# V3.2 Roadmap — 3D Anti-Aliasing & Advanced Grayscale

## Status

- **Target:** V3.2 milestone (post-V3.1 stabilization)
- **Scope:** Z-axis supersampling (3D AA), adaptive AA, advanced grayscale controls
- **Prerequisites:** V3.1 pipeline proven stable; RLE + parallel encode path operational
- **Branch:** will fork from `paul/slicing-engine-v3_1` once V3.1 merges

---

## Background

V3.1 ships with robust 2D anti-aliasing: N-stepped Y sub-scanlines with analytic X span coverage, accumulated into `row_accum: Vec<u32>`, resolved to 8-bit grayscale per physical row. This produces excellent XY edge quality but has no awareness of Z-axis geometry transitions within a single layer.

**The problem:** layer boundaries on sloped/curved surfaces exhibit stairstepping artifacts. A feature that enters or exits the layer thickness at an angle gets snapped to a binary in/out decision at the layer's center Z plane. This is especially visible on shallow-angle surfaces and small features near the resolution limit.

**The solution:** sample the Z axis at multiple sub-offsets per layer and average coverage, producing true volumetric AA without changing the fundamental rasterization pipeline.

---

## Architecture Assessment

### Current V3.1 pipeline (per-layer)

```
candidates_for_layer(layer)
  → build_segments_for_layer(triangles, candidates, layer, layer_height_mm)
    → build_scanline_segment_index(segments, height, aa_steps)
      → scanline fill (winding + coverage → row_accum)
        → resolve row_accum / aa_steps → 8-bit mask
          → encode (PNG / RLE / raw)
```

### Why V3.1 is architecturally ready

1. **`build_segments_for_layer` is already Z-parameterized.** It computes `z_mm = ((layer_index as f32) + 0.5) * layer_height_mm` and calls `edge_plane_intersection_t` per triangle edge. Accepting a `z_mm` override is a one-parameter change.

2. **`row_accum` accumulation generalizes.** Currently divides by `aa_steps` (Y sub-scanlines). With Z supersampling, divide by `y_steps × z_steps`. Promote `Vec<u32>` → `Vec<u64>` only when combined multiplier exceeds 255 (e.g., 16×Y × 16×Z).

3. **Layer index is reusable across sub-Z queries.** Dense/banded/ZBins indexes return the same candidate list for sub-Z offsets within a single layer thickness. False positives are harmless — non-intersecting triangles produce zero segments.

4. **Encoding is format-agnostic.** `encode_grayscale_png_8bit` and the RLE path both handle 8-bit grayscale natively. No encoder changes required.

5. **Session pipeline stays intact.** Rayon `par_iter` over layers with bounded concurrency. Z-supersampling adds sequential work within each worker — no restructuring needed.

### No blocking architectural issues

All concerns are **optimization/UX trade-offs**, not structural.

---

## Concerns & Constraints

### C1: Linear throughput scaling

Per-layer rasterization time multiplies linearly with total sub-samples.

| Mode       | Y Steps | Z Steps | Total | Multiplier |
| ---------- | ------- | ------- | ----- | ---------- |
| Off        | 1       | 1       | 1×    | 1.0×       |
| 2× Y-AA    | 2       | 1       | 2×    | 2.0×       |
| 4× Y-AA    | 4       | 1       | 4×    | 4.0×       |
| 2× Z-AA    | 1       | 2       | 2×    | 2.0×       |
| 4× Z-AA    | 1       | 4       | 4×    | 4.0×       |
| 2×2× (Y+Z) | 2       | 2       | 4×    | 4.0×       |
| 4×4× (Y+Z) | 4       | 4       | 16×   | 16.0×      |

**Projected wall times** (8-core, 8K res, 1000 layers, ~100 triangles/layer):

- AA=Off: ~5s
- 2×2× (Y+Z): ~20s
- 4×4× (Y+Z): ~80s

### C2: Large-layer concurrency limiter

At ≥48 MB per mask, the pool caps workers to 1. Combined with 4× Z-AA this serializes hard:

- 8K mask ≈ 56 MB → 1 worker
- 4× Z-AA → 4× slower per worker
- Net: ~7 min vs ~1.75 min baseline for 1000 layers

**Mitigation:** recommend ≤ 2× Z-AA at 8K resolution until pipeline splitting/tiling is explored.

### C3: No spatial pruning by sub-Z

The layer index returns the same candidate set for all sub-Z values within a layer. Per-sub-Z candidate filtering (`tri.z_min ≤ z_sub ≤ tri.z_max`) is possible but adds CPU work. In practice, false positives are cheap — `edge_plane_intersection_t` rejects non-crossing triangles in ~4 instructions.

### C4: Accumulator overflow

Combined AA of 16× (e.g., 4×Y × 4×Z) produces max accumulator value of `255 × 16 = 4080`, well within `u32`. Promotion to `u64` only needed at extreme combined levels (>255× total sub-samples), which is impractical.

### C5: Determinism guarantee

Sub-Z sample positions must be deterministic given (layer_index, z_steps, layer_height_mm). Use centered sub-offsets:

```
z_mm = ((layer_index as f32) + (sub + 0.5) / z_steps as f32) * layer_height_mm
```

This preserves bitwise reproducibility.

---

## Recommended Implementation

### Phase 1: Core Z Supersampling

**Goal:** add optional `z_aa_steps` to the job contract and implement uniform Z supersampling in both rasterizer paths.

#### 1a. Job contract extension (`types.rs`)

