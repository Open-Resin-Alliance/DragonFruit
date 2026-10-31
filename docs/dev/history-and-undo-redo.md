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
provider so an undo can restore the tool the edit was made in. `page.tsx` only
restores the tools in `HISTORY_TRANSFORM_MODES`; a tool missing from that list
leaves the user where they are. When the entry belongs to another workspace,
the switch skips that workspace's remembered tool, which would otherwise
replace the restored one. Anything inside a tool (the hollowing solid-area edit
mode, the Support panel) is not part of the origin; a domain that needs it
restores it in its own handler.

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
`subscribeHistoryOperations`, `subscribeHistoryDebug`. `peekUndo()` returns the
entry the next undo would pop, for code that has to know whether its own last
push is still on top.

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
3. **Everything pushed to the stack needs a handler.** An unhandled entry
   strands the stack: `undo()` pops it, finds no handler, and pushes it back
   forever. A marker with no undo behavior would need a pass-through
   (`() => true`), but prefer not to push one. Each marker is a Ctrl+Z that does
   nothing visible. The post-slice marker cost one per sliced plate, and after a
   multi-plate slice undo looked broken. To learn whether the scene changed since
   some point, subscribe to history changes instead (`subscribeHistoryChanges`,
   as `useSlicedPlates` does).
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

#### Bottom-anchored scaling

Panel scaling, scale reset, and gizmo scaling preserve each mesh's lowest
world-space Z, rather than its centre Z or the current Auto-Lift target. Use
`preserveModelBottom` from `src/features/scene/selectionLiftDrop.ts` with the
model's transform from the start of the edit and the next candidate transform:

```ts
const anchored = preserveModelBottom(
  { ...model, transform: beforeTransform },
  nextTransform,
);
```

The helper returns a cloned transform and adjusts only `position.z`, using the
mesh vertices and the bounding-box centre offset, so tilted meshes are anchored
to their actual lowest point. Retain the same before-transform throughout a live
edit to avoid drift. Multi-selection scaling keeps horizontal spacing changes
but anchors each model independently. Do not apply plate/lift snapping to scaling
previews or commits: that would overwrite the preserved height. Record the
adjusted position and scale together in the existing single history step.

`src/components/organisms/panels/PreparePanelStack.tsx` routes scale edits and
Reset Scale through the shared selection handlers even when exactly one model
is selected. Do not send that single-model branch directly to
`transformHook.setScale` or `transformHook.resetScale`: those setters update only
the scale, not the compensating position. `TransformControls` uses its required
`onScaleCommit` callback for scale-field blur and Reset Scale, independently of
the generic `onTransformCommit` callback. This keeps scale history in one scene
step without changing the existing move/rotation commit paths:

```tsx
onScaleChange={handleScaleSelectedModels}
onResetScale={() => handleResetSelectedModels('scale')}
onScaleCommit={handleSelectionTransformCommit}
```

See [Transform and Positioning](../workflows/transform-and-positioning.md).

Three payload patterns exist:

- **Inline state** — the common case for supports: the payload carries the full
  surrounding subgraph (`branches`, `braces`, `kickstands`, …) so an add can be
  undone and a remove re-added with cascades intact.
- **Typed arrays** — mesh smoothing pushes `{ geometryKey, uniqueIds, before, after }`
  and the handler writes the recorded deltas back into the topology.
- **Snapshot references** — whole-scene actions push a `{ key }` pointing into
  `sceneSnapshotRegistry` (in `useSceneCollectionManager.ts`), which stores the
  heavy `{ before, after }` pairs with a 200-entry + ~300 MB-eviction budget.

**A move is a delta, not a copy.** A transform step stores the model's before and
after transform as `supportMoves` on the pair, and the history handler replays
`transformSupportsForModel` (inverse on undo) instead of restoring a support
state. The old path deep-cloned the whole support store twice per commit — tens
of thousands of entities on a supported plate — which was the bulk of the
pointerup stall on a drag. Only a caller that also changes support *content*
(an explicit `supportBefore`/`supportAfter`) still takes the snapshot path. The
same rule makes a transform pair cost no history budget: the geometry it shares
with the live scene is not history memory, so the estimator skips live geometry
and the pair never triggers a spill.

### Disk-backed geometry spill

A scene snapshot keeps its model objects, transforms and support state in RAM,
but the geometry arrays can be moved to the **OPFS scratch store**
(`dragonfruit-undo/`, written by `src/features/scene/sceneSnapshotSpill.ts`).
Only `BufferGeometry` attributes and indices, plus the pair's **support state**
(JSON), move; model IDs, transforms, plates and printer stay in the pair, so the
existing `applySceneSnapshot` restore path does not change.

