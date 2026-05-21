# File Formats Reference

DragonFruit works with both scene and geometry formats.

## VOXL (`.voxl`)

Native DragonFruit scene format.

- Stores scene metadata, model transforms, supports, and optional extensions.
- Supports legacy V1 JSON and current V2 binary chunk container.
- V2 is the preferred writer target.

## STL

Primary mesh import/export format for geometry workflows.

- Used for model ingestion and print-ready mesh exchange.
- Export path includes support/raft geometry when configured.

## 3MF (`.3mf`)

Supported export format for model + support workflows.

- Available as an export target alongside STL and VOXL.
- Useful when you want a packaged manufacturing-ready artifact.

## LYS (`.lys`) import path

Lychee scene import is supported through the built-in LYS plugin integration.

- Geometry extracted from binary mesh payloads.
- Scene transform and support reconstruction mapped into DragonFruit structures.

For implementation details, see [Developer Formats](../dev/formats.md).
