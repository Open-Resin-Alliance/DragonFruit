# VOXL Format Specification

**Document ID:** ORA-VOXL-SPEC  
**Revision:** 2.0  
**Status:** Current  
**Owner:** Open Resin Alliance

---

## 1. Scope

This specification defines VOXL scene files used by DragonFruit-compatible applications.

VOXL stores:

- scene metadata,
- model state and transforms,
- mesh payload references and embedded mesh payloads,
- support payloads,
- extension payloads.

Defined container generations:

| Generation | Container                                  | Status                 |
| ---------- | ------------------------------------------ | ---------------------- |
| V1         | UTF-8 JSON (direct or compressed envelope) | Legacy (read required) |
| V2         | Binary chunk container                     | Current (read/write)   |

Conforming readers MUST support V1 and V2.  
Conforming writers SHOULD emit V2.

---

## 2. Normative Terms

The keywords MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as described in RFC 2119.

---

## 3. Common Conventions

### 3.1 Extension and Media Type

- Extension: `.voxl`
- Media type: `application/vnd.dragonfruit.voxl`

### 3.2 Units and Coordinate Basis

- Length unit: millimetres (`mm`)
- Basis: right-handed, Z-up
- Rotation storage: Euler radians (XYZ order)

### 3.3 Format Detection

Reader format detection MUST inspect initial bytes:

| Leading bytes                  | Interpretation |
| ------------------------------ | -------------- |
| `0x7B` (`{`)                   | V1 JSON        |
| `0x56 0x4F 0x58 0x4C` (`VOXL`) | V2 Binary      |

Unrecognized leading bytes MUST cause parse failure.

### 3.4 Numeric Validity

All vector and transform numeric fields MUST be finite IEEE 754 values.

---

## 4. V1 JSON Container

### 4.1 Allowed Top-Level Profiles

V1 allows exactly two top-level profiles:

1. direct scene JSON document,
2. compressed envelope JSON document.

### 4.2 Direct Scene JSON

#### 4.2.1 Root Object

| Field        | Type    | Required | Constraint                         |
| ------------ | ------- | -------- | ---------------------------------- |
| `magic`      | string  | YES      | MUST equal `"VOXL"`                |
| `version`    | integer | YES      | MUST equal `1`                     |
| `meta`       | object  | YES      | See 4.2.2                          |
| `scene`      | object  | YES      | See 4.2.3                          |
| `models`     | array   | YES      | elements are ModelEntryV1          |
| `supports`   | object  | YES      | DragonfruitImportFormat-compatible |
| `extensions` | object  | NO       | See Section 7                      |

#### 4.2.2 `meta` Object

| Field              | Type   | Required | Constraint                       |
| ------------------ | ------ | -------- | -------------------------------- |
| `generator`        | string | YES      |                                  |
| `generatorVersion` | string | NO       |                                  |
| `createdAt`        | string | YES      | ISO 8601 timestamp               |
| `updatedAt`        | string | YES      | ISO 8601 timestamp               |
| `units`            | string | YES      | MUST equal `"mm"`                |
| `coordinateSystem` | string | YES      | MUST equal `"right-handed-z-up"` |

#### 4.2.3 `scene` Object

| Field              | Type           | Required |
| ------------------ | -------------- | -------- |
| `activeModelId`    | string \| null | YES      |
| `selectedModelIds` | string[]       | YES      |

#### 4.2.4 ModelEntryV1

| Field           | Type    | Required | Constraint                   |
| --------------- | ------- | -------- | ---------------------------- |
| `id`            | string  | YES      | SHOULD be unique in document |
| `name`          | string  | YES      |                              |
| `visible`       | boolean | YES      |                              |
| `color`         | string  | YES      |                              |
| `polygonCount`  | integer | YES      | non-negative                 |
| `fileSizeBytes` | integer | NO       | non-negative                 |
| `transform`     | object  | YES      | See 4.2.5                    |
| `mesh`          | object  | YES      | See 4.2.6                    |

#### 4.2.5 `transform`

| Field      | Type      | Required | Constraint                  |
| ---------- | --------- | -------- | --------------------------- |
| `position` | `{x,y,z}` | YES      | finite components           |
| `rotation` | `{x,y,z}` | YES      | finite components           |
| `scale`    | `{x,y,z}` | YES      | finite, non-zero components |

