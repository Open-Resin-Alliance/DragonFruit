import { IslandScanCard } from '@/components/controls/IslandScanCard';
import { IslandOverlayControls } from '@/components/controls/IslandOverlayControls';
import { IslandVoxelControls } from '@/components/controls/IslandVoxelControls';
import { TerritoryVoxelControls } from '@/components/controls/TerritoryVoxelControls';
import { IslandListCard } from '@/components/controls/IslandListCard';
import { IslandScanWorkflowCard } from '@/volumeAnalysis/IslandScan/workflow/IslandScanWorkflowCard';
import { IslandVolumesHierarchyCard } from '@/volumeAnalysis/IslandVolumes/components/IslandVolumesHierarchyCard';
import type { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import type { useSlicingManager } from '@/features/slicing/useSlicingManager';
import type { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';

export type AnalysisPanelStackProps = {
  scene: ReturnType<typeof useSceneCollectionManager>;
  slicing: ReturnType<typeof useSlicingManager>;
  islands: ReturnType<typeof useIslandManager>;
};

/** ANALYSIS-mode floating panel group: island scan / volume / overlay / voxel cards. */
export function AnalysisPanelStack({
  scene,
  slicing,
  islands,
}: AnalysisPanelStackProps) {
  // Invoked inline by Home (not as <JSX/>) so FloatingPanelStack can flatten these keyed panels as direct children for its layout-profile positioning. 'use no memo' keeps React Compiler from injecting a useMemoCache hook (the conditional inline call must stay hook-free).
  'use no memo';
  return (
    <>
      <IslandScanCard
        key="analysis-scan-card"
        islands={islands}
        hasGeometry={!!scene.geom}
        onLoadSupportJson={scene.handleLoadSupportJson}
        onImportSupportFile={scene.importSupportDataFile}
        pluginImportPhase={scene.pluginImportPhase}
        pluginImportError={scene.pluginImportError}
        onPluginJsonFile={scene.handlePluginJsonFile}
        onPluginStlFile={scene.handlePluginStlFile}
        onCancelPluginImport={scene.cancelPluginImport}
      />

      <IslandScanWorkflowCard key="analysis-workflow" islands={islands} hasGeometry={!!scene.geom} />

      <IslandVolumesHierarchyCard key="analysis-volumes" islands={islands} layerHeightMm={slicing.layerHeightMm} />

      <IslandListCard
        key="analysis-island-list"
        islands={islands.scanData?.islands ?? []}
        selectedIslandId={islands.selectedIslandId}
        onSelectIsland={islands.setSelectedIslandId}
        showMerged={islands.showMerged}
        onShowMergedChange={islands.setShowMerged}
        layerHeightMm={slicing.layerHeightMm}
        zOffsetMm={0}
      />

      <IslandOverlayControls
        key="analysis-overlay-controls"
        enabled={islands.overlayEnabled}
        onEnabledChange={islands.setOverlayEnabled}
        brushRadiusMm={islands.overlayBrushRadius}
        onBrushRadiusChange={islands.setOverlayBrushRadius}
        color={islands.overlayColor}
        onColorChange={islands.setOverlayColor}
        opacity={islands.overlayOpacity}
        onOpacityChange={islands.setOverlayOpacity}
        taper={islands.overlayTaper}
        onTaperChange={islands.setOverlayTaper}
        islandCount={islands.scanData?.islands.length ?? 0}
      />

      <IslandVoxelControls
        key="analysis-island-voxel"
        enabled={islands.voxelEnabled && !islands.voxelShowTerritory}
        onEnabledChange={(e) => {
          if (e) {
            islands.setVoxelEnabled(true);
            islands.setVoxelShowTerritory(false);
          } else {
            islands.setVoxelEnabled(false);
          }
        }}
        opacity={islands.voxelOpacity}
        onOpacityChange={islands.setVoxelOpacity}
        colorScheme={islands.voxelColorScheme}
        onColorSchemeChange={islands.setVoxelColorScheme}
        showMerged={islands.voxelShowMerged}
        onShowMergedChange={islands.setVoxelShowMerged}
        islandCount={islands.scanData?.islands.length ?? 0}
      />

      <TerritoryVoxelControls
        key="analysis-territory-voxel"
        enabled={islands.voxelEnabled && islands.voxelShowTerritory}
        onEnabledChange={(e) => {
          if (e) {
            islands.setVoxelEnabled(true);
            islands.setVoxelShowTerritory(true);
          } else {
            islands.setVoxelEnabled(false);
          }
        }}
        opacity={islands.voxelOpacity}
        onOpacityChange={islands.setVoxelOpacity}
        islandCount={islands.voxelEnabled ? (islands.scanData?.islands.length ?? 0) : (islands.scanData?.islands.length ?? 0)}
        useSurfaceContiguity={islands.useSurfaceContiguity}
        onUseSurfaceContiguityChange={islands.setUseSurfaceContiguity}
        onRescan={islands.onRunScanlineScan}
      />
    </>
  );
}
