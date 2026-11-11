# State and Stores

DragonFruit has **no global state library** for app state — it uses two plain
patterns, both module-level with subscription APIs consumed through
`React.useSyncExternalStore`. The dominant pattern is the **module store**; the
settings sub-pattern is the **preferences module**. Zustand is reserved for a
handful of hot-path lookups (`hotkeyStore.ts`, `StepManager.ts`) where a
synchronous `getState()` is the point.

## Module store pattern

Shape (used by ~65 modules): module-level mutable state + a `subscribeX(listener)`
+ `getXSnapshot()` + `getXServerSnapshot()`.

```ts
let state: MyState = initial;

const listeners = new Set<() => void>();
export function subscribeMyStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getMyStoreSnapshot(): MyState { return state; }
export function getMyStoreServerSnapshot(): MyState { return initial; }

function setState(next: MyState) {
  state = next;
  listeners.forEach((l) => l());
}
```

Consumers read it reactively in components via `useSyncExternalStore`:

```ts
const state = React.useSyncExternalStore(subscribeMyStore, getMyStoreSnapshot, getMyStoreServerSnapshot);
```

Key rules:

- The **server snapshot** (`getXServerSnapshot`) must be a *stable reference*
  (usually the initial state constant), so server rendering and hydration are
  deterministic. The client snapshot may return a fresh reference each call, but
  the server one must not.
- Notify after every mutation that changes the snapshot. No `Object.assign` on
  the same reference — mutate the module variable then notify.
- For persisted stores, keep a `hydrate()` step (called at app root) and a
  `sanitize-on-read` step so corrupt persisted state can never crash consumers.

The canonical complex example is `src/features/profiles/profileStore.ts` (2861
lines): a `dragonfruit-profiles-v1` localStorage envelope with schema versioning,
backup/legacy keys, sanitize-on-read, `setState → sanitize → persist → notify`,
and active-material sidecar keys. Minimal examples: `printerReachabilityStore.ts`,
`src/volumeAnalysis/Islands/hoverStore.ts`.

One store splits its two channels on purpose.
`src/components/scene/SceneCanvas/supportPlacementGuideStore.ts` holds the
support placement guide plane, which follows the pointer continuously: it
notifies on the boolean "is the plane set" (that flips on enter and leave, and is
what `SceneCanvas` subscribes to in order to mount the overlay) and exposes the Z
itself through a plain getter, read every frame by the guide's material. A value
that moves every frame is not a snapshot — subscribing to it would re-render the
scene per pointer move, and throttling it is what made the line step on shallow
faces. Reach for this shape only when a consumer genuinely needs the live value
outside render.

## The support store

`src/supports/state.ts` is the largest module store here and departs from the
shape above in four ways:

- **Short names.** Plain `subscribe` / `getSnapshot` / `setSnapshot`. Importers
  alias it (`subscribe as subscribeSupportState`); check for an existing alias
  before adding an import.
- **No server snapshot.** Consumers pass `getSnapshot` twice or omit the third
  argument. Safe only because the support scene is client-only — do not copy
  into a store that renders on the server.
- **Batched notification.** `beginSupportStateBatch()` / `endSupportStateBatch()`
  bracket bulk edits so listeners fire once. Use them for any loop touching many
  entities.
- **Collections come from the registry.** Derive "every collection" from
  `SUPPORT_COLLECTION_KEYS`, `MODEL_ID_COLLECTION_KEYS` or
  `SHAFTED_COLLECTION_KEYS` rather than writing the names out. See
  [Support System](support-system.md).

Kickstands live on `SupportState` like every other type: read
`state.kickstands` directly. For the roots or knots one type owns, ask
`getOwnedPrimitives(typeId, collection)`, which reads that type's declared
edges rather than filtering by hand.

## The scene clip store

`src/features/slicing/sceneClipStore.ts` holds the cross-section clip
(`clipLower` / `clipUpper`) and is deliberately written from an event handler,
not an effect:

- `useSlicingManager` publishes the clip from `setLayerIndex` /
  `setLowerLayerIndex`, so a slider drag moves the cross-section without a React
  render. While the thumb is held the committed `layerIndex` is deferred to the
  release; `LayerSlider` keeps its own live value in state and draws that.
- `SceneCanvas` subscribes with `useSyncExternalStore` and threads the values to
  the models, the cap and the supports as before.
- `setSceneClipGate(open)` is the page's cross-section switch: closed publishes
  `null` / `null` whatever the slider says. `page.tsx` drives it from
  `isCrossSectionEnabled`, the thumbnail suppression and the workspace mode.

The plane array it exposes (`getSceneClipPlanes`) keeps its identity, so a
material that holds it sees new constants without being rebuilt.

## Preferences module pattern

Settings that persist to `localStorage` use a fixed contract, repeated in ~13
modules under `src/components/settings/*Preferences.ts`. Always copy the shape:

```ts
export const MY_SETTINGS_STORAGE_KEY = 'app-my-settings';
const MY_SETTINGS_EVENT = 'app-my-settings-changed';

export const DEFAULT_MY_SETTINGS = { … };

export function normalizeMySettings(input: unknown): MySettings { /* validate each field, fall back to defaults */ }
export function getSavedMySettings(): MySettings { /* localStorage read + module cache */ }
export function saveMySettings(settings: MySettings): void { /* setItem + dispatch CustomEvent(MY_SETTINGS_EVENT, { detail }) */ }
export function subscribeToMySettings(listener: () => void): () => void { /* 'storage' event + CustomEvent, returns unsubscribe */ }
```

