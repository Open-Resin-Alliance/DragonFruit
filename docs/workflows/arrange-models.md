# Arrange Models Workflow

Use Arrange in **Prepare mode** to quickly reposition multiple models on the build plate.

## When to use this

- You imported several models and need clean spacing.
- You want automatic packing before support placement.
- You want a controlled manual array layout.

## 1) Open Arrange controls

1. Enter **Prepare mode**.
2. Open the **Arrange** panel.
3. Choose whether to arrange all visible models or only selected models.

## 2) Choose layout mode

### Auto mode

Use for algorithmic placement.

- **Arrange Distance** controls spacing in mm.
- **Arrange Mode**:
  - **Standard**: default auto placement.
  - **High-Precision**: tighter hull/SAT-style packing.
- **Allow Z-rotation** lets auto arrange rotate models by 90° on Z when beneficial.

!!! note
In High-Precision mode, Z-rotation is required and remains enabled.

### Manual mode

Use for explicit array placement.

- Set **Count** on X/Y/Z.
- Set **Gap** on X/Y/Z in mm.

## 3) Set placement anchor

Choose an anchor for placement origin:

- Center
- Front Left / Front Right
- Back Left / Back Right

## 4) Apply arrangement

- **Arrange All**: applies to all visible models.
- **Arrange Selected**: applies only to current selection.

## Practical checks

- Confirm models stay within plate bounds/safety margins.
- Re-check model orientation after allowing Z-rotation.
- Re-run support checks if arrangement changed model context significantly.

## Important interaction with Duplicate

If Duplicate setup is active with more than one target copy, arrange actions may be temporarily disabled until duplicate count is reduced.

## Related workflows

- [Duplicate Models](./duplicate-models.md)
- [Transform and Positioning](./transform-and-positioning.md)
- [Model Preparation](./model-preparation.md)

![Arrange models placeholder](../assets/placeholders/workflow-arrange-models.png)

> Screenshot placeholder: Arrange panel showing Auto/Manual mode and Arrange All/Arrange Selected actions.
