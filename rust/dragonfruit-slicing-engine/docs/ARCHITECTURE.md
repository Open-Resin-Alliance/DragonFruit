# Architecture (V3.1)

## Intent

`dragonfruit-slicing-engine` is designed as a deterministic, high-throughput native slicer with strict module boundaries and plugin-owned output containers.

## Core goals

- deterministic output for equivalent input
- predictable memory behavior under heavy concurrency
- fast cancellation/progress responsiveness
- format extensibility without engine branching

## System flow

```text
SliceJobV3
  -> validate_job (engine)
  -> parse_triangles (geometry)
  -> build_layer_index (index)
  -> render pipeline (raster + encode)
  -> encoder finalize (encoders)
  -> SliceArtifactV3 / output path
```

## Module boundaries

### `types`

Shared job/result/progress contracts and render payload structs.

### `engine`

Orchestrator and error boundary:

- validates jobs
- selects encoder from registry
- chooses rendering path based on encoder capabilities
- aggregates `SlicingPerfV3`

### `geometry`

Packed float triangle buffer parsing into typed geometry.

### `index`

Per-layer triangle candidate index for efficient layer traversal.

### `raster`

Scanline-based rasterization to RLE runs:

- robust winding union behavior
- binary output when AA is off
- grayscale accumulation path when AA is on

### `rle`

Hot-path run-length accumulation and row/zero-row emit helpers.

### `pipeline`

Bounded parallel execution with cancellation and progress:

- `render_layers_rle_encoded` (preferred V3.1 path)
- `render_layers_rle` (fallback RLE path)
- legacy layer materialization path (for older capability contracts)

### `encode`

RLE-first PNG encoders and packing transforms:

- grayscale fixed-Huffman encode
- truecolor packed encode (`rgb8_div3`)
- grayscale averaged packed encode (`gray3_div2`)

### `encoders`

Runtime format abstraction:

- `FormatEncoder`
- `RleStreamEncoder`
- generated plugin registry

### `benchmark`

Synthetic benchmark scaffolding and CLI.

## V3.1 architecture highlights

1. **Parallel encode contract**: encoders can expose `parallel_encode_fn` and `store_encoded_layer`.
2. **O(num_runs) encoding**: no full-size pixel buffer on primary paths.
3. **Encode-time packing**: sub-pixel physical data preserved until encode phase.
4. **Progress-on-arrival**: worker completion drives smoother progress reporting.

## Error semantics

`SlicerV3Error` is the unified boundary error type. External/library errors are translated into typed variants before leaving engine orchestration.

## Extensibility rule

New output formats must be implemented as encoders and registered through generated plugin registry artifacts; avoid hardcoded format dispatch in engine code.

## Acknowledgment

Many thanks to **mslicer** for inspirational algorithmic patterns and practical methods that informed DragonFruit V3.1 architecture decisions.
