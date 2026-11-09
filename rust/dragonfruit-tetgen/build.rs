//! Compile the vendored TetGen.
//!
//! TetGen ships as three translation units plus a header, and builds as a library once `TETLIBRARY`
//! is defined, which is the only configuration flag this needs. `predicates.cxx` is Shewchuk's
//! exact arithmetic and is compiled separately because it is deliberately plain C rather than C++.

fn main() {
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .define("TETLIBRARY", None)
        .include("vendor")
        .file("vendor/tetgen.cxx")
        .file("vendor/predicates.cxx")
        .file("src/shim.cpp");

    // TetGen predates modern compilers and warns freely; the warnings are not actionable and there
    // are thousands of them at default verbosity.
    build.warnings(false);
    for flag in [
        "-Wno-unused-variable",
        "-Wno-unused-function",
        "-Wno-unused-but-set-variable",
        "-Wno-sign-compare",
        "-Wno-write-strings",
    ] {
        build.flag_if_supported(flag);
    }
    // GCC refuses some of TetGen's older constructs as errors without this.
    build.flag_if_supported("-fpermissive");
    build.std("c++14");

    build.compile("tetgen");

    for file in [
        "vendor/tetgen.cxx",
        "vendor/tetgen.h",
        "vendor/predicates.cxx",
        "vendor/LICENSE",
        "src/shim.cpp",
    ] {
        println!("cargo:rerun-if-changed={file}");
    }
}
