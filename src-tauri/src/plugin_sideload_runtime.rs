//! Runs sideloaded plugin processes and routes their capability calls.
//!
//! The host half of the protocol in `docs/dev/plugins-sdk/protocol.md`: spawn the
//! payload, handshake, validate `ready` against the manifest, then send one
//! request at a time and correlate the answer by id.
//!
//! Today only `network` is routed. The process plumbing (spawn, handshake,
//! validation, idle shutdown, crash recovery) is capability-agnostic, so encoders
//! and file types reuse it rather than repeating it.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use dragonfruit_plugin_package as package;
use dragonfruit_plugin_sdk as sdk;
use serde_json::{json, Value};

use crate::plugin_registry::PluginNetworkResponse;
use crate::plugin_sideload;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// A plugin that has answered nothing for this long is stopped; the next request
/// starts a fresh process. Connectors hold sockets, so they should not live
/// forever on a machine that is not printing.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

type FrameStream = Receiver<Result<Option<sdk::Frame>, String>>;

struct RunningPlugin {
    child: Child,
    stdin: ChildStdin,
    frames: FrameStream,
    last_used: Instant,
}

type PluginSlot = Arc<Mutex<Option<RunningPlugin>>>;

static ROOT: OnceLock<PathBuf> = OnceLock::new();
static SLOTS: LazyLock<Mutex<HashMap<String, PluginSlot>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

/// Points the runtime at the installed-plugin directory. Called once at startup.
pub fn initialize(root: PathBuf) {
    let _ = ROOT.set(root);
}

/// Stops every plugin process. Called on app exit.
pub fn shutdown_all() {
    let Ok(mut slots) = SLOTS.lock() else {
        return;
    };
    for slot in slots.values() {
        if let Ok(mut guard) = slot.lock() {
            if let Some(mut plugin) = guard.take() {
                stop(&mut plugin);
            }
        }
    }
    slots.clear();
}

/// Routes a `plugin_network_request` payload to the sideloaded plugin that owns
/// its id.
///
/// `None` means "not a sideloaded plugin": the caller keeps whatever it would
/// have answered. Any failure inside the plugin comes back as a `5xx` response
/// rather than an IPC rejection, so the caller sees a status and a message.
pub fn handle_network_request(request_json: &str) -> Option<PluginNetworkResponse> {
    let root = ROOT.get()?;
    let request: Value = serde_json::from_str(request_json).ok()?;
    let plugin_id = request
        .get("pluginId")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())?;

    let manifest = plugin_sideload::installed_manifest(root, &plugin_id)?;
    if !manifest
        .capabilities
        .contains(&package::Capability::NetworkOperations)
    {
        return Some(PluginNetworkResponse {
            status: 403,
            body: json!({ "error": format!("plugin '{plugin_id}' does not declare networkOperations") }),
        });
    }

    Some(dispatch_network(root, &plugin_id, &manifest, request))
}

fn dispatch_network(
    root: &Path,
    plugin_id: &str,
    manifest: &package::Manifest,
    request: Value,
) -> PluginNetworkResponse {
    let slot = {
        let Ok(mut slots) = SLOTS.lock() else {
            return failure("plugin runtime is unavailable");
        };
        slots
            .entry(plugin_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone()
    };
    let Ok(mut guard) = slot.lock() else {
        return failure("plugin process lock is poisoned");
    };

    retire_if_idle(&mut guard);

    if guard.is_none() {
        match start(root, plugin_id, manifest) {
            Ok(plugin) => *guard = Some(plugin),
            Err(error) => {
                log::warn!("[plugin-runtime] {plugin_id}: {error}");
                return failure(&error);
            }
        }
    }

    let request_id = NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed);
    let Some(plugin) = guard.as_mut() else {
        return failure("plugin process is gone");
    };

    match exchange(plugin, request_id, request) {
        Ok((status, body)) => PluginNetworkResponse { status, body },
        Err(error) => {
            log::warn!("[plugin-runtime] {plugin_id}: {error}");
            // A protocol failure means the process is out of step or dead; drop it
            // so the next call starts clean instead of talking to a broken pipe.
            if let Some(mut dead) = guard.take() {
                stop(&mut dead);
            }
            failure(&error)
        }
    }
}

