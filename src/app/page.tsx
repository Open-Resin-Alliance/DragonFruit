'use client';

import React, { useEffect, useRef, useState } from 'react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import type { MessageDescriptor } from '@lingui/core';
import { detectIsIOS } from '@/hooks/usePlatform';
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, Gamepad2, LayoutGrid, Loader2, Maximize2, Minimize2, Play, Plus, Printer, Redo2, RefreshCw, Trash2, Undo2, Wrench, X } from 'lucide-react';
import { SceneCanvas } from '@/components/scene/SceneCanvas';
import { SceneOverlays } from '@/components/organisms/scene/SceneOverlays';
import { FloatingPanelStack } from '@/components/layout/FloatingPanelStack';
import { PreparePanelStack } from '@/components/organisms/panels/PreparePanelStack';
import { AnalysisPanelStack } from '@/components/organisms/panels/AnalysisPanelStack';
import { ExportPanelStack } from '@/components/organisms/panels/ExportPanelStack';
import { PrintingPanelStack } from '@/components/organisms/panels/PrintingPanelStack';
import { SharedPanelStack } from '@/components/organisms/panels/SharedPanelStack';
import { TopBar } from '@/components/layout/TopBar';
import { NotificationStack } from '@/components/organisms/NotificationStack';
import { EditorLayout } from '@/components/templates/EditorLayout';
import { PrintingPreviewPane } from '@/components/organisms/PrintingPreviewPane';
import { DiagnosticsModals } from '@/components/organisms/modals/DiagnosticsModals';
import { PrintingModals } from '@/components/organisms/modals/PrintingModals';
import { SceneFileModals } from '@/components/organisms/modals/SceneFileModals';
import { ModifierModals } from '@/components/organisms/modals/ModifierModals';
import { MeshRepairModals } from '@/components/organisms/modals/MeshRepairModals';
import { useMirrorManager } from '@/features/mirror/useMirrorManager';
import { useArrangeManager } from '@/features/scene/arrange/useArrangeManager';
import { useHolePunchManager } from '@/features/hole-punching/useHolePunchManager';
import { useHollowingManager } from '@/features/hollowing/useHollowingManager';
import type { HollowingManagerDeps } from '@/features/hollowing/useHollowingManager';
import { useModifierApplyOverlay } from '@/features/hollowing/useModifierApplyOverlay';
import { useImportExportManager } from '@/features/import-export/useImportExportManager';
import type { ImportExportManagerDeps } from '@/features/import-export/useImportExportManager';
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
import { usePrintingPreviewManager, type PrintingPreviewManagerDeps } from '@/features/printing/usePrintingPreviewManager';
import { useEditorToasts } from '@/features/notifications/useEditorToasts';
import { SliceMetricsDebugModal } from '@/features/slicing/components/SliceMetricsDebugModal';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { MeshSmoothingBrushCursor } from '@/features/mesh-smoothing/MeshSmoothingBrushCursor';
import { HollowingPanel, type HollowingPanelState } from '../features/hollowing';
import { HolePunchPanel, type HolePunchPanelState } from '../features/hole-punching/HolePunchPanel';
import { PlaceOnFaceTool } from '@/features/placeOnFace/PlaceOnFaceTool';
import { MirrorTool } from '@/features/mirror/MirrorTool';
import { bakeWithFlips } from '@/features/mirror/logic/bakeWithFlips';
import { buildMirrorSupportTransforms, reflectTransformAcrossWorldAxis } from '@/features/mirror/logic/buildMirrorSupportTransforms';
import type { MirrorAxis } from '@/features/mirror/types';
import type { GeometryWithBounds } from '@/hooks/useStlGeometry';
import { RtspRelayCanvasPlayer } from '@/components/monitoring/RtspRelayCanvasPlayer';
import { IconButton, Toast, ToastViewport } from '@/components/atoms';
import { EditorContextMenu, type EditorMenuAction } from '@/components/ui/EditorContextMenu';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { quaternionFromGlobalEuler } from '@/utils/rotation';
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
import { bytesToBase64, base64ToBytes } from '@/utils/base64';
import { snapshotGeometryPositions, geometryFromSnapshot } from '@/utils/geometrySnapshot';
import {
  getDirectionScaleFactor,
  getRadialScaleFactor,
  getUniformScaleFactorForThickness,
  worldMmToLocalMm,
  computeVoxelResolution,
} from '@/utils/geometryScaling';
import { serializeHollowingModifier } from '@/features/hollowing/hollowingSerialize';
import type {
  HollowPreviewState,
  HollowPreviewCacheEntry,
  HollowingSourceEntry,
  CavityGeometryEntry,
} from '@/features/hollowing/hollowingPreviewTypes';
import {
  createHolePunchWorldFrame,
  cloneHolePunchWorldFrame,
  inferOpenFaceFromHit,
  type HolePunchWorldFrame,
  type HolePunchPlacementState,
} from '@/features/hole-punching/holePunchGeometry';
import {
  toPersistedHolePunchPlacements,
  fromPersistedHolePunchPlacements,
  serializeHolePunchPlacements,
  serializeSingleHolePunchPlacement,
} from '@/features/hole-punching/holePunchPersistence';
import {
  createGeometryFromPreviewPositions,
  disposeHollowPreviewCacheEntry,
  disposeHollowPreviewGeometryIfUncached,
} from '@/features/hollowing/hollowingPreviewCache';
import {
  formatPrintingMonitorEstimatedTime,
  formatPrintingMonitorUsedMaterial,
  formatPrintingMonitorAreaMm2,
  parsePrintingMonitorSeconds,
  parsePrintingMonitorMaterialMl,
  parsePrintingMonitorAreaMm2,
  normalizePrintingMonitorWebcamAspectRatio,
  resolvePrintingMonitorAbsoluteUrl,
} from '@/features/printing/printingMonitorFormat';
import { usePrintingMonitorManager } from '@/features/printing/usePrintingMonitorManager';
import {
  readJsonObject,
  readBooleanField,
  readStringField,
  readNumberField,
} from '@/utils/jsonFields';
import {
  PRINTING_MONITOR_DEBUG_CHANNELS,
  type FleetUploadMaterialOption,
  type PrintingMonitorRecentPlate,
  type PrintingMonitorPendingConfirmation,
  type PrintingMonitorDebugChannelState,
  type PrintingMonitorDebugState,
  type PrintingMonitorFeatureToggleResponse,
  type PrintingMonitorDebugChannel,
} from '@/features/printing/printingMonitorTypes';
import {
  EMPTY_HOME_SUPPORT_COLLECTIONS_SNAPSHOT,
  EMPTY_HOME_KICKSTAND_COLLECTIONS_SNAPSHOT,
  getHomeSupportCollectionsSnapshot,
  getHomeKickstandCollectionsSnapshot,
  type HomeSupportCollectionsSnapshot,
  type HomeKickstandCollectionsSnapshot,
} from '@/features/supports/supportSnapshotHelpers';
import {
  EXPORT_THUMBNAIL_RENDER_OPTIONS_STORAGE_KEY,
  DEFAULT_EXPORT_THUMBNAIL_RENDER_OPTIONS,
  resolveInitialExportThumbnailRenderOptions,
  type ExportThumbnailRenderOptions,
} from '@/features/export/exportThumbnailOptions';
import {
  PLUGIN_IMPORT_WARNING_DISMISSED_STORAGE_KEY,
  getFileExtension,
  getFileNameFromPath,
  isDragonfruitTempArtifactPath,
  isSupportedPrepareDropName,
  getDroppedFileMimeType,
  isSceneFileName,
  normalizeActiveVoxlScenePath,
  extractTauriDroppedPaths,
  isLikelyFileDragPayload,
  getPrepareDropSupportStateFromDataTransfer,
  buildDroppedFilesSignature,
  type LaunchSceneFileEntry,
  type SceneFileHandoffPayload,
} from '@/features/import-export/fileHandling';
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
import { resolveOutputFileExtension } from '@/features/slicing/formats/registry';
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
import { addRoot, addStick, addTrunk, beginSupportStateBatch, endSupportStateBatch, subscribe as subscribeSupportState, getSnapshot as getSupportSnapshot, setSnapshot as setSupportSnapshot, toggleSegmentCurve, transformSupportsForModel, updateTrunk, updateBranch, updateTwig, updateStick } from '@/supports/state';
import { buildAutoBracedSnapshot } from '@/supports/autoBracing/autoBrace';
import { getSettings as getSupportSettings } from '@/supports/Settings/state';
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
import { clearSDFCacheForMesh } from '@/supports/PlacementLogic/Pathfinding';
import {
  createIslandSupportMesh,
  disposeIslandSupportMesh,
} from '@/supports/autoSupport/islandSupportSurface';
import { routeRepairSupports, runAutoSupportPlan } from '@/supports/autoSupport/autoSupportRunner';
import { createAutoSupportRouteWorker, extractRouteWorkerMeshPayload, type AutoSupportPipelineWorker } from '@/supports/autoSupport/workerRouter';
import { cancelIslandScanNative } from '@/volumeAnalysis/IslandScan/nativeIslandScan';
import { AUTO_SUPPORT_PRESETS } from '@/supports/autoSupport/presets';
import { collectSupportGeometry, collectSupportSegments, contactWeldGroup, distanceToSegmentSq, evaluateCoverageScan, plannedContactPoints, plannedSupportGroup } from '@/supports/autoSupport/verifyCoverage';
import { buildScopedSupportGeometryGroup } from '@/features/export/logic/supportExportReconstruction';
import type { AutoSupportPlanPreview, AutoSupportPreset, AutoSupportProgress } from '@/supports/autoSupport/types';

import { type MeshShaderType } from '@/features/shaders/mesh';
import type { ModelTransform, TransformMode } from '@/hooks/useModelTransform';
import { useSceneAutosave, suppressSceneAutosave } from '@/hooks/useSceneAutosave';
import { SceneAutosaveRecoveryModal } from '@/components/scene/SceneAutosaveRecoveryModal';
import { MeshRepairReportModal } from '@/components/scene/MeshRepairReportModal';
import { MeshRepairConfirmModal } from '@/components/scene/MeshRepairConfirmModal';

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

type PendingModifierResetAction = 'hollowing' | 'hole_punch' | 'clear_hollowing';

const EMPTY_SUPPORT_BOUNDS_BY_MODEL_ID = new Map<string, THREE.Box3>();

