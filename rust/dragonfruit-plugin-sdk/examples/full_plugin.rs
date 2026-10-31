//! A plugin that uses every capability, as one worked example.
//!
//! It is deliberately small but complete: an encoder that records the layer
//! stream instead of writing a real container, an importer that writes a
//! one-triangle scene, a declared network mode that answers the SDK's payload
//! contract, and a preview
//! decoder. Each part is the minimum that demonstrates the contract, so a reader
//! can lift one block and replace the recording with their format.
//!
//! ```text
//! cargo build --manifest-path rust/dragonfruit-plugin-sdk/Cargo.toml --example full_plugin
//! ```
//!
//! Pack it with `examples/pack`, see `docs/dev/plugins-sdk/authoring.md` for the
//! command that also carries the sample printer preset and material template.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use dragonfruit_plugin_sdk::{
    serve, Capability, EncodeStart, Encoder, FormatDecl, Importer, LayerRef, PluginCapabilities,
    PluginIdentity, Runs, SlotKind,
};

const CONTAINER_MAGIC: &[u8; 9] = b"DFIMPORT1";

// --- identity -------------------------------------------------------------

struct FullPlugin;

impl PluginIdentity for FullPlugin {
    fn plugin_id(&self) -> &str {
        "example.full"
    }

    fn version(&self) -> &str {
        "0.1.0"
    }

    fn capabilities(&self) -> Vec<Capability> {
        vec![
            Capability::SlicerEncoder,
            Capability::NetworkOperations,
            Capability::FileType,
        ]
    }

    fn formats(&self) -> Vec<FormatDecl> {
        vec![FormatDecl {
            ext: ".exf".to_string(),
        }]
    }
}

// --- encoder --------------------------------------------------------------

#[derive(Default)]
struct EchoEncoder {
    format: String,
    /// `(layer index, kind, run count, bytes)`, kept until `finish` because the
    /// destination path only arrives with the host's encode-end message.
    layers: Vec<(u32, &'static str, u32, Vec<u8>)>,
}

impl Encoder for EchoEncoder {
    fn begin(&mut self, start: EncodeStart<'_>) -> Result<(), String> {
        self.format = start.format.to_string();
        Ok(())
    }

    fn layer(&mut self, layer: LayerRef<'_>) -> Result<(), String> {
        // RLE payloads are walked in place; nothing is collected per layer.
        let (kind, runs) = match layer.kind {
            SlotKind::Rle => ("rle", Runs::new(layer.bytes)?.len() as u32),
            SlotKind::Png => ("png", 0),
            SlotKind::RawMask => ("mask", 0),
        };
        self.layers
            .push((layer.index, kind, runs, layer.bytes.to_vec()));
        Ok(())
    }

