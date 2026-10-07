use std::borrow::Cow;
use std::time::Instant;

pub const MAX_DECODED_MESH_BYTES: usize = 256 * 1024 * 1024;

fn decoded_length(bytes: &[u8]) -> Result<usize, String> {
    let prefix = bytes
        .get(..4)
        .ok_or("LZ4 mesh body is missing its decoded-size prefix")?;
    let length = u32::from_le_bytes([prefix[0], prefix[1], prefix[2], prefix[3]]) as usize;
    if length == 0 || length > MAX_DECODED_MESH_BYTES {
        return Err(format!(
            "LZ4 mesh decoded size must be between 1 and {MAX_DECODED_MESH_BYTES} bytes, got {length}"
        ));
    }
    Ok(length)
}

/// Decode transport bytes without interpreting or changing the packed geometry.
/// An absent header keeps the legacy body borrowed; only the exact `lz4` tag is accepted.
/// LZ4 bodies contain a little-endian u32 decoded size followed by a standard block.
/// The returned nanoseconds include validation, allocation, and decompression, not staging.
/// Callers must finish this step before mutating any shared staging buffer or file.
pub fn decode_mesh_body<'a>(
    bytes: &'a [u8],
    compression: Option<&str>,
) -> Result<(Cow<'a, [u8]>, u64), String> {
    match compression {
        None => return Ok((Cow::Borrowed(bytes), 0)),
        Some("lz4") => {}
        Some(tag) => return Err(format!("Invalid x-mesh-compression header value: {tag:?}")),
    }

    let decode_start = Instant::now();
    let length = decoded_length(bytes)?;
    let block = &bytes[4..];
    if block.is_empty() {
        return Err("LZ4 mesh body is missing its compressed block".into());
    }
    let mut decoded = vec![0; length];
    let actual_length = lz4_flex::block::decompress_into(block, &mut decoded)
        .map_err(|error| format!("Invalid LZ4 mesh block: {error}"))?;
    if actual_length != length {
        return Err(format!(
            "LZ4 mesh decoded-size mismatch: declared {length}, decoded {actual_length}"
        ));
    }
    let decode_ns = decode_start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
    Ok((Cow::Owned(decoded), decode_ns))
}

#[cfg(test)]
mod tests {
    use super::{decode_mesh_body, decoded_length, MAX_DECODED_MESH_BYTES};

    // Generated independently with the real lz4-wasm@0.9.2 compress export, not
    // lz4_flex. The input repeats FLOAT_BITS four times, written as u32 LE bytes.
    const WASM_BLOCK: &[u8] = &[
        0xc0, 0x00, 0x00, 0x00, 0x12, 0x00, 0x01, 0x00, 0xf0, 0x15, 0x80, 0x01,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x80, 0x00, 0x00, 0x80, 0x3f, 0x00,
        0x00, 0x80, 0xbf, 0x00, 0x00, 0x80, 0x7f, 0x00, 0x00, 0x80, 0xff, 0x45,
        0x23, 0xc1, 0x7f, 0x45, 0x23, 0xa1, 0x7f, 0xff, 0xff, 0x7f, 0x10, 0x00,
        0x02, 0x2e, 0x00, 0x0f, 0x30, 0x00, 0x72, 0x60, 0x7f, 0x7f, 0x00, 0x00,
        0x80, 0x00,
    ];
    const FLOAT_BITS: [u32; 12] = [
        0x0000_0000, 0x8000_0000, 0x0000_0001, 0x8000_0001,
        0x3f80_0000, 0xbf80_0000, 0x7f80_0000, 0xff80_0000,
        0x7fc1_2345, 0x7fa1_2345, 0x7f7f_ffff, 0x0080_0000,
    ];


    #[test]
    fn wasm_fixture_preserves_all_float_bits_and_order() {
        let (decoded, _) = decode_mesh_body(WASM_BLOCK, Some("lz4")).unwrap();
        assert_eq!(decoded.len(), FLOAT_BITS.len() * 4 * 4);
        for (index, word) in decoded.chunks_exact(4).enumerate() {
            assert_eq!(word, FLOAT_BITS[index % FLOAT_BITS.len()].to_le_bytes());
        }
    }

    #[test]
    fn only_the_exact_compression_tag_is_accepted() {
        for tag in ["", "raw", "LZ4", " lz4", "lz4 ", "lz4,lz4", "lz4\n"] {
            let error = decode_mesh_body(WASM_BLOCK, Some(tag)).unwrap_err();
            assert!(error.contains("x-mesh-compression"));
        }
    }

    #[test]
    fn decoded_size_guard_accepts_only_positive_bounded_lengths() {
        // Exercise the inclusive upper boundary without a 256 MiB test allocation.
        for length in [1, MAX_DECODED_MESH_BYTES] {
            assert_eq!(decoded_length(&(length as u32).to_le_bytes()).unwrap(), length);
        }
        for length in [0, MAX_DECODED_MESH_BYTES + 1, u32::MAX as usize] {
            let prefix = (length as u32).to_le_bytes();
            assert!(decoded_length(&prefix).is_err());
            assert!(decode_mesh_body(&prefix, Some("lz4")).is_err());
        }
        let (decoded, _) = decode_mesh_body(&[1, 0, 0, 0, 0x10, 42], Some("lz4")).unwrap();
        assert_eq!(decoded.as_ref(), &[42]);
    }

    #[test]
    fn rejects_every_truncation_of_the_external_fixture() {
        for end in 0..WASM_BLOCK.len() {
            assert!(decode_mesh_body(&WASM_BLOCK[..end], Some("lz4")).is_err());
        }
    }

    #[test]
    fn rejects_wrong_decoded_lengths_and_trailing_garbage() {
        for length in [191_u32, 193] {
            let mut block = WASM_BLOCK.to_vec();
            block[..4].copy_from_slice(&length.to_le_bytes());
            assert!(decode_mesh_body(&block, Some("lz4")).is_err());
        }
        let mut block = WASM_BLOCK.to_vec();
        block.extend_from_slice(&[0, 0]);
        assert!(decode_mesh_body(&block, Some("lz4")).is_err());
    }

    #[test]
    fn rejects_invalid_matches_and_truncated_length_extensions() {
        let blocks: &[&[u8]] = &[
            &[1, 0, 0, 0],
            &[1, 0, 0, 0, 0x00],
            &[1, 0, 0, 0, 0xf0],
            &[1, 0, 0, 0, 0xf0, 0xff],
            &[1, 0, 0, 0, 0x20, 42, 43],
            &[12, 0, 0, 0, 0x10, 42, 0, 0, 0x70, 1, 2, 3, 4, 5, 6, 7],
            &[12, 0, 0, 0, 0x10, 42, 2, 0, 0x70, 1, 2, 3, 4, 5, 6, 7],
            &[12, 0, 0, 0, 0x1f, 42, 1, 0],
        ];
        for block in blocks {
            assert!(decode_mesh_body(block, Some("lz4")).is_err(), "{block:?}");
        }
    }
}
