# Tauri IPC and Native Bridge

The desktop app (Tauri) exposes **109** native commands to the frontend
(`#[tauri::command]` under `src-tauri/src/`, all registered in the single
`tauri::generate_handler![…]` list in `main.rs`).

`src/features/slicing/tauri/nativeSlicerBridge.ts` is the **intended** seam: it
holds 26 named wrappers and is where the cross-language conventions below are
centralized. It is not yet the only one. Today there are also **84 direct
`invoke(...)` call sites in 29 other modules**, reaching ~70 distinct commands —
nine of those modules are React components (`SettingsModal.tsx`,
`PrintingPanel.tsx`, `SliceCompletedModal.tsx`, the settings tabs, `page.tsx`).

So the rule is directional, not descriptive:

- **New commands**: add a named wrapper in `nativeSlicerBridge.ts` and call that.
  Do not add a new direct `invoke` from a component.
- **Existing direct call sites**: leave them alone unless you are already
  changing that code. Consolidating all 84 is a deliberate refactor of its own —
  see `dev/backlog.md`.

Regenerate these counts rather than trusting them:

```bash
grep -rn '#\[tauri::command\]' src-tauri/src | wc -l
grep -rhoE '\binvoke(<[^>]*>)?\(' src plugins --include=*.ts --include=*.tsx \
  --exclude=nativeSlicerBridge.ts | wc -l
```

## How a command is wired

1. **Rust side** — declare `#[tauri::command] async fn cmd_name(args: SomeArgs) -> Result<T, String>`
   in `src-tauri/src/main.rs` (or a command module like `mesh_repair.rs`, `sdf.rs`,
   `network.rs`, `plugin_registry.rs`). Arguments are deserializable structs with
   `#[serde(rename_all = "camelCase")]` so TS keys map to snake_case fields.
   Register it in the single `tauri::generate_handler![…]` list in `main.rs`.
2. **TS side** — add a wrapper in `nativeSlicerBridge.ts`:

   ```ts
   export async function pickOpenFilesWithNativeDialog(
     category: NativeOpenDialogCategory,
     multiple = false,
     sceneExtensions?: string[],
   ): Promise<NativePickedOpenFile[]> {
     const core = await loadTauriCore();
     if (!core) throw new Error('…only available in DragonFruit Desktop (Tauri runtime).');
     return core.invoke<NativePickedOpenFile[]>('pick_open_files', {
       args: { category, multiple, ...(sceneExtensions !== undefined ? { sceneExtensions } : {}) },
     });
   }
   ```

   `loadTauriCore()` lazily imports `@tauri-apps/api/core` and gates on
   `__TAURI_INTERNALS__`, so the web build (no Tauri) can import the module
   safely and fail at call time with a clear message.

3. **Events** — long-running native work streams progress via Tauri events, e.g.
   `listen('slicer://progress', …)`. Wrappers that need progress expose a
   callback or a subscription rather than blocking on the invoke.

## Conventions to respect

- **Results indexed against geometry must be sent the geometry.**
  If a command's output is addressed *by element* — triangle ids, per-vertex
  values, region masks — pass that mesh **in the request** (raw body is fine) and
  return values in the same order or index space. Do **not** read the shared
  staging buffer, and do **not** re-load the file on the Rust side: both give the
  Rust code a mesh that can differ from the one the frontend will map onto, and
  the difference is invisible until it renders as misaligned triangles or
  disconnected speckles. The island scanner learned this first, overhang
  classification second, the ambient-occlusion bake third — see the gotcha entry
  in `dev/backlog.md` for the whole history. Staging stays the right tool for
  commands that *produce* or *transform* a mesh (`mesh_repair_staged`, hollowing):
  there the output replaces the buffer, so there is nothing to index against.
- **A raw-body command cannot also take arguments.** A command declared with
  `request: tauri::ipc::Request` has no JSON body, so any sibling parameter is
  rejected at the call site — *"expected a value for key … but the IPC call used
  a bytes payload"*. Put options in request headers, or keep them as crate
  constants; `stage_mesh_binary_set` takes nothing else for this reason.
