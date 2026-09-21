//! IPC for refining geometry that an importer built outside the native loaders.
//!
//! LYS is the case this exists for: it is imported by a TypeScript plugin
//! (`plugins/lys-import/`), plugins cannot call native code, and so its geometry
//! never passes through `dragonfruit_mesh_repair::io::load_mesh_from_path` where
//! coarse faces are refined. The host calls this after a plugin import instead,
//! which keeps one implementation of the rule and covers any future importer that
//! builds geometry in the renderer.
//!
//! In: a non-indexed triangle soup in the request body, 9 floats per triangle.
//! Out: `[u32 triangle count][f32 positions][f32 normals]`, 9 of each per
//! triangle, normals welded and split at creases (`mesh_core::normals`). The
//! mesh is welded on the way in, which is what gives the refinement shared edges
//! to split and the normals adjacency to average over.

use dragonfruit_mesh_core::mesh::IndexedMesh;
use dragonfruit_mesh_core::normals::corner_normals;
use dragonfruit_mesh_core::refine::{
    longest_edge, refine_long_edges_with_budget, DEFAULT_GROWTH_LIMIT,
    MAX_EDGE_DIAGONAL_FRACTION, MAX_PASSES,
};
use dragonfruit_mesh_repair::io::DEFAULT_MERGE_EPSILON;
use tauri::ipc::{InvokeBody, Request, Response};

#[tauri::command]
pub async fn refine_mesh_soup(request: Request<'_>) -> Result<Response, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => return Err("refine_mesh_soup expects a raw binary body".into()),
    };

    tauri::async_runtime::spawn_blocking(move || {
        let soup: &[f32] =
            bytemuck::try_cast_slice(&bytes).map_err(|e| format!("positions cast: {e}"))?;
        if soup.len() % 9 != 0 {
            return Err(format!(
                "positions are not a multiple of 9 floats: {}",
                soup.len()
            ));
        }
        let started = std::time::Instant::now();
        let mesh = IndexedMesh::from_triangle_soup(soup, DEFAULT_MERGE_EPSILON);
        if mesh.triangles.is_empty() {
            return Err("refine_mesh_soup: no triangles".to_string());
        }

        let mut min = [f32::INFINITY; 3];
        let mut max = [f32::NEG_INFINITY; 3];
        for position in &mesh.positions {
            for (axis, value) in [position.x, position.y, position.z].into_iter().enumerate() {
                min[axis] = min[axis].min(value);
                max[axis] = max[axis].max(value);
            }
        }
        let diagonal = ((max[0] - min[0]).powi(2)
            + (max[1] - min[1]).powi(2)
            + (max[2] - min[2]).powi(2))
        .sqrt();
        let max_edge = diagonal * MAX_EDGE_DIAGONAL_FRACTION;
        let refined = if diagonal.is_finite() && diagonal > 0.0 && longest_edge(&mesh) > max_edge {
            let budget = (mesh.triangles.len() as f32 * DEFAULT_GROWTH_LIMIT) as usize;
            refine_long_edges_with_budget(&mesh, max_edge, MAX_PASSES, budget)
        } else {
            mesh
        };

        let normals = corner_normals(&refined);
        let triangles = refined.triangles.len();
        log::info!(
            "[refine_mesh_soup] {} soup triangles -> {} refined in {}ms",
            soup.len() / 9,
            triangles,
            started.elapsed().as_millis(),
        );

        let mut out = Vec::with_capacity(4 + triangles * 18 * 4);
        out.extend_from_slice(&(triangles as u32).to_le_bytes());
        for triangle in &refined.triangles {
            for index in triangle {
                let position = refined.positions[*index as usize];
                out.extend_from_slice(&position.x.to_le_bytes());
                out.extend_from_slice(&position.y.to_le_bytes());
                out.extend_from_slice(&position.z.to_le_bytes());
            }
        }
        for normal in &normals {
            out.extend_from_slice(&normal.x.to_le_bytes());
            out.extend_from_slice(&normal.y.to_le_bytes());
            out.extend_from_slice(&normal.z.to_le_bytes());
        }
        Ok(Response::new(out))
    })
    .await
    .map_err(|e| format!("refine task panicked: {e}"))?
}
