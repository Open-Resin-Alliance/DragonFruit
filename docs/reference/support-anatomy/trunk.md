# Trunk

A trunk is the main grounded support column. It is the primary support type that starts from the build surface and rises toward the model.

## What it is

- The support type that connects to [Roots](roots.md).
- The parent structure for attached supports such as branches and leaves.

## Geometry

- Starts at Roots.
- Builds upward through one or more shaft segments.
- Uses joints when the support needs angle changes.
- Ends in a contact cone at the model.

## Behavior

- New trunks start vertical by default.
- The length adjusts automatically to the placement height.
- The trunk base stays anchored in the Roots interface.

## Constraints

- A trunk is the only support type that uses Roots as its base.
- The first segment above Roots must preserve the trunk-to-root connection.

## Related

- [Roots](roots.md)
- [Branch](branch.md)
- [Leaf](leaf.md)

