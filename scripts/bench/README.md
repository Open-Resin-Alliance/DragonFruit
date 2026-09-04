# Slicing benchmark suite

Drives the DragonFruit CLI to slice `.voxl` scenes across a matrix of
**printer × layer-height × AA preset**, exactly the way the desktop app would
for each printer, and records timing + resource stats to a JSONL file — one row
per case. It can optionally run that whole matrix across **several git
versions/branches/PRs** of the software, and **validate** each produced slice
against a known-good reference.

## What it measures per run

- **Full `SliceStatsV3`** — all 16 engine perf fields (render wall/CPU, PNG
  encode, archive encode, z-blend, cross-blend, post-blur, support-merge, …).
- **CPU + RAM** — total CPU seconds, CPU%, peak RSS (kernel high-water mark),
  end RSS, and a **periodic RSS/CPU time series** (`resources.samples`, default
  every 250 ms) so a run can be diagnosed over its lifetime, not just at peak.
  Each repeat's full resource record is kept separately under `runs[]` (see below).
- **Hardware config** — when `--hw-configs` is used, every row carries `hw`,
  `hw_cpus`, `hw_mem` naming the simulated machine (core count + RAM ceiling) the
  case ran under, so results are directly comparable across hardware.
- **Correctness gate** — `ok: true/false`. For zip formats (`.nanodlp`) the
  `numeric_layer_count` read back from the archive must equal the reported layer
  count (`gate: "numeric-layer-count"`). Binary formats (`.ctb`/`.goo`/`.aff`/
  `.azf`) can't be decoded back to rasters, so the gate degrades to a
  non-empty-file check (`gate: "file-nonempty"`) — use `--validate` for real
  content verification of those.
- **git ref** — every row carries `ref` and `git_sha` so results stay comparable
  across versions.

## Output format per printer

Each case is written in the format the printer profile asks for
(`display.outputFormat`): `nanodlp`, `ctb`, `goo`, `aff`, `azf`, …. `nanodlp` is
a zip of layer PNGs and is fully introspectable; the others are proprietary
binary containers. The output extension is derived exactly like the app/TS CLI
(`outputFormatToExt`), and each row records the resolved `format`.

## Fidelity to the UI

`scene slice --printer <profile>` derives slice parameters the same way the app
does when you pick that printer:

| From the printer profile | Drives |
|---|---|
| `display.resolutionX/Y` | source raster resolution |
| `bitDepth.bits` | X packing (`gray3_div2` for 3-bit, `rgb8_div3` for 8-bit) **and** dithering (a low-bit-depth panel forces dither on with the panel bit depth) |
| `pixelSize.{x,y}` (µm) | physical XY pixel pitch — honors **non-square pixels** |
| `buildVolumeMm.{width,depth}` | build plate dims |
| `display.mirrorX/Y`, `display.outputFormat`/`formatVersion` | mirroring, archive format |

The named AA presets (`sharp`/`balanced`/`smooth`) are resolved through the
app's own `computePhysicalAaConfig` (imported directly from
`src/features/slicing/autoAaPhysics.ts`), producing byte-identical AA steps,
backend mode, blur radius, z-blur, and 3DAA look-back. `raw` disables AA. Each
result row records the **preset name** (`aa_preset`, and `anti_aliasing.preset`)
so cases are identified by the preset a user would pick, not the resolved
engine mode.

> Note: the printer-packing and dither-policy mappings are currently **ported**
> into `scripts/dragonfruit-ts-cli.ts` rather than imported, because the app
> originals aren't exported and their modules pull in the Tauri/THREE dependency
> chain. Consolidating into a shared pure module is a deferred design decision.

## Layout

```
scripts/bench/
  run-slicing-bench.sh      the driver
  printers/*.json           printer profiles (example provided)
  fixtures/*.voxl           your scenes (+ referenced STLs, via --mesh-dir)
```

Fixtures are yours to provide: each `.voxl` references its meshes by filename,
which must be resolvable under `--mesh-dir` (defaults to the fixtures dir).

## Usage

