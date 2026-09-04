---
issue: feat/auto-supports-v1
date: 2026-08-18
kind: decision
status: accepted
---

# ADR-0038: Auto-support placement — the roads measured and closed

Automatic support placement reached its current shape (see
[Auto-Supports](../dev/auto-supports.md) for how it works) by trying six
plausible approaches and rejecting each on measurement. Every one of them is
the obvious thing to reach for, so without this record they get proposed again.

## Rejected: physics-informed shaft sizing

Sizing shafts from load, peel and weight was implemented and removed twice over.
It produced **visibly oversized** supports — a density-grid cell of 8 mm² got a
~1.5 mm shaft — and worse, an area-derived curve **inverted the presets**: a
light 16 mm² cell sized *thicker* (1.28 mm) than a heavy 5 mm² cell (1.12 mm),
because the curve rose with cell area.

Sizing is now a locked preset table (detail 0.60 / structure 0.70 / anchor
0.80 mm shafts, tips 0.28 / 0.32 / 0.38, roots 1.2 / 1.4 / 1.6) chosen by
supported area, with three mild modulators: height (up to +25 % above 70 mm),
carried area (merged clusters +20 % cap, grid cells sized by their own cell so
the lattice stops lumping itself into fatness), and underside angle. **No load,
peel or weight maths.** A forest resize pass then re-derives each trunk's
stepwise taper from its final attachment tree.

The naming left behind (`SizingDebugInfo`) makes physics sizing look like a
feature that was never finished. It was finished, measured, and taken out.

## Rejected: a tree-fan-out planner

The first pipeline planned a support tree per island and fanned it out. It was
replaced by a per-candidate grid placement pipeline; the planner and its unread
settings were later deleted outright rather than kept switchable.

## Rejected: letting anchors merge into trees

Anchors — the minimal near-plate supports under 5 mm — used to join branching
trees through an anchor-tree pass. They no longer do, and never host fan or
merge leaves either: the fan shaft pool and merge host search exclude anchor
origin, and consolidation never converts an anchor into a leaf.

The reason is structural rather than cosmetic: **anchors are load-bearing**. A
flat region's grid infill has to stay a 1:1 pillar forest instead of
tree-merging at roughly 4 mm of root.

## Rejected: grid trunks as general fanning hosts

Treating density-grid trunks like any other fan host meant long fan leaves
**swept across the grid forest and punctured grid shafts**. Grid trunks are now
hosts only within a tight `GRID_HOST_FAN_RADIUS_MM` (2.5 mm) against the regular
`LEAF_FAN_RADIUS_MM` (5 mm); beyond that the fan falls back to the nearest
regular trunk.

## Rejected: per-Voronoi-cluster brace pairing

Brace pairing used to run per Voronoi cluster. At dense auto-grid spacings
(2.0–2.4 mm) a seed cell can claim a single trunk, so per-cluster pairing found
no edges for it — **the trunk read as braceless and got a kickstand despite 27
braceable neighbours**. Pairing is now model-wide per model, distance-limited by
the brace run, and the ladder runs once over the shared pairs so the braces
placed match the pairs the kickstand decisions saw.

## Rejected: anchoring every contact cluster

Anchor bands densify the first-printed underside. Densifying *every* Z-cluster
was tried and over-supplied: with per-patch clustering virtually every region is
its own cluster minimum, so the band stopped discriminating — logged evidence
showed 5 of 5 regions anchored. Only the **lowest** cluster is the anchor layer;
higher clusters are suction surfaces and keep scale 1.

## Consequences

- Anything reintroducing load-based sizing has to explain the preset inversion
  first.
- Anchors and grid trunks are deliberately less connected than the rest of the
  forest; "improving" their integration re-opens two of the roads above.
- Shared radii and spans live in `src/supports/autoSupport/constants.ts`
  precisely because these thresholds were tuned against measurements and were
  previously duplicated inconsistently.

## References

- Key commits: `d3ea95a2` (empirical sizing), `a06cbc90` (planner replaced),
  `ecbe5eee` (anchors standalone), `92979052` (tight grid fan radius),
  `b374ddaf` (model-wide brace pairing)
- How the result works: [Auto-Supports](../dev/auto-supports.md)
