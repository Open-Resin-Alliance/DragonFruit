# Registration Seams

Several subsystems expose a "register something, then the host dispatches to it"
pattern. The shape is consistent across all of them:

- A `registerX(...)` function that adds a claim/handler to a module-level registry
  and returns an **unregister closure**.
- The host picks what to invoke at dispatch time, usually by a predicate and/or
  priority.
- Consumers never import each other — they just register against the seam.

This page documents the non-history seams. Undo/redo registration is covered in
`dev/history-and-undo-redo.md`; plugin registration is covered by the plugin docs.

## Delete registry

`src/features/delete/deleteRegistry.ts` is a priority-ordered claim registry for
"what does Delete do right now". Each claim provides a predicate and an action.

```ts
export type DeleteHandler = () => void;

interface DeleteRegistryEntry {
  getCanDelete: () => boolean;
  performDelete: DeleteHandler;
  priority: number;
}

export function registerDeleteHandler(
  getCanDelete: () => boolean,
  performDelete: DeleteHandler,
  priority = 0,
): () => void;

export function getActiveDeleteHandler(): DeleteHandler | null;
export function triggerDelete(): boolean;   // runs the highest-priority enabled claim
```

`useDeleteHotkey` (`src/features/delete/useDeleteHotkey.ts`) bridges the
configurable `GLOBAL.DELETE` binding (default Backspace) and the fixed `Delete`
key to `triggerDelete()`.

Every claimant currently registered, highest first — check this ladder before
choosing a number, because the middle of the range is occupied:

| Priority | Claimant | Registered in |
| -------: | -------- | ------------- |
| 200 | Cut tool seam edit — Delete edits the seam instead of deleting the model (`ORGANIC_CUT_DELETE_PRIORITY`) | `src/hotkeys/useOrganicCutHotkeys.ts` |
| 100 | Support interaction manager | `src/features/supports/useSupportInteractionManager.ts` |
| 50 | Hole punching | `src/features/hole-punching/useHolePunchManager.ts` |
| 30 | Delete selected models in prepare mode | `src/app/page.tsx` |
| 20 | "Select all models" deletion | `src/app/page.tsx` |
| 10 | Delete the active model | `src/features/scene/useSceneCollectionManager.ts` |
| 10 | Dispose a blob URL | `src/features/scene/useSceneManager.ts` |

**Ties fall back to registration order.** Dispatch keeps a winner only when
`entry.priority > winner.priority` — strictly greater — and the registry is an
insertion-ordered `Set`, so on an equal priority the *first* registration wins.
The two claimants at `10` above are both gated on prepare mode and differ only
in their predicates; do not add a third at that number expecting a defined
outcome. Pick a distinct priority instead.

Delete is deliberately **not** history-tied: every Cut edit is pushed to the app
history, so the normal global undo/redo inverts it.

## Mesh geometry store

`src/supports/autoBracing/meshGeometryStore.ts` is a module-level `Map` of
modelId → `THREE` geometry/transform used by auto-brace clearance. The scene
manager registers/unregisters a model's geometry as it is loaded/unloaded:

```ts
registerMeshForAutoBrace(modelId, geometry, transform);
unregisterMeshForAutoBrace(modelId);
```

Same seam shape: registration is keyed, unregistration is a `Map.delete`, and
consumers read the store by id without importing the registering module.

## Support export geometry

`src/supports/exportGeometry/seam.ts` is the seam between the export pipeline and
each support type's geometry. A type's export builder lives in that type's own
folder and registers itself:

```ts
registerSupportExportGroup<Gadget>('gadget', (gadget, context) => THREE.Group | null);
```

The export walks `SUPPORT_TYPES` and asks each descriptor's type what it builds —
so `supportExportReconstruction.ts` holds no type name, and a type added to the
registry is exported by declaring a builder, not by editing the pipeline.

- `context.supportState` is the live store, for a type that resolves an owned
  root or host knot; `context.modelIdOf(id)` follows an entity's declared links
  to its model.
- Returning `null` drops that ONE entity — a support whose host is missing is a
  broken link, not a reason to export nothing.
- The walk names each returned group `exportGroupName(typeId, entityId)` from the
  descriptor's `singular`; a builder never spells its own prefix.
- `exportGeometry/helpers.ts` carries what every builder needs:
  `addModelMetadata`, `appendShafts`, `appendConeGeometry`, `appendJoint`,
  `raftSettingsFor`, `globalPenetrationMm`, and the `SupportGeometryGenerator`
  facade. It names no support type.

Two guards, because a registration that never runs is silent:

- **At load** — `state.ts` calls `typesMissingExportGroupBuilder()` beside the
  same check for collection restores, and throws. A type whose registration
  module did not load fails at import rather than exporting an empty mesh.
- **In the folder** — `supportTypeFolders.test.ts` asserts every declared type's
  folder provides the `<type>Registration.ts` the loader looks for.

