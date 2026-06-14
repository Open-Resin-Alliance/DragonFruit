//! Standalone mesh local-minima scanner (Islands PoC).
//!
//! Extracted from the experimental Support Painter
//! (`aaron/ag-exp-support-painter-alt` `support_painter.rs`) WITHOUT the rest of
//! that engine: no model cache, no half-edge topology, no curvatures, no
//! Dijkstra/brush proposals, no ROIs. It returns plain world-space coordinates
//! (like the voxel island system), to be classified and rendered as green minima
//! pucks. Stateless: one IPC call welds the soup, computes face normals, walks
//! the vertex adjacency graph, and returns the surviving minima.

use std::collections::HashSet;
use serde::{Deserialize, Serialize};
use dragonfruit_mesh_repair::{core::mesh::Vec3, IndexedMesh};
use dragonfruit_islands::{
    model::{Connectivity, IslandScanJob, GridRef},
    stream::run_island_scan_streaming,
};

/// A detected local vertical minimum: a vertex whose Z is strictly below all its
/// graph neighbours, surviving the down-facing / even-odd interior filter.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalMinimum {
    pub vertex_index: u32,
    pub position: Vec3,
    pub seed_triangle_id: u32,
}

/// Tauri IPC command: weld a world-space triangle soup (9 floats per triangle)
/// and return all local vertical minima. Stateless — no model cache (the cache
/// in the original only served the dropped brush-proposal feature).
#[tauri::command]
pub async fn scan_mesh_minima(positions: Vec<f32>) -> Result<Vec<LocalMinimum>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Weld coincident vertices → indexed (watertight) mesh.
        let mesh = IndexedMesh::from_triangle_soup(&positions, 1e-5);
        let tri_count = mesh.triangle_count();
        let vert_count = mesh.vertex_count();

        // 2. Per-face normals (for the down-facing heuristic).
        let mut normals = Vec::with_capacity(tri_count);
        for fi in 0..tri_count {
            normals.push(mesh.tri_normal(fi as u32));
        }

        // 3. Vertex→vertex adjacency, vertex→seed-face, vertex→incident-faces.
        let mut adj_vertices = vec![HashSet::new(); vert_count];
        let mut vert_to_face = vec![u32::MAX; vert_count];
        let mut vert_to_faces = vec![Vec::new(); vert_count];
        for fi in 0..tri_count {
            let tri = mesh.triangles[fi];
            let face_id = fi as u32;
            for &(u, v, w) in &[(tri[0], tri[1], tri[2]), (tri[1], tri[2], tri[0]), (tri[2], tri[0], tri[1])] {
                adj_vertices[u as usize].insert(v);
                adj_vertices[u as usize].insert(w);
                vert_to_face[u as usize] = face_id;
                vert_to_faces[u as usize].push(face_id);
            }
        }

        // 4. Scan for local vertical minima + hybrid down-facing / even-odd filter.
        let mut local_minima = Vec::new();
        for vi in 0..vert_count {
            let z_i = mesh.positions[vi].z;
            let neighbors = &adj_vertices[vi];
            if neighbors.is_empty() {
                continue;
            }
            let mut is_minimum = true;
            for &neighbor in neighbors {
                if mesh.positions[neighbor as usize].z <= z_i {
                    is_minimum = false;
                    break;
                }
            }
            if !is_minimum {
                continue;
            }

            // Vertex normal Z as a fast down-facing heuristic.
            let mut v_normal = Vec3::ZERO;
            for &fi in &vert_to_faces[vi] {
                v_normal = v_normal.add(normals[fi as usize]);
            }
            let len = v_normal.length();
            let nz = if len > 0.0 { v_normal.z / len } else { 0.0 };

            // Clear downward overhang (nz < -0.05) → keep. Flat / up-facing → run
            // the robust even-odd raycast to reject interior concavity tips.
            let mut keep = true;
            if nz >= -0.05 {
                let test_pt = Vec3::new(
                    mesh.positions[vi].x,
                    mesh.positions[vi].y,
                    mesh.positions[vi].z - 1e-4,
                );
                if is_point_inside_mesh(&test_pt, &mesh) {
                    keep = false;
                }
            }

            if keep {
                local_minima.push(LocalMinimum {
                    vertex_index: vi as u32,
                    position: mesh.positions[vi],
                    seed_triangle_id: vert_to_face[vi],
                });
            }
        }

        log::info!(
            "[mesh-minima] scan complete: {} minima from {} vertices / {} triangles",
            local_minima.len(),
            vert_count,
            tri_count,
        );
        Ok(local_minima)
    })
    .await
    .map_err(|e| format!("Minima scan task panicked: {e}"))?
}

