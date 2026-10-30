//! Sideloaded complex plugins: install, list and remove `.dfplugin` packages.
//!
//! Format, trust model and the (future) plugin protocol are specified in
//! `docs/dev/plugins-sideloaded.md` and ADR-0047. This module covers the host
//! half that exists today: verify a package, pin its publisher, unseal and
//! extract its payload, and keep the result under the app data dir.
//!
//! Nothing here executes the plugin yet — the process transport is the next
//! slice. A package installed by this module is inert on disk until then.

use std::io::Write;
use std::path::{Path, PathBuf};

use dragonfruit_plugin_package as package;
use serde::{Deserialize, Serialize};
use tauri::Manager;

const DIR_NAME: &str = "plugins-sideloaded";
const SETTINGS_FILE: &str = "settings.json";
const PACKAGE_FILE: &str = "package.dfplugin";
const MANIFEST_FILE: &str = "manifest.json";
const STATE_FILE: &str = "state.json";
const KEY_FILE: &str = "key";
const PAYLOAD_DIR: &str = "payload";

/// Serializes installs/removals: two concurrent imports of the same id would
/// otherwise interleave in the same directory.
fn dir_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(()));
    &LOCK
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    #[serde(default)]
    allow_sideloaded_complex_plugins: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            allow_sideloaded_complex_plugins: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledState {
    publisher_fingerprint: String,
    imported_at: String,
    version: String,
    sealed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideloadedInspect {
    pub manifest: package::Manifest,
    pub publisher_fingerprint: String,
    pub sealed: bool,
    /// True when a package with this id is already installed with the same
    /// publisher; the install will replace it.
    pub replaces_existing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSideloadedPlugin {
    pub manifest: package::Manifest,
    pub publisher_fingerprint: String,
    pub imported_at: String,
    pub sealed: bool,
}

/// Directory holding every installed package, ready for the runtime to scan.
pub fn plugin_root<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    root_dir(app)
}

/// Every installed plugin's manifest, sorted by id. The encoder registry and the
/// runtime both start from this list.
pub fn installed_packages(root: &Path) -> Vec<package::Manifest> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<package::Manifest> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let id = entry.file_name().to_string_lossy().to_string();
            installed_manifest(root, &id)
        })
        .collect();
    out.sort_by(|left, right| left.id.cmp(&right.id));
    out
}

/// The manifest of an installed plugin, or `None` when nothing with that id is
/// installed. Used by the runtime to decide whether a request belongs to it.
///
/// Reads `manifest.json` alone: routing only needs identity and capabilities, and
/// a plugin whose state file is unreadable is still the owner of its id.
pub fn installed_manifest(root: &Path, id: &str) -> Option<package::Manifest> {
    let bytes = std::fs::read(installed_dir(root, id).join(MANIFEST_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn root_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("Failed resolving app data dir: {err}"))?;
    let dir = base.join(DIR_NAME);
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("Failed creating '{}': {err}", dir.display()))?;
    Ok(dir)
}

fn read_settings(root: &Path) -> Settings {
    let path = root.join(SETTINGS_FILE);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
}

fn write_settings(root: &Path, settings: &Settings) -> Result<(), String> {
    let path = root.join(SETTINGS_FILE);
    let text = serde_json::to_string_pretty(settings)
        .map_err(|err| format!("Failed serializing plugin settings: {err}"))?;
    write_private_file(&path, text.as_bytes())
}

/// Writes a file that only the current user should read. On Unix that means
/// mode 0600; on Windows the inherited ACL of the user's app data dir applies.
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|err| format!("Failed writing '{}': {err}", path.display()))?;
    file.write_all(bytes)
        .map_err(|err| format!("Failed writing '{}': {err}", path.display()))?;
    Ok(())
}

/// `a` must be at least `b`, comparing dotted numeric versions component by
/// component and ignoring any pre-release suffix.
fn version_at_least(current: &str, required: &str) -> bool {
    fn parts(version: &str) -> Vec<u64> {
        version
            .split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|part| part.trim().parse::<u64>().unwrap_or(0))
            .collect()
    }
    let current = parts(current);
    let required = parts(required);
    for index in 0..current.len().max(required.len()) {
        let left = current.get(index).copied().unwrap_or(0);
        let right = required.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    true
}

