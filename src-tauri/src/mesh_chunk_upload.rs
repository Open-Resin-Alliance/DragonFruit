//! Tauri transport for worker-driven, content-addressed mesh uploads.
//!
//! Raw appends are SHA-256 checked before touching upload state or the cache.
//! Indexed commands consume a named immutable snapshot with take_request_body;
//! transforming commands use finish(stage=true) to replace the existing stage.

use crate::mesh_chunk_cache::{ChunkHash, MeshChunkCache, UploadStats, CACHE_BYTES, CHUNK_BYTES, MAX_SAFE_BYTES};
use serde::{Deserialize, Serialize};
use dragonfruit_mesh_core::mesh::IndexedMesh;
use crate::mesh_slice_source::{SourceCache, SourceOrder, SourceTransform, SourceBounds, SOURCE_BYTES, SOURCE_ENTRIES};
use sha2::{Digest, Sha256};
use std::sync::{LazyLock, Mutex};
use tauri::ipc::{InvokeBody, Request};
use tauri::Manager;

#[path = "mesh_slice_backing.rs"]
mod slice_backing;

static SOURCES: LazyLock<Mutex<SourceCache<IndexedMesh>>> =
    LazyLock::new(|| Mutex::new(SourceCache::new(SOURCE_BYTES, SOURCE_ENTRIES)));

static UPLOADS: LazyLock<Mutex<MeshChunkCache>> =
    LazyLock::new(|| Mutex::new(MeshChunkCache::with_verifier(CACHE_BYTES, chunk_hash)));

fn uploads() -> &'static Mutex<MeshChunkCache> {
    &UPLOADS
}

/// Bounds one plan manifest; the worker batches well below this.
const MAX_PLAN_CHUNKS: usize = 4096;

/// Create the one pending upload, lazily, for whichever command needs it first.
fn begin_upload(
    app: &crate::DragonFruitAppHandle,
    reserve_bytes: Option<u64>,
    retain_for_slice: Option<bool>,
) -> Result<String, String> {
    let reserve_bytes = native_size(reserve_bytes.unwrap_or(0))?;
    let mut uploads = uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?;
    if retain_for_slice.unwrap_or(false) {
        uploads.begin_for_slice(reserve_bytes, || {
            let directory = app.path().app_cache_dir()
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            slice_backing::open(&directory)
        })
    } else {
        uploads.begin(reserve_bytes)
    }
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_snapshot_id: Option<String>,
}

