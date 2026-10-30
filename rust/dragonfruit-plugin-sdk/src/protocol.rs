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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum HostMessage {
    #[serde(rename_all = "camelCase")]
    Hello {
        proto: u32,
        transport: Transport,
        app_version: String,
    },
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
