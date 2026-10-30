# Authoring a plugin

Status: **shipped**. This page describes what you can build and import today:
a binary that handshakes. The capability pages in this section describe the
contracts that land next.

The example throughout is AlphaBeta's `AlphaPrint`: id
`alphabeta.alphaprint`, format `.apf`.

## 1. Crate

A plugin is an ordinary Rust binary that depends on the SDK and nothing of ours:

```toml
[package]
name = "alphaprint-plugin"
version = "1.0.0"
edition = "2021"
license = "proprietary"

[dependencies]
dragonfruit-plugin-sdk = { git = "https://github.com/Open-Resin-Alliance/DragonFruit", tag = "sdk-v0.1.0" }
```

While you work against a checkout, a path dependency on
`rust/dragonfruit-plugin-sdk` is the same crate.

## 2. Identity

`PluginIdentity` is the four facts the host checks against the manifest. They
must match it exactly; the host refuses a plugin whose `ready` disagrees, and
that check lands with the spawner described in the overview's status table.

```rust
use dragonfruit_plugin_sdk::{serve, Capability, FormatDecl, PluginIdentity};

struct AlphaPrint;

impl PluginIdentity for AlphaPrint {
    fn plugin_id(&self) -> &str { "alphabeta.alphaprint" }
    fn version(&self) -> &str { "1.0.0" }
    fn capabilities(&self) -> Vec<Capability> {
        vec![Capability::SlicerEncoder, Capability::NetworkOperations]
    }
    fn formats(&self) -> Vec<FormatDecl> {
        vec![FormatDecl { ext: ".apf".to_string() }]
    }
}

fn main() -> std::io::Result<()> {
    serve(std::io::stdin().lock(), std::io::stdout().lock(), &AlphaPrint)
}
```

`formats` is what the host matches against the output extension the user picks;
`capabilities` is what the host will allow you to answer. Declaring less than
you implement is fine; declaring more refuses the plugin.

## 3. Manifest

`dfplugin.json` ships beside your binary, in plaintext, so the import sheet can
show it before anyone is asked for a key:

```json
{
  "formatVersion": 1,
  "id": "alphabeta.alphaprint",
  "name": "AlphaPrint Format",
  "version": "1.0.0",
  "vendor": { "name": "AlphaBeta", "homepage": "https://example.invalid" },
  "minAppVersion": "0.4.0",
  "capabilities": ["slicerEncoder", "networkOperations"],
  "entry": { "kind": "process", "proto": 1, "transport": "shm" },
  "publisher": { "key": "<base64 Ed25519 public key>" },
  "payload": { "sha256": "<hex>", "bytes": 0, "seal": null },
  "formats": [
    { "id": "apf", "extensions": [".apf"], "displayName": "AlphaPrint", "layers": "rle" }
  ]
}
```

Rules the host enforces, in order: `formatVersion` and `entry.proto` must be
known; the signature must verify against `publisher.key`; the key must match the
fingerprint pinned for this id on an earlier import; `minAppVersion` must be
satisfied; then the passphrase, the payload hash, and finally the handshake.

`id` must be lowercase `a-z0-9._-`. Extensions must start with a dot.

## 4. Packing

`rust/dragonfruit-plugin-package` writes the format: it zips the payload,
seals it, signs the manifest and produces the `.dfplugin`. It is
**MIT OR Apache-2.0** with no host code in it, so a vendor's build tool can link
it without touching AGPL terms.

### With the crate

```toml
[dependencies]
dragonfruit-plugin-package = { git = "https://github.com/Open-Resin-Alliance/DragonFruit", tag = "sdk-v0.1.0" }
```

The whole build, from a directory of artifacts to a finished package:

```rust
use std::collections::BTreeMap;
use dragonfruit_plugin_package as pkg;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Payload. Keys are the paths the host extracts, so they must sit under
    //    bin/, lib/ or assets/ (or be README.md). The builder refuses anything
    //    else, and `..`, absolute paths and backslashes are rejected on extract.
    let mut files = BTreeMap::new();
    files.insert(
        "bin/windows/alphaprint-plugin.exe".to_string(),
        std::fs::read("target/x86_64-pc-windows-msvc/release/alphaprint-plugin.exe")?,
    );
    files.insert("assets/alphaprint-logo.png".to_string(), std::fs::read("assets/logo.png")?);
    let payload = pkg::build_payload_zip(&files)?;

    // 2. Signing key. Generate once, keep it secret, keep it stable: the host
    //    pins its fingerprint on first import and refuses a different key later.
    let key = pkg::signing_key_from_seed(read_seed_from_your_secret_store());

    // 3. Manifest. `payload` is filled in by the builder from the real payload.
    let manifest = pkg::Manifest {
        format_version: pkg::FORMAT_VERSION,
        id: "alphabeta.alphaprint".to_string(),
        name: "AlphaPrint Format".to_string(),
        version: "1.0.0".to_string(),
        vendor: pkg::Vendor { name: "AlphaBeta".to_string(), homepage: None },
        min_app_version: "0.4.0".to_string(),
        capabilities: vec![pkg::Capability::SlicerEncoder, pkg::Capability::NetworkOperations],
        entry: pkg::Entry {
            kind: pkg::EntryKind::Process,
            proto: pkg::PROTOCOL_VERSION,
            transport: pkg::Transport::Shm,
        },
        publisher: pkg::Publisher { key: pkg::publisher_key_for(&key) },
        payload: pkg::PayloadRef { sha256: String::new(), bytes: 0, seal: None },
        formats: vec![pkg::FormatDecl {
            id: "apf".to_string(),
            extensions: vec![".apf".to_string()],
            display_name: Some("AlphaPrint".to_string()),
        }],
        network: Some(pkg::NetworkDecl { plugin_id: "alphabeta".to_string() }),
    };

    // 4. Seal, sign, write. `build_package_sealed` draws a fresh nonce and salt;
    //    sealing with a reused nonce breaks the cipher outright, so never pass
    //    your own unless you are reproducing a build in a test.
    let bytes = pkg::build_package_sealed(&manifest, &payload, "customer passphrase", &key)?;
    std::fs::write("alphaprint.dfplugin", bytes)?;
    Ok(())
}
```

