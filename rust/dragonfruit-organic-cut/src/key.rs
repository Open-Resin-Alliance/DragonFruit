//! Registration key — a peg + matching socket straddling an organic cut, so the
//! two severed halves socket together in exactly one alignment.
//!
//! The geometric idea (see `.scratch/organic-cut-key-dev-plan.md`):
//!   1. Derive a **frame** from the membrane: anchor = its centroid, axis = its
//!      average normal (the same +normal direction the part-grouping uses), and
//!      `cut_area` = the membrane surface area.
//!   2. Build a **tapered rectangular frustum** (wide base on the cut, narrow tip)
//!      sized from `cut_area`. The **peg** (nominal) is union'd onto `part_a`
//!      (the +normal side); the **socket** (peg dilated by the fit tolerance) is
//!      differenced from `part_b`.
//!   3. Enforce **≥1 mm of solid material between key and wall on both halves**:
//!      shrink the frustum to fit; if it can't fit, fall back to a **half-sphere
//!      dome**; if even that can't fit, place **no key**. Each rung records WHY.
//!
//! Everything key-related lives in THIS module — nothing leaks into mesh-repair.
//! Requires the `manifold` feature (the boolean backend); gated at the crate root.

#![cfg(feature = "manifold")]

use dragonfruit_mesh_core::mesh::{IndexedMesh, Vec3};

use crate::membrane::{to_manifold, Membrane};

/// Fit tolerance: the socket is this much larger than the peg on every face, so
/// the peg slides in instead of jamming (a print-scale slide fit).
pub const DEFAULT_KEY_TOLERANCE_MM: f32 = 0.1;

/// Minimum solid material that must remain between the key and ANY mesh wall, on
/// BOTH halves. The fit ladder (frustum → dome → none) exists to honor this.
pub const KEY_WALL_MARGIN_MM: f32 = 1.0;

/// Base rectangle proportion: length = this × width.
const KEY_LENGTH_TO_WIDTH: f32 = 1.25;

/// Top face linear scale relative to the base (taper): top is 50% of the base.
const KEY_TOP_SCALE: f32 = 0.5;

/// How far the key's base extends PAST the cut plane into the other half (mm), so
/// the peg overlaps part_a's solid for a clean boolean union (not a fragile flush
/// butt-joint) and the socket mouth fully breaches part_b's cut face.
const KEY_BASE_OVERLAP_MM: f32 = 0.3;

/// Sane mm clamps on the user-chosen key width + depth (model units are mm). The
/// sliders enforce their own ranges; these are a backstop against a stray 0/huge
/// value producing a degenerate or absurd key. The 1 mm-wall fit ladder shrinks
/// below these on thin parts.
const KEY_WIDTH_MIN_MM: f32 = 0.5;
const KEY_WIDTH_MAX_MM: f32 = 50.0;
const KEY_DEPTH_MIN_MM: f32 = 0.5;
const KEY_DEPTH_MAX_MM: f32 = 50.0;

/// Default key width + depth (mm) when the caller doesn't specify (e.g. the cut
/// runs without explicit slider values). Matches the panel defaults: width 2 mm
/// (→ length auto = 2.5 mm via the 1.25× ratio), depth 2.5 mm.
pub const DEFAULT_KEY_WIDTH_MM: f32 = 2.0;
pub const DEFAULT_KEY_DEPTH_MM: f32 = 2.5;

/// Which kind of key actually got placed — drives the preview and the user alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// The primary tapered frustum (possibly shrunk to fit).
    Frustum,
    /// Fallback half-sphere dome (the part was too thin for a full frustum).
    Dome,
    /// No key placed (the part was too thin for any key).
    None,
}

impl KeyKind {
    pub fn as_str(self) -> &'static str {
        match self {
            KeyKind::Frustum => "frustum",
            KeyKind::Dome => "dome",
            KeyKind::None => "none",
        }
    }
}

/// The placement frame for a key, derived from the membrane. `axis` points along
/// the membrane's +normal (into `part_a`); the base sits in the tangent plane at
/// `anchor`. `u`/`v` are the in-plane (cosmetic) base directions; `u` is width,
/// `v` is length.
#[derive(Debug, Clone, Copy)]
pub struct KeyFrame {
    pub anchor: Vec3,
    pub axis: Vec3,
    pub u: Vec3,
    pub v: Vec3,
    pub cut_area: f32,
}

/// Nominal frustum dimensions derived from a cut area (before any clearance clamp).
#[derive(Debug, Clone, Copy)]
pub struct FrustumDims {
    /// Base width (along `u`).
    pub width: f32,
    /// Base length (along `v`), = `KEY_LENGTH_TO_WIDTH × width`.
    pub length: f32,
    /// Depth into the body (along `axis`).
    pub depth: f32,
}

impl FrustumDims {
    /// Build the nominal dimensions from the user's requested base **width** and
    /// **depth** (both in mm — model units are mm). The base length follows the
    /// fixed 1.25× proportion; the taper (top = 50% of base) is applied at build
    /// time. Values are clamped to a sane mm range so a stray 0 / huge input can't
    /// produce a degenerate or absurd key.
    pub fn from_width_depth(width_mm: f32, depth_mm: f32) -> Self {
        let width = width_mm.clamp(KEY_WIDTH_MIN_MM, KEY_WIDTH_MAX_MM);
        let depth = depth_mm.clamp(KEY_DEPTH_MIN_MM, KEY_DEPTH_MAX_MM);
        let length = KEY_LENGTH_TO_WIDTH * width;
        FrustumDims { width, length, depth }
    }
}

/// The result of placing a key: the two (possibly modified) halves plus the kind
/// of key chosen and a human-readable reason (for the report + the user alert).
pub struct KeyOutcome {
    pub part_a: IndexedMesh,
    pub part_b: IndexedMesh,
    pub kind: KeyKind,
    /// Empty on a clean nominal frustum; otherwise WHY we shrank / fell back.
    pub detail: String,
}

