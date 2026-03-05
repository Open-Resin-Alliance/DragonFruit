use crate::plugin_registry::PluginNetworkResponse;

/// Default plugin network request handler that dispatches through registered plugins
#[tauri::command]
pub async fn plugin_network_request(request_json: String) -> Result<PluginNetworkResponse, String> {
    crate::plugin_registry::dispatch_network_request(request_json).await
}
