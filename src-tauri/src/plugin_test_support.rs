//! Fixtures shared by the sideloaded-plugin tests: build one of the SDK's
//! reference plugins, install it into a temporary plugin directory, and hand
//! back the paths. Compiled only for tests.

use std::path::{Path, PathBuf};
use std::process::Command;

use dragonfruit_plugin_package as package;

pub fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

pub fn temp_dir(label: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("df-plugin-{label}-{stamp}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

/// Builds one of the SDK's reference plugins and returns the binary path.
pub fn build_reference_plugin(example: &str) -> PathBuf {
    let sdk_manifest = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("rust")
        .join("dragonfruit-plugin-sdk")
        .join("Cargo.toml");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let status = Command::new(cargo)
        .args(["build", "--quiet", "--example", example, "--manifest-path"])
        .arg(&sdk_manifest)
        .status()
        .unwrap_or_else(|error| panic!("build {example}: {error}"));
    assert!(status.success(), "{example} failed to build");

    let built = sdk_manifest
        .parent()
        .expect("sdk dir")
        .join("target")
        .join("debug")
        .join("examples")
        .join(if cfg!(windows) {
            format!("{example}.exe")
        } else {
            example.to_string()
        });
    assert!(built.exists(), "{example} binary missing: {}", built.display());
    built
}

/// Installs a reference plugin into a temporary plugin directory.
pub fn install_reference_plugin(
    root: &Path,
    example: &str,
    manifest: &package::Manifest,
) -> PathBuf {
    let built = build_reference_plugin(example);
    let plugin_dir = root.join(&manifest.id);
    let bin_dir = plugin_dir.join("payload").join("bin").join(platform_name());
    std::fs::create_dir_all(&bin_dir).expect("bin dir");
    std::fs::copy(&built, bin_dir.join(example)).expect("install binary");
    std::fs::write(
        plugin_dir.join("manifest.json"),
        serde_json::to_vec_pretty(manifest).expect("manifest json"),
    )
    .expect("manifest");
    plugin_dir
}

/// A manifest with everything filled in, so each test only states what it means.
pub fn manifest(id: &str, capabilities: Vec<package::Capability>) -> package::Manifest {
    package::Manifest {
        format_version: package::FORMAT_VERSION,
        id: id.to_string(),
        name: "Test plugin".to_string(),
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
        network: None,
        file_types: Vec::new(),
        printer_presets: Vec::new(),
        material_templates: Vec::new(),
    }
}
