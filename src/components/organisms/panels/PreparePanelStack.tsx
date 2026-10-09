import React from 'react';
import { ModelManagerPanel } from '@/components/controls/ModelManagerPanel';
import { ModelsPanel } from '@/components/organisms/panels/ModelsPanel';
import { AutoRotationPanel } from '@/components/controls/AutoRotationPanel';
import { TransformControls } from '@/components/controls/TransformControls';
import { ArrangePanel } from '@/components/controls/ArrangePanel';
import { DuplicatePanel } from '@/components/controls/DuplicatePanel';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { OrganicCutPanel, type OrganicCutSession } from '@/features/organicCut';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useTransformManager } from '@/features/transform/useTransformManager';
import type { useArrangeManager } from '@/features/scene/arrange/useArrangeManager';

export type PreparePanelStackProps = {
  scene: ReturnType<typeof useSceneCollectionManager>;
  transformMgr: ReturnType<typeof useTransformManager>;
  arrange: ReturnType<typeof useArrangeManager>;
  organicCut: OrganicCutSession;

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
  handleAddModels: React.ComponentProps<typeof ModelsPanel>['handleAddModels'];
  showEmptySceneDialog: boolean;
  importOverlayState: { active: boolean };
  modelStatsBottomClearancePx: number;
  /** Tool rail's `Models` entry: the list stays mounted, it just is not shown. */
  modelsPanelVisible: boolean;
  /** The model list is collapsible only while the tool rail is a bar. */
  modelsPanelCollapsible: boolean;

  /**
   * The Auto Orientation panel, rendered beneath the Transform controls and only
   * while the Transform tool is active. `null` when the Auto Orientation
   * experiment is disabled, so nothing is mounted.
   */
  orientationPanel: Omit<React.ComponentProps<typeof AutoRotationPanel>, 'blockersActive' | 'onToggleBlockers'> | null;

  ensurePendingTransformHistoryForActiveModel: (operation: 'move' | 'rotate' | 'scale') => void;
  requestDestructiveTransformSupportDeletion: (operationLabel: string) => boolean;
  handleRotationComplete: () => void;
  handleAutoLiftChange: (enabled: boolean) => void;
  selectionPositionOrigin: React.ComponentProps<typeof TransformControls>['position'];
  handlePositionSelectedModels: (x: number, y: number, z: number) => void;
  commitPendingSelectionPositionHistory: () => void;
  handleCenterSelectedModels: () => void;
  handleLiftSelectedModels: () => void;
  handleDropSelectedModels: () => void;
  scheduleCommitPendingTransformHistory: (frameDelay?: number) => void;
  uniformScaling: boolean;
  setUniformScaling: (value: boolean) => void;
  localTransformSpace: boolean;
  setLocalTransformSpace: (value: boolean) => void;

  arrangeSpacingMm: number;
  setArrangeSpacingMm: (value: number) => void;
};

