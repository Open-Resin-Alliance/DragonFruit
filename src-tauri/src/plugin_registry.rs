use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[path = "../../plugins/athena/rust/network.rs"]
mod athena_network;

#[path = "../../plugins/athena/rust/plugin.rs"]
mod athena_plugin;

pub use athena_network::PluginNetworkResponse;

/// Trait for plugin network handlers that can process network requests
pub trait NetworkHandler: Send + Sync {
    /// Dispatch a network request JSON and return a response.
    /// The handler should return None if it cannot handle the request,
    /// allowing other registered handlers to process it.
    fn handle_request_blocking(
        &self,
        request_json: &str,
    ) -> Result<Option<serde_json::Value>, String>;
}

/// Trait for plugins that can provide printer/format-related metadata
pub trait FormatProvider: Send + Sync {
    /// Get the default export format extension (e.g., "print", "lys")
    fn default_export_format(&self) -> &'static str;

    /// Get the default filename for exported print files
    fn default_export_filename(&self) -> String {
        format!("slice_export.{}", self.default_export_format())
    }
}

/// Plugin metadata registration
pub struct PluginRegistration {
    pub name: String,
    pub network_handler: Option<Arc<dyn NetworkHandler>>,
    pub format_provider: Option<Arc<dyn FormatProvider>>,
}

/// Global plugin registry
static PLUGIN_REGISTRY: OnceLock<Mutex<PluginRegistry>> = OnceLock::new();

pub struct PluginRegistry {
    plugins: HashMap<String, PluginRegistration>,
    network_handlers: Vec<Arc<dyn NetworkHandler>>,
    format_provider: Option<Arc<dyn FormatProvider>>,
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self {
            plugins: HashMap::new(),
            network_handlers: Vec::new(),
            format_provider: None,
        }
    }

    /// Register a plugin with the system
    pub fn register(&mut self, registration: PluginRegistration) {
        if let Some(handler) = &registration.network_handler {
            self.network_handlers.push(handler.clone());
        }
        if let Some(provider) = &registration.format_provider {
            // Last registered provider wins
            self.format_provider = Some(provider.clone());
        }
        self.plugins.insert(registration.name.clone(), registration);
    }

    /// Get all registered network handlers in order
    pub fn network_handlers(&self) -> &[Arc<dyn NetworkHandler>] {
        &self.network_handlers
    }

    /// Get the format provider (returns default if none registered)
    pub fn format_provider(&self) -> Arc<dyn FormatProvider> {
        self.format_provider
            .clone()
            .unwrap_or_else(|| Arc::new(DefaultFormatProvider))
    }

    /// Check if a plugin is registered
    pub fn has_plugin(&self, name: &str) -> bool {
        self.plugins.contains_key(name)
    }
}

/// Default format provider (fallback)
pub struct DefaultFormatProvider;

impl FormatProvider for DefaultFormatProvider {
    fn default_export_format(&self) -> &'static str {
        "print"
    }
}

/// Get the default format provider directly
pub fn get_default_format_provider() -> Arc<dyn FormatProvider> {
    Arc::new(DefaultFormatProvider)
}

/// Get or initialize the global plugin registry
fn get_registry() -> &'static Mutex<PluginRegistry> {
    PLUGIN_REGISTRY.get_or_init(|| Mutex::new(PluginRegistry::new()))
}

/// Register a plugin in the global registry
pub fn register_plugin(registration: PluginRegistration) -> Result<(), String> {
    get_registry()
        .lock()
        .map_err(|e| format!("Failed to lock plugin registry: {e}"))?
        .register(registration);
    Ok(())
}

/// Initialize built-in plugins.
/// NOTE: Plugin-specific names are centralized here by design.
pub fn initialize_plugins() -> Result<(), String> {
    register_plugin(athena_plugin::get_plugin_registration())
}

/// Get a snapshot of registered network handlers
pub fn get_network_handlers() -> Result<Vec<Arc<dyn NetworkHandler>>, String> {
    let registry = get_registry()
        .lock()
        .map_err(|e| format!("Failed to lock plugin registry: {e}"))?;
    Ok(registry.network_handlers().to_vec())
}

/// Register a format provider in the global registry
pub fn register_format_provider(
    name: String,
    provider: Arc<dyn FormatProvider>,
) -> Result<(), String> {
    let registration = PluginRegistration {
        name,
        network_handler: None,
        format_provider: Some(provider),
    };
    register_plugin(registration)
}

/// Get the active format provider
pub fn get_format_provider() -> Result<Arc<dyn FormatProvider>, String> {
    let registry = get_registry()
        .lock()
        .map_err(|e| format!("Failed to lock plugin registry: {e}"))?;
    Ok(registry.format_provider())
}

/// Dispatch network requests through registered plugins.
/// Currently routes to plugin implementations via registry-owned dispatch wiring.
pub async fn dispatch_network_request(
    request_json: String,
) -> Result<PluginNetworkResponse, String> {
    athena_network::dispatch_plugin_network_request(request_json).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_format_provider() {
        let provider = DefaultFormatProvider;
        assert_eq!(provider.default_export_format(), "print");
        assert_eq!(provider.default_export_filename(), "slice_export.print");
    }
}