### How the registration modules load

There is deliberately **no hand-written import list**. A hand-written list is a
second place a type's name is written down, and adding a ninth type would
silently not load it.

`scripts/generate-support-registrations.mjs` discovers the folders under
`SupportTypes/` and writes `src/supports/generatedSupportRegistrations.ts`, which
`state.ts` imports for its side effects. The generated file is gitignored and
rebuilt by `predev` / `prebuild` / `pretest` — the same arrangement as
`generate-plugin-registry.mjs` and the builtin plugin registry, so a fresh
checkout always has it before anything compiles or tests.

A folder qualifies when it holds `<type>Registration.ts` (e.g.
`Trunk/trunkRegistration.ts`). Any metric here excludes generated modules: they
name every type by construction, so counting them would measure generated output
rather than hand-written code.

## Placement preview geometry

`src/supports/previewGeometry/seam.ts` is where a type whose placement preview is
not a whole provisional support registers the builder for it. The registry
declares the SHAPE (`previewShape: 'segment'`); this is the implementation.

```ts
registerSegmentPreviewBatchBuilder<GadgetPreviewData>('gadget', buildGadgetPreviewBatch);
```

The builder is a pure function of the preview data plus a context:

```ts
(id: string, preview: GadgetPreviewData, context: SegmentPreviewContext) => PlacementPreviewBatch | null
```

`context.maxShaftDiameterMm` is supplied by the caller rather than read from
settings, because the seam must stay out of the settings store — see the load
order note below. A builder never reads a store.

**Registered from the render layer, not from `<type>Registration.ts`.**
`previewGeometry/registerBuiltinPreviewBuilders.ts` holds the registrations and is
imported by `SupportRenderer`. It is deliberately NOT part of the generated
registration list that `state.ts` loads: those modules run while `state.ts` is
still initialising, and a preview builder reaches render-layer code, which would
re-enter the store mid-load. Preview geometry is only needed to draw, so it loads
with the renderer.

**Do not import a `<type>Registration.ts` module directly.** `state.ts` checks at
load that every type registered an export builder, and that check assumes
`state.ts` is the module-graph entry point. Reaching a registration module first
leaves that type mid-flight and the check throws a spurious error. Load `state.ts`
(or, for preview geometry, the render-layer module above) and let the chain bring
the rest.

## Sidebar anatomy previews

`src/supports/Settings/anatomyPreviewRegistry.ts` is where a sidebar panel
registers the component that draws its anatomy preview:

```ts
registerAnatomyPreview('gadget', GadgetPreview);
```

Registered from wherever the preview lives — a type's own folder, or the tool's
module (raft and grid are tools, not entity types) — so the sidebar mounts what
is registered rather than a table it must be kept in step with. A panel that
registers nothing falls through to `TrunkPreview`, the generic renderer, which is
deliberately not registered.

This replaced a hand-written `ANATOMY_PREVIEWS` table plus a `drawsOwnPreview`
boolean whose only job was agreeing with that table, policed by a test.
`hasOwnAnatomyPreview(panel)` is now "did anyone register one", so the two cannot
drift.

## Sidebar panels

`src/supports/Settings/sidebarPanels.ts` is the sidebar's own vocabulary: a panel
is a section of the sidebar showing settings plus the preview above. Panels are
support types AND tools (raft, grid, auto), so the tool rows are declared while
the type rows are answered by `typePanelFacts(typeId)` from the registry:

| field | derivation |
| ----- | ---------- |
| `tab` | the descriptor's `sidebarTab` |
| `settingsGroups.tip` | `hasEditableSettings && a contact field is a cone` |
| `settingsGroups.shaft` | `hasEditableSettings && hasSegments && !shaftTaper` |
| `settingsGroups.roots` | `lower.kind === 'plateRoot'` |
| `drawsOwnPreview` | `hasOwnAnatomyPreview(id)` — see above |

The compound forms are load-bearing, not incidental: twig and stick have shafts
and no *editable* shaft diameter, and a stump has a root with its own fields
rather than a plate root. Geometry and editability are different questions.

Every type answers, including those with no panel today, so offering one (stump
is the obvious candidate) is a UI change rather than a data gap.

## Writing a new seam

Follow the existing shape so it reads like the rest of the codebase:

- Keep the registry module-level and dependency-free (a `Set`/`Map` of entries).
- `registerX` takes the claim plus an optional priority and returns an unregister
  closure that removes exactly its own entry.
- Dispatch selects at call time (highest priority whose predicate is true, or a
  per-key lookup) — never at registration time.
- Prefer returning a plain `() => void` unregister (not a fancy token) so callers
  can hold it in a `useEffect` cleanup or a returned disposer.

## Related pages

- `dev/history-and-undo-redo.md`
- `dev/plugins-framework.md`
