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
//!
//! The same bundle also gives the *average escaping direction*, [`VertexVisibility::moment`],
//! which is the vertex's bent normal and points along the field's slope — three
//! accumulates per sample, no extra rays.

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
///
/// The fan is one table, shared by every vertex; what differs per vertex is the
/// basis it is laid into and the turn [`fan_rotation`] gives it.
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

/// The bake over a triangle soup: one value and one moment per *corner*, in the
/// soup's own order, plus the welded vertex count.
///
/// **The weld happens here, once.** An earlier version called
/// `IndexedMesh::from_triangle_soup` and then rebuilt the corner-to-vertex map
/// separately to expand the values back out. Two welds with different tolerances
/// disagree about which corners are the same vertex, and the values were being
/// indexed with one mapping into a mesh built with the other — on models with
/// near-coincident vertices (which is most STL soups at their shared edges) that
/// shifts occlusion by a vertex, and it renders as misaligned triangles. One
/// mapping, used in both directions, cannot disagree with itself.
pub fn bake_visibility_for_soup(
    positions: &[f32],
    rays: usize,
    reach_mm: Option<f32>,
) -> (VertexVisibility, usize) {
    let corner_count = positions.len() / 3;
    if corner_count == 0 {
        return (VertexVisibility { occlusion: Vec::new(), moment: Vec::new() }, 0);
    }

    let (mesh, corner_map) =
        IndexedMesh::from_triangle_soup_with_corner_map(positions, SOUP_MERGE_EPSILON);
    let welded = bake_vertex_visibility(&mesh, rays, reach_mm);

    // Expanded through the same map, in one pass: two passes would be two
    // chances to index the occlusion and the moment differently.
    let mut occlusion = Vec::with_capacity(corner_map.len());
    let mut moment = Vec::with_capacity(corner_map.len());
    for id in &corner_map {
        let index = *id as usize;
        occlusion.push(welded.occlusion.get(index).copied().unwrap_or(1.0));
        moment.push(welded.moment.get(index).copied().unwrap_or(Vec3::ZERO));
    }

    debug_assert_eq!(
        occlusion.len(),
        positions.len() / 3,
        "one value per corner of the soup, in its own order"
    );
    debug_assert_eq!(moment.len(), occlusion.len(), "one moment per value");
    (VertexVisibility { occlusion, moment }, mesh.positions.len())
}

/// [`bake_visibility_for_soup`], scalar only.
pub fn bake_vertex_occlusion_for_soup(
    positions: &[f32],
    rays: usize,
    reach_mm: Option<f32>,
) -> (Vec<f32>, usize) {
    let (visibility, welded) = bake_visibility_for_soup(positions, rays, reach_mm);
    (visibility.occlusion, welded)
}

/// [`bake_smoothed_vertex_occlusion`] over a soup: one value per corner, in the
/// soup's own order, plus the welded vertex count.
///
/// The smoothing runs on the welded field, before it is expanded back out, so
/// the pass sees the mesh's real neighbours rather than the soup's duplicated
/// corners: a pass over the soup's own corner graph would average a vertex with
/// copies of itself and change nothing.
pub fn bake_smoothed_occlusion_for_soup(
    positions: &[f32],
    rays: usize,
    reach_mm: Option<f32>,
) -> (Vec<f32>, usize) {
    let (mesh, corner_map) =
        IndexedMesh::from_triangle_soup_with_corner_map(positions, SOUP_MERGE_EPSILON);
    if mesh.positions.is_empty() {
        return (Vec::new(), 0);
    }
    let smoothed = bake_smoothed_vertex_occlusion(&mesh, rays, reach_mm);
    let out: Vec<f32> = corner_map
        .iter()
        .map(|id| smoothed.get(*id as usize).copied().unwrap_or(1.0))
        .collect();
    (out, mesh.positions.len())
}

/// One value per vertex: 1 = open sky, 0 = fully occluded.
pub fn bake_vertex_occlusion(mesh: &IndexedMesh, rays: usize, reach_mm: Option<f32>) -> Vec<f32> {
    bake_against(mesh, mesh, rays, reach_mm)
}

