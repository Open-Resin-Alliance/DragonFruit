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

/// One organic cut: a closed loop plus the wafer parameters.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganicCutSpec {
    /// Closed loop of surface points (last connects back to first).
    #[serde(default)]
    pub loop_points: Vec<OrganicCutLoopPoint>,
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
    /// Contour cutter thickness in mm. Default ~0.01 (physically zero) when
    /// unset/<=0. Only used by the contour cut.
    #[serde(default)]
    pub cutter_thickness_mm: f32,
    /// Membrane density multiplier (>=1) — raises the cutter poly count for the
    /// CUT. 1.0 = default resolution. Clamped to 4 in `contour_split`.
    #[serde(default = "default_one")]
    pub density: f32,
    /// When true (and mode is `Contour`), generate a registration key: a tapered
    /// peg union'd onto `part_a` and a matching socket differenced from `part_b`,
    /// so the halves socket together in one alignment. Defaults off (back-compat).
    #[serde(default)]
    pub generate_key: bool,
    /// Key base width in mm (model units are mm). The base length follows the fixed
    /// 1.25× proportion. Defaults to 5 mm when unset/<=0.
    #[serde(default = "default_key_width")]
    pub key_width_mm: f32,
    /// Key depth in mm — how far the peg pokes into the body. Defaults to 5 mm.
    #[serde(default = "default_key_depth")]
    pub key_depth_mm: f32,
    /// Requested key shape: `"frustum"` (default, rotation-locking) or `"dome"`
    /// (round half-sphere). Unknown / absent → frustum.
    #[serde(default = "default_key_shape")]
    pub key_shape: String,
    /// Edge fillet radius in mm — rounds the frustum's vertical corners + tip.
    /// 0 = sharp box. Ignored by the dome. Defaults to 0.
    #[serde(default)]
    pub key_fillet_mm: f32,
    /// Flip which half gets the peg vs the socket. Default false: peg on `part_a`
    /// (the membrane's +normal side), socket carved from `part_b`. True swaps them.
    #[serde(default)]
    pub key_swap_sides: bool,
}

/// serde defaults for the key size (mm). Literals (not `crate::key::` constants)
/// so this compiles with the `manifold` feature OFF too — the key module is gated,
/// but the spec field isn't. Kept in sync with `key::DEFAULT_KEY_*_MM`.
fn default_key_width() -> f32 {
    2.0
}
fn default_key_depth() -> f32 {
    2.5
}
fn default_key_shape() -> String {
    "frustum".to_string()
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
    /// Which kind of registration key was placed: `"frustum"`, `"dome"`, or
    /// `"none"`. `"none"` both when no key was requested AND when the part was too
    /// thin for any key (distinguish via `key_detail`). Always present.
    #[serde(default)]
    pub key_kind: String,
    /// Human-readable reason the key fell back / was skipped (for the user alert).
    /// Empty when a nominal key was placed or no key was requested.
    #[serde(default)]
    pub key_detail: String,
}

