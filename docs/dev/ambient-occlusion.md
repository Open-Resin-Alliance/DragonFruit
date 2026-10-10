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

The bake returns one `f32` per soup corner, in the order the soup was sent, and
the frontend attaches them as the `aBakedAo` attribute that `softClay` samples.
The mesh travels **in the request body**, never through the shared staging
buffer: staging is process-wide state that repair, punching and hollowing write,
so a bake that read it could compute occlusion for a different mesh than the one
the values get attached to. See `tauri-ipc-bridge.md` for that seam's rules.

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
| any GPU wgpu can make a device for (Vulkan, Metal, DX12, GL, integrated) | the compute bake; measured 9–14× the CPU (0.14 s against 1.78 s at 32 rays on the 384,324-vertex model) |
| an adapter that fails or disappears mid-bake | the CPU recipe, with the failure logged |
| no adapter at all | the CPU recipe |

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

## Related pages

- `dev/tauri-ipc-bridge.md` — the IPC seam, the staging rule, the measured bake
  costs, and the falloff's rationale
- `dev/backlog.md` — the measurements behind every number above
- `rust/dragonfruit-mesh-core/src/bvh.rs` — `Bvh::gpu_layout`, the layout a
  shader mirrors, with the mirror traversal as a test
