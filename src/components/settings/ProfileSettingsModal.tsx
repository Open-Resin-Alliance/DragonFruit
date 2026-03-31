'use client';

import React from 'react';
import { AlertTriangle, Box, CarFront, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Edit3, FlaskConical, ImagePlus, LayoutGrid, Loader2, Lock, Plus, Printer, RefreshCw, Search, Snail, Trash2, Upload, Wifi, WifiOff, X } from 'lucide-react';
import FleetManagement from '@/components/settings/FleetManagement';
import { NumberInput } from '@/components/ui/NumberInput';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import {
  applyOfficialMaterialProfileUpdate,
  applyOfficialPrinterProfileUpdate,
  addMaterialProfile,
  addPrinterProfileFromPreset,
  disconnectPrinterNetworkDevice,
  duplicatePrinterProfileAsCustom,
  getActivePrinterProfile,
  getAvailablePrinterPresets,
  getOfficialMaterialProfileUpdates,
  getOfficialPrinterProfileUpdates,
  getMaterialProfilesForPrinter,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  importPrinterBundle,
  removePrinterNetworkDevice,
  removeMaterialProfile,
  removePrinterProfile,
  movePrinterProfile,
  setActiveMaterialProfile,
  setActivePrinterProfile,
  selectPrinterNetworkDevice,
  subscribeToProfileStore,
  upsertPrinterNetworkDevice,
  updateMaterialProfile,
  updatePrinterNetworkConnectionStatus,
  updatePrinterNetworkSettings,
  updatePrinterProfile,
  type MaterialProfile,
  type PrinterNetworkDevice,
  type PrinterOutputFormat,
  type PrinterProfile,
} from '@/features/profiles/profileStore';
import {
  getAvailableProfileNetworkModes,
  getDefaultProfileNetworkUiAdapter,
  getProfileLocalMaterialSettingsAdapter,
  getProfileNetworkUiAdapter,
} from '@/features/plugins/pluginRegistry';
import {
  getAvailableOutputFormatOptions,
  getAvailableFormatVersionOptions,
  getAvailableSettingsModeOptions,
  resolveOutputFormatVersion,
  resolveOutputSettingsMode,
} from '@/features/slicing/formats/registry';
import {
  getPrinterReachabilityServerSnapshot,
  getPrinterReachabilitySnapshot,
  subscribeToPrinterReachability,
} from '@/features/network/printerReachabilityStore';
import {
  pickOpenFilesWithNativeDialog,
  readPrintArtifactBytesFromPath,
  savePrintArtifactWithNativeDialog,
} from '@/features/slicing/tauri/nativeSlicerBridge';
import {
  buildAdvancedRemoteMaterialSections,
  buildBasicRemoteMaterialSections,
  buildRemoteMaterialChips,
  buildSortedRemoteMaterialDraftEntries,
  formatRemoteMaterialFieldLabel,
  isLikelyNumericRemoteMaterialField,
  type RemoteMaterialEditDraft,
  type RemoteMaterialProfile,
} from '@/features/plugins/remoteMaterialUiUtils';
import { pluginNetworkFetch } from '@/utils/pluginNetworkBridge';

type ProfileSettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'printer' | 'material';
  openPrinterLibraryToken?: number;
  openNetworkSettingsToken?: number;
};

type DeleteConfirmTarget =
  | { kind: 'printer'; id: string; name: string }
  | { kind: 'material'; id: string; name: string };

type MaterialDraft = Omit<MaterialProfile, 'id' | 'printerProfileId'>;
type LocalSettingsByOutputDraft = NonNullable<MaterialProfile['localSettingsByOutput']>;

const OUTPUT_FORMAT_OPTIONS = getAvailableOutputFormatOptions();

const RESIN_FAMILY_OPTIONS: Array<{ value: MaterialProfile['resinFamily']; label: string }> = [
  { value: 'standard', label: 'Standard' },
  { value: 'abs-like', label: 'ABS-like' },
  { value: 'tough', label: 'Tough' },
  { value: 'flexible', label: 'Flexible' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'other', label: 'Other' },
];

const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY'];

type PluginNumericFieldSchema = {
  kind: 'number' | 'integer';
  min?: number;
  max?: number;
  defaultValue: number;
};

function clampNonNegativeNumber(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function sanitizePluginNumericValue(field: PluginNumericFieldSchema, value: number): number {
  let next = clampNonNegativeNumber(value);
  if (field.kind === 'integer') next = Math.round(next);

  const minimum = Math.max(0, field.min ?? 0);
  next = Math.max(minimum, next);

  if (field.max != null) next = Math.min(field.max, next);
  return next;
}

function isSlowFastPair(firstTag?: string, secondTag?: string): boolean {
  const first = typeof firstTag === 'string' ? firstTag.trim().toLowerCase() : '';
  const second = typeof secondTag === 'string' ? secondTag.trim().toLowerCase() : '';
  return (first === 'slow' && second === 'fast') || (first === 'fast' && second === 'slow');
}

function resolveFieldTagTone(tag?: string): { icon: typeof CarFront | typeof Snail; fallbackColor: string } | null {
  const normalized = typeof tag === 'string' ? tag.trim().toLowerCase() : '';
  if (!normalized) return null;

  if (normalized === 'slow') {
    return { icon: Snail, fallbackColor: '#f59e0b' };
  }

  return { icon: CarFront, fallbackColor: '#22c55e' };
}

type FieldTagChipProps = {
  tag?: string;
  color?: string;
  compact?: boolean;
};

function FieldTagChip({ tag, color, compact = false }: FieldTagChipProps) {
  const trimmedTag = typeof tag === 'string' ? tag.trim() : '';
  const tone = resolveFieldTagTone(trimmedTag);
  if (!trimmedTag || !tone) return null;

  const accent = (typeof color === 'string' && color.trim().length > 0)
    ? color.trim()
    : tone.fallbackColor;
  const Icon = tone.icon;

  return (
    <span
      className={`pointer-events-none absolute top-1/2 z-10 inline-flex -translate-y-1/2 items-center gap-1 rounded-full px-2 font-semibold uppercase tracking-wide ${compact ? 'right-8 h-5 text-[9px]' : 'right-8 h-5 text-[9px]'}`}
      style={{
        background: `color-mix(in srgb, ${accent} 18%, var(--surface-1))`,
        color: accent,
      }}
      title={trimmedTag}
      aria-hidden="true"
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{trimmedTag}</span>
    </span>
  );
}

function normalizeNetworkDiscoveryName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNetworkDiscoveryToken(value: unknown): string {
  return normalizeNetworkDiscoveryName(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeGenericNetworkDiscoveryName(
  value: unknown,
  options?: {
    modeLabel?: string;
    networkSupport?: string | null;
    printerModel?: string;
  },
): boolean {
  const normalized = normalizeNetworkDiscoveryToken(value);
  if (!normalized) return true;

  const modeLabel = normalizeNetworkDiscoveryToken(options?.modeLabel);
  const networkSupport = normalizeNetworkDiscoveryToken(options?.networkSupport);
  const printerModel = normalizeNetworkDiscoveryToken(options?.printerModel);

  const genericCandidates = new Set<string>([
    'printer',
    networkSupport,
    networkSupport ? `${networkSupport} printer` : '',
    modeLabel,
    modeLabel ? `${modeLabel} printer` : '',
    printerModel,
  ].filter((candidate) => candidate.length > 0));

  if (genericCandidates.has(normalized)) return true;

  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length <= 2 && normalized.endsWith(' printer')) return true;

  return false;
}

function resolveNetworkDiscoveryDisplayName(options: {
  printerName?: unknown;
  hostName?: unknown;
  printerModel?: unknown;
  modeLabel?: string;
  networkSupport?: string | null;
  fallbackName: string;
}): string {
  const printerName = normalizeNetworkDiscoveryName(options.printerName);
  const hostName = normalizeNetworkDiscoveryName(options.hostName);
  const printerModel = normalizeNetworkDiscoveryName(options.printerModel);

  const genericContext = {
    modeLabel: options.modeLabel,
    networkSupport: options.networkSupport,
    printerModel,
  };

  const preferredPrinterName = printerName && !looksLikeGenericNetworkDiscoveryName(printerName, genericContext)
    ? printerName
    : '';
  if (preferredPrinterName) return preferredPrinterName;

  const preferredHostName = hostName && !looksLikeGenericNetworkDiscoveryName(hostName, genericContext)
    ? hostName
    : '';
  if (preferredHostName) return preferredHostName;

  return printerName || hostName || options.fallbackName;
}

function resolveOfficialPresetIdFromProfile(profile: PrinterProfile): string | null {
  if (profile.officialPresetId && profile.officialPresetId.trim().length > 0) {
    return profile.officialPresetId.trim();
  }
  if (typeof profile.id === 'string' && profile.id.startsWith('printer-default-')) {
    return profile.id.slice('printer-default-'.length);
  }
  return null;
}

type BuildDimensionEditMode = 'manual' | 'auto';
type PrinterRailViewMode = 'profiles' | 'fleet';
type ManualBuildDimensions = {
  width: number;
  depth: number;
};

function computeBuildDimensionMm(resolutionPx: number, pixelSizeUm: number): number {
  const safeResolution = Math.max(1, Math.round(resolutionPx));
  const safePixelSize = Math.max(0.001, Number(pixelSizeUm) || 0.001);
  return Number(((safeResolution * safePixelSize) / 1000).toFixed(3));
}

function resolveDefaultLocalSettingsForOutput(
  outputFormat: string,
  settingsMode?: string,
): LocalSettingsByOutputDraft {
  const adapter = getProfileLocalMaterialSettingsAdapter(outputFormat, settingsMode);
  if (!adapter) return {};

  const normalizedOutput = outputFormat.trim().toLowerCase();
  const defaults: Record<string, string | number | boolean> = {};
  adapter.fields.forEach((field) => {
    defaults[field.key] = field.defaultValue;
  });

  return Object.keys(defaults).length > 0 ? { [normalizedOutput]: defaults } : {};
}

function mergeWithLocalSettingsDefaults(
  outputFormat: string,
  settingsMode: string | undefined,
  source?: MaterialProfile['localSettingsByOutput'],
): LocalSettingsByOutputDraft {
  const normalizedOutput = outputFormat.trim().toLowerCase();
  const existing = source && typeof source === 'object' ? source : {};
  const base: LocalSettingsByOutputDraft = Object.entries(existing).reduce<LocalSettingsByOutputDraft>((acc, [key, value]) => {
    if (!value || typeof value !== 'object') return acc;
    acc[key.trim().toLowerCase()] = { ...(value as Record<string, string | number | boolean>) };
    return acc;
  }, {});

  const adapter = getProfileLocalMaterialSettingsAdapter(normalizedOutput, settingsMode);
  if (!adapter) return base;

  const outputValues = { ...(base[normalizedOutput] ?? {}) };
  adapter.fields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(outputValues, field.key)) {
      outputValues[field.key] = field.defaultValue;
    }
  });
  base[normalizedOutput] = outputValues;

  return base;
}

