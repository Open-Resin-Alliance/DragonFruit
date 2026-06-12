use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../scripts/generate-plugin-registry.mjs");
    println!("cargo:rerun-if-changed=../plugins");

    let status = Command::new("node")
        .arg("../scripts/generate-plugin-registry.mjs")
        .current_dir(
            std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| "src-tauri".to_string()),
        )
        .status()
        .expect("Failed to run plugin registry generator via Node.js");

    if !status.success() {
        panic!("Plugin registry generator failed; cannot continue build");
    }

    tauri_build::build();
}