#### 4.2.6 `mesh` (V1)

| Field                   | Type    | Required    | Constraint                                      |
| ----------------------- | ------- | ----------- | ----------------------------------------------- |
| `mode`                  | string  | YES         | one of `none`, `external-file`, `embedded-file` |
| `fileName`              | string  | NO          |                                                 |
| `mimeType`              | string  | NO          |                                                 |
| `dataBase64`            | string  | CONDITIONAL | required when `mode = embedded-file`            |
| `dataEncoding`          | string  | NO          | default `base64-raw`                            |
| `uncompressedSizeBytes` | integer | CONDITIONAL | required for `base64-rle-u8`                    |
| `sha256`                | string  | NO          | 64 hex chars                                    |

### 4.3 V1 Mesh Encodings

| Encoding        | Definition                                  |
| --------------- | ------------------------------------------- |
| `base64-raw`    | raw mesh bytes, base64-encoded              |
| `base64-rle-u8` | RLE byte pairs `[count,value]`, then base64 |

For `base64-rle-u8`:

- run count MUST be in `[1,255]`,
- pair stream length MUST be even,
- decoded size MUST equal `uncompressedSizeBytes`.

### 4.4 V1 Compressed Envelope

| Field                               | Type    | Required | Constraint                      |
| ----------------------------------- | ------- | -------- | ------------------------------- |
| `magic`                             | string  | YES      | MUST equal `"VOXL"`             |
| `version`                           | integer | YES      | MUST equal `1`                  |
| `compression.kind`                  | string  | YES      | MUST equal `document-json-utf8` |
| `compression.encoding`              | string  | YES      | one of values below             |
| `compression.uncompressedSizeBytes` | integer | YES      | positive                        |
| `compression.payloadBase64`         | string  | YES      | non-empty                       |

Allowed `compression.encoding` values:

- `base64-raw`
- `base64-rle-u8`
- `base64-zlib`

Decoded envelope payload MUST parse as valid V1 direct scene JSON.

### 4.5 V1 Integrity Field

If `mesh.sha256` is present, it MUST represent SHA-256 over decoded, uncompressed mesh bytes.

---

## 5. V2 Binary Chunk Container

### 5.1 Endianness

All integer fields are little-endian.

### 5.2 File Header (16 bytes)

| Offset | Size | Type     | Field        | Constraint                  |
| ------ | ---- | -------- | ------------ | --------------------------- |
| 0      | 4    | ASCII[4] | `magic`      | MUST equal `VOXL`           |
| 4      | 2    | uint16   | `version`    | MUST equal `2`              |
| 6      | 2    | uint16   | `flags`      | reserved                    |
| 8      | 4    | uint32   | `chunkCount` | number of directory entries |
| 12     | 4    | uint32   | `reserved`   | reserved                    |

### 5.3 Chunk Directory Entry (20 bytes)

Directory starts at byte offset 16 and contains `chunkCount` entries.

| Offset | Size | Type     | Field              |
| ------ | ---- | -------- | ------------------ |
| 0      | 4    | ASCII[4] | `type`             |
| 4      | 2    | uint16   | `index`            |
| 6      | 2    | uint16   | `compression`      |
| 8      | 4    | uint32   | `offset`           |
| 12     | 4    | uint32   | `compressedSize`   |
| 16     | 4    | uint32   | `uncompressedSize` |

For each entry, `offset + compressedSize` MUST be within file bounds.

### 5.4 Compression Codes

| Code | Compression |
| ---- | ----------- |
| `0`  | none        |
| `1`  | zlib        |

Unknown compression codes MUST be rejected.

### 5.5 Chunk Types

| Type   | Cardinality             | Payload                      |
| ------ | ----------------------- | ---------------------------- |
| `META` | exactly one (`index=0`) | UTF-8 JSON metadata          |
| `SCNE` | exactly one (`index=0`) | UTF-8 JSON scene state       |
| `MODL` | exactly one (`index=0`) | UTF-8 JSON model array       |
| `MESH` | zero or more            | raw mesh bytes               |
| `SUPP` | exactly one (`index=0`) | UTF-8 JSON supports payload  |
| `EXTD` | zero or one (`index=0`) | UTF-8 JSON extensions object |

