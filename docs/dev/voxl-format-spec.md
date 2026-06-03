# VOXL Format Spec

VOXL is DragonFruit’s native scene container. This page captures the core contract engineers should rely on in code and tests.

## Supported generations

| Generation | Container                                                | Status                       |
| ---------- | -------------------------------------------------------- | ---------------------------- |
| V1         | UTF-8 JSON (direct document or compressed JSON envelope) | Legacy read support required |
| V2.0       | Binary chunk container                                   | Historical                   |
| V2.1       | Binary chunk container                                   | Current read/write target    |

Readers must support V1 and V2.x. Writers should emit V2.1 semantics.

## Core conventions

- Extension: `.voxl`
- Media type: `application/vnd.dragonfruit.voxl`
- Units: millimetres (`mm`)
- Coordinate basis: right-handed, Z-up
- Rotation storage: Euler radians (XYZ)

Format detection by first bytes:

- `{` (`0x7B`) → V1 JSON
- `VOXL` (`0x56 0x4F 0x58 0x4C`) → V2 binary

All transform/vector numbers must be finite IEEE 754 values.

## V1 contract (JSON)

Top-level profiles:

1. direct scene JSON document
2. compressed envelope containing scene JSON

Required root fields (direct profile):

- `magic = "VOXL"`
- `version = 1`
- `meta`
- `scene`
- `models`
- `supports`

Optional root fields:

- `extensions`

V1 mesh object supports:

- `none`
- `external-file`
- `embedded-file`

Supported V1 mesh encodings:

- `base64-raw`
- `base64-rle-u8`

For `base64-rle-u8`, decoded size must equal `uncompressedSizeBytes`.

## V2 contract (binary chunks)

V2 layout:

- 16-byte file header
- chunk directory (`chunkCount` entries, 20 bytes each)
- chunk payload region

Header requirements:

- `magic = VOXL`
- `version = 2` (container-major; V2.0 and V2.1 both use this)
- little-endian integer fields

Compression codes:

| Code | Meaning |
| ---- | ------- |
| `0`  | none    |
| `1`  | zlib    |

Unknown compression codes must fail parsing.

Chunk types:

| Type   | Expected use        |
| ------ | ------------------- |
| `META` | scene metadata JSON |
| `SCNE` | scene state JSON    |
| `MODL` | models JSON         |
| `MESH` | raw mesh bytes      |
| `SUPP` | supports JSON       |
| `EXTD` | extensions JSON     |

Unknown chunk types may be ignored.

For embedded model meshes, `MODL[i]` maps to `MESH(index = i)`.

### V2.1 semantic revision (current)

V2.1 is a semantic revision of the V2 binary container; it does **not** change the binary header major version.

V2.1 additionally requires:

- `MODL[*].meshModifiers` persistence for model modifier state.
- Hollowing source snapshot persistence in the hollowing modifier payload:
	- `sourcePositionsBase64`
	- `sourcePositionCount`
- `bakedIntoGeometry` semantics for modifiers that are already baked into mesh geometry.

Behavioral requirement:

- Hollowing re-apply must use persisted source snapshot geometry.
- Implementations must **not** fall back to re-hollowing the already-baked mesh when the snapshot is missing.

This is required so hollowing and hole-punch workflows remain re-editable after VOXL round-trips.

## Supports and extensions

Supports payloads are DragonFruitImportFormat-compatible. Common arrays include:

- `roots`, `trunks`, `branches`, `leaves`, `braces`, `knots`

Optional arrays:

- `twigs`, `sticks`, `kickstands`

Extensions location:

- V1: root `extensions`
- V2: `EXTD` chunk

Unknown extension keys should be ignored.

## Validation expectations

Readers should enforce:

1. valid JSON payload parse
2. required field presence
3. finite numeric transform values
4. V2 chunk bounds correctness
5. compression/decompression validity
6. decoded-size checks
7. optional SHA-256 verification when digest fields are present

## Related files

- `src/supports/types.ts`
- `docs/dev/formats.md`
- `1_Documentation/VOXL_FORMAT_SPEC.md` (full historical revision text)
