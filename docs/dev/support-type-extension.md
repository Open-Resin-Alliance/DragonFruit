# Adding a New Support Type

`src/supports/supportTypeRegistry.ts` holds one descriptor per type and is the
single source of truth for what a type *is*, but does not yet make a new type
work on its own: **declaring** a type is registry work, **wiring** it is still
partly manual. Steps below are marked accordingly.

The existing types are `Trunk`, `Branch`, `Leaf`, `Twig`, `Stick`, `Brace`,
`Anchor`, `Kickstand`.

> ⚠️ **Do not convert hand-wired paths to the registry while adding your type** —
> it puts a new feature and a behaviour-preserving refactor in one diff. Note
> what you hit, add the type, convert afterwards. See [Backlog](backlog.md).

Three reference shapes, by complexity:

- **Stick** — the floor: only `StickRenderer.tsx` + `stickBuilder.ts`, no
  placement UX (created as a cavity fallback inside trunk/branch placement).
- **Leaf** — the canonical *fully placeable* template: renderer + builder +
  placement-state store + page-level placement hook + canvas controller.
- **Kickstand** — the "owns its own barrel" template
  (`SupportTypes/Kickstand/index.ts`). Declare your entity in `types.ts` and
  read `SupportState` directly; do not add a per-type store.

This page walks through adding a new type `Gadget` (avoid the existing names).
Every numbered step below is required unless marked *optional*.

## 1. Type definitions — `src/supports/types.ts` *(registry-driven)*

Each entity is its own interface extending `SupportEntity` (the base
`{ id, modelId, settingsCodeHex }`). `Knot` is the exception — it hangs off a
shaft and carries no `modelId`, so its model is derived from its host.

- Add the entity interface next to the other support entity interfaces in
  `src/supports/types.ts`. It must be **JSON-serializable** (it round-trips
  through save/load).
- Add one line to `SupportEntityByCollection`: `gadgets: Gadget;`. That is the
  only place a collection is named. `SupportCollectionName`, `SupportCollections`
  and `SupportState` are all derived from it — do **not** add a
  `Record<string, Gadget>` field to `SupportState` by hand, as older revisions of
  this page instructed.
- `DragonfruitImportFormat` (`src/supports/types.ts`): this is a **flat,
  non-discriminated** structure — one plain array per type. `roots`, `trunks`,
  `branches`, `leaves`, `braces`, `knots` are required; the others optional. Add
  `gadgets?: Gadget[]`.

## 1b. Registry descriptor — `src/supports/supportTypeRegistry.ts` *(registry-driven)*

Add `'gadget'` to `SupportTypeId` and one descriptor to `SUPPORT_TYPES`. This is
what makes every derived walk see the type. Beyond identity
(`id`, `label`, `location`, `selectionCategory`; `historyAdd` and
`historyRemove` are derived from the id),
you must answer each behaviour flag — they have no defaults, and a test asserts
every descriptor declares all of them:

| Flag | Ask |
| ---- | --- |
| `carriesModelId` | Do instances own a `modelId`? |
| `hasSegments` | Do instances have real shafts? |
| `contactFields` | Which contact primitive fields, in order? |
| `segmentsCarryBothJoints` | Does each segment carry both its joints, or do endpoints come from a root / parent knot / neighbour? |
| `hasDedicatedSnapPass` | Does the type get its own snap loop in `supportPathTargets.ts`? |
| `hasContactDiskLengthOverride` | Does a joint drag strip `diskLengthOverride` from its contact cone? |
| `ownsEditHistoryEntry` | Does its gizmo record its own before/after entry? |
| `ownsRoot` | Do instances own a `Roots` entry via `rootId`? |
| `claimsModelSurfaceGestures` | Does the placement router hand it pointer gestures on a model face? |

⚠️ `ownsRoot` is not optional bookkeeping: roots no entity claims get culled every
render, so a type that owns roots and forgets this flag has them deleted out from
under it.

If the store must call back into your type, register a slot rather than importing
`state.ts` from the registry (that would be an initialisation cycle):
`registerKnotDiameterRule` if knots on your shaft are sized specially (twigs
taper, so they do), `registerSettingsInference` if reading settings back off your
entity needs more than the tip/root/shaft the descriptor already declares.

You do **not** register an updater. `state.ts` walks the registry and gives every
type the generic one, which writes the entity, repositions the knots riding its
shafts and recomputes dependent geometry. Add an entry to `BESPOKE_UPDATERS` only
if your type genuinely needs different work -- three do.

