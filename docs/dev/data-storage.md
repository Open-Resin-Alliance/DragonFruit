# Data Storage

This page is the developer-facing source of truth for client-side persistence used by DragonFruit.

## Storage mediums used

- `localStorage`: primary persistent settings and feature state
- `sessionStorage`: transient/session fallback for selected slicing/profile settings
- IndexedDB: recent-file payload cache (`dragonfruit-recent-files`)

## Key conventions

- `app-*`: application UI/settings
- `dragonfruit-*` / `dragonfruit.*`: product/feature scoped data
- `lumenslicer:*`: legacy namespace retained for compatibility
- Unprefixed literals still exist (`autoLift`, `liftDistance`) and should be treated as legacy technical debt

## Support system keys

| Key                           | Medium       | Purpose                                                                  |
| ----------------------------- | ------------ | ------------------------------------------------------------------------ |
| `support-settings`            | localStorage | Core support-generation settings (tip/shaft/root/grid/auto-bracing/etc.) |
| `support-presets-v1`          | localStorage | Preset definitions + active preset metadata                              |
| `support-active-preset-id-v1` | localStorage | Legacy active preset key (redundant with `support-presets-v1`)           |
| `auto-support-presets-v1`     | localStorage | Auto-support policy presets (the `light`/`medium`/`heavy` built-ins and the user's own) |
| `auto-support-active-preset-id-v1` | localStorage | Active auto-support preset id; selecting one writes the block into `support-settings` |

`support-presets-v1` carries a `supportDefaultsVersion` field beside its payload:
the batch of code defaults the preset blob was written at. It is a wire field,
not a setting — see [Code defaults that move](#code-defaults-that-move).

### Support presets (`support-presets-v1`)

`src/supports/Settings/presets.ts` owns the store: `byId`, `allIds` and
`activePresetId`. Two facts about it are load-bearing, because both are user
arrangement that has to survive a reload:

- **`allIds` is the rail's order.** The list of unpinned presets renders in that
  order, so `movePresetBefore` is the reorder entry point and the loader restores
  the stored array rather than rebuilding it from `byId` (JSON key order is
  creation order, which silently discarded a reorder). Pinned order comes from
  the slot number, not from `allIds`.
- **A slot holds one preset.** `pinnedSlot` is 1-6, or `null` for unpinned.
  `null` is stored explicitly, not omitted: an absent key is a record from before
  slots existed, where the factory preset's own slot still applies, and treating
  the two the same brought an unpinned factory preset back on the next load. The
  loader also drops the second claimant of a slot it finds.

The rail's drag is pointer events (`onPointerDown` + `setPointerCapture` +
`elementFromPoint` hit testing), not HTML5 drag and drop. Tauri leaves
`dragDropEnabled` on because the window takes OS file drops, and on Windows that
makes the webview reject page-level drags outright: the cursor becomes the
no-drop one and no `dragstart` is delivered. See `PresetSelector.tsx`.

The same drag is the rail's delete gesture: released outside the Support Studio
panel (the element carrying `data-support-studio-panel`) it asks to delete the
dragged preset, or the whole selection when the dragged row is part of one. The
pointer turns into a trash can there, from the `body.preset-drag-delete` rule in
`src/app/globals.css`.

## Profiles and plugin keys

| Key                                              | Medium                        | Purpose                                            |
| ------------------------------------------------ | ----------------------------- | -------------------------------------------------- |
| `dragonfruit-profiles-v1`                        | localStorage                  | Primary profile envelope (printers/materials)      |
| `dragonfruit-profiles-v1-backup`                 | localStorage                  | Backup copy of profile envelope                    |
| `dragonfruit-profiles`                           | localStorage                  | Deprecated legacy profile key (fallback read path) |
| `dragonfruit.material.activeByPrinterProfile.v1` | localStorage + sessionStorage | Active material selection per printer profile      |
| `dragonfruit-plugins-v1`                         | localStorage                  | Installed plugin registry + trust/install metadata |

`MaterialProfile.antiAliasingSettings.supportTipShrinkPercent` lives inside the existing `dragonfruit-profiles-v1` material envelope, not a new key. `src/features/profiles/profileStore.ts` defaults missing values to `10` and clamps whole percentages to `0`–`90`; `src/components/settings/profileFormAtoms.tsx` exposes the full-width Support Adjustments card in Material → Anti-Aliasing even with Custom Settings and Override Auto off. To set 25% for an editable material:

```ts
updateMaterialProfile(customMaterial.id, {
  antiAliasingSettings: {
    ...customMaterial.antiAliasingSettings,
    supportTipShrinkPercent: 25,
  },
});
```

`src/features/slicing/components/SlicingPanel.tsx` merges material and session AA settings. `src/features/slicing/sliceExportOrchestrator.ts` applies shrink only for effective 3DAA (`Vertical2` or `3DAA`, AA level not `Off`) while `src/features/slicing/rasterLayerZipExport.ts` assembles transient support triangles. It narrows contact-cone faces and twig disk footprints, including when AA on supports is disabled; it does not change support state, viewport geometry, projected cross sections, or STL/3MF/VOXL mesh exports. A session AA override can temporarily supply a different percentage without modifying the material.

Support Adjustments remain available under Auto AA presets (including Balanced and Smooth): `src/features/slicing/components/SlicingPanel.tsx` uses the material/session `aaOnSupports` setting even without Override Auto. Tip Compensation Offset Mode is shown as a disabled Automatic selector while Override Auto is off; `src/features/slicing/resolveEffectiveAaSettings.ts` then computes the Auto offset regardless of a stored Disabled or Manual choice. Turning Override Auto back on restores that saved choice, with Compensation Distance (mm) editable only in Manual mode. No existing profile data is migrated, and the other custom AA controls remain gated.

## Slicing and printing keys

| Key                                                 | Medium                        | Purpose                                                                |
| --------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------- |
| `dragonfruit.slicing.aaLevel`                       | localStorage + sessionStorage | AA level selection                                                     |
| `dragonfruit.slicing.minimumAaAlphaPercent`         | localStorage + sessionStorage | Minimum AA alpha threshold                                             |
| `dragonfruit.slicing.minimumAaAlphaOverrideEnabled` | localStorage + sessionStorage | Enable AA alpha override                                               |
| `dragonfruit.slicing.remoteOfflineLayerHeightMm`    | localStorage + sessionStorage | Offline/remote slicing layer height override                           |
| `dragonfruit.slicing.intentByPrinterProfile.v1`     | localStorage + sessionStorage | Preferred action intent by profile (`file`/`upload`/`print`/`preview`) |
| `dragonfruit.slicing.thumbnailRenderOptions`        | localStorage                  | Export-thumbnail rendering options                                     |
| `app-slicing-performance-settings`                  | localStorage                  | Slicing performance settings                                           |

## Scene and import keys

| Key                                      | Medium       | Purpose                                                 |
| ---------------------------------------- | ------------ | ------------------------------------------------------- |
| `app-recent-opened-files`                | localStorage | Recent files index (metadata only)                      |
| `mesh-appearance-settings`               | localStorage | Shader, mesh color, and tint-strength preferences       |
| `import-defaults-v1`                     | localStorage | Default import behavior (raft mode, wall/root defaults) |
| `dragonfruit-scene-autosave:settings-v1` | localStorage | Scene autosave enable, debounce, cooldown, cap and recovery prompt settings |

Autosave timing is stored in milliseconds: `debounceMs` defaults to `45_000` (45 seconds), `cooldownMs` to `180_000` (180 seconds; allowed `15_000`–`900_000`), and the maximum interval `capMs` to `300_000` (5 minutes). The settings UI displays debounce and cooldown in seconds and cap in minutes. After a save attempt, automatic requests wait until the cooldown expires; explicit flushes do not. Existing saved values remain in effect; a missing cooldown gets the new default, and `capMs` is normalized to at least the debounce and cooldown durations.

## UI/theme/layout keys

| Key                                    | Medium       | Purpose                                                   |
| -------------------------------------- | ------------ | --------------------------------------------------------- |
| `app-theme-preference`                 | localStorage | Theme mode preference                                     |
| `app-theme-colors`                     | localStorage | Active theme color overrides (incl. mesh selection/hover) |
| `app-theme-preset`                     | localStorage | Selected theme preset                                     |
| `app-theme-custom-profiles`            | localStorage | User custom theme profiles                                |
| `lumenslicer:floating-panel-layout:v5` | localStorage | Floating panel coordinates/sizing (moved panels only)   |
| `app-floating-layout-persistence`      | localStorage | Enable/disable floating layout persistence                |
| `app-models-panel-visible`             | localStorage | Model list visibility (shown unless hidden)               |
| `app-tool-layout`                      | localStorage | Tool entries as a left column or a bar under the app bar  |

## Camera and view keys

| Key                                  | Medium       | Purpose                             |
| ------------------------------------ | ------------ | ----------------------------------- |
| `app-3d-view-settings`               | localStorage | Build volume/view configuration     |
| `workspace-camera-settings`          | localStorage | Workspace camera state              |
| `camera-projection-settings`         | localStorage | Perspective/orthographic preference |
| `camera-feel-settings`               | localStorage | Camera interaction feel settings    |
| `camera-trackpad-settings`           | localStorage | Trackpad navigation preferences     |
| `lumenslicer:spacemouse:settings:v1` | localStorage | SpaceMouse settings                 |

## Controls and transform keys

| Key                                 | Medium       | Purpose                  |
| ----------------------------------- | ------------ | ------------------------ |
| `app-hotkeys-config`                | localStorage | User hotkey overrides    |
| `autoLift`                          | localStorage | Auto-lift enable flag    |
| `liftDistance`                      | localStorage | Auto-lift distance in mm |

## Diagnostics and debug keys

| Key                                         | Medium       | Purpose                                                   |
| ------------------------------------------- | ------------ | --------------------------------------------------------- |
| `dragonfruit.renderer-crash-diagnostics.v1` | localStorage | Renderer crash diagnostics history                        |
| `df:cross-section-cap-debug:v4`             | localStorage | Cross-section cap debug state                             |
| `dragonfruit.lysImportWarningDismissed`     | localStorage | LYS warning dismissal flag (plugin-defined fallback path) |

## Backup and sync keys

### GitHub backup settings

| Key                                     | Medium       | Purpose                                   |
| --------------------------------------- | ------------ | ----------------------------------------- |
| `dragonfruit-backups:auto-sync-enabled` | localStorage | Enable GitHub auto-sync                   |
| `dragonfruit-backups:auto-sync-minutes` | localStorage | GitHub auto-sync interval                 |
| `dragonfruit-backups:client-id`         | localStorage | Client identity for snapshot coordination |
| `dragonfruit-backups:last-sync-at`      | localStorage | Last successful sync timestamp            |

### Local (filesystem) backup settings

| Key                                           | Medium       | Purpose                         |
| --------------------------------------------- | ------------ | ------------------------------- |
| `dragonfruit-local-backups:auto-sync-enabled` | localStorage | Enable local auto-sync          |
| `dragonfruit-local-backups:auto-sync-minutes` | localStorage | Local auto-sync interval        |
| `dragonfruit-local-backups:client-id`         | localStorage | Local backup client identity    |
| `dragonfruit-local-backups:last-sync-at`      | localStorage | Last local sync timestamp       |
| `dragonfruit-local-backups:directory`         | localStorage | Selected local backup directory |

!!! note
      Backup auth/session state uses secure cookies and server-side endpoints in addition to client-side setting keys.

## IndexedDB contract

- **Database**: `dragonfruit-recent-files`
- **Version**: `1`
- **Store**: `files` (key path: `id`)
- **Use**: caches recent file payload binaries, while `app-recent-opened-files` stores lightweight metadata/index entries.

## Migration and compatibility notes

- `dragonfruit-profiles` is deprecated; `dragonfruit-profiles-v1` is canonical.
- `support-active-preset-id-v1` is legacy/redundant; active preset is also tracked in `support-presets-v1`.
- `lumenslicer:*` keys remain for compatibility and should not be removed without explicit migration handling.

### Code defaults that move

The `autoSupport` block is persisted whole, so every key an install ever wrote
carries a value, and loading is `{ ...codeDefaults, ...stored }`. A stored value
therefore wins forever: change a default in code and an install that has ever
saved keeps the old one. Two installs then disagree about a "default" while both
are doing what the code told them to, which is indistinguishable from a stale
profile.

`src/supports/Settings/defaultMigrations.ts` fixes that for **the auto-support
block of a shipped profile, and nothing else**, applying one entry per shipped
auto-support default change against the batch the blob was written at.

- **The rule.** A stored key equal to `from` is a value this app shipped, so it
  moves to `to`. Any other value is a design decision and is left alone. It is
  the same rule the preset loader already applied by hand for a whole block
  (`migrateLegacyPresetAutoSupport` in `src/supports/Settings/presets.ts`),
  generalized to single keys so the next auto-support default change needs no new
  one-off. Inside a factory preset, a key the preset **states itself** (its own
  density: detail 16, anchor 5) is a design decision and is never moved, even when
  its value happens to equal an old default; the keys it inherits follow the
  table. `designedAutoSupportKeysOf` in `src/supports/Settings/presets.ts`
  derives that split by comparing each preset's definition against the code
  defaults, so it stays true when a preset changes.
- **What it never reaches.** The live `support-settings` block is the user's own
  configuration, and the same inference is wrong there: a user who deliberately
  picks a value that happens to equal a retired default is not "untouched".
  Rewriting it on load silently discards the choice — the replacement lands
  before the save button is reachable, so **the Support Studio cannot keep such a
  setting at all**, and the studio looks like it resets itself to defaults on
  every restart. The same holds for the studio's own sections (`autoBracing`,
  tip, shaft, roots, grid): a default moving there is a change its owner has to
  land deliberately. Presets the user made, or saved their settings into, are
  theirs for the same reason. `support-settings` therefore carries no
  `supportDefaultsVersion`; the field is only stripped on load, because an
  install that ran the over-reaching build left one behind and `mergeWithDefaults`
  spreads what it loads.
