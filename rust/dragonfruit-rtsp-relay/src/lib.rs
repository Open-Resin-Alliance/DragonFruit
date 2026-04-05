//! Native RTSP relay crate for DragonFruit desktop runtime.
//!
//! This crate starts a local WebSocket relay that pulls RTSP streams with ffmpeg,
//! transcodes to MPEG-TS/JSMpeg-compatible bytes, and fan-outs frames to subscribers.
//!
//! Key features:
//! - Deterministic UDP port reclaim per RTSP URL
//! - Persisted lease/session hints across app restarts
//! - UDP-first transport with fallback to TCP
//! - Optional Session header reuse for reconnect attempts

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use tungstenite::http::header::{HeaderValue, SEC_WEBSOCKET_PROTOCOL};
use tungstenite::handshake::server::{Request, Response};
use tungstenite::{accept_hdr, Message};
use url::form_urlencoded;

const DEFAULT_RELAY_PORT: u16 = 9334;
const RELAY_PATH: &str = "/api/rtsp-relay/stream";
const DEFAULT_LEASE_TTL_MS: u64 = 60_000;
const DEFAULT_PORT_BASE_MIN: u16 = 5000;
const DEFAULT_PORT_BASE_MAX: u16 = 64998;
const DEFAULT_LEASE_STORE_FILENAME: &str = "dragonfruit-rtsp-relay-leases.json";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Applies platform-specific process options for background ffmpeg tasks.
#[cfg(windows)]
fn configure_background_process(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Applies platform-specific process options for background ffmpeg tasks.
#[cfg(not(windows))]
fn configure_background_process(_command: &mut Command) {}

/// Persisted per-URL reclaim metadata used to stabilize reconnect behavior.
#[derive(Clone, Serialize, serde::Deserialize)]
struct LeaseRecord {
    base_port: u16,
    updated_at_ms: u64,
    session_id: Option<String>,
    client_port: Option<u16>,
    server_port: Option<u16>,
    transport_header: Option<String>,
    last_claim_status: Option<String>,
    last_claim_at_ms: Option<u64>,
}

/// JSON payload persisted to disk for relay lease state.
#[derive(serde::Deserialize, serde::Serialize)]
struct LeaseStoreDisk {
    leases: HashMap<String, LeaseRecord>,
}

/// In-memory lease cache with its backing file path.
struct LeaseStore {
    path: PathBuf,
    leases: HashMap<String, LeaseRecord>,
}

/// Public Tauri command response describing relay readiness and optional debug data.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayStatusResponse {
    pub ok: bool,
    pub message: String,
    pub ws_base_url: Option<String>,
    pub rtsp_debug_transport: Option<RtspDebugTransport>,
    pub rtsp_reclaim_debug: Option<RtspReclaimDebug>,
    pub error: Option<String>,
}

/// Transport-level debug information surfaced to the frontend monitor overlay.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtspDebugTransport {
    pub client_port: Option<u16>,
    pub server_port: Option<u16>,
    pub transport_header: Option<String>,
    pub updated_at_epoch_ms: Option<u64>,
}

/// Reclaim/session debug information surfaced to the frontend monitor overlay.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RtspReclaimDebug {
    pub active_session_id: Option<String>,
    pub client_rtp_port: Option<u16>,
    pub server_rtp_port: Option<u16>,
    pub last_claim_status: Option<String>,
    pub last_claim_at_ms: Option<u64>,
    pub updated_at_ms: Option<u64>,
}

static RELAY_MANAGER: OnceLock<Arc<RelayManager>> = OnceLock::new();
static LEASE_STORE: OnceLock<Mutex<LeaseStore>> = OnceLock::new();

