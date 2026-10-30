//! Control messages. These are the only shapes either side may send today.
//!
//! Wire shape is JSON with a `type` tag, camelCase fields:
//!
//! ```json
//! {"type":"hello","proto":1,"transport":"shm","appVersion":"0.4.0"}
//! {"type":"ready","pluginId":"printbio.multimaterial","version":"0.1.0-p0",
//!  "capabilities":["slicerEncoder"],"formats":[{"ext":".pbm"}]}
//! {"type":"shutdown"}
//! {"type":"error","code":"unsupported-protocol","message":"…"}
//! ```

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    SlicerEncoder,
    NetworkOperations,
    FileType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Transport {
    /// Bulk bytes cross the shared ring; the pipe carries control only.
    Shm,
    /// Bulk bytes cross the pipe as `Bulk` frames.
    Pipe,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatDecl {
    /// Extension the encoder claims, leading dot: `.pbm`.
    pub ext: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostMessage {
    #[serde(rename_all = "camelCase")]
    Hello {
        proto: u32,
        transport: Transport,
        app_version: String,
    },
    Shutdown,
    /// One network operation. `id` is the host's correlation id; the answer is a
    /// `networkResult` carrying the same id.
    #[serde(rename_all = "camelCase")]
    Network {
        id: u64,
        request: serde_json::Value,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PluginMessage {
    #[serde(rename_all = "camelCase")]
    Ready {
        plugin_id: String,
        version: String,
        capabilities: Vec<Capability>,
        formats: Vec<FormatDecl>,
    },
    #[serde(rename_all = "camelCase")]
    NetworkResult {
        id: u64,
        status: u16,
        body: serde_json::Value,
    },
    #[serde(rename_all = "camelCase")]
    Error { code: String, message: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_uses_the_wire_casing() {
        let hello = HostMessage::Hello {
            proto: 1,
            transport: Transport::Shm,
            app_version: "0.4.0".to_string(),
        };
        let json = serde_json::to_string(&hello).expect("serialize");
        assert_eq!(
            json,
            r#"{"type":"hello","proto":1,"transport":"shm","appVersion":"0.4.0"}"#
        );
        assert_eq!(serde_json::from_str::<HostMessage>(&json).unwrap(), hello);
    }

    #[test]
    fn network_messages_use_the_wire_casing() {
        let request = HostMessage::Network {
            id: 11,
            request: serde_json::json!({"operation":"printer/status"}),
        };
        assert_eq!(
            serde_json::to_string(&request).expect("serialize"),
            r#"{"type":"network","id":11,"request":{"operation":"printer/status"}}"#
        );

        let result = PluginMessage::NetworkResult {
            id: 11,
            status: 200,
            body: serde_json::json!({"state":"printing"}),
        };
        assert_eq!(
            serde_json::to_string(&result).expect("serialize"),
            r#"{"type":"networkResult","id":11,"status":200,"body":{"state":"printing"}}"#
        );
    }

    #[test]
    fn ready_uses_the_wire_casing() {
        let ready = PluginMessage::Ready {
            plugin_id: "printbio.multimaterial".to_string(),
            version: "0.1.0-p0".to_string(),
            capabilities: vec![Capability::SlicerEncoder],
            formats: vec![FormatDecl {
                ext: ".pbm".to_string(),
            }],
        };
        let json = serde_json::to_string(&ready).expect("serialize");
        assert_eq!(
            json,
            r#"{"type":"ready","pluginId":"printbio.multimaterial","version":"0.1.0-p0","capabilities":["slicerEncoder"],"formats":[{"ext":".pbm"}]}"#
        );
    }
}
