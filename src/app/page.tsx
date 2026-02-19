'use client';

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { SceneCanvas } from '@/components/scene/SceneCanvas';
import { FloatingPanelStack } from '@/components/layout/FloatingPanelStack';
import { TopBar } from '@/components/layout/TopBar';
import { LayerSlider } from '@/components/controls/LayerSlider';
import { IslandScanCard } from '@/components/controls/IslandScanCard';
import { IslandOverlayControls } from '@/components/controls/IslandOverlayControls';
import { IslandVoxelControls } from '@/components/controls/IslandVoxelControls';
import { TerritoryVoxelControls } from '@/components/controls/TerritoryVoxelControls';
import { IslandListCard } from '@/components/controls/IslandListCard';
import { ModelManagerPanel } from '@/components/controls/ModelManagerPanel';
import { DebugPrimitivesPanel } from '@/components/controls/DebugPrimitivesPanel';
import { ModelStatsCard } from '@/components/controls/ModelStatsCard';
import { TransformToolbar } from '@/components/controls/TransformToolbar';
import { TransformControls } from '@/components/controls/TransformControls';
import { Sidebar } from '@/components/ui/Sidebar';
import { SupportSidebar } from '@/supports/Settings';
import { CurveSettingsCard } from '@/supports/Curves/CurveSettingsCard';
import { ExportPanel } from '@/features/export/components/ExportPanel';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { MeshSmoothingBrushCursor } from '@/features/mesh-smoothing/MeshSmoothingBrushCursor';

import { initializeBVH } from '@/utils/bvh';

// Domain Features
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { useSlicingManager } from '@/features/slicing/useSlicingManager';
import { useTransformManager } from '@/features/transform/useTransformManager';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';
import { useSupportInteractionManager } from '@/features/supports/useSupportInteractionManager';
import { useUndoRedoHotkeys } from '@/hotkeys/useUndoRedoHotkeys';
import { useDeleteHotkey } from '@/features/delete/useDeleteHotkey';

import { MESH_SHADER_OPTIONS, type MeshShaderType } from '@/features/shaders/mesh';

import { IslandScanWorkflowCard } from '@/volumeAnalysis/IslandScan/workflow/IslandScanWorkflowCard';
import { IslandVolumesHierarchyCard } from '@/volumeAnalysis/IslandVolumes/components/IslandVolumesHierarchyCard';

// Initialize BVH acceleration globally
if (typeof window !== 'undefined') {
  initializeBVH();
  console.log('[App] BVH acceleration initialized');
}

