# Auto-Orientation (Pre-Plan)

Design pre-plan for automatic build-orientation of models, tuned for
masked-resin (MSLA) printing. M1 has shipped (`suggestOrientation` in
`src/supports/autoSupport/orientationAdvisor.ts`, sweeping
`generateM1Candidates` plus `restingPoseCandidates` with coordinate-descent
refinement), as has M2 (support blockers — see below); M3–M5 are still
planned, sequenced so each lands as a usable improvement. It
absorbs the intent of the closed WIP attempt (#224: Fibonacci sweep with
protected-face painting) while discarding its implementation, which did
not work well in practice and was never merged. Designed to interlock
with the auto-supports pipeline
(`docs/dev/auto-supports.md`).

## Why orientation matters more in resin than FDM

Peel force is the dominant failure mode. Every layer is peeled off the
FEP film, and the force scales with the layer's cross-sectional area. A
bad orientation produces a few huge cross-sections (delamination, layer
shift, suction cupping) even when the support count is modest. FDM
orientation optimizes for overhang angle and material; resin orientation
optimizes for peel, drainage and cosmetic contact, in that order.

## Objectives, ranked

1. **Peel safety** — minimize the maximum layer cross-sectional area, and
   secondarily its integral over the print (total peel work).
2. **Cosmetic preservation** — minimize support contact on
   user-designated protected faces; default-protect nothing, but let the
   painter mark visible surfaces.
3. **Support cost** — minimize support volume and contact-point count on
   non-protected surfaces.
4. **Height** — fewer layers is faster; a tie-breaker, not a goal.
5. **Drainage** — hollowed models must not create enclosed cavities;
   orientation must keep drain paths viable (co-designed with the
   hollowing modifier).

## Architecture

### Candidate generation

- **Resting poses**: convex-hull stable orientations of the mesh
  (guaranteed physically restable).
