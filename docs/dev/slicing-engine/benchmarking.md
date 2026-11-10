# Benchmarking

## What benchmark covers

`rust/dragonfruit-slicing-engine/src/benchmark.rs` runs synthetic slicing workloads through core pipeline stages:

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

### RAW binary-core phase counters

Native perf and CLI JSON expose `raw_geometry_ns` and `raw_scanline_ns`.
The app's copied metrics expose the corresponding `rawGeometryNs` and
`rawScanlineNs`, plus `rawGeometryWorkerMs` and `rawScanlineWorkerMs`.

Compare geometry preparation/intersections against scanline/span/RLE work to
locate the native bottleneck before changing the kernel. These are elapsed
times summed across workers: do not add them to `render_wall_ns` or interpret
them as sequential portions of the job's wall time. They are subsets of the
existing render accounting, not additional work. Block rendering excludes
postprocessing and format encoding from the scanline counter even where the
older aggregate render counter includes the whole block producer.

Zero on an ineligible AA path means the RAW split was not measured, not that
rasterization was free. Shared parse/projection, index construction, encoding,
container output and app transport remain separate. See [API Reference](api.md)
for exact boundaries. Capturing these counters does not require a separate
benchmark or a per-triangle profiler.

## CLI usage

Benchmark binary: `rust/dragonfruit-slicing-engine/src/bin/benchmark.rs`

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
