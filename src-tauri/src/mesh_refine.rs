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

    tauri::async_runtime::spawn_blocking(move || refine_soup(&bytes).map(Response::new))
        .await
        .map_err(|e| format!("refine task panicked: {e}"))?
}

/// The command's work, apart from the IPC: a soup in, a `DFMX` payload out.
fn refine_soup(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let soup: &[f32] =
        bytemuck::try_cast_slice(bytes).map_err(|e| format!("positions cast: {e}"))?;
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
        return crate::mesh_repair::encode_mesh_bodies(&[], 0, false, None, None, None);
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header_u32(bytes: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
    }

    /// A flat unit square as a soup, split into `cells × cells` quads.
    fn square_soup(cells: usize) -> Vec<f32> {
        let step = 1.0 / cells as f32;
        let mut soup = Vec::new();
        for row in 0..cells {
            for col in 0..cells {
                let (x0, y0) = (col as f32 * step, row as f32 * step);
                let (x1, y1) = (x0 + step, y0 + step);
                soup.extend_from_slice(&[x0, y0, 0.0, x1, y0, 0.0, x1, y1, 0.0]);
                soup.extend_from_slice(&[x0, y0, 0.0, x1, y1, 0.0, x0, y1, 0.0]);
            }
        }
        soup
    }

    #[test]
    fn a_fine_mesh_has_no_display_mesh() {
        // Edges of 1/60 against a diagonal of √2: well under the 2% the AO needs.
        let payload = refine_soup(bytemuck::cast_slice(&square_soup(60))).unwrap();
        assert_eq!(&payload[0..4], b"DFMX");
        assert_eq!(
            header_u32(&payload, 12),
            0,
            "no bodies: the model draws its own mesh"
        );
        assert_eq!(header_u32(&payload, 28), 0, "nothing kept for the bake");
    }

    #[test]
    fn a_coarse_mesh_gets_a_finer_display_mesh_kept_for_the_bake() {
        let payload = refine_soup(bytemuck::cast_slice(&square_soup(1))).unwrap();
        assert_eq!(header_u32(&payload, 12), 1, "one body: the display mesh");
        let triangles = header_u32(&payload, 32) as usize;
        assert!(
            triangles > 2,
            "the two-triangle panel is split, got {triangles}"
        );

        let token = header_u32(&payload, 28);
        assert_ne!(token, 0);
        let kept = crate::mesh_repair::kept_for_bake(token).expect("the bake finds it");
        assert_eq!(
            kept.triangles.len(),
            triangles,
            "the bake gets the mesh that is drawn"
        );
    }

    #[test]
    fn a_soup_that_is_not_whole_triangles_is_refused() {
        let soup = [0.0f32; 10];
        assert!(refine_soup(bytemuck::cast_slice(&soup)).is_err());
        assert!(refine_soup(&[]).is_err());
    }
}
