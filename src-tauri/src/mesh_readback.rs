//! Bulk readback transport: a process-wide bounded arena plus the
//! `http://mesh.localhost/<id>` handler.
//!
//! A read command publishes its bytes and returns `{ id, byteLength }`. The
//! frontend fetches the id once and gets the body directly, which replaces the
//! channel path's `eval` + extra `invoke` and keeps the body out of JSON. The
//! id is consumed by the first successful fetch; a failed fetch is recovered by
//! invoking the read command again.

use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::http::{header, Request, Response, StatusCode};

#[path = "mesh_readback_arena.rs"]
mod arena;

/// Soft cap for everything waiting to be fetched. One oversized result is still
/// published alone rather than failing the read.
pub const READBACK_BUDGET_BYTES: usize = 256 * 1024 * 1024;
pub const READBACK_ENTRY_LIMIT: usize = 64;
pub const READBACK_TTL: Duration = Duration::from_secs(30);

static ARENA: LazyLock<Mutex<arena::ReadbackArena>> = LazyLock::new(|| {
    Mutex::new(arena::ReadbackArena::new(
        READBACK_BUDGET_BYTES,
        READBACK_ENTRY_LIMIT,
        READBACK_TTL,
    ))
});

/// What a read command returns instead of the body.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadbackRef {
    pub id: String,
    pub byte_length: u64,
}

/// Publish one readback body and return the handle the frontend fetches.
pub fn publish(bytes: Vec<u8>) -> ReadbackRef {
    let published = ARENA
        .lock()
        .expect("mesh readback arena poisoned")
        .publish(bytes, Instant::now());
    ReadbackRef { id: published.id, byte_length: published.byte_length }
}

/// Move one published body out of the arena. The id is consumed.
pub fn take(id: &str) -> Option<Vec<u8>> {
    ARENA.lock().ok()?.take(id, Instant::now())
}

fn with_cors(mut response: Response<Vec<u8>>) -> Response<Vec<u8>> {
    let headers = response.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, header::HeaderValue::from_static("*"));
    headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    response
}

/// `http://mesh.localhost/<id>` handler. The runtime registers custom protocols
/// under the app's HTTP scheme with a `{scheme}.localhost` domain, which is how
/// the page reaches this.
pub fn respond(request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() == tauri::http::Method::OPTIONS {
        return with_cors(
            Response::builder().status(StatusCode::NO_CONTENT).body(Vec::new())
                .expect("empty preflight response"),
        );
    }
    let id = request.uri().path().trim_start_matches('/');
    let Some(bytes) = take(id) else {
        return with_cors(
            Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new())
                .expect("empty miss response"),
        );
    };
    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(bytes)
        .expect("readback response");
    with_cors(response)
}
