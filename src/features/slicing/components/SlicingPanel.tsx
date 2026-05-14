import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, CircleHelp, Cpu, Download, Edit3, Layers3, Play, Printer, Timer } from 'lucide-react';
import { MouseTooltip } from '@/components/ui/MouseTooltip';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { KNOWN_SOURCE_EXTENSION_STRIP_RE } from '@/features/plugins/pluginFileTypeExtensions';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
import { openProfileSettingsModal } from '@/components/settings/profileModalEvents';
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
import { resolveCompositeMaterialLabel } from '@/utils/materialLabel';
import { cleanupStalePrintTempArtifacts, cleanupAllPrintTempArtifacts, getSlicerEngineVersion } from '@/features/slicing/tauri/nativeSlicerBridge';

export type SliceIntent = 'file' | 'upload' | 'print' | 'preview';

interface SlicingPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
  estimatedLayerCountOverride?: number | null;
  estimatedVolumeLabelOverride?: string | null;
  captureSceneThumbnailPng?: () => Promise<Uint8Array | null>;
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
  onBeforeSlicingRun?: () => Promise<void> | void;
  resolveOutputPathForIntent?: (intent: SliceIntent) => string | null | undefined;
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

  const withoutKnownExt = trimmed.replace(KNOWN_SOURCE_EXTENSION_STRIP_RE, '');
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
  if (lower.includes('saving scene')) return 'preparing';
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

const SLICING_AA_MODE_STORAGE_KEY = 'dragonfruit.slicing.aaMode';
const SLICING_AA_LEVEL_STORAGE_KEY = 'dragonfruit.slicing.aaLevel';
const SLICING_AA_LEVEL_CUSTOM_ENABLED_STORAGE_KEY = 'dragonfruit.slicing.aaLevelCustomEnabled';
const SLICING_BLUR_BRUSH_RADIUS_STORAGE_KEY = 'dragonfruit.slicing.blurBrushRadiusPx';
const SLICING_BLUR_BRUSH_CUSTOM_ENABLED_STORAGE_KEY = 'dragonfruit.slicing.blurBrushRadiusCustomEnabled';
const SLICING_MIN_AA_ALPHA_STORAGE_KEY = 'dragonfruit.slicing.minimumAaAlphaPercent';
const SLICING_MIN_AA_ALPHA_OVERRIDE_ENABLED_KEY = 'dragonfruit.slicing.minimumAaAlphaOverrideEnabled';
const SLICING_3DAA_LOOK_BACK_STORAGE_KEY = 'dragonfruit.slicing.3daaLookBack';
const SLICING_3DAA_LOOK_BACK_CUSTOM_ENABLED_STORAGE_KEY = 'dragonfruit.slicing.3daaLookBackCustomEnabled';
const SLICING_3DAA_FADE_PX_STORAGE_KEY = 'dragonfruit.slicing.3daaFadePx';
const SLICING_3DAA_FADE_PX_CUSTOM_ENABLED_STORAGE_KEY = 'dragonfruit.slicing.3daaFadePxCustomEnabled';
const SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY = 'dragonfruit.slicing.remoteOfflineLayerHeightMm';
const SLICING_INTENT_BY_PRINTER_PROFILE_STORAGE_KEY = 'dragonfruit.slicing.intentByPrinterProfile.v1';
const REMOTE_OFFLINE_LAYER_HEIGHT_MIN_MM = 0.01;
const REMOTE_OFFLINE_LAYER_HEIGHT_MAX_MM = 1;
const REMOTE_OFFLINE_LAYER_HEIGHT_STEP_MM = 0.01;
const MICRONS_PER_MM = 1000;
const AA_STRENGTH_PRESETS = [2, 4, 8, 16] as const;
const AA_STRENGTH_MIN_STEPS = 2;
const AA_STRENGTH_MAX_STEPS = 64;
const BLUR_WIDTH_PRESETS = [1, 2, 4, 8] as const;
const BLUR_WIDTH_MIN_PX = 1;
const BLUR_WIDTH_MAX_PX = 64;
const LOOK_BACK_PRESETS = [1, 2, 3, 4] as const;
const LOOK_BACK_MIN_LAYERS = 1;
const LOOK_BACK_MAX_LAYERS = 16;
const FADE_DISTANCE_PRESETS = [5, 10, 20, 40] as const;
const FADE_DISTANCE_MIN_PX = 1;
const FADE_DISTANCE_MAX_PX = 256;