fn failure(message: &str) -> PluginNetworkResponse {
    PluginNetworkResponse {
        status: 502,
        body: json!({ "error": message }),
    }
}

fn retire_if_idle(slot: &mut Option<RunningPlugin>) {
    let idle = slot
        .as_ref()
        .map(|plugin| plugin.last_used.elapsed() >= IDLE_TIMEOUT)
        .unwrap_or(false);
    let exited = slot
        .as_mut()
        .and_then(|plugin| plugin.child.try_wait().ok().flatten())
        .is_some();
    if idle || exited {
        if let Some(mut plugin) = slot.take() {
            stop(&mut plugin);
        }
    }
}

fn exchange(
    plugin: &mut RunningPlugin,
    request_id: u64,
    request: Value,
) -> Result<(u16, Value), String> {
    let message = sdk::HostMessage::Network {
        id: request_id,
        request,
    };
    send(plugin, &message)?;
    plugin.last_used = Instant::now();

    let deadline = Instant::now() + REQUEST_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("plugin did not answer within 30 s".to_string());
        }
        match plugin.frames.recv_timeout(remaining) {
            Ok(Ok(Some(frame))) => match serde_json::from_slice::<sdk::PluginMessage>(&frame.payload) {
                Ok(sdk::PluginMessage::NetworkResult { id, status, body }) if id == request_id => {
                    return Ok((status, body));
                }
                // A stale answer for a request that already timed out.
                Ok(sdk::PluginMessage::NetworkResult { .. }) => continue,
                Ok(sdk::PluginMessage::Error { code, message }) => {
                    return Err(format!("plugin error {code}: {message}"));
                }
                Ok(other) => return Err(format!("unexpected plugin message: {other:?}")),
                Err(error) => return Err(format!("unreadable plugin message: {error}")),
            },
            Ok(Ok(None)) => return Err("plugin closed the control channel".to_string()),
            Ok(Err(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => {
                return Err("plugin did not answer within 30 s".to_string());
            }
            Err(RecvTimeoutError::Disconnected) => {
                return Err("plugin reader stopped".to_string());
            }
        }
    }
}

fn send(plugin: &mut RunningPlugin, message: &sdk::HostMessage) -> Result<(), String> {
    let payload = serde_json::to_vec(message).map_err(|error| format!("encode failed: {error}"))?;
    sdk::write_frame(&mut plugin.stdin, sdk::FrameKind::Json, &payload)
        .map_err(|error| format!("write failed: {error}"))
}

fn start(root: &Path, plugin_id: &str, manifest: &package::Manifest) -> Result<RunningPlugin, String> {
    let plugin_dir = root.join(plugin_id);
    let executable = resolve_executable(&plugin_dir.join("payload"))?;

    let mut child = Command::new(&executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start '{}': {error}", executable.display()))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "plugin stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "plugin stdout is unavailable".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        forward_stderr(stderr, plugin_id.to_string());
    }
    let frames = spawn_reader(stdout);

    let hello = sdk::HostMessage::Hello {
        proto: package::PROTOCOL_VERSION,
        transport: manifest.entry.transport,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let payload = serde_json::to_vec(&hello).map_err(|error| format!("encode failed: {error}"))?;
    sdk::write_frame(&mut stdin, sdk::FrameKind::Json, &payload)
        .map_err(|error| format!("handshake write failed: {error}"))?;

    let ready = match frames.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(Ok(Some(frame))) => serde_json::from_slice::<sdk::PluginMessage>(&frame.payload)
            .map_err(|error| format!("unreadable ready message: {error}"))?,
        Ok(Ok(None)) => return Err("plugin exited before the handshake".to_string()),
        Ok(Err(error)) => return Err(error),
        Err(_) => return Err("plugin did not answer the handshake within 10 s".to_string()),
    };
    validate_ready(&ready, manifest)?;

    Ok(RunningPlugin {
        child,
        stdin,
        frames,
        last_used: Instant::now(),
    })
}