/// Derive the key frame from the membrane: centroid anchor, area-weighted average
/// normal as the axis (matching the +normal side the part-grouping uses), and a
/// stable in-plane basis. Returns `None` if the membrane is degenerate (no area /
/// cancelling normals) — the caller then skips the key.
pub fn frame_from_membrane(membrane: &Membrane) -> Option<KeyFrame> {
    if membrane.vertices.is_empty() || membrane.triangles.is_empty() {
        return None;
    }

    // Anchor = centroid of the membrane vertices.
    let mut anchor = Vec3::ZERO;
    for &p in &membrane.vertices {
        anchor = anchor.add(p);
    }
    anchor = anchor.scale(1.0 / membrane.vertices.len() as f32);

    // Axis = area-weighted average of triangle normals (consistent winding across
    // the patch → a coherent +normal, the same convention `signed_side_distance`
    // signs against). Area weighting damps tiny sliver triangles.
    let mut nsum = Vec3::ZERO;
    for t in &membrane.triangles {
        let a = membrane.vertices[t[0] as usize];
        let b = membrane.vertices[t[1] as usize];
        let c = membrane.vertices[t[2] as usize];
        // cross length = 2×area, so this is already area-weighted.
        nsum = nsum.add(b.sub(a).cross(c.sub(a)));
    }
    let nlen = nsum.length();
    if nlen < 1e-9 {
        return None; // normals cancelled — no coherent axis
    }
    let axis = nsum.scale(1.0 / nlen);

    let cut_area = membrane.area();
    if !(cut_area > 1e-9) {
        return None;
    }

    let (u, v) = orthonormal_basis(axis);
    Some(KeyFrame { anchor, axis, u, v, cut_area })
}

/// Build an orthonormal `(u, v)` pair spanning the plane perpendicular to `axis`.
/// Stable: seeds from whichever world axis is least aligned with `axis`. Purely
/// cosmetic for the key (peg & socket share it), so any stable choice is fine.
fn orthonormal_basis(axis: Vec3) -> (Vec3, Vec3) {
    let seed = if axis.x.abs() <= axis.y.abs() && axis.x.abs() <= axis.z.abs() {
        Vec3::new(1.0, 0.0, 0.0)
    } else if axis.y.abs() <= axis.z.abs() {
        Vec3::new(0.0, 1.0, 0.0)
    } else {
        Vec3::new(0.0, 0.0, 1.0)
    };
    let mut u = seed.sub(axis.scale(seed.dot(axis)));
    let ulen = u.length();
    u = if ulen > 1e-9 { u.scale(1.0 / ulen) } else { Vec3::new(1.0, 0.0, 0.0) };
    let v = axis.cross(u);
    (u, v)
}

/// Flip a frame so its `axis` points toward `part_b` (the −normal side) instead
/// of into `part_a`, for building a peg/socket that protrudes from part_a's cut
/// face into part_b. Negating `axis` alone would flip the `(u, v, axis)`
/// handedness and invert the frustum winding (manifold would reject it); swapping
/// `u` and `v` restores right-handedness so the outward winding is preserved.
fn frame_extruding_toward_part_b(frame: &KeyFrame) -> KeyFrame {
    KeyFrame {
        anchor: frame.anchor,
        axis: frame.axis.scale(-1.0),
        u: frame.v,
        v: frame.u,
        cut_area: frame.cut_area,
    }
}

/// Build a tapered rectangular frustum (truncated box) in the given frame.
///
/// The base rectangle (`width`×`length`) sits at `anchor` in the `u`/`v` plane;
/// the top is `KEY_TOP_SCALE`× the base, offset `depth` along `axis`. `grow` >0
/// dilates the solid by that amount on every face (the socket = peg with
/// `grow = tolerance`): base/top rings enlarge by `grow`, the tip extends `grow`
/// past `depth`, and the mouth is pulled `grow` back behind the base plane so the
/// socket fully clears the peg as it enters.
///
/// The base/mouth ALSO extends `KEY_BASE_OVERLAP_MM` *past* the cut plane into the
/// other half, so the peg's base overlaps part_a's material (a clean boolean union
/// instead of a fragile coplanar butt-joint) and the socket's mouth fully breaches
/// part_b's cut face.
///
/// Output is watertight with outward winding (same convention as
/// [`axis_aligned_slab`]) so `to_manifold` accepts it.
pub fn build_frustum(frame: &KeyFrame, dims: FrustumDims, grow: f32) -> IndexedMesh {
    let g = grow.max(0.0);
    // Half-extents at base and top, dilated by `grow`.
    let bw = dims.width * 0.5 + g; // base half-width
    let bl = dims.length * 0.5 + g; // base half-length
    let tw = dims.width * KEY_TOP_SCALE * 0.5 + g; // top half-width
    let tl = dims.length * KEY_TOP_SCALE * 0.5 + g; // top half-length
    // Base/mouth: behind the cut plane by `grow` (socket clearance) PLUS the fixed
    // overlap that pushes the base into the other half for a solid boolean.
    let z0 = -g - KEY_BASE_OVERLAP_MM;
    let z1 = dims.depth + g; // tip: past nominal depth by `grow`

    // Local → world: world = anchor + x·u + y·v + z·axis.
    let local = |x: f32, y: f32, z: f32| -> Vec3 {
        frame
            .anchor
            .add(frame.u.scale(x))
            .add(frame.v.scale(y))
            .add(frame.axis.scale(z))
    };

    // 8 corners: 0..3 base ring (z0), 4..7 top ring (z1). Same corner ORDER as
    // axis_aligned_slab (lo ring CCW from below, hi ring CCW from below) so the
    // face table's winding gives outward normals.
    let positions = vec![
        local(-bw, -bl, z0), // 0
        local(bw, -bl, z0),  // 1
        local(bw, bl, z0),   // 2
        local(-bw, bl, z0),  // 3
        local(-tw, -tl, z1), // 4
        local(tw, -tl, z1),  // 5
        local(tw, tl, z1),   // 6
        local(-tw, tl, z1),  // 7
    ];

    // 12 triangles, identical face table to axis_aligned_slab (outward-wound for a
    // box whose ring 0..3 is the −Z cap and ring 4..7 is the +Z cap).
    let faces: [[u32; 3]; 12] = [
        [0, 2, 1],
        [0, 3, 2], // base (−axis cap = the mouth)
        [4, 5, 6],
        [4, 6, 7], // top (+axis cap = the tip)
        [0, 1, 5],
        [0, 5, 4], // side −v
        [3, 7, 6],
        [3, 6, 2], // side +v
        [0, 4, 7],
        [0, 7, 3], // side −u
        [1, 2, 6],
        [1, 6, 5], // side +u
    ];
    let triangles = faces.to_vec();
    IndexedMesh { positions, triangles }
}