fn load_and_transform_mesh(
    file_path: &str,
    matrix: [f32; 16],
    center: [f32; 3],
) -> Result<IndexedMesh, String> {
    let path = std::path::Path::new(file_path);
    let mut mesh = dragonfruit_mesh_repair::io::load_mesh_from_path(path)
        .map_err(|e| format!("Failed to load mesh from path {}: {:?}", file_path, e))?;

    // Transform vertices: p_world = matrix * (p_local - center)
    for pos in &mut mesh.positions {
        let centered = Vec3::new(
            pos.x - center[0],
            pos.y - center[1],
            pos.z - center[2],
        );

        let x = matrix[0] * centered.x + matrix[4] * centered.y + matrix[8] * centered.z + matrix[12];
        let y = matrix[1] * centered.x + matrix[5] * centered.y + matrix[9] * centered.z + matrix[13];
        let z = matrix[2] * centered.x + matrix[6] * centered.y + matrix[10] * centered.z + matrix[14];
        let w = matrix[3] * centered.x + matrix[7] * centered.y + matrix[11] * centered.z + matrix[15];

        if w.abs() > 1e-6 {
            pos.x = x / w;
            pos.y = y / w;
            pos.z = z / w;
        } else {
            pos.x = x;
            pos.y = y;
            pos.z = z;
        }
    }

    Ok(mesh)
}

#[tauri::command]
pub async fn scan_mesh_minima_from_path(
    file_path: String,
    matrix: [f32; 16],
    center: [f32; 3],
) -> Result<Vec<LocalMinimum>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Load and transform mesh
        let mesh = load_and_transform_mesh(&file_path, matrix, center)?;
        let tri_count = mesh.triangle_count();
        let vert_count = mesh.vertex_count();

        // 2. Per-face normals (for the down-facing heuristic).
        let mut normals = Vec::with_capacity(tri_count);
        for fi in 0..tri_count {
            normals.push(mesh.tri_normal(fi as u32));
        }

        // 3. Vertex→vertex adjacency, vertex→seed-face, vertex→incident-faces.
        let mut adj_vertices = vec![HashSet::new(); vert_count];
        let mut vert_to_face = vec![u32::MAX; vert_count];
        let mut vert_to_faces = vec![Vec::new(); vert_count];
        for fi in 0..tri_count {
            let tri = mesh.triangles[fi];
            let face_id = fi as u32;
            for &(u, v, w) in &[(tri[0], tri[1], tri[2]), (tri[1], tri[2], tri[0]), (tri[2], tri[0], tri[1])] {
                adj_vertices[u as usize].insert(v);
                adj_vertices[u as usize].insert(w);
                vert_to_face[u as usize] = face_id;
                vert_to_faces[u as usize].push(face_id);
            }
        }

        // 4. Scan for local vertical minima + hybrid down-facing / even-odd filter.
        let mut local_minima = Vec::new();
        for vi in 0..vert_count {
            let z_i = mesh.positions[vi].z;
            let neighbors = &adj_vertices[vi];
            if neighbors.is_empty() {
                continue;
            }
            let mut is_minimum = true;
            for &neighbor in neighbors {
                if mesh.positions[neighbor as usize].z <= z_i {
                    is_minimum = false;
                    break;
                }
            }
            if !is_minimum {
                continue;
            }

            // Vertex normal Z as a fast down-facing heuristic.
            let mut v_normal = Vec3::ZERO;
            for &fi in &vert_to_faces[vi] {
                v_normal = v_normal.add(normals[fi as usize]);
            }
            let len = v_normal.length();
            let nz = if len > 0.0 { v_normal.z / len } else { 0.0 };

            // Clear downward overhang (nz < -0.05) → keep. Flat / up-facing → run
            // the robust even-odd raycast to reject interior concavity tips.
            let mut keep = true;
            if nz >= -0.05 {
                let test_pt = Vec3::new(
                    mesh.positions[vi].x,
                    mesh.positions[vi].y,
                    mesh.positions[vi].z - 1e-4,
                );
                if is_point_inside_mesh(&test_pt, &mesh) {
                    keep = false;
                }
            }

            if keep {
                local_minima.push(LocalMinimum {
                    vertex_index: vi as u32,
                    position: mesh.positions[vi],
                    seed_triangle_id: vert_to_face[vi],
                });
            }
        }

        log::info!(
            "[mesh-minima-path] scan complete: {} minima from {} vertices / {} triangles",
            local_minima.len(),
            vert_count,
            tri_count,
        );
        Ok(local_minima)
    })
    .await
    .map_err(|e| format!("Minima path scan task panicked: {e}"))?
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoxelIsland {
    pub id: String,
    pub source: String,
    pub contact: Vec3,
    pub base_z: f64,
    pub area_mm2: f32,
    pub layer_span: [u32; 2],
}

