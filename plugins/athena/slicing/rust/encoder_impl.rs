//! Athena plugin-owned encoder implementation for V3.
//!
//! This file is compiled by the V3 crate via a path-based module include,
//! which keeps encoder source ownership with the Athena plugin.

use crate::encoders::{FormatEncoder, RleStreamEncoder};
use crate::engine::SlicerV3Error;
use crate::types::{LayerAreaStatsV3, RenderedLayersV3, SliceJobV3};
use base64::engine::general_purpose;
use base64::Engine;
use serde_json::{json, Value};
use std::io::{Seek, Write};
use std::path::Path;
use std::sync::Arc;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

pub struct AthenaPluginEncoder;

pub fn create_plugin_encoder() -> Vec<Box<dyn FormatEncoder>> {
    vec![Box::new(AthenaPluginEncoder)]
}

fn normalize_container_compression_level(raw: u8) -> i32 {
    (raw.min(9)) as i32
}

fn select_preview_png(layer_pngs: &[Vec<u8>]) -> Option<&[u8]> {
    let first = layer_pngs.first()?;
    for candidate in layer_pngs.iter().skip(1) {
        if candidate.len() != first.len() || candidate != first {
            return Some(candidate.as_slice());
        }
    }
    Some(first.as_slice())
}

fn json_at<'a>(root: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = root;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn json_string(root: &Value, path: &[&str], default: &str) -> String {
    json_at(root, path)
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| default.to_string())
}

fn json_f64(root: &Value, path: &[&str], default: f64) -> f64 {
    json_at(root, path)
        .and_then(Value::as_f64)
        .unwrap_or(default)
}