/// The decided key for a cut: which rung of the fit ladder, at what size, plus a
/// human-readable reason (for the report + the user alert). Computed by
/// [`decide_key`] from the frame + measured clearance — SHARED by the real cut
/// ([`apply_key`]) and the live preview ([`build_key_preview_soup`]) so the
/// preview shows exactly the key that will be cut.
#[derive(Debug, Clone)]
pub enum KeyPlan {
    Frustum { dims: FrustumDims, detail: String },
    Dome { radius: f32, detail: String },
    None { detail: String },
}

impl KeyPlan {
    pub fn kind(&self) -> KeyKind {
        match self {
            KeyPlan::Frustum { .. } => KeyKind::Frustum,
            KeyPlan::Dome { .. } => KeyKind::Dome,
            KeyPlan::None { .. } => KeyKind::None,
        }
    }
    pub fn detail(&self) -> &str {
        match self {
            KeyPlan::Frustum { detail, .. }
            | KeyPlan::Dome { detail, .. }
            | KeyPlan::None { detail } => detail,
        }
    }
}

/// Run the **fit ladder** purely as a sizing decision (no booleans): a tapered
/// frustum (shrunk to keep ≥1 mm of wall everywhere) → a half-sphere dome (if the
/// frustum can't fit) → no key. Clearance is measured against the **socket** (the
/// larger of peg/socket) so both halves keep ≥`KEY_WALL_MARGIN_MM` of material.
fn decide_key(clearance: &Clearance, nominal: FrustumDims) -> KeyPlan {
    // Rung 1: tapered frustum at the user's requested size, shrunk only if needed
    // to keep ≥MARGIN of wall everywhere.
    if let Some(dims) = clearance.fit_frustum(nominal) {
        let shrunk = dims.width < nominal.width - 1e-4 || dims.depth < nominal.depth - 1e-4;
        let detail = if shrunk {
            format!(
                "key shrunk to fit (1 mm wall): {:.2}×{:.2} mm base, {:.2} mm deep",
                dims.width, dims.length, dims.depth
            )
        } else {
            String::new()
        };
        return KeyPlan::Frustum { dims, detail };
    }

    // Rung 2: half-sphere dome, sized to keep ≥MARGIN. Its nominal radius is half
    // the requested key width (so it fills the same lateral footprint as the peg).
    let nominal_r = (nominal.width * 0.5).max(0.1);
    if let Some(radius) = clearance.fit_dome(nominal_r) {
        return KeyPlan::Dome {
            radius,
            detail: format!(
                "Key fell back to a half-sphere ({radius:.2} mm radius) — the part is too thin for a full key."
            ),
        };
    }

    // Rung 3: no key.
    KeyPlan::None {
        detail: "No key placed — the part is too thin for any key.".to_string(),
    }
}

/// Place a key across the cut, honoring the fit ladder via [`decide_key`]. The
/// chosen rung + reason ride back on the [`KeyOutcome`] so the report and the user
/// alert agree with the preview.
///
/// A degenerate frame, or any boolean failure, yields the parts UNCHANGED with
/// `KeyKind::None` + a reason — a failed key must NEVER destroy the cut result.
pub fn apply_key(
    model: &IndexedMesh,
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    membrane: &Membrane,
    width_mm: f32,
    depth_mm: f32,
    tolerance: f32,
) -> KeyOutcome {
    let frame = match frame_from_membrane(membrane) {
        Some(f) => f,
        None => {
            return KeyOutcome {
                part_a,
                part_b,
                kind: KeyKind::None,
                detail: "key skipped: degenerate cut frame (no area / cancelling normals)"
                    .to_string(),
            };
        }
    };

    // Local thickness is measured against the ORIGINAL un-cut model, NOT the split
    // parts: the parts each have a cut FACE right at the anchor, so a probe ray
    // from there hits that face ~half a kerf away (≈0.05 mm) instead of the real
    // far wall — making every part look paper-thin. The un-cut body has solid
    // material through the anchor, so the rays travel to the true outer walls.
    // (This matches the preview, which probes the model and sizes correctly.)
    let clearance = Clearance::probe(&frame, model, model);
    let nominal = FrustumDims::from_width_depth(width_mm, depth_mm);
    let plan = decide_key(&clearance, nominal);

    match plan {
        KeyPlan::Frustum { dims, detail } => {
            let out = apply_frustum(part_a, part_b, &frame, dims, tolerance);
            if out.kind == KeyKind::Frustum {
                KeyOutcome { detail, ..out }
            } else {
                // Boolean failed despite fitting — report as no key, parts intact.
                KeyOutcome {
                    kind: KeyKind::None,
                    detail: format!("No key placed — frustum boolean failed: {}", out.detail),
                    ..out
                }
            }
        }
        KeyPlan::Dome { radius, detail } => {
            let out = apply_dome(part_a, part_b, &frame, radius, tolerance);
            if out.kind == KeyKind::Dome {
                KeyOutcome { detail, ..out }
            } else {
                KeyOutcome {
                    kind: KeyKind::None,
                    detail: format!("No key placed — dome boolean failed: {}", out.detail),
                    ..out
                }
            }
        }
        KeyPlan::None { detail } => KeyOutcome { part_a, part_b, kind: KeyKind::None, detail },
    }
}

