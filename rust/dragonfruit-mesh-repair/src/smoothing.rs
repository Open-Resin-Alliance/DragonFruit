//! Taubin vertex smoothing, shared by the surfaces this engine *resolves* rather than repairs.
//!
//! Two callers need it, and for the same reason: a surface that came out of a lattice, a boolean or a
//! marching pass carries the stair-steps of whatever produced it. The hollow's cavity smoothed first
//! ("to reduce voxel stair-stepping while preserving volume better than pure Laplacian smoothing"), and
//! the surface-to-solid rebuild is the same shape of surface — measured on `Gusano_de_Dune_70%.stl`, its
//! rebuild had 13.3% of its edges over 30° where the input had 7.4%, and 7.2% over 60° against 3.7%.
//!
//! Two passes per iteration, one shrinking and one growing (`lambda` then `mu`), which is Taubin's
//! volume-preserving pair: the backward pass undoes most of the shrinkage the forward one costs. A
//! candidate move is rejected when it would flatten, invert or blow up any face it touches, so the
//! surface cannot fold under it, and boundary vertices stay where they are.

use crate::core::mesh::{IndexedMesh, Vec3};

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct TaubinPassStats {
    pub(crate) applied_vertices: usize,
}

/// Smooth a mesh in place: `iterations` Taubin pairs, with no vertex moving further than `max_step`
/// in one pass. `edge_scale` is the size of the features the surface is made of — a voxel for a
/// cavity, a median edge for a rebuild — and sets how small a face the guards refuse to collapse.
pub(crate) fn taubin_smooth(mesh: &mut IndexedMesh, iterations: usize, edge_scale: f32, max_step: f32) {
    if iterations == 0 || mesh.positions.len() < 4 || mesh.triangles.is_empty() {
        return;
    }

    let vertex_count = mesh.positions.len();
    let mut neighbors: Vec<Vec<usize>> = vec![Vec::new(); vertex_count];
    let mut vertex_faces: Vec<Vec<usize>> = vec![Vec::new(); vertex_count];
    let mut edge_counts: std::collections::HashMap<(u32, u32), u8> =
        std::collections::HashMap::with_capacity(mesh.triangles.len() * 2);

    let mut add_edge = |a: u32, b: u32| {
        let ai = a as usize;
        let bi = b as usize;
        neighbors[ai].push(bi);
        neighbors[bi].push(ai);

        let key = if a < b { (a, b) } else { (b, a) };
        let entry = edge_counts.entry(key).or_insert(0);
        *entry = entry.saturating_add(1);
    };

    for tri in &mesh.triangles {
        let [a, b, c] = *tri;
        if a == b || b == c || c == a {
            continue;
        }
        add_edge(a, b);
        add_edge(b, c);
        add_edge(c, a);
    }
    for (face_idx, tri) in mesh.triangles.iter().enumerate() {
        vertex_faces[tri[0] as usize].push(face_idx);
        vertex_faces[tri[1] as usize].push(face_idx);
        vertex_faces[tri[2] as usize].push(face_idx);
    }

    for ring in &mut neighbors {
        ring.sort_unstable();
        ring.dedup();
    }

    let mut boundary_vertex = vec![false; vertex_count];
    for ((a, b), count) in edge_counts {
        if count == 1 {
            boundary_vertex[a as usize] = true;
            boundary_vertex[b as usize] = true;
        }
    }

    let mut positions = mesh.positions.clone();
    let area_floor = (edge_scale * edge_scale * 1e-4).max(1e-8);
    let iterations = iterations.max(1);
    let max_step = max_step.max(0.01);

    for _ in 0..iterations {
        let forward = taubin_pass(
            &mut positions,
            &mesh.triangles,
            &neighbors,
            &vertex_faces,
            &boundary_vertex,
            0.36,
            area_floor,
            max_step,
        );
        let backward = taubin_pass(
            &mut positions,
            &mesh.triangles,
            &neighbors,
            &vertex_faces,
            &boundary_vertex,
            -0.38,
            area_floor,
            max_step,
        );
        if forward.applied_vertices + backward.applied_vertices == 0 {
            break;
        }
    }

    mesh.positions = positions;
}

