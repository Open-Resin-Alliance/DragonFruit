# Leaf Support (Alt+Shift) — Development Plan + Checklist

## Purpose
Add a new **Leaf** support type to the V2 supports system.

A Leaf is a **minimal support** that connects **model → support** using:
- A **contact tip** at the model (uses the existing tip profile behavior, including the contact disk behavior).
- A **knot** (anchor) that snaps to and slides along an existing support shaft.

A Leaf has:
- No trunk/roots.
- No shaft segments.
- No joints.
- No “socket joint” at the base of the tip (the key difference vs the existing `ContactCone` primitive concept).

## Hard Requirements (Source-of-truth constraints)
- **Placement hotkey**: Hold **Ctrl + Alt**.
- **Host shaft diameter matching**: The Leaf’s support-side “base” must match the **host shaft diameter** (not the tip profile’s body diameter).
- **UX parity**: Leaf placement UX should be **nearly identical to Branch placement UX**:
  - Same green dot marker.
  - Same ghosted preview style (via the same preview rendering pipeline).
  - Same “preview follows mouse” behavior.
  - Same snapping-to-shaft behavior.

## Current System Facts (what exists today)
### Existing hotkey system
- File: `src/hotkeys/hotkeyConfig.ts`
- Branch uses `DEFAULT_KEYBINDINGS.SUPPORTS.BRANCH_PLACEMENT.key` (currently `Alt`).

### Existing Branch placement pipeline (to mirror)
- **Hotkey + first click (model tip)**:
  - `src/supports/SupportTypes/Branch/useBranchPlacement.ts`
  - `src/supports/SupportTypes/Branch/branchPlacementState.ts`
- **Snapping + continuous preview updates (Canvas-level)**:
  - `src/supports/SupportTypes/Branch/BranchPlacementController.tsx`
- **Green dot marker + ghosted preview rendering**:
  - `src/components/scene/SceneCanvas.tsx`
  - Branch preview uses `SupportBuilder` with `isPreview`.

### Current preview renderer
- `src/supports/rendering/SupportBuilder.tsx`
- It renders:
  - Roots (optional)
  - Segments (shafts) + joints (optional)
  - Contact cone (optional)

### Important type constraint discovered
- `ContactCone` type currently requires `socketJointId` (`src/supports/SupportPrimitives/ContactCone/types.ts`).
- Leaf needs “contact tip geometry” but **must not** terminate in a socket joint.

## Key Design Decisions (locked)
- **Alt** = Branch placement.
- **Ctrl+Alt** = Leaf placement.

## Implementation Strategy (high-level)
1. Add Leaf hotkey to the central hotkey config.
2. Introduce Leaf placement state + controller by mirroring the Branch pattern.
3. Add Leaf entity type to supports state/types + import/export.
4. Implement Leaf builder + renderer.
5. Wire Leaf placement previews (green dot + ghosted preview) into `SceneCanvas` similarly to Branch.
6. Ensure selection/interaction doesn’t break existing supports.

---

# Development Checklist (step-by-step)

## Phase 0 — Guardrails / sanity checks
- [x] Confirm Branch must not activate when Shift is held (Alt+Shift reserved for Leaf).
- [ ] Confirm no other tool uses Alt+Shift.

## Phase 1 — Hotkey configuration
- [x] Update `src/hotkeys/hotkeyConfig.ts`:
  - [x] Add `DEFAULT_KEYBINDINGS.SUPPORTS.LEAF_PLACEMENT` with **Alt+Shift**.
  - [x] Keep existing Branch binding as Alt.
- [x] Update Branch hotkey handling (`useBranchPlacement.ts`) so it ignores activation when Shift is held.

## Phase 2 — Create Leaf SupportType folder (domain structure)
- [x] Create folder: `src/supports/SupportTypes/Leaf/`
- [x] Add Leaf placement state store:
  - [x] `leafPlacementState.ts` (mirror `branchPlacementState.ts`, but track **alt+shift active**).
