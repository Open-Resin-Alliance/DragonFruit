//! Floyd-Steinberg energy-based dithering for low-bit-depth display systems.

use crate::rle::{RleRun, RleAccum, emit_row, emit_zero_rows};

/// Lowest desired energy the binned lookup table covers.
const MIN_ENERGY: f32 = -0.5;
/// Maps the 2.0-wide energy span onto the 4096 bins.
const ENERGY_SCALE: f32 = 2047.5;

/// Precomputed energy tables and target palette for Floyd-Steinberg dithering.
///
/// Integrates a highly optimized O(1) binned lookup table (Dither-LUT) that pins
/// to L1 Data Cache (<20KB), completely bypassing costly nearest-neighbor search loops
/// and eliminating branch mispredictions.
pub struct DitherPaletteV3 {
    /// Maps 8-bit input grayscale directly to physical energy based on the job LUT and gamma:
    /// E = (lut[V] / 255.0) ^ gamma
    pub source_energy: [f32; 256],
    
    /// Target PWM byte values for the low-bit-depth palette levels (e.g. 8 levels for 3-bit).
    pub target_bytes: Vec<u8>,
    
    /// Maps each target palette index to its corresponding physical energy level.
    pub target_energy: Vec<f32>,

    /// --- High Performance O(1) Binned Lookup Fields ---
    /// Precomputed target bytes corresponding to each of the 4096 bins for desired energy range [-0.5, 1.5]
    pub bin_bytes: [u8; 4096],

    /// Precomputed target energy corresponding to each of the 4096 bins for desired energy range [-0.5, 1.5]
    pub bin_energy: [f32; 4096],
}

impl DitherPaletteV3 {
    /// Create and precompute a new dithering palette with binned lookup structures.
    ///
    /// `bit_depth` must already be in the 2..=7 range dithering is defined for;
    /// callers get that from [`SliceJobV3::effective_dither_bit_depth`], which
    /// declines to dither at all outside it. The clamp below is only a last-resort
    /// guard against a palette with 1 or 256 levels — reaching it means the caller
    /// skipped that gate, so it trips a debug assertion rather than quietly
    /// degrading the layer.
    pub fn new(lut: &[u8; 256], gamma: f64, bit_depth: u32) -> Self {
        debug_assert!(
            (2..=7).contains(&bit_depth),
            "dither bit depth {bit_depth} is outside the 2..=7 range dithering is defined for",
        );
        let bit_depth = bit_depth.clamp(2, 7);
        let mut source_energy = [0.0f32; 256];
        for i in 0..256 {
            source_energy[i] = ((lut[i] as f64) / 255.0).powf(gamma) as f32;
        }

        let levels = 1 << bit_depth;
        let mut target_bytes = Vec::with_capacity(levels);
        let mut target_energy = Vec::with_capacity(levels);
        for i in 0..levels {
            let val = i as f64 * (255.0 / (levels - 1) as f64);
            let pwm_byte = val.round().clamp(0.0, 255.0) as u8;
            target_bytes.push(pwm_byte);
            target_energy.push(((pwm_byte as f64) / 255.0).powf(gamma) as f32);
        }

        // --- Precompute 1D Binned Dither-LUT ---
        let mut bin_bytes = [0u8; 4096];
        let mut bin_energy = [0.0f32; 4096];

        let min_e = -0.5f32;
        let span_e = 2.0f32;

        for bin_idx in 0..4096 {
            // Reconstruct the desired energy at the center of the bin:
            let desired_energy = min_e + (bin_idx as f32 + 0.5) / 4096.0 * span_e;

            // Find the closest target palette index
            let mut best_idx = 0;
            let mut min_diff = f32::MAX;
            for (k, &tgt_energy) in target_energy.iter().enumerate() {
                let diff = (desired_energy - tgt_energy).abs();
                if diff < min_diff {
                    min_diff = diff;
                    best_idx = k;
                }
            }

            bin_bytes[bin_idx] = target_bytes[best_idx];
            bin_energy[bin_idx] = target_energy[best_idx];
        }

        Self {
            source_energy,
            target_bytes,
            target_energy,
            bin_bytes,
            bin_energy,
        }
    }
}

/// True when a zero pixel carrying no error dithers to zero and emits no error.
///
/// Every skip in [`dither_rle_layer_with_lut_and_gamma`] rests on this: empty
/// space must consume error without ever creating any.  It holds for an identity
/// or zero-preserving LUT, but a tail-cure LUT is free to map input 0 onto a cure
/// value, and then empty space is not empty and the whole frame has to be walked.
/// Checked rather than assumed.
fn zero_is_inert(palette: &DitherPaletteV3) -> bool {
    if palette.source_energy[0] != 0.0 {
        return false;
    }
    let bin = (((0.0f32 - MIN_ENERGY) * ENERGY_SCALE).clamp(0.0, 4095.0)) as usize;
    palette.bin_bytes[bin] == 0 && palette.bin_energy[bin] == 0.0
}

/// Trim only zero-valued edges of a possible incoming-error interval. Both
/// signed zeros are inert; subnormals, infinities and NaNs must stay active.
/// Search the edges rather than rescanning the already-active interior.
#[inline]
fn nonzero_error_bounds(
    lo: usize, hi: usize, mut error_at: impl FnMut(usize) -> f32,
) -> (usize, usize) {
    let Some(lo) = (lo..=hi).find(|&x| error_at(x) != 0.0) else {
        return (usize::MAX, 0);
    };
    let hi = (lo..=hi).rfind(|&x| error_at(x) != 0.0).unwrap();
    (lo, hi)
}

/// Only the first/last input rows are needed before streaming. Keep this scan
/// O(runs), including for a single nonzero run spanning many complete rows.
fn nonzero_source_rows(runs: &[RleRun], width: usize, height: usize) -> Option<(usize, usize)> {
    let total_pixels = width.saturating_mul(height);
    let mut offset = 0;
    let mut first = usize::MAX;
    let mut last = 0;
    for run in runs {
        if offset >= total_pixels { break; }
        let length = (run.length as usize).min(total_pixels - offset);
        if run.value != 0 && length != 0 {
            first = first.min(offset);
            last = offset + length - 1;
        }
        offset += length;
    }
    if first == usize::MAX { None } else { Some((first / width, last / width)) }
}

/// A borrowed run position shared by the row-bound scan and its cheap snapshot.
/// Exhausted input is an implicit zero tail, matching `RleRowDecoder`.
#[derive(Clone, Copy)]
struct RleSourcePosition<'a> {
    runs: &'a [RleRun],
    run_idx: usize,
    run_end: usize,
}

impl<'a> RleSourcePosition<'a> {
    fn new(runs: &'a [RleRun]) -> Self {
        Self { runs, run_idx: 0, run_end: runs.first().map_or(usize::MAX, |run| run.length as usize) }
    }

    #[inline]
    fn seek(&mut self, offset: usize) {
        while offset >= self.run_end && self.run_idx < self.runs.len() {
            self.run_idx += 1;
            let Some(run) = self.runs.get(self.run_idx) else {
                self.run_end = usize::MAX;
                break;
            };
            self.run_end = self.run_end.saturating_add(run.length as usize);
        }
    }

