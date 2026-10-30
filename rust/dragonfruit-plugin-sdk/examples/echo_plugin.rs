//! Reference plugin: a network-only integration that echoes what it is asked.
//!
//! Used by the host's spawner test, so it stays deliberately small: handshake,
//! one operation, one answer. Real plugins replace `Echo` with their protocol.
//!
//! ```text
//! cargo build --manifest-path rust/dragonfruit-plugin-sdk/Cargo.toml --example echo_plugin
//! ```

use std::io::Write;

use dragonfruit_plugin_sdk::{serve, Capability, FormatDecl, PluginCapabilities, PluginIdentity};

struct Echo;

impl PluginIdentity for Echo {
    fn plugin_id(&self) -> &str {
        "example.echo"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::NetworkOperations]
    }

    fn formats(&self) -> Vec<FormatDecl> {
        Vec::new()
    }
}

impl PluginCapabilities for Echo {
    fn network(&self, request: serde_json::Value) -> (u16, serde_json::Value) {
        let operation = request
            .get("operation")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim_matches('/');

        match operation {
            "printer/status" => (
                200,
                serde_json::json!({ "state": "printing", "layer": 312, "total": 740 }),
            ),
            "echo" => (200, serde_json::json!({ "echoed": request })),
            other => (
                404,
                serde_json::json!({ "error": format!("unknown operation: {other}") }),
            ),
        }
    }
}

fn main() {
    // The control channel owns stdout. Diagnostics go to stderr, which the host
    // captures into the app log.
    let _ = writeln!(std::io::stderr(), "echo plugin: starting");
    serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        &Echo,
        &Echo,
    )
    .expect("control channel");
}