/// Ensures the relay manager is running and returns stream/reclaim diagnostics.
///
/// If `rtsp_url` is supplied and valid, this eagerly creates/initializes stream state
/// and returns lease-backed transport/reclaim debug snapshots.
pub fn ensure_rtsp_relay_status(rtsp_url: Option<&str>) -> RelayStatusResponse {
    let manager = match ensure_manager_started() {
        Ok(manager) => manager,
        Err(error) => {
            return RelayStatusResponse {
                ok: false,
                message: "Failed to initialize native RTSP relay.".to_string(),
                ws_base_url: None,
                rtsp_debug_transport: None,
                rtsp_reclaim_debug: None,
                error: Some(error),
            }
        }
    };

    if let Some(url) = rtsp_url {
        let normalized = url.trim();
        if !is_safe_rtsp_url(normalized) {
            return RelayStatusResponse {
                ok: false,
                message: "Invalid RTSP URL.".to_string(),
                ws_base_url: None,
                rtsp_debug_transport: None,
                rtsp_reclaim_debug: None,
                error: Some("Expected rtsp:// or rtsps:// URL".to_string()),
            };
        }

        manager.get_or_create_stream(normalized);

        let lease = get_or_create_lease_record(normalized);
        return RelayStatusResponse {
            ok: true,
            message: "Native RTSP relay endpoint ready.".to_string(),
            ws_base_url: Some(format!("ws://127.0.0.1:{}{}", manager.port, RELAY_PATH)),
            rtsp_debug_transport: Some(RtspDebugTransport {
                client_port: lease.client_port.or(Some(lease.base_port)),
                server_port: lease.server_port,
                transport_header: lease.transport_header,
                updated_at_epoch_ms: Some(lease.updated_at_ms),
            }),
            rtsp_reclaim_debug: Some(RtspReclaimDebug {
                active_session_id: lease.session_id,
                client_rtp_port: lease.client_port.or(Some(lease.base_port)),
                server_rtp_port: lease.server_port,
                last_claim_status: lease.last_claim_status,
                last_claim_at_ms: lease.last_claim_at_ms,
                updated_at_ms: Some(lease.updated_at_ms),
            }),
            error: None,
        };
    }

    RelayStatusResponse {
        ok: true,
        message: "Native RTSP relay endpoint ready.".to_string(),
        ws_base_url: Some(format!("ws://127.0.0.1:{}{}", manager.port, RELAY_PATH)),
        rtsp_debug_transport: None,
        rtsp_reclaim_debug: None,
        error: None,
    }
}

/// Process-level relay manager that owns stream relay instances keyed by RTSP URL.
struct RelayManager {
    port: u16,
    streams: Mutex<HashMap<String, Arc<StreamRelay>>>,
}

impl RelayManager {
    /// Gets an existing stream relay or creates one for `rtsp_url`.
    fn get_or_create_stream(&self, rtsp_url: &str) -> Arc<StreamRelay> {
        let mut guard = self.streams.lock().expect("relay stream map poisoned");
        if let Some(existing) = guard.get(rtsp_url) {
            return Arc::clone(existing);
        }

        let created = Arc::new(StreamRelay::new(rtsp_url.to_string()));
        guard.insert(rtsp_url.to_string(), Arc::clone(&created));
        created
    }
}

/// Single-URL stream relay with subscriber fan-out and ffmpeg pump lifecycle.
struct StreamRelay {
    rtsp_url: String,
    subscribers: Mutex<Vec<Sender<Vec<u8>>>>,
    running: AtomicBool,
}

impl StreamRelay {
    /// Creates a stream relay for one RTSP URL.
    fn new(rtsp_url: String) -> Self {
        Self {
            rtsp_url,
            subscribers: Mutex::new(Vec::new()),
            running: AtomicBool::new(false),
        }
    }

    /// Subscribes a WebSocket client receiver and starts ffmpeg pumping on first subscriber.
    fn subscribe(self: &Arc<Self>) -> Receiver<Vec<u8>> {
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        {
            let mut subscribers = self.subscribers.lock().expect("subscriber list poisoned");
            subscribers.push(tx);
        }

        if !self.running.swap(true, Ordering::SeqCst) {
            let relay = Arc::clone(self);
            thread::spawn(move || relay.pump_ffmpeg());
        }

        rx
    }

    /// Whether there are active stream subscribers.
    fn has_subscribers(&self) -> bool {
        let subscribers = self.subscribers.lock().expect("subscriber list poisoned");
        !subscribers.is_empty()
    }

    /// Broadcasts one transport chunk to all current subscribers.
    fn broadcast_chunk(&self, chunk: Vec<u8>) {
        let mut subscribers = self.subscribers.lock().expect("subscriber list poisoned");
        subscribers.retain(|sender| sender.send(chunk.clone()).is_ok());
    }

    /// Drops all subscribers (used on fatal ffmpeg spawn failures).
    fn clear_subscribers(&self) {
        let mut subscribers = self.subscribers.lock().expect("subscriber list poisoned");
        subscribers.clear();
    }

