//! Voxel remesh + sharp-feature recovery.
//!
//! Turns an arbitrary (including non-manifold / self-intersecting) triangle
//! soup into a watertight, 2-manifold mesh by rasterizing it into an OpenVDB
//! level set and re-extracting an adaptive polygon mesh
//! ([`try_remesh_via_openvdb`], behind the `openvdb` feature).
//!
//! Voxelization is topology-agnostic — that is exactly why it repairs anything —
//! but it rounds sharp edges. [`recover_features`] pulls the remeshed vertices
//! back onto the *original* mesh's creases and corners (QEF snap) and then
//! shrink-wraps the smooth regions tight onto the original surface. That step is
//! pure Rust and unit-testable without OpenVDB present.

use crate::core::bvh::{closest_point_on_triangle, Bvh};
use crate::core::halfedge::Topology;
use crate::core::mesh::{Aabb, IndexedMesh, Vec3};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// Options controlling the voxel remesh and its feature-recovery post-pass.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoxelRemeshOptions {
    /// Target voxel count along the bounding-box diagonal. Sets `voxel_size =
    /// bbox_diag / target`. Higher = finer/heavier. Default 256.
    pub target_voxels_along_diag: f32,
    /// Base `volumeToMesh` adaptivity in `[0,1]` (0 = uniform grid density).
    pub adaptivity: f32,
    /// Strength of the curvature-driven spatial-adaptivity term (0 disables it;
    /// flat regions get simplified, curved regions keep detail). Default 1.0.
    pub curvature_adaptivity: f32,
    /// Dihedral angle (degrees) above which an original edge counts as a sharp
    /// feature during recovery. Default 30.
    pub feature_angle_deg: f32,
    /// Run the sharp-feature recovery post-pass. Default true.
    pub recover_features: bool,
    /// Constrained shrink-wrap smoothing iterations. Default 3.
    pub shrinkwrap_iterations: u32,
    /// QEF snap gather radius, in voxels. Default 1.5.
    pub snap_radius_voxels: f32,
    /// Max distance any vertex may move during recovery, in voxels. Default 2.0.
    pub max_move_voxels: f32,
}

impl Default for VoxelRemeshOptions {
    fn default() -> Self {
        Self {
            target_voxels_along_diag: 256.0,
            adaptivity: 0.1,
            curvature_adaptivity: 1.0,
            feature_angle_deg: 30.0,
            recover_features: true,
            shrinkwrap_iterations: 3,
            snap_radius_voxels: 1.5,
            max_move_voxels: 2.0,
        }
    }
}

/// Voxel size (world units) implied by the options for `mesh`.
pub fn voxel_size_for(mesh: &IndexedMesh, opts: &VoxelRemeshOptions) -> f32 {
    let diag = mesh.bbox().diag();
    if !diag.is_finite() || diag <= 0.0 {
        return 0.0;
    }
    (diag / opts.target_voxels_along_diag.max(1.0)).max(1e-6)
}

/// Remesh `mesh` through an OpenVDB level set, then recover sharp features.
///
/// Returns `None` if the input is trivial, the level-set conversion fails, or
/// the output is empty. Requires the `openvdb` Cargo feature.
#[cfg(feature = "openvdb")]
pub fn try_remesh_via_openvdb(
    mesh: &IndexedMesh,
    opts: &VoxelRemeshOptions,
) -> Option<IndexedMesh> {
    if mesh.triangles.len() < 4 || mesh.positions.len() < 4 {
        return None;
    }
    let voxel_size = voxel_size_for(mesh, opts);
    if voxel_size <= 0.0 {
        return None;
    }

    let verts: Vec<f32> = mesh.positions.iter().flat_map(|p| [p.x, p.y, p.z]).collect();
    let tris: Vec<u32> = mesh.triangles.iter().flat_map(|t| *t).collect();

    let params = dragonfruit_openvdb_sys::RemeshParams {
        voxel_size,
        exterior_band: 3.0,
        interior_band: 3.0,
        adaptivity: opts.adaptivity,
        curvature_adaptivity: opts.curvature_adaptivity,
    };

    let out = dragonfruit_openvdb_sys::remesh(&verts, &tris, &params)?;
    if out.positions.len() < 4 || out.triangles.is_empty() {
        return None;
    }

    let mut remeshed = IndexedMesh {
        positions: out
            .positions
            .iter()
            .map(|p| Vec3::new(p[0], p[1], p[2]))
            .collect(),
        triangles: out.triangles,
    };

    if opts.recover_features {
        recover_features(&mut remeshed, mesh, voxel_size, opts);
    }

    Some(remeshed)
}