/// Build the registration key the cut WOULD place, as a flat triangle soup (9 f32
/// per triangle, model-local) for the live preview — peg AND socket together, of
/// the chosen rung (frustum or dome). Mirrors the truthful cutter preview: it
/// builds the membrane the same way the cut does, derives the same frame, probes
/// clearance against the model, and runs the SAME [`decide_key`] ladder — so the
/// preview is exactly what cuts.
///
/// Returns `(soup, kind, detail)`. On no key (too thin / degenerate), the soup is
/// empty and `detail` explains why (for the alert). `None` only if the membrane
/// itself can't be built from the loop.
pub fn build_key_preview_soup(
    model: &IndexedMesh,
    loop_pts: &[Vec3],
    membrane_smoothing: f32,
    density: f32,
    width_mm: f32,
    depth_mm: f32,
    tolerance: f32,
) -> Option<(Vec<f32>, KeyKind, String)> {
    use crate::membrane::{build_membrane_full, CONTOUR_SUBDIVISIONS, DEFAULT_GRID_DIVISIONS};

    let grid = DEFAULT_GRID_DIVISIONS * (density.clamp(1.0, 4.0) as f64);
    let membrane =
        build_membrane_full(loop_pts, CONTOUR_SUBDIVISIONS, membrane_smoothing, grid)?;
    let frame = match frame_from_membrane(&membrane) {
        Some(f) => f,
        None => {
            return Some((
                Vec::new(),
                KeyKind::None,
                "No key — degenerate cut frame.".to_string(),
            ))
        }
    };

    // At preview time the body isn't split yet; probe clearance against the whole
    // model on both sides (its walls are the same walls the halves will have).
    let clearance = Clearance::probe(&frame, model, model);
    let nominal = FrustumDims::from_width_depth(width_mm, depth_mm);
    let plan = decide_key(&clearance, nominal);
    let build_frame = frame_extruding_toward_part_b(&frame);

    let mut soup: Vec<f32> = Vec::new();
    let (kind, detail) = match &plan {
        KeyPlan::Frustum { dims, detail } => {
            append_soup(&mut soup, &build_frustum(&build_frame, *dims, 0.0)); // peg
            append_soup(&mut soup, &build_frustum(&build_frame, *dims, tolerance)); // socket
            (KeyKind::Frustum, detail.clone())
        }
        KeyPlan::Dome { radius, detail } => {
            append_soup(&mut soup, &build_dome(&build_frame, *radius, 0.0, 24));
            append_soup(&mut soup, &build_dome(&build_frame, *radius, tolerance, 24));
            (KeyKind::Dome, detail.clone())
        }
        KeyPlan::None { detail } => (KeyKind::None, detail.clone()),
    };
    Some((soup, kind, detail))
}

/// Append a mesh's triangles to a flat soup (9 f32 per triangle, model-local).
fn append_soup(soup: &mut Vec<f32>, mesh: &IndexedMesh) {
    for t in &mesh.triangles {
        for &vi in t {
            let v = mesh.positions[vi as usize];
            soup.extend_from_slice(&[v.x, v.y, v.z]);
        }
    }
}

/// Union the nominal frustum peg onto `part_a` and difference the grown socket
/// from `part_b`. On any boolean failure, returns the parts UNCHANGED with a
/// `None` kind + reason — a failed key must never destroy the cut result.
///
/// EXTRUSION DIRECTION: `frame.axis` points into `part_a` (the +normal side). The
/// peg must protrude FROM part_a's cut face INTO part_b's region so it fills the
/// socket on reassembly — i.e. it extrudes along `−axis` (toward part_b). We build
/// in a flipped frame (`axis` negated) whose wide base sits on the cut plane and
/// whose body+tip extend toward part_b. The union with part_a bonds along the cut
/// face; the difference carves the matching cavity from part_b in the same place.
fn apply_frustum(
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    frame: &KeyFrame,
    dims: FrustumDims,
    tolerance: f32,
) -> KeyOutcome {
    let build_frame = frame_extruding_toward_part_b(frame);
    let peg_mesh = build_frustum(&build_frame, dims, 0.0);
    let socket_mesh = build_frustum(&build_frame, dims, tolerance);

    let result = (|| -> Result<(IndexedMesh, IndexedMesh), String> {
        let a = to_manifold(&part_a).map_err(|e| format!("part_a invalid: {e}"))?;
        let b = to_manifold(&part_b).map_err(|e| format!("part_b invalid: {e}"))?;
        let peg = to_manifold(&peg_mesh).map_err(|e| format!("peg invalid: {e}"))?;
        let socket = to_manifold(&socket_mesh).map_err(|e| format!("socket invalid: {e}"))?;

        let a_keyed = a.union(&peg);
        let b_keyed = b.difference(&socket);

        let a_out = crate::membrane::manifold_to_indexed(&a_keyed)
            .ok_or("part_a union produced empty result")?;
        let b_out = crate::membrane::manifold_to_indexed(&b_keyed)
            .ok_or("part_b difference produced empty result")?;
        Ok((a_out, b_out))
    })();

    match result {
        Ok((a_out, b_out)) => KeyOutcome {
            part_a: a_out,
            part_b: b_out,
            kind: KeyKind::Frustum,
            detail: String::new(),
        },
        Err(reason) => KeyOutcome {
            part_a,
            part_b,
            kind: KeyKind::None,
            detail: format!("key skipped: {reason}"),
        },
    }
}

// ---------------------------------------------------------------------------
// Clearance — measure the local mesh thickness around the cut and clamp the key
// so it keeps ≥ KEY_WALL_MARGIN_MM of solid material from every wall, both halves.
// ---------------------------------------------------------------------------

/// Local thickness around the key anchor, in mm along the key's own axes. All
/// distances are "how far solid material extends from the anchor before the first
/// wall" in that direction. `+∞` means no wall was hit (open/over-large part —
/// effectively unconstrained).
struct Clearance {
    /// Depth available into part_b along `−axis` (the socket's extrusion).
    depth_b: f32,
    /// Lateral room from the anchor to the nearest wall along ±u and ±v, taking
    /// the MIN over both parts (the tightest wall on either half governs).
    lat_u_neg: f32,
    lat_u_pos: f32,
    lat_v_neg: f32,
    lat_v_pos: f32,
}

impl Clearance {
    /// Probe the un-keyed halves. Rays start a hair off the cut plane to avoid
    /// self-hitting the cut face, and are cast against each part's triangles.
    fn probe(frame: &KeyFrame, part_a: &IndexedMesh, part_b: &IndexedMesh) -> Self {
        let eps = 1e-3;
        // Depth into part_b: start just inside part_b, go along −axis.
        let neg_axis = frame.axis.scale(-1.0);
        let origin_b = frame.anchor.add(neg_axis.scale(eps));
        let depth_b = nearest_hit(part_b, origin_b, neg_axis).map(|d| d + eps).unwrap_or(f32::INFINITY);

        // Lateral: probe both halves along ±u/±v from the anchor; the tightest
        // wall on EITHER part governs (the key footprint spans both at the seam).
        let lat = |dir: Vec3| -> f32 {
            let oa = frame.anchor.add(dir.scale(eps));
            let da = nearest_hit(part_a, oa, dir).map(|d| d + eps).unwrap_or(f32::INFINITY);
            let db = nearest_hit(part_b, oa, dir).map(|d| d + eps).unwrap_or(f32::INFINITY);
            da.min(db)
        };
        Clearance {
            depth_b,
            lat_u_neg: lat(frame.u.scale(-1.0)),
            lat_u_pos: lat(frame.u),
            lat_v_neg: lat(frame.v.scale(-1.0)),
            lat_v_pos: lat(frame.v),
        }
    }

