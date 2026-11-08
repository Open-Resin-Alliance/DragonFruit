//! Sparse, field-wise overrides for inclusive printed-layer ranges.
//!
//! Parsed values stay f64 until a format writes its existing f32 records.

use crate::{SliceJobV3, SlicerV3Error};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};

// Keep the wire whitelist, enum order and patch access in one place.
macro_rules! setting_fields {
    ($( $variant:ident => $field:ident => $wire:literal ),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum LayerSettingField { $( $variant, )+ }

        impl LayerSettingField {
            pub const ALL: [Self; 14] = [$( Self::$variant, )+];

            pub const fn as_str(self) -> &'static str {
                match self { $( Self::$variant => $wire, )+ }
            }
        }

        #[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub struct LayerPrintSettingsPatch {
            $( #[serde(skip_serializing_if = "Option::is_none")]
               pub $field: Option<f64>, )+
        }

        impl LayerPrintSettingsPatch {
            pub fn get(&self, field: LayerSettingField) -> Option<f64> {
                match field { $( LayerSettingField::$variant => self.$field, )+ }
            }

            fn set(&mut self, field: LayerSettingField, value: f64) {
                match field { $( LayerSettingField::$variant => self.$field = Some(value), )+ }
            }
        }
    };
}

setting_fields! {
    ExposureSec => exposure_sec => "exposureSec",
    LightOffDelaySec => light_off_delay_sec => "lightOffDelaySec",
    WaitTimeBeforeCureSec => wait_time_before_cure_sec => "waitTimeBeforeCureSec",
    WaitTimeAfterCureSec => wait_time_after_cure_sec => "waitTimeAfterCureSec",
    WaitTimeAfterLiftSec => wait_time_after_lift_sec => "waitTimeAfterLiftSec",
    LiftHeightMm => lift_height_mm => "liftHeightMm",
    LiftHeight2Mm => lift_height2_mm => "liftHeight2Mm",
    LiftSpeedMmMin => lift_speed_mm_min => "liftSpeedMmMin",
    LiftSpeed2MmMin => lift_speed2_mm_min => "liftSpeed2MmMin",
    RetractHeightMm => retract_height_mm => "retractHeightMm",
    RetractHeight2Mm => retract_height2_mm => "retractHeight2Mm",
    RetractSpeedMmMin => retract_speed_mm_min => "retractSpeedMmMin",
    RetractSpeed2MmMin => retract_speed2_mm_min => "retractSpeed2MmMin",
    LightPwm => light_pwm => "lightPwm",
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerSettingsRange {
    pub id: String,
    #[serde(deserialize_with = "deserialize_layer_number")]
    pub start_layer: u32,
    #[serde(deserialize_with = "deserialize_layer_number")]
    pub end_layer: u32,
    pub settings: LayerPrintSettingsPatch,
}

// JSON 1 and 1.0 are the same valid integer at the TS boundary. The subtree
// validator checks bounds before serde reaches this conversion.
fn deserialize_layer_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if value.is_finite() && value.fract() == 0.0 && (1.0..=u32::MAX as f64).contains(&value) {
        Ok(value as u32)
    } else {
        Err(serde::de::Error::custom("expected a printed layer in 1..4294967295"))
    }
}

/// One nonempty patch interval. Endpoints are inclusive, one-based printed layers.
#[derive(Debug, Clone, PartialEq)]
pub struct LayerSettingsSegment {
    pub start_layer: u32,
    pub end_layer: u32,
    pub settings: LayerPrintSettingsPatch,
    /// Original array index of the highest-priority matching range overall.
    pub range_index: usize,
}

#[derive(Debug, Default)]
pub struct LayerSettingsSchedule {
    segments: Vec<LayerSettingsSegment>,
    originally_nonempty: bool,
}

impl LayerSettingsSchedule {
    /// Validate metadata and all supplied capabilities before clipping to the job.
    /// No metadata parsing or allocation is needed when looking up layer records.
    pub fn from_job(
        job: &SliceJobV3,
        supported_fields: &[LayerSettingField],
    ) -> Result<Self, SlicerV3Error> {
        let ranges = parse_ranges(&job.metadata_json)?;
        for range in &ranges {
            for field in LayerSettingField::ALL {
                if range.settings.get(field).is_some() && !supported_fields.contains(&field) {
                    return Err(SlicerV3Error::UnsupportedOutput(format!(
                        "{} cannot encode layer setting {}", job.output_format, field.as_str()
                    )));
                }
            }
        }
        Ok(Self {
            segments: compile_ranges(&ranges, job.total_layers),
            originally_nonempty: !ranges.is_empty(),
        })
    }

