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
use dragonfruit_mesh_repair::io::{refine_coarse_faces, DEFAULT_MERGE_EPSILON};
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
        let source_triangles = mesh.triangles.len();
        // The same rule, threshold and budget the loaders used to apply to the model.
        let refined = refine_coarse_faces(mesh);
        let triangles = refined.triangles.len();
        if triangles == source_triangles {
            // Nothing to split (refinement only ever adds triangles): the caller's own
            // mesh is the one to draw, and the welded copy is not sent back.
            return crate::mesh_repair::encode_mesh_bodies(&[], 0, false, None, None, None)
                .map(Response::new);
        }
        log::info!(
            "[refine_mesh_soup] {source_triangles} triangles -> {triangles} for display in {}ms",
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

