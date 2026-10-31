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
| 1 | Generate candidates | Turn detected islands into `CandidatePoint`s, then the two anchor-broadening passes: stabilization anchors, minima reinforcement |
| 2 | Deduplicate | Collapse candidates that would support the same spot |
| 3 | Place | The bulk of the work — fixed-density ring + grid infill distribution, trunk/leaf decisions, collision checks, gap filling |
| 4 | Forest resize | Re-derive every trunk's stepwise diameter now that the forest is known |
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

- **Boundary ring** — the region's perimeter resampled at fixed spacing in the
  2D-projected plane (`sampleBoundary2D`). Projection is the point: Z does
  not lengthen a boundary, so a sliver's ring is a short line and can never
  climb a limb. Each sample's Z comes from the surface sampler.
- **Grid infill** — a lattice over the footprint bbox at `computeRegionSpacing`
  (angle + suction curve; the spacing holds at the flat end until
  `SLOPE_RELAX_RAMP_START` of the way to the self-support angle — see the rules
  below), skipped for slivers and for footprints thinner than
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
    An area-derived shaft curve **inverted the profiles**: a light 16 mm² cell sized *thicker* (1.28 mm) than a heavy 5 mm² cell (1.12 mm), because the curve rose with cell area. Sizing reads the **band the run's tier resolves to** — the seven numbers (shaft, tip contact/length/penetration, root diameter/disk/cone) of the Support Studio preset `autoSupport.sizingPreset` names — and never the cell's area. `SIZING_BANDS` (detail ≈ 0.8, structure ≈ 1.0, anchor ≈ 1.4 shafts) mirrors what the three factory presets carry and is the *fallback* table, not the source of truth. See the header comment in `parameterSizing.ts`.

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

All five branch sites carry it — the merge path, `fanLeafToHost`, `buildConsolidationBranch`, the coverage-stub branch, and the grid attach in `PlacementLogic/Grid/gridPlacement.ts` (which also uses the floored radius for its own clearance check before falling back). A leaf needs nothing: its cone body already **is** the host shaft, by `syncContactConeDiameters`.

This is the member-side counterpart of the forest resize, which runs the other way: the resize thickens a **host** to match its fattest member, the floor thickens a **member** to stay within `memberHostShaftRatio` of its host. Neither can feed the other — a member at 0.7 of its host is never the fattest thing on it, and the host diameter measured identical with the floor on and off.

**Where the thickness actually comes from (finding, not tuned here).** The floor is relative, so it cannot make a forest chunky by itself — it only tracks a host that is already thick. The host's own diameter is the model-scale term: at ×1.6 the harness hosts sit at 1.62 mm against a 1.0 mm band, and with the model terms at ×1 they sit at 1.01 mm (measured: sizeScale 1 → 1.01, 1.25 → 1.27, 1.6 → 1.62, 2.0 → 2.03). A `base Ø1.00 · h1.25 → Ø1.93mm` note is therefore ~×1.55 of model factor, not height alone (the note prints only `h`; see the two findings in the forest-report section). `MAX_SHAFT_DIAMETER_MM` is not the binder anywhere near the reported sizes: at ×2.0 every harness host reads 2.03 mm and none at ×1.6 does — and that ×2.0 is the user's own `sizeScale`, which is allowed past the cap by design. Retuning those factors is a separate decision.

## Rules worth knowing before you change placement

