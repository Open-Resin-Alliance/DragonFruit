# File-type import

Status: **shipped**. A package declares its extensions, the host matches a
dropped file by extension, runs the plugin and reads the scene container it
writes back into models, supports included.

## Declaring extensions

The manifest carries them, because the host has to match a file before it starts
anything:

```json
"capabilities": ["fileType"],
"fileTypes": [
  { "extension": ".apf", "displayName": "AlphaPrint project", "isSceneFile": true }
]
```

`fileTypes` without the capability is refused at import, as is an extension that
does not start with a dot or is not lowercase. `isSceneFile` means the payload is
a scene; a single-mesh payload is a future addition, so declare scenes today.

## Messages

```json
→ {"type":"import","id":5,"input":"C:\\…\\import-5\\job.apf","output":"C:\\…\\import-5\\scene.dfimport"}
← {"type":"importDone","id":5,"path":"C:\\…\\import-5\\scene.dfimport"}
```

- The host writes the dropped file's bytes into a directory per import and hands
  both paths over. Read `input`, write `output`; do not assume the file name
  matches the one the user saw beyond what you were given.
- Answer with an the import-done frame frame once the container is complete. The host checks the
  file exists and has the container header before reading it, then deletes the
  directory, so write everything you need inside it.
- Failures are `error` frames with a code (`import-failed`, `import-unsupported`)
  and the host reports the message. A crash is a failed import, not a failed app.

There is no `detect` round trip: the extension in the manifest already chose the
plugin, and a plugin that wants to sniff the file can read `input` itself.

## The scene container (v1)

Little-endian throughout. Values are the host's units: millimetres, and a
transform in the same column-major layout three.js uses.

```text
"DFIMPORT1"           9 bytes ASCII
u32  modelCount       1..=4096
per model:
  u32  metaLength
  utf8 meta           { "modelId": "part-1", "name": "Part One",
                        "transform": [16 floats, column major],
                        "positionCount": 3, "indexCount": 3,
                        "hasNormals": false }
  f32  positions      positionCount * 3     interleaved xyz
  f32  normals        positionCount * 3     only when hasNormals
  u32  indices        indexCount            only when indexCount > 0
  utf8 support        supportLength bytes   only when supportLength > 0
```

`support` is the host's internal support document: `roots`, `trunks`, `branches`,
`leaves`, `braces`, `knots` and the optional collections, in DragonFruit's own
units. The host passes it through to the importer, which validates it, so an
empty object with empty arrays is a valid way to say "this model has none".

`meta.supportLength` is what tells the host a support blob follows.

`modelId` is required and stable: a re-import of the same document must produce
the same ids, because the host stamps them onto models. One entry per model, not
one per file, so a container holding several parts arrives as several models.

The host parses this into geometry, decomposes the transform into position,
rotation and scale, and hands the result to the same import pipeline the
compiled-in formats use (refinement, classification, placement).

### What v1 does not carry

- **Hollowing or punch data.**
- **Per-material assignment.** Geometry is one mesh per model; multi-material
  meshes land with the host's multi-material support, and this container gains a
  per-model material list then.

Each of those is an additive change to the container, so a v1 file stays
readable.

## Writing one

```rust
use dragonfruit_plugin_sdk::{serve, Capability, FormatDecl, Importer, PluginCapabilities, PluginIdentity};

impl Importer for MyImport {
    fn import(&mut self, input: &std::path::Path, output: &std::path::Path) -> Result<(), String> {
        let source = std::fs::read(input).map_err(|error| error.to_string())?;
        // …parse `source`, then write the container described above to `output`
        Ok(())
    }
}
```

`sdk/examples/echo_import.rs` is a complete one: it reads the input, writes a
single triangle with a translation, and the host test parses it back.

## Try it with the reference importer

The SDK ships `echo_import`, which reads any file and writes one triangle plus an
empty support document. Pack it and drop a file on the app:

```bash
cargo build --manifest-path rust/dragonfruit-plugin-sdk/Cargo.toml --example echo_import
cargo run -p dragonfruit-plugin-package --example pack -- \
  --out echo-import-sample.dfplugin \
  --binary rust/dragonfruit-plugin-sdk/target/debug/examples/echo_import \
  --id example.importer --name "Echo Project Import" --version 0.1.0 --vendor DragonFruit \
  --file-type .echo --file-type-name "Echo project"
```

Import that package (no passphrase: it is unsealed), then drop any `.echo` file
into the scene. The model is named with the source file's byte count, which is how
you can tell the plugin actually read it.

## Why a process cannot return three.js objects

The compiled-in tier's `handleFileTypeImport` runs in the webview and returns live
`THREE.BufferGeometry` objects. A sideloaded plugin is a separate process, so the
contract is bytes plus a parser on the host side. That is the whole reason this
container exists.
