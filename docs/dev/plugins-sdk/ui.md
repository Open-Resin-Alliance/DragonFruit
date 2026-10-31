# UI contributions

Status: **partly shipped, partly planned**. A package can declare a material pane
schema today. Custom panels are a design, not an implementation. Read the section
that applies before promising a vendor a pane.

## What a package renders today

The tier accepts **data**, never webview code. Three shapes reach the UI:

| UI surface | How a package fills it | State |
| --- | --- | --- |
| Output format in the format picker | `formats[]` in the manifest | shipped |
| File types in the import dialog | `fileTypes[]` + the `fileType` capability | shipped |
| Network mode in the printer profile, and the panels behind it | `network.mode` / `displayName` / `hostnames` | shipped |
| Material pane for its own output format | `materialSettings` (below) | shipped |
| Printer presets and material templates in the library | `printerPresets` / `materialTemplates` | shipped |
| Preset images | `payload/assets/` + a relative `imageAssetPath` | shipped (inlined as data URLs) |
| On-device (remote) material list and editor | `network.remoteMaterials` fields | shipped |
| A custom panel or overlay | needs the UI island | planned |

## Material pane schema

`materialSettings` carries the schema compiled plugins write in TypeScript
(`PluginLocalMaterialSettingsAdapterContract`): tabs, sections, cards and fields, or a
differential object (`$inherit` / `$remove` / `$update`) that starts from another
mode. The renderer validates it once, in
`src/features/plugins/declaredMaterialSettings.ts`, and then treats it exactly like
a compiled adapter — the same form renders both.

```json
"materialSettings": {
  "byOutput": {
    ".exf": {
      "displayName": "Echo settings",
      "tabs": [{ "id": "basic", "title": "Basic", "order": 10 }],
      "cards": [{ "id": "print", "title": "Print", "tabId": "basic" }],
      "fields": [
        { "key": "exposureSec", "label": "Exposure (s)", "kind": "number", "defaultValue": 2.5,
          "min": 0.1, "max": 30, "step": 0.1,
          "placement": { "tabId": "basic", "cardId": "print", "order": 10 } },
        { "key": "antialias", "label": "Anti-aliasing", "kind": "select", "defaultValue": "2",
          "options": [{ "value": "1", "label": "Off" }, { "value": "2", "label": "2x" }] }
      ]
    }
  },
  "byOutputAndMode": {
    ".exf": { "twostage": { "$inherit": "default", "fields": [] } }
  }
}
```

Rules:

- A compiled plugin owns its output format. A package fills a format nobody claims
  and may add settings modes inside it, never replace one.
- Field kinds are the renderer's own: `number`, `integer`, `text`, `boolean`,
  `select`, `spacer`. A field with an unknown kind, no `key`, or no scalar
  `defaultValue` is dropped rather than guessed at; a contract with no usable
  fields registers nothing.
- Labels and titles are plain strings in the manifest, so they are English. The
  app does not translate plugin-supplied text.
- Limits: 8 output formats, 8 modes per format, 512 fields, 128 KiB per contract.

## Why not remote JavaScript

The tier exists so a closed-source plugin stays a separate program
(`docs/adr/0047-sideloaded-complex-plugins.md`). Importing a vendor's React module
into the app's module graph — same process, same DOM, same globals — is the
combined-work case the ADR rejects. "Remote JS" in that shape is therefore not
possible for this tier at any price.

There is a defensible shape, and it is the plan below: a **sandboxed UI island**.
The bundle runs in its own frame, with its own origin, no access to the app's
objects, talking to the host over a message protocol — the same argument the
network tier already makes for its process, applied to a window.

## The UI island (planned)

Not implemented. Shipping it needs an ADR revision, because ADR-0047 currently
says UI contributions do not travel.

- The package declares `ui: { entry: "ui/index.html", panels: [...] }` and ships a
  self-contained bundle in its payload.
- The host serves it from a dedicated origin (not `tauri://`, not `http://tauri.localhost`)
  inside a sandboxed frame with no `allow-same-origin`, no top navigation, and no
  access to the app's `window`.
- All interaction is `postMessage`: the host offers a small typed API (read the
  active printer, the current job, material values; call a declared network
  operation; raise a notification), and the island renders whatever it likes with
  its own styles.
- Themed tokens are passed in as CSS variables at handshake, so a pane can match
  the app without sharing code.
- The island is not trusted with secrets: no filesystem, no Tauri IPC, no raw
  plugin process handles.

Until that exists, anything a vendor needs is integrated **in mainline** as a
declarative shape (the material pane is the first) or is out of scope for the
tier. Do not add a second private channel for one partner.

## Known gaps

- Monitoring policy (polling grace, webcam policy) is fixed by the generic adapter;
  a declared mode cannot tune it.
- The island: designed above, not built.
