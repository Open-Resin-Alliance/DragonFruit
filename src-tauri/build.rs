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

    // libcef.so must bind to our mallinfo, not glibc's; see src/mallinfo_shim.rs.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("gnu")
    {
        println!("cargo:rustc-link-arg-bins=-Wl,--export-dynamic-symbol=mallinfo");
    }

    tauri_build::build();
}