## 2. The per-type directory — `src/supports/SupportTypes/Gadget/` *(hand-wired)*

The required piece is the renderer. Everything else is optional depending on
whether the type is user-placeable.

- `GadgetRenderer.tsx` — `React.memo` component typed against the entity. The
  renderer pulls live drag-preview geometry via `usePartDragUpdate<Gadget>('gadget', id)`,
  resolves hover via `useHighlight(...)`, and commits edits via
  `captureSupportEditSnapshot()` / `pushSupportEditHistory()` (see the Stick
  renderer).
- *Placeable only*: `gadgetBuilder.ts` (geometry/state builder), a
  placement-state store, a `useGadgetPlacement` hook, and a
  `GadgetPlacementController` listed in `supports/placementControllers.ts`.
- `index.ts` barrels are **optional** — only Anchor and Kickstand have one.

## 3. Rendering — `src/supports/SupportRenderer.tsx` *(hand-wired)*

1. Import the renderer and add an entry to the `detailRenderers` table:
   `component`, `entityProp`, and optionally `hosts` (return null to skip),
   `skip`, `extraProps` and `noClipping`.
2. Add `{renderDetailFor('gadget')}` to the JSX, in the order your type should
   draw relative to the batched-shaft passes.
3. *Optional*: declare `batchesPlainShafts` / `batchesShaftJoints` so unselected
   straight shafts and joints render via `InstancedShaftGroup`.
4. *Optional*: add the type to the render-lookup worker for primitive picking.
   Anchors skip it entirely, so it is not required for selectability.

`detailRendererCoverage.test.ts` fails if a declared type has no entry.

## 4. History — `src/supports/history/` *(registry-driven)*