    /// Advance exactly one row without expanding bytes or consulting the LUT.
    /// Raw nonzero values remain active even when their energy is zero or NaN.
    fn row_bounds(&mut self, row_start: usize, width: usize) -> (usize, usize) {
        let row_end = row_start.saturating_add(width);
        let mut offset = row_start;
        let mut lo = usize::MAX;
        let mut hi = 0;
        self.seek(offset);
        while offset < row_end && self.run_idx < self.runs.len() {
            let end = self.run_end.min(row_end);
            if self.runs[self.run_idx].value != 0 {
                lo = lo.min(offset - row_start);
                hi = end - row_start - 1;
            }
            offset = end;
            self.seek(offset);
        }
        (lo, hi)
    }
}

/// Sampling retains the exact immutable palette value until the input run
/// changes, including across rows. The only per-pixel source work inside a run
/// is comparing its absolute end and reading this cached f32.
struct RleEnergyCursor<'a> {
    position: RleSourcePosition<'a>,
    source_energy: &'a [f32; 256],
    energy: f32,
}

impl<'a> RleEnergyCursor<'a> {
    fn new(mut position: RleSourcePosition<'a>, source_energy: &'a [f32; 256]) -> Self {
        position.seek(0);
        let value = position.runs.get(position.run_idx).map_or(0, |run| run.value);
        Self { position, source_energy, energy: source_energy[value as usize] }
    }

    #[inline]
    fn start_row(&mut self, mut position: RleSourcePosition<'a>, offset: usize) {
        position.seek(offset);
        if position.run_idx != self.position.run_idx {
            let value = position.runs.get(position.run_idx).map_or(0, |run| run.value);
            self.energy = self.source_energy[value as usize];
        }
        self.position = position;
    }

    #[inline(always)]
    fn energy_at(&mut self, offset: usize) -> f32 {
        if offset >= self.position.run_end {
            self.position.seek(offset);
            let value = self.position.runs.get(self.position.run_idx).map_or(0, |run| run.value);
            self.energy = self.source_energy[value as usize];
        }
        self.energy
    }
}

/// Dither an RLE layer, walking only the part of the frame that can affect the
/// output.
///
/// Floyd-Steinberg is a strict left-to-right, top-to-bottom dependency chain, so
/// the obvious implementation walks every pixel of the plate — on a 16K printer
/// that is 15120 columns for a row the model touches in a few hundred, and it
/// dominated every slicing profile we took (74-82% of all CPU).
///
/// The walk is restricted to a band without changing a single output byte. In
/// empty space the desired energy is exactly 0, which lands in the bin whose
/// target energy is exactly 0, so the quantisation error is exactly `0.0` and
/// nothing propagates: the band closes itself rather than being cut off at some
/// guessed margin. The band still grows rightward for as long as the error is a
/// non-zero float, so a genuine bleed is followed to its end.
pub fn dither_rle_layer_with_lut_and_gamma(
    runs: &[RleRun],
    palette: &DitherPaletteV3,
    width: usize,
    height: usize,
) -> Vec<RleRun> {
    if runs.is_empty() || width == 0 || height == 0 {
        return Vec::new();
    }

    let Some((min_y, max_y)) = nonzero_source_rows(runs, width, height)
    else {
        let mut out = RleAccum::new();
        emit_zero_rows(&mut out, height, width);
        return out.finish();
    };

    if !zero_is_inert(palette) {
        return dither_rle_layer_full_frame(runs, palette, width, height);
    }

    let mut out = RleAccum::new();
    let mut err_curr = vec![0.0f32; width];
    let mut err_next = vec![0.0f32; width];
    let mut row_pixels = vec![0u8; width];
    let mut source_rows = RleSourcePosition::new(runs);
    source_rows.seek(min_y.saturating_mul(width));
    let mut source = RleEnergyCursor::new(source_rows, &palette.source_energy);

    // Rows above the model hold nothing and no error has been produced yet.
    emit_zero_rows(&mut out, min_y, width);

    // Columns of `err_curr` that may hold a non-zero value; empty when lo > hi.
    let mut curr_lo = usize::MAX;
    let mut curr_hi = 0usize;

    for y in min_y..height {
        let err_empty = curr_lo > curr_hi;
        if y > max_y && err_empty {
            emit_zero_rows(&mut out, height - y, width);
            break;
        }

        let row_start = y.saturating_mul(width);
        let row_source = source_rows;
        let (input_lo, input_hi) = source_rows.row_bounds(row_start, width);
        if input_lo > input_hi && err_empty {
            // This row is blank, but later rows may still contain input.
            emit_zero_rows(&mut out, 1, width);
            continue;
        }

        let lo = input_lo.min(curr_lo).min(width - 1);
        let mut hi = input_hi.max(curr_hi).min(width - 1);
        source.start_row(row_source, row_start + lo);

        let mut x = lo;
        while x <= hi {
            let desired = source.energy_at(row_start + x) + err_curr[x];
            let bin = (((desired - MIN_ENERGY) * ENERGY_SCALE).clamp(0.0, 4095.0)) as usize;
            row_pixels[x] = palette.bin_bytes[bin];
            let quant_error = desired - palette.bin_energy[bin];

            if quant_error != 0.0 {
                if x + 1 < width {
                    err_curr[x + 1] += quant_error * 0.4375; // right, 7/16
                    if x + 1 > hi {
                        hi = x + 1; // the bleed is still alive; follow it
                    }
                }
                if y + 1 < height {
                    if x > 0 {
                        err_next[x - 1] += quant_error * 0.1875; // below-left, 3/16
                    }
                    err_next[x] += quant_error * 0.3125; // below, 5/16
                    if x + 1 < width {
                        err_next[x + 1] += quant_error * 0.0625; // below-right, 1/16
                    }
                }
            }
            x += 1;
        }

        out.push_run(lo as u32, 0);
        emit_row(&mut out, &row_pixels[lo..=hi]);
        out.push_run((width - 1 - hi) as u32, 0);

        // `err_next` was written only across [lo-1, hi+1]. Trim its actual
        // support: an old carry band must not keep growing after errors vanish.
        let next_lo = lo.saturating_sub(1);
        let next_hi = (hi + 1).min(width - 1);
        std::mem::swap(&mut err_curr, &mut err_next);
        // The row consumed [lo, hi] of the old `err_curr` and also wrote into it
        // rightward as it went, out to hi+1 — clearing only what was carried in
        // leaves that tail dirty for the row after next.
        err_next[lo..=next_hi].fill(0.0);
        if y + 1 < height {
            (curr_lo, curr_hi) = nonzero_error_bounds(next_lo, next_hi, |x| err_curr[x]);
        } else {
            curr_lo = usize::MAX;
            curr_hi = 0;
        }
    }

    out.finish()
}

/// A borrowed independent stream; the batch never copies its input runs.
pub(crate) struct DitherLayer<'a> {
    pub(crate) runs: &'a [RleRun],
    pub(crate) width: usize,
    pub(crate) height: usize,
}

pub(crate) const LAYER_DITHER_BATCH: usize = 4;

/// Decide scheduling once, outside worker/vector loops. Scalar and curing-zero
/// jobs keep individual task scheduling instead of serializing a partial group.
pub(crate) fn can_batch_layers(palette: &DitherPaletteV3, backend: crate::pulp_simd::Backend) -> bool {
    struct NativeFour;
    impl pulp::WithSimd for NativeFour {
        type Output = bool;
        fn with_simd<S: pulp::Simd>(self, _simd: S) -> bool { S::F32_LANES == LAYER_DITHER_BATCH }
    }
    zero_is_inert(palette) && backend.for_layer_dither().dispatch(NativeFour)
}