    /// Tightest lateral room along the width (u) and length (v) half-axes.
    fn half_room_u(&self) -> f32 {
        self.lat_u_neg.min(self.lat_u_pos)
    }
    fn half_room_v(&self) -> f32 {
        self.lat_v_neg.min(self.lat_v_pos)
    }

    /// Clamp the nominal frustum so the SOCKET (peg + tolerance, plus the 1 mm
    /// margin) fits: cap depth against part_b, and the base half-extents against
    /// the lateral walls. Returns `None` if nothing useful fits (→ try the dome).
    fn fit_frustum(&self, nominal: FrustumDims) -> Option<FrustumDims> {
        let m = KEY_WALL_MARGIN_MM;
        // The socket extends `tolerance` past the peg; fold a small allowance in
        // by reserving the full margin against the SOCKET extent. We size the peg
        // (nominal) and let the margin absorb the tolerance: cap so peg + tol + m
        // stays inside the wall. Use DEFAULT tolerance as the reservation.
        let tol = DEFAULT_KEY_TOLERANCE_MM;

        // Depth: socket tip at depth+tol must stay m short of part_b's far wall.
        let max_depth = (self.depth_b - m - tol).max(0.0);
        // Lateral: base half-extent + tol + m must stay inside the side walls.
        let max_half_w = (self.half_room_u() - m - tol).max(0.0);
        let max_half_l = (self.half_room_v() - m - tol).max(0.0);

        let mut width = nominal.width.min(max_half_w * 2.0);
        let mut length = nominal.length.min(max_half_l * 2.0);
        let depth = nominal.depth.min(max_depth);

        // Keep the base proportion (length = 1.25×width) if both axes were capped
        // differently — shrink the looser one to match the tighter, so the key
        // stays a sensible rectangle rather than a sliver.
        if width > 0.0 && length > 0.0 {
            let by_width = length / KEY_LENGTH_TO_WIDTH; // width implied by length cap
            width = width.min(by_width);
            length = KEY_LENGTH_TO_WIDTH * width;
        }

        // A key smaller than this floor isn't worth placing — bail to the dome.
        let floor = (KEY_MIN_FOOTPRINT_MM).max(0.0);
        if width < floor || length < floor || depth < KEY_MIN_DEPTH_MM {
            return None;
        }
        Some(FrustumDims { width, length, depth })
    }

    /// Clamp the dome radius so the grown hemisphere keeps ≥ margin from every
    /// wall (depth into part_b and lateral both apply, radius is symmetric).
    /// Returns `None` if even the minimum dome can't fit.
    fn fit_dome(&self, nominal_r: f32) -> Option<f32> {
        let m = KEY_WALL_MARGIN_MM;
        let tol = DEFAULT_KEY_TOLERANCE_MM;
        let cap = (self.depth_b - m - tol)
            .min(self.half_room_u() - m - tol)
            .min(self.half_room_v() - m - tol)
            .max(0.0);
        let r = nominal_r.min(cap);
        if r < KEY_MIN_DOME_RADIUS_MM {
            None
        } else {
            Some(r)
        }
    }
}

/// Smallest base footprint (width/length, mm) a frustum key is allowed to shrink
/// to before we give up on it and try the dome.
const KEY_MIN_FOOTPRINT_MM: f32 = 1.5;
/// Smallest depth (mm) a frustum key may shrink to before we try the dome.
const KEY_MIN_DEPTH_MM: f32 = 1.0;
/// Smallest dome radius (mm) worth placing before falling back to no key.
const KEY_MIN_DOME_RADIUS_MM: f32 = 0.75;

