//! Refinement for meshes whose faces are too large for their own size.
//!
//! A mesh can be perfectly valid and still too coarse to carry shading: a base
//! triangulated as a fan has spokes that are an order of magnitude longer than
//! the geometry around it, and anything sampled per vertex (ambient occlusion
//! especially) is interpolated across those spokes as a straight ramp. The
//! support is a mesh whose spans are a bounded fraction of the model, which is
//! what this produces.
//!
//! Subdivision is by the longest edge, and it is conforming: an edge is split at
//! one shared midpoint, so the two triangles either side of it stay welded.

use crate::mesh::{IndexedMesh, Vec3};
use std::collections::HashMap;

/// Passes of subdivision. Each pass halves the longest edge of every triangle it
/// touches, so this bounds the work on a pathologically coarse mesh: three or
/// four passes take a tenfold-too-long edge to length, and eight would be a bad
/// model rather than a bad span.
pub const MAX_PASSES: usize = 6;

/// The longest edge a mesh may have, as a fraction of its bounding-box diagonal.
///
/// Two percent is a quarter of the ambient-occlusion reach (which is 8% of the
/// diagonal), and it is chosen at that scale deliberately: a face whose span is
/// comparable to the distance occlusion travels cannot hold the field, whereas
/// one an order of magnitude under it can. Meshes that are already finer than
/// this are returned untouched, which is the common case.
pub const MAX_EDGE_DIAGONAL_FRACTION: f32 = 0.02;

/// How much a mesh may grow under [`refine_long_edges_with_budget`].
///
/// Refining to the detail scale is not affordable on a dense hard-surface part:
/// measured on a 2.13M-triangle one, bounding by the diagonal already costs 1.85x
/// the triangles and 3x the bake, and bounding by the median edge costs 8.31x and
/// 11x. A cap turns that into a bounded, predictable cost, and the faces that get
/// refined are the worst ones, which are the ones that show.
pub const DEFAULT_GROWTH_LIMIT: f32 = 1.3;

/// Subdivide the triangles whose edges are longer than `max_edge`.
///
/// Returns the input unchanged when nothing exceeds it, so a caller can run this
/// on every load without paying for well-made models.
pub fn refine_long_edges(mesh: &IndexedMesh, max_edge: f32, max_passes: usize) -> IndexedMesh {
    refine_long_edges_with_budget(mesh, max_edge, max_passes, usize::MAX)
}

