use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

#[path = "generated_builtin_plugins.rs"]
mod generated_builtin_plugins;

#[derive(Clone, Serialize)]
pub struct PluginNetworkResponse {
    pub status: u16,
    pub body: serde_json::Value,
}

/// Trait for plugin network handlers that can process network requests
pub trait NetworkHandler: Send + Sync {
    /// Dispatch a network request JSON and return a response.
    /// The handler should return None if it cannot handle the request,
    /// allowing other registered handlers to process it.
    #[allow(dead_code)]
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
const COMPLEX_PLUGIN_ALLOWLIST_JSON: &str =
    include_str!("../../src/config/complex-plugin-allowlist.json");

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

    /// Get the format provider (returns default if none registered)
    pub fn format_provider(&self) -> Arc<dyn FormatProvider> {
        self.format_provider
            .clone()
            .unwrap_or_else(|| Arc::new(DefaultFormatProvider))
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
    verify_generated_allowlist_integrity()?;
    generated_builtin_plugins::register_generated_plugins()
}

fn computed_allowlist_sha256_hex() -> String {
    let mut hasher = Sha256::new();
    hasher.update(COMPLEX_PLUGIN_ALLOWLIST_JSON.as_bytes());
    let digest = hasher.finalize();
    format!("{digest:x}")
}

fn verify_generated_allowlist_integrity() -> Result<(), String> {
    let computed = computed_allowlist_sha256_hex();
    let expected = generated_builtin_plugins::GENERATED_COMPLEX_PLUGIN_ALLOWLIST_SHA256;

    if computed == expected {
        return Ok(());
    }

    let message = format!(
        "Built-in complex plugin allowlist integrity check failed (expected SHA256 {expected}, got {computed}). Regenerate plugin registry before running.",
    );

    if cfg!(debug_assertions) {
        log::warn!("[plugin-registry] WARNING: {message}");
        return Ok(());
    }

    Err(message)
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
    let request: serde_json::Value =
        serde_json::from_str(&request_json).map_err(|e| format!("Invalid request JSON: {e}"))?;

    let plugin_id = request
        .get("pluginId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();

    if plugin_id.is_empty() {
        return Ok(PluginNetworkResponse {
            status: 400,
            body: serde_json::json!({ "error": "pluginId is required" }),
        });
    }

    if let Some(response) =
        generated_builtin_plugins::dispatch_generated_network_request(&plugin_id, request_json)
            .await?
    {
        return Ok(response);
    }

    Ok(PluginNetworkResponse {
        status: 404,
        body: serde_json::json!({ "error": format!("Unknown network plugin: {plugin_id}") }),
    })
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

    #[test]
    fn test_allowlist_hash_matches_generated_constant() {
        let computed = computed_allowlist_sha256_hex();
        assert_eq!(
            computed,
            generated_builtin_plugins::GENERATED_COMPLEX_PLUGIN_ALLOWLIST_SHA256
        );
    }
}
