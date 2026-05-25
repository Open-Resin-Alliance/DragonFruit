# Architecture and Handoff

DragonFruit uses a domain-driven structure so support logic, rendering, and interaction stay easy to evolve together.

## Core principles

1. Group by feature or domain, not by generic file type.
2. Keep state, rendering, and interaction separate where possible.
3. Route cross-feature behavior through shared interaction infrastructure.

## Support layout

- Primitives: roots, shaft, knot, joint, contact cone.
- Support types: trunk, branch, brace, kickstand, leaf, twig, stick.
- Shared logic: snapping, highlighting, selection, and interaction guards.

## Handoff expectations

- Keep implementation notes close to the owning domain page.
- When behavior changes, update the docs alongside the code path.
- Prefer concise contracts over long narrative descriptions in developer pages.

## Related

- [Architecture Overview](architecture-overview.md)
- [Support System](support-system.md)
- [Grid and Branching](grid-and-branching.md)

