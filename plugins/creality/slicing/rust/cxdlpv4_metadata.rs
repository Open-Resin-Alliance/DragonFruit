//! Metadata extraction and print-time estimation for `.cxdlpv4` files.

use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

use super::cxdlpv4_types::{CxdlpLayerTiming, CxdlpV4Metadata};
use crate::types::SliceJobV3;

fn read_opt_f32(node: Option<&Value>, keys: &[&str]) -> Option<f32> {
    let obj = node.and_then(|v| v.as_object())?;
    for key in keys {
        if let Some(val) = obj.get(*key).and_then(|v| v.as_f64()) {
            if val.is_finite() {
                return Some(val as f32);
            }
        }
    }
    None
}

fn read_f32(node: Option<&Value>, keys: &[&str], default: f32) -> f32 {
    read_opt_f32(node, keys).unwrap_or(default)
}

fn read_opt_u32(node: Option<&Value>, keys: &[&str]) -> Option<u32> {
    let obj = node.and_then(|v| v.as_object())?;
    for key in keys {
        if let Some(val) = obj.get(*key) {
            if let Some(u) = val.as_u64() {
                return Some(u.min(u32::MAX as u64) as u32);
            }
            if let Some(f) = val.as_f64() {
                if f.is_finite() && f >= 0.0 {
                    return Some((f.round() as u64).min(u32::MAX as u64) as u32);
                }
            }
        }
    }
    None
}

