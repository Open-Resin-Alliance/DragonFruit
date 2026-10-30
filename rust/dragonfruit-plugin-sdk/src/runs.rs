//! The wire form of one layer's RLE runs.
//!
//! Layer payloads of kind `rle` are a flat little-endian sequence of
//! `u32 length | u8 value`, which is the engine's own run shape with nothing
//! added. A run-length format can consume it without decoding an image, which is
//! why it is the cheaper transport: a full-width solid layer is one run, where a
//! PNG of the same layer is a megabyte of pixels.

use serde::{Deserialize, Serialize};

/// One run: `length` pixels of `value`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub length: u32,
    pub value: u8,
}

pub const RUN_BYTES: usize = 5;

/// Decodes a run payload. Whitespace and padding are not part of the format, so a
/// trailing partial run is an error rather than something to ignore.
pub fn decode_runs(bytes: &[u8]) -> Result<Vec<Run>, String> {
    if bytes.len() % RUN_BYTES != 0 {
        return Err(format!(
            "run payload of {} bytes is not a whole number of {RUN_BYTES}-byte runs",
            bytes.len()
        ));
    }
    let mut runs = Vec::with_capacity(bytes.len() / RUN_BYTES);
    for chunk in bytes.chunks_exact(RUN_BYTES) {
        let length = u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        runs.push(Run {
            length,
            value: chunk[4],
        });
    }
    Ok(runs)
}

/// Encodes runs back to the wire form. Mostly useful in tests and tooling.
pub fn encode_runs(runs: &[Run]) -> Vec<u8> {
    let mut out = Vec::with_capacity(runs.len() * RUN_BYTES);
    for run in runs {
        out.extend_from_slice(&run.length.to_le_bytes());
        out.push(run.value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_round_trip() {
        let runs = vec![
            Run { length: 0, value: 0 },
            Run { length: 4096, value: 255 },
            Run { length: 7, value: 12 },
        ];
        let bytes = encode_runs(&runs);
        assert_eq!(bytes.len(), runs.len() * RUN_BYTES);
        assert_eq!(decode_runs(&bytes).expect("decode"), runs);
    }

    #[test]
    fn a_partial_run_is_refused() {
        assert!(decode_runs(&[1, 2, 3]).is_err());
    }

    #[test]
    fn an_empty_payload_is_a_valid_empty_layer() {
        assert!(decode_runs(&[]).expect("decode").is_empty());
    }
}
