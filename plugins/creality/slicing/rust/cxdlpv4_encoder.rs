//! Streaming RLE / raw-mask encoder implementation for `.cxdlpv4`.

use std::sync::Arc;

use rayon::prelude::*;

use super::cxdlpv4_layout::{
    build_cxdlpv4_container, encode_empty_cxdlpv4_layer, encode_raw_mask_to_cxdlpv4_layer,
    encode_rle_runs_to_cxdlpv4_layer,
};
use super::cxdlpv4_metadata::{estimate_print_time_sec, extract_cxdlpv4_metadata};
use super::cxdlpv4_preview::build_cxdlpv4_previews;
use super::cxdlpv4_types::CxdlpV4Metadata;
use crate::encoders::{RawMaskStreamEncoder, RleStreamEncoder};
use crate::engine::SlicerV3Error;
use crate::rle::RleRun;
use crate::types::{LayerAreaStatsV3, RenderedLayersV3, SliceJobV3};

pub struct CxdlpV4StreamEncoder {
    width_px: u32,
    height_px: u32,
    layer_count: usize,
    expected_pixels: u64,
    meta: CxdlpV4Metadata,
    small_preview_rle: Vec<u8>,
    large_preview_rle: Vec<u8>,
    encoded_layers: Vec<Option<Vec<u8>>>,
    area_stats: Vec<LayerAreaStatsV3>,
}

impl CxdlpV4StreamEncoder {
    pub fn new(job: &SliceJobV3) -> Self {
        let meta = extract_cxdlpv4_metadata(job);
        let (small_preview_rle, large_preview_rle) = build_cxdlpv4_previews(
            job.export_thumbnail_png_base64.as_deref(),
            job.export_thumbnail_png_base64.as_deref(),
        );
        let layer_count = job.total_layers as usize;
        Self {
            width_px: job.width_px,
            height_px: job.height_px,
            layer_count,
            expected_pixels: (job.width_px as u64) * (job.height_px as u64),
            meta,
            small_preview_rle,
            large_preview_rle,
            encoded_layers: vec![None; layer_count],
            area_stats: Vec::new(),
        }
    }

    fn record_layer_bytes(&mut self, layer_index: u32, bytes: Vec<u8>) -> Result<(), SlicerV3Error> {
        let idx = layer_index as usize;
        if idx >= self.encoded_layers.len() {
            return Err(SlicerV3Error::MissingRenderedLayerPayload(format!(
                "layer_index {layer_index} out of bounds for layer_count {}",
                self.layer_count
            )));
        }
        self.encoded_layers[idx] = Some(bytes);
        Ok(())
    }

    pub fn finalize(self) -> Result<Vec<u8>, SlicerV3Error> {
        let mut layers = Vec::with_capacity(self.layer_count);
        for (idx, maybe_layer) in self.encoded_layers.into_iter().enumerate() {
            let bytes = maybe_layer.ok_or_else(|| {
                SlicerV3Error::MissingRenderedLayerPayload(format!(
                    "Missing encoded data for layer {idx}"
                ))
            })?;
            layers.push(bytes);
        }

        let print_time_sec = estimate_print_time_sec(self.layer_count as u32, &self.meta);
        build_cxdlpv4_container(
            self.width_px,
            self.height_px,
            &self.meta,
            &self.small_preview_rle,
            &self.large_preview_rle,
            &layers,
            &self.area_stats,
            print_time_sec,
        )
    }
}

impl RleStreamEncoder for CxdlpV4StreamEncoder {
    fn consume_rle_layer(&mut self, layer_index: u32, runs: Vec<RleRun>) -> Result<(), SlicerV3Error> {
        let bytes = encode_rle_runs_to_cxdlpv4_layer(&runs, self.expected_pixels)?;
        self.record_layer_bytes(layer_index, bytes)
    }

    fn set_area_stats(&mut self, stats: Vec<LayerAreaStatsV3>) {
        self.area_stats = stats;
    }

    fn parallel_encode_fn(
        &self,
    ) -> Option<Arc<dyn Fn(u32, &[RleRun]) -> Result<Vec<u8>, SlicerV3Error> + Send + Sync>> {
        let expected_pixels = self.expected_pixels;
        Some(Arc::new(move |_layer_index: u32, runs: &[RleRun]| {
            encode_rle_runs_to_cxdlpv4_layer(runs, expected_pixels)
        }))
    }

