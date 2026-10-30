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
    let format_extension = arg("--format").unwrap_or_else(|| ".apf".to_string());
    let passphrase = arg("--passphrase");
    let min_app_version = arg("--min-app-version").unwrap_or_else(|| "0.1.0".to_string());

    let binary_path = PathBuf::from(&binary);
    let binary_name = binary_path
        .file_name()
        .and_then(|value| value.to_str())
        .expect("binary file name");
    let key = package::signing_key_from_seed(seed_bytes());
    let manifest = package::Manifest {
        format_version: package::FORMAT_VERSION,
        id,
        name,
        version,
        vendor: package::Vendor {
            name: vendor,
            homepage: None,
        },
        min_app_version,
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
            id: "custom".to_string(),
            extensions: vec![format_extension],
            display_name: None,
        }],
        network: None,
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

fn platform_dir() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}
