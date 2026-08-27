//! # tauri-plugin-macos-fps
//!
//! Unlock >60fps rendering on macOS for Tauri v2 apps.
//!
//! WKWebView caps `requestAnimationFrame` at 60fps regardless of display refresh rate.
//! This plugin disables that cap by toggling WebKit's internal
//! `PreferPageRenderingUpdatesNear60FPSEnabled` preference via the private `_features` API.
//!
//! On non-macOS platforms, the plugin is a no-op.
//!
//! ## Quick start
//!
//! ```rust,ignore
//! fn main() {
//!     tauri::Builder::default()
//!         .plugin(tauri_plugin_macos_fps::init())
//!         .run(tauri::generate_context!())
//!         .expect("error while running tauri application");
//! }
//! ```
//!
//! ## Manual per-webview control
//!
//! ```rust,ignore
//! use tauri_plugin_macos_fps::MacFpsExt;
//!
//! // Unlock native refresh rate for a specific webview:
//! webview.unlock_fps()?;
//!
//! // Re-lock to 60fps:
//! webview.lock_fps()?;
//! ```

use serde::Deserialize;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Webview, Wry,
};

#[cfg(target_os = "macos")]
mod macos;

// ── Configuration ──────────────────────────────────────────────

fn default_enabled() -> bool {
    true
}

/// Plugin configuration. Set in `tauri.conf.json` under `plugins.macos-fps`:
///
/// ```json
/// {
///   "plugins": {
///     "macos-fps": {
///       "enabled": true
///     }
///   }
/// }
/// ```
#[derive(Debug, Deserialize)]
pub struct Config {
    /// Whether to automatically unlock the display's native refresh rate on all webviews.
    /// Defaults to `true`.
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { enabled: true }
    }
}

struct PluginState {
    enabled: bool,
}

// ── Extension trait ────────────────────────────────────────────

/// Extension trait for manual per-webview control of the frame rate cap.
pub trait MacFpsExt {
    /// Disable the 60fps cap on this webview, enabling the display's native refresh rate.
    ///
    /// On non-macOS platforms, this is a no-op.
    fn unlock_fps(&self) -> tauri::Result<()>;

    /// Re-enable the 60fps cap on this webview.
    ///
    /// On non-macOS platforms, this is a no-op.
    fn lock_fps(&self) -> tauri::Result<()>;
}

impl MacFpsExt for Webview<Wry> {
    fn unlock_fps(&self) -> tauri::Result<()> {
        #[cfg(target_os = "macos")]
        {
            self.with_webview(|webview| {
                let ptr = webview.inner();
                if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                    macos::disable_60fps_cap(ptr);
                })) {
                    log::error!("tauri-plugin-macos-fps: panic in unlock_fps: {:?}", e);
                }
            })?;
        }
        Ok(())
    }

    fn lock_fps(&self) -> tauri::Result<()> {
        #[cfg(target_os = "macos")]
        {
            self.with_webview(|webview| {
                let ptr = webview.inner();
                if let Err(e) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                    macos::enable_60fps_cap(ptr);
                })) {
                    log::error!("tauri-plugin-macos-fps: panic in lock_fps: {:?}", e);
                }
            })?;
        }
        Ok(())
    }
}

// ── Plugin initializer ────────────────────────────────────────

/// Initialize the plugin.
///
/// When registered, automatically disables the 60fps cap on every webview
/// as it is created (unless `enabled: false` in config).
///
/// ```rust,ignore
/// tauri::Builder::default()
///     .plugin(tauri_plugin_macos_fps::init())
///     .run(tauri::generate_context!())
///     .expect("error while running tauri application");
/// ```
pub fn init() -> TauriPlugin<Wry, Config> {
    Builder::<Wry, Config>::new("macos-fps")
        .setup(|app, api| {
            let enabled = api.config().enabled;
            if !enabled {
                log::info!("tauri-plugin-macos-fps: disabled via configuration");
            }
            app.manage(PluginState { enabled });
            Ok(())
        })
        .on_webview_ready(|webview| {
            let enabled = webview
                .try_state::<PluginState>()
                .map(|s| s.enabled)
                .unwrap_or(true);

            if !enabled {
                return;
            }

            #[cfg(target_os = "macos")]
            {
                let _ = webview.with_webview(|wv| {
                    let ptr = wv.inner();
                    if let Err(e) =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                            macos::disable_60fps_cap(ptr);
                        }))
                    {
                        log::error!(
                            "tauri-plugin-macos-fps: panic in on_webview_ready: {:?}",
                            e
                        );
                    }
                });
            }

            #[cfg(not(target_os = "macos"))]
            {
                let _ = webview;
            }
        })
        .build()
}
