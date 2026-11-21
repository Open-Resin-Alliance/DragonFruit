//! IPC for deriving a model's display mesh: its long faces split so the per-vertex
//! AO has vertices to land on.
//!
//! The mesh the model *is* never changes here — the renderer keeps it and draws this
//! one instead (`GeometryWithBounds.displayGeometry`). Every producer of a model mesh
//! asks the same command: the loaders, the importers that build geometry in the
//! renderer (LYS, via `plugins/lys-import/`), and the operations that replace a mesh.
//!
//! In: a non-indexed triangle soup in the request body, 9 floats per triangle. It is
//! welded on the way in, which is what gives the refinement shared edges to split.
//!
//! Out: a `DFMX` payload (`mesh_repair::encode_mesh_bodies`). No bodies when the mesh
//! has nothing to split, so the caller draws its own mesh. Otherwise one body, the
//! display mesh, with its face normals, and the header's token naming it in the bake
//! registry so the AO is not sent the soup back.

use dragonfruit_mesh_core::mesh::IndexedMesh;
use dragonfruit_mesh_core::refine::{
    longest_edge, refine_long_edges_with_budget, refinement_budget, MAX_EDGE_DIAGONAL_FRACTION,
    MAX_PASSES,
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
        let source_triangles = soup.len() / 9;
        if !(diagonal.is_finite() && diagonal > 0.0 && longest_edge(&mesh) > max_edge) {
            // Nothing to split: the caller's own mesh is the one to draw. The welded
            // mesh is not sent back either — it may have dropped degenerate triangles,
            // and a display mesh is only worth its memory when it adds vertices.
            return crate::mesh_repair::encode_mesh_bodies(&[], 0, false, None, None, None)
                .map(Response::new);
        }
        let budget = refinement_budget(mesh.triangles.len());
        let refined = refine_long_edges_with_budget(&mesh, max_edge, MAX_PASSES, budget);
        let triangles = refined.triangles.len();
        log::info!(
            "[refine_mesh_soup] {source_triangles} soup triangles -> {triangles} refined in {}ms",
            started.elapsed().as_millis(),
        );

        let token = crate::mesh_repair::keep_for_bake(refined);
        let kept = crate::mesh_repair::kept_for_bake(token)
            .ok_or_else(|| "refine_mesh_soup: the display mesh was evicted at once".to_string())?;
        crate::mesh_repair::encode_mesh_bodies(
            std::slice::from_ref(&*kept),
            triangles as u32,
            false,
            None,
            None,
            Some(token),
        )
        .map(Response::new)
    })
    .await
    .map_err(|e| format!("refine task panicked: {e}"))?
}

