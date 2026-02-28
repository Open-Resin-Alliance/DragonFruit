use crate::job::{SliceArtifact, SliceJob};

/// Core `.goo` container encoder scaffold.
pub fn encode_goo_container(job: &SliceJob) -> SliceArtifact {
    let payload = serde_json::json!({
        "schema": "dragonfruit.goo.scaffold.v1",
        "layers": job.layer_pngs.len(),
        "widthPx": job.width_px,
        "heightPx": job.height_px,
    });

    SliceArtifact {
        filename: "slice.goo".to_string(),
        mime_type: "application/octet-stream".to_string(),
        bytes: payload.to_string().into_bytes(),
    }
}
