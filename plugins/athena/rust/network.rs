use base64::Engine;
use futures_util::TryStreamExt;
use log::debug;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();
static ATHENA_NETWORK_FILTERS: OnceLock<Vec<String>> = OnceLock::new();
static NANODLP_UPLOAD_PROGRESS: OnceLock<Mutex<HashMap<String, NanoDlpUploadProgressEntry>>> =
    OnceLock::new();

#[derive(Clone)]
struct NanoDlpUploadProgressEntry {
    total_bytes: u64,
    sent_bytes: Arc<AtomicU64>,
    done: bool,
    error: Option<String>,
    updated_at_ms: u64,
}

fn epoch_ms_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn nanodlp_upload_progress_registry() -> &'static Mutex<HashMap<String, NanoDlpUploadProgressEntry>> {
    NANODLP_UPLOAD_PROGRESS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_nanodlp_upload_progress(upload_id: &str, total_bytes: u64, sent_bytes: Arc<AtomicU64>) {
    if upload_id.trim().is_empty() {
        return;
    }

    if let Ok(mut map) = nanodlp_upload_progress_registry().lock() {
        let now_ms = epoch_ms_now();
        // Best-effort pruning to prevent unbounded growth.
        map.retain(|_, entry| !(entry.done && now_ms.saturating_sub(entry.updated_at_ms) > 15 * 60 * 1000));

        map.insert(
            upload_id.to_string(),
            NanoDlpUploadProgressEntry {
                total_bytes,
                sent_bytes,
                done: false,
                error: None,
                updated_at_ms: now_ms,
            },
        );
    }
}

fn complete_nanodlp_upload_progress(upload_id: &str, error: Option<String>) {
    if upload_id.trim().is_empty() {
        return;
    }

    if let Ok(mut map) = nanodlp_upload_progress_registry().lock() {
        if let Some(entry) = map.get_mut(upload_id) {
            if error.is_none() {
                entry
                    .sent_bytes
                    .store(entry.total_bytes, Ordering::Relaxed);
            }
            entry.done = true;
            entry.error = error;
            entry.updated_at_ms = epoch_ms_now();
        }
    }
}

fn snapshot_nanodlp_upload_progress(upload_id: &str) -> Option<Value> {
    let entry = {
        let map = nanodlp_upload_progress_registry().lock().ok()?;
        map.get(upload_id)?.clone()
    };

    let sent = entry
        .sent_bytes
        .load(Ordering::Relaxed)
        .min(entry.total_bytes);
    let percent = if entry.total_bytes > 0 {
        ((sent as f64 / entry.total_bytes as f64) * 100.0).clamp(0.0, 100.0)
    } else if entry.done {
        100.0
    } else {
        0.0
    };

    Some(json!({
        "uploadId": upload_id,
        "totalBytes": entry.total_bytes,
        "sentBytes": sent,
        "percent": percent,
        "done": entry.done,
        "error": entry.error,
        "updatedAtMs": entry.updated_at_ms,
    }))
}

fn athena_network_filters() -> &'static Vec<String> {
    ATHENA_NETWORK_FILTERS.get_or_init(|| {
        let raw = include_str!("../printers/printers.json");
        let parsed: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let Some(arr) = parsed.as_array() else {
            return Vec::new();
        };

        let mut seen = HashSet::new();
        let mut filters = Vec::new();
        for entry in arr {
            let support = entry
                .get("networkSupport")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if support != "nanodlp" {
                continue;
            }

            let filter = entry
                .get("networkFilter")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if filter.is_empty() {
                continue;
            }
            if seen.insert(filter.to_lowercase()) {
                filters.push(filter);
            }
        }

        filters
    })
}

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(4)
            // Explicit TCP connect timeout prevents OS-level SYN retransmits from
            // holding socket handles open beyond the per-request timeout, which is
            // especially important on Windows during subnet scanning.
            .connect_timeout(Duration::from_millis(800))
            .no_proxy()
            .build()
            .expect("failed to create HTTP client")
    })
}

#[derive(Clone, Serialize)]
pub struct PluginNetworkResponse {
    pub status: u16,
    pub body: Value,
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

fn parse_host_and_port(input: &str) -> Option<(String, u16)> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);
    let authority = without_scheme.split('/').next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    if let Some(colon_idx) = authority.rfind(':') {
        let host_part = &authority[..colon_idx];
        let port_part = &authority[colon_idx + 1..];
        if let Ok(port) = port_part.parse::<u16>() {
            if port >= 1 && !host_part.is_empty() {
                return Some((host_part.to_string(), port));
            }
        }
    }
    Some((authority.to_string(), 80))
}

fn build_base_url(host: &str, port: u16) -> String {
    if port == 80 {
        format!("http://{host}")
    } else {
        format!("http://{host}:{port}")
    }
}

fn resolve_port(raw: Option<&Value>, fallback: u16) -> u16 {
    raw.and_then(|v| v.as_u64())
        .and_then(|v| u16::try_from(v).ok())
        .filter(|&p| p >= 1)
        .unwrap_or(fallback)
}

