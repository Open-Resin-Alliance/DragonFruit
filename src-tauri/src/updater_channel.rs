//! Channel-aware update checker using the official Tauri updater plugin's
//! Rust API directly.  This lets us choose the GitHub Releases endpoint at
//! runtime based on the user's release channel preference (stable vs dev).
//!
//! The flow:
//!  1. Frontend calls `check_updates(channel)` → returns `UpdateCheckResult`.
//!  2. If an update is available, the `Update` object is cached in a static.
//!  3. Frontend calls `perform_update()` → downloads & installs the cached
//!     update (signature verification, installer launch, app exit — the
//!     plugin handles everything).

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::OnceLock;
use tauri::Manager;

// ---------------------------------------------------------------------------
// Runtime type aliases — match main.rs
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-cef")]
type UpdaterAppHandle = tauri::AppHandle<tauri::Cef>;
#[cfg(not(feature = "tauri-cef"))]
type UpdaterAppHandle = tauri::AppHandle<tauri::Wry>;

// ---------------------------------------------------------------------------
// Types exposed to the frontend
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
    pub download_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Static: cached `Update` from the plugin's check
// ---------------------------------------------------------------------------

static CACHED_UPDATE: OnceLock<Mutex<Option<tauri_plugin_updater::Update>>> = OnceLock::new();

fn cached_update() -> &'static Mutex<Option<tauri_plugin_updater::Update>> {
    CACHED_UPDATE.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// Endpoint URLs per channel
// ---------------------------------------------------------------------------

const STABLE_ENDPOINT: &str =
    "https://github.com/Open-Resin-Alliance/DragonFruit/releases/latest/download/latest.json";
const DEV_ENDPOINT: &str =
    "https://github.com/Open-Resin-Alliance/DragonFruit/releases/latest/download/latest-dev.json";

fn endpoint_for_channel(channel: &str) -> &'static str {
    match channel {
        "dev" | "prerelease" => DEV_ENDPOINT,
        _ => STABLE_ENDPOINT,
    }
}

// ---------------------------------------------------------------------------
// Tauri command: check_updates
// ---------------------------------------------------------------------------

/// Check for updates using the given release channel.
/// Returns `null` (None) if no update is available.
#[tauri::command]
pub async fn check_updates(
    app_handle: UpdaterAppHandle,
    channel: Option<String>,
) -> Result<Option<UpdateCheckResult>, String> {
    let channel = channel.as_deref().unwrap_or("stable");
    let endpoint_str = endpoint_for_channel(channel);

    let endpoint_url: url::Url = endpoint_str
        .parse()
        .map_err(|e: url::ParseError| format!("Invalid endpoint URL: {e}"))?;

    use tauri_plugin_updater::UpdaterExt;

    let updater = app_handle
        .updater_builder()
        .endpoints(vec![endpoint_url])
        .map_err(|e| format!("Failed to set updater endpoints: {e}"))?
        .build()
        .map_err(|e| format!("Failed to build updater: {e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?;

    match update {
        Some(update) => {
            // Cache the full Update object so perform_update can use it.
            let version = update.version.clone();
            let current_version = update.current_version.clone();
            let body = update.body.clone();
            let date = update.date.map(|d| d.to_string());
            let download_url = Some(update.download_url.to_string());

            let mut cache = cached_update()
                .lock()
                .map_err(|e| format!("Cache lock poisoned: {e}"))?;
            *cache = Some(update);

            Ok(Some(UpdateCheckResult {
                update_available: true,
                version,
                current_version,
                body,
                date,
                download_url,
            }))
        }
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------
// Tauri command: perform_update
// ---------------------------------------------------------------------------

/// Download and install the cached update. The plugin handles signature
/// verification, installer launch, and app exit.
#[tauri::command]
pub async fn perform_update(
    on_chunk: tauri::ipc::Channel<PerformUpdateProgress>,
) -> Result<String, String> {
    let update = {
        let mut cache = cached_update()
            .lock()
            .map_err(|e| format!("Cache lock poisoned: {e}"))?;
        cache.take()
    };

    let Some(update) = update else {
        return Err("No cached update. Call check_updates first.".into());
    };

    // Emit a Started progress event.
    let _ = on_chunk.send(PerformUpdateProgress {
        downloaded_bytes: 0,
        total_bytes: None,
        phase: "downloading".into(),
    });

    // The plugin's Update::download_and_install handles the whole flow:
    // download → verify signature → launch installer → exit app.
    update
        .download_and_install(
            |chunk_len, total_len| {
                let _ = on_chunk.send(PerformUpdateProgress {
                    downloaded_bytes: chunk_len as u64,
                    total_bytes: total_len,
                    phase: "downloading".into(),
                });
            },
            || {
                let _ = on_chunk.send(PerformUpdateProgress {
                    downloaded_bytes: 0,
                    total_bytes: None,
                    phase: "installing".into(),
                });
            },
        )
        .await
        .map_err(|e| format!("Update failed: {e}"))?;

    Ok("Update installed successfully".into())
}

// ---------------------------------------------------------------------------
// Helper types for progress reporting
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformUpdateProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub phase: String,
}

// ---------------------------------------------------------------------------
// Tauri command: get_update_channel
// ---------------------------------------------------------------------------

/// Return the saved channel preference from app data dir or default to "stable".
#[tauri::command]
pub fn get_saved_update_channel(app_handle: UpdaterAppHandle) -> String {
    let path = app_handle
        .path()
        .app_data_dir()
        .map(|p| p.join("update-channel.txt"));

    match path {
        Ok(p) if p.exists() => std::fs::read_to_string(&p)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s == "stable" || s == "dev")
            .unwrap_or_else(|| "stable".to_string()),
        _ => "stable".to_string(),
    }
}

/// Save the channel preference to app data dir.
#[tauri::command]
pub fn save_update_channel(app_handle: UpdaterAppHandle, channel: String) -> Result<(), String> {
    let valid = channel == "stable" || channel == "dev";
    if !valid {
        return Err(format!(
            "Invalid channel '{channel}'. Must be 'stable' or 'dev'."
        ));
    }

    let path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {e}"))?
        .join("update-channel.txt");

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create app data dir: {e}"))?;
    }

    std::fs::write(&path, &channel)
        .map_err(|e| format!("Failed to write channel preference: {e}"))?;

    Ok(())
}
