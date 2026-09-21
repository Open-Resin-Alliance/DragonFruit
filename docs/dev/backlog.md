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
