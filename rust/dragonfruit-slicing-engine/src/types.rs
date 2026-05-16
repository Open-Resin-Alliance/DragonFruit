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

fn default_blur_brush_radius_px() -> u32 {
    1
}

fn default_anti_aliasing_mode() -> String {
    "Blur".to_string()
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

fn default_z_blend_look_back() -> u32 {
    2
}

fn default_z_blend_fade_px() -> u32 {
    20
}

fn default_z_blend_auto_fade() -> bool {
    false
}

fn default_z_blend_minimum_alpha_percent() -> f32 {
    0.0
}

fn default_z_blend_max_alpha_percent() -> f32 {
    90.0
}

fn default_z_blend_debug_color_overlay() -> bool {
    false
}

fn default_model_triangle_count() -> u32 {
    0
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
    /// Raster anti-aliasing quality hint (`Off` or `<n>x`, e.g. `2x`, `4x`, `8x`, `16x`).
    #[serde(default = "default_anti_aliasing_level")]
    pub anti_aliasing_level: String,
    /// Anti-aliasing mode hint (`Blur`, `Coverage`).
    #[serde(default = "default_anti_aliasing_mode")]
    pub anti_aliasing_mode: String,
    /// Blur brush radius in pixels for the blur AA mode.
    #[serde(default = "default_blur_brush_radius_px")]
    pub blur_brush_radius_px: u32,
    /// Whether AA should apply to support geometry (reserved for future split masks).
    #[serde(default)]
    pub aa_on_supports: bool,
    /// Number of model triangles at the front of `triangles_xyz`.
    ///
    /// Triangles after this index are treated as support/raft geometry.
    /// `0` means "unspecified" (no geometry split metadata).
    #[serde(default = "default_model_triangle_count")]
    pub model_triangle_count: u32,
    /// Minimum grayscale alpha (0-100%) for non-zero AA pixels.
    #[serde(default = "default_minimum_aa_alpha_percent")]
    pub minimum_aa_alpha_percent: f32,
    /// Mirror output image across X axis.
    #[serde(default = "default_false")]
    pub mirror_x: bool,
    /// Mirror output image across Y axis.
    #[serde(default = "default_false")]
    pub mirror_y: bool,
    /// Number of prior layers to compare against for 3DAA inter-layer blending.
    /// Higher values smooth shallower surface angles but cost more memory.
    #[serde(default = "default_z_blend_look_back")]
    pub z_blend_look_back: u32,
    /// Fade-out distance in pixels for the 3DAA inter-layer gradient.
    /// The gradient reaches 0 at this many pixels from the current layer's edge.
    ///
    /// When `z_blend_auto_fade` is `true` this value is ignored and the engine
    /// auto-computes the physically correct fade from `layer_height_mm` and the
    /// printer's XY pixel pitch.  Only used (and respected) when `z_blend_auto_fade`
    /// is `false`.
    #[serde(default = "default_z_blend_fade_px")]
    pub z_blend_fade_px: u32,
    /// When true the engine auto-computes `z_blend_fade_px` from physical
    /// printer geometry: `fade_px = ceil(layer_height_mm / xy_pixel_pitch_mm) × look_back`.
    ///
    /// This is the physically correct calibration for most MSLA printers and
    /// should be preferred over a manually-tuned `z_blend_fade_px`.  The manual
    /// override exists only for advanced users who understand why they're
    /// deviating from the physical calibration.
    #[serde(default = "default_z_blend_auto_fade")]
    pub z_blend_auto_fade: bool,
    /// Minimum gray level (0–100 %) for z-blend gradient pixels that fall outside
    /// the current layer's binary footprint.  Defaults to 0 so that the
    /// EDT gradient naturally tapers to zero at `fade_px`.  Non-zero values
    /// extend printing into the receding zone even where the gradient is faint,
    /// which can cause dimensional overgrowth and should generally be left at 0.
    ///
    /// This is separate from `minimum_aa_alpha_percent`, which applies only to
    /// XY blur / coverage AA pixels inside the current layer's footprint.
    #[serde(default = "default_z_blend_minimum_alpha_percent")]
    pub z_blend_minimum_alpha_percent: f32,
    /// Maximum gray level (0–100 %) for z-blend gradient pixels at the inner
    /// boundary (closest to the solid region).  Together with
    /// `z_blend_minimum_alpha_percent` this defines the cure-window: the
    /// gradient linearly maps from `min` (outermost receding pixel) to `max`
    /// (innermost receding pixel adjacent to solid).  Defaults to 90 %.
    #[serde(default = "default_z_blend_max_alpha_percent")]
    pub z_blend_max_alpha_percent: f32,
    /// Optional custom cure-window LUT (256 u8 values).  When present, this
    /// array is used directly in place of the linear ramp generated from
    /// `z_blend_minimum_alpha_percent` / `z_blend_max_alpha_percent`.  The
    /// engine always forces index 0 to 0 (void) and index 255 to 255 (solid).
    #[serde(default)]
    pub z_blend_custom_lut: Option<Vec<u8>>,
    /// Debug-only visualization mode for 3DAA blending.
    ///
    /// When enabled, generated PNG layer previews color-code blend direction:
    /// - Green = look-behind contribution
    /// - Red = look-ahead contribution
    ///
    /// Intended for diagnostics only.
    #[serde(default = "default_z_blend_debug_color_overlay")]
    pub z_blend_debug_color_overlay: bool,
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

    /// Physical XY pixel pitch in millimeters (width axis).
    ///
    /// Uses the source (physical sub-pixel) width so that high-resolution
    /// sub-pixel packing modes (e.g. `rgb8_div3`) report the true pixel pitch,
    /// not the packed-pixel pitch.
    #[inline]
    pub fn xy_pixel_pitch_mm(&self) -> f32 {
        if self.source_width_px == 0 || self.build_width_mm <= 0.0 {
            return 1.0; // fallback: 1 mm/px to avoid division-by-zero
        }
        self.build_width_mm / self.source_width_px as f32
    }

    /// Effective z-blend fade distance in pixels, honouring `z_blend_auto_fade`.
    ///
    /// When auto-fade is enabled the fade is derived from physical printer
    /// geometry so that the gradient spans exactly the XY distance that
    /// corresponds to `look_back` layer-height steps on a 45° surface:
    ///
    /// ```text
    /// fade_px = ceil(layer_height_mm / xy_pixel_pitch_mm) × look_back
    /// ```
    ///
    /// This ensures the gradient falls off steeply within the physically
    /// meaningful XY extent and does not bleed across unrelated features.
    pub fn effective_z_blend_fade_px(&self) -> u32 {
        if self.z_blend_auto_fade && self.layer_height_mm > 0.0 {
            let pitch = self.xy_pixel_pitch_mm();
            let layer_height_px = (self.layer_height_mm / pitch).ceil() as u32;
            // Clamp to a reasonable maximum to prevent runaway on degenerate
            // input (e.g. very thick layers on a coarse-resolution printer).
            (layer_height_px.max(1) * self.z_blend_look_back.max(1)).min(64)
        } else {
            self.z_blend_fade_px.max(1)
        }
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
