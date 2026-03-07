# VOXL (V1)

VOXL is DragonFruit's scene container format (`.voxl`) for full project round-tripping.

## V1 highlights

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

- Export writes embedded STL mesh payloads for single-file scene portability.
- Export computes SHA-256 for each embedded mesh and includes it in the file.
- Export uses RLE encoding only when it reduces payload size.
- Export can serialize the entire document as a compressed envelope (auto mode picks smallest of raw/RLE/zlib).
- Import verifies `sha256` when present and rejects mismatched embedded meshes.
- Import supports both direct scene JSON and compressed-envelope JSON profiles.

For the normative format contract, see:

- `1_Documentation/VOXL_FORMAT_SPEC.md`