/// Pull the voxel-remeshed `remeshed` back onto `original`'s features.
///
/// Two passes, both position-only (topology is never touched, so this can never
/// introduce non-manifold edges):
///   1. **QEF snap** — each vertex near a crease/corner is moved to the
///      least-squares intersection of the nearby original face planes, which is
///      exactly the sharp feature location. Smooth vertices are just projected
///      onto the surface. Feature vertices are flagged and pinned.
///   2. **Constrained shrink-wrap** — Laplacian-smooth the non-feature vertices
///      and re-project them onto the original surface, tightening the voxel
///      shell onto the true geometry while creases stay put.
pub fn recover_features(
    remeshed: &mut IndexedMesh,
    original: &IndexedMesh,
    voxel_size: f32,
    opts: &VoxelRemeshOptions,
) {
    if remeshed.positions.is_empty() || original.triangles.is_empty() {
        return;
    }
    let bvh = Bvh::build(original);
    let snap_radius = opts.snap_radius_voxels.max(0.5) * voxel_size;
    let max_move = opts.max_move_voxels.max(0.0) * voxel_size;
    // Two normals are a "feature" when the angle between them exceeds the
    // threshold, i.e. their dot drops below cos(threshold).
    let feature_cos = opts.feature_angle_deg.to_radians().cos();

    // Pass 1: QEF snap. Parallel, read-only against the original + BVH.
    let snapped: Vec<(Vec3, bool)> = remeshed
        .positions
        .par_iter()
        .map(|&v| qef_snap(v, original, &bvh, snap_radius, max_move, feature_cos))
        .collect();

    let mut locked = vec![false; snapped.len()];
    for (i, (p, is_feature)) in snapped.iter().enumerate() {
        remeshed.positions[i] = *p;
        locked[i] = *is_feature;
    }

    // Pass 2: constrained shrink-wrap relaxation.
    if opts.shrinkwrap_iterations > 0 {
        shrinkwrap_relax(
            remeshed,
            original,
            &bvh,
            &locked,
            opts.shrinkwrap_iterations,
            max_move,
        );
    }
}

/// QEF-snap a single vertex. Returns `(new_position, is_feature)`.
fn qef_snap(
    v: Vec3,
    original: &IndexedMesh,
    bvh: &Bvh,
    radius: f32,
    max_move: f32,
    feature_cos: f32,
) -> (Vec3, bool) {
    // Surface projection used both as the smooth-region answer and as the QEF
    // regularizer (keeps the solve well-posed and near the surface).
    let q = match bvh.closest_point_on_surface(original, v) {
        Some((p, _, _)) => p,
        None => return (v, false),
    };

    // Gather planes of original faces whose closest point to `v` is within
    // `radius`. Cap the count so the O(k^2) spread test stays cheap.
    const MAX_PLANES: usize = 32;
    let query = Aabb {
        min: Vec3::new(v.x - radius, v.y - radius, v.z - radius),
        max: Vec3::new(v.x + radius, v.y + radius, v.z + radius),
    };
    let mut normals: smallvec::SmallVec<[Vec3; MAX_PLANES]> = smallvec::SmallVec::new();
    let mut offsets: smallvec::SmallVec<[f32; MAX_PLANES]> = smallvec::SmallVec::new();
    bvh.query_aabb(&query, |f| {
        if normals.len() >= MAX_PLANES {
            return;
        }
        let [a, b, c] = original.tri_positions(f);
        let cp = closest_point_on_triangle(v, a, b, c);
        if v.sub(cp).length() > radius {
            return;
        }
        let mut n = b.sub(a).cross(c.sub(a));
        let len = n.length();
        if len < 1e-12 {
            return;
        }
        n = n.scale(1.0 / len);
        normals.push(n);
        offsets.push(n.dot(cp)); // plane: n·x = offset
    });

    if normals.is_empty() {
        return (q, false); // nothing nearby: fall back to surface projection
    }

    // Feature test: is there a pair of gathered normals more than the threshold
    // angle apart? If not, this is a smooth patch — just sit on the surface.
    let mut is_feature = false;
    'outer: for i in 0..normals.len() {
        for j in (i + 1)..normals.len() {
            if normals[i].dot(normals[j]) < feature_cos {
                is_feature = true;
                break 'outer;
            }
        }
    }
    if !is_feature {
        return (q, false);
    }

    // Solve min_x  Σ (nᵢ·x − offsetᵢ)²  +  λ‖x − q‖²
    // → (AᵀA + λI) x = Aᵀb + λq.
    let mut ata = [[0.0f64; 3]; 3];
    let mut atb = [0.0f64; 3];
    for (n, &d) in normals.iter().zip(offsets.iter()) {
        let nn = [n.x as f64, n.y as f64, n.z as f64];
        for i in 0..3 {
            for j in 0..3 {
                ata[i][j] += nn[i] * nn[j];
            }
            atb[i] += nn[i] * d as f64;
        }
    }
    let lambda = 0.01 * normals.len() as f64;
    let qd = [q.x as f64, q.y as f64, q.z as f64];
    for i in 0..3 {
        ata[i][i] += lambda;
        atb[i] += lambda * qd[i];
    }

    let sol = solve3(ata, atb).unwrap_or(qd);
    let mut x = Vec3::new(sol[0] as f32, sol[1] as f32, sol[2] as f32);

    // Clamp the move so a bad solve can't fling a vertex across the mesh.
    let mv = x.sub(v);
    let ml = mv.length();
    if ml > max_move && ml > 0.0 {
        x = v.add(mv.scale(max_move / ml));
    }
    (x, true)
}

