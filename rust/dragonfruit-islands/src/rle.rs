//! RLE Domain Service — stateless mask algebra.
//!
//! Ported from `IslandScan/rle.ts`. All operations are pure functions on
//! RLE Value Objects.

use crate::model::*;

// ---------------------------------------------------------------------------
// Encode / Decode
// ---------------------------------------------------------------------------

/// Encode a dense binary grid (0/non-0) into an `RleMask`.
pub fn rle_encode(data: &[u8], width: i32, height: i32) -> RleMask {
    let w = width as usize;
    let mut rows = Vec::with_capacity(height as usize);

    for y in 0..height as usize {
        let mut spans = Vec::new();
        let row_off = y * w;
        let mut run_start: Option<i32> = None;

        for x in 0..w {
            if data[row_off + x] != 0 {
                if run_start.is_none() {
                    run_start = Some(x as i32);
                }
            } else if let Some(s) = run_start {
                spans.push(RleRun {
                    start: s,
                    length: x as i32 - s,
                });
                run_start = None;
            }
        }
        if let Some(s) = run_start {
            spans.push(RleRun {
                start: s,
                length: width - s,
            });
        }
        rows.push(spans);
    }

    RleMask {
        rows,
        width,
        height,
    }
}

// ---------------------------------------------------------------------------
// Intersect Dilated: Result = A AND Dilate(B, buffer)
// ---------------------------------------------------------------------------

/// Compute `A AND Dilate(B, buffer)`.
///
/// Used to find "supported" regions: current layer pixels that overlap with
/// the dilated previous layer.
pub fn rle_intersect_dilated(a: &RleMask, b: &RleMask, buffer: i32) -> RleMask {
    if a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0 {
        return RleMask::empty(a.width.max(0), a.height.max(0));
    }

    let width = a.width;
    let height = a.height;
    let b_height = b.height.min(b.rows.len() as i32);
    if b_height <= 0 {
        return RleMask::empty(width, height);
    }

    let r = buffer.max(0);
    let rr = r as i64;
    let mut result_rows = Vec::with_capacity(height as usize);
    let valid_a_rows = height.min(a.rows.len() as i32);

    for y in 0..height {
        if y >= valid_a_rows {
            result_rows.push(Vec::new());
            continue;
        }
        let a_row = &a.rows[y as usize];
        if a_row.is_empty() {
            result_rows.push(Vec::new());
            continue;
        }

        // Gather relevant B rows within Euclidean disk [y - r, y + r]
        let start_y = y.saturating_sub(r).max(0);
        let end_y = y.saturating_add(r).min(b_height - 1);
        if start_y > end_y {
            result_rows.push(Vec::new());
            continue;
        }

        // Collect all dilated B intervals using Euclidean L2 horizontal reach
        let mut b_intervals: Vec<(i32, i32)> = Vec::new();
        for by in start_y..=end_y {
            if b.rows[by as usize].is_empty() {
                continue;
            }
            let dy = (by - y) as i64;
            let dx = ((rr * rr - dy * dy) as f64).sqrt().floor() as i32;
            for run in &b.rows[by as usize] {
                let s = run.start.saturating_sub(dx).max(0);
                let e = (run.start + run.length).saturating_add(dx).min(width);
                if s < e {
                    b_intervals.push((s, e));
                }
            }
        }

        if b_intervals.is_empty() {
            result_rows.push(Vec::new());
            continue;
        }

        // Sort and merge B intervals
        b_intervals.sort_unstable_by_key(|&(s, _)| s);
        let merged_b = merge_intervals(&b_intervals);

        // Intersect A row with merged B intervals
        let mut res = Vec::new();
        let mut bi = 0;

        for a_run in a_row {
            let a_start = a_run.start;
            let a_end = a_start + a_run.length;

            // Advance bi past intervals that end before a_start
            while bi < merged_b.len() && merged_b[bi].1 <= a_start {
                bi += 1;
            }

            let mut ti = bi;
            while ti < merged_b.len() && merged_b[ti].0 < a_end {
                let start = a_start.max(merged_b[ti].0);
                let end = a_end.min(merged_b[ti].1);
                if start < end {
                    // Merge with previous run if adjacent
                    if let Some(last) = res.last_mut() {
                        let last_run: &mut RleRun = last;
                        if last_run.start + last_run.length == start {
                            last_run.length += end - start;
                        } else {
                            res.push(RleRun {
                                start,
                                length: end - start,
                            });
                        }
                    } else {
                        res.push(RleRun {
                            start,
                            length: end - start,
                        });
                    }
                }
                ti += 1;
            }
        }

        result_rows.push(res);
    }

    RleMask {
        rows: result_rows,
        width,
        height,
    }
}