fn read_str(node: Option<&Value>, keys: &[&str]) -> Option<String> {
    let obj = node.and_then(|v| v.as_object())?;
    for key in keys {
        if let Some(s) = obj.get(*key).and_then(|v| v.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn pwm_percent_to_u16(percent: f32) -> u16 {
    let clamped = percent.clamp(0.0, 100.0);
    ((clamped / 100.0) * 255.0).round().clamp(0.0, 255.0) as u16
}

fn read_scoped_f32(primary: Option<&Value>, secondary: Option<&Value>, fallback: Option<&Value>, keys: &[&str], default: f32) -> f32 {
    read_opt_f32(primary, keys)
        .or_else(|| read_opt_f32(secondary, keys))
        .or_else(|| read_opt_f32(fallback, keys))
        .unwrap_or(default)
}

fn read_scoped_u32(primary: Option<&Value>, secondary: Option<&Value>, fallback: Option<&Value>, keys: &[&str], default: u32) -> u32 {
    read_opt_u32(primary, keys)
        .or_else(|| read_opt_u32(secondary, keys))
        .or_else(|| read_opt_u32(fallback, keys))
        .unwrap_or(default)
}

pub fn extract_cxdlpv4_metadata(job: &SliceJobV3) -> CxdlpV4Metadata {
    let mut meta = CxdlpV4Metadata::default();

    let parsed: Option<Value> = if job.metadata_json.trim().is_empty() {
        None
    } else {
        serde_json::from_str::<Value>(&job.metadata_json).ok()
    };

    let root = parsed.as_ref();
    let printer = root.and_then(|v| v.get("printer"));
    let material = root.and_then(|v| v.get("material"));
    let resin = root.and_then(|v| v.get("resin"));
    let cxdlpv4 = root.and_then(|v| v.get("cxdlpv4"));
    let export_cxdlpv4 = root
        .and_then(|v| v.get("export"))
        .and_then(|v| v.get("cxdlpv4"));

    if let Some(name) = read_str(cxdlpv4, &["machineName", "printerModel"])
        .or_else(|| read_str(export_cxdlpv4, &["machineName", "printerModel"]))
        .or_else(|| read_str(printer, &["machineName", "name", "model"]))
    {
        meta.machine_name = name;
    }

    meta.bed_size_x_mm = job.build_width_mm.max(1.0);
    meta.bed_size_y_mm = job.build_depth_mm.max(1.0);
    let build_height_mm = read_opt_f32(cxdlpv4, &["bedSizeZMm", "buildHeightMm"])
        .or_else(|| read_opt_f32(export_cxdlpv4, &["bedSizeZMm", "buildHeightMm"]))
        .or_else(|| {
            printer
                .and_then(|p| p.get("buildVolumeMm"))
                .and_then(|bv| bv.get("height"))
                .and_then(Value::as_f64)
                .map(|v| v as f32)
        })
        .or_else(|| read_opt_f32(printer, &["buildHeightMm", "buildVolumeHeightMm", "bedSizeZMm"]))
        .unwrap_or_else(|| (job.layer_height_mm.max(0.0) * job.total_layers as f32).max(1.0));
    if build_height_mm.is_finite() && build_height_mm > 0.0 {
        meta.bed_size_z_mm = build_height_mm;
    }

    meta.layer_height_mm = if job.layer_height_mm > 0.0 {
        job.layer_height_mm
    } else {
        read_f32(material, &["layerHeightMm"], 0.05).max(0.001)
    };

    meta.bottom_layer_count = read_scoped_u32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["bottomLayerCount"],
        meta.bottom_layer_count,
    );
    meta.transition_layer_count = read_scoped_u32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["transitionLayerCount"],
        0,
    );

    meta.bottom_exposure_sec = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["bottomExposureSec"],
        meta.bottom_exposure_sec,
    )
    .max(0.0);
    meta.normal_exposure_sec = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["normalExposureSec"],
        meta.normal_exposure_sec,
    )
    .max(0.0);

    meta.bottom_lift_height_mm = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["bottomLiftDistanceMm", "bottomLiftHeightMm"],
        meta.bottom_lift_height_mm,
    )
    .max(0.0);
    meta.bottom_lift_speed_mm_min = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["bottomLiftSpeedMmMin"],
        meta.bottom_lift_speed_mm_min,
    )
    .max(0.0);
    meta.bottom_lift_height2_mm = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["bottomLiftDistance2Mm"],
        0.0,
    )
    .max(0.0);
    meta.bottom_lift_speed2_mm_min = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["bottomLiftSpeed2MmMin"],
        0.0,
    )
    .max(0.0);
    meta.bottom_retract_speed_mm_min = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["bottomRetractSpeedMmMin", "retractSpeedMmMin"],
        meta.bottom_retract_speed_mm_min,
    )
    .max(0.0);

    meta.lift_height_mm = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["liftDistanceMm", "liftHeightMm"],
        meta.lift_height_mm,
    )
    .max(0.0);
    meta.lift_speed_mm_min = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["liftSpeedMmMin"],
        meta.lift_speed_mm_min,
    )
    .max(0.0);
    meta.lift_height2_mm = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["liftDistance2Mm"],
        0.0,
    )
    .max(0.0);
    meta.lift_speed2_mm_min = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["liftSpeed2MmMin"],
        0.0,
    )
    .max(0.0);

    meta.retract_speed_mm_min = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["retractSpeedMmMin"],
        meta.retract_speed_mm_min,
    )
    .max(0.0);
    meta.retract_height2_mm = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["retractDistance2Mm"],
        0.0,
    )
    .max(0.0);
    meta.retract_speed2_mm_min = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["retractSpeed2MmMin"],
        0.0,
    )
    .max(0.0);

    meta.wait_time_before_cure_sec = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["waitTimeBeforeCureSec"],
        0.0,
    )
    .max(0.0);
    meta.wait_time_after_cure_sec = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["waitTimeAfterCureSec"],
        0.0,
    )
    .max(0.0);
    meta.wait_time_after_lift_sec = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        material,
        &["waitTimeAfterLiftSec"],
        0.0,
    )
    .max(0.0);

    let explicit_light_off = read_opt_f32(cxdlpv4, &["lightOffDelaySec"])
        .or_else(|| read_opt_f32(export_cxdlpv4, &["lightOffDelaySec"]));
    meta.light_off_delay_sec = match explicit_light_off {
        Some(v) if v >= 0.0 => v,
        _ if meta.wait_time_before_cure_sec > 0.0 => meta.wait_time_before_cure_sec,
        _ => 1.0,
    };

    let explicit_bottom_light_off = read_opt_f32(cxdlpv4, &["bottomLightOffDelaySec"])
        .or_else(|| read_opt_f32(export_cxdlpv4, &["bottomLightOffDelaySec"]));
    meta.bottom_light_off_delay_sec = match explicit_bottom_light_off {
        Some(v) if v >= 0.0 => v,
        _ => meta.light_off_delay_sec,
    };

    let pwm_percent = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        None,
        &["projectorPwmPercent"],
        100.0,
    );
    meta.light_pwm = pwm_percent_to_u16(pwm_percent);

    let bottom_pwm_percent = read_scoped_f32(
        cxdlpv4,
        export_cxdlpv4,
        None,
        &["bottomProjectorPwmPercent"],
        pwm_percent,
    );
    meta.bottom_light_pwm = pwm_percent_to_u16(bottom_pwm_percent);

    let job_aa_steps = (job.configured_xy_aa_steps() as u32).max(1).clamp(1, 16);
    meta.anti_alias_level = read_opt_u32(cxdlpv4, &["antiAliasingLevel", "antiAliasLevel"])
        .or_else(|| read_opt_u32(export_cxdlpv4, &["antiAliasingLevel", "antiAliasLevel"]))
        .unwrap_or(job_aa_steps)
        .clamp(1, 16);

    let settings_mode = read_str(cxdlpv4, &["settingsMode", "mode"])
        .or_else(|| read_str(export_cxdlpv4, &["settingsMode", "mode"]))
        .or_else(|| read_str(printer, &["settingsMode", "mode"]))
        .map(|s| s.to_ascii_lowercase());
    let has_two_stage_motion = meta.bottom_lift_height2_mm > 0.0
        || meta.bottom_lift_speed2_mm_min > 0.0
        || meta.lift_height2_mm > 0.0
        || meta.lift_speed2_mm_min > 0.0
        || meta.retract_height2_mm > 0.0
        || meta.retract_speed2_mm_min > 0.0;
    meta.per_layer_settings = match settings_mode.as_deref() {
        Some("simple") => false,
        Some("twostage") | Some("allfields") => true,
        _ => has_two_stage_motion || meta.transition_layer_count > 0,
    };

    meta.resin_density_g_ml = read_scoped_f32(
        resin,
        material,
        cxdlpv4,
        &["densityGMl", "density", "resinDensityGMl", "resinDensity"],
        1.1,
    )
    .max(0.01);
    meta.resin_price_per_liter = read_scoped_f32(
        resin,
        material,
        cxdlpv4,
        &["pricePerLiter", "costPerLiter", "resinCostPerLiter"],
        0.0,
    )
    .max(0.0);

    meta.modified_timestamp_minutes = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 60).min(u32::MAX as u64) as u32)
        .unwrap_or(0);

    meta
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t.clamp(0.0, 1.0)
}

