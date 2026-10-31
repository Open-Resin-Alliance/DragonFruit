//! `FormatEncoder` adapters for sideloaded plugin encoders.
//!
//! The engine's encoder registry knows compiled-in formats. This module gives it
//! one adapter per output extension a sideloaded package declares, and the
//! adapter forwards a whole job to the plugin process through the runtime.
//!
//! What the adapter does *not* do: stream RLE or raw masks. It asks the engine
//! for PNG layers (the trait's default) because that is the contract the protocol
//! ships today; a format that needs masks is a protocol addition, not a flag.

use std::path::{Path, PathBuf};

use dragonfruit_plugin_package as package;
use dragonfruit_plugin_sdk as sdk;
use dragonfruit_slicing_engine::encoders::registry;
use dragonfruit_slicing_engine::encoders::{FormatEncoder, RleStreamEncoder};
use dragonfruit_slicing_engine::rle::RleRun;
use dragonfruit_slicing_engine::types::{LayerAreaStatsV3, RenderedLayersV3, SliceJobV3};
use dragonfruit_slicing_engine::SlicerV3Error;

use crate::plugin_sideload;
use crate::plugin_sideload_runtime;

/// One run is `u32 length | u8 value` on the wire, which is the engine's own run
/// shape with nothing added.
const RUN_BYTES: usize = 5;
/// RLE slots are sized for a full-width layer of single-pixel runs, and capped:
/// a 12K layer is 60 KB of runs, so a megabyte is generous.
const RLE_SLOT_BYTES: u32 = 1024 * 1024;

pub struct SideloadedEncoder {
    root: PathBuf,
    manifest: package::Manifest,
    /// What the package asked for per layer: runs or a PNG.
    layer_kind: package::LayerKind,
    /// `FormatEncoder::output_format` returns `&'static str`, and a package's
    /// extension is not a compile-time constant, so the name is interned once at
    /// startup. The count is bounded by the installed formats (a handful), the
    /// leak happens before the first slice, and it never grows at runtime. The
    /// alternative is changing the engine trait and every compiled-in encoder,
    /// which is a worse trade for one string per format.
    output_format: &'static str,
}

impl SideloadedEncoder {
    fn new(
        root: PathBuf,
        manifest: package::Manifest,
        extension: &str,
        layer_kind: package::LayerKind,
    ) -> Self {
        Self {
            root,
            manifest,
            layer_kind,
            output_format: Box::leak(extension.to_string().into_boxed_str()),
        }
    }
}

/// The streaming shape: the engine rasterises straight to runs and hands each
/// layer over as it is produced, so nothing has to hold a whole image.
struct SideloadedRleSink {
    session: Option<plugin_sideload_runtime::EncodeSession>,
}

impl RleStreamEncoder for SideloadedRleSink {
    fn consume_rle_layer(
        &mut self,
        layer_index: u32,
        runs: Vec<RleRun>,
    ) -> Result<(), SlicerV3Error> {
        let Some(session) = self.session.as_mut() else {
            return Err(SlicerV3Error::ExternalEncoder(
                "the encode session already ended".to_string(),
            ));
        };
        let mut bytes = Vec::with_capacity(runs.len() * RUN_BYTES);
        for run in &runs {
            bytes.extend_from_slice(&run.length.to_le_bytes());
            bytes.push(run.value);
        }
        session
            .send_layer(sdk::SlotKind::Rle, layer_index, &bytes)
            .map_err(SlicerV3Error::ExternalEncoder)?;
        Ok(())
    }

    fn finalize_to_bytes(self: Box<Self>) -> Result<Vec<u8>, SlicerV3Error> {
        Err(SlicerV3Error::ExternalEncoder(
            "a streaming encoder writes to a path".to_string(),
        ))
    }

    fn finalize_to_path(mut self: Box<Self>, output_path: &Path) -> Result<(), SlicerV3Error> {
        let Some(session) = self.session.take() else {
            return Err(SlicerV3Error::ExternalEncoder(
                "the encode session already ended".to_string(),
            ));
        };
        session
            .finish(output_path)
            .map(|_progress| ())
            .map_err(SlicerV3Error::ExternalEncoder)
    }
}

