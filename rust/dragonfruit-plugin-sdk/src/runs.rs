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

/// Borrowing iterator over a run payload.
///
/// A format that streams runs into its container never needs them collected: this
/// walks the wire bytes in place, without allocating.
#[derive(Debug, Clone)]
pub struct Runs<'a> {
    bytes: &'a [u8],
}

impl<'a> Runs<'a> {
    pub fn new(bytes: &'a [u8]) -> Result<Self, String> {
        if bytes.len() % RUN_BYTES != 0 {
            return Err(format!(
                "run payload of {} bytes is not a whole number of {RUN_BYTES}-byte runs",
                bytes.len()
            ));
        }
        Ok(Self { bytes })
    }

    pub fn len(&self) -> usize {
        self.bytes.len() / RUN_BYTES
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl Iterator for Runs<'_> {
    type Item = Run;

    fn next(&mut self) -> Option<Run> {
        if self.bytes.len() < RUN_BYTES {
            return None;
        }
        let (record, rest) = self.bytes.split_at(RUN_BYTES);
        self.bytes = rest;
        Some(Run {
            length: u32::from_le_bytes([record[0], record[1], record[2], record[3]]),
            value: record[4],
        })
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.len();
        (remaining, Some(remaining))
    }
}

impl ExactSizeIterator for Runs<'_> {}

/// Decodes a run payload into an owned vector. Prefer [`Runs`] on the hot path.
pub fn decode_runs(bytes: &[u8]) -> Result<Vec<Run>, String> {
    Ok(Runs::new(bytes)?.collect())
}

/// Appends runs in the wire form.
///
/// Each run is written with a single unaligned 8-byte store on a 5-byte stride:
/// the store covers its own record plus three bytes that the next store
/// overwrites, so only the last record needs slack. When the iterator reports an
/// exact length the buffer is reserved once and written through raw pointers; a
/// loose iterator falls back to per-record appends.
pub fn write_runs<I>(runs: I, out: &mut Vec<u8>)
where
    I: IntoIterator<Item = (u32, u8)>,
{
    let iterator = runs.into_iter();
    let (lower, upper) = iterator.size_hint();
    let exact = upper.filter(|upper| *upper == lower);

    let start = out.len();
    match exact {
        Some(count) => {
            out.reserve(count.saturating_mul(RUN_BYTES).saturating_add(8));
            let mut written = 0usize;
            unsafe {
                // SAFETY: the reservation above guarantees the capacity, and no
                // code inside this block pushes to `out`, so the pointer stays
                // valid. Every byte before `start + written * RUN_BYTES` is
                // written by one of the stores (each covers 8, the last 3 are
                // trimmed by `set_len`).
                let base = out.as_mut_ptr();
                for (length, value) in iterator {
                    let packed = length as u64 | ((value as u64) << 32);
                    std::ptr::write_unaligned(
                        base.add(start + written * RUN_BYTES) as *mut u64,
                        packed.to_le(),
                    );
                    written += 1;
                }
                out.set_len(start + written * RUN_BYTES);
            }
        }
        None => {
            for (length, value) in iterator {
                out.extend_from_slice(&length.to_le_bytes());
                out.push(value);
            }
        }
    }
}

/// Encodes runs to the wire form. Useful in tests and tooling; the hot path is
/// [`write_runs`], which reuses a buffer.
pub fn encode_runs(runs: &[Run]) -> Vec<u8> {
    let mut out = Vec::with_capacity(runs.len() * RUN_BYTES);
    write_runs(
        runs.iter().map(|run| (run.length, run.value)),
        &mut out,
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<Run> {
        vec![
            Run { length: 0, value: 0 },
            Run { length: 4096, value: 255 },
            Run { length: 7, value: 12 },
            Run { length: 1, value: 1 },
        ]
    }

    #[test]
    fn runs_round_trip() {
        let runs = sample();
        let bytes = encode_runs(&runs);
        assert_eq!(bytes.len(), runs.len() * RUN_BYTES);
        assert_eq!(decode_runs(&bytes).expect("decode"), runs);
    }

    #[test]
    fn the_iterator_borrows_and_reports_its_length() {
        let runs = sample();
        let bytes = encode_runs(&runs);
        let mut iterator = Runs::new(&bytes).expect("runs");
        assert_eq!(iterator.len(), runs.len());
        assert_eq!(iterator.size_hint(), (runs.len(), Some(runs.len())));
        assert_eq!(iterator.next(), Some(runs[0]));
        assert_eq!(iterator.len(), runs.len() - 1);
        assert_eq!(iterator.collect::<Vec<_>>(), runs[1..].to_vec());
    }

    #[test]
    fn a_partial_run_is_refused() {
        assert!(Runs::new(&[1, 2, 3]).is_err());
        assert!(decode_runs(&[1, 2, 3]).is_err());
    }

    #[test]
    fn an_empty_payload_is_a_valid_empty_layer() {
        assert!(Runs::new(&[]).expect("runs").is_empty());
        assert!(decode_runs(&[]).expect("decode").is_empty());
        assert!(encode_runs(&[]).is_empty());
    }

    #[test]
    fn write_runs_appends_without_disturbing_the_prefix() {
        let runs = sample();
        let mut out = b"header".to_vec();
        write_runs(runs.iter().map(|run| (run.length, run.value)), &mut out);
        assert_eq!(&out[..6], b"header");
        assert_eq!(decode_runs(&out[6..]).expect("decode"), runs);
    }

    #[test]
    fn the_overlapping_store_never_leaks_its_slack() {
        // One run: the store writes eight bytes and the last three must not
        // survive, or a reader would see a truncated extra record.
        let mut out = Vec::new();
        write_runs([(9u32, 3u8)], &mut out);
        assert_eq!(out, vec![9, 0, 0, 0, 3]);
        assert_eq!(Runs::new(&out).expect("runs").len(), 1);
    }

    #[test]
    fn a_loose_iterator_takes_the_append_path_and_matches_the_fast_one() {
        let runs = sample();
        let exact = encode_runs(&runs);

        // `filter` hides the length, so the slow path runs.
        let mut out = Vec::new();
        write_runs(
            runs.clone()
                .into_iter()
                .map(|run| (run.length, run.value))
                .filter(|_| true),
            &mut out,
        );
        assert_eq!(out, exact);
    }
}
