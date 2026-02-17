# LYS Stick Import Development Plan (Handoff)

## Overview
This plan is for the next coding agent to add **Lychee -> Dragonfruit Stick import** safely, without mixing in unrelated cleanup.

Why this matters:
- We now have a Lychee support case that is **not rooted to the plate**.
- It has **model contact on both ends** (dual-tip behavior), which matches Dragonfruit's Stick anatomy.
- If we keep treating parentless supports as roots/trunks, this case imports incorrectly.

Plain-language target result:
- A Lychee "stick-like" support should import as a Dragonfruit **Stick**.
- It should appear as a floating dual-contact support (no root pad, no host knot attachment).
- Both contact tips should preserve endpoint intent (position, axis/normal, and diameters) from the Lychee data.

Reference inputs used for planning:
- `1. Documentation/LogicBible/AnatomyOfSupports/Stick.md`
- `3. LysConversion/HW_Talpo_NoBase_01_Scene.json` (single-support scene)
- User-provided screenshot of the stick support shape

---

## Development Checklist
> **Agent Note:** Update this checklist as work completes. Keep fixes isolated per phase.

- [ ] **Phase 1: Confirm Source Signature (No Behavior Changes Yet)**
  - [ ] Inspect the single-support JSON and document exact support signature for this case (no parents, dual endpoint normals, no floor root behavior).
  - [ ] Capture the expected visual/anatomy constraints from Stick documentation (no knot parents, no root).
  - [ ] Write down strict acceptance criteria before coding (so we avoid overfitting).

- [ ] **Phase 2: Add Stick Classification Path in `LysConverter`**
  - [ ] Add a dedicated "stick candidate" bucket during support categorization.
  - [ ] Keep existing root/branch/leaf/brace behavior unchanged for known passing cases.
  - [ ] Add decision gates so parentless supports are not automatically treated as roots when they match stick signature.

- [ ] **Phase 3: Build Stick Geometry from Lychee Endpoints**
  - [ ] Generate a Dragonfruit `Stick` entity (not `Trunk`/`Branch`/`Leaf`).
  - [ ] Create contact cone A and B from Lychee endpoint data (base/tip + endpoint normals).
  - [ ] Map endpoint diameters per endpoint role (contact A vs contact B), with explicit fallback order.
  - [ ] Create stick segments/joints in a deterministic order.
  - [ ] Ensure no root entity and no knot links are created for stick supports.

- [ ] **Phase 4: Transform/Placement Pipeline Integration**
  - [ ] Ensure object Stage A transforms apply to both stick endpoints.
  - [ ] Ensure Stage B world XY placement also updates sticks.
  - [ ] Ensure post-import Z offset logic shifts sticks consistently with other imported supports.
  - [ ] Ensure modelId reassignment covers sticks (for parity with other support categories).

- [ ] **Phase 5: Regression Tests**
  - [ ] Add a converter test using the one-support stick JSON fixture.
  - [ ] Assert: 1 stick imported, 0 roots/trunks/branches/leaves/braces/knots for that fixture.
  - [ ] Assert both contact cones exist and preserve expected endpoint diameter mapping.
  - [ ] Assert transform placement (XY + Z) is applied to stick entities.
  - [ ] Keep existing leaf/brace tests green.

- [ ] **Phase 6: Validation + Handoff Notes**
  - [ ] Validate visually against the screenshot angle(s).
  - [ ] Remove temporary diagnostics.
  - [ ] Add short implementation notes for the next remaining support type(s).

---

## Technical Details

### Current State Snapshot (Important)
- Dragonfruit already has a `Stick` support type and renderer.
- Store loading path already supports `sticks` in import payload.
- Current Lychee converter path only constructs: roots, trunks, branches, leaves, braces, knots.
- Current categorization logic treats all `parentId.length === 0` supports as root candidates, which is the core mismatch for this stick case.

### Observed Signature in the Single-Support JSON
From `HW_Talpo_NoBase_01_Scene.json`:
- Exactly one support (`s28074`)
- `parentId: []`, `parentBaseId: null`, `parentTipId: null`
- Both `tipNormal` and `baseNormal` are present
- Endpoints are not floor-like root anchors (floating model-contact behavior)
- `mini: false`, `type: 1`, `isBaseTip: true`

This looks like a dual-contact support and should be evaluated as a stick candidate before root synthesis.

### Proposed Classification Rule (Initial)
Use a dedicated stick detection helper in converter with conservative gating:
1. No parents (`parentId` empty + no parentBase/parentTip)
2. Has both endpoint normals (`tipNormal` and `baseNormal`)
3. Endpoint geometry indicates model-to-model span (not plate-root shape)
4. Exclude `mini` supports from stick path

Important: keep this rule conservative so current root imports do not regress.

### Proposed Endpoint Mapping Rules for Stick
For each endpoint independently:
- Endpoint position: transformed Lychee endpoint (`base` or `tip`)
- Endpoint axis/normal: transformed `baseNormal` / `tipNormal`
- Endpoint contact diameter: endpoint `pointDiameter` when available
- Endpoint body diameter: endpoint `diameter` fallback
- Final fallback: existing app defaults

If endpoint-specific settings are asymmetric (`tip` vs `baseTip`), preserve that asymmetry.

### Integration Points (Expected Edits)
- `src/components/lys-import/LysConverter.ts`
  - add stick candidate detection + creation path
  - include `sticks` in conversion result payload
  - include stick geometry in Stage B XY placement helper
  - include sticks in modelId reassignment helper
- `src/components/lys-import/useLysImport.ts`
  - include sticks in support Z-offset pass
- `src/components/lys-import/LysConverter.test.ts`
  - add focused stick conversion regression tests

### Validation Gates
- **Gate A (Classification):** single-support fixture becomes stick, not root/trunk
- **Gate B (Anatomy):** no roots/knots generated for stick fixture
- **Gate C (Diameter):** both contact ends follow Lychee endpoint fields correctly
- **Gate D (Transform):** placement and offsets match imported model transform behavior
- **Gate E (Regression):** existing branch/leaf/brace expectations remain unchanged

### Out of Scope for This Pass
- Refactoring legacy/manual stick creation behavior outside LYS import
- Solving the separate staged-transform pre-existing failing test unless directly required for stick correctness
- Implementing the other remaining support type(s)

---

## Handoff Prompt for Next Agent
Implement the checklist in order, one phase at a time. Keep edits minimal and isolated. Do not bundle unrelated refactors. Prioritize:
1) correct stick classification,
2) correct dual-contact geometry and diameters,
3) full transform integration,
4) regression coverage.
