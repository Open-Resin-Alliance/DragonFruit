//! Fast PNG encoding for V3 layer masks.
//!
//! Uses hand-rolled PNG chunk assembly (signature + IHDR + IDAT + IEND) with
//! libdeflate zlib compression (3-5× faster than miniz_oxide) and crc32fast
//! for hardware-accelerated chunk CRCs.
//!
//! Container-specific archive assembly lives in encoder modules under
//! `src/encoders/`.

use crate::engine::SlicerV3Error;
use crc32fast::Hasher as Crc32Hasher;
use libdeflater::{CompressionLvl, Compressor};

const PNG_SIG: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

fn png_compression_level(strategy: &str) -> CompressionLvl {
    match strategy {
        "smallest" | "optimal" => CompressionLvl::new(6).unwrap_or(CompressionLvl::best()),
        _ => CompressionLvl::fastest(),
    }
}

fn chunk_crc32(type_bytes: &[u8; 4], data: &[u8]) -> u32 {
    let mut h = Crc32Hasher::new();
    h.update(type_bytes);
    h.update(data);
    h.finalize()
}

fn write_chunk(out: &mut Vec<u8>, type_bytes: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(type_bytes);
    out.extend_from_slice(data);
    out.extend_from_slice(&chunk_crc32(type_bytes, data).to_be_bytes());
}

fn write_ihdr(out: &mut Vec<u8>, width: u32, height: u32, bit_depth: u8) {
    let mut ihdr = [0u8; 13];
    ihdr[0..4].copy_from_slice(&width.to_be_bytes());
    ihdr[4..8].copy_from_slice(&height.to_be_bytes());
    ihdr[8] = bit_depth;
    ihdr[9] = 0; // color type: Grayscale
    ihdr[10] = 0; // compression: deflate
    ihdr[11] = 0; // filter: adaptive
    ihdr[12] = 0; // interlace: none
    write_chunk(out, b"IHDR", &ihdr);
}

fn zlib_compress(data: &[u8], level: CompressionLvl) -> Result<Vec<u8>, SlicerV3Error> {
    let mut compressor = Compressor::new(level);
    let max_size = compressor.zlib_compress_bound(data.len());
    let mut buf = vec![0u8; max_size];
    let actual = compressor
        .zlib_compress(data, &mut buf)
        .map_err(|e| SlicerV3Error::Png(e.to_string()))?;
    buf.truncate(actual);
    Ok(buf)
}

/// Encode a grayscale pixel mask to PNG.
///
/// Pass `is_binary = true` when the caller already knows all pixels are 0 or
/// 255 (e.g. AA is off). This skips the full-buffer scan and emits a compact
/// 1-bit PNG. When `false`, emits an 8-bit grayscale PNG with Sub filtering.
pub fn encode_grayscale_png(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
    is_binary: bool,
) -> Result<Vec<u8>, SlicerV3Error> {
    if is_binary {
        encode_binary_grayscale_png_1bit(width, height, pixels, png_compression_strategy)
    } else {
        encode_grayscale_png_8bit(width, height, pixels, png_compression_strategy)
    }
}

/// Encode an 8-bit grayscale (AA) layer PNG with Sub filter + libdeflate.
pub fn encode_grayscale_png_8bit(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
) -> Result<Vec<u8>, SlicerV3Error> {
    let w = width as usize;
    let h = height as usize;
    // Sub filter (type=1) for AA: filt[i] = raw[i] - raw[i-1], good for gradients.
    // "fastest" falls back to no-filter for maximum speed.
    let use_sub = !matches!(png_compression_strategy, "fastest");
    let row_bytes = 1 + w;
    let mut filtered = vec![0u8; row_bytes * h];

    for y in 0..h {
        let src = &pixels[y * w..(y + 1) * w];
        let dst = &mut filtered[y * row_bytes..(y + 1) * row_bytes];
        if use_sub {
            dst[0] = 1; // Sub
            dst[1] = src[0];
            for i in 1..w {
                dst[i + 1] = src[i].wrapping_sub(src[i - 1]);
            }
        } else {
            dst[0] = 0; // None
            dst[1..].copy_from_slice(src);
        }
    }

    let level = png_compression_level(png_compression_strategy);
    let compressed = zlib_compress(&filtered, level)?;

    let mut out = Vec::with_capacity(8 + 25 + 12 + compressed.len() + 12);
    out.extend_from_slice(&PNG_SIG);
    write_ihdr(&mut out, width, height, 8);
    write_chunk(&mut out, b"IDAT", &compressed);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}

/// Encode a binary (all-0/all-255) grayscale mask as a compact 1-bit PNG.
pub fn encode_binary_grayscale_png_1bit(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
) -> Result<Vec<u8>, SlicerV3Error> {
    let w = width as usize;
    let h = height as usize;
    let packed_row = (w + 7) / 8;
    // Filtered scanlines: 1 filter byte (None=0) + packed bits per row.
    let row_bytes = 1 + packed_row;
    let mut filtered = vec![0u8; row_bytes * h];

    for y in 0..h {
        let src_row = &pixels[y * w..(y + 1) * w];
        let dst_row = &mut filtered[y * row_bytes..(y + 1) * row_bytes];
        dst_row[0] = 0; // filter type: None — optimal for binary runs

        let full_bytes = w / 8;
        let src_chunks = src_row.chunks_exact(8);
        let remainder = src_chunks.remainder();

        for (i, chunk) in src_chunks.enumerate() {
            let mut byte = 0u8;
            byte |= (chunk[0] != 0) as u8 * 128;
            byte |= (chunk[1] != 0) as u8 * 64;
            byte |= (chunk[2] != 0) as u8 * 32;
            byte |= (chunk[3] != 0) as u8 * 16;
            byte |= (chunk[4] != 0) as u8 * 8;
            byte |= (chunk[5] != 0) as u8 * 4;
            byte |= (chunk[6] != 0) as u8 * 2;
            byte |= (chunk[7] != 0) as u8;
            dst_row[i + 1] = byte;
        }

        if !remainder.is_empty() {
            let mut byte = 0u8;
            for (j, &px) in remainder.iter().enumerate() {
                if px != 0 {
                    byte |= 1 << (7 - j);
                }
            }
            dst_row[full_bytes + 1] = byte;
        }
    }

    let level = png_compression_level(png_compression_strategy);
    let compressed = zlib_compress(&filtered, level)?;

    let mut out = Vec::with_capacity(8 + 25 + 12 + compressed.len() + 12);
    out.extend_from_slice(&PNG_SIG);
    write_ihdr(&mut out, width, height, 1);
    write_chunk(&mut out, b"IDAT", &compressed);
    write_chunk(&mut out, b"IEND", &[]);
    Ok(out)
}
