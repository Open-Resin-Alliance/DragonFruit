use std::{collections::hash_map::DefaultHasher, env, fs, hash::{Hash, Hasher},
    path::{Path, PathBuf}, process::Command};

fn run(command: &mut Command) {
    let status = command.status().expect("failed to launch CMake for CUDA slicer");
    assert!(status.success(), "CUDA slicer CMake command failed");
}

const CUDA_GENERATOR: &str = "Visual Studio 17 2022";

struct NativeMsvc {
    instance: PathBuf,
    toolset: String,
    compiler: PathBuf,
}

fn cuda_toolkit() -> PathBuf {
    let root = env::var_os("CUDA_PATH_V12_9").map(PathBuf::from).unwrap_or_else(||
        PathBuf::from(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.9"));
    assert!(root.join("bin/nvcc.exe").is_file(),
        "CUDA 12.9 nvcc.exe is missing under {}. Install CUDA 12.9 or set CUDA_PATH_V12_9 to its root; CUDA_PATH/CUDACXX are not used to select a newer toolkit.", root.display());
    assert!(root.join("extras/visual_studio_integration/MSBuildExtensions").is_dir(),
        "CUDA 12.9 Visual Studio integration is missing under {}. Install the toolkit's Visual Studio Integration component.", root.display());
    root
}

fn msvc_193_version(name: &str) -> Option<(u32, u32, u32)> {
    let mut parts = name.split('.');
    let version = (parts.next()?.parse().ok()?, parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?);
    if version.0 != 14 || !(30..40).contains(&version.1) || parts.next().is_some() {
        return None;
    }
    Some(version)
}

fn native_msvc() -> NativeMsvc {
    let installer = env::var_os("ProgramFiles(x86)").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files (x86)"));
    let vswhere = installer.join("Microsoft Visual Studio/Installer/vswhere.exe");
    let output = Command::new(&vswhere)
        .args(["-products", "*", "-version", "[17.0,18.0)",
            "-property", "installationPath", "-utf8"])
        .output().expect("cannot run vswhere; install Visual Studio 2022 Build Tools with an MSVC 19.3x toolset");
    assert!(output.status.success(), "VS2022 discovery failed: {}",
        String::from_utf8_lossy(&output.stderr));
    let instances = std::str::from_utf8(&output.stdout)
        .expect("vswhere -utf8 returned invalid UTF-8");
    let mut selected: Option<((u32, u32, u32), NativeMsvc)> = None;
    for line in instances.trim_start_matches('\u{feff}').lines() {
        if line.trim().is_empty() { continue; }
        let instance = PathBuf::from(line.trim());
        let directory = instance.join("VC/Tools/MSVC");
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => panic!("cannot inspect MSVC toolsets under {}: {error}", directory.display()),
        };
        for entry in entries {
            let entry = entry.expect("cannot read MSVC toolset directory entry");
            let name = entry.file_name();
            let Some(toolset) = name.to_str() else { continue; };
            let Some(version) = msvc_193_version(toolset) else { continue; };
            let compiler = entry.path().join("bin/Hostx64/x64/cl.exe");
            if !compiler.is_file() || selected.as_ref().is_some_and(|(best, _)| *best >= version) {
                continue;
            }
            selected = Some((version, NativeMsvc {
                instance: instance.clone(), toolset: toolset.to_owned(), compiler,
            }));
        }
    }
    selected.expect("CUDA 12.9 needs VS2022 with MSVC 19.3x (v143 toolset 14.30 through 14.39). Install an older v143 x64/x86 toolset, for example 14.38, through Visual Studio Installer's Individual components. VS2026/MSVC 19.51 and newer VS2022 19.4x toolsets are not selected for the native CUDA library.").1
}

fn native_build_dir(out: &Path, toolkit: &Path, nvcc: &Path, msvc: &NativeMsvc) -> PathBuf {
    let mut key = DefaultHasher::new();
    CUDA_GENERATOR.hash(&mut key);
    toolkit.hash(&mut key);
    msvc.instance.hash(&mut key);
    msvc.toolset.hash(&mut key);
    for compiler in [nvcc, msvc.compiler.as_path()] {
        compiler.hash(&mut key);
        fs::metadata(compiler).and_then(|metadata| metadata.modified()).ok().hash(&mut key);
    }
    out.join(format!("cuda-12.9-{:016x}", key.finish()))
}

fn cmake_command(toolkit: &Path, nvcc: &Path) -> Command {
    let mut command = Command::new("cmake");
    // Scope selection to native CMake/MSBuild; do not mutate the application's
    // environment or mix VS2026 compiler/header paths with the pinned toolset.
    command.env("CUDA_PATH", toolkit).env("CUDACXX", nvcc);
    for name in ["CXX", "CUDAHOSTCXX", "INCLUDE", "LIB", "LIBPATH", "VCINSTALLDIR",
        "VCToolsInstallDir", "VCToolsVersion", "VSINSTALLDIR", "VisualStudioVersion", "DevEnvDir"] {
        command.env_remove(name);
    }
    command
}

fn main() {
    println!("cargo:rerun-if-changed=native/cuda");
    for name in ["CUDA_PATH_V12_9", "DF_CUDA_RUNTIME_DLL", "ProgramFiles(x86)"] {
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
    let toolkit = cuda_toolkit();
    let nvcc = toolkit.join("bin/nvcc.exe");
    let msvc = native_msvc();
    println!("cargo:rerun-if-changed={}", nvcc.display());
    println!("cargo:rerun-if-changed={}", msvc.instance.join("VC/Tools/MSVC").display());
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    // A toolchain change must not reuse cached CUDA 13.x / VS2026 compiler
    // identification, implicit link paths, or MSBuild project files.
    let build = native_build_dir(&out, &toolkit, &nvcc, &msvc);
    let cuda_directory = toolkit.to_string_lossy().replace('\\', "/");
    let mut configure = cmake_command(&toolkit, &nvcc);
    configure.args(["-S", "native/cuda", "-B"]).arg(&build)
        .args(["-G", CUDA_GENERATOR, "-A", "x64", "-T"])
        .arg(format!("v143,version={},host=x64,cuda={cuda_directory}", msvc.toolset))
        .arg(format!("-DCMAKE_GENERATOR_INSTANCE={}", msvc.instance.display()))
        .arg(format!("-DCMAKE_CUDA_COMPILER={}", nvcc.display()))
        .arg("-DCMAKE_BUILD_TYPE=Release")
        .arg("-DCMAKE_CUDA_RUNTIME_LIBRARY=Shared")
        .arg(format!("-DCUDAToolkit_ROOT={}", toolkit.display()));
    run(&mut configure);
    run(cmake_command(&toolkit, &nvcc).arg("--build").arg(&build)
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