The support state matters as much as the meshes on a supported plate: a delete
of a 20-model scene carries ~20,000 entities, and the pair holds its own deep
copy. It is written verbatim (the per-type views *and* the canonical `supports`
map). Do not reduce it to `supports`: the primitive collections (`roots`,
`knots`) only exist as properties, and readers expect the views before the state
reaches the store.

- Snapshots spill when the registry's in-RAM geometry estimate exceeds the
  ~300 MB budget. A model delete spills its entry immediately: the undo pair is
  the only thing still holding the deleted meshes, so waiting for the budget
  would keep a deleted model's geometry resident. Undo stays available;
  rehydration reads the arrays back asynchronously.
- A geometry still referenced by a live model, the clipboard or another
  snapshot is not released, so sharing is preserved. The delete path passes the
  surviving model list explicitly, because the scene ref has not committed yet
  and the deleted models would still count as live.
- Rehydration is lazy: the history handler applies the snapshot inside the
  `before`/`after` pair after the scratch file is read. Missing scratch data
  declines the restore rather than applying a half-empty mesh.
- `releaseGeometryStorage` drops attributes, index, morph data, BVH and the
  centered-position cache. GPU disposal alone left the arrays alive behind
  stale fibers and render lists. It is only used for geometry nothing can draw
  any more: the deferred-disposal queue keeps its arrays (a swapped mesh can
  still be in a render list for a frame), and eviction schedules the release on
  an idle callback that re-checks the retained set before touching anything.
- Prepare's merged support geometry is per model and is released when the model
  is deleted (the delete path calls `releasePrepareMergedSupportsFor`). The
  entry is re-pointed at an empty geometry before its buffers go: a stale view,
  mounted prop or fiber can still hold the entry object, and dropping only the
  map slot left hundreds of MB alive. A *replaced* entry is different — the
  previous mesh stays drawn until the replacement publishes, so that path keeps
  its arrays and only frees the GPU buffers.
- The mesh chunk store is swept when the scene empties too, not only when models
  arrive; skipping the empty case retained every deleted model's compressed
  mesh (~150-200 MB on a loaded scene).
- Scratch files are removed when an entry is evicted or rehydrated, a 4 GB
  ceiling evicts the oldest spilled entries, and `pruneSpilledSceneSnapshots`
  removes orphans on startup.

Spill is best-effort: when OPFS is unavailable, quota is exhausted, or a geometry
uses an unsupported layout (interleaved/morph attributes), the snapshot stays in
memory and the old bounded-history behaviour applies.

### Plates on the scene snapshot

Beds ride on the same snapshot as the models, so an entry that changes the plate
list records them too: `captureSceneSnapshot` in
`src/features/scene/useSceneCollectionManager.ts` takes `{ plates, activePlateId }`
in its options, and `applySceneSnapshot` puts them back — a snapshot that carries
no plates leaves the list exactly as it is, which is what every models-only entry
wants.

`addPlate` and `removePlate` push such a snapshot. `removePlate` asks
`deleteModels` for `{ pushHistory: false }` and pushes the single entry itself:
undoing a models-only entry alone would bring the models back onto a bed that is
still gone and leave them on another plate. It keeps its synchronous signature for
callers and pushes from the deletion's completion, because `deleteModels` yields
to the UI before it finishes.

### Printer on the scene snapshot

Every snapshot records the printer it was taken under — `captureSceneSnapshot` always fills
`printerProfileId` from the profile store, and `applySceneSnapshot` puts it back. The beds
are spaced by the build volume, so an entry taken under one printer and undone under another
would restore models against frames that never applied to them. `null` is no printer; a
snapshot with `undefined` was taken before this was recorded and leaves the profile alone.

Switching printers is a step of its own, pushed by the layout effect in
`useSceneCollectionManager` that watches the profile. That effect is also what shifts the
models with their beds when the cascade re-spaces them, and it remembers the footprint the
beds were laid out on in `laidOutFootprintRef`. `applySceneSnapshot` moves that memory along
with the restored printer: without it, restoring a snapshot would look like a printer switch
and shift the models a second time. The one entry carries the beds and the models as well as
the profile, so undo takes the printer, the beds and the models back together.

Editing a profile's build volume is not a step. The profile itself is not part of the
snapshot, only which one is active, so there is no earlier volume to return to; the models
still shift when the cascade re-spaces the beds.

