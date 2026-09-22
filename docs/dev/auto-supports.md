# Auto-Supports

Automatic support placement: given the island-analysis output for a model, decide where supports go, how thick they are, and brace them — then commit the whole thing as one undoable change.

Gated behind the `auto-supports` experiment (see [Experiments Framework](experiments-framework.md)); the gate is checked in `src/app/page.tsx`.

## The seam that matters: plan, then commit

`computeAutoSupportPlan(islands, modelId, settingsOverride?, baseState?, mesh?)` is pure with respect to the stores: it clones the current snapshot, works on drafts, and returns an `AutoSupportPlan` holding `before`, the new `support` state (kickstands included), `analytics` and `result`. It commits nothing.

`runAutoPlace(...)` is the thin caller that computes a plan and, only if `result.changed`, calls `setSnapshot()` / `setKickstandSnapshot()`.

Keep that split. It is what makes the run testable without a store, lets a caller preview or discard a run, and keeps the whole placement — including auto-bracing — a single history entry rather than a stream of mutations.

## The pipeline

Six phases inside `computeAutoSupportPlan` (`autoPlace.ts`):

| # | Phase | What happens |
| - | ----- | ------------ |
| 0 | Settings | Normalize; bail out returning `null` when disabled |
| 1 | Generate candidates | Turn detected islands into `CandidatePoint`s |
| 2 | Deduplicate | Collapse candidates that would support the same spot |
| 3 | Place | The bulk of the work — fixed-density ring + grid infill distribution, trunk/leaf decisions, collision checks, gap filling |
| 4 | Forest resize | Re-derive every trunk's stepwise diameter now that the forest is known |
| 5 | Auto-bracing | Braces computed into the same draft, so they ride the one commit |

## Candidates

