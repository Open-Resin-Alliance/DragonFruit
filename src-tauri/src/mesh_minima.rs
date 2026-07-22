//! Standalone mesh local-minima scanner (Islands PoC).
//!
//! Extracted from the experimental Support Painter
//! (`aaron/ag-exp-support-painter-alt` `support_painter.rs`) WITHOUT the rest of
//! that engine: no model cache, no half-edge topology, no curvatures, no
//! Dijkstra/brush proposals, no ROIs. It returns plain world-space coordinates
//! (like the voxel island system), to be classified and rendered as green minima
//! pucks. Stateless: one IPC call welds the soup, computes face normals, walks
//! the vertex adjacency graph, and returns the surviving minima.

use dragonfruit_islands::{
    model::{Connectivity, GridRef, IslandScanJob},
    pipeline::run_island_scan,
    rasterize::rasterize_for_island_scan,
    stream::run_island_scan_streaming,
};
use dragonfruit_mesh_repair::{core::mesh::Vec3, IndexedMesh};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashSet;

/// A detected local vertical minimum: a vertex whose Z is strictly below all its
/// graph neighbours, surviving the down-facing / even-odd interior filter.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalMinimum {
    pub vertex_index: u32,
    pub position: Vec3,
    pub seed_triangle_id: u32,
}

pub struct AdjacencyList {
    pub offsets: Vec<usize>,
    pub targets: Vec<u32>,
}

impl AdjacencyList {
    /// Builds CSR adjacency list from watertight indexed mesh.
    /// Incurs exactly 4 heap allocations total.
    pub fn build(mesh: &IndexedMesh) -> Self {
        let tri_count = mesh.triangle_count();
        let vert_count = mesh.vertex_count();

        // 1. Collect all half-edges (6 per triangle)
        let mut edges = Vec::with_capacity(tri_count * 6);
        for fi in 0..tri_count {
            let tri = mesh.triangles[fi];
            let u = tri[0];
            let v = tri[1];
            let w = tri[2];
            edges.push((u, v));
            edges.push((u, w));
            edges.push((v, u));
            edges.push((v, w));
            edges.push((w, u));
            edges.push((w, v));
        }

        // 2. Sort and deduplicate to get unique undirected graph edges
        edges.sort_unstable();
        edges.dedup();

        // 3. Populate CSR offset and target vectors
        let mut offsets = vec![0; vert_count + 1];
        let mut targets = Vec::with_capacity(edges.len());

        let mut current_v = 0;
        for &(u, v) in &edges {
            while current_v < u as usize {
                current_v += 1;
                offsets[current_v] = targets.len();
            }
            targets.push(v);
        }
        while current_v < vert_count {
            current_v += 1;
            offsets[current_v] = targets.len();
        }

        Self { offsets, targets }
    }

    /// Retrieve neighbor slice for a given vertex. Zero allocations.
    #[inline]
    pub fn neighbors(&self, u: usize) -> &[u32] {
        let start = self.offsets[u];
        let end = self.offsets[u + 1];
        &self.targets[start..end]
    }
}

pub struct ThreadLocalScanContext {
    visited_generation: Vec<u32>, // matches size: vert_count
    current_generation: u32,
    queue: Vec<u32>,
    next_ring: Vec<u32>,
    result_neighbors: Vec<u32>,
}

impl ThreadLocalScanContext {
    pub fn new(vert_count: usize) -> Self {
        Self {
            visited_generation: vec![0; vert_count],
            current_generation: 0,
            queue: Vec::with_capacity(32),
            next_ring: Vec::with_capacity(32),
            result_neighbors: Vec::with_capacity(64),
        }
    }

    /// Reset generation counters if overflow is reached
    fn reset_if_needed(&mut self) {
        if self.current_generation == u32::MAX {
            self.visited_generation.fill(0);
            self.current_generation = 0;
        }
    }

    pub fn ensure_capacity(&mut self, vert_count: usize) {
        if self.visited_generation.len() < vert_count {
            self.visited_generation.resize(vert_count, 0);
        }
    }

    /// Traverse and extract k-ring neighbors without heap allocation
    pub fn get_k_ring_neighbors(&mut self, vi: usize, k: usize, adj: &AdjacencyList) -> &[u32] {
        self.reset_if_needed();
        self.current_generation += 1;
        let gen = self.current_generation;

        self.queue.clear();
        self.next_ring.clear();
        self.result_neighbors.clear();

        self.queue.push(vi as u32);
        self.visited_generation[vi] = gen;

        for _ in 0..k {
            self.next_ring.clear();
            for &u in &self.queue {
                let neighbors = adj.neighbors(u as usize);
                for &neighbor in neighbors {
                    let n_idx = neighbor as usize;
                    if self.visited_generation[n_idx] != gen {
                        self.visited_generation[n_idx] = gen;
                        self.next_ring.push(neighbor);
                        self.result_neighbors.push(neighbor);
                    }
                }
            }
            if self.next_ring.is_empty() {
                break;
            }
            std::mem::swap(&mut self.queue, &mut self.next_ring);
        }

        &self.result_neighbors
    }
}

thread_local! {
    static SCAN_CONTEXT: RefCell<Option<ThreadLocalScanContext>> = RefCell::new(None);
}

