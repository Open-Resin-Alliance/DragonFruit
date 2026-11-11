//! Island scan rasterizer — produces per-layer RLE masks from triangles.
//!
//! This is a **faithful port** of the TypeScript pipeline:
//!   1. `BucketedSlicer.slice(z)` → triangle-plane intersection → closed polygon loops
//!   2. `rasterizeLoopsToExistingGridScanline()` → edge-table scanline fill (even-odd)
//!
//! Every epsilon, pixel boundary rule, and coordinate offset matches the TS exactly
//! so that island counts are identical at any `px_mm` resolution.

use indexmap::IndexMap;

use crate::geometry::Triangle;

use crate::model::RleMask;
use crate::rle::rle_encode;

const EPS: f64 = 1e-6;

// ---------------------------------------------------------------------------
// Step 1: Triangle-plane intersection → polygon loops
// (matches BucketedSlicer.slice + buildLoops from Slice2D.ts)
// ---------------------------------------------------------------------------

type Pt2 = (f64, f64);

/// Hash a 2D point to a string key for loop stitching (matches TS `key2`).
fn key2(x: f64, y: f64) -> (i64, i64) {
    ((x * 1e5).round() as i64, (y * 1e5).round() as i64)
}

/// Intersect triangle edge (a→b) with Z plane.
/// Returns (x, y) intersection point or None.
/// Matches TS `intersectEdgeZ` with its epsilon tolerance.
fn intersect_edge_z(
    ax: f64,
    ay: f64,
    az: f64,
    bx: f64,
    by: f64,
    bz: f64,
    z_slice: f64,
) -> Option<(f64, f64)> {
    let dz = bz - az;
    if dz.abs() < EPS {
        return None;
    }
    let t = (z_slice - az) / dz;
    if t < -EPS || t > 1.0 + EPS {
        return None;
    }
    Some((ax + t * (bx - ax), ay + t * (by - ay)))
}

/// Stitch segments into closed polygon loops.
/// Matches TS `buildLoops()` from Slice2D.ts.
fn build_loops(segments: &[(Pt2, Pt2)]) -> Vec<Vec<Pt2>> {
    // Build adjacency map: key → list of connected points
    // IndexMap preserves insertion order — matches JS Map iteration semantics
    let mut next_map: IndexMap<(i64, i64), Vec<Pt2>> = IndexMap::new();

    for &(a, b) in segments {
        let ka = key2(a.0, a.1);
        let kb = key2(b.0, b.1);
        next_map.entry(ka).or_default().push(b);
        next_map.entry(kb).or_default().push(a);
    }

    let mut visited = std::collections::HashSet::new();
    let mut loops = Vec::new();

    for (&k, neighbors) in &next_map {
        if visited.contains(&k) || neighbors.is_empty() {
            continue;
        }

        // Reconstruct start point from key (matches TS parsing)
        let start = (k.0 as f64 / 1e5, k.1 as f64 / 1e5);
        let mut current = start;
        let mut loop_pts: Vec<Pt2> = vec![start];
        visited.insert(k);

        let start_key = key2(start.0, start.1);
        let mut guard = 0;
        loop {
            guard += 1;
            if guard > 100000 {
                break;
            }
            let kn = key2(current.0, current.1);
            let options = match next_map.get(&kn) {
                Some(v) => v,
                None => break,
            };

            let mut next: Option<Pt2> = None;
            for &cand in options {
                let kc = key2(cand.0, cand.1);
                if !visited.contains(&kc) || (kc == start_key && loop_pts.len() > 2) {
                    next = Some(cand);
                    break;
                }
            }

            match next {
                None => break,
                Some(n) => {
                    loop_pts.push(n);
                    let kn_next = key2(n.0, n.1);
                    if kn_next == start_key {
                        break; // closed
                    }
                    visited.insert(kn_next);
                    current = n;
                }
            }
        }

        if loop_pts.len() >= 3 {
            loops.push(loop_pts);
        }
    }

    loops
}

// ---------------------------------------------------------------------------
// Step 2: Edge-table scanline fill
// (matches rasterizeLoopsToExistingGridScanline from scanline.ts)
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Edge {
    y_max: f64,
    x: f64,
    slope: f64, // dx/dy
}

