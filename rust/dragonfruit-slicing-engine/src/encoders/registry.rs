//! Centralized output-format registry for V3 encoders.

use crate::encoders::generated_plugin_encoders::build_generated_plugin_encoders;
use crate::encoders::FormatEncoder;
use std::path::Path;
use std::sync::OnceLock;

static ENCODERS: OnceLock<Vec<Box<dyn FormatEncoder>>> = OnceLock::new();

fn encoders() -> &'static [Box<dyn FormatEncoder>] {
    ENCODERS
        // Plugin-provided encoders are generated at build time from allowlisted definitions.
        .get_or_init(build_generated_plugin_encoders)
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