- **Header values are visible ASCII — percent-encode anything else.** An HTTP
  header value may only hold bytes `0x20`–`0x7E`; `HeaderValue::to_str` rejects
  the rest, so a header carrying a *path* breaks the moment the path has an
  umlaut, accent or CJK character. This shipped: the destination rode in
  `x-mesh-stage-path` verbatim, and every save into a folder such as
  `Tatsächliche Dokumente` failed on its first chunk. Senders encode with
  `encodeStagePathHeader` (`nativeSlicerBridge.ts`), Rust decodes with
  `decode_stage_path_header` (`main.rs`). Any new header that can hold
  user-supplied text needs the same treatment — and because the decoder always
  runs, a sender that skips the encode corrupts paths containing `%`.
- **camelCase in TS → snake_case in Rust.** `serde(rename_all = "camelCase")`
  on the args struct handles the field names; keep payloads flat.
- **Binary vs JSON.** Large binary payloads (mesh geometry, slice output) use a
  two-step staging protocol rather than a giant JSON argument. The bridge
  stages bytes (e.g. `x-mesh-stage-*` headers / chunk append commands) and then
  references them by path or id in the actual command.
- **Atomic writes.** File writes go through `scene_file_begin/commit/discard_atomic`
  so an interrupted save can't corrupt an existing file. Use these for any
  new write path, not `write_bytes_to_path` straight to a user file.
- **Single-flight write lock.** `runExclusiveNativeWrite` serializes process-wide
  writes. Two chunk sequences to different paths evict each other and re-truncate
  — writers must be single-flight.
- **Cancellation.** Long-running commands (slicing, SDF, A* pathfinding) support
  a cancel command (`cancel_slicing`, …). Always offer cancellation for anything
  that runs longer than a second.

## Baked ambient occlusion (`bake_vertex_occlusion`)

`bake_vertex_occlusion(rays?, reach_mm?)` bakes per-vertex ambient occlusion for
a mesh passed **in the request body** as a raw little-endian `f32` triangle soup
(9 floats per triangle). The response is the values as little-endian `f32`, one
per soup corner in the order they were sent, so the frontend maps them onto the
geometry it sent — through the index buffer, when the geometry has one.

**Why the body and not the staging buffer.** It is an instance of the
geometry-indexed rule in *Conventions to respect* above: staging is process-wide
mutable state shared with repair, hole punching and hollowing, so a bake that
read it could compute occlusion for a different mesh than the one the values were
attached to. Raw bytes rather than a JSON `Vec<f32>` because a print-sized soup
is millions of floats and the JS side already has a byte buffer.

The command logs `soup corners -> welded vertices`; that ratio is this feature's
diagnostic. Occlusion is one value per soup corner, merged only where corners are
genuinely shared, so a ratio of 3.0 means nothing welded (the values are then
per-triangle, which reads as a mosaic) and a count that does not divide the corners
means the model's topology is not what the caller assumed.

The algorithm lives in `dragonfruit-mesh-core::vertex_occlusion` (testable
without Tauri, `cargo test -p dragonfruit-mesh-core`), the boundary is
`src-tauri/src/ao_vertex.rs`, and the frontend side is
`src/features/scene/bakedOcclusion.ts` — which attaches the values as the
`aBakedAo` attribute that `softClay` samples. It is on for everyone — it was the
`model-ao` experiment until the bake got cheap enough to ship — with a no-op left
in the plain web build (`canBakeOcclusion()` is false, so the material's strength
uniform stays 0).

Measured bake cost (release), from `cargo test -p dragonfruit-mesh-core --release
-- --ignored --nocapture bench_vertex_occlusion` (a sphere fixture; `verts` are
welded, and the cost tracks vertices × rays rather than triangles):

| triangles | vertices | bake |
| --- | --- | --- |
| 40k | 19.8k | 11 ms |
| 160k | 79.6k | 45 ms |
| 640k | 319k | 203 ms |

On real print geometry, as the meshes arrive *after* refinement, the bake measures
81 ms for the 171k-triangle mesh a 150k one refines into, and **4.8 s for a
2.78M-triangle one** (1.41M vertices, 8 rays, 341 ns per vertex, minimum of five
runs — this machine varies by more than 10% run to run, so single samples are not
worth quoting). Most of the cost is rays, and most of *that* is genuine: with the
reach at 8% of the diagonal, a ray that is **not** occluded — the majority — has to
establish that nothing blocks it anywhere in that sphere. `Bvh` in
`dragonfruit-mesh-core` is therefore flat and leaf-batched (32-byte nodes, 8
triangles per leaf, near-first traversal pruned at the caller's distance; re-measured
at 4, 8 and 16 faces per leaf, 8 still wins). The enum-per-triangle tree it replaced
built 4.3M nodes over 150 MB for that model and spent 15.4 s on the same rays; the
flat one spends 4.8 s.

