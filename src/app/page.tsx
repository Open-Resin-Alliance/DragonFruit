'use client';

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { SceneCanvas } from '@/components/scene/SceneCanvas';
import { FloatingPanelStack } from '@/components/layout/FloatingPanelStack';
import { TopBar } from '@/components/layout/TopBar';
import { EmptySceneState } from '@/components/layout/EmptySceneState';
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
import { VisualSettingsPanel } from '@/components/controls/VisualSettingsPanel';
import { SupportSidebar } from '@/supports/Settings';
import { CurveSettingsCard } from '@/supports/Curves/CurveSettingsCard';
import { ExportPanel } from '@/features/export/components/ExportPanel';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { MeshSmoothingBrushCursor } from '@/features/mesh-smoothing/MeshSmoothingBrushCursor';
import { IconButton } from '@/components/ui/primitives';
import { EditorContextMenu, type EditorMenuAction } from '@/components/ui/EditorContextMenu';
import {
  DEBUG_PRIMITIVES_PANEL_VISIBILITY_EVENT,
  isDebugPrimitivesPanelVisibleEnabled,
} from '@/components/layout/floatingLayoutPreferences';

import { initializeBVH } from '@/utils/bvh';

// Domain Features
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { useSlicingManager } from '@/features/slicing/useSlicingManager';
import { useTransformManager } from '@/features/transform/useTransformManager';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';
import { useSupportInteractionManager } from '@/features/supports/useSupportInteractionManager';
import { useUndoRedoHotkeys } from '@/hotkeys/useUndoRedoHotkeys';
import { useDeleteHotkey } from '@/features/delete/useDeleteHotkey';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import { useCameraProjectionHotkey } from '@/hotkeys/useCameraProjectionHotkey';
import { getSavedCameraProjectionSettings, saveCameraProjectionSettings } from '@/components/settings/cameraProjectionPreferences';
import { getSavedWorkspaceCameraSettings } from '@/components/settings/workspaceCameraPreferences';