fn validate_ready(ready: &sdk::PluginMessage, manifest: &package::Manifest) -> Result<(), String> {
    let sdk::PluginMessage::Ready {
        plugin_id,
        capabilities,
        formats,
        ..
    } = ready
    else {
        return Err(format!("expected ready, got {ready:?}"));
    };

    if plugin_id != &manifest.id {
        return Err(format!(
            "plugin identifies itself as '{plugin_id}' but the package is '{}'",
            manifest.id
        ));
    }
    for capability in capabilities {
        if !manifest.capabilities.contains(capability) {
            return Err(format!("plugin serves {capability:?}, which the manifest does not declare"));
        }
    }
    for format in formats {
        let declared = manifest
            .formats
            .iter()
            .any(|entry| entry.extensions.iter().any(|ext| ext == &format.ext));
        if !declared {
            return Err(format!("plugin claims '{}', which the manifest does not declare", format.ext));
        }
    }
    Ok(())
}

/// The payload layout is `bin/<platform>/<executable>`; the manifest does not
/// carry the file name, so the directory decides.
fn resolve_executable(payload_dir: &Path) -> Result<PathBuf, String> {
    let platform_dir = payload_dir.join("bin").join(platform_name());
    let entries = std::fs::read_dir(&platform_dir).map_err(|error| {
        format!(
            "no plugin binary for this platform in '{}': {error}",
            platform_dir.display()
        )
    })?;
    for entry in entries.flatten() {
        if entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            return Ok(entry.path());
        }
    }
    Err(format!("'{}' holds no plugin binary", platform_dir.display()))
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn spawn_reader(stdout: ChildStdout) -> FrameStream {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match sdk::read_frame(&mut reader) {
                Ok(Some(frame)) => {
                    if sender.send(Ok(Some(frame))).is_err() {
                        return;
                    }
                }
                Ok(None) => {
                    let _ = sender.send(Ok(None));
                    return;
                }
                Err(error) => {
                    let _ = sender.send(Err(error.to_string()));
                    return;
                }
            }
        }
    });
    receiver
}

fn forward_stderr(stderr: std::process::ChildStderr, plugin_id: String) {
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            log::info!("[plugin-runtime] {plugin_id}: {line}");
        }
    });
}