fn read_installed(dir: &Path) -> Option<InstalledSideloadedPlugin> {
    let manifest_bytes = std::fs::read(dir.join(MANIFEST_FILE)).ok()?;
    let manifest: package::Manifest = serde_json::from_slice(&manifest_bytes).ok()?;
    let state: InstalledState = std::fs::read_to_string(dir.join(STATE_FILE))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())?;
    Some(InstalledSideloadedPlugin {
        manifest,
        publisher_fingerprint: state.publisher_fingerprint,
        imported_at: state.imported_at,
        sealed: state.sealed,
    })
}

fn installed_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

fn list_installed(root: &Path) -> Vec<InstalledSideloadedPlugin> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        if let Some(plugin) = read_installed(&entry.path()) {
            out.push(plugin);
        }
    }
    out.sort_by(|left, right| left.manifest.name.cmp(&right.manifest.name));
    out
}

fn inspect_file(path: &Path, root: &Path) -> Result<(Vec<u8>, package::Inspected, bool), String> {
    let bytes = std::fs::read(path).map_err(|err| format!("Failed reading '{}': {err}", path.display()))?;
    let inspected = package::inspect(&bytes).map_err(|err| err.to_string())?;

    let existing = installed_dir(root, &inspected.manifest.id);
    let replaces_existing = match read_installed(&existing) {
        Some(installed) => {
            if installed.publisher_fingerprint != inspected.publisher_fingerprint {
                return Err(format!(
                    "'{}' is already installed from a different publisher key. Remove it before importing a package signed by another key.",
                    inspected.manifest.id
                ));
            }
            true
        }
        None => false,
    };

    if !version_at_least(env!("CARGO_PKG_VERSION"), &inspected.manifest.min_app_version) {
        return Err(format!(
            "This package needs DragonFruit {} or newer; this build is {}.",
            inspected.manifest.min_app_version,
            env!("CARGO_PKG_VERSION")
        ));
    }

    Ok((bytes, inspected, replaces_existing))
}

fn install_from_bytes(
    root: &Path,
    bytes: &[u8],
    inspected: &package::Inspected,
    passphrase: Option<&str>,
) -> Result<InstalledSideloadedPlugin, String> {
    let manifest = &inspected.manifest;
    let payload_zip = match &manifest.payload.seal {
        Some(_) => {
            let passphrase = passphrase
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("This package is sealed; a passphrase is required.")?;
            package::unseal(bytes, inspected, passphrase).map_err(|err| err.to_string())?
        }
        // Unsealed packages carry the payload ZIP verbatim; the manifest hash
        // covers those exact bytes.
        None => read_unsealed_payload(bytes)?,
    };
    if package::sha256_hex(&payload_zip) != manifest.payload.sha256.to_ascii_lowercase() {
        return Err("Payload does not match the manifest hash.".to_string());
    }

    let staging = root.join(format!("{}.staging", manifest.id));
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .map_err(|err| format!("Failed clearing '{}': {err}", staging.display()))?;
    }
    std::fs::create_dir_all(&staging)
        .map_err(|err| format!("Failed creating '{}': {err}", staging.display()))?;

    let write = || -> Result<(), String> {
        std::fs::write(staging.join(PACKAGE_FILE), bytes)
            .map_err(|err| format!("Failed writing package copy: {err}"))?;
        let manifest_bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|err| format!("Failed serializing manifest: {err}"))?;
        std::fs::write(staging.join(MANIFEST_FILE), &manifest_bytes)
            .map_err(|err| format!("Failed writing manifest: {err}"))?;

        let payload_dir = staging.join(PAYLOAD_DIR);
        std::fs::create_dir_all(&payload_dir)
            .map_err(|err| format!("Failed creating payload dir: {err}"))?;
        package::extract_payload(&payload_zip, &payload_dir).map_err(|err| err.to_string())?;

        if let Some(seal) = &manifest.payload.seal {
            let passphrase = passphrase.unwrap_or("");
            let key = package::derive_seal_key(passphrase, seal).map_err(|err| err.to_string())?;
            let hex: String = key.iter().map(|byte| format!("{byte:02x}")).collect();
            write_private_file(&staging.join(KEY_FILE), hex.as_bytes())?;
        }

        let imported_at = time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap_or_else(|_| String::new());
        let state = InstalledState {
            publisher_fingerprint: inspected.publisher_fingerprint.clone(),
            imported_at: imported_at.clone(),
            version: manifest.version.clone(),
            sealed: manifest.payload.seal.is_some(),
        };
        let state_text = serde_json::to_string_pretty(&state)
            .map_err(|err| format!("Failed serializing install state: {err}"))?;
        write_private_file(&staging.join(STATE_FILE), state_text.as_bytes())
    };
    if let Err(err) = write() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(err);
    }

    let target = installed_dir(root, &manifest.id);
    let backup = root.join(format!("{}.old", manifest.id));
    if backup.exists() {
        let _ = std::fs::remove_dir_all(&backup);
    }
    if target.exists() {
        std::fs::rename(&target, &backup)
            .map_err(|err| format!("Failed replacing '{}': {err}", target.display()))?;
    }
    if let Err(err) = std::fs::rename(&staging, &target) {
        let _ = std::fs::rename(&backup, &target);
        return Err(format!("Failed installing '{}': {err}", target.display()));
    }
    let _ = std::fs::remove_dir_all(&backup);

    read_installed(&target).ok_or_else(|| "Installed package is unreadable after install.".to_string())
}

