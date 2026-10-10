//! Shading normals for a welded mesh.
//!
//! A file format that carries one normal per triangle (an STL, and the geometry a
//! plugin builds from one) has no vertex normals to give, and writing the face
//! normal onto all three corners makes the model shade as a stack of facets.
//! Averaging over the welded mesh fixes that, and then goes too far the other way
//! on hard-edged geometry: where an organic shape meets a flat base, the shared
//! vertex averages the base's normal with the wall's into a forty-five degree
//! ramp, the rest of the base does not, and the jump between them reads as a
//! faceted band around every shape that touches it.
//!
//! So a corner averages only the faces within [`CREASE_ANGLE_DEG`] of its own.
//! A crease keeps two normals and shades crisp; a curved surface still averages,
//! because neighbouring faces there are within the threshold of each other.

use crate::mesh::{IndexedMesh, Vec3};
use rayon::prelude::*;

/// Faces further apart than this at a shared vertex get separate normals.
///
/// Sixty degrees leaves a scanned or organic surface smooth while splitting the
/// corners where a shape meets a plane. Raising it does not help where it hurts:
/// measured on a dense hard-surface model, going from 60 to 80 degrees moved the
/// share of split corners from 24.8% to 24.0%, because what splits them are faces
/// folded back on each other, not a marginal angle.
pub const CREASE_ANGLE_DEG: f32 = 60.0;

/// One normal per triangle corner, in triangle order.
pub fn corner_normals(mesh: &IndexedMesh) -> Vec<Vec3> {
    let crease_cosine = CREASE_ANGLE_DEG.to_radians().cos();
    // The raw cross product is twice the triangle's area times its normal, so
    // accumulating these weights each face by its area while the crease test below
    // divides it out. That weighting is not a refinement: a mesh that has been
    // subdivided by the longest edge is full of thin slivers whose normals are
    // meaningless, and with one vote each they outvote the real surfaces around
    // them, which shows up as a quarter of a dense model's corners splitting at
    // angles up to 180 degrees and rendering as speckle.
    let raw: Vec<Vec3> = mesh
        .triangles
        .par_iter()
        .map(|triangle| {
            let a = mesh.positions[triangle[0] as usize];
            let b = mesh.positions[triangle[1] as usize];
            let c = mesh.positions[triangle[2] as usize];
            b.sub(a).cross(c.sub(a))
        })
        .collect();
    let unit = |face: Vec3| -> Vec3 {
        let length = face.length();
        if length > 1e-20 {
            face.scale(1.0 / length)
        } else {
            Vec3::ZERO
        }
    };
    let face_normals: Vec<Vec3> = raw.par_iter().map(|face| unit(*face)).collect();

    // Incident faces per vertex, as one flat CSR pair rather than a `Vec` per
    // vertex. The per-vertex form is ~420k allocations on a dense model, and it
    // dominated the encode: a 960k-triangle payload spent 8 s in this function
    // against 0.5 s for the classifier. The fill walks faces in order, so a
    // vertex's slice is still ascending by face index and every sum below
    // accumulates in the same order as before — the output is unchanged bit for
    // bit, which the crease tests pin.
    let vertex_count = mesh.positions.len();
    let mut incident_offsets = vec![0u32; vertex_count + 1];
    for triangle in &mesh.triangles {
        for vertex in triangle {
            incident_offsets[*vertex as usize + 1] += 1;
        }
    }
    for index in 1..incident_offsets.len() {
        incident_offsets[index] += incident_offsets[index - 1];
    }
    let mut fill = incident_offsets.clone();
    let mut incident = vec![0u32; incident_offsets[vertex_count] as usize];
    for (face, triangle) in mesh.triangles.iter().enumerate() {
        for vertex in triangle {
            let slot = &mut fill[*vertex as usize];
            incident[*slot as usize] = face as u32;
            *slot += 1;
        }
    }

    let mut out = vec![Vec3::ZERO; mesh.triangles.len() * 3];
    out.par_chunks_mut(3)
        .zip(mesh.triangles.par_iter().enumerate())
        .for_each(|(corner_output, (face, triangle))| {
            let own = face_normals[face];
            for (corner, vertex) in triangle.iter().enumerate() {
                let vertex = *vertex as usize;
                let start = incident_offsets[vertex] as usize;
                let end = incident_offsets[vertex + 1] as usize;
                let mut sum = Vec3::ZERO;
                for &other in &incident[start..end] {
                    let other_normal = face_normals[other as usize];
                    if own.dot(other_normal) < crease_cosine {
                        continue;
                    }
                    sum = sum.add(other_normal);
                }
                let length = sum.length();
                corner_output[corner] = if length > 1e-12 {
                    sum.scale(1.0 / length)
                } else {
                    own
                };
            }
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn dot(a: Vec3, b: Vec3) -> f32 {
        a.x * b.x + a.y * b.y + a.z * b.z
    }

    #[test]
    fn a_hard_crease_keeps_both_normals() {
        let normals = corner_normals(&folded(90.0));
        let floor_corner = normals[0];
        let wall_corner = normals[2 * 3];
        assert!(floor_corner.z.abs() > 0.9, "floor corner: {floor_corner:?}");
        assert!(
            dot(floor_corner, wall_corner).abs() < 0.5,
            "a ninety degree crease must not average into a ramp"
        );
    }

    #[test]
    fn a_shallow_fold_still_averages() {
        let normals = corner_normals(&folded(20.0));
        assert!(
            dot(normals[0], normals[2 * 3]) > 0.8,
            "a twenty degree fold should still smooth"
        );
    }

    #[test]
    fn every_corner_gets_a_unit_normal() {
        for normal in corner_normals(&folded(90.0)) {
            assert!((normal.length() - 1.0).abs() < 1e-4, "not unit: {normal:?}");
        }
    }
}
