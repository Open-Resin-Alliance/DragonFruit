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

use log::{info, warn};
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

// Unused on Linux, where the check is skipped entirely (see `check_updates`).
#[cfg(not(target_os = "linux"))]
const STABLE_ENDPOINT: &str =
    "https://open-resin-alliance.github.io/DragonFruit/latest.json";
#[cfg(not(target_os = "linux"))]
const DEV_ENDPOINT: &str =
    "https://open-resin-alliance.github.io/DragonFruit/latest-dev.json";

#[cfg(not(target_os = "linux"))]
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
    allow_same_version: Option<bool>,
    #[allow(non_snake_case)] allowSameVersion: Option<bool>,
) -> Result<Option<UpdateCheckResult>, String> {
    let allow_same_version = allow_same_version.or(allowSameVersion);
    // Linux ships only as a Flatpak bundle, so the updater feed has no
    // `linux-x86_64` key — and even with one, the plugin cannot install over a
    // running sandboxed app (`/app` is read-only). Flatpak updates come from
    // the remote. Skip the check instead of letting it fail with a warning
    // that reads as a broken updater.
    #[cfg(target_os = "linux")]
    {
        let _ = (app_handle, channel, allow_same_version, allowSameVersion);
        info!("[updater] Linux build is distributed as a Flatpak — skipping the update check");
        Ok(None)
    }

    #[cfg(not(target_os = "linux"))]
    check_updates_impl(app_handle, channel, allow_same_version.unwrap_or(false)).await
}

