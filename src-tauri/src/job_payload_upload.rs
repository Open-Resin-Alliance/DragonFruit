use crate::job_payload_cache::{FieldSpec, LeaseAck, PayloadCache};
use std::sync::{Mutex, OnceLock};

fn cache() -> &'static Mutex<PayloadCache> {
    static CACHE: OnceLock<Mutex<PayloadCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(PayloadCache::default()))
}

#[tauri::command]
pub fn job_payload_begin(fields: Vec<FieldSpec>) -> Result<LeaseAck, String> {
    cache().lock().map_err(|e| format!("Job payload cache lock poisoned: {e}"))?.begin(fields)
}

#[tauri::command]
pub fn job_payload_append(request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let header = |name| request.headers().get(name).and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("Missing or invalid job payload header: {name}"));
    let lease = header("x-job-payload-lease")?;
    let result = (|| {
        let field = header("x-job-payload-field")?;
        let hash = header("x-job-payload-hash")?;
        let offset = header("x-job-payload-offset")?.parse::<usize>()
            .map_err(|_| "Invalid job payload offset".to_string())?;
        let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
            return Err("job_payload_append requires a raw binary body".into());
        };
        cache().lock().map_err(|e| format!("Job payload cache lock poisoned: {e}"))?
            .append(lease, field, hash, offset, bytes)
    })();
    if result.is_err() { release(lease)?; }
    result
}

#[tauri::command]
pub fn job_payload_finish(lease_id: String) -> Result<(), String> {
    let mut cache = cache().lock().map_err(|e| format!("Job payload cache lock poisoned: {e}"))?;
    let result = cache.finish(&lease_id);
    if result.is_err() { cache.release(&lease_id); }
    result
}

fn release(lease: &str) -> Result<(), String> {
    cache().lock().map_err(|e| format!("Job payload cache lock poisoned: {e}"))?.release(lease);
    Ok(())
}

#[tauri::command]
pub fn job_payload_release(lease_id: String) -> Result<(), String> { release(&lease_id) }

pub fn resolve(json: &str, lease: Option<&str>) -> Result<serde_json::Value, String> {
    cache().lock().map_err(|e| format!("Job payload cache lock poisoned: {e}"))?.resolve(json, lease)
}