fn json_u32(root: &Value, path: &[&str], default: u32) -> u32 {
    json_at(root, path)
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .unwrap_or(default)
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn round4(value: f64) -> f64 {
    (value * 10000.0).round() / 10000.0
}

fn build_plate_json(
    total_solid_area: f64,
    layers_count: u32,
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    z_max: f64,
) -> Value {
    json!({
      "PlateID": 0,
      "ProfileID": 0,
      "Profile": null,
      "CreatedDate": 0,
      "Path": "",
      "PrintTime": 0,
      "LayerHeight": 0,
      "LayerThickness": 0,
      "TotalSolidArea": total_solid_area,
      "LayersCount": layers_count,
      "LayerCount": layers_count,
      "Processed": true,
      "Feedback": false,
      "ReSliceNeeded": false,
      "MC": {
        "StartX": 0, "StartY": 0, "Width": 0, "Height": 0,
        "X": null, "Y": null, "MultiCureGap": 0, "Count": 0,
      },
      "Boundary": {
        "XMin": x_min,
        "XMax": x_max,
        "YMin": y_min,
        "YMax": y_max,
        "ZMin": 0.0,
        "ZMax": z_max,
      },
      "XMin": x_min,
      "XMax": x_max,
      "YMin": y_min,
      "YMax": y_max,
      "ZMin": 0.0,
      "ZMax": z_max,
    })
}

fn build_profile_json(job: &SliceJobV3, metadata: &Value) -> Value {
    let printer_name = json_string(metadata, &["printer", "name"], "Imported");
    let source_name = json_string(metadata, &["mode"], "dragonfruit_v3");

    let normal_exposure = json_f64(metadata, &["material", "normalExposureSec"], 0.0);
    let bottom_exposure = json_f64(
        metadata,
        &["material", "bottomExposureSec"],
        normal_exposure,
    );
    let bottom_layers = json_u32(metadata, &["material", "bottomLayerCount"], 0);

    let lift_height = json_f64(metadata, &["material", "liftDistanceMm"], 0.0);
    let lift_speed = json_f64(metadata, &["material", "liftSpeedMmMin"], 0.0);
    let retract_speed = json_f64(metadata, &["material", "retractSpeedMmMin"], 0.0);
    let depth_um = round1((job.layer_height_mm as f64) * 1000.0);

    json!({
      "ResinID": 0,
      "ProfileID": 0,
      "Title": format!("DragonFruit — {}", printer_name),
      "Desc": format!("Imported from {} via DragonFruit", source_name),
      "Depth": depth_um,
      "SupportDepth": depth_um,
      "CureTime": normal_exposure,
      "SupportCureTime": bottom_exposure,
      "SupportLayerNumber": bottom_layers,
      "LiftSpeed": lift_speed,
      "RetractSpeed": retract_speed,
      "WaitHeight": lift_height,
      "SupportWaitHeight": lift_height,
      "WaitBeforePrint": 0.0,
      "WaitAfterPrint": 0.4,
      "SupportWaitBeforePrint": 0.0,
      "SupportWaitAfterPrint": 1.0,
      "Type": 0,
      "ManufacturerLock": false,
      "CustomValues": {},
      "Updated": 0,
    })
}

fn build_options_json(job: &SliceJobV3) -> Value {
    let x_pixel_mm = round3((job.build_width_mm as f64) / (job.source_width_px.max(1) as f64));
    let y_pixel_mm = round3((job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64));

    json!({
      "Type": "",
      "URL": "",
      "PWidth": job.source_width_px,
      "PHeight": job.source_height_px,
      "ScaleFactor": 0,
      "StartLayer": 0,
      "SupportDepth": round1((job.layer_height_mm as f64) * 1000.0),
      "Thickness": round1((job.layer_height_mm as f64) * 1000.0),
      "XOffset": (job.source_width_px / 2),
      "YOffset": (job.source_height_px / 2),
      "ZOffset": 0,
      "XPixelSize": x_pixel_mm,
      "YPixelSize": y_pixel_mm,
      "XRes": ((x_pixel_mm * 1000.0).round() as i64),
      "Mask": null,
      "AutoCenter": 0,
      "SliceFromZero": false,
      "DisableValidator": false,
      "PreviewGenerate": false,
      "Running": false,
      "Debug": false,
      "Boundary": {
        "XMin": 0.0, "XMax": 0.0, "YMin": 0.0, "YMax": 0.0,
        "ZMin": 0.0, "ZMax": 0.0,
      },
      "Area": {"PlateID": 0, "Layers": [], "Kill": false},
      "MC": {
        "StartX": 0, "StartY": 0, "Width": 0, "Height": 0,
        "X": null, "Y": null, "MultiCureGap": 0, "Count": 0,
      },
      "ImageMirror": 1,
      "DisplayController": 1,
      "PlateID": 0,
      "LayerID": 0,
      "LayerCount": 0,
      "UUID": "",
      "DynamicThickness": null,
      "SkipEmpty": 0,
    })
}

fn build_info_json(layer_area_stats: &[LayerAreaStatsV3]) -> Value {
    Value::Array(
        layer_area_stats
            .iter()
            .map(|s| {
                json!({
                    "TotalSolidArea": s.total_solid_area_mm2,
                    "LargestArea": s.largest_area_mm2,
                    "SmallestArea": s.smallest_area_mm2,
                    "MinX": s.min_x,
                    "MinY": s.min_y,
                    "MaxX": s.max_x,
                    "MaxY": s.max_y,
                    "AreaCount": s.area_count,
                })
            })
            .collect(),
    )
}

fn write_nanodlp_archive<W: Write + Seek>(
    writer: W,
    job: &SliceJobV3,
    layer_pngs: &[Vec<u8>],
    layer_area_stats: &[LayerAreaStatsV3],
    on_progress: Option<&dyn Fn(u32, u32)>,
) -> Result<(), SlicerV3Error> {
    let metadata: Value = serde_json::from_str(&job.metadata_json).unwrap_or(Value::Null);
    let layers_count = layer_pngs.len() as u32;

    // VoxelShift-compatible aggregate metric used by some NanoDLP UIs.
    let avg_layer_area_mm2 = if layer_area_stats.is_empty() {
        0.0
    } else {
        layer_area_stats
            .iter()
            .map(|s| s.total_solid_area_mm2)
            .sum::<f64>()
            / (layer_area_stats.len() as f64)
    };
    let total_solid_area =
        (avg_layer_area_mm2 * (job.layer_height_mm as f64) * (job.total_layers as f64)) / 1000.0;

    let mut pix_min_x = i32::MAX;
    let mut pix_min_y = i32::MAX;
    let mut pix_max_x = i32::MIN;
    let mut pix_max_y = i32::MIN;

    for stats in layer_area_stats.iter().filter(|s| s.area_count > 0) {
        pix_min_x = pix_min_x.min(stats.min_x);
        pix_min_y = pix_min_y.min(stats.min_y);
        pix_max_x = pix_max_x.max(stats.max_x);
        pix_max_y = pix_max_y.max(stats.max_y);
    }

    let half_w = (job.build_width_mm as f64) * 0.5;
    let half_h = (job.build_depth_mm as f64) * 0.5;
    let x_pixel_size_mm =
        (job.build_width_mm as f64) / (job.effective_render_width_px().max(1) as f64);
    let y_pixel_size_mm = (job.build_depth_mm as f64) / (job.source_height_px.max(1) as f64);

    let (x_min, x_max, y_min, y_max) = if pix_min_x == i32::MAX {
        (0.0, 0.0, 0.0, 0.0)
    } else {
        (
            (pix_min_x as f64 * x_pixel_size_mm) - half_w,
            ((pix_max_x as f64 + 1.0) * x_pixel_size_mm) - half_w,
            (pix_min_y as f64 * y_pixel_size_mm) - half_h,
            ((pix_max_y as f64 + 1.0) * y_pixel_size_mm) - half_h,
        )
    };

    let z_max = round4((job.total_layers as f64) * (job.layer_height_mm as f64));

    let plate_json = build_plate_json(
        total_solid_area,
        layers_count,
        x_min,
        x_max,
        y_min,
        y_max,
        z_max,
    );
    let profile_json = build_profile_json(job, &metadata);
    let options_json = build_options_json(job);
    let info_json = build_info_json(layer_area_stats);

    let mut zip = ZipWriter::new(writer);
    let meta_opt = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(normalize_container_compression_level(
            job.container_compression_level,
        )));

    // Layer PNGs use a lightweight fixed-Huffman deflate internally (fast to
    // produce, O(num_runs)).  The resulting bitstream is highly repetitive
    // (the same 13-bit distance-1 match pattern repeated thousands of times),
    // so a second ZIP deflate pass compresses it dramatically — matching the
    // approach used by mslicer's `FileOptions::DEFAULT`.
    let layer_opt = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(1));

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

    zip.start_file("plate.json", meta_opt)?;
    zip.write_all(serde_json::to_vec_pretty(&plate_json)?.as_slice())?;

    zip.start_file("profile.json", meta_opt)?;
    zip.write_all(serde_json::to_vec_pretty(&profile_json)?.as_slice())?;

    zip.start_file("options.json", meta_opt)?;
    zip.write_all(serde_json::to_vec_pretty(&options_json)?.as_slice())?;

    if !layer_area_stats.is_empty() {
        zip.start_file("info.json", meta_opt)?;
        zip.write_all(serde_json::to_vec_pretty(&info_json)?.as_slice())?;
    }

    for (idx, png) in layer_pngs.iter().enumerate() {
        let name = format!("{}.png", idx + 1);
        zip.start_file(name, layer_opt)?;
        zip.write_all(png)?;
        if let Some(progress) = on_progress {
            progress((idx as u32) + 1, layers_count.max(1));
        }
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

    if let Some(progress) = on_progress {
        progress(layers_count.max(1), layers_count.max(1));
    }

    Ok(())
}

