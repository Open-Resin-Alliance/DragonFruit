# Auto-Support Metrics

`npm run bench:auto-supports` runs the auto-support placement pipeline over a
corpus and prints one table: support counts, member volume, coverage, orphan
culls, refusal tallies, router probes and phase timings, per model and totalled.
`--check` compares that table with a committed baseline and fails when a metric
moved.

It exists because auto-support is judged by screenshots otherwise. Every item on
`docs/internal/auto-support-roadmap.md` is arguable once a change can be shown to
move coverage, volume or refusals on the same seven models, and a metric that
moves in the wrong direction is visible before anything is printed.

## Where it lives

| File | Holds |
| --- | --- |
| `scripts/bench-auto-supports.ts` | The harness: arguments, the per-model run, metric collection, the table, the baseline diff |
| `scripts/bench-auto-support-corpus.ts` | The synthetic corpus: each entry's mesh and the islands it presents |
| `scripts/bench-island-scan.ts` | The app's voxel island detector, run in this process (Worker stand-in) |
| `scripts/bench/auto-support-baseline.json` | The committed metric snapshot `--check` compares against (grid off) |
| `scripts/bench/auto-support-baseline-grid.json` | The same for `--grid`, which measures a different run and has its own snapshot |

```bash
npm run bench:auto-supports                     # the table, synthetic corpus
npm run bench:auto-supports -- --json           # the same numbers, machine-readable
npm run bench:auto-supports -- --check          # fail when a metric moved
npm run bench:auto-supports -- --update-baseline
npm run bench:auto-supports -- --corpus ~/models  # your own STLs, islands detected
```

## What it measures, and what it does not

The harness drives the placement half of the pipeline through the same entry
point the worker uses: `runAutoPlaceRequest` (`autoSupport/autoPlace.worker.shared.ts`),
which seeds the thread's settings, snapshot and model mesh and then calls
`computeAutoSupportPlan`. So a run here behaves as the app's run does, minus the
detectors.

Corpus entries author their own footprint voxels, and the grid path samples the ring and
lattice from them, so a corpus run's contact count reflects the fixture's sampling rather
than a real scan. Read density questions off a `detected` run, where the app's own detector
produced the islands; the authored mode is for holding the input fixed across a change.

**Islands come from one of two places**, and the run says which it used:

| Source | When |
| --- | --- |
| `authored` | The synthetic corpus writes them beside the mesh, so CI measures placement alone and stays fast |
| `detected` | The app's own voxel detector, run in-process for `--corpus` models, or when `--detect` forces it |

Two consequences worth keeping in mind. First, a `detected` run measures
detection *and* placement, which is the honest end-to-end number, while an
`authored` run holds the input fixed and so isolates a placement change; the
baseline exists in the authored mode for that reason, and `--check` refuses to
compare across modes. Second, detection here is the **voxel family only**:
`scan_overhangs` and `scan_mesh_minima` are Tauri commands over the Rust
scanners, so a Node host cannot run them, and an island set that in the app
would have been intersected with those arrives as voxel islands instead.

A third, and the one to watch before trusting a green `--check`: **the corpus
models are small enough that every model-scale factor is ×1**. `modelSizingFactors`
returns ×1 at or below `SIZE_REFERENCE_MM` (60 mm) and `SHARE_REFERENCE_G` (0.6 g),
and the fixtures are 30–48 mm with no load share, so a rule keyed on the model
scale — the member host-relative floor of `memberHostShaftRatio`, say — is a
**provable no-op** here and moves no baseline. Reproduce it by setting the
`autoSupport.sizeScale` master multiplier instead: it rides the same trunk-only
sizing path. Note that `--settings '{"sizeScale":…}'` does **not** do it — the
per-candidate sizing reads the live `getSettings()`, not the run's normalized
override, so a harness has to seed `appSettings.autoSupport.sizeScale` — or
measure on a real part. Do not read "identical" as "the new rule never fires".

Detection runs at the app's island-panel resolution (`pxMm` 0.1, the print's own
layer height) and costs seconds per model; `--px-mm` and `--layer-height` trade
accuracy for speed on a large part. It works in this process through a `Worker`
stand-in that evaluates `scanlineScan.worker.ts` in-thread and routes messages to
it, with the same ordering the browser gives (the worker script runs before any
message arrives), which is why `scripts/bench-island-scan.ts` awaits the worker
module before a scan starts.

## The metrics

| Column | Meaning | Where it comes from |
| --- | --- | --- |
| `islands` | Islands handed to the run | the corpus entry, its island file, or the detector |
| `cand` | Contact candidates after generation and dedup | `ForestReport.diagnostics.candidatesBySource` |
| `entities` | Members in the committed forest | registry walk, see below |
| `contacts` | Contact cones in the committed forest | the same walk |
| `vol mm3`, `len mm` | Member volume and shaft length the forest would print | the same walk, per primitive |
| `cover %` | Footprint fraction covered at the tip radius | `AutoPlaceAnalytics.areaCoverage` |
| `orphans` | Members culled after the forest resize, by reason | `ForestReport.orphans` |
| `above` | Contacts whose own cone rises over the tip it touches | see below |
| `fallbk` | Candidates the grid refused and the fallback then placed without it | `PlacementDiagnostics.gridFallbacks` |
| `budget` | What a load budget would add (`+`) and call redundant (`-`), in supports. Report only, and deliberately outside `--check`: it measures the run, it does not gate it | `ForestReport.loadBudget` |
| `probes` | Distance-field probes the router spent | `getRouterStats().jointProbes` |
| `ms` | Wall clock for the model | the harness |

