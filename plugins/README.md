# DragonFruit Plugins

DragonFruit supports a plugin architecture for printer ecosystems and vendor-specific extensions.

This directory contains **built-in plugins** that ship with DragonFruit (for example Athena). DragonFruit also supports installing **external GitHub manifest plugins** through the Settings UI.

---

## Plugin model at a glance

DragonFruit supports two plugin paths:

1. **External manifest plugins (GitHub)**
   - Data-only extensions: metadata, printer presets, and material templates.
   - Installed from a GitHub repository manifest.
2. **Built-in complex plugins (repository PRs)**
   - Runtime logic/tooling: protocol handlers, custom workflows, advanced integration code.
   - Contributed directly to this repository and compiled with the app.

---

## Security model

External GitHub plugins are intentionally restricted to manifest data.

- Allowed: metadata, printer preset packs, material template packs.
- Not allowed: remote JS/TS execution, runtime code download/eval, external binaries.

This keeps external plugin installation safe while allowing advanced integrations through built-in plugins.

---

## Built-in plugins

Built-in plugins live under `plugins/<vendor>/`.

Current example:

- `plugins/athena/`
  - `pluginManifest.ts`
  - `nanodlpProfilePlugin.ts`
  - `network/nanodlpHandlers.ts`
  - `network/nanodlp.ts`
  - `printers/concepts3d/`

Built-in plugin assets can be served from:

- `/api/profile-assets/plugins/<plugin-folder>/<path-inside-plugin>`

Example:

- `/api/profile-assets/plugins/athena/printers/concepts3d/assets/athena2-16k.png`

---

## External GitHub manifest plugins

### Manifest filename

- Default: `dragonfruit-plugin.json`

### Minimal schema

```json
{
  "schemaVersion": 1,
  "id": "my-vendor-plugin",
  "name": "My Vendor Plugin",
  "version": "1.0.0",
  "description": "Optional description",
  "author": "Vendor",
  "homepage": "https://example.com",
  "printerPresets": [],
  "materialTemplates": []
}
```

### Required fields

- `id` (max 120 chars)
- `name` (max 120 chars)
- `version` (max 48 chars)

### Optional fields

- `description` (max 500 chars)
- `author` (max 120 chars)
- `homepage` (http/https URL)
- `printerPresets` (max 128)
- `materialTemplates` (max 512)

### Asset path behavior

- Relative paths are resolved relative to the manifest location.
- Absolute `http(s)` URLs are accepted.
- `data:` URLs are rejected.

---

## External plugin repository layout

Typical repository structure:

```text
my-vendor-plugin/
├── dragonfruit-plugin.json
└── assets/
    ├── printer-1.png
    └── ...
```

Presets and material templates can be embedded directly in `dragonfruit-plugin.json`.

---

## Install flow (external plugins)

### User flow

1. Open **Settings → Plugins**
2. Enter a GitHub repository URL
3. Click **Install Plugin**

### Runtime flow

1. `POST /api/plugins/github-manifest` fetches the manifest from GitHub
2. Manifest fields are validated/sanitized
3. Installed plugin metadata is persisted locally
4. Presets/templates are merged into runtime lists

Uninstall is handled from the same Settings UI.

### Optional custom manifest path

The API supports `manifestPath` when the manifest is not at repository root.

---

## Complex plugin contributions

Complex plugins (custom tooling/runtime logic) are contributed as built-in plugins via pull request.

See:

- `plugins/CONTRIBUTING_COMPLEX_PLUGINS.md`

---

## Runtime integration points

- Plugin profile registry: `src/features/plugins/pluginRegistry.ts`
- Network plugin handler registry: `src/features/plugins/networkPluginRegistry.ts`
- GitHub manifest route: `src/app/api/plugins/github-manifest/route.ts`
- Network plugin route dispatcher: `src/app/api/network/plugin/route.ts`
- Settings UI: `src/components/settings/PluginsSettingsTab.tsx`

---

## Authoring guidelines

- Keep vendor-specific logic in plugin-owned files.
- Keep shared/core UI generic.
- Use semantic versions for plugin manifests.
- Validate behavior with and without the plugin enabled.
