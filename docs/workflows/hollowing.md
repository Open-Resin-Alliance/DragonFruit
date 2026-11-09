# Hollowing and Hole Punch Workflow

Hollowing removes interior volume from a model, reducing material and print time. Drain holes and solid areas let you control where cavities open to the outside.

## Recommended sequence

1. Import your model and enter **Prepare** mode.
2. Switch to **Hollow** in the tool rail under the app bar (or down the left edge, if the rail is parked there).
3. Configure hollowing settings (wall thickness, voxel size, mode).
4. Review the cavity preview before applying.
5. Place hole punches for drainage or venting.
6. Apply hollowing to bake the cavity into the mesh.

---

## Hollowing modes

| Mode | Description |
|------|-------------|
| **Cavity** | Standard hollow — removes interior volume, leaves a shell. Best for most prints. |
| **Infill** | Adds internal lattice or pillar infill. Useful when the shell alone is too thin for structural load. |
| **Shell Open Face** | Removes one face of the bounding box so the cavity is open to the outside. No drain holes needed. |

---

## Voxel Size

Voxel size controls the resolution of the hollowing voxel grid.

- Enter the desired voxel size in **mm** (e.g. `0.65`).
- The actual voxel resolution (count) is calculated automatically from the model's bounding box.
- Smaller voxel sizes produce smoother cavities but require more computation.
- Preview caps the resolution at 72 voxels; apply uses the full computed resolution (up to 192).

Recommended starting point: **0.65 mm**.

---

## Shell Thickness

The minimum wall thickness of the hollow shell in mm.

- Thicker shells are stronger but use more material.
- Very thin shells (< 0.5 mm) may cause print failures.
- Shell thickness is quantized for preview to match the voxel grid.

---

## Solid Areas

Solid areas mark voxels that should stay solid during hollowing. Use them to:

- Preserve screw bosses, mounting points, or other critical features.
- Keep solid columns inside the cavity for structural support.
- Prevent hollowing from carving into thin walls.

### To mark solid areas:

1. Click **Solid Areas** in the hollowing panel to enter edit mode.
2. Click individual voxel spheres to toggle them solid (blue).
3. Drag a lasso to mark many voxels at once; **Alt**+lasso releases them.
4. Use **Undo** (Ctrl+Z) / **Redo** (Ctrl+Shift+Z) to step through your edits, while editing or after **Done**; undoing a step after **Done** reopens the edit mode.
5. Press **Done** to commit them and update the preview.
6. Clear them all with the **Clear** button.

Solid voxels appear as **blue spheres**; hollow cavity voxels appear as **yellow spheres**.

> **Note:** Changing shell thickness or voxel size while solid areas are marked will show a warning — they are cleared when the voxel grid changes.

---

## Hole Punching

Hole punches create cylindrical openings through the shell for drainage, venting, or fastener access.

### To place a hole punch:

1. While in **Hollow** mode, click the model surface where you want the hole.
2. A preview cylinder appears showing the hole position and orientation.
3. Adjust radius and depth in the hole punch panel.
4. Click and drag the hole punch handles to reposition.

Click an existing hole punch to select it rather than place another hole. This also
works from inside the cavity, including when the slice viewer clips away the front
of the model. In interior view, click a cavity surface away from existing punches
to place a new hole.

Dragging a punch body snaps it to the nearest model surface within the visible
slice-view bounds and aligns it to that surface's normal. This works in exterior
and interior view. Use the gizmo arrows for axis-constrained movement instead.

### Oval holes

- By default, hole punches are circular (linked X/Y radius).
- Click the **link icon** to unlink X and Y, then set different values for oval holes.
- Unlinking initialises Y to the current X value.
- An oval hole of 4×3 mm creates a wider opening in one axis.

### Auto depth

When depth mode is set to **Auto**, the hole depth is computed from the distance to the internal cavity surface. This ensures the hole reaches the cavity without going deeper than necessary.

---

## Applying

1. Review the cavity preview — the blue-tinted translucent mesh shows the hollowed interior.
2. Click **Apply** to bake hollowing (and any hole punches) into the model geometry.
3. Once applied, the hollowing modifier is marked as `bakedIntoGeometry`. You can still re-edit settings and re-apply later.

> **Note:** Applying is a destructive operation on the current modifier state. Un-applied hole punches are preserved across applies.

---

## Related workflows

- [Model Preparation](./model-preparation.md)
- [Transform and Positioning](./transform-and-positioning.md)
- [Raft and Export](./raft-and-export.md)
