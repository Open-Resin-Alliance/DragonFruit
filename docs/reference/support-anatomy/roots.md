# Roots

Roots are the grounded base of a trunk support. They form the footprint on the build plate or raft and provide the trunk's anchor point.

## What it is

- The bottom piece of a trunk.
- A truncated cone body with an integrated spherical top.
- Always seated on the plate or raft, not on a model or another support.

## Geometry

- Body: truncated cone.
- Top: spherical cap/ball that receives the trunk shaft.
- Main dimensions:
  - bottom diameter
  - top diameter
  - height
  - raft embed depth

## Behavior

- Dragging Roots moves the trunk base in the XY plane.
- When a raft exists, Roots sit on the raft and embed slightly.
- Roots do not snap to models or support shafts.

## Constraints

- The footprint has a minimum size requirement.
- The trunk-to-roots interface must stay watertight.
- The top diameter matches the trunk shaft interface.

## Related

- [Trunk](trunk.md)
- [Support Types](../support-types.md)

