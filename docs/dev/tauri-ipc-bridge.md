# Tauri IPC and Native Bridge

The desktop app (Tauri) exposes **107** native commands to the frontend
(`#[tauri::command]` under `src-tauri/src/`, all registered in the single
`tauri::generate_handler![…]` list in `main.rs`).

`src/features/slicing/tauri/nativeSlicerBridge.ts` is the **intended** seam: it
holds 26 named wrappers and is where the cross-language conventions below are
centralized. It is not yet the only one. Today there are also **84 direct
`invoke(...)` call sites in 29 other modules**, reaching ~70 distinct commands —
nine of those modules are React components (`SettingsModal.tsx`,
`PrintingPanel.tsx`, `SliceCompletedModal.tsx`, the settings tabs, `page.tsx`).

So the rule is directional, not descriptive:

- **New commands**: add a named wrapper in `nativeSlicerBridge.ts` and call that.
  Do not add a new direct `invoke` from a component.
- **Existing direct call sites**: leave them alone unless you are already
  changing that code. Consolidating all 84 is a deliberate refactor of its own —
  see `dev/backlog.md`.

Regenerate these counts rather than trusting them:

```bash
grep -rn '#\[tauri::command\]' src-tauri/src | wc -l
grep -rhoE '\binvoke(<[^>]*>)?\(' src plugins --include=*.ts --include=*.tsx \
  --exclude=nativeSlicerBridge.ts | wc -l
```

## How a command is wired

1. **Rust side** — declare `#[tauri::command] async fn cmd_name(args: SomeArgs) -> Result<T, String>`
   in `src-tauri/src/main.rs` (or a command module like `mesh_repair.rs`, `sdf.rs`,
   `network.rs`, `plugin_registry.rs`). Arguments are deserializable structs with
   `#[serde(rename_all = "camelCase")]` so TS keys map to snake_case fields.
   Register it in the single `tauri::generate_handler![…]` list in `main.rs`.
2. **TS side** — add a wrapper in `nativeSlicerBridge.ts`:

   ```ts
   export async function pickOpenFilesWithNativeDialog(
     category: NativeOpenDialogCategory,
     multiple = false,
     sceneExtensions?: string[],
   ): Promise<NativePickedOpenFile[]> {
     const core = await loadTauriCore();
     if (!core) throw new Error('…only available in DragonFruit Desktop (Tauri runtime).');
     return core.invoke<NativePickedOpenFile[]>('pick_open_files', {
       args: { category, multiple, ...(sceneExtensions !== undefined ? { sceneExtensions } : {}) },
     });
   }
   ```

   `loadTauriCore()` lazily imports `@tauri-apps/api/core` and gates on
   `__TAURI_INTERNALS__`, so the web build (no Tauri) can import the module
   safely and fail at call time with a clear message.

3. **Events** — long-running native work streams progress via Tauri events, e.g.
   `listen('slicer://progress', …)`. Wrappers that need progress expose a
   callback or a subscription rather than blocking on the invoke.

## Conventions to respect

- **camelCase in TS → snake_case in Rust.** `serde(rename_all = "camelCase")`
  on the args struct handles the field names; keep payloads flat.
- **Binary vs JSON.** Large binary payloads (mesh geometry, slice output) use a
  two-step staging protocol rather than a giant JSON argument. The bridge
  stages bytes (e.g. `x-mesh-stage-*` headers / chunk append commands) and then
  references them by path or id in the actual command.
- **Atomic writes.** File writes go through `scene_file_begin/commit/discard_atomic`
  so an interrupted save can't corrupt an existing file. Use these for any
  new write path, not `write_bytes_to_path` straight to a user file.
- **Single-flight write lock.** `runExclusiveNativeWrite` serializes process-wide
  writes. Two chunk sequences to different paths evict each other and re-truncate
  — writers must be single-flight.
- **Cancellation.** Long-running commands (slicing, SDF, A* pathfinding) support
  a cancel command (`cancel_slicing`, …). Always offer cancellation for anything
  that runs longer than a second.

## The Rust side of the seam

Where the TS side is a set of wrappers, the native side keeps its cross-command
state in process-wide `OnceLock` statics in `main.rs`:

- `SLICER_POOL: OnceLock<ThreadPool>` — the Rayon pool jobs run on.
- `CANCEL_FLAG: OnceLock<Arc<AtomicBool>>` — shared with the worker, checked in
  hot loops; the cancel command just flips it.
- `STAGED_MESH`, `STAGED_MESH_STATS`, `STAGED_MESH_FILE_PATH`,
  `STAGED_MESH_FILE_APPENDER` — the staging protocol's buffer, counters,
  scratch path and appender.

That the staging state is a **process-wide singleton, not per-call**, is the
reason writers must be single-flight: two overlapping stage sequences share
these statics.

**The runtime backend is a compile-time choice.** `src-tauri/Cargo.toml` builds
Tauri with `default-features = false` and selects the backend by feature —
`tauri-wry` or `tauri-cef` (`tauri-cef = ["tauri/cef"]`, used for Linux CEF
builds). `main.rs` branches on `#[cfg(feature = "tauri-cef")]`, so anything
touching the app handle type has to compile under both.

## Dialog helpers

Native pickers are wrapped with explicit filter control:

- `pick_open_files` takes a `category` (`mesh`/`scene`/`bundle`). Scene dialogs
  accept an optional `sceneExtensions` override so gated file types (see
  `dev/experiments-framework.md`) are hidden from the filter.
- `pick_save_path` takes `defaultFilename` + `filters`.
- `local_backup_pick_directory` is a folder picker.

## Guardrails

- `npm run build` type-checks the TS side, so a wrapper whose *signature* drifts
  from its callers fails the build. Note what this does **not** catch: the
  command name is a plain string, so a wrapper naming a command that no longer
  exists in Rust type-checks fine and fails at runtime. Nothing verifies the two
  sides agree — grep the Rust side when renaming a command.
- The `toNativeMetadataPayload` mapper is exported and covered by a crossing
  contract test — update the test when the metadata shape changes.
- `cargo check --manifest-path src-tauri/Cargo.toml` before touching the Rust side.

## Related pages

- `dev/experiments-framework.md` (dialog extension gating)
- `dev/backlog.md` (native twin optimization roadmap)
