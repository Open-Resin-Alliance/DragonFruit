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
