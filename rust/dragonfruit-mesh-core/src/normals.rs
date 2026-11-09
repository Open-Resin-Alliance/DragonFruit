//! Shading normals for a mesh the viewport draws.
//!
//! A file format that carries one normal per triangle (an STL, and the geometry a
//! plugin builds from one) has no vertex normals to give. The renderer shades the
//! facets the mesh actually has: each corner carries its own triangle's geometric
//! normal, so a flat face stays flat, an edge stays sharp, and the surface on
//! screen is the surface in the file.
//!
//! This used to average the faces incident to a welded vertex, then — once that
//! drew a forty-five degree ramp across every ninety degree crease — only the
//! faces within a crease angle of the corner's own. Both are gone. The viewport is
//! where a user checks what the mesh *is*, and an averaged normal paints a
//! different surface over the triangulation: a scan's facets and an imported CAD
//! edge both come out soft. It also disagreed with the geometry a repair pass
//! hands back, which the renderer recomputes per face, so a model changed its
//! shading the moment it was repaired (issue #797).
//!
//! The ambient-occlusion bake is the one consumer that wants an averaged normal —
//! it is the axis of each vertex's probe fan — and it derives its own from the
//! faces it probes (`vertex_occlusion`), never from this module.

use crate::mesh::{IndexedMesh, Vec3};
use rayon::prelude::*;

/// One normal per triangle, in triangle order.
///
/// Right-handed with the triangle's winding, so a counter-clockwise face normal
/// points out of it. A degenerate triangle (no area, and no orientation to
/// report) gets a zero normal, which is what the renderer's own
/// `computeVertexNormals` yields for one.
pub fn face_normals(mesh: &IndexedMesh) -> Vec<Vec3> {
    mesh.triangles
        .par_iter()
        .map(|triangle| {
            let a = mesh.positions[triangle[0] as usize];
            let b = mesh.positions[triangle[1] as usize];
            let c = mesh.positions[triangle[2] as usize];
            let face = b.sub(a).cross(c.sub(a));
            let length = face.length();
            if length > 1e-20 {
                face.scale(1.0 / length)
            } else {
                Vec3::ZERO
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dot(a: Vec3, b: Vec3) -> f32 {
        a.x * b.x + a.y * b.y + a.z * b.z
    }

    fn triangle(positions: Vec<Vec3>) -> IndexedMesh {
        IndexedMesh { positions, triangles: vec![[0, 1, 2]] }
    }

    /// Two quads sharing an edge, folded by `fold_deg` about it.
    fn folded(fold_deg: f32) -> IndexedMesh {
        let angle = fold_deg.to_radians();
        let (sin, cos) = angle.sin_cos();
        IndexedMesh {
            positions: vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(-1.0, 0.0, 0.0),
                Vec3::new(-1.0, 1.0, 0.0),
                Vec3::new(cos, 1.0, sin),
                Vec3::new(cos, 0.0, sin),
            ],
            triangles: vec![[0, 2, 3], [0, 3, 1], [1, 4, 5], [1, 5, 0]],
        }
    }

    #[test]
    fn a_counter_clockwise_face_points_out_of_its_plane() {
        let normals = face_normals(&triangle(vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
        ]));
        assert!(normals[0].z > 0.99, "expected +Z, got {:?}", normals[0]);
    }

    #[test]
    fn a_crease_keeps_both_faces_normals() {
        let normals = face_normals(&folded(90.0));
        let floor = normals[0];
        let wall = normals[2];
        assert!(floor.z.abs() > 0.9, "floor normal: {floor:?}");
        assert!(
            dot(floor, wall).abs() < 0.5,
            "a ninety degree crease must not average into a ramp, got {floor:?} and {wall:?}"
        );
    }

    /// The fold angle is irrelevant now: nothing averages, however shallow.
    #[test]
    fn a_shallow_fold_keeps_both_faces_normals_too() {
        let normals = face_normals(&folded(20.0));
        let floor = normals[0];
        let fold = normals[2];
        assert!(
            dot(floor, fold) < 0.999,
            "a twenty degree fold must keep its two normals, got {floor:?} and {fold:?}"
        );
    }

    #[test]
    fn every_corner_gets_a_unit_normal() {
        for normal in face_normals(&folded(90.0)) {
            assert!((normal.length() - 1.0).abs() < 1e-4, "not unit: {normal:?}");
        }
    }

    #[test]
    fn a_degenerate_triangle_gets_a_zero_normal() {
        let normals = face_normals(&triangle(vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(2.0, 0.0, 0.0),
        ]));
        assert_eq!(normals[0].length(), 0.0);
    }
}
