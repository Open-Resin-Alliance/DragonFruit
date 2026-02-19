# Anatomy of Supports — Glossary (Source of Truth)

- **Twig** [[Twig]]
  - A two-ended contact element connecting model → model using a single continuous body. Does not attach to supports.

- **Stick** [[Stick]]
  - A two-ended contact element connecting model → model via a central hub: two branches meet at a central spherical joint. Does not attach to supports.

- **Brace** [[Brace]]
  - A support-to-support stabilizer: a `shaft` with a `[[Knot]]` at both ends that snaps to any support `[[Shaft]]` (including a Brace). Never touches the model.

- **Support brace** [[Support brace]]
  - A grounded support-to-support element: starts at `[[Roots]]`, builds upward through `[[Shaft]]`/`[[Joint]]` segments, and ends in a `[[Knot]]` that snaps to a `[[Trunk]]` or `[[Branch]]` shaft (no `[[Contact cone]]`).

- **Roots** [[Roots]]
  - The bottom element of a trunk that forms the footprint on the plate or raft and provides a strong, continuous connection to the trunk.

- **Trunk** [[Trunk]]
  - The support programmatically connected to the Roots’ spherical joint. New trunks are vertical by default; length auto-adjusts to placement height.

- **Joint** [[Joint]]
  - A spherical break in a shaft that lets you change the angle of adjacent shaft segments without moving the ends.

- **Knot (Anchor)** [[Knot]]
  - A spherical connection point used to attach one support to another; slides along the host shaft only (no free 3D movement).

- **Shaft** [[Shaft]]
  - A straight cylindrical segment between Joints or anchors (Roots sphere, Contact cone); diameter per segment, no taper across a Joint.

- **Contact cone** [[Contact cone]]
  - The terminal piece at the model interface; contact face to model, socket side to a Joint (no shaft between).

- **Leaf** [[Leaf]]
  - A contact-cone-based element with an integrated Knot (no joint, no shaft); user-placed to add small contacts.

- **Branch** [[Branch]]
  - A trunk-like support without Roots; its base is a [[Knot]] that snaps to another support’s [[Shaft]] (e.g., trunk or branch), and its tip uses a [[Contact cone]].
