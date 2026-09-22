# Adding a New Support Type

`src/supports/supportTypeRegistry.ts` holds one descriptor per type and is the
single source of truth for what a type *is*, but does not yet make a new type
work on its own: **declaring** a type is registry work, **wiring** it is still
partly manual. Steps below are marked accordingly.

The existing types are `Trunk`, `Branch`, `Leaf`, `Twig`, `Stick`, `Brace`,
`Stump`, `Kickstand`.

**Three documents, no overlap:** this one is how to add a type;
`support-type-literal-plan.md` is what is left to convert;
`support-registry-findings.md` is what is still broken.

> ⚠️ **Do not convert hand-wired paths to the registry while adding your type** —
> it puts a new feature and a behaviour-preserving refactor in one diff. Note
> what you hit, add the type, convert afterwards. See [Backlog](backlog.md).

Three reference shapes, by complexity:

- **Stick** — the floor: only `StickRenderer.tsx` + `stickBuilder.ts`, no
  placement UX (created as a cavity fallback inside trunk/branch placement).
- **Leaf** — the canonical *fully placeable* template: renderer + builder +
  placement-state store + page-level placement hook + canvas controller.
  The store is not written from scratch: `createPlacementStore` supplies the
  subscribe/getSnapshot/notify/reset half, and the type adds only its own state
  shape and setters (see `interaction/shared/placement/placementStore.ts`).
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
| `canBeGridHost` | Can a fan link attach to this type's shaft? (the host pool, merge search, attachment cap and forest report all read it) |
| `hostsKickstand` | May a kickstand's host knot ride this type's segments? Read through `KICKSTAND_HOST_TYPES`; `KICKSTAND_HOST_BY_TYPE` mirrors it with literals kept so the host union narrows |
| `isAutoPlaced` | Does the auto-support pass place this type, and does the ledger report it? Read through `AUTO_PLACED_TYPE_IDS`, or `AUTO_PLACED_BY_TYPE` for the narrowed union |
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
shafts and recomputes dependent geometry. If your type genuinely needs different
work -- three do -- call `registerSupportUpdater` from your own registration
file, and the generic pass leaves that slot alone.

## 2. The per-type directory — `src/supports/SupportTypes/Gadget/` *(hand-wired)*

The required piece is the renderer. Everything else is optional depending on
whether the type is user-placeable.

- `GadgetRenderer.tsx` — `React.memo` component typed against the entity. The
  renderer pulls live drag-preview geometry via `usePartDragUpdate<Gadget>('gadget', id)`,
  resolves hover via `useHighlight(...)`, and commits edits via
  `captureSupportEditSnapshot()` / `pushSupportEditHistory()` (see the Stick
  renderer).
- *Placeable only*: `gadgetBuilder.ts` (geometry/state builder), a placement-state
  store built on `createPlacementStore` — declare your own state interface,
  `initialState`, and setters; spread `store.subscribe`/`store.getSnapshot` into
  your exported store and use `usePlacementStoreState` in the hook — a
  `useGadgetPlacement` hook, and a `GadgetPlacementController` listed in
  `supports/placementControllers.ts`. `placementComparators.ts` has the shared
  value comparisons (`vecEq`, `hostSnapTargetEq`) before you write your own.
- `index.ts` barrels are **optional** — only Stump and Kickstand have one.

## 3. Rendering — your own folder *(registry-driven)*

1. Call `registerSupportDetailRenderer('gadget', …)` from your renderer module,
   the way `TrunkRenderer.tsx` and `TwigRenderer.tsx` do. The factory returns
   `component`, `entityProp`, and optionally `hosts` (return null to skip),
   `skip`, `extraProps` and `noClipping`.
2. `SupportRenderer.tsx` — **nothing.** It asks `detailRenderersFor(...)` and
   loops over `SUPPORT_TYPES`; there is no table to edit and no JSX to add.
3. *Optional*: declare `batchesShaft` so unselected
   straight shafts and joints render via `InstancedShaftGroup`.
4. *Optional*: add the type to the render-lookup worker for primitive picking.
   Stumps skip it entirely, so it is not required for selectability.

`detailRendererCoverage.test.ts` fails if a declared type has no entry.

Bezier handles come from the registry: `Curves/BezierGizmo/bezierContextIndex.ts`
walks every `hasSegments` type and builds one context per joint and per segment
end, keyed by the selection id and prefixed with `bezierContextIdPrefix`. Both
ends resolve the way `resolveSegmentEndpoints` does — the declared lower
endpoint where a first segment carries no bottom joint, and the declared upper
endpoint at the top (a contact socket, or the host knot for a type whose
`upper.kind` is `knot`). Nothing to add, unless your type needs a handle no
declaration describes.

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

