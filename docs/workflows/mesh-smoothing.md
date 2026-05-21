# Mesh Smoothing Workflow

Use **Smooth** in Prepare mode to sculpt and clean local surface regions before support generation.

## 1) Enter Smooth mode

1. Switch to **Prepare**.
2. Choose **Smooth** from the transform toolbar.
3. Select the model to edit.

## 2) Configure brush dynamics

In the smoothing settings panel, tune:

- **Brush Size** (mm)
- **Strength**
- **Falloff** (`linear`, `smooth`, `sharp`)
- **Iterations**

## 3) Configure highlight

Set paint highlight color using:

- color text input
- color picker
- reset defaults if needed

## 4) Apply smoothing strokes

- Paint over target areas to smooth local geometry.
- Work in smaller passes for predictable results.
- Re-check silhouette and critical detail edges between passes.

## Practical checks

- Avoid over-smoothing high-detail functional surfaces.
- Re-check support contact surfaces after smoothing.
- If needed, reset settings and rework with lower strength.

## Related workflows

- [Transform and Positioning](./transform-and-positioning.md)
- [Support Placement](./support-placement.md)
- [Island Analysis Workflow](./island-analysis-workflow.md)

![Smoothing workflow placeholder](../assets/placeholders/workflow-mesh-smoothing.png)

> Screenshot placeholder: Smooth mode brush cursor and smoothing settings panel.