The registry walk is what keeps this honest as types change: the harness asks
`SUPPORT_STATE_TYPES` for each type's declared collection, and asks each type's
**proxy geometry recipe** for the primitives it contributes. A new support type
joins the counts, the volume and the contact check by being registered, with no
edit in the harness.

Two metrics are worth reading carefully:

- **Volume** counts every primitive at its nominal size and does not subtract the
  overlaps at a junction, and a curved segment counts as its chord. It is
  therefore a regression signal, not a resin estimate: the same forest always
  produces the same number, which is what a baseline needs.
- **`above`** is the contact-point rule from the pathfinder, measured on the
  committed forest rather than trusted: for each type's declared `upper` contact,
  the cone's own socket end must not rise over the tip it touches. Members grafted
  onto a host sit below a host that may be higher than their own contact, and a
  bridge's lower cone reaches up to its partner by design, which is why only the
  upper contact is checked. Anything above `0.01mm` is counted and the worst case
  is reported; a non-zero value is a bug, not a tolerance.

## The baseline and `--check`

`--update-baseline` writes the current run to `scripts/bench/auto-support-baseline.json`
(or to `--baseline <file>`, which is how the grid snapshot is recorded). Each mode
keeps its own file: `--check` refuses a baseline recorded with different flags,
because grid mode's node-snapped placement and its fallback for tips the lattice
refuses are a different measurement from the gridless run.
Read the diff before committing it: the baseline is the claim "this is the forest
we intend", and re-recording it to make a run pass is how the gate stops meaning
anything.

`--check` first refuses a baseline recorded with different flags (corpus,
detection, resolution, settings): that is a different measurement, not a
regression. Then it fails (exit 1) when:

- a run under `--repeat` differs from itself (it reports `deterministic: false`);
- a **hard** metric differs from the baseline at all: `islands`, `candidates`,
  `entities`, `contacts`, `roots`, `joints`, `curvedSegments`, `aboveContact`,
  covered/uncovered islands, `orphans`, `routerProbes`, and the per-type,
  per-refusal and per-orphan breakdowns;
- a **soft** metric leaves its tolerance: member volume and length within 0.5%,
  coverage allowed to rise but not to fall.

Timings never gate: they are wall-clock on whatever machine ran the harness, so
they are printed, diffed to nothing, and left to `[AutoSupport] Timing` for
profiling.

`--repeat N` re-runs each model and compares the forest with itself, reporting
`deterministic: false` when a run is not reproducible. It costs one extra run per
model, so it is off by default; turn it on when a change touches ordering, id
allocation or any map iteration.

## The corpus

Seven synthetic entries, each built to exercise one branch of placement:

| Entry | Exercises |
| --- | --- |
| `overhang-slab` | A large flat underside with a pedestal in the middle: boundary ring, lattice infill, drops routed around the pedestal, consolidation, a dense brace pass |
| `narrow-rib` | A 1.4 mm sliver: the ring resamples the perimeter and the lattice is skipped |
| `staggered-twins` | Two contacts 3 mm apart in plan and 3 mm apart in height: the fan and merge gates refuse the link, so both stand as plate contacts, which pins the refusal path |
| `sloped-cantilever` | A 25° underside: cells sample the real face normal, so the cone-axis policy and the contact gates run on sloped geometry |
| `steep-flat-wedge` | A 60° steep flat: sparse toppling contact instead of formation density, plus stabilization anchors |
| `cavity-ceiling` | An enclosed ceiling: no plate route, so the cavity fallback bridges model to model with ray-cast collision |
| `flat-base` | Nothing to support: the run must be a no-op rather than a crash or a stray support |

Real models go in a directory, one model per file:

```bash
npm run bench:auto-supports -- --corpus ~/models
```

A model is one `<name>.stl`, and its islands are detected. The synthetic corpus
is where islands are pinned instead: an entry there authors its `DetectedIsland`
values beside the mesh (including the `contactVoxels` footprint that drives the
ring and lattice paths), which is what keeps a CI run comparable across a change
to placement rather than to detection. An island file on disk would have to carry
that footprint as packed numbers; no producer writes one yet, so the harness does
not read one.

## Arguments

| Argument | Effect |
| --- | --- |
| `--only a,b` | Run named entries only |
| `--corpus <dir>` | Measure real models instead of the synthetic corpus (islands detected from each `<name>.stl`) |
| `--settings <json>` | Override auto-support settings for the run, e.g. `{"areaPerSupportMm2":20}` |
| `--grid` | Turn horizontal grid mode on (off by default, matching `createDefaultSettings`) |
| `--detect` | Detect islands from the mesh even where a set exists, to compare the two on one model |
| `--px-mm`, `--layer-height` | Detection resolution (defaults 0.1 and 0.05, the panel's own) |
| `--repeat N` | Re-run each model and check the forest is reproducible |
| `--baseline <file>` | Compare against another baseline |
| `--check` | Fail on a hard diff or a soft metric outside its tolerance |
| `--update-baseline` | Write the current metrics as the baseline |
| `--json` | Print metrics and diffs as JSON |
| `--verbose` | Keep the pipeline's own logging (silenced by default, so the table is the output) |
| `--help` | Print the harness's own header |

## Related pages

- [Auto-Supports](auto-supports.md) — the pipeline this measures, phase by phase
- [Auto-Support Worker](auto-support-worker.md) — the run entry point the harness calls
- [Support Pathfinding V3](support-pathfinding-v3.md) — the router whose probes and cone rule show up in these numbers
- [Performance Debugging](performance-debugging.md) — where the timing lines come from
