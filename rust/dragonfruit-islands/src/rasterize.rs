//! Island scan rasterizer — produces per-layer RLE masks from triangles.
//!
//! Delegates scanline slicing and rasterization to `dragonfruit_slicing_engine::raster`
//! using oriented non-zero winding with defective-row matched-pair repair and
//! coalesced per-row RLE spans (zero dense intermediate allocation).

use crate::geometry::Triangle;
use crate::model::{RleMask, RleRun};

const EPS: f64 = 1e-6;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Rasterize all layers from triangles for island detection.
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

            // Slice & rasterize only triangles from this Z-bucket
            let bucket_tris: Vec<&Triangle> = z_buckets[l]
                .iter()
                .map(|&ti| &triangles[ti as usize])
                .collect();
            rasterize_triangles_for_island_scan(
                &bucket_tris,
                z,
                grid_width,
                grid_height,
                origin_x,
                origin_z,
                px_mm,
            )
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
    let z_slice = z + 1e-5;
    let mut mask = RleMask::empty(grid_width, grid_height);
    if grid_width <= 0 || grid_height <= 0 || triangles.is_empty() {
        return mask;
    }
    dragonfruit_slicing_engine::raster::rasterize_triangles_at_z_nonzero_spans(
        triangles,
        z_slice,
        origin_x,
        origin_z,
        px_mm,
        grid_width as usize,
        grid_height as usize,
        true, // mask Y = -world Y; row r center is origin_z + (r + 0.5) * px_mm
        |row, spans| {
            let row_runs = &mut mask.rows[row];
            row_runs.reserve(spans.len());
            for &(start, end) in spans {
                row_runs.push(RleRun {
                    start: start as i32,
                    length: (end - start + 1) as i32,
                });
            }
        },
    );
    mask
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

    fn push_oriented_box(
        flat: &mut Vec<f32>,
        x0: f32,
        x1: f32,
        y0: f32,
        y1: f32,
        z0: f32,
        z1: f32,
        outward: bool,
    ) {
        let v = [
            [x0, y0, z0],
            [x1, y0, z0],
            [x1, y1, z0],
            [x0, y1, z0],
            [x0, y0, z1],
            [x1, y0, z1],
            [x1, y1, z1],
            [x0, y1, z1],
        ];
        let faces = [
            [0usize, 3, 2],
            [0, 2, 1],
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
        for [a, b, c] in faces {
            let (b, c) = if outward { (b, c) } else { (c, b) };
            flat.extend_from_slice(&v[a]);
            flat.extend_from_slice(&v[b]);
            flat.extend_from_slice(&v[c]);
        }
    }

    fn push_ccw_tri_prism(flat: &mut Vec<f32>, pts: [(f32, f32); 3], z0: f32, z1: f32) {
        let [p0, p1, p2] = pts;
        // Bottom (-Z)
        flat.extend_from_slice(&[p0.0, p0.1, z0, p2.0, p2.1, z0, p1.0, p1.1, z0]);
        // Top (+Z)
        flat.extend_from_slice(&[p0.0, p0.1, z1, p1.0, p1.1, z1, p2.0, p2.1, z1]);
        // Sides (outward for CCW base)
        for i in 0..3 {
            let a = pts[i];
            let b = pts[(i + 1) % 3];
            flat.extend_from_slice(&[a.0, a.1, z0, b.0, b.1, z0, b.0, b.1, z1]);
            flat.extend_from_slice(&[a.0, a.1, z0, b.0, b.1, z1, a.0, a.1, z1]);
        }
    }

    fn is_pixel_on(mask: &RleMask, col: i32, row: usize) -> bool {
        mask.rows[row]
            .iter()
            .any(|run| col >= run.start && col < run.start + run.length)
    }

    #[test]
    fn fld01_enclosed_inner_air_cavity_remains_hollow_no_phantom_island() {
        let mut flat = Vec::new();
        push_oriented_box(&mut flat, 0.0, 20.0, 0.0, 20.0, 0.0, 10.0, true);
        push_oriented_box(&mut flat, 6.0, 14.0, 6.0, 14.0, 2.0, 8.0, false);
        let triangles = parse_triangles(&flat);

        let px_mm = 1.0_f64;
        let layer_height_mm = 1.0_f64;
        let (masks, gw, gh, num_layers, ox, oz) = rasterize_for_island_scan(
            &triangles,
            0.0,
            20.0,
            0.0,
            20.0,
            0.0,
            10.0,
            px_mm,
            layer_height_mm,
        );
        assert_eq!(num_layers, 10);

        for l in 3..=6 {
            assert_eq!(
                masks[l].pixel_count(),
                336,
                "layer {l} must have exact 400 - 64 = 336 solid pixels"
            );
            for row in 0..20 {
                for col in 0..20 {
                    let in_cavity = (6..14).contains(&row) && (6..14).contains(&col);
                    assert_eq!(
                        is_pixel_on(&masks[l], col, row),
                        !in_cavity,
                        "layer {l} pixel ({col}, {row}) cavity mismatch"
                    );
                }
            }
        }

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
        let stream_scan =
            run_island_scan_streaming(&job, &triangles, 0.0, 10.0, false, None);
        let phantom_cavity_islands: Vec<_> = stream_scan
            .islands
            .iter()
            .filter(|isl| (2..7).contains(&isl.first_layer))
            .collect();
        assert!(
            phantom_cavity_islands.is_empty(),
            "hollow cavity layers 2..7 must have 0 phantom islands, got: {phantom_cavity_islands:?}"
        );
        let roof_islands: Vec<_> = stream_scan
            .islands
            .iter()
            .filter(|isl| isl.first_layer == 7)
            .collect();
        assert_eq!(roof_islands.len(), 1, "roof closure at layer 7 must emit 1 ceiling island");
        assert_eq!(
            roof_islands[0].per_layer_area_mm2.get(&7).copied(),
            Some(64.0),
            "roof ceiling island area over 8x8 pocket must equal 64 mm^2"
        );
    }

    #[test]
    fn fld02_overlapping_lobes_and_pinch_vertex_stay_solid_with_coalesced_rle() {
        // Part A1: shared-vertex overlapping L-fold (shares (2,4) & (12,10), tripping pre-Phase-B build_loops)
        // plus nested same-winding solid core (outward outer + outward inner -> +2 remains solid 400 px).
        let mut flat_a = Vec::new();
        push_oriented_box(&mut flat_a, 2.0, 12.0, 4.0, 16.0, 0.0, 2.0, true);
        push_oriented_box(&mut flat_a, 2.0, 18.0, 4.0, 10.0, 0.0, 2.0, true);
        let tris_a = parse_triangles(&flat_a);
        let (masks_a, _, _, _, _, _) = rasterize_for_island_scan(
            &tris_a, 0.0, 20.0, 0.0, 20.0, 0.0, 2.0, 1.0, 1.0,
        );
        // rows 4..10 map to world Y in (10, 16] (box 1 [2, 12]), rows 10..16 map to world Y in (4, 10] (union [2, 18])
        for row in 4..10 {
            assert_eq!(
                masks_a[0].rows[row],
                vec![RleRun { start: 2, length: 10 }],
                "upper shared-vertex row {row} must coalesce"
            );
        }
        for row in 10..16 {
            assert_eq!(
                masks_a[0].rows[row],
                vec![RleRun { start: 2, length: 16 }],
                "overlapping bottom row {row} must coalesce into 1 run without XOR void"
            );
        }
        for row in (0..4).chain(16..20) {
            assert!(masks_a[0].rows[row].is_empty());
        }

        // Part A2: same-winding nested solid inner box (outward + outward -> +2 winding stays solid)
        let mut flat_nested = Vec::new();
        push_oriented_box(&mut flat_nested, 0.0, 20.0, 0.0, 20.0, 0.0, 2.0, true);
        push_oriented_box(&mut flat_nested, 6.0, 14.0, 6.0, 14.0, 0.0, 2.0, true);
        let tris_nested = parse_triangles(&flat_nested);
        let (masks_nested, _, _, _, _, _) = rasterize_for_island_scan(
            &tris_nested, 0.0, 20.0, 0.0, 20.0, 0.0, 2.0, 1.0, 1.0,
        );
        assert_eq!(masks_nested[0].pixel_count(), 400);
        for row in 0..20 {
            assert_eq!(masks_nested[0].rows[row], vec![RleRun { start: 0, length: 20 }]);
        }

        // Part B: two triangular prisms kissing cleanly at shared pinch vertex (10.0, 10.0)
        let mut flat_b = Vec::new();
        push_ccw_tri_prism(&mut flat_b, [(4.0, 4.0), (10.0, 10.0), (4.0, 16.0)], 0.0, 2.0);
        push_ccw_tri_prism(&mut flat_b, [(10.0, 10.0), (16.0, 4.0), (16.0, 16.0)], 0.0, 2.0);
        let tris_b = parse_triangles(&flat_b);
        let (masks_b, _, _, _, _, _) = rasterize_for_island_scan(
            &tris_b, 0.0, 20.0, 0.0, 20.0, 0.0, 2.0, 1.0, 1.0,
        );
        for row in 0..20 {
            let cy = 20.0 - (row as f64 + 0.5);
            for col in 0..20 {
                let cx = col as f64 + 0.5;
                let expected = cy >= 4.0
                    && cy <= 16.0
                    && ((cx >= 4.0 && cx < 10.0 - (cy - 10.0).abs())
                        || (cx >= 10.0 + (cy - 10.0).abs() && cx < 16.0));
                assert_eq!(
                    is_pixel_on(&masks_b[0], col, row),
                    expected,
                    "bowtie pinch pixel ({col}, {row}) center=({cx}, {cy}) expected={expected}"
                );
            }
        }
    }

    #[test]
    fn mir07_issue_1017_vertex_on_slice_plane_preserves_segment() {
        let z_seam = (1.0_f64 + 1e-6 + 1e-5) as f32;
        let mut flat = Vec::new();
        // Bottom z = 0 (-Z) and Top z = 10 (+Z)
        flat.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0]);
        flat.extend_from_slice(&[0.0, 0.0, 0.0, 10.0, 10.0, 0.0, 10.0, 0.0, 0.0]);
        flat.extend_from_slice(&[0.0, 0.0, 10.0, 10.0, 0.0, 10.0, 10.0, 10.0, 10.0]);
        flat.extend_from_slice(&[0.0, 0.0, 10.0, 10.0, 10.0, 10.0, 0.0, 10.0, 10.0]);
        // x = 0 wall (-X) split at S1 = (0, 10, z_seam)
        flat.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 0.0, 10.0, 0.0, 10.0, z_seam]);
        flat.extend_from_slice(&[0.0, 0.0, 0.0, 0.0, 10.0, z_seam, 0.0, 10.0, 0.0]);
        flat.extend_from_slice(&[0.0, 10.0, z_seam, 0.0, 0.0, 10.0, 0.0, 10.0, 10.0]);
        // y = 10 wall (+Y) shares S1 = (0, 10, z_seam)
        flat.extend_from_slice(&[10.0, 10.0, 0.0, 0.0, 10.0, z_seam, 0.0, 10.0, 0.0]);
        flat.extend_from_slice(&[10.0, 10.0, 0.0, 10.0, 10.0, 10.0, 0.0, 10.0, z_seam]);
        flat.extend_from_slice(&[0.0, 10.0, z_seam, 0.0, 10.0, 10.0, 10.0, 10.0, 10.0]);
        // x = 10 wall (+X) split at S2 = (10, 0, z_seam)
        flat.extend_from_slice(&[10.0, 0.0, z_seam, 10.0, 0.0, 0.0, 10.0, 10.0, 0.0]);
        flat.extend_from_slice(&[10.0, 0.0, z_seam, 10.0, 10.0, 0.0, 10.0, 10.0, 10.0]);
        flat.extend_from_slice(&[10.0, 0.0, z_seam, 10.0, 10.0, 10.0, 10.0, 0.0, 10.0]);
        // y = 0 wall (-Y) shares S2 = (10, 0, z_seam)
        flat.extend_from_slice(&[0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 0.0, z_seam]);
        flat.extend_from_slice(&[0.0, 0.0, 0.0, 10.0, 0.0, z_seam, 0.0, 0.0, 10.0]);
        flat.extend_from_slice(&[10.0, 0.0, z_seam, 10.0, 0.0, 10.0, 0.0, 0.0, 10.0]);

        let triangles = parse_triangles(&flat);
        let px_mm = 1.0_f64;
        let layer_height_mm = 1.0_f64;
        let (masks, gw, gh, num_layers, ox, oz) = rasterize_for_island_scan(
            &triangles,
            0.0,
            10.0,
            0.0,
            10.0,
            0.0,
            10.0,
            px_mm,
            layer_height_mm,
        );
        assert_eq!(num_layers, 10);
        assert_eq!(masks[0].pixel_count(), 100, "layer 0 must be completely solid");
        assert_eq!(masks[1].pixel_count(), 100, "layer 1 must be completely solid");

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
            candidate_only: false,
        };
        let stream_scan =
            run_island_scan_streaming(&job, &triangles, 0.0, 10.0, false, None);
        let mid_air: Vec<_> = stream_scan
            .islands
            .iter()
            .filter(|isl| isl.first_layer > 0)
            .collect();
        assert!(
            mid_air.is_empty(),
            "expected 0 mid-air islands above layer 0, got: {mid_air:?}"
        );
    }

    #[test]
    fn nbr04_subvoxel_origin_and_world_y_center_alignment() {
        // Non-unit px_mm = 0.25 on asymmetric padded bbox [0.0, 2.0] x [0.0, 2.0] x [0.0, 2.0]
        // with anchor [0.0, 0.5] x [0.0, 0.5] x [0.0, 2.0] and elevated 2x1 strip [0.5, 1.0] x [1.0, 1.25] x [0.6, 2.0]
        // -> col = 2..3 (x = 0.625, 0.875), row = 3 (y = 1.125), born at layer 1 (zTop = 1.000001).
        let mut flat = Vec::new();
        push_oriented_box(&mut flat, 0.0, 0.5, 0.0, 0.5, 0.0, 2.0, true);
        push_oriented_box(&mut flat, 0.5, 1.0, 1.0, 1.25, 0.6, 2.0, true);
        let triangles = parse_triangles(&flat);

        let px_mm = 0.25_f64;
        let layer_height_mm = 0.5_f64;
        let (masks, gw, gh, num_layers, ox, oz) = rasterize_for_island_scan(
            &triangles,
            0.0,
            2.0,
            0.0,
            2.0,
            0.0,
            2.0,
            px_mm,
            layer_height_mm,
        );
        assert_eq!(ox, 0.0);
        assert_eq!(oz, -2.0);
        assert_eq!(gw, 8);
        assert_eq!(gh, 8);
        assert_eq!(num_layers, 4);
        assert_eq!(masks[1].rows[3], vec![RleRun { start: 2, length: 2 }]);

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
        let scan = run_island_scan(&job, &masks, None);
        let elevated_idx = scan
            .islands
            .iter()
            .position(|isl| isl.first_layer == 1)
            .expect("elevated layer-1 island present");
        let seed = scan.islands[elevated_idx].seed_voxel.expect("seed_voxel present");
        assert_eq!(seed.x, 2.5);
        assert_eq!(seed.y, 3.0);
        assert_eq!(seed.z, 1.0);
        assert_eq!(
            scan.grid.pixel_center_to_world_xy(seed.x, seed.y),
            (0.75, 1.125)
        );

        let footprints = scan.extract_first_layer_footprints_world_f32();
        assert_eq!(
            footprints[elevated_idx],
            vec![0.625_f32, 1.125_f32, 0.875_f32, 1.125_f32],
            "first-layer world footprints must preserve exact f64->f32 +0.5*px_mm center mapping"
        );
    }
}
