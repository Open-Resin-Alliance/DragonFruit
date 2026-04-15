# Benchmarking V3.1

## What benchmark covers

`src/benchmark.rs` runs synthetic slicing workloads through core pipeline stages:

- geometry generation
- indexing
- rasterization
- PNG encode
- container finalization

## Output metrics

`BenchmarkResultV3` includes:

- `artifact_bytes`
- `total_s`
- `layers_per_second`
- `render_s`
- `png_s`
- `archive_s`

## CLI usage

Benchmark binary: `src/bin/benchmark.rs`

Key flags:

- `--layers`
- `--srcw`
- `--srch`
- `--outw`
- `--outh`
- `--cubes`

Typical 16K-style run:

`cargo run --bin benchmark --release -- --layers 400 --srcw 15360 --srch 8640 --outw 7680 --outh 8640 --cubes 8`

## Reading results in V3.1 context

- `layers_per_second` is the top-level throughput signal.
- `render_s` + `png_s` should benefit from parallel overlap in main path.
- unexpectedly high `png_s` often means fallback path or non-optimal build profile.
- `artifact_bytes` helps validate packing/compression behavior.

## Benchmark hygiene

- compare branches under similar machine load
- pin `DF_V3_MAX_CONCURRENT` when making apples-to-apples comparisons
- run multiple times and inspect spread/outliers
- validate output correctness alongside speed

## Concurrency control

`DF_V3_MAX_CONCURRENT=<N>` caps in-flight parallel work and is useful for scaling studies and memory/throughput balancing.
