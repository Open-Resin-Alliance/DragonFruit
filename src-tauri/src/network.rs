use crate::plugin_registry::PluginNetworkResponse;

pub use dragonfruit_rtsp_relay::RelayStatusResponse;

/// Default plugin network request handler that dispatches through registered plugins
#[tauri::command]
pub async fn plugin_network_request(request_json: String) -> Result<PluginNetworkResponse, String> {
    crate::plugin_registry::dispatch_network_request(request_json).await
}

/// Native RTSP relay status handler for desktop runtime.
#[tauri::command]
pub async fn ensure_rtsp_relay(rtsp_url: Option<String>) -> Result<RelayStatusResponse, String> {
    Ok(dragonfruit_rtsp_relay::ensure_rtsp_relay_status(
        rtsp_url.as_deref(),
    ))
}
