//! Low-level `.cxdlpv4` RLE layer encoding, Creality CRC32 checksum, and container serialization.

use std::sync::OnceLock;

use super::cxdlpv4_metadata::compute_layer_timing;
use super::cxdlpv4_preview::{
    LARGE_PREVIEW_HEIGHT, LARGE_PREVIEW_WIDTH, SMALL_PREVIEW_HEIGHT, SMALL_PREVIEW_WIDTH,
};
use super::cxdlpv4_types::CxdlpV4Metadata;
use crate::engine::SlicerV3Error;
use crate::rle::RleRun;
use crate::types::LayerAreaStatsV3;

const PREVIEW_HEADER_SIZE: usize = 32;
const PRINT_PARAMETERS_SIZE: usize = 68;
const SLICER_INFO_SIZE: usize = 76;
const LAYER_DEF_SIZE: usize = 40;
const LAYER_DEF_EX_SIZE: usize = 44;

/// Pushes a single `(gray8, count)` span into a Chitubox/Creality 7-bit RLE stream.
#[inline]
pub fn push_ctb_rle_run(out: &mut Vec<u8>, gray8: u8, count: u32) {
    let gray7 = (gray8 >> 1) & 0x7F;
    let mut remaining = count;
    while remaining > 0 {
        let len = remaining.min(0x0FFF_FFFF);
        if len == 1 {
            out.push(gray7);
        } else {
            out.push(gray7 | 0x80);
            if len <= 0x7F {
                out.push(len as u8);
            } else if len <= 0x3FFF {
                out.push(0x80 | ((len >> 8) as u8));
                out.push((len & 0xFF) as u8);
            } else if len <= 0x1F_FFFF {
                out.push(0xC0 | ((len >> 16) as u8));
                out.push(((len >> 8) & 0xFF) as u8);
                out.push((len & 0xFF) as u8);
            } else {
                out.push(0xE0 | ((len >> 24) as u8));
                out.push(((len >> 16) & 0xFF) as u8);
                out.push(((len >> 8) & 0xFF) as u8);
                out.push((len & 0xFF) as u8);
            }
        }
        remaining -= len;
    }
}

/// Encodes row-major `RleRun` spans for one layer into `.cxdlpv4` 7-bit RLE bytes.
pub fn encode_rle_runs_to_cxdlpv4_layer(
    runs: &[RleRun],
    expected_pixels: u64,
) -> Result<Vec<u8>, SlicerV3Error> {
    let mut out = Vec::with_capacity(runs.len().saturating_mul(2).max(64));
    let mut seen: u64 = 0;

    let mut cur_gray7: Option<u8> = None;
    let mut cur_len: u32 = 0;

    for run in runs {
        if run.length == 0 {
            continue;
        }
        seen = seen.saturating_add(run.length as u64);
        let g7 = run.value >> 1;
        match cur_gray7 {
            Some(prev) if prev == g7 => {
                let Some(next_len) = cur_len.checked_add(run.length) else {
                    push_ctb_rle_run(&mut out, prev << 1, cur_len);
                    cur_len = run.length;
                    continue;
                };
                cur_len = next_len;
            }
            Some(prev) => {
                push_ctb_rle_run(&mut out, prev << 1, cur_len);
                cur_gray7 = Some(g7);
                cur_len = run.length;
            }
            None => {
                cur_gray7 = Some(g7);
                cur_len = run.length;
            }
        }
    }

    if let Some(prev) = cur_gray7 {
        push_ctb_rle_run(&mut out, prev << 1, cur_len);
    }

    if seen != expected_pixels {
        return Err(SlicerV3Error::MissingRenderedLayerPayload(format!(
            "Layer pixel count mismatch: expected {expected_pixels}, got {seen}"
        )));
    }

    Ok(out)
}

/// Encodes a contiguous row-major grayscale mask buffer (`width * height` bytes) into 7-bit RLE.
pub fn encode_raw_mask_to_cxdlpv4_layer(mask: &[u8]) -> Vec<u8> {
    if mask.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity((mask.len() / 8).max(64));
    let mut cur_g7 = mask[0] >> 1;
    let mut run_len = 1u32;

    for &px in &mask[1..] {
        let g7 = px >> 1;
        if g7 == cur_g7 {
            if let Some(next) = run_len.checked_add(1) {
                run_len = next;
                continue;
            }
            push_ctb_rle_run(&mut out, cur_g7 << 1, run_len);
            run_len = 1;
        } else {
            push_ctb_rle_run(&mut out, cur_g7 << 1, run_len);
            cur_g7 = g7;
            run_len = 1;
        }
    }
    push_ctb_rle_run(&mut out, cur_g7 << 1, run_len);
    out
}