fn scan_minima_internal(mesh: &IndexedMesh, k: Option<usize>) -> Vec<LocalMinimum> {
    let tri_count = mesh.triangle_count();
    let vert_count = mesh.vertex_count();

    let mut normals = Vec::with_capacity(tri_count);
    for fi in 0..tri_count {
        normals.push(mesh.tri_normal(fi as u32));
    }

    let adj = AdjacencyList::build(mesh);
    let mut vert_to_face = vec![u32::MAX; vert_count];
    let mut vert_to_faces = vec![Vec::new(); vert_count];
    for fi in 0..tri_count {
        let tri = mesh.triangles[fi];
        let face_id = fi as u32;
        for &u in &tri {
            vert_to_face[u as usize] = face_id;
            vert_to_faces[u as usize].push(face_id);
        }
    }

    let bvh = dragonfruit_mesh_repair::core::bvh::Bvh::build(mesh);
    let k_val = k.unwrap_or(2);

    (0..vert_count)
        .into_par_iter()
        .filter_map(|vi| {
            SCAN_CONTEXT.with(|cell| {
                let mut borrow = cell.borrow_mut();
                let ctx = borrow.get_or_insert_with(|| ThreadLocalScanContext::new(vert_count));
                ctx.ensure_capacity(vert_count);

                let z_i = mesh.positions[vi].z;
                let neighbors = ctx.get_k_ring_neighbors(vi, k_val, &adj);
                if neighbors.is_empty() {
                    return None;
                }

                for &neighbor in neighbors {
                    if mesh.positions[neighbor as usize].z <= z_i {
                        return None;
                    }
                }

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
                    let perturbed_orig =
                        Vec3::new(test_pt.x + 1.123e-5, test_pt.y + 2.456e-5, test_pt.z);
                    let hits = bvh.ray_hit_count(mesh, perturbed_orig, Vec3::new(0.0, 0.0, -1.0));
                    if hits % 2 == 1 {
                        keep = false;
                    }
                }

                if keep {
                    Some(LocalMinimum {
                        vertex_index: vi as u32,
                        position: mesh.positions[vi],
                        seed_triangle_id: vert_to_face[vi],
                    })
                } else {
                    None
                }
            })
        })
        .collect()
}

/// Tauri IPC command: weld a world-space triangle soup (9 floats per triangle)
/// and return all local vertical minima. Stateless — no model cache (the cache
/// in the original only served the dropped brush-proposal feature).
#[tauri::command]
pub async fn scan_mesh_minima(
    positions: Vec<f32>,
    k: Option<usize>,
) -> Result<Vec<LocalMinimum>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mesh = IndexedMesh::from_triangle_soup(&positions, 1e-5);
        let tri_count = mesh.triangle_count();
        let vert_count = mesh.vertex_count();

        let local_minima = scan_minima_internal(&mesh, k);

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

