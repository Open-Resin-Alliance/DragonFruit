//! Tauri transport for worker-driven, content-addressed mesh uploads.
//!
//! Raw appends are SHA-256 checked before touching upload state or the cache.
//! Indexed commands consume a named immutable snapshot with take_request_body;
//! transforming commands use finish(stage=true) to replace the existing stage.

use crate::mesh_chunk_cache::{ChunkHash, MeshChunkCache, UploadStats, CACHE_BYTES, CHUNK_BYTES, MAX_SAFE_BYTES};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::{InvokeBody, Request};

static UPLOADS: OnceLock<Mutex<MeshChunkCache>> = OnceLock::new();

fn uploads() -> &'static Mutex<MeshChunkCache> {
    UPLOADS.get_or_init(|| Mutex::new(MeshChunkCache::new(CACHE_BYTES)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshChunkUploadAck {
    pub upload_id: String,
    pub chunk_bytes: u64,
    pub total_bytes: u64,
    pub capacity_bytes: u64,
    pub reserve_grew: bool,
    pub chunks_received: u64,
    pub append_ns: u64,
    pub append_ns_total: u64,
    pub uploaded_bytes: u64,
    pub reused_bytes: u64,
}

impl MeshChunkUploadAck {
    fn new(upload_id: String, stats: UploadStats) -> Self {
        Self {
            upload_id,
            chunk_bytes: stats.chunk_bytes as u64,
            total_bytes: stats.total_bytes as u64,
            capacity_bytes: stats.capacity_bytes as u64,
            reserve_grew: stats.reserve_grew,
            chunks_received: stats.chunks_received,
            append_ns: stats.append_ns,
            append_ns_total: stats.append_ns_total,
            uploaded_bytes: stats.uploaded_bytes as u64,
            reused_bytes: stats.reused_bytes as u64,
        }
    }
}

fn native_size(bytes: u64) -> Result<usize, String> {
    if bytes > MAX_SAFE_BYTES || bytes > isize::MAX as u64 {
        return Err("Mesh byte size exceeds the native/JavaScript safe range".into());
    }
    usize::try_from(bytes).map_err(|_| "Mesh byte size exceeds the native range".into())
}

fn parse_chunk_hash(text: &str) -> Result<ChunkHash, String> {
    if text.len() != 64 {
        return Err("Mesh chunk hash must be 64 lowercase SHA-256 hex characters".into());
    }
    fn nibble(byte: u8) -> Result<u8, String> {
        match byte {
            b'0'..=b'9' => Ok(byte - b'0'),
            b'a'..=b'f' => Ok(byte - b'a' + 10),
            _ => Err("Mesh chunk hash must be lowercase SHA-256 hex".into()),
        }
    }
    let mut hash = [0; 32];
    for (out, pair) in hash.iter_mut().zip(text.as_bytes().chunks_exact(2)) {
        *out = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Ok(hash)
}

fn verified_chunk_hash(text: &str, bytes: &[u8]) -> Result<ChunkHash, String> {
    if bytes.is_empty() || bytes.len() > CHUNK_BYTES || bytes.len() % 4 != 0 {
        return Err("Mesh chunks must be nonempty, 4-byte aligned, and at most 4 MiB".into());
    }
    let expected = parse_chunk_hash(text)?;
    let actual: ChunkHash = Sha256::digest(bytes).into();
    if actual != expected {
        return Err("Mesh chunk SHA-256 does not match x-mesh-chunk-hash".into());
    }
    Ok(expected)
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    request.headers().get(name)
        .ok_or_else(|| format!("Mesh chunk append missing {name} header"))?
        .to_str().map_err(|e| format!("Invalid {name} header: {e}"))
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mesh_chunk_upload_begin(reserve_bytes: u64) -> Result<String, String> {
    let reserve_bytes = native_size(reserve_bytes)?;
    uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?
        .begin(reserve_bytes)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mesh_chunk_upload_append_cached(
    upload_id: String,
    hash: String,
    byte_length: u64,
) -> Result<bool, String> {
    let hash = parse_chunk_hash(&hash)?;
    let byte_length = native_size(byte_length)?;
    uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?
        .append_cached(&upload_id, &hash, byte_length)
}

#[tauri::command]
pub async fn mesh_chunk_upload_append(request: Request<'_>) -> Result<(), String> {
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("mesh_chunk_upload_append expects a raw binary body".into()),
    };
    if header(&request, "content-type")? != "application/octet-stream" {
        return Err("mesh_chunk_upload_append requires Content-Type application/octet-stream".into());
    }
    let upload_id = header(&request, "x-mesh-upload-id")?;
    let hash = verified_chunk_hash(header(&request, "x-mesh-chunk-hash")?, bytes)?;
    uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?
        .append_verified(upload_id, hash, bytes)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mesh_chunk_upload_finish(
    upload_id: String,
    stage: bool,
) -> Result<MeshChunkUploadAck, String> {
    let mut uploads = uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?;
    if !stage {
        let finished = uploads.finish(&upload_id, false)?;
        return Ok(MeshChunkUploadAck::new(upload_id, finished.stats));
    }

    // Acquire every staging lock before consuming the upload or changing any
    // staging field. Errors therefore leave both the old stage and upload intact.
    let mut staged = crate::staged_mesh().lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))?;
    let mut stats = crate::staged_mesh_stats().lock()
        .map_err(|e| format!("staged mesh stats lock poisoned: {e}"))?;
    let mut path = crate::staged_mesh_file_path().lock()
        .map_err(|e| format!("staged mesh file-path lock poisoned: {e}"))?;
    let mut appender = crate::staged_mesh_file_appender().lock()
        .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;
    let finished = uploads.finish(&upload_id, true)?;
    let ack = MeshChunkUploadAck::new(upload_id, finished.stats);
    *staged = finished.staged_bytes;
    *stats = crate::StageMeshStats {
        chunks_received: ack.chunks_received,
        append_ns_total: ack.append_ns_total,
    };
    *path = None;
    *appender = None;
    Ok(ack)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mesh_chunk_upload_abort(upload_id: String) -> Result<(), String> {
    uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?
        .abort(&upload_id);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MeshUploadReference {
    mesh_upload_id: String,
    expected_bytes: u64,
}

/// Consume the exact named snapshot for JSON commands with additional options.
pub(crate) fn take_snapshot(upload_id: &str, expected_bytes: usize) -> Result<Vec<u8>, String> {
    uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?
        .take_ready(upload_id, expected_bytes)
}

/// Raw request bodies keep their existing ownership behavior. A JSON reference
/// consumes only its exact named snapshot, never the anonymous staged mesh.
/// Call this before spawn_blocking so the ready slot is released immediately.
pub fn take_request_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(body) => {
            let reference: MeshUploadReference = serde_json::from_value(body.clone())
                .map_err(|e| format!("Expected mesh upload reference {{meshUploadId, expectedBytes}}: {e}"))?;
            let expected_bytes = native_size(reference.expected_bytes)?;
            take_snapshot(&reference.mesh_upload_id, expected_bytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hashes_must_be_lowercase_and_exact_length() {
        assert_eq!(parse_chunk_hash(&"ab".repeat(32)).unwrap(), [0xab; 32]);
        assert!(parse_chunk_hash(&"AB".repeat(32)).is_err());
        assert!(parse_chunk_hash(&"ag".repeat(32)).is_err());
        assert!(parse_chunk_hash(&"a".repeat(63)).is_err());
    }

    #[test]
    fn changed_bytes_are_rejected_before_an_append_can_mutate_state() {
        let bytes = [0u8; 36];
        let digest = Sha256::digest(bytes);
        let text: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        let hash = verified_chunk_hash(&text, &bytes).unwrap();
        let mut cache = MeshChunkCache::new(72);
        let id = cache.begin(36).unwrap();
        let changed = [1u8; 36];
        let rejected = verified_chunk_hash(&text, &changed)
            .and_then(|key| cache.append_verified(&id, key, &changed));
        assert!(rejected.is_err());
        assert!(!cache.append_cached(&id, &hash, 36).unwrap());
        assert!(cache.finish(&id, true).is_err());
        cache.append_verified(&id, hash, &bytes).unwrap();
        assert_eq!(cache.finish(&id, true).unwrap().staged_bytes.unwrap(), bytes);
    }

    #[test]
    fn native_sizes_and_raw_chunk_alignment_are_checked() {
        assert!(native_size(MAX_SAFE_BYTES + 1).is_err());
        assert!(verified_chunk_hash(&"0".repeat(64), &[]).is_err());
        assert!(verified_chunk_hash(&"0".repeat(64), &[0; 3]).is_err());
    }
}
