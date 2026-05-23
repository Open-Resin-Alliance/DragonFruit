'use client';

import React from 'react';
import { AlertTriangle, Box, Check, ChevronLeft, ChevronRight, Download, Edit3, FlaskConical, ImagePlus, LayoutGrid, Loader2, Lock, Plus, Printer, RefreshCw, Search, Trash2, Upload, Wifi, WifiOff, X } from 'lucide-react';
import FleetManagement from '@/components/settings/FleetManagement';
import { NumberInput } from '@/components/ui/NumberInput';
import { SelectDropdown } from '@/components/ui/SelectDropdown';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
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
  getRuntimeMaterialPresets,
  getProfileLocalMaterialSettingsAdapter,
  getProfileNetworkUiAdapter,
  type MaterialPreset,
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
import {
  RESIN_FAMILY_COLOR,
  RESIN_FAMILY_OPTIONS,
  CURRENCY_OPTIONS,
  type MaterialDraft,
  type LocalSettingsByOutputDraft,
  FieldTagChip,
  LabeledInput,
  LabeledNumberInput,
  LabeledTwoStageNumberInput,
  LabeledSelectInput,
  LabeledToggleInput,
  LabeledResinFamilySelect,
  LabeledCurrencySelect,
  MaterialProfileFormSections,
  MaterialProfileIdentitySection,
  PluginLocalMaterialSettingsSections,
  ReplacementMaterialEditorShell,
  clampNonNegativeNumber,
} from './profileFormAtoms';

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

type RemoteMaterialsCacheEntry = {
  materials: RemoteMaterialProfile[];
  selectedMaterialId: string;
  fetchedAt: number;
};


const REMOTE_MATERIAL_BY_PRINTER_STORAGE_KEY = 'dragonfruit.network.remoteMaterialByPrinter.v1';

function readRemoteMaterialByPrinter(): Record<string, string> {
  try {
    const raw = localStorage.getItem(REMOTE_MATERIAL_BY_PRINTER_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof k === 'string' && typeof v === 'string' && k.trim() && v.trim()) {
        result[k.trim()] = v.trim();
      }
    }
    return result;
  } catch {
    return {};
  }
}

