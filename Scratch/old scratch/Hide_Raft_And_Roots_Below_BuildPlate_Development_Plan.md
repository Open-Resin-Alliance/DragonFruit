# Hide Raft + Roots When Camera Is Below Build Plate — Development Plan

## Overview
When you orbit the camera underneath the build plate (looking up from below), the raft and the roots clutter the view and can obscure supports/model context. The goal is to automatically hide:

- The **raft** (crenelated raft system)
- The **roots** (the base/footprint primitive for trunks)

…but **only** while the camera is **below the build plate plane** (Z < 0 in world space). As soon as the camera moves back above the plate, these elements should become visible again.

This behavior must work consistently in **all modes/views** (Prepare / Support / Analysis), since it is purely a camera/view declutter rule.

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [ ] **Phase 1: Define the visibility rule + thresholds**
  - [ ] Confirm build plate plane is world-space Z=0 (current convention)
  - [ ] Decide on a small threshold to prevent flicker at the boundary (example: hide when `cameraZ < -0.01`)

- [ ] **Phase 2: Add a single authoritative “camera below plate” signal**
  - [ ] Implement a boolean derived from the active R3F camera world position (Z)
  - [ ] Update the boolean on OrbitControls movement (and any other camera change path)
  - [ ] Ensure it updates even when switching modes (Prepare/Support/Analysis)

- [ ] **Phase 3: Raft visibility integration**
  - [ ] Gate rendering of the raft system when camera is below plate
  - [ ] Ensure raft remains hidden regardless of raft settings when camera is below plate

- [ ] **Phase 4: Roots visibility integration**
  - [ ] Gate rendering of trunk roots when camera is below plate
  - [ ] Ensure only the roots are hidden (shafts/joints/tips remain visible)

- [ ] **Phase 5: Manual regression checks (visual)**
  - [ ] Orbit above plate: raft + roots visible as before
  - [ ] Orbit below plate: raft + roots hidden, everything else unchanged
  - [ ] Hover/selection/picking still works (no broken references)
  - [ ] No flicker when crossing the Z=0 boundary (threshold/hysteresis works)

## Technical Details

### Relevant Files (Primary Integration Points)
- `src/components/scene/SceneCanvas.tsx`
  - Owns the R3F `<Canvas />` and mounts `<OrbitControls />`.
  - Already has `CameraProvider` storing `cameraRef.current`.
  - Already passes `onChange` / `onEnd` handlers to OrbitControls.
  - Currently renders raft directly:
    - `<RaftRenderer />`
    - `<FootprintBorderRenderer ... />`

- `src/supports/Rafts/Crenelated/rendering/RaftRenderer.tsx`
  - Renders raft geometry at Z=0 when `raft.enabled`.

- `src/supports/SupportTypes/Trunk/TrunkRenderer.tsx`
  - Calls `<RootsRenderer ... />` as part of trunk rendering.

- `src/supports/SupportPrimitives/Roots/RootsRenderer.tsx`
  - Renders the root disk / cone / sphere footprint.

### Proposed Implementation Pattern (Minimal + Centralized)

1) **Compute a single `isCameraBelowBuildPlate` boolean in `SceneCanvas.tsx`.**

- Derive from the actual R3F camera world position:
  - `cameraRef.current?.position.z`
- Apply a small negative threshold to avoid boundary flicker.

2) **Use that boolean to control visibility in exactly two places:**

- **Raft**:
  - Condition the rendering of `<RaftRenderer />` and `<FootprintBorderRenderer />` in `SceneCanvas.tsx` so they do not render when `isCameraBelowBuildPlate` is true.

- **Roots**:
  - Pass a single visibility prop down through trunk rendering (or compute in a shared place if you already have a camera-state store).
  - The simplest integration is at the call site in `TrunkRenderer.tsx`:
    - When camera is below plate, do not render `<RootsRenderer />`.

This approach keeps the “camera-based declutter rule” in one authoritative place (SceneCanvas) and avoids scattering camera queries across many primitives.

### Notes / Constraints
- The hide rule should be based on **camera position**, not orbit target or view direction.
- The feature should not introduce new global state unless needed; a SceneCanvas-local state + prop threading is preferred for this scope.
- If you later add additional “below-plate declutter” behaviors (e.g., hide grid helper, hide plate decals), this same boolean should be reused rather than recomputed.
