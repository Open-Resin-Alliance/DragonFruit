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

`MaterialProfile.antiAliasingSettings.supportTipShrinkPercent` lives inside the existing `dragonfruit-profiles-v1` material envelope, not a new key. `src/features/profiles/profileStore.ts` defaults missing values to `10` and clamps whole percentages to `0`–`90`; `src/components/settings/profileFormAtoms.tsx` exposes the entire Support Adjustments card in Material → Anti-Aliasing even with Custom Settings and Override Auto off. To set 25% for an editable material:

```ts
updateMaterialProfile(customMaterial.id, {
  antiAliasingSettings: {
    ...customMaterial.antiAliasingSettings,
    supportTipShrinkPercent: 25,
  },
});
```

`src/features/slicing/components/SlicingPanel.tsx` merges material and session AA settings. `src/features/slicing/sliceExportOrchestrator.ts` applies shrink only for effective 3DAA (`Vertical2` or `3DAA`, AA level not `Off`) while `src/features/slicing/rasterLayerZipExport.ts` assembles transient support triangles. It narrows contact-cone faces and twig disk footprints, including when AA on supports is disabled; it does not change support state, viewport geometry, projected cross sections, or STL/3MF/VOXL mesh exports. A session AA override can temporarily supply a different percentage without modifying the material.

Support Adjustments are independent of the Auto AA preset (including Balanced and Smooth): `src/features/slicing/components/SlicingPanel.tsx` uses the material/session `aaOnSupports` setting even without Override Auto. Newly created material profiles default `tipOffsetMode` to `auto`; saved explicit `disabled` and `manual` modes remain unchanged. Changing support settings does not turn on the other custom AA controls.

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
| `mesh-appearance-settings`               | localStorage | Shader, color, and mesh appearance preferences          |
| `import-defaults-v1`                     | localStorage | Default import behavior (raft mode, wall/root defaults) |
| `dragonfruit-scene-autosave:settings-v1` | localStorage | Scene autosave settings                                 |

## UI/theme/layout keys

| Key                                    | Medium       | Purpose                                    |
| -------------------------------------- | ------------ | ------------------------------------------ |
| `app-theme-preference`                 | localStorage | Theme mode preference                      |
| `app-theme-colors`                     | localStorage | Active theme color overrides               |
| `app-theme-preset`                     | localStorage | Selected theme preset                      |
| `app-theme-custom-profiles`            | localStorage | User custom theme profiles                 |
| `lumenslicer:floating-panel-layout:v4` | localStorage | Floating panel coordinates/sizing          |
| `app-floating-layout-persistence`      | localStorage | Enable/disable floating layout persistence |
| `app-debug-primitives-panel-visible`   | localStorage | Debug panel visibility (non-user-critical) |

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

## Engineering expectations

When adding or modifying persisted state:

1. Prefer namespaced keys (`app-*`, `dragonfruit-*`).
2. Document schema and defaults in this file in the same PR.
3. Provide backward compatibility/migration behavior for renamed keys.
4. Keep secrets out of storage keys (use env/server-side secrets/cookies).
