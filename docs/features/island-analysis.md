# Island Analysis and Voxel Visualization

Island analysis identifies disconnected or unsupported regions across layers.

## What the feature does

- Scans transformed model geometry layer-by-layer.
- Labels island regions per layer.
- Builds 3D voxel visualizations from scan labels.

## Visualization modes

- **Unique colors**: each island gets a distinct color.
- **Lifecycle**: differentiates merged vs active islands.
- **Height gradient**: visual grouping by vertical position.

## Interaction

- Select islands for focused inspection.
- Filter merged islands when debugging structure.
- Adjust opacity for clarity in dense scenes.

## Coordinate behavior

Scan outputs are derived from transformed world-space geometry. Rendering follows the scan positioning policy to avoid double-applying rotation/lift transforms.

![Island voxel placeholder](../assets/placeholders/island-voxels.png)

> Screenshot placeholder: voxel visualization with one selected island highlighted.