/// Dispatch on the executing post worker. Partial batches and non-inert LUTs
/// retain the scalar API, including its empty-layer/full-frame behavior.
pub(crate) fn dither_rle_layers(
    layers: &[DitherLayer<'_>],
    palette: &DitherPaletteV3,
    backend: crate::pulp_simd::Backend,
) -> [Vec<RleRun>; LAYER_DITHER_BATCH] {
    assert!(layers.len() <= LAYER_DITHER_BATCH);
    backend.for_layer_dither().dispatch(LayerDither { layers, palette })
}

struct LayerDither<'a, 'r> {
    layers: &'a [DitherLayer<'r>],
    palette: &'a DitherPaletteV3,
}

impl pulp::WithSimd for LayerDither<'_, '_> {
    type Output = [Vec<RleRun>; LAYER_DITHER_BATCH];

    #[inline(always)]
    fn with_simd<S: pulp::Simd>(self, simd: S) -> Self::Output {
        if self.layers.len() != LAYER_DITHER_BATCH || S::F32_LANES != LAYER_DITHER_BATCH
            || !zero_is_inert(self.palette)
        {
            return std::array::from_fn(|lane| self.layers.get(lane).map_or_else(Vec::new, |layer| {
                dither_rle_layer_with_lut_and_gamma(layer.runs, self.palette, layer.width, layer.height)
            }));
        }
        dither_independent_layers_with_simd(simd, self.layers, self.palette)
    }
}

struct LayerDitherStream<'a> {
    source_rows: RleSourcePosition<'a>,
    source: RleEnergyCursor<'a>,
    row_start: usize,
    out: RleAccum,
    row: Vec<u8>,
    width: usize,
    height: usize,
    first_y: usize,
    last_y: usize,
    curr_lo: usize,
    curr_hi: usize,
    lo: usize,
    hi: usize,
    finished: bool,
}

/// Keep separate multiply/add operations: FS rounding is part of the format.
#[inline(always)]
fn add_layer_error<S: pulp::Simd>(
    simd: S, destination: &mut S::f32s, error: S::f32s, weight: f32,
    lanes: &[u32; LAYER_DITHER_BATCH],
) {
    let mask = simd.transmute_m32s_u32s(simd.partial_load_u32s(lanes));
    let product = simd.mul_f32s(error, simd.splat_f32s(weight));
    let sum = simd.add_f32s(*destination, product);
    *destination = simd.select_f32s(mask, sum, *destination);
}

/// One lane per Z layer, never one lane per dependent XY pixel. Error rows are
/// interleaved complete four-f32 vectors; each lane retains the scalar carry band.
#[inline(never)]
fn dither_independent_layers_with_simd<S: pulp::Simd>(
    simd: S, layers: &[DitherLayer<'_>], palette: &DitherPaletteV3,
) -> [Vec<RleRun>; LAYER_DITHER_BATCH] {
    debug_assert_eq!(S::F32_LANES, LAYER_DITHER_BATCH);
    let mut outputs = std::array::from_fn(|_| Vec::new());
    let mut streams: [Option<LayerDitherStream<'_>>; LAYER_DITHER_BATCH] = std::array::from_fn(|lane| {
        let layer = &layers[lane];
        if layer.runs.is_empty() || layer.width == 0 || layer.height == 0 { return None; }
        let Some((first_y, last_y)) = nonzero_source_rows(layer.runs, layer.width, layer.height) else {
            let mut out = RleAccum::new();
            emit_zero_rows(&mut out, layer.height, layer.width);
            outputs[lane] = out.finish();
            return None;
        };
        let mut out = RleAccum::new();
        emit_zero_rows(&mut out, first_y, layer.width);
        let mut source_rows = RleSourcePosition::new(layer.runs);
        source_rows.seek(first_y.saturating_mul(layer.width));
        let source = RleEnergyCursor::new(source_rows, &palette.source_energy);
        Some(LayerDitherStream {
            source_rows, source, row_start: 0, out, row: vec![0; layer.width], width: layer.width, height: layer.height,
            first_y, last_y,
            curr_lo: usize::MAX, curr_hi: 0, lo: usize::MAX, hi: 0, finished: false,
        })
    });
    let width = streams.iter().flatten().map(|s| s.width).max().unwrap_or(0);
    let height = streams.iter().flatten().map(|s| s.height).max().unwrap_or(0);
    let first_y = streams.iter().flatten().map(|s| s.first_y).min().unwrap_or(height);
    let zero = simd.splat_f32s(0.0);
    let mut err_curr = vec![zero; width];
    let mut err_next = vec![zero; width];

    for y in first_y..height {
        let mut first_x = usize::MAX;
        let mut last_x = 0;
        for stream in streams.iter_mut().flatten() {
            stream.lo = usize::MAX;
            stream.hi = 0;
            if stream.finished || y < stream.first_y || y >= stream.height { continue; }
            let err_empty = stream.curr_lo > stream.curr_hi;
            if y > stream.last_y && err_empty {
                emit_zero_rows(&mut stream.out, stream.height - y, stream.width);
                stream.finished = true;
                continue;
            }
            stream.row_start = y.saturating_mul(stream.width);
            let row_source = stream.source_rows;
            let (input_lo, input_hi) = stream.source_rows.row_bounds(stream.row_start, stream.width);
            if input_lo > input_hi && err_empty {
                emit_zero_rows(&mut stream.out, 1, stream.width);
                continue;
            }
            stream.lo = input_lo.min(stream.curr_lo).min(stream.width - 1);
            stream.hi = input_hi.max(stream.curr_hi).min(stream.width - 1);
            stream.source.start_row(row_source, stream.row_start + stream.lo);
            first_x = first_x.min(stream.lo);
            last_x = last_x.max(stream.hi);
        }

        let mut x = first_x;
        while x <= last_x {
            let mut sources = [0.0; LAYER_DITHER_BATCH];
            let mut active = [false; LAYER_DITHER_BATCH];
            for (lane, stream) in streams.iter_mut().enumerate() {
                let Some(stream) = stream else { continue; };
                if x < stream.lo || x > stream.hi { continue; }
                active[lane] = true;
                sources[lane] = stream.source.energy_at(stream.row_start + x);
            }
            let desired = simd.add_f32s(simd.partial_load_f32s(&sources), err_curr[x]);
            let scaled = simd.mul_f32s(simd.sub_f32s(desired, simd.splat_f32s(MIN_ENERGY)), simd.splat_f32s(ENERGY_SCALE));
            let mut bins = [0.0; LAYER_DITHER_BATCH];
            simd.partial_store_f32s(&mut bins, scaled);
            let mut targets = [0.0; LAYER_DITHER_BATCH];
            for (lane, stream) in streams.iter_mut().enumerate() {
                if !active[lane] { continue; }
                let stream = stream.as_mut().unwrap();
                let bin = bins[lane].clamp(0.0, 4095.0) as usize;
                stream.row[x] = palette.bin_bytes[bin];
                targets[lane] = palette.bin_energy[bin];
            }
            let error = simd.sub_f32s(desired, simd.partial_load_f32s(&targets));
            let mut errors = [0.0; LAYER_DITHER_BATCH];
            simd.partial_store_f32s(&mut errors, error);
            let mut right = [0; LAYER_DITHER_BATCH];
            let mut below_left = [0; LAYER_DITHER_BATCH];
            let mut below = [0; LAYER_DITHER_BATCH];
            let mut below_right = [0; LAYER_DITHER_BATCH];
            let mut diffuse = false;
            for (lane, stream) in streams.iter_mut().enumerate() {
                if !active[lane] || errors[lane] == 0.0 { continue; }
                let stream = stream.as_mut().unwrap();
                diffuse = true;
                if x + 1 < stream.width {
                    right[lane] = u32::MAX;
                    stream.hi = stream.hi.max(x + 1);
                    last_x = last_x.max(stream.hi);
                }
                if y + 1 < stream.height {
                    if x > 0 { below_left[lane] = u32::MAX; }
                    below[lane] = u32::MAX;
                    if x + 1 < stream.width { below_right[lane] = u32::MAX; }
                }
            }
            if diffuse {
                if x + 1 < width { add_layer_error(simd, &mut err_curr[x + 1], error, 0.4375, &right); }
                if y + 1 < height {
                    if x > 0 { add_layer_error(simd, &mut err_next[x - 1], error, 0.1875, &below_left); }
                    add_layer_error(simd, &mut err_next[x], error, 0.3125, &below);
                    if x + 1 < width { add_layer_error(simd, &mut err_next[x + 1], error, 0.0625, &below_right); }
                }
            }
            x += 1;
        }

        for (lane, stream) in streams.iter_mut().enumerate() {
            let Some(stream) = stream else { continue; };
            if stream.lo > stream.hi { continue; }
            stream.out.push_run(stream.lo as u32, 0);
            emit_row(&mut stream.out, &stream.row[stream.lo..=stream.hi]);
            stream.out.push_run((stream.width - 1 - stream.hi) as u32, 0);
            if y + 1 < stream.height {
                let mut errors = [0.0; LAYER_DITHER_BATCH];
                (stream.curr_lo, stream.curr_hi) = nonzero_error_bounds(
                    stream.lo.saturating_sub(1), (stream.hi + 1).min(stream.width - 1), |x| {
                        simd.partial_store_f32s(&mut errors, err_next[x]);
                        errors[lane]
                    },
                );
            } else {
                stream.curr_lo = usize::MAX;
                stream.curr_hi = 0;
            }
        }
        std::mem::swap(&mut err_curr, &mut err_next);
        // Clear exactly each scalar stream's consumed range, including hi+1.
        for x in first_x..last_x.saturating_add(2).min(width) {
            let mut keep = [u32::MAX; LAYER_DITHER_BATCH];
            for (lane, stream) in streams.iter().enumerate() {
                if let Some(stream) = stream {
                    if stream.lo <= stream.hi && x >= stream.lo && x <= (stream.hi + 1).min(stream.width - 1) { keep[lane] = 0; }
                }
            }
            let mask = simd.transmute_m32s_u32s(simd.partial_load_u32s(&keep));
            err_next[x] = simd.select_f32s(mask, err_next[x], zero);
        }
    }
    for (lane, stream) in streams.into_iter().enumerate() {
        if let Some(stream) = stream { outputs[lane] = stream.out.finish(); }
    }
    outputs
}

