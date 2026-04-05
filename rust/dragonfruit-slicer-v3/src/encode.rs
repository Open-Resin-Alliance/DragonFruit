//! Encoding utilities for V3:
//! - per-layer grayscale PNG encoding
//!
//! Container-specific archive assembly lives in encoder modules under
//! `src/encoders/`.

use crate::engine::SlicerV3Error;

fn parse_png_compression(strategy: &str) -> png::Compression {
    match strategy {
        "smallest" | "optimal" => png::Compression::Best,
        "balanced" => png::Compression::Fast,
        _ => png::Compression::Fast,
    }
}

fn parse_png_filter(strategy: &str) -> png::FilterType {
    match strategy {
        "smallest" | "optimal" => png::FilterType::Paeth,
        "balanced" => png::FilterType::Sub,
        _ => png::FilterType::NoFilter,
    }
}

pub fn encode_grayscale_png(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
) -> Result<Vec<u8>, SlicerV3Error> {
    let is_binary = pixels.iter().all(|&p| p == 0 || p == 255);

    if is_binary {
        return encode_binary_grayscale_png_1bit(width, height, pixels, png_compression_strategy);
    }

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(parse_png_compression(png_compression_strategy));
        encoder.set_filter(parse_png_filter(png_compression_strategy));
        let mut writer = encoder.write_header()?;
        writer.write_image_data(pixels)?;
    }
    Ok(out)
}

pub fn encode_binary_grayscale_png_1bit(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
) -> Result<Vec<u8>, SlicerV3Error> {
    let row_stride = width as usize;
    let packed_row_stride = (row_stride + 7) / 8;
    let mut packed = vec![0u8; packed_row_stride.saturating_mul(height as usize)];

    for y in 0..height as usize {
        let src_row = &pixels[y * row_stride..(y + 1) * row_stride];
        let dst_row = &mut packed[y * packed_row_stride..(y + 1) * packed_row_stride];

        // Process 8 pixels at a time into one packed byte.
        // This is autovectorization-friendly: no bit_index bookkeeping,
        // no branch per pixel, and the inner loop is a fixed-size reduction.
        let full_bytes = row_stride / 8;
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
            dst_row[i] = byte;
        }

        // Handle remaining pixels (< 8) in the last byte
        if !remainder.is_empty() {
            let mut byte = 0u8;
            for (j, &px) in remainder.iter().enumerate() {
                if px != 0 {
                    byte |= 1 << (7 - j);
                }
            }
            dst_row[full_bytes] = byte;
        }
    }

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Grayscale);
        encoder.set_depth(png::BitDepth::One);
        encoder.set_compression(parse_png_compression(png_compression_strategy));
        encoder.set_filter(parse_png_filter(png_compression_strategy));
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&packed)?;
    }
    Ok(out)
}