```bash
scripts/bench/run-slicing-bench.sh \
  --fixtures scripts/bench/fixtures \
  --printers scripts/bench/printers \
  --layer-heights 0.05,0.03 \
  --aa-presets sharp,balanced,smooth \
  --repeats 3 \
  --out bench-results.jsonl
```

Core options: `--fixtures`, `--printers`, `--mesh-dir`, `--layer-heights` (CSV),
`--aa-presets` (CSV, default `sharp,balanced,smooth,raw`), `--repeats`
(averaged, with min/max spread kept), `--codegen` (CSV, see below), `--out`,
`--no-build`. Requires `jq` (and `sha256sum` + `unzip` when validating).

Repeats are **averaged** (every scalar + every perf field) into the row's
top-level summary, with `total_s_min`/`total_s_max` for the spread — but every
repeat is **also kept un-averaged** under `runs[]` (its own timing, CPU, peak
RSS, full perf block, and RSS/CPU sample series), so nothing is lost to the
average. Failed repeats are logged with their error and, if all repeats of a
case fail, an `{"error": ...}` row is written.

### Sweeping codegen variants

The driver can also re-run the whole matrix against the **same source built with different
`RUSTFLAGS`**, which is how you find out what an x86_64 baseline actually costs rather than
arguing about it:

```bash
scripts/bench/run-slicing-bench.sh --codegen shipped,v2,v3 --layer-heights 0.05 --out codegen.jsonl
```

Every row carries `codegen`, so a variant is directly comparable against the others across every
printer, layer height and AA preset in the matrix.

| Preset | RUSTFLAGS |
|---|---|
| `v1` | `-C target-cpu=x86-64` (baseline; runs on every x86-64 CPU) |
| `v2` | `-C target-cpu=x86-64-v2` (SSE4.2; Nehalem 2008 / Bulldozer 2011 and up) |
| `v3` | `-C target-cpu=x86-64-v3` (AVX2 + FMA + BMI; Haswell 2013 / Zen 2017 and up) |
| `shipped` | `-C target-feature=+avx2,+fma` (what `.cargo/config.toml` ships today) |
| `v2avx2` | `-C target-cpu=x86-64-v2 -C target-feature=+avx2,+fma` |
| `native` | `-C target-cpu=native` — reference ceiling only, **never shippable** |

Anything starting with `-C` is passed through verbatim, so you are not limited to the presets.

`target-cpu` and `target-feature` are **not** the same knob, which is why both `v3` and
`v2avx2` are in that list. `target-feature=+avx2` tells LLVM the instructions are *available*;
the cost model and instruction scheduling still come from `target-cpu`, which stays at generic
`x86-64` unless you set it. The two combinations generate visibly different amounts of vector
code from identical source.

Each variant builds into its own `target-codegen-<name>` directory, so variants never reuse each
other's artifacts. `RUSTFLAGS` fully overrides the `rustflags` in `.cargo/config.toml` — cargo
treats the two as mutually exclusive — so no variant silently inherits the shipped flags. A
variant the host CPU cannot execute is skipped with a message rather than crashed into.

Results are **per microarchitecture**: an Intel and an AMD part can disagree, and on Zen 1/2 the
BMI2 `PDEP`/`PEXT` instructions `v3` permits are microcoded and very slow, so treat `v3` on
those parts with extra suspicion. Running this on more than one machine is the point.

Note that a slice total is dominated by PNG encoding, which codegen flags barely touch — read
the per-stage perf fields (`render_wall`, and the rest of `SliceStatsV3`) rather than `total_s`
alone, and use `--repeats` with the recorded `total_s_min`/`total_s_max` spread to check that a
difference is bigger than the run-to-run noise before calling it a result.

### Sweeping hardware configurations

The driver re-runs the **whole matrix** under several simulated machines, so you
can compare "how does this slice run on a Pi vs a workstation" in one pass. **By
default it sweeps `@common`** — a spread of common PC and Raspberry Pi machines —
so you get the cross-hardware picture without passing any flag:

