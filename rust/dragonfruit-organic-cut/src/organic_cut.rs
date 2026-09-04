//! Organic cut — split a mesh into two parts along a user-drawn surface loop.
//!
//! The user draws a closed loop on the model surface; from it we build a cutter
//! and boolean-split the model into two printable parts (`part_a` / `part_b`).
//!
//! MILESTONE M2 (current): **trivial planar cut**. We derive a single cutting
//! plane from the loop (centroid + averaged normal) and split the model with
//! `manifold-csg`'s `split_by_plane`. This is not yet the contour-following
//! "wafer" (that is M4) — it is the simplest cut that actually divides the mesh,
//! so the full draw → split → two-parts → render pipeline runs end to end on the
//! production boolean engine. The wafer replaces the plane later without changing
//! this module's signature.
//!
//! If the `manifold` feature is off, or the loop is degenerate, or manifold
//! rejects the mesh, we fall back to the M1 no-op (both parts = source) so the
//! round-trip never hard-fails.

use serde::{Deserialize, Serialize};

use dragonfruit_mesh_core::mesh::{IndexedMesh, Vec3};

/// A single point on the user-drawn loop, in the model's local space.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganicCutLoopPoint {
    pub position: [f32; 3],
    #[serde(default)]
    pub normal: [f32; 3],
}

/// An explicit cutting plane `dot(normal, p) == offset`, in model-local space.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CutPlaneSpec {
    pub normal: [f32; 3],
    pub offset: f32,
}

/// Which kind of cut to perform.
///
/// - `Plane` (default): the flat planar cut (M2) — slices along a single plane.
/// - `Contour`: the curved "wafer" cut (M4) — builds a soap-film membrane that
///   follows the drawn loop and splits along that contoured seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CutMode {
    #[default]
    Plane,
    Contour,
}

/// Per-loop registration-tenon settings for a multi-loop cut. Each field mirrors the
/// spec-level `tenon_*` fields; an entry in [`OrganicCutSpec::loop_tenons`] overrides
/// them for ONE loop, so every cut can have its own tenon/mortise (shape, size, tilt,
/// swap) — or no tenon at all (`generate_tenon = false`). Defaults match the spec-level
/// defaults so a partial JSON object is safe.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopTenonSpec {
    #[serde(default)]
    pub generate_tenon: bool,
    #[serde(default = "default_tenon_width")]
    pub tenon_width_mm: f32,
    #[serde(default = "default_tenon_depth")]
    pub tenon_depth_mm: f32,
    #[serde(default = "default_tenon_shape")]
    pub tenon_shape: String,
    #[serde(default)]
    pub tenon_fillet_mm: f32,
    #[serde(default = "default_tenon_tolerance")]
    pub tenon_tolerance_mm: f32,
    #[serde(default)]
    pub tenon_anchor: Option<[f32; 3]>,
    #[serde(default)]
    pub tenon_swap_sides: bool,
    #[serde(default)]
    pub tenon_tilt_rad: f32,
    #[serde(default)]
    pub tenon_roll_rad: f32,
}

/// One organic cut: a closed loop plus the wafer parameters.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganicCutSpec {
    /// Closed loop of surface points (last connects back to first).
    #[serde(default)]
    pub loop_points: Vec<OrganicCutLoopPoint>,
    /// Additional closed loops cut in the SAME operation (contour mode only). Each
    /// loop becomes its own membrane+slab; all slabs (plus `loop_points`) are
    /// union'd into ONE cutter and differenced once, so a body that connects in
    /// several places — e.g. a tail joined to the body at two posts with an air
    /// tunnel between them — is freed in a single cut. Each loop wraps only solid,
    /// so no membrane ever has to span the air gap (which is what produced the bad
    /// geometry with one big loop). Empty (default) = the classic single-loop cut.
    #[serde(default)]
    pub extra_loops: Vec<Vec<OrganicCutLoopPoint>>,
    /// Per-loop tenon settings, aligned with the cut's loops in order (`loop_points`
    /// is index 0, then `extra_loops` in order). When an entry is present it
    /// OVERRIDES the spec-level `tenon_*` fields for that loop — so each cut gets its
    /// own tenon/mortise (or none). A missing entry falls back to the spec-level
    /// `tenon_*` fields, so a single-loop cut without `loop_tenons` is unchanged.
    #[serde(default)]
    pub loop_tenons: Vec<LoopTenonSpec>,
    /// Wafer thickness in mm. Unused by the M2 planar cut.
    #[serde(default)]
    pub thickness_mm: f32,
    /// SEAM smoothing 0..1 — how much the cut line rounds through each waypoint.
    /// Defaults to 0.5 (the original behavior) when the field is absent.
    #[serde(default = "default_half")]
    pub smoothing: f32,
    /// MEMBRANE smoothing 0..1 — how smooth/taut the curved cutter surface is.
    /// Defaults to 0.5 (the original 60 relaxation passes) when absent.
    #[serde(default = "default_half")]
    pub membrane_smoothing: f32,
    /// Explicit cutting plane. When present AND mode is `Plane`, the cut uses
    /// THIS plane directly (the exact plane the frontend previewed), instead of
    /// deriving one from the points — guaranteeing preview == cut.
    #[serde(default)]
    pub plane: Option<CutPlaneSpec>,
    /// Flat (`plane`) vs curved (`contour`). Default `plane` for back-compat.
    #[serde(default)]
    pub mode: CutMode,
    /// Extra clearance in mm for the mortise-and-tenon joint, on top of the tenon's
    /// own tolerance. Zero — the default — means the two halves meet exactly, which
    /// is what the surface cut gives; raise it if a print needs slack to assemble.
    ///
    /// This used to be the cutter's thickness, and it used to be structural: the cut
    /// was a wafer that had to be thick enough to sever. It is not any more. The old
    /// `cutterThicknessMm` name is still read so captured dumps keep replaying.
    #[serde(default, alias = "cutterThicknessMm")]
    pub joint_clearance_mm: f32,
    /// Membrane density multiplier (>=1) — raises the cutter poly count for the
    /// CUT. 1.0 = default resolution. Clamped to 4 in `contour_split`.
    #[serde(default = "default_one")]
    pub density: f32,
    /// When true (and mode is `Contour`), generate a registration tenon: a tapered
    /// tenon union'd onto `part_a` and a matching mortise differenced from `part_b`,
    /// so the halves mortise together in one alignment. Defaults off (back-compat).
    #[serde(default)]
    pub generate_tenon: bool,
    /// Tenon base width in mm (model units are mm). The base length follows the fixed
    /// 1.25× proportion. Defaults to 5 mm when unset/<=0.
    #[serde(default = "default_tenon_width")]
    pub tenon_width_mm: f32,
    /// Tenon depth in mm — how far the tenon pokes into the body. Defaults to 5 mm.
    #[serde(default = "default_tenon_depth")]
    pub tenon_depth_mm: f32,
    /// Requested tenon shape: `"frustum"` (default, rotation-locking) or `"dome"`
    /// (round half-sphere). Unknown / absent → frustum.
    #[serde(default = "default_tenon_shape")]
    pub tenon_shape: String,
    /// Edge fillet radius in mm — rounds the frustum's vertical corners + tip.
    /// 0 = sharp box. Ignored by the dome. Defaults to 0.
    #[serde(default)]
    pub tenon_fillet_mm: f32,
    /// Tenon/mortise fit tolerance in mm: the mortise is carved this much larger than
    /// the tenon on every face, so the halves slide together instead of jamming.
    /// 0 = press fit. Defaults to 0.1 mm (a print-scale slide fit).
    #[serde(default = "default_tenon_tolerance")]
    pub tenon_tolerance_mm: f32,
    /// Where the tenon sits on the cut face: the point (model-local) the user put
    /// the crosshair on. `None` = the natural middle of the cut.
    #[serde(default)]
    pub tenon_anchor: Option<[f32; 3]>,
    /// Flip which half gets the tenon vs the mortise. Default false: tenon on `part_a`
    /// (the membrane's +normal side), mortise carved from `part_b`. True swaps them.
    #[serde(default)]
    pub tenon_swap_sides: bool,
    /// Tenon tilt (radians): polar angle the tenon leans OFF the cut normal. 0 = straight
    /// out (default). The base stays glued flat to the cut face — the body shears to
    /// lean (it does not rigidly rotate). Clamped to ~60°.
    #[serde(default)]
    pub tenon_tilt_rad: f32,
    /// Tenon roll (radians): spin of the tenon about its own axis — orients the
    /// rectangle / oblong dome footprint. Default 0.
    #[serde(default)]
    pub tenon_roll_rad: f32,
}

/// serde defaults for the tenon size (mm). Literals (not `crate::tenon::` constants)
/// so this compiles with the `manifold` feature OFF too — the tenon module is gated,
/// but the spec field isn't. Kept in sync with `tenon::DEFAULT_TENON_*_MM`.
fn default_tenon_width() -> f32 {
    2.0
}
fn default_tenon_depth() -> f32 {
    2.5
}
fn default_tenon_shape() -> String {
    "frustum".to_string()
}
/// serde default for the tenon/mortise fit tolerance (mm). A literal for the same
/// reason as the sizes above; kept in sync with `tenon::DEFAULT_TENON_TOLERANCE_MM`.
/// Note this is NOT `#[serde(default)]` (0 would mean a press fit, not "unset").
fn default_tenon_tolerance() -> f32 {
    0.1
}

/// serde default for the 0..1 smoothing fields (0.5 = original behavior).
fn default_half() -> f32 {
    0.5
}

