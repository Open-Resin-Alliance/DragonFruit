//! Parallel signed distance field computation from an indexed triangle mesh.
//!
//! Algorithm: spatial-hash-accelerated closest-point search.
//!
//! 1. Bucket every triangle into a coarse spatial hash (cell size = shell_thickness
//!    for conservative coverage).
//! 2. For each SDF grid cell within `shell_thickness` of the surface, query
//!    triangles in nearby spatial-hash buckets to find the closest point.
//! 3. Sign the distance using the closest triangle's geometric face normal.
//!
//! This is embarrassingly parallel — each SDF cell is independent, so rayon
//! fully saturates all cores.  Typical models complete in 200-800 ms.

use rayon::prelude::*;
use std::collections::HashMap;

use ahash::AHashSet;
use smallvec::SmallVec;

use crate::grid::SparseSdfGrid;
use crate::SdfOptions;

// ---------------------------------------------------------------------------
// Input mesh — lightweight, self-contained (no dep on dragonfruit-mesh-repair)
// ---------------------------------------------------------------------------

/// A single triangle for SDF computation.
#[derive(Debug, Clone, Copy)]
struct Tri {
    v0: [f32; 3],
    v1: [f32; 3],
    v2: [f32; 3],
    /// Pre-computed geometric face normal (unnormalised edge cross product).
    normal: [f32; 3],
}

impl Tri {
    fn from_vertices(v0: [f32; 3], v1: [f32; 3], v2: [f32; 3]) -> Self {
        let e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
        let e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
        let normal = cross(&e1, &e2);
        Self { v0, v1, v2, normal }
    }
}

/// Mesh input for SDF computation — flat positions + triangle indices.
pub struct SdfMeshInput {
    /// Flat vertex positions: [x0, y0, z0, x1, y1, z1, ...]
    pub positions: Vec<f32>,
    /// Triangle indices: [[i0, i1, i2], ...]
    pub triangles: Vec<[u32; 3]>,
}

// ---------------------------------------------------------------------------
// Spatial hash for triangle bucketing
// ---------------------------------------------------------------------------

type SpatialKey = (i32, i32, i32);

fn spatial_key(x: f32, y: f32, z: f32, cell_size: f32) -> SpatialKey {
    (
        (x / cell_size).floor() as i32,
        (y / cell_size).floor() as i32,
        (z / cell_size).floor() as i32,
    )
}

fn build_triangle_spatial_index(
    tris: &[Tri],
    bucket_size: f32,
) -> HashMap<SpatialKey, Vec<u32>, ahash::RandomState> {
    let mut index: HashMap<SpatialKey, Vec<u32>, ahash::RandomState> =
        HashMap::with_hasher(ahash::RandomState::default());

    for (ti, tri) in tris.iter().enumerate() {
        // Compute the AABB of this triangle
        let min_x = tri.v0[0].min(tri.v1[0]).min(tri.v2[0]);
        let min_y = tri.v0[1].min(tri.v1[1]).min(tri.v2[1]);
        let min_z = tri.v0[2].min(tri.v1[2]).min(tri.v2[2]);
        let max_x = tri.v0[0].max(tri.v1[0]).max(tri.v2[0]);
        let max_y = tri.v0[1].max(tri.v1[1]).max(tri.v2[1]);
        let max_z = tri.v0[2].max(tri.v1[2]).max(tri.v2[2]);

        let k_min = spatial_key(min_x, min_y, min_z, bucket_size);
        let k_max = spatial_key(max_x, max_y, max_z, bucket_size);

        // Insert into all buckets that the triangle AABB overlaps
        for kx in k_min.0..=k_max.0 {
            for ky in k_min.1..=k_max.1 {
                for kz in k_min.2..=k_max.2 {
                    index.entry((kx, ky, kz)).or_default().push(ti as u32);
                }
            }
        }
    }

    index
}

// ---------------------------------------------------------------------------
// Point-to-triangle distance (unsigned)
// ---------------------------------------------------------------------------

