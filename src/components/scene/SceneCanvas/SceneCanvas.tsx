"use client";

import React from 'react';
import dynamic from 'next/dynamic';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { CrossSectionCap } from '@/components/scene/CrossSectionCap';
import { IslandOverlay } from '@/components/scene/IslandOverlay';
import { IslandVoxelVisualization } from '@/components/scene/IslandVoxelVisualization';
import { IslandExpansionVisualization } from '@/components/scene/IslandExpansionVisualization';
import { MeshClassificationRenderer } from '@/components/scene/MeshClassificationRenderer';
import { IslandIdLabels } from '@/components/scene/IslandIdLabels';
import { ScreenSpaceGizmo as UnifiedGizmo } from '@/components/gizmo';
import { PickingDebugOverlay } from '@/components/picking';
import { SelectionProvider, SelectionManager, SelectionOutlineRenderer, SelectionSpotlight } from '@/components/selection';
import type { SelectionHighlightMode } from '@/components/selection';
import type { IslandMarker } from '@/volumeAnalysis/IslandScan/islandOverlayLogic';
import type { ScanResults } from '@/volumeAnalysis/islandVolume/steps/voxelization/ScanOrchestrator';
import type { BasinFillSimulator } from '@/volumeAnalysis/islandVolume/steps/expansion/BasinFillSimulator';
import type { BasinFillProxy } from '@/volumeAnalysis/islandVolume/steps/expansion/BasinFillProxy';
import type { TransformMode, ModelTransform } from '@/hooks/useModelTransform';
import type { SupportMode } from '@/supports/types';
import { SupportRenderer } from '@/supports/SupportRenderer';
import { SupportBuilder } from '@/supports/rendering';
import type { SupportData } from '@/supports/rendering';
import RaftRenderer from '@/supports/Rafts/Crenelated/rendering/RaftRenderer';
import LineRaftRenderer from '@/supports/Rafts/Crenelated/rendering/LineRaftRenderer';
import FootprintBorderRenderer from '@/supports/Rafts/Crenelated/rendering/FootprintBorderRenderer';
import { JointPlacementPreview } from '@/supports/SupportPrimitives/Joint/JointPlacementPreview';
import { BranchPlacementController } from '@/supports/SupportTypes/Branch/BranchPlacementController';
import { LeafPlacementController } from '@/supports/SupportTypes/Leaf/LeafPlacementController';
import { BracePlacementController } from '@/supports/SupportTypes/Brace/BracePlacementController';
import { SupportBracePlacementController } from '@/supports/SupportTypes/SupportBrace/SupportBracePlacementController';
import { BracePreviewRenderer } from '@/supports/SupportTypes/Brace/BracePreviewRenderer';
import { clearSelection } from '@/supports/interaction/SupportSelection';
import { SupportLimitationFeedback } from '@/supports/PlacementLogic/SupportLimitations';
import { useCurveInteractionState } from '@/supports/Curves/curveInteractionState';
import { DEFAULT_TIP_CONTACT_DIAMETER_MM } from '@/supports/Settings/defaults';

import { GhostOverlay } from '@/components/lys-import/GhostOverlay';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { CameraFocusHotkeyController, CameraHomeResetController, CameraIntroController, SpaceMouseController, useStlLoadCameraIntro } from '@/components/scene/camera';
import { CameraFocusController } from '@/components/scene/CameraFocusController';

import { PickingStateSyncer } from '../PickingStateSyncer';
import { useMeshSmoothingSceneBindings } from '@/features/mesh-smoothing/SceneMeshSmoothingBindings';
import {
  getMeshSmoothingLoadingState,
  getMeshSmoothingProcessingState,
  subscribeToMeshSmoothingLoadingState,
  subscribeToMeshSmoothingProcessingState,
} from '@/features/mesh-smoothing/meshSmoothingEngine';

import { PickingProviderWrapper, SelectionSync, useInteractionWarning } from './SceneSelectionAndPicking';
import { CameraClipPlaneStabilizer, CameraProvider, EnableLocalClipping, Helpers, Lights, LoggingHelper, SceneMoodOverlay } from './SceneEnvironment';
import { StlMesh } from './StlMesh';
import {
  DEFAULT_CAMERA_PROJECTION_SETTINGS,
  getSavedCameraProjectionSettings,
  subscribeToCameraProjectionSettings,
  type CameraProjectionMode,
} from '@/components/settings/cameraProjectionPreferences';
import { DEFAULT_VIEW3D_SETTINGS, type View3DSettings } from '@/components/settings/view3dPreferences';

const Canvas = dynamic(() => import('@react-three/fiber').then(m => m.Canvas), { ssr: false });

function CameraProjectionController({ mode }: { mode: CameraProjectionMode }) {
  const { camera, controls, set, size } = useThree();
  const ORTHO_NEAR = -20000;
  const ORTHO_FAR = 20000;

  React.useEffect(() => {
    const aspect = size.width / Math.max(1, size.height);
    if (mode === 'orthographic' && camera instanceof THREE.OrthographicCamera) {
      camera.left = -aspect;
      camera.right = aspect;
      camera.top = 1;
      camera.bottom = -1;
      camera.near = ORTHO_NEAR;
      camera.far = ORTHO_FAR;
      camera.updateProjectionMatrix();
      return;
    }

    if (mode === 'perspective' && camera instanceof THREE.PerspectiveCamera) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      return;
    }

    const target = (controls as any)?.target instanceof THREE.Vector3
      ? ((controls as any).target as THREE.Vector3).clone()
      : new THREE.Vector3(0, 0, 0);

    if (mode === 'orthographic') {
      const next = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, ORTHO_NEAR, ORTHO_FAR);
      next.position.copy(camera.position);
      next.up.copy(camera.up);

      if (camera instanceof THREE.PerspectiveCamera) {
        const distance = Math.max(0.001, camera.position.distanceTo(target));
        const fov = THREE.MathUtils.degToRad(camera.fov);
        const worldHeight = Math.max(1e-6, 2 * Math.tan(fov * 0.5) * distance);
        next.zoom = Math.max(0.0001, 2 / worldHeight);
      } else {
        next.zoom = (camera as THREE.OrthographicCamera).zoom;
      }

      next.updateProjectionMatrix();
      set({ camera: next });
      if (controls && typeof controls === 'object' && 'object' in controls) {
        (controls as any).object = next;
        (controls as any).update?.();
      }
      return;
    }

    const next = new THREE.PerspectiveCamera(50, aspect, camera.near ?? 0.02, camera.far ?? 5000);
    next.up.copy(camera.up);

    if (camera instanceof THREE.OrthographicCamera) {
      const span = Math.max(1e-6, (camera.top - camera.bottom) / Math.max(1e-6, camera.zoom));
      const fov = THREE.MathUtils.degToRad(next.fov);
      const distance = Math.max(0.001, span / (2 * Math.tan(fov * 0.5)));
      const direction = camera.position.clone().sub(target);
      if (direction.lengthSq() < 1e-10) direction.set(-1, -1, 1);
      direction.normalize();
      next.position.copy(target.clone().addScaledVector(direction, distance));
    } else {
      next.position.copy(camera.position);
    }

    next.updateProjectionMatrix();
    set({ camera: next });
    if (controls && typeof controls === 'object' && 'object' in controls) {
      (controls as any).object = next;
      (controls as any).update?.();
    }
  }, [camera, controls, mode, set, size.height, size.width]);

  return null;
}

