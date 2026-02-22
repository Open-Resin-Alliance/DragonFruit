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
import { ModelManagerPanel } from '../components/controls/ModelManagerPanel';
import { DebugPrimitivesPanel } from '@/components/controls/DebugPrimitivesPanel';
import { ModelStatsCard } from '@/components/controls/ModelStatsCard';
import { TransformToolbar } from '@/components/controls/TransformToolbar';
import { TransformControls } from '@/components/controls/TransformControls';
import {
  ArrangePanel,
  type ArrangeAnchorMode,
  type ArrangeLayoutMode,
  type ArrangePrecisionMode,
} from '@/components/controls/ArrangePanel';
import { DuplicatePanel, type DuplicateLayoutMode } from '../components/controls/DuplicatePanel';
import { VisualSettingsPanel } from '@/components/controls/VisualSettingsPanel';
import { SupportSidebar } from '@/supports/Settings';
import { CurveSettingsCard } from '@/supports/Curves/CurveSettingsCard';
import { ExportPanel } from '@/features/export/components/ExportPanel';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { MeshSmoothingBrushCursor } from '@/features/mesh-smoothing/MeshSmoothingBrushCursor';
import { IconButton } from '@/components/ui/primitives';
import { EditorContextMenu, type EditorMenuAction } from '@/components/ui/EditorContextMenu';
import { DiagnosticsModal } from '@/components/modals/DiagnosticsModal';
import {
  DEBUG_PRIMITIVES_PANEL_VISIBILITY_EVENT,
  isDebugPrimitivesPanelVisibleEnabled,
} from '@/components/layout/floatingLayoutPreferences';

