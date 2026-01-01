# Brace Support (Alt on Support) — Development Plan + Checklist

## Purpose
Add a new **Brace** support type to the V2 supports system.

A Brace is a **support → support** stabilizer that:
- Connects between **two attachment points** (normally **support shaft segments**).
- **Never touches the model**.
- Is composed of:
  - A **Knot** at each end (endpoints).
  - A **Brace shaft** between them.

This plan also includes a critical exception:
- A Brace endpoint may attach to the **cone body of a Leaf** (Leaf-only), with **variable diameter** based on where along the cone the endpoint sits.

---

## Hard Requirements (locked)

### Placement / UX
- **Hotkey**: Hold **Alt**.
- **Disambiguation**:
  - **Alt + click on model mesh** ⇒ Branch placement (existing behavior).
  - **Alt + click on a support shaft segment** ⇒ Brace placement (new).
- **Brace workflow**:
  1. Alt + click a valid target (shaft segment OR leaf cone) to set endpoint A.
  2. Preview appears and follows mouse.
  3. Endpoint B can only be committed by clicking a valid target (shaft segment OR leaf cone).
- **No fallback commit**:
  - Clicking **model mesh** or **empty canvas** during brace preview does **nothing** (preview remains).
- **Cancel**:
  - **Esc** cancels the in-progress brace placement.
- **Hover feedback (shaft targets)**:
  - Only the **hovered segment** highlights (not the entire support).
- **Hover feedback (leaf targets)**:
  - The **Leaf highlights**.
  - Show a **knot preview** on the cone that slides up/down with the mouse and **changes size** to match the local cone diameter.

### Attachment + sizing
- **Shaft endpoints**:
  - Each brace end diameter matches the host **shaft diameter** at the knot attachment.
- **Leaf cone endpoints (Leaf-only)**:
  - Endpoint may attach anywhere on the **Leaf cone body**, but must never attach to or overlap the **contact disc** at the tip.
  - The brace end diameter matches the **local cone diameter** at the attachment position.
- **Selected/unselected visual rule** (same as existing knots/joints):
  - **Unselected**: render at the base diameter.
  - **Selected**: render at **base diameter + 0.1mm** (editable “pop”).

### Editing
- Brace endpoints (knots) must be movable after placement:
  - On shafts: slides along the shaft (existing knot behavior).
  - On leaf cone: slides along the **cone centerline**; size updates continuously as it moves.

### Same-support bracing constraints
- Allowed: connecting **two different segments** on the **same support**.
- Not allowed: connecting to the **same segment**.
- Extra constraint: same-support bracing is only allowed if **at least one** of the two segments is **curved**.

### Knot merging / “too close” behavior (explicitly out-of-scope)
- No merging prompts.
- No “too close” rejection.
- No auto-offset.

---

## Current System Facts (what exists today)

### Existing hotkey system
- File: `src/hotkeys/hotkeyConfig.ts`
- Branch uses `Alt`.

### Existing Branch/Leaf placement pipeline (to mirror)
- Branch pattern:
  - `src/supports/SupportTypes/Branch/useBranchPlacement.ts`
  - `src/supports/SupportTypes/Branch/branchPlacementState.ts`
  - `src/supports/SupportTypes/Branch/BranchPlacementController.tsx`
- Leaf pattern:
  - `src/supports/SupportTypes/Leaf/useLeafPlacement.ts`
  - `src/supports/SupportTypes/Leaf/leafPlacementState.ts`
  - `src/supports/SupportTypes/Leaf/LeafPlacementController.tsx`

### Existing universal snapping + interaction rules (must reuse)
- `src/supports/interaction/SnappingManager.ts`
- `src/supports/interaction/useSnapping.ts`

### Knot attachment contract (must preserve)
Knots store:
- `parentShaftId`
- `t` (0..1)
- `pos`

And shaft changes must recompute attachments via authoritative paths:
- `src/supports/state.ts` (update routes + `recomputeKnotDependentGeometry(...)`).

---

## Key Design Decisions (locked)
- Brace is a new domain folder: `src/supports/SupportTypes/Brace/`.
- Brace uses universal snapping; no custom snapping math.
- Brace may target:
  - Support shaft segments (normal)
  - Leaf cone body (Leaf-only exception)
- No merge/offset logic in this session.

---

## Implementation Strategy (high-level)
1. Add a Brace support entity + store integration (types/state/import/export).
2. Create a Brace placement state + controller mirroring the Branch/Leaf controller pattern.
3. Implement Brace preview rendering (ghosted) + placement commit rules.
4. Implement Brace rendering for placed braces (including diameter transition along the brace shaft).
5. Extend snapping targets to include Leaf cone bodies (Leaf-only) and drive the dynamic knot-size preview.
6. Extend knot interaction for braces so endpoints slide on shafts and slide along leaf cones.
7. Wire Brace into selection/delete/history/export and recompute derived geometry on topology edits.

---

# Development Checklist (step-by-step)

## Phase 0 — Guardrails / sanity checks
- [ ] Confirm Branch placement remains Alt+click on **model mesh** only.
- [ ] Confirm Alt+click on **support segments** does not accidentally start Branch placement.
- [ ] Confirm Alt modifier doesn’t conflict with other tools while in Support Mode.

