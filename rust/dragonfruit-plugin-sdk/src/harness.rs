//! The plugin-side control loop.
//!
//! `serve` owns the handshake so a plugin's `main` is one line: read `hello`,
//! answer `ready` with the identity the host pinned, then answer capability
//! messages until `shutdown`. A protocol version the host does not know is
//! answered with an `error` frame and a clean exit, never a guess.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use crate::frame::{read_frame, write_json, FrameError, FrameKind};
use crate::protocol::{Capability, FormatDecl, HostMessage, PluginMessage};
use crate::ring::{read_layout, release_slot, slot_view, RingLayout, SlotKind};
use crate::PROTOCOL_VERSION;

/// What a plugin declares about itself. The host checks every field against the
/// manifest it imported, so a plugin cannot advertise a capability the package
/// did not declare.
pub trait PluginIdentity {
    fn plugin_id(&self) -> &str;
    fn version(&self) -> &str;
    fn capabilities(&self) -> Vec<Capability>;
    fn formats(&self) -> Vec<FormatDecl>;
}

/// What one encode session is told about itself. The destination path is not
/// here: it arrives with `finish`, because a streaming encoder only learns it
/// once every layer has been consumed.
pub struct EncodeStart<'a> {
    /// Extension the host is encoding for, leading dot: `.apf`.
    pub format: &'a str,
    /// Total layers the host will send, for progress and preallocation.
    pub layers: u32,
    /// The slice job: resolution, layer height, exposures, printer profile.
    pub job: &'a serde_json::Value,
}

/// One rasterised layer, borrowed from the ring.
pub struct LayerRef<'a> {
    pub index: u32,
    pub kind: SlotKind,
    pub width: u32,
    pub height: u32,
    pub bytes: &'a [u8],
}

