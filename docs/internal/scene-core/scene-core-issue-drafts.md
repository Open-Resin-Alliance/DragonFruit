# Scene core: draft issues

Drafts only, one per command group, from the scene core map (dev @ 5d31502c (2026-10-21)). Nothing here has been
opened. Each follows ADR-0045: pin behaviour first, move the rule, manager and CLI call the same
function, parity test as done.

## 1. scene-core: pin the CLI save round trip and the suspected bugs before extracting

**Labels (suggested):** `scene-core` · **Effort:** S–M · **Risk:** Med · **Depends on:** —

### Scope

Add a full round-trip test for the CLI save (every field and chunk, not just plates). Add pinning tests for B1–B5, B7, B8. Move the snapshot registry into scene/history/. No behaviour change except where a test proves a CLI data loss and a fix is agreed.

### Pure functions and work items (draft)

- (test) voxlRoundTrip: app-written scene → CLI load → CLI save → compare every field and mesh chunk
- `move sceneSnapshotRegistry + storeSceneSnapshotPair to scene/history/sceneSnapshotRegistry.ts (already React-free)`
- (tests) one failing-or-passing test per suspected bug in the Bugs sheet, marked as 'pins current behaviour'

### Tests (land first)

- App-written multi-plate scene with duplicate meshes, originals, every support type, link groups → CLI load → transform-model no-op → save → deep compare (fields + chunks).
- Snapshot registry: eviction at 200 pairs / ~300 MB, evicted key → entry discarded (characterise as-is).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`scene-snapshot-registry` (281-300, 345-351, 508-578), `capture-scene-snapshot` (302-348, 353-359, 370-377, 441-470), `clone-mesh-modifiers` (389-418), `store-scene-snapshot-pair` (508-577 (outside range; called by pushSceneSnapshotHistory)), `get-scene-snapshot-registry-bytes` (553-555), `scene-data-types` (1063-1102, 1125-1131, 1307-1319), `core-scene-state` (1472-1474, 1580-1592), `apply-scene-snapshot` (2281-2341), `scene-snapshot-history-handler` (2343-2360), `push-scene-snapshot-history` (2362-2369), `return-object-surface` (8113-8288), `history-jump` (page.tsx:6461-6499)

### Decisions needed

- D4: Is selection part of the core?
- D15: Should transform history become a pure 'edit session'?
- D16: Which undo gaps are bugs vs by design?
- D18: Delete dead API before extracting?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 2. scene-core: plates phase 2 — frames everywhere, relaidPlateShifts, plate plans

**Labels (suggested):** `scene-core` · **Effort:** M · **Risk:** Med · **Depends on:** foundation; D10 for origin/ordering

### Scope

Replace the ~9 hand-computed plate rects with computePlateFrames. Extract modelsShiftedForRelaidPlates as relaidPlateShifts. Add planAddPlates / planRemovePlate / planEmptyScenePlates. Convert resolveModelPlateId to one params object (D21). Optional CLI: scene add-plate / remove-plate / rename-plate / move-to-plate; scene slice reads meta.printer.

### Pure functions and work items (draft)

- `relaidPlateShifts({ models, from: { plates, footprint, ordering }, to: {...} }) → { modelId, dxMm, dyMm }[]`
- `planAddPlates({ plates, count, footprint, ordering, models }) → { plates, shifts }`
- `planRemovePlate({ plates, plateId, models }) → { plates, removeModelIds, nextActivePlateId } | { refused }`
- `planEmptyScenePlates({ plates }) → plates (the 'scene became empty' rule now inside deleteModels)`
- `resolveModelPlateId({ model, frames }) — convert to one params object (ADR rule 4)`

### Tests (land first)