```rust
/// Z-axis supersampling steps for 3D anti-aliasing (`1`, `2`, `4`).
#[serde(default = "default_z_aa_steps")]
pub z_aa_steps: u8,
```

Default: `1` (off). Valid values: `1`, `2`, `4`. Validate in `engine::validate_job`.

#### 1b. Segment generation parameterization (`raster.rs`)

Change `build_segments_for_layer` to accept a `z_mm_override: f32` parameter instead of computing Z internally:

```rust
fn build_segments_for_layer(
    job: &SliceJobV3,
    triangles: &[Triangle],
    layer_indices: &[usize],
    z_mm: f32,              // was: layer_index + 0.5 * layer_height
    layer_height_mm: f32,
) -> Vec<Segment>
```

Callers pass computed sub-Z values.

#### 1c. Z accumulation loop (`rasterize_layer_with_stats`, `rasterize_layer_rle`)

Wrap the existing segment-build + scanline-fill in an outer Z loop:

```rust
let z_steps = job.z_aa_steps.max(1) as usize;
let total_sub_samples = (aa_steps * z_steps) as u32;

for z_sub in 0..z_steps {
    let z_mm = ((layer_index as f32)
        + ((z_sub as f32 + 0.5) / z_steps as f32))
        * job.layer_height_mm;

    let segments = build_segments_for_layer(job, triangles, layer_indices, z_mm, job.layer_height_mm);
    if segments.is_empty() { continue; }

    let scanline_index = build_scanline_segment_index(&segments, height, aa_steps);
    // ... existing scanline fill loop, accumulating into row_accum ...
}

// Resolve: row_accum / total_sub_samples → 8-bit
```

#### 1d. Memory impact

- `row_accum` stays `Vec<u32>` (max value at 4×4× = 4080, fits u32)
- No additional mask buffers needed — single output mask accumulates all Z passes
- Working memory increase: **zero** beyond existing allocations

### Phase 2: Separate UI Controls

**Goal:** expose Y-AA and Z-AA as independent controls in the frontend.

- Y-AA: existing `anti_aliasing_level` (`Off`, `2x`, `4x`, `8x`, `16x`)
- Z-AA: new `z_anti_aliasing` control (`Off`, `2x`, `4x`)
- SlicingPanel maps to `z_aa_steps` in the job contract

Recommend capping Z-AA at 4× in the UI. Higher values offer diminishing returns relative to cost.

### Phase 3: Adaptive Z Supersampling (Stretch)

**Goal:** reduce Z-AA cost by only applying extra Z samples on layers with steep-angle/thin features.

#### Approach A: Triangle normal analysis

Pre-compute per-layer "Z complexity score" from candidate triangle surface normals:

- Near-horizontal triangles (normal ≈ Z-axis) → no Z-AA needed
- Near-vertical/steep triangles → Z-AA beneficial

Gate Z sub-sampling: only apply `z_aa_steps > 1` on layers where score exceeds threshold.

**Expected cost reduction:** 50–70% of layers skip Z-AA on typical organic prints.

#### Approach B: Two-pass detect-then-refine

1. Rasterize at layer center Z (1× pass)
2. Rasterize at Z ± half-layer offset
3. If masks differ significantly → re-rasterize at full Z-AA
4. If masks are identical → use center-Z result directly

**Expected cost reduction:** significant for flat-topped or vertical-walled geometry; minimal for fully organic surfaces.

### Phase 4: Split AA for Supports (Future)

**Goal:** respect `aa_on_supports` field (currently reserved in the job contract).

- Rasterize model geometry with full Y+Z AA
- Rasterize support geometry with binary (Off) or reduced AA
- Composite final mask

Requires support geometry to be tagged/separated in the triangle buffer, which is a broader pipeline concern beyond V3.2 scope.

---

## Testing Strategy

### Correctness

- **Regression suite:** verify that `z_aa_steps=1` produces identical output to V3.1
- **Determinism:** same job config → bitwise identical masks across runs
- **Coverage validation:** sphere/cylinder at 45° slope must produce smooth Z gradients at 2× and 4× Z-AA (no banding)
- **Edge cases:** single-voxel features, extremely thin layers, zero-area triangles at Z boundary

### Performance

- **Benchmark matrix:** 8K resolution, 1000 layers, triangle counts of 100/10K/100K
- **Measure per-layer rasterization time** at each Z-AA level vs baseline
- **Memory high-water mark** tracking to confirm no leaks from Z sub-loops
- **Cancellation responsiveness:** Z sub-loops must check cancellation token between sub-Z passes

### Visual

- **Reference prints:** before/after comparison on known stairstepping-prone test models
- **Layer preview inspection:** side-by-side grayscale mask comparison at Z-transitioning layers

---

## Non-Goals for V3.2

- Full 3D voxelized supersampling pipeline (architecture mismatch, massive memory)
- Anisotropic AA kernels (separate X/Y/Z kernel shapes)
- GPU-accelerated rasterization (future consideration)
- Split model/support AA masks (`aa_on_supports` — deferred to V3.3+)

---

## Summary

V3.1's rasterizer was designed with extensibility in mind. The scanline-accumulation model, Z-parameterized contour extraction, and format-agnostic encoding make 3D AA a natural incremental addition. The primary trade-off is linear compute scaling, mitigated by sensible defaults (2× Z-AA) and future adaptive techniques.

**Estimated effort:** Phase 1 (core Z-AA) is ~2-3 days of Rust work + frontend wiring. Phase 2 (UI) is ~1 day. Phase 3 (adaptive) is exploratory.