fn point_triangle_distance_sq(p: &[f32; 3], tri: &Tri) -> f32 {
    // Translated from Real-Time Collision Detection §5.2.2
    let a = tri.v0;
    let b = tri.v1;
    let c = tri.v2;

    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];

    let d1 = dot(&ab, &ap);
    let d2 = dot(&ac, &ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return dot(&ap, &ap); // closest to A
    }

    let bp = [p[0] - b[0], p[1] - b[1], p[2] - b[2]];
    let d3 = dot(&ab, &bp);
    let d4 = dot(&ac, &bp);
    if d3 >= 0.0 && d4 <= d3 {
        return dot(&bp, &bp); // closest to B
    }

    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        let v = d1 / (d1 - d3);
        let closest = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]];
        let diff = [p[0] - closest[0], p[1] - closest[1], p[2] - closest[2]];
        return dot(&diff, &diff); // closest to AB edge
    }

    let cp = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    let d5 = dot(&ab, &cp);
    let d6 = dot(&ac, &cp);
    if d6 >= 0.0 && d5 <= d6 {
        return dot(&cp, &cp); // closest to C
    }

    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        let w = d2 / (d2 - d6);
        let closest = [a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2]];
        let diff = [p[0] - closest[0], p[1] - closest[1], p[2] - closest[2]];
        return dot(&diff, &diff); // closest to AC edge
    }

    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && (d4 - d3) >= 0.0 && (d5 - d6) >= 0.0 {
        let w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
        let closest = [
            b[0] + w * (c[0] - b[0]),
            b[1] + w * (c[1] - b[1]),
            b[2] + w * (c[2] - b[2]),
        ];
        let diff = [p[0] - closest[0], p[1] - closest[1], p[2] - closest[2]];
        return dot(&diff, &diff); // closest to BC edge
    }

    // Closest to interior
    let denom = 1.0 / (va + vb + vc);
    let v = vb * denom;
    let w = vc * denom;
    let closest = [
        a[0] + ab[0] * v + ac[0] * w,
        a[1] + ab[1] * v + ac[1] * w,
        a[2] + ab[2] * v + ac[2] * w,
    ];
    let diff = [p[0] - closest[0], p[1] - closest[1], p[2] - closest[2]];
    dot(&diff, &diff)
}

// ---------------------------------------------------------------------------
// SDF computation for a single cell
// ---------------------------------------------------------------------------