What the traversal spends its time on is proving the *nearest* hit, so the cheapest
gains are the ones that stop proving it earlier. It may now stop at the first hit
inside the falloff plateau rather than the nearest hit overall, because a hit there
weighs full strength either way — a tenth of the bake on the 2.78M model. The weld
also returns its corner-to-vertex map instead of the bake replaying the traversal
and quantisation to rebuild it, which removes a second hash pass over every corner
(7%) and, more to the point, the two independent chances to disagree about which
corners are the same vertex — the bug class that put occlusion on the wrong
vertices. Only the first of those changed any value, and not by a bit: both models'
output checksums are identical before and after.

Things that do *not* help, all measured: sorting the occluder's vertices along a
Morton curve (1.02×, and this time 1.22× *slower* with the sort included — the cost
is not memory layout), gathering each triangle's vertices into the tree (8% faster
on the 2.78M model for 36 bytes per face, i.e. 100 MB of transient allocation, so
reverted), and dropping the per-ray direction normalisation, which looks redundant
on an orthonormal basis but is not: 13.7% of that model's values move by up to 0.038,
because the rounding error the division removes is enough to flip grazing rays onto
different triangles. Clustering the occluder down to a 250k-triangle budget is 2.3×
faster but moves the field by a mean of 0.19, because the cell size that budget
implies collapses the model's own detail.

### What the material gets: a turned fan, 32 rays, one graph pass

The shipped recipe is the bake with the fan turned per vertex at 32 rays, then one
graph pass; `dev/ambient-occlusion.md` is the page for it, including the GPU
accelerator and its fallback ladder. The measurements and the reasoning follow.

`bake_smoothed_occlusion_for_soup` is what `ao_vertex.rs` calls, and it is three
things stacked, each measured against a reference built from two 64-ray bakes:

| | puck (384,324 verts) | poussin (85,395) |
| --- | --- | --- |
| fixed fan, 8 rays (what shipped) | RMS 0.0554, roughness 0.0303 | RMS 0.0534, roughness 0.0323 |
| turned fan, 32 rays, one graph pass | RMS 0.0242, roughness 0.0097 | RMS 0.0195, roughness 0.0098 |

Roughness here is the mean deviation from a vertex's one-ring average, which is
the mesh-space form of the striping a zoomed view shows. The two levers are
independent: rays buy accuracy, and the graph pass buys smoothness. The pass
alone over the *fixed* fan moves the field 12% closer to the reference; over a
*turned* fan it moves it 34% closer, because a fixed fan's discretisation error
is a function of the local surface shape and is therefore correlated between
neighbours, and averaging correlated error removes nothing. Decorrelating without
following it with a pass is worse than leaving the fan fixed — that is the grain
a per-vertex rotation shipped once and was reverted for — so the two belong
together or not at all.

The pass is one iteration of `out = 0.4·self + 0.6·mean(one-ring)`. One, because
a second leaves the field *further* from the reference than the first (0.0521
against 0.0508 on the puck): it has started averaging the field's own
sub-millimetre detail rather than the estimator's noise. The graph is the mesh's
own connectivity, duplicates included, built as a CSR adjacency inside
`mesh-core`; the pass runs before the field is expanded back out to soup corners,
because a pass over the soup's corner graph would average a vertex with copies of
itself.

32 rays, not eight, is the shipped count: it is where the estimate stops being the
dominant error (0.024 against 0.056 RMS) for a bake of 1.9 s on the puck instead
of 0.5 s, on an idle callback per model. 64 rays reaches 0.008 RMS and costs
3.8 s — the trade a GPU bake is for, which is why that path is worth having even
though the CPU one is correct.

### Occlusion is weighted by how far away the occluder is

A boolean "is anything in the way" query makes a flat base under a mass of detail
as dark as a crevice, and that reads as dirt rather than as shape. The bake asks
for the *nearest* hit instead, and weights it: full weight within a plateau of 15%
of the reach, then a straight taper to nothing at the reach itself.

The plateau matters as much as the taper. An earlier version tapered from zero and
scaled by the *mesh's median edge*, which is tessellation density rather than
feature size: on a densely triangulated model that lands at a couple of
millimetres, so a cape's folds, whose occluders sit five to ten millimetres away,
lost their shading outright while the flat base it was meant to clean kept
everything the material's strength could not put back. The reach is a fraction of
the model's diagonal, so tying the falloff to it keys the weighting to the size
features are actually made at.

