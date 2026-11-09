# Auto-Support Presets

A preset is a named `autoSupport` settings block: the run policy an automatic
support pass follows — support density, overhang self-support angle, merge
radius, fan limits, the sizing band. Picking a preset applies the whole block;
the collection, the active selection and the preset file format are owned by
`src/supports/Settings/autoSupportPresets.ts`, and the built-ins' translated
names by `src/supports/Settings/autoSupportPresetMessages.ts`.

This is what the Auto Support panel's light/medium/heavy quick-select becomes: a
list the user can extend, rename, duplicate and share as a file.

## Separate from the Support Studio presets

These are **two systems**, and neither store knows the other exists:

| | Support Studio presets | Auto-support presets |
| --- | --- | --- |
| File | `src/supports/Settings/presets.ts` | `src/supports/Settings/autoSupportPresets.ts` |
| Answers | how a *manually placed* support is built | how an automatic run is policed |
| Payload | tip / shaft / roots / base-flare geometry, and `autoSupport` is excluded from what they save | the `autoSupport` block and nothing else |
| Storage | `support-presets-v1` | `auto-support-presets-v1` |
| UX | pinned slots, hotkeys, reordering, one selection driving the whole settings panel | pick per run, save / revert, import / export |

They have no shared storage, state, ids or functions. Support Studio's presets
keep excluding `autoSupport`, and an auto-support preset carries no geometry: its
`sizingPreset` is the id of the Support Studio preset the run borrows its tip,
shaft and roots from, resolved at run time. That one read is the coupling the user
chose — see [backlog.md](backlog.md) for the decision and its cost. A payload
written by the band-as-data build carries a `sizingBand` object instead; the store
runs `migrateLegacySizingPreset` (from `src/supports/autoSupport/settings.ts`) over
a payload as it adopts it and over an imported file, so the band maps back to the
factory preset it matches (else `structure`) and the obsolete key is dropped.

## Public surface

| Function | Does |
| --- | --- |
| `getAutoSupportPresets()` | the collection: built-ins first, then the user's presets. One array per state, so a selection change hands React a new reference too |
| `getAutoSupportPreset(id)` | one preset, or `undefined` |
| `getActiveAutoSupportPresetId()` | the selected preset id, or `null` |
| `setActiveAutoSupportPreset(id)` | selects a preset and applies its block; `null` clears the selection without touching the settings |
| `createAutoSupportPreset(name)` | captures the live `autoSupport` block as a new preset and selects it |
| `saveAutoSupportPreset(id)` | writes the live block into a preset — the UI's Save |
| `renameAutoSupportPreset(id, name)` | renames a user preset, returning the name actually applied; `null` for a built-in or unknown id |
| `duplicateAutoSupportPreset(id)` | copies a preset (built-ins included) under a new name, without selecting it |
| `deleteAutoSupportPreset(id)` | deletes a user preset; a built-in is refused |
| `restoreAutoSupportFactoryDefaults()` | puts the built-ins back to their factory settings, leaving the user's presets and the live settings alone |
| `resetToActivePreset()` | re-applies the active preset over the live settings — the UI's Revert |
| `isAutoSupportPresetDirty()` | whether the live block still matches the active preset |
| `exportAutoSupportPresetToJson(id)` | the preset as a JSON document |
| `importAutoSupportPresetFromJson(text)` | validates a document and adds it, selecting and applying it |
| `translateAutoSupportPresetName(preset, translate)` | the display name: translated by id for a built-in, stored name otherwise |
| `subscribeToAutoSupportPresets(listener)` | subscription for React |
| `getAutoSupportPresetsSnapshot()` | client snapshot for `useSyncExternalStore` |
| `getAutoSupportPresetsServerSnapshot()` | server snapshot for `useSyncExternalStore`: a stable built-ins-only list |

Also exported: `AutoSupportPreset`, `AutoSupportPresetSettings`,
`AutoSupportPresetDocument`, `AUTO_SUPPORT_PRESETS_STORAGE_KEY`,
`AUTO_SUPPORT_ACTIVE_PRESET_ID_STORAGE_KEY`,
`AUTO_SUPPORT_PRESET_DOCUMENT_KIND` and `AUTO_SUPPORT_PRESET_FORMAT_VERSION`.

Nothing here reads or writes geometry. A preset's settings object is
`AutoSupportSettings` plus whatever other keys the file carried, so a preset
written by a newer build round-trips through this one unchanged.

## Built-ins

`light`, `medium` and `heavy`, whose settings are the Auto Support panel's tier
values — the same blocks the Support Studio preset store gives to Detail, Structure and
Anchor. Reusing those ids and values is what keeps existing users' settings where
they are.

Built-ins are defined in code and treated as the reserved tier:

- a stored record for a built-in id may carry the user's saved edits, never its
  identity or name — the factory record is the base on every load;