/// The unbounded walk, kept for jobs whose LUT cures at input 0 — and used as the
/// oracle the bounded implementation is tested against.
fn dither_rle_layer_full_frame(
    runs: &[RleRun],
    palette: &DitherPaletteV3,
    width: usize,
    height: usize,
) -> Vec<RleRun> {
    if runs.is_empty() || width == 0 || height == 0 {
        return Vec::new();
    }

    let mut out = RleAccum::new();
    
    // Auxiliary sliding row error buffers: only O(width) RAM overhead
    let mut err_curr = vec![0.0f32; width];
    let mut err_next = vec![0.0f32; width];

    let mut decoder = crate::engine::RleRowDecoder::new(runs);
    let mut row_pixels = vec![0u8; width];

    // Binned lookup constants
    let min_e = -0.5f32;
    let scale = 2047.5f32; // maps span of 2.0 to index range 0..4095

    for y in 0..height {
        // Decode one row from RLE runs
        decoder.decode_next_row_span(width, 0, &mut row_pixels);

        let is_empty_row = row_pixels.iter().all(|&v| v == 0);
        let has_prior_errors = err_curr.iter().any(|&e| e != 0.0);

        if is_empty_row && !has_prior_errors {
            // Fast path: emit empty row directly
            emit_zero_rows(&mut out, 1, width);
            err_curr.fill(0.0);
            err_next.fill(0.0);
            continue;
        }

        // Apply Floyd-Steinberg error diffusion on the row with O(1) lookup.
        // Peel the first iteration (x = 0) and last iteration (x = width - 1)
        // to eliminate coordinate boundary checks in the hot inner loop.
        if width > 0 {
            let x = 0;
            let val = row_pixels[x];
            let src_energy = palette.source_energy[val as usize];
            let desired_energy = src_energy + err_curr[x];
            let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
            let dithered_val = palette.bin_bytes[bin_idx];
            row_pixels[x] = dithered_val;
            let quant_error = desired_energy - palette.bin_energy[bin_idx];

            if width > 1 {
                err_curr[1] += quant_error * 0.4375; // Right (7/16)
            }
            if y + 1 < height {
                err_next[0] += quant_error * 0.3125; // Bottom (5/16)
                if width > 1 {
                    err_next[1] += quant_error * 0.0625; // Bottom-Right (1/16)
                }
            }
        }

        if y + 1 < height {
            for x in 1..(width.saturating_sub(1)) {
                let val = row_pixels[x];
                let src_energy = palette.source_energy[val as usize];
                let desired_energy = src_energy + err_curr[x];
                let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
                let dithered_val = palette.bin_bytes[bin_idx];
                row_pixels[x] = dithered_val;
                let quant_error = desired_energy - palette.bin_energy[bin_idx];

                err_curr[x + 1] += quant_error * 0.4375; // Right (7/16)
                err_next[x - 1] += quant_error * 0.1875; // Bottom-Left (3/16)
                err_next[x] += quant_error * 0.3125;     // Bottom (5/16)
                err_next[x + 1] += quant_error * 0.0625; // Bottom-Right (1/16)
            }
        } else {
            for x in 1..(width.saturating_sub(1)) {
                let val = row_pixels[x];
                let src_energy = palette.source_energy[val as usize];
                let desired_energy = src_energy + err_curr[x];
                let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
                let dithered_val = palette.bin_bytes[bin_idx];
                row_pixels[x] = dithered_val;
                let quant_error = desired_energy - palette.bin_energy[bin_idx];

                err_curr[x + 1] += quant_error * 0.4375; // Right (7/16)
            }
        }

        if width > 1 {
            let x = width - 1;
            let val = row_pixels[x];
            let src_energy = palette.source_energy[val as usize];
            let desired_energy = src_energy + err_curr[x];
            let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
            let dithered_val = palette.bin_bytes[bin_idx];
            row_pixels[x] = dithered_val;
            let quant_error = desired_energy - palette.bin_energy[bin_idx];

            if y + 1 < height {
                err_next[x - 1] += quant_error * 0.1875; // Bottom-Left (3/16)
                err_next[x] += quant_error * 0.3125;     // Bottom (5/16)
            }
        }

        // Re-encode dithered row to RLE runs
        emit_row(&mut out, &row_pixels);

        // Swap error rows & clear err_next for next loop
        std::mem::swap(&mut err_curr, &mut err_next);
        err_next.fill(0.0);
    }

    out.finish()
}

