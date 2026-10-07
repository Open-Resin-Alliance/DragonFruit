import React from 'react';
import { ModelManagerPanel } from '@/components/controls/ModelManagerPanel';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';

/**
 * The model list panel, as both Prepare and Support mount it. It exists so the
 * two modes can render the same panel with the same wiring without either of them
 * carrying the other's copy of it: the window layout system keys panels by the
 * React key, so each mode passes its own — `prepare-models` in Prepare,
 * `support-models` in Support.
 */
export type ModelsPanelProps = {
  scene: ReturnType<typeof useSceneCollectionManager>;
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
  handleAddModels: React.ComponentProps<typeof ModelManagerPanel>['onAddModels'];
  dimmed: boolean;
  hidden: boolean;
  /** Collapsible only while the tool rail is a bar; see ModelManagerPanel. */
  collapsible: boolean;
  bottomClearancePx: number;
};

export function ModelsPanel({
  scene,
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
  dimmed,
  hidden,
  collapsible,
  bottomClearancePx,
}: ModelsPanelProps) {
  return (
    <ModelManagerPanel
      models={scene.models}
      outsidePlateModelIds={outsidePlateModelIds}
      activeModelId={scene.activeModelId}
      selectedModelIds={scene.selectedModelIds}
      onAddModels={handleAddModels}
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
      dimmed={dimmed}
      hidden={hidden}
      collapsible={collapsible}
      bottomClearancePx={bottomClearancePx}
    />
  );
}
