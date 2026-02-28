use crate::job::{SliceArtifact, SliceJob};

/// Core `.lumen` container encoder scaffold.
pub fn encode_lumen_container(job: &SliceJob) -> SliceArtifact {
    let payload = serde_json::json!({
        "schema": "dragonfruit.lumen.scaffold.v1",
        "layers": job.layer_pngs.len(),
        "widthPx": job.width_px,
        "heightPx": job.height_px,
    });

    SliceArtifact {
        filename: "slice.lumen".to_string(),
        mime_type: "application/octet-stream".to_string(),
        bytes: payload.to_string().into_bytes(),
    }
}
