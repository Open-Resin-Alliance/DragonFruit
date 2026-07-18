import React from 'react';
import { ModelManagerPanel } from '@/components/controls/ModelManagerPanel';
import { DebugPrimitivesPanel } from '@/components/controls/DebugPrimitivesPanel';
import { TransformControls } from '@/components/controls/TransformControls';
import { ArrangePanel } from '@/components/controls/ArrangePanel';
import { DuplicatePanel } from '@/components/controls/DuplicatePanel';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { HollowingPanel } from '@/features/hollowing';
import { HolePunchPanel } from '@/features/hole-punching/HolePunchPanel';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';
import type { useHollowingManager } from '@/features/hollowing/useHollowingManager';
import type { useHolePunchManager } from '@/features/hole-punching/useHolePunchManager';
import type { useArrangeManager } from '@/features/scene/arrange/useArrangeManager';

export type PreparePanelStackProps = {
  scene: ReturnType<typeof useSceneCollectionManager>;
  transformMgr: ReturnType<typeof useTransformManager>;
  hollowing: ReturnType<typeof useHollowingManager>;
  holePunch: ReturnType<typeof useHolePunchManager>;
  arrange: ReturnType<typeof useArrangeManager>;

  outsidePlateModelIds: React.ComponentProps<typeof ModelManagerPanel>['outsidePlateModelIds'];
  handleModelSelection: React.ComponentProps<typeof ModelManagerPanel>['onSelect'];
  handleModelRangeSelection: React.ComponentProps<typeof ModelManagerPanel>['onSelectRange'];
  handleGroupSelection: React.ComponentProps<typeof ModelManagerPanel>['onSelectGroup'];
  handleGroupSelectedModels: React.ComponentProps<typeof ModelManagerPanel>['onGroupModels'];
  handleUngroupSelectedModels: React.ComponentProps<typeof ModelManagerPanel>['onUngroupModels'];
  handleUngroupFolder: React.ComponentProps<typeof ModelManagerPanel>['onUngroupGroup'];
  handleSplitImportGroup: React.ComponentProps<typeof ModelManagerPanel>['onSplitImportGroup'];
  handleRenameFolder: React.ComponentProps<typeof ModelManagerPanel>['onRenameGroup'];
  handleRenameModel: React.ComponentProps<typeof ModelManagerPanel>['onRenameModel'];
  handleModelListContextMenu: React.ComponentProps<typeof ModelManagerPanel>['onModelContextMenu'];
  handleRepairModel: React.ComponentProps<typeof ModelManagerPanel>['onRepairModel'];
  handleOpenModelSupportsInfo: React.ComponentProps<typeof ModelManagerPanel>['onOpenSupportsInfo'];
  showEmptySceneDialog: boolean;
  importOverlayState: { active: boolean };
  modelStatsBottomClearancePx: number;

  debugPrimitivesPanelVisible: boolean;

  ensurePendingTransformHistoryForActiveModel: (operation: 'move' | 'rotate' | 'scale') => void;
  requestDestructiveTransformSupportDeletion: (operationLabel: string) => boolean;
  handleRotationComplete: () => void;
  handleAutoLiftChange: (enabled: boolean) => void;
  scheduleCommitPendingTransformHistory: (frameDelay?: number) => void;
  uniformScaling: boolean;
  setUniformScaling: (value: boolean) => void;

  isApplyingHolePunch: boolean;
  interiorView: boolean;
  hasCavityGeometry: boolean;

  arrangeSpacingMm: number;
  setArrangeSpacingMm: (value: number) => void;
  onDropSelectionToPlatform: () => void;
  onLiftSelection: () => void;
  onCenterSelection: () => void;
  onResetRotationSelection: () => void;
  onResetScaleSelection: () => void;
};

