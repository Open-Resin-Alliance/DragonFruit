use std::sync::{Arc, Mutex, OnceLock};
use std::collections::{HashMap, VecDeque, HashSet, BinaryHeap};
use serde::{Serialize, Deserialize};
use dragonfruit_mesh_repair::{IndexedMesh, core::halfedge::Topology, core::mesh::Vec3};

/// Estimated curvature attributes per triangle for smart brush evaluations.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TriangleCurvature {
    /// Maximum principal curvature estimate (based on the sharpest neighboring dihedral angle)
    pub k1: f32,
    /// Minimum principal curvature estimate (based on the flattest neighboring dihedral angle)
    pub k2: f32,
    /// Gaussian curvature estimate
    pub gaussian: f32,
    /// Mean curvature estimate
    pub mean: f32,
}

/// Cached topological and geometric analysis for a model.
#[allow(dead_code)]
pub struct CachedModelData {
    pub mesh: IndexedMesh,
    pub topology: Topology,
    pub normals: Vec<Vec3>,
    pub curvatures: Vec<TriangleCurvature>,
}

static MODEL_CACHE: OnceLock<Mutex<HashMap<String, Arc<CachedModelData>>>> = OnceLock::new();

pub fn get_model_cache() -> &'static Mutex<HashMap<String, Arc<CachedModelData>>> {
    MODEL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Estimates discrete surface curvatures (k1, k2, gaussian, mean) for all triangles in the mesh.
pub fn estimate_curvatures(mesh: &IndexedMesh, topology: &Topology, normals: &[Vec3]) -> Vec<TriangleCurvature> {
    let tri_count = mesh.triangle_count();
    let mut curvatures = vec![
        TriangleCurvature { k1: 0.0, k2: 0.0, gaussian: 0.0, mean: 0.0 };
        tri_count
    ];

    for fi in 0..tri_count {
        let tri = mesh.triangles[fi];
        let n_fi = normals[fi];

        // Traverse the three edges of the triangle to evaluate adjacent face normal variations
        let mut dihedral_angles = Vec::with_capacity(3);

        for &(u, v) in &[(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
            let edge_key = dragonfruit_mesh_repair::core::halfedge::edge_key(u, v);
            if let Some(edge_info) = topology.edges.get(&edge_key) {
                let mut max_angle: f32 = 0.0;
                for &adj_fi in &edge_info.faces {
                    if adj_fi != fi as u32 {
                        let n_adj = normals[adj_fi as usize];
                        let dot = n_fi.dot(n_adj).clamp(-1.0, 1.0);
                        let angle = dot.acos(); // Dihedral angle in radians
                        if angle > max_angle {
                            max_angle = angle;
                        }
                    }
                }
                dihedral_angles.push(max_angle);
            } else {
                dihedral_angles.push(0.0); // Boundary edge
            }
        }

        // Sort angles to extract principal curvatures
        dihedral_angles.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let k1 = dihedral_angles[2]; // Maximum dihedral angle deviation (ridge indicator)
        let k2 = dihedral_angles[0]; // Minimum dihedral angle deviation (plane indicator)

        curvatures[fi] = TriangleCurvature {
            k1,
            k2,
            gaussian: k1 * k2,
            mean: (k1 + k2) * 0.5,
        };
    }

    curvatures
}

/// Tauri IPC Command: Welds flat triangle soup, builds topological half-edges,
/// computes normals and curvatures, and caches them in memory.
#[tauri::command]
pub async fn initialize_support_painter_model(
    model_id: String,
    positions: Vec<f32>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        log::info!("[support-painter] Initializing topology for model {} ({} floats)", model_id, positions.len());

        let start_time = std::time::Instant::now();
        
        // 1. Reconstruct indexed watertight mesh by welding coincident vertices
        let mesh = IndexedMesh::from_triangle_soup(&positions, 1e-5);
        let weld_elapsed = start_time.elapsed();

        // 2. Build half-edge topological adjacencies
        let topology = Topology::build(&mesh);
        let topo_elapsed = start_time.elapsed() - weld_elapsed;

        // 3. Compute per-triangle face normals
        let tri_count = mesh.triangle_count();
        let mut normals = Vec::with_capacity(tri_count);
        for fi in 0..tri_count {
            normals.push(mesh.tri_normal(fi as u32));
        }

        // 4. Estimate surface curvatures
        let curvatures = estimate_curvatures(&mesh, &topology, &normals);
        let curv_elapsed = start_time.elapsed() - weld_elapsed - topo_elapsed;

        log::info!(
            "[support-painter] Topology cache built in {:?}. weld={:?} topo={:?} curv={:?} triangles={} vertices={}",
            start_time.elapsed(),
            weld_elapsed,
            topo_elapsed,
            curv_elapsed,
            mesh.triangle_count(),
            mesh.vertex_count()
        );

        let cached = Arc::new(CachedModelData {
            mesh,
            topology,
            normals,
            curvatures,
        });

        let mut cache = get_model_cache().lock().map_err(|e| e.to_string())?;
        cache.insert(model_id.clone(), cached);

        Ok(format!("Topology cached. triangles={}", tri_count))
    })
    .await
    .map_err(|e| format!("Initialization task panicked: {e}"))?
}