```bash
scripts/bench/run-slicing-bench.sh --layer-heights 0.05 --out hw-sweep.jsonl
```

Built-in preset groups (reference with `@name`; approximate real machines):

| Preset | Machines (`name` cpus×mem) |
|---|---|
| `@pis` | `rpi-zero2` 4×512M · `rpi3b` 4×1G · `rpi4` 4×4G · `rpi5` 4×8G |
| `@pcs` | `pc-lowend` 2×4G · `pc-budget` 4×8G · `pc-mainstream` 8×16G · `pc-workstation` 16×32G |
| `@common` | `@pis` + `@pcs` (the default) |

Override with your own list, mix presets and explicit configs, or opt out of the
sweep entirely:

```bash
# just a couple of machines
--hw-configs "rpi4:cpus=4,mem=4G; nuc:cpus=8,mem=8G"
# a preset plus a custom monster box
--hw-configs "@pis; threadripper:cpus=16,mem=64G"
# a single unconstrained run on the real host (no taskset/systemd needed)
--hw-configs host
```

Each config is `name:cpus=N,mem=SIZE` (both keys optional), separated by `;`:

| Key | Effect |
|---|---|
| `cpus=N` | **True core emulation** — the slice (and its Rust child) get an N-core CPU affinity mask via `taskset`. The engine sizes its rayon pools from `available_parallelism()` (= the affinity mask), so it genuinely runs as if on an N-core box, not via an env-var hint. |
| `mem=SIZE` | A hard RAM ceiling (`512M`, `2G`, …) imposed by a transient `systemd-run --user --scope` (`MemoryMax` + no swap). Exceeding it **OOM-kills the slice**, recorded as a failure for that machine (logged with `exit 137` / "likely OOM"). |

A config with neither key (e.g. `host`) is the unconstrained host. Every row is
tagged `hw`, `hw_cpus`, `hw_mem`. `cpus=N` needs `taskset` (util-linux); `mem=SIZE`
needs a systemd user manager with the memory cgroup controller delegated. For an
**explicit** list the driver verifies this up front and fails loudly if a cap
can't be enforced (rather than silently ignoring it); for the **default**
`@common` sweep it instead degrades to a single unconstrained `host` run with a
warning, so the tool still works on hosts that can't impose caps. The sweep nests
**inside** each git target: a ref is built once, then run under every machine.

> Note: the default sweep is thorough — the full matrix runs once per machine (8
> by default), and the low-core Pi/low-end configs are the slowest. Narrow it with
> `--hw-configs`, or trim the matrix (`--layer-heights`, `--aa-presets`, fixtures)
> when you just want a quick check.

### Benchmarking several versions (git)

Run the same matrix against multiple refs/branches/PRs. Only the
software-under-test (Rust CLI + TS CLI + `src/`) varies per ref — the harness
(this script, fixtures, printers, goldens) always runs from your current
checkout. Each ref is checked out into its own `git worktree`, built, and torn
down afterward.

```bash
scripts/bench/run-slicing-bench.sh \
  --refs main,dev --prs 418,424 \
  --layer-heights 0.05 --out cross-version.jsonl
```

| Flag | Effect |
|---|---|
| `--refs CSV` | git refs to benchmark: branches/tags/commits (e.g. `main,dev,v1.2.0`) |
| `--prs CSV` | GitHub PR numbers (fetched via `pull/N/head`) |
| `--worktree-base DIR` | where to create per-ref worktrees (default: a temp dir, removed on exit) |
| `--keep-worktrees` | don't delete the worktrees on exit (for inspection) |
| `--install-deps` | run `npm ci` in each worktree instead of symlinking your `node_modules` |
| `--overlay-uncommitted` | apply your working-tree diff (`git diff HEAD`) onto each worktree before building — use this to benchmark refs that predate the bench harness |

With no `--refs`/`--prs`, the current working tree is the single target (`ref:
"working-tree"`, original behavior). Filter results per version with
`jq 'select(.ref=="main")'`.

### Validating against known-good slices