#[cfg(not(target_os = "linux"))]
async fn check_updates_impl(
    app_handle: UpdaterAppHandle,
    channel: Option<String>,
    allow_same_version: bool,
) -> Result<Option<UpdateCheckResult>, String> {
    let channel = channel.as_deref().unwrap_or("stable");
    let endpoint_str = endpoint_for_channel(channel);

    info!("[updater] check_updates called — channel={channel} endpoint={endpoint_str} allow_same_version={allow_same_version}");

    let endpoint_url: url::Url = endpoint_str
        .parse()
        .map_err(|e: url::ParseError| format!("Invalid endpoint URL: {e}"))?;

    use tauri_plugin_updater::UpdaterExt;

    // PRESERVED (Cross-Platform Compatibility):
    // #[allow(unused_mut)]: `builder` is mutated on macOS (`#[cfg(target_os = "macos")] builder = builder.target("darwin-universal");`).
    // Kept mutable for macOS universal binary auto-updater targeting.
    #[allow(unused_mut)]
    let mut builder = app_handle
        .updater_builder()
        .endpoints(vec![endpoint_url])
        .map_err(|e| {
            warn!("[updater] Failed to set updater endpoints: {e}");
            format!("Failed to set updater endpoints: {e}")
        })?;

    // We ship a single universal macOS binary, so the plugin's default
    // arch-sniffing ("darwin-aarch64"/"darwin-x86_64") never matches the
    // "darwin-universal" key in the updater feed — force it explicitly.
    #[cfg(target_os = "macos")]
    {
        builder = builder.target("darwin-universal");
    }

    // Debug: allow same-version reinstall (0.1.15 -> 0.1.15) via Ctrl+Shift+U in Updates.
    // The default comparator treats equal as NotGreater, so same version is "no update".
    // When allow_same_version, treat >= as available so the current version's installer
    // is returned as an available update for in-place reinstall testing.
    if allow_same_version {
        builder = builder.version_comparator(|current, remote: tauri_plugin_updater::RemoteRelease| {
            remote.version >= current
        });
    }

    let updater = builder.build().map_err(|e| {
        warn!("[updater] Failed to build updater: {e}");
        format!("Failed to build updater: {e}")
    })?;

    let update = updater
        .check()
        .await
        .map_err(|e| {
            warn!("[updater] Update check failed: {e}");
            format!("Update check failed: {e}")
        })?;

    match update {
        Some(update) => {
            // Cache the full Update object so perform_update can use it.
            let version = update.version.clone();
            let current_version = update.current_version.clone();
            let mut body = update.body.clone();
            // If same-version reinstall has no body (feed has no notes or empty), fetch from GitHub release for changelog
            if body.as_ref().map_or(true, |b| b.trim().is_empty()) && allow_same_version {
                let tag = version.to_string();
                let gh_url = format!("https://api.github.com/repos/Open-Resin-Alliance/DragonFruit/releases/tags/v{tag}");
                if let Ok(client) = reqwest::Client::builder().user_agent("DragonFruit-updater").build() {
                    if let Ok(resp) = client.get(&gh_url).send().await {
                        if let Ok(json) = resp.json::<serde_json::Value>().await {
                            if let Some(b) = json.get("body").and_then(|v| v.as_str()) {
                                if !b.trim().is_empty() {
                                    body = Some(b.to_string());
                                }
                            }
                            if let Some(_pub_at) = json.get("published_at").and_then(|v| v.as_str()) {
                                // Try to keep date from GitHub if updater date is None (currently unused — updater provides date)
                            }
                        }
                    }
                }
            }
            // RFC 3339, not Display: `time` renders as "2026-07-06 4:55:17.703
            // +00:00:00", which `new Date()` on the frontend cannot parse.
            let date = update
                .date
                .and_then(|d| d.format(&time::format_description::well_known::Rfc3339).ok());
            let download_url = Some(update.download_url.to_string());

            info!("[updater] Update available: current={current_version} → new={version} url={} body_len={}", download_url.as_deref().unwrap_or("?"), body.as_ref().map(|b| b.len()).unwrap_or(0));

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
        None => {
            if allow_same_version {
                // No newer version, but debug wants in-place reinstall of current version.
                // Fabricate an available update with version == currentVersion using real release notes.
                let current_version = app_handle.package_info().version.to_string();
                let version = current_version.clone();
                // Try to get real body/date from the current version's GitHub release via the updater's
                // endpoint for the current version's tag. Fallback to minimal body if fetch fails.
                let (body, date, download_url) = {
                    // Re-use the same feed endpoint but ensure allow_same_version path via dbg_builder
                    // (the primary check already used allow_same_version, but if it still returned None due to transient, retry explicitly)
                    let feed_url: Result<url::Url, _> = endpoint_str.parse();
                    if let Ok(url) = feed_url {
                        if let Ok(mut dbg_builder) = app_handle.updater_builder().endpoints(vec![url]) {
                            #[cfg(target_os = "macos")]
                            {
                                dbg_builder = dbg_builder.target("darwin-universal");
                            }
                            dbg_builder = dbg_builder.version_comparator(|cur, rem: tauri_plugin_updater::RemoteRelease| rem.version >= cur);
                            if let Ok(updater) = dbg_builder.build() {
                                if let Ok(Some(dbg_update)) = updater.check().await {
                                    let body = dbg_update.body.clone();
                                    let date = dbg_update.date.and_then(|d| d.format(&time::format_description::well_known::Rfc3339).ok());
                                    let dl = Some(dbg_update.download_url.to_string());
                                    if let Ok(mut cache) = cached_update().lock() {
                                        *cache = Some(dbg_update);
                                    }
                                    return Ok(Some(UpdateCheckResult {
                                        update_available: true,
                                        version: version.clone(),
                                        current_version: current_version.clone(),
                                        body,
                                        date,
                                        download_url: dl,
                                    }));
                                }
                            }
                        }
                    }
                    // Final fallback: fabricated without download URL
                    (None, None, None)
                };
                info!("[updater] Debug same-version reinstall fabricated: current={current_version} → new={version}");
                return Ok(Some(UpdateCheckResult {
                    update_available: true,
                    version,
                    current_version,
                    body,
                    date,
                    download_url,
                }));
            }
            info!("[updater] No update available on channel={channel}");
            Ok(None)
        }
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
        warn!("[updater] perform_update called with no cached update");
        return Err("No cached update. Call check_updates first.".into());
    };

    info!(
        "[updater] perform_update starting: version={} url={}",
        update.version, update.download_url
    );

    // Emit a Started progress event.
    let _ = on_chunk.send(PerformUpdateProgress {
        downloaded_bytes: 0,
        total_bytes: None,
        phase: "downloading".into(),
    });

    // The plugin reports the length of each chunk, not the running total.
    let downloaded = std::sync::atomic::AtomicU64::new(0);

    // The plugin's Update::download_and_install handles the whole flow:
    // download → verify signature → launch installer → exit app.
    update
        .download_and_install(
            |chunk_len, total_len| {
                let total = downloaded
                    .fetch_add(chunk_len as u64, std::sync::atomic::Ordering::Relaxed)
                    + chunk_len as u64;
                let _ = on_chunk.send(PerformUpdateProgress {
                    downloaded_bytes: total,
                    total_bytes: total_len,
                    phase: "downloading".into(),
                });
            },
            || {
                info!("[updater] download complete — installing");
                let _ = on_chunk.send(PerformUpdateProgress {
                    downloaded_bytes: 0,
                    total_bytes: None,
                    phase: "installing".into(),
                });
            },
        )
        .await
        .map_err(|e| {
            warn!("[updater] download_and_install failed: {e}");
            format!("Update failed: {e}")
        })?;

    info!("[updater] update installed successfully");
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

    let channel = match path {
        Ok(p) if p.exists() => std::fs::read_to_string(&p)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| s == "stable" || s == "dev")
            .unwrap_or_else(|| "stable".to_string()),
        _ => "stable".to_string(),
    };
    info!("[updater] get_saved_update_channel → {channel}");
    channel
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