import { type MeshShaderType } from '@/features/shaders/mesh';

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
  const [isPrepareDragActive, setIsPrepareDragActive] = React.useState(false);
  const [prepareSmoothingSettingsExpanded, setPrepareSmoothingSettingsExpanded] = React.useState(true);
  const [supportSettingsExpanded, setSupportSettingsExpanded] = React.useState(true);
  const [debugPrimitivesPanelVisible, setDebugPrimitivesPanelVisible] = React.useState<boolean>(true);
  const [editorContextMenuPos, setEditorContextMenuPos] = React.useState<{ x: number; y: number } | null>(null);
  const [isSelectAllModelsActive, setIsSelectAllModelsActive] = React.useState(false);
  const dragDepthRef = React.useRef(0);
  const rightClickGestureRef = React.useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const handleDroppedMeshFiles = React.useCallback((files: File[]) => {
    if (scene.mode !== 'prepare') return;

    const meshFiles = files.filter((file) => file.name.toLowerCase().endsWith('.stl'));
    if (meshFiles.length === 0) {
      console.warn('[DragDrop] No supported mesh files dropped. STL is supported for now.');
      return;
    }

    const dt = new DataTransfer();
    meshFiles.forEach((file) => dt.items.add(file));
    void scene.loadFiles(dt.files);
  }, [scene]);

  const handlePrepareDragEnter = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsPrepareDragActive(true);
  }, [scene.mode]);

  const handlePrepareDragOver = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setIsPrepareDragActive(true);
  }, [scene.mode]);

  const handlePrepareDragLeave = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsPrepareDragActive(false);
    }
  }, [scene.mode]);

  const handlePrepareDrop = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsPrepareDragActive(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    handleDroppedMeshFiles(files);
  }, [handleDroppedMeshFiles, scene.mode]);

  const closeEditorContextMenu = React.useCallback(() => {
    setEditorContextMenuPos(null);
  }, []);

  const handleEditorContextMenu = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const gesture = rightClickGestureRef.current;
    if (gesture && gesture.moved) {
      return;
    }

    setEditorContextMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleModelListContextMenu = React.useCallback((modelId: string, position: { x: number; y: number }) => {
    // Right-clicking a model row should target that model first.
    scene.setActiveModelId(modelId);
    setEditorContextMenuPos(position);
  }, [scene]);

  const handleEditorPointerDownCapture = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 2) return;
    rightClickGestureRef.current = { x: e.clientX, y: e.clientY, moved: false };
  }, []);

  const handleEditorPointerMoveCapture = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const gesture = rightClickGestureRef.current;
    if (!gesture) return;
    const dx = e.clientX - gesture.x;
    const dy = e.clientY - gesture.y;
    if ((dx * dx + dy * dy) > 36) {
      gesture.moved = true;
    }
  }, []);

  const handleEditorPointerUpCapture = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 2) return;
    // keep gesture state until contextmenu fires, clear shortly after
    window.setTimeout(() => {
      rightClickGestureRef.current = null;
    }, 0);
  }, []);

  const handleEditorMenuAction = React.useCallback((action: EditorMenuAction) => {
    switch (action) {
      case 'delete':
        if (scene.activeModelId) {
          scene.deleteModel(scene.activeModelId);
        }
        break;
      case 'copy':
        if (scene.activeModelId) {
          scene.copyModel(scene.activeModelId);
        }
        break;
      case 'cut':
        if (scene.activeModelId) {
          scene.cutModel(scene.activeModelId);
        }
        break;
      case 'paste':
        scene.pasteModel();
        break;
      case 'duplicate':
      case 'arrange':
      case 'repair':
      default:
        // intentionally disabled in the menu for now
        break;
    }
    closeEditorContextMenu();
  }, [closeEditorContextMenu, scene]);

  React.useEffect(() => {
    if (!editorContextMenuPos) return;

    const handlePointerDown = () => closeEditorContextMenu();
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeEditorContextMenu();
    };
    const handleScrollOrResize = () => closeEditorContextMenu();

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
    };
  }, [editorContextMenuPos, closeEditorContextMenu]);

  React.useEffect(() => {
    setDebugPrimitivesPanelVisible(isDebugPrimitivesPanelVisibleEnabled());

    const handleDebugPanelVisibilityChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ enabled?: boolean }>;
      const nextEnabled = customEvent.detail?.enabled;
      if (typeof nextEnabled === 'boolean') {
        setDebugPrimitivesPanelVisible(nextEnabled);
      } else {
        setDebugPrimitivesPanelVisible(isDebugPrimitivesPanelVisibleEnabled());
      }
    };

    window.addEventListener(DEBUG_PRIMITIVES_PANEL_VISIBILITY_EVENT, handleDebugPanelVisibilityChanged as EventListener);
    return () => {
      window.removeEventListener(DEBUG_PRIMITIVES_PANEL_VISIBILITY_EVENT, handleDebugPanelVisibilityChanged as EventListener);
    };
  }, []);

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

  const handleModeChange = React.useCallback((nextMode: typeof scene.mode) => {
    if (scene.models.length === 0 && nextMode !== 'prepare') {
      scene.setMode('prepare');
      return;
    }
    scene.setMode(nextMode);
  }, [scene]);

  // Temporary: LYS Ghost Viewer State
  const [ghostData, setGhostData] = React.useState<any>(null);

  useUndoRedoHotkeys();
  useDeleteHotkey();
  useCameraProjectionHotkey();

  // Auto-set cross-section mode based on app mode
  React.useEffect(() => {
    slicing.setCrossSectionMode(scene.mode === 'export' ? 'rasterized' : 'smooth');
  }, [scene.mode, slicing.setCrossSectionMode]);

  React.useEffect(() => {
    if (scene.models.length > 0) return;
    if (scene.mode === 'prepare') return;
    scene.setMode('prepare');
  }, [scene.mode, scene.models.length, scene.setMode]);

  React.useEffect(() => {
    if (scene.mode !== 'export') return;
    if (scene.activeModelId) return;
    if (scene.models.length === 0) return;

    const firstVisible = scene.models.find((model) => model.visible) ?? scene.models[0];
    if (firstVisible) {
      scene.setActiveModelId(firstVisible.id);
    }
  }, [scene.mode, scene.activeModelId, scene.models, scene.setActiveModelId]);

  React.useEffect(() => {
    const workspaceProjectionMode = getSavedWorkspaceCameraSettings().defaults[scene.mode];
    const currentProjectionMode = getSavedCameraProjectionSettings().mode;

    if (workspaceProjectionMode !== currentProjectionMode) {
      saveCameraProjectionSettings({ mode: workspaceProjectionMode });
    }
  }, [scene.mode]);

  React.useEffect(() => {
    if (scene.mode !== 'support') return;
    if (scene.activeModelId) return;
    if (scene.models.length === 0) return;

    const firstVisible = scene.models.find((model) => model.visible) ?? scene.models[0];
    if (firstVisible) {
      scene.setActiveModelId(firstVisible.id);
    }
  }, [scene.mode, scene.activeModelId, scene.models, scene.setActiveModelId]);

  const importOverlayState = React.useMemo(() => {
    if (scene.importProgress.active) {
      return {
        active: true,
        label: scene.importProgress.label || (scene.importProgress.type === 'scene' ? 'Importing scene…' : 'Loading mesh…'),
        detail: scene.importProgress.detail,
        progress: scene.importProgress.progress,
      };
    }

    if (scene.isLysLoading) {
      return {
        active: true,
        label: 'Importing scene…',
        detail: 'Parsing and applying scene transforms',
        progress: null as number | null,
      };
    }

    if (scene.lycheeImportPhase === 'processing') {
      return {
        active: true,
        label: 'Importing Lychee scene…',
        detail: 'Converting support data and model metadata',
        progress: null as number | null,
      };
    }

    return {
      active: false,
      label: '',
      detail: '',
      progress: null as number | null,
    };
  }, [scene.importProgress, scene.isLysLoading, scene.lycheeImportPhase]);

  const showInlineEmptyLoading = scene.models.length === 0 && importOverlayState.active;
  const showSceneImportOverlay = scene.models.length > 0 && importOverlayState.active;
  const showEmptySceneDialog = scene.models.length === 0;

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

  React.useEffect(() => {
    if (scene.mode === 'prepare') return;
    if (!isSelectAllModelsActive) return;
    setIsSelectAllModelsActive(false);
  }, [isSelectAllModelsActive, scene.mode]);

  React.useEffect(() => {
    const unregister = registerDeleteHandler(
      () => scene.mode === 'prepare' && isSelectAllModelsActive && scene.models.length > 0,
      () => {
        const ids = scene.models.map((model) => model.id);
        ids.forEach((id) => scene.deleteModel(id));
        setIsSelectAllModelsActive(false);
      },
      20,
    );

    return () => {
      unregister();
    };
  }, [isSelectAllModelsActive, scene]);

  React.useEffect(() => {
    if (!isSelectAllModelsActive) return;

    const clearSelectAll = () => setIsSelectAllModelsActive(false);
    window.addEventListener('model-clicked', clearSelectAll as EventListener);
    window.addEventListener('model-deselected', clearSelectAll as EventListener);

    return () => {
      window.removeEventListener('model-clicked', clearSelectAll as EventListener);
      window.removeEventListener('model-deselected', clearSelectAll as EventListener);
    };
  }, [isSelectAllModelsActive]);

  React.useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const handleGlobalSelectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'a') return;
      if (isEditableTarget(event.target)) return;
      if (scene.mode !== 'prepare') return;
      if (scene.models.length === 0) return;

      // Prevent browser-level "select all text in the app" behavior and arm model select-all.
      event.preventDefault();
      event.stopPropagation();
      setIsSelectAllModelsActive(true);
    };

    window.addEventListener('keydown', handleGlobalSelectAll, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalSelectAll, true);
    };
  }, [scene.mode, scene.models.length]);

  return (
    <div className="ui-shell relative h-screen w-screen overflow-hidden">
      <TopBar
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
        hoverTintStrength={scene.hoverTintStrength}
        onHoverTintStrengthChange={scene.setHoverTintStrength}
        selectedTintStrength={scene.selectedTintStrength}
        onSelectedTintStrengthChange={scene.setSelectedTintStrength}
        selectionHighlightMode={scene.selectionHighlightMode}
        onSelectionHighlightModeChange={scene.setSelectionHighlightMode}
        debugPrimitivesPanelVisible={debugPrimitivesPanelVisible}
        onDebugPrimitivesPanelVisibleChange={setDebugPrimitivesPanelVisible}
        mode={scene.mode}
        onModeChange={handleModeChange}
        hasModels={scene.models.length > 0}
        viewTypeOverride={sessionShaderOverride}
        onViewTypeOverrideChange={setSessionShaderOverride}
      />

      <FloatingPanelStack>
        {scene.mode === 'prepare' ? (
          <>
            <ModelManagerPanel
              key="prepare-models"
              models={scene.models}
              activeModelId={scene.activeModelId}
              onSelect={scene.setActiveModelId}
              onModelContextMenu={handleModelListContextMenu}
              onDelete={scene.deleteModel}
              onVisibilityChange={scene.setModelVisibility}
              onLoadMeshChange={scene.onFileChange}
              onImportSceneChange={scene.onImportLysChange}
              dimmed={showEmptySceneDialog || importOverlayState.active}
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

            {scene.geom && transformMgr.transformMode === 'smoothing' && (
              <div
                key="prepare-smoothing-settings"
                className="ui-panel rounded-lg border shadow-lg overflow-hidden"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <div
                  className="px-2.5 py-2.5 flex items-center gap-2.5"
                >
                  <IconButton
                    onClick={() => setPrepareSmoothingSettingsExpanded((prev) => !prev)}
                    className="!p-0.5"
                    title={prepareSmoothingSettingsExpanded ? 'Collapse card' : 'Expand card'}
                  >
                    <svg
                      className="w-3 h-3 transform transition-transform"
                      style={{ color: prepareSmoothingSettingsExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      {prepareSmoothingSettingsExpanded ? (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      ) : (
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      )}
                    </svg>
                  </IconButton>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Mesh Smoothing Settings
                  </h3>
                </div>
                {prepareSmoothingSettingsExpanded && (
                  <div className="max-h-[calc(100vh-var(--topbar-height)-88px)] overflow-hidden">
                    <MeshSmoothingSettingsPanel />
                  </div>
                )}
              </div>
            )}
          </>
        ) : scene.mode === 'analysis' ? (
          <>
            <IslandScanCard
              key="analysis-scan-card"
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
        ) : scene.mode === 'export' ? (
          <ExportPanel
            key="export-main"
            models={scene.models}
            activeModel={scene.activeModel}
            activeModelId={scene.activeModelId}
            onActiveModelChange={scene.setActiveModelId}
            supportsRef={supportsRef}
          />

        ) : scene.mode === 'support' ? (
          <>
            <CurveSettingsCard key="curve-settings" />

            <div
              key="support-settings"
              className="ui-panel rounded-lg border shadow-lg overflow-hidden"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <div
                className="px-2.5 py-2.5 flex items-center gap-2.5"
              >
                <IconButton
                  onClick={() => setSupportSettingsExpanded((prev) => !prev)}
                  className="!p-0.5"
                  title={supportSettingsExpanded ? 'Collapse card' : 'Expand card'}
                >
                  <svg
                    className="w-3 h-3 transform transition-transform"
                    style={{ color: supportSettingsExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    {supportSettingsExpanded ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    )}
                  </svg>
                </IconButton>
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Support Settings
                </h3>
              </div>
              {supportSettingsExpanded && (
                <div className="max-h-[calc(100vh-var(--topbar-height)-88px)] overflow-hidden">
                  <SupportSidebar />
                </div>
              )}
            </div>
          </>
        ) : (
          <>
          </>
        )}

        {scene.models.length > 0 && (
          <VisualSettingsPanel
            key="visual-settings"
            layerIndex={slicing.layerIndex}
            maxLayers={slicing.numLayers}
            onLayerIndexChange={slicing.setLayerIndex}
            currentHeightMm={slicing.currentHeightMm}
            maxHeightMm={slicing.heightMm}
            crossSectionMode={slicing.crossSectionMode}
          />
        )}
      </FloatingPanelStack>

      <div className="absolute inset-0 top-14 z-0">
        <div
          id="scene-root"
          className="relative h-full w-full"
          onPointerDownCapture={handleEditorPointerDownCapture}
          onPointerMoveCapture={handleEditorPointerMoveCapture}
          onPointerUpCapture={handleEditorPointerUpCapture}
          onContextMenuCapture={handleEditorContextMenu}
          onDragEnter={handlePrepareDragEnter}
          onDragOver={handlePrepareDragOver}
          onDragLeave={handlePrepareDragLeave}
          onDrop={handlePrepareDrop}
        >
          {scene.models.length === 0 && (
            <EmptySceneState
              onFileChange={scene.onFileChange}
              onImportSceneChange={scene.onImportLysChange}
              onDropMeshFiles={handleDroppedMeshFiles}
              isLoading={showInlineEmptyLoading}
              loadingLabel={importOverlayState.label}
              loadingDetail={importOverlayState.detail}
            />
          )}

          {scene.mode === 'prepare' && isPrepareDragActive && (
            <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center">
              <div
                className="rounded-lg border border-dashed px-6 py-4 text-center"
                style={{
                  borderColor: 'var(--accent)',
                  background: 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
                }}
              >
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Drop mesh files to import
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  STL supported now • 3MF coming soon
                </div>
              </div>
            </div>
          )}

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
            blockSupportPlacement={supports.isPlacementDisabled}
            isBranchPlacementActive={supports.branchPlacement.isActive}
            isLeafPlacementActive={supports.leafPlacement.isActive}
            isBracePlacementActive={supports.bracePlacement.isActive}
            branchTipPosition={supports.branchPlacement.tipPosition}
            branchHoverPosition={supports.branchPlacement.hoverPosition}
            leafTipPosition={supports.leafPlacement.tipPosition}
            leafHoverPosition={supports.leafPlacement.hoverPosition}
            gpuPickingTest={false}
            selectionHighlightMode={scene.selectionHighlightMode}
            hoverTintStrength={scene.hoverTintStrength}
            selectedTintStrength={scene.selectedTintStrength}
            crossSectionMode={slicing.crossSectionMode}
            pxMm={islands.pxMm}
            supportsRef={supportsRef}
            ghostData={ghostData}
          >
            {scene.mode === 'prepare' && transformMgr.transformMode === 'smoothing' && (
              <MeshSmoothingBrushCursor />
            )}
          </SceneCanvas>

          {/* Transform Toolbar */}
          {scene.geom && scene.mode === 'prepare' && (
            <>
              <TransformToolbar
                mode={transformMgr.transformMode}
                onModeChange={transformMgr.setTransformMode}
              />
            </>
          )}

          {/* Model Info Overlay Card */}
          <ModelStatsCard
            model={scene.models.find(m => m.id === displayActiveModelId) || null}
            numLayers={slicing.numLayers}
            heightMm={slicing.heightMm}
          />

          {showSceneImportOverlay && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-[1px]">
              <div
                className="w-[min(460px,90vw)] rounded-xl border px-5 py-4 shadow-xl"
                style={{
                  background: 'color-mix(in srgb, var(--surface-0), black 8%)',
                  borderColor: 'var(--border-subtle)',
                }}
              >
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {importOverlayState.label}
                </div>
                {importOverlayState.detail && (
                  <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {importOverlayState.detail}
                  </div>
                )}

                <div
                  className="ui-loading-track mt-3 h-2.5 w-full rounded-full"
                  style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                >
                  <div
                    className="ui-loading-indicator"
                    style={{ background: 'linear-gradient(90deg, var(--accent), #ff79c6)' }}
                  />
                </div>
              </div>
            </div>
          )}


        </div>
      </div>

      <EditorContextMenu
        position={editorContextMenuPos}
        onAction={handleEditorMenuAction}
        disabledActions={[
          ...(!scene.activeModelId ? (['delete', 'cut', 'copy'] as const) : []),
          'duplicate',
          'arrange',
          'repair',
        ]}
      />

    </div>
  );
}