/// Streaming RLE encoder for the Athena NanoDLP format.
///
/// During the render pipeline, `consume_rle_layer` simply stores the raw RLE
/// runs for each layer.  All PNG encoding happens in `finalize_to_bytes` using
/// Streaming RLE encoder for the Athena NanoDLP format.
///
/// Encodes each layer's PNG **immediately** in `consume_rle_layer` using
/// libdeflate, then discards the raw RLE runs.  This bounds peak memory to
/// a single layer's pixel/filter buffer (~40 MB at 12 K) plus the growing
/// accumulated compressed PNGs — far lower than storing all raw RLE runs for
/// all 800 layers simultaneously (which can exceed 30 GB for complex prints).
///
/// PNG format is selected from the job's `x_packing_mode`:
/// - `rgb8_div3`: Truecolor (RGB) PNG, width = width_px, pHYs 3:1.
/// - other modes: 8-bit grayscale PNG at effective_render_width_px.
///
/// Layer PNGs are Stored (not Deflated) in the ZIP because they are already
/// deflate-compressed by libdeflate.
struct AthenaRleStreamEncoder {
    job: SliceJobV3,
    pngs: Vec<Vec<u8>>,
    area_stats: Vec<LayerAreaStatsV3>,
    binary_png: bool,
}

/// Encode one layer's RLE runs to a PNG byte vector.
///
/// For `rgb8_div3` mode, encodes the RLE runs directly into a Truecolor PNG
/// using the custom fixed-Huffman deflate encoder — O(num_runs + height),
/// no pixel buffer materialised.
///
/// For other modes, expands RLE → flat pixels and delegates to libdeflate.
fn encode_layer_png(
    job: &SliceJobV3,
    runs: &[crate::rle::RleRun],
    binary_png: bool,
) -> Result<Vec<u8>, SlicerV3Error> {
    let width = job.effective_render_width_px();
    let height = job.source_height_px;

    match job.x_packing_mode.as_str() {
        "rgb8_div3" => {
            // RLE runs are at physical resolution (source_width_px = 11520).
            // Pack every 3 adjacent grayscale sub-pixels into one RGB pixel,
            // preserving sub-pixel spatial accuracy.
            let logical_width = job.width_px;
            crate::encode::encode_truecolor_packed_png_from_rle(logical_width, height, runs, 3)
        }
        _ => {
            // Grayscale: expand RLE and use libdeflate.
            let total_pixels = (width as usize).saturating_mul(height as usize);
            let mut pixels = Vec::with_capacity(total_pixels);
            for run in runs {
                let len = run.length as usize;
                let end = (pixels.len() + len).min(total_pixels);
                let fill = end - pixels.len();
                pixels.extend(std::iter::repeat(run.value).take(fill));
            }
            pixels.resize(total_pixels, 0);

            crate::encode::encode_grayscale_png(
                width,
                height,
                &pixels,
                &job.png_compression_strategy,
                binary_png,
            )
        }
    }
}

