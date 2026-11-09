---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
kind: decision
---

# ADR-0032: Camera FOV management and projection switching

## Context

DragonFruit supports both perspective and orthographic camera projections.
Users switch between them while working, and the camera system must preserve
the apparent framing across transitions. Five bug-fix commits exposed implicit
invariants that were being violated.

## Decision

**1. Adjustable perspective FOV.** The perspective camera's field of view is a
user-configurable setting, not a hard-coded constant. The setting persists
across sessions.

**2. FOV preservation across projection switches.** When switching from
orthographic back to perspective, the camera retains the user's chosen FOV
rather than resetting to a default. The transition solves for camera distance
to maintain apparent object size, not for FOV.

**3. Orthographic framing uses a default FOV.** When framing (fit-to-view) in
orthographic mode, the system uses a fixed default FOV to compute the
equivalent orthographic extent, ensuring consistent framing behaviour
regardless of the user's perspective FOV setting.

**4. Camera distance scales to viewport height.** The default introductory
camera distance is computed from the viewport's pixel height, not a fixed
world-space constant. This prevents the model from appearing too small on
large monitors or too large on small ones.

**5. Ortho-to-perspective solves distance, not FOV.** When switching from
orthographic to perspective projection, the system computes the camera
distance that preserves the visible extent at the current FOV, rather than
adjusting the FOV to match the orthographic extent at a fixed distance.

## Consequences

- Any new code that adjusts camera parameters must respect the user's FOV
  setting — never hard-code a FOV value in a transition path.
- Framing operations (fit-to-view, focus-on-selection) are projection-aware
  and must test both projection modes.
- The introductory camera position depends on viewport dimensions, so resize
  handlers must not cache the initial distance.

## Update (superseded)

Decision 3 — ortho framing on a fixed default FOV — was superseded when the
ortho camera moved to a derived frustum. Both projections now use the app's live
FOV setting, so the FOV slider scales the orthographic view too and switching
projection is the identity (no distance solve). See
`docs/dev/camera-navigation.md`. Decisions 1, 2, 4, and 5 still hold in spirit:
the FOV is user-configurable, projection switches preserve apparent framing, and
framing is projection-aware.

## References

- Key commits: `feb15bae` (keep perspective FOV), `1178fc21` (default FOV for
  ortho framing), `189b44c6` (solve distance not FOV), `1ad29bf9` (adjustable
  FOV setting)
- Camera focus helper: `src/features/*/cameraFocusHelper.ts`
- Superseding design: `docs/dev/camera-navigation.md`
