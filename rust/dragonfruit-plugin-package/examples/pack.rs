//! Reference packer: builds a `.dfplugin` from a vendor binary.
//!
//! This is the shape the published SDK's packaging tool will have; it exists
//! here so the host side can be exercised with a real package and so a vendor
//! can see exactly what the format contains.
//!
//! ```text
//! cargo run --example pack -- \
//!   --out /tmp/alphaprint.dfplugin \
//!   --binary /tmp/alphaprint-plugin \
//!   --id alphabeta.alphaprint \
//!   --name "AlphaPrint Format" \
//!   --version 1.0.0 \
//!   --vendor AlphaBeta \
//!   --format .apf \
//!   --passphrase "correct horse battery staple"
//! ```
//!
//! The publisher key comes from `--seed` (hex, 32 bytes) when given, otherwise a
//! fixed development seed is used and reported so the same key can be reused
//! across test imports.

use std::collections::BTreeMap;
use std::path::PathBuf;

use dragonfruit_plugin_package as package;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|value| value == name)
        .and_then(|index| args.get(index + 1))
        .cloned()
}

/// Every value given for a repeatable flag, in order.
fn arg_all(name: &str) -> Vec<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .enumerate()
        .filter(|(_, value)| value.as_str() == name)
        .filter_map(|(index, _)| args.get(index + 1).cloned())
        .collect()
}

fn seed_bytes() -> [u8; 32] {
    match arg("--seed") {
        Some(hex) if hex.len() == 64 => {
            let mut seed = [0u8; 32];
            for index in 0..32 {
                seed[index] = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                    .expect("seed must be hex");
            }
            seed
        }
        _ => [7u8; 32],
    }
}

