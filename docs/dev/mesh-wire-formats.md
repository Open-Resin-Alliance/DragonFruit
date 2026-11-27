# Mesh Wire Format (DFMX)

One binary payload carries a mesh from Rust to the renderer: `DFMX`, written by
`encode_mesh_bodies` and returned by the `load_mesh_*` commands and by
`refine_mesh_soup` (a model's display mesh: no bodies when there is nothing to
split, otherwise one, with its token set). It is little-endian, versioned, and
holds one or more *bodies*. Each version-3 body stays indexed — unique vertex
positions plus a compact `u16`/`u32` triangle index buffer — written through
`write_indexed_body`, so the encoder never expands the loader's `IndexedMesh`
back into a triangle soup. Model shaders render with `flatShading`, deriving
each triangle's geometric face normal on the GPU without a per-corner normal
buffer.

## Layout

Header (32 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0..3 | 4 | magic `DFMX` (`0x44464D58`) |
| 4..7 | 4 | version — `3` (indexed bodies; `decodeDfmx` also accepts legacy `2`) |
| 8..11 | 4 | flags — bit 0 `IS_PREVIEW` |
| 12..15 | 4 | body count |
| 16..19 | 4 | original input triangle count |
| 20..23 | 4 | model-section triangle count (`0` when absent) |
| 24..27 | 4 | metadata JSON byte length (`0` when absent) |
| 28..31 | 4 | mesh token — the loader's kept mesh, `0` when it kept none |

Body table: `bodyCount` entries of 8 bytes, in payload order — triangle count
(4 bytes) and the length of that body's packed stream (4 bytes).

Payload: each body in table order, as a zlib stream. Offsets are derived from the
table; there is no per-body offset scalar. A version-3 body unpacks to:

- `vertexCount`: `u32` little-endian
- `positions`: `vertexCount × 3` `f32` little-endian (`vertexCount × 12` bytes)
- `indices`: `triangleCount × 3` entries (`u16` LE when `vertexCount ≤ 65535`,
  otherwise `u32` LE)

A legacy version-2 body unpacks to a non-indexed soup: positions (`9 f32` per
triangle), then one normal per corner (`9 f32` per triangle). The metadata JSON,
when present, is the last `metadataLength` bytes — a reader that does not know
the key reads the bodies and ignores the tail.

**Why bodies ship indexed and packed.** Version 1 wrote a raw 72 B/triangle
positions+normals soup (910 MB across a 13-model scene). Version 2 added
zlib level-1 packing (~2.7x). Version 3 keeps the loader's `IndexedMesh` indexed
and omits the per-corner normal block (which `flatShading` computes per fragment
on the GPU), dropping unpacked memory from 72 B/triangle to ~18 B/triangle
(`V ≈ T/2` unique vertices + `u32` indices, or ~12 B/triangle with `u16`
indices) and shrinking both IPC payload size and frontend CPU/GPU memory by
~4–5x. Each body is its own stream so a reader turns one body into one geometry
without unpacking another's bytes.

The reader unpacks with the platform's `DecompressionStream`, four bodies at a time —
**not `fflate`'s async pool**, which in this app's `crossOriginIsolated` webview waits
on its workers through `SharedArrayBuffer`/`Atomics` and blocks the main thread the
pool exists to free (that cost 2.8-10 s stalls at scene open and, once, a content
process the watchdog had to declare dead). That is why `decodeDfmx` is asynchronous;
the unpacked buffer is owned by the call, so `position` and `index` view it
directly without an extra copy.

The metadata is the classification report for the load. `load_mesh_file`
classifies a **single-body** load itself, when the caller asks for it, and ships
the report here, so the frontend has nothing to stage or round-trip for the
common case: the geometry arrives section-ordered, and the frontend passes the
report to `processGeometry` as its `bakedClassification`, which skips the native
classify pass entirely. A caller that will repair passes `classify: false`. A
multi-body 3MF is left to the frontend, whose merged geometry is its own
construction.

Because bodies are laid out as separate streams, a body's vertices are not welded
*across* bodies — matching a 3MF, where each build item is an independent solid.

The reader is `decodeDfmx` (`src/utils/dfmx.ts`), which returns the bodies
plus the header facts a preview needs (flags, original and model counts). Each packed
body is a view into the payload buffer — the payload is the body of a `fetch` response
(Tauri's IPC is a custom-protocol fetch) and belongs to that call — and the unpacked
body becomes the geometry's storage, so nothing is copied twice.

**The token in the header's last slot keeps the soup off the wire a second time.** The
loader has each model's mesh in hand when it encodes the payload, so it registers it and
reports the token here (and `refine_mesh_soup` does the same for a display mesh); the AO bake asks for that mesh by token instead of being
sent a soup back — forty bytes against 36 bytes a triangle, which is 430 MB across a
scene. For an indexed geometry (`perVertex: true`), the bake returns one `f32` per
unique vertex directly in `mesh.positions` order rather than expanding to three
corners per triangle. A bake whose geometry is no longer that mesh — a repair, a
swap, a clone — or whose token has been evicted sends the soup as before, and the
native side refuses a token whose corner or vertex count disagrees with the
caller's.

## Bodies come from the loader, not this format

What counts as a body is the loader's decision:

- `io::load_mesh_from_path` returns a single mesh and is what analysis and repair
  use.
- `io::load_mesh_bodies_from_path` returns every body a file declares. `stl`, `obj` and the staged formats give one body; `3mf` gives one per
  `<build><item>` expanded through its components, with the composed transform
  baked into the vertices (`three_mf::load_bodies`).

  A component may name a **part** rather than an object in the same file:
  BambuStudio and OrcaSlicer put each object in `3D/Objects/object_N.model` and
  write `<component p:path="/3D/Objects/object_N.model" objectid="1" />` in
  `3D/3dmodel.model`. Every `.model` entry in the archive is parsed and keyed by
  its normalized entry name, and a component with a `p:path` resolves its
  `objectid` inside that part. Without it those exporters' files fail outright
  with `object 1 referenced but not defined`, which is every Bambu or Orca export
  rather than an edge case.

`load_mesh_file` calls the body dispatcher, with one format-specific step in
front of it: `stl_special_case_response`. A binary STL announces its triangle
count in its 84-byte header, so a mesh too large to render is decimated into a
single-body preview there (flagging `IS_PREVIEW` and filling the model count),
and an oversized ASCII STL is refused. The TS seam is
`loadMeshFileFromNativePath` (`src/features/slicing/tauri/nativeSlicerBridge.ts`).

`load_mesh_bytes` is the same pipeline for a source with no on-disk path — a VOXL
model's embedded mesh chunk, or a file expanded out of a zip. It takes the file's
bytes in the request body and writes the same payload, so both share one decoder.
`load_mesh_range` is that pipeline for bytes that are already on disk: the caller
passes `(sourcePath, offset, length, compression)` and the file's range is read and
inflated inside Rust, so a VOXL scene never holds its meshes' bytes in the webview.

**Nothing a loader returns is refined.** Every loader returns the mesh as written,
because that mesh is the model: what is saved, exported, sliced and indexed by
triangle id. `refine_coarse_faces` is not idempotent — run over a mesh it already
produced, it splits more — so when the loaders refined, a VOXL `MESH` chunk (the
scene's refined geometry) came back grown: 81,282 triangles as 126,386 on the
reported scene, its `classification` boundary dropped, the classifier re-run, and
the mesh grown again on the next save. The renderer refines a copy it draws instead
(`refine_mesh_soup`, see docs/dev/tauri-ipc-bridge.md). A VOXL written while the
loaders still refined stores that refined mesh, and is read as it stores it.

**The repair passes run on the native mesh store.** `stage_mesh_binary_set` and the
commands that read staging share one process-wide buffer, so a stage/read window is
only meaningful while nothing else stages. The VOXL import builds four models
concurrently, and a model whose stored classification does not address its payload runs
`classifyFromGeometry` inside its own build; two of those interleaved and each read back
the other's soup, which rendered as one model's geometry standing in another's place.
Classify, analyze, both path repairs, the path load, hollowing, hole punching, the organic
cut, the island and overhang scans and the three surfacing modes now put their mesh into the native mesh store and name
it by id, so concurrent passes each read their own (`dev/native-mesh-store.md`). The families
still on the buffer (slicing) keep the hazard until they move.

## What DFMX deliberately drops

Matching the renderer's own loaders, so a cutover does not move geometry:

- **Units.** Neither loader scales by the model `unit=` attribute; geometry is
  in raw file units.
- **Materials and colors.** The renderer strips a mesh's `color` attribute and
  the app tints centrally, so one body is emitted per leaf mesh object — *not*
  one per material `pid` group (three splits a multi-material object into a mesh
  per material, which the app would otherwise import as several bodies).

## Compression and encoding

The payload is not compressed, and there is no LZ4 anywhere in the repo. The
in-tree codecs are deflate (`flate2`, `zip`, and VOXL's `zlib` code — see
`dev/voxl-format-spec.md`) and zstd (via `plugins/lumen`). Compressing an IPC
payload would also cost a decompress pass and a fresh allocation on the JS side.
If payload size becomes the problem, the cheaper levers are quantized positions
(the slice path already has `quantized_u16` with a `meshQuantization` box) and an
index buffer — both addable as a version bump or via the reserved table slot.

## Superseded: DFST

An earlier single-mesh `DFST` payload carried the STL path, with the preview
counts in a 64-byte header. It was retired when the STL load folded into
`load_mesh_file`: `DFMX` carries the same facts (flag, original count, model
count) plus any number of bodies, so one format now serves every input.
ADR-0027 keeps the DFST decision as the record of why the preview path exists.

## Related pages

- `dev/tauri-ipc-bridge.md` — the IPC seam and the staging rules
- `dev/native-mesh-store.md` — meshes held under ids instead of the staging buffer
- `dev/formats.md` — the formats the app reads and writes
- `dev/voxl-format-spec.md` — the on-disk binary container and its `zlib` code