## Phase 1 — Create Brace SupportType folder (domain structure)
- [x] Create folder: `src/supports/SupportTypes/Brace/`
- [ ] Add brace placement state store (mirror Branch/Leaf):
  - [x] `bracePlacementState.ts`
- [ ] Add placement hook:
  - [x] `useBracePlacement.ts`

## Phase 1.5 — UX unblocker: allow brace placement without pre-selection
- [ ] Allow Alt+click on **any** shaft segment to start a brace (no need to pre-select the parent support).
  - [ ] Must not break the decluttered selection rule for normal clicks.
  - [ ] Only relax segment click/pick rules while Brace placement is active.

## Phase 2 — Brace data model + store integration
- [ ] Update `src/supports/types.ts`:
  - [x] Add `Brace` interface.
  - [x] Add `braces` collection to `SupportState`.
  - [x] Extend import/export format(s) to include braces.
  - [ ] Define endpoint references (two endpoints) in a way that supports:
    - shaft-based endpoints (segment + t)
    - leaf-cone endpoints (leafId + cone-t)
- [ ] Update `src/supports/state.ts`:
  - [x] Add `braces: {}` to initial state.
  - [ ] Add actions `addBrace`, `updateBrace`, `removeBrace`.
    - [x] `addBrace`
    - [ ] `updateBrace`
    - [ ] `removeBrace`
  - [ ] Ensure brace endpoints participate in recomputation:
    - [ ] update endpoints when host shafts change.
    - [ ] update endpoints when leaf geometry changes.

## Phase 3 — Brace builder (preview + placed must match)
- [ ] Add `braceBuilder.ts`:
  - [ ] Inputs: endpoint A target + endpoint B target (snapped results).
  - [ ] Outputs: Brace entity + preview data needed for rendering.
  - [ ] Compute end diameters:
    - [ ] Shaft target → shaft diameter.
    - [ ] Leaf target → local cone diameter at t.
  - [ ] Enforce same-support constraints:
    - [ ] disallow same segment.
    - [ ] allow same support across different segments only if at least one segment is curved.

## Phase 4 — Brace rendering (real supports)
- [ ] Add `BraceRenderer.tsx`:
  - [x] Render two end knots.
  - [x] Render brace shaft between them.
  - [ ] Implement diameter transition end-to-end (taper) to match different endpoint sizes.
  - [ ] Ensure highlight/selection rules match “decluttered” scheme.

## Phase 5 — Canvas-level snapping + preview controller
- [ ] Add `BracePlacementController.tsx`:
  - [x] Reuse `useSnapping`.
  - [ ] Build snap targets for:
    - [x] all support shaft segments
    - [ ] leaf cone bodies (Leaf-only)
  - [x] Preview follows mouse.
  - [ ] Commit only when snapped to valid target (shaft OR leaf cone).
    - [x] shaft
    - [ ] leaf cone
  - [x] Clicking model/canvas does nothing.
  - [x] Esc cancels.

## Phase 6 — Segment-only highlight behavior for brace snapping
- [ ] Ensure hovering a snap candidate highlights only the **segment**.
- [ ] Ensure leaf hover highlights the leaf, and shows a knot-size preview that updates with cone position.

## Phase 7 — Endpoint sliding / editing
- [ ] Shaft endpoints: reuse existing knot sliding behavior.
- [ ] Leaf endpoints:
  - [ ] add cone-axis sliding behavior.
  - [ ] update endpoint diameter as it slides.

## Phase 8 — Wire Brace into SupportRenderer + interaction manager
- [x] Update `src/supports/SupportRenderer.tsx` to render braces.
- [ ] Update `src/features/supports/useSupportInteractionManager.ts`:
  - [x] Include `useBracePlacement()`.
  - [ ] Route Alt behavior correctly (model click vs support segment click).
- [ ] Update `src/components/scene/SceneCanvas.tsx`:
  - [x] Mount `<BracePlacementController />`.
  - [x] Add ghost preview rendering for brace.

## Phase 9 — History / delete / export integration
- [ ] History:
  - [ ] add brace add/remove/update actions.
- [ ] Delete flow:
  - [ ] brace deletion (and endpoint cleanup).
- [ ] Export:
  - [ ] add brace geometry generation (tapered shaft) to offline export generator.
- [ ] Model linkage:
  - [ ] braces should have a deterministic `modelId` association (and disallow cross-model attachments).

## Phase 10 — Validation / regression checks
- [ ] Branch placement still works (Alt+click model).
- [ ] Brace placement works (Alt+click support segment):
  - [ ] preview follows mouse.
  - [ ] second endpoint only commits on valid target.
  - [ ] Esc cancels.
- [ ] Brace ↔ Brace, Brace ↔ Trunk, Brace ↔ Branch supported (shaft targets).
- [ ] Brace ↔ Leaf cone attachment works:
  - [ ] cannot attach on contact disc.
  - [ ] knot-size preview changes along cone.
  - [ ] endpoint slides along cone after placement.
- [ ] Same-support constraints enforced.
- [ ] Undo/redo works for brace placement and edits.
- [ ] Export produces correct brace geometry and matches viewport.

---

## Notes / Non-goals (for this task)
- Knot merging UI and “too close” rules are out of scope.
- Auto-bracing is out of scope.
- Brace curvature (curved brace shafts) is out of scope for v1.
- Advanced brace UI controls (profiles, max joints) are out of scope unless required to place/select/delete.