import { initializeBVH } from '@/utils/bvh';
import {
  computeApproxModelWorldBounds,
  computePreciseModelWorldBounds,
  isBoundsOutsideVolume,
  shouldUsePreciseBoundsForTransform,
} from '@/utils/modelBounds';
import { convexHull2d } from '@/supports/Rafts/Crenelated/geometry/convexHull2d';

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
import { usePrepareTransformHotkeys } from '@/hotkeys/usePrepareTransformHotkeys';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import { getSavedCameraProjectionSettings, saveCameraProjectionSettings } from '@/components/settings/cameraProjectionPreferences';
import { getSavedWorkspaceCameraSettings } from '@/components/settings/workspaceCameraPreferences';
import { openProfileSettingsModal } from '@/components/settings/profileModalEvents';
import {
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';

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
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const hasActivePrinterProfile = Boolean(activePrinterProfile);

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
  const [isSupportSpotlightHoldActive, setIsSupportSpotlightHoldActive] = React.useState(false);
  const [allowPrepareWithoutPrinter, setAllowPrepareWithoutPrinter] = React.useState(false);
  const [prepareSmoothingSettingsExpanded, setPrepareSmoothingSettingsExpanded] = React.useState(true);
  const [supportSettingsExpanded, setSupportSettingsExpanded] = React.useState(true);
  const [debugPrimitivesPanelVisible, setDebugPrimitivesPanelVisible] = React.useState<boolean>(true);
  const [editorContextMenuPos, setEditorContextMenuPos] = React.useState<{ x: number; y: number } | null>(null);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = React.useState(false);
  const [isSelectAllModelsActive, setIsSelectAllModelsActive] = React.useState(false);
  const [arrangeSpacingMm, setArrangeSpacingMm] = React.useState(0.5);
  const [arrangePrecisionMode, setArrangePrecisionMode] = React.useState<ArrangePrecisionMode>('standard');
  const [arrangeAllowRotateOnZ, setArrangeAllowRotateOnZ] = React.useState(false);
  const [arrangeLayoutMode, setArrangeLayoutMode] = React.useState<ArrangeLayoutMode>('auto');
  const [arrangeAnchorMode, setArrangeAnchorMode] = React.useState<ArrangeAnchorMode>('center');
  const [arrangeArrayCountX, setArrangeArrayCountX] = React.useState(3);
  const [arrangeArrayCountY, setArrangeArrayCountY] = React.useState(2);
  const [arrangeArrayCountZ, setArrangeArrayCountZ] = React.useState(1);
  const [arrangeArrayGapX, setArrangeArrayGapX] = React.useState(5);
  const [arrangeArrayGapY, setArrangeArrayGapY] = React.useState(5);
  const [arrangeArrayGapZ, setArrangeArrayGapZ] = React.useState(5);
  const [isAutoArranging, setIsAutoArranging] = React.useState(false);
  const [duplicateTotalCopies, setDuplicateTotalCopies] = React.useState(2);
  const [duplicateSpacingMm, setDuplicateSpacingMm] = React.useState(0.5);
  const [duplicateLayoutMode, setDuplicateLayoutMode] = React.useState<DuplicateLayoutMode>('auto');
  const [duplicateArrayCountX, setDuplicateArrayCountX] = React.useState(2);
  const [duplicateArrayCountY, setDuplicateArrayCountY] = React.useState(1);
  const [duplicateArrayCountZ, setDuplicateArrayCountZ] = React.useState(1);
  const [duplicateArrayGapX, setDuplicateArrayGapX] = React.useState(5);
  const [duplicateArrayGapY, setDuplicateArrayGapY] = React.useState(5);
  const [duplicateArrayGapZ, setDuplicateArrayGapZ] = React.useState(5);
  const [isDuplicating, setIsDuplicating] = React.useState(false);
  const [duplicatePreviewTransforms, setDuplicatePreviewTransforms] = React.useState<Array<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  }>>([]);
  const [arrangeArrayPreviewItems, setArrangeArrayPreviewItems] = React.useState<Array<{
    model: (typeof scene.models)[number];
    transform: {
      position: THREE.Vector3;
      rotation: THREE.Euler;
      scale: THREE.Vector3;
    };
  }>>([]);
  const [duplicateSourcePreviewTransform, setDuplicateSourcePreviewTransform] = React.useState<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  } | null>(null);
  const [duplicateApplySourceModel, setDuplicateApplySourceModel] = React.useState<(typeof scene.models)[number] | null>(null);
  const [duplicateApplySourceTransform, setDuplicateApplySourceTransform] = React.useState<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  } | null>(null);
  const dragDepthRef = React.useRef(0);
  const arrangeHullFootprintCacheRef = React.useRef<Map<string, {
    points: THREE.Vector2[];
    halfW: number;
    halfD: number;
    localMinX: number;
    localMaxX: number;
    localMinY: number;
    localMaxY: number;
  }>>(new Map());

  React.useEffect(() => {
    if (arrangePrecisionMode !== 'high_precision') return;
    if (arrangeAllowRotateOnZ) return;
    setArrangeAllowRotateOnZ(true);
  }, [arrangePrecisionMode, arrangeAllowRotateOnZ]);
  const rightClickGestureRef = React.useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const cameraResumeTimeoutRef = React.useRef<number | null>(null);
  const { getHotkey } = useHotkeyConfig();
  const supportSpotlightHoldHotkey = getHotkey('SUPPORTS', 'TEMP_SPOTLIGHT_HOLD');

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
    if (!scene.selectedModelIds.includes(modelId)) {
      scene.selectModel(modelId, 'single');
    }
    setEditorContextMenuPos(position);
  }, [scene]);

  const handleModelSelection = React.useCallback((modelId: string, mode: 'single' | 'toggle' | 'add' = 'single') => {
    scene.selectModel(modelId, mode);
  }, [scene]);

  const handleModelRangeSelection = React.useCallback((ids: string[], activeId: string, mode: 'replace' | 'add' = 'replace') => {
    if (ids.length === 0) return;

    if (mode === 'add') {
      scene.setSelectedModelIds((prev) => Array.from(new Set([...prev, ...ids])));
    } else {
      scene.setSelectedModelIds(ids);
    }
    scene.setActiveModelId(activeId);
  }, [scene]);

  const handleGroupSelection = React.useCallback((groupId: string, mode: 'single' | 'add' = 'single') => {
    scene.selectGroup(groupId, mode);
  }, [scene]);

  const handleGroupSelectedModels = React.useCallback((modelIds: string[]) => {
    scene.groupModels(modelIds);
  }, [scene]);

  const handleUngroupSelectedModels = React.useCallback((modelIds: string[]) => {
    scene.ungroupModels(modelIds);
  }, [scene]);

  const handleUngroupFolder = React.useCallback((groupId: string) => {
    scene.ungroupGroup(groupId);
  }, [scene]);

  const handleRenameFolder = React.useCallback((groupId: string, nextName: string) => {
    scene.renameGroup(groupId, nextName);
  }, [scene]);

  const handleSceneModelSelection = React.useCallback((modelId: string | null, options?: { selectionMode?: 'single' | 'toggle' | 'add' }) => {
    if (modelId == null) {
      scene.clearModelSelection();
      return;
    }
    scene.selectModel(modelId, options?.selectionMode ?? 'single');
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
        if (scene.selectedModelIds.length > 0) {
          scene.copySelectedModels();
        } else if (scene.activeModelId) {
          scene.copyModel(scene.activeModelId);
        }
        break;
      case 'cut':
        if (scene.activeModelId) {
          scene.cutModel(scene.activeModelId);
        }
        break;
      case 'paste':
        scene.pasteCopiedModelsAutoArrange(arrangeSpacingMm);
        break;
      case 'duplicate':
      case 'arrange':
      case 'repair':
      default:
        // intentionally disabled in the menu for now
        break;
    }
    closeEditorContextMenu();
  }, [arrangeSpacingMm, closeEditorContextMenu, scene]);

  React.useEffect(() => {
    const handleDiagnosticsHotkey = (event: KeyboardEvent) => {
      const isCtrlShiftD = event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd';
      if (!isCtrlShiftD) return;

      // Important: block browser default (e.g. "Bookmark all tabs").
      event.preventDefault();
      event.stopPropagation();
      setIsDiagnosticsOpen((prev) => !prev);
    };

    window.addEventListener('keydown', handleDiagnosticsHotkey, true);
    return () => {
      window.removeEventListener('keydown', handleDiagnosticsHotkey, true);
    };
  }, []);

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

  const isFiniteNumber = React.useCallback((n: number) => Number.isFinite(n) && !Number.isNaN(n), []);

  const isFiniteTransform = React.useCallback((t: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  }) => (
    isFiniteNumber(t.position.x)
    && isFiniteNumber(t.position.y)
    && isFiniteNumber(t.position.z)
    && isFiniteNumber(t.rotation.x)
    && isFiniteNumber(t.rotation.y)
    && isFiniteNumber(t.rotation.z)
    && isFiniteNumber(t.scale.x)
    && isFiniteNumber(t.scale.y)
    && isFiniteNumber(t.scale.z)
  ), [isFiniteNumber]);

  // Sync transform manager when active model changes
  useEffect(() => {
    if (scene.activeModelId && scene.activeModel) {
      // Only run this sync when selection changes.
      // If we re-run on every activeModel object mutation, it can fight
      // with local transform/autolift updates and create feedback loops.
      if (displayActiveModelId === scene.activeModelId) {
        return;
      }

      const t = scene.activeModel.transform;

      if (!isFiniteTransform(t)) {
        const fallback = isFiniteTransform(transformMgr.transform)
          ? {
            position: transformMgr.transform.position.clone(),
            rotation: transformMgr.transform.rotation.clone(),
            scale: transformMgr.transform.scale.clone(),
          }
          : {
            position: new THREE.Vector3(0, 0, 0),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1),
          };

        console.warn('[TransformSync] Active model had non-finite transform. Auto-recovering.', {
          id: scene.activeModelId,
        });

        scene.updateModelTransform(scene.activeModelId, fallback);
        transformMgr.transformHook.setPosition(fallback.position.x, fallback.position.y, fallback.position.z);
        transformMgr.transformHook.setRotation(fallback.rotation.x, fallback.rotation.y, fallback.rotation.z);
        transformMgr.transformHook.setScale(fallback.scale.x, fallback.scale.y, fallback.scale.z);
        setDisplayActiveModelId(scene.activeModelId);
        return;
      }

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
  }, [displayActiveModelId, isFiniteTransform, scene.activeModel, scene.activeModelId, scene.updateModelTransform, transformMgr.transform, transformMgr.transformHook]);

  // Sync transform changes from manager back to model store (persistence)
  // This ensures that any change (gizmo, auto-lift, inputs) is saved to the model
  useEffect(() => {
    // Only update if the local transform state has been synchronized with the new model
    // This prevents overwriting the new model's transform with the old transform state on load
    if (scene.activeModelId && displayActiveModelId === scene.activeModelId) {
      const modelTransform = scene.activeModel?.transform;
      if (!modelTransform) return;

      if (!isFiniteTransform(modelTransform)) {
        if (isFiniteTransform(transformMgr.transform)) {
          scene.updateModelTransform(scene.activeModelId, {
            position: transformMgr.transform.position.clone(),
            rotation: transformMgr.transform.rotation.clone(),
            scale: transformMgr.transform.scale.clone(),
          });
        }
        return;
      }

      if (!isFiniteTransform(transformMgr.transform)) {
        return;
      }

      const current = transformMgr.transform;
      const EPSILON = 0.0001;
      const posChanged = current.position.distanceToSquared(modelTransform.position) > EPSILON;
      const rotChanged =
        Math.abs(current.rotation.x - modelTransform.rotation.x) > EPSILON ||
        Math.abs(current.rotation.y - modelTransform.rotation.y) > EPSILON ||
        Math.abs(current.rotation.z - modelTransform.rotation.z) > EPSILON;
      const scaleChanged = current.scale.distanceToSquared(modelTransform.scale) > EPSILON;

      if (posChanged || rotChanged || scaleChanged) {
        scene.updateModelTransform(scene.activeModelId, current);
      }
    }
  }, [
    scene.activeModelId,
    scene.activeModel,
    displayActiveModelId,
    transformMgr.transform.position.x,
    transformMgr.transform.position.y,
    transformMgr.transform.position.z,
    transformMgr.transform.rotation.x,
    transformMgr.transform.rotation.y,
    transformMgr.transform.rotation.z,
    transformMgr.transform.scale.x,
    transformMgr.transform.scale.y,
    transformMgr.transform.scale.z,
    isFiniteTransform,
  ]);

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

  const handleAddPrinterFromOnboarding = React.useCallback(() => {
    openProfileSettingsModal('printer', { openPrinterLibrary: true });
  }, []);

  const handleUseWithoutPrinter = React.useCallback(() => {
    setAllowPrepareWithoutPrinter(true);
  }, []);

  // Temporary: LYS Ghost Viewer State
  const [ghostData, setGhostData] = React.useState<any>(null);

  const computeModelWorldBounds = React.useCallback((
    model: (typeof scene.models)[number],
    transformOverride?: typeof model.transform,
    volumeBounds?: THREE.Box3 | null,
  ) => {
    const t = transformOverride ?? model.transform;

    if (shouldUsePreciseBoundsForTransform(t)) {
      return computePreciseModelWorldBounds(model.geometry, t);
    }

    const approxBounds = computeApproxModelWorldBounds(model.geometry, t);

    if (!volumeBounds) {
      return approxBounds;
    }

    if (!isBoundsOutsideVolume(approxBounds, volumeBounds, 0.01)) {
      return approxBounds;
    }

    return computePreciseModelWorldBounds(model.geometry, t);
  }, []);

  const buildVolumeBounds = React.useMemo(() => {
    if (!scene.view3dSettings.enabled) return null;

    const width = scene.view3dSettings.widthMm;
    const depth = scene.view3dSettings.depthMm;
    const minX = scene.view3dSettings.originMode === 'front_left' ? 0 : -width * 0.5;
    const minY = scene.view3dSettings.originMode === 'front_left' ? 0 : -depth * 0.5;

    return new THREE.Box3(
      new THREE.Vector3(minX, minY, 0),
      new THREE.Vector3(minX + width, minY + depth, scene.view3dSettings.maxZMm),
    );
  }, [
    scene.view3dSettings.depthMm,
    scene.view3dSettings.enabled,
    scene.view3dSettings.maxZMm,
    scene.view3dSettings.originMode,
    scene.view3dSettings.widthMm,
  ]);

  const outsidePlateModelIds = React.useMemo(() => {
    if (!buildVolumeBounds) return [] as string[];
    const BUILD_VOLUME_BOUNDS_EPS_MM = 0.01;

    return scene.models
      .filter((model) => model.visible)
      .filter((model) => {
        const effectiveTransform =
          (scene.activeModelId === model.id && displayActiveModelId === scene.activeModelId)
            ? transformMgr.transform
            : model.transform;
        const bounds = computeModelWorldBounds(model, effectiveTransform, buildVolumeBounds);
        return isBoundsOutsideVolume(bounds, buildVolumeBounds, BUILD_VOLUME_BOUNDS_EPS_MM);
      })
      .map((model) => model.id);
  }, [
    buildVolumeBounds,
    computeModelWorldBounds,
    displayActiveModelId,
    scene.activeModelId,
    scene.models,
    transformMgr.transform,
  ]);

  const inBoundsModelIds = React.useMemo(() => {
    const outsideSet = new Set(outsidePlateModelIds);
    return scene.models
      .filter((model) => model.visible)
      .filter((model) => !outsideSet.has(model.id))
      .map((model) => model.id);
  }, [outsidePlateModelIds, scene.models]);

  const totalPolygons = React.useMemo(() => {
    return scene.models.reduce((sum, model) => sum + (model.polygonCount || 0), 0);
  }, [scene.models]);

  const selectedPolygons = React.useMemo(() => {
    if (scene.selectedModelIds.length === 0) return 0;
    const selectedIdSet = new Set(scene.selectedModelIds);
    return scene.models
      .filter((model) => selectedIdSet.has(model.id))
      .reduce((sum, model) => sum + (model.polygonCount || 0), 0);
  }, [scene.models, scene.selectedModelIds]);

  const getArrangeTransform = React.useCallback((model: (typeof scene.models)[number]) => {
    if (
      scene.activeModelId
      && model.id === scene.activeModelId
      && displayActiveModelId === scene.activeModelId
    ) {
      return transformMgr.transform;
    }
    return model.transform;
  }, [displayActiveModelId, scene.activeModelId, transformMgr.transform]);

  const getModelBoundingFootprintMm = React.useCallback((
    model: (typeof scene.models)[number],
    rotationZOverride?: number,
    transformOverride?: (typeof scene.models)[number]['transform'],
  ) => {
    const t = transformOverride ?? getArrangeTransform(model);
    const rotation = new THREE.Euler(
      t.rotation.x,
      t.rotation.y,
      rotationZOverride ?? t.rotation.z,
      t.rotation.order,
    );

    const bounds = computeApproxModelWorldBounds(
      model.geometry,
      {
        position: new THREE.Vector3(0, 0, 0),
        rotation,
        scale: t.scale,
      },
    );

    return {
      width: Math.max(2, bounds.max.x - bounds.min.x),
      depth: Math.max(2, bounds.max.y - bounds.min.y),
    };
  }, [computeApproxModelWorldBounds, getArrangeTransform]);

  const sleep = React.useCallback((ms: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  }), []);

  const resolveArrangeVisibleModels = React.useCallback((scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (scope === 'all') {
      return scene.models.filter((m) => m.visible);
    }

    const selectedIdSet = new Set(explicitSelectedIds ?? scene.selectedModelIds);

    // Guard against transient selection desync: ensure active model participates
    // when user arranges selected models and the active model is visible.
    if (scene.activeModelId) {
      const activeVisible = scene.models.some((m) => m.id === scene.activeModelId && m.visible);
      if (activeVisible) selectedIdSet.add(scene.activeModelId);
    }

    return scene.models.filter((m) => m.visible && selectedIdSet.has(m.id));
  }, [scene.activeModelId, scene.models, scene.selectedModelIds]);

  const applyArrangeTransforms = React.useCallback((updates: Array<{
    id: string;
    transform: {
      position: THREE.Vector3;
      rotation: THREE.Euler;
      scale: THREE.Vector3;
    };
  }>) => {
    if (updates.length === 0) return;

    const isFiniteNumber = (n: number) => Number.isFinite(n) && !Number.isNaN(n);
    const sanitizedUpdates = updates.filter((update) => {
      const { position, rotation, scale } = update.transform;
      return isFiniteNumber(position.x)
        && isFiniteNumber(position.y)
        && isFiniteNumber(position.z)
        && isFiniteNumber(rotation.x)
        && isFiniteNumber(rotation.y)
        && isFiniteNumber(rotation.z)
        && isFiniteNumber(scale.x)
        && isFiniteNumber(scale.y)
        && isFiniteNumber(scale.z);
    });

    if (sanitizedUpdates.length === 0) {
      console.warn('[Arrange][HighPrecision] Skipping apply: all computed transforms were non-finite.');
      return;
    }

    if (sanitizedUpdates.length !== updates.length) {
      console.warn('[Arrange][HighPrecision] Dropped non-finite transforms:', {
        dropped: updates.length - sanitizedUpdates.length,
        total: updates.length,
      });
    }

    scene.updateModelTransforms(sanitizedUpdates);

    if (!scene.activeModelId || displayActiveModelId !== scene.activeModelId) {
      return;
    }

    const activeUpdate = sanitizedUpdates.find((update) => update.id === scene.activeModelId);
    if (!activeUpdate) return;

    const { position, rotation, scale } = activeUpdate.transform;
    transformMgr.transformHook.setPosition(position.x, position.y, position.z);
    transformMgr.transformHook.setRotation(rotation.x, rotation.y, rotation.z);
    transformMgr.transformHook.setScale(scale.x, scale.y, scale.z);
  }, [displayActiveModelId, scene, transformMgr.transformHook]);

  const handleAutoArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);

    if (visibleModels.length <= 1) return;

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setIsAutoArranging(true);
    await sleep(0);

    try {
      const modelTransformById = new Map(
        visibleModels.map((model) => [model.id, getArrangeTransform(model)] as const),
      );

      const modelsWithFootprints = visibleModels.map((model) => {
        const t = modelTransformById.get(model.id) ?? model.transform;
        const baseFootprint = getModelBoundingFootprintMm(model, undefined, t);
        return {
          model,
          baseWidth: baseFootprint.width,
          baseDepth: baseFootprint.depth,
        };
      });

      const minX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
      const maxX = minX + scene.view3dSettings.widthMm;
      const minY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
      const maxY = minY + scene.view3dSettings.depthMm;
      const plateWidth = Math.max(1, maxX - minX);
      const plateDepth = Math.max(1, maxY - minY);

      type PackedEntry = {
        model: (typeof visibleModels)[number];
        width: number;
        depth: number;
        row: number;
        indexInRow: number;
        rotationZ: number;
      };

      type SpillEntry = {
        model: (typeof visibleModels)[number];
        width: number;
        depth: number;
        rotationZ: number;
      };

      type Row = {
        widthUsed: number;
        maxDepth: number;
        items: PackedEntry[];
      };

      const evaluatePacking = (ordered: typeof modelsWithFootprints, targetRowWidth: number) => {
        const rows: Row[] = [];
        const spills: SpillEntry[] = [];
        const placementSizeCache = new Map<string, { width: number; depth: number }>();

        let occupiedArea = 0;
        let totalDepthUsed = 0;

        type PlacementOption = {
          rotationZ: number;
          width: number;
          depth: number;
        };

        const normalizeToPi = (angle: number) => {
          let a = angle % Math.PI;
          if (a < 0) a += Math.PI;
          return a;
        };

        const nearestEquivalentAngle = (reference: number, canonical: number) => {
          const twoPi = Math.PI * 2;
          const k = Math.round((reference - canonical) / twoPi);
          return canonical + k * twoPi;
        };

        const footprintAtAngle = (model: (typeof visibleModels)[number], angleZ: number) => {
          const t = modelTransformById.get(model.id) ?? model.transform;
          const key = `${model.id}|${angleZ.toFixed(5)}|${t.scale.x.toFixed(5)}|${t.scale.y.toFixed(5)}|${t.scale.z.toFixed(5)}|${t.rotation.x.toFixed(5)}|${t.rotation.y.toFixed(5)}`;
          const cached = placementSizeCache.get(key);
          if (cached) return cached;

          const dims = getModelBoundingFootprintMm(model, angleZ, t);

          placementSizeCache.set(key, dims);
          return dims;
        };

        const getAllOptions = (current: (typeof modelsWithFootprints)[number]): PlacementOption[] => {
          const t = modelTransformById.get(current.model.id) ?? current.model.transform;
          const currentZ = t.rotation.z;
          const currentCanonical = normalizeToPi(currentZ);

          if (!arrangeAllowRotateOnZ) {
            const dims = footprintAtAngle(current.model, currentCanonical);
            return [{ rotationZ: currentZ, width: dims.width, depth: dims.depth }];
          }

          const candidateCanonicals: number[] = [currentCanonical];
          const coarseStepDeg = 15;
          for (let deg = 0; deg < 180; deg += coarseStepDeg) {
            candidateCanonicals.push(THREE.MathUtils.degToRad(deg));
          }

          // Ensure we always evaluate the width/depth-swapped alternative from the current pose.
          candidateCanonicals.push(normalizeToPi(currentCanonical + (Math.PI * 0.5)));

          const seenFootprints = new Set<string>();
          const options: PlacementOption[] = [];

          for (const rawCanonical of candidateCanonicals) {
            const canonical = normalizeToPi(rawCanonical);
            const dims = footprintAtAngle(current.model, canonical);
            const key = `${dims.width.toFixed(3)}:${dims.depth.toFixed(3)}`;
            if (seenFootprints.has(key)) continue;
            seenFootprints.add(key);

            options.push({
              rotationZ: nearestEquivalentAngle(currentZ, canonical),
              width: dims.width,
              depth: dims.depth,
            });
          }

          return options;
        };

        for (const current of ordered) {
          const options = getAllOptions(current);
          const fitOptions = options.filter((opt) => opt.width <= plateWidth && opt.depth <= plateDepth);

          if (fitOptions.length === 0) {
            const fallback = options.reduce((best, candidate) => {
              const bestOverflow = Math.max(0, best.width - plateWidth) + Math.max(0, best.depth - plateDepth);
              const candidateOverflow = Math.max(0, candidate.width - plateWidth) + Math.max(0, candidate.depth - plateDepth);
              if (candidateOverflow < bestOverflow) return candidate;
              if (candidateOverflow === bestOverflow && (candidate.width * candidate.depth) < (best.width * best.depth)) return candidate;
              return best;
            }, options[0]);

            spills.push({
              model: current.model,
              width: fallback.width,
              depth: fallback.depth,
              rotationZ: fallback.rotationZ,
            });
            continue;
          }

          let bestPlacement:
            | { kind: 'same-row'; rowIndex: number; option: PlacementOption; score: number }
            | { kind: 'new-row'; option: PlacementOption; score: number }
            | null = null;

          if (rows.length > 0) {
            for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
              const row = rows[rowIndex];
              for (const option of fitOptions) {
                const nextWidth = row.widthUsed + (row.items.length > 0 ? arrangeSpacingMm : 0) + option.width;
                if (nextWidth > plateWidth) continue;

                const nextDepth = Math.max(row.maxDepth, option.depth);
                const depthDelta = nextDepth - row.maxDepth;
                const nextTotalDepth = totalDepthUsed + depthDelta;
                if (nextTotalDepth > plateDepth) continue;

                // Prefer tighter rows, less depth growth, and widths near target row width.
                const depthPenalty = depthDelta * 40;
                const widthPenalty = Math.abs(targetRowWidth - nextWidth) * 0.08;
                const areaScore = nextWidth * nextDepth;
                const score = areaScore + depthPenalty + widthPenalty;

                if (!bestPlacement || score < bestPlacement.score) {
                  bestPlacement = { kind: 'same-row', rowIndex, option, score };
                }
              }
            }
          }

          for (const option of fitOptions) {
            const nextTotalDepth = totalDepthUsed + (rows.length > 0 ? arrangeSpacingMm : 0) + option.depth;
            if (nextTotalDepth > plateDepth) continue;

            const widthPenalty = Math.abs(targetRowWidth - option.width) * 0.12;
            const score = (option.width * option.depth) + widthPenalty + 10;
            if (!bestPlacement || score < bestPlacement.score) {
              bestPlacement = { kind: 'new-row', option, score };
            }
          }

          if (!bestPlacement) {
            const fallback = fitOptions.reduce((best, candidate) => {
              if (candidate.width < best.width) return candidate;
              if (candidate.width === best.width && candidate.depth < best.depth) return candidate;
              return best;
            }, fitOptions[0]);

            spills.push({
              model: current.model,
              width: fallback.width,
              depth: fallback.depth,
              rotationZ: fallback.rotationZ,
            });
            continue;
          }

          if (bestPlacement.kind === 'new-row') {
            const row: Row = { widthUsed: 0, maxDepth: 0, items: [] };
            rows.push(row);
            totalDepthUsed += (rows.length > 1 ? arrangeSpacingMm : 0) + bestPlacement.option.depth;
            row.widthUsed = bestPlacement.option.width;
            row.maxDepth = bestPlacement.option.depth;
            row.items.push({
              model: current.model,
              width: bestPlacement.option.width,
              depth: bestPlacement.option.depth,
              row: rows.length - 1,
              indexInRow: 0,
              rotationZ: bestPlacement.option.rotationZ,
            });
            occupiedArea += bestPlacement.option.width * bestPlacement.option.depth;
          } else {
            const row = rows[bestPlacement.rowIndex];
            const previousDepth = row.maxDepth;
            row.widthUsed += (row.items.length > 0 ? arrangeSpacingMm : 0) + bestPlacement.option.width;
            row.maxDepth = Math.max(row.maxDepth, bestPlacement.option.depth);
            totalDepthUsed += row.maxDepth - previousDepth;
            row.items.push({
              model: current.model,
              width: bestPlacement.option.width,
              depth: bestPlacement.option.depth,
              row: bestPlacement.rowIndex,
              indexInRow: row.items.length,
              rotationZ: bestPlacement.option.rotationZ,
            });
            occupiedArea += bestPlacement.option.width * bestPlacement.option.depth;
          }
        }

        const rowDepths = rows.map((r) => r.maxDepth);
        const rowWidths = rows.map((r) => r.widthUsed);
        const totalWidth = Math.min(plateWidth, rowWidths.reduce((acc, width) => Math.max(acc, width), 0));
        const totalDepth = rowDepths.reduce((acc, depth) => acc + depth, 0) + Math.max(0, rows.length - 1) * arrangeSpacingMm;

        const layoutArea = totalWidth * totalDepth;
        const deadSpace = Math.max(0, layoutArea - occupiedArea);
        const spillArea = spills.reduce((acc, item) => acc + (item.width * item.depth), 0);
        const spillPenalty = spills.length * 1_000_000 + spillArea * 100;
        const aspectPenalty = Math.abs(totalWidth - totalDepth) * 0.05;

        return {
          rows,
          spills,
          rowDepths,
          totalWidth,
          totalDepth,
          score: deadSpace + spillPenalty + aspectPenalty,
        };
      };

      const byAreaDesc = [...modelsWithFootprints].sort((a, b) => (b.baseWidth * b.baseDepth) - (a.baseWidth * a.baseDepth));
      const byMaxSideDesc = [...modelsWithFootprints].sort((a, b) => Math.max(b.baseWidth, b.baseDepth) - Math.max(a.baseWidth, a.baseDepth));
      const orderingCandidates = [modelsWithFootprints, byAreaDesc, byMaxSideDesc];

      const totalModelArea = modelsWithFootprints.reduce((acc, current) => acc + (current.baseWidth * current.baseDepth), 0);
      const baseWidth = Math.min(plateWidth, Math.max(30, Math.sqrt(totalModelArea)));
      const targetRowWidths = [
        baseWidth * 0.8,
        baseWidth,
        baseWidth * 1.2,
        plateWidth * 0.5,
        plateWidth * 0.65,
        plateWidth * 0.8,
        plateWidth,
      ]
        .map((w) => Math.min(plateWidth, Math.max(20, w)));

      const uniqueTargetRowWidths = [...new Set(targetRowWidths.map((w) => Number(w.toFixed(3))))];

      let bestLayout: ReturnType<typeof evaluatePacking> | null = null;
      for (const ordered of orderingCandidates) {
        for (const targetRowWidth of uniqueTargetRowWidths) {
          const layout = evaluatePacking(ordered, targetRowWidth);
          if (!bestLayout || layout.score < bestLayout.score) {
            bestLayout = layout;
          }
        }
      }

      if (!bestLayout) return;

      const { rows, spills, rowDepths, totalWidth, totalDepth } = bestLayout;

      let startX = minX + ((maxX - minX) - totalWidth) * 0.5;
      let startY = minY + ((maxY - minY) - totalDepth) * 0.5;

      if (arrangeAnchorMode === 'front_left') {
        startX = minX;
        startY = minY;
      } else if (arrangeAnchorMode === 'front_right') {
        startX = maxX - totalWidth;
        startY = minY;
      } else if (arrangeAnchorMode === 'back_left') {
        startX = minX;
        startY = maxY - totalDepth;
      } else if (arrangeAnchorMode === 'back_right') {
        startX = maxX - totalWidth;
        startY = maxY - totalDepth;
      }

      const rowCenters: number[] = [];
      let cursorY = startY;
      for (let row = 0; row < rowDepths.length; row += 1) {
        const depth = rowDepths[row];
        rowCenters[row] = cursorY + depth * 0.5;
        cursorY += depth + arrangeSpacingMm;
      }

      const packedWithPositions: Array<PackedEntry & { positionX: number; positionY: number }> = [];
      rows.forEach((row, rowIndex) => {
        let rowCursorX = startX;
        row.items.forEach((item) => {
          const centerX = rowCursorX + item.width * 0.5;
          packedWithPositions.push({
            ...item,
            positionX: centerX,
            positionY: rowCenters[rowIndex],
          });
          rowCursorX += item.width + arrangeSpacingMm;
        });
      });

      const spillWithPositions: Array<SpillEntry & { positionX: number; positionY: number }> = [];
      if (spills.length > 0) {
        const outsideGap = Math.max(8, arrangeSpacingMm);
        let columnLeftX = maxX + outsideGap;
        let columnYCursor = minY;
        let columnMaxWidth = 0;

        spills.forEach((item) => {
          if (columnYCursor > minY && (columnYCursor + item.depth) > maxY) {
            columnLeftX += columnMaxWidth + outsideGap;
            columnMaxWidth = 0;
            columnYCursor = minY;
          }

          const positionX = columnLeftX + item.width * 0.5;
          const positionY = columnYCursor + item.depth * 0.5;
          spillWithPositions.push({ ...item, positionX, positionY });

          columnYCursor += item.depth + arrangeSpacingMm;
          columnMaxWidth = Math.max(columnMaxWidth, item.width);
        });
      }

      applyArrangeTransforms(
        [
          ...packedWithPositions.map(({ model, rotationZ, positionX, positionY }) => {
            const t = modelTransformById.get(model.id) ?? model.transform;
            return {
              id: model.id,
              transform: {
                position: new THREE.Vector3(positionX, positionY, t.position.z),
                rotation: new THREE.Euler(
                  t.rotation.x,
                  t.rotation.y,
                  rotationZ,
                  t.rotation.order,
                ),
                scale: t.scale.clone(),
              },
            };
          }),
          ...spillWithPositions.map(({ model, rotationZ, positionX, positionY }) => {
            const t = modelTransformById.get(model.id) ?? model.transform;
            return {
              id: model.id,
              transform: {
                position: new THREE.Vector3(positionX, positionY, t.position.z),
                rotation: new THREE.Euler(
                  t.rotation.x,
                  t.rotation.y,
                  rotationZ,
                  t.rotation.order,
                ),
                scale: t.scale.clone(),
              },
            };
          }),
        ],
      );

      transformMgr.setTransformMode('select');
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
    }
  }, [arrangeAllowRotateOnZ, arrangeAnchorMode, arrangeSpacingMm, getArrangeTransform, getModelBoundingFootprintMm, isAutoArranging, resolveArrangeVisibleModels, scene, sleep, transformMgr, applyArrangeTransforms]);

  const handleHighPrecisionArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);
    if (visibleModels.length <= 1) return;

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setIsAutoArranging(true);
    await sleep(0);

    try {
      const SAT_EPS_MM = 0.05;
      const spacing = Math.max(0, arrangeSpacingMm);
      // minSpacing is the SAT hull-to-hull gap enforcing the requested spacing.
      const minSpacing = spacing + SAT_EPS_MM;
      const PERF_COMPLEX_SCENE = visibleModels.length >= 30;
      const MAX_CANDIDATE_NEIGHBORS = PERF_COMPLEX_SCENE ? 20 : 36;
      const MAX_VERTEX_PAIR_CANDIDATES = PERF_COMPLEX_SCENE ? 180 : 420;
      const MAX_CONTACT_CANDIDATES = PERF_COMPLEX_SCENE ? 360 : 900;
      const MAX_LATTICE_CANDIDATES = PERF_COMPLEX_SCENE ? 320 : 900;
      const MAX_EVALUATED_CANDIDATES = PERF_COMPLEX_SCENE ? 420 : 1200;
      const MAX_CANDIDATE_BUFFER = PERF_COMPLEX_SCENE ? 560 : 1500;

      const minX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
      const maxX = minX + scene.view3dSettings.widthMm;
      const minY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
      const maxY = minY + scene.view3dSettings.depthMm;

      const modelTransformById = new Map(
        scene.models.map((model) => [model.id, getArrangeTransform(model)] as const),
      );

      const quant = (n: number) => Math.round(n * 1e4) / 1e4;

      type HullData = {
        points: THREE.Vector2[];
        halfW: number;
        halfD: number;
        localMinX: number;
        localMaxX: number;
        localMinY: number;
        localMaxY: number;
      };

      const getHullAtRotation = (model: (typeof visibleModels)[number], rotationZ: number): HullData => {
        const t = modelTransformById.get(model.id) ?? model.transform;
        const positionAttr = model.geometry.geometry.getAttribute('position') as THREE.BufferAttribute;
        if (!positionAttr || positionAttr.count < 3) {
          return {
            points: [
              new THREE.Vector2(-1, -1),
              new THREE.Vector2(1, -1),
              new THREE.Vector2(1, 1),
              new THREE.Vector2(-1, 1),
            ],
            halfW: 1,
            halfD: 1,
            localMinX: -1,
            localMaxX: 1,
            localMinY: -1,
            localMaxY: 1,
          };
        }

        const key = [
          model.geometry.geometry.uuid,
          quant(t.rotation.x),
          quant(t.rotation.y),
          quant(rotationZ),
          quant(t.scale.x),
          quant(t.scale.y),
          quant(t.scale.z),
        ].join('|');

        const cached = arrangeHullFootprintCacheRef.current.get(key);
        if (cached) return cached;

        const matrix = new THREE.Matrix4().compose(
          new THREE.Vector3(0, 0, 0),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(
            t.rotation.x,
            t.rotation.y,
            rotationZ,
            t.rotation.order,
          )),
          t.scale,
        );

        const center = model.geometry.center;
        // Single pass: collect strided sample AND guaranteed extremal vertices in 8 directions.
        // Extremal coverage prevents the hull from underestimating the true geometry boundary.
        const targetSamplesBase = 8000;
        const stride = Math.max(1, Math.floor(positionAttr.count / targetSamplesBase));
        const points2d: THREE.Vector2[] = [];
        const tmp = new THREE.Vector3();
        const nE = 8;
        const eDx = [1, -1, 0, 0, 0.7071068, 0.7071068, -0.7071068, -0.7071068];
        const eDy = [0, 0, 1, -1, 0.7071068, -0.7071068, 0.7071068, -0.7071068];
        const eDot = new Float64Array(nE).fill(-Infinity);
        const eXArr = new Float32Array(nE);
        const eYArr = new Float32Array(nE);
        for (let i = 0; i < positionAttr.count; i++) {
          tmp.set(
            positionAttr.getX(i) - center.x,
            positionAttr.getY(i) - center.y,
            positionAttr.getZ(i) - center.z,
          ).applyMatrix4(matrix);
          const tx = tmp.x;
          const ty = tmp.y;
          if (i % stride === 0) points2d.push(new THREE.Vector2(tx, ty));
          for (let d = 0; d < nE; d++) {
            const dot = tx * eDx[d] + ty * eDy[d];
            if (dot > eDot[d]) { eDot[d] = dot; eXArr[d] = tx; eYArr[d] = ty; }
          }
        }
        for (let d = 0; d < nE; d++) {
          if (Number.isFinite(eXArr[d]) && Number.isFinite(eYArr[d])) {
            points2d.push(new THREE.Vector2(eXArr[d], eYArr[d]));
          }
        }

        const hull = convexHull2d(points2d);
        const points = hull.length >= 3
          ? hull
          : [
            new THREE.Vector2(-1, -1),
            new THREE.Vector2(1, -1),
            new THREE.Vector2(1, 1),
            new THREE.Vector2(-1, 1),
          ];

        let localMinX = Infinity;
        let localMaxX = -Infinity;
        let localMinY = Infinity;
        let localMaxY = -Infinity;
        for (const p of points) {
          localMinX = Math.min(localMinX, p.x);
          localMaxX = Math.max(localMaxX, p.x);
          localMinY = Math.min(localMinY, p.y);
          localMaxY = Math.max(localMaxY, p.y);
        }

        if (!Number.isFinite(localMinX) || !Number.isFinite(localMaxX) || !Number.isFinite(localMinY) || !Number.isFinite(localMaxY)) {
          localMinX = -1;
          localMaxX = 1;
          localMinY = -1;
          localMaxY = 1;
        }

        const next: HullData = {
          points,
          halfW: Math.max(1, (localMaxX - localMinX) * 0.5),
          halfD: Math.max(1, (localMaxY - localMinY) * 0.5),
          localMinX,
          localMaxX,
          localMinY,
          localMaxY,
        };

        arrangeHullFootprintCacheRef.current.set(key, next);
        return next;
      };

      const axesFromPolygon = (poly: THREE.Vector2[]) => {
        const axes: THREE.Vector2[] = [];
        for (let i = 0; i < poly.length; i++) {
          const a = poly[i];
          const b = poly[(i + 1) % poly.length];
          const edge = new THREE.Vector2(b.x - a.x, b.y - a.y);
          if (edge.lengthSq() <= 1e-10) continue;
          axes.push(new THREE.Vector2(-edge.y, edge.x).normalize());
        }
        return axes;
      };

      const projectPolygon = (poly: THREE.Vector2[], center: THREE.Vector2, axis: THREE.Vector2) => {
        let min = Infinity;
        let max = -Infinity;
        for (const p of poly) {
          const dot = (p.x + center.x) * axis.x + (p.y + center.y) * axis.y;
          min = Math.min(min, dot);
          max = Math.max(max, dot);
        }
        return { min, max };
      };

      const polygonsOverlapWithSpacing = (
        polyA: THREE.Vector2[],
        centerA: THREE.Vector2,
        polyB: THREE.Vector2[],
        centerB: THREE.Vector2,
        minSpacing: number,
      ) => {
        const axes = [...axesFromPolygon(polyA), ...axesFromPolygon(polyB)];
        for (const axis of axes) {
          const pa = projectPolygon(polyA, centerA, axis);
          const pb = projectPolygon(polyB, centerB, axis);
          if ((pa.max + minSpacing) <= pb.min || (pb.max + minSpacing) <= pa.min) {
            return false;
          }
        }
        return true;
      };

      type CollisionProxy = {
        center: THREE.Vector2;
        hull: THREE.Vector2[];
        halfW: number;
        halfD: number;
        localMinX: number;
        localMaxX: number;
        localMinY: number;
        localMaxY: number;
      };

      type Placed = CollisionProxy & {
        model: (typeof visibleModels)[number];
        rotationZ: number;
      };

      const worldBoundsAt = (proxy: CollisionProxy, center: THREE.Vector2) => ({
        minX: center.x + proxy.localMinX,
        maxX: center.x + proxy.localMaxX,
        minY: center.y + proxy.localMinY,
        maxY: center.y + proxy.localMaxY,
      });

      const intersectsBroadphase = (
        a: CollisionProxy,
        centerA: THREE.Vector2,
        b: CollisionProxy,
        centerB: THREE.Vector2,
        pad: number,
      ) => {
        const ba = worldBoundsAt(a, centerA);
        const bb = worldBoundsAt(b, centerB);
        if (ba.maxX + pad <= bb.minX) return false;
        if (bb.maxX + pad <= ba.minX) return false;
        if (ba.maxY + pad <= bb.minY) return false;
        if (bb.maxY + pad <= ba.minY) return false;
        return true;
      };

      const withinPlateAt = (proxy: CollisionProxy, center: THREE.Vector2) => {
        const wb = worldBoundsAt(proxy, center);
        return wb.minX >= minX && wb.maxX <= maxX && wb.minY >= minY && wb.maxY <= maxY;
      };

      const canPlaceAt = (candidate: CollisionProxy, center: THREE.Vector2, others: CollisionProxy[]) => {
        if (!withinPlateAt(candidate, center)) return false;
        for (const other of others) {
          if (!intersectsBroadphase(candidate, center, other, other.center, minSpacing)) continue;
          if (polygonsOverlapWithSpacing(candidate.hull, center, other.hull, other.center, minSpacing)) {
            return false;
          }
        }
        return true;
      };

      const anchor = (() => {
        if (arrangeAnchorMode === 'front_left') return new THREE.Vector2(minX, minY);
        if (arrangeAnchorMode === 'front_right') return new THREE.Vector2(maxX, minY);
        if (arrangeAnchorMode === 'back_left') return new THREE.Vector2(minX, maxY);
        if (arrangeAnchorMode === 'back_right') return new THREE.Vector2(maxX, maxY);
        return new THREE.Vector2((minX + maxX) * 0.5, (minY + maxY) * 0.5);
      })();

      const targetIdSet = new Set(visibleModels.map((m) => m.id));
      const blockers: CollisionProxy[] = scene.models
        .filter((m) => m.visible && !targetIdSet.has(m.id))
        .map((m) => {
          const t = modelTransformById.get(m.id) ?? m.transform;
          const h = getHullAtRotation(m, t.rotation.z);
          return {
            center: new THREE.Vector2(t.position.x, t.position.y),
            hull: h.points,
            halfW: h.halfW,
            halfD: h.halfD,
            localMinX: h.localMinX,
            localMaxX: h.localMaxX,
            localMinY: h.localMinY,
            localMaxY: h.localMaxY,
          };
        });

      const makeRotationOptions = (currentZ: number) => {
        if (!arrangeAllowRotateOnZ) return [currentZ];
        const options: number[] = [];
        const seen = new Set<number>();
        const rotationStepDeg = PERF_COMPLEX_SCENE ? 30 : 15;
        const push = (angle: number) => {
          const twoPi = Math.PI * 2;
          let a = angle % twoPi;
          if (a < 0) a += twoPi;
          const k = Number(a.toFixed(5));
          if (seen.has(k)) return;
          seen.add(k);
          options.push(a);
        };

        push(currentZ);
        for (let deg = 0; deg < 360; deg += rotationStepDeg) push(THREE.MathUtils.degToRad(deg));
        return options;
      };

      // ── Candidate generation helper ─────────────────────────────────────────
      // For every edge of each placed polygon, project the candidate hull flush
      // against that edge (at exactly minSpacing separation) to generate nestling
      // candidates.  This lets irregular hulls fill concavities left by neighbours.
      const buildContactCandidates = (
        h: HullData,
        pool: CollisionProxy[],
        minCX: number,
        maxCX: number,
        minCY: number,
        maxCY: number,
        out: Array<{ x: number; y: number }>,
        maxOut: number,
      ) => {
        if (maxOut <= 0) return;
        for (const other of pool) {
          if (out.length >= maxOut) break;
          const otherPoly = other.hull;
          for (let ei = 0; ei < otherPoly.length; ei++) {
            if (out.length >= maxOut) break;
            const vA = otherPoly[ei];
            const vB = otherPoly[(ei + 1) % otherPoly.length];
            const ex = vB.x - vA.x;
            const ey = vB.y - vA.y;
            const len = Math.sqrt(ex * ex + ey * ey);
            if (len < 1e-8) continue;
            const nx = -ey / len;
            const ny = ex / len;

            // Extreme of candidate hull in -normal direction
            let minDot = Infinity;
            for (const p of h.points) {
              const d = p.x * nx + p.y * ny;
              if (d < minDot) minDot = d;
            }
            // Extreme of other hull in +normal direction
            let maxOther = -Infinity;
            for (const p of otherPoly) {
              const d = (p.x + other.center.x) * nx + (p.y + other.center.y) * ny;
              if (d > maxOther) maxOther = d;
            }

            // For each vertex of the other hull, compute the candidate center that
            // places the candidate hull flush against this edge at that vertex.
            // candidate_center · n = (vO + other.center) · n + minSpacing - minDot
            for (const vO of otherPoly) {
              if (out.length >= maxOut) break;
              const targetDot = (vO.x + other.center.x) * nx + (vO.y + other.center.y) * ny + minSpacing - minDot;
              if (Math.abs(ny) > 0.1) {
                for (const cx of [other.center.x, minCX, maxCX, anchor.x]) {
                  const cy = (targetDot - cx * nx) / ny;
                  out.push({ x: Math.min(maxCX, Math.max(minCX, cx)), y: Math.min(maxCY, Math.max(minCY, cy)) });
                  if (out.length >= maxOut) break;
                }
              }
              if (Math.abs(nx) > 0.1) {
                for (const cy of [other.center.y, minCY, maxCY, anchor.y]) {
                  const cx = (targetDot - cy * ny) / nx;
                  out.push({ x: Math.min(maxCX, Math.max(minCX, cx)), y: Math.min(maxCY, Math.max(minCY, cy)) });
                  if (out.length >= maxOut) break;
                }
              }
            }
            void maxOther; // used for context; direct offset not needed with vertex iteration
          }
        }
      };

      const allShareSameGeometry = visibleModels.length > 0
        && visibleModels.every((m) => m.geometry.geometry.uuid === visibleModels[0].geometry.geometry.uuid);
      const SAME_GEOMETRY_FAST_PATH = allShareSameGeometry && visibleModels.length >= 18;
      const USE_CONTACT_CANDIDATES = !(SAME_GEOMETRY_FAST_PATH && PERF_COMPLEX_SCENE);
      const ENABLE_MULTI_ORDERING_RETRY = visibleModels.length <= 32;

      // ── Pre-select best rotation for identical-geometry batches ─────────────
      // Run a fast BLF simulation at each angle and keep the angle that fits most.
      const simPackAtAngle = (angle: number): number => {
        const simPlaced: CollisionProxy[] = [...blockers];
        let count = 0;
        for (const model of visibleModels) {
          const h = getHullAtRotation(model, angle);
          const proxy: CollisionProxy = {
            center: new THREE.Vector2(),
            hull: h.points, halfW: h.halfW, halfD: h.halfD,
            localMinX: h.localMinX, localMaxX: h.localMaxX,
            localMinY: h.localMinY, localMaxY: h.localMaxY,
          };
          const minCX = minX - h.localMinX;
          const maxCX = maxX - h.localMaxX;
          const minCY = minY - h.localMinY;
          const maxCY = maxY - h.localMaxY;
          if (minCX > maxCX || minCY > maxCY) continue;

          const pitchX = Math.max(1, (h.localMaxX - h.localMinX) + minSpacing);
          const pitchY = Math.max(1, (h.localMaxY - h.localMinY) + minSpacing);
          const colsX = Math.ceil((maxCX - minCX) / pitchX) + 1;
          const rowsY = Math.ceil((maxCY - minCY) / pitchY) + 1;
          const cands: Array<{ cx: number; cy: number; d: number }> = [];
          const addSim = (x: number, y: number) => {
            const cx = Math.min(maxCX, Math.max(minCX, x));
            const cy = Math.min(maxCY, Math.max(minCY, y));
            const dx = cx - anchor.x; const dy = cy - anchor.y;
            cands.push({ cx, cy, d: dx * dx + dy * dy });
          };
          for (let ix = 0; ix <= colsX; ix++) {
            for (let iy = 0; iy <= rowsY; iy++) addSim(minCX + ix * pitchX, minCY + iy * pitchY);
          }
          for (const other of simPlaced) {
            const ob = worldBoundsAt(other, other.center);
            addSim(ob.maxX + minSpacing - h.localMinX, other.center.y);
            addSim(other.center.x, ob.maxY + minSpacing - h.localMinY);
          }
          cands.sort((a, b) => a.d - b.d);
          for (const c of cands) {
            const ctr = new THREE.Vector2(c.cx, c.cy);
            if (canPlaceAt(proxy, ctr, simPlaced)) {
              count++;
              simPlaced.push({ ...proxy, center: ctr });
              break;
            }
          }
        }
        return count;
      };

      const sharedBestRotation = (() => {
        if (!allShareSameGeometry || visibleModels.length === 0) return null as number | null;
        const probe = visibleModels[0];
        const probeT = modelTransformById.get(probe.id) ?? probe.transform;
        const rotOpts = makeRotationOptions(probeT.rotation.z);
        if (rotOpts.length === 1) return rotOpts[0];
        let bestAngle = rotOpts[0];
        let bestCount = -1;
        for (const angle of rotOpts) {
          const n = simPackAtAngle(angle);
          if (n > bestCount) { bestCount = n; bestAngle = angle; }
        }
        return bestAngle;
      })();

      // ── Model ordering ───────────────────────────────────────────────────────
      const areaAtBestAngle = (model: (typeof visibleModels)[number]) => {
        const angle = sharedBestRotation ?? (modelTransformById.get(model.id) ?? model.transform).rotation.z;
        const h = getHullAtRotation(model, angle);
        return Math.max(1, (h.localMaxX - h.localMinX) * (h.localMaxY - h.localMinY));
      };
      const modelOrder = [...visibleModels].sort((a, b) => areaAtBestAngle(b) - areaAtBestAngle(a));

      // ── Placement attempt function ───────────────────────────────────────
      // Greedy BLF is ordering-sensitive — different model orderings yield
      // different packing configurations.  By retrying with alternative orderings
      // when models spill, we eliminate the counter-intuitive case where smaller
      // spacing fits fewer models than larger spacing.
      const attemptPlacement = (order: typeof modelOrder) => {
      const placed: Placed[] = [];
      let spills: Placed[] = [];

      // ── Per-model placement ──────────────────────────────────────────────────
      for (const model of order) {
        const t = modelTransformById.get(model.id) ?? model.transform;
        const neighborPool: CollisionProxy[] = [...placed, ...blockers];
        const candidateNeighbors = neighborPool.length > MAX_CANDIDATE_NEIGHBORS
          ? neighborPool
            .slice()
            .sort((a, b) => a.center.distanceToSquared(anchor) - b.center.distanceToSquared(anchor))
            .slice(0, MAX_CANDIDATE_NEIGHBORS)
          : neighborPool;
        const collisionPool = [...placed, ...blockers];

        const angleOptions = (() => {
          const base = makeRotationOptions(t.rotation.z);
          if (SAME_GEOMETRY_FAST_PATH && sharedBestRotation != null) {
            const alternatives = base.filter((a) => Math.abs(a - sharedBestRotation) > 1e-5).slice(0, 2);
            return [sharedBestRotation, ...alternatives];
          }
          if (sharedBestRotation == null) return base;
          const prioritized = [sharedBestRotation, ...base.filter((a) => Math.abs(a - sharedBestRotation) > 1e-5)];
          return prioritized;
        })();

        let best: { proxy: CollisionProxy; center: THREE.Vector2; rotationZ: number; score: number } | null = null;

        for (const rotationZ of angleOptions) {
          const h = getHullAtRotation(model, rotationZ);
          const candidateProxy: CollisionProxy = {
            center: new THREE.Vector2(),
            hull: h.points, halfW: h.halfW, halfD: h.halfD,
            localMinX: h.localMinX, localMaxX: h.localMaxX,
            localMinY: h.localMinY, localMaxY: h.localMaxY,
          };

          const minCenterX = minX - h.localMinX;
          const maxCenterX = maxX - h.localMaxX;
          const minCenterY = minY - h.localMinY;
          const maxCenterY = maxY - h.localMaxY;
          if (minCenterX > maxCenterX || minCenterY > maxCenterY) continue;

          const seen = new Set<string>();
          const cands: Array<{ x: number; y: number; sortKey: number }> = [];
          const addCandidate = (x: number, y: number) => {
            if (cands.length >= MAX_CANDIDATE_BUFFER) return;
            const cx = Math.min(maxCenterX, Math.max(minCenterX, x));
            const cy = Math.min(maxCenterY, Math.max(minCenterY, y));
            const k = `${cx.toFixed(2)}:${cy.toFixed(2)}`;
            if (seen.has(k)) return;
            seen.add(k);
            const dx = cx - anchor.x; const dy = cy - anchor.y;
            cands.push({ x: cx, y: cy, sortKey: dx * dx + dy * dy });
          };

          // Plate corners / anchor seed
          addCandidate(anchor.x, anchor.y);
          addCandidate(minCenterX, minCenterY);
          addCandidate(maxCenterX, minCenterY);
          addCandidate(minCenterX, maxCenterY);
          addCandidate(maxCenterX, maxCenterY);

          // AABB touch positions — fast coverage for axis-aligned shapes
          let vertexPairCount = 0;
          for (const other of candidateNeighbors) {
            if (cands.length >= MAX_CANDIDATE_BUFFER) break;
            const ob = worldBoundsAt(other, other.center);
            // Right of / left of / above / below neighbour
            addCandidate(ob.maxX + minSpacing - h.localMinX, other.center.y);
            addCandidate(ob.minX - minSpacing - h.localMaxX, other.center.y);
            addCandidate(other.center.x, ob.maxY + minSpacing - h.localMinY);
            addCandidate(other.center.x, ob.minY - minSpacing - h.localMaxY);
            // Cross — align to anchor row/col
            addCandidate(ob.maxX + minSpacing - h.localMinX, anchor.y);
            addCandidate(anchor.x, ob.maxY + minSpacing - h.localMinY);
            // Vertex-to-vertex nestling: place candidate hull so vertex vC aligns
            // with placed vertex vO, offset by minSpacing along each axis.
            for (const vO of other.hull) {
              if (vertexPairCount >= MAX_VERTEX_PAIR_CANDIDATES) break;
              for (const vC of h.points) {
                if (vertexPairCount >= MAX_VERTEX_PAIR_CANDIDATES) break;
                const wx = other.center.x + vO.x;
                const wy = other.center.y + vO.y;
                addCandidate(wx - vC.x + minSpacing, wy - vC.y);
                addCandidate(wx - vC.x - minSpacing, wy - vC.y);
                addCandidate(wx - vC.x, wy - vC.y + minSpacing);
                addCandidate(wx - vC.x, wy - vC.y - minSpacing);
                vertexPairCount++;
              }
            }
          }

          // SAT-contact edge candidates — places new hull flush against each placed edge
          if (USE_CONTACT_CANDIDATES) {
            const contactRaw: Array<{ x: number; y: number }> = [];
            buildContactCandidates(
              h,
              candidateNeighbors,
              minCenterX,
              maxCenterX,
              minCenterY,
              maxCenterY,
              contactRaw,
              MAX_CONTACT_CANDIDATES,
            );
            for (const c of contactRaw) addCandidate(c.x, c.y);
          }

          // Dense regular lattice + hex offset — ensures we always match axis-aligned packing capacity
          const pitchX = Math.max(1, (h.localMaxX - h.localMinX) + minSpacing);
          const pitchY = Math.max(1, (h.localMaxY - h.localMinY) + minSpacing);
          const colsX = Math.ceil((maxCenterX - minCenterX) / pitchX) + 1;
          const rowsY = Math.ceil((maxCenterY - minCenterY) / pitchY) + 1;
          const totalLatticeCells = (colsX + 1) * (rowsY + 1) * 1.5; // account for hex offset
          const latticeStride = Math.max(1, Math.ceil(totalLatticeCells / Math.max(1, MAX_LATTICE_CANDIDATES)));
          let latticeCounter = 0;
          for (let ix = 0; ix <= colsX; ix++) {
            for (let iy = 0; iy <= rowsY; iy++) {
              if ((latticeCounter++ % latticeStride) !== 0) continue;
              addCandidate(minCenterX + ix * pitchX, minCenterY + iy * pitchY);
              // Hex-offset row: shift every other row by half pitch
              if (iy % 2 === 1) {
                addCandidate(minCenterX + ix * pitchX + pitchX * 0.5, minCenterY + iy * pitchY);
              }
            }
          }

          // Sort by anchor proximity and take first valid (BLF)
          cands.sort((a, b) => a.sortKey - b.sortKey);
          let localBest: { center: THREE.Vector2; anchorDistSq: number } | null = null;
          for (let ci = 0; ci < cands.length && ci < MAX_EVALUATED_CANDIDATES; ci++) {
            const c = cands[ci];
            const center = new THREE.Vector2(c.x, c.y);
            if (canPlaceAt(candidateProxy, center, collisionPool)) {
              localBest = { center, anchorDistSq: c.sortKey };
              break;
            }
          }

          if (!localBest) continue;

          if (!best || localBest.anchorDistSq < best.score) {
            best = { proxy: candidateProxy, center: localBest.center, rotationZ, score: localBest.anchorDistSq };
          }
        }

        if (best) {
          placed.push({
            model,
            center: best.center,
            rotationZ: best.rotationZ,
            hull: best.proxy.hull,
            halfW: best.proxy.halfW,
            halfD: best.proxy.halfD,
            localMinX: best.proxy.localMinX,
            localMaxX: best.proxy.localMaxX,
            localMinY: best.proxy.localMinY,
            localMaxY: best.proxy.localMaxY,
          });
          continue;
        }

        const fallback = getHullAtRotation(model, t.rotation.z);
        const outsideGap = Math.max(8, spacing);
        const spillIndex = spills.length;
        const spillCenter = new THREE.Vector2(
          maxX + outsideGap - fallback.localMinX,
          minY - fallback.localMinY + spillIndex * ((fallback.localMaxY - fallback.localMinY) + spacing),
        );
        spills.push({
          model,
          center: spillCenter,
          rotationZ: t.rotation.z,
          hull: fallback.points, halfW: fallback.halfW, halfD: fallback.halfD,
          localMinX: fallback.localMinX, localMaxX: fallback.localMaxX,
          localMinY: fallback.localMinY, localMaxY: fallback.localMaxY,
        });
      }

      // Second chance pass: after initial fill, try to fit spills into gaps again
      // using all rotation options while the plate context is now richer.
      if (spills.length > 0) {
        const remainingSpills: Placed[] = [];
        const retryOrder = [...spills].sort((a, b) => {
          const aw = a.localMaxX - a.localMinX;
          const ad = a.localMaxY - a.localMinY;
          const bw = b.localMaxX - b.localMinX;
          const bd = b.localMaxY - b.localMinY;
          return (aw * ad) - (bw * bd);
        });

        for (const spill of retryOrder) {
          const model = spill.model;
          const t = modelTransformById.get(model.id) ?? model.transform;
          const neighborPool: CollisionProxy[] = [...placed, ...blockers];
          const candidateNeighbors = neighborPool.length > MAX_CANDIDATE_NEIGHBORS
            ? neighborPool
              .slice()
              .sort((a, b) => a.center.distanceToSquared(anchor) - b.center.distanceToSquared(anchor))
              .slice(0, MAX_CANDIDATE_NEIGHBORS)
            : neighborPool;
          const collisionPool = [...placed, ...blockers];

          const angleOptions = (() => {
            const base = makeRotationOptions(t.rotation.z);
            if (SAME_GEOMETRY_FAST_PATH && sharedBestRotation != null) {
              const alternatives = base.filter((a) => Math.abs(a - sharedBestRotation) > 1e-5).slice(0, 2);
              return [sharedBestRotation, ...alternatives];
            }
            if (sharedBestRotation == null) return base;
            return [sharedBestRotation, ...base.filter((a) => Math.abs(a - sharedBestRotation) > 1e-5)];
          })();

          let best: { proxy: CollisionProxy; center: THREE.Vector2; rotationZ: number; score: number } | null = null;

          for (const rotationZ of angleOptions) {
            const h = getHullAtRotation(model, rotationZ);
            const candidateProxy: CollisionProxy = {
              center: new THREE.Vector2(),
              hull: h.points, halfW: h.halfW, halfD: h.halfD,
              localMinX: h.localMinX, localMaxX: h.localMaxX,
              localMinY: h.localMinY, localMaxY: h.localMaxY,
            };

            const minCenterX = minX - h.localMinX;
            const maxCenterX = maxX - h.localMaxX;
            const minCenterY = minY - h.localMinY;
            const maxCenterY = maxY - h.localMaxY;
            if (minCenterX > maxCenterX || minCenterY > maxCenterY) continue;

            const seen = new Set<string>();
            const cands: Array<{ x: number; y: number; sortKey: number }> = [];
            const addCandidate = (x: number, y: number) => {
              if (cands.length >= MAX_CANDIDATE_BUFFER) return;
              const cx = Math.min(maxCenterX, Math.max(minCenterX, x));
              const cy = Math.min(maxCenterY, Math.max(minCenterY, y));
              const k = `${cx.toFixed(2)}:${cy.toFixed(2)}`;
              if (seen.has(k)) return;
              seen.add(k);
              const dx = cx - anchor.x;
              const dy = cy - anchor.y;
              cands.push({ x: cx, y: cy, sortKey: dx * dx + dy * dy });
            };

            addCandidate(anchor.x, anchor.y);
            addCandidate(minCenterX, minCenterY);
            addCandidate(maxCenterX, minCenterY);
            addCandidate(minCenterX, maxCenterY);
            addCandidate(maxCenterX, maxCenterY);

            for (const other of candidateNeighbors) {
              if (cands.length >= MAX_CANDIDATE_BUFFER) break;
              const ob = worldBoundsAt(other, other.center);
              addCandidate(ob.maxX + minSpacing - h.localMinX, other.center.y);
              addCandidate(ob.minX - minSpacing - h.localMaxX, other.center.y);
              addCandidate(other.center.x, ob.maxY + minSpacing - h.localMinY);
              addCandidate(other.center.x, ob.minY - minSpacing - h.localMaxY);
              addCandidate(ob.maxX + minSpacing - h.localMinX, anchor.y);
              addCandidate(anchor.x, ob.maxY + minSpacing - h.localMinY);
            }

            if (USE_CONTACT_CANDIDATES) {
              const contactRaw: Array<{ x: number; y: number }> = [];
              buildContactCandidates(
                h,
                candidateNeighbors,
                minCenterX,
                maxCenterX,
                minCenterY,
                maxCenterY,
                contactRaw,
                MAX_CONTACT_CANDIDATES,
              );
              for (const c of contactRaw) addCandidate(c.x, c.y);
            }

            const pitchX = Math.max(1, (h.localMaxX - h.localMinX) + minSpacing);
            const pitchY = Math.max(1, (h.localMaxY - h.localMinY) + minSpacing);
            const colsX = Math.ceil((maxCenterX - minCenterX) / pitchX) + 1;
            const rowsY = Math.ceil((maxCenterY - minCenterY) / pitchY) + 1;
            const totalLatticeCells = (colsX + 1) * (rowsY + 1) * 1.5;
            const latticeStride = Math.max(1, Math.ceil(totalLatticeCells / Math.max(1, MAX_LATTICE_CANDIDATES)));
            let latticeCounter = 0;
            for (let ix = 0; ix <= colsX; ix++) {
              for (let iy = 0; iy <= rowsY; iy++) {
                if ((latticeCounter++ % latticeStride) !== 0) continue;
                addCandidate(minCenterX + ix * pitchX, minCenterY + iy * pitchY);
                if (iy % 2 === 1) {
                  addCandidate(minCenterX + ix * pitchX + pitchX * 0.5, minCenterY + iy * pitchY);
                }
              }
            }

            cands.sort((a, b) => a.sortKey - b.sortKey);
            for (let ci = 0; ci < cands.length && ci < MAX_EVALUATED_CANDIDATES; ci++) {
              const c = cands[ci];
              const center = new THREE.Vector2(c.x, c.y);
              if (canPlaceAt(candidateProxy, center, collisionPool)) {
                if (!best || c.sortKey < best.score) {
                  best = { proxy: candidateProxy, center, rotationZ, score: c.sortKey };
                }
                break;
              }
            }
          }

          if (best) {
            placed.push({
              model,
              center: best.center,
              rotationZ: best.rotationZ,
              hull: best.proxy.hull,
              halfW: best.proxy.halfW,
              halfD: best.proxy.halfD,
              localMinX: best.proxy.localMinX,
              localMaxX: best.proxy.localMaxX,
              localMinY: best.proxy.localMinY,
              localMaxY: best.proxy.localMaxY,
            });
          } else {
            remainingSpills.push(spill);
          }
        }

        spills = remainingSpills;
      }

      return { placed, spills };
      };

      // ── Multi-ordering retry ─────────────────────────────────────────────────
      // Try the primary ordering; if models spill, retry with alternative
      // orderings and keep the result with fewest spills.
      let bestResult = attemptPlacement(modelOrder);

      if (ENABLE_MULTI_ORDERING_RETRY && bestResult.spills.length > 0) {
        // Give spilled models first dibs on plate positions
        const spillIds = new Set(bestResult.spills.map(s => s.model.id));
        const spillFirstOrder = [
          ...modelOrder.filter(m => spillIds.has(m.id)),
          ...modelOrder.filter(m => !spillIds.has(m.id)),
        ];
        const attempt = attemptPlacement(spillFirstOrder);
        if (attempt.spills.length < bestResult.spills.length) bestResult = attempt;
      }

      if (ENABLE_MULTI_ORDERING_RETRY && bestResult.spills.length > 0) {
        // Smallest-first: small models fill gaps more flexibly
        const attempt = attemptPlacement([...modelOrder].reverse());
        if (attempt.spills.length < bestResult.spills.length) bestResult = attempt;
      }

      if (ENABLE_MULTI_ORDERING_RETRY && bestResult.spills.length > 0) {
        // Interleaved: alternate large/small to balance coverage and gap-filling
        const interleaved: typeof modelOrder = [];
        let lo = 0; let hi = modelOrder.length - 1;
        while (lo <= hi) {
          interleaved.push(modelOrder[lo++]);
          if (lo <= hi) interleaved.push(modelOrder[hi--]);
        }
        const attempt = attemptPlacement(interleaved);
        if (attempt.spills.length < bestResult.spills.length) bestResult = attempt;
      }

      const placed = bestResult.placed;
      const spills = bestResult.spills;

      // ── Multi-axis compaction ────────────────────────────────────────────────
      // Move each model toward the anchor, then independently squeeze it along
      // pure X and pure Y.  Multiple passes let models ripple into the gaps
      // opened by their neighbours.
      const COMPACTION_PASSES = PERF_COMPLEX_SCENE ? 6 : 8;
      const COMPACTION_STEPS = PERF_COMPLEX_SCENE ? 12 : 16;

      const binarySlide = (entry: Placed, dir: THREE.Vector2, others: CollisionProxy[]) => {
        const start = entry.center.clone();
        if (dir.lengthSq() <= 1e-10) return false;
        let lo = 0; let hi = 1;
        for (let s = 0; s < COMPACTION_STEPS; s++) {
          const mid = (lo + hi) * 0.5;
          const c = new THREE.Vector2(start.x + dir.x * mid, start.y + dir.y * mid);
          if (canPlaceAt(entry, c, others)) lo = mid; else hi = mid;
        }
        if (lo > 1e-4) {
          entry.center.set(start.x + dir.x * lo, start.y + dir.y * lo);
          return true;
        }
        return false;
      };

      for (let pass = 0; pass < COMPACTION_PASSES; pass++) {
        let moved = false;
        // Process farthest-from-anchor first so inner models don't block outer ones
        const order = placed
          .map((_, i) => i)
          .sort((a, b) => placed[b].center.distanceToSquared(anchor) - placed[a].center.distanceToSquared(anchor));

        for (const idx of order) {
          const entry = placed[idx];
          const others: CollisionProxy[] = [...blockers];
          for (let oi = 0; oi < placed.length; oi++) {
            if (oi !== idx) others.push(placed[oi]);
          }
          // Diagonal toward anchor
          const toAnchor = new THREE.Vector2(anchor.x - entry.center.x, anchor.y - entry.center.y);
          if (binarySlide(entry, toAnchor, others)) moved = true;
          // Pure X toward anchor
          const toAnchorX = new THREE.Vector2(anchor.x - entry.center.x, 0);
          if (binarySlide(entry, toAnchorX, others)) moved = true;
          // Pure Y toward anchor
          const toAnchorY = new THREE.Vector2(0, anchor.y - entry.center.y);
          if (binarySlide(entry, toAnchorY, others)) moved = true;
        }

        if (!moved) break;
      }

      // ── Re-layout spills using regular column-based packing ──────────────
      if (spills.length > 0) {
        const outsideGap = Math.max(8, spacing);
        let columnLeftX = maxX + outsideGap;
        let columnYCursor = minY;
        let columnMaxWidth = 0;

        for (const entry of spills) {
          const w = entry.localMaxX - entry.localMinX;
          const d = entry.localMaxY - entry.localMinY;

          // Wrap to next column if this model would exceed plate depth
          if (columnYCursor > minY && (columnYCursor + d) > maxY) {
            columnLeftX += columnMaxWidth + outsideGap;
            columnMaxWidth = 0;
            columnYCursor = minY;
          }

          entry.center.set(
            columnLeftX - entry.localMinX,
            columnYCursor - entry.localMinY,
          );

          columnYCursor += d + spacing;
          columnMaxWidth = Math.max(columnMaxWidth, w);
        }
      }

      const updates = [...placed, ...spills].map((entry) => {
        const t = modelTransformById.get(entry.model.id) ?? entry.model.transform;
        return {
          id: entry.model.id,
          transform: {
            position: new THREE.Vector3(entry.center.x, entry.center.y, t.position.z),
            rotation: new THREE.Euler(t.rotation.x, t.rotation.y, entry.rotationZ, t.rotation.order),
            scale: t.scale.clone(),
          },
        };
      });

      if (updates.length > 1) {
        applyArrangeTransforms(updates);
        transformMgr.setTransformMode('select');
      }
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
    }
  }, [
    arrangeAllowRotateOnZ,
    arrangeAnchorMode,
    arrangeSpacingMm,
    getArrangeTransform,
    isAutoArranging,
    resolveArrangeVisibleModels,
    scene,
    sleep,
    transformMgr,
    applyArrangeTransforms,
  ]);

  const computeManualArrayArrangeUpdates = React.useCallback((scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);

    const modelTransformById = new Map(
      visibleModels.map((model) => [model.id, getArrangeTransform(model)] as const),
    );

    if (visibleModels.length <= 1) return { models: visibleModels, updates: [] as Array<{ id: string; transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } }> };

    const countX = Math.max(1, Math.round(arrangeArrayCountX));
    const countY = Math.max(1, Math.round(arrangeArrayCountY));
    const countZ = Math.max(1, Math.round(arrangeArrayCountZ));

    const gapX = Math.max(0, arrangeArrayGapX);
    const gapY = Math.max(0, arrangeArrayGapY);
    const gapZ = Math.max(0, arrangeArrayGapZ);

    const baseDims = visibleModels.map((model) => {
      const t = modelTransformById.get(model.id) ?? model.transform;
      const projected = getModelBoundingFootprintMm(model, undefined, t);
      const size = model.geometry.size;
      const scaledHeight = Math.max(2, Math.abs(size.z * t.scale.z));

      return {
        width: projected.width,
        depth: projected.depth,
        height: scaledHeight,
      };
    });

    const maxWidth = Math.max(...baseDims.map((d) => d.width));
    const maxDepth = Math.max(...baseDims.map((d) => d.depth));
    const maxHeight = Math.max(...baseDims.map((d) => d.height));

    const stepX = maxWidth + gapX;
    const stepY = maxDepth + gapY;
    const stepZ = maxHeight + gapZ;

    const minX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
    const maxX = minX + scene.view3dSettings.widthMm;
    const minY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
    const maxY = minY + scene.view3dSettings.depthMm;

    const slotsPerLayer = countX * countY;
    const requiredLayers = Math.max(1, Math.ceil(visibleModels.length / slotsPerLayer));
    const usedCountZ = Math.max(countZ, requiredLayers);

    const totalWidth = (countX - 1) * stepX;
    const totalDepth = (countY - 1) * stepY;

    let startX = (scene.view3dSettings.originMode === 'front_left' ? scene.view3dSettings.widthMm * 0.5 : 0) - (totalWidth * 0.5);
    let startY = (scene.view3dSettings.originMode === 'front_left' ? scene.view3dSettings.depthMm * 0.5 : 0) - (totalDepth * 0.5);

    if (arrangeAnchorMode === 'front_left') {
      startX = minX + (maxWidth * 0.5);
      startY = minY + (maxDepth * 0.5);
    } else if (arrangeAnchorMode === 'front_right') {
      startX = maxX - (maxWidth * 0.5) - totalWidth;
      startY = minY + (maxDepth * 0.5);
    } else if (arrangeAnchorMode === 'back_left') {
      startX = minX + (maxWidth * 0.5);
      startY = maxY - (maxDepth * 0.5) - totalDepth;
    } else if (arrangeAnchorMode === 'back_right') {
      startX = maxX - (maxWidth * 0.5) - totalWidth;
      startY = maxY - (maxDepth * 0.5) - totalDepth;
    }

    const baseZ = Math.min(...visibleModels.map((model) => (modelTransformById.get(model.id) ?? model.transform).position.z));

    const updates = visibleModels.map((model, index) => {
      const t = modelTransformById.get(model.id) ?? model.transform;
      const xIndex = index % countX;
      const yIndex = Math.floor(index / countX) % countY;
      const zIndex = Math.floor(index / (countX * countY)) % usedCountZ;

      return {
        id: model.id,
        transform: {
          position: new THREE.Vector3(
            startX + (xIndex * stepX),
            startY + (yIndex * stepY),
            baseZ + (zIndex * stepZ),
          ),
          rotation: t.rotation.clone(),
          scale: t.scale.clone(),
        },
      };
    });

    return { models: visibleModels, updates };
  }, [
    arrangeAnchorMode,
    arrangeArrayCountX,
    arrangeArrayCountY,
    arrangeArrayCountZ,
    arrangeArrayGapX,
    arrangeArrayGapY,
    arrangeArrayGapZ,
    scene.models,
    scene.selectedModelIds,
    scene.view3dSettings.depthMm,
    scene.view3dSettings.originMode,
    scene.view3dSettings.widthMm,
    getArrangeTransform,
    getModelBoundingFootprintMm,
    resolveArrangeVisibleModels,
  ]);

  const handleManualArrayArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setIsAutoArranging(true);
    await sleep(0);

    try {
      const { updates } = computeManualArrayArrangeUpdates(scope, explicitSelectedIds);
      if (updates.length <= 1) return;

      applyArrangeTransforms(updates);
      transformMgr.setTransformMode('select');
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
    }
  }, [
    arrangeAnchorMode,
    arrangeArrayCountX,
    arrangeArrayCountY,
    arrangeArrayCountZ,
    arrangeArrayGapX,
    arrangeArrayGapY,
    arrangeArrayGapZ,
    computeManualArrayArrangeUpdates,
    isAutoArranging,
    scene,
    sleep,
    transformMgr,
    applyArrangeTransforms,
  ]);

  React.useEffect(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'arrange' || arrangeLayoutMode !== 'array') {
      setArrangeArrayPreviewItems([]);
      return;
    }

    const selectedVisibleCount = scene.models.filter((m) => m.visible && scene.selectedModelIds.includes(m.id)).length;
    const previewScope: 'all' | 'selected' = selectedVisibleCount > 1 ? 'selected' : 'all';
    const { models: previewModels, updates } = computeManualArrayArrangeUpdates(previewScope);

    if (updates.length <= 1 || previewModels.length <= 1) {
      setArrangeArrayPreviewItems([]);
      return;
    }

    const updateMap = new Map(updates.map((update) => [update.id, update.transform]));
    const previewItems = previewModels
      .map((model) => {
        const previewTransform = updateMap.get(model.id);
        if (!previewTransform) return null;
        return {
          model,
          transform: {
            position: previewTransform.position.clone(),
            rotation: previewTransform.rotation.clone(),
            scale: previewTransform.scale.clone(),
          },
        };
      })
      .filter((item): item is { model: (typeof scene.models)[number]; transform: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 } } => item !== null);

    setArrangeArrayPreviewItems(previewItems);
  }, [
    arrangeLayoutMode,
    computeManualArrayArrangeUpdates,
    scene.mode,
    scene.models,
    scene.selectedModelIds,
    transformMgr.transformMode,
  ]);

  const computeArrangeSlots = React.useCallback((count: number, stepX: number, stepY: number) => {
    const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.ceil(count / columns);
    const centerX = scene.view3dSettings.originMode === 'front_left' ? scene.view3dSettings.widthMm * 0.5 : 0;
    const centerY = scene.view3dSettings.originMode === 'front_left' ? scene.view3dSettings.depthMm * 0.5 : 0;
    const startX = centerX - ((columns - 1) * stepX) * 0.5;
    const startY = centerY - ((rows - 1) * stepY) * 0.5;

    return Array.from({ length: count }, (_, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      return new THREE.Vector3(startX + col * stepX, startY + row * stepY, 0);
    });
  }, [scene.view3dSettings.depthMm, scene.view3dSettings.originMode, scene.view3dSettings.widthMm]);

  useUndoRedoHotkeys();
  useDeleteHotkey();
  useCameraProjectionHotkey();
  usePrepareTransformHotkeys({
    appMode: scene.mode,
    hasModels: scene.models.length > 0,
    transformMode: transformMgr.transformMode,
    setTransformMode: transformMgr.setTransformMode,
    onArrangeAll: () => {
      void (arrangeLayoutMode === 'array'
        ? handleManualArrayArrangeModels('all')
        : (arrangePrecisionMode === 'high_precision'
          ? handleHighPrecisionArrangeModels('all')
          : handleAutoArrangeModels('all')));
    },
  });

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
    if (!hasActivePrinterProfile) return;
    if (!allowPrepareWithoutPrinter) return;
    setAllowPrepareWithoutPrinter(false);
  }, [allowPrepareWithoutPrinter, hasActivePrinterProfile]);

  React.useEffect(() => {
    const workspaceProjectionMode = getSavedWorkspaceCameraSettings().defaults[scene.mode];
    const currentProjectionMode = getSavedCameraProjectionSettings().mode;

    if (workspaceProjectionMode !== currentProjectionMode) {
      saveCameraProjectionSettings({ mode: workspaceProjectionMode });
    }
  }, [scene.mode]);

  React.useEffect(() => {
    const workspaceSelectionHighlightMode = getSavedWorkspaceCameraSettings().selectionHighlightDefaults[scene.mode];
    if (workspaceSelectionHighlightMode !== scene.selectionHighlightMode) {
      scene.setSelectionHighlightMode(workspaceSelectionHighlightMode);
    }
  }, [scene.mode, scene.selectionHighlightMode, scene.setSelectionHighlightMode]);

  React.useEffect(() => {
    if (scene.mode !== 'support') {
      setIsSupportSpotlightHoldActive(false);
      return;
    }

    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const binding = { key: supportSpotlightHoldHotkey.key, modifier: supportSpotlightHoldHotkey.modifier };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (!matchesConfiguredHotkeyDown(event, binding)) return;
      setIsSupportSpotlightHoldActive(true);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (!matchesConfiguredHotkeyUp(event, binding)) return;
      setIsSupportSpotlightHoldActive(false);
    };

    const handleBlur = () => {
      setIsSupportSpotlightHoldActive(false);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [scene.mode, supportSpotlightHoldHotkey.key, supportSpotlightHoldHotkey.modifier]);

  const effectiveSelectionHighlightMode = React.useMemo(() => {
    if (scene.mode !== 'support') return scene.selectionHighlightMode;
    if (isSupportSpotlightHoldActive) return 'spotlight';
    return scene.selectionHighlightMode === 'spotlight' ? 'tint' : scene.selectionHighlightMode;
  }, [isSupportSpotlightHoldActive, scene.mode, scene.selectionHighlightMode]);

  React.useEffect(() => {
    if (scene.mode !== 'support') return;
    if (scene.activeModelId) return;
    if (scene.models.length === 0) return;

    const firstVisible = scene.models.find((model) => model.visible) ?? scene.models[0];
    if (firstVisible) {
      scene.setActiveModelId(firstVisible.id);
    }
  }, [scene.mode, scene.activeModelId, scene.models, scene.setActiveModelId]);

  React.useEffect(() => {
    if (scene.mode !== 'support') return;
    if (scene.selectedModelIds.length <= 1) return;

    const selectedIdSet = new Set(scene.selectedModelIds);
    const firstValidSelectedId = scene.selectedModelIds.find((id) => scene.models.some((model) => model.id === id));
    const firstVisibleSelectedId = scene.models.find((model) => model.visible && selectedIdSet.has(model.id))?.id;
    const keptId = firstVisibleSelectedId ?? firstValidSelectedId;

    if (!keptId) {
      scene.clearModelSelection();
      return;
    }

    scene.setSelectedModelIds([keptId]);
    if (scene.activeModelId !== keptId) {
      scene.setActiveModelId(keptId);
    }
  }, [
    scene.mode,
    scene.selectedModelIds,
    scene.models,
    scene.activeModelId,
    scene.setActiveModelId,
    scene.setSelectedModelIds,
    scene.clearModelSelection,
  ]);

  React.useEffect(() => {
    if (scene.mode !== 'support') return;
    if (scene.models.length === 0) return;

    const modelIdSet = new Set(scene.models.map((model) => model.id));
    const activeId = scene.activeModelId;

    if (activeId && modelIdSet.has(activeId)) {
      if (scene.selectedModelIds.length === 1 && scene.selectedModelIds[0] === activeId) {
        return;
      }

      if (scene.selectedModelIds.length === 0 || !scene.selectedModelIds.includes(activeId)) {
        scene.setSelectedModelIds([activeId]);
        return;
      }

      if (scene.selectedModelIds.length > 1) {
        scene.setSelectedModelIds([activeId]);
      }
      return;
    }

    const fallback = scene.models.find((model) => model.visible) ?? scene.models[0];
    if (!fallback) return;

    scene.setActiveModelId(fallback.id);
    scene.setSelectedModelIds([fallback.id]);
  }, [
    scene.mode,
    scene.models,
    scene.activeModelId,
    scene.selectedModelIds,
    scene.setActiveModelId,
    scene.setSelectedModelIds,
  ]);

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
  const postRotateLiftScheduledRef = useRef(false);
  renderId.current++;

  // Glue Logic: Transform End Hook
  // When rotation ends, we must clear scan data as it invalidates the scan
  const applyPostRotateLift = () => {
    if (!scene.activeModelId) {
      transformMgr.pendingTransformRef.current = null;
      return;
    }

    if (postRotateLiftScheduledRef.current) {
      return;
    }
    postRotateLiftScheduledRef.current = true;

    // Run immediately: onRotateEnd already writes the latest transform into
    // pendingTransformRef, so performAutoSnap can safely use current values.
    try {
      transformMgr.performAutoSnap();
    } finally {
      postRotateLiftScheduledRef.current = false;
    }
  };

  const handleTransformEnd = (operation: 'move' | 'rotate' | 'scale') => {
    transformMgr.setIsTransforming(false);

    if (operation === 'rotate') {
      console.log('[Rotation] Clearing scan data - rotation invalidates island detection');
      islands.clearScanData();
      applyPostRotateLift();
    } else {
      transformMgr.pendingTransformRef.current = null;
    }
  };

  const handleRotationComplete = () => {
    islands.clearScanData();
    applyPostRotateLift();
  };

  const handleCameraChange = React.useCallback(() => {
    if (cameraResumeTimeoutRef.current !== null) {
      window.clearTimeout(cameraResumeTimeoutRef.current);
      cameraResumeTimeoutRef.current = null;
    }
    scene.setBackgroundGeometryWorkPaused(true);
  }, [scene]);

  const handleCameraEnd = React.useCallback(() => {
    if (cameraResumeTimeoutRef.current !== null) {
      window.clearTimeout(cameraResumeTimeoutRef.current);
    }

    cameraResumeTimeoutRef.current = window.setTimeout(() => {
      scene.setBackgroundGeometryWorkPaused(false);
      cameraResumeTimeoutRef.current = null;
    }, 140);
  }, [scene]);

  React.useEffect(() => {
    return () => {
      if (cameraResumeTimeoutRef.current !== null) {
        window.clearTimeout(cameraResumeTimeoutRef.current);
      }
      scene.setBackgroundGeometryWorkPaused(false);
    };
  }, [scene]);

  React.useEffect(() => {
    if (scene.mode === 'prepare') return;
    if (!isSelectAllModelsActive) return;
    setIsSelectAllModelsActive(false);
    scene.clearModelSelection();
  }, [isSelectAllModelsActive, scene]);

  React.useEffect(() => {
    const unregister = registerDeleteHandler(
      () => scene.mode === 'prepare' && scene.selectedModelIds.length > 0,
      () => {
        const ids = Array.from(new Set(scene.selectedModelIds));
        scene.deleteModels(ids);
        setIsSelectAllModelsActive(false);
      },
      30,
    );

    return () => {
      unregister();
    };
  }, [scene]);

  React.useEffect(() => {
    const unregister = registerDeleteHandler(
      () => scene.mode === 'prepare' && isSelectAllModelsActive && scene.models.length > 0,
      () => {
        const ids = scene.models.map((model) => model.id);
        scene.deleteModels(ids);
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
      const visibleIds = scene.models.filter((model) => model.visible).map((model) => model.id);
      if (visibleIds.length > 0) {
        scene.setSelectedModelIds(visibleIds);
        scene.setActiveModelId(visibleIds[0]);
      }
      setIsSelectAllModelsActive(true);
    };

    window.addEventListener('keydown', handleGlobalSelectAll, true);
    return () => {
      window.removeEventListener('keydown', handleGlobalSelectAll, true);
    };
  }, [scene]);

  React.useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const handleClipboardHotkeys = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.altKey) return;
      if (isEditableTarget(event.target)) return;
      if (scene.mode !== 'prepare') return;

      const key = event.key.toLowerCase();
      if (key === 'c') {
        if (scene.selectedModelIds.length === 0 && !scene.activeModelId) return;
        event.preventDefault();
        event.stopPropagation();

        if (scene.selectedModelIds.length > 0) {
          scene.copySelectedModels();
        } else if (scene.activeModelId) {
          scene.copyModel(scene.activeModelId);
        }
        return;
      }

      if (key === 'v') {
        if (!scene.canPasteModel) return;
        event.preventDefault();
        event.stopPropagation();
        scene.pasteCopiedModelsAutoArrange(arrangeSpacingMm);
      }
    };

    window.addEventListener('keydown', handleClipboardHotkeys, true);
    return () => {
      window.removeEventListener('keydown', handleClipboardHotkeys, true);
    };
  }, [arrangeSpacingMm, scene]);

  React.useEffect(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'duplicate') {
      setDuplicatePreviewTransforms([]);
      setDuplicateSourcePreviewTransform(null);
      return;
    }

    if (!scene.activeModel) {
      setDuplicatePreviewTransforms([]);
      setDuplicateSourcePreviewTransform(null);
      return;
    }

    const model = scene.activeModel;
    const baseWidth = Math.max(2, Math.abs(model.geometry.size.x * model.transform.scale.x));
    const baseDepth = Math.max(2, Math.abs(model.geometry.size.y * model.transform.scale.y));
    const z = model.transform.rotation.z;
    const c = Math.abs(Math.cos(z));
    const s = Math.abs(Math.sin(z));
    const width = (baseWidth * c) + (baseDepth * s);
    const depth = (baseWidth * s) + (baseDepth * c);
    const height = Math.max(2, Math.abs(model.geometry.size.z * model.transform.scale.z));

    const slots: THREE.Vector3[] = [];

    if (duplicateLayoutMode === 'array') {
      const countX = Math.max(1, Math.round(duplicateArrayCountX));
      const countY = Math.max(1, Math.round(duplicateArrayCountY));
      const countZ = Math.max(1, Math.round(duplicateArrayCountZ));
      const stepX = width + Math.max(0, duplicateArrayGapX);
      const stepY = depth + Math.max(0, duplicateArrayGapY);
      const stepZ = height + Math.max(0, duplicateArrayGapZ);

      const originOffsetX = ((countX - 1) * stepX) * 0.5;
      const originOffsetY = ((countY - 1) * stepY) * 0.5;
      const originOffsetZ = ((countZ - 1) * stepZ) * 0.5;

      for (let z = 0; z < countZ; z += 1) {
        for (let y = 0; y < countY; y += 1) {
          for (let x = 0; x < countX; x += 1) {
            slots.push(new THREE.Vector3(
              model.transform.position.x + (x * stepX) - originOffsetX,
              model.transform.position.y + (y * stepY) - originOffsetY,
              model.transform.position.z + (z * stepZ) - originOffsetZ,
            ));
          }
        }
      }
    } else {
      const totalCount = Math.max(1, duplicateTotalCopies);
      const spacing = Math.max(0, duplicateSpacingMm);

      const minX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
      const maxX = minX + scene.view3dSettings.widthMm;
      const minY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
      const maxY = minY + scene.view3dSettings.depthMm;

      const plateWidth = Math.max(1, maxX - minX);
      const plateDepth = Math.max(1, maxY - minY);

      const maxCols = Math.max(1, Math.floor((plateWidth + spacing) / (width + spacing)));
      const maxRows = Math.max(1, Math.floor((plateDepth + spacing) / (depth + spacing)));
      const usedCols = maxCols;
      const usedRows = maxRows;

      const totalUsedWidth = (usedCols * width) + Math.max(0, usedCols - 1) * spacing;
      const totalUsedDepth = (usedRows * depth) + Math.max(0, usedRows - 1) * spacing;

      const startX = minX + ((plateWidth - totalUsedWidth) * 0.5) + (width * 0.5);
      const startY = minY + ((plateDepth - totalUsedDepth) * 0.5) + (depth * 0.5);

      type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

      const intersectsRect = (a: Rect2D, b: Rect2D) => {
        return !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY);
      };

      const modelToRect = (m: (typeof scene.models)[number]): Rect2D => {
        const mBaseW = Math.max(2, Math.abs(m.geometry.size.x * m.transform.scale.x));
        const mBaseD = Math.max(2, Math.abs(m.geometry.size.y * m.transform.scale.y));
        const rz = m.transform.rotation.z;
        const rc = Math.abs(Math.cos(rz));
        const rs = Math.abs(Math.sin(rz));
        const mW = (mBaseW * rc) + (mBaseD * rs);
        const mD = (mBaseW * rs) + (mBaseD * rc);
        return {
          minX: m.transform.position.x - (mW * 0.5),
          maxX: m.transform.position.x + (mW * 0.5),
          minY: m.transform.position.y - (mD * 0.5),
          maxY: m.transform.position.y + (mD * 0.5),
        };
      };

      const blockedRects = scene.models
        .filter((m) => m.visible && m.id !== model.id)
        .map(modelToRect);

      const candidateCenters: Array<{ x: number; y: number; distSq: number }> = [];
      for (let row = 0; row < maxRows; row += 1) {
        for (let col = 0; col < maxCols; col += 1) {
          const x = startX + col * (width + spacing);
          const y = startY + row * (depth + spacing);
          const dx = x - model.transform.position.x;
          const dy = y - model.transform.position.y;
          candidateCenters.push({ x, y, distSq: dx * dx + dy * dy });
        }
      }

      candidateCenters.sort((a, b) => a.distSq - b.distSq);

      const chosenCenters: Array<{ x: number; y: number }> = [];
      for (const candidate of candidateCenters) {
        if (chosenCenters.length >= totalCount) break;

        const rect: Rect2D = {
          minX: candidate.x - (width * 0.5),
          maxX: candidate.x + (width * 0.5),
          minY: candidate.y - (depth * 0.5),
          maxY: candidate.y + (depth * 0.5),
        };

        if (blockedRects.some((blocked) => intersectsRect(rect, blocked))) {
          continue;
        }

        chosenCenters.push({ x: candidate.x, y: candidate.y });
        blockedRects.push(rect);
      }

      for (const center of chosenCenters) {
        slots.push(new THREE.Vector3(center.x, center.y, model.transform.position.z));
      }

      const overflowCount = totalCount - chosenCenters.length;
      if (overflowCount > 0) {
        const outsideGap = Math.max(8, spacing);
        let outsideLeftX = maxX + outsideGap;
        let outsideY = minY;
        let currentColumnMaxWidth = 0;

        for (let i = 0; i < overflowCount; i += 1) {
          if (outsideY > minY && (outsideY + depth) > maxY) {
            outsideLeftX += currentColumnMaxWidth + outsideGap;
            currentColumnMaxWidth = 0;
            outsideY = minY;
          }

          slots.push(new THREE.Vector3(
            outsideLeftX + width * 0.5,
            outsideY + depth * 0.5,
            model.transform.position.z,
          ));

          outsideY += depth + spacing;
          currentColumnMaxWidth = Math.max(currentColumnMaxWidth, width);
        }
      }
    }

    if (slots.length <= 1) {
      setDuplicatePreviewTransforms([]);
      setDuplicateSourcePreviewTransform(null);
      return;
    }

    let sourceSlotIndex = 0;
    let sourceSlotDistanceSq = Number.POSITIVE_INFINITY;

    slots.forEach((slot, index) => {
      const dx = slot.x - model.transform.position.x;
      const dy = slot.y - model.transform.position.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < sourceSlotDistanceSq) {
        sourceSlotDistanceSq = distSq;
        sourceSlotIndex = index;
      }
    });

    const sourceSlot = slots[sourceSlotIndex];
    setDuplicateSourcePreviewTransform({
      position: new THREE.Vector3(sourceSlot.x, sourceSlot.y, sourceSlot.z),
      rotation: model.transform.rotation.clone(),
      scale: model.transform.scale.clone(),
    });

    const previews: Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }> = [];
    slots.forEach((slot, index) => {
      if (index === sourceSlotIndex) return;
      previews.push({
        position: new THREE.Vector3(slot.x, slot.y, slot.z),
        rotation: model.transform.rotation.clone(),
        scale: model.transform.scale.clone(),
      });
    });

    setDuplicatePreviewTransforms(previews);
  }, [
    duplicateArrayCountX,
    duplicateArrayCountY,
    duplicateArrayCountZ,
    duplicateArrayGapX,
    duplicateArrayGapY,
    duplicateArrayGapZ,
    duplicateLayoutMode,
    duplicateSpacingMm,
    duplicateTotalCopies,
    scene.activeModel,
    scene.models,
    scene.mode,
    transformMgr.transformMode,
  ]);

  const handleConfirmDuplicate = React.useCallback(async () => {
    if (isDuplicating) return;
    if (!scene.activeModelId) return;
    if (duplicatePreviewTransforms.length === 0) return;

    const sourceModelAtApplyStart = scene.activeModel;
    const sourcePreviewTransformAtApplyStart = duplicateSourcePreviewTransform;
    if (sourceModelAtApplyStart && sourcePreviewTransformAtApplyStart) {
      setDuplicateApplySourceModel(sourceModelAtApplyStart);
      setDuplicateApplySourceTransform({
        position: sourcePreviewTransformAtApplyStart.position.clone(),
        rotation: sourcePreviewTransformAtApplyStart.rotation.clone(),
        scale: sourcePreviewTransformAtApplyStart.scale.clone(),
      });
    } else {
      setDuplicateApplySourceModel(null);
      setDuplicateApplySourceTransform(null);
    }

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setIsDuplicating(true);
    await sleep(0);

    try {
      scene.duplicateModelWithTransforms(
        scene.activeModelId,
        duplicatePreviewTransforms,
        duplicateSourcePreviewTransform
          ? {
              position: duplicateSourcePreviewTransform.position.clone(),
              rotation: duplicateSourcePreviewTransform.rotation.clone(),
              scale: duplicateSourcePreviewTransform.scale.clone(),
            }
          : null,
      );
      setDuplicateTotalCopies(2);
      setDuplicateSourcePreviewTransform(null);
      setDuplicatePreviewTransforms([]);
      transformMgr.setTransformMode('select');
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsDuplicating(false);
      setDuplicateApplySourceModel(null);
      setDuplicateApplySourceTransform(null);
    }
  }, [duplicatePreviewTransforms, duplicateSourcePreviewTransform, isDuplicating, scene, sleep, transformMgr]);

  const handleFillPlateDuplicate = React.useCallback(() => {
    if (isDuplicating) return;
    if (duplicateLayoutMode !== 'auto') return;
    const model = scene.activeModel;
    if (!model) return;

    const baseWidth = Math.max(2, Math.abs(model.geometry.size.x * model.transform.scale.x));
    const baseDepth = Math.max(2, Math.abs(model.geometry.size.y * model.transform.scale.y));
    const rz = model.transform.rotation.z;
    const rc = Math.abs(Math.cos(rz));
    const rs = Math.abs(Math.sin(rz));
    const width = (baseWidth * rc) + (baseDepth * rs);
    const depth = (baseWidth * rs) + (baseDepth * rc);
    const spacing = Math.max(0, duplicateSpacingMm);

    const minX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
    const maxX = minX + scene.view3dSettings.widthMm;
    const minY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
    const maxY = minY + scene.view3dSettings.depthMm;

    const plateWidth = Math.max(1, maxX - minX);
    const plateDepth = Math.max(1, maxY - minY);
    const maxCols = Math.max(1, Math.floor((plateWidth + spacing) / (width + spacing)));
    const maxRows = Math.max(1, Math.floor((plateDepth + spacing) / (depth + spacing)));

    const totalUsedWidth = (maxCols * width) + Math.max(0, maxCols - 1) * spacing;
    const totalUsedDepth = (maxRows * depth) + Math.max(0, maxRows - 1) * spacing;
    const startX = minX + ((plateWidth - totalUsedWidth) * 0.5) + (width * 0.5);
    const startY = minY + ((plateDepth - totalUsedDepth) * 0.5) + (depth * 0.5);

    type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

    const intersectsRect = (a: Rect2D, b: Rect2D) => {
      return !(a.maxX <= b.minX || a.minX >= b.maxX || a.maxY <= b.minY || a.minY >= b.maxY);
    };

    const modelToRect = (m: (typeof scene.models)[number]): Rect2D => {
      const mBaseW = Math.max(2, Math.abs(m.geometry.size.x * m.transform.scale.x));
      const mBaseD = Math.max(2, Math.abs(m.geometry.size.y * m.transform.scale.y));
      const z = m.transform.rotation.z;
      const c = Math.abs(Math.cos(z));
      const s = Math.abs(Math.sin(z));
      const mW = (mBaseW * c) + (mBaseD * s);
      const mD = (mBaseW * s) + (mBaseD * c);
      return {
        minX: m.transform.position.x - (mW * 0.5),
        maxX: m.transform.position.x + (mW * 0.5),
        minY: m.transform.position.y - (mD * 0.5),
        maxY: m.transform.position.y + (mD * 0.5),
      };
    };

    const blockedRects = scene.models
      .filter((m) => m.visible && m.id !== model.id)
      .map(modelToRect);

    const candidateCenters: Array<{ x: number; y: number; distSq: number }> = [];
    for (let row = 0; row < maxRows; row += 1) {
      for (let col = 0; col < maxCols; col += 1) {
        const x = startX + col * (width + spacing);
        const y = startY + row * (depth + spacing);
        const dx = x - model.transform.position.x;
        const dy = y - model.transform.position.y;
        candidateCenters.push({ x, y, distSq: dx * dx + dy * dy });
      }
    }
    candidateCenters.sort((a, b) => a.distSq - b.distSq);

    let capacity = 0;
    for (const candidate of candidateCenters) {
      const rect: Rect2D = {
        minX: candidate.x - (width * 0.5),
        maxX: candidate.x + (width * 0.5),
        minY: candidate.y - (depth * 0.5),
        maxY: candidate.y + (depth * 0.5),
      };

      if (blockedRects.some((blocked) => intersectsRect(rect, blocked))) {
        continue;
      }

      blockedRects.push(rect);
      capacity += 1;
    }

    const targetCopies = Math.min(128, Math.max(1, capacity));
    setDuplicateTotalCopies(targetCopies);
  }, [duplicateLayoutMode, duplicateSpacingMm, isDuplicating, scene]);

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
        view3dSettings={scene.view3dSettings}
        onView3dSettingsChange={scene.setView3dSettings}
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
              outsidePlateModelIds={outsidePlateModelIds}
              activeModelId={scene.activeModelId}
              selectedModelIds={scene.selectedModelIds}
              onSelect={handleModelSelection}
              onSelectRange={handleModelRangeSelection}
              onSelectGroup={handleGroupSelection}
              onGroupModels={handleGroupSelectedModels}
              onUngroupModels={handleUngroupSelectedModels}
              onUngroupGroup={handleUngroupFolder}
              onRenameGroup={handleRenameFolder}
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

            {scene.geom && transformMgr.transformMode === 'arrange' && (
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
              />
            )}

            {scene.geom && transformMgr.transformMode === 'duplicate' && (
              <DuplicatePanel
                key="prepare-duplicate-panel"
                activeModelName={scene.activeModel?.name ?? null}
                layoutMode={duplicateLayoutMode}
                onLayoutModeChange={setDuplicateLayoutMode}
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
                isApplying={isDuplicating}
              />
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
              className={`ui-panel rounded-lg border shadow-lg overflow-hidden ${supportSettingsExpanded ? 'h-[calc(100vh-var(--topbar-height)-24px)] flex flex-col' : ''}`}
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
                <div className="flex-1 min-h-0 overflow-hidden">
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
            onCrossSectionModeChange={slicing.setCrossSectionMode}
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
              recentOpenedFiles={scene.recentOpenedFiles}
              onReopenRecentFile={scene.reopenRecentOpenedFile}
              isLoading={showInlineEmptyLoading}
              loadingLabel={importOverlayState.label}
              loadingDetail={importOverlayState.detail}
              showFirstTimeOnboarding={!hasActivePrinterProfile && !allowPrepareWithoutPrinter}
              onAddPrinter={handleAddPrinterFromOnboarding}
              onUseWithoutPrinter={handleUseWithoutPrinter}
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
            selectedModelIds={scene.selectedModelIds}
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
            onActiveModelChange={handleSceneModelSelection}
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
            selectionHighlightMode={effectiveSelectionHighlightMode}
            hoverTintStrength={scene.hoverTintStrength}
            selectedTintStrength={scene.selectedTintStrength}
            crossSectionMode={slicing.crossSectionMode}
            pxMm={islands.pxMm}
            supportsRef={supportsRef}
            ghostData={ghostData}
            duplicatePreviewModel={
              isDuplicating
                ? duplicateApplySourceModel
                : (transformMgr.transformMode === 'duplicate' ? scene.activeModel : null)
            }
            duplicatePreviewTransforms={duplicatePreviewTransforms}
            duplicateActivePreviewTransform={
              isDuplicating
                ? duplicateApplySourceTransform
                : duplicateSourcePreviewTransform
            }
            arrangeArrayPreviewItems={arrangeArrayPreviewItems}
            hideDuplicateSourceDuringApply={isDuplicating}
            view3dSettings={scene.view3dSettings}
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
            models={scene.models}
            selectedModelIds={scene.selectedModelIds}
            inBoundsModelIds={inBoundsModelIds}
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

      <DiagnosticsModal
        isOpen={isDiagnosticsOpen}
        onClose={() => setIsDiagnosticsOpen(false)}
        appMode={scene.mode}
        cameraProjectionMode={getSavedCameraProjectionSettings().mode}
        modelCount={scene.models.length}
        visibleModelCount={scene.models.filter((m) => m.visible).length}
        selectedModelCount={scene.selectedModelIds.length}
        totalPolygons={totalPolygons}
        selectedPolygons={selectedPolygons}
      />

    </div>
  );
}
