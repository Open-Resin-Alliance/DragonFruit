# V3 Slicing Engine — 3D AA / 2D AA / Anisotropy Notes

Quick implementation-grounded notes for direction planning.

## 1) Most compatible multisampling/supersampling regimes for **3D AA**

### Best fit (high compatibility)

1. **Layer-local Z supersampling + existing XY AA**
   - Keep current per-layer raster path, but evaluate each layer at multiple sub-`z` offsets (e.g., `2x` or `4x` in Z within one layer thickness) and average to final 8-bit mask.
   - Why it fits: current engine already outputs grayscale masks and already accumulates AA coverage in a deterministic scanline pass.

2. **Separable AA: current XY pass × optional Z pass**
   - Preserve existing XY AA exactly; add optional Z accumulation only when enabled.
   - Good incremental path with controlled perf/memory impact.

### Medium fit

3. **Adaptive Z supersampling near steep/small features only**
   - Apply extra Z samples only on layers likely to change quickly (thin features / high slope regions).
   - More complex scheduling/heuristics, but cheaper than full-time high-Z supersampling.

### Low fit (for current architecture)

4. **Full 3D voxelized supersampling pipeline**
   - Would require fundamental architecture changes and significantly more memory.
   - Not aligned with current triangle-plane -> 2D mask pipeline.

### Important format constraint

- Current outputs can already carry grayscale coverage:
  - PNG path supports 8-bit grayscale.
  - CTB path stores raw 8-bit mask values when AA is on.
- So adding Z-based coverage is mostly a **raster/pipeline concern**, not blocked by container format.

---

## 2) Current **2D AA** implementation (today)

Implemented in `rust/dragonfruit-slicing-engine/src/raster.rs`:

- AA levels are parsed via `aa_subpixel_steps`: `Off`, `2x`, `4x`, `8x`, `16x`.
- Rasterization is winding-based scanline fill.
- AA mode uses:
  - **N-stepped Y sub-scanlines**
  - **analytic X span coverage** per sub-scanline
  - accumulation into `row_accum`, then resolve to final 8-bit grayscale.
- A minimum floor is applied to non-zero AA pixels via `minimum_aa_alpha_percent`.
- If AA is off, masks are binary (0/255).
- Pipeline chooses encoding accordingly:
  - `Off` => binary-optimized path (e.g., 1-bit PNG where applicable)
  - AA on => grayscale PNG / grayscale raw masks.

Note: `aa_on_supports` exists in the job contract but is currently described as reserved/future split-mask behavior.

---

## 3) Anisotropy / non-square pixels / non-cube voxels handling

### What is handled now

- **Non-square XY pixels are supported**.
  - `mm_to_pixel_x` uses `build_width_mm / source_width_px` mapping.
  - `mm_to_pixel_y` uses `build_depth_mm / source_height_px` mapping.
  - So X and Y physical scale are already independent.
- Area math also uses separate X/Y pixel pitch (`pixel_area_mm2`).
- Z is independent via `layer_height_mm` (not assumed equal to XY pitch).

### What is _not_ present as a dedicated feature

- No explicit anisotropic AA controls (e.g., separate AA kernels for X vs Y vs Z).
- No true 3D voxel-grid AA pass in V3 today.

### Practical interpretation

- V3 is fundamentally a **2.5D layer rasterizer** (triangle-plane intersection per layer), with good support for non-square XY calibration.
- “Non-cube voxel” behavior is implicit through `layer_height_mm` vs XY pitch differences, not through a dedicated 3D voxel pipeline.

---

## Suggested near-term direction

If we want the fastest safe path to “3D AA”:

1. Add optional **Z supersampling** (`2x`/`4x`) on top of current XY AA path.
2. Keep deterministic accumulation and existing minimum-alpha floor.
3. Gate by output format/perf profile defaults (e.g., CTB/NanoDLP presets).
4. Defer full voxelized approaches unless a broader architecture rewrite is planned.
