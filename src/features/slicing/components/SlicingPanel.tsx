import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLingui } from '@lingui/react';
import { msg, plural } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronDown, CircleHelp, Cpu, Download, Edit3, ExternalLink, Layers3, Play, Printer, Timer, X } from 'lucide-react';
import { MouseTooltip } from '@/components/ui/MouseTooltip';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import { normalizeExportBaseName, resolvePlateOutputBaseName } from '@/features/export/logic/exportFileNaming';
import { Button, Card, CardHeader, IconButton } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { ScrollableNumberField } from '@/components/ui/scrollableNumberField';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import { openProfileSettingsModal } from '@/components/settings/profileModalEvents';
import { derivePlateOutputPath, type PlateSliceScope } from '@/features/slicing/plateSliceNaming';
import { plateNumberPlaceholder } from '@/features/scene/plates/plateMessages';
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
import { getProfileNetworkUiAdapter } from '@/features/plugins/pluginRegistry';
import {
  runSliceExportOrchestrator,
  type SliceExportArtifact,
  type SliceExportResult,
} from '@/features/slicing/sliceExportOrchestrator';
import { resolveSlicingFormatDefinition } from '@/features/slicing/formats/registry';
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
import { cleanupStalePrintTempArtifacts, cleanupAllPrintTempArtifacts, getSlicerEngineVersion, pickDirectoryWithNativeDialog } from '@/features/slicing/tauri/nativeSlicerBridge';
import type { AaPreset as AaAutoPreset } from '@/features/slicing/autoAaPhysics';
import {
  clampBlurSigma,
  formatAaLevel,
  parseAaLevelSteps,
  resolveSliceAntiAliasing,
} from '@/features/slicing/sliceAntiAliasing';
import { AaSupportWarningModal } from '@/components/modals/AaSupportWarningModal';
import {
  LutCurveSelector,
  LutCurveEditorModal,
  DEFAULT_CUSTOM_CURVE,
  DEFAULT_SAVED_CURVES,
  type CurvePoint,
  type SavedCurve,
} from './LutCurveEditor';
import { useKeyPressed } from '@/hotkeys/hotkeyStore';

export type SliceIntent = 'file' | 'upload' | 'print' | 'preview' | 'uvtools';

interface SlicingPanelProps {
  models: LoadedModel[];
  /**
   * The plates a slice can cover, in cascade order. Without them the panel
   * slices every visible model, which is what a single-plate scene means. With
   * them, a slice covers one plate: its models, judged against its own volume and
   * shifted to the origin so the rasterizer's origin-centred mapping stays true.
   * More than one entry also offers slicing them all, one file per plate.
   */
  plateSliceScopes?: readonly PlateSliceScope[];
  /** Which of those the plain Slice action covers. */
  activePlateSliceIndex?: number;
  excludedModelIds?: readonly string[];
  activeModel: LoadedModel | null;
  estimatedLayerCountOverride?: number | null;
  estimatedLayerHeightMmOverride?: number | null;
  estimatedVolumeLabelOverride?: string | null;
  captureSceneThumbnailPng?: () => Promise<Uint8Array | null>;
  /** A run's first moment, with the bed it is slicing, so per-bed state is dropped for that bed. */
  onSliceRunStarted?: (context?: { plateId?: string }) => void;
  onLayerPreviewGenerated?: (payload: {
    layerIndex: number;
    totalLayers: number;
    pngBytes: Uint8Array;
  }) => void;
  onSlicingFinished?: (payload: {
    totalLayers: number;
  }) => void;
  onSliceArtifactReady?: (
    artifact: SliceExportArtifact,
    context?: { plateId?: string; totalLayers?: number; savedPath?: string; savedDirectory?: string },
  ) => void;
  /**
   * A batch's plate, as soon as it is sliced — before the batch ends and the app walks into the
   * printing workspace. Recording it here is what lets the workspace's own previews be read
   * ahead of time, while the other plates are still slicing, instead of after it opens.
   */
  onSlicePlateSliced?: (
    artifact: SliceExportArtifact,
    context: { plateId?: string; totalLayers: number; savedPath?: string },
  ) => void;
  onBenchmarkComplete?: (benchmark: SliceBenchmarkSnapshot) => void;
  onSliceTriggerRef?: React.MutableRefObject<(() => void) | null>;
  shouldAutoSlice?: boolean;
  skipThumbnailCapture?: boolean;
  onSlicingBusyChange?: (busy: boolean) => void;
  canUpload?: boolean;
  canPrint?: boolean;
  onSliceIntentChanged?: (intent: SliceIntent) => void;
  /**
   * Runs before each slice. A batch hands it the folder it already picked, so every plate's
   * file lands in one place and nothing asks the user again.
   */
  onBeforeSliceStart?: (
    intent: SliceIntent,
    options?: { destinationDirectory?: string; baseName?: string },
  ) => Promise<boolean> | boolean;
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

type Translate = (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string;

// Interpolated messages live in module-level formatters: React Compiler renames
// locals before the Lingui macro computes the id, so interpolating inside a
// component leaves the placeholder raw in production builds.
function formatZaaSamplesLabel(translate: Translate, steps: number): string {
  return translate(msg`${steps}x ZAA Samples`);
}

function formatCoverageSamplesLabel(translate: Translate, steps: number): string {
  return translate(msg`${steps}x Coverage`);
}

function formatXyAndZBlurLabel(translate: Translate, pixels: number, layers: number): string {
  return translate(msg`${pixels}px XY · ${layers}L Z`);
}

function formatEdgeBlurLabel(translate: Translate, pixels: number): string {
  return translate(msg`${pixels}px Edge Blur`);
}

function formatLutCurveSummaryLabel(translate: Translate, curveName: string): string {
  return translate(msg`LUT: ${curveName}`);
}

function formatRemoteMaterialLabel(translate: Translate, materialName: string, sourceName: string): string {
  return translate(msg`${materialName} (${sourceName})`);
}

function formatRemoteMaterialIdLabel(translate: Translate, materialId: string): string {
  return translate(msg`${materialId} (Remote ID)`);
}

function formatLayerPreviewAlt(translate: Translate, layer: number): string {
  return translate(msg`Layer ${layer} preview`);
}

// Phases reported by the native slicer arrive already worded from the backend, so
// only the ones this panel sets itself carry a catalog entry; the rest pass through.
const SLICING_PHASE_LABELS: Record<string, MessageDescriptor> = {
  Idle: msg`Idle`,
  Preparing: msg`Preparing`,
  Encoding: msg`Encoding`,
  Ready: msg`Ready`,
  Opening: msg`Opening`,
  Cancelled: msg`Cancelled`,
  Cancelling: msg`Cancelling`,
};

/**
 * What a finished batch leaves in the status line. A module-scope helper because it interpolates:
 * a `msg` written inline in a component has its local renamed by React Compiler in production
 * builds, which desyncs the message id from the compiled catalog.
 */
function formatSlicedPlatesStatus(translate: Translate, count: number): string {
  return translate(msg`${plural(count, {
    one: 'Sliced # plate.',
    other: 'Sliced # plates.',
  })}`);
}

function formatSlicingPhaseLabel(translate: Translate, phase: string): string {
  const descriptor = SLICING_PHASE_LABELS[phase];
  return descriptor ? translate(descriptor) : phase;
}

type SlicePlateScope = 'all_plates' | 'current_plate';

/**
 * Which plates a slice covers. "All Plates" writes one file per plate into a zip, which the
 * panel used to offer as a second button under the slice action.
 */
const SLICE_PLATE_SCOPE_OPTIONS: ReadonlyArray<{ value: SlicePlateScope; label: MessageDescriptor }> = [
  { value: 'all_plates', label: msg`All Plates` },
  { value: 'current_plate', label: msg`Current Plate` },
];

/** The plate scope control, dressed as the anti-aliasing Auto/Expert pair above it. */
const activeSliceScopeStyle: React.CSSProperties = {
  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
  color: 'var(--text-strong)',
};

const idleSliceScopeStyle: React.CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-0)',
  color: 'var(--text-muted)',
};

