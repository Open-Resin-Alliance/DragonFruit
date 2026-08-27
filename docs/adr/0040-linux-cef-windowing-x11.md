---
issue: 206
kind: decision
date: 2026-08-25
---

# ADR-0040: The Linux CEF build is an X11 application, deliberately

**Status**: accepted

Context: Linux uses CEF instead of WebKitGTK (#83), and the tauri crates were pinned to a `feat/cef` rev from 2026-04-16. Bumping that pin to `tauri-cef-v3.0.0-alpha.22` made the Flatpak — the only artifact we ship on Linux — install cleanly and then die on launch with `Runtime(CreateWindow)`. It had nothing to do with our code.

**What changed upstream.** tauri-apps/tauri#15588 (`488243bb`, 2026-06-29, first released in `alpha.11`) rewrote how the CEF runtime creates windows. Before it, the top-level window was a `cef::Window` — CEF's own Views widget. CEF speaks Wayland, so the window was a native Wayland surface. After it, the window is created by **winit** and the browser is embedded inside it as a child. That embedding is the whole problem:

```rust
// crates/tauri-runtime-cef/src/platform/linux/window.rs
fn raw_cef_handle(&self) -> cef::sys::cef_window_handle_t {
    self.xid() as cef::sys::cef_window_handle_t
}
fn xid(&self) -> c_ulong {
    match handle.as_raw() {
        RawWindowHandle::Xlib(h) => h.window as c_ulong,
        RawWindowHandle::Xcb(h)  => h.window.get() as c_ulong,
        other => panic!("expected X11 window handle, got {other:?}"),
    }
}
```

`cef_window_handle_t` is an X11 window id. **Wayland has no equivalent and cannot have one**: a `wl_surface` is a protocol object local to one client's connection, there is no global window namespace, `wl_subsurface` requires both surfaces to come from the same connection, and `xdg-foreign` establishes parentage between clients, not embedding. So the runtime forces the issue — `event_loop_builder.with_x11()` and `ozone-platform=x11` — and the word "wayland" does not appear anywhere in the crate. This is not a regression to wait out: `alpha.23` still does it.

**This is a reasonable trade, not an oversight.** With CEF Views the window belongs to Chromium and Tauri can only expose what Views exposes; the April runtime carried 27 `TODO`/not-implemented markers against 11 in `alpha.22`. Owning a real native window is how they close the gap with wry.

**Why it only bites us in the Flatpak.** Every Linux desktop runs XWayland, so an X11-only app works on a Wayland session without anyone noticing. Our manifest granted `--socket=wayland` plus `--socket=fallback-x11`, and *fallback* means "X11 only if Wayland is unavailable" — so in a Wayland session the sandbox handed the app no X display at all. Outside the sandbox the same binary starts fine, which is why nothing showed up until the Flatpak was built and run.

Decision: **pin `tauri-cef-v3.0.0-alpha.22` and make the Flatpak an X11 client** — `--socket=x11`, no `--socket=wayland`. This aligns the manifest with what the runtime actually requires instead of relying on an architectural accident.

A second, unrelated blocker was fixed in the same manifest: CEF's binaries are built on Ubuntu and request `libbz2.so.1.0`, while the freedesktop runtime ships the same library as `libbz2.so.1`. `libcef.so` fails to load without a symlink between the two.

**Consequences.** The app runs under XWayland. The visible cost is fractional scaling — text is rendered at one size and rescaled, so it is softer on non-integer scale factors. Everything else (clipboard, drag and drop, portals, input) goes through XWayland unchanged. Against that we gain two months of upstream fixes, of which the largest is the idle-CPU busy-spin (tauri-apps/tauri#15479): browser-process CPU at idle measured at 102% before and 9% after, on Debian 13 with an AMD Oland.

**Alternative considered and rejected: pin `alpha.10`** (`3e454aad`, 2026-06-24). It is the last tag that has the idle-CPU fix and predates the winit migration, so it would keep native Wayland. Rejected because it freezes us on an architecture upstream has abandoned: every later fix, and any future Wayland support, lands on the winit side. The gap would only get more expensive.

**The way back to Wayland is offscreen rendering.** tauri-apps/tauri#15868 asks for `windowless_rendering_enabled` to be exposed. In that mode CEF creates no window at all: it renders offscreen and hands over the texture, which the app composites into its own winit window — no XID anywhere, Wayland included. The binding layer already exists: `tauri-apps/cef-rs` ships `set_as_windowless()` and an `osr_texture_import/` module with `dmabuf.rs` for zero-copy GPU texture import on Linux, alongside `d3d11.rs` and `iosurface.rs`. What is missing is the runtime using it. The honest cost is that OSR moves input, IME and accessibility handling into the embedder. **When that lands, revisit this ADR**: the manifest goes back to `--socket=wayland` and the decision here expires.

**Verification (2026-08-25, Debian 13 / KDE Plasma 6 Wayland).** Flatpak built through the release path (`tauri-build.mjs --no-bundle` + flatpak-builder), installed with `flatpak install --user`, and launched. With `--socket=wayland` it dies at `Runtime(CreateWindow)`; with the wayland socket withheld and X11 granted it starts, and `~/.var/app/org.openresinalliance.dragonfruit/data/org.openresinalliance.dragonfruit/logs/dragonfruit.log` is written — the path from #206.