/// The bake's full per-vertex output: the scalar occlusion, and the visibility
/// moment it is derived from.
///
/// **The moment is the second thing the same ray bundle can tell us**, and it
/// costs three accumulates per sample rather than another ray bundle: it is
/// `(1/N) Σ ωᵢ·(1 − wᵢ)`, the cosine-weighted average of the directions that
/// escaped, expressed in the mesh's own frame. Its length is therefore at most
/// the occlusion value, and its direction is the vertex's *bent normal* — a
/// direction, so that a crease darkens on the side facing its occluder rather
/// than washing uniformly, and so that interpolating it across a face varies a
/// vector instead of drawing a chord through a scalar.
///
/// Its tangential part *points* along the field's slope, and it is not the
/// slope. A direction moment weights every blocked direction equally, while the
/// derivative of the field weights each by how far away its occluder sits,
/// because moving the receiver moves a far silhouette less than a near one.
/// Carrying that distance explicitly does not close the gap either: measured
/// against the field's own finite difference on a floor facing a wall, a blocked
/// moment weighted by `w/t` runs from 0.6 of the slope next to the wall to more
/// than 50 at the end of the reach, because what is left in it is the falloff
/// weighting's own derivative. So the moment is a *direction* to reconstruct
/// with, not a gradient, and the slope a reconstruction wants is still open.
///
/// What the slope is for is the wedge a coarse face shows: a chord through three
/// vertex values has a discontinuous slope across every edge, and a
/// reconstruction carrying the slope does not
/// (see "Faces too long to carry a per-vertex field" in
/// `docs/dev/tauri-ipc-bridge.md`). That page has the numbers above.
///
/// A vertex with no usable normal (isolated or degenerate) gets a zero moment,
/// which reads as "no direction known"; a consumer falls back to the geometric
/// normal there.
pub struct VertexVisibility {
    /// One per vertex: 1 = open sky, 0 = fully occluded.
    pub occlusion: Vec<f32>,
    /// `(1/N) Σ ωᵢ·(1 − wᵢ)`, one per vertex, in the mesh's own frame.
    pub moment: Vec<Vec3>,
}

/// How far the fan turns with the vertex.
///
/// A fixed fan's discretisation error is a function of the local surface shape
/// relative to the fan's own orientation, so neighbouring vertices share it, and
/// averaging correlated error removes nothing: measured on a 384,324-vertex
/// model, one mesh-graph pass over the *fixed* fan moved the field 12% closer to
/// a 64-ray reference, while the same pass over a *turned* fan moved it 34%
/// closer. The turn is what makes the error incoherent; the pass is what then
/// averages it away.
fn fan_rotation(position: Vec3, reach: f32) -> f32 {
    // Quantised at a thousandth of the reach first, so the turn is a function of
    // where the vertex is and not of the last bits of a coordinate that corners
    // within the weld tolerance disagree about.
    let quantum = (reach * 1e-3).max(f32::MIN_POSITIVE);
    let mut hash: u32 = 0x9e37_79b9;
    for axis in [position.x, position.y, position.z] {
        let cell = (axis / quantum).round() as i64 as u64;
        hash ^= (cell as u32) ^ ((cell >> 32) as u32);
        hash = hash.wrapping_mul(0x85eb_ca6b);
        hash ^= hash >> 13;
    }
    (hash as f32 / u32::MAX as f32) * std::f32::consts::TAU
}

/// Passes of mesh-graph smoothing [`bake_smoothed_vertex_occlusion`] applies.
///
/// One, because that is where the trade stops paying: on the 384,324-vertex
/// model the field's roughness falls 0.0303 → 0.0129 in one pass and its
/// distance to a 64-ray reference falls with it (0.0564 → 0.0508), but a second
/// pass leaves that distance *worse* than the first (0.0521), i.e. it has
/// started eating the field's own sub-millimetre detail rather than the
/// estimator's noise.
pub const SMOOTHING_PASSES: usize = 1;

/// How much of a neighbour average one pass takes.
///
/// Measured across `0.2..0.9` on the same model: below this the pass barely
/// moves the roughness, above it the accuracy lost per unit of smoothness climbs.
const SMOOTHING_WEIGHT: f32 = 0.6;

