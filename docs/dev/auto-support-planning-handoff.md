# Auto-Support Planning Handoff

<!-- markdownlint-disable MD013 -->

This document is the durable handoff for the DragonFruit auto-support work discussed and prototyped on July 18, 2026. It is intended to preserve product decisions, issue research, implementation context, known mistakes, architecture direction, validation requirements, and exact next steps across agent compaction or a fresh development session.

## Executive summary

DragonFruit needs a one-click auto-support workflow, but it must not create one support for every raw island detection.

The current worktree contains an experimental implementation that processes every visible unsupported island and attempts to add one complete trunk per island. Testing with `~/Downloads/immortal.stl` generated roughly 400 supports. That result is unacceptable because it wastes resin, damages the model with excessive contacts, creates unnecessary routing and bracing complexity, and does not match how production auto-support systems should operate.

Do not ship or commit the current batch behavior as the auto-support solution.

The correct system must first identify logical unsupported volumes, generate multiple candidate contact points, select a small coverage-driven set of contacts, route those contacts safely, parent nearby supports where appropriate, present a preview, and leave only genuinely unresolved regions for manual work.

## Product decision

The user explicitly rejected the island-by-island workflow and the naive batch workflow.

The product must provide:

- A single Auto Supports action.
- A reasonable number of supports rather than one support per scan result.
- Automatic handling of straightforward and structurally important unsupported regions.
- A preview before supports are committed.
- A report of unresolved regions that still need manual work.
- Density or quality presets such as Light, Normal, and Heavy.
- Safe failure when a route genuinely cannot be generated.
- One undo action for the committed auto-support result.

The product must not require the user to repeat Next, Add Support, Next, Add Support.

The product must not create a dense infill-like support network.

## Current state

The naive batch prototype this section originally described has been replaced. See the Status section at the end of this document for what is implemented on `feat/auto-supports`. The primary manual test model remains `~/Downloads/immortal.stl`.

## Manual observations

The main manual test used `~/Downloads/immortal.stl`:

- Approximately 453,000 polygons.
- Approximately 366 voxel islands in the tested scan.
- Native Tauri minima scanning found approximately 138 minima.
- The naive batch generated roughly 400 supports.
- Many individual placements initially failed with model-collision messages.
- Expanding candidate surface sampling improved placement success but did not solve the density problem.

The important conclusion is that route success is not the primary planning problem. Even perfect routing would still produce far too many supports if every raw detection became a target.

## Issue and pull request research

There is no single complete auto-support specification. The intended behavior is distributed across issues and prior support-system work.

### Logical island volumes are a prerequisite

