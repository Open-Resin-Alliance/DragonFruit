---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
kind: pattern
---

# ADR-0027: DFST binary IPC protocol and dynamic decimation budget

## Context

Large STL imports (>4M triangles) required a high-performance path from
Rust to the webview. The previous approach loaded the full STL into webview
memory before processing, consuming ~1 GB for a large binary STL. Decimation
was a single global pass with a fixed error bound, which either over-simplified
thin support structures or under-decimated the dense model body.

Additionally, mixed-geometry STL files (model body + pre-placed support
structures in a single file) had no way to preserve section boundaries during
decimation — support triangles at the tail of the buffer were treated
identically to model geometry, leading to disproportionate simplification of
supports.

## Decision

**1. DragonFruit Streaming Transfer (DFST) binary IPC protocol.**

A 64-byte header followed by raw little-endian f32 payload, transferred as
a single Tauri `Response` blob:

| Bytes | Field | Type |
|-------|-------|------|
| 0–3 | Magic `DFST` | `[u8; 4]` (0x44465354) |
| 4–7 | Flags | `u32 LE` — Bit 0: `IS_PREVIEW` |
| 8–11 | Original input triangle count | `u32 LE` |
| 12–15 | Output preview triangle count | `u32 LE` |
| 16–31 | Reserved / bounding box extents | 16 bytes |
| 32–35 | Model section boundary offset | `u32 LE` |
| 36–63 | Reserved padding | 28 bytes |

Payload at byte 64:
- Positions: `previewTriangleCount × 9` f32s (3 vertices × 3 coords)
- Normals: `previewTriangleCount × 9` f32s (face normals, parallel-computed)

The TS consumer reads the header with `DataView`, then constructs
`Float32Array` views directly over the IPC `ArrayBuffer` — no copy. Both
`position` and `normal` `BufferAttribute`s retain the IPC buffer, eliminating
two full-size allocation spikes.

**2. Dynamic triangle budget governor.**

Budget is computed from input size and bounding-box diagonal
(`stl_budget::compute_triangle_budget`):

- Target: 4M triangles
- Soft ceiling: 8M triangles (allows error-bounded outputs to exceed budget
  rather than destroying thin supports)
- Bounding-box scaled epsilon: `diagonal_mm × 0.00025`, clamped to
  `[0.003, 0.050]` — small models get tight error bounds, large models
  get proportionally wider bounds

When input exceeds the target budget, decimation proceeds through a lockstep
error tier sequence: `[target_error, 0.003, 0.005, 0.008, 0.010, 0.025]`.
Each tier is attempted; decimation stops at the first tier that brings the
total below the soft ceiling.

**3. Per-section decimation with seam locking.**

`decimate_sections_to_budget` splits the triangle buffer at the model/support
boundary (byte 32–35 of the DFST header carries this offset). Each section is
decimated independently at the same error tier (lockstep), using
`meshopt::simplify_with_locks` with `LockBorder | Regularize`. This preserves:

- Support-geometry detail (thin trunks, cone tips) that a global pass would
  collapse first
- The section boundary offset so downstream consumers can split model vs
  support geometry from the decimated mesh

The two sections are concatenated back in order (model triangles first,
support triangles second) so the boundary offset remains a simple count.

**4. Support classification via `classify_support_split`.**

Before decimation, `classify_support_split` runs on the full-resolution mesh.
It identifies the model/support boundary by analysing triangle-soup structure
(manifold shells, thin-structure heuristics, vertical-cylinder detection) and
returns `model_triangle_count`. This count propagates:

- Into the DFST header (bytes 32–35)
- Into the native repair report (`model_triangle_count` field)
- Through `splitClassifiedSupports.ts` for tinting support geometry in the
  scene
- Into VOXL autosave (preserving section identity across save/reload)

If classification is skipped (`skip_classification: true`), a previously known
`model_triangle_count` can be passed directly to `load_stl_file` for
re-decimation without repeating the classification pass.

## Consequences

- A 12M-triangle STL import transfers ~600 MB via DFST but avoids holding
  both raw and processed copies simultaneously. The webview never sees the
  raw STL bytes.
- The lockstep tier approach means both sections reach the same geometric
  error level — visual quality is uniform across the preview mesh.
- `LockBorder` on both sections prevents seam artifacts at the section
  boundary where model and support geometry share vertices.
- The 4M trigger threshold (`TRIGGER_TRIANGLES`) is deliberately lower than
  the 4M budget — files near the threshold may round-trip through decimation
  with minimal reduction but gain the classification and section-split
  metadata.
- ASCII STL files above 300 MB are rejected before loading — the parser must
  hold the entire file in memory, and very large ASCII STLs typically indicate
  an export misconfiguration.

## References

- TS: `src/hooks/useStlGeometry.ts` (DFST header parser, `loadStlViaTauri`)
- Rust: `src-tauri/src/mesh_repair.rs` (`load_stl_file`, `encode_stl_response`)
- Rust: `rust/dragonfruit-mesh-repair/src/stl_budget.rs` (budget governor)
- Rust: `rust/dragonfruit-mesh-repair/src/repair.rs` (`decimate_sections_to_budget`, `classify_support_split`)
- Rust: `rust/dragonfruit-mesh-repair/src/decimation_config.rs` (constants)
- TS: `src/features/scene/splitClassifiedSupports.ts` (section split consumer)
