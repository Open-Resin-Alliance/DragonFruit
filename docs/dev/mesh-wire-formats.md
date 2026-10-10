# Mesh Wire Formats (DFST, DFMX)

Two binary payloads carry a mesh across the Tauri IPC boundary from Rust to the
renderer. Both are little-endian and both end in the same *soup*: positions
(9 `f32` per triangle), then per-corner normals (9 `f32` per triangle,
welded and split at creases — see `dragonfruit_mesh_core::normals`). They differ
in the header and in how many meshes the payload can hold.

| | `DFST` | `DFMX` |
| --- | --- | --- |
| magic | `DFST` (`0x44465354`) | `DFMX` (`0x44464D58`) |
| header | 64 bytes | 32 bytes + body table |
| bodies | exactly one | one or more |
| versioned | no | yes (version 1) |
| written by | `encode_stl_response` | `encode_mesh_bodies` |
| command | `load_stl_file` | `load_mesh_file` |
| decoded by | `loadStlViaTauri` | not wired yet |

Write both through `write_soup`, which owns the one implementation of the soup
layout (positions then normals) so the two encoders cannot drift.

## DFST — single-mesh (STL)

Written by `encode_stl_response` in `src-tauri/src/mesh_repair.rs` and returned
by the `load_stl_file` command; decoded in `loadStlViaTauri`
(`src/hooks/useStlGeometry.ts`).

| Offset | Size | Field |
| --- | --- | --- |
| 0..3 | 4 | magic `DFST` |
| 4..7 | 4 | flags — bit 0 `IS_PREVIEW` |
| 8..11 | 4 | original input triangle count |
| 12..15 | 4 | output (preview) triangle count |
| 16..31 | 16 | reserved ("bounding-box extents" in the comment; never written) |
| 32..35 | 4 | model-section triangle count — written only when a preview carries one |
| 36..63 | 28 | reserved, zero |

Payload from byte 64: one body, positions then normals, `outputTriangleCount`
triangles. The reader derives the block boundary from the triangle count — there
is no length scalar. It is **not versioned**, and the reader rejects any length
other than `64 + triangles * 72`.

## DFMX — multi-body (universal loader)

Written by `encode_mesh_bodies` and returned by `load_mesh_file` because a 3MF
describes several bodies. It is **versioned**, so an encoding change (quantized
positions, compression) can be added as v2 without breaking v1 readers.

Header (32 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0..3 | 4 | magic `DFMX` |
| 4..7 | 4 | version — `1` |
| 8..11 | 4 | flags — bit 0 `IS_PREVIEW` |
| 12..15 | 4 | body count |
| 16..19 | 4 | original input triangle count |
| 20..23 | 4 | model-section triangle count (`0` when absent) |
| 24..31 | 8 | reserved, zero |

Body table: `bodyCount` entries of 8 bytes, in payload order —
triangle count (4 bytes) and 4 reserved bytes (an encoding / vertex-count slot
kept for v2).

Payload: each body in table order, positions then normals, 9 `f32` per triangle
each. Offsets are derived from the table; there is no per-body offset scalar.

Because bodies are laid out as separate soups, a body's vertices are not welded
*across* bodies — matching a 3MF, where each build item is an independent solid.

## Bodies come from the loader, not this format

What counts as a body is the loader's decision:

- `io::load_mesh_from_path` returns a single mesh and is what analysis and repair
  use. Import through it, never a format loader, so coarse faces are refined.
- `io::load_mesh_bodies_from_path` returns every body a file declares, each
  refined. `stl`, `obj` and the staged formats give one body; `3mf` gives one per
  `<build><item>` expanded through its components, with the composed transform
  baked into the vertices (`three_mf::load_bodies`).

`load_mesh_file` calls the body dispatcher and encodes the result. Nothing on the
frontend consumes `DFMX` yet — `loadMeshFileFromNativePath`
(`src/features/slicing/tauri/nativeSlicerBridge.ts`) returns the raw payload.

## What DFMX deliberately drops

Matching the renderer's own 3MF loaders, so a cutover does not move geometry:

- **Units.** Neither loader scales by the model `unit=` attribute; geometry is
  in raw file units.
- **Materials and colors.** The renderer strips a mesh's `color` attribute and
  the app tints centrally, so one body is emitted per leaf mesh object — *not*
  one per material `pid` group (three splits a multi-material object into a mesh
  per material, which the app would otherwise import as several bodies).

## Compression and encoding

Neither format is compressed, and there is no LZ4 anywhere in the repo. The
in-tree codecs are deflate (`flate2`, `zip`, and VOXL's `zlib` code — see
`dev/voxl-format-spec.md`) and zstd (via `plugins/lumen`). Compressing an IPC
payload would also cost a decompress pass and a fresh allocation on the JS side,
which is what the current zero-copy `Float32Array` views over the response
buffer avoid. If payload size becomes the problem, the cheaper levers are
quantized positions (the slice path already has `quantized_u16` with a
`meshQuantization` box) and an index buffer — both addable as a DFMX version bump
or via the reserved table slot.

## Related pages

- `dev/tauri-ipc-bridge.md` — the IPC seam and the staging rules
- `dev/formats.md` — the formats the app reads and writes
- `dev/voxl-format-spec.md` — the on-disk binary container and its `zlib` code
