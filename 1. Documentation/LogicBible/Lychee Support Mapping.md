# Lychee Slicer (LYS) Support Mapping Logic Bible

## Overview
This document outlines the strategy for mapping Lychee Slicer (LYS) support structures to the Dragonfruit slicer format. The goal is to ensure full compatibility and accurate conversion of support data.

## Goals
1.  **Accurate Conversion**: Convert LYS support entities (tips, trunks, bases, braces) to Dragonfruit equivalents without loss of fidelity.
2.  **Flexible System**: Design Dragonfruit's support system to accommodate the complexity of LYS supports.
3.  **Bi-directional Compatibility**: (Future goal) Potentially allow export back to LYS or similar formats.

## Lychee Data Structure Analysis

### Global Settings
Located under `supports` (root level).
Contains presets for:
- `supportMedium`, `supportLight`, `supportHeavy`
- `mini` supports
- `bracingPreset` (defines patterns like "double", "mix", "simple")

### Objects
Located under `objects.present.byId`.
Example `o5`:
- `center`: {x, y, z} (Object Center in World Space).
- `position`: {x, y, z} (Translation).
- `dimension`: {x, y, z}.
- `supportsBase`: Array of support IDs.

### Support Instances
Located under `supports.present.byId`.
Each support is an object with a unique ID (e.g., `s410`).

#### Key Fields:
- `id`: Unique string ID.
- `type`: Integer (0 or 1).
    - **Type 1**: Standard Support (can be Mini). Often has `parentBaseId: null` (Root) but can be a child.
    - **Type 0**: Auxiliary/Connecting Support. Often has `parentBaseId` set.
- `mini`: Boolean. If true, uses "Mini" support settings (likely thinner, different tip).
- `isBaseTip`: Boolean.
- `base`: {x, y, z}.
- `tip`: {x, y, z}.
- `baseNormal`: {x, y, z}.
- `tipNormal`: {x, y, z}.
- `settings`: Overrides (diameter, taper, etc.).
- `parentId`: Array of strings.
- `parentBaseId`: String ID of parent.
- `objectIdTip`: ID of object tip touches.
- `objectIdBase`: ID of object base touches.

### Coordinate System Analysis
**Conclusion**: Support coordinates are **relative to the Object Center**.
- **Formula**: `WorldPoint = ObjectCenter + LocalPoint`
- This explains why support Z values are often negative (they are below the object center).

### Graph Structure
- Supports form a graph via `parentBaseId` and `parentId`.
- **Roots**: Supports with `parentBaseId: null`.
- **Branches**: Supports with `parentBaseId` pointing to another support.
- **Bracing**: Likely represented as standard supports (Type 0/1) connecting other supports, generated based on `bracingPreset`.

## Mapping Strategy

### Entity Mapping

| Lychee Entity | Dragonfruit Entity | Notes |
| :--- | :--- | :--- |
| `sXXX` (Generic) | `SupportNode` / `SupportBranch` | Lychee seems to treat supports as nodes/segments. |
| `base` | `SupportBase` | |
| `tip` | `SupportTip` | |
| `parentId` | `parent` reference | |

### Conversion Logic
1.  **Parse Objects**: Extract `center` and `position`.
2.  **Parse Supports**:
    - Apply `ObjectCenter` offset to `base` and `tip` coordinates.
    - Resolve `parentBaseId` links to reconstruct the tree.
3.  **Reconstruct Geometry**:
    - **Type 1**: Generate standard trunk/branch. Check `mini` flag for styling.
    - **Type 0**: Generate auxiliary connection.
    - **Settings**: Apply diameter, length, and angle overrides from `settings`.

### TODO
- [ ] Implement LYS importer based on this mapping.
- [ ] Verify visual alignment of imported supports.