/// Tauri IPC Command: Evicts the cached model topology from memory.
#[tauri::command]
pub async fn clear_support_painter_model(model_id: String) -> Result<bool, String> {
    let mut cache = get_model_cache().lock().map_err(|e| e.to_string())?;
    let removed = cache.remove(&model_id).is_some();
    if removed {
        log::info!("[support-painter] Evicted cached model {}", model_id);
    }
    Ok(removed)
}

/// Tauri IPC Command: Real-time region proposals debounced on mouse pointer move.
/// Compute the centroid coordinates of a triangle.
fn tri_centroid(mesh: &IndexedMesh, face: u32) -> Vec3 {
    let [a, b, c] = mesh.tri_positions(face);
    Vec3::new(
        (a.x + b.x + c.x) / 3.0,
        (a.y + b.y + c.y) / 3.0,
        (a.z + b.z + c.z) / 3.0,
    )
}

/// Retrieve unique adjacent faces for a given face by traversing its edges.
fn adj_faces(mesh: &IndexedMesh, topology: &Topology, face: u32) -> Vec<u32> {
    let tri = mesh.triangles[face as usize];
    let mut adjs = Vec::with_capacity(3);
    for &(u, v) in &[(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
        let edge_key = dragonfruit_mesh_repair::core::halfedge::edge_key(u, v);
        if let Some(edge_info) = topology.edges.get(&edge_key) {
            for &adj_fi in &edge_info.faces {
                if adj_fi != face && !adjs.contains(&adj_fi) {
                    adjs.push(adj_fi);
                }
            }
        }
    }
    adjs
}

#[derive(Copy, Clone, PartialEq)]
struct DijkstraState {
    cost: f32,
    face: u32,
}

impl Eq for DijkstraState {}

impl Ord for DijkstraState {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other.cost.partial_cmp(&self.cost).unwrap_or(std::cmp::Ordering::Equal)
    }
}