    /// True only when the original array was empty, not when it lies beyond EOF.
    pub fn is_empty(&self) -> bool {
        !self.originally_nonempty
    }

    pub fn segments(&self) -> &[LayerSettingsSegment] {
        &self.segments
    }

    /// Encoder indices are zero-based; stored printed-layer endpoints are not.
    pub fn patch_at(&self, layer_index: u32) -> Option<&LayerPrintSettingsPatch> {
        let layer = u64::from(layer_index) + 1;
        let next = self.segments.partition_point(|segment| u64::from(segment.start_layer) <= layer);
        let segment = self.segments.get(next.checked_sub(1)?)?;
        (layer <= u64::from(segment.end_layer)).then_some(&segment.settings)
    }
}

/// Reject schedules before raster/sink initialization when an encoder cannot apply them.
/// Supporting encoders perform field/version validation once during finalization.
pub fn ensure_layer_settings_supported(
    encoder: &dyn crate::encoders::FormatEncoder,
    job: &SliceJobV3,
) -> Result<(), SlicerV3Error> {
    if encoder.supports_layer_settings() {
        return Ok(());
    }
    if !parse_ranges(&job.metadata_json)?.is_empty() {
        return Err(SlicerV3Error::UnsupportedOutput(format!(
            "{} does not support per-layer settings", job.output_format
        )));
    }
    Ok(())
}

fn invalid(reason: impl Into<String>) -> SlicerV3Error {
    SlicerV3Error::InvalidLayerSettingsRanges(reason.into())
}

fn parse_ranges(metadata: &str) -> Result<Vec<LayerSettingsRange>, SlicerV3Error> {
    if metadata.trim().is_empty() {
        return Ok(Vec::new());
    }
    let root: Value = serde_json::from_str(metadata)
        .map_err(|error| invalid(format!("metadata must be valid JSON: {error}")))?;
    let object = root.as_object().ok_or_else(|| invalid("metadata must be an object"))?;
    let Some(value) = object.get("layerSettingsRanges") else {
        return Ok(Vec::new());
    };
    let array = value.as_array().ok_or_else(|| invalid("expected an array"))?;
    let mut ids = HashSet::with_capacity(array.len());
    for (index, value) in array.iter().enumerate() {
        let range = value.as_object()
            .ok_or_else(|| invalid(format!("range {index} must be an object")))?;
        for key in range.keys() {
            if !["id", "startLayer", "endLayer", "settings"].contains(&key.as_str()) {
                return Err(invalid(format!("range {index} has unknown key {key}")));
            }
        }
        for key in ["id", "startLayer", "endLayer", "settings"] {
            if !range.contains_key(key) {
                return Err(invalid(format!("range {index} must have own {key}")));
            }
        }
        let id = range["id"].as_str().filter(|id| !id.is_empty())
            .ok_or_else(|| invalid(format!("range {index} id must be a nonempty string")))?;
        if !ids.insert(id) {
            return Err(invalid(format!("duplicate id {id}")));
        }
        for key in ["startLayer", "endLayer"] {
            let valid = range[key].as_f64().is_some_and(|number| {
                number.is_finite() && number.fract() == 0.0
                    && (1.0..=u32::MAX as f64).contains(&number)
            });
            if !valid {
                return Err(invalid(format!("range {index} {key} must be an integer in 1..4294967295")));
            }
        }
        if range["startLayer"].as_f64() > range["endLayer"].as_f64() {
            return Err(invalid(format!("range {index} startLayer must not exceed endLayer")));
        }
        let settings = range["settings"].as_object()
            .ok_or_else(|| invalid(format!("range {index} settings must be an object")))?;
        for key in settings.keys() {
            if !LayerSettingField::ALL.iter().any(|field| field.as_str() == key) {
                return Err(invalid(format!("range {index} settings has unknown key {key}")));
            }
        }
        if settings.is_empty() {
            return Err(invalid(format!("range {index} settings must supply at least one field")));
        }
        for field in LayerSettingField::ALL {
            let Some(value) = settings.get(field.as_str()) else { continue };
            let number = value.as_f64().filter(|number| {
                number.is_finite() && *number >= 0.0 && *number <= f64::from(f32::MAX)
            }).ok_or_else(|| invalid(format!(
                "range {index} {} must be a finite number in 0..f32::MAX", field.as_str()
            )))?;
            if field == LayerSettingField::LightPwm && (number.fract() != 0.0 || number > 255.0) {
                return Err(invalid(format!("range {index} lightPwm must be an integer in 0..255")));
            }
        }
    }
    // Borrow the validated Value instead of cloning the entire JSON subtree.
    let mut ranges = Vec::<LayerSettingsRange>::deserialize(value)
        .map_err(|error| invalid(error.to_string()))?;
    for range in &mut ranges {
        for field in LayerSettingField::ALL {
            if range.settings.get(field) == Some(0.0) {
                range.settings.set(field, 0.0);
            }
        }
    }
    Ok(ranges)
}

