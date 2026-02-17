# LYS Importer One-Pass Recovery Development Plan

## Overview
We are rebuilding the Lychee (`.lys`) support import logic so it works in one clean pass and does not break model orientation or support placement.

The core idea is to separate two concerns with a locked transform order:

1. **Support reconstruction (model-private prep + generation)**
   - Use `formerCenter` as the pivot for model-local interpretation.
   - Before generating supports, apply model **Z position**, **all rotation**, and **all scale** in the model-private frame.
   - Then build support geometry from Lychee support fields that are stored relative to the model.
   - This includes support endpoints, knee/shaft lengths, and tip orientation vectors.

2. **Model placement (world-space)**
   - After supports are generated and grouped to the model, apply world **X/Y position** as final placement behavior.
   - Do not apply world X/Y during support creation math.

This is required because testing confirmed that moving a model on the plate changes object world position fields, while support geometry payloads remain unchanged. If we blend these layers incorrectly, supports drift away and model orientation appears wrong.

### What we know for certain (from collected data)
- Moving model in Lychee world changes `objects.present.byId.<id>.position` (x/y), while support geometry fields remain invariant.
- Support records (`base`, `tip`, `tipNormal`, lengths) are serialized in a model-relative frame.
- `formerCenter` is the validated pivot for model-local interpretation.
- Support base Z has special plate/floor anchoring behavior in our importer path.
- Over-applying center/rotation transform directly to support points caused a regression (model/support misalignment), so transform policy must be staged and verified.

### Workflow we will follow
1. Freeze a known-good baseline import behavior.
2. Add a feature-flagged transform pipeline (no hard switch).
3. Validate each transform stage with controlled A/B Lychee exports.
4. Promote only verified behavior to default.
5. Keep rollback path available until all checks pass.

## Development Checklist
> **Agent Note:** Update this checklist after completing each step.

- [ ] **Phase 0: Safety + Baseline Lock**
  - [ ] Record current stable behavior with a baseline import sample and screenshot reference.
  - [ ] Add a temporary importer mode flag: `legacy_raw_plus_position` vs `experimental_model_local`.
  - [ ] Confirm legacy mode still imports model orientation and support proximity correctly.

- [ ] **Phase 1: Object/Support Ownership Mapping (Multi-Model Ready)**
  - [ ] Stop assuming one target object (`o15` or first only).
  - [ ] Build object map from `objects.present.byId`.
  - [ ] Group supports by `objectIdTip`/`objectIdBase` ownership.
  - [ ] Define deterministic handling for mixed/missing ownership fields.

- [ ] **Phase 2: Model-Local Support Reconstruction**
  - [ ] In model-private space, apply: `formerCenter` pivot + object `position.z` + full `rotation` + full `scale`.
  - [ ] Defer object `position.x` and `position.y` until final world placement.
  - [ ] Reconstruct support geometry from model-relative support fields only:
    - [ ] `base`
    - [ ] `tip`
    - [ ] `tipNormal`
    - [ ] `settings.base.joinLength`
    - [ ] `settings.tip.length` and tip dimensions
  - [ ] Keep base Z floor anchoring behavior consistent with current known-good root behavior.
  - [ ] Do not inject world `position.x` / `position.y` into support construction math in this phase.

- [ ] **Phase 3: Pivot/Center Policy**
  - [ ] Pivot selection rule: `formerCenter` first (validated).
  - [ ] Legacy fallback only if `formerCenter` is missing: use `center`, else zero.
  - [ ] Use pivot in model-local interpretation only where experimentally validated.
  - [ ] Keep explicit logs for pivot source per object during import.

- [ ] **Phase 4: World Placement Application**
  - [ ] Apply object world placement as a separate step to the model entity (and attached supports) per object:
    - [ ] `position.x`
    - [ ] `position.y`
  - [ ] Confirm `position.z`, `rotation`, and `scale` were already applied before support generation.
  - [ ] Ensure this step does not recompute support geometry; placement only.

- [ ] **Phase 5: Validation Matrix (Required Before Merge)**
  - [ ] **Test A (world move only):** support local geometry must remain identical; world placement changes only.
  - [ ] **Test B (rotation only):** support orientation should remain coherent relative to model.
  - [ ] **Test C (tip moved only):** only support-local tip-related fields should change.
  - [ ] **Test D (multi-model scene):** each model imports only its own supports at correct placement.
  - [ ] **Test E (regression):** legacy sample still imports with no model-orientation break.

- [ ] **Phase 6: Promote + Cleanup**
  - [ ] Promote experimental path to default only if all matrix tests pass.
  - [ ] Keep legacy mode callable for one release window as fallback.
  - [ ] Remove noisy diagnostic logs; retain concise failure diagnostics.
  - [ ] Update docs in `Scratch/LYS_Import_Coordinate_Findings.md` and baseline logs.

## Technical Details

### Relevant Files
- `src/components/lys-import/LysConverter.ts`
  - Primary conversion pipeline, support transform strategy, root/trunk construction.
- `src/components/lys-import/useLycheeImport.ts`
  - JSON intake, object transform extraction, import orchestration.
- `Scratch/LYS_Import_Coordinate_Findings.md`
  - Current empirical findings and confidence levels.
- `Scratch/LYS_TipCone_Baseline_V1.md`
  - Versioned experiment log with support field diffs.

### Current Known Risk Areas
- Single-object targeting assumptions can mis-handle multi-model scenes.
- Mixing support creation and world placement in one transform function leads to double-application errors.
- Applying center/rotation blindly to support points can misalign model and supports.

### Proposed Data/Logic Structure
- **Per-object import context**
  - Object ID
  - Pivot source (`center` | `formerCenter` | fallback)
  - Pre-support transform inputs (`formerCenter`, `position.z`, `rotation`, `scale`)
  - Final world placement input (`position.x`, `position.y`)
  - Owned support IDs

- **Two-stage conversion contract**
  1. `prepareModelPrivateFrameAndBuildSupports(objectContext, supportsForObject)`
     - Applies `formerCenter` + `position.z` + `rotation` + `scale`, then reconstructs supports.
  2. `applyWorldXYPlacementToEntity(objectContext, modelAndSupportsEntity)`
     - Applies `position.x` + `position.y` only.

- **Ownership routing**
  - Primary key: `objectIdTip`/`objectIdBase`
  - If missing/inconsistent: route by explicit fallback policy and emit warning log.

### Integration Points
- Conversion output remains Dragonfruit support schema (roots/trunks/branches/etc.).
- No STL mesh transform mutation during support generation phase.
- Placement transform policy is locked: pre-support (`position.z` + `rotation` + `scale`), final placement (`position.x` + `position.y`).

### Completion Criteria (Definition of Done)
- All validation matrix tests pass.
- No orientation regression.
- No support drift from model in world-move or rotate-only scenarios.
- Multi-model `.lys` imports are grouped and placed correctly.
- Findings and behavior are documented and reproducible.
