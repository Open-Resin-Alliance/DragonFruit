use serde::{Deserialize, Serialize};

fn default_png_compression_strategy() -> String {
    "balanced".to_string()
}

fn default_bvh_acceleration_enabled() -> bool {
    true
}

fn default_anti_aliasing_level() -> String {
    "Off".to_string()
}

fn default_aa_on_supports() -> bool {
    false
}

fn default_model_triangle_count() -> usize {
    0
}

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
    #[serde(default = "default_png_compression_strategy")]
    pub png_compression_strategy: String,
    #[serde(default = "default_bvh_acceleration_enabled")]
    pub bvh_acceleration_enabled: bool,
    #[serde(default = "default_anti_aliasing_level")]
    pub anti_aliasing_level: String,
    #[serde(default = "default_aa_on_supports")]
    pub aa_on_supports: bool,
    #[serde(default = "default_model_triangle_count")]
    pub model_triangle_count: usize,
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