fn resolve_raw_host(payload: &Value) -> String {
    payload
        .get("host")
        .or_else(|| payload.get("ipAddress"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn clamp_u64(val: Option<&Value>, fallback: u64, min: u64, max: u64) -> u64 {
    val.and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
        .map(|v| v.clamp(min, max))
        .unwrap_or(fallback.clamp(min, max))
}

fn is_plain_ipv4(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    parts.iter().all(|part| {
        if part.is_empty() || part.len() > 3 {
            return false;
        }
        match part.parse::<u16>() {
            Ok(n) => n <= 255,
            Err(_) => false,
        }
    })
}

fn to_subnet_prefix(ip: &str) -> Option<String> {
    if !is_plain_ipv4(ip) {
        return None;
    }
    let parts: Vec<&str> = ip.split('.').collect();
    Some(format!("{}.{}.{}", parts[0], parts[1], parts[2]))
}

// ---------------------------------------------------------------------------
// NanoDLP status helpers
// ---------------------------------------------------------------------------

const NANODLP_KNOWN_KEYS: &[&str] = &[
    "Printing",
    "Path",
    "LayerID",
    "Version",
    "Hostname",
    "State",
    "Status",
    "LayersCount",
    "PlateID",
    "Build",
    "Paused",
    "CurrentHeight",
    "IP",
];

fn looks_like_nanodlp_status(status: &Value) -> bool {
    let obj = match status.as_object() {
        Some(o) => o,
        None => return false,
    };
    let mut score = 0u32;
    for key in NANODLP_KNOWN_KEYS {
        if obj.contains_key(*key) {
            score += 1;
            if score >= 3 {
                return true;
            }
        }
    }
    false
}

fn looks_like_nanodlp_status_text(text: &str) -> bool {
    let trimmed = text.trim();
    if !trimmed.starts_with('{') {
        return false;
    }
    let mut matches = 0u32;
    for key in NANODLP_KNOWN_KEYS {
        let search = format!("\"{key}\"");
        if text.contains(&search) {
            matches += 1;
            if matches >= 3 {
                return true;
            }
        }
    }
    false
}

async fn fetch_nanodlp_status(host: &str, port: u16, timeout_ms: u64) -> Option<Value> {
    let url = format!("{}/status", build_base_url(host, port));
    let resp = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    let text = resp.text().await.ok()?;
    if !looks_like_nanodlp_status_text(&text) {
        return None;
    }
    let clean = text.trim().trim_start_matches('\u{FEFF}').trim();
    let status: Value = serde_json::from_str(clean).ok()?;
    if !looks_like_nanodlp_status(&status) {
        return None;
    }
    Some(status)
}

fn resolve_status_hostname(status: &Value) -> String {
    for key in &["Hostname", "hostName", "hostname", "Name", "Build", "IP"] {
        if let Some(val) = status.get(*key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn resolve_printer_name(status: &Value) -> String {
    for key in &["Name", "Build"] {
        if let Some(val) = status.get(*key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn resolve_printer_model(status: &Value) -> String {
    for key in &[
        "Model",
        "model",
        "PrinterModel",
        "printerModel",
        "Machine",
        "machine",
        "Name",
        "Build",
    ] {
        if let Some(val) = status.get(*key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn normalize_model_name(model: &str) -> String {
    let mut out = String::with_capacity(model.len());
    let mut previous_was_space = false;
    for ch in model.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            previous_was_space = false;
        } else if !previous_was_space {
            out.push(' ');
            previous_was_space = true;
        }
    }
    out.trim().to_string()
}

fn normalize_machine_name(name: &str) -> String {
    normalize_model_name(name)
}

fn is_nanodlp_filter_debug_enabled(payload: &Value, requested_network_filter: Option<&str>) -> bool {
    if let Some(v) = payload
        .get("suppressNetworkFilterDebug")
        .and_then(|v| v.as_bool())
    {
        return !v;
    }

    if let Some(v) = payload
        .get("debugNetworkFilter")
        .and_then(|v| v.as_bool())
    {
        return v;
    }

    if let Some(v) = payload
        .get("debugDiscovery")
        .and_then(|v| v.as_bool())
    {
        return v;
    }

    if requested_network_filter.map(|v| !v.trim().is_empty()).unwrap_or(false) {
        return true;
    }

    true
}

fn log_nanodlp_filter_debug(scope: &str, enabled: bool, details: Value) {
    if !enabled {
        return;
    }
    debug!("[Athena][NanoDLP][FilterDebug][{}] {}", scope, details);
}

fn resolve_supported_athena_model(status: &Value) -> Option<&'static str> {
    let model = resolve_printer_model(status);
    if model.is_empty() {
        return None;
    }
    let normalized = normalize_model_name(&model);
    if normalized.contains("athena 2") || normalized.contains("athena2") {
        return Some("athena-2");
    }
    if normalized.contains("athena") {
        return Some("athena");
    }
    None
}

fn normalize_model_hint(value: Option<&Value>) -> Option<&'static str> {
    let raw = value.and_then(|v| v.as_str())?.trim();
    if raw.is_empty() {
        return None;
    }

    let normalized = normalize_model_name(raw);
    if normalized.contains("athena 2") || normalized.contains("athena2") {
        return Some("athena-2");
    }
    if normalized.contains("athena") {
        return Some("athena");
    }
    None
}

fn matches_model_hint(supported_model: &str, model_hint: Option<&'static str>) -> bool {
    match model_hint {
        Some(expected) => supported_model == expected,
        None => true,
    }
}

fn device_matches_requested_model_hint(device: &Value, requested_model_hint: Option<&'static str>) -> bool {
    let Some(expected) = requested_model_hint else {
        return true;
    };

    let model = device
        .get("printerModel")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let normalized = normalize_model_name(model);

    if expected == "athena-2" {
        normalized.contains("athena 2") || normalized.contains("athena2")
    } else {
        normalized.contains("athena")
            && !normalized.contains("athena 2")
            && !normalized.contains("athena2")
    }
}

fn resolve_known_network_filter(machine_name: &str) -> Option<String> {
    let normalized_machine = normalize_machine_name(machine_name);
    if normalized_machine.is_empty() {
        return None;
    }

    for filter in athena_network_filters() {
        let normalized_filter = normalize_machine_name(filter);
        if normalized_machine == normalized_filter {
            return Some(filter.clone());
        }
    }

    for filter in athena_network_filters() {
        let normalized_filter = normalize_machine_name(filter);
        if normalized_filter.is_empty() {
            continue;
        }
        if normalized_machine.contains(&normalized_filter) || normalized_filter.contains(&normalized_machine) {
            return Some(filter.clone());
        }
    }

    None
}

async fn fetch_nanodlp_machine_name(host: &str, port: u16, timeout_ms: u64) -> Option<String> {
    let url = format!("{}/json/db/machine.json", build_base_url(host, port));
    let resp = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await
        .ok()?;
    if resp.status().as_u16() != 200 {
        return None;
    }
    let payload: Value = resp.json().await.ok()?;
    let name = payload.get("Name").and_then(|v| v.as_str())?.trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

async fn resolve_requested_network_filter(payload: &Value) -> Option<String> {
    let explicit = payload
        .get("networkFilter")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if explicit.is_some() {
        return explicit;
    }

    None
}

async fn resolve_device_network_filter(host: &str, port: u16, timeout_ms: u64) -> Option<String> {
    let machine_name = fetch_nanodlp_machine_name(host, port, timeout_ms).await?;
    resolve_known_network_filter(&machine_name)
}

async fn resolve_device_machine_name(host: &str, port: u16, timeout_ms: u64) -> Option<String> {
    let machine_name = fetch_nanodlp_machine_name(host, port, timeout_ms).await?;
    let trimmed = machine_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn resolve_address(status: &Value, fallback: &str) -> String {
    for key in &["IP", "ip", "ipAddress", "IPAddress"] {
        if let Some(val) = status.get(*key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() && is_plain_ipv4(trimmed) {
                return trimmed.to_string();
            }
        }
    }
    fallback.trim().to_string()
}

fn absolutize_nanodlp_url(candidate: &str, host: &str, port: u16) -> String {
    let trimmed = candidate.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    if trimmed.starts_with("//") {
        return format!("http:{trimmed}");
    }
    if trimmed.starts_with('/') {
        return format!("{}{}", build_base_url(host, port), trimmed);
    }
    format!(
        "{}/{}",
        build_base_url(host, port),
        trimmed.trim_start_matches('/')
    )
}

fn resolve_nanodlp_webcam_candidates(status: &Value, host: &str, port: u16) -> Vec<String> {
    let keys = [
        "WebcamURL",
        "webcamUrl",
        "Webcam",
        "webcam",
        "CameraURL",
        "cameraUrl",
        "StreamURL",
        "streamUrl",
        "MjpegURL",
        "mjpegUrl",
        "SnapshotURL",
        "snapshotUrl",
    ];

    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for key in keys {
        let Some(raw) = status.get(key).and_then(|v| v.as_str()) else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let absolute = absolutize_nanodlp_url(trimmed, host, port);
        if seen.insert(absolute.clone()) {
            out.push(absolute);
        }
    }
    out
}

fn resolve_athena_camera_online(state_payload: &Value) -> bool {
    match state_payload {
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().map(|v| v.is_finite() && v > 0.0).unwrap_or(false),
        Value::String(s) => {
            let normalized = s.trim().to_lowercase();
            (normalized.contains("online")
                || normalized.contains("active")
                || normalized.contains("enabled")
                || normalized.contains("ready")
                || normalized.contains("stream"))
                && !(normalized.contains("offline")
                    || normalized.contains("disabled")
                    || normalized.contains("error")
                    || normalized.contains("fail"))
        }
        Value::Object(obj) => {
            let boolish_keys = ["online", "enabled", "active", "streaming", "available"];
            for key in boolish_keys {
                if let Some(value) = obj.get(key) {
                    match value {
                        Value::Bool(true) => return true,
                        Value::Number(n) => {
                            if n.as_f64().map(|v| v.is_finite() && v > 0.0).unwrap_or(false) {
                                return true;
                            }
                        }
                        Value::String(s) => {
                            let normalized = s.trim().to_lowercase();
                            if normalized == "true"
                                || normalized == "online"
                                || normalized == "active"
                                || normalized == "enabled"
                            {
                                return true;
                            }
                        }
                        _ => {}
                    }
                }
            }

            let state_text = obj
                .get("state")
                .or_else(|| obj.get("status"))
                .or_else(|| obj.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_lowercase();

            !state_text.is_empty()
                && (state_text.contains("online")
                    || state_text.contains("active")
                    || state_text.contains("enabled")
                    || state_text.contains("ready")
                    || state_text.contains("stream"))
                && !(state_text.contains("offline")
                    || state_text.contains("disabled")
                    || state_text.contains("error")
                    || state_text.contains("fail"))
        }
        _ => false,
    }
}

async fn fetch_athena_camera_info(host: &str, port: u16) -> (bool, Option<String>, Option<String>, Value) {
    let base_url = build_base_url(host, port);
    let state_url = format!("{base_url}/athena-camera/state");
    let stream_url = format!("{base_url}/athena-camera/stream");

    let probe_stream_reachable = async {
        match http_client()
            .get(&stream_url)
            .header("Accept", "multipart/x-mixed-replace, image/*, */*;q=0.8")
            .timeout(Duration::from_millis(2500))
            .send()
            .await
        {
            Ok(resp) => {
                let code = resp.status().as_u16();
                code == 200 || code == 206 || code == 302 || code == 401 || code == 403
            }
            Err(_) => false,
        }
    };

    let mut parsed = Value::Null;

    let response = match http_client()
        .get(&state_url)
        .header("Accept", "application/json, text/plain;q=0.9, */*;q=0.8")
        .timeout(Duration::from_millis(4500))
        .send()
        .await
    {
        Ok(resp) => Some(resp),
        Err(_) => None,
    };

    if let Some(response) = response {
        if response.status().as_u16() != 200 {
            parsed = json!({ "status": response.status().as_u16() });
        } else {
            let text = response.text().await.unwrap_or_default();
            parsed = if text.trim().is_empty() {
                Value::Null
            } else {
                serde_json::from_str::<Value>(&text).unwrap_or(Value::String(text))
            };
        }
    }

    let stream_reachable = probe_stream_reachable.await;
    let online = resolve_athena_camera_online(&parsed) || stream_reachable;
    let stream_url = if online { Some(stream_url) } else { None };
    let snapshot_url = parsed
        .get("snapshotUrl")
        .and_then(|v| v.as_str())
        .map(|v| absolutize_nanodlp_url(v, host, port));

    (online, stream_url, snapshot_url, parsed)
}

// ---------------------------------------------------------------------------
// Network interface enumeration
// ---------------------------------------------------------------------------

fn get_local_subnet_prefixes() -> Vec<String> {
    let addrs = match if_addrs::get_if_addrs() {
        Ok(addrs) => addrs,
        Err(_) => return Vec::new(),
    };
    let mut prefixes = HashSet::new();
    for iface in addrs {
        if iface.is_loopback() {
            continue;
        }
        if let if_addrs::IfAddr::V4(v4) = iface.addr {
            let octets = v4.ip.octets();
            prefixes.insert(format!("{}.{}.{}", octets[0], octets[1], octets[2]));
        }
    }
    prefixes.into_iter().collect()
}

fn build_ip_candidates_from_prefixes(prefixes: &[String]) -> Vec<String> {
    let mut all = Vec::new();
    for prefix in prefixes {
        for host in 1..=254u16 {
            all.push(format!("{prefix}.{host}"));
        }
    }
    all
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

async fn probe_nanodlp(host: &str, port: u16, timeout_ms: u64) -> Option<Value> {
    let status = fetch_nanodlp_status(host, port, timeout_ms).await?;
    resolve_supported_athena_model(&status)?;
    let hostname = resolve_status_hostname(&status);
    let printer_name = resolve_printer_name(&status);
    let printer_model = resolve_printer_model(&status);
    let resolved_address = resolve_address(&status, host);
    let status_text = status
        .get("Status")
        .and_then(|v| v.as_str())
        .unwrap_or("Online");
    let state = status.get("State").and_then(|v| v.as_str()).unwrap_or("");
    let firmware_version = status
        .get("Version")
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default();

    Some(json!({
        "ipAddress": resolved_address,
        "port": port,
        "hostName": hostname,
        "printerName": printer_name,
        "printerModel": printer_model,
        "statusText": status_text,
        "state": state,
        "firmwareVersion": firmware_version,
    }))
}

async fn probe_batch(
    targets: Vec<(String, u16)>,
    concurrency: usize,
    timeout_ms: u64,
) -> Vec<Value> {
    if targets.is_empty() {
        return Vec::new();
    }
    let semaphore = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut handles = Vec::with_capacity(targets.len());
    for (host, port) in targets {
        let sem = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.ok()?;
            probe_nanodlp(&host, port, timeout_ms).await
        }));
    }

    let mut results = Vec::new();
    for handle in handles {
        if let Ok(Some(device)) = handle.await {
            results.push(device);
        }
    }

    let mut seen = HashSet::new();
    results.retain(|dev| {
        let ip = dev
            .get("ipAddress")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        seen.insert(ip)
    });
    results
}

// ---------------------------------------------------------------------------
// Profile / material helpers
// ---------------------------------------------------------------------------

fn extract_list(decoded: &Value, keys: &[&str]) -> Vec<Value> {
    if let Some(arr) = decoded.as_array() {
        return arr.clone();
    }
    if let Some(obj) = decoded.as_object() {
        for key in keys {
            if let Some(arr) = obj.get(*key).and_then(|v| v.as_array()) {
                return arr.clone();
            }
        }
        for val in obj.values() {
            if let Some(arr) = val.as_array() {
                return arr.clone();
            }
        }
        return vec![decoded.clone()];
    }
    Vec::new()
}

fn resolve_profile_id(raw: &Value) -> Option<String> {
    let candidates = [
        "profileId",
        "ProfileID",
        "ProfileId",
        "id",
        "ID",
        "Path",
        "path",
        "File",
        "file",
        "name",
        "Name",
    ];
    for key in candidates {
        if let Some(val) = raw.get(key) {
            let s = match val {
                Value::String(s) => s.trim().to_string(),
                Value::Number(n) => n.to_string(),
                _ => continue,
            };
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn friendly_name_from_path(path: &str) -> Option<String> {
    let normalized = path.trim();
    if normalized.is_empty() {
        return None;
    }
    let tail = normalized.rsplit('/').next().unwrap_or(normalized);
    let without_ext = match tail.rfind('.') {
        Some(dot) => &tail[..dot],
        None => tail,
    };
    let spaced = without_ext
        .replace(|c: char| c == '_' || c == '-', " ")
        .trim()
        .to_string();
    if spaced.is_empty() {
        None
    } else {
        Some(spaced)
    }
}

fn resolve_profile_name(raw: &Value) -> String {
    let name_candidates = [
        "display_name",
        "DisplayName",
        "label",
        "Label",
        "title",
        "Title",
        "desc",
        "Desc",
        "Description",
        "ProfileName",
        "profileName",
        "MaterialName",
        "materialName",
        "ResinName",
        "resinName",
        "name",
        "Name",
    ];
    for key in name_candidates {
        if let Some(val) = raw.get(key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    let path_candidates = ["Path", "path", "File", "file"];
    for key in path_candidates {
        if let Some(val) = raw.get(key).and_then(|v| v.as_str()) {
            if let Some(name) = friendly_name_from_path(val) {
                return name;
            }
        }
    }
    "Unknown Resin Profile".to_string()
}

fn detect_locked_profile(name: &str, raw: &Value) -> bool {
    if let Some(locked) = raw.get("locked").and_then(|v| v.as_bool()) {
        return locked;
    }
    if name.starts_with('[') {
        if let Some(bracket_end) = name.find(']') {
            let inner = &name[1..bracket_end];
            if inner.len() >= 2 && inner.len() <= 5 && inner.chars().all(|c| c.is_ascii_uppercase())
            {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// Plate helpers
// ---------------------------------------------------------------------------

fn get_plate_name(plate: &Value) -> String {
    for key in &["Path", "path", "File", "file", "Name", "name"] {
        if let Some(val) = plate.get(*key).and_then(|v| v.as_str()) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    String::new()
}

fn normalize_job_name(name: &str) -> String {
    let trimmed = name.trim();
    let without_ext = match trimmed.rfind('.') {
        Some(dot) => &trimmed[..dot],
        None => trimmed,
    };
    without_ext.to_lowercase()
}

fn has_positive_number(val: &Value) -> bool {
    match val {
        Value::Number(n) => n
            .as_f64()
            .map(|f| f.is_finite() && f > 0.0)
            .unwrap_or(false),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .map(|f| f.is_finite() && f > 0.0)
            .unwrap_or(false),
        _ => false,
    }
}

fn find_plate(plates: &[Value], plate_id: Option<u64>, job_name: &str) -> Option<Value> {
    if let Some(target_id) = plate_id {
        for plate in plates {
            let raw_id = plate
                .get("PlateID")
                .or_else(|| plate.get("plateId"))
                .or_else(|| plate.get("plate_id"))
                .or_else(|| plate.get("id"));
            if let Some(val) = raw_id {
                let parsed = match val {
                    Value::Number(n) => n.as_u64(),
                    Value::String(s) => s.trim().parse::<u64>().ok(),
                    _ => None,
                };
                if parsed == Some(target_id) {
                    return Some(plate.clone());
                }
            }
        }
    }
    let normalized_job = normalize_job_name(job_name);
    if normalized_job.is_empty() {
        return None;
    }
    for plate in plates {
        let plate_name = get_plate_name(plate);
        if !plate_name.is_empty() && normalize_job_name(&plate_name) == normalized_job {
            return Some(plate.clone());
        }
    }
    None
}

fn is_plate_metadata_ready(plate: &Value) -> bool {
    let candidates = [
        "LayerHeight",
        "layerHeight",
        "LayersCount",
        "layerCount",
        "PrintTime",
        "printTime",
        "UsedMaterial",
        "usedMaterial",
    ];
    for key in candidates {
        if let Some(val) = plate.get(key) {
            if has_positive_number(val) {
                return true;
            }
        }
    }
    let file_data = plate.get("file_data").or_else(|| plate.get("fileData"));
    if let Some(fd) = file_data {
        let last_mod = fd.get("last_modified").or_else(|| fd.get("lastModified"));
        if let Some(val) = last_mod {
            if has_positive_number(val) {
                return true;
            }
        }
    }
    false
}

fn normalize_nanodlp_file_location(value: Option<&str>) -> &'static str {
    let normalized = value.unwrap_or("").trim().to_lowercase();
    if normalized == "usb" || normalized == "external" {
        return "Usb";
    }
    if normalized == "local" || normalized == "internal" {
        return "Local";
    }
    "Local"
}

async fn resolve_nanodlp_plate_file_target(
    host: &str,
    port: u16,
    plate_id: u64,
) -> Option<(String, &'static str)> {
    let base_url = build_base_url(host, port).trim_end_matches('/').to_string();
    let resp = http_client()
        .get(format!("{base_url}/plates/list/json"))
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .ok()?;

    if resp.status().as_u16() != 200 {
        return None;
    }

    let decoded: Value = resp.json().await.ok()?;
    let entries = extract_list(&decoded, &["plates", "files", "data"]);
    let plates: Vec<Value> = entries.into_iter().filter(|e| e.is_object()).collect();
    let matched = find_plate(&plates, Some(plate_id), "")?;

    let file_path = matched
        .get("Path")
        .or_else(|| matched.get("path"))
        .or_else(|| matched.get("File"))
        .or_else(|| matched.get("file"))
        .or_else(|| matched.get("Name"))
        .or_else(|| matched.get("name"))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;

    let location_raw = matched
        .get("Location")
        .or_else(|| matched.get("location"))
        .or_else(|| matched.get("LocationCategory"))
        .or_else(|| matched.get("locationCategory"))
        .or_else(|| matched.get("storage"))
        .or_else(|| matched.get("Storage"))
        .and_then(|value| value.as_str());

    Some((file_path, normalize_nanodlp_file_location(location_raw)))
}

// ---------------------------------------------------------------------------
// Hostname / IP normalization helpers
// ---------------------------------------------------------------------------

fn normalize_hostname_candidates(val: Option<&Value>) -> Vec<String> {
    let arr = match val.and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str() {
            let trimmed = s.trim().to_lowercase();
            if !trimmed.is_empty() && trimmed.ends_with(".local") && seen.insert(trimmed.clone()) {
                result.push(trimmed);
                if result.len() >= 24 {
                    break;
                }
            }
        }
    }
    result
}

fn normalize_ipv4_candidates(val: Option<&Value>) -> Vec<String> {
    let arr = match val.and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return Vec::new(),
    };
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for item in arr {
        if let Some(s) = item.as_str() {
            let trimmed = s.trim().to_string();
            if is_plain_ipv4(&trimmed) && seen.insert(trimmed.clone()) {
                result.push(trimmed);
            }
        }
    }
    result
}

// ---------------------------------------------------------------------------
// NanoDLP: connect
// ---------------------------------------------------------------------------

async fn nanodlp_connect(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => return (400, json!({ "error": "Invalid host or IP address" })),
    };
    let port = resolve_port(payload.get("port"), parsed.1);
    let requested_model_hint = normalize_model_hint(payload.get("modelHint"));
    let requested_network_filter = resolve_requested_network_filter(payload).await;
    let debug_filter = is_nanodlp_filter_debug_enabled(payload, requested_network_filter.as_deref());

    log_nanodlp_filter_debug(
        "connect/request",
        debug_filter,
        json!({
            "host": parsed.0,
            "port": port,
            "requestedModelHint": requested_model_hint,
            "requestedNetworkFilter": requested_network_filter,
        }),
    );

    match fetch_nanodlp_status(&parsed.0, port, 5000).await {
        Some(status) => {
            let supported_model = resolve_supported_athena_model(&status);
            let hostname = resolve_status_hostname(&status);
            let printer_name = resolve_printer_name(&status);
            let printer_model = resolve_printer_model(&status);
            let resolved = resolve_address(&status, &parsed.0);
            let status_text = status
                .get("Status")
                .and_then(|v| v.as_str())
                .unwrap_or("Online");
            let state = status.get("State").and_then(|v| v.as_str()).unwrap_or("");
            let fw = status
                .get("Version")
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_default();
            let device_network_filter = resolve_device_network_filter(&parsed.0, port, 3500).await;
            let device_machine_name = resolve_device_machine_name(&parsed.0, port, 3500).await;

            log_nanodlp_filter_debug(
                "connect/candidate",
                debug_filter,
                json!({
                    "host": parsed.0,
                    "port": port,
                    "supportedModel": supported_model,
                    "requestedModelHint": requested_model_hint,
                    "printerModel": printer_model,
                    "requestedNetworkFilter": requested_network_filter,
                    "deviceMachineName": device_machine_name,
                    "normalizedDeviceMachineName": device_machine_name.as_deref().map(normalize_machine_name),
                    "normalizedRequestedNetworkFilter": requested_network_filter.as_deref().map(normalize_machine_name),
                    "deviceNetworkFilter": device_network_filter,
                }),
            );

            let normalized_requested_network_filter = requested_network_filter
                .as_deref()
                .map(normalize_machine_name);
            let normalized_device_machine_name = device_machine_name
                .as_deref()
                .map(normalize_machine_name);
            let normalized_device_network_filter = device_network_filter
                .as_deref()
                .map(normalize_machine_name);
            let network_filter_matched = normalized_requested_network_filter
                .as_ref()
                .zip(normalized_device_machine_name.as_ref())
                .map(|(expected, actual)| expected == actual)
                .unwrap_or(false);
            let explicit_known_filter_mismatch = normalized_requested_network_filter
                .as_ref()
                .zip(normalized_device_network_filter.as_ref())
                .map(|(expected, known)| expected != known)
                .unwrap_or(false);
            let model_hint_matched = supported_model
                .map(|model| matches_model_hint(model, requested_model_hint))
                .unwrap_or(false);

            if supported_model.is_none()
                || explicit_known_filter_mismatch
                || (!model_hint_matched && !network_filter_matched)
            {
                let reason = if supported_model.is_none() {
                    "unsupported-model"
                } else if explicit_known_filter_mismatch {
                    "explicit-known-filter-mismatch"
                } else {
                    "model-hint-mismatch"
                };

                log_nanodlp_filter_debug(
                    "connect/reject",
                    debug_filter,
                    json!({
                        "host": parsed.0,
                        "port": port,
                        "reason": reason,
                        "requestedModelHint": requested_model_hint,
                        "requestedNetworkFilter": requested_network_filter,
                        "modelHintMatched": model_hint_matched,
                        "networkFilterMatched": network_filter_matched,
                        "explicitKnownFilterMismatch": explicit_known_filter_mismatch,
                        "supportedModel": supported_model,
                        "printerModel": printer_model,
                        "deviceMachineName": device_machine_name,
                        "deviceNetworkFilter": device_network_filter,
                    }),
                );

                let requested_label = match requested_model_hint {
                    Some("athena-2") => Some("Athena 2"),
                    Some("athena") => Some("Athena"),
                    _ => None,
                };
                let unsupported_text = if printer_model.is_empty() {
                    match requested_network_filter.as_deref() {
                        Some(filter) => format!("Printer model mismatch: expected {filter}."),
                        None => match requested_label {
                            Some(label) => format!("Printer model mismatch: expected {label}."),
                            None => {
                                "Unsupported printer model. Supported models: Athena, Athena 2.".to_string()
                            }
                        },
                    }
                } else {
                    match requested_network_filter.as_deref() {
                        Some(filter) => {
                            format!(
                                "Printer model mismatch: expected {filter}, found \"{}\".",
                                device_network_filter
                                    .as_deref()
                                    .filter(|v| !v.trim().is_empty())
                                    .unwrap_or(printer_model.as_str())
                            )
                        }
                        None => match requested_label {
                            Some(label) => {
                                format!("Printer model mismatch: expected {label}, found \"{}\".", printer_model)
                            }
                            None => format!(
                                "Unsupported printer model \"{}\". Supported models: Athena, Athena 2.",
                                printer_model
                            ),
                        },
                    }
                };

                return (
                    200,
                    json!({
                        "connected": false,
                        "mode": "nanodlp",
                        "hostName": hostname,
                        "printerName": printer_name,
                        "printerModel": printer_model,
                        "ipAddress": resolved,
                        "port": port,
                        "statusText": unsupported_text,
                        "state": state,
                        "firmwareVersion": fw,
                    }),
                );
            }

            (
                200,
                json!({
                    "connected": true,
                    "mode": "nanodlp",
                    "hostName": hostname,
                    "printerName": printer_name,
                    "printerModel": printer_model,
                    "ipAddress": resolved,
                    "port": port,
                    "statusText": status_text,
                    "state": state,
                    "firmwareVersion": fw,
                }),
            )
        }
        None => (
            200,
            json!({
                "connected": false,
                "mode": "nanodlp",
                "hostName": "",
                "printerName": "",
                "ipAddress": parsed.0,
                "port": port,
                "statusText": "NanoDLP host unreachable or invalid status payload",
                "state": "",
                "firmwareVersion": "",
            }),
        ),
    }
}

// ---------------------------------------------------------------------------
// NanoDLP: discover
// ---------------------------------------------------------------------------

async fn nanodlp_discover(payload: &Value) -> (u16, Value) {
    let mode = payload
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("nanodlp");
    if mode != "nanodlp" {
        return (400, json!({ "error": "Unsupported network mode" }));
    }

    let scope_raw = payload
        .get("scanScope")
        .and_then(|v| v.as_str())
        .unwrap_or("all");
    let scan_scope = match scope_raw {
        "local-hostnames" | "subnet" | "all" => scope_raw,
        _ => "all",
    };
    let requested_model_hint = normalize_model_hint(payload.get("modelHint"));
    let requested_network_filter = resolve_requested_network_filter(payload).await;
    let debug_filter = is_nanodlp_filter_debug_enabled(payload, requested_network_filter.as_deref());

    let raw_host = resolve_raw_host(payload);
    let forced_host_parsed = if raw_host.trim().is_empty() {
        None
    } else {
        parse_host_and_port(&raw_host)
    };
    let forced_host = forced_host_parsed.as_ref().map(|(h, _)| h.as_str());
    let forced_host_is_ipv4 = forced_host.map(is_plain_ipv4).unwrap_or(false);

    // Parse target ports
    let ports_input = payload.get("ports").and_then(|v| v.as_array());
    let mut target_ports: Vec<u16> = ports_input
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_u64().and_then(|n| u16::try_from(n).ok()))
                .filter(|&p| p >= 1)
                .collect()
        })
        .unwrap_or_else(|| vec![80, 8080]);
    target_ports.dedup();
    target_ports.truncate(4);
    if target_ports.is_empty() {
        target_ports = vec![80, 8080];
    }

    // Build local hostname candidates
    let default_local_hostnames: Vec<&str> = vec![
        "nanodlp.local",
        "athena.local",
        "printer.local",
        "resin.local",
    ];
    let payload_local_hostnames = normalize_hostname_candidates(payload.get("localHostnames"));
    let mut local_host_candidates: Vec<String> = Vec::new();
    let mut local_seen = HashSet::new();
    if let Some(host) = forced_host {
        if host.ends_with(".local") {
            let h = host.to_lowercase();
            if local_seen.insert(h.clone()) {
                local_host_candidates.push(h);
            }
        }
    }
    for h in &payload_local_hostnames {
        if local_seen.insert(h.clone()) {
            local_host_candidates.push(h.clone());
        }
    }
    for h in default_local_hostnames {
        let s = h.to_string();
        if local_seen.insert(s.clone()) {
            local_host_candidates.push(s);
        }
    }
    local_host_candidates.truncate(24);

    // Build local targets
    let mut local_targets: Vec<(String, u16)> = Vec::new();
    let should_scan_local = scan_scope == "all" || scan_scope == "local-hostnames";
    if should_scan_local {
        for host in &local_host_candidates {
            for &port in &target_ports {
                local_targets.push((host.clone(), port));
            }
        }
    }

    // Build subnet IP candidates
    let mut subnet_host_candidates = if scan_scope == "all" || scan_scope == "subnet" {
        if forced_host_is_ipv4 {
            if let Some(prefix) = to_subnet_prefix(forced_host.unwrap()) {
                build_ip_candidates_from_prefixes(&[prefix])
            } else {
                Vec::new()
            }
        } else {
            let prefixes = get_local_subnet_prefixes();
            build_ip_candidates_from_prefixes(&prefixes)
        }
    } else {
        Vec::new()
    };

    // Fallback: derive subnets from seed IPs if no interfaces found
    if subnet_host_candidates.is_empty() && (scan_scope == "all" || scan_scope == "subnet") {
        let mut seed_prefixes = HashSet::new();
        if forced_host_is_ipv4 {
            if let Some(prefix) = forced_host.and_then(to_subnet_prefix) {
                seed_prefixes.insert(prefix);
            }
        }
        for ip in normalize_ipv4_candidates(payload.get("excludeHosts")) {
            if let Some(prefix) = to_subnet_prefix(&ip) {
                seed_prefixes.insert(prefix);
            }
        }
        for ip in normalize_ipv4_candidates(payload.get("seedIps")) {
            if let Some(prefix) = to_subnet_prefix(&ip) {
                seed_prefixes.insert(prefix);
            }
        }
        if !seed_prefixes.is_empty() {
            let prefixes: Vec<String> = seed_prefixes.into_iter().collect();
            subnet_host_candidates = build_ip_candidates_from_prefixes(&prefixes);
        }
    }

    // Build excluded hosts set
    let exclude_hosts_hn = normalize_hostname_candidates(payload.get("excludeHosts"));
    let exclude_ipv4 = normalize_ipv4_candidates(payload.get("excludeHosts"));
    let excluded: HashSet<String> = exclude_hosts_hn.into_iter().chain(exclude_ipv4).collect();

    // Build subnet targets
    let mut subnet_targets: Vec<(String, u16)> = Vec::new();
    for ip in &subnet_host_candidates {
        if excluded.contains(ip) {
            continue;
        }
        for &port in &target_ports {
            subnet_targets.push((ip.clone(), port));
        }
    }

    let progressive = payload
        .get("progressive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let probe_timeout_ms = clamp_u64(payload.get("probeTimeoutMs"), 1200, 350, 8000);
    let local_concurrency = clamp_u64(
        payload.get("localConcurrency"),
        if forced_host.is_some() { 8 } else { 20 },
        4,
        64,
    ) as usize;
    // Windows Defender Network Inspection and similar AV products treat high
    // volumes of concurrent outbound TCP SYN packets to different hosts as a
    // port scan and may terminate the process (Windows Event 1005).  Keep the
    // concurrent socket count well below the heuristic threshold on Windows.
    #[cfg(target_os = "windows")]
    let (subnet_concurrency_default, subnet_concurrency_max): (u64, u64) =
        if forced_host.is_some() { (8, 24) } else { (24, 48) };
    #[cfg(not(target_os = "windows"))]
    let (subnet_concurrency_default, subnet_concurrency_max): (u64, u64) =
        if forced_host.is_some() { (12, 64) } else { (84, 160) };
    let subnet_concurrency = clamp_u64(
        payload.get("subnetConcurrency"),
        subnet_concurrency_default,
        4,
        subnet_concurrency_max,
    ) as usize;
    let batch_start = clamp_u64(payload.get("batchStart"), 0, 0, u64::MAX) as usize;
    // Smaller default batch on Windows: fewer tasks spawned per call means
    // fewer pending socket handles in the OS at any one time.
    #[cfg(target_os = "windows")]
    let batch_size = clamp_u64(payload.get("batchSize"), 64, 8, 128) as usize;
    #[cfg(not(target_os = "windows"))]
    let batch_size = clamp_u64(payload.get("batchSize"), 96, 8, 256) as usize;

    log_nanodlp_filter_debug(
        "discover/request",
        debug_filter,
        json!({
            "scanScope": scan_scope,
            "requestedModelHint": requested_model_hint,
            "requestedNetworkFilter": requested_network_filter,
            "forcedHost": forced_host,
            "targetPorts": target_ports,
            "localTargetCount": local_targets.len(),
            "subnetTargetCount": subnet_targets.len(),
            "progressive": progressive,
        }),
    );

    // Scan local hostnames with a longer minimum timeout
    let local_timeout = probe_timeout_ms.max(1500);
    let mut found = probe_batch(local_targets.clone(), local_concurrency, local_timeout).await;
    if let Some(expected_filter) = requested_network_filter.as_deref() {
        let mut filtered = Vec::with_capacity(found.len());
        for device in found {
            let host = device.get("ipAddress").and_then(|v| v.as_str()).unwrap_or("");
            let port = device.get("port").and_then(|v| v.as_u64()).and_then(|p| u16::try_from(p).ok()).unwrap_or(80);
            let machine_name = resolve_device_machine_name(host, port, 2500).await;
            let normalized_machine_name = machine_name.as_deref().map(normalize_machine_name);
            let normalized_expected = normalize_machine_name(expected_filter);
            let known_network_filter = machine_name
                .as_deref()
                .and_then(resolve_known_network_filter);
            let normalized_known_network_filter = known_network_filter
                .as_deref()
                .map(normalize_machine_name);
            let matched = normalized_machine_name
                .as_deref()
                .map(|name| name == normalized_expected)
                .unwrap_or(false);
            let explicit_known_filter_mismatch = normalized_known_network_filter
                .as_deref()
                .map(|known| known != normalized_expected)
                .unwrap_or(false);
            let model_hint_fallback = device_matches_requested_model_hint(&device, requested_model_hint);
            let accepted = matched || (!explicit_known_filter_mismatch && model_hint_fallback);
            log_nanodlp_filter_debug(
                if matched {
                    "discover/match"
                } else if explicit_known_filter_mismatch {
                    "discover/reject"
                } else if model_hint_fallback {
                    "discover/fallback"
                } else {
                    "discover/reject"
                },
                debug_filter,
                json!({
                    "phase": "local-hostnames",
                    "host": host,
                    "port": port,
                    "machineName": machine_name,
                    "normalizedMachineName": normalized_machine_name,
                    "knownNetworkFilter": known_network_filter,
                    "normalizedKnownNetworkFilter": normalized_known_network_filter,
                    "expectedFilter": expected_filter,
                    "normalizedExpectedFilter": normalized_expected,
                    "requestedModelHint": requested_model_hint,
                    "modelHintFallback": model_hint_fallback,
                    "reason": if matched {
                        "network-filter-match"
                    } else if explicit_known_filter_mismatch {
                        "explicit-known-filter-mismatch"
                    } else if model_hint_fallback {
                        "model-hint-fallback"
                    } else {
                        "network-filter-mismatch"
                    },
                }),
            );
            if accepted {
                filtered.push(device);
            }
        }
        found = filtered;
    }
    if requested_network_filter.is_none() {
        if let Some(expected) = requested_model_hint {
            found.retain(|device| {
                let model = device.get("printerModel").and_then(|v| v.as_str()).unwrap_or("");
                let normalized = normalize_model_name(model);
                if expected == "athena-2" {
                    normalized.contains("athena 2") || normalized.contains("athena2")
                } else {
                    normalized.contains("athena")
                        && !normalized.contains("athena 2")
                        && !normalized.contains("athena2")
                }
            });
        }
    }

    // Progressive subnet scanning
    if progressive && scan_scope == "subnet" {
        let total_endpoints = subnet_targets.len();
        let start = batch_start.min(total_endpoints);
        let end = total_endpoints.min(start + batch_size);
        let batch_targets = subnet_targets[start..end].to_vec();

        let mut subnet_found =
            probe_batch(batch_targets, subnet_concurrency, probe_timeout_ms).await;

        if let Some(expected_filter) = requested_network_filter.as_deref() {
            let mut filtered = Vec::with_capacity(subnet_found.len());
            for device in subnet_found {
                let host = device.get("ipAddress").and_then(|v| v.as_str()).unwrap_or("");
                let port = device.get("port").and_then(|v| v.as_u64()).and_then(|p| u16::try_from(p).ok()).unwrap_or(80);
                let machine_name = resolve_device_machine_name(host, port, 2500).await;
                let normalized_machine_name = machine_name.as_deref().map(normalize_machine_name);
                let normalized_expected = normalize_machine_name(expected_filter);
                let known_network_filter = machine_name
                    .as_deref()
                    .and_then(resolve_known_network_filter);
                let normalized_known_network_filter = known_network_filter
                    .as_deref()
                    .map(normalize_machine_name);
                let matched = normalized_machine_name
                    .as_deref()
                    .map(|name| name == normalized_expected)
                    .unwrap_or(false);
                let explicit_known_filter_mismatch = normalized_known_network_filter
                    .as_deref()
                    .map(|known| known != normalized_expected)
                    .unwrap_or(false);
                let model_hint_fallback = device_matches_requested_model_hint(&device, requested_model_hint);
                let accepted = matched || (!explicit_known_filter_mismatch && model_hint_fallback);
                log_nanodlp_filter_debug(
                    if matched {
                        "discover/match"
                    } else if explicit_known_filter_mismatch {
                        "discover/reject"
                    } else if model_hint_fallback {
                        "discover/fallback"
                    } else {
                        "discover/reject"
                    },
                    debug_filter,
                    json!({
                        "phase": "subnet-progressive",
                        "host": host,
                        "port": port,
                        "machineName": machine_name,
                        "normalizedMachineName": normalized_machine_name,
                        "knownNetworkFilter": known_network_filter,
                        "normalizedKnownNetworkFilter": normalized_known_network_filter,
                        "expectedFilter": expected_filter,
                        "normalizedExpectedFilter": normalized_expected,
                        "requestedModelHint": requested_model_hint,
                        "modelHintFallback": model_hint_fallback,
                        "reason": if matched {
                            "network-filter-match"
                        } else if explicit_known_filter_mismatch {
                            "explicit-known-filter-mismatch"
                        } else if model_hint_fallback {
                            "model-hint-fallback"
                        } else {
                            "network-filter-mismatch"
                        },
                    }),
                );
                if accepted {
                    filtered.push(device);
                }
            }
            subnet_found = filtered;
        }

        if requested_network_filter.is_none() {
            if let Some(expected) = requested_model_hint {
                subnet_found.retain(|device| {
                    let model = device.get("printerModel").and_then(|v| v.as_str()).unwrap_or("");
                    let normalized = normalize_model_name(model);
                    if expected == "athena-2" {
                        normalized.contains("athena 2") || normalized.contains("athena2")
                    } else {
                        normalized.contains("athena")
                            && !normalized.contains("athena 2")
                            && !normalized.contains("athena2")
                    }
                });
            }
        }

        let local_ips: HashSet<String> = found
            .iter()
            .filter_map(|d| {
                d.get("ipAddress")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect();
        subnet_found.retain(|d| {
            let ip = d.get("ipAddress").and_then(|v| v.as_str()).unwrap_or("");
            !local_ips.contains(ip)
        });
        found.extend(subnet_found);

        return (
            200,
            json!({
                "mode": "nanodlp",
                "devices": found,
                "scannedHosts": subnet_host_candidates.len(),
                "scannedEndpoints": end,
                "scannedLocalHostnames": 0,
                "scannedSubnetHosts": subnet_host_candidates.len(),
                "scanScope": scan_scope,
                "progressive": true,
                "totalEndpoints": total_endpoints,
                "batchStart": start,
                "batchSize": end - start,
                "nextBatchStart": end,
                "done": end >= total_endpoints,
            }),
        );
    }

    // Full subnet scanning
    if !subnet_targets.is_empty() {
        let local_ips: HashSet<String> = found
            .iter()
            .filter_map(|d| {
                d.get("ipAddress")
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect();
        let mut subnet_found =
            probe_batch(subnet_targets.clone(), subnet_concurrency, probe_timeout_ms).await;
        if let Some(expected_filter) = requested_network_filter.as_deref() {
            let mut filtered = Vec::with_capacity(subnet_found.len());
            for device in subnet_found {
                let host = device.get("ipAddress").and_then(|v| v.as_str()).unwrap_or("");
                let port = device.get("port").and_then(|v| v.as_u64()).and_then(|p| u16::try_from(p).ok()).unwrap_or(80);
                let machine_name = resolve_device_machine_name(host, port, 2500).await;
                let normalized_machine_name = machine_name.as_deref().map(normalize_machine_name);
                let normalized_expected = normalize_machine_name(expected_filter);
                let known_network_filter = machine_name
                    .as_deref()
                    .and_then(resolve_known_network_filter);
                let normalized_known_network_filter = known_network_filter
                    .as_deref()
                    .map(normalize_machine_name);
                let matched = normalized_machine_name
                    .as_deref()
                    .map(|name| name == normalized_expected)
                    .unwrap_or(false);
                let explicit_known_filter_mismatch = normalized_known_network_filter
                    .as_deref()
                    .map(|known| known != normalized_expected)
                    .unwrap_or(false);
                let model_hint_fallback = device_matches_requested_model_hint(&device, requested_model_hint);
                let accepted = matched || (!explicit_known_filter_mismatch && model_hint_fallback);
                log_nanodlp_filter_debug(
                    if matched {
                        "discover/match"
                    } else if explicit_known_filter_mismatch {
                        "discover/reject"
                    } else if model_hint_fallback {
                        "discover/fallback"
                    } else {
                        "discover/reject"
                    },
                    debug_filter,
                    json!({
                        "phase": "subnet-full",
                        "host": host,
                        "port": port,
                        "machineName": machine_name,
                        "normalizedMachineName": normalized_machine_name,
                        "knownNetworkFilter": known_network_filter,
                        "normalizedKnownNetworkFilter": normalized_known_network_filter,
                        "expectedFilter": expected_filter,
                        "normalizedExpectedFilter": normalized_expected,
                        "requestedModelHint": requested_model_hint,
                        "modelHintFallback": model_hint_fallback,
                        "reason": if matched {
                            "network-filter-match"
                        } else if explicit_known_filter_mismatch {
                            "explicit-known-filter-mismatch"
                        } else if model_hint_fallback {
                            "model-hint-fallback"
                        } else {
                            "network-filter-mismatch"
                        },
                    }),
                );
                if accepted {
                    filtered.push(device);
                }
            }
            subnet_found = filtered;
        }
        if requested_network_filter.is_none() {
            if let Some(expected) = requested_model_hint {
                subnet_found.retain(|device| {
                    let model = device.get("printerModel").and_then(|v| v.as_str()).unwrap_or("");
                    let normalized = normalize_model_name(model);
                    if expected == "athena-2" {
                        normalized.contains("athena 2") || normalized.contains("athena2")
                    } else {
                        normalized.contains("athena")
                            && !normalized.contains("athena 2")
                            && !normalized.contains("athena2")
                    }
                });
            }
        }
        subnet_found.retain(|d| {
            let ip = d.get("ipAddress").and_then(|v| v.as_str()).unwrap_or("");
            !local_ips.contains(ip)
        });
        found.extend(subnet_found);
    }

    (
        200,
        json!({
            "mode": "nanodlp",
            "devices": found,
            "scannedHosts": local_host_candidates.len() + subnet_host_candidates.len(),
            "scannedEndpoints": local_targets.len() + subnet_targets.len(),
            "scannedLocalHostnames": local_host_candidates.len(),
            "scannedSubnetHosts": subnet_host_candidates.len(),
            "scanScope": scan_scope,
        }),
    )
}

// ---------------------------------------------------------------------------
// NanoDLP: materials
// ---------------------------------------------------------------------------

async fn nanodlp_materials(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => return (400, json!({ "error": "Invalid host or IP address" })),
    };
    let port = resolve_port(payload.get("port"), parsed.1);
    let base_url = build_base_url(&parsed.0, port);

    let result: Result<Value, String> = async {
        let resp = http_client()
            .get(format!("{base_url}/json/db/profiles.json"))
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(10))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if resp.status().as_u16() != 200 {
            return Ok(json!({
                "ipAddress": parsed.0,
                "port": port,
                "materials": [],
                "error": format!("HTTP {}", resp.status()),
            }));
        }

        let decoded: Value = resp.json().await.map_err(|e| e.to_string())?;
        let entries = extract_list(&decoded, &["profiles", "data"]);
        let mut seen = HashSet::new();
        let mut materials = Vec::new();

        for entry in entries {
            if !entry.is_object() {
                continue;
            }
            let mut merged = entry.clone();
            if let Some(custom) = entry.get("CustomValues").and_then(|v| v.as_object()) {
                if let Some(obj) = merged.as_object_mut() {
                    for (k, v) in custom {
                        obj.entry(k.clone()).or_insert_with(|| v.clone());
                    }
                }
            }
            let id = match resolve_profile_id(&merged) {
                Some(id) if !seen.contains(&id) => id,
                _ => continue,
            };
            let name = resolve_profile_name(&merged);
            let locked = detect_locked_profile(&name, &merged);
            materials.push(json!({
                "id": id,
                "name": name,
                "locked": locked,
                "meta": merged,
            }));
            seen.insert(id);
        }

        Ok(json!({
            "ipAddress": parsed.0,
            "port": port,
            "materials": materials,
        }))
    }
    .await;

    match result {
        Ok(body) => (200, body),
        Err(message) => (
            200,
            json!({
                "ipAddress": parsed.0,
                "port": port,
                "materials": [],
                "error": message,
            }),
        ),
    }
}

// ---------------------------------------------------------------------------
// NanoDLP: materials/edit
// ---------------------------------------------------------------------------

async fn nanodlp_materials_edit(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Invalid host or IP address" }),
            )
        }
    };
    let profile_id = payload
        .get("profileId")
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
        .filter(|&id| id > 0);
    let profile_id = match profile_id {
        Some(id) => id,
        None => return (400, json!({ "ok": false, "error": "Invalid profileId" })),
    };
    let fields = match payload.get("fields").and_then(|v| v.as_object()) {
        Some(f) => f,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Missing fields payload" }),
            )
        }
    };
    let port = resolve_port(payload.get("port"), parsed.1);
    let base_url = build_base_url(&parsed.0, port);

    let mut form_data = HashMap::new();
    for (key, value) in fields {
        let v = match value {
            Value::Null => continue,
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            other => other.to_string(),
        };
        form_data.insert(key.clone(), v);
    }

    let result: Result<(u16, Value), String> = async {
        let resp = http_client()
            .post(format!("{base_url}/profile/edit/simple/{profile_id}"))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&form_data)
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status().as_u16();
        let response_text = resp.text().await.unwrap_or_default();
        let response_json: Option<Value> = serde_json::from_str(&response_text).ok();

        if status != 200 && status != 201 {
            return Ok((
                502,
                json!({
                    "ok": false,
                    "ipAddress": parsed.0,
                    "port": port,
                    "status": status,
                    "error": format!("HTTP {status}"),
                    "response": response_json.unwrap_or(Value::String(response_text)),
                }),
            ));
        }
        Ok((
            200,
            json!({
                "ok": true,
                "ipAddress": parsed.0,
                "port": port,
                "profileId": profile_id,
                "response": response_json.unwrap_or(Value::String(response_text)),
            }),
        ))
    }
    .await;

    match result {
        Ok((status, body)) => (status, body),
        Err(message) => (
            500,
            json!({
                "ok": false,
                "ipAddress": parsed.0,
                "port": port,
                "error": message,
            }),
        ),
    }
}

// ---------------------------------------------------------------------------
// NanoDLP: job/import
// ---------------------------------------------------------------------------

async fn nanodlp_job_import(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Invalid host or IP address" }),
            )
        }
    };
    let port = resolve_port(payload.get("port"), parsed.1);
    let zip_base64 = payload
        .get("zipBase64")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let zip_file_path = payload
        .get("zipFilePath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if zip_base64.is_empty() && zip_file_path.is_empty() {
        return (
            400,
            json!({ "ok": false, "error": "zipBase64 payload or zipFilePath is required" }),
        );
    }

    let path_raw = payload
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let path = if path_raw.is_empty() {
        "dragonfruit_job".to_string()
    } else {
        path_raw
    };
    let profile_id = payload
        .get("profileId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if profile_id.is_empty() {
        return (
            400,
            json!({ "ok": false, "error": "profileId is required for NanoDLP import" }),
        );
    }
    let upload_id = payload
        .get("uploadId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let host_lower = parsed.0.to_lowercase();
    let is_localhost =
        host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower.starts_with("127.");
    let usb_file_path = payload
        .get("usbFilePath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    // Prefer streaming upload directly from disk when zipFilePath is provided,
    // and fall back to base64 bytes for legacy callers.
    let mut upload_file_path: Option<String> = None;
    let mut zip_bytes: Option<Vec<u8>> = None;
    if !zip_file_path.is_empty() {
        match tokio::fs::metadata(&zip_file_path).await {
            Ok(meta) => {
                if meta.len() == 0 {
                    if zip_base64.is_empty() {
                        return (400, json!({ "ok": false, "error": "zipFilePath points to an empty file" }));
                    }
                } else {
                    upload_file_path = Some(zip_file_path.clone());
                }
            }
            Err(e) => {
                if zip_base64.is_empty() {
                    return (
                        400,
                        json!({ "ok": false, "error": format!("Failed to read zipFilePath: {e}") }),
                    );
                }
            }
        }
    }
    if upload_file_path.is_none() && !zip_base64.is_empty() {
        match base64::engine::general_purpose::STANDARD.decode(&zip_base64) {
            Ok(bytes) => zip_bytes = Some(bytes),
            Err(e) => {
                return (
                    400,
                    json!({ "ok": false, "error": format!("Invalid base64: {e}") }),
                )
            }
        }
    }
    if upload_file_path.is_none() && zip_bytes.as_ref().map(|bytes| bytes.is_empty()).unwrap_or(true) {
        return (
            400,
            json!({ "ok": false, "error": "Decoded job payload is empty" }),
        );
    }

    let base_url = build_base_url(&parsed.0, port);
    let upload_file_path_for_request = upload_file_path;
    let upload_bytes_for_request = zip_bytes;
    let upload_id_for_request = if upload_id.is_empty() {
        None
    } else {
        Some(upload_id)
    };
    let tracks_upload_progress =
        upload_id_for_request.is_some() && upload_file_path_for_request.is_some();

    let result: Result<(u16, Value), String> = async {
        let form = if is_localhost && !usb_file_path.is_empty() {
            reqwest::multipart::Form::new()
                .text("Path", path.clone())
                .text("ProfileID", profile_id.clone())
                .text("USBFile", usb_file_path)
        } else {
            let file_part = if let Some(upload_path) = upload_file_path_for_request.as_ref() {
                let file = tokio::fs::File::open(upload_path)
                    .await
                    .map_err(|e| format!("Failed to open upload file '{}': {e}", upload_path))?;
                let file_len = file
                    .metadata()
                    .await
                    .map_err(|e| format!("Failed to read upload file metadata '{}': {e}", upload_path))?
                    .len();
                let progress_counter = Arc::new(AtomicU64::new(0));
                if let Some(upload_id) = upload_id_for_request.as_deref() {
                    register_nanodlp_upload_progress(upload_id, file_len, progress_counter.clone());
                }
                let progress_counter_for_stream = progress_counter;
                let stream = tokio_util::io::ReaderStream::new(file).inspect_ok(move |chunk| {
                    progress_counter_for_stream
                        .fetch_add(chunk.len() as u64, Ordering::Relaxed);
                });
                let body = reqwest::Body::wrap_stream(stream);
                reqwest::multipart::Part::stream_with_length(body, file_len)
            } else {
                let bytes = upload_bytes_for_request
                    .clone()
                    .ok_or_else(|| "No upload payload bytes available".to_string())?;
                reqwest::multipart::Part::bytes(bytes)
            }
            .file_name(format!("{path}.nanodlp"))
            .mime_str("application/octet-stream")
            .map_err(|e| format!("Failed to build multipart: {e}"))?;
            reqwest::multipart::Form::new()
                .text("Path", path.clone())
                .text("ProfileID", profile_id.clone())
                .part("ZipFile", file_part)
        };

        let resp = http_client()
            .post(format!("{base_url}/plate/add"))
            .header(
                "Accept",
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            )
            .multipart(form)
            .timeout(Duration::from_secs(600))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let response_text = resp.text().await.unwrap_or_default();
        let response_json: Option<Value> = serde_json::from_str(&response_text).ok();

        // Extract plate ID from location header
        let location_plate_id = location
            .rsplit('/')
            .find_map(|segment| segment.trim().parse::<u64>().ok());

        // Fallback: try JSON body
        let body_plate_id = if location_plate_id.is_none() {
            response_json.as_ref().and_then(|j| {
                j.get("PlateID")
                    .or_else(|| j.get("plateId"))
                    .or_else(|| j.get("plate_id"))
                    .and_then(|v| v.as_u64())
            })
        } else {
            None
        };
        let plate_id = location_plate_id.or(body_plate_id);

        let is_ok = status == 200 || status == 201 || status == 302;
        if !is_ok {
            return Ok((
                502,
                json!({
                    "ok": false,
                    "ipAddress": parsed.0,
                    "port": port,
                    "status": status,
                    "error": format!("HTTP {status}"),
                    "response": response_json.unwrap_or(Value::String(response_text)),
                }),
            ));
        }

        Ok((
            200,
            json!({
                "ok": true,
                "ipAddress": parsed.0,
                "port": port,
                "path": path,
                "plateId": plate_id,
                "status": status,
                "location": location,
                "response": response_json.unwrap_or(Value::String(response_text)),
            }),
        ))
    }
    .await;

    if tracks_upload_progress {
        if let Some(upload_id) = upload_id_for_request.as_deref() {
            match &result {
                Ok((status, _body)) if *status == 200 => {
                    complete_nanodlp_upload_progress(upload_id, None);
                }
                Ok((_status, body)) => {
                    let message = body
                        .get("error")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| "NanoDLP upload failed".to_string());
                    complete_nanodlp_upload_progress(upload_id, Some(message));
                }
                Err(message) => {
                    complete_nanodlp_upload_progress(upload_id, Some(message.clone()));
                }
            }
        }
    }

    match result {
        Ok((status, body)) => (status, body),
        Err(message) => (
            500,
            json!({
                "ok": false,
                "ipAddress": parsed.0,
                "port": port,
                "error": message,
            }),
        ),
    }
}

// ---------------------------------------------------------------------------
// NanoDLP: plates/list/json
// ---------------------------------------------------------------------------

async fn nanodlp_job_upload_progress(payload: &Value) -> (u16, Value) {
    let upload_id = payload
        .get("uploadId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if upload_id.is_empty() {
        return (
            400,
            json!({
                "ok": false,
                "error": "uploadId is required",
            }),
        );
    }

    match snapshot_nanodlp_upload_progress(&upload_id) {
        Some(progress) => (
            200,
            json!({
                "ok": true,
                "upload": progress,
            }),
        ),
        None => (
            404,
            json!({
                "ok": false,
                "uploadId": upload_id,
                "error": "Upload progress not found",
            }),
        ),
    }
}

async fn nanodlp_plates_list_json(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Invalid host or IP address" }),
            )
        }
    };
    let port = resolve_port(payload.get("port"), parsed.1);
    let base_url = build_base_url(&parsed.0, port);

    let result: Result<(u16, Value), String> = async {
        let resp = http_client()
            .get(format!("{base_url}/plates/list/json"))
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if resp.status().as_u16() != 200 {
            return Ok((
                502,
                json!({
                    "ok": false,
                    "ipAddress": parsed.0,
                    "port": port,
                    "status": resp.status().as_u16(),
                    "error": format!("HTTP {}", resp.status()),
                    "plates": [],
                }),
            ));
        }

        let decoded: Value = resp.json().await.unwrap_or(Value::Null);
        if decoded.is_null() {
            return Ok((
                200,
                json!({
                    "ok": true,
                    "ipAddress": parsed.0,
                    "port": port,
                    "plates": [],
                }),
            ));
        }

        let entries = extract_list(&decoded, &["plates", "files", "data"]);
        let plates: Vec<Value> = entries.into_iter().filter(|e| e.is_object()).collect();

        let target_plate_id = payload
            .get("plateId")
            .and_then(|v| v.as_u64())
            .filter(|&id| id > 0);
        let target_job_name = payload
            .get("jobName")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let matched_plate = find_plate(&plates, target_plate_id, target_job_name);
        let metadata_ready = matched_plate
            .as_ref()
            .map(is_plate_metadata_ready)
            .unwrap_or(false);

        Ok((
            200,
            json!({
                "ok": true,
                "ipAddress": parsed.0,
                "port": port,
                "plates": plates,
                "matchedPlate": matched_plate,
                "metadataReady": metadata_ready,
            }),
        ))
    }
    .await;

    match result {
        Ok((status, body)) => (status, body),
        Err(message) => (
            500,
            json!({
                "ok": false,
                "ipAddress": parsed.0,
                "port": port,
                "error": message,
                "plates": [],
            }),
        ),
    }
}

// ---------------------------------------------------------------------------
// NanoDLP: printer/start
// ---------------------------------------------------------------------------

async fn nanodlp_printer_start(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Invalid host or IP address" }),
            )
        }
    };
    let plate_id = payload
        .get("plateId")
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
        .filter(|&id| id > 0);
    let plate_id = match plate_id {
        Some(id) => id,
        None => return (400, json!({ "ok": false, "error": "Invalid plateId" })),
    };
    let port = resolve_port(payload.get("port"), parsed.1);
    let base_url = build_base_url(&parsed.0, port)
        .trim_end_matches('/')
        .to_string();

    let result: Result<(u16, Value), String> = async {
        let resp = http_client()
            .get(format!("{base_url}/printer/start/{plate_id}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = resp.status().as_u16();
        if status != 200 && status != 302 {
            return Ok((
                502,
                json!({
                    "ok": false,
                    "ipAddress": parsed.0,
                    "port": port,
                    "plateId": plate_id,
                    "status": status,
                    "error": format!("HTTP {status}"),
                }),
            ));
        }
        Ok((
            200,
            json!({
                "ok": true,
                "ipAddress": parsed.0,
                "port": port,
                "plateId": plate_id,
                "status": status,
            }),
        ))
    }
    .await;

    match result {
        Ok((status, body)) => (status, body),
        Err(message) => (
            500,
            json!({
                "ok": false,
                "ipAddress": parsed.0,
                "port": port,
                "plateId": plate_id,
                "error": message,
            }),
        ),
    }
}

async fn nanodlp_plate_delete(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Invalid host or IP address" }),
            )
        }
    };

    let plate_id = payload
        .get("plateId")
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)))
        .filter(|&id| id > 0);
    let plate_id = match plate_id {
        Some(id) => id,
        None => return (400, json!({ "ok": false, "error": "Invalid plateId" })),
    };

    let port = resolve_port(payload.get("port"), parsed.1);
    let base_url = build_base_url(&parsed.0, port)
        .trim_end_matches('/')
        .to_string();

    let endpoint_paths = [
        format!("/plate/delete/{plate_id}"),
        format!("/plates/delete/{plate_id}"),
        format!("/plate/remove/{plate_id}"),
    ];

    let mut attempted: Vec<Value> = Vec::new();
    let mut last_error_message: Option<String> = None;

    if let Some((file_path, location)) = resolve_nanodlp_plate_file_target(&parsed.0, port, plate_id).await {
        let endpoint_path = "/file".to_string();
        match http_client()
            .request(reqwest::Method::DELETE, format!("{base_url}{endpoint_path}"))
            .query(&[("location", location), ("file_path", file_path.as_str())])
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                attempted.push(json!({
                    "method": "DELETE",
                    "path": endpoint_path,
                    "status": status,
                    "query": {
                        "location": location,
                        "file_path": file_path,
                    }
                }));

                if status == 200 || status == 202 || status == 204 || status == 302 {
                    return (
                        200,
                        json!({
                            "ok": true,
                            "ipAddress": parsed.0,
                            "port": port,
                            "plateId": plate_id,
                            "status": status,
                            "method": "DELETE",
                            "endpoint": endpoint_path,
                            "message": format!("Deleted plate #{plate_id}."),
                            "attempted": attempted,
                        }),
                    );
                }
            }
            Err(err) => {
                last_error_message = Some(err.to_string());
            }
        }
    }

    for endpoint_path in endpoint_paths {
        match http_client()
            .get(format!("{base_url}{endpoint_path}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                attempted.push(json!({
                    "method": "GET",
                    "path": endpoint_path,
                    "status": status,
                }));

                if status == 200 || status == 202 || status == 204 || status == 302 {
                    return (
                        200,
                        json!({
                            "ok": true,
                            "ipAddress": parsed.0,
                            "port": port,
                            "plateId": plate_id,
                            "status": status,
                            "method": "GET",
                            "endpoint": endpoint_path,
                            "message": format!("Deleted plate #{plate_id}."),
                            "attempted": attempted,
                        }),
                    );
                }
            }
            Err(err) => {
                last_error_message = Some(err.to_string());
            }
        }
    }

    let last_status = attempted
        .last()
        .and_then(|entry| entry.get("status"))
        .and_then(|value| value.as_u64())
        .and_then(|value| u16::try_from(value).ok());

    (
        if last_status.is_some() { 502 } else { 500 },
        json!({
            "ok": false,
            "ipAddress": parsed.0,
            "port": port,
            "plateId": plate_id,
            "status": last_status,
            "error": last_error_message.unwrap_or_else(|| format!("Delete plate command failed for plate #{plate_id}.")),
            "attempted": attempted,
        }),
    )
}