#[tauri::command]
pub async fn scan_voxel_islands_from_path(
    file_path: String,
    matrix: [f32; 16],
    center: [f32; 3],
    layer_height_mm: f64,
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: u8,
) -> Result<Vec<VoxelIsland>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Load and transform mesh
        let mesh = load_and_transform_mesh(&file_path, matrix, center)?;

        // 2. Convert to flat triangle soup and parse into slicing engine triangles
        let soup = mesh.to_triangle_soup();
        let triangles = dragonfruit_slicing_engine::geometry::parse_triangles(&soup);

        // 3. Get transformed bounding box
        let bbox = mesh.bbox();

        // 4. Calculate grid bounds and dimensions (matching rasterize_for_island_scan)
        let ox = bbox.min.x as f64;
        let oz = -bbox.max.y as f64;
        let gw = ((bbox.max.x as f64 - bbox.min.x as f64) / px_mm).ceil().max(1.0) as i32;
        let gh = ((bbox.max.y as f64 - bbox.min.y as f64) / px_mm).ceil().max(1.0) as i32;
        let model_height = bbox.max.z as f64 - bbox.min.z as f64;
        let num_layers = (model_height / layer_height_mm).ceil().max(0.0) as usize;

        // 5. Run island scan pipeline using streaming
        let connectivity_enum = if connectivity == 8 {
            Connectivity::Eight
        } else {
            Connectivity::Four
        };

        let job = IslandScanJob {
            px_mm,
            support_buffer_mm,
            connectivity: connectivity_enum,
            min_island_area_mm2: 0.0001, // extremely small area threshold to catch all islands
            layer_height_mm,
            grid: GridRef {
                origin_x: ox,
                origin_z: oz,
                width: gw,
                height: gh,
                px_mm,
            },
            num_layers: num_layers as u32,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: true,
        };

        let scan_result = run_island_scan_streaming(&job, &triangles, bbox.min.z as f64, false, None);

        // 6. Convert tracking result back to VoxelIslands
        let mut voxel_islands = Vec::new();
        for (idx, island) in scan_result.islands.iter().enumerate() {
            // Retrieve first layer's centroid (seed_voxel)
            if let Some(seed) = island.seed_voxel {
                // Map pixel coordinates to world coordinates
                let contact_x = ox + seed.x * px_mm + px_mm * 0.5;
                let contact_y = -(oz + seed.y * px_mm);
                let contact_z = bbox.min.z as f64 + island.first_layer as f64 * layer_height_mm;

                voxel_islands.push(VoxelIsland {
                    id: format!("v{}", idx),
                    source: "voxel".to_string(),
                    contact: Vec3::new(contact_x as f32, contact_y as f32, contact_z as f32),
                    base_z: contact_z,
                    area_mm2: island.total_area_mm2 as f32,
                    layer_span: [island.first_layer, island.last_layer],
                });
            } else {
                // Fallback to global centroid if seed_voxel is somehow missing
                if let Some(c) = island.centroid {
                    let contact_x = ox + c.x * px_mm + px_mm * 0.5;
                    let contact_y = -(oz + c.y * px_mm);
                    let contact_z = bbox.min.z as f64 + island.first_layer as f64 * layer_height_mm;
                    voxel_islands.push(VoxelIsland {
                        id: format!("v{}", idx),
                        source: "voxel".to_string(),
                        contact: Vec3::new(contact_x as f32, contact_y as f32, contact_z as f32),
                        base_z: contact_z,
                        area_mm2: island.total_area_mm2 as f32,
                        layer_span: [island.first_layer, island.last_layer],
                    });
                }
            }
        }

        log::info!(
            "[voxel-islands-path] scan complete: {} islands from {} layers",
            voxel_islands.len(),
            num_layers
        );
        Ok(voxel_islands)
    })
    .await
    .map_err(|e| format!("Voxel path scan task panicked: {e}"))?
}