/// Nearest ray/mesh hit distance (Möller–Trumbore over all triangles). `None` if
/// the ray escapes. Brute force — fine for the handful of probe rays per key.
fn nearest_hit(mesh: &IndexedMesh, origin: Vec3, dir: Vec3) -> Option<f32> {
    use dragonfruit_mesh_core::bvh::ray_tri;
    let mut best: Option<f32> = None;
    for t in &mesh.triangles {
        let a = mesh.positions[t[0] as usize];
        let b = mesh.positions[t[1] as usize];
        let c = mesh.positions[t[2] as usize];
        if let Some(d) = ray_tri(origin, dir, a, b, c) {
            if d > 0.0 && best.map_or(true, |bd| d < bd) {
                best = Some(d);
            }
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Half-sphere (dome) key — the fallback when a frustum can't fit a thin part.
// ---------------------------------------------------------------------------

/// Build a watertight dome (a spherical cap) bulging along `+axis` of the
/// (already part_b-facing) `frame`, closed by a flat disk at the mouth plane.
///
/// The sphere is centered at the anchor with radius `R = radius + grow`; the flat
/// cap sits at `z = −grow − overlap` — pulled back into part_a by `grow` (socket
/// clearance) plus the fixed `KEY_BASE_OVERLAP_MM` so the dome base overlaps
/// part_a's solid for a clean union (and the socket mouth fully breaches part_b).
/// This also keeps the SOCKET (`grow = tolerance`) a TRUE dilation of the PEG
/// (`grow = 0`): every peg surface point lies strictly inside the socket — peg pole
/// at `radius` < `R`, peg rim above the socket's lower mouth — so the boolean is
/// clean (no coincident faces). `segments` = longitude steps; `rings` latitude
/// bands from mouth to pole.
fn build_dome(frame: &KeyFrame, radius: f32, grow: f32, segments: usize) -> IndexedMesh {
    let big_r = (radius + grow).max(1e-4);
    // Cap plane: pulled back by `grow` (socket dilation) + the fixed overlap so the
    // base sinks into part_a. For the peg (grow=0) this is just the overlap.
    let z_mouth = -grow - KEY_BASE_OVERLAP_MM;
    let seg = segments.max(6);
    let rings = 4usize; // latitude bands from the mouth circle up to the pole

    let local = |x: f32, y: f32, z: f32| -> Vec3 {
        frame
            .anchor
            .add(frame.u.scale(x))
            .add(frame.v.scale(y))
            .add(frame.axis.scale(z))
    };

    // Polar angle of the mouth: where the sphere (radius big_r, centered at the
    // anchor) crosses z = z_mouth. cos(theta_mouth) = z_mouth / big_r.
    let cos_m = (z_mouth / big_r).clamp(-1.0, 1.0);
    let theta_mouth = cos_m.acos(); // 0 at pole, π/2 at equator, > π/2 if z_mouth<0

    let mut positions: Vec<Vec3> = Vec::new();
    // Pole (top of the cap, along +axis).
    let pole = positions.len() as u32;
    positions.push(local(0.0, 0.0, big_r));
    // Latitude rings from just below the pole down to the mouth circle.
    let mut ring_start = Vec::with_capacity(rings);
    for i in 1..=rings {
        let theta = theta_mouth * (i as f32 / rings as f32);
        let z = big_r * theta.cos();
        let rr = big_r * theta.sin();
        ring_start.push(positions.len() as u32);
        for j in 0..seg {
            let phi = 2.0 * std::f32::consts::PI * (j as f32 / seg as f32);
            positions.push(local(rr * phi.cos(), rr * phi.sin(), z));
        }
    }
    // Flat-cap center (on the mouth plane).
    let center = positions.len() as u32;
    positions.push(local(0.0, 0.0, z_mouth));

    let mut triangles: Vec<[u32; 3]> = Vec::new();
    // Pole fan to ring 0. Wound CCW seen from OUTSIDE (+axis) → outward normals.
    let r0 = ring_start[0];
    for j in 0..seg {
        let a = r0 + j as u32;
        let b = r0 + ((j + 1) % seg) as u32;
        triangles.push([pole, a, b]);
    }
    // Bands between successive rings (cur nearer the pole, nxt nearer the mouth).
    for i in 0..rings - 1 {
        let cur = ring_start[i];
        let nxt = ring_start[i + 1];
        for j in 0..seg {
            let j1 = ((j + 1) % seg) as u32;
            let c0 = cur + j as u32;
            let c1 = cur + j1;
            let n0 = nxt + j as u32;
            let n1 = nxt + j1;
            triangles.push([c0, n1, c1]);
            triangles.push([c0, n0, n1]);
        }
    }
    // Flat cap (mouth ring → center). Its outward normal points along −axis (the
    // open mouth into part_b), so wind CW seen from +axis.
    let eq = ring_start[rings - 1];
    for j in 0..seg {
        let a = eq + j as u32;
        let b = eq + ((j + 1) % seg) as u32;
        triangles.push([center, b, a]);
    }
    IndexedMesh { positions, triangles }
}

/// Union the dome peg onto `part_a`, difference the grown dome socket from
/// `part_b`. Same failure contract as [`apply_frustum`].
fn apply_dome(
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    frame: &KeyFrame,
    radius: f32,
    tolerance: f32,
) -> KeyOutcome {
    let build_frame = frame_extruding_toward_part_b(frame);
    let peg_mesh = build_dome(&build_frame, radius, 0.0, 24);
    let socket_mesh = build_dome(&build_frame, radius, tolerance, 24);

    let result = (|| -> Result<(IndexedMesh, IndexedMesh), String> {
        let a = to_manifold(&part_a).map_err(|e| format!("part_a invalid: {e}"))?;
        let b = to_manifold(&part_b).map_err(|e| format!("part_b invalid: {e}"))?;
        let peg = to_manifold(&peg_mesh).map_err(|e| format!("dome peg invalid: {e}"))?;
        let socket = to_manifold(&socket_mesh).map_err(|e| format!("dome socket invalid: {e}"))?;
        let a_keyed = a.union(&peg);
        let b_keyed = b.difference(&socket);
        let a_out = crate::membrane::manifold_to_indexed(&a_keyed)
            .ok_or("dome union produced empty result")?;
        let b_out = crate::membrane::manifold_to_indexed(&b_keyed)
            .ok_or("dome difference produced empty result")?;
        Ok((a_out, b_out))
    })();

    match result {
        Ok((a_out, b_out)) => KeyOutcome {
            part_a: a_out,
            part_b: b_out,
            kind: KeyKind::Dome,
            detail: String::new(),
        },
        Err(reason) => KeyOutcome {
            part_a,
            part_b,
            kind: KeyKind::None,
            detail: reason,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::membrane::{
        axis_aligned_slab, build_membrane_full, CONTOUR_SUBDIVISIONS, DEFAULT_MEMBRANE_SMOOTHING,
    };

    /// A flat square membrane in the z=0 plane, side `s`, centered at origin. Its
    /// average normal is ±Z and its area is s² — a clean fixture for the frame +
    /// frustum math (no curvature to complicate the assertions).
    fn flat_membrane(s: f32) -> Membrane {
        let h = s * 0.5;
        let loop_pts = vec![
            Vec3::new(-h, -h, 0.0),
            Vec3::new(h, -h, 0.0),
            Vec3::new(h, h, 0.0),
            Vec3::new(-h, h, 0.0),
        ];
        build_membrane_full(&loop_pts, CONTOUR_SUBDIVISIONS, DEFAULT_MEMBRANE_SMOOTHING, 24.0)
            .expect("flat membrane builds")
    }

    /// Axis-aligned bbox of a mesh's vertices.
    fn bbox_of(m: &IndexedMesh) -> (Vec3, Vec3) {
        let mut lo = Vec3::new(f32::INFINITY, f32::INFINITY, f32::INFINITY);
        let mut hi = Vec3::new(f32::NEG_INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY);
        for &p in &m.positions {
            lo = lo.min(p);
            hi = hi.max(p);
        }
        (lo, hi)
    }

    // Test 1: the nominal frustum is watertight & manifold-acceptable.
    #[test]
    fn frustum_is_watertight_manifold() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let peg = build_frustum(&frame, dims, 0.0);
        assert_eq!(peg.positions.len(), 8, "frustum has 8 corners");
        assert_eq!(peg.triangles.len(), 12, "frustum has 12 triangles");
        let m = to_manifold(&peg).expect("frustum converts to a watertight manifold");
        assert!(m.num_tri() > 0, "non-empty manifold");
    }

    // Test 2: frustum dimensions follow the requested width/depth + shape rules.
    #[test]
    fn frustum_dimensions_match_spec() {
        // Explicit width/depth → base = width, length = 1.25×width, depth = depth.
        let dims = FrustumDims::from_width_depth(6.0, 4.0);
        assert!((dims.width - 6.0).abs() < 1e-4, "width = requested 6 mm (got {})", dims.width);
        assert!(
            (dims.length - KEY_LENGTH_TO_WIDTH * 6.0).abs() < 1e-4,
            "length = 1.25 × width (got {})",
            dims.length
        );
        assert!((dims.depth - 4.0).abs() < 1e-4, "depth = requested 4 mm (got {})", dims.depth);
    }

    // Test 2b: width/depth are clamped to the sane mm backstop range.
    #[test]
    fn frustum_dims_are_clamped_to_sane_range() {
        // Absurdly large → capped at the max; zero → floored at the min.
        let huge = FrustumDims::from_width_depth(1.0e6, 1.0e6);
        assert!((huge.width - KEY_WIDTH_MAX_MM).abs() < 1e-3, "width capped at max");
        assert!((huge.depth - KEY_DEPTH_MAX_MM).abs() < 1e-3, "depth capped at max");
        let tiny = FrustumDims::from_width_depth(0.0, 0.0);
        assert!((tiny.width - KEY_WIDTH_MIN_MM).abs() < 1e-3, "width floored at min");
        assert!((tiny.depth - KEY_DEPTH_MIN_MM).abs() < 1e-3, "depth floored at min");
    }

    // Test 3: tolerance growth — socket strictly larger than peg on every face.
    #[test]
    fn socket_grows_by_tolerance_on_all_faces() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let tol = 0.1;
        let peg = build_frustum(&frame, dims, 0.0);
        let socket = build_frustum(&frame, dims, tol);

        let (plo, phi) = bbox_of(&peg);
        let (slo, shi) = bbox_of(&socket);
        // Frame axis is ±Z here, u/v in the XY plane. Socket should exceed the peg
        // by ~tol in every direction (the mouth pulls back by tol in −axis too).
        for (a, b, name) in [
            (slo.x, plo.x, "x lo"),
            (slo.y, plo.y, "y lo"),
            (slo.z, plo.z, "z lo"),
        ] {
            assert!(a < b - tol * 0.5, "socket {name} extends past peg");
        }
        for (a, b, name) in [
            (shi.x, phi.x, "x hi"),
            (shi.y, phi.y, "y hi"),
            (shi.z, phi.z, "z hi"),
        ] {
            assert!(a > b + tol * 0.5, "socket {name} extends past peg");
        }
    }

    // Test 4: apply_key on a flat cut grows part_a (peg added) and keeps both
    // halves watertight.
    #[test]
    fn apply_key_unions_peg_and_carves_socket() {
        // Two stacked boxes acting as the two halves, meeting at z=0 over a 10×10
        // area — exactly what a flat equatorial cut of a 10×10×20 box yields. The
        // un-cut model is the full 10×10×20 body (clearance probes against THIS).
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let part_a = axis_aligned_slab(Vec3::new(-5.0, -5.0, 0.0), Vec3::new(5.0, 5.0, 10.0));
        let part_b = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 0.0));
        let mem = flat_membrane(10.0);

        let a_tris_before = part_a.triangle_count();
        let out = apply_key(&model, part_a, part_b, &mem, 5.0, 5.0, 0.1);

        assert_eq!(out.kind, KeyKind::Frustum, "frustum key placed: {}", out.detail);
        assert!(
            out.part_a.triangle_count() > a_tris_before,
            "part_a gained triangles from the unioned peg"
        );
        // Both halves remain watertight (convertible to a manifold).
        assert!(to_manifold(&out.part_a).is_ok(), "keyed part_a is watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "keyed part_b is watertight");
    }

    // Test 5: the peg fits inside the grown socket cavity (difference is empty).
    #[test]
    fn peg_fits_inside_socket_cavity() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let peg = to_manifold(&build_frustum(&frame, dims, 0.0)).expect("peg");
        let socket = to_manifold(&build_frustum(&frame, dims, 0.1)).expect("socket");
        // peg − socket should be empty: the peg lies entirely within the cavity.
        let leftover = peg.difference(&socket);
        assert!(
            leftover.is_empty() || leftover.num_tri() == 0,
            "peg is fully contained in the grown socket (leftover tris = {})",
            leftover.num_tri()
        );
    }

    /// Build the un-cut model + the two halves of a 10×10 cut where part_b is
    /// exactly `depth_b` mm deep along −Z and part_a is `depth_a` mm deep along +Z
    /// (both share the cut at z=0). The model spans both halves — clearance probes
    /// against it (the real pipeline measures the un-cut body, not the parts).
    /// Returns `(model, part_a, part_b)`.
    fn split_halves(depth_a: f32, depth_b: f32) -> (IndexedMesh, IndexedMesh, IndexedMesh) {
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -depth_b), Vec3::new(5.0, 5.0, depth_a));
        let part_a = axis_aligned_slab(Vec3::new(-5.0, -5.0, 0.0), Vec3::new(5.0, 5.0, depth_a));
        let part_b = axis_aligned_slab(Vec3::new(-5.0, -5.0, -depth_b), Vec3::new(5.0, 5.0, 0.0));
        (model, part_a, part_b)
    }

    // Test 7: a thin part_b forces the frustum to SHRINK (depth capped) but a key
    // is still placed, keeping the socket clear of the far wall by ≥1 mm.
    #[test]
    fn clearance_clamp_shrinks_the_frustum() {
        let mem = flat_membrane(10.0);
        // Request a 5 mm-deep key, but part_b is only 4 mm deep → the 5 mm depth
        // would punch through, so the clamp must cut it down to stop ≥1 mm short.
        let (model, part_a, part_b) = split_halves(20.0, 4.0);
        let key_w = 5.0;
        let key_d = 5.0;
        assert!(key_d > 4.0, "test premise: requested depth exceeds the part");

        let out = apply_key(&model, part_a, part_b.clone(), &mem, key_w, key_d, 0.1);

        assert_eq!(out.kind, KeyKind::Frustum, "still a frustum, just smaller: {}", out.detail);
        assert!(out.detail.contains("shrunk"), "reports the shrink: {:?}", out.detail);

        // No punch-through: part_b's far wall (z = −4) stays intact — its bbox min
        // is unchanged, meaning the socket cavity did NOT breach the bottom.
        let (lo_before, _) = bbox_of(&part_b);
        let (lo_after, _) = bbox_of(&out.part_b);
        assert!(
            (lo_after.z - lo_before.z).abs() < 1e-3,
            "far wall intact (min z {} → {}); socket did not punch through",
            lo_before.z,
            lo_after.z
        );
        // And the socket genuinely carved material (part_b changed) yet stayed
        // watertight.
        assert!(
            out.part_b.triangle_count() != part_b.triangle_count(),
            "socket carved part_b"
        );
        assert!(to_manifold(&out.part_b).is_ok(), "keyed part_b watertight");
    }

    // Test 8: the fit ladder falls back — dome on a too-thin part, no key on a
    // paper-thin part — each with a reason.
    #[test]
    fn fit_ladder_falls_back_to_dome_then_none() {
        let mem = flat_membrane(10.0);

        // ~2.0 mm deep part_b: below the frustum's depth floor (1 mm key + 1 mm
        // wall + 0.1 mm tol = 2.1 mm needed) but the shallower dome still fits.
        let (model1, pa, pb) = split_halves(20.0, 2.0);
        let dome_out = apply_key(&model1, pa, pb, &mem, 5.0, 5.0, 0.1);
        assert_eq!(dome_out.kind, KeyKind::Dome, "dome fallback: {}", dome_out.detail);
        assert!(
            dome_out.detail.contains("half-sphere"),
            "dome reason mentions half-sphere: {:?}",
            dome_out.detail
        );

        // Paper-thin part_b (0.5 mm): even the dome can't keep 1 mm → no key, and
        // the parts come back UNCHANGED.
        let (model2, pa2, pb2) = split_halves(20.0, 0.5);
        let pb2_tris = pb2.triangle_count();
        let none_out = apply_key(&model2, pa2, pb2, &mem, 5.0, 5.0, 0.1);
        assert_eq!(none_out.kind, KeyKind::None, "no key: {}", none_out.detail);
        assert!(none_out.detail.contains("too thin"), "no-key reason: {:?}", none_out.detail);
        assert_eq!(
            none_out.part_b.triangle_count(),
            pb2_tris,
            "part_b is unchanged when no key is placed"
        );
    }

    // Test 6: the preview soup is non-empty, finite, and a multiple of 9 floats
    // (peg + socket), and reports the frustum kind on a healthy part.
    #[test]
    fn key_preview_soup_is_valid() {
        // A 10×10×20 box as the model; an equatorial loop at z=0.
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let loop_pts = vec![
            Vec3::new(-5.0, -5.0, 0.0),
            Vec3::new(5.0, -5.0, 0.0),
            Vec3::new(5.0, 5.0, 0.0),
            Vec3::new(-5.0, 5.0, 0.0),
        ];
        let (soup, kind, _detail) =
            build_key_preview_soup(&model, &loop_pts, DEFAULT_MEMBRANE_SMOOTHING, 1.0, 5.0, 5.0, 0.1)
                .expect("preview builds");
        assert_eq!(kind, KeyKind::Frustum, "healthy box → frustum key preview");
        assert!(!soup.is_empty(), "preview soup non-empty");
        assert_eq!(soup.len() % 9, 0, "whole triangles");
        assert!(soup.iter().all(|f| f.is_finite()), "all coords finite");
    }

    // Test 9: the dome key is watertight and the peg fits inside the grown socket.
    #[test]
    fn dome_is_watertight_and_fits() {
        let mem = flat_membrane(10.0);
        let frame = frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        let r = 3.0;
        let peg = build_dome(&frame, r, 0.0, 24);
        let socket = build_dome(&frame, r, 0.1, 24);
        let peg_m = to_manifold(&peg).expect("dome peg watertight");
        let socket_m = to_manifold(&socket).expect("dome socket watertight");
        let leftover = peg_m.difference(&socket_m);
        assert!(
            leftover.is_empty() || leftover.num_tri() == 0,
            "dome peg fits inside grown dome socket (leftover tris = {})",
            leftover.num_tri()
        );
    }

    // Test 10: THE REAL PIPELINE — run an actual contour_split on a cube, then key
    // the parts it produces (NOT hand-built boxes). This reproduces exactly what
    // the production cut does, so it catches failures that the box-fixture tests
    // miss (e.g. the contour parts not re-importing cleanly to manifold).
    #[test]
    fn keys_the_real_contour_split_parts() {
        use crate::membrane::{contour_split, DEFAULT_CUTTER_THICKNESS_MM, DEFAULT_MEMBRANE_SMOOTHING};

        // A 20-unit cube, cut around its equator with a dense surface loop — the
        // same shape the real contour cut traces (many points on the four faces).
        let size = 20.0;
        let model = axis_aligned_slab(Vec3::ZERO, Vec3::new(size, size, size));
        let z = size / 2.0;
        let steps = 10usize;
        let f = |i: usize| size * i as f32 / steps as f32;
        let mut loop_pts = Vec::new();
        for i in 0..steps { loop_pts.push(Vec3::new(f(i), 0.0, z)); }
        for i in 0..steps { loop_pts.push(Vec3::new(size, f(i), z)); }
        for i in 0..steps { loop_pts.push(Vec3::new(size - f(i), size, z)); }
        for i in 0..steps { loop_pts.push(Vec3::new(0.0, size - f(i), z)); }

        let split = contour_split(
            &model,
            &loop_pts,
            DEFAULT_CUTTER_THICKNESS_MM,
            DEFAULT_MEMBRANE_SMOOTHING,
            1.0,
        )
        .expect("contour split severs the cube");

        // First: do the contour parts even re-import to manifold on their own?
        // (If THIS fails, the key boolean can't possibly work — the parts are bad.)
        assert!(
            to_manifold(&split.part_a).is_ok(),
            "contour part_a re-imports to manifold"
        );
        assert!(
            to_manifold(&split.part_b).is_ok(),
            "contour part_b re-imports to manifold"
        );

        let a_before = split.part_a.triangle_count();
        let b_before = split.part_b.triangle_count();

        // Now key the REAL parts — clearance probes against the original `model`.
        let out = apply_key(&model, split.part_a, split.part_b, &split.membrane, 5.0, 5.0, 0.1);

        assert_eq!(
            out.kind,
            KeyKind::Frustum,
            "key placed on real contour parts (detail: {})",
            out.detail
        );
        assert!(
            out.part_a.triangle_count() != a_before,
            "part_a changed (peg unioned): {} → {}",
            a_before,
            out.part_a.triangle_count()
        );
        assert!(
            out.part_b.triangle_count() != b_before,
            "part_b changed (socket carved): {} → {}",
            b_before,
            out.part_b.triangle_count()
        );
        assert!(to_manifold(&out.part_a).is_ok(), "keyed part_a watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "keyed part_b watertight");
    }
}
