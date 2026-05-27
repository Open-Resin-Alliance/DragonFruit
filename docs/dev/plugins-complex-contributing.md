# Contributing Complex Plugins

Use this path when a plugin needs executable behavior (protocol handlers, upload logic, Tauri integration, native encoders). If the change is data-only, use a simple manifest plugin.

## When to choose a complex plugin

Use a **complex plugin** if you need one or more of:

- custom network/protocol operations
- custom upload flow or progress semantics
- desktop/runtime behavior in Tauri
- custom container format encoder in native Rust

Use a **simple plugin** if you only need:

- printer preset packs
- material templates
- metadata + assets

## Architecture rules

Complex plugin contributions must follow these rules:

1. **Plugin-owned behavior stays in `plugins/<vendor>/...`**
2. **Core app surfaces stay generic** (no vendor hardcoding in shared routes/registries)
3. **Registration is generated, not hand-wired**
4. **Allowlist + integrity checks are required**

## Required integration flow

### Source of truth

Each complex plugin must provide:

- `plugins/<vendor>/pluginDefinition.ts`
  - default export of `ComplexPluginDefinition`
  - includes `capabilities` block

### Allowlist

Add plugin id to:

- `src/config/complex-plugin-allowlist.json`

### Generated registration

Generator:

- `scripts/generate-plugin-registry.mjs`

Generated outputs:

- `src/features/plugins/generatedBuiltinComplexPlugins.ts`
- `src/features/plugins/generatedBuiltinComplexPluginNetworkHandlers.ts`
- `src/features/plugins/generatedBuiltinComplexPluginUploadHandlers.ts`
- `src/features/plugins/generatedBuiltinComplexPluginFileTypeHandlers.ts`
- `src-tauri/src/generated_builtin_plugins.rs`
- `rust/dragonfruit-slicer-v3/src/encoders/generated_plugin_encoders.rs`
- `src-tauri/generated_crate_requirements.toml` (audit of all plugin cargo dependencies)

Do not edit generated files manually.

## Capability contract and entrypoints

`capabilities` in `pluginDefinition.ts` must match the files you provide.

| Capability flag            | Required file(s)                                                       | Required export                       |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| `networkOperations: true`  | `plugins/<vendor>/network/networkHandlers.ts`                          | `handlePluginNetworkOperation`        |
| `uploadWithProgress: true` | `plugins/<vendor>/network/index.ts`                                    | `uploadPrintJobWithProgress`          |
| `tauriRuntimePlugin: true` | `plugins/<vendor>/rust/plugin.rs` + `plugins/<vendor>/rust/network.rs` | runtime registration/dispatch symbols |
| `slicerEncoder: true`      | `plugins/<vendor>/slicing/rust/encoder_impl.rs`                        | `create_plugin_encoder()`             |
| `fileType: true`           | `plugins/<vendor>/fileTypeHandlers.ts`                                 | `handleFileTypeImport`                |

If capabilities and files disagree, generation fails intentionally.

### File type import capability

Set `fileType: true` when your plugin can import files of a given extension into DragonFruit scenes.

The plugin must:

1. Declare one or more `fileTypes` entries in `pluginDefinition.ts` (see type `PluginFileTypeDefinition` in `complexPluginContracts.ts`).
2. Export `handleFileTypeImport` from `fileTypeHandlers.ts`.

The host reads `GENERATED_BUILTIN_COMPLEX_PLUGIN_FILE_TYPE_HANDLERS` from the generated registry to dispatch file imports to the correct plugin at runtime. The host also reads the `fileTypes` metadata (from the definition) to build OS-level file picker filters and drive scene file routing.

**Naming rule**: File-type plugin code must use the format's technical acronym (e.g. `LYS`), never brand or product names.

### Multiple container formats per plugin (optional)

If your plugin supports multiple container formats (e.g., Anycubic with both AFF and AZFF), provide:

- `plugins/<vendor>/slicing/formats.json`

The function returns multiple encoder instances, one per format. Each encoder's `output_format()` method must match at least one extension in `formats.json`.

### Extra Cargo crates for slicer encoder (optional)

If your encoder implementation requires extra Rust crates beyond the core dragonfruit-slicer-v3 deps, declare them in:

- `plugins/<vendor>/slicing/rust/requiredCrates.toml`

Generator validates version conflicts and auto-merges dependencies into the slicer crate.

## Validation commands (required)

Run these before opening a PR:

1. `npm run generate:plugin-registry`
2. `npm run check:plugin-allowlist`
3. `npm run check:generated-plugin-registry`
4. `cargo check --manifest-path rust/dragonfruit-slicer-v3/Cargo.toml`
5. `npm run build`
6. `cargo check --manifest-path src-tauri/Cargo.toml`

Optional but recommended:

- `npm test`

## Common generator failures

Common generation failures include:

- plugin discovered but missing from allowlist
- allowlisted plugin missing locally (often an uninitialized submodule)
- missing `capabilities` block
- capability/file mismatch (declared capability but missing required file, or inverse)
- malformed `formats.json`
- malformed `requiredCrates.toml`
- crate version conflict across plugins

When these happen, fix contract mismatches first, then regenerate.

## Safety requirements

Complex plugin PRs must preserve DragonFruit’s safety guarantees:

- no runtime code fetching/eval
- no untrusted binary execution paths
- strict input validation on network and file boundaries
- explicit timeout/error handling in protocol operations

## PR checklist

Before requesting review:

- [ ] Plugin logic is isolated under `plugins/<vendor>/...`
- [ ] `pluginDefinition.ts` exists, default-exports, and declares capabilities
- [ ] Plugin ID is allowlisted
- [ ] Generated registries are up-to-date and committed
- [ ] No vendor hardcoding leaked into generic app routes/registries
- [ ] Validation commands pass

## Useful references

- Plugin framework overview: `docs/dev/plugins-framework.md`
- Plugin source folder: `plugins/`
- Generic plugin network route: `src/app/api/network/plugin/route.ts`
- Plugin settings UI: `src/components/settings/PluginsSettingsTab.tsx`
- Tauri plugin registry: `src-tauri/src/plugin_registry.rs`
