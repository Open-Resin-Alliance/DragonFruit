//! Encoding utilities for V3:
//! - per-layer grayscale PNG encoding
//!
//! Container-specific archive assembly lives in encoder modules under
//! `src/encoders/`.

use crate::engine::SlicerV3Error;

fn parse_png_compression(strategy: &str) -> png::Compression {
    match strategy {
        "smallest" | "optimal" => png::Compression::Best,
        "balanced" => png::Compression::Default,
        _ => png::Compression::Fast,
    }
}

fn parse_png_filter(strategy: &str) -> png::FilterType {
    match strategy {
        "smallest" | "optimal" => png::FilterType::Paeth,
        _ => png::FilterType::NoFilter,
    }
}

pub fn encode_grayscale_png(
    width: u32,
    height: u32,
    pixels: &[u8],
    png_compression_strategy: &str,
) -> Result<Vec<u8>, SlicerV3Error> {
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
