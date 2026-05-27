# Interface Tour

DragonFruit combines a central 3D workspace with mode-specific controls.

## Main regions

1. **Top bar**: file operations, global actions, app-level controls.
2. **3D canvas**: model view, support rendering, interaction gizmos.
3. **Sidebar (docked)**: mode-specific settings (supports, raft, analysis, etc.).
4. **Floating panels**: additional tools and inspectors.

## Interaction modes

- **Prepare mode**: model transform and setup.
- **Analysis mode**: island and diagnostic inspection workflows.
- **Support mode**: support placement, editing, snapping, and raft tuning.
- **Export mode**: finalize output and export artifacts.
- **Printing mode**: inspect sliced layers before printing (enabled when printing data is available).

!!! note
      Some environments/profiles may temporarily gate parts of the Analysis workspace.

## Selection behavior

- Clicking the model or support elements changes active context.
- Joint/knot editing tools take interaction priority over lower-level hover/select actions.

## Layout persistence

DragonFruit can persist floating panel positions between sessions.

![Interface placeholder](../assets/placeholders/interface-tour-annotated.png)

> Screenshot placeholder: annotated UI with labels for top bar, canvas, sidebar, and floating panels.