/// Computes per-layer timing & motion values, interpolating smoothly across transition layers.
pub fn compute_layer_timing(layer_index: u32, meta: &CxdlpV4Metadata) -> CxdlpLayerTiming {
    let is_bottom = layer_index < meta.bottom_layer_count;
    let position_z_mm = (layer_index + 1) as f32 * meta.layer_height_mm;

    let exposure_sec = if is_bottom {
        meta.bottom_exposure_sec
    } else if meta.transition_layer_count > 0 {
        let trans_idx = layer_index.saturating_sub(meta.bottom_layer_count);
        if trans_idx < meta.transition_layer_count {
            let t = (trans_idx + 1) as f32 / (meta.transition_layer_count + 1) as f32;
            lerp(meta.bottom_exposure_sec, meta.normal_exposure_sec, t)
        } else {
            meta.normal_exposure_sec
        }
    } else {
        meta.normal_exposure_sec
    };

    let (light_off_sec, lift_height_mm, lift_speed_mm_min, lift_height2_mm, lift_speed2_mm_min, retract_speed_mm_min, light_pwm) =
        if is_bottom {
            (
                meta.bottom_light_off_delay_sec,
                meta.bottom_lift_height_mm,
                meta.bottom_lift_speed_mm_min,
                meta.bottom_lift_height2_mm,
                meta.bottom_lift_speed2_mm_min,
                meta.bottom_retract_speed_mm_min,
                meta.bottom_light_pwm as f32,
            )
        } else {
            (
                meta.light_off_delay_sec,
                meta.lift_height_mm,
                meta.lift_speed_mm_min,
                meta.lift_height2_mm,
                meta.lift_speed2_mm_min,
                meta.retract_speed_mm_min,
                meta.light_pwm as f32,
            )
        };

    CxdlpLayerTiming {
        position_z_mm,
        exposure_sec,
        light_off_sec,
        lift_height_mm,
        lift_speed_mm_min,
        lift_height2_mm,
        lift_speed2_mm_min,
        retract_speed_mm_min,
        retract_height2_mm: meta.retract_height2_mm,
        retract_speed2_mm_min: meta.retract_speed2_mm_min,
        rest_time_before_lift_sec: meta.wait_time_after_cure_sec,
        rest_time_after_lift_sec: meta.wait_time_after_lift_sec,
        rest_time_after_retract_sec: meta.wait_time_before_cure_sec,
        light_pwm,
    }
}

/// Estimates total print time in whole seconds.
pub fn estimate_print_time_sec(layer_count: u32, meta: &CxdlpV4Metadata) -> u32 {
    let mut total_sec = 0.0f64;
    for i in 0..layer_count {
        let t = compute_layer_timing(i, meta);
        let lift1_sec = if t.lift_speed_mm_min > 0.0 {
            (t.lift_height_mm as f64 / t.lift_speed_mm_min as f64) * 60.0
        } else {
            0.0
        };
        let lift2_sec = if t.lift_speed2_mm_min > 0.0 {
            (t.lift_height2_mm as f64 / t.lift_speed2_mm_min as f64) * 60.0
        } else {
            0.0
        };
        let total_lift_dist = t.lift_height_mm + t.lift_height2_mm;
        let retract_dist = (total_lift_dist - meta.layer_height_mm).max(0.0);
        let retract_sec = if t.retract_speed_mm_min > 0.0 {
            (retract_dist as f64 / t.retract_speed_mm_min as f64) * 60.0
        } else {
            0.0
        };
        let wait_sec = t
            .light_off_sec
            .max(t.rest_time_before_lift_sec + t.rest_time_after_lift_sec + t.rest_time_after_retract_sec)
            as f64;
        total_sec += t.exposure_sec as f64 + lift1_sec + lift2_sec + retract_sec + wait_sec;
    }
    total_sec.round().max(0.0).min(u32::MAX as f64) as u32
}