[#8: Continue Island Volume Identification via Voxel-Based Logical Separation](https://github.com/Open-Resin-Alliance/DragonFruit/issues/8) explicitly states that reliable logical island-volume identification is critical for auto-support planning.

The issue identifies the current blocker:

- Raw voxel components may be split or merged incorrectly.
- Near-touching geometry needs deterministic separation rules.
- Voxel resolution and tolerance affect downstream decisions.
- Output must be stable and regression-tested before auto-support planning can rely on it.

Treat this issue as a foundational dependency, not an optional improvement.

### Fewer substantial supports are preferred

[#209: Hollowing-Specific supports](https://github.com/Open-Resin-Alliance/DragonFruit/issues/209) contains the clearest product guidance.

The discussion says:

- The goal is the sweet spot between too many supports and too few.
- Fewer substantial supports can be better than many weak supports.
- Auto support should start from good island detection.
- DragonFruit must not fill an object with an infill network of supports.
- Dense internal support networks waste resin and can trap resin.
- Interior and exterior supports may require different presets and connection behavior.

The issue also suggests applying an appropriate selected support preset across highlighted regions, which implies template-driven planning rather than one fixed support type for every target.

### Placement needs preview and spacing controls

[#184: Radial support generation](https://github.com/Open-Resin-Alliance/DragonFruit/issues/184) requests:

- User-adjustable placement intervals.
- A preview before committing support generation.
- Repeated spatial patterns around a defined region.
- Confirmation before supports are created.

These requirements should carry into auto supports. A generated plan must be inspectable before it mutates the support graph.

### Contact planning and routing are separate stages

[#62: Recalculation Supports on grid](https://github.com/Open-Resin-Alliance/DragonFruit/issues/62) requires preserving support-tip positions while rerouting and automatically parenting trunks.

This establishes an important architecture boundary:

- Contact points are the planner's output.
- Routing and parenting operate on those fixed contact points.
- Users should be able to reroute without changing the planned surface contacts.

Do not combine contact selection and trunk routing into one opaque step.

### Generated structures must be grouped and deterministic

[#6: Auto Bracing with Group Size Controls](https://github.com/Open-Resin-Alliance/DragonFruit/issues/6) requires:

- Deterministic generation.
- Spatial grouping with minimum and maximum group sizes.
- Graceful handling of remainder items.
- Prevention of a giant merged structure.

The same principles apply to support contact planning and parenting.

### Parenting quality remains an open problem

[#193: Optimizing parenting at grid support](https://github.com/Open-Resin-Alliance/DragonFruit/issues/193) shows unresolved quality problems around child attachment height and shaft angle.

Auto supports must not assume that existing parenting is always visually or structurally optimal. Parenting quality needs explicit scoring and validation.

### Collision reliability must be verified first

[#342: Support placement blocked by false collision of contact cone with model](https://github.com/Open-Resin-Alliance/DragonFruit/issues/342) reports false placement failures caused by contact-cone collision checks.

[PR #343: Fix support placement blocks and auto-bracing undo history](https://github.com/Open-Resin-Alliance/DragonFruit/pull/343) claims to fix the issue, but the issue remains open as of July 18, 2026.

Before evaluating auto-support coverage, reproduce the reported collision cases against current `origin/main` and determine whether the issue is fixed, partially fixed, or regressed. Otherwise the planner will incorrectly classify valid candidates as unresolved.

### Existing routing and grouping work should be reused

[PR #197: Supports pathfinding v3](https://github.com/Open-Resin-Alliance/DragonFruit/pull/197) provides the current collision-aware routing, socket rescue, committed-base selection, and chain ranking behavior.

[PR #18: Auto-bracing v2](https://github.com/Open-Resin-Alliance/DragonFruit/pull/18) uses minimum spanning trees, mesh-clearance checks, and secondary-axis passes to avoid redundant brace networks.

[PR #49: Voronoi Autobraces](https://github.com/Open-Resin-Alliance/DragonFruit/pull/49) adds Voronoi partitioning and grouped spatial generation.

These algorithms are useful references for support grouping and shared-parent planning. Do not independently invent another unrelated spatial partitioning system without first evaluating these modules.

### Orientation and protected faces are natural planner inputs

[PR #224: Auto-orientation with protected-face painting](https://github.com/Open-Resin-Alliance/DragonFruit/pull/224) introduces candidate orientation scoring and protected-face masks.

The auto-support planner should eventually accept protected faces as hard exclusions or strong penalties. Auto orientation should run before auto supports or expose a shared scoring contract.

## Core architectural principle

Auto supports must be implemented as a planner pipeline, not as a loop around the manual Add Support action.

The pipeline should have distinct stages:

1. Analyze unsupported geometry.
2. Build logical unsupported volumes.
3. Generate candidate contacts.
4. Select a minimal coverage set.
5. Route and parent the selected contacts.
6. Preview the proposed support graph.
7. Verify coverage and unresolved regions.
8. Commit the accepted graph as one history action.

Each stage needs deterministic inputs and outputs so it can be tested independently.

## Proposed domain model

Introduce explicit planner types rather than passing `DetectedIsland[]` through the whole system.

### Unsupported volume

An unsupported volume should represent one logically connected unsupported printing problem rather than one scan marker.

Suggested fields:

- Stable deterministic ID.
- Member voxel islands and minima detections.
- Lowest contact layer and highest affected layer.
- Layer duration.
- Contact footprint.
- Maximum and average cross-sectional area.
- Estimated unsupported volume.
- World-space bounds.
- Surface samples.
- Interior or exterior classification when known.
- Structural-load proxy.
- Existing support coverage.
- Protected-face overlap.
- Confidence or ambiguity score for segmentation.

### Contact candidate

A contact candidate should represent a possible support tip before routing.

Suggested fields:

- World-space point.
- World-space surface normal.
- Source unsupported volume ID.
- Covered sample IDs or estimated coverage region.
- Surface curvature or local stability score.
- Distance from protected faces.
- Distance from existing contacts.
- Visibility and removability score.
- Interior or exterior support preset.
- Preliminary pathfinding result.
- Candidate rejection reason.

### Planned support

A planned support should keep the selected contact independent from its route.

Suggested fields:

- Contact candidate ID.
- Fixed tip position and normal.
- Selected support preset.
- Route result.
- Parent or shared-trunk assignment.
- Brace group assignment.
- Covered unsupported volume samples.
- Warning or unresolved metadata.

## Phase 0: Establish a trustworthy baseline

Do this before implementing the planner.

### Tasks

- Fetch latest `origin/main` and compare the branch against it.
- Reproduce [#342](https://github.com/Open-Resin-Alliance/DragonFruit/issues/342) using current support placement.
- Verify that valid surface contacts are not rejected by contact-cone collision logic.
- Add regression fixtures for any remaining false-collision cases.
- Confirm that generated trunks are rasterized, exported, deleted, and associated with the correct model.
- Review [#384](https://github.com/Open-Resin-Alliance/DragonFruit/issues/384) because unregistered root supports would invalidate auto-support output.
- Record baseline metrics for `immortal.stl` and at least three synthetic fixtures.

### Baseline metrics

- Raw voxel-island count.
- Raw minima count.
- Intersection count.
- Logical unsupported-volume count when available.
- Existing manual support count.
- Placement collision false-negative rate.
- Scan time.
- Route time per candidate.
- Total generated support material proxy.

### Phase 0 acceptance criteria

- Known valid manual placements route successfully.
- Collision failures have reproducible geometric reasons.
- Generated supports survive export and reload.
- Baseline metrics are captured in tests or a repeatable benchmark script.

## Phase 1: Logical unsupported-volume segmentation

This phase addresses [#8](https://github.com/Open-Resin-Alliance/DragonFruit/issues/8).

### Proposed approach

Build a layer-to-layer component graph:

- Nodes represent unsupported connected components on one layer or a compact layer span.
- Edges connect nodes with sufficient projected overlap or voxel adjacency on consecutive layers.
- Splits and merges are represented explicitly.
- A logical volume follows printing dependency rather than simple Euclidean proximity.
- Near-touching regions remain separate unless their printed load path genuinely joins.

Use stable ordering and deterministic tie-breaking for all ambiguous cases.

### Required fixtures

- One floating cube.
- Two separate floating cubes that later merge.
- One volume that splits into two lobes.
- Near-touching surfaces that must remain separate.
- Thin bridges.
- Small decorative details near a large unsupported mass.
- Interior peaks in a hollow shell.
- The relevant difficult regions from `immortal.stl`.

### Phase 1 acceptance criteria

- Repeated scans return identical volume IDs and membership.
- Raw detections are substantially consolidated on complex models.
- Known separate regions do not merge due to voxel tolerance.
- Known continuous regions do not fragment into hundreds of targets.
- Segmentation output contains enough geometry for coverage planning.

## Phase 2: Candidate contact generation

Generate more possible contacts than will ultimately be used.

### Candidate sources

- Lowest stable surface points of each unsupported volume.
- Contact-footprint centroid.
- Contour extrema.
- Farthest-point samples over large footprints.
- Local minima that are not duplicates of voxel-derived candidates.
- Additional structural candidates for long-lived or high-load volumes.

### Candidate rules

- Candidates must resolve to a downward-facing printable surface.
- Candidates must respect protected-face exclusions.
- Candidates must satisfy minimum contact spacing.
- Candidates must not be generated from insignificant one-layer noise unless a preset explicitly requests maximum detail coverage.
- Candidate count must be capped by area and spacing rather than raw scan-marker count.

### Current reusable code

`src/supports/autoSupport/islandSupportSurface.ts` contains useful experimental logic for constructing a transformed raycast mesh and resolving nearby downward-facing surfaces.

Reuse or refactor:

- `createIslandSupportMesh`
- `disposeIslandSupportMesh`
- Surface-normal resolution
- Contact-footprint sampling concepts

Do not preserve the arbitrary default of ten candidates as a product rule. Candidate count belongs to the planner and should derive from volume size, spacing, and preset settings.

### Phase 2 acceptance criteria

- Candidate generation is deterministic.
- Large regions produce spatially distributed candidates.
- Tiny regions produce zero or one candidate according to threshold policy.
- Protected regions produce no forbidden contacts.
- Candidate generation does not mutate support state.

## Phase 3: Coverage-driven contact selection

This phase is the main correction to the naive batch implementation.

### Required behavior

- Select the smallest reasonable set of contacts that covers unsupported volumes.
- Prefer candidates that cover multiple nearby samples or related detections.
- Prioritize the lowest and most structurally important part of each volume.
- Penalize redundant contacts.
- Stop adding contacts when the configured coverage target is met.
- Permit unresolved regions when safe routing is impossible.

### Suggested algorithm

Start with a deterministic weighted greedy set-cover planner:

1. Represent each unsupported volume as weighted coverage samples.
2. Compute which samples each contact candidate can stabilize.
3. Score each candidate by uncovered weight gained divided by support cost.
4. Select the highest-scoring candidate.
5. Mark its samples covered.
6. Recompute marginal scores.
7. Stop when the preset coverage target is reached or no valid candidates remain.

Possible support-cost terms:

- Estimated shaft length.
- Root and raft material.
- Contact damage risk.
- Route complexity.
- Need for an independent trunk instead of shared parenting.
- Interior cleaning impact.

Possible coverage-weight terms:

- Low initial layers.
- Long-lived unsupported volumes.
- Large projected area.
- High structural-load proxy.
- Isolated fine details.

### Density presets

Start with three presets implemented as planner parameters rather than separate algorithms.

Light:

- Higher minimum region threshold.
- Wider contact spacing.
- Lower target coverage.
- Prefer shared trunks.

Normal:

- Balanced region threshold and spacing.
- Full coverage of significant volume roots.
- Additional candidates for large or long-lived regions.

Heavy:

- Lower region threshold.
- Tighter spacing.
- Higher redundancy for structural regions.
- Stronger support presets where appropriate.

Do not invent final numeric defaults without printing tests and project-owner review.

### Phase 3 acceptance criteria

- Support count is materially lower than raw detection count.
- Increasing density monotonically increases or preserves planned coverage.
- Re-running with identical inputs produces identical selected contacts.
- No duplicate contacts are selected within the configured spacing.
- The planner reports why each unresolved volume remains unresolved.

## Phase 4: Routing and automatic parenting

Only selected contacts should enter this phase.

### Routing

- Use `buildTrunkData` or a lower-level placement API from the Pathfinding V3 system.
- Keep tip position and tip normal fixed unless the planner explicitly chooses an alternate candidate.
- Preserve safety checks against model collision.
- Record structured failure reasons instead of only display strings.
- Avoid repeatedly rebuilding and disposing model collision structures for every candidate.

### Parenting

- Evaluate nearby routed supports for shared trunks.
- Preserve the planned contact positions.
- Score parent attachment height, child angle, route length, and mesh clearance.
- Use deterministic spatial grouping.
- Review the Voronoi and MST modules from auto-bracing before creating new grouping primitives.
- Avoid one giant shared network.

### Bracing

- Auto bracing should run after support contacts and parenting are accepted.
- Existing manual braces must remain intact as requested by [#360](https://github.com/Open-Resin-Alliance/DragonFruit/issues/360).
- Repeated auto-brace execution must remain idempotent.

### Phase 4 acceptance criteria

- Every committed contact has a valid route.
- Shared parenting reduces material without introducing invalid angles.
- Re-running routing does not move contact tips.
- Generated support graphs export and reload correctly.
- One failed route does not abort the entire plan.

## Phase 5: Preview and user experience

Do not immediately commit generated supports.

### Proposed workflow

1. User scans islands or Auto Supports triggers the required analysis.
2. User chooses Light, Normal, or Heavy.
3. DragonFruit generates a preview plan.
4. The viewport renders proposed supports as non-editable ghost geometry.
5. The panel reports planned contacts, shared trunks, unresolved volumes, and warnings.
6. User accepts, regenerates with different settings, or cancels.
7. Accept commits the complete graph as one undoable action.

### Required controls

- Density preset.
- Minimum unsupported-region threshold.
- Contact spacing.
- Support preset for detail, structural, and interior contacts.
- Protected-face behavior when the auto-orient work is available.
- Cancel generation.
- Accept preview.

### Required report

- Logical unsupported volumes found.
- Significant volumes planned.
- Contacts proposed.
- Independent roots proposed.
- Shared trunks proposed.
- Regions ignored by threshold.
- Regions unresolved due to collision or no viable surface.
- Estimated material or geometry-volume proxy.

### Phase 5 acceptance criteria

- No support state changes before acceptance.
- Generation can be cancelled without leaving partial state.
- Accept creates one history entry.
- Undo removes the entire generated graph.
- Unresolved regions remain selectable for manual support work.

## Phase 6: Iterative verification

The planner must verify its own result.

### Verification loop

- Apply proposed contact coverage to the unsupported-volume model.
- Re-evaluate significant uncovered samples.
- Add another candidate only when it materially improves coverage.
- Stop at the preset coverage target.
- Report unresolved volumes rather than filling the model indefinitely.

The verification loop should operate on the planner's coverage model first. A full slice or voxel re-scan can be used as a final validation pass when performance permits.

### Phase 6 acceptance criteria

- Adding a support reduces the uncovered target set.
- The loop terminates deterministically.
- Maximum iteration and support-count budgets prevent runaway generation.
- Failure to reach full coverage produces a useful report rather than hundreds of emergency supports.

## What to do with the current experimental code

The current batch implementation is a prototype and must be treated accordingly.

### Keep or refactor

- Transformed raycast mesh creation.
- Downward-surface candidate resolution.
- Batch progress type and sequential cancellation-friendly execution pattern.
- Single history entry for a committed batch.
- Structured summary counts.

### Remove or replace

- Passing `orderedIslands` directly into support generation.
- One support attempt per raw island.
- Immediate support-state mutation during planning.
- The `Auto Support All (N)` count when `N` is raw scan detections.
- Treating route success as sufficient evidence that a support should exist.
- Arbitrary per-island candidate limits as the primary density control.

### Recommended immediate code action

Before beginning Phase 1, either:

- Revert the experimental UI and batch mutation code while retaining isolated candidate-resolution tests, or
- Convert the button to a disabled or clearly experimental preview entry point that does not mutate support state.

Do not commit the current one-support-per-island behavior under an Auto Supports feature name.

## Testing strategy

### Unit tests

- Volume split and merge behavior.
- Stable volume IDs.
- Candidate spacing and deduplication.
- Protected-face exclusions.
- Coverage scoring.
- Greedy selection determinism.
- Density monotonicity.
- Route failure isolation.
- Parent grouping bounds.
- Preview cancellation.
- Single-history commit and undo.

### Integration tests

- Scan to volume segmentation.
- Volume to contact plan.
- Contact plan to routed graph.
- Routed graph to export geometry.
- Save and reload generated supports.
- Re-run auto supports without duplicating existing coverage.

### Performance tests

- Scan time by triangle count.
- Segmentation time by voxel count.
- Candidate-generation time by volume count.
- Planner time by candidate count.
- Routing time by selected contact count.
- Memory use on large STL files.
- Cancellation latency.

### Manual tests

Manual rendered-output verification is mandatory.

Use at minimum:

- `~/Downloads/immortal.stl`
- A synthetic floating cube.
- Two floating volumes that later merge.
- A hollow shell with internal peaks.
- A detailed miniature with many small features.
- A model with protected cosmetic faces when that integration exists.

For each model:

- Capture the raw detection count.
- Capture logical volume count.
- Generate Light, Normal, and Heavy previews.
- Inspect contact distribution visually.
- Inspect model intersections visually.
- Accept the Normal plan.
- Verify undo and redo.
- Export and inspect sliced layers.
- Confirm the first printable layer has build-plate connectivity.
- Compare material proxy and support count across presets.

Do not report a visual or behavioral fix from code inspection alone.

## Validation commands

Start with focused tests and expand outward.

```bash
node --import tsx --test src/supports/autoSupport/__tests__/*.test.ts
npx eslint src/supports/autoSupport src/components/controls/IslandsPanel.tsx
git diff --check
npm run build
```

Run the desktop application for native minima scanning and rendered validation:

```bash
npm run tauri:dev
```

The repository-wide test suite had two pre-existing failures on July 18, 2026:

- `src/supports/__tests__/fieldDeterministicSolver.test.ts`
- `src/supports/__tests__/potentialFieldSolver.test.ts`

Both expected successful routing but received `COLLISION_WITH_MODEL`. Re-check these against latest `origin/main`; do not assume they are still pre-existing after rebasing.

Repository-wide lint also had extensive pre-existing failures. Use focused lint for touched files, but do not ignore new warnings in the changed scope.

## Metrics and success criteria

The planner needs measurable quality targets.

### Required metrics

- Raw detection count.
- Logical unsupported-volume count.
- Significant volume count after thresholds.
- Candidate count.
- Selected contact count.
- Routed support count.
- Independent root count.
- Shared trunk count.
- Unresolved volume count.
- Estimated support geometry volume.
- Estimated model contact area.
- Planning and routing duration.

### Product-level success criteria

- One click produces a reviewable support plan.
- Support count is based on coverage and density, not raw island count.
- `immortal.stl` does not receive hundreds of independent supports under the Normal preset.
- The plan contains visibly stronger support at structurally important low regions.
- Fine details receive sparse appropriate contacts.
- The user can understand what remains unresolved.
- The preview can be cancelled without mutations.
- Accepted output can be undone in one action.
- Exported geometry matches the preview.

## Open design questions

Resolve these explicitly before finalizing defaults:

- What exact geometric definition makes two scan components one logical unsupported volume?
- How should split and merge events affect support count?
- What minimum area and layer-duration thresholds should each density preset use?
- How should contact coverage propagate through a growing unsupported volume?
- How should structural load be estimated without a full physics simulation?
- When should multiple contacts share a parent trunk?
- Which contact or shaft properties may the planner override from the selected preset?
- Should interior hollow supports use a dedicated permanent-pillar preset by default?
- Should Auto Supports automatically offer Auto Orient first?
- How should protected faces be represented before [PR #224](https://github.com/Open-Resin-Alliance/DragonFruit/pull/224) lands?
- What planning-time and support-count budgets are acceptable on large models?
- Should a full slice verification run automatically before the preview is accepted?

## Exact next actions for a future agent

1. Read this document completely.
2. Run `git status --short --branch` and inspect every uncommitted change.
3. Fetch latest `origin/main` before building further.
4. Do not commit the current naive batch implementation.
5. Reproduce and verify [#342](https://github.com/Open-Resin-Alliance/DragonFruit/issues/342) against latest main.
6. Decide whether to revert the experimental UI immediately or retain it behind a non-mutating preview placeholder.
7. Read the current island-volume code under `src/volumeAnalysis/IslandVolumes` and `src/volumeAnalysis/islandVolume` before designing new segmentation types.
8. Read the existing Voronoi, MST, and grouping code under `src/supports/autoBracing` before implementing spatial grouping.
9. Add deterministic synthetic fixtures for volume split, merge, and near-touching cases.
10. Implement Phase 1 logical unsupported-volume output with tests before adding support placement.
11. Build a preview-only contact planner using weighted coverage.
12. Validate contact counts visually on `immortal.stl` before routing anything.
13. Add routing only after the contact plan is demonstrably sparse and sensible.
14. Run the full Tauri app and inspect the generated preview and accepted graph.
15. Commit, push, or create a pull request only when explicitly requested.

## Definition of done

Auto supports are complete only when:

- Logical unsupported volumes are deterministic and regression-tested.
- Density presets generate predictably different sparse plans.
- Contact selection is coverage-driven.
- Routing failures are isolated and reported.
- Parenting and bracing avoid redundant networks.
- Preview generation does not mutate support state.
- Accept and cancel work correctly.
- Undo removes the entire accepted plan.
- Exported and sliced output matches the accepted preview.
- Manual tests on representative models show reasonable support counts and no model intersections.
- `immortal.stl` produces a practical Normal plan rather than hundreds of independent supports.

## Status

This document was the authoritative implementation handoff as of July 18, 2026. The plan has since been implemented on the `feat/auto-supports` branch:

- Logical unsupported volumes come from `buildVolumeHierarchy` roots (`src/supports/autoSupport/contactPlanner.ts`), with merge/split regression tests.
- Contact selection is coverage-driven (centroid + farthest-point sampling, spacing- and area-derived counts, per-volume and global caps) with Light/Normal/Heavy presets as planner parameters.
- `src/supports/autoSupport/autoSupportRunner.ts` orchestrates plan → route → verify: unresolved volumes get one bounded second wave of candidates, excluding zones around existing tips, routed tips, and failed attempts.
- Routing returns structured failure reasons (`no_surface`, `tip_spacing`, or a `LimitationCode`), isolates failures per contact, and supports cancellation via `AbortSignal`.
- Volumes whose trunks cannot route to the plate (typically overhangs above the model body) fall back to collision-checked on-model sticks (`src/supports/autoSupport/stickFallback.ts`): a strut from the island underside to a sufficiently flat anchor surface below (vertical first, then gently tilted directions), capped at 35 mm.
- Volumes that still fail get a detail rescue: the same trunk and stick stages re-run with slim geometry (0.6 mm shaft, 0.2 mm contact tip, short cones) so tiny features in cramped spots (claw tips, spikes) can be supported.
- `buildStick` collision checks start at the disk-offset cone start and slide each cone to a clearing standoff via `calculateSafeOffset` (carried as `diskLengthOverride`) — checks rooted on the raw surface point always grazed the curved geometry they were seated on (the false-positive family of issue [#342](https://github.com/Open-Resin-Alliance/DragonFruit/issues/342)).
- Volumes whose base prints within the first layer above the build plate are plate-supported and excluded; volumes whose only routing obstacle is an existing nearby tip count as covered rather than unresolved.
- After island routing, a surface-fill pass (`src/supports/autoSupport/overhangSampler.ts`) grids all downward-facing surface beyond the preset's overhang threshold and routes best-effort supports there — islands alone under-support large connected overhangs against peel forces. Fill failures lean on neighboring supports and are not reported as unresolved.
- Existing support tips are planning exclusions, so re-running auto supports reports already-covered regions instead of duplicating them.
- Preview renders as non-editable ghost geometry; accept commits one undoable history entry; cancel leaves no state.
- Validated end-to-end on `immortal.stl`: the Normal preset produced 10 supports across 12 logical regions (the naive prototype produced ~400), a single undo/redo toggles the whole batch, and an immediate re-run reports all regions covered.

Deliberately deferred: automatic parenting/shared trunks (contact spacing already prevents adjacent redundant trunks, Auto Brace covers cross-connection, and issue [#193](https://github.com/Open-Resin-Alliance/DragonFruit/issues/193) shows attachment-quality scoring is unsolved), and protected-face inputs pending [PR #224](https://github.com/Open-Resin-Alliance/DragonFruit/pull/224).