function isPresetValue(presets: readonly number[], value: number): boolean {
  return presets.some((preset) => preset === value);
}

function resolveInitialCustomOptionEnabled(storageKey: string, fallback = false): boolean {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(storageKey)
    ?? window.sessionStorage.getItem(storageKey);
  if (stored === 'true') return true;
  if (stored === 'false') return false;
  return fallback;
}

function SettingLabelWithHelp({
  label,
  help,
}: {
  label: string;
  help: string;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-muted)' }}>
      <span>{label}</span>
      <span
        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border cursor-help relative"
        style={{
          borderColor: 'var(--border-subtle)',
          background: 'var(--surface-0)',
          color: 'var(--text-muted)',
        }}
        tabIndex={0}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        aria-label={`${label}. ${help}`}
      >
        <CircleHelp className="h-2.5 w-2.5" />
        <MouseTooltip visible={hovered} offset={{ x: 0, y: 28 }} className="left-1/2 -translate-x-1/2">
          <div
            className="rounded px-2 py-1.5 text-[11px] leading-tight font-medium shadow-lg"
            style={{
              background: 'rgba(24, 24, 24, 0.98)',
              color: 'var(--text-strong, #e0e0e0)',
              border: '1px solid var(--accent, #baf72e)',
              maxWidth: 260,
              whiteSpace: 'normal',
              textAlign: 'left',
              boxShadow: '0 6px 32px 0 rgba(0,0,0,0.44), 0 1.5px 8px 0 rgba(0,0,0,0.28)',
            }}
          >
            {help}
          </div>
        </MouseTooltip>
      </span>
    </div>
  );
}

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

function clampRemoteOfflineLayerHeightMm(value: number, fallback = 0.05): number {
  const fallbackClamped = Math.max(
    REMOTE_OFFLINE_LAYER_HEIGHT_MIN_MM,
    Math.min(REMOTE_OFFLINE_LAYER_HEIGHT_MAX_MM, fallback),
  );

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallbackClamped;

  const clamped = Math.max(
    REMOTE_OFFLINE_LAYER_HEIGHT_MIN_MM,
    Math.min(REMOTE_OFFLINE_LAYER_HEIGHT_MAX_MM, numeric),
  );
  return Math.round(clamped * 1000) / 1000;
}

function resolveInitialAaMode(): 'Off' | 'Blur' | '3DAA' {
  if (typeof window === 'undefined') return 'Off';

  const stored = window.localStorage.getItem(SLICING_AA_MODE_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_AA_MODE_STORAGE_KEY);
  if (stored === 'Off' || stored === 'Blur' || stored === '3DAA') {
    return stored;
  }
  // Migrate legacy values: old 'Blur' mode → 'Blur', old 'Coverage' mode → 'Off'.
  if (stored === 'Coverage') return 'Off';

  return 'Off';
}

type AaStrengthLevel = `${number}x`;

function parseAaLevelSteps(level: string | null | undefined): number | null {
  const trimmed = (level ?? '').trim().toLowerCase();
  if (!trimmed.endsWith('x')) return null;
  const parsed = Number(trimmed.slice(0, -1));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
}

function clampAaLevelSteps(value: number): number {
  const next = Number.isFinite(value) ? value : 4;
  return Math.max(AA_STRENGTH_MIN_STEPS, Math.min(AA_STRENGTH_MAX_STEPS, Math.round(next)));
}

function formatAaLevel(steps: number): AaStrengthLevel {
  return `${clampAaLevelSteps(steps)}x` as AaStrengthLevel;
}

function resolveInitialAaLevel(): AaStrengthLevel {
  if (typeof window === 'undefined') return formatAaLevel(4);

  const stored = window.localStorage.getItem(SLICING_AA_LEVEL_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_AA_LEVEL_STORAGE_KEY);
  const parsedSteps = parseAaLevelSteps(stored);
  if (parsedSteps != null) {
    return formatAaLevel(parsedSteps);
  }
  // Legacy/off values fall back to historical default.
  return formatAaLevel(4);
}