    fn finish(&mut self, output: &Path) -> Result<u64, String> {
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
        let bytes = file.metadata().map_err(|error| error.to_string())?.len();
        Ok(bytes)
    }
}

// --- importer -------------------------------------------------------------

struct EchoImporter;

impl Importer for EchoImporter {
    fn import(&mut self, input: &Path, output: &Path) -> Result<(), String> {
        let source = std::fs::read(input).map_err(|error| format!("read {}: {error}", input.display()))?;

        // Empty arrays are a valid support document: the collections exist and
        // hold nothing.
        let support = serde_json::json!({
            "roots": [], "trunks": [], "branches": [], "leaves": [], "braces": [], "knots": []
        });
        let support_bytes = serde_json::to_vec(&support).map_err(|error| error.to_string())?;

        let positions: [f32; 9] = [0.0, 0.0, 0.0, 10.0, 0.0, 0.0, 0.0, 10.0, 0.0];
        let indices: [u32; 3] = [0, 1, 2];
        let meta = serde_json::json!({
            "modelId": "echo-0",
            "name": format!("Echo ({} bytes in)", source.len()),
            "transform": [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
            "positionCount": 3,
            "indexCount": 3,
            "hasNormals": false,
            "supportLength": support_bytes.len()
        });
        let meta_bytes = serde_json::to_vec(&meta).map_err(|error| error.to_string())?;

        let mut file = std::fs::File::create(output).map_err(|error| error.to_string())?;
        file.write_all(CONTAINER_MAGIC).map_err(|error| error.to_string())?;
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
        file.write_all(&support_bytes).map_err(|error| error.to_string())?;
        Ok(())
    }
}

// --- capabilities ---------------------------------------------------------

#[derive(Default)]
struct FullCapabilities {
    /// Upload sessions stay here between requests: the host sends `begin`, one
    /// `chunk` per request, then `end`. The process is warm, so this is enough.
    uploads: Mutex<HashMap<String, PathBuf>>,
}

impl FullCapabilities {
    /// The chunked upload contract: `begin` names the file, `chunk` proves the
    /// plugin can read it at that offset, `end` reports the plate. A real backend
    /// would send the bytes it reads to the printer instead.
    fn upload(&self, request: &serde_json::Value) -> (u16, serde_json::Value) {
        let phase = request.get("phase").and_then(|value| value.as_str()).unwrap_or("");
        let mut uploads = self.uploads.lock().expect("upload state");

        match phase {
            "begin" => {
                let source = request.get("sourcePath").and_then(|value| value.as_str()).unwrap_or("");
                let total = request.get("totalBytes").and_then(|value| value.as_u64()).unwrap_or(0);
                if source.is_empty() {
                    return (400, serde_json::json!({ "error": "upload begin needs sourcePath" }));
                }
                let id = format!("echo-upload-{}", uploads.len() + 1);
                uploads.insert(id.clone(), PathBuf::from(source));
                (200, serde_json::json!({ "uploadId": id, "totalBytes": total }))
            }
            "chunk" => {
                let Some(upload_id) = request.get("uploadId").and_then(|value| value.as_str()) else {
                    return (400, serde_json::json!({ "error": "upload chunk needs uploadId" }));
                };
                let Some(path) = uploads.get(upload_id) else {
                    return (404, serde_json::json!({ "error": "unknown upload id" }));
                };
                let offset = request.get("offset").and_then(|value| value.as_u64()).unwrap_or(0);
                let length = request.get("length").and_then(|value| value.as_u64()).unwrap_or(0);
                let mut file = match std::fs::File::open(path) {
                    Ok(file) => file,
                    Err(error) => return (500, serde_json::json!({ "error": error.to_string() })),
                };
                if std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(offset)).is_err() {
                    return (500, serde_json::json!({ "error": "seek failed" }));
                }
                let mut buffer = vec![0u8; length as usize];
                let read = std::io::Read::read(&mut file, &mut buffer).unwrap_or(0);
                // `received` is what the host shows as progress; the demo consumed
                // the bytes and threw them away.
                (200, serde_json::json!({ "received": offset + read as u64 }))
            }
            "end" => {
                let Some(upload_id) = request.get("uploadId").and_then(|value| value.as_str()) else {
                    return (400, serde_json::json!({ "error": "upload end needs uploadId" }));
                };
                if uploads.remove(upload_id).is_none() {
                    return (404, serde_json::json!({ "error": "unknown upload id" }));
                }
                (200, serde_json::json!({ "ok": true, "plateId": 1 }))
            }
            other => (400, serde_json::json!({ "error": format!("unknown upload phase: {other}") })),
        }
    }
}

impl PluginCapabilities for FullCapabilities {
    fn network(&self, request: serde_json::Value) -> (u16, serde_json::Value) {
        let operation = request
            .get("operation")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim_matches('/');

        // The names below are the ones `docs/dev/plugins-sdk/network.md` fixes for a
        // declared mode. A package that likes other names declares them in the
        // manifest's `network.operations` map; the panel calls whatever it finds
        // there, so both sides only ever share these payload shapes.
        let host = request
            .get("host")
            .and_then(|value| value.as_str())
            .unwrap_or("127.0.0.1");

        if operation == "upload" {
            return self.upload(&request);
        }

        match operation {
            "connect" => (
                200,
                serde_json::json!({
                    "connected": true,
                    "ipAddress": host,
                    "hostName": "echo",
                    "printerName": "Echo Printer",
                    "printerModel": "Echo",
                    "statusText": "Idle",
                }),
            ),
            "discover" => (
                200,
                serde_json::json!({
                    "devices": [{
                        "ipAddress": host,
                        "hostName": "echo",
                        "printerName": "Echo Printer",
                        "printerModel": "Echo",
                        "statusText": "Idle",
                    }],
                    "done": true,
                    "scannedEndpoints": 1,
                    "totalEndpoints": 1,
                }),
            ),
            "status" => (
                200,
                serde_json::json!({
                    "connected": true,
                    "stateText": "Idle",
                    "isPrinting": false,
                    "isPaused": false,
                    "finished": false,
                    "progressPct": 0,
                    "currentLayer": 0,
                    "totalLayers": 0,
                    "plateId": 1,
                    "jobName": null,
                    "etaSec": null,
                }),
            ),
            // Every command answers the same envelope: the panel only needs to know
            // whether the print accepted the instruction.
            "start" | "pause" | "resume" | "cancel" | "deletePlate" | "emergencyStop" => {
                (200, serde_json::json!({ "ok": true }))
            }
            // On-device materials, shaped by `full_plugin_remote_materials.json`: the
            // keys the dialog sends back on save are the keys in `meta`.
            "materials" => (
                200,
                serde_json::json!({
                    "materials": [
                        {
                            "id": "1",
                            "name": "Echo Standard",
                            "meta": { "exposureSec": 2.5, "liftMm": 6, "resinType": "standard" },
                        },
                        {
                            "id": "2",
                            "name": "Echo Tough",
                            "meta": { "exposureSec": 3.2, "liftMm": 7, "resinType": "tough" },
                        },
                    ],
                }),
            ),
            "materialsEdit" => (200, serde_json::json!({ "ok": true })),
            // The raw protocol operations, kept so the host tests can drive the ring
            // without going through the declared-mode contract.
            "printer/status" => (
                200,
                serde_json::json!({ "state": "printing", "progress": 0.42, "layer": 312 }),
            ),
            "printer/start" => (200, serde_json::json!({ "accepted": true })),
            "echo" => (200, serde_json::json!({ "echoed": request })),
            other => (
                404,
                serde_json::json!({ "error": format!("unknown operation: {other}") }),
            ),
        }
    }

    fn encoder(&self) -> Option<Box<dyn Encoder>> {
        Some(Box::new(EchoEncoder::default()))
    }

    fn importer(&self) -> Option<Box<dyn Importer>> {
        Some(Box::new(EchoImporter))
    }

    fn preview(&self, archive: &Path, layer: u32) -> Result<Vec<u8>, String> {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(format!("full-plugin-preview:{}:{layer}", archive.display()).as_bytes());
        Ok(png)
    }
}

fn main() {
    // The host maps the ring for encode sessions and omits it for everything else,
    // so the mapping is optional.
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
        &FullPlugin,
        &FullCapabilities::default(),
        mapping.as_mut().map(|mapping| &mut mapping[..]),
    )
    .expect("control channel");
}