/// serde default for the density multiplier (1.0 = default resolution).
fn default_one() -> f32 {
    1.0
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganicCutOptions {
    #[serde(default)]
    pub cut: OrganicCutSpec,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganicCutReport {
    pub source_triangle_count: usize,
    pub part_a_triangle_count: usize,
    pub part_b_triangle_count: usize,
    /// Which backend produced the result: `"plane"`, or `"noop"` on fallback.
    pub engine: String,
    /// Human-readable detail of WHY we fell back (for diagnostics). Empty on success.
    #[serde(default)]
    pub detail: String,
    /// Which kind of registration tenon was placed: `"frustum"`, `"dome"`, or
    /// `"none"`. `"none"` both when no tenon was requested AND when the part was too
    /// thin for any tenon (distinguish via `tenon_detail`). Always present.
    #[serde(default)]
    pub tenon_kind: String,
    /// Human-readable reason the tenon fell back / was skipped (for the user alert).
    /// Empty when a nominal tenon was placed or no tenon was requested.
    #[serde(default)]
    pub tenon_detail: String,
    /// How many separate parts the cut produced (= `OrganicCutOutcome::parts.len()`).
    /// A multi-loop cut that frees several pieces (e.g. both of Squirtle's arms) is
    /// >2; a plane/single-loop cut is 2; a no-op is 0/1. The frontend reads exactly
    /// this many parts back and commits each as its own model.
    #[serde(default)]
    pub part_count: usize,
    /// Where the cut went wrong, in model coordinates. Empty on success and whenever
    /// the failure has no one place — but when it does have one, a coordinate in a
    /// sentence is useless to a person looking at a model, so these are meant to be
    /// DRAWN. The seam leaving a gap, or crossing itself, is one spot the user has to
    /// find and nudge; a rim nothing can span is a whole ring worth showing.
    #[serde(default)]
    pub leak_points: Vec<[f32; 3]>,
}

/// Result of an organic cut: the resulting parts plus a report.
///
/// `parts` is the ORDERED list of every separate solid the cut produced (largest
/// first) — 2 for a plane/single-loop cut, more when a multi-loop cut frees several
/// pieces (e.g. both of Squirtle's arms), empty on a no-op. It's the single source
/// of truth: the caller commits each entry as its own model.
pub struct OrganicCutOutcome {
    pub parts: Vec<IndexedMesh>,
    pub report: OrganicCutReport,
}

/// A cutting plane `dot(normal, p) == offset`, derived from the drawn loop.
struct CutPlane {
    normal: Vec3,
    offset: f32,
    /// A representative point the plane passes through (loop centroid/midpoint).
    /// Kept for diagnostics and future use (e.g. positioning a cutter); not read
    /// by the current split math.
    #[allow(dead_code)]
    point: Vec3,
}

/// Derives a single cutting plane from the clicked points.
///
/// INTERIM (pre-geodesic-loop):
/// - **2 points** → the simplest flat cut: the plane's normal is the direction
///   from the first point to the second, and it passes through their midpoint.
///   Click one side, click the other → the blade slices perpendicular between
///   them. This is the dead-simple "establish a plane" case.
/// - **3+ points** → best-fit plane (centroid + PCA least-variance normal),
///   robust to scattered, non-looping, near-collinear input.
///
/// Returns `None` only when there are <2 points or the points are degenerate
/// (coincident / collinear with no definable plane).
fn plane_from_loop(points: &[OrganicCutLoopPoint]) -> Option<CutPlane> {
    if points.len() < 2 {
        return None;
    }

    if points.len() == 2 {
        let a = Vec3::new(points[0].position[0], points[0].position[1], points[0].position[2]);
        let b = Vec3::new(points[1].position[0], points[1].position[1], points[1].position[2]);
        let dir = b.sub(a);
        let len = dir.length();
        if len < 1e-6 {
            return None; // coincident clicks
        }
        let line = dir.scale(1.0 / len);

        // The cut should FOLLOW the line the user drew (the plane CONTAINS the
        // A->B line) and go straight down — i.e. the plane also contains the
        // world up-axis. So the plane normal is perpendicular to BOTH the drawn
        // line and "up": normal = line × up. This makes a vertical sheet running
        // along the drawn line (intuitive: draw where the seam goes, it slices
        // down through it) — NOT a plane perpendicular to the line.
        //
        // NOTE: the model here has identity rotation, so local +Z == world up.
        // When rotated-model support lands, the frontend will pass world-up
        // expressed in local space instead of this hardcoded Z.
        let up = Vec3::new(0.0, 0.0, 1.0);
        let mut normal = line.cross(up);
        if normal.length() < 1e-4 {
            // The drawn line is ~vertical; fall back to crossing with world-Y so
            // we still get a well-defined vertical-ish plane.
            normal = line.cross(Vec3::new(0.0, 1.0, 0.0));
        }
        let nlen = normal.length();
        if nlen < 1e-6 {
            return None;
        }
        let normal = normal.scale(1.0 / nlen);
        let midpoint = a.add(b).scale(0.5);
        return Some(CutPlane {
            normal,
            offset: normal.dot(midpoint),
            point: midpoint,
        });
    }

    let mut centroid = Vec3::ZERO;
    for p in points {
        centroid = centroid.add(Vec3::new(p.position[0], p.position[1], p.position[2]));
    }
    let inv = 1.0 / points.len() as f32;
    centroid = centroid.scale(inv);

    let normal = best_fit_plane_normal(points, centroid)?;

    Some(CutPlane {
        normal,
        offset: normal.dot(centroid),
        point: centroid,
    })
}

/// Best-fit plane normal via the covariance matrix of the points: the normal is
/// the eigenvector of the smallest eigenvalue (the direction of least spread).
/// Robust for any 3+ points that aren't (nearly) collinear. Returns `None` if
/// the points are degenerate (collinear / coincident).
fn best_fit_plane_normal(points: &[OrganicCutLoopPoint], centroid: Vec3) -> Option<Vec3> {
    // Accumulate the 3x3 covariance matrix (symmetric).
    let (mut xx, mut xy, mut xz, mut yy, mut yz, mut zz) = (0.0f64, 0.0, 0.0, 0.0, 0.0, 0.0);
    for p in points {
        let dx = (p.position[0] - centroid.x) as f64;
        let dy = (p.position[1] - centroid.y) as f64;
        let dz = (p.position[2] - centroid.z) as f64;
        xx += dx * dx;
        xy += dx * dy;
        xz += dx * dz;
        yy += dy * dy;
        yz += dy * dz;
        zz += dz * dz;
    }

    // Find the smallest-eigenvalue eigenvector by inverse power iteration is
    // overkill here; instead use the classic "largest cross product of the
    // covariance rows" trick which directly yields the plane normal.
    // (See Emil Ernerfeldt's plane-fitting note.)
    let det_x = yy * zz - yz * yz;
    let det_y = xx * zz - xz * xz;
    let det_z = xx * yy - xy * xy;
    let det_max = det_x.max(det_y).max(det_z);

    if det_max <= 1e-12 {
        // Points are collinear or coincident — no plane.
        return None;
    }

    let normal = if det_max == det_x {
        Vec3::new(det_x as f32, (xz * yz - xy * zz) as f32, (xy * yz - xz * yy) as f32)
    } else if det_max == det_y {
        Vec3::new((xz * yz - xy * zz) as f32, det_y as f32, (xy * xz - yz * xx) as f32)
    } else {
        Vec3::new((xy * yz - xz * yy) as f32, (xy * xz - yz * xx) as f32, det_z as f32)
    };

    let len = normal.length();
    if len < 1e-9 {
        return None;
    }
    Some(normal.scale(1.0 / len))
}

fn noop_outcome(mesh: IndexedMesh, detail: String, leak_points: Vec<[f32; 3]>) -> OrganicCutOutcome {
    let source_triangle_count = mesh.triangle_count();
    let report = OrganicCutReport {
        source_triangle_count,
        part_a_triangle_count: source_triangle_count,
        part_b_triangle_count: source_triangle_count,
        engine: "noop".to_string(),
        detail,
        tenon_kind: "none".to_string(),
        tenon_detail: String::new(),
        // A no-op didn't split anything — no parts to commit (the frontend skips
        // committing on engine == "noop" anyway).
        part_count: 0,
        leak_points,
    };
    OrganicCutOutcome {
        parts: Vec::new(),
        report,
    }
}

/// Splits `mesh` into two parts using the drawn loop.
///
/// M2: derives a plane from the loop and splits with manifold. Falls back to the
/// no-op (both parts = source) on any failure or when the `manifold` feature is
/// disabled. The fallback `detail` explains WHY, so the frontend can surface it.
pub fn organic_cut(mesh: IndexedMesh, options: &OrganicCutOptions) -> OrganicCutOutcome {
    #[cfg(feature = "manifold")]
    {
        // Contour mode: try the curved membrane cut first.
        if options.cut.mode == CutMode::Contour {
            match organic_cut_contour(&mesh, options) {
                Ok(outcome) => return outcome,
                Err(reason) => {
                    // A contour cut NEVER falls back to a plane.
                    //
                    // The membrane IS the cut surface — it is what the user drew,
                    // and it is bounded by their seam, so a contour cut cannot reach
                    // outside it. A plane fitted to the same loop is infinite: it
                    // slices clean across the whole body. And because the PREVIEW
                    // never falls back, what they saw was a membrane over their seam
                    // and what they got was a guillotine through the model, with the
                    // seam and the tenon left stuck to whatever scrap came off.
                    //
                    // So refuse, hand back the reason, and leave the mesh alone.
                    return noop_outcome(mesh, reason.why, reason.at);
                }
            }
        }

        match organic_cut_plane(&mesh, options) {
            Ok(outcome) => return outcome,
            Err(reason) => {
                eprintln!("[dragonfruit-mesh-repair] organic cut fell back: {reason}");
                return noop_outcome(mesh, reason, Vec::new());
            }
        }
    }
    #[allow(unreachable_code)]
    {
        let _ = options;
        noop_outcome(mesh, "manifold feature disabled".to_string(), Vec::new())
    }
}

/// A loop's registration-tenon settings, resolved from either the per-loop override
/// ([`OrganicCutSpec::loop_tenons`]) or the spec-level `tenon_*` fallback — already
/// parsed into the `tenon` module's types so the cut path can use them directly.
#[cfg(feature = "manifold")]
struct ResolvedTenon {
    generate: bool,
    width: f32,
    depth: f32,
    shape: crate::tenon::TenonShape,
    fillet: f32,
    tolerance: f32,
    at: crate::tenon::TenonAnchor,
    swap: bool,
    tilt: crate::tenon::TenonTilt,
}

/// Resolve loop `i`'s tenon: prefer its `loop_tenons` entry, else the spec-level fields.
#[cfg(feature = "manifold")]
fn resolve_loop_tenon(spec: &OrganicCutSpec, i: usize) -> ResolvedTenon {
    match spec.loop_tenons.get(i) {
        Some(k) => ResolvedTenon {
            generate: k.generate_tenon,
            width: k.tenon_width_mm,
            depth: k.tenon_depth_mm,
            shape: crate::tenon::TenonShape::from_str_or_default(&k.tenon_shape),
            fillet: k.tenon_fillet_mm,
            tolerance: k.tenon_tolerance_mm,
            at: k.tenon_anchor.map(|p| Vec3::new(p[0], p[1], p[2])),
            swap: k.tenon_swap_sides,
            tilt: crate::tenon::TenonTilt::new(k.tenon_tilt_rad, k.tenon_roll_rad),
        },
        None => ResolvedTenon {
            generate: spec.generate_tenon,
            width: spec.tenon_width_mm,
            depth: spec.tenon_depth_mm,
            shape: crate::tenon::TenonShape::from_str_or_default(&spec.tenon_shape),
            fillet: spec.tenon_fillet_mm,
            tolerance: spec.tenon_tolerance_mm,
            at: spec.tenon_anchor.map(|p| Vec3::new(p[0], p[1], p[2])),
            swap: spec.tenon_swap_sides,
            tilt: crate::tenon::TenonTilt::new(spec.tenon_tilt_rad, spec.tenon_roll_rad),
        },
    }
}

#[cfg(feature = "manifold")]
fn distance_to_segment(p: Vec3, a: Vec3, b: Vec3) -> f32 {
    let ab = b.sub(a);
    let len2 = ab.dot(ab);
    if len2 < 1e-18 {
        return p.sub(a).length();
    }
    let t = (p.sub(a).dot(ab) / len2).clamp(0.0, 1.0);
    p.sub(a.add(ab.scale(t))).length()
}

/// Which drawn seam a cap belongs to: the one its rim sits on. Rims come out of the
/// cut in the order the surface was walked, which is no order at all, and a cut with
/// a clearance has two per seam — so the pairing is measured rather than counted.
#[cfg(feature = "manifold")]
fn nearest_seam(cap: &crate::membrane::Membrane, loops: &[Vec<Vec3>]) -> usize {
    let sample: Vec<Vec3> = cap
        .boundary
        .iter()
        .step_by((cap.boundary.len() / 16).max(1))
        .map(|&b| cap.vertices[b as usize])
        .collect();
    let cost = |lp: &Vec<Vec3>| -> f32 {
        sample
            .iter()
            .map(|p| {
                (0..lp.len())
                    .map(|k| distance_to_segment(*p, lp[k], lp[(k + 1) % lp.len()]))
                    .fold(f32::INFINITY, f32::min)
            })
            .sum()
    };
    loops
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| cost(a).partial_cmp(&cost(b)).unwrap_or(std::cmp::Ordering::Equal))
        .map_or(0, |(i, _)| i)
}

/// A cut that refused, and where. `at` is empty when the failure has no one place.
#[cfg(feature = "manifold")]
pub struct CutRefusal {
    pub why: String,
    pub at: Vec<[f32; 3]>,
}

/// Both ways of cutting refused, so the user hears both reasons. The surface cut's is
/// first because it is the one that answers "could this cut ever work" — a seam that
/// does not separate the surface cannot be cut by any cutter, and the wafer's own
/// complaint about the same seam is a symptom.
#[cfg(feature = "manifold")]
fn both_gave_up(surface: &str, wafer: &str) -> String {
    if surface.is_empty() {
        return wafer.to_string();
    }
    format!("{surface}; and the wafer could not either: {wafer}")
}

/// Cut by splitting the model's SURFACE along the seams and closing each piece with
/// the membrane as its lid.
///
/// This is the contour cut proper, and the wafer below is only what happens when it
/// cannot. Nothing here is reconstructed after the fact: the seam becomes mesh edges,
/// the pieces are what the surface falls into, and each lid is sewn to the cut's own
/// edge chain with the winding reversed on the far side, so the two mate exactly and
/// the kerf is zero. `Err` means the caller should try the wafer — a torn or holed
/// skin lets the flood fill leak from one side to the other, and the boolean is the
/// more forgiving of the two there.
///
/// The pieces the seam never touched — the loose flakes a real STL ships — are folded
/// into the body rather than handed back. Handing them over as freed pieces is the
/// oldest bug in this file.
#[cfg(feature = "manifold")]
fn contour_cut_by_surface(
    mesh: &IndexedMesh,
    options: &OrganicCutOptions,
    loops: &[Vec<Vec3>],
    loop_tenons: &[ResolvedTenon],
    // Filled with the places the cut went wrong, so the caller can DRAW them. A
    // coordinate in a sentence is no use to someone looking at a model.
    leaks: &mut Vec<[f32; 3]>,
) -> Result<OrganicCutOutcome, String> {
    // Joint clearance: a real gap between the two halves, so glue has somewhere to go
    // and the assembled model comes out the size it started. There is nothing between
    // the halves to widen — they share their cut face — so the gap is made by cutting
    // along the seam moved BOTH ways, half the clearance each, and throwing away the
    // strip of skin in between.
    let clearance = options.cut.joint_clearance_mm.max(0.0);
    let seams: Vec<Vec<Vec3>> = if clearance > 0.0 {
        loops
            .iter()
            .flat_map(|l| {
                [
                    crate::surface_split::offset_seam(mesh, l, -clearance * 0.5),
                    crate::surface_split::offset_seam(mesh, l, clearance * 0.5),
                ]
            })
            .collect()
    } else {
        loops.to_vec()
    };

    let mut split = crate::surface_split::split_along_seams(mesh, &seams)?;
    // The two seams of one clearance were made 0.1 mm apart; where they run through
    // the same triangle they leave shavings of the strip walled off on their own, and
    // one shaving of a single face refuses the whole cut. Fold them back in before
    // anything is measured.
    if clearance > 0.0 {
        let pairs: Vec<(usize, usize)> = (0..loops.len()).map(|s| (2 * s, 2 * s + 1)).collect();
        split.dissolve_clearance_debris(&pairs);
    }
    let split = split;

    // A closed curve on a closed surface separates it into exactly two, so `n` seams
    // can leave at most `n` pieces more than the surface arrived in. This is a
    // theorem, not a tolerance — and when the count comes out far over it, the split
    // did not cut the model, it shattered it. That is worth refusing on the spot:
    // capping sixty pieces is minutes of work to produce sixty models, most of them
    // a single triangle, in place of the one the user asked for.
    let arrived = shell_count(mesh);
    let pieces_now = split.piece_of_face.iter().copied().collect::<std::collections::BTreeSet<_>>().len();
    if pieces_now > arrived + seams.len() {
        return Err(format!(
            "the cut shattered the surface: {} seams over {arrived} shell{} can leave at \
             most {} pieces and this left {pieces_now}. Somewhere the seam is running \
             along the mesh's own edges instead of across them. Redraw that stretch so \
             it crosses the triangles.",
            seams.len(),
            if arrived == 1 { "" } else { "s" },
            arrived + seams.len(),
        ));
    }

    // The refusals below carry places, not just words: the wall's loose ends are
    // exactly where the two sides still hold on to each other, and they are handed
    // out so the caller can DRAW them. Only on refusal — a cut that succeeded with a
    // pinch in its clearance strip has nothing to warn about.
    let density = options.cut.density.clamp(1.0, 4.0) as f64;
    let closed = match crate::surface_cap::close_pieces(
        &split,
        crate::membrane::DEFAULT_GRID_DIVISIONS * density,
        options.cut.membrane_smoothing,
    ) {
        Ok(closed) => closed,
        Err(e) => {
            // The refusal names its own place, and that is what gets drawn. Falling
            // back to the wall's loose ends would mark somewhere else entirely.
            leaks.extend(e.at.iter().map(|p| [p.x, p.y, p.z]));
            return Err(e.why);
        }
    };
    if closed.caps.is_empty() {
        // Say WHERE, not just that. A wall that separates anything is a closed curve;
        // where it stops dead the fill simply walks round the end, and that one spot
        // is the whole reason the cut did nothing. Naming it in model coordinates is
        // the difference between "it failed" and something the user can go and look
        // at.
        let loose = split.loose_wall_ends();
        leaks.extend(loose.iter().map(|p| [p.x, p.y, p.z]));
        if loose.is_empty() {
            return Err(
                "the seams cut the surface but do not separate it — they do not enclose \
                 a piece"
                    .to_string(),
            );
        }
        // Count them and point at them; do NOT read out coordinates. A number like
        // (-59.6, -11.4, -131.2) in a sentence is not somewhere anyone can look —
        // the pins in the viewport are, and they are numbered to match this count.
        return Err(format!(
            "the cut does not close: the two sides still hold on to each other in {} \
             {}, pinned in the viewport. Nudge the seam across {} and cut again.",
            loose.len(),
            if loose.len() == 1 { "place" } else { "places" },
            if loose.len() == 1 { "it" } else { "them" },
        ));
    }

    let mut solids: Vec<IndexedMesh> = closed.solids;
    let capped: std::collections::BTreeSet<u32> =
        closed.cap_between.iter().flat_map(|&(a, b)| [a, b]).collect();

    // Which cap belongs to which seam is measured, not assumed: rims come out of the
    // cut in whatever order the surface was walked, and a cut with a clearance has
    // TWO of them per seam.
    let cap_seam: Vec<usize> = closed.caps.iter().map(|cap| nearest_seam(cap, loops)).collect();

    // The strip of skin between a seam's two offsets is the material the gap is made
    // of, and it goes in the bin. It is read off the wall — strip is what has BOTH of
    // that seam's offsets along its border in comparable measure, and nothing else
    // does — rather than measured or counted. No distance, which matters because a
    // drawn seam is a couple of dozen points and the strip can sit further from that
    // polyline than its own width; and no counting of rims, which held while a seam
    // had exactly two of them and broke the moment the two offsets tangled and
    // severed the strip into arcs. The arcs are all strip, and all of them go.
    let mut binned: std::collections::BTreeSet<u32> = Default::default();
    if clearance > 0.0 {
        for s in 0..loops.len() {
            binned.extend(split.strips_between(2 * s, 2 * s + 1));
        }
        // Binning it all leaves nothing. That is the seam going round a handle — a
        // part joined to the body somewhere else as well: the two offsets did not
        // free the piece the user drew round, they freed the sliver between
        // themselves, and the rest of the model stayed in one piece behind the
        // handle. Handing back a sliver instead of the model is the one outcome that
        // must never happen quietly.
        let pieces: std::collections::BTreeSet<u32> =
            split.piece_of_face.iter().copied().collect();
        if pieces.iter().filter(|p| !binned.contains(p)).count() < 2 {
            return Err(
                "the seam goes round a handle — a part joined to the body somewhere \
                 else as well — so cutting along it frees nothing but the strip the \
                 clearance is made of"
                    .to_string(),
            );
        }
    }

    if std::env::var_os("DF_CUT_DEBUG").is_some() {
        let mut size: std::collections::BTreeMap<u32, usize> = Default::default();
        for &p in &split.piece_of_face {
            *size.entry(p).or_default() += 1;
        }
        eprintln!(
            "[corte] piezas {size:?}, a la basura {binned:?}, tapas entre {:?}",
            closed.cap_between
        );
    }

    // One registration tenon per seam, framed on the cut face of the piece it stands
    // on — not on some surface between the two halves. That is what lets the gap cost
    // nothing: the tenon's base is already inside its own material whatever the
    // clearance is, so there is no sinking, no lengthening, and no kerf to reason
    // about. It simply crosses the gap and the mortise is carved wherever it lands.
    //
    let (mut tenon_kind, mut tenon_detail) = (crate::tenon::TenonKind::None, String::new());
    let requested = loop_tenons.iter().filter(|k| k.generate).count();
    let mut placed = 0usize;
    let mut skipped: Vec<String> = Vec::new();
    for (s, rk) in loop_tenons.iter().enumerate() {
        if !rk.generate {
            continue;
        }
        // The seam's own caps, and the pieces they face that are not the binned
        // strip. Without a clearance that is one cap and its two pieces; with one it
        // is two caps, each facing the strip on its other side.
        let mine: Vec<usize> = (0..closed.caps.len()).filter(|&c| cap_seam[c] == s).collect();
        let mut sides: Vec<u32> = mine
            .iter()
            .flat_map(|&c| [closed.cap_between[c].0, closed.cap_between[c].1])
            .filter(|p| !binned.contains(p))
            .collect();
        sides.sort_unstable();
        sides.dedup();
        // Frame the tenon on a cap that closes a KEPT piece — with a clearance, a
        // seam also has caps on the binned strip, and a frame on one of those would
        // stand the tenon on skin that is about to be thrown away.
        let cap_index =
            mine.iter().copied().find(|&c| !binned.contains(&closed.cap_between[c].0));
        let (Some(cap_index), [p, q]) = (cap_index, sides.as_slice()) else {
            skipped.push(format!("seam {}: no cut face to stand a tenon on", s + 1));
            continue;
        };
        let cap = &closed.caps[cap_index];
        let plus_first = crate::membrane::side_of_mesh(cap, &solids[*p as usize]) >= 0.0;
        let (ia, ib) =
            if plus_first { (*p as usize, *q as usize) } else { (*q as usize, *p as usize) };
        let tenoned = crate::tenon::apply_tenon(
            mesh,
            std::mem::take(&mut solids[ia]),
            std::mem::take(&mut solids[ib]),
            cap,
            rk.shape,
            rk.swap,
            rk.tilt,
            rk.width,
            rk.depth,
            rk.fillet,
            rk.tolerance,
            rk.at,
        );
        solids[ia] = tenoned.part_a;
        solids[ib] = tenoned.part_b;
        if tenoned.kind != crate::tenon::TenonKind::None {
            placed += 1;
            tenon_kind = tenoned.kind;
        } else if !tenoned.detail.is_empty() {
            skipped.push(format!("seam {}: {}", s + 1, tenoned.detail));
        }
    }
    if requested > 0 {
        tenon_detail = if placed == requested {
            String::new()
        } else if placed == 0 {
            tenon_kind = crate::tenon::TenonKind::None;
            format!("no tenons placed ({})", skipped.join("; "))
        } else {
            format!("{placed}/{requested} tenons placed ({})", skipped.join("; "))
        };
    }

    // Biggest piece first, then the freed ones; the untouched shells ride along with
    // whichever piece is biggest, which is where they came from.
    let mut parts: Vec<IndexedMesh> = Vec::with_capacity(solids.len());
    let mut orphans: Vec<IndexedMesh> = Vec::new();
    for (piece, solid) in solids.into_iter().enumerate() {
        let piece = piece as u32;
        if binned.contains(&piece) {
            continue; // the strip the clearance is made of
        }
        if capped.contains(&piece) {
            parts.push(solid);
        } else {
            orphans.push(solid);
        }
    }
    parts.sort_by(|a, b| b.triangles.len().cmp(&a.triangles.len()));
    let Some(body) = parts.first_mut() else {
        return Err("the cut left no piece with a cut face".to_string());
    };
    let orphan_tris: usize = orphans.iter().map(|o| o.triangle_count()).sum();
    for orphan in orphans {
        let base = body.positions.len() as u32;
        body.positions.extend(orphan.positions);
        body.triangles.extend(orphan.triangles.iter().map(|t| [t[0] + base, t[1] + base, t[2] + base]));
    }

    let part_b_tris: usize = parts.iter().skip(1).map(|p| p.triangle_count()).sum();
    let report = OrganicCutReport {
        source_triangle_count: mesh.triangle_count(),
        part_a_triangle_count: parts[0].triangle_count(),
        part_b_triangle_count: part_b_tris,
        engine: "surface".to_string(),
        detail: format!(
            "surface cut: {} seams, {} parts, {} cap tris, {orphan_tris} tris of loose shell kept with the body",
            loops.len(),
            parts.len(),
            closed.caps.iter().map(|c| c.triangles.len()).sum::<usize>(),
        ),
        tenon_kind: tenon_kind.as_str().to_string(),
        tenon_detail,
        part_count: parts.len(),
        leak_points: Vec::new(),
    };
    Ok(OrganicCutOutcome { parts, report })
}

/// How many connected shells a mesh arrives in, joined through shared vertices —
/// the baseline the piece count after a split is judged against. A model that comes
/// in as a body plus a stray splinter is two, and the split is not to blame for it.
fn shell_count(mesh: &IndexedMesh) -> usize {
    let mut parent: Vec<u32> = (0..mesh.positions.len() as u32).collect();
    fn find(parent: &mut Vec<u32>, mut v: u32) -> u32 {
        while parent[v as usize] != v {
            parent[v as usize] = parent[parent[v as usize] as usize];
            v = parent[v as usize];
        }
        v
    }
    for t in &mesh.triangles {
        for k in 1..3 {
            let (a, b) = (find(&mut parent, t[0]), find(&mut parent, t[k]));
            if a != b {
                parent[a as usize] = b;
            }
        }
    }
    let mut roots: ahash::AHashSet<u32> = Default::default();
    for t in &mesh.triangles {
        roots.insert(find(&mut parent, t[0]));
    }
    roots.len()
}

/// Curved "wafer" cut (M4): build a soap-film membrane following the drawn loop,
/// thicken it into a razor-thin cutter, and split the mesh into two mating parts.
/// Delegates the geometry to [`crate::membrane::contour_split`]; returns `Err`
/// (so the caller can fall back to the plane) on any failure.
#[cfg(feature = "manifold")]
fn organic_cut_contour(
    mesh: &IndexedMesh,
    options: &OrganicCutOptions,
) -> Result<OrganicCutOutcome, CutRefusal> {
    let source_triangle_count = mesh.triangle_count();

    // Gather every loop for this cut: the primary `loop_points` plus any
    // `extra_loops`. A loop needs >=3 distinct points to span a membrane; drop the
    // degenerate ones rather than failing the whole cut.
    let to_vec3 = |pts: &[OrganicCutLoopPoint]| -> Vec<Vec3> {
        pts.iter()
            .map(|p| Vec3::new(p.position[0], p.position[1], p.position[2]))
            .collect()
    };
    // Each kept loop carries its resolved tenon, kept aligned: `loop_points` is tenon
    // index 0, then `extra_loops` in order. Degenerate loops (<3 points) are dropped
    // along with their tenon, so `loops[i]` ↔ `loop_tenons[i]` stays 1:1.
    let mut loops: Vec<Vec<Vec3>> = Vec::new();
    let mut loop_tenons: Vec<ResolvedTenon> = Vec::new();
    {
        let primary = to_vec3(&options.cut.loop_points);
        if primary.len() >= 3 {
            loops.push(primary);
            loop_tenons.push(resolve_loop_tenon(&options.cut, 0));
        }
        for (j, extra) in options.cut.extra_loops.iter().enumerate() {
            let v = to_vec3(extra);
            if v.len() >= 3 {
                loops.push(v);
                loop_tenons.push(resolve_loop_tenon(&options.cut, j + 1));
            }
        }
    }
    if loops.is_empty() {
        return Err(CutRefusal {
            why: format!(
                "contour cut needs >=3 loop points (got {} primary + {} extra loops)",
                options.cut.loop_points.len(),
                options.cut.extra_loops.len()
            ),
            at: Vec::new(),
        });
    }

    // The SURFACE cut first: split the skin along the seam so the seam becomes mesh
    // edges, then close each piece with the membrane as its lid. No cutter, no kerf,
    // nothing to classify afterwards — see `docs/adr/0002-cut-the-surface-not-a-volume.md`.
    // The wafer stays behind it because the surface cut leans on a flood fill, and a
    // flood fill leaks through a hole in the skin, which the boolean forgives.
    let mut leaks: Vec<[f32; 3]> = Vec::new();
    let surface_gave_up = match contour_cut_by_surface(mesh, options, &loops, &loop_tenons, &mut leaks) {
        Ok(outcome) => return Ok(outcome),
        Err(why) => {
            if std::env::var_os("DF_CUT_DEBUG").is_some() {
                eprintln!("[cut] surface cut gave up, falling back to the wafer: {why}");
            }
            why
        }
    };

    // The wafer's slab thickness is its own business now, not a setting. It only ever
    // had two jobs — stay under print resolution, and be thick enough for the boolean
    // to resolve its two faces apart — and letting the user drive it was measured to
    // be no help at all: the same seam fails identically at 0.1, 0.3 and 0.5 mm.
    // Worse, the slab's thickness doubled as sideways reach across a fold, by
    // accident, which made a thicker cutter look like a cure. What the user asks for
    // is joint clearance, and that is spent on the joint.
    let thickness = crate::membrane::DEFAULT_CUTTER_THICKNESS_MM;
    let clearance = options.cut.joint_clearance_mm.max(0.0);

    // MULTI-LOOP: union a cutter per loop, difference once, group largest-vs-rest.
    if loops.len() >= 2 {
        let split = crate::membrane::contour_split_multi(
            mesh,
            &loops,
            thickness,
            options.cut.membrane_smoothing,
            options.cut.density,
        )
        .map_err(|why| CutRefusal { why: both_gave_up(&surface_gave_up, &why), at: leaks.clone() })?;
        let component_count = split.component_count;
        let membrane_tris = split.membrane_tris;
        let mut part_a = split.part_a;
        let mut part_b = split.part_b;
        let (mut tenon_kind, mut tenon_detail) = (crate::tenon::TenonKind::None, String::new());

        // One registration tenon PER cut, using each loop's OWN tenon settings
        // (`loop_tenons[i]`). A loop with `generate = false` gets no tenon. `apply_tenon`
        // wants the seam's +normal side as `part_a`; in a multi-loop cut the
        // body/tail aren't grouped by side, so classify each membrane and pass the
        // parts in the right order, then map the result back. A failed/too-thin tenon
        // at one seam never affects the others (apply_tenon returns parts unchanged).
        let requested = loop_tenons.iter().filter(|k| k.generate).count();
        if requested > 0 {
            let mut placed = 0usize;
            let mut skipped: Vec<String> = Vec::new();
            for (i, membrane) in split.membranes.iter().enumerate() {
                let rk = &loop_tenons[i];
                if !rk.generate {
                    continue;
                }
                // Whichever part is on this membrane's +normal side is `part_a`.
                let a_on_plus = crate::membrane::side_of_mesh(membrane, &part_a) >= 0.0;
                let (pa, pb) = if a_on_plus { (part_a, part_b) } else { (part_b, part_a) };
                let tenoned = crate::tenon::apply_tenon(
                    mesh,
                    pa,
                    pb,
                    membrane,
                    rk.shape,
                    rk.swap,
                    rk.tilt,
                    rk.width,
                    rk.depth,
                    rk.fillet,
                    rk.tolerance + clearance,
                    rk.at,
                );
                // Map the (+normal, −normal) result back to (body, freed) = (a, b).
                if a_on_plus {
                    part_a = tenoned.part_a;
                    part_b = tenoned.part_b;
                } else {
                    part_a = tenoned.part_b;
                    part_b = tenoned.part_a;
                }
                if tenoned.kind != crate::tenon::TenonKind::None {
                    placed += 1;
                    tenon_kind = tenoned.kind;
                } else if !tenoned.detail.is_empty() {
                    skipped.push(format!("loop {}: {}", i + 1, tenoned.detail));
                }
            }
            tenon_detail = if placed == requested {
                String::new()
            } else if placed == 0 {
                tenon_kind = crate::tenon::TenonKind::None;
                format!("no tenons placed ({})", skipped.join("; "))
            } else {
                format!("{placed}/{requested} tenons placed ({})", skipped.join("; "))
            };
        }

        // Split into the FINAL separate solids: the body is one part, and each freed
        // piece (e.g. each arm) is its own. `part_b` held them merged so the per-seam
        // tenon booleans could run locally; decompose it so every piece becomes its
        // own part. The BODY is deliberately left whole: it carries the shells the
        // cut never touched (loose flakes the model already had), and decomposing it
        // would hand each of them back to the user as a separate solid — which is
        // exactly how a 548-triangle flake kept turning up as a third piece.
        let mut parts: Vec<IndexedMesh> = vec![part_a];
        parts.extend(crate::membrane::decompose_components(&part_b));
        parts.sort_by(|a, b| b.triangles.len().cmp(&a.triangles.len()));

        // Report part-A/B triangle counts as "body" vs "everything else" for the
        // log; `part_count` carries the real number of pieces.
        let part_a_tris = parts.first().map(|p| p.triangle_count()).unwrap_or(0);
        let part_b_tris: usize = parts.iter().skip(1).map(|p| p.triangle_count()).sum();
        let report = OrganicCutReport {
            source_triangle_count,
            part_a_triangle_count: part_a_tris,
            part_b_triangle_count: part_b_tris,
            engine: "membrane".to_string(),
            detail: format!(
                "multi-loop wafer cut: {} loops, {} components, {} parts, membrane tris={} \
                 (the surface cut gave up first: {surface_gave_up})",
                loops.len(),
                component_count,
                parts.len(),
                membrane_tris
            ),
            tenon_kind: tenon_kind.as_str().to_string(),
            tenon_detail,
            part_count: parts.len(),
            leak_points: Vec::new(),
        };
        return Ok(OrganicCutOutcome { parts, report });
    }

    // SINGLE-LOOP: the classic curved cut, which also supports the registration tenon
    // (anchored on the one membrane) and the clean +/- side grouping.
    let loop_pts = &loops[0];
    let split = crate::membrane::contour_split(
        mesh,
        loop_pts,
        thickness,
        options.cut.membrane_smoothing,
        options.cut.density,
    )
    .map_err(|why| CutRefusal { why: both_gave_up(&surface_gave_up, &why), at: leaks.clone() })?;

    let membrane_tris = split.membrane_tris;
    let mut part_a = split.part_a;
    let mut part_b = split.part_b;
    let (mut tenon_kind, mut tenon_detail) = (crate::tenon::TenonKind::None, String::new());

    // Optional registration tenon: tenon union'd onto part_a, mortise carved from
    // part_b. Uses this loop's resolved tenon (`loop_tenons[0]` — the per-loop override
    // or the spec-level fallback). A failed/skipped tenon NEVER fails the cut —
    // `apply_tenon` returns the parts unchanged with `TenonKind::None` + a reason.
    let rk = &loop_tenons[0];
    if rk.generate {
        let tenoned = crate::tenon::apply_tenon(
            mesh,
            part_a,
            part_b,
            &split.membrane,
            rk.shape,
            rk.swap,
            rk.tilt,
            rk.width,
            rk.depth,
            rk.fillet,
            rk.tolerance + clearance,
            rk.at,
        );
        part_a = tenoned.part_a;
        part_b = tenoned.part_b;
        tenon_kind = tenoned.kind;
        tenon_detail = tenoned.detail;
    }

    // A single-loop cut is exactly two parts.
    let parts = vec![part_a, part_b];
    let report = OrganicCutReport {
        source_triangle_count,
        part_a_triangle_count: parts[0].triangle_count(),
        part_b_triangle_count: parts[1].triangle_count(),
        engine: "membrane".to_string(),
        detail: format!(
            "wafer cut: membrane tris={membrane_tris} \
             (the surface cut gave up first: {surface_gave_up})"
        ),
        tenon_kind: tenon_kind.as_str().to_string(),
        tenon_detail,
        part_count: parts.len(),
        leak_points: Vec::new(),
    };
    Ok(OrganicCutOutcome { parts, report })
}

#[cfg(feature = "manifold")]
fn organic_cut_plane(
    mesh: &IndexedMesh,
    options: &OrganicCutOptions,
) -> Result<OrganicCutOutcome, String> {
    use manifold_csg::Manifold;

    let source_triangle_count = mesh.triangle_count();

    // Prefer the explicit plane the frontend computed + previewed (so the cut is
    // exactly what the user saw). Fall back to deriving one from the points.
    let plane = match &options.cut.plane {
        Some(p) => {
            let n = Vec3::new(p.normal[0], p.normal[1], p.normal[2]);
            let nlen = n.length();
            if nlen < 1e-6 {
                return Err("explicit plane has a zero-length normal".to_string());
            }
            let normal = n.scale(1.0 / nlen);
            CutPlane {
                normal,
                offset: p.offset,
                // A representative point on the plane (normal * offset) for diagnostics.
                point: normal.scale(p.offset),
            }
        }
        None => plane_from_loop(&options.cut.loop_points).ok_or_else(|| {
            format!(
                "could not derive a plane from loop ({} points)",
                options.cut.loop_points.len()
            )
        })?,
    };

    let src_positions: Vec<f32> = mesh.positions.iter().flat_map(|v| [v.x, v.y, v.z]).collect();
    let src_indices: Vec<u32> = mesh.triangles.iter().flat_map(|t| *t).collect();

    let model = Manifold::from_mesh_f32(&src_positions, 3, &src_indices)
        .map_err(|err| format!("manifold rejected source mesh: {err:?} (tris={source_triangle_count})"))?;
    if model.is_empty() || model.num_tri() == 0 {
        return Err("source mesh produced an empty manifold (non-watertight?)".to_string());
    }

    let normal = [
        plane.normal.x as f64,
        plane.normal.y as f64,
        plane.normal.z as f64,
    ];
    let (first, second) = model.split_by_plane(normal, plane.offset as f64);

    let part_a = manifold_to_indexed(&first).ok_or("part A conversion failed")?;
    let part_b = manifold_to_indexed(&second).ok_or("part B conversion failed")?;

    // If either side is empty the plane missed the body — treat as no usable cut.
    if part_a.triangles.is_empty() || part_b.triangles.is_empty() {
        return Err(
            "The plane does not pass through the part. It grazes the surface instead of \
             crossing the body, so there is nothing on one side of it. Move the points so \
             the plane goes through what you want to separate."
                .to_string(),
        );
    }

    // Registration tenon, same as the contour cut — the frame comes from the plane
    // and the section it carves instead of from a membrane, and there is no kerf
    // to span (`split_by_plane` is a zero-thickness split, both halves meet ON the
    // plane). A tenon that doesn't fit never fails the cut.
    let rk = resolve_loop_tenon(&options.cut, 0);
    let mut tenon_kind = crate::tenon::TenonKind::None;
    let mut tenon_detail = String::new();
    let (mut part_a, mut part_b) = (part_a, part_b);
    if rk.generate {
        let axis = plane.normal;
        let (u, v) = crate::tenon::plane_basis(axis);
        let frames = tenon_frames_per_section(&part_a, &part_b, axis, plane.offset, u, v, rk.at);
        if frames.is_empty() {
            tenon_detail = "No tenon — the plane carves no usable cross-section.".to_string();
        }
        // One tenon per mating pair. `split_by_plane` hands back (+normal side,
        // −normal side) and the frame axis IS that +normal, so `first` is part_a.
        let (mut placed, mut skipped) = (0usize, Vec::new());
        for frame in &frames {
            let tenoned = crate::tenon::apply_tenon_at_frame(
                mesh,
                part_a,
                part_b,
                *frame,
                rk.shape,
                rk.swap,
                rk.tilt,
                rk.width,
                rk.depth,
                rk.fillet,
                rk.tolerance,
            );
            if tenoned.kind != crate::tenon::TenonKind::None {
                placed += 1;
                tenon_kind = tenoned.kind;
            } else if !tenoned.detail.is_empty() {
                skipped.push(tenoned.detail.clone());
            }
            part_a = tenoned.part_a;
            part_b = tenoned.part_b;
        }
        if !frames.is_empty() && placed < frames.len() {
            tenon_detail = if placed == 0 {
                format!("no tenons placed ({})", skipped.join("; "))
            } else {
                format!("{placed}/{} tenons placed ({})", frames.len(), skipped.join("; "))
            };
        }
    }

    // Hand back every SOLID the plane produced, not two bags of them. A plane
    // through a fork, a pair of legs or a curled tentacle meets the body in
    // several places, and each side of it then holds several disjoint lumps: merged
    // into one part they would arrive as a single model that cannot be arranged or
    // printed apart. Decomposed AFTER the tenon, so the tenon's boolean still runs
    // against whole sides. The +normal side leads, as before.
    let mut parts: Vec<IndexedMesh> = Vec::new();
    parts.extend(crate::membrane::decompose_components(&part_a));
    parts.extend(crate::membrane::decompose_components(&part_b));
    // `part_a`/`part_b` in the report keep their meaning: the leading solid, and
    // everything else the cut produced.
    let part_a_triangle_count = parts.first().map(|p| p.triangle_count()).unwrap_or(0);
    let part_b_triangle_count: usize = parts.iter().skip(1).map(|p| p.triangle_count()).sum();
    let detail = if parts.len() > 2 {
        format!("plane cut: {} solids (the plane crosses the body in more than one place)", parts.len())
    } else {
        String::new()
    };
    let report = OrganicCutReport {
        source_triangle_count,
        part_a_triangle_count,
        part_b_triangle_count,
        engine: "plane".to_string(),
        detail,
        tenon_kind: tenon_kind.as_str().to_string(),
        tenon_detail,
        part_count: parts.len(),
        leak_points: Vec::new(),
    };
    Ok(OrganicCutOutcome { parts, report })
}

/// Every separate cut FACE a side of the plane presents: one `(area, centroid)` per
/// connected patch of faces lying on the plane.
///
/// One tenon per cut face is the point, and the unit has to be the patch rather
/// than the solid. `plane_section` measures every section at once and hands back a
/// single centroid for all of them, which on a body the plane meets twice — a fork,
/// a pair of legs — lands in the air between them: the tenon's clearance probe then
/// finds no material and the cut comes out with no registration at all, silently.
/// Nor is one centroid per solid enough: the base of a U is ONE solid carrying TWO
/// cut faces, and averaging those two lands in the same empty air. Grouping the
/// on-plane faces into connected patches cannot land outside the material, needs no
/// ring-chaining, and gives every mating pair its own tenon.
#[cfg(feature = "manifold")]
fn cut_face_patches(part: &IndexedMesh, axis: Vec3, offset: f32) -> Vec<(f32, Vec3)> {
    // A face is ON the plane when all three of its vertices are, to within the
    // tolerance the boolean itself works to.
    let eps = 1e-3;
    let on_plane: Vec<u32> = part
        .triangles
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            t.iter()
                .all(|&i| (part.positions[i as usize].dot(axis) - offset).abs() <= eps)
        })
        .map(|(i, _)| i as u32)
        .collect();
    if on_plane.is_empty() {
        return Vec::new();
    }

    let mut edge_faces: ahash::AHashMap<(u32, u32), Vec<u32>> = ahash::AHashMap::new();
    for &fi in &on_plane {
        let t = &part.triangles[fi as usize];
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let key = if a < b { (a, b) } else { (b, a) };
            edge_faces.entry(key).or_default().push(fi);
        }
    }
    // Face by face, not by iterating the map — see `Topology::build` in surface_split.
    let mut neighbours: ahash::AHashMap<u32, Vec<u32>> = ahash::AHashMap::new();
    for &fi in &on_plane {
        let t = &part.triangles[fi as usize];
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            let key = if a < b { (a, b) } else { (b, a) };
            for &g in &edge_faces[&key] {
                if g != fi {
                    neighbours.entry(fi).or_default().push(g);
                }
            }
        }
    }

    let mut seen: ahash::AHashSet<u32> = ahash::AHashSet::new();
    let mut patches = Vec::new();
    for &start in &on_plane {
        if !seen.insert(start) {
            continue;
        }
        let (mut area2, mut centroid) = (0.0f32, Vec3::ZERO);
        let mut queue = std::collections::VecDeque::from([start]);
        while let Some(f) = queue.pop_front() {
            let t = &part.triangles[f as usize];
            let p = [
                part.positions[t[0] as usize],
                part.positions[t[1] as usize],
                part.positions[t[2] as usize],
            ];
            let a2 = p[1].sub(p[0]).cross(p[2].sub(p[0])).length();
            area2 += a2;
            centroid = centroid.add(p[0].add(p[1]).add(p[2]).scale(a2 / 3.0));
            for &n in neighbours.get(&f).map(|v| v.as_slice()).unwrap_or(&[]) {
                if seen.insert(n) {
                    queue.push_back(n);
                }
            }
        }
        if area2 > 1e-9 {
            patches.push((area2 * 0.5, centroid.scale(1.0 / area2)));
        }
    }
    patches
}

