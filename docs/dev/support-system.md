# Support System

The largest subsystem in the frontend. `src/supports/` owns everything from the geometry of a single contact tip to the interaction that places a whole forest.

## Where things live

| Directory | Holds |
| --------- | ----- |
| `SupportPrimitives/` | The reusable pieces every type is built from — Roots, Shaft, Joint, Knot, ContactCone, ContactDisk. Each with its renderer and, where it pays, an instanced group |
| `SupportTypes/` | One directory per placeable type — Trunk, Branch, Leaf, Twig, Stick, Brace, Kickstand, Stump — each with a renderer and usually a builder |
| `PlacementLogic/` | Where a support is allowed to go: pathfinding, collision, solvers, grid policy |
| `interaction/` | Hover, selection, snapping, and the routing that decides which controller owns a click |
| `rendering/`, `Renderers/` | Shared render assembly and batched/instanced groups |
| `autoSupport/` | Automatic placement: candidate generation, coverage, Poisson spacing, near-plate bands, physics-driven sizing |
| `autoBracing/` | Automatic brace generation, plus the mesh geometry store used for clearance |
| `Grid/`, `Curves/`, `Rafts/` | Grid lattice, curved segments, raft geometry |
| `history/` | The typed history façade for support actions |
| `Settings/` | Persisted support and raft settings, and the anatomy preview |

Four files at the root carry the weight: `supportTypeRegistry.ts` (what every type IS — see below), `types.ts` (every entity interface plus `SupportState`), `state.ts` (the store and serialization), and `SupportRenderer.tsx` (the scene render loop).

## What each piece is

The vocabulary — and the distinctions people get wrong, like knot versus joint or brace versus kickstand — is in [Anatomy of Supports](../reference/support-anatomy/index.md), one page per piece. The domain glossary in `CONTEXT.md` records the terms to avoid and where the code spells them differently.

## The contracts that bite

**Partly registry-driven.** `supportTypeRegistry.ts` is the single source of truth for what a support type *is*: `SUPPORT_TYPES` holds one descriptor per type carrying its id, label, `SupportState` collection, selection category, history action pair, and a set of behaviour flags. Anything that needs "every support type" or "every entity collection" derives it from there rather than listing types by hand.

The registry deliberately describes identity, not behaviour. It holds no renderers, builders or placement logic — adding those would turn a mechanical refactor into a rewrite. Where the store must call back into a type (updating an entity, sizing a knot on a tapered shaft), the registry declares a *slot* that `state.ts` fills at load, which avoids an initialisation cycle: `state.ts` calls `createEmptySupportCollections()` while the module is still evaluating.

Three shapes are acceptable when a piece of code needs type-specific behaviour, and one is not:

- **Derived** — loop over `SUPPORT_TYPES` or a key list. Preferred.
- **Declared** — a property on the descriptor, so the type is named once at its definition.
- **Subtracted** — `.filter(id => id !== 'trunk')`. Rejected: a new type silently joins or skips the set, which is the failure the registry exists to prevent.

**Adoption is partial.** `npm run scan:support-types` reports where per-type
references still sit — run it rather than trusting a number written here.
`state.ts` also keeps `@deprecated` per-type add/update/remove wrappers
(`addTrunk`, `removeBranch`) alive until their callers move.

What the registry has taken over: collection key lists, `initialState`, the modelId and shafted-collection walks, the updater and knot-diameter slots, root ownership, removal cascades and their history payloads, segment endpoint resolution, contact-bridge construction, placement-surface marking, shaft and joint batching, selection-category resolution, the delete gate, and the renderer's per-type detail table. What remains hand-wired: export reconstruction, per-type builders in the auto-placer, and parts of the interaction manager.

See [Adding a New Support Type](support-type-extension.md) for which steps are registry-driven today.

**Two rendering paths must agree.** Unselected straight geometry renders through instanced groups (`InstancedShaftGroup`, `InstancedJointGroup`, `InstancedRootsGroup`, `InstancedContactConeGroup`); selected and edited geometry renders individually. Both paths must produce the same hover and click semantics, or a support behaves differently depending on whether it happens to be selected.

