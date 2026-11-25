# Auto-Supports

Automatic support placement: given the island-analysis output for a model, decide where supports go, how thick they are, and brace them — then commit the whole thing as one undoable change.

Gated behind the `auto-supports` experiment (see [Experiments Framework](experiments-framework.md)); the gate is checked in `src/app/page.tsx`.

## The seam that matters: plan, then commit

`computeAutoSupportPlan(islands, modelId, settingsOverride?, baseState?, mesh?)` is pure with respect to the stores: it clones the current snapshot, works on drafts, and returns an `AutoSupportPlan` holding `before`, the new `support` state (kickstands included), `analytics` and `result`. It commits nothing.

`runAutoPlace(...)` is the thin caller that computes a plan and, only if `result.changed`, calls `setSnapshot()` / `setKickstandSnapshot()`.

Keep that split. It is what makes the run testable without a store, lets a caller preview or discard a run, and keeps the whole placement — including auto-bracing — a single history entry rather than a stream of mutations.

**The draft is owned.** `createOwnedDraft(before)` gives the run a state whose collections are copied on their first write and mutated in place after that (`supportDraft.ts`). The run is the only holder, so this changes nothing about the plan/commit split — but it is what makes a run affordable: spreading `{ ...draft, [key]: { ...draft[key] } }` per placement copied a collection of several hundred entities for every support, which was most of the run's time. Two rules follow:

- Callers that build a *different* state (`{ ...draft, ... }`, `cloneSupportState`) get an unowned object; the adders there fall back to copying, so they stay immutable.
- A step that must not see an entity still standing in the draft (chunk consolidation converting a pillar into the link that replaces it) passes `excludeHostIds` to `fanLeafToHost` / `buildConsolidationBranch` and removes the pillar after the build succeeds. Do not prune a copy of the draft instead: that copy is the cost the owned draft exists to avoid.

`before` is never mutated. The draft starts as a shallow copy plus copy-on-write, so `plan.before` remains the pristine state the history entry needs.

## The pipeline

Six phases inside `computeAutoSupportPlan` (`autoPlace.ts`):

| # | Phase | What happens |
| - | ----- | ------------ |
| 0 | Settings | Normalize; bail out returning `null` when disabled |
| 1 | Generate candidates | Turn detected islands into `CandidatePoint`s (with corner-first perimeter + interior sampling on overhangs `≥ 4 mm²` or `≥ 3 mm` span), stabilization anchors, minima reinforcement, and Phase 1c representative-layer Voronoi traction optimization (`tractionOptimization.ts`) |
| 2 | Deduplicate | Collapse nearby candidates (flat overhang pairs keep a 3D ball so lower heels never erase higher toes; sloped overhangs use grown influence) |
| 3 | Synthesize & place | Cluster-first tree synthesis (`treeSynthesis.ts`) places well-spaced cluster trunks first (`MIN_TRUNK_SPACING_MM` or distinct grid nodes) with a tall-solo flagpole penalty, attaches 1-level contacts (Pass 2b), builds 2-level `Trunk → Branch → Leaf` crowns for upper/occluded clusters (Pass 2c), runs the 3-tier plate-first occluded rescue ladder, then chunk consolidation, angle-aware gap filling, the one-shot traction-constrained densification pass (`tractionCovering.ts` over `forceBudget.ts`), and the per-support force report |
| 4 | Forest resize & cross-fix | Re-derive stepwise trunk diameters, sync member-proportioned leaf cone bodies (`syncContactConeDiameters`), validate/cascade-cull orphans across 2-level trees, and actively re-host shaft-crossing (`cross`) members onto clear hosts |
| 5 | Auto-bracing | Braces computed into the same draft, so they ride the one commit |

## Candidates

