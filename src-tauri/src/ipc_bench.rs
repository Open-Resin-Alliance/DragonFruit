//! Commands that do (almost) nothing, so the frontend can time the IPC bridge
//! itself. See `src/utils/debug/ipcBench.ts` for the driver and #753 for why.
//!
//! The handlers stamp the wall clock on arrival so the driver can split a round
//! trip into its request and response legs. Both sides read the same OS clock;
//! the driver estimates the residual offset from tiny calls before trusting it.

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::ipc::{InvokeBody, Request, Response};

fn unix_us() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1e6)
        .unwrap_or(0.0)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcBenchSinkAck {
    /// Wall clock when the handler started running, in µs since the epoch.
    arrived_unix_us: f64,
    bytes: usize,
    /// `"raw"` or `"json"`: which path the body actually took.
    body_kind: &'static str,
    /// Time spent inside the handler, so the driver can exclude it.
    handler_ns: u64,
}

/// Receives a body and reports how it arrived. Touches every byte once so the
/// copy into this process cannot be optimised away or deferred.
#[tauri::command]
pub async fn ipc_bench_sink(request: Request<'_>) -> Result<IpcBenchSinkAck, String> {
    let arrived_unix_us = unix_us();
    let start = Instant::now();
    let (bytes, body_kind, checksum) = match request.body() {
        InvokeBody::Raw(b) => (b.len(), "raw", b.iter().fold(0u8, |a, &x| a ^ x)),
        InvokeBody::Json(v) => (v.to_string().len(), "json", 0),
    };
    std::hint::black_box(checksum);
    Ok(IpcBenchSinkAck {
        arrived_unix_us,
        bytes,
        body_kind,
        handler_ns: start.elapsed().as_nanos().min(u64::MAX as u128) as u64,
    })
}

/// Returns `bytes` raw bytes, for timing the Rust → JS direction.
#[tauri::command]
pub async fn ipc_bench_source(bytes: usize) -> Result<Response, String> {
    const MAX: usize = 512 << 20;
    if bytes > MAX {
        return Err(format!(
            "ipc_bench_source: {bytes} bytes exceeds the {MAX}-byte cap"
        ));
    }
    Ok(Response::new(vec![0xA5u8; bytes]))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IpcBenchEnv {
    debug_assertions: bool,
    runtime: &'static str,
    os: &'static str,
    arch: &'static str,
    tauri_version: &'static str,
}

/// What the numbers were measured on. A debug build is not representative.
#[tauri::command]
pub fn ipc_bench_env() -> IpcBenchEnv {
    IpcBenchEnv {
        debug_assertions: cfg!(debug_assertions),
        runtime: if cfg!(feature = "tauri-cef") {
            "cef"
        } else {
            "wry"
        },
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        tauri_version: tauri::VERSION,
    }
}