/// As [`refine_long_edges`], but never beyond `max_triangles`.
///
/// The budget is spent on the longest edges first, and it is spent on *edges*
/// rather than faces: an edge splits once for both the triangles either side of
/// it, so deciding per face would leave a T-junction on whichever side lost.
/// A face whose two long edges both fit the budget splits into three, so the
/// projected count is tracked per face as edges are admitted.
pub fn refine_long_edges_with_budget(
    mesh: &IndexedMesh,
    max_edge: f32,
    max_passes: usize,
    max_triangles: usize,
) -> IndexedMesh {
    let mut positions = mesh.positions.clone();
    let mut triangles = mesh.triangles.clone();

    for _ in 0..max_passes {
        // Which long edges this pass is allowed to split, longest first, until the
        // budget is spent. Faces sharing a chosen edge are split together.
        let mut over: HashMap<(u32, u32), (f32, [u32; 2], usize)> = HashMap::new();
        for (face, triangle) in triangles.iter().enumerate() {
            for edge in 0..3 {
                let (a, b) = (triangle[edge], triangle[(edge + 1) % 3]);
                let key = (a.min(b), a.max(b));
                let span = positions[a as usize].sub(positions[b as usize]).length();
                if span <= max_edge {
                    continue;
                }
                let entry = over.entry(key).or_insert((span, [u32::MAX; 2], 0));
                if entry.1[0] == u32::MAX {
                    entry.1[0] = face as u32;
                } else if entry.1[1] == u32::MAX {
                    entry.1[1] = face as u32;
                }
                entry.2 += 1;
            }
        }
        if over.is_empty() {
            break;
        }
        let mut candidates: Vec<((u32, u32), f32, [u32; 2])> = over
            .into_iter()
            .map(|(key, (span, faces, _))| (key, span, faces))
            .collect();
        candidates.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.0.cmp(&b.0))
        });

        // Each admitted edge costs one triangle in every face that touches it,
        // including a face that is already splitting: its second long edge makes
        // three triangles where the first made two. Counting only newly-marked
        // faces undercounts by half and the cap never binds.
        let mut projected = triangles.len();
        let mut chosen: HashMap<(u32, u32), ()> = HashMap::new();
        for (key, _, faces) in candidates {
            let delta = faces.iter().filter(|face| **face != u32::MAX).count();
            if projected + delta > max_triangles {
                break;
            }
            projected += delta;
            chosen.insert(key, ());
        }
        if chosen.is_empty() {
            break;
        }

        let mut midpoints: HashMap<(u32, u32), u32> = HashMap::new();
        let mut next: Vec<[u32; 3]> = Vec::with_capacity(projected);
        let mut split_any = false;

        for triangle in &triangles {
            let edges = [
                (triangle[0], triangle[1]),
                (triangle[1], triangle[2]),
                (triangle[2], triangle[0]),
            ];
            let mut long = [false; 3];
            let mut any_long = false;
            for (index, &(a, b)) in edges.iter().enumerate() {
                if chosen.contains_key(&(a.min(b), a.max(b))) {
                    long[index] = true;
                    any_long = true;
                }
            }
            if !any_long {
                next.push(*triangle);
                continue;
            }
            split_any = true;

            let mut midpoint = |a: u32, b: u32, positions: &mut Vec<Vec3>| -> u32 {
                let key = (a.min(b), a.max(b));
                if let Some(&existing) = midpoints.get(&key) {
                    return existing;
                }
                let point = positions[a as usize]
                    .add(positions[b as usize])
                    .scale(0.5);
                let index = positions.len() as u32;
                positions.push(point);
                midpoints.insert(key, index);
                index
            };

            // Splitting at the midpoints of the long edges keeps the triangles
            // that touch no long edge intact, which is what makes this cheap on a
            // mesh where only a few faces are coarse.
            match long {
                [true, false, false] => {
                    let m01 = midpoint(edges[0].0, edges[0].1, &mut positions);
                    next.push([triangle[0], m01, triangle[2]]);
                    next.push([m01, triangle[1], triangle[2]]);
                }
                [false, true, false] => {
                    let m12 = midpoint(edges[1].0, edges[1].1, &mut positions);
                    next.push([triangle[1], m12, triangle[0]]);
                    next.push([m12, triangle[2], triangle[0]]);
                }
                [false, false, true] => {
                    let m20 = midpoint(edges[2].0, edges[2].1, &mut positions);
                    next.push([triangle[2], m20, triangle[1]]);
                    next.push([m20, triangle[0], triangle[1]]);
                }
                [true, true, false] => {
                    let m01 = midpoint(edges[0].0, edges[0].1, &mut positions);
                    let m12 = midpoint(edges[1].0, edges[1].1, &mut positions);
                    next.push([triangle[0], m01, m12]);
                    next.push([m01, triangle[1], m12]);
                    next.push([m12, triangle[2], triangle[0]]);
                }
                [false, true, true] => {
                    let m12 = midpoint(edges[1].0, edges[1].1, &mut positions);
                    let m20 = midpoint(edges[2].0, edges[2].1, &mut positions);
                    next.push([triangle[1], m12, m20]);
                    next.push([m12, triangle[2], m20]);
                    next.push([m20, triangle[0], triangle[1]]);
                }
                [true, false, true] => {
                    let m01 = midpoint(edges[0].0, edges[0].1, &mut positions);
                    let m20 = midpoint(edges[2].0, edges[2].1, &mut positions);
                    next.push([triangle[2], m20, m01]);
                    next.push([m20, triangle[0], m01]);
                    next.push([m01, triangle[1], triangle[2]]);
                }
                // All three long: the classic one-to-four, with the middle
                // triangle keeping the parent's winding.
                [true, true, true] => {
                    let m01 = midpoint(edges[0].0, edges[0].1, &mut positions);
                    let m12 = midpoint(edges[1].0, edges[1].1, &mut positions);
                    let m20 = midpoint(edges[2].0, edges[2].1, &mut positions);
                    next.push([triangle[0], m01, m20]);
                    next.push([m01, triangle[1], m12]);
                    next.push([m20, m12, triangle[2]]);
                    next.push([m01, m12, m20]);
                }
                _ => next.push(*triangle),
            }
        }

        triangles = next;
        if !split_any {
            break;
        }
    }

    IndexedMesh {
        positions,
        triangles,
    }
}

