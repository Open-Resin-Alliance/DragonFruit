# Leaf

A leaf is a minimal support tip with an integrated knot. It adds a small contact without introducing a full shaft chain.

## What it is

- A contact cone paired directly with a knot.
- No shaft and no joint in the middle.
- Used for compact support placements.

## Geometry

- Tip: contact point on the model.
- Cone body: support tip profile.
- Base: integrated knot on the host shaft side.

## Behavior

- Leaf placement begins from the model and then snaps the integrated knot to a valid support shaft.
- The leaf moves with its parent support once attached.
- Tip parameters follow the same rules as the contact cone.

## Constraints

- A leaf must attach to a trunk or branch shaft.
- It does not connect to a joint.
- It is removed if the parent support is removed.

## Related

- [Contact Cone](contact-cone.md)
- [Knot](knot.md)
- [Trunk](trunk.md)
- [Branch](branch.md)