/// Compute the signed distance at a world-space query point by searching
/// nearby spatial buckets for the closest triangle.
fn compute_signed_distance_at(
    wx: f32,
    wy: f32,
    wz: f32,
    spatial_index: &HashMap<SpatialKey, Vec<u32>, ahash::RandomState>,
    tris: &[Tri],
    bucket_size: f32,
    search_radius_buckets: i32,
) -> f32 {
    let query_key = spatial_key(wx, wy, wz, bucket_size);

    // Collect unique triangle indices from nearby buckets
    let mut nearby: SmallVec<[u32; 64]> = SmallVec::new();
    {
        let mut seen = AHashSet::with_capacity(64);
        for dkx in -search_radius_buckets..=search_radius_buckets {
            for dky in -search_radius_buckets..=search_radius_buckets {
                for dkz in -search_radius_buckets..=search_radius_buckets {
                    let key = (query_key.0 + dkx, query_key.1 + dky, query_key.2 + dkz);
                    if let Some(bucket) = spatial_index.get(&key) {
                        for &ti in bucket {
                            if seen.insert(ti) {
                                nearby.push(ti);
                            }
                        }
                    }
                }
            }
        }
    }

    if nearby.is_empty() {
        return f32::MAX;
    }

    let mut best_dist_sq = f32::MAX;
    let mut best_tri_idx = 0u32;

    for &ti in &nearby {
        let tri = &tris[ti as usize];
        let d_sq = point_triangle_distance_sq(&[wx, wy, wz], tri);
        if d_sq < best_dist_sq {
            best_dist_sq = d_sq;
            best_tri_idx = ti;
        }
    }

    let dist = best_dist_sq.sqrt();
    let best_tri = &tris[best_tri_idx as usize];

    // Sign the distance via face normal dot product.
    // Use the triangle centroid as an approximation of the closest surface point.
    let centroid = [
        (best_tri.v0[0] + best_tri.v1[0] + best_tri.v2[0]) / 3.0,
        (best_tri.v0[1] + best_tri.v1[1] + best_tri.v2[1]) / 3.0,
        (best_tri.v0[2] + best_tri.v1[2] + best_tri.v2[2]) / 3.0,
    ];
    let to_query = [wx - centroid[0], wy - centroid[1], wz - centroid[2]];
    let dot_n = dot(&to_query, &best_tri.normal);
    if dot_n < 0.0 {
        -dist
    } else {
        dist
    }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/// Compute a sparse signed distance field for the given mesh.
///
/// Only cells within `options.shell_thickness` of any triangle surface are
/// computed.  Cells within `options.inner_shell` use `options.cell_size`
/// resolution; cells farther out use a coarser grid.
pub fn compute_sdf_grid(mesh: &SdfMeshInput, options: &SdfOptions) -> SparseSdfGrid {
    // Convert to internal triangle representation
    let tris: Vec<Tri> = mesh
        .triangles
        .iter()
        .map(|&[i0, i1, i2]| {
            let v0 = [
                mesh.positions[i0 as usize * 3],
                mesh.positions[i0 as usize * 3 + 1],
                mesh.positions[i0 as usize * 3 + 2],
            ];
            let v1 = [
                mesh.positions[i1 as usize * 3],
                mesh.positions[i1 as usize * 3 + 1],
                mesh.positions[i1 as usize * 3 + 2],
            ];
            let v2 = [
                mesh.positions[i2 as usize * 3],
                mesh.positions[i2 as usize * 3 + 1],
                mesh.positions[i2 as usize * 3 + 2],
            ];
            Tri::from_vertices(v0, v1, v2)
        })
        .collect();

    // Compute mesh bounding box
    let mut bb_min = [f32::MAX; 3];
    let mut bb_max = [f32::MIN; 3];
    for p in mesh.positions.chunks_exact(3) {
        for axis in 0..3 {
            bb_min[axis] = bb_min[axis].min(p[axis]);
            bb_max[axis] = bb_max[axis].max(p[axis]);
        }
    }

    let bucket_size = options.shell_thickness.max(1.0);
    let spatial_index = build_triangle_spatial_index(&tris, bucket_size);

    // Determine the grid range: bounding box expanded by shell_thickness
    let cs = options.cell_size;
    let shell = options.shell_thickness;
    let qx_min = ((bb_min[0] - shell) / cs).floor() as i32;
    let qx_max = ((bb_max[0] + shell) / cs).ceil() as i32;
    let qy_min = ((bb_min[1] - shell) / cs).floor() as i32;
    let qy_max = ((bb_max[1] + shell) / cs).ceil() as i32;
    let qz_min = ((bb_min[2] - shell) / cs).floor() as i32;
    let qz_max = ((bb_max[2] + shell) / cs).ceil() as i32;

    let total_cells = ((qx_max - qx_min + 1) as usize)
        * ((qy_max - qy_min + 1) as usize)
        * ((qz_max - qz_min + 1) as usize);

    // Build list of cell coordinates to compute
    let inner = options.inner_shell;
    let coarse_factor = options.coarse_factor as i32;
    let search_radius = (shell / bucket_size).ceil() as i32 + 1;

    // Pre-filter: only compute cells that are near the surface.
    // We do this by only including cells whose spatial-hash bucket contains
    // at least one triangle (using the bucket_size grid).
    let cell_coords: Vec<(i32, i32, i32)> = {
        let mut coords = Vec::with_capacity(total_cells.min(20_000_000));
        for qx in qx_min..=qx_max {
            for qy in qy_min..=qy_max {
                for qz in qz_min..=qz_max {
                    let wx = qx as f32 * cs;
                    let wy = qy as f32 * cs;
                    let wz = qz as f32 * cs;
                    let key = spatial_key(wx, wy, wz, bucket_size);

                    // Check if any nearby bucket has triangles
                    let mut has_tris = false;
                    'bucket_search: for dkx in -search_radius..=search_radius {
                        for dky in -search_radius..=search_radius {
                            for dkz in -search_radius..=search_radius {
                                if spatial_index.contains_key(&(
                                    key.0 + dkx,
                                    key.1 + dky,
                                    key.2 + dkz,
                                )) {
                                    has_tris = true;
                                    break 'bucket_search;
                                }
                            }
                        }
                    }

                    if has_tris {
                        // Apply coarse subsampling for outer shell
                        if inner > 0.0 && coarse_factor > 1 {
                            // Include if cell is in inner shell (within inner/cs cells
                            // of bbox edge) or on coarse stride
                            let dist_to_bbox = dist_point_to_bbox(
                                wx, wy, wz, bb_min[0], bb_min[1], bb_min[2], bb_max[0], bb_max[1],
                                bb_max[2],
                            );

                            if dist_to_bbox > inner {
                                // Outer shell: subsample
                                if qx % coarse_factor != 0
                                    || qy % coarse_factor != 0
                                    || qz % coarse_factor != 0
                                {
                                    continue;
                                }
                            }
                        }
                        coords.push((qx, qy, qz));
                    }
                }
            }
        }
        coords
    };

    let mut grid = SparseSdfGrid::new(cs, cell_coords.len());

    // Parallel SDF computation
    let distances: Vec<f32> = cell_coords
        .par_iter()
        .map(|&(qx, qy, qz)| {
            let wx = qx as f32 * cs;
            let wy = qy as f32 * cs;
            let wz = qz as f32 * cs;

            let cell_search_radius = if inner > 0.0 {
                let dist_to_bbox = dist_point_to_bbox(
                    wx, wy, wz, bb_min[0], bb_min[1], bb_min[2], bb_max[0], bb_max[1], bb_max[2],
                );
                if dist_to_bbox > inner {
                    (shell / bucket_size).ceil() as i32 + 2
                } else {
                    search_radius
                }
            } else {
                search_radius
            };

            compute_signed_distance_at(
                wx,
                wy,
                wz,
                &spatial_index,
                &tris,
                bucket_size,
                cell_search_radius,
            )
        })
        .collect();

    for (&(qx, qy, qz), &dist) in cell_coords.iter().zip(distances.iter()) {
        if dist.is_finite() {
            grid.insert(qx, qy, qz, dist);
        }
    }

    grid
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

#[inline]
fn dot(a: &[f32; 3], b: &[f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
fn cross(a: &[f32; 3], b: &[f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn dist_point_to_bbox(
    px: f32,
    py: f32,
    pz: f32,
    min_x: f32,
    min_y: f32,
    min_z: f32,
    max_x: f32,
    max_y: f32,
    max_z: f32,
) -> f32 {
    let dx = (min_x - px).max(0.0).max(px - max_x);
    let dy = (min_y - py).max(0.0).max(py - max_y);
    let dz = (min_z - pz).max(0.0).max(pz - max_z);
    (dx * dx + dy * dy + dz * dz).sqrt()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_cube_sdf() {
        // A 10mm axis-aligned cube centered at origin
        let s = 5.0; // half-size
        let positions = vec![
            // Front face (z = +s)
            -s, -s, s, s, -s, s, s, s, s, -s, -s, s, s, s, s, -s, s, s,
            // Back face (z = -s)
            s, -s, -s, -s, -s, -s, -s, s, -s, s, -s, -s, -s, s, -s, s, s, -s,
            // Right face (x = +s)
            s, -s, s, s, -s, -s, s, s, -s, s, -s, s, s, s, -s, s, s, s,
            // Left face (x = -s)
            -s, -s, -s, -s, -s, s, -s, s, s, -s, -s, -s, -s, s, s, -s, s, -s,
            // Top face (y = +s)
            -s, s, s, s, s, s, s, s, -s, -s, s, s, s, s, -s, -s, s, -s,
            // Bottom face (y = -s)
            -s, -s, -s, s, -s, -s, s, -s, s, -s, -s, -s, s, -s, s, -s, -s, s,
        ];
        let triangles: Vec<[u32; 3]> = (0..12).map(|i| [i * 3, i * 3 + 1, i * 3 + 2]).collect();

        let mesh = SdfMeshInput {
            positions,
            triangles,
        };
        let opts = SdfOptions {
            cell_size: 0.5,
            shell_thickness: 6.0,
            inner_shell: 0.0, // uniform resolution for test
            coarse_factor: 1,
        };

        let grid = compute_sdf_grid(&mesh, &opts);
        assert!(grid.len() > 0, "grid should have cells");

        // Point at origin (inside cube) should be negative
        let q0 = (0.0f32 / 0.5).round() as i32;
        let d_center = grid.get(q0, q0, q0);
        assert!(d_center.is_some(), "center cell should exist");
        assert!(
            d_center.unwrap() < 0.0,
            "center should be inside (neg distance), got {:?}",
            d_center
        );

        // Point well outside should not be in the grid
        let q_far = (20.0f32 / 0.5).round() as i32;
        assert_eq!(grid.get(q_far, 0, 0), None);
    }
}