async fn nanodlp_printer_control(
    payload: &Value,
    action: &str,
    endpoint_paths: &[&str],
    success_message: &str,
    failure_label: &str,
    treat_any_response_as_success: bool,
) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Invalid host or IP address" }),
            )
        }
    };

    let port = resolve_port(payload.get("port"), parsed.1);
    let base_url = build_base_url(&parsed.0, port)
        .trim_end_matches('/')
        .to_string();

    let mut attempted: Vec<Value> = Vec::new();
    let mut last_network_error: Option<String> = None;

    for path in endpoint_paths {
        let normalized = path.trim();
        if normalized.is_empty() {
            continue;
        }

        match http_client()
            .get(format!("{base_url}{normalized}"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(resp) => {
                let status = resp.status().as_u16();
                attempted.push(json!({ "path": normalized, "status": status }));

                if status == 200 || status == 302 {
                    return (
                        200,
                        json!({
                            "ok": true,
                            "action": action,
                            "ipAddress": parsed.0,
                            "port": port,
                            "status": status,
                            "endpoint": normalized,
                            "message": success_message,
                        }),
                    );
                }
            }
            Err(error) => {
                last_network_error = Some(error.to_string());
            }
        }
    }

    let last_status = attempted
        .last()
        .and_then(|entry| entry.get("status"))
        .and_then(|value| value.as_u64())
        .map(|value| value as u16);

    if treat_any_response_as_success && !attempted.is_empty() {
        return (
            200,
            json!({
                "ok": true,
                "action": action,
                "ipAddress": parsed.0,
                "port": port,
                "status": last_status,
                "endpoint": attempted
                    .last()
                    .and_then(|entry| entry.get("path"))
                    .and_then(|value| value.as_str()),
                "message": success_message,
                "warning": format!(
                    "Command returned non-200 status ({}) but was treated as success for fail-safe behavior.",
                    last_status
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                ),
                "attempted": attempted,
            }),
        );
    }

    (
        if last_status.is_some() { 502 } else { 500 },
        json!({
            "ok": false,
            "action": action,
            "ipAddress": parsed.0,
            "port": port,
            "status": last_status,
            "error": last_network_error.unwrap_or_else(|| format!("{failure_label} not supported or failed on this NanoDLP host.")),
            "attempted": attempted,
        }),
    )
}

