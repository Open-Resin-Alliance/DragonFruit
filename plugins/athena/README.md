# Athena Plugin

Built-in vendor plugin for Athena / Concepts3D NanoDLP workflows.

## What lives here

- `pluginManifest.ts`
  - built-in plugin manifest consumed by the plugin registry
  - carries Athena-owned printer presets and resolves plugin asset URLs
- `printers/concepts3d/printers.json`
  - Athena/Concepts3D printer preset pack
- `printers/concepts3d/assets/*`
  - preset thumbnail assets served via `/api/profile-assets/plugins/athena/...`
- `network/nanodlp.ts`
  - NanoDLP network parsing/heuristics shared by API routes
- `nanodlp/*`
  - NanoDLP edit semantics used by Profile Settings UI

## Runtime integration map

- Plugin registration:
  - `src/features/plugins/pluginRegistry.ts`
- Settings UI plugin management:
  - `src/components/settings/PluginsSettingsTab.tsx`
- NanoDLP network routes that use Athena helpers:
  - `src/app/api/network/nanodlp/connect/route.ts`
  - `src/app/api/network/nanodlp/discover/route.ts`
  - `src/app/api/network/nanodlp/materials/route.ts`
  - `src/app/api/network/nanodlp/materials/edit/route.ts`
- Profile asset serving (including plugin-owned assets):
  - `src/app/api/profile-assets/[...assetPath]/route.ts`

## Contributor notes

- Keep Athena-specific logic in this plugin rather than core profile modules.
- Prefer adding new NanoDLP behavior in small focused modules under `nanodlp/`.
- If adding new plugin-owned assets, ensure URLs normalize to `/api/profile-assets/plugins/athena/...`.

## Example call flow

This is a typical end-to-end path when a user edits an Athena NanoDLP material profile:

1. **Settings opens profile editor**

- `src/components/settings/ProfileSettingsModal.tsx` imports from
  `plugins/athena/nanodlp/*` (via `nanodlpProfilePlugin.ts`).

2. **Material metadata is converted to editable UI state**

- `resolveNanodlpEditDraftFromMeta(...)` builds the draft.
- `NANODLP_PRIMARY_EDIT_FIELDS` and `NANODLP_BASIC_SECTIONS` drive Basic tab.
- `isSensibleNanoDlpAdvancedField(...)` and section helpers drive Advanced tab.

3. **Dynamic Wait lock behavior is applied**

- `isNanoDlpDynamicWaitEnabled(...)` determines if Wait-Before fields are
  locked and shows the “Dynamic Wait active” chip.

4. **User saves edits**

- `denormalizeNanodlpEditDraftForBackend(...)` normalizes payload values.
- UI calls `/api/network/nanodlp/materials/edit`.

5. **API route uses Athena network helpers**

- Route uses `plugins/athena/network/nanodlp.ts` for host/port parsing and
  NanoDLP-specific request normalization.

6. **Runtime presets/assets remain plugin-owned**

- Built-in Athena presets come from `pluginManifest.ts`.
- Thumbnail assets are served from
  `/api/profile-assets/plugins/athena/printers/concepts3d/assets/...`.
