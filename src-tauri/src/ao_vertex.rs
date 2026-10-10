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

use dragonfruit_mesh_core::mesh::IndexedMesh;
use dragonfruit_mesh_core::vertex_occlusion::{
    bake_smoothed_occlusion_for_soup, REACH_RATIO, SMOOTHING_PASSES, SOUP_MERGE_EPSILON,
};
use tauri::ipc::{InvokeBody, Request, Response};

/// Rays per vertex for the shipped bake.
///
/// Not the estimator's eight: the field is baked once per model on an idle
/// callback, and the measurements in `vertex_occlusion` put 32 at the point where
/// the estimate stops being the dominant error — 0.024 RMS against a 64-ray
/// reference, where eight rays give 0.056, for a bake that measures 1.78s on a
/// 768,734-triangle model instead of 0.64s. Going on to 64 helps (0.008) and
/// costs 3.8s on the CPU, which is exactly what the GPU path is for: the same 32
/// rays measure 0.14s there.
const BAKED_RAYS: usize = 32;

/// The bake on the GPU, when this machine has an adapter.
///
/// The compute kernel takes the welded mesh, so this welds the soup with the same
/// tolerance the CPU soup entry points use and expands the per-vertex values back
/// through the corner map — the values have to land on the corners the frontend
/// attaches them to. Any failure returns `Err` and the caller falls back to the
/// CPU recipe: the GPU is only ever a faster way to the same field.
fn bake_on_gpu(soup: &[f32], rays: usize) -> Result<(Vec<f32>, usize), String> {
    let (mesh, corner_map) =
        IndexedMesh::from_triangle_soup_with_corner_map(soup, SOUP_MERGE_EPSILON);
    if mesh.positions.is_empty() {
        return Err("mesh has no usable vertices".into());
    }
    let values = dragonfruit_ao_gpu::bake_smoothed(&mesh, rays)?;
    let out: Vec<f32> = corner_map
        .iter()
        .map(|id| values.get(*id as usize).copied().unwrap_or(1.0))
        .collect();
    Ok((out, mesh.positions.len()))
}

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
        // The GPU when this machine has one, the CPU recipe otherwise, and the
        // CPU recipe again if the GPU fails mid-flight. The two produce the same
        // field — the turn is a different hash on each side, nothing else — so
        // which one ran is a performance fact, not a look.
        let mut adapter = "";
        let (occlusion, welded) = if dragonfruit_ao_gpu::available() {
            match bake_on_gpu(soup, BAKED_RAYS) {
                Ok(values) => {
                    adapter = dragonfruit_ao_gpu::adapter_name().unwrap_or("gpu");
                    values
                }
                Err(error) => {
                    log::warn!("[ao] GPU bake failed ({error}); using the CPU recipe");
                    bake_smoothed_occlusion_for_soup(soup, BAKED_RAYS, None)
                }
            }
        } else {
            bake_smoothed_occlusion_for_soup(soup, BAKED_RAYS, None)
        };
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
             (reach ratio {REACH_RATIO}, {BAKED_RAYS} rays, fan turned per vertex, \
             {SMOOTHING_PASSES} graph pass, {})",
            occlusion.len(),
            welded,
            soup.len() / 9,
            started.elapsed().as_millis(),
            if adapter.is_empty() { "cpu" } else { adapter },
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