/** PREPARE-mode floating panel group: model manager, transform/smoothing/arrange tools. */
export function PreparePanelStack({
  scene,
  transformMgr,
  arrange,
  organicCut,
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
  handleAddModels,
  showEmptySceneDialog,
  importOverlayState,
  modelStatsBottomClearancePx,
  modelsPanelVisible,
  modelsPanelCollapsible,
  orientationPanel,
  ensurePendingTransformHistoryForActiveModel,
  requestDestructiveTransformSupportDeletion,
  handleRotationComplete,
  handleAutoLiftChange,
  selectionPositionOrigin,
  handlePositionSelectedModels,
  commitPendingSelectionPositionHistory,
  handleCenterSelectedModels,
  handleLiftSelectedModels,
  handleDropSelectedModels,
  scheduleCommitPendingTransformHistory,
  uniformScaling,
  setUniformScaling,
  localTransformSpace,
  setLocalTransformSpace,
  arrangeSpacingMm,
  setArrangeSpacingMm,
}: PreparePanelStackProps) {
  // Invoked inline by Home (not as <JSX/>) so FloatingPanelStack can flatten these keyed panels as direct children for its layout-profile positioning. 'use no memo' keeps React Compiler from injecting a useMemoCache hook (the conditional inline call must stay hook-free).
  'use no memo';
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
      <ModelsPanel
        key="prepare-models"
        scene={scene}
        outsidePlateModelIds={outsidePlateModelIds}
        handleModelSelection={handleModelSelection}
        handleModelRangeSelection={handleModelRangeSelection}
        handleGroupSelection={handleGroupSelection}
        handleGroupSelectedModels={handleGroupSelectedModels}
        handleUngroupSelectedModels={handleUngroupSelectedModels}
        handleUngroupFolder={handleUngroupFolder}
        handleSplitImportGroup={handleSplitImportGroup}
        handleRenameFolder={handleRenameFolder}
        handleRenameModel={handleRenameModel}
        handleModelListContextMenu={handleModelListContextMenu}
        handleRepairModel={handleRepairModel}
        handleOpenModelSupportsInfo={handleOpenModelSupportsInfo}
        handleAddModels={handleAddModels}
        dimmed={showEmptySceneDialog || importOverlayState.active}
        hidden={!modelsPanelVisible}
        collapsible={modelsPanelCollapsible}
        bottomClearancePx={modelStatsBottomClearancePx}
      />

      {scene.geom && transformMgr.transformMode === 'transform' && (
        <TransformControls
          key="prepare-transform-controls"
          position={scene.selectedModelIds.length > 1
            ? selectionPositionOrigin
            : transformMgr.transform.position}
          onPositionChange={scene.selectedModelIds.length > 1
            ? handlePositionSelectedModels
            : transformMgr.transformHook.setPosition}
          onPositionCommit={scene.selectedModelIds.length > 1
            ? commitPendingSelectionPositionHistory
            : scheduleCommitPendingTransformHistory}
          onCenter={handleCenterSelectedModels}
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
          onResetRotation={transformMgr.transformHook.resetRotation}
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
          onResetScale={transformMgr.transformHook.resetScale}
          uniformScaling={uniformScaling}
          onUniformScalingChange={setUniformScaling}
          localSpace={localTransformSpace}
          onLocalSpaceChange={setLocalTransformSpace}
          modelBBox={scene.geom.bbox}
          autoLift={transformMgr.autoLift}
          onAutoLiftChange={handleAutoLiftChange}
          liftDistance={transformMgr.liftDistance}
          onLiftDistanceChange={transformMgr.setLiftDistance}
          onLift={handleLiftSelectedModels}
          onDrop={handleDropSelectedModels}
          onTransformCommit={scheduleCommitPendingTransformHistory}
        />
      )}

      {scene.geom && transformMgr.transformMode === 'transform' && orientationPanel && (
        <AutoRotationPanel key="prepare-orientation" {...orientationPanel} />
      )}

      {scene.geom && transformMgr.transformMode === 'smoothing' && (
        <MeshSmoothingSettingsPanel key="prepare-smoothing-settings" />
      )}

      {scene.geom && transformMgr.transformMode === 'organicCut' && (
        <OrganicCutPanel
          key="prepare-organic-cut-panel"
          state={organicCut.panelState}
          onStateChange={organicCut.setPanelState}
          onClearLoop={organicCut.clearLoop}
          onSnapToEdges={organicCut.snapActiveLoopToEdges}
          canSnapToEdges={organicCut.canSnapToEdges}
          loopCount={organicCut.loopCount}
          activeLoopIndex={organicCut.activeLoopIndex}
          loopSummaries={organicCut.loopSummaries}
          onSelectLoop={organicCut.selectLoop}
          onAddLoop={organicCut.addLoop}
          canAddLoop={organicCut.canAddLoop}
          onRemoveLoop={organicCut.removeLoop}
          canRemoveLoop={organicCut.canRemoveLoop}
          onApply={organicCut.apply}
          isApplying={organicCut.isApplying}
          canApply={organicCut.canApply}
          tenonFits={organicCut.tenonFits}
          cutError={organicCut.cutError}
          tenonDetail={organicCut.tenonDetail}
        />
      )}

      {scene.models.length > 0 && transformMgr.transformMode === 'arrange' && (
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
      )}

      {scene.models.length > 0 && transformMgr.transformMode === 'duplicate' && (
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
      )}
    </>
  );
}