/// Constrained shrink-wrap: Laplacian-smooth unlocked vertices and re-project
/// them onto the original surface. Locked (feature) vertices are held fixed.
fn shrinkwrap_relax(
    mesh: &mut IndexedMesh,
    original: &IndexedMesh,
    bvh: &Bvh,
    locked: &[bool],
    iterations: u32,
    max_move: f32,
) {
    let n = mesh.positions.len();
    let topo = Topology::build(mesh);
    let mut neighbors: Vec<smallvec::SmallVec<[u32; 8]>> = vec![Default::default(); n];
    for &(a, b) in topo.edges.keys() {
        neighbors[a as usize].push(b);
        neighbors[b as usize].push(a);
    }

    // Anchor = post-snap position; every vertex stays within `max_move` of it.
    let anchor = mesh.positions.clone();

    for _ in 0..iterations {
        let cur = mesh.positions.clone();
        let updated: Vec<Vec3> = (0..n)
            .into_par_iter()
            .map(|i| {
                if locked[i] || neighbors[i].is_empty() {
                    return cur[i];
                }
                // Uniform Laplacian, half-step tangential smoothing.
                let mut avg = Vec3::new(0.0, 0.0, 0.0);
                for &j in neighbors[i].iter() {
                    avg = avg.add(cur[j as usize]);
                }
                avg = avg.scale(1.0 / neighbors[i].len() as f32);
                let smoothed = cur[i].add(avg.sub(cur[i]).scale(0.5));

                // Shrink-wrap: snap back onto the original surface.
                let projected = bvh
                    .closest_point_on_surface(original, smoothed)
                    .map(|(p, _, _)| p)
                    .unwrap_or(smoothed);

                // Clamp against the anchor.
                let mv = projected.sub(anchor[i]);
                let ml = mv.length();
                if ml > max_move && ml > 0.0 {
                    anchor[i].add(mv.scale(max_move / ml))
                } else {
                    projected
                }
            })
            .collect();
        mesh.positions = updated;
    }
}