**Unselected shafts are one capacity batch per shape.** `InstancedShaftBatch` (behind `SUPPORT_INSTANCED_SHAFTS`) draws every unselected support's straight shafts as one mesh and each quantized end-to-end taper ratio as one cone mesh, from the groups `SupportRenderer` already resolved — so model visibility, selection/ghost exclusion, the drop offset and the colour are the producer's, never re-derived. A tapered shaft is the same instance matrix over a `(ratio/2, 0.5, 1)` cone template, so a taper costs a shape bucket, not a draw per shaft; a brush of twigs and kickstands used to fall back to one `ShaftRenderer` plus a zero-alpha pick cone per segment. That producer change is Support mode only — the simple and navigation views have no batch, so they keep the legacy drop to detail meshes. Curves are the exception and stay out of the batch: a merged bezier tube has one radius and is hit-resolved by `faceIndex`, so it is still one `InstancedShaftGroup` per colour, and the hover/marquee overlays still mount for those curves only.

**The shaft batch answers hover through a grid, not through three's walk.** R3F raycasts every instance of every mesh carrying a pointer handler, so a hover on a batch that draws every shaft of every model in one mesh costs O(supports) per pointer move and per click. That batch carries a custom `raycast` (`src/supports/proxyHoverIndex.ts`): the shafts are indexed into cells over the plate and a ray only tests the cells it crosses, with a ray-to-segment distance per candidate. The index is built by `InstancedShaftGroup`, from the exact list that mesh draws — a target's `index` is the instance index the event reports, so an index built anywhere else can be shifted against the drawn list and every hit past the shift resolves to a neighbouring support's model. The split rule (`splitBatchedShafts`) is what must agree: a leaf's contact point is a zero-length shaft, which is not drawn, and 67 of an 18-model plate's shafts per model are exactly that. The other kinds keep three's own raycast, because their groups bucket their instances by geometry parameters into hundreds of small meshes: a whole-kind grid handed to them is asked once per bucket, and a bucket's `instanceId` indexes its own list, not the grid's. A hit means the ray passes within a support's radius plus a grab radius, and the grab radius scales with the **depth of the closest approach**, not with how far the ray missed: a miss is near zero whenever the pointer is anywhere near a support, so sizing the radius by it would leave a hit only when the pointer was exactly on one. The reported distance is along the ray, so callers sort by depth, and each intersection names the mesh that produced it: R3F walks `hit.object` up the parents to find the handlers, so a hit that names no object goes inert. The straight shafts, roots, joints and contact cones each carry a grid, and the same handlers they had before. Hover and clicks resolve a model, which is all they ever needed, but the *hit* is per support: a box per model was tried and rejected, because it covers the gaps between supports (hovering empty space tints a model) and covers the model itself (hovering the model stops highlighting it). Curved shafts keep three's own raycast on their merged tube, which is fine at their count. If you add a pointer handler to an instanced batch without giving it an indexed raycast, you have reintroduced the O(supports) raycast.

**Unselected contact cones and plate roots are one capacity batch per shape ratio, plus a fixed primitive each.** `InstancedContactConeBatch` (behind `SUPPORT_INSTANCED_CONES`) draws every unselected cone's frustum as one mesh per quantized body/contact ratio plus one tip-ball batch and one nib batch; `InstancedRootBatch` (behind `SUPPORT_INSTANCED_ROOTS`) does the same for roots with one cone batch per quantized ratio plus one disk and one top-ball batch. The ratio is the one dimension an instance matrix cannot carry, so it lives in the geometry; the *profile* does not split a batch — `sphere` and `legacy` cones draw body and tip, a `disk` cone adds the nib, and the nib's material carries the legacy `polygonOffset 1/1` or it z-fights the plate. Both slot lists come from the groups `SupportRenderer` already resolved (`sceneBatchedContactConeGroups`, `sceneBatchedRootGroupsByType`), so visibility, selection exclusion, the drop offset and the colour are the producer's. The root writer applies `ROOT_RENDER_LIFT_MM`; the cone writer takes the nib depth from the active material profile (`useContactPenetrationResolver`), because that follows the profile store rather than the scene. Hover and marquee are a per-instance colour with **no** matrix scale — the legacy overlays drew the same geometry at the same transform. Picking keeps the legacy asymmetry: only a root **disk** answers the pointer (the root cone and ball were `raycast={() => null}`), while a cone's body mesh indexes its whole silhouette — two body half-segments, a tip-ball stub and the nib's span, all sharing the body instance id — so the inert tip and nib meshes lose no hits. Both indexes run at tolerance 0: Support mode has never given cones or roots a grab radius.