Islands arrive from volume analysis carrying a `source`. Three matter: `overhang` (the mesh-normal classifier's shallow surfaces), `minima` (local low points, only when `class === 'minimaOnly'`), and `intersection`. Emission is island-typed by footprint span: sub-head specks (≤0.5mm) get one tip at the bbox center; narrow islands 1.5–6mm long split into a symmetric pair (half area each); wide blobs keep one candidate (the grid path covers their area).

### Near-plate type overrides

`placeOneCandidate` may build a default trunk before the registry selects a
near-plate type with its own contact builder. An `OUT_OF_BOUNDS` error on that
unused trunk must not prevent `decideGridPlacement` from building and validating
the selected type. Only a registered override gets this deferral; an actual
below-plate trunk remains rejected, and a rejected override still adds nothing.
The rule is the same with grid mode on or off. See
[below-platform placement](support-system.md#below-platform-placement).


## Stabilization

Formation overhang and stability are two different failure modes, and the
island scan only models the first: a corner resting on a point, or a long
edge on a line, prints fine face-by-face yet nothing holds it against peel.
`computeStabilizationAnchors` (`stabilization.ts`) closes that gap. It scores
how the oriented mesh bears on the plate — the projected hull of the low
surface plus the surface centroid — and, when the pose can tip, lays teeth
along the low edge skeleton. Two regimes: a part resting on a low edge gets a
dense line of teeth along that edge plus flank stubs up the adjacent faces,
while a lone corner gets teeth climbing its radiating edges to the widest base
points. Climb height scales with the part (35% of height, capped at 30mm) so a
tall blade gets buttresses partway up instead of base teeth only. The common
case (a flat base) emits nothing. Gated by the `stabilizationEnabled` setting
(default on).

Stabilization anchors enter placement as `source: 'stabilization'` candidates.
While the brace pass runs they attach to a host within the normal merge radius
(4 mm): a member off an already-rooted shaft resists the same topple moment with
one plate contact instead of one per tooth, and the brace carries the load the
extra roots used to. With `debugSkipAutoBracing` on they stay standalone
buttresses — nothing else would hold the moment, so the base they widen is the
whole point. They are still stamped `origin: 'island'`, so the consolidation
pass cannot convert them into trees.


## Minima reinforcement

A mesh minima is the first point of a section — the lowest vertex of whatever
is about to start printing — so one tip under it holds a *point* while the
section's whole cross-section hangs off that contact. `computeMinimaReinforcementPoints`
(`minimaReinforcement.ts`) rings it: `MINIMA_RING_COUNT` (6) contacts on a
circle of `MINIMA_RING_RADIUS_MM` (2.5 mm) around the minima, each landing on
the feature's own flank, so the section starts on a base instead of a needle.

Only `minimaOnly` islands are reinforced — a minima the voxel mask already saw
(`class: 'intersection'`) sits on a surface the island/overhang passes cover,
and ringing those would double supports on every ordinary overhang. A ring
direction is dropped unless its upward ray finds the flank within
`MINIMA_RING_MIN_RISE_MM` (0.2 mm) … `radius · tan(selfSupportAngleDeg)` above
the minima: a flat (a sub-voxel dip in a plane) has no flank and is served by
its single tip, a needle's flanks are steeper than the self-support angle and
hold themselves, and a direction that leaves the model ends in air. The ring is
drawn in XY, like the grid's boundary ring, so it cannot climb a limb.

Reinforcement points enter placement as `source: 'reinforcement'` candidates
with their own support origin, and that origin is declared
`convertibleToTree: true` — the one non-overhang host that is. They were
standalone pillars at first, on the reasoning that spreading the section's base
is the job, but a mini report showed what that cost: 18 of its 61 bare trunks
were ring points, all inside 5 mm of one another. The ring is a *crown of
contacts*, not a set of buttresses, so the pillars are chunk-able and the
consolidation pass pulls them onto the pillar they ring. Two gates decide how
many actually convert, and both are honest:

- the merge search at placement, which can only build a leaf up to
  `MAX_LEAF_SPAN_BEFORE_BRANCH_MM`; the shortest legal link from a contact
  2.5 mm off a pillar's axis is about 5 mm, so a contact rings its own tip only
  while the pillar's shaft top stays near the axis. Past that the link crosses
  into the branch path, whose departure rule (`≤30° from vertical`) refuses it —
  measured on a test cone whose tip pillar leans 1.15 mm off its own contact:
  every crown link measured 7.0 mm and was refused;
- the consolidation pass, which reaches 8 mm at 75° and routes a branch when the
  straight link is blocked. On the same cone the leaning pillar puts the section
  *between* the knot and the flank contact, so only 2 of 6 crown links clear the
  model and the rest stay pillars.

Both are the geometry talking, not a policy: a link that would print through the
section is not a chunk. What the pass guarantees is that a crown never stands
alone *by rule* — where the geometry allows the link, the plate contact goes.

Two interactions fall out of existing gates rather than from this pass. On a
bare cone the stabilization anchors climb the same feature, and dedup's 0.5 mm
ball then decides which of the two owns each direction (measured on a test
cone: 48 anchors ate 4 of 6 ring points) — the contact exists either way. And
since the ring sits inside `ALREADY_SUPPORTED_RADIUS_MM` (3 mm) of its own
minima, re-running on a supported model adds nothing: the tips already there
filter every direction.


## Distribution: one fixed-density scheme

There is no anchor selection, no bake-off, and no grid/Poisson split. Every
overhang region above `gridAreaThresholdMm2` gets the same treatment in
`generateGridCandidates` (`gridPlacement.ts`):

- **Boundary ring (perimeter-first, corner-to-corner)** — when `perimeterLoops`
  are present, the inset loop (`insetPolygonLoops2D`) is resampled in the
  2D-projected plane (`sampleBoundary2D`, configurable via
  `BoundarySampleOptions`). Pass 1 pins sharp convex corners (turning angle
  ≥ 35°, e.g., toe tips and rim corners) and local Z minima first (falling
  back to each closed loop's lowest-Z vertex on smooth rounded lobes, deduped
  so bottom-layer tips do not fuse under UV bleed); Pass 2 subdivides each
  corner-to-corner chain uniformly using Z-graded edge factors on tilted flats
  (`leadingEdgeFactor` 0.72× along the lower-Z peeling edge,
  `trailingEdgeFactor` 1.12× along the upper-Z trailing edge when
  `tiltEnabled` holds). Projection is the point: Z does not lengthen a boundary,
  so a sliver's ring is a short line and can never climb a limb. Each sample's
  Z comes from the surface sampler.
- **Hexagonal infill & rectangular fallback** — over `computeRegionSpacing`
  (angle + suction curve; its suction reference area is decoupled from
  `gridAreaThresholdMm2` so small soles entering the perimeter path do not
  compress large-slab spacing, and the spacing holds at the flat end until
  `SLOPE_RELAX_RAMP_START` of the way to the self-support angle — see the rules
  below), regions with `perimeterLoops` place staggered hexagonal interior
  rows inside the inset polygon with ring proximity suppression and a
  single center fallback when narrow near-plate feet suppress every grid corner;
  regions without `perimeterLoops` keep the rectangular lattice + voxel-mask
  fallback. Infill is still skipped for slivers and for footprints thinner than
  one lattice cell (`Math.min(width, height) < spacing`), where the rows would
  land a fraction of a millimeter apart and double the density of a rib the
  ring already carries end to end.
- **Shape handles degenerate cases**: `shouldUseDensityGrid` routes any overhang
  at or above `gridAreaThresholdMm2` (default `OVERHANG_GRID_MIN_AREA_MM2`,
  4 mm²) **or** with major footprint span at or above
  `OVERHANG_GRID_MIN_SPAN_MM` (3 mm) to perimeter + interior sampling — catching
  miniature soles, chins, cuffs, and thin ribs that a 25 mm² gate used to leave
  on one center pillar. Compact patches under both thresholds keep the
  single-candidate path. Sliver → ring only; normal face → ring + infill.
  `MAX_GRID_CANDIDATES_PER_REGION` (800) caps each region, falling back to
  angle-only spacing and even subsampling — never silently denser.

Every grid cell also takes the **normal of the face it lands on** (`faceNormalAt`),
not the region's single `surfaceNormal`: a region's cells sit on a surface that
curves or bends underneath it, and with one normal for all of them every contact
axis on a cylinder underside measured a median 26° (worst 41°) from the surface
it touched — the disc dug in on one edge and floated off the other. The voxel
fallback (and the boundary-ring fallback, which now samples the surface at its
own XY instead of keeping the voxel Z) has no face index and keeps the region
normal.

Surface resolution is triangle-accurate: `createTriangleSurfaceAt` upward-raycasts
the model mesh and accepts only hits whose face index is in the region's
`triangleIds` (exact barycentric Z); `createVoxelSurfaceAt` (0.25 mm mask +
lazily-built hash) is the fallback when no mesh or triangle list exists.

Deleted with the old scheme (do not reintroduce without a run-level reason):
anchor bands/column tests (`anchorBands.ts`), the competitive bake-off
(`distributionBakeoff.ts`), the Poisson disk generator and flatness dispatch
(`poissonPlacement.ts`), per-region anchor spacing multipliers, Z-banded
anchor density, and the anchor girth multiplier. Density is one knob:
`areaPerSupportMm2`, modulated by angle and suction.

## Coverage and gap filling

Coverage uses an underside-angle bridge radius (`bridgeRadiusForAngleDeg`,
combined with footprint area via `coverageRadiusForRegion`) rather than a single
3→6 mm disc everywhere:

- Flat ceilings (0–15°) peel hard and bridge only `FLAT_OVERHANG_BRIDGE_RADIUS_MM`
  (1.8 mm) in green-state resin, with **zero upward influence growth** across
  flat faces (`coverRadiusSq` disables `influenceRadiusMm` growth at ≤ 15° and
  caps it at +1.5 mm above 15°).
- Moderate slopes (15–35°) ramp linearly from 1.8 mm to 2.6 mm; steep
  self-supporting faces (≥ 35°) keep `TIP_COVERAGE_RADIUS_MM` (3.0 mm).
- Large flat regions still pack denser via `coverageRadiusForArea` (floored at
  half radius).

A region needs no uncovered-cluster fill once `REGION_COVERAGE_TARGET` (95%) is
met; uncovered clusters below `MIN_GAP_CLUSTER_MM2` (1.5 mm²) are skipped
**unless** their extent reaches `HIGH_LEVERAGE_SPAN_MM` (4 mm), so a long thin
bare sliver (a 5 mm × 0.25 mm line is 0.3 mm²) still gets a contact. Coverage is
a disc test and cannot see distance: `buildGapFillCandidates` also indexes the
region's holding tips (`HoldingTipIndex`, `supportSpan.ts`), measures every
footprint cell's plan distance to the nearest tip at or below it, and adds one
contact at the longest free span when that span is ≥
`HIGH_LEVERAGE_SPAN_MM` — even on a region whose coverage target is met. A
region carries at most one such span contact per pass, deduped against the
cluster contacts, and there are at most `MAX_GAP_FILL_PASSES` (3) passes per
run. In `deduplicateCandidates`,
flat overhang pairs (`|nz| > 0.90`) use the flat 3D ball so a lower heel never
erases higher-Z toe tips on gently tilted soles; sloped overhang pairs still use
the grown 2D disc (subject to `SUPPORT_RESTSTACK_DELTA_MM`, 5 mm), and discrete
islands (voxel/minima/intersection) always keep the flat 3D ball.

## Island starts and coverage closure (`startIslands.ts`)

**What a start is.** The lowest connected cross-section of a detached island:
material whose layer first appears with nothing below it. The voxel scan already
records this as `DetectedIsland.isDetached` (its own "0-bridge to layer L-1, or
L=0" answer) and exports the BIRTH footprint in `contactVoxels`/`contact`, so
the start is read from scan data rather than detected again. The run stamps
`startIsland` onto every island (`markStartIslands`) so placement, the forest
report and the tests share one definition. A minima or overhang region is not a
start unless it carries an explicit `startIsland` stamp.

**Why the generic rules are wrong for a start.** Candidate generation is
overhang/area-driven: a start can miss the perimeter/infill floor (about 4 mm²)
or the 1.5 mm² gap-cluster floor. `filterAlreadySupported` drops a candidate
within 3 mm in 3D of *any* existing contact, so a contact a layer above or below
can suppress the one the start needs. And the overhang coverage target is 95%:
the 5% a flat overhang is allowed to leave is exactly the peel-initiation patch
a start tears from. Too few contacts then prints a pancake — the first layers
peel before the island's cross-section can carry the part.

**The recipe** (`START_SUPPORT_CONSTANTS`):

| footprint | minimum contacts | coverage disc | coverage target |
| --- | ---: | ---: | ---: |
| ≤ 0.5 mm² (speck / narrow rib) | 1 | 1.2 mm | 99% |
| ≤ 3 mm² | 2 | 1.8 mm | 99% |
| > 3 mm² | 3 | 2.5 mm | 99% |

The larger footprint's three contacts are a base plane, not a count: a single
trunk under a 20 mm² start is the pancake case the recipe exists to stop.

**Pass order and behavior.** `computeAutoSupportPlan` runs the closure after the
overhang gap-fill loop and before the force budget and the stress/brace loop.
It reuses `buildGapFillCandidates` (now with `GapFillOptions`: target, radius,
cluster floor, contact-count floor, non-overhang sources, id prefix) and
`placeOneCandidate`; there is no second placement engine. Start contacts are
deduped only against tips in the same cross-section — a 0.25 mm band around
`baseZ` — so a contact several millimetres above/below can never suppress it.
The same pass is the **densification/coverage closure for every non-grounded
island**: a voxel/minima island the generic passes missed gets at least one
holding contact and its normal coverage target, and an overhang region that
still sits under target after gap-fill gets the rest. It runs at most
`START_SUPPORT_CONSTANTS.maxPasses` (3) passes and stops when a pass places
nothing.

**Report fields.** `ForestReport.starts` holds `count`, `underSupported` and one
`StartReportRow` per start: `id`, `areaMm2`, `contacts`, `minContacts`,
`coveragePct`, `uncoveredAreaMm2`, `zMm`, `pancakeRisk` (contacts below the
recipe OR coverage below 99%). `forestReportToText` prints a `STARTS` section
and the summary line `Starts: N (M under-supported)`; the run logs the same
line. `AutoPlaceAnalytics.startIslands`/`startsUnderSupported` expose the
counters to the bench and the panel.

## Representative-layer Voronoi traction optimization (`tractionOptimization.ts`)

Between candidate filtering (`filterAlreadySupported`) and normal/tip resolution,
`computeAutoSupportPlan` runs **Phase 1c** (`src/supports/autoSupport/tractionOptimization.ts`),
adapting Cao et al. (2025) to run interactively inside the auto-support worker:

- **Public surface**: `extractRepresentativeLayers(mesh, planeCountOverride?)`
  (returning `RepresentativeLayerProfile` of `RepresentativeLayer` peaks with
  solved `StefanPressureField`), `solveStefanFieldFromSegments`,
  `sampleStefanPressure`, `referenceStefanMeanPressureMm2`,
  `STEFAN_FEP_SCREENING_LENGTH_MM` (4.5 mm), `stefanTractionFactorAt`,
  `tractionMultiplierAtZ(profile, zMm)`, and
  `optimizeContactsByTraction(candidates, overhangRegions, settings, mesh?, modelId?)`
  (returning `TractionOptimizationResult` with `TractionOptimizationStats`).
- **Representative-layer slicing & Screened Stefan suction**: a single triangle
  pass slices 24–72 horizontal Z planes, computes exact closed cross-section
  area per slice via Green's theorem, and clusters adjacent slices whose coarse
  2D silhouette IoU is ≥ 0.85 and relative area delta ≤ 20% (the paper's
  relative-distance clustering, with a coarse silhouette instead of a
  downsampled image). Within a cluster the emitted layer is the **peak-load**
  one: the area maxima are the candidates, at most four Stefan fields are
  solved, and the field with the largest `integratedForceMm4` wins. That is the
  paper's max-load representative layer with our PDE as the force model in place
  of its MLP; a coherent run usually costs one solve per cluster. On each emitted
  layer, `solveStefanFieldFromSegments` scanline-fills
  the closed 2D slice and solves the **Screened Stefan (Helmholtz) PDE**
  `(∇² − κ²)p̃ = −1` (`p̃ = 0` on `∂Ω`, `κ = 1 / λ_FEP`) via Red-Black SOR.
  `stefanTractionFactorAt` normalizes `sqrt(p̃(x,y) / p̄_ref(A_0))` against the
  analytical Bessel mean pressure of a single-support disc (`A_0` =
  `areaPerSupportMm2`), so thin blades/snouts evaluate to low suction
  (`~0.65–0.85×`) while broad solid interiors peak smoothly up to `1.55×`. A
  downward multi-layer load check protects lower contacts carrying a broad upper
  representative layer's Stefan demand from being pruned away.
- **CVT repositioning on large flat ceilings.** `cvtRepositionPoints`
  (`tractionOptimization.ts`) is the geometric `E_f` half of the paper's
  optimisation: 3 Lloyd iterations, 2 mm max step, density weighted by the
  local Stefan traction. The objective also carries the paper's coverage term:
  when a point's Voronoi cell extends past the bridge radius, the move is
  blended 50/50 toward that cell's furthest sample so density does not pull
  the perimeter in. The final position snaps to an actual footprint sample,
  because an off-surface centroid misses the region triangle on a rotated
  face and is rejected at placement. It runs only on **large flat regions
  (≥ 50 mm², ≤ 15°)**; below that the footprint is too small for a Lloyd step
  to keep edge coverage, and the discrete add/prune below does the work. On
  `overhang-slab` this removed 6 trunks and 18 cross orphans at 3.6 % less
  member volume.
- **Discrete Voronoi add, per-region prune, and global cross-region prune**:
  each eligible overhang region's 0.25 mm `contactVoxels` are partitioned into
  discrete Voronoi cells integrating per-voxel `stefanTractionFactorAt`. Demand
  is carried in demand units (mm² × traction factor); multiplying by
  `NOMINAL_PEEL_PRESSURE_MPA` gives newtons, and a contact's capacity is its
  **break load** (`supportStrengthMpa × π/4 × tip diameter²`) in those same
  units — the tip diameter is the candidate's override or the run's sizing band,
  and the strength is the same derated support break strength the frame solver
  and force budget use. Cells whose demand exceeds their own seed's break load
  or `bridgeRadiusForAngleDeg` receive a reinforcement contact at their furthest
  point (respecting a 1.2 mm UV-bleed spacing floor). Within each region,
  redundant interior `grid-*` points are pruned when neighbors absorb 100% of
  their voxels within ≤ 80% of the absorbing tip's break load and ≤ 90% reach.
  A final **Pass C global cross-region Voronoi pruner** then runs across all
  candidates (using exact mesh-resolved normals, local `stefanTractionFactorAt`,
  and measured Voronoi demand per candidate) to collapse crammed micro-overhang
  fragments (`o*`) and tight upper perimeters (`fill-*`) that sit within
  `0.85 × bridgeRadiusForAngleDeg` of a same-or-lower-Z compatible-normal contact
  whose accumulated demand stays below `85%` of that host tip's break load.
  Same-region pairs inside large (`≥ 25 mm²`) overhangs are skipped so Pass B's
  exact `0.25 mm` voxel Voronoi coverage is preserved.
  Primary discrete islands (`voxel`/`minima`/`intersection`),
  `stabilization`/`reinforcement`, `nearBase` flat soles,
  downward-load-protected anchors, and Pass-A additions are hard-protected, and
  any contact that absorbs a neighbor locks as an anchor to prevent transitivity
  drift.
- **Forest resize clearance guard**: after `computeForestDiameterProfile`
  thickens attachment-loaded trunks, any trunk whose thickened shaft would now
  fail `isShaftBlocked` while its placed pre-resize shaft cleared the mesh is
  reverted to its placed diameter rather than thickening into a `hostBlocked`
  cull.
- **A bare pillar is not re-profiled.** `computeAndApplySupportDiameterProfile`
  only has attachment demand to write a stepwise profile from; a trunk with no
  hosted branch or leaf is skipped entirely. Re-deriving it from its own contact
  demand rewrote the placed diameter (normalizing a deliberately tapered pillar
  back to its base) and re-encoded its settings for no load story. A bare
  pillar's slenderness belongs to the stress loop and the placement sizing.

### Cao et al. (2025) completion map

| paper component | DragonFruit |
| --- | --- |
| representative layer clustering + max-load layer | `extractRepresentativeLayers`: IoU/area-coherent clusters, max integrated Stefan force per cluster |
| separation-force prediction per slice | 2D Screened Stefan PDE per representative layer (no MLP; gravity is negligible at these scales) |
| support traction → stress/density field | Stefan traction plus nearest-support Voronoi allocation in `computeForceBudget` |
| capacity-constrained circle covering | discrete Voronoi add/prune (0.25 mm voxels, break load per tip) |
| CVT / `E_f` + `E_o` geometric optimisation | `cvtRepositionPoints` on large flat ceilings, density centroid + coverage blend |
| force-augmented overhang regions | one-shot `tractionCovering` adds outside the covered area from the deficit field |
| support generation / trusses | cluster trees, consolidation, braces/kickstands, thin contact cones (MST-equivalent objective, not the paper's MST) |
| verification on representative layers | beam-frame FEA on the placed forest + Stefan profile (not voxel CZM FE per layer) |

The two deliberate substitutions are the MLP (we solve the local PDE directly,
which is cheap on a few dozen representative layers) and the CZM voxel FE
verification (the beam frame is the fast support check; full solid FEA remains
the separate Phase 1/2 track). Everything the paper uses to choose support
points is now present.

## Cluster-first tree synthesis and occluded rescue

Before placing shafts, `computeAutoSupportPlan` runs **Phase 2: Cluster-First
Tree Synthesis** (`src/supports/autoSupport/treeSynthesis.ts`) for both organic
and grid modes:

- **Public surface**: `synthesizeTreeClusters(candidates, options)` (options:
  `TreeSynthesisOptions`, `TreeSynthesisGridConfig`; returns `TreeClusterPlan`
  with `nearPlate`, `trunkAnchors`, `clusteredMembers: ClusteredMemberAssignment[]`,
  `upperClusters: UpperClusterGroup[]`, and `occludedQueue`),
  `computePlateReachability`, `isTooCloseToExistingTrunk`,
  `findOffsetSilhouetteRoute` (returning `SilhouetteEscapeRoute | null`),
  `maxEulerBucklingSpanMm`, `maxStableAngleForSpanDeg`,
  `minStableRiseForLateralMm`,
  `MAX_UNBRACED_BRANCH_SPAN_MM` (nominal `Ø1.0 mm` Euler buckling ceiling ~11.6 mm),
  `MAX_ROUTED_TRUNK_DIAGONAL_SPAN_MM` (10.5 mm),
  `TWO_LEVEL_BRANCH_REACH_MM` (8 mm), `UPPER_CLUSTER_MIN_Z_MM` (18 mm), and
  `UPPER_CLUSTER_SIBLING_RADIUS_MM` (4.5 mm).
- **Tree chunks stop at eight contacts, and the two-level crown reaches
  10 mm.** `MAX_CONSOLIDATION_CONTACTS_PER_CHUNK` (8) caps a chunk below the
  user's `maxAttachmentsPerTrunk` when that is higher: one tree is a
  hand-sized snap-off group, not a twelve-finger bush. `TWO_LEVEL_BRANCH_REACH_MM`
  is 10 mm so an upper cluster further from a ground trunk still becomes a
  shared `Trunk → Branch → Leaf` crown instead of a fresh mast. Terminal hops
  already route past `MAX_LEAF_SPAN_BEFORE_BRANCH_MM` (4.5 mm) into real branch
  shafts, which is the short-finger rule this pass relies on.
- **Wider pillar spacing was measured and rejected.** Raising
  `MIN_TRUNK_SPACING_MM` 2.5 → 3.0 (globally) and a separate 3.0 mm cluster
  spacing both reduced tree consolidation: on the synthetic corpus the global
  change cost 0.7 pp coverage and the cluster-only change raised standalone
  trunks 47 → 58 (more masts, fewer shared crowns) while losing coverage. The
  2.5 mm guard stays; the reed bed is attacked by consolidation and the root
  merge, not by starving the tree layer. See `docs/dev/backlog.md`.

- **Euler-Bernoulli cantilever & Euler buckling envelope**: auto-bracing braces
  Trunks, not Branches or upper dogleg diagonals, so every unbraced angled
  member is gated by actual green-state photopolymer beam mechanics parameterized
  by its shaft diameter `d`:
  - Guided-cantilever bending (`maxStableAngleForSpanDeg(L, baseMaxAngleDeg, d)`):
    `sin θ_max = (12 π E δ_max d⁴) / (64 F_tip L³)` — short spans (`≤ 8.7 mm` at
    `Ø1.0 mm`) keep the full 45°/30° lean while longer cantilevers steepen as
    `1/L³` and thicker shafts scale with `d⁴`.
  - Euler column buckling (`maxEulerBucklingSpanMm(d)`):
    `L_max(d) = (d² / K) · sqrt(π³ E / (64 · SF · F_return))` (`~11.6 mm` at
    `Ø1.0 mm`, `~7.5 mm` at `Ø0.8 mm`, capped at `14.5 mm` for heavy shafts).
  - If `buildTrunkData` produces an unstable long diagonal during Pass 2a/2b,
    `placeOneCandidate` defers it to Phase 3 rescue (trying a stable steep
    branch, a compact `2.5 / 4.0 / 5.0 mm` silhouette dogleg, or a short
    `≤ 12 mm` cavity bridge first, keeping the routed trunk only as last resort).
- **Brace knots keep a canopy clear.** `BRACE_CANOPY_KEEP_OUT_MM` (2.5 mm)
  below a shaft's top (the contact-cone base) is brace-free: the auto ladder
  skips a link whose anchor lands inside it, and targeted stress braces clamp
  their requested Z to `topReferenceZ - 2.5`. A brace that fuses the terminal
  finger to a neighbour is unrecoverable in post-cure removal; the cone is the
  part that must snap away cleanly.
- **Braces meeting at the same tier share a knot.** Attachment heights
  quantize to `BRACE_RUNG_MM` (0.5 mm) and both brace paths reuse a knot
  already on that segment/height (within 0.05 mm in Z and plan). Two braces
  that meet one trunk at the same rung reference one knot instead of splitting
  the shaft into two near-coincident sub-millimetre segments.
- **A lonely tall spire is buttressed, not thickened.** When the stress
  feedback round lands no brace for a trunk (`noHost` — there is nothing in
  reach to brace against), `buttressTrunkWithKickstand` adds an existing
  Kickstand support from the plate to a host knot below the canopy, with the
  root offset ~0.7 × the rise (~35° from vertical) and eight azimuths tried
  through `buildKickstandData`'s own shape/clearance gate. One buttress per
  trunk, at most `MAX_STRESS_KICKSTANDS_PER_PASS` (2) per round; the log prints
  `Stress buttress`. This is why a solitary column is not left freestanding and
  does not need a diameter step.

- **Three-pass skeleton & 2-level crown build**: `synthesizeTreeClusters` runs a
  batch downward raycast (`computePlateReachability`), then a deterministic
  greedy downward-cone set cover over plate-clear elevated contacts —
  prioritizing primary discrete islands and lower-Z leading edges on slopes —
  while enforcing `MIN_TRUNK_SPACING_MM` (2.5 mm) in organic mode or distinct
  grid intersections in grid mode. In organic mode, tall sparse candidates
  (`Z ≥ UPPER_CLUSTER_MIN_Z_MM`, covering ≤ 2 neighbors) within
  `TWO_LEVEL_BRANCH_REACH_MM` of an already-chosen trunk incur a flagpole
  penalty and are grouped (along with elevated occluded clusters) into
  `upperClusters`:
  - **Pass 2a** builds near-plate overrides and *all* cluster trunk anchors first.
  - **Pass 2b** attaches clustered contacts onto the completed trunk skeleton
    (preferring each contact's assigned anchor trunk). `collectFanShaftPoints`
    resolves every segment through `hostSegmentSpan` so bottom trunk segments
    (rising from the root top with no `bottomJoint`) are available to Pass 2b,
    fanning, consolidation, and rescue.
  - **Pass 2c** builds **2-level `Trunk → Branch → Leaf` crowns** for
    `upperClusters`: one primary angled `Branch` climbs from a nearby trunk to
    the cluster's lowest contact, and `collectBranchFanShaftPoints` samples the
    branch's upper shaft (`t ∈ [0.45, 1.00]`) so close sibling contacts fan off
    as slim 2nd-level `Leaf`s. `hostSegmentSpan` resolves a branch's first
    segment from `parentKnotId`, and `validateAndCullOrphans` propagates culled
    branch hosts to fixpoint so 2nd-level leaves cascade-cull cleanly.
- **Phase 3 plate-first occluded rescue ladder**: vertically blocked contacts
  retry in strict priority order: (1) wide clear-trunk branch search across the
  full skeleton up to `CAVITY_FAN_RADIUS_MM` (12 mm); (2) a collision-free
  2-segment silhouette dogleg trunk via `findOffsetSilhouetteRoute` (12 azimuths
  × 4 radial offsets 2.5 / 4.0 / 5.0 / 6.0 mm across two bend-rise heights,
  selecting the clear route closest to existing trunks for compact bracing and
  verifying against both the SDF and exact BVH `isShaftBlocked` clearance,
  leaving zero extra model scars); (3) short model-to-model cavity bridge
  (`twig`/`stick`, `buildCavityBridge`) only when neither plate route clears.

```ts
const plan = synthesizeTreeClusters(candidates, {
    maxAngleFromVerticalDeg: 45,
    maxReachMm: 8,
    maxAttachmentsPerTrunk: 12,
    minTrunkSpacingMm: MIN_TRUNK_SPACING_MM,
    mesh,
});
```

## Support graph rigid-body & 3D beam frame stress analysis

After auto-bracing completes, `computeAutoSupportPlan` optionally evaluates
whole-frame structural stress on the assembled forest via
`src/supports/autoSupport/supportGraphStress.ts` and records the result on
`ForestReport.frameStress` (surfaced in `forestReportToText`):

- **Public surface**: `buildSupportGraph(snapshot, modelId)`,
  `distributeRigidBodyPeelLoads(tips, totalForceN, copX, copY)`,
  `distributeRigidBodyDragLoads(tips, verticalLoadsN, componentLabels, dragRatio, dirX, dirY)`,
  `biaxialContactStressMpa(normalLoadN, lateralLoadN, contactDiameterMm)`,
  `solveSupportFrameStress(graph, profile, options)`,
  `reinforceOverloadedFrameMembers(snapshot, report, mesh, modelId)`,
  `DEFAULT_SUPPORT_BREAK_STRENGTH_MPA`, types `SupportGraph`, `SupportGraphNode`,
  `SupportGraphMember`, `SupportFrameStressReport`, `FrameStressHotspot`,
  `LayerPeelPoint`, `StressSegment`, `StressTipPoint`, and reactive UI state
  helpers in `src/supports/autoSupport/frameStressState.ts`
  (`getFrameStressSnapshot`, `subscribeFrameStress`, `setModelFrameStress`,
  `clearModelFrameStress`, `getStressOverlayEnabled`,
  `setStressOverlayEnabled`, `getHoveredStressLayerZ`,
  `setHoveredStressLayerZ`, `subscribeHoveredStressLayerZ`,
  `getCachedRepresentativeLayers`), rendered in the
  UI by `src/components/controls/autoSupport/SupportStressPanel.tsx` (which
  debounces live re-solves on structural support edits), as
  line-only 3D stress vectors (`LineSegments2` + hidden supports/raft) in
  `src/components/scene/SupportStressOverlay.tsx`, and as Z-axis peel-force
  bands, the graph-hover Z-slice contour ring, pinpoint overload anchor highlights,
  and the plan-space Stefan adhesion paint (cool/teal/amber by pressure, stronger
  on the peel face and a lighter wash above) on the active mesh via
  `StressForceHeatmapMaterial`
  (`src/features/shaders/mesh/stressForceHeatmap.tsx`). A purely model-to-model
  `twig`/`stick` bridge is outside the plate-load frame, so the overlay draws it
  from the live snapshot in a neutral blue-grey. A bridge whose endpoint
  coincides with a support tip/joint **is** in the frame (next bullet) and gets
  the utilization ramp like any other member.
- **Graph construction**: `buildSupportGraph` collects all plate-rooted shafts
  (`trunk`, `stump`, `kickstand`), hosted members (`branch`, `leaf`), and
  `brace` struts for `modelId` using `resolveSegmentEndpoints`, splitting host
  segments at every hosted `knot` so triangulated X-braced multi-bay frames are
  represented accurately. A knot within `KNOT_MERGE_TOL_MM` (0.5 mm) of an
  existing node welds into it (`internNode` takes a per-call tolerance), so a
  brace knot a fraction of a millimetre below a branch knot cannot split off a
  sub-millimetre "member": a 0.2 mm stub at the 2.2 mm diameter cap measured
  231 % purely because its length/curvature ratio is joint geometry, not beam
  length. A `twig`/`stick` is included when one endpoint coincides with a free
  support node: that end shares the tip/joint, the other model contact becomes a
  fixed `model` node, and the bridge is a real secondary load path. A bridge
  whose both ends are model contacts is omitted — it adds no support load.
- **Rigid-body peel distribution, 3D frame solve & weak-spot reinforcement**:
  - Selects up to 3 global critical layers from `RepresentativeLayerProfile`
    (peak integrated Screened Stefan force, peak `areaJumpRatio · areaMm2`, and
    highest populated layer) plus up to `MAX_COMPONENT_STAGE_LAYERS` extra
    stages: each disconnected support sub-assembly (`tipComponents`, grounded
    through its own roots) that no chosen global layer reaches gets its own peak
    peel and expansion layer. A short limb on its own support tree can otherwise
    sit below all three global picks and never see a load at all. Selection is
    bounded and deterministic, and integrates peel force and Center of Pressure
    from `stefanField` (calibrated against `referenceStefanMeanPressureMm2` and
    `NOMINAL_TIP_PEEL_LOAD_N`), while recording `layerProfile` across all
    sampled representative layers plus per-beam `memberSegments` and per-tip
    `tipPoints`.
  - `distributeRigidBodyPeelLoads` solves 3-DOF rigid-body vertical + moment
    equilibrium weighted by tip stiffness `d²` with an active-set non-negativity
    clamp so compressive tips shed load onto pulling tips.
  - **Lateral drag is a diaphragm problem, not a per-tip share.**
    `distributeRigidBodyDragLoads` applies the layer's lateral total
    (`peelForceN × LATERAL_PEEL_DRAG_RATIO`) through the same 3-DOF rigid-body
    equilibrium weighted by `d²`, so a thin leaf tip does not absorb the drag
    share of the stiff trunk beside it. Tips are grouped by the connected solid
    component of the representative layer's Stefan mask
    (`maskComponentLabels`): a tip in a disconnected island cannot transfer
    shear through material that is not there, so each component carries its own
    vertical share; an unassigned tip stands alone. The rocking metric projects
    displacement along the coherent drag axis, then fits the part's rigid-body
    rotation.
  - **The report now carries the data a corrective action needs, and a planner
    turns it into one.** At the worst-rocking layer, `rockingPair` names the two
    tips at the extremes of the part's fitted rigid-body rotation (the rotation
    lever arms), and `tipDisplacements` holds every free tip's raw
    `(dx, dy, dz)`. The fit is `p = a + θ·(-nx·y + ny·x)` along the drag axis:
    a leaf bending under its own peel share moves its contact locally, but the
    cured part is one rigid layer, so only the fitted rotation is the layer
    shift. The raw max−min of tip displacements reported ~3 mm on prints that
    work; the fitted part rocking on the hand-supported Puck is 0.043 mm.
    `planStressActions` orders the fixes: `brace-rocking` for that pair when the
    fitted differential exceeds `ROCKING_THRESHOLD_MM` **and** a tip or member is
    also over (the rotation is elastic support/resin compliance), `brace-member`
    for an
    overloaded leaf/branch (a cone at its thickness cap needs a shorter span,
    not a thicker tip) and for a trunk over `DEFAULT_TRUNK_BRACE_PCT` (200 %,
    where another diameter step cannot make it stiff enough), and
    `thicken-member` for the remaining trunk/stump/kickstand/brace cases. The
    plain-text printability report prints them
    as `RECOMMENDED ACTIONS`. Tips are deliberately not planned here — their
    capacity pass is `computeForceBudget`, whose add point is the cell's
    furthest point, not the tip's own position. **Execution is wired as a
    batched loop:** `MAX_STRESS_REINFORCE_PASSES` is 2, and each round works
    from one solve, so a run costs at most three beam solves (initial +
    verification) instead of the old four. In a round the loop turns
    `brace-rocking`, `brace-member`, and any `thicken-member` already at its
    diameter cap into `addTargetedStressBraces` requests (a horizontal lateral
    tie at the layer first, the auto-brace 45° link as fallback; knots on both
    host segments, mesh clearance, one brace per support pair) capped at
    `MAX_STRESS_BRACES_PER_PASS` (4). A rocking pair may be farther apart than
    the ladder's aesthetic `maxBraceLengthMm`, so that action carries the pair's
    own span (capped at 60 mm). A member brace attaches at the member's own
    midpoint, not the report's critical layer: the critical layer can sit far
    from the shaft that was measured, and a brace there would split the wrong
    span. When an overloaded member is a leaf, the loop cannot brace it (there
    is no shaft to knot onto): it calls `promoteOverloadedLeaf` to replace the
    leaf with a branch on the same host knot (same tip, new shaft), capped at
    two promotions per round. A refused promotion is counted by reason
    (`buildFailed`, `unstable`, `crosses`) and left alone.
    `debugSkipAutoBracing` disables all of it.
  - **Braces and thickening are batched, not serialized.** Every action is
    applied from the same solve, and a brace does not suppress the diameter
    step: a braced trunk/branch also takes its one thickening step in the same
    batch. Only a promoted leaf is skipped (its old cone no longer exists).
    That combination is what removes the old "brace succeeded, so never
    thicken" residual: a 301 % trunk at 0.71 mm goes to the 1.4 mm cap in the
    same round and verifies at 114 %. A second round runs only when the
    verification still reports overload, so converged models stay at two solves
    and stubborn ones stop at three with the residual in the report. A member
    already at its diameter cap with no legal brace stays over and is reported;
    no fourth solve is spent on it. The frame is never pushed through the old
    brace→re-solve→thicken→re-solve churn.
  - **A trunk whose brace request did not land gets a plate buttress.**
    `addTargetedStressBraces` returns `bracedEntityIds`; `autoPlace` maps the
    remaining request endpoints back to their owning trunks and calls
    `buttressTrunkWithKickstand` for a trunk whose own request is still
    unserved, even when other pairs in the same batch were braced. This is
    per-trunk, so one successful pair no longer suppresses the kickstand a
    different unbraced spire needs. The buttress is one per trunk and capped at
    `MAX_STRESS_KICKSTANDS_PER_PASS` (2) per round; a trunk that already has a
    kickstand is skipped.
  - **A capped shaft gets a longer strut before it is left over.** When a
    member is at its diameter cap and the normal brace search finds no host
    inside the aesthetic `maxBraceLengthMm`, the request carries
    `MAX_CAPPED_STRUT_SPAN_MM` (16 mm). `addTargetedStressBraces` then searches
    that wider plan radius and may place a longer lateral tie; the canopy,
    clearance, angle and one-pair gates are unchanged. If a trunk already has
    one plate buttress, a second opposing kickstand strut is allowed
    (`buttressTrunkWithKickstand(..., { allowAdditional: true })`), capped at
    two. If neither a host inside 16 mm nor a second legal plate azimuth
    exists, the member remains over its limit at the cap and the report says
    so; that residual is a geometric limit, not a missing solve pass.
  - **A capped member can take a model-coupled twig strut.** When a member is
    at its diameter cap and its brace request does not land, the stress loop
    calls `buildCavityBridge` from that member's own contact to the model below
    (capped at `MAX_CAVITY_BRIDGE_MM`, 12 mm). The bridge is added to the draft
    only when it reaches a surface and clears the builder's gates; the graph
    then ties its model end to a fixed node and shares its support end with the
    member tip. This is the fallback for a capped shaft with no brace host. If
    the geometry offers no downward model surface inside 12 mm, no bridge is
    added and the residual stays visible.
  - **A capped member with no working alternative takes one bounded step.**
    The last stage is the cap exception: a member already over its limit at the
    diameter cap gets `MAX_CAPPED_EXCEPTION_DIA_MM` (1.6 mm trunk, 1.5 mm
    branch) through `reinforceOverloadedFrameMembers`' `capOverrides`, alongside
    any brace/strut the batch could still place. It is deliberately not a
    second normal pass: the default caps stay 1.4 mm, only a member that was
    already over at the cap qualifies, and the run logs
    `Stress cap exception: N capped shaft(s) ...`. The step applies to a
    **shaft** overload only. A contact cone is not a shaft segment; thickening
    the shaft cannot reduce it, and raising the cone body would lift its socket
    above the contact tip (the `aboveContact` check tolerates 0.01 mm), so the
    stage declines a cone overload.

  - **The cone stress follows the real taper.** The frame's stiffness keeps the
    effective `0.7 × body` cone member (that is what the plan is calibrated
    on), but the final report re-solves with `taperedConeStress: true` and
    evaluates nine stations along the linear body-to-contact taper with the
    station area/inertia and the internal moment interpolated from the two end
    moments. On `steep-flat-wedge` the effective 114 % becomes **222 % at the
    governing 0.397 mm section**, inside the cone rather than at an end. This
    is report-only on purpose: no brace, kickstand or diameter step changes the
    printed cone, so letting the tapered number drive the action loop would add
    structure that cannot close the load path. The remaining limit is the cone
    **geometry** (contact/taper), not the shaft.
  - **Contact body growth is capped by the socket rim.** Post-placement
    `syncContactConeDiameters` used to follow the host shaft blindly. On a
    leaning contact the socket rim rises by `(body / 2) * leanSin`; following a
    1.34 mm host on an 81° contact lifted Claptrap's cone 0.269 mm over its own
    tip. The body is now capped by
    `maxConeBodyDiameterForContact` (minus 0.005 mm) as well as the host
    diameter. Claptrap's above-contact defect went to zero with the same 1143
    entities and 98.6 % coverage, for 0.9 mm³ less member volume.
  - **The model's plate adhesion is a contact in the same peel solve.** The
    pose's bearing hull is exposed as `plateContactsFromStability`: each hull
    point gets an equal share of `bearingAreaMm2`. `solveSupportFrameStress`
    adds those contacts to the rigid-body peel and drag equilibrium with the
    same area/stiffness model, then applies the support share to the frame; the
    plate share is not charged to a tip. The contact is Stefan-limited: its
    capacity is the mean layer pressure over the footprint
    (`layer.peelForceN / layer.areaMm2 × plateArea`), and any demand above that
    is added back to the support loads. On the snowman test model this is the difference
    between 10,799 % and 1 % member load; on the real models the old support
    loads were charging the plate's job to the tips. The plate capacity is a
    mean-pressure bound, not the full 2D field.
  - **The tip contact check is biaxial.** `biaxialContactStressMpa` compares
    `√(σ_n² + 3τ²)` — the vertical peel plus the layer's lateral drag — against
    the support break strength, so a contact sheared by the diaphragm is counted
    even when its own vertical share is small. Pure peel reproduces the former
    utilization exactly; pure lateral shear counts `√3×`. The FEP interface's
    tensile/shear asymmetry is not measured yet, so this is deliberately
    isotropic and conservative. `peakStressMpa` on a tip hotspot is this
    equivalent stress; `maxTipUtilizationPct` and the peel curve use it too.
  - When grounded free nodes are at most `4500` (`solverMode: 'frame3d'`;
    raised from 1200 because a dense miniature silently fell back to
    rigid-body exactly where member bending decides brace-vs-thicken),
    `solveSupportFrameStress` assembles a 6-DOF per-node 3D Euler-Bernoulli beam
    stiffness matrix and solves `K u = f` with Block-Jacobi Preconditioned
    Conjugate Gradient (iteration cap 350 at ≤1200 free nodes, 500 above) to
    compute tip deflection, combined axial + bending stress
    vs the **bulk** member strength (`options.memberStrengthMpa`, the resin
    datasheet tensile; it defaults to `supportStrengthMpa` for a caller with one
    strength), and Euler column buckling utilization (`hotspots`). The **tip**
    check separately uses the contact break strength
    (`options.supportStrengthMpa`, default `DEFAULT_SUPPORT_BREAK_STRENGTH_MPA`).
    Conflating the two called a 2.2 mm trunk at 14.4 MPa (301 %) broken on a
    print that works: 4.8 MPa is measured on a 0.5 × 0.5 mm contact coupon, not
    on that shaft. With the bulk 24 MPa the same tree reports 60 %. Column
    buckling uses a fixed-fixed effective length (0.5 L): the support is fixed
    into its root disk and cured into the part at its contact. The former 1.1 L
    was pinned-pinned plus an imperfection and put a 1.1 mm × 20 mm trunk on the
    same print at 301 % buckling.
  - `reinforceOverloadedFrameMembers` scales overloaded `trunk` (`≤ 1.4 mm`),
    `branch` (`≤ 1.4 mm`), `leaf` cone body (`≤ 1.3 mm`), and `brace`
    (`≤ 1.4 mm`) members by `clamp((util / 90)^(1/3), 1.10, MAX_REINFORCE_STEP_SCALE)`
    (1.6, so a 300 % member reaches the 1.4 mm absolute cap in one step instead
    of two) with stepped
    `isShaftBlocked` clearance fallbacks, preserves tip `contactDiameterMm`,
    and upgrades host knots before updating `reinforcedCount` and re-solving.
    The caps are deliberate: past 1.4 mm the answer is a shorter span, a
    kickstand or a split, not a fatter pole (and a member never reads fatter
    than the trunk carrying it). `reinforcementDiameterCapMm` exposes the same
    number so the loop and the report cannot drift.
  - **The run closes the loop before it hands over a report.** After bracing,
    `computeAutoSupportPlan` solves the frame, braces/kickstands what is over
    limit first, thickens only what no structural action could fix, and
    re-solves — up to `MAX_STRESS_REINFORCE_PASSES` (3) rounds, stopping when no
    member is overloaded or nothing changes. A single pass left members over
    limit whenever thickening one shaft pushed its neighbour over; the report
    the panel receives is the post-loop solve, with the cumulative
    `reinforcedCount`. Tips that are still overloaded are logged — the contact
    pull-off limit is a placement/diameter question, not something thickening a
    shaft can fix.
  - **Constraints**: entity walks sort deterministically by coordinates so worker
    and main-thread plans produce bit-identical `frameStress` reports; forests
    above the free-node cap fall back cleanly to `solverMode: 'rigidBodyOnly'`.

```ts
const graph = buildSupportGraph(draft, modelId);
const frameStress = solveSupportFrameStress(graph, tractionProfile, {
    areaPerSupportMm2: settings.areaPerSupportMm2,
});
```
## Sizing is empirical, not physics

> [!WARNING]
> **Physics-based sizing was tried and removed — do not reintroduce it.** An area-derived shaft curve **inverted the profiles**: a light 16 mm² cell sized *thicker* (1.28 mm) than a heavy 5 mm² cell (1.12 mm), because the curve rose with cell area. Sizing reads the **band the run's tier resolves to** — the seven numbers (shaft, tip contact/length/penetration, root diameter/disk/cone) of the Support Studio preset `autoSupport.sizingPreset` names — and never the cell's area. `SIZING_BANDS` (detail ≈ 0.8, structure ≈ 1.0, anchor ≈ 1.4 shafts) mirrors what the three factory presets carry and is the *fallback* table, not the source of truth. See the header comment in `parameterSizing.ts`.

**The tier is a Support Studio preset id.** `autoSupport.sizingPreset` is an open id — `detail` / `structure` / `anchor` or any preset the user made, default `structure` — and `activeSizingBand()` resolves it through `getPresetById()`, falling back to the factory structure band when the id names no preset (a deleted one must not fail a run). `smallIslandTipDiameterMm()` and the load budget's cross-section resolve through the same function, so an edited manual preset moves all three together. **This is the accepted cost of the coupling** (see [`backlog.md`](backlog.md)): editing a manual preset changes what auto-support prints. The worker has no storage, so it cannot see a preset the user made: the main thread resolves every band a run can name (`resolvedSizingBandsForRun`) and hands them over in the run request (`AutoPlaceWorkerPayload.sizingBands`), which the worker reads verbatim. The migration rule is one function: `migrateLegacySizingPreset` (in `settings.ts`) maps a band-era block's `sizingBand` back to the factory preset whose band it matches (else `structure`) and drops the obsolete key; a payload without a band comes back as it is. `normalizeAutoSupportSettings` runs it on every block it reads, covering the settings store's own load path and every preset apply, and the auto-support preset store runs the same function as it adopts a payload (`snapshotPresetSettings`) and over an imported file.

Tip contact is the band scaled by underside angle — flat ceilings get the full contact, steeper slopes less — floored at 30% of the shaft so a thick shaft keeps a proportional tip (the forest resize applies the same floor when it later thickens that shaft), and at **0.22 mm overall**: a run never produces a contact below that, whether the band, a preset or the 30% floor asked for one (`MIN_CONTACT_TIP_DIAMETER_MM` in `settings.ts`; `resolveSizingBand` and `sizeParameters` both clamp). Candidates from sub-0.15mm² islands carry a per-point `tipDiameterMm` (detail band, 0.22mm) that bypasses band and floor, so fine detail gets a shrunk tip without dragging the shaft down. Tip length and penetration take the band flat.

**A tip is also capped by the free width of the feature it lands on.** A contact
tip is a rendered disc, and a disc wider than the tooth it sits on does not fit
it: it overlaps the neighbouring teeth and the printed contact smears across
the row. `applyContactTipCaps` (`contactTipCap.ts`) runs in the shared candidate
path — both `generateCandidates` (island emission) and `generateGridCandidates`
(the overhang lattice, which used to take the full band contact whatever it
landed on) — and sets `tipDiameterMm` to
`clamp(min(existing ?? band tip, W × autoSupport.tipContactMarginScale), floor = smallIslandTipDiameterMm())`,
where `W` is the local free width at the contact: the width of the free span
there, i.e. the diameter of the largest sphere that fits in the plane the tip
lands on. `tipContactMarginScale` is a setting (**default 0.9**) — the disc keeps
a *marginal* 5%
stand inside the feature, but the cap is a FIT rule and must not shrink a tip
that already fits: at the old 0.6 it bound for every width under `bandTip / 0.6`
(0.47 mm on the structure band) and floored a 0.28 mm band tip to 0.22 mm inside
a 0.30–0.45 mm feature, a 21% thinner contact for no fit benefit — the other
half of the "supports read a little thin" report. At 0.9 nothing shrinks above
`bandTip / 0.9` (0.31 mm on structure), so the cap only moves tips on features
that are genuinely tighter than the band tip. The margin is the same idea as
`PERIMETER_CONTACT_INSET_MM` on the boundary ring, just less of it.

**A zero reading does not cap.** `localFreeWidthMm` returns 0 when both sides of
the narrower tangent axis read free space beyond the probe reach — a ridge, a
crease or a rim seen edge-on, which is *inconclusive*, not narrow. Capping on it
floored the band tip on evidence the probe does not have (measured: 159 of the
`steep-flat-wedge`/`sloped-cantilever` contacts at a scaled band, every one of
them a 0.5 mm contact dropping to 0.22 mm). `applyContactTipCap` now returns
early on `freeWidthMm <= 0` and only a measured, non-zero width caps.

The width is read from the same `SDFCache` distance field the routers already
use — no second geometry source. The query cannot be made *at* the contact
point: a contact lies on the surface by construction, where the signed distance
is zero for a wide slab and a narrow tooth alike (measured). The probe steps out
along the tangent plane, `CONTACT_WIDTH_PROBE_MM` (**0.5 mm**) each way along
each of the two tangent axes, and reads how far it walked past the feature's
silhouette (`reach - d`); the narrower axis's two sides *summed* is the span the
disc has to fit inside. Summing rather than taking the nearer side is what keeps
the cap a width rule: the nearer-side reading collapses to zero on any
silhouette edge, so it would floor every contact on the rim of a wide face — a
placement-inset problem (the disc hangs over the edge at any width), not a width
one. The reach is also a floor on the reported width (a rim contact reads its
inward side in full) and is deliberately shorter than the ~1 mm pitch a
scalloped surface repeats at, so a probe cannot land on the *next* tooth and
read it as solid ground. A feature wider than the reach reads full width and the
cap is a no-op — the right answer for anything wider than the tip.

The cap only ever **shrinks**: `tipDiameterMm` stays unset when the cap does not
bind, so a candidate with room keeps the band sizing it had (shaft floor, angle
factor and all) and the user's tip setting semantics are untouched.

### Model-scale sizing: three bounded factors over the band

A mini that already prints well and a 250 mm part were both getting the 1.0 mm
structure shaft, because every term in `sizeParameters` was local — the
candidate's own island area, its own height, and the band in the settings. Three
run-level factors now ride on top of the band (`modelSizingFactors`), and the
same three apply to Roots, which keep their ratio to the shaft they carry:

| Factor | Input | Curve |
| ------ | ----- | ----- |
| size | model bbox diagonal (`modelSizeMm`) | `(size / SIZE_REFERENCE_MM)^SIZE_EXPONENT`, ×1 → `autoSupport.modelSizeFactorCap` (default 1.45) |
| load | model weight / support count | `(share / SHARE_REFERENCE_G)^SHARE_EXPONENT`, ×1 → `autoSupport.modelLoadFactorCap` (default 1.3) |
| height | the support's own `zHeight` | `(z / HEIGHT_REFERENCE_MM)^HEIGHT_EXPONENT`, ×1 → `autoSupport.heightFactorCap` (default 1.35) |

All three are monotone in their own input and **floored at ×1**: no factor can
thin a support below its band, so the light end — the band that already works —
is provably untouched, and none can invert a heavier support below a lighter
one on the same input. That is the property the removed area-derived curve
lacked (see the warning above). Direction is physical — a bigger print is a
longer lever, a column's buckling load falls with L², mass per support is a
load share — but every exponent and cap is calibration, not a calculation, and
nothing here reads a force. The three caps are **settings, not constants** (the
`SIZE_REFERENCE_MM`/`SIZE_EXPONENT` pair and their load/height siblings stay
internal), and `autoSupport.modelScaleEnabled = false` pins all three factors to
×1 — the band exactly — for a caller that wants the local sizing alone.

The height/load curve is **capped at the band's own shaft ceiling**
(`curveShaftCapMm`): detail and structure stop at band + `STRUCTURE_SHAFT_HEADROOM_MM`
(0.4 mm → 1.2 / 1.4 mm), while the anchor band keeps the absolute 2.0 mm
ceiling because its job is anchoring, not load-carrying. A tall support on a
large heavy part therefore cannot become a pole; the stress loop shortens its
span (brace) or buttresses it (kickstand) instead. The explicit `sizeScale`
multiplier remains the one term allowed past the curve — it is an instruction,
not a curve.

`ModelSizingContext` is optional on `sizeParameters`: a caller with no mesh gets
the band exactly, which is why the unit tests and the manual-placement paths are
unaffected. The run reads it once, before placement, from mesh volume, bbox
diagonal and the candidate count (`totalCandidates` — an estimate of how many
supports will share the model, since the pillar geometry, including its contact
cone body, is built at placement time; the post-placement forest resize below
only ever thickens). **The run logs all three factors** (`[AutoSupport] Sizing:
… → size ×…, load ×…`) and the panel's Sizing Debug shows them beside the shaft
diameter range, which is where they get fitted to real models. The user's
`sizeScale` master multiplier still rides on top and is the only term allowed
past `MAX_SHAFT_DIAMETER_MM` — an explicit instruction, not a curve.

What is deliberately NOT a factor: **where the support stands**. The spatial
axes are already covered by the local terms — how far from the plate it reaches
(height), how much surface it holds (the area tail), and what it carries after
placement (the forest resize thickens a trunk by its attachments). A second
positional term would double-count those.

Every builder the run calls takes the band through `SizeOverrides` — trunk, branch, leaf, and the cavity `buildCavityBridge` (its sticks and twigs). Each of them reads `input.<field> ?? settings.<field>`, so the Studio preset sizes manual placement only. `buildStick` skipped its overrides once and sized every cavity stick from whatever profile was loaded in Support Studio at the time; if you add a builder to the pipeline, honour the override the same way.

### A hosted member is never a needle beside its host

The three model factors above ride on the **trunk**, which is built from the candidate's own `sizeParameters` overrides; the hosted members are handed the plain band. On a part big enough to scale (`size × load × height`, capped at ×1.85 combined — each factor's own cap is higher, so the product is clamped once) that left a 1.0 mm branch hanging off a 1.5–2.0 mm trunk — the "supports read a little thin next to their hosts" report. Every member build now takes its shaft from `memberShaftDiameterMm(band, hostShaftMm, autoSupport.memberHostShaftRatio)`, which is the band floored at `memberHostShaftRatio` (**default 0.7**, a setting, not a constant) of the host shaft it sprouts from (`src/supports/constants.ts`): the two meet at the knot, so a step is right — a member carries a fraction of the host's load — but not a needle. The floor is a maximum with the band, so a host at the band (the whole light end, and every corpus fixture) is provably untouched; it binds once the host is scaled past `1 / 0.7` (≈1.43 × band).

**0.7 is a measured middle, not a guess.** On the scaled harness (×1.6, host 1.62 mm) the member/host ratio in absolute diameters is: 0.62 with no floor at all (called a *little thin*), 0.65 → branch 1.05 mm, 0.70 → 1.13 mm, 0.80 → 1.30 mm (called *a little thick*). Only ratios that bind need anything else; 0.60 is a no-op because `0.6 × 1.62 < 1.0`, which is exactly why the pre-floor ratio was 0.62. So 0.70 is the point between the two complaints, and it leaves the same ~30 % taper at every host size. (This is a harness measurement of the engine's own output, not a print test — the calibration fields' tooltips say the same about themselves.)

| host Ø at ×1.6 | member Ø, no floor | 0.65 | 0.70 | 0.80 |
| --- | --- | --- | --- | --- |
| 1.62 | 1.00 (0.62×) | 1.05 (0.65×) | 1.13 (0.70×) | 1.30 (0.80×) |

**The floor never costs a placement.** A thicker member can fail the clearance test its band diameter passed, and the first version of this change did exactly that: on the scaled harness it turned 5 consolidation links into `blocked` refusals and cost 2 branches and 1 trunk (a refused candidate degrades to a standalone pillar, which on a real part then culls as `hostBlocked` and strands its members as `missingHost` — the "went sideways" report). `buildHostedBranch` (`autoPlace.ts`) therefore builds at the floor first and, **only if the built member is rejected by the site's clearance gate**, rebuilds at `band.shaftDiameterMm` — the member the pre-floor run placed. The predicate is deliberately the clearance gate alone (build error, SDF collision): the departure angle, the cross check and the host capacity are properties of the chord and the snapshot, identical at either diameter, so they stay where they were. Measured on the scaled harness with the fallback in place, floor-on and floor-off differ in **exactly nothing** but the member diameters — same entities, same fan/merge/consolidation refusals, same orphan counts, same host diameters. Without it the same harness loses 2 branches, 1 trunk and 7 refusals at 0.65, 0.70 and 0.80.

All five branch sites carry it — the merge path, `fanLeafToHost`, `buildConsolidationBranch`, the coverage-stub branch, and the grid attach in `PlacementLogic/Grid/gridPlacement.ts` (which also uses the floored radius for its own clearance check before falling back). `syncContactConeDiameters` applies the same member proportion (`memberHostShaftRatio`, capped at host shaft and floored at the active band) to leaf cone bodies so detail leaves never bloat into full thickened trunk-diameter clubs while keeping solid knot junctions.

This is the member-side counterpart of the forest resize, which runs the other way: the resize thickens a **host** to match its fattest member, the floor thickens a **member** to stay within `memberHostShaftRatio` of its host. Neither can feed the other — a member at 0.7 of its host is never the fattest thing on it, and the host diameter measured identical with the floor on and off.

**Where the thickness actually comes from (finding, not tuned here).** The floor is relative, so it cannot make a forest chunky by itself — it only tracks a host that is already thick. The host's own diameter is the model-scale term: at ×1.6 the harness hosts sit at 1.62 mm against a 1.0 mm band, and with the model terms at ×1 they sit at 1.01 mm (measured: sizeScale 1 → 1.01, 1.25 → 1.27, 1.6 → 1.62, 2.0 → 2.03). A `base Ø1.00 · h1.25 → Ø1.93mm` note is therefore ~×1.55 of model factor, not height alone (the note prints only `h`; see the two findings in the forest-report section). `MAX_SHAFT_DIAMETER_MM` is not the binder anywhere near the reported sizes: at ×2.0 every harness host reads 2.03 mm and none at ×1.6 does — and that ×2.0 is the user's own `sizeScale`, which is allowed past the cap by design. Retuning those factors is a separate decision.

## Desktop scan profile

The desktop scan is fast enough that resolution tricks are not the lever. On
`snowman_01` (506,188 triangles, 0.1 mm / 0.05 mm), the release Rust core
measured:

| phase | time |
|---|---:|
| load + parse | 0.078 s |
| voxel raster | 0.031 s |
| voxel scan | 0.038 s |
| minima scan | 0.179 s |
| overhang classification | 0.064 s |
| stability report | 0.042 s |

The app runs those families concurrently, so the wall clock is the largest
phase (minima) plus load and serialization, not their sum. Re-run with:

```bash
DF_PROFILE_STL=/path/to/model.stl cargo test --release scan_profile -- --ignored --nocapture
```

The 8.8 s figure reported earlier came from the **TS fallback detector** on the
same mesh, not the desktop Rust path. A coarse voxel pass was tried and reverted:
it saved ~0.03 s of raster/scan while coarsening the voxel islands. If a desktop
scan feels slow, profile the Tauri IPC payload and the frontend annotation /
renderer cascade before changing the scan grid; the log shows renderer commits,
WebGL context loss, and `bracing:stress` / `resize:cross-repair` spikes, not the
island arithmetic.

## Rules worth knowing before you change placement

- **A mesh patch is grounded when its top is at the plate, or when it is a shallow
  plate-contact patch.** An overhang region's `contact` is its lowest footprint pixel,
  so the plate-contact filter reading that alone wrote off a domed underside that
  touches the plate at one point and climbs 15 mm: `annotateFilterFlags` marked the
  whole patch `grounded`, the default toggles dropped it from `filteredIslands`
  (exactly what the Auto-Support panel hands the run), and a part resting on the plate
  placed almost nothing while the same part lifted 5 mm got a full forest. Grounding
  now asks the patch's own top (`maxZ`) as well; islands that declare no top (voxel
  sections, minima) keep the contact rule, where the contact *is* the base. A shallow
  plate-contact patch is the exception: an overhang whose top is within
  `PLATE_CONTACT_PATCH_MAX_RISE_MM` (2 mm) of its plate contact is a base with a bevel
  or draft, not a dome — the snowman's 1557 mm² base at 1.5° and 0.908 mm rise is
  grounded. Excluding it raised that model's coverage from 9.7 % to 91.9 %; the
  remaining stress there is a separate load-path problem, not a plate-contact one.
  Contacts closer to the plate than a stump's root height still cannot be served and
  are refused as `STUMP_BELOW_ROOT`
  (`stumpBuilder.ts`), which is the geometry talking, not a policy.
- **A stump's body must clear the model, and no gate in the grid checks it.**
  A type with its own contact override returns from `decideGridPlacement` before the
  trunk collision checks, so a stump used to be placed on the strength of its contact
  alone. Its socket end (the joint ball plus the cone's wide end) sits a fixed
  millimetre above the plate, so an underside that clears the contact could still be
  met by that wide end, and the rendered stump read as a blob with the surface cutting
  through it. `stumpAutoPlacement.ts` now samples the built body's own surface (cone,
  joint ball, root column) against the exact signed distance field and refuses as
  `COLLISION_WITH_MODEL`. The samples are the body's *surface*, not its axis: a cone
  standing under a flat ceiling is tangent there, and an axis sample's distance
  compared against the local radius reads that tangency as an intersection.
- **A huge steep flat is an overhang, not a self-supporting face.** `classify_overhangs` (`src-tauri/src/overhang.rs`) flags down-facing triangles below the self-support angle, then a second pass (`classify_steep_flats`) hands over patches in the `[self-support, STEEP_FLAT_MAX_ANGLE_DEG]` band whose 3D area reaches `STEEP_FLAT_MIN_AREA_MM2` and whose growth stays within `STEEP_FLAT_NORMAL_TOL_DEG` of the patch's running mean normal. The reason is toppling, not peel: a 60° face prints fine by itself, but drag on several square centimetres of it rotates a tall part about its bearing edge, and the only thing that resists is contact along that face — the "whole face plastered as if it were an overhang" a professionally supported leaning plate shows. They arrive as ordinary `overhang` regions, so the density grid, the triangle surface sampler and the perimeter ring apply unchanged. Three constants carry the rule, and all three are tuning knobs rather than physics: the growth tolerance keeps a sculpted face from fusing with its flat part (a crease splits them, so a patch is one face and not every steep triangle that touches it), `STEEP_FLAT_MAX_ANGLE_DEG` is where a vertical support can no longer do anything but graze the surface, and `STEEP_FLAT_MIN_AREA_MM2` is what separates a lever from a facet. The Rust tests derive their fixtures from those constants, so retuning them does not invalidate the rule the tests pin. Known false positive, accepted: a large *smooth* curved surface (a big sphere's 45–75° belt) is locally flat enough to pass.
- **Both steep-flat thresholds stand in for a topple margin, and the margin is now logged.** The angle band and the area floor are proxies for one question — does the moment the peel drag puts on the part exceed what gravity restores? `compute_stability_report` (`src-tauri/src/overhang.rs`) answers it for the same posed mesh: driving moment about a bearing-hull edge is `M_e = Σ A·sinθ·z·max(0, u·n̂_xy)` (face area, angle from horizontal, height above the plate, outward edge normal) and restoring is `ρgV·d_e` from the volume centroid. Both sides carry one unknown constant, so the criterion collapses to a single length: `S = margin / L*` with `margin = V·d_e/M_e` (mm) and `L* = p/(ρg)` (mm, peel pressure over resin weight density). The pose topples iff `L* > margin`. Nothing consumes it yet — it is logged as `[stability] <model>: margin …` by `scan_overhangs`, the one command every model passes through (the sideload path re-classifies there because its triangle ids do not match the rendered geometry, and the client-side fallback has nowhere else to run), and `computeStabilizationAnchors` logs its own `[Stabilization] stable|unstable … bearing … centroid depth …` verdict, so the two can be diffed on real models. **A second verdict is logged beside it, and it is the one that survives a leaning pose.** `L* = p/(ρg)` is metres long at real peel pressures (10–50 kPa against `ρg = 1.08e-5 N/mm³`), so the gravity margin reads "topples" for essentially everything, and every leaning model reports a *negative* margin — the mass is already outside its base, so the comparison carries no information. The force that actually restores a bottom-up print is **plate adhesion**, and it works on the same geometry with `σ` in place of `ρg·H`: `M_adh = σ·A_contact·d̄_e`, the bearing patch's first moment about the tipping edge (`d̄_e` is the *patch's* centroid depth — always positive, unlike the volume centroid's). The pair collapses to one dimensionless constant, `adhesion_ratio = A_contact·d̄_e / M_e`, and the pose lifts iff `p/σ > adhesion_ratio` with `p/σ` of order 0.005–0.05. Both are logged side by side until real prints settle which to gate on. **Diff before swapping the thresholds**: `margin` is infinite when no down-facing face leans, and `0` where a static margin does not exist at all — a bearing locus with no polygon (a point or edge contact) or a mesh enclosing no volume.
- **Zero-area triangles never define the plate plane or the bearing locus.** A genuinely collapsed face (a stray vertex on two zero-area triangles) otherwise puts the 2 mm contact band on the stray vertex alone, and `computeStabilizationAnchors` climbs the defect's own edges instead of the part's base. Both now skip degenerate triangles — the gate tests degeneracy in the *raw* frame (an affine world transform preserves collinearity, so it costs one cross product there), and the report counts them (`degenerate faces ignored (defective mesh)`). A no-op for any mesh without such triangles; it fires on real models (a 505k-triangle part reported 2). **Do not read an odd extent or an empty bearing polygon as a defect without checking the pose**: a 20 mm cube auto-oriented onto its side legitimately measures 30.8 mm tall with no bearing polygon (it touches on a corner), and the report's `centroid_mm` is world-absolute — read it against `plate_z_mm`, not against `height_mm / 2`, which is what made a clean cube look like a broken mesh. The same cube is a clean 12-triangle box on disk, and the loader's `refine_coarse_faces` pass (14 triangles, 9 vertices) leaves its bbox and volume untouched.
- **Gravity is a driving term, not a restoring one.** A bottom-up printer hangs the part from the plate, so in the model frame gravity points +z — away from the plate. It PEELS, and it adds to the drag instead of opposing it: the honest form is `tip iff M_drag + ρg·V·d_e > σ·A·d̄_e`. The report labels it that way (`gravity lever … · peel …MPa (driving, not restoring)`) and prints the term as a pressure so it can be read against `p`: `ρg·V·d_e/M_e`, which is ~1.9e-5 MPa on a 79 cm³ part — 0.06 % of a 30 kPa peel. Negligible, but not zero, and the sign was wrong: the earlier "margin = V·d/M against L* = p/(ρg)" framing was an FDM frame convention. The *binary* verdict survives the flip (a centroid outside the bearing patch peels in either frame), which is why the placement gate has behaved sanely throughout.
- **The bearing patch is the raft's, when there is a raft.** Without one the patch is the hull of the 2 mm contact band, which on a domed bottom is a spherical cap whose CENTRE WANDERS with the tilt while the centroid stays on the axis: a fraction of a degree moves the nearest hull edge past the centroid and flips the verdict (measured on one tool across five tilts: depth −9.43, −10.61, −1.14, +9.98, +10.58, adhesion 0.016 to 0.064). With a raft the printed contact is not that cap at all, it is the raft's footprint, centred under the part. The raft is built around supports that do not exist at scan time, so the report uses the model's **XY shadow** (the hull of its projection, `SHADOW_CELL_MM` quantized) as a lower bound on it: smooth under rotation, and it under-estimates the adhesion, which errs toward covering. The flag comes from `RaftSettings.bottomMode !== 'off'`, threaded from the page into `scan_overhangs` and read directly by `computeAutoSupportPlan` for the gate. The log names which one was used (`raft footprint` versus `band 2.0mm`).
- **Anti-topple coverage is gated on solved Stefan topple risk.** When a layer profile exists, `computeAutoSupportPlan` evaluates `evaluateToppleRisk` before candidate generation against the pose's worst bearing edge and gates both `steepFlatNeedsCoverage` and `computeStabilizationAnchors` (`toppleCoverageNeeded`) via `toppleRiskNeedsCoverage` (`TOPPLE_ADHESION_THRESHOLD_MPA` (0.30 MPa, or `pastEdge` / `rocking`, falling back to `needsToppleCoverage` in `poseStability.ts` when no profile is available). The static "is the centroid over the base" test alone over-fires on bottom-up parts because gravity's peel contribution is tiny relative to plate adhesion, while `measurePoseStability` + `evaluateToppleRisk` share the bearing hull and cover point/edge contacts as zero bearing area.
- **Steep flats are braced, not carpeted.** A large planar face past the self-support angle forms fine on its own, so the density curve — tuned for formation, densest on flat ceilings — overstates what it needs: a `steepFlat` island keeps the density grid but at `STEEP_FLAT_SPACING_MULTIPLIER` (2.5) times the spacing, a sparse field of contacts rather than a lattice, and the topple job goes to `computeStabilizationAnchors`. On a low-poly model that distinction is everything — a 12-triangle plank's 81° side is one 500 mm² patch carrying 84 % of the pose's drag, and gridding it carpets the whole face. The braces are steered by the report the same pass measures: the drag pushes the part over the edge on `pushDirDeg`, so the material that *lifts* is on the far side and that is where the lever arm from the tipping edge is longest — teeth there rank above the rest under the anchor cap, and a lone-point contact stays symmetric because a point has no static margin in any direction. They climb to `dragTopMm` (the highest face that drags) rather than a fraction of the part's height, and a buttress is spaced `BUTTRESS_SPACING_MM` (8 mm) apart, not the 2.5 mm the continuous base line needs. The gate also fires on the adhesion verdict, conservatively (`CONSERVATIVE_P_SIGMA = 0.05`): a part can stand on its base and still lift off it, and the logged ratio is computed from the model's own bearing patch, which is smaller than the printed contact whenever a raft is used.
- **A region carries the drag moment it owns.** `OverhangRegion` reports `drag_moment_mm3` (`Σ A·sinθ·z` over its triangles, `z` above the part's own base — the sum `compute_stability_report` totals for the pose), `drag_dir_deg` (the XY direction its drag pushes the part, i.e. the side that lifts) and `steep_flat` (whether it came from `classify_steep_flats`). A steep face is self-supporting for formation, so contact on it only resists toppling, and the patch's share of the pose total is the constant-free measure of how much of that job it owns — which is the number a placement rule needs to stop carpeting a face that carries almost none of it. A large flat is also the best ANCHORING surface a part has, which is why coverage is not left to the verdict alone: `steepFlatNeedsCoverage` keeps the contacts of any flat at least `STEEP_FLAT_ANCHOR_MIN_AREA_MM2` (150 mm², 3D) whether or not the pose needs rescuing. Size and not share of the drag, because anchoring value is about room: planar, so a contact on it has a well-defined normal and cannot graze; large, so contacts spread instead of crowding an edge; and facing the direction the part would move, so holding it holds the part. The floor is where a flat stops having room for contacts at all (a tip covers ~3mm, so a handful want ~100mm²); above it the band and the spacing make the judgement, so a 465mm² face on a 42mm figurine and a 400mm² face on a 22mm cube both get a low band. An earlier 1000mm² floor refused both.

Anchoring contacts stay LOW (`steepFlatAnchorBandTop`) on a squat part: the lowest third of the flat, or 6 mm, whichever is more. **A slender part is the exception, and the reason is a third failure mode.** Formation, rigid-body toppling and elastic sway are three different problems, and only the first two had mechanisms: a wall tall and thin enough (past `SLENDER_RATIO` = 4 times its own thickness, `height / (volume / footprint)`) flexes under the peel's lateral load while it prints, which is what shows up as wiggling and Z lines on a 126 mm plate 7 mm thick. A contact only stops the sway at its own height, so a slender part's anchoring ladders up the steep flat instead of banding at the bottom, and the spacing between those contacts is capped by the part's own thickness (`steepFlatSpacingMultiplier`). That cap is the physics, not a switch on shape: the rung spacing is a beam span, and the sag between two contacts goes as the span to the fourth power, so it has to stay under the thickness whatever the sparse field would like. A 7mm wall lands at 7mm, a 30mm-thick part keeps the full 2.5x sparse field, and anything thinner than the formation spacing is floored there. The 2.5x exists because a face past the self-support angle needs no formation contact; a swaying wall is the opposite case, and the density moves continuously with the part instead of jumping at a ratio. Both the report (`slenderness` in the log, `height 126.2mm (11.3x)`) and the placement (`isSlenderPart`) read the same ratio. A tip's job is to stop the part moving, and low contacts are short, stiff and cheap, while the reach that resists a topple moment is the stabilization braces' job. Without the band the grid climbs the face, because a near-vertical patch has a thin XY footprint whose cells map up its height, which is how a leaning 20 mm cube sprouted supports two thirds of the way up. Formation overhangs are not banded: they have to hold material at height.

`IslandOverhangOverlay` shows what placement will cover: `scan_overhangs` returns `OverhangScan`, `scanNeedsCoverage` checks whether anti-topple contact is needed, and steep-flat patches that placement skips render muted (`MUTED_OPACITY`) instead of at full strength, per patch, via `steepFlatNeedsCoverage`. Formation overhangs use flat orange (`formationOverhangColor`), while covered steep-flat patches use uniform amber (`steepFlatOverlayColor`) so greedy triangle-growth boundaries never create asymmetric per-patch shading; spatial peel stress lives instead on `StressForceHeatmapMaterial`. `scan_overhangs` logs the top four: `[stability] regions by drag moment (pose total 179063mm³): #2 steep 62° 1180mm² z 8.5-46.2 M 98000 (55%) dir 175° · …`. See `docs/dev/backlog.md` for background.
- **Every member must clear the branch-angle rule — and the gate looks at the shaft, not the chord.** `memberMaxAngleFromVerticalDeg()` derives the steepest lean a member may take from the user's branch angle (`grid.minBranchAngleDeg`, **60° above horizontal** ⇒ ≤30° from vertical) — the same rule the grid attach path enforces through `getLengthAwareMaxAngleFromVerticalDeg`. It bounds every auto path: the placement fan (`min(leafFanMaxAngleDeg, 30°)`), the merge knot search (`STEEP_MIN_RISE_DEG = max(45°, minBranchAngleDeg)`), the routed-branch caps, and the chunk-consolidation relaxation below. `branchDepartureAngleDeg()` then re-checks the **built** branch where it actually leaves the host (knot → first shaft joint): the contact cone is clamped toward the surface normal, so a branch can pass the knot→tip gate and still run out nearly level, bending into a steep cone only at the tip — on a speck field every branch chord read 30° while every shaft left at 42°. A member that would sag is refused and its pillar stays standalone instead. The consolidation routed-branch host pick therefore aims at the *steepest* eligible sample rather than the nearest: the cone bend eats the last couple of millimetres of rise, and reaching further down the shaft buys it back. Before this the fan used 45°, merge 45° rise and consolidation 75° from vertical, and nothing consulted the configured branch angle at all.
- **Overhang pillars consolidate into chunk trees.** After placement, neighbouring ring/infill/standalone pillars (and the reinforcement origin, the one non-overhang host flagged convertible) fan into each other (`CONSOLIDATION_FAN_RADIUS_MM`, 8 mm — an upper bound, not a target, capacity `maxAttachmentsPerTrunk`) — supports release in chunks with one plate contact per chunk. Consolidation asks `fanLeafToHost` for the **nearest** eligible host (`hostOrder: 'nearest'`), where placement fanning asks for the steepest: a chunk link is a local tie between neighbouring pillars, and steepest-in-reach skips the adjacent pillar for a taller one up to the full 8 mm, which reads as a stray 6–8 mm diagonal across the lattice. The consolidation angle is relaxed past the placement fan — `min(max(leafFanMaxAngleDeg, CONSOLIDATION_MAX_ANGLE_DEG = 75°), 90° − minBranchAngleDeg)` — because on a surface sloped <45° from horizontal, neighbouring pillars can never satisfy the placement gate (the link angle is always 90° − surface slope), so chunking would be geometrically impossible. The branch-angle rule still caps the relaxation, so links shallower than it leave the pillar standalone. The chunk's interior hosts carry the load; the links that survive are connective tissue. Same-height pillars (vertical drop < 0.4 mm) never straight-fan; when the straight leaf is blocked, crosses, or the surface is too flat AND the tip sits at ≥ `CONSOLIDATION_BRANCH_MIN_HEIGHT_MM` (10 mm), a **routed branch** attaches it to a host shaft instead — high above the plate that reads as a tree; near the plate it is suppressed (it would read as a zig-zag web). Near-plate contacts (tip Z < `ANCHOR_HEIGHT_THRESHOLD_MM`, 5 mm) place as [stump](../reference/support-anatomy/stump.md) primitives and stay standalone.
- **Grid trunks are fanning hosts only up close.** `GRID_HOST_FAN_RADIUS_MM` (2.5 mm) is deliberately tighter than the general `LEAF_FAN_RADIUS_MM` (8 mm, matching the `leafFanRadiusMm` default/min of 8 mm), so fan leaves do not sweep across the grid forest and puncture its shafts.
- **Long spans become branches, not leaves.** A leaf is a seg-less tapered cone (member-proportioned body → ~0.28 mm contact), so spans past `MAX_LEAF_SPAN_BEFORE_BRANCH_MM` (4.5 mm) route to branches with real shafts in both the merge path and `fanLeafToHost` — measured knot→tip (the span the member actually bridges), not tip-to-host-tip, which understates it when the knot sits low on the shaft. In `fanLeafToHost`, when no legal branch shaft fits below the contact cone (for example a low near-plate contact where `tipLengthMm` consumes the available rise), a secondary slim-leaf fallback is permitted strictly up to `MAX_LEAF_FALLBACK_SPAN_MM` (5.9 mm) rather than spawning a redundant trunk; 6+ mm spikes are never built. **Every origin routes, overhang included.** Overhang fanning used to stay a leaf by rule past the threshold, which is how a merged 11.6 mm tapered spike got built next to its trunk: the threshold is about the *member's* shape, not about which surface the tip touches, and `buildConsolidationBranch` has always built overhang-origin branches. A candidate whose link cannot legally attach gets a pillar of its own — the consolidation pass merges pillars into chunk trees, which is the designed remedy for pillars standing next to fan leaves.
- **A short grid span may lean past the configured angle; the allowance is length-aware.** The grid attach path applies `getLengthAwareMaxAngleFromVerticalDeg` to the **built shaft's first segment** (knot → first joint), not to the knot→tip chord: under 3 mm the configured angle is a floor and the member may lean to 60° from vertical, 3–5 mm tapers back, and past 5 mm only the configured angle passes. **60° is the whole allowance, occupied node included**: an occupied node used to add the socket elbow on top (75° from vertical, 15° above flat) on the argument that refusing the graft leaves the tip unplaced, and that extra is what put a near-horizontal member at a junction. Dropping it costs nothing — the flat-region case, a host standing only as tall as its clearance with tips beside it, is served entirely by the 60° below, and 55° is where the tips start being refused (35 attachments against 60+). A leaf is gated on its own span too, because a leaf is one tapered cone and its chord *is* the member. The knot→tip chord is only a pre-filter, and it has to use the **loosest** allowance that gate can grant (75° at an occupied node, 60° otherwise): measured against the length-aware allowance instead, it dropped knots the gate would have taken, so a tip 3 mm off its host and 1 mm under its top grafted 6 mm down the shaft, because every knot above it had a straight line to the tip shallower than the branch angle while its built shaft left at 31.7° against the 60° it is allowed. It is the same allowance the socket elbow and the short-span detour slack are justified by — a strut under 3 mm leaning to 60° from vertical is mechanically sound. Flat mode needed it because a flat region's hosts are only as tall as the region's clearance, so a tip on a 1.5 mm tip lattice 4 mm from any node could not leave its host at the configured 60° above horizontal: on a 20×20 flat underside, 155 of 224 tips were refused and the region ended at 86% area coverage with 25 lonely pillars. Length-aware, the same fixture is 67 attachments and 99% coverage — the tips still refused are the ones no legal member reaches from their node, which is the rule working, not a gap. `satisfiesMinAngleFromHorizontal` (the flat test) is gone with this.
- **The run reports a load budget, and changes nothing with it.** `computeLoadBudget`
  (`loadBudget.ts`) gives every island a demand in **mm² of unsupported surface** (its own
  area, plus a share of what sits above it by footprint overlap, plus a share of the
  forest's demand by drag moment when the pose's verdict asked for anti-topple coverage)
  and credits every placed support with the area the run's own `areaPerSupportMm2` knob
  assigns one of its island's tier (`SIZING_BANDS`, with `structure` as the baseline; the
  band a run actually sizes with is the one its Support Studio tier resolves to, the same
  for every support of a run). The difference is printed as `Load budget (report only)` in the
  forest report and carried on `ForestReport.loadBudget`. It is deliberately **not** part of
  `--check` and it placed nothing: the point of this step is to see, on real models, where a
  deficit model would add supports and where it would call them redundant, before any of it
  is allowed to decide a placement. Two limits to read it with: it can only allocate over the
  islands it is given, so surface the detector never reported shows up as low coverage rather
  than as demand; and capacity is a knob, not a measurement, until a printed matrix says what
  a tip and a shaft hold. The surplus direction is the one to distrust longest, because
  culling a support is the failure a print cannot recover from.

- **A tip's share of the layer's peel is now a force, and an over-budget tip gets a contact.** `computeForceBudget` (`forceBudget.ts`) evaluates the placed forest on the same representative layers the frame solver uses: `computeLayerPeelForceAndCop` gives each layer's peel force, which is split across that layer's Stefan pressure mask and charged cell by cell to the nearest active tip in plan (the nearest-support / Voronoi allocation of Cao et al. 2025), and each tip's capacity is `support break strength × min(contact area, thinnest section of the tip's own entity)`. The strength is the same derated break strength the frame solver divides by, so a budget reading and a stress reading cannot disagree; the shared host shafts are deliberately not charged here, because the frame solve owns the load path through them. A row above 100% is a contact that would pull off before the layer releases, and it carries the farthest cell point it serves plus the nearest down-facing surface within 3 mm. **Class 2 is eligible:** a self-supporting steep flat (`steepFlat`, at or below the side-wall contact bound) is never a formation target, but joins the surface index as an add target through `collectForceBudgetSurfaces`, so an over-budget cell whose nearest down-facing surface is that flat gets a contact there. Formation adds stay density-grid pillars; class-2 adds are placed through the fan/merge path with the island's exact normal pre-resolved, because a vertical pillar to a leaning face is usually blocked by the part. `computeForceBudgetFromGraph` builds the report from a `SupportGraph` (tip contact diameters, per-entity narrowest member), which is what the plan uses. `FORCE_BUDGET_MAX_LAYERS` (3) bounds the layers evaluated. **The report is carried on `ForestReport.forceBudget` (numbers rounded so two runs serialize identically), and after gap-fill the plan runs up to three add rounds of at most 32 contacts at the worst rows' `addPoint`s through the ordinary placement path** — formation adds first, class-2 adds only if the per-pass budget remains; tip caps, clearance gates and trunk retry still decide whether an added contact can exist. `diagnostics.forceBudgetAdds` records attempted/placed for each class. One limit to read it with: the layer force still uses `NOMINAL_PEEL_PRESSURE_MPA`, so calibrating the saturated separation traction changes that shared constant rather than this module. The budget's demand is the peel field only; the frame solve owns the biaxial peel-plus-drag contact check, because lateral redistribution needs the placed stiffness.

- **Force densification is one geometric pass, not a re-solve loop (Cao et al. 2025).**
  After the budget says which tips are over their break load, the run does not
  re-simulate to choose the extra contacts. `tractionCovering.ts` turns each
  over-budget island's deficit into a contact count
  (`ceil(Σdeficit / tip capacity)`, at least one), builds a Gaussian traction
  density from the deficit tips' demand/capacity weights, and picks new points
  greedily by `density × distance to the nearest existing/chosen contact` — the
  geometric half of the paper's capacity-constrained circle-covering / CVT
  energy, without the CVT solve. Existing tips are fixed; cells within
  `MIN_FORCE_BUDGET_ADD_SPACING_MM` are not candidates, so the pass is additive
  and cannot stack a second contact on the over-budget cell. Formation cells
  become standalone density points; a class-2 steep flat still goes through the
  fan/merge path. The final force-budget report shows any residual, and no
  second frame or force solve was spent choosing the points.
  `FORCE_COVERING_DEFAULTS` holds the Gaussian sigma, weight cap and spacing.
- **A tip the lattice cannot serve is placed without the grid.** Grid mode refuses a candidate whose node is occupied and whose attachment to the host standing there is refused too (two contacts at one height give a branch nothing to rise over, which is the `sameZ` refusal), and those refusals used to drop the tip: the run reported `grid_reject_no_attachment` and the island stayed unsupported. The candidate is now retried with the grid off **for that candidate alone** (`placeOneCandidate(..., ignoreGrid)` → `buildTrunkData`'s `ignoreGrid` → `SmartPlacementV3Context.ignoreGrid`), so it lands as an ordinary free-standing placement beside the lattice instead of nowhere. The retry cannot recurse, since it leaves the grid disabled inside, and its own gates (collision, side-wall cone, attachment angle) still decide whether it places at all. The report counts them as `Grid fallbacks` in PLACEMENT DIAGNOSTICS, which is how a pillar that is off the lattice is explained rather than looking like a bug. Measured on the synthetic corpus in grid mode: 36 tips that were rejected now place, and coverage on the sloped model rises from 92.8% to 98.0%.

- **A contact whose cone renders within 15° of flat is refused.** `isSideWallContact` (`MAX_SIDE_WALL_CONTACT_LEAN_DEG`, 75°) runs on the trunk build at placement, before the grid decision, so it applies to every source — overhang, minima, intersection, and the anchoring contacts on a steep flat. It measures the **rendered cone axis**, not the surface normal, because the cone policy rotates one away from the other: a contact on an 80.8° face is refused under `normal` (80.8°) and kept under `adaptive` (55°). Minima used to be exempt up to 85°, which kept contacts whose cones render sideways; that exemption is gone. A contact past the bound is refused outright rather than served by a leaf or branch, because the cone is the part that reads as a whisker whichever member carries it.
- **A voxel island records that material starts unsupported, not how steep the surface is.** A wall steeper than the self-support angle prints on its own, so a shaft there resists nothing — the "supports on the side of the bow" report. Before candidates, the run asks `resolveSurfaceNormal`; when both vertical rays miss (which is what a side wall does), `closestSurfaceNormal` takes the nearest triangle and its inclination `acos(|n.z|)`. Islands steeper than the setting are dropped. The vertical resolver is still preferred where it hits, so a punched ceiling is not mistaken for the hole's vertical rim.
- **Leaf fanning walks `islandsToCover`, not the raw island list.** The steep-flat gate drops a self-supporting wall when the pose is stable; fanning the raw list bypassed that gate and stuck leaves on the face anyway. Internal islands are skipped here too.
- **A fan link is pre-tested as the member it will become, not as a bare ray.** A leaf is one tapered contact cone from the host to the tip, and a cone is allowed to touch the surface it points at, so the cheap gate asks `contactConeCollides` the same question the orphan validator asks at build time. It used to walk a bare 0.2 mm-clearance ray *to* the tip, which refused every link onto a flat: the tip sits on the surface, and the last stretch of any ray to it is inside the shaft keep-out however steep the link is. A branch is a real shaft, so it is still tested, to a point `FAN_LINK_TIP_INSET_MM` (0.5 mm) short of the tip, because its own collision test runs after it is built. Measured on the dense flat fixture in gridless mode: 976 consolidation links refused as `blocked` before, none after; plate contacts 438 became 208, bare hosts 308 became 0, and coverage stayed at 100%.

- **The fan reaches in plan, and the wide tier only fires when nothing is in reach.** `fanLeafToHost` admits a host sample by its *lateral* distance (`fanRadiusMm`, or `GRID_HOST_FAN_RADIUS_MM` for a grid host), the `vDist ≥ 0.4 mm` rise floor, and the branch-angle gate. The reach is a **plan** distance: run on the full 3D distance — as it was — the drop counts as if it were lateral, so on a tall thin host the samples inside the radius are the ones near its top, which are exactly the shallow ones the angle gate refuses, while the steep sample that would have been legal sits further down, outside the radius. Such a tip found no host at all (`noHost`) or only shallow ones (`angle`), and stood alone as a 1:1 pillar or crossed to the model as a stick — two contact scars where a carried tip leaves one. A tip with nothing inside the normal reach now gets a second, wider search (same plan reach, span capped at `reach / sin(maxAngle)`, so a grid host's rescue stays short), ordered by the **shortest** legal link rather than the steepest: that tier exists to remove a lone pillar, not to add material. Tier 1 is untouched, so every placement that already worked keeps its look.
- **Fanning attaches to segments, not entities.** `collectFanShaftPoints` samples per-segment (`segmentId` + `t`) and `fanLeafToHost`/`buildConsolidationBranch` create knots with `parentShaftId: segmentId, t` — not the entity id. Legacy knots keyed to the entity are rehosted to the nearest segment before `computeForestDiameterProfile` so diameter demands include fan leaves and drift checks use segment geometry. `countAttachmentsOnHost` handles both for backward compat. The host pool, merge search and capacity checks all walk `GRID_HOST_TYPES` — the types declaring `canBeGridHost` — so a second hostable type is offered as a host without a second edit.
- **The merge search reaches in plan, and snaps the knot to the highest legal sample.** `findMergeHost` admits a host by its **plan** distance for the same reason the fan does (above), and unlike the fan it selects only a *host*: the attachment is then snapped to the highest legal sample on that host's shaft (`ATTACH_SEARCH_STEP_MM`, 0.5 mm), so a candidate level with, or above, the host's joints still attaches lower down its shaft. Before either change, two pillars of equal height 2–4 mm apart reported `noHost` — every legal attachment was further down the neighbour's shaft than a 3D ball around its tip reached — and stood as two plate contacts. The knot walk also used to take the highest of 11 fixed fractions of the shaft, which on a 20 mm shaft lands up to 2 mm below the rung it was after: enough to push a member across the 6 mm leaf/branch threshold by sampling error alone, after which the branch path's departure rule refuses it and the whole link falls back to a standalone pillar.
- **A host, and therefore its knots, belong to one model.** The snapshot holds every model's forest and `collectFanShaftPoints` samples all of it, so host selection filters on the host's `modelId`: `fanLeafToHost`, `buildConsolidationBranch`, the consolidation conversion loop and the flat-island stub pass all `continue` when the host belongs to another model. Unfiltered, a run for one model attached its leaves to a neighbouring model's shafts, created knots on that model's segments, and -- worst -- *converted that model's bare standalone pillars into its own leaves* (conversion deletes the pillar). `findMergeHost` is the one path that always filtered.
- **Gap-fill is perimeter-first, not centroid-only.** `buildGapFillCandidates`
  (`coverage.ts`) still adds a contact at each uncovered cluster centroid, but it
  also walks the region's own triangle-accurate `perimeterLoops` at
  `max(1.2 mm, coverageRadius × 1.1)` of arc length and adds one contact at every
  point no tip reaches (`isPlanPointCovered`, with the same influence growth the
  footprint coverage uses), capped at `MAX_PERIMETER_CANDIDATES_PER_REGION` (12)
  per pass. A centroid alone leaves a long flat foot's sole and its toe/heel
  corners bare — the first thing a flat overhang tears — and the arc walk both
  spaces contacts evenly on smooth polygons and visits corners. Regions with a
  tip already covering the middle keep only the uncovered ends.
- **Co-located and mid-shaft close trunks merge across nearby hosts.** After
  gap-fill and before the diameter resize, `mergeNearbyTrunkRoots` dissolves a
  trunk whose plate root stands within `ROOT_MERGE_RADIUS_MM` (3 mm) of a
  taller one **or** whose leaning shaft passes surface-close in 3D — the
  `MID_SHAFT_MERGE_DISTANCE_MM` (1.6 mm) centerline floor, widened to both
  shaft radii plus `MID_SHAFT_MERGE_CLEARANCE_MM` (0.5 mm) so two fat
  near-touching shafts (1.8 mm Ø at 2.2 mm centers) are candidates instead of
  only intersecting ones: its own tip and every hosted
  member's tip are re-fanned onto the primary survivor first (preferring steepest
  legal knots via `fanLeafToHost`, with overflow contacts absorbed by other
  nearby non-consumed trunks if the primary survivor hits capacity or angle/reach
  limits), excluding victim shafts and soon-to-be-removed hosted members from
  crossing checks before removing the victim's members, knots, trunk, and
  unreferenced root. The survivor uses the full `fanRadiusMm` even when it is a
  grid host: the 2.5 mm lattice reach (`GRID_HOST_FAN_RADIUS_MM`) exists to keep
  ordinary placement fans tight, but a merge is replacing the victim pillar, and
  the victim's own members were fanned out to `fanRadiusMm` from its shaft. The merge commits only if *every* contact can be re-served
  without colliding (`contactConeCollides` / `branchCollidesWithSDF` against
  the mesh); a refusal keeps the victim trunk intact and tallies the reason
  (`blocked`, `angle`, `capacity`, `noHost`, `noTips`) in
  `ForestReport.diagnostics.rootMerges` and the text report. Every choice
  (survivor, pair order) is geometric — entity ids are random UUIDs, so an id
  tie-break made the worker and main thread pick different survivors and broke
  plan parity.
- **Auto knot ids must be free in the draft.** `draftAddPrimitive` REPLACES on an id collision instead of failing, and auto knot ids derive from candidate/island ids -- which restart per scan (`v0`/`m0`/`o0`, so two models rebuild the same ids) and repeat across gap-fill passes. A reused id silently re-parents the member that already owned that knot onto this run's host shaft, rendering as a long member reaching across from the other model's structure. `freeKnotId` allocates the free id at every member-creating site: the two fan paths, `buildConsolidationBranch`, and the merge path.
- **Relaxation toward the slope spacing is a last stretch, not a ramp from flat.** `computeRegionSpacing` blends `flatDensityBoost` (0.7 ⇒ ~2× the supports) to `slopeRelaxFactor` (1.3 ⇒ ~0.6×) by the region's angle from horizontal, and it used to blend **linearly from 0°** to the self-support threshold: a 25° underside — a shallow *formation* overhang, which peels and needs the density exactly as a flat ceiling does — took 56% of the relaxation. Only the end of the band prints by itself, which is what relaxation is for, so the ramp now starts at `SLOPE_RELAX_RAMP_START` (0.6 ⇒ 27° at the 45° default) and runs from there to the threshold. It is continuous (the flat value holds *at* the start, so the spacing does not step) and the knob keeps its meaning at the end of the band it names. Measured on the corpus's own 25° underside (`sloped-cantilever`: 215 → 337 candidates, 183 → 313 contacts, member volume 1299 → 2087 mm³) while **every other entry stayed byte-identical** — the 0° ceilings and the 60° steep flat included. That last part is the shape such a change has to have: one angle band moving, not the whole density curve. The consequence to know: below the ramp's start `slopeRelaxFactor` has no effect, because nothing there is a slope in the sense the knob means.
- **Full cross-support interference checks, knot spreading, and active `cross` re-hosting.**
  `leafPathCrossesSupports` and `branchPathCrossesSupports` guard `fanLeafToHost`,
  `buildConsolidationBranch`, and `validateAndCullOrphans` against crossings
  with every support entity class across the forest: `GRID_HOST_TYPES`
  (including bottom trunk risers without `bottomJoint` via
  `hostSegmentSpan`), hosted `branches`, `leaves`, and inter-support `braces`.
  A parent branch skips its own hosted child members via `excludeMemberId`,
  while siblings sharing the same host apply a launch-hub trim and core
  clearance so dense fan crowns do not self-false-trigger on shared parent
  knots. On `'steepest'` placements, `fanLeafToHost` also applies a mild
  angle penalty when multiple attachments share similar Z and azimuth on a
  host so fan knots spread cleanly around the shaft. After
  `computeForestDiameterProfile` and orphan culling (drift >0.5 mm, missing
  host/segment, and `blocked` members culled — only `cross` is kept and
  reported), `computeAutoSupportPlan` actively re-hosts each `cross` member via
  `fanLeafToHost`, trying clearer alternate hosts first and falling back to a
  clearer knot on the same host before re-running `validateAndCullOrphans`.
  Culled leaves/branches and their orphan knots are removed,
  `ForestReport.orphans[]` lists `id/kind/reason/hostId/knotId/detail`, and
  `forestReportToText` emits `ORPHANS CULLED`. This is where the "leaf attached
  to nowhere" (drifted knot after a host trunk’s diameter split) is caught — check
  the report before the render.
  - **A knot must be placed on the same line the drift check measures.** `hostSegmentSpan` is the single resolver for a host segment's world span (root top when the bottom segment carries no `bottomJoint`, contact cone when the top segment carries no `topJoint`), and both the merge knot search and `validateAndCullOrphans` go through it. Do not give either side its own fallback: they used to differ — the search fabricated `(0, 0, rootTopZ)` — and the two lines coincide only for a trunk rooted at the world origin, so every member merged onto an off-origin host was placed beside its shaft and then culled as `drift`. A support that is placed and then silently culled leaves its island unsupported with only a `drift` line in the report to show for it; the members are not re-placed, so the coverage number is the only other clue.
- **Contact resolution is hole-tolerant.** `resolveSurfaceNormal` casts upward from just below the candidate (underside contact), then downward from above (top-surface contact, normal flipped), and walks a small disc of lateral offsets (radii 0, 0.75, 1.5, 2.25 mm) before giving up. A punched drain hole directly above the candidate used to swallow the single upward ray, after which the downward fallback landed on the far side of the wall — in a cavity, on the floor with a flipped normal — and the candidate was rejected outright, so the interior ceiling lost every support the moment a hole was punched through it. A hit below the candidate is never accepted, in either direction.
- **A candidate within `ALREADY_SUPPORTED_RADIUS_MM` (3 mm) of an existing tip is already supported** and is skipped.
- **Twigs test with rays and reach their own length.** A twig is the short model-to-model bridge a cavity fallback places (drop ≤ `stickVsTwigCutoffMm`), and it is the one member whose whole job happens *inside* a thin gap — where the signed-distance field cannot be trusted: it signs from the nearest triangle, and in a gap between two facing faces the nearest one changes across the gap, so the empty space reads as material (measured: the midpoint of a 1.5 mm gap between a header and the body reports −0.75 mm, "inside"). Every SDF gate therefore refused twigs by construction, automatically and by hand. `buildTwig` and the cavity path check twigs with `checkShortBridgeCollision` — ray casts, which need no sign — and that check is *inset* from the sockets, because a socket sits on the surface it touches and a whisker offset from it starts inside the material (which refused every canted twig). The cavity search also reaches sideways as far as a twig may span (`stickVsTwigCutoffMm`, radii 0.75 mm steps out to the cutoff) so a pointed tip can be propped off the surface beside it; a member found that way must be a twig — sticks keep the near search and their near-vertical gate. Larger members (sticks, trunks, branches) keep the SDF: their clearance question is genuinely three-dimensional. **The twig's verticality gate lives in its registered builder** (`Twig/twigVerticality.ts`, `MAX_TWIG_SHAFT_ANGLE_DEG` 45°, enforced in `twigRegistration.ts` beside the stick's 20°): the gate measures the *built shaft* (socket to socket), because a sloped or sidewall landing's standoff is what shoves a grazing twig sideways, and past that cant the member is a near-horizontal whisker hanging the island off a strut that carries no load. It used to live only in the cavity fallback, so a twig built anywhere else — the manual bridge controller, any future path — slipped through with no gate at all. Measured: thin-gap and floor twigs build at ≤17°, pointed-tip props off a wall with a real drop land 23–43°, and the grazers start at 48°.
- **The cavity fan is the widest host search, and its refusal carries the numbers.** A tip with no plate route (`buildTrunkData` → `COLLISION_WITH_MODEL`) is first offered to a nearby host at `CAVITY_FAN_RADIUS_MM` (12 mm, plan) — the same reach for a grid host, because the 2.5 mm grid limit exists to keep ordinary fan leaves from sweeping across the grid forest and that reason does not apply to a tip whose only other outcome is a model-to-model bridge with a second contact scar on the model. The log line `noHost` alone cannot say whether there was no host or only a far one, so `fanLeafToHost`'s failure returns `nearestHostMm`, `nearestSteepMm` and `steepAngleDeg` and the report prints `fan:noHost (nearest 11.7mm plan, no legal host)` or `… (nearest 3.4mm plan, nearest legal 13.5mm @ 29°)`. Read it before tuning any reach: it separates "nothing is close" from "something is close but only at an illegal angle" from "the host is there but the link runs through a wall". **This search also passes `rescueSpanOverrideMm: Infinity`.** The wide tier's derived cap (`reach / sin(maxAngle)`) is right for ordinary placement, but a cavity tip is usually at the TOP of its feature, with the nearest host close in plan and low — so every sample that clears the angle gate makes a long link, the cap refuses all of them, and the tip becomes a stick. An observed case read `noHost (nearest 2.2mm plan, no legal host)` with the host 2.2mm away and 28.6mm below. Since the wide tier takes the shortest legal link, lifting the cap spends no more than that geometry forces, and the result is a near-vertical branch (one contact scar) where the stick had two.
- **Cavity fallback: bridge down, then just off vertical.** A tip with no plate route (`buildTrunkData` → `COLLISION_WITH_MODEL` — e.g. the ceiling of a hollow model's cavity) is first offered to a nearby host, then bridged model-to-model by `buildCavityBridge`: a downward raycast finds the surface below and the drop chooses a stick (`> stickVsTwigCutoffMm`) or a twig. The cast walks a small disc of verticals around the tip (radii 0, 0.75, 1.5, 2.25 mm, nearest radius first) rather than one straight-down ray — a punched drain hole or a gap directly under the tip used to swallow the single ray and leave the contact with no support at all, which is what "no supports inside the cavity once holes are punched" was. `MAX_SHAFT_ANGLE_DEG` (20°, in `stickVerticality.ts` — the stick's registered bridge builder applies it) caps the cant and the post-build shaft check rejects any bridge that pierces the model, so the wider search cannot produce a crooked stick. Twigs get the same shape of gate from their own registered builder (`Twig/twigVerticality.ts`, `MAX_TWIG_SHAFT_ANGLE_DEG` 45°), which no longer lives in this path.
- **A shaft may not thread a hole into the cavity.** The mesh collision tests
  cannot see this: a drain hole or bore is open space, so a pillar routed
  through it is geometrically clear. A built trunk is checked in
  `placeOneCandidate` before it is committed (`rawCavityPaths`, because the
  trunk is not in the draft yet and `hostSegmentSpan` cannot resolve its root
  there) and a crossing is treated like `COLLISION_WITH_MODEL`: the same
  fallback ladder runs — cavity fan onto a nearby host first, then
  `buildCavityBridge` — and each re-planned member is itself checked against
  the cavity before it is kept. Only when neither can serve the tip without a
  new crossing is the candidate rejected (logged as
  `CAVITY_SHOOT_THROUGH`) and counted as `trunk_build_error`.
  `validateAndCullOrphans` still tests every host path and hosted member after
  the forest is built, as the safety net for members created by passes that do
  not go through `placeOneCandidate` (consolidation, merge, gap-fill retries):
  the path is sampled every 0.75 mm, and if any sample is strictly inside the
  cavity void while a terminal is outside the cavity side of the wall, it is
  culled as `cavityCrossing` (a culled host cascades to its members as
  `missingHost`, as with `hostBlocked`). A member wholly inside the void is the
  intended cavity support — its terminals sit on the cavity wall, which
  `isOnInteriorSide` accepts — and a member wholly outside is an ordinary
  support.
- **An internal contact may only bridge inside the cavity.** Before candidates are generated, the run classifies every island against the cavity mesh the Auto-Support panel hands the worker (`getCavityGeometry` → `cavityMesh` in the payload): the cavity mesh is part of the hollowed model mesh, so an interior contact lies **on** it (within 0.15 mm) while an exterior contact is at least one shell thickness away (minimum 0.2 mm). Distance is normal-agnostic: a winding-convention mismatch cannot invert the answer. Such a candidate carries `interior: true`, skips the plate trunk and the cavity fan entirely, and is placed only by `buildCavityBridge` — or rejected. Interior grid regions also use `INTERIOR_CAVITY_SPACING_SCALE` (3) times the normal spacing — one ninth the contacts — and coverage convergence skips them: a short model-to-model bridge carries less peel than a full-height pillar, and the dense cavity forest was hard to see and remove. Before this, a hollow part with a bore or a floor opening gave the router a legal plate route, and supports ran from the plate through the cavity and out through the shell: the "internal supports shoot through the model" report. The fanning pass skips `interior` islands for the same reason.
- **Flat-island coverage is stubs, not bridges.** Flat voxel islands (everything the grid phase does not own: `source !== 'overhang'`) get stub branches from the trunks standing under them. The pass walks the island's 2.5 mm cell grid; each cell goes to the **nearest trunk within `leafFanRadiusMm` laterally**, and the cell is skipped when no trunk is that close — those spots belong to the pillar paths. Two earlier shapes are closed: walking *trunks* and stamping the island's whole bbox from each of them (10–24 mm near-horizontal branches from one host, straight across whatever stood between — through a hole into a cavity), and knot ids that omitted the trunk, so each writer overwrote the previous knot and every earlier branch re-parented onto whichever trunk wrote last (the "dozens of members on one host" that no capacity check could explain). Each tip takes its Z from the cell's own footprint voxel rather than the island's single contact Z, so a stepped island no longer hangs tips in air, and a stub that would pierce the mesh (`branchCollidesWithSDF`) is skipped like every other member-creating path.
- **Gridless runs still merge**: candidates within `GRIDLESS_MERGE_RADIUS_MM` (4 mm) of an existing trunk join it. Among in-radius hosts, `findMergeHost` ranks by distance plus `MERGE_HOST_LOAD_WEIGHT` (0.5) × longest already-hosted member span — nearer wins, but merges avoid piling long members onto one plate anchor (Dumas gain shape). No hosted members → pure nearest-first.
- **The collision predicate answers for a lattice point, not for the point you asked about.** `SDFCache.segmentBlocked` and `distanceAt` quantize the query to a 0.5 mm cell (`quantizeToCell` rounds) and return the signed distance at that cell's lattice point, so the value can be wrong for your point by up to the distance between the two. Anything using it as a *bound* must subtract that distance first, which `segmentBlocked` now does: it settles `clear` above `base - gap`, `blocked` below `base + gap`, and asks a point-exact bounded query between them. Skipping that is what let the march jump over geometry inside `clearance` — a column 0.5976 mm from the model at clearance 0.7 mm came back clear, so a routed support could clip the model. Do not verify a predicate with `distanceAt` either: it is quantized the same way, and reported 0.798 for a point that was 0.598 mm from the surface. The residual approximation is the `minStep` floor, so `blocked` from `ColumnClearanceMap` can still exceed the march's by one probe in ~2800 — see `docs/dev/backlog.md`.
- **Trunk routing is one diagonal and one drop, and the cone follows the shaft.** Placement goes through `calculateSmartPlacementV3` (`PlacementLogicV3/SmartPlacementV3.ts`), whose entire search is `EscapeJointSearch`: walk outward from the socket along a 45° ray in each candidate direction until the column below clears and the roots volume fits, then stop, so the trunk is a single diagonal, a single joint, and a vertical load-bearing span. The lean is 45° from vertical and does not escalate: a flatter leg cleared a wide obstacle below the tip by laying a flat member across the gap, which is a strut rather than a support, so a contact the shape cannot serve takes a pillar instead. The joint count stays at one. Multi-joint chains, lattice searches and contour-following routes are gone and should not come back: a vertical pillar is the strongest support, so the router's only job is to find the earliest point where vertical becomes possible and get there in one move. `resolveConeSocketAndAxis` resolves the socket and the cone axis as one decision, so the builder renders the direction the router picked instead of deriving its own, and the socket is placed on that axis. See [Support Pathfinding V3](support-pathfinding-v3.md).

## Real-model harness

The synthetic corpus is for placement regressions. Real parts are measured with
the same runner, from a directory of models:

```bash
npm run bench:real-models -- --corpus ~/models
```

`--corpus` reads every `<name>.stl` in the directory. An optional
`<name>.islands.json` beside it supplies the **app's** island set (the serialized
`DetectedIsland` array; `contact` is `{x,y,z}` and `contactVoxels` may be plain
number arrays). The Islands panel's download button writes exactly that file
(`exportIslandsToJson` in `src/volumeAnalysis/Islands/exportIslands.ts`) from
the same `structuralIslands ?? filteredIslands` set the auto-support run uses;
the desktop app opens a native save dialog and the filename is
`<model>.islands.json`. With no JSON the harness falls back to the in-process voxel
detector, which finds detached starts but not the Rust overhang/minima family;
that set can under-represent real overhangs and can leave a model unsupported
even though it prints with the app. Use the JSON for a measurement that
corresponds to what the app places.

The real-model script adds the frame solve to the ordinary table:

- `member %`, overloaded member and cone counts, `tip %`, tip overloads,
  rocking and deflection, and the worst hotspot with its Z section.
- `--fail-on-overload` exits non-zero when any committed run has an overloaded
  member (cones included), for a batch gate.
- `--stress` is implied by the npm script; the plain
  `bench:auto-supports` table remains placement-only.

Detection runs the app's scanline worker in-process. The stand-in now dispatches
one message at a time on a task: synchronous replies nested one stack frame per
layer and overflowed at 960 layers on a 49 mm part, and a microtask alone let
the process exit between layers. The queue also keeps first-message ordering
(the worker script must run before its first init message).

Measured on a real 3DBenchy STL with its own overhang islands supplied as JSON:
150 candidates, 222 entities, 92.4 % area coverage, 25 cross orphans, and a
frame solve at **327 % max member** (24 overloaded, 2 cones) — the kind of
result the synthetic corpus cannot produce because its overhangs are authored
to pass.

## Timing a run

Every run logs where its time went, one line plus a detail line:

```
[AutoSupport] Timing: 241ms total — candidates 38ms · dedup 5ms · support-filter 1ms ·
  placement 67ms · consolidation 70ms · gap-fill 0ms · analytics 15ms · fanning 0ms ·
  surface-coverage 0ms · resize 15ms · report 1ms · bracing 29ms