- `getSaved*` caches the parsed value keyed on the raw string so repeat reads
  don't re-parse.
- `save*` writes then dispatches a `CustomEvent` so same-tab consumers update
  immediately; the `storage` event covers other tabs.
- `subscribeTo*` listens to both and returns an unsubscribe closure — this is
  what a Settings tab wires into a `useEffect`.
- Boolean flags use a simpler `getItem` string check (e.g. `raw !== 'false'`)
  with the same dispatch pattern.

The Experiments registry (`src/features/experiments/experimentsRegistry.ts`)
follows this pattern with a JSON-value envelope.

## Theme colors

`src/components/settings/themeCustomizations.ts` owns the theme palette.
`applyThemeCustomColors` writes it to the document as CSS variables, so DOM
styling needs no subscription. Consumers that cannot read CSS variables — the
3D viewport's mesh selection/hover tint — subscribe to the applied palette with
`subscribeToThemeMeshHighlightColors` / `getThemeMeshHighlightColors` and
`useSyncExternalStore`; `src/app/page.tsx` is the only reader and forwards the
colors to the canvas. Both are theme entries (`meshSelectionColor`,
`meshHoverColor`), edited from the UI & Theme tab's **Mesh Highlights** sub-tab
and from the Mesh tab's Selection & Hover section, which mirrors them rather
than holding an override.

## Auto-arrange print-height priority

`src/features/scene/arrange/useArrangeManager.ts` keeps the Arrange panel's
settings in component-local state, not in a preferences module. By Height is
opt-in through `arrangeGroupByHeight` and is not persisted. Compact remains the
default. Manual arrays and Duplicate retain their existing layouts.

The objective is **the sum of each printing plate's tallest Z**, not uniform
height ranges. Short parts can fill spare space on tall plates; there are no
height buckets, tolerance cutoff or dedicated plate per height group.

Both Standard and High-Precision compute the ordinary Compact plan first, then
a height-prioritized candidate with the same XY packing and collision rules.
The candidate packs tallest-first, trying existing tall plates first. It is
rejected if it needs more plates or leaves more models unplaced than Compact.
For equal fit rates, the lower sum of plate maxima wins; a tie prefers fewer
plates and otherwise keeps Compact. This is a bounded heuristic comparison,
not an exhaustive search for the globally optimal packing.

Print height uses world Z above the plate, including transformed supports,
rotation, scale and lift. Arrange does not change Z. Fixed objects contribute
to the maximum of their plate and remain collision blockers. Multiple free
rectangle passes on one plate contribute only one maximum. Selected-only runs
leave unselected models in place; locked plates/models are excluded from By
Height. This Plate keeps its existing scope. The bed cap and oversized-object
fallback still apply.

`src/features/scene/arrange/printTimeArrange.ts` exports `PrintTimePlan` and
`improvesPrintTimePlan`. A plan records its final plate count, unplaced count,
and passes containing model IDs. An existing plate ID coalesces passes; each
null plate ID represents a distinct new plate. Supply finite nonnegative print
heights for every model and the maximum fixed-object height of each occupied
plate. For example, among two-plate layouts with the same fit rate:

```ts
const heights = new Map([['tallA', 100], ['tallB', 90], ['shortA', 10], ['shortB', 5]]);
const candidate = {
  plateCount: 2, unplacedCount: 0,
  passes: [
    { plateId: null, modelIds: ['tallA', 'tallB'] },
    { plateId: null, modelIds: ['shortA', 'shortB'] },
  ],
};
const baseline = {
  plateCount: 2, unplacedCount: 0,
  passes: [
    { plateId: null, modelIds: ['tallA', 'shortA'] },
    { plateId: null, modelIds: ['tallB', 'shortB'] },
  ],
};
improvesPrintTimePlan(candidate, baseline, heights, new Map()); // true: 110 < 190
```

`HighPrecisionArrangeInput.printHeightByModelId` carries the optional height
metadata through the worker input/client. When present, height is the primary
model ordering key; reverse, interleaved and spill-first retries do not erase
that order. Same-order aggressive rescue remains available. Without metadata,
the packer's original ordering and retries remain unchanged. High-Precision
support hull points are localized with the model's stored world transform, not
its target plate-local transform: changing the active plate must not inflate
the support footprint.

Only the selected plan is committed. Plate creation/removal and placements use
the same scene snapshot history step, so undo/redo restore them together; see
[History and Undo/Redo](history-and-undo-redo.md).

## Which pattern to use

- **Transient cross-module state** (hover, reachability, selection) → module
  store + `useSyncExternalStore`.
- **Persisted settings** (camera feel, view 3D, autosave) → preferences module.
- **Persisted domain data with schema evolution** (profiles, plugins) → module
  store with a versioned localStorage envelope.
- **Hot-path synchronous lookups** (is a hotkey active right now) → zustand
  (`getState()`), not the module pattern.

## Related pages

- `dev/registration-seams.md`
- `dev/config-schemas.md`
