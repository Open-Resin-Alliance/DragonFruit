# Backlog and Known Gotchas

A home for temporary rules, tradeoffs, gotchas, and desired architectural
directions that `AGENTS.md` references tersely. When `AGENTS.md` points here,
this page is the fleshed-out explanation. Add entries here when a rule is too
long for `AGENTS.md`, is expected to be lifted once an upstream change lands,
or is a known refactor we intend to do.

## Lingui + React Compiler: interpolating translations

**Do not** add interpolating `msg` translations inline inside a React component
or hook:

```ts
msg`${minutes} minutes`;   // ❌ inside a component/hook
```

React Compiler renames the interpolated locals in production builds
(`minutes` → `minutes_2`), which desyncs the message id from the compiled
catalog — production then renders the placeholder raw (`{minutes_2}`). Dev looks
fine and hides the bug.

**Rule:** translations that interpolate values live in **module-scope helper
functions** (e.g. the duration formatters in `src/app/page.tsx`), which React
Compiler leaves untouched.

**Temporary until:** Lingui moves to a Babel macro ordered before React Compiler.

## In progress: make the support system registry-driven

`src/supports/supportTypeRegistry.ts` **exists** and is load-bearing: one
descriptor per type, and every "for each support type / collection" walk derives
from it. `SupportState`'s collections, the modelId and shafted walks, root
ownership, the updater and knot-diameter slots, and several behaviour decisions
that used to be hardcoded type names now come from there.

**Adoption is partway.** Measured by `npm run scan:support-types`: **5,219
hand-written type references across 148 files**, down from 12,164. History
handlers, registration slots, the support primitives, the clipboard, geometry
export and most of `state.ts` are converted; `state.ts` (751),
`SupportRenderer.tsx` (457) and auto-placement (325) remain the largest
holdouts. Adding a type is therefore still partly manual — see
`dev/support-type-extension.md`, which marks each step.

**Quote the per-type rename test, not one headline.** `rename-test.py <type>`
is the goal mechanised, and the types differ: `branch` 16, `leaf` 14, `trunk` 3,
`anchor` 1, `stick` 0. Measuring on the easiest type alone reads as finished
when another is ten times worse. The detail lives in
`dev/support-type-literal-plan.md` §1.1.

Neither instrument alone is the picture: the rename test sees only what `tsc`
can prove, so a literal that survives a rename *without* a compile error is
invisible to it. Catching those needs a scan of every distinct token (736 of
them over 6,014 occurrences when last measured). Report both. A string literal
is invisible to BOTH: the knot-host prefixes needed a source scan.

**Remaining goal:** move the rest of the per-type threading behind the registry,
so the renderer, interaction manager and export derive their behaviour rather
than enumerating types. Deliberately out of scope for the registry itself:
renderers, builders and placement logic. It describes what a type IS, not how it
draws — putting behaviour in it turns a mechanical refactor into a rewrite.

**Do not do this refactor while adding a support type.** Still true, and still
the point: converting a hand-wired path and adding a new type at once means a
behaviour change and a migration land in the same diff, and neither can be
reviewed or bisected cleanly. Add the type through the current hand-wired path,
then convert separately. Registry work should land on its own with no behaviour
change.

**The rule that matters.** When code needs type-specific behaviour, derive it
from the registry or declare it as a descriptor property. Never subtract
(`.filter(id => id !== 'trunk')`): a new type silently joins or skips the set,
which is the exact failure the registry exists to prevent.

### Bugs found while converting

Converting each hand-written type list turned up defects where the list
disagreed with the registry. They are recorded in
[`support-registry-findings.md`](support-registry-findings.md) -- 22 still open
-- rather than here, because they are per-site detail rather than rules to
follow.

The rule they add up to is the one above: derive, never subtract. Two were
invisible to the whole suite AND every golden, so passing tests are not
evidence a flag is covered -- see AGENTS.md trap 4.

## Desired: route every native call through the IPC bridge

