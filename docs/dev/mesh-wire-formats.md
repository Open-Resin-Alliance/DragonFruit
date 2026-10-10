# Mesh Wire Format (DFMX)

One binary payload carries a mesh from Rust to the renderer: `DFMX`, written by
`encode_mesh_bodies` and returned by the `load_mesh_file` command. It is
little-endian, versioned, and holds one or more *bodies*. Each body ends in the
same soup: positions (9 `f32` per triangle), then per-corner normals (9 `f32` per
triangle, welded and split at creases — see `dragonfruit_mesh_core::normals`).
Write it through `write_soup`, which owns the one implementation of the soup
layout so the encoder cannot drift from the reader.

## Layout

Header (32 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0..3 | 4 | magic `DFMX` (`0x44464D58`) |
| 4..7 | 4 | version — `1` |
| 8..11 | 4 | flags — bit 0 `IS_PREVIEW` |
| 12..15 | 4 | body count |
| 16..19 | 4 | original input triangle count |
| 20..23 | 4 | model-section triangle count (`0` when absent) |
| 24..27 | 4 | metadata JSON byte length (`0` when absent) |
| 28..31 | 4 | reserved, zero |

Body table: `bodyCount` entries of 8 bytes, in payload order — triangle count
(4 bytes) and 4 reserved bytes (an encoding / vertex-count slot kept for v2).

Payload: each body in table order, positions then normals. Offsets are derived
from the table; there is no per-body offset scalar. The metadata JSON, when
present, is the last `metadataLength` bytes — a reader that does not know the key
reads the bodies and ignores the tail.

The metadata is the classification report for the load. `load_mesh_file`
classifies a **single-body** load itself, when the caller asks for it, and ships
the report here, so the frontend has nothing to stage or round-trip for the
common case: the geometry arrives section-ordered, and the frontend passes the
report to `processGeometry` as its `bakedClassification`, which skips the native
classify pass entirely. A caller that will repair passes `classify: false`. A
multi-body 3MF is left to the frontend, whose merged geometry is its own
construction.

Because bodies are laid out as separate soups, a body's vertices are not welded
*across* bodies — matching a 3MF, where each build item is an independent solid.

The reader is `decodeDfmx` (`src/hooks/useStlGeometry.ts`), which returns the
bodies plus the header facts a preview needs (flags, original and model counts).
It gives each body its own `ArrayBuffer`: `processGeometry` translates a geometry
in place to centre it, so bodies sharing one buffer would drag each other around.

## Bodies come from the loader, not this format

What counts as a body is the loader's decision:

- `io::load_mesh_from_path` returns a single mesh and is what analysis and repair
  use. Import through it, never a format loader, so coarse faces are refined.
- `io::load_mesh_bodies_from_path` returns every body a file declares, each
  refined. `stl`, `obj` and the staged formats give one body; `3mf` gives one per
  `<build><item>` expanded through its components, with the composed transform
  baked into the vertices (`three_mf::load_bodies`).

`load_mesh_file` calls the body dispatcher, with one format-specific step in
front of it: `stl_special_case_response`. A binary STL announces its triangle
count in its 84-byte header, so a mesh too large to render is decimated into a
single-body preview there (flagging `IS_PREVIEW` and filling the model count),
and an oversized ASCII STL is refused. The TS seam is
`loadMeshFileFromNativePath` (`src/features/slicing/tauri/nativeSlicerBridge.ts`).

`load_mesh_bytes` is the same pipeline for a source with no on-disk path — a VOXL
model's embedded mesh chunk, or a file expanded out of a zip. It takes the file's
bytes in the request body and writes the same payload, so both share one decoder.

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
- `dev/formats.md` — the formats the app reads and writes
- `dev/voxl-format-spec.md` — the on-disk binary container and its `zlib` code