/// Möller–Trumbore ray-triangle intersection. Returns `Some(t)` for a hit at t>ε.
fn ray_triangle_intersect(orig: &Vec3, dir: &Vec3, v0: &Vec3, v1: &Vec3, v2: &Vec3) -> Option<f32> {
    let edge1 = Vec3::new(v1.x - v0.x, v1.y - v0.y, v1.z - v0.z);
    let edge2 = Vec3::new(v2.x - v0.x, v2.y - v0.y, v2.z - v0.z);

    let pvec = Vec3::new(
        dir.y * edge2.z - dir.z * edge2.y,
        dir.z * edge2.x - dir.x * edge2.z,
        dir.x * edge2.y - dir.y * edge2.x,
    );
    let det = edge1.dot(pvec);
    if det.abs() < 1e-8 {
        return None;
    }
    let inv_det = 1.0 / det;

    let tvec = Vec3::new(orig.x - v0.x, orig.y - v0.y, orig.z - v0.z);
    let u = tvec.dot(pvec) * inv_det;
    if u < 0.0 || u > 1.0 {
        return None;
    }

    let qvec = Vec3::new(
        tvec.y * edge1.z - tvec.z * edge1.y,
        tvec.z * edge1.x - tvec.x * edge1.z,
        tvec.x * edge1.y - tvec.y * edge1.x,
    );
    let v = dir.dot(qvec) * inv_det;
    if v < 0.0 || u + v > 1.0 {
        return None;
    }

    let t = edge2.dot(qvec) * inv_det;
    if t > 1e-5 {
        Some(t)
    } else {
        None
    }
}

