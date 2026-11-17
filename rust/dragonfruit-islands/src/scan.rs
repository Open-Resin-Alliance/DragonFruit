//! Per-layer scan Domain Service — stateless island candidate detection.
//!
//! Ported from `IslandScan/island.ts`.

use crate::model::*;
use crate::rle::{
    mark_detached_and_rescue_candidates, rle_intersect_dilated, rle_label_components, rle_subtract,
};

/// Scan a single layer to identify unsupported island candidates.
///
/// Logic:
/// 1. `Supported = Current AND Dilate(Prev, buffer)`
/// 2. `Candidates = Current MINUS Supported`
/// 3. `Labels = ConnectedComponents(Candidates)`
/// 4. Classify solid-component `is_detached` via Chebyshev-1 against `Prev`
///    and rescue any detached solid runs clipped by a neighbor wall's `B`-px halo.
pub fn scan_layer(
    current: &RleMask,
    prev: Option<&RleMask>,
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: Connectivity,
) -> ScanLayerResult {
    match prev {
        None => {
            // First layer: everything is a candidate and has no polymer below.
            let island_candidates = current.clone();
            let (labels, mut components) = rle_label_components(&island_candidates, connectivity);
            for comp in &mut components {
                comp.is_detached = true;
            }
            ScanLayerResult {
                labels,
                components,
                solid_mask: current.clone(),
            }
        }
        Some(prev_mask) => {
            let buffer_px = (support_buffer_mm / px_mm).round().max(0.0) as i32;
            let supported = rle_intersect_dilated(current, prev_mask, buffer_px);
            let mut island_candidates = rle_subtract(current, &supported);
            let (mut labels, mut components) =
                rle_label_components(&island_candidates, connectivity);
            mark_detached_and_rescue_candidates(
                current,
                prev_mask,
                &mut island_candidates,
                &mut labels,
                &mut components,
                connectivity,
            );
            ScanLayerResult {
                labels,
                components,
                solid_mask: current.clone(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::scan::*;
    use crate::rle::rle_encode;

    #[test]
    fn first_layer_all_candidates() {
        let w = 5;
        let h = 3;
        #[rustfmt::skip]
        let data: Vec<u8> = vec![
            0,1,1,0,0,
            0,1,1,0,0,
            0,0,0,0,0,
        ];
        let mask = rle_encode(&data, w, h);
        let result = scan_layer(&mask, None, 0.05, 0.1, Connectivity::Four);

        // First layer: all solid pixels are candidates
        assert_eq!(result.components.len(), 1);
        assert_eq!(result.components[0].area_px, 4);
        assert!(result.components[0].is_detached);
    }

    #[test]
    fn supported_pixels_removed() {
        let w = 6;
        let h = 1;
        // prev: pixels 1-4 are solid
        let prev = RleMask {
            rows: vec![vec![RleRun {
                start: 1,
                length: 4,
            }]],
            width: w,
            height: h,
        };
        // current: pixels 0-5 are solid (wider than prev)
        let current = RleMask {
            rows: vec![vec![RleRun {
                start: 0,
                length: 6,
            }]],
            width: w,
            height: h,
        };

        // buffer=0: only exact overlap is supported
        let result = scan_layer(&current, Some(&prev), 1.0, 0.0, Connectivity::Four);

        // Candidates should be pixels 0 and 5 (the overhangs)
        assert_eq!(result.components.len(), 2);
        let total_area: i32 = result.components.iter().map(|c| c.area_px).sum();
        assert_eq!(total_area, 2);
    }

    #[test]
    fn buffer_expands_support() {
        let w = 10;
        let h = 1;
        // prev: pixels 3-6 are solid
        let prev = RleMask {
            rows: vec![vec![RleRun {
                start: 3,
                length: 4,
            }]],
            width: w,
            height: h,
        };
        // current: pixels 2-7 are solid
        let current = RleMask {
            rows: vec![vec![RleRun {
                start: 2,
                length: 6,
            }]],
            width: w,
            height: h,
        };

        // buffer=1px: dilated prev covers 2-7, so all current pixels are supported
        let result = scan_layer(&current, Some(&prev), 1.0, 1.0, Connectivity::Four);
        assert_eq!(result.components.len(), 0);
    }

    #[test]
    fn c2_moat_trap_rescues_detached_needle_inside_neighbor_wall_halo() {
        let w = 20;
        let h = 10;
        let mut prev_data = vec![0u8; (w * h) as usize];
        for y in 2..8 {
            for x in 1..5 {
                prev_data[(y * w + x) as usize] = 1;
            }
        }
        let prev = rle_encode(&prev_data, w, h);

        // Wall continues + completely detached needle at x=7..9, y=4..6 (2px gap, inside B=5 halo)
        let mut curr_data = prev_data.clone();
        for y in 4..6 {
            for x in 7..9 {
                curr_data[(y * w + x) as usize] = 1;
            }
        }
        let curr = rle_encode(&curr_data, w, h);

        let result = scan_layer(&curr, Some(&prev), 0.05, 0.25, Connectivity::Eight);
        assert_eq!(result.components.len(), 1, "detached needle must be rescued from wall halo");
        assert_eq!(result.components[0].area_px, 4);
        assert!(result.components[0].is_detached);
    }

    #[test]
    fn c2_moat_trap_partially_clipped_detached_island_rescues_full_footprint() {
        let w = 20;
        let h = 10;
        let mut prev_data = vec![0u8; (w * h) as usize];
        for y in 2..8 {
            for x in 1..5 {
                prev_data[(y * w + x) as usize] = 1;
            }
        }
        let prev = rle_encode(&prev_data, w, h);

        // Detached island x=7..13, y=4..6 (12px total; x=7..10 inside B=5 halo, x=10..13 outside)
        let mut curr_data = prev_data.clone();
        for y in 4..6 {
            for x in 7..13 {
                curr_data[(y * w + x) as usize] = 1;
            }
        }
        let curr = rle_encode(&curr_data, w, h);

        let result = scan_layer(&curr, Some(&prev), 0.05, 0.25, Connectivity::Eight);
        assert_eq!(result.components.len(), 1);
        assert_eq!(result.components[0].area_px, 12, "full detached solid footprint must be rescued");
        assert!(result.components[0].is_detached);
    }

    #[test]
    fn c2_diagonal_bridge_to_prev_solid_is_not_detached_and_not_rescued() {
        let w = 20;
        let h = 10;
        let mut prev_data = vec![0u8; (w * h) as usize];
        prev_data[(3 * w + 3) as usize] = 1;
        let prev = rle_encode(&prev_data, w, h);

        // Solid component touching (3, 3) diagonally at (4, 4), extending to x=4..12, y=4..6 (16px)
        let mut curr_data = vec![0u8; (w * h) as usize];
        for y in 4..6 {
            for x in 4..12 {
                curr_data[(y * w + x) as usize] = 1;
            }
        }
        let curr = rle_encode(&curr_data, w, h);

        // Chebyshev-1 diagonal bridge at (4, 4) anchors the solid component, so B=5 supported pixels stay suppressed
        let result = scan_layer(&curr, Some(&prev), 0.05, 0.25, Connectivity::Eight);
        assert_eq!(result.components.len(), 1);
        assert!(!result.components[0].is_detached, "Chebyshev-1 diagonal bridge must NOT be detached");
        assert!(
            result.components[0].area_px < 16,
            "bridged cantilever must NOT be rescued across B=5 halo (got area_px={})",
            result.components[0].area_px
        );

        // Under 4-connectivity, (4, 4) bridges to (3, 3) while diagonal (5, 5) is separate in S_L and detached
        let mut four_curr_data = vec![0u8; (w * h) as usize];
        four_curr_data[(4 * w + 4) as usize] = 1;
        four_curr_data[(5 * w + 5) as usize] = 1;
        let four_curr = rle_encode(&four_curr_data, w, h);
        let four_res = scan_layer(&four_curr, Some(&prev), 0.05, 0.25, Connectivity::Four);
        assert_eq!(four_res.components.len(), 1);
        assert_eq!(four_res.components[0].area_px, 1);
        assert!(four_res.components[0].is_detached);
    }
}
