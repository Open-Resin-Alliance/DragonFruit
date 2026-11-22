//! spacenavd client (Linux).
//!
//! navlib does not exist on Linux; the driver there is spacenavd, which owns the
//! HID device (by default it grabs it, so the webview's Gamepad API never sees the
//! puck) and serves it to clients over a UNIX socket. This module is a minimal
//! client for that socket: fixed 32-byte packets of eight native-endian `i32`s.
//!
//! It does not compute camera motion. It republishes the six axes in the HID
//! layout a Gamepad-API pad reports, so `SpaceMouseController` drives the camera
//! with its own pivot, tuning and inversion settings, exactly as it does for a
//! pad the browser found itself.
//!
//! It asks for spacenavd's *raw* axis and button events (protocol v1, spacenavd
//! 1.0+), not the processed motion events. Processed motion has the user's
//! `spnavrc` applied (axis swaps, inversions, sensitivity), which is set up for
//! other applications and would scramble the axes here; DragonFruit has its own
//! per-axis tuning, the same on every platform.

use std::io::{BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// spacenavd's default socket; `/var/run` is the pre-systemd spelling.
const SOCKET_PATHS: [&str; 2] = ["/run/spnav.sock", "/var/run/spnav.sock"];
/// Event carrying a [`SpnavState`] to the webview on every change.
const SPNAV_EVENT: &str = "spacemouse://spnav";
const RECONNECT_INTERVAL: Duration = Duration::from_secs(2);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(2);

// spacenavd `proto.h` / `client.h`.
const REQ_TAG: i32 = 0x7faa_0000;
const REQ_CHANGE_PROTO: i32 = 0x5500;
const REQ_SET_EVMASK: i32 = 0x1003;
const EVMASK_RAWAXIS: i32 = 0x10;
const EVMASK_RAWBUTTON: i32 = 0x20;
const UEV_RAWAXIS: i32 = 5;
const UEV_RAWBUTTON: i32 = 6;

/// spacenavd rescales every absolute axis from the device's evdev range to
/// ±500 (`DEF_MINVAL`/`DEF_MAXVAL` in its `dev_usb_linux.c`). The Gamepad API
/// normalises the same evdev range to ±1, so dividing by 500 gives exactly the
/// values a browser pad would, and the controller's tuning defaults and
/// deadzone mean the same thing on both paths.
const FULL_SCALE: f32 = 500.0;
const MAX_BUTTONS: usize = 32;

/// For each spacenavd axis, the HID axis it came from and the sign to undo.
///
/// spacenavd normalises every known device to one Y-up frame before anything
/// else, raw events included: modern USB pucks get Y/Z (and RY/RZ) swapped and
/// negated (`DF_SWAPYZ | DF_INVYZ` in its device table). Undoing that yields the
/// HID order a browser pad reports: TX, TY (fore/aft), TZ (up/down), RX, RY,
/// RZ (twist).
const HID_FROM_SPNAV: [(usize, f32); 6] = [
    (0, 1.0),
    (2, -1.0),
    (1, -1.0),
    (3, 1.0),
    (5, -1.0),
    (4, -1.0),
];

/// Latest puck state, axes already in the Gamepad-API HID layout.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpnavState {
    pub connected: bool,
    pub axes: [f32; 6],
    pub buttons: Vec<bool>,
}

fn state() -> &'static Mutex<SpnavState> {
    static STATE: OnceLock<Mutex<SpnavState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(SpnavState::default()))
}

/// Apply one event packet. Returns whether the state changed.
fn apply_packet(state: &mut SpnavState, packet: &[i32; 8]) -> bool {
    match packet[0] {
        UEV_RAWAXIS => {
            let Some(&(hid, sign)) = usize::try_from(packet[1])
                .ok()
                .and_then(|i| HID_FROM_SPNAV.get(i))
            else {
                return false;
            };
            // `+ 0.0` turns -0.0 into 0.0.
            let value = (packet[2] as f32 / FULL_SCALE).clamp(-1.0, 1.0) * sign + 0.0;
            let changed = state.axes[hid] != value;
            state.axes[hid] = value;
            changed
        }
        UEV_RAWBUTTON => {
            let Ok(index) = usize::try_from(packet[1]) else {
                return false;
            };
            if index >= MAX_BUTTONS {
                return false;
            }
            if state.buttons.len() <= index {
                state.buttons.resize(index + 1, false);
            }
            let pressed = packet[2] != 0;
            let changed = state.buttons[index] != pressed;
            state.buttons[index] = pressed;
            changed
        }
        // Includes the reply to REQ_SET_EVMASK, whose type carries REQ_TAG.
        _ => false,
    }
}

fn write_i32s(stream: &mut UnixStream, words: &[i32]) -> std::io::Result<()> {
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_ne_bytes()).collect();
    stream.write_all(&bytes)
}

/// Switch the connection to protocol v1 and subscribe to raw events only.
fn handshake(stream: &mut UnixStream) -> std::io::Result<bool> {
    let request = REQ_TAG | REQ_CHANGE_PROTO | 1;
    write_i32s(stream, &[request])?;
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    let mut reply = [0u8; 4];
    stream.read_exact(&mut reply)?;
    stream.set_read_timeout(None)?;
    if i32::from_ne_bytes(reply) != request {
        return Ok(false);
    }
    write_i32s(
        stream,
        &[
            REQ_TAG | REQ_SET_EVMASK,
            EVMASK_RAWAXIS | EVMASK_RAWBUTTON,
            0,
            0,
            0,
            0,
            0,
            0,
        ],
    )?;
    Ok(true)
}

