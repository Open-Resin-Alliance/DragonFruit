//! Sparse, field-wise overrides for inclusive printed-layer ranges.
//!
//! Parsed values stay f64 until a format writes its existing f32 records.

use crate::{SliceJobV3, SlicerV3Error};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};
use std::io::{Cursor, Write};

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
#[serde(untagged)]
pub enum LayerSettingsRange {
    Layers(LayerNumberSettingsRange),
    Millimeters(MillimeterSettingsRange),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerNumberSettingsRange {
    pub id: String,
    #[serde(deserialize_with = "deserialize_layer_number")]
    pub start_layer: u32,
    #[serde(deserialize_with = "deserialize_layer_number")]
    pub end_layer: u32,
    pub settings: LayerPrintSettingsPatch,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MillimeterSettingsRange {
    pub id: String,
    pub unit: MillimeterUnit,
    pub start_mm: f64,
    pub end_mm: f64,
    pub settings: LayerPrintSettingsPatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MillimeterUnit {
    #[serde(rename = "mm")]
    Mm,
}

impl LayerSettingsRange {
    pub fn id(&self) -> &str {
        match self {
            Self::Layers(range) => &range.id,
            Self::Millimeters(range) => &range.id,
        }
    }

    pub fn settings(&self) -> &LayerPrintSettingsPatch {
        match self {
            Self::Layers(range) => &range.settings,
            Self::Millimeters(range) => &range.settings,
        }
    }

    fn settings_mut(&mut self) -> &mut LayerPrintSettingsPatch {
        match self {
            Self::Layers(range) => &mut range.settings,
            Self::Millimeters(range) => &mut range.settings,
        }
    }

    // Resolve original bounds before clipping or ranking. Round n * nominal h
    // once to f32, like the endpoint; never round n or h before multiplication.
    // Persisted millimeter values and extrapolated bounds remain f64.
    fn bounds(&self, layer_height_mm: f64) -> Option<(f64, f64)> {
        match self {
            Self::Layers(range) => Some((f64::from(range.start_layer), f64::from(range.end_layer))),
            Self::Millimeters(range) => {
                let start_mm = range.start_mm as f32;
                let end_mm = range.end_mm as f32;
                let grid_end = (f64::from(u32::MAX) * layer_height_mm) as f32;
                let beyond = f64::from(u32::MAX) + 1.0;
                let start = if start_mm > grid_end {
                    (f64::from(start_mm) / layer_height_mm).ceil().max(beyond)
                } else {
                    grid_bound(start_mm, layer_height_mm, false) as f64
                };
                let end = if end_mm > grid_end {
                    (f64::from(end_mm) / layer_height_mm).floor()
                } else {
                    (grid_bound(end_mm, layer_height_mm, true) - 1) as f64
                };
                (start <= end).then_some((start, end))
            }
        }
    }
}

// First printed layer whose height is >= endpoint (or > for an upper bound).
// The u32::MAX + 1 sentinel is never evaluated as a physical layer.
fn grid_bound(endpoint: f32, layer_height_mm: f64, upper: bool) -> u64 {
    let mut low = 1u64;
    let mut high = u64::from(u32::MAX) + 1;
    while low < high {
        let middle = low + (high - low) / 2;
        let height = (middle as f64 * layer_height_mm) as f32;
        if if upper { height <= endpoint } else { height < endpoint } {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low
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
        let metadata = parse_metadata(&job.metadata_json)?;
        let ranges = parse_ranges(&metadata)?;
        for range in &ranges {
            for field in LayerSettingField::ALL {
                if range.settings().get(field).is_some() && !supported_fields.contains(&field) {
                    return Err(SlicerV3Error::UnsupportedOutput(format!(
                        "{} cannot encode layer setting {}", job.output_format, field.as_str()
                    )));
                }
            }
        }
        let nominal_height = if ranges.iter().any(|range| matches!(range, LayerSettingsRange::Millimeters(_))) {
            nominal_layer_height(&metadata, job.layer_height_mm)?
        } else {
            f64::from(job.layer_height_mm)
        };
        Ok(Self {
            segments: compile_ranges(&ranges, job.total_layers, nominal_height),
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
    let metadata = parse_metadata(&job.metadata_json)?;
    if !parse_ranges(&metadata)?.is_empty() {
        return Err(SlicerV3Error::UnsupportedOutput(format!(
            "{} does not support per-layer settings", job.output_format
        )));
    }
    Ok(())
}

fn invalid(reason: impl Into<String>) -> SlicerV3Error {
    SlicerV3Error::InvalidLayerSettingsRanges(reason.into())
}

fn parse_metadata(metadata: &str) -> Result<Value, SlicerV3Error> {
    if metadata.trim().is_empty() {
        return Ok(Value::Object(serde_json::Map::new()));
    }
    let root: Value = serde_json::from_str(metadata)
        .map_err(|error| invalid(format!("metadata must be valid JSON: {error}")))?;
    if !root.is_object() {
        return Err(invalid("metadata must be an object"));
    }
    Ok(root)
}

fn nominal_layer_height(metadata: &Value, layer_height_mm: f32) -> Result<f64, SlicerV3Error> {
    if !layer_height_mm.is_finite() || layer_height_mm <= 0.0 {
        return Err(invalid("millimeter ranges require a finite positive layer height"));
    }
    if let Some(value) = metadata.get("effective").and_then(|effective| effective.get("layerHeightMm")) {
        return value.as_f64().filter(|height| {
            height.is_finite() && *height > 0.0 && *height as f32 == layer_height_mm
        }).ok_or_else(|| invalid("effective.layerHeightMm must be finite, positive and match the job layer height as f32"));
    }
    // Native callers without nominal metadata use the shortest displayed f32
    // decimal (0.03, not the widened binary f32), without allocating a String.
    let mut buffer = [0u8; 64];
    let length = {
        let mut cursor = Cursor::new(buffer.as_mut_slice());
        write!(&mut cursor, "{layer_height_mm}")
            .map_err(|_| invalid("layer height decimal exceeds the stack buffer"))?;
        cursor.position() as usize
    };
    std::str::from_utf8(&buffer[..length]).ok().and_then(|text| text.parse::<f64>().ok())
        .ok_or_else(|| invalid("layer height must have a finite decimal representation"))
}

fn parse_ranges(metadata: &Value) -> Result<Vec<LayerSettingsRange>, SlicerV3Error> {
    let Some(value) = metadata.get("layerSettingsRanges") else {
        return Ok(Vec::new());
    };
    let array = value.as_array().ok_or_else(|| invalid("expected an array"))?;
    let mut ids = HashSet::with_capacity(array.len());
    for (index, value) in array.iter().enumerate() {
        let range = value.as_object()
            .ok_or_else(|| invalid(format!("range {index} must be an object")))?;
        let millimeters = match range.get("unit") {
            None => false,
            Some(Value::String(unit)) if unit == "mm" => true,
            Some(_) => return Err(invalid(format!("range {index} unit must be mm when supplied"))),
        };
        let keys = if millimeters {
            &["id", "unit", "startMm", "endMm", "settings"][..]
        } else {
            &["id", "startLayer", "endLayer", "settings"][..]
        };
        for key in range.keys() {
            if !keys.contains(&key.as_str()) {
                return Err(invalid(format!("range {index} has unknown key {key}")));
            }
        }
        for &key in keys {
            if !range.contains_key(key) {
                return Err(invalid(format!("range {index} must have own {key}")));
            }
        }
        let id = range["id"].as_str().filter(|id| !id.is_empty())
            .ok_or_else(|| invalid(format!("range {index} id must be a nonempty string")))?;
        if !ids.insert(id) {
            return Err(invalid(format!("duplicate id {id}")));
        }
        let (start_key, end_key) = if millimeters { ("startMm", "endMm") } else { ("startLayer", "endLayer") };
        for key in [start_key, end_key] {
            let valid = range[key].as_f64().is_some_and(|number| {
                if millimeters {
                    number.is_finite() && (0.0..=f64::from(f32::MAX)).contains(&number)
                } else {
                    number.is_finite() && number.fract() == 0.0
                        && (1.0..=u32::MAX as f64).contains(&number)
                }
            });
            if !valid {
                let expected = if millimeters { "a finite number in 0..f32::MAX" } else { "an integer in 1..4294967295" };
                return Err(invalid(format!("range {index} {key} must be {expected}")));
            }
        }
        if range[start_key].as_f64() > range[end_key].as_f64() {
            return Err(invalid(format!("range {index} {start_key} must not exceed {end_key}")));
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
        if let LayerSettingsRange::Millimeters(range) = range {
            if range.start_mm == 0.0 { range.start_mm = 0.0; }
            if range.end_mm == 0.0 { range.end_mm = 0.0; }
        }
        for field in LayerSettingField::ALL {
            if range.settings().get(field) == Some(0.0) {
                range.settings_mut().set(field, 0.0);
            }
        }
    }
    Ok(ranges)
}

// All spans are positive finite f64, including extrapolated bounds beyond the
// u32 grid. total_cmp keeps heap ordering deterministic without narrowing them.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Span(f64);

impl Eq for Span {}

impl Ord for Span {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

impl PartialOrd for Span {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

// BinaryHeap is max-first: reverse span, then prefer the later original index.
type Priority = (Reverse<Span>, usize);

fn current(heap: &mut BinaryHeap<Priority>, active: &[bool]) -> Option<usize> {
    while heap.peek().is_some_and(|entry| !active[entry.1]) {
        heap.pop();
    }
    heap.peek().map(|entry| entry.1)
}

fn compile_ranges(ranges: &[LayerSettingsRange], total_layers: u32, layer_height_mm: f64) -> Vec<LayerSettingsSegment> {
    // End events sort before start events at the same coordinate. u64 represents
    // u32::MAX + 1 without overflowing, even at the last possible printed layer.
    let mut events = Vec::with_capacity(ranges.len() * 2);
    for (index, range) in ranges.iter().enumerate() {
        let Some((start, end)) = range.bounds(layer_height_mm) else { continue };
        let span = Span(end - start + 1.0);
        if start <= f64::from(total_layers) {
            events.push((start as u64, true, index, span));
            events.push((end.min(f64::from(total_layers)) as u64 + 1, false, index, span));
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
            let (_, starting, index, span) = events[cursor];
            active[index] = starting;
            if starting {
                let range = &ranges[index];
                let priority = (Reverse(span), index);
                display.push(priority);
                for (field_index, field) in LayerSettingField::ALL.iter().enumerate() {
                    if range.settings().get(*field).is_some() {
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
                if let Some(value) = ranges[index].settings().get(*field) {
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

    fn mm_range(id: &str, start: f64, end: f64, settings: Value) -> Value {
        json!({"id": id, "unit": "mm", "startMm": start, "endMm": end, "settings": settings})
    }

    fn mm_schedule(ranges: Value, total: u32, height: f32) -> LayerSettingsSchedule {
        let mut job = job(ranges, total);
        job.layer_height_mm = height;
        LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL).unwrap()
    }

    #[test]
    fn layer_settings_ranges_mm_abc_fixture_matches_layers_and_inheritance() {
        let millimeters = mm_schedule(json!([
            mm_range("A", 0.15, 0.5, json!({"exposureSec": 4, "liftHeightMm": 8})),
            mm_range("B", 0.25, 0.3, json!({"exposureSec": 7})),
            mm_range("C", 0.3, 0.35, json!({"exposureSec": 9}))
        ]), 12, 0.05);
        assert_eq!(millimeters.segments(), schedule(fixture(), 12).segments());
        let exposures: Vec<f64> = (0..12).map(|index| {
            millimeters.patch_at(index).and_then(|patch| patch.exposure_sec)
                .unwrap_or(if index < 2 { 10.0 } else { 2.0 })
        }).collect();
        assert_eq!(exposures, [10., 10., 4., 4., 7., 9., 9., 4., 4., 4., 2., 2.]);
    }

    #[test]
    fn layer_settings_ranges_mm_f32_boundaries_zero_off_grid_and_raw_storage() {
        let ranges = json!([
            mm_range("sixth", 0.3, 0.3, json!({"exposureSec": 6})),
            mm_range("zero", -0.0, 0.0, json!({"exposureSec": 0})),
            mm_range("off-grid", 0.301, 0.349, json!({"exposureSec": 99})),
            mm_range("first", 0.0, 0.05, json!({"exposureSec": 1}))
        ]);
        let result = mm_schedule(ranges.clone(), 12, 0.05);
        assert_eq!(result.segments().len(), 2);
        assert_eq!(result.patch_at(0).unwrap().exposure_sec, Some(1.0));
        assert_eq!(result.patch_at(5).unwrap().exposure_sec, Some(6.0));
        assert!(result.patch_at(4).is_none());
        assert!(result.patch_at(6).is_none());
        let parsed = parse_ranges(&json!({"layerSettingsRanges": ranges})).unwrap();
        let saved = serde_json::to_value(&parsed).unwrap();
        assert_eq!(saved[0]["startMm"], json!(0.3));
        assert!(saved[0].get("startLayer").is_none());
        assert!(saved[0].get("endLayer").is_none());
        assert_eq!(parsed[0].id(), "sixth");
        if let LayerSettingsRange::Millimeters(range) = &parsed[1] {
            assert_eq!(range.start_mm.to_bits(), 0.0f64.to_bits());
        } else { panic!("expected millimeter range"); }
        let precise = 0.10000000000000002;
        let parsed = parse_ranges(&json!({"layerSettingsRanges": [
            mm_range("precise", precise, precise, json!({"exposureSec": 4}))
        ]})).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap()[0]["startMm"], json!(precise));
        assert_eq!(parsed[0].bounds(0.05), Some((2.0, 2.0)));
        for (start, end) in [(0.0, 0.0), (0.301, 0.349), (20.0, 30.0)] {
            let result = mm_schedule(json!([mm_range("empty", start, end, json!({"exposureSec": 4}))]), 12, 0.05);
            assert!(!result.is_empty());
            assert!(result.segments().is_empty());
        }
    }

    #[test]
    fn layer_settings_ranges_mm_mixed_resolved_span_ties_and_original_widths() {
        let layer = range("layers", 5, 6, json!({"exposureSec": 7, "liftHeightMm": 8}));
        let mm = mm_range("mm", 0.25, 0.3, json!({"exposureSec": 9}));
        for (ranges, expected) in [(json!([layer.clone(), mm.clone()]), 9.0), (json!([mm, layer]), 7.0)] {
            let result = mm_schedule(ranges, 12, 0.05);
            let patch = result.patch_at(5).unwrap();
            assert_eq!(patch.exposure_sec, Some(expected));
            assert_eq!(patch.lift_height_mm, Some(8.0));
            assert_eq!(result.segments()[0].range_index, 1);
        }
        let result = mm_schedule(json!([
            mm_range("narrow", 0.05, 0.5, json!({"exposureSec": 7})),
            mm_range("wide", 0.05, 5.0, json!({"exposureSec": 4, "liftHeightMm": 8}))
        ]), 5, 0.05);
        assert_eq!(result.patch_at(0).unwrap().exposure_sec, Some(7.0));
        assert_eq!(result.patch_at(0).unwrap().lift_height_mm, Some(8.0));
    }

    #[test]
    fn layer_settings_ranges_mm_height_changes_and_invalid_height_even_zero_total() {
        let ranges = json!([mm_range("point", 0.3, 0.3, json!({"exposureSec": 6}))]);
        let fine = mm_schedule(ranges.clone(), 12, 0.05);
        let coarse = mm_schedule(ranges.clone(), 12, 0.1);
        assert_eq!(fine.segments()[0].start_layer, 6);
        assert_eq!(coarse.segments()[0].start_layer, 3);
        for total in [0, 12] {
            for height in [0.0, -0.05, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
                let mut job = job(ranges.clone(), total);
                job.layer_height_mm = height;
                assert!(matches!(LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL),
                    Err(SlicerV3Error::InvalidLayerSettingsRanges(_))));
            }
        }
        assert!(mm_schedule(ranges, 0, 0.05).segments().is_empty());
        // Legacy layer-only jobs still require no height, including zero total.
        assert!(!schedule(fixture(), 0).is_empty());
    }

    #[test]
    fn layer_settings_ranges_mm_thirty_micron_point_preserves_third_layer() {
        let ranges = json!([mm_range("third", 3.0 * 0.03, 3.0 * 0.03, json!({"exposureSec": 9}))]);
        let result = mm_schedule(ranges.clone(), 12, 0.03);
        assert_eq!(result.segments().len(), 1);
        assert_eq!((result.segments()[0].start_layer, result.segments()[0].end_layer), (3, 3));
        assert_eq!(result.patch_at(2).unwrap().exposure_sec, Some(9.0));
        let mut job = job(ranges.clone(), 12);
        job.layer_height_mm = 0.03;
        job.metadata_json = json!({
            "effective": {"layerHeightMm": 0.03}, "layerSettingsRanges": ranges
        }).to_string();
        assert_eq!(LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL).unwrap().segments(), result.segments());
    }

    #[test]
    fn layer_settings_ranges_mm_nominal_height_matrix_preserves_points_and_intervals() {
        for height in [0.015, 0.025, 0.03, 0.035, 0.05, 0.0625] {
            for layer in [1u32, 3, 7, 30, 1234] {
                for end in [layer, layer + 2] {
                    let ranges = json!([mm_range("converted", f64::from(layer) * height,
                        f64::from(end) * height, json!({"exposureSec": 9}))]);
                    let expected = schedule(json!([range("converted", layer, end, json!({"exposureSec": 9}))]), end + 1);
                    for declared in [false, true] {
                        let mut job = job(ranges.clone(), end + 1);
                        job.layer_height_mm = height as f32;
                        if declared {
                            job.metadata_json = json!({
                                "effective": {"layerHeightMm": height}, "layerSettingsRanges": ranges
                            }).to_string();
                        }
                        let result = LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL).unwrap();
                        assert_eq!(result.segments(), expected.segments(), "h={height}, layers={layer}..{end}, declared={declared}");
                    }
                }
            }
        }
        let precise = 0.0300000001;
        assert_eq!(nominal_layer_height(&json!({"effective": {"layerHeightMm": precise}}), precise as f32).unwrap(), precise);
        assert_eq!(nominal_layer_height(&json!({}), 0.03).unwrap(), 0.03);
        assert_eq!(nominal_layer_height(&json!({"effective": {}}), 0.03).unwrap(), 0.03);
        for height in [f32::from_bits(1), f32::MIN_POSITIVE, f32::MAX] {
            let nominal = nominal_layer_height(&json!({}), height).unwrap();
            assert!(nominal.is_finite() && nominal > 0.0);
            assert_eq!(nominal as f32, height);
        }
    }

    #[test]
    fn layer_settings_ranges_mm_invalid_nominal_context_rejected_even_without_matching_layers() {
        for value in [Value::Null, json!("0.03"), json!(true), json!(0), json!(-0.03),
            json!(0.05), json!(f64::MAX), json!(1e-100)] {
            for (start, end) in [(0.09, 0.09), (100.0, 200.0), (0.0, 0.0), (0.091, 0.119)] {
                for total in [0, 12] {
                    let mut job = job(json!([]), total);
                    job.layer_height_mm = 0.03;
                    job.metadata_json = json!({
                        "effective": {"layerHeightMm": value},
                        "layerSettingsRanges": [mm_range("point", start, end, json!({"exposureSec": 9}))]
                    }).to_string();
                    assert!(matches!(LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL),
                        Err(SlicerV3Error::InvalidLayerSettingsRanges(_))), "context={value}, bounds={start}..{end}, total={total}");
                }
            }
        }
    }

    #[test]
    fn layer_settings_ranges_legacy_ignores_unrelated_nominal_height_context() {
        for effective in [Value::Null, json!("unrelated"), json!({}),
            json!({"layerHeightMm": null}), json!({"layerHeightMm": "0.03"}),
            json!({"layerHeightMm": 0}), json!({"layerHeightMm": 0.05})] {
            for height in [0.0, f32::NAN, 0.03] {
                let mut job = job(fixture(), 12);
                job.layer_height_mm = height;
                job.metadata_json = json!({"effective": effective, "layerSettingsRanges": fixture()}).to_string();
                let result = LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL).unwrap();
                assert_eq!(result.segments(), schedule(fixture(), 12).segments());
                job.metadata_json = json!({"effective": effective, "layerSettingsRanges": []}).to_string();
                assert!(LayerSettingsSchedule::from_job(&job, &[]).unwrap().is_empty());
            }
        }
    }

    #[test]
    fn layer_settings_ranges_mm_invalid_nominal_context_rejected_before_destination_changes() {
        let mut job = job(json!([]), 12);
        job.layer_height_mm = 0.03;
        job.output_format = ".goo".into();
        job.metadata_json = json!({
            "effective": {"layerHeightMm": null},
            "layerSettingsRanges": [mm_range("outside", 100.0, 200.0, json!({"exposureSec": 9}))]
        }).to_string();
        let path = std::env::temp_dir().join(format!("layer-settings-invalid-nominal-{}.goo", std::process::id()));
        std::fs::write(&path, b"existing destination").unwrap();
        let result = crate::engine::dispatch_encode_by_format_to_path(
            &job, &crate::types::RenderedLayersV3::default(), &[], &path, None,
        );
        assert!(matches!(result, Err(SlicerV3Error::InvalidLayerSettingsRanges(_))));
        assert_eq!(std::fs::read(&path).unwrap(), b"existing destination");
        std::fs::remove_file(&path).unwrap();
        let result = crate::engine::dispatch_encode_by_format_to_path(
            &job, &crate::types::RenderedLayersV3::default(), &[], &path, None,
        );
        assert!(matches!(result, Err(SlicerV3Error::InvalidLayerSettingsRanges(_))));
        assert!(!path.exists());
    }

    #[test]
    fn layer_settings_ranges_mm_u32_plateaus_extrapolation_and_overflow_stay_compact() {
        let last = f64::from(u32::MAX as f32);
        let result = mm_schedule(json!([mm_range("last", last, last, json!({"exposureSec": 9}))]), u32::MAX, 1.0);
        assert_eq!(result.segments().len(), 1);
        assert_eq!(result.segments()[0].end_layer, u32::MAX);
        assert!(result.segments()[0].start_layer > u32::MAX - 256);
        assert_eq!(result.patch_at(u32::MAX - 1).unwrap().exposure_sec, Some(9.0));
        assert!(result.patch_at(u32::MAX).is_none());
        // Both cover the whole physical print, but unclipped extrapolated spans
        // exceed u64 and the earlier narrower range must still win.
        let height = f32::from_bits(1);
        let result = mm_schedule(json!([
            mm_range("narrow", 0.0, 1e20, json!({"exposureSec": 7})),
            mm_range("wide", 0.0, f64::from(f32::MAX), json!({"exposureSec": 4, "liftHeightMm": 8})),
            mm_range("beyond", 1e30, 2e30, json!({"exposureSec": 99}))
        ]), u32::MAX, height);
        assert_eq!(result.segments().len(), 1);
        assert_eq!(result.patch_at(u32::MAX - 1).unwrap().exposure_sec, Some(7.0));
        assert_eq!(result.patch_at(0).unwrap().lift_height_mm, Some(8.0));
        // A finite endpoint must not match an infinite grid height.
        let result = mm_schedule(json!([
            mm_range("finite", f64::from(f32::MAX), f64::from(f32::MAX), json!({"exposureSec": 3}))
        ]), u32::MAX, f32::MAX);
        assert_eq!(result.segments().len(), 1);
        assert_eq!((result.segments()[0].start_layer, result.segments()[0].end_layer), (1, 1));
    }

    #[test]
    fn layer_settings_ranges_mm_reject_malformed_forms_and_values() {
        let valid = mm_range("mm", 0.0, 0.3, json!({"exposureSec": 4}));
        let mut cases = Vec::new();
        for key in ["id", "unit", "startMm", "endMm", "settings"] {
            let mut missing = valid.clone();
            missing.as_object_mut().unwrap().remove(key);
            cases.push(missing);
            let mut null = valid.clone();
            null[key] = Value::Null;
            cases.push(null);
        }
        for unit in [json!("layers"), json!("cm"), json!(true), json!(0)] {
            let mut invalid = valid.clone();
            invalid["unit"] = unit;
            cases.push(invalid);
        }
        for key in ["startMm", "endMm"] {
            for value in [json!(-1), json!("0.1"), json!(true), json!(f64::from(f32::MAX) * 2.0)] {
                let mut invalid = valid.clone();
                invalid[key] = value;
                cases.push(invalid);
            }
        }
        for key in ["startLayer", "endLayer", "extra"] {
            let mut mixed = valid.clone();
            mixed[key] = json!(1);
            cases.push(mixed);
        }
        let mut legacy_unit = range("legacy", 1, 2, json!({"exposureSec": 4}));
        legacy_unit["unit"] = json!("mm");
        cases.push(legacy_unit);
        cases.push(mm_range("inverted", 0.3, 0.1, json!({"exposureSec": 4})));
        for invalid in cases {
            let mut job = job(json!([invalid.clone()]), 12);
            job.layer_height_mm = 0.05;
            assert!(matches!(LayerSettingsSchedule::from_job(&job, &LayerSettingField::ALL),
                Err(SlicerV3Error::InvalidLayerSettingsRanges(_))), "{invalid}");
        }
        for literal in ["NaN", "Infinity", "-Infinity", "1e400"] {
            let metadata = format!("{{\"layerSettingsRanges\":[{{\"id\":\"mm\",\"unit\":\"mm\",\"startMm\":0,\"endMm\":{literal},\"settings\":{{\"exposureSec\":4}}}}]}}");
            assert!(parse_metadata(&metadata).and_then(|root| parse_ranges(&root)).is_err());
        }
        let duplicate = json!({"layerSettingsRanges": [
            range("same", 1, 2, json!({"exposureSec": 4})),
            mm_range("same", 0.0, 0.3, json!({"exposureSec": 4}))
        ]});
        assert!(parse_ranges(&duplicate).is_err());
    }

    #[test]
    fn layer_settings_ranges_mm_unsupported_outside_or_empty_still_rejected() {
        for (start, end) in [(20.0, 30.0), (0.0, 0.0), (0.301, 0.349)] {
            let mut job = job(json!([mm_range("outside", start, end, json!({"liftHeightMm": 8}))]), 12);
            job.layer_height_mm = 0.05;
            let error = LayerSettingsSchedule::from_job(&job, &[LayerSettingField::ExposureSec]).unwrap_err();
            assert_eq!(error.to_string(), "unsupported output format: goo cannot encode layer setting liftHeightMm");
            let encoder = crate::encoders::registry::find_encoder(".nanodlp").unwrap();
            // Unsupported formats validate the collection, not irrelevant height
            // context, even when every range is outside the job or off-grid.
            job.layer_height_mm = f32::NAN;
            let mut metadata = parse_metadata(&job.metadata_json).unwrap();
            metadata["effective"] = json!({"layerHeightMm": null});
            job.metadata_json = metadata.to_string();
            assert!(matches!(ensure_layer_settings_supported(encoder, &job),
                Err(SlicerV3Error::UnsupportedOutput(_))));
            metadata["layerSettingsRanges"][0]["extra"] = json!(1);
            job.metadata_json = metadata.to_string();
            assert!(matches!(ensure_layer_settings_supported(encoder, &job),
                Err(SlicerV3Error::InvalidLayerSettingsRanges(_))));
        }
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
