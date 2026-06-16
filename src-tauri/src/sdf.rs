//! Tauri IPC surface for `dragonfruit-sdf`.
//!
//! Commands:
//! - `compute_sdf_from_staged` — compute a sparse SDF from the staged mesh
//!   and return it as a raw binary blob (the frontend parses it into the
//!   pre-computed SDF cache).

use std::sync::{Mutex, OnceLock};

use dragonfruit_sdf::{
    compute_heightmap, compute_sdf_grid, SdfMeshInput, SdfOptions, SparseSdfGrid,
};
use rayon::{ThreadPool, ThreadPoolBuilder};
use tauri::ipc::Response;

use crate::{staged_mesh, staged_mesh_stats, StageMeshStats};

/// In-memory cache of the last computed SDF grid, keyed by mesh stats so the
/// frontend can avoid recomputing if the model hasn't changed.
static SDF_CACHE: OnceLock<Mutex<Option<(StageMeshStats, SparseSdfGrid)>>> = OnceLock::new();
static SDF_POOL: OnceLock<ThreadPool> = OnceLock::new();

pub(crate) fn sdf_cache() -> &'static Mutex<Option<(StageMeshStats, SparseSdfGrid)>> {
    SDF_CACHE.get_or_init(|| Mutex::new(None))
}

fn sdf_pool() -> &'static ThreadPool {
    SDF_POOL.get_or_init(|| {
        let hw_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1);
        let default_threads = hw_threads.saturating_sub(2).clamp(1, 2);
        let threads = std::env::var("DF_SDF_THREADS")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .filter(|&value| value > 0)
            .unwrap_or(default_threads)
            .clamp(1, hw_threads);

        log::info!(
            "sdf: using dedicated rayon pool with {} thread(s) (hardware={})",
            threads,
            hw_threads,
        );

        ThreadPoolBuilder::new()
            .thread_name(|i| format!("dragonfruit-sdf-{i}"))
            .num_threads(threads)
            .build()
            .expect("failed to create sdf rayon thread pool")
    })
}

/// Compute a signed distance field from the current staged mesh.
///
/// The result is a raw binary blob in the `SparseSdfGrid` wire format.
/// The frontend is responsible for deserialising it into the `SDFCache`.
///
/// If the staged mesh hasn't changed since the last call, the cached grid
/// is returned immediately (no recomputation).
#[tauri::command]
pub async fn compute_sdf_from_staged(
    cell_size: Option<f32>,
    shell_thickness: Option<f32>,
) -> Result<Response, String> {
    // Read current mesh stats for cache key
    let current_stats = staged_mesh_stats()
        .lock()
        .map_err(|e| format!("staged mesh stats lock poisoned: {e}"))?
        .clone();

    // Check cache
    {
        let cache = sdf_cache()
            .lock()
            .map_err(|e| format!("sdf cache lock poisoned: {e}"))?;
        if let Some((ref cached_stats, ref cached_grid)) = *cache {
            if *cached_stats == current_stats {
                log::info!(
                    "sdf: cache hit — {} cells, cell_size={}",
                    cached_grid.len(),
                    cached_grid.cell_size
                );
                return Ok(Response::new(cached_grid.to_bytes()));
            }
        }
    }

    // Read the staged mesh bytes
    let bytes = {
        staged_mesh()
            .lock()
            .map_err(|e| format!("staged mesh lock poisoned: {e}"))?
            .clone()
            .ok_or_else(|| "no staged mesh available".to_string())?
    };

    let options = SdfOptions {
        cell_size: cell_size.unwrap_or(0.5),
        shell_thickness: shell_thickness.unwrap_or(8.0),
        ..SdfOptions::default()
    };

    log::info!(
        "sdf: computing (cell_size={}, shell={}, inner={}, coarse={})...",
        options.cell_size,
        options.shell_thickness,
        options.inner_shell,
        options.coarse_factor,
    );

    let grid = tauri::async_runtime::spawn_blocking(move || {
        // Parse the staged positions into our lightweight mesh format.
        // The staging buffer is f32 LE, 9 per triangle (raw soup).
        let floats: &[f32] =
            bytemuck::try_cast_slice(&bytes).map_err(|e| format!("staged positions cast: {e}"))?;
        if floats.len() % 9 != 0 {
            return Err(format!(
                "staged positions not a multiple of 9 floats: {}",
                floats.len()
            ));
        }
        let tri_count = floats.len() / 9;

        let mesh = SdfMeshInput {
            positions: floats.to_vec(),
            triangles: (0..tri_count as u32)
                .map(|i| [i * 3, i * 3 + 1, i * 3 + 2])
                .collect(),
        };

        Ok::<_, String>(sdf_pool().install(|| compute_sdf_grid(&mesh, &options)))
    })
    .await
    .map_err(|e| format!("sdf task panicked: {e}"))??;

    log::info!(
        "sdf: computed {} cells in model-local space (cell_size={}mm)",
        grid.len(),
        grid.cell_size,
    );

    let blob = grid.to_bytes();

    // Update cache
    {
        let mut cache = sdf_cache()
            .lock()
            .map_err(|e| format!("sdf cache lock poisoned: {e}"))?;
        *cache = Some((current_stats, grid));
    }

    Ok(Response::new(blob))
}

/// Invalidate the SDF cache (e.g. after model repair or replacement).
#[tauri::command]
pub fn invalidate_sdf_cache() -> Result<(), String> {
    let mut cache = sdf_cache()
        .lock()
        .map_err(|e| format!("sdf cache lock poisoned: {e}"))?;
    *cache = None;
    log::info!("sdf: cache invalidated");
    Ok(())
}

/// Compute a clearance heightmap from the cached SDF grid.
///
/// The heightmap is a 2D grid of per-XY highest-blocked Z values.  The A*
/// pathfinder uses it as a tight admissible heuristic and for O(1)
/// straight-descent viability checks.
///
/// Requires that `compute_sdf_from_staged` has been called first (the
/// SDF grid must be cached).  Returns a raw binary blob in the
/// `ClearanceHeightmap` wire format.
#[tauri::command]
pub async fn compute_heightmap_from_staged(clearance: Option<f32>) -> Result<Response, String> {
    let sdf = {
        let cache = sdf_cache()
            .lock()
            .map_err(|e| format!("sdf cache lock poisoned: {e}"))?;
        cache
            .as_ref()
            .map(|(_, grid)| grid.clone())
            .ok_or_else(|| "no cached SDF grid — call compute_sdf_from_staged first".to_string())?
    };

    let clearance = clearance.unwrap_or(0.48);

    log::info!(
        "heightmap: computing from {} SDF cells (clearance={}mm)...",
        sdf.len(),
        clearance,
    );

    let heightmap = tauri::async_runtime::spawn_blocking(move || {
        sdf_pool().install(|| compute_heightmap(&sdf, clearance, None))
    })
    .await
    .map_err(|e| format!("heightmap task panicked: {e}"))?;

    log::info!(
        "heightmap: computed {}×{} grid ({:.1} KB)",
        heightmap.width,
        heightmap.height,
        heightmap.len() as f64 * 4.0 / 1024.0,
    );

    Ok(Response::new(heightmap.to_bytes()))
}
