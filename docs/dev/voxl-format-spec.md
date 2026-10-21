# VOXL Format Spec

VOXL is DragonFruit’s native scene container. This page captures the core contract engineers should rely on in code and tests.

## Geometry chunk cache lifecycle

`src/features/scene/voxl/meshChunkStore.ts` caches compressed geometry by content
digest, with references from each model and slot. Concurrent bakes of identical
bytes must adopt the same canonical blob: a compression finishing later must
not overwrite reference counts installed while it awaited.

Each owner has one current pending bake. Requests with the same signature share
that work; a newer signature supersedes it. Returning to an already cached
signature also invalidates a different pending bake. `release`, `retainOnly`
and `clear` invalidate pending work as well as retained chunks, including owners
that have not completed their first bake. A slot-specific release leaves the
model's other slot intact.

Invalidation does not reject an existing caller's promise: it still receives
the bytes it requested, but those bytes cannot repopulate the cache or change
reset statistics. Completion of invalidated work must not remove the pending
entry of a newer bake. `pending` and `isBakeInFlight` describe current, live
work, not invalidated operations still finishing for their callers. These are
in-memory lifecycle rules; the VOXL file format is unchanged.

## Supported generations

Two independent numbers describe a VOXL file.

**Container version** — the `version` field in the binary header — is the
*compat floor*: the minimum reader generation that can interpret the file. A
generation-N reader understands everything at or below N. Generation 1 (V1) is
obsolete and is not read; see the appendix.

| Generation | Container                                       | `version` | Status                                  |
| ---------- | ----------------------------------------------- | --------- | --------------------------------------- |
| V2         | Binary chunk container                          | `2`       | Written when no MESH chunks are shared  |
| V3         | Binary chunk container with MESH chunk sharing  | `3`       | Written when dedup removed a chunk      |

**Authoring revision** — a `major.minor` label, not stored in the file — is the
feature level of the writer. The major only bumps when a change makes an older
reader *wrong* on the same input; additive revisions ride along in either
container generation.

| Revision | Adds                                                                                     | Container version |
| -------- | ---------------------------------------------------------------------------------------- | ----------------- |
| 2.0      | Binary chunk container (first V2 write)                                                  | `2`               |
| 2.1      | `meshModifiers` persistence, inline modifier snapshots, `bakedIntoGeometry`               | `2`               |
| 3.0      | Identical-geometry MESH chunk dedup — the reader-breaking change that raised the floor    | `3`               |
| 3.1      | Modifier snapshots moved to `HSRC`/`CAVT`/`PSRC` chunks                                   | `2` or `3`        |
| 3.2      | Support `typeId`                                                                          | `2` or `3`        |
| 3.3      | `MODL.classification`                                                                     | `2` or `3`        |
| 3.4      | `SCNE.plates` (plate ids and names) and `META.printer` — current writer target            | `2` or `3`        |

Dedup (3.0) is the only reader-breaking change since V1, so a current writer
emits `version 2` for a scene with no shared MESH chunks and `version 3` when
dedup fired. Readers must support both binary floors. Writers should emit 3.4
semantics.

V1 was only ever written by pre-release builds — the first release already wrote
the binary container — so a V1 file is refused outright and explained rather than
parsed. Its shape is kept in the appendix for reference.

## Core conventions

- Extension: `.voxl`
- Media type: `application/vnd.dragonfruit.voxl`
- Units: millimeters (`mm`)
- Coordinate basis: right-handed, Z-up
- Rotation storage: Euler radians (XYZ)

Format detection by first bytes:

- `VOXL` (`0x56 0x4F 0x58 0x4C`) → binary container (floor 2 or 3)
- `{` (`0x7B`) → V1 JSON — obsolete, refused with an "unsupported version" prompt

All transform/vector numbers must be finite IEEE 754 values.

## Mesh triangle order

Everything that indexes a mesh in this format is an index into **one order**, and the order
survives every hop of the pipeline. State it once; do not re-derive it per consumer.

