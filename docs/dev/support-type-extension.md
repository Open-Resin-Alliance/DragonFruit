# Adding a New Support Type

The support system is **not registry-driven** — there is no central type registry
or single switch that makes a new type work. A support type is threaded through
~15 hand-written integration points across `types.ts`, `state.ts`,
`SupportRenderer.tsx`, the interaction manager, history, and export. The existing
types are `Trunk`, `Branch`, `Leaf`, `Twig`, `Stick`, `Brace`, `Anchor`,
`Kickstand`.

Three reference shapes, by complexity:

- **Stick** — the floor: only `StickRenderer.tsx` + `stickBuilder.ts`, no
  placement UX (created as a cavity fallback inside trunk/branch placement).
- **Leaf** — the canonical *fully placeable* template: renderer + builder +
  placement-state store + page-level placement hook + canvas controller.
- **Kickstand** — the "owns its own store + barrel" template (`kickstandStore.ts`,
  `SupportTypes/Kickstand/index.ts`). Note it also keeps its entity interface in
  `SupportTypes/Kickstand/types.ts` rather than the central `types.ts`; copy the
  rest of its shape, but follow step 1 and declare yours centrally.

This page walks through adding a new type `Gadget` (avoid the existing names).
Every numbered step below is required unless marked *optional*.

## 1. Type definitions — `src/supports/types.ts`

There is no single `SupportType` union. Each entity is its own interface extending
`SupportEntity` (the base `{ id, modelId, settingsCodeHex }`).

- Add the entity interface next to the other support entity interfaces in `src/supports/types.ts`. It must be **JSON-serializable**
  (it round-trips through save/load).
- `SupportState` (`src/supports/types.ts`): add a `Record<string, Gadget>` keyed field
  plus the new id in the `selectedCategory` string union.
- `DragonfruitImportFormat` (`src/supports/types.ts`): this is a **flat, non-discriminated**
  structure — one plain array per type. `roots`, `trunks`, `branches`, `leaves`,
  `braces`, `knots` are required; the others optional. Add `gadgets?: Gadget[]`.

## 2. The per-type directory — `src/supports/SupportTypes/Gadget/`

The required piece is the renderer. Everything else is optional depending on
whether the type is user-placeable.

- `GadgetRenderer.tsx` — `React.memo` component typed against the entity. The
  renderer pulls live drag-preview geometry via `usePartDragUpdate<Gadget>('gadget', id)`,
  resolves hover via `useHighlight(...)`, and commits edits via
  `captureSupportEditSnapshot()` / `pushSupportEditHistory()` (see the Stick
  renderer).
- *Placeable only*: `gadgetBuilder.ts` (geometry/state builder), a
  placement-state store, a `useGadgetPlacement` hook, and a
  `GadgetPlacementController` mounted in `SceneCanvas.tsx`.
- `index.ts` barrels are **optional** — only Anchor and Kickstand have one.

## 3. Rendering — `src/supports/SupportRenderer.tsx`

There is no switch — `SupportRenderer.tsx` hand-wires one block per type:

1. Import the renderer.
2. Add a `renderGadgetList` memo (pattern `renderStickList`) and a
   `selectedGadgetIds` memo.
3. *Optional*: add a scene-batched shaft map (`stickShaftsBySupport` pattern) so
   unselected straight shafts render via `InstancedShaftGroup`.
4. Add the JSX block rendering `<GadgetRenderer .../>` (plus the batched-group
   block if step 3).
5. *Optional*: add the type to the render-lookup worker for primitive picking.
   Anchors skip the worker entirely (handled by a fallback loop), so it's not
   required for selectability.

## 4. History — `src/supports/history/`

1. `actionTypes.ts` — add a `SUPPORT_ADD_GADGET` / `SUPPORT_REMOVE_GADGET`
   constant pair, a `SupportGadgetPayload { gadget }` interface, and two entries
   in `SupportHistoryPayloadMap`. The map type-checks every push and handler;
   `SupportHistoryActionType` derives from it.