impl MeshChunkUploadAck {
    fn new(upload_id: String, stats: UploadStats, slice_snapshot_id: Option<String>) -> Self {
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
            slice_snapshot_id,
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

fn chunk_hash(bytes: &[u8]) -> ChunkHash {
    Sha256::digest(bytes).into()
}

fn verified_chunk_hash(text: &str, bytes: &[u8]) -> Result<ChunkHash, String> {
    if bytes.is_empty() || bytes.len() > CHUNK_BYTES || bytes.len() % 4 != 0 {
        return Err("Mesh chunks must be nonempty, 4-byte aligned, and at most 4 MiB".into());
    }
    let expected = parse_chunk_hash(text)?;
    let actual = chunk_hash(bytes);
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

/// One chunk the caller intends to append, in upload order.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanChunk {
    hash: String,
    byte_length: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeshChunkPlanAck {
    upload_id: String,
    /// Leading chunks that already existed and were appended from cache.
    cached: usize,
    /// Present only when this call also finalized the upload.
    #[serde(skip_serializing_if = "Option::is_none")]
    ack: Option<MeshChunkUploadAck>,
}

/// One round trip for a whole batch of content-addressed chunks: create the
/// upload when needed, append the cached leading run, and finalize when the
/// caller has nothing left to send. A caller that must upload missing chunks
/// sends them with `mesh_chunk_upload_append` and plans once more with none.
#[tauri::command(rename_all = "camelCase")]
pub async fn mesh_chunk_upload_plan(
    app: crate::DragonFruitAppHandle,
    upload_id: Option<String>,
    reserve_bytes: Option<u64>,
    retain_for_slice: Option<bool>,
    chunks: Vec<PlanChunk>,
    final_upload: Option<bool>,
    stage: Option<bool>,
) -> Result<MeshChunkPlanAck, String> {
    if chunks.len() > MAX_PLAN_CHUNKS {
        return Err(format!("A mesh upload plan holds at most {MAX_PLAN_CHUNKS} chunks"));
    }
    let specs = chunks.iter()
        .map(|chunk| Ok((parse_chunk_hash(&chunk.hash)?, native_size(chunk.byte_length)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let upload_id = match upload_id {
        Some(upload_id) => upload_id,
        None => begin_upload(&app, reserve_bytes, retain_for_slice)?,
    };
    let mut uploads = uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?;
    let cached = uploads.append_cached_batch(&upload_id, &specs)?;
    let ack = if final_upload.unwrap_or(false) && cached == specs.len() {
        Some(finish_upload(&mut uploads, &upload_id, stage.unwrap_or(true))?)
    } else {
        None
    };
    Ok(MeshChunkPlanAck { upload_id, cached, ack })
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

/// Alias the exact loader mesh once; the optional body maps final geometry
/// corners back to original soup corners, not to the loader's welded vertices.
#[tauri::command]
pub async fn retain_loaded_slice_mesh(request: Request<'_>) -> Result<Option<RetainedSourceAck>, String> {
    let token: u32 = header(&request, "x-mesh-token")?.parse()
        .map_err(|_| "Invalid x-mesh-token header")?;
    let expected: usize = header(&request, "x-mesh-expected-corners")?.parse()
        .map_err(|_| "Invalid x-mesh-expected-corners header")?;
    let offset: [f64; 3] = serde_json::from_str(header(&request, "x-mesh-position-offset")?)
        .map_err(|e| format!("Invalid x-mesh-position-offset header: {e}"))?;
    let model_triangle_count = request.headers().get("x-mesh-model-triangles")
        .map(|value| {
            value.to_str().map_err(|e| format!("Invalid x-mesh-model-triangles header: {e}"))?
                .parse::<usize>().map_err(|_| "Invalid x-mesh-model-triangles header".to_string())
        }).transpose()?;
    if model_triangle_count.map_or(false, |count| count == 0 || count >= expected / 3) {
        return Err("Retained source model triangle boundary is invalid".into());
    }
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        InvokeBody::Json(_) => return Err("retain_loaded_slice_mesh expects a raw binary body".into()),
    };
    if expected == 0 || expected % 3 != 0 || !offset.iter().all(|value| value.is_finite()) {
        return Err("Retained source requires whole triangles and a finite offset".into());
    }
    let order_bytes = expected.checked_mul(4).ok_or("Retained source order size overflow")?;
    if !bytes.is_empty() && bytes.len() != order_bytes {
        return Err("Retained source order byte length does not match expectedCorners".into());
    }
    let Some(mesh) = crate::mesh_repair::loaded_mesh(token) else { return Ok(None); };
    if mesh.triangles.len().checked_mul(3) != Some(expected) {
        return Ok(None);
    }
    let mesh_bytes = mesh.positions.capacity().checked_mul(std::mem::size_of::<dragonfruit_mesh_core::mesh::Vec3>())
        .and_then(|bytes| mesh.triangles.capacity().checked_mul(std::mem::size_of::<[u32; 3]>())
            .and_then(|triangles| bytes.checked_add(triangles)))
        .and_then(|bytes| bytes.checked_add(std::mem::size_of::<IndexedMesh>()))
        .ok_or("Retained source mesh size overflow")?;
    if mesh_bytes.checked_add(bytes.len()).map_or(true, |bytes| bytes > SOURCE_BYTES) {
        return Ok(None);
    }
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut indices = Vec::new();
        indices.try_reserve_exact(bytes.len() / 4)
            .map_err(|e| format!("Cannot reserve retained source corner order: {e}"))?;
        indices.extend(bytes.chunks_exact(4).map(|part| u32::from_le_bytes(part.try_into().expect("u32 order"))));
        let source_id = SOURCES.lock().map_err(|e| format!("Retained source lock poisoned: {e}"))?
            .retain(mesh.clone(), expected, mesh_bytes, indices, offset)?;
        let Some(source_id) = source_id else { return Ok(None); };
        // Scan only once at import retention, off the async thread and without
        // registry/upload locks. Frontend partition views borrow these bounds.
        let partitions = model_triangle_count.map(|model_triangle_count| {
            let (model_bounds, support_bounds) = crate::mesh_slice_source::translated_partition_bounds(
                mesh.triangles.len(), model_triangle_count, offset, |corner| {
                    let vertex = mesh.triangles[corner / 3][corner % 3] as usize;
                    let position = mesh.positions[vertex];
                    [position.x, position.y, position.z]
                })?;
            Ok::<_, String>(RetainedSourcePartitions {
                model_triangle_count,
                model_bounds: model_bounds.into(),
                support_bounds: support_bounds.into(),
            })
        }).transpose()?;
        Ok(Some(RetainedSourceAck { source_id, partitions }))
    })
    .await
    .map_err(|e| format!("retain source task panicked: {e}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedSourceAck {
    source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    partitions: Option<RetainedSourcePartitions>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetainedSourcePartitions {
    model_triangle_count: usize,
    model_bounds: SourceMeshBounds,
    support_bounds: SourceMeshBounds,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceAppendAck {
    upload_id: String,
    triangle_count: usize,
    mesh_bounds: SourceMeshBounds,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceMeshBounds {
    min_x: f64, min_y: f64, min_z: f64,
    max_x: f64, max_y: f64, max_z: f64,
}

impl From<SourceBounds> for SourceMeshBounds {
    fn from(bounds: SourceBounds) -> Self {
        Self {
            min_x: bounds.min[0], min_y: bounds.min[1], min_z: bounds.min[2],
            max_x: bounds.max[0], max_y: bounds.max[1], max_z: bounds.max[2],
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn mesh_chunk_upload_append_source(
    app: crate::DragonFruitAppHandle,
    upload_id: Option<String>,
    reserve_bytes: Option<u64>,
    retain_for_slice: Option<bool>,
    source_id: String,
    expected_corners: usize,
    triangle_start: usize,
    triangle_end: usize,
    order: String,
    matrix: [f64; 16],
    center: [f64; 3],
    plate_offset: [f64; 2],
    flip_winding: bool,
    negative_zero_mask: u32,
) -> Result<Option<SourceAppendAck>, String> {
    let order = match order.as_str() {
        "geometry" => SourceOrder::Geometry,
        "soup" => SourceOrder::Soup,
        _ => return Err("Retained source order must be geometry or soup".into()),
    };
    let mut transform = SourceTransform { matrix, center, plate_offset, flip_winding };
    transform.restore_negative_zeros(negative_zero_mask)?;
    transform.validate()?;
    if expected_corners == 0 || expected_corners % 3 != 0
        || triangle_start >= triangle_end || triangle_end > expected_corners / 3
    {
        return Err("Retained source triangle range is invalid".into());
    }
    // The first source of a session creates the upload itself, so a retained
    // import costs one invoke instead of a separate begin round trip.
    let created = upload_id.is_none();
    let upload_id = match upload_id {
        Some(upload_id) => upload_id,
        None => begin_upload(&app, reserve_bytes, retain_for_slice)?,
    };
    let task_upload_id = upload_id.clone();
    let ack: Result<Option<SourceAppendAck>, String> = tauri::async_runtime::spawn_blocking(move || {
        // Drop the source registry lock immediately. An active command pins only
        // its source; eviction never substitutes another mesh or changes its data.
        let source = SOURCES.lock().map_err(|e| format!("Retained source lock poisoned: {e}"))?
            .get(&source_id);
        let Some(source) = source else { return Ok(None); };
        let byte_length = source.validate_range(expected_corners, triangle_start, triangle_end)?;
        let triangles_per_chunk = CHUNK_BYTES / 36;
        let chunk_length = byte_length.min(triangles_per_chunk * 36);
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(chunk_length)
            .map_err(|e| format!("Cannot reserve source transform chunk: {e}"))?;
        uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?
            .prepare_reused_append(&task_upload_id, byte_length)?;
        let mut bounds = SourceBounds::empty();
        let mut start = triangle_start;
        while start < triangle_end {
            let end = start.saturating_add(triangles_per_chunk).min(triangle_end);
            source.write_triangles(start, end, order, &transform, |mesh, corner| {
                let vertex = mesh.triangles[corner / 3][corner % 3] as usize;
                let position = mesh.positions[vertex];
                [position.x, position.y, position.z]
            }, &mut bytes, &mut bounds);
            let hash = chunk_hash(&bytes);
            // Revalidate ownership on every chunk. Cancellation can remove only
            // this ID; stale work cannot append to a subsequently begun upload.
            uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?
                .append_reused_verified(&task_upload_id, hash, &bytes)?;
            start = end;
        }
        Ok(Some(SourceAppendAck {
            upload_id: task_upload_id,
            triangle_count: triangle_end - triangle_start,
            mesh_bounds: bounds.into(),
        }))
    })
    .await
    .map_err(|e| format!("append source task panicked: {e}"))?;
    let ack = ack?;
    if ack.is_none() && created {
        // A miss falls back to live geometry; the upload this call created is
        // empty, and leaving it pending would block the fallback's own upload.
        uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?
            .abort(&upload_id);
    }
    Ok(ack)
}

fn finish_upload(
    uploads: &mut MeshChunkCache,
    upload_id: &str,
    stage: bool,
) -> Result<MeshChunkUploadAck, String> {
    if !stage {
        let finished = uploads.finish(upload_id, false)?;
        return Ok(MeshChunkUploadAck::new(upload_id.to_string(), finished.stats, finished.slice_snapshot_id));
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
    let finished = uploads.finish(upload_id, true)?;
    let ack = MeshChunkUploadAck::new(upload_id.to_string(), finished.stats, finished.slice_snapshot_id);
    *staged = finished.staged_bytes;
    *stats = crate::StageMeshStats {
        chunks_received: ack.chunks_received,
        append_ns_total: ack.append_ns_total,
    };
    *path = None;
    *appender = None;
    Ok(ack)
}

/// A miss is ordinary: never take or clear the caller's existing staged mesh.
/// The frontend holds its native-mesh operation queue and upload turn throughout.
#[tauri::command(rename_all = "camelCase")]
pub async fn restore_cached_slice_mesh(
    snapshot_id: String,
) -> Result<Option<MeshChunkUploadAck>, String> {
    let mut uploads = uploads().lock().map_err(|e| format!("Mesh upload lock poisoned: {e}"))?;
    let Some(finished) = uploads.restore_slice(&snapshot_id)? else {
        return Ok(None);
    };
    // Restore does not consume the retained snapshot. A staging-lock error also
    // leaves it and the previous stage intact, unlike consuming a pending upload.
    let mut staged = crate::staged_mesh().lock()
        .map_err(|e| format!("staged mesh lock poisoned: {e}"))?;
    let mut stats = crate::staged_mesh_stats().lock()
        .map_err(|e| format!("staged mesh stats lock poisoned: {e}"))?;
    let mut path = crate::staged_mesh_file_path().lock()
        .map_err(|e| format!("staged mesh file-path lock poisoned: {e}"))?;
    let mut appender = crate::staged_mesh_file_appender().lock()
        .map_err(|e| format!("staged mesh file appender lock poisoned: {e}"))?;
    let ack = MeshChunkUploadAck::new(snapshot_id, finished.stats, finished.slice_snapshot_id);
    *staged = finished.staged_bytes;
    *stats = crate::StageMeshStats {
        chunks_received: ack.chunks_received,
        append_ns_total: ack.append_ns_total,
    };
    *path = None;
    *appender = None;
    Ok(Some(ack))
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
    fn retained_source_ack_uses_optional_camel_case_partition_metadata() {
        let plain = RetainedSourceAck { source_id: "mesh-source-1".into(), partitions: None };
        assert_eq!(serde_json::to_value(plain).unwrap(), serde_json::json!({"sourceId": "mesh-source-1"}));
        let ack = RetainedSourceAck {
            source_id: "mesh-source-2".into(),
            partitions: Some(RetainedSourcePartitions {
                model_triangle_count: 7,
                model_bounds: SourceBounds { min: [-1., -2., -3.], max: [1., 2., 3.] }.into(),
                support_bounds: SourceBounds { min: [-4., -5., -6.], max: [4., 5., 6.] }.into(),
            }),
        };
        assert_eq!(serde_json::to_value(ack).unwrap(), serde_json::json!({
            "sourceId": "mesh-source-2",
            "partitions": {
                "modelTriangleCount": 7,
                "modelBounds": {"minX": -1., "minY": -2., "minZ": -3., "maxX": 1., "maxY": 2., "maxZ": 3.},
                "supportBounds": {"minX": -4., "minY": -5., "minZ": -6., "maxX": 4., "maxY": 5., "maxZ": 6.}
            }
        }));
    }

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

    #[test]
    fn retained_reads_use_the_transport_sha256_verifier() {
        use std::io::{Seek, SeekFrom, Write};
        let mut cache = MeshChunkCache::with_verifier(0, chunk_hash);
        let mut witness = None;
        let id = cache.begin_for_slice(0, || {
            let file = slice_backing::open(&std::env::current_dir()?)?;
            witness = Some(file.try_clone()?);
            Ok(file)
        }).unwrap();
        let bytes = [7; 36];
        cache.append_verified(&id, chunk_hash(&bytes), &bytes).unwrap();
        let finished = cache.finish(&id, true).unwrap();
        let ack = MeshChunkUploadAck::new(id.clone(), finished.stats, finished.slice_snapshot_id);
        let json = serde_json::to_value(&ack).unwrap();
        assert_eq!(json["sliceSnapshotId"], id);
        assert_eq!(cache.restore_slice(&id).unwrap().unwrap().stats.reused_bytes, 36);
        let mut witness = witness.unwrap();
        witness.seek(SeekFrom::Start(18)).unwrap();
        witness.write_all(&[8]).unwrap();
        assert!(cache.restore_slice(&id).unwrap().is_none());
    }
}