- Rust hands geometry to TypeScript as a corner soup in `IndexedMesh.triangles` order
  (`dragonfruit-mesh-core`, `mesh.rs`): `DFMX` bodies, the writer's `write_soup` and the
  `MESH` chunk's STL bytes all carry that order unchanged. A `MESH` payload is the scene
  geometry translated by `-geometry.center`; nothing else about it is reordered.
- A classification boundary (`model_triangle_count`), the baked-occlusion attribute
  (`aBakedAo`, one value per soup corner), the model/support section split and support
  routing all address that order. A classifier reports the order the pass produced, and
  the mesh it hands back *is* that order — model triangles first.
- A pass that replaces the position attribute (classify, repair, refine, swap) is a new
  mesh: per-corner data and any loader token recorded against the old array are void. An
  in-place translate (the centering) is not — it moves the same triangles.
- A report and the bytes it describes must be written together, and a reader must check
  they still agree. The rule is one function, not a convention:
  `reportAddressesTriangleSoup(report, triangles)` in
  `src/features/scene/voxl/classification.ts` compares `post.triangle_count`, because the
  boundary describes the mesh the pass *ended* with. The writer
  (`ExportManager.exportVoxl`), the loader (`classificationForPayload`) and both CLI
  readers call it. See Revision 3.3 for the stored form.
- Placing a model: the local frame is the soup minus its own bounding-box centre, then the
  entry's `transform` — extrinsic XYZ Euler radians about the fixed plate axes
  (`quaternionFromGlobalEuler`), scale, translation. Both CLIs apply it themselves
  (`scripts/dragonfruit-ts-cli.ts::applyVoxlTransform`,
  `rust/dragonfruit-cli/src/io.rs::apply_model_transform`) and read the same boundary.

## Binary container contract (V2/V3)

Binary layout:

- 16-byte file header
- chunk directory (`chunkCount` entries, 20 bytes each)
- chunk payload region

Header requirements:

- `magic = VOXL`
- `version` = the compat floor: `2`, or `3` when identical-geometry MESH dedup shares a chunk (authoring revisions 3.1–3.3 do not raise it)
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
| `HSRC` | hollowing source-mesh positions — V3.1   |
| `CAVT` | hollowing cavity-mesh positions — V3.1   |
| `PSRC` | hole-punch source-mesh positions — V3.1  |

Unknown chunk types may be ignored.

The `SCNE` payload is `VoxlSceneState`: which model is active, which models are
selected, the scene's `plates` (3.4), and `plateName` — the user's name for the
build plate, shown on the plate itself. Both plate fields are optional: a file
written before plates existed has neither, and readers must treat a missing one
as a single unnamed plate.

For embedded model meshes, `MODL[i]` maps to `MESH(index = i)` unless the entry
carries a `chunkIndex` (V3.0 dedup), which names the owning MESH chunk.

### Revision 2.1

Revision 2.1 is additive over the binary container; it does **not** change the
binary header (`version` stays `2`).

Revision 2.1 additionally requires:

- `MODL[*].meshModifiers` persistence for model modifier state.
- Hollowing source snapshot persistence in the hollowing modifier payload:
	- `sourcePositionsBase64`
	- `sourcePositionCount`
- `bakedIntoGeometry` semantics for modifiers that are already baked into mesh geometry.

Behavioral requirement:

- Hollowing re-apply must use persisted source snapshot geometry.
- Implementations must **not** fall back to re-hollowing the already-baked mesh when the snapshot is missing.

This is required so hollowing and hole-punch workflows remain re-editable after VOXL round-trips.

### Revision 3.0 — MESH chunk sharing

Revision 3.0 is the reader-breaking change that raised the container floor from
`2` to `3`. When identical-geometry dedup removes at least one MESH chunk, the
duplicate models point at the owner's chunk via `MODL[*].mesh.chunkIndex`.
Readers of the V2 generation map MESH chunks 1:1 to model index and would
silently drop those models, so writers stamp `version = 3` on any file where
dedup fired and a V2 reader then fails the version check cleanly instead. A
scene with no shared MESH chunks keeps writing `version = 2` and stays readable
by V2 readers.