function CameraModeEntryFramingController({
  runId,
  restoreRunId,
  target,
  plateWidthMm,
  plateDepthMm,
}: {
  runId: number;
  restoreRunId: number;
  target: THREE.Vector3;
  plateWidthMm: number;
  plateDepthMm: number;
}) {
  const { camera, controls, size } = useThree();

  const activeRunIdRef = React.useRef<number | null>(null);
  const completedFrameRunIdRef = React.useRef(0);
  const completedRestoreRunIdRef = React.useRef(0);
  const animatingRef = React.useRef(false);
  const rafRef = React.useRef<number | null>(null);
  const cameraSnapshotRef = React.useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    zoom: number | null;
  } | null>(null);

  const cancelAnimation = React.useCallback(() => {
    animatingRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const animateTo = React.useCallback((params: {
    startPos: THREE.Vector3;
    endPos: THREE.Vector3;
    startTarget: THREE.Vector3;
    endTarget: THREE.Vector3;
    startZoom: number;
    endZoom: number;
    isOrthographic: boolean;
    durationMs: number;
    onComplete?: () => void;
  }) => {
    const {
      startPos,
      endPos,
      startTarget,
      endTarget,
      startZoom,
      endZoom,
      isOrthographic,
      durationMs,
      onComplete,
    } = params;

    cancelAnimation();
    animatingRef.current = true;

    let startTime: number | null = null;
    const orbit = controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    };

    const tick = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime == null) startTime = now;

      const t = Math.min(1, (now - startTime) / durationMs);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      camera.position.lerpVectors(startPos, endPos, eased);
      orbit.target.lerpVectors(startTarget, endTarget, eased);

      if (isOrthographic) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.zoom = THREE.MathUtils.lerp(startZoom, endZoom, eased);
        ortho.updateProjectionMatrix();
      }

      orbit.update();

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        animatingRef.current = false;
        rafRef.current = null;
        onComplete?.();
      }
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [camera, cancelAnimation, controls]);

  React.useLayoutEffect(() => {
    if (!runId) return;
    if (completedFrameRunIdRef.current === runId) return;
    if (activeRunIdRef.current === runId) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls) || !('update' in controls)) return;

    const orbit = controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    };

    activeRunIdRef.current = runId;

    const startPos = camera.position.clone();
    const startTarget = orbit.target.clone();

    cameraSnapshotRef.current = {
      position: startPos.clone(),
      target: startTarget.clone(),
      zoom: camera instanceof THREE.OrthographicCamera ? camera.zoom : null,
    };

    const padding = 1.04;
    const fov = camera instanceof THREE.PerspectiveCamera
      ? THREE.MathUtils.degToRad(camera.fov)
      : THREE.MathUtils.degToRad(50);
    const aspect = size.width / Math.max(1, size.height);
    const hFov = 2 * Math.atan(Math.tan(fov * 0.5) * aspect);
    const minFov = Math.max(0.0001, Math.min(fov, hFov));

    const halfDiagonal = 0.5 * Math.hypot(plateWidthMm, plateDepthMm) * padding;
    const distance = Math.max(90, halfDiagonal / Math.sin(minFov * 0.5));
  const viewDir = new THREE.Vector3(0, -0.52, 1).normalize(); // front-facing top-side birds-eye
    const endTarget = target.clone().add(new THREE.Vector3(0, -plateDepthMm * 0.055, 0));
    const endPos = endTarget.clone().addScaledVector(viewDir, distance);

    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;
    let endZoom = startZoom;

    if (isOrthographic) {
      const ortho = camera as THREE.OrthographicCamera;
      const frustumHeight = Math.max(1e-6, ortho.top - ortho.bottom);
      const requiredWorldHeight = Math.max(plateWidthMm, plateDepthMm) * padding;
      endZoom = THREE.MathUtils.clamp(frustumHeight / Math.max(1e-6, requiredWorldHeight), 0.0001, 200);
    }

    animateTo({
      startPos,
      endPos,
      startTarget,
      endTarget,
      startZoom,
      endZoom,
      isOrthographic,
      durationMs: 700,
      onComplete: () => {
        activeRunIdRef.current = null;
        completedFrameRunIdRef.current = runId;
      },
    });

    return () => {
      if (activeRunIdRef.current === runId && completedFrameRunIdRef.current !== runId) {
        activeRunIdRef.current = null;
      }
    };
  }, [animateTo, camera, controls, plateDepthMm, plateWidthMm, runId, size.height, size.width, target]);

  React.useLayoutEffect(() => {
    if (!restoreRunId) return;
    if (completedRestoreRunIdRef.current === restoreRunId) return;
    if (activeRunIdRef.current === restoreRunId) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls) || !('update' in controls)) return;

    const snapshot = cameraSnapshotRef.current;
    if (!snapshot) {
      completedRestoreRunIdRef.current = restoreRunId;
      return;
    }

    const orbit = controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    };

    activeRunIdRef.current = restoreRunId;

    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const startPos = camera.position.clone();
    const endPos = snapshot.position.clone();
    const startTarget = orbit.target.clone();
    const endTarget = snapshot.target.clone();
    const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;
    const endZoom = (isOrthographic && snapshot.zoom != null) ? snapshot.zoom : startZoom;

    animateTo({
      startPos,
      endPos,
      startTarget,
      endTarget,
      startZoom,
      endZoom,
      isOrthographic,
      durationMs: 520,
      onComplete: () => {
        activeRunIdRef.current = null;
        completedRestoreRunIdRef.current = restoreRunId;
        cameraSnapshotRef.current = null;
      },
    });

    return () => {
      if (activeRunIdRef.current === restoreRunId && completedRestoreRunIdRef.current !== restoreRunId) {
        activeRunIdRef.current = null;
      }
    };
  }, [animateTo, camera, controls, restoreRunId]);

  React.useEffect(() => {
    return () => {
      cancelAnimation();
    };
  }, [cancelAnimation]);

  return null;
}

function SupportModeCameraRestoreController({
  capturePreSupportRunId,
  restorePreSupportRunId,
  captureSupportRunId,
  restoreSupportRunId,
}: {
  capturePreSupportRunId: number;
  restorePreSupportRunId: number;
  captureSupportRunId: number;
  restoreSupportRunId: number;
}) {
  const { camera, controls } = useThree();

  const preSupportSnapshotRef = React.useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    zoom: number | null;
  } | null>(null);
  const supportSnapshotRef = React.useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    zoom: number | null;
  } | null>(null);
  const capturedPreSupportRunIdRef = React.useRef(0);
  const restoredPreSupportRunIdRef = React.useRef(0);
  const capturedSupportRunIdRef = React.useRef(0);
  const restoredSupportRunIdRef = React.useRef(0);
  const activeRunIdRef = React.useRef<number | null>(null);
  const animatingRef = React.useRef(false);
  const rafRef = React.useRef<number | null>(null);

  const cancelAnimation = React.useCallback(() => {
    animatingRef.current = false;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const ensureAboveTarget = React.useCallback((position: THREE.Vector3, target: THREE.Vector3) => {
    const clamped = position.clone();
    const horizontalDistance = Math.hypot(clamped.x - target.x, clamped.y - target.y);
    const minVerticalClearance = Math.max(10, horizontalDistance * 0.22);
    if (clamped.z < target.z + minVerticalClearance) {
      clamped.z = target.z + minVerticalClearance;
    }
    return clamped;
  }, []);

  React.useLayoutEffect(() => {
    if (!capturePreSupportRunId) return;
    if (capturedPreSupportRunIdRef.current === capturePreSupportRunId) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls)) return;

    const orbit = controls as unknown as { target: THREE.Vector3 };
    preSupportSnapshotRef.current = {
      position: camera.position.clone(),
      target: orbit.target.clone(),
      zoom: camera instanceof THREE.OrthographicCamera ? camera.zoom : null,
    };

    capturedPreSupportRunIdRef.current = capturePreSupportRunId;
  }, [camera, controls, capturePreSupportRunId]);

  React.useLayoutEffect(() => {
    if (!captureSupportRunId) return;
    if (capturedSupportRunIdRef.current === captureSupportRunId) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls)) return;

    const orbit = controls as unknown as { target: THREE.Vector3 };
    supportSnapshotRef.current = {
      position: camera.position.clone(),
      target: orbit.target.clone(),
      zoom: camera instanceof THREE.OrthographicCamera ? camera.zoom : null,
    };

    capturedSupportRunIdRef.current = captureSupportRunId;
  }, [camera, controls, captureSupportRunId]);

  React.useLayoutEffect(() => {
    if (!restorePreSupportRunId) return;
    if (restoredPreSupportRunIdRef.current === restorePreSupportRunId) return;
    if (activeRunIdRef.current === restorePreSupportRunId) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls) || !('update' in controls)) return;

    const snapshot = preSupportSnapshotRef.current;
    if (!snapshot) {
      restoredPreSupportRunIdRef.current = restorePreSupportRunId;
      return;
    }

    const orbit = controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    };

    activeRunIdRef.current = restorePreSupportRunId;
    cancelAnimation();
    animatingRef.current = true;

    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const startPos = camera.position.clone();
    const endPos = ensureAboveTarget(snapshot.position.clone(), snapshot.target);
    const startTarget = orbit.target.clone();
    const endTarget = snapshot.target.clone();
    const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;
    const endZoom = (isOrthographic && snapshot.zoom != null) ? snapshot.zoom : startZoom;

    const duration = 560;
    let startTime: number | null = null;

    const tick = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime == null) startTime = now;

      const t = Math.min(1, (now - startTime) / duration);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      camera.position.lerpVectors(startPos, endPos, eased);
      orbit.target.lerpVectors(startTarget, endTarget, eased);

      if (isOrthographic) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.zoom = THREE.MathUtils.lerp(startZoom, endZoom, eased);
        ortho.updateProjectionMatrix();
      }

      orbit.update();

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        animatingRef.current = false;
        rafRef.current = null;
        activeRunIdRef.current = null;
        restoredPreSupportRunIdRef.current = restorePreSupportRunId;
        preSupportSnapshotRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (
        activeRunIdRef.current === restorePreSupportRunId
        && restoredPreSupportRunIdRef.current !== restorePreSupportRunId
      ) {
        activeRunIdRef.current = null;
      }
    };
  }, [camera, cancelAnimation, controls, restorePreSupportRunId]);

  React.useLayoutEffect(() => {
    if (!restoreSupportRunId) return;
    if (restoredSupportRunIdRef.current === restoreSupportRunId) return;
    if (activeRunIdRef.current === restoreSupportRunId) return;
    if (!controls || typeof controls !== 'object' || !('target' in controls) || !('update' in controls)) return;

    const snapshot = supportSnapshotRef.current;
    if (!snapshot) {
      restoredSupportRunIdRef.current = restoreSupportRunId;
      return;
    }

    const orbit = controls as unknown as {
      target: THREE.Vector3;
      update: () => void;
    };

    activeRunIdRef.current = restoreSupportRunId;
    cancelAnimation();
    animatingRef.current = true;

    const isOrthographic = camera instanceof THREE.OrthographicCamera;
    const startPos = camera.position.clone();
    const endPos = snapshot.position.clone();
    const startTarget = orbit.target.clone();
    const endTarget = snapshot.target.clone();
    const startZoom = isOrthographic ? (camera as THREE.OrthographicCamera).zoom : 1;
    const endZoom = (isOrthographic && snapshot.zoom != null) ? snapshot.zoom : startZoom;

    const duration = 560;
    let startTime: number | null = null;

    const tick = (now: number) => {
      if (!animatingRef.current) return;
      if (startTime == null) startTime = now;

      const t = Math.min(1, (now - startTime) / duration);
      const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      camera.position.lerpVectors(startPos, endPos, eased);
      orbit.target.lerpVectors(startTarget, endTarget, eased);

      if (isOrthographic) {
        const ortho = camera as THREE.OrthographicCamera;
        ortho.zoom = THREE.MathUtils.lerp(startZoom, endZoom, eased);
        ortho.updateProjectionMatrix();
      }

      orbit.update();

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        animatingRef.current = false;
        rafRef.current = null;
        activeRunIdRef.current = null;
        restoredSupportRunIdRef.current = restoreSupportRunId;
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (activeRunIdRef.current === restoreSupportRunId && restoredSupportRunIdRef.current !== restoreSupportRunId) {
        activeRunIdRef.current = null;
      }
    };
  }, [camera, cancelAnimation, controls, ensureAboveTarget, restoreSupportRunId]);

  React.useEffect(() => {
    return () => {
      cancelAnimation();
    };
  }, [cancelAnimation]);

  return null;
}

