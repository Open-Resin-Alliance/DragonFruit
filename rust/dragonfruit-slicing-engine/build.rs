use std::{env, fs, path::{Path, PathBuf}, process::Command};

fn run(command: &mut Command) {
    let status = command.status().expect("failed to launch CMake for CUDA slicer");
    assert!(status.success(), "CUDA slicer CMake command failed");
}

fn main() {
    println!("cargo:rerun-if-changed=native/cuda");
    for name in ["CUDA_PATH", "CUDACXX", "DF_CUDA_RUNTIME_DLL", "CMAKE_GENERATOR"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    // CUDA deployment is Windows-only. Other targets retain the typed
    // unavailable adapter, including when a cross-platform consumer enables cuda.
    if env::var_os("CARGO_FEATURE_CUDA").is_none()
        || env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    assert_eq!(env::var("CARGO_CFG_TARGET_ARCH").as_deref(), Ok("x86_64"),
        "the CUDA slicer requires a 64-bit Windows target");
    assert_eq!(env::var("CARGO_CFG_TARGET_ENV").as_deref(), Ok("msvc"),
        "the CUDA slicer requires the MSVC Windows toolchain");
    let toolkit = PathBuf::from(env::var_os("CUDA_PATH")
        .expect("CUDA_PATH must identify CUDA 12.9 Update 1 for a CUDA-enabled build"));
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let build = out.join("cuda");
    let mut configure = Command::new("cmake");
    configure.args(["-S", "native/cuda", "-B"]).arg(&build)
        .arg("-DCMAKE_BUILD_TYPE=Release")
        .arg("-DCMAKE_CUDA_RUNTIME_LIBRARY=Shared")
        .arg(format!("-DCUDAToolkit_ROOT={}", toolkit.display()));
    run(&mut configure);
    run(Command::new("cmake").arg("--build").arg(&build)
        .args(["--config", "Release", "--target", "df_cuda_slicer"]));
    let library_dir = if build.join("Release/df_cuda_slicer.lib").is_file() {
        build.join("Release")
    } else { build.clone() };
    assert!(library_dir.join("df_cuda_slicer.lib").is_file(), "CMake did not produce df_cuda_slicer.lib");
    println!("cargo:rustc-link-search=native={}", library_dir.display());
    println!("cargo:rustc-link-search=native={}", toolkit.join("lib/x64").display());
    println!("cargo:rustc-link-lib=static=df_cuda_slicer");
    println!("cargo:rustc-link-lib=dylib=cudart");
    let runtime = env::var_os("DF_CUDA_RUNTIME_DLL").map(PathBuf::from)
        .unwrap_or_else(|| toolkit.join("bin/cudart64_12.dll"));
    assert!(runtime.is_file(), "CUDA redistributable runtime DLL is missing: {}", runtime.display());
    assert_eq!(runtime.file_name().and_then(|name| name.to_str()), Some("cudart64_12.dll"),
        "DF_CUDA_RUNTIME_DLL must name cudart64_12.dll");
    println!("cargo:runtime_dll={}", runtime.display());
    // OUT_DIR is target/<profile>/build/<package>/out. Stage beside both
    // consumer executables and test executables without requiring the toolkit
    // bin directory on the end user's PATH.
    let profile = out.ancestors().nth(3).expect("unexpected Cargo OUT_DIR layout");
    for destination in [profile.join("cudart64_12.dll"), profile.join("deps/cudart64_12.dll")] {
        fs::create_dir_all(destination.parent().unwrap()).expect("create runtime directory");
        if Path::new(&runtime) != destination { fs::copy(&runtime, destination).expect("stage CUDA runtime DLL"); }
    }
}
