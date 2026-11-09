// MSVC answers every OLE entry point this DLL exports with
//   LNK4104: export of symbol 'DllGetClassObject' should be PRIVATE
// because rustc writes the module-definition file for a cdylib itself and lists those
// symbols as ordinary exports, which would also publish them in the DLL's import
// library. Nothing links that import library — COM and regsvr32 resolve the entries
// through GetProcAddress, which PRIVATE visibility would not change — so the four
// warnings are noise on every link, and the .def cannot be corrected from here.
//
// The suppression is scoped to this crate with a link argument rather than added to the
// target rustflags in the repo-root .cargo/config.toml: touching rustflags invalidates
// the fingerprints of every crate built for that target, so it would force a full
// rebuild of the Tauri shell the next time it is compiled.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/IGNORE:4104");
    }
}