/** PREPARE-mode floating panel group: model manager, transform/smoothing/hollowing/arrange tools. */
export function PreparePanelStack({
  scene,
  transformMgr,
  hollowing,
  holePunch,
  arrange,
  outsidePlateModelIds,
  handleModelSelection,
  handleModelRangeSelection,
  handleGroupSelection,
  handleGroupSelectedModels,
  handleUngroupSelectedModels,
  handleUngroupFolder,
  handleSplitImportGroup,
  handleRenameFolder,
  handleRenameModel,
  handleModelListContextMenu,
  handleRepairModel,
  handleOpenModelSupportsInfo,
  showEmptySceneDialog,
  importOverlayState,
  modelStatsBottomClearancePx,
  debugPrimitivesPanelVisible,
  ensurePendingTransformHistoryForActiveModel,
  requestDestructiveTransformSupportDeletion,
  handleRotationComplete,
  handleAutoLiftChange,
  scheduleCommitPendingTransformHistory,
  uniformScaling,
  setUniformScaling,
  isApplyingHolePunch,
  interiorView,
  hasCavityGeometry,
  arrangeSpacingMm,
  setArrangeSpacingMm,
  onDropSelectionToPlatform,
  onLiftSelection,
  onCenterSelection,
  onResetRotationSelection,
  onResetScaleSelection,
}: PreparePanelStackProps) {
  // Invoked inline by Home (not as <JSX/>) so FloatingPanelStack can flatten these keyed panels as direct children for its layout-profile positioning. 'use no memo' keeps React Compiler from injecting a useMemoCache hook (the conditional inline call must stay hook-free).
  'use no memo';
  const {
    hollowingState,
    handleHollowingStateChange,
    requestClearAppliedHollowing,
    handleResetHollowingSettings,
    handleStartHollowVoxelEditing,
    handleDoneHollowVoxelEditing,
    handleClearHollowVoxelEditing,
    handleApplyHollowing,
    isApplyingHollowing,
    isPreviewingHollowing,
    isApplyingBlockersHollowing,
    isHollowingDirty,
    isHollowingApplied,
    canResetHollowing,
    hollowingEditMode,
    isShellFaceSelectionPending,
  } = hollowing;
  const {
    holePunchState,
    handleHolePunchStateChange,
    requestResetHolePunch,
    handleApplyHolePunch,
    canUseAutoHolePunchDepth,
    isHolePunchDirty,
    holePunchNeedsBake,
    canResetHolePunch,
  } = holePunch;
  const {
    arrangePrecisionMode,
    setArrangePrecisionMode,
    arrangeLayoutMode,
    setArrangeLayoutMode,
    arrangeAllowRotateOnZ,
    setArrangeAllowRotateOnZ,
    arrangeArrayCountX,
    arrangeArrayCountY,
    arrangeArrayCountZ,
    setArrangeArrayCountX,
    setArrangeArrayCountY,
    setArrangeArrayCountZ,
    arrangeArrayGapX,
    arrangeArrayGapY,
    arrangeArrayGapZ,
    setArrangeArrayGapX,
    setArrangeArrayGapY,
    setArrangeArrayGapZ,
    arrangeAnchorMode,
    setArrangeAnchorMode,
    handleManualArrayArrangeModels,
    handleHighPrecisionArrangeModels,
    handleAutoArrangeModels,
    isAutoArranging,
    isDuplicateSetupBlockingArrange,
    duplicateLayoutMode,
    setDuplicateLayoutMode,
    duplicatePrecisionMode,
    setDuplicatePrecisionMode,
    duplicateTotalCopies,
    setDuplicateTotalCopies,
    duplicateSpacingMm,
    setDuplicateSpacingMm,
    duplicateArrayCountX,
    duplicateArrayCountY,
    duplicateArrayCountZ,
    setDuplicateArrayCountX,
    setDuplicateArrayCountY,
    setDuplicateArrayCountZ,
    duplicateArrayGapX,
    duplicateArrayGapY,
    duplicateArrayGapZ,
    setDuplicateArrayGapX,
    setDuplicateArrayGapY,
    setDuplicateArrayGapZ,
    handleConfirmDuplicate,
    handleFillPlateDuplicate,
    duplicatePreviewTransforms,
    isDuplicating,
    activeArrangeOperation,
  } = arrange;
  return (
    <>
      <ModelManagerPanel
        key="prepare-models"
        models={scene.models}
        outsidePlateModelIds={outsidePlateModelIds}
        activeModelId={scene.activeModelId}
        selectedModelIds={scene.selectedModelIds}
        onSelect={handleModelSelection}
        onSelectRange={handleModelRangeSelection}
        onSelectGroup={handleGroupSelection}
        onGroupModels={handleGroupSelectedModels}
        onUngroupModels={handleUngroupSelectedModels}
        onUngroupGroup={handleUngroupFolder}
        onSplitImportGroup={handleSplitImportGroup}
        onRenameGroup={handleRenameFolder}
        onRenameModel={handleRenameModel}
        onModelContextMenu={handleModelListContextMenu}
        onRepairModel={handleRepairModel}
        onOpenSupportsInfo={handleOpenModelSupportsInfo}
        onDelete={scene.deleteModel}
        onVisibilityChange={scene.setModelVisibility}
        dimmed={showEmptySceneDialog || importOverlayState.active}
        bottomClearancePx={modelStatsBottomClearancePx}
      />

      {debugPrimitivesPanelVisible && (
        <DebugPrimitivesPanel
          key="prepare-debug-primitives"
          onAdd={scene.addDebugPrimitive}
          onClear={scene.clearDebugModels}
        />
      )}

      {scene.geom && transformMgr.transformMode === 'transform' && (
        <TransformControls
          key="prepare-transform-controls"
          position={transformMgr.transform.position}
          onPositionChange={(x, y, z) => {
            const current = transformMgr.transform.position;
            const EPS = 1e-6;
            const hasMoveDelta = Math.abs(x - current.x) > EPS
              || Math.abs(y - current.y) > EPS
              || Math.abs(z - current.z) > EPS;
            // Stage a pending 'move' entry so the commit has a `before` to delta
            // from — the whole selection then fans out by that shared delta (§4f).
            if (hasMoveDelta) {
              ensurePendingTransformHistoryForActiveModel('move');
            }
            transformMgr.transformHook.setPosition(x, y, z);
          }}
          onCenter={onCenterSelection}
          onPlatform={transformMgr.transformHook.setPlatformZ}
          rotation={transformMgr.transform.rotation}
          onRotationChange={(x, y, z) => {
            const current = transformMgr.transform.rotation;
            const EPS = 1e-6;
            const hasDestructiveRotate = Math.abs(x - current.x) > EPS
              || Math.abs(y - current.y) > EPS;

            const hasAnyRotateDelta = hasDestructiveRotate || Math.abs(z - current.z) > EPS;
            if (hasAnyRotateDelta) {
              ensurePendingTransformHistoryForActiveModel('rotate');
            }

            if (hasDestructiveRotate) {
              const proceed = requestDestructiveTransformSupportDeletion('Rotate X/Y');
              if (!proceed) return;
            }

            transformMgr.transformHook.setRotation(x, y, z);
          }}
          onResetRotation={onResetRotationSelection}
          onRotationComplete={handleRotationComplete}
          scale={transformMgr.transform.scale}
          onScaleChange={(x, y, z) => {
            const current = transformMgr.transform.scale;
            const EPS = 1e-6;
            const hasDestructiveScale = Math.abs(x - current.x) > EPS
              || Math.abs(y - current.y) > EPS
              || Math.abs(z - current.z) > EPS;

            if (hasDestructiveScale) {
              ensurePendingTransformHistoryForActiveModel('scale');
            }

            if (hasDestructiveScale) {
              const proceed = requestDestructiveTransformSupportDeletion('Scale XYZ');
              if (!proceed) return;
            }

            transformMgr.transformHook.setScale(x, y, z);
          }}
          onResetScale={onResetScaleSelection}
          uniformScaling={uniformScaling}
          onUniformScalingChange={setUniformScaling}
          modelBBox={scene.geom.bbox}
          autoLift={transformMgr.autoLift}
          onAutoLiftChange={handleAutoLiftChange}
          liftDistance={transformMgr.liftDistance}
          onLiftDistanceChange={transformMgr.setLiftDistance}
          onLift={onLiftSelection}
          onDrop={onDropSelectionToPlatform}
          onTransformCommit={scheduleCommitPendingTransformHistory}
        />
      )}

      {scene.geom && transformMgr.transformMode === 'smoothing' && (
        <MeshSmoothingSettingsPanel key="prepare-smoothing-settings" />
      )}

      {scene.geom && transformMgr.transformMode === 'hollowing' && (
        <>
          <HollowingPanel
            key="prepare-hollowing-panel"
            state={hollowingState}
            onStateChange={handleHollowingStateChange}
            onReset={requestClearAppliedHollowing}
            onResetSettings={handleResetHollowingSettings}
            onStartEdit={handleStartHollowVoxelEditing}
            onDoneEdit={handleDoneHollowVoxelEditing}
            onClearEdit={handleClearHollowVoxelEditing}
            onApply={() => { void handleApplyHollowing(); }}
            isApplying={isApplyingHollowing}
            isPreviewing={isPreviewingHollowing}
            isApplyingBlockers={isApplyingBlockersHollowing || isPreviewingHollowing}
            canApply={!isShellFaceSelectionPending && (isHollowingDirty || !isHollowingApplied)}
            canReset={canResetHollowing}
            canEdit={!isShellFaceSelectionPending && Boolean(scene.activeModel)}
            isEditMode={hollowingEditMode}
            isHollowingApplied={isHollowingApplied}
            shellFaceSelectionPending={isShellFaceSelectionPending}
          />

          <HolePunchPanel
            key="prepare-hole-punch-panel"
            state={holePunchState}
            onStateChange={handleHolePunchStateChange}
            onReset={requestResetHolePunch}
            onApply={() => { void handleApplyHolePunch(); }}
            canUseAutoDepth={canUseAutoHolePunchDepth}
            isApplying={isApplyingHolePunch}
            canApply={!isShellFaceSelectionPending && (isHolePunchDirty || holePunchNeedsBake)}
            canReset={!isShellFaceSelectionPending && canResetHolePunch}
            disabled={hollowingEditMode}
            interiorView={interiorView}
            interiorViewAvailable={hasCavityGeometry}
          />
        </>
      )}

      {scene.models.length > 0 && transformMgr.transformMode === 'arrange' && (
        <>
          <ArrangePanel
            key="prepare-arrange-panel"
            precisionMode={arrangePrecisionMode}
            onPrecisionModeChange={setArrangePrecisionMode}
            layoutMode={arrangeLayoutMode}
            onLayoutModeChange={setArrangeLayoutMode}
            spacingMm={arrangeSpacingMm}
            onSpacingMmChange={setArrangeSpacingMm}
            allowRotateOnZ={arrangeAllowRotateOnZ}
            onAllowRotateOnZChange={setArrangeAllowRotateOnZ}
            arrayCountX={arrangeArrayCountX}
            arrayCountY={arrangeArrayCountY}
            arrayCountZ={arrangeArrayCountZ}
            onArrayCountXChange={setArrangeArrayCountX}
            onArrayCountYChange={setArrangeArrayCountY}
            onArrayCountZChange={setArrangeArrayCountZ}
            arrayGapX={arrangeArrayGapX}
            arrayGapY={arrangeArrayGapY}
            arrayGapZ={arrangeArrayGapZ}
            onArrayGapXChange={setArrangeArrayGapX}
            onArrayGapYChange={setArrangeArrayGapY}
            onArrayGapZChange={setArrangeArrayGapZ}
            anchorMode={arrangeAnchorMode}
            onAnchorModeChange={setArrangeAnchorMode}
            onApplyAll={() => {
              void (arrangeLayoutMode === 'array'
                ? handleManualArrayArrangeModels('all')
                : (arrangePrecisionMode === 'high_precision'
                  ? handleHighPrecisionArrangeModels('all')
                  : handleAutoArrangeModels('all')));
            }}
            onApplySelected={() => {
              void (arrangeLayoutMode === 'array'
                ? handleManualArrayArrangeModels('selected')
                : (arrangePrecisionMode === 'high_precision'
                  ? handleHighPrecisionArrangeModels('selected')
                  : handleAutoArrangeModels('selected')));
            }}
            modelCount={scene.models.filter((m) => m.visible).length}
            selectedModelCount={scene.models.filter((m) => m.visible && scene.selectedModelIds.includes(m.id)).length}
            isApplying={isAutoArranging}
            disableArrangeActions={isDuplicateSetupBlockingArrange}
          />

          <DuplicatePanel
            key="prepare-duplicate-panel"
            activeModelName={scene.activeModel?.name ?? null}
            layoutMode={duplicateLayoutMode}
            onLayoutModeChange={setDuplicateLayoutMode}
            precisionMode={duplicatePrecisionMode}
            onPrecisionModeChange={setDuplicatePrecisionMode}
            totalCopies={duplicateTotalCopies}
            onTotalCopiesChange={setDuplicateTotalCopies}
            spacingMm={duplicateSpacingMm}
            onSpacingMmChange={setDuplicateSpacingMm}
            arrayCountX={duplicateArrayCountX}
            arrayCountY={duplicateArrayCountY}
            arrayCountZ={duplicateArrayCountZ}
            onArrayCountXChange={setDuplicateArrayCountX}
            onArrayCountYChange={setDuplicateArrayCountY}
            onArrayCountZChange={setDuplicateArrayCountZ}
            arrayGapX={duplicateArrayGapX}
            arrayGapY={duplicateArrayGapY}
            arrayGapZ={duplicateArrayGapZ}
            onArrayGapXChange={setDuplicateArrayGapX}
            onArrayGapYChange={setDuplicateArrayGapY}
            onArrayGapZChange={setDuplicateArrayGapZ}
            onConfirm={handleConfirmDuplicate}
            onFillPlate={handleFillPlateDuplicate}
            previewCount={duplicatePreviewTransforms.length}
            isApplying={isDuplicating || (isAutoArranging && activeArrangeOperation === 'high_precision_fill')}
          />
        </>
      )}
    </>
  );
}
