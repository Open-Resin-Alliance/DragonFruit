//! Persists the main window's size, position and maximized flag across
//! launches. Hand-rolled instead of `tauri-plugin-window-state` because the
//! pinned tauri fork (feat/cef) makes external plugin resolution fragile —
//! see the dependency comments in Cargo.toml.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};

const STATE_FILE: &str = "window-state.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub maximized: bool,
}

/// Last known geometry of the main window, refreshed from window events.
/// Kept in memory (not written per-event) and flushed to disk on close/exit.
/// Geometry is only overwritten while the window is in the normal state, so
/// the pre-maximize size survives (a maximized window reports the full work
/// area as its size).
#[derive(Default)]
pub struct WindowStateTracker(Mutex<Option<WindowState>>);

fn state_file_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(STATE_FILE))
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Option<WindowState> {
    let raw = std::fs::read_to_string(state_file_path(app)?).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Applies saved geometry to the freshly created (still hidden) window.
/// The saved position is ignored when it no longer intersects any monitor,
/// e.g. after unplugging an external display.
pub fn restore<R: Runtime>(window: &WebviewWindow<R>, state: &WindowState) {
    let position_on_screen = window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|monitor| {
                let mon_pos = monitor.position();
                let mon_size = monitor.size();
                let overlaps_x = state.x + (state.width as i32) > mon_pos.x
                    && state.x < mon_pos.x + mon_size.width as i32;
                let overlaps_y =
                    state.y >= mon_pos.y - 8 && state.y < mon_pos.y + mon_size.height as i32;
                overlaps_x && overlaps_y
            })
        })
        .unwrap_or(false);

    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    if position_on_screen {
        let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
    } else {
        let _ = window.center();
    }
    if state.maximized {
        let _ = window.maximize();
    }
}

/// Subscribes to the window's move/resize/close events to keep the tracker
/// current and flush it to disk when the window closes.
pub fn track<R: Runtime>(window: &WebviewWindow<R>) {
    let app = window.app_handle().clone();
    let tracked = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
            update_tracker(&app, &tracked);
        }
        tauri::WindowEvent::CloseRequested { .. } => save(&app),
        _ => {}
    });
    // Seed the tracker so an exit without any move/resize still persists state.
    // Dispatched onto the main thread rather than called inline: `track()` runs
    // during startup from a background thread (main window creation is deferred
    // off-thread, see main.rs), and `update_tracker` locks the tracker mutex
    // before making a synchronous cross-thread query for the window's geometry.
    // If the main thread was concurrently handling a Resized/Moved event for
    // this same window via the handler above — which the `restore()` call just
    // before `track()` reliably triggers — it would block on that same mutex,
    // while this thread blocks waiting for the main thread: a deadlock that
    // hung the app on every launch.
    let app = window.app_handle().clone();
    let seed_window = window.clone();
    let _ = window.run_on_main_thread(move || update_tracker(&app, &seed_window));
}

fn update_tracker<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let Some(tracker) = app.try_state::<WindowStateTracker>() else {
        return;
    };
    let Ok(mut guard) = tracker.0.lock() else {
        return;
    };

    if window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    if (maximized || window.is_fullscreen().unwrap_or(false)) && guard.is_some() {
        // Keep the last normal-state geometry; only record the flag.
        if let Some(state) = guard.as_mut() {
            state.maximized = maximized;
        }
        return;
    }

    let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) else {
        return;
    };
    if size.width == 0 || size.height == 0 {
        return;
    }
    *guard = Some(WindowState {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
        maximized,
    });
}

/// Writes the tracked state to disk. Called on window close and app exit.
pub fn save<R: Runtime>(app: &AppHandle<R>) {
    let Some(tracker) = app.try_state::<WindowStateTracker>() else {
        return;
    };
    let Some(state) = tracker.0.lock().ok().and_then(|guard| *guard) else {
        return;
    };
    let Some(path) = state_file_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(&state) {
        Ok(json) => {
            if let Err(error) = std::fs::write(&path, json) {
                log::warn!("[window-state] Failed to write {}: {error}", path.display());
            }
        }
        Err(error) => log::warn!("[window-state] Failed to serialize state: {error}"),
    }
}