- [x] Add Leaf placement hook:
  - [x] `useLeafPlacement.ts` (mirror `useBranchPlacement.ts`, but uses Leaf hotkey).

## Phase 3 — Canvas-level snapping + preview (mirror Branch controller)
- [x] Add `LeafPlacementController.tsx`:
  - [x] Reuse the same snap target construction logic as Branch (targets from trunk + branch segments).
  - [x] Reuse `useSnapping`.
  - [x] Maintain the same “preview follows mouse” loop.
  - [x] Only allow commit when snapped to a shaft.
  - [x] Store `t` (where available) for stable knot-on-segment positioning.

## Phase 4 — Leaf data model + store integration
- [x] Update `src/supports/types.ts`:
  - [x] Add `Leaf` interface.
  - [x] Add `leaves` collection to `SupportState`.
  - [x] Add `leaves: Leaf[]` to `DragonfruitImportFormat`.
- [x] Update `src/supports/state.ts`:
  - [x] Add store collection `leaves: {}` to initial state.
  - [x] Add actions `addLeaf`, `updateLeaf` (as needed).
  - [x] Add import/load support for leaves in `loadFromLychee`.
  - [x] Update selection category logic so leaf selection works.

## Phase 5 — Contact tip representation change (to support “knot instead of socket joint”)
- [x] Update `src/supports/SupportPrimitives/ContactCone/types.ts`:
  - [x] Make `socketJointId` optional OR introduce a Leaf-specific tip type.
  - [x] Ensure existing trunk/branch code still compiles and behavior doesn’t change.

## Phase 6 — Leaf builder
- [x] Add `leafBuilder.ts`:
  - Inputs:
    - [x] model tip position + smoothed normal
    - [x] snapped knot position + host segment id
    - [x] host shaft diameter (or derive from segment)
  - Outputs:
    - [x] Leaf entity
    - [x] preview `SupportData`-like structure (or LeafPreviewData if needed)
  - Rules:
    - [x] Tip uses the existing disk-based tip behavior.
    - [x] Leaf base diameter matches host shaft diameter.

## Phase 7 — Leaf renderer (real supports)
- [x] Add `LeafRenderer.tsx`:
  - [x] Renders the model-side contact tip.
  - [x] Renders the knot at the support-side.
  - [x] Renders the connecting cone/body between them.
  - [x] Ensure it does not rely on a socket joint.

## Phase 8 — Wire Leaf into SupportRenderer
- [x] Update `src/supports/SupportRenderer.tsx`:
  - [x] Render leaves from store similarly to trunks/branches.

## Phase 9 — Wire Leaf into interaction manager + SceneCanvas preview UI
- [x] Update `src/features/supports/useSupportInteractionManager.ts`:
  - [x] Include `useLeafPlacement()`.
  - [x] Route model hover/click to trunk vs branch vs leaf correctly.
- [x] Update `src/components/scene/SceneCanvas.tsx`:
  - [x] Add Leaf hover green dot (same style and sizing).
  - [x] Add Leaf tip marker (same style).
  - [x] Add Leaf ghost preview rendering (same ghosted style).
  - [x] Mount `<LeafPlacementController />` (like BranchPlacementController).

## Phase 10 — Validation / regression checks
- [ ] Trunk placement still works (preview + commit).
- [ ] Branch placement still works (Alt only) and does not activate on Alt+Shift.
- [ ] Leaf placement works (Alt+Shift) and shows:
  - [ ] hover dot
  - [ ] tip marker
  - [ ] snapped preview
  - [ ] commit on snapped shaft
- [ ] Leaf renders after commit and persists in store.
- [ ] Export/import format includes leaves without breaking older files.

---

## Notes / Non-goals (for this task)
- Brace/Twig/Stick implementation is out of scope.
- Auto-placement/auto-bracing is out of scope.
- Advanced Leaf editing UI is out of scope unless it’s required to place/select/delete.