    /// Computes the ordered list of transports to attempt.
    ///
    /// Controlled via `DRAGONFRUIT_RTSP_TRANSPORT`.
    fn preferred_transports() -> Vec<&'static str> {
        let configured = std::env::var("DRAGONFRUIT_RTSP_TRANSPORT")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "auto".to_string());

        match configured.as_str() {
            "udp" => vec!["udp"],
            "tcp" => vec!["tcp"],
            "udp,tcp" | "auto" | "" => vec!["udp", "tcp"],
            "tcp,udp" => vec!["tcp", "udp"],
            _ => vec!["udp", "tcp"],
        }
    }

    /// Runs one ffmpeg attempt for a specific RTSP transport.
    ///
    /// Returns `Ok(true)` when media output was observed, `Ok(false)` when process
    /// completed with no media output, and `Err(())` when ffmpeg could not be spawned.
    fn run_ffmpeg_transport(&self, transport: &str, ffmpeg_binary: &str) -> Result<bool, ()> {
        let reclaim_enabled = reclaim_is_enabled();
        let lease = get_or_create_lease_record(&self.rtsp_url);
        let session_reuse_enabled = reclaim_session_header_reuse_enabled();
        let reclaim_session_id = normalize_session_id(lease.session_id.as_deref());

        let mut command = Command::new(ffmpeg_binary);
        command.arg("-rtsp_transport").arg(transport);
        if reclaim_enabled && transport == "udp" {
            command
                .arg("-min_port")
                .arg(lease.base_port.to_string())
                .arg("-max_port")
                .arg((lease.base_port + 1).to_string());
        }
        if reclaim_enabled && session_reuse_enabled {
            if let Some(session_id) = reclaim_session_id.as_deref() {
                command.arg("-headers").arg(format!("Session: {session_id}\r\n"));
            }
        }
        command
            .arg("-i")
            .arg(&self.rtsp_url)
            .arg("-f")
            .arg("mpegts")
            .arg("-codec:v")
            .arg("mpeg1video")
            .arg("-r")
            .arg("30")
            .arg("-")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure_background_process(&mut command);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                eprintln!(
                    "[dragonfruit-rtsp-relay] Failed to spawn ffmpeg (transport={transport}, binary={ffmpeg_binary}): {error}"
                );
                if reclaim_enabled {
                    update_lease_record(&self.rtsp_url, |record| {
                        record.last_claim_status = Some("ffmpeg-spawn-failed".to_string());
                        record.last_claim_at_ms = Some(now_epoch_ms());
                    });
                }
                return Err(());
            }
        };

        // Parse ffmpeg stderr in the background to update reclaim/session metadata.
        if let Some(stderr) = child.stderr.take() {
            let rtsp_url = self.rtsp_url.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stderr);
                let mut line = String::new();

                loop {
                    line.clear();
                    let read = reader.read_line(&mut line).unwrap_or(0);
                    if read == 0 {
                        break;
                    }

                    let normalized = line.trim();
                    if normalized.is_empty() {
                        continue;
                    }

                    // 454/session-not-found responses invalidate previously cached session hints.
                    if contains_session_not_found(normalized) {
                        update_lease_record(&rtsp_url, |record| {
                            record.session_id = None;
                            record.last_claim_status = Some("session-not-found".to_string());
                            record.last_claim_at_ms = Some(now_epoch_ms());
                        });
                        continue;
                    }

                    // Opportunistically capture Session IDs from ffmpeg output.
                    if let Some(session_id) = extract_session_id_from_log_line(normalized) {
                        update_lease_record(&rtsp_url, |record| {
                            if record.session_id.as_deref() != Some(session_id.as_str()) {
                                record.session_id = Some(session_id.clone());
                                record.last_claim_status = Some("session-recorded".to_string());
                                record.last_claim_at_ms = Some(now_epoch_ms());
                            }
                        });
                    }
                }
            });
        }

        let mut stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                let _ = child.kill();
                return Err(());
            }
        };

        let mut idle_since = Instant::now();
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut produced_any_output = false;

        loop {
            if !self.has_subscribers() {
                if idle_since.elapsed() > Duration::from_secs(5) {
                    let _ = child.kill();
                    break;
                }
            } else {
                idle_since = Instant::now();
            }

            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if read > 0 {
                        produced_any_output = true;
                        self.broadcast_chunk(buffer[..read].to_vec());
                    }
                }
                Err(_) => break,
            }
        }

        let _ = child.kill();
        let _ = child.wait();
        // Mark lease as actively playing once media output has been observed.
        if reclaim_enabled && produced_any_output {
            update_lease_record(&self.rtsp_url, |record| {
                record.client_port = Some(record.base_port);
                record.last_claim_status = Some("playing".to_string());
                record.last_claim_at_ms = Some(now_epoch_ms());
            });
        }
        Ok(produced_any_output)
    }

    /// Main relay loop that repeatedly tries configured transports while subscribers exist.
    fn pump_ffmpeg(self: Arc<Self>) {
        let ffmpeg_binary = resolve_ffmpeg_binary();
        let transports = Self::preferred_transports();

        'relay_loop: loop {
            if !self.has_subscribers() {
                break;
            }

            let mut spawn_failed = false;

            for transport in &transports {
                match self.run_ffmpeg_transport(transport, &ffmpeg_binary) {
                    Ok(has_output) => {
                        if has_output {
                            continue 'relay_loop;
                        }
                        if reclaim_is_enabled() && *transport == "udp" {
                            update_lease_record(&self.rtsp_url, |record| {
                                record.last_claim_status =
                                    Some("udp-no-output-fallback-tcp".to_string());
                                record.last_claim_at_ms = Some(now_epoch_ms());
                            });
                        }
                    }
                    Err(()) => {
                        spawn_failed = true;
                    }
                }
            }

            if spawn_failed {
                self.clear_subscribers();
                break;
            }

            thread::sleep(Duration::from_millis(750));
        }

        self.running.store(false, Ordering::SeqCst);
    }
}

