//! Per-vertex ambient occlusion.
//!
//! This is the *surface* estimator. A volumetric bake was built first and
//! removed, and the reason is a resolution argument rather than a preference:
//!
//! - A **volume** reconstructs occlusion from a grid, so it is smooth and free
//!   of the sampling artifacts a surface bake shows — but its grid *is* the
//!   resolution of the result. On a figurine with sub-millimetre feather relief,
//!   a 128-voxel grid over a 150mm part puts several feather valleys inside one
//!   voxel, and the shading bakes away to almost nothing.
//! - **Per-vertex** sampling resolves whatever the mesh resolves, which is
//!   exactly the detail a detailed model is made of. It costs one ray bundle per
//!   vertex, and that is only affordable natively: the same estimator in
//!   TypeScript cost ~15 µs per vertex (seconds per model, which is why it was
//!   rejected the first time round), and this runs it in parallel over vertices.
//!
//! The estimator is the standard cosine-weighted visibility integral — the
//! fraction of a cosine-weighted hemisphere that escapes the mesh within the
//! probe reach — with the probe direction taken from the mesh's own vertex normal
//! so there is nothing to orient or guess.

use crate::bvh::Bvh;
use crate::mesh::{IndexedMesh, Vec3};
use rayon::prelude::*;

/// Default probe directions per vertex.
pub const DEFAULT_RAYS: usize = 8;
/// Probe reach as a fraction of the model's bounding-box diagonal. The same
/// fraction the on-device experiments settled on: below it the estimator is
/// blind, above it crevice shading turns into an overall wash.
pub const REACH_RATIO: f32 = 0.08;
/// Where an occluder stops counting in full, and where it stops counting at all,
/// both as fractions of the reach.
///
/// Occlusion from geometry right against the surface is what reads as shape;
/// occlusion from geometry most of a reach away reads as dirt. Measured on a real
/// model, 68% of the deepest crevices' occlusion comes from within half a
/// millimetre and 86% within one, while a flat base under a mass of bumps is
/// shaded only by geometry one to five millimetres off.
///
/// The plateau matters as much as the taper. An earlier version tapered from zero
/// and scaled by the *mesh's median edge*, which is the tessellation density
/// rather than the feature size: on a densely triangulated model that falls to a
/// couple of millimetres, so a cape's folds, whose occluders sit five to ten
/// millimetres away, lost their shading entirely while the base it was meant to
/// clean kept only what the strength could not put back. Tying it to the reach
/// instead keys it to the model's own size, which is the scale features are
/// actually made at.
const FALLOFF_PLATEAU: f32 = 0.15;
const FALLOFF_END: f32 = 1.0;
/// Ray-origin offset along the normal, as a fraction of the reach.
const ORIGIN_BIAS_RATIO: f32 = 1e-3;
/// Vertex-weld tolerance for the input soup, relative to its bounding-box
/// diagonal. Kept as one constant so the mesh and the corner map cannot be built
/// with different tolerances.
const SOUP_MERGE_EPSILON: f32 = 1e-5;
/// Fixed cosine-weighted hemisphere fan in tangent space (+Z up), deterministic
/// so a re-bake reproduces itself. `rays` truncates it.
fn hemisphere_samples(rays: usize) -> Vec<Vec3> {
    let count = rays.clamp(1, 32);
    (0..count)
        .map(|i| {
            let u1 = (i as f32 + 0.5) / count as f32;
            // Golden-ratio rotation of the azimuth keeps the fan from lining up
            // with the mesh's own triangle grid.
            let u2 = (i as f32 * 0.618_034) % 1.0;
            let radius = u1.sqrt();
            let phi = std::f32::consts::TAU * u2;
            Vec3::new(
                radius * phi.cos(),
                radius * phi.sin(),
                (1.0 - u1).max(0.0).sqrt(),
            )
        })
        .collect()
}

/// One value per *geometry* vertex of the input soup, in the soup's own order.
///
/// **The weld happens here, once.** An earlier version called
/// `IndexedMesh::from_triangle_soup` and then rebuilt the corner-to-vertex map
/// separately to expand the values back out. Two welds with different tolerances
/// disagree about which corners are the same vertex, and the values were being
/// indexed with one mapping into a mesh built with the other — on models with
/// near-coincident vertices (which is most STL soups at their shared edges) that
/// shifts occlusion by a vertex, and it renders as misaligned triangles. One
/// mapping, used in both directions, cannot disagree with itself.
pub fn bake_vertex_occlusion_for_soup(
    positions: &[f32],
    rays: usize,
    reach_mm: Option<f32>,
) -> (Vec<f32>, usize) {
    let corner_count = positions.len() / 3;
    if corner_count == 0 {
        return (Vec::new(), 0);
    }

    let (mesh, corner_map) =
        IndexedMesh::from_triangle_soup_with_corner_map(positions, SOUP_MERGE_EPSILON);
    let welded = bake_vertex_occlusion(&mesh, rays, reach_mm);

    let out: Vec<f32> = corner_map
        .iter()
        .map(|id| welded.get(*id as usize).copied().unwrap_or(1.0))
        .collect();

    debug_assert_eq!(
        out.len(),
        positions.len() / 3,
        "one value per corner of the soup, in its own order"
    );
    (out, mesh.positions.len())
}