Measured on the model the report came from, over three versions of the same bake:

| | flat base (mean / spread) | deepest 5% |
| --- | --- | --- |
| unweighted | 0.915 / 0.121 | 0.250 |
| median-edge falloff | 0.999 / 0.009 | 0.697 |
| plateau and taper | 0.970 / 0.062 | 0.426 |

which the material's `BAKED_OCCLUSION_STRENGTH` maps back to a rendered surface:
at 0.75 the deepest 5% renders at 0.57 against 0.55 for the unweighted bake, so
folds look as they did, while the flat base renders at 0.98 against 0.95. The two
constants are a pair: changing one without the other makes the model flat or
dirty. The bake costs about 30% more than an unweighted one, because a nearest-hit query
cannot stop at the first hit — only at the first hit inside the plateau.

### Faces too long to carry a per-vertex field

The bake samples at vertices, so a face is the resolution it renders at: a base
triangulated as a fan has spokes an order of magnitude longer than the geometry
around it, and the occlusion cast by what sits above it, which varies at about a
millimetre, gets drawn as one straight ramp per spoke. That is the wedge pattern a
low-poly base shows, and no per-vertex trick removes it. Fading the value where the
span is long does not separate a coarse base from a genuine crevice, since both sit
on short edges, and smoothing does not help either: on a fan the mesh-graph
neighbours are ten millimetres away in space.

Import through `io::load_mesh_from_path`, never the format loaders (`io::stl::load`,
`io::obj::load`, `io::three_mf::load`) directly. The refinement lives in the
dispatcher, and the shell's STL path called `io::stl::load` for a while, so the
model in the viewport was never refined while every probe that called the
dispatcher said it was.

A plugin cannot call native code, so geometry an importer builds in the renderer
(LYS, via `plugins/lys-import/`) never reaches that dispatcher either. The host
calls `refine_mesh_soup` after a plugin import instead: soup in the request body,
`[u32 triangle count][positions][normals]` out. It welds the mesh on the way in,
which is what gives the refinement shared edges to split and the normals adjacency
to average over, and it returns normals for the same reason the loaders compute
them, so the importer does not have to repeat the crease rule in TypeScript.

The fix is at the source. `io::load_mesh_from_path` refines faces longer than 2% of
the model's diagonal, which is a quarter of the occlusion reach, before anything
derives data from the mesh, because triangle ids are what the overhang scan,
support placement, masks and caches index. Measured on that base: the longest edge
went from 16.8mm to 1.1mm, its vertices from 1608 to 10261, the model from 150k to
171k triangles (+14%), the bake from 63ms to 74ms, and the refinement itself costs
10ms. Meshes that are already fine are returned untouched, so the common case pays
one pass over the triangles and nothing else.

**Two paths escaped it, and one of them escaped the budget too.** A VOXL scene
carries its models' original STL bytes in its MESH chunks, and the loader handed
them to three's `STLLoader` in the renderer (`loadStlGeometryFromBuffer`), which
is neither the native file dispatcher nor the plugin command, so a scene's models
were never refined at all. The same call now asks `refine_mesh_soup`, which also
gives them the welded, crease-split normals the native loaders produce, and it
asks only below `REFINE_MAX_TRIANGLES` (400k): the command costs twice the mesh in
traffic, and a mesh with faces too long for the field is a mesh with few of them,
so the meshes that need it are the ones small enough to send. Above that limit a
large mesh with a few huge faces still goes unrefined, which is a real gap and the
rarer one.

The budget was the second half. It was `1.3x` the *current* triangle count, spent
longest-edge-first, which is proportional to the mesh that most needs it: measured
on a 12-triangle 120mm block, `1.3x` bought 14 triangles and left the longest edge
untouched at 169.71mm, 48.7x the 3.49mm target, so the model that most shows the
wedge was the one refinement could not touch. `refinement_budget` now returns the
larger of that fraction and a 250k-triangle headroom, which is invisible on the
2.13M-triangle parts the fraction exists to protect (the fraction allows 639k
there). Measured after: the 20-triangle plate-and-boss goes to 9856 triangles with
its longest edge at 2.67mm, against a 3.40mm target, and the reported 768,734-
triangle figure to 772,626 with its longest edge from 4.20mm to 0.81mm (+0.5%).

