# Pipeline (V3.1)

## 1) Job validation

`engine::validate_job` rejects malformed requests up front:

- positive pixel dimensions
- positive, finite layer/build settings
- non-zero layer count
- triangle buffer length multiple of 9

## 2) Geometry parse

`geometry::parse_triangles` converts packed f32 data into typed triangles used downstream by index and raster stages.

## 3) Layer index build

`index::build_layer_index` maps triangles to candidate layer ranges using z-overlap, avoiding full-triangle scans per layer.

## 4) Encoder capability selection

Engine resolves `output_format` via registry and selects one of these paths:

- **preferred**: RLE stream + parallel encode (`render_layers_rle_encoded`)
- **fallback**: RLE stream + serial encode drain (`render_layers_rle`)
- **legacy**: pre-rendered PNG/raw mask materialization path

## 5) Preferred V3.1 path: `render_layers_rle_encoded`

### Worker side (Rayon)

For each layer:

1. `rasterize_layer_rle(...)`
2. encoder closure from `parallel_encode_fn(layer_index, &runs)`
3. send `(layer_index, encoded_bytes)` to bounded channel

### Drain side (serial)

As results arrive out-of-order:

- call `store_encoded_layer(layer_index, bytes)`
- report progress on arrival
- check cancellation

This preserves low memory pressure and smooth progress behavior.

## 6) Fallback RLE path: `render_layers_rle`

Workers emit `(layer_index, runs)`, and serial drain calls `consume_rle_layer`.

This path is still bounded/cancelable and useful for encoders not exposing parallel encode closures.

## 7) Rasterization details

`raster::rasterize_layer_rle` uses scanline winding unions:

- handles overlapping/intersecting solids robustly
- AA off => strict binary 0/255 writes
- AA on => subscanline coverage accumulation to grayscale
- output is row-major `Vec<RleRun>`

## 8) O(num_runs) PNG encode details

Encode functions in `encode.rs` operate from runs directly:

- `encode_grayscale_png_from_rle`
- `encode_truecolor_packed_png_from_rle` (`rgb8_div3`)
- `encode_grayscale_averaged_png_from_rle` (`gray3_div2`)

Shared implementation ideas:

- row filter bytes interspersed into run stream
- fixed-Huffman single-block deflate
- Adler-32 appended to zlib stream
- PNG chunk assembly (IHDR/IDAT/IEND, plus pHYs for packed modes)

## 9) Finalization

Encoder finalization (`finalize_to_bytes` / `finalize_to_path`) assembles format-specific archives.

## 10) Progress + cancellation semantics

- progress reported per layer completion arrival
- first/final/phase updates emitted immediately by integration throttler
- cancellation is cooperative and checked in both worker and drain loops

## 11) Perf counters

`SlicingPerfV3` provides stage-oriented timings for diagnostics and tuning:

- `index_build_ns`
- `render_wall_ns`
- `render_ns`
- `png_encode_ns`
- `archive_encode_ns`
- `total_ns`
