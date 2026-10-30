//! Reference import plugin: opens a file and writes the v1 scene container.
//!
//! The container is documented in `docs/dev/plugins-sdk/file-types.md`. This one
//! emits a single triangle so the host parser has something real to read back.
//!
//! ```text
//! cargo build --manifest-path rust/dragonfruit-plugin-sdk/Cargo.toml --example echo_import
//! ```

use std::io::Write;
use std::path::Path;

use dragonfruit_plugin_sdk::{
    serve, Capability, FormatDecl, Importer, PluginCapabilities, PluginIdentity,
};

const MAGIC: &[u8; 9] = b"DFIMPORT1";

struct EchoImport;

impl Importer for EchoImport {
    fn import(&mut self, input: &Path, output: &Path) -> Result<(), String> {
        // Read the source so a plugin that cannot open the file fails here rather
        // than after the host has created a scene.
        let source = std::fs::read(input).map_err(|error| format!("read {}: {error}", input.display()))?;

        let positions: [f32; 9] = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0];
        let indices: [u32; 3] = [0, 1, 2];
        let meta = serde_json::json!({
            "modelId": "echo-0",
            "name": format!("Echo ({} bytes in)", source.len()),
            "transform": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            "positionCount": 3,
            "indexCount": 3,
            "hasNormals": false
        });
        let meta_bytes = serde_json::to_vec(&meta).map_err(|error| error.to_string())?;

        let mut file = std::fs::File::create(output).map_err(|error| error.to_string())?;
        file.write_all(MAGIC).map_err(|error| error.to_string())?;
        file.write_all(&1u32.to_le_bytes()).map_err(|error| error.to_string())?;
        file.write_all(&(meta_bytes.len() as u32).to_le_bytes())
            .map_err(|error| error.to_string())?;
        file.write_all(&meta_bytes).map_err(|error| error.to_string())?;
        for value in positions {
            file.write_all(&value.to_le_bytes()).map_err(|error| error.to_string())?;
        }
        for value in indices {
            file.write_all(&value.to_le_bytes()).map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

struct ImportPlugin;

impl PluginIdentity for ImportPlugin {
    fn plugin_id(&self) -> &str {
        "example.importer"
    }

    fn version(&self) -> &str {
        "1.0.0"
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::FileType]
    }

    fn formats(&self) -> Vec<FormatDecl> {
        Vec::new()
    }
}

impl PluginCapabilities for ImportPlugin {
    fn importer(&self) -> Option<Box<dyn Importer>> {
        Some(Box::new(EchoImport))
    }
}

fn main() {
    serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        &ImportPlugin,
        &ImportPlugin,
        None,
    )
    .expect("control channel");
}
