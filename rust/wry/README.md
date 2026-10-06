# Wry — vendored DragonFruit patch

This directory contains the published Wry **0.56.1** crate, with a local
request-body read-batching patch. The Cargo package version **0.56.2** identifies
this local patch; it does not contain upstream Wry 0.56.2 source.

## Source and licences

- Archive: <https://static.crates.io/crates/wry/wry-0.56.1.crate>
- Verified archive SHA-256:
  `375becb4aded9913f736443cf88000c6311478db69814cc06070465e4cc44c98`
- Upstream licences and source notices are retained: `LICENSE-APACHE`,
  `LICENSE-MIT`, and `LICENSE.spdx`.
- `Cargo.toml.orig` remains the upstream manifest. Cargo uses the normalized
  `Cargo.toml`, whose local package version and corresponding lock entry change.
- This README replaces the upstream README with local provenance.

## Patch

Only two Rust source files change:

- `src/webview2/mod.rs`, `InnerWebView::prepare_request`: increase the request
  scratch buffer from 1 KiB to 64 KiB and cast the content to `IStream` once
  before the loop. Each iteration still appends exactly the returned byte count;
  a zero-byte read ends the loop and failed HRESULTs still propagate.
- `src/wkwebview/class/url_scheme_handler.rs`, `start_task`: increase the
  `HTTPBodyStream` scratch buffer from 128 bytes to 64 KiB. The direct `HTTPBody`
  branch and existing stream lifecycle/error semantics remain unchanged. The
  pre-existing negative-read handling is not corrected by this patch.

Body extraction occurs before DragonFruit's Rust staging-handler append timer,
but inside the frontend's complete staging invoke timer. A 27,059,112-byte
Windows body requires at least 26,425 data reads with 1 KiB blocks versus 413
with 64 KiB blocks. This is a read-count reduction, not a measured speedup.
Windows and macOS runtime performance remains to be verified on preview builds.
Linux CEF does not use these Wry readers and is unchanged.

## Integration

`src-tauri/Cargo.toml` selects this copy through `[patch.crates-io]`:

```toml
wry = { path = "../rust/wry" }
```

Tauri remains pinned to `tauri-cef-v3.0.0-alpha.26`; no CI change is needed.
When replacing this vendor patch with an upstream fix, remove the path override,
resolve the desired registry Wry version with Cargo, and repeat platform
compilation and actual-WebView transfer/correctness verification.