- **A mesh patch is grounded only when its top is at the plate, not when its contact is.**
  An overhang region's `contact` is its lowest footprint pixel, so the plate-contact
  filter reading that alone wrote off a domed underside that touches the plate at one
  point and climbs 15 mm: `annotateFilterFlags` marked the whole patch `grounded`, the
  default toggles dropped it from `filteredIslands` (exactly what the Auto-Support
  panel hands the run), and a part resting on the plate placed almost nothing while the
  same part lifted 5 mm got a full forest. Grounding now asks the patch's own top
  (`maxZ`) as well; islands that declare no top (voxel sections, minima) keep the
  contact rule, where the contact *is* the base. Contacts closer to the plate than a
  stump's root height still cannot be served and are refused as `STUMP_BELOW_ROOT`
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
- **Anti-topple coverage is gated on the adhesion verdict alone.** A steep flat is worth contact only if the pose can actually peel, so `needsToppleCoverage` (the conservative adhesion bound, in `poseStability.ts`) is asked by both consumers: `computeStabilizationAnchors` decides whether to lay anchors at all, and `computeAutoSupportPlan` drops `steepFlat` islands from the candidate set when it says no. The static "is the centroid over the base" test is deliberately NOT part of it: that is the FDM frame's rule, and it over-fires badly on a bottom-up printer where the part hangs from the plate. Gravity's share of the peel is measurable and tiny (`peel +4.7e-5MPa` on a 97 cm³ part, three orders below a real peel), so the pose it fires on, a part leaning with its centroid outside a small patch, is usually fine, and the adhesion ratio already covers the cases the static test stood in for (a point or edge contact has almost no area, so its ratio collapses toward zero). Measured on a cam seal tool: `bearing 310.2mm²`, `centroid depth -8.36mm`, `adhesion 0.067` against a conservative `p/σ` of 0.05, so no coverage, and it logs why: `Topple coverage not needed — 16 steep flats left uncovered (adhesion 0.067, centroid depth -8.36mm, bearing 310.2mm²)`.
- **Steep flats are braced, not carpeted.** A large planar face past the self-support angle forms fine on its own, so the density curve — tuned for formation, densest on flat ceilings — overstates what it needs: a `steepFlat` island keeps the density grid but at `STEEP_FLAT_SPACING_MULTIPLIER` (2.5) times the spacing, a sparse field of contacts rather than a lattice, and the topple job goes to `computeStabilizationAnchors`. On a low-poly model that distinction is everything — a 12-triangle plank's 81° side is one 500 mm² patch carrying 84 % of the pose's drag, and gridding it carpets the whole face. The braces are steered by the report the same pass measures: the drag pushes the part over the edge on `pushDirDeg`, so the material that *lifts* is on the far side and that is where the lever arm from the tipping edge is longest — teeth there rank above the rest under the anchor cap, and a lone-point contact stays symmetric because a point has no static margin in any direction. They climb to `dragTopMm` (the highest face that drags) rather than a fraction of the part's height, and a buttress is spaced `BUTTRESS_SPACING_MM` (8 mm) apart, not the 2.5 mm the continuous base line needs. The gate also fires on the adhesion verdict, conservatively (`CONSERVATIVE_P_SIGMA = 0.05`): a part can stand on its base and still lift off it, and the logged ratio is computed from the model's own bearing patch, which is smaller than the printed contact whenever a raft is used.
- **A region carries the drag moment it owns.** `OverhangRegion` reports `drag_moment_mm3` (`Σ A·sinθ·z` over its triangles, `z` above the part's own base — the sum `compute_stability_report` totals for the pose), `drag_dir_deg` (the XY direction its drag pushes the part, i.e. the side that lifts) and `steep_flat` (whether it came from `classify_steep_flats`). A steep face is self-supporting for formation, so contact on it only resists toppling, and the patch's share of the pose total is the constant-free measure of how much of that job it owns — which is the number a placement rule needs to stop carpeting a face that carries almost none of it. A large flat is also the best ANCHORING surface a part has, which is why coverage is not left to the verdict alone: `steepFlatNeedsCoverage` keeps the contacts of any flat at least `STEEP_FLAT_ANCHOR_MIN_AREA_MM2` (150 mm², 3D) whether or not the pose needs rescuing. Size and not share of the drag, because anchoring value is about room: planar, so a contact on it has a well-defined normal and cannot graze; large, so contacts spread instead of crowding an edge; and facing the direction the part would move, so holding it holds the part. The floor is where a flat stops having room for contacts at all (a tip covers ~3mm, so a handful want ~100mm²); above it the band and the spacing make the judgement, so a 465mm² face on a 42mm figurine and a 400mm² face on a 22mm cube both get a low band. An earlier 1000mm² floor refused both.

Anchoring contacts stay LOW (`steepFlatAnchorBandTop`) on a squat part: the lowest third of the flat, or 6 mm, whichever is more. **A slender part is the exception, and the reason is a third failure mode.** Formation, rigid-body toppling and elastic sway are three different problems, and only the first two had mechanisms: a wall tall and thin enough (past `SLENDER_RATIO` = 4 times its own thickness, `height / (volume / footprint)`) flexes under the peel's lateral load while it prints, which is what shows up as wiggling and Z lines on a 126 mm plate 7 mm thick. A contact only stops the sway at its own height, so a slender part's anchoring ladders up the steep flat instead of banding at the bottom, and the spacing between those contacts is capped by the part's own thickness (`steepFlatSpacingMultiplier`). That cap is the physics, not a switch on shape: the rung spacing is a beam span, and the sag between two contacts goes as the span to the fourth power, so it has to stay under the thickness whatever the sparse field would like. A 7mm wall lands at 7mm, a 30mm-thick part keeps the full 2.5x sparse field, and anything thinner than the formation spacing is floored there. The 2.5x exists because a face past the self-support angle needs no formation contact; a swaying wall is the opposite case, and the density moves continuously with the part instead of jumping at a ratio. Both the report (`slenderness` in the log, `height 126.2mm (11.3x)`) and the placement (`isSlenderPart`) read the same ratio. A tip's job is to stop the part moving, and low contacts are short, stiff and cheap, while the reach that resists a topple moment is the stabilization braces' job. Without the band the grid climbs the face, because a near-vertical patch has a thin XY footprint whose cells map up its height, which is how a leaning 20 mm cube sprouted supports two thirds of the way up. Formation overhangs are not banded: they have to hold material at height.

The overlay ramps its colour by that share (`IslandOverhangOverlay`), and it shows what the placement will actually cover: `scan_overhangs` returns the topple report alongside the regions (`OverhangScan`), `scanNeedsCoverage` reduces it to the placement's own rule, and patches the placement will not touch render muted (`MUTED_OPACITY`) instead of at full strength, per patch, using the placement's own `steepFlatNeedsCoverage`. Painting everything that was classified reads as "this will be supported", which is exactly what it is not. It ramps: a formation overhang stays flat orange, a topple patch runs cool-to-hot with the fraction of the pose's drag moment it carries, normalised by the largest patch in the scan so no constant is involved. A vertex weight shared by the patches meeting there (`toppleVertexWeights`) keeps it from reading as triangle painting: the rasteriser interpolates from one patch's colour to the other's instead of stepping at the shared edge. The colours travel as shader uniforms, never as a vertex colour attribute: three converts a uniform exactly as it converts `material.color`, and only the scalar weights are per-vertex. An alpha feather at the painted set's outer edge was tried and removed, because semi-transparent overlay triangles glitch against the model. `scan_overhangs` logs the top four: `[stability] regions by drag moment (pose total 179063mm³): #2 steep 62° 1180mm² z 8.5-46.2 M 98000 (55%) dir 175° · …`. See `docs/dev/backlog.md` for the placement rule this is meant to feed.
- **Every member must clear the branch-angle rule — and the gate looks at the shaft, not the chord.** `memberMaxAngleFromVerticalDeg()` derives the steepest lean a member may take from the user's branch angle (`grid.minBranchAngleDeg`, **60° above horizontal** ⇒ ≤30° from vertical) — the same rule the grid attach path enforces through `getLengthAwareMaxAngleFromVerticalDeg`. It bounds every auto path: the placement fan (`min(leafFanMaxAngleDeg, 30°)`), the merge knot search (`STEEP_MIN_RISE_DEG = max(45°, minBranchAngleDeg)`), the routed-branch caps, and the chunk-consolidation relaxation below. `branchDepartureAngleDeg()` then re-checks the **built** branch where it actually leaves the host (knot → first shaft joint): the contact cone is clamped toward the surface normal, so a branch can pass the knot→tip gate and still run out nearly level, bending into a steep cone only at the tip — on a speck field every branch chord read 30° while every shaft left at 42°. A member that would sag is refused and its pillar stays standalone instead. The consolidation routed-branch host pick therefore aims at the *steepest* eligible sample rather than the nearest: the cone bend eats the last couple of millimetres of rise, and reaching further down the shaft buys it back. Before this the fan used 45°, merge 45° rise and consolidation 75° from vertical, and nothing consulted the configured branch angle at all.
- **Overhang pillars consolidate into chunk trees.** After placement, neighbouring ring/infill/standalone pillars (and the reinforcement origin, the one non-overhang host flagged convertible) fan into each other (`CONSOLIDATION_FAN_RADIUS_MM`, 8 mm — an upper bound, not a target, capacity `maxAttachmentsPerTrunk`) — supports release in chunks with one plate contact per chunk. Consolidation asks `fanLeafToHost` for the **nearest** eligible host (`hostOrder: 'nearest'`), where placement fanning asks for the steepest: a chunk link is a local tie between neighbouring pillars, and steepest-in-reach skips the adjacent pillar for a taller one up to the full 8 mm, which reads as a stray 6–8 mm diagonal across the lattice. The consolidation angle is relaxed past the placement fan — `min(max(leafFanMaxAngleDeg, CONSOLIDATION_MAX_ANGLE_DEG = 75°), 90° − minBranchAngleDeg)` — because on a surface sloped <45° from horizontal, neighbouring pillars can never satisfy the placement gate (the link angle is always 90° − surface slope), so chunking would be geometrically impossible. The branch-angle rule still caps the relaxation, so links shallower than it leave the pillar standalone. The chunk's interior hosts carry the load; the links that survive are connective tissue. Same-height pillars (vertical drop < 0.4 mm) never straight-fan; when the straight leaf is blocked, crosses, or the surface is too flat AND the tip sits at ≥ `CONSOLIDATION_BRANCH_MIN_HEIGHT_MM` (10 mm), a **routed branch** attaches it to a host shaft instead — high above the plate that reads as a tree; near the plate it is suppressed (it would read as a zig-zag web). Near-plate contacts (tip Z < `ANCHOR_HEIGHT_THRESHOLD_MM`, 5 mm) place as [stump](../reference/support-anatomy/stump.md) primitives and stay standalone.
- **Grid trunks are fanning hosts only up close.** `GRID_HOST_FAN_RADIUS_MM` (2.5 mm) is deliberately tighter than the general `LEAF_FAN_RADIUS_MM` (5 mm), so fan leaves do not sweep across the grid forest and puncture its shafts.
- **Long spans become branches, not leaves.** A leaf is a seg-less tapered cone (host-diameter body → ~0.28 mm contact), so past ~6 mm it reads as a spindly spike next to its trunk. Island spans over `MAX_LEAF_SPAN_BEFORE_BRANCH_MM` (6 mm) route to branches with real shafts in both the merge path and `fanLeafToHost` — measured knot→tip (the span the member actually bridges), not tip-to-host-tip, which understates it when the knot sits low on the shaft. Failed branch attempts fall through to the next candidate or the standalone-trunk path, never to a long cone. **Every origin routes, overhang included.** Overhang fanning used to stay a leaf by rule past the threshold, which is how a merged 11.6 mm tapered spike got built next to its trunk: the threshold is about the *member's* shape, not about which surface the tip touches, and `buildConsolidationBranch` has always built overhang-origin branches. A candidate whose link is past the threshold now gets a branch or (when no host sample gives one a legal departure) a pillar of its own — the consolidation pass merges pillars into chunk trees, which is the designed remedy for pillars standing next to fan leaves.
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

- **A tip the lattice cannot serve is placed without the grid.** Grid mode refuses a candidate whose node is occupied and whose attachment to the host standing there is refused too (two contacts at one height give a branch nothing to rise over, which is the `sameZ` refusal), and those refusals used to drop the tip: the run reported `grid_reject_no_attachment` and the island stayed unsupported. The candidate is now retried with the grid off **for that candidate alone** (`placeOneCandidate(..., ignoreGrid)` → `buildTrunkData`'s `ignoreGrid` → `SmartPlacementV3Context.ignoreGrid`), so it lands as an ordinary free-standing placement beside the lattice instead of nowhere. The retry cannot recurse, since it leaves the grid disabled inside, and its own gates (collision, side-wall cone, attachment angle) still decide whether it places at all. The report counts them as `Grid fallbacks` in PLACEMENT DIAGNOSTICS, which is how a pillar that is off the lattice is explained rather than looking like a bug. Measured on the synthetic corpus in grid mode: 36 tips that were rejected now place, and coverage on the sloped model rises from 92.8% to 98.0%.

- **A contact whose cone renders within 15° of flat is refused.** `isSideWallContact` (`MAX_SIDE_WALL_CONTACT_LEAN_DEG`, 75°) runs on the trunk build at placement, before the grid decision, so it applies to every source — overhang, minima, intersection, and the anchoring contacts on a steep flat. It measures the **rendered cone axis**, not the surface normal, because the cone policy rotates one away from the other: a contact on an 80.8° face is refused under `normal` (80.8°) and kept under `adaptive` (55°). Minima used to be exempt up to 85°, which kept contacts whose cones render sideways; that exemption is gone. A contact past the bound is refused outright rather than served by a leaf or branch, because the cone is the part that reads as a whisker whichever member carries it.
- **A voxel island records that material starts unsupported, not how steep the surface is.** A wall steeper than the self-support angle prints on its own, so a shaft there resists nothing — the "supports on the side of the bow" report. Before candidates, the run asks `resolveSurfaceNormal`; when both vertical rays miss (which is what a side wall does), `closestSurfaceNormal` takes the nearest triangle and its inclination `acos(|n.z|)`. Islands steeper than the setting are dropped. The vertical resolver is still preferred where it hits, so a punched ceiling is not mistaken for the hole's vertical rim.
- **Leaf fanning walks `islandsToCover`, not the raw island list.** The steep-flat gate drops a self-supporting wall when the pose is stable; fanning the raw list bypassed that gate and stuck leaves on the face anyway. Internal islands are skipped here too.
- **A fan link is pre-tested as the member it will become, not as a bare ray.** A leaf is one tapered contact cone from the host to the tip, and a cone is allowed to touch the surface it points at, so the cheap gate asks `contactConeCollides` the same question the orphan validator asks at build time. It used to walk a bare 0.2 mm-clearance ray *to* the tip, which refused every link onto a flat: the tip sits on the surface, and the last stretch of any ray to it is inside the shaft keep-out however steep the link is. A branch is a real shaft, so it is still tested, to a point `FAN_LINK_TIP_INSET_MM` (0.5 mm) short of the tip, because its own collision test runs after it is built. Measured on the dense flat fixture in gridless mode: 976 consolidation links refused as `blocked` before, none after; plate contacts 438 became 208, bare hosts 308 became 0, and coverage stayed at 100%.

- **The fan reaches in plan, and the wide tier only fires when nothing is in reach.** `fanLeafToHost` admits a host sample by its *lateral* distance (`fanRadiusMm`, or `GRID_HOST_FAN_RADIUS_MM` for a grid host), the `vDist ≥ 0.4 mm` rise floor, and the branch-angle gate. The reach is a **plan** distance: run on the full 3D distance — as it was — the drop counts as if it were lateral, so on a tall thin host the samples inside the radius are the ones near its top, which are exactly the shallow ones the angle gate refuses, while the steep sample that would have been legal sits further down, outside the radius. Such a tip found no host at all (`noHost`) or only shallow ones (`angle`), and stood alone as a 1:1 pillar or crossed to the model as a stick — two contact scars where a carried tip leaves one. A tip with nothing inside the normal reach now gets a second, wider search (same plan reach, span capped at `reach / sin(maxAngle)`, so a grid host's rescue stays short), ordered by the **shortest** legal link rather than the steepest: that tier exists to remove a lone pillar, not to add material. Tier 1 is untouched, so every placement that already worked keeps its look.
- **Fanning attaches to segments, not entities.** `collectFanShaftPoints` samples per-segment (`segmentId` + `t`) and `fanLeafToHost`/`buildConsolidationBranch` create knots with `parentShaftId: segmentId, t` — not the entity id. Legacy knots keyed to the entity are rehosted to the nearest segment before `computeForestDiameterProfile` so diameter demands include fan leaves and drift checks use segment geometry. `countAttachmentsOnHost` handles both for backward compat. The host pool, merge search and capacity checks all walk `GRID_HOST_TYPES` — the types declaring `canBeGridHost` — so a second hostable type is offered as a host without a second edit.
- **The merge search reaches in plan, and snaps the knot to the highest legal sample.** `findMergeHost` admits a host by its **plan** distance for the same reason the fan does (above), and unlike the fan it selects only a *host*: the attachment is then snapped to the highest legal sample on that host's shaft (`ATTACH_SEARCH_STEP_MM`, 0.5 mm), so a candidate level with, or above, the host's joints still attaches lower down its shaft. Before either change, two pillars of equal height 2–4 mm apart reported `noHost` — every legal attachment was further down the neighbour's shaft than a 3D ball around its tip reached — and stood as two plate contacts. The knot walk also used to take the highest of 11 fixed fractions of the shaft, which on a 20 mm shaft lands up to 2 mm below the rung it was after: enough to push a member across the 6 mm leaf/branch threshold by sampling error alone, after which the branch path's departure rule refuses it and the whole link falls back to a standalone pillar.
- **A host, and therefore its knots, belong to one model.** The snapshot holds every model's forest and `collectFanShaftPoints` samples all of it, so host selection filters on the host's `modelId`: `fanLeafToHost`, `buildConsolidationBranch`, the consolidation conversion loop and the flat-island stub pass all `continue` when the host belongs to another model. Unfiltered, a run for one model attached its leaves to a neighbouring model's shafts, created knots on that model's segments, and -- worst -- *converted that model's bare standalone pillars into its own leaves* (conversion deletes the pillar). `findMergeHost` is the one path that always filtered.
- **Auto knot ids must be free in the draft.** `draftAddPrimitive` REPLACES on an id collision instead of failing, and auto knot ids derive from candidate/island ids -- which restart per scan (`v0`/`m0`/`o0`, so two models rebuild the same ids) and repeat across gap-fill passes. A reused id silently re-parents the member that already owned that knot onto this run's host shaft, rendering as a long member reaching across from the other model's structure. `freeKnotId` allocates the free id at every member-creating site: the two fan paths, `buildConsolidationBranch`, and the merge path.
- **Relaxation toward the slope spacing is a last stretch, not a ramp from flat.** `computeRegionSpacing` blends `flatDensityBoost` (0.7 ⇒ ~2× the supports) to `slopeRelaxFactor` (1.3 ⇒ ~0.6×) by the region's angle from horizontal, and it used to blend **linearly from 0°** to the self-support threshold: a 25° underside — a shallow *formation* overhang, which peels and needs the density exactly as a flat ceiling does — took 56% of the relaxation. Only the end of the band prints by itself, which is what relaxation is for, so the ramp now starts at `SLOPE_RELAX_RAMP_START` (0.6 ⇒ 27° at the 45° default) and runs from there to the threshold. It is continuous (the flat value holds *at* the start, so the spacing does not step) and the knob keeps its meaning at the end of the band it names. Measured on the corpus's own 25° underside (`sloped-cantilever`: 215 → 337 candidates, 183 → 313 contacts, member volume 1299 → 2087 mm³) while **every other entry stayed byte-identical** — the 0° ceilings and the 60° steep flat included. That last part is the shape such a change has to have: one angle band moving, not the whole density curve. The consequence to know: below the ramp's start `slopeRelaxFactor` has no effect, because nothing there is a slope in the sense the knob means.
- **Orphan validation after resize.** After `computeForestDiameterProfile` the pipeline rehosts legacy knots and runs `validateAndCullOrphans` (drift >0.5 mm, missing host/segment culled; `cross`/`blocked` reported but kept). A knot on a top segment is valid — top segments carry no `topJoint` by design, so the host trunk's contact cone stands in as the segment top. Culled leaves/branches and their orphan knots are removed, `ForestReport.orphans[]` lists `id/kind/reason/hostId/knotId/detail`, and `forestReportToText` emits `ORPHANS CULLED`. This is where the "leaf attached to nowhere" (drifted knot after a host trunk’s diameter split) is caught — check the report before the render.
  - **A knot must be placed on the same line the drift check measures.** `hostSegmentSpan` is the single resolver for a host segment's world span (root top when the bottom segment carries no `bottomJoint`, contact cone when the top segment carries no `topJoint`), and both the merge knot search and `validateAndCullOrphans` go through it. Do not give either side its own fallback: they used to differ — the search fabricated `(0, 0, rootTopZ)` — and the two lines coincide only for a trunk rooted at the world origin, so every member merged onto an off-origin host was placed beside its shaft and then culled as `drift`. A support that is placed and then silently culled leaves its island unsupported with only a `drift` line in the report to show for it; the members are not re-placed, so the coverage number is the only other clue.
- **Contact resolution is hole-tolerant.** `resolveSurfaceNormal` casts upward from just below the candidate (underside contact), then downward from above (top-surface contact, normal flipped), and walks a small disc of lateral offsets (radii 0, 0.75, 1.5, 2.25 mm) before giving up. A punched drain hole directly above the candidate used to swallow the single upward ray, after which the downward fallback landed on the far side of the wall — in a cavity, on the floor with a flipped normal — and the candidate was rejected outright, so the interior ceiling lost every support the moment a hole was punched through it. A hit below the candidate is never accepted, in either direction.
- **A candidate within `ALREADY_SUPPORTED_RADIUS_MM` (3 mm) of an existing tip is already supported** and is skipped.
- **Twigs test with rays and reach their own length.** A twig is the short model-to-model bridge a cavity fallback places (drop ≤ `stickVsTwigCutoffMm`), and it is the one member whose whole job happens *inside* a thin gap — where the signed-distance field cannot be trusted: it signs from the nearest triangle, and in a gap between two facing faces the nearest one changes across the gap, so the empty space reads as material (measured: the midpoint of a 1.5 mm gap between a header and the body reports −0.75 mm, "inside"). Every SDF gate therefore refused twigs by construction, automatically and by hand. `buildTwig` and the cavity path check twigs with `checkShortBridgeCollision` — ray casts, which need no sign — and that check is *inset* from the sockets, because a socket sits on the surface it touches and a whisker offset from it starts inside the material (which refused every canted twig). The cavity search also reaches sideways as far as a twig may span (`stickVsTwigCutoffMm`, radii 0.75 mm steps out to the cutoff) so a pointed tip can be propped off the surface beside it; a member found that way must be a twig — sticks keep the near search and their near-vertical gate. Larger members (sticks, trunks, branches) keep the SDF: their clearance question is genuinely three-dimensional. **The twig's verticality gate lives in its registered builder** (`Twig/twigVerticality.ts`, `MAX_TWIG_SHAFT_ANGLE_DEG` 45°, enforced in `twigRegistration.ts` beside the stick's 20°): the gate measures the *built shaft* (socket to socket), because a sloped or sidewall landing's standoff is what shoves a grazing twig sideways, and past that cant the member is a near-horizontal whisker hanging the island off a strut that carries no load. It used to live only in the cavity fallback, so a twig built anywhere else — the manual bridge controller, any future path — slipped through with no gate at all. Measured: thin-gap and floor twigs build at ≤17°, pointed-tip props off a wall with a real drop land 23–43°, and the grazers start at 48°.
- **The cavity fan is the widest host search, and its refusal carries the numbers.** A tip with no plate route (`buildTrunkData` → `COLLISION_WITH_MODEL`) is first offered to a nearby host at `CAVITY_FAN_RADIUS_MM` (12 mm, plan) — the same reach for a grid host, because the 2.5 mm grid limit exists to keep ordinary fan leaves from sweeping across the grid forest and that reason does not apply to a tip whose only other outcome is a model-to-model bridge with a second contact scar on the model. The log line `noHost` alone cannot say whether there was no host or only a far one, so `fanLeafToHost`'s failure returns `nearestHostMm`, `nearestSteepMm` and `steepAngleDeg` and the report prints `fan:noHost (nearest 11.7mm plan, no legal host)` or `… (nearest 3.4mm plan, nearest legal 13.5mm @ 29°)`. Read it before tuning any reach: it separates "nothing is close" from "something is close but only at an illegal angle" from "the host is there but the link runs through a wall". **This search also passes `rescueSpanOverrideMm: Infinity`.** The wide tier's derived cap (`reach / sin(maxAngle)`) is right for ordinary placement, but a cavity tip is usually at the TOP of its feature, with the nearest host close in plan and low — so every sample that clears the angle gate makes a long link, the cap refuses all of them, and the tip becomes a stick. An observed case read `noHost (nearest 2.2mm plan, no legal host)` with the host 2.2mm away and 28.6mm below. Since the wide tier takes the shortest legal link, lifting the cap spends no more than that geometry forces, and the result is a near-vertical branch (one contact scar) where the stick had two.
- **Cavity fallback: bridge down, then just off vertical.** A tip with no plate route (`buildTrunkData` → `COLLISION_WITH_MODEL` — e.g. the ceiling of a hollow model's cavity) is first offered to a nearby host, then bridged model-to-model by `buildCavityBridge`: a downward raycast finds the surface below and the drop chooses a stick (`> stickVsTwigCutoffMm`) or a twig. The cast walks a small disc of verticals around the tip (radii 0, 0.75, 1.5, 2.25 mm, nearest radius first) rather than one straight-down ray — a punched drain hole or a gap directly under the tip used to swallow the single ray and leave the contact with no support at all, which is what "no supports inside the cavity once holes are punched" was. `MAX_SHAFT_ANGLE_DEG` (20°, in `stickVerticality.ts` — the stick's registered bridge builder applies it) caps the cant and the post-build shaft check rejects any bridge that pierces the model, so the wider search cannot produce a crooked stick. Twigs get the same shape of gate from their own registered builder (`Twig/twigVerticality.ts`, `MAX_TWIG_SHAFT_ANGLE_DEG` 45°), which no longer lives in this path.
- **An internal contact may only bridge inside the cavity.** Before candidates are generated, the run classifies every island against the cavity mesh the Auto-Support panel hands the worker (`getCavityGeometry` → `cavityMesh` in the payload): the cavity mesh is part of the hollowed model mesh, so an interior contact lies **on** it (within 0.15 mm) while an exterior contact is at least one shell thickness away (minimum 0.2 mm). Distance is normal-agnostic: a winding-convention mismatch cannot invert the answer. Such a candidate carries `interior: true`, skips the plate trunk and the cavity fan entirely, and is placed only by `buildCavityBridge` — or rejected. Interior grid regions also use `INTERIOR_CAVITY_SPACING_SCALE` (3) times the normal spacing — one ninth the contacts — and coverage convergence skips them: a short model-to-model bridge carries less peel than a full-height pillar, and the dense cavity forest was hard to see and remove. Before this, a hollow part with a bore or a floor opening gave the router a legal plate route, and supports ran from the plate through the cavity and out through the shell: the "internal supports shoot through the model" report. The fanning pass skips `interior` islands for the same reason.
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

- **The strip is one row.** The `SelectDropdown` lists presets — built-ins first, then the user's own, each row carrying a right label (`<tier name> · Built-in` / `<tier name> · Custom`, the tier being the Support Studio preset the block names, resolved by `sizingTierName`) and the active one ticked — with `Rename`, `Export` and `Import` beside it and nothing else (the LUT's row, 1375-1398). Row styling and right labels follow that selector and the theme profile dropdown (`src/components/settings/UISettingsTab.tsx`).
- **The menu carries one entry** under the presets: `New` (`menuFooterAction`, plus icon, accent tone — LUT 1359-1364, themes 297-301). `Rename`, `Duplicate`, `Export` and `Import` are in the row beside the trigger, so nothing management-shaped lives in the menu.
- **The footer is the LUT's** (1498-1532): `Delete` alone on the left in the LUT's own filled-danger treatment (1498-1511), greyed out for a built-in, then `Reset` and `Save` on the right. The LUT's `Reset` restores the draft from the snapshot taken when the editor opened (`handleResetDraft`, 1043-1052) — it *discards uncommitted changes*, it is not a factory restore — and its `Save` commits the draft (`handleSave`, 1035-1041). Both are disabled until there is something to discard or commit. Ours map as: `Reset` reloads the active preset over the dialog (discarding the draft), `Save` commits the draft — one call, `commitAutoSupportSettings`: the live settings *and* the active preset when the draft has drifted from it, so the preset the user was editing is what the star clears on, never a second save. It leaves the dialog open and acknowledges on the button (`Saved!` in the success tone for two seconds), because the preset list it acts on sits behind the dialog: closing would send the user looking for a result they cannot see. There is no separate `Apply`. `Delete` confirms through `StructuredDialogModal` and is refused for a built-in.
- Renaming and creating share one small name dialog, the shape the theme dropdown uses for the same pair (`SettingsModal`'s `Create Custom Theme` / `Rename custom theme`); `LutCurveSelector`'s editor does the same for curves.
- **Modified state is a star on the name**, not a notice row: the active preset's row label carries a trailing `*` while `isAutoSupportPresetDirty()` is set, and the trigger's `aria-label` (`Auto-support preset, modified`) and `title` say so for assistive tech and for the test. Closing the dialog with something uncommitted asks first (`useAutoSupportDialogChanges` is the one source for that question, shared with the footer's Save/Reset).
- **Two refusals, and no factory restore.** A built-in cannot be saved over — refused in the store (`saveAutoSupportPreset`) *and* disabled in the UI, with a tooltip pointing at `Duplicate` — and it cannot be deleted, so `Delete` greys out. **While a built-in is selected the policy fields are disabled too**, each saying on hover why (`LOCKED_PROFILE_HINT`, carried by the app's own `Tooltip` rather than the browser's `title`, and by the ⓘ's accessible name): an edit made there could never be kept, so the dialog does not collect one. The diagnostics stay live — a view switch is not run policy, and reading the scene with one has nothing to do with which preset is selected. `Duplicate` therefore *selects* the copy it makes: `Save` writes the selected preset, so leaving the source selected would send the next save back into the refusal. The copy's block is the source's and the live settings are left alone rather than re-applied, which is what keeps an edit staged in the dialog's draft alive — the copy then reads as modified until that edit is saved into it. There is therefore no `Restore factory presets` action: the reason it existed was saving over a built-in, and that is refused now. `restoreAutoSupportFactoryDefaults` stays in the store with no UI caller. Deleting the preset you are on falls back to `medium` (`deleteActiveAutoSupportPreset`) rather than leaving the dialog with no policy — the store's own "nothing selected" contract is unchanged.

`SelectDropdown` needed no extension for any of this: one footer entry is what `menuFooterAction` already provides.

Selecting a preset applies the whole block immediately (the store's contract), and the applied block is copied into the dialog's draft so the fields show it; the rest of the dialog stays draft-until-`Save`. The dialog's strip and the panel's row both go through `setActiveAutoSupportPreset`, so the preset a surface shows is the store's active id and not a match against the live block.

The panel's row (`AutoSupportPresetRow`) is the selector and the Auto-Lift toggle at 1:1. The selector offers **every** preset the store holds — the `Light` / `Medium` / `Heavy` built-ins and the profiles a user saved — where it used to render one button per *built-in*, which made a saved profile unreachable from the panel. Each row names its origin (`Built-in` / `Custom`) so a user can tell which rows the store's save-refusal and delete rules apply to. The selector follows the Auto Orientation panel's objective dropdown for its theme: the `--surface-1` fill and centred content.

Auto-Lift is the app's standard toggle button: `aria-pressed` for the state, and the accent fill the bracing card's quick-pick and the Cut Panel's segmented selector already use (`color-mix(--accent, --surface-1 85%)`) while it is on. Its label states the state — `Auto-Lift ON` / `Auto-Lift OFF` — so the button reads the same to someone who cannot tell the accent fill from the quiet one, and the off state keeps the `--surface-1` fill the selector beside it carries, so the row holds together rather than a filled control sitting next to a dark one. It writes the app's one auto-lift flag (`useTransformManager`, shared with Prepare → Transform → Lift, and persisted under the `autoLift` key), because the gap it holds under the model is what the generated supports have to span; `docs/workflows/transform-and-positioning.md` describes the flag itself.

The store's own migration duty, now met: the built-ins carry real bands (light = `detail`, medium = `structure`, heavy = `anchor`), `snapshotPresetSettings` runs `migrateLegacySizingPreset` on everything written or adopted (so a stored or imported block that still carries `sizingPreset` lands on its band and drops the key), and `isAutoSupportPresetDirty` compares **normalized** blocks on both sides — a payload that predates a key, or still holds a legacy one, fills the same defaults the live block does and reads clean. Comparing raw payloads marked every preset dirty the moment a key was renamed.

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
- **PLACEMENT DIAGNOSTICS** — `Trunks by kind: grid 44 (ring + infill), gap-fill 0, standalone 41 (sub-threshold overhang, no host)`; `Candidates by source: voxel 49 · minima 21 · intersection 47 · overhang 98 · stabilization 12 · reinforcement 18`; `Fan refusals: noHost=1 (too far >5mm/2.5mm grid, angle >45°, sameZ|cross|blocked|capacity)`; `Merge refusals: noHost=22, rejected=20`; `Consolidation refusals: blocked=99, cross=3 (sameZ=surface too flat for side-leaves — chunking needs ≥0.4 mm neighbour height rise)`. Sourced from `diagnostics` captured in `computeAutoSupportPlan`.
- **Counts** — `56 trunks · 70 leaves … | 16 trees, 40 bare` — `trees` are hosts with members, `bare` are 1:1 pillars.
- **FAN-OUT GROUPS** — `v115 @ Z=26.6mm Ø1.03mm [area 0.53mm² …] → 12: v116(L 2.8mm/20° Ø1.03) …`, headed by the gates that admitted its members: placement fans `≤leafFanMaxAngleDeg` within `LEAF_FAN_RADIUS_MM` (`GRID_HOST_FAN_RADIUS_MM` for grid hosts), chunk-consolidation links `≤CONSOLIDATION_MAX_ANGLE_DEG` within `CONSOLIDATION_FAN_RADIUS_MM`, and the `maxAttachmentsPerTrunk` cap in force — so a group is readable without re-deriving which pass attached each member. `spanMm`/`angleDeg` are `knot→tip` distance and angle from vertical, measured **after** the resize/orphan passes: segment splits and rehosting can drift a knot down its host, so a link can read shallower than the gate that admitted it. Each member's own `Ø` follows the angle — the diameter the member contributes, from `memberDiameterOf`, the same number the resize demand reads (a branch's widest segment; a leaf's cone body, which `syncContactConeDiameters` matches to its host) — so the member-vs-host ratio is readable off one line instead of inferred from the render.
- **STANDALONE TRUNKS** — `grid-o0-… @ Z=5.1mm Ø1.21mm [area 10mm² …]` plus `— region ring + grid infill` or `— standalone voxel/minima (below threshold or consolidated)` based on `id` prefix.
- **Two things the report still cannot show** (surfaced, not fixed). (1) The bracket note's arithmetic does not reconcile: `forestSizingNote` prints `base Ø{bandShaftMm} · h{heightFactor} → Ø{post-resize diameter}`, but the diameter in the arrow is the trunk's final segment, which also carries the model factors (`modelSizingFactors().trunkScale`, i.e. `sizeFactor × loadFactor`) the note never prints — so `base Ø1.00 · h1.25 → Ø1.93mm` multiplies out to 1.25, not 1.93. (2) The line prints the host's **shaft**; nothing prints a contact's tip, so the free-width cap's own effect (the thing that made tips read thin) is invisible here — the tip is only visible in the rendered support.

**Orphan reporting:** post-resize `rehostLegacyKnots` + `validateAndCullOrphans` cull `drift`/`missingHost`/`missingSegment` (orphan knot >0.5 mm off its host segment) and report `cross`/`blocked` without culling. `ForestReport.orphans[]` (`OrphanInfo`) and `forestReportToText` `ORPHANS CULLED` surface them. Drift is the "leaf attached to nowhere" case — host segment split rehost failed or knot was placed on a trunk that later split.

**Diagnostics reporting:** `ForestReport.diagnostics` captures `diagnostics.candidatesBySource`, `hostsByKind`, `fanRefusals`, `mergeRefusals`, and `consolidationRefusals` so the text report can explain *why* a candidate became a trunk/leaf/standalone vs fanned/merged — and why a region did not chunk (`sameZ` = surface too flat for side-leaves).

## Related pages

- [Support System](support-system.md) — the subsystem this places into
- [Stump](../reference/support-anatomy/stump.md) — what near-plate contacts become
- [Experiments Framework](experiments-framework.md) — the gate
