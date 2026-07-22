# Slicing benchmark suite

Drives the DragonFruit CLI to slice `.voxl` scenes across a matrix of
**printer × layer-height × AA preset**, exactly the way the desktop app would
for each printer, and records timing + resource stats to a JSONL file — one row
per case.

## What it measures per run

- **Full `SliceStatsV3`** — all 16 engine perf fields (render wall/CPU, PNG
  encode, archive encode, z-blend, cross-blend, post-blur, support-merge, …).
- **CPU + RAM** — total CPU seconds, CPU%, peak RSS (kernel high-water mark),
  end RSS, and a **periodic RSS/CPU time series** (`resources.samples`, default
  every 250 ms) so a run can be diagnosed over its lifetime, not just at peak.
- **Correctness gate** — `numeric_layer_count` from the archive must equal the
  reported layer count (`ok: true/false`).

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

Options: `--fixtures`, `--printers`, `--mesh-dir`, `--layer-heights` (CSV),
`--aa-presets` (CSV), `--repeats` (averaged, with min/max spread kept),
`--out`, `--no-build`. Requires `jq`.

Repeats are **averaged** (every scalar + every perf field); `total_s_min`/
`total_s_max` capture the spread, and the time series is kept from the repeat
closest to the mean. Failed repeats are logged with their error and, if all
repeats of a case fail, an `{"error": ...}` row is written.

## Analyzing results

```bash
# throughput + peak memory per case
jq -r '[.printer,.aa_preset,.layer_height,.layers_per_second,.peak_rss_mb,.ok]|@tsv' bench-results.jsonl

# RSS-over-time for one case (feed to a plot). Each sample carries `run`, and
# `samples_from_run` on the row names which repeat the series came from.
jq -r 'select(.aa_preset=="smooth").samples[]|[.run,.t_ms,.rss_mb,.cpu_percent]|@csv' bench-results.jsonl
```
