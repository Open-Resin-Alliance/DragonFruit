//! Persists the main window's size, position and maximized flag across
//! launches. Hand-rolled instead of `tauri-plugin-window-state` because the
//! pinned tauri fork (feat/cef) makes external plugin resolution fragile —
//! see the dependency comments in Cargo.toml.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, Runtime, WebviewWindow,
};

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
///
/// The rect is fitted into a monitor's work area first. A height saved on a
/// taller screen, or with the taskbar hidden, otherwise reopens the window's
/// bottom edge behind the taskbar. A rect that already fits its work area is
/// restored untouched; one that touches no monitor at all is centred, e.g.
/// after unplugging an external display.
pub fn restore<R: Runtime>(window: &WebviewWindow<R>, state: &WindowState) {
    let monitors = window.available_monitors().unwrap_or_default();
    let work_areas: Vec<PhysicalRect<i32, u32>> =
        monitors.iter().map(|monitor| *monitor.work_area()).collect();
    if work_areas.iter().any(|work| rect_inside(state, work)) {
        apply_settled(window, state.width, state.height, state.x, state.y);
    } else {
        match work_areas
            .iter()
            .filter(|work| work.size.width > 0 && work.size.height > 0)
            .max_by_key(|work| overlap_area(state, work))
        {
            Some(work) if overlap_area(state, work) > 0 => {
                let (width, height, x, y) = fit_into(state, work);
                apply_settled(window, width, height, x, y);
            }
            _ => {
                let _ = window.set_size(PhysicalSize::new(state.width, state.height));
                let (width, height) = (state.width, state.height);
                let again = window.clone();
                let _ = window.run_on_main_thread(move || {
                    let _ = again.set_size(PhysicalSize::new(width, height));
                    let _ = again.center();
                });
            }
        }
    }

    if state.maximized {
        let _ = window.maximize();
    }
}

/// Applies the geometry twice, on purpose.
///
/// The main window is created undecorated, and tao's `set_inner_size` adds the
/// frame it measures to the requested client size. On a window whose decoration
/// state is still settling that measurement is the caption the window no longer
/// has, so a single call overshoots the client height by that caption (30 px on
/// Windows 11 at 96 DPI) and the bottom edge lands behind the taskbar. The first
/// call settles the state; the second, on the main thread, measures the real
/// frame and lands on the requested size.
fn apply_settled<R: Runtime>(window: &WebviewWindow<R>, width: u32, height: u32, x: i32, y: i32) {
    apply(window, width, height, x, y);
    let again = window.clone();
    let _ = window.run_on_main_thread(move || {
        apply(&again, width, height, x, y);
    });
}

fn apply<R: Runtime>(window: &WebviewWindow<R>, width: u32, height: u32, x: i32, y: i32) {
    let _ = window.set_size(PhysicalSize::new(width, height));
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// `u32` extents are widened to `i32` for the rect arithmetic; a value that
/// cannot fit an `i32` is clamped rather than wrapped.
fn extent(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

/// Whether the whole saved rect sits inside `work`.
fn rect_inside(state: &WindowState, work: &PhysicalRect<i32, u32>) -> bool {
    state.x >= work.position.x
        && state.y >= work.position.y
        && state.x.saturating_add(extent(state.width))
            <= work.position.x.saturating_add(extent(work.size.width))
        && state.y.saturating_add(extent(state.height))
            <= work.position.y.saturating_add(extent(work.size.height))
}

/// Area shared by the saved rect and `work`, in square pixels. Zero when they
/// do not touch.
fn overlap_area(state: &WindowState, work: &PhysicalRect<i32, u32>) -> u64 {
    let left = state.x.max(work.position.x);
    let top = state.y.max(work.position.y);
    let right = state
        .x
        .saturating_add(extent(state.width))
        .min(work.position.x.saturating_add(extent(work.size.width)));
    let bottom = state
        .y
        .saturating_add(extent(state.height))
        .min(work.position.y.saturating_add(extent(work.size.height)));
    if right <= left || bottom <= top {
        0
    } else {
        (right - left) as u64 * (bottom - top) as u64
    }
}

/// Shrinks a rect that is larger than `work` and nudges it back inside,
/// keeping its top-left corner whenever the size allows.
fn fit_into(state: &WindowState, work: &PhysicalRect<i32, u32>) -> (u32, u32, i32, i32) {
    let width = state.width.min(work.size.width);
    let height = state.height.min(work.size.height);
    let max_x = work.position.x + extent(work.size.width - width);
    let max_y = work.position.y + extent(work.size.height - height);
    (
        width,
        height,
        state.x.clamp(work.position.x, max_x),
        state.y.clamp(work.position.y, max_y),
    )
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The primary display this was reported on: 3440x1440 with a 48px taskbar.
    fn primary() -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(3440, 1392),
        }
    }

    fn state(width: u32, height: u32, x: i32, y: i32) -> WindowState {
        WindowState {
            width,
            height,
            x,
            y,
            maximized: false,
        }
    }

    #[test]
    fn a_rect_that_fits_is_left_alone() {
        let saved = state(1721, 1392, 0, 0);
        assert!(rect_inside(&saved, &primary()));
    }

    #[test]
    fn a_rect_taller_than_the_work_area_is_shrunk_to_it() {
        // The reported state: 1420 tall on a 1392 work area, so the bottom
        // edge sat behind the taskbar.
        let saved = state(1721, 1420, -7, 0);
        assert!(!rect_inside(&saved, &primary()));
        assert_eq!(fit_into(&saved, &primary()), (1721, 1392, 0, 0));
    }

    #[test]
    fn a_rect_hanging_off_the_bottom_is_pulled_up() {
        let work = primary();
        let saved = state(1200, 900, 100, 800);
        let (width, height, x, y) = fit_into(&saved, &work);
        assert_eq!((width, height), (1200, 900));
        assert_eq!((x, y), (100, 492));
        assert_eq!(y + height as i32, 1392);
    }

    #[test]
    fn a_rect_on_a_second_monitor_keeps_that_monitor() {
        let left = PhysicalRect {
            position: PhysicalPosition::new(-1920, 0),
            size: PhysicalSize::new(1920, 1080),
        };
        let saved = state(1600, 1200, -1800, 0);
        assert_eq!(fit_into(&saved, &left), (1600, 1080, -1800, 0));
    }

    #[test]
    fn a_rect_off_every_monitor_has_no_overlap() {
        let saved = state(800, 600, 9000, 9000);
        assert_eq!(overlap_area(&saved, &primary()), 0);
    }

    #[test]
    fn overlap_is_the_shared_area() {
        let saved = state(1000, 1000, 3000, 1000);
        assert_eq!(overlap_area(&saved, &primary()), 440 * 392);
    }
}
