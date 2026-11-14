//! Metadata extraction and print-time estimation for `.cxdlpv4` files.

use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

use super::cxdlpv4_types::{CxdlpLayerTiming, CxdlpV4Metadata};
use crate::types::SliceJobV3;

fn read_f32(node: Option<&Value>, keys: &[&str], default: f32) -> f32 {
    let Some(obj) = node.and_then(|v| v.as_object()) else {
        return default;
    };
    for key in keys {
        if let Some(val) = obj.get(*key).and_then(|v| v.as_f64()) {
            if val.is_finite() {
                return val as f32;
            }
        }
    }
    default
}

fn read_u32(node: Option<&Value>, keys: &[&str], default: u32) -> u32 {
    let Some(obj) = node.and_then(|v| v.as_object()) else {
        return default;
    };
    for key in keys {
        if let Some(val) = obj.get(*key) {
            if let Some(u) = val.as_u64() {
                return u.min(u32::MAX as u64) as u32;
            }
            if let Some(f) = val.as_f64() {
                if f.is_finite() && f >= 0.0 {
                    return (f.round() as u64).min(u32::MAX as u64) as u32;
                }
            }
        }
    }
    default
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

fn normalize_creality_machine_name(raw: Option<String>) -> String {
    let Some(name) = raw else {
        return "HALOT-R6".to_string();
    };
    let upper = name.trim().to_ascii_uppercase();
    if upper.contains("HALOT") && upper.contains("R6") {
        return "HALOT-R6".to_string();
    }
    name.trim().to_string()
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
    let ctb = root.and_then(|v| v.get("ctb"));
    let goo = root.and_then(|v| v.get("goo"));
    let export_cxdlpv4 = root
        .and_then(|v| v.get("export"))
        .and_then(|v| v.get("cxdlpv4"));

    // Machine identifier written into header (`HALOT-R6` validated by firmware).
    let explicit_machine = read_str(cxdlpv4, &["machineName", "printerModel"])
        .or_else(|| read_str(export_cxdlpv4, &["machineName", "printerModel"]))
        .or_else(|| read_str(printer, &["name", "model"]));
    meta.machine_name = normalize_creality_machine_name(explicit_machine);

    meta.bed_size_x_mm = job.build_width_mm.max(1.0);
    meta.bed_size_y_mm = job.build_depth_mm.max(1.0);
    let build_height_mm = read_f32(
        printer,
        &["buildHeightMm", "buildVolumeHeightMm", "bedSizeZMm"],
        0.0,
    );
    if build_height_mm > 1.0 {
        meta.bed_size_z_mm = build_height_mm;
    }

    meta.layer_height_mm = if job.layer_height_mm > 0.0 {
        job.layer_height_mm
    } else {
        read_f32(material, &["layerHeightMm"], 0.05).max(0.001)
    };

    meta.bottom_layer_count = read_u32(
        cxdlpv4,
        &["bottomLayerCount"],
        read_u32(material, &["bottomLayerCount"], meta.bottom_layer_count),
    );
    meta.transition_layer_count = read_u32(
        cxdlpv4,
        &["transitionLayerCount"],
        read_u32(
            ctb,
            &["transitionLayerCount"],
            read_u32(goo, &["transitionLayerCount"], 0),
        ),
    );

    meta.bottom_exposure_sec =
        read_f32(material, &["bottomExposureSec"], meta.bottom_exposure_sec).max(0.0);
    meta.normal_exposure_sec =
        read_f32(material, &["normalExposureSec"], meta.normal_exposure_sec).max(0.0);

    meta.bottom_lift_height_mm = read_f32(
        material,
        &["bottomLiftDistanceMm", "bottomLiftHeightMm"],
        meta.bottom_lift_height_mm,
    )
    .max(0.0);
    meta.bottom_lift_speed_mm_min = read_f32(
        material,
        &["bottomLiftSpeedMmMin"],
        meta.bottom_lift_speed_mm_min,
    )
    .max(0.0);
    meta.bottom_lift_height2_mm = read_f32(
        cxdlpv4,
        &["bottomLiftDistance2Mm"],
        read_f32(material, &["bottomLiftDistance2Mm"], 0.0),
    )
    .max(0.0);
    meta.bottom_lift_speed2_mm_min = read_f32(
        cxdlpv4,
        &["bottomLiftSpeed2MmMin"],
        read_f32(material, &["bottomLiftSpeed2MmMin"], 0.0),
    )
    .max(0.0);
    meta.bottom_retract_speed_mm_min = read_f32(
        material,
        &["bottomRetractSpeedMmMin", "retractSpeedMmMin"],
        meta.bottom_retract_speed_mm_min,
    )
    .max(0.0);

    meta.lift_height_mm =
        read_f32(material, &["liftDistanceMm", "liftHeightMm"], meta.lift_height_mm).max(0.0);
    meta.lift_speed_mm_min =
        read_f32(material, &["liftSpeedMmMin"], meta.lift_speed_mm_min).max(0.0);
    meta.lift_height2_mm = read_f32(
        cxdlpv4,
        &["liftDistance2Mm"],
        read_f32(material, &["liftDistance2Mm"], 0.0),
    )
    .max(0.0);
    meta.lift_speed2_mm_min = read_f32(
        cxdlpv4,
        &["liftSpeed2MmMin"],
        read_f32(material, &["liftSpeed2MmMin"], 0.0),
    )
    .max(0.0);

    meta.retract_speed_mm_min =
        read_f32(material, &["retractSpeedMmMin"], meta.retract_speed_mm_min).max(0.0);
    meta.retract_height2_mm = read_f32(
        cxdlpv4,
        &["retractDistance2Mm"],
        read_f32(material, &["retractDistance2Mm"], 0.0),
    )
    .max(0.0);
    meta.retract_speed2_mm_min = read_f32(
        cxdlpv4,
        &["retractSpeed2MmMin"],
        read_f32(material, &["retractSpeed2MmMin"], 0.0),
    )
    .max(0.0);

    meta.wait_time_before_cure_sec = read_f32(
        cxdlpv4,
        &["waitTimeBeforeCureSec"],
        read_f32(goo, &["waitTimeBeforeCureSec"], 0.0),
    )
    .max(0.0);
    meta.wait_time_after_cure_sec = read_f32(
        cxdlpv4,
        &["waitTimeAfterCureSec"],
        read_f32(goo, &["waitTimeAfterCureSec"], 0.0),
    )
    .max(0.0);
    meta.wait_time_after_lift_sec = read_f32(
        cxdlpv4,
        &["waitTimeAfterLiftSec"],
        read_f32(goo, &["waitTimeAfterLiftSec"], 0.0),
    )
    .max(0.0);

    let explicit_light_off = read_f32(cxdlpv4, &["lightOffDelaySec"], -1.0);
    meta.light_off_delay_sec = if explicit_light_off >= 0.0 {
        explicit_light_off
    } else if meta.wait_time_before_cure_sec > 0.0 {
        meta.wait_time_before_cure_sec
    } else {
        1.0
    };

    let explicit_bottom_light_off = read_f32(cxdlpv4, &["bottomLightOffDelaySec"], -1.0);
    meta.bottom_light_off_delay_sec = if explicit_bottom_light_off >= 0.0 {
        explicit_bottom_light_off
    } else {
        meta.light_off_delay_sec
    };

    let pwm_percent = read_f32(
        cxdlpv4,
        &["projectorPwmPercent"],
        read_f32(goo, &["projectorPwmPercent"], 100.0),
    );
    meta.light_pwm = pwm_percent_to_u16(pwm_percent);

    let bottom_pwm_percent = read_f32(
        cxdlpv4,
        &["bottomProjectorPwmPercent"],
        pwm_percent,
    );
    meta.bottom_light_pwm = pwm_percent_to_u16(bottom_pwm_percent);

    meta.anti_alias_level = read_u32(
        cxdlpv4,
        &["antiAliasingLevel", "antiAliasLevel"],
        read_u32(ctb, &["antiAliasLevel"], 1),
    )
    .clamp(1, 16);

    meta.resin_density_g_ml = read_f32(
        resin,
        &["densityGMl", "density"],
        read_f32(material, &["resinDensityGMl"], 1.1),
    )
    .max(0.01);
    meta.resin_price_per_liter = read_f32(
        resin,
        &["pricePerLiter", "costPerLiter"],
        read_f32(material, &["resinCostPerLiter"], 0.0),
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