fn main() {
    let out = arg("--out").unwrap_or_else(|| "plugin.dfplugin".to_string());
    let binary = arg("--binary").expect("--binary <path> is required");
    let id = arg("--id").unwrap_or_else(|| "example.plugin".to_string());
    let name = arg("--name").unwrap_or_else(|| "Example Plugin".to_string());
    let version = arg("--version").unwrap_or_else(|| "0.1.0".to_string());
    let vendor = arg("--vendor").unwrap_or_else(|| "Example Vendor".to_string());
    let format = arg("--format");
    let format_name = arg("--format-name");
    let network = arg("--network").is_some();
    let network_mode = arg("--network-mode");
    let network_name = arg("--network-name");
    let network_hosts = arg_all("--network-host");
    let remote_materials_path = arg("--remote-materials");
    let format_extension = format.clone().unwrap_or_else(|| ".apf".to_string());
    // An empty passphrase is not a passphrase: sealing with "" only looks like
    // protection. Treat it as an unsealed package.
    let passphrase = arg("--passphrase").filter(|value| !value.trim().is_empty());
    let min_app_version = arg("--min-app-version").unwrap_or_else(|| "0.1.0".to_string());
    let layer_kind = match arg("--layers").as_deref() {
        None | Some("png") => None,
        Some("rle") => Some(package::LayerKind::Rle),
        Some(other) => panic!("--layers accepts 'png' or 'rle', not '{other}'"),
    };
    let presets_path = arg("--presets");
    let templates_path = arg("--templates");
    let material_settings_path = arg("--material-settings");
    let file_type = arg("--file-type");
    let file_type_name = arg("--file-type-name").unwrap_or_else(|| "Project file".to_string());

    let binary_path = PathBuf::from(&binary);
    let binary_name = binary_path
        .file_name()
        .and_then(|value| value.to_str())
        .expect("binary file name");
    let key = package::signing_key_from_seed(seed_bytes());
    let manifest = package::Manifest {
        format_version: package::FORMAT_VERSION,
        id: id.clone(),
        name,
        version,
        vendor: package::Vendor {
            name: vendor,
            homepage: None,
        },
        min_app_version,
        // Declared from the flags, not assumed: a package that only imports files
        // must not claim an encoder, or the host would try to slice with it.
        capabilities: {
            let mut capabilities = Vec::new();
            if format.is_some() {
                capabilities.push(package::Capability::SlicerEncoder);
            }
            if file_type.is_some() {
                capabilities.push(package::Capability::FileType);
            }
            if network {
                capabilities.push(package::Capability::NetworkOperations);
            }
            if capabilities.is_empty() {
                panic!("a package must declare a capability: pass --format, --file-type or --network");
            }
            capabilities
        },
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
        formats: format
            .iter()
            .map(|_| package::FormatDecl {
            id: "custom".to_string(),
            extensions: vec![format_extension.clone()],
            display_name: format_name.clone(),
            layers: layer_kind,
            })
            .collect(),
        printer_presets: presets_path
            .map(|path| read_json_array(&path))
            .unwrap_or_default(),
        material_templates: templates_path
            .map(|path| read_json_array(&path))
            .unwrap_or_default(),
        material_settings: material_settings_path
            .map(|path| read_material_settings(&path))
            .unwrap_or_default(),
        network: network.then(|| package::NetworkDecl {
            plugin_id: id.clone(),
            mode: network_mode.clone().unwrap_or_else(|| {
                panic!("--network also needs --network-mode <slug>: that slug is what a printer profile stores")
            }),
            display_name: network_name.clone(),
            hostnames: network_hosts.clone(),
            operations: Default::default(),
            remote_materials: remote_materials_path.as_deref().map(read_remote_materials),
        }),
        file_types: file_type
            .iter()
            .map(|extension| package::FileTypeDecl {
                extension: extension.clone(),
                display_name: file_type_name.clone(),
                is_scene_file: true,
            })
            .collect(),
    };

    let mut payload_files = BTreeMap::new();
    payload_files.insert(
        format!("bin/{}/{}", platform_dir(), binary_name),
        std::fs::read(&binary_path).expect("read binary"),
    );

    let payload = package::build_payload_zip(&payload_files).expect("payload zip");
    let package_bytes = match passphrase {
        Some(passphrase) => package::build_package_sealed(&manifest, &payload, &passphrase, &key),
        // An unsealed package is a test artifact: it carries the payload ZIP as-is.
        None => package::build_package(&manifest, &payload, None, [0u8; 24], [0u8; 16], &key),
    }
    .expect("build package");

    std::fs::write(&out, &package_bytes).expect("write package");

    let inspected = package::inspect(&package_bytes).expect("inspect own package");
    println!("wrote {out}");
    println!("publisher key:       {}", manifest.publisher.key);
    println!("publisher fingerprint: {}", inspected.publisher_fingerprint);
    println!("sealed:              {}", inspected.sealed);
}

/// Reads a JSON array of presets or templates for the manifest. Kept as opaque
/// objects here: the renderer normalises them with the same code the simple tier
/// uses, so a package cannot slip a shape past two different validators.
/// `{ "byOutput": {"<format>": {...}}, "byOutputAndMode": {"<format>": {"<mode>": {...}}} }`
/// `{ "primaryFields": [...], "basicSections": [...], "advancedSections": [...] }`
fn read_remote_materials(path: &str) -> package::RemoteMaterialsDecl {
    let text = std::fs::read_to_string(path).expect("read remote materials");
    serde_json::from_str(&text).expect("remote materials must match the manifest field")
}

fn read_material_settings(path: &str) -> package::MaterialSettingsDecl {
    let text = std::fs::read_to_string(path).expect("read material settings");
    serde_json::from_str(&text).expect("material settings must match the manifest field")
}

fn read_json_array(path: &str) -> Vec<serde_json::Value> {
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("read {path}: {error}"));
    let value: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {path}: {error}"));
    match value {
        serde_json::Value::Array(items) => items,
        _ => panic!("{path} must hold a JSON array"),
    }
}

fn platform_dir() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}
