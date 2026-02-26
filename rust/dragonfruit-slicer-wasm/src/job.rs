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
pub struct SolidSliceJob {
    pub output_format: String,
    pub source_width_px: u32,
    pub source_height_px: u32,
    pub width_px: u32,
    pub height_px: u32,
    pub x_packing_mode: String,
    pub build_width_mm: f32,
    pub build_depth_mm: f32,
    pub layer_height_mm: f32,
    pub total_layers: u32,
    pub triangles_xyz: Vec<f32>,
    pub metadata_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceArtifact {
    pub filename: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}
