# Support Types Reference

DragonFruit support authoring uses reusable primitives and composed support types.

For the full geometry and behavior breakdown, see [Anatomy of Supports](support-anatomy/index.md).

## Core primitives

- **Roots**: base footprint element.
- **Shaft**: cylindrical segment.
- **Joint**: spherical articulation break.
- **Knot**: attachment point sliding on a host shaft.
- **Contact cone**: terminal model contact piece.

## Support types

- **Trunk**: rooted primary support from plate/raft.
- **Branch**: support attached to another support shaft.
- **Brace**: stabilizer between support hosts.
- **Kickstand**: rooted auxiliary support attached to host shaft.
- **Leaf**: contact-focused variant in `Ctrl+Alt` flow.
- **Twig/Stick**: model-to-model style structures used in Alt family paths.

## Practical guidance

- Start with trunks for structural anchors.
- Add branches to reduce root count and material.
- Add braces where lateral stiffness is needed.
- Use kickstands to reinforce risky paths to ground.

![Support types placeholder](../assets/placeholders/support-types-gallery.png)

> Screenshot placeholder: labeled gallery of trunk, branch, brace, kickstand, and leaf examples.
