pub mod formats;
pub mod job;

use formats::{goo::encode_goo_container, lumen::encode_lumen_container, nanodlp::encode_nanodlp_container};
use job::{SliceArtifact, SliceJob};
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
        other => return Err(JsValue::from_str(&format!("Unsupported output format: {other}"))),
    };

    Ok(artifact.bytes)
}
