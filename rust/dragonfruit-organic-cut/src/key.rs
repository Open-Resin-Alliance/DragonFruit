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

/// Points used to sample EACH rounded corner of the frustum's rounded-rectangle
/// cross-section. 4 corners × this = the per-ring point count of the side wall.
const FILLET_CORNER_SEGS: usize = 5;
/// Rings used to sweep the rounded-over TIP (from the side-wall shoulder up to the
/// tip pole). More = smoother dome-over.
const FILLET_TIP_RINGS: usize = 4;

/// Dome tessellation: longitude segments (around the axis) and latitude rings
/// (equator → pole). High enough that the half-ellipsoid reads as a smooth dome,
/// not a faceted bullet — the key is a small, low-tri solid so this is cheap.
/// Extra rings near the pole matter most: that's where curvature is highest, so
/// the tip is the first place facets show.
const DOME_SEGMENTS: usize = 64;
const DOME_RINGS: usize = 18;

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

/// The key SHAPE the user requested. Drives which rung the fit ladder starts on.
/// (Distinct from [`KeyKind`], which is what actually got PLACED after the ladder.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum KeyShape {
    /// Tapered rectangular frustum (the default — rotation-locking).
    #[default]
    Frustum,
    /// Half-sphere dome (round, locates but does not lock rotation).
    Dome,
}

impl KeyShape {
    /// Parse the camelCase string the frontend sends; unknown → Frustum.
    pub fn from_str_or_default(s: &str) -> Self {
        match s {
            "dome" => KeyShape::Dome,
            _ => KeyShape::Frustum,
        }
    }
}

/// Which kind of key actually got placed — drives the preview and the user alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyKind {
    /// The primary tapered frustum (possibly shrunk to fit).
    Frustum,
    /// Half-sphere dome (chosen explicitly, OR the thin-part frustum fallback).
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

/// Half-ellipsoid (oblong dome) semi-axes, in mm. `half_w` is along `u`, `half_l`
/// along `v` (= `KEY_LENGTH_TO_WIDTH × half_w`, matching the frustum's footprint
/// ratio), and `depth` is the bulge along `+axis`. Equal axes → a hemisphere.
#[derive(Debug, Clone, Copy)]
pub struct DomeDims {
    pub half_w: f32,
    pub half_l: f32,
    pub depth: f32,
}