/// Payload bytes of an unsealed package: the manifest hash covers the raw
/// payload ZIP stored in `payload.bin`.
fn read_unsealed_payload(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|err| format!("Package archive is unreadable: {err}"))?;
    let mut entry = archive
        .by_name(package::PAYLOAD_ENTRY)
        .map_err(|_| "Package is missing its payload.".to_string())?;
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut out)
        .map_err(|err| format!("Failed reading payload: {err}"))?;
    Ok(out)
}

#[tauri::command]
pub async fn sideloaded_plugin_allowance<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let root = root_dir(&app)?;
    Ok(read_settings(&root).allow_sideloaded_complex_plugins)
}

#[tauri::command]
pub async fn sideloaded_plugin_set_allowance<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    allow: bool,
) -> Result<bool, String> {
    let root = root_dir(&app)?;
    let mut settings = read_settings(&root);
    settings.allow_sideloaded_complex_plugins = allow;
    write_settings(&root, &settings)?;
    Ok(allow)
}

#[tauri::command]
pub async fn sideloaded_plugin_pick<R: tauri::Runtime>(
    _app: tauri::AppHandle<R>,
) -> Result<Option<String>, String> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("DragonFruit plugin", &["dfplugin"])
            .pick_file()
    })
    .await
    .map_err(|err| format!("File picker failed: {err}"))?;
    Ok(picked.map(|path| path.to_string_lossy().to_string()))
}

#[tauri::command]
pub async fn sideloaded_plugin_inspect<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
) -> Result<SideloadedInspect, String> {
    let root = root_dir(&app)?;
    let (_bytes, inspected, replaces_existing) = inspect_file(Path::new(&path), &root)?;
    Ok(SideloadedInspect {
        manifest: inspected.manifest,
        publisher_fingerprint: inspected.publisher_fingerprint,
        sealed: inspected.sealed,
        replaces_existing,
    })
}

#[tauri::command]
pub async fn sideloaded_plugin_install<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    path: String,
    passphrase: Option<String>,
) -> Result<InstalledSideloadedPlugin, String> {
    let root = root_dir(&app)?;
    if !read_settings(&root).allow_sideloaded_complex_plugins {
        return Err("Sideloaded complex plugins are turned off in Settings → Plugins.".to_string());
    }
    let _guard = dir_lock()
        .lock()
        .map_err(|_| "Plugin install lock poisoned.".to_string())?;

    let (bytes, inspected, _replaces) = inspect_file(Path::new(&path), &root)?;
    install_from_bytes(&root, &bytes, &inspected, passphrase.as_deref())
}

