'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, LayoutGrid, Maximize2, Minimize2, Play, Printer, Redo2, RefreshCw, Trash2, Undo2, X } from 'lucide-react';
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
import { PrintingLayerGpuPreview } from '@/components/controls/PrintingLayerGpuPreview';
import { SupportSidebar } from '@/supports/Settings';
import { ExportPanel } from '@/features/export/components/ExportPanel';
import { ExportManager } from '@/features/export/logic/ExportManager';
import { SlicingPanel } from '@/features/slicing/components/SlicingPanel';
import { PrintingPanel } from '@/features/printing/components/PrintingPanel';
import { SliceMetricsDebugModal } from '@/features/slicing/components/SliceMetricsDebugModal';
import { MeshSmoothingSettingsPanel } from '@/features/mesh-smoothing/MeshSmoothingSettingsPanel';
import { MeshSmoothingBrushCursor } from '@/features/mesh-smoothing/MeshSmoothingBrushCursor';
import { PlaceOnFaceTool } from '@/features/placeOnFace/PlaceOnFaceTool';
import { RtspRelayCanvasPlayer } from '@/components/monitoring/RtspRelayCanvasPlayer';
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
import { quaternionFromGlobalEuler } from '@/utils/rotation';
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
import {
  getSavedWorkspaceCameraSettings,
  getWorkspaceCameraSettingsServerSnapshot,
  getWorkspaceCameraSettingsSnapshot,
  subscribeToWorkspaceCameraSettings,
} from '@/components/settings/workspaceCameraPreferences';
import { openProfileSettingsModal } from '@/components/settings/profileModalEvents';
import {
  getProfileMonitoringUiAdapter,
  getProfileNetworkUiAdapter,
  type PrinterMonitoringSnapshot,
  type PrinterMonitoringWebcamInfo,
} from '@/features/plugins/pluginRegistry';
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
  pickOpenFilesWithNativeDialog,
  readPrintLayerPreviewPngFromPath,
  readPrintArtifactBytesFromPath,
  savePrintArtifactPathWithNativeDialog,
  savePrintArtifactWithNativeDialog,
} from '@/features/slicing/tauri/nativeSlicerBridge';
import { subscribe as subscribeSupportState, getSnapshot as getSupportSnapshot } from '@/supports/state';
import {
  getKickstandSnapshot,
  subscribeToKickstandStore,
} from '@/supports/SupportTypes/Kickstand/kickstandStore';
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
import { uploadPrintJobWithProgress, type PluginUploadProgressEvent } from '@/features/plugins/pluginUploadBridge';
import { pluginNetworkFetch } from '@/utils/pluginNetworkBridge';
import { fetchRtspRelayStatus } from '@/utils/rtspRelayBridge';

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

const EMPTY_SUPPORT_BOUNDS_BY_MODEL_ID = new Map<string, THREE.Box3>();

type HomeSupportSnapshot = ReturnType<typeof getSupportSnapshot>;
type HomeSupportCollectionsSnapshot = Pick<
  HomeSupportSnapshot,
  'trunks' | 'branches' | 'leaves' | 'twigs' | 'sticks' | 'braces' | 'roots' | 'knots'
>;

type HomeKickstandSnapshot = ReturnType<typeof getKickstandSnapshot>;
type HomeKickstandCollectionsSnapshot = Pick<
  HomeKickstandSnapshot,
  'kickstands' | 'roots' | 'knots'
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

const EMPTY_HOME_KICKSTAND_COLLECTIONS_SNAPSHOT: HomeKickstandCollectionsSnapshot = {
  kickstands: {},
  roots: {},
  knots: {},
};

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
  includeBuildPlate: false,
  includeGrid: false,
  centerOnModel: true,
};

const PREPARE_DROP_EXTENSIONS = new Set(['.stl', '.3mf', '.lys', '.voxl']);
const LYS_IMPORT_WARNING_DISMISSED_STORAGE_KEY = 'dragonfruit.lysImportWarningDismissed';
const REMOTE_OFFLINE_LAYER_HEIGHT_STORAGE_KEY_PREFIX = 'dragonfruit.slicing.remoteOfflineLayerHeightMm.';
const SUPPORT_DRAG_HOLD_FALLBACK_MS = 320;
const DEFAULT_MONITOR_BUSY_GRACE_MS = 30_000;
const REACHABILITY_PROBE_TIMEOUT_MS = 7_500;
const DEFAULT_WEBCAM_TIMEOUT_COOLDOWN_MS = 20_000;
const DEFAULT_WEBCAM_FAILURE_COOLDOWN_MS = 8_000;
const DEFAULT_WEBCAM_MAX_CONSECUTIVE_TIMEOUTS = 3;
const DEFAULT_RTSP_DEBUG_POLL_MS = 4_000;
const DEFAULT_RELAY_AUTORETRY_LIMIT = 2;
const DEFAULT_RELAY_AUTORETRY_DELAY_MS = 1200;

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