fn taubin_pass(
    positions: &mut [Vec3],
    triangles: &[[u32; 3]],
    neighbors: &[Vec<usize>],
    vertex_faces: &[Vec<usize>],
    boundary_vertex: &[bool],
    weight: f32,
    area_floor: f32,
    max_step: f32,
) -> TaubinPassStats {
    let prev = positions.to_vec();
    let mut stats = TaubinPassStats::default();

    for i in 0..positions.len() {
        if boundary_vertex[i] {
            continue;
        }
        let ring = &neighbors[i];
        if ring.len() < 3 {
            continue;
        }

        let mut centroid = Vec3::ZERO;
        for &j in ring {
            centroid = centroid.add(prev[j]);
        }
        centroid = centroid.scale(1.0 / ring.len() as f32);

        let mut delta = centroid.sub(prev[i]).scale(weight);
        let len = delta.length();
        if len > max_step && len > 1e-8 {
            delta = delta.scale(max_step / len);
        }

        for scale in [1.0_f32, 0.5, 0.25] {
            let candidate = prev[i].add(delta.scale(scale));
            if !candidate.finite() {
                continue;
            }
            if !candidate_vertex_update_is_safe(
                i,
                candidate,
                &prev,
                triangles,
                vertex_faces,
                area_floor,
            ) {
                continue;
            }

            positions[i] = candidate;
            stats.applied_vertices += 1;
            break;
        }
    }

    stats
}

fn candidate_vertex_update_is_safe(
    vertex_index: usize,
    candidate: Vec3,
    prev_positions: &[Vec3],
    triangles: &[[u32; 3]],
    vertex_faces: &[Vec<usize>],
    area_floor: f32,
) -> bool {
    for &face_idx in &vertex_faces[vertex_index] {
        let tri = triangles[face_idx];
        let prev_tri = [
            prev_positions[tri[0] as usize],
            prev_positions[tri[1] as usize],
            prev_positions[tri[2] as usize],
        ];
        let mut next_tri = prev_tri;
        for (corner, &vertex) in tri.iter().enumerate() {
            if vertex as usize == vertex_index {
                next_tri[corner] = candidate;
            }
        }

        let prev_cross = prev_tri[1]
            .sub(prev_tri[0])
            .cross(prev_tri[2].sub(prev_tri[0]));
        let next_cross = next_tri[1]
            .sub(next_tri[0])
            .cross(next_tri[2].sub(next_tri[0]));
        let prev_area2 = prev_cross.length();
        let next_area2 = next_cross.length();

        if !next_area2.is_finite() || next_area2 <= area_floor * 2.0 {
            return false;
        }
        if prev_area2 > area_floor * 4.0 && next_area2 < prev_area2 * 0.12 {
            return false;
        }
        if prev_area2 > area_floor * 4.0 && next_cross.dot(prev_cross) <= 0.0 {
            return false;
        }
    }

    true
}

    #[test]
    fn cavity_smoothing_rejects_vertex_moves_that_flip_adjacent_triangles() {
        let positions = vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(-1.0, 0.0, 0.0),
            Vec3::new(0.0, -1.0, 0.0),
        ];
        let triangles = vec![[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1]];
        let vertex_faces = vec![
            vec![0, 1, 2, 3],
            vec![0, 3],
            vec![0, 1],
            vec![1, 2],
            vec![2, 3],
        ];

        assert!(candidate_vertex_update_is_safe(
            0,
            Vec3::new(0.1, 0.1, 0.0),
            &positions,
            &triangles,
            &vertex_faces,
            1e-8,
        ));
        assert!(!candidate_vertex_update_is_safe(
            0,
            Vec3::new(1.6, 1.6, 0.0),
            &positions,
            &triangles,
            &vertex_faces,
            1e-8,
        ));
    }