/// Encodes a completely blank layer (`expected_pixels` of 0) without allocating a full mask.
pub fn encode_empty_cxdlpv4_layer(expected_pixels: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(16);
    let mut remaining = expected_pixels;
    while remaining > 0 {
        let chunk = remaining.min(u32::MAX as u64) as u32;
        push_ctb_rle_run(&mut out, 0, chunk);
        remaining -= chunk as u64;
    }
    out
}

fn creality_crc32_table() -> &'static [u32; 256] {
    static TABLE: OnceLock<[u32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0u32; 256];
        for i in 0..256u32 {
            let mut c = i;
            for _ in 0..8 {
                c = if (c & 1) != 0 {
                    0xEDB8_8320 ^ (c >> 1)
                } else {
                    c >> 1
                };
            }
            table[i as usize] = c;
        }
        table
    })
}

/// Creality CXDLPV4 reflected CRC32 (`0xEDB88320`, initial `0`, no final XOR).
pub fn compute_creality_crc32(data: &[u8]) -> u32 {
    let table = creality_crc32_table();
    let mut crc: u32 = 0;
    for &b in data {
        crc = table[((crc ^ (b as u32)) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc
}

#[inline]
fn push_u16_le(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_le_bytes());
}

#[inline]
fn push_u32_le(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

#[inline]
fn push_f32_le(buf: &mut Vec<u8>, v: f32) {
    buf.extend_from_slice(&v.to_le_bytes());
}

#[inline]
fn push_u16_be(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_be_bytes());
}

#[inline]
fn push_u32_be(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_be_bytes());
}

fn write_preview_section(
    out: &mut Vec<u8>,
    width: u32,
    height: u32,
    rle_data: &[u8],
) -> Result<(), SlicerV3Error> {
    let img_addr = out
        .len()
        .checked_add(PREVIEW_HEADER_SIZE)
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| SlicerV3Error::UnsupportedOutput("Preview image offset overflow".to_string()))?;
    let rle_len = u32::try_from(rle_data.len())
        .map_err(|_| SlicerV3Error::UnsupportedOutput("Preview length overflow".to_string()))?;

    push_u32_le(out, width);
    push_u32_le(out, height);
    push_u32_le(out, img_addr);
    push_u32_le(out, rle_len);
    push_u32_le(out, 0);
    push_u32_le(out, 0);
    push_u32_le(out, 0);
    push_u32_le(out, 0);
    out.extend_from_slice(rle_data);
    Ok(())
}

