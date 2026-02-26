use crate::job::{SliceArtifact, SliceJob};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum NanoDlpEncodeError {
    #[error("unsupported output format for NanoDLP encoder: {0}")]
    UnsupportedFormat(String),
}

/// Athena/NanoDLP container encoder scaffold.
///
/// This module is the Rust source-of-truth for `.nanodlp` file-format handling.
/// Complex plugin authors can extend this by adding plugin-specific packing rules,
/// checksums, headers, and container metadata expected by printer firmware.
pub fn encode_nanodlp_container(job: &SliceJob) -> Result<SliceArtifact, NanoDlpEncodeError> {
    if job.output_format != ".nanodlp" {
        return Err(NanoDlpEncodeError::UnsupportedFormat(
            job.output_format.clone(),
        ));
    }

    // Scaffold output: JSON placeholder bytes.
    // Replace with real NanoDLP container serialization implementation.
    let summary = serde_json::json!({
        "schema": "dragonfruit.nanodlp.scaffold.v1",
        "widthPx": job.width_px,
        "heightPx": job.height_px,
        "layerHeightMm": job.layer_height_mm,
        "totalLayers": job.total_layers,
        "layerCount": job.layer_pngs.len(),
        "metadata": job.metadata_json,
    });

    Ok(SliceArtifact {
        filename: "slice.nanodlp".to_string(),
        mime_type: "application/octet-stream".to_string(),
        bytes: summary.to_string().into_bytes(),
    })
}
