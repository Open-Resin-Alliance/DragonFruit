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

## Per-layer print settings

Select a supported GOO, CTB or Anycubic printer/material profile, then right-click
**the layer slider track**, not a handle, and choose **Add range**. Right-clicking
a handle still opens its exact-value editor. The keyboard Context Menu key or
Shift+F10 also opens range commands at the current layer.

1. Choose **Layers** or **mm**. Layers use inclusive printed numbers (first is 1).
   MM uses inclusive printed-layer end heights above the build plate and saves
   those physical bounds, not converted layer numbers. For example, 0.075–0.15 mm
   affects layers 3–6 at 0.025 mm/layer, or layers 2–3 at 0.05 mm/layer.
2. Type into a supported setting box to enable its override automatically, or
   enable its toggle first. Focusing alone changes nothing. A new range starts
   with no overrides; unchecked fields inherit rather than copy defaults.
3. Apply once. Cancel leaves the scene unchanged; undo/redo also applies to ranges.
4. Use **Manage ranges** to reach every saved range, including fully shadowed or
   beyond-print ranges. Right-click a layer to edit/delete any range matching it.

Ranges have distinct colors shared by bands, menu swatches and Manage. The bands
overlay the slider track above the cross-section fill and below its handles.
Moving clip handles does not change settings or hide ranges outside the clip window.
Editable settings follow the selected printer's material-mode definitions,
intersected with its encoder/version support. Only fields opted into per-layer
editing appear. Material-declared motion pairs use one toggle per row; missing
companions are not displayed. Rest/wait fields, other single values, bounds and
PWM align with the far value column.
Travel is **Total / Stage 2** (not first-stage / second-stage distance); speeds
are **Stage 1 / Stage 2**. Typing one value leaves its companion inherited;
turning the shared toggle on explicitly seeds both supported values, and turning
it off clears both overrides.
The narrowest original resolved layer span wins each supplied field before
clipping to this print; equal spans prefer the later-created range, including
mixed units. Editing does not reorder priority. A
narrow exposure-only range can inherit lift/wait values from a wider range.

Travel heights are totals: stage 2 is a part of that total, not extra travel.
Speeds are mm/min and durations seconds; PLS Light PWM is a byte value (0–255),
not a material-menu percentage. Simple/Two-stage/Tilting choose the editable
fields through their existing definitions. Previously stored overrides hidden by
a printer/mode switch appear separately as read-only values that can be removed;
they are never silently dropped. Format-incompatible overrides also block slicing
before save/file picking/preparation. Modes supply the inherited baseline, and
retained explicit overrides apply afterward. LUMEN/NanoDLP ranges are not
implemented here.

Ranges belong to the scene and travel in manual saves, autosave/recovery and
VOXL exports, not material presets. They apply at the same printed numbers on
each plate. Layer-number ranges keep their printed numbers; mm ranges keep
their physical heights and affect different layers when layer height changes.
Changing geometry does not erase either form.
Deleting the last model clears them atomically with that undoable deletion.
They affect the next encoded slice only, not layer height, anti-aliasing,
dithering, raster geometry or an existing file. Legacy time estimates may not
reflect overrides. See [Printing Preview and Send](./printing-preview-and-send.md)
and the [range contract](../dev/slice-job-assembly.md#layer-settings-range-resolution).

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