`src/features/slicing/tauri/nativeSlicerBridge.ts` is documented as the seam for
Tauri commands (`dev/tauri-ipc-bridge.md`), and it is where new wrappers belong.
It is not yet the only path: 84 direct `invoke(...)` call sites live in 29 other
modules, nine of them React components, reaching ~70 of the 107 native commands.

**Why it matters:** the command name is a plain string on the TS side, so nothing
type-checks it against Rust. Centralizing the calls is what would make a single
rename verifiable instead of a grep-and-pray.

**Goal:** every native command reached through a named wrapper, so the bridge is
the full inventory of the contract and a boundary check (in the style of
`scripts/check-plugin-boundaries.mjs`) can enforce it.

Do not attempt the migration as part of unrelated work — move a call site into
the bridge when you are already editing it, and leave the rest. The bulk move is
its own change, with no behavior difference.

## Desired: native twin optimization plan

A roadmap note, not a current runtime contract — previously
`dev/native-twin-optimization-plan.md`.

**Goal:** move toward a native scene twin in Rust so the frontend can send small
state diffs instead of repeatedly staging large geometry buffers during slicing
and export.

**Key constraints:** support editing in the frontend must stay smooth; support
fidelity must remain exact; the work should land after the stable beta path is
complete.

**Architecture direction:** frontend owns live interaction and preview; backend
owns canonical slice-ready state; model assets are loaded by identity rather
than resent repeatedly; support changes are transmitted as graph diffs with
stable IDs and resolved coordinates.

**Success criteria:** less bulk geometry IPC; better support-heavy export
performance; revision parity between frontend and twin before slicing/export.

## Import post-processing: what still blocks a scene load

A scene load pays these per model, synchronously, in `processGeometry`
(`src/hooks/useStlGeometry.ts`) — measured with
`npm run bench:import-postprocess` on a 500k-triangle non-indexed soup
(~1.5M vertices, the shape a VOXL-embedded mesh has):

| Phase                       | Cost     | Needed for                       |
| --------------------------- | -------- | -------------------------------- |
| `EdgesGeometry(30)` overlay | ~2139 ms | optional, default-off overlay    |
| flattening planes           | ~98 ms   | Place on Face                    |
| `computeVertexNormals`      | ~43 ms   | rendering                        |
| `computeBoundingBox`        | ~13 ms   | everything                       |
| BVH (`accelerateGeometry`)  | ~120 ms  | support placement raycasts       |

