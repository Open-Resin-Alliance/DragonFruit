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