/// Rasterize polygon loops into a binary mask using edge-table scanline fill.
/// Matches TS `rasterizeLoopsToExistingGridScanline` exactly.
fn rasterize_loops(
    loops: &[Vec<Pt2>],
    width: usize,
    height: usize,
    origin_x: f64,
    origin_z: f64, // = -bbox.max_y
    px_mm: f64,
) -> Vec<u8> {
    let mut data = vec![0u8; width * height];

    // TS: const originY = originZ + px_mm * 0.5;
    // (originXCenter is declared but NOT used in the coordinate mapping)
    let origin_y = origin_z + px_mm * 0.5;

    for loop_pts in loops {
        let len = loop_pts.len();
        if len < 3 {
            continue;
        }

        // Build edge table
        let mut edge_table: Vec<Vec<Edge>> = vec![Vec::new(); height];

        for i in 0..len {
            let p1 = loop_pts[i];
            let p2 = loop_pts[(i + 1) % len];

            // TS: const x1 = (p1.x - originX) / px_mm;
            let x1 = (p1.0 - origin_x) / px_mm;
            let y1 = (p1.1 - origin_y) / px_mm;
            let x2 = (p2.0 - origin_x) / px_mm;
            let y2 = (p2.1 - origin_y) / px_mm;

            if (y1 - y2).abs() < 1e-6 {
                continue; // skip horizontal edges
            }

            let (y_min, y_max, x_val) = if y1 > y2 { (y2, y1, x2) } else { (y1, y2, x1) };

            let slope = (x2 - x1) / (y2 - y1);
            let start_row = y_min.ceil() as i32;
            let _end_row = y_max.ceil() as i32;

            if start_row >= height as i32 {
                continue;
            }

            let valid_start_row = start_row.max(0) as usize;
            let initial_x = x_val + slope * (valid_start_row as f64 - y_min);

            if valid_start_row < height {
                edge_table[valid_start_row].push(Edge {
                    y_max,
                    x: initial_x,
                    slope,
                });
            }
        }

        // Scanline fill with active edge list
        let mut active_edges: Vec<Edge> = Vec::new();

        for y in 0..height {
            // Add edges starting at this scanline
            active_edges.extend(edge_table[y].drain(..));

            // Remove expired edges (y >= yMax)
            active_edges.retain(|e| (y as f64) < e.y_max);

            // Sort by x
            active_edges.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));

            // Fill between pairs (even-odd rule)
            let mut i = 0;
            while i + 1 < active_edges.len() {
                // TS: let startX = Math.ceil(e1.x - 0.5);
                let start_x = (active_edges[i].x - 0.5).ceil() as i32;
                let end_x = (active_edges[i + 1].x - 0.5).ceil() as i32;

                let start_x = start_x.max(0) as usize;
                let end_x = (end_x as usize).min(width);

                if start_x < end_x {
                    let row_offset = y * width;
                    for x in start_x..end_x {
                        data[row_offset + x] = 1;
                    }
                }

                i += 2;
            }

            // Advance edge x positions
            for edge in &mut active_edges {
                edge.x += edge.slope;
            }
        }
    }

    data
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Rasterize all layers from triangles for island detection.
///
/// Faithfully ports the TS pipeline:
///   `BucketedSlicer.slice()` → `rasterizeLoopsToExistingGridScanline()`
///
/// Returns `(masks, grid_width, grid_height, num_layers, origin_x, origin_z)`.
///
/// **Z-bucket optimization**: triangles are pre-indexed by their Z-span so each
/// layer only tests triangles that actually intersect its Z plane instead of
/// iterating all triangles O(N_layers × N_triangles). For meshes with millions
/// of triangles this is the dominant speedup.
pub fn rasterize_for_island_scan(
    triangles: &[Triangle],
    bbox_min_x: f64,
    bbox_max_x: f64,
    bbox_min_y: f64,
    bbox_max_y: f64,
    bbox_min_z: f64,
    bbox_max_z: f64,
    px_mm: f64,
    layer_height_mm: f64,
) -> (Vec<RleMask>, i32, i32, usize, f64, f64) {
    let origin_x = bbox_min_x;
    let origin_z = -bbox_max_y; // mask Y = -world Y
    let grid_width = ((bbox_max_x - bbox_min_x) / px_mm).ceil().max(1.0) as i32;
    let grid_height = ((bbox_max_y - bbox_min_y) / px_mm).ceil().max(1.0) as i32;
    let model_height = bbox_max_z - bbox_min_z;
    let num_layers = (model_height / layer_height_mm).ceil().max(0.0) as usize;

    let w = grid_width as usize;
    let h = grid_height as usize;

    // ── Pre-index triangles into Z-buckets (matches stream.rs Z_TOL padding) ──
    // Each triangle goes into every bucket whose Z-band its tolerance-expanded
    // span overlaps so boundary horizontal caps are never dropped.
    const Z_TOL: f64 = 3.0e-5;
    let z_range = bbox_max_z - bbox_min_z;
    let num_z_buckets = num_layers.max(1);
    let max_bucket = (num_z_buckets - 1) as f64;
    let mut z_buckets: Vec<Vec<u32>> = vec![Vec::new(); num_z_buckets];
    for (ti, tri) in triangles.iter().enumerate() {
        let tri_min_z = tri.a.z.min(tri.b.z).min(tri.c.z) as f64;
        let tri_max_z = tri.a.z.max(tri.b.z).max(tri.c.z) as f64;
        if tri_max_z + Z_TOL < bbox_min_z || tri_min_z - Z_TOL > bbox_max_z {
            continue; // triangle entirely outside model Z range
        }
        let b_start = if z_range > EPS {
            (((tri_min_z - Z_TOL - bbox_min_z) / z_range) * max_bucket)
                .floor()
                .clamp(0.0, max_bucket) as usize
        } else {
            0
        };
        let b_end = if z_range > EPS {
            (((tri_max_z + Z_TOL - bbox_min_z) / z_range) * max_bucket)
                .ceil()
                .clamp(0.0, max_bucket) as usize
        } else {
            num_z_buckets - 1
        };
        for b in b_start..=b_end {
            z_buckets[b].push(ti as u32);
        }
    }

    let bucket_tri_counts: Vec<usize> = z_buckets.iter().map(|b| b.len()).collect();
    let total_bucket_entries: usize = bucket_tri_counts.iter().sum();
    let avg_per_layer = if num_layers > 0 {
        total_bucket_entries / num_layers
    } else {
        0
    };
    log::info!(
        "Rasterization Z-buckets: {} total entries across {} layers (avg {:.0} tri/layer vs {} total)",
        total_bucket_entries,
        num_layers,
        avg_per_layer,
        triangles.len(),
    );

    use rayon::prelude::*;
    let masks: Vec<RleMask> = (0..num_layers)
        .into_par_iter()
        .map(|l| {
            // Match TS: z = zOffset + (idx + 1) * layerHeight + 1e-6
            let z = bbox_min_z + (l as f64 + 1.0) * layer_height_mm + 1e-6;

            // Step 1: Slice only triangles from this Z-bucket
            let bucket_tris: Vec<&Triangle> = z_buckets[l]
                .iter()
                .map(|&ti| &triangles[ti as usize])
                .collect();
            let loops = slice_to_loops_from_slice(&bucket_tris, z);

            // Step 2: Rasterize loops using edge-table scanline fill
            let dense = rasterize_loops(&loops, w, h, origin_x, origin_z, px_mm);

            rle_encode(&dense, grid_width, grid_height)
        })
        .collect();

    (
        masks,
        grid_width,
        grid_height,
        num_layers,
        origin_x,
        origin_z,
    )
}

