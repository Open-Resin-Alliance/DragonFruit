/// Athena plugin implementation
pub mod network;
pub mod plugin;

pub use network::PluginNetworkResponse;
pub use plugin::{get_plugin_registration, AthenaFormatProvider};