/// Whether reclaim behavior is enabled.
fn reclaim_is_enabled() -> bool {
    parse_env_bool("DRAGONFRUIT_RTSP_RECLAIM", true)
}

/// Whether prior session IDs should be reused via `Session:` ffmpeg headers.
fn reclaim_session_header_reuse_enabled() -> bool {
    parse_env_bool("DRAGONFRUIT_RTSP_SESSION_HEADER_REUSE", true)
}

/// Lease TTL used to decide when a stored session hint should expire.
fn reclaim_lease_ttl_ms() -> u64 {
    std::env::var("DRAGONFRUIT_RTSP_LEASE_TTL_MS")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_LEASE_TTL_MS)
}

/// Shared bool parser for env flags.
fn parse_env_bool(name: &str, default_value: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !(normalized == "0"
                || normalized == "false"
                || normalized == "off"
                || normalized == "no")
        })
        .unwrap_or(default_value)
}

/// Resolves lease store path from env override or temp-directory default.
fn lease_store_path() -> PathBuf {
    if let Some(from_env) = std::env::var("DRAGONFRUIT_RTSP_LEASE_STORE_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(from_env);
    }

    std::env::temp_dir().join(DEFAULT_LEASE_STORE_FILENAME)
}

/// Global lease store singleton.
fn lease_store() -> &'static Mutex<LeaseStore> {
    LEASE_STORE.get_or_init(|| {
        let path = lease_store_path();
        let leases = load_lease_store(&path);
        Mutex::new(LeaseStore { path, leases })
    })
}

/// Loads persisted lease map from disk.
fn load_lease_store(path: &PathBuf) -> HashMap<String, LeaseRecord> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return HashMap::new(),
    };

    match serde_json::from_str::<LeaseStoreDisk>(&raw) {
        Ok(parsed) => parsed.leases,
        Err(_) => HashMap::new(),
    }
}

/// Persists the current lease map to disk.
fn save_lease_store(store: &LeaseStore) {
    let payload = LeaseStoreDisk {
        leases: store.leases.clone(),
    };

    if let Some(parent) = store.path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(serialized) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(&store.path, serialized);
    }
}

/// URL normalization used as lease-store key canonicalization.
fn normalize_lease_url(url: &str) -> String {
    url.trim().to_string()
}