/// Slice a pre-filtered set of triangles at Z height, building polygon loops.
/// Same logic as `slice_to_loops` but takes a slice instead of iterating all triangles.
fn slice_to_loops_from_slice(triangles: &[&Triangle], z: f64) -> Vec<Vec<Pt2>> {
    let z_slice = z + 1e-5;
    let mut segments: Vec<(Pt2, Pt2)> = Vec::new();

    for tri in triangles {
        let (v0x, v0y, v0z) = (tri.a.x as f64, tri.a.y as f64, tri.a.z as f64);
        let (v1x, v1y, v1z) = (tri.b.x as f64, tri.b.y as f64, tri.b.z as f64);
        let (v2x, v2y, v2z) = (tri.c.x as f64, tri.c.y as f64, tri.c.z as f64);

        let above0 = v0z >= z_slice + 10.0 * EPS;
        let above1 = v1z >= z_slice + 10.0 * EPS;
        let above2 = v2z >= z_slice + 10.0 * EPS;
        let below0 = v0z <= z_slice - 10.0 * EPS;
        let below1 = v1z <= z_slice - 10.0 * EPS;
        let below2 = v2z <= z_slice - 10.0 * EPS;

        if (above0 && above1 && above2) || (below0 && below1 && below2) {
            continue;
        }

        let mut points: Vec<(f64, f64)> = Vec::new();
        if let Some(p) = intersect_edge_z(v0x, v0y, v0z, v1x, v1y, v1z, z_slice) {
            points.push(p);
        }
        if let Some(p) = intersect_edge_z(v1x, v1y, v1z, v2x, v2y, v2z, z_slice) {
            points.push(p);
        }
        if let Some(p) = intersect_edge_z(v2x, v2y, v2z, v0x, v0y, v0z, z_slice) {
            points.push(p);
        }

        if points.len() == 2 {
            let a = (points[0].0, -points[0].1);
            let b = (points[1].0, -points[1].1);
            segments.push((a, b));
        }
    }

    build_loops(&segments)
}