What that is worth at the shading: rendering the plate-and-boss before and after,
the field the coarse mesh draws differs from the refined one by a mean of 0.014,
a p99 of 0.113 and up to 0.448, and the difference is a star of wedges radiating
from the one dark vertex the plate's fan puts under the boss. The refined field
has no such structure. Subdivision of planar faces changes no geometry: the block's
signed volume is identical before and after.

The frontend keeps two bakes in flight (`AO_BAKE_CONCURRENCY` in
`useSceneCollectionManager.ts`): each command is parallel across vertices on its
own, but the weld, the tree build and the transfer are serial phases, and in a
multi-model scene overlapping them is worth more than one model finishing sooner.

### The estimator's second output, and the lean in it (crate only — nothing consumes it yet)

`dragonfruit-mesh-core::vertex_occlusion` also returns the *visibility moment*
(`VertexVisibility::moment`): the cosine-weighted average of the directions that
escaped, `(1/N) Σ ωᵢ·(1 − wᵢ)`, in the mesh's own frame. It is three accumulates
per sample out of the same ray bundle, not a second bake — measured, the bench
above moves by less than its own run-to-run spread. Two things read it, and they
are one fact: `normalize(moment)` is the vertex's **bent normal**, and the
moment's component in the tangent plane is the occlusion field's **gradient** —
the fan's own moment is the fixed axis `(0, 0, 2/3)·n`, so the blocked and
unblocked moments are two views of one number. The gradient is what a
reconstruction carrying the slope needs, and the slope is what the wedge above is
made of: a chord through three vertex values has a discontinuous slope across
every edge, and a field that carries the slope does not.

Neither is wired up. `ao_vertex.rs` still returns one `f32` per corner and
`softClay` still multiplies by `aBakedAo`. What blocks it is a property of the
fan, measured in the crate's own tests: eight samples do not sum to their axis —
the mean is 0.057 off it, a **4.85° lean** (16 rays: 0.030, 2.58°; 32: 0.016,
1.39°; 64: 0.009, 0.75°) — and the lean is *coherent*, the same direction in
every vertex's own tangent frame, so an open surface would read as uniformly
tilted rather than as noise. A directional payload wants that decorrelated, or a
higher ray count (which is not free).

Doing the decorrelation by rotating each vertex's fan by a hash of its position
was tried and reverted. It does turn the lean into incoherent error, and the
scalar's mean moved by only 0.002 and its p5 by 0.006 on two occluding fixtures —
the wrong measurement, because it says the field did not *shift*, not that it
stopped being *smooth*. Incoherent at the vertex scale is grain wherever the
screen resolves single triangles as pixels: on the model this was reported
against, 768,734 triangles on a 24mm figure, a zoomed view puts several pixels on
one triangle and the surface speckles. A directional payload wants error that
stays smooth across neighbours, which the per-vertex hash is exactly the opposite
of.

**The moment is a direction, not the slope, and the difference is not a
constant.** A direction moment weights every blocked direction equally; the
derivative of the field weights each by how far away its occluder is, because
moving the receiver moves a far silhouette less than a near one. For a
differential occluder patch the two kernels differ by exactly `1/|d|`, so a
blocked moment weighted by `w/t` was accumulated as a slope — and measured
against the field's own box-smoothed finite difference on a 0.2mm floor facing a
6mm wall, the ratio between them runs 0.6, 0.6, 2.5, 4.0, 4.7, 5.9, 8.6, 12.3,
21.8, 56 across ten stations from the wall out to the reach. The 4 the
differential case predicts is there in the middle of that run and nowhere else,
because past it what the accumulator is differentiating is the falloff weighting
and not the geometry, and next to the wall the occluder subtends a solid angle
the differential case does not describe. So the moment is what a reconstruction
should take its *direction* from, and an estimator of the slope itself is still
open. It was reverted rather than shipped: nothing consumes a payload whose
magnitude is off by two orders of magnitude at the ends of its range.

## Native mesh loading (`load_mesh_file`, `load_mesh_bytes`)

One command reads a mesh from disk in Rust and hands it to the renderer as the
`DFMX` binary payload specified in `dev/mesh-wire-formats.md`: a 32-byte header,
a body table, then one positions-and-normals soup per body.