function writeRemoteMaterialByPrinter(printerId: string, materialId: string): void {
  try {
    const current = readRemoteMaterialByPrinter();
    const next = { ...current, [printerId]: materialId };
    localStorage.setItem(REMOTE_MATERIAL_BY_PRINTER_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore storage errors
  }
}

const OUTPUT_FORMAT_OPTIONS = getAvailableOutputFormatOptions();
const WEBCAM_ROTATION_OPTIONS = [
  { value: '0', label: '0°' },
  { value: '90', label: '90°' },
  { value: '180', label: '180°' },
  { value: '270', label: '270°' },
];

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
  const [showMaterialPresetPicker, setShowMaterialPresetPicker] = React.useState(false);
  const [materialPresetSearch, setMaterialPresetSearch] = React.useState('');
  const [selectedMaterialPresetBrand, setSelectedMaterialPresetBrand] = React.useState<string>('');
  const [isMaterialEditorOpen, setIsMaterialEditorOpen] = React.useState(false);
  const [materialEditorTab, setMaterialEditorTab] = React.useState<string>('meta');
  const [showOfficialLockDialog, setShowOfficialLockDialog] = React.useState(false);
  const [officialLockedProfileId, setOfficialLockedProfileId] = React.useState<string | null>(null);
  const [showOfficialMaterialLockDialog, setShowOfficialMaterialLockDialog] = React.useState(false);
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
    name: 'New Material',
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
  const [selectedLibraryPresetIds, setSelectedLibraryPresetIds] = React.useState<Set<string>>(new Set());
  const [selectedLibraryMaterialKeys, setSelectedLibraryMaterialKeys] = React.useState<Set<string>>(new Set());
  const [manualBuildDimensionsByPrinterId, setManualBuildDimensionsByPrinterId] = React.useState<Record<string, ManualBuildDimensions>>({});
  const [printerRailViewMode, setPrinterRailViewMode] = React.useState<PrinterRailViewMode>('profiles');
  const [isEditFleetUnitModalOpen, setIsEditFleetUnitModalOpen] = React.useState(false);
  const [editingFleetUnitId, setEditingFleetUnitId] = React.useState<string | null>(null);
  const [editingFleetUnitNickname, setEditingFleetUnitNickname] = React.useState('');
  const [editingFleetUnitImageDataUrl, setEditingFleetUnitImageDataUrl] = React.useState<string | null>(null);
  const [showPrinterUpdateDiffModal, setShowPrinterUpdateDiffModal] = React.useState(false);
  const [printerDragId, setPrinterDragId] = React.useState<string | null>(null);
  const imageUploadInputRef = React.useRef<HTMLInputElement | null>(null);
  const fleetUnitImageUploadInputRef = React.useRef<HTMLInputElement | null>(null);
  const printerReachabilityByDeviceId = React.useSyncExternalStore(
    subscribeToPrinterReachability,
    getPrinterReachabilitySnapshot,
    getPrinterReachabilityServerSnapshot,
  );
  const [isLightTheme, setIsLightTheme] = React.useState<boolean>(() => {
    if (typeof document === 'undefined') return false;
    const explicitTheme = document.documentElement.getAttribute('data-theme');
    if (explicitTheme === 'light') return true;
    if (explicitTheme === 'dark') return false;
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
  });

  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const resolveLightTheme = () => {
      const explicitTheme = document.documentElement.getAttribute('data-theme');
      if (explicitTheme === 'light') return true;
      if (explicitTheme === 'dark') return false;
      return window.matchMedia('(prefers-color-scheme: light)').matches;
    };

    const syncTheme = () => setIsLightTheme(resolveLightTheme());
    syncTheme();

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
          syncTheme();
          return;
        }
      }
    });

    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncTheme);
    } else {
      mediaQuery.addListener(syncTheme);
    }

    return () => {
      observer.disconnect();
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', syncTheme);
      } else {
        mediaQuery.removeListener(syncTheme);
      }
    };
  }, []);

  const availablePrinterPresets = React.useMemo(() => getAvailablePrinterPresets(), [profileState]);
  const officialPrinterUpdates = React.useMemo(() => getOfficialPrinterProfileUpdates(profileState), [profileState]);
  const officialPrinterUpdateIds = React.useMemo(
    () => new Set(officialPrinterUpdates.map((update) => update.printerProfileId)),
    [officialPrinterUpdates],
  );
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

  const selectedPrinterSafetyMargins = React.useMemo(() => {
    return {
      front: clampNonNegativeNumber(selectedPrinter?.safetyMarginMm?.front ?? 0),
      back: clampNonNegativeNumber(selectedPrinter?.safetyMarginMm?.back ?? 0),
      left: clampNonNegativeNumber(selectedPrinter?.safetyMarginMm?.left ?? 0),
      right: clampNonNegativeNumber(selectedPrinter?.safetyMarginMm?.right ?? 0),
    };
  }, [
    selectedPrinter?.safetyMarginMm?.front,
    selectedPrinter?.safetyMarginMm?.back,
    selectedPrinter?.safetyMarginMm?.left,
    selectedPrinter?.safetyMarginMm?.right,
  ]);

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

  const availableMaterialPresets = React.useMemo(() => {
    const printerPresetId = selectedPrinter?.officialPresetId?.trim() ?? '';
    return getRuntimeMaterialPresets(printerPresetId.length > 0 ? printerPresetId : undefined);
  }, [profileState, selectedPrinter?.officialPresetId]);

  const materialPresetBrands = React.useMemo(() => {
    const uniq = new Set(availableMaterialPresets.map((preset) => (preset.brand || 'Default').trim() || 'Default'));
    return Array.from(uniq).sort((a, b) => a.localeCompare(b));
  }, [availableMaterialPresets]);

  const filteredMaterialPresets = React.useMemo(() => {
    const search = materialPresetSearch.trim().toLowerCase();
    return availableMaterialPresets.filter((preset) => {
      const presetBrand = (preset.brand || 'Default').trim() || 'Default';
      const brandMatch = search.length > 0 || selectedMaterialPresetBrand.length === 0 || presetBrand === selectedMaterialPresetBrand;
      const searchMatch =
        search.length === 0
        || preset.name.toLowerCase().includes(search)
        || presetBrand.toLowerCase().includes(search)
        || preset.resinFamily.toLowerCase().includes(search);
      return brandMatch && searchMatch;
    });
  }, [availableMaterialPresets, materialPresetSearch, selectedMaterialPresetBrand]);

  const groupedFilteredMaterialPresets = React.useMemo(() => {
    const grouped = new Map<string, typeof filteredMaterialPresets>();
    filteredMaterialPresets.forEach((preset) => {
      const family = RESIN_FAMILY_OPTIONS.find((option) => option.value === preset.resinFamily)?.label ?? 'Other';
      const current = grouped.get(family);
      if (current) current.push(preset);
      else grouped.set(family, [preset]);
    });

    return Array.from(grouped.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, presets]) => ({ family, presets }));
  }, [filteredMaterialPresets]);

  const isSearchingMaterialPresets = materialPresetSearch.trim().length > 0;

  const addedOfficialMaterialTemplateIds = React.useMemo(() => {
    const set = new Set<string>();
    printerMaterials.forEach((material) => {
      const templateId = typeof material.officialTemplateId === 'string' ? material.officialTemplateId.trim() : '';
      if (templateId.length > 0) set.add(templateId);
    });
    return set;
  }, [printerMaterials]);

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
  const remoteMaterialsCacheRef = React.useRef<Map<string, RemoteMaterialsCacheEntry>>(new Map());
  const lastHandledOpenPrinterLibraryTokenRef = React.useRef(0);
  const lastHandledOpenNetworkSettingsTokenRef = React.useRef(0);
  const wasOpenRef = React.useRef(false);
  const materialSelectionInitializedRef = React.useRef(false);
  const lastInitializedNetworkPrinterIdRef = React.useRef<string | null>(null);
  const discoveryInFlightRef = React.useRef(false);
  const discoveryRunIdRef = React.useRef(0);

  React.useEffect(() => {
    selectedRemoteMaterialIdRef.current = selectedRemoteMaterialId;
  }, [selectedRemoteMaterialId]);

  const persistedRemoteMaterialIdForSelectedPrinter = React.useMemo(() => {
    if (!selectedPrinter) return '';

    const normalize = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

    const fromConnection = normalize(selectedPrinter.networkConnection?.selectedMaterialId);
    if (fromConnection.length > 0) return fromConnection;

    const fleet = Array.isArray(selectedPrinter.networkFleet) ? selectedPrinter.networkFleet : [];
    const activeNetworkDeviceId = normalize(selectedPrinter.activeNetworkDeviceId);
    if (activeNetworkDeviceId.length > 0) {
      const fromActiveDevice = normalize(
        fleet.find((device) => device.id === activeNetworkDeviceId)?.selectedMaterialId,
      );
      if (fromActiveDevice.length > 0) return fromActiveDevice;
    }

    const normalizedHost = normalize(selectedPrinter.networkConnection?.ipAddress || selectedPrinter.network?.ipAddress).toLowerCase();
    if (normalizedHost.length > 0) {
      const fromHostMatchedDevice = normalize(
        fleet.find((device) => (device.ipAddress || '').trim().toLowerCase() === normalizedHost)?.selectedMaterialId,
      );
      if (fromHostMatchedDevice.length > 0) return fromHostMatchedDevice;
    }

    return normalize(fleet.find((device) => normalize(device.selectedMaterialId).length > 0)?.selectedMaterialId);
  }, [selectedPrinter]);

  React.useEffect(() => {
    setSelectedRemoteMaterialId((current) => (
      current === persistedRemoteMaterialIdForSelectedPrinter
        ? current
        : persistedRemoteMaterialIdForSelectedPrinter
    ));
  }, [persistedRemoteMaterialIdForSelectedPrinter, selectedPrinter?.id]);

  const selectedPrinterResolvedId = selectedPrinter?.id ?? '';
  const selectedPrinterNetworkSupportMode = selectedPrinter?.networkSupport ?? null;
  const selectedRemoteMaterialHost = (selectedPrinter?.networkConnection?.ipAddress || selectedPrinter?.network?.ipAddress || '').trim();
  const remoteMaterialsCacheKey = React.useMemo(() => {
    if (!networkUiAdapter) return '';
    if (!selectedPrinterResolvedId) return '';
    const normalizedHost = selectedRemoteMaterialHost.trim().toLowerCase();
    if (!normalizedHost) return '';
    return `${networkUiAdapter.pluginId}::${selectedPrinterResolvedId}::${normalizedHost}`;
  }, [networkUiAdapter, selectedPrinterResolvedId, selectedRemoteMaterialHost]);
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
  const selectedPrinterUpdateDiffItems = React.useMemo(() => {
    if (!selectedPrinter || !selectedPrinterPreset || !selectedPrinterUpdate) return [] as Array<{ label: string; current: string; next: string }>;

    const preset = selectedPrinterPreset as any;
    const profile = selectedPrinter;

    const normalizeOutputFormat = (value: unknown): string => {
      if (typeof value !== 'string') return '.lys';
      const trimmed = value.trim().toLowerCase();
      if (!trimmed) return '.lys';
      return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
    };

    const nextComparable = {
      name: preset.name,
      manufacturer: preset.manufacturer,
      imageDataUrl: typeof preset.imageAssetPath === 'string' && preset.imageAssetPath.trim().length > 0
        ? preset.imageAssetPath
        : profile.imageDataUrl,
      antiAliasing: typeof preset.antiAliasing === 'boolean' ? preset.antiAliasing : undefined,
      networkSupport: typeof preset.networkSupport === 'string' && preset.networkSupport.trim().length > 0
        ? preset.networkSupport.trim().toLowerCase()
        : undefined,
      hasCamera: typeof preset.hasCamera === 'boolean' ? preset.hasCamera : undefined,
      networkFilter: typeof preset.networkFilter === 'string' && preset.networkFilter.trim().length > 0
        ? preset.networkFilter.trim()
        : undefined,
      platformBadge: preset.platformBadge,
      pixelSize: preset.pixelSize,
      bitDepth: preset.bitDepth,
      buildDimensionMode: preset.buildDimensionMode === 'auto' || preset.buildDimensionMode === 'manual'
        ? preset.buildDimensionMode
        : 'manual',
      officialPresetId: preset.presetId,
      officialPresetVersion: selectedPrinterUpdate.latestVersion,
      isOfficial: true,
      isCustom: false,
      buildVolumeMm: preset.buildVolumeMm,
      display: {
        resolutionX: Number(preset.display?.resolutionX),
        resolutionY: Number(preset.display?.resolutionY),
        outputFormat: normalizeOutputFormat(preset.display?.outputFormat),
        formatVersion: preset.display?.formatVersion,
        settingsMode: preset.display?.settingsMode,
        mirrorX: typeof preset.display?.mirrorX === 'boolean' ? preset.display.mirrorX : false,
        mirrorY: typeof preset.display?.mirrorY === 'boolean' ? preset.display.mirrorY : false,
      },
    };

    const currentComparable = {
      name: profile.name,
      manufacturer: profile.manufacturer,
      imageDataUrl: profile.imageDataUrl,
      antiAliasing: profile.antiAliasing,
      networkSupport: profile.networkSupport,
      hasCamera: profile.hasCamera,
      networkFilter: profile.networkFilter,
      platformBadge: profile.platformBadge,
      pixelSize: profile.pixelSize,
      bitDepth: profile.bitDepth,
      buildDimensionMode: profile.buildDimensionMode,
      officialPresetId: profile.officialPresetId,
      officialPresetVersion: profile.officialPresetVersion,
      isOfficial: profile.isOfficial,
      isCustom: profile.isCustom,
      buildVolumeMm: profile.buildVolumeMm,
      display: {
        resolutionX: profile.display.resolutionX,
        resolutionY: profile.display.resolutionY,
        outputFormat: profile.display.outputFormat,
        formatVersion: profile.display.formatVersion,
        settingsMode: profile.display.settingsMode,
        mirrorX: profile.display.mirrorX,
        mirrorY: profile.display.mirrorY,
      },
    };

    const isPlainObject = (value: unknown): value is Record<string, unknown> => {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    };

    const toDisplayString = (value: unknown): string => {
      if (value == null) return '—';
      if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
      if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : '—';
      }
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    const toFieldLabel = (path: string): string => {
      return path
        .split('.')
        .map((segment) => segment
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .replace(/[_-]+/g, ' ')
          .replace(/^./, (char) => char.toUpperCase()))
        .join(' › ');
    };

    const rows: Array<{ label: string; current: string; next: string }> = [];

    const walkDiff = (currentValue: unknown, nextValue: unknown, path: string): void => {
      if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
        const keys = Array.from(new Set([...Object.keys(currentValue), ...Object.keys(nextValue)])).sort((a, b) => a.localeCompare(b));
        keys.forEach((key) => {
          walkDiff(
            (currentValue as Record<string, unknown>)[key],
            (nextValue as Record<string, unknown>)[key],
            path ? `${path}.${key}` : key,
          );
        });
        return;
      }

      const currentSerialized = toDisplayString(currentValue);
      const nextSerialized = toDisplayString(nextValue);
      if (currentSerialized === nextSerialized) return;

      rows.push({
        label: toFieldLabel(path),
        current: currentSerialized,
        next: nextSerialized,
      });
    };

    walkDiff(currentComparable, nextComparable, '');
    return rows;
  }, [selectedPrinter, selectedPrinterPreset, selectedPrinterUpdate]);
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
  const canShowFleetRailMode = selectedPrinterSupportsNetworkSettings && selectedPrinterFleetCount > 0;
  const shouldRenderFleetRail = selectedPrinterSupportsNetworkSettings && printerRailViewMode === 'fleet';
  const printerRailEntryCount = shouldRenderFleetRail ? managedNetworkPrinters.length : profileState.printerProfiles.length;
  const shouldConstrainPrinterRailHeight = printerRailEntryCount > 8;
  const selectedPrinterRailIndex = React.useMemo(
    () => profileState.printerProfiles.findIndex((profile) => profile.id === selectedPrinter?.id),
    [profileState.printerProfiles, selectedPrinter?.id],
  );
  const networkSettingsActionLabel = connectedManagedNetworkPrinterCount > 0 ? 'Manage Fleet' : 'Network Settings';
  const shouldShowFleetSwitchAction = selectedPrinterSupportsNetworkSettings && selectedPrinterFleetCount > 0;
  const regularNetworkActionLabel = shouldShowFleetSwitchAction ? 'Show Fleet' : 'Network Settings';
  const accentSecondaryActionColor = isLightTheme
    ? 'color-mix(in srgb, #4f8a08, var(--text-strong) 30%)'
    : 'var(--accent-secondary)';
  const accentSecondaryActionBorderColor = isLightTheme
    ? 'color-mix(in srgb, #6aa20d, var(--border-subtle) 34%)'
    : 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)';
  const accentSecondaryActionBackground92 = isLightTheme
    ? 'color-mix(in srgb, #6aa20d, var(--surface-1) 80%)'
    : 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)';
  const accentSecondaryActionBackground93 = isLightTheme
    ? 'color-mix(in srgb, #6aa20d, var(--surface-1) 82%)'
    : 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)';
  const accentSecondaryActionStyle92: React.CSSProperties = {
    color: accentSecondaryActionColor,
    borderColor: accentSecondaryActionBorderColor,
    background: accentSecondaryActionBackground92,
  };
  const accentSecondaryActionStyle93: React.CSSProperties = {
    color: accentSecondaryActionColor,
    borderColor: accentSecondaryActionBorderColor,
    background: accentSecondaryActionBackground93,
  };
  const printerImageWellBackground = isLightTheme
    ? 'color-mix(in srgb, var(--surface-2), white 20%)'
    : '#1c2027';
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
              background: printerImageWellBackground,
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
  }, [printerImageWellBackground]);
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

    if (selectedPrinterFleetCount > 0) {
      return;
    }

    if (printerRailViewMode === 'fleet') {
      setPrinterRailViewMode('profiles');
    }
  }, [printerRailViewMode, selectedPrinterFleetCount, selectedPrinterSupportsNetworkSettings]);

  React.useLayoutEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false;
      materialSelectionInitializedRef.current = false;
      return;
    }

    const justOpened = !wasOpenRef.current;
    if (!justOpened) {
      return;
    }
    wasOpenRef.current = true;
    materialSelectionInitializedRef.current = false;

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
    setIsMaterialEditorOpen(false);
    setIsEditingPrinter(false);
    setIsNetworkSettingsOpen(shouldOpenNetworkSettings);
    setShowPresetPicker(shouldOpenPrinterLibrary && !shouldOpenNetworkSettings);
    setPresetSearch('');
    if (presetManufacturers.length > 0) setSelectedPresetManufacturer(presetManufacturers[0]);
    const materials = getMaterialProfilesForPrinter(profileState.activePrinterProfileId, profileState);
    const activeMaterial = materials.find((material) => material.id === profileState.activeMaterialProfileId)
      ?? materials[0]
      ?? null;
    setSelectedMaterialId(activeMaterial?.id ?? null);
    setSelectedManufacturer(activeMaterial?.brand ?? null);
    setSelectedResinFamily(activeMaterial?.resinFamily ?? null);
  }, [
    initialTab,
    isOpen,
    openNetworkSettingsToken,
    openPrinterLibraryToken,
    profileState.activeMaterialProfileId,
    profileState.activePrinterProfileId,
    profileState,
    presetManufacturers,
  ]);

  React.useLayoutEffect(() => {
    if (selectedMaterialPresetBrand.length === 0 && materialPresetBrands.length > 0) {
      setSelectedMaterialPresetBrand(materialPresetBrands[0]);
    }
  }, [materialPresetBrands, selectedMaterialPresetBrand]);

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
      materialSelectionInitializedRef.current = false;
      setSelectedMaterialId(null);
      setSelectedManufacturer(null);
      setSelectedResinFamily(null);
      return;
    }

    if (availableManufacturers.length === 0) {
      materialSelectionInitializedRef.current = false;
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
      const shouldRestoreRememberedSelection = !materialSelectionInitializedRef.current;
      const mappedMaterialIdForPrinter = typeof profileState.activeMaterialProfileIdByPrinterId?.[selectedPrinter.id] === 'string'
        ? profileState.activeMaterialProfileIdByPrinterId[selectedPrinter.id]!.trim()
        : '';
      const fallbackActiveMaterialId = typeof profileState.activeMaterialProfileId === 'string'
        ? profileState.activeMaterialProfileId.trim()
        : '';
      const rememberedMaterialId = [mappedMaterialIdForPrinter, fallbackActiveMaterialId]
        .find((materialId) => materialId.length > 0 && printerMaterials.some((material) => material.id === materialId))
        ?? '';

      const nextSelectedMaterialId = shouldRestoreRememberedSelection
        ? (
          rememberedMaterialId
          || filteredMaterialProfiles[0]?.id
          || printerMaterials[0]?.id
          || null
        )
        : (filteredMaterialProfiles[0]?.id ?? null);
      setSelectedMaterialId(nextSelectedMaterialId);

      const nextMaterial = nextSelectedMaterialId
        ? printerMaterials.find((material) => material.id === nextSelectedMaterialId) ?? null
        : null;
      if (nextMaterial && shouldRestoreRememberedSelection) {
        setSelectedManufacturer(nextMaterial.brand ?? null);
        setSelectedResinFamily(nextMaterial.resinFamily ?? null);
      }

      if (nextSelectedMaterialId) {
        if (shouldRestoreRememberedSelection) {
          materialSelectionInitializedRef.current = true;
        } else {
          setActiveMaterialProfile(nextSelectedMaterialId);
        }
      }
      return;
    }

    materialSelectionInitializedRef.current = true;

    if (profileState.activeMaterialProfileId !== selectedMaterialId) {
      setActiveMaterialProfile(selectedMaterialId);
    }
  }, [
    isOpen,
    profileState.activeMaterialProfileId,
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

    const handleTopMostDialogEscape = (): boolean => {
      if (deleteConfirmTarget) {
        setDeleteConfirmTarget(null);
        return true;
      }

      if (showOfficialMaterialLockDialog) {
        setShowOfficialMaterialLockDialog(false);
        return true;
      }

      if (showOfficialLockDialog) {
        setShowOfficialLockDialog(false);
        setOfficialLockedProfileId(null);
        return true;
      }

      if (showPrinterUpdateDiffModal) {
        setShowPrinterUpdateDiffModal(false);
        return true;
      }

      if (isEditFleetUnitModalOpen) {
        setIsEditFleetUnitModalOpen(false);
        return true;
      }

      if (isRemoteMaterialEditDialogOpen) {
        if (!isSavingRemoteMaterialEdit) {
          setIsRemoteMaterialEditDialogOpen(false);
        }
        return true;
      }

      if (isNetworkSettingsOpen) {
        setIsNetworkSettingsOpen(false);
        return true;
      }

      if (showPresetPicker) {
        setShowPresetPicker(false);
        return true;
      }

      if (showMaterialPresetPicker) {
        setShowMaterialPresetPicker(false);
        return true;
      }

      if (isMaterialEditorOpen) {
        setIsMaterialEditorOpen(false);
        return true;
      }

      if (isCreateMaterialOpen) {
        setIsCreateMaterialOpen(false);
        return true;
      }

      if (isEditingPrinter) {
        setIsEditingPrinter(false);
        return true;
      }

      return false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (event.defaultPrevented) return;

      if (handleTopMostDialogEscape()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    deleteConfirmTarget,
    isCreateMaterialOpen,
    isEditFleetUnitModalOpen,
    isEditingPrinter,
    isMaterialEditorOpen,
    isNetworkSettingsOpen,
    isOpen,
    isRemoteMaterialEditDialogOpen,
    isSavingRemoteMaterialEdit,
    onClose,
    showMaterialPresetPicker,
    showOfficialLockDialog,
    showOfficialMaterialLockDialog,
    showPresetPicker,
    showPrinterUpdateDiffModal,
  ]);

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

  React.useEffect(() => {
    if (!selectedPrinterUpdate) {
      setShowPrinterUpdateDiffModal(false);
    }
  }, [selectedPrinterUpdate]);

  const loadRemoteMaterials = React.useCallback(async (options?: { background?: boolean }) => {
    if (!selectedPrinterResolvedId) return;
    if (!networkUiAdapter) return;

    const host = selectedRemoteMaterialHost;
    if (!host) {
      setRemoteMaterials([]);
      setIsLoadingRemoteMaterials(false);
      setRemoteMaterialsError(`Connect to a ${selectedNetworkModeLabel} printer to load on-device materials.`);
      return;
    }

    const useBackgroundRefresh = options?.background === true;
    const cachedEntry = remoteMaterialsCacheKey
      ? remoteMaterialsCacheRef.current.get(remoteMaterialsCacheKey) ?? null
      : null;

    if (cachedEntry?.materials?.length) {
      setRemoteMaterials(cachedEntry.materials);
      if (!selectedRemoteMaterialIdRef.current && cachedEntry.selectedMaterialId) {
        setSelectedRemoteMaterialId(cachedEntry.selectedMaterialId);
      }
    }

    setIsLoadingRemoteMaterials(true);
    if (!useBackgroundRefresh) {
      setRemoteMaterialsError(null);
    }

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

      const storedId = selectedPrinterResolvedId ? (readRemoteMaterialByPrinter()[selectedPrinterResolvedId] ?? '') : '';
      const preferredId = storedId
        || persistedRemoteMaterialIdForSelectedPrinter
        || selectedRemoteMaterialIdRef.current;
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

      if (remoteMaterialsCacheKey) {
        remoteMaterialsCacheRef.current.set(remoteMaterialsCacheKey, {
          materials,
          selectedMaterialId: nextSelected?.id ?? '',
          fetchedAt: Date.now(),
        });
      }

      const errorMessage = typeof payload?.error === 'string' ? payload.error : '';
      if (errorMessage) {
        setRemoteMaterialsError(errorMessage);
      } else {
        setRemoteMaterialsError(null);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to load ${selectedNetworkModeLabel} materials.`;
      if (!cachedEntry?.materials?.length) {
        setRemoteMaterials([]);
      }
      setRemoteMaterialsError(message);
    } finally {
      setIsLoadingRemoteMaterials(false);
    }
  }, [effectiveNetworkUiAdapter, networkUiAdapter, remoteMaterialsCacheKey, selectedNetworkModeLabel, selectedRemoteMaterialHost, selectedPrinterResolvedId]);

  React.useEffect(() => {
    if (!shouldUseRemoteOnDeviceMaterials || !selectedPrinterResolvedId) {
      setRemoteMaterials([]);
      setSelectedRemoteMaterialId('');
      setIsRemoteMaterialEditDialogOpen(false);
      setRemoteMaterialsError(null);
      return;
    }

    const cachedEntry = remoteMaterialsCacheKey
      ? remoteMaterialsCacheRef.current.get(remoteMaterialsCacheKey) ?? null
      : null;
    if (cachedEntry?.materials?.length) {
      setRemoteMaterials(cachedEntry.materials);
      if (!selectedRemoteMaterialIdRef.current && cachedEntry.selectedMaterialId) {
        setSelectedRemoteMaterialId(cachedEntry.selectedMaterialId);
      }
    }

    void loadRemoteMaterials({ background: true });
  }, [loadRemoteMaterials, remoteMaterialsCacheKey, selectedPrinterResolvedId, shouldUseRemoteOnDeviceMaterials]);

  const handleSelectRemoteMaterial = React.useCallback((material: RemoteMaterialProfile) => {
    if (!selectedPrinter) return;
    const processValues = effectiveNetworkUiAdapter.resolveMaterialProcessValues(material.meta ?? {});
    setSelectedRemoteMaterialId(material.id);
    writeRemoteMaterialByPrinter(selectedPrinter.id, material.id);
    if (remoteMaterialsCacheKey) {
      const cachedEntry = remoteMaterialsCacheRef.current.get(remoteMaterialsCacheKey);
      if (cachedEntry) {
        remoteMaterialsCacheRef.current.set(remoteMaterialsCacheKey, {
          ...cachedEntry,
          selectedMaterialId: material.id,
        });
      }
    }
    updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
      selectedMaterialId: material.id,
      selectedMaterialName: material.name,
      selectedMaterialLayerHeightMm: processValues.layerHeightMm,
      selectedMaterialNormalExposureSec: processValues.normalExposureSec,
      selectedMaterialBottomExposureSec: processValues.bottomExposureSec,
      selectedMaterialBottomLayerCount: processValues.bottomLayerCount,
    });
  }, [effectiveNetworkUiAdapter, remoteMaterialsCacheKey, selectedPrinter]);

  const openRemoteMaterialEditDialog = React.useCallback(() => {
    if (effectiveNetworkUiAdapter.remoteMaterialEditingWipNotice) return;
    if (!selectedRemoteMaterial) return;
    setRemoteMaterialEditDraft(effectiveNetworkUiAdapter.resolveEditDraftFromMeta(selectedRemoteMaterial.meta ?? {}));
    setRemoteMaterialEditTab('basic');
    setIsRemoteMaterialEditDialogOpen(true);
  }, [effectiveNetworkUiAdapter, selectedRemoteMaterial]);

  const openRemoteMaterialEditDialogForMaterial = React.useCallback((material: RemoteMaterialProfile) => {
    if (effectiveNetworkUiAdapter.remoteMaterialEditingWipNotice) return;
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
    materialSelectionInitializedRef.current = false;
    setSelectedPrinterId(printerId);
    setIsEditingPrinter(false);
    setActivePrinterProfile(printerId);
    const snapshot = getProfileStoreSnapshot();
    const materials = getMaterialProfilesForPrinter(printerId, snapshot);
    const mappedId = typeof snapshot.activeMaterialProfileIdByPrinterId?.[printerId] === 'string'
      ? snapshot.activeMaterialProfileIdByPrinterId[printerId]!.trim()
      : '';
    const restored = materials.find((material) => material.id === mappedId)
      ?? materials.find((material) => material.id === snapshot.activeMaterialProfileId)
      ?? materials[0]
      ?? null;
    setSelectedMaterialId(restored?.id ?? null);
    if (restored) {
      setSelectedManufacturer((restored.brand || 'Default').trim() || 'Default');
      setSelectedResinFamily(restored.resinFamily);
    }
  }, []);

  const handleAddPrinter = React.useCallback(() => {
    setSelectedLibraryPresetIds(new Set());
    setShowPresetPicker(true);
  }, []);

  const handleAddPrinterFromPreset = React.useCallback((presetId: string) => {
    const newId = addPrinterProfileFromPreset(presetId);
    handlePickPrinter(newId);
    setShowPresetPicker(false);
    setPresetSearch('');
    if (presetManufacturers.length > 0) setSelectedPresetManufacturer(presetManufacturers[0]);
  }, [handlePickPrinter, presetManufacturers]);

  const handleAddSelectedPrinterPresets = React.useCallback(() => {
    if (selectedLibraryPresetIds.size === 0) return;
    let lastId: string | null = null;
    for (const presetId of selectedLibraryPresetIds) {
      lastId = addPrinterProfileFromPreset(presetId);
    }
    if (lastId) handlePickPrinter(lastId);
    setShowPresetPicker(false);
    setPresetSearch('');
    setSelectedLibraryPresetIds(new Set());
    if (presetManufacturers.length > 0) setSelectedPresetManufacturer(presetManufacturers[0]);
  }, [selectedLibraryPresetIds, handlePickPrinter, presetManufacturers]);

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

  const handleApplyMaterialLibraryPreset = React.useCallback((preset: MaterialPreset) => {
    if (!selectedPrinter) return;
    setShowMaterialPresetPicker(false);
    setMaterialEditorTab('meta');
    setNewMaterialDraft({
      name: preset.name,
      brand: preset.brand ?? 'Default',
      currencyCode: preset.currencyCode ?? 'USD',
      bottlePrice: preset.bottlePrice ?? 0,
      bottleCapacityMl: preset.bottleCapacityMl ?? 1000,
      resinFamily: preset.resinFamily ?? 'standard',
      scaleCompensationPct: preset.scaleCompensationPct ?? { x: 0, y: 0, z: 0 },
      layerHeightMm: preset.layerHeightMm ?? 0.05,
      normalExposureSec: preset.normalExposureSec ?? 2.5,
      bottomExposureSec: preset.bottomExposureSec ?? 28,
      bottomLayerCount: preset.bottomLayerCount ?? 5,
      liftDistanceMm: preset.liftDistanceMm ?? 6,
      liftSpeedMmMin: preset.liftSpeedMmMin ?? 60,
      retractSpeedMmMin: preset.retractSpeedMmMin ?? 150,
      minimumAaAlphaPercent: preset.minimumAaAlphaPercent ?? 35,
      ...(preset.templateId ? { officialTemplateId: preset.templateId } : {}),
      ...(preset.profileVersion != null ? { officialTemplateVersion: preset.profileVersion } : {}),
    });
    setNewMaterialLocalSettingsByOutput(
      preset.localSettingsByOutput
        ? (preset.localSettingsByOutput as Record<string, Record<string, string | number | boolean>>)
        : resolveDefaultLocalSettingsForOutput(
            selectedPrinter.display.outputFormat,
            selectedResolvedSettingsMode,
          ),
    );
    setIsCreateMaterialOpen(true);
  }, [selectedPrinter, selectedResolvedSettingsMode]);

  const handleOpenMaterialLibrary = React.useCallback(() => {
    setSelectedLibraryMaterialKeys(new Set());
    setShowMaterialPresetPicker(true);
    setMaterialPresetSearch('');
    if (materialPresetBrands.length > 0) setSelectedMaterialPresetBrand(materialPresetBrands[0]);
  }, [materialPresetBrands]);

  const handleAddSelectedMaterialPresets = React.useCallback(() => {
    if (!selectedPrinter || selectedLibraryMaterialKeys.size === 0) return;
    let lastId: string | null = null;
    let lastBrand = 'Default';
    let lastFamily = 'standard';
    for (const key of selectedLibraryMaterialKeys) {
      const preset = availableMaterialPresets.find(
        (p) => (p.templateId ?? `${p.brand}::${p.name}`) === key,
      );
      if (!preset) continue;
      const newId = addMaterialProfile(selectedPrinter.id, {
        name: preset.name,
        brand: (preset.brand ?? 'Default').trim() || 'Default',
        currencyCode: preset.currencyCode ?? 'USD',
        bottlePrice: preset.bottlePrice ?? 0,
        bottleCapacityMl: preset.bottleCapacityMl ?? 1000,
        resinFamily: preset.resinFamily ?? 'standard',
        scaleCompensationPct: preset.scaleCompensationPct ?? { x: 0, y: 0, z: 0 },
        layerHeightMm: preset.layerHeightMm ?? 0.05,
        normalExposureSec: preset.normalExposureSec ?? 2.5,
        bottomExposureSec: preset.bottomExposureSec ?? 28,
        bottomLayerCount: preset.bottomLayerCount ?? 5,
        liftDistanceMm: preset.liftDistanceMm ?? 6,
        liftSpeedMmMin: preset.liftSpeedMmMin ?? 60,
        retractSpeedMmMin: preset.retractSpeedMmMin ?? 150,
        minimumAaAlphaPercent: preset.minimumAaAlphaPercent ?? 35,
        ...(preset.templateId ? { officialTemplateId: preset.templateId } : {}),
        ...(preset.profileVersion != null ? { officialTemplateVersion: preset.profileVersion } : {}),
        localSettingsByOutput: preset.localSettingsByOutput
          ? (preset.localSettingsByOutput as Record<string, Record<string, string | number | boolean>>)
          : resolveDefaultLocalSettingsForOutput(selectedPrinter.display.outputFormat, selectedResolvedSettingsMode),
      });
      lastId = newId;
      lastBrand = (preset.brand ?? 'Default').trim() || 'Default';
      lastFamily = preset.resinFamily ?? 'standard';
    }
    if (lastId) {
      setSelectedManufacturer(lastBrand);
      setSelectedResinFamily(lastFamily as 'standard' | 'abs-like' | 'tough' | 'flexible' | 'engineering' | 'other');
      setSelectedMaterialId(lastId);
      setActiveMaterialProfile(lastId);
    }
    setShowMaterialPresetPicker(false);
    setSelectedLibraryMaterialKeys(new Set());
  }, [selectedPrinter, selectedLibraryMaterialKeys, availableMaterialPresets, selectedResolvedSettingsMode]);

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
    const isOfficial = typeof selectedMaterial.officialTemplateId === 'string' && selectedMaterial.officialTemplateId.trim().length > 0;
    if (isOfficial) {
      setShowOfficialMaterialLockDialog(true);
      return;
    }
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
    applyOfficialPrinterProfileUpdate(selectedPrinterUpdate.printerProfileId);
  }, [selectedPrinterUpdate]);

  const handleApplySelectedMaterialOfficialUpdate = React.useCallback(() => {
    if (!selectedMaterialUpdate) return;
    applyOfficialMaterialProfileUpdate(selectedMaterialUpdate.materialProfileId);
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

  const handleDuplicateMaterialAsCustom = React.useCallback(() => {
    if (!selectedMaterial || !selectedPrinter) return;
    const baseName = selectedMaterial.name.includes('Custom') ? selectedMaterial.name : `${selectedMaterial.name} Custom`;
    const newId = addMaterialProfile(selectedPrinter.id, {
      name: baseName,
      brand: selectedMaterial.brand,
      currencyCode: selectedMaterial.currencyCode,
      bottlePrice: selectedMaterial.bottlePrice,
      bottleCapacityMl: selectedMaterial.bottleCapacityMl,
      resinFamily: selectedMaterial.resinFamily,
      scaleCompensationPct: selectedMaterial.scaleCompensationPct,
      layerHeightMm: selectedMaterial.layerHeightMm,
      normalExposureSec: selectedMaterial.normalExposureSec,
      bottomExposureSec: selectedMaterial.bottomExposureSec,
      bottomLayerCount: selectedMaterial.bottomLayerCount,
      liftDistanceMm: selectedMaterial.liftDistanceMm,
      liftSpeedMmMin: selectedMaterial.liftSpeedMmMin,
      retractSpeedMmMin: selectedMaterial.retractSpeedMmMin,
      minimumAaAlphaPercent: selectedMaterial.minimumAaAlphaPercent,
      localSettingsByOutput: selectedMaterial.localSettingsByOutput,
      officialTemplateId: undefined,
      officialTemplateVersion: undefined,
    });
    setSelectedMaterialId(newId);
    setActiveMaterialProfile(newId);
    setShowOfficialMaterialLockDialog(false);
    setIsMaterialEditorOpen(true);
  }, [selectedMaterial, selectedPrinter]);

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

  const handleExportSelectedMaterialBundle = React.useCallback(() => {
    void (async () => {
      if (!selectedMaterial) return;

      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        material: selectedMaterial,
      };

      const safeName = selectedMaterial.name.replace(/[^a-z0-9-_]+/gi, '_').toLowerCase();
      const suggestedFilename = `${safeName || 'material-profile'}-bundle.json`;
      const bytes = new TextEncoder().encode(JSON.stringify(payload, null, 2));

      try {
        await savePrintArtifactWithNativeDialog(bytes, suggestedFilename);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message.toLowerCase().includes('cancel')) return;
        throw error;
      }
    })();
  }, [selectedMaterial]);

  const handleImportSelectedMaterialBundle = React.useCallback(() => {
    void (async () => {
      try {
        if (!selectedPrinter) return;

        const picked = await pickOpenFilesWithNativeDialog('bundle', false);
        const sourcePath = picked[0]?.path?.trim();
        if (!sourcePath) return;

        const bytes = await readPrintArtifactBytesFromPath(sourcePath);
        const payload = JSON.parse(new TextDecoder().decode(bytes)) as {
          material?: Partial<MaterialProfile>;
        };

        const source = payload?.material;
        if (!source || typeof source !== 'object') {
          throw new Error('[ProfileSettingsModal] Invalid material bundle payload');
        }

        const importedId = addMaterialProfile(selectedPrinter.id, {
          officialTemplateId: typeof source.officialTemplateId === 'string' && source.officialTemplateId.trim().length > 0
            ? source.officialTemplateId.trim()
            : undefined,
          officialTemplateVersion: Number.isFinite(Number(source.officialTemplateVersion))
            ? Number(source.officialTemplateVersion)
            : undefined,
          name: typeof source.name === 'string' && source.name.trim().length > 0
            ? source.name.trim()
            : `Material ${printerMaterials.length + 1}`,
          brand: typeof source.brand === 'string' && source.brand.trim().length > 0
            ? source.brand.trim()
            : 'Default',
          currencyCode: typeof source.currencyCode === 'string' && source.currencyCode.trim().length > 0
            ? source.currencyCode.trim().toUpperCase()
            : 'USD',
          bottlePrice: Number.isFinite(Number(source.bottlePrice)) ? Number(source.bottlePrice) : 0,
          bottleCapacityMl: Number.isFinite(Number(source.bottleCapacityMl)) ? Number(source.bottleCapacityMl) : 1000,
          resinFamily: (source.resinFamily ?? 'standard') as MaterialProfile['resinFamily'],
          scaleCompensationPct: {
            x: Number(source.scaleCompensationPct?.x ?? 0),
            y: Number(source.scaleCompensationPct?.y ?? 0),
            z: Number(source.scaleCompensationPct?.z ?? 0),
          },
          layerHeightMm: Number.isFinite(Number(source.layerHeightMm)) ? Number(source.layerHeightMm) : 0.05,
          normalExposureSec: Number.isFinite(Number(source.normalExposureSec)) ? Number(source.normalExposureSec) : 2.5,
          bottomExposureSec: Number.isFinite(Number(source.bottomExposureSec)) ? Number(source.bottomExposureSec) : 28,
          bottomLayerCount: Number.isFinite(Number(source.bottomLayerCount)) ? Math.max(1, Math.round(Number(source.bottomLayerCount))) : 5,
          liftDistanceMm: Number.isFinite(Number(source.liftDistanceMm)) ? Number(source.liftDistanceMm) : 6,
          liftSpeedMmMin: Number.isFinite(Number(source.liftSpeedMmMin)) ? Number(source.liftSpeedMmMin) : 60,
          retractSpeedMmMin: Number.isFinite(Number(source.retractSpeedMmMin)) ? Number(source.retractSpeedMmMin) : 150,
          minimumAaAlphaPercent: Number.isFinite(Number(source.minimumAaAlphaPercent))
            ? Math.max(0, Math.min(100, Number(source.minimumAaAlphaPercent)))
            : 35,
          localSettingsByOutput: source.localSettingsByOutput
            ? (source.localSettingsByOutput as Record<string, Record<string, string | number | boolean>>)
            : resolveDefaultLocalSettingsForOutput(selectedPrinter.display.outputFormat, selectedResolvedSettingsMode),
        });

        const importedBrand = typeof source.brand === 'string' && source.brand.trim().length > 0
          ? source.brand.trim()
          : 'Default';
        const importedFamily = (source.resinFamily ?? 'standard') as MaterialProfile['resinFamily'];
        setSelectedManufacturer(importedBrand);
        setSelectedResinFamily(importedFamily);
        setSelectedMaterialId(importedId);
        setActiveMaterialProfile(importedId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (message.toLowerCase().includes('cancel')) return;
        console.warn('[ProfileSettingsModal] Failed to import material bundle', error);
      }
    })();
  }, [printerMaterials.length, selectedPrinter, selectedResolvedSettingsMode]);

  const renderPresetLibraryCard = React.useCallback((preset: (typeof availablePrinterPresets)[number]) => {
    const isAlreadyAdded = addedOfficialPresetIds.has(preset.presetId);
    const isSelected = selectedLibraryPresetIds.has(preset.presetId);
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

    const handleToggle = () => {
      if (isAlreadyAdded) return;
      setSelectedLibraryPresetIds((prev) => {
        const next = new Set(prev);
        if (next.has(preset.presetId)) next.delete(preset.presetId);
        else next.add(preset.presetId);
        return next;
      });
    };

    return (
      <button
        key={preset.presetId}
        type="button"
        disabled={isAlreadyAdded}
        onClick={handleToggle}
        className="rounded-lg border p-2.5 text-left disabled:opacity-55 transition-[background-color,box-shadow,opacity] duration-150"
        style={{
          borderColor: 'var(--border-subtle)',
          background: isAlreadyAdded
            ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)'
            : isSelected
              ? 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)'
              : 'var(--surface-1)',
          boxShadow: isAlreadyAdded
            ? 'inset 0 0 0 1px color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)'
            : isSelected
              ? 'inset 0 0 0 1.5px color-mix(in srgb, var(--accent), transparent 40%)'
              : 'inset 0 0 0 0 transparent',
        }}
      >
        <div className="h-[132px] rounded-md border overflow-hidden flex items-center justify-center relative" style={{ borderColor: 'var(--border-subtle)', background: '#2b3039' }}>
          {preset.imageAssetPath ? (
            <img
              src={preset.imageAssetPath}
              alt={preset.name}
              className="h-full w-full object-contain"
              loading="eager"
              decoding="async"
              draggable={false}
            />
          ) : (
            isGenericPreset
              ? <Printer className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
              : <ImagePlus className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
          )}
          {isSelected && (
            <span
              className="pointer-events-none absolute top-1 left-1 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full"
              style={{ background: 'var(--accent)', color: '#0a0f0a' }}
            >
              <Check className="w-3 h-3" strokeWidth={3} />
            </span>
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
        <div className="mt-1.5 min-w-0">
          <div className="truncate text-[12px] font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
            {preset.name}
          </div>
          <div className="mt-0.5 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <div className="min-w-0 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {preset.manufacturer}
            </div>
            <span className="shrink-0 inline-flex min-w-[52px] items-center justify-end">
              <span
                className="inline-flex h-[18px] min-w-[44px] items-center justify-center rounded border px-1.5 text-[10px]"
                style={{
                  borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)',
                  color: 'var(--accent-secondary)',
                  visibility: isAlreadyAdded ? 'visible' : 'hidden',
                }}
                aria-hidden={!isAlreadyAdded}
              >
                Added
              </span>
            </span>
          </div>
        </div>
      </button>
    );
  }, [addedOfficialPresetIds, availablePrinterPresets, selectedLibraryPresetIds]);

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
                borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 30%)',
                background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)',
                color: 'var(--text-muted)',
              }}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: '#d97706' }} />
              <span>
                <strong style={{ color: 'var(--text-strong)' }}>Safety warning:</strong> Custom, non-official profiles may increase the risk of print failure and can potentially damage the machine or cause personal injury. Verify all settings carefully before printing.
              </span>
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
                  style={accentSecondaryActionStyle92}
                >
                  <Plus className="w-4 h-4" />
                  Add Printer
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
                      : 'Each printer can store its own image and has a dedicated set of compatible material profiles.'}
                  </p>
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
                        ? accentSecondaryActionStyle92
                        : accentSecondaryActionStyle93}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Printer
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
                  const hasOfficialUpdate = officialPrinterUpdateIds.has(printer.id);
                  const cardBadgeText = printer.isCustom
                    ? 'CUSTOM'
                    : platformBadge?.text;
                  const resolvedCardBadgeText = hasOfficialUpdate ? 'UPDATE' : cardBadgeText;
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
                    topBadge: resolvedCardBadgeText ? (
                      <span
                        className="pointer-events-none absolute top-1 right-1 z-10 inline-flex h-[18px] min-w-[44px] items-center justify-center whitespace-nowrap rounded-md px-1.5 text-[9px] font-bold leading-none"
                        style={hasOfficialUpdate
                          ? {
                              background: 'linear-gradient(135deg, #22c55e, #15803d)',
                              color: '#ffffff',
                              letterSpacing: '0.04em',
                            }
                          : printer.isCustom
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
                        <span className="relative top-[0.5px]">{resolvedCardBadgeText}</span>
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
                          if (fleetCount > 0) {
                            setPrinterRailViewMode('fleet');
                            return;
                          }
                          setPrinterRailViewMode('profiles');
                          setIsAddingNetworkPrinter(true);
                          setShowManualNetworkEntry(false);
                          setIsNetworkSettingsOpen(true);
                        }}
                        aria-label={fleetCount > 0 ? `Open fleet view (${fleetCount})` : 'Add another networked device'}
                        className="ui-button ui-button-secondary !h-7 !w-7 !px-0 !py-0 text-[11px] inline-flex items-center justify-center rounded-md shrink-0"
                        style={fleetCount > 0
                          ? {
                              color: 'var(--text-strong)',
                              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
                              background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                            }
                          : accentSecondaryActionStyle93}
                        title={fleetCount > 0 ? `Switch to fleet view (${fleetCount})` : 'Add another networked device'}
                      >
                        {fleetCount > 0 ? (
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
                    style={accentSecondaryActionStyle93}
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
                        style={accentSecondaryActionStyle93}
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
                            ? accentSecondaryActionStyle92
                            : { color: 'var(--text-strong)' }}
                        >
                          {shouldShowFleetSwitchAction ? <LayoutGrid className="w-3.5 h-3.5" /> : <Search className="w-3.5 h-3.5" />}
                          {regularNetworkActionLabel}
                        </button>
                      )}
                      {selectedPrinterUpdate && (
                        <button
                          type="button"
                          onClick={() => setShowPrinterUpdateDiffModal(true)}
                          className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                          style={accentSecondaryActionStyle92}
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
                        style={{ color: !hasPrinters ? 'var(--text-muted)' : 'var(--danger)' }}
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
                      {effectiveNetworkUiAdapter.remoteMaterialEditingWipNotice ? (
                        <div className="relative group">
                          <button
                            type="button"
                            disabled
                            aria-label="Edit material (work in progress)"
                            className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md opacity-35 cursor-not-allowed"
                            style={{ color: 'var(--text-strong)', pointerEvents: 'none' }}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            Edit
                          </button>
                          <div
                            className="pointer-events-none absolute right-0 top-full mt-2 z-[70] w-[220px] rounded-md border px-2.5 py-2 text-[10px] leading-tight opacity-0 -translate-y-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-y-0"
                            style={{
                              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)',
                              background: 'color-mix(in srgb, var(--surface-0), black 10%)',
                              color: 'var(--text-muted)',
                              boxShadow: '0 10px 24px rgba(0,0,0,0.28)',
                            }}
                            role="tooltip"
                            aria-hidden="true"
                          >
                            <div className="font-semibold mb-0.5" style={{ color: 'var(--text-strong)' }}>Work in progress</div>
                            <div>{effectiveNetworkUiAdapter.remoteMaterialEditingWipNotice}</div>
                          </div>
                        </div>
                      ) : (
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
                      )}
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
                        onClick={handleOpenMaterialLibrary}
                        className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={{
                          color: 'var(--accent)',
                          borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 42%)',
                          background: 'color-mix(in srgb, var(--accent), var(--surface-1) 92%)',
                        }}
                      >
                        <FlaskConical className="w-3.5 h-3.5" />
                        Library
                      </button>
                      <button
                        type="button"
                        onClick={handleAddMaterial}
                        className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={accentSecondaryActionStyle93}
                      >
                        <Plus className="w-3.5 h-3.5" />
                        New
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="p-3 flex flex-col gap-3 flex-1 min-h-0">
              {shouldUseRemoteOnDeviceMaterials ? (
                <>
                  <div className="rounded-xl border overflow-hidden flex flex-col flex-1 min-h-0" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                      {isLoadingRemoteMaterials && remoteMaterials.length === 0 ? (
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
                              onDoubleClick={effectiveNetworkUiAdapter.remoteMaterialEditingWipNotice
                                ? undefined
                                : () => openRemoteMaterialEditDialogForMaterial(material)}
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
                        style={accentSecondaryActionStyle93}
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
                        style={accentSecondaryActionStyle93}
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
                    <div className="px-2.5 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Material Type</div>
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
                        const isOfficial = typeof material.officialTemplateId === 'string' && material.officialTemplateId.trim().length > 0;
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
                              if (isOfficial) {
                                setShowOfficialMaterialLockDialog(true);
                              } else {
                                setIsMaterialEditorOpen(true);
                              }
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
                              <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-semibold">
                                {isOfficial && <Lock className="w-3.5 h-3.5 shrink-0" />}
                                <span className="truncate">{material.name}</span>
                              </span>
                              <span className="tabular-nums">{Math.round(material.layerHeightMm * 1000)}μm</span>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}>
                <div className="flex flex-wrap items-center gap-2">
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
                  <button
                    type="button"
                    onClick={openSelectedMaterialEditor}
                    disabled={!selectedMaterial}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                    style={{ color: 'var(--text-strong)' }}
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={handleImportSelectedMaterialBundle}
                    disabled={!selectedPrinter}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                    style={{ color: 'var(--text-strong)' }}
                  >
                    <Upload className="w-3.5 h-3.5" />
                    Import
                  </button>
                  <button
                    type="button"
                    onClick={handleExportSelectedMaterialBundle}
                    disabled={!selectedMaterial}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                    style={{ color: 'var(--text-strong)' }}
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export
                  </button>
                  <button
                    type="button"
                    onClick={requestDeleteSelectedMaterial}
                    disabled={!selectedMaterial || printerMaterials.length <= 1}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45 ml-auto"
                    style={{ color: !selectedMaterial || printerMaterials.length <= 1 ? 'var(--text-muted)' : 'var(--danger)' }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
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
                    <div className="h-[220px] w-full rounded-md border overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: printerImageWellBackground }}>
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
                        style={{ color: editingFleetUnitImageDataUrl ? 'var(--danger)' : 'var(--text-muted)' }}
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
                  style={{ color: 'var(--danger)' }}
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
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
                <div className="flex items-center gap-2.5">
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent-secondary), var(--surface-1) 84%), color-mix(in srgb, var(--accent), var(--surface-1) 90%))',
                    }}
                  >
                    <Printer className="w-4 h-4" style={{ color: 'var(--accent-secondary)' }} />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Printer Library</h3>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Choose an official printer preset to add.</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPresetPicker(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
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
                    <div className="space-y-2">
                      {groupedFilteredPrinterPresets.map((group) => (
                        <section key={`${selectedPresetManufacturer}-${group.family}`}>
                          <div className="mb-2 flex items-center gap-3">
                            <div
                              className="h-px flex-1"
                              style={{
                                background: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--border-subtle), transparent 52%) 18%, color-mix(in srgb, var(--text-muted), white 28%) 100%)',
                              }}
                              aria-hidden="true"
                            />
                            <span
                              className="shrink-0 text-[11px] font-semibold tracking-[0.08em]"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              {group.family}
                            </span>
                            <div
                              className="h-px flex-1"
                              style={{
                                background: 'linear-gradient(90deg, color-mix(in srgb, var(--text-muted), white 28%) 0%, color-mix(in srgb, var(--border-subtle), transparent 52%) 82%, transparent 100%)',
                              }}
                              aria-hidden="true"
                            />
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

              {/* Printer Library footer */}
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-t" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
                <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedLibraryPresetIds.size > 0
                    ? `${selectedLibraryPresetIds.size} printer${selectedLibraryPresetIds.size !== 1 ? 's' : ''} selected`
                    : 'Select printers to add'}
                </span>
                <button
                  type="button"
                  aria-disabled={selectedLibraryPresetIds.size === 0}
                  onClick={selectedLibraryPresetIds.size > 0 ? handleAddSelectedPrinterPresets : undefined}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1.5 rounded-md aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                  style={selectedLibraryPresetIds.size > 0 ? accentSecondaryActionStyle92 : undefined}
                >
                  <Plus className="w-3.5 h-3.5" />
                  {selectedLibraryPresetIds.size > 0
                    ? `Add ${selectedLibraryPresetIds.size} Printer${selectedLibraryPresetIds.size !== 1 ? 's' : ''}`
                    : 'Add Printers'}
                </button>
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
                      ? `Edit ${replacementMaterialModalLabel} Material Profile`
                      : 'Material Profile Settings'}
                  </h3>
                  <p className="ui-meta">{selectedMaterial.name} • {selectedMaterial.brand}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsMaterialEditorOpen(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close material editor"
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
                    activeTabStyle={accentSecondaryActionStyle92}
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
                  style={{ color: !selectedMaterial || printerMaterials.length <= 1 ? 'var(--text-muted)' : 'var(--danger)' }}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete Material
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
                    style={accentSecondaryActionStyle92}
                  >
                    <Check className="w-3.5 h-3.5" />
                    Save Material
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
                  <div className="rounded-xl border p-3" style={{ borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 36%)', background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)' }}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-semibold inline-flex items-center gap-1.5" style={{ color: 'var(--text-strong)' }}>
                          <AlertTriangle className="w-4 h-4" style={{ color: '#d97706' }} />
                          Official Profile — Edits Limited!
                        </div>
                        <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                          You can change Output Format, Network Support, Format Version, Webcam Support, and Webcam Rotation here. Everything else stays locked unless you make a custom copy.
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
                        style={accentSecondaryActionStyle92}
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
                            style={{ color: selectedPrinter.imageDataUrl ? 'var(--danger)' : 'var(--text-muted)' }}
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
                      <div className="w-full h-full min-h-0 rounded-md border overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: printerImageWellBackground }}>
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
                        ? accentSecondaryActionStyle92
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

                  <div className="mt-2.5 grid grid-cols-2 md:grid-cols-4 gap-2.5">
                    <LabeledNumberInput
                      label="Front Margin (mm)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinterSafetyMargins.front}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        safetyMarginMm: {
                          ...selectedPrinterSafetyMargins,
                          front: value,
                        },
                      })}
                    />
                    <LabeledNumberInput
                      label="Back Margin (mm)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinterSafetyMargins.back}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        safetyMarginMm: {
                          ...selectedPrinterSafetyMargins,
                          back: value,
                        },
                      })}
                    />
                    <LabeledNumberInput
                      label="Left Margin (mm)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinterSafetyMargins.left}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        safetyMarginMm: {
                          ...selectedPrinterSafetyMargins,
                          left: value,
                        },
                      })}
                    />
                    <LabeledNumberInput
                      label="Right Margin (mm)"
                      disabled={isSelectedPrinterOfficial}
                      value={selectedPrinterSafetyMargins.right}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        safetyMarginMm: {
                          ...selectedPrinterSafetyMargins,
                          right: value,
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

                    {selectedPrinter.hasCamera !== false && (
                      <LabeledSelectInput
                        label="Webcam Rotation"
                        value={String(selectedPrinter.display.webcamRotationDeg ?? 0)}
                        options={WEBCAM_ROTATION_OPTIONS}
                        onChange={(value) => {
                          const parsed = Number(value);
                          const nextRotation = (parsed === 0 || parsed === 90 || parsed === 180 || parsed === 270)
                            ? parsed
                            : 0;
                          handlePrinterDisplayChange({ webcamRotationDeg: nextRotation as NonNullable<PrinterProfile['display']['webcamRotationDeg']> });
                        }}
                      />
                    )}

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
                  style={accentSecondaryActionStyle92}
                >
                  <Check className="w-3.5 h-3.5" />
                  Done
                </button>
              </div>
            </div>
          </div>
        )}

        {showMaterialPresetPicker && selectedPrinter && (
          <div
            className="fixed inset-0 z-[65] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setShowMaterialPresetPicker(false);
            }}
          >
            <div
              className="w-full max-w-[1040px] h-[94vh] max-h-[90vh] min-h-[620px] rounded-xl border shadow-2xl overflow-hidden ui-modal-panel-enter flex flex-col"
              style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
                <div className="flex items-center gap-2.5">
                  <span
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent), var(--surface-1) 86%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%))',
                    }}
                  >
                    <FlaskConical className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                  </span>
                  <div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Material Library</h3>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>Choose an official material preset to add.</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowMaterialPresetPicker(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close material library"
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
                        value={materialPresetSearch}
                        onChange={(event) => setMaterialPresetSearch(event.target.value)}
                        placeholder="Search materials"
                        className="ui-input w-full h-8 text-xs"
                        style={{ paddingLeft: '2.5rem', paddingRight: '0.625rem' }}
                      />
                    </div>
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-1.5 space-y-1">
                    {materialPresetBrands.map((brand) => (
                      <button
                        key={brand}
                        type="button"
                        onClick={() => setSelectedMaterialPresetBrand(brand)}
                        className="w-full rounded-md border px-2.5 py-2 text-left text-sm font-semibold"
                        style={selectedMaterialPresetBrand === brand
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
                        {brand}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="py-2 px-2 overflow-y-auto custom-scrollbar min-h-0">
                  {(() => {
                    const renderMaterialPresetRow = (preset: MaterialPreset, index: number, groupKey: string, showFamily = false) => {
                      const templateId = typeof preset.templateId === 'string' ? preset.templateId.trim() : '';
                      const selectionKey = templateId || `${preset.brand ?? 'Default'}::${preset.name}`;
                      const isAlreadyAdded = templateId.length > 0 && addedOfficialMaterialTemplateIds.has(templateId);
                      const isSelected = !isAlreadyAdded && selectedLibraryMaterialKeys.has(selectionKey);
                      const resinFamilyLabel = RESIN_FAMILY_OPTIONS.find((option) => option.value === preset.resinFamily)?.label ?? preset.resinFamily;
                      const familyColor = RESIN_FAMILY_COLOR[preset.resinFamily] ?? '#94a3b8';

                      const handleToggle = () => {
                        if (isAlreadyAdded) return;
                        setSelectedLibraryMaterialKeys((prev) => {
                          const next = new Set(prev);
                          if (next.has(selectionKey)) next.delete(selectionKey);
                          else next.add(selectionKey);
                          return next;
                        });
                      };

                      return (
                        <button
                          key={templateId || `${groupKey}-${preset.brand || 'Default'}-${preset.name}-${index}`}
                          type="button"
                          disabled={isAlreadyAdded}
                          onClick={handleToggle}
                          className="w-full rounded-lg border text-left transition-colors overflow-hidden disabled:opacity-60"
                          style={isAlreadyAdded
                            ? {
                                borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
                                background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent-secondary), var(--surface-1) 91%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 96%))',
                              }
                            : isSelected
                              ? {
                                  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 20%)',
                                  background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                                  outline: '1.5px solid color-mix(in srgb, var(--accent), transparent 40%)',
                                }
                              : {
                                  borderColor: 'var(--border-subtle)',
                                  background: 'var(--surface-1)',
                                }}
                        >
                          <div className="flex h-full">
                            <div className="w-[3px] shrink-0 self-stretch" style={{ background: isAlreadyAdded ? 'var(--accent-secondary)' : isSelected ? 'var(--accent)' : familyColor }} />
                            <div className="flex-1 min-w-0 px-3 py-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>{preset.name}</span>
                                <div className="shrink-0 flex items-center gap-1.5">
                                  {showFamily && !isAlreadyAdded && !isSelected && (
                                    <span
                                      className="text-[10px] rounded-full border px-1.5 py-0.5 font-medium whitespace-nowrap"
                                      style={{ borderColor: `color-mix(in srgb, ${familyColor}, transparent 45%)`, color: familyColor, background: `color-mix(in srgb, ${familyColor}, var(--surface-0) 88%)` }}
                                    >
                                      {resinFamilyLabel}
                                    </span>
                                  )}
                                  {isSelected && (
                                    <span
                                      className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                                      style={{ background: 'var(--accent)', color: '#0a0f0a' }}
                                    >
                                      <Check className="w-3 h-3" strokeWidth={3} />
                                    </span>
                                  )}
                                  {isAlreadyAdded && (
                                    <span
                                      className="text-[10px] rounded-full border px-1.5 py-0.5 font-semibold whitespace-nowrap"
                                      style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)', color: 'var(--accent-secondary)' }}
                                    >
                                      Added
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                  {`${preset.layerHeightMm * 1000}μm · ${preset.normalExposureSec}s`}
                                </span>
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    };

                    if (isSearchingMaterialPresets) {
                      return (
                        <div className="space-y-1.5">
                          {filteredMaterialPresets.map((preset, index) => renderMaterialPresetRow(preset, index, 'search', true))}
                        </div>
                      );
                    }

                    return (
                      <div className="space-y-4">
                        {groupedFilteredMaterialPresets.map((group) => {
                          const familyColor = RESIN_FAMILY_COLOR[group.family] ?? '#94a3b8';
                          return (
                          <section key={`${selectedMaterialPresetBrand}-${group.family}`}>
                            <div className="flex items-center gap-2 mb-1.5 px-0.5">
                              <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: familyColor }} />
                              <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: familyColor }}>
                                {group.family}
                              </span>
                            </div>
                            <div className="space-y-1.5">
                              {group.presets.map((preset, index) => renderMaterialPresetRow(preset, index, group.family))}
                            </div>
                          </section>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              </div>

              {/* Material Library footer */}
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-t" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
                <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
                  {selectedLibraryMaterialKeys.size > 0
                    ? `${selectedLibraryMaterialKeys.size} material${selectedLibraryMaterialKeys.size !== 1 ? 's' : ''} selected`
                    : 'Select materials to add'}
                </span>
                <button
                  type="button"
                  aria-disabled={selectedLibraryMaterialKeys.size === 0}
                  onClick={selectedLibraryMaterialKeys.size > 0 ? handleAddSelectedMaterialPresets : undefined}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1.5 rounded-md aria-disabled:cursor-not-allowed aria-disabled:opacity-45"
                  style={selectedLibraryMaterialKeys.size > 0 ? accentSecondaryActionStyle92 : undefined}
                >
                  <Plus className="w-3.5 h-3.5" />
                  {selectedLibraryMaterialKeys.size > 0
                    ? `Add ${selectedLibraryMaterialKeys.size} Material${selectedLibraryMaterialKeys.size !== 1 ? 's' : ''}`
                    : 'Add Materials'}
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
                      ? `Create ${replacementMaterialModalLabel} Material Profile`
                      : 'Create Material Profile'}
                  </h3>
                  <p className="ui-meta">{selectedPrinter.name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsCreateMaterialOpen(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close create material dialog"
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
                    activeTabStyle={accentSecondaryActionStyle92}
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
                  style={accentSecondaryActionStyle92}
                >
                  <Check className="w-3.5 h-3.5" />
                  Save Material
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

        {showPrinterUpdateDiffModal && selectedPrinter && selectedPrinterUpdate && (
          <div className="fixed inset-0 z-[74] flex items-center justify-center bg-black/60 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowPrinterUpdateDiffModal(false);
            }
          }}>
            <div className="w-full max-w-[860px] max-h-[88vh] rounded-xl border shadow-2xl ui-modal-panel-enter flex flex-col overflow-hidden" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="px-4 py-3 border-b flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Official Printer Update
                  </h3>
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {selectedPrinter.name} • v{selectedPrinterUpdate.currentVersion} → v{selectedPrinterUpdate.latestVersion}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPrinterUpdateDiffModal(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close update preview"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 overflow-y-auto custom-scrollbar flex-1 min-h-0 space-y-3">
                <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
                  Review the incoming changes before applying this official profile update.
                </div>

                {selectedPrinterUpdateDiffItems.length > 0 ? (
                  <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="grid grid-cols-[170px_minmax(0,1fr)_minmax(0,1fr)] gap-0 border-b text-[10px] font-semibold uppercase tracking-wide" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                      <div className="px-2.5 py-2" style={{ borderRight: '1px solid var(--border-subtle)' }}>Field</div>
                      <div className="px-2.5 py-2" style={{ borderRight: '1px solid var(--border-subtle)' }}>Current</div>
                      <div className="px-2.5 py-2">Update</div>
                    </div>
                    <div className="divide-y divide-[var(--border-subtle)]">
                      {selectedPrinterUpdateDiffItems.map((item) => (
                        <div key={item.label} className="grid grid-cols-[170px_minmax(0,1fr)_minmax(0,1fr)] text-xs">
                          <div className="px-2.5 py-2 font-semibold" style={{ color: 'var(--text-strong)', borderRight: '1px solid var(--border-subtle)' }}>{item.label}</div>
                          <div className="px-2.5 py-2" style={{ color: 'var(--text-muted)', borderRight: '1px solid var(--border-subtle)' }}>{item.current}</div>
                          <div className="px-2.5 py-2" style={{ color: 'var(--accent-secondary)' }}>{item.next}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border px-3 py-3 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
                    No profile field-level changes were detected, but the official version marker will still advance to v{selectedPrinterUpdate.latestVersion}.
                  </div>
                )}
              </div>

              <div className="px-4 pb-4 pt-2 border-t flex items-center justify-end gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  type="button"
                  onClick={() => setShowPrinterUpdateDiffModal(false)}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleApplySelectedPrinterOfficialUpdate();
                    setShowPrinterUpdateDiffModal(false);
                  }}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                  style={accentSecondaryActionStyle92}
                >
                  <Download className="w-3.5 h-3.5" />
                  Apply Update
                </button>
              </div>
            </div>
          </div>
        )}

        {showOfficialLockDialog && (
          <StructuredDialogModal
            open={showOfficialLockDialog}
            ariaLabel="Official profile locked"
            title="Official Profile Locked"
            subtitle="Official slicer profiles can't be edited directly."
            icon={<Lock className="h-4 w-4" />}
            iconTone="warning"
            zIndexClassName="z-[75]"
            closeAriaLabel="Close official profile lock dialog"
            onClose={() => {
              setShowOfficialLockDialog(false);
              setOfficialLockedProfileId(null);
            }}
            actions={(
              <>
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs whitespace-nowrap"
                  onClick={() => {
                    setShowOfficialLockDialog(false);
                    setOfficialLockedProfileId(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDuplicateOfficialProfile}
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                  style={accentSecondaryActionStyle92}
                >
                  <Lock className="w-3.5 h-3.5" />
                  Make Custom Copy
                </button>
              </>
            )}
          >
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              For safety reasons, official slicer profiles cannot be modified directly.
              <br />
              Choose <strong>Make Custom Copy</strong> to duplicate and edit safely.
              <br />
              <strong>Warning:</strong> Custom, non-official profiles may increase print-failure risk and can potentially damage the machine or cause personal injury.
            </p>
          </StructuredDialogModal>
        )}

        <StructuredDialogModal
          open={showOfficialMaterialLockDialog && Boolean(selectedMaterial)}
          ariaLabel="Official material profile locked"
          title="Official Profile Locked"
          subtitle="Official material profiles can't be edited directly."
          icon={<Lock className="h-4 w-4" />}
          iconTone="warning"
          zIndexClassName="z-[75]"
          closeAriaLabel="Close official material profile lock dialog"
          onClose={() => setShowOfficialMaterialLockDialog(false)}
          actions={(
            <>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-9 px-3 text-xs whitespace-nowrap"
                onClick={() => setShowOfficialMaterialLockDialog(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDuplicateMaterialAsCustom}
                className="ui-button ui-button-secondary !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                style={accentSecondaryActionStyle92}
              >
                <Lock className="w-3.5 h-3.5" />
                Make Custom Copy
              </button>
            </>
          )}
        >
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Official material profiles cannot be edited directly.
            <br />
            Choose <strong>Make Custom Copy</strong> to duplicate and adjust exposure settings safely.
            <br />
            <br />
            <strong style={{ color: 'var(--danger)' }}>Warning:</strong> Custom exposure settings may affect print quality and could damage the machine or cause personal injury.
          </p>
        </StructuredDialogModal>

        <StructuredDialogModal
          open={Boolean(deleteConfirmTarget)}
          ariaLabel="Confirm delete"
          title={deleteConfirmTarget?.kind === 'printer' ? 'Delete Printer Profile' : 'Delete Material Profile'}
          subtitle="This action cannot be undone."
          icon={<AlertTriangle className="h-4 w-4" />}
          iconTone="warning"
          zIndexClassName="z-[76]"
          onClose={() => setDeleteConfirmTarget(null)}
          closeAriaLabel="Close delete confirmation dialog"
          actions={(
            <>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                onClick={() => setDeleteConfirmTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
                style={{
                  borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                  background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                  color: 'var(--danger)',
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete
              </button>
            </>
          )}
        >
          {deleteConfirmTarget ? (
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {deleteConfirmTarget.kind === 'printer'
                ? <>Delete <strong style={{ color: 'var(--text-strong)' }}>{deleteConfirmTarget.name}</strong> and remove all material profiles linked to it?</>
                : <>Delete material profile <strong style={{ color: 'var(--text-strong)' }}>{deleteConfirmTarget.name}</strong>?</>}
            </p>
          ) : null}
        </StructuredDialogModal>
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Edit {networkModeLabel} Material Profile</h3>
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
                          borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 45%)',
                          background: 'color-mix(in srgb, #d97706, var(--surface-2) 88%)',
                          color: '#d97706',
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

  const sourceCandidates = React.useMemo(() => {
    const trimmed = src.trim();
    const candidates = [trimmed];

    if (trimmed.startsWith('/api/profile-assets/')) {
      candidates.push(`/${trimmed.slice('/api/profile-assets/'.length)}`);
    } else if (trimmed.startsWith('/plugins/')) {
      candidates.push(`/api/profile-assets/${trimmed.slice('/'.length)}`);
    }

    return Array.from(new Set(candidates.filter((candidate) => candidate.length > 0)));
  }, [src]);

  React.useEffect(() => {
    let cancelled = false;

    const process = async () => {
      hydrateTrimmedImageCacheFromStorage();

      for (const candidate of sourceCandidates) {
        const cached = trimmedImageMemoryCache.get(candidate) ?? trimmedImageMemoryCache.get(src);
        if (cached) {
          if (!cancelled) {
            setDisplaySrc(cached);
            setIsLoading(false);
          }
          return;
        }

        if (!cancelled) {
          setDisplaySrc(candidate);
          setIsLoading(true);
        }

        try {
          const image = new Image();
          image.decoding = 'async';
          image.src = candidate;
          await image.decode();

          const width = image.naturalWidth;
          const height = image.naturalHeight;
          if (!width || !height) {
            cacheTrimmedImage(src, candidate);
            cacheTrimmedImage(candidate, candidate);
            if (!cancelled) {
              setDisplaySrc(candidate);
              setIsLoading(false);
            }
            return;
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            cacheTrimmedImage(src, candidate);
            cacheTrimmedImage(candidate, candidate);
            if (!cancelled) {
              setDisplaySrc(candidate);
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
            cacheTrimmedImage(src, candidate);
            cacheTrimmedImage(candidate, candidate);
            if (!cancelled) {
              setDisplaySrc(candidate);
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
            cacheTrimmedImage(src, candidate);
            cacheTrimmedImage(candidate, candidate);
            if (!cancelled) {
              setDisplaySrc(candidate);
              setIsLoading(false);
            }
            return;
          }

          const trimmedCanvas = document.createElement('canvas');
          trimmedCanvas.width = paddedWidth;
          trimmedCanvas.height = paddedHeight;
          const trimmedCtx = trimmedCanvas.getContext('2d');
          if (!trimmedCtx) {
            cacheTrimmedImage(src, candidate);
            cacheTrimmedImage(candidate, candidate);
            if (!cancelled) {
              setDisplaySrc(candidate);
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
          cacheTrimmedImage(candidate, next);
          if (!cancelled) {
            setDisplaySrc(next);
            setIsLoading(false);
          }
          return;
        } catch {
          continue;
        }
      }

      cacheTrimmedImage(src, src);
      if (!cancelled) {
        setDisplaySrc(src);
        setIsLoading(false);
      }
    };

    void process();

    return () => {
      cancelled = true;
    };
  }, [sourceCandidates, src]);

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