/// Dither a flat mask sub-image row-by-row with O(width) auxiliary memory and O(1) binned lookup table.
///
/// Implements sequential Floyd-Steinberg error diffusion in physical energy space
/// directly in the provided flat slice bounds.
pub fn dither_mask_in_bounds(
    mask: &mut [u8],
    row_width: usize,
    row_height: usize,
    palette: &DitherPaletteV3,
) {
    if mask.is_empty() || row_width == 0 || row_height == 0 {
        return;
    }

    // Auxiliary sliding row error buffers: only O(row_width) RAM overhead
    let mut err_curr = vec![0.0f32; row_width];
    let mut err_next = vec![0.0f32; row_width];

    // Binned lookup constants
    let min_e = -0.5f32;
    let scale = 2047.5f32; // maps span of 2.0 to index range 0..4095

    for y in 0..row_height {
        let row_offset = y * row_width;
        
        // Peel the first iteration (x = 0) and last iteration (x = row_width - 1)
        // to eliminate coordinate boundary checks in the hot inner loop.
        if row_width > 0 {
            let x = 0;
            let idx = row_offset + x;
            let val = mask[idx];
            let src_energy = palette.source_energy[val as usize];
            let desired_energy = src_energy + err_curr[x];
            let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
            let dithered_val = palette.bin_bytes[bin_idx];
            mask[idx] = dithered_val;
            let quant_error = desired_energy - palette.bin_energy[bin_idx];

            if row_width > 1 {
                err_curr[1] += quant_error * 0.4375; // Right (7/16)
            }
            if y + 1 < row_height {
                err_next[0] += quant_error * 0.3125; // Bottom (5/16)
                if row_width > 1 {
                    err_next[1] += quant_error * 0.0625; // Bottom-Right (1/16)
                }
            }
        }

        if y + 1 < row_height {
            for x in 1..(row_width.saturating_sub(1)) {
                let idx = row_offset + x;
                let val = mask[idx];
                let src_energy = palette.source_energy[val as usize];
                let desired_energy = src_energy + err_curr[x];
                let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
                let dithered_val = palette.bin_bytes[bin_idx];
                mask[idx] = dithered_val;
                let quant_error = desired_energy - palette.bin_energy[bin_idx];

                err_curr[x + 1] += quant_error * 0.4375; // Right (7/16)
                err_next[x - 1] += quant_error * 0.1875; // Bottom-Left (3/16)
                err_next[x] += quant_error * 0.3125;     // Bottom (5/16)
                err_next[x + 1] += quant_error * 0.0625; // Bottom-Right (1/16)
            }
        } else {
            for x in 1..(row_width.saturating_sub(1)) {
                let idx = row_offset + x;
                let val = mask[idx];
                let src_energy = palette.source_energy[val as usize];
                let desired_energy = src_energy + err_curr[x];
                let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
                let dithered_val = palette.bin_bytes[bin_idx];
                mask[idx] = dithered_val;
                let quant_error = desired_energy - palette.bin_energy[bin_idx];

                err_curr[x + 1] += quant_error * 0.4375; // Right (7/16)
            }
        }

        if row_width > 1 {
            let x = row_width - 1;
            let idx = row_offset + x;
            let val = mask[idx];
            let src_energy = palette.source_energy[val as usize];
            let desired_energy = src_energy + err_curr[x];
            let bin_idx = (((desired_energy - min_e) * scale).max(0.0).min(4095.0)) as usize;
            let dithered_val = palette.bin_bytes[bin_idx];
            mask[idx] = dithered_val;
            let quant_error = desired_energy - palette.bin_energy[bin_idx];

            if y + 1 < row_height {
                err_next[x - 1] += quant_error * 0.1875; // Bottom-Left (3/16)
                err_next[x] += quant_error * 0.3125;     // Bottom (5/16)
            }
        }

        // Swap error rows & clear err_next for next loop
        std::mem::swap(&mut err_curr, &mut err_next);
        err_next.fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rle::RleRun;

    #[test]
    fn test_dither_palette_new() {
        let mut lut = [0u8; 256];
        for i in 0..256 {
            lut[i] = i as u8;
        }

        // Test 3-bit (8 levels) palette with gamma 3.0
        let palette = DitherPaletteV3::new(&lut, 3.0, 3);
        assert_eq!(palette.target_bytes.len(), 8);
        assert_eq!(palette.target_energy.len(), 8);

        // Target bytes should be linearly spaced PWM values from 0 to 255:
        // 0, 36, 73, 109, 146, 182, 219, 255
        let expected_bytes = vec![0, 36, 73, 109, 146, 182, 219, 255];
        assert_eq!(palette.target_bytes, expected_bytes);

        // Check source energy for value 128: (128/255)^3 = 0.126
        let err = (palette.source_energy[128] - (128.0 / 255.0f32).powi(3)).abs();
        assert!(err < 1e-5);
    }

    #[test]
    fn test_dither_rle_layer_all_palette_values() {
        let mut lut = [0u8; 256];
        for i in 0..256 {
            lut[i] = i as u8;
        }
        let palette = DitherPaletteV3::new(&lut, 3.0, 3);

        // Let's create an input layer with a gradient:
        // runs: 16 runs of value 128 (gray)
        let runs = vec![RleRun { value: 128, length: 16 }];
        let dithered = dither_rle_layer_with_lut_and_gamma(&runs, &palette, 4, 4);

        // Decode dithered to see that all pixels are in target_bytes palette!
        let mut decoder = crate::engine::RleRowDecoder::new(&dithered);
        let mut row = vec![0u8; 4];
        for _ in 0..4 {
            decoder.decode_next_row_span(4, 0, &mut row);
            for &val in &row {
                assert!(palette.target_bytes.contains(&val));
            }
        }
    }

    #[test]
    fn test_dither_mask_in_bounds() {
        let mut lut = [0u8; 256];
        for i in 0..256 {
            lut[i] = i as u8;
        }
        let palette = DitherPaletteV3::new(&lut, 3.0, 3);

        // Create a 4x4 flat gray mask
        let mut mask = vec![128u8; 16];
        dither_mask_in_bounds(&mut mask, 4, 4, &palette);

        // All values in mask must be from target_bytes
        for &val in &mask {
            assert!(palette.target_bytes.contains(&val));
        }

        // Output should have diffuse/error propagation (not just a flat color because 128 is not in target_bytes)
        let first_val = mask[0];
        let mut flat = true;
        for &val in &mask {
            if val != first_val {
                flat = false;
                break;
            }
        }
        assert!(!flat, "The dithered output should contain spatially distributed values rather than a single flat level");
    }

    /// Build runs from a flat pixel buffer.
    fn runs_of(pixels: &[u8]) -> Vec<RleRun> {
        let mut acc = RleAccum::new();
        emit_row(&mut acc, pixels);
        acc.finish()
    }

    fn identity_palette(bit_depth: u32) -> DitherPaletteV3 {
        let mut lut = [0u8; 256];
        for (i, v) in lut.iter_mut().enumerate() {
            *v = i as u8;
        }
        DitherPaletteV3::new(&lut, 2.2, bit_depth)
    }

    /// The bounded walk must return byte-identical runs to the full-frame walk.
    ///
    /// This is the whole safety argument for skipping empty space, so it is
    /// asserted on patterns chosen to stress the skip: content pinned to each
    /// edge, a lone lit pixel whose error has nowhere to go, and a gradient that
    /// deliberately bleeds sideways.
    fn assert_bounded_matches_full_frame(
        name: &str,
        pixels: &[u8],
        width: usize,
        height: usize,
        bit_depth: u32,
    ) {
        assert_eq!(pixels.len(), width * height, "{name}: bad fixture");
        let palette = identity_palette(bit_depth);
        let runs = runs_of(pixels);
        let bounded = dither_rle_layer_with_lut_and_gamma(&runs, &palette, width, height);
        let reference = dither_rle_layer_full_frame(&runs, &palette, width, height);
        assert_eq!(bounded, reference, "{name}: bounded walk changed the output");
        assert_eq!(
            bounded.iter().map(|r| r.length as usize).sum::<usize>(),
            width * height,
            "{name}: wrong pixel count"
        );
    }

    #[test]
    fn bounded_walk_is_identical_for_a_small_block_in_a_wide_frame() {
        let (w, h) = (256usize, 24usize);
        let mut px = vec![0u8; w * h];
        for y in 8..14 {
            for x in 100..118 {
                px[y * w + x] = 137;
            }
        }
        assert_bounded_matches_full_frame("block", &px, w, h, 3);
    }

    #[test]
    fn bounded_walk_is_identical_for_a_bleeding_gradient() {
        // Mid grays quantise badly on purpose: the error has to travel.
        let (w, h) = (300usize, 40usize);
        let mut px = vec![0u8; w * h];
        for y in 5..35 {
            for x in 60..200 {
                px[y * w + x] = ((x - 60) * 255 / 140) as u8;
            }
        }
        assert_bounded_matches_full_frame("gradient", &px, w, h, 3);
    }

    #[test]
    fn bounded_walk_is_identical_for_a_single_lit_pixel() {
        let (w, h) = (128usize, 16usize);
        let mut px = vec![0u8; w * h];
        px[4 * w + 31] = 200;
        assert_bounded_matches_full_frame("single pixel", &px, w, h, 3);
    }

    #[test]
    fn bounded_walk_is_identical_when_content_touches_the_edges() {
        let (w, h) = (96usize, 12usize);

        let mut left = vec![0u8; w * h];
        for y in 0..4 {
            for x in 0..6 {
                left[y * w + x] = 90;
            }
        }
        assert_bounded_matches_full_frame("top-left corner", &left, w, h, 3);

        let mut right = vec![0u8; w * h];
        for y in (h - 4)..h {
            for x in (w - 6)..w {
                right[y * w + x] = 90;
            }
        }
        assert_bounded_matches_full_frame("bottom-right corner", &right, w, h, 3);

        assert_bounded_matches_full_frame("full frame", &vec![170u8; w * h], w, h, 3);
    }

    /// A rectangle is the one shape whose bounding box costs nothing, so it
    /// proves the least. These are the shapes the band actually has to reason
    /// about: one that narrows to a point, one with a gap the walk must cross
    /// and hand back as zeros, and one that is a single pixel per row.
    #[test]
    fn bounded_walk_is_identical_for_shapes_that_are_not_rectangles() {
        let (w, h) = (240usize, 48usize);

        // Diamond: every row a different span, narrowing to a point at both ends.
        let mut diamond = vec![0u8; w * h];
        let (cx, cy) = (120i32, 24i32);
        for y in 0..h {
            for x in 0..w {
                let d = (x as i32 - cx).abs() + (y as i32 - cy).abs();
                if d < 20 {
                    diamond[y * w + x] = (255 - d * 6) as u8;
                }
            }
        }
        assert_bounded_matches_full_frame("diamond", &diamond, w, h, 3);

        // Two islands far apart: the band has to span the gap between them, and
        // the gap must come back out as zeros.
        let mut islands = vec![0u8; w * h];
        for y in 10..30 {
            for x in 12..26 {
                islands[y * w + x] = 180;
            }
            for x in 200..214 {
                islands[y * w + x] = 90;
            }
        }
        assert_bounded_matches_full_frame("two islands", &islands, w, h, 3);

        // A diagonal sliver: one or two lit pixels per row, marching sideways.
        let mut sliver = vec![0u8; w * h];
        for y in 0..h {
            let x = 4 + y * 4;
            if x < w {
                sliver[y * w + x] = 220;
            }
        }
        assert_bounded_matches_full_frame("diagonal sliver", &sliver, w, h, 3);
    }

    #[test]
    fn bounded_walk_is_identical_across_bit_depths() {
        let (w, h) = (200usize, 20usize);
        let mut px = vec![0u8; w * h];
        for y in 3..17 {
            for x in 40..90 {
                px[y * w + x] = (((x * 7 + y * 13) % 256) as u8).max(1);
            }
        }
        for bits in [2u32, 3, 4, 6] {
            assert_bounded_matches_full_frame(&format!("{bits}-bit"), &px, w, h, bits);
        }
    }

    /// A LUT that cures at input 0 makes empty space non-empty; the bounded walk
    /// must recognise that and fall back rather than skip real output away.
    #[test]
    fn a_lut_that_cures_at_zero_disables_the_skip() {
        let mut lut = [40u8; 256];
        for (i, v) in lut.iter_mut().enumerate().skip(1) {
            *v = (*v).max(i as u8);
        }
        let palette = DitherPaletteV3::new(&lut, 2.2, 3);
        assert!(!zero_is_inert(&palette), "a curing LUT must not be treated as inert");

        let (w, h) = (64usize, 8usize);
        let mut px = vec![0u8; w * h];
        px[2 * w + 10] = 200;
        let runs = runs_of(&px);
        let bounded = dither_rle_layer_with_lut_and_gamma(&runs, &palette, w, h);
        let reference = dither_rle_layer_full_frame(&runs, &palette, w, h);
        assert_eq!(bounded, reference);
        assert!(
            bounded.iter().any(|r| r.value != 0),
            "a curing LUT must still light empty space"
        );
    }

    /// An empty layer must dither to nothing at all.
    ///
    /// This is the invariant that makes it legal to skip empty regions: with
    /// `src = 0` and no incoming error the desired energy is 0, which lands in
    /// the bin whose target energy is exactly 0, so the quantisation error is 0
    /// and nothing is propagated onwards.  Empty space consumes error but never
    /// creates it.
    #[test]
    fn empty_layer_dithers_to_nothing() {
        let mut lut = [0u8; 256];
        for i in 0..256 {
            lut[i] = i as u8;
        }
        let palette = DitherPaletteV3::new(&lut, 2.2, 3);

        let (width, height) = (64usize, 8usize);
        let input = vec![RleRun { length: (width * height) as u32, value: 0 }];
        let out = dither_rle_layer_with_lut_and_gamma(&input, &palette, width, height);

        assert!(
            out.iter().all(|run| run.value == 0),
            "an empty layer produced non-zero output: {out:?}"
        );
        assert_eq!(
            out.iter().map(|run| run.length as usize).sum::<usize>(),
            width * height,
            "output pixel count must match the layer"
        );
    }

    fn assert_layer_batch_parity(layers: &[DitherLayer<'_>], palette: &DitherPaletteV3) {
        for backend in crate::pulp_simd::Backend::supported_for_tests() {
            for count in 0..=layers.len() {
                let output = dither_rle_layers(&layers[..count], palette, backend);
                for lane in 0..LAYER_DITHER_BATCH {
                    let expected = if lane < count {
                        let layer = &layers[lane];
                        dither_rle_layer_with_lut_and_gamma(layer.runs, palette, layer.width, layer.height)
                    } else { Vec::new() };
                    assert_eq!(output[lane], expected, "backend={backend:?} count={count} lane={lane}");
                }
            }
        }
    }

    fn assert_source_cursor_output(layers: &[DitherLayer<'_>; 4], palette: &DitherPaletteV3) {
        let expected: [Vec<RleRun>; 4] = std::array::from_fn(|lane| {
            let layer = &layers[lane];
            dither_rle_layer_full_frame(layer.runs, palette, layer.width, layer.height)
        });
        for (lane, layer) in layers.iter().enumerate() {
            assert_eq!(dither_rle_layer_with_lut_and_gamma(layer.runs, palette, layer.width, layer.height),
                expected[lane], "scalar lane={lane}");
        }
        for backend in crate::pulp_simd::Backend::supported_for_tests() {
            for count in 0..=4 {
                let output = dither_rle_layers(&layers[..count], palette, backend);
                for lane in 0..4 {
                    if lane < count {
                        assert_eq!(output[lane], expected[lane], "backend={backend:?} count={count} lane={lane}");
                    } else {
                        assert!(output[lane].is_empty(), "backend={backend:?} count={count} lane={lane}");
                    }
                }
            }
        }
    }

    #[test]
    fn source_cursor_matches_oracle_for_row_spans_and_blank_gaps() {
        let dimensions = [(29, 11), (7, 17), (1, 23), (17, 9)];
        let mut palette = identity_palette(3);
        palette.source_energy[1] = palette.target_energy[3];
        palette.source_energy[2] = 0.0;
        let runs: [Vec<RleRun>; 4] = std::array::from_fn(|lane| {
            let (width, height) = dimensions[lane];
            let mut pixels = vec![0; width * height];
            // Exact target energy closes the carry before a gap. Later input
            // must still be visited, at completely different row bounds.
            pixels[width + width / 2] = 1;
            pixels[(height / 2) * width] = 2;
            pixels[(height / 2) * width + width - 1] = 1;
            pixels[(height - 2) * width + width / 3] = 137;
            pixels[(height - 1) * width + width - 1] = 219;
            runs_of(&pixels)
        });
        let layers = std::array::from_fn(|lane| DitherLayer {
            runs: &runs[lane], width: dimensions[lane].0, height: dimensions[lane].1,
        });
        assert_source_cursor_output(&layers, &palette);
    }

    #[test]
    fn source_cursor_matches_oracle_for_cross_row_runs_short_and_excess_input() {
        let dimensions = [(7, 9), (11, 6), (3, 13), (5, 5)];
        let runs = [
            vec![RleRun { length: 0, value: 255 }, RleRun { length: 9, value: 0 },
                RleRun { length: 24, value: 137 }, RleRun { length: 0, value: 219 },
                RleRun { length: 17, value: 0 }, RleRun { length: 99, value: 219 },
                RleRun { length: 11, value: 0 }, RleRun { length: 3, value: 5 }],
            vec![RleRun { length: 4, value: 0 }, RleRun { length: 31, value: 91 },
                RleRun { length: 0, value: 255 }, RleRun { length: 5, value: 0 }],
            Vec::new(),
            vec![RleRun { length: 0, value: 230 }, RleRun { length: 0, value: 0 },
                RleRun { length: 25, value: 0 }, RleRun { length: 9, value: 255 }],
        ];
        let layers = std::array::from_fn(|lane| DitherLayer {
            runs: &runs[lane], width: dimensions[lane].0, height: dimensions[lane].1,
        });
        assert_source_cursor_output(&layers, &identity_palette(3));
        let lut = std::array::from_fn(|i| (i as u8).max(40));
        assert_source_cursor_output(&layers, &DitherPaletteV3::new(&lut, 2.2, 3));
    }

    #[test]
    fn source_cursor_matches_oracle_for_boundary_nonfinite_and_subnormal_runs() {
        let dimensions = [(13, 9), (9, 11), (1, 17), (19, 7)];
        for energy in [0.0, -0.0, f32::from_bits(1), f32::from_bits(0x80000001),
            f32::from_bits(0x007fffff), f32::from_bits(0x807fffff),
            f32::INFINITY, f32::NEG_INFINITY, f32::from_bits(0x7fc01234)]
        {
            let mut palette = identity_palette(3);
            palette.source_energy[1] = energy;
            palette.source_energy[2] = palette.target_energy[3];
            let bin = (1..4096).find(|&bin| palette.bin_bytes[bin] != palette.bin_bytes[bin - 1]).unwrap();
            let boundary = MIN_ENERGY + bin as f32 / ENERGY_SCALE;
            for (index, bits) in [boundary.to_bits() - 1, boundary.to_bits(), boundary.to_bits() + 1].into_iter().enumerate() {
                palette.source_energy[index + 3] = f32::from_bits(bits);
            }
            let runs: [Vec<RleRun>; 4] = std::array::from_fn(|lane| {
                let (width, height) = dimensions[lane];
                let mut pixels = vec![0; width * height];
                pixels[width + width / 2] = 2;
                for index in 0..3 {
                    for x in 0..width.min(3) {
                        pixels[(index + 2) * width + x] = index as u8 + 3;
                    }
                }
                let start = (height - 2) * width + width / 2;
                let end = (start + width + 1).min(pixels.len());
                pixels[start..end].fill(1);
                runs_of(&pixels)
            });
            let layers = std::array::from_fn(|lane| DitherLayer {
                runs: &runs[lane], width: dimensions[lane].0, height: dimensions[lane].1,
            });
            assert_source_cursor_output(&layers, &palette);
        }
    }

    #[test]
    fn layer_simd_matches_scalar_for_dimensions_rois_and_partial_batches() {
        for dimensions in [[(1, 1), (3, 7), (17, 3), (65, 19)], [(257, 41); 4]] {
            let runs: [Vec<RleRun>; 4] = std::array::from_fn(|lane| {
                let (width, height) = dimensions[lane];
                let mut pixels = vec![0; width * height];
                for y in 0..height {
                    for x in 0..width {
                        if (x + lane * 7) % 37 < 19 && (y + lane * 3) % 11 < 7 {
                            pixels[y * width + x] = ((x * 43 + y * 29 + lane * 71) % 255 + 1) as u8;
                        }
                    }
                }
                runs_of(&pixels)
            });
            let layers: [DitherLayer<'_>; 4] = std::array::from_fn(|lane| DitherLayer {
                runs: &runs[lane], width: dimensions[lane].0, height: dimensions[lane].1,
            });
            let lut = std::array::from_fn(|i| i as u8);
            for bits in 2..=7 {
                for gamma in [1.0, 2.2, 3.0, 80.0] {
                    assert_layer_batch_parity(&layers, &DitherPaletteV3::new(&lut, gamma, bits));
                }
            }
        }
    }

    #[test]
    fn layer_simd_preserves_empty_layers_and_curing_zero_fallback() {
        let lit = runs_of(&[0, 17, 0, 239, 0, 0, 127, 0, 0, 0, 0, 0]);
        let zero = runs_of(&[0; 12]);
        let layers = [
            DitherLayer { runs: &lit, width: 3, height: 4 },
            DitherLayer { runs: &zero, width: 3, height: 4 },
            DitherLayer { runs: &[], width: 0, height: 7 },
            DitherLayer { runs: &lit, width: 1, height: 12 },
        ];
        assert_layer_batch_parity(&layers, &identity_palette(3));
        let lut = std::array::from_fn(|i| (i as u8).max(40));
        assert_layer_batch_parity(&layers, &DitherPaletteV3::new(&lut, 2.2, 3));
        let empty_layers = [
            DitherLayer { runs: &[], width: 3, height: 4 },
            DitherLayer { runs: &zero, width: 3, height: 4 },
            DitherLayer { runs: &lit, width: 3, height: 0 },
            DitherLayer { runs: &zero, width: 1, height: 12 },
        ];
        assert_layer_batch_parity(&empty_layers, &identity_palette(3));
    }

    #[test]
    fn layer_simd_preserves_subnormals_and_quantization_boundaries() {
        let mut palette = identity_palette(3);
        for (i, bits) in [1, 2, 7, 0x007fffff, 0x80000001, 0x80000000].into_iter().enumerate() {
            palette.source_energy[i + 1] = f32::from_bits(bits);
        }
        let mut source = 7;
        for bin in 1..4096 {
            if palette.bin_bytes[bin] != palette.bin_bytes[bin - 1] {
                let boundary = MIN_ENERGY + bin as f32 / ENERGY_SCALE;
                for bits in [boundary.to_bits() - 1, boundary.to_bits(), boundary.to_bits() + 1] {
                    palette.source_energy[source] = f32::from_bits(bits);
                    source += 1;
                }
            }
        }
        let runs: [Vec<RleRun>; 4] = std::array::from_fn(|lane| {
            let pixels: Vec<u8> = (0..67 * 9).map(|i| ((i * 13 + lane * 5) % source) as u8).collect();
            runs_of(&pixels)
        });
        let layers: [DitherLayer<'_>; 4] = std::array::from_fn(|lane| DitherLayer { runs: &runs[lane], width: 67, height: 9 });
        assert_layer_batch_parity(&layers, &palette);
    }

    #[test]
    fn incoming_error_bounds_contract_only_exact_zeros() {
        let mut errors = [0.0, -0.0, f32::from_bits(1), 0.0, -f32::from_bits(1), -0.0];
        assert_eq!(nonzero_error_bounds(0, 5, |x| errors[x]), (2, 4));
        errors[2] = 0.0;
        assert_eq!(nonzero_error_bounds(0, 5, |x| errors[x]), (4, 4));
        errors[4] = -0.0;
        assert_eq!(nonzero_error_bounds(0, 5, |x| errors[x]), (usize::MAX, 0));
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.25, -0.25] {
            errors[3] = value;
            assert_eq!(nonzero_error_bounds(0, 5, |x| errors[x]), (3, 3));
        }
        assert_eq!(nonzero_error_bounds(4, 2, |x| errors[x]), (usize::MAX, 0));
    }

    #[test]
    fn contracted_carry_preserves_visible_bleed_after_the_final_input_row() {
        let mut palette = identity_palette(3);
        // Below the last palette transition, leaving enough positive error to
        // light the following blank row. Stopping at the input bounds is wrong.
        palette.source_energy[1] = palette.target_energy[6]
            + (palette.target_energy[7] - palette.target_energy[6]) * 0.45;
        let mut pixels = vec![0; 64];
        pixels[2] = 1;
        let runs = runs_of(&pixels);
        let reference = dither_rle_layer_full_frame(&runs, &palette, 1, 64);
        let mut decoder = crate::engine::RleRowDecoder::new(&reference);
        decoder.skip_pixels(3);
        let mut following_row = [0];
        decoder.decode_next_row_span(1, 0, &mut following_row);
        assert_ne!(following_row[0], 0, "fixture must retain meaningful blank-row bleed");
        assert_eq!(dither_rle_layer_with_lut_and_gamma(&runs, &palette, 1, 64), reference);
        let layers = std::array::from_fn::<_, 4, _>(|_| DitherLayer { runs: &runs, width: 1, height: 64 });
        assert_layer_batch_parity(&layers, &palette);
    }

    #[test]
    fn contracted_carry_matches_oracle_for_blank_gaps_tails_and_skewed_streams() {
        let dimensions = [(1, 257), (129, 193), (65, 97), (257, 65)];
        for energy in [0.0, 0.2, -0.125, f32::from_bits(1),
            f32::from_bits(0x007fffff), -f32::from_bits(0x007fffff), f32::NAN]
        {
            let mut palette = identity_palette(3);
            palette.source_energy[1] = energy;
            palette.source_energy[2] = palette.target_energy[3];
            let bin = (1..4096).find(|&bin| palette.bin_bytes[bin] != palette.bin_bytes[bin - 1]).unwrap();
            let boundary = MIN_ENERGY + bin as f32 / ENERGY_SCALE;
            for (index, bits) in [boundary.to_bits() - 1, boundary.to_bits(), boundary.to_bits() + 1].into_iter().enumerate() {
                palette.source_energy[index + 3] = f32::from_bits(bits);
            }
            let runs: [Vec<RleRun>; 4] = std::array::from_fn(|lane| {
                let (width, height) = dimensions[lane];
                let mut pixels = vec![0; width * height];
                // Exact palette energy can close the carry completely. Later
                // content must still decode correctly across the blank gap.
                pixels[(lane + 1) * width + width / 2] = 2;
                for x in width / 3..=width / 2 {
                    pixels[(height / 3) * width + x] = 1;
                }
                for index in 0..3 {
                    pixels[(height / 2 + index) * width + (width - 1 - index.min(width - 1))] = index as u8 + 3;
                }
                runs_of(&pixels)
            });
            let layers: [DitherLayer<'_>; 4] = std::array::from_fn(|lane| DitherLayer {
                runs: &runs[lane], width: dimensions[lane].0, height: dimensions[lane].1,
            });
            for layer in &layers {
                let reference = dither_rle_layer_full_frame(layer.runs, &palette, layer.width, layer.height);
                assert_eq!(dither_rle_layer_with_lut_and_gamma(layer.runs, &palette, layer.width, layer.height), reference,
                    "energy={energy:?} dimensions={}x{}", layer.width, layer.height);
            }
            assert_layer_batch_parity(&layers, &palette);
        }
    }

    #[test]
    fn layer_simd_error_arithmetic_is_packed_and_bit_exact() {
        struct Arithmetic;
        impl pulp::WithSimd for Arithmetic {
            type Output = Option<[u32; 4]>;
            fn with_simd<S: pulp::Simd>(self, simd: S) -> Self::Output {
                if S::F32_LANES != 4 { return None; }
                let initial = [0.125, -0.25, f32::from_bits(7), f32::from_bits(0x80000001)];
                let errors = [0.12345679, -0.33333334, f32::from_bits(11), f32::from_bits(0x007fffff)];
                let error = simd.partial_load_f32s(&errors);
                let mut destination = simd.partial_load_f32s(&initial);
                for weight in [0.4375, 0.1875, 0.3125, 0.0625] {
                    add_layer_error(simd, &mut destination, error, weight, &[u32::MAX; 4]);
                }
                let mut output = [0.0; 4];
                simd.partial_store_f32s(&mut output, destination);
                for lane in 0..4 {
                    let mut scalar = initial[lane];
                    for weight in [0.4375, 0.1875, 0.3125, 0.0625] { scalar += errors[lane] * weight; }
                    assert_eq!(output[lane].to_bits(), scalar.to_bits());
                }
                Some(output.map(f32::to_bits))
            }
        }
        for backend in crate::pulp_simd::Backend::supported_for_tests() {
            let output = backend.for_layer_dither().dispatch(Arithmetic);
            #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
            if !matches!(backend, crate::pulp_simd::Backend::Scalar) { assert!(output.is_some()); }
            let _ = output;
        }
    }
}