- computePlateFrames vs every hand-computed rect site (defaultImportCenterXY, activePlateRect, plateOffsetFor, addPlates, moveModelsToPlate, seatModelOnNewBedIfNeeded, VOXL load) for both origin modes and both orderings.
- modelsShiftedForRelaidPlates golden cases: printer switch, ordering switch, add/remove plate; supports shifted with models (pins B5).
- removePlate refuses first plate; dropPlates currently allows it (pin as-is).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`shift-supports-with-models` (493-500), `plates-state` (1475-1493, 1522-1523), `plate-name` (1494-1502), `plate-lock` (1503-1520), `model-plate-id` (1524-1538), `plate-lock-guards` (1539-1554), `locked-plate-notice` (1555-1570, 1589), `clear-empty-plate-name` (1571-1579), `printer-profile-subscription` (1869-1870), `multi-plate-ordering` (1871-1888), `voxl-printer-bundle` (1912-1923), `active-plate-rect` (2030-2046), `voxl-load-printer-relayout` (6646-6668), `plate-offset-for` (7580-7587), `plate-forward-refs` (7596-7602 (+ assignment 7917)), `models-shifted-for-relaid-plates` (7622-7678), `relay-on-printer-switch` (7688-7762), `relay-on-ordering-change` (7774-7793), `add-plate` (7795-7832), `drop-plates` (7847-7870), `add-plates` (7886-7917), `activate-plate` (7919-7932), `plate-frames` (7940-7945), `resolve-model-plate-id` (7948-7951), `model-plate-frame` (7954-7957), `rename-plate` (7959-7961), `remove-plate` (7968-8020), `delete-models-and-extra-plates` (8034-8075), `move-models-to-plate` (8082-8111), `active-plate-name-and-lock` (8117-8118, 8138-8141 (defined 1497-1545)), `plate-state-passthrough` (8119-8131 (state declared 1480-1490, 1883-1888)), `active-plate-model-ids (page.tsx:828-834), sc-plate-scenery (SceneCanvas.tsx:1094-1109, SceneCanvas.tsx:1710-1736), slice-run-plate-scope (page.tsx:2667-2887), printing-scrub-preview-models (page.tsx:2920-2934), sc-next-plate-frame-ghost-drop (SceneCanvas.tsx:1741-1757, SceneCanvas.tsx:6102-6214), plate-widget-passthroughs` (page.tsx:10827-10851)

### Decisions needed

- D3: Are plate locks core or UI?
- D4: Is selection part of the core?
- D10: Who owns plate ordering and origin mode?
- D21: Bring plateLayout.ts fully in line with ADR rule 4?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 3. scene-core: model field rules (rename, visibility, colour, designation, link)

**Labels (suggested):** `scene-core` · **Effort:** S each · **Risk:** Low/Med · **Depends on:** foundation

### Scope

Pure renameModels, setModelsVisible, setModelsColor, setSupportDesignation, linkModels, unlinkModels; manager calls them; matching CLI commands with parity tests. Can be split into 2–3 PRs.

### Pure functions and work items (draft)

- `renameModels({ models, modelId, name }) → models`
- `setModelsVisible({ models, modelIds, visible }) → models`
- `setModelsColor({ models, modelIds, color }) → models (split from the viewer preference)`
- `setSupportDesignation({ models, modelIds, isSupport }) → models  (changes slicing → check:scene-slice case)`
- `linkModels({ models, modelIds }) / unlinkModels({ models, modelIds }) → models`

### Tests (land first)

- Each setter: input models + ids → output models; history label unchanged (DOM test reads the label).
- Support designation: check:scene-slice case where a designated model changes the sliced output.
- Replace voxlSupportDesignation.test.ts's inline copy with a call to the real function.
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`set-model-visibility` (4082-4094), `rename-model` (4166-4178), `set-mesh-color` (7088-7104), `set-mesh-visible` (7106-7110), `toggle-support-designation` (7112-7135), `link-models` (7137-7161), `unlink-models` (7163-7199), `grouping-rename-passthrough` (page.tsx:5657-5679)

### Decisions needed

- D4: Is selection part of the core?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 4. scene-core: one grouping model for app and CLI

**Labels (suggested):** `scene-core` · **Effort:** S · **Risk:** Med · **Depends on:** D5

### Scope

After D5, store groups in one place, make CLI group/ungroup/list-groups call modelGroupingHistory, extract renameGroup and modelIdsInGroup.

### Pure functions and work items (draft)

