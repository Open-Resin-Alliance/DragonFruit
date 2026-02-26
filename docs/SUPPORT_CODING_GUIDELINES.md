# Support System Coding Guidelines

This document captures the working conventions for support interactions, rendering, and placement logic in DragonFruit.

## 1) Interaction precedence (important)

When two systems can react to the same pointer event, use this priority:

1. **Explicit editing gizmos** (knot/joint/bezier)
2. **Placement tools** (Alt brace/branch/twig workflows)
3. **Support selection/hover**
4. **Canvas/model fallback behavior**

Rule: higher-priority interaction must suppress lower-priority interactions for the duration of the action, plus a short guard window after release.

## 2) Global interaction lock pattern

Use a small global lock signal for cross-component coordination:

- `window.__knotGizmoDragging` (boolean)
- `window.__knotGizmoGuardUntil` (epoch ms)
- event: `knot-gizmo-interaction-lock` with `{ active, guardUntil }`

`SupportRenderer` should consume this lock and treat it the same way we treat placement suppression (Alt-based flows): disable support hover + selection while active.

## 3) Hover/selection suppression consistency

If support interactions are suppressed:

- do not update `sceneHoveredSupportId`
- do not emit model hover to support selector
- clear any pending hover RAF clear loop safely
- keep placement events (e.g. shaft click/hover/leave) available only when needed by active placement tool

## 4) Segment identity & snapping

Avoid assumptions that `segmentId` maps 1:1 to a single path target at runtime.

- Build candidate lists by ID when possible (`id -> SnapTarget[]`)
- Resolve the nearest candidate by actual pointer/snapped position
- Prefer front-most hover event data for preview endpoints

This prevents “same hovered segment ID but preview jumps to neighbor” behavior in dense geometry.

## 5) Batched vs detailed renderer parity

Whenever interaction behavior changes, update both:

- **batched instanced path** (`SupportRenderer` / instanced groups)
- **detailed path** (`ShaftRenderer`, specific type renderers)

Parity checklist:

- same hover enter/leave semantics
- same click payload shape (`segmentId`, `point`, `intersection`)
- same suppression guards

## 6) Post-drag guard windows

After drag release, keep a short guard (typically 120–200ms) to avoid accidental selection from the release-hover frame.

- keep durations minimal
- centralize guard source (global lock + event)
- avoid duplicate unrelated timers in multiple components unless they are synchronized

## 7) Overlay/debug requirements

`Ctrl+Shift+X` overlay is mode-aware:

- **Support mode:** support/placement diagnostics only
- **Non-support modes:** transform diagnostics

When debugging placement drift, always include:

- hovered segment id
- snapped segment id / target kind
- preview start/end
- mismatch indicator

## 8) Change hygiene

For support interaction changes:

1. Add smallest possible fix
2. Verify file diagnostics
3. Run support tests (`npm test`)
4. Test manually in dense overlap scenes (front/back supports)

## 9) Don’ts

- Don’t let hover state mutate while gizmo drag lock is active
- Don’t assume map key uniqueness if IDs may be reused by different target sources
- Don’t update only one rendering path (batched or detailed) when changing interaction behavior
