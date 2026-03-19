//! Per-layer scan Domain Service — stateless island candidate detection.
//!
//! Ported from `IslandScan/island.ts`.

use crate::model::*;
use crate::rle::{rle_intersect_dilated, rle_label_components, rle_subtract};

/// Scan a single layer to identify unsupported island candidates.
///
/// Logic:
/// 1. `Supported = Current AND Dilate(Prev, buffer)`
/// 2. `Candidates = Current MINUS Supported`
/// 3. `Labels = ConnectedComponents(Candidates)`
pub fn scan_layer(
    current: &RleMask,
    prev: Option<&RleMask>,
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: Connectivity,
) -> ScanLayerResult {
    let island_candidates = match prev {
        None => {
            // First layer: everything is a candidate (no support below)
            current.clone()
        }
        Some(prev_mask) => {
            let buffer_px = (support_buffer_mm / px_mm).round().max(0.0) as i32;
            let supported = rle_intersect_dilated(current, prev_mask, buffer_px);
            rle_subtract(current, &supported)
        }
    };

    let (labels, components) = rle_label_components(&island_candidates, connectivity);

    ScanLayerResult {
        labels,
        components,
        solid_mask: current.clone(),
    }
}

#[cfg(test)]
mod tests {
    use crate::model::*;
    use crate::scan::*;
    use crate::rle::*;
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
}