- `applyModelGrouping (exists) — make CLI group/ungroup call it`
- `renameGroup({ models, groupId, name }) → models`
- `modelIdsInGroup({ models, groupId }) → ids  (today selectGroup does this inline)`

### Tests (land first)

- After D5: group in app → save → CLI list-groups shows it, and the reverse.
- modelGroupingHistory existing tests stay green.
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`group-models` (4180-4203), `list-groups` (4180-4241), `ungroup-models` (4205-4222), `ungroup-group` (4224-4241), `rename-group` (4712-4729)

### Decisions needed

- D4: Is selection part of the core?
- D5: Where do groups live in the file?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 5. scene-core: buildVoxlSaveInput shared by every saver

**Labels (suggested):** `scene-core` · **Effort:** M · **Risk:** High · **Depends on:** foundation; D9

### Scope

One pure builder used by autosave, Ctrl+S, export panel and CLI toBuildInput, with an explicit scope. Fixes CLI ORIG/sha passthrough if B2 is confirmed.

### Pure functions and work items (draft)

- `buildVoxlSaveInput({ models, supports, plates, activePlateId, printer, plateOrdering, scope }) → BuildVoxlDocumentInput`

### Tests (land first)

- Four savers (autosave, Ctrl+S, export panel, CLI) given the same scene produce the same BuildVoxlDocumentInput, except for documented scope differences.
- Hidden model + Ctrl+S (pins B3).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`chunk-store-bake` (1331-1398), `voxl-format-chunked-ref` (1584-1588), `chunk-store-sweep-effect` (1594-1601), `save-cli-tobuildinput (dragonfruit-ts-cli.ts:85-114), save-export-panel (ExportPanel.tsx:335-490 (VOXL context at 380-395 and 458-463)), save-autosave (useSceneAutosave.ts:501-712), save-export-scene-dispatch (ExportManager.ts:893-1082), save-export-voxl (ExportManager.ts:1120-1454), scene-autosave-wiring (page.tsx:1194-1221), save-baseline-dirty (page.tsx:1770-1801), slice-thumbnail-per-plate (page.tsx:2944-2950), before-slice-start (page.tsx:4135-4269), save-topbar-ctrl-s (page.tsx:4557-4654), top-bar-save-scene (page.tsx:4557-4654), save-path-resolution (page.tsx:4726-4889), empty-scene-reset (page.tsx:4891-4910), autosave-recovery-discovery` (page.tsx:4925-4980)

### Decisions needed

- D4: Is selection part of the core?
- D8: Should opening a VOXL change it, and does open merge or replace?
- D9: Is the saved model set 'all' or 'visible'?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 6. scene-core: planDeleteModels and the support cascade

**Labels (suggested):** `scene-core` · **Effort:** M · **Risk:** High · **Depends on:** plates; D13

### Scope

Extract link-dissolve, empty-scene plates and the support cascade compute; CLI remove-model calls them.

### Pure functions and work items (draft)

- `planDeleteModels({ models, plates, modelIds }) → { models, plates, dissolvedLinkGroups }`
- `supportsCascadeForModels({ supports, modelIds }) → { removeIds by collection }  (pure compute half of deleteSupportsForModel)`

### Tests (land first)

- Scene with every support type, a 2-member link group, 2 plates: delete one model → app result == CLI result (supports, link groups, plates).
- Delete last model → plates collapse (app); undo restores modifiers? (pins B14).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`delete-models` (4744-4894), `delete-models-link-dissolve` (4819-4834), `delete-models-empty-scene-plates` (4838-4853), `delete-models-support-cascade` (4861-4879), `delete-model` (4896-4898), `delete-supports-for-models` (4900-4936), `delete-active-model-handler` (7069-7081), `new-scene (page.tsx:5067-5105), select-all-and-delete (page.tsx:9435-9484, page.tsx:9898-9936), clear-or-delete-plate` (page.tsx:10855-10866, page.tsx:11683-11701)

### Decisions needed

- D4: Is selection part of the core?
- D13: Who owns support removal for a model?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 7. scene-core: one out-of-bounds rule and one seat-Z rule

