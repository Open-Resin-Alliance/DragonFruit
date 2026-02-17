# LYS Support Import Stabilization Development Plan

## Overview
The goal is to make LYS support imports match Lychee reliably, starting with predictable trunk placement and then restoring correct branch/twig/leaf attachment and tip positions.

The immediate problem is inconsistency: some changes improved one part while breaking another. This plan changes that by using a strict, measurable process:
1. lock the trunk baseline,
2. capture diagnostics from one controlled import,
3. identify the first exact mismatch stage,
4. apply one isolated fix,
5. verify and keep or revert.

This avoids broad trial-and-error edits and gives a repeatable path to parity with Lychee.

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [ ] **Phase 1: Stabilize Baseline (Trunks First)**
  - [ ] Freeze current trunk transform behavior (no additional trunk math changes until measured diagnostics are reviewed)
  - [ ] Confirm trunk baseline using the same reference scene (`HW_Talpo_NoBase_01`)

- [ ] **Phase 2: Instrument and Observe**
  - [ ] Add temporary converter diagnostics (single grouped log per support)
  - [ ] Log: source base/tip, inferred parents, endpoint-role decision, transformed endpoints, projected knot, final tip/contact values
  - [ ] Ensure logs are concise and deterministic (no spam)

- [ ] **Phase 3: Controlled Comparison Against Source Data**
  - [ ] Run one import using `HW_Talpo_NoBase_01`
  - [ ] Compare logs against JSON fields (`base`, `tip`, `parentId`, `parentBaseId`, `parentTipId`, `isBaseTip`)
  - [ ] Identify first mismatch stage only (classification vs transform vs attach-role vs projection)

- [ ] **Phase 4: Single-Stage Fix Cycle**
  - [ ] Apply one targeted fix at the confirmed mismatch stage
  - [ ] Re-test with the same scene and screenshot angles
  - [ ] If improved: keep fix
  - [ ] If not improved: revert only that fix and move to next mismatch stage

- [ ] **Phase 5: Cleanup and Hardening**
  - [ ] Remove temporary diagnostics after parity is reached
  - [ ] Add/update focused converter tests for the resolved behavior
  - [ ] Document final transform and endpoint-role rules in comments/docs for future maintenance

## Technical Details
### Relevant Files
- `src/components/lys-import/LysConverter.ts`
- `src/components/lys-import/useLysImport.ts`
- `src/features/scene/useSceneCollectionManager.ts`
- `src/components/lys-import/GhostOverlay.tsx` (debug visualization context)
- `3. LysConversion/HW_Talpo_NoBase_01_Scene.json` (reference source-of-truth data)
- `2. Backup/Backups/v102/src/features/lys-conversion/LysConverter.ts` (legacy baseline behavior)

### Debug Data to Capture per Support
- Support ID and support type classification result
- Raw source endpoints (`base`, `tip`)
- Parent linkage fields (`parentId`, `parentBaseId`, `parentTipId`, `isBaseTip`)
- Endpoint-role choice (which endpoint attached to parent, which endpoint treated as tip)
- Endpoint transform outputs used for geometry creation
- Projection result to host shaft (`parentShaftId`, `t`, `knot position`)
- Final generated cone/tip/socket positions

### Mismatch Decision Gates
- **Gate A (Classification):** Are supports classified into root/branch/brace as expected from JSON relationships?
- **Gate B (Endpoint Role):** Does attach endpoint selection match parent hint semantics?
- **Gate C (Transform):** Are transformed points in the same coordinate space as model placement?
- **Gate D (Projection):** Is projected knot location on the intended host shaft segment?
- **Gate E (Final Tip):** Is final tip/contact position close to expected visual location in Lychee?

### Integration Notes
- Keep trunk baseline deterministic while branch/twig/leaf logic is being refined.
- Do not apply multiple stage fixes in one pass.
- Use the same reference file and screenshot viewpoints for every validation cycle.
- Preserve current parent-link parsing improvements while isolating transform/projection mismatches.
