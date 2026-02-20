# Dragonfruit Plugins

Dragonfruit supports a **safe profile-plugin system** for vendor/printer extensions.

This root `plugins/` directory is for built-in plugins that ship with Dragonfruit (for example Athena).
External plugins can be installed from GitHub via the Settings → Plugins loader.

---

## Goals

The plugin system is designed to:

- keep vendor-specific logic out of core app UI,
- allow new printer ecosystems to add presets/material profiles,
- avoid hard dependencies on any single vendor,
- remain safe: **no remote code execution**.

---

## Safety model

Dragonfruit only loads **JSON manifest data** from external GitHub repos.

- ✅ Allowed: metadata, printer preset packs, material template packs.
- ❌ Not allowed: downloading and executing arbitrary JS/TS from external repos.

Built-in plugins (like Athena) are compiled with Dragonfruit and always available.

---

## Built-in plugin

- `plugins/athena/nanodlpProfilePlugin.ts`
  - Athena/NanoDLP field semantics
  - Basic/Advanced grouping and classification
  - dynamic wait behavior logic
  - tooltip/help text for advanced parameters
- `plugins/athena/printers/concepts3d/`
  - plugin-owned printer presets (`printers.json`)
  - plugin-owned images (`assets/*`)

Built-in plugin assets can be served from:

- `/api/profile-assets/plugins/<plugin-folder>/<path-inside-plugin>`

Example:

- `/api/profile-assets/plugins/athena/printers/concepts3d/assets/athena2-16k.png`

---

## External plugin manifest

Default manifest filename:

- `dragonfruit-plugin.json`

Minimal schema:

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

### Notes

- `id`, `name`, `version` are required.
- `printerPresets` and `materialTemplates` are optional.
- Relative preset image paths are resolved to raw GitHub URLs during install.

---

## Loader flow

1. User opens **Settings → Plugins**.
2. User enters GitHub repo URL.
3. Dragonfruit server route fetches manifest from GitHub and validates it.
4. Manifest is stored locally as an installed external plugin.
5. Runtime preset/template lists are merged with built-in data.

If no external plugins are installed, Dragonfruit behaves normally with built-in defaults.

---

## Where plugin runtime lives

- Registry/runtime merge logic:
  - `src/features/plugins/pluginRegistry.ts`
- GitHub manifest fetch endpoint:
  - `src/app/api/plugins/github-manifest/route.ts`
- Settings UI plugin loader:
  - `src/components/settings/PluginsSettingsTab.tsx`

---

## Authoring guidance

- Keep plugin logic pure and declarative where possible.
- Put vendor-specific semantics in plugin files, not generic components.
- Version plugin manifests semantically (`x.y.z`).
- Test with and without plugin installed to ensure graceful fallback behavior.