- **The one assumption.** Deliberately setting a key back to the old default is
  indistinguishable from never having touched it, and reads as untouched. That is
  the price of a whole-block format; if it ever matters for a key, that key needs
  its own record rather than a `from`/`to` entry.
- **Adding an entry.** Bump the batch (`version`), add `{ key, from, to }`, and
  list every older default the key may hold: an install can be pinned at any of
  them, so a key that moved twice needs an entry per step. `key` is checked
  against `AutoSupportSettings`, so a renamed key fails the build instead of
  silently migrating nothing. An entry for a non-`autoSupport` section is not
  expressible — that is the point of the scope.
- **What keeps the table honest.**
  `src/supports/__tests__/supportDefaultsMigration.test.ts` fails when an entry's
  `to` no longer equals the value the code ships, when `from` and `to` are equal,
  or when a batch is out of range. It also pins both load paths: a factory
  preset's inherited auto-support keys follow the table while its stated keys and
  its bracing do not, a user preset is untouched, and a saved studio block loads
  exactly as written.
- **Not a migration.** Removing a key needs none: `normalize*Settings` drops
  unknown keys, and their values are gone either way. Renaming a key is a
  migration in the key's own shape, not a default move: `sizingPreset` went from a
  numeric tier to a preset id and is handled by `migrateLegacySizingPreset`.

## Engineering expectations

When adding or modifying persisted state:

1. Prefer namespaced keys (`app-*`, `dragonfruit-*`).
2. Document schema and defaults in this file in the same PR.
3. Provide backward compatibility/migration behavior for renamed keys.
4. Keep secrets out of storage keys (use env/server-side secrets/cookies).
