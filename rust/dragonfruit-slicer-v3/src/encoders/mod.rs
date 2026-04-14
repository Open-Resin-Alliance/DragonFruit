//! Output container encoders for V3.
//!
//! The slicer core produces capability-driven per-layer payloads (PNG, raw
//! masks, or both) plus metadata; concrete file/container formats are encoded
//! through this trait.

#[path = "../../../../plugins/athena/slicing/rust/encoder_impl.rs"]
pub mod athena_plugin;
pub mod registry;

use crate::engine::SlicerV3Error;
use crate::types::{LayerAreaStatsV3, RenderedLayersV3, SliceJobV3};
use std::path::Path;

/// Trait implemented by concrete output format encoders.
pub trait FormatEncoder: Send + Sync {
    /// Canonical output extension handled by this encoder.
    fn output_format(&self) -> &'static str;

    /// Whether this encoder requires per-layer connected-component area stats.
    ///
    /// Keep false by default to avoid paying component-analysis overhead for
    /// formats that don't consume these metrics.
    fn requires_area_stats(&self) -> bool {
        false
    }

    /// Whether this encoder needs per-layer PNG payloads.
    fn requires_png_layers(&self) -> bool {
        true
    }

    /// Whether this encoder needs per-layer raw raster masks.
    fn requires_raw_mask_layers(&self) -> bool {
        false
    }

    /// Capability-aware encode entrypoint.
    ///
    /// Default implementation preserves backwards compatibility by routing to
    /// the legacy PNG-only method.
    fn encode_container_from_rendered_layers(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        layer_area_stats: &[LayerAreaStatsV3],
    ) -> Result<Vec<u8>, SlicerV3Error> {
        let Some(layer_pngs) = rendered_layers.png_layers.as_ref() else {
            return Err(SlicerV3Error::MissingRenderedLayerPayload(
                "png layers are required by this encoder".to_string(),
            ));
        };
        self.encode_container(job, layer_pngs, layer_area_stats)
    }

    /// Capability-aware encode entrypoint that streams output directly to disk.
    ///
    /// Default implementation preserves backwards compatibility by encoding to
    /// bytes and writing them to `output_path`.
    fn encode_container_to_path(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        layer_area_stats: &[LayerAreaStatsV3],
        output_path: &Path,
    ) -> Result<(), SlicerV3Error> {
        let bytes =
            self.encode_container_from_rendered_layers(job, rendered_layers, layer_area_stats)?;
        std::fs::write(output_path, &bytes)?;
        Ok(())
    }

    /// Encode final archive/container bytes from rendered layer PNGs.
    ///
    /// Legacy compatibility entrypoint for PNG-based encoders.
    fn encode_container(
        &self,
        job: &SliceJobV3,
        layer_pngs: &[Vec<u8>],
        layer_area_stats: &[LayerAreaStatsV3],
    ) -> Result<Vec<u8>, SlicerV3Error> {
        let _ = (job, layer_pngs, layer_area_stats);
        Err(SlicerV3Error::MissingRenderedLayerPayload(
            "encoder does not implement png-layer encoding".to_string(),
        ))
    }
}