**A joint drag draws through its own batch, not through the scene's.** While a
joint is dragged, `InstancedJointDragBatch` (behind `SUPPORT_INSTANCED_DRAG`)
draws exactly the dragged support's moved geometry — its joints at the resolved
detail diameter (blue for the dragged one, grey for its siblings), its adjacent
segments, its contact cone — from a private slot map built once at drag start
(`buildJointDragSlotMap`). The detail `JointRenderer` visual mesh,
`ShaftRenderer` visual mesh and `ContactConeRenderer` group are hidden with
`visible={false}` from the drag-suppression store rather than unmounted, so
their GPU pick registrations and pick ids survive the gesture. The writer
(`instanceDragWriter`) holds no React: `beginJointDrag` / `writeJointDragFrame` /
`endJointDrag` are an imperative transaction, and both a drag that starts on the
joint ball and one that goes through `JointGizmo` commit from
`getLastJointDragPreview()` — the preview the operator last saw. Types the
predicate rejects (a twig's contact disks, a brace, a stump, a leaf, any bezier
segment) never open a session and keep the 25 ms detail preview unchanged.

**A contact-disk (tip) drag draws through a cone-only batch.** While a selected
contact disk's HUD drags, `InstancedConeDragBatch` (behind
`SUPPORT_INSTANCED_CONE_DRAG`) draws exactly that one cone — body frustum, tip
ball and, for a `disk` profile, the polygon-offset nib — in the selected-disk
colour `#c11f61`, from a single-cone slot map built at pointer-down
(`buildConeDragSlotMap`). It is the only gesture served this way: a type opts in
by declaring `tipDragRebuildsGeometry: false` in the registry AND naming the
dragged field as a `cone` contact (`isConeOnlyTipDrag`). Trunk, leaf, stump and
stick qualify because the drag anchors the cone's socket, so no segment or joint
moves; a branch re-searches its socket and rebuilds its shaft, and a twig also
re-aims both disks and moves its disk-end joint, so both keep the detail path
byte for byte (they pass no `contact` descriptor to the session at all). The
grabbed cone alone is hidden, through `DraggedSupportContext.coneIds` with a null
`supportId` — the support's shafts and sibling joints stay on their detail
renderers, because the drag never moves them. `coneDragWriter` is the same
imperative transaction as the joint writer (`beginConeDrag` /
`writeConeDragFrame` / `endConeDrag`, session on `globalThis` because the hook
and the batch land in different lazy chunks), minus the model drop offset: the
preview cone comes from a world-space hit against the committed entity and the
detail renderer draws it with no offset. A click that never moves still commits
and pushes one history entry, exactly as before.

**The batches are one tiled set, not a live set plus a scenery set.** The split
existed because one batch per kind had bounds covering every plate; with tiles
each handful of primitives has its own sphere, so the split culled nothing. It
did cost a full rebuild of every support array whenever the active plate or the
selection changed (both change which models are scenery), which put a ~78k
instance re-layout inside the click that switched plates. Scenery still answers
no pointer and stays dimmed, but that is decided per instance and per hit now,
not by which array an instance was built into.

