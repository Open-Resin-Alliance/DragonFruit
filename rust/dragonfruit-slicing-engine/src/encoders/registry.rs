//! Centralized output-format registry for V3 encoders.

use crate::encoders::generated_plugin_encoders::build_generated_plugin_encoders;
use crate::encoders::FormatEncoder;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

static ENCODERS: OnceLock<Vec<Box<dyn FormatEncoder>>> = OnceLock::new();
static RUNTIME_ENCODERS: OnceLock<Mutex<Vec<Box<dyn FormatEncoder>>>> = OnceLock::new();

fn pending_runtime_encoders() -> &'static Mutex<Vec<Box<dyn FormatEncoder>>> {
    RUNTIME_ENCODERS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Registers an encoder that lives outside the engine, such as a sideloaded
/// plugin's child process.
///
/// Call this before the first slice: lookups hand out `&'static dyn
/// FormatEncoder`, so the registry is frozen once it is built, and a later call
/// is refused rather than silently ignored. Compiled-in encoders keep precedence
/// because they are appended first and lookups take the first match.
pub fn register_runtime_encoder(encoder: Box<dyn FormatEncoder>) -> Result<(), String> {
    if ENCODERS.get().is_some() {
        return Err(
            "the encoder registry is already built; register runtime encoders during startup"
                .to_string(),
        );
    }
    pending_runtime_encoders()
        .lock()
        .map_err(|_| "encoder registry lock poisoned".to_string())?
        .push(encoder);
    Ok(())
}

fn encoders() -> &'static [Box<dyn FormatEncoder>] {
    ENCODERS
        .get_or_init(|| {
            // Plugin-provided encoders are generated at build time from allowlisted
            // definitions; runtime encoders are appended after them.
            let mut all = build_generated_plugin_encoders();
            if let Ok(mut pending) = pending_runtime_encoders().lock() {
                all.append(&mut pending);
            }
            all
        })
        .as_slice()
}

fn normalize_format_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed.trim_start_matches('.').to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }

    Some(format!(".{normalized}"))
}

fn matches_output_format_hint(encoder_format: &str, normalized_hint: &str) -> bool {
    let encoder = encoder_format
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();
    let hint = normalized_hint
        .trim()
        .trim_start_matches('.')
        .to_ascii_lowercase();

    if encoder.is_empty() || hint.is_empty() {
        return false;
    }

    if hint == encoder {
        return true;
    }

    if let Some(rest) = hint.strip_prefix(&encoder) {
        return rest.starts_with('-') || rest.starts_with('_');
    }

    false
}

/// Returns the registered encoder for an output format extension.
pub fn find_encoder(output_format: &str) -> Option<&'static dyn FormatEncoder> {
    encoders()
        .iter()
        .find(|encoder| encoder.output_format() == output_format)
        .map(|encoder| encoder.as_ref())
}

/// Print-time estimate in whole seconds from the encoder that owns the format.
pub fn estimate_print_time_sec(
    output_format: &str,
    metadata_json: &str,
    layer_height_mm: f32,
    total_layers: u32,
) -> Option<u32> {
    find_encoder(output_format)?.estimate_print_time_sec(
        metadata_json,
        layer_height_mm,
        total_layers,
    )
}

/// Resolve an encoder from a loosely-typed format hint and source path.
///
/// Accepts hints with or without leading '.' and supports variant suffixes
/// (e.g. `ctb-v5` resolves to `.ctb`) without hard-coding plugin modules.
pub fn find_encoder_by_hint_or_source(
    format_hint: &str,
    source_path: &Path,
) -> Option<&'static dyn FormatEncoder> {
    if let Some(normalized_hint) = normalize_format_token(format_hint) {
        if let Some(encoder) = encoders()
            .iter()
            .find(|encoder| matches_output_format_hint(encoder.output_format(), &normalized_hint))
        {
            return Some(encoder.as_ref());
        }
    }

    let extension_hint = source_path
        .extension()
        .and_then(|ext| ext.to_str())
        .and_then(normalize_format_token);

    if let Some(extension_hint) = extension_hint {
        if let Some(encoder) = encoders()
            .iter()
            .find(|encoder| matches_output_format_hint(encoder.output_format(), &extension_hint))
        {
            return Some(encoder.as_ref());
        }
    }

    None
}

/// Returns all currently registered output extensions.
pub fn supported_output_formats() -> Vec<&'static str> {
    encoders()
        .iter()
        .map(|encoder| encoder.output_format())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn print_time_estimate_dispatches_to_the_format_encoder() {
        let metadata = r#"{"material":{"normalExposureSec":2,"bottomExposureSec":20,"bottomLayerCount":2,"liftDistanceMm":0,"liftDistance2Mm":0,"bottomLiftDistanceMm":0,"bottomLiftDistance2Mm":0,"liftSpeedMmMin":0,"liftSpeed2MmMin":0,"retractSpeedMmMin":0,"retractSpeed2MmMin":0,"bottomLiftSpeedMmMin":0,"bottomLiftSpeed2MmMin":0,"bottomRetractSpeedMmMin":0,"bottomRetractSpeed2MmMin":0,"retractDistanceMm":0,"bottomRetractDistanceMm":0,"waitTimeBeforeCureSec":0,"waitTimeAfterCureSec":0,"waitTimeAfterLiftSec":0,"bottomWaitTimeBeforeCureSec":0,"bottomWaitTimeAfterCureSec":0,"bottomWaitTimeAfterLiftSec":0}}"#;
        for format in [".ctb", ".goo", ".aff", ".azf"] {
            assert_eq!(
                estimate_print_time_sec(format, metadata, 0.05, 4),
                Some(44),
                "{format}",
            );
        }
        assert_eq!(estimate_print_time_sec(".nanodlp", metadata, 0.05, 4), None);
        assert_eq!(estimate_print_time_sec(".missing", metadata, 0.05, 4), None);
    }
}