### Revision 3.1

Revision 3.1 is additive over the container and does **not** raise the floor
(`version` stays `2`, or `3` when dedup also fired — the two are orthogonal).

Revision 3.1 moves the large modifier position snapshots **out of the `MODL` JSON and into raw-binary
chunks**, indexed by model index like `MESH`:

| Modifier field (in-memory / 2.1 JSON) | 3.1 chunk | Dedup pointer (MODL JSON)          |
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
  distinct modifier snapshots. Deduping these chunks does not raise the floor
  (unlike MESH dedup, revision 3.0, which raises it to `3`): they are invisible
  to older readers.

Detection (no version number is written for the authoring revision): a `MODL` entry whose
`meshModifiers` carries a non-zero `*PositionCount` with the matching `*Base64` **absent**
means the data lives in the corresponding `HSRC`/`CAVT`/`PSRC` chunk, read at
`index = *ChunkIndex ?? modelIndex` (owner defaults to its own model index; a duplicate's
`*ChunkIndex` names the owner).

Backward compatibility (accepted tradeoff): because the floor is not raised and unknown chunk
types may be ignored, older readers still open a 3.1 file — baked geometry loads from `MESH`,
and they silently drop only the hollow/hole re-editability snapshots.

### Revision 3.2

Revision 3.2 is additive over the container and does **not** raise the floor
(`version` stays `2`, or `3` when dedup also fired).

Revision 3.2 adds an optional `typeId` to every entity in the supports payload, recording the support
type explicitly rather than leaving it implicit in the array the entity sits in.

Requirements:

- Writers stamp `typeId` on every entity they write.
- Readers must accept a payload without it, deriving each entity's type from the array it
  appears in. `typeId` is never required to interpret a file.

Detection (no version number is written for the authoring revision): an entity carrying `typeId`
is 3.2; a payload without it is read exactly as before. The revision is additive, so the
authoring revision a reader reports for a binary file stays `3.1`, or `2.1` when the file carries
inline modifier snapshots; `typeId` is not part of that detection.

Backward compatibility: the field is optional and unknown JSON keys are ignored, so a 3.2 file
opens in an older reader with no loss beyond the explicit type stamp.

### Revision 3.3

Revision 3.3 is additive over the container and does **not** raise the floor
(`version` stays `2`, or `3` when dedup also fired).

Revision 3.3 adds an optional `classification` to a `MODL` entry: the native model/support classification
that ran over the triangle order of that model's `mesh` payload. The value is the classifier's
report — the `MeshHealthReport` shape (`src/utils/meshRepair.ts`), whose `model_triangle_count`
is the split boundary: the first N triangles are the model body, the remainder support geometry.

