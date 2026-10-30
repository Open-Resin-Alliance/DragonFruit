//! `FormatEncoder` adapters for sideloaded plugin encoders.
//!
//! The engine's encoder registry knows compiled-in formats. This module gives it
//! one adapter per output extension a sideloaded package declares, and the
//! adapter forwards a whole job to the plugin process through the runtime.
//!
//! What the adapter does *not* do: stream RLE or raw masks. It asks the engine
//! for PNG layers (the trait's default) because that is the contract the protocol
//! ships today; a format that needs masks is a protocol addition, not a flag.

use std::path::PathBuf;

use dragonfruit_plugin_package as package;
use dragonfruit_slicing_engine::encoders::registry;
use dragonfruit_slicing_engine::encoders::FormatEncoder;
use dragonfruit_slicing_engine::types::{LayerAreaStatsV3, RenderedLayersV3, SliceJobV3};
use dragonfruit_slicing_engine::SlicerV3Error;

use crate::plugin_sideload;
use crate::plugin_sideload_runtime;

pub struct SideloadedEncoder {
    root: PathBuf,
    manifest: package::Manifest,
    /// `FormatEncoder::output_format` returns `&'static str`, and a package's
    /// extension is not a compile-time constant, so the name is interned once at
    /// startup. The count is bounded by the installed formats (a handful), the
    /// leak happens before the first slice, and it never grows at runtime. The
    /// alternative is changing the engine trait and every compiled-in encoder,
    /// which is a worse trade for one string per format.
    output_format: &'static str,
}

impl SideloadedEncoder {
    fn new(root: PathBuf, manifest: package::Manifest, extension: &str) -> Self {
        Self {
            root,
            manifest,
            output_format: Box::leak(extension.to_string().into_boxed_str()),
        }
    }
}

impl FormatEncoder for SideloadedEncoder {
    fn output_format(&self) -> &'static str {
        self.output_format
    }

    fn encode_container_to_path_with_progress(
        &self,
        job: &SliceJobV3,
        rendered_layers: &RenderedLayersV3,
        _layer_area_stats: &[LayerAreaStatsV3],
        output_path: &std::path::Path,
        on_progress: Option<&dyn Fn(u32, u32)>,
    ) -> Result<(), SlicerV3Error> {
        let Some(layers) = rendered_layers.png_layers.as_ref() else {
            return Err(SlicerV3Error::MissingRenderedLayerPayload(
                "a sideloaded encoder is fed PNG layers".to_string(),
            ));
        };
        let job_json = serde_json::to_value(job).map_err(|error| SlicerV3Error::Json(error.to_string()))?;

        let mut progress = |done: u32, total: u32| {
            if let Some(callback) = on_progress {
                callback(done, total);
            }
        };

        plugin_sideload_runtime::encode_with_plugin(
            &self.root,
            &self.manifest.id,
            &self.manifest,
            self.output_format,
            job_json,
            layers,
            output_path,
            &mut progress,
        )
        .map_err(SlicerV3Error::ExternalEncoder)
    }
}

/// Registers an adapter for every installed package that declares the encoder
/// capability. Called once at startup, before the first slice builds the registry.
pub fn register_installed_encoders(root: &std::path::Path) {
    for manifest in plugin_sideload::installed_packages(root) {
        if !manifest
            .capabilities
            .contains(&package::Capability::SlicerEncoder)
        {
            continue;
        }
        for format in &manifest.formats {
            for extension in &format.extensions {
                let encoder = Box::new(SideloadedEncoder::new(
                    root.to_path_buf(),
                    manifest.clone(),
                    extension,
                ));
                if let Err(error) = registry::register_runtime_encoder(encoder) {
                    log::warn!("[plugin-encoder] {}: {error}", manifest.id);
                }
            }
        }
    }
}