async fn nanodlp_printer_pause(payload: &Value) -> (u16, Value) {
    nanodlp_printer_control(
        payload,
        "pause",
        &["/printer/pause"],
        "Pause command sent to printer.",
        "Pause command",
        false,
    )
    .await
}

async fn nanodlp_printer_resume(payload: &Value) -> (u16, Value) {
    nanodlp_printer_control(
        payload,
        "resume",
        &["/printer/unpause", "/printer/resume"],
        "Resume command sent to printer.",
        "Resume command",
        false,
    )
    .await
}

async fn nanodlp_printer_cancel(payload: &Value) -> (u16, Value) {
    nanodlp_printer_control(
        payload,
        "cancel",
        &["/printer/stop", "/printer/cancel"],
        "Cancel command sent to printer.",
        "Cancel command",
        false,
    )
    .await
}

async fn nanodlp_printer_emergency_stop(payload: &Value) -> (u16, Value) {
    nanodlp_printer_control(
        payload,
        "emergency-stop",
        &[
            "/printer/force-stop",
            "/printer/emergency-stop",
            "/printer/emergency",
            "/printer/abort",
            "/printer/stop",
        ],
        "Emergency stop command sent to printer.",
        "Emergency stop command",
        true,
    )
    .await
}

// ---------------------------------------------------------------------------
// NanoDLP: printer/status
// ---------------------------------------------------------------------------