### Geometry replacements with external modifiers

`scene.replaceModelGeometry` in `src/features/scene/useSceneCollectionManager.ts` accepts `{ meshModifiersAfter, meshModifiersBefore? }` for hollowing operations that must undo geometry and externally stored `ModelMeshModifiers` together. Pass the complete modifier value as `meshModifiersAfter` (or `null` to delete it); without it or `historyBefore`, the replacement creates no history entry. The optional `meshModifiersBefore` overrides the history before-state when Apply follows a draft edited over an earlier Apply: that geometry is hollow already, so restoring the draft verbatim would hollow it again at slice time, and the before-state is the earlier baked hollow instead.

```ts
scene.replaceModelGeometry(modelId, hollowedGeometry, 'Apply Hollowing', {
  meshModifiersAfter: appliedModifiers,
  meshModifiersBefore: previousBakedOrUnhollowedModifiers,
});
```

The scene history handler restores the modifier store before the corresponding model snapshot. A first Apply records the draft it applied, blockers included, as its before-state (the draft edits are steps of their own), and Remove Hollowing deletes the hollowing field while retaining unrelated modifiers. Later panel edits can create a new unbaked hollowing draft; Apply commits that draft as baked geometry. Snapshot geometry remains available for redo; `useHollowingManager` and `prepareModelGeometry` discard only derived source, cavity, preview, and slice-preparation caches on reversal.

A tool that previews its change on the live model passes `historyBefore: { transform?, supportState? }` instead, so the step's before-state is the model as it was before the preview, and `transformAfter` so the final transform lands with the geometry in the same update and step. Mirror does this: the preview flips the transform (and X/Y move the supports), and the bake at the end of the session records one step back to the unmirrored model.

### Mesh modifier edits

Hollowing and hole-punch drafts — the panel settings, the placed holes, the open
face — live in the model's mesh modifiers, and the panels resync from them
whenever the active model changes (the sync effect in `src/app/page.tsx`). So an
edit to a draft becomes undoable by recording the modifiers, and nothing else:

```ts
scene.setModelMeshModifiers(modelId, nextModifiers, {
  historyDescription: 'Edit Hole',
  merge: true,
});
```

With `historyDescription`, `setModelMeshModifiers` in
`src/features/scene/useSceneCollectionManager.ts` pushes a scene snapshot pair
whose `modifierRecord` holds the modifiers before and after. Without it, the
write is not a step: use that for writes the app makes on its own (adopting a
rotation stamp, resyncing to what Rust accepted), never for a user's edit.

`merge` is for fields that report every keystroke and wheel notch. A write with
`merge` folds into the previous step when that step has the same description,
is for the same model, is less than a second old and is still on top of the
undo stack (`peekUndo()`); the stored pair's after-state is updated in place.
Discrete actions — adding, moving or deleting a hole — never merge.

An edit that also swaps the geometry (applying, removing or resetting holes)
passes the modifiers to `replaceModelGeometry` as `meshModifiersAfter` instead,
so the mesh and the modifiers that describe it go back as one step. Writing
the modifiers separately afterwards would leave two steps, the first of which
undoes the mesh but not the drafts.

### Hollowing solid areas

Solid areas ("blockers" in the code) are their own domain, `src/features/hollowing/history/`, with one
action, `hollowing:blockers-edit`, whose payload is the model's sorted
blocked-voxel indices before and after a click, a lasso or Clear. While the
blocker edit mode is open on that model, the handler moves the blockers being
edited; once Done has committed them, it moves the committed ones in the
modifiers and reopens the edit mode on that model, so undo goes back to where
the step was made. Steps walked through from there are still committed ones
and keep moving both sets until a new stroke starts an edit of its own. Done
itself pushes nothing: the edits already are the steps. A step
whose expected indices no longer match — from an edit session that ended
without Done — is declined and discarded.

## Keyboard wiring

`src/hotkeys/useUndoRedoHotkeys.ts` is the only keyboard entry point. Keydown
(capture) → `HotkeyRegistryManager` pushes the key into `hotkeyStore` → the
subscription notices the rising edge of `GLOBAL.UNDO` / `GLOBAL.REDO` and calls
`undo()` / `redo()`. Redo is checked first because it is a strict superset
(Ctrl+Shift+Z suppresses Ctrl+Z while held). No tool switches it off: the
solid-area edit mode pushes to the app's history like every other tool (see
**Hollowing solid areas**).

## Related pages

- `dev/registration-seams.md`
- `dev/state-and-stores.md`
- `reference/hotkeys.md`
