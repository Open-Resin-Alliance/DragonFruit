# Resin Estimate

The figure beside the printer in every workspace — `Est. resin` in the stats card,
`Est. Volume` in the slicing and printing panels — is one estimate, computed by the
app from three inputs: the models' own volume, the supports, and the raft. This page
is the map of that estimate. Read it before changing a number the user sees, because
three separate places used to compute it and only one of them agreed.

## What produces the number

| Part | Module | Method |
| --- | --- | --- |
| Model volume | `src/features/printing/modelResinVolume.ts` | Signed tetrahedron sum of the mesh (the divergence theorem), in the geometry's own coordinates, ÷ 1000 for millilitres. |
| Support volume | `src/features/printing/supportResinVolume.ts` | Analytic primitives, each mirroring the shape the slicer emits: root disk and cone, joint spheres (deduped by joint id), shaft cylinders along their own polyline, contact cones at their authored profile, disk contacts as cylinder plus tip sphere, braces at the diameter their host knots give them, anchors at their inline root. |
| Raft volume | same module, via `buildRaftMeshesForCircles` | Not approximated: the exporter's own meshes (chamfered base, crenelated or perimeter wall, line-mode beam network) are built and their triangles measured. |
| Money, layer count, print time | `src/app/page.tsx` | Not volume, but shown in the same card; the volume only feeds the cost line. |

`computePlateAndSceneSupportResinMl` composes the support and raft halves for one
plate and for the scene.

`modelResinVolume.ts` exposes the whole model-side surface:

- `resinVolumeGeometryInputs(geometry)` — the geometry's position and index attributes
  plus a content-addressed cache key, or null when it has no `position` attribute.
  The key is `resinVolumeSourceKey` (shared by every copy of one mesh) plus both
  attributes' versions, so an edit invalidates it and N copies are measured once.
- `computeModelBaseResinMl(position, index)` — the chunked, yielding sum: every 4096
  triangles it yields to the browser (`requestIdleCallback` where it exists, a
  macrotask otherwise), so a million-triangle import does not freeze the frame.
- `scaleResinMl(baseMl, scale)` — applies the model's transform. Each axis scales the
  volume by its own factor, and a mirrored (negative) scale does not make resin
  negative.

Both consumers keep their own result caches keyed by that cache key and their own
in-flight maps, because they run on different lifetimes (the app root and a card that
mounts and unmounts); the computation itself is shared.

## Where it is read

- `src/app/page.tsx` — the app's figures. `supportAndRaftResinMl` holds two numbers,
  `activePlate` and `scene`; `estimatedVolumeMlLabel` is the per-plate one,
  `estimatedResinTotalLabel` the scene-wide one beside it.
- `src/components/controls/ModelStatsCard.tsx` — renders the app's labels when they
  are passed, and computes the model-only figure itself when they are not.
- `src/features/slicing/components/SlicingPanel.tsx` — renders the caller's label.
  It does not compute a volume: the app owns the model, and a panel-local guess (a
  bounding box, which this panel used to fall back to) reported a box where the model
  has a shape.
- `src/components/organisms/panels/ExportPanelStack.tsx` and `PrintingPanelStack.tsx`
  — pass the label through.

## Per plate, not per scene

Resin is about the bed it prints on. The per-plate figure is built from the models on
the active plate, and the supports and raft of those models only; the row beneath it
carries every plate. `computePlateAndSceneSupportResinMl` takes both id sets and the
two model lists, intersects the sets itself, and returns `{ activePlate, scene }`.
Feeding the scene-wide support volume into the per-plate sum is the bug that made a
plate report its neighbour's raft; `supportResinVolume.test.ts` covers it.

## Deferred, not in render

`computeSupportAndRaftResinMl` walks every support and unions the raft footprint, and
the Support workspace writes the forest on every edit. The app therefore computes it
in an effect behind a short debounce (`SUPPORT_RESIN_ESTIMATE_DEBOUNCE_MS`) and keeps
the last value until the new one lands, so a burst of support writes collapses into
one pass and the label never flashes a supports-free figure. The value is derived
state: nothing renders differently while it is pending.

Base model volume is estimated in the background across every editable workspace, so
the export and printing figures are warm when the user gets there.

## How accurate it is

`supportResinVolumeParity.test.ts` hands the same support state to
`buildSupportAndRaftWorldTriangles` — the function that produces the triangles the
slicer slices — and compares the estimate with the volume of those triangles. The
estimate is a few percent above them, and the reason is detail, not shape: the
exporter tessellates (a 14-sided root, 12-sided shafts, a polyhedral joint sphere,
fewer sides in a dense scene), while the analytic primitives measure true circles.
The comparison is therefore held at 5%; a structural miss (a missing wall, a chamfer,
a beam network, a root cap the slicer does not print) lands far outside it.

What the estimate still cannot know before a slice is the output-side shaping: the
anti-aliasing tip shrink (`supportTipShrinkPercent`) and the material's tip
penetration, both resolved from the active profiles at export time. Contacts are
measured at their authored size.

## What this estimate is not

- **Not the slicer's volume.** The AFF and AFZ encoders compute their own figure from
  the raster they just wrote (non-zero pixels × pixel area × layer height) for the
  file header and `print_info` summary. That number is authoritative for the file; the
  app never reads it back.
- **Not the island volume.** Island analysis measures voxelised layer areas, a
  different quantity with its own module (`src/volumeAnalysis/IslandScan/ScanOrchestrator.ts`)
  and a native twin in `rust/dragonfruit-islands`.
- **Not the auto-support forest metric.** `scripts/bench-auto-supports.ts` sums the
  nominal primitives of a forest as a regression baseline, and says so; see
  [Auto-Support Metrics](auto-support-metrics.md).

## Related pages

- [Raft Geometry](raft-geometry.md) — the footprint the raft half of the volume follows.
- [Slice Job Assembly](slice-job-assembly.md) — what the slicer is handed.
- [Island Detection](island-detection.md)
