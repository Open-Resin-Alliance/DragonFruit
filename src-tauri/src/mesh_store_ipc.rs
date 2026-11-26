//! The native mesh store's commands: put a mesh, read an entry's bytes back, drop ids, open a
//! client, and the counters. The store itself is `mesh_store.rs`;
//! `docs/dev/native-mesh-store.md` has the contract.

use tauri::ipc::{InvokeBody, Response};

use crate::mesh_store::{self, Entry, Owner, StoreStats};

/// The header that names the client a `mesh_store_put` stores for. A raw-body command cannot
/// take JSON arguments as well, so it rides in a header like `x-mesh-stage-path` does.
const CLIENT_ID_HEADER: &str = "x-mesh-client-id";

/// Stores a triangle soup sent as the raw request body (little-endian `f32`, nine per
/// triangle) and returns its id.
#[tauri::command]
pub async fn mesh_store_put(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => {
            return Err("mesh_store_put expects a raw binary body, got JSON".into())
        }
    };
    let client = request
        .headers()
        .get(CLIENT_ID_HEADER)
        .ok_or("mesh_store_put is missing its x-mesh-client-id header")?
        .to_str()
        .map_err(|e| format!("invalid x-mesh-client-id header: {e}"))?
        .trim()
        .to_string();
    if client.is_empty() {
        return Err("mesh_store_put received an empty x-mesh-client-id header".into());
    }
    if bytes.len() % 36 != 0 {
        return Err(format!(
            "mesh_store_put: {} bytes is not a triangle soup (9 x f32 per triangle)",
            bytes.len()
        ));
    }
    Ok(mesh_store::global().put(Owner::Frontend(client), Entry::Soup(bytes.to_vec())))
}

/// Returns the bytes of a stored soup or buffer. With `release`, the entry is dropped as it is
/// read, and its bytes leave without a copy when no operation still holds them. A session id
/// fails with `wrong_kind` and stays in the store.
#[tauri::command]
pub async fn mesh_store_read(mesh_id: String, release: Option<bool>) -> Result<Response, String> {
    let store = mesh_store::global();
    let bytes = if release.unwrap_or(false) {
        store.take_bytes(&mesh_id)?
    } else {
        store.read_bytes(&mesh_id)?
    };
    Ok(Response::new(bytes))
}

/// Drops these ids and returns how many were still there.
#[tauri::command]
pub async fn mesh_store_drop(mesh_ids: Vec<String>) -> Result<usize, String> {
    Ok(mesh_store::global().drop_ids(&mesh_ids))
}

/// Announces this page load's client id, and drops what earlier page loads left behind.
/// Returns how many entries went.
#[tauri::command]
pub async fn mesh_store_open_client(client_id: String) -> Result<usize, String> {
    let client = client_id.trim();
    if client.is_empty() {
        return Err("mesh_store_open_client requires a non-empty client id".into());
    }
    let dropped = mesh_store::global().drop_other_frontend_clients(client);
    if dropped > 0 {
        log::info!("[mesh_store] dropped {dropped} entries left by an earlier page load");
    }
    Ok(dropped)
}

#[tauri::command]
pub async fn mesh_store_stats() -> Result<StoreStats, String> {
    Ok(mesh_store::global().stats())
}
