# Stump

A stump is a minimal grounded support for contacts that sit very close to the build plate, where a full trunk would be mostly root.

## What it is

- A short standalone pillar: frustum root → joint → one shaft segment → [contact cone](contact-cone.md).
- Chosen automatically, not placed by hand: grid placement emits a stump instead of a trunk or branch whenever the contact point is below `ANCHOR_HEIGHT_THRESHOLD_MM` (5 mm, `src/supports/autoSupport/constants.ts`).
- It bypasses the grid system entirely — a stump does not take a grid node or participate in trunk pairing.

!!! note "The word *anchor* still appears nearby, and means something else"
    This type was called `Anchor` until it was renamed to `stump`. The word survives in the codebase for unrelated things: geometric anchoring (the point something is fixed to), the `'anchor'` sizing preset, and the scene arrange anchor. None of them are this type. The threshold constant above keeps its original name.

## Geometry

The root is fixed-size rather than settings-driven (`stumpBuilder.ts`):

| Part | Dimension |
| ---- | --------- |
| Root base diameter | 2.0 mm |
| Root top diameter | 1.5 mm |
| Root height | 1.0 mm |
| Joint diameter | 1.5 mm |

The contact cone is **stretched to fit**, not placed at its authored length: the builder solves the cone length that lands the socket at the fixed root height above the plate, and clamps it to never come out shorter than the profile's own length. That is what lets one rigid root height serve contacts at any height under the threshold.

## Behavior

- **Always standalone, because it is load-bearing.** A stump never merges into a branching tree, never hosts a fan or merge leaf, and is never converted into a leaf by the consolidation pass. A flat region's grid infill therefore stays a 1:1 pillar forest instead of merging into trees at roughly 4 mm of root.
- Branches, leaves and braces cannot target it — it is not a host shaft.
- `origin` records which auto-support pass created it, used only for debug origin colouring.

## Constraints

- The root seats on the plate or raft only.
- The entity must stay JSON-serializable: it round-trips through save/load and through the import format's collection key. A scene saved under the former name loads through `src/supports/importMigrations.ts`.
- Stumps are skipped by the render-lookup worker used for primitive picking; a fallback loop handles their selection instead.

## Related

- [Trunk](trunk.md) — what a contact above the threshold gets instead
- [Contact Cone](contact-cone.md) — the terminal piece a stump ends in
- [Roots](roots.md) — the grounded base of a trunk, which a stump deliberately does not use