// BinaryHeap is max-first: reverse span, then prefer the later original index.
type Priority = (Reverse<u64>, usize);

fn current(heap: &mut BinaryHeap<Priority>, active: &[bool]) -> Option<usize> {
    while heap.peek().is_some_and(|entry| !active[entry.1]) {
        heap.pop();
    }
    heap.peek().map(|entry| entry.1)
}

fn compile_ranges(ranges: &[LayerSettingsRange], total_layers: u32) -> Vec<LayerSettingsSegment> {
    // End events sort before start events at the same coordinate. u64 represents
    // u32::MAX + 1 without overflowing, even at the last possible printed layer.
    let mut events = Vec::with_capacity(ranges.len() * 2);
    for (index, range) in ranges.iter().enumerate() {
        if range.start_layer <= total_layers {
            events.push((u64::from(range.start_layer), true, index));
            events.push((u64::from(range.end_layer.min(total_layers)) + 1, false, index));
        }
    }
    events.sort_unstable();
    let mut active = vec![false; ranges.len()];
    let mut display = BinaryHeap::new();
    let mut fields: [BinaryHeap<Priority>; 14] = std::array::from_fn(|_| BinaryHeap::new());
    let mut segments: Vec<LayerSettingsSegment> = Vec::new();
    let mut cursor = 0;
    while cursor < events.len() {
        let coordinate = events[cursor].0;
        while cursor < events.len() && events[cursor].0 == coordinate {
            let (_, starting, index) = events[cursor];
            active[index] = starting;
            if starting {
                let range = &ranges[index];
                let priority = (Reverse(u64::from(range.end_layer) - u64::from(range.start_layer) + 1), index);
                display.push(priority);
                for (field_index, field) in LayerSettingField::ALL.iter().enumerate() {
                    if range.settings.get(*field).is_some() {
                        fields[field_index].push(priority);
                    }
                }
            }
            cursor += 1;
        }
        let Some(next) = events.get(cursor).map(|event| event.0) else { break };
        let Some(range_index) = current(&mut display, &active) else { continue };
        let mut settings = LayerPrintSettingsPatch::default();
        for (field_index, field) in LayerSettingField::ALL.iter().enumerate() {
            if let Some(index) = current(&mut fields[field_index], &active) {
                if let Some(value) = ranges[index].settings.get(*field) {
                    settings.set(*field, value);
                }
            }
        }
        let start_layer = coordinate as u32;
        let end_layer = (next - 1) as u32;
        if let Some(previous) = segments.last_mut() {
            if u64::from(previous.end_layer) + 1 == coordinate
                && previous.range_index == range_index && previous.settings == settings
            {
                previous.end_layer = end_layer;
                continue;
            }
        }
        segments.push(LayerSettingsSegment { start_layer, end_layer, settings, range_index });
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn job(ranges: Value, total_layers: u32) -> SliceJobV3 {
        SliceJobV3 {
            output_format: "goo".into(),
            total_layers,
            metadata_json: json!({"layerSettingsRanges": ranges}).to_string(),
            ..Default::default()
        }
    }

    fn range(id: &str, start: u32, end: u32, settings: Value) -> Value {
        json!({"id": id, "startLayer": start, "endLayer": end, "settings": settings})
    }

    fn schedule(ranges: Value, total: u32) -> LayerSettingsSchedule {
        LayerSettingsSchedule::from_job(&job(ranges, total), &LayerSettingField::ALL).unwrap()
    }

    fn fixture() -> Value {
        json!([
            range("A", 3, 10, json!({"exposureSec": 4, "liftHeightMm": 8})),
            range("B", 5, 6, json!({"exposureSec": 7})),
            range("C", 6, 7, json!({"exposureSec": 9}))
        ])
    }

    #[test]
    fn layer_settings_ranges_abc_sparse_inheritance_and_edit_order() {
        let resolved = schedule(fixture(), 12);
        let exposures: Vec<f64> = (0..12).map(|index| {
            resolved.patch_at(index).and_then(|patch| patch.exposure_sec)
                .unwrap_or(if index < 2 { 10.0 } else { 2.0 })
        }).collect();
        assert_eq!(exposures, [10., 10., 4., 4., 7., 9., 9., 4., 4., 4., 2., 2.]);
        for index in 2..10 {
            assert_eq!(resolved.patch_at(index).unwrap().lift_height_mm, Some(8.0));
        }
        assert_eq!(resolved.segments()[2].range_index, 2);
        let mut edited = fixture();
        edited[1]["settings"]["exposureSec"] = json!(11);
        assert_eq!(schedule(edited, 12).patch_at(5).unwrap().exposure_sec, Some(9.0));
        let mut deleted = fixture();
        deleted.as_array_mut().unwrap().pop();
        let deleted = schedule(deleted, 12);
        assert_eq!(deleted.patch_at(5).unwrap().exposure_sec, Some(7.0));
        assert_eq!(deleted.patch_at(6).unwrap().exposure_sec, Some(4.0));
    }

    #[test]
    fn layer_settings_ranges_original_width_and_field_specific_priority() {
        let result = schedule(json!([
            range("wide", 1, 100, json!({"exposureSec": 4, "liftHeightMm": 8, "waitTimeAfterLiftSec": 3})),
            range("medium", 1, 10, json!({"exposureSec": 7, "liftHeightMm": 6})),
            range("narrow", 2, 3, json!({"exposureSec": 9}))
        ]), 5);
        assert_eq!(result.patch_at(0).unwrap().exposure_sec, Some(7.0));
        let patch = result.patch_at(1).unwrap();
        assert_eq!(patch.exposure_sec, Some(9.0));
        assert_eq!(patch.lift_height_mm, Some(6.0));
        assert_eq!(patch.wait_time_after_lift_sec, Some(3.0));
    }

    #[test]
    fn layer_settings_ranges_touching_overlap_single_first_last_and_gaps() {
        let result = schedule(json!([
            range("first", 1, 1, json!({"exposureSec": 1})),
            range("left", 2, 3, json!({"exposureSec": 2})),
            range("right", 4, 5, json!({"exposureSec": 3})),
            range("overlap", 5, 6, json!({"exposureSec": 4})),
            range("last", 8, 8, json!({"exposureSec": 5}))
        ]), 8);
        let actual: Vec<Option<f64>> = (0..8)
            .map(|index| result.patch_at(index).and_then(|patch| patch.exposure_sec)).collect();
        assert_eq!(actual, [Some(1.), Some(2.), Some(2.), Some(3.), Some(4.), Some(4.), None, Some(5.)]);
        assert!(result.patch_at(8).is_none());
    }

    #[test]
    fn layer_settings_ranges_unsupported_encoder_rejects_before_destination_creation() {
        let encoder = crate::encoders::registry::find_encoder(".nanodlp").unwrap();
        let mut job = job(json!([range("beyond", 20, 30, json!({"exposureSec": 4}))]), 12);
        job.output_format = ".nanodlp".into();
        let error = ensure_layer_settings_supported(encoder, &job).unwrap_err();
        assert!(matches!(&error, SlicerV3Error::UnsupportedOutput(details)
            if details == ".nanodlp does not support per-layer settings"));
        let path = std::env::temp_dir().join(format!("layer-settings-unsupported-{}.nanodlp", std::process::id()));
        std::fs::write(&path, b"existing destination").unwrap();
        let result = crate::engine::dispatch_encode_by_format_to_path(
            &job, &crate::types::RenderedLayersV3::default(), &[], &path, None,
        );
        assert!(matches!(result, Err(SlicerV3Error::UnsupportedOutput(_))));
        assert_eq!(std::fs::read(&path).unwrap(), b"existing destination");
        std::fs::remove_file(&path).unwrap();
        let result = crate::engine::dispatch_encode_by_format_to_path(
            &job, &crate::types::RenderedLayersV3::default(), &[], &path, None,
        );
        assert!(matches!(result, Err(SlicerV3Error::UnsupportedOutput(_))));
        assert!(!path.exists());
        for metadata in ["", "{}", "{\"layerSettingsRanges\":[]}"] {
            job.metadata_json = metadata.into();
            ensure_layer_settings_supported(encoder, &job).unwrap();
        }
        job.metadata_json = "{\"layerSettingsRanges\":null}".into();
        assert!(matches!(ensure_layer_settings_supported(encoder, &job),
            Err(SlicerV3Error::InvalidLayerSettingsRanges(_))));
    }

    #[test]
    fn layer_settings_ranges_zero_f64_and_all_fields() {
        let precise = 1.0000000000000002;
        let mut settings = serde_json::Map::new();
        for field in LayerSettingField::ALL {
            settings.insert(field.as_str().into(), json!(0));
        }
        settings.insert("exposureSec".into(), json!(precise));
        settings.insert("lightOffDelaySec".into(), json!(-0.0));
        settings.insert("liftHeightMm".into(), json!(f64::from(f32::MAX)));
        let result = schedule(json!([range("all", 1, 1, Value::Object(settings))]), 1);
        let patch = result.patch_at(0).unwrap();
        assert_eq!(patch.exposure_sec, Some(precise));
        assert_eq!(patch.light_off_delay_sec.unwrap().to_bits(), 0.0f64.to_bits());
        assert_eq!(patch.lift_height_mm, Some(f64::from(f32::MAX)));
        for field in LayerSettingField::ALL {
            assert!(patch.get(field).is_some(), "{}", field.as_str());
        }
        assert_eq!(patch.light_pwm, Some(0.0));
        let decimal_endpoint = json!([{"id":"decimal", "startLayer":1.0, "endLayer":1.0, "settings":{"lightPwm":255}}]);
        assert_eq!(schedule(decimal_endpoint, 1).patch_at(0).unwrap().light_pwm, Some(255.0));
    }

    #[test]
    fn layer_settings_ranges_u32_end_plus_one_and_huge_total_stay_compact() {
        let result = schedule(json!([
            range("wide", 1, u32::MAX, json!({"liftHeightMm": 8})),
            range("last", u32::MAX, u32::MAX, json!({"exposureSec": 9}))
        ]), u32::MAX);
        assert_eq!(result.segments().len(), 2);
        let last = result.patch_at(u32::MAX - 1).unwrap();
        assert_eq!(last.exposure_sec, Some(9.0));
        assert_eq!(last.lift_height_mm, Some(8.0));
        assert_eq!(result.segments()[1].end_layer, u32::MAX);
        assert!(result.patch_at(u32::MAX).is_none());
    }

    #[test]
    fn layer_settings_ranges_absent_empty_and_originally_nonempty_beyond_eof() {
        for metadata in ["", "  ", "{}", "{\"unrelated\":true}", "{\"layerSettingsRanges\":[]}"] {
            let job = SliceJobV3 { metadata_json: metadata.into(), total_layers: 5, ..Default::default() };
            let result = LayerSettingsSchedule::from_job(&job, &[]).unwrap();
            assert!(result.is_empty());
            assert!(result.segments().is_empty());
        }
        let result = schedule(json!([range("beyond", 10, 20, json!({"exposureSec": 4}))]), 5);
        assert!(!result.is_empty());
        assert!(result.segments().is_empty());
        let zero = schedule(fixture(), 0);
        assert!(!zero.is_empty());
        assert!(zero.segments().is_empty());
        // Job-level total_layers > 0 validation remains the engine's responsibility.
    }

    #[test]
    fn layer_settings_ranges_reject_malformed_metadata_and_collections() {
        for metadata in ["{", "null", "[]", "1", "true", "\"text\"", "{\"layerSettingsRanges\":null}", "{\"layerSettingsRanges\":{}}"] {
            let job = SliceJobV3 { metadata_json: metadata.into(), ..Default::default() };
            assert!(matches!(LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL),
                Err(SlicerV3Error::InvalidLayerSettingsRanges(_))), "{metadata}");
        }
    }

    #[test]
    fn layer_settings_ranges_reject_invalid_shapes_and_values() {
        let valid = range("A", 1, 2, json!({"exposureSec": 4}));
        let mut cases = vec![json!([null]), json!([7]), json!([valid.clone(), valid.clone()])];
        for key in ["id", "startLayer", "endLayer", "settings"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(key);
            cases.push(json!([missing]));
            let mut null = valid.clone();
            null[key] = Value::Null;
            cases.push(json!([null]));
        }
        for id in [json!(""), json!(2)] {
            let mut invalid = valid.clone();
            invalid["id"] = id;
            cases.push(json!([invalid]));
        }
        for key in ["startLayer", "endLayer"] {
            for endpoint in [json!(0), json!(-1), json!(1.5), json!(4294967296u64), json!("1")] {
                let mut invalid = valid.clone();
                invalid[key] = endpoint;
                cases.push(json!([invalid]));
            }
        }
        cases.push(json!([range("inverted", 3, 2, json!({"exposureSec": 4}))]));
        let mut unknown_range = valid;
        unknown_range["extra"] = json!(true);
        cases.push(json!([unknown_range]));
        for settings in [json!({}), json!([]), json!({"unknown":1}), json!({"exposureSec":null}),
            json!({"exposureSec":"4"}), json!({"exposureSec":true}), json!({"exposureSec":-1}),
            json!({"exposureSec": f64::from(f32::MAX) * 2.0}), json!({"lightPwm":0.5}), json!({"lightPwm":256})] {
            cases.push(json!([range("bad", 1, 2, settings)]));
        }
        for ranges in cases {
            let job = job(ranges.clone(), 12);
            let error = LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL).unwrap_err();
            assert!(matches!(error, SlicerV3Error::InvalidLayerSettingsRanges(_)), "{ranges}: {error}");
            assert!(error.to_string().starts_with("invalid layer settings ranges: "));
        }
        // JSON cannot represent nonfinite numeric literals; reject them at parsing.
        for literal in ["NaN", "Infinity", "-Infinity", "1e400"] {
            let metadata = format!("{{\"layerSettingsRanges\":[{{\"id\":\"A\",\"startLayer\":1,\"endLayer\":1,\"settings\":{{\"exposureSec\":{literal}}}}}]}}");
            let job = SliceJobV3 { metadata_json: metadata, ..Default::default() };
            assert!(LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL).is_err());
        }
    }

    #[test]
    fn layer_settings_ranges_unsupported_shadowed_beyond_eof_in_original_field_order() {
        for unsupported in [
            json!([range("outside", 100, 200, json!({"liftHeightMm": 8}))]),
            json!([range("shadowed", 1, 12, json!({"liftHeightMm": 8})), range("winner", 1, 12, json!({"liftHeightMm": 9}))]),
        ] {
            let error = LayerSettingsSchedule::from_job(&job(unsupported, 12), &[LayerSettingField::ExposureSec]).unwrap_err();
            assert!(matches!(error, SlicerV3Error::UnsupportedOutput(_)));
            assert_eq!(error.to_string(), "unsupported output format: goo cannot encode layer setting liftHeightMm");
        }
        let ranges = json!([range("first", 1, 2, json!({"lightPwm":2, "lightOffDelaySec":0})),
            range("second", 1, 2, json!({"exposureSec":4}))]);
        let error = LayerSettingsSchedule::from_job(&job(ranges, 12), &[]).unwrap_err();
        assert_eq!(error.to_string(), "unsupported output format: goo cannot encode layer setting lightOffDelaySec");
    }

    #[test]
    fn layer_settings_ranges_coalesce_only_same_patch_and_display_identity() {
        let result = schedule(json!([
            range("wide", 1, 10, json!({"exposureSec": 4})),
            range("shadowed", 2, 9, json!({"exposureSec": 4})),
            range("winner", 2, 9, json!({"exposureSec": 4})),
            range("inner", 4, 5, json!({"exposureSec": 4}))
        ]), 10);
        assert_eq!(result.segments().len(), 5);
        assert_eq!(result.segments().iter().map(|s| s.range_index).collect::<Vec<_>>(), [0, 2, 3, 2, 0]);
        let hidden = schedule(json!([
            range("left", 1, 8, json!({"exposureSec":4})),
            range("winner", 3, 6, json!({"exposureSec":4})),
            range("crossing", 5, 12, json!({"exposureSec":4}))
        ]), 12);
        // The crossing range starts inside the winner but changes neither its
        // inherited patch nor display identity, so layer 5 adds no segment.
        assert_eq!(hidden.segments().len(), 3);
        assert_eq!((hidden.segments()[1].start_layer, hidden.segments()[1].end_layer), (3, 6));
    }
}