| Call | Use |
| --- | --- |
| `build_payload_zip` | payload ZIP from a path→bytes map; enforces the allowed roots |
| `build_package_sealed` | seal with a random nonce and salt, sign, assemble — the one to ship |
| `build_package` | same, with caller-supplied nonce and salt: reproducible builds and tests only |
| `inspect` | parse and verify a package: manifest, fingerprint, sealed flag. Run it on your own output |
| `unseal` | decrypt and check the payload against the manifest hash |
| `extract_payload` | write a payload out, refusing traversal and unknown roots |
| `publisher_key_for` | base64 public key for the manifest, from your signing key |
| `signing_key_from_seed` | deterministic key from 32 bytes — for fixtures and tests; production keys come from your secret store |

`inspect` is worth wiring into the end of your build: it is what the host will
do first, so a package that fails it here fails there.

### With the reference CLI

The crate ships a packer that does the same thing from a binary path:

```bash
cargo run -p dragonfruit-plugin-package --example pack -- \
  --out alphaprint.dfplugin \
  --binary target/release/alphaprint-plugin \
  --id alphabeta.alphaprint \
  --name "AlphaPrint Format" \
  --version 1.0.0 \
  --vendor AlphaBeta \
  --format .apf \
  --passphrase "customer passphrase"
```

| Flag | Meaning |
| --- | --- |
| `--out` | where the `.dfplugin` goes |
| `--binary` | the plugin executable; it is zipped as `bin/<platform>/<file name>` |
| `--id`, `--name`, `--version`, `--vendor` | manifest identity |
| `--format` | output extension the encoder claims, leading dot. Omit for a package that only imports files |
| `--network` | declares the network capability |
| `--layers` | `png` (default) or `rle`: which layer payload the encoder wants |
| `--file-type` | extension the package can open, e.g. `.apf`; adds the fileType capability |
| `--file-type-name` | display name for that extension, shown in the import UI |
| `--min-app-version` | manifest `minAppVersion` (default `0.1.0`) |
| `--passphrase` | seals the payload; omit (or pass an empty value) for an unsealed test package |
| `--seed` | 32 bytes of hex for a deterministic publisher key (default: the fixed dev seed) |

It prints the publisher key and fingerprint; the fingerprint is what the import
sheet shows and what the host pins.

Ship the `.dfplugin` and the passphrase through separate channels. The seal is
what makes a leaked package inert; it is not DRM, because the host must decrypt
the payload to run it.

## 5. Import and verify

Settings → Plugins → the package button → **Allow untrusted plugins?** →
**Enable Sideloading** → **Import package** → the file → review sheet →
passphrase → **Unseal and install**. The row lands in the installed list.

A failed import leaves nothing on disk: the host stages into a sibling directory
and renames. What each failure means:

| Message | Cause |
| --- | --- |
| `Manifest signature does not verify` | manifest bytes changed after signing, or the wrong key |
| `Passphrase does not unseal this package` | wrong key, or the payload was tampered with (the AEAD tag fails the same way) |
| `Payload hash does not match the manifest` | payload replaced without rebuilding the manifest |
| `…already installed from a different publisher key` | same id, different signing key: remove first |
| `This package needs DragonFruit X or newer` | `minAppVersion` above the running build |
| `Unsupported: protocol N` | `entry.proto` this host does not speak |

## 6. Checklist before shipping a build

- `ready` matches the manifest: id, version, capabilities, formats.
- Every exit path closes stdout cleanly; the host treats a closed channel as
  "plugin gone" and fails the in-flight job, not the app.
- Nothing is written outside the output paths you are given.
- The binary is built for each platform you claim to support; a package with no
  binary for the running platform is refused at start, not at import.
- The passphrase is recorded somewhere you can reissue it; there is no key
  recovery, by design.
