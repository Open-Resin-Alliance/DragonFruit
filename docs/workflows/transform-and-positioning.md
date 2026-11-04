# Transform and Positioning Workflow

Use **Transform** in Prepare mode to position models before supports.

## 1) Enter Transform mode

1. Switch to **Prepare**.
2. In the tool rail under the app bar (or down the left edge, if the rail is parked there), choose **Transform**.
3. Select the target model.

## 2) Move

Use X/Y/Z fields to set precise position.

Quick actions:

- **Center**: center model on plate.
- **Platform**: place model on platform.
- **Arrange**: one-click center + platform action.

### Lift and Drop

- **Lift** seats the selection's lowest point at the **Distance (mm)**.
- **Drop** seats it on the plate.
- The **Auto** toggle is the same pair: on lifts the selection to the distance,
  off drops it to the plate.

The height belongs to each model, not to the tool. A model lifted for supports
keeps its gap through moves, rotations and scaling; a model dropped on the plate
stays on the plate; a model loaded from a project keeps the height it was saved
at. Changing the distance does not move a model already placed — press **Lift**
to reseat it. The mode is saved with the model, so a project reopens with the
same models tracking the distance and the same ones holding their own height.

The Auto Support panel carries the same toggle beside its preset selector,
labelled with the state it is in (`Auto-Lift ON` / `Auto-Lift OFF`) and filled
with the theme accent while it is on, because the gap it holds under the model is
what a generated support has to span. Both controls read the selection and call
the same handler, so they cannot disagree.

## 3) Rotate

- Edit X/Y/Z angles directly.
- Hold a ring's handle and drag to rotate. A protractor dial appears, fixed at
  the angle you grabbed, and the readout shows the sweep from that grab — so a
  model already at 47.3° that you drag to the +10° mark ends at 57.3°.
- The dial magnetises the moving radius onto its marks: 45° radii in the inner
  band, 10° long marks and 5° short marks along the ring. The pull only applies
  while the pointer is in the band where those marks are drawn — between the
  bands, and outside the ring, rotation is free.
- Use **Reset Rotation** when needed.

## 4) Scale

- Adjust X/Y/Z scale values.
- Toggle **Uniform** scaling.
- Switch units between **%** and **mm**.
- Use **Reset Scale** to restore scale defaults.
- Scaling keeps the mesh's current bottom height fixed by moving its centre up
  or down. A model on the plate stays on the plate; a raised model keeps its gap.
  This applies to uniform and per-axis scaling, percentage and millimetre fields,
  gizmo dragging, and **Reset Scale**, including tilted models. Scaling holds
  the model's own bottom; it does not reseat it to the lift distance.

## Several models at once

With more than one model selected, the panel and the gizmo act on the whole
selection, each change as a single undo step:

- **Rotate** turns every model by the same amount. The **Group** toggle in the
  Rotate header picks how: on, the selection turns as one block about its
  centre; off, each model turns in place.
- **Scale** applies the same factor to every model and spreads them out (or
  pulls them in) horizontally about the selection's centre. Each model keeps
  its own bottom height, even when the selection contains models at different
  elevations.
- **Reset Rotation** resets every selected model's rotation; **Reset Scale**
  restores each model's scale while keeping its bottom height fixed.
- With auto-snap on, rotated models are set back on the plate (or at the lift
  distance) afterwards. Scaling preserves the existing bottom height instead.
- **Auto-Repair** (or **Repair Again**) from the model menu or the model list
  repairs the selected models one after another, all in one undo step; the
  progress names the model it is on. **Stop** keeps the models already
  repaired and leaves the rest as they were. **Undo Repairs** and **Show
  Report** still act on the active model.

## Practical checks

- Ensure model is clear of plate unless intentionally dropped.
- Keep orientation suitable for drainage and support access.
- Re-check bounds before moving to support placement.

### Panel scaling regression checks

- Select exactly one model. Increase and decrease its scale using both the
  percentage and millimetre fields; its bottom must stay at the same world Z
  during typing and after leaving the field. Repeat with a tilted, raised model.
- Use **Reset Scale** on that single model. The bottom must still stay fixed.
- Undo and redo each completed edit. Position and scale must restore together
  in one step, including the centre's compensating Z movement.
- Repeat with several selected models at different heights. Each model must
  retain its own bottom height.


## Related workflows

- [Model Preparation](./model-preparation.md)
- [Place On-Face and Mirror](./place-on-face-and-mirror.md)
- [Support Placement](./support-placement.md)

![Transform workflow placeholder](../assets/placeholders/workflow-transform-positioning.png)

> Screenshot placeholder: Transform mode with move/rotate/scale cards and auto-lift controls.
