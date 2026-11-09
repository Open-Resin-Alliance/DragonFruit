# Mesh Wire Format (DFMX)

One binary payload carries a mesh from Rust to the renderer: `DFMX`, written by
`encode_mesh_bodies` and returned by the `load_mesh_file` command. It is
little-endian, versioned, and holds one or more *bodies*. Each body ends in the
same soup: positions (9 `f32` per triangle), then one normal per corner (9 `f32` per
triangle — each triangle's own geometric normal, see `dragonfruit_mesh_core::normals`).
Write it through `write_soup`, which owns the one implementation of the soup
layout so the encoder cannot drift from the reader.

## Layout

Header (32 bytes):

| Offset | Size | Field |
| --- | --- | --- |
| 0..3 | 4 | magic `DFMX` (`0x44464D58`) |
| 4..7 | 4 | version — `2` |
| 8..11 | 4 | flags — bit 0 `IS_PREVIEW` |
| 12..15 | 4 | body count |
| 16..19 | 4 | original input triangle count |
| 20..23 | 4 | model-section triangle count (`0` when absent) |
| 24..27 | 4 | metadata JSON byte length (`0` when absent) |
| 28..31 | 4 | mesh token — the loader's kept mesh, `0` when it kept none |

Body table: `bodyCount` entries of 8 bytes, in payload order — triangle count
(4 bytes) and the length of that body's packed stream (4 bytes).

Payload: each body in table order, as a zlib stream. Offsets are derived from the
table; there is no per-body offset scalar. A body unpacks to its soup: positions
(9 `f32` per triangle), then one normal per corner (9 `f32` per triangle). The
metadata JSON, when present, is the last `metadataLength` bytes — a reader that does
not know the key reads the bodies and ignores the tail.

**Why the bodies are packed** (version 1 wrote them raw). A soup is 72 bytes a
triangle, and the 13-model scene in `backlog.md` sends **910 MB** of them. The
channel measures 189 MB/s with thirteen transfers in flight but only ~75 MB/s
effective during an import, because the transfer and the single main thread that
receives and prepares each model take turns — so the volume is what a load pays. At
zlib level 1 the same soup deflates **2.7x** on real geometry (65.8 -> 24.2 MB for an
869k-triangle model, 129.1 -> 48.1 MB for a 1.79M one), which took that scene's round
trips from 49.1 s to 35.7 s and its build pass from 17.3 s to 15.4 s — in a *dev*
build, where the encoder itself is unoptimized and costs 512 ms a model against 258
before. Each body is its own stream so a reader turns one body into one geometry
without unpacking another's bytes.

The reader unpacks with the platform's `DecompressionStream`, four bodies at a time —
**not `fflate`'s async pool**, which in this app's `crossOriginIsolated` webview waits
on its workers through `SharedArrayBuffer`/`Atomics` and blocks the main thread the
pool exists to free (that cost 2.8-10 s stalls at scene open and, once, a content
process the watchdog had to declare dead). That is why `decodeDfmx` is asynchronous;
the unpacked soup is a fresh buffer the geometry views directly.

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

The reader is `decodeDfmx` (`src/hooks/useStlGeometry.ts`), which returns the bodies
plus the header facts a preview needs (flags, original and model counts). Each packed
body is a view into the payload buffer — the payload is the body of a `fetch` response
(Tauri's IPC is a custom-protocol fetch) and belongs to that call — and the unpacked
soup becomes the geometry's storage, so nothing is copied twice.

**The token in the header's last slot keeps the soup off the wire a second time.** The
loader has each model's refined mesh in hand when it encodes the payload, so it registers
it and reports the token here; the AO bake asks for that mesh by token instead of being
sent a soup back — forty bytes against 36 bytes a triangle, which is 430 MB across a
scene. The field is unchanged by construction: the loader's weld and the bake's re-weld
of the same soup were measured to produce the same vertex set and a bit-identical field
(rms 0.00000 over 2.18M values on a 725k-triangle model). A bake whose geometry is no
longer that mesh — a repair, a swap, a clone — or whose token has been evicted sends the
soup as before, and the native side refuses a token whose corner count disagrees with the
caller's.

## Bodies come from the loader, not this format

What counts as a body is the loader's decision:

- `io::load_mesh_from_path` returns a single mesh and is what analysis and repair
  use. Import through it, never a format loader, so coarse faces are refined.
- `io::load_mesh_bodies_from_path` returns every body a file declares, each
  refined. `stl`, `obj` and the staged formats give one body; `3mf` gives one per
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

**Refinement is opt-out, and a stored scene mesh opts out.** `refine_coarse_faces`
splits triangles longer than 2% of the bbox diagonal, and it is not idempotent: run it
over a mesh it already produced and it splits more, because the new edges are still
long relative to the same diagonal. A VOXL `MESH` chunk is the scene's refined
geometry, so refining it again changes both the count and the order its
`classification` boundary indexes — on the reported scene, 81,282 triangles came back
as 126,386, the boundary was dropped, the classifier re-ran and grew the mesh again on
the next save. Both loaders take `refine: false` (`x-mesh-refine: 0` on
`load_mesh_bytes`, the `refine` argument on `load_mesh_range`), and the VOXL loaders
pass it whenever the caller holds a classification for that payload.

**The staged passes are serialised on the JS side.** `stage_mesh_binary_set` and the
`*_read_positions` commands share one process-wide buffer, so a stage/read window is
only meaningful while nothing else stages. The VOXL import builds four models
concurrently, and a model whose stored classification does not address its payload runs
`classifyFromGeometry` inside its own build; two of those interleaved and each read back
the other's soup, which rendered as one model's geometry standing in another's place.
`withStagedMesh` (`src/utils/meshRepair.ts`) is the single queue every staged pass goes
through — classify, analyze, both path repairs and the path load. It does not serialise
the AO bake, which sends its soup in the request body precisely to avoid this buffer.

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
