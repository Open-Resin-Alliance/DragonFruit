---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
kind: pattern
---

# ADR-0034: VOXL binary container format

## Context

DragonFruit needed a native project format that could persist the complete
scene state — models, supports, mesh geometry, mesh modifiers, and extensions
— in a single file. External formats (STL, OBJ) carry only geometry; Lychee
`.lys` is a competitor's proprietary container. A purpose-built format was
required to support round-trip editing, autosave, and future extensibility
without depending on any external schema.

## Decision

**1. Magic-byte format detection, not extension.** The first bytes determine
the generation: `{` (0x7B) → V1 JSON, `VOXL` (0x56 0x4F 0x58 0x4C) → V2
binary. Readers must support both; writers emit V2.1.

**2. V1 → V2: JSON to binary chunks.** V1 stored the entire scene as a single
JSON document (or compressed JSON envelope). This became untenable as mesh
data grew — base64-encoding multi-MB meshes inside JSON inflated file size and
parse time. V2 (PR #115) introduced a binary chunk container: a 16-byte file
header, a chunk directory (20 bytes per entry), and a payload region. Each
chunk has a 4-byte type tag (`META`, `SCNE`, `MODL`, `MESH`, `SUPP`, `EXTD`)
and optional zlib compression (code 0 = none, 1 = zlib). Raw mesh bytes live
in `MESH` chunks alongside their owning `MODL` entries, eliminating base64
overhead.

**3. V2.1 semantic revision, not container version bump.** V2.1 extends V2
semantics without changing the binary header major version (still `version=2`).
This avoids breaking older readers that can parse V2 structurally even if they
ignore V2.1 fields. V2.1 adds:
- `meshModifiers` persistence on every model — modifier state survives save/load
- Hollowing source snapshot persistence (`sourcePositionsBase64`,
  `sourcePositionCount`) so hollowing remains re-editable after VOXL
  round-trips
- `bakedIntoGeometry` flag for modifiers already applied to the mesh — readers
  must not re-apply them

**4. Mesh dedup on save and load.** Filled-bed scenes (many copies of the same
model) produced enormous files. PR #311 introduced content-addressable mesh
chunk deduplication on save (26x smaller for filled beds); PR #309 added dedup
on load (4x faster, cloning cached geometry instead of parsing duplicates).

**5. COW mesh chunk store and streaming writer.** PR phase 3 introduced a
copy-on-write mesh chunk store that bakes mesh data once and streams the write,
with a 4 GiB size guard. This avoids holding the full serialised file in
memory.

**6. Autosave beside project.** Autosave writes a separate `.voxl` file beside
the project file (not overwriting the manual save). Path recovery logic locates
the autosave on relaunch. Atomic commit with serialised native writers prevents
half-written files on crash.

**7. Decimated vs original mesh handling.** PR #493 resolved the distinction:
VOXL saves can carry both the decimated (display) mesh and the original
(full-resolution) mesh. The original is used for slicing; the decimated for
viewport rendering. `originalRef` sidecar resolution ensures the full-res mesh
is available for CLI slicing pipelines.

**8. Support classification roundtrip.** PR #494 added support mesh
classification that persists through VOXL save/load — models flagged as
support geometry retain that designation across sessions, feeding into the
decimation and repair pipelines.

## Consequences

- V1 read support is a permanent requirement — early adopter projects must
  remain loadable.
- Unknown chunk types are silently ignored, enabling forward-compatible
  extensions without version bumps.
- Unknown compression codes must fail parsing (not ignore), as data integrity
  cannot be guaranteed.
- The dedup strategy is content-based (hash mesh bytes), so identical geometry
  from different import sources unifies automatically.
- Hollowing re-apply is blocked when the source snapshot is missing — the
  implementation must not silently re-hollow an already-baked mesh.

## References

- Full byte-level spec: `docs/dev/voxl-format-spec.md` (in-repo)
- Key PRs: #115 (V2), #309 (dedup on load), #311 (dedup on save), #493
  (autosave + decimated/original handling), #494 (support classification
  roundtrip)
- Related: ADR-0011 (streaming RLE — similar streaming-write philosophy),
  ADR-0029 (voxel hollowing — modifier persistence consumer)
