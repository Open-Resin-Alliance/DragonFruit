"use client";

import React, { useEffect } from 'react';
import dynamic from 'next/dynamic';
import * as THREE from 'three';
import { AlertTriangle } from 'lucide-react';
import { OrbitControls } from '@react-three/drei';
import {
  CrossSectionStencilCap,
  type CrossSectionCapDebugOverrides,
  type CrossSectionStencilCapEntry,
} from '@/components/scene/CrossSectionStencilCap';
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
import type { SupportData } from '@/supports/rendering';
import { subscribe as subscribeSupportState, getSnapshot as getSupportSnapshot } from '@/supports/state';
import { getModelIdForSupportEntityId } from '@/supports/state';
import { subscribeToKickstandStore, getKickstandSnapshot } from '@/supports/SupportTypes/Kickstand/kickstandStore';
import FootprintBorderRenderer from '@/supports/Rafts/Crenelated/rendering/FootprintBorderRenderer';
import SliceSatBoundingMeshRenderer from '@/supports/Rafts/Crenelated/rendering/SliceSatBoundingMeshRenderer';
import { getRaftSettings, subscribeToRaftStore } from '@/supports/Rafts/Crenelated/RaftState';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { computeRaftOuterBoundary } from '@/supports/Rafts/Crenelated/geometry/computeRaftOuterBoundary';
import type { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { JointPlacementPreview } from '@/supports/SupportPrimitives/Joint/JointPlacementPreview';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone/contactConeUtils';
import { isContactDiskHudInteractionActive } from '@/supports/SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { BranchPlacementController } from '@/supports/SupportTypes/Branch/BranchPlacementController';
import { LeafPlacementController } from '@/supports/SupportTypes/Leaf/LeafPlacementController';
import { BracePlacementController } from '@/supports/SupportTypes/Brace/BracePlacementController';
import { KickstandPlacementController } from '@/supports/SupportTypes/Kickstand/KickstandPlacementController';
import { clearSupportSelection } from '@/supports/interaction/shared/selection/selectionController';
import { isSupportTargetHoverCategory } from '@/supports/interaction/shared/hover/supportHoverResolver';
import { useSceneHoveredSupportId } from '@/supports/interaction/shared/hover/sceneHoverStore';
import { SupportLimitationFeedback } from '@/supports/PlacementLogic/SupportLimitations';
import { useCurveInteractionState } from '@/supports/Curves/curveInteractionState';
import { getSettings, subscribeToSettings } from '@/supports/Settings';
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
import { useSupportDragDeltaBridge } from './useSupportDragDeltaBridge';
import { useExportThumbnailCapture, type ExportThumbnailRenderOptions } from './useExportThumbnailCapture';
import {
  buildBoxWireframePositions,
  buildEmptyCornerOnlyWireframePositions,
  writeCornerOnlyWireframePositions,
} from './SceneCanvasGeometry';
import { ModelAttachedSupportLayer } from './ModelAttachedSupportLayer';
import {
  CameraModeEntryFramingController,
  CameraProjectionController,
  OrbitPivotIndicator,
} from './SceneCanvasCameraControllers';
import { useMarqueeSelectionHandlers } from './useMarqueeSelectionHandlers';
import { PickingEmptySpaceHoverResetter, SceneRenderBindings } from './SceneCanvasInteractionBits';

import { PickingProviderWrapper, SelectionSync, useInteractionWarning } from './SceneSelectionAndPicking';
import { CameraClipPlaneStabilizer, CameraProvider, EnableLocalClipping, Helpers, Lights, LoggingHelper, SceneMoodOverlay } from './SceneEnvironment';
import { StlMesh } from './StlMesh';
import { setClipBounds } from './clipBoundsStore';
import { useIsLinux } from '@/hooks/usePlatform';
import {
  DEFAULT_CAMERA_PROJECTION_SETTINGS,
  getSavedCameraProjectionSettings,
  subscribeToCameraProjectionSettings,
  type CameraProjectionMode,
} from '@/components/settings/cameraProjectionPreferences';
import {
  DEFAULT_CAMERA_FEEL_SETTINGS,
  getSavedCameraFeelSettings,
  subscribeToCameraFeelSettings,
  type CameraFeelPreset,
} from '@/components/settings/cameraFeelPreferences';
import {
  DEFAULT_CAMERA_TRACKPAD_SETTINGS,
  getSavedCameraTrackpadSettings,
  subscribeToCameraTrackpadSettings,
  type CameraTrackpadModifierKey,
  type CameraTrackpadPrimaryAction,
} from '@/components/settings/cameraTrackpadPreferences';
import {
  DIAGNOSTICS_BENCHMARK_PROGRESS_EVENT,
  DIAGNOSTICS_BENCHMARK_REQUEST_EVENT,
  type DiagnosticsBenchmarkPhaseName,
  type DiagnosticsBenchmarkPhaseResult,
  type DiagnosticsBenchmarkProgressDetail,
  type DiagnosticsBenchmarkRequestDetail,
  type DiagnosticsBenchmarkResult,
  type DiagnosticsBenchmarkStats,
  type DiagnosticsBenchmarkStressProfile,
} from '@/components/modals/diagnosticsBenchmarkEvents';
import { DEFAULT_VIEW3D_SETTINGS, type View3DSettings } from '@/components/settings/view3dPreferences';
import {
  computeApproxModelWorldBounds,
  computePreciseModelWorldBounds,
  isBoundsOutsideVolume,
  shouldUsePreciseBoundsForTransform,
} from '@/utils/modelBounds';
import { computeLowestZ } from '@/utils/geometry';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { emitImmediateModelHover } from '@/supports/interaction/pointerOcclusion';

const Canvas = dynamic(() => import('@react-three/fiber').then(m => m.Canvas), { ssr: false });

type GhostPreviewTransform = {
  position: THREE.Vector3;
  rotation: THREE.Euler;
  scale: THREE.Vector3;
};

type TrackpadGestureAction = 'pan' | 'orbit';

function isLikelyTrackpadWheelEvent(event: WheelEvent): boolean {
  // Use numeric DOM_DELTA_PIXEL (=0) to avoid relying on global WheelEvent in all runtimes.
  if (event.deltaMode !== 0) return false;
  if (event.ctrlKey) return true;

  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  const dominantDelta = Math.max(absX, absY);
  const recessiveDelta = Math.min(absX, absY);

  if (dominantDelta <= 0) return false;

  // Exclude typical mouse wheel events: one axis nearly zero, other large.
  // This prevents regular mouse scroll from triggering trackpad gestures.
  if (recessiveDelta < 2 && dominantDelta > 16) return false;

  if (absX > 0) return true;
  if (!Number.isInteger(event.deltaX) || !Number.isInteger(event.deltaY)) return true;
  return dominantDelta <= 16;
}

function isTrackpadModifierPressed(event: WheelEvent, modifierKey: CameraTrackpadModifierKey): boolean {
  return modifierKey === 'shift' ? event.shiftKey : event.altKey;
}

function resolveTrackpadGestureAction(
  event: WheelEvent,
  primaryAction: CameraTrackpadPrimaryAction,
  modifierKey: CameraTrackpadModifierKey,
): TrackpadGestureAction | null {
  if (primaryAction === 'off') return null;
  if (event.ctrlKey || event.metaKey) return null;
  if (!isLikelyTrackpadWheelEvent(event)) return null;

  const modifierPressed = isTrackpadModifierPressed(event, modifierKey);
  if (!modifierPressed) return primaryAction;
  return primaryAction === 'pan' ? 'orbit' : 'pan';
}

function GhostPreviewInstances({
  geometry,
  center,
  color,
  transforms,
  opacity = 0.22,
  renderOrder = 2,
}: {
  geometry: THREE.BufferGeometry;
  center: THREE.Vector3;
  color: string;
  transforms: GhostPreviewTransform[];
  opacity?: number;
  renderOrder?: number;
}) {
  const instancedRef = React.useRef<THREE.InstancedMesh>(null);
  const workMatrixRef = React.useRef(new THREE.Matrix4());
  const workQuaternionRef = React.useRef(new THREE.Quaternion());
  const workOffsetMatrixRef = React.useRef(new THREE.Matrix4());

  React.useLayoutEffect(() => {
    const instanced = instancedRef.current;
    if (!instanced) return;

    const workMatrix = workMatrixRef.current;
    const workQuaternion = workQuaternionRef.current;
    const offsetMatrix = workOffsetMatrixRef.current.makeTranslation(-center.x, -center.y, -center.z);

    for (let i = 0; i < transforms.length; i += 1) {
      const transform = transforms[i];
      workQuaternion.setFromEuler(transform.rotation);
      workMatrix.compose(transform.position, workQuaternion, transform.scale);
      workMatrix.multiply(offsetMatrix);
      instanced.setMatrixAt(i, workMatrix);
    }

    instanced.count = transforms.length;
    instanced.instanceMatrix.needsUpdate = true;
    instanced.computeBoundingSphere();
  }, [center.x, center.y, center.z, transforms]);

  if (transforms.length === 0) return null;

  return (
    <instancedMesh
      ref={instancedRef}
      args={[geometry, undefined, transforms.length]}
      renderOrder={renderOrder}
      raycast={() => null}
      frustumCulled={false}
    >
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        depthWrite={false}
        toneMapped={false}
      />
    </instancedMesh>
  );
}

type CrossSectionCapDebugPanelState = {
  enabled: boolean;
  top: CrossSectionCapDebugOverrides;
  bottom: CrossSectionCapDebugOverrides;
};

const CROSS_SECTION_CAP_DEBUG_STORAGE_KEY = 'df:cross-section-cap-debug:v4';
const CROSS_SECTION_CAP_DEBUG_HOTKEY_ENABLED = false;

const DEFAULT_CROSS_SECTION_CAP_DEBUG_STATE: CrossSectionCapDebugPanelState = {
  enabled: false,
  top: {
    side: 'front',
    offsetMm: 1e-4,
    rotationXDeg: 0,
    clipMode: 'upper',
    stencilMode: 'standard',
    depthTest: true,
  },
  bottom: {
    side: 'back',
    offsetMm: -1e-4,
    rotationXDeg: 0,
    clipMode: 'lower',
    stencilMode: 'standard',
    depthTest: false,
  },
};

export function SceneCanvas({
  models: modelsProp = [],
  activeModelId: activeModelIdProp,
  visualActiveModelId,
  selectedModelIds,
  // Legacy props kept for compatibility if needed
  geom,
  clipLower,
  clipUpper,
  meshColor, // Global fallback color? Each model has color.
  meshVisible,
  shaderType,
  matcapVariant,
  flatUseVertexColors,
  toonSteps,
  xrayOpacity,
  heatmapBlend,
  heatmapContrast,
  heatmapColors,
  disableRaycast,
  ambientIntensity,
  directionalIntensity,
  headlightIntensity,
  onCameraChange,
  onCameraEnd,
  islandMarkers,
  overlayBrushRadius,
  overlayColor,
  overlayOpacity,
  overlaySelectedIslandId,
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
  autoLift = false,
  liftDistance = 5,
  autoSnapEnabled = true,
  onTransformChange,
  onTransformStart,
  onGizmoTransformCommit,
  onGizmoTransformGroupCommit,
  onTransformChangeEnd, // Was onTransformEnd in previous code, checking usage
  onTransformEnd,
  crossSectionMode,
  pxMm,
  showIslandIdLabels,
  mode,
  onSupportClick,
  onSupportHover,
  onActiveModelChange,
  onMarqueeSelectionChange,
  trunkPlacementPreview,
  branchPlacementPreview,
  leafPlacementPreview,
  bracePlacementPreview,
  kickstandPlacementPreview,
  jointPlacementPreview,
  gpuPickingTest,
  selectionHighlightMode,
  blockSupportPlacement,
  supportsRef,
  supportDragGroupRef,
  holdSupportDragDelta,
  supportDragTransactionId = 0,
  ghostData,
  duplicatePreviewModel,
  duplicatePreviewTransforms,
  duplicateActivePreviewTransform,
  arrangeArrayPreviewItems,
  hideDuplicateSourceDuringApply,
  isBranchPlacementActive,
  isLeafPlacementActive,
  isBracePlacementActive,
  isKickstandPlacementActive,
  hideCrossSectionCap = false,
  branchTipPosition,
  branchHoverPosition,
  leafTipPosition,
  leafHoverPosition,
  selectionColor,
  hoverColor,
  hoverTintStrength,
  selectedTintStrength,
  children,
  expansionSimulator,
  showExpansion,
  classificationFaceLabels,
  classificationGeometry,
  showClassification,
  view3dSettings,
  supportRenderRefreshNonce = 0,
  gizmoResetNonce = 0,
  historyTransformResyncToken = 0,
  isLayerScrubbing = false,
  onRegisterExportThumbnailCapture,
  exportThumbnailRenderOptions,
  indicatorPlaneZ = null,
  indicatorPlaneColor,
  deferCameraIntro = false,
  freezeViewportActive = false,
}: {
  models?: LoadedModel[];
  activeModelId?: string | null;
  visualActiveModelId?: string | null;
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
  heatmapBlend?: number;
  heatmapContrast?: number;
  heatmapColors?: string[];
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
  autoLift?: boolean;
  liftDistance?: number;
  autoSnapEnabled?: boolean;
  onTransformChange?: (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3) => void;
  onTransformStart?: (
    operation: 'move' | 'rotate' | 'scale',
    details?: { axis?: 'x' | 'y' | 'z' | 'uniform'; isUniform?: boolean },
  ) => boolean | void;
  onGizmoTransformCommit?: (payload: {
    modelId: string;
    operation: 'move' | 'rotate' | 'scale';
    before: ModelTransform;
    after: ModelTransform;
  }) => void;
  onGizmoTransformGroupCommit?: (payload: {
    operation: 'move' | 'rotate' | 'scale';
    entries: Array<{
      modelId: string;
      before: ModelTransform;
      after: ModelTransform;
    }>;
  }) => void;
  onTransformChangeEnd?: (position: THREE.Vector3, rotation: THREE.Euler, scale: THREE.Vector3) => void;
  onTransformEnd?: (
    operation: 'move' | 'rotate' | 'scale',
    finalTransform?: ModelTransform,
    options?: { skipStoreCommit?: boolean },
  ) => void;
  crossSectionMode?: 'smooth' | 'rasterized';
  pxMm?: number;
  showIslandIdLabels?: boolean;
  mode?: SupportMode;
  onSupportClick?: (hit: THREE.Intersection) => void;
  onSupportHover?: (hit: THREE.Intersection | null) => void;
  onActiveModelChange?: (id: string | null, options?: { selectionMode?: 'single' | 'toggle' | 'add' }) => void;
  onMarqueeSelectionChange?: (ids: string[]) => void;
  trunkPlacementPreview?: SupportData | null;
  branchPlacementPreview?: SupportData | null;
  leafPlacementPreview?: SupportData | null;
  bracePlacementPreview?: import('@/supports/SupportTypes/Brace/bracePlacementState').BracePreviewData | null;
  kickstandPlacementPreview?: SupportData | null;
  jointPlacementPreview?: { pos: { x: number; y: number; z: number }; diameter: number } | null;
  gpuPickingTest?: boolean;
  selectionHighlightMode?: SelectionHighlightMode;
  blockSupportPlacement?: boolean;
  supportsRef?: React.RefObject<THREE.Group | null>;
  supportDragGroupRef?: React.RefObject<THREE.Group | null>;
  holdSupportDragDelta?: boolean;
  supportDragTransactionId?: number;
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
  isKickstandPlacementActive?: boolean;
  branchTipPosition?: { x: number; y: number; z: number } | null;
  branchHoverPosition?: { x: number; y: number; z: number } | null;
  leafTipPosition?: { x: number; y: number; z: number } | null;
  leafHoverPosition?: { x: number; y: number; z: number } | null;
  selectionColor?: string;
  hoverColor?: string;
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
  supportRenderRefreshNonce?: number;
  gizmoResetNonce?: number;
  historyTransformResyncToken?: number;
  isLayerScrubbing?: boolean;
  onRegisterExportThumbnailCapture?: (capture: (() => Promise<Uint8Array | null>) | null) => void;
  exportThumbnailRenderOptions?: ExportThumbnailRenderOptions;
  indicatorPlaneZ?: number | null;
  indicatorPlaneColor?: string;
  deferCameraIntro?: boolean;
  freezeViewportActive?: boolean;
}) {
  const DROP_ANIMATION_DURATION_MS = 760;
  const LARGE_MODEL_BOUNCE_THRESHOLD_POLYS = 900_000;
  const LARGE_MODEL_DROP_DEFER_THRESHOLD_POLYS = 1_200_000;
  const BUILD_VOLUME_BOUNDS_EPS_MM = 0.01;
  const OUT_OF_BOUNDS_ROTATE_GRACE_MS = 320;
  const cameraProjectionMode = React.useSyncExternalStore(
    subscribeToCameraProjectionSettings,
    () => getSavedCameraProjectionSettings().mode,
    () => DEFAULT_CAMERA_PROJECTION_SETTINGS.mode,
  );
  const cameraFeelPreset = React.useSyncExternalStore(
    subscribeToCameraFeelSettings,
    () => getSavedCameraFeelSettings().preset,
    () => DEFAULT_CAMERA_FEEL_SETTINGS.preset,
  );
  const cameraTrackpadSettings = React.useSyncExternalStore(
    subscribeToCameraTrackpadSettings,
    () => getSavedCameraTrackpadSettings().primaryAction,
    () => DEFAULT_CAMERA_TRACKPAD_SETTINGS.primaryAction,
  );
  const cameraTrackpadModifierKey = React.useSyncExternalStore(
    subscribeToCameraTrackpadSettings,
    () => getSavedCameraTrackpadSettings().modifierKey,
    () => DEFAULT_CAMERA_TRACKPAD_SETTINGS.modifierKey,
  );
  const cameraTrackpadPanAcceleration = React.useSyncExternalStore(
    subscribeToCameraTrackpadSettings,
    () => getSavedCameraTrackpadSettings().panAcceleration,
    () => DEFAULT_CAMERA_TRACKPAD_SETTINGS.panAcceleration,
  );
  const cameraTrackpadOrbitAcceleration = React.useSyncExternalStore(
    subscribeToCameraTrackpadSettings,
    () => getSavedCameraTrackpadSettings().orbitAcceleration,
    () => DEFAULT_CAMERA_TRACKPAD_SETTINGS.orbitAcceleration,
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

  const supportStateForBounds = React.useSyncExternalStore(
    subscribeSupportState,
    getSupportSnapshot,
    getSupportSnapshot,
  );
  const supportSettings = React.useSyncExternalStore(
    subscribeToSettings,
    getSettings,
    getSettings,
  );
  const isLinux = useIsLinux();
  const sceneHoveredSupportId = useSceneHoveredSupportId();
  const [contactDiskHudInteractionActive, setContactDiskHudInteractionActive] = React.useState(() => isContactDiskHudInteractionActive());

  // Sync clip bounds to the module-level store so BranchPlacementController
  // (and other independent raycasters) can skip hits on clipped geometry.
  setClipBounds(clipLower, clipUpper);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleContactDiskHudInteractionChange = (event: Event) => {
      const detail = (event as CustomEvent<{ active?: boolean }>).detail;
      setContactDiskHudInteractionActive(!!detail?.active);
    };

    window.addEventListener('contact-disk-hud-interaction-change', handleContactDiskHudInteractionChange as EventListener);
    return () => {
      window.removeEventListener('contact-disk-hud-interaction-change', handleContactDiskHudInteractionChange as EventListener);
    };
  }, []);

  const kickstandStateForBounds = React.useSyncExternalStore(
    subscribeToKickstandStore,
    getKickstandSnapshot,
    getKickstandSnapshot,
  );

  const raftSettingsForBounds = React.useSyncExternalStore(
    subscribeToRaftStore,
    getRaftSettings,
    getRaftSettings,
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

  const modelById = React.useMemo(() => {
    const map = new Map<string, LoadedModel>();
    for (const model of models) {
      map.set(model.id, model);
    }
    return map;
  }, [models]);

  React.useEffect(() => {
    const modelIdSet = new Set(models.map((model) => model.id));
    for (const id of Object.keys(meshGroupRefCallbacks.current)) {
      if (!modelIdSet.has(id)) {
        delete meshGroupRefCallbacks.current[id];
        delete meshRefs.current[id];
      }
    }
    for (const id of Object.keys(actualMeshRefCallbacks.current)) {
      if (!modelIdSet.has(id)) {
        delete actualMeshRefCallbacks.current[id];
        delete actualMeshRefs.current[id];
      }
    }
  }, [models]);

  const alignLiveTransformToLift = React.useCallback((model: LoadedModel | null | undefined, candidate: ModelTransform | null) => {
    if (!model || !candidate) return candidate;
    if (!autoSnapEnabled) return candidate;

    const geometry = model.geometry?.geometry;
    if (!geometry) return candidate;

    const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position') as THREE.BufferAttribute);
    const center = bbox.getCenter(new THREE.Vector3());

    const offsetMatrix = new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z);
    const rotScaleMatrix = new THREE.Matrix4();
    rotScaleMatrix.compose(
      new THREE.Vector3(0, 0, 0),
      quaternionFromGlobalEuler(candidate.rotation),
      candidate.scale,
    );

    const posMatrix = new THREE.Matrix4().makeTranslation(candidate.position.x, candidate.position.y, candidate.position.z);
    const finalMatrix = posMatrix.multiply(rotScaleMatrix).multiply(offsetMatrix);
    const lowestWorldZ = computeLowestZ(geometry, finalMatrix);
    const targetZ = autoLift ? liftDistance : 0.001;
    const offset = targetZ - lowestWorldZ;

    if (!Number.isFinite(offset) || Math.abs(offset) <= 1e-5) {
      return candidate;
    }

    return {
      position: candidate.position.clone().add(new THREE.Vector3(0, 0, offset)),
      rotation: candidate.rotation.clone(),
      scale: candidate.scale.clone(),
    };
  }, [autoLift, autoSnapEnabled, liftDistance]);

  const supportColorsByModelId = React.useMemo(() => {
    const fallbackColor = meshColor ?? '#a3a3a3';
    const entries = models.map((model) => [model.id, model.color || fallbackColor] as const);
    return Object.fromEntries(entries);
  }, [meshColor, models]);

  const activeModelId = React.useMemo(() => {
    if (typeof activeModelIdProp === 'string') return activeModelIdProp;
    if (activeModelIdProp === null) return null;
    return models.length === 1 ? models[0].id : null;
  }, [activeModelIdProp, models]);

  const committedActiveModelId = React.useMemo(() => {
    if (typeof visualActiveModelId === 'string') return visualActiveModelId;
    if (visualActiveModelId === null && !activeModelId) return null;
    return activeModelId;
  }, [activeModelId, visualActiveModelId]);

  const colorActiveModelId = React.useMemo(() => committedActiveModelId, [committedActiveModelId]);

  const meshRefs = React.useRef<Record<string, THREE.Group | null>>({});
  const actualMeshRefs = React.useRef<Record<string, THREE.Mesh | null>>({});
  const meshGroupRefCallbacks = React.useRef<Record<string, (node: THREE.Group | null) => void>>({});
  const actualMeshRefCallbacks = React.useRef<Record<string, (node: THREE.Mesh | null) => void>>({});

  const prevBranchHoverDotVisibleRef = React.useRef<boolean | null>(null);
  const prevLeafHoverDotVisibleRef = React.useRef<boolean | null>(null);
  const supportPlacementGuideRafRef = React.useRef<number | null>(null);
  const supportPlacementGuidePendingZRef = React.useRef<number | null>(null);
  const [supportPlacementGuideZ, setSupportPlacementGuideZ] = React.useState<number | null>(null);

  const [isModelSelected, setIsModelSelected] = React.useState(true); // Track for gizmo visibility

  // Any active model should be treated as selected for highlight effects
  // across all modes (prepare/support/analysis/export).
  const effectiveModelSelected = isModelSelected || !!activeModelId;
  const [isGizmoDragging, setIsGizmoDragging] = React.useState(false);
  const [isGizmoRetargeting, setIsGizmoRetargeting] = React.useState(false);
  const [activeGizmoDragDescriptor, setActiveGizmoDragDescriptor] = React.useState<{
    operation: 'move' | 'rotate' | 'scale';
    axis?: 'x' | 'y' | 'z' | 'uniform';
    isUniform?: boolean;
  } | null>(null);
  const [outOfBoundsRotateGraceActive, setOutOfBoundsRotateGraceActive] = React.useState(false);
  const outOfBoundsRotateGraceTimeoutRef = React.useRef<number | null>(null);
  const [isPostGizmoInteractionGuardActive, setIsPostGizmoInteractionGuardActive] = React.useState(false);
  const postGizmoInteractionTimeoutRef = React.useRef<number | null>(null);
  const initialScaleRef = React.useRef<THREE.Vector3>(new THREE.Vector3(1, 1, 1));
  const gizmoTransformStartSnapshotRef = React.useRef<{
    modelId: string;
    operation: 'move' | 'rotate' | 'scale';
    before: ModelTransform;
  } | null>(null);
  const [gizmoGroupStartSnapshot, setGizmoGroupStartSnapshot] = React.useState<{
    operation: 'move' | 'scale';
    activeModelId: string;
    pivot: THREE.Vector3;
    beforeByModelId: Record<string, ModelTransform>;
  } | null>(null);
  const liveDragTransformRef = React.useRef<ModelTransform | null>(null);
  const [liveDragTransformVersion, setLiveDragTransformVersion] = React.useState(0);

  // --- Live support group transform during gizmo drag ---
  const gizmoDragBeforeMatrixRef = React.useRef<THREE.Matrix4 | null>(null);
  const supportDragResetFallbackTimeoutRef = React.useRef<number | null>(null);
  const supportDragResetRafRef = React.useRef<number | null>(null);
  const supportDragResetSecondRafRef = React.useRef<number | null>(null);
  // Reusable work matrices to avoid GC pressure during drag
  const _dragWorkCurrent = React.useRef(new THREE.Matrix4());
  const _dragWorkInvBefore = React.useRef(new THREE.Matrix4());
  const _dragWorkPosition = React.useRef(new THREE.Vector3());
  // Move-drag Z lock (keeps non-Z drags on their original Z without per-drag geometry scans)
  const dragMoveLockZEnabledRef = React.useRef<boolean>(false);
  const dragMoveLockedZRef = React.useRef<number>(0);
  const modelDropOffsetsRef = React.useRef<Record<string, number>>({});

  const cancelPendingSupportDragResets = React.useCallback(() => {
    if (supportDragResetRafRef.current !== null) {
      cancelAnimationFrame(supportDragResetRafRef.current);
      supportDragResetRafRef.current = null;
    }

    if (supportDragResetSecondRafRef.current !== null) {
      cancelAnimationFrame(supportDragResetSecondRafRef.current);
      supportDragResetSecondRafRef.current = null;
    }

    if (supportDragResetFallbackTimeoutRef.current !== null) {
      window.clearTimeout(supportDragResetFallbackTimeoutRef.current);
      supportDragResetFallbackTimeoutRef.current = null;
    }
  }, []);

  const resetSupportDragGroupNow = React.useCallback(() => {
    const dragGroup = supportDragGroupRef?.current;
    if (dragGroup) {
      dragGroup.matrix.identity();
      dragGroup.matrixAutoUpdate = true;
    }
    gizmoDragBeforeMatrixRef.current = null;
  }, [supportDragGroupRef]);

  const scheduleSupportDragGroupReset = React.useCallback(() => {
    cancelPendingSupportDragResets();

    // Two-frame defer allows model/support committed transforms to land first,
    // then clears any leftover temporary drag matrix deterministically.
    supportDragResetRafRef.current = requestAnimationFrame(() => {
      supportDragResetSecondRafRef.current = requestAnimationFrame(() => {
        resetSupportDragGroupNow();
        supportDragResetSecondRafRef.current = null;
      });
      supportDragResetRafRef.current = null;
    });

    // Backstop in case RAF chain is interrupted.
    supportDragResetFallbackTimeoutRef.current = window.setTimeout(() => {
      resetSupportDragGroupNow();
      supportDragResetFallbackTimeoutRef.current = null;
    }, 180);
  }, [cancelPendingSupportDragResets, resetSupportDragGroupNow]);

  const queueLiveDragTransform = React.useCallback((next: ModelTransform | null) => {
    liveDragTransformRef.current = next;
    // During active drag, avoid per-frame React rerenders; scene objects are
    // moved imperatively and this ref remains the source of truth.
    if (isGizmoDragging) return;
    setLiveDragTransformVersion((value) => value + 1);
  }, [isGizmoDragging]);

  const {
    effectiveHoldSupportDragDelta,
    armLocalBridge: armSupportDragDeltaBridge,
  } = useSupportDragDeltaBridge({
    holdSupportDragDelta,
    supportDragTransactionId,
    bridgeWindowMs: 360,
  });

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    cancelPendingSupportDragResets();

    if (isGizmoDragging) return;

    // Parent orchestrator (page.tsx) owns reset timing when transform-end
    // callback is provided, so we avoid an early duplicate reset here.
    if (onTransformEnd) return;

    // Defensive reset path for any missed/late gizmo end callback ordering.
    scheduleSupportDragGroupReset();

    return () => {
      cancelPendingSupportDragResets();
    };
  }, [cancelPendingSupportDragResets, isGizmoDragging, onTransformEnd, scheduleSupportDragGroupReset]);

  React.useEffect(() => {
    if (isGizmoDragging) return;
    queueLiveDragTransform(null);
  }, [isGizmoDragging, queueLiveDragTransform]);

  React.useEffect(() => {
    if (isGizmoDragging) return;
    if (activeGizmoDragDescriptor === null) return;
    setActiveGizmoDragDescriptor(null);
  }, [activeGizmoDragDescriptor, isGizmoDragging]);

  React.useEffect(() => {
    // Hard reset transient drag caches whenever selection target changes.
    // This prevents stale live transforms from the previous model from being
    // reused after delete/import/undo flows.
    liveDragTransformRef.current = null;
    setLiveDragTransformVersion((value) => value + 1);
    setIsGizmoDragging(false);
    setIsGizmoRetargeting(false);
    gizmoTransformStartSnapshotRef.current = null;
    setActiveGizmoDragDescriptor(null);
    setGizmoGroupStartSnapshot(null);
  }, [activeModelId]);

  React.useEffect(() => {
    if (historyTransformResyncToken <= 0) return;

    // History apply (undo/redo) must always win over any stale live drag refs.
    // Clear all transient gizmo/live state so rendering falls back to store data.
    cancelPendingSupportDragResets();
    liveDragTransformRef.current = null;
    setLiveDragTransformVersion((value) => value + 1);
    gizmoTransformStartSnapshotRef.current = null;
    setActiveGizmoDragDescriptor(null);
    setGizmoGroupStartSnapshot(null);
    setIsGizmoDragging(false);
    resetSupportDragGroupNow();
  }, [
    setActiveGizmoDragDescriptor,
    cancelPendingSupportDragResets,
    historyTransformResyncToken,
    resetSupportDragGroupNow,
  ]);

  React.useEffect(() => {
    return () => {
      liveDragTransformRef.current = null;
    };
  }, []);

  const startOutOfBoundsRotateGrace = React.useCallback(() => {
    setOutOfBoundsRotateGraceActive(true);

    if (typeof window === 'undefined') return;
    if (outOfBoundsRotateGraceTimeoutRef.current !== null) {
      window.clearTimeout(outOfBoundsRotateGraceTimeoutRef.current);
    }

    outOfBoundsRotateGraceTimeoutRef.current = window.setTimeout(() => {
      setOutOfBoundsRotateGraceActive(false);
      outOfBoundsRotateGraceTimeoutRef.current = null;
    }, OUT_OF_BOUNDS_ROTATE_GRACE_MS);
  }, [OUT_OF_BOUNDS_ROTATE_GRACE_MS]);

  React.useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      if (outOfBoundsRotateGraceTimeoutRef.current !== null) {
        window.clearTimeout(outOfBoundsRotateGraceTimeoutRef.current);
      }
    };
  }, []);

  const cameraRef = React.useRef<THREE.Camera | null>(null);
  const rendererRef = React.useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = React.useRef<THREE.Scene | null>(null);
  const buildVolumeBoundsOverlayRef = React.useRef<THREE.Group | null>(null);
  const orbitControlsRef = React.useRef<{
    target: THREE.Vector3;
    rotateSpeed: number;
    panSpeed: number;
    zoomSpeed: number;
    update: () => void;
    enabled?: boolean;
  } | null>(null);
  const suppressNextCanvasClickRef = React.useRef(false);
  const orbitChangeRafRef = React.useRef<number | null>(null);
  const orbitChangeQueuedRef = React.useRef(false);
  const orbitInteractionActiveRef = React.useRef(false);
  const orbitInteractionMovedRef = React.useRef(false);
  const wheelZoomEndTimeoutRef = React.useRef<number | null>(null);
  const wheelZoomInteractionActiveRef = React.useRef(false);
  const trackpadGestureEndTimeoutRef = React.useRef<number | null>(null);
  const trackpadGestureActionRef = React.useRef<TrackpadGestureAction | null>(null);
  const navigationResumeDelayRef = React.useRef(0);
  const benchmarkRunIdRef = React.useRef<string | null>(null);
  const [isOrbitInteracting, setIsOrbitInteracting] = React.useState(false);
  const [isOrbitRotating, setIsOrbitRotating] = React.useState(false);
  const [isWheelZoomInteracting, setIsWheelZoomInteracting] = React.useState(false);
  const [interactionResetNonce, setInteractionResetNonce] = React.useState(0);
  const [canvasRecoveryNonce, setCanvasRecoveryNonce] = React.useState(0);
  const [frozenViewportDataUrl, setFrozenViewportDataUrl] = React.useState<string | null>(null);
  const freezeCaptureArmedRef = React.useRef(false);
  const [spaceMouseNavigationActive, setSpaceMouseNavigationActive] = React.useState(false);
  const [supportGizmoInteractionActive, setSupportGizmoInteractionActive] = React.useState(false);
  const supportGizmoInteractionTimeoutRef = React.useRef<number | null>(null);
  const webGlRecoveryTimeoutRef = React.useRef<number | null>(null);
    const isOrbitInRotateState = React.useCallback(() => {
      if (trackpadGestureActionRef.current != null) {
        return trackpadGestureActionRef.current === 'orbit';
      }
      const orbitControls = orbitControlsRef.current as unknown as { state?: number } | null;
      const state = orbitControls?.state;
      // OrbitControls internal states:
      // ROTATE=0, DOLLY=1, PAN=2, TOUCH_ROTATE=3, TOUCH_PAN=4,
      // TOUCH_DOLLY_PAN=5, TOUCH_DOLLY_ROTATE=6.
      // We only want to hide on explicit pan modes.
      if (state == null) return true;
      return state !== 2 && state !== 4 && state !== 5;
    }, []);

  const [mouseOrbitDragRunId, setMouseOrbitDragRunId] = React.useState(0);
  const activeBuildVolumeSettings = view3dSettings ?? DEFAULT_VIEW3D_SETTINGS;

  const buildVolumeCenterTarget = React.useMemo(() => {
    const centerX = activeBuildVolumeSettings.originMode === 'front_left' ? activeBuildVolumeSettings.widthMm * 0.5 : 0;
    const centerY = activeBuildVolumeSettings.originMode === 'front_left' ? activeBuildVolumeSettings.depthMm * 0.5 : 0;
    const centerZ = activeBuildVolumeSettings.maxZMm * 0.5;
    return new THREE.Vector3(centerX, centerY, centerZ);
  }, [
    activeBuildVolumeSettings.depthMm,
    activeBuildVolumeSettings.maxZMm,
    activeBuildVolumeSettings.originMode,
    activeBuildVolumeSettings.widthMm,
  ]);

  const { defaultCamera, orbitTarget, setOrbitTargetFromPoint, introBoundsSnapshot, cameraIntroRunId, cameraHomeResetRunId } =
    useStlLoadCameraIntro(models, buildVolumeCenterTarget, { deferIntro: deferCameraIntro });
  const [cameraIntroCompletedRunId, setCameraIntroCompletedRunId] = React.useState(0);

  const lastHoveredModelPointRef = React.useRef<THREE.Vector3 | null>(null);
  const [hoveredMeshModelId, setHoveredMeshModelId] = React.useState<string | null>(null);
  const hoveredMeshModelIdRef = React.useRef<string | null>(null);
  const hoverModelRafRef = React.useRef<number | null>(null);
  const pendingHoverModelIdRef = React.useRef<string | null>(null);
  const [hoveredRaftModelId, setHoveredRaftModelId] = React.useState<string | null>(null);
  const [hoveredSupportPointerModelId, setHoveredSupportPointerModelId] = React.useState<string | null>(null);
  const hoveredSupportModelIdFromStore = React.useMemo(() => {
    const category = supportStateForBounds.hoveredCategory;
    if (category !== 'support' && category !== 'contactDisk' && category !== 'segment' && category !== 'joint' && category !== 'knot') {
      return null;
    }
    return getModelIdForSupportEntityId(supportStateForBounds.hoveredId);
  }, [supportStateForBounds.hoveredCategory, supportStateForBounds.hoveredId]);
  const hoveredSupportModelId = hoveredSupportPointerModelId ?? hoveredSupportModelIdFromStore;
  const hoveredModelId = React.useMemo(
    () => hoveredMeshModelId ?? hoveredRaftModelId ?? hoveredSupportModelId,
    [hoveredMeshModelId, hoveredRaftModelId, hoveredSupportModelId],
  );
  const onModelHoverPointChange = React.useCallback((point: THREE.Vector3 | null) => {
    lastHoveredModelPointRef.current = point;
  }, []);
  React.useEffect(() => {
    hoveredMeshModelIdRef.current = hoveredMeshModelId;
  }, [hoveredMeshModelId]);

  React.useEffect(() => {
    return () => {
      if (hoverModelRafRef.current !== null) {
        cancelAnimationFrame(hoverModelRafRef.current);
        hoverModelRafRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (!supportGizmoInteractionActive) return;

    pendingHoverModelIdRef.current = null;
    if (hoverModelRafRef.current !== null) {
      cancelAnimationFrame(hoverModelRafRef.current);
      hoverModelRafRef.current = null;
    }

    setHoveredMeshModelId((prev) => (prev === null ? prev : null));
    setHoveredRaftModelId((prev) => (prev === null ? prev : null));
    setHoveredSupportPointerModelId((prev) => (prev === null ? prev : null));
    emitImmediateModelHover(null);
  }, [supportGizmoInteractionActive]);

  const onModelHoverModelChange = React.useCallback((id: string | null) => {
    const nextId = id ?? null;
    pendingHoverModelIdRef.current = nextId;
    if (hoverModelRafRef.current !== null) return;

    hoverModelRafRef.current = requestAnimationFrame(() => {
      hoverModelRafRef.current = null;
      const pending = pendingHoverModelIdRef.current;
      pendingHoverModelIdRef.current = null;
      if (pending === hoveredMeshModelIdRef.current) return;
      setHoveredMeshModelId((prev) => (prev === pending ? prev : pending));
      if (pending) {
        setHoveredRaftModelId((prev) => (prev === null ? prev : null));
        setHoveredSupportPointerModelId((prev) => (prev === null ? prev : null));
      }
    });
  }, []);

  React.useEffect(() => {
    const handleModelPointerHoverImmediate = (event: Event) => {
      const customEvent = event as CustomEvent<{ modelId?: string | null }>;
      const modelId = customEvent.detail?.modelId ?? null;
      onModelHoverModelChange(modelId);
    };

    const handleSupportRaftModelPointerHover = (event: Event) => {
      const customEvent = event as CustomEvent<{ modelId?: string | null; category?: string | null }>;
      const category = customEvent.detail?.category;
      if (category === 'raft') {
        const modelId = customEvent.detail?.modelId ?? null;
        if (modelId) {
          pendingHoverModelIdRef.current = null;
          if (hoverModelRafRef.current !== null) {
            cancelAnimationFrame(hoverModelRafRef.current);
            hoverModelRafRef.current = null;
          }
          setHoveredMeshModelId((prev) => (prev === null ? prev : null));
          setHoveredSupportPointerModelId((prev) => (prev === null ? prev : null));
        }
        if (modelId) {
          setHoveredRaftModelId((prev) => (prev === modelId ? prev : modelId));
        } else {
          setHoveredRaftModelId((prev) => (prev === null ? prev : null));
        }
        return;
      }

      if (category === 'support') {
        const modelId = customEvent.detail?.modelId ?? null;
        if (modelId) {
          pendingHoverModelIdRef.current = null;
          if (hoverModelRafRef.current !== null) {
            cancelAnimationFrame(hoverModelRafRef.current);
            hoverModelRafRef.current = null;
          }
          setHoveredMeshModelId((prev) => (prev === null ? prev : null));
          setHoveredRaftModelId((prev) => (prev === null ? prev : null));
        }
        if (modelId) {
          setHoveredSupportPointerModelId((prev) => (prev === modelId ? prev : modelId));
        } else {
          setHoveredSupportPointerModelId((prev) => (prev === null ? prev : null));
        }
      }
    };

    window.addEventListener('model-pointer-hover-immediate', handleModelPointerHoverImmediate as EventListener);
    window.addEventListener('support-raft-model-pointer-hover', handleSupportRaftModelPointerHover as EventListener);

    return () => {
      window.removeEventListener('model-pointer-hover-immediate', handleModelPointerHoverImmediate as EventListener);
      window.removeEventListener('support-raft-model-pointer-hover', handleSupportRaftModelPointerHover as EventListener);
    };
  }, [onModelHoverModelChange]);


  const selectModelFromPointerHit = React.useCallback((modelId: string | null | undefined) => {
    if (mode !== 'prepare') return;
    if (!modelId || !onActiveModelChange) return;

    onActiveModelChange(modelId);
    window.__modelClickGuardUntil = performance.now() + 48;
    window.dispatchEvent(new CustomEvent('model-clicked', { detail: { modelId } }));
    window.__modelClickedThisFrame = true;
    window.setTimeout(() => {
      window.__modelClickedThisFrame = false;
    }, 0);
  }, [mode, onActiveModelChange]);

  React.useEffect(() => {
    const handleSupportModelPointerSelect = (event: Event) => {
      const customEvent = event as CustomEvent<{ modelId?: string | null }>;
      const modelId = customEvent.detail?.modelId;
      selectModelFromPointerHit(modelId ?? null);
    };

    window.addEventListener('support-model-pointer-select', handleSupportModelPointerSelect as EventListener);

    return () => {
      window.removeEventListener('support-model-pointer-select', handleSupportModelPointerSelect as EventListener);
    };
  }, [selectModelFromPointerHit]);

  const { smoothingBrushState, onSmoothingGeometryActivate } = useMeshSmoothingSceneBindings({
    mode,
    transformMode,
    containerRef,
  });

  const [isCameraBelowBuildPlate, setIsCameraBelowBuildPlate] = React.useState(false);
  const [buildPlateOpacity, setBuildPlateOpacity] = React.useState(1);
  const [outOfBoundsStripeColor, setOutOfBoundsStripeColor] = React.useState<string>('#b6ff2e');
  const hoverTintColor = hoverColor ?? '#ec2a77';
  const selectedTintColor = selectionColor ?? '#ec2a77';

  const computeSupportAndRaftWorldBounds = React.useCallback((modelId: string): THREE.Box3 | null => {
    // During active gizmo drags, keep bounds work minimal to preserve interaction FPS.
    if (isGizmoDragging || isGizmoRetargeting) return null;

    const bounds = new THREE.Box3();
    let hasAny = false;
    const BUILD_PLATE_Z = 0;

    const expandByRadius = (pos: { x: number; y: number; z: number } | THREE.Vector3, radiusMm: number) => {
      const p = pos instanceof THREE.Vector3 ? pos : new THREE.Vector3(pos.x, pos.y, pos.z);
      const r = Math.max(0, radiusMm);
      bounds.expandByPoint(new THREE.Vector3(p.x - r, p.y - r, Math.max(BUILD_PLATE_Z, p.z - r)));
      bounds.expandByPoint(new THREE.Vector3(p.x + r, p.y + r, p.z + r));
      hasAny = true;
    };

    const rootsForModel = Object.values(supportStateForBounds.roots).filter((root) => root.modelId === modelId);
    for (const root of rootsForModel) {
      const rootRadius = Math.max(0.001, root.diameter / 2);
      const rootBase = root.transform.pos;
      const rootTop = {
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        z: root.transform.pos.z + Math.max(0, root.diskHeight) + Math.max(0, root.coneHeight),
      };
      expandByRadius(rootBase, rootRadius);
      expandByRadius(rootTop, rootRadius);
    }

    const modelKnotIds = new Set<string>();
    for (const branch of Object.values(supportStateForBounds.branches)) {
      if (branch.modelId === modelId) modelKnotIds.add(branch.parentKnotId);
    }
    for (const leaf of Object.values(supportStateForBounds.leaves)) {
      if (leaf.modelId === modelId) modelKnotIds.add(leaf.parentKnotId);
    }
    for (const brace of Object.values(supportStateForBounds.braces)) {
      if (brace.modelId !== modelId) continue;
      modelKnotIds.add(brace.startKnotId);
      modelKnotIds.add(brace.endKnotId);
    }
    for (const kickstand of Object.values(kickstandStateForBounds.kickstands)) {
      if (kickstand.modelId === modelId) modelKnotIds.add(kickstand.hostKnotId);
    }

    for (const knotId of modelKnotIds) {
      const knot = supportStateForBounds.knots[knotId] ?? kickstandStateForBounds.knots[knotId];
      if (!knot?.pos) continue;
      expandByRadius(knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2));
    }

    for (const trunk of Object.values(supportStateForBounds.trunks)) {
      if (trunk.modelId !== modelId) continue;
      for (const seg of trunk.segments) {
        if (seg.topJoint?.pos) expandByRadius(seg.topJoint.pos, Math.max(0.001, (seg.topJoint.diameter ?? seg.diameter) / 2));
        if (seg.bottomJoint?.pos) expandByRadius(seg.bottomJoint.pos, Math.max(0.001, (seg.bottomJoint.diameter ?? seg.diameter) / 2));
      }
      if (trunk.contactCone) {
        expandByRadius(trunk.contactCone.pos, Math.max(0.001, trunk.contactCone.profile.contactDiameterMm / 2));
        const socket = getFinalSocketPosition(trunk.contactCone);
        expandByRadius(socket, Math.max(0.001, trunk.contactCone.profile.bodyDiameterMm / 2));
      }
    }

    for (const branch of Object.values(supportStateForBounds.branches)) {
      if (branch.modelId !== modelId) continue;
      for (const seg of branch.segments) {
        if (seg.topJoint?.pos) expandByRadius(seg.topJoint.pos, Math.max(0.001, (seg.topJoint.diameter ?? seg.diameter) / 2));
        if (seg.bottomJoint?.pos) expandByRadius(seg.bottomJoint.pos, Math.max(0.001, (seg.bottomJoint.diameter ?? seg.diameter) / 2));
      }
      if (branch.contactCone) {
        expandByRadius(branch.contactCone.pos, Math.max(0.001, branch.contactCone.profile.contactDiameterMm / 2));
        const socket = getFinalSocketPosition(branch.contactCone);
        expandByRadius(socket, Math.max(0.001, branch.contactCone.profile.bodyDiameterMm / 2));
      }
    }

    for (const leaf of Object.values(supportStateForBounds.leaves)) {
      if (leaf.modelId !== modelId || !leaf.contactCone) continue;
      expandByRadius(leaf.contactCone.pos, Math.max(0.001, leaf.contactCone.profile.contactDiameterMm / 2));
      const socket = getFinalSocketPosition(leaf.contactCone);
      expandByRadius(socket, Math.max(0.001, leaf.contactCone.profile.bodyDiameterMm / 2));
    }

    for (const twig of Object.values(supportStateForBounds.twigs)) {
      if (twig.modelId !== modelId) continue;
      for (const seg of twig.segments) {
        if (seg.topJoint?.pos) expandByRadius(seg.topJoint.pos, Math.max(0.001, (seg.topJoint.diameter ?? seg.diameter) / 2));
        if (seg.bottomJoint?.pos) expandByRadius(seg.bottomJoint.pos, Math.max(0.001, (seg.bottomJoint.diameter ?? seg.diameter) / 2));
      }
      expandByRadius(twig.contactDiskA.pos, Math.max(0.001, twig.contactDiskA.contactDiameterMm / 2));
      expandByRadius(twig.contactDiskB.pos, Math.max(0.001, twig.contactDiskB.contactDiameterMm / 2));
    }

    for (const stick of Object.values(supportStateForBounds.sticks)) {
      if (stick.modelId !== modelId) continue;
      for (const seg of stick.segments) {
        if (seg.topJoint?.pos) expandByRadius(seg.topJoint.pos, Math.max(0.001, (seg.topJoint.diameter ?? seg.diameter) / 2));
        if (seg.bottomJoint?.pos) expandByRadius(seg.bottomJoint.pos, Math.max(0.001, (seg.bottomJoint.diameter ?? seg.diameter) / 2));
      }
      expandByRadius(stick.contactConeA.pos, Math.max(0.001, stick.contactConeA.profile.contactDiameterMm / 2));
      expandByRadius(stick.contactConeB.pos, Math.max(0.001, stick.contactConeB.profile.contactDiameterMm / 2));
      expandByRadius(getFinalSocketPosition(stick.contactConeA), Math.max(0.001, stick.contactConeA.profile.bodyDiameterMm / 2));
      expandByRadius(getFinalSocketPosition(stick.contactConeB), Math.max(0.001, stick.contactConeB.profile.bodyDiameterMm / 2));
    }

    for (const kickstand of Object.values(kickstandStateForBounds.kickstands)) {
      if (kickstand.modelId !== modelId) continue;
      for (const seg of kickstand.segments) {
        if (seg.topJoint?.pos) expandByRadius(seg.topJoint.pos, Math.max(0.001, (seg.topJoint.diameter ?? seg.diameter) / 2));
        if (seg.bottomJoint?.pos) expandByRadius(seg.bottomJoint.pos, Math.max(0.001, (seg.bottomJoint.diameter ?? seg.diameter) / 2));
      }
    }

    if (rootsForModel.length > 0 && raftSettingsForBounds.bottomMode !== 'off') {
      const circles: SupportBaseCircle[] = rootsForModel.map((root) => ({
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        r: root.diameter / 2,
      }));

      const chamferInset = raftSettingsForBounds.bottomMode === 'line'
        ? Math.max(0, raftSettingsForBounds.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettingsForBounds.chamferAngle))))
        : 0;

      const baseProfile = computeFootprint(circles, {
        marginMm: 0.2 + chamferInset,
        samplesPerCircle: 24,
      });

      if (baseProfile && baseProfile.length >= 3) {
        const outerProfile = raftSettingsForBounds.wallEnabled
          ? computeRaftOuterBoundary(baseProfile, raftSettingsForBounds)
          : baseProfile;

        const raftTopZ = raftSettingsForBounds.bottomMode === 'line'
          ? raftSettingsForBounds.lineHeightMm
          : raftSettingsForBounds.thickness;
        const raftMaxZ = raftTopZ + (raftSettingsForBounds.wallEnabled ? raftSettingsForBounds.wallHeight : 0);

        for (const p of outerProfile) {
          expandByRadius({ x: p.x, y: p.y, z: 0 }, 0);
          expandByRadius({ x: p.x, y: p.y, z: raftMaxZ }, 0);
        }
      }
    }

    return hasAny ? bounds : null;
  }, [isGizmoDragging, isGizmoRetargeting, kickstandStateForBounds, raftSettingsForBounds, supportStateForBounds]);

  const computeModelWorldBounds = React.useCallback((
    model: LoadedModel,
    modelTransformOverride?: ModelTransform,
    volumeBounds?: THREE.Box3 | null,
  ) => {
    const t = modelTransformOverride ?? model.transform;

    let meshBounds: THREE.Box3;

    if (shouldUsePreciseBoundsForTransform(t)) {
      meshBounds = computePreciseModelWorldBounds(model.geometry, t);
    } else {
      const approxBounds = computeApproxModelWorldBounds(model.geometry, t);
      if (!volumeBounds) {
        meshBounds = approxBounds;
      } else if (!isBoundsOutsideVolume(approxBounds, volumeBounds, BUILD_VOLUME_BOUNDS_EPS_MM)) {
        meshBounds = approxBounds;
      } else {
        meshBounds = computePreciseModelWorldBounds(model.geometry, t);
      }
    }

    const supportRaftBounds = computeSupportAndRaftWorldBounds(model.id);
    if (!supportRaftBounds) {
      return meshBounds;
    }

    return meshBounds.clone().union(supportRaftBounds);
  }, [BUILD_VOLUME_BOUNDS_EPS_MM, computeSupportAndRaftWorldBounds]);

  const buildVolumeBounds = React.useMemo(() => {
    if (!activeBuildVolumeSettings?.enabled) return null;

    const width = activeBuildVolumeSettings.widthMm;
    const depth = activeBuildVolumeSettings.depthMm;
    const minX = activeBuildVolumeSettings.originMode === 'front_left' ? 0 : -width * 0.5;
    const minY = activeBuildVolumeSettings.originMode === 'front_left' ? 0 : -depth * 0.5;

    const sm = activeBuildVolumeSettings.safetyMarginMm;
    const marginFront = sm?.front ?? 0;
    const marginBack = sm?.back ?? 0;
    const marginLeft = sm?.left ?? 0;
    const marginRight = sm?.right ?? 0;

    return new THREE.Box3(
      new THREE.Vector3(minX + marginLeft, minY + marginFront, 0),
      new THREE.Vector3(minX + width - marginRight, minY + depth - marginBack, activeBuildVolumeSettings.maxZMm),
    );
  }, [activeBuildVolumeSettings]);

  const cachedModelWorldBoundsRef = React.useRef<Map<string, THREE.Box3>>(new Map());
  const activeTransformOverrideModelId = React.useMemo(
    () => (transform ? activeModelId : null),
    [activeModelId, transform],
  );

  const modelWorldBounds = React.useMemo(() => {
    if (isGizmoDragging || isGizmoRetargeting) {
      return cachedModelWorldBoundsRef.current;
    }

    const map = new Map<string, THREE.Box3>();
    for (const model of models) {
      if (!model.visible) continue;
      const effectiveTransform =
        (model.id === activeTransformOverrideModelId && transform)
          ? transform
          : model.transform;
      map.set(model.id, computeModelWorldBounds(model, effectiveTransform, buildVolumeBounds));
    }
    cachedModelWorldBoundsRef.current = map;
    return map;
  }, [activeTransformOverrideModelId, buildVolumeBounds, computeModelWorldBounds, isGizmoDragging, isGizmoRetargeting, models, transform]);

  const crossSectionCapEntries = React.useMemo<CrossSectionStencilCapEntry[]>(() => {
    return models
      .filter((model) => model.visible)
      .map((model) => {
        const bounds = modelWorldBounds.get(model.id);
        const hasBounds = Boolean(bounds && !bounds.isEmpty());

        return {
          id: model.id,
          geometry: model.geometry.geometry,
          center: model.geometry.center,
          transform: model.id === activeModelId && transform
            ? transform
            : model.transform,
          minZ: hasBounds ? bounds!.min.z : undefined,
          maxZ: hasBounds ? bounds!.max.z : undefined,
        };
      });
  }, [activeModelId, modelWorldBounds, models, transform]);

  const outOfBoundsModels = React.useMemo(() => {
    if (!buildVolumeBounds) return [] as Array<{ id: string; name: string; bounds: THREE.Box3 }>;
    if (isGizmoDragging || isGizmoRetargeting || outOfBoundsRotateGraceActive) return [] as Array<{ id: string; name: string; bounds: THREE.Box3 }>;

    return models
      .filter((model) => model.visible)
      .map((model) => {
        const bounds = modelWorldBounds.get(model.id) ?? computeModelWorldBounds(model, model.transform, buildVolumeBounds);
        return {
          id: model.id,
          name: model.name,
          bounds,
        };
      })
      .filter(({ bounds }) => isBoundsOutsideVolume(bounds, buildVolumeBounds, BUILD_VOLUME_BOUNDS_EPS_MM));
  }, [
    BUILD_VOLUME_BOUNDS_EPS_MM,
    buildVolumeBounds,
    computeModelWorldBounds,
    isGizmoDragging,
    isGizmoRetargeting,
    modelWorldBounds,
    models,
    outOfBoundsRotateGraceActive,
  ]);

  const shaderOutOfBoundsBounds = React.useMemo(() => {
    if (!buildVolumeBounds) return null;

    return {
      min: buildVolumeBounds.min.clone().addScalar(-BUILD_VOLUME_BOUNDS_EPS_MM),
      max: buildVolumeBounds.max.clone().addScalar(BUILD_VOLUME_BOUNDS_EPS_MM),
    };
  }, [BUILD_VOLUME_BOUNDS_EPS_MM, buildVolumeBounds]);

  const outOfBoundsModelIds = React.useMemo(() => {
    return new Set(outOfBoundsModels.map((m) => m.id));
  }, [outOfBoundsModels]);

  const activeModelVisualColor = React.useMemo(() => {
    const fallbackColor = meshColor ?? '#a3a3a3';
    if (!colorActiveModelId) return fallbackColor;
    const model = models.find((m) => m.id === colorActiveModelId);
    const isCommittedActive = !!committedActiveModelId && colorActiveModelId === committedActiveModelId;
    if (isCommittedActive) return '#3b82f6';
    return model?.color || fallbackColor;
  }, [colorActiveModelId, committedActiveModelId, meshColor, models]);

  const supportHoverTintColor = React.useMemo(() => {
    if (activeModelId) return '#c8752a';
    if (hoveredModelId) return '#c8752a';
    return '#a3a3a3';
  }, [activeModelId, hoveredModelId]);

  const supportCreationModeActive = Boolean(
    isBranchPlacementActive
    || isLeafPlacementActive
    || isBracePlacementActive
    || isKickstandPlacementActive,
  );
  const suppressSupportSelectionAndHover = mode === 'prepare' && transformMode === 'transform';

  const supportHoverTargetActive = isSupportTargetHoverCategory(supportStateForBounds.hoveredCategory);
  const suppressSupportPlacementPreviewRendering = contactDiskHudInteractionActive || supportHoverTargetActive || sceneHoveredSupportId !== null;

  const queueSupportPlacementGuideZ = React.useCallback((nextZ: number | null) => {
    supportPlacementGuidePendingZRef.current = nextZ;
    if (supportPlacementGuideRafRef.current !== null) return;

    supportPlacementGuideRafRef.current = requestAnimationFrame(() => {
      supportPlacementGuideRafRef.current = null;
      const pendingZ = supportPlacementGuidePendingZRef.current;
      supportPlacementGuidePendingZRef.current = null;
      setSupportPlacementGuideZ((previous) => {
        if (previous === null && pendingZ === null) return previous;
        if (previous !== null && pendingZ !== null && Math.abs(previous - pendingZ) <= 0.02) return previous;
        return pendingZ;
      });
    });
  }, []);

  React.useEffect(() => {
    return () => {
      if (supportPlacementGuideRafRef.current !== null) {
        cancelAnimationFrame(supportPlacementGuideRafRef.current);
        supportPlacementGuideRafRef.current = null;
      }
      supportPlacementGuidePendingZRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (mode === 'support' && !blockSupportPlacement) return;
    queueSupportPlacementGuideZ(null);
  }, [blockSupportPlacement, mode, queueSupportPlacementGuideZ]);

  const handleSupportHover = React.useCallback((hit: THREE.Intersection | null) => {
    if (mode === 'support' && !blockSupportPlacement) {
      const nextZ = hit && Number.isFinite(hit.point.z) ? hit.point.z : null;
      queueSupportPlacementGuideZ(nextZ);
    } else {
      queueSupportPlacementGuideZ(null);
    }

    onSupportHover?.(hit);
  }, [blockSupportPlacement, mode, onSupportHover, queueSupportPlacementGuideZ]);

  const supportPlacementIndicatorPlaneZ = React.useMemo(() => {
    if (mode !== 'support' || blockSupportPlacement) return null;
    if (supportPlacementGuideZ == null || !Number.isFinite(supportPlacementGuideZ)) return null;
    return supportPlacementGuideZ;
  }, [blockSupportPlacement, mode, supportPlacementGuideZ]);

  const supportPlacementGuideLineWidthMm = React.useMemo(() => {
    const toGuideWidthMm = (contactDiameterMm: number) => Math.max(0.01, contactDiameterMm * 0.3);

    const pickPreviewContactDiameterMm = (preview: SupportData | null | undefined): number | null => {
      if (!preview) return null;

      const diameters: number[] = [];

      const pushDiameter = (value: number | null | undefined) => {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return;
        diameters.push(value);
      };

      pushDiameter(preview.contactCone?.profile?.contactDiameterMm);
      preview.contactCones?.forEach((cone) => pushDiameter(cone.profile?.contactDiameterMm));
      preview.contactDisks?.forEach((disk) => pushDiameter(disk.contactDiameterMm));

      if (diameters.length === 0) return null;
      return Math.max(...diameters);
    };

    const orderedPreviews: Array<SupportData | null | undefined> = [];

    if (isBranchPlacementActive) orderedPreviews.push(branchPlacementPreview);
    if (isLeafPlacementActive) orderedPreviews.push(leafPlacementPreview);
    if (isKickstandPlacementActive) orderedPreviews.push(kickstandPlacementPreview);

    orderedPreviews.push(
      trunkPlacementPreview,
      branchPlacementPreview,
      leafPlacementPreview,
      kickstandPlacementPreview,
    );

    for (const preview of orderedPreviews) {
      const diameter = pickPreviewContactDiameterMm(preview);
      if (diameter != null) return toGuideWidthMm(diameter);
    }

    return toGuideWidthMm(supportSettings.tip.contactDiameterMm || DEFAULT_TIP_CONTACT_DIAMETER_MM);
  }, [
    branchPlacementPreview,
    isBranchPlacementActive,
    isKickstandPlacementActive,
    isLeafPlacementActive,
    kickstandPlacementPreview,
    leafPlacementPreview,
    supportSettings.tip.contactDiameterMm,
    trunkPlacementPreview,
  ]);

  const branchHoverDotVisible = Boolean(
    branchHoverPosition
    && !branchTipPosition
    && !branchPlacementPreview
    && !suppressSupportPlacementPreviewRendering
    && !supportHoverTargetActive
    && !!hoveredMeshModelId
    && isBranchPlacementActive,
  );

  const hasRaftSelection = !!committedActiveModelId || !!activeModelId || (selectedModelIds?.length ?? 0) > 0;
  const raftTintEnabled = mode !== 'printing';
  const raftColorized = raftTintEnabled && (mode === 'support' || hasRaftSelection || !!hoveredModelId);
  const raftHoverized = raftTintEnabled && (mode === 'support' || (!hasRaftSelection && !!hoveredModelId));

  const modelBoundingBoxDebugData = React.useMemo(() => {
    if (!activeBuildVolumeSettings.showModelBoundingBoxes) return [] as Array<{
      id: string;
      positions: Float32Array;
      color: string;
    }>;

    return models
      .filter((model) => model.visible)
      .map((model) => {
        const effectiveTransform =
          (model.id === activeTransformOverrideModelId && transform)
            ? transform
            : model.transform;
        const bounds = modelWorldBounds.get(model.id) ?? computeModelWorldBounds(model, effectiveTransform, buildVolumeBounds);
        return {
          id: model.id,
          positions: buildBoxWireframePositions(bounds),
          color: outOfBoundsModelIds.has(model.id) ? '#ff5b6f' : '#5aaeff',
        };
      });
  }, [activeBuildVolumeSettings.showModelBoundingBoxes, activeTransformOverrideModelId, computeModelWorldBounds, modelWorldBounds, models, outOfBoundsModelIds, transform]);

  const buildVolumeBoxGeometry = React.useMemo(() => {
    if (!activeBuildVolumeSettings?.enabled || !buildVolumeBounds) return null;

    const geometry = new THREE.BoxGeometry(
      buildVolumeBounds.max.x - buildVolumeBounds.min.x,
      buildVolumeBounds.max.y - buildVolumeBounds.min.y,
      activeBuildVolumeSettings.maxZMm,
    );
    return geometry;
  }, [activeBuildVolumeSettings, buildVolumeBounds]);

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

    const resolveOutOfBoundsStripeColor = () => {
      const rootStyles = getComputedStyle(document.documentElement);
      const accentSecondary = rootStyles.getPropertyValue('--accent-secondary').trim();

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

    resolveOutOfBoundsStripeColor();

    const observer = new MutationObserver(resolveOutOfBoundsStripeColor);
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

  const isActiveGizmoZMove = activeGizmoDragDescriptor?.operation === 'move'
    && activeGizmoDragDescriptor.axis === 'z';

  const activeModelVisualSupportTransform = React.useMemo(() => {
    if (!activeModelId) return null;
    if (duplicateActivePreviewTransform) return duplicateActivePreviewTransform;

    if (transformMode === 'transform' && (isGizmoDragging || effectiveHoldSupportDragDelta) && transform) {
      return transform;
    }

    if (transformMode === 'arrange' && transform) {
      return transform;
    }

    return null;
  }, [
    activeModelId,
    duplicateActivePreviewTransform,
    effectiveHoldSupportDragDelta,
    isGizmoDragging,
    transform,
    transformMode,
  ]);

  const useActiveModelAttachedSupportProxy = React.useMemo(() => {
    if (mode !== 'prepare' || !activeModelId || !activeModelVisualSupportTransform) return false;

    // During live gizmo interaction, force active-model support attachment so
    // global support batching doesn't get dragged as a single cloud.
    if (
      transformMode === 'transform'
      && (
        isGizmoDragging
        || isGizmoRetargeting
        || isPostGizmoInteractionGuardActive
        || effectiveHoldSupportDragDelta
      )
    ) {
      return true;
    }

    const committedTransform = modelById.get(activeModelId)?.transform;
    if (!committedTransform) return false;

    const EPSILON = 1e-6;
    const posChanged = committedTransform.position.distanceToSquared(activeModelVisualSupportTransform.position) > EPSILON;
    const scaleChanged = committedTransform.scale.distanceToSquared(activeModelVisualSupportTransform.scale) > EPSILON;
    const rotChanged =
      Math.abs(committedTransform.rotation.x - activeModelVisualSupportTransform.rotation.x) > EPSILON
      || Math.abs(committedTransform.rotation.y - activeModelVisualSupportTransform.rotation.y) > EPSILON
      || Math.abs(committedTransform.rotation.z - activeModelVisualSupportTransform.rotation.z) > EPSILON;

    return posChanged || scaleChanged || rotChanged;
  }, [
    activeModelId,
    activeModelVisualSupportTransform,
    effectiveHoldSupportDragDelta,
    isGizmoDragging,
    isGizmoRetargeting,
    isPostGizmoInteractionGuardActive,
    mode,
    modelById,
    transformMode,
  ]);

  const activeModelAttachedSupportLocalMatrix = React.useMemo(() => {
    if (!useActiveModelAttachedSupportProxy || !activeModelId) return null;

    const committedModel = models.find((model) => model.id === activeModelId);
    if (!committedModel) return null;

    const committedTransform = committedModel.transform;
    return new THREE.Matrix4()
      .compose(
        committedTransform.position,
        quaternionFromGlobalEuler(committedTransform.rotation),
        committedTransform.scale,
      )
      .invert();
  }, [activeModelId, models, useActiveModelAttachedSupportProxy]);

  // --- Support drag group helpers (must be after activeModel/activeGroupRef) ---
  const captureGizmoDragBeforeMatrix = React.useCallback(() => {
    const source = transform ?? activeModel?.transform;
    if (!source) return;
    gizmoDragBeforeMatrixRef.current = new THREE.Matrix4().compose(
      source.position,
      quaternionFromGlobalEuler(source.rotation),
      source.scale,
    );
  }, [activeModel?.transform, transform]);

  const applySupportGroupDelta = React.useCallback(() => {
    const beforeMat = gizmoDragBeforeMatrixRef.current;
    const group = activeGroupRef.current;
    const dragGroup = supportDragGroupRef?.current;
    if (!beforeMat || !group || !dragGroup) return;

    if (isActiveGizmoZMove) {
      dragGroup.matrix.identity();
      dragGroup.matrixAutoUpdate = true;
      return;
    }

    const logicalPosition = _dragWorkPosition.current.copy(group.position);
    const modelDropOffsetZ = activeModelId ? (modelDropOffsetsRef.current[activeModelId] ?? 0) : 0;
    if (mode === 'prepare' && modelDropOffsetZ > 0.0001) {
      logicalPosition.z -= modelDropOffsetZ;
    }

    const cur = _dragWorkCurrent.current.compose(logicalPosition, group.quaternion, group.scale);
    const inv = _dragWorkInvBefore.current.copy(beforeMat).invert();
    // delta = currentMatrix * inverse(beforeMatrix)
    dragGroup.matrix.multiplyMatrices(cur, inv);
    dragGroup.matrixAutoUpdate = false;
  }, [activeGroupRef, activeModelId, isActiveGizmoZMove, mode, supportDragGroupRef]);

  const composeModelTransformMatrix = React.useCallback((t: ModelTransform) => {
    return new THREE.Matrix4().compose(
      t.position,
      quaternionFromGlobalEuler(t.rotation),
      t.scale,
    );
  }, []);

  const matricesApproximatelyEqual = React.useCallback((a: THREE.Matrix4, b: THREE.Matrix4, epsilon = 1e-6) => {
    const ae = a.elements;
    const be = b.elements;
    for (let i = 0; i < 16; i += 1) {
      if (Math.abs(ae[i] - be[i]) > epsilon) return false;
    }
    return true;
  }, []);

  React.useEffect(() => {
    // During active gizmo drags, `applySupportGroupDelta` owns this matrix.
    if (isGizmoDragging) return;

    const dragGroup = supportDragGroupRef?.current;
    if (!dragGroup) return;

    if (isActiveGizmoZMove) {
      if (!dragGroup.matrixAutoUpdate) {
        dragGroup.matrix.identity();
        dragGroup.matrixAutoUpdate = true;
      }
      return;
    }

    if (mode !== 'prepare' || transformMode !== 'transform' || !activeModelId || !transform) {
      if (!dragGroup.matrixAutoUpdate) {
        dragGroup.matrix.identity();
        dragGroup.matrixAutoUpdate = true;
      }
      return;
    }

    // Outside the explicit post-drag hold window we should never keep a
    // reconciliation delta alive, otherwise stale support clouds can persist
    // while selection remains active.
    if (!effectiveHoldSupportDragDelta) {
      if (!dragGroup.matrixAutoUpdate) {
        dragGroup.matrix.identity();
        dragGroup.matrixAutoUpdate = true;
      }
      return;
    }

    const committedModel = models.find((model) => model.id === activeModelId);
    if (!committedModel) return;

    const committedMatrix = composeModelTransformMatrix(committedModel.transform);
    const liveMatrix = composeModelTransformMatrix(transform);

    if (matricesApproximatelyEqual(committedMatrix, liveMatrix)) {
      if (!dragGroup.matrixAutoUpdate) {
        dragGroup.matrix.identity();
        dragGroup.matrixAutoUpdate = true;
      }
      return;
    }

    const delta = new THREE.Matrix4().multiplyMatrices(liveMatrix, committedMatrix.clone().invert());
    dragGroup.matrix.copy(delta);
    dragGroup.matrixAutoUpdate = false;
  }, [
    activeModelId,
    isActiveGizmoZMove,
    composeModelTransformMatrix,
    isGizmoDragging,
    matricesApproximatelyEqual,
    mode,
    transformMode,
    models,
    supportDragGroupRef,
    effectiveHoldSupportDragDelta,
    transform,
  ]);

  const selectedModelIdSet = React.useMemo(() => {
    return new Set(selectedModelIds ?? []);
  }, [selectedModelIds]);

  const emptySelectedModelIds = React.useMemo<string[]>(() => [], []);
  const emptyModelDropOffsets = React.useMemo<Record<string, number>>(() => ({}), []);
  const emptyHeatmapColors = React.useMemo<string[]>(() => [], []);

  const selectedTransformableModelIds = React.useMemo(() => {
    const allIds = selectedModelIds ?? [];
    const existingIds = allIds.filter((id) => models.some((model) => model.id === id));
    if (activeModelId && existingIds.includes(activeModelId)) {
      return existingIds;
    }
    if (activeModelId) {
      return [activeModelId, ...existingIds.filter((id) => id !== activeModelId)];
    }
    return existingIds;
  }, [activeModelId, models, selectedModelIds]);

  const isMultiGizmoSelection = selectedTransformableModelIds.length > 1;

  const liveActiveTransformForMultiPreview = React.useMemo(() => {
    const liveDragTransform = liveDragTransformRef.current;
    if (isGizmoDragging && liveDragTransform) {
      return liveDragTransform;
    }
    return transform ?? null;
  }, [isGizmoDragging, transform]);

  const buildMultiSelectionTransformsFromActive = React.useCallback((
    snapshot: {
      operation: 'move' | 'scale';
      activeModelId: string;
      pivot: THREE.Vector3;
      beforeByModelId: Record<string, ModelTransform>;
    },
    activeAfter: ModelTransform,
  ) => {
    const activeBefore = snapshot.beforeByModelId[snapshot.activeModelId];
    if (!activeBefore) return {} as Record<string, ModelTransform>;

    const result: Record<string, ModelTransform> = {};

    if (snapshot.operation === 'move') {
      const delta = activeAfter.position.clone().sub(activeBefore.position);
      for (const [modelId, before] of Object.entries(snapshot.beforeByModelId)) {
        result[modelId] = {
          position: before.position.clone().add(delta),
          rotation: before.rotation.clone(),
          scale: before.scale.clone(),
        };
      }
      return result;
    }

    const safeRatio = (current: number, baseline: number) => {
      if (Math.abs(baseline) <= 1e-8) return 1;
      const ratio = current / baseline;
      return Number.isFinite(ratio) ? ratio : 1;
    };

    const ratio = new THREE.Vector3(
      safeRatio(activeAfter.scale.x, activeBefore.scale.x),
      safeRatio(activeAfter.scale.y, activeBefore.scale.y),
      safeRatio(activeAfter.scale.z, activeBefore.scale.z),
    );
    const pivot = snapshot.pivot;

    for (const [modelId, before] of Object.entries(snapshot.beforeByModelId)) {
      const offset = before.position.clone().sub(pivot);
      offset.set(offset.x * ratio.x, offset.y * ratio.y, offset.z * ratio.z);

      result[modelId] = {
        position: pivot.clone().add(offset),
        rotation: before.rotation.clone(),
        scale: new THREE.Vector3(
          before.scale.x * ratio.x,
          before.scale.y * ratio.y,
          before.scale.z * ratio.z,
        ),
      };
    }

    return result;
  }, []);

  const multiGizmoPreviewTransformsById = React.useMemo(() => {
    const snapshot = gizmoGroupStartSnapshot;
    if (!snapshot) return {} as Record<string, ModelTransform>;
    if (!isGizmoDragging) return {} as Record<string, ModelTransform>;
    if (!liveActiveTransformForMultiPreview) return {} as Record<string, ModelTransform>;
    if (!isMultiGizmoSelection) return {} as Record<string, ModelTransform>;

    return buildMultiSelectionTransformsFromActive(snapshot, liveActiveTransformForMultiPreview);
  }, [
    buildMultiSelectionTransformsFromActive,
    gizmoGroupStartSnapshot,
    isGizmoDragging,
    isMultiGizmoSelection,
    liveActiveTransformForMultiPreview,
  ]);

  const multiGizmoSupportPreviewIds = React.useMemo(() => {
    if (!isMultiGizmoSelection || !isGizmoDragging || !activeModelId) return [] as string[];
    return selectedTransformableModelIds.filter((id) => id !== activeModelId && !!multiGizmoPreviewTransformsById[id]);
  }, [activeModelId, isGizmoDragging, isMultiGizmoSelection, multiGizmoPreviewTransformsById, selectedTransformableModelIds]);

  const multiGizmoSupportPreviewDeltas = React.useMemo(() => {
    const snapshot = gizmoGroupStartSnapshot;
    if (!snapshot) return [] as Array<{ modelId: string; delta: THREE.Matrix4 }>;

    const deltas: Array<{ modelId: string; delta: THREE.Matrix4 }> = [];
    for (const modelId of multiGizmoSupportPreviewIds) {
      const before = snapshot.beforeByModelId[modelId];
      const after = multiGizmoPreviewTransformsById[modelId];
      if (!before || !after) continue;

      const beforeMatrix = composeModelTransformMatrix(before);
      const afterMatrix = composeModelTransformMatrix(after);
      const delta = new THREE.Matrix4().multiplyMatrices(afterMatrix, beforeMatrix.clone().invert());
      deltas.push({ modelId, delta });
    }

    return deltas;
  }, [composeModelTransformMatrix, gizmoGroupStartSnapshot, multiGizmoPreviewTransformsById, multiGizmoSupportPreviewIds]);

  const multiGizmoSupportPreviewGroupRefs = React.useRef<Record<string, THREE.Group | null>>({});
  const multiGizmoAnchorRef = React.useRef<THREE.Group | null>(null);

  const computeCenterFromTransforms = React.useCallback((byModelId: Record<string, ModelTransform>) => {
    const ids = selectedTransformableModelIds;
    if (ids.length === 0) return null;

    const sum = new THREE.Vector3();
    let count = 0;
    for (const modelId of ids) {
      const t = byModelId[modelId];
      if (!t) continue;
      sum.add(t.position);
      count += 1;
    }
    if (count === 0) return null;
    return sum.multiplyScalar(1 / count);
  }, [selectedTransformableModelIds]);

  const setMultiGizmoAnchorPosition = React.useCallback((position: THREE.Vector3 | null) => {
    const anchor = multiGizmoAnchorRef.current;
    if (!anchor || !position) return;
    anchor.position.copy(position);
    anchor.updateMatrix();
    anchor.updateMatrixWorld(true);
  }, []);

  const applyImmediateMultiPreview = React.useCallback((
    snapshot: {
      operation: 'move' | 'scale';
      activeModelId: string;
      pivot: THREE.Vector3;
      beforeByModelId: Record<string, ModelTransform>;
    },
    previewByModelId: Record<string, ModelTransform>,
  ) => {
    for (const [modelId, preview] of Object.entries(previewByModelId)) {
      if (modelId === snapshot.activeModelId) continue;

      const meshGroup = meshRefs.current[modelId];
      if (meshGroup) {
        meshGroup.position.copy(preview.position);
        meshGroup.quaternion.copy(quaternionFromGlobalEuler(preview.rotation));
        meshGroup.scale.copy(preview.scale);
        meshGroup.updateMatrix();
        meshGroup.updateMatrixWorld(true);
      }

      const supportGroup = multiGizmoSupportPreviewGroupRefs.current[modelId];
      const before = snapshot.beforeByModelId[modelId];
      if (supportGroup && before) {
        const beforeMatrix = composeModelTransformMatrix(before);
        const afterMatrix = composeModelTransformMatrix(preview);
        supportGroup.matrix.multiplyMatrices(afterMatrix, beforeMatrix.clone().invert());
        supportGroup.matrixAutoUpdate = false;
        supportGroup.matrixWorldNeedsUpdate = true;
      }
    }
  }, [composeModelTransformMatrix]);

  const supportProxyExcludeModelIds = React.useMemo(() => {
    const ids = [...multiGizmoSupportPreviewIds];
    if (activeModelId) ids.push(activeModelId);
    return Array.from(new Set(ids));
  }, [activeModelId, multiGizmoSupportPreviewIds]);

  const resolveMarqueeSelectedIds = React.useCallback((selection: {
    start: { x: number; y: number };
    current: { x: number; y: number };
  }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const camera = cameraRef.current;
    if (!rect || !camera) return [] as string[];

    const minX = Math.min(selection.start.x, selection.current.x);
    const maxX = Math.max(selection.start.x, selection.current.x);
    const minY = Math.min(selection.start.y, selection.current.y);
    const maxY = Math.max(selection.start.y, selection.current.y);

    const projected = new THREE.Vector3();
    const selectedIds: string[] = [];

    for (const model of models) {
      if (!model.visible) continue;

      const bounds = modelWorldBounds.get(model.id) ?? computeModelWorldBounds(model, model.transform, buildVolumeBounds);
      if (bounds.isEmpty()) continue;

      projected.copy(bounds.getCenter(new THREE.Vector3()));
      projected.project(camera);

      if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || !Number.isFinite(projected.z)) {
        continue;
      }

      // Skip centers outside clip space.
      if (projected.z < -1 || projected.z > 1) continue;

      const sx = ((projected.x + 1) * 0.5) * rect.width;
      const sy = ((1 - projected.y) * 0.5) * rect.height;

      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        selectedIds.push(model.id);
      }
    }

    return selectedIds;
  }, [buildVolumeBounds, computeModelWorldBounds, modelWorldBounds, models]);

  const resolveMarqueeSelectedSupportIds = React.useCallback((selection: {
    start: { x: number; y: number };
    current: { x: number; y: number };
  }) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const camera = cameraRef.current;
    if (!rect || !camera) return [] as string[];

    const minX = Math.min(selection.start.x, selection.current.x);
    const maxX = Math.max(selection.start.x, selection.current.x);
    const minY = Math.min(selection.start.y, selection.current.y);
    const maxY = Math.max(selection.start.y, selection.current.y);

    const point = new THREE.Vector3();
    const projected = new THREE.Vector3();
    const selectedSupportIds: string[] = [];

    const pushIfProjectedInside = (id: string, points: Array<{ x: number; y: number; z: number }>) => {
      if (!id || points.length === 0) return;

      point.set(0, 0, 0);
      for (const p of points) {
        point.x += p.x;
        point.y += p.y;
        point.z += p.z;
      }

      point.multiplyScalar(1 / points.length);
      projected.copy(point).project(camera);

      if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y) || !Number.isFinite(projected.z)) {
        return;
      }
      if (projected.z < -1 || projected.z > 1) return;

      const sx = ((projected.x + 1) * 0.5) * rect.width;
      const sy = ((1 - projected.y) * 0.5) * rect.height;
      if (sx >= minX && sx <= maxX && sy >= minY && sy <= maxY) {
        selectedSupportIds.push(id);
      }
    };

    const segmentPoints = (segments: Array<{
      topJoint?: { pos?: { x: number; y: number; z: number } };
      bottomJoint?: { pos?: { x: number; y: number; z: number } };
    }>) => {
      const points: Array<{ x: number; y: number; z: number }> = [];
      for (const segment of segments) {
        const top = segment.topJoint?.pos;
        const bottom = segment.bottomJoint?.pos;
        if (top) points.push(top);
        if (bottom) points.push(bottom);
      }
      return points;
    };

    for (const root of Object.values(supportStateForBounds.roots)) {
      pushIfProjectedInside(root.id, [root.transform.pos]);
    }

    for (const trunk of Object.values(supportStateForBounds.trunks)) {
      const points = segmentPoints(trunk.segments);
      if (trunk.contactCone) {
        points.push(trunk.contactCone.pos);
        points.push(getFinalSocketPosition(trunk.contactCone));
      }
      pushIfProjectedInside(trunk.id, points);
    }

    for (const branch of Object.values(supportStateForBounds.branches)) {
      const points = segmentPoints(branch.segments);
      if (branch.contactCone) {
        points.push(branch.contactCone.pos);
        points.push(getFinalSocketPosition(branch.contactCone));
      }
      pushIfProjectedInside(branch.id, points);
    }

    for (const leaf of Object.values(supportStateForBounds.leaves)) {
      if (!leaf.contactCone) continue;
      pushIfProjectedInside(leaf.id, [leaf.contactCone.pos, getFinalSocketPosition(leaf.contactCone)]);
    }

    for (const twig of Object.values(supportStateForBounds.twigs)) {
      const points = segmentPoints(twig.segments);
      points.push(twig.contactDiskA.pos, twig.contactDiskB.pos);
      pushIfProjectedInside(twig.id, points);
    }

    for (const stick of Object.values(supportStateForBounds.sticks)) {
      const points = segmentPoints(stick.segments);
      points.push(stick.contactConeA.pos, stick.contactConeB.pos);
      points.push(getFinalSocketPosition(stick.contactConeA), getFinalSocketPosition(stick.contactConeB));
      pushIfProjectedInside(stick.id, points);
    }

    for (const brace of Object.values(supportStateForBounds.braces)) {
      const startKnot = supportStateForBounds.knots[brace.startKnotId];
      const endKnot = supportStateForBounds.knots[brace.endKnotId];
      const points: Array<{ x: number; y: number; z: number }> = [];
      if (startKnot?.pos) points.push(startKnot.pos);
      if (endKnot?.pos) points.push(endKnot.pos);
      pushIfProjectedInside(brace.id, points);
    }

    for (const anchor of Object.values(supportStateForBounds.anchors)) {
      const points: Array<{ x: number; y: number; z: number }> = [anchor.rootPos];
      if (anchor.contactCone) {
        points.push(anchor.contactCone.pos);
      }
      pushIfProjectedInside(anchor.id, points);
    }

    for (const kickstand of Object.values(kickstandStateForBounds.kickstands)) {
      const points = segmentPoints(kickstand.segments);
      pushIfProjectedInside(kickstand.id, points);
    }

    return selectedSupportIds;
  }, [kickstandStateForBounds.kickstands, supportStateForBounds]);

  const {
    marqueeSelection,
    isMarqueeSelecting,
    handleMarqueePointerDownCapture,
    handleMarqueePointerMoveCapture,
    endMarqueeSelection,
  } = useMarqueeSelectionHandlers({
    containerRef,
    interactionResetToken: interactionResetNonce,
    mode,
    isGizmoDragging,
    isPostGizmoInteractionGuardActive,
    hoveredModelId,
    supportHoveredCategory: supportStateForBounds.hoveredCategory,
    onActiveModelChange,
    activeModelId,
    selectedModelIds,
    isOrbitInteracting,
    spaceMouseNavigationActive,
    onMarqueeSelectionChange,
    resolveMarqueeSelectedIds,
    resolveMarqueeSelectedSupportIds,
    suppressNextCanvasClickRef,
  });

  const marqueeCandidateIdSet = React.useMemo(() => {
    if (!marqueeSelection || mode !== 'prepare') return new Set<string>();

    const dragDx = marqueeSelection.current.x - marqueeSelection.start.x;
    const dragDy = marqueeSelection.current.y - marqueeSelection.start.y;
    const dragDistanceSq = (dragDx * dragDx) + (dragDy * dragDy);
    if (dragDistanceSq < 16) return new Set<string>();

    return new Set(resolveMarqueeSelectedIds(marqueeSelection));
  }, [marqueeSelection, mode, resolveMarqueeSelectedIds]);

  const supportMarqueeCandidateIdSet = React.useMemo(() => {
    if (!marqueeSelection || mode !== 'support') return new Set<string>();

    const dragDx = marqueeSelection.current.x - marqueeSelection.start.x;
    const dragDy = marqueeSelection.current.y - marqueeSelection.start.y;
    const dragDistanceSq = (dragDx * dragDx) + (dragDy * dragDy);
    if (dragDistanceSq < 16) return new Set<string>();

    return new Set(resolveMarqueeSelectedSupportIds(marqueeSelection));
  }, [marqueeSelection, mode, resolveMarqueeSelectedSupportIds]);

  React.useEffect(() => {
    if (mode !== 'support' || !isMarqueeSelecting) {
      window.dispatchEvent(new CustomEvent('support-marquee-hover', {
        detail: { supportId: null, supportIds: [], modelId: null },
      }));
      return;
    }

    const supportIds = Array.from(supportMarqueeCandidateIdSet);
    const firstSupportId = supportIds[0] ?? null;
    window.dispatchEvent(new CustomEvent('support-marquee-hover', {
      detail: { supportId: firstSupportId, supportIds, modelId: null },
    }));
  }, [isMarqueeSelecting, mode, supportMarqueeCandidateIdSet]);

  const duplicatePreviewMeshOffset = React.useMemo(() => {
    if (!duplicatePreviewModel) return null;
    return new THREE.Vector3(
      -duplicatePreviewModel.geometry.center.x,
      -duplicatePreviewModel.geometry.center.y,
      -duplicatePreviewModel.geometry.center.z,
    );
  }, [duplicatePreviewModel]);

  const effectiveDuplicatePreviewTransforms = React.useMemo(() => {
    if (!duplicatePreviewTransforms || duplicatePreviewTransforms.length === 0) {
      return [] as Array<{ position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 }>;
    }

    if (!duplicateActivePreviewTransform) {
      return duplicatePreviewTransforms;
    }

    const source = duplicateActivePreviewTransform;
    const EPSILON = 1e-5;

    return duplicatePreviewTransforms.filter((candidate) => {
      const posMatch = candidate.position.distanceToSquared(source.position) <= EPSILON;
      const rotMatch =
        Math.abs(candidate.rotation.x - source.rotation.x) <= EPSILON
        && Math.abs(candidate.rotation.y - source.rotation.y) <= EPSILON
        && Math.abs(candidate.rotation.z - source.rotation.z) <= EPSILON;
      const scaleMatch = candidate.scale.distanceToSquared(source.scale) <= EPSILON;
      return !(posMatch && rotMatch && scaleMatch);
    });
  }, [duplicateActivePreviewTransform, duplicatePreviewTransforms]);

  const duplicateSupportPreviewDeltas = React.useMemo(() => {
    if (!duplicatePreviewModel || effectiveDuplicatePreviewTransforms.length === 0) {
      return [] as THREE.Matrix4[];
    }

    const sourceMatrix = new THREE.Matrix4().compose(
      duplicatePreviewModel.transform.position,
      quaternionFromGlobalEuler(duplicatePreviewModel.transform.rotation),
      duplicatePreviewModel.transform.scale,
    );
    const invSource = sourceMatrix.clone().invert();

    return effectiveDuplicatePreviewTransforms.map((previewTransform) => {
      const targetMatrix = new THREE.Matrix4().compose(
        previewTransform.position,
        quaternionFromGlobalEuler(previewTransform.rotation),
        previewTransform.scale,
      );
      return targetMatrix.multiply(invSource.clone());
    });
  }, [duplicatePreviewModel, effectiveDuplicatePreviewTransforms]);

  const duplicateActiveSupportPreviewDelta = React.useMemo(() => {
    if (!duplicatePreviewModel || !duplicateActivePreviewTransform) return null;

    const oldSourceTransform = duplicatePreviewModel.transform;
    const targetSourceTransform = duplicateActivePreviewTransform;

    let sourceSupportAnchor: THREE.Vector3 | null = null;
    let sourceSupportAnchorCount = 0;

    for (const root of Object.values(supportStateForBounds.roots)) {
      if (root.modelId !== duplicatePreviewModel.id) continue;
      if (!sourceSupportAnchor) sourceSupportAnchor = new THREE.Vector3();
      sourceSupportAnchor.add(root.transform.pos);
      sourceSupportAnchorCount += 1;
    }

    for (const root of Object.values(kickstandStateForBounds.roots)) {
      if (root.modelId !== duplicatePreviewModel.id) continue;
      if (!sourceSupportAnchor) sourceSupportAnchor = new THREE.Vector3();
      sourceSupportAnchor.add(root.transform.pos);
      sourceSupportAnchorCount += 1;
    }

    if (sourceSupportAnchor && sourceSupportAnchorCount > 0) {
      sourceSupportAnchor.multiplyScalar(1 / sourceSupportAnchorCount);
    }

    const sourceToTarget = targetSourceTransform.position.clone().sub(oldSourceTransform.position);
    const sourceToTargetLenSq = sourceToTarget.lengthSq();

    let supportBasisTransform = oldSourceTransform;
    if (sourceSupportAnchor && sourceToTargetLenSq > 1e-8) {
      const anchorProgress = sourceSupportAnchor.clone().sub(oldSourceTransform.position).dot(sourceToTarget) / sourceToTargetLenSq;
      // If source supports are already at least halfway to the target slot,
      // treat them as committed and avoid applying the offset twice.
      if (anchorProgress >= 0.5) {
        supportBasisTransform = targetSourceTransform;
      }
    } else {
      const sourceModelFromStore = modelById.get(duplicatePreviewModel.id);
      if (sourceModelFromStore?.transform) {
        supportBasisTransform = sourceModelFromStore.transform;
      }
    }

    const sourceMatrix = new THREE.Matrix4().compose(
      supportBasisTransform.position,
      quaternionFromGlobalEuler(supportBasisTransform.rotation),
      supportBasisTransform.scale,
    );
    const targetMatrix = new THREE.Matrix4().compose(
      targetSourceTransform.position,
      quaternionFromGlobalEuler(targetSourceTransform.rotation),
      targetSourceTransform.scale,
    );

    return targetMatrix.multiply(sourceMatrix.clone().invert());
  }, [duplicateActivePreviewTransform, duplicatePreviewModel, kickstandStateForBounds.roots, modelById, supportStateForBounds.roots]);

  const duplicateSourceSupportPreviewModelId = React.useMemo(() => {
    if (!hideDuplicateSourceDuringApply) return null;
    if (!duplicatePreviewModel || !duplicateActiveSupportPreviewDelta) return null;
    return duplicatePreviewModel.id;
  }, [duplicateActiveSupportPreviewDelta, duplicatePreviewModel, hideDuplicateSourceDuringApply]);

  const arrangeSupportPreviewDeltas = React.useMemo(() => {
    if (!arrangeArrayPreviewItems || arrangeArrayPreviewItems.length === 0) {
      return [] as Array<{ modelId: string; delta: THREE.Matrix4 }>;
    }

    return arrangeArrayPreviewItems.map((item) => {
      const sourceTransform = (
        activeModelId
        && transform
        && item.model.id === activeModelId
      )
        ? transform
        : item.model.transform;

      const sourceMatrix = new THREE.Matrix4().compose(
        sourceTransform.position,
        quaternionFromGlobalEuler(sourceTransform.rotation),
        sourceTransform.scale,
      );

      const targetMatrix = new THREE.Matrix4().compose(
        item.transform.position,
        quaternionFromGlobalEuler(item.transform.rotation),
        item.transform.scale,
      );

      return {
        modelId: item.model.id,
        delta: targetMatrix.multiply(sourceMatrix.clone().invert()),
      };
    }).filter(({ modelId }) => !(useActiveModelAttachedSupportProxy && !!activeModelId && modelId === activeModelId));
  }, [activeModelId, arrangeArrayPreviewItems, transform, useActiveModelAttachedSupportProxy]);

  const SUPPORT_GHOST_PROXY_SIMPLIFY_THRESHOLD = 6;

  const supportGhostPreviewLayerCount = React.useMemo(() => {
    return duplicateSupportPreviewDeltas.length + arrangeSupportPreviewDeltas.length + (duplicateSourceSupportPreviewModelId ? 1 : 0);
  }, [arrangeSupportPreviewDeltas.length, duplicateSourceSupportPreviewModelId, duplicateSupportPreviewDeltas.length]);

  const renderSupportGhostPreviews = supportGhostPreviewLayerCount > 0;
  const useSimplifiedSupportGhostProxy = supportGhostPreviewLayerCount > SUPPORT_GHOST_PROXY_SIMPLIFY_THRESHOLD;

  const renderDuplicateSourceSupportGhostPreview = !!duplicateSourceSupportPreviewModelId && !!duplicateActiveSupportPreviewDelta;

  const arrangeSupportPreviewModelIds = React.useMemo(() => {
    if (!arrangeArrayPreviewItems || arrangeArrayPreviewItems.length === 0) return [] as string[];
    return Array.from(new Set(arrangeArrayPreviewItems.map((item) => item.model.id)));
  }, [arrangeArrayPreviewItems]);

  const arrangeArraySourceModelIdSet = React.useMemo(() => {
    if (!arrangeArrayPreviewItems || arrangeArrayPreviewItems.length === 0) return new Set<string>();
    return new Set(arrangeArrayPreviewItems.map((item) => item.model.id));
  }, [arrangeArrayPreviewItems]);

  const supportBaseExcludeModelIds = React.useMemo(() => {
    const ids = [...multiGizmoSupportPreviewIds];
    if (arrangeSupportPreviewModelIds.length > 0) {
      ids.push(...arrangeSupportPreviewModelIds);
    }
    if (renderDuplicateSourceSupportGhostPreview && duplicateSourceSupportPreviewModelId) {
      ids.push(duplicateSourceSupportPreviewModelId);
    }
    if (useActiveModelAttachedSupportProxy && activeModelId) ids.push(activeModelId);
    return Array.from(new Set(ids));
  }, [
    activeModelId,
    arrangeSupportPreviewModelIds,
    duplicateSourceSupportPreviewModelId,
    multiGizmoSupportPreviewIds,
    renderDuplicateSourceSupportGhostPreview,
    useActiveModelAttachedSupportProxy,
  ]);

  const arrangeGhostPreviewGroups = React.useMemo(() => {
    if (!arrangeArrayPreviewItems || arrangeArrayPreviewItems.length === 0) {
      return [] as Array<{ model: LoadedModel; transforms: GhostPreviewTransform[] }>;
    }

    const groups = new Map<string, { model: LoadedModel; transforms: GhostPreviewTransform[] }>();
    for (const item of arrangeArrayPreviewItems) {
      const existing = groups.get(item.model.id);
      if (existing) {
        existing.transforms.push(item.transform);
      } else {
        groups.set(item.model.id, {
          model: item.model,
          transforms: [item.transform],
        });
      }
    }

    return Array.from(groups.values());
  }, [arrangeArrayPreviewItems]);

  const hideFootprintOutlineForPreview = React.useMemo(() => {
    if (mode !== 'prepare' || transformMode !== 'arrange') return false;

    const hasArrangePreview = arrangeGhostPreviewGroups.length > 0 || arrangeSupportPreviewDeltas.length > 0;
    const hasDuplicatePreview = effectiveDuplicatePreviewTransforms.length > 0 || !!duplicateActivePreviewTransform;

    return hasArrangePreview || hasDuplicatePreview;
  }, [
    arrangeGhostPreviewGroups.length,
    arrangeSupportPreviewDeltas.length,
    duplicateActivePreviewTransform,
    effectiveDuplicatePreviewTransforms.length,
    mode,
    transformMode,
  ]);

  const activeModelTransform = React.useMemo(() => {
    if (!activeModel) return null;
    if (transform && activeModelId === activeModel.id) return transform;
    return activeModel.transform;
  }, [activeModel, transform, activeModelId]);

  const multiGizmoCenter = React.useMemo(() => {
    if (!isMultiGizmoSelection || selectedTransformableModelIds.length === 0) return null;

    const sum = new THREE.Vector3();
    let count = 0;

    for (const modelId of selectedTransformableModelIds) {
      const preview = multiGizmoPreviewTransformsById[modelId];
      if (preview) {
        sum.add(preview.position);
        count += 1;
        continue;
      }

      const model = models.find((entry) => entry.id === modelId);
      if (!model) continue;
      const sourceTransform = (modelId === activeModelId && liveActiveTransformForMultiPreview)
        ? liveActiveTransformForMultiPreview
        : model.transform;
      sum.add(sourceTransform.position);
      count += 1;
    }

    if (count === 0) return null;
    return sum.multiplyScalar(1 / count);
  }, [
    activeModelId,
    isMultiGizmoSelection,
    models,
    multiGizmoPreviewTransformsById,
    selectedTransformableModelIds,
    liveActiveTransformForMultiPreview,
    transform,
  ]);

  React.useEffect(() => {
    if (!isMultiGizmoSelection) return;
    if (!multiGizmoCenter) return;
    setMultiGizmoAnchorPosition(multiGizmoCenter);
  }, [isMultiGizmoSelection, multiGizmoCenter, setMultiGizmoAnchorPosition]);

  const dragCornerCageRefs = React.useRef<Record<string, THREE.LineSegments | null>>({});
  const dragCornerCagePrimeRafRef = React.useRef<number | null>(null);
  const dragCornerCageUpdateRafRef = React.useRef<number | null>(null);
  const dragCornerCageBaseBoundsRef = React.useRef<Record<string, THREE.Box3>>({});
  const dragCornerCageBaseTransformsRef = React.useRef<Record<string, ModelTransform>>({});
  const dragCornerCageCurrentMatrixRef = React.useRef(new THREE.Matrix4());
  const dragCornerCageBaseMatrixRef = React.useRef(new THREE.Matrix4());
  const dragCornerCageDeltaMatrixRef = React.useRef(new THREE.Matrix4());
  const dragCornerCageBoundsScratchRef = React.useRef(new THREE.Box3());
  const dragCornerCageCornerScratchRef = React.useRef([
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
    new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
  ]);

  const clearDragCornerCageBaseData = React.useCallback(() => {
    dragCornerCageBaseBoundsRef.current = {};
    dragCornerCageBaseTransformsRef.current = {};
  }, []);

  const cancelPendingDragCornerCagePrime = React.useCallback(() => {
    if (dragCornerCagePrimeRafRef.current === null || typeof window === 'undefined') return;
    window.cancelAnimationFrame(dragCornerCagePrimeRafRef.current);
    dragCornerCagePrimeRafRef.current = null;
  }, []);

  const cancelPendingDragCornerCageUpdate = React.useCallback(() => {
    if (dragCornerCageUpdateRafRef.current === null || typeof window === 'undefined') return;
    window.cancelAnimationFrame(dragCornerCageUpdateRafRef.current);
    dragCornerCageUpdateRafRef.current = null;
  }, []);

  const captureDragCornerCageBaseData = React.useCallback((ids: string[], activeBefore: ModelTransform | null) => {
    const baseBounds: Record<string, THREE.Box3> = {};
    const baseTransforms: Record<string, ModelTransform> = {};

    for (const modelId of ids) {
      const model = modelById.get(modelId);
      if (!model || !model.visible) continue;

      const beforeTransform = (modelId === activeModelId && activeBefore)
        ? activeBefore
        : model.transform;

      const bounds = computeModelWorldBounds(model, beforeTransform, buildVolumeBounds);
      if (!bounds || bounds.isEmpty()) continue;

      baseBounds[modelId] = bounds.clone();
      baseTransforms[modelId] = {
        position: beforeTransform.position.clone(),
        rotation: beforeTransform.rotation.clone(),
        scale: beforeTransform.scale.clone(),
      };
    }

    dragCornerCageBaseBoundsRef.current = baseBounds;
    dragCornerCageBaseTransformsRef.current = baseTransforms;
  }, [activeModelId, buildVolumeBounds, computeModelWorldBounds, modelById]);

  const transformBoundsByDelta = React.useCallback((baseBounds: THREE.Box3, delta: THREE.Matrix4): THREE.Box3 => {
    const min = baseBounds.min;
    const max = baseBounds.max;
    const corners = dragCornerCageCornerScratchRef.current;

    corners[0].set(min.x, min.y, min.z);
    corners[1].set(max.x, min.y, min.z);
    corners[2].set(max.x, max.y, min.z);
    corners[3].set(min.x, max.y, min.z);
    corners[4].set(min.x, min.y, max.z);
    corners[5].set(max.x, min.y, max.z);
    corners[6].set(max.x, max.y, max.z);
    corners[7].set(min.x, max.y, max.z);

    const out = dragCornerCageBoundsScratchRef.current;
    out.makeEmpty();
    for (const corner of corners) {
      corner.applyMatrix4(delta);
      out.expandByPoint(corner);
    }
    return out;
  }, []);

  const resolveLiveTransformForCage = React.useCallback((modelId: string, model: LoadedModel): ModelTransform => {
    const liveGroup = meshRefs.current[modelId];
    if (!liveGroup) {
      if (modelId === activeModelId) {
        const activeLiveDrag = (
          isGizmoDragging
          || isGizmoRetargeting
          || isPostGizmoInteractionGuardActive
        )
          ? liveDragTransformRef.current
          : null;
        return activeLiveDrag ?? transform ?? model.transform;
      }
      return multiGizmoPreviewTransformsById[modelId] ?? model.transform;
    }

    return {
      position: liveGroup.position.clone(),
      rotation: new THREE.Euler().setFromQuaternion(liveGroup.quaternion, 'ZYX'),
      scale: liveGroup.scale.clone(),
    };
  }, [
    activeModelId,
    isGizmoDragging,
    isGizmoRetargeting,
    isPostGizmoInteractionGuardActive,
    multiGizmoPreviewTransformsById,
    transform,
  ]);

  const dragCornerCageModelIds = React.useMemo(() => {
    if (mode !== 'prepare') return [] as string[];
    if (transformMode !== 'transform') return [] as string[];
    if (!isGizmoDragging || !activeModelId) return [] as string[];

    const ids = isMultiGizmoSelection
      ? selectedTransformableModelIds
      : [activeModelId];

    return ids.filter((modelId) => {
      const model = modelById.get(modelId);
      return !!model?.visible;
    });
  }, [activeModelId, isGizmoDragging, isMultiGizmoSelection, mode, modelById, selectedTransformableModelIds, transformMode]);

  const updateDragCornerCagesNow = React.useCallback(() => {
    if (dragCornerCageModelIds.length === 0) {
      Object.values(dragCornerCageRefs.current).forEach((line) => {
        if (line) line.visible = false;
      });
      return;
    }

    for (let i = 0; i < dragCornerCageModelIds.length; i += 1) {
      const modelId = dragCornerCageModelIds[i];
      const line = dragCornerCageRefs.current[modelId];
      if (!line) continue;

      const model = modelById.get(modelId);
      if (!model || !model.visible) {
        line.visible = false;
        continue;
      }

      const effectiveTransform = resolveLiveTransformForCage(modelId, model);

      const baseBounds = dragCornerCageBaseBoundsRef.current[modelId];
      const baseTransform = dragCornerCageBaseTransformsRef.current[modelId];

      let bounds: THREE.Box3;
      if (baseBounds && baseTransform) {
        const currentMatrix = dragCornerCageCurrentMatrixRef.current.copy(composeModelTransformMatrix(effectiveTransform));
        const baseMatrix = dragCornerCageBaseMatrixRef.current.copy(composeModelTransformMatrix(baseTransform));
        const delta = dragCornerCageDeltaMatrixRef.current.multiplyMatrices(currentMatrix, baseMatrix.invert());
        bounds = transformBoundsByDelta(baseBounds, delta);
      } else {
        // During initial drag-start, base cage data is primed asynchronously.
        // Avoid expensive fallback world-bounds computation in per-pointer-move path.
        if (isGizmoDragging) {
          line.visible = false;
          continue;
        }
        bounds = computeModelWorldBounds(model, effectiveTransform, buildVolumeBounds);
      }

      if (!bounds || bounds.isEmpty()) {
        line.visible = false;
        continue;
      }

      const positionAttribute = line.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!positionAttribute) continue;

      const targetArray = positionAttribute.array as Float32Array;
      if (targetArray.length !== (8 * 3 * 2 * 3)) continue;

      writeCornerOnlyWireframePositions(targetArray, bounds, 2.5);
      positionAttribute.needsUpdate = true;

      line.visible = true;
    }
  }, [
    buildVolumeBounds,
    composeModelTransformMatrix,
    computeModelWorldBounds,
    dragCornerCageModelIds,
    isGizmoDragging,
    modelById,
    resolveLiveTransformForCage,
    transformBoundsByDelta,
  ]);

  const requestDragCornerCageUpdate = React.useCallback(() => {
    if (typeof window === 'undefined') {
      updateDragCornerCagesNow();
      return;
    }
    if (dragCornerCageUpdateRafRef.current !== null) return;
    dragCornerCageUpdateRafRef.current = window.requestAnimationFrame(() => {
      dragCornerCageUpdateRafRef.current = null;
      updateDragCornerCagesNow();
    });
  }, [updateDragCornerCagesNow]);

  const scheduleDragCornerCagePrime = React.useCallback((ids: string[], activeBefore: ModelTransform | null) => {
    if (typeof window === 'undefined') return;
    cancelPendingDragCornerCagePrime();
    dragCornerCagePrimeRafRef.current = window.requestAnimationFrame(() => {
      dragCornerCagePrimeRafRef.current = null;
      captureDragCornerCageBaseData(ids, activeBefore);
      updateDragCornerCagesNow();
    });
  }, [cancelPendingDragCornerCagePrime, captureDragCornerCageBaseData, updateDragCornerCagesNow]);

  const updateDragCornerCagePulseOnly = React.useCallback(() => {
    if (dragCornerCageModelIds.length === 0) return;
    const now = performance.now();

    for (let i = 0; i < dragCornerCageModelIds.length; i += 1) {
      const modelId = dragCornerCageModelIds[i];
      const line = dragCornerCageRefs.current[modelId];
      if (!line || !line.visible) continue;

      const pulse = 0.78 + (0.22 * (0.5 + (0.5 * Math.sin((now * 0.008) + (i * 0.65)))));
      const material = line.material;
      if (Array.isArray(material)) {
        material.forEach((m) => {
          const lineMaterial = m as THREE.LineBasicMaterial;
          lineMaterial.opacity = pulse;
        });
      } else if (material) {
        (material as THREE.LineBasicMaterial).opacity = pulse;
      }
    }
  }, [dragCornerCageModelIds]);

  React.useEffect(() => {
    if (dragCornerCageModelIds.length === 0) {
      cancelPendingDragCornerCagePrime();
      cancelPendingDragCornerCageUpdate();
      updateDragCornerCagesNow();
      return;
    }

    // Prime geometry on next paint to keep gizmo pointer-down responsive,
    // especially for very large models/support graphs.
    const primeRaf = typeof window !== 'undefined'
      ? window.requestAnimationFrame(() => {
          updateDragCornerCagesNow();
        })
      : null;

    let rafId: number | null = null;
    const tick = () => {
      updateDragCornerCagePulseOnly();
      rafId = window.requestAnimationFrame(tick);
    };

    tick();

    return () => {
      if (primeRaf !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(primeRaf);
      }
      cancelPendingDragCornerCageUpdate();
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [
    activeModelId,
    buildVolumeBounds,
    composeModelTransformMatrix,
    computeModelWorldBounds,
    dragCornerCageModelIds,
    transformBoundsByDelta,
    models,
    cancelPendingDragCornerCagePrime,
    cancelPendingDragCornerCageUpdate,
    updateDragCornerCagePulseOnly,
    updateDragCornerCagesNow,
  ]);

  React.useEffect(() => {
    return () => {
      cancelPendingDragCornerCagePrime();
      cancelPendingDragCornerCageUpdate();
    };
  }, [cancelPendingDragCornerCagePrime, cancelPendingDragCornerCageUpdate]);

  const satDebugTargets = React.useMemo(() => {
    if (!activeBuildVolumeSettings.showSliceSatBoundingMesh) return [] as Array<{
      id: string;
      geometry: LoadedModel['geometry'];
      transform: ModelTransform;
    }>;

    if (!activeBuildVolumeSettings.showSliceSatBoundingMeshForAllModels) {
      if (!activeModel || !activeModelTransform) return [];
      return [{ id: activeModel.id, geometry: activeModel.geometry, transform: activeModelTransform }];
    }

    return models
      .filter((model) => model.visible)
      .map((model) => ({
        id: model.id,
        geometry: model.geometry,
        transform: (model.id === activeModelId && transform) ? transform : model.transform,
      }));
  }, [
    activeBuildVolumeSettings.showSliceSatBoundingMesh,
    activeBuildVolumeSettings.showSliceSatBoundingMeshForAllModels,
    activeModel,
    activeModelId,
    activeModelTransform,
    models,
    transform,
  ]);

  const crossSectionStencilSourceVersion = React.useMemo(() => ({
    supportRenderRefreshNonce,
    supportDragTransactionId,
    isGizmoDragging,
    effectiveHoldSupportDragDelta,
    // Restrict invalidation to geometry-bearing support/kickstand refs plus
    // raft geometry parameters. This avoids recaching on hover/selection-only
    // snapshot churn that does not alter cross-section source geometry.
    supportTrunksRef: supportStateForBounds.trunks,
    supportRootsRef: supportStateForBounds.roots,
    supportKnotsRef: supportStateForBounds.knots,
    supportBranchesRef: supportStateForBounds.branches,
    supportLeavesRef: supportStateForBounds.leaves,
    supportTwigsRef: supportStateForBounds.twigs,
    supportSticksRef: supportStateForBounds.sticks,
    supportBracesRef: supportStateForBounds.braces,
    kickstandKickstandsRef: kickstandStateForBounds.kickstands,
    kickstandRootsRef: kickstandStateForBounds.roots,
    kickstandKnotsRef: kickstandStateForBounds.knots,
    raftBottomMode: raftSettingsForBounds.bottomMode,
    raftThickness: raftSettingsForBounds.thickness,
    raftLineHeightMm: raftSettingsForBounds.lineHeightMm,
    raftWallEnabled: raftSettingsForBounds.wallEnabled,
    raftWallHeight: raftSettingsForBounds.wallHeight,
    raftChamferAngle: raftSettingsForBounds.chamferAngle,
    // Model-level signals: ensure the cross-section rebuilds when models are
    // added, removed, copied, or transformed (supports may be attached to a
    // model whose transform drives their rendered world positions).
    models,
    transform,
  }), [
    effectiveHoldSupportDragDelta,
    isGizmoDragging,
    kickstandStateForBounds.kickstands,
    kickstandStateForBounds.knots,
    kickstandStateForBounds.roots,
    models,
    raftSettingsForBounds.bottomMode,
    raftSettingsForBounds.chamferAngle,
    raftSettingsForBounds.lineHeightMm,
    raftSettingsForBounds.thickness,
    raftSettingsForBounds.wallEnabled,
    raftSettingsForBounds.wallHeight,
    supportStateForBounds.braces,
    supportStateForBounds.branches,
    supportStateForBounds.knots,
    supportStateForBounds.leaves,
    supportStateForBounds.roots,
    supportStateForBounds.sticks,
    supportStateForBounds.trunks,
    supportStateForBounds.twigs,
    supportDragTransactionId,
    supportRenderRefreshNonce,
    transform,
  ]);

  const crossSectionPlaneWidthMm = Math.max(
    1,
    (activeBuildVolumeSettings?.widthMm ?? 200) + 24,
  );
  const crossSectionPlaneHeightMm = Math.max(
    1,
    (activeBuildVolumeSettings?.depthMm ?? 200) + 24,
  );

  const introControllerBounds = introBoundsSnapshot;

  const introControllerRunId = cameraIntroRunId;

  const selectedSpaceMousePivotPoint = React.useMemo(() => {
    if (!activeModel?.visible) return null;

    const bounds = modelWorldBounds.get(activeModel.id) ?? computeModelWorldBounds(activeModel);
    if (bounds.isEmpty()) return null;

    return bounds.getCenter(new THREE.Vector3());
  }, [activeModel, computeModelWorldBounds, modelWorldBounds]);

  const supportAutoTargetModelIdRef = React.useRef<string | null | undefined>(undefined);

  const spaceMousePivotCandidates = React.useMemo(() => {
    const centers: THREE.Vector3[] = [];

    for (const model of models) {
      if (!model.visible) continue;
      const bounds = modelWorldBounds.get(model.id) ?? computeModelWorldBounds(model);
      if (bounds.isEmpty()) continue;
      centers.push(bounds.getCenter(new THREE.Vector3()));
    }

    return centers;
  }, [computeModelWorldBounds, modelWorldBounds, models]);

  const [entryDropOffsets, setEntryDropOffsets] = React.useState<Record<string, number>>({});
  const [modeEntryFramingRunId, setModeEntryFramingRunId] = React.useState(0);
  const [modeExitRestoreRunId, setModeExitRestoreRunId] = React.useState(0);
  const knownModelIdsRef = React.useRef<Set<string>>(new Set());
  const prevTransformModeRef = React.useRef<TransformMode | undefined>(transformMode);
  const entryAnimRef = React.useRef<Record<string, { startMs: number | null; fromZ: number; skipBounce: boolean }>>({});
  const pendingEntryAnimRef = React.useRef<Record<string, { fromZ: number; runId: number; skipBounce: boolean }>>({});
  const isIntroAnimating = cameraIntroRunId > cameraIntroCompletedRunId;
  const isDropAnimating = Object.keys(entryDropOffsets).length > 0;
  const dynamicDpr: [number, number] = isLinux
    ? [1, 1]
    : (isIntroAnimating || isDropAnimating || isGizmoDragging || isGizmoRetargeting)
      ? [1, 1.5]
      : [1, 10];

  React.useEffect(() => {
    modelDropOffsetsRef.current = entryDropOffsets;
  }, [entryDropOffsets]);

  const stopActiveModelDropAnimation = React.useCallback(() => {
    if (!activeModelId) return;

    delete entryAnimRef.current[activeModelId];
    delete pendingEntryAnimRef.current[activeModelId];

    setEntryDropOffsets((previous) => {
      if (previous[activeModelId] == null) return previous;
      const next = { ...previous };
      delete next[activeModelId];
      return next;
    });
  }, [activeModelId]);

  React.useEffect(() => {
    const prevMode = prevTransformModeRef.current;
    const prevIsPresentationMode = prevMode === 'arrange';
    const nextIsPresentationMode = transformMode === 'arrange';
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
    const shouldDeferLargeModelDrop = cameraIntroRunId > cameraIntroCompletedRunId;

    // Start animation for newly added mesh files
    for (const model of models) {
      const isKnown = knownModelIdsRef.current.has(model.id);
      if (isKnown) continue;

      knownModelIdsRef.current.add(model.id);

      const isMeshFile = model.fileUrl.startsWith('blob:') || /\.(stl|3mf)$/i.test(model.name);
      if (!isMeshFile) continue;

      const dropFrom = Math.max(16, Math.min(64, model.geometry.size.z * 0.45));
      const disableDropAnimation = model.polygonCount >= LARGE_MODEL_DROP_DEFER_THRESHOLD_POLYS;
      if (disableDropAnimation) continue;

      const skipBounce = model.polygonCount >= LARGE_MODEL_BOUNCE_THRESHOLD_POLYS;
      const deferDrop = shouldDeferLargeModelDrop && model.polygonCount >= LARGE_MODEL_DROP_DEFER_THRESHOLD_POLYS;

      if (deferDrop) {
        pendingEntryAnimRef.current[model.id] = {
          fromZ: dropFrom,
          runId: cameraIntroRunId,
          skipBounce,
        };
      } else {
        // Start timer on the first rendered animation frame.
        // This keeps the drop motion intact even if initial GPU upload blocks
        // the main thread for hundreds of milliseconds.
        entryAnimRef.current[model.id] = {
          startMs: null,
          fromZ: dropFrom,
          skipBounce,
        };
        initialDropOffsets[model.id] = dropFrom;
      }
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

    const activatedOffsets: Record<string, number> = {};

    for (const [id, pending] of pendingEntries) {
      entryAnimRef.current[id] = {
        startMs: null,
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
        if (animation.startMs == null) {
          animation.startMs = now;
          nextOffsets[id] = animation.fromZ;
          continue;
        }

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

  const trunkPlacementPreviewForRenderer = (
    trunkPlacementPreview
    && !suppressSupportPlacementPreviewRendering
    && !blockSupportPlacement
    && !isDraggingHandle
    && !isBranchPlacementActive
    && !isLeafPlacementActive
    && !isKickstandPlacementActive
    && !branchPlacementPreview
  )
    ? trunkPlacementPreview
    : null;

  const branchPlacementPreviewForRenderer = (
    branchPlacementPreview
    && isBranchPlacementActive
    && !isDraggingHandle
    && !suppressSupportPlacementPreviewRendering
  )
    ? branchPlacementPreview
    : null;

  const leafPlacementPreviewForRenderer = (
    leafPlacementPreview
    && !isDraggingHandle
    && !suppressSupportPlacementPreviewRendering
  )
    ? leafPlacementPreview
    : null;

  const bracePlacementPreviewForRenderer = (
    bracePlacementPreview
    && !isDraggingHandle
    && !suppressSupportPlacementPreviewRendering
  )
    ? bracePlacementPreview
    : null;

  const kickstandPlacementPreviewForRenderer = (
    kickstandPlacementPreview
    && !isDraggingHandle
    && !suppressSupportPlacementPreviewRendering
  )
    ? kickstandPlacementPreview
    : null;

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

  React.useEffect(() => {
    const handleEscapeDeselect = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;
      if (mode !== 'prepare') return;
      if (!onActiveModelChange) return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTypingContext = !!target && (
        target.isContentEditable
        || tag === 'INPUT'
        || tag === 'TEXTAREA'
        || tag === 'SELECT'
      );
      if (isTypingContext) return;

      if (!activeModelId && (!selectedModelIds || selectedModelIds.length === 0)) return;

      onActiveModelChange(null);
      window.dispatchEvent(new CustomEvent('model-deselected'));
    };

    window.addEventListener('keydown', handleEscapeDeselect);
    return () => {
      window.removeEventListener('keydown', handleEscapeDeselect);
    };
  }, [activeModelId, mode, onActiveModelChange, selectedModelIds]);

  // Handle canvas background clicks (deselect support)
  const handleCanvasClick = React.useCallback(
    (e: React.MouseEvent) => {
      console.log('[Canvas] handleCanvasClick fired, mode:', mode);

      const target = e.target as HTMLElement | null;
      // Canvas whitespace deselection is handled via R3F onPointerMissed for reliable hit/miss detection.
      if (target?.tagName === 'CANVAS') {
        return;
      }

      if (isMarqueeSelecting) {
        return;
      }

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

      // Non-canvas background clicks should not affect 3D selection state.
      return;
    },
    [isMarqueeSelecting, mode],
  );

  const handleScenePointerMissed = React.useCallback(() => {
    if (isMarqueeSelecting) return;
    if (window.__modelClickedThisFrame) return;
    if (isOrbitInteracting || spaceMouseNavigationActive) return;

    if (suppressNextCanvasClickRef.current || (window as any).__gizmoDragEndedThisFrame) {
      suppressNextCanvasClickRef.current = false;
      (window as any).__gizmoDragEndedThisFrame = false;
      return;
    }

    if (mode === 'prepare') {
      if (onActiveModelChange) {
        onActiveModelChange(null);
      }
      window.dispatchEvent(new CustomEvent('model-deselected'));
      return;
    }

    if (mode === 'support') {
      if (supportStateForBounds.hoveredCategory === 'contactDisk') return;
      clearSupportSelection();
    }
  }, [isMarqueeSelecting, isOrbitInteracting, mode, onActiveModelChange, spaceMouseNavigationActive, supportStateForBounds.hoveredCategory]);

  React.useEffect(() => {
    updateCameraBelowBuildPlate();
  }, [updateCameraBelowBuildPlate]);

  // The below-plate flag flips early for UX smoothness. To avoid rapid
  // mount/unmount churn near a single opacity cutoff while orbiting, keep a
  // hysteresis state for plate-contact primitive culling.
  const [plateContactCullActive, setPlateContactCullActive] = React.useState(false);

  React.useEffect(() => {
    const ENTER_CULL_OPACITY = 0.04;
    const EXIT_CULL_OPACITY = 0.12;

    setPlateContactCullActive((prev) => {
      if (!isCameraBelowBuildPlate) {
        return false;
      }

      if (prev) {
        return buildPlateOpacity < EXIT_CULL_OPACITY;
      }

      return buildPlateOpacity <= ENTER_CULL_OPACITY;
    });
  }, [buildPlateOpacity, isCameraBelowBuildPlate]);

  const hidePlateContactPrimitives = plateContactCullActive;
  const hideRaftPrimitives = plateContactCullActive;
  const navigationLodActive = isOrbitInteracting || isWheelZoomInteracting || spaceMouseNavigationActive || isGizmoDragging || isGizmoRetargeting || isLayerScrubbing;
  const isSpotlightHighlightActive =
    effectiveModelSelected
    && selectionHighlightMode === 'spotlight';

  const updateOrbitControlSpeeds = React.useCallback(() => {
    const controls = orbitControlsRef.current;
    const camera = cameraRef.current;
    if (!controls || !camera) return;

    if (cameraFeelPreset === 'raw') {
      controls.rotateSpeed = 1.0;
      controls.panSpeed = 1.0;
      controls.zoomSpeed = 1.0;
      return;
    }

    const distanceToTarget = camera.position.distanceTo(controls.target);
    const sceneScale = Math.max(
      activeBuildVolumeSettings.widthMm,
      activeBuildVolumeSettings.depthMm,
      activeBuildVolumeSettings.maxZMm,
      1,
    );

    const normalizedDistance = THREE.MathUtils.clamp(distanceToTarget / Math.max(1, sceneScale * 0.75), 0.35, 3.6);
    const feelTuningByPreset: Record<CameraFeelPreset, {
      accelerationExponent: number;
      rotateBase: number;
      panBase: number;
      zoomBase: number;
      rotateMin: number;
      rotateMax: number;
      panMin: number;
      panMax: number;
      zoomMin: number;
      zoomMax: number;
      responseLerp: number;
    }> = {
      raw: {
        accelerationExponent: 0,
        rotateBase: 1.0,
        panBase: 1.0,
        zoomBase: 1.0,
        rotateMin: 1.0,
        rotateMax: 1.0,
        panMin: 1.0,
        panMax: 1.0,
        zoomMin: 1.0,
        zoomMax: 1.0,
        responseLerp: 1.0,
      },
      precise: {
        accelerationExponent: 0.5,
        rotateBase: 0.72,
        panBase: 0.82,
        zoomBase: 1.25,
        rotateMin: 0.45,
        rotateMax: 1.45,
        panMin: 0.45,
        panMax: 1.9,
        zoomMin: 0.75,
        zoomMax: 2.8,
        responseLerp: 0.14,
      },
      balanced: {
        accelerationExponent: 0.42,
        rotateBase: 0.85,
        panBase: 1.0,
        zoomBase: 1.45,
        rotateMin: 0.6,
        rotateMax: 1.9,
        panMin: 0.65,
        panMax: 2.4,
        zoomMin: 0.95,
        zoomMax: 3.4,
        responseLerp: 0.2,
      },
      fast: {
        accelerationExponent: 0.34,
        rotateBase: 1.03,
        panBase: 1.2,
        zoomBase: 1.75,
        rotateMin: 0.75,
        rotateMax: 2.25,
        panMin: 0.8,
        panMax: 2.8,
        zoomMin: 1.2,
        zoomMax: 4.0,
        responseLerp: 0.26,
      },
    };

    const tuning = feelTuningByPreset[cameraFeelPreset] ?? feelTuningByPreset.balanced;
    const acceleration = Math.pow(normalizedDistance, tuning.accelerationExponent);

    const targetRotateSpeed = THREE.MathUtils.clamp(tuning.rotateBase * acceleration, tuning.rotateMin, tuning.rotateMax);
    const targetPanSpeed = THREE.MathUtils.clamp(tuning.panBase * acceleration, tuning.panMin, tuning.panMax);
    const targetZoomSpeed = THREE.MathUtils.clamp(tuning.zoomBase * acceleration, tuning.zoomMin, tuning.zoomMax);

    controls.rotateSpeed = THREE.MathUtils.lerp(controls.rotateSpeed, targetRotateSpeed, tuning.responseLerp);
    controls.panSpeed = THREE.MathUtils.lerp(controls.panSpeed, targetPanSpeed, tuning.responseLerp);
    controls.zoomSpeed = THREE.MathUtils.lerp(controls.zoomSpeed, targetZoomSpeed, tuning.responseLerp);
  }, [
    activeBuildVolumeSettings.depthMm,
    activeBuildVolumeSettings.maxZMm,
    activeBuildVolumeSettings.widthMm,
    cameraFeelPreset,
  ]);

  React.useEffect(() => {
    updateOrbitControlSpeeds();
  }, [updateOrbitControlSpeeds]);

  const navigationResumeDelayMs = React.useMemo(() => {
    if (cameraFeelPreset === 'raw') return 0;
    if (cameraFeelPreset === 'precise') return 320;
    if (cameraFeelPreset === 'fast') return 150;
    return 220;
  }, [cameraFeelPreset]);

  React.useEffect(() => {
    navigationResumeDelayRef.current = navigationResumeDelayMs;
  }, [navigationResumeDelayMs]);

  const forceEndWheelZoomInteraction = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    if (wheelZoomEndTimeoutRef.current !== null) {
      window.clearTimeout(wheelZoomEndTimeoutRef.current);
      wheelZoomEndTimeoutRef.current = null;
    }

    if (!wheelZoomInteractionActiveRef.current) return;

    wheelZoomInteractionActiveRef.current = false;
    setIsWheelZoomInteracting(false);
    window.dispatchEvent(new CustomEvent('picking-zoom-end', {
      detail: { resumeAfterMs: navigationResumeDelayMs },
    }));
  }, [navigationResumeDelayMs]);

  const clearPendingTrackpadGestureEnd = React.useCallback(() => {
    if (typeof window === 'undefined') return;
    if (trackpadGestureEndTimeoutRef.current === null) return;
    window.clearTimeout(trackpadGestureEndTimeoutRef.current);
    trackpadGestureEndTimeoutRef.current = null;
  }, []);

  const applyTrackpadGesture = React.useCallback((action: TrackpadGestureAction, event: WheelEvent) => {
    const camera = cameraRef.current;
    const controls = orbitControlsRef.current;
    const container = containerRef.current;
    if (!camera || !controls || controls.enabled === false || !container) return false;

    const rect = container.getBoundingClientRect();
    const viewportHeight = Math.max(1, rect.height);

    if (action === 'pan') {
      const RAW_TRACKPAD_PAN_SPEED = 1.0;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

      let worldUnitsPerPixel = 0;
      if (camera instanceof THREE.OrthographicCamera) {
        worldUnitsPerPixel = ((camera.top - camera.bottom) / Math.max(1e-6, camera.zoom)) / viewportHeight;
      } else if (camera instanceof THREE.PerspectiveCamera) {
        const distanceToTarget = Math.max(0.001, camera.position.distanceTo(controls.target));
        const worldHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * distanceToTarget;
        worldUnitsPerPixel = worldHeight / viewportHeight;
      } else {
        return false;
      }

      const panOffset = new THREE.Vector3()
        .addScaledVector(right, event.deltaX * worldUnitsPerPixel * RAW_TRACKPAD_PAN_SPEED * cameraTrackpadPanAcceleration)
        .addScaledVector(up, -event.deltaY * worldUnitsPerPixel * RAW_TRACKPAD_PAN_SPEED * cameraTrackpadPanAcceleration);

      camera.position.add(panOffset);
      controls.target.add(panOffset);
      camera.updateMatrixWorld();
      controls.update();
      return true;
    }

    const worldUp = camera.up.clone().normalize();
    const offset = camera.position.clone().sub(controls.target);
    const offsetLength = Math.max(0.001, offset.length());
    const RAW_TRACKPAD_ROTATE_SPEED = 1.0;
    const rotateScale = 0.0022 * RAW_TRACKPAD_ROTATE_SPEED * cameraTrackpadOrbitAcceleration;
    const yawAngle = event.deltaX * rotateScale;

    offset.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(worldUp, yawAngle));

    const normalizedOffset = offset.clone().normalize();
    const currentPolar = Math.acos(THREE.MathUtils.clamp(normalizedOffset.dot(worldUp), -1, 1));
    const nextPolar = THREE.MathUtils.clamp(currentPolar + (event.deltaY * rotateScale), 0.08, Math.PI - 0.08);
    const pitchAngle = nextPolar - currentPolar;

    const forward = normalizedOffset.clone().negate();
    const rightAxis = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    if (rightAxis.lengthSq() < 1e-8) {
      rightAxis.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    }

    offset
      .normalize()
      .multiplyScalar(offsetLength)
      .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(rightAxis, pitchAngle));

    camera.position.copy(controls.target).add(offset);
    camera.up.copy(worldUp);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
    controls.update();
    return true;
  }, [cameraTrackpadOrbitAcceleration, cameraTrackpadPanAcceleration]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') return;

    const clearPendingZoomEnd = () => {
      if (wheelZoomEndTimeoutRef.current === null) return;
      window.clearTimeout(wheelZoomEndTimeoutRef.current);
      wheelZoomEndTimeoutRef.current = null;
    };

    const endZoomInteraction = () => {
      clearPendingZoomEnd();
      if (!wheelZoomInteractionActiveRef.current) return;

      wheelZoomInteractionActiveRef.current = false;
      setIsWheelZoomInteracting(false);
      window.dispatchEvent(new CustomEvent('picking-zoom-end', {
        detail: { resumeAfterMs: navigationResumeDelayRef.current },
      }));
    };

    const beginZoomInteraction = () => {
      if (wheelZoomInteractionActiveRef.current) return;
      wheelZoomInteractionActiveRef.current = true;
      setIsWheelZoomInteracting(true);
      window.dispatchEvent(new Event('picking-zoom-start'));
    };

    const scheduleZoomInteractionEnd = () => {
      clearPendingZoomEnd();
      wheelZoomEndTimeoutRef.current = window.setTimeout(() => {
        wheelZoomEndTimeoutRef.current = null;
        endZoomInteraction();
      }, 120);
    };

    const onWheel = (event: WheelEvent) => {
      if (!container.contains(event.target as Node | null)) return;
      // Trackpad: allow zoom only for pinch gestures (ctrlKey).
      // Regular two-finger scroll should never trigger zoom.
      if (isLikelyTrackpadWheelEvent(event) && !event.ctrlKey) {
        return;
      }
      try {
        if (resolveTrackpadGestureAction(event, cameraTrackpadSettings, cameraTrackpadModifierKey) !== null) {
          return;
        }
      } catch (error) {
        console.error('[SceneCanvas] Trackpad gesture resolution failed; falling back to wheel zoom.', error);
      }

      beginZoomInteraction();

      window.dispatchEvent(new Event('picking-zoom-change'));
      scheduleZoomInteractionEnd();
    };

    const forceZoomInteractionEnd = () => {
      endZoomInteraction();
    };

    window.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('pointerup', forceZoomInteractionEnd, true);
    window.addEventListener('pointercancel', forceZoomInteractionEnd, true);
    window.addEventListener('mouseup', forceZoomInteractionEnd, true);
    window.addEventListener('contextmenu', forceZoomInteractionEnd, true);
    window.addEventListener('blur', forceZoomInteractionEnd);
    document.addEventListener('visibilitychange', forceZoomInteractionEnd);

    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointerup', forceZoomInteractionEnd, true);
      window.removeEventListener('pointercancel', forceZoomInteractionEnd, true);
      window.removeEventListener('mouseup', forceZoomInteractionEnd, true);
      window.removeEventListener('contextmenu', forceZoomInteractionEnd, true);
      window.removeEventListener('blur', forceZoomInteractionEnd);
      document.removeEventListener('visibilitychange', forceZoomInteractionEnd);
      endZoomInteraction();
    };
  }, [cameraTrackpadModifierKey, cameraTrackpadSettings]);

  React.useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      if (wheelZoomEndTimeoutRef.current !== null) {
        window.clearTimeout(wheelZoomEndTimeoutRef.current);
      }
      wheelZoomEndTimeoutRef.current = null;
      wheelZoomInteractionActiveRef.current = false;
      if (trackpadGestureEndTimeoutRef.current !== null) {
        window.clearTimeout(trackpadGestureEndTimeoutRef.current);
      }
      trackpadGestureEndTimeoutRef.current = null;
      trackpadGestureActionRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const dispatchProgress = (detail: DiagnosticsBenchmarkProgressDetail) => {
      window.dispatchEvent(new CustomEvent(DIAGNOSTICS_BENCHMARK_PROGRESS_EVENT, { detail }));
    };

    const computeStats = (samplesMs: number[], durationMs: number): DiagnosticsBenchmarkStats => {
      const cleaned = samplesMs.filter((v) => Number.isFinite(v) && v > 0);
      if (cleaned.length === 0) {
        return {
          sampleCount: 0,
          durationMs,
          fpsAvg: 0,
          fpsMin: 0,
          fpsMax: 0,
          frameTimeAvgMs: 0,
          frameTimeP95Ms: 0,
          frameTimeMaxMs: 0,
        };
      }

      const sorted = [...cleaned].sort((a, b) => a - b);
      const sum = cleaned.reduce((acc, v) => acc + v, 0);
      const avg = sum / cleaned.length;
      const max = sorted[sorted.length - 1] ?? 0;
      const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
      const p95 = sorted[p95Index] ?? max;
      const minFrame = sorted[0] ?? avg;
      const avgFps = avg > 0 ? 1000 / avg : 0;
      const minFps = max > 0 ? 1000 / max : 0;
      const maxFps = minFrame > 0 ? 1000 / minFrame : 0;

      return {
        sampleCount: cleaned.length,
        durationMs,
        fpsAvg: avgFps,
        fpsMin: minFps,
        fpsMax: maxFps,
        frameTimeAvgMs: avg,
        frameTimeP95Ms: p95,
        frameTimeMaxMs: max,
      };
    };

    const runBenchmark = async (requestId: string, stressProfile: DiagnosticsBenchmarkStressProfile) => {
      const controls = orbitControlsRef.current;
      const camera = cameraRef.current;

      if (!controls || !camera) {
        dispatchProgress({
          requestId,
          status: 'error',
          message: 'Scene controls are not ready yet. Try again in a moment.',
        });
        return;
      }

      if (benchmarkRunIdRef.current) {
        dispatchProgress({
          requestId,
          status: 'error',
          message: 'A benchmark run is already in progress.',
        });
        return;
      }

      if (models.length === 0) {
        dispatchProgress({
          requestId,
          status: 'error',
          message: 'Benchmark requires at least one loaded model.',
        });
        return;
      }

      benchmarkRunIdRef.current = requestId;
      dispatchProgress({ requestId, status: 'started', message: `Preparing ${stressProfile} 3D orbit sweepsΓÇª` });

      const startedAt = performance.now();
      const startedAtIso = new Date().toISOString();
      const controlsSnapshot = {
        enabled: (controls as any).enabled !== false,
        position: camera.position.clone(),
        target: controls.target.clone(),
        zoom: camera instanceof THREE.OrthographicCamera ? camera.zoom : null,
      };

      const restoreControls = () => {
        camera.position.copy(controlsSnapshot.position);
        controls.target.copy(controlsSnapshot.target);
        if (camera instanceof THREE.OrthographicCamera && controlsSnapshot.zoom != null) {
          camera.zoom = controlsSnapshot.zoom;
          camera.updateProjectionMatrix();
        }
        (controls as any).enabled = controlsSnapshot.enabled;
        controls.update();
      };

      try {
        (controls as any).enabled = false;
        orbitInteractionActiveRef.current = true;
        orbitInteractionMovedRef.current = true;
        setIsOrbitInteracting(true);
        window.dispatchEvent(new Event('picking-orbit-start'));

        const visibleBounds = models
          .filter((model) => model.visible)
          .map((model) => modelWorldBounds.get(model.id))
          .filter((box): box is THREE.Box3 => !!box && !box.isEmpty());

        const center = new THREE.Vector3();
        if (visibleBounds.length > 0) {
          const union = visibleBounds[0].clone();
          for (let i = 1; i < visibleBounds.length; i += 1) {
            union.union(visibleBounds[i]);
          }
          union.getCenter(center);
        } else {
          center.copy(controls.target);
        }

        const initialOffset = camera.position.clone().sub(controls.target);
        if (initialOffset.lengthSq() < 1e-6) {
          initialOffset.set(0, -120, 80);
        }

        const baseRadius3d = Math.max(18, initialOffset.length());
        const initialAzimuth = Math.atan2(initialOffset.y, initialOffset.x);
        const horizontalRadius = Math.max(1e-6, Math.hypot(initialOffset.x, initialOffset.y));
        const initialElevation = Math.atan2(initialOffset.z, horizontalRadius);

        const phaseProfilesByStress: Record<DiagnosticsBenchmarkStressProfile, Array<{
          phase: DiagnosticsBenchmarkPhaseName;
          durationMs: number;
          azimuthTurns: number;
          elevationCycles: number;
          elevationAmplitudeDeg: number;
          radialPulseCycles: number;
          radialAmplitude: number;
        }>> = {
          quick: [
            { phase: 'slow', durationMs: 3500, azimuthTurns: 0.8, elevationCycles: 0.8, elevationAmplitudeDeg: 18, radialPulseCycles: 0.6, radialAmplitude: 0.04 },
            { phase: 'medium', durationMs: 2600, azimuthTurns: 1.1, elevationCycles: 1.1, elevationAmplitudeDeg: 24, radialPulseCycles: 0.85, radialAmplitude: 0.055 },
            { phase: 'fast', durationMs: 2000, azimuthTurns: 1.45, elevationCycles: 1.35, elevationAmplitudeDeg: 30, radialPulseCycles: 1.2, radialAmplitude: 0.07 },
          ],
          standard: [
            { phase: 'slow', durationMs: 9000, azimuthTurns: 1.1, elevationCycles: 1.0, elevationAmplitudeDeg: 22, radialPulseCycles: 0.8, radialAmplitude: 0.05 },
            { phase: 'medium', durationMs: 6000, azimuthTurns: 1.5, elevationCycles: 1.4, elevationAmplitudeDeg: 28, radialPulseCycles: 1.15, radialAmplitude: 0.07 },
            { phase: 'fast', durationMs: 4200, azimuthTurns: 2.1, elevationCycles: 1.9, elevationAmplitudeDeg: 34, radialPulseCycles: 1.6, radialAmplitude: 0.09 },
          ],
          torture: [
            { phase: 'slow', durationMs: 14000, azimuthTurns: 1.6, elevationCycles: 1.35, elevationAmplitudeDeg: 26, radialPulseCycles: 1.1, radialAmplitude: 0.07 },
            { phase: 'medium', durationMs: 10500, azimuthTurns: 2.4, elevationCycles: 2.0, elevationAmplitudeDeg: 34, radialPulseCycles: 1.8, radialAmplitude: 0.1 },
            { phase: 'fast', durationMs: 8200, azimuthTurns: 3.35, elevationCycles: 2.7, elevationAmplitudeDeg: 40, radialPulseCycles: 2.4, radialAmplitude: 0.13 },
          ],
        };

        const phases = phaseProfilesByStress[stressProfile] ?? phaseProfilesByStress.standard;

        const phaseResults: DiagnosticsBenchmarkPhaseResult[] = [];
        const allSamplesMs: number[] = [];

        let phaseStartAzimuth = initialAzimuth;
        for (const phaseConfig of phases) {
          if (benchmarkRunIdRef.current !== requestId) {
            throw new Error('Benchmark interrupted.');
          }

          const phaseSamples: number[] = [];
          const phaseStartTime = performance.now();
          let lastFrameTs: number | null = null;

          await new Promise<void>((resolve) => {
            const tick = (now: number) => {
              if (benchmarkRunIdRef.current !== requestId) {
                resolve();
                return;
              }

              const elapsed = now - phaseStartTime;
              const t = Math.min(1, elapsed / phaseConfig.durationMs);

              if (lastFrameTs != null) {
                const dt = Math.max(0, now - lastFrameTs);
                if (dt > 0) {
                  phaseSamples.push(dt);
                  allSamplesMs.push(dt);
                }
              }
              lastFrameTs = now;

              const azimuth = phaseStartAzimuth + (t * phaseConfig.azimuthTurns * Math.PI * 2);
              const elevationSwing = Math.sin((t * phaseConfig.elevationCycles * Math.PI * 2) + (phaseConfig.azimuthTurns * 0.5));
              const elevationAmp = THREE.MathUtils.degToRad(phaseConfig.elevationAmplitudeDeg);
              const elevation = THREE.MathUtils.clamp(
                initialElevation + (elevationSwing * elevationAmp),
                THREE.MathUtils.degToRad(-72),
                THREE.MathUtils.degToRad(72),
              );
              const radialPulse = 1 + (Math.sin((t * phaseConfig.radialPulseCycles * Math.PI * 2) + (phaseConfig.elevationCycles * 0.7)) * phaseConfig.radialAmplitude);
              const radius = baseRadius3d * radialPulse;

              const cosElevation = Math.cos(elevation);
              const x = Math.cos(azimuth) * cosElevation * radius;
              const y = Math.sin(azimuth) * cosElevation * radius;
              const z = Math.sin(elevation) * radius;

              camera.position.set(center.x + x, center.y + y, center.z + z);
              controls.target.copy(center);
              controls.update();
              updateOrbitControlSpeeds();
              updateCameraBelowBuildPlate();
              onCameraChange?.();
              window.dispatchEvent(new Event('picking-orbit-change'));

              if (t < 1) {
                requestAnimationFrame(tick);
              } else {
                resolve();
              }
            };

            requestAnimationFrame(tick);
          });

          const phaseDuration = Math.max(0, performance.now() - phaseStartTime);
          const phaseStats = computeStats(phaseSamples, phaseDuration);
          phaseResults.push({ phase: phaseConfig.phase, stats: phaseStats });
          dispatchProgress({
            requestId,
            status: 'phase-complete',
            phase: phaseConfig.phase,
            message: `${phaseConfig.phase} sweep complete`,
          });

          phaseStartAzimuth += phaseConfig.azimuthTurns * Math.PI * 2;
        }

        const totalDurationMs = Math.max(0, performance.now() - startedAt);
        const finishedAtIso = new Date().toISOString();

        const result: DiagnosticsBenchmarkResult = {
          requestId,
          stressProfile,
          startedAtIso,
          finishedAtIso,
          totalDurationMs,
          projectionMode: cameraProjectionMode,
          cameraFeelPreset,
          phases: phaseResults,
          overall: computeStats(allSamplesMs, totalDurationMs),
        };

        dispatchProgress({ requestId, status: 'completed', result, message: 'Benchmark complete.' });
      } catch (error) {
        dispatchProgress({
          requestId,
          status: 'error',
          message: error instanceof Error ? error.message : 'Benchmark failed.',
        });
      } finally {
        restoreControls();
        orbitInteractionActiveRef.current = false;
        orbitInteractionMovedRef.current = false;
        setIsOrbitInteracting(false);
        updateCameraBelowBuildPlate();
        onCameraEnd?.();
        window.dispatchEvent(new CustomEvent('picking-orbit-end', {
          detail: { resumeAfterMs: navigationResumeDelayMs },
        }));
        benchmarkRunIdRef.current = null;
      }
    };

    const onBenchmarkRequest = (event: Event) => {
      const customEvent = event as CustomEvent<DiagnosticsBenchmarkRequestDetail>;
      const requestId = customEvent.detail?.requestId;
      const stressProfile = customEvent.detail?.stressProfile ?? 'standard';
      if (!requestId) return;
      void runBenchmark(requestId, stressProfile);
    };

    window.addEventListener(DIAGNOSTICS_BENCHMARK_REQUEST_EVENT, onBenchmarkRequest as EventListener);
    return () => {
      window.removeEventListener(DIAGNOSTICS_BENCHMARK_REQUEST_EVENT, onBenchmarkRequest as EventListener);
      benchmarkRunIdRef.current = null;
    };
  }, [
    cameraFeelPreset,
    navigationResumeDelayMs,
    cameraProjectionMode,
    modelWorldBounds,
    models,
    onCameraChange,
    onCameraEnd,
    updateCameraBelowBuildPlate,
    updateOrbitControlSpeeds,
  ]);

  const handleOrbitChange = React.useCallback(() => {
    if (orbitInteractionActiveRef.current) {
      orbitInteractionMovedRef.current = true;
    }

    if (orbitChangeQueuedRef.current) return;
    orbitChangeQueuedRef.current = true;

    orbitChangeRafRef.current = requestAnimationFrame(() => {
      orbitChangeRafRef.current = null;
      orbitChangeQueuedRef.current = false;

      const orbitActive = orbitInteractionActiveRef.current;
      if (orbitActive) {
        const rotating = isOrbitInRotateState();
        setIsOrbitRotating((prev) => (prev === rotating ? prev : rotating));
      }

      updateOrbitControlSpeeds();
      updateCameraBelowBuildPlate();
      onCameraChange?.();

      if (orbitActive) {
        window.dispatchEvent(new Event('picking-orbit-change'));
        if (!isOrbitInRotateState()) {
          window.dispatchEvent(new Event('picking-pan-change'));
        }
      }
    });
  }, [isOrbitInRotateState, onCameraChange, updateCameraBelowBuildPlate, updateOrbitControlSpeeds]);

  const handleSpaceMouseNavigationFrame = React.useCallback(() => {
    updateCameraBelowBuildPlate();
    onCameraChange?.();
    window.dispatchEvent(new Event('picking-pan-change'));
  }, [onCameraChange, updateCameraBelowBuildPlate]);

  React.useEffect(() => {
    return () => {
      if (orbitChangeRafRef.current !== null) {
        cancelAnimationFrame(orbitChangeRafRef.current);
        orbitChangeRafRef.current = null;
      }
      orbitChangeQueuedRef.current = false;
    };
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    type SupportGizmoWindowState = Window & {
      __jointGizmoDragging?: boolean;
      __knotGizmoDragging?: boolean;
      __bezierGizmoDragging?: boolean;
      __jointGizmoGuardUntil?: number;
      __knotGizmoGuardUntil?: number;
      __bezierGizmoGuardUntil?: number;
    };

    const clearPendingSupportGizmoTimeout = () => {
      if (supportGizmoInteractionTimeoutRef.current === null) return;
      window.clearTimeout(supportGizmoInteractionTimeoutRef.current);
      supportGizmoInteractionTimeoutRef.current = null;
    };

    const refreshSupportGizmoInteraction = () => {
      const w = window as SupportGizmoWindowState;
      const dragging = !!(w.__jointGizmoDragging || w.__knotGizmoDragging || w.__bezierGizmoDragging);
      const guardUntil = Math.max(
        Number(w.__jointGizmoGuardUntil ?? 0),
        Number(w.__knotGizmoGuardUntil ?? 0),
        Number(w.__bezierGizmoGuardUntil ?? 0),
      );
      const now = Date.now();
      const guardActive = guardUntil > now;

      setSupportGizmoInteractionActive(dragging || guardActive);
      clearPendingSupportGizmoTimeout();

      if (!dragging && guardActive) {
        supportGizmoInteractionTimeoutRef.current = window.setTimeout(() => {
          supportGizmoInteractionTimeoutRef.current = null;
          refreshSupportGizmoInteraction();
        }, Math.max(0, guardUntil - now + 1));
      }
    };

    const handleSupportGizmoInteractionLock = () => {
      refreshSupportGizmoInteraction();
    };

    refreshSupportGizmoInteraction();
    window.addEventListener('joint-gizmo-interaction-lock', handleSupportGizmoInteractionLock as EventListener);
    window.addEventListener('knot-gizmo-interaction-lock', handleSupportGizmoInteractionLock as EventListener);
    window.addEventListener('bezier-gizmo-interaction-lock', handleSupportGizmoInteractionLock as EventListener);

    return () => {
      window.removeEventListener('joint-gizmo-interaction-lock', handleSupportGizmoInteractionLock as EventListener);
      window.removeEventListener('knot-gizmo-interaction-lock', handleSupportGizmoInteractionLock as EventListener);
      window.removeEventListener('bezier-gizmo-interaction-lock', handleSupportGizmoInteractionLock as EventListener);
      clearPendingSupportGizmoTimeout();
    };
  }, []);

  const handleOrbitStart = React.useCallback(() => {
    orbitInteractionActiveRef.current = true;
    orbitInteractionMovedRef.current = false;
    const isRotateInteraction = isOrbitInRotateState();
    setIsOrbitRotating(isRotateInteraction);
    setIsOrbitInteracting(true);
    setMouseOrbitDragRunId((id) => id + 1);
    window.dispatchEvent(new Event('picking-orbit-start'));
    if (!isRotateInteraction) {
      window.dispatchEvent(new Event('picking-pan-start'));
    }
  }, [isOrbitInRotateState]);

  const handleOrbitEnd = React.useCallback(() => {
    const wasTrackpadGesture = trackpadGestureActionRef.current !== null;
    clearPendingTrackpadGestureEnd();
    trackpadGestureActionRef.current = null;
    if (mode === 'prepare' && orbitInteractionActiveRef.current && orbitInteractionMovedRef.current) {
      suppressNextCanvasClickRef.current = true;
    }
    orbitInteractionActiveRef.current = false;
    orbitInteractionMovedRef.current = false;
    setIsOrbitInteracting(false);
    setIsOrbitRotating(false);

    updateCameraBelowBuildPlate();
    onCameraEnd?.();
    window.dispatchEvent(new CustomEvent('picking-orbit-end', {
      detail: { resumeAfterMs: wasTrackpadGesture ? 0 : navigationResumeDelayMs },
    }));
    window.dispatchEvent(new CustomEvent('picking-pan-end', {
      detail: { resumeAfterMs: wasTrackpadGesture ? 0 : navigationResumeDelayMs },
    }));
  }, [clearPendingTrackpadGestureEnd, mode, navigationResumeDelayMs, onCameraEnd, updateCameraBelowBuildPlate]);

  const scheduleTrackpadGestureEnd = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    clearPendingTrackpadGestureEnd();
    trackpadGestureEndTimeoutRef.current = window.setTimeout(() => {
      trackpadGestureEndTimeoutRef.current = null;
      if (trackpadGestureActionRef.current === null) return;
      trackpadGestureActionRef.current = null;
      handleOrbitEnd();
    }, 140);
  }, [clearPendingTrackpadGestureEnd, handleOrbitEnd]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') return;

    const onTrackpadWheel = (event: WheelEvent) => {
      if (!container.contains(event.target as Node | null)) return;

      try {
        const action = resolveTrackpadGestureAction(
          event,
          cameraTrackpadSettings,
          cameraTrackpadModifierKey,
        );
        if (action === null) return;

        const controls = orbitControlsRef.current;
        if (!controls || controls.enabled === false) return;

        event.preventDefault();
        event.stopPropagation();

        if (!orbitInteractionActiveRef.current) {
          trackpadGestureActionRef.current = action;
          handleOrbitStart();
        } else {
          trackpadGestureActionRef.current = action;
        }

        if (!applyTrackpadGesture(action, event)) {
          trackpadGestureActionRef.current = null;
          handleOrbitEnd();
          return;
        }

        handleOrbitChange();
        scheduleTrackpadGestureEnd();
      } catch (error) {
        console.error('[SceneCanvas] Trackpad wheel handler failed; disabling current trackpad gesture frame.', error);
        trackpadGestureActionRef.current = null;
        clearPendingTrackpadGestureEnd();
      }
    };

    const forceTrackpadGestureEnd = () => {
      clearPendingTrackpadGestureEnd();
      if (trackpadGestureActionRef.current === null) return;
      trackpadGestureActionRef.current = null;
      handleOrbitEnd();
    };

    container.addEventListener('wheel', onTrackpadWheel, { capture: true, passive: false });
    window.addEventListener('blur', forceTrackpadGestureEnd);
    document.addEventListener('visibilitychange', forceTrackpadGestureEnd);

    return () => {
      container.removeEventListener('wheel', onTrackpadWheel, true);
      window.removeEventListener('blur', forceTrackpadGestureEnd);
      document.removeEventListener('visibilitychange', forceTrackpadGestureEnd);
      forceTrackpadGestureEnd();
    };
  }, [
    applyTrackpadGesture,
    cameraTrackpadModifierKey,
    cameraTrackpadSettings,
    clearPendingTrackpadGestureEnd,
    handleOrbitChange,
    handleOrbitEnd,
    handleOrbitStart,
    scheduleTrackpadGestureEnd,
  ]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const suppressViewportContextMenu = (event: MouseEvent) => {
      if (!container.contains(event.target as Node | null)) return;
      event.preventDefault();
    };

    container.addEventListener('contextmenu', suppressViewportContextMenu, true);
    return () => {
      container.removeEventListener('contextmenu', suppressViewportContextMenu, true);
    };
  }, []);

  const handleWebGlContextLost = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    handleOrbitEnd();
    forceEndWheelZoomInteraction();
    setIsGizmoDragging(false);
    setIsGizmoRetargeting(false);
    setActiveGizmoDragDescriptor(null);
    setGizmoGroupStartSnapshot(null);
    setIsPostGizmoInteractionGuardActive(false);
    setSupportGizmoInteractionActive(false);
    gizmoTransformStartSnapshotRef.current = null;
    liveDragTransformRef.current = null;
    queueLiveDragTransform(null);
    dragMoveLockZEnabledRef.current = false;
    dragMoveLockedZRef.current = 0;
    clearDragCornerCageBaseData();
    setInteractionResetNonce((value) => value + 1);

    if (webGlRecoveryTimeoutRef.current !== null) return;

    webGlRecoveryTimeoutRef.current = window.setTimeout(() => {
      webGlRecoveryTimeoutRef.current = null;
      console.warn('[SceneCanvas] WebGL context restore timeout reached; remounting canvas.');
      setCanvasRecoveryNonce((value) => value + 1);
    }, 1800);
  }, [clearDragCornerCageBaseData, forceEndWheelZoomInteraction, handleOrbitEnd, queueLiveDragTransform]);

  const handleWebGlContextRestored = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    if (webGlRecoveryTimeoutRef.current !== null) {
      window.clearTimeout(webGlRecoveryTimeoutRef.current);
      webGlRecoveryTimeoutRef.current = null;
    }

    orbitControlsRef.current?.update();
    updateCameraBelowBuildPlate();
    onCameraChange?.();
  }, [onCameraChange, updateCameraBelowBuildPlate]);

  React.useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      if (webGlRecoveryTimeoutRef.current !== null) {
        window.clearTimeout(webGlRecoveryTimeoutRef.current);
        webGlRecoveryTimeoutRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (!freezeViewportActive) {
      freezeCaptureArmedRef.current = false;
      if (frozenViewportDataUrl !== null) {
        setFrozenViewportDataUrl(null);
      }
      return;
    }

    if (freezeCaptureArmedRef.current) return;
    freezeCaptureArmedRef.current = true;

    let rafId = 0;
    let attempts = 0;
    const maxAttempts = 12;

    const tryCapture = () => {
      if (!freezeViewportActive) return;
      const canvas = rendererRef.current?.domElement;
      if (!canvas) {
        attempts += 1;
        if (attempts < maxAttempts) {
          rafId = requestAnimationFrame(tryCapture);
        }
        return;
      }

      try {
        const snapshot = canvas.toDataURL('image/png');
        if (snapshot && snapshot.length > 64) {
          setFrozenViewportDataUrl(snapshot);
        }
      } catch {
        // If snapshot capture fails, keep UI functional and simply skip freeze overlay.
      }
    };

    rafId = requestAnimationFrame(tryCapture);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [freezeViewportActive, frozenViewportDataUrl]);

  React.useEffect(() => {
    if (spaceMouseNavigationActive) {
      window.dispatchEvent(new Event('picking-pan-start'));
      return;
    }

    window.dispatchEvent(new CustomEvent('picking-pan-end', {
      detail: { resumeAfterMs: navigationResumeDelayMs },
    }));
  }, [navigationResumeDelayMs, spaceMouseNavigationActive]);

  const {
    thumbnailCaptureActive,
    includeHelpersGridDuringCapture,
    includeBuildPlateDuringCapture,
  } = useExportThumbnailCapture({
    models,
    meshColor,
    modelWorldBounds,
    computeModelWorldBounds,
    buildVolumeBounds,
    activeTransformOverrideModelId,
    transform,
    defaultCamera,
    rendererRef,
    sceneRef,
    cameraRef,
    buildVolumeBoundsOverlayRef,
    selectedTintColor,
    selectedTintStrength,
    exportThumbnailRenderOptions,
    onRegisterExportThumbnailCapture,
  });

  React.useEffect(() => {
    const forceOrbitEndIfActive = () => {
      if (!orbitInteractionActiveRef.current) return;
      handleOrbitEnd();
    };

    const suppressContextMenuDuringOrbit = (event: Event) => {
      if (orbitInteractionActiveRef.current) {
        event.preventDefault();
      }
      forceOrbitEndIfActive();
    };

    window.addEventListener('pointerup', forceOrbitEndIfActive, true);
    window.addEventListener('pointercancel', forceOrbitEndIfActive, true);
    window.addEventListener('mouseup', forceOrbitEndIfActive, true);
    window.addEventListener('contextmenu', suppressContextMenuDuringOrbit, true);
    window.addEventListener('blur', forceOrbitEndIfActive);
    document.addEventListener('visibilitychange', forceOrbitEndIfActive);

    return () => {
      window.removeEventListener('pointerup', forceOrbitEndIfActive, true);
      window.removeEventListener('pointercancel', forceOrbitEndIfActive, true);
      window.removeEventListener('mouseup', forceOrbitEndIfActive, true);
      window.removeEventListener('contextmenu', suppressContextMenuDuringOrbit, true);
      window.removeEventListener('blur', forceOrbitEndIfActive);
      document.removeEventListener('visibilitychange', forceOrbitEndIfActive);
    };
  }, [handleOrbitEnd]);

  const markGizmoDragEnded = React.useCallback((expectParentTransaction = true) => {
    window.__gizmoDragEndedThisFrame = true;
    suppressNextCanvasClickRef.current = true;
    setIsPostGizmoInteractionGuardActive(true);
    armSupportDragDeltaBridge({ expectParentTransaction });

    if (postGizmoInteractionTimeoutRef.current !== null) {
      window.clearTimeout(postGizmoInteractionTimeoutRef.current);
      postGizmoInteractionTimeoutRef.current = null;
    }

    postGizmoInteractionTimeoutRef.current = window.setTimeout(() => {
      window.__gizmoDragEndedThisFrame = false;
      setIsPostGizmoInteractionGuardActive(false);
      postGizmoInteractionTimeoutRef.current = null;
    }, 160);
  }, [armSupportDragDeltaBridge]);

  React.useEffect(() => {
    return () => {
      if (postGizmoInteractionTimeoutRef.current !== null) {
        window.clearTimeout(postGizmoInteractionTimeoutRef.current);
      }
    };
  }, []);

  const captureActiveGroupTransform = React.useCallback(() => {
    const group = activeGroupRef.current;
    if (!group) return null;

    return {
      position: group.position.clone(),
      rotation: new THREE.Euler().setFromQuaternion(group.quaternion, 'ZYX'),
      scale: group.scale.clone(),
    };
  }, [activeGroupRef]);

  const pendingTransformChangeRef = React.useRef<{
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  } | null>(null);
  const pendingTransformChangeRafRef = React.useRef<number | null>(null);

  const flushPendingTransformChange = React.useCallback(() => {
    if (pendingTransformChangeRafRef.current !== null) {
      cancelAnimationFrame(pendingTransformChangeRafRef.current);
      pendingTransformChangeRafRef.current = null;
    }

    const pending = pendingTransformChangeRef.current;
    if (!pending || !onTransformChange) return;

    pendingTransformChangeRef.current = null;
    onTransformChange(pending.position, pending.rotation, pending.scale);
  }, [onTransformChange]);

  const scheduleTransformChange = React.useCallback((live: {
    position: THREE.Vector3;
    rotation: THREE.Euler;
    scale: THREE.Vector3;
  }) => {
    if (!onTransformChange) return;

    pendingTransformChangeRef.current = {
      position: live.position.clone(),
      rotation: live.rotation.clone(),
      scale: live.scale.clone(),
    };

    if (pendingTransformChangeRafRef.current !== null) return;

    pendingTransformChangeRafRef.current = requestAnimationFrame(() => {
      pendingTransformChangeRafRef.current = null;
      const pending = pendingTransformChangeRef.current;
      if (!pending) return;
      pendingTransformChangeRef.current = null;
      onTransformChange(pending.position, pending.rotation, pending.scale);
    });
  }, [onTransformChange]);

  React.useEffect(() => {
    return () => {
      if (pendingTransformChangeRafRef.current !== null) {
        cancelAnimationFrame(pendingTransformChangeRafRef.current);
      }
      pendingTransformChangeRafRef.current = null;
      pendingTransformChangeRef.current = null;
    };
  }, []);

  const [showCrossSectionCapDebugPanel, setShowCrossSectionCapDebugPanel] = React.useState(false);
  const [crossSectionCapDebugState, setCrossSectionCapDebugState] = React.useState<CrossSectionCapDebugPanelState>(
    DEFAULT_CROSS_SECTION_CAP_DEBUG_STATE,
  );

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(CROSS_SECTION_CAP_DEBUG_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<CrossSectionCapDebugPanelState>;
      setCrossSectionCapDebugState((prev) => ({
        enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : prev.enabled,
        top: { ...prev.top, ...(parsed.top ?? {}) },
        bottom: { ...prev.bottom, ...(parsed.bottom ?? {}) },
      }));
    } catch {
      // Ignore malformed debug state.
    }
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(CROSS_SECTION_CAP_DEBUG_STORAGE_KEY, JSON.stringify(crossSectionCapDebugState));
    } catch {
      // Ignore storage write failures in temporary debug tooling.
    }
  }, [crossSectionCapDebugState]);

  React.useEffect(() => {
    if (!CROSS_SECTION_CAP_DEBUG_HOTKEY_ENABLED) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const isToggle = event.ctrlKey
        && event.shiftKey
        && (event.code === 'KeyK' || event.key.toLowerCase() === 'k');
      if (!isToggle) return;
      event.preventDefault();
      event.stopPropagation();
      setShowCrossSectionCapDebugPanel((prev) => !prev);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  const topCapDebugOverrides = crossSectionCapDebugState.enabled
    ? crossSectionCapDebugState.top
    : undefined;
  const bottomCapDebugOverrides = crossSectionCapDebugState.enabled
    ? crossSectionCapDebugState.bottom
    : undefined;

  return (
    <div
      style={{ width: '100%', height: '100%', position: 'relative' }}
      onClick={handleCanvasClick}
      onPointerDownCapture={handleMarqueePointerDownCapture}
      onPointerMoveCapture={handleMarqueePointerMoveCapture}
      onPointerUpCapture={endMarqueeSelection}
      onPointerCancelCapture={endMarqueeSelection}
      ref={containerRef}
    >
      <Canvas
        key={`scene-canvas-${canvasRecoveryNonce}`}
        style={{ width: '100%', height: '100%', backgroundColor: '#181a22', display: 'block' }}
        camera={defaultCamera}
        shadows={!isLinux}
        dpr={dynamicDpr}
        gl={{ stencil: true, logarithmicDepthBuffer: false, powerPreference: 'high-performance' }}
        onPointerMissed={handleScenePointerMissed}
      >
        <SceneRenderBindings
          rendererRef={rendererRef}
          sceneRef={sceneRef}
          onWebGlContextLost={handleWebGlContextLost}
          onWebGlContextRestored={handleWebGlContextRestored}
        />
        <LoggingHelper mode={mode} />
        
        <Lights
          ambientIntensity={ambientIntensity ?? 1.2}
          directionalIntensity={directionalIntensity ?? 0.3}
          headlightIntensity={headlightIntensity ?? 1.0}
        />
        <Helpers
          gridWidthMm={activeBuildVolumeSettings.widthMm}
          gridDepthMm={activeBuildVolumeSettings.depthMm}
          originMinX={activeBuildVolumeSettings.originMode === 'front_left' ? 0 : -activeBuildVolumeSettings.widthMm * 0.5}
          originMinY={activeBuildVolumeSettings.originMode === 'front_left' ? 0 : -activeBuildVolumeSettings.depthMm * 0.5}
          buildPlateOpacity={(!thumbnailCaptureActive || includeBuildPlateDuringCapture) ? buildPlateOpacity : 0}
          showGrid={!thumbnailCaptureActive || includeHelpersGridDuringCapture}
          showBuildPlate={!thumbnailCaptureActive || includeBuildPlateDuringCapture}
          safetyMarginMm={activeBuildVolumeSettings.safetyMarginMm}
        />
        <EnableLocalClipping enabled={clipLower != null || clipUpper != null || indicatorPlaneZ != null} />
        <CameraProvider cameraRef={cameraRef} />
        <CameraProjectionController mode={cameraProjectionMode} />
        <CameraClipPlaneStabilizer />
        {/* GPU Picking Provider - wraps all pickable content when enabled */}
        <PickingProviderWrapper enabled={gpuPickingTest} mode={mode} transformMode={transformMode}>
          <PickingStateSyncer />
          <PickingEmptySpaceHoverResetter enabled={mode === 'prepare' || mode === 'support'} />

          {/* Selection Provider - manages model selection state */}
          <SelectionProvider initialSelection={activeModelId || 'default-model'}>
            <SelectionSync activeModelId={activeModelId ?? null} />
            {/* Selection Manager - handles click-to-select/deselect logic */}
            <SelectionManager enabled={mode === 'prepare'} mode={mode} handleCanvasDeselect={false} />

            <React.Suspense fallback={null}>
              {models.map((model) => {
                const meshGroupRefCallback = meshGroupRefCallbacks.current[model.id]
                  ?? ((node: THREE.Group | null) => {
                    meshRefs.current[model.id] = node;
                  });
                if (!meshGroupRefCallbacks.current[model.id]) {
                  meshGroupRefCallbacks.current[model.id] = meshGroupRefCallback;
                }

                const actualMeshRefCallback = actualMeshRefCallbacks.current[model.id]
                  ?? ((node: THREE.Mesh | null) => {
                    actualMeshRefs.current[model.id] = node;
                  });
                if (!actualMeshRefCallbacks.current[model.id]) {
                  actualMeshRefCallbacks.current[model.id] = actualMeshRefCallback;
                }

                const isCaptureTintModel = thumbnailCaptureActive && model.visible;
                const isActive = isCaptureTintModel || model.id === activeModelId;
                const isSelectedModel = isCaptureTintModel || selectedModelIdSet.has(model.id);
                const isMarqueeCandidate = isMarqueeSelecting && marqueeCandidateIdSet.has(model.id);
                const suppressModelInteraction = isGizmoDragging || isPostGizmoInteractionGuardActive || supportGizmoInteractionActive || isOrbitInteracting || isWheelZoomInteracting || spaceMouseNavigationActive;
                const interactionLodEnabled = (isOrbitInteracting || isWheelZoomInteracting || spaceMouseNavigationActive) && !isActive;
                const supportNonSelectedOpacity = mode === 'support' && !!activeModelId && !isActive ? 0.5 : undefined;
                const shouldHideDuplicateSourceModel = Boolean(
                  hideDuplicateSourceDuringApply
                  && duplicatePreviewModel
                  && model.id === duplicatePreviewModel.id,
                );
                // Use live drag transform only during active/guarded gizmo interaction.
                // Otherwise stale refs can mask immediate panel-driven updates (e.g. reset scale).
                const liveDragTransformForRender = (
                  isGizmoDragging
                  || isGizmoRetargeting
                  || isPostGizmoInteractionGuardActive
                )
                  ? liveDragTransformRef.current
                  : null;

                // Use props.transform if active (for smooth drag), else model.transform
                const rawActiveTransformForRender = liveDragTransformForRender
                  ?? (isMultiGizmoSelection
                    ? (liveActiveTransformForMultiPreview ?? model.transform)
                    : (transform ?? model.transform));
                const shouldApplyLiveLiftAlignment =
                  isGizmoDragging
                  || isGizmoRetargeting
                  || isPostGizmoInteractionGuardActive;
                const activeTransformForRender = isActive
                  ? (shouldApplyLiveLiftAlignment
                    ? (alignLiveTransformToLift(model, rawActiveTransformForRender) ?? rawActiveTransformForRender)
                    : rawActiveTransformForRender)
                  : rawActiveTransformForRender;
                const transformToUse = isActive
                  ? (duplicateActivePreviewTransform ?? activeTransformForRender)
                  : (multiGizmoPreviewTransformsById[model.id] ?? model.transform);
                const dropOffsetZ = entryDropOffsets[model.id] ?? 0;
                const animatedTransform = dropOffsetZ > 0
                  ? {
                    position: transformToUse.position.clone().add(new THREE.Vector3(0, 0, dropOffsetZ)),
                    rotation: transformToUse.rotation,
                    scale: transformToUse.scale,
                  }
                  : transformToUse;
                const showOutOfBoundsOverlay = !!activeBuildVolumeSettings?.enabled
                  && outOfBoundsModelIds.has(model.id)
                  && !interactionLodEnabled;
                // Use per-model visibility
                if (!model.visible) return null;
                if (shouldHideDuplicateSourceModel) return null;
                if (arrangeArraySourceModelIdSet.has(model.id)) return null;

                return (
                  <React.Fragment key={model.id}>
                    <StlMesh
                      modelId={model.id}
                      geometry={model.geometry.geometry}
                      clipLower={clipLower}
                      clipUpper={clipUpper}
                      meshColor={model.color || meshColor} // Use model color
                      meshRef={meshGroupRefCallback}
                      actualMeshRef={actualMeshRefCallback}
                      materialRoughness={materialRoughness}
                      shaderType={shaderType ?? 'soft_clay'}
                      matcapVariant={matcapVariant}
                      flatUseVertexColors={flatUseVertexColors}
                      toonSteps={toonSteps}
                      xrayOpacity={xrayOpacity}
                      heatmapBlend={heatmapBlend}
                      heatmapContrast={heatmapContrast}
                      heatmapColors={heatmapColors ?? emptyHeatmapColors}
                      transform={animatedTransform}
                      mode={mode}
                      transformMode={transformMode}
                      isActiveModel={isActive}
                      onSmoothingGeometryActivate={onSmoothingGeometryActivate}
                      onSupportClick={onSupportClick}
                      onSupportHover={handleSupportHover}
                      onActiveModelChange={onActiveModelChange}
                      disableRaycast={disableRaycast}
                      blockSupportPlacement={isGizmoDragging || blockSupportPlacement}
                      suppressNextClickRef={suppressNextCanvasClickRef}
                      isSelected={
                        isCaptureTintModel ||
                        (
                          isSelectedModel &&
                          effectiveModelSelected && (selectionHighlightMode === 'tint' || selectionHighlightMode === 'spotlight')
                        )
                      }
                      isMarqueeCandidate={isMarqueeCandidate}
                      isBranchPlacementActive={isBranchPlacementActive}
                      isLeafPlacementActive={isLeafPlacementActive}
                      isBracePlacementActive={isBracePlacementActive}
                      onModelHoverPointChange={onModelHoverPointChange}
                      onModelHoverModelChange={onModelHoverModelChange}
                      hoverTintColor={hoverTintColor}
                      selectedTintColor={selectedTintColor}
                      hoverTintStrength={hoverTintStrength}
                      selectedTintStrength={selectedTintStrength}
                      supportNonSelectedOpacity={supportNonSelectedOpacity}
                      interactionLodActive={interactionLodEnabled}
                      showOutOfBoundsOverlay={showOutOfBoundsOverlay}
                      outOfBoundsMin={shaderOutOfBoundsBounds?.min ?? null}
                      outOfBoundsMax={shaderOutOfBoundsBounds?.max ?? null}
                      outOfBoundsStripeColor={outOfBoundsStripeColor}
                      supportPlacementGuidePlaneZ={!thumbnailCaptureActive && isActive ? supportPlacementIndicatorPlaneZ : null}
                      supportPlacementGuideColor="#baf72e"
                      supportPlacementGuideLineWidthMm={supportPlacementGuideLineWidthMm}
                      supportPlacementGuideOpacity={0.62}
                      suppressModelInteraction={suppressModelInteraction}
                      isExternallyHovered={hoveredModelId === model.id}
                      deferExternalTransformUpdates={
                        isActive
                        && mode === 'prepare'
                        && transformMode === 'transform'
                        && !!liveDragTransformRef.current
                        && (isGizmoDragging || isPostGizmoInteractionGuardActive)
                      }
                    >
                      {useActiveModelAttachedSupportProxy && isActive && (
                        <group
                          matrix={activeModelAttachedSupportLocalMatrix ?? undefined}
                          matrixAutoUpdate={false}
                        >
                          <ModelAttachedSupportLayer
                            mode={mode}
                            modelFilterId={model.id}
                            hideRaftPrimitives={hideRaftPrimitives}
                            hidePlateContactPrimitives={hidePlateContactPrimitives}
                            clipLower={clipLower}
                            clipUpper={clipUpper}
                            supportColorsByModelId={supportColorsByModelId}
                            hoverTintColor={supportHoverTintColor}
                            hoverTintStrength={hoverTintStrength}
                            selectedTintStrength={selectedTintStrength}
                            activeModelId={activeModelId}
                            selectedModelIds={selectedModelIds}
                            hoverModelId={hoveredModelId}
                            modelDropOffsetsById={entryDropOffsets}
                            navigationLodActive={navigationLodActive}
                            disableSelectionAndHover={supportCreationModeActive || suppressSupportSelectionAndHover}
                            raftColorized={raftColorized}
                            raftHoverized={raftHoverized}
                            passive
                            supportRenderRefreshNonce={supportRenderRefreshNonce}
                            showOutOfBoundsOverlay={showOutOfBoundsOverlay}
                            outOfBoundsMin={shaderOutOfBoundsBounds?.min ?? null}
                            outOfBoundsMax={shaderOutOfBoundsBounds?.max ?? null}
                            outOfBoundsStripeColor={outOfBoundsStripeColor}
                          />
                        </group>
                      )}
                    </StlMesh>

                  </React.Fragment>
                );
              })}

              {duplicatePreviewModel
                && effectiveDuplicatePreviewTransforms.length > 0
                ? (
                  <GhostPreviewInstances
                    geometry={duplicatePreviewModel.geometry.geometry}
                    center={duplicatePreviewModel.geometry.center}
                    color={duplicatePreviewModel.color ?? '#a3a3a3'}
                    transforms={effectiveDuplicatePreviewTransforms}
                    opacity={0.22}
                    renderOrder={2}
                  />
                )
                : null}

              {renderSupportGhostPreviews
                && duplicatePreviewModel
                && duplicateSupportPreviewDeltas.length > 0
                ? duplicateSupportPreviewDeltas.map((deltaMatrix, index) => (
                    <group
                      key={`duplicate-support-preview-${index}`}
                      matrix={deltaMatrix}
                      matrixAutoUpdate={false}
                      raycast={() => null}
                    >
                      <ModelAttachedSupportLayer
                        mode={mode}
                        navigationLodActive
                        hideRaftPrimitives={hideRaftPrimitives}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                        clipLower={clipLower}
                        clipUpper={clipUpper}
                        supportColorsByModelId={supportColorsByModelId}
                        hoverTintColor={supportHoverTintColor}
                        hoverTintStrength={hoverTintStrength}
                        selectedTintStrength={selectedTintStrength}
                        activeModelId={null}
                        selectedModelIds={emptySelectedModelIds}
                        hoverModelId={null}
                        modelDropOffsetsById={emptyModelDropOffsets}
                        modelFilterId={duplicatePreviewModel.id}
                        ghostOpacity={0.3}
                        ghostRenderOrder={2}
                        disableSelectionAndHover
                        raftColorized={false}
                        raftHoverized={false}
                        passive
                        supportProxyIncludeDetailedPrimitives={!useSimplifiedSupportGhostProxy}
                        supportRenderRefreshNonce={supportRenderRefreshNonce}
                      />
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
                    quaternion={quaternionFromGlobalEuler(duplicateActivePreviewTransform.rotation)}
                    scale={duplicateActivePreviewTransform.scale}
                    raycast={() => null}
                  >
                    <mesh
                      geometry={duplicatePreviewModel.geometry.geometry}
                      position={duplicatePreviewMeshOffset}
                      raycast={() => null}
                      renderOrder={2}
                    >
                      <meshBasicMaterial
                        color={duplicatePreviewModel.color ?? '#a3a3a3'}
                        transparent
                        opacity={0.22}
                        depthWrite={false}
                        toneMapped={false}
                      />
                    </mesh>
                  </group>
                )
                : null}

              {arrangeGhostPreviewGroups.length > 0
                ? arrangeGhostPreviewGroups.map((group) => (
                  <GhostPreviewInstances
                    key={`arrange-array-preview-${group.model.id}`}
                    geometry={group.model.geometry.geometry}
                    center={group.model.geometry.center}
                    color={group.model.color ?? '#a3a3a3'}
                    transforms={group.transforms}
                    opacity={0.22}
                    renderOrder={2}
                  />
                ))
                : null}

              {renderDuplicateSourceSupportGhostPreview
                && duplicatePreviewModel
                && duplicateActiveSupportPreviewDelta
                ? (
                    <group
                      key="duplicate-source-support-preview"
                      matrix={duplicateActiveSupportPreviewDelta}
                      matrixAutoUpdate={false}
                      raycast={() => null}
                    >
                      <ModelAttachedSupportLayer
                        mode={mode}
                        navigationLodActive
                        hideRaftPrimitives={hideRaftPrimitives}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                        clipLower={clipLower}
                        clipUpper={clipUpper}
                        supportColorsByModelId={supportColorsByModelId}
                        hoverTintColor={supportHoverTintColor}
                        hoverTintStrength={hoverTintStrength}
                        selectedTintStrength={selectedTintStrength}
                        activeModelId={null}
                        selectedModelIds={emptySelectedModelIds}
                        hoverModelId={null}
                        modelDropOffsetsById={emptyModelDropOffsets}
                        modelFilterId={duplicatePreviewModel.id}
                        ghostOpacity={0.3}
                        ghostRenderOrder={2}
                        disableSelectionAndHover
                        raftColorized={false}
                        raftHoverized={false}
                        passive
                        supportProxyIncludeDetailedPrimitives={!useSimplifiedSupportGhostProxy}
                        supportRenderRefreshNonce={supportRenderRefreshNonce}
                      />
                    </group>
                  )
                : null}

              {renderSupportGhostPreviews && arrangeSupportPreviewDeltas.length > 0
                ? arrangeSupportPreviewDeltas.map(({ modelId, delta }) => (
                    <group
                      key={`arrange-support-preview-${modelId}`}
                      matrix={delta}
                      matrixAutoUpdate={false}
                      raycast={() => null}
                    >
                      <ModelAttachedSupportLayer
                        mode={mode}
                        navigationLodActive
                        hideRaftPrimitives={hideRaftPrimitives}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                        clipLower={clipLower}
                        clipUpper={clipUpper}
                        supportColorsByModelId={supportColorsByModelId}
                        hoverTintColor={supportHoverTintColor}
                        hoverTintStrength={hoverTintStrength}
                        selectedTintStrength={selectedTintStrength}
                        activeModelId={null}
                        selectedModelIds={emptySelectedModelIds}
                        hoverModelId={null}
                        modelDropOffsetsById={emptyModelDropOffsets}
                        modelFilterId={modelId}
                        ghostOpacity={0.45}
                        ghostRenderOrder={2}
                        disableSelectionAndHover
                        raftColorized={false}
                        raftHoverized={false}
                        passive
                        supportProxyIncludeDetailedPrimitives={!useSimplifiedSupportGhostProxy}
                        supportRenderRefreshNonce={supportRenderRefreshNonce}
                      />
                    </group>
                  ))
                : null}

              {activeBuildVolumeSettings.showModelBoundingBoxes && !thumbnailCaptureActive
                ? modelBoundingBoxDebugData.map((entry) => (
                  <lineSegments key={`model-bounds-debug-${entry.id}`} renderOrder={30} raycast={() => null}>
                    <bufferGeometry>
                      <bufferAttribute
                        attach="attributes-position"
                        args={[entry.positions, 3]}
                      />
                    </bufferGeometry>
                    <lineBasicMaterial
                      color={entry.color}
                      transparent
                      opacity={0.9}
                      depthWrite={false}
                      depthTest
                    />
                  </lineSegments>
                ))
                : null}

              {!thumbnailCaptureActive && dragCornerCageModelIds.length > 0
                ? dragCornerCageModelIds.map((modelId) => (
                    <lineSegments
                      key={`drag-corner-cage-${modelId}`}
                      ref={(node) => {
                        dragCornerCageRefs.current[modelId] = node;
                      }}
                      renderOrder={31}
                      raycast={() => null}
                    >
                      <bufferGeometry>
                        <bufferAttribute
                          attach="attributes-position"
                          args={[buildEmptyCornerOnlyWireframePositions(), 3]}
                        />
                      </bufferGeometry>
                      <lineBasicMaterial
                        color={modelId === activeModelId ? '#baf72e' : '#8be63d'}
                        transparent
                        opacity={0.86}
                        blending={THREE.AdditiveBlending}
                        toneMapped={false}
                        depthWrite={false}
                        depthTest={false}
                      />
                    </lineSegments>
                  ))
                : null}

              {!thumbnailCaptureActive && activeBuildVolumeSettings?.enabled && buildVolumeBoxGeometry && buildVolumeEdgeGeometry && (
                <group
                  ref={buildVolumeBoundsOverlayRef}
                  userData={{ thumbnailHelperType: 'buildVolumeOverlay' }}
                  renderOrder={28}
                  position={[
                    (buildVolumeBounds!.min.x + buildVolumeBounds!.max.x) * 0.5,
                    (buildVolumeBounds!.min.y + buildVolumeBounds!.max.y) * 0.5,
                    activeBuildVolumeSettings.maxZMm * 0.5,
                  ]}
                  raycast={() => null}
                >
                  <mesh geometry={buildVolumeBoxGeometry} raycast={() => null} renderOrder={27}>
                    <meshBasicMaterial
                      color={outOfBoundsModels.length > 0 ? '#ff5b6f' : '#78b7ff'}
                      transparent
                      opacity={0.04}
                      depthWrite={false}
                      side={THREE.BackSide}
                    />
                  </mesh>
                  <lineSegments geometry={buildVolumeEdgeGeometry} renderOrder={29} raycast={() => null}>
                    <lineBasicMaterial
                      color={outOfBoundsModels.length > 0 ? '#ff5b6f' : '#8abfff'}
                      transparent
                      opacity={0.36}
                      depthWrite={false}
                      depthTest
                    />
                  </lineSegments>
                </group>
              )}

              {/* Raft system (Crenelated) - uses supports roots + active model footprint */}
              {/* Wrap all support/raft geometry in a drag group so they move as one during gizmo drags */}
              <group ref={supportDragGroupRef ?? undefined}>
              {!useActiveModelAttachedSupportProxy && (
                <ModelAttachedSupportLayer
                  mode={mode}
                  excludeModelId={duplicateSourceSupportPreviewModelId}
                  excludeModelIds={supportBaseExcludeModelIds}
                  hideRaftPrimitives={hideRaftPrimitives}
                  hideRaftPrimitivesForInactiveModels={mode === 'support' && !!activeModelId}
                  hidePlateContactPrimitives={hidePlateContactPrimitives}
                  clipLower={clipLower}
                  clipUpper={clipUpper}
                  supportColorsByModelId={supportColorsByModelId}
                  hoverTintColor={supportHoverTintColor}
                  hoverTintStrength={hoverTintStrength}
                  selectedTintStrength={selectedTintStrength}
                  activeModelId={activeModelId}
                  selectedModelIds={selectedModelIds}
                  hoverModelId={hoveredModelId}
                  modelDropOffsetsById={entryDropOffsets}
                  navigationLodActive={navigationLodActive}
                  disableSelectionAndHover={supportCreationModeActive || suppressSupportSelectionAndHover}
                  raftColorized={raftColorized}
                  raftHoverized={raftHoverized}
                  onModelPointerSelect={(modelId) => selectModelFromPointerHit(modelId)}
                  supportRendererRef={supportsRef as React.Ref<THREE.Group>}
                  supportRenderRefreshNonce={supportRenderRefreshNonce}
                  showOutOfBoundsOverlay={!!activeBuildVolumeSettings?.enabled && outOfBoundsModelIds.size > 0}
                  outOfBoundsMin={shaderOutOfBoundsBounds?.min ?? null}
                  outOfBoundsMax={shaderOutOfBoundsBounds?.max ?? null}
                  outOfBoundsStripeColor={outOfBoundsStripeColor}
                  trunkPlacementPreview={trunkPlacementPreviewForRenderer}
                  branchPlacementPreview={branchPlacementPreviewForRenderer}
                  leafPlacementPreview={leafPlacementPreviewForRenderer}
                  bracePlacementPreview={bracePlacementPreviewForRenderer}
                  kickstandPlacementPreview={kickstandPlacementPreviewForRenderer}
                />
              )}
              </group>{/* end supportDragGroupRef */}

              {(clipUpper != null || indicatorPlaneZ != null) && !hideCrossSectionCap && (
                <CrossSectionStencilCap
                  key="cross-section-cap-top"
                  entries={crossSectionCapEntries}
                  sourceObject={supportDragGroupRef?.current ?? null}
                  sourceObjectVersion={clipUpper != null ? crossSectionStencilSourceVersion : undefined}
                  // During slider scrubbing, avoid expensive source z-bound
                  // traversal/bucketing work. Stencil clipping still constrains
                  // fragments correctly, so this is a safe CPU optimization.
                  skipSourceZBounds={clipUpper == null || isLayerScrubbing}
                  y={(clipUpper ?? indicatorPlaneZ)!}
                  otherClipY={clipLower}
                  color={clipUpper != null ? '#FFFFFF' : (indicatorPlaneColor ?? '#ec2a77')}
                  planeWidthMm={crossSectionPlaneWidthMm}
                  planeHeightMm={crossSectionPlaneHeightMm}
                  capOpacity={clipUpper != null ? 1 : 0.78}
                  capDepthTest={clipUpper != null}
                  glowThicknessMm={clipUpper != null ? 0 : 0.11}
                  glowOpacity={clipUpper != null ? 0 : 0.44}
                  glowColor={clipUpper != null ? undefined : (indicatorPlaneColor ?? '#ec2a77')}
                  visible={!hideCrossSectionCap && (clipUpper != null || indicatorPlaneZ != null)}
                  debugOverrides={topCapDebugOverrides}
                />
              )}

              {clipLower != null && !hideCrossSectionCap && (
                <CrossSectionStencilCap
                  key="cross-section-cap-bottom"
                  entries={crossSectionCapEntries}
                  sourceObject={supportDragGroupRef?.current ?? null}
                  sourceObjectVersion={crossSectionStencilSourceVersion}
                  skipSourceZBounds={isLayerScrubbing}
                  y={clipLower}
                  otherClipY={clipUpper}
                  color="#FFFFFF"
                  planeWidthMm={crossSectionPlaneWidthMm}
                  planeHeightMm={crossSectionPlaneHeightMm}
                  capOpacity={1}
                  capDepthTest={false}
                  direction="bottom"
                  renderOrderOffset={1}
                  visible={!hideCrossSectionCap}
                  debugOverrides={bottomCapDebugOverrides}
                />
              )}

              {!hideRaftPrimitives
                && !thumbnailCaptureActive
                && !isGizmoDragging
                && !isGizmoRetargeting
                && !hideFootprintOutlineForPreview
                && !(transformMode === 'placeOnFace' && disableRaycast)
                && (
                <FootprintBorderRenderer
                  modelGeometry={activeModel ? activeModel.geometry : null}
                  modelTransform={activeModelTransform}
                  modelId={activeModelId ?? hoveredModelId ?? null}
                  color={supportHoverTintColor}
                />
              )}

              {satDebugTargets.map((entry) => (
                <SliceSatBoundingMeshRenderer
                  key={`sat-debug-${entry.id}`}
                  modelGeometry={entry.geometry}
                  modelTransform={entry.transform}
                  enabled={Boolean(activeBuildVolumeSettings.showSliceSatBoundingMesh)}
                  renderMode={activeBuildVolumeSettings.sliceSatBoundingMeshMode === 'accurate_hull'
                    ? 'hull'
                    : activeBuildVolumeSettings.experimentalSliceSatBoundingMeshRenderMode}
                  interactionActive={isGizmoDragging}
                />
              ))}

              {/* During active-model proxy drag, keep other models' supports/rafts visible in world space. */}
              {useActiveModelAttachedSupportProxy && activeModelId && (
                <ModelAttachedSupportLayer
                  mode={mode}
                  excludeModelId={activeModelId}
                  excludeModelIds={supportProxyExcludeModelIds}
                  hideRaftPrimitives={hideRaftPrimitives}
                  hidePlateContactPrimitives={hidePlateContactPrimitives}
                  clipLower={clipLower}
                  clipUpper={clipUpper}
                  supportColorsByModelId={supportColorsByModelId}
                  hoverTintColor={supportHoverTintColor}
                  hoverTintStrength={hoverTintStrength}
                  selectedTintStrength={selectedTintStrength}
                  activeModelId={activeModelId}
                  selectedModelIds={selectedModelIds}
                  hoverModelId={hoveredModelId}
                  modelDropOffsetsById={entryDropOffsets}
                  navigationLodActive
                  disableSelectionAndHover={supportCreationModeActive || suppressSupportSelectionAndHover}
                  raftColorized={raftColorized}
                  raftHoverized={raftHoverized}
                  passive
                  supportRenderRefreshNonce={supportRenderRefreshNonce}
                />
              )}

              {multiGizmoSupportPreviewDeltas.length > 0
                ? multiGizmoSupportPreviewDeltas.map(({ modelId, delta }) => (
                    <group
                      key={`multi-gizmo-support-preview-${modelId}`}
                      ref={(node) => {
                        multiGizmoSupportPreviewGroupRefs.current[modelId] = node;
                      }}
                      matrix={delta}
                      matrixAutoUpdate={false}
                      raycast={() => null}
                    >
                      <ModelAttachedSupportLayer
                        mode={mode}
                        navigationLodActive={navigationLodActive}
                        hideRaftPrimitives={hideRaftPrimitives}
                        hidePlateContactPrimitives={hidePlateContactPrimitives}
                        clipLower={clipLower}
                        clipUpper={clipUpper}
                        supportColorsByModelId={supportColorsByModelId}
                        hoverTintColor={supportHoverTintColor}
                        hoverTintStrength={hoverTintStrength}
                        selectedTintStrength={selectedTintStrength}
                        activeModelId={activeModelId}
                        selectedModelIds={selectedModelIds}
                        hoverModelId={hoveredModelId}
                        modelDropOffsetsById={entryDropOffsets}
                        modelFilterId={modelId}
                        disableSelectionAndHover={supportCreationModeActive || suppressSupportSelectionAndHover}
                        raftColorized={raftColorized}
                        raftHoverized={raftHoverized}
                        passive
                        supportRenderRefreshNonce={supportRenderRefreshNonce}
                      />
                    </group>
                  ))
                : null}

              {isMultiGizmoSelection && (
                <group
                  ref={multiGizmoAnchorRef}
                  position={multiGizmoCenter ?? new THREE.Vector3(0, 0, 0)}
                  visible={false}
                  raycast={() => null}
                />
              )}

              {/* Gizmo attached to active model */}
              {mode === 'prepare' && transformMode === 'transform' && activeModelId && !thumbnailCaptureActive && (
                <UnifiedGizmo
                  key={`main-gizmo-${gizmoResetNonce}`}
                  meshRef={(isMultiGizmoSelection ? multiGizmoAnchorRef : activeGroupRef) as React.RefObject<THREE.Group | THREE.Mesh | null>}
                  followMeshRef
                  position={[
                    (isMultiGizmoSelection ? (multiGizmoCenter?.x ?? activeModelTransform?.position.x) : activeModelTransform?.position.x) ?? 0,
                    (isMultiGizmoSelection ? (multiGizmoCenter?.y ?? activeModelTransform?.position.y) : activeModelTransform?.position.y) ?? 0,
                    (isMultiGizmoSelection ? (multiGizmoCenter?.z ?? activeModelTransform?.position.z) : activeModelTransform?.position.z) ?? 0,
                  ]}
                  rotation={[0, 0, 0]}
                  enableMove
                  enableRotate={!isMultiGizmoSelection}
                  enableScale
                  enableLighting
                  onDragStateChange={setIsGizmoDragging}
                  onRetargetingChange={setIsGizmoRetargeting}
                  onMove={(delta) => {
                    if (activeGroupRef.current) {
                      activeGroupRef.current.position.add(delta);
                      applySupportGroupDelta();
                      const live = captureActiveGroupTransform();
                      if (live) {
                        const correctedLive = dragMoveLockZEnabledRef.current
                          ? {
                              position: live.position.clone().setZ(dragMoveLockedZRef.current),
                              rotation: live.rotation,
                              scale: live.scale,
                            }
                          : live;
                        activeGroupRef.current.position.copy(correctedLive.position);
                        activeGroupRef.current.quaternion.copy(new THREE.Quaternion().setFromEuler(correctedLive.rotation));
                        activeGroupRef.current.scale.copy(correctedLive.scale);
                        applySupportGroupDelta();
                        if (isMultiGizmoSelection && gizmoGroupStartSnapshot?.operation === 'move') {
                          const immediatePreviewByModelId = buildMultiSelectionTransformsFromActive(gizmoGroupStartSnapshot, {
                            position: correctedLive.position.clone(),
                            rotation: correctedLive.rotation.clone(),
                            scale: correctedLive.scale.clone(),
                          });
                          applyImmediateMultiPreview(gizmoGroupStartSnapshot, immediatePreviewByModelId);
                          setMultiGizmoAnchorPosition(computeCenterFromTransforms(immediatePreviewByModelId));
                        }

                        queueLiveDragTransform({
                          position: correctedLive.position.clone(),
                          rotation: correctedLive.rotation.clone(),
                          scale: correctedLive.scale.clone(),
                        });
                        requestDragCornerCageUpdate();
                      }
                    }
                  }}
                    onMoveStart={(axis) => {
                    stopActiveModelDropAnimation();
                    captureGizmoDragBeforeMatrix();
                      const details = axis ? { axis } : undefined;
                      const shouldProceed = onTransformStart?.('move', details);
                      if (shouldProceed === false) return false;
                      setActiveGizmoDragDescriptor({ operation: 'move', axis });
                    if (activeModelId && activeModel) {
                      const sourceTransform = transform ?? activeModel.transform;
                      dragMoveLockZEnabledRef.current = axis !== 'z';
                      dragMoveLockedZRef.current = sourceTransform.position.z;
                      const idsForCage = isMultiGizmoSelection
                        ? selectedTransformableModelIds
                        : [activeModelId];
                      scheduleDragCornerCagePrime(idsForCage, sourceTransform);
                      queueLiveDragTransform({
                        position: sourceTransform.position.clone(),
                        rotation: sourceTransform.rotation.clone(),
                        scale: sourceTransform.scale.clone(),
                      });
                      gizmoTransformStartSnapshotRef.current = {
                        modelId: activeModelId,
                        operation: 'move',
                        before: {
                          position: sourceTransform.position.clone(),
                          rotation: sourceTransform.rotation.clone(),
                          scale: sourceTransform.scale.clone(),
                        },
                      };

                      if (isMultiGizmoSelection) {
                        const beforeByModelId: Record<string, ModelTransform> = {};
                        selectedTransformableModelIds.forEach((modelId) => {
                          const model = models.find((entry) => entry.id === modelId);
                          if (!model) return;
                          const beforeTransform = modelId === activeModelId ? sourceTransform : model.transform;
                          beforeByModelId[modelId] = {
                            position: beforeTransform.position.clone(),
                            rotation: beforeTransform.rotation.clone(),
                            scale: beforeTransform.scale.clone(),
                          };
                        });

                        const positions = Object.values(beforeByModelId).map((entry) => entry.position);
                        const pivot = positions.length > 0
                          ? positions.reduce((acc, pos) => acc.add(pos.clone()), new THREE.Vector3()).multiplyScalar(1 / positions.length)
                          : sourceTransform.position.clone();

                        setGizmoGroupStartSnapshot({
                          operation: 'move',
                          activeModelId,
                          pivot,
                          beforeByModelId,
                        });
                      } else {
                        setGizmoGroupStartSnapshot(null);
                      }
                    }
                      return true;
                  }}
                  onMoveEnd={() => {
                    markGizmoDragEnded(true);
                    dragMoveLockZEnabledRef.current = false;
                    dragMoveLockedZRef.current = 0;
                    const live = captureActiveGroupTransform();
                    if (live) {
                      if (onTransformChange && !isMultiGizmoSelection) {
                        flushPendingTransformChange();
                        onTransformChange(live.position, live.rotation, live.scale);
                      }

                      const startSnapshot = gizmoTransformStartSnapshotRef.current;
                      if (startSnapshot && startSnapshot.modelId === activeModelId && !isMultiGizmoSelection) {
                        onGizmoTransformCommit?.({
                          modelId: activeModelId,
                          operation: startSnapshot.operation,
                          before: {
                            position: startSnapshot.before.position.clone(),
                            rotation: startSnapshot.before.rotation.clone(),
                            scale: startSnapshot.before.scale.clone(),
                          },
                          after: {
                            position: live.position.clone(),
                            rotation: live.rotation.clone(),
                            scale: live.scale.clone(),
                          },
                        });
                      }

                      if (isMultiGizmoSelection && gizmoGroupStartSnapshot?.operation === 'move') {
                        const finalByModelId = buildMultiSelectionTransformsFromActive(gizmoGroupStartSnapshot, {
                          position: live.position.clone(),
                          rotation: live.rotation.clone(),
                          scale: live.scale.clone(),
                        });
                        applyImmediateMultiPreview(gizmoGroupStartSnapshot, finalByModelId);
                        setMultiGizmoAnchorPosition(computeCenterFromTransforms(finalByModelId));
                        const entries = Object.entries(gizmoGroupStartSnapshot.beforeByModelId).map(([modelId, before]) => {
                          const after = modelId === activeModelId
                            ? {
                                position: live.position.clone(),
                                rotation: live.rotation.clone(),
                                scale: live.scale.clone(),
                              }
                            : (finalByModelId[modelId] ?? before);

                          return {
                            modelId,
                            before: {
                              position: before.position.clone(),
                              rotation: before.rotation.clone(),
                              scale: before.scale.clone(),
                            },
                            after: {
                              position: after.position.clone(),
                              rotation: after.rotation.clone(),
                              scale: after.scale.clone(),
                            },
                          };
                        });

                        const formatVec3 = (v: THREE.Vector3) => `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
                        console.groupCollapsed('[MultiGizmo][Scene] move commit payload');
                        console.log('selected models:', entries.map((entry) => entry.modelId));
                        console.log('model positions:', entries.map((entry) => ({ modelId: entry.modelId, position: formatVec3(entry.before.position) })));
                        const draggedEntry = entries.find((entry) => entry.modelId === activeModelId) ?? entries[0] ?? null;
                        console.log('model dragged to:', draggedEntry ? {
                          modelId: draggedEntry.modelId,
                          position: formatVec3(draggedEntry.after.position),
                        } : null);
                        console.log('model updated position:', entries.map((entry) => ({ modelId: entry.modelId, position: formatVec3(entry.after.position) })));
                        console.groupEnd();

                        onGizmoTransformGroupCommit?.({
                          operation: 'move',
                          entries,
                        });
                      }
                    }
                    gizmoTransformStartSnapshotRef.current = null;
                    setActiveGizmoDragDescriptor(null);
                    onTransformEnd?.('move', live ?? undefined, { skipStoreCommit: isMultiGizmoSelection });
                    queueLiveDragTransform(null);
                    setGizmoGroupStartSnapshot(null);
                    clearDragCornerCageBaseData();
                    if (!onTransformEnd) {
                      scheduleSupportDragGroupReset();
                    }
                  }}
                  onRotate={(axis, angle) => {
                    if (activeGroupRef.current) {
                      const rotationAxis =
                        axis === 'x'
                          ? new THREE.Vector3(1, 0, 0)
                          : axis === 'y'
                            ? new THREE.Vector3(0, 1, 0)
                            : new THREE.Vector3(0, 0, 1);
                      const quaternion = new THREE.Quaternion().setFromAxisAngle(rotationAxis, -angle);
                      activeGroupRef.current.quaternion.premultiply(quaternion);
                      applySupportGroupDelta();
                      const live = captureActiveGroupTransform();
                      if (live) {
                        const correctedLive = alignLiveTransformToLift(activeModel ?? null, live) ?? live;
                        activeGroupRef.current.position.copy(correctedLive.position);
                        activeGroupRef.current.quaternion.copy(new THREE.Quaternion().setFromEuler(correctedLive.rotation));
                        activeGroupRef.current.scale.copy(correctedLive.scale);
                        applySupportGroupDelta();
                        queueLiveDragTransform({
                          position: correctedLive.position.clone(),
                          rotation: correctedLive.rotation.clone(),
                          scale: correctedLive.scale.clone(),
                        });
                      }
                    }
                  }}
                  onRotateStart={(axis) => {
                    stopActiveModelDropAnimation();
                    captureGizmoDragBeforeMatrix();
                    const shouldProceed = onTransformStart?.('rotate', { axis });
                    if (shouldProceed === false) return false;
                    setActiveGizmoDragDescriptor({ operation: 'rotate', axis });
                    clearDragCornerCageBaseData();
                    setGizmoGroupStartSnapshot(null);
                    if (activeModelId && activeModel) {
                      const sourceTransform = transform ?? activeModel.transform;
                      queueLiveDragTransform({
                        position: sourceTransform.position.clone(),
                        rotation: sourceTransform.rotation.clone(),
                        scale: sourceTransform.scale.clone(),
                      });
                      gizmoTransformStartSnapshotRef.current = {
                        modelId: activeModelId,
                        operation: 'rotate',
                        before: {
                          position: sourceTransform.position.clone(),
                          rotation: sourceTransform.rotation.clone(),
                          scale: sourceTransform.scale.clone(),
                        },
                      };
                    }
                    return true;
                  }}
                  onRotateEnd={() => {
                    markGizmoDragEnded(true);
                    const capturedLive = captureActiveGroupTransform();
                    const fallbackLive = liveDragTransformRef.current;
                    const live = capturedLive ?? (fallbackLive
                      ? {
                          position: fallbackLive.position.clone(),
                          rotation: fallbackLive.rotation.clone(),
                          scale: fallbackLive.scale.clone(),
                        }
                      : null);

                    if (live && onTransformChange) {
                      flushPendingTransformChange();
                      onTransformChange(live.position, live.rotation, live.scale);
                    }

                    const startSnapshot = gizmoTransformStartSnapshotRef.current;
                    if (live && startSnapshot && startSnapshot.modelId === activeModelId) {
                      onGizmoTransformCommit?.({
                        modelId: activeModelId,
                        operation: startSnapshot.operation,
                        before: {
                          position: startSnapshot.before.position.clone(),
                          rotation: startSnapshot.before.rotation.clone(),
                          scale: startSnapshot.before.scale.clone(),
                        },
                        after: {
                          position: live.position.clone(),
                          rotation: live.rotation.clone(),
                          scale: live.scale.clone(),
                        },
                      });
                    }
                    gizmoTransformStartSnapshotRef.current = null;
                    setActiveGizmoDragDescriptor(null);
                    onTransformEnd?.('rotate', live ?? undefined);
                    queueLiveDragTransform(null);
                    clearDragCornerCageBaseData();
                    if (!onTransformEnd) {
                      scheduleSupportDragGroupReset();
                    }
                  }}
                  onScaleStart={(axis, isUniform) => {
                    stopActiveModelDropAnimation();
                    captureGizmoDragBeforeMatrix();
                    const startAxis = isUniform ? 'uniform' : axis;
                    const shouldProceed = onTransformStart?.('scale', { axis: startAxis, isUniform });
                    if (shouldProceed === false) return false;
                    setActiveGizmoDragDescriptor({ operation: 'scale', axis: startAxis, isUniform });
                    if (activeGroupRef.current) {
                      initialScaleRef.current.copy(activeGroupRef.current.scale);
                    }
                    if (activeModelId && activeModel) {
                      const sourceTransform = transform ?? activeModel.transform;
                      const idsForCage = isMultiGizmoSelection
                        ? selectedTransformableModelIds
                        : [activeModelId];
                      scheduleDragCornerCagePrime(idsForCage, sourceTransform);
                      queueLiveDragTransform({
                        position: sourceTransform.position.clone(),
                        rotation: sourceTransform.rotation.clone(),
                        scale: sourceTransform.scale.clone(),
                      });
                      gizmoTransformStartSnapshotRef.current = {
                        modelId: activeModelId,
                        operation: 'scale',
                        before: {
                          position: sourceTransform.position.clone(),
                          rotation: sourceTransform.rotation.clone(),
                          scale: sourceTransform.scale.clone(),
                        },
                      };

                      if (isMultiGizmoSelection) {
                        const beforeByModelId: Record<string, ModelTransform> = {};
                        selectedTransformableModelIds.forEach((modelId) => {
                          const model = models.find((entry) => entry.id === modelId);
                          if (!model) return;
                          const beforeTransform = modelId === activeModelId ? sourceTransform : model.transform;
                          beforeByModelId[modelId] = {
                            position: beforeTransform.position.clone(),
                            rotation: beforeTransform.rotation.clone(),
                            scale: beforeTransform.scale.clone(),
                          };
                        });

                        const positions = Object.values(beforeByModelId).map((entry) => entry.position);
                        const pivot = positions.length > 0
                          ? positions.reduce((acc, pos) => acc.add(pos.clone()), new THREE.Vector3()).multiplyScalar(1 / positions.length)
                          : sourceTransform.position.clone();

                        setGizmoGroupStartSnapshot({
                          operation: 'scale',
                          activeModelId,
                          pivot,
                          beforeByModelId,
                        });
                      } else {
                        setGizmoGroupStartSnapshot(null);
                      }
                    }
                    return true;
                  }}
                  onScale={(_axis, value) => {
                    if (activeGroupRef.current) {
                      const scalarValue = Number(value);
                      const safeScalar = Number.isFinite(scalarValue) ? scalarValue : 1;
                      const nextScale = initialScaleRef.current.clone().multiplyScalar(Math.max(0.0001, safeScalar));
                      activeGroupRef.current.scale.copy(nextScale);
                      applySupportGroupDelta();
                      const live = captureActiveGroupTransform();
                      if (live) {
                        const correctedLive = alignLiveTransformToLift(activeModel ?? null, live) ?? live;
                        activeGroupRef.current.position.copy(correctedLive.position);
                        activeGroupRef.current.quaternion.copy(new THREE.Quaternion().setFromEuler(correctedLive.rotation));
                        activeGroupRef.current.scale.copy(correctedLive.scale);
                        applySupportGroupDelta();
                        if (isMultiGizmoSelection && gizmoGroupStartSnapshot?.operation === 'scale') {
                          const immediatePreviewByModelId = buildMultiSelectionTransformsFromActive(gizmoGroupStartSnapshot, {
                            position: correctedLive.position.clone(),
                            rotation: correctedLive.rotation.clone(),
                            scale: correctedLive.scale.clone(),
                          });
                          applyImmediateMultiPreview(gizmoGroupStartSnapshot, immediatePreviewByModelId);
                          setMultiGizmoAnchorPosition(computeCenterFromTransforms(immediatePreviewByModelId));
                        }

                        queueLiveDragTransform({
                          position: correctedLive.position.clone(),
                          rotation: correctedLive.rotation.clone(),
                          scale: correctedLive.scale.clone(),
                        });
                        requestDragCornerCageUpdate();
                      }
                    }
                  }}
                  onScaleEnd={() => {
                    markGizmoDragEnded(true);
                    const live = captureActiveGroupTransform();
                    if (live) {
                      if (onTransformChange && !isMultiGizmoSelection) {
                        flushPendingTransformChange();
                        onTransformChange(live.position, live.rotation, live.scale);
                      }

                      const startSnapshot = gizmoTransformStartSnapshotRef.current;
                      if (startSnapshot && startSnapshot.modelId === activeModelId && !isMultiGizmoSelection) {
                        onGizmoTransformCommit?.({
                          modelId: activeModelId,
                          operation: startSnapshot.operation,
                          before: {
                            position: startSnapshot.before.position.clone(),
                            rotation: startSnapshot.before.rotation.clone(),
                            scale: startSnapshot.before.scale.clone(),
                          },
                          after: {
                            position: live.position.clone(),
                            rotation: live.rotation.clone(),
                            scale: live.scale.clone(),
                          },
                        });
                      }

                      if (isMultiGizmoSelection && gizmoGroupStartSnapshot?.operation === 'scale') {
                        const finalByModelId = buildMultiSelectionTransformsFromActive(gizmoGroupStartSnapshot, {
                          position: live.position.clone(),
                          rotation: live.rotation.clone(),
                          scale: live.scale.clone(),
                        });
                        applyImmediateMultiPreview(gizmoGroupStartSnapshot, finalByModelId);
                        setMultiGizmoAnchorPosition(computeCenterFromTransforms(finalByModelId));
                        const entries = Object.entries(gizmoGroupStartSnapshot.beforeByModelId).map(([modelId, before]) => {
                          const after = modelId === activeModelId
                            ? {
                                position: live.position.clone(),
                                rotation: live.rotation.clone(),
                                scale: live.scale.clone(),
                              }
                            : (finalByModelId[modelId] ?? before);

                          return {
                            modelId,
                            before: {
                              position: before.position.clone(),
                              rotation: before.rotation.clone(),
                              scale: before.scale.clone(),
                            },
                            after: {
                              position: after.position.clone(),
                              rotation: after.rotation.clone(),
                              scale: after.scale.clone(),
                            },
                          };
                        });

                        const formatVec3 = (v: THREE.Vector3) => `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
                        console.groupCollapsed('[MultiGizmo][Scene] scale commit payload');
                        console.log('selected models:', entries.map((entry) => entry.modelId));
                        console.log('model positions:', entries.map((entry) => ({ modelId: entry.modelId, position: formatVec3(entry.before.position) })));
                        const draggedEntry = entries.find((entry) => entry.modelId === activeModelId) ?? entries[0] ?? null;
                        console.log('model dragged to:', draggedEntry ? {
                          modelId: draggedEntry.modelId,
                          position: formatVec3(draggedEntry.after.position),
                        } : null);
                        console.log('model updated position:', entries.map((entry) => ({ modelId: entry.modelId, position: formatVec3(entry.after.position) })));
                        console.groupEnd();

                        onGizmoTransformGroupCommit?.({
                          operation: 'scale',
                          entries,
                        });
                      }
                    }
                    gizmoTransformStartSnapshotRef.current = null;
                    setActiveGizmoDragDescriptor(null);
                    onTransformEnd?.('scale', live ?? undefined, { skipStoreCommit: isMultiGizmoSelection });
                    queueLiveDragTransform(null);
                    setGizmoGroupStartSnapshot(null);
                    clearDragCornerCageBaseData();
                    if (!onTransformEnd) {
                      scheduleSupportDragGroupReset();
                    }
                  }}
                />
              )}

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

              {/* Render Branch Hover Preview Dot - shows when Alt is held before first click */}
              {/* Uses tip contact diameter to match actual tip size */}
              {branchHoverDotVisible && branchHoverPosition && (
                <mesh position={[branchHoverPosition.x, branchHoverPosition.y, branchHoverPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2 * 0.5, 12, 12]} />
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
              {isBranchPlacementActive && branchTipPosition && !branchPlacementPreview && !suppressSupportPlacementPreviewRendering && (
                <mesh position={[branchTipPosition.x, branchTipPosition.y, branchTipPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2 * 0.5, 12, 12]} />
                  <meshStandardMaterial color="#00ff00" transparent opacity={0.7} />
                </mesh>
              )}

              {/* Render Leaf Hover Preview Dot - shows when Alt+Shift is held before first click */}
              {/* Uses tip contact diameter to match actual tip size */}
              {leafHoverPosition && !leafTipPosition && !leafPlacementPreview && !suppressSupportPlacementPreviewRendering && (
                <mesh position={[leafHoverPosition.x, leafHoverPosition.y, leafHoverPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2 * 0.5, 12, 12]} />
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
              {isLeafPlacementActive && leafTipPosition && !leafPlacementPreview && !suppressSupportPlacementPreviewRendering && (
                <mesh position={[leafTipPosition.x, leafTipPosition.y, leafTipPosition.z]} raycast={() => null}>
                  <sphereGeometry args={[DEFAULT_TIP_CONTACT_DIAMETER_MM / 2 * 0.5, 12, 12]} />
                  <meshStandardMaterial color="#00ff00" transparent opacity={0.7} />
                </mesh>
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

              {/* Kickstand Placement Controller - handles Ctrl-hover preview and click placement */}
              {mode === 'support' && <KickstandPlacementController />}

              {/* LYS Ghost Viewer (Temporary) */}
              <GhostOverlay data={ghostData} visible={!!ghostData} />
            </React.Suspense>
          </SelectionProvider>
        </PickingProviderWrapper>
        {/* Selection outline - renders when model is selected */}
        <SelectionOutlineRenderer
          meshRef={activeActualMeshRef as React.RefObject<THREE.Mesh>}
          enabled={!thumbnailCaptureActive && effectiveModelSelected && selectionHighlightMode === 'fresnel'}
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
          enabled={!thumbnailCaptureActive && effectiveModelSelected && selectionHighlightMode === 'spotlight'}
          color="#ffeacc"
          intensity={7.6}
          angle={Math.PI / 3}
          penumbra={0.3}
          elevation={60}
          radius={60}
        />
        <OrbitControls
          ref={orbitControlsRef as React.RefObject<any>}
          makeDefault
          enableDamping={cameraFeelPreset !== 'raw'}
          dampingFactor={cameraFeelPreset === 'raw' ? 0 : cameraFeelPreset === 'precise' ? 0.15 : cameraFeelPreset === 'fast' ? 0.085 : 0.12}
          rotateSpeed={cameraFeelPreset === 'raw' ? 1.0 : cameraFeelPreset === 'precise' ? 0.72 : cameraFeelPreset === 'fast' ? 1.03 : 0.85}
          panSpeed={cameraFeelPreset === 'raw' ? 1.0 : cameraFeelPreset === 'precise' ? 0.82 : cameraFeelPreset === 'fast' ? 1.2 : 1.0}
          zoomSpeed={cameraFeelPreset === 'raw' ? 1.6 : cameraFeelPreset === 'precise' ? 1.25 : cameraFeelPreset === 'fast' ? 1.75 : 1.45}
          screenSpacePanning
          zoomToCursor
          enablePan
          enabled={
            models.length > 0
            && !(mode === 'prepare' && transformMode === 'smoothing' && smoothingBrushState.isStrokeActive)
            && !isGizmoDragging
            && !isMarqueeSelecting
          }
          onStart={handleOrbitStart}
          onChange={handleOrbitChange}
          onEnd={handleOrbitEnd}
          target={orbitTarget}
          mouseButtons={{ LEFT: undefined as unknown as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }}
        />
        <OrbitPivotIndicator visible={!thumbnailCaptureActive && isOrbitInteracting && isOrbitRotating} />
        <SpaceMouseController
          pivotPoint={selectedSpaceMousePivotPoint}
          pivotCandidates={spaceMousePivotCandidates}
          fallbackPivot={buildVolumeCenterTarget}
          mouseOrbitDragRunId={mouseOrbitDragRunId}
          onNavigationActiveChange={setSpaceMouseNavigationActive}
          onNavigationFrame={handleSpaceMouseNavigationFrame}
        />
        <CameraFocusHotkeyController
          hoverPointRef={lastHoveredModelPointRef}
          setOrbitTargetFromPoint={setOrbitTargetFromPoint}
          models={models}
          activeModelId={activeModelId}
          selectedModelIds={selectedModelIds ?? []}
          hoveredModelId={hoveredModelId}
          orbitTarget={orbitTarget}
          cameraRef={cameraRef}
          orbitControlsRef={orbitControlsRef as React.MutableRefObject<{ target: THREE.Vector3; update: () => void } | null>}
        />
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
        <CameraFocusController selectedIslandId={overlaySelectedIslandId ?? null} islandMarkers={islandMarkers ?? []} />
        {/* Selection outline effect - rendered by SelectionOutlineRenderer inside SelectionProvider */}
        {children}
      </Canvas>

      <SceneMoodOverlay />

      {frozenViewportDataUrl && freezeViewportActive && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 55,
            pointerEvents: 'none',
            background: '#181a22',
          }}
          aria-hidden="true"
        >
          <img
            src={frozenViewportDataUrl}
            alt=""
            draggable={false}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
              userSelect: 'none',
            }}
          />
        </div>
      )}

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
            Loading brushΓÇª
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
            SmoothingΓÇª {Math.round((smoothingProcessing.progress ?? 0) * 100)}%
          </div>
        </div>
      )}

      {/* Support Limitation Tooltip Overlay */}
      <SupportLimitationFeedback
        error={suppressSupportPlacementPreviewRendering ? null : (leafPlacementPreview?.error ?? (isBranchPlacementActive ? branchPlacementPreview?.error : null) ?? trunkPlacementPreview?.error ?? null)}
        warning={
          suppressSupportPlacementPreviewRendering
            ? null
            : (
              leafPlacementPreview?.warning ??
              (isBranchPlacementActive ? branchPlacementPreview?.warning : null) ??
              trunkPlacementPreview?.warning ??
              interactionWarning ??
              null
            )
        }
      />

      {/* GPU Picking Debug Overlay - shows what's under cursor */}
      {gpuPickingTest && <PickingDebugOverlay position="top-right" />}

      {showCrossSectionCapDebugPanel && (
        <div
          className="absolute right-3 top-3 z-[70] w-[360px] rounded-lg border p-3 shadow-xl"
          style={{
            pointerEvents: 'auto',
            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
            background: 'color-mix(in srgb, var(--surface-0), black 6%)',
            color: 'var(--text-strong)',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs font-semibold">Cross-Section Cap Debug (temporary)</div>
            <button
              type="button"
              className="rounded border px-2 py-1 text-[10px]"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
              onClick={() => setShowCrossSectionCapDebugPanel(false)}
            >
              Close
            </button>
          </div>

          <div className="mt-2 flex items-center justify-between gap-2 rounded border p-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <label className="flex items-center gap-2 text-[11px]">
              <input
                type="checkbox"
                checked={crossSectionCapDebugState.enabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setCrossSectionCapDebugState((prev) => ({ ...prev, enabled }));
                }}
              />
              Enable overrides
            </label>
            <button
              type="button"
              className="rounded border px-2 py-1 text-[10px]"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
              onClick={() => setCrossSectionCapDebugState(DEFAULT_CROSS_SECTION_CAP_DEBUG_STATE)}
            >
              Reset defaults
            </button>
          </div>

          {(['top', 'bottom'] as const).map((which) => {
            const settings = crossSectionCapDebugState[which];
            const setSettings = (partial: Partial<CrossSectionCapDebugOverrides>) => {
              setCrossSectionCapDebugState((prev) => ({
                ...prev,
                [which]: { ...prev[which], ...partial },
              }));
            };

            return (
              <div key={which} className="mt-2 rounded border p-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[11px] font-semibold uppercase" style={{ color: 'var(--text-muted)' }}>
                  {which} cap
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <label className="flex flex-col gap-1">
                    <span>Side</span>
                    <select
                      value={settings.side ?? 'front'}
                      onChange={(e) => setSettings({ side: e.target.value as 'front' | 'back' | 'double' })}
                      className="rounded border px-1.5 py-1"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                    >
                      <option value="front">front</option>
                      <option value="back">back</option>
                      <option value="double">double</option>
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span>Depth test</span>
                    <select
                      value={settings.depthTest ? 'on' : 'off'}
                      onChange={(e) => setSettings({ depthTest: e.target.value === 'on' })}
                      className="rounded border px-1.5 py-1"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                    >
                      <option value="on">on</option>
                      <option value="off">off</option>
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span>Clip mode</span>
                    <select
                      value={settings.clipMode ?? (which === 'bottom' ? 'lower' : 'upper')}
                      onChange={(e) => setSettings({ clipMode: e.target.value as 'upper' | 'lower' })}
                      disabled={which === 'bottom'}
                      className="rounded border px-1.5 py-1"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                    >
                      <option value="upper">upper (z ≤ y)</option>
                      <option value="lower">lower (z ≥ y)</option>
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span>Stencil mode</span>
                    <select
                      value={settings.stencilMode ?? 'standard'}
                      onChange={(e) => setSettings({ stencilMode: e.target.value as 'standard' | 'mirrored' })}
                      disabled={which === 'bottom'}
                      className="rounded border px-1.5 py-1"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                    >
                      <option value="standard">standard</option>
                      <option value="mirrored">mirrored</option>
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span>Offset (mm)</span>
                    <input
                      type="number"
                      step="0.0001"
                      value={settings.offsetMm ?? (which === 'bottom' ? -0.0001 : 0.0001)}
                      onChange={(e) => setSettings({ offsetMm: Number(e.target.value) })}
                      className="rounded border px-1.5 py-1"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span>Rotation X (deg)</span>
                    <input
                      type="number"
                      step="1"
                      value={settings.rotationXDeg ?? 0}
                      onChange={(e) => setSettings({ rotationXDeg: Number(e.target.value) })}
                      disabled={which === 'bottom'}
                      className="rounded border px-1.5 py-1"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                    />
                  </label>
                </div>

                {which === 'bottom' && (
                  <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Bottom cap uses CPU slice loops right now (side/offset/depth-test apply; clip/stencil/rotation ignored).
                  </div>
                )}
              </div>
            );
          })}

          <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Toggle panel: Ctrl+Shift+K · Settings persist locally.
          </div>
        </div>
      )}

      {marqueeSelection && (
        <div
          style={{
            position: 'absolute',
            left: Math.min(marqueeSelection.start.x, marqueeSelection.current.x),
            top: Math.min(marqueeSelection.start.y, marqueeSelection.current.y),
            width: Math.abs(marqueeSelection.current.x - marqueeSelection.start.x),
            height: Math.abs(marqueeSelection.current.y - marqueeSelection.start.y),
            border: '1px solid color-mix(in srgb, var(--accent), white 18%)',
            background: 'color-mix(in srgb, var(--accent), transparent 82%)',
            boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--accent-secondary), transparent 68%)',
            borderRadius: 6,
            pointerEvents: 'none',
            zIndex: 45,
          }}
        />
      )}

      {activeBuildVolumeSettings?.enabled && activeBuildVolumeSettings.showViolationWarning && outOfBoundsModels.length > 0 && (
        <div
          className="absolute bottom-5 left-1/2 z-40 -translate-x-1/2 animate-pulse rounded-full border px-5 py-2 text-sm font-semibold shadow-lg flex items-center gap-2"
          style={{
            pointerEvents: 'none',
            borderColor: 'color-mix(in srgb, #ff5b6f, var(--border-subtle) 42%)',
            background: 'color-mix(in srgb, #ff5b6f, var(--surface-0) 90%)',
            color: 'var(--text-strong)',
          }}
          title={outOfBoundsModels.map((m) => m.name).join(', ')}
        >
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>{outOfBoundsModels.length} model{outOfBoundsModels.length === 1 ? '' : 's'} out of build volume</span>
        </div>
      )}
    </div>
  );
}