[AutoSupport] Timing detail: trunk:v3-placement 38ms/100x · branch:cone-search 17ms/28x
```

- Grep `[AutoSupport] Timing:` in `dragonfruit.log`. The phases are the pipeline's
  own boundaries, in order, so a surprising number is read the same way a
  profile is: `placement` is the per-candidate loop, `consolidation` is the
  chunk-tree pass, `bracing` is `buildAutoBracedSnapshot`, and so on.
- The detail line is the *inner* work the perf module already measures
  (`trunk:v3-placement`, `branch:cone-search`, `grid:collision-check`, …), summed
  by label with its call count. Those nest inside the coarse phases, so the two
  do not add up to the total between them.
- The detail line also carries the router's own stages (`router:standard`,
  `router:cone-gate`, `router:roots`, `router:base`, `router:joint-search`), so a
  placement that is slow overall is attributed to the stage that spent it.
- A third line reports what the *router* asked for, which is where a
  routing-heavy run spends its placement time. The cost of a placement is the
  number of questions, not the cost of one answer:

  ```
  [AutoSupport] Timing router: 2073 placements · per placement 50.0 cones (25.0 gated) ·
    0.1 joint searches (6.0 probes) · 1.0 roots checks (1.0 samples) · 0.0 base candidates
  ```

  `cones` are the straight drop plus its deviations, tested once for a straight
  drop and again as socket candidates for the joint search; `gated` is how many
  of those reached the distance field, so a ratio near 2:1 means the memo is
  doing its job. `joint probes` are the escape search's SDF probes, the unit it
  is held to, and the outcome tally after the dash says how those searches ended
  (`never-cleared` means no column inside the envelope, `probe-budget` that the
  walk ran out first — the two call for opposite fixes). A `found within` tally
  follows when any search succeeded: how many probes those actually needed,
  bucketed by powers of two. Everything to the right of a bucket you cut at
  turns into a pillar instead of a routed support, and nothing else changes, so
  that tally is the price of a smaller budget. `roots checks` are the
  root-volume fit tests (`samples` are the SDF queries inside them; 1.0 means
  the bounding-ball early-out settled each slice).
- A fourth line reports the distance field itself:

  ```
  [AutoSupport] Timing field: 12.3M cell reads · 480k BVH queries · 660k cells cached
  ```

  `cell reads` is the router's probe volume (it walks a long column per probe),
  `BVH queries` is the part of that which was new geometry work rather than a
  cached answer. A high query count with a high per-query cost is the shape to
  watch: `cells cached` names the store that answered (`table`, or
  `table+map` once the table filled), and the query count is the one to attack —
  a run's first-time cell computations dominate everything else. The march
  bounds its BVH query at `MARCH_DISTANCE_BOUND_MM` (see
  `SDFCache`), and an unbounded traversal on a sculpted part measured 17 us per
  cell against 0.2 us bounded. A cached value at or beyond that bound means "at
  least that much" rather than an exact distance — every caller compares against
  a clearance of a few tenths of a millimetre, so the cap never changes a
  verdict, and caching it is what keeps far cells from being re-queried on every
  visit (4.5M queries against 1.6M for one run). A high read-to-query ratio means the cache is doing its job and
  the cost is the walking; a low one means the field itself is being computed
  over and over, and the near-field gates (`isContactConeBlocked`, which cannot
  use the quantized cache) are the place to look.
- **The two long phases hide sub-steps.** `resize` covers the diameter
  profile, post-resize validation, orphan re-place, cross repair and cone sync;
  `bracing` covers both `buildAutoBracedSnapshot` and the whole stress
  feedback loop. The detail line now carries the split: `resize:profile`,
  `resize:validate`, `resize:requeue`, `resize:cross-repair`,
  `resize:cone-sync`, `bracing:auto`, `bracing:stress`. Read those before
  optimizing a phase by name.
- **Cross repair is local-first and bounded.** It tries another legal Z on the
  member's existing host first; only then a nearby host (8 mm) and at most
  `MAX_CROSS_REHOST_REMOTE_ATTEMPTS` (8) forest-wide attempts. Every remote
  attempt can build a branch cone, and the old unbounded forest pool made this
  the dominant resize cost. Unresolved `cross` orphans stay flagged in the
  report rather than paying for a sweep; the flags are the knob if a model
  needs more repair.
- The same data is on `result.analytics.timings` (`AutoPlaceTimings`), which is
  what the worker path logs: the worker's own `console` output never reaches the
  log bridge, so the client prints the timing it got back.
- A spike line appears when an *inner* operation exceeds its threshold, and it is
  a *summary*: count, worst, median, top five. On a big model hundreds of
  placements exceed any per-call threshold, and listing them buried the lines
  above. The coarse phases are excluded for the same reason; `trunk:v3-placement`
  carries a 120 ms threshold because a placement is tens of milliseconds by
  nature, so what is worth seeing is the outlier.
- In the app, `window.__dfPerf` exposes the same frames interactively
  (`__dfPerf.summary()`, `__dfPerf.dump()`), installed by `page.tsx`; see
  [Auto-Support Worker](auto-support-worker.md) for why it is not installed by
  `pathfindingPerf` itself.
- One caveat: `perfEndFrame()` closes the frame at the end of a run, so inner
  measurements taken outside a run (a manual placement) are attributed to the
  next run's detail line.

## Settings and reporting

`settings.ts` declares roughly twenty knobs with `AUTO_SUPPORT_CONSTRAINTS` giving each a min/max/step/default — including two debug switches (`debugSupportOriginColors`, `debugSkipAutoBracing`, the latter for faster iteration). Use `normalizeAutoSupportSettings` / `applyAutoSupportSettingsPatch` rather than building the object by hand.

### The settings dialog, by question

The dialog is organized by the question a user is asking, not by pipeline phase. It is **one scrolling surface** — there is no tab row and no rail — with the policy sections as field cards in reading order: `Detection` — `Distribution` — `Density & Sizing` — `Stability` — `Post-processing` — `Diagnostics` — `Advanced (calibration)`. **Every card is visible**; there is no disclosure in the dialog at all. Compact fields are what make that possible: with a labelled input per knob instead of a slider, the whole policy fits in one scroll, so a second navigation surface would only be another way to reach something already on screen. Three files hold the contract:

- `src/components/controls/AutoSupportPanel.tsx` is the shell: the run button, the island counts, the preset row, and the dialog's chrome (backdrop, panel, header, Escape registration).
- `src/components/controls/autoSupport/AutoSupportSettingsBody.tsx` is the dialog body — the preset strip, the seven cards and the commit bar. It is deliberately store-free: it takes the draft it edits plus the last run's diagnostics as props, which is also what makes it testable without a DOM. The only store reads in the dialog belong to the preset strip (`AutoSupportPresets.tsx`).
- `src/components/controls/autoSupport/autoSupportPanelTabs.ts` is the catalogue: `AUTO_SUPPORT_SECTIONS` (and `AUTO_SUPPORT_POLICY_SECTIONS` for the cards, `AUTO_SUPPORT_ADVANCED_SECTION` for the disclosure), plus `KNOBS_BY_SECTION` and `TOGGLES_BY_SECTION`, are the single place the control-to-section mapping is written down, and `ADVANCED_CALIBRATION_KNOBS` / `ADVANCED_CALIBRATION_TOGGLE` are the calibration fields. Move or add a control there, never by editing the body's JSX.

#### The field idiom

Every control is a field of the same shape, the one the material editor's cards use:

- a card per section, with an **uppercase header** (`ui-meta font-semibold uppercase tracking-wide`) carrying the long tooltip as its `title`, and a one-line description under it — except the calibration card, which has no description (its subtitle is optional in `AutoSupportSectionDef`);
- a **label + ⓘ row** — the ⓘ is `FieldHelpTooltip`, and the same help text is also the field's own `title`;
- a **2-column grid of full-width fields**, so a section's controls read as a block. The cards are plain grid items, so they **stretch to their row's height** — the anti-aliasing section's idiom (`profileFormAtoms.tsx`), which is what keeps a short card from leaving dead space beside a tall one;
- **no sliders anywhere**. A numeric knob is `LabeledNumberInput` (the material editor's stepper field, up/down carets), with its **unit inside the field** — right-aligned in the space the carets leave, the Support Studio convention — so the label is the name alone: `Min Island Size` reads as the field's label and the field itself shows `mm²`. A unitless knob passes none; the carets' accessible names still carry the unit. A boolean is `LabeledToggleInput` (the pill switch);
- the sizing tier is a **dropdown of Support Studio presets** (`AutoSupportSizingTierField`, its own module because it is the one place the dialog reads the other store), factory first with `Built-in` / `Custom` on the right; choosing one writes its id, and the run resolves the band from that preset's own tip, shaft and roots. There are no band fields anywhere: the numbers live in Support Studio, and the tooltip says so;
- the panel's own clamp: `AUTO_SUPPORT_CONSTRAINTS` is what the store enforces on write, but the field offers the range the slider used to, rounded to the decimals its step implies, so a typed number cannot land somewhere the dialog would never have offered.

| Section | The question | Settings it owns |
| --- | --- | --- |
| Detection | what needs support, and how tightly detections merge | `enabled`, `prioritizeIntersection`, `minIslandAreaMm2`, `tipInfluenceRadiusMm` |
| Distribution | where a region's contacts land, and how far members fan from a trunk | `leafFanRadiusMm`, `leafFanMaxAngleDeg` |
| Density & Sizing | how many, how thick, and which Support Studio preset sizes them | `sizingPreset` (the tier dropdown, a Support Studio preset id), `areaPerSupportMm2`, `sizeScale`, `gridAreaThresholdMm2`, `flatDensityBoost`, `slopeRelaxFactor`, `suctionAreaExponent` |
| Stability | will the part stay put and stay straight | `overhangSelfSupportAngleDeg`, `stabilizationEnabled`, `minimaReinforcementEnabled` |
| Post-processing | the passes after placement | `maxAttachmentsPerTrunk` (which also caps chunk consolidation), `coverageTargetPercent` |
| Diagnostics | the debug switches, and the switch that shows the run's report on the panel | `debugSupportOriginColors`, `debugSkipAutoBracing` (the **diagnostics**: applied the moment they are flipped, never dirty — see below), `debugSimpleSupportRender` (a top-level `SupportSettings` key, not under `autoSupport`, toggled through `updateDebugSimpleSupportRender`), plus `Debug Mode`, which is **panel state, not a setting** (see below) |
| Advanced (calibration) | the sizing constants the engine ships with, in the warning tone | the six calibration keys |

`Diagnostics` is a card like any other — its debug switches (`Origin Colors`, `No Brace`, `Simplified`) are on screen without opening anything, and `Debug Mode` is a cell of the switches' own grid, the one beside `Simplified` (a `LabeledToggleInput` pill, the same shape as its neighbours, so the row stays even).

**The diagnostics are not edits.** `DIAGNOSTIC_AUTO_SUPPORT_KEYS` (`src/supports/autoSupport/settings.ts`) is the list, and it is a three-way decision about how the key behaves:

- **They apply at once.** `updateAutoSupportDiagnostic` writes the store the moment the pill is flipped, so the scene shows the effect while the dialog is still open. They are read back from the store (`diagnostics` is a prop, not the draft), and the panel mirrors the value into the draft so a later `Save` cannot write the old one back.
- **They never dirty anything.** `isAutoSupportPresetDirty` and the dialog's `useAutoSupportDialogChanges` both compare `autoSupportPolicyDiffers`, which skips them, so closing the settings dialog does not ask whether to discard a view switch and the active preset never reads as modified because someone looked at the forest.
- **They are still saved.** A full `Save` carries whatever the switches hold, like any other key; only the *dirty* question ignores them. `Reset` reloads the draft from the store after applying the active preset, so it also returns the diagnostics to that preset's values.

A debug switch added to `TOGGLES_BY_SECTION.debug` without being added to `DIAGNOSTIC_AUTO_SUPPORT_KEYS` fails `autoSupportPanel.test.ts` rather than silently reverting to the staged behaviour.

`Advanced (calibration)` is the last card and spans the full width of the grid (its six fields lay out two per row inside), **framed in the app's warning tone** instead of hidden (`#d97706` mixed into the border at 36 % and the surface at 92 % — the material modal's official-profile banner) so it reads as the tuning constants rather than another preference. Its content is the six fields, directly on the card: no callout, no disclosure caret, no Reset action, no default sub-labels — each field's tooltip names the value the engine ships with and what it does. **Do not call these values measured**: they were tuned by hand from how the engine behaves, never validated against a printed result; the values are stored per preset, so the footer's `Reset` and picking a built-in are the ways back.

