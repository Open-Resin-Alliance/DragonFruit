# BranchSupports Module

Purpose: Implement branch supports with safe, modular code paths guarded by a feature flag.

Key behaviors (Phase 1):
- Alt to Branch (hold Alt).
- Two-stage placement: click contact on model → base follows mouse → snap to trunk → finalize.
- Magnetic snapping to trunks only; dynamic snap switching until click.
- Create branch-owned joint at base (distinct color). Trunk geometry not modified.

Structure:
- constants.ts, types.ts, featureFlag.ts
- placement/: controller, hotkeys, preview, base-follow
- snapping/: snapToTrunk, snapConfig
- joints/: jointFactory, jointColors, jointGuards
- validation/: tipPlacement, baseClearance, trunkOnlySnap
- rendering/: BranchPreview.tsx, BranchJointGizmo.tsx

Integration (guarded):
- page.tsx: hotkeys + placement controller hookup
- SceneCanvas.tsx: preview + snapping visuals

See Scratch/BranchDevelopmentPlan.md for acceptance criteria and phasing.