**A reader re-derives it rather than trusting it.** The boundary is only as good as the pairing of
those bytes with that report, and a count check cannot see the failure that matters: a soup of the
same length in a different order. A file written before the mesh chunk's signature included the
position array's identity can hold exactly that — the classifier's boundary beside the mesh it
classified *before* reordering it — and applying it cuts a slab out of the model and paints it as
support. So the VOXL import builds each payload, asks the native loader to classify it, and takes
the sections from that answer (`handleImportVoxlFile`'s `buildOptionsFor`). The cost is one classify
per model per load, the same pass a fresh STL import pays, done inside the loader rather than as a
second round trip. The writer still records the field: it is the file's own description of its
mesh, it is correct by construction once the bytes and the report come from the same bake, and a
future reader can honour it again when a file can prove the two agree.

Requirements:

- The boundary is an index into the soup, so it is only meaningful for the mesh the classifying
  pass *ended* with: **`post.triangle_count`**. `pre` is the mesh that was sent in, and a repair
  changes the topology between the two. Classify-only leaves `pre == post`, which is why the
  distinction went unnoticed for a while.
- One predicate decides whether a report still addresses a soup of *N* triangles —
  `reportAddressesTriangleSoup(report, N)` in `src/features/scene/voxl/classification.ts`. The
  writer, the loader and both CLIs call it; nothing re-implements the comparison.
- Writers stamp `classification` only when that predicate holds for the exact payload being
  written. A geometry replaced after classification (a baked hollowing, hole punch, mirror, or
  repair) carries none — the boundary would not address it — and neither does a payload whose
  bake fell behind the live geometry. The chunk store's geometry signature includes the identity
  of the position array (`ExportManager.computeModelGeometrySignature`), because a classify pass
  installs a reordered soup of the same length and every count-based field is blind to that.
- The boundary is expressed in the triangle order of the **stored mesh bytes**, not of the
  original import. Native decimation preserves section order, so a reduced preview's boundary is
  the one the reader must use.
- A reader that does honour it (it does not today, see above) must check the report against the
  payload it just loaded with the same predicate, and must not re-run the classifier on a report
  that passes: the report is the answer for exactly these triangles. The sections themselves are
  never stored separately — the split is built from `model_triangle_count` either way.
  (`src/hooks/useStlGeometry.ts`: `classificationForPayload`, `loadMeshGeometryFromRange`.)
- A stored mesh is not refined again on load (`_refine: false`, `refine` on the native loaders).
  Refinement is not idempotent, so re-refining a stored payload changes the count and order that
  any boundary indexes and grows the mesh on every save/load cycle.
- A reader that has the *file's path* may leave the `MESH` chunks packed: the directory
  already carries `(offset, compressedSize, uncompressedSize, compression)`, and
  `load_mesh_range` reads and inflates a range natively, so a scene never holds its
  meshes' bytes in the webview (`parseVoxlBinaryV2(bytes, { deferMeshChunks: true })`
  returns those descriptors as `meshRanges`). A reader holding only bytes inflates them
  itself, which is the default and stays supported — a file out of a zip has no range
  to give. Reading a range and unpacking it must reproduce the eager bytes exactly,
  which the dedup test pins.
- Readers must accept a `MODL` entry without it and classify as before. `classification` is never
  required to interpret a file, and an auto-repair pass on load supersedes it.

Detection (no version number is written for the authoring revision): a `MODL` entry carrying
`classification` is 3.3. As with 3.2 it does not participate in the reported authoring
revision, which stays `3.1` or `2.1`.

Backward compatibility: the field is optional and unknown JSON keys are ignored, so a 3.3 file
opens in an older reader with no loss beyond the classifier having to run again.

### Revision 3.4 (current)

Revision 3.4 is additive over the container and does **not** raise the floor
(`version` stays `2`, or `3` when dedup also fired).

Revision 3.4 records the scene's build plates and the printer it was written for.

`SCNE.plates` is the scene's plates in display order, each `{ id, name? }`:

- `id` is a stable identity, so a plate keeps it across save and load.
- `name` is what the user called it. Absent means the plate is unnamed.

`SCNE.activePlateId` is the plate that was being worked on. It is a cursor rather than a fact about the geometry, so a reader that ignores it can fall back to the first plate.

`MODL[i].plateId` is the plate that model stands on, written **only when it is not the scene's first plate**. A model with no membership field is on the first plate, which is what a scene written before plates meant by it, so a single-plate scene's bytes are unchanged.

Plate membership does not move the geometry. A model's `transform.position` stays a world coordinate, which is what keeps this revision additive: a reader that ignores plates sees every plate laid out in the cascade with each model where it belongs, rather than several beds stacked at one origin.

`plateName` remains for a scene with exactly one plate, where it is that plate's name, so a
reader that only knows the older field still shows it. `plates` is canonical, and with several
plates the shorthand is omitted because it cannot say which plate it names.

`META.printer` embeds the printer the scene was written for, whole, in the profile library's own
bundle shape:

| Field       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `version`   | The bundle format version.                                            |
| `printer`   | The printer profile definition, as `importPrinterBundle` accepts it.  |
| `materials` | The material profiles that belong to that printer.                    |

