# Place On-Face and Mirror Workflow

Use **On-Face** and **Mirror** in Prepare mode for fast orientation and symmetry operations.

## On-Face workflow

1. Enter **Prepare** mode.
2. Choose **On-Face** from the transform toolbar.
3. Click the face you want to place against the plate.
4. Let the orientation animation finish.

### Behavior notes

- On-Face orients the selected face flat to the build plate.
- If supports would be invalidated by the operation, DragonFruit may require confirmation before applying.
- On completion, transform state is committed and tool flow returns to normal editing.

## Mirror workflow

1. Enter **Prepare** mode.
2. Choose **Mirror** from the transform toolbar.
3. Select mirror axis (X, Y, or Z) using mirror handles.
4. Continue mirroring as needed.
5. Exit Mirror mode to finalize.

### Behavior notes

- Mirror uses a preview/session flow and then finalizes geometry when leaving the tool.
- Z-axis mirror may require destructive-operation confirmation if supports are present.
- Finalization updates model geometry and transform state together.

## Practical checks

- Re-check model-to-plate relationship after orientation changes.
- Revalidate supports after mirrored or face-placement operations.
- Run island scan again if major geometry orientation changed.

## Related workflows

- [Transform and Positioning](./transform-and-positioning.md)
- [Mesh Smoothing](./mesh-smoothing.md)
- [Support Placement](./support-placement.md)

![On-face and mirror placeholder](../assets/placeholders/workflow-on-face-mirror.png)

> Screenshot placeholder: toolbar in On-Face/Mirror mode with selected face and mirror axis handles.
