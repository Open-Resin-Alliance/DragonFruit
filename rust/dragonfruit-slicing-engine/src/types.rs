//! Shared data contracts for the DragonFruit V3 slicing pipeline.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

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

fn default_minimum_aa_alpha_percent() -> f32 {
    35.0
}

fn default_false() -> bool {
    false
}

fn default_x_packing_mode() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SliceJobV3 {
    /// Target output extension selected from registered encoders.
    pub output_format: String,
    /// Optional encoder-specific format version tag (e.g. `v4v5`, `v5enc`).
    #[serde(default)]
    pub format_version: Option<String>,
    /// Source raster resolution used for layer PNG generation.
    pub source_width_px: u32,
    pub source_height_px: u32,
    /// Optional logical/output dimensions retained for metadata parity.
    pub width_px: u32,
    pub height_px: u32,
    /// X-axis pixel packing mode (`none`, `rgb8_div3`, `gray3_div2`).
    ///
    /// - `none` (default): raw grayscale at source resolution.
    /// - `rgb8_div3`: 3 physical sub-pixels packed into 1 RGB pixel; render
    ///   at `width_px × height_px` and write Truecolor PNG with pHYs 3:1.
    /// - `gray3_div2`: 2 physical sub-pixels packed into 1 grayscale pixel;
    ///   render at `width_px × height_px` and write grayscale PNG with pHYs 2:1.
    #[serde(default = "default_x_packing_mode")]
    pub x_packing_mode: String,
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
    /// Minimum grayscale alpha (0-100%) for non-zero AA pixels.
    #[serde(default = "default_minimum_aa_alpha_percent")]
    pub minimum_aa_alpha_percent: f32,
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

impl SliceJobV3 {
    /// Effective render width in pixels.
    ///
    /// Always uses the full physical sub-pixel resolution so that adjacent
    /// sub-pixels carry independent exposure values.  For `rgb8_div3` the
    /// rasteriser works at `source_width_px` (e.g. 11520) and the encoder
    /// packs every 3 grayscale bytes into one RGB pixel at `width_px`
    /// (e.g. 3840).
    #[inline]
    pub fn effective_render_width_px(&self) -> u32 {
        self.source_width_px
    }
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SliceProgressPhaseV3 {
    Slicing,
    Encoding,
    Finalizing,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceProgressUpdateV3 {
    pub done: u32,
    pub total: u32,
    pub phase: SliceProgressPhaseV3,
}

/// Progress callback signature for full end-to-end slicing lifecycle.
pub type ProgressCallbackV3 = Arc<dyn Fn(SliceProgressUpdateV3) + Send + Sync>;