The overlay geometry is the whole problem: ~93% of the phase, and three times
larger than everything else combined. It is off by default, so it is now built
**only when the user has the overlay enabled** — `buildModelEdgeGeometry()` is
the single gate, called from `processGeometry` for imports (with the import
progress UI up, so the cost is where a load's cost belongs), from
`replaceModelGeometry` for geometry swaps, from the Split Supports path, and
from the scene's settings effect for models that were loaded while the setting
was off (one model per idle callback, cached on the geometry so it is built
exactly once).

Do not move this build off the import path into the overlay component: it
measured *worse*, not better — six 500k-triangle models went from one import
stall to 6 × ~1.9 s of post-load main-thread blocking (18 s of long tasks in a
browser profile, versus 5.5 s), because each model's `StlMesh` re-paid it on
mount and there is no shared cache at that layer.

**What remains, in value order:**

- **The overlay build itself (~1.9 s per 500k-triangle model) is unavoidable
  main-thread work while the setting is on.** It is the only remaining
  multi-second op in the load path; a worker (the repo already runs workers for
  the 3MF loader) is the way to remove it, and would let the overlay be enabled
  without any import penalty.
- **BVH + flattening planes are still synchronous on the import path.** Both are
  already deferrable: `finalizeModelGeometryPostProcessing` in
  `src/features/scene/useSceneCollectionManager.ts` runs exactly these two in
  idle callbacks for geometry swaps, and `hasPendingBackgroundGeometryWork()`
  reports when that queue is still draining, so the UI can stay honest. Routing
  imports through the same seam would remove ~220 ms/model and shrink the
  "import finished" to "app responsive" gap.
- **VOXL original-mesh sidecars are resolved on the import path.** When a VOXL
  has no embedded `ORIG` chunk, `resolveOriginalRefSidecar` falls back to the
  model's on-disk `sourcePath` and `readSidecarFileBytes` fetches it. For a
  source that has moved or been re-exported (the common case after a repair
  round-trip) that is a real network attempt per model that can only 404 — noisy
  and awaited, though harmless (the loader falls back to the embedded preview).

## STL imports: facets, missing normals, and a shuffled per-vertex attribute

Reported as mottling that appeared on STL imports and not on LYS ones, and
mistaken for broken baked ambient occlusion. Three separate causes, on the same
path, none of them in the occlusion estimator:

**1. The loader baked the file's per-face normals into the render.**
`encode_stl_response` wrote one triangle's normal onto all three of its corners.
An STL has no vertex normals, so this looked faithful, but with
`flatShading={false}` three *interpolates* a constant and every face is lit by its
own orientation. Measured on `poussin.stl` (150k triangles, 75k welded vertices),
counting shared positions shaded by more than one normal: **74976 / 75000 and up
to 168° apart** before, 0 / 75000 and 0.00° after. Fixed by accumulating face
normals over the already-welded mesh; `stl_normals_are_smooth_at_shared_vertices`
pins it.

This alone was *not* the mottling: rendering the same geometry through the app's
material with smooth and with per-face normals differs by **0.5-1.5% mean
brightness** even under a hard key light (measured in a headless render of the
real loader output). It is a real defect and it had to go, but it is not what the
report was about.

**2. A repaired geometry kept no normals at all.** `repairGeometryWithManifold`
rewrites positions and index in place and deletes the now-stale `normal`
attribute, with a comment saying the caller must recompute. It does not set
`nativeModifiedGeometry`, and STL loading passes `_skipComputeNormals: true`
because the loader "already computed them" — so `processGeometry` skipped the
recompute and the model shaded from a zeroed attribute. That is precisely the
imports that needed repair, which is to say the messy STLs, which is to say the
ones that look broken. Fixed by recomputing whenever the attribute is absent,
whatever the skip flag says.

**3. The bake's values were shuffled on indexed geometry.** The bake returns one
value per triangle corner in the order the soup was sent. A non-indexed geometry
*is* that soup, so the mapping is the identity; an indexed geometry's index buffer
is the *corner* order, so slot `s` draws value `s` at vertex `index.getX(s)`. The
code read it the other way round — `values[vertex] = cornerValues[index.getX(vertex)]`
— which is only correct when the index buffer is its own inverse. `MeshDefects`
repair switches the geometry from a soup to indexed (`setIndex`), so **every
repaired STL got its occlusion values shuffled**, and LYS imports, which arrive
clean and are never repaired, did not. That is the reported split exactly.

Fixed by walking the index buffer as slots. `bakedOcclusion.test.ts` covers the
non-self-inverse quad case: 3/3 with the fix, 2/3 against the previous mapping.

The lesson worth keeping: defects 1 and 2 live in the *geometry* and defect 3 in
the *attribute*, and all three present as "the per-vertex data is wrong". Before
disbelieving a per-vertex field, check what the geometry it is attached to
actually is — indexed or not, and whether it has normals at all.

## Gotcha: a Rust mesh result must be indexed against the geometry you sent

Any native command whose output is addressed *by element* — triangle ids,
per-vertex values, per-region masks — is a place this bug can appear, and it has
appeared three times now: the island scanner first, overhang classification
second, the ambient-occlusion bake third. It is worth recognising, because the
symptom looks like a rendering or a maths problem and is neither.

**Symptom.** Misaligned triangles: the values are right for the mesh Rust saw and
wrong for the mesh on screen, so shading or masks land one element over, or in
patches that follow no feature of the model. The island scanner's version was
"disconnected speckles"; the AO bake's was facets that follow the triangulation.
It shows only on *some* models, which is what makes it feel random.

**Three ways the Rust-side mesh diverges from the frontend's mesh:**

- **The shared staging buffer is process-wide mutable state.** Repair, hole
  punching, hollowing and the next import all write it. A command that stages a
  mesh, then reads it back later (an idle callback, an `await`), can find a
  *different* mesh there and compute values for that one.
- **Re-loading the file on the Rust side re-welds it.** The loader welds with its
  own epsilon and vertex order (`DEFAULT_MERGE_EPSILON`, `from_triangle_soup`),
  which need not match whatever produced the geometry the frontend renders.
  That is the island scanner's original bug: the sideloaded mesh's `triangleIds`
  pointed at the wrong triangles.
- **Welding the same soup twice, with different tolerances.** A bake that takes a
  soup welds it, and then rebuilds a corner-to-vertex map to expand its values
  back out must use the *same* weld for both directions. Two tolerances disagree
  about which corners are the same vertex, so the expansion reads one mapping's
  ids into a mesh built by the other.

**The rule.** Send the geometry in the request and return values in the geometry's
own order or index space. For indexed geometry, map back through the index buffer
so shared vertices share one value. Use staging only for commands that *produce*
or *transform* a mesh, where the output replaces the buffer and there is nothing
to index against. This is written up prescriptively in
`dev/tauri-ipc-bridge.md` under *Conventions to respect*; it is repeated here
because that is the document you read when writing a command, and this is the one
you read when something renders wrong.

**Cheapest guard when writing one of these commands:** assert the returned
element count against the geometry you sent (vertex count or triangle count), and
fail to "no result" rather than attaching a mismatched array. One weld per
pipeline, and a test that nudges coincident vertices apart by less than the weld
tolerance and asserts they still agree.

**A raw-body command cannot also take arguments** (Tauri: *"expected a value for
key … but the IPC call used a bytes payload"*). That is fine for this rule —
geometry in, values out — but it means any option has to travel in a request
header or stay a Rust constant. It cost a round trip to learn here, which is why
it is in `dev/tauri-ipc-bridge.md` under *Conventions to respect* too.

## Known: `computeAutoSupportPlan` is superlinear in support count, and runs on the main thread

A run places supports at roughly 4–9 ms each on a lattice (measured with the
plate fixture below), so a model that needs a few hundred supports is a couple of
seconds of *synchronous* work and the UI is frozen for the duration — the
"Generating Supports just hangs" report. The cost is not geometry kernels: a CPU
profile of a 417-support run attributes it to TS bookkeeping that rebuilds a
global structure per candidate or per host.

Fixed so far (all output-preserving, verified by hashing the produced brace set
before and after):

- `computeRegionCoverage` / `findUncoveredClusters` tested every footprint voxel
  against every tip — a 7000 mm² region is ~112k voxels. Now bucketed through
  `TipIndex` (`coverage.ts`), which walks only the nine cells a disc can reach.
- `buildGroupPairs` (`autoBracing/autoBrace.ts`) scanned *every* edge for every
  support in the two-axis pass, building a sorted string key per edge per
  support. Now indexed per support, with the redundancy sets cached.
- Footprint mask probes (`erodeFootprint`, `buildBoundaryPoints`, the cluster
  BFS) keyed cells with template-literal strings. Now `cellKey` in
  `voxelFootprint.ts` — numeric, so a probe allocates nothing.
- `collectFanShaftPoints` was rebuilt per candidate (up to three times) and per
  host inside the consolidation loop. Now built once per candidate and once per
  consolidation pass, filtered as pillars convert.
- The distance-field cell cache was a `Map`, and one placement asks it for
  hundreds of thousands of cells (the router walks a ~100 mm column at the cell
  floor and re-walks it for every step of its outward search). It is now a dense
  `Float32Array` over the model bounds with the `Map` as the fallback: ~15% off
  a long march, measured on a 120 mm column.
- `isContactConeBlocked` stepped the cone at a fixed 0.1 mm with the *uncached*
  exact query, and the router runs it for the straight cone plus up to 24
  deviations. It now sphere-traces the axis on the 1-Lipschitz property, which
  skips only points the fixed-step loop would also have found clear, so the
  verdict is unchanged and a cone in the open costs an order of magnitude fewer
  queries.

Still open, in the order a profile says they pay:

1. `generateGridCandidates` materialises the whole footprint as `{x,y,z}`
   objects (`footprintToPoints`) before eroding and walking it — 112k objects
   for a large region. The mask-native path is a typed-array API.
2. `fanLeafToHost` / `buildConsolidationBranch` call `getSupportTypeDescriptor`
   per candidate host sample, and their reach is a linear walk of the whole
   shaft pool. Registry lookups want hoisting; the pool wants a spatial index.
3. `computeForestDiameterProfile` deep-clones the forest with
   `structuredClone` — most of that phase's cost.
4. `isAutoBraceableShaftType` / `lateralStabiliserTypes` rebuild their
   filter+map+Set on every call, and they are called per sample.

**The responsiveness fix was architectural, not micro-optimisation.** The plan is
pure with respect to the stores it *writes* (one commit at the end), which is
what let it move to a worker thread; see
[Auto-Support Worker](auto-support-worker.md) for the protocol, the seeding
contract that keeps the two threads in agreement, and the cost of the mesh
transfer. What is still missing there is the progress/cancel surface: the run
no longer blocks the main thread, but the modal over it is indeterminate, so
the perceived freeze needs a percentage and a cancel action before it is gone.

Porting to Rust is not the next step: the profile above is dominated by
allocation and repeated walks of TS structures, which a Rust port would not
remove, and the pipeline is entangled with `three` geometry, three-mesh-bvh and
the support registry.

**Reproducing the numbers:** a slab of `W × L` leaning 60° from horizontal, one
hand-built `source: 'overhang'` island over its big face (plane, `triangleIds`,
voxel footprint), then time `computeAutoSupportPlan` with
`debugSkipAutoBracing: false`. 20×20 → 85 ms / 11 supports, 40×60 → 172 ms / 72,
60×90 → 383 ms / 158, 100×140 → 1548 ms / 417. Before the fixes above the last
row was 3593 ms; use the same fixture to check a further change pays.

## Known: the router's cost is the SDF march, and precomputing clearance does not pay

The joint search (`findEscapeJoint` in `src/supports/PlacementLogicV3/`) now
dominates a real run. Measured on a 505k-triangle sculpt with the island scan
feeding 166 islands: **32.9 s total, of which placement is 27.5 s and
`router:joint-search` is 23.0 s** — 2067 placements, 29.2 cones each (15.6
gated), 11.7 joint searches each, 24132 searches in all. Of those, **162 find a
joint (0.67%)**; 12427 end `never-cleared` and 11543 hit the probe budget.

Where the 23 s goes: 8790 probes per placement is **18.2M probes** and **107.9M
cell reads** — 5.9 reads per probe at ~213 ns each, which is main-memory latency
against the 32 MB open-addressed cell table. The **BVH queries are not the
cost**: this cache's own notes put a bounded fresh cell at 0.2 µs, so all 1.6M
of them are ~0.3 s, about 1% of the joint search. The reads come from the march
sampling at its `cellSize * 0.9` floor wherever the geometry is tight, which on
a sculpt is most of the time.

**Two thirds of all probes are spent proving a negative.** A `never-cleared`
search walks all 12 fan directions the full lateral envelope (0.5 mm steps out
to `maxLateralMm` 40 mm) and finds nothing: ~960 probes each, 12M of the 18.2M.

Three ways to replace the predicate with precomputed clearance were built and
measured; all three are rejected, and the numbers are here so they are not
re-derived:

1. **3D bitset over the scan's layers.** 216 MB at 0.05 mm, and **604 µs per
   column query against the march's 83 µs** — the query walks a 3D
   neighbourhood, so it loses to the thing it replaces.
2. **2.5D span prefilter** (per XY cell, the occupied Z range). 0.5 MB at
   0.25 mm and 377 ns per query, but only **252 of 4000 columns could be proved
   clear, and 76 of those were wrong** — a span merges separate Z passes of the
   model into one range, filling the free space between them, and the errors go
   both ways.
3. **Per-XY-column blocked-Z interval map** (Z exact, cone dilation rather than
   a slab, two-sided so a verdict can never disagree with the SDF). At 0.15 mm:
   build 6.8 s, 26 MB, 92.6% of probes settled, **8 wrong**. At 0.1 mm: build
   36.7 s, 59 MB, 94.7% settled, **14 wrong**. The build costs more than the
   23 s it would save, and "wrong" has to be zero because one wrong verdict
   moves a placement. The error budget has to absorb the query snapping to a
   cell centre, the surface sample snapping to a cell centre, and a triangle
   that only clips a cell contributing its whole Z range; tightening any of them
   costs resolution, and resolution costs build time quadratically.

Two related facts, both measured, that constrain any future attempt:

- The distance bound (`MARCH_DISTANCE_BOUND_MM`) is already doing its work: the
  same cache notes measure 3.1 µs for an *unbounded* fresh cell against 0.2 µs
  bounded, and that 14× is banked. Lowering the bound further buys little
  because fresh cells are ~1% of the run — but it is not free either, since the
  bound is also the only source of the distance *sign* for a cell more than the
  bound from any surface. A census of one real run's fresh cells found 74 of
  6200 (1.2%) capped and none of those inside the solid, but the box-with-cavity
  fixture does put capped cells inside, which is the case a naive cap breaks.
- The geometry really is in the way. On a dense sculpt most sockets have no
  clear vertical column anywhere in their lateral envelope, so the search is not
  failing from inefficiency — a faster predicate buys less than the numbers
  above suggest.

**Implication for the next attempt:** there are three levers and they are not
equally available. The *number of probes* is the biggest — two thirds of them
exist to prove "nothing clears in this direction", walking all 12 fan directions
the full lateral envelope. The *reads per probe* is next — the march's floor.
Both change which joint is found, so both change placements and need a quality
decision rather than a benchmark. The *cost of a read* is last and is
storage-shaped: the table is 4M slots for ~1.4M cells, and the obvious fixes
(denser, or coarser, or quantized) all move the field's resolution, which also
moves verdicts.

**Tried and rejected: settling the legs with a midpoint test.** A leg is one walk
step (0.61 mm) against a 0.7 mm clearance, so it is nearly a point, and the
midpoint's bounds widened by half the length settle it soundly both ways. It
measured **slower** — 204 ms against 185 ms on the router's own probes, with 11%
fewer reads but 4% *more* BVH queries: the legs' marches are already only two or
three samples, so the extra probe and lattice-gap arithmetic cost more than the
march it skipped, and the midpoint is often a cell the march would not have
touched. Do not re-try it without a profile showing the leg calls dominate.

What that leaves as the real cost: with `ColumnClearanceMap` in place a call
averages ~1.2 reads, so the ~1 µs a call costs is **not** the cache and not the
geometry — it is the call machinery and the walk's own per-step work (the escape
search builds a `{x, y, z}` object per step). Profile that before optimising
anything else here.

## Fixed: `segmentBlocked` reported a column clear that passes within clearance

Fixed by bounding each sample by its own distance to the lattice point the cache
answered for, and resolving that sample with an exact bounded point query only
where the bound cannot decide. The regression test is
`src/supports/__tests__/segmentBlockedQuantization.test.ts` — it sweeps tangent
segments that provably come within clearance and **fails on the old code (4 of
1680 reported clear) and passes on the new one**.

Two intermediate versions were tried and rejected, both recorded here because
each looked right: subtracting nothing (the original bug), and subtracting the
worst-case half-diagonal, which is sound but inflates the effective clearance by
60% and breaks `stickBridgeClearance.test.ts`'s 0.5 mm-shaft-in-a-0.8 mm-gap
case. The screen-then-ask version keeps the big steps in open space.

The first attempt asked exactly whenever `base - gap < clearance`, which fires on
every sample near geometry — where a march spends its time — and measured 23.9M
BVH queries against 1.6M, 2.9x the wall clock on a real run (95.9 s against
32.9 s). Making the test two-sided (settle `clear` above the band, `blocked`
below it, ask only between) brought that to 1.8x, and pairing it with
`ColumnClearanceMap` — which removes whole columns — turns the combination into a
win: **50% fewer reads, 28% fewer BVH queries, 34% faster than the original** on
the router's own probes.

The bug, for the record. `segmentBlocked` steps along the segment by `distance - clearance`
on the 1-Lipschitz property, but the distance it steps on comes from
`boundedDistanceAt`, which **quantizes the query to a 0.5 mm cell**
(`quantizeToCell` rounds) and answers for that cell's lattice point. The
Lipschitz argument needs the distance *at the sample point*: the true distance
there can be smaller by up to the distance to that lattice point, so a step can
carry the march past a region inside `clearance` and the segment comes back
clear. The comment above `MARCH_DISTANCE_BOUND_MM` argues the bound is exact —
that argument is about the *bound* (it is what lets the BVH prune, and it is
sound for the sign), but it assumes a point-exact distance, and this distance is
not.

Measured on the router's own probes (a 2000x250 torus knot, 502,251 vertices,
clearance 0.7 mm): of 4772 probes, **3 were reported clear with a point on the
segment 0.5976 mm from the model**. Verified with
`closestPointToPoint(point, target, 0, Infinity)` and cross-checked by a
brute-force scan of all 502,251 vertices (nearest 0.5990). `distanceAt` cannot
check this — it is quantized to the same grid, and reported 0.798 for that point.
Effect: a routed column can clip the model by up to a cell's quantization, on
0.06% of probes.

