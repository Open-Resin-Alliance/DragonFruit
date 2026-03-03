//! Encoding utilities for V3:
//! - per-layer grayscale PNG encoding
//! - `.nanodlp` archive assembly
//! - optional preview thumbnail selection

use crate::engine::SlicerV3Error;
use crate::types::SliceJobV3;
use base64::engine::general_purpose;
use base64::Engine;
use serde_json::json;
use std::io::Write;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

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

fn normalize_container_compression_level(raw: u8) -> i32 {
    (raw.min(9)) as i32
}

fn select_preview_png<'a>(layer_pngs: &'a [Vec<u8>]) -> Option<&'a [u8]> {
    let first = layer_pngs.first()?;
    for candidate in layer_pngs.iter().skip(1) {
        if candidate.len() != first.len() || candidate != first {
            return Some(candidate.as_slice());
        }
    }
    Some(first.as_slice())
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

/// Build final `.nanodlp` archive bytes from metadata + per-layer PNGs.
pub fn encode_nanodlp_archive(
    job: &SliceJobV3,
    layer_pngs: &[Vec<u8>],
) -> Result<Vec<u8>, SlicerV3Error> {
    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let meta_opt = FileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .compression_level(Some(normalize_container_compression_level(
                job.container_compression_level,
            )));
        let layer_opt = FileOptions::default().compression_method(CompressionMethod::Stored);

        let meta_json = json!({
            "format_version": 3,
            "distro": "dragonfruit",
            "program": "DragonFruit",
            "engine": "v3",
            "layer_count": job.total_layers,
        });

        zip.start_file("meta.json", meta_opt)?;
        zip.write_all(serde_json::to_vec_pretty(&meta_json)?.as_slice())?;

        zip.start_file("slicer.json", meta_opt)?;
        zip.write_all(job.metadata_json.as_bytes())?;

        for (idx, png) in layer_pngs.iter().enumerate() {
            let name = format!("{}.png", idx + 1);
            zip.start_file(name, layer_opt)?;
            zip.write_all(png)?;
        }

        let captured_preview_png = job
            .export_thumbnail_png_base64
            .as_ref()
            .and_then(|encoded| general_purpose::STANDARD.decode(encoded).ok())
            .filter(|bytes| !bytes.is_empty());

        if let Some(preview_png) = captured_preview_png
            .as_deref()
            .or_else(|| select_preview_png(layer_pngs))
        {
            zip.start_file("3d.png", layer_opt)?;
            zip.write_all(preview_png)?;

            zip.start_file("3d.png.meta", meta_opt)?;
            zip.write_all(b"{}")?;
        }

        zip.finish()?;
    }
    Ok(cursor.into_inner())
}