Unknown chunk types MUST be ignored.

### 5.6 V2 Model-to-Mesh Binding

For model `MODL[i]` with `mesh.mode = "embedded-chunk"`:

- corresponding mesh bytes MUST be in `MESH` chunk with `index = i`,
- `mesh.dataBase64` MUST NOT be present,
- `mesh.uncompressedSizeBytes` MUST equal decoded MESH byte length.

### 5.7 V2 Mesh Object

| Field                   | Type    | Required | Constraint                      |
| ----------------------- | ------- | -------- | ------------------------------- |
| `mode`                  | string  | YES      | MUST equal `embedded-chunk`     |
| `fileName`              | string  | NO       |                                 |
| `mimeType`              | string  | NO       | default SHOULD be `model/stl`   |
| `uncompressedSizeBytes` | integer | YES      | positive                        |
| `sha256`                | string  | NO       | SHA-256 hex over raw mesh bytes |

### 5.8 Supported Mesh MIME Types

| MIME type   | Payload format |
| ----------- | -------------- |
| `model/stl` | binary STL     |

### 5.9 Chunk Decode Validation

For compressed chunks (`compression = 1`):

- decompression MUST succeed,
- decompressed length MUST equal `uncompressedSize`.

Violation MUST reject the file.

---

## 6. Supports Payload Contract

V1 and V2 both use DragonfruitImportFormat semantics.

Expected top-level support arrays:

- `roots`
- `trunks`
- `branches`
- `leaves`
- `braces`
- `knots`

Optional arrays:

- `twigs`
- `sticks`
- `kickstands`

Canonical type contracts are defined in `src/supports/types.ts`.

---

## 7. Extensions

Extension payload location:

- V1: root `extensions`
- V2: `EXTD` chunk

Rules:

- unknown extension keys MUST be ignored,
- extension keys SHOULD be namespaced,
- core format semantics MUST NOT be delegated to extensions.

---

## 8. Compatibility Rules

- Readers MUST accept V1 with `version = 1`.
- Readers MUST accept V2 with `version = 2`.
- Unknown major version for a detected container MUST be rejected.
- Unknown JSON fields in known objects SHOULD be ignored.

---

## 9. Security and Validation Requirements

Readers MUST enforce:

1. valid JSON parse for JSON payloads,
2. required field checks,
3. finite numeric transform checks,
4. chunk bounds checks in V2,
5. compression code validation,
6. decompressed size validation,
7. optional SHA-256 verification where digest exists.

Implementations SHOULD apply practical maximum size limits.

---

## 10. Minimal Examples

### 10.1 V1 Envelope Example

```json
{
  "magic": "VOXL",
  "version": 1,
  "compression": {
    "kind": "document-json-utf8",
    "encoding": "base64-zlib",
    "uncompressedSizeBytes": 512,
    "payloadBase64": "<...>"
  }
}
```

### 10.2 V2 Header + Directory Example (conceptual)

```
Header(16): magic=VOXL version=2 flags=0 chunkCount=6 reserved=0
Dir[0]: type=META index=0 compression=0 offset=136 compressedSize=180 uncompressedSize=180
Dir[1]: type=SCNE index=0 compression=0 offset=316 compressedSize=64  uncompressedSize=64
Dir[2]: type=MODL index=0 compression=1 offset=380 compressedSize=420 uncompressedSize=1250
Dir[3]: type=MESH index=0 compression=1 offset=800 compressedSize=240000 uncompressedSize=690084
Dir[4]: type=SUPP index=0 compression=1 offset=240800 compressedSize=1800 uncompressedSize=7200
Dir[5]: type=EXTD index=0 compression=0 offset=242600 compressedSize=2 uncompressedSize=2
```

---

## 11. Revision History

| Revision | Date       | Summary                                                      |
| -------- | ---------- | ------------------------------------------------------------ |
| 1.0      | 2026-03-07 | V1 JSON container defined                                    |
| 2.0      | 2026-04-09 | V2 binary chunk container defined; V1 compatibility retained |
