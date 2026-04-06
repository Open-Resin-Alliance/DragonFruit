//! Output container encoders for V3.
//!
//! The slicer core produces capability-driven per-layer payloads (PNG, raw
//! masks, or both) plus metadata; concrete file/container formats are encoded
//! through this trait.

pub mod generated_plugin_encoders;
pub mod registry;

use crate::engine::SlicerV3Error;
use crate::types::{LayerAreaStatsV3, RenderedLayersV3, SliceJobV3};
use std::path::Path;

/// Stateful encoder sink that can consume raw masks layer-by-layer during
/// rasterization and produce final container bytes once all layers are seen.
pub trait RawMaskStreamEncoder: Send {
    /// Consume one rasterized raw mask layer in display order.
    fn consume_raw_mask_layer(
        &mut self,
        layer_index: u32,
        raw_mask: Vec<u8>,
    ) -> Result<(), SlicerV3Error>;

    /// Finalize and return encoded container bytes.
    fn finalize_to_bytes(self: Box<Self>) -> Result<Vec<u8>, SlicerV3Error>;

    /// Finalize and write encoded container directly to disk.
    fn finalize_to_path(self: Box<Self>, output_path: &Path) -> Result<(), SlicerV3Error> {
        let bytes = self.finalize_to_bytes()?;
        std::fs::write(output_path, bytes)?;
        Ok(())
    }
}

/// Stateful encoder sink that can consume RLE-compressed layer data directly
/// during rasterization, skipping the full-image pixel buffer entirely.
///
/// This is the fastest possible path for formats like CTB where the native
/// container encoding is already run-length based.
pub trait RleStreamEncoder: Send {
    /// Consume one rasterized layer's RLE data in display order.
    fn consume_rle_layer(
        &mut self,
        layer_index: u32,
        runs: Vec<crate::rle::RleRun>,
    ) -> Result<(), SlicerV3Error>;

    /// Optionally receive per-layer area stats computed by the rasterizer.
    /// Called after all layers are consumed but before finalize.
    fn set_area_stats(&mut self, _stats: Vec<crate::types::LayerAreaStatsV3>) {}

    /// Finalize and return encoded container bytes.
    fn finalize_to_bytes(self: Box<Self>) -> Result<Vec<u8>, SlicerV3Error>;

    /// Finalize and write encoded container directly to disk.
    fn finalize_to_path(self: Box<Self>, output_path: &Path) -> Result<(), SlicerV3Error> {
        let bytes = self.finalize_to_bytes()?;
        std::fs::write(output_path, bytes)?;
        Ok(())
    }

    /// Optionally return a thread-safe function that encodes RLE runs into
    /// layer bytes (e.g. PNG).  When provided, the pipeline will call this
    /// inside parallel rayon workers instead of encoding serially in the
    /// drain loop.
    fn parallel_encode_fn(
        &self,
    ) -> Option<
        std::sync::Arc<
            dyn Fn(&[crate::rle::RleRun]) -> Result<Vec<u8>, SlicerV3Error> + Send + Sync,
        >,
    > {
        None
    }

    /// Store a pre-encoded layer produced by `parallel_encode_fn`.
    /// Only called when `parallel_encode_fn` returns Some.
    fn store_encoded_layer(&mut self, _layer_index: u32, _bytes: Vec<u8>) {}
}

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

    /// Optionally create a streaming RLE sink for the most efficient
    /// rasterize+encode pipeline.
    ///
    /// When provided, the engine will call `rasterize_layer_rle()` instead of
    /// the full-mask path and feed runs directly here, eliminating the 40-56 MB
    /// per-layer pixel buffer.  Preferred over `create_raw_mask_stream_encoder`
    /// when both are available.
    fn create_rle_stream_encoder(
        &self,
        _job: &SliceJobV3,
    ) -> Result<Option<Box<dyn RleStreamEncoder>>, SlicerV3Error> {
        Ok(None)
    }

    /// Optionally create a streaming raw-mask sink for interleaved
    /// rasterize+encode pipelines.
    ///
    /// When provided, the engine can feed raw masks layer-by-layer as they are
    /// produced, reducing peak memory and making progress correlate linearly
    /// with layer processing.
    fn create_raw_mask_stream_encoder(
        &self,
        _job: &SliceJobV3,
    ) -> Result<Option<Box<dyn RawMaskStreamEncoder>>, SlicerV3Error> {
        Ok(None)
    }

    /// Estimated units of encode-stage work used for progress tracking.
    ///
    /// The default reports a single unit to preserve coarse compatibility for
    /// encoders that do not yet provide incremental encode progress.
    fn estimate_encode_progress_units(&self, rendered_layers: &RenderedLayersV3) -> u32 {
        let _ = rendered_layers;
        1
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

    /// Capability-aware encode entrypoint with optional incremental progress callback.
    fn encode_container_from_rendered_layers_with_progress(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        layer_area_stats: &[LayerAreaStatsV3],
        on_progress: Option<&dyn Fn(u32, u32)>,
    ) -> Result<Vec<u8>, SlicerV3Error> {
        let bytes =
            self.encode_container_from_rendered_layers(job, rendered_layers, layer_area_stats)?;
        if let Some(progress) = on_progress {
            progress(1, 1);
        }
        Ok(bytes)
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

    /// Capability-aware disk-streaming encode entrypoint with optional
    /// incremental progress callback.
    fn encode_container_to_path_with_progress(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        layer_area_stats: &[LayerAreaStatsV3],
        output_path: &Path,
        on_progress: Option<&dyn Fn(u32, u32)>,
    ) -> Result<(), SlicerV3Error> {
        let bytes = self.encode_container_from_rendered_layers_with_progress(
            job,
            rendered_layers,
            layer_area_stats,
            on_progress,
        )?;
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