- **Fibonacci sphere**: uniform coarse sweep over SO(3) down-axes
  (a #224 idea, reimplemented from scratch), always including the current pose so the result
  never regresses.
- **Refinement**: local search (coordinate-descent on the two rotation
  degrees of freedom) around the top-K candidates from the coarse pass.
  Full SO(3) optimization is unnecessary; orientation quality is
  dominated by which face points down.

### Scoring (no slicing)

Full slicing per candidate is too slow for interactive use. Score from
cheap geometric proxies computed once per candidate:

- **Cross-section proxy**: render the mesh orthographically along +Z into
  a low-res depth/coverage buffer (GPU, three-mesh-bvh assisted) and read
  per-layer coverage counts. This approximates the layer-area curve at
  near-render cost and directly estimates max and integral peel.
- **Overhang area**: triangle-area weighted count of faces whose normal
  falls below the self-support threshold, weighted by height above the
  plate (high overhangs need taller supports).
- **Painted-face feasibility**: not a score term — painted "no supports"
  faces are pruned by constraint before scoring (see below).
- **Trapped volume estimate** (hollowed models only): ray-parity
  classification of enclosed cavities for the current orientation. The
  hollowing engine already produces the cavity geometry (ADR-0029), so
  the term scores the EXISTING cavity against each candidate
  orientation, not a hypothetical one.

All terms are weighted; weights start calibrated, exposed as advanced
sliders later only if the calibration proves insufficient.

### Pose stability, and why the plate contact is not an overhang

The sweep ranks by support contact. Two things it was getting wrong, and both
showed up as a cube coming back oriented onto a corner:

- **The plate contact was double-charged.** A face-down cube's base is
  down-facing area, so it counted as overhang *and* as a cup — 300 mm² for a
  pose needing the least support of any — while a corner-down pose keeps every
  face just above the self-support angle and scored 0. The search was therefore
  paid to balance parts on a corner, which is exactly the pose the
  stabilization pass then has to patch. The base stays charged as overhang,
  scar and blocked contact: the app auto-lifts models off the plate by a few
  millimetres, so that face really does need supports bridging the gap (the
  island scan reports it — a face-down cube: one overhang region, its base).
  What it is not is a suction cup: resin flows under a sparse support forest,
  and there is no enclosed pocket to trap it. `measurePoseStability` reports
  the down-facing area inside the 2 mm contact band and `netSupportAreas`
  subtracts it from the **cup** term only.
- **Nothing scored whether the pose could stand at all.** `stabilityWeight`
  (default 1, `AdvisorOptions`) charges an unstable pose its whole footprint —
  the contact the stabilization pass would otherwise have to manufacture.
  Unstable is the constant-free part of the report: no bearing polygon (a point
  or edge contact), or the volume centroid outside the base. Finite on purpose,
  so the search still returns the least bad pose when every candidate is
  unstable, and `stabilityWeight: 0` restores ranking on contact area alone.

`measurePoseStability` is the same model `compute_stability_report`
(`src-tauri/src/overhang.rs`) logs for the placed pose — driving moment
`Σ A·(n_xy·u)·z` about a bearing-hull edge, restoring `ρg·V·d_e` and
`σ·A_contact·d̄_e` — reported as geometry so the two constants stay in the
report. The implementations are separate on purpose: the report is Rust, on the
posed mesh the scan already holds, and the advisor is a synchronous pure
function over triangle soup that must stay testable without IPC. They are
pinned to the same closed-form fixtures — a flat 10 mm cube reads
`bearing 100 mm² over 4 edges, depth 5` on both sides. `OrientationCost`
carries the terms (`bearingAreaMm2`, `bearingEdges`, `centroidDepthMm`,
`marginMm`, `adhesionRatio`, `stabilityPenaltyMm2`) so the suggestion surface
can show why a pose lost.

### "No supports" painted faces (shipped as support blockers)

Users paint surface regions that must never carry supports — a figurine's
face is the canonical case — with the Blockers button (secondary, next to
Orient Model) entering a paint mode with a fixed-radius brush, red overlay,
and Clear. The mask is a per-model set of model-space triangle indices
(`src/supports/autoSupport/supportBlockers.ts`), so it rotates with the
model and stays valid across orientation changes — unlike the hollowing
voxel blockers, which index a rotation-aligned grid and are cleared on
rotation. Out-of-range indices (geometry swapped underneath, e.g. by
hollowing) are ignored by every consumer.

Deliberate deviation from the pre-plan: blocked down-facing contact
carries a heavy FINITE weight (`blockedWeight`, default 10, in
`evaluateOrientationCost` and the sweep's `scoreFull`) under every
objective instead of pre-scoring hard pruning. A hard prune breaks the
never-regress invariant on infeasible masks (paint on opposite sides) and
needs the stroke-time conflict machinery; the weight keeps the result
never-worse than identity while still turning blocked faces away from the
plate whenever a better pose exists. The generator side IS a hard refusal:
`generateCandidates` and `generateGridCandidates` drop contacts resolving
to a blocked face (triangle sampler face carried through, upward-raycast
fallback otherwise), so the guarantee holds after orientation as well.
Strokes are single history entries (`support:blocker-stroke`) via the
typed support-history façade.

### Feedback into the support engine: peel exposure

The winning orientation's coverage render is the model's per-layer area
curve L(z). That curve is the input the support engine's sizing
heuristics currently approximate:

- **Peel exposure of a support** = the cumulative layer area above its
  tip (`integral of L(z) from tip to top`). A short support under a
  large torso is peel-critical; a tall support near the top of the print
  carries almost nothing. This measured value replaces the empirical
  height factor (a buckling proxy guessing at load) and the
  suction-area term (guessing peel from region area) as the modulation
  on top of the sizing tier band.
- **Anchor identification**: L(z) combined with the island scanner's
  per-layer regions pinpoints the layers where new disconnected islands
  start — the principled first-printed-surface set.
- **Hotspots**: sudden jumps in the layer curve mark overhang starts —
  support-demand hotspots for density and bracing.

Caveats: L(z) is whole-model area; per-region attribution layers the
region scan on top (it exists). Buffer resolution bounds accuracy —
fine for a smooth modulation term, not for exact contact sizing. The
tier band remains the base; peel exposure modulates it.

### Integration points

- **Transform panel**: an "Auto" mode that applies the winning rotation
  to the model transform, with before/after score display.
- **Auto-supports**: orientation runs first; the support pipeline
  consumes the oriented mesh unchanged. Longer term, the orientation
  scorer should call the support pipeline's candidate generator on the
  top-K orientations so support cost is measured, not proxied.
- **Hollowing**: drainage is circular with orientation — rotating the
  model changes which cavity regions sit below the drain path. The
  resolution: score the existing hollowing result per candidate
  (every cavity point must connect to a drain via a downward path —
  computable with the island scanner's per-layer connectivity), and
  after the orientation is chosen, suggest drain-hole positions at the
  cavity's lowest reachable points. Hollowing after orientation is the
  supported workflow; orienting an already-hollowed model re-scores
  drainage per candidate.

### Determinism and performance

- The sweep is pure geometry with a fixed candidate set: same model, same
  result. No RNG.
- Budget: coarse sweep over ~200-400 candidates must stay under ~2 s on
  the GPU proxy path; refinement adds ~50 ms per candidate.

## Phases

1. **M1 — Sweep and score** (shipped): Fibonacci + resting-pose candidates,
   CPU scoring (overhang primary with an anchoring margin that trades up to ~5%
   contact for the widest base; height/footprint tie-breakers, or height
   objective rank, one-click apply with optimize-for dropdown (Fewest Supports /
   Shortest Print Time / Least Scarring), auto-lift reseat above the plate,
   destructive-transform confirm clearing placed supports first, and toast
   receipts (applied / already-optimal).
2. **M2 — "No supports" painted faces** (shipped): triangle mask with
   paint mode (Blockers button), red overlay, Clear, stroke history;
   heavy finite blocked-contact weight in the search, hard refusal in the
   candidate generators.
3. **M3 — GPU peel proxy**: orthographic coverage rendering, max/integral
   cross-section terms replacing the CPU proxies.
4. **M4 — Drainage**: trapped-volume term and drain-path viability for
   hollowed models.
5. **M5 — Support-aware refinement**: run the auto-support candidate
   generator on the top-K orientations; final ranking by measured
   support cost, not proxies.

## Related research

- **Weighted multi-objective scoring is the established model.**
  "Quantitative suggestions for build orientation selection" (Int J Adv
  Manuf Technol 2018) scores orientations over surface roughness,
  support volume and build time with an OWA operator; later work uses
  weighted-sum plus grey relational analysis. Our scorer is this model
  with resin-specific terms (peel, protected faces) replacing the FDM
  ones (roughness, nozzle time).
- **GPU-accelerated candidate scoring is established.** "Determining
  Optimal Print Orientation Using GPU-Accelerated Convex Hull Analysis"
  (ACM 2023) uses convex hull candidates with GPU support calculation;
  GPU-based parallel slicers (2018, and subsequent work) score
  orientations from image-projection slicing. Our coverage-render proxy
  is the same family, applied to MSLA layer-area curves.
- **Separation-force physics supports the peel-exposure term.**
  "On characterization of separation force for resin replenishment"
  (Additive Manufacturing 2017) ties separation force to cross-section
  area and resin replenishment — the measured basis for treating
  cumulative layer area above a support tip as its load exposure.
- **Topology + orientation co-optimization** (Chandrasekhar & Suresh,
  arXiv 2210.01315; Springer 2024/2025) changes geometry to reduce
  supports. A different problem — we only rotate — but their overhang
  objective formulations are useful reference material.
- **Validation gap in the literature** is repeatedly noted (e.g. the
  Queens thesis on BOO: "lack realistic validation of results"). Our
  calibration folder of professionally pre-supported files is the
  direct answer: professional orientations as ground truth for scorer
  validation.
- **ML scoring** (Neural Slicer, arXiv 2404.15061; RL for DLP peel
  control) exists but stays a non-goal until the geometric scorer's
  ceiling is proven.

## Non-goals

- No per-part multi-model nesting optimization (the arrange tool owns
  layout).
- No ML scoring models until the geometric scorer's ceiling is proven.
- No FDM-specific terms (bridging, nozzle collision).

## Related

- [Auto-Supports](auto-supports.md) — consumes the oriented mesh; the M5
  feedback loop closes here
- [Island Analysis Workflow](../workflows/island-analysis-workflow.md) —
  the per-layer island detection the trapped-volume estimate reuses
