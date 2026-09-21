//! Tauri IPC command for the per-vertex ambient-occlusion bake.
//!
//! This is the *surface* estimator, which resolves whatever the mesh resolves —
//! the one that reads correctly on a finely detailed part, where a volumetric
//! grid cannot resolve sub-voxel relief (measured, see `docs/dev/backlog.md`).
//!
//! The mesh arrives **in the request body**, not through the shared staging
//! buffer, for the same reason the island scanner stopped reading a sideloaded
//! mesh: staging is process-wide mutable state shared with repair, punching and
//! hollowing, so a bake that reads it can compute occlusion for a different mesh
//! than the one the values get attached to.
//!
//! The bake itself lives in `dragonfruit-mesh-core::vertex_occlusion` so it is
//! testable without Tauri; this module is only the IPC boundary.

use dragonfruit_mesh_core::vertex_occlusion::{
    bake_vertex_occlusion_for_soup, DEFAULT_RAYS, REACH_RATIO,
};
use tauri::ipc::{InvokeBody, Request, Response};

/// Bake per-vertex ambient occlusion for a mesh supplied in the request body.
///
/// **The mesh arrives in the request, not through the shared staging buffer.**
/// That is deliberate and it mirrors the overhang scanner: staging is
/// process-wide mutable state that repair, hole punching and hollowing all
/// write, so a bake that reads it can find a *different* mesh than the one the
/// result will be attached to — the occlusion is then computed for another
/// shape and indexed into this one, which renders as misaligned triangles. The
/// island scanner hit exactly this and moved to passing the geometry it will
/// map onto; this does the same. Raw bytes rather than a JSON `Vec<f32>`: a
/// print-sized soup is millions of floats, and the body is already a byte
/// buffer on the JS side.
///
#[tauri::command]
pub async fn bake_vertex_occlusion(request: Request<'_>) -> Result<Response, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err("bake_vertex_occlusion expects a raw binary body".into())
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let soup: &[f32] = bytemuck::try_cast_slice(&bytes)
            .map_err(|e| format!("positions cast: {e}"))?;
        if soup.len() % 9 != 0 {
            return Err(format!(
                "positions are not a multiple of 9 floats: {}",
                soup.len()
            ));
        }
        let started = std::time::Instant::now();
        let (occlusion, welded) = bake_vertex_occlusion_for_soup(soup, DEFAULT_RAYS, None);
        if occlusion.is_empty() {
            return Err("AO bake: mesh has no usable vertices".to_string());
        }
        // The weld ratio is the diagnostic for this feature's whole bug class:
        // one value per soup corner, and welded vertices only where corners are
        // genuinely shared. A ratio of 3.0 means nothing merged (an unwelded
        // mesh, where occlusion is per triangle and reads as a mosaic), and a
        // count that does not divide the corners means the model's topology is
        // not what the caller assumed.
        log::info!(
            "[ao] baked {} soup corners -> {} welded vertices ({} triangles) in {}ms \
             (reach ratio {REACH_RATIO}, {DEFAULT_RAYS} rays)",
            occlusion.len(),
            welded,
            soup.len() / 9,
            started.elapsed().as_millis(),
        );
        let mut out = Vec::with_capacity(occlusion.len() * 4);
        for value in &occlusion {
            out.extend_from_slice(&value.to_le_bytes());
        }
        Ok(Response::new(out))
    })
    .await
    .map_err(|e| format!("vertex occlusion task panicked: {e}"))?
}
