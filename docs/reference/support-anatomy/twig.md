# Twig

A twig is a model-to-model support that uses one continuous body between two contact points.

## What it is

- A two-ended contact element.
- Does not attach to existing supports.
- Useful for short spans where a simpler mono-shaft body is enough.

## Geometry

- Tip A and tip B contact the model.
- The body remains continuous between the tips.
- Optional joints may be inserted along the body in editing flows.

## Behavior

- Placement starts with one model contact and finishes with another.
- The preview may switch between twig and stick behavior depending on span length.

## Constraints

- Twigs do not use knots.
- Twigs do not attach to support shafts.
- The built shaft must stand within 45° of vertical. A twig's ends are contact
  disks, and the standoff a sloped or sidewall landing needs can push the
  sockets far off the line between the two contacts; past that cant the member
  is a whisker that carries no load, so it is refused rather than placed.
  Sticks, which bridge longer spans, are held to 20°.

## Related

- [Stick](stick.md)
- [Contact Cone](contact-cone.md)
- [Joint](joint.md)