/// Assembles a complete `.cxdlpv4` binary file buffer ready for writing to disk.
#[allow(clippy::too_many_arguments)]
pub fn build_cxdlpv4_container(
    width_px: u32,
    height_px: u32,
    meta: &CxdlpV4Metadata,
    small_preview_rle: &[u8],
    large_preview_rle: &[u8],
    encoded_layers: &[Vec<u8>],
    area_stats: &[LayerAreaStatsV3],
    print_time_sec: u32,
) -> Result<Vec<u8>, SlicerV3Error> {
    let layer_count = u32::try_from(encoded_layers.len())
        .map_err(|_| SlicerV3Error::UnsupportedOutput("Layer count overflow".to_string()))?;
    let res_x = u16::try_from(width_px)
        .map_err(|_| SlicerV3Error::InvalidDimensions { width: width_px, height: height_px })?;
    let res_y = u16::try_from(height_px)
        .map_err(|_| SlicerV3Error::InvalidDimensions { width: width_px, height: height_px })?;

    let machine_ascii = meta.machine_name.as_bytes();
    let model_len_with_nul = machine_ascii.len() + 1;
    let header_size = 99usize + model_len_with_nul;

    let preview_small_addr = header_size;
    let preview_large_addr = preview_small_addr + PREVIEW_HEADER_SIZE + small_preview_rle.len();
    let print_params_addr = preview_large_addr + PREVIEW_HEADER_SIZE + large_preview_rle.len();
    let slicer_info_addr = print_params_addr + PRINT_PARAMETERS_SIZE;
    let layer_def_table_addr = slicer_info_addr + SLICER_INFO_SIZE;

    let layer_blobs_total: usize = encoded_layers
        .iter()
        .map(|l| LAYER_DEF_EX_SIZE + l.len())
        .sum();
    let total_before_crc = layer_def_table_addr
        + (encoded_layers.len() * LAYER_DEF_SIZE)
        + layer_blobs_total;

    if u32::try_from(total_before_crc).is_err() {
        return Err(SlicerV3Error::UnsupportedOutput(
            ".cxdlpv4 output size exceeds 4 GiB 32-bit offset space".to_string(),
        ));
    }

    let pixel_area_mm2 = {
        let px_w = meta.bed_size_x_mm as f64 / width_px.max(1) as f64;
        let px_h = meta.bed_size_y_mm as f64 / height_px.max(1) as f64;
        px_w * px_h
    };
    let volume_mm3: f64 = area_stats
        .iter()
        .map(|s| s.total_solid_pixels as f64 * pixel_area_mm2 * meta.layer_height_mm as f64)
        .sum();
    let volume_ml = (volume_mm3 / 1000.0) as f32;
    let weight_g = volume_ml * meta.resin_density_g_ml;
    let cost_dollars = (volume_ml / 1000.0) * meta.resin_price_per_liter;

    let mut out = Vec::with_capacity(total_before_crc + 4);

    // 1. Header
    push_u32_be(&mut out, 9);
    out.extend_from_slice(b"CXSW3DV2\0");
    push_u16_be(&mut out, 4);
    push_u32_be(&mut out, model_len_with_nul as u32);
    out.extend_from_slice(machine_ascii);
    out.push(0);

    push_u16_le(&mut out, res_x);
    push_u16_le(&mut out, res_y);
    push_f32_le(&mut out, meta.bed_size_x_mm);
    push_f32_le(&mut out, meta.bed_size_y_mm);
    push_f32_le(&mut out, meta.bed_size_z_mm);
    push_f32_le(&mut out, meta.layer_height_mm * layer_count as f32);
    push_f32_le(&mut out, meta.layer_height_mm);
    push_u32_le(&mut out, meta.bottom_layer_count);
    push_u32_le(&mut out, preview_small_addr as u32);
    push_u32_le(&mut out, layer_def_table_addr as u32);
    push_u32_le(&mut out, layer_count);
    push_u32_le(&mut out, preview_large_addr as u32);
    push_u32_le(&mut out, print_time_sec);
    push_u32_le(&mut out, meta.projector_type);
    push_u32_le(&mut out, print_params_addr as u32);
    push_u32_le(&mut out, PRINT_PARAMETERS_SIZE as u32);
    push_u32_le(&mut out, meta.anti_alias_level);
    push_u16_le(&mut out, meta.light_pwm);
    push_u16_le(&mut out, meta.bottom_light_pwm);
    push_u32_le(&mut out, 0); // EncryptionKey = 0 (unencrypted)
    push_u32_le(&mut out, slicer_info_addr as u32);
    push_u32_le(&mut out, SLICER_INFO_SIZE as u32);

    debug_assert_eq!(out.len(), preview_small_addr);

    // 2. Small Preview (120x120) then Large Preview (300x300)
    write_preview_section(&mut out, SMALL_PREVIEW_WIDTH, SMALL_PREVIEW_HEIGHT, small_preview_rle)?;
    debug_assert_eq!(out.len(), preview_large_addr);

    write_preview_section(&mut out, LARGE_PREVIEW_WIDTH, LARGE_PREVIEW_HEIGHT, large_preview_rle)?;
    debug_assert_eq!(out.len(), print_params_addr);

    // 3. PrintParameters (68 bytes)
    push_f32_le(&mut out, meta.bottom_lift_height_mm + meta.bottom_lift_height2_mm);
    push_f32_le(&mut out, meta.bottom_lift_speed_mm_min);
    push_f32_le(&mut out, meta.lift_height_mm + meta.lift_height2_mm);
    push_f32_le(&mut out, meta.lift_speed_mm_min);
    push_f32_le(&mut out, meta.retract_speed_mm_min);
    push_f32_le(&mut out, volume_ml);
    push_f32_le(&mut out, weight_g);
    push_f32_le(&mut out, cost_dollars);
    push_f32_le(&mut out, meta.bottom_light_off_delay_sec);
    push_f32_le(&mut out, meta.light_off_delay_sec);
    push_u32_le(&mut out, meta.bottom_layer_count);
    push_f32_le(&mut out, meta.normal_exposure_sec);
    push_f32_le(&mut out, meta.bottom_exposure_sec);
    push_u32_le(&mut out, 0);
    push_u32_le(&mut out, 0);
    push_u32_le(&mut out, 0);
    push_u32_le(&mut out, 0);
    debug_assert_eq!(out.len(), slicer_info_addr);

    // 4. SlicerInfo (76 bytes)
    push_f32_le(&mut out, meta.bottom_lift_height2_mm);
    push_f32_le(&mut out, meta.bottom_lift_speed2_mm_min);
    push_f32_le(&mut out, meta.lift_height2_mm);
    push_f32_le(&mut out, meta.lift_speed2_mm_min);
    push_f32_le(&mut out, meta.retract_height2_mm);
    push_f32_le(&mut out, meta.retract_speed2_mm_min);
    push_f32_le(&mut out, meta.wait_time_after_lift_sec);
    push_u32_le(&mut out, 1); // PerLayerSettings = 1
    push_u32_le(&mut out, meta.modified_timestamp_minutes);
    push_u32_le(&mut out, meta.anti_alias_level);
    push_u32_le(&mut out, 0); // SoftwareVersion
    push_f32_le(&mut out, meta.wait_time_before_cure_sec);
    push_f32_le(&mut out, meta.wait_time_after_cure_sec);
    push_f32_le(&mut out, meta.normal_exposure_sec);
    push_f32_le(&mut out, meta.bottom_exposure_sec);
    push_f32_le(&mut out, meta.wait_time_after_lift_sec);
    push_u32_le(&mut out, meta.transition_layer_count);
    push_u32_le(&mut out, 0);
    push_u32_le(&mut out, 0);
    debug_assert_eq!(out.len(), layer_def_table_addr);

    // 5. LayerDef table (LayerCount * 40 bytes)
    let mut data_cursor = layer_def_table_addr + (encoded_layers.len() * LAYER_DEF_SIZE);
    let mut timings = Vec::with_capacity(encoded_layers.len());

    for (idx, rle) in encoded_layers.iter().enumerate() {
        let timing = compute_layer_timing(idx as u32, meta);
        let data_size = (LAYER_DEF_EX_SIZE + rle.len()) as u32;
        let largest_area_mm2 = area_stats
            .get(idx)
            .map(|s| s.largest_area_mm2 as f64)
            .unwrap_or(0.0);
        let largest_area_encoded = (largest_area_mm2 * 1000.0)
            .round()
            .max(0.0)
            .min(u32::MAX as f64) as u32;

        push_f32_le(&mut out, timing.position_z_mm);
        push_f32_le(&mut out, timing.exposure_sec);
        push_f32_le(&mut out, timing.light_off_sec);
        push_u32_le(&mut out, data_cursor as u32);
        push_u32_le(&mut out, data_size);
        push_u32_le(&mut out, 0); // DataType = 0
        push_u32_le(&mut out, 0); // CentroidDistance = 0
        push_u32_le(&mut out, largest_area_encoded);
        push_u32_le(&mut out, 0);
        push_u32_le(&mut out, 0);

        timings.push(timing);
        data_cursor += data_size as usize;
    }

    // 6. Per-layer blobs (`LayerDefEx` 44 bytes + RLE data)
    for (idx, rle) in encoded_layers.iter().enumerate() {
        let timing = timings[idx];
        push_f32_le(&mut out, timing.lift_height_mm + timing.lift_height2_mm);
        push_f32_le(&mut out, timing.lift_speed_mm_min);
        push_f32_le(&mut out, timing.lift_height2_mm);
        push_f32_le(&mut out, timing.lift_speed2_mm_min);
        push_f32_le(&mut out, timing.retract_speed_mm_min);
        push_f32_le(&mut out, timing.retract_height2_mm);
        push_f32_le(&mut out, timing.retract_speed2_mm_min);
        push_f32_le(&mut out, timing.rest_time_before_lift_sec);
        push_f32_le(&mut out, timing.rest_time_after_lift_sec);
        push_f32_le(&mut out, timing.rest_time_after_retract_sec);
        push_f32_le(&mut out, timing.light_pwm);
        out.extend_from_slice(rle);
    }

    debug_assert_eq!(out.len(), total_before_crc);

    // 7. Trailing Creality CRC32 checksum (4 bytes Big-Endian)
    let crc = compute_creality_crc32(&out);
    push_u32_be(&mut out, crc);

    Ok(out)
}
