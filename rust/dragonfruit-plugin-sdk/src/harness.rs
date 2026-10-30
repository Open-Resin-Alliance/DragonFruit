//! The plugin-side control loop.
//!
//! `serve` owns the handshake so a plugin's `main` is one line: read `hello`,
//! answer `ready` with the identity the host pinned, then stay alive until
//! `shutdown`. A protocol version the host does not know is answered with an
//! `error` frame and a clean exit, never a guess.

use std::io::{self, Read, Write};

use crate::frame::{read_frame, write_json, FrameError, FrameKind};
use crate::protocol::{Capability, FormatDecl, HostMessage, PluginMessage};
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

/// Runs the control channel. Returns when the host says `shutdown` or closes the
/// channel; an `Err` means the exchange was malformed.
pub fn serve<R: Read, W: Write>(
    mut input: R,
    mut output: W,
    identity: &dyn PluginIdentity,
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

    loop {
        match read_frame(&mut input) {
            Ok(Some(frame)) if frame.kind == FrameKind::Bulk => {
                return fail(&mut output, "unexpected-frame", "bulk frames are not part of the handshake");
            }
            Ok(Some(frame)) => {
                match serde_json::from_slice::<HostMessage>(&frame.payload) {
                    Ok(HostMessage::Shutdown) => return Ok(()),
                    Ok(HostMessage::Hello { .. }) => {
                        return fail(&mut output, "unexpected-frame", "the handshake was already answered");
                    }
                    Err(error) => {
                        return fail(&mut output, "malformed-message", &format!("not a control message: {error}"));
                    }
                }
            }
            Ok(None) => return Ok(()),
            Err(FrameError::Closed) => return Ok(()),
            Err(error) => return Err(io::Error::other(error.to_string())),
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
    use crate::frame::write_json;
    use crate::protocol::Transport;

    struct TestPlugin;

    impl PluginIdentity for TestPlugin {
        fn plugin_id(&self) -> &str {
            "printbio.multimaterial"
        }
        fn version(&self) -> &str {
            "0.1.0-p0"
        }
        fn capabilities(&self) -> Vec<Capability> {
            vec![Capability::SlicerEncoder]
        }
        fn formats(&self) -> Vec<FormatDecl> {
            vec![FormatDecl {
                ext: ".pbm".to_string(),
            }]
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
        serve(&mut input, &mut output, &TestPlugin).expect("serve");
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
                assert_eq!(capabilities, &vec![Capability::SlicerEncoder]);
                assert_eq!(formats[0].ext, ".pbm");
            }
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn refuses_a_protocol_it_does_not_speak() {
        let mut input = std::io::Cursor::new(hello(99));
        let mut output = Vec::new();
        assert!(serve(&mut input, &mut output, &TestPlugin).is_err());
        match &sent_messages(&output)[0] {
            PluginMessage::Error { code, .. } => assert_eq!(code, "unsupported-protocol"),
            other => panic!("expected error, got {other:?}"),
        }
    }

    #[test]
    fn a_closed_channel_ends_quietly() {
        let mut input = std::io::Cursor::new(Vec::new());
        let mut output = Vec::new();
        serve(&mut input, &mut output, &TestPlugin).expect("serve");
        assert!(output.is_empty());
    }

    #[test]
    fn shutdown_ends_the_session_after_ready() {
        let mut bytes = hello(PROTOCOL_VERSION);
        write_json(&mut bytes, &HostMessage::Shutdown).expect("shutdown");
        let mut input = std::io::Cursor::new(bytes);
        let mut output = Vec::new();
        serve(&mut input, &mut output, &TestPlugin).expect("serve");
        let messages = sent_messages(&output);
        assert_eq!(messages.len(), 1, "only ready should be sent");
        assert!(matches!(messages[0], PluginMessage::Ready { .. }));
    }

    #[test]
    fn a_second_hello_is_a_protocol_error() {
        let mut bytes = hello(PROTOCOL_VERSION);
        bytes.extend_from_slice(&hello(PROTOCOL_VERSION));
        let mut input = std::io::Cursor::new(bytes);
        let mut output = Vec::new();
        assert!(serve(&mut input, &mut output, &TestPlugin).is_err());
        let messages = sent_messages(&output);
        assert!(matches!(messages[0], PluginMessage::Ready { .. }));
        match &messages[1] {
            PluginMessage::Error { code, .. } => assert_eq!(code, "unexpected-frame"),
            other => panic!("expected error, got {other:?}"),
        }
    }
}