**Labels (suggested):** `scene-core` · **Effort:** M · **Risk:** High · **Depends on:** plates; D11, D12

### Scope

Unify the four out-of-bounds copies and four seat-Z copies; CLI place-on-platform and scene slice use them; check:scene-slice cases.

### Pure functions and work items (draft)

- `modelsOutsideVolume({ models, frames, volume, mode: 'overlap'|'contain', margins?, supportBounds? }) → ids`
- `seatZ({ model, geometryBounds, autoLift, liftDistance }) → z  (wraps selectionLiftDrop.getModelLowestWorldZ)`

### Tests (land first)

- One fixture per out-of-bounds copy (resin estimate, sliceable, warning, SceneCanvas) with models inside, overlapping, outside; record each copy's answer today.
- Seat Z for unrotated/rotated/scaled off-centre mesh: selectionLiftDrop vs performAutoSnap vs SceneCanvas vs CLI place-on-platform (pins B8).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`set-model-manual-z-move-override` (4154-4164), `scene-bounds` (7536-7572), `plate-volume-bounds (page.tsx:806-813), volume-bounds-for-model (page.tsx:819-822), sc-align-live-transform-to-lift (SceneCanvas.tsx:1054-1088), sc-volume-boxes-and-oob (SceneCanvas.tsx:2022-2210), resin-in-bounds-models (page.tsx:3073-3168), scene-z-range (page.tsx:6835-7023), sliceable-models (page.tsx:3128-3157, page.tsx:6840-6851), out-of-bounds-models-page (page.tsx:7406-7482), lift-drop-selection (page.tsx:9191-9224), auto-lift-toggle` (page.tsx:9226-9247)

### Decisions needed

- D4: Is selection part of the core?
- D10: Who owns plate ordering and origin mode?
- D11: One out-of-bounds rule, and should `scene slice` drop models outside the volume?
- D12: Seat Z, Auto Lift and manualZMoveOverride as inputs?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 8. scene-core: free-spot placement and duplicate layout

**Labels (suggested):** `scene-core` · **Effort:** L (split into 3 PRs) · **Risk:** Med · **Depends on:** plates, bounds-seat; D6, D14

### Scope

Extract findFreeSpots (import + paste), layoutDuplicates (page.tsx), deriveModelFrom; plate-aware arrange in CLI; CLI duplicate and add-model --auto-place.

### Pure functions and work items (draft)

- `findFreeSpots({ footprints, frames, blockers, startPlateId, allowNewPlates }) → { positions, newPlateCount }`
- `layoutDuplicates({ source, count, spacing, frames, blockers }) → { transforms, newPlateCount }  (from page.tsx 9500–9790)`
- `deriveModelFrom({ source, id, name, transform }) → model  (one rule for which fields copies keep)`
- `arrange: make computeHighPrecisionArrangeUpdates callers plate-aware (CLI packs everything onto plate 1)`

### Tests (land first)