1. `actionTypes.ts` — **nothing**, for the usual case. Both actions and both
   payload-map entries derive from the type id: the strings are
   `support:add-gadget` / `support:remove-gadget` (built by `addAction` /
   `removeAction`), and the payloads default to `SupportEntityPayload<'gadget'>`
   and `SupportRemovalResult<'gadget'>`, read from the entry you declare in
   `SUPPORT_REMOVAL_SHAPES`. Add an entry to `AddPayloadOverrides` or
   `RemovePayloadOverrides` only if your payload carries something the cascade
   does not (a branch's trunk reprofile, say). The map type-checks every push
   and handler; `SupportHistoryActionType` derives from it.
2. `useSupportHistoryHandlers.ts` — **nothing**. `registerSupportHistoryHandlers()`
   walks the registry and registers each type's add/remove pair, inverting each
   other: undo of add removes the entity, undo of remove restores the payload.
   The hook is bound at the app root (`app/page.tsx`).

Drag/edit undo does **not** need per-type handlers — renderer-initiated edits
ride `SUPPORT_EDIT_REPLACE` with whole-`SupportState` snapshots
(`history/supportEditHistory.ts`), which is fully generic.

## 5. Store and serialization — `src/supports/state.ts` *(mostly hand-wired)*

Still the heaviest step.

- `initialState` — **nothing to do.** It spreads
  `createEmptySupportCollections()`, which derives from the registry.
- CRUD — `addGadget`, `updateGadget`, `removeGadget` (return a deep-cloned
  snapshot for undo, pattern `removeStick`).
- `SelectionCategory` union + `getSelectionLookupCache` — **entity resolution
  needs nothing.** `resolveSelectionCategory` walks `SUPPORT_STATE_COLLECTIONS`,
  so declaring your type's `selectionCategory` is enough; only the
  segment/joint/contactDisk lookup cache is still hand-written.
- `loadFromImportFormat` / `mergeFromImportFormat` — populate `gadgets` guarded
  like the optional arrays.
- `isolateImportedSupportPayload` — remap primitive ids inside the entity so
  imported payloads don't collide.
- `transformSupportsForModel` / `setSnapshot` — walk gadgets if they must move
  with a model transform.

## 6. Export — `src/features/export/logic/supportExportReconstruction.ts` *(hand-wired)*

- Include gadgets in `extractScopedSupportPayload`. Scoping itself is
  registry-driven -- `belongsToScope` walks your declared `edges`.
- Add `gadgets` to `buildScopedSupportExportDocument`'s returned format.
- Add a `buildGadgetGroup(...)` and one `gadget:` entry to the `groupBuilders`
  table in `buildScopedSupportGeometryGroup`. The table is typed
  `Record<SupportTypeId, GroupBuilder>`, so a missing entry fails to compile
  rather than dropping your type from every export.
- Do **not** name the group: return `{ id, group }` and the dispatch names it
  `Gadget_<id>` from `exportGroupName`, derived from the descriptor's `singular`.

## 7. Interaction — only for user-placeable types *(hand-wired)*

`src/features/supports/useSupportInteractionManager.ts` has **no tool registry** —
wiring is explicit:

- Invoke `useGadgetPlacement()` alongside the other placement hooks and route
  its callbacks through `resolvePlacementRouting()`.
- `resolveSupportCategoryFromSnapshot`, `collectAllSupportIds` and
  `canDeleteSelection` need **nothing**: all three resolve from the registry.
- `deleteSelectionByCategoryAndId` needs **nothing** for a type whose removal is
  the cascade plus one history entry: a generic block reads `historyRemove` off
  your descriptor. Only a type whose payload carries something extra (a branch's
  trunk reprofile) needs its own block, and it must then be listed in
  `RESHAPED_REMOVAL_PAYLOADS` — otherwise the generic block claims it first and
  your block is dead code.
- Deleting a **knot** deletes what it hosts, resolved by `findKnotHost` from the
  `hostedBy` edges onto `knots` that you declare. If your type can hang off a
  knot, add it to `KNOT_HOST_PRECEDENCE` (registry) — a knot-hosting type absent
  from that order is silently undeletable via its knot. A test asserts the two
  agree.

  The enumerated-conditional shape is the textbook case for the registry: a list
  of type names where forgetting one is silent. Where one remains, add the `||`
  and note it — but **not in your diff**. Add the `||`, note the
  line, convert it separately.
- Add `GadgetPlacementController` to `PLACEMENT_CONTROLLERS` in
  `supports/placementControllers.ts`; the scene mounts every entry under
  `mode === 'support'`. Placement *hooks* stay hand-wired above: the Rules of
  Hooks need a static call order, so they cannot come from a table.
  and add a `SUPPORTS` hotkey binding + resolver entry if it's hotkey-triggered.

## Optional integrations (only if the feature is wanted)

- **Proxy picking** (`SupportProxyMeshLayer.tsx`) — cached refs + per-type reads
  for raycast selection in prepare mode.
- **Model-link cascade** (`SupportModelLinker.ts`) — if gadgets should be removed
  when their model is deleted, add to the collections tuple and removal logic.
- **Home snapshot caching** (`supportSnapshotHelpers.ts`) — add `'gadgets'` to
  `HomeSupportCollectionsSnapshot` if home-scene caching should include it.
- **Settings cards / anatomy preview** — only for types that need a settings UI.
- **Editable settings** — set `hasEditableSettings` and the sidebar can write to
  your type: it gets a settings-hex cache bucket, and reads values back off the
  entity through the generic inference. Leave it false and the menu resolves no
  target for your type, so edits silently do nothing.

## Minimal checklist (bare, render-only Gadget)

1. `types.ts` — entity interface, one line in `SupportEntityByCollection`, format field
2. `supportTypeRegistry.ts` — `SupportTypeId` + descriptor with every behaviour flag
3. `SupportTypes/Gadget/GadgetRenderer.tsx` (+ `gadgetBuilder.ts` if it has geometry)
4. `SupportRenderer.tsx` — one entry in the `detailRenderers` table; the render
   loop, selected sets and batching derive from the registry
5. `state.ts` — SelectionCategory, lookup cache, import/merge/isolate. **Not** the
   updater (the registry loop covers it) and **not** `initialState` (derived)
6. `useSupportHistoryHandlers.ts` — add/remove handlers. **Not** `actionTypes.ts`:
   the action strings and their payload entries derive from the type id
7. `useSupportInteractionManager.ts` — **nothing**, unless the type reshapes its
   removal payload or can host a knot (see step 7 above)
8. `supportExportReconstruction.ts` — one entry in the `groupBuilders` table,
   typed `Record<SupportTypeId, GroupBuilder>`, so a missing type is a compile
   error. The group's exported name derives from `singular`

After wiring, run the registry tests — they fail loudly on a half-declared type:

```
node --import tsx --test "src/supports/__tests__/*.test.ts"
```

`registryIsSingleSourceOfTruth.test.ts` and `registryBehaviourFlags.test.ts` check
that every collection is covered and every flag declared. On Windows use the
double-quoted glob above; `npm test` single-quotes it and matches nothing under
cmd.exe.

## Related pages

- `dev/support-system.md`
- `dev/history-and-undo-redo.md`
