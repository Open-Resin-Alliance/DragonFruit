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

## Auto-arrange height grouping

`src/features/scene/arrange/useArrangeManager.ts` keeps the Arrange panel's
settings in component-local state, not in a preferences module. Height grouping
is opt-in through `arrangeGroupByHeight`; `arrangeHeightToleranceMm` starts at
10 mm. Neither setting is persisted. `ArrangePanel` exposes Compact / By Height
for Auto layout; Manual arrays and Duplicate retain their existing layouts.

Both Standard and High-Precision arrange partition the run into tallest-first
height buckets before using their existing XY packers. Print height is the
highest world Z above the plate, including transformed supports, rather than
the mesh's untransformed height or its bounding-box extent. Rotation, scale and
lift therefore affect the grouping; arranging does not change Z.
High-Precision support hull points are localized with the model's stored world
transform, not its target plate-local transform: changing the active plate must
not inflate the support footprint.

The React-free helpers in `src/features/scene/arrange/heightBuckets.ts` are:

- `bucketModelsByHeight`: takes models, a print-height callback and a maximum
  height difference in millimetres. Heights and tolerance must be finite and
  nonnegative. It measures each model once, preserves the input array and
  same-height order, and returns buckets with models and minimum/maximum heights.
- `heightRangesFit`: checks whether an occupied plate's height range and an
  incoming bucket's combined range fit the tolerance. A null occupied range
  means an empty plate.

```ts
const groups = bucketModelsByHeight([19, 21, 45], height => height, 10);
// groups.map(group => group.models) is [[45], [21, 19]].
```

Each bucket is anchored to its tallest model; neighbouring heights cannot chain
into a bucket wider than the tolerance, and close heights across a multiple of
the tolerance are not artificially split. The boundary is inclusive; zero
tolerance groups only identical heights.

A run gives each plate to at most one bucket. Compatible occupied plates are
tried before empty plates; fixed objects remain blockers and contribute their
height range. Selected-only runs do not move unselected objects, and locked
plates/models are excluded. This Plate retains its existing scope and adds new
plates for overflow rather than touching other existing plates. Height grouping
may use more plates than Compact. The existing bed cap and oversized-object
fallback still apply. Plate creation/removal and placements use the same scene
snapshot history step, so undo/redo restore them together; see
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