impl DomeDims {
    /// From the user's requested cut-face **width** and bulge **depth** (mm). The
    /// length follows the same 1.25× ratio the frustum uses, so a locked
    /// width=depth dome reads as a round-ish dome. Clamped to the sane mm range.
    pub fn from_width_depth(width_mm: f32, depth_mm: f32) -> Self {
        let width = width_mm.clamp(KEY_WIDTH_MIN_MM, KEY_WIDTH_MAX_MM);
        let depth = depth_mm.clamp(KEY_DEPTH_MIN_MM, KEY_DEPTH_MAX_MM);
        DomeDims {
            half_w: width * 0.5,
            half_l: KEY_LENGTH_TO_WIDTH * width * 0.5,
            depth,
        }
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

/// Mirror a frame so its `axis` points into part_b instead of part_a (used to
/// flip which half gets the peg). Same construction as
/// [`frame_extruding_toward_part_b`] — negate `axis`, swap `u`/`v` to keep a
/// right-handed basis — but conceptually it re-roots the key on the opposite side.
fn flip_frame_sides(frame: &KeyFrame) -> KeyFrame {
    KeyFrame {
        anchor: frame.anchor,
        axis: frame.axis.scale(-1.0),
        u: frame.v,
        v: frame.u,
        cut_area: frame.cut_area,
    }
}

/// Max tilt (radians) the key axis may lean off the membrane normal. Past this the
/// peg skims nearly parallel to the cut face — clearance/fit degrade and it can't
/// realistically socket — so the UI clamps to this and we re-clamp here as a
/// backstop. ~60°.
pub const KEY_MAX_TILT_RAD: f32 = std::f32::consts::FRAC_PI_3;

/// User-controlled reorientation of the key, expressed in the cut's own tangent
/// frame so it stays attached to the seam regardless of how the model sits in world
/// space. All three pivot about the **base center** (`anchor`):
/// - `tilt`: polar angle the body leans OFF the membrane normal (0 = straight out;
///   clamped to [`KEY_MAX_TILT_RAD`]).
/// - `azimuth`: which in-plane direction it leans toward (rotation of the lean
///   about the original normal). Irrelevant when `tilt == 0`.
/// - `roll`: spin of the key about its own axis — orients the rectangle / oblong
///   dome footprint.
///
/// The key body is **rigidly rotated** by these angles — it keeps its exact shape
/// (no shear/stretch in the body). BUT the flat base footprint must stay glued in
/// the cut plane, so a thin **collar** at the base stretches to bridge the rotated
/// body down to the fixed flat footprint. See [`LeanXform`].
#[derive(Debug, Clone, Copy, Default)]
pub struct KeyTilt {
    pub tilt: f32,
    pub azimuth: f32,
    pub roll: f32,
}

impl KeyTilt {
    pub fn new(tilt: f32, azimuth: f32, roll: f32) -> Self {
        KeyTilt { tilt, azimuth, roll }
    }
}

/// Rotate `v` about unit `axis` by `angle` radians (Rodrigues' rotation formula).
fn rotate_about(v: Vec3, axis: Vec3, angle: f32) -> Vec3 {
    let (s, c) = angle.sin_cos();
    // v·cosθ + (k×v)·sinθ + k·(k·v)·(1−cosθ)
    v.scale(c)
        .add(axis.cross(v).scale(s))
        .add(axis.scale(axis.dot(v) * (1.0 - c)))
}

/// Reorientation applied at BUILD time, in the key's local `(u, v, axis)` space
/// (origin at `anchor`, `+z` along the build axis toward the tip): a **pure rigid
/// rotation** of the whole key about the base center, plus an axial **sink** that
/// pushes the rotated key deeper into the peg's half so its tilted base stays fully
/// buried below the cut plane (a solid bond), and the socket fully breaches the cut
/// face.
///
/// Because the transform is a single rigid rotation (+ uniform translation) applied
/// IDENTICALLY to the peg and the socket, containment is preserved: the socket is
/// the peg dilated by the tolerance, and `R(socket) ⊇ R(peg)` — so the leaned peg
/// always fits its leaned socket (a clean slide fit at any tilt). The key keeps its
/// exact shape (no shear/stretch).
///
/// `R = R_lean · R_roll`: roll about local `+z` first (spins the footprint), then
/// lean about the in-plane axis `k = +z × L`, `L = (cos az, sin az, 0)`. Identity
/// (`tilt == 0 && roll == 0`) leaves geometry untouched (the exact original key).
#[derive(Debug, Clone, Copy)]
struct LeanXform {
    tilt: f32,
    roll: f32,
    /// Lean rotation axis in local (u, v) coords (unit, in-plane): k = z × L.
    k_u: f32,
    k_v: f32,
    /// Axial sink (mm, along −z) applied AFTER the rotation so the tilted base stays
    /// buried below the cut plane. 0 when not leaning.
    sink: f32,
    identity: bool,
}

impl LeanXform {
    const IDENTITY: LeanXform = LeanXform {
        tilt: 0.0,
        roll: 0.0,
        k_u: 1.0,
        k_v: 0.0,
        sink: 0.0,
        identity: true,
    };

    /// Build the transform for a key built in `build_frame`, given the user `tilt`
    /// and the key footprint `half_diag` (mm, the base half-diagonal — how far the
    /// base extends from the axis). The lean direction is computed as a WORLD
    /// direction from the ORIGINAL (un-swapped) tangent basis and projected onto
    /// `build_frame.(u, v)` so it points the same world way through any swap.
    fn for_build(orig: &KeyFrame, build_frame: &KeyFrame, tilt: &KeyTilt, half_diag: f32) -> LeanXform {
        let leaning = tilt.tilt.abs() >= 1e-6;
        let rolling = tilt.roll.abs() >= 1e-6;
        if !leaning && !rolling {
            return LeanXform::IDENTITY;
        }
        let t = tilt.tilt.clamp(-KEY_MAX_TILT_RAD, KEY_MAX_TILT_RAD);
        // World lean direction in the original tangent plane → local (u, v) coords.
        let lean_world = orig
            .u
            .scale(tilt.azimuth.cos())
            .add(orig.v.scale(tilt.azimuth.sin()));
        let lu = lean_world.dot(build_frame.u);
        let lv = lean_world.dot(build_frame.v);
        let len = (lu * lu + lv * lv).sqrt();
        // Lean rotation axis k = z × L = (−L_v, L_u, 0) (unit, in-plane). Falls back
        // to a roll-only transform if the lean direction degenerates.
        let (k_u, k_v) = if len > 1e-9 {
            (-lv / len, lu / len)
        } else {
            (1.0, 0.0)
        };
        let tilt_used = if leaning && len > 1e-9 { t } else { 0.0 };
        // Sink so the rotated base stays buried: a base corner at half_diag from the
        // axis rises by ≤ half_diag·sin(tilt) when the key tilts. Sink the whole key
        // by that much (plus a hair) so even the highest base corner stays below the
        // cut plane → the union bonds along a fully embedded base.
        let sink = half_diag.max(0.0) * tilt_used.abs().sin();
        LeanXform {
            tilt: tilt_used,
            roll: tilt.roll,
            k_u,
            k_v,
            sink,
            identity: false,
        }
    }

    /// Transform a local point: rigid roll (about +z), then rigid lean (about the
    /// in-plane axis k), then sink along −z. Identical for peg and socket, so it
    /// preserves their nesting (clean slide fit at any tilt).
    #[inline]
    fn apply(&self, x: f32, y: f32, z: f32) -> (f32, f32, f32) {
        if self.identity {
            return (x, y, z);
        }
        // 1) Roll about local +z.
        let (mut px, mut py) = (x, y);
        if self.roll.abs() >= 1e-9 {
            let (s, c) = self.roll.sin_cos();
            let rx = px * c - py * s;
            let ry = px * s + py * c;
            px = rx;
            py = ry;
        }
        // 2) Lean about the in-plane axis k = (k_u, k_v, 0).
        let (lx, ly, lz) = if self.tilt.abs() >= 1e-9 {
            let k = Vec3::new(self.k_u, self.k_v, 0.0);
            let r = rotate_about(Vec3::new(px, py, z), k, self.tilt);
            (r.x, r.y, r.z)
        } else {
            (px, py, z)
        };
        // 3) Sink along −z so the tilted base stays buried.
        (lx, ly, lz - self.sink)
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
///
/// `fillet` (mm) rounds the peg: the cross-section becomes a rounded-rectangle
/// (the 4 vertical corners are quarter-circle arcs of radius `fillet`) and the TIP
/// is rounded over (a quarter-round from the side wall up to the tip). `fillet = 0`
/// gives the original sharp tapered box. The fillet is clamped so it can't exceed
/// the smaller half-extent (which would invert the corner).
pub fn build_frustum(frame: &KeyFrame, dims: FrustumDims, grow: f32, fillet: f32) -> IndexedMesh {
    build_frustum_leaned(frame, dims, grow, fillet, LeanXform::IDENTITY)
}

/// [`build_frustum`] with an explicit [`LeanXform`] for a rotated key. The body is
/// rigid-rotated; a thin collar at the base blends to the flat glued footprint.
fn build_frustum_leaned(
    frame: &KeyFrame,
    dims: FrustumDims,
    grow: f32,
    fillet: f32,
    lean: LeanXform,
) -> IndexedMesh {
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
    let height = (z1 - z0).max(1e-4);

    // Corner radius: the requested fillet, but never more than the smallest half-
    // extent (a corner arc can't be bigger than the side it rounds) nor more than
    // a third of the height (so the tip round-over fits below the tip).
    let r = fillet
        .max(0.0)
        .min(tw.min(tl) * 0.999)
        .min(bw.min(bl) * 0.999)
        .min(height / 3.0);

    // Below a tiny threshold, fall back to the sharp 8-vertex box (cheaper + the
    // exact original geometry, so a 0 fillet is a true no-op).
    if r < 1e-4 {
        return build_sharp_frustum(frame, bw, bl, tw, tl, z0, z1, lean);
    }

    // Local → world: apply the lean (rigid body rotation + glued-base collar) to the
    // local point, then map through the frame: world = anchor + x'·u + y'·v + z'·axis.
    let local = |x: f32, y: f32, z: f32| -> Vec3 {
        let (x, y, z) = lean.apply(x, y, z);
        frame
            .anchor
            .add(frame.u.scale(x))
            .add(frame.v.scale(y))
            .add(frame.axis.scale(z))
    };

    // A rounded-rectangle ring of points (CCW seen from +axis) for half-extents
    // (hw,hl) with corner radius `cr`, at height `z`. The 4 corners are
    // quarter-circle arcs; straight runs collapse to the shared arc endpoints so
    // every ring has the SAME point count (4·FILLET_CORNER_SEGS) and lofts cleanly.
    let ring = |hw: f32, hl: f32, cr: f32, z: f32| -> Vec<Vec3> {
        let cr = cr.min(hw).min(hl);
        // Corner arc centers (inset by cr): order +x+y, -x+y, -x-y, +x-y → CCW.
        let centers = [
            (hw - cr, hl - cr, 0.0f32),               // +x+y, arc 0°→90°
            (-(hw - cr), hl - cr, std::f32::consts::FRAC_PI_2), // -x+y, 90°→180°
            (-(hw - cr), -(hl - cr), std::f32::consts::PI),     // -x-y, 180°→270°
            (hw - cr, -(hl - cr), 3.0 * std::f32::consts::FRAC_PI_2), // +x-y
        ];
        let mut pts = Vec::with_capacity(4 * FILLET_CORNER_SEGS);
        for &(cx, cy, a0) in &centers {
            for k in 0..FILLET_CORNER_SEGS {
                let t = k as f32 / (FILLET_CORNER_SEGS - 1) as f32; // 0..1 inclusive
                let a = a0 + t * std::f32::consts::FRAC_PI_2;
                pts.push(local(cx + cr * a.cos(), cy + cr * a.sin(), z));
            }
        }
        pts
    };
    let ring_n = 4 * FILLET_CORNER_SEGS;

    let mut positions: Vec<Vec3> = Vec::new();
    let mut ring_starts: Vec<u32> = Vec::new();
    let mut push_ring = |pts: Vec<Vec3>, positions: &mut Vec<Vec3>, starts: &mut Vec<u32>| {
        starts.push(positions.len() as u32);
        positions.extend(pts);
    };

    // The tip is rounded over a quarter-circle of radius `r`: the side wall ends
    // at a "shoulder" ring (z1−r), then the surface curves inward+up to a small
    // FLAT TOP face (the top size inset by `r`) at z1. The top stays a flat
    // rounded-rect cap — no collapsing pole — so no degenerate triangles.
    //
    // Tip rings, parametrized by θ from 0 (shoulder) to π/2 (top rim):
    //   inset(θ) = r·(1 − cos θ)   (0 → r): how far the rim pulls in
    //   rise(θ)  = r·sin θ         (0 → r): how far it rises toward z1
    // Each ring's half-extents shrink by inset; its corner radius STAYS `r` (the
    // rounded-rect corners are preserved up the round-over, not flattened).
    let z_shoulder = z1 - r;
    // Ring 0: base (rounded-rect, base size) at z0.
    push_ring(ring(bw, bl, r, z0), &mut positions, &mut ring_starts);
    // Ring 1: shoulder (top size) — side wall is rings 0→1.
    push_ring(ring(tw, tl, r, z_shoulder), &mut positions, &mut ring_starts);
    // Rings 2..=N: the tip round-over up to the top rim (inset by r at the top).
    for i in 1..=FILLET_TIP_RINGS {
        let ang = (i as f32 / FILLET_TIP_RINGS as f32) * std::f32::consts::FRAC_PI_2;
        let inset = r * (1.0 - ang.cos());
        let rise = r * ang.sin();
        let hw = (tw - inset).max(r + 1e-3);
        let hl = (tl - inset).max(r + 1e-3);
        push_ring(ring(hw, hl, r, z_shoulder + rise), &mut positions, &mut ring_starts);
    }
    // Top-cap center (flat top face at z1).
    let top_center = positions.len() as u32;
    positions.push(local(0.0, 0.0, z1));
    // Base center point (for the flat base cap at z0).
    let base_center = positions.len() as u32;
    positions.push(local(0.0, 0.0, z0));

    let mut triangles: Vec<[u32; 3]> = Vec::new();

    // Side + tip bands between successive rings. `cur` is the LOWER ring (toward
    // the base/−axis), `nxt` the UPPER. Rings are CCW seen from +axis, so the
    // outward-facing winding (going low→high) is [c0,c1,n1]+[c0,n1,n0].
    for w in 0..ring_starts.len() - 1 {
        let cur = ring_starts[w];
        let nxt = ring_starts[w + 1];
        for j in 0..ring_n {
            let j1 = ((j + 1) % ring_n) as u32;
            let c0 = cur + j as u32;
            let c1 = cur + j1;
            let n0 = nxt + j as u32;
            let n1 = nxt + j1;
            triangles.push([c0, c1, n1]);
            triangles.push([c0, n1, n0]);
        }
    }
    // Flat top cap (top rim ring → top center). Outward normal along +axis → wind
    // CCW seen from +axis: [center, j, j1].
    let top = *ring_starts.last().unwrap();
    for j in 0..ring_n {
        let j1 = ((j + 1) % ring_n) as u32;
        triangles.push([top_center, top + j as u32, top + j1]);
    }
    // Base cap (base ring → base center). Its outward normal points along −axis
    // (the mouth), so wind CW seen from +axis.
    let base = ring_starts[0];
    for j in 0..ring_n {
        let j1 = ((j + 1) % ring_n) as u32;
        triangles.push([base_center, base + j1, base + j as u32]);
    }

    IndexedMesh { positions, triangles }
}

/// The sharp tapered box (the `fillet = 0` path), factored out so both the filleted
/// and sharp builds share the half-extent / z math above.
///
/// When the `lean` adds a collar (a non-identity lean), we insert an intermediate
/// ring at the collar height so the side walls bend ONCE at the collar and stay
/// rigid (straight) above it — the body keeps its shape and only the short collar
/// band stretches. With no lean it's the original flat 8-vertex box.
fn build_sharp_frustum(
    frame: &KeyFrame,
    bw: f32,
    bl: f32,
    tw: f32,
    tl: f32,
    z0: f32,
    z1: f32,
    lean: LeanXform,
) -> IndexedMesh {
    let local = |x: f32, y: f32, z: f32| -> Vec3 {
        let (x, y, z) = lean.apply(x, y, z);
        frame
            .anchor
            .add(frame.u.scale(x))
            .add(frame.v.scale(y))
            .add(frame.axis.scale(z))
    };

    // The 8-vertex tapered box. `local()` applies the rigid lean rotation + sink, so
    // a leaned box is just this box rigidly rotated — still 8 verts / 12 tris, still
    // watertight, and the socket (same rotation, dilated) provably contains the peg.
    let positions = vec![
        local(-bw, -bl, z0),
        local(bw, -bl, z0),
        local(bw, bl, z0),
        local(-bw, bl, z0),
        local(-tw, -tl, z1),
        local(tw, -tl, z1),
        local(tw, tl, z1),
        local(-tw, tl, z1),
    ];
    let faces: [[u32; 3]; 12] = [
        [0, 2, 1],
        [0, 3, 2],
        [4, 5, 6],
        [4, 6, 7],
        [0, 1, 5],
        [0, 5, 4],
        [3, 7, 6],
        [3, 6, 2],
        [0, 4, 7],
        [0, 7, 3],
        [1, 2, 6],
        [1, 6, 5],
    ];
    IndexedMesh { positions, triangles: faces.to_vec() }
}
pub trait RegistrationKeyGenerator: Send + Sync {
    fn kind(&self) -> KeyKind;
    fn fit(&self, clearance: &Clearance, width_mm: f32, depth_mm: f32) -> Option<(Box<dyn RegistrationKeyGenerator>, String)>;
    fn half_diagonal(&self, tolerance: f32) -> f32;
    fn depth(&self) -> f32;
    fn build_peg(&self, frame: &KeyFrame, lean: LeanXform, fillet_mm: f32) -> IndexedMesh;
    fn build_socket(&self, frame: &KeyFrame, tolerance: f32, lean: LeanXform, fillet_mm: f32) -> IndexedMesh;
    fn clone_box(&self) -> Box<dyn RegistrationKeyGenerator>;
}

impl Clone for Box<dyn RegistrationKeyGenerator> {
    fn clone(&self) -> Self {
        self.clone_box()
    }
}

#[derive(Debug, Clone)]
pub struct FrustumGenerator {
    pub dims: Option<FrustumDims>,
}

impl RegistrationKeyGenerator for FrustumGenerator {
    fn kind(&self) -> KeyKind {
        KeyKind::Frustum
    }

    fn fit(&self, clearance: &Clearance, width_mm: f32, depth_mm: f32) -> Option<(Box<dyn RegistrationKeyGenerator>, String)> {
        let nominal = FrustumDims::from_width_depth(width_mm, depth_mm);
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
            Some((Box::new(FrustumGenerator { dims: Some(dims) }), detail))
        } else {
            let fallback = DomeDims::from_width_depth(width_mm, width_mm);
            if let Some(dims) = clearance.fit_dome(fallback) {
                let detail = format!(
                    "Key fell back to a half-sphere ({:.2}×{:.2} mm, {:.2} mm deep) — the part is too thin for a full key.",
                    dims.half_w * 2.0, dims.half_l * 2.0, dims.depth
                );
                Some((Box::new(DomeGenerator { dims: Some(dims) }), detail))
            } else {
                None
            }
        }
    }

    fn half_diagonal(&self, tolerance: f32) -> f32 {
        let dims = self.dims.expect("must be fitted");
        0.5 * dims.width.hypot(dims.length) + tolerance
    }

    fn depth(&self) -> f32 {
        let dims = self.dims.expect("must be fitted");
        dims.depth
    }

    fn build_peg(&self, frame: &KeyFrame, lean: LeanXform, fillet_mm: f32) -> IndexedMesh {
        let dims = self.dims.expect("must be fitted");
        build_frustum_leaned(frame, dims, 0.0, fillet_mm, lean)
    }

    fn build_socket(&self, frame: &KeyFrame, tolerance: f32, lean: LeanXform, fillet_mm: f32) -> IndexedMesh {
        let dims = self.dims.expect("must be fitted");
        build_frustum_leaned(frame, dims, tolerance, fillet_mm + tolerance, lean)
    }

    fn clone_box(&self) -> Box<dyn RegistrationKeyGenerator> {
        Box::new(self.clone())
    }
}

#[derive(Debug, Clone)]
pub struct DomeGenerator {
    pub dims: Option<DomeDims>,
}

impl RegistrationKeyGenerator for DomeGenerator {
    fn kind(&self) -> KeyKind {
        KeyKind::Dome
    }

    fn fit(&self, clearance: &Clearance, width_mm: f32, depth_mm: f32) -> Option<(Box<dyn RegistrationKeyGenerator>, String)> {
        let nominal_dome = DomeDims::from_width_depth(width_mm, depth_mm);
        if let Some(dims) = clearance.fit_dome(nominal_dome) {
            let shrunk = dims.half_w < nominal_dome.half_w - 1e-4
                || dims.depth < nominal_dome.depth - 1e-4;
            let detail = if shrunk {
                format!(
                    "dome key shrunk to fit (1 mm wall): {:.2}×{:.2} mm, {:.2} mm deep",
                    dims.half_w * 2.0, dims.half_l * 2.0, dims.depth
                )
            } else {
                String::new()
            };
            Some((Box::new(DomeGenerator { dims: Some(dims) }), detail))
        } else {
            None
        }
    }

    fn half_diagonal(&self, tolerance: f32) -> f32 {
        let dims = self.dims.expect("must be fitted");
        dims.half_w.max(dims.half_l) + tolerance
    }

    fn depth(&self) -> f32 {
        let dims = self.dims.expect("must be fitted");
        dims.depth
    }

    fn build_peg(&self, frame: &KeyFrame, lean: LeanXform, _fillet_mm: f32) -> IndexedMesh {
        let dims = self.dims.expect("must be fitted");
        build_dome_leaned(frame, dims.half_w, dims.half_l, dims.depth, 0.0, DOME_SEGMENTS, lean)
    }

    fn build_socket(&self, frame: &KeyFrame, tolerance: f32, lean: LeanXform, _fillet_mm: f32) -> IndexedMesh {
        let dims = self.dims.expect("must be fitted");
        build_dome_leaned(frame, dims.half_w, dims.half_l, dims.depth, tolerance, DOME_SEGMENTS, lean)
    }

    fn clone_box(&self) -> Box<dyn RegistrationKeyGenerator> {
        Box::new(self.clone())
    }
}

impl KeyShape {
    pub fn generator(&self) -> Box<dyn RegistrationKeyGenerator> {
        match self {
            KeyShape::Frustum => Box::new(FrustumGenerator { dims: None }),
            KeyShape::Dome => Box::new(DomeGenerator { dims: None }),
        }
    }
}

#[derive(Clone)]
pub enum KeyPlan {
    Fitted {
        generator: Box<dyn RegistrationKeyGenerator>,
        detail: String,
    },
    None {
        detail: String,
    },
}

impl KeyPlan {
    pub fn kind(&self) -> KeyKind {
        match self {
            KeyPlan::Fitted { generator, .. } => generator.kind(),
            KeyPlan::None { .. } => KeyKind::None,
        }
    }
    pub fn detail(&self) -> &str {
        match self {
            KeyPlan::Fitted { detail, .. } | KeyPlan::None { detail } => detail,
        }
    }
}

fn decide_key(
    clearance: &Clearance,
    width_mm: f32,
    depth_mm: f32,
    generator: &dyn RegistrationKeyGenerator,
) -> KeyPlan {
    if let Some((fitted_gen, detail)) = generator.fit(clearance, width_mm, depth_mm) {
        KeyPlan::Fitted {
            generator: fitted_gen,
            detail,
        }
    } else {
        KeyPlan::None {
            detail: "No key placed — the part is too thin for any key.".to_string(),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn apply_key(
    model: &IndexedMesh,
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    membrane: &Membrane,
    shape: KeyShape,
    swap_sides: bool,
    tilt: KeyTilt,
    width_mm: f32,
    depth_mm: f32,
    fillet_mm: f32,
    tolerance: f32,
) -> KeyOutcome {
    let frame0 = match frame_from_membrane(membrane) {
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

    let (frame, part_a, part_b) = if swap_sides {
        (flip_frame_sides(&frame0), part_b, part_a)
    } else {
        (frame0, part_a, part_b)
    };
    let orig_for_lean = frame;

    let clearance = Clearance::probe(&frame, model, model);
    let generator = shape.generator();
    let plan = decide_key(&clearance, width_mm, depth_mm, &*generator);

    let unswap = |mut out: KeyOutcome| -> KeyOutcome {
        if swap_sides {
            std::mem::swap(&mut out.part_a, &mut out.part_b);
        }
        out
    };

    match plan {
        KeyPlan::Fitted { generator, detail } => {
            let out = unswap(apply_fitted_key(part_a, part_b, &frame, &orig_for_lean, tilt, &*generator, fillet_mm, tolerance));
            let expected_kind = generator.kind();
            if out.kind == expected_kind {
                KeyOutcome { detail, ..out }
            } else {
                KeyOutcome {
                    kind: KeyKind::None,
                    detail: format!("No key placed — {:?} boolean failed: {}", expected_kind, out.detail),
                    ..out
                }
            }
        }
        KeyPlan::None { detail } => {
            let (pa, pb) = if swap_sides { (part_b, part_a) } else { (part_a, part_b) };
            KeyOutcome { part_a: pa, part_b: pb, kind: KeyKind::None, detail }
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn build_key_preview_soup_from_membrane(
    model: &IndexedMesh,
    membrane: &Membrane,
    shape: KeyShape,
    swap_sides: bool,
    tilt: KeyTilt,
    width_mm: f32,
    depth_mm: f32,
    fillet_mm: f32,
    tolerance: f32,
) -> Option<(Vec<f32>, KeyKind, String, Option<KeyFrameInfo>)> {
    let frame = match frame_from_membrane(membrane) {
        Some(f) => f,
        None => {
            return Some((
                Vec::new(),
                KeyKind::None,
                "No key — degenerate cut frame.".to_string(),
                None,
            ))
        }
    };

    let placed = if swap_sides { flip_frame_sides(&frame) } else { frame };
    let orig_for_lean = placed;
    let clearance = Clearance::probe(&placed, model, model);
    let generator = shape.generator();
    let plan = decide_key(&clearance, width_mm, depth_mm, &*generator);
    let build_frame = frame_extruding_toward_part_b(&placed);
    
    let half_diag = match &plan {
        KeyPlan::Fitted { generator, .. } => generator.half_diagonal(tolerance),
        KeyPlan::None { .. } => 0.0,
    };
    let lean = LeanXform::for_build(&orig_for_lean, &build_frame, &tilt, half_diag);

    let mut soup: Vec<f32> = Vec::new();
    let (kind, detail) = match &plan {
        KeyPlan::Fitted { generator, detail } => {
            let peg_mesh = generator.build_peg(&build_frame, lean, fillet_mm);
            let socket_mesh = generator.build_socket(&build_frame, tolerance, lean, fillet_mm);
            append_soup(&mut soup, &peg_mesh);
            append_soup(&mut soup, &socket_mesh);
            (generator.kind(), detail.clone())
        }
        KeyPlan::None { detail } => (KeyKind::None, detail.clone()),
    };
    let info = build_key_frame_info(&placed, &build_frame, &plan, lean);
    Some((soup, kind, detail, info))
}

#[allow(clippy::too_many_arguments)]
pub fn build_key_preview_soup(
    model: &IndexedMesh,
    loop_pts: &[Vec3],
    membrane_smoothing: f32,
    density: f32,
    shape: KeyShape,
    swap_sides: bool,
    tilt: KeyTilt,
    width_mm: f32,
    depth_mm: f32,
    fillet_mm: f32,
    tolerance: f32,
) -> Option<(Vec<f32>, KeyKind, String, Option<KeyFrameInfo>)> {
    use crate::membrane::{build_membrane_full, CONTOUR_SUBDIVISIONS, DEFAULT_GRID_DIVISIONS};

    let grid = DEFAULT_GRID_DIVISIONS * (density.clamp(1.0, 4.0) as f64);
    let membrane =
        build_membrane_full(loop_pts, CONTOUR_SUBDIVISIONS, membrane_smoothing, grid)?;
    build_key_preview_soup_from_membrane(
        model,
        &membrane,
        shape,
        swap_sides,
        tilt,
        width_mm,
        depth_mm,
        fillet_mm,
        tolerance,
    )
}

#[derive(Debug, Clone, Copy)]
pub struct KeyFrameInfo {
    pub anchor: Vec3,
    pub axis: Vec3,
    pub u: Vec3,
    pub v: Vec3,
    pub tip: Vec3,
    pub depth: f32,
}

fn build_key_frame_info(
    natural: &KeyFrame,
    build_frame: &KeyFrame,
    plan: &KeyPlan,
    lean: LeanXform,
) -> Option<KeyFrameInfo> {
    let depth = match plan {
        KeyPlan::Fitted { generator, .. } => generator.depth(),
        KeyPlan::None { .. } => return None,
    };
    let (tx, ty, tz) = lean.apply(0.0, 0.0, depth);
    let tip = build_frame
        .anchor
        .add(build_frame.u.scale(tx))
        .add(build_frame.v.scale(ty))
        .add(build_frame.axis.scale(tz));
    Some(KeyFrameInfo {
        anchor: natural.anchor,
        axis: natural.axis,
        u: natural.u,
        v: natural.v,
        tip,
        depth,
    })
}

fn append_soup(soup: &mut Vec<f32>, mesh: &IndexedMesh) {
    for t in &mesh.triangles {
        for &vi in t {
            let v = mesh.positions[vi as usize];
            soup.extend_from_slice(&[v.x, v.y, v.z]);
        }
    }
}

fn apply_fitted_key(
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    frame: &KeyFrame,
    orig_for_lean: &KeyFrame,
    tilt: KeyTilt,
    generator: &dyn RegistrationKeyGenerator,
    fillet_mm: f32,
    tolerance: f32,
) -> KeyOutcome {
    let build_frame = frame_extruding_toward_part_b(frame);
    let half_diag = generator.half_diagonal(tolerance);
    let lean = LeanXform::for_build(orig_for_lean, &build_frame, &tilt, half_diag);
    let peg_mesh = generator.build_peg(&build_frame, lean, fillet_mm);
    let socket_mesh = generator.build_socket(&build_frame, tolerance, lean, fillet_mm);

    let result = (|| -> Result<(IndexedMesh, IndexedMesh), String> {
        let a = to_manifold(&part_a).map_err(|e| format!("part_a invalid: {e}"))?;
        let b = to_manifold(&part_b).map_err(|e| format!("part_b invalid: {e}"))?;
        let peg = to_manifold(&peg_mesh).map_err(|e| format!("peg invalid: {e}"))?;
        let socket = to_manifold(&socket_mesh).map_err(|e| format!("socket invalid: {e}"))?;

        let a_keyed = a.union(&peg);
        let b_keyed = b.difference(&socket);

        let a_out = crate::membrane::manifold_to_indexed(&a_keyed)
            .ok_or("union produced empty result")?;
        let b_out = crate::membrane::manifold_to_indexed(&b_keyed)
            .ok_or("difference produced empty result")?;
        Ok((a_out, b_out))
    })();

    match result {
        Ok((a_out, b_out)) => KeyOutcome {
            part_a: a_out,
            part_b: b_out,
            kind: generator.kind(),
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

    /// Clamp an oblong dome (per-axis) so the grown half-ellipsoid keeps ≥ margin
    /// from every wall: `depth` against part_b's depth, `half_w`/`half_l` against
    /// the lateral walls. Each axis is capped independently (the oblong proportions
    /// are preserved where they fit, only over-large axes shrink). Returns `None`
    /// if the result is smaller than the minimum useful dome on any axis.
    fn fit_dome(&self, nominal: DomeDims) -> Option<DomeDims> {
        let m = KEY_WALL_MARGIN_MM;
        let tol = DEFAULT_KEY_TOLERANCE_MM;
        let cap_depth = (self.depth_b - m - tol).max(0.0);
        let cap_w = (self.half_room_u() - m - tol).max(0.0);
        let cap_l = (self.half_room_v() - m - tol).max(0.0);
        let half_w = nominal.half_w.min(cap_w);
        let half_l = nominal.half_l.min(cap_l);
        let depth = nominal.depth.min(cap_depth);
        // The minimum useful dome: a hemisphere of the floor radius (so the floor
        // applies to the semi-axes and the bulge depth alike).
        let floor = KEY_MIN_DOME_RADIUS_MM;
        if half_w < floor || half_l < floor || depth < floor {
            None
        } else {
            Some(DomeDims { half_w, half_l, depth })
        }
    }
}

/// Smallest base footprint (width/length, mm) a frustum key is allowed to shrink
/// to before we give up on it and try the dome. The cutoff is 0.99 mm: a key is
/// placed as long as its size is ≥ 0.99 mm, and only rejected when smaller.
const KEY_MIN_FOOTPRINT_MM: f32 = 0.99;
/// Smallest depth (mm) a frustum key may shrink to before we try the dome.
const KEY_MIN_DEPTH_MM: f32 = 0.99;
/// Smallest dome radius (mm) worth placing before falling back to no key. (Below the
/// 0.99 mm frustum cutoff — a dome can usefully locate at a smaller size.)
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

/// Build a watertight OBLONG dome — a half-ellipsoid bulging along `+axis` of the
/// (already part_b-facing) `frame`, closed by a flat disk at the mouth plane.
///
/// The half-ellipsoid has semi-axes `half_w` (along `u`), `half_l` (along `v`),
/// and `depth` (along `+axis`): equal semi-axes give a hemisphere, unequal ones an
/// oblong dome. A point on the unit hemisphere `(sinθcosφ, sinθsinφ, cosθ)` maps to
/// `(half_w·…, half_l·…, depth·cosθ)`. Below the equator (z=0) a short straight
/// skirt drops to the mouth plane, then a flat cap closes it.
///
/// `grow` dilates every semi-axis by that amount (the socket = peg with
/// `grow = tolerance`), and the flat cap sits at `z = −grow − overlap` — pulled
/// back into part_a by `grow` (socket clearance) plus the fixed `KEY_BASE_OVERLAP_MM`
/// so the dome base overlaps part_a's solid for a clean union (and the socket mouth
/// fully breaches part_b). The straight skirt makes the socket a clean per-axis
/// dilation of the peg (no coincident faces) so the boolean is robust.
///
/// `segments` = longitude steps; the surface uses a fixed number of latitude rings.
fn build_dome(
    frame: &KeyFrame,
    half_w: f32,
    half_l: f32,
    depth: f32,
    grow: f32,
    segments: usize,
) -> IndexedMesh {
    build_dome_leaned(frame, half_w, half_l, depth, grow, segments, LeanXform::IDENTITY)
}

/// [`build_dome`] with an explicit [`LeanXform`] for a rotated dome. The bulge is
/// rigid-rotated; the lower rings blend to keep the flat mouth disk glued in the
/// cut plane (the dome's many latitude rings make the collar blend smooth).
fn build_dome_leaned(
    frame: &KeyFrame,
    half_w: f32,
    half_l: f32,
    depth: f32,
    grow: f32,
    segments: usize,
    lean: LeanXform,
) -> IndexedMesh {
    let aw = (half_w + grow).max(1e-4); // semi-axis along u
    let al = (half_l + grow).max(1e-4); // semi-axis along v
    let ad = (depth + grow).max(1e-4); // semi-axis along +axis (bulge depth)
    // Cap plane: pulled back by `grow` (socket dilation) + the fixed overlap so the
    // base sinks into part_a. For the peg (grow=0) this is just the overlap.
    let z_mouth = -grow - KEY_BASE_OVERLAP_MM;
    let seg = segments.max(6);
    let rings = DOME_RINGS; // latitude bands from the EQUATOR (z=0) up to the pole

    let local = |x: f32, y: f32, z: f32| -> Vec3 {
        let (x, y, z) = lean.apply(x, y, z);
        frame
            .anchor
            .add(frame.u.scale(x))
            .add(frame.v.scale(y))
            .add(frame.axis.scale(z))
    };

    let mut positions: Vec<Vec3> = Vec::new();
    // Pole (top of the bulge, along +axis at z = ad).
    let pole = positions.len() as u32;
    positions.push(local(0.0, 0.0, ad));
    // Latitude rings from just below the pole down to the equator (θ: 0→π/2).
    // Rings are biased TOWARD the pole (θ ∝ t² where t = i/rings) so more sit
    // where curvature is highest — the tip is the first place facets show, so
    // clustering rings there smooths it far more than uniform spacing for the
    // same ring count.
    let mut ring_start: Vec<u32> = Vec::with_capacity(rings + 1);
    for i in 1..=rings {
        let t = i as f32 / rings as f32; // 0→1
        let theta = (std::f32::consts::FRAC_PI_2) * t * t; // pole-biased 0→π/2
        let z = ad * theta.cos(); // ad → 0
        let s = theta.sin(); // 0 → 1 (lateral scale)
        ring_start.push(positions.len() as u32);
        for j in 0..seg {
            let phi = 2.0 * std::f32::consts::PI * (j as f32 / seg as f32);
            positions.push(local(aw * s * phi.cos(), al * s * phi.sin(), z));
        }
    }
    // Skirt ring: the equator profile dropped straight down to the mouth plane (a
    // short vertical wall so the socket cleanly clears the peg as it enters).
    let skirt = positions.len() as u32;
    for j in 0..seg {
        let phi = 2.0 * std::f32::consts::PI * (j as f32 / seg as f32);
        positions.push(local(aw * phi.cos(), al * phi.sin(), z_mouth));
    }
    ring_start.push(skirt);
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
    // Bands between successive rings (cur nearer the pole, nxt nearer the mouth),
    // INCLUDING the equator→skirt band (the vertical wall).
    for i in 0..ring_start.len() - 1 {
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
    // Flat cap (skirt ring → center). Its outward normal points along −axis (the
    // open mouth into part_b), so wind CW seen from +axis.
    let eq = *ring_start.last().unwrap();
    for j in 0..seg {
        let a = eq + j as u32;
        let b = eq + ((j + 1) % seg) as u32;
        triangles.push([center, b, a]);
    }
    IndexedMesh { positions, triangles }
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
        let peg = build_frustum(&frame, dims, 0.0, 0.0);
        assert_eq!(peg.positions.len(), 8, "frustum has 8 corners");
        assert_eq!(peg.triangles.len(), 12, "frustum has 12 triangles");
        let m = to_manifold(&peg).expect("frustum converts to a watertight manifold");
        assert!(m.num_tri() > 0, "non-empty manifold");
    }

    // Test 1b: a FILLETED frustum (rounded corners + tip) is watertight, and its
    // peg still fits inside the grown filleted socket.
    #[test]
    fn filleted_frustum_is_watertight_and_fits() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let fillet = 0.6;
        let peg = build_frustum(&frame, dims, 0.0, fillet);
        // Rounded build has many more verts/tris than the 8/12 sharp box.
        assert!(peg.positions.len() > 8, "filleted peg has extra verts");
        let peg_m = to_manifold(&peg).expect("filleted peg is watertight");
        assert!(peg_m.num_tri() > 0, "non-empty");
        // Socket = peg offset by tol with fillet grown by tol (matches apply_frustum).
        let socket_m =
            to_manifold(&build_frustum(&frame, dims, 0.1, fillet + 0.1)).expect("filleted socket");
        let leftover = peg_m.difference(&socket_m);
        assert!(
            leftover.is_empty() || leftover.num_tri() == 0,
            "filleted peg fits inside grown filleted socket (leftover = {})",
            leftover.num_tri()
        );
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
        let peg = build_frustum(&frame, dims, 0.0, 0.0);
        let socket = build_frustum(&frame, dims, tol, 0.0);

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
        let out = apply_key(&model, part_a, part_b, &mem, KeyShape::Frustum, false, KeyTilt::default(), 5.0, 5.0, 0.0, 0.1);

        assert_eq!(out.kind, KeyKind::Frustum, "frustum key placed: {}", out.detail);
        assert!(
            out.part_a.triangle_count() > a_tris_before,
            "part_a gained triangles from the unioned peg"
        );
        // Both halves remain watertight (convertible to a manifold).
        assert!(to_manifold(&out.part_a).is_ok(), "keyed part_a is watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "keyed part_b is watertight");
    }

    // Test 4b: swap_sides flips which half gets the peg — now part_B grows it (the
    // mirror of test 4), and the returned parts keep the caller's a/b orientation.
    #[test]
    fn swap_sides_puts_the_peg_on_part_b() {
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let part_a = axis_aligned_slab(Vec3::new(-5.0, -5.0, 0.0), Vec3::new(5.0, 5.0, 10.0));
        let part_b = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 0.0));
        let mem = flat_membrane(10.0);

        let b_tris_before = part_b.triangle_count();
        // swap_sides = true → peg unions onto part_b, socket carves part_a.
        let out = apply_key(&model, part_a, part_b, &mem, KeyShape::Frustum, true, KeyTilt::default(), 5.0, 5.0, 0.0, 0.1);

        assert_eq!(out.kind, KeyKind::Frustum, "swapped frustum key placed: {}", out.detail);
        assert!(
            out.part_b.triangle_count() > b_tris_before,
            "part_b gained the peg when swapped ({} → {})",
            b_tris_before,
            out.part_b.triangle_count()
        );
        assert!(to_manifold(&out.part_a).is_ok(), "swapped part_a watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "swapped part_b watertight");
    }

    // Test 5: the peg fits inside the grown socket cavity (difference is empty).
    #[test]
    fn peg_fits_inside_socket_cavity() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let peg = to_manifold(&build_frustum(&frame, dims, 0.0, 0.0)).expect("peg");
        let socket = to_manifold(&build_frustum(&frame, dims, 0.1, 0.0)).expect("socket");
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

        let out = apply_key(&model, part_a, part_b.clone(), &mem, KeyShape::Frustum, false, KeyTilt::default(), key_w, key_d, 0.0, 0.1);

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
        let dome_out = apply_key(&model1, pa, pb, &mem, KeyShape::Frustum, false, KeyTilt::default(), 5.0, 5.0, 0.0, 0.1);
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
        let none_out = apply_key(&model2, pa2, pb2, &mem, KeyShape::Frustum, false, KeyTilt::default(), 5.0, 5.0, 0.0, 0.1);
        assert_eq!(none_out.kind, KeyKind::None, "no key: {}", none_out.detail);
        assert!(none_out.detail.contains("too thin"), "no-key reason: {:?}", none_out.detail);
        assert_eq!(
            none_out.part_b.triangle_count(),
            pb2_tris,
            "part_b is unchanged when no key is placed"
        );
    }

    // Test 8b: choosing Dome on a THICK part places a dome on purpose (not a
    // frustum), proving the shape selector overrides the default frustum-first.
    #[test]
    fn explicit_dome_shape_places_a_dome_on_a_thick_part() {
        let mem = flat_membrane(10.0);
        // Plenty thick for a frustum — but we ask for a dome explicitly.
        let (model, pa, pb) = split_halves(20.0, 20.0);
        let out = apply_key(&model, pa, pb, &mem, KeyShape::Dome, false, KeyTilt::default(), 5.0, 5.0, 0.0, 0.1);
        assert_eq!(
            out.kind,
            KeyKind::Dome,
            "explicit dome on a thick part is a dome, not a frustum: {}",
            out.detail
        );
        assert!(to_manifold(&out.part_a).is_ok(), "domed part_a watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "domed part_b watertight");
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
        let (soup, kind, _detail, _frame) =
            build_key_preview_soup(&model, &loop_pts, DEFAULT_MEMBRANE_SMOOTHING, 1.0, KeyShape::Frustum, false, KeyTilt::default(), 5.0, 5.0, 0.0, 0.1)
                .expect("preview builds");
        assert_eq!(kind, KeyKind::Frustum, "healthy box → frustum key preview");
        assert!(!soup.is_empty(), "preview soup non-empty");
        assert_eq!(soup.len() % 9, 0, "whole triangles");
        assert!(soup.iter().all(|f| f.is_finite()), "all coords finite");
    }

    // Test 6b: the swap flag visibly flips the preview — the key's body extends to
    // the OPPOSITE side of the cut (so the flip is apparent on screen, not a no-op).
    #[test]
    fn swap_flips_the_preview_key_direction() {
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let loop_pts = vec![
            Vec3::new(-5.0, -5.0, 0.0),
            Vec3::new(5.0, -5.0, 0.0),
            Vec3::new(5.0, 5.0, 0.0),
            Vec3::new(-5.0, 5.0, 0.0),
        ];
        // The cut is at z=0; the peg extrudes along ±z. Measure the soup's z-extent
        // on each side of the cut for unswapped vs swapped.
        let z_extent = |swap: bool| -> (f32, f32) {
            let (soup, _, _, _) = build_key_preview_soup(
                &model, &loop_pts, DEFAULT_MEMBRANE_SMOOTHING, 1.0, KeyShape::Frustum, swap, KeyTilt::default(), 5.0, 5.0, 0.0, 0.1,
            )
            .expect("preview builds");
            let mut lo = f32::INFINITY;
            let mut hi = f32::NEG_INFINITY;
            for c in soup.chunks_exact(3) {
                lo = lo.min(c[2]);
                hi = hi.max(c[2]);
            }
            (lo, hi)
        };
        let (lo0, hi0) = z_extent(false);
        let (lo1, hi1) = z_extent(true);
        // Unswapped: peg extends mostly to ONE side; swapped: mostly to the OTHER.
        // The body's far extent should land on opposite signs of z.
        let far0 = if hi0.abs() > lo0.abs() { hi0 } else { lo0 };
        let far1 = if hi1.abs() > lo1.abs() { hi1 } else { lo1 };
        assert!(
            far0.signum() != far1.signum(),
            "swap flips the key to the other side of the cut (far0={far0}, far1={far1})"
        );
    }

    // Test 9: the dome key (round AND oblong) is watertight and the peg fits inside
    // the grown socket.
    #[test]
    fn dome_is_watertight_and_fits() {
        let mem = flat_membrane(10.0);
        let frame = frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        // (half_w, half_l, depth) cases: a round hemisphere and two oblong ones.
        for (hw, hl, d) in [(3.0, 3.0, 3.0), (4.0, 2.0, 3.0), (2.0, 2.5, 5.0)] {
            let peg = build_dome(&frame, hw, hl, d, 0.0, DOME_SEGMENTS);
            let socket = build_dome(&frame, hw, hl, d, 0.1, DOME_SEGMENTS);
            let peg_m = to_manifold(&peg)
                .unwrap_or_else(|e| panic!("dome peg ({hw},{hl},{d}) watertight: {e}"));
            let socket_m = to_manifold(&socket)
                .unwrap_or_else(|e| panic!("dome socket ({hw},{hl},{d}) watertight: {e}"));
            let leftover = peg_m.difference(&socket_m);
            assert!(
                leftover.is_empty() || leftover.num_tri() == 0,
                "dome peg ({hw},{hl},{d}) fits inside grown socket (leftover = {})",
                leftover.num_tri()
            );
        }
    }

    // Test 11: a TILTED key rigidly rotates (keeps its exact shape) about the base,
    // sunk so the tilted base stays buried below the cut plane, and the tip leans
    // over. The whole key is one rigid body — no shear/stretch.
    #[test]
    fn tilt_rotates_rigidly_and_leans_the_tip() {
        let mem = flat_membrane(10.0);
        let frame =
            frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let half_diag = 0.5 * dims.width.hypot(dims.length);
        let tilt = KeyTilt::new(std::f32::consts::FRAC_PI_4, 0.0, 0.0); // 45° lean
        let orig = frame_from_membrane(&mem).expect("frame");
        let lean = LeanXform::for_build(&orig, &frame, &tilt, half_diag);

        let _ = build_frustum_leaned(&frame, dims, 0.0, 0.0, lean); // builds watertight
        // The base footprint must stay buried below the cut plane: transform each base
        // corner (local z = the mouth plane) and check its height along the axis is
        // ≤ ~0, so the union bonds along a fully embedded base.
        let bw = dims.width * 0.5;
        let bl = dims.length * 0.5;
        let z_mouth = -KEY_BASE_OVERLAP_MM;
        let mut max_base_height = f32::NEG_INFINITY;
        for &(sx, sy) in &[(1.0f32, 1.0f32), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)] {
            // local z height of the transformed base corner (z component of apply()).
            let (_, _, hz) = lean.apply(sx * bw, sy * bl, z_mouth);
            max_base_height = max_base_height.max(hz);
        }
        assert!(
            max_base_height <= 0.01,
            "tilted base stays buried below the cut plane (highest base z = {max_base_height})"
        );
        // Tip: the apex leans laterally by a large fraction of depth.
        let (tx, ty, tz) = lean.apply(0.0, 0.0, dims.depth);
        let lateral = (tx * tx + ty * ty).sqrt();
        assert!(
            lateral > dims.depth * 0.5,
            "tip leans over (lateral {lateral} mm at 45°, depth {})",
            dims.depth
        );
        let _ = tz;
    }

    // Test 11a2: the lean is a RIGID rotation — pairwise distances between any two
    // points are preserved (the key keeps its exact shape, no shear).
    #[test]
    fn tilt_preserves_body_shape() {
        let mem = flat_membrane(10.0);
        let frame =
            frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        let dims = FrustumDims::from_width_depth(5.0, 6.0);
        let orig = frame_from_membrane(&mem).expect("frame");
        let tilt = KeyTilt::new(40.0_f32.to_radians(), 0.9, 0.4);
        let lean = LeanXform::for_build(&orig, &frame, &tilt, 4.0);
        // Any two points: their distance must be the same before and after the lean
        // (a rigid rotation + uniform sink preserves all lengths).
        let a = (2.0f32, 1.0f32, dims.depth * 0.3);
        let b = (-1.5f32, 2.0f32, dims.depth);
        let dist = |p: (f32, f32, f32), q: (f32, f32, f32)| {
            let (dx, dy, dz) = (p.0 - q.0, p.1 - q.1, p.2 - q.2);
            (dx * dx + dy * dy + dz * dz).sqrt()
        };
        let d_before = dist(a, b);
        let d_after = dist(lean.apply(a.0, a.1, a.2), lean.apply(b.0, b.1, b.2));
        assert!(
            (d_before - d_after).abs() < 1e-3,
            "lean is rigid — distances preserved (dist {d_before} → {d_after})"
        );
    }

    // Test 11b: a tilted key (peg AND socket) is watertight at a range of angles —
    // the rigid lean + collar must not break the manifold. (The peg/socket SLIDE FIT
    // under lean is exercised end-to-end by the boolean in the real-pipeline tests;
    // here we pin the per-mesh watertightness, which is what manifold needs.)
    #[test]
    fn tilted_key_is_watertight() {
        let mem = flat_membrane(10.0);
        let frame =
            frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        let orig = frame_from_membrane(&mem).expect("frame");
        for (deg, az, roll, fillet) in [
            (30.0_f32, 0.0_f32, 0.0_f32, 0.0_f32),
            (55.0, 1.2, 0.6, 0.0),
            (45.0, 2.5, 0.0, 0.7),
        ] {
            let tilt = KeyTilt::new(deg.to_radians(), az, roll);
            let dims = FrustumDims::from_width_depth(5.0, 5.0);
            let lean = LeanXform::for_build(&orig, &frame, &tilt, dims.depth);
            let peg = build_frustum_leaned(&frame, dims, 0.0, fillet, lean);
            // Match apply_frustum: when leaning, socket uses the SAME fillet as the
            // peg (dilated extents) so peg/socket share z-levels and nest per slab.
            let socket = build_frustum_leaned(&frame, dims, 0.1, fillet, lean);
            let peg_m = to_manifold(&peg)
                .unwrap_or_else(|e| panic!("tilted peg ({deg}°,{az},{roll}) watertight: {e}"));
            let socket_m = to_manifold(&socket)
                .unwrap_or_else(|e| panic!("tilted socket ({deg}°) watertight: {e}"));
            assert!(peg_m.num_tri() > 0 && socket_m.num_tri() > 0, "non-empty");
            // Per-z-slab nesting: the peg fits fully inside the grown socket cavity.
            let leftover = peg_m.difference(&socket_m);
            assert!(
                leftover.is_empty() || leftover.num_tri() == 0,
                "tilted peg ({deg}°) fits inside the socket cavity (leftover = {})",
                leftover.num_tri()
            );
        }
    }

    // Test 11c: zero tilt is a TRUE no-op — the leaned build is byte-identical to the
    // plain build (so a key with no lean is exactly today's geometry).
    #[test]
    fn zero_tilt_is_identity() {
        let mem = flat_membrane(10.0);
        let frame =
            frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        let orig = frame_from_membrane(&mem).expect("frame");
        let lean = LeanXform::for_build(&orig, &frame, &KeyTilt::default(), 5.0);
        assert!(lean.identity, "zero tilt + zero roll → identity lean");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let plain = build_frustum(&frame, dims, 0.0, 0.4);
        let leaned = build_frustum_leaned(&frame, dims, 0.0, 0.4, lean);
        assert_eq!(plain.positions.len(), leaned.positions.len());
        for (a, b) in plain.positions.iter().zip(leaned.positions.iter()) {
            assert!(
                a.sub(*b).length() < 1e-6,
                "zero-tilt lean leaves geometry untouched"
            );
        }
    }

    // Test 11d: the full apply_key path with a tilt keeps both halves watertight and
    // still bonds the peg (part_a gains tris) — end-to-end, not just the builder.
    #[test]
    fn apply_key_with_tilt_is_watertight() {
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let part_a = axis_aligned_slab(Vec3::new(-5.0, -5.0, 0.0), Vec3::new(5.0, 5.0, 10.0));
        let part_b = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 0.0));
        let mem = flat_membrane(10.0);
        let a_before = part_a.triangle_count();
        let tilt = KeyTilt::new(40.0_f32.to_radians(), 0.7, 0.3);
        let out = apply_key(&model, part_a, part_b, &mem, KeyShape::Frustum, false, tilt, 4.0, 4.0, 0.0, 0.1);
        assert_eq!(out.kind, KeyKind::Frustum, "tilted key placed: {}", out.detail);
        assert!(out.part_a.triangle_count() > a_before, "peg bonded to part_a");
        assert!(to_manifold(&out.part_a).is_ok(), "tilted part_a watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "tilted part_b watertight");
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
        let out = apply_key(&model, split.part_a, split.part_b, &split.membrane, KeyShape::Frustum, false, KeyTilt::default(), 5.0, 5.0, 0.0, 0.1);

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

    #[derive(Debug, Clone)]
    struct CylinderGenerator {
        depth: f32,
        radius: f32,
    }

    impl RegistrationKeyGenerator for CylinderGenerator {
        fn kind(&self) -> KeyKind {
            KeyKind::Dome
        }

        fn fit(&self, _clearance: &Clearance, _width_mm: f32, _depth_mm: f32) -> Option<(Box<dyn RegistrationKeyGenerator>, String)> {
            Some((Box::new(self.clone()), "custom cylinder fit".to_string()))
        }

        fn half_diagonal(&self, tolerance: f32) -> f32 {
            self.radius + tolerance
        }

        fn depth(&self) -> f32 {
            self.depth
        }

        fn build_peg(&self, frame: &KeyFrame, lean: LeanXform, _fillet_mm: f32) -> IndexedMesh {
            build_dome_leaned(frame, self.radius, self.radius, self.depth, 0.0, DOME_SEGMENTS, lean)
        }

        fn build_socket(&self, frame: &KeyFrame, tolerance: f32, lean: LeanXform, _fillet_mm: f32) -> IndexedMesh {
            build_dome_leaned(frame, self.radius, self.radius, self.depth, tolerance, DOME_SEGMENTS, lean)
        }

        fn clone_box(&self) -> Box<dyn RegistrationKeyGenerator> {
            Box::new(self.clone())
        }
    }

    #[test]
    fn extensibility_of_registration_key_types() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let orig = frame;
        let generator = CylinderGenerator { depth: 4.0, radius: 2.0 };
        let build_frame = frame_extruding_toward_part_b(&frame);
        let lean = LeanXform::for_build(&orig, &build_frame, &KeyTilt::default(), generator.half_diagonal(0.1));
        
        let peg = generator.build_peg(&build_frame, lean, 0.0);
        let socket = generator.build_socket(&build_frame, 0.1, lean, 0.0);
        
        assert!(to_manifold(&peg).is_ok());
        assert!(to_manifold(&socket).is_ok());
        
        let clearance = Clearance {
            depth_b: 10.0,
            lat_u_neg: 10.0,
            lat_u_pos: 10.0,
            lat_v_neg: 10.0,
            lat_v_pos: 10.0,
        };
        let plan = decide_key(&clearance, 4.0, 4.0, &generator);
        match plan {
            KeyPlan::Fitted { generator: fitted_gen, detail } => {
                assert_eq!(fitted_gen.kind(), KeyKind::Dome);
                assert_eq!(detail, "custom cylinder fit");
            }
            _ => panic!("Expected Fitted plan"),
        }
    }
}
