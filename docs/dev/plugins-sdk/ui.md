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
          "options": [{ "value": "1", "label": "Off" }, { "value": "2", "label": "2x" }] },
        { "key": "extraIni", "label": "Extra INI lines", "kind": "textfield", "defaultValue": "",
          "metadataPath": "vendor.extraIni",
          "placement": { "tabId": "basic", "cardId": "print", "order": 20 } }
      ]
    }
  },
  "byOutputAndMode": {
    ".exf": { "twostage": { "$inherit": "default", "fields": [] } }
  }
}
```

Rules:

- `replacesDefaultMaterialSettings: true` makes the pane *replace* the stock material
  form: its tabs become the editor's tabs, with `Meta` and `Anti-Aliasing` appended.
  Without it the pane is appended under the stock fields — which is why an example
  that forgot the flag looked like a box at the bottom of the dialog rather than a
  material editor of its own.
- A compiled plugin owns its output format. A package fills a format nobody claims
  and may add settings modes inside it, never replace one.
- Field kinds are the renderer's own: `number`, `integer`, `text`, `textfield`,
  `boolean`, `select`, `spacer`. A field with an unknown kind, no `key`, or no
  scalar `defaultValue` is dropped rather than guessed at; a contract with no
  usable fields registers nothing.
- `textfield` is the multi-line sibling of `text`. The form renders a resizable
  textarea and passes the string through unchanged, newlines included, at the
  field's `metadataPath`. Use it for a vendor block the host cannot model field by
  field: the plugin parses or appends it itself. A "Custom" tab is just a tab whose
  section holds one of these fields.
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

### Why an island is defensible where a module is not

The combined-work question is about how the two programs communicate, not about
whether they run on one machine. The FSF's plugin guidance treats a program that
forks and execs and talks over a pipe as separate, and treats sharing memory or
intimate data structures as the case that merges them. A vendor module imported
into our webview is the second case: our tree calls its functions and our objects
cross by reference. A sandboxed frame with only serialized messages is the first
case in the web's idiom — the host hands over values through a documented,
versioned interface, and nothing is shared. It is the same argument the process
tier already makes, applied to a window.

### The invariants that keep it separate

1. **Own origin.** Served from a dedicated origin, never the app's; no
   `allow-same-origin`, no cookies or storage shared with the host.
2. **No host objects.** Every message is JSON. No functions, DOM nodes, class
   instances or handles cross the boundary, in either direction. The host
   validates what arrives against the schema and ignores unknown fields.
3. **A narrow, versioned API.** Reads the data a pane legitimately needs (active
   printer, job progress, the material values already in the profile, the output
   format) and asks the *host* to act (run a declared network operation, raise a
   notification). Never "call this host function", never a dynamic import of host
   modules, never `eval` across the boundary.
4. **No ambient capability.** CSP `default-src 'self'`, `connect-src 'none'`; no
   Tauri IPC, no filesystem, no shell. Printer traffic stays the plugin process's
   job, through the operations it already declares.
5. **Independent failure.** A crashed or blank island leaves the app working, and
   the app never depends on a pane existing. That is what "separate program" means
   in the software, not just on the licence page.
6. **Vendor code stays out of our build.** The bundle is payload data, unpacked at
   install; our build never compiles, lints or type-checks it, and the island SDK we
   publish is Apache-2.0/MIT like the plugin SDK.

### What would break the argument

- Importing the bundle into the webview's module graph "just for the panel".
- Passing live objects or callbacks instead of JSON.
- Letting the island reach `window.__TAURI_INTERNALS__` or the app's origin.
- An API so broad that it is the app's internals under another name (for example
  "give me the scene" plus "run arbitrary commands").
- Making the app refuse to work without the island.

If a feature needs any of those, it belongs in mainline as a declarative shape
(the material pane and the remote material editor are the two precedents).

### Before code

ADR-0047 says UI contributions do not travel. Shipping the island starts with an
ADR revision that makes the six invariants normative and records the
interpretation above, so a later contributor cannot widen the bridge without
reopening the decision.

## Known gaps

- The island: designed above, not built; it needs the ADR revision first.
