# VOXL Scene Format Specification (V1)

Status: **V1 (Current)**  
Owner: DragonFruit / Open Resin Alliance  
License intent: **Open documentation + open implementation**

## 1) Purpose

`VOXL` is DragonFruit’s native, open scene format for preserving complete project state beyond mesh-only files.

Primary goals:

- Save/load complete scene state (models + supports + selection/context).
- Be human-readable by default (JSON-based v1).
- Be forward-compatible via explicit versioning and extension rules.
- Avoid vendor lock-in: spec and codec are public and permissive.

## 2) File extension and media type

- Extension: `.voxl`
- UTF-8 JSON document (either full scene JSON or compressed-envelope JSON)
- Proposed media type (provisional): `application/vnd.dragonfruit.voxl+json`

## 3) Versioning

Top-level required fields:

- `magic`: must be `"VOXL"`
- `version`: integer format version (current: `1`)

Reader policy:

- Same major version: reader SHOULD attempt load.
- Higher unknown major: reader MUST fail with clear compatibility error.
- Unknown fields: reader MUST ignore unless required by `extensions` contract.

## 4) Coordinate and unit conventions

- Units: millimeters (`mm`)
- Coordinate basis: right-handed, `Z-up`
- Rotation storage in v1: Euler radians (`XYZ` field order documented in payload)

## 5) Top-level structure (v1)

v1 supports two valid top-level profiles:

1. **Direct scene JSON** (human-readable full document)
2. **Compressed envelope JSON** (whole-document compressed payload)

### 5.1 Direct scene JSON (full document)

```json
{
  "magic": "VOXL",
  "version": 1,
  "meta": {
    "generator": "DragonFruit",
    "generatorVersion": "0.1.0",
    "createdAt": "2026-03-07T12:34:56.000Z",
    "updatedAt": "2026-03-07T12:34:56.000Z",
    "units": "mm",
    "coordinateSystem": "right-handed-z-up"
  },
  "scene": {
    "activeModelId": "model-1",
    "selectedModelIds": ["model-1"]
  },
  "models": [
    {
      "id": "model-1",
      "name": "part.stl",
      "visible": true,
      "color": "#a3a3a3",
      "polygonCount": 120034,
      "fileSizeBytes": 512034,
      "transform": {
        "position": { "x": 0, "y": 0, "z": 5.2 },
        "rotation": { "x": 0, "y": 0, "z": 0 },
        "scale": { "x": 1, "y": 1, "z": 1 }
      },
      "mesh": {
        "mode": "embedded-file",
        "fileName": "part.stl",
        "mimeType": "model/stl",
        "dataEncoding": "base64-rle-u8",
        "uncompressedSizeBytes": 512034,
        "sha256": "7f2c5f3de2e2b89fc8b81fd77f4f5ef88e0188be857f8e6f4b5f7ec10f0f7a95",
        "dataBase64": "...base64-encoded-bytes..."
      }
    }
  ],
  "supports": {
    "version": 1,
    "meta": {
      "source": "dragonfruit-voxl",
      "objectCenter": { "x": 0, "y": 0, "z": 0 },
      "updatedAt": 1768574400000
    },
    "roots": [],
    "trunks": [],
    "branches": [],
    "leaves": [],
    "twigs": [],
    "sticks": [],
    "braces": [],
    "knots": [],
    "kickstands": []
  },
  "extensions": {}
}
```

### 5.2 Compressed envelope JSON (whole-document compression)

```json
{
  "magic": "VOXL",
  "version": 1,
  "compression": {
    "kind": "document-json-utf8",
    "encoding": "base64-zlib",
    "uncompressedSizeBytes": 942183,
    "payloadBase64": "...base64-encoded-compressed-json-bytes..."
  }
}
```

Envelope rules:

- `compression.kind` MUST be `document-json-utf8`.
- `compression.encoding` supports:
  - `base64-raw` (UTF-8 JSON bytes, base64 encoded)
  - `base64-rle-u8` (RLE count/value pairs of UTF-8 JSON bytes, then base64)
  - `base64-zlib` (zlib-compressed UTF-8 JSON bytes, then base64)
- `uncompressedSizeBytes` is required and MUST match decoded UTF-8 JSON byte length.
- The decoded payload MUST parse to a valid direct scene JSON document (profile 5.1).

## 6) Mesh payload strategy (v1)

`models[].mesh.mode` supports:

- `none` — metadata-only model entry (placeholder)
- `external-file` — mesh expected from sidecar/external source
- `embedded-file` — base64 data is embedded in VOXL document

`models[].mesh.dataEncoding` (optional, default `base64-raw`):

- `base64-raw` — `dataBase64` is raw STL bytes encoded as base64.
- `base64-rle-u8` — `dataBase64` stores run-length encoded bytes (count/value pairs) as base64.

When `dataEncoding` is `base64-rle-u8`, `uncompressedSizeBytes` is required and represents the decoded byte length.

`models[].mesh.sha256` (optional but recommended):

- Lowercase or uppercase hex SHA-256 digest of the **decoded, uncompressed** mesh byte payload.
- Readers should validate this when present and treat mismatch as an integrity failure for that model.

Notes:

- DragonFruit currently exports VOXL models as `embedded-file` binary STL payloads to ensure single-file round-trip import.
- DragonFruit v1 now writes `sha256` for embedded meshes and may use `base64-rle-u8` when smaller than raw payload.
- DragonFruit v1 may serialize the **entire VOXL document** through a compressed-envelope profile (`base64-zlib`, `base64-rle-u8`, or `base64-raw`).
- In auto mode, DragonFruit picks the smallest compressed-envelope payload candidate.
- Reader should gracefully skip unsupported mesh modes and continue importing any valid entries.
- Additional compression/container profiles may still be added in v2+.

## 7) Supports payload

v1 reuses the existing DragonFruit support interchange shape (`DragonfruitImportFormat`) to reduce migration risk.

This provides immediate compatibility with current support state machinery while VOXL matures as the canonical container.

## 8) Extension policy

Top-level `extensions` is a string-keyed object reserved for experimental or vendor-specific fields.

Rules:

- Readers MUST ignore unknown extension keys.
- Extension keys SHOULD be namespaced (example: `"ora.preview"`).
- Core semantics must remain in standard fields (`magic`, `version`, `scene`, `models`, `supports`).

## 9) Security and integrity

Recommended reader behavior:

- Reject malformed JSON and invalid required fields.
- Enforce practical input size limits.
- Validate IDs and numeric transform fields before apply.
- For `embedded-file`, validate declared mime/size before decoding.
- When `sha256` exists, verify digest before using embedded mesh bytes.
- For `base64-rle-u8`, validate pair structure and decoded length before decoding/import.
- For `base64-zlib`, validate decompression success and decoded byte length before parsing JSON.
- For compressed-envelope VOXL files, validate envelope fields, decode payload safely, then validate decoded scene JSON as normal VOXL.

## 10) Roadmap (non-normative)

- v1.1: optional additional integrity metadata (whole-file digest/signature envelope).
- v2: optional alternative container profiles (`.voxlz`) and chunk tables.
- v2+: incremental autosave deltas and conflict-merge metadata.
