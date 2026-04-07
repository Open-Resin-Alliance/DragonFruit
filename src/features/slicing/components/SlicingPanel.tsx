import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Cpu, Download, Gauge, Layers3, Minus, Play, Plus, Printer, Timer } from 'lucide-react';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';
import {
  getActiveMaterialProfile,
  getActivePrinterProfile,
  getProfileStoreServerSnapshot,
  getProfileStoreSnapshot,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import {
  getPrinterReachabilityServerSnapshot,
  getPrinterReachabilitySnapshot,
  subscribeToPrinterReachability,
} from '@/features/network/printerReachabilityStore';
import { getProfileLocalMaterialSettingsAdapter, getProfileNetworkUiAdapter } from '@/features/plugins/pluginRegistry';
import {
  runSliceExportOrchestrator,
  type SliceExportArtifact,
  type SliceExportResult,
} from '@/features/slicing/sliceExportOrchestrator';
import { resolveOutputSettingsMode, resolveSlicingFormatDefinition } from '@/features/slicing/formats/registry';
import { pluginNetworkFetch } from '@/utils/pluginNetworkBridge';
import { cleanupStalePrintTempArtifacts, cleanupAllPrintTempArtifacts, getSlicerEngineVersion } from '@/features/slicing/tauri/nativeSlicerBridge';

export type SliceIntent = 'file' | 'upload' | 'print' | 'preview';

interface SlicingPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
  estimatedVolumeLabelOverride?: string | null;
  captureSceneThumbnailPng?: () => Promise<Uint8Array | null>;
  thumbnailIncludeGradient?: boolean;
  thumbnailIncludeBuildPlate?: boolean;
  thumbnailIncludeGrid?: boolean;
  onThumbnailRenderOptionsChange?: (next: {
    includeGradient?: boolean;
    includeBuildPlate?: boolean;
    includeGrid?: boolean;
  }) => void;
  onSliceRunStarted?: () => void;
  onLayerPreviewGenerated?: (payload: {
    layerIndex: number;
    totalLayers: number;
    pngBytes: Uint8Array;
  }) => void;
  onSlicingFinished?: (payload: {
    totalLayers: number;
  }) => void;
  onSliceArtifactReady?: (artifact: SliceExportArtifact) => void;
  onBenchmarkComplete?: (benchmark: SliceBenchmarkSnapshot) => void;
  onSliceTriggerRef?: React.MutableRefObject<(() => void) | null>;
  shouldAutoSlice?: boolean;
  skipThumbnailCapture?: boolean;
  onSlicingBusyChange?: (busy: boolean) => void;
  canUpload?: boolean;
  canPrint?: boolean;
  onSliceIntentChanged?: (intent: SliceIntent) => void;
  onBeforeSliceStart?: (intent: SliceIntent) => Promise<boolean> | boolean;
}

type LifetimeTelemetry = {
  runCount: number;
  totalElapsedMs: number;
  totalRasterMs: number;
  lastElapsedMs: number | null;
  lastRasterMs: number | null;
  lastBackend: 'native-rust-tauri' | null;
};

type SliceBenchmarkSnapshot = SliceExportResult['benchmark'];
type RemoteMaterialProfile = {
  id: string;
  name: string;
  locked?: boolean;
};

function normalizeExportBaseName(rawName: string | null | undefined): string {
  const trimmed = (rawName ?? '').trim();
  if (!trimmed) return 'MyPrint';

  const withoutKnownExt = trimmed.replace(/(\.(stl|obj|3mf|lys|lychee|json))+$/i, '');
  const cleaned = withoutKnownExt.replace(/[.\s]+$/g, '').trim();
  return cleaned || 'MyPrint';
}

function resolveSliceFilenameBase(models: LoadedModel[], activeModel: LoadedModel | null): string {
  const visibleModels = models.filter((model) => model.visible);

  if (visibleModels.length === 1) {
    return normalizeExportBaseName(visibleModels[0].name);
  }

  if (visibleModels.length > 1) {
    const firstVisibleName = normalizeExportBaseName(visibleModels[0]?.name);
    return `${firstVisibleName}_DF_Scene`;
  }

  if (activeModel) {
    return normalizeExportBaseName(activeModel.name);
  }

  return 'MyPrint';
}

function formatDuration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatLayerRate(layersPerSecond: number | null): string {
  if (layersPerSecond == null || !Number.isFinite(layersPerSecond)) return '—';
  if (layersPerSecond >= 100) return `${Math.round(layersPerSecond)} layers/s`;
  return `${layersPerSecond.toFixed(1)} layers/s`;
}

function formatProgressLayerLabel(done: number, total: number): string {
  const totalSafe = Math.max(1, Math.round(total));
  const doneSafe = Math.max(0, Math.min(totalSafe, Math.round(done)));
  return `${doneSafe}/${totalSafe}`;
}

type SlicingPhaseKind = 'preparing' | 'staging' | 'slicing' | 'encoding' | 'finalizing' | 'handoff' | 'other';

function resolveSlicingPhaseKind(phase: string): SlicingPhaseKind {
  const lower = phase.toLowerCase();
  if (lower.includes('slicing')) return 'slicing';
  if (lower.includes('preparing')) return 'preparing';
  if (lower.includes('staging mesh') || lower.includes('transferring mesh')) return 'staging';
  if (lower.includes('slicing layer') || lower.includes('raster')) return 'slicing';
  if (lower.includes('encoding') || lower.includes('metadata') || lower.includes('compression') || lower.includes('packaging')) return 'encoding';
  if (lower.includes('finalizing')) return 'finalizing';
  if (lower.includes('opening printing') || lower.includes('handoff') || lower.includes('ready')) return 'handoff';
  return 'other';
}