/// Even-odd solidness test: cast a ray in -Z from a slightly perturbed origin and
/// count triangle hits. Odd count ⇒ the point lies inside the watertight volume.
fn is_point_inside_mesh(orig: &Vec3, mesh: &IndexedMesh) -> bool {
    let mut hits = 0;
    let dir = Vec3::new(0.0, 0.0, -1.0);
    // Perturb in X/Y to avoid exact vertex/edge alignment artefacts.
    let perturbed_orig = Vec3::new(orig.x + 1.123e-5, orig.y + 2.456e-5, orig.z);

    let tri_count = mesh.triangle_count();
    for fi in 0..tri_count {
        let [v0, v1, v2] = mesh.tri_positions(fi as u32);
        if ray_triangle_intersect(&perturbed_orig, &dir, &v0, &v1, &v2).is_some() {
            hits += 1;
        }
    }
    hits % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_minima_scanner() {
        // Downward-pointing pyramid: apex v0 at Z=-1 is the valley minimum.
        let soup = vec![
            0.0, 0.0, -1.0, 1.0, -1.0, 0.0, -1.0, -1.0, 0.0,
            0.0, 0.0, -1.0, 1.0, 1.0, 0.0, 1.0, -1.0, 0.0,
            0.0, 0.0, -1.0, -1.0, 1.0, 0.0, 1.0, 1.0, 0.0,
            0.0, 0.0, -1.0, -1.0, -1.0, 0.0, -1.0, 1.0, 0.0,
        ];

        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
        assert_eq!(mesh.vertex_count(), 5);

        let mut adj_vertices = vec![HashSet::new(); mesh.vertex_count()];
        for tri in &mesh.triangles {
            for &(u, v, w) in &[(tri[0], tri[1], tri[2]), (tri[1], tri[2], tri[0]), (tri[2], tri[0], tri[1])] {
                adj_vertices[u as usize].insert(v);
                adj_vertices[u as usize].insert(w);
            }
        }

        let z_0 = mesh.positions[0].z;
        assert_eq!(z_0, -1.0);

        let mut is_minimum = true;
        for &neighbor in &adj_vertices[0] {
            if mesh.positions[neighbor as usize].z <= z_0 {
                is_minimum = false;
            }
        }
        assert!(is_minimum);
    }

    #[test]
    fn test_local_minima_top_surface_filtration() {
        // Watertight cup: outer bottom tip v4 (Z=-0.5) is a true downward
        // overhang minimum; inner floor tip v17 (Z=0.5) is a top-surface
        // concavity that must be filtered by the even-odd test.
        let v0 = [-2.0, -2.0, 0.0];
        let v1 = [2.0, -2.0, 0.0];
        let v2 = [2.0, 2.0, 0.0];
        let v3 = [-2.0, 2.0, 0.0];
        let v4 = [0.0, 0.0, -0.5];

        let v5 = [-2.0, -2.0, 2.0];
        let v6 = [2.0, -2.0, 2.0];
        let v7 = [2.0, 2.0, 2.0];
        let v8 = [-2.0, 2.0, 2.0];

        let v9 = [-1.5, -1.5, 2.0];
        let v10 = [1.5, -1.5, 2.0];
        let v11 = [1.5, 1.5, 2.0];
        let v12 = [-1.5, 1.5, 2.0];

        let v13 = [-1.5, -1.5, 1.0];
        let v14 = [1.5, -1.5, 1.0];
        let v15 = [1.5, 1.5, 1.0];
        let v16 = [-1.5, 1.5, 1.0];
        let v17 = [0.0, 0.0, 0.5];

        let vertices = vec![
            v0, v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12, v13, v14, v15, v16, v17,
        ];

        let mut soup = Vec::new();
        let mut push_tri = |a: usize, b: usize, c: usize| {
            soup.extend_from_slice(&[
                vertices[a][0], vertices[a][1], vertices[a][2],
                vertices[b][0], vertices[b][1], vertices[b][2],
                vertices[c][0], vertices[c][1], vertices[c][2],
            ]);
        };

        // Outer bottom (CCW from below).
        push_tri(4, 1, 0);
        push_tri(4, 2, 1);
        push_tri(4, 3, 2);
        push_tri(4, 0, 3);

        // Outer walls.
        push_tri(0, 1, 6); push_tri(0, 6, 5);
        push_tri(1, 2, 7); push_tri(1, 7, 6);
        push_tri(2, 3, 8); push_tri(2, 8, 7);
        push_tri(3, 0, 5); push_tri(3, 5, 8);

        // Top rim.
        push_tri(5, 6, 10); push_tri(5, 10, 9);
        push_tri(6, 7, 11); push_tri(6, 11, 10);
        push_tri(7, 8, 12); push_tri(7, 12, 11);
        push_tri(8, 5, 9); push_tri(8, 9, 12);

        // Inner walls.
        push_tri(9, 13, 14); push_tri(9, 14, 10);
        push_tri(10, 14, 15); push_tri(10, 15, 11);
        push_tri(11, 15, 16); push_tri(11, 16, 12);
        push_tri(12, 16, 13); push_tri(12, 13, 9);

        // Inner bottom.
        push_tri(17, 13, 14);
        push_tri(17, 14, 15);
        push_tri(17, 15, 16);
        push_tri(17, 16, 13);

        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);

        let mut normals = Vec::new();
        for fi in 0..mesh.triangle_count() {
            normals.push(mesh.tri_normal(fi as u32));
        }

        let mut adj_vertices = vec![HashSet::new(); mesh.vertex_count()];
        let mut vert_to_faces = vec![Vec::new(); mesh.vertex_count()];
        for fi in 0..mesh.triangle_count() {
            let tri = mesh.triangles[fi];
            let face_id = fi as u32;
            for &(u, v, w) in &[(tri[0], tri[1], tri[2]), (tri[1], tri[2], tri[0]), (tri[2], tri[0], tri[1])] {
                adj_vertices[u as usize].insert(v);
                adj_vertices[u as usize].insert(w);
                vert_to_faces[u as usize].push(face_id);
            }
        }

        let mut kept_minima = Vec::new();
        for vi in 0..mesh.vertex_count() {
            let z_i = mesh.positions[vi].z;
            let neighbors = &adj_vertices[vi];
            if neighbors.is_empty() {
                continue;
            }
            let mut is_minimum = true;
            for &neighbor in neighbors {
                if mesh.positions[neighbor as usize].z <= z_i {
                    is_minimum = false;
                    break;
                }
            }

            if is_minimum {
                let mut v_normal = Vec3::ZERO;
                for &fi in &vert_to_faces[vi] {
                    v_normal = v_normal.add(normals[fi as usize]);
                }
                let len = v_normal.length();
                let nz = if len > 0.0 { v_normal.z / len } else { 0.0 };

                let mut keep = true;
                if nz >= -0.05 {
                    let test_pt = Vec3::new(
                        mesh.positions[vi].x,
                        mesh.positions[vi].y,
                        mesh.positions[vi].z - 1e-4,
                    );
                    if is_point_inside_mesh(&test_pt, &mesh) {
                        keep = false;
                    }
                }
                if keep {
                    kept_minima.push(vi);
                }
            }
        }

        // Locate welded indices of v4 and v17 by their unique coordinates.
        let mut index_v4 = None;
        let mut index_v17 = None;
        for i in 0..mesh.vertex_count() {
            let pos = mesh.positions[i];
            if pos.x.abs() < 1e-4 && pos.y.abs() < 1e-4 && (pos.z - (-0.5)).abs() < 1e-4 {
                index_v4 = Some(i);
            }
            if pos.x.abs() < 1e-4 && pos.y.abs() < 1e-4 && (pos.z - 0.5).abs() < 1e-4 {
                index_v17 = Some(i);
            }
        }
        let index_v4 = index_v4.expect("Failed to locate welded v4 vertex");
        let index_v17 = index_v17.expect("Failed to locate welded v17 vertex");

        // Only the bottom outer tip is kept; the inner concavity tip is filtered.
        assert!(kept_minima.contains(&index_v4));
        assert!(!kept_minima.contains(&index_v17));
    }
}
