# Anatomy of Supports

This section breaks the support system into the geometry and behavior of each building block.

If you want the quick naming summary, start with [Support Types](../support-types.md). If you want the implementation-oriented breakdown, use the pages below.

## Core primitives

- [Roots](roots.md)
- [Shaft](shaft.md)
- [Joint](joint.md)
- [Knot](knot.md)
- [Contact Cone](contact-cone.md)

## Support types

- [Trunk](trunk.md)
- [Branch](branch.md)
- [Brace](brace.md)
- [Kickstand](kickstand.md)
- [Leaf](leaf.md)
- [Twig](twig.md)
- [Stick](stick.md)

## Research notes

- [Contact Tip Research](contact-tip-research.md)

## At a glance

| Element | What it does | Key constraint |
| --- | --- | --- |
| Roots | Grounds a trunk on the plate or raft | Must stay on the build surface |
| Shaft | Carries load between endpoints | Must remain straight per segment |
| Joint | Changes angle without moving endpoints | Keeps shaft diameters matched across the joint |
| Knot | Attaches one support to another | Slides only along a host shaft |
| Contact Cone | Connects a support to the model | Touches the model only at the tip |
| Trunk | Main grounded support | Starts from Roots |
| Branch | Support extending from another support | Does not use Roots |
| Brace | Support-to-support stabilizer | Never touches the model |
| Kickstand | Grounded support that terminates on another support | Must end on a valid trunk or branch shaft |
| Leaf | Minimal support contact with integrated knot | No shaft, no joint |
| Twig | Model-to-model support with one continuous body | Does not attach to supports |
| Stick | Model-to-model support with a central hub | Does not attach to supports |