/// One value per vertex: 1 = open sky, 0 = fully occluded.
pub fn bake_vertex_occlusion(mesh: &IndexedMesh, rays: usize, reach_mm: Option<f32>) -> Vec<f32> {
    bake_against(mesh, mesh, rays, reach_mm)
}

/// Sample `mesh` while casting the rays against `occluder`.
///
/// Normals and sample positions come from `mesh`, so the field still resolves
/// the model's own relief; only the blocking geometry is simplified.
pub fn bake_against(
    mesh: &IndexedMesh,
    occluder: &IndexedMesh,
    rays: usize,
    reach_mm: Option<f32>,
) -> Vec<f32> {
    let vertex_count = mesh.positions.len();
    if vertex_count == 0 {
        return Vec::new();
    }

    // Vertex normals from the adjacent faces: the bake's probe directions and
    // the material's shading both want the smooth normal, and an unindexed mesh
    // has none of its own.
    let mut normals = vec![Vec3::ZERO; vertex_count];
    for tri in &mesh.triangles {
        let a = mesh.positions[tri[0] as usize];
        let b = mesh.positions[tri[1] as usize];
        let c = mesh.positions[tri[2] as usize];
        let face = b.sub(a).cross(c.sub(a));
        for index in tri {
            let slot = &mut normals[*index as usize];
            *slot = slot.add(face);
        }
    }

    let reach = reach_mm.unwrap_or_else(|| {
        let mut bbox = crate::mesh::Aabb::empty();
        for p in &mesh.positions {
            bbox.expand(*p);
        }
        (bbox.diag() * REACH_RATIO).max(1e-3)
    });
    let bias = reach * ORIGIN_BIAS_RATIO;
    let samples = hemisphere_samples(rays);
    let bvh = Bvh::build(occluder);
    let plateau = reach * FALLOFF_PLATEAU;
    let falloff_end = reach * FALLOFF_END;

    let mut out = vec![1.0f32; vertex_count];
    out.par_iter_mut().enumerate().for_each(|(index, value)| {
        let mut normal = normals[index];
        if normal.length() < 1e-12 {
            // Isolated or degenerate vertex: open sky is the honest answer.
            *value = 1.0;
            return;
        }
        normal = normal.scale(1.0 / normal.length());

        // A stable tangent basis; the fan is cosine weighted, so its rotation
        // about the normal does not bias the estimate.
        let mut tangent = Vec3::new(0.0, 0.0, 1.0);
        if normal.z.abs() > 0.9 {
            tangent = Vec3::new(1.0, 0.0, 0.0);
        }
        let bitangent = normal.cross(tangent);
        let bitangent = bitangent.scale(1.0 / bitangent.length().max(1e-12));
        let tangent = bitangent.cross(normal);

        let origin = mesh.positions[index].add(normal.scale(bias));
        let mut hits = 0.0f32;
        for sample in &samples {
            let dir = tangent
                .scale(sample.x)
                .add(bitangent.scale(sample.y))
                .add(normal.scale(sample.z));
            // Kept even though the basis is orthonormal and the fan is on the unit
            // sphere, so this should be a no-op: the sum of squares it divides by
            // carries a rounding error of its own, and without it the directions
            // shift by ~1e-6, which flips grazing rays onto different triangles.
            // Measured: 13.7% of one model's values move, by up to 0.038.
            let dir = dir.scale(1.0 / dir.length().max(1e-12));
            // Weighted by distance: a surface half a millimetre away blocks most
            // of the sky behind it, one at the far end of the reach barely counts.
            // Everything inside the plateau weighs the same, so the traversal is
            // allowed to stop at the first hit there.
            if let Some(t) = bvh.ray_nearest_within(occluder, origin, dir, reach, plateau) {
                // Full weight within the plateau, then a straight taper to nothing
                // at the end of the reach.
                let span = (t - plateau) / (falloff_end - plateau).max(1e-6);
                hits += (1.0 - span).clamp(0.0, 1.0);
            }
        }
        *value = 1.0 - hits / samples.len() as f32;
    });

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_soup(min: [f32; 3], max: [f32; 3]) -> Vec<f32> {
        let corners = [
            [min[0], min[1], min[2]],
            [max[0], min[1], min[2]],
            [max[0], max[1], min[2]],
            [min[0], max[1], min[2]],
            [min[0], min[1], max[2]],
            [max[0], min[1], max[2]],
            [max[0], max[1], max[2]],
            [min[0], max[1], max[2]],
        ];
        let faces: [[usize; 4]; 6] = [
            [0, 1, 2, 3],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [1, 2, 6, 5],
            [2, 3, 7, 6],
            [3, 0, 4, 7],
        ];
        let mut out = Vec::new();
        for f in faces {
            for tri in [[f[0], f[1], f[2]], [f[0], f[2], f[3]]] {
                for i in tri {
                    out.extend_from_slice(&corners[i]);
                }
            }
        }
        out
    }

    #[test]
    fn flat_faces_are_open_and_creases_darken() {
        // A slab with two thin walls leaving a 2mm-wide slot: the slot floor is a
        // crease, the slab top outboard of the walls is open.
        let mut soup = box_soup([0.0, 0.0, 0.0], [20.0, 20.0, 4.0]);
        soup.extend(box_soup([0.0, 8.5, 4.0], [20.0, 9.0, 10.0]));
        soup.extend(box_soup([0.0, 11.0, 4.0], [20.0, 11.5, 10.0]));
        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);

        let occlusion = bake_vertex_occlusion(&mesh, DEFAULT_RAYS, None);

        let value_near = |target: [f32; 3]| -> f32 {
            let mut best = f32::MAX;
            let mut value = 1.0;
            for (index, p) in mesh.positions.iter().enumerate() {
                let dx = p.x - target[0];
                let dy = p.y - target[1];
                let dz = p.z - target[2];
                let d = dx * dx + dy * dy + dz * dz;
                if d < best {
                    best = d;
                    value = occlusion[index];
                }
            }
            value
        };

        let open_face = value_near([10.0, 2.0, 4.0]);
        let crease_floor = value_near([10.0, 10.0, 4.0]);
        assert!(open_face > 0.8, "open face should stay open, got {open_face}");
        assert!(
            crease_floor < open_face - 0.2,
            "slot floor ({crease_floor}) should be clearly darker than the open face ({open_face})"
        );
    }

    /// The regression for the misalignment report: near-coincident vertices.
    ///
    /// A soup whose shared edges are duplicated *almost* exactly — the normal
    /// state of an STL soup — must produce one value per corner, and corners at
    /// the same position must get the same value. With two welds of different
    /// tolerances the values shift by a vertex and this fails.
    #[test]
    fn coincident_corners_share_a_value_through_the_soup_path() {
        let base = box_soup([0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
        // A second copy nudged by less than the weld tolerance: its corners merge
        // with the first copy's, and every value must follow.
        let nudge = 1e-7f32;
        let mut soup = base.clone();
        soup.extend(base.chunks_exact(3).flat_map(|c| [c[0] + nudge, c[1], c[2]]));

        let (values, _) = bake_vertex_occlusion_for_soup(&soup, DEFAULT_RAYS, None);
        assert_eq!(values.len(), soup.len() / 3, "one value per corner");

        // Corresponding corners of the two copies sit at the same welded vertex,
        // so they must agree.
        let corners = base.len() / 3;
        for corner in 0..corners {
            let a = values[corner];
            let b = values[corner + corners];
            assert!(
                (a - b).abs() < 1e-6,
                "corner {corner}: copies disagree ({a} vs {b}) — the corner map and the welded mesh do not match",
            );
        }
    }


    /// Occlusion counts by distance: a wall within the plateau darkens the floor
    /// under it, one part way down the taper darkens it less, and one past the
    /// reach not at all.
    ///
    /// This is what keeps a flat base clean without flattening crevices, and it
    /// fails against an estimator that counts every hit within the reach equally.
    #[test]
    fn nearby_occluders_count_and_distant_ones_do_not() {
        // A wide floor of 0.5mm triangles: the falloff is 8 x the median edge, so
        // 4mm, and the floor has to be large enough that the reach (8% of its
        // diagonal) reaches past it. 60mm gives a 6.8mm reach.
        let size = 60.0f32;
        let step = 0.5f32;
        let cells = (size / step) as u32;
        let mut soup = Vec::new();
        let vertex = |x: u32, y: u32| [x as f32 * step, y as f32 * step, 0.0];
        for x in 0..cells {
            for y in 0..cells {
                let a = vertex(x, y);
                let b = vertex(x + 1, y);
                let c = vertex(x + 1, y + 1);
                let d = vertex(x, y + 1);
                soup.extend_from_slice(&[a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]]);
                soup.extend_from_slice(&[a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]]);
            }
        }

        let occluded_under_wall_at = |height: f32| -> f32 {
            let mut all = soup.clone();
            // A wall over the middle of the floor, facing down.
            let (x0, x1) = (size * 0.4, size * 0.6);
            let (y0, y1) = (size * 0.4, size * 0.6);
            all.extend_from_slice(&[x0, y0, height, x1, y0, height, x1, y1, height]);
            all.extend_from_slice(&[x0, y0, height, x1, y1, height, x0, y1, height]);
            let mesh = IndexedMesh::from_triangle_soup(&all, 1e-5);
            let values = bake_vertex_occlusion(&mesh, DEFAULT_RAYS, None);
            // The floor vertex nearest the middle of the wall footprint.
            let middle = size * 0.5;
            let mut best = f32::MAX;
            let mut value = 1.0;
            for (index, position) in mesh.positions.iter().enumerate() {
                if position.z.abs() > 1e-6 {
                    continue;
                }
                let distance = (position.x - middle).powi(2) + (position.y - middle).powi(2);
                if distance < best {
                    best = distance;
                    value = values[index];
                }
            }
            value
        };

        // Inside the plateau (0.15 of a 6.8mm reach, so 1mm): full weight.
        let near = occluded_under_wall_at(0.5);
        assert!(near < 0.75, "a wall half a millimetre away should shade the floor, got {near}");
        // Part way down the taper (5.5mm is 0.8 of the reach): lighter than near.
        let mid = occluded_under_wall_at(5.5);
        assert!(
            mid > near + 0.15,
            "the taper should lighten with distance, got {near} then {mid}"
        );
        // Beyond the reach (6.8mm): nothing at all.
        let far = occluded_under_wall_at(8.0);
        assert!(
            far > 0.95,
            "a wall beyond the reach should leave the floor open, got {far}"
        );
    }

    #[test]
    fn bake_is_deterministic() {
        let soup = box_soup([0.0, 0.0, 0.0], [12.0, 9.0, 6.0]);
        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
        let a = bake_vertex_occlusion(&mesh, DEFAULT_RAYS, None);
        let b = bake_vertex_occlusion(&mesh, DEFAULT_RAYS, None);
        assert_eq!(a, b);
    }

    /// Timing reference: `cargo test -p dragonfruit-mesh-core --release --
    /// --ignored --nocapture bench_vertex_occlusion`.
    #[test]
    #[ignore]
    fn bench_vertex_occlusion() {
        for (segments, rings) in [(200u32, 100u32), (400, 200), (800, 400)] {
            let radius = 10.0f32;
            let mut soup = Vec::new();
            let mut points: Vec<[f32; 3]> = Vec::new();
            for ring in 0..=rings {
                let phi = std::f32::consts::PI * ring as f32 / rings as f32;
                for segment in 0..=segments {
                    let theta = std::f32::consts::TAU * segment as f32 / segments as f32;
                    points.push([
                        radius * phi.sin() * theta.cos(),
                        radius * phi.sin() * theta.sin(),
                        radius * phi.cos(),
                    ]);
                }
            }
            let idx = |ring: u32, segment: u32| (ring * (segments + 1) + segment) as usize;
            for ring in 0..rings {
                for segment in 0..segments {
                    for tri in [
                        [
                            idx(ring, segment),
                            idx(ring + 1, segment),
                            idx(ring + 1, segment + 1),
                        ],
                        [
                            idx(ring, segment),
                            idx(ring + 1, segment + 1),
                            idx(ring, segment + 1),
                        ],
                    ] {
                        for i in tri {
                            soup.extend_from_slice(&points[i]);
                        }
                    }
                }
            }
            let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
            let started = std::time::Instant::now();
            let occlusion = bake_vertex_occlusion(&mesh, DEFAULT_RAYS, None);
            let elapsed = started.elapsed();
            let occluded = occlusion.iter().filter(|v| **v < 0.999).count();
            println!(
                "tris={:>8} verts={:>8} bake={:>5}ms ({}% occluded)",
                soup.len() / 9,
                mesh.positions.len(),
                elapsed.as_millis(),
                (occluded * 100) / occlusion.len().max(1),
            );
        }
    }
}
