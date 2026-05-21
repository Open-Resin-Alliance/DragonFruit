# Raft and Export Workflow

Rafts improve adhesion and support stability, especially in resin workflows.

## Raft workflow

1. Enable raft in support settings.
2. Choose **bottom mode** (`solid`, `line`, or `off`).
3. Tune **thickness** and **chamfer angle** for removal behavior.
4. Tune wall options (**enabled**, height, thickness).
5. Tune crenelation settings (gap width/spacing) for suction relief behavior.
6. If using line bottom mode, tune **line width** and **line height**.
7. Review raft footprint around all active rooted supports.

## What DragonFruit computes

- Raft footprint from support roots.
- Chamfered base geometry (solid mode).
- Optional perimeter wall with configurable crenelation behavior.
- Line-network raft geometry in line mode.

## Export workflow

1. Review supports and raft visually.
2. Export scene/model assets.
3. Re-open output in downstream workflow for final validation.

## Export quality checks

- Model/support alignment preserved.
- Raft included when expected.
- No missing support segments in dense trees.

## Related workflows

- [Support Placement](./support-placement.md)
- [Printing Preview and Send](./printing-preview-and-send.md)
- [Island Analysis Workflow](./island-analysis-workflow.md)

![Raft placeholder](../assets/placeholders/raft-settings-and-preview.png)

> Screenshot placeholder: raft settings panel and resulting raft mesh in the viewport.
