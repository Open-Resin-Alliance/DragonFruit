# VOXL (V1 + V2)

VOXL is DragonFruit's scene container format (`.voxl`) for full project round-tripping.

## V2 highlights (current default)

- **Binary chunk-based container** — eliminates base64 overhead entirely
- Binary magic header: `VOXL` (0x56 0x4F 0x58 0x4C), `version: 2`
- Independent chunk directory for random access
- Chunk types: `META`, `SCNE`, `MODL`, `MESH`, `SUPP`, `EXTD`
- Mesh data stored as raw binary with per-chunk zlib compression
- `mesh.mode = "embedded-chunk"` — mesh bytes in separate MESH chunk
- **~60–65% smaller** than V1 for typical scenes
- Faster write (no base64 encoding) and faster read (no base64 decoding)

## V1 highlights (still supported for reading)

- Top-level contract: `magic: "VOXL"`, `version: 1`
- Stores complete scene state:
  - models (transform + visibility + display metadata)
  - supports payload (`DragonfruitImportFormat`)
  - active/selected model state
- Embedded mesh support:
  - `mesh.mode = "embedded-file"`
  - `mesh.dataBase64` byte payload
  - `mesh.dataEncoding` (`base64-raw` or `base64-rle-u8`)
  - `mesh.uncompressedSizeBytes` (required for `base64-rle-u8`)
  - `mesh.sha256` integrity checksum over decoded/uncompressed mesh bytes
- Whole-document compression envelope support:
  - top-level `compression.kind = "document-json-utf8"`
  - top-level `compression.encoding` (`base64-raw`, `base64-rle-u8`, or `base64-zlib`)
  - top-level `compression.uncompressedSizeBytes`
  - top-level `compression.payloadBase64`

## Current implementation behavior

- **Export writes V2 binary** by default for optimal size and speed.
- Import auto-detects V1 (JSON, first byte `{`) vs V2 (binary, first bytes `VOXL`).
- V2 export stores raw mesh bytes in MESH chunks with zlib compression (no base64).
- V2 reader provides pre-decoded mesh bytes via `ParsedVoxlResult.meshBytes` map.
- V1 import path is fully preserved (base64 decode, RLE, sha256 validation).
- SHA-256 integrity validation works for both V1 and V2 embedded meshes.

For the normative format contract, see:

- `1_Documentation/VOXL_FORMAT_SPEC.md`
