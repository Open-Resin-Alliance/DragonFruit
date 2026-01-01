# Branch Development Plan

## Purpose
Implement branch supports that place like trunks until committed, then anchor to an existing trunk via a branch-owned joint. This plan consolidates goals and UX rules from SupportTypes.md and our discussion.

## Goals
- Alt to Branch: Holding Alt switches placement to Branch mode.
- Trunk-like preview: Before first click, preview is identical to a trunk placement.
- Two-stage placement:
  1. First click (Alt held): fix the contact cone on the model.
  2. Then the base follows the mouse for snapping.
- Magnetic snapping: Branch base snaps to any trunk under cursor, along its shaft.
- Finalize: Second click places the base at the snapped position.
- Branch-owned joint: Create a joint at the base that belongs to the branch, not the trunk.
- Isolation: Branch joint never changes trunk geometry; trunk remains unaffected.
- Visual distinction: Branch-owned joint uses a distinct color.
- Convert to trunk: Dragging the branch-owned joint to the plate converts the branch into a trunk (rooted base).
- Validation: Respect tip/contact spacing rules and base clearances. Snap only to trunks.

## UX Flow
- Mode: Support mode must be active.
- Hotkey: Alt held → Branch placement mode active; released → Back to trunk placement.
- Hover preview: Shows standard trunk preview (contact + base) until first click.
- First click: Places contact cone on model (validates tip spacing first).
- Base-follow: Base position follows mouse world-space; magnetic snap hint shown on target trunk.
- Dynamic snap switching: While in base-follow, the snap target can change freely as the mouse moves over different trunks (not locked until final click), mirroring J-mode joint creation.
- Snap confirm: Within snap distance, show snapped base and highlight target trunk.
- Second click: Commit base, create branch + joint.
- Escape/Right-click: Cancel base-follow and revert to pre-click state.

## Snapping
- Targets: Only trunks (supports whose base is rooted to plate/raft).
- Segment projection: Project mouse to nearest point along trunk shaft segment chain.
- Thresholds:
  - Snap distance: 5.0 mm (configurable).
  - Snap break: 0.5 mm.
- Preview: Ghost base + dashed line from contact to snap point; trunk highlight on hover.
- Switching behavior:
  - Continuously evaluate nearest valid trunk within snap distance; if a different trunk becomes nearer, switch the snap target and preview.
  - No commit occurs until the user clicks; moving the mouse away breaks snap (using break threshold) and allows re-snap to another trunk.

## Data Model
- SupportInstance
  - parentBaseId: string | null (trunk ID the branch base attaches to).
  - settings: unchanged; branches share same geometry schema as trunks.
  - joints?: SupportJoint[] (branch can own joints).
- SupportJoint
  - id: string
  - position: Vec3
  - ballDiameterMm: number
  - order: number
  - ownerSupportId: string (branch ID)
  - isBranchBaseJoint: boolean (true)
- Flags
  - isTrunk: derived: objectIdBase === plate OR parentBaseId === null AND base.z ≈ 0
  - isBranch: derived: parentBaseId !== null

## Validation
- Tip/contact spacing: use surface-to-surface check vs. existing supports.
- Base clearance: min 0.1 mm between support surfaces when snapping to trunk.
- Trunk-only snap: Do not allow base to snap to branches, leaves, twigs, or braces (Phase 1).
- Length sanity: min branch length (> tip length + neck height) to avoid degenerate geometry.

## Visuals
- Branch joint color: distinct (e.g., cyan) and consistent in scene + gizmo.
- Snap preview: highlight target trunk; render snapped base marker.
- Selection: selecting branch shows its joints and segments; trunk remains unmodified.

## Editing & Conversion
- Move branch-owned joint:
  - Along trunk: re-snap to a new position.
  - To plate: becomes a trunk (clear parentBaseId; set base.z ≈ 0; toggle derived isTrunk).
  - Off-target: if outside snap distance, show invalid state and block commit.

## Keyboard/Inputs
- Alt: branch placement mode (hold).
- Esc/Right-click: cancel base-follow stage.

## Telemetry & Undo/Redo
- Record actions:
  - BRANCH_CONTACT_PLACED
  - BRANCH_BASE_SNAPPED
  - BRANCH_CREATED
  - BRANCH_CONVERTED_TO_TRUNK
- Add undo steps for each stage.

## Acceptance Criteria
- Holding Alt produces a two-stage branch placement; without Alt, trunk placement is unchanged.
- Base snaps only to trunks within threshold and respects min clearances.
- Branch-owned joint is created at snap and never alters trunk geometry.
- Visuals clearly distinguish branch-owned joint and snap states.
- Branch can be converted to a trunk by dragging its joint to the plate.

## Phasing
- Phase 1: Hotkey + two-stage placement + snapping + branch-owned joint.
- Phase 2: Visual polish (colors, dashed line, highlights) + validation toasts.
- Phase 3: Edit/convert interactions + persistence + undo/redo entries.
