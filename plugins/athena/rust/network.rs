use base64::Engine;
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tokio::sync::Semaphore;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn http_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(4)
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
    let hostname = resolve_status_hostname(&status);
    let printer_name = resolve_printer_name(&status);
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

    match fetch_nanodlp_status(&parsed.0, port, 5000).await {
        Some(status) => {
            let hostname = resolve_status_hostname(&status);
            let printer_name = resolve_printer_name(&status);
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
            (
                200,
                json!({
                    "connected": true,
                    "mode": "nanodlp",
                    "hostName": hostname,
                    "printerName": printer_name,
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
    let subnet_concurrency = clamp_u64(
        payload.get("subnetConcurrency"),
        if forced_host.is_some() { 12 } else { 84 },
        8,
        160,
    ) as usize;
    let batch_start = clamp_u64(payload.get("batchStart"), 0, 0, u64::MAX) as usize;
    let batch_size = clamp_u64(payload.get("batchSize"), 96, 8, 256) as usize;

    // Scan local hostnames with a longer minimum timeout
    let local_timeout = probe_timeout_ms.max(1500);
    let mut found = probe_batch(local_targets.clone(), local_concurrency, local_timeout).await;

    // Progressive subnet scanning
    if progressive && scan_scope == "subnet" {
        let total_endpoints = subnet_targets.len();
        let start = batch_start.min(total_endpoints);
        let end = total_endpoints.min(start + batch_size);
        let batch_targets = subnet_targets[start..end].to_vec();

        let mut subnet_found =
            probe_batch(batch_targets, subnet_concurrency, probe_timeout_ms).await;

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

    let host_lower = parsed.0.to_lowercase();
    let is_localhost =
        host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower.starts_with("127.");
    let usb_file_path = payload
        .get("usbFilePath")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    // Read zip bytes from file path or base64
    let mut zip_bytes: Option<Vec<u8>> = None;
    if !zip_file_path.is_empty() {
        match tokio::fs::read(&zip_file_path).await {
            Ok(bytes) => zip_bytes = Some(bytes),
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
    if zip_bytes.is_none() && !zip_base64.is_empty() {
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
    let zip_bytes = match zip_bytes {
        Some(bytes) if !bytes.is_empty() => bytes,
        _ => {
            return (
                400,
                json!({ "ok": false, "error": "Decoded job payload is empty" }),
            )
        }
    };

    let base_url = build_base_url(&parsed.0, port);

    let result: Result<(u16, Value), String> = async {
        let form = if is_localhost && !usb_file_path.is_empty() {
            reqwest::multipart::Form::new()
                .text("Path", path.clone())
                .text("ProfileID", profile_id.clone())
                .text("USBFile", usb_file_path)
        } else {
            let file_part = reqwest::multipart::Part::bytes(zip_bytes)
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
            .timeout(Duration::from_secs(300))
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

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async fn handle_athena_network(operation: &str, payload: &Value) -> (u16, Value) {
    let op = operation.strip_prefix("nanodlp/").unwrap_or("");
    match op {
        "connect" => nanodlp_connect(payload).await,
        "discover" => nanodlp_discover(payload).await,
        "materials" => nanodlp_materials(payload).await,
        "materials/edit" => nanodlp_materials_edit(payload).await,
        "job/import" => nanodlp_job_import(payload).await,
        "plates/list/json" => nanodlp_plates_list_json(payload).await,
        "printer/start" => nanodlp_printer_start(payload).await,
        _ => (
            404,
            json!({ "error": format!("Unknown Athena NanoDLP operation: {operation}") }),
        ),
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

    let (status, body) = match plugin_id.as_str() {
        "athena" => handle_athena_network(&operation, &request).await,
        _ => (
            404,
            json!({ "error": format!("Unknown network plugin: {plugin_id}") }),
        ),
    };

    Ok(PluginNetworkResponse { status, body })
}