/// The longest edge in a mesh, for reporting what a load had to work with.
pub fn longest_edge(mesh: &IndexedMesh) -> f32 {
    let mut longest = 0.0f32;
    for triangle in &mesh.triangles {
        for edge in 0..3 {
            let a = mesh.positions[triangle[edge] as usize];
            let b = mesh.positions[triangle[(edge + 1) % 3] as usize];
            longest = longest.max(a.sub(b).length());
        }
    }
    longest
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A cube with two triangles per face: coarse, closed, and outward wound.
    fn coarse_cube(size: f32) -> IndexedMesh {
        let v = [
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(size, 0.0, 0.0),
            Vec3::new(size, size, 0.0),
            Vec3::new(0.0, size, 0.0),
            Vec3::new(0.0, 0.0, size),
            Vec3::new(size, 0.0, size),
            Vec3::new(size, size, size),
            Vec3::new(0.0, size, size),
        ];
        let quads = [
            [0, 3, 2, 1],
            [4, 5, 6, 7],
            [0, 1, 5, 4],
            [1, 2, 6, 5],
            [2, 3, 7, 6],
            [3, 0, 4, 7],
        ];
        let mut triangles = Vec::new();
        for quad in quads {
            triangles.push([quad[0], quad[1], quad[2]]);
            triangles.push([quad[0], quad[2], quad[3]]);
        }
        IndexedMesh {
            positions: v.to_vec(),
            triangles,
        }
    }

    /// Edges not shared by exactly two triangles: a boundary, or a T-junction
    /// left behind by splitting one side of an edge.
    fn non_manifold_edges(mesh: &IndexedMesh) -> usize {
        let mut counts: HashMap<(u32, u32), u32> = HashMap::new();
        for triangle in &mesh.triangles {
            for edge in 0..3 {
                let (a, b) = (triangle[edge], triangle[(edge + 1) % 3]);
                *counts.entry((a.min(b), a.max(b))).or_insert(0) += 1;
            }
        }
        counts.values().filter(|&&count| count != 2).count()
    }

    /// Signed volume by the divergence theorem: invariant under any subdivision
    /// that keeps the surface, and negative if the winding flipped.
    fn volume(mesh: &IndexedMesh) -> f32 {
        let mut total = 0.0f32;
        for triangle in &mesh.triangles {
            let a = mesh.positions[triangle[0] as usize];
            let b = mesh.positions[triangle[1] as usize];
            let c = mesh.positions[triangle[2] as usize];
            total += a.dot(b.cross(c)) / 6.0;
        }
        total
    }

    #[test]
    fn a_coarse_face_is_refined_until_its_spans_are_short() {
        let mesh = coarse_cube(100.0);
        let max_edge = 10.0;
        assert_eq!(non_manifold_edges(&mesh), 0);
        assert!(longest_edge(&mesh) > max_edge, "the fixture must start coarse");

        let refined = refine_long_edges(&mesh, max_edge, MAX_PASSES);

        assert!(
            longest_edge(&refined) <= max_edge,
            "longest edge after refinement: {}",
            longest_edge(&refined)
        );
        assert!(refined.triangles.len() > mesh.triangles.len());
        assert_eq!(
            non_manifold_edges(&refined),
            0,
            "refinement left a boundary or a T-junction"
        );
        let (before, after) = (volume(&mesh), volume(&refined));
        assert!(
            (before - after).abs() < before.abs() * 1e-4,
            "the surface moved: volume {before} became {after}"
        );
    }


    /// A budget spent longest-edge-first, without stranding a T-junction.
    ///
    /// Deciding per face rather than per edge would split one side of an edge and
    /// leave the other whole, which is what the manifold check catches.
    #[test]
    fn a_budget_caps_the_growth_and_still_leaves_a_manifold() {
        let mesh = coarse_cube(100.0);
        let original = mesh.triangles.len();
        let budget = original + 12;
        let refined = refine_long_edges_with_budget(&mesh, 1.0, MAX_PASSES, budget);

        assert!(
            refined.triangles.len() <= budget,
            "budget was {budget}, got {}",
            refined.triangles.len()
        );
        assert!(
            refined.triangles.len() > original,
            "the budget should still buy some refinement"
        );
        assert_eq!(
            non_manifold_edges(&refined),
            0,
            "a budgeted refinement left a boundary or a T-junction"
        );
        assert!(
            (volume(&mesh) - volume(&refined)).abs() < volume(&mesh).abs() * 1e-4,
            "the surface moved"
        );
        // The longest edge is what the budget was spent on, so it is gone even
        // though the mesh cannot be refined all the way to the threshold.
        let before = longest_edge(&mesh);
        let after = longest_edge(&refined);
        assert!(after < before, "nothing was refined: {before} then {after}");
    }

    #[test]
    fn a_mesh_that_is_already_fine_is_returned_untouched() {
        let mesh = coarse_cube(10.0);
        let refined = refine_long_edges(&mesh, 100.0, MAX_PASSES);
        assert_eq!(refined.triangles.len(), mesh.triangles.len());
        assert_eq!(refined.positions.len(), mesh.positions.len());
    }

    #[test]
    fn refinement_is_deterministic() {
        let mesh = coarse_cube(100.0);
        let first = refine_long_edges(&mesh, 7.0, MAX_PASSES);
        let second = refine_long_edges(&mesh, 7.0, MAX_PASSES);
        assert_eq!(first.positions.len(), second.positions.len());
        assert_eq!(first.triangles, second.triangles);
        for (a, b) in first.positions.iter().zip(second.positions.iter()) {
            assert_eq!((a.x, a.y, a.z), (b.x, b.y, b.z));
        }
    }
}