/// Loads the mesh at `file_path` and reprojects RAW FILE coordinates into
/// world space: `w = M · (v_raw − c_pre)`.
///
/// `c_pre` MUST be the import-time pre-centering bbox center stored on the
/// model (`GeometryWithBounds.cPre` / `nativePreview.cPre`, captured by
/// `processGeometry`; P0 memo §2.2). It is NOT the post-centering scene bbox
/// center (`model.geometry.center`) — that value is only meaningful against
/// SCENE geometry, and substituting it displaces the result by
/// `M_linear · T_center` for any source file not already origin-centered.
/// That substitution was the islands sideload frame bug (fixed 2026-07-20);
/// `islands_frame_red_harness` below pins both the formula and the
/// displacement magnitude. The parameter was previously named `center`,
/// which is exactly how the wrong datum got passed — keep the name `c_pre`.
///
/// `expected_fingerprint`: import-time `(size_bytes, mtime_ms)` of the source
/// file. `Some` refuses a changed-on-disk source with `FULLRES_SOURCE_STALE`;
/// a missing/unreadable file is always `FULLRES_SOURCE_MISSING` (the shared
/// P1 convention — `verify_source_fingerprint` in mesh_repair.rs).
fn load_and_transform_mesh(
    file_path: &str,
    matrix: [f32; 16],
    c_pre: [f32; 3],
    expected_fingerprint: Option<(u64, f64)>,
) -> Result<IndexedMesh, String> {
    let path = std::path::Path::new(file_path);
    crate::mesh_repair::verify_source_fingerprint(path, expected_fingerprint)?;
    let mut mesh = dragonfruit_mesh_repair::io::load_mesh_from_path(path)
        .map_err(|e| format!("Failed to load mesh from path {}: {:?}", file_path, e))?;

    // Transform vertices: p_world = matrix * (p_raw - c_pre)
    for pos in &mut mesh.positions {
        let centered = Vec3::new(pos.x - c_pre[0], pos.y - c_pre[1], pos.z - c_pre[2]);

        let x =
            matrix[0] * centered.x + matrix[4] * centered.y + matrix[8] * centered.z + matrix[12];
        let y =
            matrix[1] * centered.x + matrix[5] * centered.y + matrix[9] * centered.z + matrix[13];
        let z =
            matrix[2] * centered.x + matrix[6] * centered.y + matrix[10] * centered.z + matrix[14];
        let w =
            matrix[3] * centered.x + matrix[7] * centered.y + matrix[11] * centered.z + matrix[15];

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
    c_pre: [f32; 3],
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
    k: Option<usize>,
) -> Result<Vec<LocalMinimum>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mesh = load_and_transform_mesh(
            &file_path,
            matrix,
            c_pre,
            expected_size_bytes.zip(expected_mtime_ms),
        )?;
        let tri_count = mesh.triangle_count();
        let vert_count = mesh.vertex_count();

        let local_minima = scan_minima_internal(&mesh, k);

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
    c_pre: [f32; 3],
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
    layer_height_mm: f64,
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: u8,
) -> Result<Vec<VoxelIsland>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Load and transform mesh
        let mesh = load_and_transform_mesh(
            &file_path,
            matrix,
            c_pre,
            expected_size_bytes.zip(expected_mtime_ms),
        )?;

        // 2. Convert to flat triangle soup and parse into slicing engine triangles
        let soup = mesh.to_triangle_soup();
        let triangles = dragonfruit_slicing_engine::geometry::parse_triangles(&soup);

        // 3. Get transformed bounding box
        let bbox = mesh.bbox();

        // 4. Calculate grid bounds and dimensions (matching rasterize_for_island_scan)
        let ox = bbox.min.x as f64;
        let oz = -bbox.max.y as f64;
        let gw = ((bbox.max.x as f64 - bbox.min.x as f64) / px_mm)
            .ceil()
            .max(1.0) as i32;
        let gh = ((bbox.max.y as f64 - bbox.min.y as f64) / px_mm)
            .ceil()
            .max(1.0) as i32;
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

        let scan_result =
            run_island_scan_streaming(&job, &triangles, bbox.min.z as f64, false, None);

        // 5a. Build Z-bucket index for projection raycasting
        let z_min = bbox.min.z;
        let z_max = bbox.max.z;
        let z_range = (z_max - z_min) as f32;
        let num_buckets = 128;
        let mut z_buckets = vec![Vec::new(); num_buckets];
        let tri_count = mesh.triangle_count();
        for fi in 0..tri_count {
            let [v0, v1, v2] = mesh.tri_positions(fi as u32);
            let t_min_z = v0.z.min(v1.z).min(v2.z);
            let t_max_z = v0.z.max(v1.z).max(v2.z);
            if z_range > 1e-5 {
                let b_start = (((t_min_z - z_min) / z_range) * (num_buckets as f32 - 1.0))
                    .floor()
                    .max(0.0) as usize;
                let b_end = (((t_max_z - z_min) / z_range) * (num_buckets as f32 - 1.0))
                    .ceil()
                    .min(num_buckets as f32 - 1.0) as usize;
                for b in b_start..=b_end {
                    z_buckets[b].push(fi as u32);
                }
            } else {
                z_buckets[0].push(fi as u32);
            }
        }

        // Define a helper closure to snap a raw world contact coordinate to the mesh surface
        let snap_to_mesh = |raw_x: f32, raw_y: f32, raw_z: f32| -> Vec3 {
            let epsilon = (layer_height_mm * 1.5) as f32;
            let mut best_hit: Option<(Vec3, f32)> = None;
            let mut best_hit_normal: Option<Vec3> = None;

            let search_min_z = (raw_z - epsilon) as f64;
            let search_max_z = (raw_z + epsilon) as f64;

            let mut candidates = HashSet::new();
            if z_range > 1e-5 {
                let b_start = (((search_min_z - z_min as f64) / z_range as f64)
                    * (num_buckets as f64 - 1.0))
                    .floor()
                    .max(0.0) as usize;
                let b_end = (((search_max_z - z_min as f64) / z_range as f64)
                    * (num_buckets as f64 - 1.0))
                    .ceil()
                    .min(num_buckets as f64 - 1.0) as usize;
                for b in b_start..=b_end {
                    for &fi in &z_buckets[b] {
                        candidates.insert(fi);
                    }
                }
            } else {
                candidates.extend(z_buckets[0].iter().cloned());
            }

            let ray_down_orig = Vec3::new(raw_x, raw_y, raw_z + epsilon);
            let ray_down_dir = Vec3::new(0.0, 0.0, -1.0);

            let ray_up_orig = Vec3::new(raw_x, raw_y, raw_z - epsilon);
            let ray_up_dir = Vec3::new(0.0, 0.0, 1.0);

            for fi in candidates {
                let [v0, v1, v2] = mesh.tri_positions(fi);

                // Ray down test
                if let Some(t) =
                    ray_triangle_intersect(&ray_down_orig, &ray_down_dir, &v0, &v1, &v2)
                {
                    if t <= 2.0 * epsilon {
                        let hit_z = ray_down_orig.z - t;
                        let normal = mesh.tri_normal(fi);
                        let is_downward = normal.z < 0.0;
                        let dist_z = (hit_z - raw_z).abs();

                        let replace = match best_hit {
                            None => true,
                            Some((_, best_dist)) => {
                                let best_normal = best_hit_normal.unwrap_or(Vec3::ZERO);
                                let best_was_downward = best_normal.z < 0.0;
                                if is_downward && !best_was_downward {
                                    true
                                } else if !is_downward && best_was_downward {
                                    false
                                } else {
                                    dist_z < best_dist
                                }
                            }
                        };

                        if replace {
                            best_hit = Some((Vec3::new(raw_x, raw_y, hit_z), dist_z));
                            best_hit_normal = Some(normal);
                        }
                    }
                }

                // Ray up test
                if let Some(t) = ray_triangle_intersect(&ray_up_orig, &ray_up_dir, &v0, &v1, &v2) {
                    if t <= 2.0 * epsilon {
                        let hit_z = ray_up_orig.z + t;
                        let normal = mesh.tri_normal(fi);
                        let is_downward = normal.z < 0.0;
                        let dist_z = (hit_z - raw_z).abs();

                        let replace = match best_hit {
                            None => true,
                            Some((_, best_dist)) => {
                                let best_normal = best_hit_normal.unwrap_or(Vec3::ZERO);
                                let best_was_downward = best_normal.z < 0.0;
                                if is_downward && !best_was_downward {
                                    true
                                } else if !is_downward && best_was_downward {
                                    false
                                } else {
                                    dist_z < best_dist
                                }
                            }
                        };

                        if replace {
                            best_hit = Some((Vec3::new(raw_x, raw_y, hit_z), dist_z));
                            best_hit_normal = Some(normal);
                        }
                    }
                }
            }

            if let Some((hit_pt, _)) = best_hit {
                hit_pt
            } else {
                Vec3::new(raw_x, raw_y, raw_z)
            }
        };

        // 6. Convert tracking result back to VoxelIslands
        let mut voxel_islands = Vec::new();
        for (idx, island) in scan_result.islands.iter().enumerate() {
            // Retrieve first layer's centroid (seed_voxel)
            if let Some(seed) = island.seed_voxel {
                // Map pixel coordinates to world coordinates
                let contact_x = ox + seed.x * px_mm + px_mm * 0.5;
                let contact_y = -(oz + seed.y * px_mm);
                let contact_z = bbox.min.z as f64 + island.first_layer as f64 * layer_height_mm;
                let contact = snap_to_mesh(contact_x as f32, contact_y as f32, contact_z as f32);

                voxel_islands.push(VoxelIsland {
                    id: format!("v{}", idx),
                    source: "voxel".to_string(),
                    contact,
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
                    let contact =
                        snap_to_mesh(contact_x as f32, contact_y as f32, contact_z as f32);

                    voxel_islands.push(VoxelIsland {
                        id: format!("v{}", idx),
                        source: "voxel".to_string(),
                        contact,
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

/// Combined result from a single unified island scan (voxel + mesh minima).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CombinedIslandScanResult {
    pub voxel_islands: Vec<VoxelIsland>,
    pub minima_islands: Vec<LocalMinimum>,
}

/// Single Tauri command that loads the mesh once and runs both the voxel island
/// scan (batch pipeline with Z-bucketed rayon-parallel rasterization) and the mesh
/// minima scan **concurrently**. Surface-snapping projections are also parallelized.
#[tauri::command]
pub async fn scan_islands_from_path(
    file_path: String,
    matrix: [f32; 16],
    c_pre: [f32; 3],
    expected_size_bytes: Option<u64>,
    expected_mtime_ms: Option<f64>,
    layer_height_mm: f64,
    px_mm: f64,
    support_buffer_mm: f64,
    connectivity: u8,
    k: Option<usize>,
) -> Result<CombinedIslandScanResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // ── 1. Load and transform mesh ONCE ──────────────────────────────
        log::info!("[islands-combined] Loading mesh from {}", file_path);
        let mesh = load_and_transform_mesh(
            &file_path,
            matrix,
            c_pre,
            expected_size_bytes.zip(expected_mtime_ms),
        )?;
        let tri_count = mesh.triangle_count();
        let vert_count = mesh.vertex_count();
        log::info!(
            "[islands-combined] Mesh loaded: {} triangles, {} vertices",
            tri_count, vert_count,
        );

        let bbox = mesh.bbox();
        let soup = mesh.to_triangle_soup();
        let triangles = dragonfruit_slicing_engine::geometry::parse_triangles(&soup);

        let ox = bbox.min.x as f64;
        let oz = -bbox.max.y as f64;
        let gw = ((bbox.max.x as f64 - bbox.min.x as f64) / px_mm).ceil().max(1.0) as i32;
        let gh = ((bbox.max.y as f64 - bbox.min.y as f64) / px_mm).ceil().max(1.0) as i32;
        let model_height = bbox.max.z as f64 - bbox.min.z as f64;
        let num_layers = (model_height / layer_height_mm).ceil().max(0.0) as usize;

        let connectivity_enum = if connectivity == 8 { Connectivity::Eight } else { Connectivity::Four };

        let job = IslandScanJob {
            px_mm,
            support_buffer_mm,
            connectivity: connectivity_enum,
            min_island_area_mm2: 0.0001,
            layer_height_mm,
            grid: GridRef { origin_x: ox, origin_z: oz, width: gw, height: gh, px_mm },
            num_layers: num_layers as u32,
            min_overlap_px: 1,
            overlap_neighborhood_px: 1,
            candidate_only: true,
        };

        // ── 2. Run voxel rasterization + scan AND minima scan CONCURRENTLY ──
        let (scan_result, minima_islands) = std::thread::scope(|s| {
            // Thread A: voxel rasterization + island scan
            let voxel_handle = s.spawn(|| {
                log::info!(
                    "[islands-combined] Rasterizing {} layers (batch, {}×{} grid)…",
                    num_layers, gw, gh,
                );
                let rasterize_start = std::time::Instant::now();
                let (masks, _, _, _, _, _) = rasterize_for_island_scan(
                    &triangles,
                    bbox.min.x as f64, bbox.max.x as f64,
                    bbox.min.y as f64, bbox.max.y as f64,
                    bbox.min.z as f64, bbox.max.z as f64,
                    px_mm, layer_height_mm,
                );
                let rasterize_sec = rasterize_start.elapsed().as_secs_f64();
                log::info!("[islands-combined] Rasterized {} layers in {:.1}s", num_layers, rasterize_sec);

                log::info!("[islands-combined] Running island scan (batch pipeline)…");
                let scan_start = std::time::Instant::now();
                let result = run_island_scan(&job, &masks, None);
                let scan_sec = scan_start.elapsed().as_secs_f64();
                log::info!(
                    "[islands-combined] Island scan done in {:.1}s — {} islands (rasterize {:.1}s + scan {:.1}s = {:.1}s)",
                    scan_sec + rasterize_sec, result.islands.len(), rasterize_sec, scan_sec, rasterize_sec + scan_sec,
                );
                result
            });

            // Thread B: mesh minima scan (uses rayon internally)
            let minima_handle = s.spawn(|| {
                log::info!("[islands-combined] Running mesh minima scan (k={})…", k.unwrap_or(2));
                let minima_start = std::time::Instant::now();
                let minima = scan_minima_internal(&mesh, k);
                let minima_sec = minima_start.elapsed().as_secs_f64();
                log::info!("[islands-combined] Minima scan done in {:.1}s — {} minima", minima_sec, minima.len());
                minima
            });

            (voxel_handle.join().unwrap(), minima_handle.join().unwrap())
        });

        // ── 3. Build Z-bucket index for surface-snapping projections ──────
        let z_min = bbox.min.z;
        let z_max = bbox.max.z;
        let z_range = (z_max - z_min) as f32;
        let num_buckets = 128;
        let mut z_buckets = vec![Vec::new(); num_buckets];
        for fi in 0..tri_count {
            let [v0, v1, v2] = mesh.tri_positions(fi as u32);
            let t_min_z = v0.z.min(v1.z).min(v2.z);
            let t_max_z = v0.z.max(v1.z).max(v2.z);
            if z_range > 1e-5 {
                let b_start = (((t_min_z - z_min) / z_range) * (num_buckets as f32 - 1.0)).floor().max(0.0) as usize;
                let b_end = (((t_max_z - z_min) / z_range) * (num_buckets as f32 - 1.0)).ceil().min(num_buckets as f32 - 1.0) as usize;
                for b in b_start..=b_end {
                    z_buckets[b].push(fi as u32);
                }
            } else {
                z_buckets[0].push(fi as u32);
            }
        }

        // ── 4. Surface-snap contacts in parallel via rayon ────────────────
        let epsilon = (layer_height_mm * 1.5) as f32;
        let snap_start = std::time::Instant::now();
        let voxel_islands: Vec<VoxelIsland> = scan_result
            .islands
            .par_iter()
            .enumerate()
            .map(|(idx, island)| {
                let (contact_x, contact_y, contact_z) = if let Some(seed) = island.seed_voxel {
                    (
                        (ox + seed.x * px_mm + px_mm * 0.5) as f32,
                        (-(oz + seed.y * px_mm)) as f32,
                        (bbox.min.z as f64 + island.first_layer as f64 * layer_height_mm) as f32,
                    )
                } else if let Some(c) = island.centroid {
                    (
                        (ox + c.x * px_mm + px_mm * 0.5) as f32,
                        (-(oz + c.y * px_mm)) as f32,
                        (bbox.min.z as f64 + island.first_layer as f64 * layer_height_mm) as f32,
                    )
                } else {
                    (0.0_f32, 0.0_f32, 0.0_f32)
                };

                let contact = snap_to_surface(
                    contact_x, contact_y, contact_z,
                    epsilon, &z_buckets, z_min, z_range, num_buckets, &mesh,
                );

                VoxelIsland {
                    id: format!("v{}", idx),
                    source: "voxel".to_string(),
                    contact,
                    base_z: contact_z as f64,
                    area_mm2: island.total_area_mm2 as f32,
                    layer_span: [island.first_layer, island.last_layer],
                }
            })
            .collect();
        log::info!(
            "[islands-combined] Surface snapping done in {:.1}s for {} islands",
            snap_start.elapsed().as_secs_f64(),
            voxel_islands.len(),
        );

        log::info!(
            "[islands-combined] Complete: {} voxel islands, {} minima islands",
            voxel_islands.len(),
            minima_islands.len(),
        );

        Ok(CombinedIslandScanResult {
            voxel_islands,
            minima_islands,
        })
    })
    .await
    .map_err(|e| format!("Combined island scan panicked: {e}"))?
}

/// Surface-snap a raw contact coordinate to the nearest mesh surface triangle
/// via bidirectional raycasting within a Z-bucket index. Thread-safe: reads
/// mesh and z_buckets immutably.
fn snap_to_surface(
    raw_x: f32,
    raw_y: f32,
    raw_z: f32,
    epsilon: f32,
    z_buckets: &[Vec<u32>],
    z_min: f32,
    z_range: f32,
    num_buckets: usize,
    mesh: &IndexedMesh,
) -> Vec3 {
    let mut best_hit: Option<(Vec3, f32)> = None;
    let mut best_hit_normal: Option<Vec3> = None;

    let search_min_z = (raw_z - epsilon) as f64;
    let search_max_z = (raw_z + epsilon) as f64;

    let mut candidates = HashSet::new();
    if z_range > 1e-5 {
        let b_start = (((search_min_z - z_min as f64) / z_range as f64)
            * (num_buckets as f64 - 1.0))
            .floor()
            .max(0.0) as usize;
        let b_end = (((search_max_z - z_min as f64) / z_range as f64) * (num_buckets as f64 - 1.0))
            .ceil()
            .min(num_buckets as f64 - 1.0) as usize;
        for b in b_start..=b_end {
            for &fi in &z_buckets[b] {
                candidates.insert(fi);
            }
        }
    } else {
        candidates.extend(z_buckets[0].iter().cloned());
    }

    let ray_down_orig = Vec3::new(raw_x, raw_y, raw_z + epsilon);
    let ray_down_dir = Vec3::new(0.0, 0.0, -1.0);
    let ray_up_orig = Vec3::new(raw_x, raw_y, raw_z - epsilon);
    let ray_up_dir = Vec3::new(0.0, 0.0, 1.0);

    for fi in candidates {
        let [v0, v1, v2] = mesh.tri_positions(fi);
        if let Some(t) = ray_triangle_intersect(&ray_down_orig, &ray_down_dir, &v0, &v1, &v2) {
            if t <= 2.0 * epsilon {
                let hit_z = ray_down_orig.z - t;
                let normal = mesh.tri_normal(fi);
                let is_downward = normal.z < 0.0;
                let dist_z = (hit_z - raw_z).abs();
                let replace = match best_hit {
                    None => true,
                    Some((_, best_dist)) => {
                        let best_normal = best_hit_normal.unwrap_or(Vec3::ZERO);
                        let best_was_downward = best_normal.z < 0.0;
                        if is_downward && !best_was_downward {
                            true
                        } else if !is_downward && best_was_downward {
                            false
                        } else {
                            dist_z < best_dist
                        }
                    }
                };
                if replace {
                    best_hit = Some((Vec3::new(raw_x, raw_y, hit_z), dist_z));
                    best_hit_normal = Some(normal);
                }
            }
        }
        if let Some(t) = ray_triangle_intersect(&ray_up_orig, &ray_up_dir, &v0, &v1, &v2) {
            if t <= 2.0 * epsilon {
                let hit_z = ray_up_orig.z + t;
                let normal = mesh.tri_normal(fi);
                let is_downward = normal.z < 0.0;
                let dist_z = (hit_z - raw_z).abs();
                let replace = match best_hit {
                    None => true,
                    Some((_, best_dist)) => {
                        let best_normal = best_hit_normal.unwrap_or(Vec3::ZERO);
                        let best_was_downward = best_normal.z < 0.0;
                        if is_downward && !best_was_downward {
                            true
                        } else if !is_downward && best_was_downward {
                            false
                        } else {
                            dist_z < best_dist
                        }
                    }
                };
                if replace {
                    best_hit = Some((Vec3::new(raw_x, raw_y, hit_z), dist_z));
                    best_hit_normal = Some(normal);
                }
            }
        }
    }
    best_hit
        .map(|(pt, _)| pt)
        .unwrap_or(Vec3::new(raw_x, raw_y, raw_z))
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
/// count triangle hits using BVH. Odd count ⇒ the point lies inside the watertight volume.
#[allow(dead_code)]
fn is_point_inside_mesh(orig: &Vec3, mesh: &IndexedMesh) -> bool {
    let bvh = dragonfruit_mesh_repair::core::bvh::Bvh::build(mesh);
    let perturbed_orig = Vec3::new(orig.x + 1.123e-5, orig.y + 2.456e-5, orig.z);
    let hits = bvh.ray_hit_count(mesh, perturbed_orig, Vec3::new(0.0, 0.0, -1.0));
    hits % 2 == 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_minima_scanner() {
        // Downward-pointing pyramid: apex v0 at Z=-1 is the valley minimum.
        let soup = vec![
            0.0, 0.0, -1.0, 1.0, -1.0, 0.0, -1.0, -1.0, 0.0, 0.0, 0.0, -1.0, 1.0, 1.0, 0.0, 1.0,
            -1.0, 0.0, 0.0, 0.0, -1.0, -1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, -1.0, -1.0, -1.0,
            0.0, -1.0, 1.0, 0.0,
        ];

        let mesh = IndexedMesh::from_triangle_soup(&soup, 1e-5);
        assert_eq!(mesh.vertex_count(), 5);

        let mut adj_vertices = vec![HashSet::new(); mesh.vertex_count()];
        for tri in &mesh.triangles {
            for &(u, v, w) in &[
                (tri[0], tri[1], tri[2]),
                (tri[1], tri[2], tri[0]),
                (tri[2], tri[0], tri[1]),
            ] {
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
                vertices[a][0],
                vertices[a][1],
                vertices[a][2],
                vertices[b][0],
                vertices[b][1],
                vertices[b][2],
                vertices[c][0],
                vertices[c][1],
                vertices[c][2],
            ]);
        };

        // Outer bottom (CCW from below).
        push_tri(4, 1, 0);
        push_tri(4, 2, 1);
        push_tri(4, 3, 2);
        push_tri(4, 0, 3);

        // Outer walls.
        push_tri(0, 1, 6);
        push_tri(0, 6, 5);
        push_tri(1, 2, 7);
        push_tri(1, 7, 6);
        push_tri(2, 3, 8);
        push_tri(2, 8, 7);
        push_tri(3, 0, 5);
        push_tri(3, 5, 8);

        // Top rim.
        push_tri(5, 6, 10);
        push_tri(5, 10, 9);
        push_tri(6, 7, 11);
        push_tri(6, 11, 10);
        push_tri(7, 8, 12);
        push_tri(7, 12, 11);
        push_tri(8, 5, 9);
        push_tri(8, 9, 12);

        // Inner walls.
        push_tri(9, 13, 14);
        push_tri(9, 14, 10);
        push_tri(10, 14, 15);
        push_tri(10, 15, 11);
        push_tri(11, 15, 16);
        push_tri(11, 16, 12);
        push_tri(12, 16, 13);
        push_tri(12, 13, 9);

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
            for &(u, v, w) in &[
                (tri[0], tri[1], tri[2]),
                (tri[1], tri[2], tri[0]),
                (tri[2], tri[0], tri[1]),
            ] {
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

/// CP0 RED HARNESS — islands sideload frame + source fidelity (plan:
/// `agents/Claude/STL-import-perf/20260720-Implementation-Plan-islands-sideload-frame-fix.md`).
///
/// Locks the reprojection formula `w = M · (v_raw − C_pre)` that
/// `load_and_transform_mesh` implements, and pins the magnitude of the live
/// frame defect (§B1): the frontend passes the POST-centering scene bbox
/// center `c` where the raw-file frame requires `C_pre`.
///
/// **These are characterization tests, not reds.** `load_and_transform_mesh`
/// is a pure function of its arguments — it faithfully applies whatever centre
/// it is handed, so the Rust side cannot fail today. The genuine reds live on
/// the caller (R-I1/R-I2, `src/volumeAnalysis/Islands/__tests__/islandScanFrame.test.ts`).
/// What these lock is the ORACLE those reds are measured against, so a future
/// change to the helper cannot silently move the frame. The staleness
/// contract (CP0's deferred red, wired GREEN at CP3) locks the shared
/// MISSING/STALE refusal alongside them.
///
/// OFF-ORIGIN BY CONSTRUCTION: the asset's bbox min corner sits at (40, 25, 0).
/// This defect survived precisely because origin-centred test meshes make
/// `c` and `C_pre` numerically identical (decision memo §2.3) — an asset for
/// this bug must never be origin-centred.
///
/// Deliberately a small self-contained box rather than the P0 lattice
/// (`mesh_repair.rs` `p0_fullres_red_harness`): those helpers are private to
/// that module and their triangle enumeration order is a pinned contract for
/// P1's R2. A frame test needs off-origin-ness, not scale.
#[cfg(test)]
mod islands_frame_red_harness {
    use super::*;
    use std::io::{BufWriter, Write};
    use std::path::PathBuf;

    // Raw-file (off-origin) bbox of the generated asset.
    const RAW_MIN: [f32; 3] = [40.0, 25.0, 0.0];
    const RAW_MAX: [f32; 3] = [60.0, 31.0, 12.0];

    /// `C_pre` — the full 3-D bbox centre `processGeometry` captures before
    /// centring (`useStlGeometry.ts`, "C_pre capture"). The CORRECT subtrahend.
    fn c_pre() -> [f32; 3] {
        [
            (RAW_MIN[0] + RAW_MAX[0]) * 0.5,
            (RAW_MIN[1] + RAW_MAX[1]) * 0.5,
            (RAW_MIN[2] + RAW_MAX[2]) * 0.5,
        ]
    }

    /// `T_center` — what import actually translates by: X/Z centred, Y bottom
    /// to zero (`geometry.translate(-preCenter.x, -preBBox.min.y, -preCenter.z)`).
    fn t_center() -> [f32; 3] {
        [
            (RAW_MIN[0] + RAW_MAX[0]) * 0.5,
            RAW_MIN[1],
            (RAW_MIN[2] + RAW_MAX[2]) * 0.5,
        ]
    }

    /// `c` — the stored POST-centring `model.geometry.center`, i.e. the bbox
    /// centre of `raw − T_center`. This is the value `useIslands` wrongly sends.
    fn scene_center() -> [f32; 3] {
        let t = t_center();
        [
            (RAW_MIN[0] + RAW_MAX[0]) * 0.5 - t[0],
            (RAW_MIN[1] + RAW_MAX[1]) * 0.5 - t[1],
            (RAW_MIN[2] + RAW_MAX[2]) * 0.5 - t[2],
        ]
    }

    fn box_tri(min: [f32; 3], max: [f32; 3], t: u64) -> [[f32; 3]; 3] {
        let [x0, y0, z0] = min;
        let [x1, y1, z1] = max;
        match t {
            0 => [[x0, y0, z0], [x1, y1, z0], [x1, y0, z0]],
            1 => [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
            2 => [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1]],
            3 => [[x0, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            4 => [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1]],
            5 => [[x0, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            6 => [[x0, y1, z0], [x1, y1, z1], [x1, y1, z0]],
            7 => [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1]],
            8 => [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
            9 => [[x0, y0, z0], [x0, y1, z1], [x0, y1, z0]],
            10 => [[x1, y0, z0], [x1, y1, z1], [x1, y0, z1]],
            _ => [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
        }
    }

    /// Writes the deterministic off-origin box as a binary STL (zeroed normals
    /// — every DragonFruit reader derives normals from vertices).
    ///
    /// `label` gives each test its OWN file. Cargo runs tests on a parallel
    /// threadpool, so a single shared path lets one test's `File::create`
    /// truncate the asset while another is mid-read — observed as an
    /// intermittent failure during CP1 verification. Per-test paths remove the
    /// shared mutable state outright (the P0 lattice harness instead guards a
    /// deliberately *cached* asset with a mutex; these files are 684 bytes, so
    /// there is nothing to cache and nothing to lock).
    fn write_off_origin_stl(label: &str) -> PathBuf {
        let path = std::env::temp_dir()
            .join(format!("dragonfruit-islands-frame-offorigin-{label}.stl"));
        let file = std::fs::File::create(&path).expect("create off-origin STL");
        let mut out = BufWriter::new(file);
        out.write_all(&[0u8; 80]).unwrap();
        out.write_all(&12u32.to_le_bytes()).unwrap();
        let mut record = [0u8; 50];
        for index in 0..12 {
            let tri = box_tri(RAW_MIN, RAW_MAX, index);
            let mut at = 12;
            for vertex in tri {
                for component in vertex {
                    record[at..at + 4].copy_from_slice(&component.to_le_bytes());
                    at += 4;
                }
            }
            out.write_all(&record).unwrap();
            record[12..48].fill(0);
        }
        out.flush().unwrap();
        path
    }

    /// Column-major (three.js `Matrix4.elements`) translation-only matrix.
    fn translation_matrix(t: [f32; 3]) -> [f32; 16] {
        [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            t[0], t[1], t[2], 1.0,
        ]
    }

    /// Column-major R_z(90°) ∘ scale(2): (x, y, z) → (−2y, 2x, 2z).
    fn rot_z90_scale2_matrix() -> [f32; 16] {
        [
            0.0, 2.0, 0.0, 0.0, //
            -2.0, 0.0, 0.0, 0.0, //
            0.0, 0.0, 2.0, 0.0, //
            0.0, 0.0, 0.0, 1.0,
        ]
    }

    fn assert_close(actual: f32, expected: f32, what: &str) {
        assert!(
            (actual - expected).abs() < 1e-3,
            "{what}: expected {expected}, got {actual}"
        );
    }

    /// The algebraic core of the whole fix: `T_center + c == C_pre`. If this
    /// identity ever breaks (e.g. the import centring convention changes), the
    /// stored datum stops being the correct subtrahend for a raw-file re-read
    /// and every full-res consumer — slicing, mutators, islands — is wrong.
    #[test]
    fn t_center_plus_scene_center_equals_c_pre() {
        let t = t_center();
        let c = scene_center();
        let expected = c_pre();
        for axis in 0..3 {
            assert_close(t[axis] + c[axis], expected[axis], "T_center + c == C_pre");
        }
    }

    /// With the CORRECT subtrahend the re-read file lands exactly where the
    /// scene bake puts it: `w = M · (v_raw − C_pre)`.
    #[test]
    fn c_pre_reproduces_the_scene_bake_frame() {
        let path = write_off_origin_stl("scene-bake");
        let translate = [100.0f32, 200.0, 300.0];
        let mesh = load_and_transform_mesh(
            path.to_str().unwrap(),
            translation_matrix(translate),
            c_pre(),
            None,
        )
        .expect("load off-origin STL");

        let bbox = mesh.bbox();
        let cp = c_pre();
        for (axis, (got_min, got_max)) in [
            (bbox.min.x, bbox.max.x),
            (bbox.min.y, bbox.max.y),
            (bbox.min.z, bbox.max.z),
        ]
        .into_iter()
        .enumerate()
        {
            assert_close(
                got_min,
                RAW_MIN[axis] - cp[axis] + translate[axis],
                "world bbox min",
            );
            assert_close(
                got_max,
                RAW_MAX[axis] - cp[axis] + translate[axis],
                "world bbox max",
            );
        }
    }

    /// Pins the LIVE DEFECT's magnitude (§B1). Passing the scene centre `c`
    /// instead of `C_pre` displaces the entire sideloaded mesh by exactly
    /// `M_linear · T_center` — the import translation, rotated/scaled into
    /// world space. Asserted non-zero so the off-origin asset is proven to
    /// actually expose the bug (an origin-centred asset would not).
    #[test]
    fn wrong_center_displaces_by_m_linear_times_t_center() {
        let path = write_off_origin_stl("displacement");
        let matrix = rot_z90_scale2_matrix();

        let correct = load_and_transform_mesh(path.to_str().unwrap(), matrix, c_pre(), None)
            .expect("load with C_pre");
        let buggy = load_and_transform_mesh(path.to_str().unwrap(), matrix, scene_center(), None)
            .expect("load with the scene centre (the pre-fix caller)");

        // M_linear · T_center for R_z(90°)∘scale(2): (x,y,z) → (−2y, 2x, 2z).
        let t = t_center();
        let expected_delta = [-2.0 * t[1], 2.0 * t[0], 2.0 * t[2]];

        let cb = correct.bbox();
        let bb = buggy.bbox();
        let actual_delta = [
            bb.min.x - cb.min.x,
            bb.min.y - cb.min.y,
            bb.min.z - cb.min.z,
        ];

        for axis in 0..3 {
            assert_close(
                actual_delta[axis],
                expected_delta[axis],
                "sideload displacement (buggy − correct)",
            );
        }

        let magnitude = (actual_delta[0].powi(2)
            + actual_delta[1].powi(2)
            + actual_delta[2].powi(2))
        .sqrt();
        assert!(
            magnitude > 1.0,
            "off-origin asset must expose a real displacement, got {magnitude} mm"
        );
    }

    /// The staleness contract, GREEN since CP3 (landed at CP0 as the
    /// deferred-red stub `staleness_contract_is_red`; red run captured in the
    /// CP0 AAR). Shares P1's `verify_source_fingerprint` + error prefixes, so
    /// the islands sideload degrades exactly like slicing and the mutators.
    #[test]
    fn staleness_contract_refuses_stale_and_missing_sources() {
        let path = write_off_origin_stl("staleness");
        let matrix = translation_matrix([0.0, 0.0, 0.0]);

        // Matching fingerprint → loads.
        let actual = crate::mesh_repair::verify_source_fingerprint(&path, None)
            .expect("stat the generated asset");
        load_and_transform_mesh(
            path.to_str().unwrap(),
            matrix,
            c_pre(),
            Some((actual.size_bytes, actual.mtime_ms)),
        )
        .expect("matching fingerprint must load");

        // Changed-on-disk (size mismatch) → refused as STALE, never scanned.
        let err = load_and_transform_mesh(
            path.to_str().unwrap(),
            matrix,
            c_pre(),
            Some((actual.size_bytes + 1, actual.mtime_ms)),
        )
        .expect_err("size mismatch must be refused");
        assert!(
            err.contains("FULLRES_SOURCE_STALE"),
            "stale error must carry the shared prefix, got: {err}"
        );

        // Missing file → MISSING, with or without a fingerprint.
        let gone = std::env::temp_dir().join("dragonfruit-islands-frame-nonexistent.stl");
        let _ = std::fs::remove_file(&gone);
        let err = load_and_transform_mesh(gone.to_str().unwrap(), matrix, c_pre(), None)
            .expect_err("missing file must be refused");
        assert!(
            err.contains("FULLRES_SOURCE_MISSING"),
            "missing error must carry the shared prefix, got: {err}"
        );
    }
}