Islands arrive from volume analysis carrying a `source`. Three matter: `overhang` (the mesh-normal classifier's shallow surfaces), `minima` (local low points, only when `class === 'minimaOnly'`), and `intersection`. Emission is island-typed by footprint span: sub-head specks (≤0.5mm) get one tip at the bbox center; narrow islands 1.5–6mm long split into a symmetric pair (half area each); wide blobs keep one candidate (the grid path covers their area).

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

Stabilization anchors enter placement as `source: 'stabilization'` candidates
and are deliberately standalone trunks: they never fan or merge onto a nearby
host (the merge gate is source-gated), so a tip pillar and its flanking
anchors stay independent instead of collapsing into drift-culled leaves.


## Distribution: one fixed-density scheme

There is no anchor selection, no bake-off, and no grid/Poisson split. Every
overhang region above `gridAreaThresholdMm2` gets the same treatment in
`generateGridCandidates` (`gridPlacement.ts`):

- **Boundary ring** — the region's perimeter resampled at fixed spacing in the
  2D-projected plane (`sampleBoundary2D`). Projection is the point: Z does
  not lengthen a boundary, so a sliver's ring is a short line and can never
  climb a limb. Each sample's Z comes from the surface sampler.
- **Grid infill** — a lattice over the footprint bbox at `computeRegionSpacing`
  (angle + suction curve), skipped for slivers and for footprints thinner than
  one lattice cell (`Math.min(width, height) < spacing`), where the rows would
  land a fraction of a millimeter apart and double the density of a rib the
  ring already carries end to end. The lattice spans the region with integer
  rows/columns, inset by the contact radius.
- **Shape handles degenerate cases**: below the area threshold the region keeps
  its single-candidate path (one pillar) *unless* `shouldUseDensityGrid` routes
  it here on shape — a footprint longer than `ISLAND_TWO_POINT_MAX_MM` (6 mm).
  A thin rib can sit well under the area gate (a 15 × 1.3 mm plank underside is
  19.5 mm²) and one centre pillar leaves both ends of the anchoring edge
  unsupported; the ring is what it needs, and the two-point band already
  handles anything shorter. Sliver → ring only; normal face → ring + infill.
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

A tip covers surface within `TIP_COVERAGE_RADIUS_MM` (3 mm) at its own height, widening along the `influenceRadiusMm` support curve above (4mm by 3.9mm up, 5mm by 15mm, capped 6mm) — tall regions need fewer fresh tips. Large flat regions pack denser: `coverageRadiusForArea` shrinks the effective disc sublinearly with footprint area (traction ∝ cross-section), floored at half radius. A region needs no gap filling once `REGION_COVERAGE_TARGET` (95%) is met; uncovered clusters below `MIN_GAP_CLUSTER_MM2` (2 mm²) are not worth filling, and there are at most `MAX_GAP_FILL_PASSES` (3) passes per run. Dedup uses the grown disc in 2D for overhang-lattice pairs, except pairs more than `SUPPORT_RESTSTACK_DELTA_MM` (5 mm) apart in Z never suppress each other (staircase shelves keep their supports). Discrete islands (voxel/minima/intersection) always use the flat 3D ball — neighboring islands must never eat each other.
## Sizing is empirical, not physics

!!! warning "Physics-based sizing was tried and removed — do not reintroduce it"
    An area-derived shaft curve **inverted the profiles**: a light 16 mm² cell sized *thicker* (1.28 mm) than a heavy 5 mm² cell (1.12 mm), because the curve rose with cell area. Light / Medium / Heavy are now hardcoded profile blocks (detail ≈ 0.8, structure ≈ 1.0, anchor ≈ 1.2 shafts) and sizing follows the active block. Session overrides apply until the next profile switch. See the header comment in `parameterSizing.ts`.

Tip contact is the profile band scaled by underside angle — flat ceilings get the full contact, steeper slopes less — floored at 30% of the shaft so a thick shaft keeps a proportional tip. Candidates from sub-0.15mm² islands carry a per-point `tipDiameterMm` (detail band, 0.22mm) that bypasses band and floor, so fine detail gets a shrunk tip without dragging the shaft down. Roots, tip length and penetration take the profile band flat.

Every builder the run calls takes the band through `SizeOverrides` — trunk, branch, leaf, and the cavity `buildCavityBridge` (its sticks and twigs). Each of them reads `input.<field> ?? settings.<field>`, so the Studio preset sizes manual placement only. `buildStick` skipped its overrides once and sized every cavity stick from whatever profile was loaded in Support Studio at the time; if you add a builder to the pipeline, honour the override the same way.

## Rules worth knowing before you change placement

- **Every member must clear the branch-angle rule — and the gate looks at the shaft, not the chord.** `memberMaxAngleFromVerticalDeg()` derives the steepest lean a member may take from the user's branch angle (`grid.minBranchAngleDeg`, **60° above horizontal** ⇒ ≤30° from vertical) — the same rule the grid attach path enforces through `getLengthAwareMaxAngleFromVerticalDeg`. It bounds every auto path: the placement fan (`min(leafFanMaxAngleDeg, 30°)`), the merge knot search (`STEEP_MIN_RISE_DEG = max(45°, minBranchAngleDeg)`), the routed-branch caps, and the chunk-consolidation relaxation below. `branchDepartureAngleDeg()` then re-checks the **built** branch where it actually leaves the host (knot → first shaft joint): the contact cone is clamped toward the surface normal, so a branch can pass the knot→tip gate and still run out nearly level, bending into a steep cone only at the tip — on a speck field every branch chord read 30° while every shaft left at 42°. A member that would sag is refused and its pillar stays standalone instead. The consolidation routed-branch host pick therefore aims at the *steepest* eligible sample rather than the nearest: the cone bend eats the last couple of millimetres of rise, and reaching further down the shaft buys it back. Before this the fan used 45°, merge 45° rise and consolidation 75° from vertical, and nothing consulted the configured branch angle at all.
- **Overhang pillars consolidate into chunk trees.** After placement, neighbouring ring/infill/standalone pillars fan into each other (`CONSOLIDATION_FAN_RADIUS_MM`, 8 mm — an upper bound, not a target, capacity `maxAttachmentsPerTrunk`) — supports release in chunks with one plate contact per chunk. Consolidation asks `fanLeafToHost` for the **nearest** eligible host (`hostOrder: 'nearest'`), where placement fanning asks for the steepest: a chunk link is a local tie between neighbouring pillars, and steepest-in-reach skips the adjacent pillar for a taller one up to the full 8 mm, which reads as a stray 6–8 mm diagonal across the lattice. The consolidation angle is relaxed past the placement fan — `min(max(leafFanMaxAngleDeg, CONSOLIDATION_MAX_ANGLE_DEG = 75°), 90° − minBranchAngleDeg)` — because on a surface sloped <45° from horizontal, neighbouring pillars can never satisfy the placement gate (the link angle is always 90° − surface slope), so chunking would be geometrically impossible. The branch-angle rule still caps the relaxation, so links shallower than it leave the pillar standalone. The chunk's interior hosts carry the load; the links that survive are connective tissue. Same-height pillars (vertical drop < 0.4 mm) never straight-fan; when the straight leaf is blocked, crosses, or the surface is too flat AND the tip sits at ≥ `CONSOLIDATION_BRANCH_MIN_HEIGHT_MM` (10 mm), a **routed branch** attaches it to a host shaft instead — high above the plate that reads as a tree; near the plate it is suppressed (it would read as a zig-zag web). Near-plate contacts (tip Z < `ANCHOR_HEIGHT_THRESHOLD_MM`, 5 mm) place as [stump](../reference/support-anatomy/stump.md) primitives and stay standalone.
- **Grid trunks are fanning hosts only up close.** `GRID_HOST_FAN_RADIUS_MM` (2.5 mm) is deliberately tighter than the general `LEAF_FAN_RADIUS_MM` (5 mm), so fan leaves do not sweep across the grid forest and puncture its shafts.
- **Long spans become branches, not leaves.** A leaf is a seg-less tapered cone (host-diameter body → ~0.28 mm contact), so past ~6 mm it reads as a spindly spike next to its trunk. Island spans over `MAX_LEAF_SPAN_BEFORE_BRANCH_MM` (6 mm) route to branches with real shafts in both the merge path and `fanLeafToHost` — measured knot→tip (the span the member actually bridges), not tip-to-host-tip, which understates it when the knot sits low on the shaft. Failed branch attempts fall through to the next candidate or the standalone-trunk path, never to a long cone. **Every origin routes, overhang included.** Overhang fanning used to stay a leaf by rule past the threshold, which is how a merged 11.6 mm tapered spike got built next to its trunk: the threshold is about the *member's* shape, not about which surface the tip touches, and `buildConsolidationBranch` has always built overhang-origin branches. A candidate whose link is past the threshold now gets a branch or (when no host sample gives one a legal departure) a pillar of its own — the consolidation pass merges pillars into chunk trees, which is the designed remedy for pillars standing next to fan leaves.
- **A short grid span may lean past the configured angle; the allowance is length-aware.** The grid attach path applies `getLengthAwareMaxAngleFromVerticalDeg` to the **built shaft's first segment** (knot → first joint), not to the knot→tip chord: under 3 mm the configured angle is a floor and the member may lean to 60° from vertical (75° at an occupied node, the socket elbow), 3–5 mm tapers back, and past 5 mm only the configured angle passes. The knot→tip chord is only a pre-filter, and it has to use the **loosest** allowance that gate can grant (75° at an occupied node, 60° otherwise): measured against the length-aware allowance instead, it dropped knots the gate would have taken, so a tip 3 mm off its host and 1 mm under its top grafted 6 mm down the shaft, because every knot above it had a straight line to the tip shallower than the branch angle while its built shaft left at 31.7° against the 60° it is allowed. It is the same allowance the socket elbow and the short-span detour slack are justified by — a strut under 3 mm leaning to 60° from vertical is mechanically sound. Flat mode needed it because a flat region's hosts are only as tall as the region's clearance, so a tip on a 1.5 mm tip lattice 4 mm from any node could not leave its host at the configured 60° above horizontal: on a 20×20 flat underside, 155 of 224 tips were refused and the region ended at 86% area coverage with 25 lonely pillars. Length-aware, the same fixture is 67 attachments and 99% coverage — the tips still refused are the ones no legal member reaches from their node, which is the rule working, not a gap. `satisfiesMinAngleFromHorizontal` (the flat test) is gone with this.
- **The fan reaches in plan, and the wide tier only fires when nothing is in reach.** `fanLeafToHost` admits a host sample by its *lateral* distance (`fanRadiusMm`, or `GRID_HOST_FAN_RADIUS_MM` for a grid host), the `vDist ≥ 0.4 mm` rise floor, and the branch-angle gate. The reach is a **plan** distance: run on the full 3D distance — as it was — the drop counts as if it were lateral, so on a tall thin host the samples inside the radius are the ones near its top, which are exactly the shallow ones the angle gate refuses, while the steep sample that would have been legal sits further down, outside the radius. Such a tip found no host at all (`noHost`) or only shallow ones (`angle`), and stood alone as a 1:1 pillar or crossed to the model as a stick — two contact scars where a carried tip leaves one. A tip with nothing inside the normal reach now gets a second, wider search (same plan reach, span capped at `reach / sin(maxAngle)`, so a grid host's rescue stays short), ordered by the **shortest** legal link rather than the steepest: that tier exists to remove a lone pillar, not to add material. Tier 1 is untouched, so every placement that already worked keeps its look.
- **Fanning attaches to segments, not entities.** `collectFanShaftPoints` samples per-segment (`segmentId` + `t`) and `fanLeafToHost`/`buildConsolidationBranch` create knots with `parentShaftId: segmentId, t` — not the entity id. Legacy knots keyed to the entity are rehosted to the nearest segment before `computeForestDiameterProfile` so diameter demands include fan leaves and drift checks use segment geometry. `countAttachmentsOnHost` handles both for backward compat. The host pool, merge search and capacity checks all walk `GRID_HOST_TYPES` — the types declaring `canBeGridHost` — so a second hostable type is offered as a host without a second edit.
- **A host, and therefore its knots, belong to one model.** The snapshot holds every model's forest and `collectFanShaftPoints` samples all of it, so host selection filters on the host's `modelId`: `fanLeafToHost`, `buildConsolidationBranch`, the consolidation conversion loop and the flat-island stub pass all `continue` when the host belongs to another model. Unfiltered, a run for one model attached its leaves to a neighbouring model's shafts, created knots on that model's segments, and -- worst -- *converted that model's bare standalone pillars into its own leaves* (conversion deletes the pillar). `findMergeHost` is the one path that always filtered.
- **Auto knot ids must be free in the draft.** `draftAddPrimitive` REPLACES on an id collision instead of failing, and auto knot ids derive from candidate/island ids -- which restart per scan (`v0`/`m0`/`o0`, so two models rebuild the same ids) and repeat across gap-fill passes. A reused id silently re-parents the member that already owned that knot onto this run's host shaft, rendering as a long member reaching across from the other model's structure. `freeKnotId` allocates the free id at every member-creating site: the two fan paths, `buildConsolidationBranch`, and the merge path.
- **Orphan validation after resize.** After `computeForestDiameterProfile` the pipeline rehosts legacy knots and runs `validateAndCullOrphans` (drift >0.5 mm, missing host/segment culled; `cross`/`blocked` reported but kept). A knot on a top segment is valid — top segments carry no `topJoint` by design, so the host trunk's contact cone stands in as the segment top. Culled leaves/branches and their orphan knots are removed, `ForestReport.orphans[]` lists `id/kind/reason/hostId/knotId/detail`, and `forestReportToText` emits `ORPHANS CULLED`. This is where the "leaf attached to nowhere" (drifted knot after a host trunk’s diameter split) is caught — check the report before the render.
  - **A knot must be placed on the same line the drift check measures.** `hostSegmentSpan` is the single resolver for a host segment's world span (root top when the bottom segment carries no `bottomJoint`, contact cone when the top segment carries no `topJoint`), and both the merge knot search and `validateAndCullOrphans` go through it. Do not give either side its own fallback: they used to differ — the search fabricated `(0, 0, rootTopZ)` — and the two lines coincide only for a trunk rooted at the world origin, so every member merged onto an off-origin host was placed beside its shaft and then culled as `drift`. A support that is placed and then silently culled leaves its island unsupported with only a `drift` line in the report to show for it; the members are not re-placed, so the coverage number is the only other clue.
- **Contact resolution is hole-tolerant.** `resolveSurfaceNormal` casts upward from just below the candidate (underside contact), then downward from above (top-surface contact, normal flipped), and walks a small disc of lateral offsets (radii 0, 0.75, 1.5, 2.25 mm) before giving up. A punched drain hole directly above the candidate used to swallow the single upward ray, after which the downward fallback landed on the far side of the wall — in a cavity, on the floor with a flipped normal — and the candidate was rejected outright, so the interior ceiling lost every support the moment a hole was punched through it. A hit below the candidate is never accepted, in either direction.
- **A candidate within `ALREADY_SUPPORTED_RADIUS_MM` (3 mm) of an existing tip is already supported** and is skipped.
- **Twigs test with rays and reach their own length.** A twig is the short model-to-model bridge a cavity fallback places (drop ≤ `stickVsTwigCutoffMm`), and it is the one member whose whole job happens *inside* a thin gap — where the signed-distance field cannot be trusted: it signs from the nearest triangle, and in a gap between two facing faces the nearest one changes across the gap, so the empty space reads as material (measured: the midpoint of a 1.5 mm gap between a header and the body reports −0.75 mm, "inside"). Every SDF gate therefore refused twigs by construction, automatically and by hand. `buildTwig` and the cavity path check twigs with `checkShortBridgeCollision` — ray casts, which need no sign — and that check is *inset* from the sockets, because a socket sits on the surface it touches and a whisker offset from it starts inside the material (which refused every canted twig). The cavity search also reaches sideways as far as a twig may span (`stickVsTwigCutoffMm`, radii 0.75 mm steps out to the cutoff) so a pointed tip can be propped off the surface beside it; a member found that way must be a twig — sticks keep the near search and their near-vertical gate. Larger members (sticks, trunks, branches) keep the SDF: their clearance question is genuinely three-dimensional. **The twig's verticality gate lives in its registered builder** (`Twig/twigVerticality.ts`, `MAX_TWIG_SHAFT_ANGLE_DEG` 45°, enforced in `twigRegistration.ts` beside the stick's 20°): the gate measures the *built shaft* (socket to socket), because a sloped or sidewall landing's standoff is what shoves a grazing twig sideways, and past that cant the member is a near-horizontal whisker hanging the island off a strut that carries no load. It used to live only in the cavity fallback, so a twig built anywhere else — the manual bridge controller, any future path — slipped through with no gate at all. Measured: thin-gap and floor twigs build at ≤17°, pointed-tip props off a wall with a real drop land 23–43°, and the grazers start at 48°.
- **The cavity fan is the widest host search, and its refusal carries the numbers.** A tip with no plate route (`buildTrunkData` → `COLLISION_WITH_MODEL`) is first offered to a nearby host at `CAVITY_FAN_RADIUS_MM` (12 mm, plan) — the same reach for a grid host, because the 2.5 mm grid limit exists to keep ordinary fan leaves from sweeping across the grid forest and that reason does not apply to a tip whose only other outcome is a model-to-model bridge with a second contact scar on the model. The log line `noHost` alone cannot say whether there was no host or only a far one, so `fanLeafToHost`'s failure returns `nearestHostMm`, `nearestSteepMm` and `steepAngleDeg` and the report prints `fan:noHost (nearest 11.7mm plan, no legal host)` or `… (nearest 3.4mm plan, nearest legal 13.5mm @ 29°)`. Read it before tuning any reach: it separates "nothing is close" from "something is close but only at an illegal angle" from "the host is there but the link runs through a wall". **This search also passes `rescueSpanOverrideMm: Infinity`.** The wide tier's derived cap (`reach / sin(maxAngle)`) is right for ordinary placement, but a cavity tip is usually at the TOP of its feature, with the nearest host close in plan and low — so every sample that clears the angle gate makes a long link, the cap refuses all of them, and the tip becomes a stick. An observed case read `noHost (nearest 2.2mm plan, no legal host)` with the host 2.2mm away and 28.6mm below. Since the wide tier takes the shortest legal link, lifting the cap spends no more than that geometry forces, and the result is a near-vertical branch (one contact scar) where the stick had two.
- **Cavity fallback: bridge down, then just off vertical.** A tip with no plate route (`buildTrunkData` → `COLLISION_WITH_MODEL` — e.g. the ceiling of a hollow model's cavity) is first offered to a nearby host, then bridged model-to-model by `buildCavityBridge`: a downward raycast finds the surface below and the drop chooses a stick (`> stickVsTwigCutoffMm`) or a twig. The cast walks a small disc of verticals around the tip (radii 0, 0.75, 1.5, 2.25 mm, nearest radius first) rather than one straight-down ray — a punched drain hole or a gap directly under the tip used to swallow the single ray and leave the contact with no support at all, which is what "no supports inside the cavity once holes are punched" was. `MAX_SHAFT_ANGLE_DEG` (20°, in `stickVerticality.ts` — the stick's registered bridge builder applies it) caps the cant and the post-build shaft check rejects any bridge that pierces the model, so the wider search cannot produce a crooked stick. Twigs get the same shape of gate from their own registered builder (`Twig/twigVerticality.ts`, `MAX_TWIG_SHAFT_ANGLE_DEG` 45°), which no longer lives in this path.
- **Flat-island coverage is stubs, not bridges.** Flat voxel islands (everything the grid phase does not own: `source !== 'overhang'`) get stub branches from the trunks standing under them. The pass walks the island's 2.5 mm cell grid; each cell goes to the **nearest trunk within `leafFanRadiusMm` laterally**, and the cell is skipped when no trunk is that close — those spots belong to the pillar paths. Two earlier shapes are closed: walking *trunks* and stamping the island's whole bbox from each of them (10–24 mm near-horizontal branches from one host, straight across whatever stood between — through a hole into a cavity), and knot ids that omitted the trunk, so each writer overwrote the previous knot and every earlier branch re-parented onto whichever trunk wrote last (the "dozens of members on one host" that no capacity check could explain). Each tip takes its Z from the cell's own footprint voxel rather than the island's single contact Z, so a stepped island no longer hangs tips in air, and a stub that would pierce the mesh (`branchCollidesWithSDF`) is skipped like every other member-creating path.
- **Gridless runs still merge**: candidates within `GRIDLESS_MERGE_RADIUS_MM` (4 mm) of an existing trunk join it. Among in-radius hosts, `findMergeHost` ranks by distance plus `MERGE_HOST_LOAD_WEIGHT` (0.5) × longest already-hosted member span — nearer wins, but merges avoid piling long members onto one plate anchor (Dumas gain shape). No hosted members → pure nearest-first.
- **Trunk routing is one diagonal and one drop, and the cone follows the shaft.** Placement goes through `calculateSmartPlacementV3` (`PlacementLogicV3/SmartPlacementV3.ts`), whose entire search is `EscapeJointSearch`: walk outward from the socket along a 45° ray in each candidate direction until the column below clears and the roots volume fits, then stop, so the trunk is a single diagonal, a single joint, and a vertical load-bearing span. The lean is 45° from vertical and does not escalate: a flatter leg cleared a wide obstacle below the tip by laying a flat member across the gap, which is a strut rather than a support, so a contact the shape cannot serve takes a pillar instead. The joint count stays at one. Multi-joint chains, lattice searches and contour-following routes are gone and should not come back: a vertical pillar is the strongest support, so the router's only job is to find the earliest point where vertical becomes possible and get there in one move. `resolveConeSocketAndAxis` resolves the socket and the cone axis as one decision, so the builder renders the direction the router picked instead of deriving its own, and the socket is placed on that axis. See [Support Pathfinding V3](support-pathfinding-v3.md).

## Settings and reporting

`settings.ts` declares roughly twenty knobs with `AUTO_SUPPORT_CONSTRAINTS` giving each a min/max/step/default — including two debug switches (`debugSupportOriginColors`, `debugSkipAutoBracing`, the latter for faster iteration). Use `normalizeAutoSupportSettings` / `applyAutoSupportSettingsPatch` rather than building the object by hand.

A run returns `AutoPlaceAnalytics` and a `ForestReport`; `forestReportToText` renders it for the placement summary. The report is the primary debugging surface — every decision includes a *why*.

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
- **PLACEMENT DIAGNOSTICS** — `Trunks by kind: grid 44 (ring + infill), gap-fill 0, standalone 41 (sub-threshold overhang, no host)`; `Candidates by source: voxel 49 · minima 21 · intersection 47 · overhang 98`; `Fan refusals: noHost=1 (too far >5mm/2.5mm grid, angle >45°, sameZ|cross|blocked|capacity)`; `Merge refusals: noHost=22, rejected=20`; `Consolidation refusals: blocked=99, cross=3 (sameZ=surface too flat for side-leaves — chunking needs ≥0.4 mm neighbour height rise)`. Sourced from `diagnostics` captured in `computeAutoSupportPlan`.
- **Counts** — `56 trunks · 70 leaves … | 16 trees, 40 bare` — `trees` are hosts with members, `bare` are 1:1 pillars.
- **FAN-OUT GROUPS** — `v115 @ Z=26.6mm Ø1.03mm [area 0.53mm² …] → 12: v116(L 2.8mm/20°) …`, headed by the gates that admitted its members: placement fans `≤leafFanMaxAngleDeg` within `LEAF_FAN_RADIUS_MM` (`GRID_HOST_FAN_RADIUS_MM` for grid hosts), chunk-consolidation links `≤CONSOLIDATION_MAX_ANGLE_DEG` within `CONSOLIDATION_FAN_RADIUS_MM`, and the `maxAttachmentsPerTrunk` cap in force — so a group is readable without re-deriving which pass attached each member. `spanMm`/`angleDeg` are `knot→tip` distance and angle from vertical, measured **after** the resize/orphan passes: segment splits and rehosting can drift a knot down its host, so a link can read shallower than the gate that admitted it.
- **STANDALONE TRUNKS** — `grid-o0-… @ Z=5.1mm Ø1.21mm [area 10mm² …]` plus `— region ring + grid infill` or `— standalone voxel/minima (below threshold or consolidated)` based on `id` prefix.

**Orphan reporting:** post-resize `rehostLegacyKnots` + `validateAndCullOrphans` cull `drift`/`missingHost`/`missingSegment` (orphan knot >0.5 mm off its host segment) and report `cross`/`blocked` without culling. `ForestReport.orphans[]` (`OrphanInfo`) and `forestReportToText` `ORPHANS CULLED` surface them. Drift is the "leaf attached to nowhere" case — host segment split rehost failed or knot was placed on a trunk that later split.

**Diagnostics reporting:** `ForestReport.diagnostics` captures `diagnostics.candidatesBySource`, `hostsByKind`, `fanRefusals`, `mergeRefusals`, and `consolidationRefusals` so the text report can explain *why* a candidate became a trunk/leaf/standalone vs fanned/merged — and why a region did not chunk (`sameZ` = surface too flat for side-leaves).

## Related pages

- [Support System](support-system.md) — the subsystem this places into
- [Stump](../reference/support-anatomy/stump.md) — what near-plate contacts become
- [Experiments Framework](experiments-framework.md) — the gate
