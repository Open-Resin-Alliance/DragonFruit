#![recursion_limit = "256"]

pub mod formats;
pub mod job;
pub mod solid_slicer;

use formats::{
    goo::encode_goo_container, lumen::encode_lumen_container, nanodlp::encode_nanodlp_container,
};
use job::{SliceArtifact, SliceJob, SolidSliceJob};
use solid_slicer::{
    slice_solid_and_encode_nanodlp_streaming, slice_solid_chunk_payload, solid_slice_to_png_layers,
    to_container_job,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn encode_slice_job(job_json: &str) -> Result<Vec<u8>, JsValue> {
    let job: SliceJob = serde_json::from_str(job_json)
        .map_err(|err| JsValue::from_str(&format!("Invalid SliceJob JSON: {err}")))?;

    let artifact: SliceArtifact = match job.output_format.as_str() {
        ".nanodlp" => encode_nanodlp_container(&job)
            .map_err(|err| JsValue::from_str(&format!("NanoDLP encoding failed: {err}")))?,
        ".goo" => encode_goo_container(&job),
        ".lumen" => encode_lumen_container(&job),
        other => {
            return Err(JsValue::from_str(&format!(
                "Unsupported output format: {other}"
            )))
        }
    };

    Ok(artifact.bytes)
}

#[wasm_bindgen]
pub fn slice_solid_and_encode_job(job_json: &str) -> Result<Vec<u8>, JsValue> {
    let job: SolidSliceJob = serde_json::from_str(job_json)
        .map_err(|err| JsValue::from_str(&format!("Invalid SolidSliceJob JSON: {err}")))?;

    if job.output_format == ".nanodlp" {
        let bytes = slice_solid_and_encode_nanodlp_streaming(&job)
            .map_err(|err| JsValue::from_str(&format!("Solid slicing failed: {err}")))?;
        return Ok(bytes);
    }

    let layer_pngs = solid_slice_to_png_layers(&job)
        .map_err(|err| JsValue::from_str(&format!("Solid slicing failed: {err}")))?;

    let container_job = to_container_job(&job, layer_pngs);

    let artifact: SliceArtifact = match container_job.output_format.as_str() {
        ".nanodlp" => encode_nanodlp_container(&container_job)
            .map_err(|err| JsValue::from_str(&format!("NanoDLP encoding failed: {err}")))?,
        ".goo" => encode_goo_container(&container_job),
        ".lumen" => encode_lumen_container(&container_job),
        other => {
            return Err(JsValue::from_str(&format!(
                "Unsupported output format: {other}"
            )))
        }
    };

    Ok(artifact.bytes)
}

#[wasm_bindgen]
pub fn slice_solid_and_encode_raw(
    output_format: String,
    source_width_px: u32,
    source_height_px: u32,
    width_px: u32,
    height_px: u32,
    x_packing_mode: String,
    build_width_mm: f32,
    build_depth_mm: f32,
    layer_height_mm: f32,
    total_layers: u32,
    triangles_xyz: Box<[f32]>,
    metadata_json: String,
) -> Result<Vec<u8>, JsValue> {
    let job = SolidSliceJob {
        output_format,
        source_width_px,
        source_height_px,
        width_px,
        height_px,
        x_packing_mode,
        build_width_mm,
        build_depth_mm,
        layer_height_mm,
        total_layers,
        triangles_xyz: triangles_xyz.into_vec(),
        metadata_json,
    };

    if job.output_format == ".nanodlp" {
        let bytes = slice_solid_and_encode_nanodlp_streaming(&job)
            .map_err(|err| JsValue::from_str(&format!("Solid slicing failed: {err}")))?;
        return Ok(bytes);
    }

    let layer_pngs = solid_slice_to_png_layers(&job)
        .map_err(|err| JsValue::from_str(&format!("Solid slicing failed: {err}")))?;

    let container_job = to_container_job(&job, layer_pngs);

    let artifact: SliceArtifact = match container_job.output_format.as_str() {
        ".nanodlp" => encode_nanodlp_container(&container_job)
            .map_err(|err| JsValue::from_str(&format!("NanoDLP encoding failed: {err}")))?,
        ".goo" => encode_goo_container(&container_job),
        ".lumen" => encode_lumen_container(&container_job),
        other => {
            return Err(JsValue::from_str(&format!(
                "Unsupported output format: {other}"
            )))
        }
    };

    Ok(artifact.bytes)
}

#[wasm_bindgen]
pub fn slice_solid_layers_chunk_raw(
    output_format: String,
    source_width_px: u32,
    source_height_px: u32,
    width_px: u32,
    height_px: u32,
    x_packing_mode: String,
    build_width_mm: f32,
    build_depth_mm: f32,
    layer_height_mm: f32,
    total_layers: u32,
    triangles_xyz: Box<[f32]>,
    metadata_json: String,
    start_layer: u32,
    layer_count: u32,
) -> Result<Vec<u8>, JsValue> {
    let job = SolidSliceJob {
        output_format,
        source_width_px,
        source_height_px,
        width_px,
        height_px,
        x_packing_mode,
        build_width_mm,
        build_depth_mm,
        layer_height_mm,
        total_layers,
        triangles_xyz: triangles_xyz.into_vec(),
        metadata_json,
    };

    slice_solid_chunk_payload(&job, start_layer, layer_count)
        .map_err(|err| JsValue::from_str(&format!("Solid chunk slicing failed: {err}")))
}
