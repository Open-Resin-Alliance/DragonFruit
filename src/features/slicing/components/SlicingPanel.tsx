import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, CircleHelp, Cpu, Download, Edit3, ExternalLink, Layers3, Loader2, Play, Printer, Timer, X } from 'lucide-react';
import { MouseTooltip } from '@/components/ui/MouseTooltip';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { KNOWN_SOURCE_EXTENSION_STRIP_RE } from '@/features/plugins/pluginFileTypeExtensions';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { openProfileSettingsModal } from '@/components/settings/profileModalEvents';
import { MaterialAntiAliasingSection, type MaterialDraft } from '@/components/settings/profileFormAtoms';
import {
  getActiveMaterialProfile,
  getActivePrinterProfile,
  DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
  type MaterialProfile,
  getProfileStoreServerSnapshot,
  getProfileStoreSnapshot,
  subscribeToProfileStore,
  updateMaterialProfile,
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
import {
  getSavedSlicingPerformanceSettings,
  saveSlicingPerformanceSettings,
} from '@/components/settings/performancePreferences';
import {
  getSavedUvToolsSettings,
  resolveUvToolsExecutablePath,
} from '@/components/settings/uvToolsPreferences';
import { cleanupStalePrintTempArtifacts, cleanupAllPrintTempArtifacts, getSlicerEngineVersion } from '@/features/slicing/tauri/nativeSlicerBridge';
import { computePhysicalAaConfig, type AaPreset as AaAutoPreset } from '@/features/slicing/autoAaPhysics';
import { AaSupportWarningModal } from '@/components/modals/AaSupportWarningModal';
import {
  LutCurveSelector,
  LutCurveEditorModal,
  sampleCurveToLut,
  DEFAULT_CUSTOM_CURVE,
  DEFAULT_CLEAR_EXP_100_CURVE,
  DEFAULT_OPAQUE_EXP_120_230_CURVE,
  DEFAULT_SAVED_CURVES,
  type CurvePoint,
  type SavedCurve,
} from './LutCurveEditor';
import { useKeyPressed } from '@/hotkeys/hotkeyStore';

export type SliceIntent = 'file' | 'upload' | 'print' | 'preview' | 'uvtools';

interface SlicingPanelProps {
  models: LoadedModel[];
  activeModel: LoadedModel | null;
  estimatedLayerCountOverride?: number | null;
  estimatedLayerHeightMmOverride?: number | null;
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
type BlurGraySourceMode = 'minimum' | 'lut';
type ZaaPattern = 'uniform' | 'halton' | 'base2';

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
const SLICING_Z_BLUR_RADIUS_LAYERS_STORAGE_KEY = 'dragonfruit.slicing.zBlurRadiusLayers';
const SLICING_Z_BLUR_RADIUS_CUSTOM_ENABLED_STORAGE_KEY = 'dragonfruit.slicing.zBlurRadiusCustomEnabled';
const SLICING_BLUR_BRUSH_CUSTOM_ENABLED_STORAGE_KEY = 'dragonfruit.slicing.blurBrushRadiusCustomEnabled';
const SLICING_BLUR_GRAY_SOURCE_STORAGE_KEY = 'dragonfruit.slicing.blurGraySourceMode';
const SLICING_MIN_AA_ALPHA_STORAGE_KEY = 'dragonfruit.slicing.minimumAaAlphaPercent';
const SLICING_MIN_AA_ALPHA_OVERRIDE_ENABLED_KEY = 'dragonfruit.slicing.minimumAaAlphaOverrideEnabled';
const SLICING_3DAA_LOOK_BACK_STORAGE_KEY = 'dragonfruit.slicing.3daaLookBack';
const SLICING_3DAA_LOOK_BACK_CUSTOM_ENABLED_STORAGE_KEY = 'dragonfruit.slicing.3daaLookBackCustomEnabled';
const SLICING_3DAA_FADE_PX_STORAGE_KEY = 'dragonfruit.slicing.3daaFadePx';
const SLICING_3DAA_FADE_PX_CUSTOM_ENABLED_STORAGE_KEY = 'dragonfruit.slicing.3daaFadePxCustomEnabled';
const SLICING_3DAA_FADE_MODE_STORAGE_KEY = 'dragonfruit.slicing.3daaFadeMode';
const SLICING_3DAA_AUTO_MODE_STORAGE_KEY = 'dragonfruit.slicing.3daaAutoMode';
const SLICING_3DAA_RESIN_TYPE_STORAGE_KEY = 'dragonfruit.slicing.3daaResinType';
const SLICING_3DAA_SAVED_CURVES_STORAGE_KEY = 'dragonfruit.slicing.3daaSavedCurves';
const SLICING_3DAA_SELECTED_CURVE_STORAGE_KEY = 'dragonfruit.slicing.3daaSelectedCurveId';
const SLICING_ZAA_PATTERN_STORAGE_KEY = 'dragonfruit.slicing.zaaPattern';
const SLICING_ZAA_DUPLICATE_Z_STORAGE_KEY = 'dragonfruit.slicing.zaaDuplicateZ';
const SLICING_BLUR_BRUSH_KERNEL_STORAGE_KEY = 'dragonfruit.slicing.blurBrushKernel';
const SLICING_BLUR_BRUSH_SIGMA_X_STORAGE_KEY = 'dragonfruit.slicing.blurBrushSigmaX';
const SLICING_BLUR_BRUSH_SIGMA_Y_STORAGE_KEY = 'dragonfruit.slicing.blurBrushSigmaY';
const SLICING_BLUR_BRUSH_SIGMA_STORAGE_KEY = 'dragonfruit.slicing.blurBrushSigma';
const SLICING_Z_BLUR_KERNEL_STORAGE_KEY = 'dragonfruit.slicing.zBlurKernel';
const SLICING_Z_BLUR_SIGMA_STORAGE_KEY = 'dragonfruit.slicing.zBlurSigma';
const NEW_CURVE_EDITING_TARGET = '__dragonfruit_new_curve__';
const SLICING_AA_QUALITY_MODE_STORAGE_KEY = 'dragonfruit.slicing.aaQualityMode';
const SLICING_AA_AUTO_PRESET_STORAGE_KEY = 'dragonfruit.slicing.aaAutoPreset';
const SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY = 'dragonfruit.slicing.sessionAaOverrideByMaterial.v1';
const SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY = 'dragonfruit.slicing.remoteOfflineLayerHeightMm';
const REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT = 'dragonfruit:slicing-remote-offline-layer-height-changed';
const SLICING_INTENT_BY_PRINTER_PROFILE_STORAGE_KEY = 'dragonfruit.slicing.intentByPrinterProfile.v1';
const REMOTE_OFFLINE_LAYER_HEIGHT_MIN_MM = 0.01;
const REMOTE_OFFLINE_LAYER_HEIGHT_MAX_MM = 1;
const REMOTE_OFFLINE_LAYER_HEIGHT_STEP_MM = 0.01;
const MICRONS_PER_MM = 1000;
const AA_STRENGTH_PRESETS = [4, 8, 16, 32] as const;
const AA_STRENGTH_MIN_STEPS = 2;
const AA_STRENGTH_MAX_STEPS = 64;
const BLUR_WIDTH_PRESETS = [1, 2, 4, 8] as const;
const BLUR_WIDTH_MIN_PX = 0; // 0 = XY blur disabled (engine skips blur code path)
const BLUR_WIDTH_MAX_PX = 64;
const Z_BLUR_RADIUS_PRESETS = [1, 2, 3] as const;
const Z_BLUR_RADIUS_MAX_LAYERS = 8; // engine radius cap; 0 = disabled
const LOOK_BACK_PRESETS = [2, 4, 6, 8] as const;
const LOOK_BACK_MIN_LAYERS = 1;
const LOOK_BACK_MAX_LAYERS = 16;
const FADE_DISTANCE_MIN_PX = 1;
const FADE_DISTANCE_MAX_PX = 256;

function isPresetValue(presets: readonly number[], value: number): boolean {
  return presets.some((preset) => preset === value);
}

function deriveFadeDistancePresets(basePx: number): number[] {
  const base = Math.max(
    FADE_DISTANCE_MIN_PX,
    Math.min(FADE_DISTANCE_MAX_PX, Math.round(basePx)),
  );
  // Logical scaling: keep fade tied to Blend Window size so users don't have
  // to mentally retune two disconnected knobs.
  const candidates = [base, base * 2, base * 3, base * 4]
    .map((px) => Math.max(FADE_DISTANCE_MIN_PX, Math.min(FADE_DISTANCE_MAX_PX, px)));
  return Array.from(new Set(candidates));
}

function materialProfileToDraft(profile: MaterialProfile): MaterialDraft {
  const { id: _id, printerProfileId: _printerProfileId, ...draft } = profile;
  return {
    ...draft,
    antiAliasingSettings: {
      ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
      ...(profile.antiAliasingSettings ?? {}),
    },
  };
}

type StoredSessionAaOverride = {
  minimumAaAlphaPercent?: number;
  antiAliasingSettings?: unknown;
};

function readSessionAaOverrideDraft(profile: MaterialProfile): MaterialDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const entry = (parsed as Record<string, StoredSessionAaOverride>)[profile.id];
    if (!entry || typeof entry !== 'object') return null;
    const minimumAaAlphaPercent = Number(entry.minimumAaAlphaPercent);
    return {
      ...materialProfileToDraft(profile),
      minimumAaAlphaPercent: Number.isFinite(minimumAaAlphaPercent)
        ? Math.max(0, Math.min(100, Math.round(minimumAaAlphaPercent)))
        : profile.minimumAaAlphaPercent,
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        ...(profile.antiAliasingSettings ?? {}),
        ...(entry.antiAliasingSettings && typeof entry.antiAliasingSettings === 'object' ? entry.antiAliasingSettings : {}),
      },
    };
  } catch {
    return null;
  }
}

function writeSessionAaOverrideDraft(materialId: string, draft: MaterialDraft): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const next = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, StoredSessionAaOverride>) }
      : {};
    next[materialId] = {
      minimumAaAlphaPercent: draft.minimumAaAlphaPercent,
      antiAliasingSettings: draft.antiAliasingSettings,
    };
    window.sessionStorage.setItem(SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage failures; the in-memory override still works.
  }
}

