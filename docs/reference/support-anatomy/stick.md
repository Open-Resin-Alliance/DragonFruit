# Stick

A stick is a model-to-model support that uses a central hub and two branched sides.

## What it is

- A two-ended contact element.
- Similar to a twig, but with a central joint and two branches meeting in the middle.
- Used for longer spans where a central hub is helpful.

## Geometry

- Tip A and tip B contact the model.
- Each side runs from a model contact toward a central joint.
- The center joint acts as the hub.
- The cone at each end shortens to fit the gap it crosses, and the clearance
  test covers the free span between the two sockets rather than their anchored
  ends. Without both, a bridge across a gap narrower than the stock cone length
  (2.5 mm per end) reads as a collision however clear it is, because the sockets
  run past each other into the material.

## Behavior

- Placement starts with one model contact and finishes with the other.
- The preview may switch between stick and twig behavior depending on distance.
- The central joint can be adjusted during editing.

## Constraints

- Sticks do not use knots.
- Sticks do not attach to support shafts.
- The built shaft must stand within 20° of vertical. Surface-normal standoffs
  shove the sockets sideways on sloped surfaces, and past that cant the result
  is a wedged stick rather than a bridge, so the automatic passes refuse it and
  fall back.
- The cap applies to the automatic passes. A stick you aim by hand is built at
  whatever cant you aim it, because you chose both contacts and the preview
  shows you the shape; the cap exists so the auto pass cannot fill a gap with
  wedges, not to overrule a deliberate placement.
- Which type a hand-aimed span builds is decided by the span, not by you: up to
  `stickVsTwigCutoffMm` (5 mm by default) is a twig, longer is a stick.

## Related

- [Twig](twig.md)
- [Contact Cone](contact-cone.md)
- [Joint](joint.md)

