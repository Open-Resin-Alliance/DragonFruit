# tauri-plugin-macos-fps (vendored)

Vendored copy of [`tauri-plugin-macos-fps`](https://github.com/userFRM/tauri-plugin-macos-fps)
v0.1.0 (MIT OR Apache-2.0), which unlocks >60 fps on macOS by disabling
WKWebView's frame rate cap.

## Why it is vendored

Upstream has a single published version (0.1.0, 2026-03) and calls
`PlatformWebview::inner()`. That method is gone: `PlatformWebview` is now
generic over the runtime (`PlatformWebview<R>(R::Webview)`) and only `Deref`s to
the runtime's own webview type. The crate therefore fails to compile against the
tauri pin adopted in ADR 0005 (`tauri-cef-v3.0.0-alpha.22`), and macOS builds
cannot link without it.

## Local modification

`inner()` still exists — on `tauri_runtime_wry::Webview`, reachable through the
`Deref`. But neither field access nor method resolution goes through `Deref`
when the target is a generic associated type, so the runtime has to be concrete.
This plugin is macOS + wry by definition, so the generic parameter was dropped:

    -pub trait MacFpsExt<R: Runtime> { ... }
    -impl<R: Runtime> MacFpsExt<R> for Webview<R> { ... }
    -pub fn init<R: Runtime>() -> TauriPlugin<R, Config>
    +pub trait MacFpsExt { ... }
    +impl MacFpsExt for Webview<Wry> { ... }
    +pub fn init() -> TauriPlugin<Wry, Config>

The three `webview.inner()` call sites are unchanged from upstream; they now
resolve because the receiver is concrete.

Reported upstream as [userFRM/tauri-plugin-macos-fps#4](https://github.com/userFRM/tauri-plugin-macos-fps/issues/4).
Drop this directory and go back to the crates.io dependency once a release
compatible with tauri >= 2.11 is published. Note the repository has had no
commits since 2026-03, so do not count on it.