/// Solve a symmetric 3×3 system `A x = b` via Gaussian elimination with partial
/// pivoting. Returns `None` if `A` is effectively singular.
fn solve3(mut a: [[f64; 3]; 3], mut b: [f64; 3]) -> Option<[f64; 3]> {
    for col in 0..3 {
        // Pivot.
        let mut piv = col;
        let mut best = a[col][col].abs();
        for r in (col + 1)..3 {
            if a[r][col].abs() > best {
                best = a[r][col].abs();
                piv = r;
            }
        }
        if best < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);

        // Eliminate below.
        for r in (col + 1)..3 {
            let f = a[r][col] / a[col][col];
            for c in col..3 {
                a[r][c] -= f * a[col][c];
            }
            b[r] -= f * b[col];
        }
    }
    // Back-substitute.
    let mut x = [0.0f64; 3];
    for i in (0..3).rev() {
        let mut s = b[i];
        for j in (i + 1)..3 {
            s -= a[i][j] * x[j];
        }
        x[i] = s / a[i][i];
    }
    Some(x)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::mesh::Vec3;

    /// An axis-aligned unit cube centred at the origin, as a triangle mesh.
    fn unit_cube() -> IndexedMesh {
        let p = [
            Vec3::new(-0.5, -0.5, -0.5),
            Vec3::new(0.5, -0.5, -0.5),
            Vec3::new(0.5, 0.5, -0.5),
            Vec3::new(-0.5, 0.5, -0.5),
            Vec3::new(-0.5, -0.5, 0.5),
            Vec3::new(0.5, -0.5, 0.5),
            Vec3::new(0.5, 0.5, 0.5),
            Vec3::new(-0.5, 0.5, 0.5),
        ];
        let f = [
            [0, 2, 1],
            [0, 3, 2], // -Z
            [4, 5, 6],
            [4, 6, 7], // +Z
            [0, 1, 5],
            [0, 5, 4], // -Y
            [2, 3, 7],
            [2, 7, 6], // +Y
            [1, 2, 6],
            [1, 6, 5], // +X
            [0, 4, 7],
            [0, 7, 3], // -X
        ];
        IndexedMesh {
            positions: p.to_vec(),
            triangles: f.to_vec(),
        }
    }

    #[test]
    fn closest_point_on_cube_surface() {
        let cube = unit_cube();
        let bvh = Bvh::build(&cube);
        // A point well outside the +X face projects onto x = 0.5.
        let (pt, _, _) = bvh
            .closest_point_on_surface(&cube, Vec3::new(2.0, 0.1, -0.2))
            .unwrap();
        assert!((pt.x - 0.5).abs() < 1e-4, "got {pt:?}");
        assert!((pt.y - 0.1).abs() < 1e-4);
        assert!((pt.z + 0.2).abs() < 1e-4);
    }

    #[test]
    fn qef_snap_recovers_a_convex_edge() {
        let cube = unit_cube();
        let bvh = Bvh::build(&cube);
        // A point that a voxel remesh would place just off the +X/+Y edge
        // (which runs along z at x=y=0.5). Recovery should pull it onto the edge.
        let voxel = 0.05;
        let off = Vec3::new(0.46, 0.46, 0.0);
        let (snapped, is_feature) = qef_snap(
            off,
            &cube,
            &bvh,
            1.5 * voxel,
            2.0 * voxel,
            30f32.to_radians().cos(),
        );
        assert!(is_feature, "edge vertex should be flagged as a feature");
        assert!((snapped.x - 0.5).abs() < voxel, "x not on edge: {snapped:?}");
        assert!((snapped.y - 0.5).abs() < voxel, "y not on edge: {snapped:?}");
    }

    #[test]
    fn qef_snap_leaves_flat_region_on_surface() {
        let cube = unit_cube();
        let bvh = Bvh::build(&cube);
        let voxel = 0.05;
        // A point off the middle of the +X face: no feature, just project to x=0.5.
        let off = Vec3::new(0.54, 0.0, 0.0);
        let (snapped, is_feature) = qef_snap(
            off,
            &cube,
            &bvh,
            1.5 * voxel,
            2.0 * voxel,
            30f32.to_radians().cos(),
        );
        assert!(!is_feature, "flat-face vertex must not be a feature");
        assert!((snapped.x - 0.5).abs() < 1e-4, "not projected: {snapped:?}");
    }

    #[test]
    fn solve3_identity() {
        let a = [[2.0, 0.0, 0.0], [0.0, 3.0, 0.0], [0.0, 0.0, 4.0]];
        let x = solve3(a, [2.0, 6.0, 12.0]).unwrap();
        assert!((x[0] - 1.0).abs() < 1e-9);
        assert!((x[1] - 2.0).abs() < 1e-9);
        assert!((x[2] - 3.0).abs() < 1e-9);
    }
}