export function SceneCanvas({
  models: modelsProp = [],
  activeModelId: activeModelIdProp,
  selectedModelIds,
  // Legacy props kept for compatibility if needed
  geom,
  clipLower,
  clipUpper,
  meshColor, // Global fallback color? Each model has color.
  meshVisible, // Global fallback visibility?
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
  xrayOpacity,
  disableRaycast,
  hideCrossSectionCap,
  onCameraChange,
  onCameraEnd,
  islandMarkers,
  overlayBrushRadius,
  overlayColor,
  overlayOpacity,
  overlaySelectedIslandId,
  ambientIntensity,
  directionalIntensity,
  headlightIntensity,
  materialRoughness,
  scanResults,
  layerHeightMm,
  scanBBox,
  voxelEnabled,
  voxelColorScheme,
  voxelSelectedIslandId,
  voxelShowMerged,
  voxelShowTerritory,
  voxelOpacity,
  transformMode,
  transform,
  onTransformChange,
  onTransformChangeEnd, // Was onTransformEnd in previous code, checking usage
  onTransformEnd,
  crossSectionMode,
  pxMm,
  showIslandIdLabels,
  mode,
  onSupportClick,
  onSupportHover,
  onActiveModelChange,
  trunkPlacementPreview,
  branchPlacementPreview,
  leafPlacementPreview,
  bracePlacementPreview,
  supportBracePlacementPreview,
  jointPlacementPreview,
  gpuPickingTest,
  selectionHighlightMode,
  blockSupportPlacement,
  supportsRef,
  ghostData,
  duplicatePreviewModel,
  duplicatePreviewTransforms,
  duplicateActivePreviewTransform,
  arrangeArrayPreviewItems,
  hideDuplicateSourceDuringApply,
  isBranchPlacementActive,
  isLeafPlacementActive,
  isBracePlacementActive,
  isSupportBracePlacementActive,
  branchTipPosition,
  branchHoverPosition,
  leafTipPosition,
  leafHoverPosition,
  hoverTintStrength,
  selectedTintStrength,
  children,
  expansionSimulator,
  showExpansion,
  classificationFaceLabels,
  classificationGeometry,
  showClassification,
  view3dSettings,
}: {
  models?: LoadedModel[];
  activeModelId?: string | null;
  selectedModelIds?: string[];
  geom?: any;
  clipLower?: number | null;
  clipUpper?: number | null;
  meshColor?: string;
  meshVisible?: boolean;
  shaderType?: import('@/features/shaders/mesh').MeshShaderType;
  matcapVariant?: import('@/features/shaders/mesh').MatcapVariant;
  flatUseVertexColors?: boolean;
  toonSteps?: number;
  xrayOpacity?: number;
  disableRaycast?: boolean;
  hideCrossSectionCap?: boolean;
  onCameraChange?: () => void;
  onCameraEnd?: () => void;
  islandMarkers?: IslandMarker[];
  overlayBrushRadius?: number;
  overlayColor?: string;
  overlayOpacity?: number;
  overlaySelectedIslandId?: number | null;
  ambientIntensity?: number;
  directionalIntensity?: number;
  headlightIntensity?: number;
  materialRoughness?: number;
  scanResults?: ScanResults | null;
  layerHeightMm?: number;
  scanBBox?: THREE.Box3 | null;
  voxelEnabled?: boolean;
  voxelColorScheme?: 'unique' | 'lifecycle' | 'height';
  voxelSelectedIslandId?: number | null;
  voxelShowMerged?: boolean;
  voxelShowTerritory?: boolean;
  voxelOpacity?: number;
  transformMode?: TransformMode;
  transform?: ModelTransform;
  onTransformChange?: (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3) => void;
  onTransformChangeEnd?: (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3) => void;
  onTransformEnd?: (operation: 'move' | 'rotate' | 'scale') => void;
  crossSectionMode?: 'smooth' | 'rasterized';
  pxMm?: number;
  showIslandIdLabels?: boolean;
  mode?: SupportMode;
  onSupportClick?: (hit: THREE.Intersection) => void;
  onSupportHover?: (hit: THREE.Intersection | null) => void;
  onActiveModelChange?: (id: string | null, options?: { selectionMode?: 'single' | 'toggle' | 'add' }) => void;
  trunkPlacementPreview?: SupportData | null;
  branchPlacementPreview?: SupportData | null;
  leafPlacementPreview?: SupportData | null;
  bracePlacementPreview?: import('@/supports/SupportTypes/Brace/bracePlacementState').BracePreviewData | null;
  supportBracePlacementPreview?: SupportData | null;
  jointPlacementPreview?: { pos: { x: number; y: number; z: number }; diameter: number } | null;
  gpuPickingTest?: boolean;
  selectionHighlightMode?: SelectionHighlightMode;
  blockSupportPlacement?: boolean;
  supportsRef?: React.RefObject<THREE.Group | null>;
  ghostData?: any;
  duplicatePreviewModel?: LoadedModel | null;
  duplicatePreviewTransforms?: Array<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  }>;
  duplicateActivePreviewTransform?: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  } | null;
  arrangeArrayPreviewItems?: Array<{
    model: LoadedModel;
    transform: {
      position: THREE.Vector3;
      rotation: THREE.Euler;
      scale: THREE.Vector3;
    };
  }>;
  hideDuplicateSourceDuringApply?: boolean;
  isBranchPlacementActive?: boolean;
  isLeafPlacementActive?: boolean;
  isBracePlacementActive?: boolean;
  isSupportBracePlacementActive?: boolean;
  branchTipPosition?: { x: number; y: number; z: number } | null;
  branchHoverPosition?: { x: number; y: number; z: number } | null;
  leafTipPosition?: { x: number; y: number; z: number } | null;
  leafHoverPosition?: { x: number; y: number; z: number } | null;
  hoverTintStrength?: number;
  selectedTintStrength?: number;

  children?: React.ReactNode;

  // Expansion Visuals
  expansionSimulator?: BasinFillSimulator | BasinFillProxy | null;
  showExpansion?: boolean;

  // Classification Visuals
  classificationFaceLabels?: Int32Array;
  classificationGeometry?: THREE.BufferGeometry;
  showClassification?: boolean;
  view3dSettings?: View3DSettings;
}) {
  const DROP_ANIMATION_DURATION_MS = 760;
  const LARGE_MODEL_BOUNCE_THRESHOLD_POLYS = 900_000;
  const cameraProjectionMode = React.useSyncExternalStore(
    subscribeToCameraProjectionSettings,
    () => getSavedCameraProjectionSettings().mode,
    () => DEFAULT_CAMERA_PROJECTION_SETTINGS.mode,
  );

  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const smoothingProcessing = React.useSyncExternalStore(
    subscribeToMeshSmoothingProcessingState,
    getMeshSmoothingProcessingState,
    getMeshSmoothingProcessingState,
  );

  const smoothingLoading = React.useSyncExternalStore(
    subscribeToMeshSmoothingLoadingState,
    getMeshSmoothingLoadingState,
    getMeshSmoothingLoadingState,
  );


  const models = React.useMemo<LoadedModel[]>(() => {
    if (modelsProp.length > 0) return modelsProp;

    if (geom?.geometry) {
      const fallbackColor = meshColor ?? '#a3a3a3';
      const visible = meshVisible ?? true;

      return [
        {
          id: 'legacy-model',
          name: 'Legacy Model',
          fileUrl: '',
          geometry: geom,
          transform: {
            position: new THREE.Vector3(0, 0, 0),
            rotation: new THREE.Euler(0, 0, 0),
            scale: new THREE.Vector3(1, 1, 1),
          },
          visible,
          color: fallbackColor,
          polygonCount: geom.geometry.getAttribute('position')?.count
            ? geom.geometry.getAttribute('position').count / 3
            : 0,
        },
      ];
    }

    return [];
  }, [geom, meshColor, meshVisible, modelsProp]);

  const activeModelId = React.useMemo(() => {
    if (typeof activeModelIdProp === 'string') return activeModelIdProp;
    if (activeModelIdProp === null) return null;
    return models.length === 1 ? models[0].id : null;
  }, [activeModelIdProp, models]);

  const meshRefs = React.useRef<Record<string, THREE.Mesh | null>>({});
  const actualMeshRefs = React.useRef<Record<string, THREE.Mesh | null>>({});

  const prevBranchHoverDotVisibleRef = React.useRef<boolean | null>(null);
  const prevLeafHoverDotVisibleRef = React.useRef<boolean | null>(null);

  const [isModelSelected, setIsModelSelected] = React.useState(true); // Track for gizmo visibility

  // Any active model should be treated as selected for highlight effects
  // across all modes (prepare/support/analysis/export).
  const effectiveModelSelected = isModelSelected || !!activeModelId;
  const [isGizmoDragging, setIsGizmoDragging] = React.useState(false);
  const initialScaleRef = React.useRef<THREE.Vector3>(new THREE.Vector3(1, 1, 1));

  const cameraRef = React.useRef<THREE.Camera | null>(null);
  const suppressNextCanvasClickRef = React.useRef(false);
  const orbitInteractionActiveRef = React.useRef(false);
  const orbitInteractionMovedRef = React.useRef(false);
  const [spaceMouseNavigationActive, setSpaceMouseNavigationActive] = React.useState(false);
  const [mouseOrbitDragRunId, setMouseOrbitDragRunId] = React.useState(0);
  const activeBuildVolumeSettings = view3dSettings ?? DEFAULT_VIEW3D_SETTINGS;

  const buildVolumeCenterTarget = React.useMemo(() => {
    if (activeBuildVolumeSettings.enabled) {
      const centerX = activeBuildVolumeSettings.originMode === 'front_left' ? activeBuildVolumeSettings.widthMm * 0.5 : 0;
      const centerY = activeBuildVolumeSettings.originMode === 'front_left' ? activeBuildVolumeSettings.depthMm * 0.5 : 0;
      const centerZ = activeBuildVolumeSettings.maxZMm * 0.5;
      return new THREE.Vector3(centerX, centerY, centerZ);
    }
    return new THREE.Vector3(0, 0, 0);
  }, [
    activeBuildVolumeSettings.depthMm,
    activeBuildVolumeSettings.enabled,
    activeBuildVolumeSettings.maxZMm,
    activeBuildVolumeSettings.originMode,
    activeBuildVolumeSettings.widthMm,
  ]);

  const { defaultCamera, orbitTarget, setOrbitTargetFromPoint, introBoundsSnapshot, cameraIntroRunId, cameraHomeResetRunId } =
    useStlLoadCameraIntro(models, buildVolumeCenterTarget);
  const [cameraIntroCompletedRunId, setCameraIntroCompletedRunId] = React.useState(0);
  const [supportEntryIntroRunId, setSupportEntryIntroRunId] = React.useState(0);
  const [supportEntryCaptureRunId, setSupportEntryCaptureRunId] = React.useState(0);
  const [supportCameraCaptureRunId, setSupportCameraCaptureRunId] = React.useState(0);
  const [supportCameraRestoreRunId, setSupportCameraRestoreRunId] = React.useState(0);
  const [supportExitRestoreRunId, setSupportExitRestoreRunId] = React.useState(0);
  const hasSavedSupportCameraRef = React.useRef(false);
  const savedSupportCameraModelIdRef = React.useRef<string | null>(null);
  const prevModeRef = React.useRef<SupportMode | undefined>(mode);

  const lastHoveredModelPointRef = React.useRef<THREE.Vector3 | null>(null);
  const onModelHoverPointChange = React.useCallback((point: THREE.Vector3 | null) => {
    lastHoveredModelPointRef.current = point;
  }, []);

  const { smoothingBrushState, onSmoothingGeometryActivate } = useMeshSmoothingSceneBindings({
    mode,
    transformMode,
    containerRef,
  });

  const [isCameraBelowBuildPlate, setIsCameraBelowBuildPlate] = React.useState(false);
  const [buildPlateOpacity, setBuildPlateOpacity] = React.useState(1);
  const [hoverTintColor, setHoverTintColor] = React.useState<string>('#ec2a77');
  const [outOfBoundsStripeColor, setOutOfBoundsStripeColor] = React.useState<string>('#b6ff2e');

  const computeModelWorldBounds = React.useCallback((model: LoadedModel) => {
    const modelBox = model.geometry.bbox.clone();
    const center = model.geometry.center;
    modelBox.translate(new THREE.Vector3(-center.x, -center.y, -center.z));

    const t = model.transform;
    const matrix = new THREE.Matrix4().compose(
      t.position,
      new THREE.Quaternion().setFromEuler(t.rotation),
      t.scale,
    );
    modelBox.applyMatrix4(matrix);
    return modelBox;
  }, []);

  const buildVolumeBounds = React.useMemo(() => {
    if (!activeBuildVolumeSettings?.enabled) return null;

    const width = activeBuildVolumeSettings.widthMm;
    const depth = activeBuildVolumeSettings.depthMm;
    const minX = activeBuildVolumeSettings.originMode === 'front_left' ? 0 : -width * 0.5;
    const minY = activeBuildVolumeSettings.originMode === 'front_left' ? 0 : -depth * 0.5;

    return new THREE.Box3(
      new THREE.Vector3(minX, minY, 0),
      new THREE.Vector3(minX + width, minY + depth, activeBuildVolumeSettings.maxZMm),
    );
  }, [activeBuildVolumeSettings]);

  const outOfBoundsModels = React.useMemo(() => {
    if (!buildVolumeBounds) return [] as Array<{ id: string; name: string; bounds: THREE.Box3 }>;

    return models
      .filter((model) => model.visible)
      .map((model) => ({
        id: model.id,
        name: model.name,
        bounds: computeModelWorldBounds(model),
      }))
      .filter(({ bounds }) => (
        bounds.min.x < buildVolumeBounds.min.x
        || bounds.max.x > buildVolumeBounds.max.x
        || bounds.min.y < buildVolumeBounds.min.y
        || bounds.max.y > buildVolumeBounds.max.y
        || bounds.min.z < buildVolumeBounds.min.z
        || bounds.max.z > buildVolumeBounds.max.z
      ));
  }, [buildVolumeBounds, computeModelWorldBounds, models]);

  const outOfBoundsModelIds = React.useMemo(() => {
    return new Set(outOfBoundsModels.map((m) => m.id));
  }, [outOfBoundsModels]);

  const buildVolumeBoxGeometry = React.useMemo(() => {
    if (!activeBuildVolumeSettings?.enabled) return null;

    const geometry = new THREE.BoxGeometry(
      activeBuildVolumeSettings.widthMm,
      activeBuildVolumeSettings.depthMm,
      activeBuildVolumeSettings.maxZMm,
    );
    return geometry;
  }, [activeBuildVolumeSettings]);

  const buildVolumeEdgeGeometry = React.useMemo(() => {
    if (!buildVolumeBoxGeometry) return null;
    return new THREE.EdgesGeometry(buildVolumeBoxGeometry);
  }, [buildVolumeBoxGeometry]);

  React.useEffect(() => {
    return () => {
      buildVolumeEdgeGeometry?.dispose();
      buildVolumeBoxGeometry?.dispose();
    };
  }, [buildVolumeBoxGeometry, buildVolumeEdgeGeometry]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const resolveHoverTint = () => {
      const rootStyles = getComputedStyle(document.documentElement);
      const accent = rootStyles.getPropertyValue('--accent').trim();
      const accentSecondary = rootStyles.getPropertyValue('--accent-secondary').trim();

      if (!accent) {
        setHoverTintColor('#ec2a77');
      } else {
        try {
          const parsed = new THREE.Color();
          parsed.setStyle(accent);
          setHoverTintColor(parsed.getStyle());
        } catch {
          setHoverTintColor('#ec2a77');
        }
      }

      if (!accentSecondary) {
        setOutOfBoundsStripeColor('#b6ff2e');
      } else {
        try {
          const parsedSecondary = new THREE.Color();
          parsedSecondary.setStyle(accentSecondary);
          setOutOfBoundsStripeColor(parsedSecondary.getStyle());
        } catch {
          setOutOfBoundsStripeColor('#b6ff2e');
        }
      }
    };

    resolveHoverTint();

    const observer = new MutationObserver(resolveHoverTint);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });

    return () => observer.disconnect();
  }, []);

  const updateCameraBelowBuildPlate = React.useCallback(() => {
    const cameraZ = cameraRef.current?.position?.z;
    if (typeof cameraZ !== 'number') return;

    const camera = cameraRef.current;
    if (!camera) return;

    const viewDir = new THREE.Vector3();
    camera.getWorldDirection(viewDir);
    const viewAbsZ = Math.abs(viewDir.z);

    // Culling thresholds (earlier than before) with hysteresis to avoid flicker.
    const ENTER_BELOW_Z = 4.8;
    const EXIT_BELOW_Z = 7.0;

    // Wider/earlier height fade band.
    // Above FADE_VISIBLE_Z the plate is fully visible, below FADE_HIDDEN_Z it's fully hidden.
    const FADE_VISIBLE_Z = 12.0;
    const FADE_HIDDEN_Z = 3.8;

    // Side-on view fade: start fading once camera is nearly flat to the build plate plane.
    // Smaller |viewDir.z| means flatter side-view.
    const SIDE_VIEW_FADE_START_ABS_Z = 0.26;
    const SIDE_VIEW_FADE_END_ABS_Z = 0.08;
    const SIDE_VIEW_HEIGHT_MAX_Z = 20.0;

    // Side-view cull hysteresis (prevents toggling near threshold).
    const SIDE_ENTER_ABS_Z = 0.10;
    const SIDE_EXIT_ABS_Z = 0.20;
    const SIDE_ACTIVE_HEIGHT_MAX_Z = 22.0;

    // Height-based fade.
    const heightFadeT = THREE.MathUtils.clamp(
      (cameraZ - FADE_HIDDEN_Z) / Math.max(0.0001, FADE_VISIBLE_Z - FADE_HIDDEN_Z),
      0,
      1,
    );
    const smoothHeightFade = heightFadeT * heightFadeT * (3 - 2 * heightFadeT); // smoothstep

    // Side-view fade (gated by being near the plate in height).
    const sideViewRaw = THREE.MathUtils.clamp(
      (SIDE_VIEW_FADE_START_ABS_Z - viewAbsZ) / Math.max(0.0001, SIDE_VIEW_FADE_START_ABS_Z - SIDE_VIEW_FADE_END_ABS_Z),
      0,
      1,
    );
    const sideViewFade = sideViewRaw * sideViewRaw * (3 - 2 * sideViewRaw);
    const sideHeightGate = THREE.MathUtils.clamp(
      (SIDE_VIEW_HEIGHT_MAX_Z - cameraZ) / SIDE_VIEW_HEIGHT_MAX_Z,
      0,
      1,
    );

    // Combine fades: whichever hides more wins.
    const combinedFade = Math.min(smoothHeightFade, 1 - (sideViewFade * sideHeightGate));

    setBuildPlateOpacity((prev) => (Math.abs(prev - combinedFade) < 1e-4 ? prev : combinedFade));

    setIsCameraBelowBuildPlate((prev) => {
      const heightTriggered = prev ? cameraZ < EXIT_BELOW_Z : cameraZ < ENTER_BELOW_Z;
      const sideTriggered = cameraZ < SIDE_ACTIVE_HEIGHT_MAX_Z
        ? (prev ? viewAbsZ < SIDE_EXIT_ABS_Z : viewAbsZ < SIDE_ENTER_ABS_Z)
        : false;
      const next = heightTriggered || sideTriggered;
      return prev === next ? prev : next;
    });
  }, []);

  React.useEffect(() => {
    const visible = !!branchHoverPosition && !branchTipPosition && !branchPlacementPreview;
    if (prevBranchHoverDotVisibleRef.current === null) {
      prevBranchHoverDotVisibleRef.current = visible;
      return;
    }
    if (prevBranchHoverDotVisibleRef.current !== visible) {
      prevBranchHoverDotVisibleRef.current = visible;
      console.log('[BranchHoverDot]', visible ? 'show' : 'hide', {
        pos: branchHoverPosition,
        isBranchPlacementActive,
        time: performance.now(),
      });
    }
  }, [branchHoverPosition, branchTipPosition, branchPlacementPreview, isBranchPlacementActive]);

  React.useEffect(() => {
    const visible = !!leafHoverPosition && !leafTipPosition && !leafPlacementPreview;
    if (prevLeafHoverDotVisibleRef.current === null) {
      prevLeafHoverDotVisibleRef.current = visible;
      return;
    }
    if (prevLeafHoverDotVisibleRef.current !== visible) {
      prevLeafHoverDotVisibleRef.current = visible;
      console.log('[LeafHoverDot]', visible ? 'show' : 'hide', {
        pos: leafHoverPosition,
        isLeafPlacementActive,
        time: performance.now(),
      });
    }
  }, [leafHoverPosition, leafTipPosition, leafPlacementPreview, isLeafPlacementActive]);

  // Computed refs for active model
  const activeGroupRef = React.useMemo(
    () => ({
      get current() {
        return activeModelId ? meshRefs.current[activeModelId] : null;
      },
    }),
    [activeModelId],
  );

  const activeActualMeshRef = React.useMemo(
    () => ({
      get current() {
        return activeModelId ? actualMeshRefs.current[activeModelId] : null;
      },
    }),
    [activeModelId],
  );

  const activeModel = React.useMemo(() => {
    if (!activeModelId) return null;
    return models.find((m) => m.id === activeModelId) ?? null;
  }, [models, activeModelId]);

  const selectedModelIdSet = React.useMemo(() => {
    return new Set(selectedModelIds ?? []);
  }, [selectedModelIds]);

  const duplicatePreviewMeshOffset = React.useMemo(() => {
    if (!duplicatePreviewModel) return null;
    return new THREE.Vector3(
      -duplicatePreviewModel.geometry.center.x,
      -duplicatePreviewModel.geometry.center.y,
      -duplicatePreviewModel.geometry.center.z,
    );
  }, [duplicatePreviewModel]);

  const activeModelTransform = React.useMemo(() => {
    if (!activeModel) return null;
    if (transform && activeModelId === activeModel.id) return transform;
    return activeModel.transform;
  }, [activeModel, transform, activeModelId]);

  const introControllerBounds = React.useMemo(() => {
    if (mode === 'support' && activeModel) {
      return computeModelWorldBounds(activeModel);
    }
    return introBoundsSnapshot;
  }, [activeModel, computeModelWorldBounds, introBoundsSnapshot, mode]);

  const introControllerRunId = cameraIntroRunId + supportEntryIntroRunId;

  React.useEffect(() => {
    const prevMode = prevModeRef.current;
    const enteringSupport = mode === 'support' && prevMode !== 'support';
    const leavingSupport = mode !== 'support' && prevMode === 'support';

    if (enteringSupport && models.length > 0) {
      setSupportEntryCaptureRunId((id) => id + 1);
      const canRestoreSavedSupportView =
        hasSavedSupportCameraRef.current
        && savedSupportCameraModelIdRef.current != null
        && savedSupportCameraModelIdRef.current === activeModelId;

      if (canRestoreSavedSupportView) {
        setSupportCameraRestoreRunId((id) => id + 1);
      } else {
        setSupportEntryIntroRunId((id) => id + 1);
      }
    }

    if (leavingSupport) {
      setSupportCameraCaptureRunId((id) => id + 1);
      hasSavedSupportCameraRef.current = true;
      savedSupportCameraModelIdRef.current = activeModelId ?? null;
      setSupportExitRestoreRunId((id) => id + 1);
    }

    prevModeRef.current = mode;
  }, [activeModelId, mode, models.length]);

  const selectedSpaceMousePivotPoint = React.useMemo(() => {
    if (!activeModel?.visible) return null;

    const bounds = computeModelWorldBounds(activeModel);
    if (bounds.isEmpty()) return null;

    return bounds.getCenter(new THREE.Vector3());
  }, [activeModel, computeModelWorldBounds]);

  React.useEffect(() => {
    if (mode !== 'support') return;
    if (spaceMouseNavigationActive) return;

    if (selectedSpaceMousePivotPoint) {
      setOrbitTargetFromPoint(selectedSpaceMousePivotPoint);
      return;
    }

    // Only fall back to build-volume center when the scene is truly empty.
    // When models exist, auto-select will fire shortly and provide the
    // proper pivot; animating to the build-volume center first causes
    // a jarring double-animation on first open.
    if (activeModelId == null && models.length === 0) {
      setOrbitTargetFromPoint(buildVolumeCenterTarget.clone());
    }
  }, [activeModelId, buildVolumeCenterTarget, mode, models.length, selectedSpaceMousePivotPoint, setOrbitTargetFromPoint, spaceMouseNavigationActive]);

  const spaceMousePivotCandidates = React.useMemo(() => {
    const centers: THREE.Vector3[] = [];

    for (const model of models) {
      if (!model.visible) continue;
      const bounds = computeModelWorldBounds(model);
      if (bounds.isEmpty()) continue;
      centers.push(bounds.getCenter(new THREE.Vector3()));
    }

    return centers;
  }, [computeModelWorldBounds, models]);

  const [entryDropOffsets, setEntryDropOffsets] = React.useState<Record<string, number>>({});
  const [modeEntryFramingRunId, setModeEntryFramingRunId] = React.useState(0);
  const [modeExitRestoreRunId, setModeExitRestoreRunId] = React.useState(0);
  const knownModelIdsRef = React.useRef<Set<string>>(new Set());
  const prevTransformModeRef = React.useRef<TransformMode | undefined>(transformMode);
  const entryAnimRef = React.useRef<Record<string, { startMs: number; fromZ: number; skipBounce: boolean }>>({});
  const pendingEntryAnimRef = React.useRef<Record<string, { fromZ: number; runId: number; skipBounce: boolean }>>({});
  const isIntroAnimating = cameraIntroRunId > cameraIntroCompletedRunId;
  const isDropAnimating = Object.keys(entryDropOffsets).length > 0;
  const dynamicDpr = (isIntroAnimating || isDropAnimating) ? ([1, 1.5] as [number, number]) : ([1, 10] as [number, number]);

  React.useEffect(() => {
    const prevMode = prevTransformModeRef.current;
    const prevIsPresentationMode = prevMode === 'arrange' || prevMode === 'duplicate';
    const nextIsPresentationMode = transformMode === 'arrange' || transformMode === 'duplicate';
    const enteringArrangeOrDuplicate = mode === 'prepare' && nextIsPresentationMode && !prevIsPresentationMode;
    const leavingArrangeOrDuplicate = mode === 'prepare' && prevIsPresentationMode && !nextIsPresentationMode;

    if (enteringArrangeOrDuplicate) {
      setModeEntryFramingRunId((id) => id + 1);
    }

    if (leavingArrangeOrDuplicate) {
      setModeExitRestoreRunId((id) => id + 1);
    }

    prevTransformModeRef.current = transformMode;
  }, [mode, transformMode]);

  React.useEffect(() => {
    const currentIds = new Set(models.map((model) => model.id));
    const initialDropOffsets: Record<string, number> = {};

    // Start animation for newly added mesh files
    for (const model of models) {
      const isKnown = knownModelIdsRef.current.has(model.id);
      if (isKnown) continue;

      knownModelIdsRef.current.add(model.id);

      const isMeshFile = model.fileUrl.startsWith('blob:') || /\.stl$/i.test(model.name);
      if (!isMeshFile) continue;

      const dropFrom = Math.max(16, Math.min(64, model.geometry.size.z * 0.45));

      const skipBounce = model.polygonCount >= LARGE_MODEL_BOUNCE_THRESHOLD_POLYS;

      // Run drop immediately so it happens concurrently with camera intro zoom.
      entryAnimRef.current[model.id] = {
        startMs: performance.now(),
        fromZ: dropFrom,
        skipBounce,
      };
      initialDropOffsets[model.id] = dropFrom;
    }

    // Cleanup removed models
    const nextKnown = new Set<string>();
    for (const id of knownModelIdsRef.current) {
      if (currentIds.has(id)) {
        nextKnown.add(id);
      } else {
        delete entryAnimRef.current[id];
        delete pendingEntryAnimRef.current[id];
      }
    }
    knownModelIdsRef.current = nextKnown;

    setEntryDropOffsets((previous) => {
      const next: Record<string, number> = {
        ...initialDropOffsets,
      };
      Object.entries(previous).forEach(([id, offset]) => {
        if (currentIds.has(id) && offset > 0.0001 && next[id] == null) {
          next[id] = offset;
        }
      });
      return next;
    });
  }, [cameraIntroCompletedRunId, cameraIntroRunId, models]);

  React.useEffect(() => {
    const pendingEntries = Object.entries(pendingEntryAnimRef.current).filter(([, pending]) => pending.runId <= cameraIntroCompletedRunId);
    if (pendingEntries.length === 0) return;

    const now = performance.now();
    const activatedOffsets: Record<string, number> = {};

    for (const [id, pending] of pendingEntries) {
      entryAnimRef.current[id] = {
        startMs: now,
        fromZ: pending.fromZ,
        skipBounce: pending.skipBounce,
      };
      activatedOffsets[id] = pending.fromZ;
      delete pendingEntryAnimRef.current[id];
    }

    setEntryDropOffsets((previous) => ({
      ...previous,
      ...activatedOffsets,
    }));
  }, [cameraIntroCompletedRunId]);

  React.useEffect(() => {
    let frame = 0;

    const tick = () => {
      const entries = Object.entries(entryAnimRef.current);
      if (entries.length === 0) return;

      const now = performance.now();
      const nextOffsets: Record<string, number> = {};

      for (const [id, animation] of entries) {
        const t = Math.min(1, (now - animation.startMs) / DROP_ANIMATION_DURATION_MS);

        // Drop -> impact -> optional rebound -> settle
        const impactT = animation.skipBounce ? 1 : 0.72;
        let zOffset = 0;

        if (t < impactT) {
          const p = t / impactT;
          // Accelerating descent for more weight
          zOffset = animation.fromZ * (1 - p * p);
        } else if (!animation.skipBounce) {
          const q = (t - impactT) / (1 - impactT);
          // One clear rebound arc after impact (rubber-ball feel)
          const reboundHeight = Math.max(4.5, animation.fromZ * 0.2);
          zOffset = reboundHeight * 4 * q * (1 - q);
        }

        if (t >= 1 || zOffset <= 0.0001) {
          delete entryAnimRef.current[id];
        } else {
          nextOffsets[id] = zOffset;
        }
      }

      setEntryDropOffsets(nextOffsets);

      if (Object.keys(entryAnimRef.current).length > 0) {
        frame = requestAnimationFrame(tick);
      }
    };

    if (Object.keys(entryAnimRef.current).length > 0) {
      frame = requestAnimationFrame(tick);
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
    };
  }, [cameraIntroCompletedRunId, models.length]);

  // Interaction State
  const { isDraggingHandle } = useCurveInteractionState();
  const interactionWarning = useInteractionWarning();

  // Listen for selection events to show/hide gizmo
  React.useEffect(() => {
    const handleModelClicked = () => setIsModelSelected(true);
    const handleModelDeselected = () => setIsModelSelected(false);

    window.addEventListener('model-clicked', handleModelClicked);
    window.addEventListener('model-deselected', handleModelDeselected);

    return () => {
      window.removeEventListener('model-clicked', handleModelClicked);
      window.removeEventListener('model-deselected', handleModelDeselected);
    };
  }, []);

  // Handle canvas background clicks (deselect support)
  const handleCanvasClick = React.useCallback(
    (e: React.MouseEvent) => {
      console.log('[Canvas] handleCanvasClick fired, mode:', mode);

      // If model was just clicked, ignore this background click
      if (window.__modelClickedThisFrame) {
        console.log('[Canvas] Ignoring click (model clicked this frame)');
        return;
      }

      // If a gizmo drag just ended, ignore this click
      if (suppressNextCanvasClickRef.current || (window as any).__gizmoDragEndedThisFrame) {
        suppressNextCanvasClickRef.current = false;
        (window as any).__gizmoDragEndedThisFrame = false;
        e.stopPropagation();
        // @ts-ignore
        if (e.nativeEvent?.stopImmediatePropagation) e.nativeEvent.stopImmediatePropagation();
        return;
      }

      if (mode === 'prepare') {
        // Deselect model if background is clicked
        if (onActiveModelChange) {
          console.log('[Canvas] Background clicked, deselecting model');
          onActiveModelChange(null);
        }
        return;
      }

      if (mode !== 'support') return;

      // Background was clicked, deselect via V2 logic
      console.log('[Canvas] Background clicked, deselecting');
      clearSelection();
    },
    [mode, onActiveModelChange],
  );

  React.useEffect(() => {
    updateCameraBelowBuildPlate();
  }, [updateCameraBelowBuildPlate]);

  const hidePlateContactPrimitives = isCameraBelowBuildPlate;
  const isSpotlightHighlightActive =
    effectiveModelSelected
    && selectionHighlightMode === 'spotlight';

  const handleOrbitChange = React.useCallback(() => {
    if (orbitInteractionActiveRef.current) {
      orbitInteractionMovedRef.current = true;
    }
    updateCameraBelowBuildPlate();
    onCameraChange?.();
    window.dispatchEvent(new Event('picking-orbit-change'));
  }, [onCameraChange, updateCameraBelowBuildPlate]);

  const handleOrbitStart = React.useCallback(() => {
    orbitInteractionActiveRef.current = true;
    orbitInteractionMovedRef.current = false;
    setMouseOrbitDragRunId((id) => id + 1);
  }, []);

  const handleOrbitEnd = React.useCallback(() => {
    if (orbitInteractionActiveRef.current && orbitInteractionMovedRef.current) {
      suppressNextCanvasClickRef.current = true;
    }
    orbitInteractionActiveRef.current = false;
    orbitInteractionMovedRef.current = false;

    updateCameraBelowBuildPlate();
    onCameraEnd?.();
    window.dispatchEvent(new Event('picking-orbit-end'));
  }, [onCameraEnd, updateCameraBelowBuildPlate]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }} onClick={handleCanvasClick} ref={containerRef}>
      <Canvas
        style={{ width: '100%', height: '100%', backgroundColor: '#181a22', display: 'block' }}
        camera={defaultCamera}
        shadows
        dpr={dynamicDpr}
        gl={{ stencil: true, logarithmicDepthBuffer: true }}
      >
        <LoggingHelper mode={mode} />
        <Lights
          ambientIntensity={ambientIntensity ?? 1.2}
          directionalIntensity={directionalIntensity ?? 0.3}
          headlightIntensity={headlightIntensity ?? 1.0}
        />
        <Helpers
          gridWidthMm={activeBuildVolumeSettings?.enabled ? activeBuildVolumeSettings.widthMm : undefined}
          gridDepthMm={activeBuildVolumeSettings?.enabled ? activeBuildVolumeSettings.depthMm : undefined}
          originMinX={buildVolumeBounds?.min.x}
          originMinY={buildVolumeBounds?.min.y}
          buildPlateOpacity={buildPlateOpacity}
        />
        <EnableLocalClipping />
        <CameraProvider cameraRef={cameraRef} />
        <CameraProjectionController mode={cameraProjectionMode} />
        <CameraClipPlaneStabilizer />
        {/* GPU Picking Provider - wraps all pickable content when enabled */}
        <PickingProviderWrapper enabled={gpuPickingTest}>
          <PickingStateSyncer />

          {/* Selection Provider - manages model selection state */}
          <SelectionProvider initialSelection={activeModelId || 'default-model'}>
            <SelectionSync activeModelId={activeModelId ?? null} />
            {/* Selection Manager - handles click-to-select/deselect logic */}
            <SelectionManager enabled={mode === 'prepare'} mode={mode} />

            <React.Suspense fallback={null}>
              {models.map((model) => {
                const isActive = model.id === activeModelId;
                const isSelectedModel = selectedModelIdSet.has(model.id);
                const supportNonSelectedOpacity = mode === 'support' && !isSelectedModel ? 0.5 : undefined;
                const shouldHideDuplicateSourceModel = Boolean(
                  hideDuplicateSourceDuringApply
                  && duplicatePreviewModel
                  && model.id === duplicatePreviewModel.id,
                );
                // Use props.transform if active (for smooth drag), else model.transform
                const transformToUse = isActive
                  ? (duplicateActivePreviewTransform ?? (transform ?? model.transform))
                  : model.transform;
                const dropOffsetZ = entryDropOffsets[model.id] ?? 0;
                const animatedTransform = dropOffsetZ > 0
                  ? {
                    position: transformToUse.position.clone().add(new THREE.Vector3(0, 0, dropOffsetZ)),
                    rotation: transformToUse.rotation,
                    scale: transformToUse.scale,
                  }
                  : transformToUse;
                const showOutOfBoundsOverlay = !!activeBuildVolumeSettings?.enabled;
                // Use per-model visibility
                if (!model.visible) return null;
                if (shouldHideDuplicateSourceModel) return null;

                return (
                  <React.Fragment key={model.id}>
                    <StlMesh
                      modelId={model.id}
                      geometry={model.geometry.geometry}
                      clipLower={clipLower}
                      clipUpper={clipUpper}
                      meshColor={model.color || meshColor} // Use model color
                      meshRef={(el: THREE.Mesh | null) => {
                        meshRefs.current[model.id] = el;
                      }}
                      actualMeshRef={(el: THREE.Mesh | null) => {
                        actualMeshRefs.current[model.id] = el;
                      }}
                      materialRoughness={materialRoughness}
                      shaderType={shaderType ?? 'soft_clay'}
                      matcapVariant={matcapVariant}
                      flatUseVertexColors={flatUseVertexColors}
                      toonSteps={toonSteps}
                      xrayOpacity={xrayOpacity}
                      transform={animatedTransform}
                      mode={mode}
                      transformMode={transformMode}
                      isActiveModel={isActive}
                      onSmoothingGeometryActivate={onSmoothingGeometryActivate}
                      onSupportClick={onSupportClick}
                      onSupportHover={onSupportHover}
                      onActiveModelChange={onActiveModelChange}
                      disableRaycast={disableRaycast}
                      blockSupportPlacement={isGizmoDragging || blockSupportPlacement}
                      suppressNextClickRef={suppressNextCanvasClickRef}
                      isSelected={
                        isSelectedModel &&
                        (
                          effectiveModelSelected && (selectionHighlightMode === 'tint' || selectionHighlightMode === 'spotlight')
                        )
                      }
                      isBranchPlacementActive={isBranchPlacementActive}
                      isLeafPlacementActive={isLeafPlacementActive}
                      isBracePlacementActive={isBracePlacementActive}
                      onModelHoverPointChange={onModelHoverPointChange}
                      hoverTintColor={hoverTintColor}
                      hoverTintStrength={hoverTintStrength}
                      selectedTintStrength={selectedTintStrength}
                      supportNonSelectedOpacity={supportNonSelectedOpacity}
                      showOutOfBoundsOverlay={showOutOfBoundsOverlay}
                      outOfBoundsMin={buildVolumeBounds?.min ?? null}
                      outOfBoundsMax={buildVolumeBounds?.max ?? null}
                      outOfBoundsStripeColor={outOfBoundsStripeColor}
                    />

                    {/* Cross-section cap (fill) at the cut plane - Render per model */}
                    {clipUpper != null && !hideCrossSectionCap && (
                      <CrossSectionCap
                        geometry={model.geometry.geometry}
                        y={clipUpper}
                        color="#FFFFFF"
                        // We need the matrix for THIS model
                        transformMatrix={(() => {
                          // Duplicate logic from previous SceneCanvas to build matrix
                          const t = animatedTransform;
                          if (!t) return undefined;

                          const center = model.geometry.center;

                          const matrix = new THREE.Matrix4();
                          matrix.compose(t.position, new THREE.Quaternion().setFromEuler(t.rotation), t.scale);
                          const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
                          matrix.multiply(offsetMatrix);
                          return matrix;
                        })()}
                        mode={crossSectionMode}
                        pxMm={pxMm}
                        visible={!hideCrossSectionCap && clipUpper != null}
                      />
                    )}
                  </React.Fragment>
                );
              })}

              {duplicatePreviewModel
                && duplicatePreviewMeshOffset
                && (duplicatePreviewTransforms?.length ?? 0) > 0
                ? duplicatePreviewTransforms!.map((previewTransform, index) => (
                    <group
                      key={`duplicate-preview-${index}`}
                      position={previewTransform.position}
                      rotation={previewTransform.rotation}
                      scale={previewTransform.scale}
                      raycast={() => null}
                    >
                      <mesh
                        geometry={duplicatePreviewModel.geometry.geometry}
                        position={duplicatePreviewMeshOffset}
                        raycast={() => null}
                        renderOrder={2}
                      >
                        <meshStandardMaterial
                          color={duplicatePreviewModel.color ?? '#a3a3a3'}
                          transparent
                          opacity={0.22}
                          roughness={0.5}
                          metalness={0.02}
                          depthWrite={false}
                        />
                      </mesh>
                    </group>
                  ))
                : null}

              {hideDuplicateSourceDuringApply
                && duplicatePreviewModel
                && duplicatePreviewMeshOffset
                && duplicateActivePreviewTransform
                ? (
                    <group
                      key="duplicate-source-preview"
                      position={duplicateActivePreviewTransform.position}
                      rotation={duplicateActivePreviewTransform.rotation}
                      scale={duplicateActivePreviewTransform.scale}
                      raycast={() => null}
                    >
                      <mesh
                        geometry={duplicatePreviewModel.geometry.geometry}
                        position={duplicatePreviewMeshOffset}
                        raycast={() => null}
                        renderOrder={2}
                      >
                        <meshStandardMaterial
                          color={duplicatePreviewModel.color ?? '#a3a3a3'}
                          transparent
                          opacity={0.22}
                          roughness={0.5}
                          metalness={0.02}
                          depthWrite={false}
                        />
                      </mesh>
                    </group>
                  )
                : null}

              {arrangeArrayPreviewItems && arrangeArrayPreviewItems.length > 0
                ? arrangeArrayPreviewItems.map((item) => {
                    const offset = new THREE.Vector3(
                      -item.model.geometry.center.x,
                      -item.model.geometry.center.y,
                      -item.model.geometry.center.z,
                    );

                    return (
                      <group
                        key={`arrange-array-preview-${item.model.id}`}
                        position={item.transform.position}
                        rotation={item.transform.rotation}
                        scale={item.transform.scale}
                        raycast={() => null}
                      >
                        <mesh
                          geometry={item.model.geometry.geometry}
                          position={offset}
                          raycast={() => null}
                          renderOrder={2}
                        >
                          <meshStandardMaterial
                            color={item.model.color ?? '#a3a3a3'}
                            transparent
                            opacity={0.22}
                            roughness={0.5}
                            metalness={0.02}
                            depthWrite={false}
                          />
                        </mesh>
                      </group>
                    );
                  })
                : null}

              {activeBuildVolumeSettings?.enabled && buildVolumeBoxGeometry && buildVolumeEdgeGeometry && (
                <group
                  position={[
                    (buildVolumeBounds!.min.x + buildVolumeBounds!.max.x) * 0.5,
                    (buildVolumeBounds!.min.y + buildVolumeBounds!.max.y) * 0.5,
                    activeBuildVolumeSettings.maxZMm * 0.5,
                  ]}
                  raycast={() => null}
                >
                  <mesh geometry={buildVolumeBoxGeometry} raycast={() => null} renderOrder={-1}>
                    <meshBasicMaterial
                      color={outOfBoundsModels.length > 0 ? '#ff5b6f' : '#78b7ff'}
                      transparent
                      opacity={0.04}
                      depthWrite={false}
                      side={THREE.BackSide}
                    />
                  </mesh>
                  <lineSegments geometry={buildVolumeEdgeGeometry} raycast={() => null}>
                    <lineBasicMaterial
                      color={outOfBoundsModels.length > 0 ? '#ff5b6f' : '#8abfff'}
                      transparent
                      opacity={0.36}
                      depthWrite={false}
                    />
                  </lineSegments>
                </group>
              )}

              {/* Raft system (Crenelated) - uses supports roots + active model footprint */}
              {!hidePlateContactPrimitives && (
                <>
                  <RaftRenderer />
                  <LineRaftRenderer />
                  <FootprintBorderRenderer modelGeometry={activeModel ? activeModel.geometry : null} modelTransform={activeModelTransform} />
                </>
              )}

              {/* Gizmo attached to active model */}
              {mode === 'prepare' && transformMode === 'transform' && activeModelId && isModelSelected && (
                <UnifiedGizmo
                  meshRef={activeGroupRef as React.RefObject<THREE.Mesh>}
                  position={[transform?.position.x ?? 0, transform?.position.y ?? 0, transform?.position.z ?? 0]}
                  rotation={[0, 0, 0]}
                  enableMove
                  enableRotate
                  enableScale
                  enableLighting
                  onDragStateChange={setIsGizmoDragging}
                  onMove={(delta) => {
                    if (activeGroupRef.current) {
                      activeGroupRef.current.position.add(delta);
                    }
                  }}
                  onMoveEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (activeGroupRef.current && onTransformChange) {
                      onTransformChange(
                        activeGroupRef.current.position.clone(),
                        activeGroupRef.current.rotation.clone(),
                        activeGroupRef.current.scale.clone(),
                      );
                    }
                  }}
                  onRotate={(axis, angle) => {
                    if (activeGroupRef.current) {
                      const worldAxis = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
                      const quaternion = new THREE.Quaternion().setFromAxisAngle(worldAxis, -angle);
                      activeGroupRef.current.quaternion.premultiply(quaternion);
                    }
                  }}
                  onRotateEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (activeGroupRef.current && onTransformChange) {
                      onTransformChange(
                        activeGroupRef.current.position.clone(),
                        activeGroupRef.current.rotation.clone(),
                        activeGroupRef.current.scale.clone(),
                      );
                    }
                    onTransformEnd?.('rotate');
                  }}
                  onScaleStart={() => {
                    if (activeGroupRef.current) {
                      initialScaleRef.current.copy(activeGroupRef.current.scale);
                    }
                  }}
                  onScale={(axis, factor) => {
                    if (activeGroupRef.current) {
                      if (axis === 'uniform') {
                        activeGroupRef.current.scale.copy(initialScaleRef.current).multiplyScalar(factor);
                      } else {
                        activeGroupRef.current.scale.copy(initialScaleRef.current);
                        if (axis === 'x') activeGroupRef.current.scale.x *= factor;
                        if (axis === 'y') activeGroupRef.current.scale.y *= factor;
                        if (axis === 'z') activeGroupRef.current.scale.z *= factor;
                      }
                    }
                  }}
                  onScaleEnd={() => {
                    window.__gizmoDragEndedThisFrame = true;
                    if (activeGroupRef.current && onTransformChange) {
                      onTransformChange(
                        activeGroupRef.current.position.clone(),
                        activeGroupRef.current.rotation.clone(),
                        activeGroupRef.current.scale.clone(),
                      );
                    }
                  }}
                />
              )}

              {/* Render supports (New V2 System) */}
              {/* Note: SupportRenderer renders supports from store. TODO: Filter by active model or show all? */}
              <SupportRenderer
                mode={mode}
                ref={supportsRef}
                hidePlateContactPrimitives={hidePlateContactPrimitives}
                clipLower={clipLower}
                clipUpper={clipUpper}
              />

              <IslandOverlay
                markers={islandMarkers ?? []}
                meshRef={activeActualMeshRef.current}
                brushRadiusMm={overlayBrushRadius ?? 2}
                color={overlayColor ?? '#FF0000'}
                opacity={overlayOpacity ?? 0.5}
                transform={transform}
                selectedIslandId={overlaySelectedIslandId}
                clipLower={clipLower}
                clipUpper={clipUpper}
              />

              <IslandVoxelVisualization
                scanResults={scanResults ?? null}
                layerHeightMm={layerHeightMm ?? 0.05}
                enabled={voxelEnabled ?? false}
                opacity={voxelOpacity}
                colorScheme={voxelColorScheme}
                selectedIslandId={voxelSelectedIslandId}
                showMerged={voxelShowMerged}
                showTerritory={voxelShowTerritory}
                transform={transform}
                zOffset={scanBBox?.min.z ?? 0}
                clipLower={clipLower}
                clipUpper={clipUpper}
              />

              <IslandExpansionVisualization simulator={expansionSimulator ?? null} transform={transform} enabled={showExpansion ?? false} />

              <MeshClassificationRenderer
                geometry={classificationGeometry}
                faceLabels={classificationFaceLabels}
                transform={transform}
                visible={showClassification ?? false}
              />

              {scanResults && (
                <IslandIdLabels
                  islands={scanResults.islands}
                  scanResults={scanResults}
                  layerHeightMm={layerHeightMm ?? 0.05}
                  enabled={showIslandIdLabels ?? false}
                  bboxMinZ={scanBBox?.min.z ?? 0}
                />
              )}

              {/* Render V2 Trunk Placement Preview (hide when in branch/leaf mode) */}
              {trunkPlacementPreview &&
                !blockSupportPlacement &&
                !isDraggingHandle &&
                !isBranchPlacementActive &&
                !isLeafPlacementActive &&
                !isSupportBracePlacementActive &&
                !branchPlacementPreview && (
                  <SupportBuilder data={trunkPlacementPreview} isPreview hidePlateContactPrimitives={hidePlateContactPrimitives} />
                )}

              {/* Render Branch Hover Preview Dot - shows when Alt is held before first click */}
              {/* Uses tip contact diameter to match actual tip size */}
              {branchHoverPosition && !branchTipPosition && !branchPlacementPreview && (
                <mesh position={[branchHoverPosition.x, branchHoverPosition.y, branchHoverPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2, 16, 16]} />
                  <meshStandardMaterial
                    color="#00ff00"
                    transparent
                    opacity={0.5}
                    emissive="#00ff00"
                    emissiveIntensity={0.3}
                  />
                </mesh>
              )}

              {/* Render Branch Tip Marker - only show when NO preview is visible */}
              {/* Once preview shows, the contact cone at the tip replaces this marker */}
              {isBranchPlacementActive && branchTipPosition && !branchPlacementPreview && (
                <mesh position={[branchTipPosition.x, branchTipPosition.y, branchTipPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2, 16, 16]} />
                  <meshStandardMaterial color="#00ff00" transparent opacity={0.7} />
                </mesh>
              )}

              {/* Render Branch Placement Preview - ALWAYS show when data exists */}
              {/* Don't check blockSupportPlacement - branch placement needs to work while hovering supports */}
              {branchPlacementPreview && isBranchPlacementActive && !isDraggingHandle && (
                <SupportBuilder data={branchPlacementPreview} isPreview hidePlateContactPrimitives={hidePlateContactPrimitives} />
              )}

              {/* Render Leaf Hover Preview Dot - shows when Alt+Shift is held before first click */}
              {/* Uses tip contact diameter to match actual tip size */}
              {leafHoverPosition && !leafTipPosition && !leafPlacementPreview && (
                <mesh position={[leafHoverPosition.x, leafHoverPosition.y, leafHoverPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2, 16, 16]} />
                  <meshStandardMaterial
                    color="#00ff00"
                    transparent
                    opacity={0.5}
                    emissive="#00ff00"
                    emissiveIntensity={0.3}
                  />
                </mesh>
              )}

              {/* Render Leaf Tip Marker - only show when NO preview is visible */}
              {/* Once preview shows, the contact cone at the tip replaces this marker */}
              {isLeafPlacementActive && leafTipPosition && !leafPlacementPreview && (
                <mesh position={[leafTipPosition.x, leafTipPosition.y, leafTipPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2, 16, 16]} />
                  <meshStandardMaterial color="#00ff00" transparent opacity={0.7} />
                </mesh>
              )}

              {/* Render Leaf Placement Preview - ALWAYS show when data exists */}
              {/* Don't check blockSupportPlacement - leaf placement needs to work while hovering supports */}
              {leafPlacementPreview && !isDraggingHandle && (
                <SupportBuilder data={leafPlacementPreview} isPreview hidePlateContactPrimitives={hidePlateContactPrimitives} />
              )}

              {/* Render Brace Placement Preview */}
              {bracePlacementPreview && !isDraggingHandle && <BracePreviewRenderer preview={bracePlacementPreview} />}

              {/* Render Support Brace Placement Preview */}
              {supportBracePlacementPreview && !isDraggingHandle && (
                <SupportBuilder
                  data={supportBracePlacementPreview}
                  isPreview
                  hidePlateContactPrimitives={hidePlateContactPrimitives}
                />
              )}

              {/* Render V2 Joint Placement Preview */}
              {jointPlacementPreview && (
                <JointPlacementPreview position={jointPlacementPreview.pos} diameter={jointPlacementPreview.diameter} />
              )}

              {/* Branch Placement Controller - handles snapping logic */}
              {mode === 'support' && <BranchPlacementController />}

              {/* Leaf Placement Controller - handles snapping logic */}
              {mode === 'support' && <LeafPlacementController />}

              {/* Brace Placement Controller - handles snapping logic */}
              {mode === 'support' && <BracePlacementController />}

              {/* Support Brace Placement Controller - handles Ctrl-hover preview and click placement */}
              {mode === 'support' && <SupportBracePlacementController />}

              {/* LYS Ghost Viewer (Temporary) */}
              <GhostOverlay data={ghostData} visible={!!ghostData} />
            </React.Suspense>
          </SelectionProvider>
        </PickingProviderWrapper>
        {/* Selection outline - renders when model is selected */}
        <SelectionOutlineRenderer
          meshRef={activeActualMeshRef as React.RefObject<THREE.Mesh>}
          enabled={effectiveModelSelected && selectionHighlightMode === 'fresnel'}
          color="#82ccff"
          intensity={0.38}
          power={3.5}
          rimMin={0.22}
          rimMax={0.5}
          alphaCut={0.03}
        />
        {/* Selection spotlight - illuminates only the selected model via layers */}
        <SelectionSpotlight
          meshRef={activeActualMeshRef as React.RefObject<THREE.Mesh>}
          enabled={effectiveModelSelected && selectionHighlightMode === 'spotlight'}
          color="#ffeacc"
          intensity={7.6}
          angle={Math.PI / 3}
          penumbra={0.3}
          elevation={60}
          radius={60}
        />
        <OrbitControls
          makeDefault
          enableDamping={false}
          enablePan
          enabled={models.length > 0 && !(mode === 'prepare' && transformMode === 'smoothing' && smoothingBrushState.isStrokeActive) && !isGizmoDragging}
          onStart={handleOrbitStart}
          onChange={handleOrbitChange}
          onEnd={handleOrbitEnd}
          target={orbitTarget}
          mouseButtons={{ LEFT: undefined as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }}
        />
        <SpaceMouseController
          pivotPoint={selectedSpaceMousePivotPoint}
          pivotCandidates={spaceMousePivotCandidates}
          fallbackPivot={buildVolumeCenterTarget}
          mouseOrbitDragRunId={mouseOrbitDragRunId}
          onNavigationActiveChange={setSpaceMouseNavigationActive}
        />
        <CameraFocusHotkeyController hoverPointRef={lastHoveredModelPointRef} setOrbitTargetFromPoint={setOrbitTargetFromPoint} />
        <CameraIntroController
          bounds={introControllerBounds}
          runId={introControllerRunId}
          onComplete={setCameraIntroCompletedRunId}
          mode={mode}
          plateWidthMm={activeBuildVolumeSettings.widthMm}
          plateDepthMm={activeBuildVolumeSettings.depthMm}
        />
        <CameraHomeResetController
          runId={cameraHomeResetRunId}
          homePosition={defaultCamera.position}
          homeTarget={[buildVolumeCenterTarget.x, buildVolumeCenterTarget.y, buildVolumeCenterTarget.z]}
          homeFovDeg={defaultCamera.fov}
        />
        <CameraModeEntryFramingController
          runId={modeEntryFramingRunId}
          restoreRunId={modeExitRestoreRunId}
          target={buildVolumeCenterTarget}
          plateWidthMm={activeBuildVolumeSettings.widthMm}
          plateDepthMm={activeBuildVolumeSettings.depthMm}
        />
        <SupportModeCameraRestoreController
          capturePreSupportRunId={supportEntryCaptureRunId}
          restorePreSupportRunId={supportExitRestoreRunId}
          captureSupportRunId={supportCameraCaptureRunId}
          restoreSupportRunId={supportCameraRestoreRunId}
        />
        <CameraFocusController selectedIslandId={overlaySelectedIslandId ?? null} islandMarkers={islandMarkers ?? []} />
        {/* Selection outline effect - rendered by SelectionOutlineRenderer inside SelectionProvider */}
        {children}
      </Canvas>

      <SceneMoodOverlay />

      {smoothingLoading.active && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div className="rounded border border-neutral-700 bg-neutral-900/70 px-3 py-2 text-sm text-neutral-100">
            Loading brush…
          </div>
        </div>
      )}

      {smoothingProcessing.active && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div className="rounded border border-neutral-700 bg-neutral-900/70 px-3 py-2 text-sm text-neutral-100">
            Smoothing… {Math.round((smoothingProcessing.progress ?? 0) * 100)}%
          </div>
        </div>
      )}

      {/* Support Limitation Tooltip Overlay */}
      <SupportLimitationFeedback
        error={leafPlacementPreview?.error ?? (isBranchPlacementActive ? branchPlacementPreview?.error : null) ?? trunkPlacementPreview?.error ?? null}
        warning={
          leafPlacementPreview?.warning ??
          (isBranchPlacementActive ? branchPlacementPreview?.warning : null) ??
          trunkPlacementPreview?.warning ??
          interactionWarning ??
          null
        }
      />

      {/* GPU Picking Debug Overlay - shows what's under cursor */}
      {gpuPickingTest && <PickingDebugOverlay position="top-right" />}

      {activeBuildVolumeSettings?.enabled && activeBuildVolumeSettings.showViolationWarning && outOfBoundsModels.length > 0 && (
        <div
          className="absolute bottom-5 left-1/2 z-40 -translate-x-1/2 animate-pulse rounded-full border px-5 py-2 text-sm font-semibold shadow-lg"
          style={{
            pointerEvents: 'none',
            borderColor: 'color-mix(in srgb, #ff5b6f, var(--border-subtle) 42%)',
            background: 'color-mix(in srgb, #ff5b6f, var(--surface-0) 90%)',
            color: 'var(--text-strong)',
          }}
          title={outOfBoundsModels.map((m) => m.name).join(', ')}
        >
          <span style={{ marginRight: 6 }}>⚠</span>
          {outOfBoundsModels.length} model{outOfBoundsModels.length === 1 ? '' : 's'} out of build volume
        </div>
      )}
    </div>
  );
}