// ---------------------------------------------------------------------------
// Subtract: Result = A AND NOT B
// ---------------------------------------------------------------------------

/// Compute `A MINUS B` (= `A AND NOT B`).
pub fn rle_subtract(a: &RleMask, b: &RleMask) -> RleMask {
    let width = a.width;
    let height = a.height;
    let mut result_rows = Vec::with_capacity(height as usize);

    for y in 0..height as usize {
        let a_row = &a.rows[y];
        let b_row = &b.rows[y];

        if a_row.is_empty() {
            result_rows.push(Vec::new());
            continue;
        }
        if b_row.is_empty() {
            result_rows.push(a_row.clone());
            continue;
        }

        let mut res = Vec::new();
        let mut bi = 0;

        for a_run in a_row {
            let mut cur_start = a_run.start;
            let cur_end = a_run.start + a_run.length;

            // Skip B runs that end before current A run
            while bi < b_row.len() && b_row[bi].start + b_row[bi].length <= cur_start {
                bi += 1;
            }

            let mut tbi = bi;
            while tbi < b_row.len() && b_row[tbi].start < cur_end {
                let b_start = b_row[tbi].start;
                let b_end = b_start + b_row[tbi].length;

                if b_start > cur_start {
                    res.push(RleRun {
                        start: cur_start,
                        length: b_start - cur_start,
                    });
                }
                cur_start = cur_start.max(b_end);
                tbi += 1;
            }

            if cur_start < cur_end {
                res.push(RleRun {
                    start: cur_start,
                    length: cur_end - cur_start,
                });
            }
        }

        result_rows.push(res);
    }

    RleMask {
        rows: result_rows,
        width,
        height,
    }
}

// ---------------------------------------------------------------------------
// Connected Components Labeling
// ---------------------------------------------------------------------------

