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
4. `npm run build`
5. `cargo check --manifest-path src-tauri/Cargo.toml`

Optional but recommended:

- `npm test`

---

## 7) Error matrix (generator failures)

| Error pattern                                                                       | Meaning                                                                       | Fix                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| `Discovered plugin(s) not in allowlist`                                             | Plugin folder contains `pluginDefinition.ts` but ID is missing from allowlist | Add ID to `src/config/complex-plugin-allowlist.json`   |
| `Allowlisted plugin(s) missing pluginDefinition.ts`                                 | Allowlist includes a plugin ID with no source definition                      | Add `pluginDefinition.ts` or remove stale allowlist ID |
| `must declare a capabilities block`                                                 | Plugin definition omits `capabilities`                                        | Add `capabilities` object                              |
| `declares networkOperations=true but is missing network/networkHandlers.ts`         | Capability/file mismatch                                                      | Add file or set capability false                       |
| `has network/networkHandlers.ts but capabilities.networkOperations is not true`     | Extra file for disabled capability                                            | Set capability true or remove file                     |
| `declares uploadWithProgress=true but is missing network/index.ts`                  | Capability/file mismatch                                                      | Add file or set capability false                       |
| `declares slicerEncoder=true but is missing slicing/rust/encoder_impl.rs`           | Capability/file mismatch                                                      | Add file or set capability false                       |
| `declares tauriRuntimePlugin=true but is missing rust/plugin.rs or rust/network.rs` | Capability/file mismatch                                                      | Add both files or set capability false                 |

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
