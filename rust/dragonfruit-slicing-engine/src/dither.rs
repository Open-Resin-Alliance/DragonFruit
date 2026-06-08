//! Floyd-Steinberg energy-based dithering for low-bit-depth display systems.

use crate::rle::{RleRun, RleAccum, emit_row, emit_zero_rows};

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
    pub fn new(lut: &[u8; 256], gamma: f64, bit_depth: u32) -> Self {
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

/// Dither an RLE layer row-by-row with O(width) auxiliary memory and O(1) binned lookup table.
///
/// Implements sequential Floyd-Steinberg error diffusion in physical energy space,
/// re-encoding back to RLE runs row-by-row.
pub fn dither_rle_layer_with_lut_and_gamma(
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
}