fn connect() -> Option<UnixStream> {
    SOCKET_PATHS
        .iter()
        .find_map(|path| UnixStream::connect(path).ok())
}

fn publish<R: Runtime>(app: &AppHandle<R>, update: impl FnOnce(&mut SpnavState) -> bool) {
    let snapshot = {
        let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
        if !update(&mut guard) {
            return;
        }
        guard.clone()
    };
    let _ = app.emit(SPNAV_EVENT, snapshot);
}

fn run<R: Runtime>(app: AppHandle<R>) {
    let mut announced_missing = false;
    loop {
        let Some(mut stream) = connect() else {
            if !announced_missing {
                log::info!(
                    "[spacemouse] spacenavd socket not available; retrying in the background"
                );
                announced_missing = true;
            }
            std::thread::sleep(RECONNECT_INTERVAL);
            continue;
        };
        announced_missing = false;
        match handshake(&mut stream) {
            Ok(true) => {}
            Ok(false) | Err(_) => {
                // Pre-1.0 daemons speak v0 only; retrying would not change that.
                log::warn!("[spacemouse] spacenavd did not accept protocol v1 (spacenavd 1.0 or newer is required)");
                return;
            }
        }
        log::info!("[spacemouse] connected to spacenavd");
        publish(&app, |s| {
            *s = SpnavState {
                connected: true,
                ..SpnavState::default()
            };
            true
        });

        // A HID report arrives as one packet per axis; apply every packet that
        // is already buffered and emit once, not once per axis.
        let mut reader = BufReader::with_capacity(32 * 64, stream);
        let mut buf = [0u8; 32];
        let mut pending = false;
        while reader.read_exact(&mut buf).is_ok() {
            let mut packet = [0i32; 8];
            for (word, chunk) in packet.iter_mut().zip(buf.chunks_exact(4)) {
                *word = i32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            }
            let mut guard = state().lock().unwrap_or_else(|e| e.into_inner());
            pending |= apply_packet(&mut guard, &packet);
            drop(guard);
            if pending && reader.buffer().len() < buf.len() {
                publish(&app, |_| true);
                pending = false;
            }
        }

        // spacenavd stopped or restarted: a held axis must not keep driving.
        log::info!("[spacemouse] spacenavd connection closed");
        publish(&app, |s| {
            *s = SpnavState::default();
            true
        });
        std::thread::sleep(RECONNECT_INTERVAL);
    }
}

/// Start the background client once (idempotent) and return the current state.
pub fn start<R: Runtime>(app: AppHandle<R>) -> SpnavState {
    static STARTED: AtomicBool = AtomicBool::new(false);
    if !STARTED.swap(true, Ordering::SeqCst) {
        let spawned = std::thread::Builder::new()
            .name("spnav-client".into())
            .spawn(move || run(app));
        if let Err(error) = spawned {
            log::warn!("[spacemouse] failed to start the spacenavd client: {error}");
            STARTED.store(false, Ordering::SeqCst);
        }
    }
    state().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn axis(state: &mut SpnavState, idx: i32, value: i32) -> bool {
        apply_packet(state, &[UEV_RAWAXIS, idx, value, 0, 0, 0, 0, 0])
    }

    #[test]
    fn raw_axes_map_back_to_hid_order() {
        let mut s = SpnavState::default();
        // spacenavd frame: x right, y up, z = -fore/aft; rotations likewise.
        for (idx, value) in [500, 250, -500, 100, -50, 500].into_iter().enumerate() {
            axis(&mut s, idx as i32, value);
        }
        assert_eq!(s.axes, [1.0, 1.0, -0.5, 0.2, -1.0, 0.1]);
    }

    #[test]
    fn raw_axes_clamp_and_have_no_negative_zero() {
        let mut s = SpnavState::default();
        assert!(axis(&mut s, 3, -1000));
        assert_eq!(s.axes[3], -1.0);
        assert!(!axis(&mut s, 1, 0));
        assert!(s.axes[2].is_sign_positive());
    }

    #[test]
    fn unchanged_or_unknown_axes_report_no_change() {
        let mut s = SpnavState::default();
        assert!(axis(&mut s, 0, 500));
        assert!(!axis(&mut s, 0, 500));
        assert!(!axis(&mut s, 6, 350));
        assert!(!axis(&mut s, -1, 350));
    }

    #[test]
    fn raw_buttons_track_press_and_release() {
        let mut s = SpnavState::default();
        assert!(apply_packet(&mut s, &[UEV_RAWBUTTON, 1, 1, 0, 0, 0, 0, 0]));
        assert_eq!(s.buttons, vec![false, true]);
        assert!(apply_packet(&mut s, &[UEV_RAWBUTTON, 1, 0, 0, 0, 0, 0, 0]));
        assert_eq!(s.buttons, vec![false, false]);
        assert!(!apply_packet(
            &mut s,
            &[UEV_RAWBUTTON, -1, 1, 0, 0, 0, 0, 0]
        ));
        assert!(!apply_packet(
            &mut s,
            &[UEV_RAWBUTTON, 99, 1, 0, 0, 0, 0, 0]
        ));
    }

    #[test]
    fn evmask_reply_is_ignored() {
        let mut s = SpnavState::default();
        assert!(!apply_packet(
            &mut s,
            &[REQ_TAG | REQ_SET_EVMASK, 0x30, 0, 0, 0, 0, 0, 0]
        ));
    }
}
