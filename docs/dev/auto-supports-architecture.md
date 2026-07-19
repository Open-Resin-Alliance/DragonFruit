# Auto Supports Architecture

Auto Supports is a planner pipeline, not a loop around the manual Add Support action. Every stage has deterministic inputs and outputs, nothing mutates support state until the user accepts, and the result is verified empirically before it is offered.

Code lives under `src/supports/autoSupport/`.

## Pipeline

1. **Segment** — `buildVolumeHierarchy` builds a layer-to-layer component graph from the island scan; graph roots become logical unsupported volumes (`contactPlanner.ts`). Volumes whose base prints within the first layer are plate-supported and excluded.
2. **Plan contacts** — coverage-driven selection per volume: centroid plus farthest-point samples over the base footprint, with per-volume and global caps derived from spacing and area. Existing support tips act as exclusion zones, so re-runs only plan what is uncovered.
3. **Route** — `routePlanner.ts` builds collision-checked trunks via the pathfinding placement stack, with typed failure reasons (`no_surface`, `tip_spacing`, or a `LimitationCode`). Failures are isolated per contact.
4. **Rescue ladder** — volumes whose contacts all failed escalate through: a trunk retry with a deeper A* budget and wider tip search, on-model sticks (`stickFallback.ts`: vertical first, then gently tilted toward flatter anchors), then both stages again with slim detail geometry for tiny features in cramped spots.
5. **Surface fill** — `overhangSampler.ts` grids all downward-facing surface beyond the preset's overhang threshold and routes best-effort supports there. Islands alone under-support large connected overhangs against peel forces; fill failures lean on neighbors and are never reported as unresolved.
6. **Verify and repair** — `verifyCoverage.ts` re-scans the model merged with planned and committed support geometry. Anything still flagged gets one bounded repair round through the rescue ladder (tight spacing floor — verification evidence beats aesthetic spacing), then a second scan confirms.
7. **Preview and accept** — supports render as ghost geometry; accept commits everything (optionally plus auto-bracing) as one history entry.

## Support sizing

- Volumes above the preset's `structuralVolumeMm3` route with scaled-up overrides (1.5× shaft and contact tip, 1.25× roots and cone body) relative to the user's configured sizes.
- The detail rescue uses fixed slim overrides (0.6 mm shaft, 0.2 mm contact tip, short cones).

## Verification details

- Support contact points get small weld spheres in the verification geometry. Printed tips penetrate and fuse with the surface; without the weld, a sub-pixel contact fails the scan's minimum layer overlap and a physically supported region reads as an island.
- Flagged spots within 3 mm of a support tip, or within 2 mm of a support shaft segment, are scan artifacts (voxel linkage, self-intersecting unioned source meshes, the overhanging foot of a tilted strut) and are excluded from the reported count. This filter runs before the repair decision, so a steady-state generation pays one verification scan.
- `buildStick` collision checks start at the disk-offset cone start and slide each cone to a clearing standoff via `calculateSafeOffset` — checks rooted on the raw surface point always graze the curved geometry the cone is seated on (the false-positive family of issue [#342](https://github.com/Open-Resin-Alliance/DragonFruit/issues/342)).

## Threading

- The whole pipeline (hierarchy, planning, routing, sampling, coverage evaluation) runs in a dedicated web worker (`autoSupportRoute.worker.ts`, wrapped by `workerRouter.ts`). The worker receives the local-space geometry, world matrix, and the serialized BVH — deserializing beats rebuilding by tens of seconds on dense meshes.
- The worker persists per model and transform; its mesh, BVH, and SDF cache are reused across generations.
- Every wrapper method falls back to the in-thread implementation when the worker is unavailable, so a broken worker degrades to jank instead of a hang.
- Beware `typeof window` guards in worker-reachable modules: the bundler compiles them to constants in browser-destined chunks, including worker chunks. Use `globalThis.window` checks instead (see `pathfindingPerf.ts`).
- Island scans run natively (`run_island_scan_native`): z-bucketed parallel rasterization plus the parallel scan pipeline in `rust/dragonfruit-islands`. Scans are cancellable via `cancel_island_scan_native`.

## Testing

- Unit tests cover segmentation merge/split, contact determinism, exclusion zones, the rescue ladder, surface sampling, verification evaluation, and stick geometry (`src/supports/autoSupport/__tests__/`).
- The routers are injectable throughout (`routeContacts` / `routeSticks` / `sampleSurface`), so pipeline behavior is testable without meshes or pathfinding.
- Manual reference models: a ~450k-triangle miniature and a ~4.4M-triangle multi-part model; the naive prototype this design replaced generated ~400 supports where the pipeline plans a verified sparse set.

## Deferred

- Automatic parenting / shared trunks: contact spacing prevents adjacent redundant trunks, Auto Brace covers cross-connection, and attachment-quality scoring is an open problem ([#193](https://github.com/Open-Resin-Alliance/DragonFruit/issues/193)).
- Protected-face inputs and auto-orientation, pending [PR #224](https://github.com/Open-Resin-Alliance/DragonFruit/pull/224).

## Related

- [Auto Supports workflow](../workflows/auto-supports.md)
- [Branch Supports](branch-supports.md)
- [Island Analysis and Voxels](../features/island-analysis.md)