`--validate <dir>` compares each produced slice to a golden reference and records
a `validation:{status,method,…}` block on the row. Goldens are matched by name:

```
<voxl>__<printer>__lh<lh>__<preset>.<ext>
# e.g.  bust__elegoo-saturn__lh0.05__sharp.ctb
```

Comparison is format-aware:

- **zip (`.nanodlp`)** — `method: "layer-hash"`: the numeric layer PNGs are
  content-hashed and compared by name. Container metadata, timestamps, and the
  `3d.png` thumbnail are ignored, so only the actual per-layer pixels matter.
  Reports `mismatched_layers`, `only_in_golden`, `only_in_produced`.
- **binary (`.ctb`/`.goo`/`.aff`/`.azf`)** — `method: "file-sha256"`: the whole
  file is SHA-256 compared (these can't be decoded back to rasters). Requires the
  encoder to be byte-deterministic across the versions you compare.

`status` is one of `match` / `mismatch` / `missing` / `error`. A `mismatch` or
`error` forces `ok=false`; a `missing` golden is ignored unless you pass
`--require-golden` (then it also fails the case). Validation runs once per case
(slicing is deterministic). `unzip` is required for meaningful `.nanodlp`
validation — without it those goldens degrade to timestamp-sensitive whole-file
SHA-256 and the driver warns.

## Visualizing results

`visualize-stats.mjs` turns a results JSONL into a single self-contained HTML
dashboard — styled like the app's in-UI **Slice Performance Metrics (V3)** modal,
but surfacing *everything the benchmark records*, not just the SliceStatsV3 perf
fields: the imposed hardware envelope (cpus/mem), CPU + RAM, the **RSS/CPU
time-series** drawn as a chart (with the `mem=` cap marked when set), every
un-averaged repeat under `runs[]`, the correctness gate + validation, and output
size.

```bash
node scripts/bench/visualize-stats.mjs bench-results.jsonl --out report.html --open
# multiple files are merged (e.g. compare a cross-version run beside a hw sweep):
node scripts/bench/visualize-stats.mjs hw-sweep.jsonl cross-version.jsonl --out report.html
```

The page has a **sortable overview table** (click a header to sort by throughput,
peak RSS, CPU, …; click a case to jump to it) over a **per-case detail card** each
carrying the V3-style metric cards, a pipeline-timing pie, the resource-over-time
chart, a per-repeat `runs[]` table, and the correctness/output panel. Options:
`--out <file.html>`, `--title <text>`, `--open`. Node built-ins only — no deps.

## Analyzing results

```bash
# throughput + peak memory per case (with hw config, ref + output format)
jq -r '[.hw,.ref,.printer,.format,.aa_preset,.layer_height,.layers_per_second,.peak_rss_mb,.ok]|@tsv' bench-results.jsonl

# compare one case across hardware configs ("how does it run under each machine")
jq -r 'select(.printer=="elegoo-saturn" and .aa_preset=="sharp")|[.hw,.hw_cpus,.hw_mem,.total_s,.layers_per_second,.peak_rss_mb,.ok]|@tsv' hw-sweep.jsonl

# compare one case across versions
jq -r 'select(.printer=="elegoo-saturn" and .aa_preset=="sharp")|[.ref,.git_sha,.total_s,.layers_per_second]|@tsv' cross-version.jsonl

# validation failures only
jq -c 'select(.validation.status | IN("mismatch","error"))|{ref,printer,aa_preset,validation}' bench-results.jsonl

# per-repeat spread for a case (each run kept separate under runs[], not just averaged)
jq -r 'select(.aa_preset=="smooth")|.runs[]|[.run,.total_s,.peak_rss_mb,.peak_sample_cpu_percent]|@csv' bench-results.jsonl

# RSS-over-time for one case (feed to a plot). Series live per-repeat under
# runs[].samples[]; each sample also carries its own `run`.
jq -r 'select(.aa_preset=="smooth").runs[].samples[]|[.run,.t_ms,.rss_mb,.cpu_percent]|@csv' bench-results.jsonl
```