function formatClockFromSeconds(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatElapsedClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const SLICING_AA_LEVEL_STORAGE_KEY = 'dragonfruit.slicing.aaLevel';
const SLICING_MIN_AA_ALPHA_STORAGE_KEY = 'dragonfruit.slicing.minimumAaAlphaPercent';
const SLICING_MIN_AA_ALPHA_OVERRIDE_ENABLED_KEY = 'dragonfruit.slicing.minimumAaAlphaOverrideEnabled';
const SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY = 'dragonfruit.slicing.remoteOfflineLayerHeightMm';
const SLICING_INTENT_BY_PRINTER_PROFILE_STORAGE_KEY = 'dragonfruit.slicing.intentByPrinterProfile.v1';

function readSliceIntentByPrinterProfile(): Record<string, SliceIntent> {
  if (typeof window === 'undefined') return {};

  const raw = window.localStorage.getItem(SLICING_INTENT_BY_PRINTER_PROFILE_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_INTENT_BY_PRINTER_PROFILE_STORAGE_KEY);
  if (!raw || raw.trim().length === 0) return {};

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Record<string, SliceIntent> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === 'file' || value === 'upload' || value === 'print' || value === 'preview') {
        next[key] = value;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function writeSliceIntentByPrinterProfile(next: Record<string, SliceIntent>): void {
  if (typeof window === 'undefined') return;
  const serialized = JSON.stringify(next);
  window.localStorage.setItem(SLICING_INTENT_BY_PRINTER_PROFILE_STORAGE_KEY, serialized);
  window.sessionStorage.setItem(SLICING_INTENT_BY_PRINTER_PROFILE_STORAGE_KEY, serialized);
}

function clampLayerHeightMm(value: number, fallback = 0.05): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.max(0.001, Math.min(1, numeric));
  return Math.round(clamped * 1000) / 1000;
}

function resolveInitialAaLevel(): 'Off' | '2x' | '4x' | '8x' | '16x' {
  if (typeof window === 'undefined') return 'Off';

  const stored = window.localStorage.getItem(SLICING_AA_LEVEL_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_AA_LEVEL_STORAGE_KEY);
  if (stored === 'Off' || stored === '2x' || stored === '4x' || stored === '8x' || stored === '16x') {
    return stored;
  }

  return 'Off';
}

function resolveInitialMinimumAaAlphaPercent(): number {
  if (typeof window === 'undefined') return 35;

  const stored = window.localStorage.getItem(SLICING_MIN_AA_ALPHA_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_MIN_AA_ALPHA_STORAGE_KEY);
  if (stored == null || stored.trim().length === 0) return 35;
  const parsed = Number(stored);
  if (!Number.isFinite(parsed)) return 35;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function resolveInitialMinimumAaAlphaOverrideEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  const stored = window.localStorage.getItem(SLICING_MIN_AA_ALPHA_OVERRIDE_ENABLED_KEY)
    ?? window.sessionStorage.getItem(SLICING_MIN_AA_ALPHA_OVERRIDE_ENABLED_KEY);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  // No stored preference — default to profile mode.
  return false;
}

export function SlicingPanel({
  models,
  activeModel,
  estimatedVolumeLabelOverride,
  captureSceneThumbnailPng,
  thumbnailIncludeGradient = false,
  thumbnailIncludeBuildPlate = false,
  thumbnailIncludeGrid = false,
  onThumbnailRenderOptionsChange,
  onSliceRunStarted,
  onLayerPreviewGenerated,
  onSlicingFinished,
  onSliceArtifactReady,
  onBenchmarkComplete,
  onSliceTriggerRef,
  shouldAutoSlice,
  skipThumbnailCapture,
  onSlicingBusyChange,
  canUpload = false,
  canPrint = false,
  onSliceIntentChanged,
  onBeforeSliceStart,
}: SlicingPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isThumbnailDrawerOpen, setIsThumbnailDrawerOpen] = useState(false);
  const [sliceIntent, setSliceIntent] = useState<SliceIntent>(() => {
    const id = (getActivePrinterProfile(getProfileStoreSnapshot())?.id ?? '').trim();
    if (!id) return 'file';
    const remembered = readSliceIntentByPrinterProfile()[id];
    if (remembered === 'file' || remembered === 'upload' || remembered === 'print' || remembered === 'preview') return remembered;
    return 'file';
  });
  const [sliceIntentMenuOpen, setSliceIntentMenuOpen] = useState(false);
  const [sliceIntentMenuRect, setSliceIntentMenuRect] = useState<DOMRect | null>(null);
  const sliceIntentMenuRef = useRef<HTMLDivElement | null>(null);
  const sliceIntentAnchorRef = useRef<HTMLDivElement | null>(null);
  const [isSlicingZip, setIsSlicingZip] = useState(false);
  const [sliceStatus, setSliceStatus] = useState('Idle');
  const [currentPhase, setCurrentPhase] = useState('Idle');
  const [progressDone, setProgressDone] = useState(0);
  const [progressTotal, setProgressTotal] = useState(1);
  const [slicingLayerDone, setSlicingLayerDone] = useState(0);
  const [slicingLayerTotal, setSlicingLayerTotal] = useState(1);
  const [currentElapsedMs, setCurrentElapsedMs] = useState(0);
  const [currentRasterMs, setCurrentRasterMs] = useState(0);
  const [liveLayersPerSec, setLiveLayersPerSec] = useState<number | null>(null);
  const [estimatedRemainingMs, setEstimatedRemainingMs] = useState<number | null>(null);
  const smoothedMetricsRef = useRef({ layersPerSec: 0, remainingMs: 0 });
  const [showSlicingModal, setShowSlicingModal] = useState(false);
  const [slicingModalStage, setSlicingModalStage] = useState<'running' | 'finished' | 'failed' | 'cancelled'>('running');
  const [displayProgressPercent, setDisplayProgressPercent] = useState(0);
  const [antiAliasingLevel, setAntiAliasingLevel] = useState<'Off' | '2x' | '4x' | '8x' | '16x'>(resolveInitialAaLevel);
  const [minimumAaAlphaPercent, setMinimumAaAlphaPercent] = useState<number>(resolveInitialMinimumAaAlphaPercent);
  const [enableMinimumAaAlphaOverride, setEnableMinimumAaAlphaOverride] = useState<boolean>(resolveInitialMinimumAaAlphaOverrideEnabled);
  const [remoteOfflineLayerHeightMm, setRemoteOfflineLayerHeightMm] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.05;
    const raw = window.localStorage.getItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY)
      ?? window.sessionStorage.getItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY);
    if (raw == null || raw.trim().length === 0) return 0.05;
    const parsed = Number(raw);
    return (Number.isFinite(parsed) && parsed > 0) ? clampLayerHeightMm(parsed) : 0.05;
  });
  const [remoteOfflineLayerHeightDraft, setRemoteOfflineLayerHeightDraft] = useState<string | null>(null);
  const [selectedRemoteMaterialName, setSelectedRemoteMaterialName] = useState<string | null>(null);
  const [isLoadingRemoteMaterial, setIsLoadingRemoteMaterial] = useState(false);
  const [layerPreviewUrls, setLayerPreviewUrls] = useState<Array<string | null>>([]);
  const [previewTotalLayers, setPreviewTotalLayers] = useState(0);
  const [previewSelectedLayer, setPreviewSelectedLayer] = useState(1);
  const [lastBenchmark, setLastBenchmark] = useState<SliceBenchmarkSnapshot | null>(null);
  const [lastNativeError, setLastNativeError] = useState<string | null>(null);
  const [slicerEngineVersion, setSlicerEngineVersion] = useState<string | null>(null);
  const [lifetimeTelemetry, setLifetimeTelemetry] = useState<LifetimeTelemetry>({
    runCount: 0,
    totalElapsedMs: 0,
    totalRasterMs: 0,
    lastElapsedMs: null,
    lastRasterMs: null,
    lastBackend: null,
  });
  const slicingAbortControllerRef = useRef<AbortController | null>(null);
  const autoSliceTriggeredRef = useRef(false);
  const autoSliceTimeoutRef = useRef<number | null>(null);
  const handleSliceZipExportRef = useRef<(() => Promise<void>) | null>(null);

  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const printerReachabilityByDeviceId = React.useSyncExternalStore(
    subscribeToPrinterReachability,
    getPrinterReachabilitySnapshot,
    getPrinterReachabilityServerSnapshot,
  );
  const activePrinterProfile = useMemo(() => getActivePrinterProfile(profileState), [profileState]);
  const networkUiAdapter = useMemo(
    () => getProfileNetworkUiAdapter(activePrinterProfile?.networkSupport),
    [activePrinterProfile?.networkSupport],
  );
  const activeMaterialProfile = useMemo(() => getActiveMaterialProfile(profileState), [profileState]);
  const effectiveMaterialProfile = useMemo(() => {
    if (!activeMaterialProfile) return null;
    if (!activePrinterProfile) return activeMaterialProfile;
    if (!networkUiAdapter) return activeMaterialProfile;
    if (activePrinterProfile.networkConnection?.connected !== true) return activeMaterialProfile;

    const activeDeviceId = (
      activePrinterProfile.activeNetworkDeviceId?.trim()
      || (activePrinterProfile.networkFleet ?? []).find((device) => (
        (device.ipAddress || '').trim().toLowerCase()
        === (activePrinterProfile.networkConnection?.ipAddress || '').trim().toLowerCase()
      ))?.id
      || ''
    );
    if (activeDeviceId && printerReachabilityByDeviceId[activeDeviceId] === false) {
      return activeMaterialProfile;
    }

    const selectedMaterialId = activePrinterProfile.networkConnection?.selectedMaterialId?.trim() ?? '';
    if (!selectedMaterialId) return activeMaterialProfile;

    const selectedLayerHeightMm = Number(activePrinterProfile.networkConnection?.selectedMaterialLayerHeightMm);
    const selectedNormalExposureSec = Number(activePrinterProfile.networkConnection?.selectedMaterialNormalExposureSec);
    const selectedBottomExposureSec = Number(activePrinterProfile.networkConnection?.selectedMaterialBottomExposureSec);
    const selectedBottomLayerCount = Number(activePrinterProfile.networkConnection?.selectedMaterialBottomLayerCount);
    const selectedMaterialName = activePrinterProfile.networkConnection?.selectedMaterialName?.trim() ?? '';

    return {
      ...activeMaterialProfile,
      name: selectedMaterialName || activeMaterialProfile.name,
      layerHeightMm: Number.isFinite(selectedLayerHeightMm) && selectedLayerHeightMm > 0
        ? selectedLayerHeightMm
        : activeMaterialProfile.layerHeightMm,
      normalExposureSec: Number.isFinite(selectedNormalExposureSec) && selectedNormalExposureSec > 0
        ? selectedNormalExposureSec
        : activeMaterialProfile.normalExposureSec,
      bottomExposureSec: Number.isFinite(selectedBottomExposureSec) && selectedBottomExposureSec > 0
        ? selectedBottomExposureSec
        : activeMaterialProfile.bottomExposureSec,
      bottomLayerCount: Number.isFinite(selectedBottomLayerCount) && selectedBottomLayerCount >= 0
        ? selectedBottomLayerCount
        : activeMaterialProfile.bottomLayerCount,
    };
  }, [activeMaterialProfile, activePrinterProfile, networkUiAdapter, printerReachabilityByDeviceId]);

  const selectedFormat = useMemo(() => {
    if (!activePrinterProfile || !effectiveMaterialProfile) return null;
    return resolveSlicingFormatDefinition({
      printerProfile: activePrinterProfile,
      materialProfile: effectiveMaterialProfile,
    });
  }, [activePrinterProfile, effectiveMaterialProfile]);

  const selectedRemoteMaterialId = activePrinterProfile?.networkConnection?.selectedMaterialId?.trim() ?? '';
  const selectedNetworkDeviceId = useMemo(() => {
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
  const selectedNetworkDeviceReachability = selectedNetworkDeviceId
    ? (printerReachabilityByDeviceId[selectedNetworkDeviceId] ?? null)
    : null;
  const isRemoteNetworkUnavailable = Boolean(networkUiAdapter) && (
    activePrinterProfile?.networkConnection?.connected !== true
    || selectedNetworkDeviceReachability === false
  );
  // Respect printer-profile capability: explicit `false` means AA must be disabled.
  const antiAliasingAvailable = activePrinterProfile != null && activePrinterProfile.antiAliasing !== false;
  const minimumAaControlsDisabled = !antiAliasingAvailable;
  const isRemoteMaterialSyncConnected = Boolean(networkUiAdapter) && !isRemoteNetworkUnavailable;
  const showRemoteOfflineLayerHeightOverride = Boolean(networkUiAdapter)
    && isRemoteNetworkUnavailable
    && networkUiAdapter?.supportsRemoteMaterialProfiles !== false;
  const remoteMaterialHost = (activePrinterProfile?.networkConnection?.ipAddress
    || activePrinterProfile?.network?.ipAddress
    || '').trim();

  const progressPercent = useMemo(() => {
    const total = Math.max(1, progressTotal);
    return Math.max(0, Math.min(100, Math.round((progressDone / total) * 100)));
  }, [progressDone, progressTotal]);

  const phaseKind = useMemo(() => resolveSlicingPhaseKind(currentPhase), [currentPhase]);
  const encodeUnitTotal = Math.max(1, progressTotal - slicingLayerTotal);
  const encodeUnitDone = Math.max(0, Math.min(encodeUnitTotal, progressDone - slicingLayerTotal));
  const progressCounterLabel = phaseKind === 'slicing'
    ? 'Sliced Layers'
    : phaseKind === 'encoding'
      ? 'Encoded Layers'
      : 'Pipeline Units';
  const progressCounterValue = phaseKind === 'slicing'
    ? formatProgressLayerLabel(slicingLayerDone, slicingLayerTotal)
    : phaseKind === 'encoding'
      ? formatProgressLayerLabel(encodeUnitDone, encodeUnitTotal)
      : formatProgressLayerLabel(progressDone, progressTotal);
  const canCancelSlicing = slicingModalStage === 'running'
    && (phaseKind === 'preparing' || phaseKind === 'staging' || phaseKind === 'slicing');

  const slicingElapsedLabel = useMemo(() => formatElapsedClock(currentElapsedMs), [currentElapsedMs]);

  const visibleModels = useMemo(() => models.filter((model) => model.visible), [models]);
  const activePrinterProfileId = (activePrinterProfile?.id ?? '').trim();
  const [isShiftHeld, setIsShiftHeld] = useState(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Shift') setIsShiftHeld(true); };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === 'Shift') setIsShiftHeld(false); };
    const onBlur = () => setIsShiftHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const effectiveSliceIntent = useMemo<SliceIntent>(() => {
    if (isShiftHeld) return 'preview';
    if (sliceIntent === 'upload' && !canUpload) return 'file';
    if (sliceIntent === 'print' && !canPrint) return 'file';
    return sliceIntent;
  }, [canPrint, canUpload, isShiftHeld, sliceIntent]);
  // 'preview' is always available regardless of network state
  const sliceFilenameBase = useMemo(
    () => resolveSliceFilenameBase(models, activeModel),
    [activeModel, models],
  );

  useEffect(() => {
    if (!activePrinterProfileId) {
      setSliceIntent('file');
      return;
    }

    const remembered = readSliceIntentByPrinterProfile()[activePrinterProfileId];
    if (remembered === 'file' || remembered === 'upload' || remembered === 'print') {
      setSliceIntent(remembered);
      return;
    }

    setSliceIntent('file');
  }, [activePrinterProfileId]);

  useEffect(() => {
    if (!activePrinterProfileId) return;
    const map = readSliceIntentByPrinterProfile();
    if (map[activePrinterProfileId] === sliceIntent) return;
    map[activePrinterProfileId] = sliceIntent;
    writeSliceIntentByPrinterProfile(map);
  }, [activePrinterProfileId, sliceIntent]);

  const estimatedVolumeLabel = useMemo(() => {
    if (estimatedVolumeLabelOverride && estimatedVolumeLabelOverride.trim().length > 0) {
      return estimatedVolumeLabelOverride;
    }

    if (visibleModels.length === 0) return '—';

    let totalMm3 = 0;
    for (const model of visibleModels) {
      const bbox = model.geometry.bbox;
      const sizeX = Math.max(0, bbox.max.x - bbox.min.x);
      const sizeY = Math.max(0, bbox.max.y - bbox.min.y);
      const sizeZ = Math.max(0, bbox.max.z - bbox.min.z);
      const sx = Math.abs(model.transform.scale.x || 1);
      const sy = Math.abs(model.transform.scale.y || 1);
      const sz = Math.abs(model.transform.scale.z || 1);
      totalMm3 += (sizeX * sx) * (sizeY * sy) * (sizeZ * sz);
    }

    const ml = totalMm3 / 1000;
    return `${ml.toFixed(2)} mL`;
  }, [estimatedVolumeLabelOverride, visibleModels]);

  const effectiveLayerHeightMm = useMemo(() => {
    if (showRemoteOfflineLayerHeightOverride) {
      return clampLayerHeightMm(remoteOfflineLayerHeightMm, clampLayerHeightMm(activeMaterialProfile?.layerHeightMm ?? 0.05));
    }
    if (!effectiveMaterialProfile) return null;
    return clampLayerHeightMm(effectiveMaterialProfile.layerHeightMm, 0.05);
  }, [activeMaterialProfile?.layerHeightMm, effectiveMaterialProfile, remoteOfflineLayerHeightMm, showRemoteOfflineLayerHeightOverride]);

  const materialProfileForSlicing = useMemo(() => {
    if (!effectiveMaterialProfile) return null;
    if (!showRemoteOfflineLayerHeightOverride) return effectiveMaterialProfile;
    return {
      ...effectiveMaterialProfile,
      layerHeightMm: effectiveLayerHeightMm ?? clampLayerHeightMm(activeMaterialProfile?.layerHeightMm ?? 0.05),
    };
  }, [activeMaterialProfile?.layerHeightMm, effectiveLayerHeightMm, effectiveMaterialProfile, showRemoteOfflineLayerHeightOverride]);

  const estimatedLayerCount = useMemo(() => {
    if (effectiveLayerHeightMm == null || visibleModels.length === 0) return 0;

    const layerHeightMm = Math.max(0.001, effectiveLayerHeightMm || 0.05);
    let maxModelHeightMm = 0;

    for (const model of visibleModels) {
      const bbox = model.geometry.bbox;
      const sizeZ = Math.max(0, bbox.max.z - bbox.min.z);
      const sz = Math.abs(model.transform.scale.z || 1);
      maxModelHeightMm = Math.max(maxModelHeightMm, sizeZ * sz);
    }

    return Math.max(0, Math.ceil(maxModelHeightMm / layerHeightMm));
  }, [effectiveLayerHeightMm, visibleModels]);

  const estimatedPrintTimeLabel = useMemo(() => {
    if (!effectiveMaterialProfile || estimatedLayerCount <= 0) return '—';

    const totalLayers = estimatedLayerCount;
    const bottomLayers = Math.max(0, Math.min(totalLayers, Math.round(effectiveMaterialProfile.bottomLayerCount)));
    const normalLayers = Math.max(0, totalLayers - bottomLayers);

    const liftSec = effectiveMaterialProfile.liftSpeedMmMin > 0
      ? (effectiveMaterialProfile.liftDistanceMm / effectiveMaterialProfile.liftSpeedMmMin) * 60
      : 0;
    const retractSec = effectiveMaterialProfile.retractSpeedMmMin > 0
      ? (effectiveMaterialProfile.liftDistanceMm / effectiveMaterialProfile.retractSpeedMmMin) * 60
      : 0;
    const travelSecPerLayer = Math.max(0, liftSec + retractSec);

    const totalSec = (
      bottomLayers * (effectiveMaterialProfile.bottomExposureSec + travelSecPerLayer)
      + normalLayers * (effectiveMaterialProfile.normalExposureSec + travelSecPerLayer)
    );

    return formatClockFromSeconds(totalSec);
  }, [effectiveMaterialProfile, estimatedLayerCount]);

  const effectiveAntiAliasingLevel = antiAliasingAvailable ? antiAliasingLevel : 'Off';
  const minimumAlphaLabel = 'Minimum Alpha';

  const minimumAaProfileSupport = useMemo(() => {
    const fallback = Math.max(
      0,
      Math.min(100, Math.round(Number(effectiveMaterialProfile?.minimumAaAlphaPercent ?? 35))),
    );

    if (!effectiveMaterialProfile) {
      return {
        available: false as const,
        value: fallback,
      };
    }

    const outputFormat = (selectedFormat?.outputFormat ?? activePrinterProfile?.display.outputFormat ?? '').trim();
    if (!outputFormat) {
      return {
        available: false as const,
        value: fallback,
      };
    }

    const normalizedOutput = outputFormat.toLowerCase();
    const outputWithoutDot = normalizedOutput.replace(/^\./, '');
    const settingsMode = resolveOutputSettingsMode(outputFormat, activePrinterProfile?.display.settingsMode);

    const localAdapter = getProfileLocalMaterialSettingsAdapter(outputFormat, settingsMode);
    const profileField = localAdapter?.fields.find((field) => {
      const metadataPath = field.metadataPath?.trim().toLowerCase();
      return metadataPath === 'dragonfruit.minimumaaalphapercent' || field.key === 'minimumAaAlphaPercent';
    });

    if (!profileField) {
      return {
        available: false as const,
        value: fallback,
      };
    }

    const profileAlphaFieldKey = profileField.key;

    const localForOutput = effectiveMaterialProfile.localSettingsByOutput?.[normalizedOutput]
      ?? effectiveMaterialProfile.localSettingsByOutput?.[outputWithoutDot]
      ?? null;

    const localValue = localForOutput?.[profileAlphaFieldKey];
    const parsed = Number(localValue);
    if (!Number.isFinite(parsed)) {
      return {
        available: true as const,
        value: fallback,
      };
    }

    return {
      available: true as const,
      value: Math.max(0, Math.min(100, Math.round(parsed))),
    };
  }, [
    activePrinterProfile?.display.outputFormat,
    activePrinterProfile?.display.settingsMode,
    effectiveMaterialProfile,
    selectedFormat?.outputFormat,
  ]);

  const profileMinimumAaAlphaPercent = minimumAaProfileSupport.value;
  const hasProfileMinimumAaAlpha = minimumAaProfileSupport.available;

  const setClampedMinimumAaAlphaPercent = useCallback((value: number) => {
    const next = Number.isFinite(value) ? value : 50;
    setMinimumAaAlphaPercent(Math.max(0, Math.min(100, Math.round(next))));
  }, []);

  const persistRemoteOfflineLayerHeight = useCallback((value: number) => {
    if (typeof window === 'undefined') return;

    const serialized = String(clampLayerHeightMm(value));
    window.localStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
  }, []);

  const setClampedRemoteOfflineLayerHeightMm = useCallback((value: number) => {
    setRemoteOfflineLayerHeightMm((previous) => {
      const next = clampLayerHeightMm(value, previous);
      persistRemoteOfflineLayerHeight(next);
      return next;
    });
  }, [persistRemoteOfflineLayerHeight]);

  const beginRemoteOfflineLayerHeightEdit = useCallback(() => {
    setRemoteOfflineLayerHeightDraft(String(remoteOfflineLayerHeightMm));
  }, [remoteOfflineLayerHeightMm]);

  const cancelRemoteOfflineLayerHeightEdit = useCallback(() => {
    setRemoteOfflineLayerHeightDraft(null);
  }, []);

  const commitRemoteOfflineLayerHeightEdit = useCallback(() => {
    if (remoteOfflineLayerHeightDraft == null) return;

    const trimmed = remoteOfflineLayerHeightDraft.trim();
    if (trimmed.length > 0) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed > 0) {
        setClampedRemoteOfflineLayerHeightMm(parsed);
      }
    }

    setRemoteOfflineLayerHeightDraft(null);
  }, [remoteOfflineLayerHeightDraft, setClampedRemoteOfflineLayerHeightMm]);

  useEffect(() => {
    void getSlicerEngineVersion().then((v) => {
      if (v) setSlicerEngineVersion(v);
    });
  }, []);

  useEffect(() => {
    if (!antiAliasingAvailable) {
      if (antiAliasingLevel !== 'Off') {
        setAntiAliasingLevel('Off');
      }
      if (!enableMinimumAaAlphaOverride) {
        setEnableMinimumAaAlphaOverride(true);
      }
      return;
    }

    if (!hasProfileMinimumAaAlpha && !enableMinimumAaAlphaOverride) {
      setEnableMinimumAaAlphaOverride(true);
    }
  }, [antiAliasingAvailable, antiAliasingLevel, enableMinimumAaAlphaOverride, hasProfileMinimumAaAlpha]);

  // When the profile gains a min-AA-alpha field (e.g. printer profile switch), default back to profile mode.
  const prevHasProfileMinimumAaAlphaRef = useRef(hasProfileMinimumAaAlpha);
  useEffect(() => {
    const prev = prevHasProfileMinimumAaAlphaRef.current;
    prevHasProfileMinimumAaAlphaRef.current = hasProfileMinimumAaAlpha;
    if (!prev && hasProfileMinimumAaAlpha) {
      setEnableMinimumAaAlphaOverride(false);
    }
  }, [hasProfileMinimumAaAlpha]);


  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_AA_LEVEL_STORAGE_KEY, antiAliasingLevel);
    // Backward compatibility for same-session reads from existing logic paths.
    window.sessionStorage.setItem(SLICING_AA_LEVEL_STORAGE_KEY, antiAliasingLevel);
  }, [antiAliasingLevel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(Math.max(0, Math.min(100, Math.round(minimumAaAlphaPercent))));
    window.localStorage.setItem(SLICING_MIN_AA_ALPHA_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_MIN_AA_ALPHA_STORAGE_KEY, serialized);
  }, [minimumAaAlphaPercent]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(enableMinimumAaAlphaOverride);
    window.localStorage.setItem(SLICING_MIN_AA_ALPHA_OVERRIDE_ENABLED_KEY, serialized);
    window.sessionStorage.setItem(SLICING_MIN_AA_ALPHA_OVERRIDE_ENABLED_KEY, serialized);
  }, [enableMinimumAaAlphaOverride]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const serialized = String(clampLayerHeightMm(remoteOfflineLayerHeightMm));
    window.localStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
  }, [remoteOfflineLayerHeightMm]);

  const resolvedMaterialLabel = useMemo(() => {
    if (isRemoteMaterialSyncConnected && selectedRemoteMaterialId) {
      if (isLoadingRemoteMaterial) return 'Loading remote material…';
      if (selectedRemoteMaterialName) return `${selectedRemoteMaterialName} (${networkUiAdapter?.displayName ?? 'Remote'})`;
      const fromConnection = activePrinterProfile?.networkConnection?.selectedMaterialName?.trim();
      if (fromConnection) return `${fromConnection} (${networkUiAdapter?.displayName ?? 'Remote'})`;
      return `${selectedRemoteMaterialId} (Remote ID)`;
    }

    return effectiveMaterialProfile?.name ?? 'No material selected';
  }, [
    activePrinterProfile?.networkConnection?.selectedMaterialName,
    effectiveMaterialProfile?.name,
    isLoadingRemoteMaterial,
    isRemoteMaterialSyncConnected,
    networkUiAdapter?.displayName,
    selectedRemoteMaterialName,
    selectedRemoteMaterialId,
  ]);

  useEffect(() => {
    if (!showSlicingModal) {
      setDisplayProgressPercent(0);
      return;
    }

    let rafId = 0;
    let mounted = true;

    const animate = () => {
      if (!mounted) return;
      setDisplayProgressPercent((prev) => {
        const target = progressPercent;
        if (target >= 100 || Math.abs(target - prev) < 0.1) return target;
        return prev + (target - prev) * 0.5;
      });
      rafId = window.requestAnimationFrame(animate);
    };

    rafId = window.requestAnimationFrame(animate);
    return () => {
      mounted = false;
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [progressPercent, showSlicingModal]);

  const clearLayerPreviewUrls = useCallback(() => {
    setLayerPreviewUrls((previous) => {
      for (const url of previous) {
        if (url) URL.revokeObjectURL(url);
      }
      return [];
    });
  }, []);

  useEffect(() => {
    return () => {
      slicingAbortControllerRef.current?.abort();
      clearLayerPreviewUrls();
      onSlicingBusyChange?.(false);
    };
  }, [clearLayerPreviewUrls, onSlicingBusyChange]);

  useEffect(() => {
    if (!isSlicingZip) {
      setCurrentElapsedMs(0);
      return;
    }

    const runStart = performance.now();
    const id = window.setInterval(() => {
      setCurrentElapsedMs(performance.now() - runStart);
    }, 120);

    return () => {
      window.clearInterval(id);
    };
  }, [isSlicingZip]);

  useEffect(() => {
    if (!networkUiAdapter || !isRemoteMaterialSyncConnected || !remoteMaterialHost || !selectedRemoteMaterialId) {
      setSelectedRemoteMaterialName(null);
      setIsLoadingRemoteMaterial(false);
      return;
    }

    let cancelled = false;
    setIsLoadingRemoteMaterial(true);

    void (async () => {
      try {
        const response = await pluginNetworkFetch({
          pluginId: networkUiAdapter.pluginId,
          operation: networkUiAdapter.operations.materials,
          host: remoteMaterialHost,
        });

        const payload = await response.json().catch(() => ({} as Record<string, unknown>));
        const listRaw = Array.isArray((payload as { materials?: unknown }).materials)
          ? (payload as { materials: unknown[] }).materials
          : [];

        const materials: RemoteMaterialProfile[] = listRaw
          .map<RemoteMaterialProfile | null>((item) => {
            const value = item as Partial<RemoteMaterialProfile>;
            if (typeof value?.id !== 'string' || typeof value?.name !== 'string') return null;
            return {
              id: value.id,
              name: value.name,
              locked: value.locked === true ? true : undefined,
            };
          })
          .filter((item): item is RemoteMaterialProfile => item !== null);

        const selected = materials.find((material) => material.id === selectedRemoteMaterialId) ?? null;
        if (!cancelled) {
          setSelectedRemoteMaterialName(selected?.name ?? null);
        }
      } catch {
        if (!cancelled) {
          setSelectedRemoteMaterialName(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingRemoteMaterial(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    isRemoteMaterialSyncConnected,
    networkUiAdapter,
    remoteMaterialHost,
    selectedRemoteMaterialId,
  ]);

  const handleSliceZipExport = async () => {
    if (!activePrinterProfile) {
      alert('Select a printer profile first.');
      return;
    }
    
    if (!materialProfileForSlicing) {
      alert('Select a material profile first.');
      return;
    }

    const visibleModels = models.filter((model) => model.visible);
    if (visibleModels.length === 0) {
      alert('No visible models available for slicing.');
      return;
    }

    const proceed = await Promise.resolve(onBeforeSliceStart?.(effectiveSliceIntent) ?? true).catch(() => false);
    if (!proceed) {
      return;
    }

    setIsSlicingZip(true);
    setCurrentPhase('Preparing');
    setSliceStatus('Preparing');
    setProgressDone(0);
    setProgressTotal(1);
    setSlicingLayerDone(0);
    setSlicingLayerTotal(1);
    setCurrentElapsedMs(0);
    setCurrentRasterMs(0);
    setLiveLayersPerSec(null);
    setEstimatedRemainingMs(null);
    smoothedMetricsRef.current = { layersPerSec: 0, remainingMs: 0 };
    setShowSlicingModal(true);
    setSlicingModalStage('running');
    onSlicingBusyChange?.(true);
    clearLayerPreviewUrls();
    setPreviewTotalLayers(0);
    setPreviewSelectedLayer(1);
    onSliceIntentChanged?.(effectiveSliceIntent);
    onSliceRunStarted?.();

    const runStartMs = performance.now();
    const abortController = new AbortController();
    slicingAbortControllerRef.current = abortController;
    let rasterStartedMs: number | null = null;
    let rasterAccumulatedMs = 0;
    let slicingPhaseStartMs: number | null = null;
    let exportThumbnailPng: Uint8Array | null = null;
    let completedTotalLayers = 0;
    let slicingSucceeded = false;
    let completedTotalLayersFromResult = 0;

    try {
      // Proactively clean stale temp files (older than 1 hour) before starting new slice
      // to prevent disk space exhaustion from repeated auto-slicing.
      await cleanupStalePrintTempArtifacts(60 * 60).catch((err) => {
        console.warn('[Slicing] Failed to cleanup stale temp artifacts before slice:', err);
      });

      if (captureSceneThumbnailPng && !skipThumbnailCapture) {
        try {
          exportThumbnailPng = await captureSceneThumbnailPng();
          console.info('[Slicing] Scene thumbnail capture result', {
            hasThumbnail: Boolean(exportThumbnailPng && exportThumbnailPng.length > 0),
            bytes: exportThumbnailPng?.length ?? 0,
          });
        } catch (thumbnailError) {
          console.warn('[Slicing] Scene thumbnail capture failed, continuing with layer preview fallback.', thumbnailError);
        }
      }

      const result = await runSliceExportOrchestrator({
        models: visibleModels,
        printerProfile: activePrinterProfile,
        materialProfile: materialProfileForSlicing,
        filenameBase: sliceFilenameBase || activePrinterProfile.name || 'slice_export',
        antiAliasingLevel: effectiveAntiAliasingLevel,
        minimumAaAlphaPercentOverride: enableMinimumAaAlphaOverride
          ? minimumAaAlphaPercent
          : profileMinimumAaAlphaPercent,

        outputMode: 'return',
        exportThumbnailPng,
        abortSignal: abortController.signal,
        onProgress: (done, total, phase) => {
          const phaseKind = resolveSlicingPhaseKind(phase);
          const isSlicingPhase = phaseKind === 'slicing';
          const safeTotal = Math.max(1, total);
          const safeDone = Math.max(0, Math.min(done, safeTotal));
          setCurrentPhase(phase);
          setSliceStatus(phase);
          setProgressDone(safeDone);
          setProgressTotal(safeTotal);

          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('dragonfruit:slicing-progress', {
              detail: {
                phase,
                done: safeDone,
                total: safeTotal,
              },
            }));
          }

          const nowMs = performance.now();

          if (isSlicingPhase) {
            setSlicingLayerDone(safeDone);
            setSlicingLayerTotal(safeTotal);

            if (slicingPhaseStartMs == null) {
              slicingPhaseStartMs = nowMs;
            }
            if (rasterStartedMs == null) {
              rasterStartedMs = nowMs;
            }
            setCurrentRasterMs(rasterAccumulatedMs + (nowMs - rasterStartedMs));

            // Compute speed from cumulative elapsed time to avoid burst-induced spikes
            // when progress events are delivered in batches.
            const phaseElapsedMs = Math.max(1, nowMs - slicingPhaseStartMs);
            if (safeDone > 0 && phaseElapsedMs > 300) {
              const rawRate = (safeDone * 1000) / phaseElapsedMs;
              const alpha = 0.2;
              const priorRate = smoothedMetricsRef.current.layersPerSec;
              const smoothedRate = priorRate > 0
                ? ((1 - alpha) * priorRate + alpha * rawRate)
                : rawRate;
              smoothedMetricsRef.current.layersPerSec = smoothedRate;
              setLiveLayersPerSec(smoothedRate);

              const remaining = Math.max(0, safeTotal - safeDone);
              if (smoothedRate > 0) {
                const rawRemainingMs = (remaining / smoothedRate) * 1000;
                const priorRemaining = smoothedMetricsRef.current.remainingMs;
                const smoothedRemaining = priorRemaining > 0
                  ? ((1 - alpha) * priorRemaining + alpha * rawRemainingMs)
                  : rawRemainingMs;
                smoothedMetricsRef.current.remainingMs = smoothedRemaining;
                setEstimatedRemainingMs(smoothedRemaining);
              }
            }
          } else if (rasterStartedMs != null) {
            rasterAccumulatedMs += nowMs - rasterStartedMs;
            rasterStartedMs = null;
            setCurrentRasterMs(rasterAccumulatedMs);
            setLiveLayersPerSec(null);
            setEstimatedRemainingMs(null);
          } else {
            setLiveLayersPerSec(null);
            setEstimatedRemainingMs(null);
          }
        },
        onLayerPreview: (layerIndex, totalLayers, pngBytes) => {
          completedTotalLayers = Math.max(completedTotalLayers, totalLayers);
          onLayerPreviewGenerated?.({
            layerIndex,
            totalLayers,
            pngBytes,
          });
          const blobBytes = Uint8Array.from(pngBytes);
          const blob = new Blob([blobBytes.buffer], { type: 'image/png' });
          const nextUrl = URL.createObjectURL(blob);
          setLayerPreviewUrls((previous) => {
            const next = previous.slice();
            const requiredLength = Math.max(totalLayers, layerIndex + 1);
            if (next.length < requiredLength) {
              next.length = requiredLength;
            }
            const prevUrl = next[layerIndex];
            if (prevUrl) URL.revokeObjectURL(prevUrl);
            next[layerIndex] = nextUrl;
            return next;
          });
          setPreviewTotalLayers(totalLayers);
          setPreviewSelectedLayer((previousLayer) => {
            if (!Number.isFinite(previousLayer) || previousLayer <= 0) {
              return Math.max(1, Math.min(totalLayers, layerIndex + 1));
            }
            return Math.max(1, Math.min(totalLayers, previousLayer));
          });
        },
      });

      setCurrentPhase('Encoding');
      setSliceStatus('Encoding');

      const runEndMs = performance.now();
      completedTotalLayersFromResult = Math.max(completedTotalLayersFromResult, result.benchmark.totalLayers ?? 0);
      if (rasterStartedMs != null) {
        rasterAccumulatedMs += runEndMs - rasterStartedMs;
      }

      const elapsedMs = runEndMs - runStartMs;
      const benchmarkTotalMs = result.benchmark.totalElapsedMs;
      const benchmarkCoreMs = result.benchmark.coreSlicingMs;
      setCurrentElapsedMs(benchmarkTotalMs);
      setCurrentRasterMs(benchmarkCoreMs ?? rasterAccumulatedMs);
      setLastBenchmark(result.benchmark);

      const effectiveElapsedMs = benchmarkTotalMs || elapsedMs;
      const effectiveCoreMs = benchmarkCoreMs ?? rasterAccumulatedMs;
      const effectiveMeshPrepMs = result.benchmark.meshPrepMs ?? 0;
      const effectivePostRasterMs = Math.max(
        0,
        effectiveElapsedMs - effectiveCoreMs - effectiveMeshPrepMs,
      );

      console.groupCollapsed('[SlicingPerf] Native slicing summary');
      console.log({
        backend: result.backend,
        outputFormat: result.outputFormat,
        totalElapsedMs: Number(effectiveElapsedMs.toFixed(2)),
        meshPrepMs: Number(effectiveMeshPrepMs.toFixed(2)),
        rasterizingMs: Number(effectiveCoreMs.toFixed(2)),
        postRasterMs: Number(effectivePostRasterMs.toFixed(2)),
        totalLayers: result.benchmark.totalLayers,
        layersPerSecond: result.benchmark.layersPerSecond,
        artifactBytes: result.artifact?.byteSize ?? null,
      });
      console.info(
        '[SlicingPerf] Detailed worker stage timing (raster/pack/zip) is emitted by native Rust logs with the same prefix.',
      );
      console.groupEnd();

      setLifetimeTelemetry((prev) => ({
        runCount: prev.runCount + 1,
        totalElapsedMs: prev.totalElapsedMs + effectiveElapsedMs,
        totalRasterMs: prev.totalRasterMs + effectiveCoreMs,
        lastElapsedMs: effectiveElapsedMs,
        lastRasterMs: effectiveCoreMs,
        lastBackend: result.backend,
      }));

      setCurrentPhase('Ready');
      setSliceStatus(`Generated ${result.outputFormat} via native Rust backend.`);
      setSlicingModalStage('finished');
      slicingSucceeded = true;
      if (result.artifact) {
        onSliceArtifactReady?.(result.artifact);
      }
      if (result.benchmark) {
        onBenchmarkComplete?.(result.benchmark);
      }
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') {
        setCurrentPhase('Cancelled');
        setSliceStatus('Cancelled');
        setSlicingModalStage('cancelled');
      } else {
        console.error('Slice ZIP export failed:', error);
        const message = error instanceof Error ? error.message : 'Unknown slicing error.';
        
        // If disk space error, aggressively clean ALL temp files to recover space
        if (message.includes('not enough space') || message.includes('os error 112') || message.includes('disk full')) {
          console.warn('[Slicing] Disk space error detected — cleaning ALL temp artifacts.');
          await cleanupAllPrintTempArtifacts().then((removed) => {
            console.info(`[Slicing] Emergency cleanup removed ${removed} temp file(s).`);
            alert(`Disk space error! Cleaned ${removed} temporary slice files. Please free up disk space or slice at lower resolution.`);
          }).catch((cleanupErr) => {
            console.error('[Slicing] Emergency cleanup failed:', cleanupErr);
            alert(`Slice ZIP export failed: ${message}\n\nFailed to clean temp files. Please manually delete files in %TEMP% matching "dragonfruit-slice-*"`);
          });
        } else {
          alert(`Slice ZIP export failed: ${message}`);
        }
        
        setCurrentPhase('Failed');
        setSliceStatus('Failed');
        setSlicingModalStage('failed');
      }
    } finally {
      if (slicingAbortControllerRef.current === abortController) {
        slicingAbortControllerRef.current = null;
      }
      setIsSlicingZip(false);
      onSlicingBusyChange?.(false);
      if (slicingSucceeded) {
        setCurrentPhase('Opening');
        setSliceStatus('Opening');
        onSlicingFinished?.({ totalLayers: Math.max(completedTotalLayers, completedTotalLayersFromResult, 1) });
      }
    }
  };

  const handleCancelSlicing = useCallback(() => {
    if (!isSlicingZip) return;
    setCurrentPhase('Cancelling');
    setSliceStatus('Cancelling');
    slicingAbortControllerRef.current?.abort();
  }, [isSlicingZip]);

  // Close intent dropdown on outside click
  useEffect(() => {
    if (!sliceIntentMenuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inAnchor = sliceIntentAnchorRef.current?.contains(target);
      const inMenu = sliceIntentMenuRef.current?.contains(target);
      if (!inAnchor && !inMenu) {
        setSliceIntentMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sliceIntentMenuOpen]);

  // If menu is open and network options disappear, close the menu.
  useEffect(() => {
    if ((canUpload || canPrint) || !sliceIntentMenuOpen) return;
    setSliceIntentMenuOpen(false);
  }, [canUpload, canPrint, sliceIntentMenuOpen]);

  // Populate the slice trigger ref so parent can call slice from outside
  useEffect(() => {
    handleSliceZipExportRef.current = handleSliceZipExport;
  }, [handleSliceZipExport]);

  // Populate the slice trigger ref so parent can call slice from outside
  useEffect(() => {
    if (onSliceTriggerRef) {
      onSliceTriggerRef.current = handleSliceZipExport;
    }
  }, [handleSliceZipExport, onSliceTriggerRef]);

  // Auto-trigger slice when shouldAutoSlice becomes true
  useEffect(() => {
    if (!shouldAutoSlice) {
      if (autoSliceTimeoutRef.current !== null) {
        window.clearTimeout(autoSliceTimeoutRef.current);
        autoSliceTimeoutRef.current = null;
      }
      autoSliceTriggeredRef.current = false;
      return;
    }

    if (autoSliceTriggeredRef.current || isSlicingZip || autoSliceTimeoutRef.current !== null) {
      return;
    }

    // Use setTimeout to ensure DOM is ready and state is settled.
    // Increased from 50ms to 500ms to reduce excessive temp file creation during rapid changes.
    autoSliceTimeoutRef.current = window.setTimeout(() => {
      autoSliceTimeoutRef.current = null;
      if (autoSliceTriggeredRef.current) return;
      autoSliceTriggeredRef.current = true;
      void handleSliceZipExportRef.current?.();
    }, 500);

    return () => {
      if (autoSliceTimeoutRef.current !== null) {
        window.clearTimeout(autoSliceTimeoutRef.current);
        autoSliceTimeoutRef.current = null;
      }
    };
  }, [isSlicingZip, shouldAutoSlice]);

  const selectedLayerPreviewUrl = useMemo(() => {
    if (previewSelectedLayer < 1) return null;
    return layerPreviewUrls[previewSelectedLayer - 1] ?? null;
  }, [layerPreviewUrls, previewSelectedLayer]);

  const handleCloseSlicingModal = useCallback(() => {
    setShowSlicingModal(false);
    clearLayerPreviewUrls();
    setPreviewTotalLayers(0);
    setPreviewSelectedLayer(1);
  }, [clearLayerPreviewUrls]);

  if (models.length === 0) {
    return (
      <Card className="w-72">
        <CardHeader
          left={(
            <>
              <IconButton
                onClick={() => setIsExpanded((prev) => !prev)}
                className="!p-0.5"
                title={isExpanded ? 'Collapse card' : 'Expand card'}
              >
                <svg
                  className="w-3 h-3 transform transition-transform"
                  style={{ color: isExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {isExpanded ? (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  ) : (
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  )}
                </svg>
              </IconButton>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Slicing</h2>
            </>
          )}
          hideDivider={!isExpanded}
        />
        {isExpanded && (
          <div className="px-3 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            No meshes loaded yet. Import a model first, then return to Slicing.
          </div>
        )}
      </Card>
    );
  }

  return (
    <Card className="w-72">
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setIsExpanded((prev) => !prev)}
              className="!p-0.5"
              title={isExpanded ? 'Collapse card' : 'Expand card'}
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: isExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isExpanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Slicing</h2>
          </>
        )}
        hideDivider={!isExpanded}
      />

      {isExpanded && (
        <div className="px-3 pt-2 pb-3 space-y-2.5">
          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              <Gauge className="w-3.5 h-3.5" />
              <span>Print Profile</span>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Printer</div>
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={activePrinterProfile?.name ?? 'No printer selected'}>
                  {activePrinterProfile?.name ?? 'No printer selected'}
                </div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Material</div>
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={resolvedMaterialLabel}>
                  {resolvedMaterialLabel}
                </div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Output</div>
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                  {selectedFormat?.displayName ?? selectedFormat?.outputFormat ?? '—'}
                </div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Layer Height</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {effectiveLayerHeightMm != null ? `${effectiveLayerHeightMm.toFixed(3)} mm` : '—'}
                </div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Est. Volume</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedVolumeLabel}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Est. Print Time</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedPrintTimeLabel}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Est. Layers</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedLayerCount > 0 ? estimatedLayerCount : '—'}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Engine</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {slicerEngineVersion ? `v${slicerEngineVersion}` : 'Slicer V3'}
                </div>
              </div>
            </div>

            {showRemoteOfflineLayerHeightOverride && (
              <div className="mt-2 rounded-md border p-2 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                <div className="space-y-0.5 text-center">
                  <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>
                    Offline Layer Height
                  </div>
                  <div className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    No remote material profile is loaded right now.
                  </div>
                </div>

                <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="flex min-w-0 items-center gap-1">
                    <IconButton
                      className="!h-8 !w-8 shrink-0 !p-0"
                      onClick={() => setClampedRemoteOfflineLayerHeightMm(remoteOfflineLayerHeightMm - 0.005)}
                      disabled={remoteOfflineLayerHeightMm <= 0.001}
                      title="Decrease offline layer height"
                    >
                      <Minus className="h-3.5 w-3.5" />
                    </IconButton>

                    <input
                      type="number"
                      min={0.001}
                      max={1}
                      step={0.005}
                      value={remoteOfflineLayerHeightDraft ?? String(remoteOfflineLayerHeightMm)}
                      onFocus={beginRemoteOfflineLayerHeightEdit}
                      onChange={(event) => setRemoteOfflineLayerHeightDraft(event.target.value)}
                      onBlur={commitRemoteOfflineLayerHeightEdit}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitRemoteOfflineLayerHeightEdit();
                          event.currentTarget.blur();
                          return;
                        }

                        if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelRemoteOfflineLayerHeightEdit();
                          event.currentTarget.blur();
                        }
                      }}
                      onWheel={(event) => {
                        event.preventDefault();
                        setClampedRemoteOfflineLayerHeightMm(remoteOfflineLayerHeightMm + (event.deltaY < 0 ? 0.005 : -0.005));
                      }}
                      className="ui-input h-8 w-0 min-w-0 flex-1 px-0 text-xs sm:text-sm text-center tabular-nums font-semibold no-spinners"
                      aria-label="Offline layer height override in millimeters"
                    />

                    <IconButton
                      className="!h-8 !w-8 shrink-0 !p-0"
                      onClick={() => setClampedRemoteOfflineLayerHeightMm(remoteOfflineLayerHeightMm + 0.005)}
                      disabled={remoteOfflineLayerHeightMm >= 1}
                      title="Increase offline layer height"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </IconButton>
                  </div>
                </div>

                <div className="text-[11px] leading-snug text-center" style={{ color: 'var(--text-muted)' }}>
                  Networking is currently unavailable, so this slice will use offline import. Set the layer height here, then choose the matching resin profile on the machine before printing.
                </div>
              </div>
            )}
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
              <Cpu className="w-3.5 h-3.5" />
              <span>Quality Settings</span>
            </div>

            <div className="space-y-1">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Anti-Aliasing</div>
              <div className="grid grid-cols-5 gap-1">
                {(['Off', '2x', '4x', '8x', '16x'] as const).map((level) => {
                  const active = antiAliasingLevel === level;
                  return (
                    <button
                      key={level}
                      type="button"
                      disabled={!antiAliasingAvailable}
                      aria-disabled={!antiAliasingAvailable}
                      className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                      style={!antiAliasingAvailable
                        ? {
                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--surface-0), black 8%)',
                            color: 'color-mix(in srgb, var(--text-muted), black 18%)',
                            cursor: 'not-allowed',
                            opacity: 0.68,
                          }
                        : active
                          ? {
                              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
                              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                              color: 'var(--text-strong)',
                            }
                          : {
                              borderColor: 'var(--border-subtle)',
                              background: 'var(--surface-0)',
                              color: 'var(--text-muted)',
                            }}
                      onClick={() => setAntiAliasingLevel(level)}
                    >
                      {level}
                    </button>
                  );
                })}
              </div>
              {!antiAliasingAvailable && (
                <div
                  className="mt-2 px-1 text-[11px] leading-snug font-mono text-center"
                  style={{
                    color: 'color-mix(in srgb, #fca5a5, var(--text-muted) 38%)',
                  }}
                >
                  The selected Machine does not support AA at this time.
                </div>
              )}
                {antiAliasingAvailable && (
                  <div className="space-y-1">
                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Minimum Alpha</div>
                    {hasProfileMinimumAaAlpha && (
                      <div className="grid grid-cols-2 gap-1">
                        <button
                          type="button"
                          disabled={minimumAaControlsDisabled}
                          aria-disabled={minimumAaControlsDisabled}
                          className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                          style={(!enableMinimumAaAlphaOverride && !minimumAaControlsDisabled)
                            ? {
                                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
                                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                                color: 'var(--text-strong)',
                              }
                            : {
                                borderColor: 'var(--border-subtle)',
                                background: minimumAaControlsDisabled
                                  ? 'color-mix(in srgb, var(--surface-0), black 8%)'
                                  : 'var(--surface-0)',
                                color: minimumAaControlsDisabled
                                  ? 'color-mix(in srgb, var(--text-muted), black 18%)'
                                  : 'var(--text-muted)',
                                cursor: minimumAaControlsDisabled ? 'not-allowed' : 'pointer',
                                opacity: minimumAaControlsDisabled ? 0.68 : 1,
                              }}
                          onClick={() => {
                            if (minimumAaControlsDisabled) return;
                            setEnableMinimumAaAlphaOverride(false);
                          }}
                        >
                          {`Profile (${profileMinimumAaAlphaPercent}%)`}
                        </button>
                        <button
                          type="button"
                          disabled={minimumAaControlsDisabled}
                          aria-disabled={minimumAaControlsDisabled}
                          className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                          style={(enableMinimumAaAlphaOverride && !minimumAaControlsDisabled)
                            ? {
                                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
                                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                                color: 'var(--text-strong)',
                              }
                            : {
                                borderColor: 'var(--border-subtle)',
                                background: minimumAaControlsDisabled
                                  ? 'color-mix(in srgb, var(--surface-0), black 8%)'
                                  : 'var(--surface-0)',
                                color: minimumAaControlsDisabled
                                  ? 'color-mix(in srgb, var(--text-muted), black 18%)'
                                  : 'var(--text-muted)',
                                cursor: minimumAaControlsDisabled ? 'not-allowed' : 'pointer',
                                opacity: minimumAaControlsDisabled ? 0.68 : 1,
                              }}
                          onClick={() => {
                            if (minimumAaControlsDisabled) return;
                            setEnableMinimumAaAlphaOverride(true);
                          }}
                        >
                          Override
                        </button>
                      </div>
                    )}
                    {(enableMinimumAaAlphaOverride || !hasProfileMinimumAaAlpha) && (
                      <div className="mt-1 rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                        <div className="flex min-w-0 items-center gap-1">
                          <IconButton
                            className="!h-8 !w-8 shrink-0 !p-0"
                            onClick={() => setClampedMinimumAaAlphaPercent(minimumAaAlphaPercent - 1)}
                            disabled={minimumAaControlsDisabled || minimumAaAlphaPercent <= 0}
                            title="Decrease minimum alpha"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </IconButton>

                          <input
                            type="number"
                            min={0}
                            max={100}
                            step={1}
                            value={minimumAaAlphaPercent}
                            disabled={minimumAaControlsDisabled}
                            aria-disabled={minimumAaControlsDisabled}
                            onChange={(event) => setClampedMinimumAaAlphaPercent(Number(event.target.value))}
                            onWheel={(event) => {
                              if (minimumAaControlsDisabled) return;
                              event.preventDefault();
                              setClampedMinimumAaAlphaPercent(minimumAaAlphaPercent + (event.deltaY < 0 ? 1 : -1));
                            }}
                            className="ui-input h-8 w-0 min-w-0 flex-1 px-0 text-xs sm:text-sm text-center tabular-nums font-semibold no-spinners"
                            aria-label="Minimum alpha percent override"
                          />

                          <IconButton
                            className="!h-8 !w-8 shrink-0 !p-0"
                            onClick={() => setClampedMinimumAaAlphaPercent(minimumAaAlphaPercent + 1)}
                            disabled={minimumAaControlsDisabled || minimumAaAlphaPercent >= 100}
                            title="Increase minimum alpha"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </IconButton>
                        </div>
                      </div>
                    )}
                  </div>
                )}
            </div>
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <button
              type="button"
              className="mb-1 w-full flex items-center justify-between gap-2 text-left"
              onClick={() => setIsThumbnailDrawerOpen((prev) => !prev)}
              aria-expanded={isThumbnailDrawerOpen}
              aria-label="Toggle thumbnail settings"
            >
              <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
                <Layers3 className="w-3.5 h-3.5" />
                <span>Thumbnails</span>
              </span>
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: isThumbnailDrawerOpen ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isThumbnailDrawerOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </button>

            {isThumbnailDrawerOpen && (
              <div className="mt-1 space-y-2">

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs" style={{ color: 'var(--text-strong)' }}>Background gradient</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Scene mood overlay in thumbnail</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={thumbnailIncludeGradient}
                  onClick={() => onThumbnailRenderOptionsChange?.({ includeGradient: !thumbnailIncludeGradient })}
                  className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors shrink-0"
                  style={{
                    background: thumbnailIncludeGradient ? 'var(--accent)' : 'var(--surface-2)',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform ${thumbnailIncludeGradient ? 'translate-x-4' : 'translate-x-0'}`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs" style={{ color: 'var(--text-strong)' }}>Build plate</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Render build plate in thumbnail</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={thumbnailIncludeBuildPlate}
                  onClick={() => onThumbnailRenderOptionsChange?.({ includeBuildPlate: !thumbnailIncludeBuildPlate })}
                  className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors shrink-0"
                  style={{
                    background: thumbnailIncludeBuildPlate ? 'var(--accent)' : 'var(--surface-2)',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform ${thumbnailIncludeBuildPlate ? 'translate-x-4' : 'translate-x-0'}`}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs" style={{ color: 'var(--text-strong)' }}>Grid</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Render build grid in thumbnail</div>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={thumbnailIncludeGrid}
                  onClick={() => onThumbnailRenderOptionsChange?.({ includeGrid: !thumbnailIncludeGrid })}
                  className="w-10 h-6 rounded-full flex items-center px-0.5 transition-colors shrink-0"
                  style={{
                    background: thumbnailIncludeGrid ? 'var(--accent)' : 'var(--surface-2)',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    className={`w-5 h-5 rounded-full bg-white shadow transform transition-transform ${thumbnailIncludeGrid ? 'translate-x-4' : 'translate-x-0'}`}
                  />
                </button>
              </div>
              </div>
            )}
          </div>

          {/* Slice intent split-button */}
          {(() => {
            const isDisabled = isSlicingZip || !activePrinterProfile || !materialProfileForSlicing || models.length === 0;
            type IconType = React.FC<{ className?: string }>;
            const intentOptions: { key: SliceIntent; label: string; Icon: IconType; enabled: boolean }[] = [
              { key: 'file',    label: 'Slice to File',  Icon: Download as IconType, enabled: true },
              { key: 'upload',  label: 'Slice & Upload', Icon: Printer  as IconType, enabled: canUpload },
              { key: 'print',   label: 'Slice & Print',  Icon: Play     as IconType, enabled: canPrint },
            ];
            const current = intentOptions.find((o) => o.key === effectiveSliceIntent) ?? intentOptions[0]!;
            const CurrentIcon = current.Icon;
            const hasNetworkOptions = canUpload || canPrint;
            return (
              <div ref={sliceIntentAnchorRef} className="relative w-full">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => { void handleSliceZipExport(); }}
                    disabled={isDisabled}
                    className={`ui-button ui-button-primary flex-1 !h-9 text-sm inline-flex items-center justify-center gap-1.5 ${hasNetworkOptions && !isShiftHeld ? 'rounded-r-none' : ''} ${isSlicingZip ? 'cursor-wait opacity-70' : ''}`}
                  >
                    <CurrentIcon className="w-4 h-4 shrink-0" />
                    {isSlicingZip ? 'Slicing…' : current.label}
                  </button>
                  {hasNetworkOptions && !isShiftHeld && (
                    <button
                      type="button"
                      onClick={() => {
                        const rect = sliceIntentAnchorRef.current?.getBoundingClientRect() ?? null;
                        setSliceIntentMenuRect(rect);
                        setSliceIntentMenuOpen((v) => !v);
                      }}
                      disabled={isDisabled}
                      aria-label="Choose slice action"
                      className="ui-button ui-button-primary !h-9 w-10 shrink-0 inline-flex items-center justify-center rounded-l-none border-l border-black/15"
                    >
                      <ChevronDown
                        className={`h-6 w-6 transition-transform duration-200 ease-out ${sliceIntentMenuOpen ? 'rotate-180' : 'rotate-0'}`}
                      />
                    </button>
                  )}
                </div>
                {sliceIntentMenuOpen && sliceIntentMenuRect && typeof document !== 'undefined' && createPortal(
                  <div
                    ref={sliceIntentMenuRef}
                    className="rounded-md border overflow-hidden"
                    style={{
                      position: 'fixed',
                      top: `${sliceIntentMenuRect.bottom + 6}px`,
                      left: sliceIntentMenuRect.left,
                      width: sliceIntentMenuRect.width,
                      zIndex: 9999,
                      background: 'var(--surface-1)',
                      borderColor: 'var(--border-subtle)',
                      boxShadow: '0 14px 24px rgba(0,0,0,0.34)',
                    }}
                  >
                    {intentOptions.map(({ key, label, Icon, enabled }) => (
                      <button
                        key={key}
                        type="button"
                        disabled={!enabled}
                        onClick={() => {
                          setSliceIntent(key);
                          onSliceIntentChanged?.(key);
                          setSliceIntentMenuOpen(false);
                        }}
                        className="w-full grid grid-cols-[16px_minmax(0,1fr)_16px] items-center gap-2 px-3 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        style={{
                          color: key === sliceIntent ? 'var(--accent)' : 'var(--text-strong)',
                          background: key === sliceIntent ? 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)' : 'transparent',
                        }}
                        onMouseEnter={(e) => { if (key !== sliceIntent && enabled) (e.currentTarget as HTMLElement).style.background = 'var(--surface-2)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = key === sliceIntent ? 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)' : 'transparent'; }}
                      >
                        <Icon className="w-4 h-4 shrink-0" />
                        <span className="text-center">{label}</span>
                        <span aria-hidden="true" className="w-4 h-4" />
                      </button>
                    ))}
                  </div>,
                  document.body,
                )}
              </div>
            );
          })()}
        </div>
      )}

      {showSlicingModal && typeof document !== 'undefined' && createPortal(
        <div className="fixed left-0 right-0 top-[var(--topbar-height)] bottom-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3">
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Slicing progress"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                    color: 'var(--accent)',
                  }}
                >
                  <Layers3 className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Background Pipeline
                  </div>
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Slicing Plate
                  </h2>
                </div>
              </div>
              <div
                className="rounded-md border px-2.5 py-1 text-xs font-medium"
                style={{
                  borderColor: slicingModalStage === 'failed'
                    ? 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)'
                    : slicingModalStage === 'cancelled'
                      ? 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)'
                    : slicingModalStage === 'finished'
                      ? 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)'
                      : 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                  color: slicingModalStage === 'failed'
                    ? '#fca5a5'
                    : slicingModalStage === 'cancelled'
                      ? '#fcd34d'
                    : slicingModalStage === 'finished'
                      ? '#86efac'
                      : 'var(--text-strong)',
                  background: 'var(--surface-1)',
                }}
              >
                {slicingModalStage === 'running'
                  ? 'Running'
                  : slicingModalStage === 'finished'
                    ? 'Ready'
                    : slicingModalStage === 'cancelled'
                      ? 'Cancelled'
                    : 'Failed'}
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Pipeline Stage</div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={currentPhase}>{currentPhase}</div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{progressCounterLabel}</div>
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
                    {progressCounterValue}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Progress</div>
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{Math.round(displayProgressPercent)}%</div>
                </div>
                {slicingModalStage === 'running' && liveLayersPerSec != null && (
                  <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Speed</div>
                    <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{formatLayerRate(liveLayersPerSec)}</div>
                  </div>
                )}
              </div>

              {slicingModalStage === 'finished' && previewTotalLayers > 0 && (
                <div className="rounded-lg border p-2.5 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Plate preview · Layer {previewSelectedLayer}/{previewTotalLayers}
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, previewTotalLayers)}
                    step={1}
                    value={Math.max(1, Math.min(previewTotalLayers || 1, previewSelectedLayer))}
                    onChange={(event) => setPreviewSelectedLayer(Number(event.target.value))}
                    className="w-full"
                  />
                  {selectedLayerPreviewUrl ? (
                    <img
                      src={selectedLayerPreviewUrl}
                      alt={`Layer ${previewSelectedLayer} preview`}
                      className="w-full h-36 rounded object-contain"
                    />
                  ) : (
                    <div className="h-36 rounded border border-dashed flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                      Preview for this layer is not available.
                    </div>
                  )}
                </div>
              )}

              <div className="h-2.5 rounded overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                <div
                  className="h-full"
                  style={{ width: `${displayProgressPercent.toFixed(1)}%`, background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))' }}
                />
              </div>

              <div className="pt-1 flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <Timer className="h-3.5 w-3.5" />
                  <span>Elapsed {slicingElapsedLabel}</span>
                </div>

                <div className="flex items-center gap-2">
                  {slicingModalStage === 'running' && (
                    <Button
                      variant="secondary"
                      className="!h-9 text-xs"
                      disabled={!canCancelSlicing}
                      onClick={handleCancelSlicing}
                    >
                      {canCancelSlicing ? 'Cancel Slicing' : 'Finishing…'}
                    </Button>
                  )}
                  {slicingModalStage !== 'running' && (
                    <Button
                      variant="secondary"
                      className="!h-9 text-xs"
                      onClick={handleCloseSlicingModal}
                    >
                      Close Plate
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </Card>
  );
}

export default SlicingPanel;
