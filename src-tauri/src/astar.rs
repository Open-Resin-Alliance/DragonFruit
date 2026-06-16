//! Tauri IPC surface for `dragonfruit-astar`.
//!
//! Commands:
//! - `run_astar_pathfinding` — run the Rust-native A* pathfinder using the
//!   cached SDF grid and heightmap.

use dragonfruit_astar::{run_astar, AStarRequest};
use tauri::ipc::Response;

use crate::sdf::sdf_cache;

/// Run the Rust-native 26-connected grid A* pathfinder.
///
/// Uses the pre-computed SDF grid (must be loaded via `compute_sdf_from_staged`
/// first).  Returns a binary blob with path waypoints and metadata.
///
/// Request format: JSON `AStarRequest`.
/// Response format: binary `AStarResult::to_bytes()`.
#[tauri::command]
pub async fn run_astar_pathfinding(
    request_json: String,
) -> Result<Response, String> {
    let request: AStarRequest = serde_json::from_str(&request_json)
        .map_err(|e| format!("invalid A* request JSON: {e}"))?;

    // Get the cached SDF grid
    let (sdf, heightmap) = {
        let cache = sdf_cache()
            .lock()
            .map_err(|e| format!("sdf cache lock poisoned: {e}"))?;
        let (_, grid) = cache
            .as_ref()
            .ok_or_else(|| "no cached SDF grid — call compute_sdf_from_staged first".to_string())?;
        // TODO: also retrieve heightmap from cache when available
        (grid.clone(), None::<dragonfruit_sdf::ClearanceHeightmap>)
    };

    let start = dragonfruit_astar::Vec3::new(
        request.start_x,
        request.start_y,
        request.start_z,
    );

    log::info!(
        "astar: running from ({:.1}, {:.1}, {:.1}) to z={:.1} (step={}mm, max_exp={})",
        start.x, start.y, start.z,
        request.goal_z,
        request.options.step_mm,
        request.options.max_expansions,
    );

    let result = tauri::async_runtime::spawn_blocking(move || {
        run_astar(
            &sdf,
            heightmap.as_ref(),
            start,
            request.goal_z,
            &request.options,
            None, // warm-start not yet implemented in IPC
            None,
            None,
        )
    })
    .await
    .map_err(|e| format!("astar task panicked: {e}"))?;

    log::info!(
        "astar: {} in {} expansions ({} waypoints)",
        if result.reached { "reached" } else if result.stagnated { "stagnated" } else { "exhausted" },
        result.expansions,
        result.path.len(),
    );

    Ok(Response::new(result.to_bytes()))
}
