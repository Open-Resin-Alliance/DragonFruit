# Scan Positioning

Scan-derived overlays and voxels must follow a strict coordinate policy.

## Core rule

Island scan inputs already use transformed world-space geometry (rotation, scale, and lift applied during scan preparation).

Therefore, render-time code must avoid double-applying transform components.

## Helper policy

Use centralized scan-positioning helpers for:

- Layer index → world Z conversion
- Outer visualization group positioning behavior

## Practical guidance

- Reapply only the intended post-scan visual attachment behavior.
- Do not reapply baked rotation/lift when scan outputs already encode them.
- Keep all scan-based features aligned to the same helper policy.

## Island footprints: world space, scene root

The island overlay (`src/components/scene/IslandInstancesOverlay.tsx`) draws the
contact footprints that `buildIslandInstances`
(`src/volumeAnalysis/Islands/islandInstances.ts`) packs from the detectors'
contact voxels. Those coordinates are already the frame `StlMesh` places the
model in, so the overlay is mounted **at the scene root with an identity
transform** and needs no positioning helper.

The decal it replaced (`IslandSurfaceDotsOverlay`) could live inside the model
group because it redrew the model's own local geometry and did its matching in
the vertex shader's world space. An instanced overlay cannot: mount it inside
the model group and the model transform is applied a second time, which puts
every island wherever the current rotation happens to send it. That is this
page's "rotation being applied twice in overlay rendering" pattern, and it
compiles, renders, and only looks wrong.

## Common regression patterns

- Double-lift in Z after rescan
- Rotation being applied twice in overlay rendering
- Feature-specific ad hoc positioning diverging from shared helper behavior