async fn nanodlp_printer_status(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Invalid host or IP address" }),
            )
        }
    };

    let port = resolve_port(payload.get("port"), parsed.1);

    match fetch_nanodlp_status(&parsed.0, port, 8000).await {
        Some(status) => (
            200,
            json!({
                "ok": true,
                "ipAddress": parsed.0,
                "port": port,
                "status": status,
            }),
        ),
        None => (
            200,
            json!({
                "ok": false,
                "ipAddress": parsed.0,
                "port": port,
                "error": "NanoDLP status endpoint unavailable.",
                "status": Value::Null,
            }),
        ),
    }
}

// ---------------------------------------------------------------------------
// NanoDLP: printer/webcam/info
// ---------------------------------------------------------------------------

async fn nanodlp_printer_webcam_info(payload: &Value) -> (u16, Value) {
    let raw_host = resolve_raw_host(payload);
    let parsed = match parse_host_and_port(&raw_host) {
        Some(p) => p,
        None => {
            return (
                400,
                json!({ "ok": false, "error": "Invalid host or IP address" }),
            )
        }
    };

    let port = resolve_port(payload.get("port"), parsed.1);

    let status = fetch_nanodlp_status(&parsed.0, port, 5000).await;
    let camera_info = fetch_athena_camera_info(&parsed.0, port).await;

    let (camera_online, camera_stream_url, camera_snapshot_url, camera_state_payload) = camera_info;

    match status {
        Some(status_payload) => {
            let status_candidates = resolve_nanodlp_webcam_candidates(&status_payload, &parsed.0, port);
            let had_status_candidates = !status_candidates.is_empty();
            let mut candidates = Vec::new();
            if let Some(stream) = camera_stream_url.clone() {
                candidates.push(stream);
            }
            if let Some(snapshot) = camera_snapshot_url.clone() {
                candidates.push(snapshot);
            }
            candidates.extend(status_candidates);

            let mut deduped = Vec::new();
            let mut seen = HashSet::new();
            for candidate in candidates {
                if seen.insert(candidate.clone()) {
                    deduped.push(candidate);
                }
            }

            let snapshot_url = deduped
                .iter()
                .find(|value| {
                    let v = value.to_lowercase();
                    v.contains("snapshot")
                        || v.contains(".jpg")
                        || v.contains(".jpeg")
                        || v.contains(".png")
                })
                .cloned()
                .or_else(|| deduped.first().cloned());
            let stream_url = deduped
                .iter()
                .find(|value| {
                    let v = value.to_lowercase();
                    v.contains("stream") || v.contains("mjpeg") || v.contains("video")
                })
                .cloned()
                .or_else(|| deduped.first().cloned());

            (
                200,
                json!({
                    "ok": true,
                    "available": !deduped.is_empty(),
                    "ipAddress": parsed.0,
                    "port": port,
                    "streamUrl": stream_url,
                    "snapshotUrl": snapshot_url,
                    "candidates": deduped,
                    "message": if camera_online {
                        "Athena camera stream available."
                    } else if had_status_candidates {
                        "Webcam endpoint detected."
                    } else {
                        "No webcam endpoint reported by this printer."
                    },
                    "status": status_payload,
                    "cameraState": camera_state_payload,
                }),
            )
        }
        None => {
            if camera_online {
                let mut candidates = Vec::new();
                if let Some(stream) = camera_stream_url.clone() {
                    candidates.push(stream);
                }
                if let Some(snapshot) = camera_snapshot_url.clone() {
                    candidates.push(snapshot);
                }

                (
                    200,
                    json!({
                        "ok": true,
                        "available": !candidates.is_empty(),
                        "ipAddress": parsed.0,
                        "port": port,
                        "streamUrl": camera_stream_url,
                        "snapshotUrl": camera_snapshot_url,
                        "candidates": candidates,
                        "message": "Athena camera stream available.",
                        "status": Value::Null,
                        "cameraState": camera_state_payload,
                    }),
                )
            } else {
                (
                    200,
                    json!({
                        "ok": false,
                        "available": false,
                        "ipAddress": parsed.0,
                        "port": port,
                        "streamUrl": Value::Null,
                        "snapshotUrl": Value::Null,
                        "candidates": [],
                        "message": "No camera endpoint available from this printer.",
                        "status": Value::Null,
                        "cameraState": camera_state_payload,
                    }),
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async fn handle_athena_network(operation: &str, payload: &Value) -> (u16, Value) {
    let normalized_operation = operation.trim().trim_start_matches('/').trim_end_matches('/');
    let op = normalized_operation
        .strip_prefix("nanodlp/")
        .unwrap_or(normalized_operation);

    match op {
        "connect" => nanodlp_connect(payload).await,
        "discover" => nanodlp_discover(payload).await,
        "materials" => nanodlp_materials(payload).await,
        "materials/edit" => nanodlp_materials_edit(payload).await,
        "job/import" => nanodlp_job_import(payload).await,
        "job/upload-progress" => nanodlp_job_upload_progress(payload).await,
        "plates/list/json" => nanodlp_plates_list_json(payload).await,
        "plate/delete" => nanodlp_plate_delete(payload).await,
        "printer/start" => nanodlp_printer_start(payload).await,
        "printer/pause" => nanodlp_printer_pause(payload).await,
        "printer/unpause" | "printer/resume" => nanodlp_printer_resume(payload).await,
        "printer/stop" | "printer/cancel" => nanodlp_printer_cancel(payload).await,
        "printer/force-stop" | "printer/emergency-stop" => nanodlp_printer_emergency_stop(payload).await,
        "printer/status" => nanodlp_printer_status(payload).await,
        "printer/webcam/info" => nanodlp_printer_webcam_info(payload).await,
        _ => (
            404,
            json!({ "error": format!("Unknown Athena NanoDLP operation: {normalized_operation}") }),
        ),
    }
}

fn plugin_operation_deadline(operation: &str) -> Duration {
    let normalized_operation = operation.trim().trim_start_matches('/').trim_end_matches('/');
    let op = normalized_operation
        .strip_prefix("nanodlp/")
        .unwrap_or(normalized_operation);

    if matches!(op, "job/import") {
        // Large uploads can legitimately take several minutes on slower networks.
        return Duration::from_secs(10 * 60);
    }

    #[cfg(target_os = "windows")]
    {
        Duration::from_secs(60)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Duration::from_secs(120)
    }
}

// ---------------------------------------------------------------------------
// Plugin dispatcher entry point
// ---------------------------------------------------------------------------

pub async fn dispatch_plugin_network_request(request_json: String) -> Result<PluginNetworkResponse, String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| format!("Invalid request JSON: {e}"))?;

    let plugin_id = request
        .get("pluginId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let operation = request
        .get("operation")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if plugin_id.is_empty() {
        return Ok(PluginNetworkResponse {
            status: 400,
            body: json!({ "error": "pluginId is required" }),
        });
    }
    if operation.is_empty() {
        return Ok(PluginNetworkResponse {
            status: 400,
            body: json!({ "error": "operation is required" }),
        });
    }

    // Spawn the operation as an independent tokio task so that any panic
    // inside a handler is caught as a JoinError rather than unwinding through
    // the Tauri command dispatcher and crashing the process.
    //
    // A hard wall timeout is also applied: subnet discovery opens O(concurrency)
    // TCP sockets simultaneously; if previous batches haven't finished when the
    // next poll arrives the total open-socket count can grow until Windows AV
    // heuristics decide the process is a port scanner and terminates it
    // (Windows Event 1005).  Returning a 503 early breaks the accumulation.
    let deadline = plugin_operation_deadline(&operation);

    let task = tokio::spawn(async move {
        match plugin_id.as_str() {
            "athena" => handle_athena_network(&operation, &request).await,
            _ => (
                404,
                json!({ "error": format!("Unknown network plugin: {plugin_id}") }),
            ),
        }
    });

    let (status, body) = match tokio::time::timeout(deadline, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(join_err)) => {
            log::error!("[plugin-network] Handler panicked: {join_err}");
            (
                500,
                json!({ "error": "Network operation encountered an internal error" }),
            )
        }
        Err(_elapsed) => {
            log::warn!(
                "[plugin-network] Operation timed out after {}s",
                deadline.as_secs()
            );
            (
                503,
                json!({ "error": "Network operation timed out" }),
            )
        }
    };

    Ok(PluginNetworkResponse { status, body })
}
