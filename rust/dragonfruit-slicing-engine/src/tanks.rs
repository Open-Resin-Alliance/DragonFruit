//! Per-tank triangle partitioning for multi-tank machines.
//!
//! The render pipeline draws one mask per tank per layer. That starts by
//! splitting the job's triangles by the tank each one prints from, which is the
//! model's material assignment, with support geometry always in Tank 1.

use crate::geometry::Triangle;
use crate::rle::{RleAccum, RleRun};
use crate::types::SliceJobV3;

/// Triangles that print from one tank, in their original order.
#[derive(Debug, Clone, Default)]
pub struct TankTriangles {
    pub tank: u32,
    pub triangles: Vec<Triangle>,
    /// How many of `triangles`, from the front, are model geometry rather than
    /// supports. The partition keeps the job's order, and supports only ever
    /// appear after the model triangles, so a tank that received supports has
    /// them at the tail.
    pub model_triangle_count: usize,
}

/// Splits parsed triangles by tank, returning one entry per tank in tank order.
///
/// Every tank is present even when it has no triangles for this job, so callers
/// can emit an empty film for it rather than guessing which tank is missing.
pub fn partition_triangles_by_tank(job: &SliceJobV3, triangles: &[Triangle]) -> Vec<TankTriangles> {
    let tank_count = job.tank_count.max(1) as usize;
    let mut tanks: Vec<TankTriangles> = (0..tank_count)
        .map(|tank| TankTriangles {
            tank: tank as u32,
            triangles: Vec::new(),
            model_triangle_count: 0,
        })
        .collect();

    for (index, triangle) in triangles.iter().enumerate() {
        let tank = job.tank_for_triangle(index) as usize;
        let entry = &mut tanks[tank.min(tank_count - 1)];
        entry.triangles.push(*triangle);
        if !job.is_support_triangle(index) {
            entry.model_triangle_count += 1;
        }
    }

    tanks
}

struct RleCursor<'a> {
    runs: &'a [RleRun],
    index: usize,
    remaining: u32,
    value: u8,
}

impl<'a> RleCursor<'a> {
    #[inline]
    fn new(runs: &'a [RleRun]) -> Self {
        Self {
            runs,
            index: 0,
            remaining: 0,
            value: 0,
        }
    }

    #[inline]
    fn ensure(&mut self) -> u32 {
        while self.remaining == 0 {
            let Some(run) = self.runs.get(self.index).copied() else {
                self.value = 0;
                return 0;
            };
            self.index += 1;
            self.remaining = run.length;
            self.value = run.value;
        }
        self.remaining
    }

    #[inline]
    fn advance(&mut self, count: u32) {
        if self.remaining > 0 {
            self.remaining -= count;
        }
    }
}

