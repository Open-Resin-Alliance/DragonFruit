//! Fixtures shared by the tests.

use crate::core::mesh::{IndexedMesh, Vec3};

/// A welded unit cube: 12 triangles, closed, consistently outward.
pub(crate) fn unit_cube() -> IndexedMesh {
    let mut positions = Vec::with_capacity(8);
    for z in [0.0f32, 1.0] {
        for y in [0.0f32, 1.0] {
            for x in [0.0f32, 1.0] {
                positions.push(Vec3::new(x, y, z));
            }
        }
    }
    IndexedMesh {
        positions,
        triangles: vec![
            [0, 2, 1],
            [1, 2, 3],
            [4, 5, 6],
            [5, 7, 6],
            [0, 1, 4],
            [1, 5, 4],
            [2, 6, 3],
            [3, 6, 7],
            [0, 4, 2],
            [2, 4, 6],
            [1, 3, 5],
            [3, 7, 5],
        ],
    }
}
