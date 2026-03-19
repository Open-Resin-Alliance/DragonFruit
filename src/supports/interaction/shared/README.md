# Shared Support Interaction Architecture

This directory is the migration foundation for support interaction refactoring.

## Ownership boundaries

### Shared hover layer owns
- Translating raw support/model hover signals into one resolved hover snapshot.
- Suppression and stale-hover resolution rules.
- Shared hover source + intent state for selection and placement.

### Shared selection layer owns
- Single-select, shift-toggle multi-select, and marquee-select state.
- Marquee candidate tracking.
- Resolved selection snapshot for rendering and tool logic.

### Shared placement preview layer owns
- Preview mode resolution (`hidden`, `hoverDot`, `tipMarker`, `snappedPreview`, `freePreview`).
- Preview visibility guards.

### Shared snapping layer owns
- Snap target registration and lookup.
- Resolved snap session state and lock metadata.

### Shared placement session layer owns
- Placement session stage transitions.
- Lifecycle helpers for start/cancel/finalize/reset.
- Common cleanup contract for temporary interaction state.

## Support-type-specific ownership

### Branch keeps
- Branch geometry and anatomy building.
- Branch mesh-to-mesh fallback behavior.
- Branch-specific snap acceptance rules.

### Leaf keeps
- Leaf geometry and anatomy building.
- Leaf-specific start rules and host attachment rules.

### Brace keeps
- Brace endpoint validation and geometry building.
- Brace-specific preview model and host-diameter handling.

### Kickstand keeps
- Kickstand placement rules and geometry building.
- Kickstand-specific preview details.

## Migration rules

1. Existing hooks/controllers can keep their stores while delegating new decisions to shared modules.
2. Shared modules must be introduced as compatibility layers first, then become authoritative.
3. Renderers should consume resolved state, not rebuild hover/selection/preview decisions.
4. Each placement type should migrate in isolation (branch -> leaf -> brace -> kickstand).
5. Remove duplicated guards and cleanup only after all placement paths are migrated.