    fn store_encoded_layer(&mut self, layer_index: u32, bytes: Vec<u8>) {
        let idx = layer_index as usize;
        if idx < self.encoded_layers.len() {
            self.encoded_layers[idx] = Some(bytes);
        }
    }

    fn finalize_to_bytes(self: Box<Self>) -> Result<Vec<u8>, SlicerV3Error> {
        (*self).finalize()
    }
}

pub struct CxdlpV4RawMaskStreamEncoder {
    inner: CxdlpV4StreamEncoder,
}

impl CxdlpV4RawMaskStreamEncoder {
    pub fn new(job: &SliceJobV3) -> Self {
        Self {
            inner: CxdlpV4StreamEncoder::new(job),
        }
    }
}

impl RawMaskStreamEncoder for CxdlpV4RawMaskStreamEncoder {
    fn consume_raw_mask_layer(
        &mut self,
        layer_index: u32,
        raw_mask: Vec<u8>,
    ) -> Result<(), SlicerV3Error> {
        let bytes = if raw_mask.is_empty() {
            crate::pipeline::return_mask_to_pool(raw_mask);
            encode_empty_cxdlpv4_layer(self.inner.expected_pixels)
        } else {
            if raw_mask.len() as u64 != self.inner.expected_pixels {
                let len = raw_mask.len();
                crate::pipeline::return_mask_to_pool(raw_mask);
                return Err(SlicerV3Error::MissingRenderedLayerPayload(format!(
                    "Raw mask length {len} does not match expected {}",
                    self.inner.expected_pixels
                )));
            }
            let encoded = encode_raw_mask_to_cxdlpv4_layer(&raw_mask);
            crate::pipeline::return_mask_to_pool(raw_mask);
            encoded
        };
        self.inner.record_layer_bytes(layer_index, bytes)
    }

    fn finalize_to_bytes(self: Box<Self>) -> Result<Vec<u8>, SlicerV3Error> {
        self.inner.finalize()
    }
}

/// Fallback batch encoder when the slicing pipeline supplies `RenderedLayersV3`.
pub fn encode_rendered_layers_to_cxdlpv4(
    job: &SliceJobV3,
    rendered_layers: &RenderedLayersV3,
    layer_area_stats: &[LayerAreaStatsV3],
    on_progress: Option<&dyn Fn(u32, u32)>,
) -> Result<Vec<u8>, SlicerV3Error> {
    let Some(raw_masks) = rendered_layers.raw_mask_layers.as_ref() else {
        return Err(SlicerV3Error::MissingRenderedLayerPayload(
            "raw_mask_layers are required for .cxdlpv4 encoding".to_string(),
        ));
    };

    let meta = extract_cxdlpv4_metadata(job);
    let (small_preview_rle, large_preview_rle) = build_cxdlpv4_previews(
        job.export_thumbnail_png_base64.as_deref(),
        job.export_thumbnail_png_base64.as_deref(),
    );

    let total_layers = raw_masks.len() as u32;
    let expected_pixels = (job.width_px as u64) * (job.height_px as u64);

    let encoded: Result<Vec<Vec<u8>>, SlicerV3Error> = raw_masks
        .par_iter()
        .enumerate()
        .map(|(idx, mask)| {
            if mask.is_empty() {
                Ok(encode_empty_cxdlpv4_layer(expected_pixels))
            } else if mask.len() as u64 != expected_pixels {
                Err(SlicerV3Error::MissingRenderedLayerPayload(format!(
                    "Layer {idx} raw_mask length {} != {expected_pixels}",
                    mask.len()
                )))
            } else {
                Ok(encode_raw_mask_to_cxdlpv4_layer(mask))
            }
        })
        .collect();

    let encoded_layers = encoded?;
    if let Some(cb) = on_progress {
        let denom = total_layers.max(1);
        cb(denom, denom);
    }
    let print_time_sec = estimate_print_time_sec(total_layers, &meta);
    build_cxdlpv4_container(
        job.width_px,
        job.height_px,
        &meta,
        &small_preview_rle,
        &large_preview_rle,
        &encoded_layers,
        layer_area_stats,
        print_time_sec,
    )
}
