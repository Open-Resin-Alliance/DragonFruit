# Ambient Occlusion

The model's shading carries a baked ambient-occlusion field: one number per
vertex, sampled by the native side once per model and multiplied into the
material. This page is the contract for it — where it comes from, what the
shipped recipe is, and how the GPU accelerator slots in without becoming a second
estimator.

## Where it lives

| piece | file |
| --- | --- |
| the estimator and the recipe | `rust/dragonfruit-mesh-core/src/vertex_occlusion.rs` |
| the GPU accelerator | `rust/dragonfruit-ao-gpu/` |
| the IPC boundary | `src-tauri/src/ao_vertex.rs` (`bake_vertex_occlusion`) |
| the frontend side | `src/features/scene/bakedOcclusion.ts` |
| the material | `src/features/shaders/mesh/softClay.tsx` |

Standard and Profile views share this material recipe. Profile adds the scene
PLS height colors before lighting; it retains the same baked and cavity
occlusion instead of replacing model shading. Other diagnostic view modes do
not apply the baked field. See [Profile model view](slice-job-assembly.md#profile-model-view).

The bake returns one `f32` per soup corner, in the order the soup was sent, and
the frontend attaches them as the `aBakedAo` attribute that `softClay` samples.
The mesh travels **in the request body**, never through the shared staging
buffer: staging is process-wide state that repair, punching and hollowing write,
so a bake that read it could compute occlusion for a different mesh than the one
the values get attached to. See `tauri-ipc-bridge.md` for that seam's rules.

## Where the bake is requested

Two call sites, and both must leave the geometry with `aBakedAo`:

- `processGeometry` (`src/hooks/useStlGeometry.ts`) starts the bake as soon as the
  geometry's positions are final and attaches the field before the model reaches
  the scene, so a model's first frame already carries it. Every import goes
  through prep, which makes this the one that covers the common case.
- The idle sweep in `useSceneCollectionManager.ts` is the net for a geometry
  that never went through prep — one restored from a project, or one swapped in
  by a repair, a boolean cut or a hole punch.

**The bake starts before the BVH and the flattening planes, not after them.** It is
native work — a GPU kernel where the machine has one, and the measured bake is
0.4-1.2 s per model on a print-sized part — while those two are main-thread work.
In sequence they cost their sum; started early they cost the longer of the two.
What was tried and reverted is *deferring* the bake (to an idle callback, after the
model is visible, which is the pop-in this design exists to prevent), not overlapping
it.

A batch import — a VOXL scene, or several files at once — passes
`_deferOcclusionBake` instead of waiting per model: the bake is still started at the
same point in that model's prep, but the *wait* is collected and taken once, after
every mesh in the batch has been prepared and before any model is placed. On the
15-model scene measured in `backlog.md` the thirteen bakes total 7.4 s of GPU time
that used to run one model at a time, with the main thread idle in between.

**A geometry whose mesh the loader kept is baked by token, not by upload.** The native
loader registers each model's refined mesh as it encodes the `DFMX` payload and reports a
token in the header (`mesh-wire-formats.md`); the bake sends forty bytes naming it, and
the native side welds nothing — the mesh it uses is the one the loader already welded and
indexed. The field is the same by construction: measured on a real model, re-welding the
same soup at the bake's own epsilon produces the identical vertex set and a bit-identical
field. The token is recorded against the geometry's *position array* and checked natively
against the corner count, so a geometry that was repaired, swapped, cloned or rewritten
since — and an evicted token — fall back to the soup path, which cannot go stale. That
fallback is what every other geometry uses: a plugin's, a repaired one, a file out of a
zip.

The recording happens in the loader, immediately after the decoded bodies are merged and
*before* prep runs (`rememberLoadedMeshMesh`, called from `loadMeshGeometryFromRange` — the
range load is the one path whose `DFMX` header carries a token). It used to happen at the
end of prep, which was one pass too late: a classify pass replaces the position attribute
with the reordered soup at the same corner count, so the array recorded afterwards was the
*new* one and the guard passed — the bake then indexed the loader's triangle order into a
geometry drawn in the classifier's order, one triangle over, which renders as speckle.
Recorded first, the reorder invalidates the token by itself. A centering translate mutates
the array in place and correctly keeps it.

`aBakedAo` is the queue's only key, so the sweep must not re-issue a bake whose
result has not landed yet: a geometry with a bake in flight has no attribute, and
looks exactly like one that was never baked. The sweep therefore keeps the
geometries it has on the wire (`pendingAoGeometriesRef`) out of its queue, and
attaches whatever comes back even when the effect run that started it was
superseded — the values belong to that geometry, and discarding them is what left
it unbaked and re-queueable on the next `models` change. Both halves are needed:
without the first, one `models` change during a bake sends the soup twice; without
the second, the same model is re-baked on every later change.

**"Outstanding" is the run's remaining queue plus the bakes in flight**, and both
are state rather than bookkeeping: the queue is `pendingAoQueueRef`, *replaced*
wholesale by each effect run (so a superseded run cannot leave anything counted —
the workers shift the same array), and the in-flight count rides the take. It used
to be the run's whole queue added up front and returned a bake at a time, which
leaked a count per superseded run: every `models` change while a bake was queued
(a hollowing apply patches them, the idle plane pass patches them again) left the
count above zero forever, and `hasPendingBackgroundGeometryWork()` is what the
modifier-apply overlay polls to clear its "loading mesh" spinner — it then waited
out its 20-second cap with all the work already done.

## The shipped recipe

`bake_smoothed_occlusion_for_soup` is what the command calls: the estimator with
the fan **turned per vertex**, 32 rays, then **one pass** of mesh-graph
smoothing. Measured against a reference built from two 64-ray bakes:

| | 384,324-vertex model | 85,395-vertex model |
| --- | --- | --- |
| fixed fan, 8 rays | RMS 0.0554, roughness 0.0303 | RMS 0.0534, roughness 0.0323 |
| turned fan, 32 rays, one pass | RMS 0.0242, roughness 0.0097 | RMS 0.0195, roughness 0.0098 |

Roughness is the mean deviation from a vertex's one-ring average, the mesh-space
form of the striping a zoomed view shows. The two levers are independent — rays
buy accuracy, the pass buys smoothness — and they belong together: a fixed fan's
discretisation error is correlated between neighbours, so a pass over it moves the
field 12% toward the reference, where a pass over a *turned* fan moves it 34%.
Decorrelating without following it with a pass is worse than leaving the fan
fixed, which is why `SMOOTHING_PASSES` and the turn ship as one thing.

The pass runs on the welded mesh, before values are expanded back out to corners:
a pass over the soup's corner graph would average a vertex with copies of itself.
One pass, not more, because a second moves the field *further* from the reference
— it has started averaging the field's own sub-millimetre detail.

## The GPU accelerator, and the fallback ladder

`dragonfruit-ao-gpu` runs the same estimator as a compute shader: same BVH (via
`Bvh::gpu_layout`), same falloff, same fan. It is an accelerator, never a
requirement.

| machine | what runs |
| --- | --- |
| a discrete GPU (Vulkan, Metal, DX12, GL) | the compute bake; measured 9–14× the CPU (0.14 s against 1.78 s at 32 rays on the 384,324-vertex model) |
| an adapter that fails or disappears mid-bake | the CPU recipe, with the failure logged |
| no discrete GPU (integrated-only or software) | AO is disabled; no bake runs |

**AO is only baked when a discrete GPU is present.** The IPC boundary checks
`dragonfruit_ao_gpu::has_discrete_adapter()` before the request is sent, and
`bake_vertex_occlusion` refuses without one, so integrated-only machines render
unoccluded instead of spending bake time. The crate itself can still bake on an
integrated adapter if called directly; the policy lives at the boundary, not in
the accelerator.

**Hardware ray tracing is not required and not used.** wgpu exposes ray query
only on Vulkan (on this development machine: true on Vulkan, false on DX12 and
GL, and no path at all on macOS), so a ray-query kernel would be a Vulkan-only
feature. The traversal is a compute shader over the same flat BVH the CPU walks,
which runs everywhere — that is why the crate depends on nothing but wgpu.

The two paths are required to agree: `tests/gpu_matches_cpu.rs` bakes a fixture
with both and fails on a mean difference over `1e-4`. The smoothing pass stays in
`mesh-core` and runs on the CPU for both, so the two paths cannot drift into
different fields.

## Constraints to keep

- **A new ray count is a look change.** The field's mean moves when the ray count
  or the fan changes; the material's `BAKED_OCCLUSION_STRENGTH` and the slider
  default were tuned as a pair with the estimator, so re-tune them together.
- **The fan turn needs the pass.** See above; shipping one without the other is
  the grain regression recorded in `backlog.md`.
- **Weld before you smooth.** Both soup entry points weld with
  `SOUP_MERGE_EPSILON`; a caller that welds with its own tolerance bakes a
  different mesh than the corners it expands onto.
- **A bake's values belong to the corner table its soup was expanded through, not
  to whatever the geometry's index is when the reply lands.** The bake can be
  started long before the geometry is finished — that is how it overlaps the BVH
  and the flattening planes — and those steps re-index geometry (building the BVH
  gives a soup an index it did not have). `bakeOcclusionForGeometry` snapshots the
  table with the request and maps through the snapshot; `mapCornerValuesToVertices`
  takes it as a parameter for that reason. Reading the live index at reply time
  landed the field one triangle over, which shows as speckled shading on an
  imported mesh (`backlog.md`, "a Rust mesh result must be indexed against the
  geometry you sent").

## Related pages

- `dev/tauri-ipc-bridge.md` — the IPC seam, the staging rule, the measured bake
  costs, and the falloff's rationale
- `dev/backlog.md` — the measurements behind every number above
- `rust/dragonfruit-mesh-core/src/bvh.rs` — `Bvh::gpu_layout`, the layout a
  shader mirrors, with the mirror traversal as a test