Shipping the definition rather than a reference is what makes a custom printer work: the scene does
not depend on that profile being installed wherever it is opened, because an import can add it from
the file. Three kinds of field are deliberately left out:

- The network and connection fields (`network`, `networkFleet`, `networkConnection`,
  `activeNetworkDeviceId`) are session state rather than facts about the printer, and they carry a
  LAN address and device ids.
- An uploaded printer photo, which is a data URL and would be duplicated into every save. A factory
  printer's image is a bundled asset path and does travel.
- The bundle's export timestamp. It changes on every save, and the autosave write-skip fingerprints
  the document from chunk content, so a timestamp in the file would stop the skip from ever firing.

An import that finds the selected printer smaller than the embedded one on any axis offers to
switch. Switching selects the installed profile the bundle resolves to, matching the official
preset id first, then the local id it was written with, then the name, and otherwise adds the
printer from the bundle.

Detection (no version number is written for the authoring revision): a `SCNE` carrying `plates`,
or a `META` carrying `printer`, is 3.4. As with 3.2 and 3.3 it does not participate in the
reported authoring revision, which stays `3.1` or `2.1`.

Backward compatibility: both fields are optional and unknown JSON keys are ignored, so a 3.4 file
opens in an older reader. It sees every model as belonging to one plate, which is what the scene
would have been before plates existed, and it ignores the printer. Nothing is dropped; the plate
split is simply not shown.

## Supports and extensions

Supports payloads are DragonFruitImportFormat-compatible. Common arrays include:

- `roots`, `trunks`, `branches`, `leaves`, `braces`, `knots`

Optional arrays:

- `twigs`, `sticks`, `stumps`, `kickstands`

Every entity may carry an optional `typeId` naming its support type (3.2). A payload without
it is read exactly as before, with each entity's type derived from the array it appears in.

Extensions location:

- Binary: `EXTD` chunk

Unknown extension keys should be ignored.

## Implementation notes

- The current writer (`src/features/scene/voxl/codec-v2.ts`) emits 3.4 semantics: raw mesh bytes into `MESH` chunks with per-chunk zlib and no base64, which makes files roughly 60-65% smaller than the old JSON container for typical scenes and faster to write and read. It stamps the container floor `2`, or `3` when dedup shared a MESH chunk.
- The binary reader hands callers pre-decoded mesh bytes through `ParsedVoxlResult.meshBytes`.
- A V1 file is refused by `VoxlObsoleteVersionError` (`src/features/scene/voxl/codec.ts`) rather than parsed; the app turns that into the "unsupported version" modal. Detection is `detectObsoleteVoxlVersion`.

## Validation expectations

Readers should enforce:

1. valid payload parse
2. required field presence
3. finite numeric transform values
4. binary chunk bounds correctness
5. compression/decompression validity
6. decoded-size checks
7. optional SHA-256 verification when digest fields are present

## Related files

- `src/features/scene/voxl/codec.ts`
- `src/features/scene/voxl/codec-v2.ts`
- `src/supports/types.ts`
- `src/features/scene/voxl/types.ts`
- `src/hooks/useStlGeometry.ts`
- `docs/dev/formats.md`

## Appendix: V1 (obsolete)

V1 is no longer read by any DragonFruit reader. The shape is kept for
hand-recovery and so a refused file can be identified; nothing here is a
supported contract.

A V1 file is UTF-8 JSON with one of two top-level profiles:

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

V1 mesh object modes: `none`, `external-file`, `embedded-file`.

V1 mesh encodings:

- `base64-raw`
- `base64-rle-u8`

For `base64-rle-u8`, decoded size must equal `uncompressedSizeBytes`.

Compressed envelope profile fields:

- `compression.kind = "document-json-utf8"`
- `compression.encoding`: `base64-raw`, `base64-rle-u8` or `base64-zlib`
- `compression.uncompressedSizeBytes`
- `compression.payloadBase64`

V1 extensions lived at the root `extensions` key.