impl FormatEncoder for SideloadedEncoder {
    fn output_format(&self) -> &'static str {
        self.output_format
    }

    fn requires_png_layers(&self) -> bool {
        self.layer_kind == package::LayerKind::Png
    }

    fn read_layer_preview_png(
        &self,
        path: &Path,
        layer_number: u32,
    ) -> Result<Vec<u8>, SlicerV3Error> {
        plugin_sideload_runtime::preview_with_plugin(
            &self.root,
            &self.manifest.id,
            &self.manifest,
            path,
            layer_number,
        )
        .map_err(SlicerV3Error::LayerPreview)
    }

    fn create_rle_stream_encoder(
        &self,
        job: &SliceJobV3,
    ) -> Result<Option<Box<dyn RleStreamEncoder>>, SlicerV3Error> {
        if self.layer_kind != package::LayerKind::Rle {
            return Ok(None);
        }
        let job_json =
            serde_json::to_value(job).map_err(|error| SlicerV3Error::Json(error.to_string()))?;
        let session = plugin_sideload_runtime::EncodeSession::start(
            &self.root,
            &self.manifest.id,
            &self.manifest,
            self.output_format,
            job_json,
            job.total_layers,
            RLE_SLOT_BYTES,
        )
        .map_err(SlicerV3Error::ExternalEncoder)?;
        Ok(Some(Box::new(SideloadedRleSink {
            session: Some(session),
        })))
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
                    format.layer_kind(),
                ));
                if let Err(error) = registry::register_runtime_encoder(encoder) {
                    log::warn!("[plugin-encoder] {}: {error}", manifest.id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_test_support::{install_reference_plugin, temp_dir};
    use dragonfruit_slicing_engine::rle::RleRun;

    fn job(total_layers: u32) -> SliceJobV3 {
        SliceJobV3 {
            output_format: ".exf".to_string(),
            width_px: 4096,
            height_px: 2560,
            total_layers,
            ..SliceJobV3::default()
        }
    }

    /// Drives the streaming shape: two RLE layers in, one container out, with the
    /// plugin reporting the run counts it was given.
    #[test]
    fn streams_rle_layers_through_a_real_plugin_process() {
        let root = temp_dir("rle");
        let manifest = package::Manifest {
            id: "example.encoder".to_string(),
            capabilities: vec![package::Capability::SlicerEncoder],
            formats: vec![package::FormatDecl {
                id: "exf".to_string(),
                extensions: vec![".exf".to_string()],
                display_name: None,
                layers: Some(package::LayerKind::Rle),
            }],
            ..crate::plugin_test_support::manifest(
                "example.encoder",
                vec![package::Capability::SlicerEncoder],
            )
        };
        install_reference_plugin(&root, "echo_encoder", &manifest);

        let encoder = SideloadedEncoder::new(
            root.clone(),
            manifest,
            ".exf",
            package::LayerKind::Rle,
        );
        assert!(!encoder.requires_png_layers(), "an RLE format must not ask for PNGs");

        let output = root.join("job.exf");
        let mut sink = encoder
            .create_rle_stream_encoder(&job(2))
            .expect("create session")
            .expect("a streaming sink");

        let first = vec![RleRun { length: 4096, value: 0 }, RleRun { length: 12, value: 255 }];
        let second = vec![RleRun { length: 4108, value: 0 }];
        sink.consume_rle_layer(0, first).expect("layer 0");
        sink.consume_rle_layer(1, second).expect("layer 1");
        sink.finalize_to_path(&output).expect("finalize");

        let written = std::fs::read(&output).expect("read container");
        assert!(written.starts_with(b"ECHOENC1.exf"));
        assert!(written.windows(3).any(|window| window == b"rle"), "kind not recorded");
        // Two runs for the first layer, one for the second.
        assert!(written.windows(4).any(|window| window == 2u32.to_le_bytes()), "run count 2");
        assert!(written.windows(4).any(|window| window == 1u32.to_le_bytes()), "run count 1");
        assert!(written.ends_with(b"layers=2"));

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Registering an installed package makes its format findable by the engine.
    #[test]
    fn a_registered_package_appears_in_the_engine_registry() {
        let root = temp_dir("registry");
        let manifest = package::Manifest {
            id: "example.encoder".to_string(),
            capabilities: vec![package::Capability::SlicerEncoder],
            formats: vec![package::FormatDecl {
                id: "exf".to_string(),
                extensions: vec![".exf".to_string()],
                display_name: Some("Echo container".to_string()),
                layers: Some(package::LayerKind::Rle),
            }],
            ..crate::plugin_test_support::manifest(
                "example.encoder",
                vec![package::Capability::SlicerEncoder],
            )
        };
        install_reference_plugin(&root, "echo_encoder", &manifest);

        register_installed_encoders(&root);

        let encoder = registry::find_encoder(".exf").expect("the format is registered");
        assert_eq!(encoder.output_format(), ".exf");
        assert!(
            !encoder.requires_png_layers(),
            "an RLE package must not be asked for PNG layers"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A PNG package must not open a streaming session, and the batch path is what
    /// runs instead.
    #[test]
    fn a_png_package_asks_for_png_layers() {
        let manifest = crate::plugin_test_support::manifest(
            "example.encoder",
            vec![package::Capability::SlicerEncoder],
        );
        let encoder = SideloadedEncoder::new(
            std::env::temp_dir(),
            manifest,
            ".exf",
            package::LayerKind::Png,
        );
        assert!(encoder.requires_png_layers());
        assert!(encoder
            .create_rle_stream_encoder(&job(1))
            .expect("no session")
            .is_none());
    }
}
