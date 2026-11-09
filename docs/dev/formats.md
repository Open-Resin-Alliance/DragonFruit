# Formats

This page is the developer-facing index for DragonFruit format contracts.

## VOXL

VOXL is DragonFruit’s native scene container.

- V1: JSON-based legacy profile — **not read**; only pre-release builds ever wrote it, so a V1 file is refused with an "unsupported version" prompt. See the spec appendix.
- V2/V3: binary chunk container — the header `version` is the compat floor (`2`, or `3` when identical-geometry dedup shares a MESH chunk), not the writer generation. The current writer emits authoring revision 3.4.

Contracts include chunk typing, compression validation, bounds checks, support payload compatibility, model modifier persistence (`meshModifiers`) for re-editable workflows like hollowing, baked mesh classification (`classification`) so a reload does not re-run the model/support classifier, the scene's build plates (`plates`, with stable ids and names), and the printer the scene was written for (`printer`, embedded whole with its materials so a custom profile travels and an import can offer to switch instead of dropping a packed plate into a smaller machine).

See: `dev/voxl-format-spec.md`

## LYS extraction context

LYS scene import relies on binary geometry extraction plus transform/support mapping.

Important extraction points:

- Geometry binary payload includes header + index buffer + vertex buffer.
- Correct payload offsets and topology reconstruction are required for valid mesh output.
- Import pipeline must preserve transform parity and support reconstruction consistency.

See: `dev/lys-mesh-extraction-spec.md`

## STL

STL remains core for mesh input/output and offline export composition.

When exporting with supports/raft enabled, generated geometry should remain aligned with viewport semantics.
