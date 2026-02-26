use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceJob {
    pub output_format: String,
    pub width_px: u32,
    pub height_px: u32,
    pub layer_height_mm: f32,
    pub total_layers: u32,
    pub layer_pngs: Vec<Vec<u8>>,
    pub metadata_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceArtifact {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}