impl PartialOrd for DijkstraState {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Tauri IPC Command: Real-time region proposals debounced on mouse pointer move.
/// Returns a Vec<u32> containing matching triangle IDs.
/// Phase 3: Implements smart-brush mathematical suites: MacroFace, Ridge, Cylinder, and Point.
#[tauri::command]
pub async fn propose_brush_region(
    model_id: String,
    seed_triangle_id: u32,
    brush_type: String,
) -> Result<Vec<u32>, String> {
    let cache_lock = get_model_cache().lock().map_err(|e| e.to_string())?;
    let cached = cache_lock.get(&model_id).ok_or_else(|| {
        format!("Model {} is not initialized in the support painter cache.", model_id)
    })?;

    let seed = seed_triangle_id as usize;
    if seed >= cached.mesh.triangle_count() {
        return Err(format!("Seed triangle ID {} is out of mesh bounds.", seed_triangle_id));
    }

    match brush_type.as_str() {
        "MacroFace" => {
            let mut queue = VecDeque::new();
            let mut visited = HashSet::new();
            
            if cached.normals[seed].z < 0.0 {
                let seed_normal = cached.normals[seed];
                queue.push_back(seed_triangle_id);
                visited.insert(seed_triangle_id);

                while let Some(curr) = queue.pop_front() {
                    let adjs = adj_faces(&cached.mesh, &cached.topology, curr);
                    for adj in adjs {
                        if !visited.contains(&adj) {
                            let n_adj = cached.normals[adj as usize];
                            if n_adj.z < 0.0 {
                                // 35 degrees = 0.61 radians normal deviation tolerance
                                let normal_deviation = seed_normal.dot(n_adj).clamp(-1.0, 1.0).acos();

                                let n_curr = cached.normals[curr as usize];
                                // 25 degrees = 0.43 radians edge-guard dihedral tolerance
                                let edge_dihedral = n_curr.dot(n_adj).clamp(-1.0, 1.0).acos();

                                if normal_deviation < 0.61 && edge_dihedral < 0.43 {
                                    visited.insert(adj);
                                    queue.push_back(adj);
                                }
                            }
                        }
                    }
                }
            }
            Ok(visited.into_iter().collect())
        }
        "Ridge" => {
            let mut visited = HashSet::new();

            if cached.normals[seed].z < 0.0 && cached.curvatures[seed].k1 > 0.15 {
                visited.insert(seed_triangle_id);

                // Get adjacent faces of the seed
                let adjs = adj_faces(&cached.mesh, &cached.topology, seed_triangle_id);
                let mut candidates: Vec<u32> = adjs.into_iter()
                    .filter(|&adj| {
                        let idx = adj as usize;
                        cached.normals[idx].z < 0.0 && cached.curvatures[idx].k1 > 0.15
                    })
                    .collect();

                // Sort candidates by curvature k1 descending (sharpest crease first)
                candidates.sort_by(|&a, &b| {
                    cached.curvatures[b as usize].k1.partial_cmp(&cached.curvatures[a as usize].k1).unwrap_or(std::cmp::Ordering::Equal)
                });

                // Follow branch A (the sharpest neighboring crease)
                if candidates.len() > 0 {
                    let mut curr_a = candidates[0];
                    visited.insert(curr_a);

                    loop {
                        let adjs_a = adj_faces(&cached.mesh, &cached.topology, curr_a);
                        let mut next_candidates: Vec<u32> = adjs_a.into_iter()
                            .filter(|&adj| {
                                let idx = adj as usize;
                                !visited.contains(&adj) && cached.normals[idx].z < 0.0 && cached.curvatures[idx].k1 > 0.15
                            })
                            .collect();
                        if next_candidates.is_empty() {
                            break;
                        }
                        // Greedily pick the neighbor with the maximum curvature
                        next_candidates.sort_by(|&a, &b| {
                            cached.curvatures[b as usize].k1.partial_cmp(&cached.curvatures[a as usize].k1).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        curr_a = next_candidates[0];
                        visited.insert(curr_a);
                    }
                }

                // Follow branch B (the second sharpest neighboring crease, extending in the opposite direction)
                if candidates.len() > 1 {
                    let mut curr_b = candidates[1];
                    visited.insert(curr_b);

                    loop {
                        let adjs_b = adj_faces(&cached.mesh, &cached.topology, curr_b);
                        let mut next_candidates: Vec<u32> = adjs_b.into_iter()
                            .filter(|&adj| {
                                let idx = adj as usize;
                                !visited.contains(&adj) && cached.normals[idx].z < 0.0 && cached.curvatures[idx].k1 > 0.15
                            })
                            .collect();
                        if next_candidates.is_empty() {
                            break;
                        }
                        // Greedily pick the neighbor with the maximum curvature
                        next_candidates.sort_by(|&a, &b| {
                            cached.curvatures[b as usize].k1.partial_cmp(&cached.curvatures[a as usize].k1).unwrap_or(std::cmp::Ordering::Equal)
                        });
                        curr_b = next_candidates[0];
                        visited.insert(curr_b);
                    }
                }
            }
            Ok(visited.into_iter().collect())
        }
        "Cylinder" => {
            let mut queue = VecDeque::new();
            let mut visited = HashSet::new();

            let seed_curv = &cached.curvatures[seed];
            if cached.normals[seed].z < 0.0 && seed_curv.k1 > 0.05 && seed_curv.k2 < 0.02 {
                queue.push_back(seed_triangle_id);
                visited.insert(seed_triangle_id);

                while let Some(curr) = queue.pop_front() {
                    let adjs = adj_faces(&cached.mesh, &cached.topology, curr);
                    for adj in adjs {
                        if !visited.contains(&adj) {
                            let idx = adj as usize;
                            if cached.normals[idx].z < 0.0 {
                                let curv = &cached.curvatures[idx];
                                if curv.k1 > 0.05 && curv.k2 < 0.02 {
                                    visited.insert(adj);
                                    queue.push_back(adj);
                                }
                            }
                        }
                    }
                }
            }
            Ok(visited.into_iter().collect())
        }
        "Point" => {
            let mut proposed = Vec::new();
            let mut dists = HashMap::new();
            let mut heap = BinaryHeap::new();

            if cached.normals[seed].z < 0.0 {
                let r_limit = 8.0f32; // Geodesic radius limit in mm
                dists.insert(seed_triangle_id, 0.0f32);
                heap.push(DijkstraState { cost: 0.0, face: seed_triangle_id });

                while let Some(DijkstraState { cost, face }) = heap.pop() {
                    if cost > r_limit {
                        continue;
                    }
                    if !proposed.contains(&face) {
                        proposed.push(face);
                    }

                    let centroid_curr = tri_centroid(&cached.mesh, face);
                    let adjs = adj_faces(&cached.mesh, &cached.topology, face);
                    for adj in adjs {
                        let idx = adj as usize;
                        if cached.normals[idx].z < 0.0 {
                            let centroid_adj = tri_centroid(&cached.mesh, adj);
                            let step_cost = centroid_curr.sub(centroid_adj).length();
                            let next_cost = cost + step_cost;

                            let current_best = *dists.get(&adj).unwrap_or(&f32::INFINITY);
                            if next_cost < current_best && next_cost <= r_limit {
                                dists.insert(adj, next_cost);
                                heap.push(DijkstraState { cost: next_cost, face: adj });
                            }
                        }
                    }
                }
            }
            Ok(proposed)
        }
        "Ring" => {
            let mut queue = VecDeque::new();
            let mut visited = HashSet::new();

            if cached.normals[seed].z < 0.0 {
                let seed_centroid = tri_centroid(&cached.mesh, seed_triangle_id);
                let seed_z = seed_centroid.z;

                queue.push_back(seed_triangle_id);
                visited.insert(seed_triangle_id);

                while let Some(curr) = queue.pop_front() {
                    let adjs = adj_faces(&cached.mesh, &cached.topology, curr);
                    for adj in adjs {
                        if !visited.contains(&adj) {
                            let idx = adj as usize;
                            if cached.normals[idx].z < 0.0 {
                                let centroid = tri_centroid(&cached.mesh, adj);
                                if (centroid.z - seed_z).abs() <= 1.0 {
                                    visited.insert(adj);
                                    queue.push_back(adj);
                                }
                            }
                        }
                    }
                }
            }
            Ok(visited.into_iter().collect())
        }
        _ => {
            // Fallback: return seed face + 1-ring neighbors (Phase 2 legacy) if normal points below horizontal
            let mut proposed = Vec::new();
            if cached.normals[seed].z < 0.0 {
                proposed.push(seed_triangle_id);
                let tri = cached.mesh.triangles[seed];
                for &(u, v) in &[(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
                    let edge_key = dragonfruit_mesh_repair::core::halfedge::edge_key(u, v);
                    if let Some(edge_info) = cached.topology.edges.get(&edge_key) {
                        for &adj_fi in &edge_info.faces {
                            if adj_fi != seed_triangle_id && !proposed.contains(&adj_fi) {
                                if cached.normals[adj_fi as usize].z < 0.0 {
                                    proposed.push(adj_fi);
                                }
                            }
                        }
                    }
                }
            }
            Ok(proposed)
        }
    }
}