- Import free-spot, paste, plugin import and duplicate preview: golden positions for fixed footprints/blockers on 1 and 2 plates, including overflow to a new bed.
- Touching-edge overlap behaviour of intersectsRect vs plateFreeSpace.rectsOverlap.
- Derived-model field lists for split, merge, paste, duplicate (what's kept today).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`default-import-center` (2001-2022), `intersects-rect` (2024-2028), `is-rect-inside-plate` (2048-2055), `footprint-for-transform` (2057-2062), `build-mesh-placement-offsets` (2064-2085), `model-footprint-rect` (2087-2103), `is-model-footprint-inside-plate` (2105-2107), `find-free-spot-centers` (2109-2279), `seat-model-on-new-bed` (2762-2793), `import-free-spot-placement` (2936-2940, 2979-2983 (search itself at 2109-2279)), `copy-model` (4938-4965), `clipboard-entry-build` (4944-4962, 4974-4993), `copy-selected-models` (4967-4996), `cut-selected-models` (4998-5000), `cut-model` (5002-5004), `paste-model` (5006-5067), `paste-auto-arrange` (5069-5586), `paste-support-rect` (5091-5179), `paste-place-into-bed` (5181-5365), `duplicate-with-transforms` (5588-5719), `plugin-import-arrange` (6032-6220), `voxl-load-offbed-placement` (6670-6719), `support-aware-arrange-bounds (page.tsx:7496-7797), prepare-hotkeys-arrange-all (page.tsx:7997-8010), duplicate-preview-layout (page.tsx:9500-9790), copy-paste-hotkeys (page.tsx:9938-10004), arrange-plate-button` (page.tsx:10841-10847)

### Decisions needed

- D1: Does THREE count as impure for maths-only use?
- D3: Are plate locks core or UI?
- D4: Is selection part of the core?
- D6: One placement engine or several?
- D14: Which fields does a derived model keep?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 9. scene-core: planModelTransforms

**Labels (suggested):** `scene-core` · **Effort:** L · **Risk:** High · **Depends on:** plates, model-fields; D1, D2, D3, D20

### Scope

One transform planner returning model updates, support deltas, link-peer updates, plate restamp and refusals; both manager entry points call it; CLI transform-model/center-xy call it.

### Pure functions and work items (draft)

- `planModelTransforms({ models, updates: {modelId, transform}[], lockedPlateIds, frames }) → { models, supportDeltas, refused, landedPlateId }`
- `centerOnPlate({ models, modelIds, frame, originMode }) → updates`
- `linkPeerUpdates({ models, leaderId, before, after }) → updates (today written 4 times)`

### Tests (land first)

- updateModelTransform vs updateModelTransforms on the same input: link peers, supports, plateId, landedPlateId, lock refusal — record the drift.
- Link-peer propagation: replace linkGroupTransformPropagation.test.ts's own copy with the manager path.
- center on plate 2 (pins B10), transform tolerance epsilons.
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`transforms-equal` (361-368), `supports-for-models` (483-486, 503-506), `set-model-transform-raw` (3073-3089), `update-model-transform` (3091-3231), `transform-plate-lock-guard` (3111-3122, 3374-3392 (helpers 1540-1572)), `transform-link-peer-propagation` (3164-3193, 3408-3438, 3256-3281), `commit-model-transform-history` (3233-3316), `commit-model-transforms-history` (3318-3358), `update-model-transforms` (3360-3525), `destructive-transform-guard (page.tsx:2384-2503), apply-orientation (page.tsx:2456-2479), sc-multi-selection-transform (SceneCanvas.tsx:2878-2949), history-transform-resync (page.tsx:6031-6087), sc-move-z-lock (SceneCanvas.tsx:7211-7272), mirror-finalize-on-tool-change (page.tsx:7903-7909), history-origin-restore (page.tsx:5948-5993, page.tsx:7915-7932), transform-end (page.tsx:8474-8760), gizmo-group-commit (page.tsx:8833-8919), selection-panel-edits (page.tsx:8921-9027), selection-rotate (page.tsx:9056-9081), selection-transform-commit (page.tsx:9084-9104), selection-scale (page.tsx:9029-9042, page.tsx:9106-9134), selection-reset (page.tsx:9136-9159), selection-move (page.tsx:9044-9054, page.tsx:9161-9169), center-selection (page.tsx:9171-9189), transform-start (page.tsx:9259-9330), pending-transform-history (page.tsx:5774-5939, page.tsx:9332-9366), gizmo-commit (page.tsx:8762-8826, page.tsx:9385-9405), place-on-face` (page.tsx:9792-9804, page.tsx:10349-10356)

### Decisions needed

- D1: Does THREE count as impure for maths-only use?
- D2: What does a transform carry with it?
- D3: Are plate locks core or UI?
- D4: Is selection part of the core?
- D12: Seat Z, Auto Lift and manualZMoveOverride as inputs?
- D15: Should transform history become a pure 'edit session'?
- D20: What does 'center' mean on plate 2?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 10. scene-core: planVoxlOpen and planMeshImport

**Labels (suggested):** `scene-core` · **Effort:** L · **Risk:** High · **Depends on:** plates, placement, save; D7, D8

### Scope

Plan/apply split for VOXL open and mesh import; CLI scene load (and add-model) use the plan.

### Pure functions and work items (draft)

- `planVoxlOpen({ doc, existingIds, printer, ordering, prefs }) → { models, supports, plates, idRemap, needs: ['printer-mismatch'|'off-bed'|...] }`
- `planMeshImport({ entries, frames, activePlateId, blockers }) → placements`
- `sanitizeImportedModelName / remapModelIdsInPayload (already module-level, just move)`

### Tests (land first)

- Open an app-saved VOXL: names, supports (prefs applied), ids on collision, plate shift on printer mismatch, ordering adoption — snapshot the app's result.
- Headless prompt defaults (placement/hollowing/repair).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`sanitize-imported-model-name` (845-858), `helper-name-sanitize` (845-858), `sha256-hex` (860-874), `remap-model-ids-in-payload` (876-898), `helper-support-payload` (876-923), `support-payload-counts` (901-914), `apply-import-defaults-to-raft` (916-923), `normalize-plugin-scene-payload` (925-1057), `helper-normalize-plugin-payload` (1006-1057), `scene-import-placement-prompt` (1168-1175, 1612, 1625, 1745-1750, 1784-1802), `scene-import-hollowing-prompt` (1177-1184, 1615, 1626, 1752-1757, 1804-1823), `merge-cavity-into-shell` (1197-1260), `helper-cavity` (1197-1240), `mesh-repair-confirm-prompt` (1262-1272, 1305, 1616, 1627, 1759-1782), `printer-mismatch` (1287-1303, 1614, 1711-1718 (raised at 6766-6785)), `mesh-scene-extension` (1418-1437), `scene-plugin-import-handlers` (1439-1463), `load-files` (2693-3058), `import-lock-and-extension-filter` (2697-2705 (getMeshExtension at 1418-1424)), `import-progress-and-recent-paths` (2707-2734, 2804-2817, 2997-3017, 3049-3057), `import-prefs-read` (2736-2750), `import-native-repair-options` (2820-2896), `import-build-model-entry` (2898-2996), `import-post-selection` (3020-3032), `import-repair-report` (3034-3047 (rule at 1156-1166)), `on-file-change` (3060-3066), `scene-import-run-options` (5723-5736), `should-auto-repair-scene-imports` (5733-5736), `import-plugin-scene-file` (5738-6286), `plugin-import-hollow-bake` (5794-5849), `plugin-import-apply-supports` (6222-6250), `import-voxl-file` (6288-6868), `voxl-load-header-check` (6307-6319), `voxl-load-mesh-build-dedup` (6359-6462), `voxl-load-model-mapping` (6465-6630), `voxl-load-commit` (6721-6760), `voxl-load-printer-mismatch` (6762-6786), `voxl-load-supports` (6789-6800), `import-scene-file` (6870-6881), `import-scene-files` (6883-6948) …

### Decisions needed

- D4: Is selection part of the core?
- D7: How do imports handle user prompts when headless?
- D8: Should opening a VOXL change it, and does open merge or replace?
- D10: Who owns plate ordering and origin mode?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 11. scene-core: split and merge as data

**Labels (suggested):** `scene-core` · **Effort:** L · **Risk:** High · **Depends on:** transform; D1, D14

### Scope

Triangle-soup split/merge rules without THREE geometry; fix Euler order if B4 confirmed.

### Pure functions and work items (draft)

- `splitByClassification({ positions: Float32Array, classification, transform }) → parts (data only)`
- `partTransforms({ source, partCentres }) → transforms  (fix the Euler-order suspect first)`

### Tests (land first)

- Split a model rotated about two axes: part world positions (pins B4).
- Split/merge supports round trip keeps triangle count and classification.
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`split-model-into-parts` (3744-3883), `split-import-group` (4243-4284), `split-supports` (4286-4451), `split-supports-synthetic-report` (4324-4370, 4547-4596), `merge-supports` (4453-4654), `organic-cut-commit` (page.tsx:10365-10382)

### Decisions needed

- D1: Does THREE count as impure for maths-only use?
- D4: Is selection part of the core?
- D14: Which fields does a derived model keep?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.
