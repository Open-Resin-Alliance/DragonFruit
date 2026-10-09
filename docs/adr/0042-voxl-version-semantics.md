---
issue: voxl-version-semantics
kind: decision
date: 2026-10-07
---

# ADR-0042: VOXL version semantics — compat floor and authoring revision

## Context

VOXL had drifted into two numbers that nobody could reconcile. The binary
container's header `version` field is written as `3` when identical-geometry
MESH dedup shares a chunk (ADR-0034 §4), yet the documentation kept calling the
current format "V2.4". Reading the docs gave two answers to "what version is
VOXL": 2.4, or 3.

The history shows how it happened. Dedup landed 2026-07-04 and raised the
container to 3 because it is reader-*breaking*: a reader of the V2 generation
maps MESH chunks 1:1 to model index and would silently drop the duplicate
models. Then three additive revisions — modifier-snapshot chunks, support
`typeId`, and `MODL.classification` — landed *after* that bump but were still
labelled `2.2`, `2.3`, `2.4`, anchored to a major the format had already left.
The generation table in `docs/dev/voxl-format-spec.md` never listed V3 at all,
and `docs/dev/formats.md` asserted the header "major remains `2`", which the
dedup writer had already made false.

The versioning convention the code intends was already correct
(`codec-v2.ts` — "the versioning convention reserves bumps for changes that
would make old readers WRONG"); it was the *labels* that had drifted off it.

## Decision

**Two numbers, each with one job.**

**Container version** — the `version` field in the binary header — is the
**compat floor**: the minimum reader generation that can interpret the file. A
generation-N reader understands everything at or below N.

- `2` — a V2-generation reader suffices (no shared MESH chunks).
- `3` — a V3-generation reader is required; identical-geometry dedup removed at
  least one chunk, so duplicate models point at the owner's chunk through
  `MODL[*].mesh.chunkIndex`. All-unique scenes keep writing `2` and stay
  readable by V2 readers.

**Authoring revision** — a `major.minor` label, *not* stored in the file — is
the feature level of the writer. The major bumps **only** when a change makes
an older reader wrong on the same input; additive revisions ride along in
either container generation. Re-based onto the current generation:

| Revision | Adds                                                              | Floor |
| -------- | ----------------------------------------------------------------- | ----- |
| 2.0      | Binary chunk container                                            | `2`   |
| 2.1      | `meshModifiers` persistence, inline snapshots, `bakedIntoGeometry` | `2`   |
| 3.0      | Identical-geometry MESH chunk dedup (reader-breaking)             | `3`   |
| 3.1      | Modifier snapshots moved to `HSRC`/`CAVT`/`PSRC` chunks           | `2`/`3` |
| 3.2      | Support `typeId`                                                  | `2`/`3` |
| 3.3      | `MODL.classification` — current writer target                     | `2`/`3` |

The detected layout revision (`ParsedVoxlResult.sourceVersion`) follows the same
ladder: `3.1` when a file carries modifier-snapshot chunks, `2.1` when it uses
the older inline layout (a current write of a scene with no snapshots is
byte-identical to the 2.1 layout).

`VOXL_V2_SEMANTIC_REVISION` (2.2) becomes `VOXL_V3_SEMANTIC_REVISION` (3.1);
`VOXL_V2_INLINE_REVISION` stays `2.1`, since the inline layout genuinely
predates the generation-3 floor.

## Consequences

- "What version is VOXL" now has one answer: the writer emits **3.3**
  semantics, in a container floored at `2` or `3`.
- The per-file floor is preserved deliberately: a scene with no shared MESH
  chunks still opens in a DragonFruit build from before the dedup release.
  Collapsing to a single always-`3` header was rejected — it would cost that
  compatibility for no reader-safety gain.
- The floor and the authoring revision are independent; a `2`-floored file can
  carry 3.3 semantics, and a `3`-floored file can carry 2.1 semantics. Docs and
  comments must say which axis a number belongs to.
- External readers are unaffected: the Rust thumbnailer declares VOXL
  `version >= 2` and the CLI accepts `>= 2` and already honours `chunkIndex`.
- Future additive features bump the minor (`3.4`, …). Only a change that makes
  a V3 reader wrong raises the floor to `4` — and then the authoring major moves
  to `4.0` with it.

## References

- `docs/dev/voxl-format-spec.md` — the generation and revision tables, and the
  per-revision contracts
- ADR-0034 — the binary container format itself
- `src/features/scene/voxl/codec-v2.ts` — `VOXL_V2`/`VOXL_V3` and the revision
  constants
