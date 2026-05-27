# Duplicate Models Workflow

Use Duplicate in **Prepare mode** to create additional copies of the active model with controlled spacing/layout.

## 1) Select the source model

- Click the model you want to copy.
- Open the **Duplicate** panel.

!!! note
    Duplicate actions require an active model selection.

## 2) Choose layout strategy

### Auto Layout

Good for quick copy generation with spacing control.

- **Total Copies** sets target count (standard mode).
- **Arrange Distance** controls spacing in mm.
- **Precision Mode**:
  - **Standard**: preview + confirm workflow.
  - **High-Precision**: SAT-based fill behavior for tighter packing.

### Array Layout

Use fixed grid-style duplication.

- Set **Count** on X/Y/Z.
- Set **Gap** on X/Y/Z in mm.
- Total generated count is derived from axis counts.

## 3) Build duplicates

### Fill Plate

- Available in **Auto Layout**.
- In **Standard**, updates target copies for current plate capacity.
- In **High-Precision**, computes packed placement and applies duplicates directly.

### Confirm Duplicate

- In standard preview flow, use **Confirm Duplicate** to create the new models.

## What gets duplicated

- Source model geometry/transform baseline.
- Grouping context.
- Support state mapped from source into new copies.

After apply, DragonFruit selects the new copies and sets the first created copy active.

## Practical checks

- Verify preview count before confirm.
- Review plate occupancy after fill-plate operations.
- Revalidate support topology if copying already-supported models.

## Related workflows

- [Arrange Models](./arrange-models.md)
- [Transform and Positioning](./transform-and-positioning.md)
- [Model Preparation](./model-preparation.md)

![Duplicate models placeholder](../assets/placeholders/workflow-duplicate-models.png)

> Screenshot placeholder: Duplicate panel with Auto/Array, Fill Plate, and Confirm Duplicate controls.
