use crate::job::{SliceArtifact, SliceJob};
use serde_json::{json, Value};
use std::io::Write;
use thiserror::Error;
use zip::write::FileOptions;
use zip::{CompressionMethod, ZipWriter};

#[derive(Debug, Error)]
pub enum NanoDlpEncodeError {
    #[error("unsupported output format for NanoDLP encoder: {0}")]
    UnsupportedFormat(String),
    #[error("failed to parse metadata json: {0}")]
    MetadataJson(String),
    #[error("zip writer failure: {0}")]
    ZipWrite(String),
}

fn extract_printer_name(root: &Value) -> String {
    root.get("printer")
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("Athena")
        .to_string()
}

fn extract_source_file(root: &Value) -> String {
    root.get("sourceFile")
        .and_then(Value::as_str)
        .unwrap_or("dragonfruit_export")
        .to_string()
}

fn build_plate_json(job: &SliceJob, source_metadata: &Value) -> Value {
    let total_layers = job.total_layers;
    let z_max_mm = (job.layer_height_mm as f64) * (total_layers as f64);

    json!({
        "PlateID": 0,
        "ProfileID": 0,
        "Profile": Value::Null,
        "CreatedDate": 0,
        "Path": "",
        "LayersCount": total_layers,
        "Processed": true,
        "TotalSolidArea": 0.0,
        "MultiMaterial": false,
        "MC": {
            "StartX": 0,
            "StartY": 0,
            "Width": 0,
            "Height": 0,
            "X": Value::Null,
            "Y": Value::Null,
            "MultiCureGap": 0,
            "Count": 0
        },
        "XMin": 0.0,
        "XMax": 0.0,
        "YMin": 0.0,
        "YMax": 0.0,
        "ZMin": 0.0,
        "ZMax": z_max_mm,
        "_dragonfruit": {
            "source": "dragonfruit-wasm",
            "upstreamRef": "Open-Resin-Alliance/VoxelShift",
            "metadata": source_metadata
        }
    })
}

fn build_profile_json(job: &SliceJob, source_metadata: &Value) -> Value {
    let printer_name = extract_printer_name(source_metadata);
    let source_file = extract_source_file(source_metadata);
    let thickness_um = ((job.layer_height_mm as f64) * 1000.0).round();

    json!({
        "ResinID": 0,
        "ProfileID": 0,
        "Title": format!("DragonFruit — {}", printer_name),
        "Desc": format!("Imported from {} via DragonFruit", source_file),
        "Thickness": thickness_um,
        "XOffset": (job.width_px / 2),
        "YOffset": (job.height_px / 2),
        "ZOffset": 0,
        "AutoCenter": 0,
        "XPixelSize": 0.0,
        "YPixelSize": 0.0,
        "ImageMirror": 1,
        "DisplayController": 1,
        "Boundary": {
            "XMin": 0.0,
            "XMax": 0.0,
            "YMin": 0.0,
            "YMax": 0.0,
            "ZMin": 0.0,
            "ZMax": (job.layer_height_mm as f64) * (job.total_layers as f64)
        },
        "Area": { "PlateID": 0, "Layers": [], "Kill": false }
    })
}

fn build_options_json(job: &SliceJob) -> Value {
    let depth_um = ((job.layer_height_mm as f64) * 1000.0).round();
    json!({
        "PWidth": job.width_px,
        "PHeight": job.height_px,
        "SupportDepth": depth_um,
        "Depth": depth_um,
        "LiftSpeed": 0.0,
        "RetractSpeed": 0.0,
        "CureTime": 0.0,
        "ExportType": 0,
        "OutputPath": "",
        "Suffix": "",
        "SkipEmpty": 0,
        "FillColorRGB": { "R": 255, "G": 255, "B": 255, "A": 255 },
        "BlankColorRGB": { "R": 0, "G": 0, "B": 0, "A": 255 }
    })
}

fn json_pretty_bytes(value: &Value) -> Result<Vec<u8>, NanoDlpEncodeError> {
    serde_json::to_vec_pretty(value)
        .map_err(|err| NanoDlpEncodeError::MetadataJson(err.to_string()))
}

/// Athena plugin-owned NanoDLP container encoder.
///
/// Source ownership lives under `plugins/athena/slicing/rust/*`.
pub fn encode_nanodlp_container(job: &SliceJob) -> Result<SliceArtifact, NanoDlpEncodeError> {
    if job.output_format != ".nanodlp" {
        return Err(NanoDlpEncodeError::UnsupportedFormat(
            job.output_format.clone(),
        ));
    }

    let source_metadata: Value = serde_json::from_str(&job.metadata_json)
        .map_err(|err| NanoDlpEncodeError::MetadataJson(err.to_string()))?;

    let plate_json = json_pretty_bytes(&build_plate_json(job, &source_metadata))?;
    let profile_json = json_pretty_bytes(&build_profile_json(job, &source_metadata))?;
    let options_json = json_pretty_bytes(&build_options_json(job))?;

    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let options = FileOptions::default().compression_method(CompressionMethod::Stored);

        zip.start_file("plate.json", options)
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;
        zip.write_all(&plate_json)
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;

        zip.start_file("profile.json", options)
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;
        zip.write_all(&profile_json)
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;

        zip.start_file("options.json", options)
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;
        zip.write_all(&options_json)
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;

        zip.start_file("info.json", options)
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;
        zip.write_all(b"[]")
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;

        for (index, layer_png) in job.layer_pngs.iter().enumerate() {
            let name = format!("{}.png", index + 1);
            zip.start_file(name, options)
                .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;
            zip.write_all(layer_png)
                .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;
        }

        zip.finish()
            .map_err(|err| NanoDlpEncodeError::ZipWrite(err.to_string()))?;
    }

    Ok(SliceArtifact {
        filename: "slice.nanodlp".to_string(),
        mime_type: "application/octet-stream".to_string(),
        bytes: cursor.into_inner(),
    })
}
