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

- **A huge steep flat is an overhang, not a self-supporting face.** `classify_overhangs` (`src-tauri/src/overhang.rs`) flags down-facing triangles below the self-support angle, then a second pass (`classify_steep_flats`) hands over patches in the `[self-support, STEEP_FLAT_MAX_ANGLE_DEG]` band whose 3D area reaches `STEEP_FLAT_MIN_AREA_MM2` and whose growth stays within `STEEP_FLAT_NORMAL_TOL_DEG` of the patch's running mean normal. The reason is toppling, not peel: a 60° face prints fine by itself, but drag on several square centimetres of it rotates a tall part about its bearing edge, and the only thing that resists is contact along that face — the "whole face plastered as if it were an overhang" a professionally supported leaning plate shows. They arrive as ordinary `overhang` regions, so the density grid, the triangle surface sampler and the perimeter ring apply unchanged. Three constants carry the rule, and all three are tuning knobs rather than physics: the growth tolerance keeps a sculpted face from fusing with its flat part (a crease splits them, so a patch is one face and not every steep triangle that touches it), `STEEP_FLAT_MAX_ANGLE_DEG` is where a vertical support can no longer do anything but graze the surface, and `STEEP_FLAT_MIN_AREA_MM2` is what separates a lever from a facet. The Rust tests derive their fixtures from those constants, so retuning them does not invalidate the rule the tests pin. Known false positive, accepted: a large *smooth* curved surface (a big sphere's 45–75° belt) is locally flat enough to pass.
- **Both steep-flat thresholds stand in for a topple margin, and the margin is now logged.** The angle band and the area floor are proxies for one question — does the moment the peel drag puts on the part exceed what gravity restores? `compute_stability_report` (`src-tauri/src/overhang.rs`) answers it for the same posed mesh: driving moment about a bearing-hull edge is `M_e = Σ A·sinθ·z·max(0, u·n̂_xy)` (face area, angle from horizontal, height above the plate, outward edge normal) and restoring is `ρgV·d_e` from the volume centroid. Both sides carry one unknown constant, so the criterion collapses to a single length: `S = margin / L*` with `margin = V·d_e/M_e` (mm) and `L* = p/(ρg)` (mm, peel pressure over resin weight density). The pose topples iff `L* > margin`. Nothing consumes it yet — it is logged as `[stability] <model>: margin …` by `scan_overhangs`, the one command every model passes through (the sideload path re-classifies there because its triangle ids do not match the rendered geometry, and the client-side fallback has nowhere else to run), and `computeStabilizationAnchors` logs its own `[Stabilization] stable|unstable … bearing … centroid depth …` verdict, so the two can be diffed on real models. **A second verdict is logged beside it, and it is the one that survives a leaning pose.** `L* = p/(ρg)` is metres long at real peel pressures (10–50 kPa against `ρg = 1.08e-5 N/mm³`), so the gravity margin reads "topples" for essentially everything, and every leaning model reports a *negative* margin — the mass is already outside its base, so the comparison carries no information. The force that actually restores a bottom-up print is **plate adhesion**, and it works on the same geometry with `σ` in place of `ρg·H`: `M_adh = σ·A_contact·d̄_e`, the bearing patch's first moment about the tipping edge (`d̄_e` is the *patch's* centroid depth — always positive, unlike the volume centroid's). The pair collapses to one dimensionless constant, `adhesion_ratio = A_contact·d̄_e / M_e`, and the pose lifts iff `p/σ > adhesion_ratio` with `p/σ` of order 0.005–0.05. Both are logged side by side until real prints settle which to gate on. **Diff before swapping the thresholds**: `margin` is infinite when no down-facing face leans, and `0` where a static margin does not exist at all — a bearing locus with no polygon (a point or edge contact) or a mesh enclosing no volume.
- **Zero-area triangles never define the plate plane or the bearing locus.** A genuinely collapsed face (a stray vertex on two zero-area triangles) otherwise puts the 2 mm contact band on the stray vertex alone, and `computeStabilizationAnchors` climbs the defect's own edges instead of the part's base. Both now skip degenerate triangles — the gate tests degeneracy in the *raw* frame (an affine world transform preserves collinearity, so it costs one cross product there), and the report counts them (`degenerate faces ignored (defective mesh)`). A no-op for any mesh without such triangles; it fires on real models (a 505k-triangle part reported 2). **Do not read an odd extent or an empty bearing polygon as a defect without checking the pose**: a 20 mm cube auto-oriented onto its side legitimately measures 30.8 mm tall with no bearing polygon (it touches on a corner), and the report's `centroid_mm` is world-absolute — read it against `plate_z_mm`, not against `height_mm / 2`, which is what made a clean cube look like a broken mesh. The same cube is a clean 12-triangle box on disk, and the loader's `refine_coarse_faces` pass (14 triangles, 9 vertices) leaves its bbox and volume untouched.
- **Gravity is a driving term, not a restoring one.** A bottom-up printer hangs the part from the plate, so in the model frame gravity points +z — away from the plate. It PEELS, and it adds to the drag instead of opposing it: the honest form is `tip iff M_drag + ρg·V·d_e > σ·A·d̄_e`. The report labels it that way (`gravity lever … · peel …MPa (driving, not restoring)`) and prints the term as a pressure so it can be read against `p`: `ρg·V·d_e/M_e`, which is ~1.9e-5 MPa on a 79 cm³ part — 0.06 % of a 30 kPa peel. Negligible, but not zero, and the sign was wrong: the earlier "margin = V·d/M against L* = p/(ρg)" framing was an FDM frame convention. The *binary* verdict survives the flip (a centroid outside the bearing patch peels in either frame), which is why the placement gate has behaved sanely throughout.
- **The bearing patch is the raft's, when there is a raft.** Without one the patch is the hull of the 2 mm contact band, which on a domed bottom is a spherical cap whose CENTRE WANDERS with the tilt while the centroid stays on the axis: a fraction of a degree moves the nearest hull edge past the centroid and flips the verdict (measured on one tool across five tilts: depth −9.43, −10.61, −1.14, +9.98, +10.58, adhesion 0.016 to 0.064). With a raft the printed contact is not that cap at all, it is the raft's footprint, centred under the part. The raft is built around supports that do not exist at scan time, so the report uses the model's **XY shadow** (the hull of its projection, `SHADOW_CELL_MM` quantized) as a lower bound on it: smooth under rotation, and it under-estimates the adhesion, which errs toward covering. The flag comes from `RaftSettings.bottomMode !== 'off'`, threaded from the page into `scan_overhangs` and read directly by `computeAutoSupportPlan` for the gate. The log names which one was used (`raft footprint` versus `band 2.0mm`).
- **Anti-topple coverage is gated on the adhesion verdict alone.** A steep flat is worth contact only if the pose can actually peel, so `needsToppleCoverage` (the conservative adhesion bound, in `poseStability.ts`) is asked by both consumers: `computeStabilizationAnchors` decides whether to lay anchors at all, and `computeAutoSupportPlan` drops `steepFlat` islands from the candidate set when it says no. The static "is the centroid over the base" test is deliberately NOT part of it: that is the FDM frame's rule, and it over-fires badly on a bottom-up printer where the part hangs from the plate. Gravity's share of the peel is measurable and tiny (`peel +4.7e-5MPa` on a 97 cm³ part, three orders below a real peel), so the pose it fires on, a part leaning with its centroid outside a small patch, is usually fine, and the adhesion ratio already covers the cases the static test stood in for (a point or edge contact has almost no area, so its ratio collapses toward zero). Measured on a cam seal tool: `bearing 310.2mm²`, `centroid depth -8.36mm`, `adhesion 0.067` against a conservative `p/σ` of 0.05, so no coverage, and it logs why: `Topple coverage not needed — 16 steep flats left uncovered (adhesion 0.067, centroid depth -8.36mm, bearing 310.2mm²)`.
- **Steep flats are braced, not carpeted.** A large planar face past the self-support angle forms fine on its own, so the density curve — tuned for formation, densest on flat ceilings — overstates what it needs: a `steepFlat` island keeps the density grid but at `STEEP_FLAT_SPACING_MULTIPLIER` (2.5) times the spacing, a sparse field of contacts rather than a lattice, and the topple job goes to `computeStabilizationAnchors`. On a low-poly model that distinction is everything — a 12-triangle plank's 81° side is one 500 mm² patch carrying 84 % of the pose's drag, and gridding it carpets the whole face. The braces are steered by the report the same pass measures: the drag pushes the part over the edge on `pushDirDeg`, so the material that *lifts* is on the far side and that is where the lever arm from the tipping edge is longest — teeth there rank above the rest under the anchor cap, and a lone-point contact stays symmetric because a point has no static margin in any direction. They climb to `dragTopMm` (the highest face that drags) rather than a fraction of the part's height, and a buttress is spaced `BUTTRESS_SPACING_MM` (8 mm) apart, not the 2.5 mm the continuous base line needs. The gate also fires on the adhesion verdict, conservatively (`CONSERVATIVE_P_SIGMA = 0.05`): a part can stand on its base and still lift off it, and the logged ratio is computed from the model's own bearing patch, which is smaller than the printed contact whenever a raft is used.
- **A region carries the drag moment it owns.** `OverhangRegion` reports `drag_moment_mm3` (`Σ A·sinθ·z` over its triangles, `z` above the part's own base — the sum `compute_stability_report` totals for the pose), `drag_dir_deg` (the XY direction its drag pushes the part, i.e. the side that lifts) and `steep_flat` (whether it came from `classify_steep_flats`). A steep face is self-supporting for formation, so contact on it only resists toppling, and the patch's share of the pose total is the constant-free measure of how much of that job it owns — which is the number a placement rule needs to stop carpeting a face that carries almost none of it. The overlay ramps its colour by that share (`IslandOverhangOverlay`): a formation overhang stays flat orange, a topple patch runs cool-to-hot with the fraction of the pose's drag moment it carries, normalised by the largest patch in the scan so no constant is involved. A vertex weight shared by the patches meeting there (`toppleVertexWeights`) keeps it from reading as triangle painting: the rasteriser interpolates from one patch's colour to the other's instead of stepping at the shared edge. The colours travel as shader uniforms, never as a vertex colour attribute: three converts a uniform exactly as it converts `material.color`, and only the scalar weights are per-vertex. An alpha feather at the painted set's outer edge was tried and removed, because semi-transparent overlay triangles glitch against the model. `scan_overhangs` logs the top four: `[stability] regions by drag moment (pose total 179063mm³): #2 steep 62° 1180mm² z 8.5-46.2 M 98000 (55%) dir 175° · …`. See `docs/dev/backlog.md` for the placement rule this is meant to feed.
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
- **The collision predicate answers for a lattice point, not for the point you asked about.** `SDFCache.segmentBlocked` and `distanceAt` quantize the query to a 0.5 mm cell (`quantizeToCell` rounds) and return the signed distance at that cell's lattice point, so the value can be wrong for your point by up to the distance between the two. Anything using it as a *bound* must subtract that distance first, which `segmentBlocked` now does: it settles `clear` above `base - gap`, `blocked` below `base + gap`, and asks a point-exact bounded query between them. Skipping that is what let the march jump over geometry inside `clearance` — a column 0.5976 mm from the model at clearance 0.7 mm came back clear, so a routed support could clip the model. Do not verify a predicate with `distanceAt` either: it is quantized the same way, and reported 0.798 for a point that was 0.598 mm from the surface. The residual approximation is the `minStep` floor, so `blocked` from `ColumnClearanceMap` can still exceed the march's by one probe in ~2800 — see `docs/dev/backlog.md`.
- **Trunk routing is one diagonal and one drop, and the cone follows the shaft.** Placement goes through `calculateSmartPlacementV3` (`PlacementLogicV3/SmartPlacementV3.ts`), whose entire search is `EscapeJointSearch`: walk outward from the socket along a 45° ray in each candidate direction until the column below clears and the roots volume fits, then stop, so the trunk is a single diagonal, a single joint, and a vertical load-bearing span. The lean is 45° from vertical and does not escalate: a flatter leg cleared a wide obstacle below the tip by laying a flat member across the gap, which is a strut rather than a support, so a contact the shape cannot serve takes a pillar instead. The joint count stays at one. Multi-joint chains, lattice searches and contour-following routes are gone and should not come back: a vertical pillar is the strongest support, so the router's only job is to find the earliest point where vertical becomes possible and get there in one move. `resolveConeSocketAndAxis` resolves the socket and the cone axis as one decision, so the builder renders the direction the router picked instead of deriving its own, and the socket is placed on that axis. See [Support Pathfinding V3](support-pathfinding-v3.md).

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