impl RleStreamEncoder for AthenaRleStreamEncoder {
    fn consume_rle_layer(
        &mut self,
        layer_index: u32,
        runs: Vec<crate::rle::RleRun>,
    ) -> Result<(), SlicerV3Error> {
        // Encode immediately so the raw runs can be dropped right away.
        let png = encode_layer_png(&self.job, &runs, self.binary_png)?;
        self.pngs[layer_index as usize] = png;
        Ok(())
    }

    fn set_area_stats(&mut self, stats: Vec<LayerAreaStatsV3>) {
        self.area_stats = stats;
    }

    fn parallel_encode_fn(
        &self,
    ) -> Option<Arc<dyn Fn(u32, &[crate::rle::RleRun]) -> Result<Vec<u8>, SlicerV3Error> + Send + Sync>>
    {
        let job = self.job.clone();
        let binary_png = self.binary_png;
        Some(Arc::new(move |_layer_index: u32, runs: &[crate::rle::RleRun]| {
            encode_layer_png(&job, runs, binary_png)
        }))
    }

    fn store_encoded_layer(&mut self, layer_index: u32, bytes: Vec<u8>) {
        self.pngs[layer_index as usize] = bytes;
    }

    fn finalize_to_bytes(self: Box<Self>) -> Result<Vec<u8>, SlicerV3Error> {
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        write_nanodlp_archive(&mut cursor, &self.job, &self.pngs, &self.area_stats, None)?;
        Ok(cursor.into_inner())
    }
}