What remains approximate. The march's `minStep` floor (`cellSize * 0.9`) still
lets a point inside clearance sit between two samples whose bounds are both
clear, so `blocked` from the map can still exceed `blocked` from the march by
that residue — one probe in ~2800 in the measurement above. Closing it means
interval termination (prove `clear` from `min over samples (d) - spacing/2`, and
refine when that fails) rather than a smaller floor everywhere. Measure that
before building it.

## Measured: a vertex-ball column-clearance map (landed)

The router's columns all run from a walk point down to `rootTopZ`, which is
below the model, so a column is blocked exactly when the blocked set at that XY
has any element in `[rootTopZ, zTop]` — i.e. the whole Z-interval structure
collapses to its minimum. That is one scalar per XY cell, and it makes the build
a single min-push instead of the interval map's per-cell lists (which is why
that one took 6.8-36.7 s and this one does not).

The scalar has to be a *real* blocked Z to be usable, and the way to get one
without an error budget is to draw balls around **mesh vertices**: a vertex is
provably on the solid, so a ball of `clearance` around it is provably inside the
blocked set. Every earlier rasterized version had to bound how far a cell could
sit from the surface it stood for, and a triangle clipping a cell charges its
lowest vertex to a cell up to a triangle-width away — hundreds of times the
error the verdict can absorb.

Measured on the same knot (radius = clearance minus the query's half-cell snap):

| cell | build | memory | column probes settled | query |
|---|---|---|---|---|
| 0.3 mm | 57 ms | 0.2 MB | 94.1% | 0.24 µs |
| 0.2 mm | 88 ms | 0.5 MB | 94.8% | 0.13 µs |
| 0.1 mm | 301 ms | 1.8 MB | 95.8% | 0.13 µs |

`blocked` is sound by construction here, and it measurably works: against the
router's own probes it cut cell reads by 56%, and paired with the exact march the
stage's reads fell 50% and its time 34% against the original. It is landed —
`SDFCache.enableColumnMap` is opt-in and clearance-specific, and the router
turns it on in `calculateSmartPlacementV3`. It can never say `clear`: proving
nothing is within clearance needs completeness, and vertices are not complete.


