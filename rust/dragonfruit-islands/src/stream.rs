use crate::model::*;
use crate::pipeline::postprocess;
use crate::rasterize::rasterize_triangles_for_island_scan;
use crate::scan::scan_layer;
use crate::tracker::IslandTracker;
use dragonfruit_slicing_engine::geometry::Triangle;

const EPS: f64 = 1e-6;

/// Run the island scan using a streaming pipeline.
///
/// Slicing and rasterization are performed sequentially, keeping only the
/// current and previous layer masks in memory.
///
/// - `job`: The island scan configuration.
/// - `triangles`: The parsed model triangles.
/// - `bbox_min_z`: The Z minimum of the model.
/// - `bbox_max_z`: The Z maximum of the model.
/// - `store_labels`: If true, the full 3D labels volume `island_labels_per_layer`
///   is retained and returned (used for Volume Analysis visual overlays).
///   If false, masks are immediately discarded to achieve O(1) memory scalability.
/// - `on_progress`: Progress callback.
pub fn run_island_scan_streaming(
    job: &IslandScanJob,
    triangles: &[Triangle],
    bbox_min_z: f64,
    bbox_max_z: f64,
    store_labels: bool,
    on_progress: Option<&(dyn Fn(u32, u32) + Sync)>,
) -> IslandScanResult {
    let num_layers = job.num_layers as usize;

    let mut tracker = IslandTracker::new(
        job.px_mm,
        job.min_overlap_px,
        job.overlap_neighborhood_px,
    );

    // ── Pre-index triangles into Z-buckets (mirrors rasterize_for_island_scan) ──
    // Each triangle goes into every bucket whose Z-band its span overlaps, so a
    // layer only slices triangles whose Z-span can intersect its slice plane
    // instead of iterating all triangles (O(L × T) → O(L × T/L)).
    //
    // The span is expanded by Z_TOL (layer offset 1e-6 + slice epsilon 1e-5 +
    // 10*EPS) so bucket membership is a strict superset of the triangles that
    // can contribute segments at a layer's slice plane — the per-layer slice
    // stays bit-identical to the un-bucketed path (same slice z formula, EPS,
    // loop stitching, and mask semantics; extra triangles are filtered by the
    // same above/below checks inside the slicer).
    const Z_TOL: f64 = 3.0e-5;
    let z_range = bbox_max_z - bbox_min_z;
    let num_z_buckets = num_layers.max(1);
    let mut z_buckets: Vec<Vec<u32>> = vec![Vec::new(); num_z_buckets];
    for (ti, tri) in triangles.iter().enumerate() {
        let tri_min_z = tri.a.z.min(tri.b.z).min(tri.c.z) as f64;
        let tri_max_z = tri.a.z.max(tri.b.z).max(tri.c.z) as f64;
        if tri_max_z + Z_TOL < bbox_min_z || tri_min_z - Z_TOL > bbox_max_z {
            continue; // triangle entirely outside model Z range
        }
        let b_start = if z_range > EPS {
            (((tri_min_z - Z_TOL - bbox_min_z) / z_range) * (num_z_buckets as f64 - 1.0))
                .floor()
                .max(0.0) as usize
        } else {
            0
        };
        let b_end = if z_range > EPS {
            (((tri_max_z + Z_TOL - bbox_min_z) / z_range) * (num_z_buckets as f64 - 1.0))
                .ceil()
                .min(num_z_buckets as f64 - 1.0) as usize
        } else {
            num_z_buckets - 1
        };
        for b in b_start..=b_end {
            z_buckets[b].push(ti as u32);
        }
    }

    let mut prev_mask: Option<RleMask> = None;
    let mut prev_island_labels: Option<RleLabels> = None;
    let mut island_labels_per_layer = Vec::with_capacity(if store_labels { num_layers } else { 0 });

    for l in 0..num_layers {
        // Match TS: z = zOffset + (idx + 1) * layerHeight + 1e-6
        let z = bbox_min_z + (l as f64 + 1.0) * job.layer_height_mm + 1e-6;

        // 1. Slice and rasterize the current layer — only triangles whose
        //    Z-span can intersect this layer's slice plane.
        let bucket_tris: Vec<&Triangle> = z_buckets[l]
            .iter()
            .map(|&ti| &triangles[ti as usize])
            .collect();
        let current_mask = rasterize_triangles_for_island_scan(
            &bucket_tris,
            z,
            job.grid.width,
            job.grid.height,
            job.grid.origin_x,
            job.grid.origin_z,
            job.px_mm,
        );

        // 2. Scan candidates against previous layer
        let lr = scan_layer(
            &current_mask,
            prev_mask.as_ref(),
            job.px_mm,
            job.support_buffer_mm,
            job.connectivity,
        );

        // 3. Track islands sequentially
        let island_labels = tracker.process_layer(
            l as u32,
            &lr.labels,
            &lr.components,
            prev_island_labels.as_ref(),
            &lr.solid_mask,
            job.candidate_only,
        );

        // 4. Update window (older layers are dropped from memory here)
        prev_mask = Some(current_mask);
        prev_island_labels = Some(island_labels.clone());

        if store_labels {
            island_labels_per_layer.push(island_labels);
        }

        if let Some(cb) = on_progress {
            cb(l as u32 + 1, num_layers as u32);
        }
    }

    tracker.finalize_islands(num_layers.saturating_sub(1) as u32);

    // Phase 3: Volume calculation, max-area, placeholder resolution, and
    // min-area filtering — shared with the batch pipeline.
    postprocess(
        job.grid.clone(),
        tracker.get_islands(),
        island_labels_per_layer,
        job.layer_height_mm,
        job.min_island_area_mm2,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::parse_triangles;
    use crate::model::Connectivity;

    #[test]
    fn test_streaming_cube() {
        // Minimal valid job setup
        let job = IslandScanJob {
            px_mm: 0.05,
            support_buffer_mm: 0.1,
            connectivity: Connectivity::Four,
            min_island_area_mm2: 0.0001,
            layer_height_mm: 0.05,
            grid: GridRef {
                origin_x: 0.0,
                origin_z: 0.0,
                width: 5,
                height: 5,
                px_mm: 0.05,
            },
            num_layers: 3,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: false,
        };

        // No triangles means empty scan result
        let result = run_island_scan_streaming(&job, &[], 0.0, 1.0, false, None);
        assert!(result.islands.is_empty());
    }

    #[test]
    fn z_bucket_streaming_matches_unbucketed_reference() {
        // Parity check for the Z-bucket optimization: the per-layer rasterized
        // masks (and the resulting island labels) must be bit-identical to the
        // un-bucketed path (every triangle tested at every layer).
        //
        // Mesh layout (grid 40×40, px_mm = 1.0, origin at (0,0)):
        //   - Cube A:  XY [5,10]×[5,10], z [0, 0.35]  — spans all 8 layers.
        //   - Cube B:  XY [15,20]×[5,10], z [0.1, 0.2] — middle layers.
        //   - Sliver box:  XY [30,32]×[5,8], z-span [0.1500005, 0.1500205].
        //     Its bottom face sits just ABOVE the bucket-2 band boundary
        //     (0.15 = 3·z_range/7 for 8 buckets over 0..0.35) while its side
        //     walls are cut by layer 2's slice plane (z = 0.150011), giving a
        //     visible ~2×3 px footprint. Without the bucket tolerance
        //     expansion the box lands in bucket 3 only and layer 2's mask
        //     diverges from the un-bucketed reference.
        let px_mm = 1.0_f64;
        let layer_height_mm = 0.05_f64;
        let num_layers = 8_usize;
        let bbox_min_z = 0.0_f64;
        let bbox_max_z = 0.35_f64; // = (num_layers - 1) * layer_height_mm

        let mut flat: Vec<f32> = Vec::new();
        // Cube A + Cube B + sliver box: two quads per face
        for (x0, x1, y0, y1, z0, z1) in [
            (5.0_f32, 10.0_f32, 5.0_f32, 10.0_f32, 0.0_f32, 0.35_f32),
            (15.0_f32, 20.0_f32, 5.0_f32, 10.0_f32, 0.1_f32, 0.2_f32),
            (30.0_f32, 32.0_f32, 5.0_f32, 8.0_f32, 0.1500005, 0.1500205),
        ] {
            // faces at constant x
            flat.extend_from_slice(&[x0, y0, z0, x0, y1, z0, x0, y1, z1]);
            flat.extend_from_slice(&[x0, y0, z0, x0, y1, z1, x0, y0, z1]);
            flat.extend_from_slice(&[x1, y0, z0, x1, y1, z0, x1, y1, z1]);
            flat.extend_from_slice(&[x1, y0, z0, x1, y1, z1, x1, y0, z1]);
            // faces at constant y
            flat.extend_from_slice(&[x0, y0, z0, x1, y0, z0, x1, y0, z1]);
            flat.extend_from_slice(&[x0, y0, z0, x1, y0, z1, x0, y0, z1]);
            flat.extend_from_slice(&[x0, y1, z0, x1, y1, z0, x1, y1, z1]);
            flat.extend_from_slice(&[x0, y1, z0, x1, y1, z1, x0, y1, z1]);
            // faces at constant z (top/bottom — never intersect a slice plane)
            flat.extend_from_slice(&[x0, y0, z0, x1, y0, z0, x1, y1, z0]);
            flat.extend_from_slice(&[x0, y0, z0, x1, y1, z0, x0, y1, z0]);
            flat.extend_from_slice(&[x0, y0, z1, x1, y0, z1, x1, y1, z1]);
            flat.extend_from_slice(&[x0, y0, z1, x1, y1, z1, x0, y1, z1]);
        }
        let triangles = parse_triangles(&flat);

        let make_job = || IslandScanJob {
            px_mm,
            support_buffer_mm: 0.0,
            connectivity: Connectivity::Four,
            min_island_area_mm2: 0.0,
            layer_height_mm,
            grid: GridRef {
                origin_x: 0.0,
                origin_z: -10.0, // mask Y = -world Y (cubes span y 5..10)
                width: 40,
                height: 40,
                px_mm,
            },
            num_layers: num_layers as u32,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: false,
        };

        // Streaming (Z-bucketed) pipeline
        let stream_result = run_island_scan_streaming(
            &make_job(),
            &triangles,
            bbox_min_z,
            bbox_max_z,
            true,
            None,
        );

        // Un-bucketed reference: rasterize every layer against ALL triangles,
        // then run the batch pipeline over those masks.
        let all_tris: Vec<&Triangle> = triangles.iter().collect();
        let mut ref_masks = Vec::with_capacity(num_layers);
        for l in 0..num_layers {
            let z = bbox_min_z + (l as f64 + 1.0) * layer_height_mm + 1e-6;
            ref_masks.push(crate::rasterize::rasterize_triangles_for_island_scan(
                &all_tris,
                z,
                40,
                40,
                0.0,
                -10.0,
                px_mm,
            ));
        }
        let batch_result = crate::pipeline::run_island_scan(&make_job(), &ref_masks, None);

        // Sanity: the fixture actually exercises the boundary case — layer 2
        // must contain a footprint in the tilted-quad region (x 30..32), and
        // layers 1/3 must not.
        let has_quad_px = |mask: &RleMask| -> bool {
            mask.rows.iter().any(|row| {
                row.iter().any(|run| run.start >= 29 && run.start < 33 && run.length > 0)
            })
        };
        assert!(has_quad_px(&ref_masks[2]), "layer 2 must contain the quad footprint");
        assert!(!has_quad_px(&ref_masks[1]), "layer 1 must not contain the quad");
        assert!(!has_quad_px(&ref_masks[3]), "layer 3 must not contain the quad");

        // Bit-identical per-layer labels (includes placeholder reassignment).
        assert_eq!(
            stream_result.island_labels_per_layer,
            batch_result.island_labels_per_layer,
            "label masks differ between bucketed streaming and un-bucketed batch"
        );

        // Islands must match in content (normalize order — tracker HashMap order
        // is not guaranteed between instances).
        let mut stream_islands = stream_result.islands;
        let mut batch_islands = batch_result.islands;
        stream_islands.sort_by_key(|i| i.id.0);
        batch_islands.sort_by_key(|i| i.id.0);
        assert_eq!(stream_islands.len(), batch_islands.len());
        for (s, b) in stream_islands.iter().zip(batch_islands.iter()) {
            assert_eq!(s.id, b.id);
            assert_eq!(s.first_layer, b.first_layer);
            assert_eq!(s.last_layer, b.last_layer);
            assert_eq!(s.total_area_mm2, b.total_area_mm2);
            assert_eq!(s.per_layer_area_mm2, b.per_layer_area_mm2);
            assert_eq!(s.parent_id, b.parent_id);
            assert_eq!(s.is_merged_placeholder, b.is_merged_placeholder);
            assert_eq!(s.max_area_mm2, b.max_area_mm2);
            assert_eq!(s.max_area_layer, b.max_area_layer);
            // Volume sums may differ in the last ulp due to HashMap iteration
            // order; compare with a small relative tolerance.
            match (s.volume_mm3, b.volume_mm3) {
                (Some(sv), Some(bv)) => {
                    assert!((sv - bv).abs() <= 1e-9 * sv.abs().max(bv.abs()).max(1.0));
                }
                (None, None) => {}
                _ => panic!("volume presence differs"),
            }
        }
    }
}
