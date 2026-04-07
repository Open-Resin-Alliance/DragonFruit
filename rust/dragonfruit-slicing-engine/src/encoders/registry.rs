//! Centralized output-format registry for V3 encoders.

use crate::encoders::generated_plugin_encoders::build_generated_plugin_encoders;
use crate::encoders::FormatEncoder;
use std::sync::OnceLock;

static ENCODERS: OnceLock<Vec<Box<dyn FormatEncoder>>> = OnceLock::new();

fn encoders() -> &'static [Box<dyn FormatEncoder>] {
    ENCODERS
        // Plugin-provided encoders are generated at build time from allowlisted definitions.
        .get_or_init(build_generated_plugin_encoders)
        .as_slice()
}

/// Returns the registered encoder for an output format extension.
pub fn find_encoder(output_format: &str) -> Option<&'static dyn FormatEncoder> {
    encoders()
        .iter()
        .find(|encoder| encoder.output_format() == output_format)
        .map(|encoder| encoder.as_ref())
}

/// Returns all currently registered output extensions.
pub fn supported_output_formats() -> Vec<&'static str> {
    encoders()
        .iter()
        .map(|encoder| encoder.output_format())
        .collect()
}