/// Combines pre-LUT union AA, per-tank binary masks, and per-tank AA masks into
/// a boundary-preserved AA RLE stream for `target_tank`.
///
/// Touching boundaries between materials keep full interior exposure (`255`)
/// with zero cross-tank bleed, while outside material-to-void boundaries retain
/// anti-aliasing without corner notches at multi-material T-junctions.
pub fn combine_tank_boundary_aa_rle(
    union_aa: &[RleRun],
    tank_binary: &[&[RleRun]],
    tank_aa: &[&[RleRun]],
    target_tank: usize,
) -> Vec<RleRun> {
    debug_assert_eq!(tank_binary.len(), tank_aa.len());
    debug_assert!(target_tank < tank_binary.len());
    if tank_binary.is_empty()
        || tank_binary.len() != tank_aa.len()
        || target_tank >= tank_binary.len()
    {
        return Vec::new();
    }

    let tank_has_layer_geometry: Vec<bool> = tank_binary
        .iter()
        .map(|runs| runs.iter().any(|run| run.value > 0))
        .collect();

    let mut union_cursor = RleCursor::new(union_aa);
    let mut bin_cursors: Vec<RleCursor<'_>> = tank_binary.iter().map(|r| RleCursor::new(r)).collect();
    let mut aa_cursors: Vec<RleCursor<'_>> = tank_aa.iter().map(|r| RleCursor::new(r)).collect();
    let mut out = RleAccum::new();

    loop {
        let mut chunk = u32::MAX;
        let u_rem = union_cursor.ensure();
        if u_rem > 0 {
            chunk = chunk.min(u_rem);
        }
        for cursor in &mut bin_cursors {
            let rem = cursor.ensure();
            if rem > 0 {
                chunk = chunk.min(rem);
            }
        }
        for cursor in &mut aa_cursors {
            let rem = cursor.ensure();
            if rem > 0 {
                chunk = chunk.min(rem);
            }
        }
        if chunk == u32::MAX {
            break;
        }

        let u_aa = union_cursor.value;
        let b_t = bin_cursors[target_tank].value;
        let any_b = bin_cursors.iter().any(|c| c.value > 0);
        let a_t = aa_cursors[target_tank].value;
        let mut max_a = 0u8;
        let mut max_a_count = 0usize;
        for cursor in &aa_cursors {
            let v = cursor.value;
            if v > max_a {
                max_a = v;
                max_a_count = 1;
            } else if v == max_a {
                max_a_count += 1;
            }
        }

        let out_val = if b_t > 0 {
            u_aa
        } else if any_b {
            0
        } else if u_aa == 0 || a_t == 0 {
            0
        } else if a_t == max_a {
            if max_a_count == 1 {
                u_aa
            } else {
                let tied_on_layer = aa_cursors
                    .iter()
                    .enumerate()
                    .filter(|(i, c)| c.value == max_a && tank_has_layer_geometry[*i])
                    .count();
                if tied_on_layer > 0 {
                    if !tank_has_layer_geometry[target_tank] {
                        0
                    } else if tied_on_layer == 1 {
                        u_aa
                    } else {
                        a_t
                    }
                } else {
                    a_t
                }
            }
        } else {
            0
        };

        out.push_run(chunk, out_val);
        union_cursor.advance(chunk);
        for cursor in &mut bin_cursors {
            cursor.advance(chunk);
        }
        for cursor in &mut aa_cursors {
            cursor.advance(chunk);
        }
    }

    out.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{parse_triangles, Triangle};

    fn job(tank_count: u32, model_triangle_count: u32, tanks: &[u32]) -> SliceJobV3 {
        SliceJobV3 {
            tank_count,
            triangle_tank_index: tanks.to_vec(),
            model_triangle_count,
            ..Default::default()
        }
    }

    /// Six triangles: two per tank, all flat at z = 0.
    fn triangles() -> Vec<Triangle> {
        let mut flat = Vec::new();
        for index in 0..6 {
            let x = index as f32;
            flat.extend_from_slice(&[
                x, 0.0, 0.0,
                x + 1.0, 0.0, 0.0,
                x, 1.0, 0.0,
            ]);
        }
        parse_triangles(&flat)
    }

    #[test]
    fn splits_by_assignment_keeping_order() {
        let tris = triangles();
        let job = job(2, 4, &[0, 1, 1, 0, 0, 0]);
        let tanks = partition_triangles_by_tank(&job, &tris);

        assert_eq!(tanks.len(), 2);
        assert_eq!(tanks[0].tank, 0);
        assert_eq!(tanks[1].tank, 1);
        // Two model triangles for tank 0 plus both supports (always Tank 1).
        assert_eq!(tanks[0].triangles.len(), 4);
        assert_eq!(tanks[1].triangles.len(), 2);
        // Order inside a tank is the original order.
        assert_eq!(tanks[0].triangles[0].a.x, 0.0);
        assert_eq!(tanks[0].triangles[1].a.x, 3.0);
        assert_eq!(tanks[0].triangles[2].a.x, 4.0);
        assert_eq!(tanks[1].triangles[0].a.x, 1.0);
        assert_eq!(tanks[0].model_triangle_count, 2);
        assert_eq!(tanks[1].model_triangle_count, 2);
    }

    #[test]
    fn support_geometry_always_prints_from_tank_one() {
        let tris = triangles();
        // Four model triangles then two support triangles that claim tank 2.
        let job = job(3, 4, &[2, 2, 1, 0, 2, 2]);
        let tanks = partition_triangles_by_tank(&job, &tris);

        assert_eq!(
            tanks[0].triangles.len(), 3,
            "the tank-0 model triangle plus both supports, whatever the supports claimed",
        );
        assert_eq!(tanks[1].triangles.len(), 1, "model triangle assigned tank 1");
        assert_eq!(tanks[2].triangles.len(), 2, "model triangles assigned tank 2");
        assert_eq!(tanks[0].model_triangle_count, 1, "supports are not model triangles");
    }

    #[test]
    fn a_job_without_assignments_is_all_tank_one() {
        let tris = triangles();
        let job = job(1, 0, &[]);
        let tanks = partition_triangles_by_tank(&job, &tris);

        assert_eq!(tanks.len(), 1);
        assert_eq!(tanks[0].triangles.len(), 6);
    }

    #[test]
    fn out_of_range_assignments_are_clamped() {
        let tris = triangles();
        let job = job(2, 6, &[7, 7, 0, 0, 0, 0]);
        let tanks = partition_triangles_by_tank(&job, &tris);

        assert_eq!(tanks[0].triangles.len(), 4);
        assert_eq!(tanks[1].triangles.len(), 2);
    }

    fn rle_of(pixels: &[u8]) -> Vec<RleRun> {
        let mut acc = RleAccum::new();
        crate::rle::emit_row(&mut acc, pixels);
        acc.finish()
    }

    fn expand(runs: &[RleRun], len: usize) -> Vec<u8> {
        crate::rle::expand_rle_to_mask(runs, len)
    }

    #[test]
    fn boundary_combine_keeps_touching_seam_crisp_and_preserves_outer_aa() {
        // 1x8 strip:
        // [0]: void halo near Tank 0 (u_aa=80, a_0=80, a_1=0)
        // [1]: Tank 0 outer edge (b_0=255, u_aa=190, a_0=190)
        // [2]: Tank 0 deep interior (b_0=255, u_aa=255, a_0=255)
        // [3]: Tank 0 touching seam (b_0=255, b_1=0, u_aa=255, a_0=190, a_1=70)
        // [4]: Tank 1 touching seam (b_0=0, b_1=255, u_aa=255, a_0=70, a_1=190)
        // [5]: Tank 1 deep interior (b_1=255, u_aa=255, a_1=255)
        // [6]: Tank 1 outer edge (b_1=255, u_aa=185, a_1=185)
        // [7]: void halo near Tank 1 (u_aa=75, a_0=0, a_1=75)
        let union_aa = rle_of(&[80, 190, 255, 255, 255, 255, 185, 75]);
        let bin_0 = rle_of(&[0, 255, 255, 255, 0, 0, 0, 0]);
        let bin_1 = rle_of(&[0, 0, 0, 0, 255, 255, 255, 0]);
        let aa_0 = rle_of(&[80, 190, 255, 190, 70, 0, 0, 0]);
        let aa_1 = rle_of(&[0, 0, 0, 70, 190, 255, 185, 75]);

        let out_0 = expand(
            &combine_tank_boundary_aa_rle(&union_aa, &[&bin_0, &bin_1], &[&aa_0, &aa_1], 0),
            8,
        );
        let out_1 = expand(
            &combine_tank_boundary_aa_rle(&union_aa, &[&bin_0, &bin_1], &[&aa_0, &aa_1], 1),
            8,
        );

        assert_eq!(out_0, vec![80, 190, 255, 255, 0, 0, 0, 0]);
        assert_eq!(out_1, vec![0, 0, 0, 0, 255, 255, 185, 75]);
    }

    #[test]
    fn boundary_combine_handles_t_junction_ties_subpixel_and_overlap() {
        // [0]: T-junction outer edge on Tank 0 (b_0=255, u_aa=210, a_0=170 -> uses u_aa=210)
        // [1]: Void gap tie (b_0=0, b_1=0, u_aa=120, a_0=60, a_1=60 -> symmetric a_t=60)
        // [2]: Void dominance Tank 1 (b_0=0, b_1=0, u_aa=110, a_0=40, a_1=70 -> 0 for T0, 110 for T1)
        // [3]: Sub-pixel thin feature in Tank 0 (b_0=0, b_1=0, u_aa=95, a_0=95, a_1=0 -> 95 for T0)
        // [4]: Overlapping materials (b_0=255, b_1=255, u_aa=255 -> 255 for both)
        let union_aa = rle_of(&[210, 120, 110, 95, 255]);
        let bin_0 = rle_of(&[255, 0, 0, 0, 255]);
        let bin_1 = rle_of(&[0, 0, 0, 0, 255]);
        let aa_0 = rle_of(&[170, 60, 40, 95, 255]);
        let aa_1 = rle_of(&[40, 60, 70, 0, 255]);

        let out_0 = expand(
            &combine_tank_boundary_aa_rle(&union_aa, &[&bin_0, &bin_1], &[&aa_0, &aa_1], 0),
            5,
        );
        let out_1 = expand(
            &combine_tank_boundary_aa_rle(&union_aa, &[&bin_0, &bin_1], &[&aa_0, &aa_1], 1),
            5,
        );

        assert_eq!(out_0, vec![210, 60, 0, 95, 255]);
        assert_eq!(out_1, vec![0, 60, 110, 0, 255]);
    }

    #[test]
    fn boundary_combine_breaks_z_blur_rounding_ties_in_favor_of_present_tank() {
        // Tank 0 has geometry on this layer; Tank 1 is all-zero on this layer.
        // Void halo pixel [0] ties at a_0 == a_1 == 1 (from Z-blur rounding) with u_aa == 2.
        // Tank 0 uniquely owns the layer geometry, so Tank 0 gets u_aa (2) and Tank 1 gets 0.
        let union_aa = rle_of(&[2, 255]);
        let bin_0 = rle_of(&[0, 255]);
        let bin_1 = rle_of(&[0, 0]);
        let aa_0 = rle_of(&[1, 170]);
        let aa_1 = rle_of(&[1, 85]);

        let out_0 = expand(
            &combine_tank_boundary_aa_rle(&union_aa, &[&bin_0, &bin_1], &[&aa_0, &aa_1], 0),
            2,
        );
        let out_1 = expand(
            &combine_tank_boundary_aa_rle(&union_aa, &[&bin_0, &bin_1], &[&aa_0, &aa_1], 1),
            2,
        );

        assert_eq!(out_0, vec![2, 255]);
        assert_eq!(out_1, vec![0, 0]);
    }
}