/// Opens a file through a sideloaded importer.
///
/// The dropped `File` arrives as a raw body (a scene can be tens of MB and JSON
/// numbers would double it), with the plugin id and file name in headers. Returns
/// the scene container the plugin wrote; the renderer parses it into geometry.
#[tauri::command]
pub async fn sideloaded_plugin_import_file<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("sideloaded_plugin_import_file expects a raw binary body".to_string());
        }
    };

    let header = |name: &str| -> Result<String, String> {
        let value = request
            .headers()
            .get(name)
            .ok_or_else(|| format!("missing {name} header"))?;
        let text = value
            .to_str()
            .map_err(|error| format!("invalid {name} header: {error}"))?;
        Ok(percent_encoding::percent_decode_str(text)
            .decode_utf8()
            .map_err(|error| format!("invalid {name} header: {error}"))?
            .into_owned())
    };

    let id = header("x-plugin-id")?;
    let file_name = header("x-file-name")?;
    let root = root_dir(&app)?;
    let manifest = installed_manifest(&root, &id)
        .ok_or_else(|| format!("plugin '{id}' is not installed"))?;
    if !manifest
        .capabilities
        .contains(&package::Capability::FileType)
    {
        return Err(format!("plugin '{id}' does not declare fileType"));
    }

    let container = tauri::async_runtime::spawn_blocking(move || {
        crate::plugin_sideload_runtime::import_with_plugin(&root, &id, &manifest, &file_name, &bytes)
    })
    .await
    .map_err(|error| format!("import task failed: {error}"))??;

    Ok(tauri::ipc::Response::new(container))
}

#[tauri::command]
pub async fn sideloaded_plugin_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<InstalledSideloadedPlugin>, String> {
    let root = root_dir(&app)?;
    Ok(list_installed(&root))
}

