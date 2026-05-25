# Shaft

A shaft is the straight cylindrical section used throughout the support system.

## What it is

- A straight cylinder between endpoints.
- The load-bearing span between joints, knots, roots, or tip interfaces.

## Geometry

- The body remains straight for a single segment.
- Diameter is defined per segment from settings.

## Behavior

- Endpoint movement updates the shaft's orientation and length.
- Shafts can host joints or knots depending on the support type.

## Constraints

- No taper is allowed across a joint.
- Curved behavior is handled by separate features, not by the shaft primitive itself.

## Related

- [Joint](joint.md)
- [Knot](knot.md)
- [Trunk](trunk.md)
- [Branch](branch.md)

