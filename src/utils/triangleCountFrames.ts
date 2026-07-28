/**
 * The two frames of `model_triangle_count`, expressed as types instead of prose.
 *
 * ## Why this module exists
 *
 * There are two different numbers called `model_triangle_count` in this
 * codebase, they are both `number`, and conflating them produced a four-phase
 * defect chain (Ph3 → Ph3c → Ph3e) that ended with support anti-aliasing
 * silently disabled for an entire slice. Documentation and one rename were the
 * 2026-07-27 answer; both are conventions, and a convention is exactly what the
 * next agent re-derives their way past. A type is not.
 *
 * Authority for everything below:
 * `agents/Claude/STL-import-perf/20260727-Audit-model-triangle-count-frames.md`.
 *
 * ## The two frames
 *
 * - **(A) FILE frame** — {@link FileFrameCount}. Measured by Rust's
 *   `classify_import` on the **full-resolution source file** and carried in the
 *   DFST header as `ImportClassificationJson.model_triangle_count`. It travels
 *   as `geometry.importRunMap` (`ImportRunMap.modelTriangleCount`) and
 *   `geometry.nativePreview.runMap` (`ImportRunMapSummary.modelTriangleCount`),
 *   and is consumed only by the run-map splice, in **source-file** triangle
 *   indices. For a decimated preview it addresses triangles the scene buffer
 *   does not contain, so it must never be used to cut one.
 * - **(B) GEOMETRY frame** — {@link GeometryFrameCount}. `MeshHealthReport.model_triangle_count`,
 *   stored as `geometry.meshDefects.nativeRepairReport`. It is **always measured
 *   on the buffer it is attached to and therefore always indexes it** — previews
 *   included. A decimated preview runs its own `mesh_classify_staged` pass over
 *   its own triangles and is reordered model-first by that pass; Rust derives
 *   the count from that same mesh's connected components, so it is bounded by
 *   `mesh.triangles.len()` by construction.
 *
 * ## The mechanism, and its one asymmetry
 *
 * A branded number **is** assignable to `number`, so every arithmetic operation,
 * every `.toLocaleString()`, every existing consumer that takes a plain `number`
 * keeps compiling untouched. A plain `number` is **not** assignable to a brand.
 * That asymmetry is the whole mechanism: you cannot hand an unbranded value — or
 * a value branded with the *other* frame — to a parameter that asks for a
 * specific frame, and the two brands are mutually incompatible in both
 * directions.
 *
 * ## ⚠ ARITHMETIC LAUNDERS THE BRAND
 *
 * `Math.min(a, b)`, `Math.floor(a)`, `a + b`, `a * 9` — every one of them
 * returns plain `number`, brand gone. That is deliberate (it is what keeps the
 * brand from infecting every expression in the tree) but it means **a derived
 * value carries no guarantee**. Re-branding a derived value is an assertion
 * about where it came from, exactly like the decode boundaries below, and it
 * deserves the same comment. Where the assertion is trivially true — a clamp of
 * a (B) count against the same buffer's own size — say so; where it is not,
 * do not re-brand at all.
 *
 * ## What this does NOT protect against
 *
 * - **Right type, wrong source.** A (B) count from model X handed to a (B)
 *   parameter that is about model Y compiles perfectly. The brand carries the
 *   frame, not the provenance.
 * - **The Rust side.** `model_triangle_count` crosses the IPC boundary as a
 *   plain `u32`/`usize` in `SliceJobV3`, `mesh_repair.rs` and `engine.rs`. No
 *   TypeScript type reaches there.
 * - **A third frame.** The split index handed to the slicer
 *   (`SliceJobV3.model_triangle_count`) is neither (A) nor (B): it indexes the
 *   CONCATENATED STAGED buffer, and it is a sum of per-model (B) counts plus
 *   full-res splice counts. It is deliberately left as a plain `number` —
 *   branding it (B) would assert an identity that does not hold.
 *
 * ## Where the brand is introduced (R8-lite, 2026-07-27)
 *
 * Four decode/bridge boundaries, and they are meant to stay the only ones:
 *
 *  1. `parseImportClassification` (`@/utils/meshRepair`) — the DFST classification
 *     decode, whose sole production caller is `decodeNativeStlResponse` in
 *     `useStlGeometry.ts` → **(A)**.
 *  2. `normalizeMeshHealthReport` (`@/utils/meshRepair`) — the shared decode for
 *     `mesh_classify_staged` / `mesh_repair_staged` / `mesh_repair_from_path`
 *     → **(B)**.
 *  3. The VOXL restore — the persisted `MODL` run-map summary, which re-enters
 *     the type system through `readJsonChunk<VoxlModelEntry[]>` in
 *     `voxl/codec-v2.ts` → **(A)**. VOXL persists (A) and only (A); a reload's
 *     health report is produced by a fresh classify pass and is branded at (2).
 *  4. `importClassificationToHealthReport` (`@/utils/meshRepair`) — the ONE
 *     legal A→B conversion in the tree, valid only because both of its callers
 *     guarantee A ≡ B. See that function's docblock.
 *
 * Anything else that needs a brand is a *derivation* (see the laundering note),
 * not a boundary, and there are only a handful: they are the places a count is
 * measured directly off the buffer it describes.
 */

declare const FILE_FRAME: unique symbol;
declare const GEOMETRY_FRAME: unique symbol;

/**
 * FRAME (A) — a triangle index in **SOURCE-FILE** numbering. Valid against the
 * original file's triangle order; invalid against a decimated scene buffer.
 */
export type FileFrameCount = number & { readonly [FILE_FRAME]: true };

/**
 * FRAME (B) — a triangle index into **the buffer the value is attached to**.
 * Valid against that buffer and nothing else, previews included.
 */
export type GeometryFrameCount = number & { readonly [GEOMETRY_FRAME]: true };

/**
 * Assert that `count` is a FILE-frame (A) triangle index.
 *
 * Legal at exactly two kinds of site: a decode boundary that is reading the
 * source file's own numbers (the DFST classification, a persisted run map), and
 * a derivation whose inputs were all (A) and whose output still addresses the
 * file. Anywhere else, you are asserting something you have not checked.
 */
export function asFileFrameCount(count: number): FileFrameCount {
  return count as FileFrameCount;
}

/**
 * Assert that `count` is a GEOMETRY-frame (B) triangle index — i.e. that it
 * indexes the very buffer it is about to be used against.
 *
 * Legal at a decode boundary for a report measured on that buffer, and at a
 * derivation where the arithmetic cannot leave the buffer (a clamp against the
 * buffer's own triangle count, a count read off the buffer's own attributes).
 * Not legal as a way to make a plain `number` fit.
 */
export function asGeometryFrameCount(count: number): GeometryFrameCount {
  return count as GeometryFrameCount;
}