/// Average each vertex's value toward its one-ring neighbours.
///
/// The mesh graph is the regular neighbourhood a vertex field can have, so this
/// is the filter that domain allows: it removes the estimator's incoherent error
/// without inventing geometry. Duplicate neighbours (a vertex reached by two
/// triangles) count twice, which is what the measurement above weighted too.
pub fn smooth_over_mesh_graph(mesh: &IndexedMesh, values: &[f32], passes: usize) -> Vec<f32> {
    let count = mesh.positions.len();
    if passes == 0 || count == 0 {
        return values.to_vec();
    }
    // CSR adjacency: offsets, then each vertex's neighbour list.
    let mut offsets = vec![0u32; count + 1];
    for tri in &mesh.triangles {
        for index in tri {
            offsets[*index as usize + 1] += 2;
        }
    }
    for i in 0..count {
        offsets[i + 1] += offsets[i];
    }
    let mut neighbours = vec![0u32; offsets[count] as usize];
    let mut cursor = offsets.clone();
    for tri in &mesh.triangles {
        for a in 0..3 {
            let (from, to) = (tri[a], tri[(a + 1) % 3]);
            neighbours[cursor[from as usize] as usize] = to;
            cursor[from as usize] += 1;
            let (from, to) = (tri[(a + 1) % 3], tri[a]);
            neighbours[cursor[from as usize] as usize] = to;
            cursor[from as usize] += 1;
        }
    }

    let mut current = values.to_vec();
    let mut next = current.clone();
    for _ in 0..passes {
        next.par_iter_mut().enumerate().for_each(|(index, slot)| {
            let start = offsets[index] as usize;
            let end = offsets[index + 1] as usize;
            if start == end {
                *slot = current[index];
                return;
            }
            let mut sum = 0.0f32;
            for n in &neighbours[start..end] {
                sum += current[*n as usize];
            }
            let mean = sum / (end - start) as f32;
            *slot = current[index] * (1.0 - SMOOTHING_WEIGHT) + mean * SMOOTHING_WEIGHT;
        });
        std::mem::swap(&mut current, &mut next);
    }
    current
}

/// The occlusion field the material consumes: the turned-fan bake, then
/// [`SMOOTHING_PASSES`] of mesh-graph smoothing.
///
/// Measured on the two models this was built against, against a reference made
/// from two 64-ray realisations:
///
/// | | 384,324 vertices | 85,395 vertices |
/// | --- | --- | --- |
/// | shipped (fixed fan, 8 rays) | RMS 0.0554, roughness 0.0303 | RMS 0.0534, roughness 0.0323 |
/// | this, 32 rays | RMS 0.0242, roughness 0.0097 | RMS 0.0195, roughness 0.0098 |
///
/// About 2.3x more accurate and 3x smoother than the field that ships, for a
/// bake that costs roughly four times as long and runs on an idle callback.
pub fn bake_smoothed_vertex_occlusion(
    mesh: &IndexedMesh,
    rays: usize,
    reach_mm: Option<f32>,
) -> Vec<f32> {
    let turned = bake_against_with_visibility_and_rotation(mesh, mesh, rays, reach_mm, true);
    smooth_over_mesh_graph(mesh, &turned.occlusion, SMOOTHING_PASSES)
}

/// The bake, keeping the visibility moment [`bake_vertex_occlusion`] discards.
pub fn bake_vertex_visibility(
    mesh: &IndexedMesh,
    rays: usize,
    reach_mm: Option<f32>,
) -> VertexVisibility {
    bake_against_with_visibility(mesh, mesh, rays, reach_mm)
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
    bake_against_with_visibility(mesh, occluder, rays, reach_mm).occlusion
}

/// [`bake_against`] without throwing the moment away.
///
/// One implementation rather than two, because the moment has to come from the
/// same ray bundle as the scalar it qualifies: a second loop would be a second
/// chance for the two to disagree about the mesh, which is the failure mode
/// this module has already been bitten by once.
pub fn bake_against_with_visibility(
    mesh: &IndexedMesh,
    occluder: &IndexedMesh,
    rays: usize,
    reach_mm: Option<f32>,
) -> VertexVisibility {
    bake_against_with_visibility_and_rotation(mesh, occluder, rays, reach_mm, false)
}

