# Support System

The largest subsystem in the frontend. `src/supports/` owns everything from the geometry of a single contact tip to the interaction that places a whole forest.

## Where things live

| Directory | Holds |
| --------- | ----- |
| `SupportPrimitives/` | The reusable pieces every type is built from — Roots, Shaft, Joint, Knot, ContactCone, ContactDisk. Each with its renderer and, where it pays, an instanced group |
| `SupportTypes/` | One directory per placeable type — Trunk, Branch, Leaf, Twig, Stick, Brace, Kickstand, Anchor — each with a renderer and usually a builder |
| `PlacementLogic/` | Where a support is allowed to go: pathfinding, collision, solvers, grid policy |
| `interaction/` | Hover, selection, snapping, and the routing that decides which controller owns a click |
| `rendering/`, `Renderers/` | Shared render assembly and batched/instanced groups |
| `autoSupport/` | Automatic placement: candidate generation, coverage, Poisson spacing, anchor bands, physics-driven sizing |
| `autoBracing/` | Automatic brace generation, plus the mesh geometry store used for clearance |
| `Grid/`, `Curves/`, `Rafts/` | Grid lattice, curved segments, raft geometry |
| `history/` | The typed history façade for support actions |
| `Settings/` | Persisted support and raft settings, and the anatomy preview |

Three files at the root carry the weight: `types.ts` (every entity interface plus `SupportState`), `state.ts` (~4 800 lines of store and serialization), and `SupportRenderer.tsx` (~5 000 lines, one hand-wired block per type).

## What each piece is

The vocabulary — and the distinctions people get wrong, like knot versus joint or brace versus kickstand — is in [Anatomy of Supports](../reference/support-anatomy/index.md), one page per piece. The domain glossary in `CONTEXT.md` records the terms to avoid and where the code spells them differently.

## The contracts that bite

**Not registry-driven.** There is no central type registry: a new type is threaded through ~15 hand-written integration points. This is deliberate for now — the registry refactor is [in the backlog](backlog.md) and should not be attempted while adding a type. Follow [Adding a New Support Type](support-type-extension.md).

**Two rendering paths must agree.** Unselected straight geometry renders through instanced groups (`InstancedShaftGroup`, `InstancedJointGroup`, `InstancedRootsGroup`, `InstancedContactConeGroup`); selected and edited geometry renders individually. Both paths must produce the same hover and click semantics, or a support behaves differently depending on whether it happens to be selected.

**Knots must survive topology edits.** A knot persists its host shaft id, its normalized position along that shaft (`t`), and a world position derived from the host. Any change to shaft topology has to route through the paths that recompute knot placement — otherwise attachments silently drift or detach.

**Cascades are one history action.** Deleting a trunk rehosts or removes its dependents; that whole cascade is a single entry with before/after state, so undo restores a consistent graph rather than half of one. See [History and Undo/Redo](history-and-undo-redo.md).

## Multi-support settings

`applySettingsToSelectedSupports` in
`src/supports/Settings/applySettingsToSelectedSupports.ts` is the mutation path
for editing settings when one or more supports are selected. It reads the
current support selection, resolves every selected support to its editable
target, and batches all store mutations into one notification. When no
multi-selection exists, it falls back to the primary selected support.

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

## Related pages

- [Grid and Branching](grid-and-branching.md) — grid ownership and trunk replacement
- [Support Pathfinding V3](support-pathfinding-v3.md) — the routing solver
- [Raft Geometry](raft-geometry.md) — the base derived from support roots
