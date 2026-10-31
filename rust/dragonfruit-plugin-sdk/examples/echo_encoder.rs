//! Reference encoder plugin: writes a container that records what it was given.
//!
//! The output is `ECHOENC1` followed by the format, then `(index, length, bytes)`
//! per layer, so a test can assert that every layer crossed the ring intact.
//!
//! ```text
//! set DF_PLUGIN_RING=<path>          # the host sets this
//! cargo build --manifest-path rust/dragonfruit-plugin-sdk/Cargo.toml --example echo_encoder
//! ```

use std::io::Write;

use dragonfruit_plugin_sdk::{
    serve, Capability, EncodeStart, Encoder, FormatDecl, LayerRef, PluginCapabilities,
    PluginIdentity, Runs, SlotKind,
};

#[derive(Default)]
struct EchoEncoder {
    format: String,
    /// `(index, kind, run count, bytes)` per layer, kept until `finish` because a
    /// streaming session does not learn its destination path until then.
    layers: Vec<(u32, &'static str, u32, Vec<u8>)>,
    /// Bytes of the scene payload the host baked into the job metadata, when the
    /// profile asked for one. Read from `job.metadata_json`.
    scene_bytes: Option<usize>,
}

impl Encoder for EchoEncoder {
    fn begin(&mut self, start: EncodeStart<'_>) -> Result<(), String> {
        self.format = start.format.to_string();
        self.scene_bytes = start
            .job
            .get("metadata_json")
            .and_then(|value| value.as_str())
            .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            .and_then(|metadata| metadata.get("echo")?.get("sceneBase64")?.as_str().map(str::len));
        Ok(())
    }

    fn layer(&mut self, layer: LayerRef<'_>) -> Result<(), String> {
        let (kind, runs) = match layer.kind {
            // Count runs straight out of the wire bytes: no allocation, no Vec.
            SlotKind::Rle => ("rle", Runs::new(layer.bytes)?.len() as u32),
            SlotKind::Png => ("png", 0),
            SlotKind::RawMask => ("mask", 0),
        };
        self.layers
            .push((layer.index, kind, runs, layer.bytes.to_vec()));
        Ok(())
    }

    fn finish(&mut self, output: &std::path::Path) -> Result<u64, String> {
        let mut file = std::fs::File::create(output).map_err(|error| error.to_string())?;
        file.write_all(b"ECHOENC1").map_err(|error| error.to_string())?;
        file.write_all(self.format.as_bytes()).map_err(|error| error.to_string())?;
        for (index, kind, runs, bytes) in &self.layers {
            file.write_all(&index.to_le_bytes()).map_err(|error| error.to_string())?;
            file.write_all(&(bytes.len() as u32).to_le_bytes())
                .map_err(|error| error.to_string())?;
            file.write_all(kind.as_bytes()).map_err(|error| error.to_string())?;
            file.write_all(&runs.to_le_bytes()).map_err(|error| error.to_string())?;
            file.write_all(bytes).map_err(|error| error.to_string())?;
        }
        file.write_all(format!("layers={}", self.layers.len()).as_bytes())
            .map_err(|error| error.to_string())?;
        if let Some(bytes) = self.scene_bytes {
            file.write_all(format!(" scene={bytes}").as_bytes())
                .map_err(|error| error.to_string())?;
        }
        let bytes = file.metadata().map_err(|error| error.to_string())?.len();
        Ok(bytes)
    }
}

struct EncoderPlugin;

impl PluginIdentity for EncoderPlugin {
    fn plugin_id(&self) -> &str {
        "example.encoder"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::SlicerEncoder]
    }

    fn formats(&self) -> Vec<FormatDecl> {
        vec![FormatDecl {
            ext: ".exf".to_string(),
        }]
    }
}

impl PluginCapabilities for EncoderPlugin {
    fn encoder(&self) -> Option<Box<dyn Encoder>> {
        Some(Box::new(EchoEncoder::default()))
    }

    /// A real format decodes its own container here. The reference one answers
    /// with a fixed PNG-shaped payload so the host path can be exercised.
    fn preview(&self, archive: &std::path::Path, layer: u32) -> Result<Vec<u8>, String> {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(format!("echo-preview:{}:{layer}", archive.display()).as_bytes());
        Ok(png)
    }
}

fn main() {
    // The host maps the ring for encode sessions and omits it for everything else
    // (a preview opens the process on its own), so the mapping is optional.
    let ring_path = std::env::var("DF_PLUGIN_RING").ok();
    let mut mapping = ring_path.map(|path| {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap_or_else(|error| panic!("open ring {path}: {error}"));
        // SAFETY: the host owns the file for the session and is the only other
        // mapper; the ring's own accessors keep the two sides in order.
        unsafe { memmap2::MmapMut::map_mut(&file) }.expect("map the ring")
    });

    serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        &EncoderPlugin,
        &EncoderPlugin,
        mapping.as_mut().map(|mapping| &mut mapping[..]),
    )
    .expect("control channel");
}