export default function Home() {
  // 1. Scene & Geometry (Multi-Model)
  const scene = useSceneCollectionManager();

  // 2. Transform Management (needs geom for bounds)
  const transformMgr = useTransformManager({ geom: scene.geom });

  // Ref for supports group (used for export)
  const supportsRef = React.useRef<THREE.Group | null>(null);

  // Local state to coordinate transform sync with active model switching
  // This prevents 1-frame flickers where SceneCanvas renders new model with old transform
  const [displayActiveModelId, setDisplayActiveModelId] = React.useState<string | null>(null);

  const [sessionShaderOverride, setSessionShaderOverride] = React.useState<MeshShaderType | null>(null);
  const effectiveShaderType = sessionShaderOverride ?? scene.shaderType;

  // Sync transform manager when active model changes
  useEffect(() => {
    if (scene.activeModelId && scene.activeModel) {
      const t = scene.activeModel.transform;

      console.log('[Home] Syncing transform from model:', {
        id: scene.activeModelId,
        pos: t.position,
        ignoreAutoLift: scene.activeModel.ignoreAutoLift
      });

      // If model requests to ignore auto-lift/snap (e.g. LYS import), disable it in the hook
      if (scene.activeModel.ignoreAutoLift) {
        transformMgr.transformHook.setAutoSnapEnabled(false);
      } else {
        transformMgr.transformHook.setAutoSnapEnabled(true);
      }

      // 1. Update transform manager to match model ONLY if different
      // This prevents infinite loop when model object reference changes but values are same
      const currentT = transformMgr.transform;
      const EPSILON = 0.0001;

      const posChanged = currentT.position.distanceToSquared(t.position) > EPSILON;
      const rotChanged =
        Math.abs(currentT.rotation.x - t.rotation.x) > EPSILON ||
        Math.abs(currentT.rotation.y - t.rotation.y) > EPSILON ||
        Math.abs(currentT.rotation.z - t.rotation.z) > EPSILON;
      const scaleChanged = currentT.scale.distanceToSquared(t.scale) > EPSILON;

      if (posChanged || rotChanged || scaleChanged) {
        transformMgr.transformHook.setPosition(t.position.x, t.position.y, t.position.z);
        transformMgr.transformHook.setRotation(t.rotation.x, t.rotation.y, t.rotation.z);
        transformMgr.transformHook.setScale(t.scale.x, t.scale.y, t.scale.z);
      }

      // 2. Only AFTER updating transform, update the display ID
      setDisplayActiveModelId(scene.activeModelId);
    } else {
      setDisplayActiveModelId(null);
    }
  }, [scene.activeModelId, scene.activeModel]);

  // Sync transform changes from manager back to model store (persistence)
  // This ensures that any change (gizmo, auto-lift, inputs) is saved to the model
  useEffect(() => {
    // Only update if the local transform state has been synchronized with the new model
    // This prevents overwriting the new model's transform with the old transform state on load
    if (scene.activeModelId && displayActiveModelId === scene.activeModelId) {
      scene.updateModelTransform(scene.activeModelId, transformMgr.transform);
    }
  }, [transformMgr.transform, scene.activeModelId, displayActiveModelId]);

  // Wrap transform change to update local state
  const handleTransformChange = (pos: THREE.Vector3, rot: THREE.Euler, scl: THREE.Vector3) => {
    transformMgr.onTransformChange(pos, rot, scl);
  };

  // 3. Slicing (Global context - operates on scene bounds, not just active model)
  const sceneZRange = React.useMemo(() => ({
    min: scene.sceneBounds?.min.z ?? 0,
    max: scene.sceneBounds?.max.z ?? 100 // Default range if empty
  }), [scene.sceneBounds]);

  const slicing = useSlicingManager({
    hasGeometry: scene.models.length > 0,
    zRange: sceneZRange
  });

  // 4. Islands (needs geom & transform & layerHeight)
  const islands = useIslandManager({
    geom: scene.geom,
    transform: transformMgr.transform,
    layerHeightMm: slicing.layerHeightMm
  });

  // 5. Supports
  const supports = useSupportInteractionManager({ mode: scene.mode });

  // Temporary: LYS Ghost Viewer State
  const [ghostData, setGhostData] = React.useState<any>(null);

  useUndoRedoHotkeys();
  useDeleteHotkey();

  const renderId = useRef(0);
  renderId.current++;

  // Glue Logic: Transform End Hook
  // When rotation ends, we must clear scan data as it invalidates the scan
  const handleTransformEnd = (operation: 'move' | 'rotate' | 'scale') => {
    transformMgr.setIsTransforming(false);

    if (operation === 'rotate') {
      console.log('[Rotation] Clearing scan data - rotation invalidates island detection');
      islands.clearScanData();

      // Defer auto-snap
      setTimeout(() => {
        transformMgr.performAutoSnap();
      }, 0);
    } else {
      transformMgr.pendingTransformRef.current = null;
    }
  };

  const handleRotationComplete = () => {
    islands.clearScanData();
    setTimeout(() => {
      transformMgr.performAutoSnap();
    }, 0);
  };

  const handleCameraChange = React.useCallback(() => { }, []);
  const handleCameraEnd = React.useCallback(() => { }, []);

  const sidebarContent = React.useMemo(() => {
    if (scene.mode === 'support') {
      return <SupportSidebar />;
    }

    if (scene.mode === 'analysis') {
      return <div />;
    }

    if (scene.mode === 'prepare') {
      if (transformMgr.transformMode === 'smoothing') {
        return <MeshSmoothingSettingsPanel />;
      }

      return <div />;
    }

    if (scene.mode === 'export') {
      return <div />;
    }

    return <div />;
  }, [scene.mode, transformMgr.transformMode]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100">
      <TopBar
        onFileChange={scene.onFileChange}
        layerHeightMicron={slicing.layerHeightMicron}
        onLayerHeightChange={slicing.setLayerHeightMicron}
        layerHeightMm={slicing.layerHeightMm}
        meshColor={scene.meshColor}
        onMeshColorChange={scene.setMeshColor}
        shaderType={scene.shaderType}
        onShaderTypeChange={scene.setShaderType}
        matcapVariant={scene.matcapVariant}
        onMatcapVariantChange={scene.setMatcapVariant}
        flatUseVertexColors={scene.flatUseVertexColors}
        onFlatUseVertexColorsChange={scene.setFlatUseVertexColors}
        toonSteps={scene.toonSteps}
        onToonStepsChange={scene.setToonSteps}
        ambientIntensity={scene.ambientIntensity}
        onAmbientIntensityChange={scene.setAmbientIntensity}
        directionalIntensity={scene.directionalIntensity}
        onDirectionalIntensityChange={scene.setDirectionalIntensity}
        materialRoughness={scene.materialRoughness}
        onMaterialRoughnessChange={scene.setMaterialRoughness}
        xrayOpacity={scene.xrayOpacity}
        onXrayOpacityChange={scene.setXrayOpacity}
        mode={scene.mode}
        onModeChange={scene.setMode}
        selectionHighlightMode={scene.selectionHighlightMode}
        onSelectionHighlightModeChange={scene.setSelectionHighlightMode}
        onImportLysChange={scene.onImportLysChange}
      />

      <FloatingPanelStack>
        {scene.mode === 'prepare' ? (
          <>
            <ModelManagerPanel
              models={scene.models}
              activeModelId={scene.activeModelId}
              onSelect={scene.setActiveModelId}
              onDelete={scene.deleteModel}
              onVisibilityChange={scene.setModelVisibility}
            />

            <DebugPrimitivesPanel
              onAdd={scene.addDebugPrimitive}
              onClear={scene.clearDebugModels}
            />
          </>
        ) : scene.mode === 'analysis' ? (
          <>
            <IslandScanCard
              islands={islands}
              hasGeometry={!!scene.geom}
              onLoadLychee={scene.handleLoadLychee}
              onImportLycheeFile={scene.importLycheeSupportFile}
              lycheeImportPhase={scene.lycheeImportPhase}
              lycheeImportError={scene.lycheeImportError}
              onLycheeJsonFile={scene.handleLycheeJsonFile}
              onLycheeStlFile={scene.handleLycheeStlFile}
              onCancelLycheeImport={scene.cancelLycheeImport}
            />

            <IslandScanWorkflowCard islands={islands} hasGeometry={!!scene.geom} />

            <IslandVolumesHierarchyCard islands={islands} layerHeightMm={slicing.layerHeightMm} />

            <IslandListCard
              islands={islands.scanData?.islands ?? []}
              selectedIslandId={islands.selectedIslandId}
              onSelectIsland={islands.setSelectedIslandId}
              showMerged={islands.showMerged}
              onShowMergedChange={islands.setShowMerged}
              layerHeightMm={slicing.layerHeightMm}
              zOffsetMm={0}
            />

            <IslandOverlayControls
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
        ) : scene.mode === 'export' ? (
          <ExportPanel activeModel={scene.activeModel} supportsRef={supportsRef} />

        ) : (
          <>
            <CurveSettingsCard />
          </>
        )}
      </FloatingPanelStack>

      <div className="absolute inset-0 top-14 z-0 flex">
        <div id="scene-root" className="relative flex-1">
          <SceneCanvas
            models={scene.models}
            activeModelId={displayActiveModelId}
            clipLower={slicing.clipLower}
            clipUpper={slicing.clipUpper}
            meshColor={scene.meshColor}
            meshVisible={scene.meshVisible}
            shaderType={effectiveShaderType}
            matcapVariant={scene.matcapVariant}
            flatUseVertexColors={scene.flatUseVertexColors}
            toonSteps={scene.toonSteps}
            xrayOpacity={scene.xrayOpacity}
            disableRaycast={transformMgr.isTransforming}
            hideCrossSectionCap={false}
            onCameraChange={handleCameraChange}
            onCameraEnd={handleCameraEnd}
            islandMarkers={[
              ...(islands.overlayEnabled ? islands.islandMarkers : []),
            ] as any}
            overlayBrushRadius={islands.overlayBrushRadius}
            overlayColor={islands.overlayColor}
            overlayOpacity={islands.overlayOpacity}
            overlaySelectedIslandId={islands.selectedIslandId}
            ambientIntensity={scene.ambientIntensity}
            directionalIntensity={scene.directionalIntensity}
            materialRoughness={scene.materialRoughness}
            scanResults={islands.scanData}
            layerHeightMm={slicing.layerHeightMm}
            scanBBox={islands.scanBBox}
            showIslandIdLabels={islands.showIslandIdLabels}
            voxelEnabled={islands.voxelEnabled}
            voxelColorScheme={islands.voxelColorScheme}
            voxelSelectedIslandId={islands.selectedIslandId}
            voxelShowMerged={islands.voxelShowMerged}
            voxelShowTerritory={islands.voxelShowTerritory}
            voxelOpacity={islands.voxelOpacity}
            transformMode={transformMgr.transformMode}
            transform={transformMgr.transform}
            onTransformChange={handleTransformChange}
            onTransformEnd={handleTransformEnd}
            mode={scene.mode}
            onSupportClick={supports.onModelClick}
            onSupportHover={supports.onModelHover}
            onActiveModelChange={scene.setActiveModelId}
            trunkPlacementPreview={supports.trunkPlacementV2.previewData}
            branchPlacementPreview={supports.branchPlacement.previewData}
            leafPlacementPreview={supports.leafPlacement.previewData}
            bracePlacementPreview={supports.bracePreview}
            supportBracePlacementPreview={supports.supportBracePreview}
            blockSupportPlacement={supports.isPlacementDisabled}
            isBranchPlacementActive={supports.branchPlacement.isActive}
            isLeafPlacementActive={supports.leafPlacement.isActive}
            isBracePlacementActive={supports.bracePlacement.isActive}
            isSupportBracePlacementActive={supports.supportBracePlacement.isActive}
            branchTipPosition={supports.branchPlacement.tipPosition}
            branchHoverPosition={supports.branchPlacement.hoverPosition}
            leafTipPosition={supports.leafPlacement.tipPosition}
            leafHoverPosition={supports.leafPlacement.hoverPosition}
            gpuPickingTest={false}
            selectionHighlightMode={scene.selectionHighlightMode}
            crossSectionMode={slicing.crossSectionMode}
            pxMm={islands.pxMm}
            supportsRef={supportsRef}
            ghostData={ghostData}
          >
            {scene.mode === 'prepare' && transformMgr.transformMode === 'smoothing' && (
              <MeshSmoothingBrushCursor />
            )}
          </SceneCanvas>

          <div className="absolute top-2 right-2 z-20">
            <select
              value={sessionShaderOverride ?? ''}
              onChange={(e) => setSessionShaderOverride((e.target.value || null) as MeshShaderType | null)}
              className="rounded border border-neutral-700 bg-neutral-900/80 text-neutral-200 focus:outline-none focus:ring-0"
              style={{ fontSize: 10, padding: '1px 4px', height: 18 }}
              title="Session shader (does not change defaults)"
            >
              <option value="">Default</option>
              {MESH_SHADER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Transform Toolbar */}
          {scene.geom && scene.mode === 'prepare' && (
            <>
              <TransformToolbar
                mode={transformMgr.transformMode}
                onModeChange={transformMgr.setTransformMode}
              />

              {/* Transform Controls Panel */}
              {transformMgr.transformMode === 'transform' && (
                <TransformControls
                  position={transformMgr.transform.position}
                  onPositionChange={transformMgr.transformHook.setPosition}
                  onCenter={transformMgr.transformHook.centerXY}
                  onPlatform={transformMgr.transformHook.setPlatformZ}
                  rotation={transformMgr.transform.rotation}
                  onRotationChange={transformMgr.transformHook.setRotation}
                  onResetRotation={transformMgr.transformHook.resetRotation}
                  onRotationComplete={handleRotationComplete}
                  scale={transformMgr.transform.scale}
                  onScaleChange={transformMgr.transformHook.setScale}
                  onResetScale={transformMgr.transformHook.resetScale}
                  modelBBox={scene.geom.bbox}
                  autoLift={transformMgr.autoLift}
                  onAutoLiftChange={transformMgr.setAutoLift}
                  liftDistance={transformMgr.liftDistance}
                  onLiftDistanceChange={transformMgr.setLiftDistance}
                  onLift={() => {
                    const lowestWorldZ = transformMgr.getLowestWorldZ();
                    if (lowestWorldZ !== null) transformMgr.transformHook.snapToLift(lowestWorldZ, transformMgr.liftDistance);
                  }}
                  onDrop={() => {
                    const lowestWorldZ = transformMgr.getLowestWorldZ();
                    if (lowestWorldZ !== null) transformMgr.transformHook.snapToPlatform(lowestWorldZ);
                  }}
                />
              )}
            </>
          )}

          {/* Model Info Overlay Card */}
          <ModelStatsCard
            model={scene.models.find(m => m.id === displayActiveModelId) || null}
            numLayers={slicing.numLayers}
            heightMm={slicing.heightMm}
          />

          <LayerSlider
            min={0}
            max={slicing.numLayers}
            step={1}
            value={slicing.layerIndex}
            onChange={(v) => slicing.setLayerIndex(Math.round(v))}
            currentHeightMm={slicing.currentHeightMm}
            maxHeightMm={slicing.heightMm}
            showValue={true}
            onToggleMode={() => slicing.setCrossSectionMode(prev => prev === 'smooth' ? 'rasterized' : 'smooth')}
            crossSectionMode={slicing.crossSectionMode}
            className="right-0"
          />
        </div>

        <Sidebar side="right" fixed={false} widthClass="w-80" className="border-l border-neutral-800" contentClassName="space-y-0">
          {sidebarContent}
        </Sidebar>
      </div>

    </div>
  );
}