fn stop(plugin: &mut RunningPlugin) {
    let _ = send(plugin, &sdk::HostMessage::Shutdown);
    plugin.stdin.flush().ok();
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if plugin.child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = plugin.child.kill();
    let _ = plugin.child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn manifest(capabilities: Vec<package::Capability>) -> package::Manifest {
        package::Manifest {
            format_version: package::FORMAT_VERSION,
            id: "example.echo".to_string(),
            name: "Echo".to_string(),
            version: "1.0.0".to_string(),
            vendor: package::Vendor {
                name: "Test".to_string(),
                homepage: None,
            },
            min_app_version: "0.1.0".to_string(),
            capabilities,
            entry: package::Entry {
                kind: package::EntryKind::Process,
                proto: package::PROTOCOL_VERSION,
                transport: package::Transport::Shm,
            },
            publisher: package::Publisher {
                key: String::new(),
            },
            payload: package::PayloadRef {
                sha256: String::new(),
                bytes: 0,
                seal: None,
            },
            formats: Vec::new(),
            network: Some(package::NetworkDecl {
                plugin_id: "echo".to_string(),
            }),
        }
    }

    fn ready(capabilities: Vec<sdk::Capability>, formats: Vec<&str>) -> sdk::PluginMessage {
        sdk::PluginMessage::Ready {
            plugin_id: "example.echo".to_string(),
            version: "1.0.0".to_string(),
            capabilities,
            formats: formats
                .into_iter()
                .map(|ext| sdk::FormatDecl {
                    ext: ext.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn accepts_a_ready_that_matches_the_manifest() {
        let manifest = manifest(vec![package::Capability::NetworkOperations]);
        validate_ready(&ready(vec![sdk::Capability::NetworkOperations], vec![]), &manifest)
            .expect("matching ready");
    }

    #[test]
    fn refuses_an_undeclared_capability() {
        let manifest = manifest(vec![package::Capability::NetworkOperations]);
        let error = validate_ready(
            &ready(
                vec![
                    sdk::Capability::NetworkOperations,
                    sdk::Capability::SlicerEncoder,
                ],
                vec![],
            ),
            &manifest,
        )
        .expect_err("undeclared capability");
        assert!(error.contains("does not declare"), "{error}");
    }

    #[test]
    fn refuses_a_foreign_plugin_id() {
        let manifest = manifest(vec![package::Capability::NetworkOperations]);
        let mut ready = ready(vec![], vec![]);
        if let sdk::PluginMessage::Ready { plugin_id, .. } = &mut ready {
            *plugin_id = "someone.else".to_string();
        }
        assert!(validate_ready(&ready, &manifest).is_err());
    }

    #[test]
    fn resolves_the_binary_from_the_platform_directory() {
        let root = temp_dir("resolve");
        let bin = root.join("bin").join(platform_name());
        std::fs::create_dir_all(&bin).expect("bin dir");
        std::fs::write(bin.join("plugin"), b"x").expect("binary");
        let found = resolve_executable(&root).expect("resolve");
        assert_eq!(found, bin.join("plugin"));

        assert!(resolve_executable(&root.join("missing")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    fn temp_dir(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("df-plugin-runtime-{label}-{stamp}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    /// Builds the SDK's reference plugin, installs it into a temporary plugin
    /// directory and drives it through the real process boundary.
    #[test]
    fn round_trips_a_network_request_through_a_real_plugin_process() {
        let sdk_manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("rust")
            .join("dragonfruit-plugin-sdk")
            .join("Cargo.toml");
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let status = Command::new(cargo)
            .args(["build", "--quiet", "--example", "echo_plugin", "--manifest-path"])
            .arg(&sdk_manifest)
            .status()
            .expect("build the reference plugin");
        assert!(status.success(), "reference plugin failed to build");

        let built = sdk_manifest
            .parent()
            .expect("sdk dir")
            .join("target")
            .join("debug")
            .join("examples")
            .join(if cfg!(windows) { "echo_plugin.exe" } else { "echo_plugin" });
        assert!(built.exists(), "reference plugin binary missing: {}", built.display());

        let root = temp_dir("e2e");
        let plugin_dir = root.join("example.echo");
        let bin_dir = plugin_dir.join("payload").join("bin").join(platform_name());
        std::fs::create_dir_all(&bin_dir).expect("bin dir");
        std::fs::copy(&built, bin_dir.join("echo_plugin")).expect("install binary");
        let manifest = manifest(vec![package::Capability::NetworkOperations]);
        std::fs::write(
            plugin_dir.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).expect("manifest json"),
        )
        .expect("manifest");

        initialize(root.clone());

        let response = handle_network_request(
            r#"{"pluginId":"example.echo","operation":"printer/status"}"#,
        )
        .expect("routed to the sideloaded plugin");
        assert_eq!(response.status, 200, "body: {}", response.body);
        assert_eq!(response.body["state"], "printing");

        let unknown = handle_network_request(
            r#"{"pluginId":"example.echo","operation":"nope"}"#,
        )
        .expect("routed");
        assert_eq!(unknown.status, 404);

        assert!(
            handle_network_request(r#"{"pluginId":"not.installed","operation":"x"}"#).is_none(),
            "an unknown id must fall through to the caller"
        );

        shutdown_all();
        let _ = std::fs::remove_dir_all(&root);
    }
}
