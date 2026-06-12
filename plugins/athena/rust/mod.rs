/// Athena plugin implementation
pub mod network;
pub mod plugin;

pub use plugin::{get_plugin_registration, AthenaFormatProvider};
pub use network::PluginNetworkResponse;