#[tauri::command]
pub async fn sideloaded_plugin_remove<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    id: String,
) -> Result<(), String> {
    let root = root_dir(&app)?;
    let _guard = dir_lock()
        .lock()
        .map_err(|_| "Plugin install lock poisoned.".to_string())?;
    let dir = installed_dir(&root, &id);
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|err| format!("Failed removing '{}': {err}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn version_comparison_accepts_equal_and_newer_builds() {
        assert!(version_at_least("0.3.0", "0.3.0"));
        assert!(version_at_least("0.4.0", "0.3.9"));
        assert!(version_at_least("1.0", "0.9.9"));
        assert!(!version_at_least("0.3.0", "0.4.0"));
        assert!(!version_at_least("0.3.0", "0.3.1"));
    }

    #[test]
    fn prerelease_suffix_is_ignored() {
        assert!(version_at_least("0.3.0-beta.4", "0.3.0"));
        assert!(!version_at_least("0.2.9-beta", "0.3.0"));
    }

    fn test_key(seed: u8) -> package::PluginSigningKey {
        package::signing_key_from_seed([seed; 32])
    }

    fn test_package(seed: u8, passphrase: Option<&str>, min_app_version: &str) -> Vec<u8> {
        let key = test_key(seed);
        let mut files = BTreeMap::new();
        files.insert("bin/test/plugin".to_string(), b"#!/bin/sh\n".to_vec());
        let payload = package::build_payload_zip(&files).expect("payload");
        let manifest = package::Manifest {
            format_version: package::FORMAT_VERSION,
            id: "alphabeta.test".to_string(),
            name: "Test Plugin".to_string(),
            version: "1.0.0".to_string(),
            vendor: package::Vendor {
                name: "AlphaBeta".to_string(),
                homepage: None,
            },
            min_app_version: min_app_version.to_string(),
            capabilities: vec![package::Capability::SlicerEncoder],
            entry: package::Entry {
                kind: package::EntryKind::Process,
                proto: package::PROTOCOL_VERSION,
                transport: package::Transport::Shm,
            },
            publisher: package::Publisher {
                key: package::publisher_key_for(&key),
            },
            payload: package::PayloadRef {
                sha256: String::new(),
                bytes: 0,
                seal: None,
            },
            formats: vec![package::FormatDecl {
                id: "apf".to_string(),
                extensions: vec![".apf".to_string()],
                display_name: None,
                layers: None,
            }],
            network: None,
            file_types: Vec::new(),
        };
        package::build_package(
            &manifest,
            &payload,
            passphrase,
            [9u8; 24],
            [8u8; 16],
            &key,
        )
        .expect("package")
    }

    fn temp_root(label: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("df-sideload-{label}-{stamp}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("temp root");
        root
    }

    fn install(root: &Path, bytes: &[u8], passphrase: Option<&str>) -> Result<InstalledSideloadedPlugin, String> {
        let inspected = package::inspect(bytes).map_err(|err| err.to_string())?;
        install_from_bytes(root, bytes, &inspected, passphrase)
    }

    #[test]
    fn installs_a_sealed_package_and_records_it() {
        let root = temp_root("sealed");
        let bytes = test_package(5, Some("s3cret"), "0.1.0");
        let installed = install(&root, &bytes, Some("s3cret")).expect("install");

        assert_eq!(installed.manifest.id, "alphabeta.test");
        assert!(installed.sealed);
        assert!(!installed.publisher_fingerprint.is_empty());

        let dir = root.join("alphabeta.test");
        assert!(dir.join(PACKAGE_FILE).exists());
        assert!(dir.join(MANIFEST_FILE).exists());
        assert!(dir.join(STATE_FILE).exists());
        assert!(dir.join(KEY_FILE).exists());
        assert!(dir.join(PAYLOAD_DIR).join("bin/test/plugin").exists());
        assert!(!root.join("alphabeta.test.staging").exists());

        let listed = list_installed(&root);
        assert_eq!(listed.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sealed_package_needs_its_passphrase() {
        let root = temp_root("passphrase");
        let bytes = test_package(5, Some("s3cret"), "0.1.0");

        assert!(install(&root, &bytes, None).is_err());
        assert!(install(&root, &bytes, Some("wrong")).is_err());
        assert!(!root.join("alphabeta.test").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_different_publisher_cannot_take_over_an_id() {
        let root = temp_root("pin");
        install(&root, &test_package(5, None, "0.1.0"), None).expect("first install");

        let impostor = test_package(6, None, "0.1.0");
        let temp_file = root.join("impostor.dfplugin");
        std::fs::write(&temp_file, &impostor).expect("write");
        let error = inspect_file(&temp_file, &root).expect_err("must refuse");
        assert!(error.contains("different publisher"), "unexpected: {error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reinstalling_the_same_publisher_replaces_the_directory() {
        let root = temp_root("replace");
        let first = test_package(5, None, "0.1.0");
        install(&root, &first, None).expect("first install");
        let marker = installed_dir(&root, "alphabeta.test").join("stale-marker");
        std::fs::write(&marker, b"x").expect("marker");

        install(&root, &first, None).expect("second install");
        assert!(!marker.exists(), "replacement must not keep stale files");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_package_needing_a_newer_app_is_refused() {
        let root = temp_root("minapp");
        let bytes = test_package(5, None, "99.0.0");
        let inspected = package::inspect(&bytes).expect("inspect");
        assert!(!version_at_least(env!("CARGO_PKG_VERSION"), &inspected.manifest.min_app_version));
        let temp_file = root.join("pkg.dfplugin");
        std::fs::write(&temp_file, &bytes).expect("write");
        let error = inspect_file(&temp_file, &root).expect_err("must refuse");
        assert!(error.contains("or newer"), "unexpected: {error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn allowance_round_trips_and_defaults_off() {
        let root = temp_root("allowance");
        assert!(!read_settings(&root).allow_sideloaded_complex_plugins);
        write_settings(
            &root,
            &Settings {
                allow_sideloaded_complex_plugins: true,
            },
        )
        .expect("write");
        assert!(read_settings(&root).allow_sideloaded_complex_plugins);
        let _ = std::fs::remove_dir_all(&root);
    }
}