impl FormatEncoder for AthenaPluginEncoder {
    fn output_format(&self) -> &'static str {
        ".nanodlp"
    }

    fn requires_area_stats(&self) -> bool {
        false
    }

    fn requires_png_layers(&self) -> bool {
        false
    }

    fn create_rle_stream_encoder(
        &self,
        job: &SliceJobV3,
    ) -> Result<Option<Box<dyn RleStreamEncoder>>, SlicerV3Error> {
        let binary_png = job.anti_aliasing_level.trim() == "Off";
        Ok(Some(Box::new(AthenaRleStreamEncoder {
            job: job.clone(),
            pngs: vec![Vec::new(); job.total_layers as usize],
            area_stats: vec![LayerAreaStatsV3::default(); job.total_layers as usize],
            binary_png,
        })))
    }

    fn estimate_encode_progress_units(&self, rendered_layers: &RenderedLayersV3) -> u32 {
        rendered_layers
            .png_layers
            .as_ref()
            .map(|layers| layers.len() as u32)
            .unwrap_or(1)
            .max(1)
    }

    fn encode_container_from_rendered_layers_with_progress(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        layer_area_stats: &[LayerAreaStatsV3],
        on_progress: Option<&dyn Fn(u32, u32)>,
    ) -> Result<Vec<u8>, SlicerV3Error> {
        let Some(layer_pngs) = rendered_layers.png_layers.as_ref() else {
            return Err(SlicerV3Error::MissingRenderedLayerPayload(
                "png layers are required by Athena NanoDLP encoder".to_string(),
            ));
        };

        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        write_nanodlp_archive(&mut cursor, job, layer_pngs, layer_area_stats, on_progress)?;
        Ok(cursor.into_inner())
    }

    fn encode_container(
        &self,
        job: &SliceJobV3,
        layer_pngs: &[Vec<u8>],
        layer_area_stats: &[LayerAreaStatsV3],
    ) -> Result<Vec<u8>, SlicerV3Error> {
        let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
        write_nanodlp_archive(&mut cursor, job, layer_pngs, layer_area_stats, None)?;
        Ok(cursor.into_inner())
    }

    fn encode_container_to_path_with_progress(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        layer_area_stats: &[LayerAreaStatsV3],
        output_path: &Path,
        on_progress: Option<&dyn Fn(u32, u32)>,
    ) -> Result<(), SlicerV3Error> {
        let Some(layer_pngs) = rendered_layers.png_layers.as_ref() else {
            return Err(SlicerV3Error::MissingRenderedLayerPayload(
                "png layers are required by Athena NanoDLP encoder".to_string(),
            ));
        };

        let file = std::fs::File::create(output_path)?;
        let writer = std::io::BufWriter::new(file);
        write_nanodlp_archive(writer, job, layer_pngs, layer_area_stats, on_progress)
    }

    fn encode_container_to_path(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        layer_area_stats: &[LayerAreaStatsV3],
        output_path: &Path,
    ) -> Result<(), SlicerV3Error> {
        let Some(layer_pngs) = rendered_layers.png_layers.as_ref() else {
            return Err(SlicerV3Error::MissingRenderedLayerPayload(
                "png layers are required by Athena NanoDLP encoder".to_string(),
            ));
        };

        let file = std::fs::File::create(output_path)?;
        let writer = std::io::BufWriter::new(file);
        write_nanodlp_archive(writer, job, layer_pngs, layer_area_stats, None)
    }
}
