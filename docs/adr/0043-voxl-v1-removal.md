---
issue: voxl-v1-removal
kind: decision
date: 2026-10-07
---

# ADR-0043: VOXL V1 read support removed

## Context

VOXL V1 was the original JSON scene container: a scene document (or a
compressed envelope around one) with mesh geometry carried as base64, optionally
RLE-compressed. It was superseded by the binary chunk container (PR #115,
2026-04-10) and has been read-only ever since — the writer has emitted the binary
container for as long as anyone can check.

The evidence that V1 is safe to drop is that **no release ever wrote one**. The
first release tag, `v0.1.3` (2026-04-15), already contains the binary container:
`git merge-base --is-ancestor 5f720d9ef v0.1.3` holds. V1 files can therefore
only come from pre-release/nightly builds built before 2026-04-10, and the
`.voxl` files committed to the repository number zero.

ADR-0034 recorded V1 read support as "a permanent requirement — early adopter
projects must remain loadable". That call was made before the release timeline
was checkable against tags; this ADR supersedes it.

## Decision

**V1 is not read by any reader.** The app's TypeScript reader and the Rust CLI
both drop the V1 JSON path; the Rust thumbnailer already refused V1
(`version >= 2`).

A V1 file is not a parse failure. Both readers recognise the generation cheaply —
`{` (a JSON object: the document or its envelope) or the `VOXL` magic with a
container version below `2` — and refuse it with an error that names it:
`VoxlObsoleteVersionError` in the app, an "Unsupported VOXL binary version"
message in the CLI. The app surfaces that as a dedicated modal
(`ObsoleteVoxlVersionModal`) that says the scene was saved by an unsupported
version and that opening it in an older DragonFruit build and re-saving will
produce a file this version reads.

The V1 byte layout moves to an appendix of `docs/dev/voxl-format-spec.md`,
marked obsolete, kept for hand-recovery and so a refused file can be identified.
It is no longer a contract.

What went with it:

- The V1 codec in `src/features/scene/voxl/codec.ts` — JSON parse/serialize, the
  compressed-envelope reader, the base64/RLE helpers, and the V1 document
  builder. `parseVoxlAuto` is now binary-only.
- The V1-only types: `VoxlCompressedDocumentEnvelopeV1`, `VoxlCompressionRef`,
  `VoxlDocumentCompressionEncoding`, `SerializeVoxlOptions`, `VoxlMeshEncoding`,
  and `VoxlMeshRef.dataBase64` / `.dataEncoding`.
- The CLI's V1 JSON loader (`load_voxl_v1_from_bytes`) and its `base64`
  dependency; `dragonfruit-cli` bumped to `2.0.0` (a removed input format is a
  semver major).
- Dead V1-era writers that no caller reached: `ExportManager.buildEmbeddedMeshPayload`
  and its RLE/SHA helpers.

## Consequences

- A pre-release V1 scene cannot be opened by a current build. The modal states
  the recovery path: open it in an older DragonFruit, save it, and the re-saved
  scene is a binary container this version reads. There is no in-app migration
  and none is planned — the affected population is pre-release testers only.
- The reader is smaller and single-path: one container, two floors, no
  format-detection branch that can half-succeed.
- `scripts/dragonfruit-ts-cli.ts` used to write V1 JSON through the removed
  helpers, which would have produced files the app refuses; it now writes the
  binary container like the app does.
- If a V1 file ever needs reading again, the appendix plus the ADR-0034 record
  are enough to reimplement it — but it should be a deliberate decision, not a
  re-import of the deleted code.

## References

- `docs/dev/voxl-format-spec.md` — supported generations, and the V1 appendix
- ADR-0034 — the binary container format and the (now superseded) V1 read
  requirement
- ADR-0042 — VOXL version semantics (compat floor vs authoring revision)
- `src/features/scene/voxl/codec.ts` — `VoxlObsoleteVersionError`,
  `detectObsoleteVoxlVersion`