/// Result of an organic cut: the two parts plus a report.
pub struct OrganicCutOutcome {
    pub part_a: IndexedMesh,
    pub part_b: IndexedMesh,
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

fn noop_outcome(mesh: IndexedMesh, detail: String) -> OrganicCutOutcome {
    let source_triangle_count = mesh.triangle_count();
    let part_a = mesh.clone();
    let part_b = mesh;
    let report = OrganicCutReport {
        source_triangle_count,
        part_a_triangle_count: part_a.triangle_count(),
        part_b_triangle_count: part_b.triangle_count(),
        engine: "noop".to_string(),
        detail,
        key_kind: "none".to_string(),
        key_detail: String::new(),
    };
    OrganicCutOutcome {
        part_a,
        part_b,
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
        // Contour mode: try the curved membrane cut first. On ANY failure (loop
        // doesn't wrap through the body, membrane invalid, etc.) fall back to the
        // flat plane cut so the user still gets *a* cut. The plane itself then
        // falls back to no-op if it also fails.
        if options.cut.mode == CutMode::Contour {
            match organic_cut_contour(&mesh, options) {
                Ok(outcome) => return outcome,
                Err(reason) => {
                    eprintln!("[dragonfruit-mesh-repair] contour cut fell back to plane: {reason}");
                    // Fall through to the plane path, preserving WHY in the detail.
                    return match organic_cut_plane(&mesh, options) {
                        Ok(mut outcome) => {
                            outcome.report.detail =
                                format!("contour fell back to plane: {reason}");
                            outcome
                        }
                        Err(plane_reason) => noop_outcome(
                            mesh,
                            format!("contour failed ({reason}); plane also failed ({plane_reason})"),
                        ),
                    };
                }
            }
        }

        match organic_cut_plane(&mesh, options) {
            Ok(outcome) => return outcome,
            Err(reason) => {
                eprintln!("[dragonfruit-mesh-repair] organic cut fell back: {reason}");
                return noop_outcome(mesh, reason);
            }
        }
    }
    #[allow(unreachable_code)]
    {
        let _ = options;
        noop_outcome(mesh, "manifold feature disabled".to_string())
    }
}

/// Curved "wafer" cut (M4): build a soap-film membrane following the drawn loop,
/// thicken it into a razor-thin cutter, and split the mesh into two mating parts.
/// Delegates the geometry to [`crate::membrane::contour_split`]; returns `Err`
/// (so the caller can fall back to the plane) on any failure.
#[cfg(feature = "manifold")]
fn organic_cut_contour(
    mesh: &IndexedMesh,
    options: &OrganicCutOptions,
) -> Result<OrganicCutOutcome, String> {
    let source_triangle_count = mesh.triangle_count();
    let loop_pts: Vec<Vec3> = options
        .cut
        .loop_points
        .iter()
        .map(|p| Vec3::new(p.position[0], p.position[1], p.position[2]))
        .collect();
    if loop_pts.len() < 3 {
        return Err(format!("contour cut needs >=3 loop points (got {})", loop_pts.len()));
    }

    let thickness = if options.cut.cutter_thickness_mm > 0.0 {
        options.cut.cutter_thickness_mm
    } else {
        crate::membrane::DEFAULT_CUTTER_THICKNESS_MM
    };

    let split =
        crate::membrane::contour_split(
            mesh,
            &loop_pts,
            thickness,
            options.cut.membrane_smoothing,
            options.cut.density,
        )?;

    let membrane_tris = split.membrane_tris;
    let mut part_a = split.part_a;
    let mut part_b = split.part_b;
    let (mut key_kind, mut key_detail) = (crate::key::KeyKind::None, String::new());

    // Optional registration key: peg union'd onto part_a, socket carved from
    // part_b. A failed/skipped key NEVER fails the cut — `apply_key` returns the
    // parts unchanged with `KeyKind::None` + a reason in that case.
    if options.cut.generate_key {
        let keyed = crate::key::apply_key(
            mesh,
            part_a,
            part_b,
            &split.membrane,
            crate::key::KeyShape::from_str_or_default(&options.cut.key_shape),
            options.cut.key_swap_sides,
            options.cut.key_width_mm,
            options.cut.key_depth_mm,
            options.cut.key_fillet_mm,
            crate::key::DEFAULT_KEY_TOLERANCE_MM,
        );
        part_a = keyed.part_a;
        part_b = keyed.part_b;
        key_kind = keyed.kind;
        key_detail = keyed.detail;
    }

    let report = OrganicCutReport {
        source_triangle_count,
        part_a_triangle_count: part_a.triangle_count(),
        part_b_triangle_count: part_b.triangle_count(),
        engine: "membrane".to_string(),
        detail: format!("membrane tris={membrane_tris}"),
        key_kind: key_kind.as_str().to_string(),
        key_detail,
    };
    Ok(OrganicCutOutcome { part_a, part_b, report })
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
        return Err(format!(
            "plane did not divide the mesh (partA tris={}, partB tris={}) — \
             loop likely tangent to the surface rather than wrapping through it",
            part_a.triangle_count(),
            part_b.triangle_count()
        ));
    }

    let report = OrganicCutReport {
        source_triangle_count,
        part_a_triangle_count: part_a.triangle_count(),
        part_b_triangle_count: part_b.triangle_count(),
        engine: "plane".to_string(),
        detail: String::new(),
        key_kind: "none".to_string(),
        key_detail: String::new(),
    };
    Ok(OrganicCutOutcome {
        part_a,
        part_b,
        report,
    })
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
        assert!(outcome.part_a.triangle_count() > 0, "part A empty 1");
        assert!(outcome.part_b.triangle_count() > 0, "part B empty");
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
        assert!(outcome.part_a.triangle_count() > 0, "part A empty (explicit)");
        assert!(outcome.part_b.triangle_count() > 0, "part B empty (explicit)");
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
        assert_eq!(outcome.report.engine, "membrane", "should use the membrane engine");
        assert!(outcome.part_a.triangle_count() > 0, "part A empty");
        assert!(outcome.part_b.triangle_count() > 0, "part B empty");
    }

    #[cfg(feature = "manifold")]
    #[test]
    fn contour_mode_falls_back_to_plane_when_membrane_cannot_sever() {
        // A diamond loop through the four FACE CENTERS at z=5. The membrane spans
        // only the inner diamond, so the cube's corner prisms stay bridged →
        // contour can't sever (1 component) → falls back to the plane cut. The
        // best-fit plane of these points IS z=5, which cleanly divides the cube,
        // so the fallback succeeds with engine="plane" and records the reason.
        let mesh = IndexedMesh::from_triangle_soup(&cube_soup(10.0), 1e-6);
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
        // It fell back to the plane (the loop still defines a best-fit plane).
        assert_eq!(outcome.report.engine, "plane", "should fall back to the plane engine");
        assert!(
            outcome.report.detail.contains("contour fell back"),
            "detail should record the fallback: {}",
            outcome.report.detail
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
        assert_eq!(outcome.part_a.triangle_count(), src_tris);
        assert_eq!(outcome.part_b.triangle_count(), src_tris);
    }
}
