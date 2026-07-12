# Contact Cone

The contact cone is the terminal piece that interfaces a support with the model.

## What it is

- The final support piece that touches the model.
- A cone with a small contact end and a larger socket side.

## Geometry

- Tip: the small contact face that touches the model.
- Cone body: the tapered section between the tip and socket.
- Tip ball: a sphere (radius = contact radius) where the cone body meets the
  contact disk. It fills the elbow wedge when the cone approaches the surface
  at an angle. The disk standoff is floored at contact radius + 0.1 mm
  (`TIP_BALL_CLEARANCE_MM` in `contactDiskUtils.ts`) so the ball never touches
  the model — only the disk makes contact.
- Socket side: connects directly to a joint, with no shaft between them.

## Behavior

- The cone axis follows the averaged surface normal under the contact footprint.
- The tip embeds into the model surface by the penetration depth (see below).
- The cone is the terminal element for support types that end on the model.

## Penetration (embed depth)

Penetration extends the contact disk deeper into the model along the surface
normal, without moving the cone-side connection.

- Setting: **Penetration** in the support sidebar (`tip.penetrationMm`,
  0–0.5 mm, default 0.1 mm).
- The disk cylinder grows by the penetration depth and shifts into the model;
  the cone-side end (where the cone body meets the disk) stays exactly where
  it was, so sockets and joints are unaffected.
- It applies universally to every disk-tipped support type (trunk, branch,
  leaf, stick, anchor, and both ends of a twig) and is honored by the
  viewport, file export, and the sliced/printed mesh alike.
- Deeper penetration anchors the support more strongly at the cost of a
  larger surface blemish after removal.

## Oval contact face (squish)

Each contact disc can be reshaped from a circle into an oval, per disc, using
the handle on the disc's selection gizmo ring.

- Drag the handle **toward the center** to squish the contact face (down to
  25% of the contact diameter); drag it **around the ring** to rotate the
  oval about the disc's normal. Hold **Shift** to snap the rotation to 15°
  steps. **Double-click** the handle to reset to a perfect circle.
- The oval is anchored at the model surface: the full oval cross-section runs
  through the entire penetration depth, then blends back to a circle where
  the disc meets the cone tip — so the shape crossing the model skin is
  exactly the oval you drew, at any penetration.
- The shape is stored on the individual support (like its position), survives
  save/load and copy/paste, participates in undo/redo, and is honored by the
  viewport, file export, and the sliced/printed mesh alike.
- Use it to slip contacts into narrow details or grooves where a full-width
  circular mark would damage the surface.

## Constraints

- The contact face touches the model only.
- The socket side connects to a joint only.
- It does not connect directly to a shaft.

## Related

- [Trunk](trunk.md)
- [Branch](branch.md)
- [Leaf](leaf.md)
- [Twig](twig.md)
- [Stick](stick.md)
- [Contact Tip Research](contact-tip-research.md)

