# History and Undo/Redo

DragonFruit has a single, app-wide undo/redo history. Every editable domain
(supports, mesh smoothing, scene composition) registers actions against it and
pushes state through it. There is one history stack per session; Ctrl+Z / Ctrl+Shift+Z
drive it.

This page is the formal version of the guidance in `AGENTS.md` ("Undo/redo —
history handlers"). Read the invariants in **Constraints** before writing any
history code.

## Architecture

Three layers:

1. **Untyped core store** — `src/history/historyStore.ts`. Module-level singleton
   (`undoStack`, `redoStack`, `handlerMap`) with plain-string action types. No React.
2. **Typed façade** — `src/history/typedHistory.ts`. Binds an action type to its
   payload type via a generic map, so a push can't drift from the handler that
   inverts it.
3. **Domain modules** — e.g. `src/supports/history/`, `src/features/mesh-smoothing/history/`,
   the scene snapshot registry in `src/features/scene/useSceneCollectionManager.ts`.

Types live in `src/history/types.ts`:

```ts
export type HistoryDirection = 'undo' | 'redo';

export interface HistoryAction<Type extends string = string, Payload = unknown> {
  type: Type;
  description?: string;      // human-readable, shown in the undo/redo toast
  payload: Payload;          // serialized state needed to invert the action
  origin?: HistoryOrigin;    // stamped by pushHistory, not by the domain
}

export type HistoryHandler = (action: HistoryAction, direction: HistoryDirection) => boolean | void;
```

`origin` (`{ appMode, transformMode }`) is stamped centrally from an app-installed
provider so an undo can restore the tool the edit was made in.

## Using the typed façade (per domain)

Never call `pushHistory` / `registerHistoryHandler` directly — always go through
`createTypedHistory<Map>()`. The map binds each action type constant to its
payload type.

```ts
// actionTypes.ts
export const DO_THING = 'dom:do-thing' as const;
export type DoThingPayload = { before: Foo; after: Foo };
export type DomainHistoryPayloadMap = { [DO_THING]: DoThingPayload };

// history.ts
const history = createTypedHistory<DomainHistoryPayloadMap>();
export const pushDomainHistory = history.push;
export const registerDomainHistoryHandler = history.register;

// handlers.ts — register at app-root lifetime
export function registerDomainHistoryHandlers(): () => void {
  const unreg = registerDomainHistoryHandler(DO_THING, (payload, direction) => {
    if (!payload?.before || !payload?.after) return false;   // decline = discard
    if (direction === 'undo') apply(payload.before); else apply(payload.after);
    return true;
  });
  return unreg;
}
export function useDomainHistoryHandlers() {
  useEffect(() => registerDomainHistoryHandlers(), []);
}

// push site
pushDomainHistory({ type: DO_THING, description: 'Do thing', payload: { before, after } });
```

The `createTypedHistory` API is exactly `push` and `register`. Clearing and
subscribing go directly on the store: `clearHistory()`, `subscribeHistory`,
`subscribeHistoryOperations`, `subscribeHistoryDebug`.

Payloads are `structuredClone`d on every push and every stack hop, so typed
arrays (`Float32Array`, `Uint32Array`) survive and callers may mutate after
pushing.

## Dispatch semantics

When `undo()` / `redo()` pops an entry, dispatch runs every registered handler
for the action type and resolves to one of three outcomes:

| Handler situation                          | Result      | Store behavior                                                  |
| ------------------------------------------ | ----------- | --------------------------------------------------------------- |
| Handler returns `true` (or nothing)        | `applied`   | Entry moves to the opposite stack; `subscribeHistoryOperations` fires |
| Handler returns `false`                    | `declined`  | Entry **discarded** — the state needed is gone and stays gone   |
| No handler registered for the type         | `no-handler`| Entry **pushed back onto the same stack** to replay later       |

A `false` return is stable across retries, so the entry is discarded rather than
kept — keeping it would pin the top of the stack and block every entry beneath
it. A missing handler keeps the entry so it replays once a handler registers;
this is the **stranded-stack hazard** (see below).

## Constraints

1. **Push and register through the typed façade**, never raw
   `pushHistory` / `registerHistoryHandler`.
2. **Register at app-root / always-mounted lifetime**, never gated on a render
   component. Handlers gated on a mesh being on screen make Ctrl+Z stop working
   depending on the render tree — silently. Supports register via
   `useSupportHistoryHandlers()` at the app root (`src/app/page.tsx`); scene and
   mesh-smoothing register in always-mounted hooks.
3. **Everything pushed to the stack needs a handler** — even a marker with no
   undo behavior needs a pass-through (`() => true`). An unhandled entry strands
   the stack: `undo()` pops it, finds no handler, and pushes it back forever.
   Example: `SCENE_SLICED` (a post-slice marker) is registered as a pass-through
   in `useSceneCollectionManager.ts`.
4. **A new push clears the redo stack.**
5. **`origin` is stamped centrally** by `setHistoryOriginProvider`, not by
   domains. `subscribeHistoryOperations` drives tool restore + toast.

## Payload shapes

### Live scene transform batches

`useSceneCollectionManager` normally pushes one scene snapshot whenever
`updateModelTransforms` runs. Controls that emit multiple live updates during a
single gesture may pass `{ pushHistory: false }`, capture the original model and
support transforms before the first update, and call
`commitModelTransformsHistory` once when the gesture ends.

```ts
const beforeTransforms = scene.models.map(({ id, transform }) => ({
  id,
  transform: {
    position: transform.position.clone(),
    rotation: transform.rotation.clone(),
    scale: transform.scale.clone(),
  },
}));
const supportBefore = captureTransformSupportSnapshot();

scene.updateModelTransforms(liveUpdates, { pushHistory: false });

const supportAfter = captureTransformSupportSnapshot();
scene.commitModelTransformsHistory(beforeTransforms, 'Move Selected Models', {
  includeSupportState: true,
  supportBefore: supportBefore.support,
  supportAfter: supportAfter.support,
  kickstandBefore: supportBefore.kickstand,
  kickstandAfter: supportAfter.kickstand,
});
```

Transient updates are intentionally absent from undo history. The gesture-end
commit records the original and final states as the one reversible action.
Attached support and kickstand snapshots must cover that same before/after
gesture so undo restores the complete selection atomically. Capture every model
that the gesture may move, including linked peers; models omitted from
`beforeTransforms` cannot be restored by the resulting entry.

Three payload patterns exist:

- **Inline state** — the common case for supports: the payload carries the full
  surrounding subgraph (`branches`, `braces`, `kickstands`, …) so an add can be
  undone and a remove re-added with cascades intact.
- **Typed arrays** — mesh smoothing pushes `{ geometryKey, uniqueIds, before, after }`
  and the handler writes the recorded deltas back into the topology.
- **Snapshot references** — whole-scene actions push a `{ key }` pointing into
  `sceneSnapshotRegistry` (in `useSceneCollectionManager.ts`), which stores the
  heavy `{ before, after }` pairs with a 200-entry + ~300 MB-eviction budget.

## Keyboard wiring

`src/hotkeys/useUndoRedoHotkeys.ts` is the only keyboard entry point. Keydown
(capture) → `HotkeyRegistryManager` pushes the key into `hotkeyStore` → the
subscription notices the rising edge of `GLOBAL.UNDO` / `GLOBAL.REDO` and calls
`undo()` / `redo()`. Redo is checked first because it is a strict superset
(Ctrl+Shift+Z suppresses Ctrl+Z while held). It is disabled only while hollowing
voxel-edit mode is active.

## Related pages

- `dev/registration-seams.md`
- `dev/state-and-stores.md`
- `reference/hotkeys.md`
