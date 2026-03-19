# Contributing Complex Plugins

This guide is the implementation framework for **complex plugins** in DragonFruit.

Use this path when your plugin requires executable behavior (protocol handlers, upload logic, Tauri integration, native encoders). If your change is data-only, use a simple manifest plugin instead.

---

## 1) Decision: simple or complex?

Choose **complex plugin** if you need one or more of:

- custom network/protocol operations
- custom upload flow or progress semantics
- desktop/runtime behavior in Tauri
- custom container format encoder in native Rust

Choose **simple plugin** if you only need:

- printer preset packs
- material templates
- metadata + assets

---

## 2) Architecture principles

Complex plugin contributions must follow these rules:

1. **Plugin-owned behavior stays in `plugins/<vendor>/...`**
2. **Core app surfaces stay generic** (no vendor hardcoding in shared routes/registries)
3. **Registration is generated, not hand-wired**
4. **Allowlist + integrity checks are required**

---

## 3) Required integration flow

### 3.1 Source of truth

Each complex plugin must provide:

- `plugins/<vendor>/pluginDefinition.ts`
  - default export of `ComplexPluginDefinition`
  - includes `capabilities` block

### 3.2 Allowlist

Add plugin id to:

- `src/config/complex-plugin-allowlist.json`

### 3.3 Generated registration

Generator:

- `scripts/generate-plugin-registry.mjs`

Generated outputs:

- `src/features/plugins/generatedBuiltinComplexPlugins.ts`
- `src/features/plugins/generatedBuiltinComplexPluginNetworkHandlers.ts`
- `src/features/plugins/generatedBuiltinComplexPluginUploadHandlers.ts`
- `src-tauri/src/generated_builtin_plugins.rs`
- `rust/dragonfruit-slicer-v3/src/encoders/generated_plugin_encoders.rs`
- `src-tauri/generated_crate_requirements.toml` (audit of all plugin cargo dependencies)

Do not edit generated files manually.

---

## 4) Capability contract and entrypoints

`capabilities` in `pluginDefinition.ts` must match the files you provide.

| Capability flag            | Required file(s)                                                       | Required export                       |
| -------------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| `networkOperations: true`  | `plugins/<vendor>/network/networkHandlers.ts`                          | `handlePluginNetworkOperation`        |
| `uploadWithProgress: true` | `plugins/<vendor>/network/index.ts`                                    | `uploadPrintJobWithProgress`          |
| `tauriRuntimePlugin: true` | `plugins/<vendor>/rust/plugin.rs` + `plugins/<vendor>/rust/network.rs` | runtime registration/dispatch symbols |
| `slicerEncoder: true`      | `plugins/<vendor>/slicing/rust/encoder_impl.rs`                        | `create_plugin_encoder()`             |

If capabilities and files disagree, generation fails intentionally.

### 4.1) Multiple container formats per plugin (optional)

If your plugin supports multiple container formats (e.g., Anycubic with both AFF and AZFF), provide:

- `plugins/<vendor>/slicing/formats.json`
  - Schema: object mapping format type names to metadata
  - Each format lists supported file extensions
  - Generator validates extensions match registered encoder outputs
  - Optional: rich metadata (displayName, version, notes)

**Example** (`plugins/anycubic/slicing/formats.json`):

```json
{
  "AFF": {
    "extensions": [".aff", ".pmwb"],
    "displayName": "Anycubic AFF Format",
    "version": "1.0",
    "notes": "Standard AFF container format for Anycubic printers"
  },
  "AZFF": {
    "extensions": [".azff"],
    "displayName": "Anycubic AZFF (Enhanced)",
    "version": "2.0",
    "notes": "Enhanced AZFF format with improved compression"
  }
}
```

**Encoder function signature** (Rust):

```rust
pub fn create_plugin_encoder() -> Vec<Box<dyn FormatEncoder>> {
    vec![
        Box::new(AffPluginEncoder),
        Box::new(AzffPluginEncoder),
    ]
}
```

The function returns multiple encoder instances, one per format. Each encoder's `output_format()` method must match at least one extension in `formats.json`.

### 4.2) Required Cargo crates for slicer encoder (optional)

If your encoder implementation requires extra Rust crates beyond the core dragonfruit-slicer-v3 deps, declare them in:

- `plugins/<vendor>/slicing/rust/requiredCrates.toml`
  - Schema: TOML matching Cargo.toml `[dependencies]` and `[optional-dependencies]` sections
  - Generator validates version conflicts (strict: incompatible versions will fail the build)
  - Generator auto-merges into `dragonfruit-slicer-v3/Cargo.toml`
  - All declared crates become available to encoder code via `use ...`

**Example** (`plugins/anycubic/slicing/rust/requiredCrates.toml`):

```toml
[dependencies]
imageproc = { version = "0.23", features = ["image-hashing"] }
ndarray = "0.15"
numpy = { version = "0.20", optional = true }

[optional-dependencies]
gpu-utils = "1.2"

[features]
default = []
cuda-support = ["gpu-utils"]

[notes]
purpose = "Image processing and optional GPU support for AFF rendering"
minimum-rust = "1.75"
```

**Encoder code can then use** (within `encoder_impl.rs`):

```rust
use imageproc::processing;
use ndarray::Array2D;

pub fn create_plugin_encoder() -> Vec<Box<dyn FormatEncoder>> {
    vec![Box::new(AffPluginEncoder)]
}
```

