//! Length-prefixed frames on the control channel.
//!
//! ```text
//! frame := u32 length (LE, includes the kind byte) | u8 kind | payload[length - 1]
//! ```
//!
//! Length includes the kind byte so a frame can never be empty, and a reader
//! rejects a length it cannot trust before allocating.

use std::io::{self, Read, Write};

/// Upper bound for a control frame. JSON control messages are a few KB; bulk
/// layer data goes through the shared ring, or through `Bulk` frames only in
/// pipe mode (where each layer is still one frame, so the cap is generous).
pub const MAX_FRAME_BYTES: u32 = 64 * 1024 * 1024;

const KIND_JSON: u8 = 0;
const KIND_BULK: u8 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Json,
    Bulk,
}

impl FrameKind {
    fn to_wire(self) -> u8 {
        match self {
            Self::Json => KIND_JSON,
            Self::Bulk => KIND_BULK,
        }
    }

    fn from_wire(value: u8) -> Result<Self, FrameError> {
        match value {
            KIND_JSON => Ok(Self::Json),
            KIND_BULK => Ok(Self::Bulk),
            other => Err(FrameError::UnknownKind(other)),
        }
    }
}

#[derive(Debug)]
pub struct Frame {
    pub kind: FrameKind,
    pub payload: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum FrameError {
    /// The peer closed the channel between frames. Not an error: the host is gone.
    Closed,
    UnknownKind(u8),
    TooLarge(u32),
    Io(String),
    /// Bytes where a frame should start, but not a complete frame.
    Truncated,
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Closed => write!(f, "control channel closed"),
            Self::UnknownKind(kind) => write!(f, "unknown frame kind {kind}"),
            Self::TooLarge(bytes) => write!(f, "frame of {bytes} bytes exceeds {MAX_FRAME_BYTES}"),
            Self::Io(detail) => write!(f, "control channel I/O error: {detail}"),
            Self::Truncated => write!(f, "control channel ended mid-frame"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            Self::Truncated
        } else {
            Self::Io(error.to_string())
        }
    }
}

pub fn write_frame<W: Write>(writer: &mut W, kind: FrameKind, payload: &[u8]) -> Result<(), FrameError> {
    let length = payload
        .len()
        .checked_add(1)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value <= MAX_FRAME_BYTES)
        .ok_or(FrameError::TooLarge(payload.len() as u32))?;
    writer
        .write_all(&length.to_le_bytes())
        .map_err(FrameError::from)?;
    writer.write_all(&[kind.to_wire()]).map_err(FrameError::from)?;
    writer.write_all(payload).map_err(FrameError::from)?;
    writer.flush().map_err(FrameError::from)
}

/// Reads one frame. `Ok(None)` means the peer closed cleanly between frames.
pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Frame>, FrameError> {
    let mut length_bytes = [0u8; 4];
    match reader.read_exact(&mut length_bytes) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(FrameError::from(error)),
    }
    let length = u32::from_le_bytes(length_bytes);
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(length));
    }

    let mut kind_byte = [0u8; 1];
    reader.read_exact(&mut kind_byte).map_err(FrameError::from)?;
    let kind = FrameKind::from_wire(kind_byte[0])?;

    let mut payload = vec![0u8; (length - 1) as usize];
    reader.read_exact(&mut payload).map_err(FrameError::from)?;
    Ok(Some(Frame { kind, payload }))
}

/// JSON helpers: the control channel is JSON, and framing it is the only thing a
/// plugin should have to think about.
pub(crate) fn write_json<W: Write, T: serde::Serialize>(
    writer: &mut W,
    message: &T,
) -> Result<(), FrameError> {
    let payload = serde_json::to_vec(message).map_err(|error| FrameError::Io(error.to_string()))?;
    write_frame(writer, FrameKind::Json, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_round_trips() {
        let mut buffer = Vec::new();
        write_frame(&mut buffer, FrameKind::Json, b"{\"type\":\"hello\"}").expect("write");
        let mut cursor = std::io::Cursor::new(buffer);
        let frame = read_frame(&mut cursor).expect("read").expect("frame");
        assert_eq!(frame.kind, FrameKind::Json);
        assert_eq!(frame.payload, b"{\"type\":\"hello\"}");
    }

    #[test]
    fn clean_close_is_not_an_error() {
        let mut empty = std::io::Cursor::new(Vec::new());
        assert!(read_frame(&mut empty).expect("read").is_none());
    }

    #[test]
    fn an_unknown_kind_is_refused() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&2u32.to_le_bytes());
        bytes.push(9);
        bytes.push(b'x');
        let mut cursor = std::io::Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).unwrap_err(), FrameError::UnknownKind(9));
    }

    #[test]
    fn oversized_and_empty_frames_are_refused() {
        let mut too_big = std::io::Cursor::new((MAX_FRAME_BYTES + 1).to_le_bytes().to_vec());
        assert!(matches!(read_frame(&mut too_big), Err(FrameError::TooLarge(_))));

        let mut zero = std::io::Cursor::new(0u32.to_le_bytes().to_vec());
        assert!(matches!(read_frame(&mut zero), Err(FrameError::TooLarge(0))));
    }

    #[test]
    fn a_truncated_payload_is_reported() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&6u32.to_le_bytes());
        bytes.push(KIND_JSON);
        bytes.extend_from_slice(b"abc");
        let mut cursor = std::io::Cursor::new(bytes);
        assert_eq!(read_frame(&mut cursor).unwrap_err(), FrameError::Truncated);
    }
}