/// Pair each cut face on one side of the plane with the one it mates on the other,
/// and give every pair a tenon frame of its own.
///
/// `at` keeps its meaning: an explicit anchor picks the ONE pair whose cut face it
/// sits on, so a user placing the crosshair still gets exactly one tenon, where
/// they put it.
#[cfg(feature = "manifold")]
fn tenon_frames_per_section(
    part_a: &IndexedMesh,
    part_b: &IndexedMesh,
    axis: Vec3,
    offset: f32,
    u: Vec3,
    v: Vec3,
    at: crate::tenon::TenonAnchor,
) -> Vec<crate::tenon::TenonFrame> {
    let a_faces = cut_face_patches(part_a, axis, offset);
    let b_faces = cut_face_patches(part_b, axis, offset);

    let mut frames: Vec<crate::tenon::TenonFrame> = Vec::new();
    for (area, centroid) in a_faces {
        // The mating face is the one at the same place on the plane: a split leaves
        // the pair coincident.
        let mated = b_faces
            .iter()
            .any(|(_, c)| c.sub(centroid).length() <= area.sqrt().max(0.1));
        if mated {
            frames.push(crate::tenon::TenonFrame { anchor: centroid, axis, u, v, cut_area: area });
        }
    }
    match at {
        Some(p) => {
            let flat = p.sub(axis.scale(p.dot(axis) - offset));
            frames
                .into_iter()
                .min_by(|x, y| {
                    let dx = x.anchor.sub(flat).length();
                    let dy = y.anchor.sub(flat).length();
                    dx.partial_cmp(&dy).unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|f| vec![crate::tenon::TenonFrame { anchor: flat, ..f }])
                .unwrap_or_default()
        }
        None => frames,
    }
}

#[cfg(feature = "manifold")]
fn manifold_to_indexed(model: &manifold_csg::Manifold) -> Option<IndexedMesh> {
    if model.is_empty() || model.num_tri() == 0 {
        return Some(IndexedMesh {
            positions: Vec::new(),
            triangles: Vec::new(),
        });
    }
    let (vp, np, ti) = model.to_mesh_f32();
    if np < 3 || ti.is_empty() || vp.is_empty() {
        return None;
    }
    let positions: Vec<Vec3> = vp.chunks_exact(np).map(|c| Vec3::new(c[0], c[1], c[2])).collect();
    let triangles: Vec<[u32; 3]> = ti.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    Some(IndexedMesh {
        positions,
        triangles,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Axis-aligned cube [0,size]^3 as a raw triangle soup (12 tris).
    fn cube_soup(size: f32) -> Vec<f32> {
        let s = size;
        // 8 corners
        let c = [
            [0.0, 0.0, 0.0],
            [s, 0.0, 0.0],
            [s, s, 0.0],
            [0.0, s, 0.0],
            [0.0, 0.0, s],
            [s, 0.0, s],
            [s, s, s],
            [0.0, s, s],
        ];
        // 12 triangles (two per face), wound outward
        let faces = [
            [0, 2, 1],
            [0, 3, 2], // z=0
            [4, 5, 6],
            [4, 6, 7], // z=s
            [0, 1, 5],
            [0, 5, 4], // y=0
            [3, 7, 6],
            [3, 6, 2], // y=s
            [0, 4, 7],
            [0, 7, 3], // x=0
            [1, 2, 6],
            [1, 6, 5], // x=s
        ];
        let mut soup = Vec::with_capacity(12 * 9);
        for f in faces {
            for idx in f {
                soup.extend_from_slice(&c[idx]);
            }
        }
        soup
    }

    fn loop_on_plane_z(z: f32, size: f32) -> Vec<OrganicCutLoopPoint> {
        // A square loop at height z, normals pointing +Z (defines a horizontal
        // cutting plane through the cube).
        let s = size;
        [[0.0, 0.0], [s, 0.0], [s, s], [0.0, s]]
            .iter()
            .map(|p| OrganicCutLoopPoint {
                position: [p[0], p[1], z],
                normal: [0.0, 0.0, 1.0],
            })
            .collect()
    }

    #[test]
    fn plane_from_loop_uses_averaged_normal() {
        let pts = loop_on_plane_z(5.0, 10.0);
        let plane = plane_from_loop(&pts).expect("plane");
        assert!((plane.normal.z - 1.0).abs() < 1e-5);
        assert!((plane.offset - 5.0).abs() < 1e-4);
    }

    #[test]
    fn best_fit_plane_from_three_scattered_points() {
        // Three non-collinear points roughly in a tilted plane: the PCA fit
        // should produce a unit normal (interim "few rough clicks" path).
        let pts = vec![
            OrganicCutLoopPoint { position: [0.0, 0.0, 0.0], normal: [0.0; 3] },
            OrganicCutLoopPoint { position: [10.0, 0.0, 1.0], normal: [0.0; 3] },
            OrganicCutLoopPoint { position: [0.0, 10.0, 1.0], normal: [0.0; 3] },
        ];
        let plane = plane_from_loop(&pts).expect("plane from 3 scattered points");
        let nlen = (plane.normal.x * plane.normal.x
            + plane.normal.y * plane.normal.y
            + plane.normal.z * plane.normal.z)
            .sqrt();
        assert!((nlen - 1.0).abs() < 1e-4, "normal should be unit length");
    }

    #[test]
    fn collinear_points_have_no_plane() {
        // Points on a line have no well-defined plane → None → no-op fallback.
        let pts = vec![
            OrganicCutLoopPoint { position: [0.0, 0.0, 0.0], normal: [0.0; 3] },
            OrganicCutLoopPoint { position: [5.0, 0.0, 0.0], normal: [0.0; 3] },
            OrganicCutLoopPoint { position: [10.0, 0.0, 0.0], normal: [0.0; 3] },
        ];
        assert!(plane_from_loop(&pts).is_none());
    }

    #[test]
    fn two_points_cut_along_the_line_vertically() {
        // Line drawn along +X. The cut should FOLLOW the line and go vertically
        // (plane contains the X line and the Z up-axis), so its normal is
        // perpendicular to both: X × Z = (0,-1,0). The plane is the y=0 sheet.
        let pts = vec![
            OrganicCutLoopPoint { position: [-5.0, 0.0, 3.0], normal: [0.0; 3] },
            OrganicCutLoopPoint { position: [5.0, 0.0, 3.0], normal: [0.0; 3] },
        ];
        let plane = plane_from_loop(&pts).expect("plane from 2 points");
        // Normal is ±Y (vertical sheet running along the X line).
        assert!(plane.normal.x.abs() < 1e-5, "normal.x should be ~0");
        assert!((plane.normal.y.abs() - 1.0).abs() < 1e-5, "normal.y should be ~±1");
        assert!(plane.normal.z.abs() < 1e-5, "normal.z should be ~0");
        // Plane passes through the midpoint, which is at y=0.
        assert!(plane.offset.abs() < 1e-4, "offset should be ~0 (y=0 plane)");
    }

    #[test]
    fn one_point_has_no_plane() {
        let pts = vec![OrganicCutLoopPoint { position: [0.0; 3], normal: [0.0, 0.0, 1.0] }];
        assert!(plane_from_loop(&pts).is_none());
    }

    #[cfg(feature = "manifold")]
    #[test]
    fn cube_splits_into_two_nonempty_parts() {
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(10.0), 1e-6);
        let options = OrganicCutOptions {
            cut: OrganicCutSpec {
                loop_points: loop_on_plane_z(5.0, 10.0),
                thickness_mm: 0.0,
                smoothing: 0.0,
                plane: None,
                ..Default::default()
            },
        };
        let outcome = organic_cut(mesh, &options);
        assert_eq!(outcome.report.engine, "plane");
        assert!(outcome.parts[0].triangle_count() > 0, "part A empty 1");
        assert!(outcome.parts[1].triangle_count() > 0, "part B empty");
    }

    #[cfg(feature = "manifold")]
    #[test]
    fn cube_splits_by_explicit_plane() {
        // Explicit z=5 plane should split the [0,10]^3 cube into two parts,
        // ignoring loop_points entirely.
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(10.0), 1e-6);
        let options = OrganicCutOptions {
            cut: OrganicCutSpec {
                loop_points: vec![],
                thickness_mm: 0.0,
                smoothing: 0.0,
                plane: Some(CutPlaneSpec { normal: [0.0, 0.0, 1.0], offset: 5.0 }),
                ..Default::default()
            },
        };
        let outcome = organic_cut(mesh, &options);
        assert_eq!(outcome.report.engine, "plane");
        assert!(outcome.parts[0].triangle_count() > 0, "part A empty (explicit)");
        assert!(outcome.parts[1].triangle_count() > 0, "part B empty (explicit)");
    }

    #[cfg(feature = "manifold")]
    #[test]
    fn contour_mode_splits_cube_with_membrane_engine() {
        // Contour mode + a DENSE loop tracing the cube's equator (like a real
        // surface loop, not 4 points on hard edges) → membrane cut → two parts,
        // engine="membrane".
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(10.0), 1e-6);
        let steps = 8;
        let z = 5.0_f32;
        let f = |i: usize| 10.0_f32 * i as f32 / steps as f32;
        let mut loop_points = Vec::new();
        for i in 0..steps { loop_points.push(OrganicCutLoopPoint { position: [f(i), 0.0, z], normal: [0.0; 3] }); }
        for i in 0..steps { loop_points.push(OrganicCutLoopPoint { position: [10.0, f(i), z], normal: [0.0; 3] }); }
        for i in 0..steps { loop_points.push(OrganicCutLoopPoint { position: [10.0 - f(i), 10.0, z], normal: [0.0; 3] }); }
        for i in 0..steps { loop_points.push(OrganicCutLoopPoint { position: [0.0, 10.0 - f(i), z], normal: [0.0; 3] }); }
        let options = OrganicCutOptions {
            cut: OrganicCutSpec {
                loop_points,
                mode: CutMode::Contour,
                ..Default::default()
            },
        };
        let outcome = organic_cut(mesh, &options);
        assert_eq!(outcome.report.engine, "surface", "should use the surface engine");
        assert!(outcome.parts[0].triangle_count() > 0, "part A empty");
        assert!(outcome.parts[1].triangle_count() > 0, "part B empty");
    }

    // The plane section is what the flat cut anchors its tenon on, so it has to be
    // right: through the middle of a cube it is the full square face, centred.
    #[cfg(feature = "manifold")]
    #[test]
    fn plane_section_measures_the_cut_face() {
        let size = 30.0_f32;
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(size), 1e-6);
        let section = crate::membrane::plane_section(
            &mesh,
            Vec3::new(0.0, 0.0, 1.0),
            12.0,
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
        )
        .expect("the plane crosses the cube");
        assert!(
            (section.area - size * size).abs() < 1e-2,
            "full square face: {} vs {}",
            section.area,
            size * size,
        );
        for (got, want) in [(section.centroid.x, 15.0), (section.centroid.y, 15.0), (section.centroid.z, 12.0)] {
            assert!((got - want).abs() < 1e-3, "centroid on the plane's middle: {got} vs {want}");
        }
    }

    /// A U: a base with two legs standing on it, built with the boolean so it is one
    /// watertight solid. A horizontal plane through the legs meets the body TWICE.
    #[cfg(feature = "manifold")]
    fn u_shape() -> IndexedMesh {
        use crate::membrane::{axis_aligned_slab, to_manifold};
        let base = to_manifold(&axis_aligned_slab(Vec3::new(0.0, 0.0, 0.0), Vec3::new(30.0, 10.0, 5.0))).expect("base");
        let left = to_manifold(&axis_aligned_slab(Vec3::new(0.0, 0.0, 5.0), Vec3::new(8.0, 10.0, 25.0))).expect("left");
        let right = to_manifold(&axis_aligned_slab(Vec3::new(22.0, 0.0, 5.0), Vec3::new(30.0, 10.0, 25.0))).expect("right");
        manifold_to_indexed(&base.union(&left).union(&right)).expect("U")
    }

    // A plane crossing the body in more than one place used to hand back its lumps
    // MERGED into two parts: the two leg tops arrived as a single model that could
    // not be moved or printed apart. Every solid is now its own part.
    #[cfg(feature = "manifold")]
    #[test]
    fn a_plane_across_two_legs_hands_back_every_solid() {
        let mesh = u_shape();
        let options = OrganicCutOptions {
            cut: OrganicCutSpec {
                mode: CutMode::Plane,
                plane: Some(CutPlaneSpec { normal: [0.0, 0.0, 1.0], offset: 15.0 }),
                generate_tenon: false,
                ..Default::default()
            },
        };
        let outcome = organic_cut(mesh, &options);
        assert_eq!(outcome.report.engine, "plane");
        assert_eq!(
            outcome.report.part_count, 3,
            "two leg tops and the base, each its own solid: {}",
            outcome.report.detail,
        );
        assert_eq!(outcome.parts.len(), 3);
        let mut sizes: Vec<usize> = outcome.parts.iter().map(|p| p.triangle_count()).collect();
        sizes.sort_unstable();
        assert!(sizes[0] > 0 && sizes[2] > sizes[0], "the base is the biggest of the three: {sizes:?}");
    }

    // With two sections, the tenon used to be anchored on the centroid of BOTH of
    // them — a point in the air between the legs — so the clearance probe found no
    // material and the cut came out with no registration at all, silently. Each
    // mating pair now gets its own.
    #[cfg(feature = "manifold")]
    #[test]
    fn a_plane_across_two_legs_tenons_each_section() {
        let mesh = u_shape();
        let spec = |generate: bool| OrganicCutOptions {
            cut: OrganicCutSpec {
                mode: CutMode::Plane,
                plane: Some(CutPlaneSpec { normal: [0.0, 0.0, 1.0], offset: 15.0 }),
                generate_tenon: generate,
                tenon_width_mm: 3.0,
                tenon_depth_mm: 3.0,
                tenon_tolerance_mm: 0.1,
                tenon_anchor: None,
                ..Default::default()
            },
        };
        let plain = organic_cut(mesh.clone(), &spec(false));
        let tenoned = organic_cut(mesh, &spec(true));

        assert_eq!(tenoned.report.tenon_kind, "frustum", "{}", tenoned.report.tenon_detail);
        assert!(
            tenoned.report.tenon_detail.is_empty(),
            "both sections should be tenoned: {}",
            tenoned.report.tenon_detail,
        );
        assert_eq!(tenoned.report.part_count, plain.report.part_count, "the tenons must not add solids");
        let total = |o: &OrganicCutOutcome| o.parts.iter().map(|p| p.triangle_count()).sum::<usize>();
        assert!(
            total(&tenoned) > total(&plain),
            "two tenons and two mortises add geometry: {} vs {}",
            total(&tenoned),
            total(&plain),
        );
    }

    // A flat cut used to return `tenon_kind: "none"` unconditionally — the tenon was
    // wired to the contour path only. It now tenons off the plane's own section.
    #[cfg(feature = "manifold")]
    #[test]
    fn plane_cut_places_a_tenon() {
        let size = 30.0_f32;
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(size), 1e-6);
        let options = OrganicCutOptions {
            cut: OrganicCutSpec {
                loop_points: loop_on_plane_z(size * 0.5, size),
                mode: CutMode::Plane,
                generate_tenon: true,
                tenon_width_mm: 5.0,
                tenon_depth_mm: 5.0,
                tenon_tolerance_mm: 0.1,
                tenon_anchor: None,
                ..Default::default()
            },
        };
        let plain = organic_cut(mesh.clone(), &OrganicCutOptions {
            cut: OrganicCutSpec {
                loop_points: loop_on_plane_z(size * 0.5, size),
                mode: CutMode::Plane,
                ..Default::default()
            },
        });
        let tenoned = organic_cut(mesh, &options);
        assert_eq!(tenoned.report.engine, "plane", "still the plane engine");
        assert_eq!(tenoned.report.tenon_kind, "frustum", "tenon placed: {}", tenoned.report.tenon_detail);
        // The tenon is union'd onto one half and carved out of the other, so both
        // halves gain geometry over the same cut without a tenon.
        assert!(
            tenoned.parts[0].triangle_count() > plain.parts[0].triangle_count(),
            "part A gained the tenon",
        );
        assert!(
            tenoned.parts[1].triangle_count() > plain.parts[1].triangle_count(),
            "part B gained the mortise",
        );
    }

    #[cfg(feature = "manifold")]
    #[test]
    fn multi_loop_cut_places_a_tenon_per_seam() {
        // Two band loops through a tall bar, contour mode, generate_tenon on. Each
        // seam should get its own registration tenon (tenon + mortise), so the report
        // records a placed tenon and both parts gain geometry from the booleans.
        let size = 30.0_f32;
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(size), 1e-6);
        let band = |z: f32| -> Vec<OrganicCutLoopPoint> {
            let steps = 8usize;
            let f = |i: usize| size * i as f32 / steps as f32;
            let mut pts = Vec::new();
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [f(i), 0.0, z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [size, f(i), z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [size - f(i), size, z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [0.0, size - f(i), z], normal: [0.0; 3] }); }
            pts
        };
        let options = OrganicCutOptions {
            cut: OrganicCutSpec {
                loop_points: band(10.0),
                extra_loops: vec![band(20.0)],
                mode: CutMode::Contour,
                generate_tenon: true,
                tenon_width_mm: 3.0,
                tenon_depth_mm: 3.0,
                tenon_shape: "frustum".to_string(),
                ..Default::default()
            },
        };
        let outcome = organic_cut(mesh, &options);
        assert_eq!(outcome.report.engine, "surface", "should use the surface engine");
        assert_ne!(
            outcome.report.tenon_kind, "none",
            "expected a tenon placed per seam, tenon_detail={}",
            outcome.report.tenon_detail
        );
        assert!(outcome.parts[0].triangle_count() > 0, "part A empty");
        assert!(outcome.parts[1].triangle_count() > 0, "part B empty");
    }

    #[cfg(feature = "manifold")]
    #[test]
    fn multi_loop_cut_yields_one_part_per_freed_piece() {
        // The bug fix: two band cuts through a bar free THREE pieces (bottom /
        // middle / top). They must come back as three SEPARATE parts — not the body
        // plus one merged "everything else" mesh (which is what made Squirtle's two
        // arms a single part). No tenon, so geometry isn't perturbed.
        let size = 30.0_f32;
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(size), 1e-6);
        let band = |z: f32| -> Vec<OrganicCutLoopPoint> {
            let steps = 8usize;
            let f = |i: usize| size * i as f32 / steps as f32;
            let mut pts = Vec::new();
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [f(i), 0.0, z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [size, f(i), z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [size - f(i), size, z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [0.0, size - f(i), z], normal: [0.0; 3] }); }
            pts
        };
        let options = OrganicCutOptions {
            cut: OrganicCutSpec {
                loop_points: band(10.0),
                extra_loops: vec![band(20.0)],
                mode: CutMode::Contour,
                ..Default::default()
            },
        };
        let outcome = organic_cut(mesh, &options);
        assert_eq!(outcome.report.engine, "surface");
        assert_eq!(
            outcome.parts.len(),
            3,
            "two cuts across the bar should yield 3 separate parts, got {} (detail={})",
            outcome.parts.len(),
            outcome.report.detail
        );
        assert_eq!(outcome.report.part_count, 3);
        for (i, p) in outcome.parts.iter().enumerate() {
            assert!(p.triangle_count() > 0, "part {i} empty");
        }
    }

    // A ring round a HANDLE — a tentacle that leaves the body and fuses back — cannot
    // free anything, whatever it is cut with. Cut it with a joint clearance and the
    // two offsets DO free something: the sliver between themselves. Both of the
    // seam's rims then sit between the same two pieces, so "the piece the two rims
    // both face" stops naming one thing, and choosing either at random is a coin toss
    // whose other face bins the model and hands back the sliver. This is that case,
    // and the only right answer is to refuse.
    #[cfg(feature = "manifold")]
    #[test]
    fn a_ring_round_a_handle_never_hands_back_the_sliver_instead_of_the_model() {
        let (major, minor, around, tube) = (10.0_f32, 3.0_f32, 64usize, 32usize);
        let mut positions = Vec::new();
        for i in 0..around {
            let u = i as f32 / around as f32 * std::f32::consts::TAU;
            for j in 0..tube {
                let v = j as f32 / tube as f32 * std::f32::consts::TAU;
                let r = major + minor * v.cos();
                positions.push(Vec3::new(r * u.cos(), r * u.sin(), minor * v.sin()));
            }
        }
        let idx = |i: usize, j: usize| ((i % around) * tube + (j % tube)) as u32;
        let mut triangles = Vec::new();
        for i in 0..around {
            for j in 0..tube {
                triangles.push([idx(i, j), idx(i + 1, j), idx(i + 1, j + 1)]);
                triangles.push([idx(i, j), idx(i + 1, j + 1), idx(i, j + 1)]);
            }
        }
        let mesh = IndexedMesh { positions, triangles };
        let source = mesh.triangle_count();

        let ring: Vec<OrganicCutLoopPoint> = (0..96)
            .map(|j| {
                let v = j as f32 / 96.0 * std::f32::consts::TAU;
                let r = major + minor * v.cos();
                let (a, s) = (0.3_f32, minor * v.sin());
                OrganicCutLoopPoint { position: [r * a.cos(), r * a.sin(), s], normal: [0.0; 3] }
            })
            .collect();
        let outcome = organic_cut(
            mesh,
            &OrganicCutOptions {
                cut: OrganicCutSpec {
                    loop_points: ring,
                    mode: CutMode::Contour,
                    joint_clearance_mm: 0.3,
                    ..Default::default()
                },
            },
        );

        // Refusing is the right answer, and the reason has to name the handle. What is
        // NEVER allowed is succeeding with the sliver: a cut that hands back a fraction
        // of the model it was given has thrown the model away.
        assert_eq!(outcome.report.engine, "noop", "detail={}", outcome.report.detail);
        for part in &outcome.parts {
            assert!(
                part.triangle_count() * 4 > source,
                "a part of {} triangles came back from a model of {source} — the cut \
                 kept the sliver and binned the body",
                part.triangle_count(),
            );
        }
    }

    #[cfg(feature = "manifold")]
    #[test]
    fn per_loop_tenons_override_and_respect_generate_flag() {
        // Per-loop `loop_tenons`: prove (a) the override is read and (b) a loop with
        // generate=false really gets NO tenon. Tenoning only loop 0 must add less
        // geometry than tenoning BOTH loops (one fewer tenon+mortise boolean).
        let size = 30.0_f32;
        let band = |z: f32| -> Vec<OrganicCutLoopPoint> {
            let steps = 8usize;
            let f = |i: usize| size * i as f32 / steps as f32;
            let mut pts = Vec::new();
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [f(i), 0.0, z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [size, f(i), z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [size - f(i), size, z], normal: [0.0; 3] }); }
            for i in 0..steps { pts.push(OrganicCutLoopPoint { position: [0.0, size - f(i), z], normal: [0.0; 3] }); }
            pts
        };
        let mk_tenon = |generate: bool| LoopTenonSpec {
            generate_tenon: generate,
            tenon_width_mm: 3.0,
            tenon_depth_mm: 3.0,
            tenon_shape: "frustum".to_string(),
            tenon_fillet_mm: 0.0,
            tenon_tolerance_mm: 0.1,
            tenon_anchor: None,
            tenon_swap_sides: false,
            tenon_tilt_rad: 0.0,
            tenon_roll_rad: 0.0,
        };
        let run = |loop_tenons: Vec<LoopTenonSpec>| {
            let mesh = IndexedMesh::from_triangle_soup(&cube_soup(size), 1e-6);
            let options = OrganicCutOptions {
                cut: OrganicCutSpec {
                    loop_points: band(10.0),
                    extra_loops: vec![band(20.0)],
                    loop_tenons,
                    mode: CutMode::Contour,
                    // Spec-level generate_tenon stays OFF — only `loop_tenons` drive tenons
                    // here, proving the per-loop override is what's read.
                    ..Default::default()
                },
            };
            organic_cut(mesh, &options)
        };

        // Only loop 0 tenoned; loop 1 explicitly NOT tenoned.
        let one = run(vec![mk_tenon(true), mk_tenon(false)]);
        assert_eq!(one.report.engine, "surface");
        assert_ne!(one.report.tenon_kind, "none", "loop 0 should be tenoned: {}", one.report.tenon_detail);
        // Both loops tenoned.
        let two = run(vec![mk_tenon(true), mk_tenon(true)]);
        assert_ne!(two.report.tenon_kind, "none");

        let one_tris: usize = one.parts.iter().map(|p| p.triangle_count()).sum();
        let two_tris: usize = two.parts.iter().map(|p| p.triangle_count()).sum();
        assert!(
            two_tris > one_tris,
            "tenoning both loops ({two_tris} tris) should add more geometry than tenoning one ({one_tris}) \
             — loop 1's generate=false must be respected"
        );
    }

    #[cfg(feature = "manifold")]
    #[test]
    fn contour_mode_refuses_rather_than_cutting_outside_the_seam() {
        // A diamond loop through the four FACE CENTERS at z=5. The membrane spans
        // only the inner diamond, so the cube's corner prisms stay bridged and the
        // contour cut cannot sever.
        //
        // This used to fall back to the best-fit plane — z=5, straight through the
        // whole cube, corners and all. A contour cut must never reach outside the
        // seam the user drew, and the preview never falls back, so what they saw (a
        // membrane over the diamond) and what they got (a guillotine across the
        // body, with the seam and tenon stuck to the offcut) were different cuts.
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(10.0), 1e-6);
        let source_tris = mesh.triangles.len();
        let loop_points = vec![
            OrganicCutLoopPoint { position: [0.0, 5.0, 5.0], normal: [0.0; 3] },
            OrganicCutLoopPoint { position: [5.0, 0.0, 5.0], normal: [0.0; 3] },
            OrganicCutLoopPoint { position: [10.0, 5.0, 5.0], normal: [0.0; 3] },
            OrganicCutLoopPoint { position: [5.0, 10.0, 5.0], normal: [0.0; 3] },
        ];
        let options = OrganicCutOptions {
            cut: OrganicCutSpec {
                loop_points,
                mode: CutMode::Contour,
                ..Default::default()
            },
        };
        let outcome = organic_cut(mesh, &options);
        // The wafer could not sever this and refused, which was right FOR THE WAFER:
        // its membrane spans the flat inner diamond, so the corner prisms stay
        // bridged. The surface cut has no such limit — the seam becomes edges, and
        // the fill parts top from bottom — so severing here is a gain, not the
        // guillotine this test was written to catch. What still must hold is that
        // nothing is cut OUTSIDE the seam: the two halves add back up to the cube.
        assert_eq!(outcome.report.engine, "surface", "detail={}", outcome.report.detail);
        assert_eq!(outcome.parts.len(), 2, "the seam parts the cube in two");
        assert_eq!(
            outcome.report.source_triangle_count, source_tris,
            "and it reports the body it was given",
        );
        let whole = IndexedMesh::from_triangle_soup(&cube_soup(10.0), 1e-6).signed_volume();
        let parts: f64 = outcome.parts.iter().map(|p| p.signed_volume()).sum();
        assert!(
            (parts - whole).abs() < whole.abs() * 1e-3,
            "the pieces add up to the cube — nothing was cut outside the seam: {parts} vs {whole}",
        );
    }

    #[test]
    fn cut_mode_defaults_to_plane() {
        // serde: an OrganicCutSpec with no `mode` field deserializes to Plane.
        let spec: OrganicCutSpec = serde_json::from_str("{}").expect("empty spec");
        assert_eq!(spec.mode, CutMode::Plane);
        let spec2: OrganicCutSpec =
            serde_json::from_str(r#"{"mode":"contour"}"#).expect("contour spec");
        assert_eq!(spec2.mode, CutMode::Contour);
    }

    #[test]
    fn degenerate_loop_falls_back_to_noop() {
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(10.0), 1e-6);
        let src_tris = mesh.triangle_count();
        let options = OrganicCutOptions::default(); // empty loop
        let outcome = organic_cut(mesh, &options);
        assert_eq!(outcome.report.engine, "noop");
        // A no-op produces no parts (the frontend skips committing it); the source
        // size is still echoed in the report for diagnostics.
        assert!(outcome.parts.is_empty(), "no-op should produce no parts");
        assert_eq!(outcome.report.part_count, 0);
        assert_eq!(outcome.report.part_a_triangle_count, src_tris);
    }
}