- they cannot be renamed (their title is translated by id at render, so a stored
  rename could never be displayed) or deleted (the panel's tier row and the file
  format are defined in terms of those ids);
- they *can* be saved over — that is how a user keeps a tweaked tier — and
  `restoreAutoSupportFactoryDefaults()` is the way back.

## Storage and reload

| Key | Holds |
| --- | --- |
| `auto-support-presets-v1` | the collection: `{ byId, allIds }` |
| `auto-support-active-preset-id-v1` | the active preset id |

The active id is deliberately **not** duplicated inside the collection key: one
fact, one home, so the two cannot disagree. Both keys are written on every
change that touches them.

The collection is read **once, at module load**, and repaired there rather than
guarded at every read:

- unknown ids (never written, or from a build that no longer knows them) are dropped
- duplicate ids collapse to their first occurrence
- a record whose id is missing from the order is appended, so a preset cannot be lost
- a record whose settings are unusable keeps its name and gets the default block
- an active id that names nothing becomes no selection

No preset is active until the user picks one. Inferring a selection from the live
settings — as the Support Studio preset store does — would put a preset's name on settings
the user never tied to it, and the first knob edit would then read as a rewrite
of that preset.

## Active preset and the dirty state

Selecting a preset applies its block through the settings store, so the applied
values are the preset's and no stale keys survive from the previous one.

Editing a knob afterwards does **not** rewrite the preset and does **not** detach
it. `isAutoSupportPresetDirty()` turns true and the UI offers Save
(`saveAutoSupportPreset`) or Revert (`resetToActivePreset`). The alternatives were
worse: silently rewriting the preset destroys the reference point the user
reverts to, and silently clearing the selection loses the fact that they started
from one.

Only the keys the live settings block can hold take part in that comparison, so
a preset carrying a knob this build does not know never reads as permanently
edited.

## Preset files

Export writes one JSON document, described for users in
[Auto-Support Preset Format](../reference/auto-support-preset-format.md):

```json
{
  "kind": "dragonfruit-auto-support-preset",
  "formatVersion": 1,
  "exportedAt": "2026-01-01T00:00:00.000Z",
  "preset": { "name": "Heavy 0.05", "settings": { "areaPerSupportMm2": 5 } }
}
```

`kind` and `formatVersion` are matched exactly — an unknown one is a hard reject
with no migration attempt, the same rule the theme-profile importer follows. Each
rejection throws an `Error` whose message is meant to be shown as-is:

| Message | Cause |
| --- | --- |
| `Invalid auto-support preset file: not valid JSON.` | the text does not parse |
| `Invalid auto-support preset file: expected a JSON object.` | it parses, but is not an object |
| `Invalid auto-support preset file: unsupported kind.` | wrong or missing `kind` |
| `Invalid auto-support preset file: unsupported format version <value>.` | wrong or missing `formatVersion` |
| `Invalid auto-support preset file: missing preset.` | no `preset` object |
| `Invalid auto-support preset file: missing preset name.` | empty or absent `preset.name` |
| `Invalid auto-support preset file: settings must be an object.` | `preset.settings` is not an object |

An import that passes is added under a de-duplicated name, selected, and applied;
a rejected one adds nothing.

## Usage

```tsx
import { useSyncExternalStore } from 'react';
import {
  getActiveAutoSupportPresetId,
  getAutoSupportPresets,
  getAutoSupportPresetsServerSnapshot,
  getAutoSupportPresetsSnapshot,
  isAutoSupportPresetDirty,
  setActiveAutoSupportPreset,
  subscribeToAutoSupportPresets,
} from '@/supports/Settings/autoSupportPresets';

function usePresets() {
  useSyncExternalStore(
    subscribeToAutoSupportPresets,
    getAutoSupportPresetsSnapshot,
    getAutoSupportPresetsServerSnapshot,
  );
  return {
    presets: getAutoSupportPresets(),
    activeId: getActiveAutoSupportPresetId(),
    dirty: isAutoSupportPresetDirty(),
  };
}
```

The dirty flag follows the settings store as well, so a component that shows it
should also subscribe to `subscribeToSettings` from `src/supports/Settings/state.ts`.

```ts
setActiveAutoSupportPreset('light');   // apply the light policy
updateAutoSupportSettings({ areaPerSupportMm2: 12 });   // user edits a knob
isAutoSupportPresetDirty();            // true — the preset is untouched
saveAutoSupportPreset('light');        // keep the edit, or:
resetToActivePreset();                 // discard it
```

## Tests

`src/supports/__tests__/autoSupportPresets.test.ts` covers CRUD, the load repair
pass, the storage round trip, the dirty/save/revert cycle, import/export, every
rejection message and built-in integrity against the Support Studio preset table
plus the settings-key forward compatibility the format promises.

The test file loads the store through `require` with the require cache entry
deleted first: the module reads storage exactly once, at load, so a fresh
instance is the only way to exercise that path.
