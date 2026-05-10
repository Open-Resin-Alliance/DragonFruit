# DragonFruit Plugin Framework

This folder defines the plugin system for DragonFruit.

DragonFruit supports two plugin classes with intentionally different trust and capability boundaries:

- **Simple plugins** (runtime-installed, data-only, GitHub manifest based)
- **Complex plugins** (repository-contributed, compile-time integrated, code-capable)

If you remember one rule, remember this one: **runtime-installed plugins are data; executable plugin code is build-time only**.

---

## Plugin classes at a glance

| Class          | Install model                        | Contains code? | Primary use                                                | Trust model                        |
| -------------- | ------------------------------------ | -------------- | ---------------------------------------------------------- | ---------------------------------- |
| Simple plugin  | Runtime install from GitHub manifest | No             | Presets, templates, metadata, assets                       | Restricted + validated             |
| Complex plugin | PR into this repository              | Yes            | Protocols, upload flows, network handlers, native encoders | Reviewed + allowlisted + generated |

---

## Simple plugins (manifest plugins)

Simple plugins are a safe extension mechanism for printer/material content.

### Allowed

- Manifest metadata
- Printer preset packs
- Material templates
- Static asset references

### Not allowed

- Remote JS/TS execution
- Runtime code download/eval
- External binaries

### Manifest basics

- Default filename: `dragonfruit-plugin.json`
- Required: `id`, `name`, `version`
- Optional: `description`, `author`, `homepage`, `printerPresets`, `materialTemplates`

### Install flow

1. User installs from **Settings → Plugins**
2. `POST /api/plugins/github-manifest` fetches + validates manifest
3. Metadata is persisted
4. Presets/templates merge into runtime lists

### Built-in simple plugins (core-owned wiring)

- Built-in simple plugin enrollment is declared in `src/config/builtin-simple-plugin-allowlist.json`.
- A generator (`scripts/generate-builtin-simple-plugins.mjs`) produces `src/features/plugins/generatedBuiltinSimplePlugins.ts`.
- Core runtime consumes generated manifests only (`src/features/plugins/builtinSimplePlugins.ts`).
- Result: plugin folders remain data-only (`dragonfruit-plugin.json`, preset JSON, assets) with no plugin-specific TS wiring in core files.

### Runtime safety controls

- GitHub repository allowlist (`DRAGONFRUIT_PLUGIN_GITHUB_ALLOWLIST`)
- Optional explicit liability acknowledgment for unallowlisted repos
- Optional manifest SHA-256 verification (`expectedManifestSha256`)

Route reference: `src/app/api/plugins/github-manifest/route.ts`

---

## Complex plugins (compiled plugins)

Complex plugins are for integrations that require executable logic.

### Typical capabilities

- Network/protocol operations
- Upload orchestration
- Monitoring adapters
- Native Rust/Tauri runtime integration
- Native slicer container encoders

### Registration architecture (generated)

Complex plugin bindings are generated at build-time from plugin definitions + allowlist.

- Generator: `scripts/generate-plugin-registry.mjs`
- Allowlist: `src/config/complex-plugin-allowlist.json`

Generated outputs:

- `src/features/plugins/generatedBuiltinComplexPlugins.ts`
- `src/features/plugins/generatedBuiltinComplexPluginNetworkHandlers.ts`
- `src/features/plugins/generatedBuiltinComplexPluginUploadHandlers.ts`
- `src-tauri/src/generated_builtin_plugins.rs`
- `rust/dragonfruit-slicer-v3/src/encoders/generated_plugin_encoders.rs`

Integrity hardening:

- Generated allowlist SHA-256 is verified during Tauri startup.

---

## Complex plugin source conventions

Complex plugins live at `plugins/<vendor>/`.

Complex plugin sources may be either regular in-repo folders or Git submodules
mounted under `plugins/<vendor>`. For submodule-backed plugins, ensure
submodules are initialized/updated before running CI validation commands.
Local generation/build commands skip missing plugin submodules with warnings
and compile with the plugin sources that are available.

Required entrypoint:

- `plugins/<vendor>/pluginDefinition.ts`
  - must default-export `ComplexPluginDefinition`
  - must include a `capabilities` block

Optional entrypoints (gated by capabilities):

- Frontend network operations
  - `plugins/<vendor>/network/networkHandlers.ts`
  - export alias: `handlePluginNetworkOperation`
- Frontend upload bridge
  - `plugins/<vendor>/network/index.ts`
  - export: `uploadPrintJobWithProgress`
- Tauri runtime plugin
  - `plugins/<vendor>/rust/plugin.rs`
  - `plugins/<vendor>/rust/network.rs`
- Native slicer encoder
  - `plugins/<vendor>/slicing/rust/encoder_impl.rs`
  - export: `create_plugin_encoder()`

Capability/file mismatches fail generation by design.

---

## Asset model

Built-in plugin assets are served from:

- `/api/profile-assets/plugins/<plugin-folder>/<path-inside-plugin>`

Example:

- `/api/profile-assets/plugins/athena/printers/assets/athena2-16k.png`

---

## Guardrails and verification

Use these checks before opening a PR:

- `npm run generate:plugin-registry`
- `npm run check:plugin-allowlist`
- `npm run check:generated-plugin-registry`
- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`

CI guardrail workflow:

- `.github/workflows/plugin-registry-guardrails.yml`

---

## Where plugin behavior is wired

- Profile plugin registry: `src/features/plugins/pluginRegistry.ts`
- Built-in plugin definition list: `src/features/plugins/builtinComplexPlugins.ts`
- Network handler registry: `src/features/plugins/networkPluginRegistry.ts`
- Generic network API route: `src/app/api/network/plugin/route.ts`
- Tauri plugin registry: `src-tauri/src/plugin_registry.rs`
- Native encoder registry: `rust/dragonfruit-slicer-v3/src/encoders/registry.rs`
- Plugin settings UI: `src/components/settings/PluginsSettingsTab.tsx`

---

## Contributing next

If you’re adding executable plugin behavior, continue in:

- `plugins/CONTRIBUTING_COMPLEX_PLUGINS.md`

If you’re adding Athena-specific behavior, see:

- `plugins/athena/README.md`