**Version conflict resolution**: If two plugins declare the same crate with different versions, generator will fail with a clear error. Plugins must coordinate on compatible versions or be in separate builds.

---

## 5) Minimal template

`plugins/<vendor>/pluginDefinition.ts`:

```ts
import type { ComplexPluginDefinition } from "@/features/plugins/complexPluginContracts";

const PLUGIN_DEFINITION: ComplexPluginDefinition = {
  id: "<vendor-id>",
  manifest: {
    id: "<vendor-id>-builtin",
    name: "<Vendor Plugin>",
    version: "0.1.0",
  },
  capabilities: {
    networkOperations: false,
    uploadWithProgress: false,
    slicerEncoder: false,
    tauriRuntimePlugin: false,
  },
};

export default PLUGIN_DEFINITION;
```

---

## 6) Validation commands (required)

Run these before opening a PR:

1. `npm run generate:plugin-registry`
2. `npm run check:plugin-allowlist`
3. `npm run check:generated-plugin-registry`
4. `cargo check --manifest-path rust/dragonfruit-slicer-v3/Cargo.toml` (validates cargo crate merges)
5. `npm run build`
6. `cargo check --manifest-path src-tauri/Cargo.toml`

Optional but recommended:

- `npm test`

---

## 7) Error matrix (generator failures)

| Error pattern                                                                       | Meaning                                                                       | Fix                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `Discovered plugin(s) not in allowlist`                                             | Plugin folder contains `pluginDefinition.ts` but ID is missing from allowlist | Add ID to `src/config/complex-plugin-allowlist.json`     |
| `Allowlisted plugin(s) missing pluginDefinition.ts`                                 | Allowlist includes a plugin ID with no source definition                      | Add `pluginDefinition.ts` or remove stale allowlist ID   |
| `must declare a capabilities block`                                                 | Plugin definition omits `capabilities`                                        | Add `capabilities` object                                |
| `declares networkOperations=true but is missing network/networkHandlers.ts`         | Capability/file mismatch                                                      | Add file or set capability false                         |
| `has network/networkHandlers.ts but capabilities.networkOperations is not true`     | Extra file for disabled capability                                            | Set capability true or remove file                       |
| `declares uploadWithProgress=true but is missing network/index.ts`                  | Capability/file mismatch                                                      | Add file or set capability false                         |
| `declares slicerEncoder=true but is missing slicing/rust/encoder_impl.rs`           | Capability/file mismatch                                                      | Add file or set capability false                         |
| `declares tauriRuntimePlugin=true but is missing rust/plugin.rs or rust/network.rs` | Capability/file mismatch                                                      | Add both files or set capability false                   |
| `formats.json exists but is not valid JSON`                                         | Malformed JSON in formats.json                                                | Fix JSON syntax                                          |
| `formats.json declares extensions not matching any encoder output_format()`         | Extension in formats.json has no corresponding encoder                        | Add encoder or remove extension from formats.json        |
| `create_plugin_encoder() declares slicerEncoder=true but returns no encoders`       | Encoder function returns empty vec                                            | Return at least one encoder instance                     |
| `requiredCrates.toml exists but is not valid TOML`                                  | Malformed TOML in requiredCrates.toml                                         | Fix TOML syntax (test with `toml-cli`)                   |
| `requiredCrates.toml: crate X version conflict (plugin A: 0.5, plugin B: 0.6)`      | Two plugins declare same crate with incompatible versions                     | Coordinate plugin versions or split into separate builds |
| `requiredCrates.toml declares crate with invalid semver`                            | Version string not valid semver (e.g., `latest`)                              | Use explicit version constraint (e.g., `^1.0` or `0.5`)  |

---

## 8) Safety requirements

Complex plugin PRs must preserve DragonFruit’s safety guarantees:

- no runtime code fetching/eval
- no untrusted binary execution paths
- strict input validation on network and file boundaries
- explicit timeout/error handling in protocol operations

---

## 9) PR checklist

Before requesting review:

- [ ] Plugin logic is isolated under `plugins/<vendor>/...`
- [ ] `pluginDefinition.ts` exists, default-exports, and declares capabilities
- [ ] Plugin ID is allowlisted
- [ ] If `slicerEncoder: true`: `encoder_impl.rs` exists and `create_plugin_encoder()` function is properly exported
- [ ] If supporting multiple formats: `formats.json` exists and all extensions have matching encoders
- [ ] If using extra cargo crates: `requiredCrates.toml` exists (if needed) and is valid TOML with semver versions
- [ ] Generated registries are up-to-date and committed
- [ ] No vendor hardcoding leaked into generic app routes/registries
- [ ] Docs updated (`plugins/README.md` + plugin-local README)
- [ ] Validation commands pass

---

## 10) Review expectations

Reviewers will evaluate:

- architectural isolation and maintainability
- compatibility with generated registration framework
- safety and failure semantics
- clarity of docs and migration impact
- regression risk against existing plugins

---

## 11) Useful references

- Framework overview: `plugins/README.md`
- Athena reference implementation: `plugins/athena/README.md`
- Generic plugin network route: `src/app/api/network/plugin/route.ts`
- Plugin settings UI: `src/components/settings/PluginsSettingsTab.tsx`
- Tauri plugin registry: `src-tauri/src/plugin_registry.rs`