function clearSessionAaOverrideDraft(materialId: string): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.sessionStorage.getItem(SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const next = { ...(parsed as Record<string, StoredSessionAaOverride>) };
    delete next[materialId];
    if (Object.keys(next).length === 0) {
      window.sessionStorage.removeItem(SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(SLICING_SESSION_AA_OVERRIDE_STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // ignore storage failures
  }
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
  onToggle,
  isOpen,
}: {
  label: string;
  help: string;
  /** When provided, the label row becomes a collapse toggle. Adds a chevron inline — no extra height. */
  onToggle?: () => void;
  isOpen?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      className={`flex items-center gap-1 text-xs${onToggle ? ' cursor-pointer select-none' : ''}`}
      style={{ color: 'var(--text-muted)' }}
      onClick={onToggle}
      role={onToggle ? 'button' : undefined}
      tabIndex={onToggle ? 0 : undefined}
      onKeyDown={onToggle ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } } : undefined}
    >
      <span className="flex-1">{label}</span>
      {onToggle && (
        <span className="inline-flex items-center opacity-50" aria-hidden="true">
          <ChevronDown className={`h-3 w-3 transition-transform duration-150 ${isOpen ? '' : '-rotate-90'}`} />
        </span>
      )}
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
        onClick={(e) => e.stopPropagation()}
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
      if (value === 'file' || value === 'upload' || value === 'print' || value === 'preview' || value === 'uvtools') {
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
type BlurKernelMode = 'box' | 'gaussian';

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

function resolveInitialBlurKernel(storageKey: string, fallback: BlurKernelMode): BlurKernelMode {
  if (typeof window === 'undefined') return fallback;

  const stored = window.localStorage.getItem(storageKey)
    ?? window.sessionStorage.getItem(storageKey);
  return stored === 'gaussian' ? 'gaussian' : 'box';
}

function clampBlurSigma(value: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0.05, Math.min(16, Math.round(numeric * 100) / 100));
}

function resolveInitialBlurSigma(storageKey: string, fallback: number, legacyStorageKey?: string): number {
  if (typeof window === 'undefined') return fallback;

  const stored = window.localStorage.getItem(storageKey)
    ?? window.sessionStorage.getItem(storageKey);
  if (stored != null && stored.trim().length > 0) {
    const parsed = Number(stored);
    if (Number.isFinite(parsed)) {
      return clampBlurSigma(parsed, fallback);
    }
  }

  if (legacyStorageKey) {
    const legacyStored = window.localStorage.getItem(legacyStorageKey)
      ?? window.sessionStorage.getItem(legacyStorageKey);
    if (legacyStored != null && legacyStored.trim().length > 0) {
      const parsed = Number(legacyStored);
      if (Number.isFinite(parsed)) {
        return clampBlurSigma(parsed, fallback);
      }
    }
  }

  return fallback;
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

function resolveInitialZBlurRadiusLayers(): number {
  if (typeof window === 'undefined') return 1;

  const stored = window.localStorage.getItem(SLICING_Z_BLUR_RADIUS_LAYERS_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_Z_BLUR_RADIUS_LAYERS_STORAGE_KEY);
  if (stored == null || stored.trim().length === 0) return 1;

  const parsed = Number(stored);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, Math.min(Z_BLUR_RADIUS_MAX_LAYERS, Math.round(parsed)));
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

function resolveInitialBlurGraySourceMode(): BlurGraySourceMode {
  if (typeof window === 'undefined') return 'lut';

  const stored = window.localStorage.getItem(SLICING_BLUR_GRAY_SOURCE_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_BLUR_GRAY_SOURCE_STORAGE_KEY);
  return stored === 'minimum' ? 'minimum' : 'lut';
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
  if (typeof window === 'undefined') return 8;
  const stored = window.localStorage.getItem(SLICING_3DAA_FADE_PX_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_3DAA_FADE_PX_STORAGE_KEY);
  if (stored == null || stored.trim().length === 0) return 8;
  const parsed = Math.round(Number(stored));
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(FADE_DISTANCE_MIN_PX, Math.min(FADE_DISTANCE_MAX_PX, parsed));
}

function resolveInitialZBlendFadeMode(): 'auto' | 'manual' {
  if (typeof window === 'undefined') return 'auto';
  const stored = window.localStorage.getItem(SLICING_3DAA_FADE_MODE_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_3DAA_FADE_MODE_STORAGE_KEY);
  return stored === 'manual' ? 'manual' : 'auto';
}

function resolveInitialZBlendAutoMode(): boolean {
  if (typeof window === 'undefined') return true;
  const stored = window.localStorage.getItem(SLICING_3DAA_AUTO_MODE_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_3DAA_AUTO_MODE_STORAGE_KEY);
  // Default to true (Auto / slope-adaptive) unless user explicitly selected Expert.
  return stored !== 'false';
}

function resolveInitialZaaPattern(): ZaaPattern {
  if (typeof window === 'undefined') return 'halton';
  const stored = window.localStorage.getItem(SLICING_ZAA_PATTERN_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_ZAA_PATTERN_STORAGE_KEY);
  if (stored === 'uniform' || stored === 'halton' || stored === 'base2') return stored;
  return 'halton'; // Default changed from 'uniform' to 'halton' (lower-discrepancy)
}

function resolveInitialZaaDuplicateZ(): boolean {
  if (typeof window === 'undefined') return false;
  const stored = window.localStorage.getItem(SLICING_ZAA_DUPLICATE_Z_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_ZAA_DUPLICATE_Z_STORAGE_KEY);
  return stored === 'true';
}

/** Max-alpha (%) for the cure-window LUT keyed by material transparency. */
const Z_BLEND_MAX_ALPHA_BY_RESIN = {
  opaque: 90,
  clear: 65,
} as const;

function resolveInitialZBlendResinType(): 'opaque' | 'clear' | 'custom' {
  if (typeof window === 'undefined') return 'opaque';
  const stored = window.localStorage.getItem(SLICING_3DAA_RESIN_TYPE_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_3DAA_RESIN_TYPE_STORAGE_KEY);
  return stored === 'clear' ? 'clear' : stored === 'custom' ? 'custom' : 'opaque';
}

function resolveInitialSavedCurves(): SavedCurve[] {
  if (typeof window === 'undefined') return DEFAULT_SAVED_CURVES;
  try {
    const raw =
      window.sessionStorage.getItem(SLICING_3DAA_SAVED_CURVES_STORAGE_KEY)
      ?? window.localStorage.getItem(SLICING_3DAA_SAVED_CURVES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedCurve[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  return DEFAULT_SAVED_CURVES;
}

function resolveInitialSelectedCurveId(curves: SavedCurve[]): string {
  if (typeof window === 'undefined') return curves[0].id;
  const stored =
    window.sessionStorage.getItem(SLICING_3DAA_SELECTED_CURVE_STORAGE_KEY)
    ?? window.localStorage.getItem(SLICING_3DAA_SELECTED_CURVE_STORAGE_KEY);
  if (stored && curves.some((c) => c.id === stored)) return stored;
  return curves[0].id;
}

function resolveInitialAaQualityMode(): 'auto' | 'expert' {
  if (typeof window === 'undefined') return 'auto';
  const stored = window.localStorage.getItem(SLICING_AA_QUALITY_MODE_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_AA_QUALITY_MODE_STORAGE_KEY);
  return stored === 'advanced' || stored === 'expert' ? 'expert' : 'auto';
}

type AaAutoUiPreset = 'raw' | AaAutoPreset;

type AutoAaResolvedConfig = {
  aaMode: 'Off' | 'Blur' | '3DAA';
  antiAliasingMode: 'Coverage' | 'Blur' | 'Vertical2';
  aaSteps: number;
  blurBrushRadiusPx: number;
  zBlurRadiusLayers: number;
  zBlendLookBack: number;
};

const DEFAULT_AUTO_Z_BLEND_LOOK_BACK = 2;

const PENDING_AUTO_AA_CONFIG: AutoAaResolvedConfig = {
  aaMode: 'Blur',
  antiAliasingMode: 'Blur',
  aaSteps: 4,
  blurBrushRadiusPx: 1,
  zBlurRadiusLayers: 0,
  zBlendLookBack: DEFAULT_AUTO_Z_BLEND_LOOK_BACK,
};

const DEFAULT_AUTO_AA_CONFIG: AutoAaResolvedConfig = {
  aaMode: 'Blur',
  antiAliasingMode: 'Blur',
  aaSteps: 4,
  blurBrushRadiusPx: 1,
  zBlurRadiusLayers: 0,
  zBlendLookBack: DEFAULT_AUTO_Z_BLEND_LOOK_BACK,
};

function resolveInitialAaAutoPreset(): AaAutoUiPreset {
  if (typeof window === 'undefined') return 'balanced';
  const stored = window.localStorage.getItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY)
    ?? window.sessionStorage.getItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY);
  if (stored === 'raw') return 'raw';
  if (stored === 'sharp' || stored === 'smooth') return stored;
  return 'balanced';
}

const AUTO_AA_PRESET_OPTIONS: ReadonlyArray<{
  preset: AaAutoUiPreset;
  label: string;
  desc: string;
}> = [
  { preset: 'raw', label: 'Disabled', desc: 'Raw masks only.' },
  { preset: 'sharp', label: 'Sharp', desc: 'Crisp text and details.' },
  { preset: 'balanced', label: 'Balanced', desc: 'Printer-aware smoothing.' },
  { preset: 'smooth', label: 'Smooth', desc: 'Soft organic curves.' },
];

// AaAutoPreset is imported from autoAaPhysics.ts

export function SlicingPanel({
  models,
  activeModel,
  estimatedLayerCountOverride,
  estimatedLayerHeightMmOverride,
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
  const [isExpanded, setIsExpanded] = useFloatingPanelCollapse(true);
  const [sliceIntent, setSliceIntent] = useState<SliceIntent>(() => {
    const id = (getActivePrinterProfile(getProfileStoreSnapshot())?.id ?? '').trim();
    if (!id) return 'file';
    const remembered = readSliceIntentByPrinterProfile()[id];
    if (remembered === 'file' || remembered === 'upload' || remembered === 'print' || remembered === 'preview' || remembered === 'uvtools') return remembered;
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
  const [showAaWarningModal, setShowAaWarningModal] = useState(false);
  const [pendingAaTarget, setPendingAaTarget] = useState<'Off' | 'Blur' | '3DAA' | null>(null);
  const [aaWarningModelName, setAaWarningModelName] = useState('');
  const [aaLevel, setAaLevel] = useState<AaStrengthLevel>(resolveInitialAaLevel);
  const [useCustomAaLevel, setUseCustomAaLevel] = useState<boolean>(() => {
    const initialSteps = parseAaLevelSteps(resolveInitialAaLevel()) ?? 4;
    return resolveInitialCustomOptionEnabled(
      SLICING_AA_LEVEL_CUSTOM_ENABLED_STORAGE_KEY,
      !isPresetValue(AA_STRENGTH_PRESETS, initialSteps),
    );
  });
  const [blurBrushRadiusPx, setBlurBrushRadiusPx] = useState<number>(resolveInitialBlurBrushRadiusPx);
  const [blurBrushKernel, setBlurBrushKernel] = useState<BlurKernelMode>(() => resolveInitialBlurKernel(
    SLICING_BLUR_BRUSH_KERNEL_STORAGE_KEY,
    'gaussian',
  ));
  const [blurBrushSigmaX, setBlurBrushSigmaX] = useState<number>(() => resolveInitialBlurSigma(
    SLICING_BLUR_BRUSH_SIGMA_X_STORAGE_KEY,
    0.5,
    SLICING_BLUR_BRUSH_SIGMA_STORAGE_KEY,
  ));
  const [blurBrushSigmaY, setBlurBrushSigmaY] = useState<number>(() => resolveInitialBlurSigma(
    SLICING_BLUR_BRUSH_SIGMA_Y_STORAGE_KEY,
    0.5,
    SLICING_BLUR_BRUSH_SIGMA_STORAGE_KEY,
  ));
  const [zBlurRadiusLayers, setZBlurRadiusLayers] = useState<number>(resolveInitialZBlurRadiusLayers);
  const [zBlurKernel, setZBlurKernel] = useState<BlurKernelMode>(() => resolveInitialBlurKernel(
    SLICING_Z_BLUR_KERNEL_STORAGE_KEY,
    'box',
  ));
  const [zBlurSigma, setZBlurSigma] = useState<number>(() => resolveInitialBlurSigma(
    SLICING_Z_BLUR_SIGMA_STORAGE_KEY,
    0.5,
  ));
  const [useCustomBlurBrushRadius, setUseCustomBlurBrushRadius] = useState<boolean>(() => {
    const initial = resolveInitialBlurBrushRadiusPx();
    return resolveInitialCustomOptionEnabled(
      SLICING_BLUR_BRUSH_CUSTOM_ENABLED_STORAGE_KEY,
      !isPresetValue(BLUR_WIDTH_PRESETS, initial),
    );
  });
  const [useCustomZBlurRadius, setUseCustomZBlurRadius] = useState<boolean>(() => {
    const initial = resolveInitialZBlurRadiusLayers();
    return resolveInitialCustomOptionEnabled(
      SLICING_Z_BLUR_RADIUS_CUSTOM_ENABLED_STORAGE_KEY,
      !isPresetValue(Z_BLUR_RADIUS_PRESETS, initial),
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
  const [zBlendFadeMode, setZBlendFadeMode] = useState<'auto' | 'manual'>(resolveInitialZBlendFadeMode);
  const [zBlendAutoMode, setZBlendAutoMode] = useState<boolean>(resolveInitialZBlendAutoMode);
  const [zaaPattern, setZaaPattern] = useState<ZaaPattern>(resolveInitialZaaPattern);
  const [zaaDuplicateZ, setZaaDuplicateZ] = useState<boolean>(resolveInitialZaaDuplicateZ);
  // Rollup / collapse state — transient (not persisted to localStorage)
  const [showMoreZaaOptions, setShowMoreZaaOptions] = useState(false);   // item 4: "More" rollup for Pattern + DupZ
  const [showXyBlurSection, setShowXyBlurSection] = useState(true);      // item 6
  const [showZBlurSection, setShowZBlurSection] = useState(true);        // item 6
  const [showGrayscaleSection, setShowGrayscaleSection] = useState(true); // item 6
  const [showAaOnSupports, setShowAaOnSupports] = useState(false);       // item 7: default closed
  const [aaQualityMode, setAaQualityMode] = useState<'auto' | 'expert'>(resolveInitialAaQualityMode);
  const [aaAutoPreset, setAaAutoPreset] = useState<AaAutoUiPreset>(resolveInitialAaAutoPreset);
  const [autoAaConfig, setAutoAaConfig] = useState<AutoAaResolvedConfig>(DEFAULT_AUTO_AA_CONFIG);
  const [autoZBlendLookBack, setAutoZBlendLookBack] = useState<number>(DEFAULT_AUTO_Z_BLEND_LOOK_BACK);
  const [isAutoAaCalculating, setIsAutoAaCalculating] = useState(false);
  const [materialAaEditorDraft, setMaterialAaEditorDraft] = useState<MaterialDraft | null>(null);
  const [isMaterialAaEditorOpen, setIsMaterialAaEditorOpen] = useState(false);
  const [sessionAaOverrideDraft, setSessionAaOverrideDraft] = useState<MaterialDraft | null>(null);
  const [editingSessionAaOverrideDraft, setEditingSessionAaOverrideDraft] = useState<MaterialDraft | null>(null);
  const [isSessionAaOverrideOpen, setIsSessionAaOverrideOpen] = useState(false);
  const [zBlendResinType, setZBlendResinType] = useState<'opaque' | 'clear' | 'custom'>(resolveInitialZBlendResinType);
  const [savedCurves, setSavedCurves] = useState<SavedCurve[]>(() => resolveInitialSavedCurves());
  const [selectedCurveId, setSelectedCurveId] = useState<string>(() => resolveInitialSelectedCurveId(resolveInitialSavedCurves()));
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
  const [useCustomZBlendFadePx, setUseCustomZBlendFadePx] = useState<boolean>(() => {
    const initial = resolveInitialZBlendFadePx();
    const initialLookBack = resolveInitialZBlendLookBack();
    const initialPresets = deriveFadeDistancePresets(Math.max(2, initialLookBack * 2));
    return resolveInitialCustomOptionEnabled(
      SLICING_3DAA_FADE_PX_CUSTOM_ENABLED_STORAGE_KEY,
      !isPresetValue(initialPresets, initial),
    );
  });
  const [minimumAaAlphaPercent, setMinimumAaAlphaPercent] = useState<number>(resolveInitialMinimumAaAlphaPercent);
  const [enableMinimumAaAlphaOverride, setEnableMinimumAaAlphaOverride] = useState<boolean>(resolveInitialMinimumAaAlphaOverrideEnabled);
  const [blurGraySourceMode, setBlurGraySourceMode] = useState<BlurGraySourceMode>(resolveInitialBlurGraySourceMode);
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
  useEffect(() => {
    setSessionAaOverrideDraft(activeMaterialProfile ? readSessionAaOverrideDraft(activeMaterialProfile) : null);
    setEditingSessionAaOverrideDraft(null);
    setIsSessionAaOverrideOpen(false);
    setMaterialAaEditorDraft(null);
    setIsMaterialAaEditorOpen(false);
  }, [activeMaterialProfile?.id]);
  const profileAntiAliasingSettings = useMemo(() => ({
    ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
    ...(activeMaterialProfile?.antiAliasingSettings ?? {}),
    ...(sessionAaOverrideDraft?.antiAliasingSettings ?? {}),
  }), [activeMaterialProfile?.antiAliasingSettings, sessionAaOverrideDraft?.antiAliasingSettings]);
  const aaOnSupportsEnabled = profileAntiAliasingSettings.enableOverride === true
    ? profileAntiAliasingSettings.aaOnSupports
    : getSavedSlicingPerformanceSettings().aaOnSupportsExperimental === true;
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

  const autoDetectedResinType = useMemo<'opaque' | 'clear'>(() => {
    const name = effectiveMaterialProfile?.name ?? '';
    return /\bclear\b/i.test(name) ? 'clear' : 'opaque';
  }, [effectiveMaterialProfile?.name]);

  useEffect(() => {
    setZBlendResinType((current) => {
      if (aaMode === '3DAA') {
        if (aaQualityMode === 'auto') {
          return autoDetectedResinType;
        }
        return current === 'custom' ? 'custom' : autoDetectedResinType;
      }
      if (aaMode === 'Blur' && blurGraySourceMode === 'lut') {
        return current === 'custom' ? 'custom' : autoDetectedResinType;
      }
      return current;
    });
  }, [aaMode, aaQualityMode, autoDetectedResinType, blurGraySourceMode]);

  const autoLutCurveLabel = autoDetectedResinType === 'clear' ? 'Clear' : 'Opaque';

  const sessionAaOverrideEnabled = sessionAaOverrideDraft?.antiAliasingSettings?.enableOverride === true;
  const materialProfileAaOverrideEnabled = activeMaterialProfile?.antiAliasingSettings?.enableOverride === true;
  const aaOverrideNoticeLabel = sessionAaOverrideEnabled
    ? 'Session Override active'
    : materialProfileAaOverrideEnabled
      ? 'Using Material Settings'
      : null;
  const handleOpenMaterialAaEditor = useCallback(() => {
    if (!activeMaterialProfile) return;
    setMaterialAaEditorDraft(materialProfileToDraft(activeMaterialProfile));
    setIsMaterialAaEditorOpen(true);
  }, [activeMaterialProfile]);

  const handleSaveMaterialAaEditor = useCallback(() => {
    if (!activeMaterialProfile || !materialAaEditorDraft) return;
    updateMaterialProfile(activeMaterialProfile.id, {
      minimumAaAlphaPercent: materialAaEditorDraft.minimumAaAlphaPercent,
      antiAliasingSettings: materialAaEditorDraft.antiAliasingSettings,
    });
    setIsMaterialAaEditorOpen(false);
  }, [activeMaterialProfile, materialAaEditorDraft]);

  const handleOpenSessionAaOverride = useCallback(() => {
    if (!activeMaterialProfile) return;
    const baseDraft = sessionAaOverrideDraft ?? materialProfileToDraft(activeMaterialProfile);
    setEditingSessionAaOverrideDraft({
      ...baseDraft,
      antiAliasingSettings: {
        ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
        ...(baseDraft.antiAliasingSettings ?? {}),
        enableCustomSettings: true,
        enableOverride: true,
      },
    });
    setIsSessionAaOverrideOpen(true);
  }, [activeMaterialProfile, sessionAaOverrideDraft]);

  const opaqueDefaultLut = useMemo(
    () => sampleCurveToLut(DEFAULT_OPAQUE_EXP_120_230_CURVE),
    [],
  );

  const clearDefaultLut = useMemo(
    () => sampleCurveToLut(DEFAULT_CLEAR_EXP_100_CURVE),
    [],
  );

  useEffect(() => {
    if (savedCurves.length === 0) {
      const fallback: SavedCurve = {
        ...DEFAULT_SAVED_CURVES[0],
        id: crypto.randomUUID(),
        points: [...DEFAULT_CUSTOM_CURVE],
      };
      setSavedCurves([fallback]);
      setSelectedCurveId(fallback.id);
      return;
    }

    if (!savedCurves.some((curve) => curve.id === selectedCurveId)) {
      setSelectedCurveId(savedCurves[0].id);
    }

    if (
      editingTarget
      && editingTarget !== NEW_CURVE_EDITING_TARGET
      && !savedCurves.some((curve) => curve.id === editingTarget)
    ) {
      setEditingTarget(null);
    }
  }, [editingTarget, savedCurves, selectedCurveId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_3DAA_RESIN_TYPE_STORAGE_KEY, zBlendResinType);
    window.sessionStorage.setItem(SLICING_3DAA_RESIN_TYPE_STORAGE_KEY, zBlendResinType);
  }, [zBlendResinType]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const json = JSON.stringify(savedCurves);
    window.localStorage.setItem(SLICING_3DAA_SAVED_CURVES_STORAGE_KEY, json);
    window.sessionStorage.setItem(SLICING_3DAA_SAVED_CURVES_STORAGE_KEY, json);
  }, [savedCurves]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_3DAA_SELECTED_CURVE_STORAGE_KEY, selectedCurveId);
    window.sessionStorage.setItem(SLICING_3DAA_SELECTED_CURVE_STORAGE_KEY, selectedCurveId);
  }, [selectedCurveId]);

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
  const printerDitherBitDepth = useMemo<number | null>(() => {
    const printerBitDepth = Number(activePrinterProfile?.bitDepth?.bits);
    if (!Number.isFinite(printerBitDepth) || printerBitDepth <= 0) {
      return null;
    }
    // 8-bit (or higher) displays don't need dithering — return null so the
    // auto-dither gate below stays disabled.
    if (Math.round(printerBitDepth) >= 8) return null;
    return Math.max(2, Math.min(7, Math.round(printerBitDepth)));
  }, [activePrinterProfile?.bitDepth?.bits]);
  const autoDitherRequiredForPrinter = printerDitherBitDepth != null && printerDitherBitDepth !== 8;
  const effectiveDitherEnabledForSlice = autoDitherRequiredForPrinter
    ? true
    : profileAntiAliasingSettings.ditherEnabled;
  const effectiveDitherBitDepthForSlice = printerDitherBitDepth
    ?? Math.max(2, Math.min(7, Math.round(profileAntiAliasingSettings.ditherBitDepth ?? 3)));
  const effectiveDitherDeviceGammaForSlice = Math.max(
    0.5,
    Math.min(4.0, Number(profileAntiAliasingSettings.ditherDeviceGamma ?? 3.0)),
  );

  const isRemoteMaterialSyncConnected = Boolean(networkUiAdapter) && !isRemoteNetworkUnavailable;
  const showRemoteOfflineLayerHeightOverride = Boolean(networkUiAdapter)
    && isRemoteNetworkUnavailable
    && networkUiAdapter?.supportsRemoteMaterialProfiles !== false;
  const remoteMaterialHost = (activePrinterProfile?.networkConnection?.ipAddress
    || activePrinterProfile?.network?.ipAddress
    || '').trim();

  const progressPercent = useMemo(() => {
    const total = Math.max(1, progressTotal);
    return Math.max(0, Math.min(100, (progressDone / total) * 100));
  }, [progressDone, progressTotal]);
  const progressPercentLabel = useMemo(() => {
    const rounded = Math.round(displayProgressPercent);
    if (slicingModalStage === 'running' && progressDone < progressTotal) {
      return Math.min(99, rounded);
    }
    return Math.max(0, Math.min(100, rounded));
  }, [displayProgressPercent, progressDone, progressTotal, slicingModalStage]);

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

  // When the user enables AA on an STL whose support geometry analysis didn't
  // produce a model/support split, warn that we can't disable AA for possible
  // support geometry.
  const handleAaModeChange = useCallback((mode: 'Off' | 'Blur' | '3DAA') => {
    if (mode === 'Off') {
      setAaMode('Off');
      return;
    }

    // Check visible models for STL files with unclassified support geometry.
    const stlWithoutSupportSplit = models.filter((m) => {
      if (!m.visible) return false;
      if (!m.name.toLowerCase().endsWith('.stl')) return false;
      const report = m.geometry.meshDefects?.nativeRepairReport;
      if (!report) return true; // No analysis report at all
      const hasSplit = report.model_triangle_count != null && report.model_triangle_count > 0;
      const isSupportGeometry = report.likely_support_geometry === true;
      return !hasSplit && !isSupportGeometry;
    });

    if (stlWithoutSupportSplit.length > 0) {
      setAaWarningModelName(stlWithoutSupportSplit[0].name);
      setPendingAaTarget(mode);
      setShowAaWarningModal(true);
    } else {
      setAaMode(mode);
    }
  }, [models]);

  const handleAaWarningProceed = useCallback(() => {
    if (pendingAaTarget) {
      setAaMode(pendingAaTarget);
    }
    setShowAaWarningModal(false);
    setPendingAaTarget(null);
  }, [pendingAaTarget]);

  const handleAaWarningCancel = useCallback(() => {
    setShowAaWarningModal(false);
    setPendingAaTarget(null);
  }, []);

  const visibleModels = useMemo(() => models.filter((model) => model.visible), [models]);
  const activePrinterProfileId = (activePrinterProfile?.id ?? '').trim();
  const isShiftHeld = useKeyPressed('shift');

  const uvToolsSettings = useMemo(() => getSavedUvToolsSettings(), []);
  const canUvTools = uvToolsSettings.enabled;

  const effectiveSliceIntent = useMemo<SliceIntent>(() => {
    if (isShiftHeld) return 'preview';
    if (sliceIntent === 'upload' && !canUpload) return 'file';
    if (sliceIntent === 'print' && !canPrint) return 'file';
    if (sliceIntent === 'uvtools' && !canUvTools) return 'file';
    return sliceIntent;
  }, [canPrint, canUpload, canUvTools, isShiftHeld, sliceIntent]);
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
    if (remembered === 'file' || remembered === 'upload' || remembered === 'print' || remembered === 'uvtools') {
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
    if (showRemoteOfflineLayerHeightOverride) {
      return {
        ...effectiveMaterialProfile,
        layerHeightMm: effectiveLayerHeightMm ?? clampRemoteOfflineLayerHeightMm(activeMaterialProfile?.layerHeightMm ?? 0.05),
      };
    }
    return {
      ...effectiveMaterialProfile,
      layerHeightMm: clampLayerHeightMm(effectiveMaterialProfile.layerHeightMm, 0.05),
    };
  }, [activeMaterialProfile?.layerHeightMm, effectiveLayerHeightMm, effectiveMaterialProfile, showRemoteOfflineLayerHeightOverride]);

  const estimatedLayerCount = useMemo(() => {
    const overrideLayerHeightMm = Number(estimatedLayerHeightMmOverride);
    const canTrustOverride = Number.isFinite(estimatedLayerCountOverride)
      && Number(estimatedLayerCountOverride) > 0
      && effectiveLayerHeightMm != null
      && Number.isFinite(overrideLayerHeightMm)
      && Math.abs(overrideLayerHeightMm - effectiveLayerHeightMm) <= 0.0005;

    if (canTrustOverride) {
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
  }, [effectiveLayerHeightMm, estimatedLayerCountOverride, estimatedLayerHeightMmOverride, visibleModels]);

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

  // Shared pixel pitch calculation used by both autoZBlendFadePx and autoAaConfig.
  // Prefers the explicit pixelSize field (µm, stored directly from the manufacturer
  // spec) when available — avoids floating-point rounding introduced by deriving
  // pitch from buildVolumeMm which is stored at only 3 decimal places.
  const pixelPitchMm = useMemo(() => {
    // Direct pixel size path (most accurate)
    const pxSizeX = Number(activePrinterProfile?.pixelSize?.x);
    const pxSizeY = Number(activePrinterProfile?.pixelSize?.y);
    if (Number.isFinite(pxSizeX) && Number.isFinite(pxSizeY) && pxSizeX > 0 && pxSizeY > 0) {
      return {
        x: pxSizeX / 1000,
        y: pxSizeY / 1000,
      }; // µm → mm
    }

    // Fallback: derive from build volume ÷ resolution
    const resX = Number(activePrinterProfile?.display?.resolutionX);
    const resY = Number(activePrinterProfile?.display?.resolutionY);
    const buildW = Number(activePrinterProfile?.buildVolumeMm?.width);
    const buildD = Number(activePrinterProfile?.buildVolumeMm?.depth);

    let pitchX: number | null = null;
    let pitchY: number | null = null;
    if (Number.isFinite(resX) && Number.isFinite(buildW) && resX > 0 && buildW > 0) {
      pitchX = buildW / resX;
    }
    if (Number.isFinite(resY) && Number.isFinite(buildD) && resY > 0 && buildD > 0) {
      pitchY = buildD / resY;
    }
    return {
      x: pitchX ?? pitchY ?? 0.05,
      y: pitchY ?? pitchX ?? 0.05,
    };
  }, [
    activePrinterProfile?.pixelSize?.x,
    activePrinterProfile?.pixelSize?.y,
    activePrinterProfile?.buildVolumeMm?.depth,
    activePrinterProfile?.buildVolumeMm?.width,
    activePrinterProfile?.display?.resolutionX,
    activePrinterProfile?.display?.resolutionY,
  ]);

  // Auto AA config: physics-grounded parameters from pixel pitch + layer height.
  // Computed asynchronously so Export-page transition can paint first, with
  // a visible pending state in the AA panel.
  useEffect(() => {
    let cancelled = false;
    setIsAutoAaCalculating(true);

    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;

      const layerHeightMm = Number(effectiveLayerHeightMm);
      const safeLayerH = Number.isFinite(layerHeightMm) && layerHeightMm > 0 ? layerHeightMm : 0.05;

      const nextAutoAaConfig: AutoAaResolvedConfig = aaAutoPreset === 'raw'
        ? {
            aaMode: 'Off',
            antiAliasingMode: 'Coverage',
            aaSteps: 0,
            blurBrushRadiusPx: 0,
            zBlurRadiusLayers: 0,
            zBlendLookBack: 0,
          }
        : computePhysicalAaConfig(aaAutoPreset, pixelPitchMm.x, safeLayerH, pixelPitchMm.y);

      const nextAutoZBlendLookBack = computePhysicalAaConfig('balanced', pixelPitchMm.x, safeLayerH, pixelPitchMm.y).zBlendLookBack;

      if (cancelled) return;
      setAutoAaConfig(nextAutoAaConfig);
      setAutoZBlendLookBack(nextAutoZBlendLookBack);
      setIsAutoAaCalculating(false);
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [aaAutoPreset, effectiveLayerHeightMm, pixelPitchMm]);

  const effectiveAutoAaConfig = isAutoAaCalculating ? PENDING_AUTO_AA_CONFIG : autoAaConfig;
  const effectiveAutoZBlendLookBack = isAutoAaCalculating
    ? DEFAULT_AUTO_Z_BLEND_LOOK_BACK
    : autoZBlendLookBack;

  const autoLookBackForFade = (aaQualityMode === 'auto' && antiAliasingAvailable)
    ? effectiveAutoAaConfig.zBlendLookBack
    : effectiveAutoZBlendLookBack;

  const autoZBlendFadePx = useMemo(() => {
    const lookBack = Math.max(
      LOOK_BACK_MIN_LAYERS,
      Math.min(LOOK_BACK_MAX_LAYERS, Math.round(autoLookBackForFade)),
    );

    const layerHeightMm = Number(effectiveLayerHeightMm);
    const safeLayerHeightMm = Number.isFinite(layerHeightMm) && layerHeightMm > 0 ? layerHeightMm : 0.05;

    const pxPerLayer = safeLayerHeightMm / Math.max(pixelPitchMm.x, 1e-6);
    // Mirror the Rust engine formula (types.rs `effective_z_blend_fade_px`):
    //   fade_per_layer = ceil(layer_height_px / tan(20°)) = ceil(layer_height_px × 2.747)
    //   total = fade_per_layer × look_back, clamped to [1, 256]
    // This ensures the displayed auto value matches what the engine actually uses.
    const fadePerLayer = Math.ceil(pxPerLayer * 2.747);
    const base = Math.max(1, fadePerLayer * lookBack);
    return Math.max(FADE_DISTANCE_MIN_PX, Math.min(FADE_DISTANCE_MAX_PX, base));
  }, [
    autoLookBackForFade,
    effectiveLayerHeightMm,
    pixelPitchMm,
  ]);

  const fadeDistancePresets = useMemo(
    () => deriveFadeDistancePresets(autoZBlendFadePx),
    [autoZBlendFadePx],
  );

  const materialAaOverrideEnabled = profileAntiAliasingSettings.enableOverride === true;
  useEffect(() => {
    if (!materialAaOverrideEnabled) return;
    setAaQualityMode('expert');
  }, [materialAaOverrideEnabled]);

  const profileAaMode = materialAaOverrideEnabled
    ? profileAntiAliasingSettings.mode
    : effectiveAutoAaConfig.aaMode;
  const profileAaLevel = materialAaOverrideEnabled
    ? formatAaLevel(parseAaLevelSteps(profileAntiAliasingSettings.level) ?? 4)
    : (effectiveAutoAaConfig.aaMode === 'Off' ? 'Off' as const : formatAaLevel(effectiveAutoAaConfig.aaSteps || 4));

  const useAutoFadeDistance = profileAaMode === '3DAA';

  const effectiveZBlendFadePx = useAutoFadeDistance
    ? autoZBlendFadePx
    : profileAntiAliasingSettings.zBlendFadePx;

  // Resolved AA state: auto mode overrides manual state when AA is available.
  const resolvedAaMode = profileAaMode;
  const resolvedAaLevel = profileAaLevel;
  const resolvedBlurBrushRadiusPx = materialAaOverrideEnabled
    ? profileAntiAliasingSettings.blurBrushRadiusPx
    : effectiveAutoAaConfig.blurBrushRadiusPx;
  const resolvedBlurBrushKernel: BlurKernelMode = materialAaOverrideEnabled && profileAntiAliasingSettings.useCustomBlurBrushRadius
    ? profileAntiAliasingSettings.blurBrushKernel
    : 'gaussian';
  const resolvedBlurBrushSigmaX = clampBlurSigma(profileAntiAliasingSettings.blurBrushSigmaX, 0.5);
  const resolvedBlurBrushSigmaY = clampBlurSigma(profileAntiAliasingSettings.blurBrushSigmaY, 0.5);
  const resolvedZBlurRadiusLayers = resolvedAaMode === '3DAA'
    ? (materialAaOverrideEnabled ? profileAntiAliasingSettings.zBlurRadiusLayers : effectiveAutoAaConfig.zBlurRadiusLayers)
    : 0;
  const resolvedZBlurKernel: BlurKernelMode = materialAaOverrideEnabled && profileAntiAliasingSettings.useCustomZBlurRadius
    ? profileAntiAliasingSettings.zBlurKernel
    : 'box';
  const resolvedZBlurSigma = clampBlurSigma(profileAntiAliasingSettings.zBlurSigma, 0.5);
  const resolvedZBlendLookBack = profileAaMode === '3DAA' ? effectiveAutoZBlendLookBack : 0;
  const resolvedZBlendFadeMode = useAutoFadeDistance ? 'auto' as const : 'manual' as const;

  const effectiveAntiAliasingLevel =
    !antiAliasingAvailable || resolvedAaMode === 'Off' ? 'Off' as const : resolvedAaLevel;
  const effectiveAntiAliasingMode: 'Blur' | '3DAA' | 'Vertical2' | 'Coverage' =
    !antiAliasingAvailable || resolvedAaMode === 'Off' ? 'Coverage' :
    resolvedAaMode === '3DAA' ? 'Vertical2' :
    'Blur';
  const shouldApply3daaSamplingOverrides = resolvedAaMode === '3DAA';
  const effectiveZaaKernel = resolvedAaMode === '3DAA'
    ? 'perturb' as const
    : undefined;
  const effectiveZaaPattern = shouldApply3daaSamplingOverrides
    ? profileAntiAliasingSettings.zaaPattern
    : undefined;
  const effectiveZaaDuplicateZ = shouldApply3daaSamplingOverrides
    ? profileAntiAliasingSettings.zaaDuplicateZ
    : undefined;
  const duplicateZSupportedAtCurrentAa = (parseAaLevelSteps(resolvedAaLevel) ?? 4) >= 16;
  const advancedSampleCountLabel = aaMode === '3DAA' ? '3DAA Sample Count' : 'XY Sample Count';
  const advancedSampleCountHelp = aaMode === '3DAA'
    ? 'Controls how many raster samples each layer uses before resolving the final grayscale. In 3DAA these samples are distributed through the layer height using perturbation, so higher values improve shallow slopes and edge stability but cost more slicing time.'
    : 'Controls supersampling for the layer-local XY edge-smoothing pass. Higher levels preserve finer edge detail but cost more slicing time.';
  const advancedBlurWidthLabel = 'XY Blur Radius';
  const advancedBlurWidthHelp = aaMode === '3DAA'
    ? 'Controls the final in-plane XY blur radius that softens perturbation output after sampling. Higher values smooth edges more, but can soften tiny features.'
    : 'Controls XY blur radius in pixels. Higher values create smoother transitions but can soften fine details.';
  const autoAaSummarySampleLabel = effectiveAutoAaConfig.aaMode === 'Off'
    ? 'No AA'
    : effectiveAutoAaConfig.antiAliasingMode === 'Blur'
      ? 'Binary Base'
    : effectiveAutoAaConfig.aaMode === '3DAA'
      ? `${effectiveAutoAaConfig.aaSteps}x ZAA Samples`
      : `${effectiveAutoAaConfig.aaSteps}x Coverage`;
  const autoAaSummaryBlurLabel = effectiveAutoAaConfig.aaMode === 'Off'
    ? 'No Edge Blur'
    : effectiveAutoAaConfig.antiAliasingMode === 'Coverage'
      ? 'No Edge Blur'
      : effectiveAutoAaConfig.aaMode === '3DAA'
        ? `${effectiveAutoAaConfig.blurBrushRadiusPx}px XY · ${effectiveAutoAaConfig.zBlurRadiusLayers}L Z`
        : `${effectiveAutoAaConfig.blurBrushRadiusPx}px Edge Blur`;
  const autoAaSummaryKernelLabel = effectiveAutoAaConfig.aaMode === '3DAA'
    ? '3DAA'
    : effectiveAutoAaConfig.antiAliasingMode === 'Coverage'
      ? 'Coverage'
      : '2D Blur';
  const autoAaSummaryGrayLabel = effectiveAutoAaConfig.aaMode === 'Off'
    ? 'No Gray Map'
    : `LUT: ${autoLutCurveLabel}`;
  const effectiveBlurGraySourceMode = materialAaOverrideEnabled
    ? profileAntiAliasingSettings.blurGraySourceMode
    : 'lut';
  const effectiveZBlendResinType = materialAaOverrideEnabled
    ? profileAntiAliasingSettings.zBlendResinType
    : autoDetectedResinType;
  const effectiveSelectedLutCurveId = materialAaOverrideEnabled
    ? profileAntiAliasingSettings.selectedLutCurveId
    : selectedCurveId;
  const effectiveCustomLutCurve = savedCurves.find((curve) => curve.id === effectiveSelectedLutCurveId) ?? null;
  const effectiveCustomLut = effectiveCustomLutCurve ? sampleCurveToLut(effectiveCustomLutCurve.points) : opaqueDefaultLut;
  const effectiveZBlendMaxAlphaPercent = effectiveZBlendResinType === 'clear'
    ? Z_BLEND_MAX_ALPHA_BY_RESIN.clear
    : effectiveZBlendResinType === 'custom'
      ? Math.max(...effectiveCustomLut) / 255 * 100
      : Z_BLEND_MAX_ALPHA_BY_RESIN.opaque;
  const blurUsesLutCurve = (aaMode === 'Blur' || aaMode === '3DAA') && effectiveBlurGraySourceMode === 'lut';
  const shouldUseLutCurveForExport =
    (effectiveAntiAliasingMode === 'Vertical2' || effectiveAntiAliasingMode === 'Blur' || effectiveAntiAliasingMode === 'Coverage')
    && effectiveBlurGraySourceMode === 'lut';

  const minimumAaProfileSupport = useMemo(() => {
    const fallback = Math.max(
      0,
      Math.min(100, Math.round(Number(sessionAaOverrideDraft?.minimumAaAlphaPercent ?? effectiveMaterialProfile?.minimumAaAlphaPercent ?? 35))),
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
    sessionAaOverrideDraft?.minimumAaAlphaPercent,
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

  const setClampedZBlurRadiusLayers = useCallback((value: number) => {
    const next = Number.isFinite(value) ? value : 1;
    setZBlurRadiusLayers(Math.max(0, Math.min(Z_BLUR_RADIUS_MAX_LAYERS, Math.round(next))));
  }, []);

  const setClampedZBlendLookBack = useCallback((value: number) => {
    const next = Number.isFinite(value) ? value : 2;
    setZBlendLookBack(Math.max(LOOK_BACK_MIN_LAYERS, Math.min(LOOK_BACK_MAX_LAYERS, Math.round(next))));
  }, []);

  const setClampedZBlendFadePx = useCallback((value: number) => {
    const next = Number.isFinite(value) ? value : 8;
    setZBlendFadePx(Math.max(FADE_DISTANCE_MIN_PX, Math.min(FADE_DISTANCE_MAX_PX, Math.round(next))));
  }, []);

  const setAaOnSupportsEnabled = useCallback((enabled: boolean) => {
    saveSlicingPerformanceSettings({
      ...getSavedSlicingPerformanceSettings(),
      aaOnSupportsExperimental: enabled,
    });
  }, []);

  useEffect(() => {
    if (useAutoFadeDistance) return;
    if (useCustomZBlendFadePx) return;
    if (isPresetValue(fadeDistancePresets, zBlendFadePx)) return;
    // Preserve the user-selected value instead of snapping to a fallback preset.
    // If current value no longer maps to the dynamic preset set, move to Custom.
    setUseCustomZBlendFadePx(true);
  }, [fadeDistancePresets, useAutoFadeDistance, useCustomZBlendFadePx, zBlendFadePx]);

  useEffect(() => {
    if (aaQualityMode !== 'expert' || aaMode !== '3DAA') return;
    const targetMode: 'auto' | 'manual' = zBlendAutoMode ? 'auto' : 'manual';
    if (zBlendFadeMode === targetMode) return;
    setZBlendFadeMode(targetMode);
  }, [aaMode, aaQualityMode, zBlendAutoMode, zBlendFadeMode]);

  const setClampedRemoteOfflineLayerHeightMm = useCallback((value: number) => {
    setRemoteOfflineLayerHeightMm((previous) => {
      const next = clampRemoteOfflineLayerHeightMm(value, previous);
      return Object.is(previous, next) ? previous : next;
    });
  }, []);

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
    window.localStorage.setItem(SLICING_BLUR_BRUSH_KERNEL_STORAGE_KEY, blurBrushKernel);
    window.sessionStorage.setItem(SLICING_BLUR_BRUSH_KERNEL_STORAGE_KEY, blurBrushKernel);
  }, [blurBrushKernel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(clampBlurSigma(blurBrushSigmaX, 0.5));
    window.localStorage.setItem(SLICING_BLUR_BRUSH_SIGMA_X_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_BLUR_BRUSH_SIGMA_X_STORAGE_KEY, serialized);
  }, [blurBrushSigmaX]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(clampBlurSigma(blurBrushSigmaY, 0.5));
    window.localStorage.setItem(SLICING_BLUR_BRUSH_SIGMA_Y_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_BLUR_BRUSH_SIGMA_Y_STORAGE_KEY, serialized);
  }, [blurBrushSigmaY]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(Math.max(0, Math.min(Z_BLUR_RADIUS_MAX_LAYERS, Math.round(zBlurRadiusLayers))));
    window.localStorage.setItem(SLICING_Z_BLUR_RADIUS_LAYERS_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_Z_BLUR_RADIUS_LAYERS_STORAGE_KEY, serialized);
  }, [zBlurRadiusLayers]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_Z_BLUR_KERNEL_STORAGE_KEY, zBlurKernel);
    window.sessionStorage.setItem(SLICING_Z_BLUR_KERNEL_STORAGE_KEY, zBlurKernel);
  }, [zBlurKernel]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(clampBlurSigma(zBlurSigma, 0.5));
    window.localStorage.setItem(SLICING_Z_BLUR_SIGMA_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_Z_BLUR_SIGMA_STORAGE_KEY, serialized);
  }, [zBlurSigma]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(useCustomZBlurRadius);
    window.localStorage.setItem(SLICING_Z_BLUR_RADIUS_CUSTOM_ENABLED_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_Z_BLUR_RADIUS_CUSTOM_ENABLED_STORAGE_KEY, serialized);
  }, [useCustomZBlurRadius]);

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
    window.localStorage.setItem(SLICING_3DAA_FADE_MODE_STORAGE_KEY, zBlendFadeMode);
    window.sessionStorage.setItem(SLICING_3DAA_FADE_MODE_STORAGE_KEY, zBlendFadeMode);
  }, [zBlendFadeMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(zBlendAutoMode);
    window.localStorage.setItem(SLICING_3DAA_AUTO_MODE_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_3DAA_AUTO_MODE_STORAGE_KEY, serialized);
  }, [zBlendAutoMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_ZAA_PATTERN_STORAGE_KEY, zaaPattern);
    window.sessionStorage.setItem(SLICING_ZAA_PATTERN_STORAGE_KEY, zaaPattern);
  }, [zaaPattern]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const serialized = String(zaaDuplicateZ);
    window.localStorage.setItem(SLICING_ZAA_DUPLICATE_Z_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_ZAA_DUPLICATE_Z_STORAGE_KEY, serialized);
  }, [zaaDuplicateZ]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_AA_QUALITY_MODE_STORAGE_KEY, aaQualityMode);
    window.sessionStorage.setItem(SLICING_AA_QUALITY_MODE_STORAGE_KEY, aaQualityMode);
  }, [aaQualityMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY, aaAutoPreset);
    window.sessionStorage.setItem(SLICING_AA_AUTO_PRESET_STORAGE_KEY, aaAutoPreset);
  }, [aaAutoPreset]);

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
    window.localStorage.setItem(SLICING_BLUR_GRAY_SOURCE_STORAGE_KEY, blurGraySourceMode);
    window.sessionStorage.setItem(SLICING_BLUR_GRAY_SOURCE_STORAGE_KEY, blurGraySourceMode);
  }, [blurGraySourceMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const serialized = String(clampRemoteOfflineLayerHeightMm(remoteOfflineLayerHeightMm));
    window.localStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
    window.sessionStorage.setItem(SLICING_REMOTE_OFFLINE_LAYER_HEIGHT_GLOBAL_STORAGE_KEY, serialized);
    window.dispatchEvent(new CustomEvent(REMOTE_OFFLINE_LAYER_HEIGHT_CHANGED_EVENT));
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
        aaOnSupports: aaOnSupportsEnabled,
        models: visibleModels,
        printerProfile: activePrinterProfile,
        materialProfile: materialProfileForSlicing,
        filenameBase: sliceFilenameBase || activePrinterProfile.name || 'slice_export',
        outputPath: resolvedOutputPath.length > 0 ? resolvedOutputPath : null,
        antiAliasingLevel: effectiveAntiAliasingLevel,
        antiAliasingMode: effectiveAntiAliasingMode,
        blurBrushRadiusPx: resolvedBlurBrushRadiusPx,
        blurBrushKernel: resolvedBlurBrushKernel,
        blurBrushSigmaX: resolvedBlurBrushSigmaX,
        blurBrushSigmaY: resolvedBlurBrushSigmaY,
        zBlurRadiusLayers: resolvedZBlurRadiusLayers,
        zBlurKernel: resolvedZBlurKernel,
        zBlurSigma: resolvedZBlurSigma,
        zBlendLookBack: resolvedAaMode === '3DAA' ? resolvedZBlendLookBack : undefined,
        zBlendFadePx: resolvedAaMode === '3DAA' ? effectiveZBlendFadePx : undefined,
        zBlendAutoFade: resolvedAaMode === '3DAA' ? (resolvedZBlendFadeMode === 'auto') : undefined,
        zBlendMinimumAlphaPercent: resolvedAaMode === '3DAA'
          ? profileMinimumAaAlphaPercent
          : undefined,
        zBlendMaxAlphaPercent: resolvedAaMode === '3DAA'
          ? effectiveZBlendMaxAlphaPercent
          : 90,
        zBlendCustomLut: shouldUseLutCurveForExport
          ? (effectiveZBlendResinType === 'clear'
              ? clearDefaultLut
              : effectiveZBlendResinType === 'custom'
                ? effectiveCustomLut
                : opaqueDefaultLut)
          : undefined,
        zaaKernel: effectiveZaaKernel,
        zaaPattern: effectiveZaaPattern,
        zaaDuplicateZ: effectiveZaaDuplicateZ,
        ditherEnabled: effectiveDitherEnabledForSlice,
        ditherBitDepth: effectiveDitherBitDepthForSlice,
        ditherDeviceGamma: effectiveDitherDeviceGammaForSlice,
        minimumAaAlphaPercentOverride: shouldUseLutCurveForExport && effectiveAntiAliasingMode === 'Blur'
          ? 0
          : profileMinimumAaAlphaPercent,

        outputMode: 'return',
        exportThumbnailPng,
        abortSignal: abortController.signal,
        onProgress: (done, total, phase) => {
          const phaseKind = resolveSlicingPhaseKind(phase);
          const isSlicingPhase = phaseKind === 'slicing';
          const isPreSlicingPhase = phaseKind === 'preparing' || phaseKind === 'staging';
          const safeTotal = Math.max(1, total);
          const safeDone = Math.max(0, Math.min(done, safeTotal));
          setCurrentPhase(phase);
          setSliceStatus(phase);

          if (isSlicingPhase) {
            hasSlicingProgressStartedRef.current = true;
          }

          if (!hasSlicingProgressStartedRef.current && isPreSlicingPhase) {
            // Keep pre-slice phases (Preparing / Staging) at zero progress.
            setProgressDone(0);
            setProgressTotal(1);
          } else {
            // Once slicing begins, keep progress in sync across Encoding/Finalizing/Handoff
            // so the bar and counter don't appear to stall near completion.
            setProgressDone(safeDone);
            setProgressTotal(safeTotal);
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

  // If menu is open and menu options disappear, close the menu.
  useEffect(() => {
    if ((canUpload || canPrint || canUvTools) || !sliceIntentMenuOpen) return;
    setSliceIntentMenuOpen(false);
  }, [canUpload, canPrint, canUvTools, sliceIntentMenuOpen]);

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
    if (aaQualityMode === 'auto' && isAutoAaCalculating) {
      return;
    }

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
  }, [aaQualityMode, isAutoAaCalculating, isSlicingZip, shouldAutoSlice]);

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
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Slicing</h3>
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Slicing</h3>
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
                    label="Anti-Aliasing"
                    help="Auto derives slice settings from your printer resolution and material layer height. Expert lets you jump to material AA settings or apply a temporary session override."
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    {(['auto', 'expert'] as const).map((qmode) => {
                      const qActive = aaQualityMode === qmode;
                      const label = qmode === 'auto' ? 'Auto' : 'Expert';
                      const disabled = qmode === 'auto' && materialAaOverrideEnabled;
                      return (
                        <button
                          key={qmode}
                          type="button"
                          disabled={disabled}
                          className="rounded border px-2 py-1.5 text-center text-xs font-semibold transition-colors disabled:cursor-not-allowed"
                          style={disabled
                            ? {
                                borderColor: 'var(--border-subtle)',
                                background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 36%)',
                                color: 'color-mix(in srgb, var(--text-muted), transparent 22%)',
                                opacity: 0.55,
                              }
                            : qActive
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
                            if (disabled) return;
                            setAaQualityMode(qmode);
                          }}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {aaOverrideNoticeLabel && (
                    <>
                      <div className="h-1.5" />
                      <div
                        className="rounded border px-2 py-1.5 text-center text-[10px] font-semibold"
                        style={{
                          borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 42%)',
                          background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 88%)',
                          color: 'color-mix(in srgb, #f59e0b, var(--text-strong) 16%)',
                        }}
                      >
                        {aaOverrideNoticeLabel}
                      </div>
                    </>
                  )}

                  {aaQualityMode === 'auto' && (
                    <>
                      <div className="h-1.5" />
                      <div className="grid grid-cols-2 gap-1.5">
                        {AUTO_AA_PRESET_OPTIONS.map(({ preset, label, desc }) => {
                          const pActive = aaAutoPreset === preset;
                          return (
                            <button
                              key={preset}
                              type="button"
                              className="flex min-h-[45px] flex-col items-center justify-center rounded border px-2 py-1.5 text-center transition-colors"
                              style={pActive
                                ? {
                                    borderColor: 'var(--accent-secondary-action-border)',
                                    background: 'var(--accent-secondary-action-bg-92)',
                                    color: 'var(--accent-secondary-action-color)',
                                  }
                                : {
                                    borderColor: 'var(--border-subtle)',
                                    background: 'var(--surface-0)',
                                    color: 'var(--text-muted)',
                                  }}
                              onClick={() => setAaAutoPreset(preset)}
                            >
                              <div className="text-[11px] font-semibold leading-tight">{label}</div>
                              <div className="mt-0.5 text-[9px] leading-tight" style={{ color: pActive ? 'color-mix(in srgb, var(--accent-secondary-action-color), var(--text-muted) 38%)' : 'var(--text-muted)' }}>
                                {desc}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      {isAutoAaCalculating && (
                        <div
                          className="flex items-center justify-center gap-1 rounded border px-2 py-1 text-[10px] font-medium"
                          style={{
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-0)',
                            color: 'var(--text-muted)',
                          }}
                        >
                          <Loader2 className="h-3 w-3 animate-spin" />
                          <span>Calculating AA profile…</span>
                        </div>
                      )}
                      <div className="h-1.5" />
                      <div
                        className="grid grid-cols-2 overflow-hidden rounded"
                        style={{
                          background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 42%)',
                          boxShadow: 'inset 0 0 0 1px var(--border-subtle)',
                        }}
                      >
                        {([
                          ['Mode', autoAaSummaryKernelLabel],
                          ['Samples', autoAaSummarySampleLabel],
                          ['Blur', autoAaSummaryBlurLabel],
                          ['Grey', autoAaSummaryGrayLabel],
                        ] as const).map(([label, value], index) => (
                          <div
                            key={label}
                            className="min-w-0 px-1.5 py-1.5 text-center leading-tight"
                            style={{
                              color: 'var(--text-strong)',
                              borderRight: index % 2 === 0 ? '1px solid var(--border-subtle)' : undefined,
                              borderBottom: index < 2 ? '1px solid var(--border-subtle)' : undefined,
                            }}
                            title={value}
                          >
                            <div className="text-[9px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
                            <div className="truncate text-[11px] font-semibold">{value}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {aaQualityMode === 'expert' && (
                    <>
                      <div className="h-1.5" />
                      <div className="space-y-1.5">
                        <button
                          type="button"
                          disabled={!activeMaterialProfile}
                          className="w-full rounded border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                          style={sessionAaOverrideEnabled
                            ? {
                                borderColor: 'var(--border-subtle)',
                                background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 36%)',
                                color: 'color-mix(in srgb, var(--text-muted), transparent 18%)',
                                opacity: 0.55,
                              }
                            : {
                                borderColor: materialProfileAaOverrideEnabled ? 'var(--accent-secondary-action-border)' : 'var(--border-subtle)',
                                background: materialProfileAaOverrideEnabled ? 'var(--accent-secondary-action-bg-92)' : 'var(--surface-0)',
                                color: materialProfileAaOverrideEnabled ? 'var(--accent-secondary-action-color)' : 'var(--text-strong)',
                              }}
                          onClick={handleOpenMaterialAaEditor}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold leading-tight">Material Profile Settings</span>
                            <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: sessionAaOverrideEnabled ? 'var(--text-muted)' : materialProfileAaOverrideEnabled ? 'color-mix(in srgb, var(--accent-secondary-action-color), var(--text-muted) 38%)' : 'var(--text-muted)' }}>
                              {sessionAaOverrideEnabled ? 'Bypassed' : materialProfileAaOverrideEnabled ? 'Override On' : 'Edit'}
                            </span>
                          </div>
                        </button>
                        <button
                          type="button"
                          disabled={!activeMaterialProfile}
                          className="w-full rounded border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45"
                          style={{
                            borderColor: sessionAaOverrideEnabled ? 'var(--accent-secondary-action-border)' : 'var(--border-subtle)',
                            background: sessionAaOverrideEnabled ? 'var(--accent-secondary-action-bg-92)' : 'var(--surface-0)',
                            color: sessionAaOverrideEnabled ? 'var(--accent-secondary-action-color)' : 'var(--text-strong)',
                          }}
                          onClick={handleOpenSessionAaOverride}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-semibold leading-tight">Session Overrides</span>
                            <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: sessionAaOverrideEnabled ? 'color-mix(in srgb, var(--accent-secondary-action-color), var(--text-muted) 38%)' : 'var(--text-muted)' }}>
                              {sessionAaOverrideEnabled ? 'Active' : 'Temporary'}
                            </span>
                          </div>
                        </button>
                        {sessionAaOverrideDraft && (
                          <button
                            type="button"
                            className="w-full rounded border px-2 py-1.5 text-xs font-semibold transition-colors"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              background: 'var(--surface-0)',
                              color: 'var(--text-muted)',
                            }}
                            onClick={() => {
                              if (activeMaterialProfile) {
                                clearSessionAaOverrideDraft(activeMaterialProfile.id);
                              }
                              setSessionAaOverrideDraft(null);
                            }}
                          >
                            Clear Session Override
                          </button>
                        )}
                      </div>
                    </>
                  )}

                  {false && aaQualityMode === 'expert' && <>
                  <SettingLabelWithHelp
                    label="Anti-Aliasing Mode"
                    help="Off disables AA. Blur applies XY smoothing only. 3DAA applies XY smoothing plus Z perturbation sampling through the layer height."
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
                          onClick={() => handleAaModeChange(mode)}
                        >
                          {mode}
                        </button>
                      );
                    })}
                  </div>
                  {aaMode !== 'Off' && (
                    <>
                      {/* ── Sample Count ── */}
                      <SettingLabelWithHelp
                        label={advancedSampleCountLabel}
                        help={advancedSampleCountHelp}
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
                          className="min-w-0 rounded border px-1 py-1 text-[9px] sm:text-[11px] font-medium leading-none tracking-tight whitespace-nowrap transition-colors"
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

                      {/* ── "More" rollup: Perturbation Pattern + Duplicate Terminal Z (3DAA only, item 4) ── */}
                      {aaMode === '3DAA' && (
                        <>
                          <button
                            type="button"
                            className="flex items-center gap-1 px-0.5 py-0.5 rounded text-xs transition-colors"
                            style={{ color: 'var(--text-muted)' }}
                            onClick={() => setShowMoreZaaOptions((v) => !v)}
                          >
                            <ChevronDown className={`h-3 w-3 transition-transform duration-150 ${showMoreZaaOptions ? '' : '-rotate-90'}`} />
                            <span>More</span>
                          </button>
                          {showMoreZaaOptions && (
                            <>
                              <SettingLabelWithHelp
                                label="Perturbation Pattern"
                                help="Chooses how 3DAA distributes Z samples. Uniform uses centered spacing, Halton is low-discrepancy, and Base2 uses a van der Corput sequence."
                              />
                              <div className="grid grid-cols-3 gap-1">
                                {([
                                  ['uniform', 'Uniform'],
                                  ['halton', 'Halton'],
                                  ['base2', 'Base2'],
                                ] as const).map(([pattern, label]) => (
                                  <button
                                    key={pattern}
                                    type="button"
                                    className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                                    style={zaaPattern === pattern
                                      ? {
                                          borderColor: 'var(--accent-secondary-action-border)',
                                          background: 'var(--accent-secondary-action-bg-92)',
                                          color: 'var(--accent-secondary-action-color)',
                                        }
                                      : {
                                          borderColor: 'var(--border-subtle)',
                                          background: 'var(--surface-0)',
                                          color: 'var(--text-muted)',
                                        }}
                                    onClick={() => setZaaPattern(pattern)}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>

                              {duplicateZSupportedAtCurrentAa && (
                                <>
                                  <SettingLabelWithHelp
                                    label="Duplicate Terminal Z"
                                    help="Reduces triangle lookups by 50% by pairing half of Y perturbations at the same Z perturbation height."
                                  />
                                  <div className="grid grid-cols-2 gap-1">
                                    <button
                                      type="button"
                                      className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                                      style={!zaaDuplicateZ
                                        ? {
                                            borderColor: 'var(--accent-secondary-action-border)',
                                            background: 'var(--accent-secondary-action-bg-92)',
                                            color: 'var(--accent-secondary-action-color)',
                                          }
                                        : {
                                            borderColor: 'var(--border-subtle)',
                                            background: 'var(--surface-0)',
                                            color: 'var(--text-muted)',
                                          }}
                                      onClick={() => setZaaDuplicateZ(false)}
                                    >
                                      Off
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                                      style={zaaDuplicateZ
                                        ? {
                                            borderColor: 'var(--accent-secondary-action-border)',
                                            background: 'var(--accent-secondary-action-bg-92)',
                                            color: 'var(--accent-secondary-action-color)',
                                          }
                                        : {
                                            borderColor: 'var(--border-subtle)',
                                            background: 'var(--surface-0)',
                                            color: 'var(--text-muted)',
                                          }}
                                      onClick={() => setZaaDuplicateZ(true)}
                                    >
                                      On
                                    </button>
                                  </div>
                                </>
                              )}
                            </>
                          )}
                        </>
                      )}

                      {/* ── XY Blur Radius (item 1: disabled state; item 6: collapse toggle) ── */}
                      <SettingLabelWithHelp
                        label={advancedBlurWidthLabel}
                        help={advancedBlurWidthHelp}
                        onToggle={() => setShowXyBlurSection((v) => !v)}
                        isOpen={showXyBlurSection}
                      />
                      {showXyBlurSection && (
                        <>
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
                              className="min-w-0 rounded border px-1 py-1 text-[9px] sm:text-[11px] font-medium leading-none tracking-tight whitespace-nowrap transition-colors"
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
                            <div
                              className="mt-1 rounded-md border p-2"
                              style={{
                                borderColor: 'var(--border-subtle)',
                                background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 38%)',
                              }}
                            >
                              <ScrollableNumberField
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
                              {/* Item 1: radius=0 → "XY Blur Disabled" replaces Box/Gaussian grid */}
                              {blurBrushRadiusPx === 0 ? (
                                <div className="mt-2">
                                  <button
                                    type="button"
                                    className="w-full rounded border px-1.5 py-1 text-xs font-medium"
                                    style={{
                                      borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
                                      background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                                      color: 'var(--text-strong)',
                                    }}
                                  >
                                    XY Blur Disabled
                                  </button>
                                </div>
                              ) : (
                                <div className="mt-2 grid grid-cols-2 gap-1">
                                  {([['box', 'Box'], ['gaussian', 'Gaussian']] as const).map(([mode, label]) => {
                                    const active = blurBrushKernel === mode;
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
                                        onClick={() => setBlurBrushKernel(mode)}
                                      >
                                        {label}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                              {blurBrushKernel === 'gaussian' && blurBrushRadiusPx > 0 && (
                                <div className="mt-2 grid grid-cols-2 gap-1.5">
                                  <div>
                                    <div className="px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                      Sigma X
                                    </div>
                                    <ScrollableNumberField
                                      value={blurBrushSigmaX}
                                      onChange={(value) => setBlurBrushSigmaX(clampBlurSigma(value, 1.5))}
                                      min={0.05}
                                      max={16}
                                      step={0.05}
                                      unit=""
                                      ariaLabel="Gaussian XY sigma X"
                                      decreaseTitle="Decrease XY sigma X"
                                      increaseTitle="Increase XY sigma X"
                                    />
                                  </div>
                                  <div>
                                    <div className="px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                      Sigma Y
                                    </div>
                                    <ScrollableNumberField
                                      value={blurBrushSigmaY}
                                      onChange={(value) => setBlurBrushSigmaY(clampBlurSigma(value, 1.5))}
                                      min={0.05}
                                      max={16}
                                      step={0.05}
                                      unit=""
                                      ariaLabel="Gaussian XY sigma Y"
                                      decreaseTitle="Decrease XY sigma Y"
                                      increaseTitle="Increase XY sigma Y"
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </>
                      )}

                      {/* ── Z Blur Radius Layers (3DAA only) ── */}
                      {aaMode === '3DAA' && (
                        <>
                          <SettingLabelWithHelp
                            label="Z Blur Radius Layers"
                            help="Applies a blur across neighboring layers after 3DAA sampling to smooth Z stair-steps. Radius 0 disables Z blur. Radius 1 blends 3 layers, radius 2 blends 5 layers, etc."
                            onToggle={() => setShowZBlurSection((v) => !v)}
                            isOpen={showZBlurSection}
                          />
                          {showZBlurSection && (
                            <>
                              <div className="grid grid-cols-4 gap-1">
                                {Z_BLUR_RADIUS_PRESETS.map((preset) => {
                                  const active = !useCustomZBlurRadius && zBlurRadiusLayers === preset;
                                  return (
                                    <button
                                      key={preset}
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
                                        setUseCustomZBlurRadius(false);
                                        setClampedZBlurRadiusLayers(preset);
                                      }}
                                    >
                                      {`${preset}`}
                                    </button>
                                  );
                                })}
                                <button
                                  type="button"
                                  className="min-w-0 rounded border px-1 py-1 text-[9px] sm:text-[11px] font-medium leading-none tracking-tight whitespace-nowrap transition-colors"
                                  style={useCustomZBlurRadius
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
                                  onClick={() => setUseCustomZBlurRadius(true)}
                                >
                                  Custom
                                </button>
                              </div>
                              {useCustomZBlurRadius && (
                                <div
                                  className="mt-1 rounded-md border p-2"
                                  style={{
                                    borderColor: 'var(--border-subtle)',
                                    background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 38%)',
                                  }}
                                >
                                  <ScrollableNumberField
                                    value={zBlurRadiusLayers}
                                    onChange={setClampedZBlurRadiusLayers}
                                    min={0}
                                    max={Z_BLUR_RADIUS_MAX_LAYERS}
                                    step={1}
                                    unit=""
                                    ariaLabel="3DAA Z blur radius layers"
                                    decreaseTitle="Decrease Z blur radius"
                                    increaseTitle="Increase Z blur radius"
                                  />
                                  {zBlurRadiusLayers === 0 ? (
                                    <div className="mt-2">
                                      <button
                                        type="button"
                                        className="w-full rounded border px-1.5 py-1 text-xs font-medium"
                                        style={{
                                          borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
                                          background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                                          color: 'var(--text-strong)',
                                        }}
                                      >
                                        Z Blur Disabled
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="mt-2 grid grid-cols-2 gap-1">
                                      {([['box', 'Box'], ['gaussian', 'Gaussian']] as const).map(([mode, label]) => {
                                        const active = zBlurKernel === mode;
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
                                            onClick={() => setZBlurKernel(mode)}
                                          >
                                            {label}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  )}
                                  {zBlurKernel === 'gaussian' && zBlurRadiusLayers > 0 && (
                                    <div className="mt-2">
                                      <div className="px-0.5 pb-1 text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                        Sigma
                                      </div>
                                      <ScrollableNumberField
                                        value={zBlurSigma}
                                        onChange={(value) => setZBlurSigma(clampBlurSigma(value, 0.5))}
                                        min={0.05}
                                        max={16}
                                        step={0.05}
                                        unit=""
                                        ariaLabel="Gaussian Z sigma"
                                        decreaseTitle="Decrease Z sigma"
                                        increaseTitle="Increase Z sigma"
                                      />
                                    </div>
                                  )}
                                </div>
                              )}
                            </>
                          )}
                        </>
                      )}

                      {/* divider before Grayscale */}
                      <div
                        className="my-2.5 mx-1 h-px rounded-full"
                        style={{
                          background: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--border-subtle), var(--text-muted) 18%) 22%, color-mix(in srgb, var(--border-subtle), var(--text-muted) 18%) 78%, transparent 100%)',
                        }}
                      />

                      {/* ── Grayscale Mapping ── */}
                      <SettingLabelWithHelp
                        label="Grayscale Mapping"
                        help="LUT Curve is the default and recommended path for grayscale AA. Minimum Grey remains available as a simpler fallback override when you want threshold-style behavior instead of a cure-response curve."
                        onToggle={() => setShowGrayscaleSection((v) => !v)}
                        isOpen={showGrayscaleSection}
                      />
                      {showGrayscaleSection && (
                        <>
                          <div className="grid grid-cols-2 gap-1">
                            <button
                              type="button"
                              className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                              style={blurGraySourceMode === 'lut'
                                ? {
                                    borderColor: 'var(--accent-secondary-action-border)',
                                    background: 'var(--accent-secondary-action-bg-92)',
                                    color: 'var(--accent-secondary-action-color)',
                                  }
                                : {
                                    borderColor: 'var(--border-subtle)',
                                    background: 'var(--surface-0)',
                                    color: 'var(--text-muted)',
                                  }}
                              onClick={() => setBlurGraySourceMode('lut')}
                            >
                              LUT Curve
                            </button>
                            <button
                              type="button"
                              className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                              style={blurGraySourceMode === 'minimum'
                                ? {
                                    borderColor: 'var(--accent-secondary-action-border)',
                                    background: 'var(--accent-secondary-action-bg-92)',
                                    color: 'var(--accent-secondary-action-color)',
                                  }
                                : {
                                    borderColor: 'var(--border-subtle)',
                                    background: 'var(--surface-0)',
                                    color: 'var(--text-muted)',
                                  }}
                              onClick={() => setBlurGraySourceMode('minimum')}
                            >
                              Minimum Grey
                            </button>
                          </div>

                          {((aaMode === 'Blur' && blurUsesLutCurve)
                            || (aaMode === '3DAA' && blurGraySourceMode === 'lut')) && (
                            <div className="space-y-1">
                              <SettingLabelWithHelp
                                label="LUT Curve"
                                help={aaMode === '3DAA'
                                  ? 'Chooses the cure-response LUT for perturbation-based 3DAA grayscale output. Opaque uses a stronger EXP curve (~47%→90%) for standard resins, Clear uses a gentler EXP curve (~39%→65%) for translucent materials, and Custom lets you import or tune your own curve.'
                                  : 'Remaps the final grayscale output through the shared resin-calibrated cure curve system used by both Blur AA and 3DAA.'}
                              />
                              <div className="grid grid-cols-3 gap-1">
                                {(['opaque', 'clear', 'custom'] as const).map((rtype) => {
                                  const active = zBlendResinType === rtype;
                                  const isAutoDetected = rtype !== 'custom' && autoDetectedResinType === rtype;
                                  return (
                                    <button
                                      key={rtype}
                                      type="button"
                                      className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                                      style={active
                                        ? {
                                            borderColor: 'var(--accent-secondary-action-border)',
                                            background: 'var(--accent-secondary-action-bg-92)',
                                            color: 'var(--accent-secondary-action-color)',
                                          }
                                        : {
                                            borderColor: 'var(--border-subtle)',
                                            background: 'var(--surface-0)',
                                            color: 'var(--text-muted)',
                                          }}
                                      title={isAutoDetected ? 'Auto-detected from material name' : undefined}
                                      onClick={() => setZBlendResinType(rtype)}
                                    >
                                      {rtype === 'opaque' ? 'Opaque' : rtype === 'clear' ? 'Clear' : 'Custom'}
                                      {isAutoDetected && <span className="ml-1 opacity-60 text-[9px]">✦</span>}
                                    </button>
                                  );
                                })}
                              </div>
                              {zBlendResinType === 'custom' && (
                                <LutCurveSelector
                                  savedCurves={savedCurves}
                                  selectedCurveId={selectedCurveId}
                                  onSelectCurve={setSelectedCurveId}
                                  onOpenEditor={(id) => setEditingTarget(id ?? NEW_CURVE_EDITING_TARGET)}
                                />
                              )}
                              <LutCurveEditorModal
                                isOpen={editingTarget !== null}
                                savedCurves={savedCurves}
                                selectedCurveId={selectedCurveId}
                                onSelectCurve={(id) => {
                                  setSelectedCurveId(id);
                                  setEditingTarget(id);
                                }}
                                onImportCurve={(curve) => {
                                  const importedId = curve.id.trim() || crypto.randomUUID();
                                  const normalizedName = curve.name.trim() || 'Imported Curve';
                                  setSavedCurves((prev) => {
                                    const lowerNames = new Set(prev.map((entry) => entry.name.trim().toLowerCase()));
                                    let finalName = normalizedName;
                                    let suffix = 2;
                                    while (lowerNames.has(finalName.trim().toLowerCase())) {
                                      finalName = `${normalizedName} (${suffix})`;
                                      suffix += 1;
                                    }
                                    const importedCurve = {
                                      ...curve,
                                      id: importedId,
                                      name: finalName,
                                    };
                                    return [...prev, importedCurve];
                                  });
                                  setSelectedCurveId(importedId);
                                  setEditingTarget(importedId);
                                }}
                                editingCurve={
                                  editingTarget === null || editingTarget === NEW_CURVE_EDITING_TARGET
                                    ? null
                                    : (savedCurves.find((c) => c.id === editingTarget) ?? null)
                                }
                                onSave={(curve) => {
                                  if (savedCurves.some((c) => c.id === curve.id)) {
                                    setSavedCurves((prev) => prev.map((c) => c.id === curve.id ? curve : c));
                                  } else {
                                    setSavedCurves((prev) => [...prev, curve]);
                                    setSelectedCurveId(curve.id);
                                  }
                                  setEditingTarget(null);
                                }}
                                onDelete={(id) => {
                                  const next = savedCurves.filter((c) => c.id !== id);
                                  const fallback = next.length > 0
                                    ? next
                                    : [{ ...DEFAULT_SAVED_CURVES[0], id: crypto.randomUUID(), points: [...DEFAULT_CUSTOM_CURVE] }];

                                  const nextSelectedId = selectedCurveId === id
                                    ? fallback[0].id
                                    : (fallback.some((curve) => curve.id === selectedCurveId)
                                        ? selectedCurveId
                                        : fallback[0].id);

                                  setSavedCurves(fallback);
                                  setSelectedCurveId(nextSelectedId);
                                  setEditingTarget(nextSelectedId);
                                }}
                                onClose={() => setEditingTarget(null)}
                              />
                            </div>
                          )}

                          {blurGraySourceMode === 'minimum' && (
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
                          )}
                        </>
                      )}

                      {/* ── AA on Supports — moved to bottom, default closed (item 7) ── */}
                      {(aaMode === 'Blur' || aaMode === '3DAA') && (
                        <>
                          <div
                            className="my-2.5 mx-1 h-px rounded-full"
                            style={{
                              background: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--border-subtle), var(--text-muted) 18%) 22%, color-mix(in srgb, var(--border-subtle), var(--text-muted) 18%) 78%, transparent 100%)',
                            }}
                          />
                          <SettingLabelWithHelp
                            label="AA on Supports"
                            help="Controls whether native support and raft geometry also receives grayscale AA in the selected mode. Off keeps supports crisp and binary; On allows anti-aliased support edges too."
                            onToggle={() => setShowAaOnSupports((v) => !v)}
                            isOpen={showAaOnSupports}
                          />
                          {showAaOnSupports && (
                            <div className="grid grid-cols-2 gap-1">
                              <button
                                type="button"
                                className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                                style={!aaOnSupportsEnabled
                                  ? {
                                      borderColor: 'var(--accent-secondary-action-border)',
                                      background: 'var(--accent-secondary-action-bg-92)',
                                      color: 'var(--accent-secondary-action-color)',
                                    }
                                  : {
                                      borderColor: 'var(--border-subtle)',
                                      background: 'var(--surface-0)',
                                      color: 'var(--text-muted)',
                                    }}
                                onClick={() => setAaOnSupportsEnabled(false)}
                              >
                                Supports Off
                              </button>
                              <button
                                type="button"
                                className="rounded border px-1.5 py-1 text-xs font-medium transition-colors"
                                style={aaOnSupportsEnabled
                                  ? {
                                      borderColor: 'var(--accent-secondary-action-border)',
                                      background: 'var(--accent-secondary-action-bg-92)',
                                      color: 'var(--accent-secondary-action-color)',
                                    }
                                  : {
                                      borderColor: 'var(--border-subtle)',
                                      background: 'var(--surface-0)',
                                      color: 'var(--text-muted)',
                                    }}
                                onClick={() => setAaOnSupportsEnabled(true)}
                              >
                                Supports On
                              </button>
                            </div>
                          )}
                        </>
                      )}

                    </>
                  )}
                  </>}
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
            const isAutoAaPending = aaQualityMode === 'auto' && isAutoAaCalculating;
            const isDisabled = isSlicingZip || isAutoAaPending || !activePrinterProfile || !materialProfileForSlicing || models.length === 0;
            type IconType = React.FC<{ className?: string }>;
            const intentOptions: { key: SliceIntent; label: string; Icon: IconType; enabled: boolean; menuOnly?: boolean }[] = [
              { key: 'file',    label: 'Slice to File',      Icon: Download as IconType, enabled: true },
              { key: 'upload',  label: 'Slice & Upload',     Icon: Printer  as IconType, enabled: canUpload },
              { key: 'print',   label: 'Slice & Print',      Icon: Play     as IconType, enabled: canPrint },
              { key: 'uvtools', label: 'Send to UVTools',    Icon: ExternalLink as IconType, enabled: canUvTools },
              { key: 'preview', label: 'Just Slice',         Icon: Cpu      as IconType, enabled: true, menuOnly: true },
            ];
            const current = intentOptions.find((o) => o.key === effectiveSliceIntent) ?? intentOptions[0]!;
            const CurrentIcon = current.Icon;
            const hasMenuOptions = canUpload || canPrint || canUvTools;
            return (
              <div ref={sliceIntentAnchorRef} className="relative w-full">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={() => { void handleSliceZipExport(); }}
                    disabled={isDisabled}
                    className={`ui-button ui-button-primary flex-1 !h-9 text-sm inline-flex items-center justify-center gap-1.5 ${hasMenuOptions && !isShiftHeld ? 'rounded-r-none' : ''} ${isSlicingZip ? 'cursor-wait opacity-70' : ''}`}
                  >
                    <CurrentIcon className="w-4 h-4 shrink-0" />
                    {isSlicingZip ? 'Slicing…' : isAutoAaPending ? 'Profiling AA…' : current.label}
                  </button>
                  {hasMenuOptions && !isShiftHeld && (
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

      {isMaterialAaEditorOpen && materialAaEditorDraft && activeMaterialProfile && typeof document !== 'undefined' && createPortal(
        <div className="fixed left-0 right-0 top-[var(--topbar-height)] bottom-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3">
          <div
            className="w-full max-w-[920px] h-[min(760px,88vh)] overflow-hidden rounded-xl border shadow-2xl flex flex-col"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Material anti-aliasing settings"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Material Anti-Aliasing Settings
                </h2>
                <p className="ui-meta truncate">
                  {activeMaterialProfile.name} · {activeMaterialProfile.brand}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsMaterialAaEditorOpen(false)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                aria-label="Close material anti-aliasing settings"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 overflow-y-auto custom-scrollbar flex-1">
              <MaterialAntiAliasingSection
                draft={materialAaEditorDraft}
                printerDitherBitDepth={printerDitherBitDepth}
                onChange={(next) => {
                  setMaterialAaEditorDraft((current) => {
                    if (!current) return current;
                    return typeof next === 'function' ? next(current) : next;
                  });
                }}
              />
            </div>
            <div className="px-3 py-2 border-t flex items-center justify-end gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <button
                type="button"
                onClick={() => setIsMaterialAaEditorOpen(false)}
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveMaterialAaEditor}
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                style={{
                  borderColor: 'var(--accent-secondary-action-border)',
                  background: 'var(--accent-secondary-action-bg-92)',
                  color: 'var(--accent-secondary-action-color)',
                }}
              >
                Save Material
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {isSessionAaOverrideOpen && editingSessionAaOverrideDraft && typeof document !== 'undefined' && createPortal(
        <div className="fixed left-0 right-0 top-[var(--topbar-height)] bottom-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3">
          <div
            className="w-full max-w-[920px] h-[min(760px,88vh)] overflow-hidden rounded-xl border shadow-2xl flex flex-col"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Session anti-aliasing override"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Session Anti-Aliasing Override
                </h2>
                <p className="ui-meta truncate">
                  {activeMaterialProfile ? `${activeMaterialProfile.name} · ${activeMaterialProfile.brand}` : 'Current material'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsSessionAaOverrideOpen(false)}
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                aria-label="Close session anti-aliasing override"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 overflow-y-auto custom-scrollbar flex-1">
              <MaterialAntiAliasingSection
                draft={editingSessionAaOverrideDraft}
                lockActivationToggles
                printerDitherBitDepth={printerDitherBitDepth}
                onChange={(next) => {
                  setEditingSessionAaOverrideDraft((current) => {
                    if (!current) return current;
                    return typeof next === 'function' ? next(current) : next;
                  });
                }}
              />
            </div>
            <div className="px-3 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <button
                type="button"
                onClick={() => {
                  if (activeMaterialProfile) {
                    clearSessionAaOverrideDraft(activeMaterialProfile.id);
                  }
                  setSessionAaOverrideDraft(null);
                  setEditingSessionAaOverrideDraft(null);
                  setIsSessionAaOverrideOpen(false);
                }}
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                style={{ color: 'var(--text-muted)' }}
              >
                Clear Override
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsSessionAaOverrideOpen(false)}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (activeMaterialProfile) {
                      writeSessionAaOverrideDraft(activeMaterialProfile.id, editingSessionAaOverrideDraft);
                    }
                    setSessionAaOverrideDraft(editingSessionAaOverrideDraft);
                    setIsSessionAaOverrideOpen(false);
                  }}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                  style={{
                    borderColor: 'var(--accent-secondary-action-border)',
                    background: 'var(--accent-secondary-action-bg-92)',
                    color: 'var(--accent-secondary-action-color)',
                  }}
                >
                  Apply for Session
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
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
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{progressPercentLabel}%</div>
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

      <AaSupportWarningModal
        isOpen={showAaWarningModal}
        modelName={aaWarningModelName}
        onCancel={handleAaWarningCancel}
        onProceed={handleAaWarningProceed}
      />
    </Card>
  );
}

export default SlicingPanel;
