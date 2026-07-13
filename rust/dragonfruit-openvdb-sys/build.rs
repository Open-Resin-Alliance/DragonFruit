//! Fully self-contained, cross-platform build of the OpenVDB shim.
//!
//! Everything is vendored under `vendor/` as git submodules and built from
//! source with the `cmake` crate, then statically linked. No system packages,
//! no pkg-config, no vcpkg — identical on Windows (MSVC), macOS, Linux and the
//! flatpak runner. We disable Blosc/ZLIB/EXR because we never touch `.vdb`
//! files (in-memory grids only), which removes the heaviest transitive deps.

use std::path::PathBuf;

fn main() {
    // Escape hatch for type-checking / CI where OpenVDB isn't vendored: skip the
    // native build entirely. `cargo check` (which does not link) then succeeds;
    // a real `cargo build`/link will fail, as expected, until the submodules and
    // toolchain are present.
    if std::env::var_os("DF_VDB_SKIP_BUILD").is_some() {
        println!("cargo:warning=dragonfruit-openvdb-sys: DF_VDB_SKIP_BUILD set — skipping native build");
        return;
    }

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let vendor = manifest.join("vendor");
    for dep in ["tbb", "imath", "openvdb"] {
        let p = vendor.join(dep);
        if !p.join("CMakeLists.txt").exists() {
            panic!(
                "vendored dependency `{dep}` missing at {}. Run:\n  \
                 git submodule update --init --recursive rust/dragonfruit-openvdb-sys/vendor/{dep}",
                p.display()
            );
        }
    }

    // 1. oneTBB (static)
    let tbb = cmake::Config::new(vendor.join("tbb"))
        .define("TBB_TEST", "OFF")
        .define("TBB_STRICT", "OFF")
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        .build();

    // 2. Imath (provides Half, needed by OpenVDB)
    let imath = cmake::Config::new(vendor.join("imath"))
        .define("BUILD_SHARED_LIBS", "OFF")
        .define("IMATH_INSTALL_PKG_CONFIG", "OFF")
        .define("BUILD_TESTING", "OFF")
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        .build();

    // 3. OpenVDB core (static), pointed at the two deps above.
    let openvdb = cmake::Config::new(vendor.join("openvdb"))
        .define("OPENVDB_BUILD_CORE", "ON")
        .define("OPENVDB_BUILD_BINARIES", "OFF")
        .define("OPENVDB_BUILD_PYTHON_MODULE", "OFF")
        .define("OPENVDB_BUILD_UNITTESTS", "OFF")
        .define("OPENVDB_CORE_SHARED", "OFF")
        .define("OPENVDB_CORE_STATIC", "ON")
        .define("USE_BLOSC", "OFF")
        .define("USE_ZLIB", "OFF")
        .define("USE_EXR", "OFF")
        .define("USE_IMATH_HALF", "ON")
        .define(
            "CMAKE_PREFIX_PATH",
            format!("{};{}", tbb.display(), imath.display()),
        )
        .define("TBB_ROOT", &tbb)
        .define("Imath_ROOT", &imath)
        .define("CMAKE_POSITION_INDEPENDENT_CODE", "ON")
        .build();

    // 4. Our shim, compiled against the freshly-built headers.
    let mut cc = cc::Build::new();
    cc.cpp(true)
        .file("cpp/df_vdb_shim.cpp")
        .include(openvdb.join("include"))
        .include(tbb.join("include"))
        .include(imath.join("include"))
        .include(imath.join("include").join("Imath"));
    if cc.get_compiler().is_like_msvc() {
        cc.flag("/std:c++17").flag("/EHsc").flag("/bigobj");
    } else {
        cc.flag("-std=c++17");
    }
    cc.compile("df_vdb_shim");

    // 5. Link order: shim -> openvdb -> imath -> tbb -> C++ runtime.
    for dir in [&openvdb, &imath, &tbb] {
        println!("cargo:rustc-link-search=native={}", dir.join("lib").display());
        // some platforms install into lib64
        println!("cargo:rustc-link-search=native={}", dir.join("lib64").display());
    }
    println!("cargo:rustc-link-lib=static=openvdb");
    println!("cargo:rustc-link-lib=static=Imath-3_1");
    println!("cargo:rustc-link-lib=static=tbb");

    // C++ standard library (platform-dependent).
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("apple") {
        println!("cargo:rustc-link-lib=dylib=c++");
    } else if target.contains("linux") {
        println!("cargo:rustc-link-lib=dylib=stdc++");
    } // MSVC links the C++ runtime automatically.

    println!("cargo:rerun-if-changed=cpp/df_vdb_shim.cpp");
    println!("cargo:rerun-if-changed=cpp/df_vdb_shim.hpp");
}