function isSceneFileName(name: string): boolean {
  const ext = getFileExtension(name);
  return ext === '.voxl' || ext === '.lys';
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

export default function Home() {
  // 1. Scene & Geometry (Multi-Model)
  const scene = useSceneCollectionManager();
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const workspaceCameraSettings = React.useSyncExternalStore(
    subscribeToWorkspaceCameraSettings,
    getWorkspaceCameraSettingsSnapshot,
    getWorkspaceCameraSettingsServerSnapshot,
  );
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const activeMaterialProfile = React.useMemo(() => getActiveMaterialProfile(profileState), [profileState]);
  const networkSelectedMaterialLayerHeightMm = React.useMemo(() => {
    const profile = activePrinterProfile;
    if (!profile || !profile.networkSupport) return null;
    if (profile.networkConnection?.connected !== true) return null;
    const candidate = Number(profile.networkConnection?.selectedMaterialLayerHeightMm);
    if (!Number.isFinite(candidate) || candidate <= 0) return null;
    return candidate;
  }, [
    activePrinterProfile?.networkConnection?.connected,
    activePrinterProfile?.networkConnection?.selectedMaterialLayerHeightMm,
    activePrinterProfile?.networkSupport,
  ]);
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
  const [showLysImportWarningModal, setShowLysImportWarningModal] = React.useState(false);
  const [suppressLysImportWarning, setSuppressLysImportWarning] = React.useState(false);
  const [lysImportWarningSkipFuture, setLysImportWarningSkipFuture] = React.useState(false);
  const lysImportWarningPendingResolveRef = React.useRef<((proceed: boolean) => void) | null>(null);
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

  const [sessionShaderOverride, setSessionShaderOverride] = React.useState<MeshShaderType | null>(null);
  const effectiveShaderType = sessionShaderOverride ?? scene.shaderType;
  const [isPrepareDragActive, setIsPrepareDragActive] = React.useState(false);
  const [isSupportSpotlightHoldActive, setIsSupportSpotlightHoldActive] = React.useState(false);
  const [allowPrepareWithoutPrinter, setAllowPrepareWithoutPrinter] = React.useState(false);
  const [prepareSmoothingSettingsExpanded, setPrepareSmoothingSettingsExpanded] = React.useState(true);
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
  const [printingPngLoadedUrl, setPrintingPngLoadedUrl] = React.useState<string | null>(null);
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
  const slicedArtifactProfileFingerprintRef = React.useRef<string | null>(null);
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
  const [printingUploadTelemetry, setPrintingUploadTelemetry] = React.useState<{
    speed: string;
    remaining: string;
    transferred: string;
  } | null>(null);
  const [printingReadyPlateId, setPrintingReadyPlateId] = React.useState<number | null>(null);
  const [printingPrintNowBusy, setPrintingPrintNowBusy] = React.useState(false);
  const [printingUploadDialogOpen, setPrintingUploadDialogOpen] = React.useState(false);
  const [printingTargetPickerOpen, setPrintingTargetPickerOpen] = React.useState(false);
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

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(LYS_IMPORT_WARNING_DISMISSED_STORAGE_KEY);
      setSuppressLysImportWarning(stored === '1');
    } catch {
      setSuppressLysImportWarning(false);
    }
  }, []);

  React.useEffect(() => {
    return () => {
      if (lysImportWarningPendingResolveRef.current) {
        const resolve = lysImportWarningPendingResolveRef.current;
        lysImportWarningPendingResolveRef.current = null;
        resolve(false);
      }
    };
  }, []);

  const hasLysSceneFile = React.useCallback((filesInput: FileList | File[]) => {
    const files = Array.from(filesInput);
    return files.some((file) => file.name.trim().toLowerCase().endsWith('.lys'));
  }, []);

  const maybeConfirmLysImportWarning = React.useCallback(async (filesInput: FileList | File[]) => {
    if (suppressLysImportWarning) return true;
    if (!hasLysSceneFile(filesInput)) return true;

    if (lysImportWarningPendingResolveRef.current) {
      const pendingResolve = lysImportWarningPendingResolveRef.current;
      lysImportWarningPendingResolveRef.current = null;
      pendingResolve(false);
    }

    setLysImportWarningSkipFuture(false);
    setShowLysImportWarningModal(true);
    return await new Promise<boolean>((resolve) => {
      lysImportWarningPendingResolveRef.current = resolve;
    });
  }, [hasLysSceneFile, suppressLysImportWarning]);

  const resolveLysImportWarning = React.useCallback((proceed: boolean) => {
    const resolve = lysImportWarningPendingResolveRef.current;
    lysImportWarningPendingResolveRef.current = null;
    setLysImportWarningSkipFuture(false);
    setShowLysImportWarningModal(false);
    resolve?.(proceed);
  }, []);

  const handleCancelLysImportWarning = React.useCallback(() => {
    resolveLysImportWarning(false);
  }, [resolveLysImportWarning]);

  const handleContinueLysImportWarning = React.useCallback(() => {
    if (lysImportWarningSkipFuture) {
      setSuppressLysImportWarning(true);
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(LYS_IMPORT_WARNING_DISMISSED_STORAGE_KEY, '1');
        } catch {
          // Ignore persistence failure and still proceed.
        }
      }
    }
    resolveLysImportWarning(true);
  }, [lysImportWarningSkipFuture, resolveLysImportWarning]);

  const importSceneFilesWithLysWarning = React.useCallback(async (filesInput: FileList | File[]) => {
    const sceneFiles = Array.from(filesInput);
    if (sceneFiles.length === 0) return;

    const proceed = await maybeConfirmLysImportWarning(sceneFiles);
    if (!proceed) return;

    await scene.importSceneFiles(sceneFiles);
  }, [maybeConfirmLysImportWarning, scene]);

  const handleImportSceneInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const files = Array.from(e.target.files);
    void importSceneFilesWithLysWarning(files);
    e.target.value = '';
  }, [importSceneFilesWithLysWarning]);

  const handleReopenRecentFile = React.useCallback(async (entryId: string) => {
    const entry = scene.recentOpenedFiles.find((item) => item.id === entryId);
    if (!entry) return false;

    if (entry.kind === 'scene' && entry.name.trim().toLowerCase().endsWith('.lys')) {
      const proceed = await maybeConfirmLysImportWarning([
        new File([], entry.name, { type: 'application/octet-stream' }),
      ]);
      if (!proceed) return false;
    }

    return await scene.reopenRecentOpenedFile(entryId);
  }, [maybeConfirmLysImportWarning, scene.recentOpenedFiles, scene.reopenRecentOpenedFile]);
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
  const pendingDestructiveTransformContinueRef = React.useRef<(() => void) | null>(null);
  const dragDepthRef = React.useRef(0);
  const launchSceneFilesHandledRef = React.useRef(false);
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
        trunks: Object.keys(supportStateSnapshot.trunks).length,
        branches: Object.keys(supportStateSnapshot.branches).length,
        leaves: Object.keys(supportStateSnapshot.leaves).length,
        twigs: Object.keys(supportStateSnapshot.twigs).length,
        sticks: Object.keys(supportStateSnapshot.sticks).length,
        braces: Object.keys(supportStateSnapshot.braces).length,
        roots: Object.keys(supportStateSnapshot.roots).length,
        knots: Object.keys(supportStateSnapshot.knots).length,
        kickstands: Object.keys(kickstandStateSnapshot.kickstands).length,
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
    scene.setMode('printing');
  }, [scene]);

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
    const bitDepth = Math.max(0, Math.round(Number(activePrinterProfile?.bitDepth?.bits ?? 0)));
    const hasPrintableArtifact = (printingArtifact?.outputName ?? '').trim().length > 0;

    if (!hasPrintableArtifact || printerWidth <= 0 || printerHeight <= 0) {
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

  // First, check if we should even calculate volumes based on mode.
  // Printing-mode reopen with an existing artifact should stay responsive;
  // avoid re-running heavy support/raft volume aggregation in that case.
  const shouldCalculateVolumes = scene.mode === 'export' || (scene.mode === 'printing' && !printingArtifact);

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
    shouldCalculateVolumes,
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
    let cancelled = false;

    if (!shouldCalculateVolumes) {
      setIsPrintingEstimatedResinBusy(false);
      return () => {
        cancelled = true;
      };
    }

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
  }, [getOrComputeBaseResinMl, scene.models, shouldCalculateVolumes, supportAndRaftResinMl]);

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
  const activeNetworkUiAdapter = React.useMemo(
    () => getProfileNetworkUiAdapter(activePrinterProfile?.networkSupport),
    [activePrinterProfile?.networkSupport],
  );
  const remoteOfflineLayerHeightStorageKey = React.useMemo(() => {
    if (!activePrinterProfile) return null;
    const printerKey = activePrinterProfile.id?.trim()
      || activePrinterProfile.officialPresetId?.trim()
      || activePrinterProfile.name?.trim()
      || 'default';
    return `${REMOTE_OFFLINE_LAYER_HEIGHT_STORAGE_KEY_PREFIX}${printerKey}`;
  }, [activePrinterProfile?.id, activePrinterProfile?.name, activePrinterProfile?.officialPresetId]);
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
  const shouldUseRemoteOfflineLayerHeight = Boolean(activeNetworkUiAdapter) && (
    activePrinterProfile?.networkConnection?.connected !== true
    || selectedSliceDeviceReachability === false
  );
  const remoteOfflineSlicedLayerHeightMm = (() => {
    if (!activeNetworkUiAdapter) return null;
    if (!shouldUseRemoteOfflineLayerHeight) return null;
    if (typeof window === 'undefined' || !remoteOfflineLayerHeightStorageKey) return null;

    const raw = window.localStorage.getItem(remoteOfflineLayerHeightStorageKey)
      ?? window.sessionStorage.getItem(remoteOfflineLayerHeightStorageKey);
    if (raw == null || raw.trim().length === 0) return null;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.max(0.001, Math.min(1, parsed));
  })();
  const printingMonitoringAdapter = React.useMemo(
    () => getProfileMonitoringUiAdapter(activePrinterProfile?.networkSupport),
    [activePrinterProfile?.networkSupport],
  );
  const slicedLayerHeightMm = React.useMemo(() => {
    if (remoteOfflineSlicedLayerHeightMm != null) {
      return remoteOfflineSlicedLayerHeightMm;
    }
    if (networkSelectedMaterialLayerHeightMm != null) {
      return Math.max(0.001, Number(networkSelectedMaterialLayerHeightMm));
    }
    return Math.max(0.001, Number(activeMaterialProfile?.layerHeightMm ?? 0.05));
  }, [activeMaterialProfile?.layerHeightMm, networkSelectedMaterialLayerHeightMm, remoteOfflineSlicedLayerHeightMm]);
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

            const payload = await response.json().catch(() => ({} as any));
            if (!response.ok) return [target.id, false] as const;

            if (payload && typeof payload.ok === 'boolean') {
              return [target.id, payload.ok === true] as const;
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
  const printingResinName = React.useMemo(() => {
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

    return activeMaterialProfile?.name ?? 'No resin selected';
  }, [
    activeMaterialProfile?.name,
    activeNetworkUiAdapter,
    activePrinterProfile?.networkConnection?.connected,
    activePrinterProfile?.networkConnection?.selectedMaterialName,
    printingTargetDevice?.selectedMaterialName,
  ]);
  const sendToPrinterButtonLabel = sendToPrinterTargetName
    ? `Upload to ${sendToPrinterTargetName.length > 26 ? `${sendToPrinterTargetName.slice(0, 24)}…` : sendToPrinterTargetName}`
    : 'Send to Printer';
  const canSendToPrinter = Boolean(
    printingArtifact
    && activeNetworkUiAdapter
    && printableConnectedPrinterFleet.length > 0,
  );
  const requiresRemoteMaterialSelectionForUpload = Boolean(
    activeNetworkUiAdapter
    && activeNetworkUiAdapter.supportsRemoteMaterialProfiles !== false,
  );
  const canPrintNow = Boolean(
    printingReadyPlateId
    && printingTargetDevice?.connected === true,
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

              const payload = await response.json().catch(() => null) as any;
              if (payload && typeof payload.ok === 'boolean') {
                return payload.ok === true;
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
    return () => {
      if (printingUploadProcessingHandoffTimeoutRef.current !== null) {
        window.clearTimeout(printingUploadProcessingHandoffTimeoutRef.current);
        printingUploadProcessingHandoffTimeoutRef.current = null;
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
      let matching = parsed.filter((material) => isLayerHeightMatch(material.layerHeightMm));

      if (matching.length === 0 && (printingTargetDevice.selectedMaterialId?.trim() ?? '').length > 0 && isLayerHeightMatch(printingTargetDevice.selectedMaterialLayerHeightMm ?? null)) {
        matching = [{
          id: printingTargetDevice.selectedMaterialId!.trim(),
          name: printingTargetDevice.selectedMaterialName?.trim() || printingTargetDevice.selectedMaterialId!.trim(),
          layerHeightMm: printingTargetDevice.selectedMaterialLayerHeightMm ?? null,
        }];
      }

      setPrintingTargetMaterialOptions(matching);

      setPrintingTargetMaterialId((previousId) => {
        const preferredId = previousId.trim();
        const fallbackId = matching.find((material) => material.id === (printingTargetDevice.selectedMaterialId ?? '').trim())?.id
          ?? matching[0]?.id
          ?? '';
        return matching.some((material) => material.id === preferredId) ? preferredId : fallbackId;
      });

      if (matching.length === 0) {
        setPrintingTargetMaterialError(`No material on this printer matches sliced layer height ${slicedLayerHeightMm.toFixed(3)} mm.`);
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

        const payload = await response.json().catch(() => null) as any;
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

          const payload = await response.json().catch(() => ({} as any));
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

          const payload = await response.json().catch(() => ({} as any));
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

      const payload = await response.json().catch(() => ({} as any));
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
          const parsedPrintTimeSec = parsePrintingMonitorSeconds(rawPrintTime);
          const parsedUsedMaterialMl = parsePrintingMonitorMaterialMl(rawUsedMaterial);

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

        const payload = await response.json().catch(() => ({} as any));
        if (cancelled) return;
        const parsed = printingMonitoringAdapter.parseWebcamInfoPayload(payload, host, port);
        const elapsedMs = Date.now() - requestStartedAt;

        const parsedMessage = String(parsed?.message ?? '').toLowerCase();
        const payloadMessage = typeof payload?.message === 'string' ? payload.message.toLowerCase() : '';
        const ack = typeof payload?.ack === 'number' ? payload.ack : null;
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
              const payload = await response.json().catch(() => null) as { error?: unknown } | null;
              const reason = typeof payload?.error === 'string' && payload.error.trim().length > 0
                ? payload.error.trim()
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

            const payload = await response.json().catch(() => ({} as any));
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

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPrintingMonitorPrinterMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
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
    const nativeFiles = await pickFilesWithNativeDialog('scene', true);
    if (nativeFiles) {
      if (nativeFiles.length === 0) return;
      await importSceneFilesWithLysWarning(nativeFiles);
      return;
    }

    const webFiles = await pickFilesWithWebInput('.voxl,.lys', true);
    if (webFiles.length === 0) return;
    await importSceneFilesWithLysWarning(webFiles);
  }, [importSceneFilesWithLysWarning, pickFilesWithNativeDialog, pickFilesWithWebInput]);

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
    await importSceneFilesWithLysWarning(files);
    return true;
  }, [importSceneFilesWithLysWarning]);

  const importSceneFromPaths = React.useCallback(async (paths: string[]): Promise<boolean> => {
    if (!paths || paths.length === 0) return false;

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

    return importSceneFromLaunchEntries(entries);
  }, [importSceneFromLaunchEntries]);

  React.useEffect(() => {
    if (launchSceneFilesHandledRef.current) return;
    launchSceneFilesHandledRef.current = true;

    if (!isDesktopRuntime()) return;

    let cancelled = false;

    void (async () => {
      try {
        const core = await import('@tauri-apps/api/core');
        const launchEntries = await core.invoke<LaunchSceneFileEntry[]>('get_launch_scene_files');
        if (cancelled || !launchEntries || launchEntries.length === 0) return;

        const imported = await importSceneFromLaunchEntries(launchEntries);
        if (!imported) {
          console.warn('[LaunchOpen] App launched with file arguments, but no supported scene file (.voxl/.lys) was found.');
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('[LaunchOpen] Failed handling launch scene file arguments.', error);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [importSceneFromLaunchEntries, isDesktopRuntime]);

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

          void importSceneFromPaths(paths).catch((error) => {
            console.warn('[LaunchOpen] Failed importing handed-off scene file(s).', error);
          });
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
  }, [importSceneFromPaths, isDesktopRuntime]);

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
    setPrintingSendBusy(true);
    setPrintingSendProgress(0.01);
    setPrintingUploadDisplayProgress(0.01);
    setPrintingSendStageText('Uploading print job…');
    setPrintingSendStatusText('Uploading print job to printer…');
    setPrintingUploadTelemetry(null);
    setPrintingUploadDialogStage('uploading');
    setPrintingUploadDialogOpen(true);
    setPrintingDeviceProcessingStartedAtMs(null);
    setPrintingDeviceProcessingElapsedSec(0);

    try {
      const nativeTempPath = printingArtifact.nativeTempPath?.trim() || '';
      let zipBlob = printingArtifact.blob;

      // If we have a local temp path and no blob, read the blob from native bridge
      if (!zipBlob && nativeTempPath) {
        try {
          const fileBytes = await readPrintArtifactBytesFromPath(nativeTempPath);
          if (fileBytes && fileBytes.length > 0) {
            const normalizedBytes = Uint8Array.from(fileBytes);
            zipBlob = new Blob([normalizedBytes], { type: 'application/octet-stream' });
          }
        } catch (readError) {
          console.warn('Failed to read artifact from native path:', readError);
        }
      }

      if (!zipBlob) {
        throw new Error('No print artifact blob available for printer upload.');
      }

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
        path: pathBase,
        profileId: selectedMaterialId,
        callbacks: {
          onProgress: (event: PluginUploadProgressEvent) => {
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
            resolvedPlateId = plateId;
          },
        },
      });

      if (!uploadResult.ok) {
        throw new Error('Upload failed on printer backend');
      }

      const startedAt = Date.now();
      const timeoutMs = 10 * 60 * 1000;
      const pollMs = 1250;
      let metadataReady = false;
      let pollFailureCount = 0;

      while ((Date.now() - startedAt) < timeoutMs) {
        try {
          const responseReady = await pluginNetworkFetch({
            pluginId: printingMonitoringAdapter.pluginId,
            operation: printingMonitoringAdapter.operations.platesList,
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
      setPrintingSendStatusText(`Send failed: ${message}`);
      setPrintingSendStageText('Upload failed');
      setPrintingUploadDialogStage('failed');
      setPrintingDeviceProcessingStartedAtMs(null);
      setPrintingUploadTelemetry(null);
      setPrintingSendProgress(0);
      setPrintingUploadDisplayProgress(0);
    } finally {
      setPrintingSendBusy(false);
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

      const payload = await response.json().catch(() => ({} as any));
      if (response.ok && payload?.ok) {
        setPrintingSendStageText('Print started');
        setPrintingUploadDialogStage('started');
        setPrintingSendStatusText(`Print started successfully${printingReadyPlateId ? ` • Plate #${printingReadyPlateId}` : ''}.`);
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

      const payload = await response.json().catch(() => ({} as any));
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

      const payload = await response.json().catch(() => ({} as any));
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

      const payload = await response.json().catch(() => ({} as any));
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
      const statusPayload = await statusResponse.json().catch(() => ({} as any));
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

      const payload = await response.json().catch(() => ({} as any));
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
      const payload = await response.json().catch(() => ({} as any));

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

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPrintingMonitorPendingConfirmation(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
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

  React.useEffect(() => {
    if (scene.mode !== 'printing') return;

    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
    };

    const handlePrintingLayerHotkeys = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (printingPreviewTotalLayers <= 0) return;

      const key = event.key;
      const isUp = key === 'ArrowUp' || key === 'w' || key === 'W';
      const isDown = key === 'ArrowDown' || key === 's' || key === 'S';
      if (!isUp && !isDown) return;

      event.preventDefault();
      event.stopPropagation();

      const delta = isUp ? 1 : -1;
      const nextLayer = printingSelectedLayerRef.current + delta;
      handlePrintingLayerChange(nextLayer);
    };

    window.addEventListener('keydown', handlePrintingLayerHotkeys, true);
    return () => {
      window.removeEventListener('keydown', handlePrintingLayerHotkeys, true);
    };
  }, [handlePrintingLayerChange, printingPreviewTotalLayers, scene.mode]);

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
      await importSceneFilesWithLysWarning(sceneFiles);
      return;
    }

    if (meshFiles.length > 0) {
      // Use the same handler as the Load Mesh button.
      const meshEvent = buildSyntheticFileChangeEvent(meshFiles);
      scene.onFileChange(meshEvent);
    }
  }, [importSceneFilesWithLysWarning, scene]);

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

    const handlePrintingMonitorDebugHotkey = (event: KeyboardEvent) => {
      const isCtrlShiftN = event.ctrlKey
        && event.shiftKey
        && (event.code === 'KeyN' || event.key.toLowerCase() === 'n');
      if (!isCtrlShiftN) return;
      if (!printingMonitorModalOpen) return;

      event.preventDefault();
      event.stopPropagation();
      setIsPrintingMonitorDebugOpen((prev) => !prev);
    };

    const handlePrintingMonitorRtspDebugHotkey = (event: KeyboardEvent) => {
      const isCtrlShiftM = event.ctrlKey
        && event.shiftKey
        && (event.code === 'KeyM' || event.key.toLowerCase() === 'm');
      if (!isCtrlShiftM) return;
      if (!printingMonitorModalOpen) return;

      event.preventDefault();
      event.stopPropagation();
      setIsPrintingMonitorRtspDebugOpen((prev) => !prev);
    };

    window.addEventListener('keydown', handleDiagnosticsHotkey, true);
    window.addEventListener('keydown', handleHistoryDebugHotkey, true);
    window.addEventListener('keydown', handleTransformDebugOverlayHotkey, true);
    window.addEventListener('keydown', handleSliceMetricsDebugHotkey, true);
    window.addEventListener('keydown', handlePrintingMonitorDebugHotkey, true);
    window.addEventListener('keydown', handlePrintingMonitorRtspDebugHotkey, true);
    return () => {
      window.removeEventListener('keydown', handleDiagnosticsHotkey, true);
      window.removeEventListener('keydown', handleHistoryDebugHotkey, true);
      window.removeEventListener('keydown', handleTransformDebugOverlayHotkey, true);
      window.removeEventListener('keydown', handleSliceMetricsDebugHotkey, true);
      window.removeEventListener('keydown', handlePrintingMonitorDebugHotkey, true);
      window.removeEventListener('keydown', handlePrintingMonitorRtspDebugHotkey, true);
    };
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

  // For non-printing workflows, avoid expensive world-triangle projection work.
  // Keep layer floor at 0 when support/raft geometry exists so layer-1 alignment is correct.
  const fallbackZRange = React.useMemo(() => ({
    min: hasSupportOrRaftGeometry ? 0 : (scene.sceneBounds?.min.z ?? 0),
    max: scene.sceneBounds?.max.z ?? 100,
  }), [hasSupportOrRaftGeometry, scene.sceneBounds]);

  const [sceneZRange, setSceneZRange] = useState(fallbackZRange);

  const projectedZRangeCacheRef = React.useRef<Map<string, { min: number; max: number }>>(new Map());
  const projectedZRangeCacheKey = React.useMemo(() => {
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
      `roots:${Object.keys(supportStateSnapshot.roots).length}`,
      `trunks:${Object.keys(supportStateSnapshot.trunks).length}`,
      `branches:${Object.keys(supportStateSnapshot.branches).length}`,
      `leaves:${Object.keys(supportStateSnapshot.leaves).length}`,
      `twigs:${Object.keys(supportStateSnapshot.twigs).length}`,
      `sticks:${Object.keys(supportStateSnapshot.sticks).length}`,
      `braces:${Object.keys(supportStateSnapshot.braces).length}`,
      `kickstands:${Object.keys(kickstandStateSnapshot.kickstands).length}`,
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
    // Printing only needs accurate support/raft-aware bounds before a print artifact
    // exists; reopening printing with an existing artifact should avoid this rebuild.
    const needsAccurateZRange = scene.mode === 'printing' && !printingArtifact;
    
    if (needsAccurateZRange) {
      const cached = projectedZRangeCacheRef.current.get(projectedZRangeCacheKey);
      if (cached) {
        setSceneZRange(cached);
        return;
      }

      // Defer expensive calculation to idle time to avoid RAF stalls on mode entry.
      let cancelled = false;
      let timeoutId: number | null = null;
      let idleId: number | null = null;

      const run = () => {
        if (cancelled) return;
        const projected = buildProjectedCrossSectionZRange(scene.models);
        const nextRange = projected ?? fallbackZRange;
        projectedZRangeCacheRef.current.set(projectedZRangeCacheKey, nextRange);
        if (projectedZRangeCacheRef.current.size > 8) {
          const oldest = projectedZRangeCacheRef.current.keys().next().value;
          if (oldest != null) projectedZRangeCacheRef.current.delete(oldest);
        }
        setSceneZRange(nextRange);
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
      // Use fast fallback for prepare/support/export modes
      setSceneZRange(fallbackZRange);
    }
  }, [
    fallbackZRange,
    printingArtifact,
    projectedZRangeCacheKey,
    scene.mode,
    scene.models,
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
    const targetMicron = Math.max(1, Math.round(slicedLayerHeightMm * 1000));
    if (slicing.layerHeightMicron !== targetMicron) {
      slicing.setLayerHeightMicron(targetMicron);
    }
  }, [
    slicedLayerHeightMm,
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

  // Show re-slice modal when entering printing with invalid artifact
  React.useEffect(() => {
    if (scene.mode === 'printing' && printingArtifactIsInvalid && printingArtifact) {
      setShowPrintingResliceModal(true);
    }
  }, [scene.mode, printingArtifactIsInvalid, printingArtifact]);

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
    if (scene.models.length === 0) return;

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

  React.useEffect(() => {
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
    if (scene.mode === 'printing') return 'none';
    if (scene.mode !== 'support') return scene.selectionHighlightMode;
    if (isSupportSpotlightHoldActive) return 'spotlight';
    return scene.selectionHighlightMode === 'spotlight' ? 'tint' : scene.selectionHighlightMode;
  }, [isSupportSpotlightHoldActive, scene.mode, scene.selectionHighlightMode]);

  const isTransitioningOutOfPrinting = scene.mode !== 'printing' && previousSceneModeRef.current === 'printing';

  const sceneClipLower = React.useMemo(() => {
    if (scene.mode === 'printing' || isTransitioningOutOfPrinting) return null;
    return slicing.clipLower;
  }, [isTransitioningOutOfPrinting, scene.mode, slicing.clipLower]);

  const sceneClipUpper = React.useMemo(() => {
    if (scene.mode === 'printing' || isTransitioningOutOfPrinting) return null;
    return slicing.clipUpper;
  }, [isTransitioningOutOfPrinting, scene.mode, slicing.clipUpper]);

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
  const [holdEmptyStateSceneImportUi, setHoldEmptyStateSceneImportUi] = React.useState(false);

  React.useEffect(() => {
    const isSceneImportActive =
      (scene.importProgress.active && scene.importProgress.type === 'scene')
      || scene.isLysLoading
      || scene.lycheeImportPhase === 'processing';

    if (isSceneImportActive && scene.models.length === 0) {
      setHoldEmptyStateSceneImportUi(true);
      return;
    }

    if (!isSceneImportActive && holdEmptyStateSceneImportUi) {
      setHoldEmptyStateSceneImportUi(false);
    }
  }, [holdEmptyStateSceneImportUi, scene.importProgress.active, scene.importProgress.type, scene.isLysLoading, scene.lycheeImportPhase, scene.models.length]);

  const showEmptyStatePanel = scene.models.length === 0 || holdEmptyStateSceneImportUi;
  const showEmptyStateLoading = showInlineEmptyLoading || holdEmptyStateSceneImportUi;
  const showSceneImportOverlay = scene.models.length > 0 && importOverlayState.active && !holdEmptyStateSceneImportUi;
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

      type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

      // Use a tiny tolerance to allow touching (not overlapping) rects when spacing = 0
      const COLLISION_TOLERANCE = 0.01;
      const intersectsRect = (a: Rect2D, b: Rect2D) => {
        return !(a.maxX <= b.minX + COLLISION_TOLERANCE || a.minX + COLLISION_TOLERANCE >= b.maxX || 
                 a.maxY <= b.minY + COLLISION_TOLERANCE || a.minY + COLLISION_TOLERANCE >= b.maxY);
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
    // Add small epsilon to prevent floating point edge cases when spacing is very small
    const gridSpacing = spacing > 0 ? spacing : 0.001;
    const maxCols = Math.max(1, Math.floor((plateWidth + gridSpacing) / (width + gridSpacing)));
    const maxRows = Math.max(1, Math.floor((plateDepth + gridSpacing) / (depth + gridSpacing)));

    // Use actual spacing (including 0) for layout, not gridSpacing
    const totalUsedWidth = (maxCols * width) + Math.max(0, maxCols - 1) * spacing;
    const totalUsedDepth = (maxRows * depth) + Math.max(0, maxRows - 1) * spacing;
    const startX = minX + ((plateWidth - totalUsedWidth) * 0.5) + (width * 0.5);
    const startY = minY + ((plateDepth - totalUsedDepth) * 0.5) + (depth * 0.5);

    type Rect2D = { minX: number; maxX: number; minY: number; maxY: number };

    // Use a tiny tolerance to allow touching (not overlapping) rects when spacing = 0
    const COLLISION_TOLERANCE = 0.01;
    const intersectsRect = (a: Rect2D, b: Rect2D) => {
      return !(a.maxX <= b.minX + COLLISION_TOLERANCE || a.minX + COLLISION_TOLERANCE >= b.maxX || 
               a.maxY <= b.minY + COLLISION_TOLERANCE || a.minY + COLLISION_TOLERANCE >= b.maxY);
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

  const handlePlaceOnFace = React.useCallback((modelId: string) => {
    if (scene.activeModelId !== modelId) return;
    handleTransformEnd('rotate');
    transformMgr.setTransformMode('transform');
  }, [handleTransformEnd, scene.activeModelId, transformMgr]);

  const handlePlaceOnFaceBeforeApply = React.useCallback((_normal: THREE.Vector3, continueApply: () => void) => {
    return requestDestructiveTransformSupportDeletionWithContinuation('Place On Face', continueApply);
  }, [requestDestructiveTransformSupportDeletionWithContinuation]);

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
        showMonitorButton={showTopbarMonitorButton}
        monitorButtonActive={selectedPrinterHasActivePrint}
        monitorButtonPaused={selectedPrinterHasPausedAlert}
        monitorButtonOffline={isTopbarSelectedPrinterOffline}
        printerReachabilityByDeviceId={printerReachabilityByDeviceId}
        warnBeforeProfileSettingsOpen={Boolean(printingArtifact && !printingArtifactIsInvalid)}
        onOpenMonitor={() => setPrintingMonitorModalOpen(true)}
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
              onImportSceneChange={handleImportSceneInputChange}
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
            <SupportSidebar key="support-settings" />
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
              onOpenSendTargetPicker={() => setPrintingTargetPickerOpen(true)}
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
              onFileChange={scene.onFileChange}
              onImportSceneClick={() => { void handleOpenSceneDialog(); }}
              onImportSceneChange={handleImportSceneInputChange}
              onDropMeshFiles={handleDroppedPrepareFiles}
              recentOpenedFiles={scene.recentOpenedFiles}
              onReopenRecentFile={handleReopenRecentFile}
              isLoading={showEmptyStateLoading}
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
            deferCameraIntro={holdEmptyStateSceneImportUi}
            freezeViewportActive={isSlicingBusy && scene.mode === 'export'}
            indicatorPlaneZ={scene.mode === 'printing' ? slicing.currentHeightMm : null}
            indicatorPlaneColor={scene.selectionColor || '#ec2a77'}
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
                dragBatchMode="raf"
                docked
                embedded
                expandToContainer
                className="h-full"
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
                            clipZ={slicing.currentHeightMm}
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

      {showLysImportWarningModal && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCancelLysImportWarning();
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
                    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 88%)',
                    color: '#f59e0b',
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
                onClick={handleCancelLysImportWarning}
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
                    checked={lysImportWarningSkipFuture}
                    onChange={(event) => setLysImportWarningSkipFuture(event.target.checked)}
                    className="h-3.5 w-3.5 rounded border"
                    style={{ accentColor: '#f59e0b' }}
                  />
                  <span>Do not remind again</span>
                </label>

                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                    onClick={handleCancelLysImportWarning}
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
                    onClick={handleContinueLysImportWarning}
                  >
                    Continue
                  </button>
                </div>
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
                    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 88%)',
                    color: '#f59e0b',
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

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                  onClick={() => setPrintingMonitorPendingConfirmation(null)}
                >
                  {printingMonitorPendingConfirmation.kind === 'plate' ? 'Keep File' : 'Keep Printing'}
                </button>
                <button
                  type="button"
                  className="ui-button !h-9 px-3 text-xs"
                  style={
                    printingMonitorPendingConfirmation.kind === 'plate'
                      ? (
                        printingMonitorPendingConfirmation.action === 'start'
                          ? {
                              borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)',
                              background: 'color-mix(in srgb, #22c55e, var(--surface-1) 84%)',
                              color: '#bbf7d0',
                            }
                          : {
                              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                              background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                              color: '#fee2e2',
                            }
                      )
                      : (
                        printingMonitorPendingConfirmation.action === 'cancel'
                          ? {
                              borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                              background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                              color: '#fde68a',
                            }
                          : {
                              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                              background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                              color: '#fee2e2',
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
                  Fleet Upload
                </div>
                <div className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Choose target printer
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3.5">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {requiresRemoteMaterialSelectionForUpload
                  ? 'Pick the target machine and material profile for this upload.'
                  : 'Pick the target machine for this upload.'}
              </div>
              {requiresRemoteMaterialSelectionForUpload && (
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
                                color: '#86efac',
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
                      Target material (matching sliced layer height)
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
                                          color: '#86efac',
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
                  onClick={() => setPrintingTargetPickerOpen(false)}
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
                    void performSendToPrinter(
                      printingTargetDevice,
                      requiresRemoteMaterialSelectionForUpload ? printingTargetMaterialId : undefined,
                    );
                  }}
                >
                  Upload to Selected Printer
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
                    color: '#baf72e',
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
                        color: '#fde68a',
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
                        color: '#fecaca',
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
                                              color: '#bbf7d0',
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
                                borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 35%)',
                                background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 90%)',
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
                          <AlertTriangle className="w-5 h-5" style={{ color: '#f59e0b' }} />
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

      {printingMonitorErrorToast && (
        <div
          className="pointer-events-none fixed inset-x-0 z-[126] flex justify-center px-3"
          style={{ bottom: (historyActionToast || scene.sceneImportReport) ? '4.5rem' : '1.25rem' }}
        >
          <div
            className="flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold shadow-lg"
            style={{
              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 50%)',
              background: 'color-mix(in srgb, #ef4444, var(--surface-0) 90%)',
              color: 'var(--text-strong)',
              opacity: isPrintingMonitorErrorToastVisible ? 1 : 0,
              transform: `translateY(${isPrintingMonitorErrorToastVisible ? '0px' : '8px'})`,
              transition: 'opacity 220ms ease, transform 220ms ease',
            }}
          >
            <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            {printingMonitorErrorToast.text}
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
