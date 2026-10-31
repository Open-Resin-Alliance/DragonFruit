# Raft Geometry

DragonFruit raft generation produces a sacrificial base derived from support roots.

## Geometry pipeline

1. Group the support roots into clusters a model standing on the plate separates
   (see [Model clearance](#model-clearance)).
2. Compute a footprint per cluster from its circles (convex hull + margin).
3. Cut whatever the model still covers out of those footprints.
4. Generate the chamfered base plate.
5. Optionally generate a perimeter wall (crenelated where configured).

## Design intent

- Improve adhesion and support network stability.
- Ease removal via chamfer profile.
- Reduce suction issues with perimeter gap strategy.
- Keep the raft material-efficient while still forming a stable base.
- Never let the raft run through a model that rests on the plate.

## Model clearance

A model dropped onto the plate occupies the same volume the raft wants to fill, so
the raft is trimmed where the model stands:

> raft = hull(support roots, margin) − dilate(model plate footprint over the raft
> band, **1 mm**)

- **The band, not the contact patch.** The band runs from the plate (Z = 0) to the
  top of the raft material (`raftBandTopMm`: plate/beam height plus the wall). A
  ball resting on the plate touches it at a point, but over a 2 mm raft its lower
  cap widens by millimetres — cutting only the contact patch would leave the raft
  buried in the ball's flank. `collectModelPlateFootprint` unions the model's
  triangles *inside the band*, projected to XY, so concave and multi-lobed contact
  (two feet, a ring-shaped base) is handled exactly.
- **1 mm is a hard rule**, not a setting: `MODEL_PLATE_CLEARANCE_MM` in
  `modelPlateFootprint.ts`. It is applied by dilating the cut region
  (`inflateModelPlateClearance`), which grows the outside of the footprint and
  shrinks any hole inside it — the raft still keeps 1 mm from a ring-shaped
  contact patch's inner wall.
- **All visible models count.** A raft belongs to one model's supports but has to
  clear every model on the plate, so every call site passes the same visible-model
  list. Preview, export and slice must agree or the printed raft differs from the
  viewport.
- **The model separates rafts, it does not bridge them.** Roots land in one
  cluster only when the line between them clears the model
  (`clusterCirclesAroundClearance`), so two clusters on opposite sides of a model
  get one raft each instead of one raft wrapping around it. Whatever a single
  cluster's hull still covers — roots ringed around a model leave no pair to
  split them — is cut out as before.
- **Line mode drops the beams instead.** A beam whose line would pass through the
  model is never drawn (`filterLineRaftEdges`): cutting it would leave severed
  ends that have to be closed up again, and the two clusters should read as two
  clusters. A beam passing within half a beam width of the clearance counts as in
  the way, since its own width would overlap it.

## Where it lives

| File | Role |
|---|---|
| `src/supports/Rafts/Crenelated/geometry/modelPlateFootprint.ts` | `collectModelPlateFootprint` (band footprint in world XY, unioned across models), `MODEL_PLATE_CLEARANCE_MM`, per-geometry bottom-triangle index and transform caches |
| `src/supports/Rafts/Crenelated/geometry/polygonRaster2d.ts` | `rasterizePolygonsToRegion` — the polygon soup (one polygon per triangle) into simple nested rings, on a grid |
| `src/supports/Rafts/Crenelated/geometry/polygonSet2d.ts` | Clipper-backed set algebra: `PolygonWithHoles`, `unionPolygonSets`, `differencePolygonSets`, `offsetPolygonSet`, `polygonsFromPolyTree`, `polygonSetToShapes`, `polygonSetAreaMm2` |
| `src/supports/Rafts/Crenelated/geometry/computeRaftFootprint.ts` | `computeRaftFootprintPolygons` (hull minus clearance), `inflateModelPlateClearance`, `raftSolidHeightMm`, `raftChamferInsetMm`, `raftDynamicMarginMm`, `raftBandTopMm`, `raftWallBaseHeightMm` |
| `src/supports/Rafts/Crenelated/geometry/generateRaftFromFootprint.ts` | `buildRaftFootprintMeshes` (the shared seam: footprint + base + wall), `generateChamferedBaseFromPolygons`, `generateWallFromPolygons`, `isUntrimmedFootprint` |
| `src/supports/Rafts/Crenelated/geometry/generateUnionedLineRaftMesh.ts` | line-mode beam network; `filterLineRaftEdges` drops the beams the model is in the way of |

`buildRaftFootprintMeshes` / `computeRaftFootprintPolygons` are reached from the
viewport (`RaftRenderer`, `LineRaftRenderer`, `RaftProxyMeshLayer` via
`ModelAttachedSupportLayer`), the exporter (`ExportManager.exportScene`), the
slicer (`buildSupportAndRaftWorldTriangles` in `features/slicing/rasterLayerZipExport.ts`)
and the resin estimate (`computeSupportAndRaftResinMl` in `src/features/printing/supportResinVolume.ts`).

## Constraints

- **Untrimmed footprints keep the original generators.** A footprint that is still
  one convex ring (`isUntrimmedFootprint`) goes through `generateChamferedBase`,
  `generateCrenelatedWallManual` and `generatePerimeterWall` unchanged, so scenes
  whose models are lifted off the plate render exactly as before. Only a trimmed
  set (holes or several lobes) reaches the set-aware builders.
- **Trimmed walls follow outer rings only.** The clearance cut is not the raft's
  perimeter; the base closes that face with its own side wall.
- **The clearance cut can fold a miter.** `insetRingForSolidSide` clamps the
  chamfer miter so a tight concave corner cannot turn the ring inside out.
- **The cut region is a raster superset.** Unioning the band's triangles with
  Clipper took over a second on a model standing on the plate — a frozen frame on
  load — so `rasterizePolygonsToRegion` draws them on a grid instead. The grid
  reports the region up to a cell larger than it is (0.05–0.25 mm, chosen from the
  footprint size), which only ever *adds* clearance, and simplifies the traced
  boundary so it does not look stepped. A feature thinner than one cell can be
  missed, which for a raft that keeps a millimetre of daylight is not visible.
- **A support root inside the cut loses its raft patch.** The raft cannot both
  clear the model and hold a root that sits under it; the clearance wins.
- **Cost.** `collectModelPlateFootprint` rejects models whose bounding box stays
  above the band, indexes each remaining geometry's bottom triangles once, and
  caches both the local footprint (per scale and band) and the world one (per
  transform). A plate-touching model costs tens of milliseconds the first time and
  nothing afterwards; a model turned only about Z reuses its local footprint.
- `filterLineRaftEdges` is applied by every line-raft caller (viewport, preview,
  exporter, slicer) before `generateUnionedLineRaftMesh` builds the network, so the
  fallback that draws one beam per edge is filtered too.
- The chamfered branch of `generateUnionedLineRaftMesh` (`chamferAngleDeg`) has no
  caller in the app; it now delegates to `generateChamferedBaseFromPolygons`.

## Validation

- No NaN vertices.
- Correct winding and normals.
- Watertight output for export paths: `generateChamferedBaseFromPolygons` builds
  closed shells (every edge shared by two triangles), covered by
  `geometry/__tests__/raftPlateClearance.test.ts`.
- The trimmed raft never intersects the model it clears, asserted with
  point-to-triangle distances in the same test file.

## Related pages

- `docs/dev/slicing-engine/index.md` — the raft reaches the print through the same
  world-triangle buffer as the supports.
- `docs/dev/support-system.md` — support roots, the source of the hull.
