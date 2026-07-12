# Support Settings API

This page documents the public API for reading and writing support settings
from anywhere in the app — including panels outside the support sidebar.
It uses tip penetration as the worked example because that is the setting
most likely to be surfaced in additional UI.

## Store architecture

Support settings live in a module-singleton store with a manual subscription
set: [`src/supports/Settings/state.ts`](https://github.com/Open-Resin-Alliance/DragonFruit/blob/main/src/supports/Settings/state.ts).
Import everything from the barrel `@/supports/Settings`.

- `getSettings()` — one-shot read of the whole `SupportSettings` object.
- `subscribeToSettings(listener)` — subscription for `useSyncExternalStore`.
- `updateTipProfile(partial)` — shallow-merge a partial patch into `settings.tip`.
- Settings persist automatically to `localStorage` under the key
  `support-settings` (see [Data Storage](data-storage.md)).

## Tip penetration ("embed depth")

The value that controls how deep every contact disk extends into the model:

- **Field:** `settings.tip.penetrationMm` (millimeters)
- **Default:** `DEFAULT_TIP_PENETRATION_MM = 0.1` (`src/supports/Settings/defaults.ts`)
- **Valid range:** `TIP_PENETRATION_MIN_MM` (0) to `TIP_PENETRATION_MAX_MM` (0.5)

### Read / write from any panel

```ts
import { getTipPenetrationMm, setTipPenetrationMm } from '@/supports/Settings';

const depth = getTipPenetrationMm();   // read current value (mm)
setTipPenetrationMm(0.25);             // write — clamped to the valid range
```

`setTipPenetrationMm` enforces the 0–0.5 mm clamp internally, so callers cannot
bypass it. Prefer these wrappers over raw `updateTipProfile` writes.

### Reactive read in a React component

```ts
import { useSyncExternalStore } from 'react';
import { subscribeToSettings, getSettings } from '@/supports/Settings';

const settings = useSyncExternalStore(subscribeToSettings, getSettings, getSettings);
const depth = settings.tip.penetrationMm;
```

### Raw write (no clamp — avoid unless you have a reason)

```ts
import { updateTipProfile } from '@/supports/Settings';
updateTipProfile({ penetrationMm: 0.25 });
```

## Behavior contracts you must know

1. **Global writes do not rebuild placed supports.** Changing the global
   setting affects future placements and any UI bound to the store. Supports
   already on the plate keep their own values. The support sidebar pushes the
   edited settings onto the currently selected supports via
   `applySettingsToSupportTarget(target, settings)` from `@/supports/state`;
   do the same if your panel should update the current selection.
2. **Each placed support carries its own settings snapshot.** Trunk, Branch,
   and Leaf entities persist a `settingsCodeHex` (binary codec:
   `src/supports/Settings/supportSettingsCodec.ts`). Penetration is encoded
   there at ×1000 scale as a positional u16 — changing the codec field order
   or scale requires a codec version bump; changing the default value does not.
3. **Presets overwrite the value when applied.** All built-in presets
   (`detail`, `structure`, `anchor`) inherit `DEFAULT_TIP_PENETRATION_MM`.
4. **Geometry is single-sourced.** All disk geometry (viewport detailed +
   instanced renderers, STL/3MF/VOXL export, and the slicer feed) derives from
   `getContactDiskGeometrySpec()` and `createContactDiskLoftGeometry()` in
   `src/supports/SupportPrimitives/ContactDisk/contactDiskUtils.ts`.
   Penetration extends the disk into the model only — the cone-side connection
   (tip center, socket, joints) never moves with this setting.

## Not a setting: the oval contact face

The oval contact-face shape (squish ratio + rotation) is **per-disc entity
data**, not a global setting — there is nothing in the settings store for it.
It lives as optional `contactFaceRatio` / `contactFaceAngleRad` fields on
`ContactCone` and `ContactDisk` entities, is edited via the gizmo-ring handle,
and is written through `commitContactFaceShape(contactId, ratio, angleRad)`
in `src/supports/SupportPrimitives/ContactDisk/contactFaceActions.ts` (which
resolves the owning support and records one undo entry). Do not add a global
default for it without revisiting that design.
