# Athena Complex Plugin

Athena is DragonFruit’s reference **complex plugin** for NanoDLP-class printers.

It demonstrates end-to-end plugin ownership across:

- profile and material semantics
- network protocol operations
- upload orchestration
- monitoring parsing
- native slicing container encoding (`.nanodlp`)

---

## 1) Purpose and scope

Athena exists to keep vendor-specific behavior outside core app modules while still supporting deep runtime integration.

Primary scope:

- NanoDLP connection/discovery/material/print operations
- Athena printer preset + asset pack
- Athena-specific monitoring interpretation
- Athena-owned native output format support

Out of scope:

- generic plugin registry behavior (owned by core framework)
- runtime-installed executable plugin code

---

## 2) Folder map

`plugins/athena/`:

- `pluginDefinition.ts`
  - complex plugin definition + capabilities
- `pluginManifest.ts`
  - built-in metadata + printer preset pack binding
- `printers/printers.json`
  - Athena printer presets
- `printers/assets/*`
  - preset thumbnails
- `nanodlp/*`
  - profile/material UI semantics and transformation helpers
- `network/nanodlp.ts`
  - shared NanoDLP utility layer
- `network/networkHandlers.ts`
  - canonical plugin network entrypoint (`handlePluginNetworkOperation`)
- `network/nanodlpHandlers.ts`
  - Athena NanoDLP operation router implementation
- `network/handlers/*`
  - operation-focused modules (`connect`, `discover`, `materials`, `jobs`, `printer`)
- `network/index.ts`
  - Athena network barrel + upload entrypoint
- `slicing/nanodlpFormatDefinition.ts`
  - TS format metadata for `.nanodlp`
- `slicing/rust/encoder_impl.rs`
  - Rust encoder implementation (`create_plugin_encoder()`)

---

## 3) Capability declaration

Athena declares capabilities in `pluginDefinition.ts`:

- `networkOperations: true`
- `uploadWithProgress: true`
- `tauriRuntimePlugin: true`
- `slicerEncoder: true`

These flags must stay consistent with source entrypoints; generator checks enforce this.

---

## 4) Integration points (how Athena gets wired)

Athena is wired through **generated registries** (not manual core registration):

- `src/features/plugins/generatedBuiltinComplexPlugins.ts`
- `src/features/plugins/generatedBuiltinComplexPluginNetworkHandlers.ts`
- `src/features/plugins/generatedBuiltinComplexPluginUploadHandlers.ts`
- `src-tauri/src/generated_builtin_plugins.rs`
- `rust/dragonfruit-slicing-engine/src/encoders/generated_plugin_encoders.rs`

Core consumers:

- `src/features/plugins/pluginRegistry.ts`
- `src/features/plugins/networkPluginRegistry.ts`
- `src/app/api/network/plugin/route.ts`
- `src-tauri/src/plugin_registry.rs`
- `rust/dragonfruit-slicing-engine/src/encoders/registry.rs`

---

## 5) Request lifecycle examples

### 5.1 Network operation path

1. UI sends operation to generic route: `/api/network/plugin`
2. Core registry resolves `pluginId: 'athena'`
3. Athena entrypoint `handlePluginNetworkOperation` runs
4. Athena operation router delegates to `network/handlers/*`
5. Response returns as normalized `{ status, body }`

### 5.2 Material edit flow

1. UI derives draft using `nanodlp/*` helpers
2. Draft is denormalized to NanoDLP payload
3. Operation dispatches through generic plugin route
4. Athena handler applies NanoDLP-specific semantics

### 5.3 Slicing output flow (`.nanodlp`)

1. Format selection resolves Athena-owned format metadata
2. Native encoder registry resolves Athena plugin encoder
3. `create_plugin_encoder()` returns encoder instance
4. Athena Rust encoder writes NanoDLP container

---

## 6) Asset and preset ownership

Athena assets are plugin-owned and served via:

- `/api/profile-assets/plugins/athena/printers/assets/<file>`

Preset source of truth:

- `plugins/athena/printers/printers.json`

---

## 7) Contributor rules for Athena changes

When editing Athena, keep these boundaries:

1. Vendor-specific logic stays under `plugins/athena/*`
2. Core routes/registries remain vendor-agnostic
3. New network behavior should land in `network/handlers/*`
4. Update docs when capabilities or folder contracts change
5. Regenerate and validate before PR

Required checks:

- `npm run generate:plugin-registry`
- `npm run check:plugin-allowlist`
- `npm run check:generated-plugin-registry`
- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`

---

## 8) Known format support

- Supported: `.nanodlp`
- Not supported: `.ctb`

---

## 9) Related docs

- Plugin framework: `plugins/README.md`
- Complex plugin contribution framework: `plugins/CONTRIBUTING_COMPLEX_PLUGINS.md`