#### React Compiler and the store getters

The store getters that take no argument (`getActiveAutoSupportPresetId`, `isAutoSupportPresetDirty`) **must be read through `useSyncExternalStore`**, never called straight from render: React Compiler treats a bare call to an imported function as pure and evaluates it once, which freezes the value at whatever it was when the component mounted. That is a frozen preset name in the selector and a dirty strip that never clears — and it looks like a store bug. The settings snapshot the flag depends on needs its own subscription beside it, since a knob edit is what changes the answer.

### Presets are the run policy, and a separate system from Support Studio

The preset UI is the UI for `src/supports/Settings/autoSupportPresets.ts` (see [Auto-Support Presets](auto-support-presets.md)), in `src/components/controls/autoSupport/AutoSupportPresets.tsx`. It is the LUT curve editor's shape (`src/features/slicing/components/LutCurveEditor.tsx`), which the user picked over both a management sub-modal and an action bar:

- **The strip is one row.** The `SelectDropdown` lists presets — built-ins first, then the user's own, each row carrying a right label (`<tier name> · Built-in` / `<tier name> · Custom`, the tier being the Support Studio preset the block names, resolved by `sizingTierName`) and the active one ticked — with `Rename`, `Duplicate`, `Export` and `Import` beside it and nothing else (the LUT's row, 1375-1398). Row styling and right labels follow that selector and the theme profile dropdown (`src/components/settings/UISettingsTab.tsx`).
- **The menu carries one entry** under the presets: `New` (`menuFooterAction`, plus icon, accent tone — LUT 1359-1364, themes 297-301). `Rename`, `Duplicate`, `Export` and `Import` are in the row beside the trigger, so nothing management-shaped lives in the menu.
- **The footer is the LUT's** (1498-1532): `Delete` alone on the left in the LUT's own filled-danger treatment (1498-1511), greyed out for a built-in, then `Reset` and `Save` on the right. The LUT's `Reset` restores the draft from the snapshot taken when the editor opened (`handleResetDraft`, 1043-1052) — it *discards uncommitted changes*, it is not a factory restore — and its `Save` commits the draft (`handleSave`, 1035-1041). Both are disabled until there is something to discard or commit. Ours map as: `Reset` reloads the active preset over the dialog (discarding the draft), `Save` commits the draft — one call, `commitAutoSupportSettings`: the live settings *and* the active preset when the draft has drifted from it, so the preset the user was editing is what the star clears on, never a second save. It leaves the dialog open and acknowledges on the button (`Saved!` in the success tone for two seconds), because the preset list it acts on sits behind the dialog: closing would send the user looking for a result they cannot see. There is no separate `Apply`. `Delete` confirms through `StructuredDialogModal` and is refused for a built-in.
- Renaming and creating share one small name dialog, the shape the theme dropdown uses for the same pair (`SettingsModal`'s `Create Custom Theme` / `Rename custom theme`); `LutCurveSelector`'s editor does the same for curves.
- **Modified state is a star on the name**, not a notice row: the active preset's row label carries a trailing `*` while `isAutoSupportPresetDirty()` is set, and the trigger's `aria-label` (`Auto-support preset, modified`) and `title` say so for assistive tech and for the test. Closing the dialog with something uncommitted asks first (`useAutoSupportDialogChanges` is the one source for that question, shared with the footer's Save/Reset).
- **Two refusals, and no factory restore.** A built-in cannot be saved over — refused in the store (`saveAutoSupportPreset`) *and* disabled in the UI, with a tooltip pointing at `Duplicate` — and it cannot be deleted, so `Delete` greys out. **While a built-in is selected the policy fields are disabled too**, each saying on hover why (`LOCKED_PROFILE_HINT`, carried by the app's own `Tooltip` rather than the browser's `title`, and by the ⓘ's accessible name): an edit made there could never be kept, so the dialog does not collect one. The diagnostics stay live — a view switch is not run policy, and reading the scene with one has nothing to do with which preset is selected. `Duplicate` therefore *selects* the copy it makes: `Save` writes the selected preset, so leaving the source selected would send the next save back into the refusal. The copy's block is the source's and the live settings are left alone rather than re-applied, which is what keeps an edit staged in the dialog's draft alive — the copy then reads as modified until that edit is saved into it. There is therefore no `Restore factory presets` action: the reason it existed was saving over a built-in, and that is refused now. `restoreAutoSupportFactoryDefaults` stays in the store with no UI caller. Deleting the preset you are on falls back to `medium` (`deleteActiveAutoSupportPreset`) rather than leaving the dialog with no policy — the store's own "nothing selected" contract is unchanged.

`SelectDropdown` needed no extension for any of this: one footer entry is what `menuFooterAction` already provides.

Selecting a preset applies the whole block immediately (the store's contract), and the applied block is copied into the dialog's draft so the fields show it; the rest of the dialog stays draft-until-`Save`. The dialog's strip and the panel's row both go through `setActiveAutoSupportPreset`, so the preset a surface shows is the store's active id and not a match against the live block.

The panel's row (`AutoSupportPresetRow`) is the selector and the Auto-Lift toggle at 1:1. The selector offers **every** preset the store holds — the `Light` / `Medium` / `Heavy` built-ins and the profiles a user saved — where it used to render one button per *built-in*, which made a saved profile unreachable from the panel. Each row names its origin (`Built-in` / `Custom`) so a user can tell which rows the store's save-refusal and delete rules apply to. The selector follows the Auto Orientation panel's objective dropdown for its theme: the `--surface-1` fill and centred content.

Auto-Lift is the app's standard toggle button: `aria-pressed` for the state, and the accent fill the bracing card's quick-pick and the Cut Panel's segmented selector already use (`color-mix(--accent, --surface-1 85%)`) while it is on. Its label states the state — `Auto-Lift ON` / `Auto-Lift OFF` — so the button reads the same to someone who cannot tell the accent fill from the quiet one, and the off state keeps the `--surface-1` fill the selector beside it carries, so the row holds together rather than a filled control sitting next to a dark one. It reads and writes the selection's lift mode — whether every selected model tracks the lift distance — and calls the same `handleAutoLiftChange` as Prepare → Transform's toggle, because the gap it holds under the model is what the generated supports have to span; `docs/workflows/transform-and-positioning.md` describes the lift itself.

The store's own migration duty, now met: the built-ins carry their Support Studio preset ids (light = `detail`, medium = `structure`, heavy = `anchor`), `snapshotPresetSettings` runs `migrateLegacySizingPreset` on everything written or adopted (migrating a legacy `sizingBand` → `sizingPreset` and dropping `sizingBand`), and `isAutoSupportPresetDirty` compares **normalized** blocks on both sides — a payload that predates a key, or still holds a legacy one, fills the same defaults the live block does and reads clean. Comparing raw payloads marked every preset dirty the moment a key was renamed.

Support Studio's presets (`src/supports/Settings/presets.ts`) are a **different system**: they describe how a manually placed support is built and exclude `autoSupport` entirely. Neither store reads the other, and the panel must not present one as a lifecycle stage of the other.

A run returns `AutoPlaceAnalytics` and a `ForestReport`; `forestReportToText` renders it for the placement summary. The report is the primary debugging surface — every decision includes a *why*.

### Where the last run's diagnostics surface

Both halves are the **panel's**, on the Auto Supports card under the preset row, because that is where a run is started and the report describes the run that just happened: `Sizing Debug` (the size, load and height factors the run used, behind a caret) and `Show Forest Report` (the `nH nL nB · n trees` tally, opening the text report in the panel's own modal). `AutoSupportRunDiagnostics` in `src/components/controls/autoSupport/AutoSupportRunDiagnostics.tsx` renders both, presentational — the report arrives as a prop and only the caret's open state is its own — which is what lets the markup be asserted in `src/supports/__tests__/autoSupportPanel.test.ts`. Neither half renders until a run has produced it: the panel does not show two empty frames.

**`Debug Mode` is the switch that shows them, and it is panel state, not a setting.** `AutoSupportPanel` owns the flag and passes it into the dialog; the dialog's Diagnostics card carries the pill and nothing else of the report. It is the `Debug` button the panel used to have in its debug row, now a labelled switch beside `Simplified`. Keeping it session-scoped is deliberate: a diagnostic view is not a policy, so nothing in a saved preset or a shared settings file should turn it on.

### Report sections

`ForestReport` lives in `src/supports/autoSupport/types.ts` (`ForestReport`, `ForestScanMetrics`, `OrphanInfo`, `ForestTree`). `forestReportToText` in `src/supports/autoSupport/autoPlace.ts` is the copy-paste renderer.

- **SCAN** — `209 islands (voxel …) → 187 candidates · 1 overhang` plus `coverage 100% of 438mm²`. Coverage is the  footprint fraction @3mm.
- **ORPHANS CULLED** — grouped by `reason` with counts and human-readable help, then per-entity `id (kind) reason @host knot … — detail`:
  - `hostBlocked` — shaft pierces mesh (would print through model, SDF `distance < radius` on `isShaftBlocked`)
  - `blocked` — `knot→tip` ray hits mesh (`contactConeCollides` offset ray, tip-0.5mm, not straight segment; `branchCollidesWithSDF` for branches)
  - `missingHost`/`missingSegment`/`missingKnot` — knot points to segment/trunk that has no joints or was culled (legacy `trunkId` before `segmentId+t` rehost)
  - `drift` — knot >0.5mm from host shaft (split offset, `pointToSegmentDistanceSq >0.25`)
  - `cross` — leaf/branch crosses another shaft after thickening (`leafPathCrossesSupports` `radius 0.25`, kept but flagged)
  - `host culled (blocked)` — a member on a host that was itself `hostBlocked`
- **PLACEMENT DIAGNOSTICS** — `Trunks by kind: grid 44 (ring + infill), gap-fill 0, standalone 41 (sub-threshold overhang, no host)`; `Candidates by source: voxel 49 · minima 21 · intersection 47 · overhang 98 · stabilization 12 · reinforcement 18`; `Fan refusals: noHost=1 (too far >8mm/2.5mm grid, angle >45°, sameZ|cross|blocked|capacity)`; `Merge refusals: noHost=22, rejected=20`; `Consolidation refusals: blocked=99, cross=3 (sameZ=surface too flat for side-leaves — chunking needs ≥0.4 mm neighbour height rise)`; `Root merges: 1 co-located trunk(s) dissolved into a shared host (refusals: blocked=17, capacity=3, noHost=3)`. Sourced from `diagnostics` captured in `computeAutoSupportPlan`.
- **Counts** — `56 trunks · 70 leaves … | 16 trees, 40 bare` — `trees` are hosts with members, `bare` are 1:1 pillars.
- **FAN-OUT GROUPS** — `v115 @ Z=26.6mm Ø1.03mm [area 0.53mm² …] → 12: v116(L 2.8mm/20° Ø1.03) …`, headed by the gates that admitted its members: placement fans `≤leafFanMaxAngleDeg` within `LEAF_FAN_RADIUS_MM` (`GRID_HOST_FAN_RADIUS_MM` for grid hosts), chunk-consolidation links `≤CONSOLIDATION_MAX_ANGLE_DEG` within `CONSOLIDATION_FAN_RADIUS_MM`, and the `maxAttachmentsPerTrunk` cap in force — so a group is readable without re-deriving which pass attached each member. `spanMm`/`angleDeg` are `knot→tip` distance and angle from vertical, measured **after** the resize/orphan passes: segment splits and rehosting can drift a knot down its host, so a link can read shallower than the gate that admitted it. Each member's own `Ø` follows the angle — the diameter the member contributes, from `memberDiameterOf`, the same number the resize demand reads (a branch's widest segment; a leaf's cone body, which `syncContactConeDiameters` matches to its host) — so the member-vs-host ratio is readable off one line instead of inferred from the render.
- **STANDALONE TRUNKS** — `grid-o0-… @ Z=5.1mm Ø1.21mm [area 10mm² …]` plus `— region ring + grid infill` or `— standalone voxel/minima (below threshold or consolidated)` based on `id` prefix.
- **Two things the report still cannot show** (surfaced, not fixed). (1) The bracket note's arithmetic does not reconcile: `forestSizingNote` prints `base Ø{bandShaftMm} · h{heightFactor} → Ø{post-resize diameter}`, but the diameter in the arrow is the trunk's final segment, which also carries the model factors (`modelSizingFactors().trunkScale`, i.e. `sizeFactor × loadFactor`) the note never prints — so `base Ø1.00 · h1.25 → Ø1.93mm` multiplies out to 1.25, not 1.93. (2) The line prints the host's **shaft**; nothing prints a contact's tip, so the free-width cap's own effect (the thing that made tips read thin) is invisible here — the tip is only visible in the rendered support.

**Orphan reporting:** post-resize `rehostLegacyKnots` + `validateAndCullOrphans` cull `drift`/`missingHost`/`missingSegment`/`blocked` (`return false`, including orphan knots >0.5 mm off their host segment) and keep/report `cross` (`return true`). `ForestReport.orphans[]` (`OrphanInfo`) and `forestReportToText` `ORPHANS CULLED` surface them. Drift is the "leaf attached to nowhere" case — host segment split rehost failed or knot was placed on a trunk that later split.

**Diagnostics reporting:** `ForestReport.diagnostics` captures `diagnostics.candidatesBySource`, `hostsByKind`, `fanRefusals`, `mergeRefusals`, and `consolidationRefusals` so the text report can explain *why* a candidate became a trunk/leaf/standalone vs fanned/merged — and why a region did not chunk (`sameZ` = surface too flat for side-leaves).

## Live printability (demand side)

The frame solver answers "do the placed supports hold?" from the members that
exist — remove supports and the beam solve simply has less to carry. The demand
side lives in `src/supports/autoSupport/printability.ts`
(`evaluatePrintability`), which evaluates the islands the scan already produced
against the tips actually placed:

| Signal | Source | Unit |
|---|---|---|
| Region coverage | `computeRegionCoverage` with `coverageRadiusForRegion` | fraction of footprint |
| Uncovered area | footprint area × (1 − coverage) | mm² |
| Area deficit | `computeLoadBudget` rows by island id | mm² |
| Unsupported span | plan distance from each footprint cell to the nearest tip at or below it, capped at `MAX_FREE_SPAN_MM` | mm |
| Peak peel / area jump | `buildPeelCurve` over `RepresentativeLayerProfile` | N / unitless |

`PrintabilityReport.verdict` is one of `ready`, `underSupported`, `overloaded`,
`critical`: a material uncovered region or a warning region makes it
under-supported, a frame utilization above 100 % from the same edit makes it
overloaded, and the pair — or an uncovered fraction of
`CRITICAL_UNCOVERED_FRACTION` at `CRITICAL_UNCOVERED_AREA_MM2` or more — reads
critical. Region severity requires **both** a mass
(`CRITICAL_UNCOVERED_AREA_MM2`, 8 mm²) and a bridge (`HIGH_LEVERAGE_SPAN_MM`,
4 mm) to be critical. A region is **ok** when its free span is below the bridge
**and** either its coverage reaches `REGION_COVERAGE_TARGET` or its uncovered
area is below `MIN_MATERIAL_UNCOVERED_MM2` (0.5 mm²); otherwise it is a
warning. The hand-supported Puck print's 13.3 mm² patch at 3.9 mm is a warning;
a 0.25 mm²/331.6 mm² (0.1 %) rim and 30 fully covered regions with sub-2.4 mm
spans but **zero per-island budget capacity** are ready. The per-island load
budget is context, not a verdict term — a covered region whose own row has no
assigned capacity is not unsupported. The summary maps a `critical` verdict to
**Action Needed**, `underSupported` to **Needs Attention** (uncovered when a
material uncovered region exists, otherwise the short regions), and it no longer
promotes any uncovered area over 0.02 mm² to critical. A `topple.outcome === 'rocking'` with
a solved frame and no overload is **elastic support/resin compliance** — the
part/forest flexes during peel and recovers — so the summary is **ready** with
a reference note, not attention. The auto-backed Puck reads 0.533 mm with tip
62 %, member 67 %, and adhesion inside limits; the hand-backed one 0.043 mm.
Rocking without a frame still reads attention. `toppleRiskNeedsCoverage` only
gates `pastEdge` / adhesion, so elastic rocking no longer adds anti-topple
supports.

**Constraints:**

- Tips and shaft widths are read from the snapshot's typed collections (trunks,
  branches, leaves, stumps, sticks, twigs). Braces and kickstands carry no model
  contact and are not contacts.
- Coverage is computed without the occlusion mesh on the live path; pass `mesh`
  only when the vertical-shelf correctness is worth the raycast cost.
- The peel signal is context, not a verdict term. Per-region peel demand needs
  the 2D Stefan field for *that region's* slice, and the representative-layer
  profile only retains a handful of global layers; the frame report's per-layer
  tip utilization owns tip-load sufficiency in the meantime.

The verdict is stored beside the frame report in `frameStressState.ts`
(`printabilityByModelId`, `setModelPrintability`, `clearModelPrintability`) and
summarized by `src/supports/autoSupport/supportStressReport.ts`
(`summarizeSupportStress`, `supportStressReportToText`,
`SupportStressReportInput`, `SupportStressSummary`, `SupportStressStatusLevel`,
`FLOATING_Z_THRESHOLD_MM`).
### Support-mode analysis runs on the auto-support worker

The frame solve, representative-layer sampling, printability, and topple pass
are too heavy for the UI thread on a multi-million-triangle model. They now run
on the same worker as placement: `src/supports/autoSupport/supportAnalysis.ts`
exports `runSupportAnalysis` (pure apart from the seeded store/mesh/settings),
`autoPlace.worker.ts` handles an `analyze` request next to `run`, and
`autoPlaceWorkerClient.ts` exposes `analyzeSupportState` /
`buildSupportAnalysisPayload`. The worker posts
`Preparing model → Sampling layers → Building support graph → Solving frame →
Stability → Printability`; the panel renders those as check circles while the
report lands in one store write. The analysis is debounced and re-arms while a
support gizmo is dragging, so resizing never waits on a solve. The payload
carries the support snapshot, serialized islands, and the mesh (through the
worker's confirmed-key cache); the main thread pays that serialization once, not
the solve. Without a `Worker` (tests, plain browser) the client falls back to
the same in-process body.

The Coverage row's colour uses `coverageCheckStatus` from `printability.ts`,
the same materiality the verdict uses: an uncovered area below the
`MIN_MATERIAL_UNCOVERED_MM2` (0.5 mm²) per-region floor is still shown as a
number, but stays green while the banner says **Checks Passed**. Only a
material uncovered region, a deficient region/short span (amber), or a critical
verdict turns the row red; the Details `Uncovered area` value uses the same
colour. This stops a 0.2 mm² sub-material patch from reading as a failure next
to a passing verdict.

`SupportStressPanel` (titled **Printability** in the UI) renders a plain-language
hero verdict banner (`Checks Passed` / `Needs Attention` / `Action Needed` /
`Not Checked`), a unified three-row Coverage / Support load / Stability checklist,
the interactive peel profile graph, a collapsed-by-default Details disclosure
(metrics + hotspots), a **Printability Report** modal (`StructuredDialogModal`)
displaying and copying the full plain-text diagnostic report, and a footer action
bar (`Overlay` + `Reinforce` / `Analyze`). Models sitting above
`FLOATING_Z_THRESHOLD_MM` (0.5 mm) with no supports evaluate to `critical`
(`floatingUnsupported`) instead of measuring plate adhesion against their own
floating base, and unscanned models (`hasScan: false`) never report green
coverage or `Checks Passed` before an overhang scan has run. **Every structural support edit re-analyses the
model** — placement, move, thickness, and twig/stick bridges included:
`captureStructuralRefs` covers every geometry collection and the subscription
coalesces edits on a 160 ms debounce, re-solving the frame and re-evaluating
printability. The effect also analyses once on setup when the current state is
not the solved one, because the island set changes on every edit and an edit can
land while the subscription is being rebuilt (that is how a Generate run used to
produce supports with no stress report). The demand side is evaluated on **mesh
mount**, not on a scan: the panel subscribes to `subscribeModelMesh` and runs
`evaluatePrintability` with the layer profile as soon as the model exists, so
the peel curve and spatial adhesion overlay are available on a freshly imported
model — pre-supported or bare — before any scan, and are then refreshed with the
scan's islands when it runs. Without that, a pre-supported import had only a
frame report and the shader fell back to the 1D Z band, which reads as a purely
vertical gradient. With no frame report the panel graphs
`PrintabilityReport.peelCurve` and the shader builds its band from the same
curve.

**Peel overlay (Stefan adhesion only).** `PrintabilityReport.peelOverlay` is a
plan-resolution `PeelOverlay`: the peak Screened Stefan pressure `p̃` over the
sampled layers, normalized to the model's own hottest cell, on a
`OVERLAY_MIN_CELL_MM` 0.5 mm grid (capped at 1024 a side). It is the *only* surface
paint — uncovered footprints are panel data (uncovered mm², max span, short
regions), not model colour. The fields exist per sampled plane, so this is a max
projection: it says *where* the part peels, while the graph-hover ring still
carries *at which Z*. `StressForceHeatmapMaterial` uploads it as a world-space
DataTexture (`uPeelTex`, `uPeelMin`, `uPeelInvSize`, `uPeelEnabled`) and paints
the cool → teal → amber ramp on the model, weighted by pressure and strongest on
downward-facing surface (upward faces keep a lighter wash so the field reads
from the working view);
when the overlay is present the 1D Z band is not drawn (it is the fallback for a
stress report with no sampled fields), and the rings and overload spots still
apply. The material takes `report` and `printability` independently, so an
unsupported model with no stress report still shows its adhesion. While the
overlay is enabled, `SceneCanvas` suppresses the island 3D overlays too —
selected-island marker, contact-footprint instances, overhang patches, voxel
visualization and island id labels — on the same `stressOverlayActive` flag that
already hides supports and rafts, so the paint never competes with scan debug.

**Layer resolution.** `extractRepresentativeLayers(mesh, planeCount?, { layerHeightMm })`
slices at the print profile's layer height when the caller supplies it
(`getCachedRepresentativeLayers(mesh, getActiveMaterialProfile()?.layerHeightMm)`
in `SupportStressPanel`), capped at `MAX_SAMPLED_PLANES` (1024). The **placement
run** takes the same height: `runAutoPlace` / `computeAutoSupportPlan` accept a
`layerHeightMm`, the worker payload carries it (`AutoPlaceWorkerPayload`), and it
reaches `optimizeContactsByTraction` → `extractRepresentativeLayers`. Without
that the run's traction profile — and the `frameStress` report it attaches — was
sampled on the ~1 mm default grid, so the peel profile read coarse right after
Generate until the next edit re-solved with the panel's 50 µm profile. It
returns `profile.samples` — one `{ zMm, areaMm2 }` per printed layer — alongside
the IoU-clustered `layers` that carry the Stefan PDE fields. The stress report's
`layerProfile`, the panel's peel graph and `buildPeelCurve` all read `samples`
when present, so the Z ladder is the selected profile's layer height rather than
the cluster peaks; hand-built profiles (tests, fixtures) fall back to `layers`.

**Per-layer force, not per-cluster force.** `computePeelLayerSamples`
(`supportGraphStress.ts`) gives every sample a force: the field-derived traction
factor — `stefanLayerForceFactor`, the same `0.50 + 0.50·(p̄/p̄_ref)^0.22`
compression clamped to `[0.65, 1.55]` that `stefanTractionFactorAt` applies at
placement, plus the area-jump surcharge — is anchored at the representative
layers and interpolated across the samples between them, then multiplied by that
sample's own area and `NOMINAL_PEEL_PRESSURE_MPA`. A 10 mm² reference disc is
untouched (ratio 1 → factor 1 → 0.29 N). At a representative layer this equals
`computeLayerPeelForceAndCop` exactly; between them the neighbours inherit the
same factor instead of falling back to nominal 1.0, which is what made cluster
peaks spike.

**The frame solver must use that factor, not the raw saturation ratio.** Feeding
the field's raw `mean p̃ / p̃_ref` into the area multiplied a broad layer by up
to ~38× nominal: a 598 mm² cross-section read 226 N (0.38 MPa mean) and threw
healthy leaves to 40 MPa / 342 %, triggering the reinforce loop to thicken 732
members. The compressed factor caps the same layer at 1.55× (≈27 N), which is
the band the placement model and the 10–50 kPa peel documentation already
assume; only `NOMINAL_PEEL_PRESSURE_MPA` (29 kPa at the 10 mm² disc, ≈45 kPa
saturated) remains a per-resin calibration constant (plan §4.3).

**Topple risk from the solved demand.** `evaluateToppleRisk`
(`src/supports/autoSupport/toppleRisk.ts`) evaluates the **worst single-layer**
peel moment: per sampled layer, the Stefan peel force
(`computePeelLayerSamples`) at that layer's centre of pressure, measured about
the pose's worst bearing edge (so multi-layer profiles never inflate moments
with finer layer heights). It returns `comDepthMm` (how far the centre of
mass sits inside the edge), `peelMomentNmm`, `requiredAdhesionMpa` (the plate
pressure that would lift the contact patch against the conservative
`TOPPLE_ADHESION_THRESHOLD_MPA` 0.30 MPa band, `Infinity` when bearing area is
zero), and `complianceMm` from the frame solve; `classifyToppleRisk` turns
those into `pastEdge` / `rocking` (fitted part rotation above
`ROCKING_THRESHOLD_MM` 0.15 mm, a reference for elastic layer-shift sensitivity)
/ `adhesionBound`, and `toppleRiskNeedsCoverage` turns only `pastEdge` or an
adhesion over-budget into the placement/coverage boolean.

`complianceMm` reads `SupportFrameStressReport.maxTipRockingMm`, now the range
of the **fitted rigid-body rotation** along the layer's coherent drag direction
(`rigidBodyRockingMm`). A single tip's deflection magnitude is an elastic sag —
one thin leaf bending under its own share — reported separately as
`maxTipDeflectionMm`. The raw max−min of contact displacements still included
that sag (and marked a 3 mm "rocking" on the hand- and auto-supported Puck
prints that work); the fit removes it, and the same hand file reads 0.043 mm.
A symmetric frame under a symmetric peel reads ~0 fitted rotation even though
each tip deflects.

The edge now travels with the pose: the Rust `StabilityReport` exposes
`worst_edge_point_mm` / `worst_edge_normal` (pinned by the analytic fixture
test), `PoseStabilityWire` carries them, and the TS `PoseStability` exposes
`worstEdgePoint` / `worstEdgeNormal`. Both `computeAutoSupportPlan` and
`SupportStressPanel` evaluate `evaluateToppleRisk` live from the mesh's world
centroid (`geometryCentroidMm`) and bearing edge, logging it and storing
`ForestReport.toppleRisk` / `toppleRiskByModelId`. The panel re-evaluates
live deflection on every structural support edit via `setModelToppleRisk` and
`clearModelToppleRisk`.

**Calibrating the green constants.** Three numbers cannot come from the mesh;
`greenMaterialCalibration.ts` converts a measurement into each:

- `NOMINAL_PEEL_PRESSURE_MPA` (29 kPa today, ≈45 kPa at the 1.55× saturation
  cap) — film pressure at the 10 mm²
  reference disc, from a suction-cup pull-off: `peelPressureFromPullOff`
  divides the peak force by `area × peelTractionFactorForArea(area)`, so a
  coupon larger than the reference is corrected for the compression the solver
  applies (a reference-size coupon's factor is exactly 1). The default is
  anchored twice: a 706.85 mm² coupon's 31.7 N damage-initiation force and
  e-Stage 7.3's 45 kPa suction parameter (Cao et al. 2025). The placement lean
  gate deliberately keeps its own `MEMBER_LEAN_DESIGN_LOAD_N` (0.15 N): it uses
  the vertical peel load as a lateral cantilever proxy, while the actual drag is
  `LATERAL_PEEL_DRAG_RATIO` (8 %) of it, so re-tuning that gate is a separate
  structural decision rather than a side effect of the pressure constant.
- `GREEN_RESIN_MODULUS_MPA` (850 MPa) — from a printed cantilever bar,
  `greenModulusFromCantilever` inverts `E = F·L³/(3·δ·I)` with
  `roundBarInertiaMm4` for the section.
- `DEFAULT_SUPPORT_BREAK_STRENGTH_MPA` (4.8 MPa) — from a single contact's
  pull-off, `greenUtsFromContactPullOff`: `σ = F / (π·(d/2)²)`. It is what the
  solver's **tip contact** check and every placement capacity use. Member
  bending/axial stress uses the profile's **bulk** tensile instead
  (`memberStrengthMpa`): a 2.2 mm shaft is not a 0.5 × 0.5 mm coupon. A material
  profile carries the
  **datasheet tensile**, and `supportBreakStrengthMpa` applies
  `SUPPORT_BREAK_STRENGTH_RATIO` (0.2): DM12 breaks at 4.8 MPa on a 0.5 × 0.5 mm
  section against a 24 MPa datasheet (Cao et al. 2025), because a thin green
  strut is far weaker than bulk.

All three return `null` for a measurement that cannot be physical.

**Tensile strength is a material field now.** `MaterialProfile.tensileStrengthMpa`
(Meta tab of the material dialog, next to resin family and bottle fields; default
`DEFAULT_RESIN_TENSILE_STRENGTH_MPA` 24 MPa — the measured DM12 — clamped 5–200)
is normalized on create/import/copy and threaded to `computeAutoSupportPlan` /
`runAutoPlace` as `resinTensileMpa` (`AutoPlaceWorkerPayload.tensileStrengthMpa`,
which the client fills from the active material). The run derates it **once**,
at its boundary, with `supportBreakStrengthMpa`; the frame solver receives it as
`supportStrengthMpa` for tips and the undated datasheet value as
`memberStrengthMpa` for members, the force budget and Phase 1c get the break
strength. The panel carries the profile tensile in
`buildSupportAnalysisPayload`; `runSupportAnalysis` derives the same pair before
calling the solver. Doubling the profile value halves
every tip/member utilization without moving geometry (pinned by a solver
test). A stored profile still carrying the **old 12 MPa default** is moved to 24
once during hydration (`migrateTensileSemantics`): under the new semantics 12
would derate to a 2.4 MPa break and carpet the model in supports. The
`dragonfruit.material.tensileSemantics.v2` localStorage marker keeps a 12 typed
after the change as the user's datasheet value. Peel pressure, green modulus,
FEP screening length and plate adhesion are still source constants; a
pull-off/bar measurement feeds them through `greenMaterialCalibration.ts` but
has no per-material field yet.

**Per-layer growth masks.** The same pass derives `profile.growth` (with
`profile.growthGrid`): every plane that added solid area over the last plane
that actually had material, holding the *added plan cells* (`addedCells`, row-major
indices at `GROWTH_CELL_MM` 0.5 mm) plus `addedAreaMm2` and `growthRatio`. This
is the input for consecutive-layer overhang detection — the added cells are
*where* the new surface is, which the area curve alone cannot say. `fillPlaneMask`
uses an even-odd scanline fill of the plane's own contour segments, so a plane
is a closed region, not a boundary band. Constraints:

- Growth is measured against the last plane with area > 0.05 mm², because a
  plane exactly on a feature boundary can cut no triangles and read as zero.
- Retained entries are capped (`MAX_GROWTH_LAYERS` 128, largest addition first;
  `MAX_GROWTH_CELLS` 2 M indices) and re-sorted by Z.
- Cost is bounded by the fills: a 40 mm sphere at 50 µm (800 planes) slices and
  derives growth in ~57 ms, a torus knot in ~87 ms; the profile is cached per
  geometry, transform and layer height.
- At 50 µm a smooth surface adds a sliver every layer, so growth entries alone
  are not overhangs. Filtering added cells by self-support angle and by whether
  the layer below carries them is the placement step that consumes this.

## Related pages

- [Support System](support-system.md) — the subsystem this places into
- [Stump](../reference/support-anatomy/stump.md) — what near-plate contacts become
- [Experiments Framework](experiments-framework.md) — the gate
