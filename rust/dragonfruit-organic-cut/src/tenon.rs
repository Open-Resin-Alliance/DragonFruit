//! Registration tenon — a tenon + matching mortise straddling an organic cut, so the
//! two severed halves mortise together in exactly one alignment.
//!
//! The geometric idea (see `.scratch/organic-cut-tenon-dev-plan.md`):
//!   1. Derive a **frame** from the membrane: anchor = its centroid, axis = its
//!      average normal (the same +normal direction the part-grouping uses), and
//!      `cut_area` = the membrane surface area.
//!   2. Build a **tapered rectangular frustum** (wide base on the cut, narrow tip)
//!      sized from `cut_area`. The **tenon** (nominal) is union'd onto `part_a`
//!      (the +normal side); the **mortise** (tenon dilated by the fit tolerance) is
//!      differenced from `part_b`.
//!   3. Enforce **≥1 mm of solid material between tenon and wall on both halves**:
//!      shrink the frustum to fit; if it can't fit, fall back to a **half-sphere
//!      dome**; if even that can't fit, place **no tenon**. Each rung records WHY.
//!
//! Everything tenon-related lives in THIS module — nothing leaks into mesh-repair.
//! Requires the `manifold` feature (the boolean backend); gated at the crate root.

#![cfg(feature = "manifold")]

use dragonfruit_mesh_core::mesh::{IndexedMesh, Vec3};

use crate::membrane::{to_manifold, Membrane};

/// Fit tolerance: the mortise is this much larger than the tenon on every face, so
/// the tenon slides in instead of jamming (a print-scale slide fit).
pub const DEFAULT_TENON_TOLERANCE_MM: f32 = 0.1;

/// Bounds on a caller-chosen fit tolerance (mm). 0 is legal — a zero-clearance
/// press fit, for printers that undersize anyway — and the upper bound keeps a
/// stray value from eating the whole tenon: every extra 0.1 mm of mortise is 0.1 mm
/// less wall the fit ladder has to play with.
pub const TENON_TOLERANCE_MIN_MM: f32 = 0.0;
pub const TENON_TOLERANCE_MAX_MM: f32 = 1.0;

/// Bring a caller's tolerance into range; a NaN/absent value falls back to the
/// default slide fit rather than poisoning every clamp downstream.
fn sanitize_tolerance(tolerance: f32) -> f32 {
    if tolerance.is_finite() {
        tolerance.clamp(TENON_TOLERANCE_MIN_MM, TENON_TOLERANCE_MAX_MM)
    } else {
        DEFAULT_TENON_TOLERANCE_MM
    }
}

/// Minimum solid material that must remain between the tenon and ANY mesh wall, on
/// BOTH halves. The fit ladder (frustum → dome → none) exists to honor this.
pub const TENON_WALL_MARGIN_MM: f32 = 1.0;

/// Base rectangle proportion: length = this × width.
const TENON_LENGTH_TO_WIDTH: f32 = 1.25;

/// Top face linear scale relative to the base (taper): top is 50% of the base.
const TENON_TOP_SCALE: f32 = 0.5;

/// How far the tenon's base extends PAST the cut plane into the other half (mm), so
/// the tenon overlaps part_a's solid for a clean boolean union (not a fragile flush
/// butt-joint) and the mortise mouth fully breaches part_b's cut face.
const TENON_BASE_OVERLAP_MM: f32 = 0.3;

/// Points used to sample EACH rounded corner of the frustum's rounded-rectangle
/// cross-section. 4 corners × this = the per-ring point count of the side wall.
const FILLET_CORNER_SEGS: usize = 5;
/// Rings used to sweep the rounded-over TIP (from the side-wall shoulder up to the
/// tip pole). More = smoother dome-over.
const FILLET_TIP_RINGS: usize = 4;

/// Dome tessellation: longitude segments (around the axis) and latitude rings
/// (equator → pole). High enough that the half-ellipsoid reads as a smooth dome,
/// not a faceted bullet — the tenon is a small, low-tri solid so this is cheap.
/// Extra rings near the pole matter most: that's where curvature is highest, so
/// the tip is the first place facets show.
const DOME_SEGMENTS: usize = 64;
const DOME_RINGS: usize = 18;

/// Sane mm clamps on the user-chosen tenon width + depth (model units are mm). The
/// sliders enforce their own ranges; these are a backstop against a stray 0/huge
/// value producing a degenerate or absurd tenon. The 1 mm-wall fit ladder shrinks
/// below these on thin parts.
const TENON_WIDTH_MIN_MM: f32 = 0.5;
const TENON_WIDTH_MAX_MM: f32 = 50.0;
const TENON_DEPTH_MIN_MM: f32 = 0.5;
const TENON_DEPTH_MAX_MM: f32 = 50.0;

/// Default tenon width + depth (mm) when the caller doesn't specify (e.g. the cut
/// runs without explicit slider values). Matches the panel defaults: width 2 mm
/// (→ length auto = 2.5 mm via the 1.25× ratio), depth 2.5 mm.
pub const DEFAULT_TENON_WIDTH_MM: f32 = 2.0;
pub const DEFAULT_TENON_DEPTH_MM: f32 = 2.5;

/// The tenon SHAPE the user requested. Drives which rung the fit ladder starts on.
/// (Distinct from [`TenonKind`], which is what actually got PLACED after the ladder.)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TenonShape {
    /// Tapered rectangular frustum (the default — rotation-locking).
    #[default]
    Frustum,
    /// Half-sphere dome (round, locates but does not lock rotation).
    Dome,
}

impl TenonShape {
    /// Parse the camelCase string the frontend sends; unknown → Frustum.
    pub fn from_str_or_default(s: &str) -> Self {
        match s {
            "dome" => TenonShape::Dome,
            _ => TenonShape::Frustum,
        }
    }
}

/// Which kind of tenon actually got placed — drives the preview and the user alert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TenonKind {
    /// The primary tapered frustum (possibly shrunk to fit).
    Frustum,
    /// Half-sphere dome (chosen explicitly, OR the thin-part frustum fallback).
    Dome,
    /// No tenon placed (the part was too thin for any tenon).
    None,
}

impl TenonKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TenonKind::Frustum => "frustum",
            TenonKind::Dome => "dome",
            TenonKind::None => "none",
        }
    }
}

/// The placement frame for a tenon, derived from the membrane. `axis` points along
/// the membrane's +normal (into `part_a`); the base sits in the tangent plane at
/// `anchor`. `u`/`v` are the in-plane (cosmetic) base directions; `u` is width,
/// `v` is length.
#[derive(Debug, Clone, Copy)]
pub struct TenonFrame {
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
    /// Base length (along `v`), = `TENON_LENGTH_TO_WIDTH × width`.
    pub length: f32,
    /// Depth into the body (along `axis`).
    pub depth: f32,
}

impl FrustumDims {
    /// Build the nominal dimensions from the user's requested base **width** and
    /// **depth** (both in mm — model units are mm). The base length follows the
    /// fixed 1.25× proportion; the taper (top = 50% of base) is applied at build
    /// time. Values are clamped to a sane mm range so a stray 0 / huge input can't
    /// produce a degenerate or absurd tenon.
    pub fn from_width_depth(width_mm: f32, depth_mm: f32) -> Self {
        let width = width_mm.clamp(TENON_WIDTH_MIN_MM, TENON_WIDTH_MAX_MM);
        let depth = depth_mm.clamp(TENON_DEPTH_MIN_MM, TENON_DEPTH_MAX_MM);
        let length = TENON_LENGTH_TO_WIDTH * width;
        FrustumDims { width, length, depth }
    }
}

/// Half-ellipsoid (oblong dome) semi-axes, in mm. `half_w` is along `u`, `half_l`
/// along `v` (= `TENON_LENGTH_TO_WIDTH × half_w`, matching the frustum's footprint
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
        let width = width_mm.clamp(TENON_WIDTH_MIN_MM, TENON_WIDTH_MAX_MM);
        let depth = depth_mm.clamp(TENON_DEPTH_MIN_MM, TENON_DEPTH_MAX_MM);
        DomeDims {
            half_w: width * 0.5,
            half_l: TENON_LENGTH_TO_WIDTH * width * 0.5,
            depth,
        }
    }
}

/// The result of placing a tenon: the two (possibly modified) halves plus the kind
/// of tenon chosen and a human-readable reason (for the report + the user alert).
pub struct TenonOutcome {
    pub part_a: IndexedMesh,
    pub part_b: IndexedMesh,
    pub kind: TenonKind,
    /// Empty on a clean nominal frustum; otherwise WHY we shrank / fell back.
    pub detail: String,
}

/// Derive the tenon frame from the membrane: centroid anchor, area-weighted average
/// normal as the axis (matching the +normal side the part-grouping uses), and a
/// stable in-plane basis. Returns `None` if the membrane is degenerate (no area /
/// cancelling normals) — the caller then skips the tenon.
pub fn frame_from_membrane(membrane: &Membrane) -> Option<TenonFrame> {
    frame_from_membrane_at(membrane, None)
}

