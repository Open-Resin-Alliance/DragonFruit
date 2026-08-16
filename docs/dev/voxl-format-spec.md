# VOXL Format Spec

VOXL is DragonFruit’s native scene container. This page captures the core contract engineers should rely on in code and tests.

## Supported generations

| Generation | Container                                                | Status                       |
| ---------- | -------------------------------------------------------- | ---------------------------- |
| V1         | UTF-8 JSON (direct document or compressed JSON envelope) | Legacy read support required |
| V2.0       | Binary chunk container                                   | Historical                   |
| V2.1       | Binary chunk container                                   | Superseded by V2.2           |
| V2.2       | Binary chunk container                                   | Current read/write target    |

Readers must support V1 and V2.x. Writers should emit V2.2 semantics.

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
- `version = 2` (container-major; V2.0, V2.1, and V2.2 all use this — semantic revisions do not bump the header. Identical-geometry dedup bumps it to `3`; the two are orthogonal.)
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
| `HSRC` | hollowing source-mesh positions — V2.2   |
| `CAVT` | hollowing cavity-mesh positions — V2.2   |
| `PSRC` | hole-punch source-mesh positions — V2.2  |

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

### V2.2 semantic revision (current)

V2.2 is a semantic revision of the V2 binary container; like V2.1 it does **not** change the
binary header major version (`version` stays `2`, or `3` when identical-geometry dedup also
fired — the two are orthogonal).

V2.2 moves the large modifier position snapshots **out of the `MODL` JSON and into raw-binary
chunks**, indexed by model index like `MESH`:

| Modifier field (in-memory / V2.1 JSON) | V2.2 chunk | Dedup pointer (MODL JSON)          |
| -------------------------------------- | ---------- | --------------------------------- |
| `hollowing.sourcePositionsBase64`      | `HSRC`     | `hollowing.sourceChunkIndex`      |
| `hollowing.cavityPositionsBase64`      | `CAVT`     | `hollowing.cavityChunkIndex`      |
| `holePunchSourcePositionsBase64`       | `PSRC`     | `holePunchSourceChunkIndex`       |

Rationale: these snapshots are non-indexed `Float32` triangle-soup meshes (often larger than
the model's own geometry). Concatenated as base64 inside one `MODL` JSON string, several such
models exceed V8's ~512 MiB single-string ceiling, so `JSON.stringify(models)` (and, on read,
`JSON.parse`) throws `RangeError: Invalid string length`. Chunking the raw bytes removes the
ceiling on both sides and drops the 4/3 base64 inflation.

Requirements:

- Writers store the **raw `Float32` bytes** in `HSRC`/`CAVT`/`PSRC` (not base64), `zlib`
  compressed, at the owning model's index.
- The `*PositionCount` fields (`sourcePositionCount`, `cavityPositionCount`,
  `holePunchSourcePositionCount`) and `enabled` / `bakedIntoGeometry` flags **remain in the
  `MODL` JSON**; the matching `*Base64` fields are omitted.
- These chunks are **content-deduplicated within each type**, mirroring `MESH` dedup:
  identical snapshots across models share one chunk. The first occurrence owns it (chunk
  `index` = owner model index); later identical ones write no chunk and instead carry a
  `*ChunkIndex` pointer (see table) in the MODL JSON naming the owner. Dedup is keyed by the
  blob's own content, **independent of `MESH` dedup** — a MESH-duplicate model may still own
  its own `HSRC`/`CAVT`/`PSRC` chunk, and two models sharing `MESH` geometry may still hold
  distinct modifier snapshots. Deduping these chunks does not bump the header (unlike MESH
  dedup, which bumps to `3`): they are invisible to older readers.

Detection (no version number is written for the semantic revision): a `MODL` entry whose
`meshModifiers` carries a non-zero `*PositionCount` with the matching `*Base64` **absent**
means the data lives in the corresponding `HSRC`/`CAVT`/`PSRC` chunk, read at
`index = *ChunkIndex ?? modelIndex` (owner defaults to its own model index; a duplicate's
`*ChunkIndex` names the owner).

Backward compatibility (accepted tradeoff): because the header does not bump and unknown chunk
types may be ignored, older V2/V3 readers still open a V2.2 file — baked geometry loads from
`MESH`, and they silently drop only the hollow/hole re-editability snapshots.

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