function resolveInitialBlurBrushRadiusPx(): number {
  if (typeof window === 'undefined') return 1;

  const stored = window.localStorage.getItem(SLICING_BLUR_BRUSH_RADIUS_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_BLUR_BRUSH_RADIUS_STORAGE_KEY);
  if (stored == null || stored.trim().length === 0) return 1;

  const parsed = Number(stored);
  if (!Number.isFinite(parsed)) return 1;
  const rounded = Math.round(parsed);
  return Math.max(BLUR_WIDTH_MIN_PX, Math.min(BLUR_WIDTH_MAX_PX, rounded));
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

function resolveInitialZBlendLookBack(): number {
  if (typeof window === 'undefined') return 2;
  const stored = window.localStorage.getItem(SLICING_3DAA_LOOK_BACK_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_3DAA_LOOK_BACK_STORAGE_KEY);
  if (stored == null || stored.trim().length === 0) return 2;
  const parsed = Math.round(Number(stored));
  if (!Number.isFinite(parsed)) return 2;
  return Math.max(LOOK_BACK_MIN_LAYERS, Math.min(LOOK_BACK_MAX_LAYERS, parsed));
}

function resolveInitialZBlendFadePx(): number {
  if (typeof window === 'undefined') return 20;
  const stored = window.localStorage.getItem(SLICING_3DAA_FADE_PX_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_3DAA_FADE_PX_STORAGE_KEY);
  if (stored == null || stored.trim().length === 0) return 20;
  const parsed = Math.round(Number(stored));
  if (!Number.isFinite(parsed)) return 20;
  return Math.max(FADE_DISTANCE_MIN_PX, Math.min(FADE_DISTANCE_MAX_PX, parsed));
}

export function SlicingPanel({
  models,
  activeModel,
  estimatedLayerCountOverride,
  estimatedVolumeLabelOverride,
  captureSceneThumbnailPng,
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
  onBeforeSlicingRun,
  resolveOutputPathForIntent,
}: SlicingPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);
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
  const [aaMode, setAaMode] = useState<'Off' | 'Blur' | '3DAA'>(resolveInitialAaMode);
  const [aaLevel, setAaLevel] = useState<AaStrengthLevel>(resolveInitialAaLevel);
  const [useCustomAaLevel, setUseCustomAaLevel] = useState<boolean>(() => {
    const initialSteps = parseAaLevelSteps(resolveInitialAaLevel()) ?? 4;
    return resolveInitialCustomOptionEnabled(
      SLICING_AA_LEVEL_CUSTOM_ENABLED_STORAGE_KEY,
      !isPresetValue(AA_STRENGTH_PRESETS, initialSteps),
    );
  });
  const [blurBrushRadiusPx, setBlurBrushRadiusPx] = useState<number>(resolveInitialBlurBrushRadiusPx);
  const [useCustomBlurBrushRadius, setUseCustomBlurBrushRadius] = useState<boolean>(() => {
    const initial = resolveInitialBlurBrushRadiusPx();
    return resolveInitialCustomOptionEnabled(
      SLICING_BLUR_BRUSH_CUSTOM_ENABLED_STORAGE_KEY,
      !isPresetValue(BLUR_WIDTH_PRESETS, initial),
    );
  });
  const [zBlendLookBack, setZBlendLookBack] = useState<number>(resolveInitialZBlendLookBack);
  const [useCustomZBlendLookBack, setUseCustomZBlendLookBack] = useState<boolean>(() => {
    const initial = resolveInitialZBlendLookBack();
    return resolveInitialCustomOptionEnabled(
      SLICING_3DAA_LOOK_BACK_CUSTOM_ENABLED_STORAGE_KEY,
      !isPresetValue(LOOK_BACK_PRESETS, initial),
    );
  });
  const [zBlendFadePx, setZBlendFadePx] = useState<number>(resolveInitialZBlendFadePx);
  const [useCustomZBlendFadePx, setUseCustomZBlendFadePx] = useState<boolean>(() => {
    const initial = resolveInitialZBlendFadePx();
    return resolveInitialCustomOptionEnabled(
      SLICING_3DAA_FADE_PX_CUSTOM_ENABLED_STORAGE_KEY,
      !isPresetValue(FADE_DISTANCE_PRESETS, initial),
    );
  });
  const [minimumAaAlphaPercent, setMinimumAaAlphaPercent] = useState<number>(resolveInitialMinimumAaAlphaPercent);
  const [enableMinimumAaAlphaOverride, setEnableMinimumAaAlphaOverride] = useState<boolean>(resolveInitialMinimumAaAlphaOverrideEnabled);
  const [remoteOfflineLayerHeightMm, setRemoteOfflineLayerHeightMm] = useState<number>(() => {
    if (typeof window === 'undefined') return 0.05;
    const raw = window.localStorage.getItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY)
      ?? window.sessionStorage.getItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY);
    if (raw == null || raw.trim().length === 0) return 0.05;
    const parsed = Number(raw);
    return (Number.isFinite(parsed) && parsed > 0) ? clampRemoteOfflineLayerHeightMm(parsed) : 0.05;
  });
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
  const hasSlicingProgressStartedRef = useRef(false);

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
      return clampRemoteOfflineLayerHeightMm(
        remoteOfflineLayerHeightMm,
        clampRemoteOfflineLayerHeightMm(activeMaterialProfile?.layerHeightMm ?? 0.05),
      );
    }
    if (!effectiveMaterialProfile) return null;
    return clampLayerHeightMm(effectiveMaterialProfile.layerHeightMm, 0.05);
  }, [activeMaterialProfile?.layerHeightMm, effectiveMaterialProfile, remoteOfflineLayerHeightMm, showRemoteOfflineLayerHeightOverride]);

  const materialProfileForSlicing = useMemo(() => {
    if (!effectiveMaterialProfile) return null;
    if (!showRemoteOfflineLayerHeightOverride) return effectiveMaterialProfile;
    return {
      ...effectiveMaterialProfile,
      layerHeightMm: effectiveLayerHeightMm ?? clampRemoteOfflineLayerHeightMm(activeMaterialProfile?.layerHeightMm ?? 0.05),
    };
  }, [activeMaterialProfile?.layerHeightMm, effectiveLayerHeightMm, effectiveMaterialProfile, showRemoteOfflineLayerHeightOverride]);

  const estimatedLayerCount = useMemo(() => {
    if (Number.isFinite(estimatedLayerCountOverride) && Number(estimatedLayerCountOverride) > 0) {
      return Math.max(0, Math.round(Number(estimatedLayerCountOverride)));
    }

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
  }, [effectiveLayerHeightMm, estimatedLayerCountOverride, visibleModels]);

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

  const effectiveAntiAliasingLevel =
    !antiAliasingAvailable || aaMode === 'Off' ? 'Off' as const : aaLevel;
  const effectiveAntiAliasingMode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage' =
    !antiAliasingAvailable || aaMode === 'Off' ? 'Coverage' :
    aaMode === '3DAA' ? 'Vertical2' :
    'Blur';

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

  const setClampedAaLevelSteps = useCallback((value: number) => {
    setAaLevel(formatAaLevel(value));
  }, []);

  const setClampedBlurBrushRadiusPx = useCallback((value: number) => {
    const next = Number.isFinite(value) ? value : 1;
    setBlurBrushRadiusPx(Math.max(BLUR_WIDTH_MIN_PX, Math.min(BLUR_WIDTH_MAX_PX, Math.round(next))));
  }, []);

  const setClampedZBlendLookBack = useCallback((value: number) => {
    const next = Number.isFinite(value) ? value : 2;
    setZBlendLookBack(Math.max(LOOK_BACK_MIN_LAYERS, Math.min(LOOK_BACK_MAX_LAYERS, Math.round(next))));
  }, []);

  const setClampedZBlendFadePx = useCallback((value: number) => {
    const next = Number.isFinite(value) ? value : 20;
    setZBlendFadePx(Math.max(FADE_DISTANCE_MIN_PX, Math.min(FADE_DISTANCE_MAX_PX, Math.round(next))));
  }, []);

  const persistRemoteOfflineLayerHeight = useCallback((value: number) => {
    if (typeof window === 'undefined') return;

    const serialized = String(clampRemoteOfflineLayerHeightMm(value));
    window.localStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
  }, []);

  const setClampedRemoteOfflineLayerHeightMm = useCallback((value: number) => {
    setRemoteOfflineLayerHeightMm((previous) => {
      const next = clampRemoteOfflineLayerHeightMm(value, previous);
      persistRemoteOfflineLayerHeight(next);
      return next;
    });
  }, [persistRemoteOfflineLayerHeight]);

  useEffect(() => {
    void getSlicerEngineVersion().then((v) => {
      if (v) setSlicerEngineVersion(v);
    });
  }, []);

  useEffect(() => {
    if (!antiAliasingAvailable) {
      if (aaMode !== 'Off') setAaMode('Off');
      if (!enableMinimumAaAlphaOverride) setEnableMinimumAaAlphaOverride(true);
      return;
    }

    if (!hasProfileMinimumAaAlpha && !enableMinimumAaAlphaOverride) {
      setEnableMinimumAaAlphaOverride(true);
    }
  }, [antiAliasingAvailable, aaMode, enableMinimumAaAlphaOverride, hasProfileMinimumAaAlpha]);

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
    window.localStorage.setItem(SLICING_AA_MODE_STORAGE_KEY, aaMode);
    window.sessionStorage.setItem(SLICING_AA_MODE_STORAGE_KEY, aaMode);
  }, [aaMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_AA_LEVEL_STORAGE_KEY, aaLevel);
    window.sessionStorage.setItem(SLICING_AA_LEVEL_STORAGE_KEY, aaLevel);
  }, [aaLevel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(useCustomAaLevel);
    window.localStorage.setItem(SLICING_AA_LEVEL_CUSTOM_ENABLED_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_AA_LEVEL_CUSTOM_ENABLED_STORAGE_KEY, serialized);
  }, [useCustomAaLevel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(Math.max(BLUR_WIDTH_MIN_PX, Math.min(BLUR_WIDTH_MAX_PX, Math.round(blurBrushRadiusPx))));
    window.localStorage.setItem(SLICING_BLUR_BRUSH_RADIUS_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_BLUR_BRUSH_RADIUS_STORAGE_KEY, serialized);
  }, [blurBrushRadiusPx]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(useCustomBlurBrushRadius);
    window.localStorage.setItem(SLICING_BLUR_BRUSH_CUSTOM_ENABLED_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_BLUR_BRUSH_CUSTOM_ENABLED_STORAGE_KEY, serialized);
  }, [useCustomBlurBrushRadius]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_3DAA_LOOK_BACK_STORAGE_KEY, String(zBlendLookBack));
    window.sessionStorage.setItem(SLICING_3DAA_LOOK_BACK_STORAGE_KEY, String(zBlendLookBack));
  }, [zBlendLookBack]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(useCustomZBlendLookBack);
    window.localStorage.setItem(SLICING_3DAA_LOOK_BACK_CUSTOM_ENABLED_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_3DAA_LOOK_BACK_CUSTOM_ENABLED_STORAGE_KEY, serialized);
  }, [useCustomZBlendLookBack]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_3DAA_FADE_PX_STORAGE_KEY, String(zBlendFadePx));
    window.sessionStorage.setItem(SLICING_3DAA_FADE_PX_STORAGE_KEY, String(zBlendFadePx));
  }, [zBlendFadePx]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(useCustomZBlendFadePx);
    window.localStorage.setItem(SLICING_3DAA_FADE_PX_CUSTOM_ENABLED_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_3DAA_FADE_PX_CUSTOM_ENABLED_STORAGE_KEY, serialized);
  }, [useCustomZBlendFadePx]);

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

    const serialized = String(clampRemoteOfflineLayerHeightMm(remoteOfflineLayerHeightMm));
    window.localStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
  }, [remoteOfflineLayerHeightMm]);

  const resolvedMaterialLabel = useMemo(() => {
    if (showRemoteOfflineLayerHeightOverride) {
      return 'N/A';
    }

    if (isRemoteMaterialSyncConnected && selectedRemoteMaterialId) {
      if (isLoadingRemoteMaterial) return 'Loading remote material…';
      if (selectedRemoteMaterialName) return `${selectedRemoteMaterialName} (${networkUiAdapter?.displayName ?? 'Remote'})`;
      const fromConnection = activePrinterProfile?.networkConnection?.selectedMaterialName?.trim();
      if (fromConnection) return `${fromConnection} (${networkUiAdapter?.displayName ?? 'Remote'})`;
      return `${selectedRemoteMaterialId} (Remote ID)`;
    }

    return resolveCompositeMaterialLabel(effectiveMaterialProfile) ?? effectiveMaterialProfile?.name ?? 'No material selected';
  }, [
    activePrinterProfile?.networkConnection?.selectedMaterialName,
    effectiveMaterialProfile,
    isLoadingRemoteMaterial,
    isRemoteMaterialSyncConnected,
    networkUiAdapter?.displayName,
    selectedRemoteMaterialName,
    selectedRemoteMaterialId,
    showRemoteOfflineLayerHeightOverride,
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

    const resolvedOutputPath = (resolveOutputPathForIntent?.(effectiveSliceIntent) ?? '').trim();

    setIsSlicingZip(true);
    setCurrentPhase('Preparing');
    setSliceStatus('Preparing');
    setProgressDone(0);
    setProgressTotal(1);
    hasSlicingProgressStartedRef.current = false;
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

    // Fire scene save concurrently — it's best-effort and independent of mesh preparation.
    // The orchestrator uses visibleModels already captured in memory, so there's no ordering dependency.
    void Promise.resolve(onBeforeSlicingRun?.()).catch((error) => {
      console.warn('[Slicing] Pre-slice save step failed; continuing to slicing.', error);
    });

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
        outputPath: resolvedOutputPath.length > 0 ? resolvedOutputPath : null,
        antiAliasingLevel: effectiveAntiAliasingLevel,
        antiAliasingMode: effectiveAntiAliasingMode,
        blurBrushRadiusPx,
        zBlendLookBack: aaMode === '3DAA' ? zBlendLookBack : undefined,
        zBlendFadePx: aaMode === '3DAA' ? zBlendFadePx : undefined,
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

          if (isSlicingPhase) {
            hasSlicingProgressStartedRef.current = true;
            setProgressDone(safeDone);
            setProgressTotal(safeTotal);
          } else if (!hasSlicingProgressStartedRef.current) {
            // Keep pre-slice phases (Preparing / Staging) at zero progress.
            setProgressDone(0);
            setProgressTotal(1);
          }

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
          await cleanupAllPrintTempArtifacts().catch((cleanupError) => {
            console.warn('[Slicing] Temp artifact cleanup after disk-space error failed:', cleanupError);
          });
        }
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
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                className="col-span-2 relative rounded border px-1.5 py-1 pr-7 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--surface-1),white_4%)]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                onClick={() => openProfileSettingsModal('printer')}
                aria-label="Edit printer profile"
                title="Open printer profiles"
              >
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Printer</div>
                <div className="text-sm font-semibold break-words" style={{ color: 'var(--text-strong)' }} title={activePrinterProfile?.name ?? 'No printer selected'}>
                  {activePrinterProfile?.name ?? 'No printer selected'}
                </div>
                <Edit3
                  className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                className="col-span-2 relative rounded border px-1.5 py-1 pr-7 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--surface-1),white_4%)]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                onClick={() => openProfileSettingsModal('material')}
                aria-label="Edit material profile"
                title="Open material profiles"
              >
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Material</div>
                <div className="text-sm font-semibold break-words" style={{ color: 'var(--text-strong)' }} title={resolvedMaterialLabel}>
                  {resolvedMaterialLabel}
                </div>
                <Edit3
                  className="pointer-events-none absolute right-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                  aria-hidden="true"
                />
              </button>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Layers</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedLayerCount > 0 ? estimatedLayerCount : '—'}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Layer Height</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {effectiveLayerHeightMm != null ? `${effectiveLayerHeightMm.toFixed(3)} mm` : '—'}
                </div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Est. Volume</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedVolumeLabel}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Est. Print Time</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedPrintTimeLabel}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Output</div>
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                  {selectedFormat?.displayName ?? selectedFormat?.outputFormat ?? '—'}
                </div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Engine</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {slicerEngineVersion ? `v${slicerEngineVersion}` : 'Slicer V3'}
                </div>
              </div>
            </div>

            {showRemoteOfflineLayerHeightOverride && (
              <div className="mt-2 rounded-md border p-2 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="space-y-0.5 text-center">
                  <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>
                    Offline Layer Height
                  </div>
                  <div className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Remote material unavailable.
                  </div>
                </div>

                <ScrollableNumberField
                  value={remoteOfflineLayerHeightMm * MICRONS_PER_MM}
                  onChange={(nextMicrons) => setClampedRemoteOfflineLayerHeightMm(nextMicrons / MICRONS_PER_MM)}
                  min={REMOTE_OFFLINE_LAYER_HEIGHT_MIN_MM * MICRONS_PER_MM}
                  max={REMOTE_OFFLINE_LAYER_HEIGHT_MAX_MM * MICRONS_PER_MM}
                  step={REMOTE_OFFLINE_LAYER_HEIGHT_STEP_MM * MICRONS_PER_MM}
                  unit="µm"
                  ariaLabel="Offline layer height override in micrometers"
                  decreaseTitle="Decrease offline layer height"
                  increaseTitle="Increase offline layer height"
                  commitOnBlur
                />

                <div className="text-[11px] leading-snug text-center" style={{ color: 'var(--text-muted)' }}>
                  Network unavailable. <br />
                  Select a matching material during import instead.
                </div>
              </div>
            )}
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="space-y-1">
              {antiAliasingAvailable ? (
                <>
                  <SettingLabelWithHelp
                    label="Anti-Aliasing Mode"
                    help="Off disables AA. Blur smooths horizontal edges. 3DAA applies Blur and Z-axis blending between nearby layers."
                  />
                  <div className="grid grid-cols-3 gap-1">
                    {(['Off', 'Blur', '3DAA'] as const).map((mode) => {
                      const active = aaMode === mode;
                      return (
                        <button
                          key={mode}
                          type="button"
                          className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                          style={active
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
                          onClick={() => setAaMode(mode)}
                        >
                          {mode}
                        </button>
                      );
                    })}
                  </div>

                  {aaMode !== 'Off' && (
                    <>
                      <SettingLabelWithHelp
                        label="AA Strength"
                        help="Controls supersampling level before blur/Z-blending. Higher levels preserve finer edge detail but cost more slicing time."
                      />
                      <div className="grid grid-cols-5 gap-1">
                        {AA_STRENGTH_PRESETS.map((steps) => {
                          const level = formatAaLevel(steps);
                          const active = !useCustomAaLevel && aaLevel === level;
                          return (
                            <button
                              key={level}
                              type="button"
                              className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                              style={active
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
                              onClick={() => {
                                setUseCustomAaLevel(false);
                                setAaLevel(level);
                              }}
                            >
                              {level}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                          style={useCustomAaLevel
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
                          onClick={() => setUseCustomAaLevel(true)}
                        >
                          Custom
                        </button>
                      </div>
                      {useCustomAaLevel && (
                        <ScrollableNumberField
                          className="mt-1"
                          value={parseAaLevelSteps(aaLevel) ?? 4}
                          onChange={setClampedAaLevelSteps}
                          min={AA_STRENGTH_MIN_STEPS}
                          max={AA_STRENGTH_MAX_STEPS}
                          step={1}
                          unit="x"
                          ariaLabel="Custom AA strength"
                          decreaseTitle="Decrease AA strength"
                          increaseTitle="Increase AA strength"
                        />
                      )}

                      <SettingLabelWithHelp
                        label="Blur Width"
                        help="Controls edge blur width in pixels. Higher values create smoother transitions but can soften fine details."
                      />
                      <div className="grid grid-cols-5 gap-1">
                        {BLUR_WIDTH_PRESETS.map((radius) => {
                          const active = !useCustomBlurBrushRadius && blurBrushRadiusPx === radius;
                          return (
                            <button
                              key={radius}
                              type="button"
                              className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                              style={active
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
                              onClick={() => {
                                setUseCustomBlurBrushRadius(false);
                                setClampedBlurBrushRadiusPx(radius);
                              }}
                            >
                              {`${radius}px`}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                          style={useCustomBlurBrushRadius
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
                          onClick={() => setUseCustomBlurBrushRadius(true)}
                        >
                          Custom
                        </button>
                      </div>
                      {useCustomBlurBrushRadius && (
                        <ScrollableNumberField
                          className="mt-1"
                          value={blurBrushRadiusPx}
                          onChange={setClampedBlurBrushRadiusPx}
                          min={BLUR_WIDTH_MIN_PX}
                          max={BLUR_WIDTH_MAX_PX}
                          step={1}
                          unit="px"
                          ariaLabel="Custom blur width in pixels"
                          decreaseTitle="Decrease blur width"
                          increaseTitle="Increase blur width"
                        />
                      )}

                      {aaMode === '3DAA' && (
                        <>
                          <SettingLabelWithHelp
                            label="Look-Back Layers"
                            help="How many previous layers are used for Z blending. Higher values can reduce stepping but may blur very thin layer transitions."
                          />
                          <div className="grid grid-cols-5 gap-1">
                            {LOOK_BACK_PRESETS.map((n) => {
                              const active = !useCustomZBlendLookBack && zBlendLookBack === n;
                              return (
                                <button
                                  key={n}
                                  type="button"
                                  className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                                  style={active
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
                                  onClick={() => {
                                    setUseCustomZBlendLookBack(false);
                                    setClampedZBlendLookBack(n);
                                  }}
                                >
                                  {n}
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                              style={useCustomZBlendLookBack
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
                              onClick={() => setUseCustomZBlendLookBack(true)}
                            >
                              Custom
                            </button>
                          </div>
                          {useCustomZBlendLookBack && (
                            <ScrollableNumberField
                              className="mt-1"
                              value={zBlendLookBack}
                              onChange={setClampedZBlendLookBack}
                              min={LOOK_BACK_MIN_LAYERS}
                              max={LOOK_BACK_MAX_LAYERS}
                              step={1}
                              unit="lyr"
                              ariaLabel="Custom look back layer count"
                              decreaseTitle="Decrease look back"
                              increaseTitle="Increase look back"
                            />
                          )}

                          <SettingLabelWithHelp
                            label="Fade Distance"
                            help="Maximum blend distance for receding edges. Larger distances keep the gradient visible farther from the edge."
                          />
                          <div className="grid grid-cols-5 gap-1">
                            {FADE_DISTANCE_PRESETS.map((px) => {
                              const active = !useCustomZBlendFadePx && zBlendFadePx === px;
                              return (
                                <button
                                  key={px}
                                  type="button"
                                  className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                                  style={active
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
                                  onClick={() => {
                                    setUseCustomZBlendFadePx(false);
                                    setClampedZBlendFadePx(px);
                                  }}
                                >
                                  {`${px}px`}
                                </button>
                              );
                            })}
                            <button
                              type="button"
                              className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                              style={useCustomZBlendFadePx
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
                              onClick={() => setUseCustomZBlendFadePx(true)}
                            >
                              Custom
                            </button>
                          </div>
                          {useCustomZBlendFadePx && (
                            <ScrollableNumberField
                              className="mt-1"
                              value={zBlendFadePx}
                              onChange={setClampedZBlendFadePx}
                              min={FADE_DISTANCE_MIN_PX}
                              max={FADE_DISTANCE_MAX_PX}
                              step={1}
                              unit="px"
                              ariaLabel="Custom fade distance in pixels"
                              decreaseTitle="Decrease fade distance"
                              increaseTitle="Increase fade distance"
                            />
                          )}
                        </>
                      )}

                      <div className="space-y-1">
                        <SettingLabelWithHelp
                          label="Minimum Grey Level"
                          help="Sets the minimum pixel intensity used by AA gradients. Profile uses material defaults; Override lets you force a value for this slice."
                        />
                        {hasProfileMinimumAaAlpha && (
                          <div className="grid grid-cols-2 gap-1">
                            <button
                              type="button"
                              className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                              style={!enableMinimumAaAlphaOverride
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
                              onClick={() => setEnableMinimumAaAlphaOverride(false)}
                            >
                              {`Profile (${profileMinimumAaAlphaPercent}%)`}
                            </button>
                            <button
                              type="button"
                              className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                              style={enableMinimumAaAlphaOverride
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
                              onClick={() => setEnableMinimumAaAlphaOverride(true)}
                            >
                              Override
                            </button>
                          </div>
                        )}
                        {(enableMinimumAaAlphaOverride || !hasProfileMinimumAaAlpha) && (
                          <ScrollableNumberField
                            className="mt-1"
                            value={minimumAaAlphaPercent}
                            onChange={setClampedMinimumAaAlphaPercent}
                            min={0}
                            max={100}
                            step={1}
                            unit="%"
                            ariaLabel="Minimum alpha percent override"
                            decreaseTitle="Decrease minimum alpha"
                            increaseTitle="Increase minimum alpha"
                          />
                        )}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div
                  className="px-1 text-[11px] leading-snug font-mono text-center"
                  style={{
                    color: 'color-mix(in srgb, var(--danger), var(--text-muted) 38%)',
                  }}
                >
                  The selected Machine does not support AA at this time.
                </div>
              )}
            </div>
          </div>

          {/* Slice intent split-button */}
          {(() => {
            const isDisabled = isSlicingZip || !activePrinterProfile || !materialProfileForSlicing || models.length === 0;
            type IconType = React.FC<{ className?: string }>;
            const intentOptions: { key: SliceIntent; label: string; Icon: IconType; enabled: boolean; menuOnly?: boolean }[] = [
              { key: 'file',    label: 'Slice to File',  Icon: Download as IconType, enabled: true },
              { key: 'upload',  label: 'Slice & Upload', Icon: Printer  as IconType, enabled: canUpload },
              { key: 'print',   label: 'Slice & Print',  Icon: Play     as IconType, enabled: canPrint },
              { key: 'preview', label: 'Just Slice',     Icon: Cpu      as IconType, enabled: true, menuOnly: true },
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
                    {intentOptions.filter((o) => !o.menuOnly).map(({ key, label, Icon, enabled }) => (
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
                    ? 'var(--danger)'
                    : slicingModalStage === 'cancelled'
                      ? 'color-mix(in srgb, #f59e0b, var(--text-strong) 20%)'
                    : slicingModalStage === 'finished'
                      ? 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)'
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
