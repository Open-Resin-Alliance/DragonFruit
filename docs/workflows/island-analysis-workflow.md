# Island Analysis Workflow

Use Analysis mode to detect unsupported/disconnected islands and inspect scan-derived overlays.

## 1) Enter Analysis mode

1. Switch to **Analysis** mode.
2. Open the scan card and workflow card.

## 2) Run scan

Choose scan implementation:

- **Native**: Rust scan path (fastest)
- **JS**: TypeScript scanline path

Use workflow defaults as a starting point:

- Min Area: `0`
- Min Overlap: `4`
- Overlap Radius: `1`

## 3) Enable and inspect visuals

- Enable ID labels/voxel visuals.
- Use Island list to search, sort, and select islands.
- Toggle showing child/merged islands.
- Open Hierarchy view for parent/child relationships.

## 4) Refine scan parameters

Adjust as needed:

- Pixel (mm)
- Buffer (mm)
- Connectivity (4/8)
- Min Area (mm²)
- Min Overlap (px)
- Overlap Radius (px)

## Practical checks

- Focus on persistent critical islands first.
- Verify selected island spans and volume/area metrics.
- Re-scan after large orientation or support changes.

## Related workflows

- [Model Preparation](./model-preparation.md)
- [Support Placement](./support-placement.md)
- [Raft and Export](./raft-and-export.md)

![Island analysis workflow placeholder](../assets/placeholders/workflow-island-analysis.png)

> Screenshot placeholder: Analysis mode with scan controls, island list, and selected-island overlays.
