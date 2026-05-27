# Branch

A branch is a support that grows from another support instead of starting from Roots.

## What it is

- A trunk-like support without Roots.
- The base is a knot that snaps to another support shaft.

## Geometry

- Base: knot anchored to a host shaft.
- Body: one or more shaft segments.
- Optional joints: used for angle edits.
- Tip: contact cone at the model.

## Behavior

- Branches are created from the model outward, then snap their base to a support shaft.
- Once attached, they inherit motion from their parent support.
- Their angle and length can be edited like a trunk.

## Constraints

- Branches do not connect to the model, plate, or raft at the base.
- The base knot must attach to a trunk or another branch shaft.
- If the parent support is removed, the branch must be reassigned or removed.

## Related

- [Knot](knot.md)
- [Joint](joint.md)
- [Contact Cone](contact-cone.md)
- [Trunk](trunk.md)

