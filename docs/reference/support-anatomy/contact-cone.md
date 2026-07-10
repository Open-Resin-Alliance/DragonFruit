# Contact Cone

The contact cone is the terminal piece that interfaces a support with the model.

## What it is

- The final support piece that touches the model.
- A cone with a small contact end and a larger socket side.

## Geometry

- Tip: the small contact face that touches the model.
- Cone body: the tapered section between the tip and socket.
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
  the round tip on the cone side stays exactly where it was, so sockets and
  joints are unaffected.
- It applies universally to every disk-tipped support type (trunk, branch,
  leaf, stick, anchor, and both ends of a twig) and is honored by the
  viewport, file export, and the sliced/printed mesh alike.
- Deeper penetration anchors the support more strongly at the cost of a
  larger surface blemish after removal.

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