`load_mesh_file` takes `filePath` and an optional `classify` (default true). It
dispatches through `io::load_mesh_bodies_from_path` — `stl`/`obj` give one body;
`3mf` gives one per `<build><item>` expanded through its components, with
transforms baked — refines coarse faces per body, and adds one STL-only step in
front: a mesh too large to render (its triangle count read from the binary-STL
header) is decimated into a preview, and an oversized ASCII STL is refused.

With `classify` true and a single body, the loader also runs the model/support
classifier and ships its report in the payload's metadata tail, so a classify-only
import has nothing left to stage or round-trip. A caller that will repair passes
`classify: false`: that pass classifies too, and its report is the one that
matters.

Materials and units are dropped, matching the renderer's loaders. The TS seam is
`loadMeshFileFromNativePath` in `nativeSlicerBridge.ts`.

`load_mesh_bytes` is the twin for a source with no on-disk path — a VOXL's
embedded mesh chunk, or a file expanded out of a zip. The body is the raw file
(binary or ASCII STL), and the response is the same `DFMX` payload, so both share
one decoder. Its `classify` flag rides in an `x-mesh-classify` header, because a
raw-body command cannot also take JSON arguments. The TS seam is `loadMeshBytes`.

Both loaders classify a single-body load when asked, so an import that will not
repair has nothing left to run: the geometry arrives section-ordered, the report
rides the metadata tail, and the frontend passes it to `processGeometry` as
`bakedClassification`. Which imports ask is `wantsLoaderClassification`
(`useStlGeometry.ts`): a classify-only import does; one that may auto-repair does
not, because that pass classifies too.

### Deferred post-processing

An import passes `deferHeavyPostProcessing`, so `processGeometry` does not build
the BVH, compute the flattening planes, or await the AO bake before the model is
on screen. The result carries `postProcessingDeferred`, and
`useSceneCollectionManager` finalizes it the same way it does a geometry swap:
`finalizeModelGeometryPostProcessing` builds the BVH and schedules the planes on
idle, and the AO sweep picks up a geometry with no `aBakedAo`. `hasPendingBackgroundGeometryWork`
reports while that queue is still draining.

## The Rust side of the seam

Where the TS side is a set of wrappers, the native side keeps its cross-command
state in process-wide `OnceLock` statics in `main.rs`:

- `SLICER_POOL: OnceLock<ThreadPool>` — the Rayon pool jobs run on.
- `CANCEL_FLAG: OnceLock<Arc<AtomicBool>>` — shared with the worker, checked in
  hot loops; the cancel command just flips it.
- `STAGED_MESH`, `STAGED_MESH_STATS`, `STAGED_MESH_FILE_PATH`,
  `STAGED_MESH_FILE_APPENDER` — the staging protocol's buffer, counters,
  scratch path and appender.

That the staging state is a **process-wide singleton, not per-call**, is the
reason writers must be single-flight: two overlapping stage sequences share
these statics.

**The runtime backend is a compile-time choice.** `src-tauri/Cargo.toml` builds
Tauri with `default-features = false` and selects the backend by feature —
`tauri-wry` or `tauri-cef` (`tauri-cef = ["tauri/cef"]`, used for Linux CEF
builds). `main.rs` branches on `#[cfg(feature = "tauri-cef")]`, so anything
touching the app handle type has to compile under both.

## Dialog helpers

Native pickers are wrapped with explicit filter control:

- `pick_open_files` takes a `category` (`mesh`/`scene`/`bundle`). Scene dialogs
  accept an optional `sceneExtensions` override so gated file types (see
  `dev/experiments-framework.md`) are hidden from the filter.
- `pick_save_path` takes `defaultFilename` + `filters`.
- `local_backup_pick_directory` is a folder picker.

## Guardrails

- `npm run build` type-checks the TS side, so a wrapper whose *signature* drifts
  from its callers fails the build. Note what this does **not** catch: the
  command name is a plain string, so a wrapper naming a command that no longer
  exists in Rust type-checks fine and fails at runtime. Nothing verifies the two
  sides agree — grep the Rust side when renaming a command.
- The `toNativeMetadataPayload` mapper is exported and covered by a crossing
  contract test — update the test when the metadata shape changes.
- `cargo check --manifest-path src-tauri/Cargo.toml` before touching the Rust side.

## Related pages

- `dev/experiments-framework.md` (dialog extension gating)
- `dev/backlog.md` (native twin optimization roadmap)
