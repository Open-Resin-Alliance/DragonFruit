# Plugin Framework

DragonFruit supports two plugin classes with explicit trust boundaries.

## Plugin classes

| Class          | Install model                                   | Contains executable code | Typical use                                                            |
| -------------- | ----------------------------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| Simple plugin  | Runtime install from GitHub manifest            | No                       | Presets, material templates, metadata, assets                          |
| Complex plugin | Repository contribution + build-time generation | Yes                      | Protocol handlers, upload flows, runtime integrations, native encoders |

!!! note
      Core rule: runtime-installed plugins are data-only. Executable plugin code is build-time only.

## Simple plugin contract

Simple plugins are manifest-driven and intentionally restricted.

- Default manifest file: `dragonfruit-plugin.json`
- Required fields: `id`, `name`, `version`
- No runtime code download or execution
- Installed through Settings → Plugins

Key implementation points:

- API route: `src/app/api/plugins/github-manifest/route.ts`
- Built-in allowlist: `src/config/builtin-simple-plugin-allowlist.json`
- Generator: `scripts/generate-builtin-simple-plugins.mjs`
- Generated output consumed by: `src/features/plugins/builtinSimplePlugins.ts`

## Complex plugin contract

Complex plugins provide executable behavior and must use generated registration.

- Plugin source root: `plugins/<vendor>/`
- Required entrypoint: `plugins/<vendor>/pluginDefinition.ts`
- Plugin ID must be in `src/config/complex-plugin-allowlist.json`
- Registration is generated via `scripts/generate-plugin-registry.mjs`

Generated outputs include frontend registries and Rust/Tauri registries.

## Capability-gated files

Capability flags in `pluginDefinition.ts` must match files on disk.

| Capability           | Required file(s)                    | Required export                |
| -------------------- | ----------------------------------- | ------------------------------ |
| `networkOperations`  | `network/networkHandlers.ts`        | `handlePluginNetworkOperation` |
| `uploadWithProgress` | `network/index.ts`                  | `uploadPrintJobWithProgress`   |
| `tauriRuntimePlugin` | `rust/plugin.rs`, `rust/network.rs` | runtime registration symbols   |
| `slicerEncoder`      | `slicing/rust/encoder_impl.rs`      | `create_plugin_encoder()`      |
| `fileType`           | `fileTypeHandlers.ts`               | `handleFileTypeImport`         |

Capability/file mismatches intentionally fail generation.

## Guardrails and verification

Before opening a plugin PR, run:

- `npm run generate:plugin-registry`
- `npm run check:plugin-allowlist`
- `npm run check:generated-plugin-registry`
- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`

CI guardrail workflow: `.github/workflows/plugin-registry-guardrails.yml`.

## Related pages

- `dev/plugins-complex-contributing.md`
- `dev/formats.md`
