# Scene core: draft issues

One draft per command group, from the scene core map (dev @ 5d31502c (2026-10-21), symbols re-checked on dev @ 45195593 (2026-11-10)). Draft 1 (the CLI save
round trip, test-only) is open as issue #928, and parts of draft 2 as #938–#940; the others stay here as the plan until their turn. Each follows ADR-0045: pin behaviour first, move the rule, manager and CLI call the same
function, parity test as done.

## 1. scene-core: test that a CLI save keeps every field (round trip)

**Status:** opened as issue #928 (test-only).

**Labels (suggested):** `scene-core` · **Effort:** S · **Risk:** Low · **Depends on:** —

### Scope

Test-only change. Add a full round-trip test for the CLI save: every field and chunk, not just plates. Where the test meets a known defect (B1 issue #923, B2 issue #924), mark that case as an expected failure linked to its issue rather than fixing it here. No production code changes.

### Work items

- One test: an app-written scene → CLI load → a no-op CLI command → CLI save → reload → compare every field and every mesh chunk.
- Known gaps it will hit (B1 meshless duplicates, issue #923; B2 dropped ORIG chunks and sha map, issue #924) are marked as expected failures that link to those issues. No production code changes.

### Test fixture

- App-written multi-plate scene with duplicate meshes, originals, every support type, link groups → CLI load → transform-model no-op → save → deep compare (fields + chunks).

### Out of scope

Fixing B1 or B2 (issues #923, #924), moving the snapshot registry, and pinning the other suspected bugs: each is a later, separate PR.

## 2. scene-core: plates phase 2 — frames everywhere, relaidPlateShifts, plate plans

**Status:** plan. Parts already opened: #938 (plateLayout.ts to one parameters object), #939 (one plate relayout step), #940 (plate logic in one place); the support-move bug B5 was fixed by PR #943.

**Labels (suggested):** `scene-core` · **Effort:** M · **Risk:** Med · **Depends on:** foundation; D10 for origin/ordering

### Scope

Replace the ~9 hand-computed plate rects with computePlateFrames. Extract modelsShiftedForRelaidPlates as relaidPlateShifts. Add planAddPlates / planRemovePlate / planEmptyScenePlates. Convert resolveModelPlateId to one params object (D21, decided). Optional CLI: scene add-plate / remove-plate / rename-plate / move-to-plate; scene slice reads meta.printer.

### Pure functions and work items (draft)

- `relaidPlateShifts({ models, from: { plates, footprint, ordering }, to: {...} }) → { modelId, dxMm, dyMm }[]`
- `planAddPlates({ plates, count, footprint, ordering, models }) → { plates, shifts }`
- `planRemovePlate({ plates, plateId, models }) → { plates, removeModelIds, nextActivePlateId } | { refused }`
- `planEmptyScenePlates({ plates }) → plates (the 'scene became empty' rule now inside deleteModels)`
- `resolveModelPlateId({ model, frames }) — convert to one params object (D21, decided)`

### Tests (land first)

- computePlateFrames vs every hand-computed rect site (defaultImportCenterXY, activePlateRect, plateOffsetFor, addPlates, moveModelsToPlate, seatModelOnNewBedIfNeeded, VOXL load) for both origin modes and both orderings.
- modelsShiftedForRelaidPlates golden cases: printer switch, ordering switch, add/remove plate; supports shifted with models (pins B5).
- removePlate refuses first plate; dropPlates currently allows it (pin as-is).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`shift-supports-with-models` (`shiftSupportsWithModels`), `plates-state` (`setPlates`, `activePlateId`, `setActivePlateId`), `plate-name` (`plateName`, `setPlateName`), `plate-lock` (`lockedPlateIds`, `lockedPlateIdsRef`, `plateLocked`), `model-plate-id` (`modelPlateId`, `plateFramesRef`), `plate-lock-guards` (`isModelPlateLocked`, `isActivePlateLocked`, `isPlateLocked`), `locked-plate-notice` (`onBlockedByLockRef`, `lockedPlateIdFor`, `onBlockedByLock`), `clear-empty-plate-name` (effect/inline: useEffect (empty single plate clears name) in useSceneCollectionManager.ts), `printer-profile-subscription` (`profileState`, `activePrinterProfile`), `multi-plate-ordering` (`multiPlateSettings`, `followLandedPlateRef`, `plateOrdering`), `voxl-printer-bundle` (`voxlPrinterBundle`), `active-plate-rect` (`activePlateRect`), `voxl-load-printer-relayout` (`handleImportVoxlFile`), `plate-offset-for` (`plateOffsetFor`, `plateOffsetForRef`), `plate-forward-refs` (`addPlatesRef`, `plateOffsetForRef`), `models-shifted-for-relaid-plates` (`modelsShiftedForRelaidPlates`), `relay-on-printer-switch` (`laidOutFootprintRef`), `relay-on-ordering-change` (`appliedPlateOrderingRef`), `add-plate` (`addPlate`), `drop-plates` (`dropPlates`), `add-plates` (`addPlates`), `activate-plate` (`activatePlate`), `plate-frames` (`plateFrames`, `plateFramesRef`), `resolve-model-plate-id` (`resolveModelPlateId`), `model-plate-frame` (`modelPlateFrame`), `rename-plate` (`renamePlate`), `remove-plate` (`removePlate`), `delete-models-and-extra-plates` (`deleteModelsAndExtraPlates`), `move-models-to-plate` (`moveModelsToPlate`), `active-plate-name-and-lock` (`plateName`, `setPlateName`, `plateLocked`), `plate-state-passthrough` (`activePlateId`, `plateViewRunId`, `plateOrdering`), `active-plate-model-ids` (`activePlateModelIds` in page.tsx), `sc-plate-scenery` (`plateSceneryModelIds`, `modelPlateStates`, `isModelFocusable` in SceneCanvas.tsx), `slice-run-plate-scope` (`handleSliceRunStartedForPrinting`, `recordPrintingSlice`, `handleSlicePlateSliced` in page.tsx), `printing-scrub-preview-models` (`printingScrubPreviewModels` in page.tsx), `sc-next-plate-frame-ghost-drop` (`nextPlateFrame`, `applySelectDragMove`, `finishSelectDrag` in SceneCanvas.tsx), `plate-widget-passthroughs` (`onAddPlate`, `onTogglePlateLock`, `onActivatePlate` in page.tsx)

### Decisions

- D3 (open): Are plate locks core or UI?
- D4 (open): Is selection part of the core?
- D10 (open): Who owns plate ordering and origin mode?
- D21 (decided): Yes. plateLayout.ts moves to a single parameters object before it gains more callers (issue #938).

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 3. scene-core: model field rules (rename, visibility, colour, designation, link)

**Status:** plan; opened when its turn comes.

**Labels (suggested):** `scene-core` · **Effort:** S each · **Risk:** Low/Med · **Depends on:** foundation

### Scope

Pure renameModels, setModelsVisible, setModelsColor, setSupportDesignation, linkModels, unlinkModels; manager calls them; matching CLI commands with parity tests. Can be split into 2–3 PRs.

### Pure functions and work items (draft)

- `renameModels({ models, modelId, name }) → models`
- `setModelsVisible({ models, modelIds, visible }) → models`
- `setModelsColor({ models, modelIds, color }) → models (split from the viewer preference)`
- `setSupportDesignation({ models, modelIds, isSupport }) → models (changes slicing → check:scene-slice case)`
- `linkModels({ models, modelIds }) / unlinkModels({ models, modelIds }) → models`

### Tests (land first)

- Each setter: input models + ids → output models; history label unchanged (DOM test reads the label).
- Support designation: check:scene-slice case where a designated model changes the sliced output.
- Replace voxlSupportDesignation.test.ts's inline copy with a call to the real function.
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`set-model-visibility` (`setModelVisibility`), `rename-model` (`renameModel`), `set-mesh-color` (`setMeshColor`), `set-mesh-visible` (`setMeshVisible`), `toggle-support-designation` (`toggleSupportDesignation`), `link-models` (`linkModels`), `unlink-models` (`unlinkModels`), `grouping-rename-passthrough` (`handleGroupSelectedModels`, `handleUngroupSelectedModels`, `handleUngroupFolder` in page.tsx)

### Decisions

- D4 (open): Is selection part of the core?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 4. scene-core: one grouping model for app and CLI

**Status:** plan; opened when its turn comes.

**Labels (suggested):** `scene-core` · **Effort:** S · **Risk:** Med · **Depends on:** D5

### Scope

After D5, store groups in one place, make CLI group/ungroup/list-groups call modelGroupingHistory, extract renameGroup and modelIdsInGroup.

### Pure functions and work items (draft)

- `applyModelGrouping (exists) — make CLI group/ungroup call it`
- `renameGroup({ models, groupId, name }) → models`
- `modelIdsInGroup({ models, groupId }) → ids (today selectGroup does this inline)`

### Tests (land first)

- After D5: group in app → save → CLI list-groups shows it, and the reverse.
- modelGroupingHistory existing tests stay green.
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`group-models` (`groupModels`), `list-groups` (`groupId`), `ungroup-models` (`ungroupModels`), `ungroup-group` (`ungroupGroup`), `rename-group` (`renameGroup`)

### Decisions

- D4 (open): Is selection part of the core?
- D5 (open): Where do groups live in the file?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 5. scene-core: buildVoxlSaveInput shared by every saver

**Status:** plan; opened when its turn comes.

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

`chunk-store-bake` (`exportManager`, `scheduleIdleTask`, `scheduleModelChunkBake`), `voxl-format-chunked-ref` (`lastLoadedVoxlFormatChunkedRef`), `chunk-store-sweep-effect` (`scheduleChunkStoreSweep`), `save-cli-tobuildinput` (`toBuildInput`, `saveVoxl` in dragonfruit-ts-cli.ts), `save-export-panel` (`ExportPanel`, `handleExport`, `exportGroupsToDirectory` in ExportPanel.tsx), `save-autosave` (`useSceneAutosave`, `performAutosave` in useSceneAutosave.ts), `save-export-scene-dispatch` (`ExportManager`, `exportScene` in ExportManager.ts), `save-export-voxl` (`ExportManager`, `exportVoxl` in ExportManager.ts), `scene-autosave-wiring` (`useSceneAutosave` in page.tsx), `save-baseline-dirty` (`markSceneSaveBaseline`, `recomputeUnsavedSceneChanges`, `subscribeHistory` in page.tsx), `slice-thumbnail-per-plate` (`captureSliceThumbnailPng` in page.tsx), `before-slice-start` (`handleBeforeSliceStart`, `handlePreSliceSceneSave`, `suggestedSliceOutputFilename` in page.tsx), `save-topbar-ctrl-s` (`performTopBarSaveScene` in page.tsx), `top-bar-save-scene` (`performTopBarSaveScene` in page.tsx), `save-path-resolution` (`resolveSceneSaveNativePath`, `saveCurrentSceneNow`, `handleTopBarSaveScene` in page.tsx), `empty-scene-reset` (effect/inline: useEffect (scene.models.length === 0) in page.tsx), `autosave-recovery-discovery` (`resolveAutosaveRecovery` in page.tsx)

### Decisions

- D4 (open): Is selection part of the core?
- D8 (open): Should opening a VOXL change it, and does open merge or replace?
- D9 (decided): All models. Settled by PR #942 (issue #925): Ctrl/Cmd+S now writes hidden models too, like autosave and the CLI.

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 6. scene-core: planDeleteModels and the support cascade

**Status:** plan. The CLI half is already open as issue #935 (remove-model leaves supports behind; part of H1 in #929), whose fix is this draft's pure cascade over the support type registry.

**Labels (suggested):** `scene-core` · **Effort:** M · **Risk:** High · **Depends on:** plates; D13

### Scope

Extract link-dissolve, empty-scene plates and the support cascade compute; CLI remove-model calls them.

### Pure functions and work items (draft)

- `planDeleteModels({ models, plates, modelIds }) → { models, plates, dissolvedLinkGroups }`
- `supportsCascadeForModels({ supports, modelIds }) → { removeIds by collection } (pure compute half of deleteSupportsForModel)`

### Tests (land first)

- Scene with every support type, a 2-member link group, 2 plates: delete one model → app result == CLI result (supports, link groups, plates).
- Delete last model → plates collapse (app); undo restores modifiers? (pins B14).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`delete-models` (`deleteModels`), `delete-models-link-dissolve` (`deleteModels`), `delete-models-empty-scene-plates` (`deleteModels`), `delete-models-support-cascade` (`deleteModels`), `delete-model` (`deleteModel`), `delete-supports-for-models` (`deleteSupportsForModels`), `delete-active-model-handler` (`registerDeleteHandler`), `new-scene` (`startNewScene`, `handleRequestNewScene`, `handleDiscardAndNewScene` in page.tsx), `select-all-and-delete` (`registerDeleteHandler` in page.tsx), `clear-or-delete-plate` (`onClearPlate` in page.tsx)

### Decisions

- D4 (open): Is selection part of the core?
- D13 (open): Who owns support removal for a model?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 7. scene-core: one out-of-bounds rule and one seat-Z rule

**Status:** plan; opened when its turn comes.

**Labels (suggested):** `scene-core` · **Effort:** M · **Risk:** High · **Depends on:** plates; D11, D12

### Scope

Unify the four out-of-bounds copies and four seat-Z copies; CLI place-on-platform and scene slice use them; check:scene-slice cases.

### Pure functions and work items (draft)

- `modelsOutsideVolume({ models, frames, volume, mode: 'overlap'|'contain', margins?, supportBounds? }) → ids`
- `seatZ({ model, geometryBounds, autoLift, liftDistance }) → z (wraps selectionLiftDrop.getModelLowestWorldZ)`

### Tests (land first)

- One fixture per out-of-bounds copy (resin estimate, sliceable, warning, SceneCanvas) with models inside, overlapping, outside; record each copy's answer today.
- Seat Z for unrotated/rotated/scaled off-centre mesh: selectionLiftDrop vs performAutoSnap vs SceneCanvas vs CLI place-on-platform (pins B8).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`set-model-manual-z-move-override` (effect/inline: setModelManualZMoveOverride in useSceneCollectionManager.ts), `scene-bounds` (`sceneBounds`), `plate-volume-bounds` (`plateVolumeBounds` in page.tsx), `volume-bounds-for-model` (`volumeBoundsForModel` in page.tsx), `sc-align-live-transform-to-lift` (`alignLiveTransformToLift` in SceneCanvas.tsx), `sc-volume-boxes-and-oob` (`buildVolumeBounds`, `plateVolumeBoxes`, `volumeBoxForModel` in SceneCanvas.tsx), `resin-in-bounds-models` (`resinBuildVolumeBounds`, `resinInBoundsModelIdSet`, `visibleResinModels` in page.tsx), `scene-z-range` (`accurateMaxZ`, `fallbackZRange`, `normalizeToSlicerZRange` in page.tsx), `sliceable-models` (`sliceableModelIdSet`, `slicingModels`, `excludedSliceModelIds` in page.tsx), `out-of-bounds-models-page` (`computeModelWorldBounds`, `buildVolumeBounds`, `outsidePlateModelIds` in page.tsx), `lift-drop-selection` (`placeSelectedModelsAtWorldZ`, `handleLiftSelectedModels`, `handleDropSelectedModels` in page.tsx), `auto-lift-toggle` (`handleAutoLiftChange` in page.tsx)

### Decisions

- D4 (open): Is selection part of the core?
- D10 (open): Who owns plate ordering and origin mode?
- D11 (open): One out-of-bounds rule, and should `scene slice` drop models outside the volume?
- D12 (open): Seat Z, Auto Lift and manualZMoveOverride as inputs?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 8. scene-core: free-spot placement and duplicate layout

**Status:** plan; opened when its turn comes.

**Labels (suggested):** `scene-core` · **Effort:** L (split into 3 PRs) · **Risk:** Med · **Depends on:** plates, bounds-seat; D6, D14

### Scope

Extract findFreeSpots (import + paste), layoutDuplicates (page.tsx), deriveModelFrom; plate-aware arrange in CLI; CLI duplicate and add-model --auto-place.

### Pure functions and work items (draft)

- `findFreeSpots({ footprints, frames, blockers, startPlateId, allowNewPlates }) → { positions, newPlateCount }`
- `layoutDuplicates({ source, count, spacing, frames, blockers }) → { transforms, newPlateCount } (from the duplicate-preview effect in page.tsx that sets setDuplicatePreviewTransforms)`
- `deriveModelFrom({ source, id, name, transform }) → model (one rule for which fields copies keep)`
- `arrange: make computeHighPrecisionArrangeUpdates callers plate-aware (CLI packs everything onto plate 1)`

### Tests (land first)

- Import free-spot, paste, plugin import and duplicate preview: golden positions for fixed footprints/blockers on 1 and 2 plates, including overflow to a new bed.
- Touching-edge overlap behaviour of intersectsRect vs plateFreeSpace.rectsOverlap.
- Derived-model field lists for split, merge, paste, duplicate (what's kept today).
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`default-import-center` (`defaultImportCenterXY`), `intersects-rect` (`intersectsRect`, `Rect2D`), `is-rect-inside-plate` (`isRectInsidePlate`), `footprint-for-transform` (`footprintForTransform`), `build-mesh-placement-offsets` (`buildMeshPlacementOffsets`), `model-footprint-rect` (`modelFootprintRect`), `is-model-footprint-inside-plate` (`isModelFootprintInsidePlate`), `find-free-spot-centers` (`findFreeSpotCentersForModels`), `seat-model-on-new-bed` (`seatModelOnNewBedIfNeeded`, `loadFiles`), `import-free-spot-placement` (`loadFiles`, `findFreeSpotCentersForModels`), `copy-model` (`copyModel`), `clipboard-entry-build` (`copyModel`, `copySelectedModels`, `ModelClipboardEntry`), `copy-selected-models` (`copySelectedModels`), `cut-selected-models` (`cutSelectedModels`), `cut-model` (`cutModel`), `paste-model` (`pasteModel`), `paste-auto-arrange` (`pasteCopiedModelsAutoArrange`), `paste-support-rect` (`supportRectForPayload`, `pasteCopiedModelsAutoArrange`), `paste-place-into-bed` (`placeIntoBed`, `buildPlacementOffsets`, `intersectsRect`), `duplicate-with-transforms` (`duplicateModelWithTransforms`), `plugin-import-arrange` (`handleImportPluginSceneFile`, `arrangeImportedModels`), `voxl-load-offbed-placement` (`handleImportVoxlFile`), `support-aware-arrange-bounds` (`supportBoundsByModelId`, `getArrangeTransform`, `getModelSupportAwareDimensionsMm` in page.tsx), `prepare-hotkeys-arrange-all` (`usePrepareTransformHotkeys`, `onArrangeAll` in page.tsx), `duplicate-preview-layout` (effect/inline: useEffect duplicate preview in page.tsx), `copy-paste-hotkeys` (effect/inline: Ctrl+C / Ctrl+V / Ctrl+S branches of hotkey effect in page.tsx), `arrange-plate-button` (`onArrangePlate` in page.tsx)

### Decisions

- D1 (decided): THREE is allowed inside a pure function, as long as only its maths is used and not its scene graph, THREE types stay out of signatures, and inputs are never mutated. Ender will amend ADR-0045 to say so.
- D3 (open): Are plate locks core or UI?
- D4 (open): Is selection part of the core?
- D6 (open): One placement engine or several?
- D14 (open): Which fields does a derived model keep?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 9. scene-core: planModelTransforms

**Status:** plan; opened when its turn comes.

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

`transforms-equal` (`transformsEqual`), `supports-for-models` (`hasSupportsForModel`, `supportStateFor`), `set-model-transform-raw` (`setModelTransformRaw`), `update-model-transform` (`updateModelTransform`), `transform-plate-lock-guard` (`isModelPlateLocked`, `lockedPlateIdFor`, `updateModelTransform`), `transform-link-peer-propagation` (`updateModelTransform`, `updateModelTransforms`, `commitModelTransformHistory`), `commit-model-transform-history` (`commitModelTransformHistory`), `commit-model-transforms-history` (`commitModelTransformsHistory`), `update-model-transforms` (`updateModelTransforms`), `destructive-transform-guard` (`requestDestructiveTransformSupportDeletion`, `requestOrientSupportDeletionWithContinuation` in page.tsx), `apply-orientation` (`handleApplyOrientation` in page.tsx), `sc-multi-selection-transform` (`buildMultiSelectionTransformsFromActive` in SceneCanvas.tsx), `history-transform-resync` (effect/inline: useEffect in page.tsx), `sc-move-z-lock` (`onMoveStart`, `onMove` in SceneCanvas.tsx), `mirror-finalize-on-tool-change` (`setTransformModeWithMirrorFinalize` in page.tsx), `history-origin-restore` (`historyOriginRef`, `setHistoryOriginProvider`, `subscribeHistoryOperations` in page.tsx), `transform-end` (`handleTransformEnd`, `applyPostRotateLift` in page.tsx), `gizmo-group-commit` (`handleGizmoTransformGroupCommit` in page.tsx), `selection-panel-edits` (`ensurePendingSelectionHistory`, `commitPendingSelectionPositionHistory`, `applySelectionPositionUpdates` in page.tsx), `selection-rotate` (`handleRotateSelectedModels` in page.tsx), `selection-transform-commit` (`handleSelectionTransformCommit` in page.tsx), `selection-scale` (`handleScaleSelectedModels` in page.tsx), `selection-reset` (`handleResetSelectedModels` in page.tsx), `selection-move` (`handlePositionSelectedModels`, `selectionPositionOrigin` in page.tsx), `center-selection` (`handleCenterSelectedModels` in page.tsx), `transform-start` (`handleTransformStart` in page.tsx), `pending-transform-history` (`invalidatePendingTransformHistory`, `commitPendingTransformHistory`, `scheduleCommitPendingTransformHistory` in page.tsx), `gizmo-commit` (`handleGizmoTransformCommit`, `handleRotationComplete` in page.tsx), `place-on-face` (`handlePlaceOnFaceAnimationStart`, `handlePlaceOnFace`, `handlePlaceOnFaceBeforeApply` in page.tsx)

### Decisions

- D1 (decided): THREE is allowed inside a pure function, as long as only its maths is used and not its scene graph, THREE types stay out of signatures, and inputs are never mutated. Ender will amend ADR-0045 to say so.
- D2 (open): What does a transform carry with it?
- D3 (open): Are plate locks core or UI?
- D4 (open): Is selection part of the core?
- D12 (open): Seat Z, Auto Lift and manualZMoveOverride as inputs?
- D15 (open): Should transform history become a pure 'edit session'?
- D20 (open): What does 'center' mean on plate 2?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 10. scene-core: planVoxlOpen and planMeshImport

**Status:** plan; opened when its turn comes.

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

`sanitize-imported-model-name` (`sanitizeImportedModelDisplayName`), `helper-name-sanitize` (`sanitizeImportedModelDisplayName`), `sha256-hex` (`sha256Hex`), `remap-model-ids-in-payload` (`remapModelIdsInPayload`), `helper-support-payload` (`remapModelIdsInPayload`, `voxlSupportsContainData`, `countSupportEntries`), `support-payload-counts` (`voxlSupportsContainData`, `payloadCollections`, `countSupportEntries`), `apply-import-defaults-to-raft` (`applyImportDefaultsToRaftState`), `normalize-plugin-scene-payload` (`PluginSceneImportPayload`, `toFiniteNumber`, `toVector3`), `helper-normalize-plugin-payload` (`normalizePluginSceneImportPayload`), `scene-import-placement-prompt` (`sceneImportPlacementPrompt`, `requestSceneImportPlacementChoice`, `resolveSceneImportPlacementPrompt`), `scene-import-hollowing-prompt` (`sceneImportHollowingPrompt`, `requestSceneImportHollowingChoice`, `resolveSceneImportHollowingPrompt`), `merge-cavity-into-shell` (`mergeCavityIntoShell`, `readPayloadCavity`, `geometryPositionsAsSoup`), `helper-cavity` (`readPayloadCavity`, `mergeCavityIntoShell`), `mesh-repair-confirm-prompt` (`meshRepairConfirmPrompt`, `requestMeshRepairConfirmation`, `resolveMeshRepairConfirmPrompt`), `printer-mismatch` (`printerMismatch`, `setPrinterMismatch`, `resolvePrinterMismatch`), `mesh-scene-extension` (`getMeshExtension`, `getSceneExtension`), `scene-plugin-import-handlers` (`scenePluginImportHandlersByExtension`), `load-files` (`loadFiles`), `import-lock-and-extension-filter` (`loadFiles`, `getMeshExtension`), `import-progress-and-recent-paths` (`loadFiles`), `import-prefs-read` (`loadFiles`), `import-native-repair-options` (`loadFiles`, `loadOptions`, `onNativeProcessingStage`), `import-build-model-entry` (`loadFiles`), `import-post-selection` (`loadFiles`), `import-repair-report` (`loadFiles`, `repairReportNeedsAttention`), `on-file-change` (`onFileChange`), `scene-import-run-options` (`SceneImportRunOptions`, `shouldAutoRepairSceneImports`), `should-auto-repair-scene-imports` (`shouldAutoRepairSceneImports`), `import-plugin-scene-file` (`handleImportPluginSceneFile`, `importPluginSceneFile`), `plugin-import-hollow-bake` (`handleImportPluginSceneFile`), `plugin-import-apply-supports` (`handleImportPluginSceneFile`, `applySupports`), `import-voxl-file` (`handleImportVoxlFile`), `voxl-load-header-check` (`handleImportVoxlFile`), `voxl-load-mesh-build-dedup` (`handleImportVoxlFile`), `voxl-load-model-mapping` (`handleImportVoxlFile`, `LoadedModel`), `voxl-load-commit` (`handleImportVoxlFile`), `voxl-load-printer-mismatch` (`handleImportVoxlFile`), `voxl-load-supports` (`handleImportVoxlFile`), `import-scene-file` (`importSceneFile`), `import-scene-files` (`importSceneFiles`) …

### Decisions

- D4 (open): Is selection part of the core?
- D7 (open): How do imports handle user prompts when headless?
- D8 (open): Should opening a VOXL change it, and does open merge or replace?
- D10 (open): Who owns plate ordering and origin mode?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.

## 11. scene-core: split and merge as data

**Status:** plan; opened when its turn comes.

**Labels (suggested):** `scene-core` · **Effort:** L · **Risk:** High · **Depends on:** transform; D1, D14

### Scope

Triangle-soup split/merge rules without THREE geometry; fix Euler order if B4 confirmed.

### Pure functions and work items (draft)

- `splitByClassification({ positions: Float32Array, classification, transform }) → parts (data only)`
- `partTransforms({ source, partCentres }) → transforms (fix the Euler-order suspect first)`

### Tests (land first)

- Split a model rotated about two axes: part world positions (pins B4).
- Split/merge supports round trip keeps triangle count and classification.
- Parity test: same input scene through the manager path and the CLI path gives the same result.

### Operations in scope (from the map)

`split-model-into-parts` (`splitModelIntoParts`), `split-import-group` (`splitImportGroup`), `split-supports` (`splitSupports`), `split-supports-synthetic-report` (`splitSupports`, `mergeSupports`, `nativeRepairReport`), `merge-supports` (`mergeSupports`), `organic-cut-commit` (`useOrganicCutSession`, `commitParts` in page.tsx)

### Decisions

- D1 (decided): THREE is allowed inside a pure function, as long as only its maths is used and not its scene graph, THREE types stay out of signatures, and inputs are never mutated. Ender will amend ADR-0045 to say so.
- D4 (open): Is selection part of the core?
- D14 (open): Which fields does a derived model keep?

### Out of scope

Behaviour changes, unless a pinning test proves a data loss and the fix is agreed separately.