/// A container writer. One instance per encode session; the host streams layers
/// in index order and the session ends when the declared count arrives.
pub trait Encoder {
    fn begin(&mut self, start: EncodeStart<'_>) -> Result<(), String>;
    fn layer(&mut self, layer: LayerRef<'_>) -> Result<(), String>;
    /// Writes the container to `output` and returns the number of bytes written.
    fn finish(&mut self, output: &Path) -> Result<u64, String>;
}

/// A file the host cannot parse. `import` reads `input` and writes the scene
/// container to `output`; the container format is specified in
/// `docs/dev/plugins-sdk/file-types.md`.
pub trait Importer {
    fn import(&mut self, input: &Path, output: &Path) -> Result<(), String>;
}

/// What a plugin can answer after the handshake. Capabilities are opt-in per
/// method, so a plugin that only encodes does not have to know the network
/// vocabulary, and vice versa.
pub trait PluginCapabilities {
    /// One network operation, request in and `(status, body)` out. Synchronous on
    /// purpose: the host sends one request at a time, so a handler owns the
    /// session for its duration.
    fn network(&self, request: serde_json::Value) -> (u16, serde_json::Value) {
        (
            404,
            serde_json::json!({ "error": format!("this plugin does not serve network operations: {request}") }),
        )
    }

    /// An encoder instance for one session, or `None` when the plugin does not
    /// encode.
    fn encoder(&self) -> Option<Box<dyn Encoder>> {
        None
    }

    /// An importer for a file this package declares, or `None` when it opens no
    /// files.
    fn importer(&self) -> Option<Box<dyn Importer>> {
        None
    }

    /// Decodes one layer's preview PNG from an encoded file. Not every format can:
    /// the default says so, and the host shows the preview it can get.
    fn preview(&self, _archive: &Path, _layer: u32) -> Result<Vec<u8>, String> {
        Err("this plugin does not provide layer previews".to_string())
    }
}

/// For a plugin that has nothing to answer yet.
pub struct NoCapabilities;

impl PluginCapabilities for NoCapabilities {}

struct EncodeState {
    id: u64,
    encoder: Box<dyn Encoder>,
    layout: RingLayout,
    expected: u32,
    received: u32,
}

/// Runs the control channel.
///
/// `ring` is the host's mapping, already opened by the caller (the SDK stays free
/// of mapping dependencies). It is required the moment the plugin claims a
/// format, and `None` is fine for a network-only plugin.
///
/// Returns when the host says `shutdown` or closes the channel; an `Err` means
/// the exchange was malformed.
pub fn serve<R: Read, W: Write, C: PluginCapabilities>(
    mut input: R,
    mut output: W,
    identity: &dyn PluginIdentity,
    capabilities: &C,
    mut ring: Option<&mut [u8]>,
) -> io::Result<()> {
    let hello = match read_frame(&mut input) {
        Ok(Some(frame)) => frame,
        Ok(None) => return Ok(()),
        Err(error) => return Err(io::Error::other(error.to_string())),
    };
    if hello.kind != FrameKind::Json {
        return fail(&mut output, "malformed-handshake", "expected a JSON hello frame");
    }

    let message: HostMessage = match serde_json::from_slice(&hello.payload) {
        Ok(message) => message,
        Err(error) => {
            return fail(&mut output, "malformed-handshake", &format!("hello is not a control message: {error}"));
        }
    };

    let proto = match message {
        HostMessage::Hello { proto, .. } => proto,
        HostMessage::Shutdown => return Ok(()),
        _ => {
            return fail(&mut output, "unexpected-frame", "a request arrived before the handshake completed");
        }
    };
    if proto != PROTOCOL_VERSION {
        return fail(
            &mut output,
            "unsupported-protocol",
            &format!("this plugin speaks protocol {PROTOCOL_VERSION}, the host offered {proto}"),
        );
    }

    let ready = PluginMessage::Ready {
        plugin_id: identity.plugin_id().to_string(),
        version: identity.version().to_string(),
        capabilities: identity.capabilities(),
        formats: identity.formats(),
    };
    write_json(&mut output, &ready).map_err(to_io)?;

    let mut session: Option<EncodeState> = None;

    loop {
        let frame = match read_frame(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) | Err(FrameError::Closed) => return Ok(()),
            Err(error) => return Err(io::Error::other(error.to_string())),
        };
        if frame.kind != FrameKind::Json {
            return fail(&mut output, "unexpected-frame", "bulk frames are not part of the control protocol");
        }

        let message: HostMessage = match serde_json::from_slice(&frame.payload) {
            Ok(message) => message,
            Err(error) => {
                return fail(&mut output, "malformed-message", &format!("not a control message: {error}"));
            }
        };

        match message {
            HostMessage::Shutdown => return Ok(()),
            HostMessage::Hello { .. } => {
                return fail(&mut output, "unexpected-frame", "the handshake was already answered");
            }
            HostMessage::Network { id, request } => {
                let (status, body) = capabilities.network(request);
                let result = PluginMessage::NetworkResult { id, status, body };
                write_json(&mut output, &result).map_err(to_io)?;
            }
            HostMessage::EncodeBegin {
                id,
                format,
                layers,
                job,
            } => {
                if session.is_some() {
                    return fail(&mut output, "encode-in-progress", "one encode session at a time");
                }
                let Some(ring_bytes) = ring.as_deref_mut() else {
                    return fail(&mut output, "ring-required", "this host offered no ring for layer data");
                };
                let layout = match read_layout(ring_bytes) {
                    Ok(layout) => layout,
                    Err(error) => return fail(&mut output, "ring-invalid", &error.to_string()),
                };
                let Some(mut encoder) = capabilities.encoder() else {
                    return fail(&mut output, "encoder-unsupported", "the plugin offers no encoder");
                };
                if let Err(message) = encoder.begin(EncodeStart {
                    format: &format,
                    layers,
                    job: &job,
                }) {
                    return fail(&mut output, "encode-failed", &message);
                }

                session = Some(EncodeState {
                    id,
                    encoder,
                    layout,
                    expected: layers,
                    received: 0,
                });
            }
            HostMessage::Preview { id, path, layer } => {
                match capabilities.preview(Path::new(&path), layer) {
                    Ok(png) => {
                        write_json(
                            &mut output,
                            &PluginMessage::PreviewPng {
                                id,
                                bytes: png.len() as u64,
                            },
                        )
                        .map_err(to_io)?;
                        crate::frame::write_frame(&mut output, FrameKind::Bulk, &png)
                            .map_err(to_io)?;
                    }
                    Err(message) => return fail(&mut output, "preview-unsupported", &message),
                }
            }
            HostMessage::EncodeEnd { id, output: target } => {
                let Some(mut state) = session.take() else {
                    return fail(&mut output, "unexpected-frame", "no encode session to finish");
                };
                if state.id != id {
                    return fail(&mut output, "unexpected-frame", "end id does not match the session");
                }
                match state.encoder.finish(Path::new(&target)) {
                    Ok(bytes) => {
                        write_json(
                            &mut output,
                            &PluginMessage::EncodeDone {
                                id,
                                path: target,
                                bytes,
                            },
                        )
                        .map_err(to_io)?;
                    }
                    Err(message) => return fail(&mut output, "encode-failed", &message),
                }
            }
            HostMessage::EncodeLayer {
                id,
                index,
                slot,
                kind,
                bytes,
            } => {
                let Some(state) = session.as_mut() else {
                    return fail(&mut output, "unexpected-frame", "a layer arrived with no encode session");
                };
                if state.id != id {
                    return fail(&mut output, "unexpected-frame", "layer id does not match the session");
                }
                let Some(ring_bytes) = ring.as_deref_mut() else {
                    return fail(&mut output, "ring-required", "this host offered no ring for layer data");
                };

                {
                    let view = match slot_view(ring_bytes, &state.layout, slot) {
                        Ok(Some(view)) => view,
                        Ok(None) => {
                            return fail(&mut output, "slot-empty", "the published slot holds nothing");
                        }
                        Err(error) => return fail(&mut output, "ring-invalid", &error.to_string()),
                    };
                    if view.layer_index != index || view.kind != kind || view.payload.len() as u64 != bytes {
                        return fail(&mut output, "slot-mismatch", "the slot does not match its announcement");
                    }
                    if let Err(message) = state.encoder.layer(LayerRef {
                        index: view.layer_index,
                        kind: view.kind,
                        width: view.width,
                        height: view.height,
                        bytes: view.payload,
                    }) {
                        return fail(&mut output, "encode-failed", &message);
                    }
                }

                if let Err(error) = release_slot(ring_bytes, &state.layout, slot) {
                    return fail(&mut output, "ring-invalid", &error.to_string());
                }
                write_json(&mut output, &PluginMessage::SlotFree { slot }).map_err(to_io)?;

                state.received += 1;
                write_json(
                    &mut output,
                    &PluginMessage::Progress {
                        id: state.id,
                        done: state.received,
                        total: state.expected,
                    },
                )
                .map_err(to_io)?;

            }
            HostMessage::Import {
                id,
                input,
                output: target,
            } => {
                let Some(mut importer) = capabilities.importer() else {
                    return fail(&mut output, "import-unsupported", "the plugin offers no importer");
                };
                let input_path = PathBuf::from(&input);
                let target_path = PathBuf::from(&target);
                match importer.import(&input_path, &target_path) {
                    Ok(()) => {
                        write_json(
                            &mut output,
                            &PluginMessage::ImportDone {
                                id,
                                path: target,
                            },
                        )
                        .map_err(to_io)?;
                    }
                    Err(message) => return fail(&mut output, "import-failed", &message),
                }
            }
            HostMessage::EncodeCancel { id } => {
                let matches = session.as_ref().map(|state| state.id == id).unwrap_or(false);
                if matches {
                    session = None;
                }
                write_json(&mut output, &PluginMessage::EncodeCancelled { id }).map_err(to_io)?;
            }
        }
    }
}

fn fail<W: Write>(output: &mut W, code: &str, message: &str) -> io::Result<()> {
    let error = PluginMessage::Error {
        code: code.to_string(),
        message: message.to_string(),
    };
    write_json(output, &error).map_err(to_io)?;
    Err(io::Error::other(format!("{code}: {message}")))
}

fn to_io(error: FrameError) -> io::Error {
    io::Error::other(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{read_frame, write_json};
    use crate::protocol::Transport;
    use crate::ring::{init_ring, publish_slot, RingLayout};

    struct TestPlugin;

    impl PluginIdentity for TestPlugin {
        fn plugin_id(&self) -> &str {
            "printbio.multimaterial"
        }
        fn version(&self) -> &str {
            "0.1.0-p0"
        }
        fn capabilities(&self) -> Vec<Capability> {
            vec![Capability::SlicerEncoder, Capability::NetworkOperations]
        }
        fn formats(&self) -> Vec<FormatDecl> {
            vec![FormatDecl {
                ext: ".pbm".to_string(),
            }]
        }
    }

    struct EchoNetwork;

    impl PluginCapabilities for EchoNetwork {
        fn network(&self, request: serde_json::Value) -> (u16, serde_json::Value) {
            let operation = request.get("operation").and_then(|value| value.as_str()).unwrap_or("");
            if operation == "printer/status" {
                (200, serde_json::json!({ "state": "printing" }))
            } else {
                (404, serde_json::json!({ "error": format!("unknown operation: {operation}") }))
            }
        }
    }

    #[derive(Default)]
    struct RecordingEncoder {
        layers: Vec<(u32, Vec<u8>)>,
        last_output: Option<PathBuf>,
    }

    impl Encoder for RecordingEncoder {
        fn begin(&mut self, _start: EncodeStart<'_>) -> Result<(), String> {
            Ok(())
        }
        fn layer(&mut self, layer: LayerRef<'_>) -> Result<(), String> {
            self.layers.push((layer.index, layer.bytes.to_vec()));
            Ok(())
        }
        fn finish(&mut self, output: &Path) -> Result<u64, String> {
            self.last_output = Some(output.to_path_buf());
            Ok(self.layers.iter().map(|(_, bytes)| bytes.len() as u64).sum())
        }
    }

    struct EncodePlugin;

    impl PluginCapabilities for EncodePlugin {
        fn encoder(&self) -> Option<Box<dyn Encoder>> {
            Some(Box::new(RecordingEncoder::default()))
        }
    }

    fn hello(proto: u32) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_json(
            &mut bytes,
            &HostMessage::Hello {
                proto,
                transport: Transport::Shm,
                app_version: "0.4.0".to_string(),
            },
        )
        .expect("hello");
        bytes
    }

    fn sent_messages(bytes: &[u8]) -> Vec<PluginMessage> {
        let mut cursor = std::io::Cursor::new(bytes.to_vec());
        let mut out = Vec::new();
        while let Some(frame) = read_frame(&mut cursor).expect("frame") {
            out.push(serde_json::from_slice(&frame.payload).expect("message"));
        }
        out
    }

    #[test]
    fn answers_a_handshake_with_its_identity() {
        let mut input = std::io::Cursor::new(hello(PROTOCOL_VERSION));
        let mut output = Vec::new();
        serve(&mut input, &mut output, &TestPlugin, &NoCapabilities, None).expect("serve");
        let messages = sent_messages(&output);
        assert_eq!(messages.len(), 1);
        match &messages[0] {
            PluginMessage::Ready {
                plugin_id,
                version,
                capabilities,
                formats,
            } => {
                assert_eq!(plugin_id, "printbio.multimaterial");
                assert_eq!(version, "0.1.0-p0");
                assert_eq!(capabilities.len(), 2);
                assert_eq!(formats[0].ext, ".pbm");
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn refuses_a_protocol_it_does_not_speak() {
        let mut input = std::io::Cursor::new(hello(99));
        let mut output = Vec::new();
        assert!(serve(&mut input, &mut output, &TestPlugin, &NoCapabilities, None).is_err());
        match &sent_messages(&output)[0] {
            PluginMessage::Error { code, .. } => assert_eq!(code, "unsupported-protocol"),
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn a_closed_channel_ends_quietly() {
        let mut input = std::io::Cursor::new(Vec::new());
        let mut output = Vec::new();
        serve(&mut input, &mut output, &TestPlugin, &NoCapabilities, None).expect("serve");
        assert!(output.is_empty());
    }

    #[test]
    fn shutdown_ends_the_session_after_ready() {
        let mut bytes = hello(PROTOCOL_VERSION);
        write_json(&mut bytes, &HostMessage::Shutdown).expect("shutdown");
        let mut input = std::io::Cursor::new(bytes);
        let mut output = Vec::new();
        serve(&mut input, &mut output, &TestPlugin, &NoCapabilities, None).expect("serve");
        let messages = sent_messages(&output);
        assert_eq!(messages.len(), 1, "only ready should be sent");
    }

    #[test]
    fn a_second_hello_is_a_protocol_error() {
        let mut bytes = hello(PROTOCOL_VERSION);
        bytes.extend_from_slice(&hello(PROTOCOL_VERSION));
        let mut input = std::io::Cursor::new(bytes);
        let mut output = Vec::new();
        assert!(serve(&mut input, &mut output, &TestPlugin, &NoCapabilities, None).is_err());
        let messages = sent_messages(&output);
        assert!(matches!(messages[0], PluginMessage::Ready { .. }));
        match &messages[1] {
            PluginMessage::Error { code, .. } => assert_eq!(code, "unexpected-frame"),
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn a_network_request_is_answered_with_its_correlation_id() {
        let mut bytes = hello(PROTOCOL_VERSION);
        write_json(
            &mut bytes,
            &HostMessage::Network {
                id: 11,
                request: serde_json::json!({ "operation": "printer/status" }),
            },
        )
        .expect("network");
        write_json(
            &mut bytes,
            &HostMessage::Network {
                id: 12,
                request: serde_json::json!({ "operation": "nope" }),
            },
        )
        .expect("second network");
        write_json(&mut bytes, &HostMessage::Shutdown).expect("shutdown");

        let mut input = std::io::Cursor::new(bytes);
        let mut output = Vec::new();
        serve(&mut input, &mut output, &TestPlugin, &EchoNetwork, None).expect("serve");

        let messages = sent_messages(&output);
        assert_eq!(messages.len(), 3, "ready plus two results");
        match &messages[1] {
            PluginMessage::NetworkResult { id, status, body } => {
                assert_eq!(*id, 11);
                assert_eq!(*status, 200);
                assert_eq!(body["state"], "printing");
            }
            other => panic!("expected a network result, got {other:?}"),
        }
        match &messages[2] {
            PluginMessage::NetworkResult { id, status, .. } => {
                assert_eq!(*id, 12);
                assert_eq!(*status, 404);
            }
            other => panic!("expected a network result, got {other:?}"),
        }
    }

    const LAYOUT: RingLayout = RingLayout::new(2, 4096);
    const RING_BYTES: usize = LAYOUT.bytes_needed();

    #[repr(align(4096))]
    struct Aligned([u8; RING_BYTES]);

    #[test]
    fn an_encode_session_reads_layers_out_of_the_ring() {
        let mut buffer = Box::new(Aligned([0u8; RING_BYTES]));
        init_ring(&mut buffer.0, LAYOUT).expect("init ring");

        let layers: [&[u8]; 2] = [b"first-layer", b"second-layer"];
        let mut bytes = hello(PROTOCOL_VERSION);
        write_json(
            &mut bytes,
            &HostMessage::EncodeBegin {
                id: 7,
                format: ".pbm".to_string(),
                layers: layers.len() as u32,
                job: serde_json::json!({ "widthPx": 4096 }),
            },
        )
        .expect("begin");

        for (index, payload) in layers.iter().enumerate() {
            let slot = index as u32;
            publish_slot(&mut buffer.0, &LAYOUT, slot, SlotKind::Png, index as u32, payload, 4096, 2560)
                .expect("publish");
            write_json(
                &mut bytes,
                &HostMessage::EncodeLayer {
                    id: 7,
                    index: index as u32,
                    slot,
                    kind: SlotKind::Png,
                    bytes: payload.len() as u64,
                },
            )
            .expect("layer");
        }
        write_json(
            &mut bytes,
            &HostMessage::EncodeEnd {
                id: 7,
                output: "out.pbm".to_string(),
            },
        )
        .expect("end");
        write_json(&mut bytes, &HostMessage::Shutdown).expect("shutdown");

        let mut input = std::io::Cursor::new(bytes);
        let mut output = Vec::new();
        serve(
            &mut input,
            &mut output,
            &TestPlugin,
            &EncodePlugin,
            Some(&mut buffer.0[..]),
        )
        .expect("serve");

        let messages = sent_messages(&output);
        assert!(matches!(messages[0], PluginMessage::Ready { .. }));
        let freed: Vec<u32> = messages
            .iter()
            .filter_map(|message| match message {
                PluginMessage::SlotFree { slot } => Some(*slot),
                _ => None,
            })
            .collect();
        assert_eq!(freed, vec![0, 1], "every slot is handed back");

        let progress: Vec<(u32, u32)> = messages
            .iter()
            .filter_map(|message| match message {
                PluginMessage::Progress { done, total, .. } => Some((*done, *total)),
                _ => None,
            })
            .collect();
        assert_eq!(progress, vec![(1, 2), (2, 2)]);

        match messages.last().expect("done") {
            PluginMessage::EncodeDone { id, path, bytes } => {
                assert_eq!(*id, 7);
                assert_eq!(path, "out.pbm");
                assert_eq!(*bytes, 23, "11 + 12 bytes of layer payload");
            }
            other => panic!("expected encode done, got {other:?}"),
        }
        assert_eq!(
            crate::ring::slot_state(&buffer.0, &LAYOUT, 0).expect("state"),
            crate::ring::SlotState::Free
        );
    }
}
