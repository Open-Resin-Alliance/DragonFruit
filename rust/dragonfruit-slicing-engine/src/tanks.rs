//! Per-tank triangle partitioning for multi-tank machines.
//!
//! The render pipeline draws one mask per tank per layer. That starts by
//! splitting the job's triangles by the tank each one prints from, which is the
//! model's material assignment, with support geometry always in Tank 1.

use crate::geometry::Triangle;
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
}
