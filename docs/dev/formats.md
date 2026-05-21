# Formats

This page is the developer-facing index for DragonFruit format contracts.

## VOXL

VOXL is DragonFruit’s native scene container.

- V1: JSON-based legacy profile (reader compatibility required).
- V2: binary chunk container (preferred writer target).

Contracts include chunk typing, compression validation, bounds checks, and support payload compatibility.

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