2. `useSupportHistoryHandlers.ts` — registration is **all-in-one**: the single
   `registerSupportHistoryHandlers()` registers every type in one array. Add
   add/remove entries (pattern `SUPPORT_ADD_STICK` / `SUPPORT_REMOVE_STICK`),
   inverting each other: undo of add → `removeGadget`, undo of remove →
   `addGadget`. The hook is bound at the app root (`app/page.tsx`).

Drag/edit undo does **not** need per-type handlers — renderer-initiated edits
ride `SUPPORT_EDIT_REPLACE` with whole-`SupportState` snapshots
(`history/supportEditHistory.ts`), which is fully generic.

## 5. Store and serialization — `src/supports/state.ts`

- `initialState` — add `gadgets: {}`.
- CRUD — `addGadget`, `updateGadget`, `removeGadget` (return a deep-cloned
  snapshot for undo, pattern `removeStick`).
- `SelectionCategory` union + `getSelectionLookupCache` + `resolveSelectionCategory`
  — add gadget segments/joints/contactDisks and the `state.gadgets[id]` branch.
- `loadFromImportFormat` / `mergeFromImportFormat` — populate `gadgets` guarded
  like the optional arrays.
- `isolateImportedSupportPayload` — remap primitive ids inside the entity so
  imported payloads don't collide.
- `transformSupportsForModel` / `setSnapshot` — walk gadgets if they must move
  with a model transform.

## 6. Export — `src/features/export/logic/supportExportReconstruction.ts`

- Include gadgets in `extractScopedSupportPayload`.
- Add `gadgets` to `buildScopedSupportExportDocument`'s returned format.
- Add a `buildGadgetGroup(...)` and append it in `buildScopedSupportGeometryGroup`.

## 7. Interaction — only for user-placeable types

`src/features/supports/useSupportInteractionManager.ts` has **no tool registry** —
wiring is explicit:

- Invoke `useGadgetPlacement()` alongside the other placement hooks and route
  its callbacks through `resolvePlacementRouting()`.
- Add the category to `resolveSupportCategoryFromSnapshot`, `collectAllSupportIds`,
  `deleteSelectionByCategoryAndId`, **and `canDeleteSelection`**. ⚠️ The existing
  `canDeleteSelection` omits `anchor` (a known bug — anchors are deletable but the
  gate blocks single-selection Delete). Mirror the *correct* behavior: add your
  category to both places.
- Mount `<GadgetPlacementController />` in `SceneCanvas.tsx` under `mode === 'support'`,
  and add a `SUPPORTS` hotkey binding + resolver entry if it's hotkey-triggered.

## Optional integrations (only if the feature is wanted)

- **Proxy picking** (`SupportProxyMeshLayer.tsx`) — cached refs + per-type reads
  for raycast selection in prepare mode.
- **Model-link cascade** (`SupportModelLinker.tsx`) — if gadgets should be removed
  when their model is deleted, add to the collections tuple and removal logic.
- **Home snapshot caching** (`supportSnapshotHelpers.ts`) — add `'gadgets'` to
  `HomeSupportCollectionsSnapshot` if home-scene caching should include it.
- **Settings cards / anatomy preview** — only for types that need a settings UI.

## Minimal checklist (bare, render-only Gadget)

1. `types.ts` — interface, `SupportState.gadgets`, `selectedCategory`, format field
2. `SupportTypes/Gadget/GadgetRenderer.tsx` (+ `gadgetBuilder.ts` if it has geometry)
3. `SupportRenderer.tsx` — import, render list, selected set, JSX block
4. `state.ts` — initialState, add/update/remove, SelectionCategory, lookup cache, import/merge/isolate
5. `actionTypes.ts` + `useSupportHistoryHandlers.ts` — add/remove handlers
6. `useSupportInteractionManager.ts` — category resolution, delete path, can-delete
7. `supportExportReconstruction.ts` — scoped payload, export document, geometry group

## Related pages

- `dev/support-system.md`
- `dev/history-and-undo-redo.md`
