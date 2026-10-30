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
    PluginIdentity,
};

#[derive(Default)]
struct EchoEncoder {
    file: Option<std::fs::File>,
    layers: u64,
}

impl Encoder for EchoEncoder {
    fn begin(&mut self, start: EncodeStart<'_>) -> Result<(), String> {
        let mut file = std::fs::File::create(start.output).map_err(|error| error.to_string())?;
        file.write_all(b"ECHOENC1").map_err(|error| error.to_string())?;
        file.write_all(start.format.as_bytes())
            .map_err(|error| error.to_string())?;
        self.file = Some(file);
        Ok(())
    }

    fn layer(&mut self, layer: LayerRef<'_>) -> Result<(), String> {
        let file = self.file.as_mut().ok_or_else(|| "no session".to_string())?;
        file.write_all(&layer.index.to_le_bytes())
            .map_err(|error| error.to_string())?;
        file.write_all(&(layer.bytes.len() as u32).to_le_bytes())
            .map_err(|error| error.to_string())?;
        file.write_all(layer.bytes)
            .map_err(|error| error.to_string())?;
        self.layers += 1;
        Ok(())
    }

    fn finish(&mut self) -> Result<u64, String> {
        let file = self.file.as_mut().ok_or_else(|| "no session".to_string())?;
        file.flush().map_err(|error| error.to_string())?;
        let bytes = file.metadata().map_err(|error| error.to_string())?.len();
        file.write_all(format!("layers={}", self.layers).as_bytes())
            .map_err(|error| error.to_string())?;
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
}

fn main() {
    // The host maps the ring and passes its path. The SDK stays free of mapping
    // dependencies, so opening it is the plugin's job.
    let ring_path = std::env::var("DF_PLUGIN_RING").expect("DF_PLUGIN_RING is set by the host");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&ring_path)
        .unwrap_or_else(|error| panic!("open ring {ring_path}: {error}"));
    // SAFETY: the host owns the file for the session and is the only other mapper;
    // the ring's own accessors keep the two sides in order.
    let mut mapping = unsafe { memmap2::MmapMut::map_mut(&file) }.expect("map the ring");

    serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        &EncoderPlugin,
        &EncoderPlugin,
        Some(&mut mapping[..]),
    )
    .expect("control channel");
}