/// Deterministic FNV-1a hash used for stable base-port selection.
fn fnv1a32(text: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in text.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

/// Creates an initial lease record for a URL with deterministic even base UDP port.
fn create_default_lease_record(url: &str) -> LeaseRecord {
    let normalized = normalize_lease_url(url);
    let span = u32::from(DEFAULT_PORT_BASE_MAX - DEFAULT_PORT_BASE_MIN);
    let offset = if span == 0 { 0 } else { fnv1a32(&normalized) % span };
    let mut base_port = DEFAULT_PORT_BASE_MIN + u16::try_from(offset).unwrap_or(0);
    if base_port % 2 != 0 {
        base_port = base_port.saturating_sub(1);
    }

    LeaseRecord {
        base_port,
        updated_at_ms: now_epoch_ms(),
        session_id: None,
        client_port: Some(base_port),
        server_port: None,
        transport_header: None,
        last_claim_status: None,
        last_claim_at_ms: None,
    }
}

/// Gets existing lease record or creates/persists a new default one.
fn get_or_create_lease_record(url: &str) -> LeaseRecord {
    let normalized = normalize_lease_url(url);
    let mut guard = lease_store().lock().expect("lease store poisoned");

    if let Some(existing) = guard.leases.get(&normalized).cloned() {
        return existing;
    }

    let created = create_default_lease_record(&normalized);
    guard.leases.insert(normalized, created.clone());
    save_lease_store(&guard);
    created
}

/// Updates and persists a lease record, applying TTL-based session expiry when needed.
fn update_lease_record(url: &str, mutator: impl FnOnce(&mut LeaseRecord)) -> LeaseRecord {
    let normalized = normalize_lease_url(url);
    let mut guard = lease_store().lock().expect("lease store poisoned");

    let mut record = guard
        .leases
        .get(&normalized)
        .cloned()
        .unwrap_or_else(|| create_default_lease_record(&normalized));

    mutator(&mut record);
    record.updated_at_ms = now_epoch_ms();

    if let Some(last_claim_at_ms) = record.last_claim_at_ms {
        let ttl_ms = reclaim_lease_ttl_ms();
        if ttl_ms > 0 && record.updated_at_ms.saturating_sub(last_claim_at_ms) > ttl_ms {
            record.session_id = None;
            record.last_claim_status = Some("lease-expired".to_string());
            record.last_claim_at_ms = Some(record.updated_at_ms);
        }
    }

    guard.leases.insert(normalized, record.clone());
    save_lease_store(&guard);
    record
}

/// Current UNIX epoch in milliseconds.
fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Normalizes optional session IDs by trimming and removing empties.
fn normalize_session_id(session: Option<&str>) -> Option<String> {
    session
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Detects ffmpeg log lines indicating stale/missing RTSP session state.
fn contains_session_not_found(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("session not found") || line.contains(" 454 ") || lower.contains("status 454")
}

/// Attempts to extract RTSP Session ID from one ffmpeg log line.
fn extract_session_id_from_log_line(line: &str) -> Option<String> {
    let marker = "Session:";
    let index = line.find(marker)?;
    let tail = line[(index + marker.len())..].trim();
    if tail.is_empty() {
        return None;
    }

    let candidate = tail
        .split(';')
        .next()
        .unwrap_or("")
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim();

    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

/// Lazily starts the relay listener thread and returns the global manager.
fn ensure_manager_started() -> Result<Arc<RelayManager>, String> {
    if let Some(manager) = RELAY_MANAGER.get() {
        return Ok(Arc::clone(manager));
    }

    let listener =
        bind_listener().map_err(|err| format!("Failed to bind relay listener: {err}"))?;
    let port = listener
        .local_addr()
        .map_err(|err| format!("Failed to resolve relay listener address: {err}"))?
        .port();

    let manager = Arc::new(RelayManager {
        port,
        streams: Mutex::new(HashMap::new()),
    });

    let manager_for_thread = Arc::clone(&manager);
    thread::spawn(move || {
        for incoming in listener.incoming() {
            let stream = match incoming {
                Ok(stream) => stream,
                Err(_) => continue,
            };

            let manager_ref = Arc::clone(&manager_for_thread);
            thread::spawn(move || {
                let _ = handle_ws_client(stream, manager_ref);
            });
        }
    });

    let _ = RELAY_MANAGER.set(Arc::clone(&manager));
    RELAY_MANAGER
        .get()
        .map(Arc::clone)
        .ok_or_else(|| "Failed to initialize relay manager".to_string())
}

/// Binds relay listener to default port with ephemeral fallback.
fn bind_listener() -> std::io::Result<TcpListener> {
    TcpListener::bind(("127.0.0.1", DEFAULT_RELAY_PORT))
        .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))
}

/// Handles one WebSocket client lifecycle.
///
/// Validates request path/query, wires stream subscription, sends JSMpeg header,
/// and forwards chunks until disconnect/timeout.
fn handle_ws_client(stream: TcpStream, manager: Arc<RelayManager>) -> Result<(), String> {
    let requested_rtsp = Arc::new(Mutex::new(None::<String>));
    let requested_rtsp_in_handshake = Arc::clone(&requested_rtsp);

    let mut websocket = accept_hdr(stream, move |request: &Request, mut response: Response| {
        if request.uri().path() != RELAY_PATH {
            return Err(http_error_response(404, "Not Found"));
        }

        let query = request.uri().query().unwrap_or("");
        let rtsp_url = form_urlencoded::parse(query.as_bytes())
            .find_map(|(key, value)| {
                if key == "url" {
                    Some(value.into_owned())
                } else {
                    None
                }
            })
            .unwrap_or_default();

        if !is_safe_rtsp_url(rtsp_url.as_str()) {
            return Err(http_error_response(400, "Invalid RTSP URL"));
        }

        if let Ok(mut lock) = requested_rtsp_in_handshake.lock() {
            *lock = Some(rtsp_url);
        }

        if let Some(header) = request.headers().get(SEC_WEBSOCKET_PROTOCOL) {
            if let Ok(protocols) = header.to_str() {
                if let Some(first_protocol) = protocols
                    .split(',')
                    .map(|value| value.trim())
                    .find(|value| !value.is_empty())
                {
                    if let Ok(protocol_value) = HeaderValue::from_str(first_protocol) {
                        response
                            .headers_mut()
                            .insert(SEC_WEBSOCKET_PROTOCOL, protocol_value);
                    }
                }
            }
        }

        Ok(response)
    })
    .map_err(|error| format!("WebSocket handshake failed: {error}"))?;

    let rtsp_url = requested_rtsp
        .lock()
        .map_err(|_| "WebSocket URL lock poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Missing RTSP URL".to_string())?;

    let relay = manager.get_or_create_stream(&rtsp_url);
    let receiver = relay.subscribe();

    websocket
        .send(Message::Binary(jsmpeg_header().to_vec()))
        .map_err(|error| format!("Failed to send JSMpeg stream header: {error}"))?;

    loop {
        match receiver.recv_timeout(Duration::from_secs(15)) {
            Ok(chunk) => {
                websocket
                    .send(Message::Binary(chunk))
                    .map_err(|error| format!("Failed sending relay frame: {error}"))?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if websocket.send(Message::Ping(Vec::new())).is_err() {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let _ = websocket.close(None);
    Ok(())
}

/// JSMpeg 8-byte magic header.
fn jsmpeg_header() -> [u8; 8] {
    let mut header = [0_u8; 8];
    header[0] = b'j';
    header[1] = b's';
    header[2] = b'm';
    header[3] = b'p';
    header[4] = 0;
    header[5] = 0;
    header[6] = 0;
    header[7] = 0;
    header
}

/// Builds a plain-text HTTP error response for handshake rejection.
fn http_error_response(status: u16, body: &str) -> tungstenite::http::Response<Option<String>> {
    tungstenite::http::Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(Some(body.to_string()))
        .unwrap_or_else(|_| tungstenite::http::Response::new(Some(body.to_string())))
}

/// Minimal RTSP URL validation.
fn is_safe_rtsp_url(candidate: &str) -> bool {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        return false;
    }

    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("rtsp://") || lower.starts_with("rtsps://")
}

/// Resolves ffmpeg executable path with env overrides and ffmpeg-sidecar support.
fn resolve_ffmpeg_binary() -> String {
    if let Some(from_env) = std::env::var("DRAGONFRUIT_FFMPEG_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return from_env;
    }

    if let Some(from_env) = std::env::var("FFMPEG_PATH")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return from_env;
    }

    if let Some(from_env) = std::env::var("FFMPEG")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return from_env;
    }

    let sidecar_path = ffmpeg_sidecar::paths::ffmpeg_path();
    let sidecar_binary = sidecar_path.to_string_lossy().to_string();

    if ffmpeg_binary_is_runnable(&sidecar_binary) {
        return sidecar_binary;
    }

    let auto_download_enabled = std::env::var("DRAGONFRUIT_FFMPEG_AUTODOWNLOAD")
        .ok()
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            !(normalized == "0" || normalized == "false" || normalized == "off" || normalized == "no")
        })
        .unwrap_or(true);

    if auto_download_enabled {
        if let Err(error) = ffmpeg_sidecar::download::auto_download() {
            eprintln!("[dragonfruit-rtsp-relay] ffmpeg-sidecar auto_download failed: {error}");
        }

        let refreshed = ffmpeg_sidecar::paths::ffmpeg_path().to_string_lossy().to_string();
        if ffmpeg_binary_is_runnable(&refreshed) {
            return refreshed;
        }
    }

    "ffmpeg".to_string()
}

/// Checks whether an ffmpeg binary candidate can execute `-version`.
fn ffmpeg_binary_is_runnable(binary: &str) -> bool {
    let trimmed = binary.trim();
    if trimmed.is_empty() {
        return false;
    }

    let mut command = Command::new(trimmed);
    command
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_background_process(&mut command);
    command.status().is_ok()
}
