'use client';

import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Redo2, Undo2 } from 'lucide-react';
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
import { LayerSlider } from '@/components/controls/LayerSlider';
import { PrintingLayerScrubPreview } from '@/components/controls/PrintingLayerScrubPreview';
import { SupportSidebar } from '@/supports/Settings';
import { CurveSettingsCard } from '@/supports/Curves/CurveSettingsCard';
import { ExportPanel } from '@/features/export/components/ExportPanel';
import { ExportManager } from '@/features/export/logic/ExportManager';
import { SlicingPanel } from '@/features/slicing/components/SlicingPanel';
import { PrintingPanel } from '@/features/printing/components/PrintingPanel';
import { SliceMetricsDebugModal } from '@/features/slicing/components/SliceMetricsDebugModal';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { MeshSmoothingBrushCursor } from '@/features/mesh-smoothing/MeshSmoothingBrushCursor';
import { IconButton } from '@/components/ui/primitives';
import { EditorContextMenu, type EditorMenuAction } from '@/components/ui/EditorContextMenu';
import { DiagnosticsModal } from '@/components/modals/DiagnosticsModal';
import { HistoryDebugModal } from '@/components/modals/HistoryDebugModal';
import { ModelSupportsModal } from '@/components/modals/ModelSupportsModal';
import { DestructiveTransformModal } from '@/components/modals/DestructiveTransformModal';
import { PrintingResliceModal } from '@/components/modals/PrintingResliceModal';
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
import {
  type HullCacheEntry,
  type ArrangeModel as HighPrecisionArrangeModel,
} from '@/features/scene/arrange/highPrecisionArrange';
import { computeHighPrecisionArrangeUpdatesWorker } from '@/features/scene/arrange/highPrecisionArrangeWorkerClient';

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
import { getSavedWorkspaceCameraSettings } from '@/components/settings/workspaceCameraPreferences';
import { openProfileSettingsModal } from '@/components/settings/profileModalEvents';
import {
  getActiveMaterialProfile,
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import type { SliceExportArtifact, SliceExportResult } from '@/features/slicing/sliceExportOrchestrator';
import {
  cleanupStalePrintTempArtifacts,
  deletePrintTempArtifactPath,
  pickOpenFilesWithNativeDialog,
  readPrintLayerPreviewPngFromPath,
  readPrintArtifactBytesFromPath,
  savePrintArtifactPathWithNativeDialog,
  savePrintArtifactWithNativeDialog,
} from '@/features/slicing/tauri/nativeSlicerBridge';
import { subscribe as subscribeSupportState, getSnapshot as getSupportSnapshot } from '@/supports/state';
import {
  getSupportBraceSnapshot,
  subscribeToSupportBraceStore,
} from '@/supports/SupportTypes/SupportBrace/supportBraceStore';
import { bracePlacementStore } from '@/supports/SupportTypes/Brace/bracePlacementState';
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

import { type MeshShaderType } from '@/features/shaders/mesh';
import type { ModelTransform } from '@/hooks/useModelTransform';

import { IslandScanWorkflowCard } from '@/volumeAnalysis/IslandScan/workflow/IslandScanWorkflowCard';
import { IslandVolumesHierarchyCard } from '@/volumeAnalysis/IslandVolumes/components/IslandVolumesHierarchyCard';
import { pluginNetworkFetch } from '@/utils/pluginNetworkBridge';

interface ShaftHoverDebugDetail {
  segmentId: string | null;
  point: { x: number; y: number; z: number } | null;
}

const EMPTY_SUPPORT_BOUNDS_BY_MODEL_ID = new Map<string, THREE.Box3>();

type HomeSupportSnapshot = ReturnType<typeof getSupportSnapshot>;
type HomeSupportCollectionsSnapshot = Pick<
  HomeSupportSnapshot,
  'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'roots' | 'knots'
>;

type HomeSupportBraceSnapshot = ReturnType<typeof getSupportBraceSnapshot>;
type HomeSupportBraceCollectionsSnapshot = Pick<
  HomeSupportBraceSnapshot,
  'supportBraces' | 'roots' | 'knots'
>;

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

const EMPTY_HOME_SUPPORT_BRACE_COLLECTIONS_SNAPSHOT: HomeSupportBraceCollectionsSnapshot = {
  supportBraces: {},
  roots: {},
  knots: {},
};

let cachedHomeSupportCollectionsSnapshot: HomeSupportCollectionsSnapshot | null = null;
let cachedHomeSupportBraceCollectionsSnapshot: HomeSupportBraceCollectionsSnapshot | null = null;

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

function getHomeSupportBraceCollectionsSnapshot(): HomeSupportBraceCollectionsSnapshot {
  const snapshot = getSupportBraceSnapshot();
  const cached = cachedHomeSupportBraceCollectionsSnapshot;

  if (
    cached
    && cached.supportBraces === snapshot.supportBraces
    && cached.roots === snapshot.roots
    && cached.knots === snapshot.knots
  ) {
    return cached;
  }

  const next: HomeSupportBraceCollectionsSnapshot = {
    supportBraces: snapshot.supportBraces,
    roots: snapshot.roots,
    knots: snapshot.knots,
  };

  cachedHomeSupportBraceCollectionsSnapshot = next;
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
  console.log('[App] BVH acceleration initialized');
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
  includeBuildPlate: true,
  includeGrid: true,
  centerOnModel: true,
};

const PREPARE_DROP_EXTENSIONS = new Set(['.stl', '.3mf', '.lys', '.voxl']);

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

function isSupportedPrepareDropName(name: string): boolean {
  return PREPARE_DROP_EXTENSIONS.has(getFileExtension(name));
}

function getDroppedFileMimeType(name: string): string {
  const ext = getFileExtension(name);
  if (ext === '.stl') return 'model/stl';
  if (ext === '.3mf') return 'model/3mf';
  if (ext === '.voxl') return 'application/json';
  if (ext === '.lys') return 'application/octet-stream';
  return 'application/octet-stream';
}

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

export default function Home() {
  // 1. Scene & Geometry (Multi-Model)
  const scene = useSceneCollectionManager();
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const activeMaterialProfile = React.useMemo(() => getActiveMaterialProfile(profileState), [profileState]);
  const hasActivePrinterProfile = Boolean(activePrinterProfile);

  // 2. Transform Management (needs geom for bounds)
  const transformMgr = useTransformManager({ geom: scene.geom });

  // Ref for supports group (used for export)
  const supportsRef = React.useRef<THREE.Group | null>(null);
  // Ref for the drag-wrapper group around supports/rafts (live gizmo transform)
  const supportDragGroupRef = React.useRef<THREE.Group | null>(null);
  const exportThumbnailCaptureRef = React.useRef<(() => Promise<Uint8Array | null>) | null>(null);
  const exportThumbnailCaptureRunnerRef = React.useRef<(() => Promise<Uint8Array | null>) | null>(null);
  const supportDragResetRafRef = React.useRef<number | null>(null);
  const supportDragResetSecondRafRef = React.useRef<number | null>(null);
  const [holdSupportDragDeltaUntilSupportSync, setHoldSupportDragDeltaUntilSupportSync] = React.useState(false);
  const pendingSupportSyncReleasePerfRef = React.useRef<number | null>(null);
  const supportSyncFallbackTimeoutRef = React.useRef<number | null>(null);
  const lastSupportStoreUpdatePerfRef = React.useRef<number>(0);
  const lastSupportBraceStoreUpdatePerfRef = React.useRef<number>(0);
  const transformDebugTimelineRef = React.useRef<{
    lastOperation: 'move' | 'rotate' | 'scale' | null;
    dragReleasedAt: { perfMs: number; epochMs: number } | null;
    liveCalculatedAt: { perfMs: number; epochMs: number } | null;
    storeUpdateStartedAt: { perfMs: number; epochMs: number } | null;
    storeUpdatedAt: { perfMs: number; epochMs: number } | null;
    supportStoreUpdatedAt: { perfMs: number; epochMs: number } | null;
    supportBraceStoreUpdatedAt: { perfMs: number; epochMs: number } | null;
    activeModelStoreObservedAt: { perfMs: number; epochMs: number } | null;
  }>({
    lastOperation: null,
    dragReleasedAt: null,
    liveCalculatedAt: null,
    storeUpdateStartedAt: null,
    storeUpdatedAt: null,
    supportStoreUpdatedAt: null,
    supportBraceStoreUpdatedAt: null,
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
  } | null>(null);
  const transformHistoryCommitRequestedRef = React.useRef(false);
  const transformHistoryCommitNonceRef = React.useRef(0);
  const pendingHistoryTransformResyncRef = React.useRef(false);
  const suppressNextTransformPersistenceRef = React.useRef(false);
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
  const [historyActionToast, setHistoryActionToast] = React.useState<{ id: number; text: string; direction: 'undo' | 'redo' } | null>(null);
  const [isHistoryActionToastVisible, setIsHistoryActionToastVisible] = React.useState(false);
  const [isSceneImportToastVisible, setIsSceneImportToastVisible] = React.useState(false);
  const [historyTransformResyncTick, setHistoryTransformResyncTick] = React.useState(0);
  const historyTransformResyncTokenRef = React.useRef(0);
  const historyTransformResyncRafRef = React.useRef<number | null>(null);
  const historyTransformResyncSecondRafRef = React.useRef<number | null>(null);
  const historyTransformResyncTimeoutRef = React.useRef<number | null>(null);
  const historyActionToastFadeTimeoutRef = React.useRef<number | null>(null);
  const historyActionToastClearTimeoutRef = React.useRef<number | null>(null);
  const sceneImportToastFadeTimeoutRef = React.useRef<number | null>(null);

  const [sessionShaderOverride, setSessionShaderOverride] = React.useState<MeshShaderType | null>(null);
  const effectiveShaderType = sessionShaderOverride ?? scene.shaderType;
  const [isPrepareDragActive, setIsPrepareDragActive] = React.useState(false);
  const [isSupportSpotlightHoldActive, setIsSupportSpotlightHoldActive] = React.useState(false);
  const [allowPrepareWithoutPrinter, setAllowPrepareWithoutPrinter] = React.useState(false);
  const [prepareSmoothingSettingsExpanded, setPrepareSmoothingSettingsExpanded] = React.useState(true);
  const [supportSettingsExpanded, setSupportSettingsExpanded] = React.useState(true);
  const [debugPrimitivesPanelVisible, setDebugPrimitivesPanelVisible] = React.useState<boolean>(false);
  const [editorContextMenuPos, setEditorContextMenuPos] = React.useState<{ x: number; y: number } | null>(null);
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
  const [isPrintingPngLoaded, setIsPrintingPngLoaded] = React.useState(false);
  const [isSceneLayerScrubbing, setIsSceneLayerScrubbing] = React.useState(false);
  const [isSlicingBusy, setIsSlicingBusy] = React.useState(false);
  const [isPrintingPreviewSettled, setIsPrintingPreviewSettled] = React.useState(false);
  const [isPrintingSettledCanvasReady, setIsPrintingSettledCanvasReady] = React.useState(false);
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
  const lastPrintingLayerSyncPerfRef = React.useRef(0);
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
  const [printingEstimatedResinMl, setPrintingEstimatedResinMl] = React.useState<number | null>(null);
  const [isPrintingEstimatedResinBusy, setIsPrintingEstimatedResinBusy] = React.useState(false);
  const printingBaseResinMlCacheRef = React.useRef<Map<string, number | null>>(new Map());
  const printingInFlightBaseResinMlRef = React.useRef<Map<string, Promise<number | null>>>(new Map());
  const [showPrintingResliceModal, setShowPrintingResliceModal] = React.useState(false);
  const [shouldAutoSliceOnExportEntry, setShouldAutoSliceOnExportEntry] = React.useState(false);
  const [printingSendBusy, setPrintingSendBusy] = React.useState(false);
  const [printingSendStatusText, setPrintingSendStatusText] = React.useState<string | null>(null);
  const [printingSendProgress, setPrintingSendProgress] = React.useState(0);
  const [printingSendStageText, setPrintingSendStageText] = React.useState<string | null>(null);
  const [printingReadyPlateId, setPrintingReadyPlateId] = React.useState<number | null>(null);
  const [printingPrintNowBusy, setPrintingPrintNowBusy] = React.useState(false);
  const [printingUploadDialogOpen, setPrintingUploadDialogOpen] = React.useState(false);
  const [printingUploadDialogStage, setPrintingUploadDialogStage] = React.useState<'uploading' | 'processing' | 'ready' | 'starting' | 'failed' | 'started'>('uploading');
  const [printingUploadDisplayProgress, setPrintingUploadDisplayProgress] = React.useState(0);
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
  const [activeArrangeOperation, setActiveArrangeOperation] = React.useState<'standard' | 'high_precision' | 'array' | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(
      EXPORT_THUMBNAIL_RENDER_OPTIONS_STORAGE_KEY,
      JSON.stringify(exportThumbnailRenderOptions),
    );
  }, [exportThumbnailRenderOptions]);
  const [isAutoArranging, setIsAutoArranging] = React.useState(false);
  const [arrangeOverlayElapsedSec, setArrangeOverlayElapsedSec] = React.useState(0);
  const [arrangeOverlayModelCount, setArrangeOverlayModelCount] = React.useState<number | null>(null);
  const [duplicateTotalCopies, setDuplicateTotalCopies] = React.useState(1);
  const [duplicateSpacingMm, setDuplicateSpacingMm] = React.useState(0.5);
  const showArrangeBlockingOverlay = isAutoArranging;

  const arrangeOverlayContent = React.useMemo(() => {
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

  const arrangeOverlayElapsedLabel = React.useMemo(() => {
    const total = Math.max(0, arrangeOverlayElapsedSec);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  }, [arrangeOverlayElapsedSec]);
  const [duplicateLayoutMode, setDuplicateLayoutMode] = React.useState<DuplicateLayoutMode>('auto');
  const [duplicateArrayCountX, setDuplicateArrayCountX] = React.useState(2);
  const [duplicateArrayCountY, setDuplicateArrayCountY] = React.useState(1);
  const [duplicateArrayCountZ, setDuplicateArrayCountZ] = React.useState(1);
  const [duplicateArrayGapX, setDuplicateArrayGapX] = React.useState(5);
  const [duplicateArrayGapY, setDuplicateArrayGapY] = React.useState(5);
  const [duplicateArrayGapZ, setDuplicateArrayGapZ] = React.useState(5);
  const [isDuplicating, setIsDuplicating] = React.useState(false);
  const effectiveDuplicateTotalCopies = React.useMemo(() => {
    if (duplicateLayoutMode === 'array') {
      const countX = Math.max(1, Math.round(duplicateArrayCountX));
      const countY = Math.max(1, Math.round(duplicateArrayCountY));
      const countZ = Math.max(1, Math.round(duplicateArrayCountZ));
      return Math.max(1, Math.min(128, countX * countY * countZ));
    }

    return Math.max(1, Math.round(duplicateTotalCopies));
  }, [
    duplicateArrayCountX,
    duplicateArrayCountY,
    duplicateArrayCountZ,
    duplicateLayoutMode,
    duplicateTotalCopies,
  ]);
  const isDuplicateSetupBlockingArrange = Boolean(scene.activeModel) && effectiveDuplicateTotalCopies > 1;
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
  const [supportRenderRefreshNonce, setSupportRenderRefreshNonce] = React.useState(0);
  const [gizmoResetNonce, setGizmoResetNonce] = React.useState(0);
  const [pendingDestructiveTransform, setPendingDestructiveTransform] = React.useState<{
    modelId: string;
    modelName: string;
    supportCount: number;
    operationLabel: string;
  } | null>(null);
  const dragDepthRef = React.useRef(0);
  const lastPrepareDropRef = React.useRef<{ signature: string; atMs: number }>({
    signature: '',
    atMs: 0,
  });
  const modelStatsCardContainerRef = React.useRef<HTMLDivElement | null>(null);
  const [modelStatsBottomClearancePx, setModelStatsBottomClearancePx] = React.useState(220);
  const arrangeHullFootprintCacheRef = React.useRef<Map<string, HullCacheEntry>>(new Map());
  const trackSupportCollectionsInHome = scene.mode !== 'support';
  const supportStateSnapshot = React.useSyncExternalStore(
    subscribeSupportState,
    trackSupportCollectionsInHome ? getHomeSupportCollectionsSnapshot : (() => EMPTY_HOME_SUPPORT_COLLECTIONS_SNAPSHOT),
    trackSupportCollectionsInHome ? getHomeSupportCollectionsSnapshot : (() => EMPTY_HOME_SUPPORT_COLLECTIONS_SNAPSHOT),
  );
  const supportBraceStateSnapshot = React.useSyncExternalStore(
    subscribeToSupportBraceStore,
    trackSupportCollectionsInHome ? getHomeSupportBraceCollectionsSnapshot : (() => EMPTY_HOME_SUPPORT_BRACE_COLLECTIONS_SNAPSHOT),
    trackSupportCollectionsInHome ? getHomeSupportBraceCollectionsSnapshot : (() => EMPTY_HOME_SUPPORT_BRACE_COLLECTIONS_SNAPSHOT),
  );
  const raftSettingsSnapshot = React.useSyncExternalStore(subscribeToRaftStore, getRaftSettings, getRaftSettings);
  const bracePlacementSnapshot = React.useSyncExternalStore(
    bracePlacementStore.subscribe,
    bracePlacementStore.getSnapshot,
    bracePlacementStore.getSnapshot,
  );

  React.useEffect(() => {
    transformDebugTimelineRef.current.supportStoreUpdatedAt = {
      perfMs: performance.now(),
      epochMs: Date.now(),
    };
    lastSupportStoreUpdatePerfRef.current = transformDebugTimelineRef.current.supportStoreUpdatedAt.perfMs;
  }, [supportStateSnapshot]);

  React.useEffect(() => {
    transformDebugTimelineRef.current.supportBraceStoreUpdatedAt = {
      perfMs: performance.now(),
      epochMs: Date.now(),
    };
    lastSupportBraceStoreUpdatePerfRef.current = transformDebugTimelineRef.current.supportBraceStoreUpdatedAt.perfMs;
  }, [supportBraceStateSnapshot]);

  React.useEffect(() => {
    if (!holdSupportDragDeltaUntilSupportSync) return;

    const releasedAt = pendingSupportSyncReleasePerfRef.current;
    if (releasedAt == null) return;

    const synced =
      lastSupportStoreUpdatePerfRef.current > releasedAt
      || lastSupportBraceStoreUpdatePerfRef.current > releasedAt;

    if (!synced) return;

    setHoldSupportDragDeltaUntilSupportSync(false);
    pendingSupportSyncReleasePerfRef.current = null;
    if (typeof window !== 'undefined' && supportSyncFallbackTimeoutRef.current !== null) {
      window.clearTimeout(supportSyncFallbackTimeoutRef.current);
      supportSyncFallbackTimeoutRef.current = null;
    }
  }, [holdSupportDragDeltaUntilSupportSync, supportBraceStateSnapshot, supportStateSnapshot]);

  React.useEffect(() => {
    const activeModel = scene.models.find((m) => m.id === scene.activeModelId);
    if (!activeModel) {
      activeModelStoreTransformKeyRef.current = null;
      return;
    }

    const t = activeModel.transform;
    const key = [
      activeModel.id,
      t.position.x.toFixed(6),
      t.position.y.toFixed(6),
      t.position.z.toFixed(6),
      t.rotation.x.toFixed(6),
      t.rotation.y.toFixed(6),
      t.rotation.z.toFixed(6),
      t.scale.x.toFixed(6),
      t.scale.y.toFixed(6),
      t.scale.z.toFixed(6),
    ].join('|');

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
      setSupportShaftHoverDebug({
        segmentId: detail?.segmentId ?? null,
        point: detail?.point ?? null,
      });
    };

    const handleShaftLeave = (evt: Event) => {
      const detail = (evt as CustomEvent<{ segmentId?: string | null }>).detail;
      setSupportShaftHoverDebug((prev) => {
        if (!detail?.segmentId || prev.segmentId === detail.segmentId) {
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
        supportBraces: 0,
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
    const supportBraces = Object.values(supportBraceStateSnapshot.supportBraces).filter((item) => item.modelId === modelId).length;

    return { trunks, branches, leaves, twigs, sticks, braces, roots, knots, supportBraces };
  }, [scene.activeModelId, supportBraceStateSnapshot.supportBraces, supportStateSnapshot.braces, supportStateSnapshot.branches, supportStateSnapshot.knots, supportStateSnapshot.leaves, supportStateSnapshot.roots, supportStateSnapshot.sticks, supportStateSnapshot.trunks, supportStateSnapshot.twigs]);

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
        supportBraceStoreUpdatedAt: timeline.supportBraceStoreUpdatedAt,
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
        trunks: Object.keys(supportStateSnapshot.trunks).length,
        branches: Object.keys(supportStateSnapshot.branches).length,
        leaves: Object.keys(supportStateSnapshot.leaves).length,
        twigs: Object.keys(supportStateSnapshot.twigs).length,
        sticks: Object.keys(supportStateSnapshot.sticks).length,
        braces: Object.keys(supportStateSnapshot.braces).length,
        roots: Object.keys(supportStateSnapshot.roots).length,
        knots: Object.keys(supportStateSnapshot.knots).length,
        supportBraces: Object.keys(supportBraceStateSnapshot.supportBraces).length,
      },
    };
  }, [scene.activeModelId, scene.models, supportBraceStateSnapshot.supportBraces, supportDragGroupRef, supportStateSnapshot.braces, supportStateSnapshot.branches, supportStateSnapshot.knots, supportStateSnapshot.leaves, supportStateSnapshot.roots, supportStateSnapshot.sticks, supportStateSnapshot.trunks, supportStateSnapshot.twigs, transformDebugTick, transformMgr.transform]);

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
    const supportBraceCount = Object.values(supportBraceStateSnapshot.supportBraces)
      .filter((supportBrace) => supportBrace.modelId === modelId)
      .length;

    return supportIds.roots.length
      + supportIds.trunks.length
      + supportIds.branches.length
      + supportIds.braces.length
      + supportIds.leaves.length
      + supportIds.twigs.length
      + supportIds.sticks.length
      + supportBraceCount;
  }, [supportBraceStateSnapshot.supportBraces, supportStateSnapshot]);

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
  }, [pendingDestructiveTransform, scene]);

  const handleCancelDestructiveTransform = React.useCallback(() => {
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
  const cameraResumeTimeoutRef = React.useRef<number | null>(null);
  const { getHotkey } = useHotkeyConfig();
  const supportSpotlightHoldHotkey = getHotkey('SUPPORTS', 'TEMP_SPOTLIGHT_HOLD');

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
      if (printingDisplayedLayerRafRef.current !== null) {
        window.cancelAnimationFrame(printingDisplayedLayerRafRef.current);
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
    }, 1000);
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
      if (!Number.isFinite(previous) || previous <= 0) {
        return Math.max(1, Math.min(payload.totalLayers, payload.layerIndex + 1));
      }
      return Math.max(1, Math.min(payload.totalLayers, previous));
    });
  }, []);

  const handleSlicingFinishedForPrinting = React.useCallback((payload: { totalLayers: number }) => {
    const totalLayers = Math.max(1, payload.totalLayers);
    setPrintingPreviewTotalLayers(totalLayers);
    setPrintingSelectedLayer(1);
    setPrintingDisplayedLayer(1);
    printingDisplayedLayerTargetRef.current = 1;
    scene.setMode('printing');
  }, [scene]);

  const handleSliceRunStartedForPrinting = React.useCallback(() => {
    setShouldAutoSliceOnExportEntry(false);
    clearPrintingLayerPreviewUrls();
    setPrintingPreviewTotalLayers(0);
    setPrintingSelectedLayer(1);
    setPrintingDisplayedLayer(1);
    printingDisplayedLayerTargetRef.current = 1;
    setPrintingArtifact(null);
    setPrintingArtifactIsInvalid(false);
    setPrintingReadyPlateId(null);
  }, [clearPrintingLayerPreviewUrls]);

  const selectedPrintingLayerPreviewUrl = React.useMemo(() => {
    if (printingDisplayedLayer < 1) return null;
    return printingLayerPreviewUrls[printingDisplayedLayer - 1] ?? null;
  }, [printingLayerPreviewUrls, printingDisplayedLayer]);

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
    void readPrintLayerPreviewPngFromPath(printingArtifact.nativeTempPath, layerNumber)
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

  // Show scrub preview while actively scrubbing, before settle completes,
  // or if the target PNG isn't loaded yet (avoids stale-frame flash).
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

  React.useEffect(() => {
    // Reset load state whenever we change the displayed layer's preview URL.
    setIsPrintingPngLoaded(false);
    if (!selectedPrintingLayerPreviewUrl) return;

    const loadNonce = ++printingPreviewLoadNonceRef.current;
    let cancelled = false;
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled) return;
      if (loadNonce !== printingPreviewLoadNonceRef.current) return;
      setIsPrintingPngLoaded(true);
    };
    image.onerror = () => {
      // Fail-open so we do not get stuck in scrub preview if decode/load fails once.
      if (cancelled) return;
      if (loadNonce !== printingPreviewLoadNonceRef.current) return;
      setIsPrintingPngLoaded(true);
    };
    image.src = selectedPrintingLayerPreviewUrl;

    return () => {
      cancelled = true;
    };
  }, [selectedPrintingLayerPreviewUrl]);

  const handlePrintingPreviewWheel = React.useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (printingPreviewTotalLayers <= 0) return;
    event.preventDefault();
    schedulePrintingPreviewSettle();

    const previousZoom = printingPreviewZoomRef.current;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const nextZoom = Math.max(1, Math.min(32, previousZoom * factor));

    if (Math.abs(nextZoom - previousZoom) < 1e-5) return;

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

    setPrintingPreviewZoom(nextZoom);
    queuePrintingPreviewPan(nextPan);
  }, [queuePrintingPreviewPan, schedulePrintingPreviewSettle, printingPreviewTotalLayers]);

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
    queuePrintingPreviewPan(nextPan);
    schedulePrintingPreviewSettle();
  }, [queuePrintingPreviewPan, schedulePrintingPreviewSettle]);

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
    const bitDepth = Math.max(0, Math.round(Number(activePrinterProfile?.bitDepth?.bits ?? 0)));
    const isNanodlpArtifact = (printingArtifact?.outputName ?? '').toLowerCase().endsWith('.nanodlp');

    if (!isNanodlpArtifact || printerWidth <= 0 || printerHeight <= 0) {
      return null;
    }

    const isLikely16kClass = printerWidth >= 15000 && printerWidth <= 15400;
    if (isLikely16kClass) {
      if (bitDepth === 3) {
        printerWidth = 15136;
      } else if (bitDepth === 8) {
        printerWidth = 15120;
      }
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
    activePrinterProfile?.bitDepth?.bits,
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
      lastPrintingLayerSyncPerfRef.current = 0;
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

  // Refs to batch displayed layer updates and avoid expensive re-renders during scrubbing
  const printingDisplayedLayerTargetRef = React.useRef(1);
  const printingSelectedLayerHasUrlRef = React.useRef(false);
  const printingDisplayedLayerRafRef = React.useRef<number | null>(null);

  // Track if selected layer has a URL available (without depending on whole array)
  React.useEffect(() => {
    printingSelectedLayerHasUrlRef.current = Boolean(printingLayerPreviewUrls[printingSelectedLayer - 1]);
  }, [printingSelectedLayer, printingLayerPreviewUrls]);

  // Sync displayed layer: during scrub prefer available previews;
  // once scrub ends, switch to selected layer immediately.
  React.useEffect(() => {
    if (isPrintingLayerScrubbing) {
      // During scrubbing: prefer selected layer if available, else keep current
      const nextTarget = printingSelectedLayerHasUrlRef.current ? printingSelectedLayer : printingDisplayedLayerTargetRef.current;
      
      if (printingDisplayedLayerTargetRef.current !== nextTarget) {
        printingDisplayedLayerTargetRef.current = nextTarget;
        
        // Batch updates to avoid excessive re-renders during rapid scrubbing
        if (printingDisplayedLayerRafRef.current !== null) {
          window.cancelAnimationFrame(printingDisplayedLayerRafRef.current);
        }
        printingDisplayedLayerRafRef.current = window.requestAnimationFrame(() => {
          printingDisplayedLayerRafRef.current = null;
          setPrintingDisplayedLayer(nextTarget);
        });
      }
    } else {
      // Not scrubbing: switch to selected layer immediately so we don't keep
      // showing the previous layer while waiting for settle/load.
      if (printingDisplayedLayerRafRef.current !== null) {
        window.cancelAnimationFrame(printingDisplayedLayerRafRef.current);
        printingDisplayedLayerRafRef.current = null;
      }
      if (printingDisplayedLayerTargetRef.current !== printingSelectedLayer) {
        printingDisplayedLayerTargetRef.current = printingSelectedLayer;
        setPrintingDisplayedLayer(printingSelectedLayer);
      }
    }
  }, [
    isPrintingLayerScrubbing,
    isPrintingPreviewSettled,
    printingSelectedLayer,
  ]);

  React.useEffect(() => {
    setIsPrintingSettledCanvasReady(false);
  }, [selectedPrintingLayerPreviewUrl]);

  const hasPrintingWorkspaceData = printingPreviewTotalLayers > 0 && printingArtifact !== null;

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
    setPrintingReadyPlateId(null);
    setPrintingPrintNowBusy(false);
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
    }
  }, []);

  const handleSlicingBenchmarkComplete = React.useCallback((benchmark: SliceExportResult['benchmark']) => {
    setPrintingSlicingBenchmark(benchmark);
  }, []);

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

  // First, check if we should even calculate volumes based on mode
  // This is a cheap check that prevents us from depending on support state changes during editing
  const shouldCalculateVolumes = scene.mode === 'export' || scene.mode === 'printing';

  const supportAndRaftResinMl = React.useMemo(() => {
    if (!shouldCalculateVolumes) return 0;

    // Expensive calculation ONLY runs when mode is export/printing
    const visibleModelIds = new Set(scene.models.filter((model) => model.visible).map((model) => model.id));
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
    for (const supportBrace of Object.values(supportBraceStateSnapshot.supportBraces)) {
      const firstDiameter = supportBrace.profile.terminalStartDiameterMm
        || supportBrace.segments[0]?.diameter
        || supportBrace.profile.bodyDiameterMm;
      if (firstDiameter && firstDiameter > 0) {
        topDiameterByRootId.set(supportBrace.rootId, firstDiameter);
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
    for (const root of Object.values(supportBraceStateSnapshot.roots)) {
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

    for (const supportBrace of Object.values(supportBraceStateSnapshot.supportBraces)) {
      if (!visibleModelIds.has(supportBrace.modelId)) continue;

      for (let i = 0; i < supportBrace.segments.length; i += 1) {
        const seg = supportBrace.segments[i];
        const root = supportBraceStateSnapshot.roots[supportBrace.rootId];
        const hostKnot = supportBraceStateSnapshot.knots[supportBrace.hostKnotId];
        const rootTopPos = root
          ? {
              x: root.transform.pos.x,
              y: root.transform.pos.y,
              z: root.transform.pos.z + Math.max(0, root.diskHeight) + Math.max(0, root.coneHeight),
            }
          : null;
        const start = i === 0
          ? (seg.bottomJoint?.pos ?? rootTopPos ?? { x: 0, y: 0, z: 0 })
          : (supportBrace.segments[i - 1].topJoint?.pos ?? seg.bottomJoint?.pos ?? rootTopPos ?? { x: 0, y: 0, z: 0 });
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
    shouldCalculateVolumes,
    computeFootprint,
    computeRaftOuterBoundary,
    raftSettingsSnapshot,
    scene.models,
    supportBraceStateSnapshot.knots,
    supportBraceStateSnapshot.roots,
    supportBraceStateSnapshot.supportBraces,
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
    let cancelled = false;
    const visibleModels = scene.models.filter((model) => model.visible);

    if (visibleModels.length === 0) {
      setPrintingEstimatedResinMl(null);
      setIsPrintingEstimatedResinBusy(false);
      return () => {
        cancelled = true;
      };
    }

    setIsPrintingEstimatedResinBusy(true);

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
      setPrintingEstimatedResinMl(found || totalWithSupports > 0 ? totalWithSupports : null);
      setIsPrintingEstimatedResinBusy(false);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [getOrComputeBaseResinMl, scene.models, supportAndRaftResinMl]);

  const estimatedVolumeMlLabel = React.useMemo(() => {
    const visible = scene.models.filter((model) => model.visible);
    if (visible.length === 0) return '—';
    if (isPrintingEstimatedResinBusy && printingEstimatedResinMl == null) return 'Calculating…';
    if (printingEstimatedResinMl == null) return '—';
    return `${printingEstimatedResinMl.toFixed(2)} mL`;
  }, [isPrintingEstimatedResinBusy, printingEstimatedResinMl, scene.models]);

  const modelStatsEstimatedPrintTimeLabel = React.useMemo(() => {
    if (!activeMaterialProfile) return '—';

    const visibleModels = scene.models.filter((model) => model.visible);
    if (visibleModels.length === 0) return '—';

    const layerHeightMm = Math.max(0.001, activeMaterialProfile.layerHeightMm || 0.05);
    let maxModelHeightMm = 0;

    for (const model of visibleModels) {
      const bbox = model.geometry.bbox;
      const sizeZ = Math.max(0, bbox.max.z - bbox.min.z);
      const sz = Math.abs(model.transform.scale.z || 1);
      maxModelHeightMm = Math.max(maxModelHeightMm, sizeZ * sz);
    }

    const totalLayers = Math.max(0, Math.ceil(maxModelHeightMm / layerHeightMm));
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
  }, [activeMaterialProfile, scene.models]);

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
  const canSendToPrinter = Boolean(
    printingArtifact
    && printingArtifact.outputName.toLowerCase().endsWith('.nanodlp')
    && activePrinterProfile?.networkSupport === 'nanodlp'
    && activePrinterProfile.networkConnection?.connected === true
    && (activePrinterProfile.networkConnection?.selectedMaterialId?.trim() ?? '').length > 0,
  );
  const canPrintNow = Boolean(
    printingReadyPlateId
    && activePrinterProfile?.networkSupport === 'nanodlp'
    && activePrinterProfile.networkConnection?.connected === true,
  );

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
    const currentPath = printingArtifact?.nativeTempPath?.trim() || null;
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
    if (!printingUploadDialogOpen) {
      setPrintingUploadDisplayProgress(printingSendProgress);
      return;
    }

    let raf = 0;
    const animate = () => {
      setPrintingUploadDisplayProgress((previous) => {
        const target = Math.max(0, Math.min(1, printingSendProgress));
        if (Math.abs(target - previous) < 0.0025) {
          return target;
        }
        return previous + ((target - previous) * 0.18);
      });
      raf = window.requestAnimationFrame(animate);
    };

    raf = window.requestAnimationFrame(animate);
    return () => {
      window.cancelAnimationFrame(raf);
    };
  }, [printingSendProgress, printingUploadDialogOpen]);

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

  const handleTopBarSaveScene = React.useCallback(async () => {
    const visibleModels = scene.models.filter((model) => model.visible);
    const scopeModels = visibleModels.length > 0 ? visibleModels : scene.models;

    const buildModelGroup = (model: typeof scene.models[number]): THREE.Group => {
      const group = new THREE.Group();
      const t = model.transform;
      group.position.copy(t.position);
      group.rotation.copy(t.rotation);
      group.scale.copy(t.scale);

      const centerOffset = model.geometry.center;
      const mesh = new THREE.Mesh(model.geometry.geometry);
      mesh.position.set(-centerOffset.x, -centerOffset.y, -centerOffset.z);

      group.add(mesh);
      group.updateMatrixWorld(true);
      return group;
    };

    const exportRoot = new THREE.Group();
    scopeModels.forEach((model) => exportRoot.add(buildModelGroup(model)));
    exportRoot.updateMatrixWorld(true);

    await ExportManager.exportScene(
      scopeModels.length > 0 ? exportRoot : null,
      supportsRef.current || null,
      {
        filename: 'Scene',
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
      },
    );
  }, [scene.activeModelId, scene.models, scene.selectedModelIds]);

  const isDesktopRuntime = React.useCallback(() => {
    if (typeof window === 'undefined') return false;
    return window.location.protocol === 'tauri:'
      || window.location.protocol === 'file:'
      || window.location.hostname === 'tauri.localhost'
      || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  }, []);

  const buildSyntheticFileChangeEvent = React.useCallback((nextFiles: File[]): React.ChangeEvent<HTMLInputElement> => {
    const dt = new DataTransfer();
    nextFiles.forEach((file) => dt.items.add(file));
    const target = { files: dt.files, value: '' } as unknown as HTMLInputElement;
    return { target, currentTarget: target } as React.ChangeEvent<HTMLInputElement>;
  }, []);

  const pickFilesWithNativeDialog = React.useCallback(async (category: 'mesh' | 'scene', multiple: boolean): Promise<File[] | null> => {
    if (!isDesktopRuntime()) return null;

    try {
      const picked = await pickOpenFilesWithNativeDialog(category, multiple);
      if (!picked || picked.length === 0) return [];

      const core = await import('@tauri-apps/api/core');
      const files: File[] = [];

      for (const entry of picked) {
        try {
          const sourcePath = entry.path.trim();
          if (!sourcePath) continue;

          const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
          const name = entry.name || getFileNameFromPath(sourcePath);

          files.push(new File([new Uint8Array(bytes)], name, {
            type: getDroppedFileMimeType(name),
            lastModified: Date.now(),
          }));
        } catch (error) {
          console.warn(`[Picker] Failed reading picked file path: ${entry.path}`, error);
        }
      }

      return files;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? '');
      const cancelled = message.toLowerCase().includes('cancel');
      if (cancelled) return [];
      console.warn(`[Picker] Native ${category} picker failed, falling back to web input.`, error);
      return null;
    }
  }, [isDesktopRuntime]);

  const pickFilesWithWebInput = React.useCallback((accept: string, multiple: boolean): Promise<File[]> => {
    return new Promise((resolve) => {
      if (typeof document === 'undefined') {
        resolve([]);
        return;
      }

      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;

      input.onchange = () => {
        resolve(Array.from(input.files ?? []));
      };

      input.click();
    });
  }, []);

  const handleOpenMeshDialog = React.useCallback(async () => {
    const nativeFiles = await pickFilesWithNativeDialog('mesh', true);
    if (nativeFiles) {
      if (nativeFiles.length === 0) return;
      scene.onFileChange(buildSyntheticFileChangeEvent(nativeFiles));
      return;
    }

    const webFiles = await pickFilesWithWebInput('.stl,.3mf', true);
    if (webFiles.length === 0) return;
    scene.onFileChange(buildSyntheticFileChangeEvent(webFiles));
  }, [buildSyntheticFileChangeEvent, pickFilesWithNativeDialog, pickFilesWithWebInput, scene]);

  const handleOpenSceneDialog = React.useCallback(async () => {
    const nativeFiles = await pickFilesWithNativeDialog('scene', false);
    if (nativeFiles) {
      if (nativeFiles.length === 0) return;
      scene.onImportLysChange(buildSyntheticFileChangeEvent([nativeFiles[0]]));
      return;
    }

    const webFiles = await pickFilesWithWebInput('.voxl,.lys', false);
    if (webFiles.length === 0) return;
    scene.onImportLysChange(buildSyntheticFileChangeEvent([webFiles[0]]));
  }, [buildSyntheticFileChangeEvent, pickFilesWithNativeDialog, pickFilesWithWebInput, scene]);

  const handleTopBarOpenScene = React.useCallback(() => {
    void handleOpenSceneDialog();
  }, [handleOpenSceneDialog]);

  const handleSendToPrinter = React.useCallback(async () => {
    if (!printingArtifact || !activePrinterProfile) return;
    if (activePrinterProfile.networkSupport !== 'nanodlp') return;
    if (activePrinterProfile.networkConnection?.connected !== true) return;

    const host = (activePrinterProfile.networkConnection.ipAddress || activePrinterProfile.network?.ipAddress || '').trim();
    const port = activePrinterProfile.networkConnection.port || 80;
    const selectedMaterialId = (activePrinterProfile.networkConnection.selectedMaterialId ?? '').trim();
    if (!host) {
      setPrintingSendStatusText('No printer IP address available for send operation.');
      return;
    }
    if (!selectedMaterialId) {
      setPrintingSendStatusText('No NanoDLP material profile selected. Choose one in Printer Settings first.');
      return;
    }

    setPrintingReadyPlateId(null);
    setPrintingSendBusy(true);
    setPrintingSendProgress(0.01);
    setPrintingSendStageText('Uploading print job…');
    setPrintingSendStatusText('Uploading print job to printer…');
    setPrintingUploadDialogStage('uploading');
    setPrintingUploadDialogOpen(true);
    setPrintingDeviceProcessingStartedAtMs(null);
    setPrintingDeviceProcessingElapsedSec(0);

    try {
      const nativeTempPath = printingArtifact.nativeTempPath?.trim() || '';
      let zipBase64: string | undefined;

      // Prefer native temp-path handoff (avoids huge JS base64 payloads and intermittent truncation).
      // Fall back to base64 only when we do not have a valid temp-path artifact.
      if (!nativeTempPath) {
        const bytes = printingArtifact.blob
          ? new Uint8Array(await printingArtifact.blob.arrayBuffer())
          : null;

        if (!bytes || bytes.length === 0) {
          throw new Error('No print artifact payload available for printer upload.');
        }

        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          const chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode(...chunk);
        }
        zipBase64 = btoa(binary);
      }

      const pathBase = printingArtifact.outputName.replace(/\.[^.]+$/i, '');

      const response = await pluginNetworkFetch({
        pluginId: 'athena',
        operation: 'nanodlp/job/import',
        ipAddress: host,
        port,
        zipBase64,
        zipFilePath: nativeTempPath || undefined,
        path: pathBase,
        profileId: selectedMaterialId,
      });

      const payload = await response.json().catch(() => ({} as any));
      if (!(response.ok && payload?.ok)) {
        const reason = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        setPrintingSendStatusText(`Send failed: ${reason}`);
        setPrintingSendStageText('Upload failed');
        setPrintingUploadDialogStage('failed');
        setPrintingSendProgress(0);
        return;
      }

      const importedPlateId = Number(payload?.plateId);
      let resolvedPlateId = Number.isFinite(importedPlateId) && importedPlateId > 0 ? importedPlateId : null;

      setPrintingSendProgress(1);
      setPrintingUploadDialogStage('processing');
      setPrintingSendStageText('Processing on device…');
      setPrintingSendStatusText('Upload complete. NanoDLP is processing file metadata…');
      setPrintingDeviceProcessingStartedAtMs(Date.now());

      const startedAt = Date.now();
      const timeoutMs = 10 * 60 * 1000;
      const pollMs = 1250;
      let metadataReady = false;
      let pollFailureCount = 0;

      while ((Date.now() - startedAt) < timeoutMs) {
        try {
          const responseReady = await pluginNetworkFetch({
            pluginId: 'athena',
            operation: 'nanodlp/plates/list/json',
            ipAddress: host,
            port,
            plateId: resolvedPlateId,
            jobName: pathBase,
          });

          const readyPayload = await responseReady.json().catch(() => ({} as any));
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
      }

      if (resolvedPlateId) {
        setPrintingReadyPlateId(resolvedPlateId);
      }

      if (metadataReady) {
        setPrintingSendProgress(1);
        setPrintingSendStageText('Ready to print');
        setPrintingUploadDialogStage('ready');
        setPrintingDeviceProcessingStartedAtMs(null);
        setPrintingSendStatusText(
          `Import complete${resolvedPlateId ? ` • Plate #${resolvedPlateId}` : ''}. Click Print Now when ready.`,
        );
      } else {
        setPrintingSendProgress(1);
        setPrintingSendStageText('Device still processing');
        setPrintingUploadDialogStage('failed');
        setPrintingDeviceProcessingStartedAtMs(null);
        setPrintingSendStatusText(
          `Upload complete${resolvedPlateId ? ` • Plate #${resolvedPlateId}` : ''}. Device is still processing metadata after waiting.`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setPrintingSendStatusText(`Send failed: ${message}`);
      setPrintingSendStageText('Upload failed');
      setPrintingUploadDialogStage('failed');
      setPrintingDeviceProcessingStartedAtMs(null);
      setPrintingSendProgress(0);
    } finally {
      setPrintingSendBusy(false);
    }
  }, [activePrinterProfile, printingArtifact]);

  const handlePrintNow = React.useCallback(async () => {
    if (!activePrinterProfile) return;
    if (activePrinterProfile.networkSupport !== 'nanodlp') return;
    if (activePrinterProfile.networkConnection?.connected !== true) return;
    if (!printingReadyPlateId) return;

    const host = (activePrinterProfile.networkConnection.ipAddress || activePrinterProfile.network?.ipAddress || '').trim();
    const port = activePrinterProfile.networkConnection.port || 80;
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
        pluginId: 'athena',
        operation: 'nanodlp/printer/start',
        ipAddress: host,
        port,
        plateId: printingReadyPlateId,
      });

      const payload = await response.json().catch(() => ({} as any));
      if (response.ok && payload?.ok) {
        setPrintingSendStageText('Print started');
        setPrintingUploadDialogStage('started');
        setPrintingSendStatusText(`Print started successfully${printingReadyPlateId ? ` • Plate #${printingReadyPlateId}` : ''}.`);
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
  }, [activePrinterProfile, printingReadyPlateId]);

  const handlePrintingLayerChange = React.useCallback((nextLayer: number) => {
    if (!Number.isFinite(nextLayer)) return;
    const clamped = clampPrintingLayer(nextLayer);

    const currentOrPending = pendingPrintingSelectedLayerRef.current ?? printingSelectedLayerRef.current;
    if (currentOrPending === clamped) {
      return;
    }

    schedulePrintingPreviewSettle();
    pendingPrintingSelectedLayerRef.current = clamped;

    if (printingSelectedLayerRafRef.current !== null) return;

    printingSelectedLayerRafRef.current = window.requestAnimationFrame(() => {
      printingSelectedLayerRafRef.current = null;
      const pending = pendingPrintingSelectedLayerRef.current;
      pendingPrintingSelectedLayerRef.current = null;
      if (pending == null) return;
      setPrintingSelectedLayer((previous) => (previous === pending ? previous : pending));
    });
  }, [clampPrintingLayer, schedulePrintingPreviewSettle]);

  const handlePrintingLayerScrubStart = React.useCallback(() => {
    setIsPrintingLayerScrubbing(true);
    schedulePrintingPreviewSettle();
  }, [schedulePrintingPreviewSettle]);

  const handlePrintingLayerScrubEnd = React.useCallback(() => {
    if (printingSelectedLayerRafRef.current !== null) {
      window.cancelAnimationFrame(printingSelectedLayerRafRef.current);
      printingSelectedLayerRafRef.current = null;
    }
    const pending = pendingPrintingSelectedLayerRef.current;
    pendingPrintingSelectedLayerRef.current = null;
    if (pending != null) {
      setPrintingSelectedLayer((previous) => (previous === pending ? previous : pending));
    }
    setIsPrintingLayerScrubbing(false);
    // Immediately show the proper PNG for the selected layer when released
    setPrintingDisplayedLayer((previous) => {
      const targetLayer = pending ?? previous;
      return Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), targetLayer));
    });
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

  const handleDroppedPrepareFiles = React.useCallback(async (files: File[]) => {
    if (scene.mode !== 'prepare') return;

    const supportedFiles = files.filter((file) => isSupportedPrepareDropName(file.name));
    if (supportedFiles.length === 0) {
      console.warn('[DragDrop] No supported files dropped. Supported: .stl, .3mf, .lys, .voxl');
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
      return ext === '.stl' || ext === '.3mf';
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
      const sceneEvent = buildSyntheticFileChangeEvent([sceneFiles[0]]);
      scene.onImportLysChange(sceneEvent);
      return;
    }

    if (meshFiles.length > 0) {
      // Use the same handler as the Load Mesh button.
      const meshEvent = buildSyntheticFileChangeEvent(meshFiles);
      scene.onFileChange(meshEvent);
    }
  }, [scene]);

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
          const bytes = await core.invoke<ArrayBuffer>('read_print_file_bytes', { sourcePath });
          const name = getFileNameFromPath(sourcePath);
          files.push(new File([new Uint8Array(bytes)], name, {
            type: getDroppedFileMimeType(name),
            lastModified: Date.now(),
          }));
        } catch (error) {
          console.warn(`[DragDrop] Failed reading dropped file path: ${sourcePath}`, error);
        }
      }

      return files;
    } catch {
      return [] as File[];
    }
  }, []);

  React.useEffect(() => {
    if (scene.mode !== 'prepare') return;
    if (typeof window === 'undefined') return;

    const isLikelyDesktopRuntime =
      window.location.protocol === 'tauri:'
      || window.location.protocol === 'file:'
      || window.location.hostname === 'tauri.localhost'
      || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

    if (!isLikelyDesktopRuntime) return;

    const unlisten: Array<() => void> = [];
    let disposed = false;

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        const unlistenDragOver = await listen('tauri://drag-over', () => {
          if (disposed || scene.mode !== 'prepare') return;
          setIsPrepareDragActive(true);
        });
        unlisten.push(unlistenDragOver);

        const hideOverlay = () => {
          dragDepthRef.current = 0;
          setIsPrepareDragActive(false);
        };

        const unlistenDragLeave = await listen('tauri://drag-leave', () => {
          if (disposed) return;
          hideOverlay();
        });
        unlisten.push(unlistenDragLeave);

        const unlistenDragCancelled = await listen('tauri://drag-drop-cancelled', () => {
          if (disposed) return;
          hideOverlay();
        });
        unlisten.push(unlistenDragCancelled);

        const unlistenDragDrop = await listen<unknown>('tauri://drag-drop', (event) => {
          if (disposed || scene.mode !== 'prepare') return;

          hideOverlay();

          const paths = extractTauriDroppedPaths(event.payload);
          if (paths.length === 0) return;

          void (async () => {
            const files = await createFilesFromTauriDroppedPaths(paths);
            if (files.length === 0) return;
            await handleDroppedPrepareFiles(files);
          })();
        });
        unlisten.push(unlistenDragDrop);
      } catch {
        // Ignore in non-Tauri environments or when listeners are unavailable.
      }
    })();

    return () => {
      disposed = true;
      while (unlisten.length > 0) {
        const remove = unlisten.pop();
        try {
          remove?.();
        } catch {
          // noop
        }
      }
    };
  }, [createFilesFromTauriDroppedPaths, handleDroppedPrepareFiles, scene.mode]);

  const handlePrepareDragEnter = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    if (!isLikelyFileDragPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current += 1;
    setIsPrepareDragActive(true);
  }, [scene.mode]);

  const handlePrepareDragOver = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (scene.mode !== 'prepare') return;
    if (!isLikelyFileDragPayload(e.dataTransfer)) return;
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
    void handleDroppedPrepareFiles(files);
  }, [handleDroppedPrepareFiles, scene.mode]);

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

    const undoCountBefore = getUndoCount();
    const pushed = scene.commitModelTransformHistory(pending.modelId, pending.before, afterTransform, pending.description);
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
  }, [invalidatePendingTransformHistory, isFiniteTransform, scene, transformMgr.pendingTransformRef, transformMgr.transform, transformsApproximatelyEqual]);

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

    sceneImportToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsSceneImportToastVisible(false);
      sceneImportToastFadeTimeoutRef.current = null;
    }, 3800);

    return () => {
      if (sceneImportToastFadeTimeoutRef.current !== null) {
        window.clearTimeout(sceneImportToastFadeTimeoutRef.current);
        sceneImportToastFadeTimeoutRef.current = null;
      }
    };
  }, [scene.sceneImportReport]);

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
    const handleDiagnosticsHotkey = (event: KeyboardEvent) => {
      const isCtrlShiftD = event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd';
      if (!isCtrlShiftD) return;

      // Important: block browser default (e.g. "Bookmark all tabs").
      event.preventDefault();
      event.stopPropagation();
      setIsDiagnosticsOpen((prev) => !prev);
    };

    const handleHistoryDebugHotkey = (event: KeyboardEvent) => {
      const isCtrlShiftC = event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c';
      if (!isCtrlShiftC) return;

      event.preventDefault();
      event.stopPropagation();
      setIsHistoryDebugOpen((prev) => !prev);
    };

    const handleTransformDebugOverlayHotkey = (event: KeyboardEvent) => {
      const isCtrlShiftX = event.ctrlKey
        && event.shiftKey
        && (event.code === 'KeyX' || event.key.toLowerCase() === 'x');
      if (!isCtrlShiftX) return;

      event.preventDefault();
      event.stopPropagation();
      setIsTransformDebugOverlayOpen((prev) => !prev);
    };

    const handleSliceMetricsDebugHotkey = (event: KeyboardEvent) => {
      const isCtrlShiftA = event.ctrlKey
        && event.shiftKey
        && (event.code === 'KeyA' || event.key.toLowerCase() === 'a');
      if (!isCtrlShiftA) return;

      // Only toggle when we actually have slicing metrics from a completed run.
      if (!printingSlicingBenchmark) return;

      event.preventDefault();
      event.stopPropagation();
      setIsSliceMetricsDebugOpen((prev) => !prev);
    };

    window.addEventListener('keydown', handleDiagnosticsHotkey, true);
    window.addEventListener('keydown', handleHistoryDebugHotkey, true);
    window.addEventListener('keydown', handleTransformDebugOverlayHotkey, true);
    window.addEventListener('keydown', handleSliceMetricsDebugHotkey, true);
    return () => {
      window.removeEventListener('keydown', handleDiagnosticsHotkey, true);
      window.removeEventListener('keydown', handleHistoryDebugHotkey, true);
      window.removeEventListener('keydown', handleTransformDebugOverlayHotkey, true);
      window.removeEventListener('keydown', handleSliceMetricsDebugHotkey, true);
    };
  }, [printingSlicingBenchmark]);

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
  }, [displayActiveModelId, invalidatePendingTransformHistory, isFiniteTransform, scene.activeModel, scene.activeModelId, scene.updateModelTransform, transformMgr.transform, transformMgr.transformHook]);

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
  const sceneZRange = React.useMemo(() => {
    const projected = buildProjectedCrossSectionZRange(scene.models);
    if (projected) return projected;

    return {
      min: scene.sceneBounds?.min.z ?? 0,
      max: scene.sceneBounds?.max.z ?? 100, // Default range if empty
    };
  }, [
    scene.models,
    scene.sceneBounds,
    supportStateSnapshot,
    supportBraceStateSnapshot,
    raftSettingsSnapshot,
  ]);

  const slicing = useSlicingManager({
    hasGeometry: scene.models.length > 0,
    zRange: sceneZRange
  });

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
    const profileLayerHeightMm = Math.max(0.001, Number(activeMaterialProfile?.layerHeightMm ?? 0.05));
    const targetMicron = Math.max(1, Math.round(profileLayerHeightMm * 1000));
    if (slicing.layerHeightMicron !== targetMicron) {
      slicing.setLayerHeightMicron(targetMicron);
    }
  }, [
    activeMaterialProfile?.layerHeightMm,
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
      printingDisplayedLayerTargetRef.current = 1;
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

  // Lock printing workspace when no models exist
  React.useEffect(() => {
    if (scene.models.length === 0 && scene.mode === 'printing') {
      // Reset to prepare mode if we delete the last model while in printing
      scene.setMode('prepare');
      setPrintingArtifact(null);
      setPrintingArtifactIsInvalid(false);
    }
  }, [scene.models.length, scene.mode, scene, printingArtifact]);

  // Show re-slice modal when entering printing with invalid artifact
  React.useEffect(() => {
    if (scene.mode === 'printing' && printingArtifactIsInvalid && printingArtifact) {
      setShowPrintingResliceModal(true);
    }
  }, [scene.mode, printingArtifactIsInvalid, printingArtifact]);

  React.useEffect(() => {
    if (scene.mode !== 'printing') return;
    const clamped = Math.max(1, Math.min(Math.max(1, printingPreviewTotalLayers), printingSelectedLayer));

    if (isPrintingLayerScrubbing) {
      const now = performance.now();
      if ((now - lastPrintingLayerSyncPerfRef.current) < 42) {
        return;
      }
      lastPrintingLayerSyncPerfRef.current = now;
    } else {
      lastPrintingLayerSyncPerfRef.current = 0;
    }

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
    isPrintingLayerScrubbing,
  ]);

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
    if (nextMode === 'printing' && !hasPrintingWorkspaceData) {
      return;
    }
    scene.setMode(nextMode);
  }, [hasPrintingWorkspaceData, scene]);

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

  const supportBoundsByModelId = React.useMemo(() => {
    if (scene.mode !== 'prepare') {
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
    for (const supportBrace of Object.values(supportBraceStateSnapshot.supportBraces)) {
      if (supportBrace.modelId) knotModelById.set(supportBrace.hostKnotId, supportBrace.modelId);
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

    for (const supportBrace of Object.values(supportBraceStateSnapshot.supportBraces)) {
      const modelId = supportBrace.modelId;
      if (!modelId) continue;
      for (const seg of supportBrace.segments) {
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

    for (const knot of Object.values(supportBraceStateSnapshot.knots)) {
      const modelId = knotModelById.get(knot.id) ?? null;
      expand(modelId, knot.pos, Math.max(0.001, (knot.diameter ?? 1.2) / 2));
    }

    return boundsByModelId;
  }, [
    scene.mode,
    supportStateSnapshot.braces,
    supportStateSnapshot.branches,
    supportStateSnapshot.knots,
    supportStateSnapshot.leaves,
    supportStateSnapshot.roots,
    supportStateSnapshot.sticks,
    supportStateSnapshot.trunks,
    supportStateSnapshot.twigs,
    supportBraceStateSnapshot.knots,
    supportBraceStateSnapshot.supportBraces,
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

    const meshBounds = computeApproxModelWorldBounds(
      model.geometry,
      effectiveTransform,
    );

    const supportBoundsBase = supportBoundsByModelId.get(model.id);
    const combinedBounds = meshBounds.clone();
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
      combinedBounds.union(transformedSupportBounds);
    }

    return {
      width: Math.max(2, combinedBounds.max.x - combinedBounds.min.x),
      depth: Math.max(2, combinedBounds.max.y - combinedBounds.min.y),
      height: Math.max(2, combinedBounds.max.z - combinedBounds.min.z),
    };
  }, [computeApproxModelWorldBounds, getArrangeTransform, supportBoundsByModelId]);

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

    if (visibleModels.length <= 1) return;

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

          const dims = getModelSupportAwareDimensionsMm(model, angleZ, t);

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
      setActiveArrangeOperation(null);
      setArrangeOverlayModelCount(null);
    }
  }, [arrangeAllowRotateOnZ, arrangeAnchorMode, arrangeSpacingMm, getArrangeTransform, getModelSupportAwareDimensionsMm, isAutoArranging, resolveArrangeVisibleModels, scene, sleep, transformMgr, applyArrangeTransforms]);

  const handleHighPrecisionArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);
    if (visibleModels.length <= 1) return;

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

      const toHighPrecisionArrangeModel = (model: (typeof scene.models)[number]): HighPrecisionArrangeModel => {
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
      };

      const visibleIdSet = new Set(visibleModels.map((model) => model.id));
      const highPrecisionSceneModels = scene.models.map(toHighPrecisionArrangeModel);
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
    supportBoundsByModelId,
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
    getModelSupportAwareDimensionsMm,
    resolveArrangeVisibleModels,
  ]);

  const handleManualArrayArrangeModels = React.useCallback(async (scope: 'all' | 'selected', explicitSelectedIds?: string[]) => {
    if (isAutoArranging) return;

    const visibleModels = resolveArrangeVisibleModels(scope, explicitSelectedIds);
    if (visibleModels.length <= 1) return;

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
      transformMgr.setTransformMode('select');
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
    // Skip camera changes during automatic re-slice flow to prevent flickering
    if (shouldReturnToPrintingAfterSliceRef.current) return;
    
    const workspaceProjectionMode = getSavedWorkspaceCameraSettings().defaults[scene.mode];
    const currentProjectionMode = getSavedCameraProjectionSettings().mode;

    if (workspaceProjectionMode !== currentProjectionMode) {
      saveCameraProjectionSettings({ mode: workspaceProjectionMode });
    }
  }, [scene.mode]);

  React.useEffect(() => {
    // Skip selection highlight changes during automatic re-slice flow to prevent flickering
    if (shouldReturnToPrintingAfterSliceRef.current) return;
    
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

  const handleTransformEnd = (
    operation: 'move' | 'rotate' | 'scale',
    finalTransform?: ModelTransform,
    options?: { skipStoreCommit?: boolean },
  ) => {
    const stampNow = () => ({ perfMs: performance.now(), epochMs: Date.now() });
    const releasePerf = performance.now();
    pendingSupportSyncReleasePerfRef.current = releasePerf;
    setHoldSupportDragDeltaUntilSupportSync(true);
    if (typeof window !== 'undefined') {
      if (supportSyncFallbackTimeoutRef.current !== null) {
        window.clearTimeout(supportSyncFallbackTimeoutRef.current);
      }
      // Fallback release guard: avoid indefinite hold when no support updates occur.
      supportSyncFallbackTimeoutRef.current = window.setTimeout(() => {
        setHoldSupportDragDeltaUntilSupportSync(false);
        pendingSupportSyncReleasePerfRef.current = null;
        supportSyncFallbackTimeoutRef.current = null;
      }, 120);
    }

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
        scene.updateModelTransform(scene.activeModelId, {
          position: current.position.clone(),
          rotation: current.rotation.clone(),
          scale: current.scale.clone(),
        }, explicitBeforeTransform);
        transformDebugTimelineRef.current.storeUpdatedAt = stampNow();
        // Prevent the persistence effect from applying the same delta a second time
        transformEndFlushedRef.current = true;
      }
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
      };
      pendingRotateGizmoCommitRef.current = null;
    }

    if (pendingTransformHistoryRef.current && targetModelId && pendingTransformHistoryRef.current.modelId === targetModelId) {
      pendingTransformHistoryRef.current.description = `transform:${operation} ${targetModelName}`;
    }

    transformMgr.setIsTransforming(false);

    if (operation === 'rotate') {
      console.log('[Rotation] Clearing scan data - rotation invalidates island detection');
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

    scene.commitModelTransformHistory(
      payload.modelId,
      payload.before,
      payload.after,
      `transform:${payload.operation} ${targetModelName}`,
    );

    skipNextTransformEndCommitRef.current = {
      modelId: payload.modelId,
      operation: payload.operation,
    };
  }, [scene]);

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

    const formatVec3 = (v: THREE.Vector3) => `(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
    console.groupCollapsed(`[MultiGizmo][Page] ${payload.operation} commit`);
    console.log('selected models:', payload.entries.map((entry) => entry.modelId));
    console.log('model positions:', payload.entries.map((entry) => ({
      modelId: entry.modelId,
      position: formatVec3(entry.before.position),
    })));
    const draggedEntry = payload.entries.find((entry) => entry.modelId === scene.activeModelId) ?? payload.entries[0] ?? null;
    console.log('model dragged to:', draggedEntry ? {
      modelId: draggedEntry.modelId,
      position: formatVec3(draggedEntry.after.position),
    } : null);
    console.log('model updated position:', updates.map((entry) => ({
      modelId: entry.id,
      position: formatVec3(entry.transform.position),
    })));
    console.groupEnd();

    if (updates.length === 0) return;

    scene.updateModelTransforms(updates);

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
  }, [isFiniteTransform, scene, transformMgr.transformHook]);

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

    if (!pendingTransformHistoryRef.current || pendingTransformHistoryRef.current.modelId !== scene.activeModelId) {
      pendingTransformHistoryRef.current = {
        modelId: scene.activeModelId,
        before: {
          position: scene.activeModel.transform.position.clone(),
          rotation: scene.activeModel.transform.rotation.clone(),
          scale: scene.activeModel.transform.scale.clone(),
        },
        description: `transform:${operation} ${targetModelName}`,
      };
    }

    if (operation === 'rotate') {
      pendingRotateGizmoCommitRef.current = null;
    }

    transformMgr.setIsTransforming(true);
    return true;
  }, [requestDestructiveTransformSupportDeletion, scene.activeModel, scene.activeModelId, transformMgr]);

  const ensurePendingTransformHistoryForActiveModel = React.useCallback((operation: 'move' | 'rotate' | 'scale') => {
    if (!scene.activeModelId || !scene.activeModel) return;

    const targetModelName = (scene.activeModel.name ?? scene.activeModelId).trim();
    if (!pendingTransformHistoryRef.current || pendingTransformHistoryRef.current.modelId !== scene.activeModelId) {
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
  }, [isFiniteTransform, scene.activeModel, scene.activeModelId, transformMgr.transform]);

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

  React.useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const handleGlobalSelectAll = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'a') return;
      if (isEditableTarget(event.target)) return;
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
    if (scene.mode !== 'prepare' || transformMgr.transformMode !== 'arrange') {
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
        return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
      };

      const modelToRect = (m: (typeof scene.models)[number]): Rect2D => {
        const dims = getModelSupportAwareDimensionsMm(m, undefined, m.transform);
        const mW = dims.width;
        const mD = dims.depth;
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
    resolveArrangeVisibleModels,
    duplicateSpacingMm,
    duplicateTotalCopies,
    getModelSupportAwareDimensionsMm,
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

  const handleFillPlateDuplicate = React.useCallback(() => {
    if (isDuplicating) return;
    if (duplicateLayoutMode !== 'auto') return;
    const model = scene.activeModel;
    if (!model) return;

    const sourceDims = getModelSupportAwareDimensionsMm(model, undefined, model.transform);
    const width = sourceDims.width;
    const depth = sourceDims.depth;
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
      return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
    };

    const modelToRect = (m: (typeof scene.models)[number]): Rect2D => {
      const dims = getModelSupportAwareDimensionsMm(m, undefined, m.transform);
      const mW = dims.width;
      const mD = dims.depth;
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
  }, [duplicateLayoutMode, duplicateSpacingMm, getModelSupportAwareDimensionsMm, isDuplicating, scene]);

  return (
    <div className="ui-shell relative h-screen w-screen overflow-hidden" data-no-window-drag="true">
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
        mode={scene.mode}
        onModeChange={handleModeChange}
        hasModels={scene.models.length > 0}
        hasPrintingData={hasPrintingWorkspaceData}
        viewTypeOverride={sessionShaderOverride}
        onViewTypeOverrideChange={setSessionShaderOverride}
        heatmapColors={scene.heatmapColors}
        onHeatmapColorChange={scene.onHeatmapColorChange}
        isSlicingBusy={isSlicingBusy}
        onSaveScene={() => { void handleTopBarSaveScene(); }}
        onOpenScene={handleTopBarOpenScene}
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
              onOpenSupportsInfo={handleOpenModelSupportsInfo}
              onDelete={scene.deleteModel}
              onVisibilityChange={scene.setModelVisibility}
              onLoadMeshClick={() => { void handleOpenMeshDialog(); }}
              onLoadMeshChange={scene.onFileChange}
              onImportSceneClick={() => { void handleOpenSceneDialog(); }}
              onImportSceneChange={scene.onImportLysChange}
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
                onTransformCommit={scheduleCommitPendingTransformHistory}
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
              </>
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
          <>
            <ExportPanel
              key="export-main"
              models={scene.models}
              activeModel={scene.activeModel}
              activeModelId={scene.activeModelId}
              selectedModelIds={scene.selectedModelIds}
              onActiveModelChange={scene.setActiveModelId}
              supportsRef={supportsRef}
            />

            <SlicingPanel
              key="export-slicing"
              models={scene.models}
              activeModel={scene.activeModel}
              estimatedVolumeLabelOverride={estimatedVolumeMlLabel}
              captureSceneThumbnailPng={captureExportThumbnailPng}
              thumbnailIncludeGradient={exportThumbnailRenderOptions.includeGradient}
              thumbnailIncludeBuildPlate={exportThumbnailRenderOptions.includeBuildPlate}
              thumbnailIncludeGrid={exportThumbnailRenderOptions.includeGrid}
              onThumbnailRenderOptionsChange={(next) => {
                setExportThumbnailRenderOptions((previous) => ({
                  ...previous,
                  ...next,
                }));
              }}
              onSliceRunStarted={handleSliceRunStartedForPrinting}
              onLayerPreviewGenerated={handlePrintingLayerPreviewGenerated}
              onSlicingFinished={handleSlicingFinishedForPrinting}
              onSliceArtifactReady={handleSliceArtifactReady}
              onBenchmarkComplete={handleSlicingBenchmarkComplete}
              onSliceTriggerRef={triggerSliceExportRef}
              shouldAutoSlice={shouldAutoSliceOnExportEntry}
              skipThumbnailCapture={shouldReturnToPrintingAfterSliceRef.current}
              onSlicingBusyChange={setIsSlicingBusy}
            />
          </>

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
        ) : scene.mode === 'printing' ? (
          <>
            <PrintingPanel
              outputName={printingArtifact?.outputName ?? null}
              outputFormat={printingArtifact?.outputName?.split('.').pop() ? `.${printingArtifact.outputName.split('.').pop()}` : null}
              outputSizeLabel={printingOutputSizeLabel}
              printerName={activePrinterProfile?.name ?? 'No printer selected'}
              resinName={activeMaterialProfile?.name ?? 'No resin selected'}
              estimatedPrintTimeLabel={estimatedPrintTimeLabel}
              estimatedVolumeLabel={estimatedVolumeMlLabel}
              canDownload={canDownloadPrintArtifact}
              canSendToPrinter={canSendToPrinter}
              sendBusy={printingSendBusy}
              sendStatusText={printingSendStatusText}
              onDownload={handleDownloadPrintArtifact}
              onSendToPrinter={handleSendToPrinter}
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
              <div>SupportBraces: {transformDebugStats.supportCounts.supportBraces} / {activeSupportEntityCounts.supportBraces}</div>
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
                <div>SupportBrace store updated: {formatDebugTime(transformDebugStats.timeline.supportBraceStoreUpdatedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Active model store observed: {formatDebugTime(transformDebugStats.timeline.activeModelStoreObservedAt, transformDebugStats.timeline.nowPerfMs)}</div>
                <div>Release → Live: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.liveCalculatedAt)}</div>
                <div>Live → Store start: {formatDebugLatencyMs(transformDebugStats.timeline.liveCalculatedAt, transformDebugStats.timeline.storeUpdateStartedAt)}</div>
                <div>Store start → Store updated: {formatDebugLatencyMs(transformDebugStats.timeline.storeUpdateStartedAt, transformDebugStats.timeline.storeUpdatedAt)}</div>
                <div>Release → Store updated: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.storeUpdatedAt)}</div>
                <div>Release → Support store: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.supportStoreUpdatedAt)}</div>
                <div>Release → SupportBrace store: {formatDebugLatencyMs(transformDebugStats.timeline.dragReleasedAt, transformDebugStats.timeline.supportBraceStoreUpdatedAt)}</div>
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
          {scene.models.length === 0 && (
            <EmptySceneState
              onLoadMeshClick={() => { void handleOpenMeshDialog(); }}
              onFileChange={scene.onFileChange}
              onImportSceneClick={() => { void handleOpenSceneDialog(); }}
              onImportSceneChange={scene.onImportLysChange}
              onDropMeshFiles={handleDroppedPrepareFiles}
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
                  Drop supported files to import
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  Supported: STL, 3MF, LYS, VOXL
                </div>
              </div>
            </div>
          )}

          <SceneCanvas
            models={scene.models}
            activeModelId={displayActiveModelId}
            visualActiveModelId={scene.activeModelId}
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
            heatmapContrast={scene.heatmapContrast}
            heatmapColors={scene.heatmapColors}
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
            onTransformStart={handleTransformStart}
            onGizmoTransformCommit={handleGizmoTransformCommit}
            onGizmoTransformGroupCommit={handleGizmoTransformGroupCommit}
            onTransformChange={handleTransformChange}
            onTransformEnd={handleTransformEnd}
            mode={scene.mode}
            onSupportClick={supports.onModelClick}
            onSupportHover={supports.onModelHover}
            onActiveModelChange={handleSceneModelSelection}
            onMarqueeSelectionChange={handleSceneMarqueeSelection}
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
            supportDragGroupRef={supportDragGroupRef}
            holdSupportDragDelta={holdSupportDragDeltaUntilSupportSync}
            ghostData={ghostData}
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
          >
            {scene.mode === 'prepare' && transformMgr.transformMode === 'smoothing' && (
              <MeshSmoothingBrushCursor />
            )}
          </SceneCanvas>

          {/* Transform Toolbar */}
          {scene.models.length > 0 && scene.mode === 'prepare' && (
            <>
              <TransformToolbar
                mode={transformMgr.transformMode}
                onModeChange={transformMgr.setTransformMode}
              />
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
                numLayers={slicing.numLayers}
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
            style={{ gridTemplateColumns: '104px minmax(0, 1fr)', background: 'var(--surface-0)' }}
          >
            <div
              className="h-full border-r px-1 py-2"
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
                currentHeightMm={slicing.currentHeightMm}
                maxHeightMm={slicing.heightMm}
                showValue={true}
                crossSectionMode={slicing.crossSectionMode}
                docked
                embedded
                expandToContainer
                className="h-full"
              />
            </div>

            <div className="h-full min-h-0 min-w-0 p-3 flex flex-col gap-2 overflow-hidden">
              <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Layer PNG Preview
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
                {shouldShowScrubPreview ? (
                  // While scrubbing: render a vector cross-section instead of decoding PNGs.
                  // This avoids image-decode memory churn and gives instant visual feedback
                  // via the same loop data used by the 3-D cross-section cap.
                  // Wrap in aspect-ratio container to match PNG preview sizing behavior.
                  (() => {
                    const aspectW = printingPreviewTargetResolution
                      ? printingPreviewTargetResolution.viewportWidth
                      : activePrinterProfile?.buildVolumeMm?.width ?? 143;
                    const aspectH = printingPreviewTargetResolution
                      ? printingPreviewTargetResolution.viewportHeight
                      : activePrinterProfile?.buildVolumeMm?.depth ?? 89;
                    const aspectRatio = aspectW / aspectH;
                    return (
                      <div
                        className="block rounded"
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
                        <PrintingLayerScrubPreview
                          models={scene.models}
                          clipZ={printingSelectedLayer * slicing.layerHeightMm}
                          buildPlateWidthMm={activePrinterProfile?.buildVolumeMm?.width ?? 143}
                          buildPlateDepthMm={activePrinterProfile?.buildVolumeMm?.depth ?? 89}
                          mirrorX={activePrinterProfile?.display?.mirrorX === true}
                          mirrorY={activePrinterProfile?.display?.mirrorY === true}
                          className="block w-full h-full rounded"
                        />
                      </div>
                    );
                  })()
                ) : selectedPrintingLayerPreviewUrl ? (
                  printingPreviewTargetResolution ? (
                    <svg
                      viewBox={`0 0 ${printingPreviewTargetResolution.viewportWidth} ${printingPreviewTargetResolution.viewportHeight}`}
                      preserveAspectRatio="xMidYMid meet"
                      className="block w-full h-full max-w-full max-h-full rounded"
                      style={{
                        transform: printingPreviewVisualTransform || 'none',
                        transformOrigin: 'center center',
                        willChange: 'transform',
                      }}
                      role="img"
                      aria-label={`Layer ${printingSelectedLayer} preview`}
                    >
                      <image
                        href={selectedPrintingLayerPreviewUrl}
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
                      src={selectedPrintingLayerPreviewUrl}
                      alt={`Layer ${printingSelectedLayer} preview`}
                      className="block rounded max-w-full max-h-full w-auto h-auto object-contain"
                      style={{
                        imageRendering: 'pixelated',
                        transform: printingPreviewVisualTransform || 'none',
                        transformOrigin: 'center center',
                        willChange: 'transform',
                      }}
                    />
                  )
                ) : (
                  <div
                    className="h-full w-full rounded border border-dashed flex items-center justify-center text-xs"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                  >
                    No preview PNG available for this layer yet.
                  </div>
                )}

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

      <ModelSupportsModal
        isOpen={supportsInfoModelId !== null}
        onClose={() => setSupportsInfoModelId(null)}
        model={scene.models.find((m) => m.id === supportsInfoModelId) ?? null}
      />

      <DestructiveTransformModal
        isOpen={pendingDestructiveTransform !== null}
        modelName={pendingDestructiveTransform?.modelName ?? null}
        supportCount={pendingDestructiveTransform?.supportCount ?? 0}
        operationLabel={pendingDestructiveTransform?.operationLabel ?? 'Transform'}
        onCancel={handleCancelDestructiveTransform}
        onConfirm={handleConfirmDestructiveTransform}
      />

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
                  Upload to NanoDLP
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
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Plate</div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {printingReadyPlateId ? `#${printingReadyPlateId}` : 'Pending'}
                  </div>
                </div>
              </div>

              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {printingSendStatusText ?? 'Preparing upload pipeline…'}
              </div>

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
                    Processing on NanoDLP… elapsed {printingProcessingElapsedLabel}
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
                    className="h-full rounded-full transition-all duration-200"
                    style={{
                      width: `${printingDialogProgressPercent.toFixed(1)}%`,
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
              </div>
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

      {historyActionToast && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[125] flex justify-center px-3">
          <div
            className="flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold shadow-lg"
            style={{
              borderColor: historyActionToast.direction === 'undo'
                ? 'color-mix(in srgb, #fbbf24, var(--border-subtle) 50%)'
                : 'color-mix(in srgb, #60a5fa, var(--border-subtle) 50%)',
              background: historyActionToast.direction === 'undo'
                ? 'color-mix(in srgb, #fbbf24, var(--surface-0) 90%)'
                : 'color-mix(in srgb, #60a5fa, var(--surface-0) 90%)',
              color: 'var(--text-strong)',
              opacity: isHistoryActionToastVisible ? 1 : 0,
              transform: `translateY(${isHistoryActionToastVisible ? '0px' : '8px'})`,
              transition: 'opacity 220ms ease, transform 220ms ease',
            }}
          >
            {historyActionToast.direction === 'undo' ? (
              <Undo2 className="h-4 w-4 motion-safe:animate-pulse" />
            ) : (
              <Redo2 className="h-4 w-4 motion-safe:animate-pulse" />
            )}
            {historyActionToast.text}
          </div>
        </div>
      )}

      {scene.sceneImportReport && (
        <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[125] flex justify-center px-3">
          <div
            className="rounded-full border px-4 py-2 text-sm font-semibold shadow-lg"
            style={{
              borderColor: scene.sceneImportReport.tone === 'error'
                ? 'color-mix(in srgb, #ef4444, var(--border-subtle) 50%)'
                : scene.sceneImportReport.tone === 'warning'
                  ? 'color-mix(in srgb, #f59e0b, var(--border-subtle) 50%)'
                  : 'color-mix(in srgb, #22c55e, var(--border-subtle) 50%)',
              background: scene.sceneImportReport.tone === 'error'
                ? 'color-mix(in srgb, #ef4444, var(--surface-0) 90%)'
                : scene.sceneImportReport.tone === 'warning'
                  ? 'color-mix(in srgb, #f59e0b, var(--surface-0) 90%)'
                  : 'color-mix(in srgb, #22c55e, var(--surface-0) 90%)',
              color: 'var(--text-strong)',
              opacity: isSceneImportToastVisible ? 1 : 0,
              transform: `translateY(${isSceneImportToastVisible ? '0px' : '8px'})`,
              transition: 'opacity 220ms ease, transform 220ms ease',
            }}
          >
            {scene.sceneImportReport.text}
          </div>
        </div>
      )}

    </div>
  );
}
