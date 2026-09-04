# Interface Tour

DragonFruit combines a central 3D workspace with mode-specific controls.

## Main regions

1. **Top bar**: file operations, global actions, app-level controls.
2. **3D canvas**: model view, support rendering, interaction gizmos.
3. **Sidebar (docked)**: mode-specific settings (supports, raft, analysis, etc.).
4. **Floating panels**: additional tools and inspectors.

## Interaction modes

- **Prepare mode**: model transform, hollowing, hole punching, and setup.
- **Analysis mode**: island and diagnostic inspection workflows.
- **Support mode**: support placement, editing, snapping, and raft tuning.
- **Export mode**: finalize output and export artifacts.
- **Printing mode**: inspect sliced layers before printing (enabled when printing data is available).

!!! note
      Some environments/profiles may temporarily gate parts of the Analysis workspace.

## Selection behavior

- Clicking the model or support elements changes active context.
- Joint/knot editing tools take interaction priority over lower-level hover/select actions.
- `Shift`+drag draws a selection rectangle: models in Prepare mode, support
  elements in Support mode. Each mode only ever selects its own entities.
  Nothing is selected until the mouse button is released — while you drag, the
  rectangle previews what it would take.
- A marquee only ever adds to the selection, and a drag that catches nothing
  leaves it untouched. To clear a selection, click an empty spot on the canvas.
- A model counts together with its supports and its raft: touching any of them
  takes the model, and enclosing it means enclosing all three.
- The direction of the drag picks the rule, as CAD applications do:
    - **Left to right** draws a green rectangle and takes only what it encloses
      completely.
    - **Right to left** draws a magenta rectangle and takes anything it
      touches.

## Layout persistence

DragonFruit can persist floating panel positions between sessions.

![Interface placeholder](../assets/placeholders/interface-tour-annotated.png)

> Screenshot placeholder: annotated UI with labels for top bar, canvas, sidebar, and floating panels.
