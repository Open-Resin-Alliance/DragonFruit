//! Shared data contracts for the DragonFruit V3 slicing pipeline.

use serde::{Deserialize, Serialize};

use crate::metrics::SlicingPerfV3;

fn default_png_compression_strategy() -> String {
    "balanced".to_string()
}

fn default_container_compression_level() -> u8 {
    2
}

fn default_anti_aliasing_level() -> String {
    "Off".to_string()
}

fn default_false() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceJobV3 {
    /// Target output extension selected from registered encoders.
    pub output_format: String,
    /// Source raster resolution used for layer PNG generation.
    pub source_width_px: u32,
    pub source_height_px: u32,
    /// Optional logical/output dimensions retained for metadata parity.
    pub width_px: u32,
    pub height_px: u32,
    /// Build plate dimensions in millimeters.
    pub build_width_mm: f32,
    pub build_depth_mm: f32,
    /// Slice step in millimeters.
    pub layer_height_mm: f32,
    /// Total number of layers to evaluate.
    pub total_layers: u32,
    /// Optional captured preview thumbnail (`3d.png`) as base64 PNG bytes.
    #[serde(default)]
    pub export_thumbnail_png_base64: Option<String>,
    /// PNG compression strategy hint (`fastest`, `balanced`, `smallest`, `optimal`).
    #[serde(default = "default_png_compression_strategy")]
    pub png_compression_strategy: String,
    /// ZIP deflate level for metadata entries.
    #[serde(default = "default_container_compression_level")]
    pub container_compression_level: u8,
    /// Raster anti-aliasing quality hint (`Off`, `2x`, `4x`, `8x`).
    #[serde(default = "default_anti_aliasing_level")]
    pub anti_aliasing_level: String,
    /// Whether AA should apply to support geometry (reserved for future split masks).
    #[serde(default)]
    pub aa_on_supports: bool,
    /// Mirror output image across X axis.
    #[serde(default = "default_false")]
    pub mirror_x: bool,
    /// Mirror output image across Y axis.
    #[serde(default = "default_false")]
    pub mirror_y: bool,
    /// Flat triangle buffer (`x,y,z` * 3 vertices per triangle).
    pub triangles_xyz: Vec<f32>,
    /// Opaque metadata JSON passed through from app layer.
    pub metadata_json: String,
}

#[derive(Debug, Clone)]
pub struct SliceArtifactV3 {
    /// Final archive bytes.
    pub bytes: Vec<u8>,
    /// Accumulated performance counters for diagnostics/telemetry.
    pub perf: SlicingPerfV3,
}

/// Rendered layer payloads produced by the raster/encode stage.
///
/// Encoders can request either PNG layers, raw mask layers, or both.
#[derive(Debug, Clone, Default)]
pub struct RenderedLayersV3 {
    /// Optional grayscale PNG bytes per layer.
    pub png_layers: Option<Vec<Vec<u8>>>,
    /// Optional raw 8-bit grayscale raster masks per layer.
    pub raw_mask_layers: Option<Vec<Vec<u8>>>,
}

impl RenderedLayersV3 {
    pub fn layer_count(&self) -> usize {
        self.png_layers
            .as_ref()
            .map(|v| v.len())
            .or_else(|| self.raw_mask_layers.as_ref().map(|v| v.len()))
            .unwrap_or(0)
    }
}

/// Per-layer solid area metrics computed during rasterization.
///
/// Values are kept lightweight to enable near-zero-overhead aggregation in the
/// hot scanline fill path.
#[derive(Debug, Clone, Default)]
pub struct LayerAreaStatsV3 {
    pub total_solid_pixels: u32,
    pub total_solid_area_mm2: f64,
    pub largest_area_mm2: f64,
    pub smallest_area_mm2: f64,
    pub min_x: i32,
    pub min_y: i32,
    pub max_x: i32,
    pub max_y: i32,
    pub area_count: u32,
}

/// Progress callback signature `(done_layers, total_layers)`.
pub type ProgressCallbackV3 = Box<dyn Fn(u32, u32) + Send + Sync>;