## 6. Export — `SupportTypes/Gadget/gadgetRegistration.ts` *(registry-driven)*

- Register how your type exports, in your own folder:

```ts
registerSupportExportGroup<Gadget>('gadget', (gadget, context) => {
    const group = new THREE.Group();
    addModelMetadata(group, gadget.modelId);
    // …build into `group`…
    return group;
});
```

- Return `null` to drop ONE entity (a broken host link) rather than failing the
  export.
- Use `context.supportState` to resolve an owned root or host knot, and
  `context.modelIdOf(id)` to follow an entity's declared links to its model.
- Take the shared pieces from `supports/exportGeometry/helpers.ts`:
  `addModelMetadata`, `appendShafts`, `appendConeGeometry`, `raftSettingsFor`,
  `globalPenetrationMm`, `SupportGeometryGenerator`.
- Do **not** name the returned group: the walk names it `Gadget_<id>` from
  `exportGroupName`.

`supportExportReconstruction.ts` needs **nothing**: the payload, the document and
the geometry group are all filled by walking `SUPPORT_TYPES`. `state.ts` throws at
load if a declared type registered no builder, and `supportTypeFolders.test.ts`
fails if the registration file is missing.

## 7. Interaction — only for user-placeable types *(hand-wired)*

`src/features/supports/useSupportInteractionManager.ts` has **no tool registry** —
wiring is explicit:

- Invoke `useGadgetPlacement()` alongside the other placement hooks and route
  its callbacks through `resolvePlacementRouting()`.
- `resolveSupportCategoryFromSnapshot`, `collectAllSupportIds` and
  `canDeleteSelection` need **nothing**: all three resolve from the registry.
- `deleteSelectionByCategoryAndId` needs **nothing**: the manager resolves the
  type from `selectionCategory`, removes it with `removeSupportEntity`, and the
  payload comes from `supports/history/removalPayload.ts`, derived from your
  `SUPPORT_REMOVAL_SHAPES` entry — its `self` plus one field per declared
  cascade entry. A field declared as an array (`['startKnot', 'endKnot']`) is a
  set of NAMED singular slots rather than a list.
- Removing one of your type also re-solves a host it hung from, when that
  host's own type declares `recomputesDiameterFromAttachments` — the host is
  found through your declared `hostedBy` knot edge and re-solved, with the
  result reported beside the cascade. The flag sits on the HOST, not on you:
  trunk is the one type that declares it, because a stepwise shaft diameter is
  derived from what it carries.
- A bridge type you declare for `contactSpan` may refuse a wide landing by
  leaving `mayReachSideways` false: the bridge search runs near radii first, and
  only a type allowed to reach sideways may land beyond the near cutoff. Twig
  allows it (short props off a neighbouring surface); stick does not (it stays
  near vertical).
- `PlacedKind` and `LEDGER_KINDS` come from the registry's declared
  `AUTO_PLACED_TYPE_IDS` — if auto-placement can place your type, add it there
  rather than to any list in `autoSupport/`.
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
- **A sidebar panel** (optional) — the panel's three settings flags derive from
  the registry automatically, so your type answers them already; offering a panel
  is adding your id to `TYPE_PANELS` in `Settings/sidebarPanels.ts`. If it should
  draw its own anatomy preview rather than fall through to the generic renderer,
  call `registerAnatomyPreview('gadget', GadgetPreview)` from wherever that
  preview lives. See `registration-seams.md`.

## Minimal checklist (bare, render-only Gadget)

1. `types.ts` — entity interface, one line in `SupportEntityByCollection`, format field
2. `supportTypeRegistry.ts` — `SupportTypeId` + descriptor with every behaviour flag
3. `SupportTypes/Gadget/GadgetRenderer.tsx` (+ `gadgetBuilder.ts` if it has geometry)
4. `SupportTypes/Gadget/GadgetRenderer.tsx` — one
   `registerSupportDetailRenderer('gadget', …)` call. **Not**
   `SupportRenderer.tsx`: the render loop, selected sets and batching all derive
   from the registry
5. `state.ts` — SelectionCategory, lookup cache, import/merge/isolate. **Not** the
   updater (the registry loop covers it) and **not** `initialState` (derived)
6. `useSupportHistoryHandlers.ts` — add/remove handlers. **Not** `actionTypes.ts`:
   the action strings and their payload entries derive from the type id
7. `useSupportInteractionManager.ts` — **nothing**, unless the type reshapes its
   removal payload or can host a knot (see step 7 above)
8. `SupportTypes/Gadget/gadgetRegistration.ts` — one
   `registerSupportExportGroup<Gadget>(...)` call under your own type id. The
   loader, the payload, the document and the group name all derive; the
   registration file is discovered from your folder, and `state.ts` throws at
   load if it never ran

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
