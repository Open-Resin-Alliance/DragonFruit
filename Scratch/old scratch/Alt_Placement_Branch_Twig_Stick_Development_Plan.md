# Unified Alt Placement (Branch vs Twig/Stick) — Development Plan + Checklist

## Overview
We are building a single, easy-to-learn **Alt placement workflow** that starts the same way (Alt + click the model), then **switches behavior based on what you target for the second action**:

- Alt + click the model to set **Point A**.
- Move the mouse:
  - If you hover a **support shaft**, the preview switches to **Branch** (Point A on model, base snaps to a support shaft).
  - If you hover the **model mesh**, the preview switches to **Twig/Stick** (Point A on model, Point B on model).
- Second click commits:
  - **On support shaft** → commits a **Branch**.
  - **On model mesh** → commits a **Twig or Stick**, chosen automatically by a **distance cutoff**.

This plan also introduces one shared setting:
- A **Twig vs Stick cutoff distance** (default **5mm**) used whenever we place mesh-to-mesh links.

Twig and Stick are **real, saved support objects** (selectable, deletable, exportable), not temporary placement helpers.

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [x] **Phase 1: Lock requirements + guardrails**
  - [x] Confirm the exact cutoff rule: distance **> cutoff** = Stick, distance **<= cutoff** = Twig.
  - [x] Confirm Twig shaft diameter uses the **tip contact diameter** from settings.
  - [x] Confirm Stick uses the **regular support shaft diameter logic** (same as typical supports).
  - [x] Confirm Leaf stays on `Ctrl+Alt` (no change) and Brace remains Alt-on-support (no change).

- [x] **Phase 2: Add shared settings (single source of truth)**
  - [x] Add a new `meshToMesh` group under `SupportSettings`.
  - [x] Add `stickVsTwigCutoffMm` with default value **5**.
  - [x] Ensure load/save merges defaults safely (no breaking existing localStorage).

- [x] **Phase 3: Add data model support for Twig + Stick**
  - [x] Extend `src/supports/types.ts` to include `Twig` and `Stick` entities.
  - [x] Extend `SupportState` to store `twigs` and `sticks` collections.
  - [x] Extend import/export format (Dragonfruit) to include `twigs` and `sticks`.
  - [x] Add store actions in `src/supports/state.ts`:
    - [x] `addTwig`, `removeTwig`, (optional) `updateTwig`
    - [x] `addStick`, `removeStick`, (optional) `updateStick`
  - [x] Ensure delete flow can remove twig/stick and clears selection correctly.

- [x] **Phase 4: Create feature folders + builders (domain structure)**
  - [x] Create folder: `src/supports/SupportTypes/Twig/`
    - [x] Add `twigBuilder.ts` that builds a mesh-to-mesh support using:
      - 2 contact cones (Point A, Point B)
      - a thin connecting shaft whose diameter equals `settings.tip.contactDiameterMm`
  - [x] Create folder: `src/supports/SupportTypes/Stick/`
    - [x] Add `stickBuilder.ts` that builds a mesh-to-mesh support using:
      - 2 contact cones
      - a connecting shaft using the regular shaft diameter logic (settings-driven)
  - [x] Ensure both builders share any truly-common math in an appropriate shared domain folder (only if needed).

- [ ] **Phase 5: Rendering + selection integration**
  - [x] Render placed Twigs/Sticks in `src/supports/SupportRenderer.tsx` (or the existing rendering pipeline)
  - [x] Ensure they are selectable/deletable following the existing interaction rules.
  - [x] Ensure previews render using the existing generic `SupportBuilder` data shape.

- [ ] **Phase 6: Unified Alt placement controller (switching on the second target)**
  - [ ] Implement a unified Alt placement state machine that stores:
    - [ ] Point A (model hit)
    - [ ] Current hover target classification for the second step (support vs model)
    - [ ] Preview data for whichever mode is active
  - [ ] While awaiting second input:
    - [ ] If hovering a support shaft: use existing snapping targets (Trunk/Branch/Brace segments) and show Branch preview
    - [ ] If hovering the model mesh: track Point B and show Twig/Stick preview based on distance cutoff
  - [ ] Second click commits the correct type:
    - [ ] Click on snapped support shaft → Branch commit
    - [ ] Click on model mesh → Twig/Stick commit
  - [ ] Ensure **Alt release** cancels cleanly and clears previews.
  - [ ] Ensure **Esc** cancels cleanly.

- [ ] **Phase 7: Regression checks (must not break existing tools)**
  - [ ] Trunk placement still works normally when Alt is not active.
  - [ ] Branch placement still works (Alt-click model → hover/click support).
  - [ ] Brace placement still works (Alt-click support → click support).
  - [ ] Leaf placement still works (`Ctrl+Alt`).
  - [ ] No “double placement” or duplicated click handlers when Alt is held.

## Technical Details

### Relevant Files (current)
- Settings (single source of truth):
  - `src/supports/Settings/types.ts`
  - `src/supports/Settings/defaults.ts`
  - `src/supports/Settings/state.ts`
- Branch placement (existing pattern we will extend / refactor around):
  - `src/supports/SupportTypes/Branch/useBranchPlacement.ts`
  - `src/supports/SupportTypes/Branch/branchPlacementState.ts`
  - `src/supports/SupportTypes/Branch/BranchPlacementController.tsx`
  - `src/supports/SupportTypes/Branch/branchBuilder.ts`
- Brace placement (separate Alt-on-support behavior, must remain intact):
  - `src/supports/SupportTypes/Brace/useBracePlacement.ts`
  - `src/supports/SupportTypes/Brace/BracePlacementController.tsx`
- Central routing of hover/click behavior:
  - `src/features/supports/useSupportInteractionManager.ts`
- Shared snapping logic:
  - `src/supports/interaction/useSnapping.ts`
  - `src/supports/interaction/SnappingManager.ts`
- Generic support rendering for previews/placed supports:
  - `src/supports/rendering/SupportBuilder.tsx`

### Proposed New Structure
- `src/supports/SupportTypes/Twig/`
  - `twigBuilder.ts`
  - (later) `TwigRenderer.tsx` if a specialized renderer is needed (prefer generic SupportBuilder if possible)
- `src/supports/SupportTypes/Stick/`
  - `stickBuilder.ts`

### Proposed Settings Shape
- Extend `SupportSettings` with a new group:
  - `meshToMesh: { stickVsTwigCutoffMm: number }`

### Integration Points (high risk)
- `useSupportInteractionManager.ts` currently routes **model clicks** to Branch placement while branch mode is active; for unified Alt placement we must ensure the **second model click** is treated as Point B (not as “reset Point A”).
- `BranchPlacementController.tsx` currently only commits when snapped to a support; unified flow needs a second path for committing mesh-to-mesh Twig/Stick.
- Avoid global window click handlers fighting each other (BranchPlacementController currently uses a window capture `click` listener while active).

### Placement Rules (locked for implementation)
- **First action**: Alt + click model mesh sets Point A (position + normal + modelId).
- **Second hover/click**:
  - Hover support shaft → preview as Branch (snapped)
  - Hover model mesh → preview as Twig/Stick (Point B)
- **Commit**:
  - Click support shaft → Branch
  - Click model mesh → Twig or Stick by distance cutoff (default 5mm)

