use std::sync::{Arc, Mutex, OnceLock};
use std::collections::HashMap;
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
/// Returns a Vec<u32> containing matching triangle IDs.
/// Phase 2: Establishes a functional bridge returning the seed face plus its 1-ring neighbors.
#[tauri::command]
pub async fn propose_brush_region(
    model_id: String,
    seed_triangle_id: u32,
    _brush_type: String,
) -> Result<Vec<u32>, String> {
    let cache_lock = get_model_cache().lock().map_err(|e| e.to_string())?;
    let cached = cache_lock.get(&model_id).ok_or_else(|| {
        format!("Model {} is not initialized in the support painter cache.", model_id)
    })?;

    let seed = seed_triangle_id as usize;
    if seed >= cached.mesh.triangle_count() {
        return Err(format!("Seed triangle ID {} is out of mesh bounds.", seed_triangle_id));
    }

    let mut proposed = vec![seed_triangle_id];

    // Build 1-ring neighborhood for Phase 2 bridge verification
    let tri = cached.mesh.triangles[seed];
    for &(u, v) in &[(tri[0], tri[1]), (tri[1], tri[2]), (tri[2], tri[0])] {
        let edge_key = dragonfruit_mesh_repair::core::halfedge::edge_key(u, v);
        if let Some(edge_info) = cached.topology.edges.get(&edge_key) {
            for &adj_fi in &edge_info.faces {
                if adj_fi != seed_triangle_id && !proposed.contains(&adj_fi) {
                    proposed.push(adj_fi);
                }
            }
        }
    }

    Ok(proposed)
}
