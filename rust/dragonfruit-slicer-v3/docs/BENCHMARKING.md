# Benchmarking

## Benchmark module

`src/benchmark.rs` provides a synthetic benchmark runner that:

- generates procedural box geometry
- executes full V3 slicing path
- reports coarse stage timing and throughput

Returned metrics (`BenchmarkResultV3`):

- `artifact_bytes`
- `total_s`
- `layers_per_second`
- `render_s`
- `png_s`
- `archive_s`

## CLI benchmark binary

`src/bin/benchmark.rs` exposes quick local runs.

Example arguments:

- `--layers`
- `--srcw`, `--srch`
- `--outw`, `--outh`
- `--cubes`

## Interpreting results

- `render_s` isolates raster stage cost.
- `png_s` highlights compression overhead.
- `archive_s` highlights container write/zip overhead.
- `layers_per_second` is useful for high-level trend tracking.

## Practical benchmark hygiene

- Keep machine load low during comparison runs.
- Use same concurrency settings (`DF_V3_MAX_CONCURRENT`) when comparing branches.
- Compare multiple runs and look at trend, not single outlier.
- Validate outputs still pass correctness expectations when tuning for speed.

## Environment controls

- `DF_V3_MAX_CONCURRENT=<N>` caps pipeline worker concurrency.

This can help evaluate memory-vs-throughput tradeoffs and avoid over-parallelization on constrained systems.