export function ProfileSettingsModal({
  isOpen,
  onClose,
  initialTab = 'printer',
  openPrinterLibraryToken = 0,
  openNetworkSettingsToken = 0,
}: ProfileSettingsModalProps) {
  const logNetworkScanDebug = React.useCallback((scope: string, details: Record<string, unknown>) => {
    try {
      console.info(`[NetworkSettings][AutoScan][${scope}]`, details);
    } catch {
      // no-op
    }
  }, []);

  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const [selectedPrinterId, setSelectedPrinterId] = React.useState<string | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = React.useState<string | null>(null);
  const [selectedManufacturer, setSelectedManufacturer] = React.useState<string | null>(null);
  const [selectedResinFamily, setSelectedResinFamily] = React.useState<MaterialProfile['resinFamily'] | null>(null);
  const [isCreateMaterialOpen, setIsCreateMaterialOpen] = React.useState(false);
  const [isMaterialEditorOpen, setIsMaterialEditorOpen] = React.useState(false);
  const [materialEditorTab, setMaterialEditorTab] = React.useState<string>('meta');
  const [showOfficialLockDialog, setShowOfficialLockDialog] = React.useState(false);
  const [officialLockedProfileId, setOfficialLockedProfileId] = React.useState<string | null>(null);
  const [isNetworkSettingsOpen, setIsNetworkSettingsOpen] = React.useState(false);
  const [isAddingNetworkPrinter, setIsAddingNetworkPrinter] = React.useState(false);
  const [networkDiscoveryEnabled, setNetworkDiscoveryEnabled] = React.useState(true);
  const [networkIpAddress, setNetworkIpAddress] = React.useState('');
  const [isNetworkScanning, setIsNetworkScanning] = React.useState(false);
  const [networkScanProgressPct, setNetworkScanProgressPct] = React.useState(0);
  const [networkScanPhaseLabel, setNetworkScanPhaseLabel] = React.useState('');
  const [isNetworkConnecting, setIsNetworkConnecting] = React.useState(false);
  const [networkConnectionMessage, setNetworkConnectionMessage] = React.useState('');
  const [showManualNetworkEntry, setShowManualNetworkEntry] = React.useState(false);
  const [hasAutoScannedOnOpen, setHasAutoScannedOnOpen] = React.useState(false);
  const [discoveredPrinters, setDiscoveredPrinters] = React.useState<Array<{ id: string; name: string; ipAddress: string; status: 'online' | 'reachable' }>>([]);
  const [cachedDiscoveredPrinters, setCachedDiscoveredPrinters] = React.useState<Array<{ id: string; name: string; ipAddress: string; status: 'online' | 'reachable' }>>([]);
  const [remoteMaterials, setRemoteMaterials] = React.useState<RemoteMaterialProfile[]>([]);
  const [isLoadingRemoteMaterials, setIsLoadingRemoteMaterials] = React.useState(false);
  const [remoteMaterialsError, setRemoteMaterialsError] = React.useState<string | null>(null);
  const [selectedRemoteMaterialId, setSelectedRemoteMaterialId] = React.useState<string>('');
  const [isRemoteMaterialEditDialogOpen, setIsRemoteMaterialEditDialogOpen] = React.useState(false);
  const [remoteMaterialEditTab, setRemoteMaterialEditTab] = React.useState<'basic' | 'advanced'>('basic');
  const [isSavingRemoteMaterialEdit, setIsSavingRemoteMaterialEdit] = React.useState(false);
  const [remoteMaterialEditDraft, setRemoteMaterialEditDraft] = React.useState<RemoteMaterialEditDraft>({});
  const [deleteConfirmTarget, setDeleteConfirmTarget] = React.useState<DeleteConfirmTarget | null>(null);
  const [editMaterialDraft, setEditMaterialDraft] = React.useState<MaterialDraft>({
    name: 'Standard 405nm',
    brand: 'Default',
    currencyCode: 'USD',
    bottlePrice: 24.99,
    bottleCapacityMl: 1000,
    resinFamily: 'standard',
    scaleCompensationPct: { x: 0, y: 0, z: 0 },
    layerHeightMm: 0.05,
    normalExposureSec: 2.5,
    bottomExposureSec: 28,
    bottomLayerCount: 5,
    liftDistanceMm: 6,
    liftSpeedMmMin: 60,
    retractSpeedMmMin: 150,
    minimumAaAlphaPercent: 35,
  });
  const [newMaterialDraft, setNewMaterialDraft] = React.useState<Omit<MaterialProfile, 'id' | 'printerProfileId'>>({
    name: 'New Resin',
    brand: 'Default',
    currencyCode: 'USD',
    bottlePrice: 0,
    bottleCapacityMl: 1000,
    resinFamily: 'standard',
    scaleCompensationPct: { x: 0, y: 0, z: 0 },
    layerHeightMm: 0.05,
    normalExposureSec: 2.5,
    bottomExposureSec: 28,
    bottomLayerCount: 5,
    liftDistanceMm: 6,
    liftSpeedMmMin: 60,
    retractSpeedMmMin: 150,
    minimumAaAlphaPercent: 35,
  });
  const [editMaterialLocalSettingsByOutput, setEditMaterialLocalSettingsByOutput] = React.useState<LocalSettingsByOutputDraft>({});
  const [newMaterialLocalSettingsByOutput, setNewMaterialLocalSettingsByOutput] = React.useState<LocalSettingsByOutputDraft>({});
  const [isEditingPrinter, setIsEditingPrinter] = React.useState(false);
  const [uploadTargetPrinterId, setUploadTargetPrinterId] = React.useState<string | null>(null);
  const [showPresetPicker, setShowPresetPicker] = React.useState(false);
  const [presetSearch, setPresetSearch] = React.useState('');
  const [selectedPresetManufacturer, setSelectedPresetManufacturer] = React.useState<string>('');
  const [manualBuildDimensionsByPrinterId, setManualBuildDimensionsByPrinterId] = React.useState<Record<string, ManualBuildDimensions>>({});
  const [printerRailViewMode, setPrinterRailViewMode] = React.useState<PrinterRailViewMode>('profiles');
  const [isEditFleetUnitModalOpen, setIsEditFleetUnitModalOpen] = React.useState(false);
  const [editingFleetUnitId, setEditingFleetUnitId] = React.useState<string | null>(null);
  const [editingFleetUnitNickname, setEditingFleetUnitNickname] = React.useState('');
  const [editingFleetUnitImageDataUrl, setEditingFleetUnitImageDataUrl] = React.useState<string | null>(null);
  const [officialUpdateStatusMessage, setOfficialUpdateStatusMessage] = React.useState<string | null>(null);
  const [printerDragId, setPrinterDragId] = React.useState<string | null>(null);
  const imageUploadInputRef = React.useRef<HTMLInputElement | null>(null);
  const fleetUnitImageUploadInputRef = React.useRef<HTMLInputElement | null>(null);
  const printerReachabilityByDeviceId = React.useSyncExternalStore(
    subscribeToPrinterReachability,
    getPrinterReachabilitySnapshot,
    getPrinterReachabilityServerSnapshot,
  );

  const availablePrinterPresets = React.useMemo(() => getAvailablePrinterPresets(), [profileState]);
  const officialPrinterUpdates = React.useMemo(() => getOfficialPrinterProfileUpdates(profileState), [profileState]);
  const officialMaterialUpdates = React.useMemo(() => getOfficialMaterialProfileUpdates(profileState), [profileState]);

  const presetManufacturers = React.useMemo(() => {
    const uniq = new Set(availablePrinterPresets.map((preset) => preset.manufacturer));
    const sorted = Array.from(uniq)
      .filter(m => m.toLowerCase() !== 'generic')
      .sort((a, b) => a.localeCompare(b));
    const generic = Array.from(uniq).filter(m => m.toLowerCase() === 'generic');
    return [...sorted, ...generic];
  }, [availablePrinterPresets]);

  const filteredPrinterPresets = React.useMemo(() => {
    const search = presetSearch.trim().toLowerCase();
    return availablePrinterPresets.filter((preset) => {
      const manufacturerMatch = search.length > 0 || preset.manufacturer === selectedPresetManufacturer;
      const searchMatch =
        search.length === 0
        || preset.name.toLowerCase().includes(search)
        || preset.manufacturer.toLowerCase().includes(search)
        || (preset.family ?? '').toLowerCase().includes(search);
      return manufacturerMatch && searchMatch;
    });
  }, [availablePrinterPresets, presetSearch, selectedPresetManufacturer]);

  const isSearching = presetSearch.trim().length > 0;

  const groupedFilteredPrinterPresets = React.useMemo(() => {
    const grouped = new Map<string, typeof filteredPrinterPresets>();
    filteredPrinterPresets.forEach((preset) => {
      const family = (preset.family ?? '').trim() || 'Other';
      const current = grouped.get(family);
      if (current) {
        current.push(preset);
      } else {
        grouped.set(family, [preset]);
      }
    });

    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, presets]) => ({ family, presets }));
  }, [filteredPrinterPresets, selectedPresetManufacturer]);

  const addedOfficialPresetIds = React.useMemo(() => {
    const set = new Set<string>();
    profileState.printerProfiles.forEach((profile) => {
      if (!profile.isOfficial) return;
      const presetId = resolveOfficialPresetIdFromProfile(profile);
      if (presetId) set.add(presetId);
    });
    return set;
  }, [profileState.printerProfiles]);

  // Initialize first manufacturer selection when presetManufacturers becomes available
  React.useLayoutEffect(() => {
    if (selectedPresetManufacturer === '' && presetManufacturers.length > 0) {
      setSelectedPresetManufacturer(presetManufacturers[0]);
    }
  }, [presetManufacturers, selectedPresetManufacturer]);

  const selectedPrinter = React.useMemo(() => {
    if (profileState.printerProfiles.length === 0) return null;
    const fallback = getActivePrinterProfile(profileState);
    if (!selectedPrinterId) return fallback;
    return profileState.printerProfiles.find((profile) => profile.id === selectedPrinterId) ?? fallback;
  }, [profileState, selectedPrinterId]);

  const selectedFormatVersionOptions = React.useMemo(() => {
    if (!selectedPrinter) return [] as Array<{ value: string; label: string; isDefault?: boolean }>;
    return getAvailableFormatVersionOptions(selectedPrinter.display.outputFormat);
  }, [selectedPrinter]);

  const selectedResolvedFormatVersion = React.useMemo(() => {
    if (!selectedPrinter) return undefined;
    return resolveOutputFormatVersion(
      selectedPrinter.display.outputFormat,
      selectedPrinter.display.formatVersion,
    );
  }, [selectedPrinter]);

  const selectedSettingsModeOptions = React.useMemo(() => {
    if (!selectedPrinter) return [] as Array<{ value: string; label: string; isDefault?: boolean }>;
    return getAvailableSettingsModeOptions(selectedPrinter.display.outputFormat);
  }, [selectedPrinter]);

  const selectedResolvedSettingsMode = React.useMemo(() => {
    if (!selectedPrinter) return undefined;
    return resolveOutputSettingsMode(
      selectedPrinter.display.outputFormat,
      selectedPrinter.display.settingsMode,
    );
  }, [selectedPrinter]);

  const selectedLocalMaterialSettingsAdapter = React.useMemo(() => {
    if (!selectedPrinter) return null;
    return getProfileLocalMaterialSettingsAdapter(
      selectedPrinter.display.outputFormat,
      selectedResolvedSettingsMode,
    );
  }, [selectedPrinter, selectedResolvedSettingsMode]);

  const usePluginLocalSettingsAsReplacement = Boolean(
    selectedLocalMaterialSettingsAdapter?.replacesDefaultMaterialSettings,
  );

  const replacementMaterialEditorTabs = React.useMemo(() => {
    if (!usePluginLocalSettingsAsReplacement || !selectedLocalMaterialSettingsAdapter) return [] as Array<{ id: string; title: string; order: number }>;
    const declared = [...(selectedLocalMaterialSettingsAdapter.tabs ?? [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((tab, index) => ({ id: tab.id, title: tab.title, order: tab.order ?? (index + 1) * 10 }));
    return [...declared, { id: 'meta', title: 'Meta', order: 1000 }];
  }, [selectedLocalMaterialSettingsAdapter, usePluginLocalSettingsAsReplacement]);

  const replacementMaterialEditorDefaultTab = React.useMemo(() => {
    if (!usePluginLocalSettingsAsReplacement) return 'meta';
    return replacementMaterialEditorTabs[0]?.id ?? 'meta';
  }, [replacementMaterialEditorTabs, selectedResolvedSettingsMode, usePluginLocalSettingsAsReplacement]);

  const replacementMaterialModalLabel = React.useMemo(() => {
    if (!selectedPrinter || !usePluginLocalSettingsAsReplacement) return null;
    const normalized = selectedPrinter.display.outputFormat.replace(/^\./, '').trim();
    if (!normalized) return null;
    return normalized.toUpperCase();
  }, [selectedPrinter, usePluginLocalSettingsAsReplacement]);

  const selectedBuildDimensionMode: BuildDimensionEditMode = React.useMemo(() => {
    if (!selectedPrinter) return 'manual';
    return selectedPrinter.buildDimensionMode === 'auto' ? 'auto' : 'manual';
  }, [selectedPrinter]);

  const applyAutoBuildDimensions = React.useCallback((printer: PrinterProfile, overrides?: {
    resolutionX?: number;
    resolutionY?: number;
    pixelSizeX?: number;
    pixelSizeY?: number;
  }) => {
    const resolutionX = overrides?.resolutionX ?? printer.display.resolutionX;
    const resolutionY = overrides?.resolutionY ?? printer.display.resolutionY;
    const pixelSizeX = overrides?.pixelSizeX ?? printer.pixelSize?.x ?? 1;
    const pixelSizeY = overrides?.pixelSizeY ?? printer.pixelSize?.y ?? 1;

    return {
      ...printer.buildVolumeMm,
      width: computeBuildDimensionMm(resolutionX, pixelSizeX),
      depth: computeBuildDimensionMm(resolutionY, pixelSizeY),
    };
  }, []);

  const setBuildDimensionMode = React.useCallback((mode: BuildDimensionEditMode) => {
    if (!selectedPrinter) return;
    if (mode === selectedBuildDimensionMode) return;

    const currentManualDimensions: ManualBuildDimensions = {
      width: selectedPrinter.buildVolumeMm.width,
      depth: selectedPrinter.buildVolumeMm.depth,
    };

    if (selectedBuildDimensionMode === 'manual' && mode === 'auto') {
      setManualBuildDimensionsByPrinterId((prev) => ({
        ...prev,
        [selectedPrinter.id]: currentManualDimensions,
      }));
    }

    if (mode === 'auto') {
      updatePrinterProfile(selectedPrinter.id, {
        buildDimensionMode: 'auto',
        buildVolumeMm: applyAutoBuildDimensions(selectedPrinter),
      });
    }

    if (mode === 'manual') {
      const remembered = manualBuildDimensionsByPrinterId[selectedPrinter.id];
      if (remembered) {
        updatePrinterProfile(selectedPrinter.id, {
          buildDimensionMode: 'manual',
          buildVolumeMm: {
            ...selectedPrinter.buildVolumeMm,
            width: remembered.width,
            depth: remembered.depth,
          },
        });
        return;
      }

      updatePrinterProfile(selectedPrinter.id, {
        buildDimensionMode: 'manual',
      });
    }
  }, [applyAutoBuildDimensions, manualBuildDimensionsByPrinterId, selectedBuildDimensionMode, selectedPrinter]);

  React.useEffect(() => {
    if (!selectedPrinter) return;
    if (selectedBuildDimensionMode !== 'manual') return;

    const nextManualDimensions: ManualBuildDimensions = {
      width: selectedPrinter.buildVolumeMm.width,
      depth: selectedPrinter.buildVolumeMm.depth,
    };

    setManualBuildDimensionsByPrinterId((prev) => {
      const current = prev[selectedPrinter.id];
      if (current && current.width === nextManualDimensions.width && current.depth === nextManualDimensions.depth) {
        return prev;
      }
      return {
        ...prev,
        [selectedPrinter.id]: nextManualDimensions,
      };
    });
  }, [selectedBuildDimensionMode, selectedPrinter]);

  const handlePrinterDisplayChange = React.useCallback((partialDisplay: Partial<PrinterProfile['display']>) => {
    if (!selectedPrinter) return;

    const nextDisplay: PrinterProfile['display'] = {
      ...selectedPrinter.display,
      ...partialDisplay,
    };

    nextDisplay.formatVersion = resolveOutputFormatVersion(
      nextDisplay.outputFormat,
      partialDisplay.formatVersion ?? nextDisplay.formatVersion,
    );
    nextDisplay.settingsMode = resolveOutputSettingsMode(
      nextDisplay.outputFormat,
      partialDisplay.settingsMode ?? nextDisplay.settingsMode,
    );

    updatePrinterProfile(selectedPrinter.id, {
      display: nextDisplay,
      buildVolumeMm: selectedBuildDimensionMode === 'auto'
        ? applyAutoBuildDimensions(selectedPrinter, {
          resolutionX: nextDisplay.resolutionX,
          resolutionY: nextDisplay.resolutionY,
        })
        : selectedPrinter.buildVolumeMm,
    });
  }, [applyAutoBuildDimensions, selectedBuildDimensionMode, selectedPrinter]);

  const handlePrinterPixelSizeChange = React.useCallback((axis: 'x' | 'y', value: number) => {
    if (!selectedPrinter) return;

    const safeValue = Math.max(0.001, Number(value) || 0.001);
    const currentPixelX = selectedPrinter.pixelSize?.x ?? 1;
    const currentPixelY = selectedPrinter.pixelSize?.y ?? 1;

    const nextPixelSize = {
      x: axis === 'x' ? safeValue : currentPixelX,
      y: axis === 'y' ? safeValue : currentPixelY,
    };

    updatePrinterProfile(selectedPrinter.id, {
      pixelSize: nextPixelSize,
      buildVolumeMm: selectedBuildDimensionMode === 'auto'
        ? applyAutoBuildDimensions(selectedPrinter, {
          pixelSizeX: nextPixelSize.x,
          pixelSizeY: nextPixelSize.y,
        })
        : selectedPrinter.buildVolumeMm,
    });
  }, [applyAutoBuildDimensions, selectedBuildDimensionMode, selectedPrinter]);

  const handlePrinterBitDepthChange = React.useCallback((value: number) => {
    if (!selectedPrinter) return;
    const bits = Math.max(1, Math.round(value));
    updatePrinterProfile(selectedPrinter.id, {
      bitDepth: {
        bits,
        description: selectedPrinter.bitDepth?.description,
      },
    });
  }, [selectedPrinter]);

  const printerMaterials = React.useMemo(() => {
    if (!selectedPrinter) return [];
    return getMaterialProfilesForPrinter(selectedPrinter.id, profileState);
  }, [profileState, selectedPrinter]);

  const availableManufacturers = React.useMemo(() => {
    return Array.from(new Set(printerMaterials.map((material) => material.brand || 'Default'))).sort((a, b) => a.localeCompare(b));
  }, [printerMaterials]);

  const selectedManufacturerValue = React.useMemo(() => {
    if (availableManufacturers.length === 0) return null;
    if (selectedManufacturer && availableManufacturers.includes(selectedManufacturer)) return selectedManufacturer;
    return availableManufacturers[0];
  }, [availableManufacturers, selectedManufacturer]);

  const availableResinTypes = React.useMemo(() => {
    if (!selectedManufacturerValue) return [];
    return Array.from(
      new Set(
        printerMaterials
          .filter((material) => (material.brand || 'Default') === selectedManufacturerValue)
          .map((material) => material.resinFamily),
      ),
    );
  }, [printerMaterials, selectedManufacturerValue]);

  const selectedResinFamilyValue = React.useMemo(() => {
    if (availableResinTypes.length === 0) return null;
    if (selectedResinFamily && availableResinTypes.includes(selectedResinFamily)) return selectedResinFamily;
    return availableResinTypes[0];
  }, [availableResinTypes, selectedResinFamily]);

  const filteredMaterialProfiles = React.useMemo(() => {
    if (!selectedManufacturerValue || !selectedResinFamilyValue) return [];
    return printerMaterials.filter(
      (material) => (material.brand || 'Default') === selectedManufacturerValue && material.resinFamily === selectedResinFamilyValue,
    );
  }, [printerMaterials, selectedManufacturerValue, selectedResinFamilyValue]);

  const selectedMaterial = React.useMemo(() => {
    if (filteredMaterialProfiles.length === 0) return null;
    if (!selectedMaterialId) return filteredMaterialProfiles[0];
    return filteredMaterialProfiles.find((material) => material.id === selectedMaterialId) ?? filteredMaterialProfiles[0];
  }, [filteredMaterialProfiles, selectedMaterialId]);

  const selectedPrinterUpdate = React.useMemo(() => {
    if (!selectedPrinter) return null;
    return officialPrinterUpdates.find((update) => update.printerProfileId === selectedPrinter.id) ?? null;
  }, [officialPrinterUpdates, selectedPrinter]);
  const isSelectedPrinterOfficial = selectedPrinter?.isOfficial === true;

  const selectedMaterialUpdate = React.useMemo(() => {
    if (!selectedMaterial) return null;
    return officialMaterialUpdates.find((update) => update.materialProfileId === selectedMaterial.id) ?? null;
  }, [officialMaterialUpdates, selectedMaterial]);

  const selectedPrinterSupportsNetworkSettings = Boolean(selectedPrinter?.networkSupport);
  const registeredNetworkModeOptions = React.useMemo<Array<{ value: PrinterOutputFormat; label: string }>>(() => {
    const modes = getAvailableProfileNetworkModes();
    return [
      { value: '', label: 'None (Local only)' },
      ...modes.map((mode) => ({
        value: mode.mode,
        label: mode.displayName,
      })),
    ];
  }, []);
  const selectedPrinterNetworkModeOptions = React.useMemo<Array<{ value: PrinterOutputFormat; label: string }>>(() => {
    const currentMode = (selectedPrinter?.networkSupport ?? '').trim().toLowerCase();
    if (!currentMode) return registeredNetworkModeOptions;
    if (registeredNetworkModeOptions.some((option) => option.value === currentMode)) return registeredNetworkModeOptions;
    return [
      ...registeredNetworkModeOptions,
      { value: currentMode, label: `Unknown (${currentMode})` },
    ];
  }, [registeredNetworkModeOptions, selectedPrinter?.networkSupport]);
  const networkUiAdapter = React.useMemo(
    () => getProfileNetworkUiAdapter(selectedPrinter?.networkSupport),
    [selectedPrinter?.networkSupport],
  );
  const effectiveNetworkUiAdapter = React.useMemo(
    () => networkUiAdapter ?? getDefaultProfileNetworkUiAdapter(),
    [networkUiAdapter],
  );
  const supportsRemoteMaterialProfiles = Boolean(
    networkUiAdapter && networkUiAdapter.supportsRemoteMaterialProfiles !== false,
  );
  const selectedNetworkModeLabel = networkUiAdapter?.displayName ?? 'Unknown';
  const selectedActiveNetworkDeviceReachability = selectedPrinter?.activeNetworkDeviceId
    ? printerReachabilityByDeviceId[selectedPrinter.activeNetworkDeviceId]
    : null;
  const shouldUseRemoteOnDeviceMaterials = Boolean(
    supportsRemoteMaterialProfiles
    && selectedPrinter?.networkConnection?.connected
    && (selectedPrinter?.networkConnection?.ipAddress || selectedPrinter?.network?.ipAddress)
    && selectedActiveNetworkDeviceReachability !== false,
  );

  const selectedRemoteMaterial = React.useMemo(() => {
    if (!selectedRemoteMaterialId) return null;
    return remoteMaterials.find((material) => material.id === selectedRemoteMaterialId) ?? null;
  }, [remoteMaterials, selectedRemoteMaterialId]);

  const selectedRemoteMaterialIdRef = React.useRef('');
  const lastHandledOpenPrinterLibraryTokenRef = React.useRef(0);
  const lastHandledOpenNetworkSettingsTokenRef = React.useRef(0);
  const wasOpenRef = React.useRef(false);
  const lastInitializedNetworkPrinterIdRef = React.useRef<string | null>(null);
  const discoveryInFlightRef = React.useRef(false);
  const discoveryRunIdRef = React.useRef(0);

  React.useEffect(() => {
    selectedRemoteMaterialIdRef.current = selectedRemoteMaterialId;
  }, [selectedRemoteMaterialId]);

  const selectedPrinterResolvedId = selectedPrinter?.id ?? '';
  const selectedPrinterNetworkSupportMode = selectedPrinter?.networkSupport ?? null;
  const selectedRemoteMaterialHost = (selectedPrinter?.networkConnection?.ipAddress || selectedPrinter?.network?.ipAddress || '').trim();
  const selectedPrinterPreset = React.useMemo(() => {
    if (!selectedPrinter) return null;
    const presetId = resolveOfficialPresetIdFromProfile(selectedPrinter);
    if (presetId) {
      return availablePrinterPresets.find((preset) => preset.presetId === presetId) ?? null;
    }

    const normalizedPrinterName = (selectedPrinter.name ?? '').trim().toLowerCase();
    const normalizedPrinterManufacturer = (selectedPrinter.manufacturer ?? '').trim().toLowerCase();

    if (!normalizedPrinterName) return null;

    const exactMatch = availablePrinterPresets.find((preset) => (
      (preset.name ?? '').trim().toLowerCase() === normalizedPrinterName
      && (preset.manufacturer ?? '').trim().toLowerCase() === normalizedPrinterManufacturer
    ));
    if (exactMatch) return exactMatch;

    const fuzzyMatch = availablePrinterPresets.find((preset) => {
      const presetName = (preset.name ?? '').trim().toLowerCase();
      const presetFamily = (preset.family ?? '').trim().toLowerCase();
      const manufacturerMatches = !normalizedPrinterManufacturer
        || (preset.manufacturer ?? '').trim().toLowerCase() === normalizedPrinterManufacturer;
      if (!manufacturerMatches) return false;
      return (
        presetName === normalizedPrinterName
        || presetName.includes(normalizedPrinterName)
        || normalizedPrinterName.includes(presetName)
        || (presetFamily.length > 0 && normalizedPrinterName.includes(presetFamily))
      );
    });

    return fuzzyMatch ?? null;
  }, [availablePrinterPresets, selectedPrinter]);
  const selectedPrinterNetworkFilterHint = React.useMemo(() => {
    const explicit = selectedPrinter?.networkFilter?.trim() || '';
    if (explicit.length > 0) return explicit;

    const presetFilter = selectedPrinterPreset?.networkFilter?.trim() || '';
    if (presetFilter.length > 0) return presetFilter;

    if (!selectedPrinter) return '';

    const normalizedName = (selectedPrinter.name ?? '').trim().toLowerCase();
    const normalizedManufacturer = (selectedPrinter.manufacturer ?? '').trim().toLowerCase();
    const resolutionX = Number(selectedPrinter.display?.resolutionX ?? 0);
    const resolutionY = Number(selectedPrinter.display?.resolutionY ?? 0);
    const pixelX = Number(selectedPrinter.pixelSize?.x ?? 0);
    const pixelY = Number(selectedPrinter.pixelSize?.y ?? 0);

    const candidates = availablePrinterPresets
      .filter((preset) => preset.networkSupport === selectedPrinter?.networkSupport)
      .filter((preset) => typeof preset.networkFilter === 'string' && preset.networkFilter.trim().length > 0);

    const byDisplayAndPixel = candidates.find((preset) => {
      const presetResolutionX = Number(preset.display?.resolutionX ?? 0);
      const presetResolutionY = Number(preset.display?.resolutionY ?? 0);
      const presetPixelX = Number((preset as any)?.pixelSize?.x ?? 0);
      const presetPixelY = Number((preset as any)?.pixelSize?.y ?? 0);

      const resolutionMatch = resolutionX > 0 && resolutionY > 0
        && presetResolutionX === resolutionX
        && presetResolutionY === resolutionY;

      const pixelMatch = pixelX > 0 && pixelY > 0
        && Math.abs(presetPixelX - pixelX) < 0.001
        && Math.abs(presetPixelY - pixelY) < 0.001;

      return resolutionMatch && pixelMatch;
    });
    if (byDisplayAndPixel?.networkFilter) return byDisplayAndPixel.networkFilter;

    const byDisplayOnly = candidates.find((preset) => {
      const presetResolutionX = Number(preset.display?.resolutionX ?? 0);
      const presetResolutionY = Number(preset.display?.resolutionY ?? 0);
      return resolutionX > 0 && resolutionY > 0
        && presetResolutionX === resolutionX
        && presetResolutionY === resolutionY;
    });
    if (byDisplayOnly?.networkFilter) return byDisplayOnly.networkFilter;

    const exactByNameAndManufacturer = candidates.find((preset) => (
      (preset.name ?? '').trim().toLowerCase() === normalizedName
      && (preset.manufacturer ?? '').trim().toLowerCase() === normalizedManufacturer
    ));
    if (exactByNameAndManufacturer?.networkFilter) return exactByNameAndManufacturer.networkFilter;

    const exactByName = candidates.find((preset) => (
      (preset.name ?? '').trim().toLowerCase() === normalizedName
    ));
    if (exactByName?.networkFilter) return exactByName.networkFilter;

    const containsByName = candidates.find((preset) => {
      const presetName = (preset.name ?? '').trim().toLowerCase();
      if (!presetName || !normalizedName) return false;
      return normalizedName.includes(presetName) || presetName.includes(normalizedName);
    });
    if (containsByName?.networkFilter) return containsByName.networkFilter;

    const containsByFamily = candidates.find((preset) => {
      const presetFamily = (preset.family ?? '').trim().toLowerCase();
      if (!presetFamily || !normalizedName) return false;
      return normalizedName.includes(presetFamily);
    });
    if (containsByFamily?.networkFilter) return containsByFamily.networkFilter;

    return '';
  }, [availablePrinterPresets, selectedPrinter, selectedPrinter?.networkFilter, selectedPrinterPreset?.networkFilter]);
  const selectedPrinterModelHint = React.useMemo(() => {
    const source = [
      selectedPrinterNetworkFilterHint,
      selectedPrinter?.name ?? '',
      selectedPrinterPreset?.name ?? '',
      selectedPrinterPreset?.family ?? '',
    ]
      .filter((value) => typeof value === 'string' && value.trim().length > 0)
      .join(' ')
      .toLowerCase();

    if (!source) return undefined;
    if (/\bathena\s*(ii|2)\b/.test(source) || source.includes('athena2')) return 'athena-2' as const;
    if (source.includes('athena')) return 'athena' as const;
    return undefined;
  }, [selectedPrinter?.name, selectedPrinterNetworkFilterHint, selectedPrinterPreset?.family, selectedPrinterPreset?.name]);
  const managedNetworkPrinters = React.useMemo(() => selectedPrinter?.networkFleet ?? [], [selectedPrinter?.networkFleet]);
  const connectedManagedNetworkPrinterCount = React.useMemo(
    () => managedNetworkPrinters.filter((device) => device.connected).length,
    [managedNetworkPrinters],
  );
  const selectedPrinterFleetCount = managedNetworkPrinters.length;
  const canShowFleetRailMode = selectedPrinterSupportsNetworkSettings && selectedPrinterFleetCount > 1;
  const shouldRenderFleetRail = selectedPrinterSupportsNetworkSettings && printerRailViewMode === 'fleet';
  const printerRailEntryCount = shouldRenderFleetRail ? managedNetworkPrinters.length : profileState.printerProfiles.length;
  const shouldConstrainPrinterRailHeight = printerRailEntryCount > 8;
  const selectedPrinterRailIndex = React.useMemo(
    () => profileState.printerProfiles.findIndex((profile) => profile.id === selectedPrinter?.id),
    [profileState.printerProfiles, selectedPrinter?.id],
  );
  const networkSettingsActionLabel = connectedManagedNetworkPrinterCount > 1 ? 'Manage Fleet' : 'Network Settings';
  const shouldShowFleetSwitchAction = selectedPrinterSupportsNetworkSettings && selectedPrinterFleetCount > 1;
  const regularNetworkActionLabel = shouldShowFleetSwitchAction ? 'Show Fleet' : 'Network Settings';
  const printerSectionTitle = shouldRenderFleetRail
    ? `${selectedPrinter?.name ?? 'Printer'} Fleet`
    : '3D Printer';
  const moveDraggedPrinter = React.useCallback((draggedId: string, beforeId?: string | null) => {
    if (!draggedId) return;
    movePrinterProfile(draggedId, beforeId ?? undefined);
  }, []);
  const moveSelectedPrinterInRail = React.useCallback((direction: -1 | 1) => {
    if (!selectedPrinter || shouldRenderFleetRail) return;
    if (selectedPrinterRailIndex < 0) return;

    const targetIndex = selectedPrinterRailIndex + direction;
    const targetPrinter = profileState.printerProfiles[targetIndex];
    if (!targetPrinter) return;

    movePrinterProfile(selectedPrinter.id, direction > 0 ? profileState.printerProfiles[targetIndex + 1]?.id : targetPrinter.id);
  }, [profileState.printerProfiles, selectedPrinter, selectedPrinterRailIndex, shouldRenderFleetRail]);
  const renderPrinterRailCard = React.useCallback((options: {
    key: string;
    active: boolean;
    draggable?: boolean;
    dragging?: boolean;
    onClick: () => void;
    onDoubleClick?: () => void;
    onDragStart?: React.DragEventHandler<HTMLDivElement>;
    onDragEnd?: React.DragEventHandler<HTMLDivElement>;
    onDragOver?: React.DragEventHandler<HTMLDivElement>;
    onDrop?: React.DragEventHandler<HTMLDivElement>;
    imageDataUrl?: string;
    imageAlt: string;
    imageFallback: React.ReactNode;
    imageOverlay?: React.ReactNode;
    useTrimmedImage?: boolean;
    imageFitClassName?: string;
    imageInsetClassName?: string;
    topBadge?: React.ReactNode;
    bottomRightBadge?: React.ReactNode;
    title: string;
    subtitle: string;
    footer?: React.ReactNode;
    activeStyles: React.CSSProperties;
    inactiveStyles: React.CSSProperties;
  }) => {
    const {
      key,
      active,
      draggable,
      dragging,
      onClick,
      onDoubleClick,
      onDragStart,
      onDragEnd,
      onDragOver,
      onDrop,
      imageDataUrl,
      imageAlt,
      imageFallback,
      imageOverlay,
      useTrimmedImage = true,
      imageFitClassName = 'object-contain',
      imageInsetClassName = 'inset-1',
      topBadge,
      bottomRightBadge,
      title,
      subtitle,
      footer,
      activeStyles,
      inactiveStyles,
    } = options;

    return (
      <div
        key={key}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
        className={`min-w-0 w-full rounded-xl border p-2 transition-all duration-150 ${draggable ? (dragging ? 'opacity-60' : 'cursor-grab active:cursor-grabbing') : ''}`}
        onDoubleClick={onDoubleClick}
        style={active ? activeStyles : inactiveStyles}
      >
        <button
          type="button"
          onClick={onClick}
          className="w-full text-left leading-none"
        >
          <div
            className="h-[128px] min-h-[128px] max-h-[128px] shrink-0 rounded-lg border overflow-hidden relative"
            style={{
              borderColor: 'var(--border-subtle)',
              background: '#1c2027',
              height: 128,
              minHeight: 128,
              maxHeight: 128,
            }}
          >
            {imageDataUrl ? (
              <div className={`absolute ${imageInsetClassName}`}>
                {useTrimmedImage ? (
                  <AutoTrimmedImage src={imageDataUrl} alt={imageAlt} className={`h-full w-full ${imageFitClassName}`} />
                ) : (
                  <img src={imageDataUrl} alt={imageAlt} className={`h-full w-full ${imageFitClassName} transition-opacity duration-150 opacity-100`} />
                )}
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center px-2" style={{ color: 'var(--text-muted)' }}>
                <div className="flex flex-col items-center justify-center gap-1 text-[10px] text-center leading-tight">
                  {imageFallback}
                </div>
              </div>
            )}
            {imageOverlay}
            {topBadge}
            {bottomRightBadge && (
              <div className="absolute bottom-1 right-1 z-10">
                {bottomRightBadge}
              </div>
            )}
          </div>
        </button>

        <div className="mt-0.5 flex items-center justify-between gap-1.5">
          <button
            type="button"
            onClick={onClick}
            className="min-w-0 flex-1 text-left"
          >
            <div className="flex items-center gap-1.5">
              <div className="text-[11px] leading-snug font-semibold truncate min-w-0" style={{ color: 'var(--text-strong)' }}>
                {title}
              </div>
            </div>
            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
              {subtitle}
            </div>
          </button>
          {footer}
        </div>
      </div>
    );
  }, []);
  const activeManagedNetworkPrinter = React.useMemo(
    () => managedNetworkPrinters.find((device) => device.id === selectedPrinter?.activeNetworkDeviceId) ?? null,
    [managedNetworkPrinters, selectedPrinter?.activeNetworkDeviceId],
  );
  const editingFleetUnit = React.useMemo(
    () => managedNetworkPrinters.find((device) => device.id === editingFleetUnitId) ?? null,
    [editingFleetUnitId, managedNetworkPrinters],
  );
  const isSelectedRemoteMaterialPrinterOffline = React.useMemo(() => {
    if (!supportsRemoteMaterialProfiles) return false;
    if (!selectedRemoteMaterialHost) return false;

    if (activeManagedNetworkPrinter) {
      if (printerReachabilityByDeviceId[activeManagedNetworkPrinter.id] === false) return true;
      return activeManagedNetworkPrinter.connected !== true;
    }

    if (selectedPrinter?.activeNetworkDeviceId && selectedActiveNetworkDeviceReachability === false) {
      return true;
    }

    return selectedPrinter?.networkConnection?.connected === false;
  }, [
    activeManagedNetworkPrinter,
    selectedActiveNetworkDeviceReachability,
    selectedPrinter?.activeNetworkDeviceId,
    supportsRemoteMaterialProfiles,
    printerReachabilityByDeviceId,
    selectedRemoteMaterialHost,
    selectedPrinter?.networkConnection?.connected,
  ]);
  const hasConfiguredRemoteMaterialTarget = Boolean(
    selectedRemoteMaterialHost
    || selectedPrinter?.activeNetworkDeviceId
    || activeManagedNetworkPrinter,
  );
  const shouldShowRemoteMaterialSelectedPrinterOfflineState = Boolean(
    supportsRemoteMaterialProfiles
    && !shouldUseRemoteOnDeviceMaterials
    && hasConfiguredRemoteMaterialTarget
    && isSelectedRemoteMaterialPrinterOffline,
  );
  const shouldShowRemoteMaterialConnectInfo = Boolean(
    supportsRemoteMaterialProfiles
    && !shouldUseRemoteOnDeviceMaterials
    && !shouldShowRemoteMaterialSelectedPrinterOfflineState,
  );
  const shouldShowRemoteMaterialsPanel = shouldUseRemoteOnDeviceMaterials || shouldShowRemoteMaterialSelectedPrinterOfflineState;

  const primaryEditFields = effectiveNetworkUiAdapter.primaryEditFields;
  const basicEditSections = effectiveNetworkUiAdapter.basicSections;
  const advancedEditSectionsDefs = effectiveNetworkUiAdapter.advancedSections;

  const remoteMaterialPrimaryFieldByKey = React.useMemo(() => {
    const map = new Map<string, (typeof primaryEditFields)[number]>();
    primaryEditFields.forEach((field) => {
      map.set(field.key, field);
    });
    return map;
  }, [primaryEditFields]);

  const sortedRemoteMaterialDraftEntries = React.useMemo(() => {
    return buildSortedRemoteMaterialDraftEntries(remoteMaterialEditDraft, primaryEditFields);
  }, [remoteMaterialEditDraft, primaryEditFields]);

  const basicRemoteMaterialSections = React.useMemo(() => {
    return buildBasicRemoteMaterialSections(
      remoteMaterialEditDraft,
      primaryEditFields,
      basicEditSections,
    );
  }, [basicEditSections, primaryEditFields, remoteMaterialEditDraft]);

  const advancedRemoteMaterialSections = React.useMemo(() => {
    return buildAdvancedRemoteMaterialSections(
      sortedRemoteMaterialDraftEntries,
      primaryEditFields,
      advancedEditSectionsDefs,
      effectiveNetworkUiAdapter.resolveAdvancedSectionId,
    );
  }, [advancedEditSectionsDefs, effectiveNetworkUiAdapter.resolveAdvancedSectionId, primaryEditFields, sortedRemoteMaterialDraftEntries]);

  const isRemoteMaterialDynamicWaitEnabledState = React.useMemo(() => {
    return effectiveNetworkUiAdapter.isDynamicWaitEnabled(remoteMaterialEditDraft);
  }, [remoteMaterialEditDraft, effectiveNetworkUiAdapter]);

  React.useEffect(() => {
    if (!selectedPrinterSupportsNetworkSettings) {
      setPrinterRailViewMode('profiles');
      return;
    }

    if (selectedPrinterFleetCount > 1) {
      return;
    }

    if (printerRailViewMode === 'fleet') {
      setPrinterRailViewMode('profiles');
    }
  }, [printerRailViewMode, selectedPrinterFleetCount, selectedPrinterSupportsNetworkSettings]);

  React.useEffect(() => {
    if (!selectedPrinterSupportsNetworkSettings) {
      setPrinterRailViewMode('profiles');
      return;
    }

    if (selectedPrinterFleetCount > 1) {
      return;
    }

    if (printerRailViewMode === 'fleet') {
      setPrinterRailViewMode('profiles');
    }
  }, [printerRailViewMode, selectedPrinterFleetCount, selectedPrinterSupportsNetworkSettings]);

  React.useLayoutEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      return;
    }

    const justOpened = !wasOpenRef.current;
    if (!justOpened) {
      return;
    }
    wasOpenRef.current = true;

    const shouldOpenPrinterLibrary =
      initialTab === 'printer'
      && openPrinterLibraryToken > 0
      && openPrinterLibraryToken > lastHandledOpenPrinterLibraryTokenRef.current;

    const shouldOpenNetworkSettings =
      initialTab === 'printer'
      && openNetworkSettingsToken > 0
      && openNetworkSettingsToken > lastHandledOpenNetworkSettingsTokenRef.current;

    if (shouldOpenPrinterLibrary) {
      lastHandledOpenPrinterLibraryTokenRef.current = openPrinterLibraryToken;
    }

    if (shouldOpenNetworkSettings) {
      lastHandledOpenNetworkSettingsTokenRef.current = openNetworkSettingsToken;
    }

    setSelectedPrinterId(profileState.activePrinterProfileId);
    setSelectedManufacturer(null);
    setSelectedResinFamily(null);
    setIsMaterialEditorOpen(false);
    setIsEditingPrinter(false);
    setIsNetworkSettingsOpen(shouldOpenNetworkSettings);
    setShowPresetPicker(shouldOpenPrinterLibrary && !shouldOpenNetworkSettings);
    setPresetSearch('');
    if (presetManufacturers.length > 0) setSelectedPresetManufacturer(presetManufacturers[0]);
    const materials = getMaterialProfilesForPrinter(profileState.activePrinterProfileId, profileState);
    setSelectedMaterialId(materials[0]?.id ?? null);
  }, [initialTab, isOpen, openNetworkSettingsToken, openPrinterLibraryToken, profileState.activePrinterProfileId, profileState, presetManufacturers]);

  React.useEffect(() => {
    if (!isOpen) return;

    const sources = availablePrinterPresets
      .map((preset) => preset.imageAssetPath)
      .filter((path): path is string => typeof path === 'string' && path.trim().length > 0);

    const uniqueSources = Array.from(new Set(sources));
    uniqueSources.forEach((source) => {
      const image = new Image();
      image.decoding = 'async';
      image.src = source;
      void image.decode().catch(() => {
        // Ignore decode failures during prefetch.
      });
    });
  }, [isOpen, availablePrinterPresets]);

  React.useEffect(() => {
    if (!isOpen) return;
    if (!selectedPrinter) {
      setSelectedMaterialId(null);
      setSelectedManufacturer(null);
      setSelectedResinFamily(null);
      return;
    }

    if (availableManufacturers.length === 0) {
      setSelectedMaterialId(null);
      setSelectedManufacturer(null);
      setSelectedResinFamily(null);
      return;
    }

    if (selectedManufacturerValue && selectedManufacturerValue !== selectedManufacturer) {
      setSelectedManufacturer(selectedManufacturerValue);
    }

    if (selectedResinFamilyValue && selectedResinFamilyValue !== selectedResinFamily) {
      setSelectedResinFamily(selectedResinFamilyValue);
    }

    if (!selectedMaterialId || !filteredMaterialProfiles.some((material) => material.id === selectedMaterialId)) {
      setSelectedMaterialId(filteredMaterialProfiles[0]?.id ?? null);
    }
  }, [
    isOpen,
    selectedPrinter,
    availableManufacturers,
    selectedManufacturer,
    selectedManufacturerValue,
    selectedResinFamily,
    selectedResinFamilyValue,
    filteredMaterialProfiles,
    selectedMaterialId,
  ]);

  React.useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  React.useEffect(() => {
    if (!selectedPrinter) {
      setIsMaterialEditorOpen(false);
      setIsCreateMaterialOpen(false);
    }
  }, [selectedPrinter]);

  React.useEffect(() => {
    if (!selectedPrinter) {
      setIsEditingPrinter(false);
    }
  }, [selectedPrinter]);

  React.useEffect(() => {
    if (!selectedPrinter) {
      setIsNetworkSettingsOpen(false);
      setIsAddingNetworkPrinter(false);
      lastInitializedNetworkPrinterIdRef.current = null;
      return;
    }

    if (lastInitializedNetworkPrinterIdRef.current === selectedPrinter.id) {
      return;
    }
    lastInitializedNetworkPrinterIdRef.current = selectedPrinter.id;

    setNetworkDiscoveryEnabled(selectedPrinter.network?.discoveryEnabled ?? true);
    setNetworkIpAddress(selectedPrinter.network?.ipAddress ?? '');
    setCachedDiscoveredPrinters(discoveredPrinters);
    setDiscoveredPrinters([]);
    setNetworkConnectionMessage(selectedPrinter.networkConnection?.statusText ?? '');
    setShowManualNetworkEntry(false);
    setIsAddingNetworkPrinter((selectedPrinter.networkFleet?.length ?? 0) === 0);
  }, [discoveredPrinters, selectedPrinter]);

  React.useEffect(() => {
    if (!selectedPrinterSupportsNetworkSettings) {
      setIsNetworkSettingsOpen(false);
    }
  }, [selectedPrinterSupportsNetworkSettings]);

  const loadRemoteMaterials = React.useCallback(async () => {
    if (!selectedPrinterResolvedId) return;
    if (!networkUiAdapter) return;

    const host = selectedRemoteMaterialHost;
    if (!host) {
      setRemoteMaterials([]);
      setRemoteMaterialsError(`Connect to a ${selectedNetworkModeLabel} printer to load on-device materials.`);
      return;
    }

    setIsLoadingRemoteMaterials(true);
    setRemoteMaterialsError(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: networkUiAdapter.pluginId,
        operation: networkUiAdapter.operations.materials,
        host,
      });

      const payload = await response.json().catch(() => null) as any;
      const materials = Array.isArray(payload?.materials)
        ? payload.materials.filter((item: any) => typeof item?.id === 'string' && typeof item?.name === 'string')
        : [];

      setRemoteMaterials(materials);

      const preferredId = selectedRemoteMaterialIdRef.current;
      const nextSelected = materials.find((item: any) => item.id === preferredId)
        ?? materials.find((item: any) => item.locked !== true)
        ?? materials[0]
        ?? null;

      if (nextSelected) {
        const processValues = effectiveNetworkUiAdapter.resolveMaterialProcessValues((nextSelected as RemoteMaterialProfile).meta ?? {});
        setSelectedRemoteMaterialId(nextSelected.id);
        updatePrinterNetworkConnectionStatus(selectedPrinterResolvedId, {
          selectedMaterialId: nextSelected.id,
          selectedMaterialName: nextSelected.name,
          selectedMaterialLayerHeightMm: processValues.layerHeightMm,
          selectedMaterialNormalExposureSec: processValues.normalExposureSec,
          selectedMaterialBottomExposureSec: processValues.bottomExposureSec,
          selectedMaterialBottomLayerCount: processValues.bottomLayerCount,
        });
      } else {
        setSelectedRemoteMaterialId('');
      }

      const errorMessage = typeof payload?.error === 'string' ? payload.error : '';
      if (errorMessage) {
        setRemoteMaterialsError(errorMessage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to load ${selectedNetworkModeLabel} materials.`;
      setRemoteMaterials([]);
      setRemoteMaterialsError(message);
    } finally {
      setIsLoadingRemoteMaterials(false);
    }
  }, [effectiveNetworkUiAdapter, networkUiAdapter, selectedRemoteMaterialHost, selectedPrinterResolvedId]);

  React.useEffect(() => {
    if (!shouldUseRemoteOnDeviceMaterials || !selectedPrinterResolvedId) {
      setRemoteMaterials([]);
      setSelectedRemoteMaterialId('');
      setIsRemoteMaterialEditDialogOpen(false);
      setRemoteMaterialsError(null);
      return;
    }

    void loadRemoteMaterials();
  }, [loadRemoteMaterials, selectedPrinterResolvedId, shouldUseRemoteOnDeviceMaterials]);

  const handleSelectRemoteMaterial = React.useCallback((material: RemoteMaterialProfile) => {
    if (!selectedPrinter) return;
    const processValues = effectiveNetworkUiAdapter.resolveMaterialProcessValues(material.meta ?? {});
    setSelectedRemoteMaterialId(material.id);
    updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
      selectedMaterialId: material.id,
      selectedMaterialName: material.name,
      selectedMaterialLayerHeightMm: processValues.layerHeightMm,
      selectedMaterialNormalExposureSec: processValues.normalExposureSec,
      selectedMaterialBottomExposureSec: processValues.bottomExposureSec,
      selectedMaterialBottomLayerCount: processValues.bottomLayerCount,
    });
  }, [effectiveNetworkUiAdapter, selectedPrinter]);

  const openRemoteMaterialEditDialog = React.useCallback(() => {
    if (!selectedRemoteMaterial) return;
    setRemoteMaterialEditDraft(effectiveNetworkUiAdapter.resolveEditDraftFromMeta(selectedRemoteMaterial.meta ?? {}));
    setRemoteMaterialEditTab('basic');
    setIsRemoteMaterialEditDialogOpen(true);
  }, [effectiveNetworkUiAdapter, selectedRemoteMaterial]);

  const openRemoteMaterialEditDialogForMaterial = React.useCallback((material: RemoteMaterialProfile) => {
    if (material.locked) return;
    handleSelectRemoteMaterial(material);
    setRemoteMaterialEditDraft(effectiveNetworkUiAdapter.resolveEditDraftFromMeta(material.meta ?? {}));
    setRemoteMaterialEditTab('basic');
    setIsRemoteMaterialEditDialogOpen(true);
  }, [effectiveNetworkUiAdapter, handleSelectRemoteMaterial]);

  const handleSaveRemoteMaterialEdits = React.useCallback(async () => {
    if (!selectedPrinter) return;
    if (!selectedRemoteMaterial) return;
    if (!networkUiAdapter) return;

    const host = (selectedPrinter.networkConnection?.ipAddress || selectedPrinter.network?.ipAddress || '').trim();
    const profileId = Number(selectedRemoteMaterial.id);
    if (!host || !Number.isFinite(profileId) || profileId <= 0) return;

    setIsSavingRemoteMaterialEdit(true);
    setRemoteMaterialsError(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: networkUiAdapter.pluginId,
        operation: networkUiAdapter.operations.materialsEdit,
        host,
        profileId,
        fields: effectiveNetworkUiAdapter.denormalizeEditDraftForBackend(remoteMaterialEditDraft),
      });

      const payload = await response.json().catch(() => null) as any;
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : `Failed to save ${selectedNetworkModeLabel} material profile.`);
      }

      setIsRemoteMaterialEditDialogOpen(false);
      setNetworkConnectionMessage(`${selectedNetworkModeLabel} profile updated. Refreshing materials…`);
      await loadRemoteMaterials();
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to save ${selectedNetworkModeLabel} profile.`;
      setRemoteMaterialsError(message);
      setNetworkConnectionMessage(message);
    } finally {
      setIsSavingRemoteMaterialEdit(false);
    }
  }, [effectiveNetworkUiAdapter, loadRemoteMaterials, remoteMaterialEditDraft, networkUiAdapter, selectedRemoteMaterial, selectedPrinter]);

  React.useEffect(() => {
    if (isNetworkSettingsOpen) {
      setHasAutoScannedOnOpen(false);
    }
  }, [isNetworkSettingsOpen, selectedPrinter?.id]);

  const handleRunNetworkDiscovery = React.useCallback(async () => {
    if (!selectedPrinter) return;
    if (!networkDiscoveryEnabled) return;
    if (!networkUiAdapter) return;

    if (discoveryInFlightRef.current) {
      logNetworkScanDebug('discover/skip-concurrent', {
        printerId: selectedPrinter.id,
        reason: 'scan-already-running',
      });
      return;
    }

    discoveryInFlightRef.current = true;
    const runId = ++discoveryRunIdRef.current;
    const isCurrentRun = () => discoveryRunIdRef.current === runId;

    setIsNetworkScanning(true);
    setNetworkScanPhaseLabel('Resolving friendly .local hostnames…');
    setNetworkConnectionMessage('Resolving friendly .local hostnames…');
    setNetworkScanProgressPct(8);

    try {
      const configuredHost = networkIpAddress.trim();
      const seedDevices: Array<{ id: string; name: string; ipAddress: string; status: 'online' | 'reachable' }> = [];
      const carryForwardDiscovered = [...discoveredPrinters, ...cachedDiscoveredPrinters].filter((item, index, array) => (
        array.findIndex((candidate) => candidate.ipAddress === item.ipAddress) === index
      ));

      if (isCurrentRun() && carryForwardDiscovered.length > 0) {
        setDiscoveredPrinters(carryForwardDiscovered);
      }

      logNetworkScanDebug('discover/request', {
        printerId: selectedPrinter.id,
        printerName: selectedPrinter.name,
        printerManufacturer: selectedPrinter.manufacturer ?? null,
        printerOfficialPresetId: resolveOfficialPresetIdFromProfile(selectedPrinter),
        printerResolutionX: selectedPrinter.display?.resolutionX ?? null,
        printerResolutionY: selectedPrinter.display?.resolutionY ?? null,
        printerPixelX: selectedPrinter.pixelSize?.x ?? null,
        printerPixelY: selectedPrinter.pixelSize?.y ?? null,
        scanScope: 'local-hostnames+subnet(progressive)',
        configuredHost,
        networkFilter: selectedPrinterNetworkFilterHint || null,
        modelHint: selectedPrinterModelHint ?? null,
        localHostnamesPresetCount: effectiveNetworkUiAdapter.defaultLocalHostnames.length,
      });

      if (configuredHost.length > 0) {
        const connectResponse = await pluginNetworkFetch({
          pluginId: networkUiAdapter.pluginId,
          operation: networkUiAdapter.operations.connect,
          host: configuredHost,
          networkFilter: selectedPrinterNetworkFilterHint || undefined,
          modelHint: selectedPrinterModelHint,
        });

        const connectPayload = await connectResponse.json().catch(() => null) as any;
        logNetworkScanDebug('connect/configured-host-response', {
          ok: connectResponse.ok,
          status: connectResponse.status,
          requestHost: configuredHost,
          requestedNetworkFilter: selectedPrinterNetworkFilterHint || null,
          requestedModelHint: selectedPrinterModelHint ?? null,
          connected: connectPayload?.connected === true,
          ipAddress: connectPayload?.ipAddress,
          hostName: connectPayload?.hostName,
          printerName: connectPayload?.printerName,
          printerModel: connectPayload?.printerModel,
          statusText: connectPayload?.statusText,
        });
        if (connectPayload?.connected === true && typeof connectPayload?.ipAddress === 'string') {
          const resolvedName = resolveNetworkDiscoveryDisplayName({
            printerName: connectPayload.printerName,
            hostName: connectPayload.hostName,
            printerModel: connectPayload.printerModel,
            modeLabel: selectedNetworkModeLabel,
            networkSupport: selectedPrinter.networkSupport,
            fallbackName: typeof connectPayload.ipAddress === 'string' && connectPayload.ipAddress.trim().length > 0
              ? connectPayload.ipAddress.trim()
              : configuredHost,
          });

          seedDevices.push({
            id: `${selectedPrinter.id}-configured-host`,
            name: resolvedName,
            ipAddress: connectPayload.ipAddress,
            status: 'online',
          });
        }
      }

      const localHostnameCandidates = Array.from(new Set([
        ...effectiveNetworkUiAdapter.defaultLocalHostnames,
        (selectedPrinter.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '.local',
        configuredHost.toLowerCase().endsWith('.local') ? configuredHost.toLowerCase() : '',
      ].filter((value) => value && value.endsWith('.local'))));

      const localResponse = await pluginNetworkFetch({
        pluginId: networkUiAdapter.pluginId,
        operation: networkUiAdapter.operations.discover,
        mode: selectedPrinter.networkSupport,
        scanScope: 'local-hostnames',
        host: networkIpAddress.trim() || undefined,
        networkFilter: selectedPrinterNetworkFilterHint || undefined,
        modelHint: selectedPrinterModelHint,
        debugNetworkFilter: true,
        localHostnames: localHostnameCandidates,
        ports: [80, 8080],
      });

      const localPayload = await localResponse.json().catch(() => null) as any;
      logNetworkScanDebug('discover/local-response', {
        ok: localResponse.ok,
        status: localResponse.status,
        requestedNetworkFilter: selectedPrinterNetworkFilterHint || null,
        requestedModelHint: selectedPrinterModelHint ?? null,
        localHostnames: localHostnameCandidates,
        foundCount: Array.isArray(localPayload?.devices) ? localPayload.devices.length : 0,
        devices: Array.isArray(localPayload?.devices)
          ? localPayload.devices.map((device: any) => ({
            ipAddress: device?.ipAddress,
            hostName: device?.hostName,
            printerName: device?.printerName,
            printerModel: device?.printerModel,
            statusText: device?.statusText,
          }))
          : [],
      });
      const localDevices: any[] = Array.isArray(localPayload?.devices) ? localPayload.devices : [];
      const localDiscovered = localDevices.map((device, index) => {
        const hostName = typeof device?.hostName === 'string' ? device.hostName.trim() : '';
        const printerName = typeof device?.printerName === 'string' ? device.printerName.trim() : '';
        const printerModel = typeof device?.printerModel === 'string' ? device.printerModel.trim() : '';
        const ipAddress = typeof device?.ipAddress === 'string' ? device.ipAddress.trim() : '';

        return {
          id: `${selectedPrinter.id}-local-scan-${index}`,
          name: resolveNetworkDiscoveryDisplayName({
            printerName,
            hostName,
            printerModel,
            modeLabel: selectedNetworkModeLabel,
            networkSupport: selectedPrinter.networkSupport,
            fallbackName: `${selectedNetworkModeLabel} Printer`,
          }),
          ipAddress,
          status: 'online' as const,
        };
      }).filter((item) => item.ipAddress.length > 0);

      const baseDiscovered = [...seedDevices, ...localDiscovered].filter((item, index, array) => (
        array.findIndex((candidate) => candidate.ipAddress === item.ipAddress) === index
      ));

      setNetworkScanProgressPct(44);
      setNetworkScanPhaseLabel('Scanning local subnet…');
      setNetworkConnectionMessage(`Scanning local subnet for ${selectedNetworkModeLabel} devices…`);
            setNetworkScanProgressPct(42);
            setNetworkScanPhaseLabel('Verifying previously discovered printers…');
            setNetworkConnectionMessage('Checking if previously discovered printers are still available…');

            const verifiedCachedPrinters: typeof baseDiscovered = [];
            if (carryForwardDiscovered.length > 0) {
              for (const cachedPrinter of carryForwardDiscovered) {
                try {
                  const reachResponse = await pluginNetworkFetch({
                    pluginId: networkUiAdapter.pluginId,
                    operation: networkUiAdapter.operations.connect,
                    host: cachedPrinter.ipAddress,
                    networkFilter: selectedPrinterNetworkFilterHint || undefined,
                    modelHint: selectedPrinterModelHint,
                  });

                  const reachPayload = await reachResponse.json().catch(() => null) as any;
                  if (reachPayload?.connected === true) {
                    verifiedCachedPrinters.push({
                      ...cachedPrinter,
                      status: 'online',
                    });
                    logNetworkScanDebug('discover/cached-printer-verified', {
                      ipAddress: cachedPrinter.ipAddress,
                      name: cachedPrinter.name,
                    });
                  } else {
                    logNetworkScanDebug('discover/cached-printer-unreachable', {
                      ipAddress: cachedPrinter.ipAddress,
                      name: cachedPrinter.name,
                      reachable: false,
                    });
                  }
                } catch (err) {
                  logNetworkScanDebug('discover/cached-printer-check-error', {
                    ipAddress: cachedPrinter.ipAddress,
                    name: cachedPrinter.name,
                    error: err instanceof Error ? err.message : 'Unknown error',
                  });
                }
              }
            }

            const baseWithVerifiedCache = [...verifiedCachedPrinters, ...baseDiscovered].filter((item, index, array) => (
              array.findIndex((candidate) => candidate.ipAddress === item.ipAddress) === index
            ));
            if (isCurrentRun() && baseWithVerifiedCache.length > 0) setDiscoveredPrinters(baseWithVerifiedCache);

      setNetworkScanProgressPct(56);

      const subnetDiscovered: Array<{ id: string; name: string; ipAddress: string; status: 'online' | 'reachable' }> = [];
      let subnetPayloadLast: any = null;
      let subnetBatchStart = 0;
      let subnetTotalEndpoints = 0;
      let subnetScannedEndpoints = 0;

      while (true) {
        const response = await pluginNetworkFetch({
          pluginId: networkUiAdapter.pluginId,
          operation: networkUiAdapter.operations.discover,
          mode: selectedPrinter.networkSupport,
          scanScope: 'subnet',
          progressive: true,
          batchStart: subnetBatchStart,
          batchSize: 96,
          probeTimeoutMs: 1200,
          subnetConcurrency: 84,
          host: networkIpAddress.trim() || undefined,
          networkFilter: selectedPrinterNetworkFilterHint || undefined,
          modelHint: selectedPrinterModelHint,
          debugNetworkFilter: true,
          excludeHosts: localDiscovered.map((item) => item.ipAddress),
          seedIps: localDiscovered.map((item) => item.ipAddress),
          ports: [80, 8080],
        });

        const payload = await response.json().catch(() => null) as any;
        subnetPayloadLast = payload;
        logNetworkScanDebug('discover/subnet-batch-response', {
          ok: response.ok,
          status: response.status,
          batchStart: subnetBatchStart,
          nextBatchStart: payload?.nextBatchStart,
          done: payload?.done === true,
          scannedEndpoints: payload?.scannedEndpoints,
          totalEndpoints: payload?.totalEndpoints,
          requestedNetworkFilter: selectedPrinterNetworkFilterHint || null,
          requestedModelHint: selectedPrinterModelHint ?? null,
          foundCount: Array.isArray(payload?.devices) ? payload.devices.length : 0,
          devices: Array.isArray(payload?.devices)
            ? payload.devices.map((device: any) => ({
              ipAddress: device?.ipAddress,
              hostName: device?.hostName,
              printerName: device?.printerName,
              printerModel: device?.printerModel,
              statusText: device?.statusText,
            }))
            : [],
        });

        const devices: any[] = Array.isArray(payload?.devices) ? payload.devices : [];
        const discoveredBatch = devices.map((device, index) => {
          const hostName = typeof device?.hostName === 'string' ? device.hostName.trim() : '';
          const printerName = typeof device?.printerName === 'string' ? device.printerName.trim() : '';
          const printerModel = typeof device?.printerModel === 'string' ? device.printerModel.trim() : '';
          const ipAddress = typeof device?.ipAddress === 'string' ? device.ipAddress.trim() : '';

          return {
            id: `${selectedPrinter.id}-scan-batch-${subnetBatchStart}-${index}`,
            name: resolveNetworkDiscoveryDisplayName({
              printerName,
              hostName,
              printerModel,
              modeLabel: selectedNetworkModeLabel,
              networkSupport: selectedPrinter.networkSupport,
              fallbackName: `${selectedNetworkModeLabel} Printer`,
            }),
            ipAddress,
            status: 'online' as const,
          };
        }).filter((item) => item.ipAddress.length > 0);

        subnetDiscovered.push(...discoveredBatch);

        const liveMerged = [...baseWithVerifiedCache, ...subnetDiscovered].filter((item, index, array) => (
          array.findIndex((candidate) => candidate.ipAddress === item.ipAddress) === index
        ));
        if (isCurrentRun()) setDiscoveredPrinters(liveMerged);

        subnetTotalEndpoints = Number.isFinite(Number(payload?.totalEndpoints)) ? Number(payload.totalEndpoints) : subnetTotalEndpoints;
        subnetScannedEndpoints = Number.isFinite(Number(payload?.scannedEndpoints)) ? Number(payload.scannedEndpoints) : subnetScannedEndpoints;

        const subnetProgressRatio = subnetTotalEndpoints > 0
          ? Math.min(1, subnetScannedEndpoints / subnetTotalEndpoints)
          : 1;
        const progressPct = Math.round(56 + (subnetProgressRatio * 42));

        setNetworkScanProgressPct(Math.max(56, Math.min(98, progressPct)));
        setNetworkScanPhaseLabel(`Scanning local subnet… ${subnetScannedEndpoints}/${subnetTotalEndpoints || 0} endpoints`);

        const done = payload?.done === true;
        const nextBatchStart = Number.isFinite(Number(payload?.nextBatchStart)) ? Number(payload.nextBatchStart) : subnetScannedEndpoints;
        if (done || nextBatchStart <= subnetBatchStart) {
          break;
        }

        subnetBatchStart = nextBatchStart;
      }

      const scannedHosts = Number.isFinite(Number(subnetPayloadLast?.scannedHosts)) ? Number(subnetPayloadLast.scannedHosts) : 0;
      const scannedEndpoints = subnetScannedEndpoints;
      const scannedLocalHostnames = Number.isFinite(Number(localPayload?.scannedLocalHostnames)) ? Number(localPayload.scannedLocalHostnames) : localHostnameCandidates.length;
      const scannedSubnetHosts = Number.isFinite(Number(subnetPayloadLast?.scannedSubnetHosts)) ? Number(subnetPayloadLast.scannedSubnetHosts) : scannedHosts;

      const merged = [...baseWithVerifiedCache, ...subnetDiscovered].filter((item, index, array) => (
        array.findIndex((candidate) => candidate.ipAddress === item.ipAddress) === index
      ));

      if (isCurrentRun()) {
        setDiscoveredPrinters(merged);
        setNetworkScanProgressPct(100);
        setNetworkScanPhaseLabel('Scan complete');
        setCachedDiscoveredPrinters(merged);
      }

      logNetworkScanDebug('discover/summary', {
        mergedCount: merged.length,
        scannedHosts,
        scannedEndpoints,
        scannedLocalHostnames,
        scannedSubnetHosts,
      });

      if (merged.length > 0) {
        if (isCurrentRun()) {
          setNetworkConnectionMessage(
            `Found ${merged.length} ${selectedNetworkModeLabel} device${merged.length === 1 ? '' : 's'} (resolved ${scannedLocalHostnames} .local hostnames, scanned ${scannedSubnetHosts} subnet hosts / ${scannedEndpoints} endpoints).`,
          );
        }
      } else {
        if (isCurrentRun()) {
          setNetworkConnectionMessage(
            scannedSubnetHosts > 0 || scannedLocalHostnames > 0
              ? `No ${selectedNetworkModeLabel} devices found (resolved ${scannedLocalHostnames} .local hostnames, scanned ${scannedSubnetHosts} subnet hosts / ${scannedEndpoints} endpoints).`
              : 'No local IPv4 subnet detected by the scanner. Try entering printer IP and scanning again.',
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Discovery failed';
      logNetworkScanDebug('discover/error', {
        message,
        requestedNetworkFilter: selectedPrinterNetworkFilterHint || null,
        requestedModelHint: selectedPrinterModelHint ?? null,
      });
      if (isCurrentRun()) {
        setNetworkConnectionMessage(message);
        setNetworkScanPhaseLabel('Scan failed');
        setNetworkScanProgressPct(100);
      }
    } finally {
      if (isCurrentRun()) {
        setIsNetworkScanning(false);
        window.setTimeout(() => {
          if (!isCurrentRun()) return;
          setNetworkScanProgressPct(0);
          setNetworkScanPhaseLabel('');
        }, 500);
      }
      discoveryInFlightRef.current = false;
    }
  }, [
    cachedDiscoveredPrinters,
    discoveredPrinters,
    discoveryInFlightRef,
    discoveryRunIdRef,
    effectiveNetworkUiAdapter,
    logNetworkScanDebug,
    networkDiscoveryEnabled,
    networkIpAddress,
    networkUiAdapter,
    selectedPrinter,
    selectedPrinterModelHint,
    selectedPrinterNetworkFilterHint,
  ]);

  const handleConnectNetworkPrinter = React.useCallback(async (options?: { host?: string; closeOnSuccess?: boolean; preferredName?: string }) => {
    if (!selectedPrinter || !networkUiAdapter) return;

    const host = (options?.host ?? networkIpAddress).trim();
    const normalizeAddress = (value: unknown): string => (typeof value === 'string' ? value.trim().toLowerCase() : '');
    const normalizeName = normalizeNetworkDiscoveryName;

    const normalizedHost = host.toLowerCase();
    const preferredOptionName = normalizeName(options?.preferredName);
    const debugSentinelHost = '192.168.999.999';
    if (!host) {
      const now = new Date().toISOString();
      setNetworkConnectionMessage('Enter a printer IP address or host first.');
      updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
        mode: selectedPrinter.networkSupport,
        connected: false,
        hostName: '',
        ipAddress: '',
        port: 80,
        lastCheckedAt: now,
        statusText: 'Missing printer host/IP.',
      });
      return false;
    }

    if (normalizedHost === debugSentinelHost) {
      const now = new Date().toISOString();
      const debugPrimaryIp = '192.168.999.999';
      const debugSecondaryIp = '192.168.999.998';

      upsertPrinterNetworkDevice(selectedPrinter.id, {
        ipAddress: debugPrimaryIp,
        hostName: 'Debug Dummy Athena A',
        connected: true,
        mode: selectedPrinter.networkSupport,
        port: 80,
        lastCheckedAt: now,
        statusText: 'Debug printer seeded',
        displayName: 'Debug Dummy Athena A',
      }, { select: true });

      upsertPrinterNetworkDevice(selectedPrinter.id, {
        ipAddress: debugSecondaryIp,
        hostName: 'Debug Dummy Athena B',
        connected: true,
        mode: selectedPrinter.networkSupport,
        port: 80,
        lastCheckedAt: now,
        statusText: 'Debug printer seeded',
        displayName: 'Debug Dummy Athena B',
      }, { select: false });

      updatePrinterNetworkSettings(selectedPrinter.id, {
        discoveryEnabled: networkDiscoveryEnabled,
        ipAddress: debugPrimaryIp,
      });

      updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
        mode: selectedPrinter.networkSupport,
        connected: true,
        hostName: 'Debug Dummy Athena A',
        ipAddress: debugPrimaryIp,
        port: 80,
        lastCheckedAt: now,
        statusText: 'Debug fleet seeded',
      });

      setNetworkIpAddress(debugPrimaryIp);
      setNetworkConnectionMessage('Debug mode: seeded 2 dummy printers (Athena A + Athena B).');
      setIsAddingNetworkPrinter(false);
      setShowManualNetworkEntry(false);
      return true;
    }

    setIsNetworkConnecting(true);
    setNetworkConnectionMessage(`Connecting to ${selectedNetworkModeLabel} host…`);

    try {
      const response = await pluginNetworkFetch({
        pluginId: effectiveNetworkUiAdapter.pluginId,
        operation: effectiveNetworkUiAdapter.operations.connect,
        host,
        networkFilter: selectedPrinterNetworkFilterHint || undefined,
        modelHint: selectedPrinterModelHint,
      });

      const payload = await response.json().catch(() => null) as any;
      const now = new Date().toISOString();

      if (payload?.connected === true) {
        const resolvedIpAddress = typeof payload.ipAddress === 'string' ? payload.ipAddress : host;
        const normalizedResolvedIp = normalizeAddress(resolvedIpAddress);
        const normalizedRequestedHost = normalizeAddress(host);

        const knownDevice = managedNetworkPrinters.find((device) => {
          const deviceIp = normalizeAddress(device.ipAddress);
          return deviceIp.length > 0 && (deviceIp === normalizedResolvedIp || deviceIp === normalizedRequestedHost);
        });

        const discoveredDevice = discoveredPrinters.find((device) => {
          const candidateIp = normalizeAddress((device as any)?.ipAddress);
          return candidateIp.length > 0 && (candidateIp === normalizedResolvedIp || candidateIp === normalizedRequestedHost);
        });

        const preferredKnownName = [
          normalizeName(knownDevice?.displayName),
          normalizeName(knownDevice?.hostName),
          normalizeName((discoveredDevice as any)?.name),
        ].find((value) => value.length > 0 && !looksLikeGenericNetworkDiscoveryName(value, {
          modeLabel: selectedNetworkModeLabel,
          networkSupport: selectedPrinter.networkSupport,
          printerModel: normalizeName(payload.printerModel),
        }));

        const preferredPayloadName = [
          normalizeName(payload.printerName),
          normalizeName(payload.hostName),
        ].find((value) => {
          if (!value) return false;
          if (looksLikeGenericNetworkDiscoveryName(value, {
            modeLabel: selectedNetworkModeLabel,
            networkSupport: selectedPrinter.networkSupport,
            printerModel: normalizeName(payload.printerModel),
          })) return false;
          const normalizedValue = normalizeAddress(value);
          return normalizedValue !== normalizedRequestedHost && normalizedValue !== normalizedResolvedIp;
        });

        const fallbackPayloadName = resolveNetworkDiscoveryDisplayName({
          printerName: payload.printerName,
          hostName: payload.hostName,
          printerModel: payload.printerModel,
          modeLabel: selectedNetworkModeLabel,
          networkSupport: selectedPrinter.networkSupport,
          fallbackName: resolvedIpAddress,
        });

        const resolvedHostName = preferredPayloadName
          || (preferredOptionName && !looksLikeGenericNetworkDiscoveryName(preferredOptionName, {
            modeLabel: selectedNetworkModeLabel,
            networkSupport: selectedPrinter.networkSupport,
            printerModel: normalizeName(payload.printerModel),
          }) ? preferredOptionName : '')
          || preferredKnownName
          || fallbackPayloadName
          || host;

        upsertPrinterNetworkDevice(selectedPrinter.id, {
          ipAddress: resolvedIpAddress,
          hostName: resolvedHostName,
          connected: true,
          mode: selectedPrinter.networkSupport,
          port: Number.isFinite(Number(payload.port)) ? Number(payload.port) : 80,
          lastCheckedAt: now,
          statusText: typeof payload.statusText === 'string' ? payload.statusText : 'Connected',
          displayName: resolvedHostName,
        }, { select: true });

        updatePrinterNetworkSettings(selectedPrinter.id, {
          discoveryEnabled: networkDiscoveryEnabled,
          ipAddress: resolvedIpAddress,
        });

        setNetworkIpAddress(resolvedIpAddress);

        updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
          mode: selectedPrinter.networkSupport,
          connected: true,
          hostName: resolvedHostName,
          ipAddress: resolvedIpAddress,
          port: Number.isFinite(Number(payload.port)) ? Number(payload.port) : 80,
          lastCheckedAt: now,
          statusText: typeof payload.statusText === 'string' ? payload.statusText : 'Connected',
        });

        setNetworkConnectionMessage(`Connected to ${resolvedHostName}`);
        setIsAddingNetworkPrinter(false);
        setShowManualNetworkEntry(false);
        if (options?.closeOnSuccess) {
          setIsNetworkSettingsOpen(false);
        }
        return true;
      } else {
        const statusText = typeof payload?.statusText === 'string'
          ? payload.statusText
          : `${selectedNetworkModeLabel} host unreachable.`;

        updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
          mode: selectedPrinter.networkSupport,
          connected: false,
          hostName: '',
          ipAddress: host,
          port: Number.isFinite(Number(payload?.port)) ? Number(payload.port) : 80,
          lastCheckedAt: now,
          statusText,
        });

        setNetworkConnectionMessage(statusText);
        return false;
      }
    } catch (error) {
      const now = new Date().toISOString();
      const statusText = error instanceof Error ? error.message : 'Connection failed';

      updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
        mode: selectedPrinter.networkSupport,
        connected: false,
        hostName: '',
        ipAddress: host,
        port: 80,
        lastCheckedAt: now,
        statusText,
      });

      setNetworkConnectionMessage(statusText);
      return false;
    } finally {
      setIsNetworkConnecting(false);
    }
  }, [
    discoveredPrinters,
    effectiveNetworkUiAdapter,
    managedNetworkPrinters,
    networkDiscoveryEnabled,
    networkIpAddress,
    networkUiAdapter,
    selectedNetworkModeLabel,
    selectedPrinter,
    selectedPrinterModelHint,
    selectedPrinterNetworkFilterHint,
  ]);

  const handleSelectManagedPrinter = React.useCallback((device: PrinterNetworkDevice) => {
    if (!selectedPrinter) return;
    selectPrinterNetworkDevice(selectedPrinter.id, device.id);
    setNetworkIpAddress(device.ipAddress);
    setNetworkConnectionMessage(`Selected ${device.displayName || device.hostName || device.ipAddress}`);
  }, [selectedPrinter]);

  const handleDisconnectManagedPrinter = React.useCallback((device: PrinterNetworkDevice) => {
    if (!selectedPrinter) return;
    disconnectPrinterNetworkDevice(selectedPrinter.id, device.id);
    setNetworkConnectionMessage(`Disconnected ${device.displayName || device.hostName || device.ipAddress}`);
  }, [selectedPrinter]);

  const handleRemoveManagedPrinter = React.useCallback((device: PrinterNetworkDevice) => {
    if (!selectedPrinter) return;
    removePrinterNetworkDevice(selectedPrinter.id, device.id);
    if (networkIpAddress.trim() === device.ipAddress.trim()) {
      setNetworkIpAddress('');
    }
    setNetworkConnectionMessage(`Removed ${device.displayName || device.hostName || device.ipAddress} from this profile fleet.`);
  }, [networkIpAddress, selectedPrinter]);

  const handleOpenNetworkSettings = React.useCallback(() => {
    if (!selectedPrinter) return;
    setNetworkDiscoveryEnabled(selectedPrinter.network?.discoveryEnabled ?? true);
    setNetworkIpAddress(selectedPrinter.network?.ipAddress ?? '');
    setIsAddingNetworkPrinter((selectedPrinter.networkFleet?.length ?? 0) === 0);
    setShowManualNetworkEntry(false);
    setIsNetworkSettingsOpen(true);
  }, [selectedPrinter]);

  const handleOpenEditFleetUnitModal = React.useCallback(() => {
    if (!selectedPrinter) return;
    const target = activeManagedNetworkPrinter ?? managedNetworkPrinters[0] ?? null;
    if (!target) return;
    setEditingFleetUnitId(target.id);
    setEditingFleetUnitNickname(target.displayName || target.hostName || target.ipAddress || '');
    setEditingFleetUnitImageDataUrl(target.imageDataUrl ?? null);
    setIsEditFleetUnitModalOpen(true);
  }, [activeManagedNetworkPrinter, managedNetworkPrinters, selectedPrinter]);

  const handleSaveFleetUnitEdits = React.useCallback(() => {
    if (!selectedPrinter) return;
    if (!editingFleetUnit) return;

    const nextDisplayName = editingFleetUnitNickname.trim()
      || editingFleetUnit.hostName
      || editingFleetUnit.ipAddress
      || 'Printer';

    upsertPrinterNetworkDevice(selectedPrinter.id, {
      id: editingFleetUnit.id,
      ipAddress: editingFleetUnit.ipAddress,
      displayName: nextDisplayName,
      imageDataUrl: editingFleetUnitImageDataUrl?.trim() ?? '',
    });

    setIsEditFleetUnitModalOpen(false);
  }, [editingFleetUnit, editingFleetUnitImageDataUrl, editingFleetUnitNickname, selectedPrinter]);

  const handleResetFleetUnitDraft = React.useCallback(() => {
    if (!editingFleetUnit) return;
    setEditingFleetUnitNickname(editingFleetUnit.hostName || editingFleetUnit.ipAddress || 'Printer');
    setEditingFleetUnitImageDataUrl(null);
  }, [editingFleetUnit]);

  const handleFleetUnitImageUploadChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      const normalized = await normalizeUploadedPrinterImageDataUrl(result);
      setEditingFleetUnitImageDataUrl(normalized);
    };
    reader.readAsDataURL(file);
  }, []);

  React.useEffect(() => {
    if (!isNetworkSettingsOpen) return;
    if (!selectedPrinterSupportsNetworkSettings) return;
    if (!networkUiAdapter) return;
    if (!networkDiscoveryEnabled) return;
    if (!isAddingNetworkPrinter && managedNetworkPrinters.length > 0) return;
    if (isNetworkScanning) return;
    if (hasAutoScannedOnOpen) return;

    setHasAutoScannedOnOpen(true);
    void handleRunNetworkDiscovery();
  }, [
    handleRunNetworkDiscovery,
    hasAutoScannedOnOpen,
    isNetworkScanning,
    isNetworkSettingsOpen,
    networkDiscoveryEnabled,
    isAddingNetworkPrinter,
    networkUiAdapter,
    managedNetworkPrinters.length,
    selectedPrinter?.networkSupport,
    selectedPrinterSupportsNetworkSettings,
  ]);

  React.useEffect(() => {
    if (!isMaterialEditorOpen || !selectedMaterial) return;
    setMaterialEditorTab(replacementMaterialEditorDefaultTab);
    setEditMaterialDraft({
      name: selectedMaterial.name,
      brand: selectedMaterial.brand,
      currencyCode: selectedMaterial.currencyCode || 'USD',
      bottlePrice: selectedMaterial.bottlePrice,
      bottleCapacityMl: selectedMaterial.bottleCapacityMl,
      resinFamily: selectedMaterial.resinFamily,
      scaleCompensationPct: {
        x: selectedMaterial.scaleCompensationPct.x,
        y: selectedMaterial.scaleCompensationPct.y,
        z: selectedMaterial.scaleCompensationPct.z,
      },
      layerHeightMm: selectedMaterial.layerHeightMm,
      normalExposureSec: selectedMaterial.normalExposureSec,
      bottomExposureSec: selectedMaterial.bottomExposureSec,
      bottomLayerCount: selectedMaterial.bottomLayerCount,
      liftDistanceMm: selectedMaterial.liftDistanceMm,
      liftSpeedMmMin: selectedMaterial.liftSpeedMmMin,
      retractSpeedMmMin: selectedMaterial.retractSpeedMmMin,
      minimumAaAlphaPercent: selectedMaterial.minimumAaAlphaPercent,
    });
    if (selectedPrinter) {
      setEditMaterialLocalSettingsByOutput(
        mergeWithLocalSettingsDefaults(
          selectedPrinter.display.outputFormat,
          selectedResolvedSettingsMode,
          selectedMaterial.localSettingsByOutput,
        ),
      );
    }
  }, [isMaterialEditorOpen, replacementMaterialEditorDefaultTab, selectedMaterial, selectedPrinter, selectedResolvedSettingsMode]);

  const handlePickPrinter = React.useCallback((printerId: string) => {
    setSelectedPrinterId(printerId);
    setIsEditingPrinter(false);
    setActivePrinterProfile(printerId);
    const materials = getMaterialProfilesForPrinter(printerId, getProfileStoreSnapshot());
    const first = materials[0] ?? null;
    setSelectedMaterialId(first?.id ?? null);
    if (first) setActiveMaterialProfile(first.id);
  }, []);

  const handleAddPrinter = React.useCallback(() => {
    setShowPresetPicker(true);
  }, []);

  const handleAddPrinterFromPreset = React.useCallback((presetId: string) => {
    const newId = addPrinterProfileFromPreset(presetId);
    handlePickPrinter(newId);
    setShowPresetPicker(false);
    setPresetSearch('');
    if (presetManufacturers.length > 0) setSelectedPresetManufacturer(presetManufacturers[0]);
  }, [handlePickPrinter, presetManufacturers]);

  const requestDeleteSelectedPrinter = React.useCallback(() => {
    if (!selectedPrinter) return;
    setDeleteConfirmTarget({ kind: 'printer', id: selectedPrinter.id, name: selectedPrinter.name });
  }, [selectedPrinter]);

  const handleAddMaterial = React.useCallback(() => {
    if (!selectedPrinter) return;
    setMaterialEditorTab('meta');
    setNewMaterialDraft({
      name: `Material ${printerMaterials.length + 1}`,
      brand: selectedManufacturerValue ?? 'Default',
      currencyCode: 'USD',
      bottlePrice: 0,
      bottleCapacityMl: 1000,
      resinFamily: selectedResinFamilyValue ?? 'standard',
      scaleCompensationPct: { x: 0, y: 0, z: 0 },
      layerHeightMm: 0.05,
      normalExposureSec: 2.5,
      bottomExposureSec: 28,
      bottomLayerCount: 5,
      liftDistanceMm: 6,
      liftSpeedMmMin: 60,
      retractSpeedMmMin: 150,
      minimumAaAlphaPercent: 35,
    });
    setNewMaterialLocalSettingsByOutput(
      resolveDefaultLocalSettingsForOutput(
        selectedPrinter.display.outputFormat,
        selectedResolvedSettingsMode,
      ),
    );
    setIsCreateMaterialOpen(true);
  }, [printerMaterials.length, replacementMaterialEditorDefaultTab, selectedPrinter, selectedManufacturerValue, selectedResinFamilyValue, selectedResolvedSettingsMode]);

  const handleCreateMaterial = React.useCallback(() => {
    if (!selectedPrinter) return;

    const newId = addMaterialProfile(selectedPrinter.id, {
      ...newMaterialDraft,
      name: newMaterialDraft.name.trim() || `Material ${printerMaterials.length + 1}`,
      brand: newMaterialDraft.brand.trim() || 'Default',
      localSettingsByOutput: newMaterialLocalSettingsByOutput,
    });

    setSelectedManufacturer((newMaterialDraft.brand || 'Default').trim() || 'Default');
    setSelectedResinFamily(newMaterialDraft.resinFamily);
    setSelectedMaterialId(newId);
    setActiveMaterialProfile(newId);
    setIsCreateMaterialOpen(false);
  }, [newMaterialDraft, newMaterialLocalSettingsByOutput, printerMaterials.length, selectedPrinter]);

  const requestDeleteSelectedMaterial = React.useCallback(() => {
    if (!selectedMaterial) return;
    setDeleteConfirmTarget({ kind: 'material', id: selectedMaterial.id, name: selectedMaterial.name });
  }, [selectedMaterial]);

  const openSelectedMaterialEditor = React.useCallback(() => {
    if (!selectedMaterial) return;
    setIsMaterialEditorOpen(true);
  }, [selectedMaterial]);

  const handleConfirmDelete = React.useCallback(() => {
    if (!deleteConfirmTarget) return;

    if (deleteConfirmTarget.kind === 'printer') {
      removePrinterProfile(deleteConfirmTarget.id);
    } else {
      removeMaterialProfile(deleteConfirmTarget.id);
    }

    setDeleteConfirmTarget(null);
  }, [deleteConfirmTarget]);

  const handleSaveMaterialEdits = React.useCallback(() => {
    if (!selectedMaterial) return;

    updateMaterialProfile(selectedMaterial.id, {
      ...editMaterialDraft,
      name: editMaterialDraft.name.trim() || selectedMaterial.name,
      brand: editMaterialDraft.brand.trim() || 'Default',
      currencyCode: editMaterialDraft.currencyCode.trim().toUpperCase() || 'USD',
      localSettingsByOutput: editMaterialLocalSettingsByOutput,
    });

    setIsMaterialEditorOpen(false);
  }, [editMaterialDraft, editMaterialLocalSettingsByOutput, selectedMaterial]);

  const handleApplySelectedPrinterOfficialUpdate = React.useCallback(() => {
    if (!selectedPrinterUpdate) return;
    const result = applyOfficialPrinterProfileUpdate(selectedPrinterUpdate.printerProfileId);

    if (result === 'updated') {
      setOfficialUpdateStatusMessage(`Updated printer profile to v${selectedPrinterUpdate.latestVersion}.`);
      return;
    }

    if (result === 'version-bumped-custom') {
      setOfficialUpdateStatusMessage('Custom profile kept unchanged for safety. Baseline version marker was updated.');
      return;
    }

    if (result === 'already-latest') {
      setOfficialUpdateStatusMessage('Selected printer profile is already on the latest official version.');
      return;
    }

    setOfficialUpdateStatusMessage('Unable to apply printer update (profile is no longer linked to an official preset).');
  }, [selectedPrinterUpdate]);

  const handleApplySelectedMaterialOfficialUpdate = React.useCallback(() => {
    if (!selectedMaterialUpdate) return;
    const result = applyOfficialMaterialProfileUpdate(selectedMaterialUpdate.materialProfileId);

    if (result === 'updated') {
      setOfficialUpdateStatusMessage(`Updated material profile to v${selectedMaterialUpdate.latestVersion}.`);
      return;
    }

    if (result === 'version-bumped-custom') {
      setOfficialUpdateStatusMessage('Custom material kept unchanged for safety. Baseline version marker was updated.');
      return;
    }

    if (result === 'already-latest') {
      setOfficialUpdateStatusMessage('Selected material profile is already on the latest official version.');
      return;
    }

    setOfficialUpdateStatusMessage('Unable to apply material update (profile is no longer linked to an official template).');
  }, [selectedMaterialUpdate]);

  const handleDuplicateSelectedPrinterAsCustom = React.useCallback(() => {
    if (!selectedPrinter) return;
    const newId = duplicatePrinterProfileAsCustom(selectedPrinter.id);
    handlePickPrinter(newId);
    setIsEditingPrinter(true);
  }, [handlePickPrinter, selectedPrinter]);

  const showOfficialProfileDialog = React.useCallback((profileId: string) => {
    setOfficialLockedProfileId(profileId);
    setShowOfficialLockDialog(true);
  }, []);

  const handleDuplicateOfficialProfile = React.useCallback(() => {
    if (!officialLockedProfileId) return;
    const newId = duplicatePrinterProfileAsCustom(officialLockedProfileId);
    handlePickPrinter(newId);
    setShowOfficialLockDialog(false);
    setOfficialLockedProfileId(null);
    setIsEditingPrinter(true);
  }, [officialLockedProfileId, handlePickPrinter]);

  const triggerImageUpload = React.useCallback((printerId: string) => {
    setUploadTargetPrinterId(printerId);
    imageUploadInputRef.current?.click();
  }, []);

  const handleImageUploadChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const printerId = uploadTargetPrinterId;
    const file = event.target.files?.[0];
    event.currentTarget.value = '';
    if (!printerId || !file) return;
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      const normalized = await normalizeUploadedPrinterImageDataUrl(result);
      updatePrinterProfile(printerId, { imageDataUrl: normalized });
    };
    reader.readAsDataURL(file);
  }, [uploadTargetPrinterId]);

  const handleExportSelectedPrinterBundle = React.useCallback(() => {
    void (async () => {
      if (!selectedPrinter) return;
      const snapshot = getProfileStoreSnapshot();
      const printer = snapshot.printerProfiles.find((item) => item.id === selectedPrinter.id);
      if (!printer) return;

      const materials = getMaterialProfilesForPrinter(printer.id, snapshot);
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        printer,
        materials,
      };

      const safeName = printer.name.replace(/[^a-z0-9-_]+/gi, '_').toLowerCase();
      const suggestedFilename = `${safeName || 'printer-profile'}-bundle.json`;
      const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));

      try {
        await savePrintArtifactWithNativeDialog(bytes, suggestedFilename);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message.toLowerCase().includes('cancel')) return;
        throw error;
      }
    })();
  }, [selectedPrinter]);

  const handleImportSelectedPrinterBundle = React.useCallback(() => {
    void (async () => {
      try {
        const picked = await pickOpenFilesWithNativeDialog('bundle', false);
        const sourcePath = picked[0]?.path?.trim();
        if (!sourcePath) return;

        const bytes = await readPrintArtifactBytesFromPath(sourcePath);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        importPrinterBundle(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message.toLowerCase().includes('cancel')) return;
        console.warn('[ProfileSettingsModal] Failed to import printer bundle', error);
      }
    })();
  }, []);

  const renderPresetLibraryCard = React.useCallback((preset: (typeof availablePrinterPresets)[number]) => {
    const isAlreadyAdded = addedOfficialPresetIds.has(preset.presetId);
    const isGenericPreset = preset.manufacturer.toLowerCase() === 'generic'
      || preset.name.toLowerCase().includes('generic');
    const platformBadge = preset.platformBadge?.text?.trim()
      ? preset.platformBadge
      : undefined;
    const bitDepthBits = Number.isFinite(Number(preset.bitDepth?.bits))
      ? Math.round(Number(preset.bitDepth?.bits))
      : null;
    const bitDepthLabel = bitDepthBits != null && bitDepthBits !== 8
      ? `${bitDepthBits} Bit`
      : null;

    return (
      <button
        key={preset.presetId}
        type="button"
        disabled={isAlreadyAdded}
        onClick={() => handleAddPrinterFromPreset(preset.presetId)}
        className="rounded-lg border p-2.5 text-left disabled:opacity-55"
        style={{
          borderColor: isAlreadyAdded
            ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)'
            : 'var(--border-subtle)',
          background: isAlreadyAdded
            ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)'
            : 'var(--surface-1)',
        }}
      >
        <div className="h-[136px] rounded-md border overflow-hidden flex items-center justify-center relative" style={{ borderColor: 'var(--border-subtle)', background: '#2b3039' }}>
          {preset.imageAssetPath ? (
            <AutoTrimmedImage src={preset.imageAssetPath} alt={preset.name} className="h-full w-full object-contain" />
          ) : (
            isGenericPreset
              ? <Printer className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
              : <ImagePlus className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
          )}
          {platformBadge && (
            <span
              className="pointer-events-none absolute top-1 right-1 z-10 inline-flex h-[18px] min-w-[44px] items-center justify-center whitespace-nowrap rounded-md px-1.5 text-[9px] font-bold leading-none"
              style={{
                background: `linear-gradient(135deg, color-mix(in srgb, ${platformBadge.color || '#0ea5e9'}, white 14%), color-mix(in srgb, ${platformBadge.color || '#0ea5e9'}, black 18%))`,
                color: '#ffffff',
                letterSpacing: '0.04em',
              }}
            >
              <span className="relative top-[0.5px]">{platformBadge.text}</span>
            </span>
          )}
          {bitDepthLabel && (
            <span
              className="pointer-events-none absolute bottom-1 right-1 z-10 inline-flex h-[18px] items-center justify-center whitespace-nowrap rounded-md border px-1.5 text-[9px] font-bold leading-none"
              style={{
                borderColor: bitDepthBits === 8
                  ? 'color-mix(in srgb, #22c55e, white 22%)'
                  : bitDepthBits === 3
                    ? 'color-mix(in srgb, #ef4444, white 18%)'
                    : 'color-mix(in srgb, var(--accent-secondary), white 20%)',
                color: '#f8fafc',
                background: bitDepthBits === 8
                  ? 'linear-gradient(135deg, color-mix(in srgb, #22c55e, #111827 56%), color-mix(in srgb, #22c55e, #0b1220 72%))'
                  : bitDepthBits === 3
                    ? 'linear-gradient(135deg, color-mix(in srgb, #ef4444, #111827 56%), color-mix(in srgb, #ef4444, #0b1220 72%))'
                    : 'linear-gradient(135deg, color-mix(in srgb, var(--accent-secondary), #111827 52%), color-mix(in srgb, var(--accent-secondary), #0b1220 68%))',
              }}
              title={preset.bitDepth?.description || `${bitDepthLabel} display`}
            >
              {bitDepthLabel}
            </span>
          )}
        </div>
        <div className="mt-2 text-[12px] font-semibold leading-tight flex items-center justify-between gap-2" style={{ color: 'var(--text-strong)' }}>
          <span className="truncate">{preset.name}</span>
          <span className="shrink-0 inline-flex items-center gap-1">
            {isAlreadyAdded && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)', color: 'var(--accent-secondary)' }}>
                Added
              </span>
            )}
          </span>
        </div>
        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {preset.manufacturer}
        </div>
      </button>
    );
  }, [addedOfficialPresetIds, availablePrinterPresets, handleAddPrinterFromPreset]);

  if (!isOpen) return null;
  const hasPrinters = profileState.printerProfiles.length > 0;
  const isCustomSelectedPrinter = Boolean(selectedPrinter?.isCustom && !selectedPrinter?.isOfficial);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/58 backdrop-blur-sm p-5 ui-modal-backdrop-enter"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`w-full max-w-[1120px] flex flex-col rounded-xl border shadow-2xl overflow-hidden ui-modal-panel-enter ${hasPrinters ? 'h-full' : 'self-center h-[700px] max-h-[94vh]'}`}
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-strong)',
          boxShadow: '0 26px 54px rgba(0,0,0,0.48)',
        }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent), var(--surface-1) 86%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%))',
              }}
            >
              <Box className="w-4 h-4" style={{ color: 'var(--accent)' }} />
            </span>
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
              Printer & Material Profiles
            </h2>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
            aria-label="Close"
            type="button"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className={`px-4 py-3 custom-scrollbar ${hasPrinters ? 'flex-1 min-h-0 overflow-hidden flex' : 'flex-1 min-h-0 overflow-hidden flex'}`}>
          <div className={`flex flex-col gap-3 ${hasPrinters ? 'w-full min-h-0 flex-1' : 'w-full h-full min-h-0'}`}>
          {isCustomSelectedPrinter && (
            <div
              className="rounded-lg border px-3 py-2 text-xs flex items-start gap-2"
              style={{
                borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 30%)',
                background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 92%)',
                color: 'var(--text-muted)',
              }}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: '#f59e0b' }} />
              <span>
                <strong style={{ color: 'var(--text-strong)' }}>Safety warning:</strong> Custom, non-official profiles may increase the risk of print failure and can potentially damage the machine or cause personal injury. Verify all settings carefully before printing.
              </span>
            </div>
          )}
          {(officialPrinterUpdates.length > 0 || officialMaterialUpdates.length > 0) && (
            <div
              className="rounded-lg border px-3 py-2 text-xs flex items-start gap-2"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 34%)',
                background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                color: 'var(--text-muted)',
              }}
            >
              <Download className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--accent-secondary)' }} />
              <span>
                <strong style={{ color: 'var(--text-strong)' }}>Official profile updates found:</strong>{' '}
                {officialPrinterUpdates.length} printer profile{officialPrinterUpdates.length === 1 ? '' : 's'} and{' '}
                {officialMaterialUpdates.length} material profile{officialMaterialUpdates.length === 1 ? '' : 's'} have newer official versions available.
              </span>
            </div>
          )}
          {officialUpdateStatusMessage && (
            <div
              className="rounded-lg border px-3 py-2 text-xs"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 34%)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 94%)',
                color: 'var(--text-muted)',
              }}
            >
              {officialUpdateStatusMessage}
            </div>
          )}
          {!hasPrinters && (
            <div
              className="rounded-xl border flex-1 h-full min-h-0 flex items-center justify-center px-4 py-10"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-2), transparent 4%), color-mix(in srgb, var(--surface-2), black 8%))',
              }}
            >
              <div className="text-center max-w-[520px]">
                <div
                  className="inline-flex h-14 w-14 items-center justify-center rounded-full border mb-3"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 22%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                  }}
                >
                  <Printer className="w-6 h-6" style={{ color: 'var(--accent)' }} />
                </div>

                <h4 className="text-2xl font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Welcome to Printer Profiles
                </h4>
                <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  Add your first printer from the library to unlock a tailored materials list and printer-specific defaults.
                </p>

                <button
                  type="button"
                  onClick={handleAddPrinter}
                  className="ui-button ui-button-secondary mt-5 !h-10 !px-4 !py-0 text-sm inline-flex items-center justify-center gap-1.5 rounded-md"
                  style={{
                    color: 'var(--accent-secondary)',
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                  }}
                >
                  <Plus className="w-4 h-4" />
                  Printer Library
                </button>
              </div>
            </div>
          )}

          {hasPrinters && (
          <section className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 8%), var(--surface-1))' }}>
            <div className="p-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-strong)' }}>
                    <Box className="w-4 h-4" />
                    {printerSectionTitle}
                  </h3>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {shouldRenderFleetRail
                      ? `Showing connected devices for ${selectedPrinter?.name ?? 'selected profile'}.`
                      : 'Each printer can store its own image and has a dedicated set of compatible resin/material profiles.'}
                  </p>
                  {selectedPrinterUpdate && (
                    <p className="text-[11px] mt-1" style={{ color: 'var(--accent-secondary)' }}>
                      Update available for this printer profile (v{selectedPrinterUpdate.currentVersion} → v{selectedPrinterUpdate.latestVersion}).
                    </p>
                  )}
                </div>

                {!shouldRenderFleetRail && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => moveSelectedPrinterInRail(-1)}
                      disabled={!selectedPrinter || selectedPrinterRailIndex <= 0}
                      className="ui-button ui-button-secondary !h-8 !w-8 !px-0 !py-0 inline-flex items-center justify-center rounded-md disabled:opacity-45"
                      style={{
                        color: 'var(--text-muted)',
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                      }}
                      aria-label="Move selected printer left"
                      title="Move selected printer left"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSelectedPrinterInRail(1)}
                      disabled={!selectedPrinter || selectedPrinterRailIndex < 0 || selectedPrinterRailIndex >= profileState.printerProfiles.length - 1}
                      className="ui-button ui-button-secondary !h-8 !w-8 !px-0 !py-0 inline-flex items-center justify-center rounded-md disabled:opacity-45"
                      style={{
                        color: 'var(--text-muted)',
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                      }}
                      aria-label="Move selected printer right"
                      title="Move selected printer right"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={handleAddPrinter}
                      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md shrink-0"
                      style={shouldShowFleetSwitchAction
                        ? {
                            color: 'var(--accent-secondary)',
                            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                          }
                        : {
                            color: 'var(--accent-secondary)',
                            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)',
                          }}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Printer Library
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="p-3">
              <div
                className={`grid grid-cols-5 gap-2.5 pb-1 ${shouldConstrainPrinterRailHeight ? 'max-h-[392px] overflow-y-auto pr-1' : ''}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (printerDragId) {
                    moveDraggedPrinter(printerDragId, null);
                    setPrinterDragId(null);
                  }
                }}
              >
                {shouldRenderFleetRail
                  ? managedNetworkPrinters.map((device) => {
                    const active = selectedPrinter?.activeNetworkDeviceId === device.id;
                    const reachable = printerReachabilityByDeviceId[device.id] !== false;
                    const online = device.connected === true && reachable;
                    const cardTitle = device.displayName || device.hostName || device.ipAddress;
                    const statusLabel = online ? 'Online' : device.connected ? 'Limited' : 'Offline';

                    return renderPrinterRailCard({
                      key: device.id,
                      active,
                      onClick: () => handleSelectManagedPrinter(device),
                      onDoubleClick: () => {
                        handleSelectManagedPrinter(device);
                        setIsEditingPrinter(true);
                      },
                      imageDataUrl: device.imageDataUrl,
                      imageAlt: cardTitle,
                      useTrimmedImage: false,
                      imageFitClassName: 'object-cover',
                      imageInsetClassName: 'inset-0',
                      imageFallback: (
                        <>
                          {online ? <Wifi className="w-5 h-5 mx-auto mb-1" /> : <WifiOff className="w-5 h-5 mx-auto mb-1" />}
                          {online ? 'Online' : 'Offline'}
                        </>
                      ),
                      imageOverlay: (
                        <div className="pointer-events-none absolute top-1 left-1 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border"
                          style={{
                            borderColor: online
                              ? 'color-mix(in srgb, #22c55e, white 12%)'
                              : 'color-mix(in srgb, var(--border-subtle), #ef4444 18%)',
                            background: online
                              ? 'color-mix(in srgb, #22c55e, #0f172a 40%)'
                              : 'color-mix(in srgb, #ef4444, #0f172a 78%)',
                          }}
                        >
                          {online
                            ? <Wifi className="w-3.5 h-3.5" style={{ color: '#dcfce7' }} />
                            : <WifiOff className="w-3.5 h-3.5" style={{ color: '#fecaca' }} />}
                        </div>
                      ),
                      topBadge: (
                        <span
                          className="pointer-events-none absolute top-1 right-1 z-10 inline-flex h-[18px] min-w-[44px] items-center justify-center whitespace-nowrap rounded-md px-1.5 text-[9px] font-bold leading-none"
                          style={online
                            ? {
                                background: 'linear-gradient(135deg, #22c55e, #15803d)',
                                color: '#ffffff',
                                letterSpacing: '0.04em',
                              }
                            : {
                                background: 'linear-gradient(135deg, #ef4444, #b91c1c)',
                                color: '#ffffff',
                                letterSpacing: '0.04em',
                              }}
                        >
                          <span className="relative top-[0.5px]">{statusLabel}</span>
                        </span>
                      ),
                      bottomRightBadge: null,
                      title: cardTitle,
                      subtitle: device.ipAddress,
                      footer: null,
                      activeStyles: {
                        borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 28%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                      },
                      inactiveStyles: {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-2)',
                      },
                    });
                  })
                  : profileState.printerProfiles.map((printer) => {
                  const active = printer.id === selectedPrinter?.id;
                  const isGenericPrinter = (printer.manufacturer ?? '').toLowerCase() === 'generic'
                    || printer.name.toLowerCase().includes('generic');
                  const activeDeviceReachability = printer.activeNetworkDeviceId
                    ? printerReachabilityByDeviceId[printer.activeNetworkDeviceId]
                    : null;
                  const hasConfiguredNetworkTarget = Boolean(
                    printer.networkSupport
                    && (printer.networkConnection?.ipAddress || printer.network?.ipAddress || printer.activeNetworkDeviceId),
                  );
                  const isNetworkConnected = printer.networkConnection?.connected === true && activeDeviceReachability !== false;
                  const isNetworkOffline = hasConfiguredNetworkTarget && !isNetworkConnected;
                  const supportsNetworkFleet = Boolean(printer.networkSupport);
                  const fleetCount = printer.networkFleet?.length ?? 0;
                  const platformBadge = printer.platformBadge?.text?.trim()
                    ? printer.platformBadge
                    : undefined;
                  const cardBadgeText = printer.isCustom
                    ? 'CUSTOM'
                    : platformBadge?.text;
                  const bitDepthBits = Number.isFinite(Number(printer.bitDepth?.bits))
                    ? Math.round(Number(printer.bitDepth?.bits))
                    : null;
                  const bitDepthLabel = bitDepthBits != null && bitDepthBits !== 8
                    ? `${bitDepthBits} Bit`
                    : null;

                  return renderPrinterRailCard({
                    key: printer.id,
                    active,
                    draggable: true,
                    dragging: printerDragId === printer.id,
                    onClick: () => handlePickPrinter(printer.id),
                    onDoubleClick: () => {
                      handlePickPrinter(printer.id);
                      setIsEditingPrinter(true);
                    },
                    onDragStart: (event) => {
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', printer.id);
                      setPrinterDragId(printer.id);
                    },
                    onDragEnd: () => setPrinterDragId(null),
                    onDragOver: (event) => event.preventDefault(),
                    onDrop: (event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (printerDragId && printerDragId !== printer.id) {
                        moveDraggedPrinter(printerDragId, printer.id);
                      }
                      setPrinterDragId(null);
                    },
                    imageDataUrl: printer.imageDataUrl,
                    imageAlt: printer.name,
                    useTrimmedImage: true,
                    imageFitClassName: 'object-contain',
                    bottomRightBadge: bitDepthLabel ? (
                      <span
                        className="inline-flex h-[18px] items-center justify-center whitespace-nowrap rounded-md border px-1.5 text-[9px] font-bold leading-none"
                        style={{
                          borderColor: bitDepthBits === 3
                            ? 'color-mix(in srgb, #ef4444, white 18%)'
                            : 'color-mix(in srgb, var(--accent-secondary), white 20%)',
                          color: '#f8fafc',
                          background: bitDepthBits === 3
                            ? 'linear-gradient(135deg, color-mix(in srgb, #ef4444, #111827 56%), color-mix(in srgb, #ef4444, #0b1220 72%))'
                            : 'linear-gradient(135deg, color-mix(in srgb, var(--accent-secondary), #111827 52%), color-mix(in srgb, var(--accent-secondary), #0b1220 68%))',
                        }}
                        title={printer.bitDepth?.description || `${bitDepthLabel} display`}
                      >
                        <span className="relative top-[0.5px]">{bitDepthLabel}</span>
                      </span>
                    ) : null,
                    imageFallback: isGenericPrinter ? <><Printer className="w-5 h-5 mx-auto mb-1" />Generic</> : <><ImagePlus className="w-5 h-5 mx-auto mb-1" />No image</>,
                    imageOverlay: (isNetworkConnected || isNetworkOffline) ? (
                      <span
                        className="pointer-events-none absolute top-1 left-1 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border"
                        title={isNetworkConnected
                          ? `Connected to ${printer.networkConnection?.hostName || printer.networkConnection?.ipAddress || 'network printer'}`
                          : 'Printer not connected'}
                        style={isNetworkConnected
                          ? {
                              borderColor: 'color-mix(in srgb, #22c55e, white 12%)',
                              background: 'color-mix(in srgb, #22c55e, #0f172a 40%)',
                              color: '#dcfce7',
                            }
                          : {
                              borderColor: 'color-mix(in srgb, var(--border-subtle), #ef4444 18%)',
                              background: 'color-mix(in srgb, #ef4444, #0f172a 78%)',
                              color: '#fecaca',
                            }}
                      >
                        {isNetworkConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
                      </span>
                    ) : null,
                    topBadge: cardBadgeText ? (
                      <span
                        className="pointer-events-none absolute top-1 right-1 z-10 inline-flex h-[18px] min-w-[44px] items-center justify-center whitespace-nowrap rounded-md px-1.5 text-[9px] font-bold leading-none"
                        style={printer.isCustom
                          ? {
                              background: 'linear-gradient(135deg, #ef4444, #b91c1c)',
                              color: '#ffffff',
                              letterSpacing: '0.04em',
                            }
                          : {
                              background: `linear-gradient(135deg, color-mix(in srgb, ${platformBadge?.color || '#0ea5e9'}, white 14%), color-mix(in srgb, ${platformBadge?.color || '#0ea5e9'}, black 18%))`,
                              color: '#ffffff',
                              letterSpacing: '0.04em',
                            }}
                      >
                        <span className="relative top-[0.5px]">{cardBadgeText}</span>
                      </span>
                    ) : null,
                    title: printer.name,
                    subtitle: printer.manufacturer || 'Generic',
                    footer: supportsNetworkFleet ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handlePickPrinter(printer.id);
                          if (fleetCount > 1) {
                            setPrinterRailViewMode('fleet');
                            return;
                          }
                          setPrinterRailViewMode('profiles');
                          setIsAddingNetworkPrinter(true);
                          setShowManualNetworkEntry(false);
                          setIsNetworkSettingsOpen(true);
                        }}
                        aria-label={fleetCount > 1 ? `Open fleet view (${fleetCount})` : 'Add another networked device'}
                        className="ui-button ui-button-secondary !h-7 !w-7 !px-0 !py-0 text-[11px] inline-flex items-center justify-center rounded-md shrink-0"
                        style={fleetCount > 1
                          ? {
                              color: 'var(--text-strong)',
                              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
                              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                            }
                          : {
                              color: 'var(--accent-secondary)',
                              borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                              background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)',
                            }}
                        title={fleetCount > 1 ? `Switch to fleet view (${fleetCount})` : 'Add another networked device'}
                      >
                        {fleetCount > 1 ? (
                          <span className="grid h-full w-full place-items-center text-[12px] font-semibold leading-none tabular-nums">{fleetCount}</span>
                        ) : (
                          <Plus className="w-3.5 h-3.5" />
                        )}
                      </button>
                    ) : null,
                    activeStyles: {
                      borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 28%)',
                      background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                    },
                    inactiveStyles: {
                      borderColor: 'var(--border-subtle)',
                      background: 'var(--surface-2)',
                    },
                  });
                  })}
              </div>

              {shouldRenderFleetRail && managedNetworkPrinters.length === 0 && (
                <div
                  className="mt-2 rounded-lg border px-3 py-5 text-center"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <div className="text-xs">No fleet devices saved for this printer profile yet.</div>
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingNetworkPrinter(true);
                      setShowManualNetworkEntry(false);
                      setIsNetworkSettingsOpen(true);
                    }}
                    className="ui-button ui-button-secondary mt-2 !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                    style={{
                      color: 'var(--accent-secondary)',
                      borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                      background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)',
                    }}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add First Device
                  </button>
                </div>
              )}

              {hasPrinters && (
              <div className="mt-2.5 rounded-lg border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}>
                <div className="flex flex-wrap items-center gap-2">
                  {shouldRenderFleetRail ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setPrinterRailViewMode('profiles')}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={{
                          color: 'var(--accent-secondary)',
                          borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                          background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)',
                        }}
                      >
                        Return to Printers
                      </button>
                      <button
                        type="button"
                        onClick={handleOpenNetworkSettings}
                        disabled={!hasPrinters || !selectedPrinter}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        <Search className="w-3.5 h-3.5" />
                        Manage Fleet
                      </button>
                      <button
                        type="button"
                        onClick={handleOpenEditFleetUnitModal}
                        disabled={!activeManagedNetworkPrinter}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        Edit Unit
                      </button>
                    </>
                  ) : (
                    <>
                      {selectedPrinterSupportsNetworkSettings && (
                        <button
                          type="button"
                          onClick={() => {
                            if (shouldShowFleetSwitchAction) {
                              setPrinterRailViewMode('fleet');
                              return;
                            }
                            handleOpenNetworkSettings();
                          }}
                          disabled={!hasPrinters || !selectedPrinter}
                          className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                          style={shouldShowFleetSwitchAction
                            ? {
                                color: 'var(--accent-secondary)',
                                borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                                background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                              }
                            : { color: 'var(--text-strong)' }}
                        >
                          {shouldShowFleetSwitchAction ? <LayoutGrid className="w-3.5 h-3.5" /> : <Search className="w-3.5 h-3.5" />}
                          {regularNetworkActionLabel}
                        </button>
                      )}
                      {selectedPrinterUpdate && (
                        <button
                          type="button"
                          onClick={handleApplySelectedPrinterOfficialUpdate}
                          className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                          style={{
                            color: 'var(--accent-secondary)',
                            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                          }}
                          title={`Update v${selectedPrinterUpdate.currentVersion} to v${selectedPrinterUpdate.latestVersion}`}
                        >
                          <Download className="w-3.5 h-3.5" />
                          Update Printer
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          if (!selectedPrinter || !hasPrinters) return;
                          setIsEditingPrinter(true);
                        }}
                        disabled={!hasPrinters}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        Edit Printer
                      </button>
                      <button
                        type="button"
                        onClick={handleImportSelectedPrinterBundle}
                        disabled={!hasPrinters}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Import
                      </button>
                      <button
                        type="button"
                        onClick={handleExportSelectedPrinterBundle}
                        disabled={!hasPrinters}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        <Download className="w-3.5 h-3.5" />
                        Export
                      </button>
                      <button
                        type="button"
                        onClick={requestDeleteSelectedPrinter}
                        disabled={!hasPrinters}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45 ml-auto"
                        style={{ color: !hasPrinters ? 'var(--text-muted)' : '#fca5a5' }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete Printer
                      </button>
                    </>
                  )}
                </div>
              </div>
              )}
            </div>
          </section>
          )}

          {hasPrinters && selectedPrinter && (
          <section
            className="rounded-lg border overflow-hidden flex flex-col min-h-0 flex-1"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 8%), var(--surface-1))',
            }}
          >
            <div className="p-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-strong)' }}>
                    <FlaskConical className="w-4 h-4" />
                    Material Settings
                  </h3>
                  <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    {shouldUseRemoteOnDeviceMaterials
                      ? <>Connected {selectedNetworkModeLabel} profiles are loaded directly from <span style={{ color: 'var(--text-strong)' }}>{selectedPrinter.name}</span>. Selection is read-only for now.</>
                      : shouldShowRemoteMaterialSelectedPrinterOfflineState
                        ? <>Printer not connected. Reconnect the selected machine in Fleet Management, then refresh on-device materials.</>
                        : shouldShowRemoteMaterialConnectInfo
                          ? <>Connect to a machine to view on-device material profiles.</>
                          : <>Profiles below are bound to <span style={{ color: 'var(--text-strong)' }}>{selectedPrinter.name}</span> and follow the selected printer hardware.</>}
                  </p>
                  {selectedMaterialUpdate && (
                    <p className="text-[11px] mt-1" style={{ color: 'var(--accent-secondary)' }}>
                      Update available for selected material profile (v{selectedMaterialUpdate.currentVersion} → v{selectedMaterialUpdate.latestVersion}).
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {shouldUseRemoteOnDeviceMaterials && (
                    <>
                      <button
                        type="button"
                        onClick={openRemoteMaterialEditDialog}
                        disabled={!selectedRemoteMaterial}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => { void loadRemoteMaterials(); }}
                        disabled={isLoadingRemoteMaterials || !selectedRemoteMaterialHost}
                        className="ui-button ui-button-secondary !h-8 !w-8 !p-0 inline-flex items-center justify-center rounded-md disabled:opacity-45"
                        style={{ color: 'var(--text-strong)' }}
                        title="Refresh remote materials"
                        aria-label="Refresh remote materials"
                      >
                        {isLoadingRemoteMaterials ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                      </button>
                    </>
                  )}
                  {!shouldUseRemoteOnDeviceMaterials && !shouldShowRemoteMaterialSelectedPrinterOfflineState && !shouldShowRemoteMaterialConnectInfo && (
                    <>
                      <button
                        type="button"
                        onClick={openSelectedMaterialEditor}
                        disabled={!selectedMaterial}
                        className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={handleAddMaterial}
                        className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={{
                          color: 'var(--accent-secondary)',
                          borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                          background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)',
                        }}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Resin
                      </button>
                    </>
                  )}
                  {selectedMaterialUpdate && (
                    <button
                      type="button"
                      onClick={handleApplySelectedMaterialOfficialUpdate}
                      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                      style={{
                        color: 'var(--accent-secondary)',
                        borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                        background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                      }}
                      title={`Update v${selectedMaterialUpdate.currentVersion} to v${selectedMaterialUpdate.latestVersion}`}
                    >
                      <Download className="w-3.5 h-3.5" />
                      Update Material
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="p-3 flex flex-col gap-3 flex-1 min-h-0">
              {shouldUseRemoteOnDeviceMaterials ? (
                <>
                  <div className="rounded-xl border overflow-hidden flex flex-col flex-1 min-h-0" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                      {isLoadingRemoteMaterials ? (
                        <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                          Loading materials from printer…
                        </div>
                      ) : remoteMaterials.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                          {remoteMaterialsError || `No on-device materials were returned by this ${selectedNetworkModeLabel} host.`}
                        </div>
                      ) : (
                        remoteMaterials.map((material) => {
                          const active = selectedRemoteMaterialId === material.id;
                          const chips = buildRemoteMaterialChips(material, effectiveNetworkUiAdapter.resolveMaterialProcessValues);
                          return (
                            <button
                              key={material.id}
                              type="button"
                              onClick={() => handleSelectRemoteMaterial(material)}
                              onDoubleClick={() => openRemoteMaterialEditDialogForMaterial(material)}
                              className="w-full rounded-md border px-2.5 py-2 text-left"
                              style={active
                                ? {
                                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 89%)',
                                    color: 'var(--text-strong)',
                                  }
                                : {
                                    borderColor: 'var(--border-subtle)',
                                    background: 'var(--surface-1)',
                                    color: 'var(--text-muted)',
                                  }}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex-1">
                                  <span className="truncate text-sm font-semibold block">{material.name}</span>
                                  {chips.length > 0 && (
                                    <span className="flex flex-wrap gap-1 mt-1">
                                      {chips.map((chip) => (
                                        <span
                                          key={`${material.id}-${chip}`}
                                          className="text-[10px] rounded-full border px-1.5 py-0.5"
                                          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}
                                        >
                                          {chip}
                                        </span>
                                      ))}
                                    </span>
                                  )}
                                </div>
                                <span className="text-[10px]" style={{ color: material.locked ? '#fbbf24' : 'var(--text-muted)' }}>
                                  {material.locked ? 'Locked' : 'On device'}
                                </span>
                              </div>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>

                </>
              ) : shouldShowRemoteMaterialSelectedPrinterOfflineState ? (
                <div className="rounded-xl border flex-1 min-h-0 flex items-center justify-center px-4 py-5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="text-center max-w-[520px]">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border mb-3" style={{ borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 30%)', background: 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)' }}>
                      <WifiOff className="w-5 h-5" style={{ color: 'var(--danger)' }} />
                    </div>
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                      Printer Not Connected
                    </h4>
                    <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      A network printer is configured, but it is not responding right now. Reconnect it in Fleet Management, then refresh to load on-device materials.
                    </p>
                    {selectedPrinterSupportsNetworkSettings && (
                      <button
                        type="button"
                        onClick={handleOpenNetworkSettings}
                        className="ui-button ui-button-secondary mt-3 !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={{
                          color: 'var(--accent-secondary)',
                          borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                          background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)',
                        }}
                      >
                        <Search className="w-3.5 h-3.5" />
                        Open Fleet Management
                      </button>
                    )}
                    {remoteMaterialsError && (
                      <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {remoteMaterialsError}
                      </div>
                    )}
                  </div>
                </div>
              ) : shouldShowRemoteMaterialConnectInfo ? (
                <div className="rounded-xl border flex-1 min-h-0 flex items-center justify-center px-4 py-5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="text-center max-w-[520px]">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border mb-3" style={{ borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 30%)', background: 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)' }}>
                      <WifiOff className="w-5 h-5" style={{ color: 'var(--danger)' }} />
                    </div>
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                      Connect to a Machine
                    </h4>
                    <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Connect to a machine to view on-device material profiles.
                    </p>
                    {selectedPrinterSupportsNetworkSettings && (
                      <button
                        type="button"
                        onClick={handleOpenNetworkSettings}
                        className="ui-button ui-button-secondary mt-3 !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={{
                          color: 'var(--accent-secondary)',
                          borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                          background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)',
                        }}
                      >
                        <Search className="w-3.5 h-3.5" />
                        Connect Now
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <>
              <div className="rounded-xl border overflow-hidden flex flex-col flex-1 min-h-0" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                <div className="grid grid-cols-[1fr_1fr_1.25fr] flex-1 min-h-0 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="border-r min-h-0 flex flex-col" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Manufacturer</div>
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-1.5 space-y-1">
                      {availableManufacturers.map((manufacturer) => {
                        const active = selectedManufacturerValue === manufacturer;
                        return (
                          <button
                            key={manufacturer}
                            type="button"
                            onClick={() => {
                              setSelectedManufacturer(manufacturer);
                              setSelectedResinFamily(null);
                              setSelectedMaterialId(null);
                            }}
                            className="w-full rounded-md border px-2.5 py-2 text-left text-sm"
                            style={active
                              ? {
                                  borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 28%)',
                                  background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)',
                                  color: 'var(--text-strong)',
                                }
                              : {
                                  borderColor: 'var(--border-subtle)',
                                  background: 'var(--surface-1)',
                                  color: 'var(--text-muted)',
                                }}
                          >
                            {manufacturer}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="border-r min-h-0 flex flex-col" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Resin Type</div>
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-1.5 space-y-1">
                      {availableResinTypes.map((resinType) => {
                        const active = selectedResinFamilyValue === resinType;
                        const resinLabel = RESIN_FAMILY_OPTIONS.find((option) => option.value === resinType)?.label ?? resinType;
                        return (
                          <button
                            key={resinType}
                            type="button"
                            onClick={() => {
                              setSelectedResinFamily(resinType);
                              setSelectedMaterialId(null);
                            }}
                            className="w-full rounded-md border px-2.5 py-2 text-left text-sm"
                            style={active
                              ? {
                                  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                                  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 89%)',
                                  color: 'var(--text-strong)',
                                }
                              : {
                                  borderColor: 'var(--border-subtle)',
                                  background: 'var(--surface-1)',
                                  color: 'var(--text-muted)',
                                }}
                          >
                            {resinLabel}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="min-h-0 flex flex-col">
                    <div className="px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Profile</div>
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-1.5 space-y-1">
                      {filteredMaterialProfiles.map((material) => {
                        const active = selectedMaterial?.id === material.id;
                        return (
                          <button
                            key={material.id}
                            type="button"
                            onClick={() => {
                              setSelectedMaterialId(material.id);
                              setActiveMaterialProfile(material.id);
                            }}
                            onDoubleClick={() => {
                              setSelectedMaterialId(material.id);
                              setActiveMaterialProfile(material.id);
                              setIsMaterialEditorOpen(true);
                            }}
                            className="w-full rounded-md border px-2.5 py-2 text-left text-sm"
                            style={active
                              ? {
                                  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)',
                                  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 89%)',
                                  color: 'var(--text-strong)',
                                }
                              : {
                                  borderColor: 'var(--border-subtle)',
                                  background: 'var(--surface-1)',
                                  color: 'var(--text-muted)',
                                }}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="truncate font-semibold">{material.name}</span>
                              <span className="tabular-nums">{Math.round(material.layerHeightMm * 1000)}μm</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

                </>
              )}
            </div>
          </section>
          )}
          </div>
        </div>

        <input
          ref={imageUploadInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleImageUploadChange}
        />

        <input
          ref={fleetUnitImageUploadInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFleetUnitImageUploadChange}
        />

        {isEditFleetUnitModalOpen && selectedPrinter && editingFleetUnit && (
          <div className="fixed inset-0 z-[72] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsEditFleetUnitModalOpen(false);
          }}>
            <div className="w-full max-w-[760px] rounded-xl border shadow-2xl overflow-hidden ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Edit Unit</h3>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Customize nickname and card thumbnail for this fleet unit in DragonFruit.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsEditFleetUnitModalOpen(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close Edit Unit"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3">
                <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_340px] gap-3">
                  <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                    <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Unit Identity</div>
                    <div className="grid grid-cols-1 gap-2">
                      <LabeledInput
                        label="Nickname"
                        value={editingFleetUnitNickname}
                        onChange={setEditingFleetUnitNickname}
                      />
                      <LabeledInput
                        label="IP Address"
                        value={editingFleetUnit.ipAddress}
                        disabled
                        onChange={() => {}}
                      />
                    </div>

                    <div className="mt-2 rounded-md border px-2 py-1.5 text-[11px]" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'color-mix(in srgb, var(--surface-2), transparent 6%)' }}>
                      Reset will clear custom nickname + thumbnail and fall back to the device hostname/IP.
                    </div>
                  </div>

                  <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                    <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Card Thumbnail</div>
                    <div className="h-[220px] w-full rounded-md border overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: '#1c2027' }}>
                      {editingFleetUnitImageDataUrl ? (
                        <AutoTrimmedImage src={editingFleetUnitImageDataUrl} alt={editingFleetUnitNickname || editingFleetUnit.displayName || 'Fleet unit'} className="h-full w-full object-cover" />
                      ) : (
                        <div className="text-[11px] text-center px-3" style={{ color: 'var(--text-muted)' }}>
                          No custom image
                        </div>
                      )}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => fleetUnitImageUploadInputRef.current?.click()}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        <Upload className="w-3.5 h-3.5" />
                        Upload Image
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingFleetUnitImageDataUrl(null)}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                        style={{ color: editingFleetUnitImageDataUrl ? '#fca5a5' : 'var(--text-muted)' }}
                        disabled={!editingFleetUnitImageDataUrl}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Clear
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="px-3 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  type="button"
                  onClick={handleResetFleetUnitDraft}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                  style={{ color: '#fca5a5' }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Reset Unit
                </button>
                <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setIsEditFleetUnitModalOpen(false)}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveFleetUnitEdits}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                  style={{
                    color: 'var(--accent-secondary)',
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                  }}
                >
                  <Check className="w-3.5 h-3.5" />
                  Save Unit
                </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {showPresetPicker && (
          <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowPresetPicker(false);
          }}>
            <div className="w-full max-w-[1040px] h-[94vh] max-h-[90vh] min-h-[620px] rounded-xl border shadow-2xl overflow-hidden ui-modal-panel-enter flex flex-col" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Printer Library</h3>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Choose an official printer preset to add.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPresetPicker(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close printer library"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-[220px_minmax(0,1fr)] grid-rows-[1fr] min-h-[620px] flex-1 min-h-0 overflow-hidden">
                <div className="border-r flex flex-col min-h-0" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
                  <div className="p-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="relative">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 pointer-events-none" style={{ color: 'var(--text-muted)' }} />
                      <input
                        value={presetSearch}
                        onChange={(event) => setPresetSearch(event.target.value)}
                        placeholder="Search printers"
                        className="ui-input w-full h-8 text-xs"
                        style={{ paddingLeft: '2.5rem', paddingRight: '0.625rem' }}
                      />
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-1.5 space-y-1">
                    {presetManufacturers.map((manufacturer) => (
                      <button
                        key={manufacturer}
                        type="button"
                        onClick={() => setSelectedPresetManufacturer(manufacturer)}
                        className="w-full rounded-md border px-2.5 py-2 text-left text-sm font-semibold"
                        style={selectedPresetManufacturer === manufacturer
                          ? {
                              borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)',
                              background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 88%)',
                              color: 'var(--text-strong)',
                            }
                          : {
                              borderColor: 'var(--border-subtle)',
                              background: 'var(--surface-1)',
                              color: 'var(--text-muted)',
                            }}
                      >
                        {manufacturer}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="p-3 overflow-y-auto custom-scrollbar min-h-0">
                  {isSearching ? (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-2.5">
                      {filteredPrinterPresets.map(renderPresetLibraryCard)}
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {groupedFilteredPrinterPresets.map((group) => (
                        <section key={`${selectedPresetManufacturer}-${group.family}`} className="space-y-1.5">
                          <div className="px-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                            {group.family}
                          </div>
                          <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-2.5">
                            {group.presets.map(renderPresetLibraryCard)}
                          </div>
                        </section>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {isMaterialEditorOpen && selectedMaterial && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsMaterialEditorOpen(false);
          }}>
            <div className="w-full max-w-[920px] max-h-[88vh] rounded-xl border shadow-2xl ui-modal-panel-enter flex flex-col" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {usePluginLocalSettingsAsReplacement && replacementMaterialModalLabel
                      ? `Edit ${replacementMaterialModalLabel} Resin Profile`
                      : 'Resin Profile Settings'}
                  </h3>
                  <p className="ui-meta">{selectedMaterial.name} • {selectedMaterial.brand}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsMaterialEditorOpen(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close resin editor"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 space-y-3 overflow-y-auto custom-scrollbar flex-1">
                {usePluginLocalSettingsAsReplacement ? (
                  <ReplacementMaterialEditorShell
                    tabs={replacementMaterialEditorTabs}
                    activeTabId={materialEditorTab}
                    onActiveTabChange={setMaterialEditorTab}
                    draft={editMaterialDraft}
                    onDraftChange={setEditMaterialDraft}
                    outputFormat={selectedPrinter?.display.outputFormat ?? '.lys'}
                    settingsMode={selectedResolvedSettingsMode}
                    adapter={selectedLocalMaterialSettingsAdapter}
                    localSettingsByOutput={editMaterialLocalSettingsByOutput}
                    onLocalSettingsByOutputChange={setEditMaterialLocalSettingsByOutput}
                  />
                ) : (
                  <>
                    <MaterialProfileFormSections draft={editMaterialDraft} onChange={setEditMaterialDraft} />
                    <PluginLocalMaterialSettingsSections
                      outputFormat={selectedPrinter?.display.outputFormat ?? '.lys'}
                      settingsMode={selectedResolvedSettingsMode}
                      adapter={selectedLocalMaterialSettingsAdapter}
                      localSettingsByOutput={editMaterialLocalSettingsByOutput}
                      onChange={setEditMaterialLocalSettingsByOutput}
                      replacementMode={usePluginLocalSettingsAsReplacement}
                    />
                  </>
                )}
              </div>

              <div className="px-3 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  type="button"
                  onClick={() => {
                    requestDeleteSelectedMaterial();
                    setIsMaterialEditorOpen(false);
                  }}
                  disabled={!selectedMaterial || printerMaterials.length <= 1}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-full disabled:opacity-45"
                  style={{ color: !selectedMaterial || printerMaterials.length <= 1 ? 'var(--text-muted)' : '#fca5a5' }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Resin
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsMaterialEditorOpen(false)}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveMaterialEdits}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-full"
                    style={{ color: 'var(--accent-secondary)' }}
                  >
                    <Check className="w-3.5 h-3.5" />
                    Save Resin
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {isEditingPrinter && selectedPrinter && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsEditingPrinter(false);
          }}>
            <div className="w-full max-w-[960px] max-h-[88vh] rounded-xl border shadow-2xl ui-modal-panel-enter flex flex-col" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Printer Profile Settings
                  </h3>
                  <p className="ui-meta">{selectedPrinter.name} • {selectedPrinter.manufacturer || 'Generic'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsEditingPrinter(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close printer editor"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 space-y-3 overflow-y-auto custom-scrollbar flex-1">
                {isSelectedPrinterOfficial && (
                  <div className="rounded-xl border p-3" style={{ borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 36%)', background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 92%)' }}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--text-strong)' }}>
                          <AlertTriangle className="w-4 h-4" style={{ color: '#f59e0b' }} />
                          Official Profile — Edits Limited!
                        </div>
                        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          You can change Output Format, Network Support, Format Version, and Webcam Support here. Everything else stays locked unless you make a custom copy.
                        </div>
                        <div className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                          <strong style={{ color: 'var(--text-strong)' }}>Warning:</strong> Custom, non-official profiles may increase the risk of print failure and can potentially damage the machine or cause personal injury.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          void handleDuplicateSelectedPrinterAsCustom();
                        }}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                        style={{ color: 'var(--accent-secondary)' }}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Create Custom Copy
                      </button>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Identity</div>
                  <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_240px] gap-3 md:items-stretch">
                    <div className="space-y-3">
                      <LabeledInput
                        label="Printer Name"
                        value={selectedPrinter.name}
                        disabled={isSelectedPrinterOfficial}
                        onChange={(value) => updatePrinterProfile(selectedPrinter.id, { name: value })}
                      />

                      <LabeledInput
                        label="Manufacturer"
                        value={selectedPrinter.manufacturer ?? ''}
                        disabled={isSelectedPrinterOfficial}
                        onChange={(value) => updatePrinterProfile(selectedPrinter.id, { manufacturer: value })}
                      />

                      <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}>
                        <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Profile Image</div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() => triggerImageUpload(selectedPrinter.id)}
                            disabled={isSelectedPrinterOfficial}
                            className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                            style={{ color: isSelectedPrinterOfficial ? 'var(--text-muted)' : 'var(--text-strong)' }}
                          >
                            <Upload className="w-3.5 h-3.5" />
                            Upload Image
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!selectedPrinter.imageDataUrl) return;
                              updatePrinterProfile(selectedPrinter.id, { imageDataUrl: undefined });
                            }}
                            disabled={isSelectedPrinterOfficial || !selectedPrinter.imageDataUrl}
                            className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                            style={{ color: selectedPrinter.imageDataUrl ? '#fca5a5' : 'var(--text-muted)' }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            Clear Image
                          </button>
                        </div>
                        <p className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          Tip: use a front/angled photo for faster visual identification.
                        </p>
                      </div>
                    </div>

                    <div className="rounded-lg border p-2.5 h-full min-h-0 flex" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}>
                      <div className="w-full h-full min-h-0 rounded-md border overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: '#1c2027' }}>
                        {selectedPrinter.imageDataUrl ? (
                          <AutoTrimmedImage src={selectedPrinter.imageDataUrl} alt={selectedPrinter.name} className="h-full w-full object-contain" />
                        ) : (
                          <div className="text-[11px] text-center px-3" style={{ color: 'var(--text-muted)' }}>
                            <Printer className="w-5 h-5 mx-auto mb-1" />
                            No preview image
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Build Volume</div>
                  <div
                    className="mb-3 rounded-lg border p-2.5 flex flex-wrap items-center justify-between gap-2"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      background: 'color-mix(in srgb, var(--surface-1), transparent 7%)',
                    }}
                  >
                    <div>
                      <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                        Auto-Calculate Width/Depth
                      </div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Uses Resolution × Pixel Size. Non-destructive: switching back restores previous manual width/depth.
                      </div>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={selectedBuildDimensionMode === 'auto'}
                      onClick={() => setBuildDimensionMode(selectedBuildDimensionMode === 'auto' ? 'manual' : 'auto')}
                      disabled={isSelectedPrinterOfficial}
                      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md disabled:opacity-55 disabled:cursor-not-allowed"
                      style={selectedBuildDimensionMode === 'auto'
                        ? {
                            color: 'var(--accent-secondary)',
                            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                          }
                        : { color: 'var(--text-strong)' }}
                    >
                      {selectedBuildDimensionMode === 'auto' ? 'Auto' : 'Manual'}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                    <LabeledNumberInput
                      label="Build Width (mm)"
                      disabled={selectedBuildDimensionMode === 'auto' || isSelectedPrinterOfficial}
                      value={selectedPrinter.buildVolumeMm.width}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        buildVolumeMm: {
                          ...selectedPrinter.buildVolumeMm,
                          width: value,
                        },
                      })}
                    />
                    <LabeledNumberInput
                      label="Build Depth (mm)"
                      disabled={selectedBuildDimensionMode === 'auto' || isSelectedPrinterOfficial}
                      value={selectedPrinter.buildVolumeMm.depth}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        buildVolumeMm: {
                          ...selectedPrinter.buildVolumeMm,
                          depth: value,
                        },
                      })}
                    />
                    <LabeledNumberInput
                      label="Build Height (mm)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinter.buildVolumeMm.height}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        buildVolumeMm: {
                          ...selectedPrinter.buildVolumeMm,
                          height: value,
                        },
                      })}
                    />
                  </div>
                </div>

                <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Display</div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                    <LabeledNumberInput
                      label="Resolution X (px)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinter.display.resolutionX}
                      onChange={(value) => handlePrinterDisplayChange({
                        resolutionX: Math.max(1, Math.round(value)),
                      })}
                    />
                    <LabeledNumberInput
                      label="Resolution Y (px)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinter.display.resolutionY}
                      onChange={(value) => handlePrinterDisplayChange({
                        resolutionY: Math.max(1, Math.round(value)),
                      })}
                    />
                    <LabeledNumberInput
                      label="Bit Depth"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinter.bitDepth?.bits ?? 8}
                      onChange={handlePrinterBitDepthChange}
                    />

                    <LabeledNumberInput
                      label="Pixel Size X (μm)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinter.pixelSize?.x ?? 1}
                      onChange={(value) => handlePrinterPixelSizeChange('x', value)}
                    />
                    <LabeledNumberInput
                      label="Pixel Size Y (μm)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinter.pixelSize?.y ?? 1}
                      onChange={(value) => handlePrinterPixelSizeChange('y', value)}
                    />

                    <LabeledToggleInput
                      label="Anti-Aliasing"
                      disabled={isSelectedPrinterOfficial}
                      checked={selectedPrinter.antiAliasing === true}
                      onChange={(checked) => updatePrinterProfile(selectedPrinter.id, { antiAliasing: checked })}
                    />
                  </div>
                </div>

                <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Output</div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
                    <LabeledSelectInput
                      label="Output Format"
                      value={selectedPrinter.display.outputFormat}
                      options={OUTPUT_FORMAT_OPTIONS}
                      onChange={(value) => handlePrinterDisplayChange({ outputFormat: value })}
                    />

                    <LabeledSelectInput
                      label="Network Support"
                      value={selectedPrinter.networkSupport ?? ''}
                      options={selectedPrinterNetworkModeOptions}
                      onChange={(value) => {
                        const nextMode = value.trim().toLowerCase();
                        const normalizedMode = nextMode.length > 0 ? nextMode : undefined;
                        updatePrinterProfile(selectedPrinter.id, { networkSupport: normalizedMode });
                        if (!normalizedMode) {
                          setIsNetworkSettingsOpen(false);
                          setIsAddingNetworkPrinter(false);
                        }
                      }}
                    />

                    <LabeledToggleInput
                      label="Webcam Support"
                      checked={selectedPrinter.hasCamera !== false}
                      onChange={(checked) => updatePrinterProfile(selectedPrinter.id, { hasCamera: checked })}
                    />

                    {selectedFormatVersionOptions.length > 0 && (
                      <SelectDropdown
                        label="Format Version"
                        value={selectedResolvedFormatVersion ?? selectedFormatVersionOptions[0].value}
                        options={selectedFormatVersionOptions}
                        onChange={(value) => handlePrinterDisplayChange({ formatVersion: value })}
                      />
                    )}

                    {selectedSettingsModeOptions.length > 0 && (
                      <SelectDropdown
                        label="Settings Mode"
                        value={selectedResolvedSettingsMode ?? selectedSettingsModeOptions[0].value}
                        options={selectedSettingsModeOptions}
                        disabled={isSelectedPrinterOfficial}
                        onChange={(value) => handlePrinterDisplayChange({ settingsMode: value })}
                      />
                    )}

                    <LabeledToggleInput
                      label="Mirror X"
                      disabled={isSelectedPrinterOfficial}
                      checked={selectedPrinter.display.mirrorX === true}
                      onChange={(checked) => handlePrinterDisplayChange({ mirrorX: checked })}
                    />

                    <LabeledToggleInput
                      label="Mirror Y"
                      disabled={isSelectedPrinterOfficial}
                      checked={selectedPrinter.display.mirrorY === true}
                      onChange={(checked) => handlePrinterDisplayChange({ mirrorY: checked })}
                    />
                  </div>
                </div>
              </div>

              <div className="px-3 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Changes are applied immediately.
                </span>
                <button
                  type="button"
                  onClick={() => setIsEditingPrinter(false)}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-full"
                  style={{ color: 'var(--accent-secondary)' }}
                >
                  <Check className="w-3.5 h-3.5" />
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {isCreateMaterialOpen && selectedPrinter && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsCreateMaterialOpen(false);
          }}>
            <div className="w-full max-w-[920px] max-h-[88vh] rounded-xl border shadow-2xl ui-modal-panel-enter flex flex-col" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {usePluginLocalSettingsAsReplacement && replacementMaterialModalLabel
                      ? `Create ${replacementMaterialModalLabel} Resin Profile`
                      : 'Create Resin Profile'}
                  </h3>
                  <p className="ui-meta">{selectedPrinter.name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsCreateMaterialOpen(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close create resin dialog"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 space-y-3 overflow-y-auto custom-scrollbar flex-1">
                {usePluginLocalSettingsAsReplacement ? (
                  <ReplacementMaterialEditorShell
                    tabs={replacementMaterialEditorTabs}
                    activeTabId={materialEditorTab}
                    onActiveTabChange={setMaterialEditorTab}
                    draft={newMaterialDraft}
                    onDraftChange={setNewMaterialDraft}
                    outputFormat={selectedPrinter.display.outputFormat}
                    settingsMode={selectedResolvedSettingsMode}
                    adapter={selectedLocalMaterialSettingsAdapter}
                    localSettingsByOutput={newMaterialLocalSettingsByOutput}
                    onLocalSettingsByOutputChange={setNewMaterialLocalSettingsByOutput}
                  />
                ) : (
                  <>
                    <MaterialProfileFormSections draft={newMaterialDraft} onChange={setNewMaterialDraft} />
                    <PluginLocalMaterialSettingsSections
                      outputFormat={selectedPrinter.display.outputFormat}
                      settingsMode={selectedResolvedSettingsMode}
                      adapter={selectedLocalMaterialSettingsAdapter}
                      localSettingsByOutput={newMaterialLocalSettingsByOutput}
                      onChange={setNewMaterialLocalSettingsByOutput}
                      replacementMode={usePluginLocalSettingsAsReplacement}
                    />
                  </>
                )}
              </div>

              <div className="px-3 py-2 border-t flex items-center justify-end gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  type="button"
                  onClick={() => setIsCreateMaterialOpen(false)}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleCreateMaterial}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-full"
                  style={{ color: 'var(--accent)' }}
                >
                  <Check className="w-3.5 h-3.5" />
                  Save Resin
                </button>
              </div>
            </div>
          </div>
        )}

        {isNetworkSettingsOpen && selectedPrinter && selectedPrinterSupportsNetworkSettings && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsNetworkSettingsOpen(false);
          }}>
            <FleetManagement
              printerName={selectedPrinter.name}
              managedPrinters={managedNetworkPrinters}
              printerReachabilityByDeviceId={printerReachabilityByDeviceId}
              activePrinterId={selectedPrinter.activeNetworkDeviceId ?? null}
              showAddPrinterFlow={isAddingNetworkPrinter || managedNetworkPrinters.length === 0}
              onEnterAddPrinterFlow={() => {
                setIsAddingNetworkPrinter(true);
                setShowManualNetworkEntry(false);
              }}
              onExitAddPrinterFlow={() => {
                setIsAddingNetworkPrinter(false);
                setShowManualNetworkEntry(false);
              }}
              networkDiscoveryEnabled={networkDiscoveryEnabled}
              onToggleDiscovery={() => setNetworkDiscoveryEnabled((prev) => !prev)}
              onRunDiscovery={() => { void handleRunNetworkDiscovery(); }}
              isNetworkScanning={isNetworkScanning}
              networkScanProgressPct={networkScanProgressPct}
              networkScanPhaseLabel={networkScanPhaseLabel}
              discoveredPrinters={discoveredPrinters}
              isNetworkConnecting={isNetworkConnecting}
              onConnectDiscovered={(entry) => {
                void handleConnectNetworkPrinter({
                  host: entry.ipAddress,
                  preferredName: entry.name,
                  closeOnSuccess: false,
                });
              }}
              onSelectManagedPrinter={handleSelectManagedPrinter}
              onReconnectManagedPrinter={(device) => {
                void handleConnectNetworkPrinter({
                  host: device.ipAddress,
                  preferredName: device.displayName || device.hostName || device.ipAddress,
                  closeOnSuccess: false,
                });
              }}
              onDisconnectManagedPrinter={handleDisconnectManagedPrinter}
              onRemoveManagedPrinter={handleRemoveManagedPrinter}
              showManualNetworkEntry={showManualNetworkEntry}
              onToggleManualEntry={() => setShowManualNetworkEntry((prev) => !prev)}
              networkIpAddress={networkIpAddress}
              onNetworkIpAddressChange={setNetworkIpAddress}
              onConnectManual={() => { void handleConnectNetworkPrinter(); }}
              activePrinterSummary={activeManagedNetworkPrinter?.connected
                ? `Active: ${activeManagedNetworkPrinter.displayName || activeManagedNetworkPrinter.hostName || activeManagedNetworkPrinter.ipAddress}`
                : activeManagedNetworkPrinter
                  ? `Selected: ${activeManagedNetworkPrinter.displayName || activeManagedNetworkPrinter.ipAddress}`
                  : 'No active printer selected'}
              onClose={() => setIsNetworkSettingsOpen(false)}
              onSave={() => {
                updatePrinterNetworkSettings(selectedPrinter.id, {
                  discoveryEnabled: networkDiscoveryEnabled,
                  ipAddress: networkIpAddress.trim(),
                });
                setIsNetworkSettingsOpen(false);
              }}
            />
          </div>
        )}

        <RemoteMaterialEditDialog
          isOpen={isRemoteMaterialEditDialogOpen}
          material={selectedRemoteMaterial}
          networkModeLabel={selectedNetworkModeLabel}
          isSaving={isSavingRemoteMaterialEdit}
          editTab={remoteMaterialEditTab}
          onEditTabChange={setRemoteMaterialEditTab}
          basicSections={basicRemoteMaterialSections}
          advancedSections={advancedRemoteMaterialSections}
          primaryFieldByKey={remoteMaterialPrimaryFieldByKey}
          isDynamicWaitEnabledState={isRemoteMaterialDynamicWaitEnabledState}
          resolveFieldHelpText={effectiveNetworkUiAdapter.getFieldHelpText}
          onDraftChange={setRemoteMaterialEditDraft}
          onClose={() => setIsRemoteMaterialEditDialogOpen(false)}
          onSave={() => { void handleSaveRemoteMaterialEdits(); }}
        />

        {showOfficialLockDialog && (
          <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowOfficialLockDialog(false);
              setOfficialLockedProfileId(null);
            }
          }}>
            <div className="w-full max-w-[520px] rounded-xl border shadow-2xl ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <AlertTriangle className="w-4 h-4" style={{ color: '#f59e0b' }} />
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Official Profile Locked
                </h3>
              </div>
              <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                For safety reasons, official slicer profiles cannot be modified directly.
                You can create a copy and customize that profile instead.
                <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <strong style={{ color: 'var(--text-strong)' }}>Warning:</strong> Custom, non-official profiles may increase the risk of print failure and can potentially damage the machine or cause personal injury.
                </div>
              </div>
              <div className="px-4 pb-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowOfficialLockDialog(false);
                    setOfficialLockedProfileId(null);
                  }}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDuplicateOfficialProfile}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                  style={{
                    color: 'var(--accent-secondary)',
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                  }}
                >
                  <Lock className="w-3.5 h-3.5" />
                  Make Custom Copy
                </button>
              </div>
            </div>
          </div>
        )}

        {deleteConfirmTarget && (
          <div className="fixed inset-0 z-[76] flex items-center justify-center bg-black/60 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setDeleteConfirmTarget(null);
            }
          }}>
            <div className="w-full max-w-[520px] rounded-xl border shadow-2xl ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <AlertTriangle className="w-4 h-4" style={{ color: '#f59e0b' }} />
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Confirm Delete
                </h3>
              </div>
              <div className="px-4 py-3 text-sm" style={{ color: 'var(--text-muted)' }}>
                {deleteConfirmTarget.kind === 'printer'
                  ? <>Delete printer profile <strong style={{ color: 'var(--text-strong)' }}>{deleteConfirmTarget.name}</strong> and all resin profiles bound to it?</>
                  : <>Delete resin profile <strong style={{ color: 'var(--text-strong)' }}>{deleteConfirmTarget.name}</strong>?</>}
              </div>
              <div className="px-4 pb-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setDeleteConfirmTarget(null)}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmDelete}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                  style={{ color: '#fca5a5' }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type RemoteMaterialEditDialogProps = {
  isOpen: boolean;
  material: RemoteMaterialProfile | null;
  networkModeLabel: string;
  isSaving: boolean;
  editTab: 'basic' | 'advanced';
  onEditTabChange: (tab: 'basic' | 'advanced') => void;
  basicSections: Array<{
    id: string;
    title: string;
    entries: Array<readonly [string, string]>;
  }>;
  advancedSections: Array<{
    id: string;
    title: string;
    entries: Array<readonly [string, string]>;
  }>;
  primaryFieldByKey: Map<string, { label: string; description?: string }>;
  isDynamicWaitEnabledState: boolean;
  resolveFieldHelpText: (fieldKey: string) => string;
  onDraftChange: React.Dispatch<React.SetStateAction<RemoteMaterialEditDraft>>;
  onClose: () => void;
  onSave: () => void;
};

function RemoteMaterialEditDialog({
  isOpen,
  material,
  networkModeLabel,
  isSaving,
  editTab,
  onEditTabChange,
  basicSections,
  advancedSections,
  primaryFieldByKey,
  isDynamicWaitEnabledState,
  resolveFieldHelpText,
  onDraftChange,
  onClose,
  onSave,
}: RemoteMaterialEditDialogProps) {
  if (!isOpen || !material) return null;

  return (
    <div className="fixed inset-0 z-[71] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !isSaving) onClose();
    }}>
      <div className="w-full max-w-[920px] max-h-[88vh] rounded-xl border shadow-2xl overflow-hidden flex flex-col ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Edit {networkModeLabel} Resin Profile</h3>
            <p className="ui-meta">{material.name} • Profile ID {material.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
            aria-label={`Close ${networkModeLabel} edit dialog`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 space-y-3 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          <div className="flex items-center gap-1.5 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              type="button"
              onClick={() => onEditTabChange('basic')}
              className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
              style={editTab === 'basic'
                ? { color: 'var(--accent-secondary)', borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)' }
                : { color: 'var(--text-muted)' }}
            >
              Basic
            </button>
            <button
              type="button"
              onClick={() => onEditTabChange('advanced')}
              className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
              style={editTab === 'advanced'
                ? { color: 'var(--accent-secondary)', borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)' }
                : { color: 'var(--text-muted)' }}
            >
              Advanced
            </button>
          </div>

          {editTab === 'basic' ? (
            <div className="space-y-2.5">
              {basicSections.map((section) => (
                <div
                  key={section.id}
                  className="rounded-xl border p-3"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                >
                  <div className="ui-meta font-semibold uppercase tracking-wide mb-2 flex items-center justify-between gap-2">
                    <span>{section.title}</span>
                    {section.id === 'timing' && isDynamicWaitEnabledState && (
                      <span
                        className="text-[10px] rounded-full border px-2 py-0.5 normal-case tracking-normal"
                        style={{
                          borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                          background: 'color-mix(in srgb, #f59e0b, var(--surface-2) 88%)',
                          color: '#fbbf24',
                        }}
                        title="Dynamic Wait is controlling Wait Before Print fields"
                      >
                        Dynamic Wait active
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    {section.entries.map(([key, value]) => {
                      const field = primaryFieldByKey.get(key);
                      const isDynamicWaitLockedField = isDynamicWaitEnabledState && (key === 'SupportBeforeWait' || key === 'BeforeWait');
                      const dynamicWaitHelp = isDynamicWaitLockedField
                        ? 'Controlled by Dynamic Wait. Disable Dynamic Wait in Advanced settings to edit this value.'
                        : undefined;
                      const numericValue = Number(value);
                      const isNumeric = Number.isFinite(numericValue);
                      if (isNumeric) {
                        return (
                          <LabeledNumberInput
                            key={key}
                            label={field?.label ?? formatRemoteMaterialFieldLabel(key)}
                            helpText={dynamicWaitHelp ?? field?.description}
                            disabled={isDynamicWaitLockedField}
                            value={numericValue}
                            onChange={(next) => onDraftChange((prev) => ({
                              ...prev,
                              [key]: key === 'SupportLayerNumber' || key === 'TransitionalLayer'
                                ? String(Math.max(0, Math.round(next)))
                                : String(next),
                            }))}
                          />
                        );
                      }

                      return (
                        <LabeledInput
                          key={key}
                          label={field?.label ?? formatRemoteMaterialFieldLabel(key)}
                          helpText={dynamicWaitHelp ?? field?.description}
                          disabled={isDynamicWaitLockedField}
                          value={value}
                          onChange={(next) => onDraftChange((prev) => ({ ...prev, [key]: next }))}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2.5">
              {advancedSections.length > 0 ? (
                advancedSections.map((section) => (
                  <div
                    key={section.id}
                    className="rounded-xl border p-3"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                  >
                    <div className="ui-meta font-semibold uppercase tracking-wide mb-2">{section.title}</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {section.entries.map(([key, value]) => {
                        const numericValue = Number(value);
                        const useNumericInput = Number.isFinite(numericValue)
                          || (value.trim().length === 0 && isLikelyNumericRemoteMaterialField(key, value));

                        if (useNumericInput) {
                          return (
                            <LabeledNumberInput
                              key={key}
                              label={formatRemoteMaterialFieldLabel(key)}
                              helpText={resolveFieldHelpText(key)}
                              value={Number.isFinite(numericValue) ? numericValue : 0}
                              onChange={(next) => onDraftChange((prev) => ({ ...prev, [key]: String(next) }))}
                            />
                          );
                        }

                        return (
                          <LabeledInput
                            key={key}
                            label={formatRemoteMaterialFieldLabel(key)}
                            helpText={resolveFieldHelpText(key)}
                            value={value}
                            onChange={(next) => onDraftChange((prev) => ({ ...prev, [key]: next }))}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    No additional advanced controls were found for this profile.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div
          className="px-3 py-2 border-t flex items-center justify-between gap-2 shrink-0 sticky bottom-0"
          style={{
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-0), transparent 4%)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {`Applies to ${networkModeLabel} profile on the printer (all scalar parameters from this profile).`}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSaving}
              className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={isSaving}
              className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-full disabled:opacity-60"
              style={{ color: 'var(--accent-secondary)' }}
            >
              {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
              {isSaving ? 'Saving…' : `Save to ${networkModeLabel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type PluginLocalMaterialSettingsSectionsProps = {
  outputFormat: string;
  settingsMode?: string;
  adapter: ReturnType<typeof getProfileLocalMaterialSettingsAdapter>;
  localSettingsByOutput: LocalSettingsByOutputDraft;
  onChange: React.Dispatch<React.SetStateAction<LocalSettingsByOutputDraft>>;
  replacementMode?: boolean;
  activeTabId?: string;
  onActiveTabChange?: (tabId: string) => void;
  showTabBar?: boolean;
};

function PluginLocalMaterialSettingsSections({
  outputFormat,
  settingsMode,
  adapter,
  localSettingsByOutput,
  onChange,
  replacementMode = false,
  activeTabId: controlledActiveTabId,
  onActiveTabChange,
  showTabBar = true,
}: PluginLocalMaterialSettingsSectionsProps) {
  if (!adapter || adapter.fields.length === 0) return null;

  const normalizedOutput = outputFormat.trim().toLowerCase();
  const tabs = React.useMemo(() => {
    const declared = [...(adapter.tabs ?? [])]
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (declared.length > 0) return declared;
    return [{ id: 'local', title: adapter.displayName ?? 'Local Settings', order: 0 }];
  }, [adapter.displayName, adapter.tabs]);

  const defaultTabId = React.useMemo(() => tabs[0]?.id ?? 'local', [tabs]);

  const [uncontrolledActiveTabId, setUncontrolledActiveTabId] = React.useState(defaultTabId);
  const activeTabId = controlledActiveTabId ?? uncontrolledActiveTabId;
  const setActiveTabId = onActiveTabChange ?? setUncontrolledActiveTabId;

  React.useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(defaultTabId);
    }
  }, [activeTabId, defaultTabId, tabs]);

  const valuesForOutput = localSettingsByOutput[normalizedOutput] ?? {};

  const fieldsForActiveTab = React.useMemo(() => {
    const fallbackTabId = tabs[0]?.id;
    return adapter.fields
      .filter((field) => (field.placement?.tabId ?? fallbackTabId) === activeTabId)
      .sort((a, b) => (a.placement?.order ?? 0) - (b.placement?.order ?? 0));
  }, [activeTabId, adapter.fields, tabs]);

  const sectionById = React.useMemo(() => {
    const map = new Map<string, { id: string; title: string; order?: number }>();
    (adapter.sections ?? []).forEach((section) => {
      map.set(section.id, section);
    });
    return map;
  }, [adapter.sections]);

  const cardById = React.useMemo(() => {
    const map = new Map<string, { id: string; title: string; order?: number }>();
    (adapter.cards ?? []).forEach((card) => {
      map.set(card.id, card);
    });
    return map;
  }, [adapter.cards]);

  const sectionGroups = React.useMemo(() => {
    const grouped = new Map<string, typeof fieldsForActiveTab>();

    fieldsForActiveTab.forEach((field) => {
      const sectionId = field.placement?.sectionId ?? 'general';
      const current = grouped.get(sectionId);
      if (current) {
        current.push(field);
      } else {
        grouped.set(sectionId, [field]);
      }
    });

    return Array.from(grouped.entries())
      .map(([sectionId, fields]) => ({
        sectionId,
        sectionTitle: sectionById.get(sectionId)?.title ?? 'General',
        sectionOrder: sectionById.get(sectionId)?.order ?? 0,
        fields,
      }))
      .sort((a, b) => a.sectionOrder - b.sectionOrder || a.sectionTitle.localeCompare(b.sectionTitle));
  }, [fieldsForActiveTab, sectionById]);

  const setFieldValue = React.useCallback((fieldKey: string, nextValue: string | number | boolean) => {
    onChange((prev) => ({
      ...prev,
      [normalizedOutput]: {
        ...(prev[normalizedOutput] ?? {}),
        [fieldKey]: nextValue,
      },
    }));
  }, [normalizedOutput, onChange]);

  return (
    <div
      className={replacementMode ? 'space-y-2' : 'rounded-xl border p-3 space-y-2'}
      style={replacementMode
        ? undefined
        : { borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
    >
      {!replacementMode && (
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="ui-meta font-semibold uppercase tracking-wide">{adapter.displayName ?? 'Format-specific settings'}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Applied to {normalizedOutput} metadata for export.
            </div>
          </div>
        </div>
      )}

      {showTabBar && tabs.length > 1 && (
        <div className="flex items-center gap-1.5 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTabId(tab.id)}
                className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
                style={active
                  ? { color: 'var(--accent-secondary)', borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)' }
                  : { color: 'var(--text-muted)' }}
              >
                {tab.title}
              </button>
            );
          })}
        </div>
      )}

      {sectionGroups.length === 0 ? (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No custom settings are available for this tab.
        </div>
      ) : (
        <div className="space-y-2">
          {sectionGroups.map((section) => {
            const cardGroups = new Map<string, typeof section.fields>();
            section.fields.forEach((field) => {
              const cardId = field.placement?.cardId ?? 'general';
              const existing = cardGroups.get(cardId);
              if (existing) {
                existing.push(field);
              } else {
                cardGroups.set(cardId, [field]);
              }
            });

            const cards = Array.from(cardGroups.entries())
              .map(([cardId, fields]) => ({
                cardId,
                cardTitle: cardById.get(cardId)?.title ?? 'General',
                cardOrder: cardById.get(cardId)?.order ?? 0,
                fields: [...fields].sort((a, b) => (a.placement?.order ?? 0) - (b.placement?.order ?? 0)),
              }))
              .sort((a, b) => a.cardOrder - b.cardOrder || a.cardTitle.localeCompare(b.cardTitle));

            return (
              <div key={section.sectionId} className="space-y-1.5">
                {!replacementMode && (
                  <div className="ui-meta font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    {section.sectionTitle}
                  </div>
                )}
                {cards.map((card) => {
                  const renderedKeys = new Set<string>();
                  return (
                  <div
                    key={`${section.sectionId}-${card.cardId}`}
                    className="rounded-xl border p-3"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                  >
                    <div className="ui-meta font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>{card.cardTitle}</div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {card.fields.map((field) => {
                        if (renderedKeys.has(field.key)) return null;

                        const fieldValue = Object.prototype.hasOwnProperty.call(valuesForOutput, field.key)
                          ? valuesForOutput[field.key]
                          : field.defaultValue;
                        const sanitizedFieldValue = (field.kind === 'number' || field.kind === 'integer')
                          ? sanitizePluginNumericValue(field as PluginNumericFieldSchema, Number(fieldValue))
                          : fieldValue;

                        if (field.splitWithKey) {
                          const pairedField = card.fields.find((candidate) => candidate.key === field.splitWithKey);
                          if (pairedField) {
                            const pairedValue = Object.prototype.hasOwnProperty.call(valuesForOutput, pairedField.key)
                              ? valuesForOutput[pairedField.key]
                              : pairedField.defaultValue;
                            const sanitizedPairedValue = (pairedField.kind === 'number' || pairedField.kind === 'integer')
                              ? sanitizePluginNumericValue(pairedField as PluginNumericFieldSchema, Number(pairedValue))
                              : pairedValue;
                            renderedKeys.add(field.key);
                            renderedKeys.add(pairedField.key);
                            return (
                              <LabeledTwoStageNumberInput
                                key={field.key}
                                label={field.label}
                                helpText={field.description}
                                firstValue={Number(sanitizedFieldValue)}
                                secondValue={Number(sanitizedPairedValue)}
                                firstMin={field.min}
                                firstMax={field.max}
                                firstStep={field.step}
                                firstTag={field.tag}
                                firstColor={field.color}
                                secondMin={pairedField.min}
                                secondMax={pairedField.max}
                                secondStep={pairedField.step}
                                secondTag={pairedField.tag}
                                secondColor={pairedField.color}
                                onFirstChange={(next) => {
                                  const clamped = sanitizePluginNumericValue(field as PluginNumericFieldSchema, next);
                                  const pairedClamped = sanitizePluginNumericValue(pairedField as PluginNumericFieldSchema, Number(sanitizedPairedValue));

                                  if (isSlowFastPair(field.tag, pairedField.tag)) {
                                    const fieldTag = field.tag?.trim().toLowerCase();
                                    if (fieldTag === 'slow' && clamped > pairedClamped) {
                                      setFieldValue(field.key, clamped);
                                      setFieldValue(pairedField.key, clamped);
                                      return;
                                    }
                                    if (fieldTag === 'fast' && clamped < pairedClamped) {
                                      setFieldValue(field.key, clamped);
                                      setFieldValue(pairedField.key, clamped);
                                      return;
                                    }
                                  }

                                  setFieldValue(field.key, clamped);
                                }}
                                onSecondChange={(next) => {
                                  const clamped = sanitizePluginNumericValue(pairedField as PluginNumericFieldSchema, next);
                                  const fieldClamped = sanitizePluginNumericValue(
                                    field as PluginNumericFieldSchema,
                                    Number(sanitizedFieldValue),
                                  );

                                  if (isSlowFastPair(field.tag, pairedField.tag)) {
                                    const pairedTag = pairedField.tag?.trim().toLowerCase();
                                    if (pairedTag === 'slow' && clamped > fieldClamped) {
                                      setFieldValue(field.key, clamped);
                                      setFieldValue(pairedField.key, clamped);
                                      return;
                                    }
                                    if (pairedTag === 'fast' && clamped < fieldClamped) {
                                      setFieldValue(field.key, clamped);
                                      setFieldValue(pairedField.key, clamped);
                                      return;
                                    }
                                  }

                                  setFieldValue(pairedField.key, clamped);
                                }}
                              />
                            );
                          }
                        }

                        if (field.kind === 'boolean') {
                          return (
                            <LabeledToggleInput
                              key={field.key}
                              label={field.label}
                              checked={Boolean(fieldValue)}
                              onChange={(next) => setFieldValue(field.key, next)}
                            />
                          );
                        }

                        if (field.kind === 'select' && Array.isArray(field.options) && field.options.length > 0) {
                          return (
                            <SelectDropdown
                              key={field.key}
                              label={field.label}
                              value={String(fieldValue)}
                              onChange={(nextValue) => setFieldValue(field.key, nextValue)}
                              options={field.options.map((option) => ({
                                value: option.value,
                                label: option.label,
                              }))}
                              className="space-y-1 block"
                              labelClassName="font-medium"
                              selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
                            />
                          );
                        }

                        if (field.kind === 'number' || field.kind === 'integer') {
                          return (
                            <LabeledNumberInput
                              key={field.key}
                              label={field.label}
                              helpText={field.description}
                              tag={field.tag}
                              color={field.color}
                              value={Number(sanitizedFieldValue)}
                              onChange={(next) => {
                                const clamped = sanitizePluginNumericValue(field as PluginNumericFieldSchema, next);
                                setFieldValue(field.key, clamped);
                              }}
                            />
                          );
                        }

                        return (
                          <LabeledInput
                            key={field.key}
                            label={field.label}
                            helpText={field.description}
                            value={String(fieldValue)}
                            onChange={(next) => setFieldValue(field.key, next)}
                          />
                        );
                      })}
                    </div>
                  </div>
                );})}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type ReplacementMaterialEditorShellProps = {
  tabs: Array<{ id: string; title: string; order: number }>;
  activeTabId: string;
  onActiveTabChange: (tabId: string) => void;
  draft: MaterialDraft;
  onDraftChange: React.Dispatch<React.SetStateAction<MaterialDraft>>;
  outputFormat: string;
  settingsMode?: string;
  adapter: ReturnType<typeof getProfileLocalMaterialSettingsAdapter> | null;
  localSettingsByOutput: LocalSettingsByOutputDraft;
  onLocalSettingsByOutputChange: React.Dispatch<React.SetStateAction<LocalSettingsByOutputDraft>>;
};

function ReplacementMaterialEditorShell({
  tabs,
  activeTabId,
  onActiveTabChange,
  draft,
  onDraftChange,
  outputFormat,
  settingsMode,
  adapter,
  localSettingsByOutput,
  onLocalSettingsByOutputChange,
}: ReplacementMaterialEditorShellProps) {
  const measureRootRef = React.useRef<HTMLDivElement | null>(null);
  const [minBodyHeight, setMinBodyHeight] = React.useState<number | null>(null);

  const renderTabBody = React.useCallback((tabId: string) => {
    if (tabId === 'meta') {
      return <MaterialProfileIdentitySection draft={draft} onChange={onDraftChange} />;
    }

    return (
      <PluginLocalMaterialSettingsSections
        outputFormat={outputFormat}
        settingsMode={settingsMode}
        adapter={adapter}
        localSettingsByOutput={localSettingsByOutput}
        onChange={onLocalSettingsByOutputChange}
        replacementMode
        activeTabId={tabId}
        showTabBar={false}
      />
    );
  }, [adapter, draft, localSettingsByOutput, onDraftChange, onLocalSettingsByOutputChange, outputFormat, settingsMode]);

  React.useLayoutEffect(() => {
    const root = measureRootRef.current;
    if (!root) return;

    const heights = Array.from(root.querySelectorAll<HTMLElement>('[data-measure-tab-body]'))
      .map((element) => element.getBoundingClientRect().height)
      .filter((height) => Number.isFinite(height) && height > 0);

    const nextHeight = heights.length > 0 ? Math.ceil(Math.max(...heights)) : null;
    setMinBodyHeight((prev) => (prev === nextHeight ? prev : nextHeight));
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
        {tabs.map((tab) => {
          const active = activeTabId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onActiveTabChange(tab.id)}
              className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
              style={active
                ? { color: 'var(--accent-secondary)', borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)' }
                : { color: 'var(--text-muted)' }}
            >
              {tab.title}
            </button>
          );
        })}
      </div>

      <div className="relative" style={minBodyHeight ? { minHeight: `${minBodyHeight}px` } : undefined}>
        <div className="space-y-3" data-measure-tab-body>
          {renderTabBody(activeTabId)}
        </div>

        <div ref={measureRootRef} aria-hidden="true" className="absolute inset-0 pointer-events-none invisible overflow-hidden" style={{ width: '100%' }}>
          {tabs.map((tab) => (
            <div key={tab.id} className="space-y-3" data-measure-tab-body>
              {renderTabBody(tab.id)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type LabeledInputProps = {
  label: string;
  helpText?: string;
  disabled?: boolean;
  value: string | number;
  onChange: (value: string) => void;
};

function LabeledInput({ label, helpText, disabled = false, value, onChange }: LabeledInputProps) {
  const [localValue, setLocalValue] = React.useState<string>(() => String(value));
  const [isFocused, setIsFocused] = React.useState(false);

  React.useEffect(() => {
    if (isFocused) return;
    setLocalValue(String(value));
  }, [value, isFocused]);

  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        {helpText && (
          <span
            title={helpText}
            aria-label={`${label} help`}
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-semibold cursor-help"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}
          >
            ?
          </span>
        )}
      </span>
      <input
        type="text"
        disabled={disabled}
        value={localValue}
        onChange={(event) => {
          const next = event.target.value;
          setLocalValue(next);
          onChange(next);
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        className={`ui-input w-full h-[36px] px-2.5 leading-tight text-sm ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
      />
    </label>
  );
}

type LabeledNumberInputProps = {
  label: string;
  helpText?: string;
  tag?: string;
  color?: string;
  disabled?: boolean;
  value: number;
  onChange: (value: number) => void;
};

function LabeledNumberInput({ label, helpText, tag, color, disabled = false, value, onChange }: LabeledNumberInputProps) {
  const safeValue = clampNonNegativeNumber(value);
  const [localValue, setLocalValue] = React.useState<string>(() => String(safeValue));
  const [isFocused, setIsFocused] = React.useState(false);
  const tone = resolveFieldTagTone(tag);
  const accent = (typeof color === 'string' && color.trim().length > 0)
    ? color.trim()
    : tone?.fallbackColor ?? null;

  React.useEffect(() => {
    if (isFocused) return;
    setLocalValue(String(safeValue));
  }, [isFocused, safeValue]);

  const commit = React.useCallback(() => {
    const trimmed = localValue.trim();
    if (trimmed === '') {
      // Revert to persisted value when input is left empty.
      setLocalValue(String(value));
      return;
    }

    const next = Number(trimmed);
    if (!Number.isFinite(next)) {
      setLocalValue(String(safeValue));
      return;
    }

    const sanitized = clampNonNegativeNumber(next);
    onChange(sanitized);
    setLocalValue(String(sanitized));
  }, [localValue, onChange, safeValue]);

  const nudge = React.useCallback((direction: 1 | -1) => {
    const fallback = safeValue;
    const parsed = Number(localValue.trim());
    const current = Number.isFinite(parsed) ? parsed : fallback;
    const step = Math.abs(current) < 1 ? 0.01 : 1;
    const decimals = step < 1 ? 3 : 0;
    const next = clampNonNegativeNumber(Number((current + direction * step).toFixed(decimals)));
    onChange(next);
    setLocalValue(String(next));
  }, [localValue, onChange, safeValue]);

  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        {helpText && (
          <span
            title={helpText}
            aria-label={`${label} help`}
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-semibold cursor-help"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}
          >
            ?
          </span>
        )}
      </span>
      <div className="relative">
        <input
          type="text"
          disabled={disabled}
          value={localValue}
          onChange={(event) => {
            if (event.target.value.includes('-')) return;
            setLocalValue(event.target.value);
          }}
          onFocus={() => setIsFocused(true)}
          onBlur={() => {
            setIsFocused(false);
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              nudge(1);
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              nudge(-1);
            }
          }}
          className={`ui-input w-full h-[36px] pl-2.5 ${tag ? 'pr-20' : 'pr-6'} leading-tight text-sm no-spinners ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
          style={accent ? {
            background: `color-mix(in srgb, ${accent} 7%, var(--surface-1))`,
            borderColor: `color-mix(in srgb, ${accent} 24%, var(--border-subtle))`,
          } : undefined}
        />

        <FieldTagChip tag={tag} color={color} />

        <div className="absolute inset-y-0 right-1 z-20 flex w-4 flex-col items-center justify-center gap-0.5">
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10"
            onClick={() => nudge(1)}
            disabled={disabled}
            tabIndex={-1}
            aria-label={`Increase ${label}`}
          >
            <ChevronUp className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10"
            onClick={() => nudge(-1)}
            disabled={disabled}
            tabIndex={-1}
            aria-label={`Decrease ${label}`}
          >
            <ChevronDown className="h-2.5 w-2.5" />
          </button>
        </div>
      </div>
    </label>
  );
}

type LabeledTwoStageNumberInputProps = {
  label: string;
  helpText?: string;
  firstValue: number;
  secondValue: number;
  firstMin?: number;
  firstMax?: number;
  firstStep?: number;
  firstTag?: string;
  firstColor?: string;
  secondMin?: number;
  secondMax?: number;
  secondStep?: number;
  secondTag?: string;
  secondColor?: string;
  onFirstChange: (value: number) => void;
  onSecondChange: (value: number) => void;
};

function LabeledTwoStageNumberInput({
  label,
  helpText,
  firstValue,
  secondValue,
  firstMin,
  firstMax,
  firstStep,
  firstTag,
  firstColor,
  secondMin,
  secondMax,
  secondStep,
  secondTag,
  secondColor,
  onFirstChange,
  onSecondChange,
}: LabeledTwoStageNumberInputProps) {
  const firstTone = resolveFieldTagTone(firstTag);
  const secondTone = resolveFieldTagTone(secondTag);
  const firstAccent = (typeof firstColor === 'string' && firstColor.trim().length > 0)
    ? firstColor.trim()
    : firstTone?.fallbackColor ?? null;
  const secondAccent = (typeof secondColor === 'string' && secondColor.trim().length > 0)
    ? secondColor.trim()
    : secondTone?.fallbackColor ?? null;

  return (
    <label className="space-y-1 block md:col-span-2">
      <span className="ui-label font-medium inline-flex items-center gap-1.5">
        {label}
        {helpText && (
          <span
            title={helpText}
            aria-label={`${label} help`}
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border text-[9px] font-semibold cursor-help"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}
          >
            ?
          </span>
        )}
      </span>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
        <div className="relative">
          <NumberInput
            value={Number.isFinite(firstValue) ? firstValue : 0}
            onChange={(next) => onFirstChange(next)}
            min={firstMin}
            max={firstMax}
            step={firstStep}
            showStepper
            aria-label={`${label} stage 1`}
            className={`ui-input w-full h-[36px] px-2.5 ${firstTag ? 'pr-24' : 'pr-2.5'} text-sm leading-tight`}
            style={firstAccent ? {
              background: `color-mix(in srgb, ${firstAccent} 7%, var(--surface-1))`,
              borderColor: `color-mix(in srgb, ${firstAccent} 24%, var(--border-subtle))`,
            } : undefined}
          />
          <FieldTagChip tag={firstTag} color={firstColor} compact />
        </div>
        <div className="text-sm px-1 font-semibold" style={{ color: 'var(--text-muted)' }}>{'>'}</div>
        <div className="relative">
          <NumberInput
            value={Number.isFinite(secondValue) ? secondValue : 0}
            onChange={(next) => onSecondChange(next)}
            min={secondMin}
            max={secondMax}
            step={secondStep}
            showStepper
            aria-label={`${label} stage 2`}
            className={`ui-input w-full h-[36px] px-2.5 ${secondTag ? 'pr-24' : 'pr-2.5'} text-sm leading-tight`}
            style={secondAccent ? {
              background: `color-mix(in srgb, ${secondAccent} 7%, var(--surface-1))`,
              borderColor: `color-mix(in srgb, ${secondAccent} 24%, var(--border-subtle))`,
            } : undefined}
          />
          <FieldTagChip tag={secondTag} color={secondColor} compact />
        </div>
      </div>
    </label>
  );
}

type LabeledSelectInputProps = {
  label: string;
  value: PrinterOutputFormat;
  options: Array<{ value: PrinterOutputFormat; label: string }>;
  onChange: (value: PrinterOutputFormat) => void;
  disabled?: boolean;
};

function LabeledSelectInput({ label, value, options, onChange, disabled = false }: LabeledSelectInputProps) {
  return (
    <SelectDropdown
      label={label}
      value={value}
      onChange={(nextValue) => onChange(nextValue as PrinterOutputFormat)}
      disabled={disabled}
      options={options}
      className="space-y-1 block"
      labelClassName="font-medium"
      selectClassName={`w-full h-[36px] px-2.5 pr-10 leading-tight text-sm ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
      selectStyle={disabled
        ? {
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-2), black 8%)',
            color: 'var(--text-muted)',
          }
        : undefined}
    />
  );
}

type LabeledToggleInputProps = {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
};

function LabeledToggleInput({ label, checked, onChange, disabled = false }: LabeledToggleInputProps) {
  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium inline-flex items-center">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => {
          if (disabled) return;
          onChange(!checked);
        }}
        disabled={disabled}
        className={`ui-input w-full h-[36px] px-2.5 leading-tight text-sm inline-flex items-center justify-between ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
        style={disabled
          ? {
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), black 8%)',
              color: 'var(--text-muted)',
            }
          : {
              borderColor: checked
                ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 36%)'
                : 'var(--border-subtle)',
              background: checked
                ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%)'
                : 'var(--surface-1)',
              color: checked ? 'var(--text-strong)' : 'var(--text-muted)',
            }}
      >
        <span>{checked ? 'Enabled' : 'Disabled'}</span>
        <span
          className="inline-flex h-5 w-9 rounded-full p-0.5 transition-colors"
          style={disabled
            ? { background: 'color-mix(in srgb, var(--surface-2), black 8%)' }
            : { background: checked ? 'var(--accent-secondary)' : 'var(--surface-2)' }}
        >
          <span
            className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`}
          />
        </span>
      </button>
    </label>
  );
}

type LabeledResinFamilySelectProps = {
  label: string;
  value: MaterialProfile['resinFamily'];
  options: Array<{ value: MaterialProfile['resinFamily']; label: string }>;
  onChange: (value: MaterialProfile['resinFamily']) => void;
};

function LabeledResinFamilySelect({ label, value, options, onChange }: LabeledResinFamilySelectProps) {
  return (
    <SelectDropdown
      label={label}
      value={value}
      onChange={(nextValue) => onChange(nextValue as MaterialProfile['resinFamily'])}
      options={options}
      className="space-y-1 block"
      labelClassName="font-medium"
      selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
    />
  );
}

type MaterialProfileFormSectionsProps = {
  draft: MaterialDraft;
  onChange: React.Dispatch<React.SetStateAction<MaterialDraft>>;
};

function MaterialProfileFormSections({ draft, onChange }: MaterialProfileFormSectionsProps) {
  return (
    <>
      <MaterialProfileIdentitySection draft={draft} onChange={onChange} />

      <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Print Settings</div>
        <div className="grid grid-cols-2 gap-2">
          <LabeledNumberInput
            label="Layer height (mm)"
            value={draft.layerHeightMm}
            onChange={(value) => onChange((prev) => ({ ...prev, layerHeightMm: value }))}
          />
          <LabeledNumberInput
            label="Normal exposure (s)"
            value={draft.normalExposureSec}
            onChange={(value) => onChange((prev) => ({ ...prev, normalExposureSec: value }))}
          />
          <LabeledNumberInput
            label="Bottom exposure (s)"
            value={draft.bottomExposureSec}
            onChange={(value) => onChange((prev) => ({ ...prev, bottomExposureSec: value }))}
          />
          <LabeledNumberInput
            label="Bottom layers"
            value={draft.bottomLayerCount}
            onChange={(value) => onChange((prev) => ({ ...prev, bottomLayerCount: value }))}
          />
          <LabeledNumberInput
            label="Lift distance (mm)"
            value={draft.liftDistanceMm}
            onChange={(value) => onChange((prev) => ({ ...prev, liftDistanceMm: value }))}
          />
          <LabeledNumberInput
            label="Lift speed (mm/min)"
            value={draft.liftSpeedMmMin}
            onChange={(value) => onChange((prev) => ({ ...prev, liftSpeedMmMin: value }))}
          />
          <LabeledNumberInput
            label="Retract speed (mm/min)"
            value={draft.retractSpeedMmMin}
            onChange={(value) => onChange((prev) => ({ ...prev, retractSpeedMmMin: value }))}
          />
          <LabeledNumberInput
            label="Minimum AA alpha (%)"
            value={draft.minimumAaAlphaPercent}
            onChange={(value) => onChange((prev) => ({
              ...prev,
              minimumAaAlphaPercent: Math.max(0, Math.min(100, value)),
            }))}
          />
        </div>
      </div>

      <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-2">
          Scale Compensation (% shrinkage)
        </div>
        <div className="grid grid-cols-3 gap-2">
          <LabeledNumberInput
            label="Scale X (%)"
            value={draft.scaleCompensationPct.x}
            onChange={(value) => onChange((prev) => ({
              ...prev,
              scaleCompensationPct: {
                ...prev.scaleCompensationPct,
                x: value,
              },
            }))}
          />
          <LabeledNumberInput
            label="Scale Y (%)"
            value={draft.scaleCompensationPct.y}
            onChange={(value) => onChange((prev) => ({
              ...prev,
              scaleCompensationPct: {
                ...prev.scaleCompensationPct,
                y: value,
              },
            }))}
          />
          <LabeledNumberInput
            label="Scale Z (%)"
            value={draft.scaleCompensationPct.z}
            onChange={(value) => onChange((prev) => ({
              ...prev,
              scaleCompensationPct: {
                ...prev.scaleCompensationPct,
                z: value,
              },
            }))}
          />
        </div>
      </div>
    </>
  );
}

type MaterialProfileIdentitySectionProps = {
  draft: MaterialDraft;
  onChange: React.Dispatch<React.SetStateAction<MaterialDraft>>;
};

function MaterialProfileIdentitySection({ draft, onChange }: MaterialProfileIdentitySectionProps) {
  return (
    <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
      <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Resin Profile</div>
      <div className="grid grid-cols-2 gap-2">
        <LabeledInput
          label="Manufacturer"
          value={draft.brand}
          onChange={(value) => onChange((prev) => ({ ...prev, brand: value }))}
        />
        <LabeledInput
          label="Name"
          value={draft.name}
          onChange={(value) => onChange((prev) => ({ ...prev, name: value }))}
        />
        <LabeledResinFamilySelect
          label="Resin Family"
          value={draft.resinFamily}
          options={RESIN_FAMILY_OPTIONS}
          onChange={(value) => onChange((prev) => ({ ...prev, resinFamily: value }))}
        />
        <LabeledCurrencySelect
          label="Currency"
          value={draft.currencyCode || 'USD'}
          options={CURRENCY_OPTIONS}
          onChange={(value) => onChange((prev) => ({ ...prev, currencyCode: value }))}
        />
        <LabeledNumberInput
          label="Bottle Price"
          value={draft.bottlePrice}
          onChange={(value) => onChange((prev) => ({ ...prev, bottlePrice: value }))}
        />
        <LabeledNumberInput
          label="Bottle Capacity (ml)"
          value={draft.bottleCapacityMl}
          onChange={(value) => onChange((prev) => ({ ...prev, bottleCapacityMl: value }))}
        />
      </div>
    </div>
  );
}

type LabeledCurrencySelectProps = {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
};

function LabeledCurrencySelect({ label, value, options, onChange }: LabeledCurrencySelectProps) {
  return (
    <SelectDropdown
      label={label}
      value={value}
      onChange={(nextValue) => onChange(String(nextValue))}
      options={options.map((option) => ({ value: option, label: option }))}
      className="space-y-1 block"
      labelClassName="font-medium"
      selectClassName="w-full h-[36px] px-2.5 pr-10 leading-tight text-sm"
    />
  );
}

type AutoTrimmedImageProps = {
  src: string;
  alt: string;
  className?: string;
};

const TRIMMED_IMAGE_CACHE_STORAGE_KEY = 'dragonfruit.trimmedImageCache.v1';
const TRIMMED_IMAGE_CACHE_MAX_ENTRIES = 48;
const TRIMMED_IMAGE_CACHE_MAX_PERSISTED_LENGTH = 350_000;

const trimmedImageMemoryCache = new Map<string, string>();
let hasHydratedTrimmedImageCache = false;

function canPersistTrimmedImage(src: string, value: string): boolean {
  if (!src || src.startsWith('data:')) return false;
  return value.length <= TRIMMED_IMAGE_CACHE_MAX_PERSISTED_LENGTH;
}

function persistTrimmedImageCacheToStorage() {
  if (typeof window === 'undefined') return;

  try {
    const entries = Array.from(trimmedImageMemoryCache.entries()).slice(-TRIMMED_IMAGE_CACHE_MAX_ENTRIES);
    const persistableEntries = entries.filter(([key, value]) => canPersistTrimmedImage(key, value));
    localStorage.setItem(TRIMMED_IMAGE_CACHE_STORAGE_KEY, JSON.stringify(persistableEntries));
  } catch {
    // Ignore cache persistence failures (e.g. quota exceeded).
  }
}

function hydrateTrimmedImageCacheFromStorage() {
  if (hasHydratedTrimmedImageCache || typeof window === 'undefined') return;
  hasHydratedTrimmedImageCache = true;

  try {
    const raw = localStorage.getItem(TRIMMED_IMAGE_CACHE_STORAGE_KEY);
    if (!raw) return;

    const entries = JSON.parse(raw) as unknown;
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== 'string' || typeof value !== 'string') continue;
      trimmedImageMemoryCache.set(key, value);
    }
  } catch {
    // Ignore corrupted cache payloads.
  }
}

function cacheTrimmedImage(src: string, value: string) {
  trimmedImageMemoryCache.set(src, value);

  while (trimmedImageMemoryCache.size > TRIMMED_IMAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = trimmedImageMemoryCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    trimmedImageMemoryCache.delete(oldestKey);
  }

  persistTrimmedImageCacheToStorage();
}

type Rgba = { r: number; g: number; b: number; a: number };

function readPixelRgba(pixels: Uint8ClampedArray, width: number, x: number, y: number): Rgba {
  const index = (y * width + x) * 4;
  return {
    r: pixels[index],
    g: pixels[index + 1],
    b: pixels[index + 2],
    a: pixels[index + 3],
  };
}

function rgbaDelta(a: Rgba, b: Rgba): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
    Math.abs(a.a - b.a),
  );
}

function resolveUniformBackgroundColor(width: number, height: number, pixels: Uint8ClampedArray): Rgba | null {
  if (!width || !height) return null;
  const corners = [
    readPixelRgba(pixels, width, 0, 0),
    readPixelRgba(pixels, width, width - 1, 0),
    readPixelRgba(pixels, width, 0, height - 1),
    readPixelRgba(pixels, width, width - 1, height - 1),
  ];

  if (corners.some((corner) => corner.a < 220)) return null;

  const base = corners[0];
  const isUniform = corners.every((corner) => rgbaDelta(corner, base) <= 24);
  if (!isUniform) return null;

  const avg = corners.reduce((acc, corner) => ({
    r: acc.r + corner.r,
    g: acc.g + corner.g,
    b: acc.b + corner.b,
    a: acc.a + corner.a,
  }), { r: 0, g: 0, b: 0, a: 0 });

  return {
    r: Math.round(avg.r / corners.length),
    g: Math.round(avg.g / corners.length),
    b: Math.round(avg.b / corners.length),
    a: Math.round(avg.a / corners.length),
  };
}

function isLikelyBackgroundPixel(pixel: Rgba, background: Rgba | null): boolean {
  if (pixel.a <= 8) return true;
  if (!background) return false;

  const colorDelta = Math.max(
    Math.abs(pixel.r - background.r),
    Math.abs(pixel.g - background.g),
    Math.abs(pixel.b - background.b),
  );
  return pixel.a >= 220 && colorDelta <= 20;
}

async function normalizeUploadedPrinterImageDataUrl(src: string): Promise<string> {
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
    await image.decode();

    const width = image.naturalWidth;
    const height = image.naturalHeight;
    if (!width || !height) return src;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return src;

    ctx.drawImage(image, 0, 0);
    const imageData = ctx.getImageData(0, 0, width, height);
    const pixels = imageData.data;
    const background = resolveUniformBackgroundColor(width, height, pixels);

    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = readPixelRgba(pixels, width, x, y);
        if (!isLikelyBackgroundPixel(pixel, background)) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) return src;

    const trimmedWidth = maxX - minX + 1;
    const trimmedHeight = maxY - minY + 1;
    const pad = Math.max(2, Math.round(Math.max(trimmedWidth, trimmedHeight) * 0.04));
    const paddedMinX = Math.max(0, minX - pad);
    const paddedMinY = Math.max(0, minY - pad);
    const paddedMaxX = Math.min(width - 1, maxX + pad);
    const paddedMaxY = Math.min(height - 1, maxY + pad);
    const paddedWidth = paddedMaxX - paddedMinX + 1;
    const paddedHeight = paddedMaxY - paddedMinY + 1;

    if (paddedWidth >= width * 0.99 && paddedHeight >= height * 0.99) return src;

    const trimmedCanvas = document.createElement('canvas');
    trimmedCanvas.width = paddedWidth;
    trimmedCanvas.height = paddedHeight;
    const trimmedCtx = trimmedCanvas.getContext('2d');
    if (!trimmedCtx) return src;

    trimmedCtx.drawImage(
      canvas,
      paddedMinX,
      paddedMinY,
      paddedWidth,
      paddedHeight,
      0,
      0,
      paddedWidth,
      paddedHeight,
    );

    return trimmedCanvas.toDataURL('image/png');
  } catch {
    return src;
  }
}

function AutoTrimmedImage({ src, alt, className }: AutoTrimmedImageProps) {
  const [displaySrc, setDisplaySrc] = React.useState(src);
  const [isLoading, setIsLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    const process = async () => {
      hydrateTrimmedImageCacheFromStorage();

      const cached = trimmedImageMemoryCache.get(src);
      if (cached) {
        if (!cancelled) {
          setDisplaySrc(cached);
          setIsLoading(false);
        }
        return;
      }

      if (!cancelled) {
        setDisplaySrc(src);
        setIsLoading(true);
      }

      try {
        const image = new Image();
        image.decoding = 'async';
        image.src = src;
        await image.decode();

        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) {
          cacheTrimmedImage(src, src);
          if (!cancelled) {
            setDisplaySrc(src);
            setIsLoading(false);
          }
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cacheTrimmedImage(src, src);
          if (!cancelled) {
            setDisplaySrc(src);
            setIsLoading(false);
          }
          return;
        }

        ctx.drawImage(image, 0, 0);
        const imageData = ctx.getImageData(0, 0, width, height);
        const pixels = imageData.data;
        const background = resolveUniformBackgroundColor(width, height, pixels);

        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;

        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const pixel = readPixelRgba(pixels, width, x, y);
            if (!isLikelyBackgroundPixel(pixel, background)) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }

        if (maxX < minX || maxY < minY) {
          cacheTrimmedImage(src, src);
          if (!cancelled) {
            setDisplaySrc(src);
            setIsLoading(false);
          }
          return;
        }

        const trimmedWidth = maxX - minX + 1;
        const trimmedHeight = maxY - minY + 1;

        const pad = Math.max(2, Math.round(Math.max(trimmedWidth, trimmedHeight) * 0.04));
        const paddedMinX = Math.max(0, minX - pad);
        const paddedMinY = Math.max(0, minY - pad);
        const paddedMaxX = Math.min(width - 1, maxX + pad);
        const paddedMaxY = Math.min(height - 1, maxY + pad);
        const paddedWidth = paddedMaxX - paddedMinX + 1;
        const paddedHeight = paddedMaxY - paddedMinY + 1;

        if (
          paddedWidth >= width * 0.99
          && paddedHeight >= height * 0.99
        ) {
          cacheTrimmedImage(src, src);
          if (!cancelled) {
            setDisplaySrc(src);
            setIsLoading(false);
          }
          return;
        }

        const trimmedCanvas = document.createElement('canvas');
        trimmedCanvas.width = paddedWidth;
        trimmedCanvas.height = paddedHeight;
        const trimmedCtx = trimmedCanvas.getContext('2d');
        if (!trimmedCtx) {
          cacheTrimmedImage(src, src);
          if (!cancelled) {
            setDisplaySrc(src);
            setIsLoading(false);
          }
          return;
        }

        trimmedCtx.drawImage(
          canvas,
          paddedMinX,
          paddedMinY,
          paddedWidth,
          paddedHeight,
          0,
          0,
          paddedWidth,
          paddedHeight,
        );

        const next = trimmedCanvas.toDataURL('image/png');
        cacheTrimmedImage(src, next);
        if (!cancelled) {
          setDisplaySrc(next);
          setIsLoading(false);
        }
      } catch {
        cacheTrimmedImage(src, src);
        if (!cancelled) {
          setDisplaySrc(src);
          setIsLoading(false);
        }
      }
    };

    void process();

    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <div className="relative h-full w-full min-h-0 overflow-hidden">
      {isLoading && (
        <div className="absolute inset-0 z-[1] flex items-center justify-center" style={{ background: 'color-mix(in srgb, #151923, transparent 32%)' }}>
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--accent-secondary)' }} />
        </div>
      )}
      <img
        src={displaySrc}
        alt={alt}
        className={`absolute inset-0 ${className ?? ''} transition-opacity duration-150 opacity-100`}
      />
    </div>
  );
}