/// [`frame_from_membrane`] with the tenon placed at `at` — a point on the cut face,
/// in model-local space, which is where the user put the crosshair.
///
/// It is a POINT, not a displacement. An offset had to be interpreted: measured in
/// some basis, from some origin, and re-derived on every preview — and the frontend
/// and this function did not agree on any of those three, so the tenon landed
/// somewhere neither of them had pointed. A point needs no interpretation. It is
/// snapped to the membrane on the way in, which for a point picked ON the membrane
/// is a no-op, and for anything else is the nearest place it could actually sit.
pub fn frame_from_membrane_at(membrane: &Membrane, at: TenonAnchor) -> Option<TenonFrame> {
    if membrane.vertices.is_empty() || membrane.triangles.is_empty() {
        return None;
    }

    let cut_area = membrane.area();
    if !(cut_area > 1e-9) {
        return None;
    }

    // Where the user put it, or the middle of the cut if they have not moved it.
    // Either way it is SNAPPED ONTO the membrane and the normal taken THERE.
    //
    // Averaging the whole patch (centroid + area-weighted mean of every triangle
    // normal) describes a curved membrane by a single plane, which no point on a
    // saddle-shaped seam actually lies on: the tenon was built with a flat base on
    // that mean plane, so one corner punched through to the far side of the cut
    // while the opposite corner floated clear of it. On a flat membrane the two
    // agree, which is why it only showed up on curved seams.
    let seed = at.unwrap_or_else(|| {
        let mut centroid = Vec3::ZERO;
        for &p in &membrane.vertices {
            centroid = centroid.add(p);
        }
        centroid.scale(1.0 / membrane.vertices.len() as f32)
    });

    let mut anchor = seed;
    let mut best_d2 = f32::INFINITY;
    let mut best_tri = 0usize;
    for (i, t) in membrane.triangles.iter().enumerate() {
        let a = membrane.vertices[t[0] as usize];
        let b = membrane.vertices[t[1] as usize];
        let c = membrane.vertices[t[2] as usize];
        let (cp, d2) = crate::membrane::closest_on_tri(seed, a, b, c);
        if d2 < best_d2 {
            best_d2 = d2;
            anchor = cp;
            best_tri = i;
        }
    }

    // Local normal: area-weight only the triangles touching the anchor's triangle
    // vertices, so the axis follows the seam where the tenon actually sits while
    // staying steadier than a single triangle's normal on a coarse mesh.
    let seed = membrane.triangles[best_tri];
    let mut nsum = Vec3::ZERO;
    for t in &membrane.triangles {
        if !t.iter().any(|v| seed.contains(v)) {
            continue;
        }
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

    let (u, v) = orthonormal_basis(axis);
    Some(TenonFrame { anchor, axis, u, v, cut_area })
}

/// The tenon frame for a FLAT cut: the plane's own normal, anchored at the centroid
/// of the cross-section the plane carves through the body.
///
/// The contour cut derives its frame from the membrane it built; a plane cut has
/// no membrane, and the loop's waypoints only sample the surface where the user
/// happened to click — their centroid is not the middle of the cut face. The real
/// section is, so we measure it (see [`crate::membrane::plane_section`]).
pub fn frame_from_plane(
    mesh: &IndexedMesh,
    normal: Vec3,
    plane_offset: f32,
    at: TenonAnchor,
) -> Option<TenonFrame> {
    let nlen = normal.length();
    if nlen < 1e-9 {
        return None;
    }
    let axis = normal.scale(1.0 / nlen);
    let (u, v) = orthonormal_basis(axis);
    let section = crate::membrane::plane_section(mesh, axis, plane_offset / nlen, u, v)?;
    if !(section.area > 1e-9) {
        return None;
    }
    // Flatten the user's point onto the cut plane — it came from a pointer ray, so
    // it is already on it bar float error. Off the material is their business: the
    // clearance probe finds no walls and the verdict says it doesn't fit.
    let anchor = match at {
        Some(p) => p.sub(axis.scale(p.sub(section.centroid).dot(axis))),
        None => section.centroid,
    };
    Some(TenonFrame { anchor, axis, u, v, cut_area: section.area })
}


/// Area-weighted mean normal of a whole membrane — a single direction for the
/// patch, where `TenonFrame::axis` is the LOCAL normal where the tenon sits. Only
/// the tests need it now, to push a point off the cut face on purpose.
#[cfg(test)]
fn mean_membrane_normal(membrane: &Membrane) -> Vec3 {
    let mut nsum = Vec3::ZERO;
    for t in &membrane.triangles {
        let a = membrane.vertices[t[0] as usize];
        let b = membrane.vertices[t[1] as usize];
        let c = membrane.vertices[t[2] as usize];
        nsum = nsum.add(b.sub(a).cross(c.sub(a)));
    }
    let len = nsum.length();
    if len > 1e-9 { nsum.scale(1.0 / len) } else { Vec3::new(0.0, 0.0, 1.0) }
}

/// Build an orthonormal `(u, v)` pair spanning the plane perpendicular to `axis`,
/// with `u × v = axis` (the handedness the frustum's winding depends on).
///
/// This basis is NOT cosmetic. The tenon leans in the plane of one of its narrow
/// faces, and which plane that is comes from here — so a `u` that swings when
/// `axis` barely moves swings the lean with it. That is what the old rule did: it
/// seeded from whichever world axis was least aligned, which is a comparison of
/// nearly-equal magnitudes, and every time `|x|` crossed `|y|` the basis turned a
/// quarter turn. The preview and the cut measure the axis on membranes built from
/// their own copy of the seam — near-identical, not identical — so a tenon framed
/// anywhere near one of those crossings leaned one way on screen and another way
/// in the cut.
///
/// Frisvad's construction (Duff et al., "Building an Orthonormal Basis,
/// Revisited") instead varies smoothly with `axis` everywhere except across
/// `axis.z = 0`, where the sign flips. That is one circle of directions instead of
/// three great circles, and it is not where a cut face's normal usually points.
///
/// It is not a cure: a seam whose normal lies near the z = 0 equator can still
/// have its lean plane turn over. The cure is to weld `u` to something the seam
/// itself defines rather than to the world axes at all.
pub(crate) fn plane_basis(axis: Vec3) -> (Vec3, Vec3) {
    orthonormal_basis(axis)
}

fn orthonormal_basis(axis: Vec3) -> (Vec3, Vec3) {
    let len = axis.length();
    if len < 1e-9 {
        return (Vec3::new(1.0, 0.0, 0.0), Vec3::new(0.0, 1.0, 0.0));
    }
    let n = axis.scale(1.0 / len);
    let s = if n.z >= 0.0 { 1.0 } else { -1.0 };
    // `s + n.z` is never near zero: `s` carries the sign of `n.z`, so the sum is
    // between 1 and 2 in magnitude. That is the whole point of the "revisited"
    // form — the naive one divides by `1 + n.z` and blows up at the south pole.
    let a = -1.0 / (s + n.z);
    let b = n.x * n.y * a;
    let u = Vec3::new(1.0 + s * n.x * n.x * a, s * b, -s * n.x);
    let ulen = u.length();
    let u = if ulen > 1e-9 { u.scale(1.0 / ulen) } else { Vec3::new(1.0, 0.0, 0.0) };
    let v = n.cross(u);
    (u, v)
}

/// Flip a frame so its `axis` points toward `part_b` (the −normal side) instead
/// of into `part_a`, for building a tenon/mortise that protrudes from part_a's cut
/// face into part_b. Negating `axis` alone would flip the `(u, v, axis)`
/// handedness and invert the frustum winding (manifold would reject it); swapping
/// `u` and `v` restores right-handedness so the outward winding is preserved.
fn frame_extruding_toward_part_b(frame: &TenonFrame) -> TenonFrame {
    TenonFrame {
        anchor: frame.anchor,
        axis: frame.axis.scale(-1.0),
        u: frame.v,
        v: frame.u,
        cut_area: frame.cut_area,
    }
}

/// Mirror a frame so its `axis` points into part_b instead of part_a (used to
/// flip which half gets the tenon). Same construction as
/// [`frame_extruding_toward_part_b`] — negate `axis`, swap `u`/`v` to keep a
/// right-handed basis — but conceptually it re-roots the tenon on the opposite side.
fn flip_frame_sides(frame: &TenonFrame) -> TenonFrame {
    TenonFrame {
        anchor: frame.anchor,
        axis: frame.axis.scale(-1.0),
        u: frame.v,
        v: frame.u,
        cut_area: frame.cut_area,
    }
}

/// Max tilt (radians) the tenon axis may lean off the membrane normal: **45°**.
///
/// Past this the tenon skims the cut face — it stops locating the halves and starts
/// levering them apart — so the UI clamps to it and we re-clamp here as a backstop.
/// It was 60°, which in practice was a lean nobody wanted and every placement
/// struggled to hold.
pub const TENON_MAX_TILT_RAD: f32 = std::f32::consts::FRAC_PI_4;

/// User-controlled reorientation of the tenon, expressed in the cut's own tangent
/// frame so it stays attached to the seam regardless of how the model sits in world
/// space. Both pivot about the **base center** (`anchor`):
/// - `tilt`: polar angle the body leans OFF the membrane normal (0 = straight out;
///   clamped to [`TENON_MAX_TILT_RAD`]).
/// - `roll`: spin about the tenon's own axis. The lean plane is welded to one of the
///   tenon's narrow faces, so rolling turns the lean with the body — the whole point
///   versus the old azimuth, which was a second number for the same freedom as the
///   roll and drifted out of step with it.
#[derive(Debug, Clone, Copy, Default)]
pub struct TenonTilt {
    /// Lean about the build frame's `+y` (the single lean axis).
    pub tilt: f32,
    pub roll: f32,
}

impl TenonTilt {
    pub fn new(tilt: f32, roll: f32) -> Self {
        TenonTilt { tilt, roll }
    }
}

/// Where the tenon sits ON the cut face, as millimetres along the frame's own `u`
/// and `v` axes from the natural anchor (the centroid of the cut).
///
/// Where the tenon sits on the cut face: a point in MODEL-LOCAL space, or `None`
/// for the natural middle of the cut.
///
/// The centroid is a fine default and a poor rule — on a bean-shaped section it can
/// sit in the thinnest part, or in air — so the user drags the tenon to where there
/// is material. What they drag it to is a place, and a place is a point: the same
/// three numbers mean the same thing to the pointer, the preview and the cut, with
/// nothing to convert and nothing to disagree about.
pub type TenonAnchor = Option<Vec3>;


/// Reorientation applied at BUILD time, in the tenon's local `(u, v, axis)` space
/// (origin at `anchor`, `+z` along the build axis toward the tip): a **pure rigid
/// rotation** of the whole tenon about the base center — nothing else.
///
/// It used to sink the leaned tenon deeper so its whole tilted base stayed buried,
/// and lengthen the trunk so the tip still stood `depth` proud of the cut face.
/// Between them the tenon was a different SIZE at every angle, which is not what a
/// tenon is: it is a solid, and leaning a solid does not change it. The cap simply
/// ends up `depth·cos(lean)` above the cut face, because that is where a rigid body
/// of length `depth` leaning by that much puts it. The base half that rotates up out
/// of part_a is the half that enters the mortise, which carries the same rotation.
///
/// Because the transform is a single rigid rotation (+ uniform translation) applied
/// IDENTICALLY to the tenon and the mortise, containment is preserved: the mortise is
/// the tenon dilated by the tolerance, and `R(mortise) ⊇ R(tenon)` — so the leaned tenon
/// always fits its leaned mortise (a clean slide fit at any tilt). The tenon keeps its
/// exact shape (no shear/stretch).
///
/// `R = R_roll · R_lean`: lean about local `+y` (in the tenon's own frame, welding the
/// lean plane to the body), then roll about local `+z`. Identity (`tilt == 0 &&
/// roll == 0`) leaves geometry untouched (the exact original tenon).
#[derive(Debug, Clone, Copy)]
struct LeanXform {
    tilt: f32,
    roll: f32,
    /// Extra length (mm) added to the BASE END only, so a leaned base stays buried.
    ///
    /// Rotating the body lifts its leading base corner by half_diag·sin(lean), which
    /// on a short tenon is far more than the 0.3mm of overlap it is built with — so
    /// the base edge surfaced through the cut face and sat there in plain view. The
    /// trunk grows DOWNWARD by that much: the tenon still ends up longer than it was
    /// drawn, but only into the material it is rooted in, and the cap stays exactly
    /// at depth·cos(lean). (Growing the whole body, which is what the old
    /// `stretch_depth` did, moved the cap and changed the tenon the user asked for.)
    base_sink: f32,
    identity: bool,
}

impl LeanXform {
    const IDENTITY: LeanXform =
        LeanXform { tilt: 0.0, roll: 0.0, base_sink: 0.0, identity: true };

    /// Build the transform for a tenon built in `build_frame`, given the user tilt
    /// and the tenon footprint `half_diag` (mm, the base half-diagonal — how far the
    /// base extends from the axis).
    fn for_build(tilt: &TenonTilt, max_tilt: f32, half_diag: f32) -> LeanXform {
        let leaning = tilt.tilt.abs() >= 1e-6;
        let rolling = tilt.roll.abs() >= 1e-6;
        if !leaning && !rolling {
            return LeanXform::IDENTITY;
        }
        // Clamp to the hard ceiling. Whether the lean still FITS is `check_lean`'s
        // verdict, reported to the user — not something enforced by refusing to turn.
        let cap = max_tilt.clamp(0.0, TENON_MAX_TILT_RAD);
        let t = if tilt.tilt.abs() >= 1e-6 { tilt.tilt.clamp(-cap, cap) } else { 0.0 };
        // How far the leading base corner rises when the body turns — see `base_sink`.
        let base_sink = half_diag.max(0.0) * t.sin();
        LeanXform { tilt: t, roll: tilt.roll, base_sink, identity: false }
    }

    /// The burial that keeps the base under the cut face at ANY lean up to the
    /// ceiling — `base_sink` for the worst case rather than for a given angle.
    ///
    /// For the live preview, which is built once and then rotated by the gizmo
    /// without a rebuild: it cannot lengthen itself as the lean grows, so it starts
    /// out long enough for wherever the lean ends up.
    fn burial_for_steepest_lean(half_diag: f32) -> f32 {
        half_diag.max(0.0) * TENON_MAX_TILT_RAD.sin()
    }


    /// Transform a local point: rigid lean about the body's own **+y**, then roll
    /// about **+z**. Identical for tenon and mortise, so it preserves their nesting
    /// (a clean slide fit at any angle).
    ///
    /// The order is the whole trick. Leaning FIRST, in the tenon's own frame, welds
    /// the lean plane to the body: the roll then turns the two together because it
    /// turns everything. (The old azimuth failed because it named the lean direction
    /// in world terms and kept it in sync with the roll by hand — two numbers
    /// describing one freedom can always disagree. One welded lean cannot.)
    #[inline]
    fn apply(&self, x: f32, y: f32, z: f32) -> (f32, f32, f32) {
        if self.identity {
            return (x, y, z);
        }
        // 1) Lean about local +y: (x, z) turn, y is the hinge. +y is the build
        // frame's length axis, so the tenon tips over one of its NARROW faces.
        let (mut px, mut pz) = (x, z);
        if self.tilt.abs() >= 1e-9 {
            let (s, c) = self.tilt.sin_cos();
            let rx = px * c + pz * s;
            let rz = -px * s + pz * c;
            px = rx;
            pz = rz;
        }
        // 2) Roll about local +z, carrying the leaned body and its lean plane alike.
        let mut py = y;
        if self.roll.abs() >= 1e-9 {
            let (s, c) = self.roll.sin_cos();
            let rx = px * c - py * s;
            let ry = px * s + py * c;
            px = rx;
            py = ry;
        }
        (px, py, pz)
    }
}

/// Build a tapered rectangular frustum (truncated box) in the given frame.
///
/// The base rectangle (`width`×`length`) sits at `anchor` in the `u`/`v` plane;
/// the top is `TENON_TOP_SCALE`× the base, offset `depth` along `axis`. `grow` >0
/// dilates the solid by that amount on every face (the mortise = tenon with
/// `grow = tolerance`): base/top rings enlarge by `grow`, the tip extends `grow`
/// past `depth`, and the mouth is pulled `grow` back behind the base plane so the
/// mortise fully clears the tenon as it enters.
///
/// The base/mouth ALSO extends `TENON_BASE_OVERLAP_MM` *past* the cut plane into the
/// other half, so the tenon's base overlaps part_a's material (a clean boolean union
/// instead of a fragile coplanar butt-joint) and the mortise's mouth fully breaches
/// part_b's cut face.
///
/// Output is watertight with outward winding (same convention as
/// [`axis_aligned_slab`]) so `to_manifold` accepts it.
///
/// `fillet` (mm) rounds the tenon: the cross-section becomes a rounded-rectangle
/// (the 4 vertical corners are quarter-circle arcs of radius `fillet`) and the TIP
/// is rounded over (a quarter-round from the side wall up to the tip). `fillet = 0`
/// gives the original sharp tapered box. The fillet is clamped so it can't exceed
/// the smaller half-extent (which would invert the corner).
pub fn build_frustum(frame: &TenonFrame, dims: FrustumDims, grow: f32, fillet: f32) -> IndexedMesh {
    build_frustum_leaned(frame, dims, grow, fillet, LeanXform::IDENTITY)
}

/// [`build_frustum`] with an explicit [`LeanXform`] for a rotated tenon. The body is
/// rigid-rotated; a thin collar at the base blends to the flat glued footprint.
fn build_frustum_leaned(
    frame: &TenonFrame,
    dims: FrustumDims,
    grow: f32,
    fillet: f32,
    lean: LeanXform,
) -> IndexedMesh {
    let g = grow.max(0.0);
    // Half-extents at base and top, dilated by `grow`.
    let bw = dims.width * 0.5 + g; // base half-width
    let bl = dims.length * 0.5 + g; // base half-length
    let tw = dims.width * TENON_TOP_SCALE * 0.5 + g; // top half-width
    let tl = dims.length * TENON_TOP_SCALE * 0.5 + g; // top half-length
    // Base/mouth: behind the cut plane by `grow` (mortise clearance) PLUS the fixed
    // overlap that pushes the base into the other half for a solid boolean.
    // Base/mouth: behind the cut plane by `grow` (mortise clearance) PLUS the fixed
    // overlap that pushes the base into the other half for a solid boolean, PLUS
    // whatever the lean needs to keep the turned base buried (`base_sink`).
    let z0_taper = -g - TENON_BASE_OVERLAP_MM;
    let z0 = z0_taper - lean.base_sink;
    let z1 = dims.depth + g; // tip: past nominal depth by `grow`
    let height = (z1 - z0).max(1e-4);

    // Extending the base must not change the tenon's SHAPE, only its length. Sizing
    // the base ring at the new, deeper plane and lofting straight to the top would
    // spread the same taper over a longer run — so the section at the cut face came
    // out narrower the further it leaned, and the tenon visibly shrank on release.
    // Prolong the cone instead: widen the base ring by exactly what the existing
    // slope gives over the extra length, and every section from `z0_taper` up —
    // the one at the cut face above all — is the one it always was.
    let (bw, bl) = if lean.base_sink > 0.0 {
        let k = (z1 - z0) / (z1 - z0_taper).max(1e-4);
        (tw + (bw - tw) * k, tl + (bl - tl) * k)
    } else {
        (bw, bl)
    };

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
    let push_ring = |pts: Vec<Vec3>, positions: &mut Vec<Vec3>, starts: &mut Vec<u32>| {
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
    frame: &TenonFrame,
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

    // The 8-vertex tapered box. `local()` applies the rigid lean rotation, so
    // a leaned box is just this box rigidly rotated — still 8 verts / 12 tris, still
    // watertight, and the mortise (same rotation, dilated) provably contains the tenon.
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

/// The decided tenon for a cut: the solid to build — ALWAYS the shape and size the
/// user asked for — and whether it actually fits where they put it. Computed by
/// [`decide_tenon`] from the frame + measured clearance, and SHARED by the real cut
/// ([`apply_tenon`]) and the live preview ([`build_tenon_preview_soup`]) so the
/// preview shows exactly the tenon that will be cut.
///
/// The plan does not resize anything and never substitutes one shape for another.
/// A tenon that doesn't fit is still built, at the requested size, so the preview
/// can draw it in the "won't fit" colour where the user put it — with the reason —
/// and they can move it or shrink it themselves. Deciding *for* them (shrinking to
/// the biggest thing that fits, or swapping the frustum for a half-sphere) meant a
/// 3 mm tenon silently became a 1.5 mm one, and the number in the panel stopped
/// describing the thing on screen.
#[derive(Debug, Clone)]
pub struct TenonPlan {
    /// The solid to build, at the size the user asked for.
    pub body: TenonBody,
    pub verdict: TenonVerdict,
}

/// The shape to build, at the requested size.
#[derive(Debug, Clone, Copy)]
pub enum TenonBody {
    Frustum(FrustumDims),
    Dome(DomeDims),
}

/// Whether the tenon fits where the user put it. No middle rungs: a tenon either
/// goes in as asked, or it doesn't go in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TenonVerdict {
    Fits,
    DoesNotFit(TenonProblem),
}

/// Why a tenon can't go where the user put it. Carries the measurements so the
/// message can name them, instead of saying "the part is too thin" to everything.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TenonProblem {
    /// Too little material behind the cut face to sink the tenon into.
    TooShallow { room_mm: f32, needed_mm: f32 },
    /// The side walls are closer together than the tenon's footprint.
    TooNarrow { room_mm: f32, needed_mm: f32 },
    /// The cut face itself is unusable (no area, or normals that cancel), so there
    /// is nowhere to root a tenon and no frame to aim one with.
    DegenerateFace,
    /// Leaned so far that the tenon comes out through the skin.
    EscapesTheBody,
}

impl TenonProblem {
    /// The sentence shown to the user. Says which way it doesn't fit and by how
    /// much — "too thin" alone sent people looking at the wrong dimension.
    pub fn message(&self) -> String {
        match *self {
            TenonProblem::TooShallow { room_mm, needed_mm } => format!(
                "This tenon doesn't fit here — only {room_mm:.2} mm of material behind the cut face, and it needs {needed_mm:.2} mm. Shorten it or move it somewhere thicker.",
            ),
            TenonProblem::TooNarrow { room_mm, needed_mm } => format!(
                "This tenon doesn't fit here — the walls leave {room_mm:.2} mm across, and its base needs {needed_mm:.2} mm. Narrow it or move it away from the edge.",
            ),
            TenonProblem::DegenerateFace => {
                "No tenon — this cut leaves no usable face to root one on.".to_string()
            }
            TenonProblem::EscapesTheBody => {
                "This tenon doesn't fit here — leaned this far it comes out through the surface. Stand it up more, or move it into thicker material.".to_string()
            }
        }
    }
}

impl TenonPlan {
    /// The shape being built. Note this is what is DRAWN, not proof anything was
    /// cut: check [`TenonPlan::fits`] for that.
    pub fn kind(&self) -> TenonKind {
        match self.body {
            TenonBody::Frustum(_) => TenonKind::Frustum,
            TenonBody::Dome(_) => TenonKind::Dome,
        }
    }
    pub fn fits(&self) -> bool {
        self.verdict == TenonVerdict::Fits
    }
    /// The reason it doesn't fit; empty when it does.
    pub fn detail(&self) -> String {
        match self.verdict {
            TenonVerdict::Fits => String::new(),
            TenonVerdict::DoesNotFit(problem) => problem.message(),
        }
    }
    /// The depth the body stands, whichever shape it is.
    fn depth(&self) -> f32 {
        match self.body {
            TenonBody::Frustum(d) => d.depth,
            TenonBody::Dome(d) => d.depth,
        }
    }
    /// Base half-diagonal (how far the footprint reaches from the axis), plus the
    /// mortise's tolerance — how far the leaned body swings off the axis.
    fn half_diag(&self, tolerance: f32) -> f32 {
        match self.body {
            TenonBody::Frustum(d) => 0.5 * d.width.hypot(d.length) + tolerance,
            TenonBody::Dome(d) => d.half_w.max(d.half_l) + tolerance,
        }
    }
}

/// Decide the tenon: build what was asked for, and say whether it fits.
///
/// This used to be a **fit ladder** that shrank the frustum to whatever the walls
/// allowed, then swapped it for a half-sphere, then gave up. All three rungs are
/// gone. The user picks the shape and the size; this only measures. The dome is
/// still a shape they can choose — it is no longer something we choose for them.
///
/// Clearance is measured against the **mortise** (the larger of tenon/mortise) so both
/// halves keep ≥`TENON_WALL_MARGIN_MM` of material.
fn decide_tenon(
    clearance: &Clearance,
    nominal: FrustumDims,
    nominal_dome: DomeDims,
    shape: TenonShape,
    tolerance: f32,
    tilt: f32,
) -> TenonPlan {
    let (body, fit) = if shape == TenonShape::Frustum {
        (
            TenonBody::Frustum(nominal),
            clearance.check_frustum(nominal, tolerance),
        )
    } else {
        (
            TenonBody::Dome(nominal_dome),
            clearance.check_dome(nominal_dome, tolerance),
        )
    };
    // Standing straight is only half the question: a tenon that fits upright can
    // still swing out through a wall once it leans.
    let plan = TenonPlan { body, verdict: TenonVerdict::Fits };
    let fit = fit.and_then(|()| {
        check_lean(clearance, plan.half_diag(tolerance), plan.depth(), tilt)
    });
    let verdict = match fit {
        Ok(()) => TenonVerdict::Fits,
        Err(problem) => TenonVerdict::DoesNotFit(problem),
    };
    TenonPlan { verdict, ..plan }
}

/// Does this placement survive being LEANED by `tilt`?
///
/// This used to be `max_tilt_for`, which walked the angle up against the material
/// and handed back a cap the gizmo then clamped to. On a tenon near an edge the cap
/// came out 0, so the lean ring turned and nothing moved — the tool silently
/// refusing instead of saying no. Fit is a verdict now, not a limit: lean it as far
/// as you like (up to [`TENON_MAX_TILT_RAD`]) and this reports whether the leaned
/// tenon still has material around it.
///
/// A lean costs room three ways: the trunk swings SIDEWAYS toward a lateral wall,
/// its base dips BACKWARDS into the tenon's own half as it rotates. The body is
/// rigid, so both are measured on the tenon the user asked for.
fn check_lean(
    clearance: &Clearance,
    half_diag: f32,
    depth: f32,
    tilt: f32,
) -> Result<(), TenonProblem> {
    let t = tilt.abs().min(TENON_MAX_TILT_RAD);
    if t < 1e-6 {
        return Ok(());
    }
    let m = TENON_WALL_MARGIN_MM;
    // The base corner that rotates DOWN into part_a, and the rigid trunk.
    let dip = half_diag * t.sin();
    // Sideways: the leaned tip, plus the base still standing half a diagonal off
    // the axis. Measured against the TIGHTEST of the four probes rather than the
    // room in the lean's own direction — the roll ring aims the lean, and a verdict
    // that flickered as the user turned it would be worse than a conservative one.
    let reach = depth * t.sin() + half_diag * t.cos();
    let room_lat = clearance.half_room_u().min(clearance.half_room_v());
    if reach + m > room_lat {
        return Err(TenonProblem::TooNarrow {
            room_mm: room_lat * 2.0,
            needed_mm: (reach + m) * 2.0,
        });
    }
    // Backwards: the dipping base corner has to stay inside the material behind the
    // base, or the tenon's own half opens up around its root.
    let needed_back = dip + TENON_BASE_OVERLAP_MM + m;
    if needed_back > clearance.depth_a {
        return Err(TenonProblem::TooShallow {
            room_mm: clearance.depth_a,
            needed_mm: needed_back,
        });
    }
    Ok(())
}

/// Place a tenon across the cut, honoring the fit ladder via [`decide_tenon`]. The
/// chosen rung + reason ride back on the [`TenonOutcome`] so the report and the user
/// alert agree with the preview.
///
/// A degenerate frame, or any boolean failure, yields the parts UNCHANGED with
/// `TenonKind::None` + a reason — a failed tenon must NEVER destroy the cut result.
#[allow(clippy::too_many_arguments)]
pub fn apply_tenon(
    model: &IndexedMesh,
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    membrane: &Membrane,
    shape: TenonShape,
    swap_sides: bool,
    tilt: TenonTilt,
    width_mm: f32,
    depth_mm: f32,
    fillet_mm: f32,
    tolerance: f32,
    at: TenonAnchor,
) -> TenonOutcome {
    let frame0 = match frame_from_membrane_at(membrane, at) {
        Some(f) => f,
        None => {
            return TenonOutcome {
                part_a,
                part_b,
                kind: TenonKind::None,
                detail: "tenon skipped: degenerate cut frame (no area / cancelling normals)"
                    .to_string(),
            };
        }
    };
    apply_tenon_at_frame(
        model, part_a, part_b, frame0, shape, swap_sides, tilt, width_mm, depth_mm, fillet_mm,
        tolerance,
    )
}

/// [`apply_tenon`] with the placement frame supplied directly, for cuts that have no
/// membrane to derive it from — the flat plane cut, which frames the tenon on the
/// plane itself (see [`frame_from_plane`]).
#[allow(clippy::too_many_arguments)]
pub fn apply_tenon_at_frame(
    model: &IndexedMesh,
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    frame0: TenonFrame,
    shape: TenonShape,
    swap_sides: bool,
    tilt: TenonTilt,
    width_mm: f32,
    depth_mm: f32,
    fillet_mm: f32,
    tolerance: f32,
) -> TenonOutcome {
    let tolerance = sanitize_tolerance(tolerance);
    // Half the cutter thickness — how far each half's cut face sits from the
    // membrane the tenon is framed on. See `sink_frame_into_part_a`.

    // Flip which half gets the tenon vs the mortise. By default the tenon roots in
    // part_a (the membrane's +normal side) and protrudes into part_b's mortise. To
    // swap, mirror the placement frame (negate the axis, keeping a right-handed
    // basis by swapping u/v) AND swap the two part roles — then the SAME downstream
    // logic (tenon onto the first arg, mortise from the second) puts the tenon on part_b
    // and the mortise on part_a. Geometry is otherwise identical, so the fit ladder
    // and clearance below are unchanged.
    let (frame, part_a, part_b) = if swap_sides {
        (flip_frame_sides(&frame0), part_b, part_a)
    } else {
        (frame0, part_a, part_b)
    };
    // The lean+roll are applied at BUILD time as a rigid body rotation about the
    // base, NOT folded into the frame — so the frame stays the natural tangent frame
    // for clearance probing.

    // Local thickness is measured against the ORIGINAL un-cut model, NOT the split
    // parts: the parts each have a cut FACE right at the anchor, so a probe ray
    // from there hits that face ~half a kerf away (≈0.05 mm) instead of the real
    // far wall — making every part look paper-thin. The un-cut body has solid
    // material through the anchor, so the rays travel to the true outer walls.
    // (This matches the preview, which probes the model and sizes correctly.)
    let clearance = Clearance::probe(&frame, model, model);
    let nominal = FrustumDims::from_width_depth(width_mm, depth_mm);
    let nominal_dome = DomeDims::from_width_depth(width_mm, depth_mm);
    let plan = decide_tenon(&clearance, nominal, nominal_dome, shape, tolerance, tilt.tilt.abs());
    // The same containment check the preview runs, on the same frame, so what the
    // user saw refused in red is what the cut refuses.
    let plan = {
        let build_frame =
            frame_extruding_toward_part_b(&frame);
        let lean = LeanXform::for_build(&tilt, TENON_MAX_TILT_RAD, plan.half_diag(tolerance));
        confirm_tenon_stays_inside(plan, model, &build_frame, lean)
    };
    // How far this placement can lean before the tenon leaves the material. The cut
    // must agree with the preview, which caps the gizmo the same way.
    // The lean is no longer capped by the room around the tenon — leaning it too
    // far is a thing the fit VERDICT reports (see `check_lean`), not a thing the
    // gizmo silently refuses to do. Only the hard ceiling remains.
    let max_tilt = TENON_MAX_TILT_RAD;

    // The TenonOutcome from apply_frustum/apply_dome holds (tenon-half, mortise-half) in
    // (part_a, part_b). When we swapped roles above, swap them back so the returned
    // part_a/part_b match the caller's original orientation.
    let unswap = |mut out: TenonOutcome| -> TenonOutcome {
        if swap_sides {
            std::mem::swap(&mut out.part_a, &mut out.part_b);
        }
        out
    };

    // A tenon that doesn't fit never reaches the booleans. It is not shrunk to
    // something that would, and not quietly dropped either: the parts come back
    // untouched with the reason, and the caller refuses the cut. The preview drew
    // it in red at this exact size, so the user already knows which one and why.
    if let TenonVerdict::DoesNotFit(problem) = plan.verdict {
        // Still in swapped roles if we swapped above; put them back for the caller.
        let (pa, pb) = if swap_sides { (part_b, part_a) } else { (part_a, part_b) };
        return TenonOutcome {
            part_a: pa,
            part_b: pb,
            kind: TenonKind::None,
            detail: problem.message(),
        };
    }

    match plan.body {
        TenonBody::Frustum(dims) => {
            let out = unswap(apply_frustum(part_a, part_b, &frame, tilt, dims, fillet_mm, tolerance, max_tilt));
            if out.kind == TenonKind::Frustum {
                out
            } else {
                // Boolean failed despite fitting — report as no tenon, parts intact.
                TenonOutcome {
                    kind: TenonKind::None,
                    detail: format!("No tenon placed — frustum boolean failed: {}", out.detail),
                    ..out
                }
            }
        }
        TenonBody::Dome(dims) => {
            let out = unswap(apply_dome(part_a, part_b, &frame, tilt, dims, tolerance, max_tilt));
            if out.kind == TenonKind::Dome {
                out
            } else {
                TenonOutcome {
                    kind: TenonKind::None,
                    detail: format!("No tenon placed — dome boolean failed: {}", out.detail),
                    ..out
                }
            }
        }
    }
}

/// Build the registration tenon the cut WOULD place, as a flat triangle soup (9 f32
/// per triangle, model-local) for the live preview — tenon AND mortise together, of
/// the chosen rung (frustum or dome). Mirrors the truthful cutter preview: it
/// builds the membrane the same way the cut does, derives the same frame, probes
/// clearance against the model, and runs the SAME [`decide_tenon`] ladder — so the
/// preview is exactly what cuts.
///
/// Returns `(soup, kind, detail)`. On no tenon (too thin / degenerate), the soup is
/// empty and `detail` explains why (for the alert). `None` only if the membrane
/// itself can't be built from the loop.
#[allow(clippy::too_many_arguments)]
pub fn build_tenon_preview_soup(
    model: &IndexedMesh,
    loop_pts: &[Vec3],
    membrane_smoothing: f32,
    density: f32,
    shape: TenonShape,
    swap_sides: bool,
    tilt: TenonTilt,
    width_mm: f32,
    depth_mm: f32,
    fillet_mm: f32,
    tolerance: f32,
    at: TenonAnchor,
) -> Option<TenonPreview> {
    use crate::membrane::{build_membrane_full, CONTOUR_SUBDIVISIONS, DEFAULT_GRID_DIVISIONS};

    let grid = DEFAULT_GRID_DIVISIONS * (density.clamp(1.0, 4.0) as f64);
    let membrane =
        build_membrane_full(loop_pts, CONTOUR_SUBDIVISIONS, membrane_smoothing, grid)?;
    let frame = match frame_from_membrane_at(&membrane, at) {
        Some(f) => f,
        None => {
            return Some(TenonPreview {
                soup: Vec::new(),
                tenon_triangles: 0,
                kind: TenonKind::None,
                fits: false,
                detail: TenonProblem::DegenerateFace.message(),
                frame: None,
            })
        }
    };
    Some(build_tenon_preview_at_frame(
        model, frame, shape, swap_sides, tilt, width_mm, depth_mm, fillet_mm, tolerance,
    ))
}

/// [`build_tenon_preview_soup`] with the frame supplied, for the flat plane cut —
/// which frames its tenon on the plane instead of on a membrane. Same ladder, same
/// build, so the plane preview is as truthful as the contour one.
#[allow(clippy::too_many_arguments)]
pub fn build_tenon_preview_at_frame(
    model: &IndexedMesh,
    frame: TenonFrame,
    shape: TenonShape,
    swap_sides: bool,
    tilt: TenonTilt,
    width_mm: f32,
    depth_mm: f32,
    fillet_mm: f32,
    tolerance: f32,
) -> TenonPreview {
    let tolerance = sanitize_tolerance(tolerance);

    // At preview time the body isn't split yet; probe clearance against the whole
    // model on both sides (its walls are the same walls the halves will have).
    // Probe the natural (swapped) frame — the lean/roll are applied at build time as
    // a rigid rotation, not folded into the probe frame (matches `apply_tenon`).
    let placed = if swap_sides { flip_frame_sides(&frame) } else { frame };
    let clearance = Clearance::probe(&placed, model, model);
    let nominal = FrustumDims::from_width_depth(width_mm, depth_mm);
    let nominal_dome = DomeDims::from_width_depth(width_mm, depth_mm);
    let plan = decide_tenon(&clearance, nominal, nominal_dome, shape, tolerance, tilt.tilt.abs());
    // The build frame must MATCH what `apply_tenon` uses so the preview is exactly
    // what cuts: extrude the tenon toward part_b, with the rigid lean about the base.
    let build_frame = frame_extruding_toward_part_b(&placed);
    // Sink uses the base half-diagonal so the tilted base stays buried (matches
    // apply_frustum/apply_dome; the mortise footprint is a hair larger).
    let half_diag = plan.half_diag(tolerance);
    // The lean is no longer capped by the room around the tenon — leaning it too
    // far is a thing the fit VERDICT reports (see `check_lean`), not a thing the
    // gizmo silently refuses to do. Only the hard ceiling remains.
    let max_tilt = TENON_MAX_TILT_RAD;
    let lean = LeanXform::for_build(&tilt, max_tilt, half_diag);
    // Where the leaned tenon ACTUALLY ended up — the probes only ever measured
    // where it started. See `confirm_tenon_stays_inside`.
    let plan = confirm_tenon_stays_inside(plan, model, &build_frame, lean);
    // The SOUP is built straight — the frontend applies the lean itself, live, so the
    // gizmo stays smooth without a round-trip per frame. It carries a base extension
    // though (see `LeanXform::base_sink`), because that is a change of LENGTH and a
    // client-side rotation cannot produce it.
    //
    // The extension is sized for the STEEPEST lean the gizmo can reach, not for the
    // lean this soup was built at: the soup has to survive being rotated to any
    // angle without a rebuild, and one built at 0 has no burial at all, so the base
    // edge rose through the cut face and sat there in plain view the moment the
    // gizmo was touched. A soup built at the ceiling never shows it, which is what
    // the maintainer asked every tenon to look like.
    //
    // It is the one place the preview outreaches the cut: `apply_tenon` buries the
    // base by what its own lean needs. The difference is entirely BELOW the cut
    // face, inside the half the tenon is welded to, so nothing visible parts ways —
    // barring a rooted half thinner than the surplus, where the preview's base
    // reaches out through the back and the cut's does not.
    let soup_lean = LeanXform {
        tilt: 0.0,
        roll: 0.0,
        base_sink: LeanXform::burial_for_steepest_lean(half_diag),
        identity: false,
    };

    let mut soup: Vec<f32> = Vec::new();
    // Triangles [0, tenon_triangles) are the tenon, the rest the mortise. The frontend
    // colours the two apart, which is the only way the Fit Tolerance knob is
    // visible: it grows the mortise and leaves the tenon exactly where it was.
    let tenon_triangles;
    // The body is built WHETHER OR NOT it fits. A tenon that can't be placed is
    // still drawn, at the size the user asked for, so the scene can colour it as
    // "won't fit" where they put it — erasing it took the aim gizmo with it and
    // left them nothing to drag somewhere it would work.
    let kind = match plan.body {
        TenonBody::Frustum(dims) => {
            // tenon + mortise — matching apply_frustum so the preview is exactly what
            // cuts (rigid lean applied identically, mortise fillet = tenon fillet + tol).
            append_soup(&mut soup, &build_frustum_leaned(&build_frame, dims, 0.0, fillet_mm, soup_lean));
            tenon_triangles = soup.len() / 9;
            append_soup(&mut soup, &build_frustum_leaned(&build_frame, dims, tolerance, fillet_mm + tolerance, soup_lean));
            TenonKind::Frustum
        }
        TenonBody::Dome(dims) => {
            append_soup(&mut soup, &build_dome_leaned(&build_frame, dims.half_w, dims.half_l, dims.depth, 0.0, DOME_SEGMENTS, soup_lean));
            tenon_triangles = soup.len() / 9;
            append_soup(&mut soup, &build_dome_leaned(&build_frame, dims.half_w, dims.half_l, dims.depth, tolerance, DOME_SEGMENTS, soup_lean));
            TenonKind::Dome
        }
    };
    let (fits, detail) = (plan.fits(), plan.detail());
    // Report the placement frame for the gizmo. We hand back the NATURAL tangent
    // basis (the swapped `placed`): anchor = base center, axis = the +normal the tenon
    // roots against (toward the tenon's half), and u/v the in-plane basis. The frontend
    // mounts the rotation gizmo at the anchor oriented to this frame, and converts
    // gizmo rotations into tilt/azimuth/roll. `tip` is the leaned apex (model-local).
    let info = build_tenon_frame_info(&placed, &build_frame, &plan, lean, max_tilt, half_diag);
    TenonPreview { soup, tenon_triangles, kind, fits, detail, frame: info }
}

/// What the live preview hands the frontend: the tenon the cut WOULD place, as one
/// flat triangle soup with the boundary between its two halves marked.
#[derive(Debug, Clone)]
pub struct TenonPreview {
    /// Tenon triangles first, then the mortise's (9 f32 per triangle, model-local).
    pub soup: Vec<f32>,
    /// How many of `soup`'s triangles belong to the TENON.
    pub tenon_triangles: usize,
    /// Which shape is DRAWN (frustum / dome). Says nothing about whether it fits —
    /// see `fits`, which is what decides the colour and whether the cut is allowed.
    pub kind: TenonKind,
    /// Whether this tenon can actually be placed where the user put it. `false`
    /// means "draw it in the won't-fit colour and refuse the cut", NOT "no tenon":
    /// the soup is still a full tenon and mortise at the requested size.
    pub fits: bool,
    /// Why it doesn't fit, for the panel's alert. Empty when it does.
    pub detail: String,
    /// Placement frame for the aim gizmo. `None` when no tenon was placed.
    pub frame: Option<TenonFrameInfo>,
}

/// Placement-frame info handed to the frontend so the aim/roll gizmo sits exactly
/// on the previewed tenon. All in model-local coords (the same space as the soup).
#[derive(Debug, Clone, Copy)]
pub struct TenonFrameInfo {
    /// Base center (pivot for tilt/roll).
    pub anchor: Vec3,
    /// The +normal the tenon roots against (un-tilted; the tilt-0 axis direction).
    pub axis: Vec3,
    /// In-plane basis (width / length directions), already rolled-out to the
    /// un-rolled natural basis so the frontend computes azimuth in a stable frame.
    pub u: Vec3,
    pub v: Vec3,
    /// The leaned TIP point (apex of the tenon) in model-local coords — where the
    /// aim handle is drawn. Reflects the current tilt/azimuth/roll rigid rotation.
    pub tip: Vec3,
    /// Tenon height (depth along the build axis to the tip), for handle scaling.
    pub depth: f32,
    /// The hard ceiling on the lean (radians). It is a CONSTANT: how far a tenon may
    /// lean before it leaves the material is reported as a won't-fit verdict, not
    /// enforced by freezing the ring — which, on a tenon near an edge, meant the
    /// ring turned and nothing happened.
    pub max_tilt: f32,
    /// Base half-diagonal (mm, mortise footprint). The frontend leans the tenon
    /// client-side on a soup built straight, so it needs the same number Rust used
    /// to sink and lengthen it — otherwise the preview and the cut disagree the
    /// moment the user touches the lean ring.
    pub half_diag: f32,
}

/// Compute the [`TenonFrameInfo`] for a decided plan: the tip is the apex of the tenon
/// after the rigid lean rotation, in model-local coords.
fn build_tenon_frame_info(
    natural: &TenonFrame,
    build_frame: &TenonFrame,
    plan: &TenonPlan,
    lean: LeanXform,
    max_tilt: f32,
    half_diag: f32,
) -> Option<TenonFrameInfo> {
    // The frame is reported even for a tenon that doesn't fit — that is exactly
    // when the user needs the gizmo, to drag it somewhere it does.
    let depth = plan.depth();
    // The tip sits at local (0, 0, depth) in the build frame, transformed by the lean
    // (it's above the collar, so this is the full rigid rotation — the tip leans in
    // both lateral AND axial directions).
    let (tx, ty, tz) = lean.apply(0.0, 0.0, depth);
    let tip = build_frame
        .anchor
        .add(build_frame.u.scale(tx))
        .add(build_frame.v.scale(ty))
        .add(build_frame.axis.scale(tz));
    Some(TenonFrameInfo {
        anchor: natural.anchor,
        axis: natural.axis,
        u: natural.u,
        v: natural.v,
        tip,
        depth,
        max_tilt,
        half_diag,
    })
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

/// Union the nominal frustum tenon onto `part_a` and difference the grown mortise
/// from `part_b`. On any boolean failure, returns the parts UNCHANGED with a
/// `None` kind + reason — a failed tenon must never destroy the cut result.
///
/// EXTRUSION DIRECTION: `frame.axis` points into `part_a` (the +normal side). The
/// tenon must protrude FROM part_a's cut face INTO part_b's region so it fills the
/// mortise on reassembly — i.e. it extrudes along `−axis` (toward part_b). We build
/// in a flipped frame (`axis` negated) whose wide base sits on the cut plane and
/// whose body+tip extend toward part_b. The union with part_a bonds along the cut
/// face; the difference carves the matching cavity from part_b in the same place.
#[allow(clippy::too_many_arguments)]
fn apply_frustum(
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    frame: &TenonFrame,
    tilt: TenonTilt,
    dims: FrustumDims,
    fillet: f32,
    tolerance: f32,
    max_tilt: f32,
) -> TenonOutcome {
    // Base sunk half a kerf into part_a's material (`dims` already carries the
    // matching extra length — see `grow_plan_for_kerf`).
    let build_frame = frame_extruding_toward_part_b(frame);
    // Rigid lean rotation about the base (identity when tilt == 0 && roll == 0): the
    // body keeps its shape, a thin collar at the base stays glued flat on the cut
    // face. Tenon and mortise share the SAME lean so the mortise follows the tenon exactly.
    // The lean's sink depends on the base half-diagonal so the tilted base stays
    // buried. Use the MORTISE's footprint (slightly larger) so both share one sink.
    let half_diag = 0.5 * ((dims.width).hypot(dims.length)) + tolerance;
    let lean = LeanXform::for_build(&tilt, max_tilt, half_diag);
    let tenon_mesh = build_frustum_leaned(&build_frame, dims, 0.0, fillet, lean);
    // The mortise is the tenon offset outward by `tolerance`; a uniform offset of a
    // rounded-rect grows the corner radius by the same amount, so the mortise's fillet
    // is tenon fillet + tolerance. The lean is a rigid rotation applied identically to
    // both, so the dilated mortise provably contains the leaned tenon.
    let mortise_mesh = build_frustum_leaned(&build_frame, dims, tolerance, fillet + tolerance, lean);

    let result = (|| -> Result<(IndexedMesh, IndexedMesh), String> {
        let a = to_manifold(&part_a).map_err(|e| format!("part_a invalid: {e}"))?;
        let b = to_manifold(&part_b).map_err(|e| format!("part_b invalid: {e}"))?;
        let tenon = to_manifold(&tenon_mesh).map_err(|e| format!("tenon invalid: {e}"))?;
        let mortise = to_manifold(&mortise_mesh).map_err(|e| format!("mortise invalid: {e}"))?;

        let a_tenoned = a.union(&tenon);
        let b_tenoned = b.difference(&mortise);

        let a_out = crate::membrane::manifold_to_indexed(&a_tenoned)
            .ok_or("part_a union produced empty result")?;
        let b_out = crate::membrane::manifold_to_indexed(&b_tenoned)
            .ok_or("part_b difference produced empty result")?;
        Ok((a_out, b_out))
    })();

    match result {
        Ok((a_out, b_out)) => TenonOutcome {
            part_a: a_out,
            part_b: b_out,
            kind: TenonKind::Frustum,
            detail: String::new(),
        },
        Err(reason) => TenonOutcome {
            part_a,
            part_b,
            kind: TenonKind::None,
            detail: format!("tenon skipped: {reason}"),
        },
    }
}

// ---------------------------------------------------------------------------
// Clearance — measure the local mesh thickness around the cut and clamp the tenon
// so it keeps ≥ TENON_WALL_MARGIN_MM of solid material from every wall, both halves.
// ---------------------------------------------------------------------------

/// Local thickness around the tenon anchor, in mm along the tenon's own axes. All
/// distances are "how far solid material extends from the anchor before the first
/// wall" in that direction. `+∞` means no wall was hit (open/over-large part —
/// effectively unconstrained).
struct Clearance {
    /// Depth available into part_b along `−axis` (the mortise's extrusion).
    depth_b: f32,
    /// Material available BEHIND the base, into part_a along `+axis`. A leaned tenon
    /// sinks into it (see [`LeanXform`]), so this is what bounds the lean.
    depth_a: f32,
    /// Lateral room from the anchor to the nearest wall along ±u and ±v, taking
    /// the MIN over both parts (the tightest wall on either half governs).
    lat_u_neg: f32,
    lat_u_pos: f32,
    lat_v_neg: f32,
    lat_v_pos: f32,
}

impl Clearance {
    /// Probe the un-tenoned halves. Rays start a hair off the cut plane to avoid
    /// self-hitting the cut face, and are cast against each part's triangles.
    fn probe(frame: &TenonFrame, part_a: &IndexedMesh, part_b: &IndexedMesh) -> Self {
        let eps = 1e-3;
        // Depth into part_b: start just inside part_b, go along −axis.
        let neg_axis = frame.axis.scale(-1.0);
        let origin_b = frame.anchor.add(neg_axis.scale(eps));
        let depth_b = nearest_hit(part_b, origin_b, neg_axis).map(|d| d + eps).unwrap_or(f32::INFINITY);
        // Same, the other way: how much material backs the base.
        let origin_a = frame.anchor.add(frame.axis.scale(eps));
        let depth_a = nearest_hit(part_a, origin_a, frame.axis).map(|d| d + eps).unwrap_or(f32::INFINITY);

        // Lateral: probe both halves along ±u/±v from the anchor; the tightest
        // wall on EITHER part governs (the tenon footprint spans both at the seam).
        let lat = |dir: Vec3| -> f32 {
            let oa = frame.anchor.add(dir.scale(eps));
            let da = nearest_hit(part_a, oa, dir).map(|d| d + eps).unwrap_or(f32::INFINITY);
            let db = nearest_hit(part_b, oa, dir).map(|d| d + eps).unwrap_or(f32::INFINITY);
            da.min(db)
        };
        Clearance {
            depth_b,
            depth_a,
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

    /// Does the requested frustum fit here? Measured against the MORTISE (tenon +
    /// tolerance) plus the 1 mm wall margin, so both halves keep their material.
    ///
    /// Reports the tightest violation, in the user's units: the room there is and
    /// the room it needs, so the message can name a number they can act on.
    fn check_frustum(
        &self,
        nominal: FrustumDims,
        tolerance: f32,
    ) -> Result<(), TenonProblem> {
        // The mortise extends `tolerance` past the tenon, so the wall must clear the
        // tenon PLUS that tolerance PLUS the margin. The reservation uses the
        // tolerance this cut will actually build with — a looser fit eats into the
        // wall it has to leave standing.
        let m = TENON_WALL_MARGIN_MM;
        let tol = tolerance.max(0.0);

        // Depth: the mortise tip at depth+tol must stay m short of part_b's far wall.
        // `depth_b` is measured from the membrane, and the tenon is lengthened by the
        // kerf to cross the cutter's void, so half of that eats into the room here.
        let needed_depth = nominal.depth + tol + m;
        if self.depth_b < needed_depth {
            return Err(TenonProblem::TooShallow {
                room_mm: self.depth_b,
                needed_mm: needed_depth,
            });
        }
        // Lateral: base half-extent + tol + m must stay inside the side walls. Both
        // axes are reported as full widths — that is what the panel's fields say.
        let checks = [
            (self.half_room_u(), nominal.width),
            (self.half_room_v(), nominal.length),
        ];
        for (half_room, extent) in checks {
            let needed = extent + 2.0 * (tol + m);
            if half_room * 2.0 < needed {
                return Err(TenonProblem::TooNarrow {
                    room_mm: half_room * 2.0,
                    needed_mm: needed,
                });
            }
        }
        Ok(())
    }

    /// [`Clearance::check_frustum`] for the oblong dome: same margins, measured
    /// against the half-ellipsoid's semi-axes and bulge depth.
    fn check_dome(
        &self,
        nominal: DomeDims,
        tolerance: f32,
    ) -> Result<(), TenonProblem> {
        let m = TENON_WALL_MARGIN_MM;
        let tol = tolerance.max(0.0);
        let needed_depth = nominal.depth + tol + m;
        if self.depth_b < needed_depth {
            return Err(TenonProblem::TooShallow {
                room_mm: self.depth_b,
                needed_mm: needed_depth,
            });
        }
        let checks = [
            (self.half_room_u(), nominal.half_w),
            (self.half_room_v(), nominal.half_l),
        ];
        for (half_room, semi_axis) in checks {
            let needed = 2.0 * (semi_axis + tol + m);
            if half_room * 2.0 < needed {
                return Err(TenonProblem::TooNarrow {
                    room_mm: half_room * 2.0,
                    needed_mm: needed,
                });
            }
        }
        Ok(())
    }
}

/// Nearest ray/mesh hit distance (Möller–Trumbore over all triangles). `None` if
/// the ray escapes. Brute force — fine for the handful of probe rays per tenon.
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

/// Confirm the leaned tenon is still INSIDE the body, and say so if it isn't.
///
/// The clearance probes measure room along ±u/±v from the anchor and read a ray
/// that hits nothing as infinite room, so on any convex or tapering surface they
/// wave through a lean that walks the tenon out into the air. This looks where the
/// tenon actually ended up: the cap's centre and its four corners, the points that
/// swing furthest when it leans.
///
/// Only the CAP. The base is buried in material by construction, and every extra
/// point costs a pass over the model's triangles on every preview frame.
fn confirm_tenon_stays_inside(
    plan: TenonPlan,
    model: &IndexedMesh,
    build_frame: &TenonFrame,
    lean: LeanXform,
) -> TenonPlan {
    if !plan.fits() {
        return plan; // already refused, for a reason that is more use than this one
    }
    let depth = plan.depth();
    let (hw, hl) = match plan.body {
        TenonBody::Frustum(d) => (0.5 * d.width * TENON_TOP_SCALE, 0.5 * d.length * TENON_TOP_SCALE),
        // A dome's cap is a point, so its corners are the point too.
        TenonBody::Dome(_) => (0.0, 0.0),
    };
    let cap = [(0.0, 0.0), (hw, hl), (-hw, hl), (hw, -hl), (-hw, -hl)];
    for (dx, dy) in cap {
        let (x, y, z) = lean.apply(dx, dy, depth);
        let p = build_frame
            .anchor
            .add(build_frame.u.scale(x))
            .add(build_frame.v.scale(y))
            .add(build_frame.axis.scale(z));
        if !is_inside(model, p) {
            return TenonPlan {
                verdict: TenonVerdict::DoesNotFit(TenonProblem::EscapesTheBody),
                ..plan
            };
        }
    }
    plan
}

/// Is `p` inside the closed mesh? Ray parity: a ray from an interior point crosses
/// the skin an odd number of times, an exterior one an even number.
///
/// This is the question the lateral ray probes could not answer. They measure "how
/// far to the nearest wall along ±u/±v FROM THE ANCHOR", and when a probe finds no
/// wall it reports infinite room — which on a tapering body (a spire, a tower, any
/// convex outside) is most directions. So a tenon could be leaned until its tip was
/// out in the air and nothing objected, because nothing had looked where the tip
/// actually went.
fn is_inside(mesh: &IndexedMesh, p: Vec3) -> bool {
    use dragonfruit_mesh_core::bvh::ray_tri;
    // An arbitrary but irrational-ish direction, so the ray is unlikely to graze an
    // edge or a vertex — the one case parity counting gets wrong.
    let dir = Vec3::new(0.577_35, 0.577_36, 0.577_34);
    let mut crossings = 0usize;
    for t in &mesh.triangles {
        let a = mesh.positions[t[0] as usize];
        let b = mesh.positions[t[1] as usize];
        let c = mesh.positions[t[2] as usize];
        if let Some(d) = ray_tri(p, dir, a, b, c) {
            if d > 1e-6 {
                crossings += 1;
            }
        }
    }
    crossings % 2 == 1
}

// ---------------------------------------------------------------------------
// Half-sphere (dome) tenon — the fallback when a frustum can't fit a thin part.
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
/// `grow` dilates every semi-axis by that amount (the mortise = tenon with
/// `grow = tolerance`), and the flat cap sits at `z = −grow − overlap` — pulled
/// back into part_a by `grow` (mortise clearance) plus the fixed `TENON_BASE_OVERLAP_MM`
/// so the dome base overlaps part_a's solid for a clean union (and the mortise mouth
/// fully breaches part_b). The straight skirt makes the mortise a clean per-axis
/// dilation of the tenon (no coincident faces) so the boolean is robust.
///
/// `segments` = longitude steps; the surface uses a fixed number of latitude rings.
/// `lean` rigid-rotates the bulge; the lower rings blend to keep the flat mouth
/// disk glued in the cut plane (the dome's many latitude rings make the collar
/// blend smooth). Pass [`LeanXform::IDENTITY`] for an upright dome.
fn build_dome_leaned(
    frame: &TenonFrame,
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
    // Cap plane: pulled back by `grow` (mortise dilation) + the fixed overlap so the
    // base sinks into part_a. For the tenon (grow=0) this is just the overlap.
    let z_mouth = -grow - TENON_BASE_OVERLAP_MM - lean.base_sink;
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
    // short vertical wall so the mortise cleanly clears the tenon as it enters).
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

/// Union the dome tenon onto `part_a`, difference the grown dome mortise from
/// `part_b`. Same failure contract as [`apply_frustum`].
fn apply_dome(
    part_a: IndexedMesh,
    part_b: IndexedMesh,
    frame: &TenonFrame,
    tilt: TenonTilt,
    dims: DomeDims,
    tolerance: f32,
    max_tilt: f32,
) -> TenonOutcome {
    // Same kerf correction as the frustum: the mouth sinks into part_a and `dims`
    // arrives already grown (see `grow_plan_for_kerf`).
    let build_frame = frame_extruding_toward_part_b(frame);
    // Rigid lean rotation about the base (identity when tilt == 0 && roll == 0): the
    // bulge keeps its shape and is sunk so the tilted mouth disk stays buried. Tenon +
    // mortise share the SAME rigid lean, so the dilated mortise contains the leaned tenon.
    let half_diag = dims.half_w.max(dims.half_l) + tolerance;
    let lean = LeanXform::for_build(&tilt, max_tilt, half_diag);
    let tenon_mesh =
        build_dome_leaned(&build_frame, dims.half_w, dims.half_l, dims.depth, 0.0, DOME_SEGMENTS, lean);
    let mortise_mesh =
        build_dome_leaned(&build_frame, dims.half_w, dims.half_l, dims.depth, tolerance, DOME_SEGMENTS, lean);

    let result = (|| -> Result<(IndexedMesh, IndexedMesh), String> {
        let a = to_manifold(&part_a).map_err(|e| format!("part_a invalid: {e}"))?;
        let b = to_manifold(&part_b).map_err(|e| format!("part_b invalid: {e}"))?;
        let tenon = to_manifold(&tenon_mesh).map_err(|e| format!("dome tenon invalid: {e}"))?;
        let mortise = to_manifold(&mortise_mesh).map_err(|e| format!("dome mortise invalid: {e}"))?;
        let a_tenoned = a.union(&tenon);
        let b_tenoned = b.difference(&mortise);
        let a_out = crate::membrane::manifold_to_indexed(&a_tenoned)
            .ok_or("dome union produced empty result")?;
        let b_out = crate::membrane::manifold_to_indexed(&b_tenoned)
            .ok_or("dome difference produced empty result")?;
        Ok((a_out, b_out))
    })();

    match result {
        Ok((a_out, b_out)) => TenonOutcome {
            part_a: a_out,
            part_b: b_out,
            kind: TenonKind::Dome,
            detail: String::new(),
        },
        Err(reason) => TenonOutcome {
            part_a,
            part_b,
            kind: TenonKind::None,
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

    /// The in-plane basis has to move as little as the axis does. The tenon's lean
    /// plane is welded to `u`, and the preview and the cut each measure the axis on
    /// their own copy of the membrane — so a `u` that turns a quarter turn when the
    /// axis moves a thousandth of a degree makes the tenon lean one way on screen
    /// and another way in the cut.
    #[test]
    fn the_in_plane_basis_does_not_swing_when_the_axis_barely_moves() {
        // Right through the old rule's worst crossing: |x| = |y| = |z|, where its
        // seed jumped from world X to world Y on the last bit of the mantissa.
        let d = 1.0 / 3.0f32.sqrt();
        for (sx, sy) in [(1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
            let axis = Vec3::new(d * sx, d * sy, d);
            let (u, _) = orthonormal_basis(axis);
            for eps in [1e-5f32, -1e-5, 1e-4, -1e-4] {
                let nudged = {
                    let p = Vec3::new(d * sx + eps, d * sy - eps, d);
                    p.scale(1.0 / p.length())
                };
                let (u2, v2) = orthonormal_basis(nudged);
                assert!(
                    u.dot(u2) > 0.999,
                    "a {eps} nudge turned u from {u:?} to {u2:?}",
                );
                // And it is still a right-handed orthonormal frame.
                assert!(u2.dot(v2).abs() < 1e-5, "u and v stay perpendicular");
                assert!((u2.cross(v2).dot(nudged) - 1.0).abs() < 1e-4, "u × v = axis");
            }
        }
    }

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

    /// A strongly warped membrane: a tight ring whose height swings by more than
    /// its own radius, the regime a cut around a waist lands in.
    ///
    /// Asymmetric and tight on purpose. On a gentle or symmetric patch the vertex
    /// centroid happens to land on the surface and the patch-wide mean normal
    /// happens to match the local one, so such a fixture cannot tell the old
    /// mean-plane frame from a local one. Measured here: centroid ~1.6mm off the
    /// surface, mean normal ~82° from the local normal.
    fn warped_membrane() -> Membrane {
        const N: usize = 8;
        let amps = [0.0f32, 12.0, -3.0, 11.0, -13.0, 4.0, -9.0, 6.0];
        let loop_pts: Vec<Vec3> = (0..N)
            .map(|i| {
                let th = std::f32::consts::TAU * i as f32 / N as f32;
                Vec3::new(6.0 * th.cos(), 6.0 * th.sin(), amps[i])
            })
            .collect();
        build_membrane_full(&loop_pts, CONTOUR_SUBDIVISIONS, DEFAULT_MEMBRANE_SMOOTHING, 24.0)
            .expect("warped membrane builds")
    }

    /// Distance from `p` to the membrane surface.
    fn distance_to_membrane(mem: &Membrane, p: Vec3) -> f32 {
        let mut best = f32::INFINITY;
        for t in &mem.triangles {
            let a = mem.vertices[t[0] as usize];
            let b = mem.vertices[t[1] as usize];
            let c = mem.vertices[t[2] as usize];
            let (_, d2) = crate::membrane::closest_on_tri(p, a, b, c);
            best = best.min(d2);
        }
        best.sqrt()
    }

    // The tenon lands where it was put. This is the whole point of an anchor being
    // a POINT: ask for a place on the cut face and that is the place you get, with
    // no basis to agree on and no displacement to re-derive.
    //
    // It used to be an offset in millimetres from the centroid, measured in one
    // basis by the handle and applied in another by this function — on a warped
    // seam those are tens of degrees apart, so the tenon appeared somewhere neither
    // had asked for, and small drags could jump it clear across the patch.
    #[test]
    fn the_tenon_lands_where_it_was_put() {
        let mem = warped_membrane();
        // Sample real places ON the cut face — the vertices are, by construction.
        for i in [0usize, 7, 23, 40] {
            let wanted = mem.vertices[i % mem.vertices.len()];
            let frame = frame_from_membrane_at(&mem, Some(wanted)).expect("frame");
            assert!(
                frame.anchor.sub(wanted).length() < 1e-3,
                "asked for {wanted:?}, got {:?}",
                frame.anchor,
            );
        }
    }

    // A point that is NOT on the cut face lands at the nearest place it could
    // actually sit, rather than being refused or drifting off the surface. The
    // handle can only produce points on the face, so this is a guard for float
    // error and for a membrane rebuilt at a different smoothing under an anchor
    // that was saved against the old one.
    #[test]
    fn an_anchor_off_the_face_snaps_onto_it() {
        let mem = warped_membrane();
        let on_face = mem.vertices[11 % mem.vertices.len()];
        let axis = mean_membrane_normal(&mem);
        let adrift = on_face.add(axis.scale(3.0));
        let frame = frame_from_membrane_at(&mem, Some(adrift)).expect("frame");
        assert!(
            distance_to_membrane(&mem, frame.anchor) < 1e-3,
            "the anchor sits on the cut face",
        );
        assert!(
            frame.anchor.sub(adrift).length() <= 3.0 + 1e-3,
            "and at the NEAREST spot, not wherever",
        );
    }

    #[test]
    fn frame_anchor_sits_on_a_curved_membrane() {
        let mem = warped_membrane();

        // Premise: on this membrane the vertex centroid — what the frame used to
        // anchor to — is genuinely off the surface. Without this the test could
        // pass against the old mean-plane frame and prove nothing.
        let mut centroid = Vec3::ZERO;
        for &p in &mem.vertices {
            centroid = centroid.add(p);
        }
        centroid = centroid.scale(1.0 / mem.vertices.len() as f32);
        let centroid_gap = distance_to_membrane(&mem, centroid);
        assert!(
            centroid_gap > 0.1,
            "fixture is too flat to be meaningful (centroid only {centroid_gap:.4}mm off)"
        );

        let frame = frame_from_membrane(&mem).expect("frame");
        let anchor_gap = distance_to_membrane(&mem, frame.anchor);
        assert!(
            anchor_gap < 1e-3,
            "anchor is {anchor_gap:.4}mm off the membrane (centroid was {centroid_gap:.4}mm)"
        );
    }

    #[test]
    fn frame_axis_follows_the_surface_where_the_tenon_sits() {
        let mem = warped_membrane();
        let frame = frame_from_membrane(&mem).expect("frame");

        // Local normal at the anchor's triangle.
        let mut best_d2 = f32::INFINITY;
        let mut local = Vec3::ZERO;
        for t in &mem.triangles {
            let a = mem.vertices[t[0] as usize];
            let b = mem.vertices[t[1] as usize];
            let c = mem.vertices[t[2] as usize];
            let (_, d2) = crate::membrane::closest_on_tri(frame.anchor, a, b, c);
            if d2 < best_d2 {
                best_d2 = d2;
                let n = b.sub(a).cross(c.sub(a));
                let l = n.length();
                if l > 1e-12 {
                    local = n.scale(1.0 / l);
                }
            }
        }

        // Premise: the patch-wide mean normal genuinely disagrees with the local
        // one here, so this distinguishes the two.
        let mut nsum = Vec3::ZERO;
        for t in &mem.triangles {
            let a = mem.vertices[t[0] as usize];
            let b = mem.vertices[t[1] as usize];
            let c = mem.vertices[t[2] as usize];
            nsum = nsum.add(b.sub(a).cross(c.sub(a)));
        }
        let mean = nsum.scale(1.0 / nsum.length());
        assert!(
            mean.dot(local).abs() < 0.98,
            "fixture too flat: mean and local normals already agree"
        );

        let alignment = frame.axis.dot(local).abs();
        assert!(
            alignment > 0.98,
            "axis is {:.1}° off the local surface normal",
            alignment.clamp(-1.0, 1.0).acos().to_degrees()
        );
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
        let tenon = build_frustum(&frame, dims, 0.0, 0.0);
        assert_eq!(tenon.positions.len(), 8, "frustum has 8 corners");
        assert_eq!(tenon.triangles.len(), 12, "frustum has 12 triangles");
        let m = to_manifold(&tenon).expect("frustum converts to a watertight manifold");
        assert!(m.num_tri() > 0, "non-empty manifold");
    }

    // Test 1b: a FILLETED frustum (rounded corners + tip) is watertight, and its
    // tenon still fits inside the grown filleted mortise.
    #[test]
    fn filleted_frustum_is_watertight_and_fits() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let fillet = 0.6;
        let tenon = build_frustum(&frame, dims, 0.0, fillet);
        // Rounded build has many more verts/tris than the 8/12 sharp box.
        assert!(tenon.positions.len() > 8, "filleted tenon has extra verts");
        let tenon_m = to_manifold(&tenon).expect("filleted tenon is watertight");
        assert!(tenon_m.num_tri() > 0, "non-empty");
        // Mortise = tenon offset by tol with fillet grown by tol (matches apply_frustum).
        let mortise_m =
            to_manifold(&build_frustum(&frame, dims, 0.1, fillet + 0.1)).expect("filleted mortise");
        let leftover = tenon_m.difference(&mortise_m);
        assert!(
            leftover.is_empty() || leftover.num_tri() == 0,
            "filleted tenon fits inside grown filleted mortise (leftover = {})",
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
            (dims.length - TENON_LENGTH_TO_WIDTH * 6.0).abs() < 1e-4,
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
        assert!((huge.width - TENON_WIDTH_MAX_MM).abs() < 1e-3, "width capped at max");
        assert!((huge.depth - TENON_DEPTH_MAX_MM).abs() < 1e-3, "depth capped at max");
        let tiny = FrustumDims::from_width_depth(0.0, 0.0);
        assert!((tiny.width - TENON_WIDTH_MIN_MM).abs() < 1e-3, "width floored at min");
        assert!((tiny.depth - TENON_DEPTH_MIN_MM).abs() < 1e-3, "depth floored at min");
    }

    // Test 3: tolerance growth — mortise strictly larger than tenon on every face.
    #[test]
    fn mortise_grows_by_tolerance_on_all_faces() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let tol = 0.1;
        let tenon = build_frustum(&frame, dims, 0.0, 0.0);
        let mortise = build_frustum(&frame, dims, tol, 0.0);

        let (plo, phi) = bbox_of(&tenon);
        let (slo, shi) = bbox_of(&mortise);
        // Frame axis is ±Z here, u/v in the XY plane. Mortise should exceed the tenon
        // by ~tol in every direction (the mouth pulls back by tol in −axis too).
        for (a, b, name) in [
            (slo.x, plo.x, "x lo"),
            (slo.y, plo.y, "y lo"),
            (slo.z, plo.z, "z lo"),
        ] {
            assert!(a < b - tol * 0.5, "mortise {name} extends past tenon");
        }
        for (a, b, name) in [
            (shi.x, phi.x, "x hi"),
            (shi.y, phi.y, "y hi"),
            (shi.z, phi.z, "z hi"),
        ] {
            assert!(a > b + tol * 0.5, "mortise {name} extends past tenon");
        }
    }

    // Test 4: apply_tenon on a flat cut grows part_a (tenon added) and keeps both
    // halves watertight.
    #[test]
    fn apply_tenon_unions_the_tenon_and_carves_the_mortise() {
        // Two stacked boxes acting as the two halves, meeting at z=0 over a 10×10
        // area — exactly what a flat equatorial cut of a 10×10×20 box yields. The
        // un-cut model is the full 10×10×20 body (clearance probes against THIS).
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let part_a = axis_aligned_slab(Vec3::new(-5.0, -5.0, 0.0), Vec3::new(5.0, 5.0, 10.0));
        let part_b = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 0.0));
        let mem = flat_membrane(10.0);

        let a_tris_before = part_a.triangle_count();
        let out = apply_tenon(&model, part_a, part_b, &mem, TenonShape::Frustum, false, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1, None);

        assert_eq!(out.kind, TenonKind::Frustum, "frustum tenon placed: {}", out.detail);
        assert!(
            out.part_a.triangle_count() > a_tris_before,
            "part_a gained triangles from the unioned tenon"
        );
        // Both halves remain watertight (convertible to a manifold).
        assert!(to_manifold(&out.part_a).is_ok(), "tenoned part_a is watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "tenoned part_b is watertight");
    }

    // Test 4b: swap_sides flips which half gets the tenon — now part_B grows it (the
    // mirror of test 4), and the returned parts keep the caller's a/b orientation.
    #[test]
    fn swap_sides_puts_the_tenon_on_part_b() {
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let part_a = axis_aligned_slab(Vec3::new(-5.0, -5.0, 0.0), Vec3::new(5.0, 5.0, 10.0));
        let part_b = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 0.0));
        let mem = flat_membrane(10.0);

        let b_tris_before = part_b.triangle_count();
        // swap_sides = true → tenon unions onto part_b, mortise carves part_a.
        let out = apply_tenon(&model, part_a, part_b, &mem, TenonShape::Frustum, true, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1, None);

        assert_eq!(out.kind, TenonKind::Frustum, "swapped frustum tenon placed: {}", out.detail);
        assert!(
            out.part_b.triangle_count() > b_tris_before,
            "part_b gained the tenon when swapped ({} → {})",
            b_tris_before,
            out.part_b.triangle_count()
        );
        assert!(to_manifold(&out.part_a).is_ok(), "swapped part_a watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "swapped part_b watertight");
    }

    // Test 5: the tenon fits inside the grown mortise cavity (difference is empty).
    #[test]
    fn tenon_fits_inside_mortise_cavity() {
        let mem = flat_membrane(10.0);
        let frame = frame_from_membrane(&mem).expect("frame");
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let tenon = to_manifold(&build_frustum(&frame, dims, 0.0, 0.0)).expect("tenon");
        let mortise = to_manifold(&build_frustum(&frame, dims, 0.1, 0.0)).expect("mortise");
        // tenon − mortise should be empty: the tenon lies entirely within the cavity.
        let leftover = tenon.difference(&mortise);
        assert!(
            leftover.is_empty() || leftover.num_tri() == 0,
            "tenon is fully contained in the grown mortise (leftover tris = {})",
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

    // A tenon too deep for the part is REFUSED, not quietly shortened to whatever
    // would have fitted. The parts come back untouched, and the reason names both
    // numbers — the room there is, and the room it needed — so the user can fix it.
    #[test]
    fn a_tenon_too_deep_for_the_part_is_refused_not_shrunk() {
        let mem = flat_membrane(10.0);
        // Request a 5 mm-deep tenon into a part_b only 4 mm thick: it would punch
        // through, and shortening it to ~2.9 mm would silently give the user a
        // tenon they never asked for.
        let (model, part_a, part_b) = split_halves(20.0, 4.0);
        let pb_tris = part_b.triangle_count();
        let out = apply_tenon(&model, part_a, part_b, &mem, TenonShape::Frustum, false, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1, None);

        assert_eq!(out.kind, TenonKind::None, "refused, not placed: {}", out.detail);
        assert!(
            out.detail.contains("doesn't fit") && out.detail.contains("4.00 mm"),
            "the reason names the room it has: {:?}",
            out.detail
        );
        assert_eq!(
            out.part_b.triangle_count(),
            pb_tris,
            "a refused tenon leaves both halves untouched",
        );
    }

    // Nor is a frustum ever swapped for a half-sphere. The dome is a shape the user
    // can pick; it stopped being a consolation prize we hand out behind their back.
    #[test]
    fn a_frustum_that_does_not_fit_never_becomes_a_dome() {
        let mem = flat_membrane(10.0);
        // 2 mm of part_b: the old ladder shrank past the frustum floor and placed a
        // dome here, reporting "fell back to a half-sphere".
        let (model, pa, pb) = split_halves(20.0, 2.0);
        let out = apply_tenon(&model, pa, pb, &mem, TenonShape::Frustum, false, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1, None);
        assert_eq!(out.kind, TenonKind::None, "no dome substitution: {}", out.detail);
        assert!(
            !out.detail.contains("half-sphere"),
            "and it doesn't offer one: {:?}",
            out.detail
        );
    }

    // A refused tenon is still BUILT for the preview, at the size that was asked
    // for, with its placement frame — that is what the scene draws in red and what
    // the gizmo hangs off, so the user can drag it somewhere it fits.
    #[test]
    fn a_refused_tenon_is_still_previewed_at_its_requested_size() {
        let (model, _, _) = split_halves(20.0, 2.0);
        let frame = TenonFrame {
            anchor: Vec3::ZERO,
            axis: Vec3::new(0.0, 0.0, 1.0),
            u: Vec3::new(1.0, 0.0, 0.0),
            v: Vec3::new(0.0, 1.0, 0.0),
            cut_area: 100.0,
        };
        let preview = build_tenon_preview_at_frame(&model, frame, TenonShape::Frustum, false, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1);

        assert!(!preview.fits, "it does not fit: {:?}", preview.detail);
        assert!(!preview.detail.is_empty(), "and it says why");
        assert_eq!(preview.kind, TenonKind::Frustum, "still drawn as the frustum asked for");
        assert!(preview.tenon_triangles > 0, "the tenon is still built");
        assert!(
            preview.soup.len() / 9 > preview.tenon_triangles,
            "and so is its mortise",
        );
        assert!(preview.frame.is_some(), "the aim gizmo still has a frame to sit on");

        // The body is the REQUESTED 5 mm, not the ~1 mm the walls would have allowed.
        let depth = preview.frame.expect("frame").depth;
        assert!(
            (depth - 5.0).abs() < 1e-3,
            "previewed at the requested 5 mm depth, got {depth}",
        );
    }

    // Test 8b: choosing Dome on a THICK part places a dome on purpose (not a
    // frustum), proving the shape selector overrides the default frustum-first.
    #[test]
    fn explicit_dome_shape_places_a_dome_on_a_thick_part() {
        let mem = flat_membrane(10.0);
        // Plenty thick for a frustum — but we ask for a dome explicitly.
        let (model, pa, pb) = split_halves(20.0, 20.0);
        let out = apply_tenon(&model, pa, pb, &mem, TenonShape::Dome, false, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1, None);
        assert_eq!(
            out.kind,
            TenonKind::Dome,
            "explicit dome on a thick part is a dome, not a frustum: {}",
            out.detail
        );
        assert!(to_manifold(&out.part_a).is_ok(), "domed part_a watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "domed part_b watertight");
    }

    // End to end, through the real preview: leaning lowers the cap to depth·cos and
    // does not resize the tenon. The twin of `tilt_rotates_rigidly_and_leans_the_tip`,
    // which measures the transform; this one measures the SOUP that gets drawn.
    #[test]
    fn the_preview_soup_is_built_straight_and_buried_deep_enough_for_any_lean() {
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let loop_pts = vec![
            Vec3::new(-5.0, -5.0, 0.0),
            Vec3::new(5.0, -5.0, 0.0),
            Vec3::new(5.0, 5.0, 0.0),
            Vec3::new(-5.0, 5.0, 0.0),
        ];
        let (width, depth, tol) = (2.0f32, 2.5f32, 0.1f32);
        // Only the TENON's triangles: the mortise is grown by the tolerance and would
        // read a hair longer.
        let extent = |tilt_deg: f32| -> (f32, f32) {
            let preview = build_tenon_preview_soup(
                &model, &loop_pts, DEFAULT_MEMBRANE_SMOOTHING, 1.0, TenonShape::Frustum, false,
                TenonTilt::new(tilt_deg.to_radians(), 0.0), width, depth, 0.0, tol,
                None,
            )
            .expect("preview builds");
            let tenon = &preview.soup[..preview.tenon_triangles * 9];
            // The cut is at z=0 and the tenon extrudes along ±z.
            // The tenon extrudes toward −z here, so the CAP is the minimum and the
            // base (which reaches back into part_a) is the maximum.
            let zs: Vec<f32> = tenon.chunks_exact(3).map(|c| c[2]).collect();
            let cap = zs.iter().copied().fold(f32::INFINITY, f32::min);
            let base = zs.iter().copied().fold(f32::NEG_INFINITY, f32::max);
            (cap, base)
        };

        // The base extension is a change of LENGTH, which no client-side rotation can
        // produce — so the soup carries enough of it for the STEEPEST lean the gizmo
        // reaches, whatever lean it was built at. Sized for the angle it was built
        // at instead, a soup built upright had none, and the first few degrees of
        // the gizmo lifted the base edge out through the cut face in plain view.
        let half_diag = 0.5 * width.hypot(width * TENON_LENGTH_TO_WIDTH) + tol;
        let burial = half_diag * TENON_MAX_TILT_RAD.sin();

        let (cap0, base0) = extent(0.0);
        assert!(
            (base0 - cap0 - (depth + TENON_BASE_OVERLAP_MM + burial)).abs() < 0.05,
            "upright, the tenon is its depth plus the base overlap plus the burial: \
             cap {cap0}, base {base0}, burial {burial}",
        );

        // The soup is built STRAIGHT — the frontend leans it, so this must not turn —
        // and it is the SAME soup at every angle, cap and base both.
        for deg in [15.0f32, 30.0, 45.0] {
            let (cap, base) = extent(deg);
            assert!(
                (cap - cap0).abs() < 0.05,
                "at {deg}° the cap end has not moved (soup is built straight): {cap} vs {cap0}",
            );
            assert!(
                (base - base0).abs() < 0.05,
                "at {deg}° the base is buried exactly as deep as at 0: {base} vs {base0}",
            );
        }

        // What that burial buys, stated in the terms the gizmo works in: the base
        // reaches back past the cut face by at least what the steepest lean lifts
        // its leading corner, so rotating the soup never brings it into view.
        assert!(
            base0 - TENON_BASE_OVERLAP_MM >= half_diag * TENON_MAX_TILT_RAD.sin() - 0.05,
            "the straight soup reaches back far enough to stay buried at the ceiling: base {base0}",
        );
    }

    // Leaned far enough, the tenon comes out through the skin — and the ray probes
    // never noticed, because a probe that hits nothing reads as infinite room and on
    // a tapering body most directions hit nothing. Pinned on a CONE for that reason:
    // a slab has walls for the probes to find, so it cannot show this at all.
    #[test]
    fn a_lean_that_takes_the_tenon_out_through_the_skin_is_refused() {
        // A cone standing on z=0, apex at z=20: the surface falls away in every
        // lateral direction, so a probe from a point on the axis escapes.
        const N: usize = 48;
        // 0 = apex, 1 = centre of the base disk, 2.. = the rim.
        let mut positions = vec![Vec3::new(0.0, 0.0, 20.0), Vec3::new(0.0, 0.0, 0.0)];
        for i in 0..N {
            let th = std::f32::consts::TAU * i as f32 / N as f32;
            positions.push(Vec3::new(8.0 * th.cos(), 8.0 * th.sin(), 0.0));
        }
        let mut triangles = Vec::new();
        for i in 0..N {
            let a = 2 + i as u32;
            let b = 2 + ((i + 1) % N) as u32;
            triangles.push([0u32, a, b]); // side
            triangles.push([1u32, b, a]); // base disk, wound the other way
        }
        let cone = IndexedMesh { positions, triangles };

        // A point up the axis is inside; one out to the side at the same height is
        // not — the premise the probes miss.
        assert!(is_inside(&cone, Vec3::new(0.0, 0.0, 10.0)), "premise: axis is inside");
        assert!(!is_inside(&cone, Vec3::new(7.0, 0.0, 10.0)), "premise: out to the side is not");

        // A tenon rooted on the axis, leaned hard, reaches out past the sloping skin.
        let frame = TenonFrame {
            anchor: Vec3::new(0.0, 0.0, 10.0),
            axis: Vec3::new(0.0, 0.0, 1.0),
            u: Vec3::new(1.0, 0.0, 0.0),
            v: Vec3::new(0.0, 1.0, 0.0),
            cut_area: 100.0,
        };
        let plan = TenonPlan {
            // Short enough that standing straight it is comfortably inside the cone
            // (tip at z=14, where the radius is 2.4mm), so the refusal below can only
            // be about the LEAN.
            body: TenonBody::Frustum(FrustumDims::from_width_depth(2.0, 4.0)),
            verdict: TenonVerdict::Fits,
        };
        let hard = LeanXform::for_build(&TenonTilt::new(TENON_MAX_TILT_RAD, 0.0), TENON_MAX_TILT_RAD, 1.0);
        let leaned = confirm_tenon_stays_inside(plan.clone(), &cone, &frame, hard);
        assert_eq!(
            leaned.verdict,
            TenonVerdict::DoesNotFit(TenonProblem::EscapesTheBody),
            "a tenon leaned out through the skin is refused",
        );

        // Standing straight in the same spot, it is fine.
        let upright = confirm_tenon_stays_inside(plan, &cone, &frame, LeanXform::IDENTITY);
        assert!(upright.fits(), "and upright it is fine: {}", upright.detail());
    }

    // Leaning must not resize the tenon where it counts: its cross-section AT THE
    // CUT FACE. Extending the base to keep the turned base buried used to re-loft
    // the taper over a longer run, so the section at the face got narrower the
    // further it leaned — the tenon visibly shrank the moment Rust answered, while
    // the client-side preview (which cannot resize anything) had looked right.
    #[test]
    fn extending_the_base_for_a_lean_does_not_thin_the_tenon_at_the_cut_face() {
        let frame = TenonFrame {
            anchor: Vec3::ZERO,
            axis: Vec3::new(0.0, 0.0, 1.0),
            u: Vec3::new(1.0, 0.0, 0.0),
            v: Vec3::new(0.0, 1.0, 0.0),
            cut_area: 100.0,
        };
        let dims = FrustumDims::from_width_depth(3.0, 4.0);
        // Half-width of the solid at the cut plane (z = 0), measured off the mesh.
        let width_at_face = |base_sink: f32| -> f32 {
            let lean = LeanXform { tilt: 0.0, roll: 0.0, base_sink, identity: base_sink <= 0.0 };
            let mesh = build_frustum_leaned(&frame, dims, 0.0, 0.0, lean);
            // Widest |x| among vertices straddling the cut plane, by interpolating
            // each edge that crosses z = 0.
            let mut widest = 0.0f32;
            for t in &mesh.triangles {
                for (i, j) in [(0, 1), (1, 2), (2, 0)] {
                    let (a, b) = (mesh.positions[t[i] as usize], mesh.positions[t[j] as usize]);
                    if (a.z > 0.0) == (b.z > 0.0) {
                        continue;
                    }
                    let s = (0.0 - a.z) / (b.z - a.z);
                    widest = widest.max((a.x + s * (b.x - a.x)).abs());
                }
            }
            widest
        };

        let upright = width_at_face(0.0);
        assert!(upright > 0.5, "premise: the tenon straddles the cut plane ({upright}mm)");
        // 45° on this footprint asks for a real extension, not a rounding error.
        for sink in [0.5f32, 1.2, 2.0] {
            let leaned = width_at_face(sink);
            assert!(
                (leaned - upright).abs() < 1e-3,
                "with {sink}mm of base extension the tenon is still {upright}mm across \
                 at the cut face, got {leaned}",
            );
        }
    }

    // Leaning is never silently refused. Room to spare and it fits; a near wall and
    // it does not — but the ANGLE is always the user's to set. The old cap froze the
    // ring at 0 on a cramped placement, which read as a broken gizmo.
    #[test]
    fn the_lean_is_reported_as_a_fit_not_enforced_as_a_cap() {
        let dims = FrustumDims::from_width_depth(2.0, 2.5);
        let plan = TenonPlan { body: TenonBody::Frustum(dims), verdict: TenonVerdict::Fits };
        let (half_diag, depth) = (plan.half_diag(0.1), plan.depth());
        let lean = std::f32::consts::FRAC_PI_6; // 30°
        let roomy = Clearance {
            depth_a: f32::INFINITY,
            depth_b: f32::INFINITY,
            lat_u_neg: f32::INFINITY,
            lat_u_pos: f32::INFINITY,
            lat_v_neg: f32::INFINITY,
            lat_v_pos: f32::INFINITY,
        };
        assert!(
            check_lean(&roomy, half_diag, depth, lean).is_ok(),
            "nothing in the way → a 30° lean fits",
        );

        // A wall right up against it: the leaned trunk swings into it, so the tenon
        // does not fit — and says which way it doesn't.
        let cramped = Clearance { lat_v_pos: 1.2, lat_v_neg: 1.2, ..roomy };
        assert!(
            matches!(
                check_lean(&cramped, half_diag, depth, lean),
                Err(TenonProblem::TooNarrow { .. })
            ),
            "a wall against the swing is reported as too narrow",
        );

        // Thin material behind the base bounds it too: the lean sinks the base in.
        let shallow = Clearance { depth_a: 0.5, ..roomy };
        assert!(
            matches!(
                check_lean(&shallow, half_diag, depth, lean),
                Err(TenonProblem::TooShallow { .. })
            ),
            "nothing to sink the base into is reported as too shallow",
        );

        // And standing straight is unaffected either way.
        assert!(check_lean(&cramped, half_diag, depth, 0.0).is_ok(), "no lean, no swing");
    }

    // Test 6: the preview soup is non-empty, finite, and a multiple of 9 floats
    // (tenon + mortise), and reports the frustum kind on a healthy part.
    #[test]
    fn tenon_preview_soup_is_valid() {
        // A 10×10×20 box as the model; an equatorial loop at z=0.
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let loop_pts = vec![
            Vec3::new(-5.0, -5.0, 0.0),
            Vec3::new(5.0, -5.0, 0.0),
            Vec3::new(5.0, 5.0, 0.0),
            Vec3::new(-5.0, 5.0, 0.0),
        ];
        let preview =
            build_tenon_preview_soup(&model, &loop_pts, DEFAULT_MEMBRANE_SMOOTHING, 1.0, TenonShape::Frustum, false, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1, None)
                .expect("preview builds");
        let soup = &preview.soup;
        assert_eq!(preview.kind, TenonKind::Frustum, "healthy box → frustum tenon preview");
        assert!(!soup.is_empty(), "preview soup non-empty");
        assert_eq!(soup.len() % 9, 0, "whole triangles");
        assert!(soup.iter().all(|f| f.is_finite()), "all coords finite");
        // The tenon is the first half of the soup and the mortise the rest, so the
        // frontend can colour them apart.
        assert!(preview.tenon_triangles > 0, "tenon triangles reported");
        assert!(
            preview.tenon_triangles < soup.len() / 9,
            "the mortise's triangles come after the tenon's",
        );
    }

    // GONE with the kerf: the tenon no longer has a gap to span. The cut face is
    // shared by both halves, so the tenon stands on it and the clearance the user
    // asks for is spent on the joint's fit (`tolerance`), not on reaching across a
    // void. See `surface_cap`.

    // Test 6b: the swap flag visibly flips the preview — the tenon's body extends to
    // the OPPOSITE side of the cut (so the flip is apparent on screen, not a no-op).
    #[test]
    fn swap_flips_the_preview_tenon_direction() {
        let model = axis_aligned_slab(Vec3::new(-5.0, -5.0, -10.0), Vec3::new(5.0, 5.0, 10.0));
        let loop_pts = vec![
            Vec3::new(-5.0, -5.0, 0.0),
            Vec3::new(5.0, -5.0, 0.0),
            Vec3::new(5.0, 5.0, 0.0),
            Vec3::new(-5.0, 5.0, 0.0),
        ];
        // The cut is at z=0; the tenon extrudes along ±z. Measure the soup's z-extent
        // on each side of the cut for unswapped vs swapped.
        let z_extent = |swap: bool| -> (f32, f32) {
            let soup = build_tenon_preview_soup(
                &model, &loop_pts, DEFAULT_MEMBRANE_SMOOTHING, 1.0, TenonShape::Frustum, swap, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1, None,
            )
            .expect("preview builds")
            .soup;
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
        // Unswapped: tenon extends mostly to ONE side; swapped: mostly to the OTHER.
        // The body's far extent should land on opposite signs of z.
        let far0 = if hi0.abs() > lo0.abs() { hi0 } else { lo0 };
        let far1 = if hi1.abs() > lo1.abs() { hi1 } else { lo1 };
        assert!(
            far0.signum() != far1.signum(),
            "swap flips the tenon to the other side of the cut (far0={far0}, far1={far1})"
        );
    }

    // Test 9: the dome tenon (round AND oblong) is watertight and the tenon fits inside
    // the grown mortise.
    #[test]
    fn dome_is_watertight_and_fits() {
        let mem = flat_membrane(10.0);
        let frame = frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        // (half_w, half_l, depth) cases: a round hemisphere and two oblong ones.
        for (hw, hl, d) in [(3.0, 3.0, 3.0), (4.0, 2.0, 3.0), (2.0, 2.5, 5.0)] {
            let tenon = build_dome_leaned(&frame, hw, hl, d, 0.0, DOME_SEGMENTS, LeanXform::IDENTITY);
            let mortise =
                build_dome_leaned(&frame, hw, hl, d, 0.1, DOME_SEGMENTS, LeanXform::IDENTITY);
            let tenon_m = to_manifold(&tenon)
                .unwrap_or_else(|e| panic!("dome tenon ({hw},{hl},{d}) watertight: {e}"));
            let mortise_m = to_manifold(&mortise)
                .unwrap_or_else(|e| panic!("dome mortise ({hw},{hl},{d}) watertight: {e}"));
            let leftover = tenon_m.difference(&mortise_m);
            assert!(
                leftover.is_empty() || leftover.num_tri() == 0,
                "dome tenon ({hw},{hl},{d}) fits inside grown mortise (leftover = {})",
                leftover.num_tri()
            );
        }
    }

    // Test 11: a TILTED tenon rigidly rotates (keeps its exact shape) about the base,
    // sunk so the tilted base stays buried below the cut plane, and the tip leans
    // over. The whole tenon is one rigid body — no shear/stretch.
    #[test]
    fn tilt_rotates_rigidly_and_leans_the_tip() {
        let mem = flat_membrane(10.0);
        let frame =
            frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        let dims = FrustumDims::from_width_depth(5.0, 5.0);
        let half_diag = 0.5 * dims.width.hypot(dims.length);
        let tilt = TenonTilt::new(std::f32::consts::FRAC_PI_4, 0.0); // 45° lean
        let lean = LeanXform::for_build(&tilt, TENON_MAX_TILT_RAD, half_diag);

        let _ = build_frustum_leaned(&frame, dims, 0.0, 0.0, lean); // builds watertight

        // The body is RIGID: leaning it rotates it and nothing else. Every corner
        // keeps its distance from the base centre, and the tip keeps its length.
        //
        // It used to sink the whole tenon and lengthen the trunk so the cap stayed
        // at a fixed height above the cut face. That made the tenon a different size
        // at every angle — the panel said 5mm and the solid was something else.
        let (tx, ty, tz) = lean.apply(0.0, 0.0, dims.depth);
        let tip_len = (tx * tx + ty * ty + tz * tz).sqrt();
        assert!(
            (tip_len - dims.depth).abs() < 1e-3,
            "the trunk keeps its {} mm, got {tip_len}",
            dims.depth,
        );

        // And so the cap ends up at depth·cos(lean) above the cut face — lower than
        // standing straight, which is what leaning a solid does.
        let expected = dims.depth * tilt.tilt.cos();
        assert!(
            (tz - expected).abs() < 1e-3,
            "cap at depth·cos(lean) = {expected} mm above the face, got {tz}",
        );
        let lateral = (tx * tx + ty * ty).sqrt();
        assert!(lateral > 0.1, "the tip actually leans (lateral {lateral} mm)");
        assert!(
            (lateral - tz).abs() < 0.05,
            "at 45° the tip leans one to one: lateral {lateral} mm vs height {tz} mm",
        );
    }

    // Rolling turns the tenon AND the direction it leans, as ONE body: the tip at
    // roll δ is the tip at roll 0, turned by δ about the cut normal. Nothing else
    // is acceptable — the ring is the tenon's own spin, so whatever it does to the
    // body it must do to the lean.
    //
    // This is the "0 to 180 in a full turn" bug, pinned. The lean plane was aimed
    // by a separate `azimuth` the frontend derived as `π/2 − roll`: the body turned
    // one way at δ and its lean plane the other, so the two moved at 2δ relative to
    // each other and the trunk visibly lagged the handle.
    #[test]
    fn rolling_turns_the_tenon_and_its_lean_together() {
        let tilt = std::f32::consts::FRAC_PI_6; // 30°
        let depth = 5.0;
        let upright = LeanXform::for_build(&TenonTilt::new(tilt, 0.0), TENON_MAX_TILT_RAD, 1.0);
        let (ux, uy, uz) = upright.apply(0.0, 0.0, depth);

        for deg in [30.0f32, 90.0, 150.0, 240.0, 330.0] {
            let roll = deg.to_radians();
            let rolled = LeanXform::for_build(&TenonTilt::new(tilt, roll), TENON_MAX_TILT_RAD, 1.0);
            let (rx, ry, rz) = rolled.apply(0.0, 0.0, depth);
            // Turn the un-rolled tip by the same angle about +z and they must agree.
            let (s, c) = roll.sin_cos();
            let (ex, ey) = (ux * c - uy * s, ux * s + uy * c);
            assert!(
                (rx - ex).abs() < 1e-4 && (ry - ey).abs() < 1e-4 && (rz - uz).abs() < 1e-4,
                "at {deg}° the tip should be the un-rolled tip turned by {deg}°: \
                 got ({rx}, {ry}, {rz}), expected ({ex}, {ey}, {uz})",
            );
        }
    }

    // GONE with the kerf: nothing sinks the base any more, so there is no sunk base
    // to pivot away from. The build frame sits ON the cut face.

    // Test 11a2: the lean is a RIGID rotation — pairwise distances between any two
    // points are preserved (the tenon keeps its exact shape, no shear).
    #[test]
    fn tilt_preserves_body_shape() {
        let dims = FrustumDims::from_width_depth(5.0, 6.0);
        let tilt = TenonTilt::new(40.0_f32.to_radians(), 0.4);
        let lean = LeanXform::for_build(&tilt, TENON_MAX_TILT_RAD, 4.0);
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

    // Test 11b: a tilted tenon (tenon AND mortise) is watertight at a range of angles —
    // the rigid lean + collar must not break the manifold. (The tenon/mortise SLIDE FIT
    // under lean is exercised end-to-end by the boolean in the real-pipeline tests;
    // here we pin the per-mesh watertightness, which is what manifold needs.)
    #[test]
    fn tilted_tenon_is_watertight() {
        let mem = flat_membrane(10.0);
        let frame =
            frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        for (deg, az, roll, fillet) in [
            (30.0_f32, 0.0_f32, 0.0_f32, 0.0_f32),
            (55.0, 1.2, 0.6, 0.0),
            (45.0, 2.5, 0.0, 0.7),
        ] {
            let tilt = TenonTilt::new(deg.to_radians(), roll);
            let dims = FrustumDims::from_width_depth(5.0, 5.0);
            let lean = LeanXform::for_build(&tilt, TENON_MAX_TILT_RAD, 4.0);
            let tenon = build_frustum_leaned(&frame, dims, 0.0, fillet, lean);
            // Match apply_frustum: when leaning, mortise uses the SAME fillet as the
            // tenon (dilated extents) so tenon/mortise share z-levels and nest per slab.
            let mortise = build_frustum_leaned(&frame, dims, 0.1, fillet, lean);
            let tenon_m = to_manifold(&tenon)
                .unwrap_or_else(|e| panic!("tilted tenon ({deg}°,{az},{roll}) watertight: {e}"));
            let mortise_m = to_manifold(&mortise)
                .unwrap_or_else(|e| panic!("tilted mortise ({deg}°) watertight: {e}"));
            assert!(tenon_m.num_tri() > 0 && mortise_m.num_tri() > 0, "non-empty");
            // Per-z-slab nesting: the tenon fits fully inside the grown mortise cavity.
            let leftover = tenon_m.difference(&mortise_m);
            assert!(
                leftover.is_empty() || leftover.num_tri() == 0,
                "tilted tenon ({deg}°) fits inside the mortise cavity (leftover = {})",
                leftover.num_tri()
            );
        }
    }

    // Test 11c: zero tilt is a TRUE no-op — the leaned build is byte-identical to the
    // plain build (so a tenon with no lean is exactly today's geometry).
    #[test]
    fn zero_tilt_is_identity() {
        let mem = flat_membrane(10.0);
        let frame =
            frame_extruding_toward_part_b(&frame_from_membrane(&mem).expect("frame"));
        let lean = LeanXform::for_build(&TenonTilt::default(), TENON_MAX_TILT_RAD, 0.0);
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

    // Test 11d: the full apply_tenon path with a tilt keeps both halves watertight and
    // still bonds the tenon (part_a gains tris) — end-to-end, not just the builder.
    #[test]
    fn apply_tenon_with_tilt_is_watertight() {
        // Roomy on purpose: this test is about the BOOLEANS surviving a lean, not
        // about the fit. A 40° lean swings the trunk well off the axis, and on a
        // 10mm slab that is a tenon which genuinely doesn't fit — `check_lean` would
        // (rightly) refuse it before any boolean ran.
        let model = axis_aligned_slab(Vec3::new(-30.0, -30.0, -10.0), Vec3::new(30.0, 30.0, 10.0));
        let part_a = axis_aligned_slab(Vec3::new(-30.0, -30.0, 0.0), Vec3::new(30.0, 30.0, 10.0));
        let part_b = axis_aligned_slab(Vec3::new(-30.0, -30.0, -10.0), Vec3::new(30.0, 30.0, 0.0));
        let mem = flat_membrane(60.0);
        let a_before = part_a.triangle_count();
        let tilt = TenonTilt::new(40.0_f32.to_radians(), 0.3);
        let out = apply_tenon(&model, part_a, part_b, &mem, TenonShape::Frustum, false, tilt, 4.0, 4.0, 0.0, 0.1, None);
        assert_eq!(out.kind, TenonKind::Frustum, "tilted tenon placed: {}", out.detail);
        assert!(out.part_a.triangle_count() > a_before, "tenon bonded to part_a");
        assert!(to_manifold(&out.part_a).is_ok(), "tilted part_a watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "tilted part_b watertight");
    }

    // Test 10: THE REAL PIPELINE — run an actual contour_split on a cube, then tenon
    // the parts it produces (NOT hand-built boxes). This reproduces exactly what
    // the production cut does, so it catches failures that the box-fixture tests
    // miss (e.g. the contour parts not re-importing cleanly to manifold).
    #[test]
    fn places_a_tenon_on_the_real_contour_split_parts() {
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
        // (If THIS fails, the tenon boolean can't possibly work — the parts are bad.)
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

        // Now tenon the REAL parts — clearance probes against the original `model`.
        let out = apply_tenon(&model, split.part_a, split.part_b, &split.membrane, TenonShape::Frustum, false, TenonTilt::default(), 5.0, 5.0, 0.0, 0.1, None);

        assert_eq!(
            out.kind,
            TenonKind::Frustum,
            "tenon placed on real contour parts (detail: {})",
            out.detail
        );
        assert!(
            out.part_a.triangle_count() != a_before,
            "part_a changed (tenon unioned): {} → {}",
            a_before,
            out.part_a.triangle_count()
        );
        assert!(
            out.part_b.triangle_count() != b_before,
            "part_b changed (mortise carved): {} → {}",
            b_before,
            out.part_b.triangle_count()
        );
        assert!(to_manifold(&out.part_a).is_ok(), "tenoned part_a watertight");
        assert!(to_manifold(&out.part_b).is_ok(), "tenoned part_b watertight");
    }
}