**The selection and the hover tint are one colour per instance.** The batches hold every visible model's primitives and are laid out from the support state, not from the selection or the hover. A model's supports are recoloured in place (`instanceColor` on the four groups, one merged tube per colour for curved shafts), which is why selecting every model on the plate costs a colour pass rather than one overlay per model. The tint is a **colour**, computed by `createProxySupportTint` (base, active, and a hovered model's blend of the two), not a translucent pass drawn over the batch: blending on top made a hovered support's orange depend on what was underneath it, so a support that was also selected came out a different orange than its neighbours in the same model. A selected model keeps the active colour, with nothing added for hover. The colour pass is a separate layout effect from the matrices: a tint must not re-derive every instance matrix to change a colour.

**The world layer hides an excluded model instead of dropping it.** The active model's supports are drawn by the layer attached to its group (so they follow a live transform), and the world layer used to leave them out of its batches. It now keeps them and zero-scales their instances (`isHidden` on the four groups), so making a model active costs the instances that changed state rather than a full re-layout of the plate. **The relationship no longer flips during navigation.** The attached layer used to be hidden for the duration of an orbit while the world layer stopped excluding its model, saving 124 draw calls while the camera moved. The exclusion change at each end re-rendered the layer and ran its per-instance hide pass over ~78k instances inside the pointer task; the render profiler measured a 62 ms long animation frame at orbit start (`onPointerDown` on the stack). A full-plate orbit holds 165 fps at 404 calls without the fold, so the attached layer now stays visible and the world layer always excludes its model. Curved shafts are the exception to hiding in place: a merged tube cannot hide one shaft, so the world layer takes those from the visible set and merges them again, which is cheap because each shaft's sweep is cached. A layer with a `modelFilterId` (the ghost and preview ones) still filters its geometry, because it draws one model by definition.

**A batch layout is ~0.1 us per instance, and it is paid per re-layout.** The four groups derive a matrix per instance whenever their arrays change (a support edit, or the active model moving between the world layer and its own attached layer). Keep the arrays stable when only a colour or a visibility changes, and hoist scratch objects in any helper the layout calls: minting a `Vector3` per instance per pass cost more than the maths in the cone batch.

**A rendered root sits 0.01 mm above the plate.** `InstancedRootsGroup` lifts its
whole stack by `ROOT_RENDER_LIFT_MM`. A root's disk bottom lands exactly on the
plate, which puts the plate top, the raft's bottom and every root disk on the same
plane: three coplanar surfaces fight for depth, and a raft of roots shows it as a
mottled patch through the raft. A hundredth of a millimetre is invisible at any
zoom the app offers. It is a rendering offset only — the sliced and exported
geometry comes from the support state, not from this batch — so it must not be
"corrected" back into the geometry builders.

**A proxy geometry that will be raycast needs a bounds tree.** `src/utils/bvh.ts` installs three-mesh-bvh's accelerated raycast globally, and a mesh whose geometry has no `boundsTree` falls back to the plain per-triangle test — paid once per visible mesh on every pointer move. The raft proxy geometries build one (`withBoundsTree`). three-mesh-bvh does not accelerate `InstancedMesh.raycast`, so the support batches carry the grid raycast described above instead.

**Knots must survive topology edits.** A knot persists its host shaft id, its normalized position along that shaft (`t`), and a world position derived from the host. Any change to shaft topology has to route through the paths that recompute knot placement — otherwise attachments silently drift or detach.

**Cascades are one history action.** Deleting a trunk rehosts or removes its dependents; that whole cascade is a single entry with before/after state, so undo restores a consistent graph rather than half of one. See [History and Undo/Redo](history-and-undo-redo.md).

## Multi-support settings

`applySettingsToSelectedSupports` in
`src/supports/Settings/applySettingsToSelectedSupports.ts` is the mutation path
for editing settings when one or more supports are selected. It reads the
current support selection, resolves every selected support to its editable
target, and batches all store mutations into one notification. When no
multi-selection exists, it falls back to the primary selected support.

### Profile field limits

`SUPPORT_PROFILE_LIMITS` (`src/supports/Settings/defaults.ts`) holds the sane
range of every General-tab profile field (`tip`, `shaft`, `roots`). The store
applies it through `clampProfileFields` on **every** write — the tab, a preset, an
imported scene and a plugin call all pass through it — so no path can hand a
negative or absurd dimension to the geometry builders. The same table supplies
the inputs' `min`/`max`, which also switches `NumberInput` to a pattern that
cannot start a negative value.

Zero is a legal limit for a height that may mean "no feature" (root disk/cone
height); diameters floor just above zero because a zero-radius disk or cone has
no usable normal. Upper bounds are generous — they catch a stray digit, not model
a printer. A new General-tab field is not protected until it is in that table and
clamped in `clampProfileFields`.

The settings sidebar shows the last selected support's values. Changing a value
applies those settings to the complete selection. The sidebar captures one
before/after support edit snapshot around the editing session, so undo restores
the whole selection in one step. Selection controllers must therefore keep a
primary selected support alongside the selected-ID set; clearing the primary
representative makes the sidebar non-editable even when IDs remain selected.
Shift-click toggles one support without disturbing the rest of the set. Detailed
primitive renderers must defer to the parent support while a multi-selection is
active: a normal click replaces the set with that support, while Shift-click
toggles only that support. Selecting a shaft, joint, knot, or contact cone in
either case would clear the support selection set.

## Placing supports

- By hand: modifier keys choose the family, the first click's target chooses the type — [Support Placement Modifiers](../reference/support-placement-modifiers.md).
- Automatically: `autoSupport/` generates candidates from island analysis and overhang regions, then sizes and places a forest. Gated behind an experiment.

### Below-platform placement

A trunk whose final contact cone or socket-joint sphere extends below world
Z=0 is invalid. `buildTrunkDataFromPlacement` in
`src/supports/SupportTypes/Trunk/trunkBuilder.ts` classifies the authored geometry
after resolving the cone axis, length, and disk standoff; it does not shorten the
cone or reposition the support to make it fit. Crossings deeper than 1e-6 mm use
the existing `OUT_OF_BOUNDS` limitation, while tangent contact is allowed.

`getContactConeLowestZ` in
`src/supports/SupportPrimitives/ContactCone/contactConeUtils.ts` returns the
analytic minimum world Z of a contact cone, including tilted end rims, its round
tip, and any contact disk. Pass the final cone, with the existing normalized
world-space normals and resolved `diskLengthOverride`:

```ts
const minimumZ = getContactConeLowestZ(contactCone);
```

The builder puts the same error on its result, route validity, and preview data.
The grid decision rejects it before snapping or host attachment can discard the
error, and hover/click do not try a cavity bridge for this limitation. Registry
overrides still validate their own geometry rather than inheriting an unused
trunk candidate's failure. The existing red preview and limitation feedback show
the refusal; ordinary clicks do not add it. The explicit force-place override
retains its existing behavior, as for other invalid supports.


## The placement guide line

Hovering a model in Support mode marks the band where the tip will land: the
intersection of the horizontal plane at the hovered point's height with the
model. Dragging a tip drives the same plane from the drag's hit point, which is
what tips get levelled against when several of them have to meet the model at one
height.

The plane lives in `supportPlacementGuideStore` (`src/components/scene/SceneCanvas/`).
It has two writers, `handleSupportHover` in `SceneCanvas` for model hover and
`useContactDiskDragSession` for a tip drag, and they do not share a render pass:
while `isContactDiskHudDraggingActive()` the hover path leaves the plane alone, so
a drag cannot fight the hover's ray for the same pointer.

Only the store's "is the plane set" flag is subscribed to (by `SceneCanvas`, to
mount the overlay); the Z is read imperatively every frame by `StlMesh`, which
writes the `uPlaneZ` uniform. The split is deliberate. The Z follows the pointer,
so carrying it in render state means either a scene re-render per pointer move or
a deadband on the value — and a deadband steps the line by `z / tan(tilt)` of
contour travel on screen, which is pixels on a shallow face and nothing on a
steep one.

The stripe itself is measured along the surface: distance to the plane's contour
divided by the surface's tilt against the plane. A face lying in the plane has no
contour and gets a faint wash instead of a stripe as wide as the face. The stripe
width is half the contact diameter of the tip being placed.

## Related pages

- [Grid and Branching](grid-and-branching.md) — grid node ownership and attachment
- [Support Pathfinding V3](support-pathfinding-v3.md) — the routing solver
- [Raft Geometry](raft-geometry.md) — the base derived from support roots
