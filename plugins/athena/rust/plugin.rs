/// Athena plugin adapter for DragonFruit plugin registry
///
/// This module implements the plugin registration interface for Athena,
/// allowing it to be discovered and used by the core plugin registry.
use std::sync::Arc;

use crate::plugin_registry::{FormatProvider, PluginRegistration};

/// Athena format provider implementation
pub struct AthenaFormatProvider;

impl FormatProvider for AthenaFormatProvider {
    fn default_export_format(&self) -> &'static str {
        "nanodlp"
    }
}

/// Get instructions for plugin registration
pub fn get_plugin_registration() -> PluginRegistration {
    PluginRegistration {
        name: "athena".to_string(),
        network_handler: None,
        format_provider: Some(Arc::new(AthenaFormatProvider)),
    }
}
