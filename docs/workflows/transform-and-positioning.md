# Transform and Positioning Workflow

Use **Modify** in Prepare mode to position models before supports.

## 1) Enter Modify mode

1. Switch to **Prepare**.
2. In the top toolbar, choose **Modify**.
3. Select the target model.

## 2) Move

Use X/Y/Z fields to set precise position.

Quick actions:

- **Center**: center model on plate.
- **Platform**: place model on platform.
- **Arrange**: one-click center + platform action.

### Auto-lift tools

- Toggle **Auto-Lift** on/off.
- Set **Distance (mm)**.
- Use **Lift** / **Drop** for direct repositioning.

## 3) Rotate

- Edit X/Y/Z angles directly.
- **Drag** a ring's diamond handle for free rotation.
- **Click** a ring's diamond handle to open the protractor dial:
  - Aim — the pointer sticks to tick marks; the readout shows the angle
    from the dial's 0° reference.
  - Click a tick to rotate the model by exactly that angle.
  - Press **Esc** (or click the diamond again) to cancel.
- Set tick spacing with the **Short / Long / Spoke** fields (degrees;
  Short must divide 360; 0 hides Long or Spoke marks).
- Use **Reset Rotation** when needed.

## 4) Scale

- Adjust X/Y/Z scale values.
- Toggle **Uniform** scaling.
- Switch units between **%** and **mm**.
- Use **Reset Scale** to restore scale defaults.

## Practical checks

- Ensure model is clear of plate unless intentionally dropped.
- Keep orientation suitable for drainage and support access.
- Re-check bounds before moving to support placement.

## Related workflows

- [Model Preparation](./model-preparation.md)
- [Place On-Face and Mirror](./place-on-face-and-mirror.md)
- [Support Placement](./support-placement.md)

![Transform workflow placeholder](../assets/placeholders/workflow-transform-positioning.png)

> Screenshot placeholder: Modify mode with move/rotate/scale cards and auto-lift controls.
