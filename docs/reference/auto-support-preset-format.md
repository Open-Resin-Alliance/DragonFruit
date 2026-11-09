# Auto-Support Preset Format

An auto-support preset file holds one named set of automatic support settings —
the run policy a Generate Supports pass follows: support density, self-support
angle, merge radius, fan limits and the sizing tier every shaft, tip and root is
built from. Exporting a preset writes
one of these files; importing one adds the preset to your list and selects it.

Files are plain JSON and safe to read, edit or hand to someone else.

## The document

```json
{
  "kind": "dragonfruit-auto-support-preset",
  "formatVersion": 1,
  "exportedAt": "2026-06-01T09:30:00.000Z",
  "preset": {
    "name": "Heavy 0.05",
    "settings": {
      "areaPerSupportMm2": 5,
      "overhangSelfSupportAngleDeg": 45,
      "sizingPreset": "anchor"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `kind` | Always `dragonfruit-auto-support-preset`. Identifies the file type |
| `formatVersion` | The shape of the file. Currently `1` |
| `exportedAt` | When the file was written, as an ISO timestamp. Informational — it is not read back |
| `preset.name` | The preset's name. Required and not empty |
| `preset.settings` | The auto-support settings, as a JSON object |

Only the fields shown are written. Nothing about the model is: a preset is a
policy, not geometry.

## The version rule

`kind` and `formatVersion` must match what the app knows **exactly**. There is no
migration and no guessing: a file with another `kind`, or with a `formatVersion`
other than `1`, is refused, and the app shows the reason.

Files from **older or newer** versions of DragonFruit are therefore refused
rather than half-read — a preset that silently becomes the wrong policy would run
the printer with settings nobody chose. If a future version adds a format, it
will convert old files at import time.

## Settings a given build does not know

Any key inside `preset.settings` is kept exactly as written, including keys this
version of the app does not use. Exporting that preset again writes them back, so
a preset shared between versions is not damaged by passing through an older
build. Keys this build cannot name are simply not applied to the run.

## On import

- The name is made unique if it is already taken (`Heavy` becomes `Heavy (2)`), so
  an import never silently overwrites a preset.
- The imported preset is selected and applied: it is what the next Generate
  Supports run uses.
- Built-in presets — `light`, `medium`, `heavy` — cannot be renamed, deleted or
  imported over; an import of a file named after one gets its own new name.
- A file that fails any check above adds nothing.
- A file from the band-as-data build — one whose block carries a `sizingBand`
  object instead of the tier id — is migrated: the seven numbers map back to the
  factory preset whose band they match (`structure` when they match none), the
  obsolete key is dropped, and nothing else about the block changes.

## Not the Support Studio presets

Support Studio's own presets (the Detail / Structure / Anchor cards, with their
pinning, and their own export) describe the geometry of **manually placed**
supports and are a separate system: separate storage, separate ids, separate
files. An auto-support preset carries only the automatic run's settings, and a
Support Studio preset never carries auto-support settings.