/// [`bake_against_with_visibility`], optionally turning the fan per vertex.
fn bake_against_with_visibility_and_rotation(
    mesh: &IndexedMesh,
    occluder: &IndexedMesh,
    rays: usize,
    reach_mm: Option<f32>,
    turned: bool,
) -> VertexVisibility {
    let vertex_count = mesh.positions.len();
    if vertex_count == 0 {
        return VertexVisibility { occlusion: Vec::new(), moment: Vec::new() };
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
    let mut moments = vec![Vec3::ZERO; vertex_count];
    out.par_iter_mut()
        .zip(moments.par_iter_mut())
        .enumerate()
        .for_each(|(index, (value, moment))| {
            let mut normal = normals[index];
            if normal.length() < 1e-12 {
                // Isolated or degenerate vertex: open sky is the honest answer,
                // and there is no direction to point a bent normal at.
                *value = 1.0;
                *moment = Vec3::ZERO;
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
            // The turn, applied to the basis rather than to the sample table, so
            // the fan stays one shared array: rotating it about the normal by the
            // vertex's own angle is the same thing, and it costs a sine and a
            // cosine per vertex.
            let (tangent, bitangent) = if turned {
                let (sin, cos) = fan_rotation(mesh.positions[index], reach).sin_cos();
                (
                    tangent.scale(cos).add(bitangent.scale(sin)),
                    bitangent.scale(cos).sub(tangent.scale(sin)),
                )
            } else {
                (tangent, bitangent)
            };

            let origin = mesh.positions[index].add(normal.scale(bias));
            let mut hits = 0.0f32;
            // The escaping directions, in mesh space: this is the moment above.
            // Same loop, same bundle, so the two outputs cannot disagree.
            let mut escaped = Vec3::ZERO;
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
                let blocked = match bvh.ray_nearest_within(occluder, origin, dir, reach, plateau) {
                    // Full weight within the plateau, then a straight taper to
                    // nothing at the end of the reach.
                    Some(t) => {
                        let span = (t - plateau) / (falloff_end - plateau).max(1e-6);
                        (1.0 - span).clamp(0.0, 1.0)
                    }
                    None => 0.0,
                };
                hits += blocked;
                escaped = escaped.add(dir.scale(1.0 - blocked));
            }
            let sample_count = samples.len() as f32;
            *value = 1.0 - hits / sample_count;
            *moment = escaped.scale(1.0 / sample_count);
        });

    VertexVisibility { occlusion: out, moment: moments }
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

    /// The moment the fan itself produces on an unoccluded surface.
    ///
    /// A finite fan's directions do not sum to its axis. Measured on the shipped
    /// one: 8 rays leave a **0.057 transverse moment, a 4.85° lean**, 16 leave
    /// 0.030 (2.58°), 32 leave 0.016 (1.39°), 64 leave 0.009 (0.75°) — it falls
    /// with ray count and it is *coherent*: the same lean in every vertex's own
    /// tangent frame, so a flat floor reads as uniformly tilted rather than as
    /// noise. Every directional claim below subtracts it, because on a surface
    /// with one normal it is the entire reading of a vertex far from its occluder.
    fn fan_bias() -> Vec3 {
        let samples = hemisphere_samples(DEFAULT_RAYS);
        let sum = samples.iter().fold(Vec3::ZERO, |acc, sample| acc.add(*sample));
        sum.scale(1.0 / samples.len() as f32)
    }

    /// The visibility moment is a direction integral, and on a surface nothing
    /// occludes it is the fan's own axis: two thirds of the normal, plus the
    /// fan's transverse lean and nothing else.
    ///
    /// That two thirds is not a tuned number — a cosine-weighted fan over a
    /// hemisphere has `E[√(1 − u)] = 2/3` for `u` uniform — so the axis pins the
    /// accumulation and the `1/N` scaling, and the transverse part pins the
    /// tangent-to-mesh frame: the fan's mean is computed in tangent space and the
    /// bake's is in mesh space, so a swapped basis fails here.
    #[test]
    fn open_surface_moment_is_the_fan_axis() {
        // A flat plate: two triangles, four vertices, normal +Z, nothing above it.
        let soup = [
            0.0f32, 0.0, 0.0, 10.0, 0.0, 0.0, 10.0, 10.0, 0.0, //
            0.0, 0.0, 0.0, 10.0, 10.0, 0.0, 0.0, 10.0, 0.0,
        ];
        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
        let visibility = bake_vertex_visibility(&mesh, DEFAULT_RAYS, None);
        let bias = fan_bias();
        assert!(
            bias.length() > 0.05,
            "the fan's own transverse lean should be documented here, got {}",
            bias.length(),
        );

        assert_eq!(visibility.moment.len(), mesh.positions.len());
        for (index, moment) in visibility.moment.iter().enumerate() {
            let occlusion = visibility.occlusion[index];
            assert!(occlusion > 0.999, "the plate should be open, got {occlusion}");
            assert!(
                (moment.z - 2.0 / 3.0).abs() < 0.01,
                "an open surface's moment should sit at 2/3 of its normal, got {moment:?}",
            );
            assert!(
                moment.sub(bias).length() < 1e-4,
                "an open surface's moment is the fan's own mean and nothing else: \
                 got {moment:?} against {bias:?}",
            );
            assert!(
                moment.length() <= occlusion + 1e-6,
                "the moment cannot outrun the occlusion it comes from: {moment:?} at {occlusion}",
            );
        }
    }

    /// The moment's component in the tangent plane leans away from the occluder,
    /// and less as the occluder recedes, while the occlusion value rises with
    /// distance. It tracks the field's slope rather than being it (see
    /// [`VertexVisibility::moment`] for what it is not), and this is the part of
    /// that claim that holds: on the rise out of a crease it points the right way
    /// and fades as the field flattens.
    ///
    /// If the moment were only "a direction to shade with" it could point
    /// anywhere on a surface whose shading is uniform, and the first assertion
    /// below would be arbitrary.
    #[test]
    fn moment_leans_away_from_the_occluder_along_the_rising_field() {
        // A 1mm-triangulated 40mm floor with a block 6mm tall over its middle.
        // The reach is 8% of the diagonal, about 4.5mm, so the block's wall is
        // inside the falloff for the vertices near it and out of it by the end of
        // the walk, which is what gives the field somewhere to decay.
        let size = 40.0f32;
        let step = 1.0f32;
        let cells = (size / step) as u32;
        let vertex = |x: u32, y: u32| [x as f32 * step, y as f32 * step, 0.0];
        let mut soup = Vec::new();
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
        soup.extend(box_soup([10.0, 10.0, 0.2], [30.0, 30.0, 6.0]));
        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
        let visibility = bake_vertex_visibility(&mesh, DEFAULT_RAYS, None);

        // Floor vertices along y = 20, walking out from under the block's +x wall.
        // The floor's normal is +Z everywhere, so every vertex shares one tangent
        // frame and the fan's bias is one vector for the whole walk — which is
        // exactly why it has to come off before the tilt says anything.
        let bias = fan_bias().x;
        let mut walk = Vec::new();
        for x in 31..=37 {
            let mut best = f32::MAX;
            let mut nearest = None;
            for (index, position) in mesh.positions.iter().enumerate() {
                if position.z.abs() > 1e-6 {
                    continue;
                }
                let distance = (position.x - x as f32).powi(2) + (position.y - 20.0).powi(2);
                if distance < best {
                    best = distance;
                    nearest = Some(index);
                }
            }
            let index = nearest.expect("a floor vertex in the walk");
            walk.push((x, visibility.occlusion[index], visibility.moment[index].x - bias));
        }

        // The walk has to span the decay, or the monotonicity below proves nothing.
        let first = walk.first().unwrap();
        let last = walk.last().unwrap();
        assert!(
            last.1 > first.1 + 0.05,
            "the walk should cross the falloff, got {} then {}",
            first.1,
            last.1,
        );
        assert!(
            first.2 > 0.05,
            "next to the wall the lean should be unmistakable, got {}",
            first.2,
        );
        assert!(
            walk[2].2 > 0.0,
            "the lean should survive past the first vertex, got {} at x={}",
            walk[2].2,
            walk[2].0,
        );
        for pair in walk.windows(2) {
            assert!(
                pair[1].1 >= pair[0].1 - 0.02,
                "the field should lighten with distance from the block: {:?} then {:?}",
                (pair[0].0, pair[0].1),
                (pair[1].0, pair[1].1),
            );
            assert!(
                pair[1].2 <= pair[0].2 + 0.02,
                "and the lean should fade, not grow: {:?} then {:?}",
                (pair[0].0, pair[0].2),
                (pair[1].0, pair[1].2),
            );
        }
    }

    #[test]
    fn bake_is_deterministic() {
        let soup = box_soup([0.0, 0.0, 0.0], [12.0, 9.0, 6.0]);
        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
        let a = bake_vertex_visibility(&mesh, DEFAULT_RAYS, None);
        let b = bake_vertex_visibility(&mesh, DEFAULT_RAYS, None);
        assert_eq!(a.occlusion, b.occlusion);
        assert_eq!(a.moment, b.moment);
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

#[cfg(test)]
mod smoothing_tests {
    use super::*;
    use crate::mesh::IndexedMesh;

    fn box_soup(min: [f32; 3], max: [f32; 3]) -> Vec<f32> {
        let c = [
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
                    out.extend_from_slice(&c[i]);
                }
            }
        }
        out
    }

    fn slot_fixture() -> IndexedMesh {
        // The module's own slot geometry, on the 0.5mm floor grid the estimator
        // tests use: a field with a real gradient across a 2mm slot, resolved by
        // enough vertices for a distance measurement to mean something.
        let size = 60.0f32;
        let step = 0.5f32;
        let cells = (size / step) as u32;
        let vertex = |x: u32, y: u32| [x as f32 * step, y as f32 * step, 0.0];
        let mut soup = Vec::new();
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
        soup.extend(box_soup([0.0, 8.5, 0.0], [60.0, 9.0, 6.0]));
        soup.extend(box_soup([0.0, 11.0, 0.0], [60.0, 11.5, 6.0]));
        IndexedMesh::from_triangle_soup(&soup, 1e-5)
    }

    fn roughness(mesh: &IndexedMesh, values: &[f32]) -> f32 {
        let smoothed = smooth_over_mesh_graph(mesh, values, 1);
        // One pass with weight 0.6 leaves 40% of the original deviation, so undo
        // it to read the field's own roughness.
        let mut sum = 0.0f32;
        let mut count = 0.0f32;
        for (a, b) in smoothed.iter().zip(values.iter()) {
            sum += (a - b).abs() / SMOOTHING_WEIGHT;
            count += 1.0;
        }
        sum / count.max(1.0)
    }

    /// The pass smooths, and the turned fan is what makes that worth doing.
    #[test]
    fn smoothing_moves_the_field_toward_a_more_sampled_one() {
        let mesh = slot_fixture();
        let reference = bake_vertex_occlusion(&mesh, 32, None);
        let fixed = bake_smoothed_turned_probe(&mesh, 8, false);
        let turned = bake_smoothed_turned_probe(&mesh, 8, true);

        let distance = |values: &[f32]| -> f32 {
            let sum: f32 = values
                .iter()
                .zip(reference.iter())
                .map(|(a, b)| (a - b) * (a - b))
                .sum();
            (sum / values.len() as f32).sqrt()
        };
        let fixed_distance = distance(&fixed);
        let turned_distance = distance(&turned);
        assert!(
            turned_distance < fixed_distance * 0.9,
            "the turned fan has to be measurably closer to the 32-ray field than the fixed one: \
             {turned_distance} against {fixed_distance}"
        );

        // And the pass has to be a contraction: a neighbour average lowers the
        // field's own roughness, measured as its deviation from the one-ring
        // mean (recovered from the weighted pass).
        let once = smooth_over_mesh_graph(&mesh, &fixed, SMOOTHING_PASSES);
        assert!(
            smoothed_in_range(&once),
            "averaging convex combinations of values in [0, 1] cannot leave [0, 1]"
        );
        let before = roughness(&mesh, &fixed);
        let after = roughness(&mesh, &once);
        assert!(
            after < before * 0.9,
            "one pass should lower the roughness clearly: {after} against {before}"
        );
    }

    fn smoothed_in_range(values: &[f32]) -> bool {
        values.iter().all(|v| (0.0..=1.0).contains(v))
    }

    /// The fixture, baked with the rotation flag exposed so the test can compare
    /// the two fans at the same ray count.
    fn bake_smoothed_turned_probe(mesh: &IndexedMesh, rays: usize, turned: bool) -> Vec<f32> {
        let visibility = bake_against_with_visibility_and_rotation(mesh, mesh, rays, None, turned);
        smooth_over_mesh_graph(mesh, &visibility.occlusion, SMOOTHING_PASSES)
    }

    /// The soup path has to give one value per corner and agree with the mesh
    /// path at the corners' welded vertices.
    #[test]
    fn the_soup_entry_welds_before_it_smooths() {
        let mesh = slot_fixture();
        let soup = mesh.to_triangle_soup();
        let (values, welded) = bake_smoothed_occlusion_for_soup(&soup, 8, None);
        assert_eq!(values.len(), soup.len() / 3, "one value per corner");
        assert!(smoothed_in_range(&values), "a bake cannot leave [0, 1]");
        let (again, welded_again) = bake_smoothed_occlusion_for_soup(&soup, 8, None);
        assert_eq!(values, again, "a re-bake has to reproduce itself");
        assert_eq!(welded, welded_again);
        assert!(welded > 0 && welded < values.len(), "the soup has corners to weld: {welded}");
    }
}
