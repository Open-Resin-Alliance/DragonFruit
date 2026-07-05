'use client';

import React, { useEffect, useRef, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { detectIsIOS } from '@/hooks/usePlatform';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, Gamepad2, LayoutGrid, Loader2, Maximize2, Minimize2, Play, Plus, Printer, Redo2, RefreshCw, Trash2, Undo2, Wrench, X } from 'lucide-react';
import { SceneCanvas } from '@/components/scene/SceneCanvas';
import { FloatingPanelStack } from '@/components/layout/FloatingPanelStack';
import { TopBar } from '@/components/layout/TopBar';
import { GlobalUpdateIndicator } from '@/features/updater/GlobalUpdateIndicator';
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
import { SnapAngleReadout } from '@/components/gizmo/rotate/SnapAngleReadout';
import { RotationHintTooltip } from '@/components/gizmo/rotate/RotationHintTooltip';
import { TransformControls } from '@/components/controls/TransformControls';
import {
  ArrangePanel,
  type ArrangeAnchorMode,
  type ArrangeLayoutMode,
  type ArrangePrecisionMode,
} from '@/components/controls/ArrangePanel';
import { DuplicatePanel, type DuplicateLayoutMode } from '../components/controls/DuplicatePanel';
import { VisualSettingsPanel } from '@/components/controls/VisualSettingsPanel';
import { LayerSlider } from '@/components/controls/LayerSlider';
import { PrintingLayerGpuPreview } from '@/components/controls/PrintingLayerGpuPreview';
import { SupportSidebar } from '@/supports/Settings';
import { useLeafPlacementState } from '@/supports/SupportTypes/Leaf/leafPlacementState';
import { ExportPanel } from '@/features/export/components/ExportPanel';
import { ExportManager } from '@/features/export/logic/ExportManager';
import { resolveEntirePlateExportBaseName } from '@/features/export/logic/exportFileNaming';
import { SlicingPanel, type SliceIntent } from '@/features/slicing/components/SlicingPanel';
import { PrintingPanel } from '@/features/printing/components/PrintingPanel';
import { SliceMetricsDebugModal } from '@/features/slicing/components/SliceMetricsDebugModal';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { MeshSmoothingBrushCursor } from '@/features/mesh-smoothing/MeshSmoothingBrushCursor';
import { HollowingPanel, type HollowingPanelState } from '../features/hollowing';
import { HolePunchPanel, type HolePunchPanelState } from '../features/hole-punching/HolePunchPanel';
import { HolePunchPreviewCylinder } from '@/features/hole-punching/HolePunchPreviewCylinder';
import { HolePunchGizmo } from '@/features/hole-punching/HolePunchGizmo';
import { PlaceOnFaceTool } from '@/features/placeOnFace/PlaceOnFaceTool';
import { MirrorTool } from '@/features/mirror/MirrorTool';
import { bakeWithFlips } from '@/features/mirror/logic/bakeWithFlips';
import { buildMirrorSupportTransforms, reflectTransformAcrossWorldAxis } from '@/features/mirror/logic/buildMirrorSupportTransforms';
import type { MirrorAxis } from '@/features/mirror/types';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { RtspRelayCanvasPlayer } from '@/components/monitoring/RtspRelayCanvasPlayer';
import { IconButton, Toast, ToastViewport } from '@/components/ui/primitives';
import { EditorContextMenu, type EditorMenuAction } from '@/components/ui/EditorContextMenu';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { DiagnosticsModal } from '@/components/modals/DiagnosticsModal';
import { HistoryDebugModal } from '@/components/modals/HistoryDebugModal';
import { ModelSupportsModal } from '@/components/modals/ModelSupportsModal';
import { DestructiveTransformModal } from '@/components/modals/DestructiveTransformModal';
import { PrintingResliceModal } from '@/components/modals/PrintingResliceModal';
import { SliceCompletedModal } from '@/components/modals/SliceCompletedModal';
import { UvToolsLaunchingModal } from '@/components/modals/UvToolsLaunchingModal';
import { ZipFilePickerModal } from '@/components/modals/ZipFilePickerModal';
import { extractFilesFromZip, getFileExtensionLower } from '@/utils/zipImport';
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
import { computeProjectedFootprintHull, computeProjectedFootprintSize } from '@/utils/modelFootprint';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
import { getPluginSceneOverlayLoader } from '@/features/plugins/pluginRegistry';
import {
  type HullCacheEntry,
  type ArrangeModel as HighPrecisionArrangeModel,
} from '@/features/scene/arrange/highPrecisionArrange';
import {
  computeHighPrecisionArrangeResultWorker,
  computeHighPrecisionArrangeUpdatesWorker,
} from '@/features/scene/arrange/highPrecisionArrangeWorkerClient';

// Domain Features
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import { useSlicingManager } from '@/features/slicing/useSlicingManager';
import { useTransformManager } from '@/features/transform/useTransformManager';
import { useIslandManager } from '@/volumeAnalysis/IslandScan/useIslandManager';
// Islands PoC (Support-tab unified islands panel). Tab-agnostic + modular — see
// agents/Claude/20260613-1404-Implementation-dev-islands-islands-panel-...md.
import { useIslands } from '@/volumeAnalysis/Islands/useIslands';
import { IslandsPanel } from '@/components/controls/IslandsPanel';
import { IslandOverlay } from '@/components/scene/IslandOverlay';
import { useSupportInteractionManager } from '@/features/supports/useSupportInteractionManager';
import { useUndoRedoHotkeys } from '@/hotkeys/useUndoRedoHotkeys';
import { hotkeyStore, useActionActive, isActionActiveSync } from '@/hotkeys/hotkeyStore';
import { useDeleteHotkey } from '@/features/delete/useDeleteHotkey';
import { registerDeleteHandler } from '@/features/delete/deleteRegistry';
import { useCameraProjectionHotkey } from '@/hotkeys/useCameraProjectionHotkey';
import { useInteriorViewHotkey } from '@/hotkeys/useInteriorViewHotkey';
import { usePrepareTransformHotkeys } from '@/hotkeys/usePrepareTransformHotkeys';
import { useHotkeyConfig } from '@/hotkeys/HotkeyContext';
import { matchesConfiguredHotkeyDown, matchesConfiguredHotkeyUp } from '@/hotkeys/hotkeyConfig';
import {
  clearHistory,
  clearHistoryDebugEvents,
  getHistoryDebugEvents,
  getRedoCount,
  getUndoCount,
  pushHistory,
  redo,
  subscribeHistory,
  subscribeHistoryDebug,
  subscribeHistoryOperations,
  undo,
} from '@/history/historyStore';
import type { HistoryDebugEvent } from '@/history/types';
import { formatHistoryLabel } from '@/history/formatHistoryLabel';
import { getSavedCameraProjectionSettings, saveCameraProjectionSettings } from '@/components/settings/cameraProjectionPreferences';
import {
  getSceneAutosaveSettingsServerSnapshot,
  getSceneAutosaveSettingsSnapshot,
  subscribeToSceneAutosaveSettings,
} from '@/components/settings/sceneAutosavePreferences';
import {
  getSavedWorkspaceCameraSettings,
  getWorkspaceCameraSettingsServerSnapshot,
  getWorkspaceCameraSettingsSnapshot,
  subscribeToWorkspaceCameraSettings,
} from '@/components/settings/workspaceCameraPreferences';
import { openProfileSettingsModal, PROFILE_SETTINGS_MODAL_OPEN_CHANGE_EVENT } from '@/components/settings/profileModalEvents';
import {
  getProfileMonitoringUiAdapter,
  getProfileNetworkUiAdapter,
  type PrinterMonitoringSnapshot,
  type PrinterMonitoringWebcamInfo,
} from '@/features/plugins/pluginRegistry';
import { GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS } from '@/features/plugins/generatedBuiltinComplexPlugins';
import {
  getActiveMaterialProfile,
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  selectPrinterNetworkDevice,
  subscribeToProfileStore,
  type PrinterNetworkDevice,
  upsertPrinterNetworkDevice,
} from '@/features/profiles/profileStore';
import {
  getPrinterReachabilityServerSnapshot,
  getPrinterReachabilitySnapshot,
  setPrinterReachabilityMap,
  subscribeToPrinterReachability,
} from '@/features/network/printerReachabilityStore';
import type { SliceExportArtifact, SliceExportResult } from '@/features/slicing/sliceExportOrchestrator';
import {
  cleanupStalePrintTempArtifacts,
  deletePrintTempArtifactPath,
  launchExternalProcess,
  pickSavePathWithNativeDialog,
  pickOpenFilesWithNativeDialog,
  readPrintLayerPreviewPngFromPath,
  readPrintArtifactBytesFromPath,
  savePrintArtifactPathWithNativeDialog,
  savePrintArtifactWithNativeDialog,
  writeBytesToNativePath,
} from '@/features/slicing/tauri/nativeSlicerBridge';
import {
  getSavedUvToolsSettings,
  resolveUvToolsExecutablePath,
} from '@/components/settings/uvToolsPreferences';
import { subscribe as subscribeSupportState, getSnapshot as getSupportSnapshot, toggleSegmentCurve, transformSupportsForModel, updateTrunk, updateBranch, updateTwig, updateStick } from '@/supports/state';
import {
  getKickstandSnapshot,
  subscribeToKickstandStore,
} from '@/supports/SupportTypes/Kickstand/kickstandStore';
import { bracePlacementStore } from '@/supports/SupportTypes/Brace/bracePlacementState';
import { splitShaft, splitBranchShaft, splitTwigShaft, splitStickShaft } from '@/supports/SupportPrimitives/Joint/jointUtils';
import { captureSupportEditSnapshot, pushSupportEditHistory } from '@/supports/history/supportEditHistory';
import { getRaftSettings, subscribeToRaftStore } from '@/supports/Rafts/Crenelated/RaftState';
import { computeFootprint } from '@/supports/Rafts/Crenelated/geometry/computeFootprint';
import { computeRaftOuterBoundary } from '@/supports/Rafts/Crenelated/geometry/computeRaftOuterBoundary';
import type { SupportBaseCircle } from '@/supports/Rafts/Crenelated/RaftTypes';
import { getTrunkSegmentEndpoints, getBranchSegmentEndpoints } from '@/supports/SupportPrimitives/Knot/knotUtils';
import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '@/supports/SupportPrimitives/ContactDisk/contactDiskUtils';
import { getBezierPointAtT } from '@/supports/Curves/BezierUtils';
import { getSupportsForModel } from '@/supports/PlacementLogic/SupportModelLinker';
import { buildProjectedCrossSectionZRange } from '@/features/slicing/rasterLayerZipExport';
import { resolveCompositeMaterialLabel } from '@/utils/materialLabel';

import { type MeshShaderType } from '@/features/shaders/mesh';
import type { ModelTransform, TransformMode } from '@/hooks/useModelTransform';
import { useSceneAutosave, suppressSceneAutosave } from '@/hooks/useSceneAutosave';
import { SceneAutosaveRecoveryModal } from '@/components/scene/SceneAutosaveRecoveryModal';
import { MeshRepairReportModal } from '@/components/scene/MeshRepairReportModal';
import { MeshRepairConfirmModal } from '@/components/scene/MeshRepairConfirmModal';
import { HollowVoxelEditOverlay } from '@/components/scene/HollowVoxelEditOverlay';
import { HollowVoxelPreview } from '@/components/scene/HollowVoxelPreview';

import { IslandScanWorkflowCard } from '@/volumeAnalysis/IslandScan/workflow/IslandScanWorkflowCard';
import { IslandVolumesHierarchyCard } from '@/volumeAnalysis/IslandVolumes/components/IslandVolumesHierarchyCard';
import { uploadPrintJobWithProgress, type PluginUploadProgressEvent } from '@/features/plugins/pluginUploadBridge';
import { pluginNetworkFetch } from '@/utils/pluginNetworkBridge';
import { fetchRtspRelayStatus } from '@/utils/rtspRelayBridge';
import {
  hollowApplyFromCapturedSource,
  hollowFromGeometry,
  hollowPreviewFromCapturedSource,
  stageHollowPreviewSource,
  type HollowOptions,
  type HollowReport,
} from '@/utils/meshHollowing';
import {
  punchFromCapturedSource,
  stagePunchSource,
  type PunchOptions,
} from '@/utils/meshPunching';
import type {
  ModelMeshModifiers,
  ModelHolePunchPlacement,
  ModelHollowingModifier,
  MeshModifierOpenFace,
} from '@/features/mesh-modifiers/types';

interface ShaftHoverDebugDetail {
  segmentId: string | null;
  point: { x: number; y: number; z: number } | null;
}

type FleetUploadMaterialOption = {
  id: string;
  name: string;
  layerHeightMm: number | null;
};

type PrintingMonitorRecentPlate = {
  plateId: number;
  name: string;
  materialProfileName: string | null;
  lastModifiedEpochSec: number | null;
  layerCount: number | null;
  printTimeSec: number | null;
  usedMaterialMl: number | null;
  totalSolidAreaMm2: number | null;
  smallestAreaMm2: number | null;
  largestAreaMm2: number | null;
};

type PrintingMonitorPendingConfirmation =
  | {
      kind: 'control';
      action: 'cancel' | 'emergency-stop';
    }
  | {
      kind: 'plate';
      action: 'start' | 'delete';
      plateId: number;
      plateName: string;
    };

type PrintingMonitorDebugChannelState = {
  requestedAtEpochMs: number | null;
  request: Record<string, unknown> | null;
  httpStatus: number | null;
  rawPayload: unknown;
  parsedPayload: unknown;
  error: string | null;
};

type PrintingMonitorDebugState = {
  status: PrintingMonitorDebugChannelState;
  webcam: PrintingMonitorDebugChannelState;
  plates: PrintingMonitorDebugChannelState;
  taskHistory: PrintingMonitorDebugChannelState;
  taskDetails: PrintingMonitorDebugChannelState;
};

type PrintingMonitorFeatureToggleResponse = {
  operation: string;
  httpStatus: number | null;
  httpOk: boolean | null;
  commandOk: boolean | null;
  payload: unknown;
  error: string | null;
  requestedAtEpochMs: number;
};

const PRINTING_MONITOR_DEBUG_CHANNELS = ['status', 'webcam', 'plates', 'taskHistory', 'taskDetails'] as const;
type PrintingMonitorDebugChannel = (typeof PRINTING_MONITOR_DEBUG_CHANNELS)[number];

type PendingModifierResetAction = 'hollowing' | 'hole_punch' | 'clear_hollowing';

const EMPTY_SUPPORT_BOUNDS_BY_MODEL_ID = new Map<string, THREE.Box3>();

type HomeSupportSnapshot = ReturnType<typeof getSupportSnapshot>;
type HomeSupportCollectionsSnapshot = Pick<
  HomeSupportSnapshot,
  'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'roots' | 'knots'
>;

/**
 * Transforms Float32Array voxel centers from model-local to world space
 * by applying `(center - geometryCenter) * scale * quaternion + position`.
 * Used to render voxel cubes outside the model's rotated group.
 */
function transformVoxelCentersToWorld(
  voxelCenters: Float32Array,
  geometryCenter: THREE.Vector3,
  scale: THREE.Vector3,
  quaternion: THREE.Quaternion,
  position: THREE.Vector3,
): Float32Array {
  const count = Math.floor(voxelCenters.length / 3);
  const out = new Float32Array(voxelCenters.length);
  const tmp = new THREE.Vector3();
  for (let i = 0; i < count; i += 1) {
    const base = i * 3;
    tmp.set(voxelCenters[base], voxelCenters[base + 1], voxelCenters[base + 2]);
    tmp.sub(geometryCenter);
    tmp.multiply(scale);
    tmp.applyQuaternion(quaternion);
    tmp.add(position);
    out[base] = tmp.x;
    out[base + 1] = tmp.y;
    out[base + 2] = tmp.z;
  }
  return out;
}

/**
 * Renders HollowVoxelPreview in world space by pre-transforming the voxel
 * centers using the model's position/rotation/scale, then passing meshOffset
 * as zero since positions are already in world coordinates.
 */
function WorldSpaceVoxelPreview({
  voxelCenters,
  voxelSizeMm,
  modelTransform: { position, quaternion, scale },
  geometryCenter,
}: {
  voxelCenters: Float32Array;
  voxelSizeMm: number;
  modelTransform: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
  geometryCenter: THREE.Vector3;
}) {
  const worldCenters = React.useMemo(
    () => transformVoxelCentersToWorld(voxelCenters, geometryCenter, scale, quaternion, position),
    [voxelCenters, geometryCenter, scale, quaternion, position],
  );
  return (
    <HollowVoxelPreview
      voxelCenters={worldCenters}
      voxelSizeMm={voxelSizeMm}
      meshOffset={new THREE.Vector3(0, 0, 0)}
    />
  );
}

/**
 * Renders HollowVoxelEditOverlay in world space (same transform logic).
 */
function WorldSpaceVoxelEditOverlay({
  voxelCenters,
  blockedVoxelCenters,
  voxelRadiusMm,
  blockedVoxelIndexSet,
  modelTransform: { position, quaternion, scale },
  geometryCenter,
  onToggleVoxel,
}: {
  voxelCenters: Float32Array;
  blockedVoxelCenters?: Float32Array;
  voxelRadiusMm: number;
  blockedVoxelIndexSet: Set<number>;
  modelTransform: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };
  geometryCenter: THREE.Vector3;
  onToggleVoxel?: (voxelIndex: number) => void;
}) {
  const worldCenters = React.useMemo(
    () => transformVoxelCentersToWorld(voxelCenters, geometryCenter, scale, quaternion, position),
    [voxelCenters, geometryCenter, scale, quaternion, position],
  );
  const worldBlockedCenters = React.useMemo(
    () => blockedVoxelCenters
      ? transformVoxelCentersToWorld(blockedVoxelCenters, geometryCenter, scale, quaternion, position)
      : undefined,
    [blockedVoxelCenters, geometryCenter, scale, quaternion, position],
  );
  return (
    <HollowVoxelEditOverlay
      voxelCenters={worldCenters}
      blockedVoxelCenters={worldBlockedCenters}
      voxelRadiusMm={voxelRadiusMm}
      blockedVoxelIndexSet={blockedVoxelIndexSet}
      meshOffset={new THREE.Vector3(0, 0, 0)}
      onToggleVoxel={onToggleVoxel}
    />
  );
}

function countRecordEntries(record: Record<string, unknown>): number {
  let count = 0;
  for (const _key in record) {
    count += 1;
  }
  return count;
}

type HomeKickstandSnapshot = ReturnType<typeof getKickstandSnapshot>;
type HomeKickstandCollectionsSnapshot = Pick<
  HomeKickstandSnapshot,
  'kickstands' | 'roots' | 'knots'
>;

type HollowPreviewState = {
  modelId: string;
  geometry: THREE.BufferGeometry;
  infillGeometry: THREE.BufferGeometry | null;
  removedVoxelCenters: Float32Array;
  removedVoxelIndices: Uint32Array;
  blockedVoxelCenters?: Float32Array;
  report: HollowReport;
  previewKey: string;
  /** When true, the geometry is the original source mesh and the cavity
   *  should be visualized as spheres at removedVoxelCenters instead. */
  previewVoxelSpheres?: boolean;
};

type HollowPreviewCacheEntry = {
  modelId: string;
  report: HollowReport;
  positions: Float32Array;
  infillPositions?: Float32Array;
  removedVoxelCenters?: Float32Array;
  removedVoxelIndices?: Uint32Array;
  blockedVoxelCenters?: Float32Array;
  previewGeometry?: THREE.BufferGeometry | null;
  infillGeometry?: THREE.BufferGeometry | null;
};

type HollowingSourceEntry = {
  geometry: THREE.BufferGeometry;
};

/** Stores the per-model interior cavity surface mesh for Interior View Mode. */
type CavityGeometryEntry = {
  geometry: THREE.BufferGeometry;
};

type HolePunchPlacementState = {
  id: string;
  modelId: string;
  worldPoint: THREE.Vector3;
  worldNormal: THREE.Vector3;
  worldFrame?: HolePunchWorldFrame;
  localPoint: THREE.Vector3;
  localNormal: THREE.Vector3;
  radiusMm: number;
  radiusYMm?: number;
  depthMm: number;
  depthMode: 'manual' | 'auto';
};

type HolePunchWorldFrame = {
  xAxis: THREE.Vector3;
  yAxis: THREE.Vector3;
  zAxis: THREE.Vector3;
};

const HOLE_PUNCH_FRAME_REFERENCE_X = new THREE.Vector3(1, 0, 0);
const HOLE_PUNCH_FRAME_REFERENCE_Z = new THREE.Vector3(0, 0, 1);

function createHolePunchWorldFrame(worldNormal: THREE.Vector3): HolePunchWorldFrame {
  const yAxis = worldNormal.clone();
  if (yAxis.lengthSq() <= 1e-12) {
    yAxis.set(0, 0, -1);
  } else {
    yAxis.normalize();
  }
  const displayY = yAxis.clone().negate();
  const upReference = Math.abs(displayY.dot(HOLE_PUNCH_FRAME_REFERENCE_Z)) < 0.92
    ? HOLE_PUNCH_FRAME_REFERENCE_Z.clone()
    : HOLE_PUNCH_FRAME_REFERENCE_X.clone();
  const displayZ = upReference
    .sub(displayY.clone().multiplyScalar(upReference.dot(displayY)))
    .normalize();
  const xAxis = displayY.clone().cross(displayZ).normalize();
  const zAxis = displayZ.negate();
  return { xAxis, yAxis, zAxis };
}

function cloneHolePunchWorldFrame(frame: HolePunchWorldFrame): HolePunchWorldFrame {
  return {
    xAxis: frame.xAxis.clone(),
    yAxis: frame.yAxis.clone(),
    zAxis: frame.zAxis.clone(),
  };
}

function normalizeDirectionTuple(x: number, y: number, z: number): [number, number, number] {
  const dir = new THREE.Vector3(x, y, z);
  if (dir.lengthSq() <= 1e-12) {
    return [0, 0, -1];
  }
  dir.normalize();
  return [dir.x, dir.y, dir.z];
}

function toPersistedHolePunchPlacements(
  model: { geometry: GeometryWithBounds; transform?: ModelTransform },
  placements: HolePunchPlacementState[],
): ModelHolePunchPlacement[] {
  const geometry = model.geometry.geometry;
  const bbox = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as THREE.BufferAttribute,
  );
  const size = bbox.getSize(new THREE.Vector3());
  const toNorm = (value: number, min: number, span: number) => (span <= 1e-9 ? 0.5 : (value - min) / span);

  // When a model transform is available, derive localPoint/localNormal from
  // worldPoint/worldNormal at serialization time so they always stay consistent
  // with the model's current transform — even if the draft state has drifted
  // (e.g. after gizmo manipulation). When transform is unavailable (legacy
  // callers like hollow-apply that only pass a bare geometry), fall back to
  // the stored localPoint/localNormal in the draft state.
  let inverseModelMatrix: THREE.Matrix4 | null = null;
  let inverseNormalMatrix: THREE.Matrix3 | null = null;
  if (model.transform) {
    const meshMatrix = new THREE.Matrix4()
      .compose(
        model.transform.position.clone(),
        quaternionFromGlobalEuler(model.transform.rotation),
        model.transform.scale.clone(),
      )
      .multiply(new THREE.Matrix4().makeTranslation(
        -model.geometry.center.x,
        -model.geometry.center.y,
        -model.geometry.center.z,
      ));
    inverseModelMatrix = meshMatrix.clone().invert();

    const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshMatrix);
    inverseNormalMatrix = normalMatrix.clone().invert();
  }

  return placements.map((placement) => {
    let localPoint: THREE.Vector3;
    let localNormal: THREE.Vector3;
    if (inverseModelMatrix && inverseNormalMatrix) {
      // Derive from world-space values — always consistent with current transform.
      localPoint = placement.worldPoint.clone().applyMatrix4(inverseModelMatrix);
      localNormal = placement.worldNormal
        .clone()
        .applyMatrix3(inverseNormalMatrix)
        .normalize();
    } else {
      // Fallback: use stored values (legacy path).
      localPoint = placement.localPoint;
      localNormal = placement.localNormal;
    }

    const direction = normalizeDirectionTuple(localNormal.x, localNormal.y, localNormal.z);
    return {
      id: placement.id,
      centerNorm: [
        toNorm(localPoint.x, bbox.min.x, size.x),
        toNorm(localPoint.y, bbox.min.y, size.y),
        toNorm(localPoint.z, bbox.min.z, size.z),
      ],
      radiusMm: placement.radiusMm,
      radiusYMm: placement.radiusYMm,
      depthMm: placement.depthMm,
      direction,
      depthMode: placement.depthMode,
    };
  });
}

function fromPersistedHolePunchPlacements(
  model: { id: string; geometry: GeometryWithBounds; transform: ModelTransform },
  persisted: ModelHolePunchPlacement[],
): HolePunchPlacementState[] {
  if (persisted.length === 0) return [];

  const bbox = model.geometry.bbox;
  const size = model.geometry.size;
  const toMm = (norm: number, min: number, span: number) => min + (norm * (span <= 1e-9 ? 0 : span));

  const meshMatrix = new THREE.Matrix4()
    .compose(
      model.transform.position.clone(),
      quaternionFromGlobalEuler(model.transform.rotation),
      model.transform.scale.clone(),
    )
    .multiply(new THREE.Matrix4().makeTranslation(
      -model.geometry.center.x,
      -model.geometry.center.y,
      -model.geometry.center.z,
    ));

  const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshMatrix);

  return persisted.map((placement) => {
    const localPoint = new THREE.Vector3(
      toMm(placement.centerNorm[0], bbox.min.x, size.x),
      toMm(placement.centerNorm[1], bbox.min.y, size.y),
      toMm(placement.centerNorm[2], bbox.min.z, size.z),
    );

    const localNormal = new THREE.Vector3(
      placement.direction[0],
      placement.direction[1],
      placement.direction[2],
    );
    if (localNormal.lengthSq() <= 1e-12) {
      localNormal.set(0, 0, -1);
    } else {
      localNormal.normalize();
    }

    const worldPoint = localPoint.clone().applyMatrix4(meshMatrix);
    const worldNormal = localNormal.clone().applyNormalMatrix(normalMatrix).normalize();
    const worldFrame = createHolePunchWorldFrame(worldNormal);

    return {
      id: placement.id,
      modelId: model.id,
      worldPoint,
      worldNormal,
      worldFrame,
      localPoint,
      localNormal,
      radiusMm: placement.radiusMm,
      radiusYMm: placement.radiusYMm,
      depthMm: placement.depthMm,
      depthMode: placement.depthMode ?? 'manual',
    };
  });
}

function serializeHollowingModifier(modifier: ModelHollowingModifier | null | undefined): string {
  if (!modifier?.enabled) return 'disabled';
  return JSON.stringify({
    enabled: true,
    blockedVoxelIndices: [...(modifier.blockedVoxelIndices ?? [])].sort((a, b) => a - b),
    mode: modifier.mode,
    voxelSizeMm: Number(modifier.voxelSizeMm.toFixed(4)),
    shellThicknessMm: Number(modifier.shellThicknessMm.toFixed(4)),
    infillMode: modifier.infillMode ?? 'lattice',
    infillCellMm: Number((modifier.infillCellMm ?? 4.2426).toFixed(4)),
    infillBeamRadiusMm: Number((modifier.infillBeamRadiusMm ?? 0.25).toFixed(4)),
    openFace: modifier.openFace,
    openFaceSelected: modifier.mode === 'shell_open_face'
      ? (modifier.openFaceSelected ?? true)
      : true,
  });
}

function areSortedNumberArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function isKeyboardTargetEditable(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

function inferOpenFaceFromHit(
  hit: THREE.Intersection,
  fallback: MeshModifierOpenFace,
): MeshModifierOpenFace {
  const normal = hit.face?.normal;
  if (!normal) return fallback;

  const absX = Math.abs(normal.x);
  const absY = Math.abs(normal.y);
  const absZ = Math.abs(normal.z);

  if (absX >= absY && absX >= absZ) {
    return normal.x >= 0 ? 'x_max' : 'x_min';
  }
  if (absY >= absX && absY >= absZ) {
    return normal.y >= 0 ? 'y_max' : 'y_min';
  }
  return normal.z >= 0 ? 'z_max' : 'z_min';
}

function serializeHolePunchPlacements(placements: ModelHolePunchPlacement[]): string {
  const normalizePlacement = (placement: ModelHolePunchPlacement) => ({
    id: placement.id,
    centerNorm: placement.centerNorm.map((value) => Number(value.toFixed(6))),
    radiusMm: Number(placement.radiusMm.toFixed(4)),
    radiusYMm: placement.radiusYMm != null ? Number(placement.radiusYMm.toFixed(4)) : undefined,
    depthMm: Number(placement.depthMm.toFixed(4)),
    direction: placement.direction.map((value) => Number(value.toFixed(6))),
    depthMode: placement.depthMode ?? 'manual',
  });

  const sorted = [...placements]
    .map(normalizePlacement)
    .sort((a, b) => a.id.localeCompare(b.id));

  return JSON.stringify(sorted);
}

function serializeSingleHolePunchPlacement(placement: ModelHolePunchPlacement): string {
  return JSON.stringify({
    id: placement.id,
    centerNorm: placement.centerNorm.map((value) => Number(value.toFixed(6))),
    radiusMm: Number(placement.radiusMm.toFixed(4)),
    radiusYMm: placement.radiusYMm != null ? Number(placement.radiusYMm.toFixed(4)) : undefined,
    depthMm: Number(placement.depthMm.toFixed(4)),
    direction: placement.direction.map((value) => Number(value.toFixed(6))),
    depthMode: placement.depthMode ?? 'manual',
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    const CHUNK_SIZE = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  throw new Error('Base64 encoding is unavailable in this environment.');
}

function base64ToBytes(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/g, '');

  if (typeof atob === 'function') {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(normalized, 'base64'));
  }

  throw new Error('Base64 decoding is unavailable in this environment.');
}

function snapshotGeometryPositions(geometry: THREE.BufferGeometry): {
  sourcePositionsBase64: string;
  sourcePositionCount: number;
} {
  const position = geometry.getAttribute('position');
  if (!(position instanceof THREE.BufferAttribute)) {
    throw new Error('Geometry has no position attribute.');
  }

  const floatArray = position.array instanceof Float32Array
    ? position.array
    : new Float32Array(position.array);
  const bytes = new Uint8Array(
    floatArray.buffer,
    floatArray.byteOffset,
    floatArray.byteLength,
  );

  return {
    sourcePositionsBase64: bytesToBase64(bytes),
    sourcePositionCount: position.count,
  };
}

function geometryFromSnapshot(snapshot: {
  sourcePositionsBase64?: string;
  sourcePositionCount?: number;
}): THREE.BufferGeometry | null {
  const base64 = snapshot.sourcePositionsBase64;
  const count = snapshot.sourcePositionCount;
  if (!base64 || !Number.isFinite(count) || (count as number) <= 0) {
    return null;
  }

  const bytes = base64ToBytes(base64);
  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    return null;
  }

  const view = new Float32Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const positions = new Float32Array(view.length);
  positions.set(view);

  if (positions.length !== (count as number) * 3) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function getAbsSafeScaleComponents(scale: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(
    Math.max(1e-6, Math.abs(scale.x)),
    Math.max(1e-6, Math.abs(scale.y)),
    Math.max(1e-6, Math.abs(scale.z)),
  );
}

function getDirectionScaleFactor(direction: THREE.Vector3, scale: THREE.Vector3): number {
  const dir = direction.clone();
  if (dir.lengthSq() <= 1e-12) {
    dir.set(0, 0, -1);
  } else {
    dir.normalize();
  }

  const absScale = getAbsSafeScaleComponents(scale);
  const scaledDir = new THREE.Vector3(
    dir.x * absScale.x,
    dir.y * absScale.y,
    dir.z * absScale.z,
  );
  return Math.max(1e-6, scaledDir.length());
}

function getRadialScaleFactor(direction: THREE.Vector3, scale: THREE.Vector3): number {
  const dir = direction.clone();
  if (dir.lengthSq() <= 1e-12) {
    dir.set(0, 0, -1);
  } else {
    dir.normalize();
  }

  const helper = Math.abs(dir.z) < 0.9
    ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(0, 1, 0);

  const tangentA = helper.clone().cross(dir);
  if (tangentA.lengthSq() <= 1e-12) {
    tangentA.set(1, 0, 0);
  } else {
    tangentA.normalize();
  }
  const tangentB = dir.clone().cross(tangentA).normalize();

  const absScale = getAbsSafeScaleComponents(scale);
  const scaleAlong = (v: THREE.Vector3) => new THREE.Vector3(
    v.x * absScale.x,
    v.y * absScale.y,
    v.z * absScale.z,
  ).length();

  const sA = scaleAlong(tangentA);
  const sB = scaleAlong(tangentB);
  return Math.max(1e-6, (sA + sB) * 0.5);
}

function getUniformScaleFactorForThickness(scale: THREE.Vector3): number {
  const absScale = getAbsSafeScaleComponents(scale);
  return Math.max(1e-6, (absScale.x + absScale.y + absScale.z) / 3);
}

function worldMmToLocalMm(worldMm: number, scaleFactor: number): number {
  return Math.max(1e-4, worldMm / Math.max(1e-6, scaleFactor));
}

/** Convert a desired voxel size (mm in local space) to a voxel resolution
 *  count, given the model's largest bounding-box extent in local space.
 *  Clamped to [24, 192].
 *
 *  Callers MUST convert world-space voxel size to local space via
 *  `worldMmToLocalMm(voxelSizeMm, scaleFactor)` before calling this. */
function computeVoxelResolution(voxelSizeMm: number, maxExtent: number): number {
  const raw = Math.round(maxExtent / Math.max(0.05, voxelSizeMm));
  return Math.min(192, Math.max(24, raw));
}

function buildGeometryVersionKey(geometry: THREE.BufferGeometry): string {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute | null;
  const index = geometry.getIndex();

  return [
    geometry.uuid,
    position?.count ?? 0,
    position?.version ?? 0,
    index?.count ?? 0,
    index?.version ?? 0,
  ].join(':');
}

function createGeometryFromPreviewPositions(positions: Float32Array): THREE.BufferGeometry {
  const copied = new Float32Array(positions.length);
  copied.set(positions);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(copied, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function disposeHollowPreviewCacheEntry(entry: HollowPreviewCacheEntry): void {
  entry.previewGeometry?.dispose();
  entry.infillGeometry?.dispose();
}

function isHollowPreviewGeometryCacheOwned(
  geometry: THREE.BufferGeometry | null,
  entries: Iterable<HollowPreviewCacheEntry>,
): boolean {
  if (!geometry) return false;
  for (const entry of entries) {
    if (entry.previewGeometry === geometry || entry.infillGeometry === geometry) {
      return true;
    }
  }
  return false;
}

function disposeHollowPreviewGeometryIfUncached(
  geometry: THREE.BufferGeometry | null,
  entries: Iterable<HollowPreviewCacheEntry>,
): void {
  if (!geometry) return;
  if (isHollowPreviewGeometryCacheOwned(geometry, entries)) return;
  geometry.dispose();
}

const EMPTY_HOME_SUPPORT_COLLECTIONS_SNAPSHOT: HomeSupportCollectionsSnapshot = {
  trunks: {},
  branches: {},
  leaves: {},
  twigs: {},
  sticks: {},
  braces: {},
  roots: {},
  knots: {},
};

const EMPTY_HOME_KICKSTAND_COLLECTIONS_SNAPSHOT: HomeKickstandCollectionsSnapshot = {
  kickstands: {},
  roots: {},
  knots: {},
};

const HOLE_PUNCH_OUTSIDE_PROTRUSION_MM = 3;
const HOLE_PUNCH_DEPTH_OFFSET_FROM_SHELL_MM = 1;
const HOLE_PUNCH_AUTO_DEPTH_RAY_START_OFFSET_MM = 0.3;
const HOLE_PUNCH_AUTO_DEPTH_MIN_INSIDE_MM = 1;
const HOLLOW_PREVIEW_DEBOUNCE_MS = 90;
const HOLLOW_PREVIEW_THICKNESS_QUANTUM_MM = 0.2;

function quantizePreviewShellThicknessMm(valueMm: number): number {
  const clamped = Math.max(0.1, valueMm);
  return Number((Math.round(clamped / HOLLOW_PREVIEW_THICKNESS_QUANTUM_MM) * HOLLOW_PREVIEW_THICKNESS_QUANTUM_MM).toFixed(3));
}

function getDefaultHolePunchDepthMm(shellThicknessMm: number): number {
  return Number(
    Math.min(120, Math.max(1, shellThicknessMm + HOLE_PUNCH_DEPTH_OFFSET_FROM_SHELL_MM)).toFixed(1),
  );
}

let cachedHomeSupportCollectionsSnapshot: HomeSupportCollectionsSnapshot | null = null;
let cachedHomeKickstandCollectionsSnapshot: HomeKickstandCollectionsSnapshot | null = null;

function getHomeSupportCollectionsSnapshot(): HomeSupportCollectionsSnapshot {
  const snapshot = getSupportSnapshot();
  const cached = cachedHomeSupportCollectionsSnapshot;

  if (
    cached
    && cached.trunks === snapshot.trunks
    && cached.branches === snapshot.branches
    && cached.leaves === snapshot.leaves
    && cached.twigs === snapshot.twigs
    && cached.sticks === snapshot.sticks
    && cached.braces === snapshot.braces
    && cached.roots === snapshot.roots
    && cached.knots === snapshot.knots
  ) {
    return cached;
  }

  const next: HomeSupportCollectionsSnapshot = {
    trunks: snapshot.trunks,
    branches: snapshot.branches,
    leaves: snapshot.leaves,
    twigs: snapshot.twigs,
    sticks: snapshot.sticks,
    braces: snapshot.braces,
    roots: snapshot.roots,
    knots: snapshot.knots,
  };

  cachedHomeSupportCollectionsSnapshot = next;
  return next;
}

function getHomeKickstandCollectionsSnapshot(): HomeKickstandCollectionsSnapshot {
  const snapshot = getKickstandSnapshot();
  const cached = cachedHomeKickstandCollectionsSnapshot;

  if (
    cached
    && cached.kickstands === snapshot.kickstands
    && cached.roots === snapshot.roots
    && cached.knots === snapshot.knots
  ) {
    return cached;
  }

  const next: HomeKickstandCollectionsSnapshot = {
    kickstands: snapshot.kickstands,
    roots: snapshot.roots,
    knots: snapshot.knots,
  };

  cachedHomeKickstandCollectionsSnapshot = next;
  return next;
}

function installReactDevtoolsSemverGuard() {
  if (process.env.NODE_ENV !== 'development') return;
  if (typeof window === 'undefined') return;

  const hook = (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || hook.__dragonfruitSemverGuardInstalled) return;
  if (typeof hook.inject !== 'function') return;

  const originalInject = hook.inject;

  const withSafeSemver = (renderer: any) => {
    if (!renderer || typeof renderer !== 'object') return renderer;

    const patched = { ...renderer };
    if (typeof patched.version !== 'string' || patched.version.trim() === '') {
      patched.version = '0.0.0';
    }
    if (typeof patched.reconcilerVersion !== 'string' || patched.reconcilerVersion.trim() === '') {
      patched.reconcilerVersion = '0.0.0';
    }
    return patched;
  };

  hook.inject = function injectWithSemverGuard(renderer: any) {
    try {
      return originalInject.call(this, renderer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('not valid semver')) {
        return originalInject.call(this, withSafeSemver(renderer));
      }
      throw error;
    }
  };

  hook.__dragonfruitSemverGuardInstalled = true;
}

// Initialize BVH acceleration globally
if (typeof window !== 'undefined') {
  initializeBVH();
  installReactDevtoolsSemverGuard();
}

type ExportThumbnailRenderOptions = {
  includeGradient: boolean;
  includeBuildPlate: boolean;
  includeGrid: boolean;
  centerOnModel: boolean;
};

const EXPORT_THUMBNAIL_RENDER_OPTIONS_STORAGE_KEY = 'dragonfruit.slicing.thumbnailRenderOptions';
const DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS: ExportThumbnailRenderOptions = {
  includeGradient: false,
  includeBuildPlate: false,
  includeGrid: false,
  centerOnModel: true,
};

const PLUGIN_SCENE_FILE_TYPES = GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS.flatMap(
  (def) => (def.fileTypes ?? []).filter((ft) => ft.isSceneFile),
);
const PLUGIN_ALL_FILE_TYPES = GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS.flatMap(
  (def) => def.fileTypes ?? [],
);
const PREPARE_DROP_EXTENSIONS = new Set([
  '.stl', '.obj', '.3mf', '.voxl',
  ...PLUGIN_ALL_FILE_TYPES.map((ft) => ft.fileExtension),
]);
const PLUGIN_IMPORT_WARNING_DISMISSED_STORAGE_KEY =
  PLUGIN_SCENE_FILE_TYPES.find((ft) => ft.fileExtension === '.lys')?.importWarning?.storageKey
  ?? 'dragonfruit.lysImportWarningDismissed';
const COLD_START_SCENE_HANDOFF_DELAY_MS = 1150;
const REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY = 'dragonfruit.slicing.remoteOfflineLayerHeightMm';
const REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT = 'dragonfruit:slicing-remote-offline-layer-height-changed';
const SUPPORT_DRAG_HOLD_FALLBACK_MS = 320;
const DEFAULT_MONITOR_BUSY_GRACE_MS = 30_000;
const REACHABILITY_PROBE_TIMEOUT_MS = 7_500;
const DEFAULT_WEBCAM_TIMEOUT_COOLDOWN_MS = 20_000;
const DEFAULT_WEBCAM_FAILURE_COOLDOWN_MS = 8_000;
const DEFAULT_WEBCAM_MAX_CONSECUTIVE_TIMEOUTS = 3;
const DEFAULT_RTSP_DEBUG_POLL_MS = 4_000;
const DEFAULT_RELAY_AUTORETRY_LIMIT = 2;
const DEFAULT_RELAY_AUTORETRY_DELAY_MS = 1200;
const RESIN_ESTIMATE_BACKGROUND_REFRESH_MS = 12_000;

function readRemoteOfflineLayerHeightSnapshotMm(): number | null {
  if (typeof window === 'undefined') return null;

  const raw = window.localStorage.getItem(REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY)
    ?? window.sessionStorage.getItem(REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY);
  if (raw == null || raw.trim().length === 0) return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(1, parsed));
}

type TransformStoreCommitResult = {
  updated: boolean;
  supportsChanged: boolean;
  kickstandsChanged: boolean;
};

type PendingSupportDragSyncTransaction = {
  transactionId: number;
  expectedModelTransformKeys: Map<string, string>;
  expectedSupportStoreVersion: number;
  expectedKickstandStoreVersion: number;
};

function createModelTransformKey(modelId: string, transform: ModelTransform): string {
  return [
    modelId,
    transform.position.x.toFixed(6),
    transform.position.y.toFixed(6),
    transform.position.z.toFixed(6),
    transform.rotation.x.toFixed(6),
    transform.rotation.y.toFixed(6),
    transform.rotation.z.toFixed(6),
    transform.scale.x.toFixed(6),
    transform.scale.y.toFixed(6),
    transform.scale.z.toFixed(6),
  ].join('|');
}

function getFileExtension(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const dotIndex = trimmed.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === trimmed.length - 1) return '';
  return trimmed.slice(dotIndex);
}

function getFileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function isDragonfruitTempArtifactPath(path: string | null | undefined): boolean {
  if (typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (!trimmed) return false;
  const name = getFileNameFromPath(trimmed).toLowerCase();
  return name.startsWith('dragonfruit-slice-');
}

function isSupportedPrepareDropName(name: string): boolean {
  return PREPARE_DROP_EXTENSIONS.has(getFileExtension(name));
}

function getDroppedFileMimeType(name: string): string {
  const ext = getFileExtension(name);
  if (ext === '.stl') return 'model/stl';
  if (ext === '.obj') return 'model/obj';
  if (ext === '.3mf') return 'model/3mf';
  if (ext === '.voxl') return 'application/json';
  const pluginType = PLUGIN_ALL_FILE_TYPES.find((ft) => ft.fileExtension === ext);
  return pluginType?.mimeType ?? 'application/octet-stream';
}

function isSceneFileName(name: string): boolean {
  const ext = getFileExtension(name);
  if (ext === '.voxl') return true;
  return PLUGIN_SCENE_FILE_TYPES.some((ft) => ft.fileExtension === ext);
}

function normalizeActiveVoxlScenePath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  return getFileExtension(trimmed) === '.voxl' ? trimmed : null;
}

type LaunchSceneFileEntry = {
  path: string;
  name: string;
};

type SceneFileHandoffPayload = {
  paths?: string[];
  source?: string;
};

function extractTauriDroppedPaths(payload: unknown): string[] {
  const isStringArray = (value: unknown): value is string[] => (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );

  if (isStringArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === 'object' && 'paths' in payload) {
    const candidate = (payload as { paths?: unknown }).paths;
    if (isStringArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function isLikelyFileDragPayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if ((dataTransfer.files?.length ?? 0) > 0) return true;
  if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')) return true;
  if (Array.from(dataTransfer.types ?? []).includes('Files')) return true;
  // Desktop runtime drags may not expose file metadata until drop.
  return true;
}

function getPrepareDropSupportStateFromDataTransfer(dataTransfer: DataTransfer | null): 'supported' | 'unsupported' | 'unknown' {
  if (!dataTransfer) return 'unknown';

  const fileNames = new Set<string>();

  const directFiles = Array.from(dataTransfer.files ?? []);
  for (const file of directFiles) {
    if (typeof file.name === 'string' && file.name.trim().length > 0) {
      fileNames.add(file.name.trim());
    }
  }

  const items = Array.from(dataTransfer.items ?? []);
  for (const item of items) {
    if (item.kind !== 'file') continue;
    try {
      const file = item.getAsFile();
      if (file && typeof file.name === 'string' && file.name.trim().length > 0) {
        fileNames.add(file.name.trim());
      }

      const webkitEntry = (item as DataTransferItem & {
        webkitGetAsEntry?: () => { isFile?: boolean; name?: string } | null;
      }).webkitGetAsEntry?.();
      if (webkitEntry?.isFile && typeof webkitEntry.name === 'string' && webkitEntry.name.trim().length > 0) {
        fileNames.add(webkitEntry.name.trim());
      }
    } catch {
      // Some runtimes throw here during drag hover metadata probing.
    }
  }

  const maybeExtractNameFromTextPath = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
    if (!firstLine) return;

    let normalized = firstLine;
    if (normalized.startsWith('file://')) {
      try {
        normalized = decodeURIComponent(normalized.replace(/^file:\/\//, ''));
      } catch {
        normalized = normalized.replace(/^file:\/\//, '');
      }
    }

    const name = getFileNameFromPath(normalized);
    if (name.trim().length > 0) {
      fileNames.add(name.trim());
    }
  };

  try {
    maybeExtractNameFromTextPath(dataTransfer.getData('text/uri-list'));
    maybeExtractNameFromTextPath(dataTransfer.getData('text/plain'));
  } catch {
    // Ignore dataTransfer text extraction failures on restricted drag payloads.
  }

  if (fileNames.size === 0) {
    return 'unknown';
  }

  const hasSupported = Array.from(fileNames).some((name) => isSupportedPrepareDropName(name));
  return hasSupported ? 'supported' : 'unsupported';
}

function buildDroppedFilesSignature(files: File[]): string {
  return files
    .map((file) => `${file.name.trim().toLowerCase()}::${Number.isFinite(file.size) ? file.size : -1}`)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
}

function resolveInitialExportThumbnailRenderOptions(): ExportThumbnailRenderOptions {
  if (typeof window === 'undefined') return DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS;

  try {
    const raw = window.localStorage.getItem(EXPORT_THUMBNAIL_RENDER_OPTIONS_STORAGE_KEY);
    if (!raw) return DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS;

    const parsed = JSON.parse(raw) as Partial<ExportThumbnailRenderOptions>;
    return {
      includeGradient: typeof parsed.includeGradient === 'boolean'
        ? parsed.includeGradient
        : DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS.includeGradient,
      includeBuildPlate: typeof parsed.includeBuildPlate === 'boolean'
        ? parsed.includeBuildPlate
        : DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS.includeBuildPlate,
      includeGrid: typeof parsed.includeGrid === 'boolean'
        ? parsed.includeGrid
        : DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS.includeGrid,
      centerOnModel: typeof parsed.centerOnModel === 'boolean'
        ? parsed.centerOnModel
        : DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS.centerOnModel,
    };
  } catch {
    return DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS;
  }
}

function formatPrintingMonitorEstimatedTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';

  const rounded = Math.max(1, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  }

  if (minutes > 0) {
    return `${minutes}m`;
  }

  return '<1m';
}

function formatPrintingMonitorUsedMaterial(ml: number | null): string {
  if (ml == null || !Number.isFinite(ml) || ml <= 0) return '—';
  return `${ml.toFixed(2)} mL`;
}

function formatPrintingMonitorAreaMm2(areaMm2: number | null): string {
  if (areaMm2 == null || !Number.isFinite(areaMm2) || areaMm2 <= 0) return '—';
  if (areaMm2 >= 1000) return `${areaMm2.toFixed(0)} mm²`;
  if (areaMm2 >= 100) return `${areaMm2.toFixed(1)} mm²`;
  return `${areaMm2.toFixed(2)} mm²`;
}

function parsePrintingMonitorSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.round(numeric);
  }

  const hms = trimmed.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = Number(hms[3] ?? '0');
    if ([h, m, s].every((n) => Number.isFinite(n) && n >= 0)) {
      const total = (hms[3] == null)
        ? (h * 60 + m)
        : (h * 3600 + m * 60 + s);
      return total > 0 ? total : null;
    }
  }

  const units = trimmed.match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i);
  if (units) {
    const h = Number(units[1] ?? 0);
    const m = Number(units[2] ?? 0);
    const s = Number(units[3] ?? 0);
    if ([h, m, s].every((n) => Number.isFinite(n) && n >= 0)) {
      const total = Math.round(h * 3600 + m * 60 + s);
      return total > 0 ? total : null;
    }
  }

  return null;
}

function parsePrintingMonitorMaterialMl(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const extracted = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (!extracted) return null;
  const parsed = Number(extracted[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parsePrintingMonitorAreaMm2(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const extracted = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (!extracted) return null;
  const parsed = Number(extracted[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizePrintingMonitorWebcamAspectRatio(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  // Keep practical camera bounds and reject pathological stream metadata.
  if (value < 0.45 || value > 2.4) return null;
  return value;
}

function resolvePrintingMonitorAbsoluteUrl(candidate: string, host: string, port: number): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `http:${trimmed}`;
  const base = `http://${host}${port === 80 ? '' : `:${port}`}`;
  if (trimmed.startsWith('/')) return `${base}${trimmed}`;
  return `${base}/${trimmed.replace(/^\/+/, '')}`;
}

type JsonObject = Record<string, unknown>;

function asJsonObject(value: unknown): JsonObject {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

async function readJsonObject(response: { json: () => Promise<unknown> }): Promise<JsonObject> {
  try {
    const payload = await response.json();
    return asJsonObject(payload);
  } catch {
    return {};
  }
}

function readBooleanField(payload: JsonObject, key: string): boolean | null {
  const value = payload[key];
  return typeof value === 'boolean' ? value : null;
}

function readStringField(payload: JsonObject, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function readNumberField(payload: JsonObject, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export default function Home() {
  const { _ } = useLingui();
  const { stage, sproutParentingLockHeld } = useLeafPlacementState();
  // 1. Scene & Geometry (Multi-Model)
  const scene = useSceneCollectionManager();
  const importSceneFile = scene.importSceneFile;
  const importSceneFiles = scene.importSceneFiles;
  const recentOpenedFiles = scene.recentOpenedFiles;
  const reopenRecentOpenedFile = scene.reopenRecentOpenedFile;
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const sceneAutosaveSettings = React.useSyncExternalStore(
    subscribeToSceneAutosaveSettings,
    getSceneAutosaveSettingsSnapshot,
    getSceneAutosaveSettingsServerSnapshot,
  );
  const workspaceCameraSettings = React.useSyncExternalStore(
    subscribeToWorkspaceCameraSettings,
    getWorkspaceCameraSettingsSnapshot,
    getWorkspaceCameraSettingsServerSnapshot,
  );
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const activeMaterialProfile = React.useMemo(() => getActiveMaterialProfile(profileState), [profileState]);
  const hasActivePrinterProfile = Boolean(activePrinterProfile);

  // 2. Transform Management (needs geom for bounds)
  const transformMgr = useTransformManager({ geom: scene.geom });
  const [uniformScaling, setUniformScaling] = React.useState(true);

  // Ref for supports group (used for export)
  const supportsRef = React.useRef<THREE.Group | null>(null);
  // Hide support geometry in hollowing mode — it just gets in the way.
  React.useEffect(() => {
    const hidden = scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing';
    if (supportsRef.current) supportsRef.current.visible = !hidden;
  }, [scene.mode, transformMgr.transformMode]);
  // Ref for the drag-wrapper group around supports/rafts (live gizmo transform)
  const supportDragGroupRef = React.useRef<THREE.Group | null>(null);
  const exportThumbnailCaptureRef = React.useRef<(() => Promise<Uint8Array | null>) | null>(null);
  const exportThumbnailCaptureRunnerRef = React.useRef<(() => Promise<Uint8Array | null>) | null>(null);
  const supportDragResetRafRef = React.useRef<number | null>(null);
  const supportDragResetSecondRafRef = React.useRef<number | null>(null);
  const [holdSupportDragDeltaUntilSupportSync, setHoldSupportDragDeltaUntilSupportSync] = React.useState(false);
  const [supportDragTransactionId, setSupportDragTransactionId] = React.useState(0);
  const supportDragTransactionIdRef = React.useRef(0);
  const pendingSupportDragSyncRef = React.useRef<PendingSupportDragSyncTransaction | null>(null);
  const supportStoreVersionRef = React.useRef(0);
  const kickstandStoreVersionRef = React.useRef(0);
  const supportSyncFallbackTimeoutRef = React.useRef<number | null>(null);
  const transformDebugTimelineRef = React.useRef<{
    lastOperation: 'move' | 'rotate' | 'scale' | null;
    dragReleasedAt: { perfMs: number; epochMs: number } | null;
    liveCalculatedAt: { perfMs: number; epochMs: number } | null;
    storeUpdateStartedAt: { perfMs: number; epochMs: number } | null;
    storeUpdatedAt: { perfMs: number; epochMs: number } | null;
    supportStoreUpdatedAt: { perfMs: number; epochMs: number } | null;
    kickstandStoreUpdatedAt: { perfMs: number; epochMs: number } | null;
    activeModelStoreObservedAt: { perfMs: number; epochMs: number } | null;
  }>({
    lastOperation: null,
    dragReleasedAt: null,
    liveCalculatedAt: null,
    storeUpdateStartedAt: null,
    storeUpdatedAt: null,
    supportStoreUpdatedAt: null,
    kickstandStoreUpdatedAt: null,
    activeModelStoreObservedAt: null,
  });
  const activeModelStoreTransformKeyRef = React.useRef<string | null>(null);

  // Local state to coordinate transform sync with active model switching
  // This prevents 1-frame flickers where SceneCanvas renders new model with old transform
  const [displayActiveModelId, setDisplayActiveModelId] = React.useState<string | null>(null);
  const pendingTransformHistoryRef = React.useRef<{
    modelId: string;
    before: ModelTransform;
    after?: ModelTransform;
    description?: string;
    supportBefore?: ReturnType<typeof getSupportSnapshot>;
    supportAfter?: ReturnType<typeof getSupportSnapshot>;
    kickstandBefore?: ReturnType<typeof getKickstandSnapshot>;
    kickstandAfter?: ReturnType<typeof getKickstandSnapshot>;
  } | null>(null);
  const transformHistoryCommitRequestedRef = React.useRef(false);
  const transformHistoryCommitNonceRef = React.useRef(0);
  const pendingHistoryTransformResyncRef = React.useRef(false);
  const suppressNextTransformPersistenceRef = React.useRef(false);
  const suppressTransformPersistenceCycleCountRef = React.useRef(0);
  const skipNextTransformEndCommitRef = React.useRef<{
    modelId: string;
    operation: 'move' | 'scale';
  } | null>(null);
  const transformEndFlushedRef = React.useRef(false);
  const pendingRotateGizmoCommitRef = React.useRef<{
    modelId: string;
    before: ModelTransform;
    after: ModelTransform;
    description: string;
  } | null>(null);
  const transformHistoryDebugRef = React.useRef<{
    lastResult:
      | 'none'
      | 'scheduled'
      | 'invalidated'
      | 'committed'
      | 'committed_no_push'
      | 'skipped_equal_transform'
      | 'skipped_nonce_mismatch'
      | 'skipped_no_pending'
      | 'skipped_model_missing';
    lastReason: string;
    lastModelId: string | null;
    lastDescription: string | null;
    lastExpectedNonce: number | null;
    lastScheduledNonce: number | null;
    lastUndoCountBefore: number | null;
    lastUndoCountAfter: number | null;
    lastPushApplied: boolean | null;
    lastAt: { perfMs: number; epochMs: number } | null;
  }>({
    lastResult: 'none',
    lastReason: 'init',
    lastModelId: null,
    lastDescription: null,
    lastExpectedNonce: null,
    lastScheduledNonce: null,
    lastUndoCountBefore: null,
    lastUndoCountAfter: null,
    lastPushApplied: null,
    lastAt: null,
  });
  const [newDeviceToast, setNewDeviceToast] = React.useState<string | null>(null);
  const [isNewDeviceToastVisible, setIsNewDeviceToastVisible] = React.useState(false);
  const newDeviceToastTimeoutRef = React.useRef<number | null>(null);
  const [historyActionToast, setHistoryActionToast] = React.useState<{ id: number; text: string; direction: 'undo' | 'redo' } | null>(null);
  const [isHistoryActionToastVisible, setIsHistoryActionToastVisible] = React.useState(false);
  const [isSceneImportToastVisible, setIsSceneImportToastVisible] = React.useState(false);
  const [exportSuccessToast, setExportSuccessToast] = React.useState<{ id: number; path: string } | null>(null);
  const [isExportSuccessToastVisible, setIsExportSuccessToastVisible] = React.useState(false);
  const [exportErrorToast, setExportErrorToast] = React.useState<{ id: number; text: string } | null>(null);
  const [isExportErrorToastVisible, setIsExportErrorToastVisible] = React.useState(false);
  const [isSceneSaveInProgress, setIsSceneSaveInProgress] = React.useState(false);
  const [isPreSliceSceneSaveInProgress, setIsPreSliceSceneSaveInProgress] = React.useState(false);
  const [isSaveToastVisible, setIsSaveToastVisible] = React.useState(false);
  const [isSaveToastAnimatedVisible, setIsSaveToastAnimatedVisible] = React.useState(false);
  const [saveToastLabel, setSaveToastLabel] = React.useState<'Saving…' | 'Autosaving…'>('Autosaving…');
  const [showPluginImportWarningModal, setShowPluginImportWarningModal] = React.useState(false);
  const [suppressPluginImportWarning, setSuppressPluginImportWarning] = React.useState(false);
  const [pluginImportWarningSkipFuture, setPluginImportWarningSkipFuture] = React.useState(false);
  const [activeSceneFilePath, setActiveSceneFilePath] = React.useState<string | null>(null);
  const [loadedSceneSaveSource, setLoadedSceneSaveSource] = React.useState<{ name: string; path: string | null } | null>(null);
  const [showSceneSaveChoiceModal, setShowSceneSaveChoiceModal] = React.useState(false);
  const [sceneSaveChoiceFileName, setSceneSaveChoiceFileName] = React.useState<string | null>(null);
  const [sceneSaveChoicePath, setSceneSaveChoicePath] = React.useState<string | null>(null);
  const [autosaveRecovery, setAutosaveRecovery] = React.useState<{ savedAt: string } | null>(null);
  const [showCloseUnsavedChangesModal, setShowCloseUnsavedChangesModal] = React.useState(false);
  const [closeUnsavedChangesBusy, setCloseUnsavedChangesBusy] = React.useState<'none' | 'save_and_close' | 'discard_and_close'>('none');
  const [hasUnsavedSceneChanges, setHasUnsavedSceneChanges] = React.useState(false);
  const pluginImportWarningPendingResolveRef = React.useRef<((proceed: boolean) => void) | null>(null);
  const sceneSaveChoiceResolveRef = React.useRef<((choice: 'overwrite' | 'save_as' | 'cancel') => void) | null>(null);
  const [showDamagedModelDialog, setShowDamagedModelDialog] = React.useState(false);

  // ZIP file picker modal
  const [zipPickerState, setZipPickerState] = React.useState<{
    zipName: string;
    files: File[];
    category: 'mesh' | 'scene' | 'mixed';
    defaultSelectionCategory: 'mesh' | 'scene';
  } | null>(null);
  const zipPickerResolveRef = React.useRef<((files: File[]) => void) | null>(null);
  const hasUnsavedSceneChangesRef = React.useRef(false);
  const allowProgrammaticWindowCloseRef = React.useRef(false);
  const sceneSaveBaselineRef = React.useRef<{
    undo: number;
    redo: number;
    modelCount: number;
  }>({
    undo: getUndoCount(),
    redo: getRedoCount(),
    modelCount: scene.models.length,
  });
  const [historyTransformResyncTick, setHistoryTransformResyncTick] = React.useState(0);
  const historyTransformResyncTokenRef = React.useRef(0);
  const historyTransformResyncRafRef = React.useRef<number | null>(null);
  const historyTransformResyncSecondRafRef = React.useRef<number | null>(null);
  const historyTransformResyncTimeoutRef = React.useRef<number | null>(null);
  const historyActionToastFadeTimeoutRef = React.useRef<number | null>(null);
  const historyActionToastClearTimeoutRef = React.useRef<number | null>(null);
  const printingMonitorErrorToastFadeTimeoutRef = React.useRef<number | null>(null);
  const printingMonitorErrorToastClearTimeoutRef = React.useRef<number | null>(null);
  const sceneImportToastFadeTimeoutRef = React.useRef<number | null>(null);
  const exportSuccessToastFadeTimeoutRef = React.useRef<number | null>(null);
  const exportErrorToastFadeTimeoutRef = React.useRef<number | null>(null);
  const saveToastHideTimeoutRef = React.useRef<number | null>(null);
  const saveToastClearTimeoutRef = React.useRef<number | null>(null);
  const saveToastEnterRafRef = React.useRef<number | null>(null);
  const saveToastShownAtRef = React.useRef<number | null>(null);
  const sceneSaveKickoffTimerRef = React.useRef<number | null>(null);
  const sceneSaveInFlightRef = React.useRef(false);
  const sceneSaveQueuedRef = React.useRef(false);
  const queuedSceneSavePathOverrideRef = React.useRef<string | null | undefined>(undefined);
  const preferredOverwriteScenePathRef = React.useRef<string | null>(null);
  const [isSlicingBusy, setIsSlicingBusy] = React.useState(false);

  const sceneAutosaveEnabled = sceneAutosaveSettings.enabled
    && !isSlicingBusy
    && scene.mode !== 'printing';
  const sceneImportAutosaveSuppressMs = Math.min(
    Math.max(sceneAutosaveSettings.debounceMs + 5_000, 15_000),
    45_000,
  );

  const { isAutosaving, clearAutosave, flushAutosave } = useSceneAutosave({
    models: scene.models,
    activeModelId: scene.activeModelId,
    selectedModelIds: scene.selectedModelIds,
    enabled: sceneAutosaveEnabled,
    debounceMs: sceneAutosaveSettings.debounceMs,
    capMs: sceneAutosaveSettings.capMs,
    preferredSavePath: preferredOverwriteScenePathRef.current,
  });

  React.useEffect(() => {
    const MIN_SAVE_TOAST_VISIBLE_MS = 2000;
    const TOAST_ANIMATION_MS = 220;
    const hasActiveSaveWork = isSceneSaveInProgress || (isAutosaving && !isPreSliceSceneSaveInProgress);

    if (hasActiveSaveWork) {
      if (saveToastHideTimeoutRef.current !== null) {
        window.clearTimeout(saveToastHideTimeoutRef.current);
        saveToastHideTimeoutRef.current = null;
      }
      if (saveToastClearTimeoutRef.current !== null) {
        window.clearTimeout(saveToastClearTimeoutRef.current);
        saveToastClearTimeoutRef.current = null;
      }
      if (saveToastEnterRafRef.current !== null) {
        window.cancelAnimationFrame(saveToastEnterRafRef.current);
        saveToastEnterRafRef.current = null;
      }

      setSaveToastLabel(isSceneSaveInProgress ? 'Saving…' : 'Autosaving…');

      if (!isSaveToastVisible) {
        saveToastShownAtRef.current = Date.now();
        setIsSaveToastVisible(true);
        setIsSaveToastAnimatedVisible(false);
        saveToastEnterRafRef.current = window.requestAnimationFrame(() => {
          saveToastEnterRafRef.current = null;
          setIsSaveToastAnimatedVisible(true);
        });
      } else if (!isSaveToastAnimatedVisible) {
        setIsSaveToastAnimatedVisible(true);
      }
      return;
    }

    if (!isSaveToastVisible) {
      saveToastShownAtRef.current = null;
      return;
    }

    const shownAt = saveToastShownAtRef.current ?? Date.now();
    const elapsed = Date.now() - shownAt;
    const remaining = Math.max(0, MIN_SAVE_TOAST_VISIBLE_MS - elapsed);

    if (saveToastHideTimeoutRef.current !== null) {
      window.clearTimeout(saveToastHideTimeoutRef.current);
    }
    saveToastHideTimeoutRef.current = window.setTimeout(() => {
      saveToastHideTimeoutRef.current = null;
      setIsSaveToastAnimatedVisible(false);
      if (saveToastClearTimeoutRef.current !== null) {
        window.clearTimeout(saveToastClearTimeoutRef.current);
      }
      saveToastClearTimeoutRef.current = window.setTimeout(() => {
        saveToastClearTimeoutRef.current = null;
        saveToastShownAtRef.current = null;
        setIsSaveToastVisible(false);
      }, TOAST_ANIMATION_MS);
    }, remaining);
  }, [isAutosaving, isPreSliceSceneSaveInProgress, isSaveToastAnimatedVisible, isSaveToastVisible, isSceneSaveInProgress]);

  React.useEffect(() => {
    return () => {
      if (saveToastHideTimeoutRef.current !== null) {
        window.clearTimeout(saveToastHideTimeoutRef.current);
        saveToastHideTimeoutRef.current = null;
      }
      if (saveToastClearTimeoutRef.current !== null) {
        window.clearTimeout(saveToastClearTimeoutRef.current);
        saveToastClearTimeoutRef.current = null;
      }
      if (saveToastEnterRafRef.current !== null) {
        window.cancelAnimationFrame(saveToastEnterRafRef.current);
        saveToastEnterRafRef.current = null;
      }
    };
  }, []);

  const [sessionShaderOverride, setSessionShaderOverride] = React.useState<MeshShaderType | null>(null);
  const [interiorView, setInteriorView] = React.useState(false);
  const [isPreviewingHollowing, setIsPreviewingHollowing] = React.useState(false);
  const [hollowPreview, setHollowPreview] = React.useState<HollowPreviewState | null>(null);
  const shouldForceHollowingXray = scene.mode === 'prepare'
    && transformMgr.transformMode === 'hollowing'
    && !scene.activeModel?.meshModifiers?.hollowing?.bakedIntoGeometry;
  const effectiveShaderType = (shouldForceHollowingXray || hollowPreview)
    ? 'xray'
    : (sessionShaderOverride ?? scene.shaderType);
  const [isPrepareDragActive, setIsPrepareDragActive] = React.useState(false);
  const [isPrepareDragUnsupported, setIsPrepareDragUnsupported] = React.useState(false);
  const isSupportSpotlightHoldActive = useActionActive('SUPPORTS', 'TEMP_SPOTLIGHT_HOLD');
  const [allowPrepareWithoutPrinter, setAllowPrepareWithoutPrinter] = React.useState(false);
  const [prepareSmoothingSettingsExpanded, setPrepareSmoothingSettingsExpanded] = React.useState(true);
  const [hollowingState, setHollowingState] = React.useState<HollowingPanelState>({
    mode: 'cavity',
    voxelSizeMm: 0.65,
    shellThicknessMm: 2.0,
    infillMode: 'lattice',
    infillCellMm: 4.2426,
    infillBeamRadiusMm: 0.35,
    openFace: 'z_max',
  });
  const [isShellOpenFaceSelected, setIsShellOpenFaceSelected] = React.useState(true);
  const [hollowingDraftEnabled, setHollowingDraftEnabled] = React.useState(false);
  const [hollowingEditMode, setHollowingEditMode] = React.useState(false);
  const [blockedHollowVoxelIndices, setBlockedHollowVoxelIndices] = React.useState<number[]>([]);
  const [editingBlockedHollowVoxelIndices, setEditingBlockedHollowVoxelIndices] = React.useState<number[]>([]);
  const editingBlockedHollowVoxelIndicesRef = React.useRef<number[]>([]);
  const hollowVoxelEditUndoStackRef = React.useRef<number[][]>([]);
  const hollowVoxelEditRedoStackRef = React.useRef<number[][]>([]);
  const hollowingEditModeRef = React.useRef(false);
  const [holePunchState, setHolePunchState] = React.useState<HolePunchPanelState>({
    radiusMm: 2.0,
    radiusYMm: undefined,
    depthMm: getDefaultHolePunchDepthMm(2.0),
    depthMode: 'manual',
  });
  const [holePunchPlacements, setHolePunchPlacements] = React.useState<HolePunchPlacementState[]>([]);
  const holePunchPlacementsRef = React.useRef<HolePunchPlacementState[]>([]);
  const [selectedHolePunchPlacementIds, setSelectedHolePunchPlacementIds] = React.useState<string[]>([]);
  const [hoveredHolePunchPlacementId, setHoveredHolePunchPlacementId] = React.useState<string | null>(null);
  const [holePunchHoverPlacement, setHolePunchHoverPlacement] = React.useState<HolePunchPlacementState | null>(null);
  const [isApplyingHolePunch, setIsApplyingHolePunch] = React.useState(false);
  const [isApplyingBlockersHollowing, setIsApplyingBlockersHollowing] = React.useState(false);
  const [pendingHolePunchAutoApplyModelId, setPendingHolePunchAutoApplyModelId] = React.useState<string | null>(null);
  const holePunchDragStateRef = React.useRef<{
    pointerId: number;
    placementId: string;
    moved: boolean;
  } | null>(null);
  const suppressHolePunchClickPlacementIdRef = React.useRef<string | null>(null);
  const suppressHolePunchGizmoReleaseClickUntilRef = React.useRef(0);
  const [isApplyingHollowing, setIsApplyingHollowing] = React.useState(false);
  const [pendingModifierResetAction, setPendingModifierResetAction] = React.useState<PendingModifierResetAction | null>(null);
  const [pendingBlockerResetState, setPendingBlockerResetState] = React.useState<HollowingPanelState | null>(null);
  const hollowPreviewDebounceTimerRef = React.useRef<number | ReturnType<typeof setTimeout> | null>(null);
  const hollowPreviewRequestSeqRef = React.useRef(0);
  const hollowPreviewResultCacheRef = React.useRef<Map<string, HollowPreviewCacheEntry>>(new Map());
  const hollowPreviewWarmupKeyRef = React.useRef<string | null>(null);
  const [debugPrimitivesPanelVisible, setDebugPrimitivesPanelVisible] = React.useState<boolean>(false);
  const [editorContextMenuPos, setEditorContextMenuPos] = React.useState<{ x: number; y: number } | null>(null);
  const [editorContextMenuSupportTarget, setEditorContextMenuSupportTarget] = React.useState<{
    segmentId: string;
    point: { x: number; y: number; z: number };
  } | null>(null);
  const [manualRepairModelId, setManualRepairModelId] = React.useState<string | null>(null);
  const [isManualRepairing, setIsManualRepairing] = React.useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = React.useState(false);
  const [isSliceMetricsDebugOpen, setIsSliceMetricsDebugOpen] = React.useState(false);
    const handleRegisterExportThumbnailCapture = React.useCallback((capture: (() => Promise<Uint8Array | null>) | null) => {
      exportThumbnailCaptureRef.current = capture;
    }, []);

    const captureExportThumbnailPng = React.useCallback(async () => {
      const runCapture = exportThumbnailCaptureRunnerRef.current;
      if (!runCapture) return null;
      return runCapture();
    }, []);

  const [isHistoryDebugOpen, setIsHistoryDebugOpen] = React.useState(false);
  const [supportsInfoModelId, setSupportsInfoModelId] = React.useState<string | null>(null);
  const [isTransformDebugOverlayOpen, setIsTransformDebugOverlayOpen] = React.useState(false);
  const holePunchAutoDepthRaycasterRef = React.useRef(new THREE.Raycaster());
  const holePunchAutoDepthMeshRef = React.useRef(
    new THREE.Mesh(
      undefined,
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    ),
  );

  React.useEffect(() => {
    holePunchPlacementsRef.current = holePunchPlacements;
  }, [holePunchPlacements]);
  const [transformDebugTick, setTransformDebugTick] = React.useState(0);
  const [supportShaftHoverDebug, setSupportShaftHoverDebug] = React.useState<ShaftHoverDebugDetail>({
    segmentId: null,
    point: null,
  });
  const [printingLayerPreviewUrls, setPrintingLayerPreviewUrls] = React.useState<Array<string | null>>([]);
  const printingLayerPreviewLoadInFlightRef = React.useRef<Set<number>>(new Set());

  const [printingPreviewTotalLayers, setPrintingPreviewTotalLayers] = React.useState(0);
  const [printingSelectedLayer, setPrintingSelectedLayer] = React.useState(1);
  const [printingDisplayedLayer, setPrintingDisplayedLayer] = React.useState(1);
  const [isPrintingLayerScrubbing, setIsPrintingLayerScrubbing] = React.useState(false);
  const [printingPngLoadedUrl, setPrintingPngLoadedUrl] = React.useState<string | null>(null);
  const [isSceneLayerScrubbing, setIsSceneLayerScrubbing] = React.useState(false);
  const [isPrintingPreviewSettled, setIsPrintingPreviewSettled] = React.useState(false);
  const [isPrintingSettledCanvasReady, setIsPrintingSettledCanvasReady] = React.useState(false);

  const defaultHollowingState = React.useMemo<HollowingPanelState>(() => ({
    mode: 'cavity',
    voxelSizeMm: 0.65,
    shellThicknessMm: 2.0,
    infillMode: 'lattice',
    infillCellMm: 4.2426,
    infillBeamRadiusMm: 0.35,
    openFace: 'z_max',
  }), []);

  const defaultHolePunchState = React.useMemo<HolePunchPanelState>(() => ({
    radiusMm: 2.0,
    radiusYMm: undefined,
    depthMm: getDefaultHolePunchDepthMm(defaultHollowingState.shellThicknessMm),
    depthMode: 'manual',
  }), [defaultHollowingState.shellThicknessMm]);
  const recommendedHolePunchDepthMm = React.useMemo(
    () => getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm),
    [hollowingState.shellThicknessMm],
  );
  const hollowingSourceByModelIdRef = React.useRef<Map<string, HollowingSourceEntry>>(new Map());
  const cavityGeometryByModelIdRef = React.useRef<Map<string, CavityGeometryEntry>>(new Map());
  const [printingPreviewZoom, setPrintingPreviewZoom] = React.useState(1);
  const [printingPreviewPan, setPrintingPreviewPan] = React.useState({ x: 0, y: 0 });
  const [isPrintingPreviewPanning, setIsPrintingPreviewPanning] = React.useState(false);
  const [exportThumbnailRenderOptions, setExportThumbnailRenderOptions] = React.useState<ExportThumbnailRenderOptions>(resolveInitialExportThumbnailRenderOptions);
  const printingPreviewViewportRef = React.useRef<HTMLDivElement | null>(null);
  const printingPreviewCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const printingPreviewSettleTimeoutRef = React.useRef<number | null>(null);
  const printingPreviewSettledRef = React.useRef(false);
  const printingPreviewCanvasRenderNonceRef = React.useRef(0);
  const printingPreviewLoadNonceRef = React.useRef(0);
  const pendingPrintingSelectedLayerRef = React.useRef<number | null>(null);
  const printingSelectedLayerRafRef = React.useRef<number | null>(null);
  const printingSelectedLayerRef = React.useRef(1);
  const printingPreviewZoomRef = React.useRef(1);
  const printingPreviewPanRef = React.useRef({ x: 0, y: 0 });
  const printingPreviewPanPendingRef = React.useRef({ x: 0, y: 0 });
  const printingPreviewPanRafRef = React.useRef<number | null>(null);
  const previousSceneModeRef = React.useRef<typeof scene.mode>(scene.mode);
  const preservedNonPrintingLayerIndexRef = React.useRef<number | null>(null);
  const lastSliceHistoryEventIdRef = React.useRef<number | null>(null);
  const triggerSliceExportRef = React.useRef<(() => void) | null>(null);
  const modeBeforePrintingRef = React.useRef<typeof scene.mode>('prepare');
  const shouldReturnToPrintingAfterSliceRef = React.useRef(false);
  const sliceIntentRef = React.useRef<SliceIntent>('file');
  const pendingPostSliceActionRef = React.useRef<'upload' | 'print' | null>(null);
  const pendingAutoStartPrintRef = React.useRef(false);
  const preSliceFileDestinationPathRef = React.useRef<string | null>(null);
  const preSliceUploadSelectionRef = React.useRef<{ deviceId: string; materialId?: string } | null>(null);
  const preSliceTargetPickerResolverRef = React.useRef<((selection: { deviceId: string; materialId?: string } | null) => void) | null>(null);
  const preSlicePrintConfirmResolverRef = React.useRef<((confirmed: boolean) => void) | null>(null);
  const printingPreviewDragRef = React.useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [printingArtifact, setPrintingArtifact] = React.useState<SliceExportArtifact | null>(null);
  const [printingSlicingBenchmark, setPrintingSlicingBenchmark] = React.useState<SliceExportResult['benchmark'] | null>(null);
  const [printingArtifactIsInvalid, setPrintingArtifactIsInvalid] = React.useState(false);
  const slicedArtifactProfileFingerprintRef = React.useRef<string | null>(null);
  const [printingEstimatedResinMl, setPrintingEstimatedResinMl] = React.useState<number | null>(null);
  const printingEstimatedResinMlRef = React.useRef<number | null>(null);
  const [isPrintingEstimatedResinBusy, setIsPrintingEstimatedResinBusy] = React.useState(false);
  const [resinEstimateRefreshTick, setResinEstimateRefreshTick] = React.useState(0);
  const printingBaseResinMlCacheRef = React.useRef<Map<string, number | null>>(new Map());
  const printingInFlightBaseResinMlRef = React.useRef<Map<string, Promise<number | null>>>(new Map());
  const lastCompletedResinEstimateSignatureRef = React.useRef<string>('');
  const [showUnappliedHolePunchModal, setShowUnappliedHolePunchModal] = React.useState(false);
  const unappliedHolePunchResolveRef = React.useRef<((action: 'apply' | 'skip') => void) | null>(null);
  const [showPrintingResliceModal, setShowPrintingResliceModal] = React.useState(false);
  const [showSliceCompletedModal, setShowSliceCompletedModal] = React.useState(false);
  const [sliceCompletedModalData, setSliceCompletedModalData] = React.useState<{
    filePath: string | null;
    slicingTimeMs: number | null;
  }>({ filePath: null, slicingTimeMs: null });
  const [uvToolsLaunchingPath, setUvToolsLaunchingPath] = React.useState<string | null>(null);
  const [shouldAutoSliceOnExportEntry, setShouldAutoSliceOnExportEntry] = React.useState(false);
  const [printingSendBusy, setPrintingSendBusy] = React.useState(false);
  const [printingSendStatusText, setPrintingSendStatusText] = React.useState<string | null>(null);
  const printingSendCancelRequestedRef = React.useRef(false);
  const [printingSendProgress, setPrintingSendProgress] = React.useState(0);
  const [printingSendStageText, setPrintingSendStageText] = React.useState<string | null>(null);
  const [printingUploadTelemetry, setPrintingUploadTelemetry] = React.useState<{
    speed: string;
    remaining: string;
    transferred: string;
  } | null>(null);
  const [completedSliceIntent, setCompletedSliceIntent] = React.useState<SliceIntent | null>(null);
  const [completedSaveDestinationPath, setCompletedSaveDestinationPath] = React.useState<string | null>(null);
  const [printingReadyPlateId, setPrintingReadyPlateId] = React.useState<number | null>(null);
  const [printingPrintNowBusy, setPrintingPrintNowBusy] = React.useState(false);
  const [printingUploadDialogOpen, setPrintingUploadDialogOpen] = React.useState(false);
  const [printingTargetPickerOpen, setPrintingTargetPickerOpen] = React.useState(false);
  const [printingTargetPickerMode, setPrintingTargetPickerMode] = React.useState<'post-slice' | 'pre-slice-upload' | 'pre-slice-print'>('post-slice');
  const [printingTargetDeviceId, setPrintingTargetDeviceId] = React.useState<string | null>(null);
  const [printingTargetMaterialId, setPrintingTargetMaterialId] = React.useState<string>('');
  const [printingTargetMaterialOptions, setPrintingTargetMaterialOptions] = React.useState<FleetUploadMaterialOption[]>([]);
  const [isPrintingTargetMaterialsLoading, setIsPrintingTargetMaterialsLoading] = React.useState(false);
  const [printingTargetMaterialError, setPrintingTargetMaterialError] = React.useState<string | null>(null);
  const printingTargetMaterialsCacheRef = React.useRef<Map<string, FleetUploadMaterialOption[]>>(new Map());
  const [printingMonitorSnapshot, setPrintingMonitorSnapshot] = React.useState<PrinterMonitoringSnapshot | null>(null);
  const [printingMonitorWebcamInfo, setPrintingMonitorWebcamInfo] = React.useState<PrinterMonitoringWebcamInfo | null>(null);
  const [printingMonitorRelayBaseWsUrl, setPrintingMonitorRelayBaseWsUrl] = React.useState<string | null>(null);
  const [printingMonitorRelaySetupError, setPrintingMonitorRelaySetupError] = React.useState<string | null>(null);
  const [printingMonitorRelayDebugTransport, setPrintingMonitorRelayDebugTransport] = React.useState<{
    clientPort: number | null;
    serverPort: number | null;
    transportHeader: string | null;
    updatedAtEpochMs: number | null;
  } | null>(null);
  const [printingMonitorRelayReclaimDebug, setPrintingMonitorRelayReclaimDebug] = React.useState<{
    activeSessionId: string | null;
    clientRtpPort: number | null;
    serverRtpPort: number | null;
    lastClaimStatus: string | null;
    lastClaimAtMs: number | null;
    updatedAtMs: number | null;
  } | null>(null);
  const [isPrintingMonitorThumbnailLoaded, setIsPrintingMonitorThumbnailLoaded] = React.useState(false);
  const [printingMonitorThumbnailDisplayUrl, setPrintingMonitorThumbnailDisplayUrl] = React.useState<string | null>(null);
  const [isPrintingMonitorWebcamLoaded, setIsPrintingMonitorWebcamLoaded] = React.useState(false);
  const [printingMonitorWebcamLoadError, setPrintingMonitorWebcamLoadError] = React.useState<string | null>(null);
  const [printingMonitorWebcamAspectRatio, setPrintingMonitorWebcamAspectRatio] = React.useState<number | null>(null);
  const [printingMonitorWebcamRefreshNonce, setPrintingMonitorWebcamRefreshNonce] = React.useState(0);
  const [isPrintingMonitorWebcamResetBusy, setIsPrintingMonitorWebcamResetBusy] = React.useState(false);
  const [isPrintingMonitorWebcamSnapshotSaving, setIsPrintingMonitorWebcamSnapshotSaving] = React.useState(false);
  const [printingMonitorWebcamExpanded, setPrintingMonitorWebcamExpanded] = React.useState(false);
  const [preSlicePrintConfirmOpen, setPreSlicePrintConfirmOpen] = React.useState(false);
  const [printingMonitorRecentPlates, setPrintingMonitorRecentPlates] = React.useState<PrintingMonitorRecentPlate[]>([]);
  const [isPrintingMonitorRecentPlatesLoading, setIsPrintingMonitorRecentPlatesLoading] = React.useState(false);
  const [printingMonitorRecentPlatesError, setPrintingMonitorRecentPlatesError] = React.useState<string | null>(null);
  const [printingMonitorPlatesStoragePath, setPrintingMonitorPlatesStoragePath] = React.useState<'/local/' | '/usb/'>('/local/');
  const [printingMonitorSelectedPlateId, setPrintingMonitorSelectedPlateId] = React.useState<number | null>(null);
  const [isPrintingMonitorPolling, setIsPrintingMonitorPolling] = React.useState(false);
  const [isPrintingMonitorStatusRequestInFlight, setIsPrintingMonitorStatusRequestInFlight] = React.useState(false);
  const [printingMonitorLastStatusSuccessAtMs, setPrintingMonitorLastStatusSuccessAtMs] = React.useState<number | null>(null);
  const [printingMonitorNowEpochMs, setPrintingMonitorNowEpochMs] = React.useState(() => Date.now());
  const [printingMonitorErrorToast, setPrintingMonitorErrorToast] = React.useState<{ id: number; text: string } | null>(null);
  const [isPrintingMonitorErrorToastVisible, setIsPrintingMonitorErrorToastVisible] = React.useState(false);
  const [printingMonitorActionBusy, setPrintingMonitorActionBusy] = React.useState<null | 'start' | 'delete' | 'pause' | 'resume' | 'cancel' | 'emergency-stop' | 'webcam-enable' | 'webcam-disable' | 'timelapse-enable' | 'timelapse-disable'>(null);
  const [printingMonitorControlPendingAction, setPrintingMonitorControlPendingAction] = React.useState<null | 'pause' | 'resume' | 'cancel' | 'emergency-stop'>(null);
  const [printingMonitorActionStatus, setPrintingMonitorActionStatus] = React.useState<string | null>(null);
  const [printingMonitorPendingConfirmation, setPrintingMonitorPendingConfirmation] = React.useState<PrintingMonitorPendingConfirmation | null>(null);
  const [printingMonitorDeviceId, setPrintingMonitorDeviceId] = React.useState<string | null>(null);
  const [printingMonitorViewMode, setPrintingMonitorViewMode] = React.useState<'detail' | 'dashboard'>('detail');
  const [printingMonitorDashboardSnapshots, setPrintingMonitorDashboardSnapshots] = React.useState<Record<string, PrinterMonitoringSnapshot | null>>({});
  const [isPrintingMonitorDashboardRefreshing, setIsPrintingMonitorDashboardRefreshing] = React.useState(false);
  const [isPrintingMonitorPrinterMenuOpen, setIsPrintingMonitorPrinterMenuOpen] = React.useState(false);
  const [isPrintingMonitorPrinterThumbnailFailed, setIsPrintingMonitorPrinterThumbnailFailed] = React.useState(false);
  const [printingMonitorModalOpen, setPrintingMonitorModalOpen] = React.useState(false);
  const [isPrintingMonitorDebugOpen, setIsPrintingMonitorDebugOpen] = React.useState(false);
  const [isPrintingMonitorRtspDebugOpen, setIsPrintingMonitorRtspDebugOpen] = React.useState(false);
  const [printingMonitorDebugCopyState, setPrintingMonitorDebugCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const [printingMonitorLastFeatureToggleResponse, setPrintingMonitorLastFeatureToggleResponse] = React.useState<PrintingMonitorFeatureToggleResponse | null>(null);
  const [printingMonitorDebugState, setPrintingMonitorDebugState] = React.useState<PrintingMonitorDebugState>({
    status: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
    webcam: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
    plates: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
    taskHistory: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
    taskDetails: {
      requestedAtEpochMs: null,
      request: null,
      httpStatus: null,
      rawPayload: null,
      parsedPayload: null,
      error: null,
    },
  });
  const lastPrintingMonitorErrorToastRef = React.useRef<{ message: string; atEpochMs: number } | null>(null);
  const clearPrintingMonitorErrorToastTimeouts = React.useCallback(() => {
    if (printingMonitorErrorToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(printingMonitorErrorToastFadeTimeoutRef.current);
      printingMonitorErrorToastFadeTimeoutRef.current = null;
    }
    if (printingMonitorErrorToastClearTimeoutRef.current !== null) {
      window.clearTimeout(printingMonitorErrorToastClearTimeoutRef.current);
      printingMonitorErrorToastClearTimeoutRef.current = null;
    }
  }, []);

  const normalizePrintingMonitorErrorMessage = React.useCallback((message: string) => {
    const normalized = message.trim();
    if (!normalized) return '';

    const lower = normalized.toLowerCase();
    if (lower.includes('tainted canvases may not be exported')) {
      return 'Unable to export this webcam frame directly. Retrying through the secure snapshot proxy.';
    }

    return normalized;
  }, []);

  const setPrintingMonitorError = React.useCallback((nextError: string | null) => {
    const normalized = typeof nextError === 'string' ? normalizePrintingMonitorErrorMessage(nextError) : '';

    if (!normalized) {
      clearPrintingMonitorErrorToastTimeouts();
      setIsPrintingMonitorErrorToastVisible(false);
      setPrintingMonitorErrorToast(null);
      return;
    }

    const now = Date.now();
    const previous = lastPrintingMonitorErrorToastRef.current;
    if (
      previous
      && previous.message === normalized
      && (now - previous.atEpochMs) < 1500
    ) {
      return;
    }

    lastPrintingMonitorErrorToastRef.current = {
      message: normalized,
      atEpochMs: now,
    };

    setPrintingMonitorErrorToast({ id: now, text: normalized });
    setIsPrintingMonitorErrorToastVisible(true);

    clearPrintingMonitorErrorToastTimeouts();
    printingMonitorErrorToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsPrintingMonitorErrorToastVisible(false);
      printingMonitorErrorToastFadeTimeoutRef.current = null;
    }, 2200);

    printingMonitorErrorToastClearTimeoutRef.current = window.setTimeout(() => {
      setPrintingMonitorErrorToast(null);
      printingMonitorErrorToastClearTimeoutRef.current = null;
    }, 2600);
  }, [clearPrintingMonitorErrorToastTimeouts, normalizePrintingMonitorErrorMessage]);

  React.useEffect(() => {
    return () => {
      clearPrintingMonitorErrorToastTimeouts();
    };
  }, [clearPrintingMonitorErrorToastTimeouts]);

  const printingMonitorPrinterMenuRef = React.useRef<HTMLDivElement | null>(null);
  const printingMonitorWebcamViewportRef = React.useRef<HTMLDivElement | null>(null);
  const printingMonitorThumbnailCacheRef = React.useRef<Map<string, string>>(new Map());
  const printingMonitorWebcamRequestInFlightRef = React.useRef(false);
  const printingMonitorWebcamBusyUntilEpochMsRef = React.useRef(0);
  const printingMonitorWebcamAutoPollBlockedRef = React.useRef(false);
  const printingMonitorWebcamConsecutiveTimeoutsRef = React.useRef(0);
  const printingMonitorRelayAutoRetryCountRef = React.useRef(0);
  const printingMonitorRelayAutoRetryTimeoutRef = React.useRef<number | null>(null);
  const printingMonitorWebcamReadinessTokenRef = React.useRef(0);
  const printingMonitorWebcamReadinessTimeoutRef = React.useRef<number | null>(null);
  const printingMonitorStartFocusDeviceIdRef = React.useRef<string | null>(null);
  const printingMonitorRecentPlatesRequestIdRef = React.useRef(0);
  const printingMonitorRecentPlatesRef = React.useRef<PrintingMonitorRecentPlate[]>([]);
  const printingMonitorSelectedPlateIdRef = React.useRef<number | null>(null);
  const printingMonitorRecentPlatesCacheRef = React.useRef<Map<string, {
    plates: PrintingMonitorRecentPlate[];
    selectedPlateId: number | null;
    error: string | null;
  }>>(new Map());
  const printingMonitorLeftColumnRef = React.useRef<HTMLElement | null>(null);
  const printingMonitorWebcamSectionRef = React.useRef<HTMLElement | null>(null);
  const printingMonitorWebcamFollowerHeightPxRef = React.useRef<number | null>(null);
  const monitorReachabilityInconclusiveCountsRef = React.useRef<Record<string, number>>({});
  const topbarPrinterOfflineCacheByDeviceIdRef = React.useRef<Record<string, boolean>>({});
  const [selectedPrinterMonitorSnapshot, setSelectedPrinterMonitorSnapshot] = React.useState<PrinterMonitoringSnapshot | null>(null);
  const printerReachabilityByDeviceId = React.useSyncExternalStore(
    subscribeToPrinterReachability,
    getPrinterReachabilitySnapshot,
    getPrinterReachabilityServerSnapshot,
  );
  const [printingUploadDialogStage, setPrintingUploadDialogStage] = React.useState<'uploading' | 'processing' | 'ready' | 'starting' | 'failed' | 'started'>('uploading');
  const [printingUploadDisplayProgress, setPrintingUploadDisplayProgress] = React.useState(0);
  const printingUploadProcessingHandoffTimeoutRef = React.useRef<number | null>(null);
  const [printingDeviceProcessingStartedAtMs, setPrintingDeviceProcessingStartedAtMs] = React.useState<number | null>(null);
  const [printingDeviceProcessingElapsedSec, setPrintingDeviceProcessingElapsedSec] = React.useState(0);
  const lastOwnedPrintTempPathRef = React.useRef<string | null>(null);
  const [historyDebugEvents, setHistoryDebugEvents] = React.useState<HistoryDebugEvent[]>([]);
  const [historyStackCounts, setHistoryStackCounts] = React.useState<{ undo: number; redo: number }>({
    undo: 0,
    redo: 0,
  });
  const [historyPreviewTargetEventId, setHistoryPreviewTargetEventId] = React.useState<number | null>(null);
  const [isHistoryPreviewActive, setIsHistoryPreviewActive] = React.useState(false);
  const historyPreviewBaselineRef = React.useRef<{ undo: number; redo: number } | null>(null);
  const [isSelectAllModelsActive, setIsSelectAllModelsActive] = React.useState(false);
  const [isTemporarilyDisablingCrossSectionForThumbnail, setIsTemporarilyDisablingCrossSectionForThumbnail] = React.useState(false);
  const [isCrossSectionEnabled, setIsCrossSectionEnabled] = React.useState(true);
  const handleToggleCrossSection = React.useCallback(() => setIsCrossSectionEnabled((prev) => !prev), []);
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
  const [activeArrangeOperation, setActiveArrangeOperation] = React.useState<'standard' | 'high_precision' | 'high_precision_fill' | 'array' | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      EXPORT_THUMBNAIL_RENDER_OPTIONS_STORAGE_KEY,
      JSON.stringify(exportThumbnailRenderOptions),
    );
  }, [exportThumbnailRenderOptions]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(PLUGIN_IMPORT_WARNING_DISMISSED_STORAGE_KEY);
      setSuppressPluginImportWarning(stored === '1');
    } catch {
      setSuppressPluginImportWarning(false);
    }
  }, []);

  React.useEffect(() => {
    return () => {
      if (pluginImportWarningPendingResolveRef.current) {
        const resolve = pluginImportWarningPendingResolveRef.current;
        pluginImportWarningPendingResolveRef.current = null;
        resolve(false);
      }
    };
  }, []);

  React.useEffect(() => {
    if (!scene.sceneImportPlacementPrompt) return;

    let wasEscapePressed = false;

    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isEscapePressed = active.has('escape');
      if (isEscapePressed && !wasEscapePressed) {
        scene.resolveSceneImportPlacementPrompt('load_as_is');
      }
      wasEscapePressed = isEscapePressed;
    });

    return unsubscribe;
  }, [scene.sceneImportPlacementPrompt, scene.resolveSceneImportPlacementPrompt]);

  const hasPluginSceneFile = React.useCallback((filesInput: FileList | File[]) => {
    const files = Array.from(filesInput);
    return files.some((file) => file.name.trim().toLowerCase().endsWith('.lys'));
  }, []);

  const maybeConfirmPluginImportWarning = React.useCallback(async (filesInput: FileList | File[]) => {
    if (suppressPluginImportWarning) return true;
    if (!hasPluginSceneFile(filesInput)) return true;

    if (pluginImportWarningPendingResolveRef.current) {
      const pendingResolve = pluginImportWarningPendingResolveRef.current;
      pluginImportWarningPendingResolveRef.current = null;
      pendingResolve(false);
    }

    setPluginImportWarningSkipFuture(false);
    setShowPluginImportWarningModal(true);
    return await new Promise<boolean>((resolve) => {
      pluginImportWarningPendingResolveRef.current = resolve;
    });
  }, [hasPluginSceneFile, suppressPluginImportWarning]);

  const resolvePluginImportWarning = React.useCallback((proceed: boolean) => {
    const resolve = pluginImportWarningPendingResolveRef.current;
    pluginImportWarningPendingResolveRef.current = null;
    setPluginImportWarningSkipFuture(false);
    setShowPluginImportWarningModal(false);
    resolve?.(proceed);
  }, []);

  const handleCancelPluginImportWarning = React.useCallback(() => {
    resolvePluginImportWarning(false);
  }, [resolvePluginImportWarning]);

  const handleContinuePluginImportWarning = React.useCallback(() => {
    if (pluginImportWarningSkipFuture) {
      setSuppressPluginImportWarning(true);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(PLUGIN_IMPORT_WARNING_DISMISSED_STORAGE_KEY, '1');
        } catch {
          // Ignore persistence failure and still proceed.
        }
      }
    }
    resolvePluginImportWarning(true);
  }, [pluginImportWarningSkipFuture, resolvePluginImportWarning]);

  const resolveSceneSaveChoice = React.useCallback((choice: 'overwrite' | 'save_as' | 'cancel') => {
    const resolve = sceneSaveChoiceResolveRef.current;
    sceneSaveChoiceResolveRef.current = null;
    setShowSceneSaveChoiceModal(false);
    setSceneSaveChoiceFileName(null);
    setSceneSaveChoicePath(null);
    resolve?.(choice);
  }, []);

  const promptSceneSaveChoice = React.useCallback(async (
    options: { fileName: string; scenePath: string | null },
  ): Promise<'overwrite' | 'save_as' | 'cancel'> => {
    if (sceneSaveChoiceResolveRef.current) {
      sceneSaveChoiceResolveRef.current('cancel');
      sceneSaveChoiceResolveRef.current = null;
    }

    setSceneSaveChoiceFileName(options.fileName);
    setSceneSaveChoicePath(options.scenePath);
    setShowSceneSaveChoiceModal(true);

    return await new Promise<'overwrite' | 'save_as' | 'cancel'>((resolve) => {
      sceneSaveChoiceResolveRef.current = resolve;
    });
  }, []);

  React.useEffect(() => {
    if (!showSceneSaveChoiceModal) return;

    let wasEscapePressed = false;

    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isEscapePressed = active.has('escape');
      if (isEscapePressed && !wasEscapePressed) {
        resolveSceneSaveChoice('cancel');
      }
      wasEscapePressed = isEscapePressed;
    });

    return unsubscribe;
  }, [resolveSceneSaveChoice, showSceneSaveChoiceModal]);

  React.useEffect(() => {
    return () => {
      if (sceneSaveChoiceResolveRef.current) {
        sceneSaveChoiceResolveRef.current('cancel');
        sceneSaveChoiceResolveRef.current = null;
      }
    };
  }, []);

  const markSceneSaveBaseline = React.useCallback(() => {
    sceneSaveBaselineRef.current = {
      undo: getUndoCount(),
      redo: getRedoCount(),
      modelCount: scene.models.length,
    };
    setHasUnsavedSceneChanges(false);
    hasUnsavedSceneChangesRef.current = false;
  }, [scene.models.length]);

  const recomputeUnsavedSceneChanges = React.useCallback(() => {
    const baseline = sceneSaveBaselineRef.current;
    const undoCount = getUndoCount();
    const redoCount = getRedoCount();
    const modelCount = scene.models.length;

    const dirty = modelCount > 0 && (
      undoCount !== baseline.undo
      || redoCount !== baseline.redo
      || modelCount !== baseline.modelCount
    );

    setHasUnsavedSceneChanges(dirty);
    hasUnsavedSceneChangesRef.current = dirty;
  }, [scene.models.length]);

  React.useEffect(() => {
    const unsubscribe = subscribeHistory(recomputeUnsavedSceneChanges);
    return () => {
      unsubscribe();
    };
  }, [recomputeUnsavedSceneChanges]);

  React.useEffect(() => {
    recomputeUnsavedSceneChanges();
  }, [recomputeUnsavedSceneChanges, scene.models.length]);

  const importSceneFilesWithPluginWarning = React.useCallback(async (
    filesInput: FileList | File[],
    options?: { resultingScenePath?: string | null; sourcePaths?: Array<string | null | undefined> },
  ): Promise<boolean> => {
    const sceneFiles = Array.from(filesInput);
    if (sceneFiles.length === 0) return false;

    const proceed = await maybeConfirmPluginImportWarning(sceneFiles);
    if (!proceed) return false;

    // Fresh imports can emit a burst of history/model-count changes while meshes are
    // still decoding and settling. Keep autosave asleep across the import and the
    // immediate post-import stabilization window to avoid adding save/export work to
    // the hot path.
    suppressSceneAutosave(sceneImportAutosaveSuppressMs);

    const imported = sceneFiles.length === 1
      ? await importSceneFile(sceneFiles[0], {
          sourcePath: options?.sourcePaths?.[0] ?? options?.resultingScenePath ?? null,
        })
      : await importSceneFiles(sceneFiles, {
          sourcePaths: options?.sourcePaths,
        });

    if (imported) {
      const importedSingleFile = sceneFiles.length === 1 ? sceneFiles[0] : null;
      const importedSingleIsVoxl = Boolean(importedSingleFile && getFileExtension(importedSingleFile.name) === '.voxl');
      const normalizedScenePath = normalizeActiveVoxlScenePath(options?.resultingScenePath);
      setActiveSceneFilePath(normalizedScenePath);
      if (importedSingleFile && importedSingleIsVoxl) {
        setLoadedSceneSaveSource({
          name: importedSingleFile.name,
          path: normalizedScenePath,
        });
        markSceneSaveBaseline();
      } else {
        setLoadedSceneSaveSource(null);
      }

      suppressSceneAutosave(sceneImportAutosaveSuppressMs);
    }

    return imported;
  }, [importSceneFile, importSceneFiles, markSceneSaveBaseline, maybeConfirmPluginImportWarning, sceneImportAutosaveSuppressMs]);

  // ── ZIP import helpers ───────────────────────────────────────────────────

  const resolveZipFiles = React.useCallback(async (
    zip: File,
    requestedCategory: 'mesh' | 'scene',
  ): Promise<{ meshFiles: File[]; sceneFiles: File[] }> => {
    const meshExts = new Set(['.stl', '.obj', '.3mf']);
    const sceneExts = new Set(['.voxl', '.lys']);
    const oppositeCategory = requestedCategory === 'mesh' ? 'scene' : 'mesh';

    const readingLabel = 'Loading Archive…';
    setNativePickerPreparationState({
      active: true,
      label: readingLabel,
      detail: `Reading ${zip.name}…`,
      progress: null,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    let extracted: File[];
    try {
      extracted = await extractFilesFromZip(zip);
    } catch (err) {
      console.error('[ZIP] Failed to read ZIP archive:', err);
      setNativePickerPreparationState({ active: false, label: '', detail: '', progress: null });
      return { meshFiles: [], sceneFiles: [] };
    }

    const meshCandidates = extracted.filter((f) => meshExts.has(getFileExtensionLower(f.name)));
    const sceneCandidates = extracted.filter((f) => sceneExts.has(getFileExtensionLower(f.name)));

    // Clear spinner before potentially showing the picker modal (or returning nothing)
    setNativePickerPreparationState({ active: false, label: '', detail: '', progress: null });

    const hasMeshCandidates = meshCandidates.length > 0;
    const hasSceneCandidates = sceneCandidates.length > 0;

    let targetCategory: 'mesh' | 'scene' | 'mixed';
    let targetCandidates: File[];

    if (hasMeshCandidates && hasSceneCandidates) {
      // Fully mixed ZIP: allow user to choose any combination of mesh/scene files.
      targetCategory = 'mixed';
      targetCandidates = [...meshCandidates, ...sceneCandidates];
    } else {
      const primaryCandidates = requestedCategory === 'mesh' ? meshCandidates : sceneCandidates;
      const oppositeCandidates = requestedCategory === 'mesh' ? sceneCandidates : meshCandidates;
      targetCategory = primaryCandidates.length === 0 && oppositeCandidates.length > 0
        ? oppositeCategory
        : requestedCategory;
      targetCandidates = targetCategory === 'mesh' ? meshCandidates : sceneCandidates;
    }

    if (targetCandidates.length === 0) {
      return { meshFiles: [], sceneFiles: [] };
    }

    const uniqueExts = new Set(targetCandidates.map((f) => getFileExtensionLower(f.name)));
    const selectedCandidates = (targetCategory !== 'mixed' && uniqueExts.size === 1)
      ? targetCandidates
      : await new Promise<File[]>((resolve) => {
          zipPickerResolveRef.current = resolve;
          setZipPickerState({
            zipName: zip.name,
            files: targetCandidates,
            category: targetCategory,
            defaultSelectionCategory: requestedCategory,
          });
        });

    const selectedMeshFiles = selectedCandidates.filter((file) => meshExts.has(getFileExtensionLower(file.name)));
    const selectedSceneFiles = selectedCandidates.filter((file) => sceneExts.has(getFileExtensionLower(file.name)));

    return {
      meshFiles: selectedMeshFiles,
      sceneFiles: selectedSceneFiles,
    };
  }, []);

  const expandPickedFilesWithZip = React.useCallback(async (
    files: File[],
    requestedCategory: 'mesh' | 'scene',
  ): Promise<{ meshFiles: File[]; sceneFiles: File[] }> => {
    const meshExts = new Set(['.stl', '.obj', '.3mf']);
    const sceneExts = new Set(['.voxl', '.lys']);

    const meshFiles: File[] = [];
    const sceneFiles: File[] = [];

    for (const file of files) {
      const ext = getFileExtensionLower(file.name);
      if (ext === '.zip') {
        const expanded = await resolveZipFiles(file, requestedCategory);
        if (expanded.meshFiles.length > 0) meshFiles.push(...expanded.meshFiles);
        if (expanded.sceneFiles.length > 0) sceneFiles.push(...expanded.sceneFiles);
      } else if (meshExts.has(ext)) {
        meshFiles.push(file);
      } else if (sceneExts.has(ext)) {
        sceneFiles.push(file);
      }
    }

    return { meshFiles, sceneFiles };
  }, [resolveZipFiles]);

  // ─────────────────────────────────────────────────────────────────────────

  const handleImportSceneInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    void importSceneFilesWithPluginWarning(files);
    e.target.value = '';
  }, [importSceneFilesWithPluginWarning]);

  const handleLoadMeshChangeWithZip = React.useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    e.target.value = '';
    const processed = await expandPickedFilesWithZip(files, 'mesh');
    if (processed.meshFiles.length > 0) {
      void scene.loadFiles(processed.meshFiles);
    }
    if (processed.sceneFiles.length > 0) {
      await importSceneFilesWithPluginWarning(processed.sceneFiles, { resultingScenePath: null });
    }
  }, [expandPickedFilesWithZip, importSceneFilesWithPluginWarning, scene]);

  const handleImportSceneChangeWithZip = React.useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    e.target.value = '';
    const processed = await expandPickedFilesWithZip(files, 'scene');
    if (processed.sceneFiles.length > 0) {
      await importSceneFilesWithPluginWarning(processed.sceneFiles, { resultingScenePath: null });
    }
    if (processed.meshFiles.length > 0) {
      void scene.loadFiles(processed.meshFiles);
    }
  }, [expandPickedFilesWithZip, importSceneFilesWithPluginWarning, scene]);

  const handleReopenRecentFile = React.useCallback(async (entryId: string) => {
    const entry = recentOpenedFiles.find((item) => item.id === entryId);
    if (!entry) return false;

    if (entry.kind === 'scene' && entry.name.trim().toLowerCase().endsWith('.lys')) {
      const proceed = await maybeConfirmPluginImportWarning([
        new File([], entry.name, { type: 'application/octet-stream' }),
      ]);
      if (!proceed) return false;
    }

    const sourcePath = typeof entry.sourcePath === 'string' && entry.sourcePath.trim().length > 0
      ? entry.sourcePath.trim()
      : null;

    // Preferred path for desktop: reload from the original source file so the
    // editing session can resume with an overwrite-capable scene path.
    if (entry.kind === 'scene' && sourcePath) {
      try {
        const sourceBytes = await readPrintArtifactBytesFromPath(sourcePath);
        if (sourceBytes && sourceBytes.length > 0) {
          const restoredFile = new File([Uint8Array.from(sourceBytes)], entry.name, {
            type: getDroppedFileMimeType(entry.name),
            lastModified: Date.now(),
          });

          const importedFromSource = await importSceneFilesWithPluginWarning([restoredFile], {
            resultingScenePath: sourcePath,
            sourcePaths: [sourcePath],
          });

          if (importedFromSource) {
            return true;
          }
        }
      } catch (error) {
        console.warn('[RecentFiles] Failed reopening scene from original source path; falling back to cached copy.', error);
      }
    }

    const reopened = await reopenRecentOpenedFile(entryId);
    if (reopened && entry.kind === 'scene') {
      setActiveSceneFilePath(normalizeActiveVoxlScenePath(sourcePath));
      if (entry.name.trim().toLowerCase().endsWith('.voxl')) {
        setLoadedSceneSaveSource({
          name: entry.name,
          path: normalizeActiveVoxlScenePath(sourcePath),
        });
        markSceneSaveBaseline();
      } else {
        setLoadedSceneSaveSource(null);
      }
    }
    return reopened;
  }, [importSceneFilesWithPluginWarning, markSceneSaveBaseline, maybeConfirmPluginImportWarning, recentOpenedFiles, reopenRecentOpenedFile]);
  const [isAutoArranging, setIsAutoArranging] = React.useState(false);
  const [isExporting, setIsExporting] = React.useState(false);
  const [arrangeOverlayElapsedSec, setArrangeOverlayElapsedSec] = React.useState(0);
  const [arrangeOverlayModelCount, setArrangeOverlayModelCount] = React.useState<number | null>(null);
  const [duplicateTotalCopies, setDuplicateTotalCopies] = React.useState(1);
  const [duplicateSpacingMm, setDuplicateSpacingMm] = React.useState(0.5);
  const showArrangeBlockingOverlay = isAutoArranging;
  const showModifierApplyBlockingOverlay = isApplyingHollowing || isApplyingHolePunch || isApplyingBlockersHollowing || pendingHolePunchAutoApplyModelId !== null;
  const [modifierApplyOverlayElapsedSec, setModifierApplyOverlayElapsedSec] = React.useState(0);

  const arrangeOverlayContent = React.useMemo(() => {
    if (activeArrangeOperation === 'high_precision_fill') {
      return {
        title: 'High-Precision Fill Running…',
        detailLines: [
          'Using SAT-based 2.5D nesting to pack duplicates onto the plate.',
          'Please be patient while we compute the densest valid fill.',
        ],
      };
    }

    if (activeArrangeOperation === 'high_precision') {
      return {
        title: 'High-Precision Arrange Running…',
        detailLines: [
          'This is a computationally expensive operation for dense packing.',
          'Please be patient while we process your models.',
        ],
      };
    }

    if (activeArrangeOperation === 'array') {
      return {
        title: 'Applying Array Arrange…',
        detailLines: [
          'Positioning models and validating placement.',
          'Please wait a moment.',
        ],
      };
    }

    return {
      title: 'Arranging Models…',
      detailLines: [
        'Computing placements and resolving collisions.',
        'Please wait.',
      ],
    };
  }, [activeArrangeOperation]);

  const modifierApplyOverlayContent = React.useMemo(() => {
    if (isApplyingHollowing && pendingHolePunchAutoApplyModelId) {
      return {
        title: 'Applying Hollowing and Hole Punches...',
        detailLines: [
          'Updating the hollowed mesh and preserving your hole punches afterward.',
          'Please be patient while we rebuild the model.',
        ],
      };
    }

    if (isApplyingHollowing) {
      return {
        title: 'Applying Hollowing...',
        detailLines: [
          'Rebuilding the model geometry with the latest hollowing settings.',
          'Please wait a moment.',
        ],
      };
    }

    if (isApplyingHolePunch || pendingHolePunchAutoApplyModelId) {
      return {
        title: 'Applying Hole Punches...',
        detailLines: [
          'Cutting hole punches into the current model geometry.',
          'Please wait a moment.',
        ],
      };
    }

    if (isApplyingBlockersHollowing) {
      return {
        title: 'Applying Blockers...',
        detailLines: [
          'Updating the hollowing preview with your blocker changes.',
          'Please wait a moment.',
        ],
      };
    }

    return {
      title: 'Applying Model Changes...',
      detailLines: [
        'Updating model geometry.',
        'Please wait a moment.',
      ],
    };
  }, [isApplyingBlockersHollowing, isApplyingHolePunch, isApplyingHollowing, pendingHolePunchAutoApplyModelId]);

  React.useEffect(() => {
    if (!showArrangeBlockingOverlay) {
      setArrangeOverlayElapsedSec(0);
      return;
    }

    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setArrangeOverlayElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);

    return () => window.clearInterval(id);
  }, [showArrangeBlockingOverlay]);

  React.useEffect(() => {
    if (!showModifierApplyBlockingOverlay) {
      setModifierApplyOverlayElapsedSec(0);
      return;
    }

    const startedAt = Date.now();
    const id = window.setInterval(() => {
      setModifierApplyOverlayElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 250);

    return () => window.clearInterval(id);
  }, [showModifierApplyBlockingOverlay]);

  const arrangeOverlayElapsedLabel = React.useMemo(() => {
    const total = Math.max(0, arrangeOverlayElapsedSec);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, [arrangeOverlayElapsedSec]);
  const modifierApplyOverlayElapsedLabel = React.useMemo(() => {
    const total = Math.max(0, modifierApplyOverlayElapsedSec);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, [modifierApplyOverlayElapsedSec]);
  const [duplicateLayoutMode, setDuplicateLayoutMode] = React.useState<DuplicateLayoutMode>('auto');
  const [duplicatePrecisionMode, setDuplicatePrecisionMode] = React.useState<ArrangePrecisionMode>('standard');
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
  const effectiveDuplicateTotalCopies = React.useMemo(() => {
    if (duplicateLayoutMode === 'array') {
      const countX = Math.max(1, Math.round(duplicateArrayCountX));
      const countY = Math.max(1, Math.round(duplicateArrayCountY));
      const countZ = Math.max(1, Math.round(duplicateArrayCountZ));
      return Math.max(1, Math.min(128, countX * countY * countZ));
    }

    if (duplicatePrecisionMode === 'high_precision') {
      return Math.max(1, duplicatePreviewTransforms.length + (duplicateSourcePreviewTransform ? 1 : 0));
    }

    return Math.max(1, Math.round(duplicateTotalCopies));
  }, [
    duplicateArrayCountX,
    duplicateArrayCountY,
    duplicateArrayCountZ,
    duplicateLayoutMode,
    duplicatePrecisionMode,
    duplicatePreviewTransforms.length,
    duplicateSourcePreviewTransform,
    duplicateTotalCopies,
  ]);
  const isDuplicateSetupBlockingArrange = Boolean(scene.activeModel) && effectiveDuplicateTotalCopies > 1;
  const [supportRenderRefreshNonce, setSupportRenderRefreshNonce] = React.useState(0);
  const [gizmoResetNonce, setGizmoResetNonce] = React.useState(0);
  const [pendingDestructiveTransform, setPendingDestructiveTransform] = React.useState<{
    modelId: string;
    modelName: string;
    supportCount: number;
    operationLabel: string;
  } | null>(null);
  const pendingDestructiveTransformContinueRef = React.useRef<(() => void) | null>(null);
  const dragDepthRef = React.useRef(0);
  const launchSceneFilesHandledRef = React.useRef(false);
  const startupSceneHandoffReadyRef = React.useRef(false);
  const queuedLaunchSceneEntriesRef = React.useRef<LaunchSceneFileEntry[]>([]);
  const coldStartSceneHandoffTimerRef = React.useRef<number | null>(null);
  const launchSceneImportInFlightRef = React.useRef(false);
  const desktopWindowRevealRequestedRef = React.useRef(false);
  // Stable ref so the launch effect can always call the latest version of
  // this callback without listing it as a dep (which causes effect re-runs
  // and cancelled-flag races during scene initialization).
  const importSceneFromLaunchEntriesRef = React.useRef<((entries: LaunchSceneFileEntry[]) => Promise<boolean>) | null>(null);
  const [pendingStartupSceneHandoff, setPendingStartupSceneHandoff] = React.useState(false);

  const suppressTransformPersistenceCycles = React.useCallback((cycles = 1) => {
    const normalized = Math.max(0, Math.trunc(cycles));
    if (normalized > 0) {
      suppressTransformPersistenceCycleCountRef.current = Math.max(
        suppressTransformPersistenceCycleCountRef.current,
        normalized,
      );
    }
    suppressNextTransformPersistenceRef.current = true;
  }, []);
  const lastPrepareDropRef = React.useRef<{ signature: string; atMs: number }>({
    signature: '',
    atMs: 0,
  });
  const modelStatsCardContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [modelStatsBottomClearancePx, setModelStatsBottomClearancePx] = React.useState(220);
  const arrangeHullFootprintCacheRef = React.useRef<Map<string, HullCacheEntry>>(new Map());
  const trackSupportCollectionsInHome = scene.mode !== 'support';
  
  // Stable snapshot functions for useSyncExternalStore
  const getEmptySupportSnapshot = React.useCallback(() => EMPTY_HOME_SUPPORT_COLLECTIONS_SNAPSHOT, []);
  const getEmptyKickstandSnapshot = React.useCallback(() => EMPTY_HOME_KICKSTAND_COLLECTIONS_SNAPSHOT, []);
  
  const supportStateSnapshot = React.useSyncExternalStore(
    subscribeSupportState,
    trackSupportCollectionsInHome ? getHomeSupportCollectionsSnapshot : getEmptySupportSnapshot,
    trackSupportCollectionsInHome ? getHomeSupportCollectionsSnapshot : getEmptySupportSnapshot,
  );
  const kickstandStateSnapshot = React.useSyncExternalStore(
    subscribeToKickstandStore,
    trackSupportCollectionsInHome ? getHomeKickstandCollectionsSnapshot : getEmptyKickstandSnapshot,
    trackSupportCollectionsInHome ? getHomeKickstandCollectionsSnapshot : getEmptyKickstandSnapshot,
  );
  const raftSettingsSnapshot = React.useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
  const bracePlacementSnapshot = React.useSyncExternalStore(
    bracePlacementStore.subscribe,
    bracePlacementStore.getSnapshot,
    bracePlacementStore.getSnapshot,
  );

  React.useEffect(() => {
    supportDragTransactionIdRef.current = supportDragTransactionId;
  }, [supportDragTransactionId]);

  const clearSupportSyncFallbackTimeout = React.useCallback(() => {
    if (typeof window === 'undefined') return;
    if (supportSyncFallbackTimeoutRef.current !== null) {
      window.clearTimeout(supportSyncFallbackTimeoutRef.current);
      supportSyncFallbackTimeoutRef.current = null;
    }
  }, []);

  const finalizeSupportDragSyncTransaction = React.useCallback((transactionId?: number) => {
    if (
      transactionId !== undefined
      && pendingSupportDragSyncRef.current
      && pendingSupportDragSyncRef.current.transactionId !== transactionId
    ) {
      return;
    }

    pendingSupportDragSyncRef.current = null;
    clearSupportSyncFallbackTimeout();
    setHoldSupportDragDeltaUntilSupportSync(false);
  }, [clearSupportSyncFallbackTimeout]);

  const beginSupportDragSyncTransaction = React.useCallback((
    expectedModelTransforms: Array<{ modelId: string; transform: ModelTransform }>,
    commitResult: TransformStoreCommitResult,
  ) => {
    const nextTransactionId = supportDragTransactionIdRef.current + 1;
    supportDragTransactionIdRef.current = nextTransactionId;
    setSupportDragTransactionId(nextTransactionId);

    const expectedModelTransformKeys = new Map<string, string>();
    expectedModelTransforms.forEach(({ modelId, transform }) => {
      expectedModelTransformKeys.set(modelId, createModelTransformKey(modelId, transform));
    });

    const expectedSupportStoreVersion = supportStoreVersionRef.current + (commitResult.supportsChanged ? 1 : 0);
    const expectedKickstandStoreVersion = kickstandStoreVersionRef.current + (commitResult.kickstandsChanged ? 1 : 0);
    const needsHold = (
      expectedModelTransformKeys.size > 0
      || expectedSupportStoreVersion > supportStoreVersionRef.current
      || expectedKickstandStoreVersion > kickstandStoreVersionRef.current
    );

    if (!needsHold) {
      finalizeSupportDragSyncTransaction();
      return;
    }

    pendingSupportDragSyncRef.current = {
      transactionId: nextTransactionId,
      expectedModelTransformKeys,
      expectedSupportStoreVersion,
      expectedKickstandStoreVersion,
    };
    setHoldSupportDragDeltaUntilSupportSync(true);

    if (typeof window !== 'undefined') {
      clearSupportSyncFallbackTimeout();
      const requiresSupportSync = commitResult.supportsChanged || commitResult.kickstandsChanged;
      const fallbackMs = requiresSupportSync
        ? Math.max(SUPPORT_DRAG_HOLD_FALLBACK_MS, 520)
        : SUPPORT_DRAG_HOLD_FALLBACK_MS;
      supportSyncFallbackTimeoutRef.current = window.setTimeout(() => {
        finalizeSupportDragSyncTransaction(nextTransactionId);
      }, fallbackMs);
    }
  }, [clearSupportSyncFallbackTimeout, finalizeSupportDragSyncTransaction]);

  React.useEffect(() => {
    return () => {
      clearSupportSyncFallbackTimeout();
    };
  }, [clearSupportSyncFallbackTimeout]);

  React.useEffect(() => {
    transformDebugTimelineRef.current.supportStoreUpdatedAt = {
      perfMs: performance.now(),
      epochMs: Date.now(),
    };
    supportStoreVersionRef.current += 1;
  }, [supportStateSnapshot]);

  React.useEffect(() => {
    transformDebugTimelineRef.current.kickstandStoreUpdatedAt = {
      perfMs: performance.now(),
      epochMs: Date.now(),
    };
    kickstandStoreVersionRef.current += 1;
  }, [kickstandStateSnapshot]);

  React.useEffect(() => {
    if (!holdSupportDragDeltaUntilSupportSync) return;

    const pendingTransaction = pendingSupportDragSyncRef.current;
    if (!pendingTransaction) {
      finalizeSupportDragSyncTransaction();
      return;
    }

    if (supportDragTransactionId < pendingTransaction.transactionId) return;

    const modelsById = new Map(scene.models.map((model) => [model.id, model]));
    const modelTransformsSynced = Array.from(pendingTransaction.expectedModelTransformKeys.entries()).every(
      ([modelId, expectedTransformKey]) => {
        const model = modelsById.get(modelId);
        if (!model) return false;
        return createModelTransformKey(modelId, model.transform) === expectedTransformKey;
      },
    );
    if (!modelTransformsSynced) return;

    if (supportStoreVersionRef.current < pendingTransaction.expectedSupportStoreVersion) return;
    if (kickstandStoreVersionRef.current < pendingTransaction.expectedKickstandStoreVersion) return;

    finalizeSupportDragSyncTransaction(pendingTransaction.transactionId);
  }, [
    finalizeSupportDragSyncTransaction,
    holdSupportDragDeltaUntilSupportSync,
    kickstandStateSnapshot,
    scene.models,
    supportDragTransactionId,
    supportStateSnapshot,
  ]);

  React.useEffect(() => {
    const activeModel = scene.models.find((m) => m.id === scene.activeModelId);
    if (!activeModel) {
      activeModelStoreTransformKeyRef.current = null;
      return;
    }

    const t = activeModel.transform;
    const key = createModelTransformKey(activeModel.id, t);

    if (activeModelStoreTransformKeyRef.current === key) return;
    activeModelStoreTransformKeyRef.current = key;
    transformDebugTimelineRef.current.activeModelStoreObservedAt = {
      perfMs: performance.now(),
      epochMs: Date.now(),
    };
  }, [scene.activeModelId, scene.models]);

  React.useEffect(() => {
    if (!isTransformDebugOverlayOpen) return;

    const intervalId = window.setInterval(() => {
      setTransformDebugTick((prev) => prev + 1);
    }, 120);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isTransformDebugOverlayOpen]);

  React.useEffect(() => {
    const handleShaftHover = (evt: Event) => {
      const detail = (evt as CustomEvent<{ segmentId?: string | null; point?: { x: number; y: number; z: number } | null }>).detail;
      const nextSegmentId = detail?.segmentId ?? null;
      const nextPoint = detail?.point ?? null;

      setSupportShaftHoverDebug((prev) => {
        if (
          prev.segmentId === nextSegmentId &&
          prev.point?.x === nextPoint?.x &&
          prev.point?.y === nextPoint?.y &&
          prev.point?.z === nextPoint?.z
        ) {
          return prev;
        }

        return {
          segmentId: nextSegmentId,
          point: nextPoint,
        };
      });
    };

    const handleShaftLeave = (evt: Event) => {
      const detail = (evt as CustomEvent<{ segmentId?: string | null }>).detail;
      setSupportShaftHoverDebug((prev) => {
        if (!detail?.segmentId || prev.segmentId === detail.segmentId) {
          if (prev.segmentId === null && prev.point === null) {
            return prev;
          }
          return { segmentId: null, point: null };
        }
        return prev;
      });
    };

    window.addEventListener('shaft-hover', handleShaftHover as EventListener);
    window.addEventListener('shaft-leave', handleShaftLeave as EventListener);
    return () => {
      window.removeEventListener('shaft-hover', handleShaftHover as EventListener);
      window.removeEventListener('shaft-leave', handleShaftLeave as EventListener);
    };
  }, []);

  const activeSupportEntityCounts = React.useMemo(() => {
    const modelId = scene.activeModelId;
    if (!modelId) {
      return {
        trunks: 0,
        branches: 0,
        leaves: 0,
        twigs: 0,
        sticks: 0,
        braces: 0,
        roots: 0,
        knots: 0,
        kickstands: 0,
      };
    }

    const trunks = Object.values(supportStateSnapshot.trunks).filter((item) => item.modelId === modelId).length;
    const branches = Object.values(supportStateSnapshot.branches).filter((item) => item.modelId === modelId).length;
    const leaves = Object.values(supportStateSnapshot.leaves).filter((item) => item.modelId === modelId).length;
    const twigs = Object.values(supportStateSnapshot.twigs).filter((item) => item.modelId === modelId).length;
    const sticks = Object.values(supportStateSnapshot.sticks).filter((item) => item.modelId === modelId).length;
    const braces = Object.values(supportStateSnapshot.braces).filter((item) => item.modelId === modelId).length;
    const roots = Object.values(supportStateSnapshot.roots).filter((item) => item.modelId === modelId).length;
    const knots = Object.values(supportStateSnapshot.knots).filter((item) => {
      const parent = item.parentShaftId;
      const trunk = supportStateSnapshot.trunks[parent];
      if (trunk) return trunk.modelId === modelId;
      const branch = supportStateSnapshot.branches[parent];
      if (branch) return branch.modelId === modelId;
      const twig = supportStateSnapshot.twigs[parent];
      if (twig) return twig.modelId === modelId;
      const stick = supportStateSnapshot.sticks[parent];
      if (stick) return stick.modelId === modelId;
      if (parent.startsWith('braceSegment:')) {
        const braceId = parent.slice('braceSegment:'.length);
        return supportStateSnapshot.braces[braceId]?.modelId === modelId;
      }
      return false;
    }).length;
    const kickstands = Object.values(kickstandStateSnapshot.kickstands).filter((item) => item.modelId === modelId).length;

    return { trunks, branches, leaves, twigs, sticks, braces, roots, knots, kickstands };
  }, [kickstandStateSnapshot.kickstands, scene.activeModelId, supportStateSnapshot.braces, supportStateSnapshot.branches, supportStateSnapshot.knots, supportStateSnapshot.leaves, supportStateSnapshot.roots, supportStateSnapshot.sticks, supportStateSnapshot.trunks, supportStateSnapshot.twigs]);

  const transformDebugStats = React.useMemo(() => {
    const activeModel = scene.models.find((m) => m.id === scene.activeModelId) ?? null;
    const storeTransform = activeModel?.transform ?? null;
    const liveTransform = transformMgr.transform;

    const posDelta = storeTransform
      ? liveTransform.position.distanceTo(storeTransform.position)
      : 0;
    const rotDelta = storeTransform
      ? Math.max(
        Math.abs(liveTransform.rotation.x - storeTransform.rotation.x),
        Math.abs(liveTransform.rotation.y - storeTransform.rotation.y),
        Math.abs(liveTransform.rotation.z - storeTransform.rotation.z),
      )
      : 0;
    const scaleDelta = storeTransform
      ? liveTransform.scale.distanceTo(storeTransform.scale)
      : 0;

    const dragGroup = supportDragGroupRef.current;
    let dragGroupPos: THREE.Vector3 | null = null;
    let dragGroupScale: THREE.Vector3 | null = null;
    if (dragGroup) {
      const pos = new THREE.Vector3();
      const quat = new THREE.Quaternion();
      const scale = new THREE.Vector3();
      dragGroup.matrix.decompose(pos, quat, scale);
      dragGroupPos = pos;
      dragGroupScale = scale;
    }

    const timeline = transformDebugTimelineRef.current;
    const pendingHistory = pendingTransformHistoryRef.current;
    const historyDebug = transformHistoryDebugRef.current;

    return {
      activeModel,
      storeTransform,
      liveTransform,
      posDelta,
      rotDelta,
      scaleDelta,
      dragGroupAutoUpdate: dragGroup?.matrixAutoUpdate ?? null,
      dragGroupPos,
      dragGroupScale,
      timeline: {
        lastOperation: timeline.lastOperation,
        dragReleasedAt: timeline.dragReleasedAt,
        liveCalculatedAt: timeline.liveCalculatedAt,
        storeUpdateStartedAt: timeline.storeUpdateStartedAt,
        storeUpdatedAt: timeline.storeUpdatedAt,
        supportStoreUpdatedAt: timeline.supportStoreUpdatedAt,
        kickstandStoreUpdatedAt: timeline.kickstandStoreUpdatedAt,
        activeModelStoreObservedAt: timeline.activeModelStoreObservedAt,
        nowPerfMs: performance.now(),
      },
      historyCommit: {
        pendingModelId: pendingHistory?.modelId ?? null,
        pendingDescription: pendingHistory?.description ?? null,
        pendingHasAfter: Boolean(pendingHistory?.after),
        pendingBeforeRotation: pendingHistory
          ? {
              x: pendingHistory.before.rotation.x,
              y: pendingHistory.before.rotation.y,
              z: pendingHistory.before.rotation.z,
            }
          : null,
        pendingAfterRotation: pendingHistory?.after
          ? {
              x: pendingHistory.after.rotation.x,
              y: pendingHistory.after.rotation.y,
              z: pendingHistory.after.rotation.z,
            }
          : null,
        commitRequested: transformHistoryCommitRequestedRef.current,
        commitNonce: transformHistoryCommitNonceRef.current,
        pendingResync: pendingHistoryTransformResyncRef.current,
        suppressNextPersistence: suppressNextTransformPersistenceRef.current,
        skipToken: skipNextTransformEndCommitRef.current,
        pendingRotateGizmoModelId: pendingRotateGizmoCommitRef.current?.modelId ?? null,
        lastResult: historyDebug.lastResult,
        lastReason: historyDebug.lastReason,
        lastModelId: historyDebug.lastModelId,
        lastDescription: historyDebug.lastDescription,
        lastExpectedNonce: historyDebug.lastExpectedNonce,
        lastScheduledNonce: historyDebug.lastScheduledNonce,
        lastUndoCountBefore: historyDebug.lastUndoCountBefore,
        lastUndoCountAfter: historyDebug.lastUndoCountAfter,
        lastPushApplied: historyDebug.lastPushApplied,
        lastAt: historyDebug.lastAt,
      },
      supportCounts: {
        trunks: countRecordEntries(supportStateSnapshot.trunks),
        branches: countRecordEntries(supportStateSnapshot.branches),
        leaves: countRecordEntries(supportStateSnapshot.leaves),
        twigs: countRecordEntries(supportStateSnapshot.twigs),
        sticks: countRecordEntries(supportStateSnapshot.sticks),
        braces: countRecordEntries(supportStateSnapshot.braces),
        roots: countRecordEntries(supportStateSnapshot.roots),
        knots: countRecordEntries(supportStateSnapshot.knots),
        kickstands: countRecordEntries(kickstandStateSnapshot.kickstands),
      },
    };
  }, [kickstandStateSnapshot.kickstands, scene.activeModelId, scene.models, supportDragGroupRef, supportStateSnapshot.braces, supportStateSnapshot.branches, supportStateSnapshot.knots, supportStateSnapshot.leaves, supportStateSnapshot.roots, supportStateSnapshot.sticks, supportStateSnapshot.trunks, supportStateSnapshot.twigs, transformDebugTick, transformMgr.transform]);

  const supportDebugStats = React.useMemo(() => {
    const snapTarget = bracePlacementSnapshot.snapTarget;
    const preview = bracePlacementSnapshot.preview;
    const hoveredSegmentId = supportShaftHoverDebug.segmentId;
    const snappedSegmentId = snapTarget?.kind === 'shaft' ? (snapTarget.segmentId ?? null) : null;
    const hoveredVsSnapMismatch = Boolean(
      hoveredSegmentId
      && snappedSegmentId
      && hoveredSegmentId !== snappedSegmentId,
    );

    const supportRendererDebug = (typeof window !== 'undefined')
      ? ((window as any).__supportRendererDebug as {
        supportInteractionSuppressed?: boolean;
        disableSelectionAndHover?: boolean;
        gizmoInteractionLockActive?: boolean;
        knotGizmoDragging?: boolean;
        jointGizmoDragging?: boolean;
        knotGizmoGuardUntil?: number;
        knotOnlyGuardUntil?: number;
        jointOnlyGuardUntil?: number;
        immediateModelHoverId?: string | null;
        externalHoverModelId?: string | null;
        effectiveHoverModelId?: string | null;
        sceneHoveredSupportId?: string | null;
        marqueeHoveredSupportId?: string | null;
        rawHoveredCategory?: string | null;
        rawHoveredId?: string | null;
        hoveredCategoryForVisual?: string | null;
        hoveredIdForVisual?: string | null;
      } | undefined)
      : undefined;

    const nowEpoch = Date.now();
    const knotGuardUntil = supportRendererDebug?.knotGizmoGuardUntil ?? 0;
    const knotGuardRemainingMs = Math.max(0, knotGuardUntil - nowEpoch);
    const knotOnlyGuardRemainingMs = Math.max(0, (supportRendererDebug?.knotOnlyGuardUntil ?? 0) - nowEpoch);
    const jointOnlyGuardRemainingMs = Math.max(0, (supportRendererDebug?.jointOnlyGuardUntil ?? 0) - nowEpoch);

    return {
      hoveredCategory: supportRendererDebug?.rawHoveredCategory ?? null,
      hoveredId: supportRendererDebug?.rawHoveredId ?? null,
      shaftHoveredSegmentId: hoveredSegmentId,
      shaftHoverPoint: supportShaftHoverDebug.point,
      braceAltActive: bracePlacementSnapshot.altActive,
      braceStage: bracePlacementSnapshot.stage,
      braceStartKind: bracePlacementSnapshot.start?.kind ?? null,
      braceStartSegmentId: bracePlacementSnapshot.start?.kind === 'shaft'
        ? (bracePlacementSnapshot.start.segmentId ?? null)
        : null,
      braceSnapKind: snapTarget?.kind ?? null,
      braceSnapSegmentId: snappedSegmentId,
      braceSnapLeafId: snapTarget?.kind === 'leaf' ? (snapTarget.leafId ?? null) : null,
      previewStart: preview?.start ?? null,
      previewEnd: preview?.end ?? null,
      hoveredVsSnapMismatch,

      supportInteractionSuppressed: !!supportRendererDebug?.supportInteractionSuppressed,
      disableSelectionAndHover: !!supportRendererDebug?.disableSelectionAndHover,
      gizmoInteractionLockActive: !!supportRendererDebug?.gizmoInteractionLockActive,
      knotGizmoDragging: !!supportRendererDebug?.knotGizmoDragging,
      jointGizmoDragging: !!supportRendererDebug?.jointGizmoDragging,
      knotGuardRemainingMs,
      knotOnlyGuardRemainingMs,
      jointOnlyGuardRemainingMs,
      immediateModelHoverId: supportRendererDebug?.immediateModelHoverId ?? null,
      externalHoverModelId: supportRendererDebug?.externalHoverModelId ?? null,
      effectiveHoverModelId: supportRendererDebug?.effectiveHoverModelId ?? null,
      sceneHoveredSupportId: supportRendererDebug?.sceneHoveredSupportId ?? null,
      marqueeHoveredSupportId: supportRendererDebug?.marqueeHoveredSupportId ?? null,
      rawHoveredCategory: supportRendererDebug?.rawHoveredCategory ?? null,
      rawHoveredId: supportRendererDebug?.rawHoveredId ?? null,
      hoveredCategoryForVisual: supportRendererDebug?.hoveredCategoryForVisual ?? null,
      hoveredIdForVisual: supportRendererDebug?.hoveredIdForVisual ?? null,
    };
  }, [bracePlacementSnapshot, supportShaftHoverDebug.point, supportShaftHoverDebug.segmentId, transformDebugTick]);

  const getSupportPrimitiveCountForModel = React.useCallback((modelId: string | null | undefined) => {
    if (!modelId) return 0;

    const supportIds = getSupportsForModel(supportStateSnapshot, modelId);
    const kickstandCount = Object.values(kickstandStateSnapshot.kickstands)
      .filter((kickstand) => kickstand.modelId === modelId)
      .length;

    return supportIds.roots.length
      + supportIds.trunks.length
      + supportIds.branches.length
      + supportIds.braces.length
      + supportIds.leaves.length
      + supportIds.twigs.length
      + supportIds.sticks.length
      + kickstandCount;
  }, [kickstandStateSnapshot.kickstands, supportStateSnapshot]);

  const requestDestructiveTransformSupportDeletion = React.useCallback((operationLabel: string) => {
    if (scene.mode !== 'prepare') return true;
    if (!scene.activeModelId) return true;
    if (pendingDestructiveTransform) return false;

    const supportCount = getSupportPrimitiveCountForModel(scene.activeModelId);
    if (supportCount <= 0) return true;

    setPendingDestructiveTransform({
      modelId: scene.activeModelId,
      modelName: (scene.activeModel?.name ?? scene.activeModelId).trim(),
      supportCount,
      operationLabel,
    });
    return false;
  }, [getSupportPrimitiveCountForModel, pendingDestructiveTransform, scene]);

  const requestDestructiveTransformSupportDeletionWithContinuation = React.useCallback((
    operationLabel: string,
    onContinue: () => void,
  ) => {
    const proceedImmediately = requestDestructiveTransformSupportDeletion(operationLabel);
    if (proceedImmediately) {
      pendingDestructiveTransformContinueRef.current = null;
      return true;
    }

    pendingDestructiveTransformContinueRef.current = onContinue;
    return false;
  }, [requestDestructiveTransformSupportDeletion]);

  const handleConfirmDestructiveTransform = React.useCallback(() => {
    const pending = pendingDestructiveTransform;
    if (!pending) return;

    scene.deleteSupportsForModels(
      [pending.modelId],
      `Delete Supports Before ${pending.operationLabel} ${pending.modelName}`,
    );

    setSupportRenderRefreshNonce((value) => value + 1);
    setGizmoResetNonce((value) => value + 1);
    setPendingDestructiveTransform(null);
    const continueAfterDeletion = pendingDestructiveTransformContinueRef.current;
    pendingDestructiveTransformContinueRef.current = null;
    continueAfterDeletion?.();
  }, [pendingDestructiveTransform, scene]);

  const handleCancelDestructiveTransform = React.useCallback(() => {
    pendingDestructiveTransformContinueRef.current = null;
    setPendingDestructiveTransform(null);
  }, []);

  React.useEffect(() => {
    if (arrangePrecisionMode !== 'high_precision') return;
    if (arrangeAllowRotateOnZ) return;
    setArrangeAllowRotateOnZ(true);
  }, [arrangePrecisionMode, arrangeAllowRotateOnZ]);

  React.useLayoutEffect(() => {
    const element = modelStatsCardContainerRef.current;
    if (!element) {
      setModelStatsBottomClearancePx(220);
      return;
    }

    const updateClearance = () => {
      const rect = element.getBoundingClientRect();
      const bottomMarginPx = 12; // bottom-3 (aligned with floating panel margin)
      const safetyGapPx = 14;
      const measured = Math.ceil(rect.height + bottomMarginPx + safetyGapPx);
      setModelStatsBottomClearancePx(Math.max(220, measured));
    };

    updateClearance();
    const observer = new ResizeObserver(() => {
      updateClearance();
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [scene.models.length]);
  const rightClickGestureRef = React.useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressEditorContextMenuUntilRef = React.useRef(0);
  const cameraResumeTimeoutRef = React.useRef<number | null>(null);
  const { getHotkey } = useHotkeyConfig();
  const supportSpotlightHoldHotkey = getHotkey('SUPPORTS', 'TEMP_SPOTLIGHT_HOLD');

  const supportMenuSnapshot = React.useSyncExternalStore(
    subscribeSupportState,
    getSupportSnapshot,
    getSupportSnapshot,
  );

  const supportMenuSelection = React.useMemo(() => {
    const selectedId = supportMenuSnapshot.selectedId;
    return {
      selectedId,
      selectedCategory: supportMenuSnapshot.selectedCategory,
      isBraceSelected: Boolean(selectedId && supportMenuSnapshot.braces[selectedId]),
    };
  }, [supportMenuSnapshot]);

  const supportsCanToggleCurve = React.useMemo(() => {
    if (scene.mode !== 'support') return false;
    if (supportMenuSelection.selectedCategory === 'segment' && supportMenuSelection.selectedId) return true;
    return supportMenuSelection.isBraceSelected;
  }, [scene.mode, supportMenuSelection.isBraceSelected, supportMenuSelection.selectedCategory, supportMenuSelection.selectedId]);

  const supportContextMenuSegmentOwner = React.useMemo(() => {
    const segmentId = editorContextMenuSupportTarget?.segmentId;
    if (!segmentId) return null;

    const trunk = Object.values(supportMenuSnapshot.trunks).find((item) => item.segments.some((segment) => segment.id === segmentId));
    if (trunk) return { kind: 'trunk' as const, id: trunk.id };

    const branch = Object.values(supportMenuSnapshot.branches).find((item) => item.segments.some((segment) => segment.id === segmentId));
    if (branch) return { kind: 'branch' as const, id: branch.id };

    const twig = Object.values(supportMenuSnapshot.twigs).find((item) => item.segments.some((segment) => segment.id === segmentId));
    if (twig) return { kind: 'twig' as const, id: twig.id };

    const stick = Object.values(supportMenuSnapshot.sticks).find((item) => item.segments.some((segment) => segment.id === segmentId));
    if (stick) return { kind: 'stick' as const, id: stick.id };

    return null;
  }, [editorContextMenuSupportTarget?.segmentId, supportMenuSnapshot.branches, supportMenuSnapshot.sticks, supportMenuSnapshot.trunks, supportMenuSnapshot.twigs]);

  const supportsCanAddJoint = React.useMemo(() => {
    if (scene.mode !== 'support') return false;
    if (!editorContextMenuSupportTarget?.segmentId || !editorContextMenuSupportTarget.point) return false;
    return supportContextMenuSegmentOwner !== null;
  }, [editorContextMenuSupportTarget, scene.mode, supportContextMenuSegmentOwner]);

  const supportContextMenuItems = React.useMemo(() => {
    return [
      {
        id: 'supports-toggle-curve' as const,
        label: msg`Toggle Curve`,
        icon: RefreshCw,
      },
      {
        id: 'supports-add-joint' as const,
        label: msg`Add Joint`,
        icon: Plus,
      },
    ];
  }, []);

  const editorContextMenuTitle = scene.mode === 'support' ? _(msg`Supports`) : _(msg`Editor`);
  const editorContextMenuItems = scene.mode === 'support' ? supportContextMenuItems : undefined;
  const editorContextMenuDisabledActions = React.useMemo(() => {
    if (scene.mode === 'support') {
      return [
        ...(!supportsCanToggleCurve ? (['supports-toggle-curve'] as const) : []),
        ...(!supportsCanAddJoint ? (['supports-add-joint'] as const) : []),
      ];
    }

    const activeModel = scene.activeModelId
      ? scene.models.find((m) => m.id === scene.activeModelId)
      : undefined;
    const canSplitSupports = !!activeModel?.geometry.meshDefects?.nativeRepairReport?.model_triangle_count;

    return [
      ...(!scene.activeModelId ? (['delete', 'cut', 'copy', 'repair'] as const) : []),
      ...(!scene.canPasteModel ? (['paste'] as const) : []),
      ...(!canSplitSupports ? (['split-supports'] as const) : []),
    ];
  }, [scene.activeModelId, scene.canPasteModel, scene.mode, scene.models, supportsCanAddJoint, supportsCanToggleCurve]);

  const clearPrintingLayerPreviewUrls = React.useCallback(() => {
    printingLayerPreviewLoadInFlightRef.current.clear();
    setPrintingLayerPreviewUrls((previous) => {
      for (const url of previous) {
        if (url) URL.revokeObjectURL(url);
      }
      return [];
    });
  }, []);

  React.useEffect(() => {
    return () => {
      clearPrintingLayerPreviewUrls();
    };
  }, [clearPrintingLayerPreviewUrls]);

  React.useEffect(() => {
    printingPreviewZoomRef.current = printingPreviewZoom;
  }, [printingPreviewZoom]);

  React.useEffect(() => {
    printingPreviewPanRef.current = printingPreviewPan;
  }, [printingPreviewPan]);

  React.useEffect(() => {
    printingSelectedLayerRef.current = printingSelectedLayer;
  }, [printingSelectedLayer]);

  React.useEffect(() => {
    printingPreviewSettledRef.current = isPrintingPreviewSettled;
  }, [isPrintingPreviewSettled]);

  React.useEffect(() => {
    return () => {
      if (printingSelectedLayerRafRef.current !== null) {
        window.cancelAnimationFrame(printingSelectedLayerRafRef.current);
      }
      if (printingPreviewPanRafRef.current !== null) {
        window.cancelAnimationFrame(printingPreviewPanRafRef.current);
      }
      if (printingPreviewSettleTimeoutRef.current !== null) {
        window.clearTimeout(printingPreviewSettleTimeoutRef.current);
      }
    };
  }, []);

  const schedulePrintingPreviewSettle = React.useCallback(() => {
    if (printingPreviewSettledRef.current) {
      printingPreviewSettledRef.current = false;
      setIsPrintingPreviewSettled(false);
    }
    if (printingPreviewSettleTimeoutRef.current !== null) {
      window.clearTimeout(printingPreviewSettleTimeoutRef.current);
    }
    printingPreviewSettleTimeoutRef.current = window.setTimeout(() => {
      printingPreviewSettleTimeoutRef.current = null;
      printingPreviewSettledRef.current = true;
      setIsPrintingPreviewSettled(true);
    }, 180);
  }, []);

  const queuePrintingPreviewPan = React.useCallback((nextPan: { x: number; y: number }) => {
    printingPreviewPanPendingRef.current = nextPan;
    if (printingPreviewPanRafRef.current !== null) return;

    printingPreviewPanRafRef.current = window.requestAnimationFrame(() => {
      printingPreviewPanRafRef.current = null;
      const pending = printingPreviewPanPendingRef.current;
      setPrintingPreviewPan((previous) => {
        if (Math.abs(previous.x - pending.x) < 0.05 && Math.abs(previous.y - pending.y) < 0.05) {
          return previous;
        }
        return pending;
      });
    });
  }, []);

  const clampPrintingPreviewPan = React.useCallback((
    nextPan: { x: number; y: number },
    zoom: number,
    viewportWidthPx: number,
    viewportHeightPx: number,
  ) => {
    if (!Number.isFinite(zoom) || zoom <= 1.0001) {
      return { x: 0, y: 0 };
    }

    const safeWidth = Math.max(1, viewportWidthPx);
    const safeHeight = Math.max(1, viewportHeightPx);
    const maxPanX = Math.max(0, ((zoom - 1) * safeWidth) * 0.5);
    const maxPanY = Math.max(0, ((zoom - 1) * safeHeight) * 0.5);

    return {
      x: Math.max(-maxPanX, Math.min(maxPanX, nextPan.x)),
      y: Math.max(-maxPanY, Math.min(maxPanY, nextPan.y)),
    };
  }, []);

  React.useEffect(() => {
    if (printingPreviewZoom <= 1.0001) {
      queuePrintingPreviewPan({ x: 0, y: 0 });
    }
  }, [printingPreviewZoom, queuePrintingPreviewPan]);

  const clampPrintingLayer = React.useCallback((nextLayer: number) => {
    const rounded = Math.round(nextLayer);
    return Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), rounded));
  }, [printingPreviewTotalLayers]);

  const handlePrintingLayerPreviewGenerated = React.useCallback((payload: {
    layerIndex: number;
    totalLayers: number;
    pngBytes: Uint8Array;
  }) => {
    const previewBytes = new Uint8Array(payload.pngBytes.length);
    previewBytes.set(payload.pngBytes);
    const blob = new Blob([previewBytes.buffer], { type: 'image/png' });
    const nextUrl = URL.createObjectURL(blob);

    setPrintingLayerPreviewUrls((previous) => {
      const next = previous.slice();
      const requiredLength = Math.max(payload.totalLayers, payload.layerIndex + 1);
      if (next.length < requiredLength) {
        next.length = requiredLength;
      }
      const prevUrl = next[payload.layerIndex];
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      next[payload.layerIndex] = nextUrl;
      return next;
    });

    setPrintingPreviewTotalLayers(payload.totalLayers);
    setPrintingSelectedLayer((previous) => {
      const nextSelected = !Number.isFinite(previous) || previous <= 0
        ? Math.max(1, Math.min(payload.totalLayers, payload.layerIndex + 1))
        : Math.max(1, Math.min(payload.totalLayers, previous));

      printingSelectedLayerRef.current = nextSelected;
      setPrintingDisplayedLayer((current) => (current === nextSelected ? current : nextSelected));
      return nextSelected;
    });
  }, []);

  const handleSlicingFinishedForPrinting = React.useCallback((payload: { totalLayers: number }) => {
    const totalLayers = Math.max(1, payload.totalLayers);
    setPrintingPreviewTotalLayers(totalLayers);
    setPrintingSelectedLayer(1);
    setPrintingDisplayedLayer(1);
    printingSelectedLayerRef.current = 1;
  }, []);

  const handleSliceRunStartedForPrinting = React.useCallback(() => {
    setShouldAutoSliceOnExportEntry(false);
    clearPrintingLayerPreviewUrls();
    setPrintingPreviewTotalLayers(0);
    setPrintingSelectedLayer(1);
    setPrintingDisplayedLayer(1);
    printingSelectedLayerRef.current = 1;
    setPrintingArtifact(null);
    setPrintingArtifactIsInvalid(false);
    slicedArtifactProfileFingerprintRef.current = null;
    setPrintingReadyPlateId(null);
  }, [clearPrintingLayerPreviewUrls]);

  const selectedPrintingLayerPreviewUrl = React.useMemo(() => {
    if (printingDisplayedLayer < 1) return null;
    return printingLayerPreviewUrls[printingDisplayedLayer - 1] ?? null;
  }, [printingLayerPreviewUrls, printingDisplayedLayer]);

  const isPrintingPngLoaded = React.useMemo(() => {
    if (!selectedPrintingLayerPreviewUrl) return false;
    return printingPngLoadedUrl === selectedPrintingLayerPreviewUrl;
  }, [printingPngLoadedUrl, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    if (scene.mode !== 'printing') return;
    if (!printingArtifact?.nativeTempPath) return;
    if (printingPreviewTotalLayers <= 0) return;

    const layerNumber = Math.max(1, Math.min(printingPreviewTotalLayers, printingDisplayedLayer));
    const layerIndex = layerNumber - 1;
    if (printingLayerPreviewUrls[layerIndex]) return;

    const inFlight = printingLayerPreviewLoadInFlightRef.current;
    if (inFlight.has(layerNumber)) return;
    inFlight.add(layerNumber);

    let cancelled = false;
    void readPrintLayerPreviewPngFromPath(printingArtifact.nativeTempPath, layerNumber, printingArtifact.outputFormat)
      .then((pngBytes: Uint8Array) => {
        if (cancelled) return;
        const previewBytes = new Uint8Array(pngBytes.length);
        previewBytes.set(pngBytes);
        const blob = new Blob([previewBytes.buffer], { type: 'image/png' });
        const nextUrl = URL.createObjectURL(blob);
        setPrintingLayerPreviewUrls((previous) => {
          const next = previous.slice();
          if (next.length < printingPreviewTotalLayers) {
            next.length = printingPreviewTotalLayers;
          }
          const prevUrl = next[layerIndex];
          if (prevUrl) URL.revokeObjectURL(prevUrl);
          next[layerIndex] = nextUrl;
          return next;
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.warn(`[Printing] Failed loading layer ${layerNumber} preview PNG from archive.`, error);
        }
      })
      .finally(() => {
        inFlight.delete(layerNumber);
      });

    return () => {
      cancelled = true;
    };
  }, [
    scene.mode,
    printingArtifact?.nativeTempPath,
    printingDisplayedLayer,
    printingLayerPreviewUrls,
    printingPreviewTotalLayers,
  ]);

  // Show GPU preview during scrubbing or while waiting for PNG to load
  // (GPU preview is fast enough to render real-time during scrub)
  const shouldShowScrubPreview = React.useMemo(() => {
    return (
      isPrintingLayerScrubbing
      || !isPrintingPreviewSettled
      || !selectedPrintingLayerPreviewUrl
      || !isPrintingPngLoaded
    );
  }, [
    isPrintingLayerScrubbing,
    isPrintingPreviewSettled,
    selectedPrintingLayerPreviewUrl,
    isPrintingPngLoaded,
  ]);

  const printingPreviewPngUrlForDisplay = React.useMemo(() => {
    return selectedPrintingLayerPreviewUrl ?? printingPngLoadedUrl;
  }, [printingPngLoadedUrl, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    if (!selectedPrintingLayerPreviewUrl) {
      setPrintingPngLoadedUrl(null);
      return;
    }

    const loadNonce = ++printingPreviewLoadNonceRef.current;
    let cancelled = false;
    const targetUrl = selectedPrintingLayerPreviewUrl;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled) return;
      if (loadNonce !== printingPreviewLoadNonceRef.current) return;
      setPrintingPngLoadedUrl(targetUrl);
    };
    image.onerror = () => {
      // Fail-open so we do not get stuck in scrub preview if decode/load fails once.
      if (cancelled) return;
      if (loadNonce !== printingPreviewLoadNonceRef.current) return;
      setPrintingPngLoadedUrl(targetUrl);
    };
    image.src = targetUrl;

    return () => {
      cancelled = true;
    };
  }, [selectedPrintingLayerPreviewUrl]);

  const handlePrintingPreviewWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (printingPreviewTotalLayers <= 0) return;
    event.preventDefault();

    const previousZoom = printingPreviewZoomRef.current;
    if (previousZoom <= 1.0001 && event.deltaY > 0) {
      return;
    }

    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = Math.max(1, Math.min(32, previousZoom * factor));

    if (Math.abs(nextZoom - previousZoom) < 1e-5) return;

    schedulePrintingPreviewSettle();

    const viewportRect = printingPreviewViewportRef.current?.getBoundingClientRect();
    if (!viewportRect) {
      setPrintingPreviewZoom(nextZoom);
      if (nextZoom <= 1.0001) queuePrintingPreviewPan({ x: 0, y: 0 });
      return;
    }

    const pointerX = event.clientX - (viewportRect.left + viewportRect.width * 0.5);
    const pointerY = event.clientY - (viewportRect.top + viewportRect.height * 0.5);
    const previousPan = printingPreviewPanRef.current;
    const contentX = (pointerX - previousPan.x) / Math.max(1e-4, previousZoom);
    const contentY = (pointerY - previousPan.y) / Math.max(1e-4, previousZoom);
    const nextPan = nextZoom <= 1.0001
      ? { x: 0, y: 0 }
      : {
          x: pointerX - (contentX * nextZoom),
          y: pointerY - (contentY * nextZoom),
        };

    const clampedPan = clampPrintingPreviewPan(
      nextPan,
      nextZoom,
      viewportRect.width,
      viewportRect.height,
    );

    setPrintingPreviewZoom(nextZoom);
    queuePrintingPreviewPan(clampedPan);
  }, [clampPrintingPreviewPan, queuePrintingPreviewPan, schedulePrintingPreviewSettle, printingPreviewTotalLayers]);

  const handlePrintingPreviewPointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (printingPreviewTotalLayers <= 0) return;
    if (printingPreviewZoomRef.current <= 1.0001) return;
    if (event.button !== 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const currentPan = printingPreviewPanRef.current;
    printingPreviewDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: currentPan.x,
      originY: currentPan.y,
    };
    setIsPrintingPreviewPanning(true);
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle, printingPreviewTotalLayers]);

  const handlePrintingPreviewPointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = printingPreviewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();

    const nextPan = {
      x: drag.originX + (event.clientX - drag.startClientX),
      y: drag.originY + (event.clientY - drag.startClientY),
    };
    const viewportRect = printingPreviewViewportRef.current?.getBoundingClientRect();
    const clampedPan = viewportRect
      ? clampPrintingPreviewPan(nextPan, printingPreviewZoomRef.current, viewportRect.width, viewportRect.height)
      : nextPan;

    queuePrintingPreviewPan(clampedPan);
    schedulePrintingPreviewSettle();
  }, [clampPrintingPreviewPan, queuePrintingPreviewPan, schedulePrintingPreviewSettle]);

  const handlePrintingPreviewPointerEnd = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = printingPreviewDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    printingPreviewDragRef.current = null;
    setIsPrintingPreviewPanning(false);
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle]);

  const printingPreviewTargetResolution = React.useMemo(() => {
    let printerWidth = Math.max(1, Math.round(activePrinterProfile?.display?.resolutionX ?? 0));
    const printerHeight = Math.max(1, Math.round(activePrinterProfile?.display?.resolutionY ?? 0));
    const pixelSizeX = Math.max(0.0001, Number(activePrinterProfile?.pixelSize?.x ?? 1));
    const pixelSizeY = Math.max(0.0001, Number(activePrinterProfile?.pixelSize?.y ?? 1));
    const hasPrintableArtifact = (printingArtifact?.outputName ?? '').trim().length > 0;

    if (!hasPrintableArtifact || printerWidth <= 0 || printerHeight <= 0) {
      return null;
    }

    return {
      widthPx: printerWidth,
      heightPx: printerHeight,
      viewportWidth: printerWidth * pixelSizeX,
      viewportHeight: printerHeight * pixelSizeY,
    };
  }, [
    activePrinterProfile?.display?.resolutionX,
    activePrinterProfile?.display?.resolutionY,
    activePrinterProfile?.pixelSize?.x,
    activePrinterProfile?.pixelSize?.y,
    printingArtifact?.outputName,
  ]);

  const printingPreviewDeMirrorTransform = React.useMemo(() => {
    const mirrorX = activePrinterProfile?.display?.mirrorX === true;
    const mirrorY = activePrinterProfile?.display?.mirrorY === true;
    const scaleX = mirrorX ? -1 : 1;
    const scaleY = mirrorY ? -1 : 1;
    if (scaleX === 1 && scaleY === 1) return undefined;
    return `scale(${scaleX}, ${scaleY})`;
  }, [activePrinterProfile?.display?.mirrorX, activePrinterProfile?.display?.mirrorY]);

  const printingPreviewMirrorScale = React.useMemo(() => ({
    x: activePrinterProfile?.display?.mirrorX === true ? -1 : 1,
    y: activePrinterProfile?.display?.mirrorY === true ? -1 : 1,
  }), [activePrinterProfile?.display?.mirrorX, activePrinterProfile?.display?.mirrorY]);

  const isPrintingPreviewLowResActive = React.useMemo(() => {
    // Only use low-res PNG upscale path when scrubbing with PNG preview.
    // When the fake cross-section preview is active, this would double-scale it.
    return isPrintingLayerScrubbing && !shouldShowScrubPreview && printingPreviewZoom <= 1.0001;
  }, [isPrintingLayerScrubbing, printingPreviewZoom, shouldShowScrubPreview]);

  const printingPreviewScrubQualityScale = React.useMemo(() => {
    if (!isPrintingPreviewLowResActive) return 1;
    return 0.5;
  }, [isPrintingPreviewLowResActive]);

  const printingPreviewScrubUpscaleTransform = React.useMemo(() => {
    if (printingPreviewScrubQualityScale >= 0.9999) return undefined;
    const upscale = 1 / printingPreviewScrubQualityScale;
    return `scale(${upscale})`;
  }, [printingPreviewScrubQualityScale]);

  const printingPreviewVisualTransform = React.useMemo(() => {
    const transformParts: string[] = [];
    if (Math.abs(printingPreviewPan.x) > 0.01 || Math.abs(printingPreviewPan.y) > 0.01) {
      transformParts.push(`translate(${printingPreviewPan.x}px, ${printingPreviewPan.y}px)`);
    }
    if (Math.abs(printingPreviewZoom - 1) > 1e-4) {
      transformParts.push(`scale(${printingPreviewZoom})`);
    }
    if (printingPreviewDeMirrorTransform) {
      transformParts.push(printingPreviewDeMirrorTransform);
    }
    if (printingPreviewScrubUpscaleTransform) {
      transformParts.push(printingPreviewScrubUpscaleTransform);
    }
    return transformParts.length > 0 ? transformParts.join(' ') : undefined;
  }, [
    printingPreviewDeMirrorTransform,
    printingPreviewPan.x,
    printingPreviewPan.y,
    printingPreviewScrubUpscaleTransform,
    printingPreviewZoom,
  ]);

  const printingPreviewCursor = React.useMemo<React.CSSProperties['cursor']>(() => {
    if (!selectedPrintingLayerPreviewUrl) return 'default';
    if (printingPreviewZoom > 1.0001) {
      return isPrintingPreviewPanning ? 'grabbing' : 'grab';
    }
    return 'zoom-in';
  }, [isPrintingPreviewPanning, printingPreviewZoom, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    if (scene.mode !== 'printing') {
      setIsPrintingLayerScrubbing(false);
      setIsPrintingSettledCanvasReady(false);
      printingPreviewSettledRef.current = false;
      setIsPrintingPreviewSettled(false);
      setPrintingPreviewZoom(1);
      queuePrintingPreviewPan({ x: 0, y: 0 });
      setIsPrintingPreviewPanning(false);
      printingPreviewDragRef.current = null;
      setPrintingDisplayedLayer(1);
      if (printingPreviewSettleTimeoutRef.current !== null) {
        window.clearTimeout(printingPreviewSettleTimeoutRef.current);
        printingPreviewSettleTimeoutRef.current = null;
      }
    }
  }, [queuePrintingPreviewPan, scene.mode]);

  React.useEffect(() => {
    if (scene.mode !== 'printing') return;
    // Reset transform state on entering printing so scrub/PNG views stay in sync.
    setIsPrintingSettledCanvasReady(false);
    printingPreviewSettledRef.current = false;
    setIsPrintingPreviewSettled(false);
    setPrintingPreviewZoom(1);
    queuePrintingPreviewPan({ x: 0, y: 0 });
    setIsPrintingPreviewPanning(false);
    printingPreviewDragRef.current = null;
    if (printingPreviewSettleTimeoutRef.current !== null) {
      window.clearTimeout(printingPreviewSettleTimeoutRef.current);
      printingPreviewSettleTimeoutRef.current = null;
    }
  }, [queuePrintingPreviewPan, scene.mode]);

  React.useEffect(() => {
    if (scene.mode === 'printing') return;
    setIsSceneLayerScrubbing(false);
  }, [scene.mode]);

  React.useEffect(() => {
    if (scene.mode !== 'printing') return;
    if (!selectedPrintingLayerPreviewUrl) {
      printingPreviewSettledRef.current = false;
      setIsPrintingPreviewSettled(false);
      setIsPrintingSettledCanvasReady(false);
      return;
    }
    schedulePrintingPreviewSettle();
  }, [scene.mode, schedulePrintingPreviewSettle, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    setIsPrintingSettledCanvasReady(false);
  }, [selectedPrintingLayerPreviewUrl]);

  const hasPrintingWorkspaceData = printingPreviewTotalLayers > 0 && printingArtifact !== null;
  const activeSliceProfileFingerprint = React.useMemo(() => {
    const printerProfileId = String(activePrinterProfile?.id ?? '').trim();
    const materialProfileId = String(activeMaterialProfile?.id ?? '').trim();
    return `${printerProfileId}::${materialProfileId}`;
  }, [activeMaterialProfile?.id, activePrinterProfile?.id]);

  const handleSliceArtifactReady = React.useCallback((artifact: SliceExportArtifact) => {
    setPrintingArtifact(artifact);
    setPrintingArtifactIsInvalid(false);
    setShowPrintingResliceModal(false);
    // Push a "Sliced Scene" marker to history so we can detect changes after this point
    pushHistory({
      type: 'SCENE_SLICED',
      description: 'Scene sliced for printing',
      payload: {},
    });
    setPrintingSendStatusText(null);
    setPrintingSendProgress(0);
    setPrintingSendStageText(null);
    setPrintingUploadTelemetry(null);
    setPrintingReadyPlateId(null);
    setPrintingPrintNowBusy(false);
    if (printingUploadProcessingHandoffTimeoutRef.current !== null) {
      window.clearTimeout(printingUploadProcessingHandoffTimeoutRef.current);
      printingUploadProcessingHandoffTimeoutRef.current = null;
    }
    setPrintingUploadDialogOpen(false);
    setPrintingUploadDialogStage('uploading');
    setPrintingUploadDisplayProgress(0);
    setPrintingDeviceProcessingStartedAtMs(null);
    setPrintingDeviceProcessingElapsedSec(0);
    // Re-slice can swap preview sources; reset transform to avoid stale zoom/pan desync.
    setIsPrintingSettledCanvasReady(false);
    printingPreviewSettledRef.current = false;
    setIsPrintingPreviewSettled(false);
    setPrintingPreviewZoom(1);
    queuePrintingPreviewPan({ x: 0, y: 0 });
    setIsPrintingPreviewPanning(false);
    printingPreviewDragRef.current = null;
    if (printingPreviewSettleTimeoutRef.current !== null) {
      window.clearTimeout(printingPreviewSettleTimeoutRef.current);
      printingPreviewSettleTimeoutRef.current = null;
    }
    // If we re-sliced from printing mode, return there now
    if (shouldReturnToPrintingAfterSliceRef.current) {
      shouldReturnToPrintingAfterSliceRef.current = false;
      setShouldAutoSliceOnExportEntry(false);
      scene.setMode('printing');
      return;
    }

    // Dispatch slice intent action with the fresh artifact
    const intent = sliceIntentRef.current;
    setCompletedSliceIntent(intent);
    setCompletedSaveDestinationPath(null);
    if (intent === 'upload' || intent === 'print') {
      pendingPostSliceActionRef.current = intent;
      setShouldAutoSliceOnExportEntry(false);
      scene.setMode('printing');
    } else if (intent === 'preview') {
      // 'preview': navigate to printing workspace without saving or uploading.
      setShouldAutoSliceOnExportEntry(false);
      scene.setMode('printing');
    } else {
      // 'file' or 'uvtools': write to pre-selected destination, then navigate to printing workspace.
      const destinationPath = preSliceFileDestinationPathRef.current?.trim() || '';
      preSliceFileDestinationPathRef.current = null;

      const nativePathForIntent = artifact.nativeTempPath?.trim() || '';
      const normalizePathForCompare = (value: string) => value.replace(/\\/g, '/').toLowerCase();
      if (
        destinationPath
        && nativePathForIntent
        && normalizePathForCompare(destinationPath) === normalizePathForCompare(nativePathForIntent)
      ) {
        setCompletedSaveDestinationPath(destinationPath);

        // If intent is 'uvtools', show launching modal and fire UVTools
        if (intent === 'uvtools') {
          setUvToolsLaunchingPath(destinationPath);
          const uvToolsSettings = getSavedUvToolsSettings();
          const exePath = resolveUvToolsExecutablePath(uvToolsSettings);
          launchExternalProcess(exePath, destinationPath)
            .then(() => {
              setTimeout(() => setUvToolsLaunchingPath(null), 5000);
            })
            .catch((err) => {
              console.warn('[UVTools] Failed to launch UVTools:', err);
              setTimeout(() => setUvToolsLaunchingPath(null), 5000);
            });
        }

        setShouldAutoSliceOnExportEntry(false);
        scene.setMode('printing');
        return;
      }

      const saveAndNavigate = async (a: SliceExportArtifact) => {
        let savedPath: string | null = null;

        if (destinationPath) {
          try {
            const nativePathForWrite = a.nativeTempPath?.trim() || '';
            const bytes = a.blob
              ? new Uint8Array(await a.blob.arrayBuffer())
              : (nativePathForWrite ? await readPrintArtifactBytesFromPath(nativePathForWrite) : null);
            if (!bytes) throw new Error('No artifact bytes available for write.');
            await writeBytesToNativePath(destinationPath, bytes);
            savedPath = destinationPath;
          } catch (error) {
            console.warn('[Slicing] Failed writing pre-selected save path, falling back to save dialog.', error);
          }
        }

        if (!savedPath) {
          const nativePath = a.nativeTempPath?.trim() || '';
          if (nativePath) {
            try {
              const resolvedPath = await savePrintArtifactPathWithNativeDialog(nativePath, a.outputName);
              savedPath = resolvedPath || a.outputName;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err ?? '');
              if (msg.toLowerCase().includes('cancel')) return;
            }
          }
          if (!savedPath) {
            try {
              const nativePath2 = a.nativeTempPath?.trim() || '';
              const bytes = a.blob
                ? new Uint8Array(await a.blob.arrayBuffer())
                : (nativePath2 ? await readPrintArtifactBytesFromPath(nativePath2) : null);
              if (!bytes) throw new Error('No artifact bytes');
              const resolvedPath = await savePrintArtifactWithNativeDialog(bytes, a.outputName);
              savedPath = resolvedPath || a.outputName;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err ?? '');
              if (msg.toLowerCase().includes('cancel')) return;
            }
          }
          if (!savedPath && a.blob) {
            const url = URL.createObjectURL(a.blob);
            const anchor = document.createElement('a');
            anchor.href = url; anchor.download = a.outputName; anchor.rel = 'noopener'; anchor.style.display = 'none';
            document.body?.appendChild(anchor);
            anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            anchor.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            savedPath = a.outputName;
          }
        }

        if (savedPath) {
          setCompletedSaveDestinationPath(savedPath);

          // If intent is 'uvtools', show launching modal and fire UVTools
          if (intent === 'uvtools') {
            setUvToolsLaunchingPath(savedPath);
            const uvToolsSettings = getSavedUvToolsSettings();
            const exePath = resolveUvToolsExecutablePath(uvToolsSettings);
            launchExternalProcess(exePath, savedPath)
              .then(() => {
                setTimeout(() => setUvToolsLaunchingPath(null), 5000);
              })
              .catch((err) => {
                console.warn('[UVTools] Failed to launch UVTools:', err);
                setTimeout(() => setUvToolsLaunchingPath(null), 5000);
              });
          }
        }
        setShouldAutoSliceOnExportEntry(false);
        scene.setMode('printing');
      };
      void saveAndNavigate(artifact);
    }
  }, [scene]);

  const handleSlicingBenchmarkComplete = React.useCallback((benchmark: SliceExportResult['benchmark']) => {
    setPrintingSlicingBenchmark(benchmark);
  }, []);

  React.useEffect(() => {
    if (completedSliceIntent !== 'file' || !completedSaveDestinationPath) {
      return;
    }

    const slicingTimeMs = printingSlicingBenchmark?.totalElapsedMs ?? null;
    if (slicingTimeMs === null || !Number.isFinite(slicingTimeMs)) {
      return;
    }

    setSliceCompletedModalData({
      filePath: completedSaveDestinationPath,
      slicingTimeMs,
    });
    setShowSliceCompletedModal(true);
  }, [completedSliceIntent, completedSaveDestinationPath, printingSlicingBenchmark?.totalElapsedMs]);

  const printingOutputSizeLabel = React.useMemo(() => {
    if (!printingArtifact) return '—';
    const bytes = Math.max(0, printingArtifact.byteSize);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }, [printingArtifact]);

  const yieldResinEstimateToMainThread = React.useCallback(async () => {
    await new Promise<void>((resolve) => {
      if (typeof window !== 'undefined' && typeof (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback === 'function') {
        (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback?.(() => resolve(), { timeout: 16 });
        return;
      }
      setTimeout(resolve, 0);
    });
  }, []);

  const computeBaseResinMlChunked = React.useCallback(async (
    position: { getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number; count: number },
    index: { getX: (i: number) => number; count: number } | null,
  ): Promise<number | null> => {
    let signedVolume = 0;

    const vax = { x: 0, y: 0, z: 0 };
    const vbx = { x: 0, y: 0, z: 0 };
    const vcx = { x: 0, y: 0, z: 0 };

    const readVertex = (i: number, out: { x: number; y: number; z: number }) => {
      out.x = position.getX(i);
      out.y = position.getY(i);
      out.z = position.getZ(i);
    };

    const addTriangle = (ia: number, ib: number, ic: number) => {
      readVertex(ia, vax);
      readVertex(ib, vbx);
      readVertex(ic, vcx);

      signedVolume += (
        vax.x * (vbx.y * vcx.z - vbx.z * vcx.y)
        - vax.y * (vbx.x * vcx.z - vbx.z * vcx.x)
        + vax.z * (vbx.x * vcx.y - vbx.y * vcx.x)
      ) / 6;
    };

    const yieldEveryTriangles = 4096;
    let processedTriangles = 0;

    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        addTriangle(index.getX(i), index.getX(i + 1), index.getX(i + 2));
        processedTriangles += 1;
        if (processedTriangles % yieldEveryTriangles === 0) {
          await yieldResinEstimateToMainThread();
        }
      }
    } else {
      for (let i = 0; i < position.count; i += 3) {
        addTriangle(i, i + 1, i + 2);
        processedTriangles += 1;
        if (processedTriangles % yieldEveryTriangles === 0) {
          await yieldResinEstimateToMainThread();
        }
      }
    }

    const baseVolumeMm3 = Math.abs(signedVolume);
    return Number.isFinite(baseVolumeMm3) ? (baseVolumeMm3 / 1000) : null;
  }, [yieldResinEstimateToMainThread]);

  const getOrComputeBaseResinMl = React.useCallback(async (model: (typeof scene.models)[number]): Promise<number | null> => {
    const geometry = model.geometry.geometry;
    const positionAttr = geometry.getAttribute('position');
    if (!positionAttr) return null;

    const sourceKey = String(geometry.userData?.resinVolumeSourceKey ?? geometry.uuid);
    geometry.userData = {
      ...geometry.userData,
      resinVolumeSourceKey: sourceKey,
    };

    const position = positionAttr as {
      getX: (i: number) => number;
      getY: (i: number) => number;
      getZ: (i: number) => number;
      count: number;
      version?: number;
      data?: { version?: number };
    };
    const index = geometry.getIndex() as ({ getX: (i: number) => number; count: number; version?: number } | null);

    const positionVersion = position.version ?? position.data?.version ?? 0;
    const indexVersion = index?.version ?? 0;
    const cacheKey = `${sourceKey}:${positionVersion}:${indexVersion}`;

    const cached = printingBaseResinMlCacheRef.current.get(cacheKey);
    if (cached !== undefined) return cached;

    const inFlight = printingInFlightBaseResinMlRef.current.get(cacheKey);
    if (inFlight) return inFlight;

    const promise = computeBaseResinMlChunked(position, index)
      .then((result) => {
        printingBaseResinMlCacheRef.current.set(cacheKey, result);
        printingInFlightBaseResinMlRef.current.delete(cacheKey);
        return result;
      })
      .catch(() => {
        printingInFlightBaseResinMlRef.current.delete(cacheKey);
        return null;
      });

    printingInFlightBaseResinMlRef.current.set(cacheKey, promise);
    return promise;
  }, [computeBaseResinMlChunked]);

  // Support/raft aggregation is comparatively heavy, so keep it scoped to
  // pre-artifact printing only. Base model volume estimation runs in the
  // background across active editing modes (for warm, up-to-date estimates).
  const shouldCalculateSupportAndRaftVolumes = scene.mode === 'printing' && !printingArtifact;
  const resinBuildVolumeBounds = React.useMemo(() => {
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

  const resinInBoundsModelIdSet = React.useMemo(() => {
    const visibleModels = scene.models.filter((model) => model.visible);
    if (visibleModels.length === 0) return new Set<string>();
    if (!resinBuildVolumeBounds) return new Set(visibleModels.map((model) => model.id));

    const BUILD_VOLUME_BOUNDS_EPS_MM = 0.01;
    const inBoundsModelIds = new Set<string>();

    for (const model of visibleModels) {
      // Use stored transform — bounds don't change on selection.
      // Previously depended on scene.activeModelId, causing recomputation
      // (including computePreciseModelWorldBounds, O(vertices)) on every click.
      const approxBounds = computeApproxModelWorldBounds(model.geometry, model.transform);
      const bounds = isBoundsOutsideVolume(approxBounds, resinBuildVolumeBounds, BUILD_VOLUME_BOUNDS_EPS_MM)
        ? computePreciseModelWorldBounds(model.geometry, model.transform)
        : approxBounds;

      if (!isBoundsOutsideVolume(bounds, resinBuildVolumeBounds, BUILD_VOLUME_BOUNDS_EPS_MM)) {
        inBoundsModelIds.add(model.id);
      }
    }

    return inBoundsModelIds;
  }, [
    resinBuildVolumeBounds,
    scene.models,
  ]);

  const visibleResinModels = React.useMemo(() => {
    return scene.models.filter((model) => model.visible && resinInBoundsModelIdSet.has(model.id));
  }, [resinInBoundsModelIdSet, scene.models]);
  const shouldEstimateResinInBackground = visibleResinModels.length > 0
    && (scene.mode !== 'printing' || !printingArtifact);

  const resinEstimateComputationSignature = React.useMemo(() => {
    if (visibleResinModels.length === 0) return '';
    // Stable signature — only changes when geometry or scale actually changes,
    // NOT when selection changes. Prevents the resin estimate useEffect from
    // firing extra state updates on every model click.
    const parts = visibleResinModels.map((model) => {
      const geometry = model.geometry.geometry;
      const positionAttr = geometry.getAttribute('position') as ({ version?: number; data?: { version?: number } } | null);
      const indexAttr = geometry.getIndex() as ({ version?: number } | null);

      const sourceKey = String(geometry.userData?.resinVolumeSourceKey ?? geometry.uuid);
      const positionVersion = positionAttr?.version ?? positionAttr?.data?.version ?? 0;
      const indexVersion = indexAttr?.version ?? 0;

      const sx = Math.abs(model.transform.scale.x || 1).toFixed(6);
      const sy = Math.abs(model.transform.scale.y || 1).toFixed(6);
      const sz = Math.abs(model.transform.scale.z || 1).toFixed(6);

      return `${model.id}:${sourceKey}:${positionVersion}:${indexVersion}:${sx}:${sy}:${sz}`;
    });

    parts.sort((a, b) => a.localeCompare(b));
    return parts.join('|');
  }, [visibleResinModels]);

  const supportAndRaftResinMl = React.useMemo(() => {
    if (!shouldCalculateSupportAndRaftVolumes) return 0;

    // Expensive calculation ONLY runs in pre-artifact printing mode.
    const visibleModelIds = resinInBoundsModelIdSet;
    if (visibleModelIds.size === 0) return 0;

    const mm3ToMl = (mm3: number) => Math.max(0, mm3) / 1000;
    const circleArea = (radiusMm: number) => Math.PI * radiusMm * radiusMm;
    const sphereVolumeMm3 = (radiusMm: number) => (4 / 3) * Math.PI * radiusMm * radiusMm * radiusMm;
    const cylinderVolumeMm3 = (radiusMm: number, heightMm: number) => circleArea(radiusMm) * Math.max(0, heightMm);
    const frustumVolumeMm3 = (r1: number, r2: number, heightMm: number) => {
      const h = Math.max(0, heightMm);
      return (Math.PI * h / 3) * ((r1 * r1) + (r1 * r2) + (r2 * r2));
    };
    const distanceMm = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
    };
    const sampleBezierLengthMm = (
      p0: { x: number; y: number; z: number },
      p1: { x: number; y: number; z: number },
      p2: { x: number; y: number; z: number },
      p3: { x: number; y: number; z: number },
      samples: number,
    ) => {
      let length = 0;
      let prev = p0;
      const steps = Math.max(4, samples);
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const next = getBezierPointAtT(p0, p1, p2, p3, t);
        length += distanceMm(prev, next);
        prev = next;
      }
      return length;
    };

    const contactConeVolumeMl = (cone: {
      profile: {
        contactDiameterMm: number;
        bodyDiameterMm: number;
        lengthMm: number;
        type?: 'disk' | 'sphere';
      };
      normal: { x: number; y: number; z: number };
      surfaceNormal?: { x: number; y: number; z: number };
      diskLengthOverride?: number;
    }) => {
      const contactRadius = Math.max(0.001, cone.profile.contactDiameterMm / 2);
      const bodyRadius = Math.max(0.001, cone.profile.bodyDiameterMm / 2);
      const coneLen = Math.max(0, cone.profile.lengthMm);
      const coneMm3 = frustumVolumeMm3(contactRadius, bodyRadius, coneLen);

      let diskMm3 = 0;
      if (cone.profile.type === 'disk') {
        const surfaceNormal = cone.surfaceNormal ?? cone.normal;
        const diskProfile = {
          type: 'disk' as const,
          diskThicknessMm: Math.max(0.01, Number((cone.profile as { diskThicknessMm?: number }).diskThicknessMm ?? 0.1)),
          maxStandoffMm: Math.max(0.01, Number((cone.profile as { maxStandoffMm?: number }).maxStandoffMm ?? 0.35)),
          standoffAngleThreshold: Number((cone.profile as { standoffAngleThreshold?: number }).standoffAngleThreshold ?? (Math.PI / 4)),
        };
        const diskThickness = cone.diskLengthOverride ?? calculateDiskThickness(surfaceNormal, cone.normal, diskProfile);
        diskMm3 = cylinderVolumeMm3(contactRadius, Math.max(0, diskThickness));
      }

      return mm3ToMl(coneMm3 + diskMm3);
    };

    const contactDiskVolumeMl = (disk: {
      contactDiameterMm: number;
      profile: {
        type?: 'disk';
        standoffAngleThreshold?: number;
        diskThicknessMm?: number;
        maxStandoffMm?: number;
      };
      surfaceNormal: { x: number; y: number; z: number };
      coneAxis: { x: number; y: number; z: number };
      diskLengthOverride?: number;
    }) => {
      const radius = Math.max(0.001, disk.contactDiameterMm / 2);
      const diskProfile = {
        type: 'disk' as const,
        diskThicknessMm: Math.max(0.01, Number(disk.profile.diskThicknessMm ?? 0.1)),
        maxStandoffMm: Math.max(0.01, Number(disk.profile.maxStandoffMm ?? 0.35)),
        standoffAngleThreshold: Number(disk.profile.standoffAngleThreshold ?? (Math.PI / 4)),
      };
      const thickness = disk.diskLengthOverride ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, diskProfile);
      return mm3ToMl(cylinderVolumeMm3(radius, Math.max(0, thickness)));
    };

    const segmentVolumeMl = (
      segment: {
        diameter: number;
        type?: 'straight' | 'bezier';
        controlPoint1?: { x: number; y: number; z: number };
        controlPoint2?: { x: number; y: number; z: number };
        resolution?: number;
      },
      start: { x: number; y: number; z: number },
      end: { x: number; y: number; z: number },
    ) => {
      const radius = Math.max(0.001, segment.diameter / 2);
      const length = segment.type === 'bezier' && segment.controlPoint1 && segment.controlPoint2
        ? sampleBezierLengthMm(start, segment.controlPoint1, segment.controlPoint2, end, segment.resolution ?? 16)
        : distanceMm(start, end);
      return mm3ToMl(cylinderVolumeMm3(radius, length));
    };

    const polygonAreaMm2 = (profile: THREE.Vector2[]) => {
      if (profile.length < 3) return 0;
      let sum = 0;
      for (let i = 0; i < profile.length; i += 1) {
        const a = profile[i];
        const b = profile[(i + 1) % profile.length];
        sum += (a.x * b.y) - (b.x * a.y);
      }
      return Math.abs(sum) * 0.5;
    };
    const polygonPerimeterMm = (profile: THREE.Vector2[]) => {
      if (profile.length < 2) return 0;
      let sum = 0;
      for (let i = 0; i < profile.length; i += 1) {
        const a = profile[i];
        const b = profile[(i + 1) % profile.length];
        sum += a.distanceTo(b);
      }
      return sum;
    };

    const topDiameterByRootId = new Map<string, number>();
    for (const trunk of Object.values(supportStateSnapshot.trunks)) {
      const firstDiameter = trunk.baseDiameterMm ?? trunk.segments[0]?.diameter;
      if (firstDiameter && firstDiameter > 0) {
        topDiameterByRootId.set(trunk.rootId, firstDiameter);
      }
    }
    for (const kickstand of Object.values(kickstandStateSnapshot.kickstands)) {
      const firstDiameter = kickstand.profile.terminalStartDiameterMm
        || kickstand.segments[0]?.diameter
        || kickstand.profile.bodyDiameterMm;
      if (firstDiameter && firstDiameter > 0) {
        topDiameterByRootId.set(kickstand.rootId, firstDiameter);
      }
    }

    let supportMl = 0;

    const addRootVolume = (root: { id: string; modelId: string; diameter: number; diskHeight: number; coneHeight: number }) => {
      if (!visibleModelIds.has(root.modelId)) return;

      const rootRadius = Math.max(0.001, root.diameter / 2);
      const topDiameter = topDiameterByRootId.get(root.id) ?? Math.max(0.1, root.diameter * 0.35);
      const topRadius = Math.max(0.001, topDiameter / 2);

      const effectiveDiskHeight = raftSettingsSnapshot.bottomMode === 'solid'
        ? 0.05
        : Math.max(0, root.diskHeight);
      const coneHeight = Math.max(0, root.coneHeight);

      const diskMm3 = cylinderVolumeMm3(rootRadius, effectiveDiskHeight);
      const coneMm3 = frustumVolumeMm3(rootRadius, topRadius, coneHeight);
      const capSphereMm3 = coneHeight > 0 ? sphereVolumeMm3(topRadius) : 0;
      supportMl += mm3ToMl(diskMm3 + coneMm3 + capSphereMm3);
    };

    for (const root of Object.values(supportStateSnapshot.roots)) {
      addRootVolume(root);
    }
    for (const root of Object.values(kickstandStateSnapshot.roots)) {
      addRootVolume(root);
    }

    for (const trunk of Object.values(supportStateSnapshot.trunks)) {
      if (!visibleModelIds.has(trunk.modelId)) continue;
      const root = supportStateSnapshot.roots[trunk.rootId];
      for (let i = 0; i < trunk.segments.length; i += 1) {
        const seg = trunk.segments[i];
        const endpoints = getTrunkSegmentEndpoints(trunk, seg, i, root);
        if (!endpoints) continue;
        supportMl += segmentVolumeMl(seg, endpoints.start, endpoints.end);
      }
      if (trunk.contactCone) {
        supportMl += contactConeVolumeMl(trunk.contactCone);
      }
    }

    for (const branch of Object.values(supportStateSnapshot.branches)) {
      if (!visibleModelIds.has(branch.modelId)) continue;
      const parentKnot = supportStateSnapshot.knots[branch.parentKnotId];
      for (let i = 0; i < branch.segments.length; i += 1) {
        const seg = branch.segments[i];
        const endpoints = getBranchSegmentEndpoints(branch, seg, i, parentKnot);
        if (!endpoints) continue;
        supportMl += segmentVolumeMl(seg, endpoints.start, endpoints.end);
      }
      if (branch.contactCone) {
        supportMl += contactConeVolumeMl(branch.contactCone);
      }
    }

    for (const leaf of Object.values(supportStateSnapshot.leaves)) {
      if (!visibleModelIds.has(leaf.modelId)) continue;
      if (leaf.contactCone) {
        supportMl += contactConeVolumeMl(leaf.contactCone);
      }
    }

    for (const twig of Object.values(supportStateSnapshot.twigs)) {
      if (!visibleModelIds.has(twig.modelId)) continue;

      for (let i = 0; i < twig.segments.length; i += 1) {
        const seg = twig.segments[i];
        const start = i === 0
          ? (seg.bottomJoint?.pos ?? twig.contactDiskA.pos)
          : (twig.segments[i - 1].topJoint?.pos ?? seg.bottomJoint?.pos ?? twig.contactDiskA.pos);
        const end = seg.topJoint?.pos ?? twig.contactDiskB.pos;
        supportMl += segmentVolumeMl(seg, start, end);
      }

      supportMl += contactDiskVolumeMl(twig.contactDiskA);
      supportMl += contactDiskVolumeMl(twig.contactDiskB);
    }

    for (const stick of Object.values(supportStateSnapshot.sticks)) {
      if (!visibleModelIds.has(stick.modelId)) continue;

      for (let i = 0; i < stick.segments.length; i += 1) {
        const seg = stick.segments[i];
        const start = i === 0
          ? (seg.bottomJoint?.pos ?? stick.contactConeA.pos)
          : (stick.segments[i - 1].topJoint?.pos ?? seg.bottomJoint?.pos ?? stick.contactConeA.pos);
        const end = seg.topJoint?.pos ?? stick.contactConeB.pos;
        supportMl += segmentVolumeMl(seg, start, end);
      }

      supportMl += contactConeVolumeMl(stick.contactConeA);
      supportMl += contactConeVolumeMl(stick.contactConeB);
    }

    for (const brace of Object.values(supportStateSnapshot.braces)) {
      if (!visibleModelIds.has(brace.modelId)) continue;
      const startKnot = supportStateSnapshot.knots[brace.startKnotId];
      const endKnot = supportStateSnapshot.knots[brace.endKnotId];
      if (!startKnot || !endKnot) continue;

      const length = brace.curve?.type === 'bezier'
        ? sampleBezierLengthMm(startKnot.pos, brace.curve.controlPoint1, brace.curve.controlPoint2, endKnot.pos, brace.curve.resolution ?? 16)
        : distanceMm(startKnot.pos, endKnot.pos);
      supportMl += mm3ToMl(cylinderVolumeMm3(Math.max(0.001, brace.profile.diameter / 2), length));
    }

    for (const kickstand of Object.values(kickstandStateSnapshot.kickstands)) {
      if (!visibleModelIds.has(kickstand.modelId)) continue;

      for (let i = 0; i < kickstand.segments.length; i += 1) {
        const seg = kickstand.segments[i];
        const root = kickstandStateSnapshot.roots[kickstand.rootId];
        const hostKnot = kickstandStateSnapshot.knots[kickstand.hostKnotId];
        const rootTopPos = root
          ? {
              x: root.transform.pos.x,
              y: root.transform.pos.y,
              z: root.transform.pos.z + Math.max(0, root.diskHeight) + Math.max(0, root.coneHeight),
            }
          : null;
        const start = i === 0
          ? (seg.bottomJoint?.pos ?? rootTopPos ?? { x: 0, y: 0, z: 0 })
          : (kickstand.segments[i - 1].topJoint?.pos ?? seg.bottomJoint?.pos ?? rootTopPos ?? { x: 0, y: 0, z: 0 });
        const end = seg.topJoint?.pos ?? hostKnot?.pos ?? start;
        supportMl += segmentVolumeMl(seg, start, end);
      }
    }

    let raftMl = 0;
    if (raftSettingsSnapshot.bottomMode !== 'off') {
      const rootsByModel = new Map<string, SupportBaseCircle[]>();
      for (const root of Object.values(supportStateSnapshot.roots)) {
        if (!visibleModelIds.has(root.modelId)) continue;
        if (!rootsByModel.has(root.modelId)) rootsByModel.set(root.modelId, []);
        rootsByModel.get(root.modelId)!.push({
          x: root.transform.pos.x,
          y: root.transform.pos.y,
          r: root.diameter / 2,
        });
      }

      for (const circles of rootsByModel.values()) {
        if (circles.length === 0) continue;

        const chamferInset = raftSettingsSnapshot.bottomMode === 'line'
          ? Math.max(0, raftSettingsSnapshot.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettingsSnapshot.chamferAngle))))
          : 0;

        const baseProfile = computeFootprint(circles, {
          marginMm: 0.2 + chamferInset,
          samplesPerCircle: 24,
        });

        if (!baseProfile || baseProfile.length < 3) continue;

        const areaMm2 = polygonAreaMm2(baseProfile);
        const baseMm3 = raftSettingsSnapshot.bottomMode === 'line'
          ? (polygonPerimeterMm(baseProfile) * Math.max(0, raftSettingsSnapshot.lineWidthMm) * Math.max(0, raftSettingsSnapshot.lineHeightMm))
          : (areaMm2 * Math.max(0, raftSettingsSnapshot.thickness));

        let wallMm3 = 0;
        if (raftSettingsSnapshot.wallEnabled && raftSettingsSnapshot.wallHeight > 0 && raftSettingsSnapshot.wallThickness > 0) {
          const outerProfile = computeRaftOuterBoundary(baseProfile, raftSettingsSnapshot);
          const wallPerimeterMm = polygonPerimeterMm(outerProfile.length >= 3 ? outerProfile : baseProfile);
          wallMm3 = wallPerimeterMm * Math.max(0, raftSettingsSnapshot.wallThickness) * Math.max(0, raftSettingsSnapshot.wallHeight);
        }

        raftMl += mm3ToMl(baseMm3 + wallMm3);
      }
    }

    return supportMl + raftMl;
  }, [
    resinInBoundsModelIdSet,
    shouldCalculateSupportAndRaftVolumes,
    computeFootprint,
    computeRaftOuterBoundary,
    raftSettingsSnapshot,
    scene.models,
    kickstandStateSnapshot.knots,
    kickstandStateSnapshot.roots,
    kickstandStateSnapshot.kickstands,
    supportStateSnapshot.braces,
    supportStateSnapshot.branches,
    supportStateSnapshot.knots,
    supportStateSnapshot.leaves,
    supportStateSnapshot.roots,
    supportStateSnapshot.sticks,
    supportStateSnapshot.trunks,
    supportStateSnapshot.twigs,
  ]);

  React.useEffect(() => {
    if (!shouldEstimateResinInBackground) return;

    const intervalId = window.setInterval(() => {
      setResinEstimateRefreshTick((previous) => previous + 1);
    }, RESIN_ESTIMATE_BACKGROUND_REFRESH_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [shouldEstimateResinInBackground]);

  React.useEffect(() => {
    let cancelled = false;

    if (!shouldEstimateResinInBackground) {
      if (visibleResinModels.length === 0) {
        lastCompletedResinEstimateSignatureRef.current = '';
        printingEstimatedResinMlRef.current = null;
        setPrintingEstimatedResinMl(null);
      }
      setIsPrintingEstimatedResinBusy(false);
      return () => {
        cancelled = true;
      };
    }

    const visibleModels = visibleResinModels;
    const compositeSignature = `${resinEstimateComputationSignature}::supports:${supportAndRaftResinMl.toFixed(6)}`;
    const hasChangedSinceLastSuccess = compositeSignature !== lastCompletedResinEstimateSignatureRef.current;
    const hadPriorValue = printingEstimatedResinMlRef.current != null;
    if (hadPriorValue && hasChangedSinceLastSuccess) {
      setIsPrintingEstimatedResinBusy(true);
    }

    const run = async () => {
      let totalMl = 0;
      let found = false;

      for (const model of visibleModels) {
        if (cancelled) return;
        const baseMl = await getOrComputeBaseResinMl(model);
        if (cancelled) return;
        if (baseMl == null) continue;

        const sx = Math.abs(model.transform.scale.x || 1);
        const sy = Math.abs(model.transform.scale.y || 1);
        const sz = Math.abs(model.transform.scale.z || 1);
        totalMl += baseMl * sx * sy * sz;
        found = true;
      }

      if (cancelled) return;
      const totalWithSupports = totalMl + supportAndRaftResinMl;
      const nextValue = found || totalWithSupports > 0 ? totalWithSupports : null;
      printingEstimatedResinMlRef.current = nextValue;
      setPrintingEstimatedResinMl(nextValue);
      lastCompletedResinEstimateSignatureRef.current = compositeSignature;
      setIsPrintingEstimatedResinBusy(false);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [
    getOrComputeBaseResinMl,
    resinEstimateComputationSignature,
    resinEstimateRefreshTick,
    shouldEstimateResinInBackground,
    supportAndRaftResinMl,
    visibleResinModels,
  ]);

  const estimatedVolumeMlLabel = React.useMemo(() => {
    const visible = scene.models.filter((model) => model.visible);
    if (visible.length === 0) return '—';
    if (isPrintingEstimatedResinBusy && printingEstimatedResinMl == null) return 'Calculating…';
    if (printingEstimatedResinMl == null) return '—';
    return `${printingEstimatedResinMl.toFixed(2)} mL`;
  }, [isPrintingEstimatedResinBusy, printingEstimatedResinMl, scene.models]);

  const estimatedPrintTimeLabel = React.useMemo(() => {
    if (!activeMaterialProfile || printingPreviewTotalLayers <= 0) return '—';

    const totalLayers = printingPreviewTotalLayers;
    const bottomLayers = Math.max(0, Math.min(totalLayers, Math.round(activeMaterialProfile.bottomLayerCount)));
    const normalLayers = Math.max(0, totalLayers - bottomLayers);

    const liftSec = activeMaterialProfile.liftSpeedMmMin > 0
      ? (activeMaterialProfile.liftDistanceMm / activeMaterialProfile.liftSpeedMmMin) * 60
      : 0;
    const retractSec = activeMaterialProfile.retractSpeedMmMin > 0
      ? (activeMaterialProfile.liftDistanceMm / activeMaterialProfile.retractSpeedMmMin) * 60
      : 0;
    const travelSecPerLayer = Math.max(0, liftSec + retractSec);

    const totalSec = (
      bottomLayers * (activeMaterialProfile.bottomExposureSec + travelSecPerLayer)
      + normalLayers * (activeMaterialProfile.normalExposureSec + travelSecPerLayer)
    );

    const minutes = Math.floor(totalSec / 60);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours > 0) return `~${hours}h ${mins}m`;
    return `~${mins}m`;
  }, [activeMaterialProfile, printingPreviewTotalLayers]);

  const canDownloadPrintArtifact = Boolean(printingArtifact);
  const activeNetworkUiAdapter = React.useMemo(
    () => getProfileNetworkUiAdapter(activePrinterProfile?.networkSupport),
    [activePrinterProfile?.networkSupport],
  );
  const selectedSliceDeviceId = React.useMemo(() => {
    const directId = activePrinterProfile?.activeNetworkDeviceId?.trim();
    if (directId) return directId;

    const connectionIp = activePrinterProfile?.networkConnection?.ipAddress?.trim().toLowerCase() ?? '';
    if (!connectionIp) return null;

    const fleet = activePrinterProfile?.networkFleet ?? [];
    return fleet.find((device) => (device.ipAddress || '').trim().toLowerCase() === connectionIp)?.id ?? null;
  }, [
    activePrinterProfile?.activeNetworkDeviceId,
    activePrinterProfile?.networkConnection?.ipAddress,
    activePrinterProfile?.networkFleet,
  ]);
  const selectedSliceDeviceReachability = selectedSliceDeviceId
    ? (printerReachabilityByDeviceId[selectedSliceDeviceId] ?? null)
    : null;
  const shouldUseRemoteOfflineLayerHeight = Boolean(activeNetworkUiAdapter)
    && activeNetworkUiAdapter?.supportsRemoteMaterialProfiles !== false
    && (
      activePrinterProfile?.networkConnection?.connected !== true
      || selectedSliceDeviceReachability === false
    );
  const [remoteOfflineLayerHeightSnapshotMm, setRemoteOfflineLayerHeightSnapshotMm] = React.useState<number | null>(() => (
    readRemoteOfflineLayerHeightSnapshotMm()
  ));

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateSnapshot = () => {
      const next = readRemoteOfflineLayerHeightSnapshotMm();
      setRemoteOfflineLayerHeightSnapshotMm((previous) => (Object.is(previous, next) ? previous : next));
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key === REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY) updateSnapshot();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT, updateSnapshot);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT, updateSnapshot);
    };
  }, []);

  const remoteOfflineSlicedLayerHeightMm = React.useMemo(() => {
    if (!shouldUseRemoteOfflineLayerHeight) return null;
    return remoteOfflineLayerHeightSnapshotMm;
  }, [remoteOfflineLayerHeightSnapshotMm, shouldUseRemoteOfflineLayerHeight]);
  const remoteSelectedMaterialLayerHeightMm = React.useMemo(() => {
    if (!activeNetworkUiAdapter) return null;
    if (activeNetworkUiAdapter.supportsRemoteMaterialProfiles === false) return null;
    if (activePrinterProfile?.networkConnection?.connected !== true) return null;
    if (selectedSliceDeviceReachability === false) return null;

    const selectedMaterialId = activePrinterProfile.networkConnection?.selectedMaterialId?.trim() ?? '';
    if (!selectedMaterialId) return null;

    const candidate = Number(activePrinterProfile.networkConnection?.selectedMaterialLayerHeightMm);
    if (!Number.isFinite(candidate) || candidate <= 0) return null;
    return Math.max(0.001, candidate);
  }, [
    activeNetworkUiAdapter,
    activePrinterProfile?.networkConnection?.connected,
    activePrinterProfile?.networkConnection?.selectedMaterialId,
    activePrinterProfile?.networkConnection?.selectedMaterialLayerHeightMm,
    selectedSliceDeviceReachability,
  ]);
  const printingMonitoringAdapter = React.useMemo(
    () => getProfileMonitoringUiAdapter(activePrinterProfile?.networkSupport),
    [activePrinterProfile?.networkSupport],
  );
  const slicedLayerHeightMm = React.useMemo(() => {
    if (remoteOfflineSlicedLayerHeightMm != null) {
      return remoteOfflineSlicedLayerHeightMm;
    }
    if (remoteSelectedMaterialLayerHeightMm != null) {
      return remoteSelectedMaterialLayerHeightMm;
    }
    return Math.max(0.001, Number(activeMaterialProfile?.layerHeightMm ?? 0.05));
  }, [activeMaterialProfile?.layerHeightMm, remoteOfflineSlicedLayerHeightMm, remoteSelectedMaterialLayerHeightMm]);
  const crossSectionLayerHeightMm = slicedLayerHeightMm;
  const isLayerHeightMatch = React.useCallback((candidateLayerHeightMm: number | null | undefined) => {
    if (candidateLayerHeightMm == null) return false;
    return Math.abs(candidateLayerHeightMm - slicedLayerHeightMm) <= 0.0005;
  }, [slicedLayerHeightMm]);
  const connectedPrinterFleet = React.useMemo(() => {
    if (!activePrinterProfile || !activeNetworkUiAdapter) return [] as PrinterNetworkDevice[];
    return (activePrinterProfile.networkFleet ?? []).filter((device) => device.connected);
  }, [activeNetworkUiAdapter, activePrinterProfile]);
  const printableConnectedPrinterFleet = React.useMemo(() => {
    return connectedPrinterFleet;
  }, [connectedPrinterFleet]);
  const reachablePrintableConnectedPrinterFleet = React.useMemo(() => {
    return printableConnectedPrinterFleet.filter((device) => printerReachabilityByDeviceId[device.id] !== false);
  }, [printableConnectedPrinterFleet, printerReachabilityByDeviceId]);
  const printingTargetDevice = React.useMemo(() => {
    if (printableConnectedPrinterFleet.length === 0) return null;
    return printableConnectedPrinterFleet.find((device) => device.id === activePrinterProfile?.activeNetworkDeviceId)
      ?? printableConnectedPrinterFleet.find((device) => device.id === printingTargetDeviceId)
      ?? printableConnectedPrinterFleet[0]
      ?? null;
  }, [activePrinterProfile?.activeNetworkDeviceId, printableConnectedPrinterFleet, printingTargetDeviceId]);
  const selectedKnownPrinterDevice = React.useMemo(() => {
    const fleet = activePrinterProfile?.networkFleet ?? [];
    if (fleet.length === 0) return null;
    return fleet.find((device) => device.id === activePrinterProfile?.activeNetworkDeviceId)
      ?? fleet.find((device) => device.connected)
      ?? fleet[0]
      ?? null;
  }, [activePrinterProfile?.activeNetworkDeviceId, activePrinterProfile?.networkFleet]);
  const selectedPrinterProbeTarget = React.useMemo(() => {
    const host = (selectedKnownPrinterDevice?.ipAddress || activePrinterProfile?.network?.ipAddress || '').trim();
    if (!host) return null;
    return {
      host,
      port: selectedKnownPrinterDevice?.port || 80,
    };
  }, [activePrinterProfile?.network?.ipAddress, selectedKnownPrinterDevice?.ipAddress, selectedKnownPrinterDevice?.port]);
  const monitorSelectableDevices = React.useMemo(() => {
    const fleet = activePrinterProfile?.networkFleet ?? [];
    if (fleet.length === 0) return [] as PrinterNetworkDevice[];
    return fleet.filter((device) => (device.ipAddress || '').trim().length > 0);
  }, [activePrinterProfile?.networkFleet]);

  const allReachabilityProbeTargets = React.useMemo(() => {
    const targets = new Map<string, {
      id: string;
      host: string;
      port: number;
      pluginId: string;
      operation: string;
      adapter: ReturnType<typeof getProfileMonitoringUiAdapter>;
    }>();

    for (const printer of profileState.printerProfiles) {
      if (!printer.networkSupport) continue;

      const adapter = getProfileMonitoringUiAdapter(printer.networkSupport);
      if (!adapter.available || !adapter.pluginId || !adapter.operations?.status) continue;

      const fleet = Array.isArray(printer.networkFleet) ? printer.networkFleet : [];
      if (fleet.length > 0) {
        for (const device of fleet) {
          const host = (device.ipAddress || '').trim();
          const id = (device.id || '').trim();
          if (!host || !id) continue;

          targets.set(id, {
            id,
            host,
            port: device.port || 80,
            pluginId: adapter.pluginId,
            operation: adapter.operations.status,
            adapter,
          });
        }
        continue;
      }

      const host = (printer.networkConnection?.ipAddress || printer.network?.ipAddress || '').trim();
      const id = (printer.activeNetworkDeviceId || printer.id || '').trim();
      if (!host || !id) continue;

      targets.set(id, {
        id,
        host,
        port: printer.networkConnection?.port || 80,
        pluginId: adapter.pluginId,
        operation: adapter.operations.status,
        adapter,
      });
    }

    return Array.from(targets.values());
  }, [profileState.printerProfiles]);

  const dashboardMonitorDevices = React.useMemo(() => {
    if (monitorSelectableDevices.length === 0) return [] as PrinterNetworkDevice[];

    return [...monitorSelectableDevices].sort((a, b) => {
      const aOffline = printerReachabilityByDeviceId[a.id] === false || a.connected !== true;
      const bOffline = printerReachabilityByDeviceId[b.id] === false || b.connected !== true;
      if (aOffline === bOffline) return 0;
      return aOffline ? 1 : -1;
    });
  }, [monitorSelectableDevices, printerReachabilityByDeviceId]);

  const dashboardOnlineMonitorDevices = React.useMemo(() => {
    return monitorSelectableDevices.filter((device) => {
      const hasHost = (device.ipAddress || '').trim().length > 0;
      if (!hasHost) return false;
      if (printerReachabilityByDeviceId[device.id] === false) return false;
      return device.connected === true;
    });
  }, [monitorSelectableDevices, printerReachabilityByDeviceId]);
  const monitoringDevice = React.useMemo(() => {
    if (monitorSelectableDevices.length > 0) {
      return monitorSelectableDevices.find((device) => device.id === printingMonitorDeviceId)
        ?? monitorSelectableDevices.find((device) => device.id === activePrinterProfile?.activeNetworkDeviceId)
        ?? monitorSelectableDevices.find((device) => device.id === printingTargetDevice?.id)
        ?? monitorSelectableDevices[0]
        ?? null;
    }
    return null;
  }, [activePrinterProfile?.activeNetworkDeviceId, monitorSelectableDevices, printingMonitorDeviceId, printingTargetDevice?.id]);
  const monitoringDeviceId = monitoringDevice?.id ?? null;
  const monitoringDeviceHost = React.useMemo(() => {
    return (monitoringDevice?.ipAddress || '').trim();
  }, [monitoringDevice?.ipAddress]);
  const monitoringDevicePort = monitoringDevice?.port || 80;
  const monitoringDeviceMainboardId = React.useMemo(() => {
    if (!monitoringDeviceId) return null;
    if (!monitoringDeviceId.includes('-')) return monitoringDeviceId;
    return monitoringDeviceId.split('-').pop() ?? monitoringDeviceId;
  }, [monitoringDeviceId]);
  const printingMonitorRecentPlatesCacheKey = React.useMemo(() => {
    if (!monitoringDeviceHost) return null;
    const pluginId = (printingMonitoringAdapter.pluginId ?? '').trim();
    if (!pluginId) return null;
    return `${pluginId}|${monitoringDeviceId ?? 'unknown'}|${monitoringDeviceHost.toLowerCase()}:${monitoringDevicePort}|${printingMonitorPlatesStoragePath}`;
  }, [
    monitoringDeviceHost,
    monitoringDeviceId,
    monitoringDevicePort,
    printingMonitorPlatesStoragePath,
    printingMonitoringAdapter.pluginId,
  ]);

  React.useEffect(() => {
    if (allReachabilityProbeTargets.length === 0) return;

    let cancelled = false;
    let burstIntervalId: number | null = null;
    let steadyIntervalId: number | null = null;
    let burstTransitionTimeoutId: number | null = null;

    const pollAllReachability = async () => {
      const entries = await Promise.all(
        allReachabilityProbeTargets.map(async (target) => {
          try {
            const response = await pluginNetworkFetch({
              pluginId: target.pluginId,
              operation: target.operation,
              ipAddress: target.host,
              port: target.port,
            });

            const payload = await readJsonObject(response);
            if (!response.ok) return [target.id, false] as const;

            const payloadOk = readBooleanField(payload, 'ok');
            if (payloadOk != null) {
              return [target.id, payloadOk === true] as const;
            }

            try {
              const snapshot = target.adapter.parseStatusPayload(payload, `${target.host}:${target.port}`);
              if (snapshot && typeof snapshot.connected === 'boolean') {
                return [target.id, snapshot.connected] as const;
              }
            } catch {
              // Fall back to transport success.
            }

            return [target.id, true] as const;
          } catch {
            return [target.id, false] as const;
          }
        }),
      );

      if (cancelled) return;

      const nextMap = { ...getPrinterReachabilitySnapshot() };
      for (const [deviceId, reachable] of entries) {
        nextMap[deviceId] = reachable;
      }

      setPrinterReachabilityMap(nextMap);
    };

    void pollAllReachability();

    burstIntervalId = window.setInterval(() => {
      void pollAllReachability();
    }, 2000);

    burstTransitionTimeoutId = window.setTimeout(() => {
      if (cancelled) return;
      if (burstIntervalId != null) {
        window.clearInterval(burstIntervalId);
        burstIntervalId = null;
      }

      steadyIntervalId = window.setInterval(() => {
        void pollAllReachability();
      }, 15_000);
    }, 12_000);

    return () => {
      cancelled = true;
      if (burstIntervalId != null) {
        window.clearInterval(burstIntervalId);
      }
      if (steadyIntervalId != null) {
        window.clearInterval(steadyIntervalId);
      }
      if (burstTransitionTimeoutId != null) {
        window.clearTimeout(burstTransitionTimeoutId);
      }
    };
  }, [allReachabilityProbeTargets]);

  const printingTargetMaterialGroups = React.useMemo(() => {
    const groups = new Map<string, FleetUploadMaterialOption[]>();
    for (const material of printingTargetMaterialOptions) {
      const label = material.layerHeightMm == null
        ? 'Layer height unknown'
        : '';
      const bucket = groups.get(label);
      if (bucket) {
        bucket.push(material);
      } else {
        groups.set(label, [material]);
      }
    }
    return Array.from(groups.entries()).map(([label, materials]) => ({ label, materials }));
  }, [printingTargetMaterialOptions]);
  const sendToPrinterTargetName = printingTargetDevice?.displayName || printingTargetDevice?.hostName || printingTargetDevice?.ipAddress || null;
  const shouldShowOfflineRemoteMaterialName = Boolean(
    activeNetworkUiAdapter
    && activeNetworkUiAdapter.supportsRemoteMaterialProfiles !== false
    && shouldUseRemoteOfflineLayerHeight,
  );
  const printingResinName = React.useMemo(() => {
    if (shouldShowOfflineRemoteMaterialName) {
      return 'N/A';
    }

    const targetName = printingTargetDevice?.selectedMaterialName?.trim();
    if (targetName && targetName.length > 0) return targetName;

    const selectedName = activePrinterProfile?.networkConnection?.selectedMaterialName?.trim();
    if (
      activeNetworkUiAdapter
      && activePrinterProfile?.networkConnection?.connected === true
      && selectedName
      && selectedName.length > 0
    ) {
      return selectedName;
    }

    const compositeLocalMaterialName = resolveCompositeMaterialLabel(activeMaterialProfile);

    return compositeLocalMaterialName ?? activeMaterialProfile?.name ?? 'No resin selected';
  }, [
    activeMaterialProfile,
    activeNetworkUiAdapter,
    activePrinterProfile?.networkConnection?.connected,
    activePrinterProfile?.networkConnection?.selectedMaterialName,
    printingTargetDevice?.selectedMaterialName,
    shouldShowOfflineRemoteMaterialName,
  ]);
  const sendToPrinterButtonLabel = sendToPrinterTargetName
    ? `Upload to ${sendToPrinterTargetName.length > 26 ? `${sendToPrinterTargetName.slice(0, 24)}…` : sendToPrinterTargetName}`
    : 'Send to Printer';
  const canSendToPrinter = Boolean(
    printingArtifact
    && activeNetworkUiAdapter
    && printableConnectedPrinterFleet.length > 0,
  );
  // Whether the slicing panel can offer Slice & Upload / Slice & Print actions
  const canSliceAndUpload = Boolean(
    activeNetworkUiAdapter
    && reachablePrintableConnectedPrinterFleet.length > 0,
  );
  const canSliceAndPrint = canSliceAndUpload && Boolean(printingMonitoringAdapter.operations?.start);
  const requiresRemoteMaterialSelectionForUpload = Boolean(
    activeNetworkUiAdapter
    && activeNetworkUiAdapter.supportsRemoteMaterialProfiles !== false,
  );
  const suggestedSliceOutputFilename = React.useMemo(() => {
    const modelName = (scene.activeModel?.name ?? scene.models[0]?.name ?? '').trim();
    const base = (modelName || activePrinterProfile?.name || 'slice_export')
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, '_');
    const outputFormat = (activePrinterProfile?.display.outputFormat ?? '').trim();
    const ext = outputFormat.length > 0
      ? (outputFormat.startsWith('.') ? outputFormat : `.${outputFormat}`)
      : '.print';
    return `${base || 'slice_export'}${ext}`;
  }, [activePrinterProfile?.display.outputFormat, activePrinterProfile?.name, scene.activeModel?.name, scene.models]);
  const isPreSliceTargetPicker = printingTargetPickerMode !== 'post-slice';
  const canPrintNow = Boolean(
    printingReadyPlateId
    && printingTargetDevice?.connected === true,
  );

  const handlePreSliceSceneSave = React.useCallback(async (): Promise<void> => {
    setIsPreSliceSceneSaveInProgress(true);
    try {
      await flushAutosave();
    } catch (error) {
      console.warn('[Slicing] Failed to flush autosave before slicing; continuing.', error);
    } finally {
      setIsPreSliceSceneSaveInProgress(false);
    }
  }, [flushAutosave]);

  const handleBeforeSliceStart = React.useCallback(async (intent: SliceIntent): Promise<boolean> => {
    if (shouldReturnToPrintingAfterSliceRef.current) {
      return true;
    }

    preSliceFileDestinationPathRef.current = null;
    preSliceUploadSelectionRef.current = null;

    if (intent === 'preview') {
      // Just slice — no preflight needed.
      return true;
    }

    if (intent === 'file' || intent === 'uvtools') {
      try {
        const destinationPath = await pickSavePathWithNativeDialog(suggestedSliceOutputFilename);
        if (!destinationPath || destinationPath.trim().length === 0) {
          return false;
        }
        preSliceFileDestinationPathRef.current = destinationPath.trim();
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message.toLowerCase().includes('cancel')) {
          return false;
        }
        // If native picker isn't available (web runtime), keep current post-slice fallback behavior.
        console.warn('[Slicing] Pre-slice save picker unavailable; falling back to post-slice save flow.', error);
        return true;
      }
    }

    if (!activeNetworkUiAdapter || reachablePrintableConnectedPrinterFleet.length === 0) {
      setPrintingSendStatusText('No online printer is available for upload.');
      return false;
    }

    const shouldOpenTargetPicker = reachablePrintableConnectedPrinterFleet.length > 1 || requiresRemoteMaterialSelectionForUpload;
    if (shouldOpenTargetPicker) {
      setPrintingTargetPickerMode(intent === 'print' ? 'pre-slice-print' : 'pre-slice-upload');
      setPrintingTargetPickerOpen(true);
      const selection = await new Promise<{ deviceId: string; materialId?: string } | null>((resolve) => {
        preSliceTargetPickerResolverRef.current = resolve;
      });
      preSliceTargetPickerResolverRef.current = null;
      if (!selection) {
        preSliceUploadSelectionRef.current = null;
        return false;
      }
      preSliceUploadSelectionRef.current = selection;
    } else {
      const selectedTarget = (
        printingTargetDevice && printerReachabilityByDeviceId[printingTargetDevice.id] !== false
          ? printingTargetDevice
          : reachablePrintableConnectedPrinterFleet[0]
      ) ?? null;
      if (!selectedTarget) {
        setPrintingSendStatusText('No online printer is available for upload.');
        return false;
      }
      preSliceUploadSelectionRef.current = {
        deviceId: selectedTarget.id,
        materialId: requiresRemoteMaterialSelectionForUpload
          ? ((selectedTarget.selectedMaterialId ?? '').trim() || undefined)
          : undefined,
      };
    }

    if (intent === 'print') {
      setPreSlicePrintConfirmOpen(true);
      const confirmed = await new Promise<boolean>((resolve) => {
        preSlicePrintConfirmResolverRef.current = resolve;
      });
      preSlicePrintConfirmResolverRef.current = null;
      if (!confirmed) {
        preSliceUploadSelectionRef.current = null;
        return false;
      }
    }

    return true;
  }, [
    activeNetworkUiAdapter,
    reachablePrintableConnectedPrinterFleet,
    printerReachabilityByDeviceId,
    printingTargetDevice,
    requiresRemoteMaterialSelectionForUpload,
    suggestedSliceOutputFilename,
  ]);

  const printingDialogStageLabel = React.useMemo(() => {
    if (printingSendStageText && printingSendStageText.trim().length > 0) {
      return printingSendStageText;
    }

    switch (printingUploadDialogStage) {
      case 'uploading': return 'Uploading to printer';
      case 'processing': return 'Processing on device';
      case 'ready': return 'Ready to print';
      case 'starting': return 'Starting print';
      case 'started': return 'Print started';
      case 'failed': return 'Upload failed';
      default: return 'Processing';
    }
  }, [printingSendStageText, printingUploadDialogStage]);

  const printingDialogIsIndeterminate = printingUploadDialogStage === 'processing';
  const printingDialogProgressPercent = Math.max(0, Math.min(100, printingUploadDisplayProgress * 100));

  const printingProcessingElapsedLabel = React.useMemo(() => {
    const total = Math.max(0, printingDeviceProcessingElapsedSec);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }, [printingDeviceProcessingElapsedSec]);

  const printingMonitorPlateId = React.useMemo(() => {
    const candidate = printingMonitorSnapshot?.plateId ?? printingReadyPlateId;
    if (candidate == null || !Number.isFinite(candidate) || candidate <= 0) return null;
    return Math.round(candidate);
  }, [printingMonitorSnapshot?.plateId, printingReadyPlateId]);
  const printingMonitorThumbnailUrl = React.useMemo(() => {
    if (!monitoringDevice) return null;
    const host = (monitoringDevice.ipAddress || '').trim();
    if (!host) return null;
    const port = monitoringDevice.port || 80;

    const metadataThumbnail = typeof printingMonitorSnapshot?.thumbnailPath === 'string'
      ? printingMonitorSnapshot.thumbnailPath.trim()
      : '';
    if (metadataThumbnail) {
      const resolved = resolvePrintingMonitorAbsoluteUrl(metadataThumbnail, host, port);
      if (resolved) return resolved;
    }

    if (printingMonitorPlateId == null) return null;
    const base = `http://${host}${port === 80 ? '' : `:${port}`}`;
    return `${base}/static/plates/${printingMonitorPlateId}/3d.png`;
  }, [monitoringDevice, printingMonitorPlateId, printingMonitorSnapshot?.thumbnailPath]);
  const printingMonitorThumbnailCacheKey = React.useMemo(() => {
    if (!monitoringDevice || !printingMonitorThumbnailUrl) return null;
    const host = (monitoringDevice.ipAddress || '').trim();
    if (!host) return null;
    const port = monitoringDevice.port || 80;
    return `${host}:${port}|${printingMonitorThumbnailUrl}`;
  }, [monitoringDevice, printingMonitorThumbnailUrl]);
  const printingMonitorInlineWebcamUrl = React.useMemo(() => {
    const candidates = [
      printingMonitorWebcamInfo?.streamUrl,
      printingMonitorWebcamInfo?.snapshotUrl,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return candidates.find((value) => /^https?:\/\//i.test(value)
      || /^wss?:\/\//i.test(value)
      || /^data:/i.test(value)
      || /^blob:/i.test(value));
  }, [printingMonitorWebcamInfo?.snapshotUrl, printingMonitorWebcamInfo?.streamUrl]);

  const printingMonitorRtspSourceUrl = React.useMemo(() => {
    const candidates = [
      printingMonitorWebcamInfo?.streamUrl,
      printingMonitorWebcamInfo?.snapshotUrl,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return candidates.find((value) => /^rtsps?:\/\//i.test(value)) ?? null;
  }, [printingMonitorWebcamInfo?.snapshotUrl, printingMonitorWebcamInfo?.streamUrl]);

  const printingMonitorIsDesktopRuntime = React.useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.location.protocol === 'tauri:'
      || window.location.protocol === 'file:'
      || window.location.hostname === 'tauri.localhost'
      || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  }, []);

  React.useEffect(() => {
    if (!printingMonitorRtspSourceUrl || !printingMonitorModalOpen) {
      setPrintingMonitorRelayBaseWsUrl(null);
      setPrintingMonitorRelaySetupError(null);
      setPrintingMonitorRelayDebugTransport(null);
      setPrintingMonitorRelayReclaimDebug(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const refreshRelayDebug = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        const relayStatus = await fetchRtspRelayStatus(printingMonitorRtspSourceUrl);
        const response = { ok: relayStatus.ok, status: relayStatus.status };
        const payload = relayStatus.payload ?? null;
        if (cancelled) return;

        const wsBaseUrl = typeof payload?.wsBaseUrl === 'string'
          ? payload.wsBaseUrl.trim()
          : '';
        if (response.ok && /^wss?:\/\//i.test(wsBaseUrl)) {
          setPrintingMonitorRelayBaseWsUrl(wsBaseUrl);
          setPrintingMonitorRelaySetupError(null);
          const debugTransport = payload?.rtspDebugTransport && typeof payload.rtspDebugTransport === 'object'
            ? {
                clientPort: typeof payload.rtspDebugTransport.clientPort === 'number' ? payload.rtspDebugTransport.clientPort : null,
                serverPort: typeof payload.rtspDebugTransport.serverPort === 'number' ? payload.rtspDebugTransport.serverPort : null,
                transportHeader: typeof payload.rtspDebugTransport.transportHeader === 'string'
                  ? payload.rtspDebugTransport.transportHeader
                  : null,
                updatedAtEpochMs: typeof payload.rtspDebugTransport.updatedAtEpochMs === 'number'
                  ? payload.rtspDebugTransport.updatedAtEpochMs
                  : null,
              }
            : null;
          const reclaimDebug = payload?.rtspReclaimDebug && typeof payload.rtspReclaimDebug === 'object'
            ? {
                activeSessionId: typeof payload.rtspReclaimDebug.activeSessionId === 'string'
                  ? payload.rtspReclaimDebug.activeSessionId
                  : null,
                clientRtpPort: typeof payload.rtspReclaimDebug.clientRtpPort === 'number'
                  ? payload.rtspReclaimDebug.clientRtpPort
                  : null,
                serverRtpPort: typeof payload.rtspReclaimDebug.serverRtpPort === 'number'
                  ? payload.rtspReclaimDebug.serverRtpPort
                  : null,
                lastClaimStatus: typeof payload.rtspReclaimDebug.lastClaimStatus === 'string'
                  ? payload.rtspReclaimDebug.lastClaimStatus
                  : null,
                lastClaimAtMs: typeof payload.rtspReclaimDebug.lastClaimAtMs === 'number'
                  ? payload.rtspReclaimDebug.lastClaimAtMs
                  : null,
                updatedAtMs: typeof payload.rtspReclaimDebug.updatedAtMs === 'number'
                  ? payload.rtspReclaimDebug.updatedAtMs
                  : null,
              }
            : null;
          setPrintingMonitorRelayDebugTransport(debugTransport);
          setPrintingMonitorRelayReclaimDebug(reclaimDebug);
          return;
        }

        const payloadError = typeof payload?.error === 'string' ? payload.error.trim() : '';
        const fallbackError = 'RTSP relay endpoint returned no websocket base URL.';
        setPrintingMonitorRelayBaseWsUrl(null);
        setPrintingMonitorRelaySetupError(payloadError || fallbackError);
        setPrintingMonitorRelayDebugTransport(null);
        setPrintingMonitorRelayReclaimDebug(null);
      } catch (error) {
        if (!cancelled) {
          setPrintingMonitorRelayBaseWsUrl(null);
          const message = error instanceof Error ? error.message : 'Unable to reach RTSP relay endpoint.';
          setPrintingMonitorRelaySetupError(message);
          setPrintingMonitorRelayDebugTransport(null);
          setPrintingMonitorRelayReclaimDebug(null);
        }
      } finally {
        inFlight = false;
      }
    };

    void refreshRelayDebug();
    const intervalId = window.setInterval(() => {
      void refreshRelayDebug();
    }, DEFAULT_RTSP_DEBUG_POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [printingMonitorModalOpen, printingMonitorRtspSourceUrl]);

  const printingMonitorWebcamUrl = React.useMemo(() => {
    if (printingMonitorInlineWebcamUrl) return printingMonitorInlineWebcamUrl;

    if (!printingMonitorRtspSourceUrl || !printingMonitorRelayBaseWsUrl) return null;

    const relayQueryUrl = encodeURIComponent(printingMonitorRtspSourceUrl);
    return `${printingMonitorRelayBaseWsUrl}?url=${relayQueryUrl}`;
  }, [printingMonitorInlineWebcamUrl, printingMonitorRelayBaseWsUrl, printingMonitorRtspSourceUrl]);
  const printingMonitorWebcamUsesRelayWs = React.useMemo(() => {
    const candidate = (printingMonitorWebcamUrl ?? '').trim();
    return /^wss?:\/\//i.test(candidate);
  }, [printingMonitorWebcamUrl]);
  const printingMonitorRtspDebugSummary = React.useMemo(() => {
    if (printingMonitorInlineWebcamUrl) {
      return {
        title: 'Inline webcam transport',
        description: 'The monitor is using the printer-provided HTTP/data/blob stream directly, so no RTSP relay is involved.',
      };
    }

    if (printingMonitorRtspSourceUrl && printingMonitorRelayBaseWsUrl) {
      return {
        title: 'RTSP relay transport',
        description: 'The printer reported an RTSP source and the monitor is bridging it through the local relay websocket.',
      };
    }

    if (printingMonitorRtspSourceUrl) {
      if (printingMonitorIsDesktopRuntime && printingMonitorRelaySetupError) {
        return {
          title: 'RTSP relay unavailable',
          description: `The printer reported an RTSP URL, but the relay endpoint could not be initialized in this bundled runtime (${printingMonitorRelaySetupError}).`,
        };
      }

      return {
        title: 'RTSP source detected',
        description: 'The printer reported an RTSP URL, but the local relay websocket is not ready yet.',
      };
    }

    return {
      title: 'No RTSP source',
      description: 'The printer did not report an RTSP webcam URL for this monitor session.',
    };
  }, [
    printingMonitorInlineWebcamUrl,
    printingMonitorIsDesktopRuntime,
    printingMonitorRelayBaseWsUrl,
    printingMonitorRelaySetupError,
    printingMonitorRtspSourceUrl,
  ]);
  const printingMonitorHasCamera = activePrinterProfile?.hasCamera !== false;
  const printingMonitorUsesTwoColumnDetailLayout = printingMonitorHasCamera;
  const printingMonitorModalWidthClass = printingMonitorViewMode === 'detail' && !printingMonitorUsesTwoColumnDetailLayout
    ? 'w-[min(760px,94vw)]'
    : 'w-[min(1120px,94vw)]';
  const printingMonitorWebcamStatusPresentation = React.useMemo(() => {
    const rawMessage = (printingMonitorWebcamInfo?.message ?? 'No webcam feed reported yet.').trim();
    const messageLower = rawMessage.toLowerCase();

    if (messageLower.includes('stream limit') || messageLower.includes('simultaneous')) {
      return {
        tone: 'warning' as const,
        title: 'Video Stream Busy',
        description: rawMessage,
      };
    }

    if (messageLower.includes('failed') || messageLower.includes('error') || messageLower.includes('unable')) {
      return {
        tone: 'error' as const,
        title: 'Webcam Unavailable',
        description: rawMessage,
      };
    }

    return {
      tone: 'neutral' as const,
      title: 'Webcam Not Ready',
      description: rawMessage,
    };
  }, [printingMonitorWebcamInfo?.message]);
  const printingMonitorWebcamDisplayPresentation = React.useMemo(() => {
    if (printingMonitorWebcamLoadError) {
      return {
        tone: 'error' as const,
        title: 'Webcam Unavailable',
        description: printingMonitorWebcamLoadError,
      };
    }

    return printingMonitorWebcamStatusPresentation;
  }, [printingMonitorWebcamLoadError, printingMonitorWebcamStatusPresentation]);
  const printingMonitorUiPolicy = React.useMemo(() => {
    return printingMonitoringAdapter.getMonitoringUiPolicy?.() ?? null;
  }, [printingMonitoringAdapter]);
  const printingMonitorBusyGraceMs = printingMonitorUiPolicy?.busyResponseGraceMs ?? DEFAULT_MONITOR_BUSY_GRACE_MS;
  const printingMonitorReachabilityMaxInconclusivePolls = printingMonitorUiPolicy?.inconclusiveReachabilityMaxPolls ?? null;
  const printingMonitorSupportsWebcamStreamSlotReset = Boolean(printingMonitorUiPolicy?.supportsWebcamStreamSlotReset);
  const printingMonitorWebcamMaxConsecutiveTimeouts = printingMonitorUiPolicy?.webcamMaxConsecutiveTimeouts ?? DEFAULT_WEBCAM_MAX_CONSECUTIVE_TIMEOUTS;
  const printingMonitorWebcamTimeoutCooldownMs = printingMonitorUiPolicy?.webcamTimeoutCooldownMs ?? DEFAULT_WEBCAM_TIMEOUT_COOLDOWN_MS;
  const printingMonitorWebcamFailureCooldownMs = printingMonitorUiPolicy?.webcamFailureCooldownMs ?? DEFAULT_WEBCAM_FAILURE_COOLDOWN_MS;
  const printingMonitorWebcamCanResetStreamSlot = React.useMemo(() => {
    if (!printingMonitorSupportsWebcamStreamSlotReset) return false;
    const messageLower = String(printingMonitorWebcamInfo?.message ?? '').toLowerCase();
    if (!messageLower) return false;
    return messageLower.includes('stream limit') || messageLower.includes('simultaneous');
  }, [printingMonitorSupportsWebcamStreamSlotReset, printingMonitorWebcamInfo?.message]);
  const monitorWebcamRotationDeg = React.useMemo(() => {
    const candidate = Number(activePrinterProfile?.display.webcamRotationDeg ?? 0);
    if (candidate === 0 || candidate === 90 || candidate === 180 || candidate === 270) {
      return candidate as 0 | 90 | 180 | 270;
    }
    return 0;
  }, [activePrinterProfile?.display.webcamRotationDeg]);
  const shouldSwapMonitorWebcamAspect = React.useMemo(() => {
    return monitorWebcamRotationDeg === 90 || monitorWebcamRotationDeg === 270;
  }, [monitorWebcamRotationDeg]);
  const monitorWebcamTransform = React.useMemo(() => {
    const rotate = monitorWebcamRotationDeg !== 0
      ? `rotate(${monitorWebcamRotationDeg}deg)`
      : '';
    const scale = shouldSwapMonitorWebcamAspect
      ? ` scale(${printingMonitorWebcamAspectRatio ?? 1})`
      : '';
    const combined = `${rotate}${scale}`.trim();
    return combined.length > 0 ? combined : undefined;
  }, [monitorWebcamRotationDeg, printingMonitorWebcamAspectRatio, shouldSwapMonitorWebcamAspect]);
  const printingMonitorCanExpandWebcam = React.useMemo(() => {
    return Boolean(
      printingMonitorModalOpen
      && printingMonitorViewMode === 'detail'
      && printingMonitorUsesTwoColumnDetailLayout
      && printingMonitorHasCamera
    );
  }, [
    printingMonitorHasCamera,
    printingMonitorModalOpen,
    printingMonitorUsesTwoColumnDetailLayout,
    printingMonitorViewMode,
  ]);
  const printingMonitorDetailWebcamExpanded = printingMonitorCanExpandWebcam && printingMonitorWebcamExpanded;
  const monitorWebcamDisplayAspectRatio = React.useMemo(() => {
    const normalizedAspect = normalizePrintingMonitorWebcamAspectRatio(printingMonitorWebcamAspectRatio);
    if (normalizedAspect == null) {
      return null;
    }
    return shouldSwapMonitorWebcamAspect
      ? (1 / normalizedAspect)
      : normalizedAspect;
  }, [printingMonitorWebcamAspectRatio, shouldSwapMonitorWebcamAspect]);
  const printingMonitorStateTextNormalized = React.useMemo(() => {
    return String(printingMonitorSnapshot?.stateText ?? '').trim().toLowerCase();
  }, [printingMonitorSnapshot?.stateText]);
  const printingMonitorIsPauseTransition = React.useMemo(() => {
    return Boolean(
      printingMonitorSnapshot?.pauseLatched
      || printingMonitorStateTextNormalized === 'pausing',
    );
  }, [printingMonitorSnapshot?.pauseLatched, printingMonitorStateTextNormalized]);
  const printingMonitorIsCancelTransition = React.useMemo(() => {
    return Boolean(
      printingMonitorStateTextNormalized === 'canceling'
      || (printingMonitorSnapshot?.cancelLatched && printingMonitorStateTextNormalized !== 'idle'),
    );
  }, [printingMonitorSnapshot?.cancelLatched, printingMonitorStateTextNormalized]);
  const printingMonitorHasActivePrint = React.useMemo(() => {
    return Boolean(
      printingMonitorSnapshot?.isPrinting
      || printingMonitorSnapshot?.isPaused
      || printingMonitorIsCancelTransition
      || printingMonitorIsPauseTransition
    );
  }, [
    printingMonitorSnapshot?.isPaused,
    printingMonitorSnapshot?.isPrinting,
    printingMonitorIsCancelTransition,
    printingMonitorIsPauseTransition,
  ]);
  const printingMonitorAnyActionBusy = React.useMemo(() => {
    return printingMonitorActionBusy !== null || printingMonitorControlPendingAction !== null;
  }, [printingMonitorActionBusy, printingMonitorControlPendingAction]);
  const printingMonitorCancelButtonAnimating = React.useMemo(() => {
    return Boolean(
      printingMonitorControlPendingAction === 'cancel'
      || printingMonitorIsCancelTransition
      || printingMonitorActionBusy === 'cancel',
    );
  }, [printingMonitorActionBusy, printingMonitorControlPendingAction, printingMonitorIsCancelTransition]);
  const printingMonitorPauseButtonAnimating = React.useMemo(() => {
    return Boolean(
      printingMonitorControlPendingAction === 'pause'
      || printingMonitorControlPendingAction === 'resume'
      || printingMonitorIsPauseTransition
      || printingMonitorActionBusy === 'pause'
      || printingMonitorActionBusy === 'resume',
    );
  }, [
    printingMonitorActionBusy,
    printingMonitorControlPendingAction,
    printingMonitorIsPauseTransition,
  ]);
  const printingMonitorPauseButtonDisabled = React.useMemo(() => {
    if (!printingMonitoringAdapter.operations || !printingMonitorHasActivePrint) return true;
    if (printingMonitorIsCancelTransition || printingMonitorControlPendingAction === 'cancel') return true;
    if (printingMonitorIsPauseTransition || printingMonitorControlPendingAction === 'pause') return true;
    return (
      printingMonitorActionBusy === 'start'
      || printingMonitorActionBusy === 'delete'
      || printingMonitorActionBusy === 'pause'
      || printingMonitorActionBusy === 'resume'
      || printingMonitorActionBusy === 'emergency-stop'
      || printingMonitorControlPendingAction === 'resume'
      || printingMonitorControlPendingAction === 'emergency-stop'
    );
  }, [
    printingMonitorActionBusy,
    printingMonitorControlPendingAction,
    printingMonitorHasActivePrint,
    printingMonitorIsCancelTransition,
    printingMonitorIsPauseTransition,
    printingMonitoringAdapter.operations,
  ]);
  const printingMonitorCancelButtonDisabled = React.useMemo(() => {
    if (!printingMonitoringAdapter.operations || !printingMonitorHasActivePrint) return true;
    if (printingMonitorIsPauseTransition || printingMonitorIsCancelTransition) return true;
    return printingMonitorAnyActionBusy;
  }, [
    printingMonitorAnyActionBusy,
    printingMonitorHasActivePrint,
    printingMonitorIsCancelTransition,
    printingMonitorIsPauseTransition,
    printingMonitoringAdapter.operations,
  ]);
  const printingMonitorEmergencyStopDisabled = React.useMemo(() => {
    if (!printingMonitoringAdapter.operations) return true;
    return (
      printingMonitorActionBusy === 'start'
      || printingMonitorActionBusy === 'delete'
      || printingMonitorActionBusy === 'pause'
      || printingMonitorActionBusy === 'resume'
      || printingMonitorActionBusy === 'emergency-stop'
      || printingMonitorControlPendingAction === 'pause'
      || printingMonitorControlPendingAction === 'resume'
      || printingMonitorControlPendingAction === 'emergency-stop'
    );
  }, [printingMonitorActionBusy, printingMonitorControlPendingAction, printingMonitoringAdapter.operations]);
  const printingMonitorDisplayProgressPct = React.useMemo(() => {
    if (!printingMonitorHasActivePrint) return null;
    const totalRaw = printingMonitorSnapshot?.totalLayers;
    const currentRaw = printingMonitorSnapshot?.currentLayer;
    const totalNumeric = Number(totalRaw);
    const currentNumeric = Number(currentRaw);
    if (!Number.isFinite(totalNumeric) || !Number.isFinite(currentNumeric)) return null;

    const total = Math.max(0, Math.round(totalNumeric));
    const current = Math.max(0, Math.round(currentNumeric));
    if (total <= 0) return null;

    const completedLayers = Math.max(0, Math.min(total, current - 1));
    return (completedLayers / total) * 100;
  }, [printingMonitorHasActivePrint, printingMonitorSnapshot?.currentLayer, printingMonitorSnapshot?.totalLayers]);
  const printingMonitorDisplayCurrentLayer = React.useMemo(() => {
    if (!printingMonitorHasActivePrint) return null;
    const raw = printingMonitorSnapshot?.currentLayer;
    if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
    return Math.max(0, Math.round(raw));
  }, [printingMonitorHasActivePrint, printingMonitorSnapshot?.currentLayer]);
  const printingMonitorDisplayTotalLayers = React.useMemo(() => {
    if (!printingMonitorHasActivePrint) return null;
    const raw = printingMonitorSnapshot?.totalLayers;
    if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
    return Math.round(raw);
  }, [printingMonitorHasActivePrint, printingMonitorSnapshot?.totalLayers]);
  const printingMonitorDisplayMaterialProfile = React.useMemo(() => {
    if (!printingMonitorHasActivePrint) return '—';

    const activePlateId = printingMonitorPlateId;
    if (activePlateId != null) {
      const activePlate = printingMonitorRecentPlates.find((plate) => plate.plateId === activePlateId);
      if (activePlate?.materialProfileName) return activePlate.materialProfileName;
    }

    if (printingMonitorSelectedPlateId != null) {
      const selectedPlate = printingMonitorRecentPlates.find((plate) => plate.plateId === printingMonitorSelectedPlateId);
      if (selectedPlate?.materialProfileName) return selectedPlate.materialProfileName;
    }

    return '—';
  }, [printingMonitorHasActivePrint, printingMonitorPlateId, printingMonitorRecentPlates, printingMonitorSelectedPlateId]);
  const selectedPrinterStateTextNormalized = React.useMemo(() => {
    return String(selectedPrinterMonitorSnapshot?.stateText ?? '').trim().toLowerCase();
  }, [selectedPrinterMonitorSnapshot?.stateText]);
  const selectedPrinterIsPauseTransition = React.useMemo(() => {
    return Boolean(
      selectedPrinterMonitorSnapshot?.pauseLatched
      || selectedPrinterStateTextNormalized === 'pausing',
    );
  }, [selectedPrinterMonitorSnapshot?.pauseLatched, selectedPrinterStateTextNormalized]);
  const selectedPrinterIsCancelTransition = React.useMemo(() => {
    return Boolean(
      selectedPrinterStateTextNormalized === 'canceling'
      || (selectedPrinterMonitorSnapshot?.cancelLatched && selectedPrinterStateTextNormalized !== 'idle'),
    );
  }, [selectedPrinterMonitorSnapshot?.cancelLatched, selectedPrinterStateTextNormalized]);
  const selectedPrinterHasActivePrint = React.useMemo(() => {
    return Boolean(
      selectedPrinterMonitorSnapshot?.isPrinting
      || selectedPrinterMonitorSnapshot?.isPaused
      || selectedPrinterIsCancelTransition
      || selectedPrinterIsPauseTransition
    );
  }, [
    selectedPrinterMonitorSnapshot?.isPaused,
    selectedPrinterMonitorSnapshot?.isPrinting,
    selectedPrinterIsCancelTransition,
    selectedPrinterIsPauseTransition,
  ]);
  const selectedPrinterHasPausedAlert = React.useMemo(() => {
    return Boolean(
      selectedPrinterMonitorSnapshot?.isPaused
      || selectedPrinterIsPauseTransition,
    );
  }, [selectedPrinterIsPauseTransition, selectedPrinterMonitorSnapshot?.isPaused]);
  React.useEffect(() => {
    const selectedDeviceId = selectedKnownPrinterDevice?.id;
    if (!selectedDeviceId) return;

    const selectedReachability = printerReachabilityByDeviceId[selectedDeviceId];
    if (selectedReachability === false || selectedKnownPrinterDevice.connected !== true) {
      topbarPrinterOfflineCacheByDeviceIdRef.current[selectedDeviceId] = true;
      return;
    }

    if (selectedReachability === true && selectedKnownPrinterDevice.connected === true) {
      topbarPrinterOfflineCacheByDeviceIdRef.current[selectedDeviceId] = false;
    }
  }, [printerReachabilityByDeviceId, selectedKnownPrinterDevice]);
  const isTopbarSelectedPrinterOffline = React.useMemo(() => {
    const selectedHost = (selectedKnownPrinterDevice?.ipAddress || activePrinterProfile?.network?.ipAddress || '').trim();
    if (!selectedHost) return false;

    if (selectedKnownPrinterDevice) {
      const selectedReachability = printerReachabilityByDeviceId[selectedKnownPrinterDevice.id];
      if (selectedReachability === false) return true;
      if (selectedKnownPrinterDevice.connected !== true) return true;
      if (selectedReachability === true) return false;
      return topbarPrinterOfflineCacheByDeviceIdRef.current[selectedKnownPrinterDevice.id] === true;
    }

    return activePrinterProfile?.networkConnection?.connected === false;
  }, [
    activePrinterProfile?.network?.ipAddress,
    activePrinterProfile?.networkConnection?.connected,
    printerReachabilityByDeviceId,
    selectedKnownPrinterDevice,
  ]);
  const isPrintingMonitorSelectedPrinterOfflineRaw = React.useMemo(() => {
    const monitorHost = (monitoringDevice?.ipAddress || activePrinterProfile?.network?.ipAddress || '').trim();
    if (!monitorHost) return false;

    if (printingMonitorSnapshot?.connected === true) {
      return false;
    }

    if (monitoringDevice) {
      if (printerReachabilityByDeviceId[monitoringDevice.id] !== true) return true;
      return monitoringDevice.connected !== true;
    }

    return activePrinterProfile?.networkConnection?.connected === false;
  }, [
    activePrinterProfile?.network?.ipAddress,
    activePrinterProfile?.networkConnection?.connected,
    monitoringDevice,
    printingMonitorSnapshot?.connected,
    printerReachabilityByDeviceId,
  ]);
  const isPrintingMonitorWithinSlowResponseGrace = React.useMemo(() => {
    if (!printingMonitorModalOpen) return false;
    if (printingMonitorLastStatusSuccessAtMs == null) return false;
    return (printingMonitorNowEpochMs - printingMonitorLastStatusSuccessAtMs) <= printingMonitorBusyGraceMs;
  }, [
    printingMonitorLastStatusSuccessAtMs,
    printingMonitorModalOpen,
    printingMonitorNowEpochMs,
    printingMonitorBusyGraceMs,
  ]);
  const printingMonitorSlowResponseGraceRemainingSec = React.useMemo(() => {
    if (!isPrintingMonitorWithinSlowResponseGrace || printingMonitorLastStatusSuccessAtMs == null) return 0;
    const remainingMs = Math.max(0, printingMonitorBusyGraceMs - (printingMonitorNowEpochMs - printingMonitorLastStatusSuccessAtMs));
    return Math.ceil(remainingMs / 1000);
  }, [
    isPrintingMonitorWithinSlowResponseGrace,
    printingMonitorLastStatusSuccessAtMs,
    printingMonitorNowEpochMs,
    printingMonitorBusyGraceMs,
  ]);
  const shouldShowPrintingMonitorSlowResponseCard = React.useMemo(() => {
    return isPrintingMonitorSelectedPrinterOfflineRaw && isPrintingMonitorWithinSlowResponseGrace;
  }, [isPrintingMonitorSelectedPrinterOfflineRaw, isPrintingMonitorWithinSlowResponseGrace]);
  const isPrintingMonitorSelectedPrinterOffline = React.useMemo(() => {
    if (isPrintingMonitorSelectedPrinterOfflineRaw && isPrintingMonitorWithinSlowResponseGrace) {
      return false;
    }
    return isPrintingMonitorSelectedPrinterOfflineRaw;
  }, [
    isPrintingMonitorSelectedPrinterOfflineRaw,
    isPrintingMonitorWithinSlowResponseGrace,
  ]);
  const hasMonitorSelectableTarget = monitorSelectableDevices.length > 0;
  const hasPrintingMonitorFleet = monitorSelectableDevices.length > 1;
  const printingMonitorPrinterThumbnailSrc = React.useMemo(() => {
    const source = activePrinterProfile?.imageDataUrl;
    if (typeof source !== 'string') return null;
    const trimmed = source.trim();
    if (!trimmed || isPrintingMonitorPrinterThumbnailFailed) return null;
    return trimmed;
  }, [activePrinterProfile?.imageDataUrl, isPrintingMonitorPrinterThumbnailFailed]);
  const printingMonitorHeaderUsesFleetLabelOrder = React.useMemo(() => {
    return (activePrinterProfile?.networkFleet?.length ?? 0) > 1;
  }, [activePrinterProfile?.networkFleet]);
  const printingMonitorHeaderTopLabel = React.useMemo(() => {
    if (printingMonitorHeaderUsesFleetLabelOrder) {
      return activePrinterProfile?.name ?? 'Select Profile';
    }
    return 'Printer';
  }, [activePrinterProfile?.name, printingMonitorHeaderUsesFleetLabelOrder]);
  const printingMonitorHeaderBottomLabel = React.useMemo(() => {
    const selectedPrinterName = monitoringDevice?.displayName || monitoringDevice?.hostName || monitoringDevice?.ipAddress || 'Selected printer';
    return selectedPrinterName;
  }, [monitoringDevice?.displayName, monitoringDevice?.hostName, monitoringDevice?.ipAddress]);
  const printingMonitorHeaderTitle = React.useMemo(() => {
    if (printingMonitorHeaderUsesFleetLabelOrder) {
      return `Printer profile: ${printingMonitorHeaderTopLabel} • Active printer: ${printingMonitorHeaderBottomLabel}`;
    }
    return `Monitored printer: ${printingMonitorHeaderBottomLabel}`;
  }, [printingMonitorHeaderBottomLabel, printingMonitorHeaderTopLabel, printingMonitorHeaderUsesFleetLabelOrder]);
  const showTopbarMonitorButton = React.useMemo(() => {
    const hasMonitoring = Boolean(
      printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations
    );
    if (!hasMonitoring) return false;
    if (!hasMonitorSelectableTarget) return false;
    return true;
  }, [hasMonitorSelectableTarget, printingMonitoringAdapter]);

  React.useEffect(() => {
    printingMonitorRecentPlatesRef.current = printingMonitorRecentPlates;
  }, [printingMonitorRecentPlates]);

  React.useEffect(() => {
    printingMonitorSelectedPlateIdRef.current = printingMonitorSelectedPlateId;
  }, [printingMonitorSelectedPlateId]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) return;

    setPrintingMonitorNowEpochMs(Date.now());
    const intervalId = window.setInterval(() => {
      setPrintingMonitorNowEpochMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [printingMonitorModalOpen]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) return;
    setPrintingMonitorLastStatusSuccessAtMs(null);
    setIsPrintingMonitorStatusRequestInFlight(false);
  }, [monitoringDevice?.id, printingMonitorModalOpen]);

  React.useEffect(() => {
    const shouldProbeFleetReachability = Boolean(
      activeNetworkUiAdapter
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations?.status,
    );

    if (!shouldProbeFleetReachability) {
      monitorReachabilityInconclusiveCountsRef.current = {};
      return;
    }

    const probeFleet = (activePrinterProfile?.networkFleet ?? []).filter((device) => {
      const host = (device.ipAddress || '').trim();
      return host.length > 0;
    });

    if (probeFleet.length === 0) {
      monitorReachabilityInconclusiveCountsRef.current = {};
      return;
    }

    let cancelled = false;

    const probeWithTimeout = async (device: PrinterNetworkDevice): Promise<boolean | null> => {
      const host = (device.ipAddress || '').trim();
      const port = device.port || 80;
      if (!host) return false;

      // Deterministic debug behavior for local dummy endpoints.
      const normalizedHost = host.toLowerCase();
      const normalizedName = `${device.displayName ?? ''} ${device.hostName ?? ''}`.toLowerCase();
      if (normalizedHost.endsWith('999.999') || normalizedName.includes('debug dummy athena a')) {
        return true;
      }
      if (normalizedHost.endsWith('999.998') || normalizedName.includes('debug dummy athena b')) {
        return false;
      }

      try {
        const result = await Promise.race<boolean | null>([
          pluginNetworkFetch({
            pluginId: printingMonitoringAdapter.pluginId!,
            operation: printingMonitoringAdapter.operations!.status,
            ipAddress: host,
            port,
          })
            .then(async (response) => {
              if (!response.ok) return false;

              const payload = await readJsonObject(response);
              const payloadOk = readBooleanField(payload, 'ok');
              if (payloadOk != null) {
                return payloadOk === true;
              }

              try {
                const parsed = printingMonitoringAdapter.parseStatusPayload(payload, `reachability:${host}:${port}`);
                if (parsed && typeof parsed.connected === 'boolean') {
                  return parsed.connected;
                }
              } catch {
                // Ignore parse errors and fall back to HTTP success semantics.
              }

              return true;
            })
            .catch(() => null),
          new Promise<null>((resolve) => {
            window.setTimeout(() => resolve(null), REACHABILITY_PROBE_TIMEOUT_MS);
          }),
        ]);

        return result;
      } catch {
        return null;
      }
    };

    const probeAll = async () => {
      const entries = await Promise.all(
        probeFleet.map(async (device) => {
          const reachable = await probeWithTimeout(device);
          return [device.id, reachable] as const;
        }),
      );

      if (cancelled) return;

      const previousReachability = getPrinterReachabilitySnapshot();
      const previousInconclusiveCounts = monitorReachabilityInconclusiveCountsRef.current;
      const nextInconclusiveCounts: Record<string, number> = {};
      const nextMap: Record<string, boolean | null> = {};
      const maxUnknownPolls = Math.max(1, printingMonitorReachabilityMaxInconclusivePolls ?? 1);
      for (const [id, reachable] of entries) {
        if (reachable === true) {
          nextMap[id] = true;
          nextInconclusiveCounts[id] = 0;
          continue;
        }

        if (reachable === false) {
          nextMap[id] = false;
          nextInconclusiveCounts[id] = 0;
          continue;
        }

        const unknownCount = (previousInconclusiveCounts[id] ?? 0) + 1;
        nextInconclusiveCounts[id] = unknownCount;

        const keepPreviousOnline = previousReachability[id] === true && unknownCount < maxUnknownPolls;
        nextMap[id] = keepPreviousOnline ? true : false;
      }

      monitorReachabilityInconclusiveCountsRef.current = nextInconclusiveCounts;
      const mergedMap: Record<string, boolean | null> = {
        ...previousReachability,
        ...nextMap,
      };
      setPrinterReachabilityMap(mergedMap);
    };

    void probeAll();

    const intervalId = window.setInterval(() => {
      void probeAll();
    }, 9000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    activeNetworkUiAdapter,
    activePrinterProfile?.networkFleet,
    printingMonitoringAdapter,
  ]);

  React.useEffect(() => {
    if (!printingTargetPickerOpen) return;
    if (!printingTargetDeviceId) return;
    if (printerReachabilityByDeviceId[printingTargetDeviceId] !== false) return;

    const fallbackOnline = printableConnectedPrinterFleet.find(
      (device) => printerReachabilityByDeviceId[device.id] !== false,
    );
    if (fallbackOnline) {
      setPrintingTargetDeviceId(fallbackOnline.id);
    }
  }, [
    printableConnectedPrinterFleet,
    printerReachabilityByDeviceId,
    printingTargetDeviceId,
    printingTargetPickerOpen,
  ]);

  // Best-effort background cleanup of stale DragonFruit temp artifacts from prior runs.
  React.useEffect(() => {
    void cleanupStalePrintTempArtifacts(3 * 24 * 60 * 60)
      .then((removed) => {
        if (removed > 0) {
          console.info(`[Printing] Cleaned up ${removed} stale temporary slice artifact(s).`);
        }
      })
      .catch((error) => {
        console.warn('[Printing] Failed to clean stale temp artifacts.', error);
      });
  }, []);

  // Delete previously-owned temp artifacts once replaced or cleared.
  React.useEffect(() => {
    const currentArtifactPath = printingArtifact?.nativeTempPath?.trim() || null;
    const currentPath = isDragonfruitTempArtifactPath(currentArtifactPath) ? currentArtifactPath : null;
    const previousPath = lastOwnedPrintTempPathRef.current;

    if (previousPath && previousPath !== currentPath) {
      void deletePrintTempArtifactPath(previousPath).catch((error) => {
        console.warn('[Printing] Failed to delete replaced temp artifact.', error);
      });
    }

    lastOwnedPrintTempPathRef.current = currentPath;
  }, [printingArtifact]);

  // Delete currently-owned temp artifact on page unmount.
  React.useEffect(() => {
    return () => {
      const path = lastOwnedPrintTempPathRef.current;
      if (path) {
        void deletePrintTempArtifactPath(path).catch(() => {});
      }
    };
  }, []);

  React.useEffect(() => {
    return () => {
      if (printingUploadProcessingHandoffTimeoutRef.current !== null) {
        window.clearTimeout(printingUploadProcessingHandoffTimeoutRef.current);
        printingUploadProcessingHandoffTimeoutRef.current = null;
      }

      if (preSliceTargetPickerResolverRef.current) {
        preSliceTargetPickerResolverRef.current(null);
        preSliceTargetPickerResolverRef.current = null;
      }
      if (preSlicePrintConfirmResolverRef.current) {
        preSlicePrintConfirmResolverRef.current(false);
        preSlicePrintConfirmResolverRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (!showTopbarMonitorButton && printingMonitorModalOpen) {
      setPrintingMonitorModalOpen(false);
    }
  }, [printingMonitorModalOpen, showTopbarMonitorButton]);

  React.useEffect(() => {
    if (!activePrinterProfile || !activeNetworkUiAdapter) {
      setPrintingTargetDeviceId(null);
      return;
    }

    if (printableConnectedPrinterFleet.length === 0) {
      setPrintingTargetDeviceId(null);
      return;
    }

    const activeFleetDeviceId = (activePrinterProfile.activeNetworkDeviceId ?? '').trim();
    if (
      activeFleetDeviceId
      && printableConnectedPrinterFleet.some((device) => device.id === activeFleetDeviceId)
      && printingTargetDeviceId !== activeFleetDeviceId
    ) {
      setPrintingTargetDeviceId(activeFleetDeviceId);
      return;
    }

    if (printingTargetDeviceId && printableConnectedPrinterFleet.some((device) => device.id === printingTargetDeviceId)) {
      return;
    }

    const reachableFleet = printableConnectedPrinterFleet.filter((device) => printerReachabilityByDeviceId[device.id] !== false);
    const preferredPool = reachableFleet.length > 0 ? reachableFleet : printableConnectedPrinterFleet;

    const fallbackTarget = preferredPool.find((device) => device.id === activePrinterProfile.activeNetworkDeviceId)
      ?? preferredPool[0]
      ?? null;
    if (fallbackTarget?.id) {
      setPrintingTargetDeviceId(fallbackTarget.id);
      if (fallbackTarget.id !== activePrinterProfile.activeNetworkDeviceId) {
        selectPrinterNetworkDevice(activePrinterProfile.id, fallbackTarget.id);
      }
    } else {
      setPrintingTargetDeviceId(null);
    }
  }, [activeNetworkUiAdapter, activePrinterProfile, printableConnectedPrinterFleet, printerReachabilityByDeviceId, printingTargetDeviceId]);

  React.useEffect(() => {
    if (!printingTargetPickerOpen) {
      setIsPrintingTargetMaterialsLoading(false);
      return;
    }
    if (!requiresRemoteMaterialSelectionForUpload) {
      setPrintingTargetMaterialOptions([]);
      setPrintingTargetMaterialId('__local_profile__');
      setPrintingTargetMaterialError(null);
      setIsPrintingTargetMaterialsLoading(false);
      return;
    }
    if (!printingTargetDevice || !activeNetworkUiAdapter) {
      setPrintingTargetMaterialOptions([]);
      setPrintingTargetMaterialId('');
      setPrintingTargetMaterialError('Select a printer to load matching material settings.');
      setIsPrintingTargetMaterialsLoading(false);
      return;
    }

    const host = (printingTargetDevice.ipAddress || '').trim();
    if (!host) {
      setPrintingTargetMaterialOptions([]);
      setPrintingTargetMaterialId('');
      setPrintingTargetMaterialError('Selected printer has no network address.');
      setIsPrintingTargetMaterialsLoading(false);
      return;
    }

    const cacheKey = `${activeNetworkUiAdapter.pluginId}:${host.toLowerCase()}`;
    const applyResolvedMaterials = (parsed: FleetUploadMaterialOption[]) => {
      const materialChoices = isPreSliceTargetPicker
        ? parsed
        : parsed.filter((material) => isLayerHeightMatch(material.layerHeightMm));

      const selectedDeviceMaterialId = (printingTargetDevice.selectedMaterialId ?? '').trim();
      if (
        materialChoices.length === 0
        && selectedDeviceMaterialId.length > 0
        && (isPreSliceTargetPicker || isLayerHeightMatch(printingTargetDevice.selectedMaterialLayerHeightMm ?? null))
      ) {
        materialChoices.push({
          id: selectedDeviceMaterialId,
          name: printingTargetDevice.selectedMaterialName?.trim() || selectedDeviceMaterialId,
          layerHeightMm: printingTargetDevice.selectedMaterialLayerHeightMm ?? null,
        });
      }

      setPrintingTargetMaterialOptions(materialChoices);

      setPrintingTargetMaterialId((previousId) => {
        const preferredId = previousId.trim();
        const fallbackId = materialChoices.find((material) => material.id === selectedDeviceMaterialId)?.id
          ?? materialChoices[0]?.id
          ?? '';
        return materialChoices.some((material) => material.id === preferredId) ? preferredId : fallbackId;
      });

      if (materialChoices.length === 0) {
        setPrintingTargetMaterialError(
          isPreSliceTargetPicker
            ? 'No material profiles found on this printer.'
            : `No material on this printer matches sliced layer height ${slicedLayerHeightMm.toFixed(3)} mm.`,
        );
      } else {
        setPrintingTargetMaterialError(null);
      }
    };

    const cached = printingTargetMaterialsCacheRef.current.get(cacheKey);
    if (cached) {
      setIsPrintingTargetMaterialsLoading(false);
      applyResolvedMaterials(cached);
      return;
    }

    let cancelled = false;
    setIsPrintingTargetMaterialsLoading(true);
    setPrintingTargetMaterialError(null);

    void (async () => {
      try {
        const response = await pluginNetworkFetch({
          pluginId: activeNetworkUiAdapter.pluginId,
          operation: activeNetworkUiAdapter.operations.materials,
          host,
        });

        const payload = await readJsonObject(response);
        const rawMaterials = Array.isArray(payload?.materials) ? payload.materials : [];

        const parsed: FleetUploadMaterialOption[] = rawMaterials
          .map((item: any) => {
            if (typeof item?.id !== 'string' || typeof item?.name !== 'string') return null;
            const processValues = activeNetworkUiAdapter.resolveMaterialProcessValues((item?.meta ?? {}) as Record<string, unknown>);
            return {
              id: item.id,
              name: item.name,
              layerHeightMm: Number.isFinite(Number(processValues.layerHeightMm))
                ? Number(processValues.layerHeightMm)
                : null,
            } satisfies FleetUploadMaterialOption;
          })
          .filter((item: FleetUploadMaterialOption | null): item is FleetUploadMaterialOption => item !== null);

        if (cancelled) return;
        printingTargetMaterialsCacheRef.current.set(cacheKey, parsed);
        applyResolvedMaterials(parsed);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Failed to load materials from printer.';
        setPrintingTargetMaterialOptions([]);
        setPrintingTargetMaterialId('');
        setPrintingTargetMaterialError(message);
      } finally {
        if (!cancelled) {
          setIsPrintingTargetMaterialsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeNetworkUiAdapter,
    isPreSliceTargetPicker,
    isLayerHeightMatch,
    printingTargetDevice,
    printingTargetPickerOpen,
    requiresRemoteMaterialSelectionForUpload,
    slicedLayerHeightMm,
  ]);

  React.useEffect(() => {
    if (!printingUploadDialogOpen || printingUploadDialogStage !== 'processing' || printingDeviceProcessingStartedAtMs == null) {
      setPrintingDeviceProcessingElapsedSec(0);
      return;
    }

    const updateElapsed = () => {
      setPrintingDeviceProcessingElapsedSec(Math.max(0, Math.floor((Date.now() - printingDeviceProcessingStartedAtMs) / 1000)));
    };

    updateElapsed();
    const id = window.setInterval(updateElapsed, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [printingDeviceProcessingStartedAtMs, printingUploadDialogOpen, printingUploadDialogStage]);

  React.useEffect(() => {
    const canProbeSelectedPrinter = Boolean(
      printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations
      && selectedPrinterProbeTarget,
    );

    if (!canProbeSelectedPrinter) {
      setSelectedPrinterMonitorSnapshot(null);
      return;
    }

    const host = (selectedPrinterProbeTarget?.host || '').trim();
    const port = selectedPrinterProbeTarget?.port || 80;
    if (!host) {
      setSelectedPrinterMonitorSnapshot(null);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        try {
          const response = await pluginNetworkFetch({
            pluginId: printingMonitoringAdapter.pluginId,
            operation: printingMonitoringAdapter.operations!.status,
            ipAddress: host,
            port,
          });

          const payload = await readJsonObject(response);
          if (cancelled) return;
          const snapshot = printingMonitoringAdapter.parseStatusPayload(payload, `${host}:${port}`);
          setSelectedPrinterMonitorSnapshot(snapshot);
        } catch {
          if (cancelled) return;
          setSelectedPrinterMonitorSnapshot(null);
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 4500);
        });
      }
    };

    void poll();

    return () => {
      cancelled = true;
    };
  }, [printingMonitoringAdapter, selectedPrinterProbeTarget]);

  React.useEffect(() => {
    const canMonitor = Boolean(
      printingMonitorModalOpen
      && monitoringDevice
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations,
    );

    if (!canMonitor) {
      setIsPrintingMonitorPolling(false);
      setIsPrintingMonitorStatusRequestInFlight(false);
      return;
    }

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setIsPrintingMonitorPolling(false);
      setIsPrintingMonitorStatusRequestInFlight(false);
      setPrintingMonitorError('No printer IP available for monitoring.');
      return;
    }

    let cancelled = false;
    setIsPrintingMonitorPolling(true);

    const poll = async () => {
      while (!cancelled) {
        const requestPayload = {
          pluginId: printingMonitoringAdapter.pluginId,
          operation: printingMonitoringAdapter.operations!.status,
          ipAddress: host,
          port,
          plateId: printingReadyPlateId,
        };

        setIsPrintingMonitorStatusRequestInFlight(true);
        try {
          const response = await pluginNetworkFetch(requestPayload);

          const payload = await readJsonObject(response);
          if (cancelled) return;

          const snapshot = printingMonitoringAdapter.parseStatusPayload(payload, `${host}:${port}`);
          setPrintingMonitorSnapshot(snapshot);
          if (snapshot?.connected === true) {
            setPrintingMonitorLastStatusSuccessAtMs(Date.now());
          }
          const payloadError = typeof payload?.error === 'string' ? payload.error : null;
          const liveReachability = monitoringDevice ? getPrinterReachabilitySnapshot()[monitoringDevice.id] : null;
          const isLikelyOffline = Boolean(
            monitoringDevice
            && (liveReachability !== true || monitoringDevice.connected !== true)
            && snapshot?.connected !== true,
          );
          setPrintingMonitorError(isLikelyOffline ? null : payloadError);
          setPrintingMonitorDebugState((previous) => ({
            ...previous,
            status: {
              requestedAtEpochMs: Date.now(),
              request: requestPayload,
              httpStatus: response.status,
              rawPayload: payload,
              parsedPayload: snapshot,
              error: null,
            },
          }));
        } catch (error) {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : 'Failed to poll printer status.';
          const liveReachability = monitoringDevice ? getPrinterReachabilitySnapshot()[monitoringDevice.id] : null;
          const isLikelyOffline = Boolean(
            monitoringDevice
            && (liveReachability !== true || monitoringDevice.connected !== true),
          );
          setPrintingMonitorError(isLikelyOffline ? null : message);
          setPrintingMonitorDebugState((previous) => ({
            ...previous,
            status: {
              requestedAtEpochMs: Date.now(),
              request: requestPayload,
              httpStatus: null,
              rawPayload: null,
              parsedPayload: null,
              error: message,
            },
          }));
        } finally {
          if (!cancelled) {
            setIsPrintingMonitorStatusRequestInFlight(false);
          }
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, 2200);
        });
      }
    };

    void poll().finally(() => {
      if (!cancelled) {
        setIsPrintingMonitorPolling(false);
        setIsPrintingMonitorStatusRequestInFlight(false);
      }
    });

    return () => {
      cancelled = true;
      setIsPrintingMonitorPolling(false);
      setIsPrintingMonitorStatusRequestInFlight(false);
    };
  }, [
    monitoringDevice,
    printingMonitoringAdapter,
    printingMonitorModalOpen,
    printingReadyPlateId,
  ]);

  const refreshPrintingMonitorRecentPlates = React.useCallback(async () => {
    const requestId = ++printingMonitorRecentPlatesRequestIdRef.current;

    const canLoadRecentPlates = Boolean(
      printingMonitorModalOpen
      && monitoringDevice
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations?.platesList,
    );
    if (!canLoadRecentPlates) {
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      setPrintingMonitorRecentPlatesError(null);
      setIsPrintingMonitorRecentPlatesLoading(false);
      return;
    }

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      setPrintingMonitorRecentPlatesError('No printer IP available for recent print files.');
      setIsPrintingMonitorRecentPlatesLoading(false);
      return;
    }

    setIsPrintingMonitorRecentPlatesLoading(true);
    setPrintingMonitorRecentPlatesError(null);

    const requestPayload = {
      pluginId: printingMonitoringAdapter.pluginId,
      operation: printingMonitoringAdapter.operations!.platesList,
      ipAddress: host,
      port,
      storagePath: printingMonitorPlatesStoragePath,
      source: printingMonitorPlatesStoragePath,
      url: printingMonitorPlatesStoragePath,
    };

    try {
      const response = await pluginNetworkFetch(requestPayload);

      const payload = await readJsonObject(response);
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      const parsed: PrintingMonitorRecentPlate[] = (Array.isArray(payload?.plates) ? payload.plates : [])
        .map((entry: unknown) => {
          if (!entry || typeof entry !== 'object') return null;
          const plate = entry as Record<string, unknown>;
          const rawPlateId = plate.PlateID ?? plate.plateId ?? plate.plate_id ?? plate.id;
          const plateId = Number(String(rawPlateId ?? '').trim());
          if (!Number.isFinite(plateId) || plateId <= 0) return null;

          const rawName = plate.Path ?? plate.path ?? plate.File ?? plate.file ?? plate.Name ?? plate.name;
          const fullName = typeof rawName === 'string' ? rawName.trim() : `Plate #${Math.round(plateId)}`;
          const cleanName = fullName.split('/').filter(Boolean).pop() || fullName;

          const rawMaterialProfile =
            plate.ProfileName
            ?? plate.profileName
            ?? plate.MaterialName
            ?? plate.materialName
            ?? plate.ResinName
            ?? plate.resinName
            ?? plate.Profile
            ?? plate.profile;
          const materialProfileFromName = typeof rawMaterialProfile === 'string'
            ? rawMaterialProfile.trim()
            : '';

          const rawProfileId =
            plate.ProfileID
            ?? plate.profileId
            ?? plate.profile_id
            ?? plate.MaterialID
            ?? plate.materialId;
          const profileId = Number(String(rawProfileId ?? '').trim());
          const materialProfileName = materialProfileFromName.length > 0
            ? materialProfileFromName
            : (Number.isFinite(profileId) && profileId > 0 ? `Profile #${Math.round(profileId)}` : null);

          const rawFileData = plate.file_data ?? plate.fileData;
          let fileData: Record<string, unknown> | undefined;
          if (rawFileData && typeof rawFileData === 'object' && !Array.isArray(rawFileData)) {
            fileData = rawFileData as Record<string, unknown>;
          } else if (typeof rawFileData === 'string' && rawFileData.trim().length > 0) {
            try {
              const parsedFileData = JSON.parse(rawFileData) as unknown;
              if (parsedFileData && typeof parsedFileData === 'object' && !Array.isArray(parsedFileData)) {
                fileData = parsedFileData as Record<string, unknown>;
              }
            } catch {
              fileData = undefined;
            }
          }
          const rawLastModified = fileData?.last_modified ?? fileData?.lastModified ?? plate.lastModified;
          const lastModifiedEpochSec = Number(String(rawLastModified ?? '').trim());
          const rawLayerCount = plate.LayersCount ?? plate.layerCount ?? fileData?.layer_count;
          const rawPrintTime =
            plate.PrintTime
            ?? plate.printTime
            ?? plate.print_time
            ?? plate.EstimatedTime
            ?? plate.estimatedTime
            ?? plate.estimated_time
            ?? plate.Duration
            ?? plate.duration
            ?? fileData?.PrintTime
            ?? fileData?.printTime
            ?? fileData?.print_time
            ?? fileData?.EstimatedTime
            ?? fileData?.estimatedTime
            ?? fileData?.estimated_time
            ?? fileData?.Duration
            ?? fileData?.duration;
          const rawUsedMaterial =
            plate.UsedMaterial
            ?? plate.usedMaterial
            ?? plate.used_material
            ?? plate.MaterialUsage
            ?? plate.materialUsage
            ?? plate.material_usage
            ?? fileData?.UsedMaterial
            ?? fileData?.usedMaterial
            ?? fileData?.used_material
            ?? fileData?.MaterialUsage
            ?? fileData?.materialUsage
            ?? fileData?.material_usage;
          const rawTotalSolidArea =
            plate.TotalSolidArea
            ?? plate.totalSolidArea
            ?? plate.total_solid_area
            ?? fileData?.TotalSolidArea
            ?? fileData?.totalSolidArea
            ?? fileData?.total_solid_area;
          const rawLargestArea =
            plate.LargestArea
            ?? plate.largestArea
            ?? plate.largest_area
            ?? fileData?.LargestArea
            ?? fileData?.largestArea
            ?? fileData?.largest_area;
          const rawSmallestArea =
            plate.SmallestArea
            ?? plate.smallestArea
            ?? plate.smallest_area
            ?? fileData?.SmallestArea
            ?? fileData?.smallestArea
            ?? fileData?.smallest_area;
          const parsedPrintTimeSec = parsePrintingMonitorSeconds(rawPrintTime);
          const parsedUsedMaterialMl = parsePrintingMonitorMaterialMl(rawUsedMaterial);
          const parsedTotalSolidAreaMm2 = parsePrintingMonitorAreaMm2(rawTotalSolidArea);
          const parsedLargestAreaMm2 = parsePrintingMonitorAreaMm2(rawLargestArea);
          const parsedSmallestAreaMm2 = parsePrintingMonitorAreaMm2(rawSmallestArea);

          return {
            plateId: Math.round(plateId),
            name: cleanName,
            materialProfileName,
            lastModifiedEpochSec: Number.isFinite(lastModifiedEpochSec) && lastModifiedEpochSec > 0
              ? Math.round(lastModifiedEpochSec)
              : null,
            layerCount: Number.isFinite(Number(rawLayerCount)) && Number(rawLayerCount) > 0
              ? Math.round(Number(rawLayerCount))
              : null,
            printTimeSec: parsedPrintTimeSec,
            usedMaterialMl: parsedUsedMaterialMl,
            totalSolidAreaMm2: parsedTotalSolidAreaMm2,
            smallestAreaMm2: parsedSmallestAreaMm2,
            largestAreaMm2: parsedLargestAreaMm2,
          } satisfies PrintingMonitorRecentPlate;
        })
        .filter((item: PrintingMonitorRecentPlate | null): item is PrintingMonitorRecentPlate => item !== null)
        .sort((a: PrintingMonitorRecentPlate, b: PrintingMonitorRecentPlate) => {
          const aModified = a.lastModifiedEpochSec ?? 0;
          const bModified = b.lastModifiedEpochSec ?? 0;
          if (aModified !== bModified) return bModified - aModified;
          return b.plateId - a.plateId;
        })
        .slice(0, 20);

      setPrintingMonitorRecentPlates(parsed);
      setPrintingMonitorDebugState((previous) => ({
        ...previous,
        plates: {
          requestedAtEpochMs: Date.now(),
          request: requestPayload,
          httpStatus: response.status,
          rawPayload: payload,
          parsedPayload: parsed,
          error: null,
        },
      }));
      setPrintingMonitorSelectedPlateId((previous) => {
        if (previous != null && parsed.some((plate: PrintingMonitorRecentPlate) => plate.plateId === previous)) return previous;
        if (printingMonitorPlateId != null && parsed.some((plate: PrintingMonitorRecentPlate) => plate.plateId === printingMonitorPlateId)) {
          return printingMonitorPlateId;
        }
        return parsed[0]?.plateId ?? null;
      });
      setPrintingMonitorRecentPlatesError(null);
      if (printingMonitorRecentPlatesCacheKey) {
        const resolvedSelectedPlateId = (
          printingMonitorPlateId != null && parsed.some((plate: PrintingMonitorRecentPlate) => plate.plateId === printingMonitorPlateId)
        )
          ? printingMonitorPlateId
          : (parsed[0]?.plateId ?? null);
        printingMonitorRecentPlatesCacheRef.current.set(printingMonitorRecentPlatesCacheKey, {
          plates: parsed,
          selectedPlateId: resolvedSelectedPlateId,
          error: null,
        });
      }
    } catch (error) {
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      const message = error instanceof Error ? error.message : 'Failed to load recent print files.';
      setPrintingMonitorRecentPlatesError(message);
      if (printingMonitorRecentPlatesCacheKey) {
        const cached = printingMonitorRecentPlatesCacheRef.current.get(printingMonitorRecentPlatesCacheKey);
        printingMonitorRecentPlatesCacheRef.current.set(printingMonitorRecentPlatesCacheKey, {
          plates: cached?.plates ?? printingMonitorRecentPlatesRef.current,
          selectedPlateId: cached?.selectedPlateId ?? printingMonitorSelectedPlateIdRef.current,
          error: message,
        });
      }
      setPrintingMonitorDebugState((previous) => ({
        ...previous,
        plates: {
          requestedAtEpochMs: Date.now(),
          request: requestPayload,
          httpStatus: null,
          rawPayload: null,
          parsedPayload: null,
          error: message,
        },
      }));
    } finally {
      if (requestId !== printingMonitorRecentPlatesRequestIdRef.current) return;
      setIsPrintingMonitorRecentPlatesLoading(false);
    }
  }, [
    monitoringDevice,
    printingMonitorModalOpen,
    printingMonitorPlateId,
    printingMonitorPlatesStoragePath,
    printingMonitorRecentPlatesCacheKey,
    printingMonitoringAdapter,
  ]);

  const handlePrintingMonitorStoragePathChange = React.useCallback((nextPath: '/local/' | '/usb/') => {
    if (nextPath === printingMonitorPlatesStoragePath) return;

    // Switch immediately and hydrate from per-device cache (if available) while a fresh fetch runs.
    printingMonitorRecentPlatesRequestIdRef.current += 1;
    setIsPrintingMonitorRecentPlatesLoading(true);
    setPrintingMonitorPlatesStoragePath(nextPath);
  }, [printingMonitorPlatesStoragePath]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) return;

    printingMonitorRecentPlatesRequestIdRef.current += 1;

    if (!printingMonitorRecentPlatesCacheKey) {
      setPrintingMonitorRecentPlates([]);
      setPrintingMonitorRecentPlatesError(null);
      setPrintingMonitorSelectedPlateId(null);
      return;
    }

    const cached = printingMonitorRecentPlatesCacheRef.current.get(printingMonitorRecentPlatesCacheKey);
    if (!cached) {
      setPrintingMonitorRecentPlates([]);
      setPrintingMonitorRecentPlatesError(null);
      setPrintingMonitorSelectedPlateId(null);
      return;
    }

    setPrintingMonitorRecentPlates(cached.plates);
    setPrintingMonitorRecentPlatesError(cached.error);
    setPrintingMonitorSelectedPlateId(cached.selectedPlateId);
  }, [printingMonitorModalOpen, printingMonitorRecentPlatesCacheKey]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) {
      printingMonitorRecentPlatesRequestIdRef.current += 1;
      setIsPrintingMonitorRecentPlatesLoading(false);
      return;
    }

    void refreshPrintingMonitorRecentPlates();
  }, [printingMonitorModalOpen, refreshPrintingMonitorRecentPlates]);

  React.useLayoutEffect(() => {
    const webcamSection = printingMonitorWebcamSectionRef.current;
    const clearSizing = () => {
      webcamSection?.style.removeProperty('height');
      webcamSection?.style.removeProperty('max-height');
    };

    if (
      !printingMonitorModalOpen
      || printingMonitorViewMode !== 'detail'
      || !printingMonitorUsesTwoColumnDetailLayout
      || !printingMonitorHasCamera
    ) {
      clearSizing();
      return;
    }

    if (printingMonitorDetailWebcamExpanded) {
      const cachedHeightPx = printingMonitorWebcamFollowerHeightPxRef.current;
      if (cachedHeightPx && cachedHeightPx > 0 && webcamSection) {
        webcamSection.style.height = `${cachedHeightPx}px`;
        webcamSection.style.maxHeight = `${cachedHeightPx}px`;
      } else {
        clearSizing();
      }
      return;
    }

    let resizeObserver: ResizeObserver | null = null;
    let rafId: number | null = null;

    const applyFollowerHeight = () => {
      const leftColumn = printingMonitorLeftColumnRef.current;
      const rightColumn = printingMonitorWebcamSectionRef.current;
      if (!leftColumn || !rightColumn) return;

      const measured = Math.max(0, Math.round(leftColumn.getBoundingClientRect().height));
      if (measured <= 0) return;

      printingMonitorWebcamFollowerHeightPxRef.current = measured;
      rightColumn.style.height = `${measured}px`;
      rightColumn.style.maxHeight = `${measured}px`;
    };

    const bind = () => {
      const leftColumn = printingMonitorLeftColumnRef.current;
      if (!leftColumn) {
        rafId = window.requestAnimationFrame(bind);
        return;
      }

      applyFollowerHeight();
      resizeObserver = new ResizeObserver(() => {
        applyFollowerHeight();
      });
      resizeObserver.observe(leftColumn);
      window.addEventListener('resize', applyFollowerHeight);
    };

    bind();

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener('resize', applyFollowerHeight);
      clearSizing();
    };
  }, [
    printingMonitorHasCamera,
    printingMonitorDetailWebcamExpanded,
    printingMonitorModalOpen,
    printingMonitorUsesTwoColumnDetailLayout,
    printingMonitorViewMode,
  ]);

  React.useEffect(() => {
    if (printingMonitorCanExpandWebcam) return;
    setPrintingMonitorWebcamExpanded(false);
  }, [printingMonitorCanExpandWebcam]);

  React.useEffect(() => {
    if (printingMonitorPlateId == null) return;
    setPrintingMonitorSelectedPlateId((previous) => previous ?? printingMonitorPlateId);
  }, [printingMonitorPlateId]);

  React.useEffect(() => {
    if (!printingMonitorHasCamera) {
      setPrintingMonitorWebcamInfo(null);
      setPrintingMonitorWebcamLoadError(null);
      setIsPrintingMonitorWebcamLoaded(false);
      setPrintingMonitorWebcamAspectRatio(null);
      return;
    }

    const canResolveWebcam = Boolean(
      printingMonitorModalOpen
      && monitoringDeviceId
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations,
    );

    if (!canResolveWebcam) return;

    const host = monitoringDeviceHost;
    const port = monitoringDevicePort;
    if (!host) return;
    const webcamOperation = printingMonitoringAdapter.operations?.webcamInfo;

    if (!webcamOperation || webcamOperation.trim().length === 0) {
      setPrintingMonitorWebcamInfo({
        available: false,
        streamUrl: null,
        snapshotUrl: null,
        message: 'Webcam operation is not configured for this plugin.',
      });
      setPrintingMonitorDebugState((previous) => ({
        ...previous,
        webcam: {
          requestedAtEpochMs: Date.now(),
          request: {
            pluginId: printingMonitoringAdapter.pluginId,
            operation: webcamOperation ?? null,
            ipAddress: host,
            port,
          },
          httpStatus: null,
          rawPayload: null,
          parsedPayload: null,
          error: 'Webcam operation is not configured for this plugin.',
        },
      }));
      return;
    }

    let cancelled = false;
    const pollWebcamInfo = async () => {
      if (cancelled || printingMonitorWebcamRequestInFlightRef.current) return;
      if (printingMonitorWebcamAutoPollBlockedRef.current) return;

      const now = Date.now();
      if (printingMonitorWebcamBusyUntilEpochMsRef.current > now) {
        return;
      }

      printingMonitorWebcamRequestInFlightRef.current = true;

      const requestPayload = {
        pluginId: printingMonitoringAdapter.pluginId,
        operation: webcamOperation,
        ipAddress: host,
        port,
        mainboardId: monitoringDeviceMainboardId,
      };

      try {
        const requestStartedAt = Date.now();
        const response = await pluginNetworkFetch(requestPayload);

        const payload = await readJsonObject(response);
        if (cancelled) return;
        const parsed = printingMonitoringAdapter.parseWebcamInfoPayload(payload, host, port);
        const elapsedMs = Date.now() - requestStartedAt;

        const parsedMessage = String(parsed?.message ?? '').toLowerCase();
        const payloadMessage = (readStringField(payload, 'message') ?? '').toLowerCase();
        const ack = readNumberField(payload, 'ack');
        const timedOut = parsedMessage.includes('timed out')
          || payloadMessage.includes('timed out')
          || parsedMessage.includes('no-response')
          || payloadMessage.includes('no-response')
          || ack === -1;
        const streamLimitBusy = parsedMessage.includes('stream limit') || parsedMessage.includes('simultaneous');
        const pluginFailure = !response.ok || payload?.ok === false;
        let timeoutCircuitBreakerTripped = false;
        let timeoutCount = printingMonitorWebcamConsecutiveTimeoutsRef.current;

        if (streamLimitBusy) {
          printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
          printingMonitorWebcamAutoPollBlockedRef.current = true;
          printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
        } else if (timedOut) {
          timeoutCount += 1;
          printingMonitorWebcamConsecutiveTimeoutsRef.current = timeoutCount;

          if (timeoutCount >= printingMonitorWebcamMaxConsecutiveTimeouts) {
            timeoutCircuitBreakerTripped = true;
            printingMonitorWebcamAutoPollBlockedRef.current = true;
            printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
          } else {
            printingMonitorWebcamBusyUntilEpochMsRef.current = Date.now() + printingMonitorWebcamTimeoutCooldownMs;
          }
        } else if (pluginFailure) {
          printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
          printingMonitorWebcamBusyUntilEpochMsRef.current = Date.now() + printingMonitorWebcamFailureCooldownMs;
        } else {
          printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
          printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
        }

        const finalParsed: PrinterMonitoringWebcamInfo = timeoutCircuitBreakerTripped
          ? {
              available: false,
              streamUrl: null,
              snapshotUrl: null,
              message: `Webcam timed out ${timeoutCount} times in a row. Auto-retries are paused to prevent request spam. Click Retry Webcam to try again.`,
            }
          : parsed;

        if (!response.ok || timedOut || payload?.ok === false) {
          console.warn('[Monitor/Webcam] Request warning', {
            requestPayload,
            httpStatus: response.status,
            elapsedMs,
            timedOut,
            streamLimitBusy,
            timeoutCount,
            timeoutCircuitBreakerTripped,
            ack,
            cooldownUntilEpochMs: printingMonitorWebcamBusyUntilEpochMsRef.current,
            payload,
            parsed,
          });
        }

        setPrintingMonitorWebcamInfo(finalParsed);
        setPrintingMonitorDebugState((previous) => ({
          ...previous,
          webcam: {
            requestedAtEpochMs: Date.now(),
            request: requestPayload,
            httpStatus: response.status,
            rawPayload: payload,
            parsedPayload: finalParsed,
            error: null,
          },
        }));
      } catch (error) {
        if (cancelled) return;
        let timeoutCount = printingMonitorWebcamConsecutiveTimeoutsRef.current + 1;
        printingMonitorWebcamConsecutiveTimeoutsRef.current = timeoutCount;

        const timeoutCircuitBreakerTripped = timeoutCount >= printingMonitorWebcamMaxConsecutiveTimeouts;
        if (timeoutCircuitBreakerTripped) {
          printingMonitorWebcamAutoPollBlockedRef.current = true;
          printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
        } else {
          printingMonitorWebcamBusyUntilEpochMsRef.current = Date.now() + printingMonitorWebcamTimeoutCooldownMs;
        }

        const message = timeoutCircuitBreakerTripped
          ? `Webcam timed out ${timeoutCount} times in a row. Auto-retries are paused to prevent request spam. Click Retry Webcam to try again.`
          : (error instanceof Error ? error.message : 'Unable to resolve webcam feed details.');

        console.warn('[Monitor/Webcam] Request failed', {
          requestPayload,
          error: message,
          timeoutCount,
          timeoutCircuitBreakerTripped,
          cooldownUntilEpochMs: printingMonitorWebcamBusyUntilEpochMsRef.current,
        });
        setPrintingMonitorWebcamInfo({
          available: false,
          streamUrl: null,
          snapshotUrl: null,
          message,
        });
        setPrintingMonitorDebugState((previous) => ({
          ...previous,
          webcam: {
            requestedAtEpochMs: Date.now(),
            request: requestPayload,
            httpStatus: null,
            rawPayload: null,
            parsedPayload: null,
            error: message,
          },
        }));
      } finally {
        printingMonitorWebcamRequestInFlightRef.current = false;
      }
    };

    void pollWebcamInfo();
    const intervalId = window.setInterval(() => {
      void pollWebcamInfo();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      printingMonitorWebcamRequestInFlightRef.current = false;
    };
  }, [
    monitoringDeviceHost,
    monitoringDeviceId,
    monitoringDeviceMainboardId,
    monitoringDevicePort,
    printingMonitorHasCamera,
    printingMonitoringAdapter,
    printingMonitorModalOpen,
    printingMonitorWebcamRefreshNonce,
  ]);

  React.useEffect(() => {
    if (!printingMonitorHasActivePrint || !printingMonitorThumbnailUrl || !printingMonitorThumbnailCacheKey) {
      setPrintingMonitorThumbnailDisplayUrl(null);
      setIsPrintingMonitorThumbnailLoaded(false);
      return;
    }

    const cached = printingMonitorThumbnailCacheRef.current.get(printingMonitorThumbnailCacheKey) ?? null;
    if (cached) {
      setPrintingMonitorThumbnailDisplayUrl(cached);
      setIsPrintingMonitorThumbnailLoaded(true);
    } else {
      setPrintingMonitorThumbnailDisplayUrl(null);
      setIsPrintingMonitorThumbnailLoaded(false);
    }

    let cancelled = false;
    const probeImage = new Image();
    probeImage.decoding = 'async';
    probeImage.onload = () => {
      if (cancelled) return;
      printingMonitorThumbnailCacheRef.current.set(printingMonitorThumbnailCacheKey, printingMonitorThumbnailUrl);
      setPrintingMonitorThumbnailDisplayUrl(printingMonitorThumbnailUrl);
      setIsPrintingMonitorThumbnailLoaded(true);
    };
    probeImage.onerror = () => {
      if (cancelled) return;
      const fallback = printingMonitorThumbnailCacheRef.current.get(printingMonitorThumbnailCacheKey) ?? null;
      setPrintingMonitorThumbnailDisplayUrl(fallback);
      setIsPrintingMonitorThumbnailLoaded(Boolean(fallback));
    };
    probeImage.src = printingMonitorThumbnailUrl;

    return () => {
      cancelled = true;
    };
  }, [printingMonitorHasActivePrint, printingMonitorThumbnailCacheKey, printingMonitorThumbnailUrl]);

  React.useEffect(() => {
    printingMonitorWebcamReadinessTokenRef.current += 1;
    if (printingMonitorWebcamReadinessTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorWebcamReadinessTimeoutRef.current);
      printingMonitorWebcamReadinessTimeoutRef.current = null;
    }
    setIsPrintingMonitorWebcamLoaded(false);
    setPrintingMonitorWebcamLoadError(null);
  }, [printingMonitorWebcamUrl]);

  React.useEffect(() => {
    setPrintingMonitorWebcamAspectRatio(null);
  }, [printingMonitorWebcamUrl]);

  const cancelPrintingMonitorWebcamReadinessCheck = React.useCallback(() => {
    printingMonitorWebcamReadinessTokenRef.current += 1;
    if (printingMonitorWebcamReadinessTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorWebcamReadinessTimeoutRef.current);
      printingMonitorWebcamReadinessTimeoutRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) return;

    cancelPrintingMonitorWebcamReadinessCheck();
    if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
      printingMonitorRelayAutoRetryTimeoutRef.current = null;
    }

    printingMonitorRelayAutoRetryCountRef.current = 0;
    printingMonitorWebcamAutoPollBlockedRef.current = false;
    printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
    printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;

    setPrintingMonitorRelayBaseWsUrl(null);
    setPrintingMonitorRelaySetupError(null);
    setPrintingMonitorRelayDebugTransport(null);
    setPrintingMonitorRelayReclaimDebug(null);
    setPrintingMonitorWebcamInfo(null);
    setPrintingMonitorWebcamLoadError(null);
    setIsPrintingMonitorWebcamLoaded(false);
    setPrintingMonitorWebcamAspectRatio(null);
  }, [cancelPrintingMonitorWebcamReadinessCheck, monitoringDeviceId, printingMonitorModalOpen]);

  const schedulePrintingMonitorMjpegReadinessCheck = React.useCallback((target: HTMLImageElement) => {
    cancelPrintingMonitorWebcamReadinessCheck();

    const readinessToken = printingMonitorWebcamReadinessTokenRef.current;
    const sampleIntervalMs = 120;
    const maxSamples = 36;
    const minFrameDimensionPx = 64;
    const minRenderedDimensionPx = 16;
    let sampleCount = 0;
    let stableDimensionSamples = 0;
    let previousDimensionSignature: string | null = null;

    const evaluateReadiness = () => {
      if (printingMonitorWebcamReadinessTokenRef.current !== readinessToken) return;

      const naturalW = Math.round(target.naturalWidth || 0);
      const naturalH = Math.round(target.naturalHeight || 0);
      const hasDimensions = Number.isFinite(naturalW)
        && Number.isFinite(naturalH)
        && naturalW > 0
        && naturalH > 0;

      let normalizedRatio: number | null = null;
      if (hasDimensions) {
        normalizedRatio = normalizePrintingMonitorWebcamAspectRatio(naturalW / naturalH);
        if (normalizedRatio != null) {
          setPrintingMonitorWebcamAspectRatio((previous) => {
            if (previous != null && Math.abs(previous - normalizedRatio!) < 0.001) return previous;
            return normalizedRatio;
          });
        }

        const signature = `${naturalW}x${naturalH}`;
        if (signature === previousDimensionSignature) {
          stableDimensionSamples += 1;
        } else {
          previousDimensionSignature = signature;
          stableDimensionSamples = 0;
        }
      }

      const hasUsableFrameDimensions = hasDimensions
        && naturalW >= minFrameDimensionPx
        && naturalH >= minFrameDimensionPx;
      const hasRenderableViewport = target.clientWidth >= minRenderedDimensionPx
        && target.clientHeight >= minRenderedDimensionPx;
      const ready = normalizedRatio != null
        && hasRenderableViewport
        && (hasUsableFrameDimensions ? stableDimensionSamples >= 1 : stableDimensionSamples >= 2);

      if (ready) {
        setIsPrintingMonitorWebcamLoaded(true);
        setPrintingMonitorWebcamLoadError(null);
        printingMonitorWebcamReadinessTimeoutRef.current = null;
        return;
      }

      sampleCount += 1;
      if (sampleCount >= maxSamples) {
        if (normalizedRatio != null && hasDimensions && hasRenderableViewport) {
          setIsPrintingMonitorWebcamLoaded(true);
          setPrintingMonitorWebcamLoadError(null);
        }
        printingMonitorWebcamReadinessTimeoutRef.current = null;
        return;
      }

      printingMonitorWebcamReadinessTimeoutRef.current = window.setTimeout(evaluateReadiness, sampleIntervalMs);
    };

    evaluateReadiness();
  }, [cancelPrintingMonitorWebcamReadinessCheck]);

  React.useEffect(() => {
    return () => {
      cancelPrintingMonitorWebcamReadinessCheck();
    };
  }, [cancelPrintingMonitorWebcamReadinessCheck]);

  React.useLayoutEffect(() => {
    if (!printingMonitorModalOpen) return;
    const focusDeviceId = printingMonitorStartFocusDeviceIdRef.current;
    if (focusDeviceId && monitorSelectableDevices.some((device) => device.id === focusDeviceId)) {
      setPrintingMonitorDeviceId(focusDeviceId);
      setPrintingMonitorViewMode('detail');
      return;
    }
    setPrintingMonitorViewMode(monitorSelectableDevices.length > 1 ? 'dashboard' : 'detail');
  }, [printingMonitorModalOpen, monitorSelectableDevices.length]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) {
      printingMonitorStartFocusDeviceIdRef.current = null;
      setIsPrintingMonitorPrinterMenuOpen(false);
      setPrintingMonitorViewMode('detail');
      setPrintingMonitorDashboardSnapshots({});
      setIsPrintingMonitorDashboardRefreshing(false);
      setIsPrintingMonitorWebcamResetBusy(false);
      return;
    }

    if (monitorSelectableDevices.length === 0) {
      setPrintingMonitorDeviceId(null);
      return;
    }

    setPrintingMonitorDeviceId((previous) => {
      const focusDeviceId = printingMonitorStartFocusDeviceIdRef.current;
      if (focusDeviceId && monitorSelectableDevices.some((device) => device.id === focusDeviceId)) {
        return focusDeviceId;
      }

      if (previous && monitorSelectableDevices.some((device) => device.id === previous)) {
        return previous;
      }

      if (activePrinterProfile?.activeNetworkDeviceId && monitorSelectableDevices.some((device) => device.id === activePrinterProfile.activeNetworkDeviceId)) {
        return activePrinterProfile.activeNetworkDeviceId;
      }

      if (printingTargetDevice?.id && monitorSelectableDevices.some((device) => device.id === printingTargetDevice.id)) {
        return printingTargetDevice.id;
      }

      return monitorSelectableDevices[0]?.id ?? null;
    });
  }, [activePrinterProfile?.activeNetworkDeviceId, monitorSelectableDevices, printingMonitorModalOpen, printingTargetDevice?.id]);

  const triggerPrintingMonitorWebcamRetry = React.useCallback(() => {
    cancelPrintingMonitorWebcamReadinessCheck();
    if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
      printingMonitorRelayAutoRetryTimeoutRef.current = null;
    }
    printingMonitorWebcamAutoPollBlockedRef.current = false;
    printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
    printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
    setPrintingMonitorWebcamLoadError(null);
    setIsPrintingMonitorWebcamLoaded(false);
    setPrintingMonitorWebcamRefreshNonce((previous) => previous + 1);
  }, [cancelPrintingMonitorWebcamReadinessCheck]);

  React.useEffect(() => {
    printingMonitorRelayAutoRetryCountRef.current = 0;
    if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
      printingMonitorRelayAutoRetryTimeoutRef.current = null;
    }
  }, [printingMonitorWebcamUrl]);

  React.useEffect(() => {
    return () => {
      if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
        window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
        printingMonitorRelayAutoRetryTimeoutRef.current = null;
      }
    };
  }, []);

  const handleSavePrintingMonitorWebcamSnapshot = React.useCallback(async () => {
    if (isPrintingMonitorWebcamSnapshotSaving) return;

    const viewport = printingMonitorWebcamViewportRef.current;
    if (!viewport) {
      setPrintingMonitorError('Webcam view is not ready for snapshot capture.');
      return;
    }

    const renderedCanvas = viewport.querySelector('canvas');
    const renderedImage = viewport.querySelector('img');
    if (!renderedCanvas && !renderedImage) {
      setPrintingMonitorError('No webcam frame is available to capture.');
      return;
    }

    setIsPrintingMonitorWebcamSnapshotSaving(true);

    try {
      let blob: Blob | null = null;
      const snapshotSourceCandidates = Array.from(new Set([
        renderedImage?.currentSrc,
        renderedImage?.src,
        printingMonitorWebcamInfo?.snapshotUrl,
        printingMonitorWebcamInfo?.streamUrl,
        printingMonitorWebcamUrl,
      ]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim())));

      if (renderedCanvas) {
        try {
          blob = await new Promise<Blob | null>((resolve, reject) => {
            try {
              renderedCanvas.toBlob((nextBlob) => resolve(nextBlob), 'image/png');
            } catch (canvasError) {
              reject(canvasError);
            }
          });
        } catch (canvasError) {
          const message = canvasError instanceof Error ? canvasError.message : String(canvasError ?? '');
          if (!/tainted canvases may not be exported/i.test(message)) {
            throw canvasError;
          }
        }
      }

      if (!blob) {
        let snapshotFetchError: unknown = null;

        for (const sourceUrl of snapshotSourceCandidates) {
          const isDataOrBlobUrl = /^data:|^blob:/i.test(sourceUrl);
          const isHttpUrl = /^https?:\/\//i.test(sourceUrl);
          if (!isDataOrBlobUrl && !isHttpUrl) continue;

          const requestUrl = isDataOrBlobUrl
            ? sourceUrl
            : `/api/webcam-snapshot?url=${encodeURIComponent(sourceUrl)}`;

          try {
            const response = await fetch(requestUrl, {
              method: 'GET',
              cache: 'no-store',
            });

            if (!response.ok) {
              const payload = await readJsonObject(response);
              const payloadError = readStringField(payload, 'error');
              const reason = typeof payloadError === 'string' && payloadError.trim().length > 0
                ? payloadError.trim()
                : `HTTP ${response.status}`;
              throw new Error(reason);
            }

            const nextBlob = await response.blob();
            if (nextBlob.size <= 0) {
              throw new Error('Snapshot source returned empty image data.');
            }

            blob = nextBlob;
            break;
          } catch (fetchError) {
            snapshotFetchError = fetchError;
          }
        }

        if (!blob && snapshotFetchError) {
          throw snapshotFetchError;
        }
      }

      if (!blob) {
        throw new Error('Unable to capture webcam snapshot from the current feed.');
      }

      const bytes = new Uint8Array(await blob.arrayBuffer());
      const baseNameRaw = (
        monitoringDevice?.displayName
        || monitoringDevice?.hostName
        || monitoringDevice?.ipAddress
        || 'printer'
      ).trim();
      const baseName = baseNameRaw.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'printer';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `webcam_${baseName}_${stamp}.png`;

      try {
        await savePrintArtifactWithNativeDialog(bytes, filename);
      } catch {
        const objectUrl = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.rel = 'noopener';
        anchor.style.display = 'none';
        document.body?.appendChild(anchor);
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }

      setPrintingMonitorActionStatus('Webcam snapshot saved.');
      setPrintingMonitorError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save webcam snapshot.';
      setPrintingMonitorError(message);
    } finally {
      setIsPrintingMonitorWebcamSnapshotSaving(false);
    }
  }, [
    isPrintingMonitorWebcamSnapshotSaving,
    monitoringDevice?.displayName,
    monitoringDevice?.hostName,
    monitoringDevice?.ipAddress,
    printingMonitorWebcamInfo?.snapshotUrl,
    printingMonitorWebcamInfo?.streamUrl,
    printingMonitorWebcamUrl,
  ]);

  // Flush webcam polling/circuit-breaker state on monitor close.
  const flushMonitors = React.useCallback(async () => {
    cancelPrintingMonitorWebcamReadinessCheck();
    if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
      window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
      printingMonitorRelayAutoRetryTimeoutRef.current = null;
    }
    printingMonitorRelayAutoRetryCountRef.current = 0;
    // Reset webcam polling state
    printingMonitorWebcamAutoPollBlockedRef.current = false;
    printingMonitorWebcamBusyUntilEpochMsRef.current = 0;
    printingMonitorWebcamRequestInFlightRef.current = false;
    printingMonitorWebcamConsecutiveTimeoutsRef.current = 0;
    setPrintingMonitorWebcamLoadError(null);
    setIsPrintingMonitorWebcamLoaded(false);
    setPrintingMonitorWebcamAspectRatio(null);
    setPrintingMonitorWebcamRefreshNonce((previous) => previous + 1);
  }, [cancelPrintingMonitorWebcamReadinessCheck]);

  const handleResetPrintingMonitorWebcamStreamSlot = React.useCallback(async () => {
    if (isPrintingMonitorWebcamResetBusy) return;

    const host = monitoringDeviceHost;
    const port = monitoringDevicePort;
    if (!printingMonitorModalOpen || !monitoringDeviceId || !host) {
      setPrintingMonitorWebcamInfo({
        available: false,
        streamUrl: null,
        snapshotUrl: null,
        message: 'No printer IP available to reset webcam stream.',
      });
      return;
    }

    setIsPrintingMonitorWebcamResetBusy(true);

    try {
      triggerPrintingMonitorWebcamRetry();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Failed to reset webcam stream.';
      setPrintingMonitorWebcamInfo({
        available: false,
        streamUrl: null,
        snapshotUrl: null,
        message,
      });
    } finally {
      setIsPrintingMonitorWebcamResetBusy(false);
    }
  }, [
    isPrintingMonitorWebcamResetBusy,
    monitoringDeviceHost,
    monitoringDeviceId,
    printingMonitorModalOpen,
    triggerPrintingMonitorWebcamRetry,
  ]);

  // Manage printer monitor webcam lifecycle: disable when monitor closes.
  React.useEffect(() => {
    if (!printingMonitorModalOpen || !monitoringDeviceId) {
      // Monitor closed or no device: disable the stream
      void flushMonitors();
      return;
    }

    // Cleanup when monitor closes
    return () => {
      void flushMonitors();
    };
  }, [printingMonitorModalOpen, monitoringDeviceId, flushMonitors]);

  React.useEffect(() => {
    const canPollDashboard = Boolean(
      printingMonitorModalOpen
      && printingMonitorViewMode === 'dashboard'
      && printingMonitoringAdapter.available
      && printingMonitoringAdapter.pluginId
      && printingMonitoringAdapter.operations?.status,
    );

    if (!canPollDashboard) {
      setIsPrintingMonitorDashboardRefreshing(false);
      return;
    }

    if (dashboardOnlineMonitorDevices.length === 0) {
      setPrintingMonitorDashboardSnapshots({});
      setIsPrintingMonitorDashboardRefreshing(false);
      return;
    }

    let cancelled = false;

    const pollAll = async () => {
      if (cancelled) return;
      setIsPrintingMonitorDashboardRefreshing(true);

      const entries = await Promise.all(
        dashboardOnlineMonitorDevices.map(async (device) => {
          const host = (device.ipAddress || '').trim();
          const port = device.port || 80;
          if (!host) return [device.id, null] as const;

          try {
            const response = await pluginNetworkFetch({
              pluginId: printingMonitoringAdapter.pluginId!,
              operation: printingMonitoringAdapter.operations!.status,
              ipAddress: host,
              port,
            });

            const payload = await readJsonObject(response);
            const snapshot = printingMonitoringAdapter.parseStatusPayload(payload, `${host}:${port}`);
            return [device.id, snapshot] as const;
          } catch {
            return [device.id, null] as const;
          }
        }),
      );

      if (cancelled) return;

      const next: Record<string, PrinterMonitoringSnapshot | null> = {};
      for (const [deviceId, snapshot] of entries) {
        next[deviceId] = snapshot;
      }
      setPrintingMonitorDashboardSnapshots(next);
      setIsPrintingMonitorDashboardRefreshing(false);
    };

    void pollAll();

    const intervalId = window.setInterval(() => {
      void pollAll();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [
    dashboardOnlineMonitorDevices,
    printingMonitorModalOpen,
    printingMonitoringAdapter,
    printingMonitorViewMode,
  ]);

  React.useEffect(() => {
    if (!isPrintingMonitorPrinterMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (printingMonitorPrinterMenuRef.current?.contains(target)) return;
      setIsPrintingMonitorPrinterMenuOpen(false);
    };

    window.addEventListener('mousedown', handlePointerDown);

    let wasEscapePressed = false;
    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isEscapePressed = active.has('escape');
      if (isEscapePressed && !wasEscapePressed) {
        setIsPrintingMonitorPrinterMenuOpen(false);
      }
      wasEscapePressed = isEscapePressed;
    });

    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      unsubscribe();
    };
  }, [isPrintingMonitorPrinterMenuOpen]);

  React.useEffect(() => {
    setIsPrintingMonitorPrinterThumbnailFailed(false);
  }, [activePrinterProfile?.id, activePrinterProfile?.imageDataUrl]);

  React.useEffect(() => {
    if (!printingMonitorModalOpen) {
      setPrintingMonitorLastStatusSuccessAtMs(null);
      setIsPrintingMonitorStatusRequestInFlight(false);
      setPrintingMonitorActionBusy(null);
      setPrintingMonitorControlPendingAction(null);
      setPrintingMonitorActionStatus(null);
      setPrintingMonitorPendingConfirmation(null);
      setIsPrintingMonitorDebugOpen(false);
      setIsPrintingMonitorRtspDebugOpen(false);
      setPrintingMonitorDebugCopyState('idle');
      setPrintingMonitorError(null);
    }
  }, [printingMonitorModalOpen, setPrintingMonitorError]);

  React.useEffect(() => {
    if (!printingMonitorControlPendingAction) return;

    const timeoutId = window.setTimeout(() => {
      setPrintingMonitorControlPendingAction(null);
    }, 20_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [printingMonitorControlPendingAction]);

  React.useEffect(() => {
    if (!printingMonitorControlPendingAction || !printingMonitorSnapshot) return;

    const settled = (() => {
      if (printingMonitorControlPendingAction === 'pause') {
        return printingMonitorSnapshot.isPaused || !printingMonitorHasActivePrint;
      }
      if (printingMonitorControlPendingAction === 'resume') {
        return !printingMonitorSnapshot.isPaused && !printingMonitorIsPauseTransition;
      }
      if (printingMonitorControlPendingAction === 'cancel') {
        return !printingMonitorSnapshot.isPrinting
          && !printingMonitorSnapshot.isPaused
          && !printingMonitorIsCancelTransition;
      }
      return !printingMonitorSnapshot.isPrinting
        && !printingMonitorSnapshot.isPaused
        && !printingMonitorIsCancelTransition;
    })();

    if (settled) {
      setPrintingMonitorControlPendingAction(null);
    }
  }, [
    printingMonitorControlPendingAction,
    printingMonitorHasActivePrint,
    printingMonitorIsCancelTransition,
    printingMonitorIsPauseTransition,
    printingMonitorSnapshot,
  ]);

  const handleDownloadPrintArtifact = React.useCallback(async () => {
    if (!printingArtifact) return;

    const nativeTempPath = printingArtifact.nativeTempPath;

    if (nativeTempPath && nativeTempPath.trim().length > 0) {
      try {
        await savePrintArtifactPathWithNativeDialog(nativeTempPath, printingArtifact.outputName);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        const cancelled = message.toLowerCase().includes('cancel');
        if (!cancelled) {
          console.warn('[Printing] Native path save dialog failed, attempting byte fallback.', error);
        }
      }
    }

    try {
      const bytes = printingArtifact.blob
        ? new Uint8Array(await printingArtifact.blob.arrayBuffer())
        : (nativeTempPath ? await readPrintArtifactBytesFromPath(nativeTempPath) : null);
      if (!bytes) {
        throw new Error('No print artifact bytes available for download.');
      }
      await savePrintArtifactWithNativeDialog(bytes, printingArtifact.outputName);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const cancelled = message.toLowerCase().includes('cancel');
      if (!cancelled) {
        console.warn('[Printing] Native save dialog failed, falling back to browser download.', error);
      }
    }

    if (!printingArtifact.blob) {
      console.warn('[Printing] Browser fallback unavailable because artifact is disk-backed only.');
      return;
    }

    const objectUrl = URL.createObjectURL(printingArtifact.blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = printingArtifact.outputName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body?.appendChild(anchor);
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }, [printingArtifact]);

  const performTopBarSaveScene = React.useCallback(async (options?: { nativePathOverride?: string | null }) => {
    const visibleModels = scene.models.filter((model) => model.visible);
    const scopeModels = visibleModels.length > 0 ? visibleModels : scene.models;
    const resolvedNativePath = options?.nativePathOverride !== undefined
      ? options.nativePathOverride
      : activeSceneFilePath;
    const resolvedSceneFilename = resolvedNativePath
      ? (getFileNameFromPath(resolvedNativePath).replace(/\.voxl$/i, '').trim() || 'Scene')
      : resolveEntirePlateExportBaseName(scene.models);

    // Capture a thumbnail from the live scene canvas — same path as the export panel.
    let exportThumbnailPng: Uint8Array | null = null;
    try {
      // Temporarily disable cross-section clipping while taking the scene thumbnail.
      setIsTemporarilyDisablingCrossSectionForThumbnail(true);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const runCapture = exportThumbnailCaptureRunnerRef.current;
      if (runCapture) exportThumbnailPng = await runCapture();
    } catch {
      // Non-fatal: save proceeds without thumbnail.
    } finally {
      setIsTemporarilyDisablingCrossSectionForThumbnail(false);
    }

    const savedPath = await ExportManager.exportScene(
      null,
      supportsRef.current || null,
      {
        filename: resolvedSceneFilename,
        format: 'voxl',
        binary: true,
        separateFiles: false,
        includeRaft: false,
        includeSupports: true,
        includeModel: true,
      },
      {
        models: scopeModels,
        activeModelId: scene.activeModelId,
        selectedModelIds: scene.selectedModelIds,
        exportThumbnailPng: exportThumbnailPng ?? undefined,
      },
      {
        nativePath: resolvedNativePath,
      },
    );
    const nextActiveScenePath = normalizeActiveVoxlScenePath(savedPath);
    if (nextActiveScenePath) {
      setActiveSceneFilePath(nextActiveScenePath);
      setLoadedSceneSaveSource({
        name: getFileNameFromPath(nextActiveScenePath),
        path: nextActiveScenePath,
      });
      // Once a scene has been successfully saved to a concrete VOXL path,
      // future Ctrl+S should keep saving in-place without prompting again.
      preferredOverwriteScenePathRef.current = nextActiveScenePath;
    }
    if (savedPath) {
      setExportSuccessToast({ id: Date.now(), path: savedPath });
      setIsExportSuccessToastVisible(true);
      if (exportSuccessToastFadeTimeoutRef.current !== null) {
        window.clearTimeout(exportSuccessToastFadeTimeoutRef.current);
      }
      exportSuccessToastFadeTimeoutRef.current = window.setTimeout(() => {
        setIsExportSuccessToastVisible(false);
        exportSuccessToastFadeTimeoutRef.current = null;
      }, 3800);

      markSceneSaveBaseline();
      void clearAutosave();
    }

    return savedPath;
  }, [activeSceneFilePath, clearAutosave, markSceneSaveBaseline, scene.activeModelId, scene.models, scene.selectedModelIds]);

  const handleAutosaveRestore = React.useCallback(async () => {
    const recoverySnapshot = autosaveRecovery;
    setAutosaveRecovery(null);
    setNativePickerPreparationState({
      active: true,
      label: 'Loading Scene…',
      detail: 'Reading autosaved scene…',
      progress: null,
    });

    // Let React commit the modal dismissal/loading UI before native file IO begins.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const bytes = await invoke<ArrayBuffer>('scene_autosave_read_voxl_bytes');
      const uint8 = new Uint8Array(bytes);
      if (uint8.byteLength === 0) {
        throw new Error('Autosaved VOXL file is empty.');
      }
      const file = new File([uint8], 'autosave.voxl', { type: 'application/octet-stream' });
      suppressSceneAutosave(60_000);
      setNativePickerPreparationState({
        active: false,
        label: '',
        detail: '',
        progress: null,
      });
      const restored = await importSceneFile(file, { suppressRecentTracking: true, suppressPlacementPrompt: true, suppressRepair: true });
      if (restored) {
        await clearAutosave();
      } else if (recoverySnapshot) {
        console.warn('[Autosave] Restore failed; keeping recovery prompt available.');
        setAutosaveRecovery(recoverySnapshot);
      }
    } catch (error) {
      console.error('[Autosave] Failed to restore autosaved scene.', error);
      if (recoverySnapshot) {
        setAutosaveRecovery(recoverySnapshot);
      }
    } finally {
      setNativePickerPreparationState({
        active: false,
        label: '',
        detail: '',
        progress: null,
      });
    }
  }, [autosaveRecovery, clearAutosave, importSceneFile]);

  const handleAutosaveDiscard = React.useCallback(async () => {
    setAutosaveRecovery(null);
    await clearAutosave();
  }, [clearAutosave]);

  const queueTopBarSaveScene = React.useCallback((nativePathOverride?: string | null) => {
    queuedSceneSavePathOverrideRef.current = nativePathOverride;

    if (typeof window === 'undefined') {
      if (sceneSaveInFlightRef.current) {
        sceneSaveQueuedRef.current = true;
        setIsSceneSaveInProgress(true);
        return;
      }
      sceneSaveInFlightRef.current = true;
      setIsSceneSaveInProgress(true);
      const queuedNativePathOverride = queuedSceneSavePathOverrideRef.current;
      queuedSceneSavePathOverrideRef.current = undefined;
      void performTopBarSaveScene({ nativePathOverride: queuedNativePathOverride }).finally(() => {
        sceneSaveInFlightRef.current = false;
        setIsSceneSaveInProgress(sceneSaveQueuedRef.current);
      });
      return;
    }

    if (sceneSaveInFlightRef.current) {
      sceneSaveQueuedRef.current = true;
      setIsSceneSaveInProgress(true);
      return;
    }

    const runSaveTask = () => {
      if (sceneSaveInFlightRef.current) {
        sceneSaveQueuedRef.current = true;
        return;
      }

      sceneSaveInFlightRef.current = true;
      setIsSceneSaveInProgress(true);
      const queuedNativePathOverride = queuedSceneSavePathOverrideRef.current;
      queuedSceneSavePathOverrideRef.current = undefined;
      void performTopBarSaveScene({ nativePathOverride: queuedNativePathOverride })
        .catch((error) => {
          console.error('[SceneSave] Save operation failed.', error);
        })
        .finally(() => {
          sceneSaveInFlightRef.current = false;
          if (sceneSaveQueuedRef.current) {
            sceneSaveQueuedRef.current = false;
            queueKickoff();
            setIsSceneSaveInProgress(true);
            return;
          }
          setIsSceneSaveInProgress(false);
        });
    };

    const queueKickoff = () => {
      if (sceneSaveKickoffTimerRef.current !== null) return;
      setIsSceneSaveInProgress(true);
      sceneSaveKickoffTimerRef.current = window.setTimeout(() => {
        sceneSaveKickoffTimerRef.current = null;
        runSaveTask();
      }, 0);
    };

    if (sceneSaveKickoffTimerRef.current !== null) {
      sceneSaveQueuedRef.current = true;
      return;
    }

    queueKickoff();
  }, [performTopBarSaveScene]);

  const resolveSceneSaveNativePath = React.useCallback(async (): Promise<{
    cancelled: boolean;
    nativePathOverride?: string | null;
  }> => {
    const loadedScenePath = normalizeActiveVoxlScenePath(
      activeSceneFilePath ?? loadedSceneSaveSource?.path ?? null,
    );
    const loadedSceneFileName = (() => {
      if (loadedSceneSaveSource && getFileExtension(loadedSceneSaveSource.name) === '.voxl') {
        return loadedSceneSaveSource.name;
      }
      if (loadedScenePath) {
        return getFileNameFromPath(loadedScenePath);
      }
      return null;
    })();

    if (!loadedSceneFileName) {
      return { cancelled: false, nativePathOverride: undefined };
    }

    // We know this came from a VOXL scene, but we cannot overwrite if the
    // originating native path is unavailable (e.g. recent-reopen blob cache).
    // In that case, skip the modal and go straight to Save As.
    if (!loadedScenePath) {
      preferredOverwriteScenePathRef.current = null;
      return { cancelled: false, nativePathOverride: null };
    }

    if (preferredOverwriteScenePathRef.current === loadedScenePath) {
      return { cancelled: false, nativePathOverride: loadedScenePath };
    }

    const choice = await promptSceneSaveChoice({
      fileName: loadedSceneFileName,
      scenePath: loadedScenePath,
    });
    if (choice === 'cancel') {
      return { cancelled: true };
    }

    if (choice === 'save_as') {
      preferredOverwriteScenePathRef.current = null;
      return { cancelled: false, nativePathOverride: null };
    }

    preferredOverwriteScenePathRef.current = loadedScenePath;
    return { cancelled: false, nativePathOverride: loadedScenePath };
  }, [activeSceneFilePath, loadedSceneSaveSource, promptSceneSaveChoice]);

  const saveCurrentSceneNow = React.useCallback(async (): Promise<boolean> => {
    const resolution = await resolveSceneSaveNativePath();
    if (resolution.cancelled) return false;

    const savedPath = await performTopBarSaveScene({
      nativePathOverride: resolution.nativePathOverride,
    });
    return Boolean(savedPath);
  }, [performTopBarSaveScene, resolveSceneSaveNativePath]);

  const handleTopBarSaveScene = React.useCallback(() => {
    void (async () => {
      const resolution = await resolveSceneSaveNativePath();
      if (resolution.cancelled) return;
      queueTopBarSaveScene(resolution.nativePathOverride);
    })();
  }, [queueTopBarSaveScene, resolveSceneSaveNativePath]);

  const handleTopBarSaveSceneAs = React.useCallback(() => {
    // Save As: always route through the native save dialog (a null override
    // suppresses any remembered path), skipping the overwrite/save-as choice
    // modal. A successful save re-points the scene's save target — and future
    // Ctrl+S overwrites — at the newly chosen file.
    queueTopBarSaveScene(null);
  }, [queueTopBarSaveScene]);

  React.useEffect(() => {
    if (scene.models.length !== 0) return;

    preferredOverwriteScenePathRef.current = null;
    setActiveSceneFilePath(null);
    setLoadedSceneSaveSource(null);
    setShowCloseUnsavedChangesModal(false);
    setCloseUnsavedChangesBusy('none');
    if (sceneSaveChoiceResolveRef.current) {
      sceneSaveChoiceResolveRef.current('cancel');
      sceneSaveChoiceResolveRef.current = null;
    }
    setShowSceneSaveChoiceModal(false);
    setSceneSaveChoiceFileName(null);
    setSceneSaveChoicePath(null);
    markSceneSaveBaseline();
  }, [markSceneSaveBaseline, scene.models.length]);

  React.useEffect(() => {
    return () => {
      if (sceneSaveKickoffTimerRef.current !== null) {
        window.clearTimeout(sceneSaveKickoffTimerRef.current);
        sceneSaveKickoffTimerRef.current = null;
      }
      sceneSaveQueuedRef.current = false;
      queuedSceneSavePathOverrideRef.current = undefined;
      preferredOverwriteScenePathRef.current = null;
      setIsSceneSaveInProgress(false);
    };
  }, []);

  React.useEffect(() => {
    if (!sceneAutosaveSettings.recoveryPromptEnabled) {
      setAutosaveRecovery(null);
      return;
    }
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

    let cancelled = false;
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const manifest = await invoke<{ savedAt: string; clean: boolean } | null>('scene_autosave_read_manifest');
        if (!cancelled && manifest && !manifest.clean) {
          setAutosaveRecovery({ savedAt: manifest.savedAt });
        }
      } catch {
        // Non-fatal: no autosave recovery available.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sceneAutosaveSettings.recoveryPromptEnabled]);

  const isDesktopRuntime = React.useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.location.protocol === 'tauri:'
      || window.location.protocol === 'file:'
      || window.location.hostname === 'tauri.localhost'
      || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  }, []);

  const closeDesktopWindowNow = React.useCallback(async () => {
    if (!isDesktopRuntime()) return;

    allowProgrammaticWindowCloseRef.current = true;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      allowProgrammaticWindowCloseRef.current = false;
    }
  }, [isDesktopRuntime]);

  const handleRequestProgramClose = React.useCallback(() => {
    if (hasUnsavedSceneChangesRef.current) {
      setShowCloseUnsavedChangesModal(true);
      return;
    }
    void closeDesktopWindowNow();
  }, [closeDesktopWindowNow]);

  const handleDiscardAndCloseProgram = React.useCallback(() => {
    void (async () => {
      setCloseUnsavedChangesBusy('discard_and_close');
      try {
        setShowCloseUnsavedChangesModal(false);
        await closeDesktopWindowNow();
      } finally {
        setCloseUnsavedChangesBusy('none');
      }
    })();
  }, [closeDesktopWindowNow]);

  const handleSaveAndCloseProgram = React.useCallback(() => {
    void (async () => {
      setCloseUnsavedChangesBusy('save_and_close');
      try {
        const saved = await saveCurrentSceneNow();
        if (!saved) return;
        setShowCloseUnsavedChangesModal(false);
        await closeDesktopWindowNow();
      } catch (error) {
        console.error('[SceneSave] Save-and-close failed.', error);
      } finally {
        setCloseUnsavedChangesBusy('none');
      }
    })();
  }, [closeDesktopWindowNow, saveCurrentSceneNow]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedSceneChangesRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  React.useEffect(() => {
    if (!isDesktopRuntime()) return;

    let unlisten: (() => void) | null = null;
    let disposed = false;

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        unlisten = await currentWindow.onCloseRequested((event) => {
          if (allowProgrammaticWindowCloseRef.current) {
            allowProgrammaticWindowCloseRef.current = false;
            return;
          }

          if (!hasUnsavedSceneChangesRef.current) {
            return;
          }

          event.preventDefault();
          setShowCloseUnsavedChangesModal(true);
        });

        if (disposed && unlisten) {
          unlisten();
          unlisten = null;
        }
      } catch {
        // Non-fatal in web runtime or restricted capability mode.
      }
    })();

    return () => {
      disposed = true;
      if (unlisten) {
        unlisten();
      }
    };
  }, [isDesktopRuntime]);

  React.useEffect(() => {
    if (!isDesktopRuntime()) return;
    if (desktopWindowRevealRequestedRef.current) return;
    desktopWindowRevealRequestedRef.current = true;

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const revealWindow = async () => {
      try {
        const core = await import('@tauri-apps/api/core');
        // Use reveal_main_window_command (show only, no set_focus) to avoid
        // triggering Windows' focus-stealing prevention error sound.
        await core.invoke('reveal_main_window_command');
      } catch (error) {
        if (!cancelled) {
          console.warn('[StartupWindow] Failed to reveal main window after startup.', error);
        }
      }
    };

    // Wait for the React tree to finish its initial paint before revealing.
    // Two RAF frames (~33ms) is not enough for this app's heavy component tree;
    // a short setTimeout gives the browser time to commit the first full frame.
    timerId = setTimeout(() => {
      if (!cancelled) {
        // Signal the splashscreen to fade out gracefully before revealing.
        import('@tauri-apps/api/event').then(({ emit }) => {
          emit('splash-fade-out').catch(() => {});
        });
        setTimeout(() => {
          if (!cancelled) void revealWindow();
        }, 180);
      }
    }, 350);

    return () => {
      cancelled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
    };
  }, [isDesktopRuntime]);

  const buildSyntheticFileChangeEvent = React.useCallback((nextFiles: File[]): React.ChangeEvent<HTMLInputElement> => {
    const dt = new DataTransfer();
    nextFiles.forEach((file) => dt.items.add(file));
    const target = { files: dt.files, value: '' } as unknown as HTMLInputElement;
    return { target, currentTarget: target } as React.ChangeEvent<HTMLInputElement>;
  }, []);

  const [nativePickerPreparationState, setNativePickerPreparationState] = React.useState<{
    active: boolean;
    label: string;
    detail: string;
    progress: number | null;
  }>({
    active: false,
    label: '',
    detail: '',
    progress: null,
  });

  const waitForUiTick = React.useCallback(() => new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  }), []);

  const createPathBackedStlFile = React.useCallback((sourcePath: string, name: string): File => {
    const file = new File([], name, {
      type: getDroppedFileMimeType(name),
      lastModified: Date.now(),
    });
    (file as File & { filePath?: string }).filePath = sourcePath;
    return file;
  }, []);

  const pickFilesWithNativeDialog = React.useCallback(async (category: 'mesh' | 'scene', multiple: boolean): Promise<File[] | null> => {
    if (!isDesktopRuntime()) return null;

    try {
      const picked = await pickOpenFilesWithNativeDialog(category, multiple);
      if (!picked || picked.length === 0) return [];

      const core = await import('@tauri-apps/api/core');
      const files: File[] = [];

      const readingLabel = category === 'scene' ? 'Loading Scene…' : 'Loading Mesh…';
      const singleNoun = category === 'scene' ? 'scene file' : 'mesh file';
      const pluralNoun = category === 'scene' ? 'scene files' : 'mesh files';

      setNativePickerPreparationState({
        active: true,
        label: readingLabel,
        detail: picked.length > 1
          ? `Reading 0/${picked.length} selected ${pluralNoun}…`
          : `Reading selected ${singleNoun}…`,
        progress: null,
      });
      await waitForUiTick();

      try {
        for (let i = 0; i < picked.length; i += 1) {
          const entry = picked[i];
        try {
          const sourcePath = entry.path.trim();
          if (!sourcePath) continue;

          const resolvedName = entry.name || getFileNameFromPath(sourcePath);
          setNativePickerPreparationState({
            active: true,
            label: readingLabel,
            detail: picked.length > 1
              ? `Reading ${i + 1}/${picked.length}: ${resolvedName}`
              : `Reading ${resolvedName}…`,
            progress: null,
          });

          const name = resolvedName;
          if (getFileExtensionLower(name) === '.stl') {
            files.push(createPathBackedStlFile(sourcePath, name));
          } else {
            const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
            files.push(new File([new Uint8Array(bytes)], name, {
              type: getDroppedFileMimeType(name),
              lastModified: Date.now(),
            }));
          }
        } catch (error) {
          console.warn(`[Picker] Failed reading picked file path: ${entry.path}`, error);
        }
      }

        return files;
      } finally {
        setNativePickerPreparationState({
          active: false,
          label: '',
          detail: '',
          progress: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const cancelled = message.toLowerCase().includes('cancel');
      if (cancelled) return [];
      console.warn(`[Picker] Native ${category} picker failed, falling back to web input.`, error);
      return null;
    }
  }, [createPathBackedStlFile, isDesktopRuntime, waitForUiTick]);

  const pickFilesWithWebInput = React.useCallback((accept: string, multiple: boolean): Promise<File[]> => {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') {
        resolve([]);
        return;
      }

      const input = document.createElement('input');
      input.type = 'file';
      // iOS WebKit greys out files whose extension it can't map to a known UTI
      // (e.g. .stl, .3mf), and it ignores MIME hints too, so drop the filter
      // there and rely on extension validation when the picked files are processed.
      input.accept = detectIsIOS() ? '' : accept;
      input.multiple = multiple;

      input.onchange = () => {
        resolve(Array.from(input.files ?? []));
      };

      input.click();
    });
  }, []);

  const pickSceneFilesWithNativeDialog = React.useCallback(async (): Promise<Array<{ file: File; sourcePath: string }> | null> => {
    if (!isDesktopRuntime()) return null;

    try {
      const picked = await pickOpenFilesWithNativeDialog('scene', true);
      if (!picked || picked.length === 0) return [];

      const core = await import('@tauri-apps/api/core');
      const files: Array<{ file: File; sourcePath: string }> = [];

      setNativePickerPreparationState({
        active: true,
        label: 'Loading Scene…',
        detail: picked.length > 1
          ? `Reading 0/${picked.length} selected scene files…`
          : 'Reading selected scene file…',
        progress: null,
      });
      await waitForUiTick();

      try {
        for (let i = 0; i < picked.length; i += 1) {
          const entry = picked[i];
        try {
          const sourcePath = entry.path.trim();
          if (!sourcePath) continue;

          const resolvedName = entry.name || getFileNameFromPath(sourcePath);
          setNativePickerPreparationState({
            active: true,
            label: 'Loading Scene…',
            detail: picked.length > 1
              ? `Reading ${i + 1}/${picked.length}: ${resolvedName}`
              : `Reading ${resolvedName}…`,
            progress: null,
          });

          const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
          const name = resolvedName;

          files.push({
            file: new File([new Uint8Array(bytes)], name, {
              type: getDroppedFileMimeType(name),
              lastModified: Date.now(),
            }),
            sourcePath,
          });
        } catch (error) {
          console.warn(`[Picker] Failed reading picked scene file path: ${entry.path}`, error);
        }
      }

        return files;
      } finally {
        setNativePickerPreparationState({
          active: false,
          label: '',
          detail: '',
          progress: null,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const cancelled = message.toLowerCase().includes('cancel');
      if (cancelled) return [];
      console.warn('[Picker] Native scene picker failed, falling back to web input.', error);
      return null;
    }
  }, [isDesktopRuntime, waitForUiTick]);

  const handleOpenMeshDialog = React.useCallback(async () => {
    const nativeFiles = await pickFilesWithNativeDialog('mesh', true);
    if (nativeFiles) {
      if (nativeFiles.length === 0) return;
      const expanded = await expandPickedFilesWithZip(nativeFiles, 'mesh');
      if (expanded.meshFiles.length > 0) {
        void scene.loadFiles(expanded.meshFiles);
      }
      if (expanded.sceneFiles.length > 0) {
        await importSceneFilesWithPluginWarning(expanded.sceneFiles, { resultingScenePath: null });
      }
      return;
    }

    const webFiles = await pickFilesWithWebInput('.stl,.obj,.3mf,.zip', true);
    if (webFiles.length === 0) return;
    const expanded = await expandPickedFilesWithZip(webFiles, 'mesh');
    if (expanded.meshFiles.length > 0) {
      scene.onFileChange(buildSyntheticFileChangeEvent(expanded.meshFiles));
    }
    if (expanded.sceneFiles.length > 0) {
      await importSceneFilesWithPluginWarning(expanded.sceneFiles, { resultingScenePath: null });
    }
  }, [buildSyntheticFileChangeEvent, importSceneFilesWithPluginWarning, pickFilesWithNativeDialog, pickFilesWithWebInput, scene, expandPickedFilesWithZip]);

  const handleOpenSceneDialog = React.useCallback(async () => {
    const nativeFiles = await pickSceneFilesWithNativeDialog();
    if (nativeFiles) {
      if (nativeFiles.length === 0) return;
      const nonZip = nativeFiles.filter((e) => getFileExtensionLower(e.file.name) !== '.zip');
      const zips = nativeFiles.filter((e) => getFileExtensionLower(e.file.name) === '.zip');
      const expandedFromZips = await expandPickedFilesWithZip(zips.map((e) => e.file), 'scene');
      const sceneFiles = [...nonZip.map((e) => e.file), ...expandedFromZips.sceneFiles];

      if (sceneFiles.length > 0) {
        await importSceneFilesWithPluginWarning(
          sceneFiles,
          {
            resultingScenePath: nonZip.length === 1 && expandedFromZips.sceneFiles.length === 0
              ? nativeFiles[0]?.sourcePath ?? null
              : null,
            sourcePaths: [
              ...nonZip.map((e) => e.sourcePath),
              ...Array.from({ length: expandedFromZips.sceneFiles.length }, () => null),
            ],
          },
        );
      }

      if (expandedFromZips.meshFiles.length > 0) {
        void scene.loadFiles(expandedFromZips.meshFiles);
      }
      return;
    }

    const webFiles = await pickFilesWithWebInput('.voxl,.lys,.zip', true);
    if (webFiles.length === 0) return;
    const expanded = await expandPickedFilesWithZip(webFiles, 'scene');
    if (expanded.sceneFiles.length > 0) {
      await importSceneFilesWithPluginWarning(expanded.sceneFiles, { resultingScenePath: null });
    }
    if (expanded.meshFiles.length > 0) {
      void scene.loadFiles(expanded.meshFiles);
    }
  }, [importSceneFilesWithPluginWarning, pickSceneFilesWithNativeDialog, pickFilesWithWebInput, expandPickedFilesWithZip]);

  const importSceneFromLaunchEntries = React.useCallback(async (entries: LaunchSceneFileEntry[]): Promise<boolean> => {
    if (!entries || entries.length === 0) return false;

    const sceneEntries = entries.filter((entry) => {
      const name = (entry.name || getFileNameFromPath(entry.path)).trim();
      return isSceneFileName(name);
    });

    if (sceneEntries.length === 0) return false;

    const core = await import('@tauri-apps/api/core');

    const files: File[] = [];
    for (const sceneEntry of sceneEntries) {
      const sourcePath = sceneEntry.path.trim();
      if (!sourcePath) continue;

      const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
      const name = sceneEntry.name || getFileNameFromPath(sourcePath);
      files.push(new File([new Uint8Array(bytes)], name, {
        type: getDroppedFileMimeType(name),
        lastModified: Date.now(),
      }));
    }

    if (files.length === 0) return false;
    return await importSceneFilesWithPluginWarning(files, {
      resultingScenePath: files.length === 1 ? sceneEntries[0]?.path ?? null : null,
      sourcePaths: sceneEntries.map((entry) => entry.path),
    });
  }, [importSceneFilesWithPluginWarning]);

  // Keep the ref in sync with the latest callback.
  React.useEffect(() => {
    importSceneFromLaunchEntriesRef.current = importSceneFromLaunchEntries;
  }, [importSceneFromLaunchEntries]);

  const flushQueuedLaunchSceneImports = React.useCallback(async (): Promise<void> => {
    if (!startupSceneHandoffReadyRef.current) return;
    if (launchSceneImportInFlightRef.current) return;

    const queuedEntries = queuedLaunchSceneEntriesRef.current;
    if (!queuedEntries || queuedEntries.length === 0) {
      setPendingStartupSceneHandoff(false);
      return;
    }

    queuedLaunchSceneEntriesRef.current = [];
    launchSceneImportInFlightRef.current = true;

    try {
      const handler = importSceneFromLaunchEntriesRef.current;
      if (!handler) return;

      const imported = await handler(queuedEntries);
      if (!imported) {
        console.warn('[LaunchOpen] App launched with file arguments, but no supported scene file (.voxl/.lys) was found.');
      }
    } catch (error) {
      console.warn('[LaunchOpen] Failed handling queued launch scene file arguments.', error);
    } finally {
      launchSceneImportInFlightRef.current = false;
      const stillQueued = queuedLaunchSceneEntriesRef.current.length > 0;
      setPendingStartupSceneHandoff(stillQueued && !startupSceneHandoffReadyRef.current);
      if (stillQueued) {
        void flushQueuedLaunchSceneImports();
      }
    }
  }, []);

  const queueLaunchSceneEntries = React.useCallback((entries: LaunchSceneFileEntry[]) => {
    if (!entries || entries.length === 0) return;

    const merged = new Map<string, LaunchSceneFileEntry>();
    for (const entry of queuedLaunchSceneEntriesRef.current) {
      const key = entry.path.trim().toLowerCase();
      if (!key) continue;
      merged.set(key, entry);
    }
    for (const entry of entries) {
      const key = entry.path.trim().toLowerCase();
      if (!key) continue;
      merged.set(key, entry);
    }

    queuedLaunchSceneEntriesRef.current = Array.from(merged.values());

    if (!startupSceneHandoffReadyRef.current) {
      setPendingStartupSceneHandoff(true);
      return;
    }

    void flushQueuedLaunchSceneImports();
  }, [flushQueuedLaunchSceneImports]);

  React.useEffect(() => {
    if (!isDesktopRuntime()) {
      startupSceneHandoffReadyRef.current = true;
      return;
    }

    if (coldStartSceneHandoffTimerRef.current !== null) {
      window.clearTimeout(coldStartSceneHandoffTimerRef.current);
    }

    coldStartSceneHandoffTimerRef.current = window.setTimeout(() => {
      coldStartSceneHandoffTimerRef.current = null;
      startupSceneHandoffReadyRef.current = true;
      void flushQueuedLaunchSceneImports();
    }, COLD_START_SCENE_HANDOFF_DELAY_MS);

    return () => {
      if (coldStartSceneHandoffTimerRef.current !== null) {
        window.clearTimeout(coldStartSceneHandoffTimerRef.current);
        coldStartSceneHandoffTimerRef.current = null;
      }
      startupSceneHandoffReadyRef.current = true;
    };
  }, [flushQueuedLaunchSceneImports, isDesktopRuntime]);

  // Primary-launch file loading. Uses importSceneFromLaunchEntriesRef (a
  // stable ref) so this effect only runs once on mount and is never
  // cancelled mid-flight by scene re-renders during initialization.
  React.useEffect(() => {
    if (launchSceneFilesHandledRef.current) return;
    launchSceneFilesHandledRef.current = true;

    if (!isDesktopRuntime()) return;

    void (async () => {
      try {
        const core = await import('@tauri-apps/api/core');
        const launchEntries = await core.invoke<LaunchSceneFileEntry[]>('get_launch_scene_files');
        if (!launchEntries || launchEntries.length === 0) return;

        queueLaunchSceneEntries(launchEntries);
      } catch (error) {
        console.warn('[LaunchOpen] Failed handling launch scene file arguments.', error);
      }
    })();
    // isDesktopRuntime is a stable useCallback([]) — this effect runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDesktopRuntime, queueLaunchSceneEntries]);

  React.useEffect(() => {
    if (!isDesktopRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        unlisten = await listen<SceneFileHandoffPayload>('dragonfruit://scene-file-handoff', (event) => {
          if (disposed) return;
          const paths = Array.isArray(event.payload?.paths) ? event.payload.paths : [];
          if (paths.length === 0) return;

          const entries: LaunchSceneFileEntry[] = paths
            .map((path) => {
              const trimmed = path.trim();
              if (!trimmed) return null;
              return {
                path: trimmed,
                name: getFileNameFromPath(trimmed),
              } satisfies LaunchSceneFileEntry;
            })
            .filter((entry): entry is LaunchSceneFileEntry => Boolean(entry));

          queueLaunchSceneEntries(entries);
        });
      } catch (error) {
        if (!disposed) {
          console.warn('[LaunchOpen] Failed subscribing to scene-file handoff events.', error);
        }
      }
    })();

    return () => {
      disposed = true;
      if (unlisten) {
        try {
          unlisten();
        } catch {
          // noop
        }
      }
    };
  }, [isDesktopRuntime, queueLaunchSceneEntries]);

  const handleTopBarOpenScene = React.useCallback(() => {
    void handleOpenSceneDialog();
  }, [handleOpenSceneDialog]);

  const performSendToPrinter = React.useCallback(async (targetDevice: PrinterNetworkDevice, selectedMaterialIdOverride?: string) => {
    if (!printingArtifact || !activePrinterProfile) return;
    if (!activeNetworkUiAdapter) return;
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations?.platesList) return;

    const host = (targetDevice.ipAddress || activePrinterProfile.network?.ipAddress || '').trim();
    const port = targetDevice.port || 80;
    const requiresRemoteMaterialSelection = activeNetworkUiAdapter.supportsRemoteMaterialProfiles !== false;
    const selectedMaterialId = requiresRemoteMaterialSelection
      ? (selectedMaterialIdOverride ?? targetDevice.selectedMaterialId ?? '').trim()
      : ((selectedMaterialIdOverride ?? targetDevice.selectedMaterialId ?? '').trim() || '__local_profile__');
    if (!host) {
      setPrintingSendStatusText('No printer IP address available for send operation.');
      return;
    }
    if (requiresRemoteMaterialSelection && !selectedMaterialId) {
      setPrintingSendStatusText('Select a matching material profile before upload.');
      return;
    }
    if (requiresRemoteMaterialSelection && !selectedMaterialIdOverride && !isLayerHeightMatch(targetDevice.selectedMaterialLayerHeightMm ?? null)) {
      setPrintingSendStatusText(`Selected material on this printer does not match sliced layer height ${slicedLayerHeightMm.toFixed(3)} mm.`);
      return;
    }

    const isCancelRequested = () => printingSendCancelRequestedRef.current;
    const throwIfCanceled = () => {
      if (isCancelRequested()) {
        throw new Error('Upload canceled by user.');
      }
    };

    setPrintingTargetDeviceId(targetDevice.id);
    selectPrinterNetworkDevice(activePrinterProfile.id, targetDevice.id);

    if (requiresRemoteMaterialSelection) {
      const selectedMaterialOption = printingTargetMaterialOptions.find((material) => material.id === selectedMaterialId) ?? null;
      upsertPrinterNetworkDevice(
        activePrinterProfile.id,
        {
          id: targetDevice.id,
          ipAddress: targetDevice.ipAddress,
          selectedMaterialId,
          selectedMaterialName: selectedMaterialOption?.name ?? targetDevice.selectedMaterialName ?? selectedMaterialId,
          selectedMaterialLayerHeightMm: selectedMaterialOption?.layerHeightMm ?? targetDevice.selectedMaterialLayerHeightMm,
        },
        { select: true },
      );
    }

    setPrintingReadyPlateId(null);
  printingSendCancelRequestedRef.current = false;
    setPrintingSendBusy(true);
    setPrintingSendProgress(0.01);
    setPrintingUploadDisplayProgress(0.01);
    setPrintingSendStageText('Uploading Print Job…');
    setPrintingSendStatusText('Uploading Print Job to Printer…');
    setPrintingUploadTelemetry(null);
    setPrintingUploadDialogStage('uploading');
    setPrintingUploadDialogOpen(true);
    setPrintingDeviceProcessingStartedAtMs(null);
    setPrintingDeviceProcessingElapsedSec(0);

    try {
      const nativeTempPath = printingArtifact.nativeTempPath?.trim() || '';
      const zipFilePath = nativeTempPath.length > 0 ? nativeTempPath : null;
      const zipBlob = printingArtifact.blob ?? null;
      throwIfCanceled();

      if (!zipBlob && !zipFilePath) {
        throw new Error('No print artifact payload available for printer upload.');
      }

      throwIfCanceled();

      const pathBase = printingArtifact.outputName.replace(/\.[^.]+$/i, '');
      const networkMode = (activeNetworkUiAdapter.mode || '').trim();
      if (!networkMode) {
        throw new Error('No network mode available for printer upload.');
      }
      
      // Build the printer host URL
      const hostUrl = `http://${host}${port && port !== 80 ? `:${port}` : ''}`;

      // Track upload progress and send via active plugin handler
      let resolvedPlateId: number | null = null;
      
      const uploadResult = await uploadPrintJobWithProgress({
        networkMode,
        hostUrl,
        zipBlob,
        zipFilePath,
        path: pathBase,
        profileId: selectedMaterialId,
        callbacks: {
          onProgress: (event: PluginUploadProgressEvent) => {
            if (isCancelRequested()) return;
            const progress = event.percentComplete / 100;
            const clampedProgress = Math.min(progress, 0.9999);
            if (printingUploadProcessingHandoffTimeoutRef.current !== null) {
              window.clearTimeout(printingUploadProcessingHandoffTimeoutRef.current);
              printingUploadProcessingHandoffTimeoutRef.current = null;
            }
            setPrintingSendProgress(clampedProgress);
            setPrintingUploadDisplayProgress(clampedProgress);
            setPrintingUploadTelemetry({
              speed: event.uploadSpeed,
              remaining: event.remainingTime,
              transferred: event.transferred,
            });
          },
          onStatusUpdate: (update) => {
            if (isCancelRequested()) return;
            if (update.stage === 'processing') {
              setPrintingSendProgress(1);
              setPrintingUploadDisplayProgress(1);
              if (printingUploadProcessingHandoffTimeoutRef.current !== null) {
                window.clearTimeout(printingUploadProcessingHandoffTimeoutRef.current);
              }
              printingUploadProcessingHandoffTimeoutRef.current = window.setTimeout(() => {
                printingUploadProcessingHandoffTimeoutRef.current = null;
                setPrintingUploadDialogStage('processing');
                setPrintingSendStageText('Processing on device…');
                setPrintingSendStatusText(`Upload complete. ${activeNetworkUiAdapter.displayName} is processing file metadata…`);
                setPrintingUploadTelemetry(null);
                setPrintingDeviceProcessingStartedAtMs(Date.now());
              }, 220);
            } else if (update.stage === 'error') {
              if (printingUploadProcessingHandoffTimeoutRef.current !== null) {
                window.clearTimeout(printingUploadProcessingHandoffTimeoutRef.current);
                printingUploadProcessingHandoffTimeoutRef.current = null;
              }
              setPrintingSendStatusText(`Send failed: ${update.error || update.message}`);
              setPrintingSendStageText('Upload failed');
              setPrintingUploadDialogStage('failed');
              setPrintingUploadTelemetry(null);
              setPrintingSendProgress(0);
              setPrintingUploadDisplayProgress(0);
            }
          },
          onComplete: (plateId) => {
            if (isCancelRequested()) return;
            resolvedPlateId = plateId;
          },
        },
      });

      throwIfCanceled();

      if (!uploadResult.ok) {
        throw new Error('Upload failed on printer backend');
      }

      const startedAt = Date.now();
      const timeoutMs = 10 * 60 * 1000;
      const pollMs = 1250;
      let metadataReady = false;
      let pollFailureCount = 0;

      while ((Date.now() - startedAt) < timeoutMs) {
        throwIfCanceled();
        try {
          const responseReady = await pluginNetworkFetch({
            pluginId: printingMonitoringAdapter.pluginId,
            operation: printingMonitoringAdapter.operations.platesList,
            ipAddress: host,
            port,
            plateId: resolvedPlateId,
            jobName: pathBase,
          });

          const readyPayload = await readJsonObject(responseReady);
          const matchedPlate = readyPayload?.matchedPlate as Record<string, unknown> | null | undefined;
          const matchedPlateId = Number(
            (matchedPlate as any)?.PlateID
            ?? (matchedPlate as any)?.plateId
            ?? (matchedPlate as any)?.plate_id
            ?? (matchedPlate as any)?.id,
          );
          if (!resolvedPlateId && Number.isFinite(matchedPlateId) && matchedPlateId > 0) {
            resolvedPlateId = matchedPlateId;
          }

          throwIfCanceled();

          metadataReady = readyPayload?.metadataReady === true;
          pollFailureCount = 0;

          if (metadataReady) {
            break;
          }
        } catch {
          pollFailureCount += 1;
          if (pollFailureCount >= 6) {
            throw new Error('Lost connection while waiting for device processing.');
          }
        }

        await new Promise<void>((resolve) => {
          window.setTimeout(resolve, pollMs);
        });

        throwIfCanceled();
      }

      if (resolvedPlateId) {
        setPrintingReadyPlateId(resolvedPlateId);
      }

      if (printingUploadProcessingHandoffTimeoutRef.current !== null) {
        window.clearTimeout(printingUploadProcessingHandoffTimeoutRef.current);
        printingUploadProcessingHandoffTimeoutRef.current = null;
      }

      if (metadataReady) {
        setPrintingSendProgress(1);
        setPrintingUploadDisplayProgress(1);
        setPrintingSendStageText('Ready to print');
        setPrintingUploadDialogStage('ready');
        setPrintingDeviceProcessingStartedAtMs(null);
        setPrintingUploadTelemetry(null);
        setPrintingSendStatusText(
          `Import complete${resolvedPlateId ? ` • Plate #${resolvedPlateId}` : ''}. Click Print Now when ready.`,
        );
      } else {
        setPrintingSendProgress(1);
        setPrintingUploadDisplayProgress(1);
        setPrintingSendStageText('Device still processing');
        setPrintingUploadDialogStage('failed');
        setPrintingDeviceProcessingStartedAtMs(null);
        setPrintingUploadTelemetry(null);
        setPrintingSendStatusText(
          `Upload complete${resolvedPlateId ? ` • Plate #${resolvedPlateId}` : ''}. Device is still processing metadata after waiting.`,
        );
      }
    } catch (error) {
      if (printingUploadProcessingHandoffTimeoutRef.current !== null) {
        window.clearTimeout(printingUploadProcessingHandoffTimeoutRef.current);
        printingUploadProcessingHandoffTimeoutRef.current = null;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      const canceled = printingSendCancelRequestedRef.current || /cancel|abort/i.test(message);
      if (canceled) {
        setPrintingSendStatusText('Upload canceled. You can retry when ready.');
        setPrintingSendStageText('Upload canceled');
      } else {
        setPrintingSendStatusText(`Send failed: ${message}`);
        setPrintingSendStageText('Upload failed');
      }
      setPrintingUploadDialogStage('failed');
      setPrintingDeviceProcessingStartedAtMs(null);
      setPrintingUploadTelemetry(null);
      setPrintingSendProgress(0);
      setPrintingUploadDisplayProgress(0);
    } finally {
      setPrintingSendBusy(false);
      printingSendCancelRequestedRef.current = false;
    }
  }, [
    activeNetworkUiAdapter,
    activePrinterProfile,
    isLayerHeightMatch,
    printingArtifact,
    printingMonitoringAdapter.operations,
    printingMonitoringAdapter.pluginId,
    printingTargetMaterialOptions,
    slicedLayerHeightMm,
  ]);

  const handleSendToPrinter = React.useCallback(async () => {
    if (!printingArtifact || !activePrinterProfile) return;
    if (!activeNetworkUiAdapter) return;
    if (printableConnectedPrinterFleet.length === 0) {
      setPrintingSendStatusText('No connected printer is available for upload.');
      return;
    }

    const selectedTarget = printingTargetDevice ?? printableConnectedPrinterFleet[0] ?? null;
    if (!selectedTarget) {
      setPrintingSendStatusText('No connected printer is available for upload.');
      return;
    }

    if (requiresRemoteMaterialSelectionForUpload && !isLayerHeightMatch(selectedTarget.selectedMaterialLayerHeightMm ?? null)) {
      setPrintingTargetPickerMode('post-slice');
      setPrintingTargetPickerOpen(true);
      return;
    }

    await performSendToPrinter(selectedTarget);
  }, [
    activeNetworkUiAdapter,
    activePrinterProfile,
    isLayerHeightMatch,
    performSendToPrinter,
    printableConnectedPrinterFleet,
    printingArtifact,
    printingTargetDevice,
    requiresRemoteMaterialSelectionForUpload,
  ]);

  const handleCancelSendToPrinter = React.useCallback(() => {
    if (!printingSendBusy) return;

    printingSendCancelRequestedRef.current = true;
    setPrintingSendStageText('Canceling upload…');
    setPrintingSendStatusText('Canceling upload…');

    if (activeNetworkUiAdapter?.pluginId === 'athena') {
      void import('../../plugins/athena/network')
        .then((mod) => {
          if (typeof mod.abortUpload === 'function') {
            mod.abortUpload();
          }
        })
        .catch(() => {
          // Ignore; cooperative cancellation checks still stop follow-up work.
        });
    }
  }, [activeNetworkUiAdapter?.pluginId, printingSendBusy]);

  const openPrintingMonitorForTargetDevice = React.useCallback((deviceId: string | null) => {
    printingMonitorStartFocusDeviceIdRef.current = deviceId;
    setPrintingMonitorDeviceId(deviceId);
    setPrintingMonitorViewMode('detail');
    setPrintingMonitorModalOpen(true);
  }, []);

  const handlePrintNow = React.useCallback(async () => {
    if (!activePrinterProfile || !printingTargetDevice) return;
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations?.start) return;
    if (printingTargetDevice.connected !== true) return;
    if (!printingReadyPlateId) return;

    const host = (printingTargetDevice.ipAddress || activePrinterProfile.network?.ipAddress || '').trim();
    const port = printingTargetDevice.port || 80;
    if (!host) {
      setPrintingSendStatusText('No printer IP address available for Print Now.');
      return;
    }

    setPrintingPrintNowBusy(true);
    setPrintingSendStageText('Starting print…');
    setPrintingUploadDialogStage('starting');
    setPrintingDeviceProcessingStartedAtMs(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation: printingMonitoringAdapter.operations.start,
        ipAddress: host,
        port,
        plateId: printingReadyPlateId,
      });

      const payload = await readJsonObject(response);
      if (response.ok && payload?.ok === true) {
        setPrintingSendStageText('Print started');
        setPrintingUploadDialogStage('started');
        setPrintingSendStatusText(`Print started successfully${printingReadyPlateId ? ` • Plate #${printingReadyPlateId}` : ''}.`);
        setPrintingUploadDialogOpen(false);
        openPrintingMonitorForTargetDevice(printingTargetDevice.id);
      } else {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        setPrintingSendStageText('Start print failed');
        setPrintingUploadDialogStage('failed');
        setPrintingSendStatusText(`Print start failed: ${reason}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setPrintingSendStageText('Start print failed');
      setPrintingUploadDialogStage('failed');
      setPrintingSendStatusText(`Print start failed: ${message}`);
    } finally {
      setPrintingPrintNowBusy(false);
    }
  }, [activePrinterProfile, openPrintingMonitorForTargetDevice, printingMonitoringAdapter.operations, printingMonitoringAdapter.pluginId, printingReadyPlateId, printingTargetDevice]);

  const executeStartMonitorRecentPlate = React.useCallback(async (plateId: number) => {
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations?.start) return;
    if (!Number.isFinite(plateId) || plateId <= 0) return;

    const roundedPlateId = Math.round(plateId);

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError('No printer IP available to start selected file.');
      return;
    }

    setPrintingMonitorActionBusy('start');
    setPrintingMonitorActionStatus(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation: printingMonitoringAdapter.operations.start,
        ipAddress: host,
        port,
        plateId: roundedPlateId,
      });

      const payload = await readJsonObject(response);
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      setPrintingReadyPlateId(roundedPlateId);
      setPrintingMonitorSelectedPlateId(roundedPlateId);
      setPrintingMonitorActionStatus(`Started plate #${roundedPlateId}.`);
      setPrintingMonitorError(null);
      void refreshPrintingMonitorRecentPlates();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to start selected print file.';
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
    } finally {
      setPrintingMonitorActionBusy(null);
    }
  }, [
    monitoringDevice?.ipAddress,
    monitoringDevice?.port,
    printingMonitoringAdapter,
    refreshPrintingMonitorRecentPlates,
  ]);

  const handleStartMonitorRecentPlate = React.useCallback((plateId: number) => {
    if (!Number.isFinite(plateId) || plateId <= 0) return;
    const roundedPlateId = Math.round(plateId);
    const matched = printingMonitorRecentPlates.find((plate) => plate.plateId === roundedPlateId);
    setPrintingMonitorPendingConfirmation({
      kind: 'plate',
      action: 'start',
      plateId: roundedPlateId,
      plateName: matched?.name ?? `Plate #${roundedPlateId}`,
    });
  }, [printingMonitorRecentPlates]);

  const executeDeleteMonitorRecentPlate = React.useCallback(async (plateId: number) => {
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations?.deletePlate) return;
    if (!Number.isFinite(plateId) || plateId <= 0) return;

    const roundedPlateId = Math.round(plateId);

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError('No printer IP available to delete selected file.');
      return;
    }

    setPrintingMonitorActionBusy('delete');
    setPrintingMonitorActionStatus(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation: printingMonitoringAdapter.operations.deletePlate,
        ipAddress: host,
        port,
        plateId: roundedPlateId,
      });

      const payload = await readJsonObject(response);
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      setPrintingMonitorActionStatus(`Deleted plate #${roundedPlateId}.`);
      setPrintingMonitorError(null);
      setPrintingMonitorRecentPlates((previous) => previous.filter((plate) => plate.plateId !== roundedPlateId));
      setPrintingMonitorSelectedPlateId((previous) => (previous === roundedPlateId ? null : previous));
      if (printingReadyPlateId === roundedPlateId) {
        setPrintingReadyPlateId(null);
      }
      void refreshPrintingMonitorRecentPlates();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete selected print file.';
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
    } finally {
      setPrintingMonitorActionBusy(null);
    }
  }, [
    monitoringDevice?.ipAddress,
    monitoringDevice?.port,
    printingMonitoringAdapter,
    printingReadyPlateId,
    refreshPrintingMonitorRecentPlates,
  ]);

  const handleDeleteMonitorRecentPlate = React.useCallback((plateId: number) => {
    if (!Number.isFinite(plateId) || plateId <= 0) return;
    const roundedPlateId = Math.round(plateId);
    const matched = printingMonitorRecentPlates.find((plate) => plate.plateId === roundedPlateId);
    setPrintingMonitorPendingConfirmation({
      kind: 'plate',
      action: 'delete',
      plateId: roundedPlateId,
      plateName: matched?.name ?? `Plate #${roundedPlateId}`,
    });
  }, [printingMonitorRecentPlates]);

  const executePrintingMonitorControlAction = React.useCallback(async (
    action: 'pause' | 'resume' | 'cancel' | 'emergency-stop',
  ) => {
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations) return;

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError('No printer IP available for control command.');
      return;
    }

    const operation = action === 'pause'
      ? printingMonitoringAdapter.operations.pause
      : action === 'resume'
        ? printingMonitoringAdapter.operations.resume
        : action === 'cancel'
          ? printingMonitoringAdapter.operations.cancel
          : printingMonitoringAdapter.operations.emergencyStop;

    setPrintingMonitorActionBusy(action);
    setPrintingMonitorControlPendingAction(action);
    setPrintingMonitorActionStatus(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation,
        ipAddress: host,
        port,
        plateId: printingMonitorPlateId,
      });

      const payload = await readJsonObject(response);
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string'
          ? payload.error
          : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      const successMessage = typeof payload?.message === 'string' && payload.message.trim().length > 0
        ? payload.message.trim()
        : action === 'pause'
          ? 'Pause command sent.'
          : action === 'resume'
            ? 'Resume command sent.'
            : action === 'cancel'
              ? 'Cancel command sent.'
              : 'Emergency stop command sent.';

      setPrintingMonitorActionStatus(successMessage);
      setPrintingMonitorError(null);

      const statusResponse = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation: printingMonitoringAdapter.operations.status,
        ipAddress: host,
        port,
        plateId: printingMonitorPlateId,
      });
      const statusPayload = await readJsonObject(statusResponse);
      if (statusResponse.ok) {
        setPrintingMonitorSnapshot(printingMonitoringAdapter.parseStatusPayload(statusPayload, `${host}:${port}`));
      }
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'Failed to send control command to printer.';
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
      setPrintingMonitorControlPendingAction(null);
    } finally {
      setPrintingMonitorActionBusy(null);
    }
  }, [monitoringDevice?.ipAddress, monitoringDevice?.port, printingMonitorPlateId, printingMonitoringAdapter]);

  const executePrintingMonitorFeatureToggle = React.useCallback(async (
    feature: 'webcam' | 'timelapse',
    enabled: boolean,
  ) => {
    if (!printingMonitoringAdapter.pluginId || !printingMonitoringAdapter.operations) return;

    const operation = feature === 'webcam'
      ? (enabled ? printingMonitoringAdapter.operations.webcamEnable : printingMonitoringAdapter.operations.webcamDisable)
      : (enabled ? printingMonitoringAdapter.operations.timelapseEnable : printingMonitoringAdapter.operations.timelapseDisable);
    if (!operation) {
      setPrintingMonitorError(`This monitor plugin does not expose ${feature} ${enabled ? 'enable' : 'disable'} commands.`);
      return;
    }

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError(`No printer IP available for ${feature} command.`);
      return;
    }

    const busyKey = feature === 'webcam'
      ? (enabled ? 'webcam-enable' : 'webcam-disable')
      : (enabled ? 'timelapse-enable' : 'timelapse-disable');

    const statusRawPayload = printingMonitorDebugState.status.rawPayload;
    const statusPayloadRecord = (statusRawPayload && typeof statusRawPayload === 'object' && !Array.isArray(statusRawPayload))
      ? statusRawPayload as Record<string, unknown>
      : null;
    const rawMainboardId = statusPayloadRecord?.mainboardId ?? statusPayloadRecord?.MainboardID;
    const resolvedMainboardId = typeof rawMainboardId === 'string' && rawMainboardId.trim().length > 0
      ? rawMainboardId.trim()
      : monitoringDeviceMainboardId;

    setPrintingMonitorActionBusy(busyKey);
    setPrintingMonitorActionStatus(null);
    let recordedResponse = false;

    try {
      const response = await pluginNetworkFetch({
        pluginId: printingMonitoringAdapter.pluginId,
        operation,
        ipAddress: host,
        port,
        mainboardId: resolvedMainboardId,
      });

      const payload = await readJsonObject(response);
      const commandOk = typeof payload?.ok === 'boolean' ? payload.ok : (response.ok ? true : false);
      setPrintingMonitorLastFeatureToggleResponse({
        operation,
        httpStatus: response.status,
        httpOk: response.ok,
        commandOk,
        payload,
        error: payload?.ok === false || !response.ok
          ? (typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
          : null,
        requestedAtEpochMs: Date.now(),
      });
      recordedResponse = true;
      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      const featureLabel = feature === 'webcam' ? 'Video stream' : 'Timelapse';
      setPrintingMonitorActionStatus(
        typeof payload?.message === 'string' && payload.message.trim().length > 0
          ? payload.message.trim()
          : `${featureLabel} ${enabled ? 'enabled' : 'disabled'}.`,
      );
      setPrintingMonitorError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to send ${feature} command.`;
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
      if (!recordedResponse) {
        setPrintingMonitorLastFeatureToggleResponse({
          operation,
          httpStatus: null,
          httpOk: false,
          commandOk: false,
          payload: null,
          error: message,
          requestedAtEpochMs: Date.now(),
        });
      }
    } finally {
      setPrintingMonitorActionBusy(null);
    }
  }, [
    monitoringDevice?.ipAddress,
    monitoringDevice?.port,
    monitoringDeviceMainboardId,
    printingMonitorDebugState.status.rawPayload,
    printingMonitoringAdapter,
  ]);

  const executePrintingMonitorSdcpDebugCommand = React.useCallback(async (
    options: {
      operation: string;
      label: string;
      channel: PrintingMonitorDebugChannel;
      payload?: Record<string, unknown>;
    },
  ) => {
    if (!printingMonitoringAdapter.pluginId) return;

    const host = (monitoringDevice?.ipAddress || '').trim();
    const port = monitoringDevice?.port || 80;
    if (!host) {
      setPrintingMonitorError(`No printer IP available for ${options.label}.`);
      return;
    }

    const requestPayload = {
      pluginId: printingMonitoringAdapter.pluginId,
      operation: options.operation,
      ipAddress: host,
      port,
      ...(options.payload ?? {}),
    };

    setPrintingMonitorActionBusy(null);
    setPrintingMonitorActionStatus(null);

    try {
      const response = await pluginNetworkFetch(requestPayload);
      const payload = await readJsonObject(response);

      setPrintingMonitorDebugState((previous) => ({
        ...previous,
        [options.channel]: {
          requestedAtEpochMs: Date.now(),
          request: requestPayload,
          httpStatus: response.status,
          rawPayload: payload,
          parsedPayload: payload,
          error: (!response.ok || payload?.ok === false)
            ? (typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
            : null,
        },
      }));

      const commandOk = typeof payload?.ok === 'boolean'
        ? payload.ok
        : response.ok;
      setPrintingMonitorLastFeatureToggleResponse({
        operation: options.operation,
        httpStatus: response.status,
        httpOk: response.ok,
        commandOk,
        payload,
        error: (!response.ok || payload?.ok === false)
          ? (typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`)
          : null,
        requestedAtEpochMs: Date.now(),
      });

      if (!response.ok || payload?.ok === false) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(reason);
      }

      setPrintingMonitorActionStatus(
        typeof payload?.message === 'string' && payload.message.trim().length > 0
          ? payload.message.trim()
          : `${options.label} command accepted.`,
      );
      setPrintingMonitorError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to run ${options.label} command.`;
      setPrintingMonitorError(message);
      setPrintingMonitorActionStatus(null);
      setPrintingMonitorLastFeatureToggleResponse((previous) => ({
        operation: options.operation,
        httpStatus: previous?.operation === options.operation ? previous.httpStatus : null,
        httpOk: previous?.operation === options.operation ? previous.httpOk : false,
        commandOk: false,
        payload: previous?.operation === options.operation ? previous.payload : null,
        error: message,
        requestedAtEpochMs: Date.now(),
      }));
    }
  }, [monitoringDevice?.ipAddress, monitoringDevice?.port, printingMonitoringAdapter.pluginId]);

  const handlePrintingMonitorControlAction = React.useCallback((
    action: 'pause' | 'resume' | 'cancel' | 'emergency-stop',
  ) => {
    if (action === 'cancel' || action === 'emergency-stop') {
      setPrintingMonitorPendingConfirmation({ kind: 'control', action });
      return;
    }

    void executePrintingMonitorControlAction(action);
  }, [executePrintingMonitorControlAction]);

  React.useEffect(() => {
    if (!printingMonitorPendingConfirmation) return;

    let wasEscapePressed = false;
    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isEscapePressed = active.has('escape');
      if (isEscapePressed && !wasEscapePressed) {
        setPrintingMonitorPendingConfirmation(null);
      }
      wasEscapePressed = isEscapePressed;
    });

    return unsubscribe;
  }, [printingMonitorPendingConfirmation]);

  const handlePrintingLayerChange = React.useCallback((nextLayer: number) => {
    if (!Number.isFinite(nextLayer)) return;
    const clamped = clampPrintingLayer(nextLayer);

    const flushPendingLayer = (options?: { syncDisplayedLayer?: boolean }) => {
      const pending = pendingPrintingSelectedLayerRef.current;
      pendingPrintingSelectedLayerRef.current = null;
      if (pending == null) return;

      printingSelectedLayerRef.current = pending;
      setPrintingSelectedLayer((previous) => (previous === pending ? previous : pending));
      if (options?.syncDisplayedLayer !== false) {
        setPrintingDisplayedLayer((previous) => (previous === pending ? previous : pending));
      }
    };

    if (isPrintingLayerScrubbing) {
      const currentOrPending = pendingPrintingSelectedLayerRef.current ?? printingSelectedLayerRef.current;
      if (currentOrPending === clamped) return;

      pendingPrintingSelectedLayerRef.current = clamped;

      if (printingSelectedLayerRafRef.current !== null) return;

      printingSelectedLayerRafRef.current = window.requestAnimationFrame(() => {
        printingSelectedLayerRafRef.current = null;
        flushPendingLayer({ syncDisplayedLayer: false });
      });
      return;
    }

    if (printingSelectedLayerRafRef.current !== null) {
      window.cancelAnimationFrame(printingSelectedLayerRafRef.current);
      printingSelectedLayerRafRef.current = null;
    }

    pendingPrintingSelectedLayerRef.current = null;
    printingSelectedLayerRef.current = clamped;
    setPrintingSelectedLayer((previous) => (previous === clamped ? previous : clamped));
    setPrintingDisplayedLayer((previous) => (previous === clamped ? previous : clamped));
  }, [clampPrintingLayer, isPrintingLayerScrubbing]);

  const handlePrintingLayerScrubStart = React.useCallback(() => {
    setIsPrintingLayerScrubbing(true);
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle]);

  const handlePrintingLayerScrubEnd = React.useCallback(() => {
    const flushPendingLayer = () => {
      const pending = pendingPrintingSelectedLayerRef.current;
      pendingPrintingSelectedLayerRef.current = null;
      if (pending == null) return null;

      printingSelectedLayerRef.current = pending;
      setPrintingSelectedLayer((previous) => (previous === pending ? previous : pending));
      setPrintingDisplayedLayer((previous) => (previous === pending ? previous : pending));
      return pending;
    };

    if (printingSelectedLayerRafRef.current !== null) {
      window.cancelAnimationFrame(printingSelectedLayerRafRef.current);
      printingSelectedLayerRafRef.current = null;
    }

    const pending = flushPendingLayer();
    setIsPrintingLayerScrubbing(false);
    // Switch display target to the released layer immediately.
    // If that layer PNG is not loaded yet, UI falls back to cross-section preview
    // instead of showing stale PNG from the previously displayed layer.
    const targetLayer = pending ?? printingSelectedLayerRef.current;
    setPrintingDisplayedLayer(
      Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), targetLayer)),
    );
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle, printingPreviewTotalLayers]);

  const handleSceneLayerScrubStart = React.useCallback(() => {
    setIsSceneLayerScrubbing(true);
  }, []);

  const handleSceneLayerScrubEnd = React.useCallback(() => {
    setIsSceneLayerScrubbing(false);
  }, []);

  const usePrintingSettledHiResCanvas = React.useMemo(() => {
    return Boolean(
      selectedPrintingLayerPreviewUrl
      && printingPreviewZoom > 1.0001
      && !isPrintingLayerScrubbing,
    );
  }, [isPrintingLayerScrubbing, printingPreviewZoom, selectedPrintingLayerPreviewUrl]);

  React.useEffect(() => {
    if (!usePrintingSettledHiResCanvas) return;
    if (!selectedPrintingLayerPreviewUrl) return;

    const canvas = printingPreviewCanvasRef.current;
    const viewport = printingPreviewViewportRef.current;
    if (!canvas || !viewport) return;

    const rect = viewport.getBoundingClientRect();
    const viewportWidth = Math.max(1, Math.round(rect.width));
    const viewportHeight = Math.max(1, Math.round(rect.height));
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const canvasWidth = Math.max(1, Math.round(viewportWidth * dpr));
    const canvasHeight = Math.max(1, Math.round(viewportHeight * dpr));

    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const renderNonce = ++printingPreviewCanvasRenderNonceRef.current;
    let cancelled = false;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled) return;
      if (renderNonce !== printingPreviewCanvasRenderNonceRef.current) return;

      const naturalWidth = Math.max(1, image.naturalWidth || 1);
      const naturalHeight = Math.max(1, image.naturalHeight || 1);
      const logicalSourceWidth = Math.max(1, printingPreviewTargetResolution?.viewportWidth ?? naturalWidth);
      const logicalSourceHeight = Math.max(1, printingPreviewTargetResolution?.viewportHeight ?? naturalHeight);
      const baseScale = Math.min(viewportWidth / logicalSourceWidth, viewportHeight / logicalSourceHeight);
      const drawWidth = logicalSourceWidth * baseScale;
      const drawHeight = logicalSourceHeight * baseScale;

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.imageSmoothingEnabled = false;
      ctx.translate(viewportWidth * 0.5 + printingPreviewPan.x, viewportHeight * 0.5 + printingPreviewPan.y);
      ctx.scale(printingPreviewZoom, printingPreviewZoom);
      ctx.scale(printingPreviewMirrorScale.x, printingPreviewMirrorScale.y);
      ctx.drawImage(image, -drawWidth * 0.5, -drawHeight * 0.5, drawWidth, drawHeight);
      ctx.restore();
      setIsPrintingSettledCanvasReady(true);
    };
    image.src = selectedPrintingLayerPreviewUrl;

    return () => {
      cancelled = true;
    };
  }, [
    printingPreviewMirrorScale.x,
    printingPreviewMirrorScale.y,
    printingPreviewPan.x,
    printingPreviewPan.y,
    printingPreviewTargetResolution?.viewportHeight,
    printingPreviewTargetResolution?.viewportWidth,
    printingPreviewZoom,
    selectedPrintingLayerPreviewUrl,
    usePrintingSettledHiResCanvas,
  ]);

  const handleDroppedPrepareFiles = React.useCallback(async (
    files: File[],
    options?: { prearmedLoadingUi?: boolean },
  ) => {
    if (scene.mode !== 'prepare') return;

    const supportedFiles = files.filter((file) => isSupportedPrepareDropName(file.name));
    if (supportedFiles.length === 0) {
      console.warn('[DragDrop] No supported files dropped. Supported: .stl, .obj, .3mf, .lys, .voxl');
      return;
    }

    const signature = buildDroppedFilesSignature(supportedFiles);
    const nowMs = Date.now();
    const last = lastPrepareDropRef.current;
    if (signature.length > 0 && last.signature === signature && (nowMs - last.atMs) < 1500) {
      // Tauri desktop can emit both native drag-drop and DOM drop for a single gesture.
      // Ignore near-identical repeat payloads to prevent duplicate imports.
      return;
    }
    lastPrepareDropRef.current = { signature, atMs: nowMs };

    const meshFiles = supportedFiles.filter((file) => {
      const ext = getFileExtension(file.name);
      return ext === '.stl' || ext === '.obj' || ext === '.3mf';
    });
    const sceneFiles = supportedFiles.filter((file) => {
      const ext = getFileExtension(file.name);
      return ext === '.lys' || ext === '.voxl';
    });

    const buildSyntheticFileChangeEvent = (nextFiles: File[]): React.ChangeEvent<HTMLInputElement> => {
      const dt = new DataTransfer();
      nextFiles.forEach((file) => dt.items.add(file));
      const target = { files: dt.files, value: '' } as unknown as HTMLInputElement;
      return { target, currentTarget: target } as React.ChangeEvent<HTMLInputElement>;
    };

    if (sceneFiles.length > 0) {
      // Match "Import Scene" button behavior: when a scene file is present,
      // treat the drop as a scene import path and don't separately load mesh files.
      // Use the same handler as the Import Scene button.
      const shouldPrearmLoadingUi = !options?.prearmedLoadingUi;

      if (shouldPrearmLoadingUi) {
        setNativePickerPreparationState({
          active: true,
          label: sceneFiles.length > 1 ? 'Loading dropped scenes…' : 'Loading dropped scene…',
          detail: sceneFiles.length > 1
            ? `Preparing ${sceneFiles.length} dropped scene files…`
            : 'Preparing dropped scene file…',
          progress: null,
        });

        await waitForUiTick();
      }

      try {
        await importSceneFilesWithPluginWarning(sceneFiles);
      } finally {
        if (shouldPrearmLoadingUi) {
          setNativePickerPreparationState({
            active: false,
            label: '',
            detail: '',
            progress: null,
          });
        }
      }
      return;
    }

    if (meshFiles.length > 0) {
      // Use the same handler as the Load Mesh button.
      const meshEvent = buildSyntheticFileChangeEvent(meshFiles);
      scene.onFileChange(meshEvent);
    }
  }, [importSceneFilesWithPluginWarning, scene, waitForUiTick]);

  const createFilesFromTauriDroppedPaths = React.useCallback(async (paths: string[]) => {
    const normalizedSupportedPaths = paths
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
      .filter((path) => isSupportedPrepareDropName(getFileNameFromPath(path)));

    if (normalizedSupportedPaths.length === 0) return [] as File[];

    try {
      const core = await import('@tauri-apps/api/core');
      const files: File[] = [];

      for (const sourcePath of normalizedSupportedPaths) {
        try {
          const name = getFileNameFromPath(sourcePath);
          if (getFileExtensionLower(name) === '.stl') {
            files.push(createPathBackedStlFile(sourcePath, name));
          } else {
            const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
            files.push(new File([new Uint8Array(bytes)], name, {
              type: getDroppedFileMimeType(name),
              lastModified: Date.now(),
            }));
          }
        } catch (error) {
          console.warn(`[DragDrop] Failed reading dropped file path: ${sourcePath}`, error);
        }
      }

      return files;
    } catch {
      return [] as File[];
    }
  }, [createPathBackedStlFile]);

  const sceneModeRef = React.useRef(scene.mode);
  const createFilesFromTauriDroppedPathsRef = React.useRef(createFilesFromTauriDroppedPaths);
  const handleDroppedPrepareFilesRef = React.useRef(handleDroppedPrepareFiles);

  React.useEffect(() => {
    sceneModeRef.current = scene.mode;
  }, [scene.mode]);

  React.useEffect(() => {
    createFilesFromTauriDroppedPathsRef.current = createFilesFromTauriDroppedPaths;
  }, [createFilesFromTauriDroppedPaths]);

  React.useEffect(() => {
    handleDroppedPrepareFilesRef.current = handleDroppedPrepareFiles;
  }, [handleDroppedPrepareFiles]);

  React.useEffect(() => {
    if (scene.mode !== 'prepare') return;
    if (typeof window === 'undefined') return;

    const isLikelyDesktopRuntime =
      window.location.protocol === 'tauri:'
      || window.location.protocol === 'file:'
      || window.location.hostname === 'tauri.localhost'
      || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

    if (!isLikelyDesktopRuntime) return;

    const unlisten: Array<() => void | Promise<void>> = [];
    let disposed = false;

    const invokeUnlistenSafely = (remove: (() => void | Promise<void>) | undefined) => {
      if (!remove) return;
      try {
        const result = remove();
        if (result && typeof result.then === 'function') {
          void result.catch(() => {
            // noop
          });
        }
      } catch {
        // noop
      }
    };

    const registerUnlisten = (remove: () => void | Promise<void>) => {
      if (disposed) {
        invokeUnlistenSafely(remove);
        return;
      }
      unlisten.push(remove);
    };

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        const unlistenDragOver = await listen<unknown>('tauri://drag-over', (event) => {
          if (disposed || sceneModeRef.current !== 'prepare') return;
          setIsPrepareDragActive(true);

          const paths = extractTauriDroppedPaths(event.payload);
          if (paths.length === 0) {
            return;
          }

          const hasSupportedPath = paths.some((path) => {
            const fileName = getFileNameFromPath(path);
            return isSupportedPrepareDropName(fileName);
          });
          setIsPrepareDragUnsupported(!hasSupportedPath);
        });
        registerUnlisten(unlistenDragOver);

        const hideOverlay = () => {
          dragDepthRef.current = 0;
          setIsPrepareDragActive(false);
          setIsPrepareDragUnsupported(false);
        };

        const unlistenDragLeave = await listen('tauri://drag-leave', () => {
          if (disposed) return;
          hideOverlay();
        });
        registerUnlisten(unlistenDragLeave);

        const unlistenDragCancelled = await listen('tauri://drag-drop-cancelled', () => {
          if (disposed) return;
          hideOverlay();
        });
        registerUnlisten(unlistenDragCancelled);

        const unlistenDragDrop = await listen<unknown>('tauri://drag-drop', (event) => {
          if (disposed || sceneModeRef.current !== 'prepare') return;

          hideOverlay();

          const paths = extractTauriDroppedPaths(event.payload);
          if (paths.length === 0) return;

          const supportedPathCount = paths.filter((path) => {
            const fileName = getFileNameFromPath(path);
            return isSupportedPrepareDropName(fileName);
          }).length;

          void (async () => {
            if (supportedPathCount > 0) {
              setNativePickerPreparationState({
                active: true,
                label: 'Loading dropped files…',
                detail: supportedPathCount > 1
                  ? `Reading 0/${supportedPathCount} dropped files…`
                  : 'Reading dropped file…',
                progress: null,
              });

              await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
              });
            }

            try {
              const files = await createFilesFromTauriDroppedPathsRef.current(paths);
              if (files.length === 0) return;
              await handleDroppedPrepareFilesRef.current(files, { prearmedLoadingUi: true });
            } finally {
              if (supportedPathCount > 0) {
                setNativePickerPreparationState({
                  active: false,
                  label: '',
                  detail: '',
                  progress: null,
                });
              }
            }
          })();
        });
        registerUnlisten(unlistenDragDrop);
      } catch {
        // Ignore in non-Tauri environments or when listeners are unavailable.
      }
    })();

    return () => {
      disposed = true;
      while (unlisten.length > 0) {
        const remove = unlisten.pop();
        invokeUnlistenSafely(remove);
      }
    };
  }, [scene.mode]);

  const handlePrepareDragEnter = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    if (!isLikelyFileDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    const supportState = getPrepareDropSupportStateFromDataTransfer(e.dataTransfer);
    if (supportState === 'unsupported') {
      setIsPrepareDragUnsupported(true);
    } else if (supportState === 'supported') {
      setIsPrepareDragUnsupported(false);
    }
    setIsPrepareDragActive(true);
  }, [scene.mode]);

  const handlePrepareDragOver = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    if (!isLikelyFileDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const supportState = getPrepareDropSupportStateFromDataTransfer(e.dataTransfer);
    if (supportState === 'unsupported') {
      setIsPrepareDragUnsupported(true);
    } else if (supportState === 'supported') {
      setIsPrepareDragUnsupported(false);
    }
    e.dataTransfer.dropEffect = supportState === 'unsupported' ? 'none' : 'copy';
    setIsPrepareDragActive(true);
  }, [scene.mode]);

  const handlePrepareDragLeave = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsPrepareDragActive(false);
      setIsPrepareDragUnsupported(false);
    }
  }, [scene.mode]);

  const handlePrepareDrop = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsPrepareDragActive(false);
    setIsPrepareDragUnsupported(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;

    const supportedFileCount = files.filter((file) => isSupportedPrepareDropName(file.name)).length;

    if (supportedFileCount > 0) {
      void (async () => {
        setNativePickerPreparationState({
          active: true,
          label: 'Loading dropped files…',
          detail: supportedFileCount > 1
            ? `Preparing ${supportedFileCount} dropped files…`
            : 'Preparing dropped file…',
          progress: null,
        });

        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });

        try {
          await handleDroppedPrepareFiles(files, { prearmedLoadingUi: true });
        } finally {
          setNativePickerPreparationState({
            active: false,
            label: '',
            detail: '',
            progress: null,
          });
        }
      })();
      return;
    }

    void handleDroppedPrepareFiles(files);
  }, [handleDroppedPrepareFiles, scene.mode]);

  const closeEditorContextMenu = React.useCallback(() => {
    setEditorContextMenuPos(null);
    setEditorContextMenuSupportTarget(null);
  }, []);

  const handleEditorContextMenu = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Intentionally do not open here: some macOS/WebView paths emit contextmenu
    // on right-button press. We open on right-button release instead.
  }, []);

  const handleModelListContextMenu = React.useCallback((modelId: string, position: { x: number; y: number }) => {
    // Right-clicking a model row should target that model first.
    if (!scene.selectedModelIds.includes(modelId)) {
      scene.selectModel(modelId, 'single');
    }
    setEditorContextMenuPos(position);
  }, [scene]);

  const handleRepairModel = React.useCallback((modelId: string) => {
    setManualRepairModelId(modelId);
  }, []);

  const handleOpenModelSupportsInfo = React.useCallback((modelId: string) => {
    setSupportsInfoModelId(modelId);
  }, []);

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

  const handleSplitImportGroup = React.useCallback((modelId: string) => {
    scene.splitImportGroup(modelId);
  }, [scene]);

  const handleRenameFolder = React.useCallback((groupId: string, nextName: string) => {
    scene.renameGroup(groupId, nextName);
  }, [scene]);

  const handleRenameModel = React.useCallback((modelId: string, nextName: string) => {
    scene.renameModel(modelId, nextName);
  }, [scene]);

  const handleSceneModelSelection = React.useCallback((modelId: string | null, options?: { selectionMode?: 'single' | 'toggle' | 'add' }) => {
    if (modelId == null) {
      if (
        scene.mode === 'prepare'
        && transformMgr.transformMode === 'hollowing'
        && selectedHolePunchPlacementIds.length > 0
      ) {
        setSelectedHolePunchPlacementIds([]);
        setHoveredHolePunchPlacementId(null);
        setHolePunchHoverPlacement(null);
        return;
      }
      scene.clearModelSelection();
      return;
    }
    scene.selectModel(modelId, options?.selectionMode ?? 'single');
  }, [scene, selectedHolePunchPlacementIds.length, transformMgr.transformMode]);

  React.useEffect(() => {
    if (
      scene.mode !== 'prepare'
      || transformMgr.transformMode !== 'hollowing'
      || selectedHolePunchPlacementIds.length === 0
    ) {
      return;
    }

    let wasEscapePressed = false;
    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isEscapePressed = active.has('escape');
      if (isEscapePressed && !wasEscapePressed) {
        setSelectedHolePunchPlacementIds([]);
        setHoveredHolePunchPlacementId(null);
        setHolePunchHoverPlacement(null);
      }
      wasEscapePressed = isEscapePressed;
    });

    return unsubscribe;
  }, [scene.mode, selectedHolePunchPlacementIds.length, transformMgr.transformMode]);

  const handleSceneMarqueeSelection = React.useCallback((ids: string[]) => {
    const deduped = Array.from(new Set(ids));
    if (deduped.length === 0) {
      scene.clearModelSelection();
      return;
    }

    scene.setSelectedModelIds(deduped);
    const preferredActiveId = deduped.includes(scene.activeModelId ?? '')
      ? scene.activeModelId
      : deduped[0];
    scene.setActiveModelId(preferredActiveId);
  }, [scene]);

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

  const transformsApproximatelyEqual = React.useCallback((a: ModelTransform, b: ModelTransform) => {
    const EPSILON = 1e-5;
    return a.position.distanceToSquared(b.position) <= EPSILON
      && Math.abs(a.rotation.x - b.rotation.x) <= EPSILON
      && Math.abs(a.rotation.y - b.rotation.y) <= EPSILON
      && Math.abs(a.rotation.z - b.rotation.z) <= EPSILON
      && a.scale.distanceToSquared(b.scale) <= EPSILON;
  }, []);

  const captureTransformSupportSnapshot = React.useCallback(() => {
    const supportSnapshot = structuredClone(getSupportSnapshot());
    supportSnapshot.selectedId = null;
    supportSnapshot.selectedCategory = null;
    supportSnapshot.hoveredId = null;
    supportSnapshot.hoveredCategory = 'none';

    const kickstandSnapshot = structuredClone(getKickstandSnapshot());
    kickstandSnapshot.selectedId = null;

    return {
      support: supportSnapshot,
      kickstand: kickstandSnapshot,
    };
  }, []);

  const invalidatePendingTransformHistory = React.useCallback((options?: { clearRotateCommit?: boolean }) => {
    const now = {
      perfMs: performance.now(),
      epochMs: Date.now(),
    };
    const pending = pendingTransformHistoryRef.current;
    transformHistoryCommitNonceRef.current += 1;
    pendingTransformHistoryRef.current = null;
    transformHistoryCommitRequestedRef.current = false;
    transformHistoryDebugRef.current = {
      ...transformHistoryDebugRef.current,
      lastResult: 'invalidated',
      lastReason: options?.clearRotateCommit === false ? 'invalidate_keep_rotate' : 'invalidate',
      lastModelId: pending?.modelId ?? null,
      lastDescription: pending?.description ?? null,
      lastExpectedNonce: null,
      lastPushApplied: null,
      lastAt: now,
    };
    if (options?.clearRotateCommit !== false) {
      pendingRotateGizmoCommitRef.current = null;
    }
  }, []);

  const commitPendingTransformHistory = React.useCallback((expectedNonce?: number) => {
    const now = {
      perfMs: performance.now(),
      epochMs: Date.now(),
    };
    if (typeof expectedNonce === 'number' && expectedNonce !== transformHistoryCommitNonceRef.current) {
      transformHistoryDebugRef.current = {
        ...transformHistoryDebugRef.current,
        lastResult: 'skipped_nonce_mismatch',
        lastReason: 'expected_nonce_mismatch',
        lastExpectedNonce: expectedNonce,
        lastAt: now,
      };
      return false;
    }

    const pending = pendingTransformHistoryRef.current;
    if (!pending) {
      transformHistoryDebugRef.current = {
        ...transformHistoryDebugRef.current,
        lastResult: 'skipped_no_pending',
        lastReason: 'no_pending_history',
        lastExpectedNonce: expectedNonce ?? null,
        lastAt: now,
      };
      return false;
    }

    const targetModel = scene.models.find((model) => model.id === pending.modelId);
    if (!targetModel) {
      transformHistoryDebugRef.current = {
        ...transformHistoryDebugRef.current,
        lastResult: 'skipped_model_missing',
        lastReason: 'target_model_missing',
        lastModelId: pending.modelId,
        lastDescription: pending.description ?? null,
        lastExpectedNonce: expectedNonce ?? null,
        lastAt: now,
      };
      invalidatePendingTransformHistory();
      return false;
    }

    const explicitAfter = pending.after && isFiniteTransform(pending.after)
      ? {
          position: pending.after.position.clone(),
          rotation: pending.after.rotation.clone(),
          scale: pending.after.scale.clone(),
        }
      : null;

    const pendingTransform = transformMgr.pendingTransformRef.current;
    const afterTransform = explicitAfter ?? (
      (
        scene.activeModelId === pending.modelId
        && pendingTransform
        && isFiniteTransform({
          position: pendingTransform.pos,
          rotation: pendingTransform.rot,
          scale: pendingTransform.scl,
        })
      )
        ? {
            position: pendingTransform.pos.clone(),
            rotation: pendingTransform.rot.clone(),
            scale: pendingTransform.scl.clone(),
          }
        : (
          scene.activeModelId === pending.modelId && isFiniteTransform(transformMgr.transform)
        )
          ? {
              position: transformMgr.transform.position.clone(),
              rotation: transformMgr.transform.rotation.clone(),
              scale: transformMgr.transform.scale.clone(),
            }
          : {
              position: targetModel.transform.position.clone(),
              rotation: targetModel.transform.rotation.clone(),
              scale: targetModel.transform.scale.clone(),
            }
    );

    const supportHistoryOptions = (
      pending.supportBefore
      && pending.kickstandBefore
    )
      ? {
          includeSupportState: true,
          supportBefore: pending.supportBefore,
          kickstandBefore: pending.kickstandBefore,
        }
      : undefined;

    const undoCountBefore = getUndoCount();
    const pushed = scene.commitModelTransformHistory(
      pending.modelId,
      pending.before,
      afterTransform,
      pending.description,
      supportHistoryOptions,
    );
    const undoCountAfter = getUndoCount();
    const equalTransform = transformsApproximatelyEqual(pending.before, afterTransform);
    transformHistoryDebugRef.current = {
      ...transformHistoryDebugRef.current,
      lastResult: pushed ? 'committed' : (equalTransform ? 'skipped_equal_transform' : 'committed_no_push'),
      lastReason: pushed ? 'commit_success' : (equalTransform ? 'before_after_equal' : 'commit_no_push'),
      lastModelId: pending.modelId,
      lastDescription: pending.description ?? null,
      lastExpectedNonce: expectedNonce ?? null,
      lastUndoCountBefore: undoCountBefore,
      lastUndoCountAfter: undoCountAfter,
      lastPushApplied: Boolean(pushed),
      lastAt: now,
    };
    pendingTransformHistoryRef.current = null;
    transformHistoryCommitRequestedRef.current = false;
    return true;
  }, [captureTransformSupportSnapshot, invalidatePendingTransformHistory, isFiniteTransform, scene, transformMgr.pendingTransformRef, transformMgr.transform, transformsApproximatelyEqual]);

  const scheduleCommitPendingTransformHistory = React.useCallback((frameDelay = 1) => {
    const scheduledNonce = ++transformHistoryCommitNonceRef.current;
    transformHistoryDebugRef.current = {
      ...transformHistoryDebugRef.current,
      lastResult: 'scheduled',
      lastReason: `schedule_delay_${Math.max(0, frameDelay)}`,
      lastScheduledNonce: scheduledNonce,
      lastExpectedNonce: scheduledNonce,
      lastAt: {
        perfMs: performance.now(),
        epochMs: Date.now(),
      },
    };
    transformHistoryCommitRequestedRef.current = true;
    const run = (remaining: number) => {
      if (scheduledNonce !== transformHistoryCommitNonceRef.current) return;
      if (remaining <= 0) {
        commitPendingTransformHistory(scheduledNonce);
        return;
      }
      window.requestAnimationFrame(() => run(remaining - 1));
    };
    run(Math.max(0, frameDelay));
  }, [commitPendingTransformHistory]);

  React.useEffect(() => {
    const fallbackDescription = (type: string) => {
      if (type === 'scene_models_snapshot_apply') return 'Scene Change';
      return formatHistoryLabel(type);
    };

    const unsubscribe = subscribeHistoryOperations(({ direction, action }) => {
      const sourceDescription = action.description?.trim() || fallbackDescription(action.type);
      const description = formatHistoryLabel(sourceDescription);

      pendingHistoryTransformResyncRef.current = true;
      invalidatePendingTransformHistory();
      setGizmoResetNonce((value) => value + 1);
      setHistoryTransformResyncTick((value) => value + 1);

      setHistoryActionToast({ id: Date.now(), text: description, direction });
      setIsHistoryActionToastVisible(true);

      if (historyActionToastFadeTimeoutRef.current !== null) {
        window.clearTimeout(historyActionToastFadeTimeoutRef.current);
      }
      if (historyActionToastClearTimeoutRef.current !== null) {
        window.clearTimeout(historyActionToastClearTimeoutRef.current);
      }

      historyActionToastFadeTimeoutRef.current = window.setTimeout(() => {
        setIsHistoryActionToastVisible(false);
        historyActionToastFadeTimeoutRef.current = null;
      }, 1400);

      historyActionToastClearTimeoutRef.current = window.setTimeout(() => {
        setHistoryActionToast(null);
        historyActionToastClearTimeoutRef.current = null;
      }, 1800);
    });

    return () => {
      unsubscribe();
      if (historyActionToastFadeTimeoutRef.current !== null) {
        window.clearTimeout(historyActionToastFadeTimeoutRef.current);
      }
      if (historyActionToastClearTimeoutRef.current !== null) {
        window.clearTimeout(historyActionToastClearTimeoutRef.current);
      }
    };
  }, [invalidatePendingTransformHistory]);

  React.useEffect(() => {
    if (!scene.sceneImportReport) {
      setIsSceneImportToastVisible(false);
      if (sceneImportToastFadeTimeoutRef.current !== null) {
        window.clearTimeout(sceneImportToastFadeTimeoutRef.current);
        sceneImportToastFadeTimeoutRef.current = null;
      }
      return;
    }

    setIsSceneImportToastVisible(true);

    if (sceneImportToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(sceneImportToastFadeTimeoutRef.current);
    }

    const sceneImportToastDurationMs = scene.sceneImportReport.durationMs ?? 4200;
    const sceneImportToastFadeMs = Math.max(0, sceneImportToastDurationMs - 400);

    sceneImportToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsSceneImportToastVisible(false);
      sceneImportToastFadeTimeoutRef.current = null;
    }, sceneImportToastFadeMs);

    return () => {
      if (sceneImportToastFadeTimeoutRef.current !== null) {
        window.clearTimeout(sceneImportToastFadeTimeoutRef.current);
        sceneImportToastFadeTimeoutRef.current = null;
      }
    };
  }, [scene.sceneImportReport]);

  const handleNewDeviceDetected = React.useCallback((deviceId: string) => {
    setNewDeviceToast(deviceId);
    setIsNewDeviceToastVisible(true);
    if (newDeviceToastTimeoutRef.current !== null) {
      window.clearTimeout(newDeviceToastTimeoutRef.current);
    }
    newDeviceToastTimeoutRef.current = window.setTimeout(() => {
      setIsNewDeviceToastVisible(false);
      newDeviceToastTimeoutRef.current = null;
    }, 9000);
  }, []);

  React.useEffect(() => {
    return () => {
      if (newDeviceToastTimeoutRef.current !== null) {
        window.clearTimeout(newDeviceToastTimeoutRef.current);
      }
    };
  }, []);

  const handleExportSuccess = React.useCallback((savedPath: string) => {
    setExportSuccessToast({ id: Date.now(), path: savedPath });
    setIsExportSuccessToastVisible(true);
    if (exportSuccessToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(exportSuccessToastFadeTimeoutRef.current);
    }
    exportSuccessToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsExportSuccessToastVisible(false);
      exportSuccessToastFadeTimeoutRef.current = null;
    }, 3800);
  }, []);

  const showOperationError = React.useCallback((message: string) => {
    setExportErrorToast({ id: Date.now(), text: message });
    setIsExportErrorToastVisible(true);
    if (exportErrorToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(exportErrorToastFadeTimeoutRef.current);
    }
    exportErrorToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsExportErrorToastVisible(false);
      exportErrorToastFadeTimeoutRef.current = null;
    }, 4500);
  }, []);

  const cancelPendingHistoryTransformResyncFrames = React.useCallback(() => {
    if (historyTransformResyncRafRef.current !== null) {
      window.cancelAnimationFrame(historyTransformResyncRafRef.current);
      historyTransformResyncRafRef.current = null;
    }
    if (historyTransformResyncSecondRafRef.current !== null) {
      window.cancelAnimationFrame(historyTransformResyncSecondRafRef.current);
      historyTransformResyncSecondRafRef.current = null;
    }
    if (historyTransformResyncTimeoutRef.current !== null) {
      window.clearTimeout(historyTransformResyncTimeoutRef.current);
      historyTransformResyncTimeoutRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    if (!pendingHistoryTransformResyncRef.current) return;

    pendingHistoryTransformResyncRef.current = false;
    invalidatePendingTransformHistory();
    transformMgr.pendingTransformRef.current = null;
    transformMgr.setIsTransforming(false);

    cancelPendingHistoryTransformResyncFrames();
    const token = ++historyTransformResyncTokenRef.current;

    const syncFromStoreActiveModel = () => {
      if (token !== historyTransformResyncTokenRef.current) return;

      if (!scene.activeModelId || !scene.activeModel) {
        setDisplayActiveModelId(null);
        return;
      }

      const t = scene.activeModel.transform;
      if (!isFiniteTransform(t)) return;

      suppressNextTransformPersistenceRef.current = true;
      transformMgr.transformHook.setPosition(t.position.x, t.position.y, t.position.z);
      transformMgr.transformHook.setRotation(t.rotation.x, t.rotation.y, t.rotation.z);
      transformMgr.transformHook.setScale(t.scale.x, t.scale.y, t.scale.z);
      setDisplayActiveModelId(scene.activeModelId);
    };

    // Immediate sync + two-frame follow-up to catch async store updates from
    // history handlers before they visually lag behind selected-model renders.
    syncFromStoreActiveModel();
    historyTransformResyncRafRef.current = window.requestAnimationFrame(() => {
      syncFromStoreActiveModel();
      historyTransformResyncRafRef.current = null;

      historyTransformResyncSecondRafRef.current = window.requestAnimationFrame(() => {
        syncFromStoreActiveModel();
        historyTransformResyncSecondRafRef.current = null;
      });
    });

    historyTransformResyncTimeoutRef.current = window.setTimeout(() => {
      syncFromStoreActiveModel();
      historyTransformResyncTimeoutRef.current = null;
    }, 48);
  }, [
    cancelPendingHistoryTransformResyncFrames,
    historyTransformResyncTick,
    invalidatePendingTransformHistory,
    isFiniteTransform,
    scene.activeModel,
    scene.activeModelId,
    transformMgr.pendingTransformRef,
    transformMgr.setIsTransforming,
    transformMgr.transformHook,
  ]);

  React.useEffect(() => {
    return () => {
      cancelPendingHistoryTransformResyncFrames();
    };
  }, [cancelPendingHistoryTransformResyncFrames]);

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

    const gesture = rightClickGestureRef.current;
    const moved = Boolean(gesture?.moved);
    const shouldSuppress = performance.now() < suppressEditorContextMenuUntilRef.current;
    if (!moved && !shouldSuppress) {
      if (scene.mode === 'support' && supportShaftHoverDebug.segmentId && supportShaftHoverDebug.point) {
        setEditorContextMenuSupportTarget({
          segmentId: supportShaftHoverDebug.segmentId,
          point: supportShaftHoverDebug.point,
        });
      } else {
        setEditorContextMenuSupportTarget(null);
      }
      setEditorContextMenuPos({ x: e.clientX, y: e.clientY });
    }

    // keep gesture state until contextmenu fires, clear shortly after
    window.setTimeout(() => {
      rightClickGestureRef.current = null;
    }, 0);
  }, [scene.mode, supportShaftHoverDebug.point, supportShaftHoverDebug.segmentId]);

  React.useEffect(() => {
    const markSuppressed = (durationMs: number) => {
      suppressEditorContextMenuUntilRef.current = Math.max(
        suppressEditorContextMenuUntilRef.current,
        performance.now() + durationMs,
      );
    };

    const onOrbitChange = () => markSuppressed(300);

    window.addEventListener('picking-orbit-change', onOrbitChange as EventListener);

    return () => {
      window.removeEventListener('picking-orbit-change', onOrbitChange as EventListener);
    };
  }, []);

  const handleEditorMenuAction = React.useCallback((action: EditorMenuAction) => {
    const projectSplitPoint = (
      start: { x: number; y: number; z: number },
      end: { x: number; y: number; z: number },
      point: { x: number; y: number; z: number },
    ) => {
      const startVec = new THREE.Vector3(start.x, start.y, start.z);
      const endVec = new THREE.Vector3(end.x, end.y, end.z);
      const pointVec = new THREE.Vector3(point.x, point.y, point.z);
      const lineDir = endVec.clone().sub(startVec);
      const lenSq = lineDir.lengthSq();
      if (lenSq <= 1e-10) {
        return {
          t: 0,
          point: { x: startVec.x, y: startVec.y, z: startVec.z },
        };
      }

      const rawT = pointVec.clone().sub(startVec).dot(lineDir) / lenSq;
      const t = Math.max(0, Math.min(1, rawT));
      const projected = startVec.clone().lerp(endVec, t);
      return {
        t,
        point: { x: projected.x, y: projected.y, z: projected.z },
      };
    };

    const projectBezierSplitPoint = (
      start: { x: number; y: number; z: number },
      control1: { x: number; y: number; z: number },
      control2: { x: number; y: number; z: number },
      end: { x: number; y: number; z: number },
      point: { x: number; y: number; z: number },
    ) => {
      const target = new THREE.Vector3(point.x, point.y, point.z);
      let bestT = 0;
      let bestPoint = start;
      let bestDistanceSq = Number.POSITIVE_INFINITY;

      const steps = 40;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const sample = getBezierPointAtT(start, control1, control2, end, t);
        const sampleVec = new THREE.Vector3(sample.x, sample.y, sample.z);
        const distanceSq = sampleVec.distanceToSquared(target);
        if (distanceSq < bestDistanceSq) {
          bestDistanceSq = distanceSq;
          bestT = t;
          bestPoint = sample;
        }
      }

      return {
        t: bestT,
        point: bestPoint,
      };
    };

    switch (action) {
      case 'supports-toggle-curve': {
        const state = getSupportSnapshot();
        if (state.selectedCategory === 'segment' && state.selectedId) {
          toggleSegmentCurve(state.selectedId);
        } else if (state.selectedId && state.braces[state.selectedId]) {
          toggleSegmentCurve(`braceSegment:${state.selectedId}`);
        }
        break;
      }
      case 'supports-add-joint': {
        const target = editorContextMenuSupportTarget;
        if (!target?.segmentId || !target.point) break;

        const state = getSupportSnapshot();
        const segmentId = target.segmentId;
        const splitTargetPoint = target.point;
        const beforeSnapshot = captureSupportEditSnapshot();

        const trunk = Object.values(state.trunks).find((item) => item.segments.some((segment) => segment.id === segmentId));
        if (trunk) {
          const segmentIndex = trunk.segments.findIndex((segment) => segment.id === segmentId);
          if (segmentIndex >= 0) {
            const segment = trunk.segments[segmentIndex];
            const root = state.roots[trunk.rootId];
            let start = segment.bottomJoint?.pos;
            if (!start) {
              if (segmentIndex === 0 && root) {
                start = {
                  x: root.transform.pos.x,
                  y: root.transform.pos.y,
                  z: root.transform.pos.z + root.diskHeight + root.coneHeight,
                };
              } else {
                start = trunk.segments[segmentIndex - 1]?.topJoint?.pos;
              }
            }

            const end = segment.topJoint?.pos
              ?? (trunk.contactCone ? getFinalSocketPosition(trunk.contactCone) : null)
              ?? (start ? { x: start.x, y: start.y, z: start.z + 10 } : null);

            if (start && end) {
              const projected = segment.type === 'bezier'
                ? projectBezierSplitPoint(start, segment.controlPoint1, segment.controlPoint2, end, splitTargetPoint)
                : projectSplitPoint(start, end, splitTargetPoint);
              const updated = splitShaft(trunk, segmentId, projected.point, projected.t, root);
              updateTrunk(updated);
              pushSupportEditHistory('Create trunk joint', beforeSnapshot, captureSupportEditSnapshot());
            }
          }
          break;
        }

        const branch = Object.values(state.branches).find((item) => item.segments.some((segment) => segment.id === segmentId));
        if (branch) {
          const segmentIndex = branch.segments.findIndex((segment) => segment.id === segmentId);
          if (segmentIndex >= 0) {
            const segment = branch.segments[segmentIndex];
            const parentKnot = state.knots[branch.parentKnotId];
            const start = segmentIndex === 0
              ? (parentKnot?.pos ?? segment.bottomJoint?.pos ?? null)
              : (branch.segments[segmentIndex - 1]?.topJoint?.pos ?? segment.bottomJoint?.pos ?? null);
            const end = segment.topJoint?.pos
              ?? (branch.contactCone ? getFinalSocketPosition(branch.contactCone) : null)
              ?? (start ? { x: start.x, y: start.y, z: start.z + 5 } : null);

            if (start && end) {
              const projected = segment.type === 'bezier'
                ? projectBezierSplitPoint(start, segment.controlPoint1, segment.controlPoint2, end, splitTargetPoint)
                : projectSplitPoint(start, end, splitTargetPoint);
              const updated = splitBranchShaft(branch, segmentId, projected.point, projected.t, parentKnot);
              updateBranch(updated);
              pushSupportEditHistory('Create branch joint', beforeSnapshot, captureSupportEditSnapshot());
            }
          }
          break;
        }

        const twig = Object.values(state.twigs).find((item) => item.segments.some((segment) => segment.id === segmentId));
        if (twig) {
          const segmentIndex = twig.segments.findIndex((segment) => segment.id === segmentId);
          if (segmentIndex >= 0) {
            const segment = twig.segments[segmentIndex];
            const start = segmentIndex === 0
              ? (segment.bottomJoint?.pos ?? null)
              : (twig.segments[segmentIndex - 1]?.topJoint?.pos ?? segment.bottomJoint?.pos ?? null);
            const end = segment.topJoint?.pos ?? (start ? { x: start.x, y: start.y, z: start.z + 5 } : null);

            if (start && end) {
              const projected = segment.type === 'bezier'
                ? projectBezierSplitPoint(start, segment.controlPoint1, segment.controlPoint2, end, splitTargetPoint)
                : projectSplitPoint(start, end, splitTargetPoint);
              const updated = splitTwigShaft(twig, segmentId, projected.point, projected.t);
              updateTwig(updated);
              pushSupportEditHistory('Create twig joint', beforeSnapshot, captureSupportEditSnapshot());
            }
          }
          break;
        }

        const stick = Object.values(state.sticks).find((item) => item.segments.some((segment) => segment.id === segmentId));
        if (stick) {
          const segmentIndex = stick.segments.findIndex((segment) => segment.id === segmentId);
          if (segmentIndex >= 0) {
            const segment = stick.segments[segmentIndex];
            const start = segmentIndex === 0
              ? (segment.bottomJoint?.pos ?? null)
              : (stick.segments[segmentIndex - 1]?.topJoint?.pos ?? segment.bottomJoint?.pos ?? null);
            const end = segment.topJoint?.pos ?? (start ? { x: start.x, y: start.y, z: start.z + 5 } : null);

            if (start && end) {
              const projected = segment.type === 'bezier'
                ? projectBezierSplitPoint(start, segment.controlPoint1, segment.controlPoint2, end, splitTargetPoint)
                : projectSplitPoint(start, end, splitTargetPoint);
              const updated = splitStickShaft(stick, segmentId, projected.point, projected.t);
              updateStick(updated);
              pushSupportEditHistory('Create stick joint', beforeSnapshot, captureSupportEditSnapshot());
            }
          }
        }
        break;
      }
      case 'split-supports': {
        const targetId = scene.activeModelId;
        if (targetId) {
          closeEditorContextMenu();
          scene.splitSupports(targetId);
          return;
        }
        break;
      }
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
      case 'paste': {
        const pastedIds = scene.pasteCopiedModelsAutoArrange(arrangeSpacingMm);
        if (pastedIds.length > 0 && printingEstimatedResinMlRef.current != null) {
          const pastedModel = scene.models.find((m) => pastedIds.includes(m.id));
          if (pastedModel) {
            const geom = pastedModel.geometry.geometry;
            const pos = geom.getAttribute('position');
            const idx = geom.getIndex();
            const sourceKey = String(geom.userData?.resinVolumeSourceKey ?? geom.uuid);
            const posVer = (pos as { version?: number; data?: { version?: number } }).version
              ?? (pos as { version?: number; data?: { version?: number } }).data?.version ?? 0;
            const idxVer = (idx as { version?: number } | null)?.version ?? 0;
            const cacheKey = `${sourceKey}:${posVer}:${idxVer}`;
            const cachedMl = printingBaseResinMlCacheRef.current.get(cacheKey) ?? null;
            if (cachedMl != null) {
              const sx = Math.abs(pastedModel.transform.scale.x || 1);
              const sy = Math.abs(pastedModel.transform.scale.y || 1);
              const sz = Math.abs(pastedModel.transform.scale.z || 1);
              const addedMl = cachedMl * sx * sy * sz;
              const nextTotal = (printingEstimatedResinMlRef.current - supportAndRaftResinMl) + addedMl + supportAndRaftResinMl;
              printingEstimatedResinMlRef.current = nextTotal;
              setPrintingEstimatedResinMl(nextTotal);
            }
          }
        }
        break;
      }
      case 'repair': {
        const targetId = scene.activeModelId;
        if (targetId) {
          closeEditorContextMenu();
          setManualRepairModelId(targetId);
          return;
        }
        break;
      }
      default:
        break;
    }
    closeEditorContextMenu();
  }, [arrangeSpacingMm, closeEditorContextMenu, scene]);

  React.useEffect(() => {
    const refreshHistoryDebug = () => {
      setHistoryDebugEvents(getHistoryDebugEvents());
      setHistoryStackCounts({ undo: getUndoCount(), redo: getRedoCount() });
    };

    refreshHistoryDebug();

    const unsubHistory = subscribeHistory(refreshHistoryDebug);
    const unsubHistoryDebug = subscribeHistoryDebug(refreshHistoryDebug);

    return () => {
      unsubHistory();
      unsubHistoryDebug();
    };
  }, []);

  React.useEffect(() => {
    if (isHistoryDebugOpen) {
      historyPreviewBaselineRef.current = {
        undo: getUndoCount(),
        redo: getRedoCount(),
      };
      setIsHistoryPreviewActive(false);
      setHistoryPreviewTargetEventId(null);
      return;
    }

    historyPreviewBaselineRef.current = null;
    setIsHistoryPreviewActive(false);
    setHistoryPreviewTargetEventId(null);
  }, [isHistoryDebugOpen]);

  const jumpHistoryToCounts = React.useCallback((targetUndoCount: number) => {
    let safety = 800;

    while (getUndoCount() > targetUndoCount && safety > 0) {
      const before = getUndoCount();
      undo();
      const after = getUndoCount();
      safety -= 1;
      if (after >= before) break;
    }

    while (getUndoCount() < targetUndoCount && safety > 0) {
      const before = getUndoCount();
      redo();
      const after = getUndoCount();
      safety -= 1;
      if (after <= before) break;
    }
  }, []);

  const handleHistoryJumpToEvent = React.useCallback((event: HistoryDebugEvent) => {
    const currentTotal = getUndoCount() + getRedoCount();
    const targetTotal = event.undoCount + event.redoCount;

    // We can only jump safely within the same undo/redo universe.
    if (currentTotal !== targetTotal) return;

    jumpHistoryToCounts(event.undoCount);
    setIsHistoryPreviewActive(true);
    setHistoryPreviewTargetEventId(event.id);
  }, [jumpHistoryToCounts]);

  const handleHistoryCancelPreview = React.useCallback(() => {
    const baseline = historyPreviewBaselineRef.current;
    if (!baseline) return;
    jumpHistoryToCounts(baseline.undo);
    setIsHistoryPreviewActive(false);
    setHistoryPreviewTargetEventId(null);
  }, [jumpHistoryToCounts]);

  React.useEffect(() => {
    let wasDiagnostics = false;
    let wasHistory = false;
    let wasTransform = false;
    let wasSliceMetrics = false;
    let wasPrintMonitor = false;
    let wasPrintRtsp = false;

    const unsubscribe = hotkeyStore.subscribe((state) => {
      const isDiagnosticsActive = isActionActiveSync('DEBUG', 'DIAGNOSTICS');
      const isHistoryActive = isActionActiveSync('DEBUG', 'HISTORY');
      const isTransformActive = isActionActiveSync('DEBUG', 'TRANSFORM');
      const isSliceMetricsActive = isActionActiveSync('DEBUG', 'SLICE_METRICS');
      const isPrintMonitorActive = isActionActiveSync('DEBUG', 'PRINT_MONITOR');
      const isPrintRtspActive = isActionActiveSync('DEBUG', 'PRINT_RTSP');

      if (isDiagnosticsActive && !wasDiagnostics) {
        setIsDiagnosticsOpen((prev) => !prev);
      }
      if (isHistoryActive && !wasHistory) {
        setIsHistoryDebugOpen((prev) => !prev);
      }
      if (isTransformActive && !wasTransform) {
        setIsTransformDebugOverlayOpen((prev) => !prev);
      }
      if (isSliceMetricsActive && !wasSliceMetrics) {
        if (printingSlicingBenchmark) {
          setIsSliceMetricsDebugOpen((prev) => !prev);
        }
      }
      if (isPrintMonitorActive && !wasPrintMonitor) {
        if (printingMonitorModalOpen) {
          setIsPrintingMonitorDebugOpen((prev) => !prev);
        }
      }
      if (isPrintRtspActive && !wasPrintRtsp) {
        if (printingMonitorModalOpen) {
          setIsPrintingMonitorRtspDebugOpen((prev) => !prev);
        }
      }

      wasDiagnostics = isDiagnosticsActive;
      wasHistory = isHistoryActive;
      wasTransform = isTransformActive;
      wasSliceMetrics = isSliceMetricsActive;
      wasPrintMonitor = isPrintMonitorActive;
      wasPrintRtsp = isPrintRtspActive;
    });

    return unsubscribe;
  }, [printingMonitorModalOpen, printingSlicingBenchmark]);

  const printingMonitorDebugBundle = React.useMemo(() => {
    const selectedDeviceSummary = monitoringDevice
      ? {
          id: monitoringDevice.id,
          displayName: monitoringDevice.displayName,
          hostName: monitoringDevice.hostName,
          ipAddress: monitoringDevice.ipAddress,
          port: monitoringDevice.port,
          connectedFlag: monitoringDevice.connected,
          reachability: printerReachabilityByDeviceId[monitoringDevice.id],
        }
      : null;

    const channelSummary = (channel: PrintingMonitorDebugChannel) => {
      const debug = printingMonitorDebugState[channel];
      return {
        requestedAt: debug.requestedAtEpochMs
          ? new Date(debug.requestedAtEpochMs).toISOString()
          : null,
        httpStatus: debug.httpStatus,
        request: debug.request,
        error: debug.error,
        rawPayload: debug.rawPayload,
        parsedPayload: debug.parsedPayload,
      };
    };

    return {
      selectedDevice: selectedDeviceSummary,
      offlineGate: {
        isPrintingMonitorSelectedPrinterOffline,
        snapshotConnected: printingMonitorSnapshot?.connected ?? null,
        snapshotStateText: printingMonitorSnapshot?.stateText ?? null,
      },
      channels: {
        status: channelSummary('status'),
        webcam: channelSummary('webcam'),
        plates: channelSummary('plates'),
        taskHistory: channelSummary('taskHistory'),
        taskDetails: channelSummary('taskDetails'),
      },
    };
  }, [
    isPrintingMonitorSelectedPrinterOffline,
    monitoringDevice,
    printerReachabilityByDeviceId,
    printingMonitorDebugState,
    printingMonitorSnapshot?.connected,
    printingMonitorSnapshot?.stateText,
  ]);

  const printingMonitorDebugPanels = React.useMemo(() => {
    if (!isPrintingMonitorDebugOpen) return [] as Array<{
      channel: PrintingMonitorDebugChannel;
      statusText: string;
      requestedAt: string | null;
      json: string;
      hasError: boolean;
    }>;

    return PRINTING_MONITOR_DEBUG_CHANNELS.map((channel) => {
      const selectedChannel = printingMonitorDebugBundle.channels[channel];
      const payload = {
        channel,
        requestedAt: selectedChannel.requestedAt,
        httpStatus: selectedChannel.httpStatus,
        request: selectedChannel.request,
        error: selectedChannel.error,
        rawPayload: selectedChannel.rawPayload,
        parsedPayload: selectedChannel.parsedPayload,
      };

      let serialized = '';
      try {
        serialized = JSON.stringify(payload, null, 2);
      } catch {
        serialized = JSON.stringify({
          ...payload,
          rawPayload: '<unserializable>',
          parsedPayload: '<unserializable>',
        }, null, 2);
      }

      const hasError = Boolean(selectedChannel.error);
      const statusText = hasError
        ? 'error'
        : selectedChannel.httpStatus == null
          ? 'pending'
          : `HTTP ${selectedChannel.httpStatus}`;

      return {
        channel,
        statusText,
        requestedAt: selectedChannel.requestedAt,
        json: serialized,
        hasError,
      };
    });
  }, [isPrintingMonitorDebugOpen, printingMonitorDebugBundle.channels]);

  const handleCopyPrintingMonitorDebugBundle = React.useCallback(async () => {
    try {
      if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
        throw new Error('Clipboard API unavailable');
      }
      await navigator.clipboard.writeText(JSON.stringify({
        generatedAt: new Date().toISOString(),
        ...printingMonitorDebugBundle,
      }, null, 2));
      setPrintingMonitorDebugCopyState('copied');
    } catch {
      setPrintingMonitorDebugCopyState('failed');
    }
  }, [printingMonitorDebugBundle]);

  React.useEffect(() => {
    if (printingMonitorDebugCopyState === 'idle') return;
    const timeoutId = window.setTimeout(() => setPrintingMonitorDebugCopyState('idle'), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [printingMonitorDebugCopyState]);

  const formatDebugVec3 = React.useCallback((v: THREE.Vector3 | null | undefined) => {
    if (!v) return 'n/a';
    const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : 'NaN');
    return `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`;
  }, []);

  const formatDebugVec3Like = React.useCallback((v: { x: number; y: number; z: number } | null | undefined) => {
    if (!v) return 'n/a';
    const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : 'NaN');
    return `${f(v.x)}, ${f(v.y)}, ${f(v.z)}`;
  }, []);

  const formatDebugNumber = React.useCallback((value: number, digits = 4) => {
    if (!Number.isFinite(value)) return 'NaN';
    return value.toFixed(digits);
  }, []);

  const formatDebugTime = React.useCallback((stamp: { perfMs: number; epochMs: number } | null, nowPerfMs: number) => {
    if (!stamp) return 'n/a';
    const d = new Date(stamp.epochMs);
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const ss = d.getSeconds().toString().padStart(2, '0');
    const mmm = d.getMilliseconds().toString().padStart(3, '0');
    const wall = `${hh}:${mm}:${ss}.${mmm}`;
    const ageMs = Math.max(0, Math.round(nowPerfMs - stamp.perfMs));
    return `${wall} (${ageMs} ms ago)`;
  }, []);

  const formatDebugLatencyMs = React.useCallback(
    (start: { perfMs: number; epochMs: number } | null, end: { perfMs: number; epochMs: number } | null) => {
      if (!start || !end) return 'n/a';
      const deltaMs = Math.max(0, Math.round(end.perfMs - start.perfMs));
      return `${deltaMs} ms`;
    },
    [],
  );

  React.useEffect(() => {
    if (!editorContextMenuPos) return;

    const handlePointerDown = () => closeEditorContextMenu();
    const handleScrollOrResize = () => closeEditorContextMenu();

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', handleScrollOrResize);
    window.addEventListener('scroll', handleScrollOrResize, true);

    let wasEscapePressed = false;
    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isEscapePressed = active.has('escape');
      if (isEscapePressed && !wasEscapePressed) {
        closeEditorContextMenu();
      }
      wasEscapePressed = isEscapePressed;
    });

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', handleScrollOrResize);
      window.removeEventListener('scroll', handleScrollOrResize, true);
      unsubscribe();
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
  React.useEffect(() => {
    if (scene.activeModelId && scene.activeModel) {
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
        suppressNextTransformPersistenceRef.current = true;
        transformMgr.transformHook.setPosition(fallback.position.x, fallback.position.y, fallback.position.z);
        transformMgr.transformHook.setRotation(fallback.rotation.x, fallback.rotation.y, fallback.rotation.z);
        transformMgr.transformHook.setScale(fallback.scale.x, fallback.scale.y, fallback.scale.z);
        setDisplayActiveModelId(scene.activeModelId);
        return;
      }

      const shouldSuppressAutoLiftDuringSync =
        scene.activeModel.ignoreAutoLift && displayActiveModelId !== scene.activeModelId;
      const shouldDisableAutoSnap =
        shouldSuppressAutoLiftDuringSync || scene.activeModel.manualZMoveOverride === true;

      // Some imported models need to keep their stored transform when first synced into
      // the live transform manager. Only suppress auto-lift for that initial sync pass;
      // once synchronized, the Modify tab settings should work normally again.
      if (shouldDisableAutoSnap) {
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
        suppressNextTransformPersistenceRef.current = true;
        transformMgr.transformHook.setPosition(t.position.x, t.position.y, t.position.z);
        transformMgr.transformHook.setRotation(t.rotation.x, t.rotation.y, t.rotation.z);
        transformMgr.transformHook.setScale(t.scale.x, t.scale.y, t.scale.z);
      }

      // 2. Only AFTER updating transform, update the display ID
      setDisplayActiveModelId(scene.activeModelId);
    } else {
      setDisplayActiveModelId(null);
      invalidatePendingTransformHistory();
      suppressNextTransformPersistenceRef.current = true;
      transformMgr.transformHook.setPosition(0, 0, 0);
      transformMgr.transformHook.setRotation(0, 0, 0);
      transformMgr.transformHook.setScale(1, 1, 1);
    }
  }, [displayActiveModelId, invalidatePendingTransformHistory, isFiniteTransform, scene.activeModel, scene.activeModelId, scene.updateModelTransform]);

  // Sync transform changes from manager back to model store (persistence)
  // This ensures that any change (gizmo, auto-lift, inputs) is saved to the model
  useEffect(() => {
    // Only suppress persistence while a live gizmo transform is actively driving
    // transient values (pendingTransformRef is set from SceneCanvas drag updates).
    // If isTransforming ever lingers true without a pending gizmo payload, we still
    // need manual Transform panel edits to persist and reflow support geometry.
    if (transformMgr.isTransforming && transformMgr.pendingTransformRef.current) return;

    // Skip if handleTransformEnd already flushed the final transform synchronously.
    // The persistence effect would otherwise re-apply the delta because React state
    // (scene.activeModel) hasn't committed yet while modelsRef is still stale.
    if (transformEndFlushedRef.current) {
      transformEndFlushedRef.current = false;
      return;
    }

    // Mirror mode/session writes model transforms explicitly through raw scene
    // updates. Persistence during this window can race and re-apply stale
    // reflected transforms after finalize.
    if (transformMgr.transformMode === 'mirror' || mirrorSessionRef.current) {
      return;
    }

    if (suppressTransformPersistenceCycleCountRef.current > 0) {
      suppressTransformPersistenceCycleCountRef.current -= 1;
      return;
    }

    if (suppressNextTransformPersistenceRef.current) {
      suppressNextTransformPersistenceRef.current = false;
      return;
    }

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
        const pending = pendingTransformHistoryRef.current;
        if (!pending || pending.modelId !== scene.activeModelId) {
          const beforeSupportSnapshot = captureTransformSupportSnapshot();
          pendingTransformHistoryRef.current = {
            modelId: scene.activeModelId,
            before: {
              position: modelTransform.position.clone(),
              rotation: modelTransform.rotation.clone(),
              scale: modelTransform.scale.clone(),
            },
            after: {
              position: current.position.clone(),
              rotation: current.rotation.clone(),
              scale: current.scale.clone(),
            },
            description: pending?.description,
            supportBefore: beforeSupportSnapshot.support,
            kickstandBefore: beforeSupportSnapshot.kickstand,
          };
        } else {
          pending.after = {
            position: current.position.clone(),
            rotation: current.rotation.clone(),
            scale: current.scale.clone(),
          };
        }

        const isDirectTransformPath = !transformMgr.pendingTransformRef.current;
        scene.updateModelTransform(scene.activeModelId, current);

        const afterSupportSnapshot = captureTransformSupportSnapshot();
        const pendingAfter = pendingTransformHistoryRef.current;
        if (pendingAfter && pendingAfter.modelId === scene.activeModelId) {
          pendingAfter.supportAfter = afterSupportSnapshot.support;
          pendingAfter.kickstandAfter = afterSupportSnapshot.kickstand;
        }

        if (isDirectTransformPath) {
          setSupportRenderRefreshNonce((prev) => prev + 1);
        }

        if (transformHistoryCommitRequestedRef.current) {
          window.requestAnimationFrame(() => {
            commitPendingTransformHistory(transformHistoryCommitNonceRef.current);
          });
        }
      }
    }
  }, [
    captureTransformSupportSnapshot,
    commitPendingTransformHistory,
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
    transformMgr.isTransforming,
    transformMgr.transformMode,
    isFiniteTransform,
  ]);

  useEffect(() => {
    const pending = pendingTransformHistoryRef.current;
    if (!pending) {
      transformHistoryCommitRequestedRef.current = false;
      return;
    }
    if (scene.activeModelId === pending.modelId) return;
    invalidatePendingTransformHistory();
  }, [invalidatePendingTransformHistory, scene.activeModelId]);

  // Wrap transform change to update local state.
  // Keep this callback stable during active drags to avoid callback-identity
  // churn feeding back into gizmo drag listeners/effects.
  const handleTransformChange = React.useCallback((pos: THREE.Vector3, rot: THREE.Euler, scl: THREE.Vector3) => {
    transformMgr.setIsTransforming(true);
    transformMgr.onTransformChange(pos, rot, scl);
  }, [transformMgr.onTransformChange, transformMgr.setIsTransforming]);

  // 3. Slicing (Global context - operates on scene bounds, not just active model)
  const hasAnyEntries = React.useCallback((record: Record<string, unknown>) => {
    for (const _key in record) {
      return true;
    }
    return false;
  }, []);

  const hasSupportOrRaftGeometry = React.useMemo(() => {
    return (
      raftSettingsSnapshot.bottomMode !== 'off'
      || hasAnyEntries(supportStateSnapshot.roots)
      || hasAnyEntries(supportStateSnapshot.trunks)
      || hasAnyEntries(supportStateSnapshot.branches)
      || hasAnyEntries(supportStateSnapshot.leaves)
      || hasAnyEntries(supportStateSnapshot.twigs)
      || hasAnyEntries(supportStateSnapshot.sticks)
      || hasAnyEntries(supportStateSnapshot.braces)
      || hasAnyEntries(kickstandStateSnapshot.kickstands)
    );
  }, [
    hasAnyEntries,
    kickstandStateSnapshot.kickstands,
    raftSettingsSnapshot.bottomMode,
    supportStateSnapshot.braces,
    supportStateSnapshot.branches,
    supportStateSnapshot.leaves,
    supportStateSnapshot.roots,
    supportStateSnapshot.sticks,
    supportStateSnapshot.trunks,
    supportStateSnapshot.twigs,
  ]);

  // For non-printing workflows, avoid expensive world-triangle projection work by default.
  // Keep layer floor at 0 when support/raft geometry exists so layer-1 alignment is correct.
  const fallbackZRange = React.useMemo(() => ({
    min: hasSupportOrRaftGeometry ? 0 : (scene.sceneBounds?.min.z ?? 0),
    max: scene.sceneBounds?.max.z ?? 100,
  }), [hasSupportOrRaftGeometry, scene.sceneBounds]);

  const normalizeToSlicerZRange = React.useCallback((range: { min: number; max: number }) => {
    const maxZMm = Math.max(0, Number(range.max) || 0);
    const buildHeightLimitMm = Math.max(0, Number(activePrinterProfile?.buildVolumeMm.height) || 0);
    const clampedMaxZMm = buildHeightLimitMm > 0
      ? Math.min(maxZMm, buildHeightLimitMm)
      : maxZMm;

    return {
      min: 0,
      max: clampedMaxZMm,
    };
  }, [activePrinterProfile?.buildVolumeMm.height]);

  const [sceneZRange, setSceneZRange] = useState(fallbackZRange);

  const setSceneZRangeIfChanged = React.useCallback((nextRange: { min: number; max: number }) => {
    setSceneZRange((previous) => {
      if (Object.is(previous.min, nextRange.min) && Object.is(previous.max, nextRange.max)) {
        return previous;
      }
      return nextRange;
    });
  }, []);

  const projectedZRangeCacheRef = React.useRef<Map<string, { min: number; max: number }>>(new Map());
  const buildProjectedZRangeCacheKey = React.useCallback(() => {
    const visibleSignature = scene.models
      .filter((model) => model.visible)
      .map((model) => {
        const t = model.transform;
        return [
          model.id,
          model.geometry.geometry.uuid,
          t.position.x.toFixed(3),
          t.position.y.toFixed(3),
          t.position.z.toFixed(3),
          t.rotation.x.toFixed(3),
          t.rotation.y.toFixed(3),
          t.rotation.z.toFixed(3),
          t.scale.x.toFixed(3),
          t.scale.y.toFixed(3),
          t.scale.z.toFixed(3),
        ].join('|');
      })
      .join(';');

    return [
      visibleSignature,
      `support-refresh:${supportRenderRefreshNonce}`,
      `raft-mode:${raftSettingsSnapshot.bottomMode}`,
      `roots:${countRecordEntries(supportStateSnapshot.roots)}`,
      `trunks:${countRecordEntries(supportStateSnapshot.trunks)}`,
      `branches:${countRecordEntries(supportStateSnapshot.branches)}`,
      `leaves:${countRecordEntries(supportStateSnapshot.leaves)}`,
      `twigs:${countRecordEntries(supportStateSnapshot.twigs)}`,
      `sticks:${countRecordEntries(supportStateSnapshot.sticks)}`,
      `braces:${countRecordEntries(supportStateSnapshot.braces)}`,
      `kickstands:${countRecordEntries(kickstandStateSnapshot.kickstands)}`,
    ].join('||');
  }, [
    kickstandStateSnapshot.kickstands,
    raftSettingsSnapshot.bottomMode,
    scene.models,
    supportRenderRefreshNonce,
    supportStateSnapshot.braces,
    supportStateSnapshot.branches,
    supportStateSnapshot.leaves,
    supportStateSnapshot.roots,
    supportStateSnapshot.sticks,
    supportStateSnapshot.trunks,
    supportStateSnapshot.twigs,
  ]);

  useEffect(() => {
    // Projected world-triangle bounds are expensive.
    // Analysis can run on fallback bounds to keep mode-entry instant.
    // Printing needs accurate support/raft-aware bounds before a print artifact exists.
    // Export intentionally uses fallback bounds to avoid full-plate OOM spikes on entry.
    const needsAccurateZRange = scene.mode === 'printing' && !printingArtifact;
    const shouldUseSlicerAlignedRange = scene.mode === 'printing' || scene.mode === 'export';
    
    if (needsAccurateZRange) {
      const projectedZRangeCacheKey = buildProjectedZRangeCacheKey();
      const cached = projectedZRangeCacheRef.current.get(projectedZRangeCacheKey);
      if (cached) {
        setSceneZRangeIfChanged(cached);
        return;
      }

      // Defer expensive calculation to idle time to avoid RAF stalls on mode entry.
      let cancelled = false;
      let timeoutId: number | null = null;
      let idleId: number | null = null;

      const run = () => {
        if (cancelled) return;
        const projected = buildProjectedCrossSectionZRange(scene.models);
        const baseRange = projected ?? fallbackZRange;
        const nextRange = shouldUseSlicerAlignedRange
          ? normalizeToSlicerZRange(baseRange)
          : baseRange;
        projectedZRangeCacheRef.current.set(projectedZRangeCacheKey, nextRange);
        if (projectedZRangeCacheRef.current.size > 8) {
          const oldest = projectedZRangeCacheRef.current.keys().next().value;
          if (oldest != null) projectedZRangeCacheRef.current.delete(oldest);
        }
        setSceneZRangeIfChanged(nextRange);
      };

      timeoutId = window.setTimeout(() => {
        const win = window as Window & {
          requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
        };
        if (typeof win.requestIdleCallback === 'function') {
          idleId = win.requestIdleCallback(() => run(), { timeout: 250 });
        } else {
          run();
        }
      }, 0);

      return () => {
        cancelled = true;
        if (timeoutId !== null) window.clearTimeout(timeoutId);
        if (idleId !== null && typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(idleId);
        }
      };
    } else {
      // Use fast fallback for non-export modes where projected bounds aren't required.
      const nextRange = shouldUseSlicerAlignedRange
        ? normalizeToSlicerZRange(fallbackZRange)
        : fallbackZRange;
      setSceneZRangeIfChanged(nextRange);
    }
  }, [
    buildProjectedZRangeCacheKey,
    normalizeToSlicerZRange,
    fallbackZRange,
    printingArtifact,
    scene.mode,
    scene.models,
    setSceneZRangeIfChanged,
  ]);

  const slicing = useSlicingManager({
    hasGeometry: scene.models.length > 0,
    zRange: sceneZRange,
    layerHeightMm: crossSectionLayerHeightMm,
  });

  const estimatedSlicerLayerCount = React.useMemo(() => {
    if (scene.models.length === 0) return 0;

    const layerHeightMm = Math.max(0.001, crossSectionLayerHeightMm || 0.05);
    const printableMaxZMm = Math.max(0, Number(sceneZRange.max) || 0);
    const buildHeightLimitMm = Math.max(0, Number(activePrinterProfile?.buildVolumeMm.height) || 0);
    const slicerHeightMm = buildHeightLimitMm > 0
      ? Math.min(printableMaxZMm, buildHeightLimitMm)
      : printableMaxZMm;

    return Math.max(0, Math.ceil(slicerHeightMm / layerHeightMm));
  }, [activePrinterProfile?.buildVolumeMm.height, crossSectionLayerHeightMm, scene.models.length, sceneZRange.max]);

  const modelStatsEstimatedPrintTimeLabel = React.useMemo(() => {
    if (!activeMaterialProfile) return '—';

    const visibleModels = scene.models.filter((model) => model.visible);
    if (visibleModels.length === 0) return '—';

    const totalLayers = estimatedSlicerLayerCount;
    if (totalLayers <= 0) return '—';

    const bottomLayers = Math.max(0, Math.min(totalLayers, Math.round(activeMaterialProfile.bottomLayerCount)));
    const normalLayers = Math.max(0, totalLayers - bottomLayers);

    const liftSec = activeMaterialProfile.liftSpeedMmMin > 0
      ? (activeMaterialProfile.liftDistanceMm / activeMaterialProfile.liftSpeedMmMin) * 60
      : 0;
    const retractSec = activeMaterialProfile.retractSpeedMmMin > 0
      ? (activeMaterialProfile.liftDistanceMm / activeMaterialProfile.retractSpeedMmMin) * 60
      : 0;
    const travelSecPerLayer = Math.max(0, liftSec + retractSec);

    const totalSec = (
      bottomLayers * (activeMaterialProfile.bottomExposureSec + travelSecPerLayer)
      + normalLayers * (activeMaterialProfile.normalExposureSec + travelSecPerLayer)
    );

    const wholeSeconds = Math.max(0, Math.floor(totalSec));
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const seconds = wholeSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }, [activeMaterialProfile, estimatedSlicerLayerCount, scene.models]);

  const printingCurrentHeightMm = React.useMemo(() => {
    if (scene.mode !== 'printing') return null;
    if (printingPreviewTotalLayers <= 0) return null;

    const clampedLayer = Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), printingSelectedLayer));
    const height = clampedLayer * crossSectionLayerHeightMm;
    return Math.min(Math.max(height, 0), Math.max(slicing.heightMm, 0));
  }, [crossSectionLayerHeightMm, printingPreviewTotalLayers, printingSelectedLayer, scene.mode, slicing.heightMm]);

  React.useEffect(() => {
    const handleLayerHotkeys = (event: CustomEvent) => {
      const { key, altKey, ctrlKey, metaKey } = event.detail;
      if (altKey || ctrlKey || metaKey) return;

      const isPrinting = scene.mode === 'printing';
      const isUp = key === 'ArrowUp' || (isPrinting && (key === 'w' || key === 'W'));
      const isDown = key === 'ArrowDown' || (isPrinting && (key === 's' || key === 'S'));
      if (!isUp && !isDown) return;

      const delta = isUp ? 1 : -1;

      if (isPrinting) {
        if (printingPreviewTotalLayers <= 0) return;
        const nextLayer = printingSelectedLayerRef.current + delta;
        handlePrintingLayerChange(nextLayer);
        return;
      }

      if (slicing.numLayers <= 0) return;
      slicing.setLayerIndex((previous) => previous + delta);
    };

    window.addEventListener('app-hotkey-keydown', handleLayerHotkeys as EventListener);
    return () => {
      window.removeEventListener('app-hotkey-keydown', handleLayerHotkeys as EventListener);
    };
  }, [handlePrintingLayerChange, printingPreviewTotalLayers, scene.mode, slicing.layerIndex, slicing.numLayers, slicing.setLayerIndex]);

  const runExportThumbnailCapture = React.useCallback(async () => {
    const capture = exportThumbnailCaptureRef.current;
    if (!capture) return null;

    const previousLayerIndex = slicing.layerIndex;
    const previousActiveModelId = scene.activeModelId;
    const previousSelectedModelIds = scene.selectedModelIds;
    const previousSelectAllActive = isSelectAllModelsActive;
    const visibleModelIds = scene.models.filter((model) => model.visible).map((model) => model.id);
    const forcedActiveModelId = visibleModelIds[0] ?? null;

    const sameSelection = (
      previousSelectedModelIds.length === visibleModelIds.length
      && previousSelectedModelIds.every((id, index) => id === visibleModelIds[index])
    );

    const shouldResetLayer = previousLayerIndex !== 0;
    const shouldSetSelection = visibleModelIds.length > 0 && !sameSelection;
    const shouldSetActive = forcedActiveModelId !== previousActiveModelId;
    const shouldSetSelectAllVisual = !previousSelectAllActive;

    try {
      // Ensure export thumbnail shows full geometry (no cross-section clipping)
      // and equivalent to Ctrl+A model visibility context.
      if (shouldResetLayer) {
        slicing.setLayerIndex(0);
      }

      if (visibleModelIds.length > 0) {
        if (shouldSetSelection) {
          scene.setSelectedModelIds(visibleModelIds);
        }
        if (shouldSetActive) {
          scene.setActiveModelId(forcedActiveModelId);
        }
        if (shouldSetSelectAllVisual) {
          setIsSelectAllModelsActive(true);
        }
      }

      if (shouldResetLayer || shouldSetSelection || shouldSetActive || shouldSetSelectAllVisual) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      return await capture();
    } finally {
      if (shouldResetLayer) {
        slicing.setLayerIndex(previousLayerIndex);
      }
      if (shouldSetSelection) {
        scene.setSelectedModelIds(previousSelectedModelIds);
      }
      if (shouldSetActive) {
        scene.setActiveModelId(previousActiveModelId);
      }
      if (shouldSetSelectAllVisual) {
        setIsSelectAllModelsActive(previousSelectAllActive);
      }
    }
  }, [
    isSelectAllModelsActive,
    scene.activeModelId,
    scene.models,
    scene.selectedModelIds,
    scene.setActiveModelId,
    scene.setSelectedModelIds,
    slicing.layerIndex,
    slicing.setLayerIndex,
  ]);

  React.useEffect(() => {
    exportThumbnailCaptureRunnerRef.current = runExportThumbnailCapture;
  }, [runExportThumbnailCapture]);

  React.useEffect(() => {
    const targetMicron = Math.max(1, Math.round(crossSectionLayerHeightMm * 1000));
    if (slicing.layerHeightMicron !== targetMicron) {
      slicing.setLayerHeightMicron(targetMicron);
    }
  }, [
    crossSectionLayerHeightMm,
    slicing.layerHeightMicron,
    slicing.setLayerHeightMicron,
  ]);

  React.useEffect(() => {
    const previousMode = previousSceneModeRef.current;
    const currentMode = scene.mode;

    if (previousMode !== 'printing' && currentMode === 'printing') {
      // Save the mode we were in before entering printing (for Back button to return to)
      modeBeforePrintingRef.current = previousMode;
      // Save the general (prepare/support) layer position before printing takes control.
      preservedNonPrintingLayerIndexRef.current = slicing.layerIndex;
      // Printing preview should always begin at the first layer.
      setPrintingSelectedLayer(1);
      setPrintingDisplayedLayer(1);
      printingSelectedLayerRef.current = 1;
    } else if (previousMode === 'printing' && currentMode !== 'printing') {
      // Restore general slider state so printing scrub position does not leak across modes.
      const preserved = preservedNonPrintingLayerIndexRef.current;
      if (preserved != null) {
        const clamped = Math.max(0, Math.min(Math.max(0, slicing.numLayers), Math.round(preserved)));
        slicing.setLayerIndex(clamped);
      }
      preservedNonPrintingLayerIndexRef.current = null;
    }

    previousSceneModeRef.current = currentMode;
  }, [scene.mode, slicing.layerIndex, slicing.numLayers, slicing.setLayerIndex]);

  // Invalidate printing artifact if scene changed (detected via history events after the slice marker)
  React.useEffect(() => {
    if (!printingArtifact) return; // Nothing to invalidate
    
    const historyEvents = getHistoryDebugEvents();
    if (historyEvents.length === 0) return;
    
    // Find the most recent "SCENE_SLICED" marker
    let sliceMarkerIndex = -1;
    for (let i = historyEvents.length - 1; i >= 0; i--) {
      if (historyEvents[i].actionType === 'SCENE_SLICED') {
        sliceMarkerIndex = i;
        break;
      }
    }
    
    if (sliceMarkerIndex >= 0) {
      // Check if there are any OTHER events (non-undo/redo) after the slice marker
      const eventsAfterSlice = historyEvents.slice(sliceMarkerIndex + 1);
      const hasModifications = eventsAfterSlice.some(
        (e) => e.kind === 'push' && e.actionType !== 'SCENE_SLICED'
      );
      
      if (hasModifications) {
        setPrintingArtifactIsInvalid(true);
      }
    }
  }, [printingArtifact]);

  // Re-check invalidation when history changes
  React.useEffect(() => {
    const checkInvalidation = () => {
      if (!printingArtifact || printingArtifactIsInvalid) return; // Already invalid or no artifact
      
      const historyEvents = getHistoryDebugEvents();
      if (historyEvents.length === 0) return;
      
      // Find the most recent "SCENE_SLICED" marker
      let sliceMarkerIndex = -1;
      for (let i = historyEvents.length - 1; i >= 0; i--) {
        if (historyEvents[i].actionType === 'SCENE_SLICED') {
          sliceMarkerIndex = i;
          break;
        }
      }
      
      if (sliceMarkerIndex >= 0) {
        // Check if there are any OTHER events (non-undo/redo) after the slice marker
        const eventsAfterSlice = historyEvents.slice(sliceMarkerIndex + 1);
        const hasModifications = eventsAfterSlice.some(
          (e) => e.kind === 'push' && e.actionType !== 'SCENE_SLICED'
        );
        
        if (hasModifications) {
          setPrintingArtifactIsInvalid(true);
        }
      }
    };

    const unsubscribe = subscribeHistoryDebug(checkInvalidation);
    return () => {
      void unsubscribe();
    };
  }, [printingArtifact, printingArtifactIsInvalid]);

  // Bind slice artifact to active printer/material profile fingerprint.
  React.useEffect(() => {
    if (!printingArtifact) {
      slicedArtifactProfileFingerprintRef.current = null;
      return;
    }

    if (!slicedArtifactProfileFingerprintRef.current) {
      slicedArtifactProfileFingerprintRef.current = activeSliceProfileFingerprint;
    }
  }, [activeSliceProfileFingerprint, printingArtifact]);

  // Invalidate slicing output when printer and/or material profile changes.
  React.useEffect(() => {
    if (!printingArtifact || printingArtifactIsInvalid) return;

    const baselineFingerprint = slicedArtifactProfileFingerprintRef.current;
    if (!baselineFingerprint) {
      slicedArtifactProfileFingerprintRef.current = activeSliceProfileFingerprint;
      return;
    }

    if (baselineFingerprint !== activeSliceProfileFingerprint) {
      setPrintingArtifactIsInvalid(true);
    }
  }, [activeSliceProfileFingerprint, printingArtifact, printingArtifactIsInvalid]);

  // Lock printing workspace when no models exist
  React.useEffect(() => {
    if (scene.models.length === 0 && scene.mode === 'printing') {
      // Reset to prepare mode if we delete the last model while in printing
      scene.setMode('prepare');
      setPrintingArtifact(null);
      setPrintingArtifactIsInvalid(false);
    }
  }, [scene.models.length, scene.mode, scene, printingArtifact]);

  // Track whether the profile settings modal is currently open so we can
  // defer the printing-workspace kick until after the user closes it.
  const isProfileModalOpenRef = React.useRef(false);
  const pendingPrintingKickRef = React.useRef(false);
  React.useEffect(() => {
    const handler = (e: Event) => {
      const isOpen = (e as CustomEvent<{ isOpen: boolean }>).detail.isOpen;
      isProfileModalOpenRef.current = isOpen;
      if (!isOpen && pendingPrintingKickRef.current) {
        pendingPrintingKickRef.current = false;
        scene.setMode('prepare');
        setShowPrintingResliceModal(true);
      }
    };
    window.addEventListener(PROFILE_SETTINGS_MODAL_OPEN_CHANGE_EVENT, handler);
    return () => window.removeEventListener(PROFILE_SETTINGS_MODAL_OPEN_CHANGE_EVENT, handler);
  }, [scene]);

  // If artifact becomes invalid while already in printing workspace, kick back and show modal.
  // If the profile settings modal is currently open, defer until it closes.
  React.useEffect(() => {
    if (scene.mode === 'printing' && printingArtifactIsInvalid && printingArtifact) {
      if (isProfileModalOpenRef.current) {
        pendingPrintingKickRef.current = true;
      } else {
        scene.setMode('prepare');
        setShowPrintingResliceModal(true);
      }
    }
  }, [printingArtifactIsInvalid, printingArtifact, scene.mode, scene]);

  // Auto-trigger upload/print when entering printing workspace via a Slice & Upload / Slice & Print intent
  React.useEffect(() => {
    if (scene.mode !== 'printing') return;
    if (!printingArtifact) return;
    const action = pendingPostSliceActionRef.current;
    if (!action) return;
    pendingPostSliceActionRef.current = null;
    if (action === 'print') pendingAutoStartPrintRef.current = true;

    const preselected = preSliceUploadSelectionRef.current;
    preSliceUploadSelectionRef.current = null;
    if (preselected) {
      const preselectedTarget = printableConnectedPrinterFleet.find((device) => device.id === preselected.deviceId) ?? null;
      if (preselectedTarget) {
        void performSendToPrinter(preselectedTarget, preselected.materialId);
        return;
      }
    }

    void handleSendToPrinter();
  }, [scene.mode, printingArtifact, handleSendToPrinter, performSendToPrinter, printableConnectedPrinterFleet]);

  // After a Slice & Print upload, auto-start print when plate is ready
  React.useEffect(() => {
    if (!pendingAutoStartPrintRef.current) return;
    if (!printingReadyPlateId || !printingTargetDevice?.connected) return;
    pendingAutoStartPrintRef.current = false;
    void handlePrintNow();
  }, [printingReadyPlateId, printingTargetDevice?.connected, handlePrintNow]);

  React.useLayoutEffect(() => {
    if (scene.mode !== 'printing') return;
    const clamped = Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), printingSelectedLayer));

    // Keep 3D cross-section in lock-step with selected PNG layer.
    // Use 1-based layer index here so layer 1 still produces a real cut plane.
    const targetLayerIndex = Math.max(1, clamped);
    if (slicing.layerIndex === targetLayerIndex) {
      return;
    }
    slicing.setLayerIndex(targetLayerIndex);
  }, [
    scene.mode,
    printingPreviewTotalLayers,
    printingSelectedLayer,
    slicing.layerIndex,
    slicing.setLayerIndex,
  ]);

  // 4. Islands (needs geom & transform & layerHeight)
  const islands = useIslandManager({
    geom: scene.geom,
    transform: transformMgr.transform,
    layerHeightMm: slicing.layerHeightMm
  });

  // Islands PoC — fresh, tab-agnostic hook (true world-space). Mounted in the
  // Support tab; relocatable to Analysis with a one-line move. supportTips is
  // injected (no src/supports coupling in the Islands module).
  const modelRaycastRef = React.useRef<((start: THREE.Vector3, end: THREE.Vector3) => boolean) | null>(null);
  const [supportTips, setSupportTips] = React.useState<THREE.Vector3[]>([]);

  React.useEffect(() => {
    const updateSupportTips = () => {
      const snap = getSupportSnapshot();
      const tips: THREE.Vector3[] = [];
      const activeModelId = scene.activeModel?.id;
      if (!activeModelId) {
        setSupportTips([]);
        return;
      }

      const addPos = (pos?: { x: number; y: number; z: number }, modelId?: string) => {
        if (pos && modelId === activeModelId) {
          tips.push(new THREE.Vector3(pos.x, pos.y, pos.z));
        }
      };

      for (const t of Object.values(snap.trunks)) {
        if (t.contactCone) addPos(t.contactCone.pos, t.modelId);
      }
      for (const b of Object.values(snap.branches)) {
        if (b.contactCone) addPos(b.contactCone.pos, b.modelId);
      }
      for (const l of Object.values(snap.leaves)) {
        if (l.contactCone) addPos(l.contactCone.pos, l.modelId);
      }
      for (const a of Object.values(snap.anchors)) {
        if (a.contactCone) addPos(a.contactCone.pos, a.modelId);
      }
      for (const tw of Object.values(snap.twigs)) {
        if (tw.contactDiskA) addPos(tw.contactDiskA.pos, tw.modelId);
        if (tw.contactDiskB) addPos(tw.contactDiskB.pos, tw.modelId);
      }
      for (const st of Object.values(snap.sticks)) {
        if (st.contactConeA) addPos(st.contactConeA.pos, st.modelId);
        if (st.contactConeB) addPos(st.contactConeB.pos, st.modelId);
      }

      setSupportTips(prevTips => {
        if (prevTips.length !== tips.length) return tips;
        for (let i = 0; i < tips.length; i++) {
          if (!prevTips[i].equals(tips[i])) return tips;
        }
        return prevTips;
      });
    };

    updateSupportTips();
    return subscribeSupportState(updateSupportTips);
  }, [scene.activeModel?.id]);

  const islandsPoc = useIslands({
    geom: scene.geom,
    transform: transformMgr.transform,
    layerHeightMm: slicing.layerHeightMm,
    supportTips,
    plateZ: 0,
    sourcePath: scene.activeModel?.sourcePath,
    activeTab: scene.mode,
  });

  // 5. Supports
  const supports = useSupportInteractionManager({ mode: scene.mode });

  const handleModeChange = React.useCallback((nextMode: typeof scene.mode) => {
    if (scene.models.length === 0 && nextMode !== 'prepare') {
      scene.setMode('prepare');
      return;
    }
    if (nextMode === 'printing' && !hasPrintingWorkspaceData) {
      return;
    }
    if (nextMode === 'printing' && printingArtifactIsInvalid && printingArtifact) {
      setShowPrintingResliceModal(true);
      return;
    }
    scene.setMode(nextMode);
  }, [hasPrintingWorkspaceData, printingArtifact, printingArtifactIsInvalid, scene]);

  const handleAddPrinterFromOnboarding = React.useCallback(() => {
    openProfileSettingsModal('printer', { openPrinterLibrary: true });
  }, []);

  const handleUseWithoutPrinter = React.useCallback(() => {
    setAllowPrepareWithoutPrinter(true);
  }, []);

  // Temporary: LYS Ghost Viewer State
  const [ghostData, setGhostData] = React.useState<any>(null);
  const LysGhostOverlay = React.useMemo(
    () => {
      const loader = getPluginSceneOverlayLoader('lys-import');
      return loader ? React.lazy(loader) : null;
    },
    [],
  );

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

  const supportBoundsByModelId = React.useMemo(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'arrange') {
      return EMPTY_SUPPORT_BOUNDS_BY_MODEL_ID;
    }

    const boundsByModelId = new Map<string, THREE.Box3>();

    const ensureBounds = (modelId: string) => {
      let bounds = boundsByModelId.get(modelId);
      if (!bounds) {
        bounds = new THREE.Box3();
        boundsByModelId.set(modelId, bounds);
      }
      return bounds;
    };

    const expand = (modelId: string | null | undefined, pos: { x: number; y: number; z: number } | null | undefined, radiusMm = 0) => {
      if (!modelId || !pos) return;
      const bounds = ensureBounds(modelId);
      const radius = Math.max(0, radiusMm);
      bounds.expandByPoint(new THREE.Vector3(pos.x - radius, pos.y - radius, pos.z - radius));
      bounds.expandByPoint(new THREE.Vector3(pos.x + radius, pos.y + radius, pos.z + radius));
    };

    const knotModelById = new Map<string, string>();

    for (const branch of Object.values(supportStateSnapshot.branches)) {
      if (branch.modelId) knotModelById.set(branch.parentKnotId, branch.modelId);
    }
    for (const leaf of Object.values(supportStateSnapshot.leaves)) {
      if (leaf.modelId) knotModelById.set(leaf.parentKnotId, leaf.modelId);
    }
    for (const brace of Object.values(supportStateSnapshot.braces)) {
      if (!brace.modelId) continue;
      knotModelById.set(brace.startKnotId, brace.modelId);
      knotModelById.set(brace.endKnotId, brace.modelId);
    }
    for (const kickstand of Object.values(kickstandStateSnapshot.kickstands)) {
      if (kickstand.modelId) knotModelById.set(kickstand.hostKnotId, kickstand.modelId);
    }

    for (const root of Object.values(supportStateSnapshot.roots)) {
      expand(root.modelId, root.transform?.pos, Math.max(0.001, root.diameter / 2));
      expand(root.modelId, {
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        z: root.transform.pos.z + Math.max(0, root.diskHeight) + Math.max(0, root.coneHeight),
      }, Math.max(0.001, root.diameter / 2));
    }

    if (raftSettingsSnapshot.bottomMode !== 'off') {
      const rootsByModel = new Map<string, SupportBaseCircle[]>();

      for (const root of Object.values(supportStateSnapshot.roots)) {
        if (!root.modelId) continue;
        if (!rootsByModel.has(root.modelId)) rootsByModel.set(root.modelId, []);
        rootsByModel.get(root.modelId)!.push({
          x: root.transform.pos.x,
          y: root.transform.pos.y,
          r: root.diameter / 2,
        });
      }

      for (const [modelId, circles] of rootsByModel) {
        if (circles.length === 0) continue;

        const chamferInset = raftSettingsSnapshot.bottomMode === 'line'
          ? Math.max(0, raftSettingsSnapshot.lineHeightMm) * Math.tan((Math.PI / 180) * (90 - Math.min(90, Math.max(45, raftSettingsSnapshot.chamferAngle))))
          : 0;

        const baseProfile = computeFootprint(circles, {
          marginMm: 0.2 + chamferInset,
          samplesPerCircle: 24,
        });

        if (!baseProfile || baseProfile.length < 3) continue;

        const outerProfile = raftSettingsSnapshot.wallEnabled
          ? computeRaftOuterBoundary(baseProfile, raftSettingsSnapshot)
          : baseProfile;

        const raftTopZ = raftSettingsSnapshot.bottomMode === 'line'
          ? raftSettingsSnapshot.lineHeightMm
          : raftSettingsSnapshot.thickness;
        const raftMaxZ = raftTopZ + (raftSettingsSnapshot.wallEnabled ? raftSettingsSnapshot.wallHeight : 0);

        for (const p of outerProfile) {
          expand(modelId, { x: p.x, y: p.y, z: 0 }, 0);
          expand(modelId, { x: p.x, y: p.y, z: raftMaxZ }, 0);
        }
      }
    }

    for (const trunk of Object.values(supportStateSnapshot.trunks)) {
      const modelId = trunk.modelId;
      if (!modelId) continue;
      for (const seg of trunk.segments) {
        expand(modelId, seg.topJoint?.pos, Math.max(0.001, (seg.topJoint?.diameter ?? seg.diameter) / 2));
        expand(modelId, seg.bottomJoint?.pos, Math.max(0.001, (seg.bottomJoint?.diameter ?? seg.diameter) / 2));
      }
      if (trunk.contactCone) {
        expand(modelId, trunk.contactCone.pos, Math.max(0.001, trunk.contactCone.profile.contactDiameterMm / 2));
      }
    }

    for (const branch of Object.values(supportStateSnapshot.branches)) {
      const modelId = branch.modelId;
      if (!modelId) continue;
      for (const seg of branch.segments) {
        expand(modelId, seg.topJoint?.pos, Math.max(0.001, (seg.topJoint?.diameter ?? seg.diameter) / 2));
        expand(modelId, seg.bottomJoint?.pos, Math.max(0.001, (seg.bottomJoint?.diameter ?? seg.diameter) / 2));
      }
      if (branch.contactCone) {
        expand(modelId, branch.contactCone.pos, Math.max(0.001, branch.contactCone.profile.contactDiameterMm / 2));
      }
    }

    for (const leaf of Object.values(supportStateSnapshot.leaves)) {
      if (!leaf.modelId || !leaf.contactCone) continue;
      expand(leaf.modelId, leaf.contactCone.pos, Math.max(0.001, leaf.contactCone.profile.contactDiameterMm / 2));
    }

    for (const twig of Object.values(supportStateSnapshot.twigs)) {
      const modelId = twig.modelId;
      if (!modelId) continue;
      for (const seg of twig.segments) {
        expand(modelId, seg.topJoint?.pos, Math.max(0.001, (seg.topJoint?.diameter ?? seg.diameter) / 2));
        expand(modelId, seg.bottomJoint?.pos, Math.max(0.001, (seg.bottomJoint?.diameter ?? seg.diameter) / 2));
      }
      expand(modelId, twig.contactDiskA.pos, Math.max(0.001, twig.contactDiskA.contactDiameterMm / 2));
      expand(modelId, twig.contactDiskB.pos, Math.max(0.001, twig.contactDiskB.contactDiameterMm / 2));
    }

    for (const stick of Object.values(supportStateSnapshot.sticks)) {
      const modelId = stick.modelId;
      if (!modelId) continue;
      for (const seg of stick.segments) {
        expand(modelId, seg.topJoint?.pos, Math.max(0.001, (seg.topJoint?.diameter ?? seg.diameter) / 2));
        expand(modelId, seg.bottomJoint?.pos, Math.max(0.001, (seg.bottomJoint?.diameter ?? seg.diameter) / 2));
      }
      expand(modelId, stick.contactConeA.pos, Math.max(0.001, stick.contactConeA.profile.contactDiameterMm / 2));
      expand(modelId, stick.contactConeB.pos, Math.max(0.001, stick.contactConeB.profile.contactDiameterMm / 2));
    }

    for (const kickstand of Object.values(kickstandStateSnapshot.kickstands)) {
      const modelId = kickstand.modelId;
      if (!modelId) continue;
      for (const seg of kickstand.segments) {
        expand(modelId, seg.topJoint?.pos, Math.max(0.001, (seg.topJoint?.diameter ?? seg.diameter) / 2));
        expand(modelId, seg.bottomJoint?.pos, Math.max(0.001, (seg.bottomJoint?.diameter ?? seg.diameter) / 2));
      }
    }

    for (const knot of Object.values(supportStateSnapshot.knots)) {
      const parent = knot.parentShaftId;
      let modelId = knotModelById.get(knot.id) ?? null;
      if (!modelId) {
        const trunk = supportStateSnapshot.trunks[parent];
        const branch = supportStateSnapshot.branches[parent];
        const twig = supportStateSnapshot.twigs[parent];
        const stick = supportStateSnapshot.sticks[parent];
        if (trunk?.modelId) modelId = trunk.modelId;
        else if (branch?.modelId) modelId = branch.modelId;
        else if (twig?.modelId) modelId = twig.modelId;
        else if (stick?.modelId) modelId = stick.modelId;
        else if (parent.startsWith('braceSegment:')) {
          const braceId = parent.slice('braceSegment:'.length);
          modelId = supportStateSnapshot.braces[braceId]?.modelId ?? null;
        }
      }
      expand(modelId, knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2));
    }

    for (const knot of Object.values(kickstandStateSnapshot.knots)) {
      const modelId = knotModelById.get(knot.id) ?? null;
      expand(modelId, knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2));
    }

    return boundsByModelId;
  }, [
    scene.mode,
    transformMgr.transformMode,
    supportStateSnapshot.braces,
    supportStateSnapshot.branches,
    supportStateSnapshot.knots,
    supportStateSnapshot.leaves,
    supportStateSnapshot.roots,
    supportStateSnapshot.sticks,
    supportStateSnapshot.trunks,
    supportStateSnapshot.twigs,
    kickstandStateSnapshot.knots,
    kickstandStateSnapshot.kickstands,
    raftSettingsSnapshot,
  ]);

  const getModelSupportAwareDimensionsMm = React.useCallback((
    model: (typeof scene.models)[number],
    rotationZOverride?: number,
    transformOverride?: (typeof scene.models)[number]['transform'],
  ) => {
    const t = transformOverride ?? getArrangeTransform(model);
    const effectiveTransform = {
      position: t.position.clone(),
      rotation: new THREE.Euler(
        t.rotation.x,
        t.rotation.y,
        rotationZOverride ?? t.rotation.z,
        t.rotation.order,
      ),
      scale: t.scale.clone(),
    };

    const meshApproxBounds = computeApproxModelWorldBounds(
      model.geometry,
      effectiveTransform,
    );
    const meshFootprint = computeProjectedFootprintSize(
      model.geometry,
      effectiveTransform.rotation,
      effectiveTransform.scale,
    );

    const approxCenterX = (meshApproxBounds.min.x + meshApproxBounds.max.x) * 0.5;
    const approxCenterY = (meshApproxBounds.min.y + meshApproxBounds.max.y) * 0.5;

    let minX = approxCenterX - (meshFootprint.width * 0.5);
    let maxX = approxCenterX + (meshFootprint.width * 0.5);
    let minY = approxCenterY - (meshFootprint.depth * 0.5);
    let maxY = approxCenterY + (meshFootprint.depth * 0.5);
    let minZ = meshApproxBounds.min.z;
    let maxZ = meshApproxBounds.max.z;

    const supportBoundsBase = supportBoundsByModelId.get(model.id);
    if (supportBoundsBase && !supportBoundsBase.isEmpty()) {
      const sourceMatrix = new THREE.Matrix4().compose(
        model.transform.position,
        new THREE.Quaternion().setFromEuler(model.transform.rotation),
        model.transform.scale,
      );
      const targetMatrix = new THREE.Matrix4().compose(
        effectiveTransform.position,
        new THREE.Quaternion().setFromEuler(effectiveTransform.rotation),
        effectiveTransform.scale,
      );
      const delta = new THREE.Matrix4().multiplyMatrices(targetMatrix, sourceMatrix.clone().invert());
      const transformedSupportBounds = supportBoundsBase.clone().applyMatrix4(delta);

      minX = Math.min(minX, transformedSupportBounds.min.x);
      maxX = Math.max(maxX, transformedSupportBounds.max.x);
      minY = Math.min(minY, transformedSupportBounds.min.y);
      maxY = Math.max(maxY, transformedSupportBounds.max.y);
      minZ = Math.min(minZ, transformedSupportBounds.min.z);
      maxZ = Math.max(maxZ, transformedSupportBounds.max.z);
    }

    return {
      width: Math.max(2, maxX - minX),
      depth: Math.max(2, maxY - minY),
      height: Math.max(2, maxZ - minZ),
    };
  }, [getArrangeTransform, supportBoundsByModelId]);

  const getModelSupportAwareFootprintPolygon = React.useCallback((
    model: (typeof scene.models)[number],
    rotationZOverride?: number,
    transformOverride?: (typeof scene.models)[number]['transform'],
  ) => {
    const t = transformOverride ?? getArrangeTransform(model);
    const effectiveTransform = {
      position: t.position.clone(),
      rotation: new THREE.Euler(
        t.rotation.x,
        t.rotation.y,
        rotationZOverride ?? t.rotation.z,
        t.rotation.order,
      ),
      scale: t.scale.clone(),
    };

    const points = computeProjectedFootprintHull(
      model.geometry,
      effectiveTransform.rotation,
      effectiveTransform.scale,
    ).map((point) => new THREE.Vector2(
      point.x + effectiveTransform.position.x,
      point.y + effectiveTransform.position.y,
    ));

    const supportBoundsBase = supportBoundsByModelId.get(model.id);
    if (supportBoundsBase && !supportBoundsBase.isEmpty()) {
      const sourceMatrix = new THREE.Matrix4().compose(
        model.transform.position,
        new THREE.Quaternion().setFromEuler(model.transform.rotation),
        model.transform.scale,
      );
      const targetMatrix = new THREE.Matrix4().compose(
        effectiveTransform.position,
        new THREE.Quaternion().setFromEuler(effectiveTransform.rotation),
        effectiveTransform.scale,
      );
      const delta = new THREE.Matrix4().multiplyMatrices(targetMatrix, sourceMatrix.clone().invert());
      const transformedSupportBounds = supportBoundsBase.clone().applyMatrix4(delta);
      points.push(
        new THREE.Vector2(transformedSupportBounds.min.x, transformedSupportBounds.min.y),
        new THREE.Vector2(transformedSupportBounds.max.x, transformedSupportBounds.min.y),
        new THREE.Vector2(transformedSupportBounds.max.x, transformedSupportBounds.max.y),
        new THREE.Vector2(transformedSupportBounds.min.x, transformedSupportBounds.max.y),
      );
    }

    if (points.length < 3) {
      const dims = getModelSupportAwareDimensionsMm(model, rotationZOverride, transformOverride);
      return [
        new THREE.Vector2(effectiveTransform.position.x - dims.width * 0.5, effectiveTransform.position.y - dims.depth * 0.5),
        new THREE.Vector2(effectiveTransform.position.x + dims.width * 0.5, effectiveTransform.position.y - dims.depth * 0.5),
        new THREE.Vector2(effectiveTransform.position.x + dims.width * 0.5, effectiveTransform.position.y + dims.depth * 0.5),
        new THREE.Vector2(effectiveTransform.position.x - dims.width * 0.5, effectiveTransform.position.y + dims.depth * 0.5),
      ];
    }

    const sorted = points
      .map((point) => point.clone())
      .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
    const cross = (o: THREE.Vector2, a: THREE.Vector2, b: THREE.Vector2) =>
      (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower: THREE.Vector2[] = [];
    for (const point of sorted) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
        lower.pop();
      }
      lower.push(point);
    }
    const upper: THREE.Vector2[] = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const point = sorted[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
        upper.pop();
      }
      upper.push(point);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }, [getArrangeTransform, getModelSupportAwareDimensionsMm, supportBoundsByModelId]);

  const getModelSupportAwareFootprintPolygonRef = React.useRef(getModelSupportAwareFootprintPolygon);
  React.useEffect(() => {
    getModelSupportAwareFootprintPolygonRef.current = getModelSupportAwareFootprintPolygon;
  }, [getModelSupportAwareFootprintPolygon]);

  const sleep = React.useCallback((ms: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  }), []);

  const buildHighPrecisionArrangeSupportLocalPoints = React.useCallback((
    modelTransformById: Map<string, (typeof scene.models)[number]['transform']>,
  ) => {
    const supportLocalPointsByModelId = new Map<string, { points: THREE.Vector3[]; key: string }>();

    for (const model of scene.models) {
      const supportBounds = supportBoundsByModelId.get(model.id);
      if (!supportBounds || supportBounds.isEmpty()) continue;

      const t = modelTransformById.get(model.id) ?? model.transform;
      const worldMatrix = new THREE.Matrix4().compose(
        t.position,
        new THREE.Quaternion().setFromEuler(t.rotation),
        t.scale,
      );
      const invWorldMatrix = worldMatrix.clone().invert();

      const xs = [supportBounds.min.x, supportBounds.max.x];
      const ys = [supportBounds.min.y, supportBounds.max.y];
      const zs = [supportBounds.min.z, supportBounds.max.z];

      const points: THREE.Vector3[] = [];
      const seen = new Set<string>();
      const tmp = new THREE.Vector3();
      for (const x of xs) {
        for (const y of ys) {
          for (const z of zs) {
            tmp.set(x, y, z).applyMatrix4(invWorldMatrix);
            const dedupeKey = `${tmp.x.toFixed(4)}:${tmp.y.toFixed(4)}:${tmp.z.toFixed(4)}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);
            points.push(tmp.clone());
          }
        }
      }

      if (points.length === 0) continue;

      const key = [
        supportBounds.min.x.toFixed(4),
        supportBounds.min.y.toFixed(4),
        supportBounds.min.z.toFixed(4),
        supportBounds.max.x.toFixed(4),
        supportBounds.max.y.toFixed(4),
        supportBounds.max.z.toFixed(4),
        points.length,
      ].join('|');

      supportLocalPointsByModelId.set(model.id, { points, key });
    }

    return supportLocalPointsByModelId;
  }, [scene.models, supportBoundsByModelId]);

  const buildHighPrecisionArrangeModels = React.useCallback((
    sourceModels: (typeof scene.models),
    modelTransformById: Map<string, (typeof scene.models)[number]['transform']>,
  ): HighPrecisionArrangeModel[] => {
    const supportLocalPointsByModelId = buildHighPrecisionArrangeSupportLocalPoints(modelTransformById);

    return sourceModels.map((model): HighPrecisionArrangeModel => {
      const t = modelTransformById.get(model.id) ?? model.transform;
      const supportLocal = supportLocalPointsByModelId.get(model.id);

      return {
        id: model.id,
        visible: model.visible,
        transform: {
          position: t.position.clone(),
          rotation: t.rotation.clone(),
          scale: t.scale.clone(),
        },
        geometry: {
          center: model.geometry.center.clone(),
          geometry: model.geometry.geometry,
          supportLocalPoints: supportLocal?.points,
          supportHullKey: supportLocal?.key,
        },
      };
    });
  }, [buildHighPrecisionArrangeSupportLocalPoints]);

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
    setSupportRenderRefreshNonce((prev) => prev + 1);

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

    if (visibleModels.length <= 1) {
      if (visibleModels.length === 1) {
        const model = visibleModels[0];
        const t = getArrangeTransform(model);
        const dims = getModelSupportAwareDimensionsMm(model, undefined, t);

        const rawMinX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
        const rawMaxX = rawMinX + scene.view3dSettings.widthMm;
        const rawMinY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
        const rawMaxY = rawMinY + scene.view3dSettings.depthMm;
        const sm = scene.view3dSettings.safetyMarginMm;
        const minX = rawMinX + Math.max(0, sm?.left ?? 0);
        const maxX = rawMaxX - Math.max(0, sm?.right ?? 0);
        const minY = rawMinY + Math.max(0, sm?.front ?? 0);
        const maxY = rawMaxY - Math.max(0, sm?.back ?? 0);

        let centerX: number;
        let centerY: number;
        if (arrangeAnchorMode === 'front_left') {
          centerX = minX + dims.width * 0.5;
          centerY = minY + dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'front_right') {
          centerX = maxX - dims.width * 0.5;
          centerY = minY + dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'back_left') {
          centerX = minX + dims.width * 0.5;
          centerY = maxY - dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'back_right') {
          centerX = maxX - dims.width * 0.5;
          centerY = maxY - dims.depth * 0.5;
        } else {
          centerX = (minX + maxX) * 0.5;
          centerY = (minY + maxY) * 0.5;
        }

        // Arrange and Duplicate previews should never overlap.
        setDuplicateApplySourceModel(null);
        setDuplicateApplySourceTransform(null);
        setDuplicateSourcePreviewTransform(null);
        setDuplicatePreviewTransforms([]);
        setDuplicateTotalCopies(1);

        applyArrangeTransforms([{
          id: model.id,
          transform: {
            position: new THREE.Vector3(centerX, centerY, t.position.z),
            rotation: t.rotation.clone(),
            scale: t.scale.clone(),
          },
        }]);
      }
      return;
    }

    // Arrange and Duplicate previews should never overlap.
    setDuplicateApplySourceModel(null);
    setDuplicateApplySourceTransform(null);
    setDuplicateSourcePreviewTransform(null);
    setDuplicatePreviewTransforms([]);
    setDuplicateTotalCopies(1);

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setActiveArrangeOperation('standard');
    setArrangeOverlayModelCount(visibleModels.length);
    setIsAutoArranging(true);
    await sleep(0);

    try {
      const modelTransformById = new Map(
        visibleModels.map((model) => [model.id, getArrangeTransform(model)] as const),
      );

      const modelsWithFootprints = visibleModels.map((model) => {
        const t = modelTransformById.get(model.id) ?? model.transform;
        const baseFootprint = getModelSupportAwareDimensionsMm(model, undefined, t);
        return {
          model,
          baseWidth: baseFootprint.width,
          baseDepth: baseFootprint.depth,
        };
      });

      const rawMinX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
      const rawMaxX = rawMinX + scene.view3dSettings.widthMm;
      const rawMinY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
      const rawMaxY = rawMinY + scene.view3dSettings.depthMm;
      const arrangeSm = scene.view3dSettings.safetyMarginMm;
      const minX = rawMinX + Math.max(0, arrangeSm?.left ?? 0);
      const maxX = rawMaxX - Math.max(0, arrangeSm?.right ?? 0);
      const minY = rawMinY + Math.max(0, arrangeSm?.front ?? 0);
      const maxY = rawMaxY - Math.max(0, arrangeSm?.back ?? 0);
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

      const evaluatePacking = (
        ordered: typeof modelsWithFootprints,
        targetRowWidth: number,
        enableRotation: boolean,
      ) => {
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

          const dims = getModelSupportAwareDimensionsMm(model, angleZ, t);

          placementSizeCache.set(key, dims);
          return dims;
        };

        const getAllOptions = (current: (typeof modelsWithFootprints)[number]): PlacementOption[] => {
          const t = modelTransformById.get(current.model.id) ?? current.model.transform;
          const currentZ = t.rotation.z;
          const currentCanonical = normalizeToPi(currentZ);

          if (!enableRotation) {
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
          usedRotation: enableRotation,
        };
      };

      const countPackedItems = (layout: ReturnType<typeof evaluatePacking>) => (
        layout.rows.reduce((acc, row) => acc + row.items.length, 0)
      );

      const isBetterLayout = (
        candidate: ReturnType<typeof evaluatePacking>,
        currentBest: ReturnType<typeof evaluatePacking> | null,
      ) => {
        if (!currentBest) return true;

        if (candidate.spills.length !== currentBest.spills.length) {
          return candidate.spills.length < currentBest.spills.length;
        }

        const candidatePackedCount = countPackedItems(candidate);
        const bestPackedCount = countPackedItems(currentBest);
        if (candidatePackedCount !== bestPackedCount) {
          return candidatePackedCount > bestPackedCount;
        }

        const scoreDelta = candidate.score - currentBest.score;
        if (Math.abs(scoreDelta) > 1e-6) {
          return scoreDelta < 0;
        }

        // When layouts are effectively tied, do not force rotation.
        if (candidate.usedRotation !== currentBest.usedRotation) {
          return !candidate.usedRotation;
        }

        return false;
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
      const rotationModes = arrangeAllowRotateOnZ ? [false, true] : [false];
      for (const ordered of orderingCandidates) {
        for (const targetRowWidth of uniqueTargetRowWidths) {
          for (const enableRotation of rotationModes) {
            const layout = evaluatePacking(ordered, targetRowWidth, enableRotation);
            if (isBetterLayout(layout, bestLayout)) {
              bestLayout = layout;
            }
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
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
      setActiveArrangeOperation(null);
      setArrangeOverlayModelCount(null);
    }
  }, [arrangeAllowRotateOnZ, arrangeAnchorMode, arrangeSpacingMm, getArrangeTransform, getModelSupportAwareDimensionsMm, isAutoArranging, resolveArrangeVisibleModels, scene, sleep, transformMgr, applyArrangeTransforms]);

  const handleHighPrecisionArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);
    if (visibleModels.length <= 1) {
      if (visibleModels.length === 1) {
        const model = visibleModels[0];
        const t = getArrangeTransform(model);
        const dims = getModelSupportAwareDimensionsMm(model, undefined, t);

        const rawMinX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
        const rawMaxX = rawMinX + scene.view3dSettings.widthMm;
        const rawMinY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
        const rawMaxY = rawMinY + scene.view3dSettings.depthMm;
        const sm = scene.view3dSettings.safetyMarginMm;
        const minX = rawMinX + Math.max(0, sm?.left ?? 0);
        const maxX = rawMaxX - Math.max(0, sm?.right ?? 0);
        const minY = rawMinY + Math.max(0, sm?.front ?? 0);
        const maxY = rawMaxY - Math.max(0, sm?.back ?? 0);

        let centerX: number;
        let centerY: number;
        if (arrangeAnchorMode === 'front_left') {
          centerX = minX + dims.width * 0.5;
          centerY = minY + dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'front_right') {
          centerX = maxX - dims.width * 0.5;
          centerY = minY + dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'back_left') {
          centerX = minX + dims.width * 0.5;
          centerY = maxY - dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'back_right') {
          centerX = maxX - dims.width * 0.5;
          centerY = maxY - dims.depth * 0.5;
        } else {
          centerX = (minX + maxX) * 0.5;
          centerY = (minY + maxY) * 0.5;
        }

        // Arrange and Duplicate previews should never overlap.
        setDuplicateApplySourceModel(null);
        setDuplicateApplySourceTransform(null);
        setDuplicateSourcePreviewTransform(null);
        setDuplicatePreviewTransforms([]);
        setDuplicateTotalCopies(1);

        applyArrangeTransforms([{
          id: model.id,
          transform: {
            position: new THREE.Vector3(centerX, centerY, t.position.z),
            rotation: t.rotation.clone(),
            scale: t.scale.clone(),
          },
        }]);
      }
      return;
    }

    // Arrange and Duplicate previews should never overlap.
    setDuplicateApplySourceModel(null);
    setDuplicateApplySourceTransform(null);
    setDuplicateSourcePreviewTransform(null);
    setDuplicatePreviewTransforms([]);
    setDuplicateTotalCopies(1);

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setActiveArrangeOperation('high_precision');
    setArrangeOverlayModelCount(visibleModels.length);
    setIsAutoArranging(true);
    await sleep(0);

    try {
      const modelTransformById = new Map(
        scene.models.map((model) => [model.id, getArrangeTransform(model)] as const),
      );
      const visibleIdSet = new Set(visibleModels.map((model) => model.id));
      const highPrecisionSceneModels = buildHighPrecisionArrangeModels(scene.models, modelTransformById);
      const highPrecisionVisibleModels = highPrecisionSceneModels.filter((model) => visibleIdSet.has(model.id));

      const updates = await computeHighPrecisionArrangeUpdatesWorker({
        visibleModels: highPrecisionVisibleModels,
        sceneModels: highPrecisionSceneModels,
        widthMm: scene.view3dSettings.widthMm,
        depthMm: scene.view3dSettings.depthMm,
        originMode: scene.view3dSettings.originMode,
        arrangeSpacingMm,
        arrangeAllowRotateOnZ,
        arrangeAnchorMode,
        getArrangeTransform: (model) => model.transform,
        hullCache: arrangeHullFootprintCacheRef.current,
        safetyMarginMm: scene.view3dSettings.safetyMarginMm,
      });

      if (updates.length > 1) {
        applyArrangeTransforms(updates);
      }
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
      setActiveArrangeOperation(null);
      setArrangeOverlayModelCount(null);
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
    buildHighPrecisionArrangeModels,
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
      const projected = getModelSupportAwareDimensionsMm(model, undefined, t);
      const scaledHeight = projected.height;

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

    const rawMinX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
    const rawMaxX = rawMinX + scene.view3dSettings.widthMm;
    const rawMinY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
    const rawMaxY = rawMinY + scene.view3dSettings.depthMm;
    const arraySm = scene.view3dSettings.safetyMarginMm;
    const minX = rawMinX + Math.max(0, arraySm?.left ?? 0);
    const maxX = rawMaxX - Math.max(0, arraySm?.right ?? 0);
    const minY = rawMinY + Math.max(0, arraySm?.front ?? 0);
    const maxY = rawMaxY - Math.max(0, arraySm?.back ?? 0);

    const slotsPerLayer = countX * countY;
    const requiredLayers = Math.max(1, Math.ceil(visibleModels.length / slotsPerLayer));
    const usedCountZ = Math.max(countZ, requiredLayers);

    const totalWidth = (countX - 1) * stepX;
    const totalDepth = (countY - 1) * stepY;

    let startX = (minX + maxX) * 0.5 - totalWidth * 0.5;
    let startY = (minY + maxY) * 0.5 - totalDepth * 0.5;

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
    scene.view3dSettings.safetyMarginMm,
    scene.view3dSettings.widthMm,
    getArrangeTransform,
    getModelSupportAwareDimensionsMm,
    resolveArrangeVisibleModels,
  ]);

  const handleManualArrayArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);
    if (visibleModels.length <= 1) {
      if (visibleModels.length === 1) {
        const model = visibleModels[0];
        const t = getArrangeTransform(model);
        const dims = getModelSupportAwareDimensionsMm(model, undefined, t);

        const rawMinX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
        const rawMaxX = rawMinX + scene.view3dSettings.widthMm;
        const rawMinY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
        const rawMaxY = rawMinY + scene.view3dSettings.depthMm;
        const sm = scene.view3dSettings.safetyMarginMm;
        const minX = rawMinX + Math.max(0, sm?.left ?? 0);
        const maxX = rawMaxX - Math.max(0, sm?.right ?? 0);
        const minY = rawMinY + Math.max(0, sm?.front ?? 0);
        const maxY = rawMaxY - Math.max(0, sm?.back ?? 0);

        let centerX: number;
        let centerY: number;
        if (arrangeAnchorMode === 'front_left') {
          centerX = minX + dims.width * 0.5;
          centerY = minY + dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'front_right') {
          centerX = maxX - dims.width * 0.5;
          centerY = minY + dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'back_left') {
          centerX = minX + dims.width * 0.5;
          centerY = maxY - dims.depth * 0.5;
        } else if (arrangeAnchorMode === 'back_right') {
          centerX = maxX - dims.width * 0.5;
          centerY = maxY - dims.depth * 0.5;
        } else {
          centerX = (minX + maxX) * 0.5;
          centerY = (minY + maxY) * 0.5;
        }

        // Arrange and Duplicate previews should never overlap.
        setDuplicateApplySourceModel(null);
        setDuplicateApplySourceTransform(null);
        setDuplicateSourcePreviewTransform(null);
        setDuplicatePreviewTransforms([]);
        setDuplicateTotalCopies(1);

        applyArrangeTransforms([{
          id: model.id,
          transform: {
            position: new THREE.Vector3(centerX, centerY, t.position.z),
            rotation: t.rotation.clone(),
            scale: t.scale.clone(),
          },
        }]);
      }
      return;
    }

    // Arrange and Duplicate previews should never overlap.
    setDuplicateApplySourceModel(null);
    setDuplicateApplySourceTransform(null);
    setDuplicateSourcePreviewTransform(null);
    setDuplicatePreviewTransforms([]);
    setDuplicateTotalCopies(1);

    const minSpinnerMs = 220;
    const startedAt = performance.now();
    setActiveArrangeOperation('array');
    setArrangeOverlayModelCount(visibleModels.length);
    setIsAutoArranging(true);
    await sleep(0);

    try {
      const { updates } = computeManualArrayArrangeUpdates(scope, explicitSelectedIds);
      if (updates.length <= 1) return;

      applyArrangeTransforms(updates);
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsAutoArranging(false);
      setActiveArrangeOperation(null);
      setArrangeOverlayModelCount(null);
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

  const finalizeMirrorSessionRef = React.useRef<() => void>(() => {});
  const setTransformModeWithMirrorFinalize = React.useCallback((nextMode: TransformMode) => {
    if (transformMgr.transformMode === 'mirror' && nextMode !== 'mirror') {
      suppressTransformPersistenceCycles(10);
      finalizeMirrorSessionRef.current();
    }
    transformMgr.setTransformMode(nextMode);
  }, [suppressTransformPersistenceCycles, transformMgr.transformMode, transformMgr.setTransformMode]);

  useUndoRedoHotkeys({ disabled: hollowingEditMode });
  useDeleteHotkey();
  useCameraProjectionHotkey();
  const hasCavityGeometry = scene.activeModel
    ? cavityGeometryByModelIdRef.current.has(scene.activeModel.id)
    : false;
  useInteriorViewHotkey(
    () => setInteriorView((prev) => !prev),
    hasCavityGeometry,
  );
  usePrepareTransformHotkeys({
    appMode: scene.mode,
    hasModels: scene.models.length > 0,
    transformMode: transformMgr.transformMode,
    setTransformMode: setTransformModeWithMirrorFinalize,
    onArrangeAll: () => {
      void (arrangeLayoutMode === 'array'
        ? handleManualArrayArrangeModels('all')
        : (arrangePrecisionMode === 'high_precision'
          ? handleHighPrecisionArrangeModels('all')
          : handleAutoArrangeModels('all')));
    },
  });

  React.useEffect(() => {
    if (scene.models.length > 0) return;
    if (scene.mode === 'prepare') return;
    scene.setMode('prepare');
  }, [scene.mode, scene.models.length, scene.setMode]);

  React.useEffect(() => {
    if (scene.mode !== 'export') return;
    if (scene.models.length === 0) return;

    // Check for unapplied hole punches and warn the user.
    const hasUnapplied = scene.models.some((model) => {
      const mm = scene.getModelMeshModifiers(model.id);
      const p = mm?.holePunches;
      return p && p.length > 0 && !mm?.holePunchesBakedIntoGeometry;
    });
    if (hasUnapplied && unappliedHolePunchResolveRef.current === null) {
      setShowUnappliedHolePunchModal(true);
    }

    // In export mode, select all visible models for tinting
    const visibleModels = scene.models.filter((model) => model.visible);
    const visibleIds = visibleModels.length > 0 
      ? visibleModels.map((m) => m.id) 
      : scene.models.map((m) => m.id);

    // Set active model if none exists
    if (!scene.activeModelId) {
      const firstVisible = visibleModels[0] ?? scene.models[0];
      if (firstVisible) {
        scene.setActiveModelId(firstVisible.id);
      }
    }

    // Select all visible models for export workspace tinting
    scene.setSelectedModelIds(visibleIds);
  }, [scene.mode, scene.activeModelId, scene.models, scene.setActiveModelId]);

  // When entering arrange mode with exactly one visible model, auto-select it.
  React.useEffect(() => {
    if (scene.mode !== 'prepare') return;
    if (transformMgr.transformMode !== 'arrange') return;
    const visibleModels = scene.models.filter((m) => m.visible);
    if (visibleModels.length !== 1) return;
    const sole = visibleModels[0];
    if (scene.activeModelId === sole.id && scene.selectedModelIds.includes(sole.id)) return;
    scene.selectModel(sole.id, 'single');
  }, [scene.mode, transformMgr.transformMode, scene.models, scene.activeModelId, scene.selectedModelIds, scene.selectModel]);

  React.useEffect(() => {
    if (!hasActivePrinterProfile) return;
    if (!allowPrepareWithoutPrinter) return;
    setAllowPrepareWithoutPrinter(false);
  }, [allowPrepareWithoutPrinter, hasActivePrinterProfile]);

  React.useEffect(() => {
    // Skip camera changes during automatic re-slice flow to prevent flickering
    if (shouldReturnToPrintingAfterSliceRef.current) return;

    const persistedWorkspaceCameraSettings = getSavedWorkspaceCameraSettings();

    if (persistedWorkspaceCameraSettings.scope !== 'workspace') return;

    const workspaceProjectionMode = persistedWorkspaceCameraSettings.defaults[scene.mode];
    const currentProjectionMode = getSavedCameraProjectionSettings().mode;

    if (workspaceProjectionMode !== currentProjectionMode) {
      saveCameraProjectionSettings({ mode: workspaceProjectionMode });
    }
  }, [scene.mode, workspaceCameraSettings]);

  React.useEffect(() => {
    // Removed old per-workspace selection highlight override effect
    // const workspaceSelectionHighlightMode = getSavedWorkspaceCameraSettings().selectionHighlightDefaults[scene.mode];
    // if (workspaceSelectionHighlightMode !== scene.selectionHighlightMode) {
    //   scene.setSelectionHighlightMode(workspaceSelectionHighlightMode);
    // }
  }, [scene.mode, scene.selectionHighlightMode, scene.setSelectionHighlightMode]);



  const effectiveSelectionHighlightMode = React.useMemo(() => {
    if (scene.mode === 'printing') return 'none';
    if (scene.mode !== 'support') return scene.selectionHighlightMode;
    if (isSupportSpotlightHoldActive) return 'spotlight';
    return scene.selectionHighlightMode === 'spotlight' ? 'tint' : scene.selectionHighlightMode;
  }, [isSupportSpotlightHoldActive, scene.mode, scene.selectionHighlightMode]);

  const isTransitioningOutOfPrinting = scene.mode !== 'printing' && previousSceneModeRef.current === 'printing';

  const sceneClipLower = React.useMemo(() => {
    if (isTemporarilyDisablingCrossSectionForThumbnail) return null;
    if (!isCrossSectionEnabled) return null;
    if (scene.mode === 'printing' || isTransitioningOutOfPrinting) return null;
    return slicing.clipLower;
  }, [isCrossSectionEnabled, isTemporarilyDisablingCrossSectionForThumbnail, isTransitioningOutOfPrinting, scene.mode, slicing.clipLower]);

  const sceneClipUpper = React.useMemo(() => {
    if (isTemporarilyDisablingCrossSectionForThumbnail) return null;
    if (!isCrossSectionEnabled) return null;
    if (scene.mode === 'printing' || isTransitioningOutOfPrinting) return null;
    return slicing.clipUpper;
  }, [isCrossSectionEnabled, isTemporarilyDisablingCrossSectionForThumbnail, isTransitioningOutOfPrinting, scene.mode, slicing.clipUpper]);

  const effectiveHoverTintStrengthForScene = React.useMemo(() => {
    return scene.mode === 'printing' ? 0 : scene.hoverTintStrength;
  }, [scene.hoverTintStrength, scene.mode]);

  const effectiveSelectedTintStrengthForScene = React.useMemo(() => {
    return scene.mode === 'printing' ? 0 : scene.selectedTintStrength;
  }, [scene.mode, scene.selectedTintStrength]);

  const sceneCanvasActiveModelId = React.useMemo(() => {
    if (scene.mode === 'printing') return null;
    return displayActiveModelId;
  }, [displayActiveModelId, scene.mode]);

  const sceneCanvasVisualActiveModelId = React.useMemo(() => {
    if (scene.mode === 'printing') return null;
    return scene.activeModelId;
  }, [scene.activeModelId, scene.mode]);

  const sceneCanvasSelectedModelIds = React.useMemo(() => {
    if (scene.mode === 'printing') return [] as string[];
    return scene.selectedModelIds;
  }, [scene.mode, scene.selectedModelIds]);

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
    if (nativePickerPreparationState.active) {
      return {
        active: true,
        label: nativePickerPreparationState.label,
        detail: nativePickerPreparationState.detail,
        progress: nativePickerPreparationState.progress,
      };
    }

    if (scene.importProgress.active) {
      return {
        active: true,
        label: scene.importProgress.label || (scene.importProgress.type === 'scene' ? 'Loading Scene…' : 'Loading Mesh…'),
        detail: scene.importProgress.detail,
        progress: scene.importProgress.progress,
      };
    }

    if (scene.pluginImportPhase === 'processing') {
      return {
        active: true,
        label: 'Loading LYS Scene…',
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
  }, [nativePickerPreparationState, scene.importProgress, scene.pluginImportPhase]);

  const showInlineEmptyLoading = scene.models.length === 0 && (importOverlayState.active || pendingStartupSceneHandoff);
  const [holdEmptyStateSceneImportUi, setHoldEmptyStateSceneImportUi] = React.useState(false);

  React.useEffect(() => {
    const isSceneImportActive =
      (scene.importProgress.active
        && (scene.importProgress.type === 'scene' || scene.importProgress.type === 'mesh'))
      || scene.pluginImportPhase === 'processing';

    if (isSceneImportActive && scene.models.length === 0) {
      setHoldEmptyStateSceneImportUi(true);
      return;
    }

    if (!isSceneImportActive && holdEmptyStateSceneImportUi) {
      setHoldEmptyStateSceneImportUi(false);
    }
  }, [holdEmptyStateSceneImportUi, scene.importProgress.active, scene.importProgress.type, scene.pluginImportPhase, scene.models.length]);

  const showEmptyStatePanel = scene.models.length === 0 || holdEmptyStateSceneImportUi;
  const showEmptyStateLoading = showInlineEmptyLoading || holdEmptyStateSceneImportUi;
  const showSceneImportOverlay = scene.models.length > 0 && importOverlayState.active && !holdEmptyStateSceneImportUi;
  const showEmptySceneDialog = scene.models.length === 0;
  const emptyStateLoadingLabel = pendingStartupSceneHandoff
    ? 'Opening scene…'
    : importOverlayState.label;
  const emptyStateLoadingDetail = pendingStartupSceneHandoff
    ? 'Letting DragonFruit finish its startup animation before loading your scene.'
    : importOverlayState.detail;

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
      // handleTransformEnd flushes the raw rotated transform first so support
      // geometry can catch up. Once auto-lift adjusts Z, we need to let the
      // normal persistence effect write that lifted result back to the model.
      transformEndFlushedRef.current = false;
    } finally {
      postRotateLiftScheduledRef.current = false;
    }
  };

  const handleTransformEnd = (
    operation: 'move' | 'rotate' | 'scale',
    finalTransform?: ModelTransform,
    options?: { skipStoreCommit?: boolean },
  ) => {
    const stampNow = () => ({ perfMs: performance.now(), epochMs: Date.now() });
    const releasePerf = performance.now();

    transformDebugTimelineRef.current.lastOperation = operation;
    transformDebugTimelineRef.current.dragReleasedAt = {
      perfMs: releasePerf,
      epochMs: Date.now(),
    };
    if (finalTransform) {
      transformDebugTimelineRef.current.liveCalculatedAt = stampNow();
    }

    if (options?.skipStoreCommit) {
      transformMgr.setIsTransforming(false);
      transformMgr.pendingTransformRef.current = null;
      invalidatePendingTransformHistory();
      return;
    }

    let transformCommitResult: TransformStoreCommitResult = {
      updated: false,
      supportsChanged: false,
      kickstandsChanged: false,
    };
    const expectedModelTransforms: Array<{ modelId: string; transform: ModelTransform }> = [];

    // Flush the final model transform into the store synchronously so
    // transformSupportsForModel() recalculates all support positions before
    // we reset the visual drag-group matrix. This eliminates the 1-frame
    // flash where supports snap back to their pre-drag positions.
    if (scene.activeModelId && displayActiveModelId === scene.activeModelId) {
      const pending = transformMgr.pendingTransformRef.current;
      const pendingHistory = pendingTransformHistoryRef.current;
      const current = (
        finalTransform && isFiniteTransform(finalTransform)
      )
        ? {
            position: finalTransform.position.clone(),
            rotation: finalTransform.rotation.clone(),
            scale: finalTransform.scale.clone(),
          }
        : (
          pending && isFiniteTransform({ position: pending.pos, rotation: pending.rot, scale: pending.scl })
        )
          ? {
              position: pending.pos.clone(),
              rotation: pending.rot.clone(),
              scale: pending.scl.clone(),
            }
          : transformMgr.transform;
      if (isFiniteTransform(current)) {
        if (!finalTransform) {
          transformDebugTimelineRef.current.liveCalculatedAt = stampNow();
        }

        // Keep drag delta active through store commit so live preview remains
        // visually stable; SceneCanvas reconciliation clears the matrix only
        // after committed/live transforms are actually aligned.

        const explicitBeforeTransform = (
          pendingHistory && pendingHistory.modelId === scene.activeModelId
        )
          ? {
              position: pendingHistory.before.position.clone(),
              rotation: pendingHistory.before.rotation.clone(),
              scale: pendingHistory.before.scale.clone(),
            }
          : undefined;

        transformDebugTimelineRef.current.storeUpdateStartedAt = stampNow();
        const committedTransform = {
          position: current.position.clone(),
          rotation: current.rotation.clone(),
          scale: current.scale.clone(),
        };
        transformCommitResult = scene.updateModelTransform(
          scene.activeModelId,
          committedTransform,
          explicitBeforeTransform,
        );
        transformDebugTimelineRef.current.storeUpdatedAt = stampNow();

        if (transformCommitResult.updated) {
          expectedModelTransforms.push({
            modelId: scene.activeModelId,
            transform: {
              position: committedTransform.position.clone(),
              rotation: committedTransform.rotation.clone(),
              scale: committedTransform.scale.clone(),
            },
          });
        }

        beginSupportDragSyncTransaction(expectedModelTransforms, transformCommitResult);
        // Prevent the persistence effect from applying the same delta a second time
        transformEndFlushedRef.current = true;

        // Eagerly sync transformMgr so the `transform` prop into SceneCanvas reflects
        // the final position in the same React batch as `isGizmoDragging = false`.
        // Without this, rawActiveTransformForRender falls through to the stale
        // transformMgr.transform for one frame, causing a one-frame position flash.
        if (transformCommitResult.updated) {
          transformMgr.transformHook.setPosition(committedTransform.position.x, committedTransform.position.y, committedTransform.position.z);
          transformMgr.transformHook.setRotation(committedTransform.rotation.x, committedTransform.rotation.y, committedTransform.rotation.z);
          transformMgr.transformHook.setScale(committedTransform.scale.x, committedTransform.scale.y, committedTransform.scale.z);
        }
      }
    }

    if (expectedModelTransforms.length === 0) {
      beginSupportDragSyncTransaction(expectedModelTransforms, transformCommitResult);
    }

    // Do not eagerly reset support drag-group matrix here.
    // SceneCanvas reconciles dragGroup matrix from committed-vs-live transforms
    // and only returns to identity/auto-update once both are actually in sync.

    const targetModelId = scene.activeModelId;
    const targetModelName = (scene.activeModel?.name ?? targetModelId ?? 'Model').trim();

    if (operation === 'rotate' && pendingRotateGizmoCommitRef.current && targetModelId === pendingRotateGizmoCommitRef.current.modelId) {
      pendingTransformHistoryRef.current = {
        modelId: pendingRotateGizmoCommitRef.current.modelId,
        before: {
          position: pendingRotateGizmoCommitRef.current.before.position.clone(),
          rotation: pendingRotateGizmoCommitRef.current.before.rotation.clone(),
          scale: pendingRotateGizmoCommitRef.current.before.scale.clone(),
        },
        after: {
          position: pendingRotateGizmoCommitRef.current.after.position.clone(),
          rotation: pendingRotateGizmoCommitRef.current.after.rotation.clone(),
          scale: pendingRotateGizmoCommitRef.current.after.scale.clone(),
        },
        description: pendingRotateGizmoCommitRef.current.description,
        supportBefore: pendingTransformHistoryRef.current?.supportBefore,
        kickstandBefore: pendingTransformHistoryRef.current?.kickstandBefore,
      };
      pendingRotateGizmoCommitRef.current = null;
    }

    if (pendingTransformHistoryRef.current && targetModelId && pendingTransformHistoryRef.current.modelId === targetModelId) {
      pendingTransformHistoryRef.current.description = `transform:${operation} ${targetModelName}`;
    }

    transformMgr.setIsTransforming(false);

    if (operation === 'rotate') {
      islands.clearScanData();
      applyPostRotateLift();
    } else {
      transformMgr.pendingTransformRef.current = null;
    }

    if (pendingTransformHistoryRef.current && targetModelId && pendingTransformHistoryRef.current.modelId === targetModelId) {
      const pendingTransform = transformMgr.pendingTransformRef.current;
      const afterFromPending = (
        pendingTransform
        && isFiniteTransform({
          position: pendingTransform.pos,
          rotation: pendingTransform.rot,
          scale: pendingTransform.scl,
        })
      )
        ? {
            position: pendingTransform.pos.clone(),
            rotation: pendingTransform.rot.clone(),
            scale: pendingTransform.scl.clone(),
          }
        : null;

      const afterFromTransform = isFiniteTransform(transformMgr.transform)
        ? {
            position: transformMgr.transform.position.clone(),
            rotation: transformMgr.transform.rotation.clone(),
            scale: transformMgr.transform.scale.clone(),
          }
        : null;

      const afterFromFinal = finalTransform && isFiniteTransform(finalTransform)
        ? {
            position: finalTransform.position.clone(),
            rotation: finalTransform.rotation.clone(),
            scale: finalTransform.scale.clone(),
          }
        : null;

      const existingAfter = pendingTransformHistoryRef.current.after && isFiniteTransform(pendingTransformHistoryRef.current.after)
        ? {
            position: pendingTransformHistoryRef.current.after.position.clone(),
            rotation: pendingTransformHistoryRef.current.after.rotation.clone(),
            scale: pendingTransformHistoryRef.current.after.scale.clone(),
          }
        : null;

      const existingAfterIsMeaningful = existingAfter
        ? !transformsApproximatelyEqual(pendingTransformHistoryRef.current.before, existingAfter)
        : false;

      if (!existingAfterIsMeaningful) {
        pendingTransformHistoryRef.current.after = afterFromFinal ?? afterFromPending ?? afterFromTransform ?? existingAfter ?? undefined;
      }

      const afterSupportSnapshot = captureTransformSupportSnapshot();
      pendingTransformHistoryRef.current.supportAfter = afterSupportSnapshot.support;
      pendingTransformHistoryRef.current.kickstandAfter = afterSupportSnapshot.kickstand;
    }

    const skipCommitToken = skipNextTransformEndCommitRef.current;
    if (
      skipCommitToken
      && targetModelId
      && skipCommitToken.modelId === targetModelId
      && skipCommitToken.operation === operation
    ) {
      skipNextTransformEndCommitRef.current = null;
      invalidatePendingTransformHistory();
      return;
    }

    if (operation === 'rotate') {
      commitPendingTransformHistory();
      return;
    }

    scheduleCommitPendingTransformHistory(1);
  };

  const handleGizmoTransformCommit = React.useCallback((payload: {
    modelId: string;
    operation: 'move' | 'rotate' | 'scale';
    before: ModelTransform;
    after: ModelTransform;
  }) => {
    const targetModel = scene.models.find((model) => model.id === payload.modelId);
    const targetModelName = (targetModel?.name ?? payload.modelId).trim();

    if (payload.operation === 'rotate') {
      pendingRotateGizmoCommitRef.current = {
        modelId: payload.modelId,
        before: {
          position: payload.before.position.clone(),
          rotation: payload.before.rotation.clone(),
          scale: payload.before.scale.clone(),
        },
        after: {
          position: payload.after.position.clone(),
          rotation: payload.after.rotation.clone(),
          scale: payload.after.scale.clone(),
        },
        description: `transform:${payload.operation} ${targetModelName}`,
      };
      skipNextTransformEndCommitRef.current = null;
      return;
    }

    // For move/scale, defer history commit to handleTransformEnd where support state
    // has already been transformed in-store. Early commits from this callback can
    // capture stale support "after" snapshots, which breaks redo.
    const existing = pendingTransformHistoryRef.current;
    if (existing && existing.modelId === payload.modelId) {
      existing.before = {
        position: payload.before.position.clone(),
        rotation: payload.before.rotation.clone(),
        scale: payload.before.scale.clone(),
      };
      existing.after = {
        position: payload.after.position.clone(),
        rotation: payload.after.rotation.clone(),
        scale: payload.after.scale.clone(),
      };
      existing.description = `transform:${payload.operation} ${targetModelName}`;
    } else {
      const beforeSupportSnapshot = captureTransformSupportSnapshot();
      pendingTransformHistoryRef.current = {
        modelId: payload.modelId,
        before: {
          position: payload.before.position.clone(),
          rotation: payload.before.rotation.clone(),
          scale: payload.before.scale.clone(),
        },
        after: {
          position: payload.after.position.clone(),
          rotation: payload.after.rotation.clone(),
          scale: payload.after.scale.clone(),
        },
        description: `transform:${payload.operation} ${targetModelName}`,
        supportBefore: beforeSupportSnapshot.support,
        kickstandBefore: beforeSupportSnapshot.kickstand,
      };
    }

    skipNextTransformEndCommitRef.current = null;
  }, [captureTransformSupportSnapshot, scene]);

  const handleGizmoTransformGroupCommit = React.useCallback((payload: {
    operation: 'move' | 'rotate' | 'scale';
    entries: Array<{
      modelId: string;
      before: ModelTransform;
      after: ModelTransform;
    }>;
  }) => {
    if (payload.entries.length === 0) return;

    const hasMeaningfulChange = (before: ModelTransform, after: ModelTransform) => {
      const EPSILON = 1e-6;
      return (
        before.position.distanceToSquared(after.position) > EPSILON
        || before.scale.distanceToSquared(after.scale) > EPSILON
        || Math.abs(before.rotation.x - after.rotation.x) > EPSILON
        || Math.abs(before.rotation.y - after.rotation.y) > EPSILON
        || Math.abs(before.rotation.z - after.rotation.z) > EPSILON
      );
    };

    const updates = payload.entries
      .filter((entry) => isFiniteTransform(entry.after) && hasMeaningfulChange(entry.before, entry.after))
      .map((entry) => ({
        id: entry.modelId,
        transform: {
          position: entry.after.position.clone(),
          rotation: entry.after.rotation.clone(),
          scale: entry.after.scale.clone(),
        },
      }));

    if (updates.length === 0) {
      beginSupportDragSyncTransaction([], {
        updated: false,
        supportsChanged: false,
        kickstandsChanged: false,
      });
      return;
    }

    const transformCommitResult = scene.updateModelTransforms(updates);
    beginSupportDragSyncTransaction(
      transformCommitResult.updated
        ? updates.map((entry) => ({
            modelId: entry.id,
            transform: {
              position: entry.transform.position.clone(),
              rotation: entry.transform.rotation.clone(),
              scale: entry.transform.scale.clone(),
            },
          }))
        : [],
      transformCommitResult,
    );

    const activeUpdate = scene.activeModelId
      ? updates.find((entry) => entry.id === scene.activeModelId)
      : undefined;
    if (activeUpdate) {
      const { position, rotation, scale } = activeUpdate.transform;
      transformMgr.transformHook.setPosition(position.x, position.y, position.z);
      transformMgr.transformHook.setRotation(rotation.x, rotation.y, rotation.z);
      transformMgr.transformHook.setScale(scale.x, scale.y, scale.z);
    }

    setSupportRenderRefreshNonce((value) => value + 1);
    skipNextTransformEndCommitRef.current = null;
  }, [beginSupportDragSyncTransaction, isFiniteTransform, scene, transformMgr.transformHook]);

  const handleAutoLiftChange = React.useCallback((enabled: boolean) => {
    if (scene.activeModelId) {
      scene.setModelManualZMoveOverride(scene.activeModelId, false);
    }
    transformMgr.setAutoLift(enabled);
  }, [scene, transformMgr]);

  const disableAutoLiftForManualZMove = React.useCallback(() => {
    if (!scene.activeModelId) return;
    scene.setModelManualZMoveOverride(scene.activeModelId, true);
    transformMgr.disableAutoLiftForManualZMove();
  }, [scene, transformMgr]);

  const handleTransformStart = React.useCallback((
    operation: 'move' | 'rotate' | 'scale',
    details?: { axis?: 'x' | 'y' | 'z' | 'uniform'; isUniform?: boolean },
  ) => {
    skipNextTransformEndCommitRef.current = null;

    if (typeof window !== 'undefined' && supportDragResetRafRef.current !== null) {
      window.cancelAnimationFrame(supportDragResetRafRef.current);
      supportDragResetRafRef.current = null;
    }
    if (typeof window !== 'undefined' && supportDragResetSecondRafRef.current !== null) {
      window.cancelAnimationFrame(supportDragResetSecondRafRef.current);
      supportDragResetSecondRafRef.current = null;
    }

    if (operation === 'rotate' && (details?.axis === 'x' || details?.axis === 'y')) {
      const proceed = requestDestructiveTransformSupportDeletion('Rotate X/Y');
      if (!proceed) return false;
    }

    if (operation === 'scale') {
      const proceed = requestDestructiveTransformSupportDeletion('Scale XYZ');
      if (!proceed) return false;
    }

    if (!scene.activeModelId || !scene.activeModel) return;
    const targetModelName = (scene.activeModel.name ?? scene.activeModelId).trim();

    if (operation === 'move' && details?.axis === 'z') {
      disableAutoLiftForManualZMove();
    }

    if (!pendingTransformHistoryRef.current || pendingTransformHistoryRef.current.modelId !== scene.activeModelId) {
      pendingTransformHistoryRef.current = {
        modelId: scene.activeModelId,
        before: {
          position: scene.activeModel.transform.position.clone(),
          rotation: scene.activeModel.transform.rotation.clone(),
          scale: scene.activeModel.transform.scale.clone(),
        },
        description: `transform:${operation} ${targetModelName}`,
        supportBefore: captureTransformSupportSnapshot().support,
        kickstandBefore: captureTransformSupportSnapshot().kickstand,
      };
    }

    if (operation === 'rotate') {
      pendingRotateGizmoCommitRef.current = null;
    }

    return true;
  }, [captureTransformSupportSnapshot, disableAutoLiftForManualZMove, requestDestructiveTransformSupportDeletion, scene.activeModel, scene.activeModelId]);

  const ensurePendingTransformHistoryForActiveModel = React.useCallback((operation: 'move' | 'rotate' | 'scale') => {
    if (!scene.activeModelId || !scene.activeModel) return;

    const targetModelName = (scene.activeModel.name ?? scene.activeModelId).trim();
    if (!pendingTransformHistoryRef.current || pendingTransformHistoryRef.current.modelId !== scene.activeModelId) {
      const beforeSupportSnapshot = captureTransformSupportSnapshot();
      pendingTransformHistoryRef.current = {
        modelId: scene.activeModelId,
        before: {
          position: scene.activeModel.transform.position.clone(),
          rotation: scene.activeModel.transform.rotation.clone(),
          scale: scene.activeModel.transform.scale.clone(),
        },
        after: isFiniteTransform(transformMgr.transform)
          ? {
              position: transformMgr.transform.position.clone(),
              rotation: transformMgr.transform.rotation.clone(),
              scale: transformMgr.transform.scale.clone(),
            }
          : undefined,
        description: `transform:${operation} ${targetModelName}`,
        supportBefore: beforeSupportSnapshot.support,
        kickstandBefore: beforeSupportSnapshot.kickstand,
      };
      return;
    }

    pendingTransformHistoryRef.current.description = `transform:${operation} ${targetModelName}`;
    if (isFiniteTransform(transformMgr.transform)) {
      pendingTransformHistoryRef.current.after = {
        position: transformMgr.transform.position.clone(),
        rotation: transformMgr.transform.rotation.clone(),
        scale: transformMgr.transform.scale.clone(),
      };
    }
  }, [captureTransformSupportSnapshot, isFiniteTransform, scene.activeModel, scene.activeModelId, transformMgr.transform]);

  React.useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && supportDragResetRafRef.current !== null) {
        window.cancelAnimationFrame(supportDragResetRafRef.current);
        supportDragResetRafRef.current = null;
      }
      if (typeof window !== 'undefined' && supportDragResetSecondRafRef.current !== null) {
        window.cancelAnimationFrame(supportDragResetSecondRafRef.current);
        supportDragResetSecondRafRef.current = null;
      }
      if (typeof window !== 'undefined' && supportSyncFallbackTimeoutRef.current !== null) {
        window.clearTimeout(supportSyncFallbackTimeoutRef.current);
        supportSyncFallbackTimeoutRef.current = null;
      }
    };
  }, []);

  const handleRotationComplete = () => {
    const targetModelId = scene.activeModelId;
    const targetModelName = (scene.activeModel?.name ?? targetModelId ?? 'Model').trim();
    if (pendingTransformHistoryRef.current && targetModelId && pendingTransformHistoryRef.current.modelId === targetModelId) {
      pendingTransformHistoryRef.current.description = `transform:rotate ${targetModelName}`;
      if (isFiniteTransform(transformMgr.transform)) {
        pendingTransformHistoryRef.current.after = {
          position: transformMgr.transform.position.clone(),
          rotation: transformMgr.transform.rotation.clone(),
          scale: transformMgr.transform.scale.clone(),
        };
      }
    } else {
      // No pending entry means no meaningful rotation delta was staged.
      return;
    }

    islands.clearScanData();
    applyPostRotateLift();
    commitPendingTransformHistory();
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


  const selectAllActive = useActionActive('CANVAS', 'SELECT_ALL');
  const copyActive = useActionActive('CANVAS', 'COPY');
  const pasteActive = useActionActive('CANVAS', 'PASTE');
  const saveActive = useActionActive('GLOBAL', 'SAVE');
  const saveAsActive = useActionActive('GLOBAL', 'SAVE_AS');
  const wasSelectAllActive = React.useRef(false);
  const wasCopyActive = React.useRef(false);
  const wasPasteActive = React.useRef(false);
  const wasSaveActive = React.useRef(false);
  const wasSaveAsActive = React.useRef(false);

  React.useEffect(() => {
    if (!selectAllActive || wasSelectAllActive.current) {
      wasSelectAllActive.current = selectAllActive;
      return;
    }
    wasSelectAllActive.current = true;

    if (scene.models.length === 0) return;
    const visibleIds = scene.models.filter((model) => model.visible).map((model) => model.id);
    if (visibleIds.length > 0) {
      scene.setSelectedModelIds(visibleIds);
      scene.setActiveModelId(visibleIds[0]);
    }
    setIsSelectAllModelsActive(true);
  }, [selectAllActive, scene, setIsSelectAllModelsActive]);

  React.useEffect(() => {
    if (!copyActive || wasCopyActive.current) {
      wasCopyActive.current = copyActive;
      return;
    }
    wasCopyActive.current = true;

    if (scene.mode !== 'prepare') return;
    if (scene.selectedModelIds.length === 0 && !scene.activeModelId) return;
    if (scene.selectedModelIds.length > 0) {
      scene.copySelectedModels();
    } else if (scene.activeModelId) {
      scene.copyModel(scene.activeModelId);
    }
  }, [copyActive, scene]);

  React.useEffect(() => {
    if (!pasteActive || wasPasteActive.current) {
      wasPasteActive.current = pasteActive;
      return;
    }
    wasPasteActive.current = true;

    if (scene.mode !== 'prepare') return;
    if (!scene.canPasteModel) return;
    const pastedIds = scene.pasteCopiedModelsAutoArrange(arrangeSpacingMm);
    // Paste shares geometry with the source — add its cached volume directly
    // instead of waiting for the async resin effect loop.
    if (pastedIds.length > 0 && printingEstimatedResinMlRef.current != null) {
      const pastedModel = scene.models.find((m) => pastedIds.includes(m.id));
      if (pastedModel) {
        const geom = pastedModel.geometry.geometry;
        const pos = geom.getAttribute('position');
        const idx = geom.getIndex();
        const sourceKey = String(geom.userData?.resinVolumeSourceKey ?? geom.uuid);
        const posVer = (pos as { version?: number; data?: { version?: number } }).version
          ?? (pos as { version?: number; data?: { version?: number } }).data?.version ?? 0;
        const idxVer = (idx as { version?: number } | null)?.version ?? 0;
        const cacheKey = `${sourceKey}:${posVer}:${idxVer}`;
        const cachedMl = printingBaseResinMlCacheRef.current.get(cacheKey) ?? null;
        if (cachedMl != null) {
          const sx = Math.abs(pastedModel.transform.scale.x || 1);
          const sy = Math.abs(pastedModel.transform.scale.y || 1);
          const sz = Math.abs(pastedModel.transform.scale.z || 1);
          const addedMl = cachedMl * sx * sy * sz;
          const nextTotal = (printingEstimatedResinMlRef.current - supportAndRaftResinMl) + addedMl + supportAndRaftResinMl;
          printingEstimatedResinMlRef.current = nextTotal;
          setPrintingEstimatedResinMl(nextTotal);
        }
      }
    }
  }, [pasteActive, scene, arrangeSpacingMm, printingEstimatedResinMlRef, supportAndRaftResinMl, printingBaseResinMlCacheRef, setPrintingEstimatedResinMl]);

  React.useEffect(() => {
    if (!saveActive || wasSaveActive.current) {
      wasSaveActive.current = saveActive;
      return;
    }
    wasSaveActive.current = true;

    if (scene.models.length === 0) return;
    void handleTopBarSaveScene();
  }, [saveActive, scene.models.length, handleTopBarSaveScene]);

  React.useEffect(() => {
    if (!saveAsActive || wasSaveAsActive.current) {
      wasSaveAsActive.current = saveAsActive;
      return;
    }
    wasSaveAsActive.current = true;

    if (scene.models.length === 0) return;
    handleTopBarSaveSceneAs();
  }, [saveAsActive, scene.models.length, handleTopBarSaveSceneAs]);

  React.useEffect(() => {
    let cancelled = false;

    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'arrange') {
      setDuplicatePreviewTransforms([]);
      setDuplicateSourcePreviewTransform(null);
      return () => {
        cancelled = true;
      };
    }

    if (!scene.activeModel) {
      setDuplicatePreviewTransforms([]);
      setDuplicateSourcePreviewTransform(null);
      return () => {
        cancelled = true;
      };
    }

    const model = scene.activeModel;

    if (duplicateLayoutMode === 'auto' && duplicatePrecisionMode === 'high_precision') {
      setDuplicatePreviewTransforms([]);
      setDuplicateSourcePreviewTransform(null);
      return () => {
        cancelled = true;
      };
    }

    const sourceDims = getModelSupportAwareDimensionsMm(model, undefined, model.transform);
    const width = sourceDims.width;
    const depth = sourceDims.depth;
    const height = sourceDims.height;

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

      const rawDupMinX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
      const rawDupMaxX = rawDupMinX + scene.view3dSettings.widthMm;
      const rawDupMinY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
      const rawDupMaxY = rawDupMinY + scene.view3dSettings.depthMm;
      const dupSm = scene.view3dSettings.safetyMarginMm;
      const minX = rawDupMinX + Math.max(0, dupSm?.left ?? 0);
      const maxX = rawDupMaxX - Math.max(0, dupSm?.right ?? 0);
      const minY = rawDupMinY + Math.max(0, dupSm?.front ?? 0);
      const maxY = rawDupMaxY - Math.max(0, dupSm?.back ?? 0);

      const plateWidth = Math.max(1, maxX - minX);
      const plateDepth = Math.max(1, maxY - minY);

      // Add small epsilon to prevent floating point edge cases when spacing is very small
      const gridSpacing = spacing > 0 ? spacing : 0.001;
      const maxCols = Math.max(1, Math.floor((plateWidth + gridSpacing) / (width + gridSpacing)));
      const maxRows = Math.max(1, Math.floor((plateDepth + gridSpacing) / (depth + gridSpacing)));
      const usedCols = maxCols;
      const usedRows = maxRows;

      // Use actual spacing (including 0) for layout, not gridSpacing
      const totalUsedWidth = (usedCols * width) + Math.max(0, usedCols - 1) * spacing;
      const totalUsedDepth = (usedRows * depth) + Math.max(0, usedRows - 1) * spacing;

      const startX = minX + ((plateWidth - totalUsedWidth) * 0.5) + (width * 0.5);
      const startY = minY + ((plateDepth - totalUsedDepth) * 0.5) + (depth * 0.5);

      const projectPolygon = (poly: THREE.Vector2[], axis: THREE.Vector2) => {
        let min = Infinity;
        let max = -Infinity;
        for (const point of poly) {
          const projected = point.dot(axis);
          min = Math.min(min, projected);
          max = Math.max(max, projected);
        }
        return { min, max };
      };

      const polygonsOverlap = (a: THREE.Vector2[], b: THREE.Vector2[]) => {
        const testAxes = (poly: THREE.Vector2[]) => {
          for (let i = 0; i < poly.length; i += 1) {
            const p0 = poly[i];
            const p1 = poly[(i + 1) % poly.length];
            const edge = new THREE.Vector2(p1.x - p0.x, p1.y - p0.y);
            if (edge.lengthSq() <= 1e-10) continue;
            const axis = new THREE.Vector2(-edge.y, edge.x).normalize();
            const pa = projectPolygon(a, axis);
            const pb = projectPolygon(b, axis);
            if (pa.max <= pb.min + spacing || pb.max <= pa.min + spacing) return false;
          }
          return true;
        };
        return testAxes(a) && testAxes(b);
      };

      const blockedPolygons = scene.models
        .filter((m) => m.visible && m.id !== model.id)
        .map((m) => getModelSupportAwareFootprintPolygonRef.current(m, undefined, m.transform));

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

        const candidateTransform = {
          position: new THREE.Vector3(candidate.x, candidate.y, model.transform.position.z),
          rotation: model.transform.rotation.clone(),
          scale: model.transform.scale.clone(),
        };
        const candidatePolygon = getModelSupportAwareFootprintPolygonRef.current(model, undefined, candidateTransform);

        if (blockedPolygons.some((blocked) => polygonsOverlap(candidatePolygon, blocked))) {
          continue;
        }

        chosenCenters.push({ x: candidate.x, y: candidate.y });
        blockedPolygons.push(candidatePolygon);
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

    return () => {
      cancelled = true;
    };
  }, [
    buildHighPrecisionArrangeModels,
    duplicateArrayCountX,
    duplicateArrayCountY,
    duplicateArrayCountZ,
    duplicateArrayGapX,
    duplicateArrayGapY,
    duplicateArrayGapZ,
    duplicateLayoutMode,
    duplicatePrecisionMode,
    duplicateSpacingMm,
    duplicateTotalCopies,
    getModelSupportAwareDimensionsMm,
    scene.activeModel,
    scene.models,
    scene.mode,
    scene.view3dSettings.safetyMarginMm,
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
      const createdIds = scene.duplicateModelWithTransforms(
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

      const firstCreatedId = createdIds[0] ?? null;
      const firstCreatedTransform = duplicatePreviewTransforms[0] ?? null;
      if (firstCreatedId && firstCreatedTransform) {
        setDisplayActiveModelId(firstCreatedId);
        transformMgr.transformHook.setPosition(
          firstCreatedTransform.position.x,
          firstCreatedTransform.position.y,
          firstCreatedTransform.position.z,
        );
        transformMgr.transformHook.setRotation(
          firstCreatedTransform.rotation.x,
          firstCreatedTransform.rotation.y,
          firstCreatedTransform.rotation.z,
        );
        transformMgr.transformHook.setScale(
          firstCreatedTransform.scale.x,
          firstCreatedTransform.scale.y,
          firstCreatedTransform.scale.z,
        );
      }

      setDuplicateTotalCopies(1);
      setDuplicateSourcePreviewTransform(null);
      setDuplicatePreviewTransforms([]);
    } finally {
      const elapsed = performance.now() - startedAt;
      if (elapsed < minSpinnerMs) {
        await sleep(minSpinnerMs - elapsed);
      }
      setIsDuplicating(false);
      setDuplicateApplySourceModel(null);
      setDuplicateApplySourceTransform(null);
    }
  }, [duplicatePreviewTransforms, duplicateSourcePreviewTransform, isDuplicating, scene, sleep, transformMgr.transformHook]);

  const handleFillPlateDuplicate = React.useCallback(async () => {
    if (isDuplicating || isAutoArranging) return;
    if (duplicateLayoutMode !== 'auto') return;
    const model = scene.activeModel;
    if (!model) return;

    if (duplicatePrecisionMode === 'high_precision') {
      const minSpinnerMs = 220;
      const startedAt = performance.now();
      const maxProbeCopies = 128;

      setDuplicateApplySourceModel(null);
      setDuplicateApplySourceTransform(null);
      setDuplicateSourcePreviewTransform(null);
      setDuplicatePreviewTransforms([]);
      setIsDuplicating(true);
      setActiveArrangeOperation('high_precision_fill');
      setArrangeOverlayModelCount(maxProbeCopies);
      setIsAutoArranging(true);
      await sleep(0);

      try {
        const modelTransformById = new Map(
          scene.models.map((sceneModel) => [sceneModel.id, sceneModel.transform] as const),
        );
        const highPrecisionSceneModels = buildHighPrecisionArrangeModels(scene.models, modelTransformById);
        const highPrecisionSourceModel = highPrecisionSceneModels.find((candidate) => candidate.id === model.id);
        if (!highPrecisionSourceModel) return;

        const duplicateSceneModels: HighPrecisionArrangeModel[] = Array.from({ length: maxProbeCopies }, (_, index) => ({
          ...highPrecisionSourceModel,
          id: `${model.id}__duplicate_fill_${index}`,
          visible: true,
          transform: {
            position: highPrecisionSourceModel.transform.position.clone(),
            rotation: highPrecisionSourceModel.transform.rotation.clone(),
            scale: highPrecisionSourceModel.transform.scale.clone(),
          },
          geometry: {
            center: highPrecisionSourceModel.geometry.center.clone(),
            geometry: highPrecisionSourceModel.geometry.geometry,
            supportLocalPoints: highPrecisionSourceModel.geometry.supportLocalPoints?.map((point) => point.clone()),
            supportHullKey: highPrecisionSourceModel.geometry.supportHullKey,
          },
        }));

        const result = await computeHighPrecisionArrangeResultWorker({
          visibleModels: duplicateSceneModels,
          sceneModels: [...highPrecisionSceneModels.filter((sceneModel) => sceneModel.id !== model.id), ...duplicateSceneModels],
          widthMm: scene.view3dSettings.widthMm,
          depthMm: scene.view3dSettings.depthMm,
          originMode: scene.view3dSettings.originMode,
          arrangeSpacingMm: duplicateSpacingMm,
          arrangeAllowRotateOnZ: true,
          arrangeAnchorMode: 'center',
          getArrangeTransform: (arrangeModel) => arrangeModel.transform,
          hullCache: arrangeHullFootprintCacheRef.current,
          safetyMarginMm: scene.view3dSettings.safetyMarginMm,
        });

        const packedIdSet = new Set(result.packedIds);
        const packedUpdates = result.updates.filter((update) => packedIdSet.has(update.id));
        if (packedUpdates.length <= 1) return;

        let sourceUpdate = packedUpdates[0];
        let sourceDistanceSq = Number.POSITIVE_INFINITY;
        for (const update of packedUpdates) {
          const dx = update.transform.position.x - model.transform.position.x;
          const dy = update.transform.position.y - model.transform.position.y;
          const distanceSq = (dx * dx) + (dy * dy);
          if (distanceSq < sourceDistanceSq) {
            sourceDistanceSq = distanceSq;
            sourceUpdate = update;
          }
        }

        const duplicateTransforms = packedUpdates
          .filter((update) => update.id !== sourceUpdate.id)
          .map((update) => ({
            position: update.transform.position.clone(),
            rotation: update.transform.rotation.clone(),
            scale: update.transform.scale.clone(),
          }));

        if (duplicateTransforms.length === 0) return;

        const createdIds = scene.duplicateModelWithTransforms(
          model.id,
          duplicateTransforms,
          {
            position: sourceUpdate.transform.position.clone(),
            rotation: sourceUpdate.transform.rotation.clone(),
            scale: sourceUpdate.transform.scale.clone(),
          },
        );

        const firstCreatedId = createdIds[0] ?? null;
        const firstCreatedTransform = duplicateTransforms[0] ?? null;
        if (firstCreatedId && firstCreatedTransform) {
          setDisplayActiveModelId(firstCreatedId);
          transformMgr.transformHook.setPosition(
            firstCreatedTransform.position.x,
            firstCreatedTransform.position.y,
            firstCreatedTransform.position.z,
          );
          transformMgr.transformHook.setRotation(
            firstCreatedTransform.rotation.x,
            firstCreatedTransform.rotation.y,
            firstCreatedTransform.rotation.z,
          );
          transformMgr.transformHook.setScale(
            firstCreatedTransform.scale.x,
            firstCreatedTransform.scale.y,
            firstCreatedTransform.scale.z,
          );
        }

        setDuplicateTotalCopies(1);
      } catch (error) {
        console.warn('[Duplicate][HighPrecision] Failed applying fill-plate duplicate.', error);
      } finally {
        const elapsed = performance.now() - startedAt;
        if (elapsed < minSpinnerMs) {
          await sleep(minSpinnerMs - elapsed);
        }
        setIsDuplicating(false);
        setIsAutoArranging(false);
        setActiveArrangeOperation(null);
        setArrangeOverlayModelCount(null);
      }
      return;
    }

    const sourceDims = getModelSupportAwareDimensionsMm(model, undefined, model.transform);
    const width = sourceDims.width;
    const depth = sourceDims.depth;
    const spacing = Math.max(0, duplicateSpacingMm);

    const rawFillMinX = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.widthMm * 0.5;
    const rawFillMaxX = rawFillMinX + scene.view3dSettings.widthMm;
    const rawFillMinY = scene.view3dSettings.originMode === 'front_left' ? 0 : -scene.view3dSettings.depthMm * 0.5;
    const rawFillMaxY = rawFillMinY + scene.view3dSettings.depthMm;
    const fillSm = scene.view3dSettings.safetyMarginMm;
    const minX = rawFillMinX + Math.max(0, fillSm?.left ?? 0);
    const maxX = rawFillMaxX - Math.max(0, fillSm?.right ?? 0);
    const minY = rawFillMinY + Math.max(0, fillSm?.front ?? 0);
    const maxY = rawFillMaxY - Math.max(0, fillSm?.back ?? 0);

    const plateWidth = Math.max(1, maxX - minX);
    const plateDepth = Math.max(1, maxY - minY);
    // Add small epsilon to prevent floating point edge cases when spacing is very small
    const gridSpacing = spacing > 0 ? spacing : 0.001;
    const maxCols = Math.max(1, Math.floor((plateWidth + gridSpacing) / (width + gridSpacing)));
    const maxRows = Math.max(1, Math.floor((plateDepth + gridSpacing) / (depth + gridSpacing)));

    // Use actual spacing (including 0) for layout, not gridSpacing
    const totalUsedWidth = (maxCols * width) + Math.max(0, maxCols - 1) * spacing;
    const totalUsedDepth = (maxRows * depth) + Math.max(0, maxRows - 1) * spacing;
    const startX = minX + ((plateWidth - totalUsedWidth) * 0.5) + (width * 0.5);
    const startY = minY + ((plateDepth - totalUsedDepth) * 0.5) + (depth * 0.5);

    const projectPolygon = (poly: THREE.Vector2[], axis: THREE.Vector2) => {
      let min = Infinity;
      let max = -Infinity;
      for (const point of poly) {
        const projected = point.dot(axis);
        min = Math.min(min, projected);
        max = Math.max(max, projected);
      }
      return { min, max };
    };

    const polygonsOverlap = (a: THREE.Vector2[], b: THREE.Vector2[]) => {
      const testAxes = (poly: THREE.Vector2[]) => {
        for (let i = 0; i < poly.length; i += 1) {
          const p0 = poly[i];
          const p1 = poly[(i + 1) % poly.length];
          const edge = new THREE.Vector2(p1.x - p0.x, p1.y - p0.y);
          if (edge.lengthSq() <= 1e-10) continue;
          const axis = new THREE.Vector2(-edge.y, edge.x).normalize();
          const pa = projectPolygon(a, axis);
          const pb = projectPolygon(b, axis);
          if (pa.max <= pb.min + spacing || pb.max <= pa.min + spacing) return false;
        }
        return true;
      };
      return testAxes(a) && testAxes(b);
    };

    const blockedPolygons = scene.models
      .filter((m) => m.visible && m.id !== model.id)
      .map((m) => getModelSupportAwareFootprintPolygonRef.current(m, undefined, m.transform));

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
      const candidateTransform = {
        position: new THREE.Vector3(candidate.x, candidate.y, model.transform.position.z),
        rotation: model.transform.rotation.clone(),
        scale: model.transform.scale.clone(),
      };
      const candidatePolygon = getModelSupportAwareFootprintPolygonRef.current(model, undefined, candidateTransform);

      if (blockedPolygons.some((blocked) => polygonsOverlap(candidatePolygon, blocked))) {
        continue;
      }

      blockedPolygons.push(candidatePolygon);
      capacity += 1;
    }

    const targetCopies = Math.min(128, Math.max(1, capacity));
    setDuplicateTotalCopies(targetCopies);
  }, [
    buildHighPrecisionArrangeModels,
    duplicateLayoutMode,
    duplicatePrecisionMode,
    duplicateSpacingMm,
    getModelSupportAwareDimensionsMm,
    isAutoArranging,
    isDuplicating,
    scene,
    sleep,
    transformMgr.transformHook,
  ]);

  const handlePlaceOnFaceAnimationStart = React.useCallback(() => {
    ensurePendingTransformHistoryForActiveModel('rotate');

    // Place-On-Face is an orientation-to-plate operation, so it should
    // restore gravity/auto-snap behavior even if manual Z translation had
    // previously disabled it.
    if (scene.activeModelId) {
      scene.setModelManualZMoveOverride(scene.activeModelId, false);
    }
    transformMgr.transformHook.setAutoSnapEnabled(true);

    transformMgr.setIsTransforming(true);
  }, [ensurePendingTransformHistoryForActiveModel, scene, transformMgr]);

  const persistActiveModelModifiers = React.useCallback((next: ModelMeshModifiers | undefined) => {
    const activeModelId = scene.activeModel?.id;
    if (!activeModelId) return;
    scene.setModelMeshModifiers(activeModelId, next);
  }, [scene]);

  const handleApplyHollowing = React.useCallback(() => {
    void (async () => {
      const activeModel = scene.activeModel;
      if (!activeModel) return;

      const persistedHollowing = activeModel.meshModifiers?.hollowing;
      const shouldApply = hollowingDraftEnabled || !persistedHollowing?.enabled;
      if (!shouldApply) return;

      if (hollowingState.mode === 'shell_open_face' && !isShellOpenFaceSelected) {
        showOperationError('Pick the face to open before applying Shell mode.');
        return;
      }

      const holesWereAlreadyBaked = activeModel.meshModifiers?.holePunchesBakedIntoGeometry === true;

      const existingSource = hollowingSourceByModelIdRef.current.get(activeModel.id);
      const needsNewSource = !existingSource || !persistedHollowing?.enabled;

      let sourceGeometry: THREE.BufferGeometry;
      if (needsNewSource) {
        if (existingSource) {
          existingSource.geometry.dispose();
        }

        if (persistedHollowing?.enabled) {
          const restoredFromSnapshot = geometryFromSnapshot(persistedHollowing);
          sourceGeometry = restoredFromSnapshot ?? activeModel.geometry.geometry.clone();
        } else {
          // Use the current geometry which may already have baked holes.
          sourceGeometry = activeModel.geometry.geometry.clone();
        }

        hollowingSourceByModelIdRef.current.set(activeModel.id, {
          geometry: sourceGeometry,
        });
      } else {
        sourceGeometry = existingSource.geometry;
      }

      setIsApplyingHollowing(true);
      try {
        const effectiveHollowMode = hollowingState.mode === 'shell_open_face'
          ? 'cavity'
          : hollowingState.mode;
        const shellScaleFactor = getUniformScaleFactorForThickness(activeModel.transform.scale);
        const bbox = sourceGeometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
          sourceGeometry.getAttribute('position') as THREE.BufferAttribute,
        );
        const bboxSize = bbox.getSize(new THREE.Vector3());
        const maxExtent = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);
        const applyQuat = new THREE.Quaternion().setFromEuler(activeModel.transform.rotation);
        const options: HollowOptions = {
          mode: effectiveHollowMode,
          voxelResolution: computeVoxelResolution(worldMmToLocalMm(hollowingState.voxelSizeMm, shellScaleFactor), maxExtent),
          shellThicknessMm: worldMmToLocalMm(hollowingState.shellThicknessMm, shellScaleFactor),
          blockedVoxelIndices: blockedHollowVoxelIndices,
          infillMode: hollowingState.infillMode,
          infillCellMm: worldMmToLocalMm(hollowingState.infillCellMm, shellScaleFactor),
          infillBeamRadiusMm: worldMmToLocalMm(hollowingState.infillBeamRadiusMm, shellScaleFactor),
          openFace: hollowingState.openFace,
          drainHoles: [],
          previewCavityOnly: false,
          smoothInternalSurfaces: true,
          internalChamferPasses: 2,
          rotationQuat: [applyQuat.x, applyQuat.y, applyQuat.z, applyQuat.w],
        };
        const sourceGeometryKey = buildGeometryVersionKey(sourceGeometry);
        const staged = await stageHollowPreviewSource(
          sourceGeometry,
          `${activeModel.id}::${sourceGeometryKey}`,
        );

        const result = staged
          ? await hollowApplyFromCapturedSource(options)
          : await hollowFromGeometry(sourceGeometry, options);
        if (!result) {
          showOperationError('Hollowing is available in DragonFruit Desktop only.');
          return;
        }

        // Detect hollowing failure: if no voxels were removed, the manifold
        // stabilization could not resolve the cavity surface, likely because
        // the mesh is too damaged for boolean operations.
        if (result.report && 'removedVoxels' in result.report && result.report.removedVoxels === 0) {
          setShowDamagedModelDialog(true);
          return;
        }

        const nextGeometry = new THREE.BufferGeometry();
        nextGeometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
        nextGeometry.computeVertexNormals();
        nextGeometry.computeBoundingBox();
        nextGeometry.computeBoundingSphere();

        // Store cavity geometry for Interior View Mode
        if (result.cavityPositions) {
          const existingCavity = cavityGeometryByModelIdRef.current.get(activeModel.id);
          if (existingCavity) {
            existingCavity.geometry.dispose();
          }
          const cavityGeometry = new THREE.BufferGeometry();
          cavityGeometry.setAttribute('position', new THREE.BufferAttribute(result.cavityPositions, 3));
          cavityGeometry.computeVertexNormals();
          cavityGeometry.computeBoundingBox();
          cavityGeometry.computeBoundingSphere();
          cavityGeometryByModelIdRef.current.set(activeModel.id, { geometry: cavityGeometry });
        } else {
          const existingCavity = cavityGeometryByModelIdRef.current.get(activeModel.id);
          if (existingCavity) {
            existingCavity.geometry.dispose();
            cavityGeometryByModelIdRef.current.delete(activeModel.id);
          }
        }

        const modeLabel = hollowingState.mode === 'shell_open_face'
          ? 'Shell Hollowing'
          : hollowingState.mode === 'infill'
            ? 'Infill Hollowing'
            : 'Cavity Hollowing';
        const replaced = scene.replaceModelGeometry(
          activeModel.id,
          nextGeometry,
          `${modeLabel} (${result.report.outputTriangleCount.toLocaleString()} tris)`,
        );
        if (!replaced) {
          nextGeometry.dispose();
          return;
        }

        // Hollowing is now baked — clear the preview overlay and exit X-Ray
        // forced shader so the user can see surface detail for hole placement.
        clearHollowPreview();
        setSessionShaderOverride(null);

        const sourceSnapshot = snapshotGeometryPositions(sourceGeometry);
        let cavityPositionsBase64: string | undefined;
        let cavityPositionCount: number | undefined;
        if (result.cavityPositions) {
          const cavityBytes = new Uint8Array(
            result.cavityPositions.buffer,
            result.cavityPositions.byteOffset,
            result.cavityPositions.byteLength,
          );
          cavityPositionsBase64 = bytesToBase64(cavityBytes);
          cavityPositionCount = result.cavityPositions.length / 3;
        }

        setHolePunchState((previous) => (
          previous.depthMode === 'auto'
            ? previous
            : { ...previous, depthMode: 'auto' }
        ));

        const nextHolePunchPlacements = holePunchPlacementsRef.current.map((placement) => {
          if (placement.modelId !== activeModel.id || placement.depthMode !== 'auto') {
            return placement;
          }

          return {
            ...placement,
            depthMm: computeAutoHolePunchDepthMmForGeometry(
              activeModel,
              nextGeometry,
              placement.worldPoint,
              placement.worldNormal,
            ),
          };
        });
        setHolePunchPlacements(nextHolePunchPlacements);

        const persistedHolePunches = toPersistedHolePunchPlacements(
          { geometry: { geometry: nextGeometry } as GeometryWithBounds },
          nextHolePunchPlacements.filter((placement) => placement.modelId === activeModel.id),
        ).filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0);

        // When holes were already baked before hollowing, they were passed as
        // drainHoles to the hollower which already cut them — no re-apply needed.
        // Only auto-reapply holes that were in draft state (not yet baked).
        const shouldAutoReapplyHolePunches = !holesWereAlreadyBaked && persistedHolePunches.length > 0;

        persistActiveModelModifiers({
          ...(activeModel.meshModifiers ?? {}),
          hollowing: {
            enabled: true,
            bakedIntoGeometry: true,
            sourcePositionsBase64: sourceSnapshot.sourcePositionsBase64,
            sourcePositionCount: sourceSnapshot.sourcePositionCount,
            cavityPositionsBase64,
            cavityPositionCount,
            blockedVoxelIndices: blockedHollowVoxelIndices,
            mode: effectiveHollowMode,
            voxelSizeMm: hollowingState.voxelSizeMm,
            shellThicknessMm: hollowingState.shellThicknessMm,
            infillMode: hollowingState.infillMode,
            infillCellMm: hollowingState.infillCellMm,
            infillBeamRadiusMm: hollowingState.infillBeamRadiusMm,
            openFace: hollowingState.openFace,
            openFaceSelected: hollowingState.mode === 'shell_open_face'
              ? isShellOpenFaceSelected
              : true,
          },
          holePunches: persistedHolePunches,
          holePunchAppliedPlacements: holesWereAlreadyBaked ? persistedHolePunches : [],
          holePunchesBakedIntoGeometry: holesWereAlreadyBaked,
          holePunchSourcePositionsBase64: holesWereAlreadyBaked
            ? (activeModel.meshModifiers?.holePunchSourcePositionsBase64 ?? undefined)
            : undefined,
          holePunchSourcePositionCount: holesWereAlreadyBaked
            ? (activeModel.meshModifiers?.holePunchSourcePositionCount ?? undefined)
            : undefined,
        });

        if (shouldAutoReapplyHolePunches) {
          setPendingHolePunchAutoApplyModelId(activeModel.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showOperationError(`Hollowing failed: ${message}`);
      } finally {
        setIsApplyingHollowing(false);
        setIsApplyingBlockersHollowing(false);
      }
    })();
  }, [blockedHollowVoxelIndices, hollowingDraftEnabled, hollowingState, isShellOpenFaceSelected, persistActiveModelModifiers, scene]);

  const handleResetHollowing = React.useCallback(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return;

    const sourceEntry = hollowingSourceByModelIdRef.current.get(activeModel.id)
      ?? (() => {
        const restored = geometryFromSnapshot(activeModel.meshModifiers?.hollowing ?? {});
        if (!restored) return null;
        const entry = { geometry: restored };
        hollowingSourceByModelIdRef.current.set(activeModel.id, entry);
        return entry;
      })();

    if (sourceEntry) {
      const restoredGeometry = sourceEntry.geometry.clone();
      const restored = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Reset Hollowing');
      if (!restored) {
        restoredGeometry.dispose();
      }
    }

    // Clear cavity geometry and auto-disable interior view on hollowing reset
    const existingCavity = cavityGeometryByModelIdRef.current.get(activeModel.id);
    if (existingCavity) {
      existingCavity.geometry.dispose();
      cavityGeometryByModelIdRef.current.delete(activeModel.id);
    }
    setInteriorView(false);

    setHollowingState(defaultHollowingState);
    setIsShellOpenFaceSelected(true);
    setHollowingDraftEnabled(false);
    setHollowingEditMode(false);
    setBlockedHollowVoxelIndices([]);
    setEditingBlockedHollowVoxelIndices([]);
    persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        enabled: false,
        bakedIntoGeometry: false,
        // Clear the source snapshot — hollowing was reset so the snapshot is
        // stale (it may contain holes that have since been removed).
        sourcePositionsBase64: undefined,
        sourcePositionCount: undefined,
        blockedVoxelIndices: [],
        mode: defaultHollowingState.mode,
        voxelSizeMm: defaultHollowingState.voxelSizeMm,
        shellThicknessMm: defaultHollowingState.shellThicknessMm,
        infillMode: defaultHollowingState.infillMode,
        infillCellMm: defaultHollowingState.infillCellMm,
        infillBeamRadiusMm: defaultHollowingState.infillBeamRadiusMm,
        openFace: defaultHollowingState.openFace,
        openFaceSelected: true,
      },
      // Preserve hole punch baked state — the geometry restored from the
      // hollowing source still contains any pre-baked holes, so the system
      // must not lose track of them.
      holePunchAppliedPlacements: activeModel.meshModifiers?.holePunches ?? [],
      holePunchesBakedIntoGeometry: activeModel.meshModifiers?.holePunchesBakedIntoGeometry === true,
      holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
      holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
    });
  }, [defaultHollowingState, persistActiveModelModifiers, scene.activeModel]);

  const handleClearAppliedHollowing = React.useCallback(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return;

    const sourceEntry = hollowingSourceByModelIdRef.current.get(activeModel.id)
      ?? (() => {
        const restored = geometryFromSnapshot(activeModel.meshModifiers?.hollowing ?? {});
        if (!restored) return null;
        const entry = { geometry: restored };
        hollowingSourceByModelIdRef.current.set(activeModel.id, entry);
        return entry;
      })();

    if (sourceEntry) {
      const restoredGeometry = sourceEntry.geometry.clone();
      const restored = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Clear Hollowing');
      if (!restored) {
        restoredGeometry.dispose();
      }
    }

    // Clear cavity geometry and disable interior view
    const existingCavity = cavityGeometryByModelIdRef.current.get(activeModel.id);
    if (existingCavity) {
      existingCavity.geometry.dispose();
      cavityGeometryByModelIdRef.current.delete(activeModel.id);
    }
    setInteriorView(false);

    setHollowingDraftEnabled(false);
    setHollowingEditMode(false);
    setBlockedHollowVoxelIndices([]);
    setEditingBlockedHollowVoxelIndices([]);
    persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        enabled: false,
        bakedIntoGeometry: false,
        sourcePositionsBase64: undefined,
        sourcePositionCount: undefined,
        blockedVoxelIndices: [],
        // Keep current settings — don't reset to defaults.
        mode: hollowingState.mode,
        voxelSizeMm: hollowingState.voxelSizeMm,
        shellThicknessMm: hollowingState.shellThicknessMm,
        infillMode: hollowingState.infillMode,
        infillCellMm: hollowingState.infillCellMm,
        infillBeamRadiusMm: hollowingState.infillBeamRadiusMm,
        openFace: hollowingState.openFace,
        openFaceSelected: hollowingState.mode === 'shell_open_face'
          ? isShellOpenFaceSelected
          : true,
      },
      holePunchAppliedPlacements: activeModel.meshModifiers?.holePunches ?? [],
      holePunchesBakedIntoGeometry: activeModel.meshModifiers?.holePunchesBakedIntoGeometry === true,
      holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
      holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
    });
  }, [hollowingState, isShellOpenFaceSelected, persistActiveModelModifiers, scene.activeModel]);

  const handleResetHollowingSettings = React.useCallback(() => {
    setHollowingState(defaultHollowingState);
    setIsShellOpenFaceSelected(true);
  }, [defaultHollowingState]);

  const handleHollowingStateChange = React.useCallback((next: HollowingPanelState) => {
    const openFaceChanged = next.openFace !== hollowingState.openFace;
    const resolutionChanged = Math.abs(next.voxelSizeMm - hollowingState.voxelSizeMm) > 1e-6;
    const thicknessChanged = Math.abs(next.shellThicknessMm - hollowingState.shellThicknessMm) > 1e-6;
    const blockedVoxelIndices = resolutionChanged
      ? []
      : blockedHollowVoxelIndices;
    const nextShellOpenFaceSelected = next.mode === 'shell_open_face'
      ? (
        hollowingState.mode !== 'shell_open_face'
          ? false
          : (openFaceChanged ? true : isShellOpenFaceSelected)
      )
      : true;

    // Warn before clearing blockers when adjusting resolution or thickness.
    if ((resolutionChanged || thicknessChanged) && blockedHollowVoxelIndices.length > 0) {
      setPendingBlockerResetState(next);
      return;
    }

    setHollowingState(next);
    setIsShellOpenFaceSelected(nextShellOpenFaceSelected);
    setHollowingDraftEnabled(true);
    setBlockedHollowVoxelIndices(blockedVoxelIndices);
    // Clear editing indices when voxel resolution changes (new grid), but
    // preserve them when only shell thickness or mode changes so the user
    // stays in sphere edit mode with their current selection intact.
    if (!hollowingEditMode || resolutionChanged) {
      setEditingBlockedHollowVoxelIndices(blockedVoxelIndices);
    }

    if (!nextShellOpenFaceSelected) {
      setSelectedHolePunchPlacementIds([]);
      setHoveredHolePunchPlacementId(null);
      setHolePunchHoverPlacement(null);
    }

    const activeModel = scene.activeModel;
    if (!activeModel) return;

    persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        enabled: true,
        bakedIntoGeometry: false,
        sourcePositionsBase64: activeModel.meshModifiers?.hollowing?.sourcePositionsBase64,
        sourcePositionCount: activeModel.meshModifiers?.hollowing?.sourcePositionCount,
        blockedVoxelIndices,
        mode: next.mode,
        voxelSizeMm: next.voxelSizeMm,
        shellThicknessMm: next.shellThicknessMm,
        infillMode: next.infillMode,
        infillCellMm: next.infillCellMm,
        infillBeamRadiusMm: next.infillBeamRadiusMm,
        openFace: next.openFace,
        openFaceSelected: nextShellOpenFaceSelected,
      },
    });
  }, [blockedHollowVoxelIndices, hollowingState.mode, hollowingState.openFace, hollowingState.voxelSizeMm, isShellOpenFaceSelected, persistActiveModelModifiers, scene.activeModel]);

  const selectedHolePunchPlacementIdSet = React.useMemo(
    () => new Set(selectedHolePunchPlacementIds),
    [selectedHolePunchPlacementIds],
  );

  const selectedHolePunchPlacements = React.useMemo(
    () => holePunchPlacements.filter((placement) => selectedHolePunchPlacementIdSet.has(placement.id)),
    [holePunchPlacements, selectedHolePunchPlacementIdSet],
  );

  const isHollowingApplied = React.useMemo(() => {
    const modifier = scene.activeModel?.meshModifiers?.hollowing;
    return Boolean(modifier?.enabled && modifier?.bakedIntoGeometry);
  }, [scene.activeModel]);

  const canUseAutoHolePunchDepth = React.useMemo(() => (
    Boolean(scene.activeModel && (hollowingDraftEnabled || isHollowingApplied))
  ), [hollowingDraftEnabled, isHollowingApplied, scene.activeModel]);

  const syncHolePunchPanelFromSelection = React.useCallback((
    nextSelectedIds: string[],
    placements: HolePunchPlacementState[],
    preferredId?: string | null,
    autoDepthEnabled = canUseAutoHolePunchDepth,
  ) => {
    const preferredPlacement = preferredId
      ? placements.find((placement) => placement.id === preferredId)
      : null;
    const fallbackPlacement = [...placements].reverse().find((placement) => nextSelectedIds.includes(placement.id)) ?? null;
    const nextPlacement = preferredPlacement ?? fallbackPlacement;
    if (nextPlacement) {
      setHolePunchState({
        radiusMm: nextPlacement.radiusMm,
        radiusYMm: nextPlacement.radiusYMm,
        depthMm: nextPlacement.depthMm,
        depthMode: autoDepthEnabled ? nextPlacement.depthMode : 'manual',
      });
    }
  }, [canUseAutoHolePunchDepth]);

  const activeHolePunchPlacements = React.useMemo(() => {
    const activeModelId = scene.activeModel?.id;
    if (!activeModelId) return [] as HolePunchPlacementState[];
    return holePunchPlacements.filter((placement) => placement.modelId === activeModelId);
  }, [holePunchPlacements, scene.activeModel?.id]);

  React.useEffect(() => {
    let wasAPressed = false;
    let wasCPressed = false;
    let wasVPressed = false;
    let wasSPressed = false;

    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isCtrlOrMeta = active.has('ctrl') || active.has('meta') || active.has('control');
      const isAPressed = active.has('a') && isCtrlOrMeta;
      const isCPressed = active.has('c') && isCtrlOrMeta;
      const isVPressed = active.has('v') && isCtrlOrMeta;
      const isSPressed = active.has('s') && isCtrlOrMeta;

      const isAJustPressed = isAPressed && !wasAPressed;
      const isCJustPressed = isCPressed && !wasCPressed;
      const isVJustPressed = isVPressed && !wasVPressed;
      const isSJustPressed = isSPressed && !wasSPressed;

      if (isAJustPressed) {
        if (scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing') {
          if (activeHolePunchPlacements.length > 0) {
            const nextIds = activeHolePunchPlacements.map((placement) => placement.id);
            setSelectedHolePunchPlacementIds(nextIds);
            syncHolePunchPanelFromSelection(nextIds, activeHolePunchPlacements, nextIds[nextIds.length - 1] ?? null);
            setHoveredHolePunchPlacementId(null);
            setHolePunchHoverPlacement(null);
          }
        } else if (scene.mode === 'prepare') {
          if (scene.models.length > 0) {
            const visibleIds = scene.models.filter((model) => model.visible).map((model) => model.id);
            if (visibleIds.length > 0) {
              scene.setSelectedModelIds(visibleIds);
              scene.setActiveModelId(visibleIds[0]);
            }
            setIsSelectAllModelsActive(true);
          }
        }
      }

      if (isCJustPressed && !active.has('alt')) {
        if (scene.mode === 'prepare') {
          if (scene.selectedModelIds.length === 0 && !scene.activeModelId) return;
          if (scene.selectedModelIds.length > 0) {
            scene.copySelectedModels();
          } else if (scene.activeModelId) {
            scene.copyModel(scene.activeModelId);
          }
        }
      }

      if (isVJustPressed && !active.has('alt')) {
        if (scene.mode === 'prepare' && scene.canPasteModel) {
          scene.pasteCopiedModelsAutoArrange(arrangeSpacingMm);
        }
      }

      if (isSJustPressed && !active.has('alt') && !active.has('shift')) {
        if (scene.models.length > 0) {
          void handleTopBarSaveScene();
        }
      }

      wasAPressed = isAPressed;
      wasCPressed = isCPressed;
      wasVPressed = isVPressed;
      wasSPressed = isSPressed;
    });

    return unsubscribe;
  }, [
    scene,
    transformMgr.transformMode,
    activeHolePunchPlacements,
    syncHolePunchPanelFromSelection,
    arrangeSpacingMm,
    handleTopBarSaveScene
  ]);

  const previousRecommendedHolePunchDepthRef = React.useRef<number>(recommendedHolePunchDepthMm);

  React.useEffect(() => {
    const previousRecommendedDepth = previousRecommendedHolePunchDepthRef.current;
    const nextRecommendedDepth = recommendedHolePunchDepthMm;

    const shouldAutoUpdateDepth = selectedHolePunchPlacementIds.length === 0
      && activeHolePunchPlacements.length === 0
      && Math.abs(holePunchState.depthMm - previousRecommendedDepth) <= 1e-6;

    if (shouldAutoUpdateDepth && Math.abs(holePunchState.depthMm - nextRecommendedDepth) > 1e-6) {
      setHolePunchState((previous) => ({
        ...previous,
        depthMm: nextRecommendedDepth,
      }));
    }

    previousRecommendedHolePunchDepthRef.current = nextRecommendedDepth;
  }, [
    activeHolePunchPlacements.length,
    holePunchState.depthMm,
    recommendedHolePunchDepthMm,
    selectedHolePunchPlacementIds.length,
  ]);

  const appliedHolePunchPlacementsSignature = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return '[]';
    const appliedPlacements = activeModel.meshModifiers?.holePunchAppliedPlacements
      ?? (activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        ? (activeModel.meshModifiers?.holePunches ?? [])
        : []);
    return serializeHolePunchPlacements(appliedPlacements);
  }, [scene.activeModel]);

  const draftHolePunchPlacementsSignature = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return '[]';
    const persistedDraft = toPersistedHolePunchPlacements(activeModel, activeHolePunchPlacements);
    return serializeHolePunchPlacements(persistedDraft);
  }, [activeHolePunchPlacements, scene.activeModel]);

  const isHolePunchApplied = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return false;
    return Boolean(
      (activeModel.meshModifiers?.holePunches?.length ?? 0) > 0
      && activeModel.meshModifiers?.holePunchesBakedIntoGeometry,
    );
  }, [scene.activeModel]);

  const holePunchNeedsBake = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return false;
    const placements = activeModel.meshModifiers?.holePunches ?? [];
    const hasSourceSnapshot = Boolean(
      activeModel.meshModifiers?.holePunchSourcePositionsBase64
      && Number.isFinite(activeModel.meshModifiers?.holePunchSourcePositionCount)
      && (activeModel.meshModifiers?.holePunchSourcePositionCount ?? 0) > 0,
    );

    if (activeModel.meshModifiers?.holePunchesBakedIntoGeometry) return false;
    return placements.length > 0 || hasSourceSnapshot;
  }, [scene.activeModel]);

  const isHolePunchDirty = draftHolePunchPlacementsSignature !== appliedHolePunchPlacementsSignature;

  const appliedHolePunchPlacementIds = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) {
      return new Set<string>();
    }

    const appliedPlacements = activeModel.meshModifiers?.holePunchAppliedPlacements
      ?? (activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        ? (activeModel.meshModifiers?.holePunches ?? [])
        : []);

    if (appliedPlacements.length === 0) {
      return new Set<string>();
    }

    const currentPersistedPlacements = toPersistedHolePunchPlacements(activeModel, activeHolePunchPlacements)
      .filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0);

    if (currentPersistedPlacements.length === 0) {
      return new Set<string>();
    }

    const currentById = new Map<string, string>();
    for (const placement of currentPersistedPlacements) {
      currentById.set(placement.id, serializeSingleHolePunchPlacement(placement));
    }

    const appliedIds = new Set<string>();
    for (const placement of appliedPlacements) {
      const currentSignature = currentById.get(placement.id);
      if (!currentSignature) continue;
      if (currentSignature === serializeSingleHolePunchPlacement(placement)) {
        appliedIds.add(placement.id);
      }
    }

    return appliedIds;
  }, [activeHolePunchPlacements, scene.activeModel]);

  const persistedHollowingSignature = React.useMemo(
    () => serializeHollowingModifier(scene.activeModel?.meshModifiers?.hollowing),
    [scene.activeModel],
  );

  const draftHollowingSignature = React.useMemo(
    () => serializeHollowingModifier({
      enabled: hollowingDraftEnabled,
      blockedVoxelIndices: blockedHollowVoxelIndices,
      mode: hollowingState.mode,
      voxelSizeMm: hollowingState.voxelSizeMm,
      shellThicknessMm: hollowingState.shellThicknessMm,
      infillMode: hollowingState.infillMode,
      infillCellMm: hollowingState.infillCellMm,
      infillBeamRadiusMm: hollowingState.infillBeamRadiusMm,
      openFace: hollowingState.openFace,
      openFaceSelected: hollowingState.mode === 'shell_open_face'
        ? isShellOpenFaceSelected
        : true,
    }),
    [
      hollowingDraftEnabled,
      blockedHollowVoxelIndices,
      hollowingState.mode,
      hollowingState.openFace,
      hollowingState.infillMode,
      hollowingState.shellThicknessMm,
      hollowingState.infillBeamRadiusMm,
      hollowingState.infillCellMm,
      hollowingState.voxelSizeMm,
      isShellOpenFaceSelected,
    ],
  );

  const isShellFaceSelectionPending = hollowingState.mode === 'shell_open_face' && !isShellOpenFaceSelected;

  const isHollowingDirty = draftHollowingSignature !== persistedHollowingSignature;

  const canResetHollowing = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return false;
    const modifier = activeModel.meshModifiers?.hollowing;
    if (!modifier) return false;
    return Boolean(modifier.enabled || isHollowingDirty || isHollowingApplied);
  }, [isHollowingApplied, isHollowingDirty, scene.activeModel]);

  const blockedHollowVoxelIndexSet = React.useMemo(
    () => new Set(blockedHollowVoxelIndices),
    [blockedHollowVoxelIndices],
  );

  const editingBlockedHollowVoxelIndexSet = React.useMemo(
    () => new Set(editingBlockedHollowVoxelIndices),
    [editingBlockedHollowVoxelIndices],
  );

  React.useEffect(() => {
    editingBlockedHollowVoxelIndicesRef.current = editingBlockedHollowVoxelIndices;
  }, [editingBlockedHollowVoxelIndices]);

  React.useEffect(() => {
    hollowingEditModeRef.current = hollowingEditMode;
  }, [hollowingEditMode]);

  React.useEffect(() => {
    if (hollowingEditMode) return;
    hollowVoxelEditUndoStackRef.current = [];
    hollowVoxelEditRedoStackRef.current = [];
  }, [hollowingEditMode]);

  const applyEditingBlockedHollowVoxelIndices = React.useCallback((
    nextIndicesInput: Iterable<number>,
    options?: { recordHistory?: boolean },
  ) => {
    const nextIndices = [...new Set(nextIndicesInput)]
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const previousIndices = editingBlockedHollowVoxelIndicesRef.current;
    if (areSortedNumberArraysEqual(previousIndices, nextIndices)) {
      return false;
    }

    if (options?.recordHistory ?? true) {
      hollowVoxelEditUndoStackRef.current.push([...previousIndices]);
      if (hollowVoxelEditUndoStackRef.current.length > 100) {
        hollowVoxelEditUndoStackRef.current.shift();
      }
      hollowVoxelEditRedoStackRef.current = [];
    }

    editingBlockedHollowVoxelIndicesRef.current = nextIndices;
    setEditingBlockedHollowVoxelIndices(nextIndices);
    return true;
  }, []);

  const undoHollowVoxelEdit = React.useCallback(() => {
    const previousIndices = hollowVoxelEditUndoStackRef.current.pop();
    if (!previousIndices) return false;

    hollowVoxelEditRedoStackRef.current.push([...editingBlockedHollowVoxelIndicesRef.current]);
    editingBlockedHollowVoxelIndicesRef.current = previousIndices;
    setEditingBlockedHollowVoxelIndices(previousIndices);
    return true;
  }, []);

  const redoHollowVoxelEdit = React.useCallback(() => {
    const nextIndices = hollowVoxelEditRedoStackRef.current.pop();
    if (!nextIndices) return false;

    hollowVoxelEditUndoStackRef.current.push([...editingBlockedHollowVoxelIndicesRef.current]);
    editingBlockedHollowVoxelIndicesRef.current = nextIndices;
    setEditingBlockedHollowVoxelIndices(nextIndices);
    return true;
  }, []);

  React.useEffect(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'hollowing' || !hollowingEditMode) {
      return;
    }

    let wasZPressed = false;
    let wasYPressed = false;

    const unsubscribe = hotkeyStore.subscribe((state) => {
      const active = state.activeKeys;
      const isCtrlOrMeta = active.has('ctrl') || active.has('meta') || active.has('control');
      const isZPressed = active.has('z') && isCtrlOrMeta;
      const isYPressed = active.has('y') && isCtrlOrMeta;

      const isZJustPressed = isZPressed && !wasZPressed;
      const isYJustPressed = isYPressed && !wasYPressed;

      if (isZJustPressed) {
        if (active.has('shift')) {
          redoHollowVoxelEdit();
        } else {
          undoHollowVoxelEdit();
        }
      } else if (isYJustPressed) {
        redoHollowVoxelEdit();
      }

      wasZPressed = isZPressed;
      wasYPressed = isYPressed;
    });

    return unsubscribe;
  }, [hollowingEditMode, redoHollowVoxelEdit, scene.mode, transformMgr.transformMode, undoHollowVoxelEdit]);

  const blockedPreviewVoxelInstanceIdSet = React.useMemo(() => {
    const preview = hollowPreview;
    if (!preview) return new Set<number>();
    const activeBlockedIndexSet = hollowingEditMode
      ? editingBlockedHollowVoxelIndexSet
      : blockedHollowVoxelIndexSet;

    const next = new Set<number>();
    for (let instanceIndex = 0; instanceIndex < preview.removedVoxelIndices.length; instanceIndex += 1) {
      if (activeBlockedIndexSet.has(preview.removedVoxelIndices[instanceIndex] ?? -1)) {
        next.add(instanceIndex);
      }
    }
    // Also map committed blocked voxel centers: their instance index is
    // offset past the removed voxels. If the user cleared a blocked voxel
    // from the editing set, it won't be in activeBlockedIndexSet and will
    // render as yellow.
    if (preview.blockedVoxelCenters) {
      const blockedCount = Math.floor(preview.blockedVoxelCenters.length / 3);
      for (let blockedIndex = 0; blockedIndex < blockedCount; blockedIndex += 1) {
        const gridIndex = blockedHollowVoxelIndices[blockedIndex];
        if (activeBlockedIndexSet.has(gridIndex)) {
          next.add(preview.removedVoxelIndices.length + blockedIndex);
        }
      }
    }
    return next;
  }, [blockedHollowVoxelIndexSet, blockedHollowVoxelIndices, editingBlockedHollowVoxelIndexSet, hollowPreview, hollowingEditMode]);

  const commitBlockedHollowVoxelIndices = React.useCallback((nextIndices: number[]) => {
    const activeModel = scene.activeModel;
    if (!activeModel) return;

    setBlockedHollowVoxelIndices(nextIndices);
    setHollowingDraftEnabled(true);
    persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        enabled: true,
        bakedIntoGeometry: false,
        sourcePositionsBase64: activeModel.meshModifiers?.hollowing?.sourcePositionsBase64,
        sourcePositionCount: activeModel.meshModifiers?.hollowing?.sourcePositionCount,
        blockedVoxelIndices: nextIndices,
        mode: hollowingState.mode,
        voxelSizeMm: hollowingState.voxelSizeMm,
        shellThicknessMm: hollowingState.shellThicknessMm,
        infillMode: hollowingState.infillMode,
        infillCellMm: hollowingState.infillCellMm,
        infillBeamRadiusMm: hollowingState.infillBeamRadiusMm,
        openFace: hollowingState.openFace,
        openFaceSelected: hollowingState.mode === 'shell_open_face'
          ? isShellOpenFaceSelected
          : true,
      },
    });
  }, [hollowingState, isShellOpenFaceSelected, persistActiveModelModifiers, scene.activeModel]);

  const toggleBlockedHollowVoxelIndex = React.useCallback((voxelIndex: number) => {
    const currentPreview = hollowPreview;
    if (!currentPreview || voxelIndex < 0) return;

    let gridVoxelIndex: number;

    const removedCount = currentPreview.removedVoxelIndices.length;
    if (voxelIndex < removedCount) {
      // Instance in the removed voxel array — look up grid index directly.
      gridVoxelIndex = currentPreview.removedVoxelIndices[voxelIndex];
    } else {
      // Instance in the appended blocked-only array — look up via
      // blockedHollowVoxelIndices (committed set, same order as blocked centers).
      const blockedOffset = voxelIndex - removedCount;
      gridVoxelIndex = blockedHollowVoxelIndices[blockedOffset];
    }

    if (!Number.isFinite(gridVoxelIndex)) return;

    const next = new Set(editingBlockedHollowVoxelIndexSet);
    if (next.has(gridVoxelIndex)) {
      next.delete(gridVoxelIndex);
    } else {
      next.add(gridVoxelIndex);
    }
    applyEditingBlockedHollowVoxelIndices(next);
  }, [applyEditingBlockedHollowVoxelIndices, blockedHollowVoxelIndices, editingBlockedHollowVoxelIndexSet, hollowPreview]);

  const canResetHolePunch = React.useMemo(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) return false;
    return activeHolePunchPlacements.length > 0
      || (activeModel.meshModifiers?.holePunchAppliedPlacements?.length ?? 0) > 0
      || Boolean(
        activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        && (activeModel.meshModifiers?.holePunches?.length ?? 0) > 0,
      );
  }, [activeHolePunchPlacements.length, scene.activeModel]);

  const persistHolePunchPlacementsForModel = React.useCallback((
    activeModel: NonNullable<typeof scene.activeModel>,
    placements: HolePunchPlacementState[],
  ) => {
    const nextActivePlacements = placements.filter((placement) => placement.modelId === activeModel.id);
    const nextPersisted = toPersistedHolePunchPlacements(activeModel, nextActivePlacements)
      .filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0);

    persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      holePunches: nextPersisted,
      holePunchAppliedPlacements: activeModel.meshModifiers?.holePunchAppliedPlacements
        ?? (activeModel.meshModifiers?.holePunchesBakedIntoGeometry
          ? (activeModel.meshModifiers?.holePunches ?? [])
          : []),
      holePunchesBakedIntoGeometry: false,
      holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
      holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
    });
  }, [persistActiveModelModifiers]);

  const computeAutoHolePunchDepthMmForGeometry = React.useCallback((
    model: (typeof scene.models)[number],
    targetGeometry: THREE.BufferGeometry,
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
  ) => {

    const axis = worldNormal.clone();
    if (axis.lengthSq() <= 1e-10) {
      return getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm);
    }
    axis.normalize();

    const raycaster = holePunchAutoDepthRaycasterRef.current;
    const rayMesh = holePunchAutoDepthMeshRef.current;
    rayMesh.geometry = targetGeometry;
    rayMesh.position.set(
      -model.geometry.center.x,
      -model.geometry.center.y,
      -model.geometry.center.z,
    );
    rayMesh.quaternion.copy(quaternionFromGlobalEuler(model.transform.rotation));
    rayMesh.scale.copy(model.transform.scale);
    rayMesh.updateMatrixWorld(true);

    const origin = worldPoint.clone().addScaledVector(axis, -HOLE_PUNCH_AUTO_DEPTH_RAY_START_OFFSET_MM);
    raycaster.ray.origin.copy(origin);
    raycaster.ray.direction.copy(axis);
    raycaster.near = 0;
    raycaster.far = 240;

    const hits = raycaster.intersectObject(rayMesh, false);
    const distinctDistances: number[] = [];
    for (const hit of hits) {
      if (distinctDistances.length > 0 && Math.abs(hit.distance - distinctDistances[distinctDistances.length - 1]) <= 0.05) {
        continue;
      }
      distinctDistances.push(hit.distance);
      if (distinctDistances.length >= 2) break;
    }

    if (distinctDistances.length < 2) {
      return getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm);
    }

    const shellPathLengthMm = Math.max(
      HOLE_PUNCH_AUTO_DEPTH_MIN_INSIDE_MM,
      distinctDistances[1] - distinctDistances[0],
    );
    return Number(
      Math.min(120, shellPathLengthMm + HOLE_PUNCH_DEPTH_OFFSET_FROM_SHELL_MM).toFixed(1),
    );
  }, [hollowingState.shellThicknessMm]);

  const computeAutoHolePunchDepthMm = React.useCallback((
    modelId: string,
    worldPoint: THREE.Vector3,
    worldNormal: THREE.Vector3,
  ) => {
    const activeModel = scene.models.find((model) => model.id === modelId) ?? null;
    if (!activeModel) {
      return getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm);
    }

    const previewGeometry = (
      hollowPreview
      && hollowPreview.modelId === modelId
      && hollowingDraftEnabled
    ) ? hollowPreview.geometry : null;

    const shouldUseActiveGeometry = Boolean(
      scene.getModelMeshModifiers(modelId)?.hollowing?.enabled
      && scene.getModelMeshModifiers(modelId)?.hollowing?.bakedIntoGeometry,
    );

    const targetGeometry = previewGeometry ?? (shouldUseActiveGeometry ? activeModel.geometry.geometry : null);
    if (!targetGeometry) {
      return getDefaultHolePunchDepthMm(hollowingState.shellThicknessMm);
    }

    return computeAutoHolePunchDepthMmForGeometry(activeModel, targetGeometry, worldPoint, worldNormal);
  }, [computeAutoHolePunchDepthMmForGeometry, hollowPreview, hollowingDraftEnabled, hollowingState.shellThicknessMm, scene.models]);

  const buildHolePunchPlacementForHit = React.useCallback((
    base: Pick<HolePunchPlacementState, 'id' | 'modelId' | 'radiusMm' | 'radiusYMm' | 'depthMm' | 'depthMode'>,
    hit: THREE.Intersection,
  ): HolePunchPlacementState => {
    const localPoint = hit.object.worldToLocal(hit.point.clone());
    const localNormal = hit.face?.normal
      ? hit.face.normal.clone().normalize().negate()
      : new THREE.Vector3(0, 0, -1);
    const worldNormal = hit.face?.normal
      ? hit.face.normal.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize().negate()
      : new THREE.Vector3(0, 0, -1);
    const resolvedDepthMm = (base.depthMode === 'auto' && canUseAutoHolePunchDepth)
      ? computeAutoHolePunchDepthMm(base.modelId, hit.point, worldNormal)
      : base.depthMm;

    return {
      ...base,
      worldPoint: hit.point.clone(),
      worldNormal,
      worldFrame: createHolePunchWorldFrame(worldNormal),
      localPoint,
      localNormal,
      depthMm: resolvedDepthMm,
      depthMode: base.depthMode === 'auto' && !canUseAutoHolePunchDepth ? 'manual' : base.depthMode,
    };
  }, [canUseAutoHolePunchDepth, computeAutoHolePunchDepthMm]);

  const buildHolePunchPlacementFromHit = React.useCallback((hit: THREE.Intersection, modelId: string): HolePunchPlacementState => {
    return buildHolePunchPlacementForHit({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      modelId,
      radiusMm: holePunchState.radiusMm,
      radiusYMm: holePunchState.radiusYMm,
      depthMm: holePunchState.depthMm,
      depthMode: canUseAutoHolePunchDepth ? holePunchState.depthMode : 'manual',
    }, hit);
  }, [buildHolePunchPlacementForHit, canUseAutoHolePunchDepth, holePunchState.depthMm, holePunchState.depthMode, holePunchState.radiusMm, holePunchState.radiusYMm]);

  const handleHolePunchClick = React.useCallback((hit: THREE.Intersection) => {
    const activeModel = scene.activeModel;
    if (!activeModel) return;

    const hitModelId = (hit.object.userData?.modelId as string | undefined) ?? activeModel.id;
    if (hitModelId !== activeModel.id) return;

    if (selectedHolePunchPlacementIds.length > 0 && Date.now() < suppressHolePunchGizmoReleaseClickUntilRef.current) {
      setHolePunchHoverPlacement(null);
      return;
    }

    if (hollowingState.mode === 'shell_open_face' && !isShellOpenFaceSelected) {
      const pickedOpenFace = inferOpenFaceFromHit(hit, hollowingState.openFace);
        const nextHollowingState: HollowingPanelState = {
          ...hollowingState,
          openFace: pickedOpenFace,
        };

      setHollowingState(nextHollowingState);
      setIsShellOpenFaceSelected(true);
      setHollowingDraftEnabled(true);
      setSelectedHolePunchPlacementIds([]);
      setHoveredHolePunchPlacementId(null);
      setHolePunchHoverPlacement(null);

      persistActiveModelModifiers({
        ...(activeModel.meshModifiers ?? {}),
        hollowing: {
          enabled: true,
          bakedIntoGeometry: false,
          sourcePositionsBase64: activeModel.meshModifiers?.hollowing?.sourcePositionsBase64,
          sourcePositionCount: activeModel.meshModifiers?.hollowing?.sourcePositionCount,
          mode: nextHollowingState.mode,
          voxelSizeMm: nextHollowingState.voxelSizeMm,
          shellThicknessMm: nextHollowingState.shellThicknessMm,
          infillMode: nextHollowingState.infillMode,
          infillCellMm: nextHollowingState.infillCellMm,
          infillBeamRadiusMm: nextHollowingState.infillBeamRadiusMm,
          openFace: nextHollowingState.openFace,
          openFaceSelected: true,
        },
      });
      return;
    }

    if (selectedHolePunchPlacementIds.length > 0) {
      setSelectedHolePunchPlacementIds([]);
      setHoveredHolePunchPlacementId(null);
      setHolePunchHoverPlacement(null);
      return;
    }

    const placement = buildHolePunchPlacementFromHit(hit, activeModel.id);
    setHolePunchPlacements((previous) => {
      const nextPlacements = [...previous, placement];
      persistHolePunchPlacementsForModel(activeModel, nextPlacements);
      return nextPlacements;
    });
    setSelectedHolePunchPlacementIds([]);
    setHoveredHolePunchPlacementId(null);
    setHolePunchHoverPlacement(null);
  }, [
    buildHolePunchPlacementFromHit,
    hollowingState,
    isShellOpenFaceSelected,
    persistHolePunchPlacementsForModel,
    scene.activeModel,
    selectedHolePunchPlacementIds.length,
  ]);

  const handleHolePunchHover = React.useCallback((hit: THREE.Intersection | null) => {
    const activeModel = scene.activeModel;
    if (
      holePunchDragStateRef.current
      || selectedHolePunchPlacementIds.length > 0
      || !activeModel
      || !hit
      || (hollowingState.mode === 'shell_open_face' && !isShellOpenFaceSelected)
    ) {
      setHolePunchHoverPlacement(null);
      return;
    }

    const hitModelId = (hit.object.userData?.modelId as string | undefined) ?? activeModel.id;
    if (hitModelId !== activeModel.id) {
      setHolePunchHoverPlacement(null);
      return;
    }

    const placement = buildHolePunchPlacementFromHit(hit, activeModel.id);
    setHolePunchHoverPlacement(placement);
  }, [buildHolePunchPlacementFromHit, hollowingState.mode, isShellOpenFaceSelected, scene.activeModel, selectedHolePunchPlacementIds.length]);

  const handleSelectHolePunchPlacement = React.useCallback((
    placementId: string,
    selectionMode: 'single' | 'toggle' | 'add' = 'single',
  ) => {
    if (suppressHolePunchClickPlacementIdRef.current === placementId) {
      suppressHolePunchClickPlacementIdRef.current = null;
      return;
    }
    const exists = holePunchPlacements.some((entry) => entry.id === placementId);
    if (!exists) return;

    setSelectedHolePunchPlacementIds((previous) => {
      let nextIds: string[];
      if (selectionMode === 'toggle') {
        nextIds = previous.includes(placementId)
          ? previous.filter((id) => id !== placementId)
          : [...previous, placementId];
      } else if (selectionMode === 'add') {
        nextIds = previous.includes(placementId) ? previous : [...previous, placementId];
      } else {
        nextIds = [placementId];
      }

      syncHolePunchPanelFromSelection(nextIds, holePunchPlacements, placementId);
      return nextIds;
    });
  }, [holePunchPlacements, syncHolePunchPanelFromSelection]);

  const handleHolePunchPlacementDragStart = React.useCallback((
    placementId: string,
    event: ThreeEvent<PointerEvent>,
  ) => {
    if (event.button !== 0) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      handleSelectHolePunchPlacement(
        placementId,
        event.ctrlKey || event.metaKey ? 'toggle' : 'add',
      );
      return;
    }
    holePunchDragStateRef.current = {
      pointerId: event.pointerId,
      placementId,
      moved: false,
    };
    suppressHolePunchClickPlacementIdRef.current = null;
    setHoveredHolePunchPlacementId(placementId);
    setHolePunchHoverPlacement(null);
    handleSelectHolePunchPlacement(placementId, 'single');
    const pointerTarget = event.target as Element | null;
    pointerTarget?.setPointerCapture?.(event.pointerId);
  }, [handleSelectHolePunchPlacement]);

  const handleHolePunchPlacementDragMove = React.useCallback((
    placementId: string,
    event: ThreeEvent<PointerEvent>,
    raycastActiveModelFromRay: (ray: THREE.Ray) => THREE.Intersection | null,
  ) => {
    const drag = holePunchDragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.placementId !== placementId) return;

    const hit = raycastActiveModelFromRay(event.ray);
    if (!hit) return;

    drag.moved = true;
    setHolePunchPlacements((previous) => previous.map((placement) => (
      placement.id === placementId
        ? buildHolePunchPlacementForHit(placement, hit)
        : placement
    )));
    setSelectedHolePunchPlacementIds((previous) => (
      previous.includes(placementId) ? previous : [placementId]
    ));
    setHoveredHolePunchPlacementId(placementId);
    setHolePunchHoverPlacement(null);
  }, [buildHolePunchPlacementForHit]);

  const handleHolePunchPlacementDragEnd = React.useCallback((
    placementId: string,
    event: ThreeEvent<PointerEvent>,
  ) => {
    const drag = holePunchDragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.placementId !== placementId) return;

    holePunchDragStateRef.current = null;
    const pointerTarget = event.target as Element | null;
    pointerTarget?.releasePointerCapture?.(event.pointerId);

    if (!drag.moved) return;

    suppressHolePunchClickPlacementIdRef.current = placementId;
    const activeModel = scene.activeModel;
    if (activeModel) {
      persistHolePunchPlacementsForModel(activeModel, holePunchPlacementsRef.current);
    }
  }, [persistHolePunchPlacementsForModel, scene.activeModel]);

  /**
   * Gizmo-based placement move — applies the delta directly without snapping
   * to surface normals, giving the user precise axis-constrained control.
   */
  const holePunchGizmoDragRef = React.useRef<{
    placementId: string;
    startWorldPoint: THREE.Vector3;
    startLocalPoint: THREE.Vector3;
    accumulatedDelta: THREE.Vector3;
    /** Inverse model matrix (world→local) captured at drag start, used to
     *  convert the world-space gizmo delta into the model's local coordinate
     *  space so the persisted localPoint stays accurate for Rust. */
    inverseModelMatrix: THREE.Matrix4;
  } | null>(null);

  const handleHolePunchGizmoMoveStart = React.useCallback((placementId: string) => {
    const placement = holePunchPlacementsRef.current.find((candidate) => candidate.id === placementId);
    if (!placement) {
      holePunchGizmoDragRef.current = null;
      return;
    }

    // Compute the inverse model matrix so we can convert the world-space
    // gizmo delta into the model's local coordinate space. This keeps
    // localPoint accurate for Rust serialization even when the model is
    // rotated.
    let inverseModelMatrix: THREE.Matrix4;
    const activeModel = scene.activeModel;
    if (activeModel && placement.modelId === activeModel.id) {
      const meshMatrix = new THREE.Matrix4()
        .compose(
          activeModel.transform.position.clone(),
          quaternionFromGlobalEuler(activeModel.transform.rotation),
          activeModel.transform.scale.clone(),
        )
        .multiply(new THREE.Matrix4().makeTranslation(
          -activeModel.geometry.center.x,
          -activeModel.geometry.center.y,
          -activeModel.geometry.center.z,
        ));
      inverseModelMatrix = meshMatrix.invert();
    } else {
      // Fallback: identity matrix (world = local), preserves old behavior.
      inverseModelMatrix = new THREE.Matrix4();
    }

    holePunchGizmoDragRef.current = {
      placementId,
      startWorldPoint: placement.worldPoint.clone(),
      startLocalPoint: placement.localPoint.clone(),
      accumulatedDelta: new THREE.Vector3(),
      inverseModelMatrix,
    };
  }, [scene.activeModel]);

  const handleHolePunchGizmoMove = React.useCallback((
    placementId: string,
    delta: THREE.Vector3,
  ) => {
    const drag = holePunchGizmoDragRef.current;
    if (!drag || drag.placementId !== placementId) return;

    drag.accumulatedDelta.add(delta);
    const nextWorldPoint = drag.startWorldPoint.clone().add(drag.accumulatedDelta);
    // Convert the new world point back to model local space using the
    // inverse matrix captured at drag start. Directly adding the world-space
    // delta to the local point would be wrong when the model has a rotation.
    const nextLocalPoint = nextWorldPoint.clone().applyMatrix4(drag.inverseModelMatrix);

    setHolePunchPlacements((previous) => {
      const nextPlacements = previous.map((placement) => {
        if (placement.id !== placementId) return placement;
        return {
          ...placement,
          worldPoint: nextWorldPoint.clone(),
          localPoint: nextLocalPoint.clone(),
        };
      });
      holePunchPlacementsRef.current = nextPlacements;
      return nextPlacements;
    });
  }, []);

  const handleHolePunchGizmoMoveEnd = React.useCallback((placementId: string) => {
    if (!holePunchGizmoDragRef.current || holePunchGizmoDragRef.current.placementId !== placementId) return;

    suppressHolePunchGizmoReleaseClickUntilRef.current = Date.now() + 250;
    holePunchGizmoDragRef.current = null;
    const activeModel = scene.activeModel;
    if (activeModel) {
      persistHolePunchPlacementsForModel(activeModel, holePunchPlacementsRef.current);
    }
  }, [persistHolePunchPlacementsForModel, scene.activeModel]);

  /**
   * Gizmo-based placement rotation — updates the cylinder normal without
   * snapping, giving the user precise rotational control via the gizmo rings.
   */
  const holePunchGizmoRotateRef = React.useRef<{ placementId: string } | null>(null);

  const handleHolePunchGizmoRotateStart = React.useCallback((placementId: string) => {
    holePunchGizmoRotateRef.current = { placementId };
  }, []);

  const handleHolePunchGizmoRotate = React.useCallback((
    placementId: string,
    newNormal: THREE.Vector3,
    worldFrame: HolePunchWorldFrame,
  ) => {
    if (!holePunchGizmoRotateRef.current || holePunchGizmoRotateRef.current.placementId !== placementId) return;

    // Convert the world-space normal to local space using the inverse
    // normal matrix, so the persisted direction stays accurate for Rust.
    let localNormal = newNormal.clone();
    const activeModel = scene.activeModel;
    if (activeModel) {
      const meshMatrix = new THREE.Matrix4()
        .compose(
          activeModel.transform.position.clone(),
          quaternionFromGlobalEuler(activeModel.transform.rotation),
          activeModel.transform.scale.clone(),
        )
        .multiply(new THREE.Matrix4().makeTranslation(
          -activeModel.geometry.center.x,
          -activeModel.geometry.center.y,
          -activeModel.geometry.center.z,
        ));
      const normalMatrix = new THREE.Matrix3().getNormalMatrix(meshMatrix);
      const inverseNormalMatrix = normalMatrix.clone().invert();
      localNormal = newNormal.clone().applyMatrix3(inverseNormalMatrix).normalize();
    }

    setHolePunchPlacements((previous) => {
      const nextPlacements = previous.map((placement) => {
        if (placement.id !== placementId) return placement;
        return {
          ...placement,
          worldNormal: newNormal.clone(),
          worldFrame: cloneHolePunchWorldFrame(worldFrame),
          localNormal,
        };
      });
      holePunchPlacementsRef.current = nextPlacements;
      return nextPlacements;
    });
  }, [scene.activeModel]);

  const handleHolePunchGizmoRotateEnd = React.useCallback((placementId: string) => {
    if (!holePunchGizmoRotateRef.current || holePunchGizmoRotateRef.current.placementId !== placementId) return;

    suppressHolePunchGizmoReleaseClickUntilRef.current = Date.now() + 250;
    holePunchGizmoRotateRef.current = null;
    const activeModel = scene.activeModel;
    if (activeModel) {
      persistHolePunchPlacementsForModel(activeModel, holePunchPlacementsRef.current);
    }
  }, [persistHolePunchPlacementsForModel, scene.activeModel]);

  const handleDeleteSelectedHolePunchPlacement = React.useCallback(() => {
    const activeModel = scene.activeModel;
    if (!activeModel || selectedHolePunchPlacementIds.length === 0) return;

    const selectedIds = new Set(selectedHolePunchPlacementIds);
    const nextPlacements = holePunchPlacements.filter((placement) => !selectedIds.has(placement.id));
    const remainingForModel = nextPlacements.filter((p) => p.modelId === activeModel.id);
    const holesWereBaked = activeModel.meshModifiers?.holePunchesBakedIntoGeometry === true;

    setHolePunchPlacements(nextPlacements);
    setSelectedHolePunchPlacementIds([]);
    setHoveredHolePunchPlacementId(null);
    setHolePunchHoverPlacement(null);

    // If holes were baked and we just deleted the last placement for the
    // active model, restore the pre-punch geometry so the boolean cut is
    // actually undone — otherwise the hole remains in the mesh and the
    // hollowing cache keeps pointing at stale geometry.
    if (holesWereBaked && remainingForModel.length === 0) {
      const restored = geometryFromSnapshot({
        sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
        sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
      });
      if (restored) {
        const restoredGeometry = restored.clone();
        const replaced = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Hole Punching (Removed)');
        if (!replaced) {
          restoredGeometry.dispose();
        }
        restored.dispose();
      }
      hollowingSourceByModelIdRef.current.delete(activeModel.id);
      // Clear the preview result cache too — it may hold a stale result from
      // when the hole was still present.
      for (const [key, entry] of hollowPreviewResultCacheRef.current.entries()) {
        if (entry.modelId === activeModel.id) {
          disposeHollowPreviewCacheEntry(entry);
          hollowPreviewResultCacheRef.current.delete(key);
        }
      }
      persistActiveModelModifiers({
        ...(activeModel.meshModifiers ?? {}),
        holePunches: [],
        holePunchAppliedPlacements: [],
        holePunchesBakedIntoGeometry: false,
        // Clear the source snapshot — pre-punch geometry was already restored
        // so there's nothing left to apply.
        holePunchSourcePositionsBase64: undefined,
        holePunchSourcePositionCount: undefined,
      });
    } else {
      persistHolePunchPlacementsForModel(activeModel, nextPlacements);
    }
  }, [holePunchPlacements, persistActiveModelModifiers, persistHolePunchPlacementsForModel, scene.activeModel, selectedHolePunchPlacementIds]);

  React.useEffect(() => {
    const unregister = registerDeleteHandler(
      () => (
        scene.mode === 'prepare'
        && transformMgr.transformMode === 'hollowing'
        && selectedHolePunchPlacementIds.length > 0
        && selectedHolePunchPlacements.some((placement) => placement.modelId === scene.activeModel?.id)
      ),
      handleDeleteSelectedHolePunchPlacement,
      50,
    );

    return () => {
      unregister();
    };
  }, [
    handleDeleteSelectedHolePunchPlacement,
    scene.activeModel?.id,
    scene.mode,
    selectedHolePunchPlacementIds.length,
    selectedHolePunchPlacements,
    transformMgr.transformMode,
  ]);

  const handleHolePunchStateChange = React.useCallback((next: HolePunchPanelState) => {
    const normalizedNext: HolePunchPanelState = canUseAutoHolePunchDepth
      ? next
      : { ...next, depthMode: 'manual' };
    setHolePunchState(normalizedNext);
    setHolePunchPlacements((previous) => {
      if (selectedHolePunchPlacementIds.length === 0) return previous;
      const nextPlacements = previous.map((placement) => (
        selectedHolePunchPlacementIdSet.has(placement.id)
          ? {
              ...placement,
              radiusMm: normalizedNext.radiusMm,
              radiusYMm: normalizedNext.radiusYMm,
              depthMm: normalizedNext.depthMode === 'auto'
                ? computeAutoHolePunchDepthMm(placement.modelId, placement.worldPoint, placement.worldNormal)
                : normalizedNext.depthMm,
              depthMode: normalizedNext.depthMode,
            }
          : placement
      ));

      const activeModel = scene.activeModel;
      if (activeModel) {
        persistHolePunchPlacementsForModel(activeModel, nextPlacements);
      }

      return nextPlacements;
    });
  }, [
    canUseAutoHolePunchDepth,
    computeAutoHolePunchDepthMm,
    persistHolePunchPlacementsForModel,
    scene.activeModel,
    selectedHolePunchPlacementIdSet,
    selectedHolePunchPlacementIds.length,
  ]);

  const handleResetHolePunch = React.useCallback(() => {
    const activeModel = scene.activeModel;
    const activeModelId = activeModel?.id ?? null;
    if (!activeModelId || !activeModel) return;

    const restored = geometryFromSnapshot({
      sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
      sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
    });
    if (restored) {
      const restoredGeometry = restored.clone();
      const replaced = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Reset Hole Punching');
      if (!replaced) {
        restoredGeometry.dispose();
      }
      restored.dispose();
    }

    // Pre-punch geometry was restored — invalidate the hollowing source cache
    // so the next hollowing preview uses the hole-free geometry.
    hollowingSourceByModelIdRef.current.delete(activeModel.id);

    setHolePunchPlacements((previous) => {
      const updated = previous.filter((placement) => placement.modelId !== activeModelId);
      persistActiveModelModifiers({
        ...(activeModel.meshModifiers ?? {}),
        holePunches: [],
        holePunchAppliedPlacements: [],
        // Pre-punch geometry was restored — no holes are baked into it.
        holePunchesBakedIntoGeometry: false,
        holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
        holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
      });
      return updated;
    });
    setHolePunchState(defaultHolePunchState);
    setSelectedHolePunchPlacementIds([]);
    setHoveredHolePunchPlacementId(null);
    setHolePunchHoverPlacement(null);
  }, [defaultHolePunchState, persistActiveModelModifiers, scene.activeModel]);

  const requestResetHollowing = React.useCallback(() => {
    if (!canResetHollowing || isApplyingHollowing || isPreviewingHollowing) return;
    setPendingModifierResetAction('hollowing');
  }, [canResetHollowing, isApplyingHollowing, isPreviewingHollowing]);

  const requestClearAppliedHollowing = React.useCallback(() => {
    setPendingModifierResetAction('clear_hollowing');
  }, []);

  const requestResetHolePunch = React.useCallback(() => {
    if (!canResetHolePunch || isApplyingHolePunch) return;
    const activeModel = scene.activeModel;
    const hasAppliedOrBakedPunches = (activeModel?.meshModifiers?.holePunchAppliedPlacements?.length ?? 0) > 0
      || Boolean(
        activeModel?.meshModifiers?.holePunchesBakedIntoGeometry
        && (activeModel?.meshModifiers?.holePunches?.length ?? 0) > 0,
      );
    if (!hasAppliedOrBakedPunches) {
      // Only un-applied draft punches — skip confirmation.
      handleResetHolePunch();
      return;
    }
    setPendingModifierResetAction('hole_punch');
  }, [canResetHolePunch, handleResetHolePunch, isApplyingHolePunch, scene.activeModel]);

  const handleConfirmModifierReset = React.useCallback(() => {
    const action = pendingModifierResetAction;
    setPendingModifierResetAction(null);
    if (action === 'hollowing') {
      handleResetHollowing();
      return;
    }
    if (action === 'clear_hollowing') {
      handleClearAppliedHollowing();
      return;
    }
    if (action === 'hole_punch') {
      handleResetHolePunch();
    }
  }, [handleClearAppliedHollowing, handleResetHolePunch, handleResetHollowing, pendingModifierResetAction]);

  const handleConfirmBlockerReset = React.useCallback(() => {
    const next = pendingBlockerResetState;
    setPendingBlockerResetState(null);
    if (!next) return;
    // Re-apply the state change that was deferred — this clears blockers.
    const resolutionChanged = Math.abs(next.voxelSizeMm - hollowingState.voxelSizeMm) > 1e-6;
    const blockedVoxelIndices = resolutionChanged ? [] : [];
    setHollowingState(next);
    setIsShellOpenFaceSelected(next.mode === 'shell_open_face' ? false : true);
    setHollowingDraftEnabled(true);
    setBlockedHollowVoxelIndices(blockedVoxelIndices);
    setEditingBlockedHollowVoxelIndices(blockedVoxelIndices);
    // Persist like handleHollowingStateChange does
    const activeModel = scene.activeModel;
    if (!activeModel) return;
    persistActiveModelModifiers({
      ...(activeModel.meshModifiers ?? {}),
      hollowing: {
        ...(activeModel.meshModifiers?.hollowing ?? {}),
        enabled: true,
        bakedIntoGeometry: false,
        blockedVoxelIndices,
        mode: next.mode,
        voxelSizeMm: next.voxelSizeMm,
        shellThicknessMm: next.shellThicknessMm,
        infillMode: next.infillMode ?? defaultHollowingState.infillMode,
        infillCellMm: next.infillCellMm ?? defaultHollowingState.infillCellMm,
        infillBeamRadiusMm: next.infillBeamRadiusMm ?? defaultHollowingState.infillBeamRadiusMm,
        openFace: next.openFace,
        openFaceSelected: next.mode === 'shell_open_face' ? false : true,
      },
    });
  }, [defaultHollowingState, hollowingState, pendingBlockerResetState, persistActiveModelModifiers, scene.activeModel]);

  const handleApplyHolePunch = React.useCallback(() => {
    void (async () => {
      const activeModel = scene.activeModel;
      if (!activeModel) return;

      const placements = activeHolePunchPlacements;
      const persisted = toPersistedHolePunchPlacements(activeModel, placements)
        .filter((placement) => placement.radiusMm > 0 && placement.depthMm > 0);

      const bakedPlacements = activeModel.meshModifiers?.holePunches ?? [];
      const bakedPlacementSignaturesById = new Map<string, string>();
      for (const placement of bakedPlacements) {
        bakedPlacementSignaturesById.set(placement.id, serializeSingleHolePunchPlacement(placement));
      }

      const draftPlacementSignaturesById = new Map<string, string>();
      for (const placement of persisted) {
        draftPlacementSignaturesById.set(placement.id, serializeSingleHolePunchPlacement(placement));
      }

      const bakedPlacementsUnchanged = bakedPlacements.every((placement) => (
        draftPlacementSignaturesById.get(placement.id) === serializeSingleHolePunchPlacement(placement)
      ));

      const appendOnlyNewPlacements = (
        activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        && bakedPlacementsUnchanged
        && persisted.length > bakedPlacements.length
      )
        ? persisted.filter((placement) => !bakedPlacementSignaturesById.has(placement.id))
        : [];

      const hasStoredPunchSource = Boolean(
        activeModel.meshModifiers?.holePunchSourcePositionsBase64
        && Number.isFinite(activeModel.meshModifiers?.holePunchSourcePositionCount)
        && (activeModel.meshModifiers?.holePunchSourcePositionCount ?? 0) > 0,
      );

      const useAppendOnlyFastPath = Boolean(
        activeModel.meshModifiers?.holePunchesBakedIntoGeometry
        && hasStoredPunchSource
        && appendOnlyNewPlacements.length > 0,
      );

      const punchesToApply = useAppendOnlyFastPath
        ? appendOnlyNewPlacements
        : persisted;

      if (persisted.length === 0) {
        const restored = geometryFromSnapshot({
          sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
          sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
        });

        if (restored) {
          const restoredGeometry = restored.clone();
          const replaced = scene.replaceModelGeometry(activeModel.id, restoredGeometry, 'Hole Punching (Removed)');
          if (!replaced) {
            restoredGeometry.dispose();
          }
          restored.dispose();
        }

        // Pre-punch geometry was restored — clear the hollowing cache so the
        // next preview resolves from the hole-free geometry.
        hollowingSourceByModelIdRef.current.delete(activeModel.id);

        persistActiveModelModifiers({
          ...(activeModel.meshModifiers ?? {}),
          holePunches: [],
          holePunchAppliedPlacements: [],
          // No holes remain in the geometry after restoring the pre-punch source.
          holePunchesBakedIntoGeometry: false,
          holePunchSourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
          holePunchSourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
        });
        return;
      }

      setIsApplyingHolePunch(true);
      await sleep(0);
      try {
        let sourceGeometry: THREE.BufferGeometry;
        let ownsSourceGeometry = false;
        let sourceSnapshot: {
          sourcePositionsBase64: string;
          sourcePositionCount: number;
        };

        if (useAppendOnlyFastPath) {
          sourceGeometry = activeModel.geometry.geometry.clone();
          ownsSourceGeometry = true;
          sourceSnapshot = {
            sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64 ?? '',
            sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount ?? 0,
          };
        } else if (hasStoredPunchSource) {
          const restoredFromSnapshot = geometryFromSnapshot({
            sourcePositionsBase64: activeModel.meshModifiers?.holePunchSourcePositionsBase64,
            sourcePositionCount: activeModel.meshModifiers?.holePunchSourcePositionCount,
          });

          if (!restoredFromSnapshot) {
            showOperationError('Hole punch source snapshot is missing or invalid. Re-apply cannot continue.');
            return;
          }

          sourceGeometry = restoredFromSnapshot;
          ownsSourceGeometry = true;
          sourceSnapshot = snapshotGeometryPositions(sourceGeometry);
        } else {
          sourceGeometry = activeModel.geometry.geometry.clone();
          ownsSourceGeometry = true;
          sourceSnapshot = snapshotGeometryPositions(sourceGeometry);
        }

        const sourceBbox = sourceGeometry.boundingBox
          ?? new THREE.Box3().setFromBufferAttribute(sourceGeometry.getAttribute('position') as THREE.BufferAttribute);
        const sourceSize = sourceBbox.getSize(new THREE.Vector3());
        const toMm = (norm: number, min: number, span: number) => min + (norm * (span <= 1e-9 ? 0 : span));
        const toNorm = (value: number, min: number, span: number) => (span <= 1e-9 ? 0.5 : (value - min) / span);

        const punchOptions: PunchOptions = {
          punches: punchesToApply.map((placement) => {
            const axis = new THREE.Vector3(
              placement.direction[0],
              placement.direction[1],
              placement.direction[2],
            );
            if (axis.lengthSq() <= 1e-12) {
              axis.set(0, 0, -1);
            } else {
              axis.normalize();
            }

            const axisScaleFactor = getDirectionScaleFactor(axis, activeModel.transform.scale);
            const radialScaleFactor = getRadialScaleFactor(axis, activeModel.transform.scale);
            const localOutsideProtrusionMm = worldMmToLocalMm(
              HOLE_PUNCH_OUTSIDE_PROTRUSION_MM,
              axisScaleFactor,
            );
            const localDepthMm = worldMmToLocalMm(placement.depthMm, axisScaleFactor);
            const localRadiusMm = worldMmToLocalMm(placement.radiusMm, radialScaleFactor);
            const localRadiusYMm = placement.radiusYMm != null
              ? worldMmToLocalMm(placement.radiusYMm, radialScaleFactor)
              : undefined;

            const surfaceCenterMm = new THREE.Vector3(
              toMm(placement.centerNorm[0], sourceBbox.min.x, sourceSize.x),
              toMm(placement.centerNorm[1], sourceBbox.min.y, sourceSize.y),
              toMm(placement.centerNorm[2], sourceBbox.min.z, sourceSize.z),
            );

            // Punch kernel expects cylinder start at centerNorm and extends along
            // direction for lengthMm. Shift start slightly opposite axis so cut
            // spans outside protrusion + requested depth inside.
            const shiftedStartMm = surfaceCenterMm.clone().add(
              axis.clone().multiplyScalar(-localOutsideProtrusionMm),
            );

            const shiftedStartNorm: [number, number, number] = [
              toNorm(shiftedStartMm.x, sourceBbox.min.x, sourceSize.x),
              toNorm(shiftedStartMm.y, sourceBbox.min.y, sourceSize.y),
              toNorm(shiftedStartMm.z, sourceBbox.min.z, sourceSize.z),
            ];

            // No longer clamp centerNorm to [0,1] — the Rust backend now
            // accepts out-of-bounds values so holes pulled outside the model
            // bbox via the gizmo stay exactly where the user positioned them.
            // The outside-protrusion shift may push the start past the bbox
            // boundary; compute the effective extra length from the actual
            // (unclamped) offset between surface center and shifted start.
            const shiftedStartMmActual = new THREE.Vector3(
              toMm(shiftedStartNorm[0], sourceBbox.min.x, sourceSize.x),
              toMm(shiftedStartNorm[1], sourceBbox.min.y, sourceSize.y),
              toMm(shiftedStartNorm[2], sourceBbox.min.z, sourceSize.z),
            );

            const effectiveOutsideMm = Math.max(
              0,
              surfaceCenterMm.clone().sub(shiftedStartMmActual).dot(axis),
            );

            return {
              centerNorm: shiftedStartNorm,
              radiusMm: localRadiusMm,
              radiusYMm: localRadiusYMm,
              direction: [axis.x, axis.y, axis.z] as [number, number, number],
              lengthMm: localDepthMm + effectiveOutsideMm,
            };
          }),
        };

        const punchSourceKey = useAppendOnlyFastPath
          ? `${activeModel.id}::append:${buildGeometryVersionKey(activeModel.geometry.geometry)}::${appendOnlyNewPlacements.length}`
          : hasStoredPunchSource
          ? `${activeModel.id}::hole-source:${activeModel.meshModifiers?.holePunchSourcePositionCount ?? 0}:${activeModel.meshModifiers?.holePunchSourcePositionsBase64?.length ?? 0}`
          : `${activeModel.id}::geom:${buildGeometryVersionKey(activeModel.geometry.geometry)}`;

        const staged = await stagePunchSource(sourceGeometry, punchSourceKey);
        if (!staged) {
          if (ownsSourceGeometry) {
            sourceGeometry.dispose();
          }
          showOperationError('Hole punching is available in DragonFruit Desktop only.');
          return;
        }

        const result = await punchFromCapturedSource(punchOptions);
        if (!result) {
          if (ownsSourceGeometry) {
            sourceGeometry.dispose();
          }
          showOperationError('Hole punching is available in DragonFruit Desktop only.');
          return;
        }

        // Detect manifold boolean failure: if the output triangle count matches
        // the source (mesh unchanged) despite valid punches, the mesh is too
        // damaged for boolean operations. We compare output vs source rather
        // than removedTriangleCount because manifold re-triangulation can
        // increase the triangle count (e.g., 136 → 210), making a saturating
        // subtraction report zero triangles removed even when the boolean
        // succeeded (non-hollowed meshes are especially prone to this).
        if (result.report.outputTriangleCount === result.report.sourceTriangleCount && result.report.punchCount > 0) {
          if (ownsSourceGeometry) {
            sourceGeometry.dispose();
          }
          setShowDamagedModelDialog(true);
          return;
        }

        const nextGeometry = new THREE.BufferGeometry();
        nextGeometry.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
        nextGeometry.computeVertexNormals();
        nextGeometry.computeBoundingBox();
        nextGeometry.computeBoundingSphere();

        const replaced = scene.replaceModelGeometry(
          activeModel.id,
          nextGeometry,
          `Hole Punching (${result.report.outputTriangleCount.toLocaleString()} tris)`,
        );
        if (!replaced) {
          if (ownsSourceGeometry) {
            sourceGeometry.dispose();
          }
          nextGeometry.dispose();
          return;
        }

        if (ownsSourceGeometry) {
          sourceGeometry.dispose();
        }

        // Hole-punched geometry just replaced the model — invalidate the
        // hollowing source cache so future hollowing previews resolve from
        // the current (hole-punched) geometry rather than a stale snapshot.
        hollowingSourceByModelIdRef.current.delete(activeModel.id);

        persistActiveModelModifiers({
          ...(activeModel.meshModifiers ?? {}),
          holePunches: persisted,
          holePunchAppliedPlacements: persisted,
          holePunchesBakedIntoGeometry: true,
          holePunchSourcePositionsBase64: sourceSnapshot.sourcePositionsBase64,
          holePunchSourcePositionCount: sourceSnapshot.sourcePositionCount,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showOperationError(`Hole punching failed: ${message}`);
      } finally {
        setIsApplyingHolePunch(false);
      }
    })();
  }, [activeHolePunchPlacements, persistActiveModelModifiers, scene, sleep]);

  React.useEffect(() => {
    if (!pendingHolePunchAutoApplyModelId) return;
    if (isApplyingHollowing || isApplyingHolePunch) return;

    const activeModel = scene.activeModel;
    if (!activeModel || activeModel.id !== pendingHolePunchAutoApplyModelId) {
      return;
    }

    if ((activeModel.meshModifiers?.holePunches?.length ?? 0) === 0) {
      setPendingHolePunchAutoApplyModelId(null);
      return;
    }

    setPendingHolePunchAutoApplyModelId(null);
    handleApplyHolePunch();
  }, [
    handleApplyHolePunch,
    isApplyingHolePunch,
    isApplyingHollowing,
    pendingHolePunchAutoApplyModelId,
    scene.activeModel,
  ]);

  const clearPendingHollowPreviewDebounce = React.useCallback(() => {
    if (hollowPreviewDebounceTimerRef.current !== null) {
      clearTimeout(hollowPreviewDebounceTimerRef.current);
      hollowPreviewDebounceTimerRef.current = null;
    }
  }, []);

  const resolveHollowPreviewSourceGeometry = React.useCallback((activeModel: (typeof scene.models)[number]) => {
    const sourceEntry = hollowingSourceByModelIdRef.current.get(activeModel.id);
    if (sourceEntry) {
      return sourceEntry.geometry;
    }

    // Only restore from the hollowing snapshot if hollowing is actually baked
    // (or at least enabled). If hollowing was reset/cleared, the snapshot is a
    // stale copy of the pre-hollowing geometry which may have holes that have
    // since been removed — using it would make the preview ignore hole changes.
    const h = activeModel.meshModifiers?.hollowing;
    const snapshotIsValid = h?.sourcePositionsBase64 && (h.bakedIntoGeometry || h.enabled);
    const restoredFromSnapshot = snapshotIsValid
      ? geometryFromSnapshot(h)
      : null;
    if (restoredFromSnapshot) {
      hollowingSourceByModelIdRef.current.set(activeModel.id, { geometry: restoredFromSnapshot });
      return restoredFromSnapshot;
    }

    return activeModel.geometry.geometry;
  }, []);

  const buildHollowingOptions = React.useCallback((
    modelScale: THREE.Vector3,
    maxExtent: number,
    tuning?: { preview?: boolean; previewShellThicknessMm?: number },
    stateOverride?: HollowingPanelState,
  ): HollowOptions => {
    const preview = Boolean(tuning?.preview);
    const state = stateOverride ?? hollowingState;
    const effectiveHollowMode = state.mode === 'shell_open_face'
      ? 'cavity'
      : state.mode;
    const voxelResolution = computeVoxelResolution(
      worldMmToLocalMm(state.voxelSizeMm, getUniformScaleFactorForThickness(modelScale)),
      maxExtent,
    );
    const shellThicknessMmWorld = preview
      ? (tuning?.previewShellThicknessMm ?? state.shellThicknessMm)
      : state.shellThicknessMm;
    const hasCommittedBlockedVoxels = blockedHollowVoxelIndices.length > 0;

    return {
      mode: effectiveHollowMode,
      voxelResolution,
      shellThicknessMm: worldMmToLocalMm(
        shellThicknessMmWorld,
        getUniformScaleFactorForThickness(modelScale),
      ),
      blockedVoxelIndices: blockedHollowVoxelIndices,
      infillMode: state.infillMode,
      infillCellMm: worldMmToLocalMm(
        state.infillCellMm,
        getUniformScaleFactorForThickness(modelScale),
      ),
      infillBeamRadiusMm: worldMmToLocalMm(
        state.infillBeamRadiusMm,
        getUniformScaleFactorForThickness(modelScale),
      ),
      openFace: state.openFace,
      drainHoles: [],
      previewCavityOnly: false,
      smoothInternalSurfaces: !preview || hasCommittedBlockedVoxels,
      internalChamferPasses: !preview || hasCommittedBlockedVoxels ? 2 : 0,
    };
  }, [
    hollowingState.mode,
    hollowingState.openFace,
    hollowingState.infillMode,
    hollowingState.infillBeamRadiusMm,
    hollowingState.infillCellMm,
    hollowingState.shellThicknessMm,
    hollowingState.voxelSizeMm,
    blockedHollowVoxelIndices,
  ]);

  const buildHollowPreviewRequest = React.useCallback((
    activeModel: (typeof scene.models)[number],
    overrideState?: HollowingPanelState,
  ) => {
    const previewState = overrideState ?? hollowingState;
    const previewShellThicknessMm = quantizePreviewShellThicknessMm(previewState.shellThicknessMm);
    const sourceGeometry = resolveHollowPreviewSourceGeometry(activeModel);
    const sourceGeometryKey = buildGeometryVersionKey(sourceGeometry);
    const bbox = sourceGeometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      sourceGeometry.getAttribute('position') as THREE.BufferAttribute,
    );
    const bboxSize = bbox.getSize(new THREE.Vector3());
    const maxExtent = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);
    const previewQuat = new THREE.Quaternion().setFromEuler(activeModel.transform.rotation);
    const options: HollowOptions = {
      ...buildHollowingOptions(activeModel.transform.scale, maxExtent, {
        preview: true,
        previewShellThicknessMm,
      }, previewState),
      drainHoles: [],
      previewCavityOnly: true,
      previewVoxelSpheres: true,
      rotationQuat: [previewQuat.x, previewQuat.y, previewQuat.z, previewQuat.w],
    };
    const optionsKey = JSON.stringify(options);
    const previewKey = `${activeModel.id}::${sourceGeometryKey}::${optionsKey}`;

    return {
      sourceGeometry,
      sourceGeometryKey,
      options,
      previewKey,
    };
  }, [
    buildHollowingOptions,
    hollowingState.shellThicknessMm,
    hollowingState.voxelSizeMm,
    resolveHollowPreviewSourceGeometry,
  ]);

  const cacheHollowPreviewResult = React.useCallback((
    activeModelId: string,
    report: HollowReport,
    positions: Float32Array,
    infillPositions: Float32Array | undefined,
    removedVoxelCenters: Float32Array | undefined,
    removedVoxelIndices: Uint32Array | undefined,
    blockedVoxelCenters: Float32Array | undefined,
    previewKey: string,
  ) => {
    const cachedPositions = new Float32Array(positions.length);
    cachedPositions.set(positions);
    const cachedRemovedVoxelCenters = removedVoxelCenters
      ? new Float32Array(removedVoxelCenters)
      : undefined;
    const cachedRemovedVoxelIndices = removedVoxelIndices
      ? new Uint32Array(removedVoxelIndices)
      : undefined;
    const cachedBlockedVoxelCenters = blockedVoxelCenters
      ? new Float32Array(blockedVoxelCenters)
      : undefined;

    hollowPreviewResultCacheRef.current.set(previewKey, {
      modelId: activeModelId,
      report,
      positions: cachedPositions,
      infillPositions,
      removedVoxelCenters: cachedRemovedVoxelCenters,
      removedVoxelIndices: cachedRemovedVoxelIndices,
      blockedVoxelCenters: cachedBlockedVoxelCenters,
      previewGeometry: null,
      infillGeometry: null,
    });

    if (hollowPreviewResultCacheRef.current.size > 6) {
      const oldest = hollowPreviewResultCacheRef.current.keys().next().value;
      if (oldest != null) {
        const evicted = hollowPreviewResultCacheRef.current.get(oldest);
        if (evicted) {
          disposeHollowPreviewCacheEntry(evicted);
        }
        hollowPreviewResultCacheRef.current.delete(oldest);
      }
    }

    return cachedPositions;
  }, []);

  const materializeHollowPreviewCacheEntry = React.useCallback((previewKey: string) => {
    const cached = hollowPreviewResultCacheRef.current.get(previewKey);
    if (!cached) return null;

    if (!cached.previewGeometry) {
      cached.previewGeometry = createGeometryFromPreviewPositions(cached.positions);
    }

    if (cached.infillPositions && !cached.infillGeometry) {
      cached.infillGeometry = createGeometryFromPreviewPositions(cached.infillPositions);
    }

    return cached;
  }, []);

  const primeHollowPreviewCache = React.useCallback(async (
    activeModel: (typeof scene.models)[number],
    overrideState?: HollowingPanelState,
  ) => {
    const { sourceGeometry, sourceGeometryKey, options, previewKey } = buildHollowPreviewRequest(activeModel, overrideState);

    if (hollowPreviewResultCacheRef.current.has(previewKey) || hollowPreviewWarmupKeyRef.current === previewKey) {
      return;
    }

    hollowPreviewWarmupKeyRef.current = previewKey;
    try {
      const staged = await stageHollowPreviewSource(
        sourceGeometry,
        `${activeModel.id}::${sourceGeometryKey}`,
      );
      if (!staged) {
        return;
      }

      const result = await hollowPreviewFromCapturedSource(options);
      if (!result) {
        return;
      }

      cacheHollowPreviewResult(
        activeModel.id,
        result.report,
        result.positions,
        result.infillPositions,
        result.removedVoxelCenters,
        result.removedVoxelIndices,
        result.blockedVoxelCenters,
        previewKey,
      );

      const scheduleMaterialize = typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function'
        ? (cb: () => void) => window.requestIdleCallback(() => cb())
        : (cb: () => void) => window.setTimeout(cb, 0);
      scheduleMaterialize(() => {
        try {
          materializeHollowPreviewCacheEntry(previewKey);
        } catch (error) {
          console.warn('[Hollowing] Failed to materialize cached preview geometry:', error);
        }
      });
    } catch (error) {
      console.warn('[Hollowing] Warm preview prime failed:', error);
    } finally {
      if (hollowPreviewWarmupKeyRef.current === previewKey) {
        hollowPreviewWarmupKeyRef.current = null;
      }
    }
  }, [buildHollowPreviewRequest, cacheHollowPreviewResult, materializeHollowPreviewCacheEntry]);

  const handleTransformToolbarHover = React.useCallback((mode: TransformMode | null) => {
    if (mode === 'hollowing') {
      if (scene.mode === 'prepare') {
        const activeModel = scene.activeModel;
        if (activeModel) {
          const persistedHollowing = activeModel.meshModifiers?.hollowing;
          const warmupState: HollowingPanelState = persistedHollowing?.enabled
            ? {
                mode: persistedHollowing.mode === 'shell_open_face' ? 'cavity' : persistedHollowing.mode,
                voxelSizeMm: persistedHollowing.voxelSizeMm,
                shellThicknessMm: persistedHollowing.shellThicknessMm,
                infillMode: persistedHollowing.infillMode ?? defaultHollowingState.infillMode,
                infillCellMm: persistedHollowing.infillCellMm ?? defaultHollowingState.infillCellMm,
                infillBeamRadiusMm: persistedHollowing.infillBeamRadiusMm ?? defaultHollowingState.infillBeamRadiusMm,
                openFace: persistedHollowing.openFace,
              }
            : defaultHollowingState;

          void primeHollowPreviewCache(activeModel, warmupState);
        }
      }
      return;
    }
  }, [
    defaultHollowingState,
    primeHollowPreviewCache,
    scene.activeModel,
    scene.mode,
  ]);

  const runHollowPreview = React.useCallback(async ({
    activeModel,
    sourceGeometry,
    sourceGeometryKey,
    options,
    previewKey,
    notifyUnavailable,
  }: {
    activeModel: (typeof scene.models)[number];
    sourceGeometry: THREE.BufferGeometry;
    sourceGeometryKey: string;
    options: HollowOptions;
    previewKey: string;
    notifyUnavailable: boolean;
  }) => {
    const requestSeq = ++hollowPreviewRequestSeqRef.current;
    setIsPreviewingHollowing(true);

    try {
      const cached = hollowPreviewResultCacheRef.current.get(previewKey);
      if (cached) {
        hollowPreviewResultCacheRef.current.delete(previewKey);
        hollowPreviewResultCacheRef.current.set(previewKey, cached);
        const materialized = materializeHollowPreviewCacheEntry(previewKey) ?? cached;
        const previewGeometry = materialized.previewGeometry ?? createGeometryFromPreviewPositions(materialized.positions);
        const infillGeometry = materialized.infillGeometry
          ?? (materialized.infillPositions ? createGeometryFromPreviewPositions(materialized.infillPositions) : null);
        if (hollowPreviewRequestSeqRef.current !== requestSeq) {
          disposeHollowPreviewGeometryIfUncached(previewGeometry, hollowPreviewResultCacheRef.current.values());
          disposeHollowPreviewGeometryIfUncached(infillGeometry, hollowPreviewResultCacheRef.current.values());
          return;
        }

        setHollowPreview((previous) => {
          if (previous) {
            disposeHollowPreviewGeometryIfUncached(previous.geometry, hollowPreviewResultCacheRef.current.values());
            disposeHollowPreviewGeometryIfUncached(previous.infillGeometry ?? null, hollowPreviewResultCacheRef.current.values());
          }
          return {
            modelId: cached.modelId,
            geometry: previewGeometry,
            infillGeometry,
            removedVoxelCenters: cached.removedVoxelCenters ?? new Float32Array(0),
            removedVoxelIndices: cached.removedVoxelIndices ?? new Uint32Array(0),
            blockedVoxelCenters: cached.blockedVoxelCenters,
            report: cached.report,
            previewKey,
            previewVoxelSpheres: true,
          };
        });
        return;
      }

      const staged = await stageHollowPreviewSource(
        sourceGeometry,
        `${activeModel.id}::${sourceGeometryKey}`,
      );
      if (!staged) {
        if (notifyUnavailable) {
          showOperationError('Hollowing preview is available in DragonFruit Desktop only.');
        }
        return;
      }

      const result = await hollowPreviewFromCapturedSource(options);
      if (!result) {
        if (notifyUnavailable) {
          showOperationError('Hollowing preview is available in DragonFruit Desktop only.');
        }
        return;
      }

      const cachedPositions = cacheHollowPreviewResult(
        activeModel.id,
        result.report,
        result.positions,
        result.infillPositions,
        result.removedVoxelCenters,
        result.removedVoxelIndices,
        result.blockedVoxelCenters,
        previewKey,
      );
      const materialized = materializeHollowPreviewCacheEntry(previewKey);

      const previewGeometry = materialized?.previewGeometry
        ?? createGeometryFromPreviewPositions(cachedPositions);
      const infillGeometry = materialized?.infillGeometry
        ?? (result.infillPositions
          ? createGeometryFromPreviewPositions(result.infillPositions)
          : null);

      if (hollowPreviewRequestSeqRef.current !== requestSeq) {
        disposeHollowPreviewGeometryIfUncached(previewGeometry, hollowPreviewResultCacheRef.current.values());
        disposeHollowPreviewGeometryIfUncached(infillGeometry, hollowPreviewResultCacheRef.current.values());
        return;
      }

      setHollowPreview((previous) => {
        if (previous) {
          disposeHollowPreviewGeometryIfUncached(previous.geometry, hollowPreviewResultCacheRef.current.values());
          disposeHollowPreviewGeometryIfUncached(previous.infillGeometry ?? null, hollowPreviewResultCacheRef.current.values());
        }
        return {
          modelId: activeModel.id,
          geometry: previewGeometry,
          infillGeometry,
          removedVoxelCenters: result.removedVoxelCenters ?? new Float32Array(0),
          removedVoxelIndices: result.removedVoxelIndices ?? new Uint32Array(0),
          blockedVoxelCenters: result.blockedVoxelCenters,
          report: result.report,
          previewKey,
          previewVoxelSpheres: true,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (notifyUnavailable) {
        showOperationError(`Hollowing preview failed: ${message}`);
      } else {
        console.warn('[Hollowing] Debounced preview failed:', message);
      }
    } finally {
      if (hollowPreviewRequestSeqRef.current === requestSeq) {
        setIsPreviewingHollowing(false);
        setIsApplyingBlockersHollowing(false);
      }
    }
  }, [cacheHollowPreviewResult, scene.models]);

  const clearHollowPreview = React.useCallback(() => {
    hollowPreviewRequestSeqRef.current += 1;
    setIsPreviewingHollowing(false);
    clearPendingHollowPreviewDebounce();
    setHollowPreview((previous) => {
      if (previous) {
        disposeHollowPreviewGeometryIfUncached(previous.geometry, hollowPreviewResultCacheRef.current.values());
        disposeHollowPreviewGeometryIfUncached(previous.infillGeometry ?? null, hollowPreviewResultCacheRef.current.values());
      }
      return null;
    });
  }, [clearPendingHollowPreviewDebounce]);

  React.useEffect(() => {
    return () => {
      if (hollowPreview) {
        hollowPreview.geometry.dispose();
        hollowPreview.infillGeometry?.dispose();
      }
    };
  }, [hollowPreview]);

  React.useEffect(() => {
    return () => {
      clearPendingHollowPreviewDebounce();
    };
  }, [clearPendingHollowPreviewDebounce]);

  React.useEffect(() => {
    const liveIds = new Set(scene.models.map((model) => model.id));
    for (const [modelId, entry] of hollowingSourceByModelIdRef.current.entries()) {
      if (liveIds.has(modelId)) continue;
      entry.geometry.dispose();
      hollowingSourceByModelIdRef.current.delete(modelId);
    }

    for (const [modelId, entry] of cavityGeometryByModelIdRef.current.entries()) {
      if (liveIds.has(modelId)) continue;
      entry.geometry.dispose();
      cavityGeometryByModelIdRef.current.delete(modelId);
    }

    // If the active model's cavity geometry was just removed, exit interior view
    // so the user doesn't get stuck with no way to toggle it off.
    if (
      interiorView &&
      (!scene.activeModel || !cavityGeometryByModelIdRef.current.has(scene.activeModel.id))
    ) {
      setInteriorView(false);
    }

    for (const [cacheKey, entry] of hollowPreviewResultCacheRef.current.entries()) {
      if (liveIds.has(entry.modelId)) continue;
      disposeHollowPreviewCacheEntry(entry);
      hollowPreviewResultCacheRef.current.delete(cacheKey);
    }
  }, [scene.models, interiorView, setInteriorView]);

  // Restore cavity geometry from persisted data for models with baked hollowing.
  React.useEffect(() => {
    for (const model of scene.models) {
      const hollowing = scene.getModelMeshModifiers(model.id)?.hollowing;
      if (!hollowing?.enabled || !hollowing.cavityPositionsBase64 || !hollowing.cavityPositionCount) {
        continue;
      }
      if (cavityGeometryByModelIdRef.current.has(model.id)) {
        continue; // already restored
      }

      const bytes = base64ToBytes(hollowing.cavityPositionsBase64);
      if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) continue;
      const view = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
      );
      if (view.length !== hollowing.cavityPositionCount * 3) continue;

      const positions = new Float32Array(view.length);
      positions.set(view);
      const cavityGeometry = new THREE.BufferGeometry();
      cavityGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      cavityGeometry.computeVertexNormals();
      cavityGeometry.computeBoundingBox();
      cavityGeometry.computeBoundingSphere();
      cavityGeometryByModelIdRef.current.set(model.id, { geometry: cavityGeometry });
    }
  }, [scene.models]);

  React.useEffect(() => {
    return () => {
      for (const entry of hollowingSourceByModelIdRef.current.values()) {
        entry.geometry.dispose();
      }
      hollowingSourceByModelIdRef.current.clear();
      for (const entry of cavityGeometryByModelIdRef.current.values()) {
        entry.geometry.dispose();
      }
      cavityGeometryByModelIdRef.current.clear();
      for (const entry of hollowPreviewResultCacheRef.current.values()) {
        disposeHollowPreviewCacheEntry(entry);
      }
      hollowPreviewResultCacheRef.current.clear();
    };
  }, []);

  React.useEffect(() => {
    if (!hollowPreview) return;
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'hollowing') {
      clearHollowPreview();
      return;
    }
    const stillExists = scene.models.some((model) => model.id === hollowPreview.modelId);
    if (!stillExists) {
      clearHollowPreview();
    }
  }, [clearHollowPreview, hollowPreview, scene.mode, scene.models, transformMgr.transformMode]);

  React.useEffect(() => {
    if (scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing') {
      return;
    }
    setHollowingEditMode(false);
    setEditingBlockedHollowVoxelIndices(blockedHollowVoxelIndices);
  }, [blockedHollowVoxelIndices, scene.mode, transformMgr.transformMode]);

  const resolveBlockedHollowVoxelMarqueeSelection = React.useCallback((
    polygon: Array<{ x: number; y: number }>,
    helpers: {
      projectWorldPoint: (point: THREE.Vector3) => { x: number; y: number; z: number } | null;
    },
  ) => {
    const preview = hollowPreview;
    const activeModel = scene.activeModel;
    if (!preview || !activeModel || polygon.length < 3) return [] as string[];

    const pointInPolygon = (x: number, y: number) => {
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;
        const intersects = ((yi > y) !== (yj > y))
          && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-6) + xi);
        if (intersects) inside = !inside;
      }
      return inside;
    };

    const modelQuaternion = quaternionFromGlobalEuler(activeModel.transform.rotation);
    const selected: string[] = [];

    for (let instanceIndex = 0; instanceIndex < preview.removedVoxelIndices.length; instanceIndex += 1) {
      const offset = instanceIndex * 3;
      const localPoint = new THREE.Vector3(
        preview.removedVoxelCenters[offset] - activeModel.geometry.center.x,
        preview.removedVoxelCenters[offset + 1] - activeModel.geometry.center.y,
        preview.removedVoxelCenters[offset + 2] - activeModel.geometry.center.z,
      );
      localPoint.multiply(activeModel.transform.scale);
      localPoint.applyQuaternion(modelQuaternion);
      localPoint.add(activeModel.transform.position);
      const projected = helpers.projectWorldPoint(localPoint);
      if (!projected) continue;
      if (!pointInPolygon(projected.x, projected.y)) continue;
      selected.push(String(preview.removedVoxelIndices[instanceIndex]));
    }

    // Also test blocked-only voxel centers so lassoing over them works.
    if (preview.blockedVoxelCenters) {
      const blockedCount = Math.floor(preview.blockedVoxelCenters.length / 3);
      for (let blockedIndex = 0; blockedIndex < blockedCount; blockedIndex += 1) {
        const offset = blockedIndex * 3;
        const localPoint = new THREE.Vector3(
          preview.blockedVoxelCenters[offset] - activeModel.geometry.center.x,
          preview.blockedVoxelCenters[offset + 1] - activeModel.geometry.center.y,
          preview.blockedVoxelCenters[offset + 2] - activeModel.geometry.center.z,
        );
        localPoint.multiply(activeModel.transform.scale);
        localPoint.applyQuaternion(modelQuaternion);
        localPoint.add(activeModel.transform.position);
        const projected = helpers.projectWorldPoint(localPoint);
        if (!projected) continue;
        if (!pointInPolygon(projected.x, projected.y)) continue;
        selected.push(String(blockedHollowVoxelIndices[blockedIndex]));
      }
    }

    return selected;
  }, [hollowPreview, scene.activeModel, blockedHollowVoxelIndices]);

  const handleBlockedHollowVoxelMarqueeSelection = React.useCallback((ids: string[], altKey?: boolean) => {
    if (ids.length === 0) return;
    const next = new Set(editingBlockedHollowVoxelIndicesRef.current);
    if (altKey) {
      // Alt + lasso: un-block (remove from the blocked set).
      for (const id of ids) {
        const voxelIndex = Number(id);
        if (!Number.isFinite(voxelIndex)) continue;
        next.delete(voxelIndex);
      }
    } else {
      // Plain lasso: block (add to the blocked set).
      for (const id of ids) {
        const voxelIndex = Number(id);
        if (!Number.isFinite(voxelIndex)) continue;
        next.add(voxelIndex);
      }
    }
    applyEditingBlockedHollowVoxelIndices(next);
  }, [applyEditingBlockedHollowVoxelIndices]);

  const handleStartHollowVoxelEditing = React.useCallback(() => {
    editingBlockedHollowVoxelIndicesRef.current = blockedHollowVoxelIndices;
    hollowVoxelEditUndoStackRef.current = [];
    hollowVoxelEditRedoStackRef.current = [];
    setEditingBlockedHollowVoxelIndices(blockedHollowVoxelIndices);
    setHollowingEditMode(true);
  }, [blockedHollowVoxelIndices]);

  const handleClearHollowVoxelEditing = React.useCallback(() => {
    applyEditingBlockedHollowVoxelIndices([]);
  }, [applyEditingBlockedHollowVoxelIndices]);

  const handleDoneHollowVoxelEditing = React.useCallback(() => {
    const nextIndices = [...editingBlockedHollowVoxelIndices].sort((a, b) => a - b);
    const prevIndices = [...blockedHollowVoxelIndices].sort((a, b) => a - b);
    const hasChanges = nextIndices.length !== prevIndices.length
      || nextIndices.some((v, i) => v !== prevIndices[i]);

    if (!hasChanges) {
      setHollowingEditMode(false);
      return;
    }

    commitBlockedHollowVoxelIndices(nextIndices);
    clearHollowPreview();
    setHollowingEditMode(false);
    setIsApplyingBlockersHollowing(true);
  }, [blockedHollowVoxelIndices, clearHollowPreview, commitBlockedHollowVoxelIndices, editingBlockedHollowVoxelIndices]);

  React.useEffect(() => {
    if (canUseAutoHolePunchDepth || holePunchState.depthMode !== 'auto') {
      return;
    }

    setHolePunchState((previous) => ({ ...previous, depthMode: 'manual' }));
  }, [canUseAutoHolePunchDepth, holePunchState.depthMode]);

  React.useEffect(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode === 'hollowing') {
      return;
    }

    const activeModel = scene.activeModel;
    if (!activeModel) {
      return;
    }

    const persistedHollowing = activeModel.meshModifiers?.hollowing;
    const warmupState: HollowingPanelState = persistedHollowing?.enabled
      ? {
          mode: persistedHollowing.mode === 'shell_open_face' ? 'cavity' : persistedHollowing.mode,
          voxelSizeMm: persistedHollowing.voxelSizeMm,
          shellThicknessMm: persistedHollowing.shellThicknessMm,
          infillMode: persistedHollowing.infillMode ?? defaultHollowingState.infillMode,
          infillCellMm: persistedHollowing.infillCellMm ?? defaultHollowingState.infillCellMm,
          infillBeamRadiusMm: persistedHollowing.infillBeamRadiusMm ?? defaultHollowingState.infillBeamRadiusMm,
          openFace: persistedHollowing.openFace,
        }
      : defaultHollowingState;

    const previewRequest = buildHollowPreviewRequest(activeModel, warmupState);
    if (hollowPreviewResultCacheRef.current.has(previewRequest.previewKey)
      || hollowPreviewWarmupKeyRef.current === previewRequest.previewKey) {
      return;
    }

    void primeHollowPreviewCache(activeModel, warmupState);
  }, [
    buildHollowPreviewRequest,
    defaultHollowingState,
    primeHollowPreviewCache,
    scene.activeModel,
    scene.mode,
    transformMgr.transformMode,
  ]);

  React.useEffect(() => {
    const activeModel = scene.activeModel;
    if (!activeModel) {
      setHolePunchPlacements([]);
      setSelectedHolePunchPlacementIds([]);
      setHolePunchHoverPlacement(null);
      setHollowingState(defaultHollowingState);
      setIsShellOpenFaceSelected(true);
      setHollowingDraftEnabled(false);
      setHollowingEditMode(false);
      setBlockedHollowVoxelIndices([]);
      setEditingBlockedHollowVoxelIndices([]);
      setHolePunchState(defaultHolePunchState);
      return;
    }

    const persistedPlacements = fromPersistedHolePunchPlacements(
      activeModel,
      activeModel.meshModifiers?.holePunches ?? [],
    );

    // Preserve worldFrame from current draft placements when the id matches
    // and the normal is unchanged. This prevents the persist round-trip from
    // dropping X/Z-axis rotation (around the cylinder's own axis) applied via
    // the gizmo — without this the gizmo rotation snaps back on release.
    setHolePunchPlacements((previous) => {
      const prevById = new Map(previous.map((p) => [p.id, p]));
      return persistedPlacements.map((placement) => {
        const prev = prevById.get(placement.id);
        if (
          prev?.worldFrame
          && placement.worldNormal.distanceToSquared(prev.worldNormal) < 1e-8
        ) {
          return { ...placement, worldFrame: prev.worldFrame };
        }
        return placement;
      });
    });
    setHoveredHolePunchPlacementId((previous) => (
      previous && persistedPlacements.some((placement) => placement.id === previous)
        ? previous
        : null
    ));
    setHolePunchHoverPlacement(null);

    const persistedHollowing = activeModel.meshModifiers?.hollowing;
    const nextCanUseAutoHolePunchDepth = Boolean(
      persistedHollowing?.enabled || persistedHollowing?.bakedIntoGeometry,
    );
    const nextHollowingPanelState = {
      mode: (persistedHollowing?.mode ?? defaultHollowingState.mode) === 'shell_open_face' ? 'cavity' : (persistedHollowing?.mode ?? defaultHollowingState.mode),
      voxelSizeMm: persistedHollowing?.voxelSizeMm ?? defaultHollowingState.voxelSizeMm,
      shellThicknessMm: persistedHollowing?.shellThicknessMm ?? defaultHollowingState.shellThicknessMm,
      infillMode: persistedHollowing?.infillMode ?? defaultHollowingState.infillMode,
      infillCellMm: persistedHollowing?.infillCellMm ?? defaultHollowingState.infillCellMm,
      infillBeamRadiusMm: persistedHollowing?.infillBeamRadiusMm ?? defaultHollowingState.infillBeamRadiusMm,
      openFace: persistedHollowing?.openFace ?? defaultHollowingState.openFace,
    };

    const nextShellOpenFaceSelected = nextHollowingPanelState.mode === 'shell_open_face'
      ? (persistedHollowing?.openFaceSelected ?? true)
      : true;
    setIsShellOpenFaceSelected(nextShellOpenFaceSelected);
    if (!nextShellOpenFaceSelected) {
      setSelectedHolePunchPlacementIds([]);
      setHoveredHolePunchPlacementId(null);
      setHolePunchHoverPlacement(null);
    }

    if (persistedHollowing?.enabled) {
      setHollowingDraftEnabled(true);
      setHollowingState(nextHollowingPanelState);
    } else {
      setHollowingDraftEnabled(false);
      setHollowingState(nextHollowingPanelState);
    }
    // If the persisted data lacks voxelSizeMm (old voxelResolution format), the
    // blocked indices were computed at a fixed resolution that doesn't map to the
    // current voxel-size-based grid — clear them to avoid corrupt previews.
    const blockersFromOldFormat = (
      persistedHollowing?.blockedVoxelIndices?.length
      && persistedHollowing.voxelSizeMm == null
      && 'voxelResolution' in (persistedHollowing as Record<string, unknown>)
    );
    const persistedBlockedIndices = blockersFromOldFormat
      ? (console.warn('[Hollowing] Cleared blockers from old voxelResolution format — incompatible with current voxel-size grid.'), [])
      : (persistedHollowing?.blockedVoxelIndices ?? []);
    setBlockedHollowVoxelIndices(persistedBlockedIndices);
    // Preserve edit mode state: don't reset editing indices or exit edit mode
    // when a hollowing parameter change (e.g. shell thickness or voxel resolution)
    // triggers this sync effect through the model modifier update.
    if (!hollowingEditModeRef.current) {
      setEditingBlockedHollowVoxelIndices(persistedBlockedIndices);
      setHollowingEditMode(false);
    }

    setSelectedHolePunchPlacementIds((previous) => {
      const nextSelectedIds = previous.filter(
        (id) => persistedPlacements.some((placement) => placement.id === id),
      );
      if (nextSelectedIds.length > 0) {
        syncHolePunchPanelFromSelection(
          nextSelectedIds,
          persistedPlacements,
          nextSelectedIds[nextSelectedIds.length - 1] ?? null,
          nextCanUseAutoHolePunchDepth,
        );
      } else if (persistedPlacements.length === 0) {
        setHolePunchState((previousState) => ({
          radiusMm: previousState.radiusMm,
          depthMm: getDefaultHolePunchDepthMm(nextHollowingPanelState.shellThicknessMm),
          depthMode: nextCanUseAutoHolePunchDepth ? previousState.depthMode : 'manual',
        }));
      } else {
        setHolePunchState((previousState) => ({
          ...previousState,
          depthMode: nextCanUseAutoHolePunchDepth ? previousState.depthMode : 'manual',
        }));
      }
      return nextSelectedIds;
    });
  }, [
    canUseAutoHolePunchDepth,
    scene.activeModel,
    defaultHolePunchState,
    defaultHollowingState,
    syncHolePunchPanelFromSelection,
  ]);

  React.useEffect(() => {
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'hollowing') {
      return;
    }

    if (isApplyingHollowing) return;

    if (isHollowingApplied && !isHollowingDirty) {
      clearPendingHollowPreviewDebounce();
      if (hollowPreview) {
        clearHollowPreview();
      }
      return;
    }

    if (isShellFaceSelectionPending) {
      clearPendingHollowPreviewDebounce();
      if (hollowPreview) {
        clearHollowPreview();
      }
      return;
    }

    const activeModel = scene.activeModel;
    if (!activeModel) {
      clearHollowPreview();
      return;
    }

    const previewShellThicknessMm = quantizePreviewShellThicknessMm(hollowingState.shellThicknessMm);
    const sourceGeometry = resolveHollowPreviewSourceGeometry(activeModel);
    const sourceGeometryKey = buildGeometryVersionKey(sourceGeometry);
    const bbox = sourceGeometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
      sourceGeometry.getAttribute('position') as THREE.BufferAttribute,
    );
    const bboxSize = bbox.getSize(new THREE.Vector3());
    const maxExtent = Math.max(bboxSize.x, bboxSize.y, bboxSize.z);

    const debounceQuat = new THREE.Quaternion().setFromEuler(activeModel.transform.rotation);
    const options: HollowOptions = {
      ...buildHollowingOptions(activeModel.transform.scale, maxExtent, {
        preview: true,
        previewShellThicknessMm,
      }),
      previewCavityOnly: true,
      rotationQuat: [debounceQuat.x, debounceQuat.y, debounceQuat.z, debounceQuat.w],
    };
    const optionsKey = JSON.stringify(options);
    const previewKey = `${activeModel.id}::${sourceGeometryKey}::${optionsKey}`;

    if (hollowPreview && hollowPreview.modelId === activeModel.id && hollowPreview.previewKey === previewKey) {
      return;
    }

    clearPendingHollowPreviewDebounce();
    hollowPreviewDebounceTimerRef.current = setTimeout(() => {
      void runHollowPreview({
        activeModel,
        sourceGeometry,
        sourceGeometryKey,
        options,
        previewKey,
        notifyUnavailable: false,
      });
    }, HOLLOW_PREVIEW_DEBOUNCE_MS);

    return () => {
      clearPendingHollowPreviewDebounce();
    };
  }, [
    buildHollowingOptions,
    clearHollowPreview,
    clearPendingHollowPreviewDebounce,
    hollowPreview,
    isHollowingApplied,
    isHollowingDirty,
    isApplyingHollowing,
    isShellFaceSelectionPending,
    resolveHollowPreviewSourceGeometry,
    runHollowPreview,
    scene.activeModel,
    scene.mode,
    transformMgr.transformMode,
  ]);

  const handlePlaceOnFace = React.useCallback((modelId: string) => {
    if (scene.activeModelId !== modelId) return;
    handleTransformEnd('rotate');
  }, [handleTransformEnd, scene.activeModelId]);

  const handlePlaceOnFaceBeforeApply = React.useCallback((_normal: THREE.Vector3, continueApply: () => void) => {
    return requestDestructiveTransformSupportDeletionWithContinuation('Place On Face', continueApply);
  }, [requestDestructiveTransformSupportDeletionWithContinuation]);

  const mirrorToolActive = scene.mode === 'prepare' && transformMgr.transformMode === 'mirror';

  // Mirror session state: while the user is in Mirror mode we don't bake the
  // geometry per-click (a 2.4M-vert bake is slow on big meshes). Instead, each
  // click toggles a parity bit and applies a negative-scale transform — the GPU
  // renders the flip immediately. On exit we run one combined bake against the
  // accumulated parity bits and reset the scale to positive.
  const mirrorSessionRef = React.useRef<{
    modelId: string;
    flips: { x: boolean; y: boolean; z: boolean };
    initialTransform: ModelTransform;
    previewTransform: ModelTransform;
    initialGeometry: GeometryWithBounds;
  } | null>(null);
  const mirrorPrevToolActiveRef = React.useRef(false);
  const mirrorLocalOriginRef = React.useRef(new THREE.Vector3(0, 0, 0));
  // Tracks a pending deferred bake so we can cancel/flush it on mode switch.
  const pendingBakeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks an in-flight bake worker so it can be terminated on flush.
  const pendingBakeWorkerRef = React.useRef<Worker | null>(null);

  const syncTransformManagerToTransform = React.useCallback((nextTransform: ModelTransform) => {
    // Keep transform-manager state aligned with raw mirror updates so the
    // persistence bridge cannot write a stale transform back into the model.
    suppressTransformPersistenceCycles(8);
    transformMgr.transformHook.setPosition(
      nextTransform.position.x,
      nextTransform.position.y,
      nextTransform.position.z,
    );
    transformMgr.transformHook.setRotation(
      nextTransform.rotation.x,
      nextTransform.rotation.y,
      nextTransform.rotation.z,
    );
    transformMgr.transformHook.setScale(
      nextTransform.scale.x,
      nextTransform.scale.y,
      nextTransform.scale.z,
    );
  }, [suppressTransformPersistenceCycles, transformMgr.transformHook]);

  const finalizeMirrorSession = React.useCallback(() => {
    const session = mirrorSessionRef.current;
    mirrorSessionRef.current = null;
    if (!session) return;

    const { modelId, flips, previewTransform, initialGeometry } = session;
    const anyFlip = flips.x || flips.y || flips.z;

    if (!anyFlip) {
      // Net-zero session (e.g. user clicked X twice). Nothing to commit.
      return;
    }

    let baked: THREE.BufferGeometry | null = null;
    try {
      baked = bakeWithFlips(initialGeometry.geometry, flips);
    } catch (error) {
      console.error('[Mirror] bakeWithFlips threw during finalize, preserving live mirrored state:', error);
      return;
    }
    if (!baked) {
      return;
    }

    // Preserve mirrored orientation while converting from reflected preview
    // transform to baked geometry: finalTransform * bakedGeometry == previewTransform * sourceGeometry.
    const bakeLocalMatrix = new THREE.Matrix4().identity();
    const bakeLocalElements = bakeLocalMatrix.elements;
    bakeLocalElements[0] = flips.x ? -1 : 1;
    bakeLocalElements[5] = flips.y ? -1 : 1;
    bakeLocalElements[10] = flips.z ? -1 : 1;

    const previewMatrix = new THREE.Matrix4().compose(
      previewTransform.position.clone(),
      quaternionFromGlobalEuler(previewTransform.rotation),
      previewTransform.scale.clone(),
    );
    const finalizedMatrix = previewMatrix.clone().multiply(bakeLocalMatrix);
    const finalizedPosition = new THREE.Vector3();
    const finalizedQuaternion = new THREE.Quaternion();
    const finalizedScale = new THREE.Vector3();
    finalizedMatrix.decompose(finalizedPosition, finalizedQuaternion, finalizedScale);
    const finalizedTransform: ModelTransform = {
      position: finalizedPosition,
      rotation: new THREE.Euler().setFromQuaternion(finalizedQuaternion, 'ZYX'),
      scale: finalizedScale,
    };

    // Replace geometry FIRST (direct setModels call using modelsRef.current),
    // then apply the finalized transform AFTER via a functional setModels updater.
    // This ordering matters: replaceModelGeometry uses a direct state value from
    // modelsRef.current (pre-mirror transform), so any prior setModelTransformRaw
    // functional updates get overwritten by the direct call. By setting the transform
    // AFTER replaceModelGeometry, the functional updater applies on top of the
    // direct state and the final batched React state has both the correct geometry
    // AND the correct transform.
    const axes = [flips.x && 'X', flips.y && 'Y', flips.z && 'Z'].filter(Boolean).join(', ');
    scene.replaceModelGeometry(modelId, baked, `Mirror Model (${axes})`, {
      includeSupportState: !flips.z,
    });
    scene.setModelTransformRaw(modelId, {
      position: finalizedTransform.position.clone(),
      rotation: finalizedTransform.rotation.clone(),
      scale: finalizedTransform.scale.clone(),
    });
    syncTransformManagerToTransform(finalizedTransform);
  }, [scene, transformMgr, syncTransformManagerToTransform]);

  // Schedules baking off the main thread via a Web Worker so the visual mirror
  // renders instantly. Cancels any in-flight worker/timer so rapid successive
  // clicks only trigger one bake pass. The session stays alive until the worker
  // completes (or flushPendingBake terminates it) so flushPendingBake can still
  // call finalizeMirrorSession as a synchronous fallback.
  const scheduleBake = React.useCallback(() => {
    // Cancel any previously scheduled bake.
    if (pendingBakeTimerRef.current !== null) {
      clearTimeout(pendingBakeTimerRef.current);
      pendingBakeTimerRef.current = null;
    }
    if (pendingBakeWorkerRef.current) {
      pendingBakeWorkerRef.current.terminate();
      pendingBakeWorkerRef.current = null;
    }

    const session = mirrorSessionRef.current;
    if (!session) return;

    const { modelId, flips, previewTransform, initialGeometry } = session;
    const anyFlip = flips.x || flips.y || flips.z;
    if (!anyFlip) {
      // Net-zero session: clear without baking.
      mirrorSessionRef.current = null;
      return;
    }

    // Compute the finalised transform on the main thread (pure matrix math, fast).
    const bakeLocalMatrix = new THREE.Matrix4().identity();
    const ble = bakeLocalMatrix.elements;
    ble[0] = flips.x ? -1 : 1;
    ble[5] = flips.y ? -1 : 1;
    ble[10] = flips.z ? -1 : 1;
    const previewMatrix = new THREE.Matrix4().compose(
      previewTransform.position.clone(),
      quaternionFromGlobalEuler(previewTransform.rotation),
      previewTransform.scale.clone(),
    );
    const finalizedMatrix = previewMatrix.clone().multiply(bakeLocalMatrix);
    const fPos = new THREE.Vector3();
    const fQuat = new THREE.Quaternion();
    const fScale = new THREE.Vector3();
    finalizedMatrix.decompose(fPos, fQuat, fScale);
    const finalizedTransform: ModelTransform = {
      position: fPos,
      rotation: new THREE.Euler().setFromQuaternion(fQuat, 'ZYX'),
      scale: fScale,
    };

    // Snapshot the geometry arrays needed by the worker.
    const source = initialGeometry.geometry;
    const posAttr = source.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!posAttr) {
      // No position attribute – fall back to synchronous bake.
      finalizeMirrorSession();
      return;
    }

    // Slice (memcpy) the arrays we need to modify; the originals stay on the
    // main thread so the session geometry remains intact for flush fallback.
    const positions = (posAttr.array as Float32Array).slice();
    const normAttr = source.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const normals = normAttr ? (normAttr.array as Float32Array).slice() : null;
    const idxAttr = source.getIndex();
    const rawIdx = idxAttr?.array;
    let indices: Uint16Array | Uint32Array | null = null;
    let indexType: 'uint16' | 'uint32' | null = null;
    if (rawIdx) {
      indices = rawIdx.slice() as Uint16Array | Uint32Array;
      indexType = rawIdx instanceof Uint16Array ? 'uint16' : 'uint32';
    }
    const posItemSize = posAttr.itemSize;
    const normItemSize = normAttr?.itemSize ?? 3;
    const axes: number[] = [];
    if (flips.x) axes.push(0);
    if (flips.y) axes.push(1);
    if (flips.z) axes.push(2);
    const axisLabel = [flips.x && 'X', flips.y && 'Y', flips.z && 'Z'].filter(Boolean).join(', ');
    const includeSupports = !flips.z;

    const worker = new Worker(
      new URL('@/features/mirror/workers/bakeMirrorWorker', import.meta.url),
      { type: 'module' },
    );
    pendingBakeWorkerRef.current = worker;

    const transferables: Transferable[] = [positions.buffer];
    if (normals) transferables.push(normals.buffer);
    if (indices) transferables.push(indices.buffer);
    worker.postMessage({ positions, normals, indices, posItemSize, normItemSize, axes }, transferables);

    worker.onmessage = (e: MessageEvent) => {
      // Discard result if a newer bake/flush already took over.
      if (pendingBakeWorkerRef.current !== worker) {
        worker.terminate();
        return;
      }
      pendingBakeWorkerRef.current = null;
      worker.terminate();

      // Clear the session now that the worker has committed the bake.
      mirrorSessionRef.current = null;

      const { positions: bp, normals: bn, indices: bi } = e.data as {
        positions: Float32Array;
        normals: Float32Array | null;
        indices: Uint16Array | Uint32Array | null;
      };

      // Reconstruct a Three.js geometry from the worker-returned arrays.
      // We avoid a full geometry.clone() – only the modified arrays were
      // copied; all other attributes (UV, vertex colour, etc.) are shared
      // by reference from the source (safe since they are never modified).
      const baked = new THREE.BufferGeometry();
      baked.setAttribute('position', new THREE.BufferAttribute(bp, posItemSize));
      if (bn) {
        baked.setAttribute('normal', new THREE.BufferAttribute(bn, normItemSize));
      } else {
        baked.computeVertexNormals();
      }
      if (bi) {
        baked.setIndex(new THREE.BufferAttribute(bi, 1));
      }
      const srcAttrs = source.attributes;
      for (const name of Object.keys(srcAttrs)) {
        if (name !== 'position' && name !== 'normal') {
          baked.setAttribute(name, srcAttrs[name] as THREE.BufferAttribute);
        }
      }
      baked.computeBoundingBox();
      baked.computeBoundingSphere();

      scene.replaceModelGeometry(modelId, baked, `Mirror Model (${axisLabel})`, {
        includeSupportState: includeSupports,
      });
      scene.setModelTransformRaw(modelId, {
        position: finalizedTransform.position.clone(),
        rotation: finalizedTransform.rotation.clone(),
        scale: finalizedTransform.scale.clone(),
      });
      syncTransformManagerToTransform(finalizedTransform);
    };

    worker.onerror = () => {
      if (pendingBakeWorkerRef.current !== worker) return;
      pendingBakeWorkerRef.current = null;
      worker.terminate();
      console.error('[Mirror] bake worker failed – falling back to synchronous bake');
      finalizeMirrorSession();
    };
  }, [scene, finalizeMirrorSession, syncTransformManagerToTransform]);

  // Cancels any pending deferred bake (timer or worker) and runs it
  // synchronously now. Used when exiting mirror mode so geometry is committed
  // before the tool switch fires.
  const flushPendingBake = React.useCallback(() => {
    if (pendingBakeTimerRef.current !== null) {
      clearTimeout(pendingBakeTimerRef.current);
      pendingBakeTimerRef.current = null;
    }
    if (pendingBakeWorkerRef.current) {
      pendingBakeWorkerRef.current.terminate();
      pendingBakeWorkerRef.current = null;
    }
    finalizeMirrorSession();
  }, [finalizeMirrorSession]);

  React.useEffect(() => {
    finalizeMirrorSessionRef.current = flushPendingBake;
  }, [flushPendingBake]);

  React.useEffect(() => {
    const wasActive = mirrorPrevToolActiveRef.current;
    mirrorPrevToolActiveRef.current = mirrorToolActive;
    if (wasActive && !mirrorToolActive) {
      flushPendingBake();
    }
  }, [mirrorToolActive, flushPendingBake]);

  const handleMirror = React.useCallback((axis: MirrorAxis) => {
    const modelId = scene.activeModelId;
    if (!modelId) return;
    const model = scene.models.find((m) => m.id === modelId);
    if (!model) return;

    if (!mirrorSessionRef.current || mirrorSessionRef.current.modelId !== modelId) {
      // Finalize any prior session that was for a different model first.
      if (mirrorSessionRef.current) flushPendingBake();
      mirrorSessionRef.current = {
        modelId,
        flips: { x: false, y: false, z: false },
        initialTransform: {
          position: model.transform.position.clone(),
          rotation: model.transform.rotation.clone(),
          scale: model.transform.scale.clone(),
        },
        previewTransform: {
          position: model.transform.position.clone(),
          rotation: model.transform.rotation.clone(),
          scale: model.transform.scale.clone(),
        },
        initialGeometry: model.geometry,
      };
    }

    const session = mirrorSessionRef.current;
    if (!session) return;

    const performMirror = () => {
      session.flips[axis] = !session.flips[axis];

      // Reflect the model's transform across the world-space axis through the
      // model's world bbox center. This produces a true world-space mirror
      // regardless of the model's existing rotation.
      const nextTransform = reflectTransformAcrossWorldAxis(
        model.transform,
        mirrorLocalOriginRef.current,
        axis,
      );
      session.previewTransform = {
        position: nextTransform.position.clone(),
        rotation: nextTransform.rotation.clone(),
        scale: nextTransform.scale.clone(),
      };

      // For X/Y also push supports through the same reflection. Z deletes
      // supports up-front via the destructive modal.
      if (axis !== 'z') {
        const supportTransforms = buildMirrorSupportTransforms({
          current: model.transform,
          modelLocalBboxCenter: mirrorLocalOriginRef.current.clone(),
          axis,
        });
        if (supportTransforms) {
          transformSupportsForModel(modelId, supportTransforms.before, supportTransforms.after);
        }
      }

      scene.setModelTransformRaw(modelId, nextTransform);
      syncTransformManagerToTransform(nextTransform);

      // Schedule baking in the next task so the visual mirror renders
      // immediately. The session stays alive until the bake completes.
      // On mode switch, flushPendingBake() will cancel and run synchronously.
      scheduleBake();
    };

    if (axis === 'z') {
      const proceedNow = requestDestructiveTransformSupportDeletionWithContinuation('Mirror Z', performMirror);
      if (proceedNow) performMirror();
    } else {
      performMirror();
    }
  }, [scene, transformMgr, requestDestructiveTransformSupportDeletionWithContinuation, flushPendingBake, scheduleBake, syncTransformManagerToTransform]);

  return (
    <div className="ui-shell relative h-screen w-screen overflow-hidden" data-no-window-drag="true">
      <TopBar
        meshColor={scene.meshColor}
        onMeshColorChange={scene.setMeshColor}
        selectionColor={scene.selectionColor}
        onSelectionColorChange={scene.setSelectionColor}
        hoverColor={scene.hoverColor}
        onHoverColorChange={scene.setHoverColor}
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
        heatmapBlend={scene.heatmapBlend}
        onHeatmapBlendChange={scene.setHeatmapBlend}
        heatmapContrast={scene.heatmapContrast}
        onHeatmapContrastChange={scene.setHeatmapContrast}
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
        slicingThumbnailRenderSettings={exportThumbnailRenderOptions}
        onSlicingThumbnailRenderSettingsChange={(next) => {
          setExportThumbnailRenderOptions((previous) => ({
            ...previous,
            ...next,
          }));
        }}
        mode={scene.mode}
        onModeChange={handleModeChange}
        hasModels={scene.models.length > 0}
        hasPrintingData={hasPrintingWorkspaceData}
        viewTypeOverride={sessionShaderOverride}
        onViewTypeOverrideChange={setSessionShaderOverride}
        interiorView={interiorView}
        onInteriorViewChange={setInteriorView}
        interiorViewAvailable={hasCavityGeometry}
        heatmapColors={scene.heatmapColors}
        onHeatmapColorChange={scene.onHeatmapColorChange}
        isSlicingBusy={isSlicingBusy}
        onLoadMeshChange={handleLoadMeshChangeWithZip}
        onImportSceneChange={handleImportSceneChangeWithZip}
        onSaveScene={() => { void handleTopBarSaveScene(); }}
        onSaveSceneAs={() => { handleTopBarSaveSceneAs(); }}
        onOpenScene={handleTopBarOpenScene}
        onCloseProgram={handleRequestProgramClose}
        showMonitorButton={showTopbarMonitorButton}
        monitorButtonActive={selectedPrinterHasActivePrint}
        monitorButtonPaused={selectedPrinterHasPausedAlert}
        monitorButtonOffline={isTopbarSelectedPrinterOffline}
        printerReachabilityByDeviceId={printerReachabilityByDeviceId}
        warnBeforeProfileSettingsOpen={Boolean(printingArtifact && !printingArtifactIsInvalid)}
        onOpenMonitor={() => setPrintingMonitorModalOpen(true)}
      />

      <GlobalUpdateIndicator />

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
                onPositionChange={transformMgr.transformHook.setPosition}
                onCenter={transformMgr.transformHook.centerXY}
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
                modelBBox={scene.geom.bbox}
                autoLift={transformMgr.autoLift}
                onAutoLiftChange={handleAutoLiftChange}
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
        ) : scene.mode === 'analysis' ? (
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
        ) : scene.mode === 'export' ? (
          <>
            <ExportPanel
              key="export-main"
              models={scene.models}
              activeModel={scene.activeModel}
              activeModelId={scene.activeModelId}
              selectedModelIds={scene.selectedModelIds}
              onActiveModelChange={scene.setActiveModelId}
              supportsRef={supportsRef}
              captureSceneThumbnailPng={captureExportThumbnailPng}
              onExportSuccess={handleExportSuccess}
              onExportError={showOperationError}
              onExportProgress={setIsExporting}
            />

            <SlicingPanel
              key="export-slicing"
              models={scene.models}
              activeModel={scene.activeModel}
              estimatedLayerCountOverride={estimatedSlicerLayerCount}
              estimatedLayerHeightMmOverride={crossSectionLayerHeightMm}
              estimatedVolumeLabelOverride={estimatedVolumeMlLabel}
              captureSceneThumbnailPng={captureExportThumbnailPng}
              onSliceRunStarted={handleSliceRunStartedForPrinting}
              onLayerPreviewGenerated={handlePrintingLayerPreviewGenerated}
              onSlicingFinished={handleSlicingFinishedForPrinting}
              onSliceArtifactReady={handleSliceArtifactReady}
              onBenchmarkComplete={handleSlicingBenchmarkComplete}
              onSliceTriggerRef={triggerSliceExportRef}
              shouldAutoSlice={shouldAutoSliceOnExportEntry}
              skipThumbnailCapture={shouldReturnToPrintingAfterSliceRef.current}
              onSlicingBusyChange={setIsSlicingBusy}
              canUpload={canSliceAndUpload}
              canPrint={canSliceAndPrint}
              onSliceIntentChanged={(intent) => { sliceIntentRef.current = intent; }}
              onBeforeSliceStart={handleBeforeSliceStart}
              onBeforeSlicingRun={handlePreSliceSceneSave}
              resolveOutputPathForIntent={(intent) => (
                intent === 'file' || intent === 'uvtools'
                  ? (preSliceFileDestinationPathRef.current?.trim() || null)
                  : null
              )}
            />
          </>

        ) : scene.mode === 'support' ? (
          <>
            <SupportSidebar key="support-settings" />
            <IslandsPanel
              key="support-islands"
              islands={islandsPoc}
              hasGeometry={!!scene.geom}
              bottomClearancePx={modelStatsBottomClearancePx}
            />
          </>
        ) : scene.mode === 'printing' ? (
          <>
            <PrintingPanel
              outputName={printingArtifact?.outputName ?? null}
              outputFormat={printingArtifact?.outputName?.split('.').pop() ? `.${printingArtifact.outputName.split('.').pop()}` : null}
              outputSizeLabel={printingOutputSizeLabel}
              printerName={activePrinterProfile?.name ?? 'No printer selected'}
              resinName={printingResinName}
              estimatedPrintTimeLabel={estimatedPrintTimeLabel}
              estimatedVolumeLabel={estimatedVolumeMlLabel}
              canDownload={canDownloadPrintArtifact}
              canSendToPrinter={canSendToPrinter}
              sendBusy={printingSendBusy}
              sendStatusText={printingSendStatusText}
              sendButtonLabel={sendToPrinterButtonLabel}
              showSendTargetPicker={printableConnectedPrinterFleet.length > 1}
              onOpenSendTargetPicker={() => {
                setPrintingTargetPickerMode('post-slice');
                setPrintingTargetPickerOpen(true);
              }}
              onDownload={handleDownloadPrintArtifact}
              onSendToPrinter={handleSendToPrinter}
              onCancelSendToPrinter={handleCancelSendToPrinter}
              canSendToUvTools={getSavedUvToolsSettings().enabled}
              onSendToUvTools={() => {
                const fp = completedSaveDestinationPath;
                if (!fp) return;
                const s = getSavedUvToolsSettings();
                launchExternalProcess(resolveUvToolsExecutablePath(s), fp).catch((err) =>
                  console.warn('[UVTools] Failed to launch from printing panel:', err),
                );
              }}
              sliceIntent={completedSliceIntent}
              savedFilePath={completedSaveDestinationPath}
            />
          </>
        ) : (
          <>
          </>
        )}

        {scene.models.length > 0 && scene.mode !== 'printing' && (
          <VisualSettingsPanel
            key="visual-settings"
            layerIndex={slicing.layerIndex}
            maxLayers={slicing.numLayers}
            onLayerIndexChange={slicing.setLayerIndex}
            onScrubStart={handleSceneLayerScrubStart}
            onScrubEnd={handleSceneLayerScrubEnd}
            onCrossSectionModeChange={slicing.setCrossSectionMode}
            currentHeightMm={slicing.currentHeightMm}
            maxHeightMm={slicing.heightMm}
            crossSectionMode={slicing.crossSectionMode}
            lowerLayerIndex={slicing.lowerLayerIndex}
            onLowerLayerIndexChange={slicing.setLowerLayerIndex}
            lowerCurrentHeightMm={slicing.lowerCurrentHeightMm}
            crossSectionEnabled={isCrossSectionEnabled}
            onToggleCrossSection={handleToggleCrossSection}
            layerHeightMm={slicing.layerHeightMm}
          />
        )}

        {isTransformDebugOverlayOpen && (
          <div
            key="transform-debug-overlay"
            className="rounded-lg border p-2.5 font-mono text-[10px] leading-tight shadow-xl"
            style={{
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-strong)',
              background: 'color-mix(in srgb, var(--surface-0), black 14%)',
              fontSize: '10px',
            }}
          >
            <div className="mb-2 flex items-center justify-between">
              <div className="text-xs font-semibold" style={{ fontFamily: 'var(--font-geist-mono)' }}>
                {scene.mode === 'printing' ? 'Printing Debug Overlay' : scene.mode === 'support' ? 'Support Debug Overlay' : 'Transform Debug Overlay'}
              </div>
              <button
                type="button"
                className="rounded border px-2 py-0.5 text-[10px]"
                style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                onClick={() => setIsTransformDebugOverlayOpen(false)}
              >
                Close
              </button>
            </div>

            {scene.mode === 'printing' ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <div style={{ color: 'var(--text-muted)' }}>Mode</div><div>{scene.mode}</div>
                <div style={{ color: 'var(--text-muted)' }}>Total layers</div><div>{printingPreviewTotalLayers}</div>
                <div style={{ color: 'var(--text-muted)' }}>Selected layer</div><div>{printingSelectedLayer}</div>
                <div style={{ color: 'var(--text-muted)' }}>Displayed layer</div><div>{printingDisplayedLayer}</div>
                <div style={{ color: 'var(--text-muted)' }}>Is scrubbing</div><div>{isPrintingLayerScrubbing ? 'true' : 'false'}</div>
                <div style={{ color: 'var(--text-muted)' }}>Show scrub preview</div><div>{shouldShowScrubPreview ? 'true' : 'false'}</div>
                <div style={{ color: 'var(--text-muted)' }}>Send progress</div><div>{(printingSendProgress * 100).toFixed(1)}%</div>
                <div style={{ color: 'var(--text-muted)' }}>Send busy</div><div>{printingSendBusy ? 'true' : 'false'}</div>
                <div style={{ color: 'var(--text-muted)' }}>Stage text</div><div className="truncate" title={printingSendStageText ?? 'none'}>{printingSendStageText ?? 'none'}</div>
              </div>
            ) : scene.mode === 'support' ? (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <div style={{ color: 'var(--text-muted)' }}>Mode</div><div>{scene.mode}</div>
                <div style={{ color: 'var(--text-muted)' }}>Active model</div><div>{scene.activeModelId ?? 'none'}</div>
                <div style={{ color: 'var(--text-muted)' }}>Hovered category</div><div>{supportDebugStats.hoveredCategory}</div>
                <div style={{ color: 'var(--text-muted)' }}>Hovered id</div><div>{supportDebugStats.hoveredId ?? 'none'}</div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <div style={{ color: 'var(--text-muted)' }}>Mode</div><div>{scene.mode}</div>
                <div style={{ color: 'var(--text-muted)' }}>Transform mode</div><div>{transformMgr.transformMode}</div>
                <div style={{ color: 'var(--text-muted)' }}>Active model</div><div>{scene.activeModelId ?? 'none'}</div>
                <div style={{ color: 'var(--text-muted)' }}>Display model</div><div>{displayActiveModelId ?? 'none'}</div>
                <div style={{ color: 'var(--text-muted)' }}>isTransforming</div><div>{transformMgr.isTransforming ? 'true' : 'false'}</div>
                <div style={{ color: 'var(--text-muted)' }}>Drag group auto</div><div>{String(transformDebugStats.dragGroupAutoUpdate)}</div>
              </div>
            )}

            {scene.mode === 'printing' && (
              <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Preview State
                </div>
                <div>Preview URLs loaded: {printingLayerPreviewUrls.filter(u => u !== null).length} / {printingPreviewTotalLayers}</div>
                <div>Selected URL exists: {(printingLayerPreviewUrls[printingSelectedLayer - 1] ?? null) ? 'true' : 'false'}</div>
                <div>Displayed URL exists: {(printingLayerPreviewUrls[printingDisplayedLayer - 1] ?? null) ? 'true' : 'false'}</div>
                <div>Artifact ready: {printingArtifact ? 'true' : 'false'}</div>
                <div>Artifact name: {printingArtifact?.outputName ?? 'none'}</div>
                <div>Upload dialog open: {printingUploadDialogOpen ? 'true' : 'false'}</div>
                <div>Upload stage: {printingUploadDialogStage}</div>
                <div>Display progress: {(printingUploadDisplayProgress * 100).toFixed(1)}%</div>
                <div>Ready plate ID: {printingReadyPlateId ?? 'none'}</div>
                <div>Print now busy: {printingPrintNowBusy ? 'true' : 'false'}</div>
                <div>Status text: {printingSendStatusText ?? 'none'}</div>

                {printingSlicingBenchmark && (
                  <>
                    <div className="mt-2 mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Slicing Metrics
                    </div>
                    <div>Total time: {printingSlicingBenchmark.totalElapsedMs.toFixed(0)} ms</div>
                    {printingSlicingBenchmark.meshPrepMs !== null && (
                      <div>Mesh prep: {printingSlicingBenchmark.meshPrepMs.toFixed(0)} ms</div>
                    )}
                    {printingSlicingBenchmark.coreSlicingMs !== null && (
                      <div>Core slicing: {printingSlicingBenchmark.coreSlicingMs.toFixed(0)} ms</div>
                    )}
                    {printingSlicingBenchmark.totalLayers !== null && (
                      <div>Total layers: {printingSlicingBenchmark.totalLayers}</div>
                    )}
                    {printingSlicingBenchmark.layersPerSecond !== null && (
                      <div>Layers/sec: {printingSlicingBenchmark.layersPerSecond.toFixed(1)}</div>
                    )}
                  </>
                )}
              </div>
            )}

            {scene.mode === 'support' && (
              <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Placement Lock Debug
                </div>
                <div>Hovered category/id: {supportDebugStats.hoveredCategory} / {supportDebugStats.hoveredId ?? 'none'}</div>
                <div>Shaft hovered segment: {supportDebugStats.shaftHoveredSegmentId ?? 'none'}</div>
                <div>Shaft hover point: {formatDebugVec3Like(supportDebugStats.shaftHoverPoint)}</div>
                <div>Brace Alt active: {supportDebugStats.braceAltActive ? 'true' : 'false'}</div>
                <div>Brace stage: {supportDebugStats.braceStage}</div>
                <div>Brace start: {supportDebugStats.braceStartKind ?? 'none'} / {supportDebugStats.braceStartSegmentId ?? 'n/a'}</div>
                <div>Brace snap: {supportDebugStats.braceSnapKind ?? 'none'} / {supportDebugStats.braceSnapSegmentId ?? supportDebugStats.braceSnapLeafId ?? 'n/a'}</div>
                <div>Preview start: {formatDebugVec3Like(supportDebugStats.previewStart)}</div>
                <div>Preview end: {formatDebugVec3Like(supportDebugStats.previewEnd)}</div>
                <div>Suppressed: {supportDebugStats.supportInteractionSuppressed ? 'true' : 'false'}</div>
                <div>disableSelectionAndHover: {supportDebugStats.disableSelectionAndHover ? 'true' : 'false'}</div>
                <div>Gizmo lock active: {supportDebugStats.gizmoInteractionLockActive ? 'true' : 'false'}</div>
                <div>Knot dragging: {supportDebugStats.knotGizmoDragging ? 'true' : 'false'}</div>
                <div>Joint dragging: {supportDebugStats.jointGizmoDragging ? 'true' : 'false'}</div>
                <div>Knot guard remaining: {supportDebugStats.knotGuardRemainingMs} ms</div>
                <div>Knot-only guard: {supportDebugStats.knotOnlyGuardRemainingMs} ms</div>
                <div>Joint-only guard: {supportDebugStats.jointOnlyGuardRemainingMs} ms</div>
                <div>Immediate hover model: {supportDebugStats.immediateModelHoverId ?? 'none'}</div>
                <div>External hover model: {supportDebugStats.externalHoverModelId ?? 'none'}</div>
                <div>Effective hover model: {supportDebugStats.effectiveHoverModelId ?? 'none'}</div>
                <div>Scene hovered support: {supportDebugStats.sceneHoveredSupportId ?? 'none'}</div>
                <div>Marquee hovered support: {supportDebugStats.marqueeHoveredSupportId ?? 'none'}</div>
                <div>Raw hovered category/id: {supportDebugStats.rawHoveredCategory ?? 'none'} / {supportDebugStats.rawHoveredId ?? 'none'}</div>
                <div>Visual hovered category/id: {supportDebugStats.hoveredCategoryForVisual ?? 'none'} / {supportDebugStats.hoveredIdForVisual ?? 'none'}</div>
                <div>
                  Hover vs snap segment mismatch:{' '}
                  <span style={{ color: supportDebugStats.hoveredVsSnapMismatch ? '#ff8a8a' : 'var(--text-strong)' }}>
                    {supportDebugStats.hoveredVsSnapMismatch ? 'YES' : 'no'}
                  </span>
                </div>
              </div>
            )}

            {scene.mode !== 'support' && scene.mode !== 'printing' && (
              <>
                <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Transform Delta (live vs store)
                  </div>
                  <div>Δpos: {formatDebugNumber(transformDebugStats.posDelta)} mm</div>
                  <div>Δrot max: {formatDebugNumber(transformDebugStats.rotDelta)} rad</div>
                  <div>Δscale: {formatDebugNumber(transformDebugStats.scaleDelta)}</div>
                </div>

                <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Active Model Transform
                  </div>
                  <div>Store pos: {formatDebugVec3(transformDebugStats.storeTransform?.position)}</div>
                  <div>Live pos: {formatDebugVec3(transformDebugStats.liveTransform.position)}</div>
                  <div>Drag Δ pos: {formatDebugVec3(transformDebugStats.dragGroupPos)}</div>
                  <div>Drag Δ scale: {formatDebugVec3(transformDebugStats.dragGroupScale)}</div>
                </div>
              </>
            )}

            <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Support Counts (all / active model)
              </div>
              <div>Trunks: {transformDebugStats.supportCounts.trunks} / {activeSupportEntityCounts.trunks}</div>
              <div>Branches: {transformDebugStats.supportCounts.branches} / {activeSupportEntityCounts.branches}</div>
              <div>Leaves: {transformDebugStats.supportCounts.leaves} / {activeSupportEntityCounts.leaves}</div>
              <div>Twigs: {transformDebugStats.supportCounts.twigs} / {activeSupportEntityCounts.twigs}</div>
              <div>Sticks: {transformDebugStats.supportCounts.sticks} / {activeSupportEntityCounts.sticks}</div>
              <div>Braces: {transformDebugStats.supportCounts.braces} / {activeSupportEntityCounts.braces}</div>
              <div>Roots: {transformDebugStats.supportCounts.roots} / {activeSupportEntityCounts.roots}</div>
              <div>Knots: {transformDebugStats.supportCounts.knots} / {activeSupportEntityCounts.knots}</div>
              <div>Kickstands: {transformDebugStats.supportCounts.kickstands} / {activeSupportEntityCounts.kickstands}</div>
            </div>

            {scene.mode !== 'support' && scene.mode !== 'printing' && (
              <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Transform Timeline
                </div>
                <div>Last op: {transformDebugStats.timeline.lastOperation ?? 'n/a'}</div>
                <div>Drag released: {formatDebugTime(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Live calculated: {formatDebugTime(transformDebugStats.timeline.liveCalculatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Store update start: {formatDebugTime(transformDebugStats.timeline.storeUpdateStartedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Store updated: {formatDebugTime(transformDebugStats.timeline.storeUpdatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Support store updated: {formatDebugTime(transformDebugStats.timeline.supportStoreUpdatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Kickstand store updated: {formatDebugTime(transformDebugStats.timeline.kickstandStoreUpdatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Active model store observed: {formatDebugTime(transformDebugStats.timeline.activeModelStoreObservedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Release → Live: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.liveCalculatedAt)}</div>
                <div>Live → Store start: {formatDebugLatencyMs(transformDebugStats.timeline.liveCalculatedAt, transformDebugStats.timeline.storeUpdateStartedAt)}</div>
                <div>Store start → Store updated: {formatDebugLatencyMs(transformDebugStats.timeline.storeUpdateStartedAt, transformDebugStats.timeline.storeUpdatedAt)}</div>
                <div>Release → Store updated: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.storeUpdatedAt)}</div>
                <div>Release → Support store: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.supportStoreUpdatedAt)}</div>
                <div>Release → Kickstand store: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.kickstandStoreUpdatedAt)}</div>
                <div>Release → Active model observed: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.activeModelStoreObservedAt)}</div>
              </div>
            )}

            {scene.mode !== 'support' && scene.mode !== 'printing' && (
              <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Transform History Commit
                </div>
                <div>Pending model: {transformDebugStats.historyCommit.pendingModelId ?? 'none'}</div>
                <div>Pending description: {transformDebugStats.historyCommit.pendingDescription ?? 'none'}</div>
                <div>Pending has after: {transformDebugStats.historyCommit.pendingHasAfter ? 'true' : 'false'}</div>
                <div>Pending before rot: {formatDebugVec3Like(transformDebugStats.historyCommit.pendingBeforeRotation)}</div>
                <div>Pending after rot: {formatDebugVec3Like(transformDebugStats.historyCommit.pendingAfterRotation)}</div>
                <div>Commit requested: {transformDebugStats.historyCommit.commitRequested ? 'true' : 'false'}</div>
                <div>Commit nonce: {transformDebugStats.historyCommit.commitNonce}</div>
                <div>Pending resync: {transformDebugStats.historyCommit.pendingResync ? 'true' : 'false'}</div>
                <div>Suppress next persistence: {transformDebugStats.historyCommit.suppressNextPersistence ? 'true' : 'false'}</div>
                <div>
                  Skip token: {transformDebugStats.historyCommit.skipToken
                    ? `${transformDebugStats.historyCommit.skipToken.operation}:${transformDebugStats.historyCommit.skipToken.modelId}`
                    : 'none'}
                </div>
                <div>Pending rotate-gizmo model: {transformDebugStats.historyCommit.pendingRotateGizmoModelId ?? 'none'}</div>
                <div>Last result: {transformDebugStats.historyCommit.lastResult}</div>
                <div>Last reason: {transformDebugStats.historyCommit.lastReason}</div>
                <div>Last model: {transformDebugStats.historyCommit.lastModelId ?? 'none'}</div>
                <div>Last description: {transformDebugStats.historyCommit.lastDescription ?? 'none'}</div>
                <div>Last expected nonce: {transformDebugStats.historyCommit.lastExpectedNonce ?? 'n/a'}</div>
                <div>Last scheduled nonce: {transformDebugStats.historyCommit.lastScheduledNonce ?? 'n/a'}</div>
                <div>Last push applied: {transformDebugStats.historyCommit.lastPushApplied === null ? 'n/a' : (transformDebugStats.historyCommit.lastPushApplied ? 'true' : 'false')}</div>
                <div>Undo before → after: {transformDebugStats.historyCommit.lastUndoCountBefore ?? 'n/a'} → {transformDebugStats.historyCommit.lastUndoCountAfter ?? 'n/a'}</div>
                <div>Last attempt: {formatDebugTime(transformDebugStats.historyCommit.lastAt, transformDebugStats.timeline.nowPerfMs)}</div>
              </div>
            )}

            <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Toggle: Ctrl+Shift+X
            </div>
          </div>
        )}
      </FloatingPanelStack>

      <div className="absolute inset-0 top-14 z-0 flex">
        <div
          id="scene-root"
          className={`relative h-full ${scene.mode === 'printing' ? 'w-1/2 border-r' : 'w-full'}`}
          style={scene.mode === 'printing' ? { borderColor: 'var(--border-subtle)' } : undefined}
          onPointerDownCapture={handleEditorPointerDownCapture}
          onPointerMoveCapture={handleEditorPointerMoveCapture}
          onPointerUpCapture={handleEditorPointerUpCapture}
          onContextMenuCapture={handleEditorContextMenu}
          onDragEnter={handlePrepareDragEnter}
          onDragOver={handlePrepareDragOver}
          onDragLeave={handlePrepareDragLeave}
          onDrop={handlePrepareDrop}
        >
          {showEmptyStatePanel && (
            <EmptySceneState
              onLoadMeshClick={() => { void handleOpenMeshDialog(); }}
              onFileChange={handleLoadMeshChangeWithZip}
              onImportSceneClick={() => { void handleOpenSceneDialog(); }}
              onImportSceneChange={handleImportSceneChangeWithZip}
              onDropMeshFiles={handleDroppedPrepareFiles}
              recentOpenedFiles={scene.recentOpenedFiles}
              onReopenRecentFile={handleReopenRecentFile}
              isLoading={showEmptyStateLoading}
              loadingLabel={emptyStateLoadingLabel}
              loadingDetail={emptyStateLoadingDetail}
              showFirstTimeOnboarding={!hasActivePrinterProfile && !allowPrepareWithoutPrinter}
              onAddPrinter={handleAddPrinterFromOnboarding}
              onUseWithoutPrinter={handleUseWithoutPrinter}
            />
          )}

          {scene.mode === 'prepare' && isPrepareDragActive && (
            <div className="absolute inset-0 z-40 pointer-events-none flex items-center justify-center">
              <div
                className="absolute inset-0"
                style={{
                  background: isPrepareDragUnsupported
                    ? 'color-mix(in srgb, var(--danger), transparent 90%)'
                    : 'color-mix(in srgb, black, transparent 86%)',
                  backdropFilter: 'blur(1px)',
                }}
              />
              <div
                className="relative min-w-[380px] max-w-[min(92vw,640px)] rounded-xl border border-dashed px-8 py-6 text-center"
                style={{
                  borderColor: isPrepareDragUnsupported ? 'var(--danger)' : 'var(--accent)',
                  background: isPrepareDragUnsupported
                    ? 'color-mix(in srgb, var(--danger), var(--surface-0) 88%)'
                    : 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
                }}
              >
                <div className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {isPrepareDragUnsupported ? 'Unsupported file format' : 'Drop supported files to import'}
                </div>
                <div className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
                  {isPrepareDragUnsupported
                    ? 'Please use: STL, OBJ, 3MF, LYS, VOXL'
                    : 'Supported: STL, OBJ, 3MF, LYS, VOXL'}
                </div>
              </div>
            </div>
          )}

          <SceneCanvas
            models={scene.models}
            activeModelId={sceneCanvasActiveModelId}
            visualActiveModelId={sceneCanvasVisualActiveModelId}
            selectedModelIds={sceneCanvasSelectedModelIds}
            clipLower={sceneClipLower}
            clipUpper={sceneClipUpper}
            meshColor={scene.meshColor}
            meshVisible={scene.meshVisible}
            shaderType={effectiveShaderType}
            matcapVariant={scene.matcapVariant}
            flatUseVertexColors={scene.flatUseVertexColors}
            toonSteps={scene.toonSteps}
            xrayOpacity={scene.xrayOpacity}
            heatmapContrast={scene.heatmapContrast}
            heatmapColors={scene.heatmapColors}
            interiorView={interiorView}
            cavityGeometryByModelId={new Map(Array.from(cavityGeometryByModelIdRef.current.entries()).map(([id, entry]) => [id, entry.geometry]))}
            disableRaycast={transformMgr.isTransforming}
            hideCrossSectionCap={false}
            onCameraChange={handleCameraChange}
            onCameraEnd={handleCameraEnd}
            islandMarkers={
              scene.mode === 'support'
                ? islandsPoc.islandMarkers
                : (islands.overlayEnabled ? islands.islandMarkers : [])
            }
            overlayBrushRadius={islands.overlayBrushRadius}
            overlayColor={islands.overlayColor}
            overlayOpacity={islands.overlayOpacity}
            overlaySelectedIslandId={
              scene.mode === 'support' ? islandsPoc.selectedMarkerId : islands.selectedIslandId
            }
            enableVolumeGlow={islandsPoc.enableVolumeGlow}
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
            uniformScaling={uniformScaling}
            autoLift={transformMgr.autoLift}
            liftDistance={transformMgr.liftDistance}
            autoSnapEnabled={transformMgr.autoSnapEnabled}
            onTransformStart={handleTransformStart}
            onGizmoTransformCommit={handleGizmoTransformCommit}
            onGizmoTransformGroupCommit={handleGizmoTransformGroupCommit}
            onTransformChange={handleTransformChange}
            onTransformEnd={handleTransformEnd}
            mode={scene.mode}
            onSupportClick={supports.onModelClick}
            onHolePunchClick={scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing' && !hollowingEditMode ? handleHolePunchClick : undefined}
            onHolePunchHover={scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing' && !hollowingEditMode ? handleHolePunchHover : undefined}
            onSupportHover={supports.onModelHover}
            onActiveModelChange={handleSceneModelSelection}
            onMarqueeSelectionChange={handleSceneMarqueeSelection}
            trunkPlacementPreview={supports.trunkPlacementV2.previewData}
            branchPlacementPreview={supports.branchPlacement.previewData}
            leafPlacementPreview={supports.leafPlacement.previewData}
            bracePlacementPreview={supports.bracePreview}
            kickstandPlacementPreview={supports.kickstandPreview}
            blockSupportPlacement={supports.isPlacementHardDisabled}
            isBranchPlacementActive={supports.branchPlacement.isActive}
            isLeafPlacementActive={supports.leafPlacement.isActive}
            isBracePlacementActive={supports.bracePlacement.isActive}
            isKickstandPlacementActive={supports.kickstandPlacement.isActive}
            branchTipPosition={supports.branchPlacement.tipPosition}
            branchHoverPosition={supports.branchPlacement.hoverPosition}
            leafTipPosition={supports.leafPlacement.tipPosition}
            leafHoverPosition={supports.leafPlacement.hoverPosition}
            gpuPickingTest={false}
            selectionHighlightMode={effectiveSelectionHighlightMode}
            higherContrastModelEdges={workspaceCameraSettings.higherContrastModelEdges}
            blockerEditMode={hollowingEditMode}
            selectionColor={scene.selectionColor}
            hoverColor={scene.hoverColor}
            hoverTintStrength={effectiveHoverTintStrengthForScene}
            selectedTintStrength={effectiveSelectedTintStrengthForScene}
            crossSectionMode={slicing.crossSectionMode}
            pxMm={islands.pxMm}
            supportsRef={supportsRef}
            supportDragGroupRef={supportDragGroupRef}
            holdSupportDragDelta={holdSupportDragDeltaUntilSupportSync}
            supportDragTransactionId={supportDragTransactionId}
            customPrepareLassoSelection={{
              enabled: Boolean(
                scene.mode === 'prepare'
                && transformMgr.transformMode === 'hollowing'
                && hollowingEditMode
                && hollowPreview
                && hollowPreview.removedVoxelIndices.length > 0,
              ),
              resolveSelection: resolveBlockedHollowVoxelMarqueeSelection,
              onSelectionChange: handleBlockedHollowVoxelMarqueeSelection,
            }}
            renderSceneOverlays={({ raycastActiveModelFromRay }) => {
              // Update raycast ref for island co-visibility checks
              modelRaycastRef.current = (start, end) => {
                const dir = new THREE.Vector3().subVectors(end, start).normalize();
                const ray = new THREE.Ray(start, dir);
                const hit = raycastActiveModelFromRay(ray);
                if (hit && hit.distance < start.distanceTo(end) - 0.5) {
                  return false; // occluded
                }
                return true; // clear
              };

              const previewModel = hollowPreview
                ? scene.models.find((model) => model.id === hollowPreview.modelId) ?? null
                : null;
              const activeModelId = scene.activeModel?.id ?? null;
              const isInHollowingTool = scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing';
              const showDraftHolePunchMarkers = (
                interiorView
                || (
                  isInHollowingTool
                  && !isShellFaceSelectionPending
                  && !hollowingEditMode
                )
              );
              const holePunchCavityBoundaryDepthMm = (hollowingDraftEnabled || isHollowingApplied)
                ? Math.max(0, hollowingState.shellThicknessMm)
                : null;
              const placedPunches = activeModelId
                ? holePunchPlacements.filter((placement) => placement.modelId === activeModelId)
                : [];
              const hoverPunchPreview = (
                !hoveredHolePunchPlacementId
                && holePunchHoverPlacement
                && holePunchHoverPlacement.modelId === activeModelId
              )
                ? holePunchHoverPlacement
                : null;

              return (
                <>
                  {ghostData && LysGhostOverlay ? <LysGhostOverlay data={ghostData} visible /> : null}

                  {placedPunches.map((placement) => {
                    const isApplied = appliedHolePunchPlacementIds.has(placement.id);
                    // Draft markers (blue, unapplied) always show so the user
                    // can see what needs applying. Applied markers (orange/grey)
                    // only show in prepare/hollowing mode.
                    if (isApplied && !showDraftHolePunchMarkers) return null;
                    return (
                      <HolePunchPreviewCylinder
                        key={`hole-punch-placement-${placement.id}`}
                        position={placement.worldPoint}
                        normal={placement.worldNormal}
                        frame={placement.worldFrame}
                        radiusMm={placement.radiusMm}
                        radiusYMm={placement.radiusYMm}
                        lengthMm={placement.depthMm}
                        cavityBoundaryDepthMm={holePunchCavityBoundaryDepthMm}
                        applied={isApplied}
                        variant={isInHollowingTool && selectedHolePunchPlacementIdSet.has(placement.id)
                          ? 'selected'
                          : isInHollowingTool && placement.id === hoveredHolePunchPlacementId
                            ? 'hover'
                            : 'placed'}
                        /* Only interactive when inside the hollowing tool */
                        {...(isInHollowingTool ? {
                          onHoverStart: () => {
                            setHoveredHolePunchPlacementId(placement.id);
                            setHolePunchHoverPlacement(null);
                          },
                          onHoverEnd: () => {
                            setHoveredHolePunchPlacementId((previous) => (previous === placement.id ? null : previous));
                          },
                          onPointerDown: (event: any) => handleHolePunchPlacementDragStart(placement.id, event),
                          onPointerMove: (event: any) => handleHolePunchPlacementDragMove(
                            placement.id,
                            event,
                            raycastActiveModelFromRay,
                          ),
                          onPointerUp: (event: any) => handleHolePunchPlacementDragEnd(placement.id, event),
                          onPointerCancel: (event: any) => handleHolePunchPlacementDragEnd(placement.id, event),
                          onClick: () => {},
                        } : {})}
                      />
                    );
                  })}

                  {showDraftHolePunchMarkers && hoverPunchPreview && (
                    <HolePunchPreviewCylinder
                      key="hole-punch-hover-preview"
                      position={hoverPunchPreview.worldPoint}
                      normal={hoverPunchPreview.worldNormal}
                      radiusMm={holePunchState.radiusMm}
                      radiusYMm={holePunchState.radiusYMm}
                      lengthMm={holePunchState.depthMm}
                      cavityBoundaryDepthMm={holePunchCavityBoundaryDepthMm}
                      variant="hover"
                    />
                  )}

                  {isInHollowingTool && selectedHolePunchPlacementIds.length === 1 && (() => {
                    const selectedPlacement = placedPunches.find(
                      (p) => selectedHolePunchPlacementIdSet.has(p.id),
                    );
                    if (!selectedPlacement) return null;
                    return (
                      <HolePunchGizmo
                        key={`hole-punch-gizmo-${selectedPlacement.id}`}
                        placement={selectedPlacement}
                        onMoveStart={() => handleHolePunchGizmoMoveStart(selectedPlacement.id)}
                        onMove={(delta) => handleHolePunchGizmoMove(selectedPlacement.id, delta)}
                        onMoveEnd={() => handleHolePunchGizmoMoveEnd(selectedPlacement.id)}
                        onRotateStart={() => handleHolePunchGizmoRotateStart(selectedPlacement.id)}
                        onRotate={(newNormal, worldFrame) => handleHolePunchGizmoRotate(
                          selectedPlacement.id,
                          newNormal,
                          worldFrame,
                        )}
                        onRotateEnd={() => handleHolePunchGizmoRotateEnd(selectedPlacement.id)}
                      />
                    );
                  })()}

                  {hollowPreview && previewModel && hollowingEditMode && !(isHollowingApplied && !isHollowingDirty) && (
                    <WorldSpaceVoxelEditOverlay
                      voxelCenters={hollowPreview.removedVoxelCenters}
                      blockedVoxelCenters={hollowPreview.blockedVoxelCenters}
                      voxelRadiusMm={Math.max(hollowPreview.report.voxelSizeMm, 0.2)}
                      blockedVoxelIndexSet={blockedPreviewVoxelInstanceIdSet}
                      modelTransform={{
                        position: previewModel.transform.position,
                        quaternion: quaternionFromGlobalEuler(previewModel.transform.rotation),
                        scale: previewModel.transform.scale,
                      }}
                      geometryCenter={previewModel.geometry.center}
                      onToggleVoxel={toggleBlockedHollowVoxelIndex}
                    />
                  )}

                  {hollowPreview && previewModel && !hollowingEditMode && !(isHollowingApplied && !isHollowingDirty) && (
                    <>
                      {hollowPreview.previewVoxelSpheres && (
                        <WorldSpaceVoxelPreview
                          voxelCenters={hollowPreview.removedVoxelCenters}
                          voxelSizeMm={hollowPreview.report.voxelSizeMm}
                          modelTransform={{
                            position: previewModel.transform.position,
                            quaternion: quaternionFromGlobalEuler(previewModel.transform.rotation),
                            scale: previewModel.transform.scale,
                          }}
                          geometryCenter={previewModel.geometry.center}
                        />
                      )}
                      <group
                        position={previewModel.transform.position}
                        quaternion={quaternionFromGlobalEuler(previewModel.transform.rotation)}
                        scale={previewModel.transform.scale}
                      >
                        {!hollowPreview.previewVoxelSpheres && (
                          <mesh
                            geometry={hollowPreview.geometry}
                            position={new THREE.Vector3(
                              -previewModel.geometry.center.x,
                              -previewModel.geometry.center.y,
                              -previewModel.geometry.center.z,
                            )}
                            raycast={() => null}
                            renderOrder={6}
                          >
                            <meshStandardMaterial
                              color={'#66ecff'}
                              emissive={'#3be6f2'}
                              emissiveIntensity={0.18}
                              transparent
                              opacity={0.62}
                              depthTest
                              depthWrite={false}
                              side={THREE.DoubleSide}
                              roughness={0.65}
                              metalness={0.0}
                            />
                          </mesh>
                        )}
                        {hollowPreview.infillGeometry && (
                          <mesh
                            geometry={hollowPreview.infillGeometry}
                            position={new THREE.Vector3(
                              -previewModel.geometry.center.x,
                            -previewModel.geometry.center.y,
                            -previewModel.geometry.center.z,
                          )}
                          raycast={() => null}
                          renderOrder={7}
                        >
                          <meshStandardMaterial
                            color={'#43215f'}
                            emissive={'#5a2f82'}
                            emissiveIntensity={0.24}
                            transparent
                            opacity={0.9}
                            depthTest
                            depthWrite={false}
                            side={THREE.DoubleSide}
                            roughness={0.55}
                            metalness={0.0}
                          />
                        </mesh>
                      )}
                    </group>
                  </>
                )}
                </>
              );
            }}
            duplicatePreviewModel={
              isDuplicating
                ? duplicateApplySourceModel
                : (transformMgr.transformMode === 'arrange' ? scene.activeModel : null)
            }
            duplicatePreviewTransforms={duplicatePreviewTransforms}
            duplicateActivePreviewTransform={
              isDuplicating
                ? duplicateApplySourceTransform
                : duplicateSourcePreviewTransform
            }
            supportRenderRefreshNonce={supportRenderRefreshNonce}
            gizmoResetNonce={gizmoResetNonce}
            historyTransformResyncToken={historyTransformResyncTick}
            isLayerScrubbing={scene.mode === 'printing' ? isPrintingLayerScrubbing : isSceneLayerScrubbing}
            arrangeArrayPreviewItems={arrangeArrayPreviewItems}
            hideDuplicateSourceDuringApply={isDuplicating}
            view3dSettings={scene.view3dSettings}
            onRegisterExportThumbnailCapture={handleRegisterExportThumbnailCapture}
            exportThumbnailRenderOptions={exportThumbnailRenderOptions}
            deferCameraIntro={holdEmptyStateSceneImportUi}
            freezeViewportActive={isSlicingBusy && scene.mode === 'export'}
            indicatorPlaneZ={scene.mode === 'printing' ? printingCurrentHeightMm : null}
            indicatorPlaneColor={scene.selectionColor || '#ec2a77'}
            onNewDeviceDetected={handleNewDeviceDetected}
          >
            {scene.mode === 'prepare' && transformMgr.transformMode === 'smoothing' && (
              <MeshSmoothingBrushCursor />
            )}
            {scene.mode === 'prepare' && transformMgr.transformMode === 'placeOnFace' && (
              <PlaceOnFaceTool
                models={scene.models}
                activeModelId={displayActiveModelId}
                activeTransform={transformMgr.transform}
                onAnimationStart={handlePlaceOnFaceAnimationStart}
                onAnimatedTransformChange={handleTransformChange}
                resolveAnimatedTransform={transformMgr.resolveLiveTransform}
                onFaceSelect={handlePlaceOnFace}
                onBeforeFaceApply={handlePlaceOnFaceBeforeApply}
              />
            )}
            {scene.mode === 'prepare' && transformMgr.transformMode === 'mirror' && (
              <MirrorTool
                activeModelId={displayActiveModelId}
                onMirror={handleMirror}
              />
            )}
          </SceneCanvas>

          {/* Transform Toolbar */}
          {scene.models.length > 0 && scene.mode === 'prepare' && (
            <>
              <TransformToolbar
                mode={transformMgr.transformMode}
                onModeChange={setTransformModeWithMirrorFinalize}
                onModeHover={handleTransformToolbarHover}
              />
              <SnapAngleReadout />
              <RotationHintTooltip />
            </>
          )}

          {scene.models.length > 0 && (
            <div
              ref={modelStatsCardContainerRef}
              className="absolute bottom-3 left-3 z-30 pointer-events-auto"
            >
              <ModelStatsCard
                model={scene.models.find((m) => m.id === displayActiveModelId) || null}
                models={scene.models}
                selectedModelIds={scene.selectedModelIds}
                inBoundsModelIds={inBoundsModelIds}
                numLayers={estimatedSlicerLayerCount}
                heightMm={slicing.heightMm}
                estimatedPrintTimeLabelOverride={modelStatsEstimatedPrintTimeLabel}
                estimatedResinLabelOverride={estimatedVolumeMlLabel}
              />
            </div>
          )}

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

        {scene.mode === 'printing' && (
          <div
            className="h-full w-1/2 min-w-0 min-h-0 grid overflow-hidden"
            style={{ gridTemplateColumns: '56px minmax(0, 1fr)', background: 'var(--surface-0)' }}
          >
            <div
              className="relative z-20 h-full overflow-visible border-r px-0 py-1.5"
              style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}
            >
              <LayerSlider
                min={1}
                max={Math.max(1, printingPreviewTotalLayers)}
                step={1}
                value={Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), printingSelectedLayer))}
                onChange={handlePrintingLayerChange}
                onScrubStart={handlePrintingLayerScrubStart}
                onScrubEnd={handlePrintingLayerScrubEnd}
                allowTrackClickJump
                currentHeightMm={printingCurrentHeightMm ?? undefined}
                maxHeightMm={slicing.heightMm}
                showValue={true}
                crossSectionMode={slicing.crossSectionMode}
                showModeIndicator={false}
                compactMinimalRail
                dragBatchMode="raf"
                docked
                embedded
                expandToContainer
                className="mx-auto h-full"
              />
            </div>

            <div className="h-full min-h-0 min-w-0 p-3 flex flex-col gap-2 overflow-hidden">
              <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Layer Preview
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Layer {Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), printingSelectedLayer))}/{Math.max(1, printingPreviewTotalLayers)}
              </div>

              <div
                className="relative flex-1 min-h-0 min-w-0 rounded-lg border p-2 flex items-center justify-center overflow-hidden"
                ref={printingPreviewViewportRef}
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'color-mix(in srgb, var(--surface-1), transparent 6%)',
                  cursor: printingPreviewCursor,
                  touchAction: 'none',
                }}
                onWheel={handlePrintingPreviewWheel}
                onPointerDown={handlePrintingPreviewPointerDown}
                onPointerMove={handlePrintingPreviewPointerMove}
                onPointerUp={handlePrintingPreviewPointerEnd}
                onPointerCancel={handlePrintingPreviewPointerEnd}
              >
                {/* Layered preview: GPU preview (instant) underneath, PNG (higher quality) on top when loaded */}
                {(() => {
                  const aspectW = printingPreviewTargetResolution
                    ? printingPreviewTargetResolution.viewportWidth
                    : activePrinterProfile?.buildVolumeMm?.width ?? 143;
                  const aspectH = printingPreviewTargetResolution
                    ? printingPreviewTargetResolution.viewportHeight
                    : activePrinterProfile?.buildVolumeMm?.depth ?? 89;
                  const aspectRatio = aspectW / aspectH;
                  
                  return (
                    <div
                      className="block rounded relative"
                      style={{ 
                        aspectRatio: aspectRatio.toString(),
                        width: '100%',
                        maxWidth: '100%',
                        maxHeight: '100%',
                        transform: printingPreviewVisualTransform || 'none',
                        transformOrigin: 'center center',
                        willChange: 'transform',
                      }}
                    >
                      {/* Fast scrub preview: keep mounted to avoid first-use GPU warmup hitch. */}
                      {printingPreviewTotalLayers > 0 && (
                        <div
                          className="absolute inset-0 transition-opacity duration-100"
                          style={{
                            opacity: 1,
                            pointerEvents: 'none',
                          }}
                        >
                          <PrintingLayerGpuPreview
                            models={scene.models}
                            clipZ={printingCurrentHeightMm}
                            buildPlateWidthMm={activePrinterProfile?.buildVolumeMm?.width ?? 143}
                            buildPlateDepthMm={activePrinterProfile?.buildVolumeMm?.depth ?? 89}
                            viewportWidthMm={printingPreviewTargetResolution?.viewportWidth}
                            viewportHeightMm={printingPreviewTargetResolution?.viewportHeight}
                            supportGroupRef={supportDragGroupRef as React.RefObject<THREE.Group>}
                            supportVersion={supportRenderRefreshNonce}
                            mirrorX={activePrinterProfile?.display?.mirrorX === true}
                            mirrorY={activePrinterProfile?.display?.mirrorY === true}
                            className="block w-full h-full rounded"
                            style={{
                              transform: printingPreviewScrubUpscaleTransform || 'none',
                              transformOrigin: 'center center',
                              willChange: 'transform',
                            }}
                          />
                        </div>
                      )}

                      {/* PNG layer on top (held briefly during scrub handoff to avoid flash). */}
                      {printingPreviewPngUrlForDisplay && (
                        <div 
                          className="absolute inset-0 transition-opacity duration-150" 
                          style={{ opacity: isPrintingPngLoaded ? 1 : 0 }}
                        >
                          {printingPreviewTargetResolution ? (
                            <svg
                              viewBox={`0 0 ${printingPreviewTargetResolution.viewportWidth} ${printingPreviewTargetResolution.viewportHeight}`}
                              preserveAspectRatio="xMidYMid meet"
                              className="block w-full h-full rounded"
                              role="img"
                              aria-label={`Layer ${printingSelectedLayer} preview`}
                            >
                              <image
                                href={printingPreviewPngUrlForDisplay}
                                x={0}
                                y={0}
                                width={printingPreviewTargetResolution.viewportWidth}
                                height={printingPreviewTargetResolution.viewportHeight}
                                preserveAspectRatio="none"
                                style={{ imageRendering: 'pixelated' }}
                              />
                            </svg>
                          ) : (
                            <img
                              src={printingPreviewPngUrlForDisplay}
                              alt={`Layer ${printingSelectedLayer} preview`}
                              className="block rounded w-full h-full object-contain"
                              style={{ imageRendering: 'pixelated' }}
                            />
                          )}
                        </div>
                      )}

                      {/* Fallback message when no data available */}
                      {!selectedPrintingLayerPreviewUrl && printingPreviewTotalLayers === 0 && (
                        <div
                          className="absolute inset-0 rounded border border-dashed flex items-center justify-center text-xs"
                          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                        >
                          No preview available yet.
                        </div>
                      )}
                    </div>
                  );
                })()}

                {selectedPrintingLayerPreviewUrl && usePrintingSettledHiResCanvas && (
                  <canvas
                    ref={printingPreviewCanvasRef}
                    className="pointer-events-none absolute inset-0 block h-full w-full rounded transition-opacity duration-75"
                    style={{
                      imageRendering: 'pixelated',
                      opacity: isPrintingSettledCanvasReady ? 1 : 0,
                    }}
                    aria-label={`Layer ${printingSelectedLayer} settled preview`}
                  />
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <EditorContextMenu
        position={editorContextMenuPos}
        onAction={handleEditorMenuAction}
        title={editorContextMenuTitle}
        items={editorContextMenuItems}
        disabledActions={editorContextMenuDisabledActions}
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

      <HistoryDebugModal
        isOpen={isHistoryDebugOpen}
        onClose={() => setIsHistoryDebugOpen(false)}
        historyDebugEvents={historyDebugEvents}
        historyStackCounts={historyStackCounts}
        selectedPreviewEventId={historyPreviewTargetEventId}
        isPreviewActive={isHistoryPreviewActive}
        onJumpToEvent={handleHistoryJumpToEvent}
        onCancelPreview={handleHistoryCancelPreview}
        onClearEventLog={() => {
          clearHistoryDebugEvents();
        }}
        onClearUndoRedoStacks={() => {
          clearHistory();
        }}
        onClearAll={() => {
          clearHistory();
          clearHistoryDebugEvents();
        }}
      />

      <SliceMetricsDebugModal
        isOpen={isSliceMetricsDebugOpen}
        onClose={() => setIsSliceMetricsDebugOpen(false)}
        benchmark={printingSlicingBenchmark}
        outputName={printingArtifact?.outputName ?? null}
        outputSizeLabel={printingOutputSizeLabel}
      />

      <SliceCompletedModal
        isOpen={showSliceCompletedModal}
        onClose={() => setShowSliceCompletedModal(false)}
        filePath={sliceCompletedModalData.filePath}
        slicingTimeMs={sliceCompletedModalData.slicingTimeMs}
        onOpenInUvTools={getSavedUvToolsSettings().enabled ? (fp) => {
          const s = getSavedUvToolsSettings();
          launchExternalProcess(resolveUvToolsExecutablePath(s), fp).catch((err) =>
            console.warn('[UVTools] Failed to launch from completed dialog:', err),
          );
        } : undefined}
      />

      <UvToolsLaunchingModal
        isOpen={uvToolsLaunchingPath !== null}
        filePath={uvToolsLaunchingPath}
        onLaunchComplete={() => setUvToolsLaunchingPath(null)}
      />

      <ModelSupportsModal
        isOpen={supportsInfoModelId !== null}
        onClose={() => setSupportsInfoModelId(null)}
        model={scene.models.find((m) => m.id === supportsInfoModelId) ?? null}
      />

      <StructuredDialogModal
        open={showUnappliedHolePunchModal}
        ariaLabel="Unapplied hole punches"
        title="Unapplied Holes"
        subtitle="Some models have unapplied hole punches"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close"
        onClose={() => {
          setShowUnappliedHolePunchModal(false);
          unappliedHolePunchResolveRef.current?.('skip');
          unappliedHolePunchResolveRef.current = null;
        }}
        actions={(
          <>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={() => {
                setShowUnappliedHolePunchModal(false);
                unappliedHolePunchResolveRef.current?.('skip');
                unappliedHolePunchResolveRef.current = null;
              }}
            >
              Continue Without
            </button>
            <button
              type="button"
              className="ui-button ui-button-accent !h-9 px-3 text-xs"
              onClick={() => {
                setShowUnappliedHolePunchModal(false);
                unappliedHolePunchResolveRef.current = null;
                // Defer so the modal closes before apply starts.
                setTimeout(() => { handleApplyHolePunch(); }, 0);
              }}
            >
              Apply Now
            </button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            One or more models have hole punches that haven&apos;t been applied.
            Hole punches must be baked into the geometry before slicing or they
            will not appear in the output.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <strong>Do you want to apply them now?</strong>
          </p>
        </div>
      </StructuredDialogModal>

      <DestructiveTransformModal
        isOpen={pendingDestructiveTransform !== null}
        modelName={pendingDestructiveTransform?.modelName ?? null}
        supportCount={pendingDestructiveTransform?.supportCount ?? 0}
        operationLabel={pendingDestructiveTransform?.operationLabel ?? 'Transform'}
        onCancel={handleCancelDestructiveTransform}
        onConfirm={handleConfirmDestructiveTransform}
      />

      <StructuredDialogModal
        open={showDamagedModelDialog}
        ariaLabel="Mesh boolean operation failed"
        title="Mesh quality too low"
        subtitle="Boolean operation requires a manifold mesh"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="danger"
        closeDisabled
        onClose={() => setShowDamagedModelDialog(false)}
        actions={(
          <button
            type="button"
            className="ui-button ui-button-accent !h-9 px-3 text-xs"
            onClick={() => setShowDamagedModelDialog(false)}
          >
            Got it
          </button>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            This mesh contains too many self-intersecting triangles and
            non-manifold edges for boolean operations to succeed.
            The import repair pass reduced but could not fully resolve
            all issues in the geometry.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            We recommend repairing the mesh in a dedicated 3D modeling
            program such as <strong>Blender</strong> or{' '}
            <strong>Netfabb</strong> before importing it into DragonFruit.
          </p>
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingModifierResetAction !== null}
        ariaLabel="Confirm modifier reset"
        title={pendingModifierResetAction === 'hollowing' ? 'Remove Hollowing?' : 'Remove All Holes?'}
        subtitle="This action can't be undone"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close reset confirmation"
        onClose={() => setPendingModifierResetAction(null)}
        actions={(
          <>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={() => setPendingModifierResetAction(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs"
              style={{
                borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 36%)',
                background: 'color-mix(in srgb, var(--danger), transparent 86%)',
                color: 'var(--danger)',
              }}
              onClick={handleConfirmModifierReset}
            >
              {pendingModifierResetAction === 'hollowing' ? 'Remove Hollowing' : 'Remove All Holes'}
            </button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {pendingModifierResetAction === 'hollowing'
              ? 'Are you sure you want to remove hollowing from this model?'
              : 'Are you sure you want to remove all hole punches from this model?'}
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            {pendingModifierResetAction === 'hollowing'
              ? 'Your model will return to its solid version.'
              : 'All holes on this model will be removed.'}
          </p>
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingBlockerResetState !== null}
        ariaLabel="Confirm blocker reset"
        title="Reset Blockers?"
        subtitle="Blockers will be lost"
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        closeAriaLabel="Close blocker reset confirmation"
        onClose={() => setPendingBlockerResetState(null)}
        actions={(
          <>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={() => setPendingBlockerResetState(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs"
              style={{
                borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 36%)',
                background: 'color-mix(in srgb, var(--danger), transparent 86%)',
                color: 'var(--danger)',
              }}
              onClick={handleConfirmBlockerReset}
            >
              Reset Blockers
            </button>
          </>
        )}
      >
        <div className="space-y-2">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Changing the voxel resolution or shell thickness will clear all applied blockers.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            You will need to re-select blocked regions after the change.
          </p>
        </div>
      </StructuredDialogModal>

      {scene.sceneImportPlacementPrompt && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              scene.resolveSceneImportPlacementPrompt('load_as_is');
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Scene import placement decision"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                    color: 'var(--accent)',
                  }}
                >
                  <LayoutGrid className="h-4 w-4" />
                </span>

                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Scene may be off-plate
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Choose how to place imported models.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close scene import placement prompt"
                onClick={() => scene.resolveSceneImportPlacementPrompt('load_as_is')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Imported scene</div>
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={scene.sceneImportPlacementPrompt.fileName}>
                  {scene.sceneImportPlacementPrompt.fileName}
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {scene.sceneImportPlacementPrompt.offPlateModelCount.toLocaleString()} of {scene.sceneImportPlacementPrompt.modelCount.toLocaleString()} model{scene.sceneImportPlacementPrompt.modelCount === 1 ? '' : 's'} appear outside the build plate.
                </div>
              </div>

              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-strong)' }}>Auto-Arrange</strong> will reposition imported models onto free space on the plate.
                <span className="mt-1 block">
                  <strong style={{ color: 'var(--text-strong)' }}>Load As-Is</strong> keeps scene coordinates exactly as stored in the file.
                </span>
              </p>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                  onClick={() => scene.resolveSceneImportPlacementPrompt('load_as_is')}
                >
                  Load As-Is
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-accent !h-9 w-full px-3 text-xs"
                  onClick={() => scene.resolveSceneImportPlacementPrompt('auto_arrange')}
                >
                  Auto-Arrange
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {autosaveRecovery && (
        <SceneAutosaveRecoveryModal
          savedAt={autosaveRecovery.savedAt}
          onRestore={handleAutosaveRestore}
          onDiscard={handleAutosaveDiscard}
        />
      )}

      {scene.meshRepairConfirmPrompt && (
        <MeshRepairConfirmModal
          prompt={scene.meshRepairConfirmPrompt}
          onRepair={() => scene.resolveMeshRepairConfirmPrompt('repair')}
          onLoadAsIs={() => scene.resolveMeshRepairConfirmPrompt('load_as_is')}
          onCancelImport={() => scene.resolveMeshRepairConfirmPrompt('cancel_import')}
        />
      )}

      {manualRepairModelId && (() => {
        const repairModel = scene.models.find(m => m.id === manualRepairModelId);
        if (!repairModel) return null;
        return (
          <div
            className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !isManualRepairing) {
                setManualRepairModelId(null);
              }
            }}
          >
            <div
              className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
              style={{
                background: 'var(--surface-0)',
                borderColor: 'var(--border-subtle)',
                boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
              }}
              role="dialog"
              aria-modal="true"
              aria-label="Repair mesh"
            >
              <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                    style={{
                      borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 45%)',
                      background: 'color-mix(in srgb, #d97706, var(--surface-1) 88%)',
                      color: '#d97706',
                    }}
                  >
                    <AlertTriangle className="h-4 w-4" />
                  </span>

                  <div className="min-w-0 pr-2">
                    <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                      Repair this mesh?
                    </h2>
                    <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                      DragonFruit will try to fix common geometry issues before you keep working.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'var(--surface-1)',
                    color: 'var(--text-muted)',
                  }}
                  aria-label="Close repair mesh dialog"
                  disabled={isManualRepairing}
                  onClick={() => setManualRepairModelId(null)}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4 p-5">
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Model</div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={repairModel.name}>
                    {repairModel.name}
                  </div>
                </div>

                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Repair can help with holes, broken surfaces, and other mesh problems that may lead to slicing or print issues.
                </p>

                <div
                  className="rounded-md border px-3 py-2"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 40%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)',
                  }}
                >
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: '#d97706' }} />
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      <strong style={{ color: 'var(--text-strong)' }}>Heads up:</strong> The repaired result will replace this model in your current scene. Large or badly damaged meshes can take longer, and some files may still need manual cleanup afterward.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                    disabled={isManualRepairing}
                    onClick={() => setManualRepairModelId(null)}
                  >
                    Keep Original
                  </button>
                  <button
                    type="button"
                    className="ui-button ui-button-accent !h-9 w-full px-3 text-xs flex items-center justify-center gap-1.5 disabled:opacity-60"
                    disabled={isManualRepairing}
                    onClick={() => {
                      const id = manualRepairModelId;
                      setIsManualRepairing(true);
                      void scene.repairModelInPlace(id).finally(() => {
                        setIsManualRepairing(false);
                        setManualRepairModelId(null);
                      });
                    }}
                  >
                    {isManualRepairing
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Repairing…</>
                      : <><Wrench className="h-3.5 w-3.5" />Repair</>
                    }
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {scene.meshRepairReports.length > 0 && (
        <MeshRepairReportModal
          reports={scene.meshRepairReports}
          presentation={scene.meshRepairReportPresentation}
          onDismiss={scene.dismissMeshRepairReports}
        />
      )}

      {showPluginImportWarningModal && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCancelPluginImportWarning();
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="LYS import experimental warning"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: '#d97706',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>

                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    LYS Import is Experimental
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    This feature is still under development.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close LYS import warning"
                onClick={handleCancelPluginImportWarning}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Geometry, support placement, and transforms can import differently across `.lys` scene variants, so unforeseen results are still possible.
              </p>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <label className="inline-flex items-center gap-2 text-xs select-none" style={{ color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    checked={pluginImportWarningSkipFuture}
                    onChange={(event) => setPluginImportWarningSkipFuture(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border"
                    style={{ accentColor: '#f59e0b' }}
                  />
                  <span>Do not remind again</span>
                </label>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                    onClick={handleCancelPluginImportWarning}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ui-button !h-9 px-3 text-xs"
                    style={{
                      borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                      background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                      color: '#fde68a',
                    }}
                    onClick={handleContinuePluginImportWarning}
                  >
                    Continue
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {zipPickerState && (
        <ZipFilePickerModal
          zipName={zipPickerState.zipName}
          files={zipPickerState.files}
          category={zipPickerState.category}
          defaultSelectionCategory={zipPickerState.defaultSelectionCategory}
          onConfirm={(selected) => {
            const resolve = zipPickerResolveRef.current;
            zipPickerResolveRef.current = null;
            setZipPickerState(null);
            resolve?.(selected);
          }}
          onCancel={() => {
            const resolve = zipPickerResolveRef.current;
            zipPickerResolveRef.current = null;
            setZipPickerState(null);
            resolve?.([]);
          }}
        />
      )}

      <StructuredDialogModal
        open={showCloseUnsavedChangesModal}
        ariaLabel="Unsaved changes"
        title="Unsaved Scene Changes"
        subtitle={hasUnsavedSceneChanges
          ? 'You have unsaved edits in this scene.'
          : 'This scene is already saved.'}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        zIndexClassName="z-[220]"
        closeAriaLabel="Close unsaved changes modal"
        closeDisabled={closeUnsavedChangesBusy !== 'none'}
        onClose={() => {
          if (closeUnsavedChangesBusy !== 'none') return;
          setShowCloseUnsavedChangesModal(false);
        }}
        onBackdropClick={() => {
          if (closeUnsavedChangesBusy !== 'none') return;
          setShowCloseUnsavedChangesModal(false);
        }}
        actions={(
          <>
            <button
              type="button"
              className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
              disabled={closeUnsavedChangesBusy !== 'none'}
              onClick={handleDiscardAndCloseProgram}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Discard Changes
            </button>
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
              disabled={closeUnsavedChangesBusy !== 'none'}
              onClick={handleSaveAndCloseProgram}
            >
              Save &amp; Close
            </button>
          </>
        )}
      >
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {hasUnsavedSceneChanges
            ? 'You’re about to close DragonFruit with unsaved scene changes.'
            : 'Close DragonFruit now?'}
        </p>
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <strong>Please ensure you have saved any important work.</strong>
        </p>
      </StructuredDialogModal>

      {showSceneSaveChoiceModal && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              resolveSceneSaveChoice('cancel');
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Save scene options"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #22c55e, var(--surface-1) 90%)',
                    color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" />
                </span>

                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Save Loaded Scene
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Choose where Ctrl+S should save this imported `.voxl` scene.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close save scene options"
                onClick={() => resolveSceneSaveChoice('cancel')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3.5 p-5">
              <div
                className="rounded-lg border px-3 py-2.5"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                }}
              >
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Loaded file
                </div>
                <div className="mt-1 text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }} title={sceneSaveChoiceFileName ?? ''}>
                  {sceneSaveChoiceFileName ?? 'Loaded scene'}
                </div>
                <div className="mt-1 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }} title={sceneSaveChoicePath ?? ''}>
                  {sceneSaveChoicePath ?? 'Original file path unavailable (overwrite disabled)'}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-0.5">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs whitespace-nowrap"
                  onClick={() => resolveSceneSaveChoice('save_as')}
                >
                  Save as New Scene
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-accent !h-9 px-3 text-xs whitespace-nowrap"
                  disabled={!sceneSaveChoicePath}
                  onClick={() => resolveSceneSaveChoice('overwrite')}
                >
                  Overwrite Loaded Scene
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {printingMonitorPendingConfirmation && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPrintingMonitorPendingConfirmation(null);
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label={
              printingMonitorPendingConfirmation.kind === 'control'
                ? (printingMonitorPendingConfirmation.action === 'cancel' ? 'Confirm cancel print' : 'Confirm emergency stop')
                : (printingMonitorPendingConfirmation.action === 'start' ? 'Confirm start recent file' : 'Confirm delete recent file')
            }
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: '#d97706',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {printingMonitorPendingConfirmation.kind === 'control'
                      ? (printingMonitorPendingConfirmation.action === 'cancel' ? 'Cancel Print Job' : 'Emergency Stop')
                      : (printingMonitorPendingConfirmation.action === 'start' ? 'Start Recent Print File' : 'Delete Recent Print File')}
                  </h2>
                  <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {printingMonitorPendingConfirmation.kind === 'control'
                      ? (
                        printingMonitorPendingConfirmation.action === 'cancel'
                          ? 'This action cannot be undone.'
                          : 'This will immediately halt the printer.'
                      )
                      : (
                        printingMonitorPendingConfirmation.action === 'start'
                          ? 'Start this recent file on the selected printer now?'
                          : 'This will remove the file from the printer.'
                      )}
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close monitor confirmation modal"
                onClick={() => setPrintingMonitorPendingConfirmation(null)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {printingMonitorPendingConfirmation.kind === 'plate' && (
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>File</div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={`#${printingMonitorPendingConfirmation.plateId} • ${printingMonitorPendingConfirmation.plateName}`}>
                    {`#${printingMonitorPendingConfirmation.plateId} • ${printingMonitorPendingConfirmation.plateName}`}
                  </div>
                </div>
              )}

              <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Printer</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {monitoringDevice?.displayName || monitoringDevice?.hostName || monitoringDevice?.ipAddress || 'Selected printer'}
                </div>
              </div>

              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {printingMonitorPendingConfirmation.kind === 'control'
                  ? (
                    printingMonitorPendingConfirmation.action === 'cancel'
                      ? 'Canceling will stop the current print job and clear queued progress for this plate.'
                      : 'Emergency Stop is for immediate intervention and should be used only when necessary.'
                  )
                  : (
                    printingMonitorPendingConfirmation.action === 'start'
                      ? 'The selected plate will begin printing immediately on this machine.'
                      : 'Deleted files cannot be restored from this monitor.'
                  )}
              </p>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                  onClick={() => setPrintingMonitorPendingConfirmation(null)}
                >
                  {printingMonitorPendingConfirmation.kind === 'plate' ? 'Keep File' : 'Keep Printing'}
                </button>
                <button
                  type="button"
                  className="ui-button !h-9 w-full px-3 text-xs"
                  style={
                    printingMonitorPendingConfirmation.kind === 'plate'
                      ? (
                        printingMonitorPendingConfirmation.action === 'start'
                          ? {
                              borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)',
                              background: 'color-mix(in srgb, #22c55e, var(--surface-1) 84%)',
                              color: 'color-mix(in srgb, #22c55e, var(--text-strong) 25%)',
                            }
                          : {
                              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                              background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                              color: 'color-mix(in srgb, #ef4444, var(--text-strong) 25%)',
                            }
                      )
                      : (
                        printingMonitorPendingConfirmation.action === 'cancel'
                          ? {
                              borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                              background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                              color: 'color-mix(in srgb, #f59e0b, var(--text-strong) 20%)',
                            }
                          : {
                              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                              background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                              color: 'color-mix(in srgb, #ef4444, var(--text-strong) 25%)',
                            }
                      )
                  }
                  onClick={() => {
                    const pending = printingMonitorPendingConfirmation;
                    if (!pending) return;
                    setPrintingMonitorPendingConfirmation(null);
                    if (pending.kind === 'control') {
                      void executePrintingMonitorControlAction(pending.action);
                      return;
                    }
                    if (pending.action === 'start') {
                      void executeStartMonitorRecentPlate(pending.plateId);
                    } else {
                      void executeDeleteMonitorRecentPlate(pending.plateId);
                    }
                  }}
                >
                  {printingMonitorPendingConfirmation.kind === 'plate'
                    ? (printingMonitorPendingConfirmation.action === 'start' ? 'Confirm Start' : 'Confirm Delete')
                    : (printingMonitorPendingConfirmation.action === 'cancel' ? 'Confirm Cancel' : 'Confirm Emergency Stop')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <PrintingResliceModal
        isOpen={showPrintingResliceModal}
        onCancel={() => {
          setShowPrintingResliceModal(false);
          scene.setMode(modeBeforePrintingRef.current);
        }}
        onResliceNow={() => {
          setShowPrintingResliceModal(false);
          shouldReturnToPrintingAfterSliceRef.current = true;
          setShouldAutoSliceOnExportEntry(true);
          scene.setMode('export');
        }}
      />

      {preSlicePrintConfirmOpen && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPreSlicePrintConfirmOpen(false);
              if (preSlicePrintConfirmResolverRef.current) {
                preSlicePrintConfirmResolverRef.current(false);
                preSlicePrintConfirmResolverRef.current = null;
              }
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Print readiness confirmation"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: '#d97706',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>

                <div className="min-w-0 pr-2">
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Safety Check
                  </div>
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Confirm printer is ready to print
                  </h2>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close print readiness confirmation"
                onClick={() => {
                  setPreSlicePrintConfirmOpen(false);
                  if (preSlicePrintConfirmResolverRef.current) {
                    preSlicePrintConfirmResolverRef.current(false);
                    preSlicePrintConfirmResolverRef.current = null;
                  }
                }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Please verify before continuing:
              </div>
              <div className="rounded-md border p-3 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)' }} />
                  <span>Build plate and resin vat are properly seated and secured.</span>
                </div>
                <div className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)' }} />
                  <span>Resin is mixed, sufficient for the print, and at operating temperature.</span>
                </div>
                <div className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)' }} />
                  <span>Build plate is clean and clear, and the printer cover is fully closed.</span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                  onClick={() => {
                    setPreSlicePrintConfirmOpen(false);
                    if (preSlicePrintConfirmResolverRef.current) {
                      preSlicePrintConfirmResolverRef.current(false);
                      preSlicePrintConfirmResolverRef.current = null;
                    }
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-accent !h-9 px-3 text-xs"
                  onClick={() => {
                    setPreSlicePrintConfirmOpen(false);
                    if (preSlicePrintConfirmResolverRef.current) {
                      preSlicePrintConfirmResolverRef.current(true);
                      preSlicePrintConfirmResolverRef.current = null;
                    }
                  }}
                >
                  Continue to Slicing
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {printingTargetPickerOpen && (
        <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm px-4">
          <div
            className="w-full max-w-3xl overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Choose printer"
          >
            <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  {isPreSliceTargetPicker ? 'Pre-Slice Targeting' : 'Fleet Upload'}
                </div>
                <div className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {isPreSliceTargetPicker ? 'Choose target before slicing' : 'Choose target printer'}
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3.5">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {requiresRemoteMaterialSelectionForUpload
                  ? (isPreSliceTargetPicker
                    ? 'Pick the target machine and material profile now, then slicing will begin.'
                    : 'Pick the target machine and material profile for this upload.')
                  : (isPreSliceTargetPicker
                    ? 'Pick the target machine now, then slicing will begin.'
                    : 'Pick the target machine for this upload.')}
              </div>
              {requiresRemoteMaterialSelectionForUpload && !isPreSliceTargetPicker && (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Target layer height: <span style={{ color: 'var(--text-strong)' }}>{slicedLayerHeightMm.toFixed(3)} mm</span>
                </div>
              )}

              <div className={`grid gap-3 md:items-start ${requiresRemoteMaterialSelectionForUpload ? 'md:grid-cols-2' : 'md:grid-cols-1'}`}>
                <div className="rounded-md border px-3 py-2.5 min-h-[360px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                    Target printer
                  </div>
                  <div className="max-h-[318px] overflow-y-auto custom-scrollbar pr-1 space-y-2">
                    {printableConnectedPrinterFleet.map((device) => {
                      const isSelected = device.id === (printingTargetDeviceId ?? printingTargetDevice?.id);
                      const isDeviceOffline = printerReachabilityByDeviceId[device.id] === false;
                      return (
                        <button
                          key={device.id}
                          type="button"
                          onClick={() => {
                            if (isDeviceOffline) return;
                            setPrintingTargetDeviceId(device.id);
                            if (activePrinterProfile?.id) {
                              selectPrinterNetworkDevice(activePrinterProfile.id, device.id);
                            }
                          }}
                          disabled={isDeviceOffline}
                          className="relative w-full rounded-lg border px-3 py-2.5 pr-9 text-left"
                          style={isDeviceOffline
                            ? {
                                borderColor: 'color-mix(in srgb, var(--border-subtle), black 18%)',
                                background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                                color: 'var(--text-muted)',
                                opacity: 0.55,
                              }
                            : isSelected
                            ? {
                                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 28%)',
                                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 89%)',
                              }
                            : {
                                borderColor: 'var(--border-subtle)',
                                background: 'color-mix(in srgb, var(--surface-1), black 3%)',
                              }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                                {device.displayName || device.hostName || device.ipAddress}
                              </div>
                              <div className="text-[12px] leading-tight mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                {device.ipAddress} • {isDeviceOffline ? 'Offline' : 'Online'}
                              </div>
                            </div>
                          </div>
                          {isDeviceOffline ? (
                            <span
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide"
                              style={{ color: 'var(--text-muted)' }}
                              aria-label="Printer offline"
                            >
                              Offline
                            </span>
                          ) : (isSelected && (
                            <div
                              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full"
                              style={{
                                color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
                                background: 'color-mix(in srgb, #22c55e, transparent 84%)',
                              }}
                              aria-label="Selected printer"
                              title="Selected"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                            </div>
                          ))}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {requiresRemoteMaterialSelectionForUpload && (
                  <div className="rounded-md border px-3 py-2.5 min-h-[360px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                      {isPreSliceTargetPicker ? 'Target material' : 'Target material (matching sliced layer height)'}
                    </div>
                    {isPrintingTargetMaterialsLoading ? (
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading materials from selected printer…</div>
                    ) : printingTargetMaterialOptions.length > 0 ? (
                      <div className="max-h-[318px] overflow-y-auto custom-scrollbar pr-1 space-y-2">
                        {printingTargetMaterialGroups.map((group) => (
                          <div key={group.label} className="space-y-1.5">
                            {group.label && (
                              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                {group.label}
                              </div>
                            )}
                            <div className="space-y-1">
                              {group.materials.map((material) => {
                                const isSelectedMaterial = material.id === printingTargetMaterialId;
                                return (
                                  <button
                                    key={material.id}
                                    type="button"
                                    onClick={() => {
                                      setPrintingTargetMaterialId(material.id);
                                      if (activePrinterProfile?.id && printingTargetDevice) {
                                        upsertPrinterNetworkDevice(
                                          activePrinterProfile.id,
                                          {
                                            id: printingTargetDevice.id,
                                            ipAddress: printingTargetDevice.ipAddress,
                                            selectedMaterialId: material.id,
                                            selectedMaterialName: material.name,
                                            selectedMaterialLayerHeightMm: material.layerHeightMm ?? undefined,
                                          },
                                          { select: true },
                                        );
                                      }
                                    }}
                                    className="relative w-full rounded-md border px-2.5 py-2 pr-9 text-left"
                                    style={isSelectedMaterial
                                      ? {
                                          borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 32%)',
                                          background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                                        }
                                      : {
                                          borderColor: 'var(--border-subtle)',
                                          background: 'color-mix(in srgb, var(--surface-1), black 3%)',
                                        }}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0 text-[13px] font-medium truncate" style={{ color: 'var(--text-strong)' }} title={material.name}>
                                        {material.name}
                                      </div>
                                    </div>
                                    {material.layerHeightMm != null && (
                                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                        {material.layerHeightMm.toFixed(3)} mm
                                      </div>
                                    )}
                                    {isSelectedMaterial && (
                                      <div
                                        className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full"
                                        style={{
                                          color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
                                          background: 'color-mix(in srgb, #22c55e, transparent 84%)',
                                        }}
                                        aria-label="Selected material"
                                        title="Selected"
                                      >
                                        <CheckCircle2 className="h-4 w-4" />
                                      </div>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {printingTargetMaterialError ?? 'No matching material profile found on this printer.'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {requiresRemoteMaterialSelectionForUpload && printingTargetMaterialError && printingTargetMaterialOptions.length > 0 && (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {printingTargetMaterialError}
                </div>
              )}

              {printingTargetDevice && printerReachabilityByDeviceId[printingTargetDevice.id] === false && (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Selected printer is offline. Choose an online printer to continue.
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                  onClick={() => {
                    setPrintingTargetPickerOpen(false);
                    if (isPreSliceTargetPicker && preSliceTargetPickerResolverRef.current) {
                      preSliceTargetPickerResolverRef.current(null);
                      preSliceTargetPickerResolverRef.current = null;
                    }
                    setPrintingTargetPickerMode('post-slice');
                  }}
                  disabled={printingSendBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-accent !h-9 px-3 text-xs"
                  disabled={
                    printingSendBusy
                    || isPrintingTargetMaterialsLoading
                    || !printingTargetDevice
                    || (requiresRemoteMaterialSelectionForUpload && !printingTargetMaterialId)
                    || printerReachabilityByDeviceId[printingTargetDevice.id] === false
                  }
                  onClick={() => {
                    if (!printingTargetDevice) return;
                    if (requiresRemoteMaterialSelectionForUpload && !printingTargetMaterialId) return;
                    setPrintingTargetPickerOpen(false);
                    if (isPreSliceTargetPicker && preSliceTargetPickerResolverRef.current) {
                      preSliceTargetPickerResolverRef.current({
                        deviceId: printingTargetDevice.id,
                        materialId: requiresRemoteMaterialSelectionForUpload ? printingTargetMaterialId : undefined,
                      });
                      preSliceTargetPickerResolverRef.current = null;
                      setPrintingTargetPickerMode('post-slice');
                      return;
                    }

                    setPrintingTargetPickerMode('post-slice');
                    void performSendToPrinter(
                      printingTargetDevice,
                      requiresRemoteMaterialSelectionForUpload ? printingTargetMaterialId : undefined,
                    );
                  }}
                >
                  {isPreSliceTargetPicker ? 'Continue to Slicing' : 'Upload to Selected Printer'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {printingUploadDialogOpen && (
        <div className="absolute inset-0 z-[121] flex items-center justify-center bg-black/55 backdrop-blur-sm px-4">
          <div
            className="w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-live="polite"
            aria-label="Printer upload status"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Post-Processing
                </div>
                <div className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Upload to {activeNetworkUiAdapter?.displayName ?? 'Printer'}
                </div>
                <div className="mt-0.5 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                  {printingArtifact?.outputName ?? 'Preparing artifact'}
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Stage</div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {printingDialogStageLabel}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Target Printer</div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={printingTargetDevice?.displayName || printingTargetDevice?.hostName || printingTargetDevice?.ipAddress || 'Pending'}>
                    {printingTargetDevice?.displayName || printingTargetDevice?.hostName || printingTargetDevice?.ipAddress || 'Pending'}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Plate</div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {printingReadyPlateId ? `#${printingReadyPlateId}` : 'Pending'}
                  </div>
                </div>
              </div>

              <div className="text-xs min-h-[18px]" style={{ color: 'var(--text-muted)' }}>
                {printingSendStatusText ?? 'Preparing upload pipeline…'}
              </div>

              {printingUploadDialogStage === 'started' && (
                <div className="rounded-md border px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
                  Print started. Use <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>Monitor</span> in the top bar to view live progress and webcam.
                </div>
              )}

              {printingUploadDialogStage === 'uploading' && printingUploadTelemetry && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div
                    className="rounded-md border px-2.5 py-2"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                  >
                    <div className="uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Speed</div>
                    <div
                      className="mt-1 text-xs font-semibold"
                      style={{ color: 'var(--text-strong)', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {printingUploadTelemetry.speed}
                    </div>
                  </div>
                  <div
                    className="rounded-md border px-2.5 py-2"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                  >
                    <div className="uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Remaining</div>
                    <div
                      className="mt-1 text-xs font-semibold"
                      style={{ color: 'var(--text-strong)', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {printingUploadTelemetry.remaining}
                    </div>
                  </div>
                  <div
                    className="rounded-md border px-2.5 py-2"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                  >
                    <div className="uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Transferred</div>
                    <div
                      className="mt-1 text-xs font-semibold"
                      style={{ color: 'var(--text-strong)', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {printingUploadTelemetry.transferred}
                    </div>
                  </div>
                </div>
              )}

              {printingDialogIsIndeterminate ? (
                <>
                  <div
                    className="ui-loading-track h-2.5 w-full rounded-full"
                    style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                  >
                    <div
                      className="ui-loading-indicator"
                      style={{ background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))' }}
                    />
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Processing on {activeNetworkUiAdapter?.displayName ?? 'printer backend'}… elapsed {printingProcessingElapsedLabel}
                  </div>
                </>
              ) : (
                <div
                  className="h-2.5 w-full rounded-full border overflow-hidden"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-2), black 20%)',
                  }}
                >
                  <div
                    className="h-full rounded-full transition-[width] duration-200 ease-out"
                    style={{
                      width: `${printingDialogProgressPercent.toFixed(2)}%`,
                      background: printingUploadDialogStage === 'failed'
                        ? 'linear-gradient(90deg, #ef4444, #f97316)'
                        : printingUploadDialogStage === 'started'
                          ? 'linear-gradient(90deg, #60a5fa, #22d3ee)'
                          : 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))',
                    }}
                  />
                </div>
              )}

              <div className="mt-1 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <span>
                  {printingUploadDialogStage === 'processing'
                    ? 'Waiting for metadata readiness'
                    : 'Transfer progress'}
                </span>
                <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {printingDialogIsIndeterminate ? '—' : `${printingDialogProgressPercent.toFixed(0)}%`}
                </span>
              </div>

              <div className="pt-1 flex items-center justify-end gap-2">
                {(printingUploadDialogStage === 'failed' || printingUploadDialogStage === 'started' || printingUploadDialogStage === 'ready') && (
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                    onClick={() => setPrintingUploadDialogOpen(false)}
                    disabled={printingSendBusy || printingPrintNowBusy}
                  >
                    Close
                  </button>
                )}

                {printingUploadDialogStage === 'failed' && (
                  <button
                    type="button"
                    className="ui-button ui-button-accent !h-9 px-3 text-xs"
                    onClick={() => { void handleSendToPrinter(); }}
                    disabled={printingSendBusy || printingPrintNowBusy || !canSendToPrinter}
                  >
                    Retry Upload
                  </button>
                )}

                {printingUploadDialogStage === 'ready' && (
                  <button
                    type="button"
                    className="ui-button ui-button-accent !h-9 px-3 text-xs"
                    onClick={handlePrintNow}
                    disabled={!canPrintNow || printingPrintNowBusy || printingSendBusy}
                  >
                    {printingPrintNowBusy ? 'Starting print…' : 'Start Print'}
                  </button>
                )}

                {printingUploadDialogStage === 'started' && (
                  <button
                    type="button"
                    className="ui-button ui-button-accent !h-9 px-3 text-xs"
                    onClick={() => openPrintingMonitorForTargetDevice(printingTargetDevice?.id ?? null)}
                    disabled={printingSendBusy || printingPrintNowBusy}
                  >
                    Open Monitor
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {printingMonitorModalOpen && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            onClick={() => setPrintingMonitorModalOpen(false)}
            aria-label="Close printer monitor"
          />

          <div
            className={`relative z-[1] ${printingMonitorModalWidthClass} max-h-[88vh] overflow-auto rounded-xl border shadow-2xl`}
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Printer monitor"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              {printingMonitorViewMode === 'dashboard' ? (
                <div className="inline-flex items-center gap-2 px-1.5 py-1">
                  <div className="inline-flex h-7 w-7 items-center justify-center rounded-sm shrink-0" style={{
                    background: 'color-mix(in srgb, #baf72e, var(--surface-1) 90%)',
                    border: '1px solid color-mix(in srgb, #baf72e, var(--border-subtle) 45%)',
                    color: 'var(--accent-secondary)',
                  }}>
                    <LayoutGrid className="h-3.5 w-3.5" />
                  </div>
                  <span className="min-w-0 flex max-w-[320px] flex-col items-start leading-none gap-[2px]">
                    <span
                      className="truncate text-[10px] tracking-[0.01em]"
                      style={{ color: 'var(--text-muted)' }}
                      title="Monitoring Dashboard"
                    >
                      Monitoring Dashboard
                    </span>
                    <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }} title="Fleet Status Overview">
                      Fleet Status Overview
                    </span>
                  </span>
                </div>
              ) : (
                <div className="relative" ref={printingMonitorPrinterMenuRef}>
                  {monitorSelectableDevices.length > 1 ? (
                    <button
                      type="button"
                      className="group inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold transition-colors"
                      style={{
                        background: 'transparent',
                        color: 'var(--text-strong)',
                      }}
                      onClick={() => setIsPrintingMonitorPrinterMenuOpen((previous) => !previous)}
                      aria-label={printingMonitorHeaderUsesFleetLabelOrder
                        ? `Select monitored printer for profile ${printingMonitorHeaderTopLabel}`
                        : 'Select monitored printer'}
                      title={printingMonitorHeaderTitle}
                    >
                      <div
                        className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-sm shrink-0"
                        style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}
                      >
                        {printingMonitorPrinterThumbnailSrc ? (
                          <img
                            src={printingMonitorPrinterThumbnailSrc}
                            alt={activePrinterProfile?.name ?? 'Selected printer'}
                            className="h-full w-full object-contain"
                            draggable={false}
                            onError={() => setIsPrintingMonitorPrinterThumbnailFailed(true)}
                          />
                        ) : (
                          <Printer className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                        )}
                      </div>
                      <span className="min-w-0 flex max-w-[280px] flex-col items-start leading-none gap-[2px]">
                        <span
                          className={printingMonitorHeaderUsesFleetLabelOrder
                            ? 'truncate text-[10px] tracking-[0.01em]'
                            : 'text-[9px] uppercase tracking-[0.11em]'}
                          style={{ color: 'var(--text-muted)' }}
                          title={printingMonitorHeaderTopLabel}
                        >
                          {printingMonitorHeaderTopLabel}
                        </span>
                        <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }} title={printingMonitorHeaderBottomLabel}>
                          {printingMonitorHeaderBottomLabel}
                        </span>
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isPrintingMonitorPrinterMenuOpen ? 'rotate-180' : ''}`} />
                    </button>
                  ) : (
                    <div className="inline-flex items-center gap-2 px-1.5 py-1">
                      <div
                        className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-sm shrink-0"
                        style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}
                      >
                        {printingMonitorPrinterThumbnailSrc ? (
                          <img
                            src={printingMonitorPrinterThumbnailSrc}
                            alt={activePrinterProfile?.name ?? 'Selected printer'}
                            className="h-full w-full object-contain"
                            draggable={false}
                            onError={() => setIsPrintingMonitorPrinterThumbnailFailed(true)}
                          />
                        ) : (
                          <Printer className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                        )}
                      </div>
                      <span className="min-w-0 flex max-w-[280px] flex-col items-start leading-none gap-[2px]">
                        <span
                          className={printingMonitorHeaderUsesFleetLabelOrder
                            ? 'truncate text-[10px] tracking-[0.01em]'
                            : 'text-[9px] uppercase tracking-[0.11em]'}
                          style={{ color: 'var(--text-muted)' }}
                          title={printingMonitorHeaderTopLabel}
                        >
                          {printingMonitorHeaderTopLabel}
                        </span>
                        <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }} title={printingMonitorHeaderBottomLabel}>
                          {printingMonitorHeaderBottomLabel}
                        </span>
                      </span>
                    </div>
                  )}

                  {isPrintingMonitorPrinterMenuOpen && monitorSelectableDevices.length > 1 && (
                    <div
                      className="absolute left-0 top-full z-20 mt-2 w-[min(360px,82vw)] rounded-lg border p-1.5 shadow-xl"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        background: 'color-mix(in srgb, var(--surface-0), #000 8%)',
                      }}
                    >
                      <div className="max-h-56 overflow-y-auto custom-scrollbar space-y-1 pr-0.5">
                        {monitorSelectableDevices.map((device) => {
                          const selected = monitoringDevice?.id === device.id;
                          const display = device.displayName || device.hostName || device.ipAddress || `Printer ${device.id}`;
                          const isOffline = printerReachabilityByDeviceId[device.id] === false;
                          return (
                            <button
                              key={device.id}
                              type="button"
                              className="w-full rounded-md border px-2.5 py-2 text-left"
                              style={isOffline
                                ? {
                                    borderColor: 'color-mix(in srgb, var(--border-subtle), black 18%)',
                                    background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                                    opacity: 0.55,
                                  }
                                : selected
                                ? {
                                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)',
                                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                                  }
                                : {
                                    borderColor: 'var(--border-subtle)',
                                    background: 'var(--surface-1)',
                                  }}
                              disabled={isOffline}
                              onClick={() => {
                                if (isOffline) return;
                                setPrintingMonitorDeviceId(device.id);
                                setIsPrintingMonitorPrinterMenuOpen(false);
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <div
                                  className="inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-sm shrink-0"
                                  style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}
                                >
                                  {printingMonitorPrinterThumbnailSrc ? (
                                    <img
                                      src={printingMonitorPrinterThumbnailSrc}
                                      alt={activePrinterProfile?.name ?? display}
                                      className="h-full w-full object-contain"
                                      draggable={false}
                                      onError={() => setIsPrintingMonitorPrinterThumbnailFailed(true)}
                                    />
                                  ) : (
                                    <Printer className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[12px] font-semibold" style={{ color: 'var(--text-strong)' }} title={display}>
                                    {display}
                                  </div>
                                  <div className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--text-muted)' }} title={device.ipAddress || undefined}>
                                    {device.ipAddress || 'No IP'} • {isOffline ? 'Offline' : 'Online'}
                                  </div>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                {hasPrintingMonitorFleet && (
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-8 px-2.5 text-[11px] inline-flex items-center gap-1"
                    onClick={() => {
                      setIsPrintingMonitorPrinterMenuOpen(false);
                      setPrintingMonitorViewMode((previous) => {
                        const next = previous === 'dashboard' ? 'detail' : 'dashboard';
                        return next;
                      });
                    }}
                    title={printingMonitorViewMode === 'dashboard' ? 'Switch to detailed single-printer view' : 'Switch to dashboard view for all fleet printers'}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    {printingMonitorViewMode === 'dashboard' ? 'Detail View' : 'Dashboard View'}
                  </button>
                )}
                <button
                  type="button"
                  className="ui-button ui-button-secondary inline-flex items-center justify-center leading-none !h-8 !w-8 !p-0"
                  onClick={() => setPrintingMonitorModalOpen(false)}
                  aria-label="Close printer monitor"
                  title="Close monitor"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {printingMonitorViewMode === 'dashboard' ? (
              <div className="p-5">
                {dashboardMonitorDevices.length > 0 ? (
                  <div
                    className="overflow-y-auto custom-scrollbar pr-1"
                    style={{ height: 'clamp(34rem, 66vh, 42rem)' }}
                  >
                    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 auto-rows-max content-start">
                    {dashboardMonitorDevices.map((device) => {
                      const display = device.displayName || device.hostName || device.ipAddress || `Printer ${device.id}`;
                      const snapshot = printingMonitorDashboardSnapshots[device.id] ?? null;
                      const isOffline = printerReachabilityByDeviceId[device.id] === false || device.connected !== true;
                      const isPaused = !isOffline && Boolean(snapshot?.isPaused);
                      const isPrinting = !isOffline && Boolean(snapshot?.isPrinting) && !isPaused;
                      const isIdle = !isOffline && !isPrinting && !isPaused;
                      const stateText = isOffline ? 'Offline' : (snapshot?.stateText?.trim() || 'Status unavailable');
                      const hasActivePrint = !isOffline && (isPrinting || isPaused);
                      const currentLayer = Number.isFinite(Number(snapshot?.currentLayer)) ? Math.max(0, Math.round(Number(snapshot?.currentLayer))) : null;
                      const totalLayersRaw = Number.isFinite(Number(snapshot?.totalLayers)) ? Math.round(Number(snapshot?.totalLayers)) : null;
                      const totalLayers = totalLayersRaw != null && totalLayersRaw > 0 ? totalLayersRaw : null;
                      const progressPct = totalLayers != null && currentLayer != null
                        ? Math.max(0, Math.min(100, ((Math.max(0, currentLayer - 1)) / totalLayers) * 100))
                        : null;
                      const displayCurrentLayer = hasActivePrint ? currentLayer : null;
                      const displayTotalLayers = hasActivePrint ? totalLayers : null;
                      const displayProgressPct = hasActivePrint ? progressPct : null;
                      const displayLayerText = hasActivePrint
                        ? (displayTotalLayers != null
                          ? `${displayCurrentLayer ?? '—'}/${displayTotalLayers}`
                          : (displayCurrentLayer != null ? `${displayCurrentLayer}` : '—'))
                        : '-/-';
                      const brandColor = '#baf72e';
                      const idleColor = '#60a5fa';
                      const pausedColor = '#f59e0b';
                      const cardHoverHintText = 'Click to show Detailed View';
                      const progressFill = isPaused
                        ? `linear-gradient(90deg, ${pausedColor}, color-mix(in srgb, ${pausedColor}, #fde68a 35%))`
                        : isPrinting
                          ? `linear-gradient(90deg, ${brandColor}, color-mix(in srgb, ${brandColor}, #52cc80 50%))`
                          : 'color-mix(in srgb, var(--text-muted), transparent 78%)';
                      const progressTextColor = isPaused
                        ? '#fde68a'
                        : isPrinting
                          ? brandColor
                          : 'var(--text-muted)';

                      return (
                        <div
                          key={device.id}
                          className="group w-full rounded-lg border overflow-hidden transition-shape hover:shadow-sm text-left"
                          onClick={() => {
                            if (isOffline) return;
                            setPrintingMonitorDeviceId(device.id);
                            setPrintingMonitorViewMode('detail');
                          }}
                          onKeyDown={(event) => {
                            if (isOffline) return;
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setPrintingMonitorDeviceId(device.id);
                              setPrintingMonitorViewMode('detail');
                            }
                          }}
                          style={{
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            cursor: isOffline ? 'not-allowed' : 'pointer',
                          }}
                          title={isOffline
                              ? `${display} is offline`
                              : `Open detailed monitor for ${display}`}
                          aria-label={isOffline
                              ? `${display} is offline`
                              : `Open detailed monitor for ${display}`}
                          role={isOffline ? undefined : 'button'}
                          tabIndex={isOffline ? -1 : 0}
                        >
                          {/* Thumbnail Header */}
                          {device.imageDataUrl ? (
                            <div
                              className="relative h-28 overflow-hidden"
                              style={{
                                background: 'linear-gradient(135deg, color-mix(in srgb, var(--surface-2), black 30%), var(--surface-1))',
                              }}
                            >
                              <img
                                src={device.imageDataUrl}
                                alt={display}
                                className="h-full w-full object-cover"
                                style={isOffline ? { filter: 'grayscale(100%) sepia(0.25) brightness(0.94)' } : undefined}
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                }}
                              />
                              {!isOffline && (
                                <div
                                  className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                  style={{ background: 'color-mix(in srgb, #000, transparent 55%)' }}
                                >
                                  <span
                                    className="rounded-md border px-2 py-1 text-[10px] font-semibold tracking-wide"
                                    style={{
                                      borderColor: 'color-mix(in srgb, #baf72e, var(--border-subtle) 55%)',
                                      color: '#d9ff8f',
                                      background: 'color-mix(in srgb, #1f2937, transparent 35%)',
                                    }}
                                  >
                                    {cardHoverHintText}
                                  </span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div
                              className="relative h-28 flex items-center justify-center"
                              style={{
                                background: 'linear-gradient(135deg, color-mix(in srgb, var(--surface-2), black 30%), var(--surface-1))',
                                color: 'var(--text-muted)',
                              }}
                            >
                              <Printer className="h-8 w-8 opacity-40" />
                              {!isOffline && (
                                <div
                                  className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                  style={{ background: 'color-mix(in srgb, #000, transparent 55%)' }}
                                >
                                  <span
                                    className="rounded-md border px-2 py-1 text-[10px] font-semibold tracking-wide"
                                    style={{
                                      borderColor: 'color-mix(in srgb, #baf72e, var(--border-subtle) 55%)',
                                      color: '#d9ff8f',
                                      background: 'color-mix(in srgb, #1f2937, transparent 35%)',
                                    }}
                                  >
                                    {cardHoverHintText}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          <div className="p-3 space-y-2">
                            {/* Name + Status Pill */}
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-semibold leading-tight" style={{ color: 'var(--text-strong)' }} title={display}>
                                  {display}
                                </div>
                                <div className="truncate text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }} title={device.ipAddress || undefined}>
                                  {device.ipAddress || 'No IP'}
                                </div>
                              </div>
                              <div
                                className="inline-flex h-6 items-center rounded-full border px-2.5 text-[10px] font-semibold whitespace-nowrap flex-shrink-0"
                                style={{
                                  borderColor: isOffline
                                    ? 'color-mix(in srgb, #ef4444, var(--border-subtle) 52%)'
                                    : isPaused
                                    ? `color-mix(in srgb, ${pausedColor}, var(--border-subtle) 45%)`
                                    : isPrinting
                                    ? `color-mix(in srgb, ${brandColor}, var(--border-subtle) 45%)`
                                    : `color-mix(in srgb, ${idleColor}, var(--border-subtle) 40%)`,
                                  color: isOffline
                                    ? '#fecaca'
                                    : isPaused
                                      ? '#fde68a'
                                      : isPrinting
                                        ? brandColor
                                        : '#bfdbfe',
                                  background: isOffline
                                    ? 'color-mix(in srgb, #ef4444, var(--surface-1) 90%)'
                                    : isPaused
                                    ? `color-mix(in srgb, ${pausedColor}, var(--surface-1) 90%)`
                                    : isPrinting
                                    ? `color-mix(in srgb, ${brandColor}, var(--surface-1) 92%)`
                                    : `color-mix(in srgb, ${idleColor}, var(--surface-1) 88%)`,
                                }}
                              >
                                {isOffline ? 'Offline' : (isPaused ? 'Paused' : (isPrinting ? 'Printing' : (isIdle ? 'Idle' : 'Idle')))}
                              </div>
                            </div>

                            {/* State Text */}
                            <div className="text-[11px] leading-tight" style={{ color: 'var(--text-muted)' }} title={stateText}>
                              {stateText}
                            </div>

                            {/* Progress Bar (always rendered to keep card heights consistent) */}
                            <div className="space-y-2 min-h-[34px]">
                              <div className="h-2.5 w-full rounded-full border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), black 25%)' }}>
                                <div
                                  className="h-full rounded-full transition-[width] duration-200 ease-out"
                                  style={{
                                    width: `${(displayProgressPct ?? 0).toFixed(1)}%`,
                                    background: hasActivePrint ? progressFill : 'color-mix(in srgb, var(--text-muted), transparent 78%)',
                                  }}
                                />
                              </div>
                              <div className="text-[10px] flex justify-between" style={{ color: 'var(--text-muted)' }}>
                                <span>Layer {displayLayerText}</span>
                                <span className="font-semibold" style={{ color: hasActivePrint ? progressTextColor : 'var(--text-muted)' }}>
                                  {hasActivePrint && displayProgressPct != null ? `${displayProgressPct.toFixed(0)}%` : '-'}
                                </span>
                              </div>
                            </div>

                          </div>
                        </div>
                      );
                    })}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border p-6 text-center" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 4%)' }}>
                    <Printer className="h-8 w-8 mx-auto mb-2 opacity-40" style={{ color: 'var(--text-muted)' }} />
                    <div className="text-[12px] font-medium" style={{ color: 'var(--text-strong)' }}>
                      No printers available
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                      No networked printers with valid IP addresses were found in this fleet
                    </div>
                  </div>
                )}
              </div>
            ) : shouldShowPrintingMonitorSlowResponseCard ? (
              <div className="p-4">
                <div
                  className="h-[min(62vh,520px)] rounded-xl border"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-1), #000 4%)',
                  }}
                >
                  <div className="h-full w-full flex items-center justify-center p-6">
                    <div className="max-w-md w-full rounded-xl border px-5 py-5 text-center" style={{
                      borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 56%)',
                      background: 'color-mix(in srgb, #78350f, var(--surface-1) 72%)',
                    }}>
                      <div className="mx-auto mb-3 inline-flex h-11 w-11 items-center justify-center rounded-lg border" style={{
                        borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 52%)',
                        background: 'color-mix(in srgb, #f59e0b, transparent 84%)',
                        color: 'color-mix(in srgb, #f59e0b, var(--text-strong) 20%)',
                      }}>
                        <RefreshCw className="h-5 w-5 animate-spin" />
                      </div>
                      <h3 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                        Printer is responding slowly
                      </h3>
                      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        We will keep trying to reconnect for another {printingMonitorSlowResponseGraceRemainingSec}s. If reconnection fails, please verify the network configuration and confirm the printer is online.
                      </p>
                      <div className="mt-4 mx-auto w-[78%]">
                        <div
                          className="ui-loading-track h-2.5 w-full rounded-full"
                          style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                        >
                          <div
                            className="ui-loading-indicator"
                            style={{ background: 'linear-gradient(90deg, #f59e0b, color-mix(in srgb, #f59e0b, #fde68a 28%))' }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : isPrintingMonitorSelectedPrinterOffline ? (
              <div className="p-4">
                <div
                  className="h-[min(62vh,520px)] rounded-xl border"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-1), #000 4%)',
                  }}
                >
                  <div className="h-full w-full flex items-center justify-center p-6">
                    <div className="max-w-md w-full rounded-xl border px-5 py-5 text-center" style={{
                      borderColor: 'color-mix(in srgb, #f87171, var(--border-subtle) 56%)',
                      background: 'color-mix(in srgb, #7f1d1d, var(--surface-1) 72%)',
                    }}>
                      <div className="mx-auto mb-3 inline-flex h-11 w-11 items-center justify-center rounded-lg border" style={{
                        borderColor: 'color-mix(in srgb, #f87171, var(--border-subtle) 52%)',
                        background: 'color-mix(in srgb, #f87171, transparent 84%)',
                        color: 'var(--danger)',
                      }}>
                        <AlertTriangle className="h-5 w-5" />
                      </div>
                      <h3 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                        This machine is currently offline
                      </h3>
                      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        Reconnect this printer in Network Settings, or choose a different online printer from the selector above.
                      </p>
                      <div className="mt-4 flex items-center justify-center">
                        <button
                          type="button"
                          className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                          onClick={() => {
                            setPrintingMonitorModalOpen(false);
                            openProfileSettingsModal('printer', { openNetworkSettings: true });
                          }}
                        >
                          Open Network Settings
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div
                className={`p-4 grid grid-cols-1 items-start ${printingMonitorDetailWebcamExpanded ? 'gap-y-3 lg:gap-x-0' : 'gap-3'} ${printingMonitorUsesTwoColumnDetailLayout ? 'lg:items-stretch lg:[grid-template-columns:var(--printing-monitor-detail-columns)]' : ''}`}
                style={printingMonitorUsesTwoColumnDetailLayout
                  ? ({
                      '--printing-monitor-detail-columns': printingMonitorDetailWebcamExpanded
                        ? 'minmax(0,1fr)'
                        : 'minmax(340px,1fr) minmax(420px,1fr)',
                    } as React.CSSProperties)
                  : undefined}
              >
                {!printingMonitorDetailWebcamExpanded && (
                <section
                  ref={printingMonitorLeftColumnRef}
                  className="grid gap-3 grid-rows-[auto_1fr] overflow-hidden transition-[opacity,transform] duration-140 ease-out motion-reduce:transition-none opacity-100 translate-y-0"
                >
                <div className="w-full min-w-0 max-w-full overflow-hidden rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 4%)' }}>
                  <div className={`grid min-h-[34px] items-center gap-2 px-1 ${printingMonitorHasActivePrint ? 'grid-cols-[1fr_auto]' : 'grid-cols-[1fr_auto_1fr]'}`}>
                    <div className="justify-self-start text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      {printingMonitorHasActivePrint ? 'Print Details' : 'Print Files'}
                    </div>
                    {!printingMonitorHasActivePrint && (
                      <div
                        className="relative inline-flex h-9 w-[132px] items-center rounded-lg border p-1 justify-self-center overflow-hidden"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-1), #000 12%)',
                          boxShadow: 'inset 0 1px 0 color-mix(in srgb, #ffffff, transparent 94%)',
                        }}
                        aria-label="Print file source"
                      >
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute bottom-1 left-1 top-1 rounded-md border transition-transform duration-200 ease-out"
                          style={{
                            width: 'calc(50% - 4px)',
                            transform: printingMonitorPlatesStoragePath === '/usb/' ? 'translateX(100%)' : 'translateX(0)',
                            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 32%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 78%)',
                          }}
                        />
                        <button
                          type="button"
                          className="relative z-[1] inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold tracking-[0.02em] transition-colors duration-200"
                          style={{
                            color: printingMonitorPlatesStoragePath === '/local/' ? 'var(--text-strong)' : 'var(--text-muted)',
                          }}
                          onClick={() => handlePrintingMonitorStoragePathChange('/local/')}
                          title="Show print files from local storage"
                        >
                          Local
                        </button>
                        <button
                          type="button"
                          className="relative z-[1] inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold tracking-[0.02em] transition-colors duration-200"
                          style={{
                            color: printingMonitorPlatesStoragePath === '/usb/' ? 'var(--text-strong)' : 'var(--text-muted)',
                          }}
                          onClick={() => handlePrintingMonitorStoragePathChange('/usb/')}
                          title="Show print files from USB storage"
                        >
                          USB
                        </button>
                      </div>
                    )}
                    <IconButton
                      onClick={() => {
                        void refreshPrintingMonitorRecentPlates();
                      }}
                      disabled={printingMonitorAnyActionBusy || isPrintingMonitorRecentPlatesLoading}
                      className="!p-1.5 justify-self-end"
                      title="Refresh print files"
                      aria-label="Refresh print files"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isPrintingMonitorRecentPlatesLoading ? 'animate-spin' : ''}`} />
                    </IconButton>
                  </div>
                  <div className="mt-1.5 w-full min-w-0 max-w-full rounded-md border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 6%)' }}>
                    <div className="h-[clamp(220px,30vh,320px)] w-full">
                      {printingMonitorHasActivePrint && (printingMonitorThumbnailDisplayUrl || printingMonitorThumbnailUrl) ? (
                        <div className="relative h-full w-full overflow-hidden">
                          {!isPrintingMonitorThumbnailLoaded && (
                            <div className="absolute inset-0 flex items-center justify-center px-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              <div className="w-[74%]">
                                <div
                                  className="ui-loading-track h-2.5 w-full rounded-full"
                                  style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                                >
                                  <div
                                    className="ui-loading-indicator"
                                    style={{ background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))' }}
                                  />
                                </div>
                                <div className="mt-2 text-center">Loading thumbnail…</div>
                              </div>
                            </div>
                          )}
                          <img
                            src={printingMonitorThumbnailDisplayUrl ?? printingMonitorThumbnailUrl ?? undefined}
                            alt="Active print thumbnail"
                            className="absolute inset-0 h-full w-full object-contain object-center transition-opacity duration-150"
                            style={{
                              opacity: isPrintingMonitorThumbnailLoaded ? 1 : 0,
                              maxWidth: '100%',
                              maxHeight: '100%',
                            }}
                            loading="eager"
                            decoding="async"
                            fetchPriority="high"
                          />
                        </div>
                      ) : (
                        <div className="h-full w-full min-w-0 max-w-full overflow-hidden p-2">
                          {printingMonitorRecentPlates.length > 0 ? (
                            <div className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col overflow-hidden">
                              <div className="min-h-0 w-full min-w-0 max-w-full flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar space-y-1 pr-1">
                                {printingMonitorRecentPlates.map((plate) => {
                                  return (
                                    <div
                                      key={plate.plateId}
                                      className="w-full min-w-0 overflow-hidden rounded-md border px-2 py-1.5"
                                      style={{
                                        borderColor: 'var(--border-subtle)',
                                        background: 'var(--surface-1)',
                                      }}
                                    >
                                      <div className="flex w-full min-w-0 items-center gap-3 overflow-hidden">
                                        <div className="min-w-0 basis-0 flex-1 overflow-hidden pr-3 text-left">
                                          <div className="block w-full max-w-full truncate text-[11px]" style={{ color: 'var(--text-strong)' }} title={`#${plate.plateId} • ${plate.name}`}>
                                            {`#${plate.plateId} • ${plate.name}`}
                                          </div>
                                          <div className="mt-0.5 block w-full max-w-full truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {plate.materialProfileName ?? 'Material profile unavailable'}
                                          </div>
                                          <div className="mt-0.5 block w-full max-w-full truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {`Est. ${formatPrintingMonitorEstimatedTime(plate.printTimeSec)} • ${formatPrintingMonitorUsedMaterial(plate.usedMaterialMl)}`}
                                          </div>
                                          <div className="mt-0.5 block w-full max-w-full truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {`Area Σ ${formatPrintingMonitorAreaMm2(plate.totalSolidAreaMm2)} • Min ${formatPrintingMonitorAreaMm2(plate.smallestAreaMm2)} • Max ${formatPrintingMonitorAreaMm2(plate.largestAreaMm2)}`}
                                          </div>
                                        </div>

                                        <div className="flex w-[56px] shrink-0 items-center justify-end gap-1">
                                          <IconButton
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              void handleStartMonitorRecentPlate(plate.plateId);
                                            }}
                                            className="!p-1.5"
                                            style={{
                                              borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)',
                                              background: 'color-mix(in srgb, #22c55e, var(--surface-1) 86%)',
                                              color: 'color-mix(in srgb, #22c55e, var(--text-strong) 25%)',
                                            }}
                                            title={`Start plate #${plate.plateId}`}
                                            disabled={printingMonitorAnyActionBusy || printingMonitorHasActivePrint}
                                          >
                                            <Play className="w-3.5 h-3.5" />
                                          </IconButton>
                                          <IconButton
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              void handleDeleteMonitorRecentPlate(plate.plateId);
                                            }}
                                            className="!p-1.5"
                                            style={{
                                              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                                              background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                                              color: '#fecaca',
                                            }}
                                            title={`Delete plate #${plate.plateId}`}
                                            disabled={printingMonitorAnyActionBusy}
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </IconButton>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-3 py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {isPrintingMonitorRecentPlatesLoading ? (
                                'Loading recent print files…'
                              ) : printingMonitorRecentPlatesError ? (
                                printingMonitorRecentPlatesError
                              ) : (
                                <div className="flex flex-col items-center gap-2 text-center">
                                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>No Files Found</span>
                                  <button
                                    type="button"
                                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 !text-[11px] !font-semibold inline-flex items-center justify-center gap-1"
                                    onClick={() => {
                                      void refreshPrintingMonitorRecentPlates();
                                    }}
                                    disabled={printingMonitorAnyActionBusy || isPrintingMonitorRecentPlatesLoading}
                                  >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    Refresh
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-md border p-3 space-y-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 4%)' }}>
                  <div className="flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span>{printingMonitorSnapshot?.stateText ?? 'Polling printer status…'}</span>
                    <span>
                      {isPrintingMonitorStatusRequestInFlight && isPrintingMonitorWithinSlowResponseGrace
                        ? 'Busy…'
                        : (isPrintingMonitorPolling ? 'Live' : 'Idle')}
                    </span>
                  </div>

                  {printingMonitorHasActivePrint ? (
                    <>
                      <div
                        className="h-2 w-full rounded-full border overflow-hidden"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), black 20%)',
                        }}
                      >
                        <div
                          className="h-full rounded-full transition-[width] duration-200 ease-out"
                          style={{
                            width: `${(printingMonitorDisplayProgressPct ?? 0).toFixed(2)}%`,
                            background: 'linear-gradient(90deg, #60a5fa, #22d3ee)',
                          }}
                        />
                      </div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Progress {printingMonitorDisplayProgressPct != null ? `${printingMonitorDisplayProgressPct.toFixed(1)}%` : '—'}
                      </div>
                    </>
                  ) : (
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      No active print.
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                      Layer:{' '}
                      <span style={{ color: 'var(--text-strong)' }}>
                        {printingMonitorDisplayTotalLayers != null
                          ? `${printingMonitorDisplayCurrentLayer ?? '—'}/${printingMonitorDisplayTotalLayers}`
                          : (printingMonitorDisplayCurrentLayer != null ? `${printingMonitorDisplayCurrentLayer}` : '—')}
                      </span>
                    </div>
                    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                      Material:{' '}
                      <span style={{ color: 'var(--text-strong)' }}>{printingMonitorDisplayMaterialProfile}</span>
                    </div>
                    <div
                      className="col-span-2 rounded-md border px-2.5 py-2 truncate"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                      title={printingMonitorHasActivePrint ? (printingMonitorSnapshot?.jobName ?? undefined) : undefined}
                    >
                      Job:{' '}
                      <span style={{ color: 'var(--text-strong)' }}>{printingMonitorHasActivePrint ? (printingMonitorSnapshot?.jobName ?? '—') : '—'}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className="ui-button !h-9 px-3 text-xs"
                      style={!printingMonitorPauseButtonDisabled
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 87%)',
                            color: 'var(--text-strong)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--surface-2), black 8%)',
                            color: 'var(--text-muted)',
                            opacity: 0.55,
                          }}
                      onClick={() => {
                        void handlePrintingMonitorControlAction(printingMonitorSnapshot?.isPaused ? 'resume' : 'pause');
                      }}
                      disabled={printingMonitorPauseButtonDisabled}
                    >
                      {printingMonitorPauseButtonAnimating
                        ? (
                          <span className="inline-flex items-center gap-1.5">
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            <span>
                              {printingMonitorControlPendingAction === 'resume'
                                ? 'Resuming…'
                                : printingMonitorSnapshot?.isPaused && !printingMonitorIsPauseTransition
                                  ? 'Resuming…'
                                  : 'Pausing…'}
                            </span>
                          </span>
                        )
                        : (printingMonitorSnapshot?.isPaused ? 'Resume' : 'Pause')}
                    </button>

                    <button
                      type="button"
                      className="ui-button !h-9 px-3 text-xs"
                      style={!printingMonitorCancelButtonDisabled
                        ? {
                            borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 48%)',
                            background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 88%)',
                            color: '#fde68a',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--surface-2), black 8%)',
                            color: 'var(--text-muted)',
                            opacity: 0.55,
                          }}
                      onClick={() => {
                        void handlePrintingMonitorControlAction('cancel');
                      }}
                      disabled={printingMonitorCancelButtonDisabled}
                    >
                      {printingMonitorCancelButtonAnimating
                        ? (
                          <span className="inline-flex items-center gap-1.5">
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            <span>Canceling…</span>
                          </span>
                        )
                        : 'Cancel'}
                    </button>

                    <button
                      type="button"
                      className="ui-button !h-9 px-3 text-xs col-span-2"
                      style={{
                        borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                        background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                        color: '#fee2e2',
                      }}
                      onClick={() => {
                        void handlePrintingMonitorControlAction('emergency-stop');
                      }}
                      disabled={printingMonitorEmergencyStopDisabled}
                    >
                      {(printingMonitorControlPendingAction === 'emergency-stop' || printingMonitorActionBusy === 'emergency-stop')
                        ? 'Stopping…'
                        : 'Emergency Stop'}
                    </button>
                  </div>

                </div>
                </section>
                )}

                {printingMonitorHasCamera && (
                <section
                  ref={printingMonitorWebcamSectionRef}
                  className={`rounded-md border p-2 flex flex-col min-h-0 overflow-hidden self-stretch h-[min(62vh,520px)] lg:h-full transition-opacity duration-150 ease-out motion-reduce:transition-none ${printingMonitorDetailWebcamExpanded ? 'opacity-100' : 'opacity-[0.985]'}`}
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-1), #000 4%)',
                  }}
                >
                <div className="grid min-h-[34px] grid-cols-[1fr_auto] items-center gap-2 px-1">
                  <div className="justify-self-start text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Webcam
                  </div>
                  <div className="justify-self-end inline-flex items-center gap-1.5">
                    {printingMonitorCanExpandWebcam && (
                      <IconButton
                        onClick={() => setPrintingMonitorWebcamExpanded((previous) => !previous)}
                        className="!p-1.5"
                        title={printingMonitorDetailWebcamExpanded ? 'Collapse webcam view' : 'Expand webcam view'}
                        aria-label={printingMonitorDetailWebcamExpanded ? 'Collapse webcam view' : 'Expand webcam view'}
                      >
                        {printingMonitorDetailWebcamExpanded
                          ? <Minimize2 className="w-3.5 h-3.5" />
                          : <Maximize2 className="w-3.5 h-3.5" />}
                      </IconButton>
                    )}
                    <IconButton
                      onClick={() => {
                        void handleSavePrintingMonitorWebcamSnapshot();
                      }}
                      disabled={isPrintingMonitorWebcamSnapshotSaving || !printingMonitorWebcamUrl || !isPrintingMonitorWebcamLoaded}
                      className="!p-1.5"
                      title="Save webcam snapshot"
                      aria-label="Save webcam snapshot"
                    >
                      {isPrintingMonitorWebcamSnapshotSaving
                        ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        : <Download className="w-3.5 h-3.5" />}
                    </IconButton>
                  </div>
                </div>
                {printingMonitorWebcamUrl ? (
                  <div className="mt-1.5 flex-1 min-h-0 min-w-0 flex items-center justify-center overflow-hidden">
                    {printingMonitorWebcamLoadError ? (
                      <div className="w-full max-w-full rounded-md border p-4 flex items-center justify-center h-full" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 7%)' }}>
                        <div className="text-center max-w-[520px] w-full">
                          <div
                            className="inline-flex h-12 w-12 items-center justify-center rounded-full border mb-3"
                            style={{
                              borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 30%)',
                              background: 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)',
                            }}
                          >
                            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--danger)' }} />
                          </div>

                          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                            {printingMonitorWebcamDisplayPresentation.title}
                          </h4>
                          <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                            {printingMonitorWebcamDisplayPresentation.description}
                          </p>

                          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                            {printingMonitorWebcamCanResetStreamSlot && (
                              <button
                                type="button"
                                className="ui-button ui-button-secondary !h-8 px-2.5 text-[10px]"
                                onClick={() => {
                                  void handleResetPrintingMonitorWebcamStreamSlot();
                                }}
                                disabled={isPrintingMonitorWebcamResetBusy}
                                title="Ask the printer to disable any stale webcam stream before retrying"
                              >
                                {isPrintingMonitorWebcamResetBusy ? 'Resetting stream…' : 'Reset stream slot'}
                              </button>
                            )}

                            <button
                              type="button"
                              className="ui-button ui-button-secondary !h-8 px-2.5 text-[10px]"
                              onClick={() => {
                                triggerPrintingMonitorWebcamRetry();
                              }}
                              disabled={isPrintingMonitorWebcamResetBusy}
                            >
                              Retry
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        ref={printingMonitorWebcamViewportRef}
                        className="relative rounded-md border overflow-hidden h-full max-h-full max-w-full"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-1), #000 6%)',
                          width: isPrintingMonitorWebcamLoaded ? undefined : '100%',
                          minWidth: isPrintingMonitorWebcamLoaded ? undefined : 'min(100%, 220px)',
                        }}
                      >
                        {!isPrintingMonitorWebcamLoaded && (
                          <div className="absolute inset-0 z-[1] flex items-center justify-center px-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            <div className="w-[74%]">
                              <div
                                className="ui-loading-track h-2.5 w-full rounded-full"
                                style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                              >
                                <div
                                  className="ui-loading-indicator"
                                  style={{ background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))' }}
                                />
                              </div>
                              <div className="mt-2 text-center">Loading camera feed…</div>
                            </div>
                          </div>
                        )}
                        <div className="h-full w-full min-h-0 min-w-0 flex items-center justify-center overflow-hidden">
                        <div
                          className="max-h-full max-w-full"
                          style={monitorWebcamDisplayAspectRatio != null
                            ? {
                                width: '100%',
                                height: 'auto',
                                maxWidth: '100%',
                                maxHeight: '100%',
                                aspectRatio: String(monitorWebcamDisplayAspectRatio),
                              }
                            : {
                                width: '100%',
                                height: '100%',
                                maxWidth: '100%',
                                maxHeight: '100%',
                              }}
                        >
                          {printingMonitorWebcamUsesRelayWs ? (
                            <RtspRelayCanvasPlayer
                              url={printingMonitorWebcamUrl}
                              className="block h-full w-full object-contain transition-opacity duration-150"
                              style={{
                                opacity: isPrintingMonitorWebcamLoaded ? 1 : 0,
                                transform: monitorWebcamTransform,
                                transformOrigin: 'center center',
                              }}
                              onLoaded={(ratio) => {
                                cancelPrintingMonitorWebcamReadinessCheck();
                                printingMonitorRelayAutoRetryCountRef.current = 0;
                                if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
                                  window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
                                  printingMonitorRelayAutoRetryTimeoutRef.current = null;
                                }
                                const normalizedRatio = normalizePrintingMonitorWebcamAspectRatio(ratio);
                                if (normalizedRatio != null) {
                                  setPrintingMonitorWebcamAspectRatio((previous) => {
                                    if (previous != null && Math.abs(previous - normalizedRatio) < 0.001) return previous;
                                    return normalizedRatio;
                                  });
                                }
                                setIsPrintingMonitorWebcamLoaded(true);
                                setPrintingMonitorWebcamLoadError(null);
                              }}
                              onError={(message) => {
                                cancelPrintingMonitorWebcamReadinessCheck();
                                console.warn('[Monitor/Webcam] rtsp-relay playback issue', { url: printingMonitorWebcamUrl, message });
                                const normalizedMessage = String(message ?? '').toLowerCase();
                                const isRetryableRelayError = printingMonitorWebcamUsesRelayWs && (
                                  normalizedMessage.includes('did not deliver any video data in time')
                                  || normalizedMessage.includes('websocket disconnected')
                                );
                                if (isRetryableRelayError && printingMonitorRelayAutoRetryCountRef.current < DEFAULT_RELAY_AUTORETRY_LIMIT) {
                                  printingMonitorRelayAutoRetryCountRef.current += 1;
                                  const attempt = printingMonitorRelayAutoRetryCountRef.current;
                                  setIsPrintingMonitorWebcamLoaded(false);
                                  setPrintingMonitorWebcamLoadError(`Webcam stream stalled. Retrying (${attempt}/${DEFAULT_RELAY_AUTORETRY_LIMIT})…`);
                                  if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
                                    window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
                                  }
                                  printingMonitorRelayAutoRetryTimeoutRef.current = window.setTimeout(() => {
                                    printingMonitorRelayAutoRetryTimeoutRef.current = null;
                                    triggerPrintingMonitorWebcamRetry();
                                  }, DEFAULT_RELAY_AUTORETRY_DELAY_MS);
                                  return;
                                }
                                setIsPrintingMonitorWebcamLoaded(false);
                                setPrintingMonitorWebcamLoadError(message);
                              }}
                            />
                          ) : (
                            <img
                              src={printingMonitorWebcamUrl}
                              alt="Printer webcam preview"
                              className="block h-full w-full object-contain transition-opacity duration-150"
                              style={{
                                opacity: isPrintingMonitorWebcamLoaded ? 1 : 0,
                                transform: monitorWebcamTransform,
                                transformOrigin: 'center center',
                              }}
                              onLoad={(event) => {
                                schedulePrintingMonitorMjpegReadinessCheck(event.currentTarget);
                              }}
                              onError={() => {
                                cancelPrintingMonitorWebcamReadinessCheck();
                                setIsPrintingMonitorWebcamLoaded(false);
                                setPrintingMonitorWebcamLoadError('The webcam image could not be loaded.');
                              }}
                              loading="eager"
                              decoding="async"
                              fetchPriority="high"
                            />
                          )}
                        </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-1.5 flex-1 min-h-0 rounded-md border p-4 flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 7%)' }}>
                    <div className="text-center max-w-[520px] w-full">
                      <div
                        className="inline-flex h-12 w-12 items-center justify-center rounded-full border mb-3"
                        style={printingMonitorWebcamStatusPresentation.tone === 'warning'
                            ? {
                                borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 35%)',
                                background: 'color-mix(in srgb, #d97706, var(--surface-1) 90%)',
                              }
                            : printingMonitorWebcamStatusPresentation.tone === 'error'
                              ? {
                                  borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 30%)',
                                  background: 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)',
                                }
                              : {
                                  borderColor: 'var(--border-subtle)',
                                  background: 'var(--surface-1)',
                                }}
                      >
                        {printingMonitorWebcamStatusPresentation.tone === 'warning' ? (
                          <AlertTriangle className="w-5 h-5" style={{ color: '#d97706' }} />
                        ) : printingMonitorWebcamStatusPresentation.tone === 'error' ? (
                          <AlertTriangle className="w-5 h-5" style={{ color: 'var(--danger)' }} />
                        ) : (
                          <RefreshCw className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                        )}
                      </div>

                      <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                        {printingMonitorWebcamStatusPresentation.title}
                      </h4>
                      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        {printingMonitorWebcamStatusPresentation.description}
                      </p>

                      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                      {printingMonitorWebcamCanResetStreamSlot && (
                        <button
                          type="button"
                          className="ui-button ui-button-secondary !h-8 px-2.5 text-[10px]"
                          onClick={() => {
                            void handleResetPrintingMonitorWebcamStreamSlot();
                          }}
                          disabled={isPrintingMonitorWebcamResetBusy}
                          title="Ask the printer to disable any stale webcam stream before retrying"
                        >
                          {isPrintingMonitorWebcamResetBusy ? 'Resetting stream…' : 'Reset stream slot'}
                        </button>
                      )}

                      <button
                        type="button"
                        className="ui-button ui-button-secondary !h-8 px-2.5 text-[10px]"
                        onClick={() => {
                          triggerPrintingMonitorWebcamRetry();
                        }}
                        disabled={isPrintingMonitorWebcamResetBusy}
                      >
                        Retry
                      </button>
                    </div>
                    </div>
                  </div>
                )}
                </section>
                )}
              </div>
            )}

            {isPrintingMonitorDebugOpen && (
              <div className="pointer-events-none fixed right-4 top-[5.25rem] z-[170] w-[min(760px,94vw)]">
                <div
                  className="pointer-events-auto rounded-lg border p-2.5 font-mono text-[10px] leading-tight shadow-xl"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-strong)',
                    background: 'color-mix(in srgb, var(--surface-0), black 14%)',
                    fontSize: '10px',
                  }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs font-semibold" style={{ fontFamily: 'var(--font-geist-mono)' }}>
                      Monitor Debug Overlay (Ctrl+Shift+N)
                    </div>
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        className="rounded border px-2 py-0.5 text-[10px]"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                        onClick={() => {
                          void handleCopyPrintingMonitorDebugBundle();
                        }}
                        title="Copy monitor debug bundle"
                      >
                        {printingMonitorDebugCopyState === 'copied'
                          ? 'Copied'
                          : printingMonitorDebugCopyState === 'failed'
                            ? 'Copy Failed'
                            : 'Copy JSON'}
                      </button>
                      <button
                        type="button"
                        className="rounded border px-2 py-0.5 text-[10px]"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                        onClick={() => setIsPrintingMonitorDebugOpen(false)}
                      >
                        Close
                      </button>
                    </div>
                  </div>


                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <div style={{ color: 'var(--text-muted)' }}>Printer</div>
                    <div className="truncate" title={printingMonitorHeaderBottomLabel}>
                      {printingMonitorHeaderBottomLabel}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Device host</div>
                    <div className="truncate" title={printingMonitorDebugBundle.selectedDevice?.ipAddress ?? 'n/a'}>
                      {printingMonitorDebugBundle.selectedDevice?.ipAddress ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Reachability</div>
                    <div>
                      {printingMonitorDebugBundle.selectedDevice?.reachability == null
                        ? 'unknown'
                        : (printingMonitorDebugBundle.selectedDevice.reachability ? 'online' : 'offline')}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Offline gate</div>
                    <div>{printingMonitorDebugBundle.offlineGate.isPrintingMonitorSelectedPrinterOffline ? 'true' : 'false'}</div>
                  </div>

                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Channel payloads
                    </div>
                    <div className="grid gap-2 lg:grid-cols-3">
                      {printingMonitorDebugPanels.map((panel) => (
                        <div
                          key={panel.channel}
                          className="rounded-md border overflow-hidden"
                          style={{

                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--surface-2), #000 8%)',
                          }}
                        >
                          <div
                            className="border-b px-2 py-1 text-[10px] uppercase tracking-[0.08em] flex items-center justify-between gap-2"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                          >
                            <span>{panel.channel}</span>
                            <span style={{ color: panel.hasError ? '#fca5a5' : 'var(--text-muted)' }}>
                              {panel.statusText}
                            </span>
                          </div>
                          <pre
                            className="max-h-56 overflow-auto custom-scrollbar p-2 text-[10px] leading-[1.35]"
                            style={{ color: 'var(--text-strong)' }}
                          >
                            {panel.json}
                          </pre>
                          <div
                            className="border-t px-2 py-1 text-[10px]"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                          >
                            {panel.requestedAt ?? 'not requested'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Manual SDCP commands
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || !printingMonitoringAdapter.operations?.webcamEnable}
                        onClick={() => {
                          void executePrintingMonitorFeatureToggle('webcam', true);
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 386</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Enable video stream</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || !printingMonitoringAdapter.operations?.webcamDisable}
                        onClick={() => {
                          void executePrintingMonitorFeatureToggle('webcam', false);
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 386</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Disable video stream</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || !printingMonitoringAdapter.operations?.timelapseEnable}
                        onClick={() => {
                          void executePrintingMonitorFeatureToggle('timelapse', true);
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 387</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Enable timelapse</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || !printingMonitoringAdapter.operations?.timelapseDisable}
                        onClick={() => {
                          void executePrintingMonitorFeatureToggle('timelapse', false);
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 387</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Disable timelapse</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || printingMonitoringAdapter.pluginId !== 'sdcp-v3'}
                        onClick={() => {
                          void executePrintingMonitorSdcpDebugCommand({
                            operation: 'sdcp/task/history/list',
                            label: 'Task history',
                            channel: 'taskHistory',
                          });
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 320</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Fetch task history IDs</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || printingMonitoringAdapter.pluginId !== 'sdcp-v3'}
                        onClick={() => {
                          void executePrintingMonitorSdcpDebugCommand({
                            operation: 'sdcp/task/details',
                            label: 'Task details',
                            channel: 'taskDetails',
                          });
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 321</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Fetch task detail records</div>
                      </button>
                    </div>
                    <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {printingMonitorActionStatus ?? 'Use these commands to manually toggle SDCP device features.'}
                    </div>
                  </div>

                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Last SDCP response JSON
                    </div>
                    <div
                      className="rounded-md border px-2 py-1"
                      style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), #000 8%)' }}
                    >
                      <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span className="truncate" title={printingMonitorLastFeatureToggleResponse?.operation ?? 'n/a'}>
                          {printingMonitorLastFeatureToggleResponse?.operation ?? 'No response yet'}
                        </span>
                        <span>
                          {printingMonitorLastFeatureToggleResponse
                            ? `HTTP ${printingMonitorLastFeatureToggleResponse.httpStatus ?? 'n/a'}${printingMonitorLastFeatureToggleResponse.httpOk === true ? ' • transport-ok' : printingMonitorLastFeatureToggleResponse.httpOk === false ? ' • transport-error' : ''}${printingMonitorLastFeatureToggleResponse.commandOk === true ? ' • command-ok' : printingMonitorLastFeatureToggleResponse.commandOk === false ? ' • command-error' : ''}`
                            : 'waiting'}
                        </span>
                      </div>
                      <pre
                        className="mt-1 max-h-40 overflow-auto custom-scrollbar whitespace-pre-wrap break-words rounded-sm border px-2 py-1 text-[10px] leading-[1.35]"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'var(--surface-1)',
                          color: 'var(--text-strong)',
                        }}
                      >
                        {printingMonitorLastFeatureToggleResponse
                          ? JSON.stringify({
                            httpStatus: printingMonitorLastFeatureToggleResponse.httpStatus,
                            httpOk: printingMonitorLastFeatureToggleResponse.httpOk,
                            commandOk: printingMonitorLastFeatureToggleResponse.commandOk,
                            error: printingMonitorLastFeatureToggleResponse.error,
                            payload: printingMonitorLastFeatureToggleResponse.payload,
                          }, null, 2)
                          : 'Click a command to inspect the response JSON.'}
                      </pre>
                    </div>
                  </div>

                  <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Toggle: Ctrl+Shift+N
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

            {isPrintingMonitorRtspDebugOpen && (
              <div className="pointer-events-none fixed left-4 top-[5.25rem] z-[170] w-[min(620px,94vw)]">
                <div
                  className="pointer-events-auto rounded-lg border p-2.5 font-mono text-[10px] leading-tight shadow-xl"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-strong)',
                    background: 'color-mix(in srgb, var(--surface-0), black 14%)',
                    fontSize: '10px',
                  }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs font-semibold" style={{ fontFamily: 'var(--font-geist-mono)' }}>
                      RTSP Debug Overlay (Ctrl+Shift+M)
                    </div>
                    <button
                      type="button"
                      className="rounded border px-2 py-0.5 text-[10px]"
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                      onClick={() => setIsPrintingMonitorRtspDebugOpen(false)}
                    >
                      Close
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <div style={{ color: 'var(--text-muted)' }}>Mode</div>
                    <div>{printingMonitorRtspDebugSummary.title}</div>

                    <div style={{ color: 'var(--text-muted)' }}>Source RTSP</div>
                    <div className="truncate" title={printingMonitorRtspSourceUrl ?? 'n/a'}>
                      {printingMonitorRtspSourceUrl ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Relay base</div>
                    <div className="truncate" title={printingMonitorRelayBaseWsUrl ?? 'n/a'}>
                      {printingMonitorRelayBaseWsUrl ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Final webcam URL</div>
                    <div className="truncate" title={printingMonitorWebcamUrl ?? 'n/a'}>
                      {printingMonitorWebcamUrl ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Transport path</div>
                    <div>
                      {printingMonitorWebcamUsesRelayWs
                        ? 'RTSP relay websocket'
                        : printingMonitorInlineWebcamUrl
                          ? 'Direct webcam URL'
                          : 'Unavailable'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>UDP source port</div>
                    <div>{printingMonitorRelayDebugTransport?.serverPort ?? 'n/a'}</div>

                    <div style={{ color: 'var(--text-muted)' }}>UDP destination port</div>
                    <div>{printingMonitorRelayDebugTransport?.clientPort ?? 'n/a'}</div>

                    <div className="col-span-2 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Source is the printer/server RTP port; destination is the DragonFruit/client RTP port.
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Reclaim session</div>
                    <div className="truncate" title={printingMonitorRelayReclaimDebug?.activeSessionId ?? 'n/a'}>
                      {printingMonitorRelayReclaimDebug?.activeSessionId ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Reclaim status</div>
                    <div>{printingMonitorRelayReclaimDebug?.lastClaimStatus ?? 'n/a'}</div>

                    <div style={{ color: 'var(--text-muted)' }}>Webcam status</div>
                    <div title={printingMonitorWebcamDisplayPresentation.description}>
                      {printingMonitorWebcamDisplayPresentation.title}
                    </div>
                  </div>

                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      {printingMonitorRtspDebugSummary.description}
                    </div>
                    <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Current feed note: {printingMonitorWebcamDisplayPresentation.description}
                    </div>
                    {printingMonitorRelayDebugTransport?.transportHeader && (
                      <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        Last Transport header: {printingMonitorRelayDebugTransport.transportHeader}
                      </div>
                    )}
                  </div>

                  <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Toggle: Ctrl+Shift+M
                  </div>
                </div>
              </div>
            )}

      {isExporting && (
        <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-[1px]">
          <div
            className="w-[min(520px,92vw)] rounded-xl border px-5 py-4 shadow-xl"
            style={{ background: 'color-mix(in srgb, var(--surface-0), black 10%)', borderColor: 'var(--border-subtle)' }}
            role="dialog"
            aria-modal="true"
            aria-live="polite"
          >
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Exporting…
            </div>
            <div className="mt-1 space-y-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <p>Writing mesh geometry and support data to file…</p>
            </div>
            <div className="ui-loading-track mt-3 h-2.5 w-full rounded-full" style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}>
              <div className="ui-loading-indicator" style={{ background: 'linear-gradient(90deg, var(--accent), #ff79c6)' }} />
            </div>
          </div>
        </div>
      )}

      {showArrangeBlockingOverlay && (
        <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/45 backdrop-blur-[1px]">
          <div
            className="w-[min(520px,92vw)] rounded-xl border px-5 py-4 shadow-xl"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), black 10%)',
              borderColor: 'var(--border-subtle)',
            }}
            role="dialog"
            aria-modal="true"
            aria-live="polite"
          >
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              {arrangeOverlayContent.title}
            </div>
            <div className="mt-1 space-y-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {arrangeOverlayContent.detailLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>

            <div className="mt-2 text-[11px] font-medium tracking-wide" style={{ color: 'var(--accent)' }}>
              Elapsed: {arrangeOverlayElapsedLabel}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Processing {arrangeOverlayModelCount ?? 0} {arrangeOverlayModelCount === 1 ? 'model' : 'models'}
            </div>

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

      {islandsPoc.scanning && (
        <div className="absolute inset-0 z-[121] flex items-center justify-center bg-black/45 backdrop-blur-[1px]">
          <div
            className="w-[min(520px,92vw)] rounded-xl border px-5 py-4 shadow-xl"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), black 10%)',
              borderColor: 'var(--border-subtle)',
            }}
            role="dialog"
            aria-modal="true"
            aria-live="polite"
          >
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Analyzing Model Islands & Minima
            </div>
            <div className="mt-1 space-y-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <p>Slicing and analysis in progress...</p>
              {islandsPoc.scanProgress && islandsPoc.scanProgress.total > 100 && (
                <p>
                  Layer {islandsPoc.scanProgress.done} of {islandsPoc.scanProgress.total}
                </p>
              )}
            </div>

            <div className="mt-2 text-[11px] font-medium tracking-wide" style={{ color: 'var(--accent)' }}>
              Elapsed: {islandsPoc.elapsedLabel}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Processing 1 model
            </div>

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

      {showModifierApplyBlockingOverlay && (
        <div className="absolute inset-0 z-[121] flex items-center justify-center bg-black/45 backdrop-blur-[1px]">
          <div
            className="w-[min(520px,92vw)] rounded-xl border px-5 py-4 shadow-xl"
            style={{
              background: 'color-mix(in srgb, var(--surface-0), black 10%)',
              borderColor: 'var(--border-subtle)',
            }}
            role="dialog"
            aria-modal="true"
            aria-live="polite"
          >
            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              {modifierApplyOverlayContent.title}
            </div>
            <div className="mt-1 space-y-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {modifierApplyOverlayContent.detailLines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>

            <div className="mt-2 text-[11px] font-medium tracking-wide" style={{ color: 'var(--accent)' }}>
              Elapsed: {modifierApplyOverlayElapsedLabel}
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Processing 1 model
            </div>

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

      {newDeviceToast && (
        <ToastViewport zIndex={127} offset="1.25rem">
          <Toast
            tone="warning"
            shape="rounded"
            animated
            visible={isNewDeviceToastVisible}
            className="flex items-center gap-3 max-w-sm pointer-events-auto"
          >
            <Gamepad2 className="h-4 w-4 flex-shrink-0" />
            <span className="flex-1 text-[12px] leading-snug">
              New input device detected.<br />
              <span style={{ fontWeight: 400, opacity: 0.8 }}>Go to Settings → 3D Mouse to configure or block it.</span>
            </span>
            <button
              type="button"
              onClick={() => setIsNewDeviceToastVisible(false)}
              className="flex-shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold"
              style={{ background: 'color-mix(in srgb, #f59e0b, transparent 80%)', color: 'var(--text-strong)' }}
            >
              Dismiss
            </button>
          </Toast>
        </ToastViewport>
      )}

      {isSaveToastVisible && (
        <ToastViewport zIndex={126} offset="1.25rem">
          <Toast tone="info" animated visible={isSaveToastAnimatedVisible} className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" />
            {saveToastLabel}
          </Toast>
        </ToastViewport>
      )}

      {historyActionToast && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast
            tone={historyActionToast.direction === 'undo' ? 'warning' : 'info'}
            animated
            visible={isHistoryActionToastVisible}
            className="flex items-center gap-2"
          >
            {historyActionToast.direction === 'undo' ? (
              <Undo2 className="h-4 w-4 motion-safe:animate-pulse" />
            ) : (
              <Redo2 className="h-4 w-4 motion-safe:animate-pulse" />
            )}
            {historyActionToast.text}
          </Toast>
        </ToastViewport>
      )}

      {printingMonitorErrorToast && (
        <ToastViewport
          zIndex={126}
          offset={(historyActionToast || scene.sceneImportReport) ? '4.5rem' : '1.25rem'}
        >
          <Toast
            tone="error"
            animated
            visible={isPrintingMonitorErrorToastVisible}
            className="flex items-center gap-2"
          >
            <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            {printingMonitorErrorToast.text}
          </Toast>
        </ToastViewport>
      )}

      {scene.sceneImportReport && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast
            tone={
              scene.sceneImportReport.tone === 'error'
                ? 'error'
                : scene.sceneImportReport.tone === 'warning'
                  ? 'warning'
                  : 'success'
            }
            animated
            visible={isSceneImportToastVisible}
            className={`flex items-center gap-2 ${
              scene.sceneImportReport.clickAction === 'openMeshRepairReport'
                ? 'pointer-events-auto cursor-pointer select-none'
                : ''
            }`}
            role={scene.sceneImportReport.clickAction === 'openMeshRepairReport' ? 'button' : undefined}
            tabIndex={scene.sceneImportReport.clickAction === 'openMeshRepairReport' ? 0 : undefined}
            onClick={() => {
              if (scene.sceneImportReport?.clickAction === 'openMeshRepairReport') {
                scene.openPendingMeshRepairReports();
              }
            }}
            onKeyDown={(event) => {
              if (scene.sceneImportReport?.clickAction !== 'openMeshRepairReport') {
                return;
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                scene.openPendingMeshRepairReports();
              }
            }}
          >
            {scene.sceneImportReport.tone === 'error' ? (
              <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            ) : scene.sceneImportReport.tone === 'warning' ? (
              <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {scene.sceneImportReport.text}
          </Toast>
        </ToastViewport>
      )}

      {exportSuccessToast && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast tone="success" animated visible={isExportSuccessToastVisible} className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            Saved to: {exportSuccessToast.path}
          </Toast>
        </ToastViewport>
      )}

      {exportErrorToast && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast tone="error" animated visible={isExportErrorToastVisible} className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            {exportErrorToast.text}
          </Toast>
        </ToastViewport>
      )}

      {sproutParentingLockHeld && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast tone="info" visible={true} className="flex items-center gap-2">
            {stage === 'awaitingSproutTip'
              ? "Leaf Fanning Active: Click model to sprout leaf"
              : "Leaf Fanning: Click a support shaft to lock anchor knot"}
          </Toast>
        </ToastViewport>
      )}

    </div>
  );
}
