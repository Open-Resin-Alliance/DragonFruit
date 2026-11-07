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

    println!("cargo:rerun-if-env-changed=DEP_DF_CUDA_SLICER_RUNTIME_DLL");
    if std::env::var_os("CARGO_FEATURE_CUDA").is_some()
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
    {
        let runtime = std::path::PathBuf::from(std::env::var_os("DEP_DF_CUDA_SLICER_RUNTIME_DLL")
            .expect("CUDA-enabled desktop build requires the engine runtime DLL metadata"));
        println!("cargo:rerun-if-changed={}", runtime.display());
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
        let resources = manifest.join("windows-resources/cuda");
        std::fs::create_dir_all(&resources).expect("create CUDA packaging directory");
        std::fs::copy(&runtime, resources.join("cudart64_12.dll"))
            .expect("stage CUDA runtime for Windows installers");
    }

    tauri_build::build();
}