function resolveSliceFilenameBase(models: LoadedModel[], activeModel: LoadedModel | null): string {
  const firstVisible = models.find((model) => model.visible);

  if (firstVisible) {
    return normalizeExportBaseName(firstVisible.name);
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

function formatLayerRate(translate: Translate, layersPerSecond: number | null): string {
  if (layersPerSecond == null || !Number.isFinite(layersPerSecond)) return '—';
  const rate = layersPerSecond >= 100
    ? String(Math.round(layersPerSecond))
    : layersPerSecond.toFixed(1);
  return translate(msg`${rate} layers/s`);
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

function isPresetValue(presets: readonly number[], value: number): boolean {
  return presets.some((preset) => preset === value);
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

function resolveInitialBlurKernel(storageKey: string, fallback: BlurKernelMode): BlurKernelMode {
  if (typeof window === 'undefined') return fallback;

  const stored = window.localStorage.getItem(storageKey)
    ?? window.sessionStorage.getItem(storageKey);
  return stored === 'gaussian' ? 'gaussian' : 'box';
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
  label: MessageDescriptor;
  desc: MessageDescriptor;
}> = [
  { preset: 'raw', label: msg`Disabled`, desc: msg`Raw masks only.` },
  { preset: 'sharp', label: msg`Sharp`, desc: msg`Crisp text and details.` },
  { preset: 'balanced', label: msg`Balanced`, desc: msg`Printer-aware smoothing.` },
  { preset: 'smooth', label: msg`Smooth`, desc: msg`Soft organic curves.` },
];

// AaAutoPreset is imported from autoAaPhysics.ts

export function SlicingPanel({
  models,
  plateSliceScopes,
  activePlateSliceIndex = 0,
  excludedModelIds = [],
  activeModel,
  estimatedLayerCountOverride,
  estimatedLayerHeightMmOverride,
  estimatedVolumeLabelOverride,
  captureSceneThumbnailPng,
  onSliceRunStarted,
  onLayerPreviewGenerated,
  onSlicingFinished,
  onSliceArtifactReady,
  onSlicePlateSliced,
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
  const { _ } = useLingui();
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
  const [showOutOfBoundsWarningModal, setShowOutOfBoundsWarningModal] = useState(false);
  const outOfBoundsWarningResolveRef = useRef<((proceed: boolean) => void) | null>(null);
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
  const [materialAaEditorDraft, setMaterialAaEditorDraft] = useState<MaterialDraft | null>(null);
  const [isMaterialAaEditorOpen, setIsMaterialAaEditorOpen] = useState(false);
  const [sessionAaOverrideDraft, setSessionAaOverrideDraft] = useState<MaterialDraft | null>(null);
  const [editingSessionAaOverrideDraft, setEditingSessionAaOverrideDraft] = useState<MaterialDraft | null>(null);
  const [isSessionAaOverrideOpen, setIsSessionAaOverrideOpen] = useState(false);

  // Escape closes both anti-aliasing editors; the slicing progress modal is
  // blocking, so it swallows the key instead of letting it through.
  useEscapeToClose(isMaterialAaEditorOpen, () => setIsMaterialAaEditorOpen(false));
  useEscapeToClose(isSessionAaOverrideOpen, () => setIsSessionAaOverrideOpen(false));
  useEscapeToClose(showSlicingModal, undefined);
  const [zBlendResinType, setZBlendResinType] = useState<'opaque' | 'clear' | 'custom'>(resolveInitialZBlendResinType);
  const [savedCurves, setSavedCurves] = useState<SavedCurve[]>(() => resolveInitialSavedCurves());
  const [selectedCurveId, setSelectedCurveId] = useState<string>(() => resolveInitialSelectedCurveId(resolveInitialSavedCurves()));
  const [editingTarget, setEditingTarget] = useState<string | null>(null);
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
  const handleSliceZipExportRef = useRef<((scopeOverride?: PlateSliceScope) => Promise<boolean>) | null>(null);
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
  const aaOnSupportsEnabled = profileAntiAliasingSettings.aaOnSupports === true;
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

  const autoLutCurveLabel = autoDetectedResinType === 'clear' ? _(msg`Clear`) : _(msg`Opaque`);

  const sessionAaOverrideEnabled = sessionAaOverrideDraft?.antiAliasingSettings?.enableOverride === true;
  const materialProfileAaOverrideEnabled = activeMaterialProfile?.antiAliasingSettings?.enableOverride === true;
  const aaOverrideNoticeLabel = sessionAaOverrideEnabled
    ? _(msg`Session Override active`)
    : materialProfileAaOverrideEnabled
      ? _(msg`Using Material Settings`)
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
  // Raw declared depth, kept separate from the clamped dither depth above so the
  // UI can tell "8-bit or deeper panel" apart from "printer declares nothing".
  const printerPanelBitDepth = useMemo<number | null>(() => {
    const printerBitDepth = Number(activePrinterProfile?.bitDepth?.bits);
    if (!Number.isFinite(printerBitDepth) || printerBitDepth <= 0) return null;
    return Math.round(printerBitDepth);
  }, [activePrinterProfile?.bitDepth?.bits]);
  const autoDitherRequiredForPrinter = printerDitherBitDepth != null;
  // An 8-bit (or deeper) panel emits every grayscale level on its own, so
  // dithering there can only quantize the layer below the panel's resolution.
  const ditherForcedOffForPrinter = printerPanelBitDepth != null && printerPanelBitDepth >= 8;
  const effectiveDitherEnabledForSlice = autoDitherRequiredForPrinter
    ? true
    : ditherForcedOffForPrinter
      ? false
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
    ? _(msg`Sliced Layers`)
    : phaseKind === 'encoding'
      ? _(msg`Encoded Layers`)
      : _(msg`Pipeline Units`);
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
      const isSupportGeometry = m.isSupportGeometry !== undefined
        ? m.isSupportGeometry
        : report.likely_support_geometry === true;
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

  const excludedModelIdSet = useMemo(() => new Set(excludedModelIds), [excludedModelIds]);
  /** The plate the plain Slice action covers. */
  const activePlateSliceScope = plateSliceScopes?.[activePlateSliceIndex] ?? null;
  /**
   * The plates a slice could cover that actually hold something. An empty bed is not a
   * choice: a scene whose other beds are bare slices exactly as a single-bed scene does, and
   * a bare bed is not what a file is named for either.
   */
  const populatedPlateScopes = useMemo(
    () => (plateSliceScopes ?? []).filter((scope) => scope.modelIds.length > 0),
    [plateSliceScopes],
  );
  const singlePlate = populatedPlateScopes.length <= 1;
  /** Which plates the slice covers: every plate that has one, or just the plate in hand. */
  const [slicePlateScope, setSlicePlateScope] = useState<SlicePlateScope>('all_plates');
  /**
   * What the scope means here. With one bed there is nothing to choose, so it is the bed in hand
   * whatever the selector last said — the button then reads and slices like a single run, which
   * is what a one-bed scene is.
   */
  const effectiveSlicePlateScope: SlicePlateScope = singlePlate ? 'current_plate' : slicePlateScope;
  /** The models the slice covers: one plate's, or every visible one. */
  const plateModelIdSet = useMemo(
    () => (activePlateSliceScope ? new Set(activePlateSliceScope.modelIds) : null),
    [activePlateSliceScope],
  );
  const scopedModels = useMemo(
    () => (plateModelIdSet ? models.filter((model) => plateModelIdSet.has(model.id)) : models),
    [models, plateModelIdSet],
  );
  const visibleModels = useMemo(
    () => scopedModels.filter((model) => model.visible && !excludedModelIdSet.has(model.id)),
    [excludedModelIdSet, scopedModels],
  );
  const excludedVisibleModelCount = useMemo(
    () => scopedModels.filter((model) => model.visible && excludedModelIdSet.has(model.id)).length,
    [excludedModelIdSet, scopedModels],
  );
  const requestOutOfBoundsSliceConfirmation = useCallback(() => new Promise<boolean>((resolve) => {
    outOfBoundsWarningResolveRef.current?.(false);
    outOfBoundsWarningResolveRef.current = resolve;
    setShowOutOfBoundsWarningModal(true);
  }), []);
  const settleOutOfBoundsSliceConfirmation = useCallback((proceed: boolean) => {
    const resolve = outOfBoundsWarningResolveRef.current;
    outOfBoundsWarningResolveRef.current = null;
    setShowOutOfBoundsWarningModal(false);
    resolve?.(proceed);
  }, []);
  useEffect(() => () => {
    outOfBoundsWarningResolveRef.current?.(false);
    outOfBoundsWarningResolveRef.current = null;
  }, []);
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
  // A slice is a plate's output, so it is named for the plate: its own name, or — in a
  // one-bed scene whose bed has no name — the first model standing on it, which is the
  // convention the export panel follows too. A scene with no plates falls back to the model.
  const sliceFilenameBase = useMemo(() => {
    const scope = plateSliceScopes?.[activePlateSliceIndex] ?? plateSliceScopes?.[0];
    if (!scope) return resolveSliceFilenameBase(visibleModels, activeModel);
    const scopeModelIdSet = new Set(scope.modelIds);
    return resolvePlateOutputBaseName({
      plateName: scope.plateName,
      plateNumberLabel: plateNumberPlaceholder(activePlateSliceIndex + 1, _),
      singlePlate,
      plateModels: models.filter((model) => scopeModelIdSet.has(model.id)),
    });
  }, [_, activeModel, activePlateSliceIndex, models, plateSliceScopes, visibleModels]);

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

  const sliceAntiAliasing = useMemo(() => resolveSliceAntiAliasing({
    printerProfile: activePrinterProfile,
    materialProfile: materialProfileForSlicing,
    override: sessionAaOverrideDraft,
    preset: aaAutoPreset,
    layerHeightMm: effectiveLayerHeightMm,
    lutCurves: savedCurves,
  }), [
    aaAutoPreset,
    activePrinterProfile,
    effectiveLayerHeightMm,
    materialProfileForSlicing,
    savedCurves,
    sessionAaOverrideDraft,
  ]);
  const effectiveAutoAaConfig = sliceAntiAliasing.decision.autoConfig;

  const materialAaOverrideEnabled = sliceAntiAliasing.decision.overrideEnabled;
  useEffect(() => {
    if (!materialAaOverrideEnabled) return;
    setAaQualityMode('expert');
  }, [materialAaOverrideEnabled]);

  const duplicateZSupportedAtCurrentAa = sliceAntiAliasing.decision.duplicateZSupported;
  const advancedSampleCountLabel = aaMode === '3DAA' ? '3DAA Sample Count' : 'XY Sample Count';
  const advancedSampleCountHelp = aaMode === '3DAA'
    ? 'Controls how many raster samples each layer uses before resolving the final grayscale. In 3DAA these samples are distributed through the layer height using perturbation, so higher values improve shallow slopes and edge stability but cost more slicing time.'
    : 'Controls supersampling for the layer-local XY edge-smoothing pass. Higher levels preserve finer edge detail but cost more slicing time.';
  const advancedBlurWidthLabel = 'XY Blur Radius';
  const advancedBlurWidthHelp = aaMode === '3DAA'
    ? 'Controls the final in-plane XY blur radius that softens perturbation output after sampling. Higher values smooth edges more, but can soften tiny features.'
    : 'Controls XY blur radius in pixels. Higher values create smoother transitions but can soften fine details.';
  const autoAaSummarySampleLabel = effectiveAutoAaConfig.aaMode === 'Off'
    ? _(msg`No AA`)
    : effectiveAutoAaConfig.antiAliasingMode === 'Blur'
      ? _(msg`Binary Base`)
    : effectiveAutoAaConfig.aaMode === '3DAA'
      ? formatZaaSamplesLabel(_, effectiveAutoAaConfig.aaSteps)
      : formatCoverageSamplesLabel(_, effectiveAutoAaConfig.aaSteps);
  const autoAaSummaryBlurLabel = effectiveAutoAaConfig.aaMode === 'Off'
    ? _(msg`No Edge Blur`)
    : effectiveAutoAaConfig.antiAliasingMode === 'Coverage'
      ? _(msg`No Edge Blur`)
      : effectiveAutoAaConfig.aaMode === '3DAA'
        ? formatXyAndZBlurLabel(_, effectiveAutoAaConfig.blurBrushRadiusPx, effectiveAutoAaConfig.zBlurRadiusLayers)
        : formatEdgeBlurLabel(_, effectiveAutoAaConfig.blurBrushRadiusPx);
  const autoAaSummaryKernelLabel = effectiveAutoAaConfig.aaMode === '3DAA'
    ? '3DAA'
    : effectiveAutoAaConfig.antiAliasingMode === 'Coverage'
      ? _(msg`Coverage`)
      : _(msg`2D Blur`);
  const autoAaSummaryGrayLabel = effectiveAutoAaConfig.aaMode === 'Off'
    ? _(msg`No Gray Map`)
    : formatLutCurveSummaryLabel(_, autoLutCurveLabel);
  const effectiveBlurGraySourceMode = materialAaOverrideEnabled
    ? profileAntiAliasingSettings.blurGraySourceMode
    : 'lut';
  const blurUsesLutCurve = (aaMode === 'Blur' || aaMode === '3DAA') && effectiveBlurGraySourceMode === 'lut';

  const minimumAaProfileSupport = sliceAntiAliasing.decision.minimumAaAlpha;

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

  const setAaOnSupportsEnabled = useCallback((enabled: boolean) => {
    saveSlicingPerformanceSettings({
      ...getSavedSlicingPerformanceSettings(),
      aaOnSupportsExperimental: enabled,
    });
  }, []);

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
      if (isLoadingRemoteMaterial) return _(msg`Loading remote material…`);
      const remoteSourceName = networkUiAdapter?.displayName ?? _(msg`Remote`);
      if (selectedRemoteMaterialName) return formatRemoteMaterialLabel(_, selectedRemoteMaterialName, remoteSourceName);
      const fromConnection = activePrinterProfile?.networkConnection?.selectedMaterialName?.trim();
      if (fromConnection) return formatRemoteMaterialLabel(_, fromConnection, remoteSourceName);
      return formatRemoteMaterialIdLabel(_, selectedRemoteMaterialId);
    }

    return resolveCompositeMaterialLabel(effectiveMaterialProfile) ?? effectiveMaterialProfile?.name ?? _(msg`No material selected`);
  }, [
    _,
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

  const handleSliceZipExport = async (
    scopeOverride?: PlateSliceScope,
    /**
     * Set by the batch: the folder it already picked for every plate's file, so the run does
     * not ask for a destination per bed, and the collected artifacts it hands over itself once
     * the whole batch is done — a switch to the printing workspace mid-batch aborts the run
     * that is still in flight.
     */
    batch?: {
      destinationDirectory: string;
      completed: Array<{
        artifact: SliceExportArtifact;
        plateId?: string;
        totalLayers: number;
        /** Where the run wrote it, so the plate is not saved again on the way past. */
        savedPath?: string;
      }>;
    },
  ): Promise<boolean> => {
    // A batch passes each plate's scope in turn; a plain run uses the active one.
    const scope = scopeOverride ?? activePlateSliceScope;
    const scopeModelIdSet = scope ? new Set(scope.modelIds) : null;
    const scopeModels = scopeModelIdSet
      ? models.filter((model) => scopeModelIdSet.has(model.id))
      : models;
    const scopeFilenameBase = scope
      ? resolvePlateOutputBaseName({
          plateName: scope.plateName,
          plateNumberLabel: plateNumberPlaceholder((plateSliceScopes?.indexOf(scope) ?? 0) + 1, _),
          singlePlate,
          plateModels: scopeModels,
        })
      : null;
    if (!activePrinterProfile) {
      alert(_(msg`Select a printer profile first.`));
      return false;
    }

    if (!materialProfileForSlicing) {
      alert(_(msg`Select a material profile first.`));
      return false;
    }

    if (visibleModels.length === 0) {
      alert(excludedVisibleModelCount > 0
        ? _(msg`All visible models are outside the build volume.`)
        : _(msg`No visible models available for slicing.`));
      return false;
    }

    if (excludedVisibleModelCount > 0 && !(await requestOutOfBoundsSliceConfirmation())) return false;

    // A batch writes files into the folder it picked: the intent menus are the single-plate
    // flow's, and none of them means "all of them at once".
    const intentForRun: SliceIntent = batch ? 'file' : effectiveSliceIntent;

    const proceed = await Promise.resolve(
      onBeforeSliceStart?.(
        intentForRun,
        batch ? { destinationDirectory: batch.destinationDirectory, baseName: scopeFilenameBase ?? undefined } : undefined,
      ) ?? true,
    ).catch(() => false);
    if (!proceed) {
      return false;
    }

    const resolvedOutputPath = (resolveOutputPathForIntent?.(intentForRun) ?? '').trim();

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
    onSliceRunStarted?.(scope ? { plateId: scope.plateId } : undefined);

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

      // A plate's file is named for the plate, beside the chosen path; a plain
      // run keeps the name and destination it always had.
      const outputBaseName = scopeFilenameBase ?? (sliceFilenameBase || activePrinterProfile.name || 'slice_export');
      const scopeOutputPath = scopeFilenameBase
        ? derivePlateOutputPath(resolvedOutputPath, scopeFilenameBase)
        : null;

      const result = await runSliceExportOrchestrator({
        models: scopeModels,
        excludedModelIds,
        ...(scope
          ? {
              plateVolumeBoundsMm: scope.volumeBoundsMm,
              plateOffsetMm: scope.offsetMm,
            }
          : {}),
        printerProfile: activePrinterProfile,
        materialProfile: materialProfileForSlicing,
        filenameBase: outputBaseName,
        outputPath: (scopeOutputPath ?? resolvedOutputPath).trim().length > 0
          ? (scopeOutputPath ?? resolvedOutputPath)
          : null,
        antiAliasing: {
          preset: aaAutoPreset,
          override: sessionAaOverrideDraft,
          lutCurves: savedCurves,
        },
        ditherEnabled: effectiveDitherEnabledForSlice,
        ditherBitDepth: effectiveDitherBitDepthForSlice,
        ditherDeviceGamma: effectiveDitherDeviceGammaForSlice,

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
      // A batch reaches "finished" once, at the end: one plate of several is not the run's end,
      // and the modal would otherwise announce every plate but the last.
      if (!batch) setSlicingModalStage('finished');
      slicingSucceeded = true;
      if (result.artifact) {
        if (batch) {
          const plateTotalLayers = Math.max(
            1,
            completedTotalLayers,
            completedTotalLayersFromResult,
            result.benchmark.totalLayers ?? 0,
          );
          batch.completed.push({
            artifact: result.artifact,
            ...(scope ? { plateId: scope.plateId } : {}),
            ...(result.artifact.nativeTempPath ? { savedPath: result.artifact.nativeTempPath } : {}),
            totalLayers: plateTotalLayers,
          });
          onSlicePlateSliced?.(result.artifact, {
            ...(scope ? { plateId: scope.plateId } : {}),
            ...(result.artifact.nativeTempPath ? { savedPath: result.artifact.nativeTempPath } : {}),
            totalLayers: plateTotalLayers,
          });
        } else {
          onSliceArtifactReady?.(result.artifact, scope ? { plateId: scope.plateId } : undefined);
        }
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
      // Handed on for a plain run only: the batch hands its plates over when it is done, which
      // is also when the app switches to the printing workspace.
      if (slicingSucceeded && !batch) {
        setCurrentPhase('Opening');
        setSliceStatus('Opening');
        onSlicingFinished?.({ totalLayers: Math.max(completedTotalLayers, completedTotalLayersFromResult, 1) });
      }
    }

    return slicingSucceeded;
  };

  /**
   * Slice every plate in turn, one file each, named for the plate. Sequential
   * rather than concurrent: each run drives the same native pipeline and the same
   * progress surface, and a batch that stops on the first failure leaves the
   * plates it did write intact.
   */
  const handleSliceAllPlates = async () => {
    // The beds that hold something, in cascade order. An empty bed has no file of its own, and
    // asking for one would stop the batch on a bed there is nothing to slice.
    if (populatedPlateScopes.length < 2) return;

    // One folder for the run, the way a per-plate export picks one: the plates are sliced one
    // after another into it, each file named for its plate, and nothing asks again.
    const destinationDirectory = (await pickDirectoryWithNativeDialog()).trim();
    if (!destinationDirectory) return;

    const completed: Array<{
      artifact: SliceExportArtifact;
      plateId?: string;
      totalLayers: number;
      savedPath?: string;
    }> = [];
    for (const scope of populatedPlateScopes) {
      const sliced = await handleSliceZipExport(scope, { destinationDirectory, completed });
      if (!sliced) break;
    }

    // The batch's own end. Every plate reached "Ready" on its own; this is what the modal waits
    // for, and what the plates handed over below walk the app into the printing workspace with.
    setCurrentPhase('Ready');
    setSliceStatus(formatSlicedPlatesStatus(_, completed.length));
    setSlicingModalStage('finished');

    // The plates are handed over once the batch is done. The first of them is what walks the
    // app into the printing workspace; doing that per bed would abort the run that follows.
    for (const entry of completed) {
      onSliceArtifactReady?.(entry.artifact, {
        ...(entry.plateId ? { plateId: entry.plateId } : {}),
        ...(entry.savedPath ? { savedPath: entry.savedPath } : {}),
        savedDirectory: destinationDirectory,
        totalLayers: entry.totalLayers,
      });
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
              <PanelCollapseToggle expanded={isExpanded} onToggle={() => setIsExpanded((prev) => !prev)} />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}><Trans>Slicing</Trans></h3>
            </>
          )}
        />
        {isExpanded && (
          <div className="px-3 pb-3 text-xs" style={{ color: 'var(--text-muted)' }}>
            <Trans>No meshes loaded yet. Import a model first, then return to Slicing.</Trans>
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
            <PanelCollapseToggle expanded={isExpanded} onToggle={() => setIsExpanded((prev) => !prev)} />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}><Trans>Slicing</Trans></h3>
          </>
        )}
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
                aria-label={_(msg`Edit printer profile`)}
                title={_(msg`Open printer profiles`)}
              >
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Printer</Trans></div>
                <div className="text-sm font-semibold break-words" style={{ color: 'var(--text-strong)' }} title={activePrinterProfile?.name ?? _(msg`No printer selected`)}>
                  {activePrinterProfile?.name ?? _(msg`No printer selected`)}
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
                aria-label={_(msg`Edit material profile`)}
                title={_(msg`Open material profiles`)}
              >
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Material</Trans></div>
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
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Layers</Trans></div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedLayerCount > 0 ? estimatedLayerCount : '—'}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Layer Height</Trans></div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {effectiveLayerHeightMm != null ? `${effectiveLayerHeightMm.toFixed(3)} mm` : '—'}
                </div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Est. Volume</Trans></div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedVolumeLabel}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Est. Print Time</Trans></div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedPrintTimeLabel}</div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Output</Trans></div>
                <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                  {selectedFormat?.displayName ?? selectedFormat?.outputFormat ?? '—'}
                </div>
              </div>
              <div className="rounded border px-1.5 py-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Engine</Trans></div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {slicerEngineVersion ? `v${slicerEngineVersion}` : 'Slicer V3'}
                </div>
              </div>
            </div>

            {showRemoteOfflineLayerHeightOverride && (
              <div className="mt-2 rounded-md border p-2 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="space-y-0.5 text-center">
                  <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>
                    <Trans>Offline Layer Height</Trans>
                  </div>
                  <div className="text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    <Trans>Remote material unavailable.</Trans>
                  </div>
                </div>

                <ScrollableNumberField
                  value={remoteOfflineLayerHeightMm * MICRONS_PER_MM}
                  onChange={(nextMicrons) => setClampedRemoteOfflineLayerHeightMm(nextMicrons / MICRONS_PER_MM)}
                  min={REMOTE_OFFLINE_LAYER_HEIGHT_MIN_MM * MICRONS_PER_MM}
                  max={REMOTE_OFFLINE_LAYER_HEIGHT_MAX_MM * MICRONS_PER_MM}
                  step={REMOTE_OFFLINE_LAYER_HEIGHT_STEP_MM * MICRONS_PER_MM}
                  unit="µm"
                  ariaLabel={_(msg`Offline layer height override in micrometers`)}
                  decreaseTitle={_(msg`Decrease offline layer height`)}
                  increaseTitle={_(msg`Increase offline layer height`)}
                  commitOnBlur
                />

                <div className="text-[11px] leading-snug text-center" style={{ color: 'var(--text-muted)' }}>
                  <Trans>Network unavailable.</Trans> <br />
                  <Trans>Select a matching material during import instead.</Trans>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-md border p-2 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="space-y-1">
              {antiAliasingAvailable ? (
                <>
                  <SettingLabelWithHelp
                    label={_(msg`Anti-Aliasing`)}
                    help={_(msg`Auto derives slice settings from your printer resolution and material layer height. Expert lets you jump to material AA settings or apply a temporary session override.`)}
                  />
                  <div className="grid grid-cols-2 gap-1.5">
                    {(['auto', 'expert'] as const).map((qmode) => {
                      const qActive = aaQualityMode === qmode;
                      const label = qmode === 'auto' ? _(msg`Auto`) : _(msg`Expert`);
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
                              <div className="text-xs font-semibold leading-tight">{_(label)}</div>
                              <div className="mt-0.5 text-[10px] leading-tight" style={{ color: pActive ? 'color-mix(in srgb, var(--accent-secondary-action-color), var(--text-muted) 38%)' : 'var(--text-muted)' }}>
                                {_(desc)}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <div className="h-1.5" />
                      <div
                        className="grid grid-cols-2 overflow-hidden rounded"
                        style={{
                          background: 'color-mix(in srgb, var(--surface-0), var(--surface-1) 42%)',
                          boxShadow: 'inset 0 0 0 1px var(--border-subtle)',
                        }}
                      >
                        {([
                          [_(msg`Mode`), autoAaSummaryKernelLabel],
                          [_(msg`Samples`), autoAaSummarySampleLabel],
                          [_(msg`Blur`), autoAaSummaryBlurLabel],
                          [_(msg`Grey`), autoAaSummaryGrayLabel],
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
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{label}</div>
                            <div className="truncate text-xs font-semibold">{value}</div>
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
                            <span className="text-[11px] font-semibold leading-tight"><Trans>Material Profile Settings</Trans></span>
                            <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: sessionAaOverrideEnabled ? 'var(--text-muted)' : materialProfileAaOverrideEnabled ? 'color-mix(in srgb, var(--accent-secondary-action-color), var(--text-muted) 38%)' : 'var(--text-muted)' }}>
                              {sessionAaOverrideEnabled ? <Trans>Bypassed</Trans> : materialProfileAaOverrideEnabled ? <Trans>Override On</Trans> : <Trans>Edit</Trans>}
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
                            <span className="text-[11px] font-semibold leading-tight"><Trans>Session Overrides</Trans></span>
                            <span className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: sessionAaOverrideEnabled ? 'color-mix(in srgb, var(--accent-secondary-action-color), var(--text-muted) 38%)' : 'var(--text-muted)' }}>
                              {sessionAaOverrideEnabled ? <Trans>Active</Trans> : <Trans>Temporary</Trans>}
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
                            <Trans>Clear Session Override</Trans>
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
                  <Trans>The selected Machine does not support AA at this time.</Trans>
                </div>
              )}
            </div>
          </div>

          {/* Which plates the slice covers: one file for the bed being worked on, or a zip
              with one file per bed. Only worth offering when more than one bed holds
              something — an empty bed is not a choice. */}
          {!singlePlate && (
            <div
              className="rounded-md border p-2"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
            >
              <div role="group" aria-label={_(msg`Slice plates`)} className="grid grid-cols-2 gap-1.5">
                {SLICE_PLATE_SCOPE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={slicePlateScope === option.value}
                    className="rounded border px-2 py-1.5 text-center text-xs font-semibold transition-colors"
                    style={slicePlateScope === option.value ? activeSliceScopeStyle : idleSliceScopeStyle}
                    onClick={() => setSlicePlateScope(option.value)}
                  >
                    {_(option.label)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Slice intent split-button */}
          {(() => {
            const isDisabled = isSlicingZip || !activePrinterProfile || !materialProfileForSlicing || models.length === 0;
            type IconType = React.FC<{ className?: string }>;
            const intentOptions: { key: SliceIntent; label: string; Icon: IconType; enabled: boolean; menuOnly?: boolean }[] = [
              { key: 'file',    label: _(msg`Slice to File`),   Icon: Download as IconType, enabled: true },
              { key: 'upload',  label: _(msg`Slice & Upload`),  Icon: Printer  as IconType, enabled: canUpload },
              { key: 'print',   label: _(msg`Slice & Print`),   Icon: Play     as IconType, enabled: canPrint },
              { key: 'uvtools', label: _(msg`Send to UVTools`), Icon: ExternalLink as IconType, enabled: canUvTools },
              { key: 'preview', label: _(msg`Just Slice`),      Icon: Cpu      as IconType, enabled: true, menuOnly: true },
            ];
            const current = intentOptions.find((o) => o.key === effectiveSliceIntent) ?? intentOptions[0]!;
            const CurrentIcon = current.Icon;
            const hasMenuOptions = canUpload || canPrint || canUvTools;
            return (
              <div ref={sliceIntentAnchorRef} className="relative w-full">
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="primary"
                    size="auto"
                    onClick={() => {
                      void (effectiveSlicePlateScope === 'all_plates'
                        ? handleSliceAllPlates()
                        : handleSliceZipExport());
                    }}
                    disabled={isDisabled}
                    className={`flex-1 !h-9 text-sm inline-flex items-center justify-center gap-1.5 ${hasMenuOptions && !isShiftHeld && effectiveSlicePlateScope === 'current_plate' ? 'rounded-r-none' : ''} ${isSlicingZip ? 'cursor-wait opacity-70' : ''}`}
                  >
                    {effectiveSlicePlateScope === 'all_plates'
                      ? <Layers3 className="w-4 h-4 shrink-0" />
                      : <CurrentIcon className="w-4 h-4 shrink-0" />}
                    {isSlicingZip
                      ? _(msg`Slicing…`)
                      : (effectiveSlicePlateScope === 'all_plates' ? _(msg`Slice All`) : current.label)}
                  </Button>
                  {hasMenuOptions && !isShiftHeld && effectiveSlicePlateScope === 'current_plate' && (
                    <Button
                      variant="primary"
                      size="auto"
                      onClick={() => {
                        const rect = sliceIntentAnchorRef.current?.getBoundingClientRect() ?? null;
                        setSliceIntentMenuRect(rect);
                        setSliceIntentMenuOpen((v) => !v);
                      }}
                      disabled={isDisabled}
                      aria-label={_(msg`Choose slice action`)}
                      className="!h-9 w-10 shrink-0 inline-flex items-center justify-center rounded-l-none border-l border-black/15"
                    >
                      <ChevronDown
                        className={`h-6 w-6 transition-transform duration-200 ease-out ${sliceIntentMenuOpen ? 'rotate-180' : 'rotate-0'}`}
                      />
                    </Button>
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
            aria-label={_(msg`Material anti-aliasing settings`)}
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  <Trans>Material Anti-Aliasing Settings</Trans>
                </h2>
                <p className="ui-meta truncate">
                  {activeMaterialProfile.name} · {activeMaterialProfile.brand}
                </p>
              </div>
              <IconButton
                variant="surface"
                size="sm"
                onClick={() => setIsMaterialAaEditorOpen(false)}
                aria-label={_(msg`Close material anti-aliasing settings`)}
              >
                <X className="w-4 h-4" />
              </IconButton>
            </div>
            <div className="p-3 overflow-y-auto custom-scrollbar flex-1">
              <MaterialAntiAliasingSection
                draft={materialAaEditorDraft}
                printerDitherBitDepth={printerDitherBitDepth}
                printerPanelBitDepth={printerPanelBitDepth}
                onChange={(next) => {
                  setMaterialAaEditorDraft((current) => {
                    if (!current) return current;
                    return typeof next === 'function' ? next(current) : next;
                  });
                }}
              />
            </div>
            <div className="px-2 py-2 border-t flex items-center justify-end gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <Button
                variant="secondary"
                size="auto"
                onClick={() => setIsMaterialAaEditorOpen(false)}
                className="!h-8 !px-3 !py-0 text-xs rounded-full"
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="auto"
                onClick={handleSaveMaterialAaEditor}
                className="!h-8 !px-3 !py-0 text-xs rounded-full"
                style={{
                  borderColor: 'var(--accent-secondary-action-border)',
                  background: 'var(--accent-secondary-action-bg-92)',
                  color: 'var(--accent-secondary-action-color)',
                }}
              >
                <Trans>Save Material</Trans>
              </Button>
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
            aria-label={_(msg`Session anti-aliasing override`)}
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  <Trans>Session Anti-Aliasing Override</Trans>
                </h2>
                <p className="ui-meta truncate">
                  {activeMaterialProfile ? `${activeMaterialProfile.name} · ${activeMaterialProfile.brand}` : _(msg`Current material`)}
                </p>
              </div>
              <IconButton
                variant="surface"
                size="sm"
                onClick={() => setIsSessionAaOverrideOpen(false)}
                aria-label={_(msg`Close session anti-aliasing override`)}
              >
                <X className="w-4 h-4" />
              </IconButton>
            </div>
            <div className="p-3 overflow-y-auto custom-scrollbar flex-1">
              <MaterialAntiAliasingSection
                draft={editingSessionAaOverrideDraft}
                lockActivationToggles
                printerDitherBitDepth={printerDitherBitDepth}
                printerPanelBitDepth={printerPanelBitDepth}
                onChange={(next) => {
                  setEditingSessionAaOverrideDraft((current) => {
                    if (!current) return current;
                    return typeof next === 'function' ? next(current) : next;
                  });
                }}
              />
            </div>
            <div className="px-2 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
              <Button
                variant="secondary"
                size="auto"
                onClick={() => {
                  if (activeMaterialProfile) {
                    clearSessionAaOverrideDraft(activeMaterialProfile.id);
                  }
                  setSessionAaOverrideDraft(null);
                  setEditingSessionAaOverrideDraft(null);
                  setIsSessionAaOverrideOpen(false);
                }}
                className="!h-8 !px-3 !py-0 text-xs rounded-full"
                style={{ color: 'var(--text-muted)' }}
              >
                <Trans>Clear Override</Trans>
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="auto"
                  onClick={() => setIsSessionAaOverrideOpen(false)}
                  className="!h-8 !px-3 !py-0 text-xs rounded-full"
                >
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  size="auto"
                  onClick={() => {
                    if (activeMaterialProfile) {
                      writeSessionAaOverrideDraft(activeMaterialProfile.id, editingSessionAaOverrideDraft);
                    }
                    setSessionAaOverrideDraft(editingSessionAaOverrideDraft);
                    setIsSessionAaOverrideOpen(false);
                  }}
                  className="!h-8 !px-3 !py-0 text-xs rounded-full"
                  style={{
                    borderColor: 'var(--accent-secondary-action-border)',
                    background: 'var(--accent-secondary-action-bg-92)',
                    color: 'var(--accent-secondary-action-color)',
                  }}
                >
                  <Trans>Apply for Session</Trans>
                </Button>
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
            aria-label={_(msg`Slicing progress`)}
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
                    <Trans>Background Pipeline</Trans>
                  </div>
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                    <Trans>Slicing Plate</Trans>
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
                  ? <Trans>Running</Trans>
                  : slicingModalStage === 'finished'
                    ? <Trans>Ready</Trans>
                    : slicingModalStage === 'cancelled'
                      ? <Trans>Cancelled</Trans>
                    : <Trans>Failed</Trans>}
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}><Trans>Pipeline Stage</Trans></div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={formatSlicingPhaseLabel(_, currentPhase)}>{formatSlicingPhaseLabel(_, currentPhase)}</div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{progressCounterLabel}</div>
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>
                    {progressCounterValue}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}><Trans>Progress</Trans></div>
                  <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{progressPercentLabel}%</div>
                </div>
                {slicingModalStage === 'running' && liveLayersPerSec != null && (
                  <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}><Trans>Speed</Trans></div>
                    <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--text-strong)' }}>{formatLayerRate(_, liveLayersPerSec)}</div>
                  </div>
                )}
              </div>

              {slicingModalStage === 'finished' && previewTotalLayers > 0 && (
                <div className="rounded-lg border p-2.5 space-y-1.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    <Trans>Plate preview · Layer {previewSelectedLayer}/{previewTotalLayers}</Trans>
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
                      alt={formatLayerPreviewAlt(_, previewSelectedLayer)}
                      className="w-full h-36 rounded object-contain"
                    />
                  ) : (
                    <div className="h-36 rounded border border-dashed flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                      <Trans>Preview for this layer is not available.</Trans>
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
                  <span><Trans>Elapsed {slicingElapsedLabel}</Trans></span>
                </div>

                <div className="flex items-center gap-2">
                  {slicingModalStage === 'running' && (
                    <Button
                      variant="secondary"
                      className="!h-9 text-xs"
                      disabled={!canCancelSlicing}
                      onClick={handleCancelSlicing}
                    >
                      {canCancelSlicing ? <Trans>Cancel Slicing</Trans> : <Trans>Finishing…</Trans>}
                    </Button>
                  )}
                  {slicingModalStage !== 'running' && (
                    <Button
                      variant="secondary"
                      className="!h-9 text-xs"
                      onClick={handleCloseSlicingModal}
                    >
                      <Trans>Close Plate</Trans>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      <StructuredDialogModal
        open={showOutOfBoundsWarningModal}
        ariaLabel="Out-of-bounds models will be excluded"
        title={<Trans>Models Outside Build Volume</Trans>}
        subtitle={<Trans>Only printable models will be sliced</Trans>}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        zIndexClassName="z-[130]"
        closeAriaLabel="Close modal"
        onClose={() => settleOutOfBoundsSliceConfirmation(false)}
        onBackdropClick={() => settleOutOfBoundsSliceConfirmation(false)}
        actions={(
          <>
            <Button
              variant="secondary"
              className="!h-9 text-xs"
              onClick={() => settleOutOfBoundsSliceConfirmation(false)}
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              className="!h-9 text-xs"
              onClick={() => settleOutOfBoundsSliceConfirmation(true)}
            >
              <Trans>Slice Printable Models</Trans>
            </Button>
          </>
        )}
      >
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {excludedVisibleModelCount === 1 ? (
            <Trans>One visible model outside the build volume will be excluded from this slice.</Trans>
          ) : (
            <Trans comment="{excludedVisibleModelCount} is always 2 or more; the singular case is its own message.">
              <strong style={{ color: 'var(--text-strong)' }}>{excludedVisibleModelCount}</strong> visible models outside the build volume will be excluded from this slice.
            </Trans>
          )}
        </p>
      </StructuredDialogModal>

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