function countRecordEntries(record: Record<string, unknown>): number {
  let count = 0;
  for (const _key in record) {
    count += 1;
  }
  return count;
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

const HOLE_PUNCH_OUTSIDE_PROTRUSION_MM = 3;
const HOLE_PUNCH_DEPTH_OFFSET_FROM_SHELL_MM = 1;
const HOLE_PUNCH_AUTO_DEPTH_RAY_START_OFFSET_MM = 0.3;
const HOLE_PUNCH_AUTO_DEPTH_MIN_INSIDE_MM = 1;
const HOLLOW_PREVIEW_DEBOUNCE_MS = 90;

function getDefaultHolePunchDepthMm(shellThicknessMm: number): number {
  return Number(
    Math.min(120, Math.max(1, shellThicknessMm + HOLE_PUNCH_DEPTH_OFFSET_FROM_SHELL_MM)).toFixed(1),
  );
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

const COLD_START_SCENE_HANDOFF_DELAY_MS = 1150;
const REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY = 'dragonfruit.slicing.remoteOfflineLayerHeightMm';
const REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT = 'dragonfruit:slicing-remote-offline-layer-height-changed';
const SUPPORT_DRAG_HOLD_FALLBACK_MS = 320;
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

  // --- Hollowing manager: placed early so its state/setters are in scope for
  //     useHolePunchManager below. Late/cross deps supplied via a ref populated
  //     after the hole-punch manager and shared callbacks exist (TDZ break). ---
  const hollowingDepsRef = React.useRef<HollowingManagerDeps>({
    showOperationError: () => {},
    setShowDamagedModelDialog: () => {},
    beginFinalizing: () => {},
    clearFinalizing: () => {},
    nextPaint: async () => {},
    persistActiveModelModifiers: () => {},
    setPendingModifierResetAction: () => {},
    setInteriorView: () => {},
    setSessionShaderOverride: () => {},
    computeAutoHolePunchDepthMmForGeometry: () => 0,
    setHolePunchState: () => {},
    setHolePunchPlacements: () => {},
    holePunchPlacementsRef: { current: [] },
    setPendingHolePunchAutoApplyModelId: () => {},
    setPendingBlockerResetState: () => {},
    setSelectedHolePunchPlacementIds: () => {},
    setHoveredHolePunchPlacementId: () => {},
    setHolePunchHoverPlacement: () => {},
    interiorView: false,
  });
  const hollowing = useHollowingManager({
    scene,
    transformMgr,
    deps: hollowingDepsRef,
  });
  const {
    isPreviewingHollowing,
    setIsPreviewingHollowing,
    hollowPreview,
    setHollowPreview,
    hollowingState,
    setHollowingState,
    isShellOpenFaceSelected,
    setIsShellOpenFaceSelected,
    hollowingDraftEnabled,
    setHollowingDraftEnabled,
    hollowingEditMode,
    setHollowingEditMode,
    blockedHollowVoxelIndices,
    setBlockedHollowVoxelIndices,
    editingBlockedHollowVoxelIndices,
    setEditingBlockedHollowVoxelIndices,
    isApplyingBlockersHollowing,
    setIsApplyingBlockersHollowing,
    isApplyingHollowing,
    setIsApplyingHollowing,
    editingBlockedHollowVoxelIndicesRef,
    hollowVoxelEditUndoStackRef,
    hollowVoxelEditRedoStackRef,
    hollowingEditModeRef,
    hollowPreviewDebounceTimerRef,
    hollowPreviewRequestSeqRef,
    hollowPreviewResultCacheRef,
    hollowPreviewWarmupKeyRef,
    hollowingSourceByModelIdRef,
    cavityGeometryByModelIdRef,
    defaultHollowingState,
    isHollowingApplied,
    persistedHollowingSignature,
    draftHollowingSignature,
    isShellFaceSelectionPending,
    isHollowingDirty,
    canResetHollowing,
    blockedHollowVoxelIndexSet,
    editingBlockedHollowVoxelIndexSet,
    blockedPreviewVoxelInstanceIdSet,
    handleApplyHollowing,
    handleResetHollowing,
    handleClearAppliedHollowing,
    handleResetHollowingSettings,
    handleHollowingStateChange,
    applyEditingBlockedHollowVoxelIndices,
    undoHollowVoxelEdit,
    redoHollowVoxelEdit,
    commitBlockedHollowVoxelIndices,
    toggleBlockedHollowVoxelIndex,
    requestResetHollowing,
    requestClearAppliedHollowing,
    clearPendingHollowPreviewDebounce,
    buildHollowPreviewRequest,
    cacheHollowPreviewResult,
    materializeHollowPreviewCacheEntry,
    primeHollowPreviewCache,
    runHollowPreview,
    clearHollowPreview,
    resolveBlockedHollowVoxelMarqueeSelection,
    handleBlockedHollowVoxelMarqueeSelection,
    handleStartHollowVoxelEditing,
    handleClearHollowVoxelEditing,
    handleDoneHollowVoxelEditing,
  } = hollowing;

  // Ref for supports group (used for export)
  const supportsRef = React.useRef<THREE.Group | null>(null);
  // Hide support geometry in hollowing mode — it just gets in the way.
  React.useEffect(() => {
    const hidden = scene.mode === 'prepare' && transformMgr.transformMode === 'hollowing';
    if (supportsRef.current) supportsRef.current.visible = !hidden;
  }, [scene.mode, transformMgr.transformMode]);
  // Ref for the drag-wrapper group around supports/rafts (live gizmo transform)
  const supportDragGroupRef = React.useRef<THREE.Group | null>(null);
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
  const [isSceneSaveInProgress, setIsSceneSaveInProgress] = React.useState(false);
  const [isPreSliceSceneSaveInProgress, setIsPreSliceSceneSaveInProgress] = React.useState(false);
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

  // Editor toast/notification subsystem (state, refs, fade/show effects,
  // helpers). Triggers stay in Home and call these returned setters; the
  // save-toast machinery effect reads save-progress externals injected here.
  const {
    historyActionToast,
    setHistoryActionToast,
    isHistoryActionToastVisible,
    setIsHistoryActionToastVisible,
    isSceneImportToastVisible,
    setIsSceneImportToastVisible,
    exportSuccessToast,
    setExportSuccessToast,
    isExportSuccessToastVisible,
    setIsExportSuccessToastVisible,
    exportErrorToast,
    setExportErrorToast,
    isExportErrorToastVisible,
    setIsExportErrorToastVisible,
    isSaveToastVisible,
    setIsSaveToastVisible,
    isSaveToastAnimatedVisible,
    setIsSaveToastAnimatedVisible,
    saveToastLabel,
    setSaveToastLabel,
    historyActionToastFadeTimeoutRef,
    historyActionToastClearTimeoutRef,
    printingMonitorErrorToastFadeTimeoutRef,
    printingMonitorErrorToastClearTimeoutRef,
    sceneImportToastFadeTimeoutRef,
    exportSuccessToastFadeTimeoutRef,
    exportErrorToastFadeTimeoutRef,
    saveToastHideTimeoutRef,
    saveToastClearTimeoutRef,
    saveToastEnterRafRef,
    saveToastShownAtRef,
    printingMonitorErrorToast,
    setPrintingMonitorErrorToast,
    isPrintingMonitorErrorToastVisible,
    setIsPrintingMonitorErrorToastVisible,
    lastPrintingMonitorErrorToastRef,
    clearPrintingMonitorErrorToastTimeouts,
    normalizePrintingMonitorErrorMessage,
    setPrintingMonitorError,
    handleExportSuccess,
    showOperationError,
  } = useEditorToasts({
    isSceneSaveInProgress,
    isPreSliceSceneSaveInProgress,
    isAutosaving,
    sceneImportReport: scene.sceneImportReport,
  });

  const [sessionShaderOverride, setSessionShaderOverride] = React.useState<MeshShaderType | null>(null);
  const [interiorView, setInteriorView] = React.useState(false);
  const isSupportSpotlightHoldActive = useActionActive('SUPPORTS', 'TEMP_SPOTLIGHT_HOLD');
  const [allowPrepareWithoutPrinter, setAllowPrepareWithoutPrinter] = React.useState(false);
  const [prepareSmoothingSettingsExpanded, setPrepareSmoothingSettingsExpanded] = React.useState(true);
  const [selectedHolePunchPlacementIds, setSelectedHolePunchPlacementIds] = React.useState<string[]>([]);
  const [hoveredHolePunchPlacementId, setHoveredHolePunchPlacementId] = React.useState<string | null>(null);
  const [holePunchHoverPlacement, setHolePunchHoverPlacement] = React.useState<HolePunchPlacementState | null>(null);
  const [isApplyingHolePunch, setIsApplyingHolePunch] = React.useState(false);
  const [pendingHolePunchAutoApplyModelId, setPendingHolePunchAutoApplyModelId] = React.useState<string | null>(null);
  const {
    isFinalizing,
    beginFinalizing,
    clearFinalizing,
    finalizingOverlayContent,
    nextPaint,
  } = useModifierApplyOverlay({
    hasPendingBackgroundGeometryWork: scene.hasPendingBackgroundGeometryWork,
    isApplyingHollowing,
    isApplyingHolePunch,
    pendingHolePunchAutoApplyModelId,
  });
  const [pendingModifierResetAction, setPendingModifierResetAction] = React.useState<PendingModifierResetAction | null>(null);
  const [pendingBlockerResetState, setPendingBlockerResetState] = React.useState<HollowingPanelState | null>(null);
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


  const [isHistoryDebugOpen, setIsHistoryDebugOpen] = React.useState(false);
  const [supportsInfoModelId, setSupportsInfoModelId] = React.useState<string | null>(null);
  const [isTransformDebugOverlayOpen, setIsTransformDebugOverlayOpen] = React.useState(false);

  const [transformDebugTick, setTransformDebugTick] = React.useState(0);
  const [supportShaftHoverDebug, setSupportShaftHoverDebug] = React.useState<ShaftHoverDebugDetail>({
    segmentId: null,
    point: null,
  });
  const [printingLayerPreviewUrls, setPrintingLayerPreviewUrls] = React.useState<Array<string | null>>([]);
  const printingLayerPreviewLoadInFlightRef = React.useRef<Set<number>>(new Set());

  const [printingPreviewTotalLayers, setPrintingPreviewTotalLayers] = React.useState(0);

  const printingPreviewDepsRef = React.useRef<PrintingPreviewManagerDeps>({
    printingPreviewTargetResolution: null,
  });
  const {
    printingSelectedLayer,
    setPrintingSelectedLayer,
    printingDisplayedLayer,
    setPrintingDisplayedLayer,
    isPrintingLayerScrubbing,
    setIsPrintingLayerScrubbing,
    printingPngLoadedUrl,
    setPrintingPngLoadedUrl,
    isSceneLayerScrubbing,
    setIsSceneLayerScrubbing,
    isPrintingPreviewSettled,
    setIsPrintingPreviewSettled,
    isPrintingSettledCanvasReady,
    setIsPrintingSettledCanvasReady,
    printingPreviewZoom,
    setPrintingPreviewZoom,
    printingPreviewPan,
    setPrintingPreviewPan,
    isPrintingPreviewPanning,
    setIsPrintingPreviewPanning,
    printingPreviewViewportRef,
    printingPreviewCanvasRef,
    printingPreviewSettleTimeoutRef,
    printingPreviewSettledRef,
    printingPreviewCanvasRenderNonceRef,
    printingPreviewLoadNonceRef,
    pendingPrintingSelectedLayerRef,
    printingSelectedLayerRafRef,
    printingSelectedLayerRef,
    printingPreviewZoomRef,
    printingPreviewPanRef,
    printingPreviewPanPendingRef,
    printingPreviewPanRafRef,
    printingPreviewDragRef,
    schedulePrintingPreviewSettle,
    queuePrintingPreviewPan,
    clampPrintingPreviewPan,
    clampPrintingLayer,
    handlePrintingLayerChange,
    handlePrintingLayerScrubStart,
    handlePrintingLayerScrubEnd,
    handleSceneLayerScrubStart,
    handleSceneLayerScrubEnd,
    handlePrintingPreviewWheel,
    handlePrintingPreviewPointerDown,
    handlePrintingPreviewPointerMove,
    handlePrintingPreviewPointerEnd,
    selectedPrintingLayerPreviewUrl,
    isPrintingPngLoaded,
    shouldShowScrubPreview,
    printingPreviewPngUrlForDisplay,
    printingPreviewDeMirrorTransform,
    printingPreviewMirrorScale,
    isPrintingPreviewLowResActive,
    printingPreviewScrubQualityScale,
    printingPreviewScrubUpscaleTransform,
    printingPreviewVisualTransform,
    printingPreviewCursor,
    usePrintingSettledHiResCanvas,
  } = usePrintingPreviewManager({
    scene,
    activePrinterProfile,
    printingPreviewTotalLayers,
    printingLayerPreviewUrls,
    deps: printingPreviewDepsRef,
  });


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
  const [exportThumbnailRenderOptions, setExportThumbnailRenderOptions] = React.useState<ExportThumbnailRenderOptions>(resolveInitialExportThumbnailRenderOptions);
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
  const [preSlicePrintConfirmOpen, setPreSlicePrintConfirmOpen] = React.useState(false);

  const topbarPrinterOfflineCacheByDeviceIdRef = React.useRef<Record<string, boolean>>({});
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

  // ── Import / drag-drop / scene-handoff + export-thumbnail capture ──────────
  //   Extracted to useImportExportManager. Late/cross-domain deps (isDesktopRuntime,
  //   slicing layer access, select-all model state) are supplied via a ref populated
  //   AFTER those values exist below (TDZ break, mirrors the hollowing manager).
  const importExportDepsRef = React.useRef<ImportExportManagerDeps>({
    isDesktopRuntime: () => false,
    slicing: { layerIndex: 0, setLayerIndex: () => {} },
    isSelectAllModelsActive: false,
    setIsSelectAllModelsActive: () => {},
  });
  const importExport = useImportExportManager({
    scene,
    importSceneFile,
    importSceneFiles,
    recentOpenedFiles,
    reopenRecentOpenedFile,
    maybeConfirmPluginImportWarning,
    markSceneSaveBaseline,
    setActiveSceneFilePath,
    setLoadedSceneSaveSource,
    sceneImportAutosaveSuppressMs,
    deps: importExportDepsRef,
  });
  const {
    isPrepareDragActive,
    setIsPrepareDragActive,
    isPrepareDragUnsupported,
    setIsPrepareDragUnsupported,
    exportThumbnailCaptureRunnerRef,
    handleRegisterExportThumbnailCapture,
    captureExportThumbnailPng,
    runExportThumbnailCapture,
    zipPickerState,
    setZipPickerState,
    zipPickerResolveRef,
    nativePickerPreparationState,
    setNativePickerPreparationState,
    pendingStartupSceneHandoff,
    setPendingStartupSceneHandoff,
    handleTopBarOpenScene,
    handleImportSceneInputChange,
    handleLoadMeshChangeWithZip,
    handleImportSceneChangeWithZip,
    handleReopenRecentFile,
    handleOpenMeshDialog,
    handleOpenSceneDialog,
    importSceneFilesWithPluginWarning,
    handleDroppedPrepareFiles,
    handlePrepareDragEnter,
    handlePrepareDragOver,
    handlePrepareDragLeave,
    handlePrepareDrop,
  } = importExport;

  const [isExporting, setIsExporting] = React.useState(false);
  const showModifierApplyBlockingOverlay = isApplyingHollowing || isApplyingHolePunch || isApplyingBlockersHollowing || pendingHolePunchAutoApplyModelId !== null || isFinalizing;
  const [modifierApplyOverlayElapsedSec, setModifierApplyOverlayElapsedSec] = React.useState(0);


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

    if (finalizingOverlayContent) return finalizingOverlayContent;

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
  }, [finalizingOverlayContent, isApplyingBlockersHollowing, isApplyingHolePunch, isApplyingHollowing, pendingHolePunchAutoApplyModelId]);


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

  const modifierApplyOverlayElapsedLabel = React.useMemo(() => {
    const total = Math.max(0, modifierApplyOverlayElapsedSec);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, [modifierApplyOverlayElapsedSec]);
  const [supportRenderRefreshNonce, setSupportRenderRefreshNonce] = React.useState(0);
  const [gizmoResetNonce, setGizmoResetNonce] = React.useState(0);
  const [pendingDestructiveTransform, setPendingDestructiveTransform] = React.useState<{
    modelId: string;
    modelName: string;
    supportCount: number;
    operationLabel: string;
  } | null>(null);
  const pendingDestructiveTransformContinueRef = React.useRef<(() => void) | null>(null);
  const desktopWindowRevealRequestedRef = React.useRef(false);

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
  const modelStatsCardContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [modelStatsBottomClearancePx, setModelStatsBottomClearancePx] = React.useState(220);
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

  printingPreviewDepsRef.current.printingPreviewTargetResolution = printingPreviewTargetResolution;

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
    return `${printingEstimatedResinMl.toFixed(2)} ml`;
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
    if (hours > 0) return _(msg({ message: `~${hours} h ${mins} min`, comment: 'Approximate estimated print time (the "~" marks it as a rough estimate). {hours}/{mins} are whole-number quantities.' }));
    return _(msg({ message: `~${mins} min`, comment: 'Approximate estimated print time under an hour (the "~" marks it as a rough estimate).' }));
  }, [_, activeMaterialProfile, printingPreviewTotalLayers]);

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

  // Printing-monitor domain (webcam/device/plates/upload/dashboard/debug/relay) — see usePrintingMonitorManager.
  const {
    printingTargetPickerOpen,
    setPrintingTargetPickerOpen,
    printingTargetPickerMode,
    setPrintingTargetPickerMode,
    printingTargetDeviceId,
    setPrintingTargetDeviceId,
    printingTargetMaterialId,
    setPrintingTargetMaterialId,
    printingTargetMaterialOptions,
    setPrintingTargetMaterialOptions,
    isPrintingTargetMaterialsLoading,
    setIsPrintingTargetMaterialsLoading,
    printingTargetMaterialError,
    setPrintingTargetMaterialError,
    printingTargetMaterialsCacheRef,
    printingMonitorSnapshot,
    setPrintingMonitorSnapshot,
    printingMonitorWebcamInfo,
    setPrintingMonitorWebcamInfo,
    printingMonitorRelayBaseWsUrl,
    setPrintingMonitorRelayBaseWsUrl,
    printingMonitorRelaySetupError,
    setPrintingMonitorRelaySetupError,
    printingMonitorRelayDebugTransport,
    setPrintingMonitorRelayDebugTransport,
    printingMonitorRelayReclaimDebug,
    setPrintingMonitorRelayReclaimDebug,
    isPrintingMonitorThumbnailLoaded,
    setIsPrintingMonitorThumbnailLoaded,
    printingMonitorThumbnailDisplayUrl,
    setPrintingMonitorThumbnailDisplayUrl,
    isPrintingMonitorWebcamLoaded,
    setIsPrintingMonitorWebcamLoaded,
    printingMonitorWebcamLoadError,
    setPrintingMonitorWebcamLoadError,
    printingMonitorWebcamAspectRatio,
    setPrintingMonitorWebcamAspectRatio,
    printingMonitorWebcamRefreshNonce,
    setPrintingMonitorWebcamRefreshNonce,
    isPrintingMonitorWebcamResetBusy,
    setIsPrintingMonitorWebcamResetBusy,
    isPrintingMonitorWebcamSnapshotSaving,
    setIsPrintingMonitorWebcamSnapshotSaving,
    printingMonitorWebcamExpanded,
    setPrintingMonitorWebcamExpanded,
    printingMonitorRecentPlates,
    setPrintingMonitorRecentPlates,
    isPrintingMonitorRecentPlatesLoading,
    setIsPrintingMonitorRecentPlatesLoading,
    printingMonitorRecentPlatesError,
    setPrintingMonitorRecentPlatesError,
    printingMonitorPlatesStoragePath,
    setPrintingMonitorPlatesStoragePath,
    printingMonitorSelectedPlateId,
    setPrintingMonitorSelectedPlateId,
    isPrintingMonitorPolling,
    setIsPrintingMonitorPolling,
    isPrintingMonitorStatusRequestInFlight,
    setIsPrintingMonitorStatusRequestInFlight,
    printingMonitorLastStatusSuccessAtMs,
    setPrintingMonitorLastStatusSuccessAtMs,
    printingMonitorNowEpochMs,
    setPrintingMonitorNowEpochMs,
    printingMonitorActionBusy,
    setPrintingMonitorActionBusy,
    printingMonitorControlPendingAction,
    setPrintingMonitorControlPendingAction,
    printingMonitorActionStatus,
    setPrintingMonitorActionStatus,
    printingMonitorPendingConfirmation,
    setPrintingMonitorPendingConfirmation,
    printingMonitorDeviceId,
    setPrintingMonitorDeviceId,
    printingMonitorViewMode,
    setPrintingMonitorViewMode,
    printingMonitorDashboardSnapshots,
    setPrintingMonitorDashboardSnapshots,
    isPrintingMonitorDashboardRefreshing,
    setIsPrintingMonitorDashboardRefreshing,
    isPrintingMonitorPrinterMenuOpen,
    setIsPrintingMonitorPrinterMenuOpen,
    isPrintingMonitorPrinterThumbnailFailed,
    setIsPrintingMonitorPrinterThumbnailFailed,
    printingMonitorModalOpen,
    setPrintingMonitorModalOpen,
    isPrintingMonitorDebugOpen,
    setIsPrintingMonitorDebugOpen,
    isPrintingMonitorRtspDebugOpen,
    setIsPrintingMonitorRtspDebugOpen,
    printingMonitorDebugCopyState,
    setPrintingMonitorDebugCopyState,
    printingMonitorLastFeatureToggleResponse,
    setPrintingMonitorLastFeatureToggleResponse,
    printingMonitorDebugState,
    setPrintingMonitorDebugState,
    printingMonitorPrinterMenuRef,
    printingMonitorWebcamViewportRef,
    printingMonitorThumbnailCacheRef,
    printingMonitorWebcamRequestInFlightRef,
    printingMonitorWebcamBusyUntilEpochMsRef,
    printingMonitorWebcamAutoPollBlockedRef,
    printingMonitorWebcamConsecutiveTimeoutsRef,
    printingMonitorRelayAutoRetryCountRef,
    printingMonitorRelayAutoRetryTimeoutRef,
    printingMonitorWebcamReadinessTokenRef,
    printingMonitorWebcamReadinessTimeoutRef,
    printingMonitorStartFocusDeviceIdRef,
    printingMonitorRecentPlatesRequestIdRef,
    printingMonitorRecentPlatesRef,
    printingMonitorSelectedPlateIdRef,
    printingMonitorRecentPlatesCacheRef,
    printingMonitorLeftColumnRef,
    printingMonitorWebcamSectionRef,
    printingMonitorWebcamFollowerHeightPxRef,
    monitorReachabilityInconclusiveCountsRef,
    selectedPrinterMonitorSnapshot,
    setSelectedPrinterMonitorSnapshot,
    printingMonitoringAdapter,
    printingTargetDevice,
    monitorSelectableDevices,
    dashboardMonitorDevices,
    dashboardOnlineMonitorDevices,
    monitoringDevice,
    monitoringDeviceId,
    monitoringDeviceHost,
    monitoringDevicePort,
    monitoringDeviceMainboardId,
    printingMonitorRecentPlatesCacheKey,
    printingTargetMaterialGroups,
    requiresRemoteMaterialSelectionForUpload,
    isPreSliceTargetPicker,
    printingMonitorPlateId,
    printingMonitorThumbnailUrl,
    printingMonitorThumbnailCacheKey,
    printingMonitorInlineWebcamUrl,
    printingMonitorRtspSourceUrl,
    printingMonitorIsDesktopRuntime,
    printingMonitorWebcamUrl,
    printingMonitorWebcamUsesRelayWs,
    printingMonitorRtspDebugSummary,
    printingMonitorHasCamera,
    printingMonitorUsesTwoColumnDetailLayout,
    printingMonitorModalWidthClass,
    printingMonitorWebcamStatusPresentation,
    printingMonitorWebcamDisplayPresentation,
    printingMonitorUiPolicy,
    printingMonitorBusyGraceMs,
    printingMonitorReachabilityMaxInconclusivePolls,
    printingMonitorSupportsWebcamStreamSlotReset,
    printingMonitorWebcamMaxConsecutiveTimeouts,
    printingMonitorWebcamTimeoutCooldownMs,
    printingMonitorWebcamFailureCooldownMs,
    printingMonitorWebcamCanResetStreamSlot,
    monitorWebcamRotationDeg,
    shouldSwapMonitorWebcamAspect,
    monitorWebcamTransform,
    printingMonitorCanExpandWebcam,
    printingMonitorDetailWebcamExpanded,
    monitorWebcamDisplayAspectRatio,
    printingMonitorStateTextNormalized,
    printingMonitorIsPauseTransition,
    printingMonitorIsCancelTransition,
    printingMonitorHasActivePrint,
    printingMonitorAnyActionBusy,
    printingMonitorCancelButtonAnimating,
    printingMonitorPauseButtonAnimating,
    printingMonitorPauseButtonDisabled,
    printingMonitorCancelButtonDisabled,
    printingMonitorEmergencyStopDisabled,
    printingMonitorDisplayProgressPct,
    printingMonitorDisplayCurrentLayer,
    printingMonitorDisplayTotalLayers,
    printingMonitorDisplayMaterialProfile,
    isPrintingMonitorSelectedPrinterOfflineRaw,
    isPrintingMonitorWithinSlowResponseGrace,
    printingMonitorSlowResponseGraceRemainingSec,
    shouldShowPrintingMonitorSlowResponseCard,
    isPrintingMonitorSelectedPrinterOffline,
    hasMonitorSelectableTarget,
    hasPrintingMonitorFleet,
    printingMonitorPrinterThumbnailSrc,
    printingMonitorHeaderUsesFleetLabelOrder,
    printingMonitorHeaderTopLabel,
    printingMonitorHeaderBottomLabel,
    printingMonitorHeaderTitle,
    showTopbarMonitorButton,
    refreshPrintingMonitorRecentPlates,
    handlePrintingMonitorStoragePathChange,
    cancelPrintingMonitorWebcamReadinessCheck,
    schedulePrintingMonitorMjpegReadinessCheck,
    triggerPrintingMonitorWebcamRetry,
    handleSavePrintingMonitorWebcamSnapshot,
    flushMonitors,
    handleResetPrintingMonitorWebcamStreamSlot,
    openPrintingMonitorForTargetDevice,
    executeStartMonitorRecentPlate,
    handleStartMonitorRecentPlate,
    executeDeleteMonitorRecentPlate,
    handleDeleteMonitorRecentPlate,
    executePrintingMonitorControlAction,
    executePrintingMonitorFeatureToggle,
    executePrintingMonitorSdcpDebugCommand,
    handlePrintingMonitorControlAction,
    printingMonitorDebugBundle,
    printingMonitorDebugPanels,
    handleCopyPrintingMonitorDebugBundle,
  } = usePrintingMonitorManager({
    activePrinterProfile,
    setPrintingMonitorError,
    printingReadyPlateId,
    setPrintingReadyPlateId,
    printerReachabilityByDeviceId,
    activeNetworkUiAdapter,
    slicedLayerHeightMm,
    isLayerHeightMatch,
    printableConnectedPrinterFleet,
    selectedPrinterProbeTarget,
  });

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
  const suggestedSliceOutputFilename = React.useMemo(() => {
    const modelName = (scene.activeModel?.name ?? scene.models[0]?.name ?? '').trim();
    const base = (modelName || activePrinterProfile?.name || 'slice_export')
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*]+/g, '_')
      .replace(/\s+/g, '_');
    const ext = resolveOutputFileExtension(
      activePrinterProfile?.display.outputFormat,
      activePrinterProfile?.display.formatVersion,
    );
    return `${base || 'slice_export'}.${ext}`;
  }, [activePrinterProfile?.display.outputFormat, activePrinterProfile?.display.formatVersion, activePrinterProfile?.name, scene.activeModel?.name, scene.models]);
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
    const paddedSeconds = seconds.toString().padStart(2, '0');
    return _(msg`${minutes} min ${paddedSeconds} s`);
  }, [_, printingDeviceProcessingElapsedSec]);





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
























  // Flush webcam polling/circuit-breaker state on monitor close.


  // Manage printer monitor webcam lifecycle: disable when monitor closes.







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
    // No editor menu on the empty-scene welcome screen — there is nothing to act
    // on (unless the clipboard holds a cut/copied model that could be pasted).
    if (!moved && !shouldSuppress && (scene.models.length > 0 || scene.canPasteModel)) {
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
  }, [scene.mode, scene.models.length, scene.canPasteModel, supportShaftHoverDebug.point, supportShaftHoverDebug.segmentId]);

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
    if (transformMgr.transformMode === 'mirror' || mirror.mirrorSessionRef.current) {
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
  //
  // Compute an accurate max Z from actual geometry vertices to match the slicing
  // engine's own max-Z computation.  The legacy sceneBounds path uses
  // Box3.applyMatrix4 which overestimates the envelope for rotated models.
  const accurateMaxZ = React.useMemo(() => {
    let maxZ = 0;
    for (const model of scene.models) {
      if (!model.visible) continue;
      const position = model.geometry.geometry.getAttribute('position');
      if (!position) continue;
      const center = model.geometry.center;
      const t = model.transform;
      const matrix = new THREE.Matrix4().compose(
        t.position,
        quaternionFromGlobalEuler(t.rotation),
        t.scale,
      );
      const me = matrix.elements;
      // worldZ = me[2]*vcx + me[6]*vcy + me[10]*vcz + me[14]
      const a = me[2], b = me[6], c = me[10], d = me[14];
      const src = position.array as Float32Array | number[];
      const count = position.count;
      for (let i = 0; i < count; i++) {
        const vx = src[i * 3] - center.x;
        const vy = src[i * 3 + 1] - center.y;
        const vz = src[i * 3 + 2] - center.z;
        const worldZ = a * vx + b * vy + c * vz + d;
        if (worldZ > maxZ) maxZ = worldZ;
      }
    }
    return maxZ;
  }, [scene.models]);

  const fallbackZRange = React.useMemo(() => ({
    min: hasSupportOrRaftGeometry ? 0 : (scene.sceneBounds?.min.z ?? 0),
    max: accurateMaxZ > 0 ? accurateMaxZ : (scene.sceneBounds?.max.z ?? 100),
  }), [hasSupportOrRaftGeometry, scene.sceneBounds, accurateMaxZ]);

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
    const paddedSeconds = seconds.toString().padStart(2, '0');

    if (hours > 0) return _(msg`${hours} h ${minutes} min`);
    return _(msg`${minutes} min ${paddedSeconds} s`);
  }, [_, activeMaterialProfile, estimatedSlicerLayerCount, scene.models]);

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

  // Populate the import/export manager deps now that the slicing manager and the
  // select-all model state exist (breaks the TDZ/dependency cycle, mirrors the
  // hollowing manager). Render-time assignment so mount-time effects see real values.
  importExportDepsRef.current = {
    isDesktopRuntime,
    slicing: { layerIndex: slicing.layerIndex, setLayerIndex: slicing.setLayerIndex },
    isSelectAllModelsActive,
    setIsSelectAllModelsActive,
  };

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

  const [autoSupportPreview, setAutoSupportPreview] = React.useState<AutoSupportPlanPreview | null>(null);
  const autoSupportAbortRef = React.useRef<AbortController | null>(null);
  const autoSupportWorkerRef = React.useRef<{ key: string; worker: AutoSupportPipelineWorker } | null>(null);

  // Scan data, any pending plan, and the pipeline worker's mesh are all in
  // world space for one specific model; they are stale the moment the active
  // model changes OR its transform does. Without this, generating after a
  // move plans against the old position, and applying a preview after a move
  // commits supports at stale coordinates — floating in air.
  const clearIslandScanData = islands.clearScanData;
  const activeTransformKey = [
    transformMgr.transform.position.toArray(),
    transformMgr.transform.rotation.toArray(),
    transformMgr.transform.scale.toArray(),
  ].flat().join(',');
  React.useEffect(() => {
    clearIslandScanData();
    autoSupportAbortRef.current?.abort();
    setAutoSupportPreview(null);
    autoSupportWorkerRef.current?.worker.dispose();
    autoSupportWorkerRef.current = null;
  }, [clearIslandScanData, scene.activeModel?.id, activeTransformKey]);
  React.useEffect(() => () => {
    autoSupportWorkerRef.current?.worker.dispose();
    autoSupportWorkerRef.current = null;
  }, []);

  const handlePlanAutoSupports = React.useCallback(async (
    preset: AutoSupportPreset,
    onProgress: (progress: AutoSupportProgress) => void,
    options?: { onModelStruts?: boolean; surfaceFill?: boolean },
  ): Promise<AutoSupportPlanPreview | null> => {
    const geom = scene.geom;
    const modelId = scene.activeModel?.id;
    if (!geom || !modelId) return null;
    const plannerSettings = {
      ...AUTO_SUPPORT_PRESETS[preset],
      allowOnModelStruts: options?.onModelStruts ?? true,
      allowSurfaceFill: options?.surfaceFill ?? true,
    };

    setAutoSupportPreview(null);
    autoSupportAbortRef.current?.abort();
    const abortController = new AbortController();
    autoSupportAbortRef.current = abortController;
    abortController.signal.addEventListener('abort', () => { void cancelIslandScanNative(); }, { once: true });

    let scanData = islands.scanData;
    let scanBBox = islands.scanBBox;
    if (!scanData || !scanBBox) {
      onProgress({ phase: 'scan', completed: 0, total: 1 });
      // Planning works in millimetres — a coarse dedicated scan is ~4x faster
      // than the panel's marker-grade scan and leaves the panel state alone.
      const scanned = await islands.onRunCoverageScan(null);
      if (!scanned || abortController.signal.aborted) return null;
      scanData = scanned.scanData;
      scanBBox = scanned.scanBBox;
      onProgress({ phase: 'scan', completed: 1, total: 1 });
    }

    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    const mesh = createIslandSupportMesh(geom, transformMgr.transform, modelId);
    // Run the whole pipeline (hierarchy, planning, routing, coverage
    // evaluation) off the main thread when workers are available; on dense
    // meshes these otherwise block the viewport for the entire generation.
    // The worker persists across generations — its mesh, BVH, and SDF cache
    // are only invalidated when the model or its transform changes.
    const workerKey = `${modelId}:${mesh.matrixWorld.elements.join(',')}`;
    let routeWorker = autoSupportWorkerRef.current?.key === workerKey
      ? autoSupportWorkerRef.current.worker
      : null;
    if (!routeWorker) {
      autoSupportWorkerRef.current?.worker.dispose();
      autoSupportWorkerRef.current = null;
      const workerMesh = extractRouteWorkerMeshPayload(mesh);
      routeWorker = workerMesh
        ? createAutoSupportRouteWorker({ mesh: workerMesh.payload, transfers: workerMesh.transfers, modelId, settings: getSupportSettings() })
        : null;
      if (routeWorker) autoSupportWorkerRef.current = { key: workerKey, worker: routeWorker };
    }
    try {
      const planArgs = {
        scan: scanData,
        scanMinZ: scanBBox.min.z,
        layerHeightMm: slicing.layerHeightMm,
        preset,
        settings: plannerSettings,
        modelId,
        mesh,
        existingTipPoints: supportTips.map((tip) => ({ x: tip.x, y: tip.y, z: tip.z })),
        signal: abortController.signal,
        onProgress,
      };
      const preview = routeWorker
        ? await routeWorker.planAutoSupports(planArgs)
        : await runAutoSupportPlan(planArgs);

      // Verify empirically: re-scan the model merged with the planned and
      // committed supports; any volume still passing the significance
      // thresholds is genuinely unsupported. One repair round routes supports
      // for whatever the first verification still sees, then re-verifies.
      if (preview.supports.length > 0 && !abortController.signal.aborted) {
        const runVerificationScan = async () => {
          const plannedGroups = preview.supports.map(plannedSupportGroup);
          const committedGroup = buildScopedSupportGeometryGroup(getSupportSnapshot(), getKickstandSnapshot(), [modelId]);
          const weldGroup = contactWeldGroup([
            ...plannedContactPoints(preview.supports),
            ...supportTips.map((tip) => ({ x: tip.x, y: tip.y, z: tip.z })),
          ]);
          const supportGeometry = collectSupportGeometry([...plannedGroups, committedGroup, weldGroup]);
          if (!supportGeometry) return null;
          try {
            const verificationScan = await islands.onRunCoverageScan(supportGeometry);
            if (!verificationScan || abortController.signal.aborted) return null;
            const evaluateArgs = {
              scan: verificationScan.scanData,
              scanMinZ: verificationScan.scanBBox.min.z,
              layerHeightMm: slicing.layerHeightMm,
              settings: plannerSettings,
            };
            return routeWorker
              ? await routeWorker.evaluateCoverage(evaluateArgs)
              : evaluateCoverageScan(evaluateArgs);
          } finally {
            supportGeometry.dispose();
          }
        };

        // Flagged spots with a support tip fused within reach are scan
        // artifacts (voxel linkage, self-intersecting source geometry), not
        // missing supports. Filtering them BEFORE deciding to repair means a
        // steady-state generation pays one verification scan, not two plus a
        // repair wave for the same recurring artifacts.
        const fusedRadiusSq = 3 * 3;
        const shaftRadiusSq = 2 * 2;
        const realRemaindersOf = (contacts: typeof preview.supports[number]['contact'][]) => {
          const allTips = [
            ...plannedContactPoints(preview.supports),
            ...supportTips.map((tip) => ({ x: tip.x, y: tip.y, z: tip.z })),
          ];
          const snapshot = getSupportSnapshot();
          const shaftSegments = collectSupportSegments(preview.supports, snapshot, modelId);
          return contacts.filter((contact) => {
            const nearTip = allTips.some((tip) => {
              const dx = tip.x - contact.position.x;
              const dy = tip.y - contact.position.y;
              const dz = tip.z - contact.position.z;
              return dx * dx + dy * dy + dz * dz < fusedRadiusSq;
            });
            if (nearTip) return false;
            return !shaftSegments.some((segment) => distanceToSegmentSq(contact.position, segment.a, segment.b) < shaftRadiusSq);
          });
        };

        onProgress({ phase: 'verify', completed: 0, total: 2 });
        let verification = await runVerificationScan();
        let realRemainders = verification ? realRemaindersOf(verification.repairContacts) : [];
        onProgress({ phase: 'verify', completed: 1, total: 2 });
        if (realRemainders.length > 0 && !abortController.signal.aborted) {
          const repairArgs = {
            contacts: realRemainders,
            settings: plannerSettings,
            modelId,
            mesh,
            existingTipPoints: supportTips.map((tip) => ({ x: tip.x, y: tip.y, z: tip.z })),
            signal: abortController.signal,
            onProgress,
          };
          const repairs = routeWorker
            ? await routeWorker.repairSupports(repairArgs)
            : await routeRepairSupports(repairArgs);
          if (repairs.length > 0) {
            preview.supports.push(...repairs);
            verification = (await runVerificationScan()) ?? verification;
            realRemainders = verification ? realRemaindersOf(verification.repairContacts) : realRemainders;
          }
        }
        onProgress({ phase: 'verify', completed: 2, total: 2 });
        if (verification) {
          preview.verification = { remainingVolumeCount: realRemainders.length };
        }
      }

      setAutoSupportPreview(preview.supports.length > 0 ? preview : null);
      return preview;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      throw error;
    } finally {
      clearSDFCacheForMesh(mesh.uuid);
      disposeIslandSupportMesh(mesh);
      if (autoSupportAbortRef.current === abortController) autoSupportAbortRef.current = null;
    }
  }, [islands, scene.activeModel?.id, scene.geom, slicing.layerHeightMm, supportTips, transformMgr.transform]);

  const handleAbortAutoSupportRun = React.useCallback(() => {
    autoSupportAbortRef.current?.abort();
  }, []);

  const handleAcceptAutoSupports = React.useCallback((options?: { brace?: boolean }) => {
    if (!autoSupportPreview || autoSupportPreview.supports.length === 0) return;
    const before = captureSupportEditSnapshot();
    beginSupportStateBatch();
    try {
      for (const support of autoSupportPreview.supports) {
        if (support.kind === 'trunk') {
          addRoot(support.root);
          addTrunk(support.trunk);
        } else {
          addStick(support.stick);
        }
      }
      if (options?.brace) {
        // Fold bracing into the same commit so one undo removes the whole
        // generated structure, supports and braces alike.
        const braced = buildAutoBracedSnapshot(getSupportSnapshot(), getSupportSettings().autoBracing);
        if (braced.changed) setSupportSnapshot(braced.snapshot);
      }
    } finally {
      endSupportStateBatch();
    }
    pushSupportEditHistory('Generate auto supports', before, captureSupportEditSnapshot());
    setAutoSupportPreview(null);
  }, [autoSupportPreview]);

  const handleCancelAutoSupports = React.useCallback(() => setAutoSupportPreview(null), []);

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

  const arrange = useArrangeManager({
    scene,
    transformMgr,
    sleep,
    displayActiveModelId,
    setDisplayActiveModelId,
    setSupportRenderRefreshNonce,
    supportBoundsByModelId,
    arrangeSpacingMm,
    setArrangeSpacingMm,
    getArrangeTransform,
    getModelSupportAwareDimensionsMm,
    getModelSupportAwareFootprintPolygonRef,
  });
  const {
    arrangePrecisionMode,
    setArrangePrecisionMode,
    arrangeAllowRotateOnZ,
    setArrangeAllowRotateOnZ,
    arrangeLayoutMode,
    setArrangeLayoutMode,
    arrangeAnchorMode,
    setArrangeAnchorMode,
    arrangeArrayCountX,
    setArrangeArrayCountX,
    arrangeArrayCountY,
    setArrangeArrayCountY,
    arrangeArrayCountZ,
    setArrangeArrayCountZ,
    arrangeArrayGapX,
    setArrangeArrayGapX,
    arrangeArrayGapY,
    setArrangeArrayGapY,
    arrangeArrayGapZ,
    setArrangeArrayGapZ,
    activeArrangeOperation,
    setActiveArrangeOperation,
    isAutoArranging,
    setIsAutoArranging,
    arrangeOverlayElapsedSec,
    setArrangeOverlayElapsedSec,
    arrangeOverlayModelCount,
    setArrangeOverlayModelCount,
    duplicateTotalCopies,
    setDuplicateTotalCopies,
    duplicateSpacingMm,
    setDuplicateSpacingMm,
    showArrangeBlockingOverlay,
    arrangeOverlayContent,
    arrangeOverlayElapsedLabel,
    duplicateLayoutMode,
    setDuplicateLayoutMode,
    duplicatePrecisionMode,
    setDuplicatePrecisionMode,
    duplicateArrayCountX,
    setDuplicateArrayCountX,
    duplicateArrayCountY,
    setDuplicateArrayCountY,
    duplicateArrayCountZ,
    setDuplicateArrayCountZ,
    duplicateArrayGapX,
    setDuplicateArrayGapX,
    duplicateArrayGapY,
    setDuplicateArrayGapY,
    duplicateArrayGapZ,
    setDuplicateArrayGapZ,
    isDuplicating,
    setIsDuplicating,
    duplicatePreviewTransforms,
    setDuplicatePreviewTransforms,
    arrangeArrayPreviewItems,
    setArrangeArrayPreviewItems,
    duplicateSourcePreviewTransform,
    setDuplicateSourcePreviewTransform,
    duplicateApplySourceModel,
    setDuplicateApplySourceModel,
    duplicateApplySourceTransform,
    setDuplicateApplySourceTransform,
    effectiveDuplicateTotalCopies,
    isDuplicateSetupBlockingArrange,
    buildHighPrecisionArrangeSupportLocalPoints,
    buildHighPrecisionArrangeModels,
    resolveArrangeVisibleModels,
    applyArrangeTransforms,
    handleAutoArrangeModels,
    handleHighPrecisionArrangeModels,
    computeManualArrayArrangeUpdates,
    handleManualArrayArrangeModels,
    computeArrangeSlots,
    handleConfirmDuplicate,
    handleFillPlateDuplicate,
  } = arrange;

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


  const saveAsActive = useActionActive('GLOBAL', 'SAVE_AS');
  const wasSaveAsActive = React.useRef(false);

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
      // Gaps may be negative (nested arrays); floor the step so it advances.
      const stepX = Math.max(0.1, width + duplicateArrayGapX);
      const stepY = Math.max(0.1, depth + duplicateArrayGapY);
      const stepZ = Math.max(0.1, height + duplicateArrayGapZ);

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
      // Spacing may be negative (nesting); clamp so a step never collapses.
      const spacing = Math.max(-Math.min(width, depth) + 0.1, duplicateSpacingMm);

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

  const holePunch = useHolePunchManager({
    scene,
    transformMgr,
    sleep,
    hollowingState,
    hollowingDraftEnabled,
    hollowPreview,
    isShellOpenFaceSelected,
    defaultHolePunchState,
    recommendedHolePunchDepthMm,
    setHollowingState,
    setIsShellOpenFaceSelected,
    setHollowingDraftEnabled,
    persistActiveModelModifiers,
    setPendingModifierResetAction,
    hollowingSourceByModelIdRef,
    hollowPreviewResultCacheRef,
    isApplyingHolePunch,
    setIsApplyingHolePunch,
    isApplyingHollowing,
    pendingHolePunchAutoApplyModelId,
    setPendingHolePunchAutoApplyModelId,
    selectedHolePunchPlacementIds,
    setSelectedHolePunchPlacementIds,
    setHoveredHolePunchPlacementId,
    setHolePunchHoverPlacement,
    showOperationError,
    setShowDamagedModelDialog,
    beginFinalizing,
    clearFinalizing,
    nextPaint,
  });
  const {
    holePunchState,
    setHolePunchState,
    holePunchPlacements,
    setHolePunchPlacements,
    holePunchPlacementsRef,
    holePunchDragStateRef,
    suppressHolePunchClickPlacementIdRef,
    suppressHolePunchGizmoReleaseClickUntilRef,
    holePunchAutoDepthRaycasterRef,
    holePunchAutoDepthMeshRef,
    selectedHolePunchPlacementIdSet,
    selectedHolePunchPlacements,
    canUseAutoHolePunchDepth,
    syncHolePunchPanelFromSelection,
    activeHolePunchPlacements,
    previousRecommendedHolePunchDepthRef,
    appliedHolePunchPlacementsSignature,
    draftHolePunchPlacementsSignature,
    isHolePunchApplied,
    holePunchNeedsBake,
    isHolePunchDirty,
    appliedHolePunchPlacementIds,
    canResetHolePunch,
    persistHolePunchPlacementsForModel,
    computeAutoHolePunchDepthMmForGeometry,
    computeAutoHolePunchDepthMm,
    buildHolePunchPlacementForHit,
    buildHolePunchPlacementFromHit,
    handleHolePunchClick,
    handleHolePunchHover,
    handleSelectHolePunchPlacement,
    handleHolePunchPlacementDragStart,
    handleHolePunchPlacementDragMove,
    handleHolePunchPlacementDragEnd,
    holePunchGizmoDragRef,
    handleHolePunchGizmoMoveStart,
    handleHolePunchGizmoMove,
    handleHolePunchGizmoMoveEnd,
    holePunchGizmoRotateRef,
    handleHolePunchGizmoRotateStart,
    handleHolePunchGizmoRotate,
    handleHolePunchGizmoRotateEnd,
    handleDeleteSelectedHolePunchPlacement,
    handleHolePunchStateChange,
    handleResetHolePunch,
    requestResetHolePunch,
    handleApplyHolePunch,
  } = holePunch;

  // Hollowing-aware Ctrl/Cmd+A/C/V/S hotkeys (hotkey-store rewrite from #297).
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
    handleTopBarSaveScene,
    printingEstimatedResinMlRef,
    supportAndRaftResinMl,
    printingBaseResinMlCacheRef,
    setPrintingEstimatedResinMl
  ]);

  // Relocated from the early state block: depends on hollowPreview which is now
  // produced by useHollowingManager (declared above, after transformMgr).
  const shouldForceHollowingXray = scene.mode === 'prepare'
    && transformMgr.transformMode === 'hollowing'
    && !scene.activeModel?.meshModifiers?.hollowing?.bakedIntoGeometry;
  const effectiveShaderType = (shouldForceHollowingXray || hollowPreview)
    ? 'xray'
    : (sessionShaderOverride ?? scene.shaderType);

  // Populate the hollowing manager deps now that the hole-punch manager and
  // shared callbacks exist (breaks the TDZ/dependency cycle).
  hollowingDepsRef.current = {
    showOperationError,
    setShowDamagedModelDialog,
    beginFinalizing,
    clearFinalizing,
    nextPaint,
    persistActiveModelModifiers,
    setPendingModifierResetAction,
    setInteriorView,
    setSessionShaderOverride,
    computeAutoHolePunchDepthMmForGeometry,
    setHolePunchState,
    setHolePunchPlacements,
    holePunchPlacementsRef,
    setPendingHolePunchAutoApplyModelId,
    setPendingBlockerResetState,
    setSelectedHolePunchPlacementIds,
    setHoveredHolePunchPlacementId,
    setHolePunchHoverPlacement,
    interiorView,
  };

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
        blockedVoxelRotationQuat: undefined,
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

  React.useEffect(() => {
    if (canUseAutoHolePunchDepth || holePunchState.depthMode !== 'auto') {
      return;
    }

    setHolePunchState((previous) => ({ ...previous, depthMode: 'manual' }));
  }, [canUseAutoHolePunchDepth, holePunchState.depthMode]);

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

    // Single source of truth for preview options and cache keys, shared with
    // the toolbar-hover warmup path. Building options inline here previously
    // omitted `previewVoxelSpheres: true` (and `drainHoles: []`), which made
    // every debounced parameter change run the full cavity-mesh build — and,
    // on manifold failure, the entire stabilization retry cascade — for a
    // result the preview never renders, while also splitting the cache keys
    // so warmup-primed entries could never serve the live preview.
    const {
      sourceGeometry,
      sourceGeometryKey,
      options,
      previewKey,
    } = buildHollowPreviewRequest(activeModel);

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
    buildHollowPreviewRequest,
    clearHollowPreview,
    clearPendingHollowPreviewDebounce,
    hollowPreview,
    isHollowingApplied,
    isHollowingDirty,
    isApplyingHollowing,
    isShellFaceSelectionPending,
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
  const mirror = useMirrorManager({
    scene,
    transformMgr,
    mirrorToolActive,
    suppressTransformPersistenceCycles,
    requestDestructiveTransformSupportDeletionWithContinuation,
  });

  React.useEffect(() => {
    finalizeMirrorSessionRef.current = mirror.flushPendingBake;
  }, [mirror.flushPendingBake]);

  return (
    <EditorLayout>
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
            {PreparePanelStack({
              scene: scene,
              transformMgr: transformMgr,
              hollowing: hollowing,
              holePunch: holePunch,
              arrange: arrange,
              outsidePlateModelIds: outsidePlateModelIds,
              handleModelSelection: handleModelSelection,
              handleModelRangeSelection: handleModelRangeSelection,
              handleGroupSelection: handleGroupSelection,
              handleGroupSelectedModels: handleGroupSelectedModels,
              handleUngroupSelectedModels: handleUngroupSelectedModels,
              handleUngroupFolder: handleUngroupFolder,
              handleSplitImportGroup: handleSplitImportGroup,
              handleRenameFolder: handleRenameFolder,
              handleRenameModel: handleRenameModel,
              handleModelListContextMenu: handleModelListContextMenu,
              handleRepairModel: handleRepairModel,
              handleOpenModelSupportsInfo: handleOpenModelSupportsInfo,
              showEmptySceneDialog: showEmptySceneDialog,
              importOverlayState: importOverlayState,
              modelStatsBottomClearancePx: modelStatsBottomClearancePx,
              debugPrimitivesPanelVisible: debugPrimitivesPanelVisible,
              ensurePendingTransformHistoryForActiveModel: ensurePendingTransformHistoryForActiveModel,
              requestDestructiveTransformSupportDeletion: requestDestructiveTransformSupportDeletion,
              handleRotationComplete: handleRotationComplete,
              handleAutoLiftChange: handleAutoLiftChange,
              scheduleCommitPendingTransformHistory: scheduleCommitPendingTransformHistory,
              uniformScaling: uniformScaling,
              setUniformScaling: setUniformScaling,
              isApplyingHolePunch: isApplyingHolePunch,
              interiorView: interiorView,
              hasCavityGeometry: hasCavityGeometry,
              arrangeSpacingMm: arrangeSpacingMm,
              setArrangeSpacingMm: setArrangeSpacingMm,
            })}
          </>
        ) : scene.mode === 'analysis' ? (
          <>
            {AnalysisPanelStack({
              scene: scene,
              slicing: slicing,
              islands: islands,
            })}
          </>
        ) : scene.mode === 'export' ? (
          <>
            {ExportPanelStack({
              scene: scene,
              slicing: slicing,
              supportsRef: supportsRef,
              captureExportThumbnailPng: captureExportThumbnailPng,
              handleExportSuccess: handleExportSuccess,
              showOperationError: showOperationError,
              estimatedSlicerLayerCount: estimatedSlicerLayerCount,
              crossSectionLayerHeightMm: crossSectionLayerHeightMm,
              estimatedVolumeMlLabel: estimatedVolumeMlLabel,
              handleSliceRunStartedForPrinting: handleSliceRunStartedForPrinting,
              handlePrintingLayerPreviewGenerated: handlePrintingLayerPreviewGenerated,
              handleSlicingFinishedForPrinting: handleSlicingFinishedForPrinting,
              handleSliceArtifactReady: handleSliceArtifactReady,
              handleSlicingBenchmarkComplete: handleSlicingBenchmarkComplete,
              triggerSliceExportRef: triggerSliceExportRef,
              shouldAutoSliceOnExportEntry: shouldAutoSliceOnExportEntry,
              shouldReturnToPrintingAfterSliceRef: shouldReturnToPrintingAfterSliceRef,
              setIsSlicingBusy: setIsSlicingBusy,
              canSliceAndUpload: canSliceAndUpload,
              canSliceAndPrint: canSliceAndPrint,
              sliceIntentRef: sliceIntentRef,
              handleBeforeSliceStart: handleBeforeSliceStart,
              handlePreSliceSceneSave: handlePreSliceSceneSave,
              preSliceFileDestinationPathRef: preSliceFileDestinationPathRef,
              setIsExporting: setIsExporting,
            })}
          </>

        ) : scene.mode === 'support' ? (
          <>
            <SupportSidebar key="support-settings" />
            <IslandsPanel
              key="support-islands"
              islands={islandsPoc}
              hasGeometry={!!scene.geom}
              bottomClearancePx={modelStatsBottomClearancePx}
              autoSupportPreview={autoSupportPreview}
              onPlanAutoSupports={handlePlanAutoSupports}
              onAbortAutoSupportRun={handleAbortAutoSupportRun}
              onAcceptAutoSupports={handleAcceptAutoSupports}
              onCancelAutoSupports={handleCancelAutoSupports}
            />
          </>
        ) : scene.mode === 'printing' ? (
          <>
            {PrintingPanelStack({
              printingArtifact: printingArtifact,
              printingOutputSizeLabel: printingOutputSizeLabel,
              activePrinterProfile: activePrinterProfile,
              printingResinName: printingResinName,
              estimatedPrintTimeLabel: estimatedPrintTimeLabel,
              estimatedVolumeMlLabel: estimatedVolumeMlLabel,
              canDownloadPrintArtifact: canDownloadPrintArtifact,
              canSendToPrinter: canSendToPrinter,
              printingSendBusy: printingSendBusy,
              printingSendStatusText: printingSendStatusText,
              sendToPrinterButtonLabel: sendToPrinterButtonLabel,
              printableConnectedPrinterFleet: printableConnectedPrinterFleet,
              setPrintingTargetPickerMode: setPrintingTargetPickerMode,
              setPrintingTargetPickerOpen: setPrintingTargetPickerOpen,
              handleDownloadPrintArtifact: handleDownloadPrintArtifact,
              handleSendToPrinter: handleSendToPrinter,
              handleCancelSendToPrinter: handleCancelSendToPrinter,
              completedSliceIntent: completedSliceIntent,
              completedSaveDestinationPath: completedSaveDestinationPath,
            })}
          </>
        ) : (
          <>
          </>
        )}

        {SharedPanelStack({
          scene: scene,
          slicing: slicing,
          transformMgr: transformMgr,
          handleSceneLayerScrubStart: handleSceneLayerScrubStart,
          handleSceneLayerScrubEnd: handleSceneLayerScrubEnd,
          isCrossSectionEnabled: isCrossSectionEnabled,
          handleToggleCrossSection: handleToggleCrossSection,
          isTransformDebugOverlayOpen: isTransformDebugOverlayOpen,
          setIsTransformDebugOverlayOpen: setIsTransformDebugOverlayOpen,
          displayActiveModelId: displayActiveModelId,
          transformDebugStats: transformDebugStats,
          supportDebugStats: supportDebugStats,
          activeSupportEntityCounts: activeSupportEntityCounts,
          formatDebugVec3: formatDebugVec3,
          formatDebugVec3Like: formatDebugVec3Like,
          formatDebugNumber: formatDebugNumber,
          formatDebugTime: formatDebugTime,
          formatDebugLatencyMs: formatDebugLatencyMs,
          printingPreviewTotalLayers: printingPreviewTotalLayers,
          printingSelectedLayer: printingSelectedLayer,
          printingDisplayedLayer: printingDisplayedLayer,
          isPrintingLayerScrubbing: isPrintingLayerScrubbing,
          shouldShowScrubPreview: shouldShowScrubPreview,
          printingSendProgress: printingSendProgress,
          printingSendBusy: printingSendBusy,
          printingSendStageText: printingSendStageText,
          printingLayerPreviewUrls: printingLayerPreviewUrls,
          printingArtifact: printingArtifact,
          printingUploadDialogOpen: printingUploadDialogOpen,
          printingUploadDialogStage: printingUploadDialogStage,
          printingUploadDisplayProgress: printingUploadDisplayProgress,
          printingReadyPlateId: printingReadyPlateId,
          printingPrintNowBusy: printingPrintNowBusy,
          printingSendStatusText: printingSendStatusText,
          printingSlicingBenchmark: printingSlicingBenchmark,
        })}
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
            autoSupportPreviews={autoSupportPreview?.supports.map((support) => support.supportData) ?? []}
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

              return (
              <SceneOverlays
                raycastActiveModelFromRay={raycastActiveModelFromRay}
                scene={scene}
                transformMgr={transformMgr}
                ghostData={ghostData}
                LysGhostOverlay={LysGhostOverlay}
                hollowPreview={hollowPreview}
                hollowingEditMode={hollowingEditMode}
                hollowingDraftEnabled={hollowingDraftEnabled}
                isHollowingApplied={isHollowingApplied}
                isHollowingDirty={isHollowingDirty}
                isShellFaceSelectionPending={isShellFaceSelectionPending}
                hollowingState={hollowingState}
                blockedPreviewVoxelInstanceIdSet={blockedPreviewVoxelInstanceIdSet}
                toggleBlockedHollowVoxelIndex={toggleBlockedHollowVoxelIndex}
                interiorView={interiorView}
                holePunchPlacements={holePunchPlacements}
                appliedHolePunchPlacementIds={appliedHolePunchPlacementIds}
                selectedHolePunchPlacementIds={selectedHolePunchPlacementIds}
                selectedHolePunchPlacementIdSet={selectedHolePunchPlacementIdSet}
                hoveredHolePunchPlacementId={hoveredHolePunchPlacementId}
                holePunchHoverPlacement={holePunchHoverPlacement}
                holePunchState={holePunchState}
                setHoveredHolePunchPlacementId={setHoveredHolePunchPlacementId}
                setHolePunchHoverPlacement={setHolePunchHoverPlacement}
                handleHolePunchPlacementDragStart={handleHolePunchPlacementDragStart}
                handleHolePunchPlacementDragMove={handleHolePunchPlacementDragMove}
                handleHolePunchPlacementDragEnd={handleHolePunchPlacementDragEnd}
                handleHolePunchGizmoMoveStart={handleHolePunchGizmoMoveStart}
                handleHolePunchGizmoMove={handleHolePunchGizmoMove}
                handleHolePunchGizmoMoveEnd={handleHolePunchGizmoMoveEnd}
                handleHolePunchGizmoRotateStart={handleHolePunchGizmoRotateStart}
                handleHolePunchGizmoRotate={handleHolePunchGizmoRotate}
                handleHolePunchGizmoRotateEnd={handleHolePunchGizmoRotateEnd}
              />
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
                onMirror={mirror.handleMirror}
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
          <PrintingPreviewPane
            printingPreviewTotalLayers={printingPreviewTotalLayers}
            printingSelectedLayer={printingSelectedLayer}
            handlePrintingLayerChange={handlePrintingLayerChange}
            handlePrintingLayerScrubStart={handlePrintingLayerScrubStart}
            handlePrintingLayerScrubEnd={handlePrintingLayerScrubEnd}
            printingCurrentHeightMm={printingCurrentHeightMm}
            slicingHeightMm={slicing.heightMm}
            crossSectionMode={slicing.crossSectionMode}
            printingPreviewViewportRef={printingPreviewViewportRef}
            printingPreviewCursor={printingPreviewCursor}
            handlePrintingPreviewWheel={handlePrintingPreviewWheel}
            handlePrintingPreviewPointerDown={handlePrintingPreviewPointerDown}
            handlePrintingPreviewPointerMove={handlePrintingPreviewPointerMove}
            handlePrintingPreviewPointerEnd={handlePrintingPreviewPointerEnd}
            printingPreviewTargetResolution={printingPreviewTargetResolution}
            activePrinterProfile={activePrinterProfile}
            printingPreviewVisualTransform={printingPreviewVisualTransform}
            models={scene.models}
            supportDragGroupRef={supportDragGroupRef}
            supportRenderRefreshNonce={supportRenderRefreshNonce}
            printingPreviewScrubUpscaleTransform={printingPreviewScrubUpscaleTransform}
            printingPreviewPngUrlForDisplay={printingPreviewPngUrlForDisplay}
            isPrintingPngLoaded={isPrintingPngLoaded}
            selectedPrintingLayerPreviewUrl={selectedPrintingLayerPreviewUrl}
            usePrintingSettledHiResCanvas={usePrintingSettledHiResCanvas}
            printingPreviewCanvasRef={printingPreviewCanvasRef}
            isPrintingSettledCanvasReady={isPrintingSettledCanvasReady}
          />
        )}
      </div>

      <EditorContextMenu
        position={editorContextMenuPos}
        onAction={handleEditorMenuAction}
        title={editorContextMenuTitle}
        items={editorContextMenuItems}
        disabledActions={editorContextMenuDisabledActions}
      />

      <DiagnosticsModals
        clearHistory={clearHistory}
        clearHistoryDebugEvents={clearHistoryDebugEvents}
        handleHistoryCancelPreview={handleHistoryCancelPreview}
        handleHistoryJumpToEvent={handleHistoryJumpToEvent}
        historyDebugEvents={historyDebugEvents}
        historyPreviewTargetEventId={historyPreviewTargetEventId}
        historyStackCounts={historyStackCounts}
        isDiagnosticsOpen={isDiagnosticsOpen}
        isHistoryDebugOpen={isHistoryDebugOpen}
        isHistoryPreviewActive={isHistoryPreviewActive}
        isSliceMetricsDebugOpen={isSliceMetricsDebugOpen}
        printingArtifact={printingArtifact}
        printingOutputSizeLabel={printingOutputSizeLabel}
        printingSlicingBenchmark={printingSlicingBenchmark}
        scene={scene}
        selectedPolygons={selectedPolygons}
        setIsDiagnosticsOpen={setIsDiagnosticsOpen}
        setIsHistoryDebugOpen={setIsHistoryDebugOpen}
        setIsSliceMetricsDebugOpen={setIsSliceMetricsDebugOpen}
        totalPolygons={totalPolygons}
      />

      <PrintingModals
        DEFAULT_RELAY_AUTORETRY_DELAY_MS={DEFAULT_RELAY_AUTORETRY_DELAY_MS}
        DEFAULT_RELAY_AUTORETRY_LIMIT={DEFAULT_RELAY_AUTORETRY_LIMIT}
        activeNetworkUiAdapter={activeNetworkUiAdapter}
        activePrinterProfile={activePrinterProfile}
        canPrintNow={canPrintNow}
        canSendToPrinter={canSendToPrinter}
        cancelPrintingMonitorWebcamReadinessCheck={cancelPrintingMonitorWebcamReadinessCheck}
        dashboardMonitorDevices={dashboardMonitorDevices}
        executeDeleteMonitorRecentPlate={executeDeleteMonitorRecentPlate}
        executePrintingMonitorControlAction={executePrintingMonitorControlAction}
        executePrintingMonitorFeatureToggle={executePrintingMonitorFeatureToggle}
        executePrintingMonitorSdcpDebugCommand={executePrintingMonitorSdcpDebugCommand}
        executeStartMonitorRecentPlate={executeStartMonitorRecentPlate}
        handleCopyPrintingMonitorDebugBundle={handleCopyPrintingMonitorDebugBundle}
        handleDeleteMonitorRecentPlate={handleDeleteMonitorRecentPlate}
        handlePrintNow={handlePrintNow}
        handlePrintingMonitorControlAction={handlePrintingMonitorControlAction}
        handlePrintingMonitorStoragePathChange={handlePrintingMonitorStoragePathChange}
        handleResetPrintingMonitorWebcamStreamSlot={handleResetPrintingMonitorWebcamStreamSlot}
        handleSavePrintingMonitorWebcamSnapshot={handleSavePrintingMonitorWebcamSnapshot}
        handleSendToPrinter={handleSendToPrinter}
        handleStartMonitorRecentPlate={handleStartMonitorRecentPlate}
        hasPrintingMonitorFleet={hasPrintingMonitorFleet}
        isPreSliceTargetPicker={isPreSliceTargetPicker}
        isPrintingMonitorDebugOpen={isPrintingMonitorDebugOpen}
        isPrintingMonitorPolling={isPrintingMonitorPolling}
        isPrintingMonitorPrinterMenuOpen={isPrintingMonitorPrinterMenuOpen}
        isPrintingMonitorRecentPlatesLoading={isPrintingMonitorRecentPlatesLoading}
        isPrintingMonitorRtspDebugOpen={isPrintingMonitorRtspDebugOpen}
        isPrintingMonitorSelectedPrinterOffline={isPrintingMonitorSelectedPrinterOffline}
        isPrintingMonitorStatusRequestInFlight={isPrintingMonitorStatusRequestInFlight}
        isPrintingMonitorThumbnailLoaded={isPrintingMonitorThumbnailLoaded}
        isPrintingMonitorWebcamLoaded={isPrintingMonitorWebcamLoaded}
        isPrintingMonitorWebcamResetBusy={isPrintingMonitorWebcamResetBusy}
        isPrintingMonitorWebcamSnapshotSaving={isPrintingMonitorWebcamSnapshotSaving}
        isPrintingMonitorWithinSlowResponseGrace={isPrintingMonitorWithinSlowResponseGrace}
        isPrintingTargetMaterialsLoading={isPrintingTargetMaterialsLoading}
        modeBeforePrintingRef={modeBeforePrintingRef}
        monitorSelectableDevices={monitorSelectableDevices}
        monitorWebcamDisplayAspectRatio={monitorWebcamDisplayAspectRatio}
        monitorWebcamTransform={monitorWebcamTransform}
        monitoringDevice={monitoringDevice}
        openPrintingMonitorForTargetDevice={openPrintingMonitorForTargetDevice}
        performSendToPrinter={performSendToPrinter}
        preSlicePrintConfirmOpen={preSlicePrintConfirmOpen}
        preSlicePrintConfirmResolverRef={preSlicePrintConfirmResolverRef}
        preSliceTargetPickerResolverRef={preSliceTargetPickerResolverRef}
        printableConnectedPrinterFleet={printableConnectedPrinterFleet}
        printerReachabilityByDeviceId={printerReachabilityByDeviceId}
        printingArtifact={printingArtifact}
        printingDialogIsIndeterminate={printingDialogIsIndeterminate}
        printingDialogProgressPercent={printingDialogProgressPercent}
        printingDialogStageLabel={printingDialogStageLabel}
        printingMonitorActionBusy={printingMonitorActionBusy}
        printingMonitorActionStatus={printingMonitorActionStatus}
        printingMonitorAnyActionBusy={printingMonitorAnyActionBusy}
        printingMonitorCanExpandWebcam={printingMonitorCanExpandWebcam}
        printingMonitorCancelButtonAnimating={printingMonitorCancelButtonAnimating}
        printingMonitorCancelButtonDisabled={printingMonitorCancelButtonDisabled}
        printingMonitorControlPendingAction={printingMonitorControlPendingAction}
        printingMonitorDashboardSnapshots={printingMonitorDashboardSnapshots}
        printingMonitorDebugBundle={printingMonitorDebugBundle}
        printingMonitorDebugCopyState={printingMonitorDebugCopyState}
        printingMonitorDebugPanels={printingMonitorDebugPanels}
        printingMonitorDetailWebcamExpanded={printingMonitorDetailWebcamExpanded}
        printingMonitorDisplayCurrentLayer={printingMonitorDisplayCurrentLayer}
        printingMonitorDisplayMaterialProfile={printingMonitorDisplayMaterialProfile}
        printingMonitorDisplayProgressPct={printingMonitorDisplayProgressPct}
        printingMonitorDisplayTotalLayers={printingMonitorDisplayTotalLayers}
        printingMonitorEmergencyStopDisabled={printingMonitorEmergencyStopDisabled}
        printingMonitorHasActivePrint={printingMonitorHasActivePrint}
        printingMonitorHasCamera={printingMonitorHasCamera}
        printingMonitorHeaderBottomLabel={printingMonitorHeaderBottomLabel}
        printingMonitorHeaderTitle={printingMonitorHeaderTitle}
        printingMonitorHeaderTopLabel={printingMonitorHeaderTopLabel}
        printingMonitorHeaderUsesFleetLabelOrder={printingMonitorHeaderUsesFleetLabelOrder}
        printingMonitorInlineWebcamUrl={printingMonitorInlineWebcamUrl}
        printingMonitorIsPauseTransition={printingMonitorIsPauseTransition}
        printingMonitorLastFeatureToggleResponse={printingMonitorLastFeatureToggleResponse}
        printingMonitorLeftColumnRef={printingMonitorLeftColumnRef}
        printingMonitorModalOpen={printingMonitorModalOpen}
        printingMonitorModalWidthClass={printingMonitorModalWidthClass}
        printingMonitorPauseButtonAnimating={printingMonitorPauseButtonAnimating}
        printingMonitorPauseButtonDisabled={printingMonitorPauseButtonDisabled}
        printingMonitorPendingConfirmation={printingMonitorPendingConfirmation}
        printingMonitorPlatesStoragePath={printingMonitorPlatesStoragePath}
        printingMonitorPrinterMenuRef={printingMonitorPrinterMenuRef}
        printingMonitorPrinterThumbnailSrc={printingMonitorPrinterThumbnailSrc}
        printingMonitorRecentPlates={printingMonitorRecentPlates}
        printingMonitorRecentPlatesError={printingMonitorRecentPlatesError}
        printingMonitorRelayAutoRetryCountRef={printingMonitorRelayAutoRetryCountRef}
        printingMonitorRelayAutoRetryTimeoutRef={printingMonitorRelayAutoRetryTimeoutRef}
        printingMonitorRelayBaseWsUrl={printingMonitorRelayBaseWsUrl}
        printingMonitorRelayDebugTransport={printingMonitorRelayDebugTransport}
        printingMonitorRelayReclaimDebug={printingMonitorRelayReclaimDebug}
        printingMonitorRtspDebugSummary={printingMonitorRtspDebugSummary}
        printingMonitorRtspSourceUrl={printingMonitorRtspSourceUrl}
        printingMonitorSlowResponseGraceRemainingSec={printingMonitorSlowResponseGraceRemainingSec}
        printingMonitorSnapshot={printingMonitorSnapshot}
        printingMonitorThumbnailDisplayUrl={printingMonitorThumbnailDisplayUrl}
        printingMonitorThumbnailUrl={printingMonitorThumbnailUrl}
        printingMonitorUsesTwoColumnDetailLayout={printingMonitorUsesTwoColumnDetailLayout}
        printingMonitorViewMode={printingMonitorViewMode}
        printingMonitorWebcamCanResetStreamSlot={printingMonitorWebcamCanResetStreamSlot}
        printingMonitorWebcamDisplayPresentation={printingMonitorWebcamDisplayPresentation}
        printingMonitorWebcamLoadError={printingMonitorWebcamLoadError}
        printingMonitorWebcamSectionRef={printingMonitorWebcamSectionRef}
        printingMonitorWebcamStatusPresentation={printingMonitorWebcamStatusPresentation}
        printingMonitorWebcamUrl={printingMonitorWebcamUrl}
        printingMonitorWebcamUsesRelayWs={printingMonitorWebcamUsesRelayWs}
        printingMonitorWebcamViewportRef={printingMonitorWebcamViewportRef}
        printingMonitoringAdapter={printingMonitoringAdapter}
        printingPrintNowBusy={printingPrintNowBusy}
        printingProcessingElapsedLabel={printingProcessingElapsedLabel}
        printingReadyPlateId={printingReadyPlateId}
        printingSendBusy={printingSendBusy}
        printingSendStatusText={printingSendStatusText}
        printingTargetDevice={printingTargetDevice}
        printingTargetDeviceId={printingTargetDeviceId}
        printingTargetMaterialError={printingTargetMaterialError}
        printingTargetMaterialGroups={printingTargetMaterialGroups}
        printingTargetMaterialId={printingTargetMaterialId}
        printingTargetMaterialOptions={printingTargetMaterialOptions}
        printingTargetPickerOpen={printingTargetPickerOpen}
        printingUploadDialogOpen={printingUploadDialogOpen}
        printingUploadDialogStage={printingUploadDialogStage}
        printingUploadTelemetry={printingUploadTelemetry}
        refreshPrintingMonitorRecentPlates={refreshPrintingMonitorRecentPlates}
        requiresRemoteMaterialSelectionForUpload={requiresRemoteMaterialSelectionForUpload}
        scene={scene}
        schedulePrintingMonitorMjpegReadinessCheck={schedulePrintingMonitorMjpegReadinessCheck}
        setIsPrintingMonitorDebugOpen={setIsPrintingMonitorDebugOpen}
        setIsPrintingMonitorPrinterMenuOpen={setIsPrintingMonitorPrinterMenuOpen}
        setIsPrintingMonitorPrinterThumbnailFailed={setIsPrintingMonitorPrinterThumbnailFailed}
        setIsPrintingMonitorRtspDebugOpen={setIsPrintingMonitorRtspDebugOpen}
        setIsPrintingMonitorWebcamLoaded={setIsPrintingMonitorWebcamLoaded}
        setPreSlicePrintConfirmOpen={setPreSlicePrintConfirmOpen}
        setPrintingMonitorDeviceId={setPrintingMonitorDeviceId}
        setPrintingMonitorModalOpen={setPrintingMonitorModalOpen}
        setPrintingMonitorPendingConfirmation={setPrintingMonitorPendingConfirmation}
        setPrintingMonitorViewMode={setPrintingMonitorViewMode}
        setPrintingMonitorWebcamAspectRatio={setPrintingMonitorWebcamAspectRatio}
        setPrintingMonitorWebcamExpanded={setPrintingMonitorWebcamExpanded}
        setPrintingMonitorWebcamLoadError={setPrintingMonitorWebcamLoadError}
        setPrintingTargetDeviceId={setPrintingTargetDeviceId}
        setPrintingTargetMaterialId={setPrintingTargetMaterialId}
        setPrintingTargetPickerMode={setPrintingTargetPickerMode}
        setPrintingTargetPickerOpen={setPrintingTargetPickerOpen}
        setPrintingUploadDialogOpen={setPrintingUploadDialogOpen}
        setShouldAutoSliceOnExportEntry={setShouldAutoSliceOnExportEntry}
        setShowPrintingResliceModal={setShowPrintingResliceModal}
        setShowSliceCompletedModal={setShowSliceCompletedModal}
        setUvToolsLaunchingPath={setUvToolsLaunchingPath}
        shouldReturnToPrintingAfterSliceRef={shouldReturnToPrintingAfterSliceRef}
        shouldShowPrintingMonitorSlowResponseCard={shouldShowPrintingMonitorSlowResponseCard}
        showPrintingResliceModal={showPrintingResliceModal}
        showSliceCompletedModal={showSliceCompletedModal}
        sliceCompletedModalData={sliceCompletedModalData}
        slicedLayerHeightMm={slicedLayerHeightMm}
        triggerPrintingMonitorWebcamRetry={triggerPrintingMonitorWebcamRetry}
        uvToolsLaunchingPath={uvToolsLaunchingPath}
      />

      <SceneFileModals
        arrangeOverlayContent={arrangeOverlayContent}
        arrangeOverlayElapsedLabel={arrangeOverlayElapsedLabel}
        arrangeOverlayModelCount={arrangeOverlayModelCount}
        autosaveRecovery={autosaveRecovery}
        closeUnsavedChangesBusy={closeUnsavedChangesBusy}
        handleAutosaveDiscard={handleAutosaveDiscard}
        handleAutosaveRestore={handleAutosaveRestore}
        handleCancelPluginImportWarning={handleCancelPluginImportWarning}
        handleContinuePluginImportWarning={handleContinuePluginImportWarning}
        handleDiscardAndCloseProgram={handleDiscardAndCloseProgram}
        handleSaveAndCloseProgram={handleSaveAndCloseProgram}
        hasUnsavedSceneChanges={hasUnsavedSceneChanges}
        pluginImportWarningSkipFuture={pluginImportWarningSkipFuture}
        resolveSceneSaveChoice={resolveSceneSaveChoice}
        scene={scene}
        sceneSaveChoiceFileName={sceneSaveChoiceFileName}
        sceneSaveChoicePath={sceneSaveChoicePath}
        setPluginImportWarningSkipFuture={setPluginImportWarningSkipFuture}
        setShowCloseUnsavedChangesModal={setShowCloseUnsavedChangesModal}
        setSupportsInfoModelId={setSupportsInfoModelId}
        setZipPickerState={setZipPickerState}
        showArrangeBlockingOverlay={showArrangeBlockingOverlay}
        showCloseUnsavedChangesModal={showCloseUnsavedChangesModal}
        showPluginImportWarningModal={showPluginImportWarningModal}
        showSceneSaveChoiceModal={showSceneSaveChoiceModal}
        supportsInfoModelId={supportsInfoModelId}
        zipPickerResolveRef={zipPickerResolveRef}
        zipPickerState={zipPickerState}
      />

      <ModifierModals
        handleApplyHolePunch={handleApplyHolePunch}
        handleCancelDestructiveTransform={handleCancelDestructiveTransform}
        handleConfirmBlockerReset={handleConfirmBlockerReset}
        handleConfirmDestructiveTransform={handleConfirmDestructiveTransform}
        handleConfirmModifierReset={handleConfirmModifierReset}
        modifierApplyOverlayContent={modifierApplyOverlayContent}
        modifierApplyOverlayElapsedLabel={modifierApplyOverlayElapsedLabel}
        pendingBlockerResetState={pendingBlockerResetState}
        pendingDestructiveTransform={pendingDestructiveTransform}
        pendingModifierResetAction={pendingModifierResetAction}
        setPendingBlockerResetState={setPendingBlockerResetState}
        setPendingModifierResetAction={setPendingModifierResetAction}
        setShowUnappliedHolePunchModal={setShowUnappliedHolePunchModal}
        showModifierApplyBlockingOverlay={showModifierApplyBlockingOverlay}
        showUnappliedHolePunchModal={showUnappliedHolePunchModal}
        unappliedHolePunchResolveRef={unappliedHolePunchResolveRef}
      />

      <MeshRepairModals
        isManualRepairing={isManualRepairing}
        manualRepairModelId={manualRepairModelId}
        scene={scene}
        setIsManualRepairing={setIsManualRepairing}
        setManualRepairModelId={setManualRepairModelId}
        setShowDamagedModelDialog={setShowDamagedModelDialog}
        showDamagedModelDialog={showDamagedModelDialog}
      />

      <NotificationStack
        isSaveToastVisible={isSaveToastVisible}
        isSaveToastAnimatedVisible={isSaveToastAnimatedVisible}
        saveToastLabel={saveToastLabel}
        historyActionToast={historyActionToast}
        isHistoryActionToastVisible={isHistoryActionToastVisible}
        printingMonitorErrorToast={printingMonitorErrorToast}
        isPrintingMonitorErrorToastVisible={isPrintingMonitorErrorToastVisible}
        sceneImportReport={scene.sceneImportReport}
        isSceneImportToastVisible={isSceneImportToastVisible}
        onOpenMeshRepairReport={scene.openPendingMeshRepairReports}
        exportSuccessToast={exportSuccessToast}
        isExportSuccessToastVisible={isExportSuccessToastVisible}
        exportErrorToast={exportErrorToast}
        isExportErrorToastVisible={isExportErrorToastVisible}
      />

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

      {sproutParentingLockHeld && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast tone="info" visible={true} className="flex items-center gap-2">
            {stage === 'awaitingSproutTip'
              ? "Leaf Fanning Active: Click model to sprout leaf"
              : "Leaf Fanning: Click a support shaft to lock anchor knot"}
          </Toast>
        </ToastViewport>
      )}

    </EditorLayout>
  );
}