/// Slice a caller-supplied subset of triangles at Z height and rasterize to an
/// RLE mask. Same per-layer semantics as `rasterize_for_island_scan`, but the
/// triangle set is provided by the caller (the streaming pipeline passes only
/// the triangles whose Z-bucket intersects the layer's slice plane).
pub(crate) fn rasterize_triangles_for_island_scan(
    triangles: &[&Triangle],
    z: f64,
    grid_width: i32,
    grid_height: i32,
    origin_x: f64,
    origin_z: f64,
    px_mm: f64,
) -> RleMask {
    let loops = slice_to_loops_from_slice(triangles, z);
    let dense = rasterize_loops(
        &loops,
        grid_width as usize,
        grid_height as usize,
        origin_x,
        origin_z,
        px_mm,
    );
    rle_encode(&dense, grid_width, grid_height)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::parse_triangles;
    use crate::model::{Connectivity, GridRef, IslandScanJob};
    use crate::pipeline::run_island_scan;
    use crate::stream::run_island_scan_streaming;

    #[test]
    fn batch_rasterize_matches_stream_on_bucket_boundary_horizontal_cap() {
        // Model height 0.350001 mm at 0.05 mm layers -> ceil(7.00002) = 8 layers.
        // Bucket 3 boundary sits at 3 * (0.350001 / 7) ≈ 0.15000043 mm, while
        // layer 2's slice plane sits at z_slice = 3 * 0.05 + 1.1e-5 = 0.150011 mm.
        // A horizontal cap box spanning z ∈ [0.150005, 0.150020] (bottom cap within
        // 5e-6 < 1e-5 of the boundary) is intersected by layer 2's slice plane and
        // must produce non-empty RLE coverage matching stream.rs.
        let px_mm = 1.0_f64;
        let layer_height_mm = 0.05_f64;
        let bbox_min_z = 0.0_f64;
        let bbox_max_z = 0.350001_f64;

        let mut flat: Vec<f32> = Vec::new();
        for (x0, x1, y0, y1, z0, z1) in [
            (5.0_f32, 10.0_f32, 5.0_f32, 10.0_f32, 0.0_f32, 0.350001_f32),
            (20.0_f32, 26.0_f32, 10.0_f32, 16.0_f32, 0.150005_f32, 0.150020_f32),
        ] {
            flat.extend_from_slice(&[x0, y0, z0, x0, y1, z0, x0, y1, z1]);
            flat.extend_from_slice(&[x0, y0, z0, x0, y1, z1, x0, y0, z1]);
            flat.extend_from_slice(&[x1, y0, z0, x1, y1, z0, x1, y1, z1]);
            flat.extend_from_slice(&[x1, y0, z0, x1, y1, z1, x1, y0, z1]);
            flat.extend_from_slice(&[x0, y0, z0, x1, y0, z0, x1, y0, z1]);
            flat.extend_from_slice(&[x0, y0, z0, x1, y0, z1, x0, y0, z1]);
            flat.extend_from_slice(&[x0, y1, z0, x1, y1, z0, x1, y1, z1]);
            flat.extend_from_slice(&[x0, y1, z0, x1, y1, z1, x0, y1, z1]);
            // Downward (-Z) and upward (+Z) horizontal caps
            flat.extend_from_slice(&[x0, y0, z0, x1, y1, z0, x1, y0, z0]);
            flat.extend_from_slice(&[x0, y0, z0, x0, y1, z0, x1, y1, z0]);
            flat.extend_from_slice(&[x0, y0, z1, x1, y0, z1, x1, y1, z1]);
            flat.extend_from_slice(&[x0, y0, z1, x1, y1, z1, x0, y1, z1]);
        }
        let triangles = parse_triangles(&flat);

        let (batch_masks, gw, gh, num_layers, ox, oz) = rasterize_for_island_scan(
            &triangles,
            0.0,
            40.0,
            0.0,
            40.0,
            bbox_min_z,
            bbox_max_z,
            px_mm,
            layer_height_mm,
        );
        assert_eq!(num_layers, 8);

        let has_cap_coverage = |mask: &RleMask| -> bool {
            mask.rows.iter().any(|row| {
                row.iter()
                    .any(|run| run.start >= 19 && run.start < 27 && run.length > 0)
            })
        };
        assert!(
            has_cap_coverage(&batch_masks[2]),
            "layer 2 batch mask must capture the boundary horizontal cap: {:?}",
            batch_masks[2]
        );

        let job = IslandScanJob {
            px_mm,
            support_buffer_mm: 0.0,
            connectivity: Connectivity::Four,
            min_island_area_mm2: 0.0,
            layer_height_mm,
            grid: GridRef {
                origin_x: ox,
                origin_z: oz,
                width: gw,
                height: gh,
                px_mm,
            },
            num_layers: num_layers as u32,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: true,
        };
        let batch_scan = run_island_scan(&job, &batch_masks, None);
        let stream_scan =
            run_island_scan_streaming(&job, &triangles, bbox_min_z, bbox_max_z, true, None);

        assert_eq!(
            batch_scan.island_labels_per_layer,
            stream_scan.island_labels_per_layer,
            "batch rasterize + scan must match stream.rs on bucket boundary horizontal cap"
        );
    }
}
