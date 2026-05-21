# Scan Positioning

Scan-derived overlays and voxels must follow a strict coordinate policy.

## Core rule

Island scan inputs already use transformed world-space geometry (rotation, scale, and lift applied during scan preparation).

Therefore, render-time code must avoid double-applying transform components.

## Helper policy

Use centralized scan-positioning helpers for:

- Layer index → world Z conversion
- Outer visualization group positioning behavior

## Practical guidance

- Reapply only the intended post-scan visual attachment behavior.
- Do not reapply baked rotation/lift when scan outputs already encode them.
- Keep all scan-based features aligned to the same helper policy.

## Common regression patterns

- Double-lift in Z after rescan
- Rotation being applied twice in overlay rendering
- Feature-specific ad hoc positioning diverging from shared helper behavior
