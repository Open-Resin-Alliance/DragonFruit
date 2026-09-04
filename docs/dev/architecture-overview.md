# Architecture Overview

DragonFruit is one desktop app assembled from four codebases that talk across two seams. Read this page to find out *where* a change goes; the pages it links to say *how* each part works.

## The four parts

| Directory | What it is | Talks to |
| --------- | ---------- | -------- |
| `src/` | The whole UI and editor: a Next.js + React frontend rendering a three.js scene | Rust, over Tauri IPC |
| `src-tauri/` | The desktop shell: window, updater, and ~105 `#[tauri::command]` entry points | `src/` above, `rust/` below |
| `rust/` | Ten standalone crates doing the heavy work — slicing engine, islands, mesh repair, SDF, A*, organic cut, RTSP relay, CLI | called by `src-tauri/` |
| `plugins/` | Per-vendor printer support, as git submodules | registered into both `src/` and `rust/` by generated code |

`profiles/` holds printer and material presets, which plugins extend.

The crates under `rust/` are **standalone — there is no workspace root**. `src-tauri/Cargo.toml` depends on each by path, which is why a stale `version` in a crate is invisible locally but breaks the lock file (see the crate-version rule in `AGENTS.md`).

## The two seams

**Frontend ↔ native** is Tauri IPC: string-named commands, plus events for progress on long jobs, plus a staging protocol for payloads too big to pass as arguments. Its conventions — and the fact that only part of the call sites go through the named bridge today — are in [`tauri-ipc-bridge.md`](tauri-ipc-bridge.md).

**Core ↔ plugins** is generated, not hand-wired. Runtime-installed plugins are data only; executable plugin code is compiled in from `plugins/` at build time via `scripts/generate-plugin-registry.mjs`. That boundary is enforced, not conventional — see [`plugins-framework.md`](plugins-framework.md).

## Where a change enters

- **A new UI surface** → a feature directory under `src/features/`, state through a module store ([`state-and-stores.md`](state-and-stores.md)), keys through the hotkey registry ([`hotkeys.md`](hotkeys.md)).
- **Anything the user can undo** → the typed history façade, registered at app-root lifetime ([`history-and-undo-redo.md`](history-and-undo-redo.md)). Getting the lifetime wrong breaks Ctrl+Z silently.
- **Something not ready for everyone** → an experiment gate ([`experiments-framework.md`](experiments-framework.md)).
- **A new native capability** → a command in `src-tauri/`, a wrapper in the IPC bridge, and the heavy work in a crate under `rust/`.
- **A new printer or format** → a plugin ([`plugins-complex-contributing.md`](plugins-complex-contributing.md)).
- **A new support type** → the walkthrough in [`support-type-extension.md`](support-type-extension.md); the support system is deliberately not registry-driven yet, so this is ~15 hand-wired points.

## Conventions that actually hold

- **Group by domain, not by file type.** `src/features/<domain>/` and `src/supports/<domain>/`, each owning its state, rendering and interaction together.
- **Register, don't import.** Subsystems that need to be extended expose a registry and let consumers register into it, rather than importing each other. The shapes are catalogued in [`registration-seams.md`](registration-seams.md).
- **Generated code is generated.** Anything matching `**/generated*` is produced by a script and gitignored; edit the generator, never the output.

## Two files that dominate the map

`src/app/page.tsx` (~10 800 lines) and `src/components/scene/SceneCanvas/SceneCanvas.tsx` (~7 400) are the editor shell and the canvas. Most cross-feature wiring still lands in them, which is why so many walkthroughs end with "mount it in `page.tsx`" or "…in `SceneCanvas.tsx`". Ongoing extraction work is tracked in [`page-tsx-refactor-handoff.md`](page-tsx-refactor-handoff.md).

## Verification

`npm test` (118 test files), `npm run build` (type-checks), `npm run check:docs`, and the plugin guardrails. `cargo test` is **not** wired into CI yet. See [`contributing.md`](contributing.md).