/// Connected component labeling on an `RleMask`.
///
/// Two-pass algorithm using union-find over RLE runs.
/// Returns labeled RLE and per-component metadata.
pub fn rle_label_components(
    mask: &RleMask,
    connectivity: Connectivity,
) -> (RleLabels, Vec<ComponentInfo>) {
    let height = mask.height as usize;
    let expand = if connectivity == Connectivity::Eight {
        1
    } else {
        0
    };

    // Union-find arrays (1-based)
    let mut parent: Vec<usize> = vec![0]; // index 0 unused
    let mut area: Vec<i64> = vec![0];
    let mut sum_x: Vec<f64> = vec![0.0];
    let mut sum_y: Vec<f64> = vec![0.0];
    let mut next_id: usize = 1;

    // Path-compressed find
    fn find(parent: &mut [usize], mut i: usize) -> usize {
        while parent[i] != i {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        i
    }

    let union = |parent: &mut Vec<usize>,
                 area: &mut Vec<i64>,
                 sum_x: &mut Vec<f64>,
                 sum_y: &mut Vec<f64>,
                 i: usize,
                 j: usize| {
        let ri = find(parent, i);
        let rj = find(parent, j);
        if ri != rj {
            parent[rj] = ri;
            area[ri] += area[rj];
            sum_x[ri] += sum_x[rj];
            sum_y[ri] += sum_y[rj];
            area[rj] = 0;
            sum_x[rj] = 0.0;
            sum_y[rj] = 0.0;
        }
    };

    // First pass: assign temp labels, union connected runs
    let mut label_rows: Vec<Vec<RleLabelRun>> = Vec::with_capacity(height);

    for y in 0..height {
        let row = &mask.rows[y];
        let mut current_row_labels = Vec::new();

        for run in row {
            let start = run.start;
            let len = run.length;
            let end = start + len;

            // Centroid sums for this run
            let run_sum_x = len as f64 * (start as f64 + (end - 1) as f64) / 2.0;
            let run_sum_y = len as f64 * y as f64;

            // Allocate new label
            let my_id = next_id;
            next_id += 1;
            parent.push(my_id);
            area.push(len as i64);
            sum_x.push(run_sum_x);
            sum_y.push(run_sum_y);

            current_row_labels.push(RleLabelRun {
                start,
                length: len,
                id: my_id as i32,
            });

            // Check connectivity with previous row
            if y > 0 {
                let prev_row = &label_rows[y - 1];
                let search_start = start - expand;
                let search_end = end + expand;

                for prev_run in prev_row {
                    let p_start = prev_run.start;
                    let p_end = p_start + prev_run.length;

                    if p_start >= search_end {
                        break;
                    }
                    if search_start.max(p_start) < search_end.min(p_end) {
                        union(
                            &mut parent,
                            &mut area,
                            &mut sum_x,
                            &mut sum_y,
                            my_id,
                            prev_run.id as usize,
                        );
                    }
                }
            }
        }

        label_rows.push(current_row_labels);
    }

    // Second pass: resolve labels to sequential IDs, build components
    let mut id_map: HashMap<usize, i32> = HashMap::new();
    let mut components = Vec::new();
    let mut final_next_id: i32 = 1;

    use std::collections::HashMap;

    for y in 0..height {
        for run in &mut label_rows[y] {
            let old_id = run.id as usize;
            let root = find(&mut parent, old_id);

            let final_id = *id_map.entry(root).or_insert_with(|| {
                let fid = final_next_id;
                final_next_id += 1;
                components.push(ComponentInfo {
                    id: fid,
                    label: fid,
                    area_px: area[root] as i32,
                    size: area[root] as i32,
                    centroid_sum_x: sum_x[root],
                    centroid_sum_y: sum_y[root],
                });
                fid
            });

            run.id = final_id;
        }
    }

    let labels = RleLabels {
        rows: label_rows,
        width: mask.width,
        height: mask.height,
    };

    (labels, components)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn merge_intervals(intervals: &[(i32, i32)]) -> Vec<(i32, i32)> {
    if intervals.is_empty() {
        return Vec::new();
    }
    let mut merged = Vec::with_capacity(intervals.len());
    let mut cur = intervals[0];
    for &(s, e) in &intervals[1..] {
        if s <= cur.1 {
            cur.1 = cur.1.max(e);
        } else {
            merged.push(cur);
            cur = (s, e);
        }
    }
    merged.push(cur);
    merged
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::model::*;
    use crate::rle::*;

    // Test-local decode helpers (the crate no longer exports decode functions;
    // they were only used to round-trip in tests).
    fn decode(mask: &RleMask) -> Vec<u8> {
        let w = mask.width as usize;
        let mut data = vec![0u8; w * mask.height as usize];
        for (y, row) in mask.rows.iter().enumerate() {
            let row_off = y * w;
            for run in row {
                for j in 0..run.length {
                    data[row_off + (run.start + j) as usize] = 1;
                }
            }
        }
        data
    }

    fn encode_labels(data: &[i32], width: i32, height: i32) -> RleLabels {
        let w = width as usize;
        let mut rows = Vec::with_capacity(height as usize);
        for y in 0..height as usize {
            let mut spans = Vec::new();
            let row_off = y * w;
            let mut run_start: i32 = -1;
            let mut current_id: i32 = 0;
            for x in 0..w {
                let id = data[row_off + x];
                if id != current_id {
                    if current_id != 0 && run_start >= 0 {
                        spans.push(RleLabelRun {
                            start: run_start,
                            length: x as i32 - run_start,
                            id: current_id,
                        });
                    }
                    if id != 0 {
                        run_start = x as i32;
                    } else {
                        run_start = -1;
                    }
                    current_id = id;
                }
            }
            if current_id != 0 && run_start >= 0 {
                spans.push(RleLabelRun {
                    start: run_start,
                    length: width - run_start,
                    id: current_id,
                });
            }
            rows.push(spans);
        }
        RleLabels {
            rows,
            width,
            height,
        }
    }

    fn decode_labels(labels: &RleLabels) -> Vec<i32> {
        let w = labels.width as usize;
        let mut data = vec![0i32; w * labels.height as usize];
        for (y, row) in labels.rows.iter().enumerate() {
            let row_off = y * w;
            for run in row {
                for j in 0..run.length {
                    data[row_off + (run.start + j) as usize] = run.id;
                }
            }
        }
        data
    }

    #[test]
    fn encode_decode_roundtrip() {
        let w = 8;
        let h = 4;
        #[rustfmt::skip]
        let data: Vec<u8> = vec![
            0,0,1,1,1,0,0,0,
            0,1,1,0,0,1,1,0,
            0,0,0,0,0,0,0,0,
            1,1,1,1,1,1,1,1,
        ];
        let mask = rle_encode(&data, w, h);
        assert_eq!(mask.rows[0].len(), 1); // one run: [2,3]
        assert_eq!(mask.rows[1].len(), 2); // two runs
        assert_eq!(mask.rows[2].len(), 0); // empty
        assert_eq!(mask.rows[3].len(), 1); // one full-width run

        let decoded = decode(&mask);
        assert_eq!(decoded, data);
    }

    #[test]
    fn encode_decode_labels_roundtrip() {
        let w = 6;
        let h = 2;
        let data: Vec<i32> = vec![0, 1, 1, 0, 2, 2, 3, 3, 3, 0, 0, 2];
        let labels = encode_labels(&data, w, h);
        let decoded = decode_labels(&labels);
        assert_eq!(decoded, data);
    }

    #[test]
    fn subtract_basic() {
        let w = 10;
        let h = 1;
        let a = RleMask {
            rows: vec![vec![RleRun {
                start: 2,
                length: 6,
            }]],
            width: w,
            height: h,
        };
        let b = RleMask {
            rows: vec![vec![RleRun {
                start: 4,
                length: 2,
            }]],
            width: w,
            height: h,
        };
        let result = rle_subtract(&a, &b);
        // Expected: [2,2] and [6,2]
        assert_eq!(result.rows[0].len(), 2);
        assert_eq!(result.rows[0][0], RleRun { start: 2, length: 2 });
        assert_eq!(result.rows[0][1], RleRun { start: 6, length: 2 });
    }

    #[test]
    fn intersect_dilated_basic() {
        let w = 10;
        let h = 3;
        let a = RleMask {
            rows: vec![
                vec![RleRun {
                    start: 0,
                    length: 10,
                }],
                vec![RleRun {
                    start: 0,
                    length: 10,
                }],
                vec![RleRun {
                    start: 0,
                    length: 10,
                }],
            ],
            width: w,
            height: h,
        };
        // B has a single pixel at (5, 1)
        let b = RleMask {
            rows: vec![
                vec![],
                vec![RleRun {
                    start: 5,
                    length: 1,
                }],
                vec![],
            ],
            width: w,
            height: h,
        };
        // buffer=1 (Euclidean L2 disk): cross around (5, 1) — corners excluded.
        let result = rle_intersect_dilated(&a, &b, 1);
        assert_eq!(result.rows[0], vec![RleRun { start: 5, length: 1 }]);
        assert_eq!(result.rows[1], vec![RleRun { start: 4, length: 3 }]);
        assert_eq!(result.rows[2], vec![RleRun { start: 5, length: 1 }]);
    }

    #[test]
    fn nbr02_euclidean_disk_eliminates_diagonal_square_bias() {
        let w = 8;
        let h = 8;
        // Support pixel at (0, 0)
        let mut b_data = vec![0u8; (w * h) as usize];
        b_data[0] = 1;
        let b = rle_encode(&b_data, w, h);

        // Candidate pixels at (3, 4) [3^2 + 4^2 = 25 <= 25] and (4, 4) [4^2 + 4^2 = 32 > 25]
        let mut a_data = vec![0u8; (w * h) as usize];
        a_data[(4 * w + 3) as usize] = 1;
        a_data[(4 * w + 4) as usize] = 1;
        let a = rle_encode(&a_data, w, h);

        let supported = rle_intersect_dilated(&a, &b, 5);
        let candidates = rle_subtract(&a, &supported);

        let supported_px = decode(&supported);
        let candidate_px = decode(&candidates);
        assert_eq!(
            supported_px[(4 * w + 3) as usize],
            1,
            "(3, 4) with r^2=25 must be supported"
        );
        assert_eq!(
            supported_px[(4 * w + 4) as usize],
            0,
            "(4, 4) with r^2=32 must NOT be supported"
        );
        assert_eq!(
            candidate_px[(4 * w + 3) as usize],
            0,
            "(3, 4) must not remain candidate"
        );
        assert_eq!(
            candidate_px[(4 * w + 4) as usize],
            1,
            "(4, 4) must remain candidate"
        );
    }

    #[test]
    fn label_components_4_connectivity() {
        let w = 5;
        let h = 3;
        #[rustfmt::skip]
        let data: Vec<u8> = vec![
            1,1,0,1,1,
            0,0,0,0,0,
            1,1,0,0,1,
        ];
        let mask = rle_encode(&data, w, h);
        let (labels, comps) = rle_label_components(&mask, Connectivity::Four);

        // Should find 4 disconnected components (4-conn):
        // (0-1, row 0), (3-4, row 0), (0-1, row 2), (4, row 2)
        assert_eq!(comps.len(), 4);
        assert_eq!(labels.rows.len(), 3);

        // Total area should match
        let total: i32 = comps.iter().map(|c| c.area_px).sum();
        assert_eq!(total, 7);
    }

    #[test]
    fn label_components_8_connectivity() {
        let w = 5;
        let h = 3;
        #[rustfmt::skip]
        let data: Vec<u8> = vec![
            1,0,0,0,0,
            0,1,0,0,0,
            0,0,1,0,0,
        ];
        let mask = rle_encode(&data, w, h);
        let (_labels, comps) = rle_label_components(&mask, Connectivity::Eight);

        // With 8-connectivity, these diagonal pixels form 1 component
        assert_eq!(comps.len(), 1);
        assert_eq!(comps[0].area_px, 3);
    }

    #[test]
    fn nbr02_zero_negative_buffer_and_mismatched_mask_heights() {
        let a = rle_encode(&[1, 0, 1, 0, 0, 1, 0, 1], 4, 2);
        let b = rle_encode(&[1, 1, 0, 0, 0, 0, 0, 1], 4, 2);

        // Zero and negative buffers perform exact identity intersection without dilation
        assert_eq!(rle_intersect_dilated(&a, &b, 0), rle_encode(&[1, 0, 0, 0, 0, 0, 0, 1], 4, 2));
        assert_eq!(rle_intersect_dilated(&a, &b, -2), rle_encode(&[1, 0, 0, 0, 0, 0, 0, 1], 4, 2));

        // Mismatched mask heights & short rows vec never panic and only sample valid B rows
        let tall_a = rle_encode(&vec![1u8; 4 * 5], 4, 5);
        let short_b = RleMask {
            rows: vec![vec![RleRun { start: 1, length: 1 }]],
            width: 4,
            height: 3, // rows.len() == 1 < height
        };
        let out_short = rle_intersect_dilated(&tall_a, &short_b, 1);
        assert_eq!(out_short.height, 5);
        assert_eq!(decode(&out_short)[0..4], [1, 1, 1, 0]);
        assert_eq!(decode(&out_short)[4..8], [0, 1, 0, 0]);
        assert_eq!(decode(&out_short)[8..20], [0u8; 12]);
    }

    #[test]
    fn pixel_count() {
        let mask = RleMask {
            rows: vec![
                vec![RleRun { start: 0, length: 5 }],
                vec![],
                vec![
                    RleRun { start: 2, length: 3 },
                    RleRun { start: 7, length: 2 },
                ],
            ],
            width: 10,
            height: 3,
        };
        assert_eq!(mask.pixel_count(), 10);
    }
}
