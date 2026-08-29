# Anchor

An anchor is a minimal grounded support for contacts that sit very close to the build plate, where a full trunk would be mostly root.

## What it is

- A short standalone pillar: frustum root → joint → one shaft segment → [contact cone](contact-cone.md).
- Chosen automatically, not placed by hand: grid placement emits an anchor instead of a trunk or branch whenever the contact point is below `ANCHOR_HEIGHT_THRESHOLD_MM` (5 mm, `src/supports/autoSupport/constants.ts`).
- It bypasses the grid system entirely — an anchor does not take a grid node or participate in trunk pairing.

!!! warning "Three unrelated things are called *anchor* in this codebase"
    This page is about the **support type** (`Anchor`, `src/supports/types.ts`). Separately, the doc comment on the unrelated `Knot` interface reads "Knot (Anchor)" — a legacy alias for a primitive that attaches supports to a shaft. Three meanings, one word.

## Geometry

The root is fixed-size rather than settings-driven (`anchorBuilder.ts`):

| Part | Dimension |
| ---- | --------- |
| Root base diameter | 2.0 mm |
| Root top diameter | 1.5 mm |
| Root height | 1.0 mm |
| Joint diameter | 1.5 mm |

The contact cone is **stretched to fit**, not placed at its authored length: the builder solves the cone length that lands the socket at the fixed root height above the plate, and clamps it to never come out shorter than the profile's own length. That is what lets one rigid root height serve contacts at any height under the threshold.

## Behavior

- **Always standalone, because it is load-bearing.** An anchor never merges into a branching tree, never hosts a fan or merge leaf, and is never converted into a leaf by the consolidation pass. A flat region's grid infill therefore stays a 1:1 pillar forest instead of merging into trees at roughly 4 mm of root.
- Branches, leaves and braces cannot target it — it is not a host shaft.
- `origin` records which auto-support pass created it, used only for debug origin colouring.

## Constraints

- The root seats on the plate or raft only.
- The entity must stay JSON-serializable: it round-trips through save/load and through `anchors?: Anchor[]` in the import format.
- Anchors are skipped by the render-lookup worker used for primitive picking; a fallback loop handles their selection instead.

!!! bug "Single-selection Delete is blocked"
    `canDeleteSelection` in `src/features/supports/useSupportInteractionManager.ts` omits the `anchor` category, while `deleteSelectionByCategoryAndId` handles it. A selected anchor is deletable in every path except the gate that decides whether Delete does anything, so pressing Delete on one does nothing. Multi-selection is unaffected.

## Related

- [Trunk](trunk.md) — what a contact above the threshold gets instead
- [Contact Cone](contact-cone.md) — the terminal piece an anchor ends in
- [Roots](roots.md) — the grounded base of a trunk, which an anchor deliberately does not use
