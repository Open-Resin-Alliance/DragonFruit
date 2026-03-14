'use client';

import React from 'react';
import { AlertTriangle, Box, Check, ChevronDown, ChevronUp, Download, FlaskConical, ImagePlus, Loader2, Lock, Plus, Printer, Search, Trash2, Upload, Wifi, WifiOff, X } from 'lucide-react';
import FleetManagement from '@/components/settings/FleetManagement';
import {
  addMaterialProfile,
  addPrinterProfileFromPreset,
  disconnectPrinterNetworkDevice,
  duplicatePrinterProfileAsCustom,
  getActivePrinterProfile,
  getAvailablePrinterPresets,
  getMaterialProfilesForPrinter,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  removePrinterNetworkDevice,
  removeMaterialProfile,
  removePrinterProfile,
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
  getDefaultProfileNetworkUiAdapter,
  getProfileNetworkUiAdapter,
} from '@/features/plugins/pluginRegistry';
import { pluginNetworkFetch } from '@/utils/pluginNetworkBridge';

type ProfileSettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'printer' | 'material';
  openPrinterLibraryToken?: number;
};

type DeleteConfirmTarget =
  | { kind: 'printer'; id: string; name: string }
  | { kind: 'material'; id: string; name: string };

type MaterialDraft = Omit<MaterialProfile, 'id' | 'printerProfileId'>;

type NanoDlpMaterial = {
  id: string;
  name: string;
  locked: boolean;
  meta: Record<string, unknown>;
};

type NanoDlpEditDraft = Record<string, string>;

function formatNanoDlpMetaLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .trim();
}

function isLikelyNumericNanoDlpField(key: string, value: string): boolean {
  const normalizedKey = key.toLowerCase();
  if (Number.isFinite(Number(value))) return true;
  return (
    normalizedKey.includes('time')
    || normalizedKey.includes('layer')
    || normalizedKey.includes('speed')
    || normalizedKey.includes('height')
    || normalizedKey.includes('distance')
    || normalizedKey.includes('exposure')
    || normalizedKey.includes('lift')
    || normalizedKey.includes('wait')
    || normalizedKey.includes('depth')
  );
}

function buildNanoDlpMaterialChips(
  material: NanoDlpMaterial,
  resolveMaterialProcessValues: (meta: Record<string, unknown>) => {
    layerHeightMm?: number;
    normalExposureSec?: number;
    bottomExposureSec?: number;
    bottomLayerCount?: number;
  },
): string[] {
  const processValues = resolveMaterialProcessValues(material.meta ?? {});
  const parts: string[] = [];

  if (processValues.bottomLayerCount != null) {
    parts.push(`Burn-In ${processValues.bottomLayerCount}L`);
  }

  if (processValues.bottomExposureSec != null) {
    parts.push(`Burn-In ${processValues.bottomExposureSec.toFixed(1)}s`);
  }

  if (processValues.normalExposureSec != null) {
    parts.push(`Cure ${processValues.normalExposureSec.toFixed(1)}s`);
  }

  return parts;
}

const OUTPUT_FORMAT_OPTIONS: Array<{ value: PrinterOutputFormat; label: string }> = [
  { value: '.nanodlp', label: '.nanodlp' },
  { value: '.goo', label: '.goo' },
  { value: '.lumen', label: '.lumen' },
];

const RESIN_FAMILY_OPTIONS: Array<{ value: MaterialProfile['resinFamily']; label: string }> = [
  { value: 'standard', label: 'Standard' },
  { value: 'abs-like', label: 'ABS-like' },
  { value: 'tough', label: 'Tough' },
  { value: 'flexible', label: 'Flexible' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'other', label: 'Other' },
];

const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CNY'];

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

function computeBuildDimensionMm(resolutionPx: number, pixelSizeUm: number): number {
  const safeResolution = Math.max(1, Math.round(resolutionPx));
  const safePixelSize = Math.max(0.001, Number(pixelSizeUm) || 0.001);
  return Number(((safeResolution * safePixelSize) / 1000).toFixed(3));
}

export function ProfileSettingsModal({
  isOpen,
  onClose,
  initialTab = 'printer',
  openPrinterLibraryToken = 0,
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
  const [nanodlpMaterials, setNanodlpMaterials] = React.useState<NanoDlpMaterial[]>([]);
  const [isLoadingNanodlpMaterials, setIsLoadingNanodlpMaterials] = React.useState(false);
  const [nanodlpMaterialsError, setNanodlpMaterialsError] = React.useState<string | null>(null);
  const [selectedNanodlpMaterialId, setSelectedNanodlpMaterialId] = React.useState<string>('');
  const [isNanodlpEditDialogOpen, setIsNanodlpEditDialogOpen] = React.useState(false);
  const [nanodlpEditTab, setNanodlpEditTab] = React.useState<'basic' | 'advanced'>('basic');
  const [isSavingNanodlpEdit, setIsSavingNanodlpEdit] = React.useState(false);
  const [nanodlpEditDraft, setNanodlpEditDraft] = React.useState<NanoDlpEditDraft>({});
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
  });
  const [isEditingPrinter, setIsEditingPrinter] = React.useState(false);
  const [uploadTargetPrinterId, setUploadTargetPrinterId] = React.useState<string | null>(null);
  const [showPresetPicker, setShowPresetPicker] = React.useState(false);
  const [presetSearch, setPresetSearch] = React.useState('');
  const [selectedPresetManufacturer, setSelectedPresetManufacturer] = React.useState<string>('All');
  const [buildDimensionModeByPrinterId, setBuildDimensionModeByPrinterId] = React.useState<Record<string, BuildDimensionEditMode>>({});
  const imageUploadInputRef = React.useRef<HTMLInputElement | null>(null);

  const availablePrinterPresets = React.useMemo(() => getAvailablePrinterPresets(), [profileState]);

  const presetManufacturers = React.useMemo(() => {
    const uniq = new Set(availablePrinterPresets.map((preset) => preset.manufacturer));
    return ['All', ...Array.from(uniq).sort((a, b) => a.localeCompare(b))];
  }, [availablePrinterPresets]);

  const filteredPrinterPresets = React.useMemo(() => {
    const search = presetSearch.trim().toLowerCase();
    return availablePrinterPresets.filter((preset) => {
      const manufacturerMatch = selectedPresetManufacturer === 'All' || preset.manufacturer === selectedPresetManufacturer;
      const searchMatch =
        search.length === 0
        || preset.name.toLowerCase().includes(search)
        || preset.manufacturer.toLowerCase().includes(search)
        || (preset.family ?? '').toLowerCase().includes(search);
      return manufacturerMatch && searchMatch;
    });
  }, [availablePrinterPresets, presetSearch, selectedPresetManufacturer]);

  const groupedFilteredPrinterPresets = React.useMemo(() => {
    if (selectedPresetManufacturer === 'All') return [] as Array<{ family: string; presets: typeof filteredPrinterPresets }>;

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

  const selectedPrinter = React.useMemo(() => {
    if (profileState.printerProfiles.length === 0) return null;
    const fallback = getActivePrinterProfile(profileState);
    if (!selectedPrinterId) return fallback;
    return profileState.printerProfiles.find((profile) => profile.id === selectedPrinterId) ?? fallback;
  }, [profileState, selectedPrinterId]);

  const selectedBuildDimensionMode: BuildDimensionEditMode = React.useMemo(() => {
    if (!selectedPrinter) return 'manual';
    return buildDimensionModeByPrinterId[selectedPrinter.id] ?? 'manual';
  }, [buildDimensionModeByPrinterId, selectedPrinter]);

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
    setBuildDimensionModeByPrinterId((prev) => ({
      ...prev,
      [selectedPrinter.id]: mode,
    }));

    if (mode === 'auto') {
      updatePrinterProfile(selectedPrinter.id, {
        buildVolumeMm: applyAutoBuildDimensions(selectedPrinter),
      });
    }
  }, [applyAutoBuildDimensions, selectedPrinter]);

  const handlePrinterDisplayChange = React.useCallback((partialDisplay: Partial<PrinterProfile['display']>) => {
    if (!selectedPrinter) return;

    const nextDisplay: PrinterProfile['display'] = {
      ...selectedPrinter.display,
      ...partialDisplay,
    };

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

  const selectedPrinterSupportsNetworkSettings = Boolean(selectedPrinter?.networkSupport);
  const networkUiAdapter = React.useMemo(
    () => getProfileNetworkUiAdapter(selectedPrinter?.networkSupport),
    [selectedPrinter?.networkSupport],
  );
  const effectiveNetworkUiAdapter = React.useMemo(
    () => networkUiAdapter ?? getDefaultProfileNetworkUiAdapter(),
    [networkUiAdapter],
  );
  const isNanodlpPrinter = Boolean(networkUiAdapter);
  const selectedNetworkModeLabel = networkUiAdapter?.displayName ?? 'Unknown';
  const shouldUseNanodlpOnDeviceMaterials = Boolean(
    Boolean(networkUiAdapter)
    && selectedPrinter?.networkConnection?.connected
    && (selectedPrinter?.networkConnection?.ipAddress || selectedPrinter?.network?.ipAddress),
  );
  const shouldShowNanodlpConnectInfo = Boolean(isNanodlpPrinter && !shouldUseNanodlpOnDeviceMaterials);

  const selectedNanodlpMaterial = React.useMemo(() => {
    if (!selectedNanodlpMaterialId) return null;
    return nanodlpMaterials.find((material) => material.id === selectedNanodlpMaterialId) ?? null;
  }, [nanodlpMaterials, selectedNanodlpMaterialId]);

  const selectedNanodlpMaterialIdRef = React.useRef('');
  const lastHandledOpenPrinterLibraryTokenRef = React.useRef(0);
  const wasOpenRef = React.useRef(false);
  const discoveryInFlightRef = React.useRef(false);
  const discoveryRunIdRef = React.useRef(0);

  React.useEffect(() => {
    selectedNanodlpMaterialIdRef.current = selectedNanodlpMaterialId;
  }, [selectedNanodlpMaterialId]);

  const selectedPrinterResolvedId = selectedPrinter?.id ?? '';
  const selectedPrinterNetworkSupportMode = selectedPrinter?.networkSupport ?? null;
  const selectedNanodlpHost = (selectedPrinter?.networkConnection?.ipAddress || selectedPrinter?.network?.ipAddress || '').trim();
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
      .filter((preset) => preset.networkSupport === 'nanodlp')
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
  const networkSettingsActionLabel = connectedManagedNetworkPrinterCount > 1 ? 'Manage Fleet' : 'Network Settings';
  const activeManagedNetworkPrinter = React.useMemo(
    () => managedNetworkPrinters.find((device) => device.id === selectedPrinter?.activeNetworkDeviceId) ?? null,
    [managedNetworkPrinters, selectedPrinter?.activeNetworkDeviceId],
  );

  const primaryEditFields = effectiveNetworkUiAdapter.primaryEditFields;
  const basicEditSections = effectiveNetworkUiAdapter.basicSections;
  const advancedEditSectionsDefs = effectiveNetworkUiAdapter.advancedSections;

  const nanodlpPrimaryFieldByKey = React.useMemo(() => {
    const map = new Map<string, (typeof primaryEditFields)[number]>();
    primaryEditFields.forEach((field) => {
      map.set(field.key, field);
    });
    return map;
  }, [primaryEditFields]);

  const sortedNanodlpDraftEntries = React.useMemo(() => {
    const entries = Object.entries(nanodlpEditDraft);
    const primaryOrder = new Map<string, number>();
    primaryEditFields.forEach((field, index) => {
      primaryOrder.set(field.key, index);
    });

    return entries.sort(([keyA], [keyB]) => {
      const indexA = primaryOrder.get(keyA);
      const indexB = primaryOrder.get(keyB);

      const isPrimaryA = indexA != null;
      const isPrimaryB = indexB != null;

      if (isPrimaryA && isPrimaryB) return (indexA as number) - (indexB as number);
      if (isPrimaryA) return -1;
      if (isPrimaryB) return 1;
      return keyA.localeCompare(keyB);
    });
  }, [nanodlpEditDraft, primaryEditFields]);

  const basicNanodlpDraftEntries = React.useMemo(() => {
    return primaryEditFields
      .map((field) => [field.key, nanodlpEditDraft[field.key]] as const)
      .filter(([, value]) => typeof value === 'string');
  }, [nanodlpEditDraft, primaryEditFields]);

  const basicNanodlpSections = React.useMemo(() => {
    const entryMap = new Map(basicNanodlpDraftEntries);
    return basicEditSections
      .map((section) => ({
        ...section,
        entries: section.keys
          .map((key) => [key, entryMap.get(key)] as const)
          .filter(([, value]) => typeof value === 'string') as Array<readonly [string, string]>,
      }))
      .filter((section) => section.entries.length > 0);
  }, [basicEditSections, basicNanodlpDraftEntries]);

  const advancedNanodlpDraftEntries = React.useMemo(() => {
    return sortedNanodlpDraftEntries
      .filter(([key]) => !nanodlpPrimaryFieldByKey.has(key));
  }, [nanodlpPrimaryFieldByKey, sortedNanodlpDraftEntries]);

  const advancedNanodlpSections = React.useMemo(() => {
    const sectionTitleById = new Map<string, string>([
      ...advancedEditSectionsDefs.map((section) => [section.id, section.title] as const),
      ['other', 'Other Advanced Controls'] as const,
    ]);

    const grouped = new Map<string, Array<readonly [string, string]>>();
    for (const entry of advancedNanodlpDraftEntries) {
      const sectionId = effectiveNetworkUiAdapter.resolveAdvancedSectionId(entry[0]);
      const current = grouped.get(sectionId);
      if (current) {
        current.push(entry);
      } else {
        grouped.set(sectionId, [entry]);
      }
    }

    const orderedIds = [...advancedEditSectionsDefs.map((section) => section.id), 'other'];
    return orderedIds
      .map((id) => ({
        id,
        title: sectionTitleById.get(id) ?? 'Advanced',
        entries: grouped.get(id) ?? [],
      }))
      .filter((section) => section.entries.length > 0);
  }, [advancedEditSectionsDefs, advancedNanodlpDraftEntries, effectiveNetworkUiAdapter]);

  const isNanodlpDynamicWaitEnabledState = React.useMemo(() => {
    return effectiveNetworkUiAdapter.isDynamicWaitEnabled(nanodlpEditDraft);
  }, [nanodlpEditDraft, effectiveNetworkUiAdapter]);

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

    if (shouldOpenPrinterLibrary) {
      lastHandledOpenPrinterLibraryTokenRef.current = openPrinterLibraryToken;
    }

    setSelectedPrinterId(profileState.activePrinterProfileId);
    setSelectedManufacturer(null);
    setSelectedResinFamily(null);
    setIsMaterialEditorOpen(false);
    setIsEditingPrinter(false);
    setIsNetworkSettingsOpen(false);
    setShowPresetPicker(shouldOpenPrinterLibrary);
    setPresetSearch('');
    setSelectedPresetManufacturer('All');
    const materials = getMaterialProfilesForPrinter(profileState.activePrinterProfileId, profileState);
    setSelectedMaterialId(materials[0]?.id ?? null);
  }, [initialTab, isOpen, openPrinterLibraryToken, profileState.activePrinterProfileId, profileState]);

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
    if (!selectedPrinter || selectedPrinter.isOfficial) {
      setIsEditingPrinter(false);
    }
  }, [selectedPrinter]);

  React.useEffect(() => {
    if (!selectedPrinter) {
      setIsNetworkSettingsOpen(false);
      setIsAddingNetworkPrinter(false);
      return;
    }

    setNetworkDiscoveryEnabled(selectedPrinter.network?.discoveryEnabled ?? true);
    setNetworkIpAddress(selectedPrinter.network?.ipAddress ?? '');
    setDiscoveredPrinters([]);
    setNetworkConnectionMessage(selectedPrinter.networkConnection?.statusText ?? '');
    setShowManualNetworkEntry(false);
    setIsAddingNetworkPrinter((selectedPrinter.networkFleet?.length ?? 0) === 0);
  }, [selectedPrinter]);

  React.useEffect(() => {
    if (!selectedPrinterSupportsNetworkSettings) {
      setIsNetworkSettingsOpen(false);
    }
  }, [selectedPrinterSupportsNetworkSettings]);

  const loadNanodlpMaterials = React.useCallback(async () => {
    if (!selectedPrinterResolvedId) return;
    if (!networkUiAdapter) return;

    const host = selectedNanodlpHost;
    if (!host) {
      setNanodlpMaterials([]);
      setNanodlpMaterialsError('Connect to a NanoDLP printer to load on-device materials.');
      return;
    }

    setIsLoadingNanodlpMaterials(true);
    setNanodlpMaterialsError(null);

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

      setNanodlpMaterials(materials);

      const preferredId = selectedNanodlpMaterialIdRef.current;
      const nextSelected = materials.find((item: any) => item.id === preferredId)
        ?? materials.find((item: any) => item.locked !== true)
        ?? materials[0]
        ?? null;

      if (nextSelected) {
        const processValues = effectiveNetworkUiAdapter.resolveMaterialProcessValues((nextSelected as NanoDlpMaterial).meta ?? {});
        setSelectedNanodlpMaterialId(nextSelected.id);
        updatePrinterNetworkConnectionStatus(selectedPrinterResolvedId, {
          selectedMaterialId: nextSelected.id,
          selectedMaterialName: nextSelected.name,
          selectedMaterialLayerHeightMm: processValues.layerHeightMm,
          selectedMaterialNormalExposureSec: processValues.normalExposureSec,
          selectedMaterialBottomExposureSec: processValues.bottomExposureSec,
          selectedMaterialBottomLayerCount: processValues.bottomLayerCount,
        });
      } else {
        setSelectedNanodlpMaterialId('');
      }

      const errorMessage = typeof payload?.error === 'string' ? payload.error : '';
      if (errorMessage) {
        setNanodlpMaterialsError(errorMessage);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load NanoDLP materials.';
      setNanodlpMaterials([]);
      setNanodlpMaterialsError(message);
    } finally {
      setIsLoadingNanodlpMaterials(false);
    }
  }, [effectiveNetworkUiAdapter, networkUiAdapter, selectedNanodlpHost, selectedPrinterResolvedId]);

  React.useEffect(() => {
    if (!shouldUseNanodlpOnDeviceMaterials || !selectedPrinterResolvedId) {
      setNanodlpMaterials([]);
      setSelectedNanodlpMaterialId('');
      setIsNanodlpEditDialogOpen(false);
      setNanodlpMaterialsError(null);
      return;
    }

    void loadNanodlpMaterials();
  }, [loadNanodlpMaterials, selectedPrinterResolvedId, shouldUseNanodlpOnDeviceMaterials]);

  const handleSelectNanodlpMaterial = React.useCallback((material: NanoDlpMaterial) => {
    if (!selectedPrinter) return;
    const processValues = effectiveNetworkUiAdapter.resolveMaterialProcessValues(material.meta ?? {});
    setSelectedNanodlpMaterialId(material.id);
    updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
      selectedMaterialId: material.id,
      selectedMaterialName: material.name,
      selectedMaterialLayerHeightMm: processValues.layerHeightMm,
      selectedMaterialNormalExposureSec: processValues.normalExposureSec,
      selectedMaterialBottomExposureSec: processValues.bottomExposureSec,
      selectedMaterialBottomLayerCount: processValues.bottomLayerCount,
    });
  }, [effectiveNetworkUiAdapter, selectedPrinter]);

  const openNanodlpEditDialog = React.useCallback(() => {
    if (!selectedNanodlpMaterial) return;
    setNanodlpEditDraft(effectiveNetworkUiAdapter.resolveEditDraftFromMeta(selectedNanodlpMaterial.meta ?? {}));
    setNanodlpEditTab('basic');
    setIsNanodlpEditDialogOpen(true);
  }, [effectiveNetworkUiAdapter, selectedNanodlpMaterial]);

  const handleSaveNanodlpEdits = React.useCallback(async () => {
    if (!selectedPrinter) return;
    if (!selectedNanodlpMaterial) return;
    if (!networkUiAdapter) return;

    const host = (selectedPrinter.networkConnection?.ipAddress || selectedPrinter.network?.ipAddress || '').trim();
    const profileId = Number(selectedNanodlpMaterial.id);
    if (!host || !Number.isFinite(profileId) || profileId <= 0) return;

    setIsSavingNanodlpEdit(true);
    setNanodlpMaterialsError(null);

    try {
      const response = await pluginNetworkFetch({
        pluginId: networkUiAdapter.pluginId,
        operation: networkUiAdapter.operations.materialsEdit,
        host,
        profileId,
        fields: effectiveNetworkUiAdapter.denormalizeEditDraftForBackend(nanodlpEditDraft),
      });

      const payload = await response.json().catch(() => null) as any;
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' ? payload.error : 'Failed to save NanoDLP material profile.');
      }

      setIsNanodlpEditDialogOpen(false);
      setNetworkConnectionMessage('NanoDLP profile updated. Refreshing materials…');
      await loadNanodlpMaterials();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save NanoDLP profile.';
      setNanodlpMaterialsError(message);
      setNetworkConnectionMessage(message);
    } finally {
      setIsSavingNanodlpEdit(false);
    }
  }, [effectiveNetworkUiAdapter, loadNanodlpMaterials, nanodlpEditDraft, networkUiAdapter, selectedNanodlpMaterial, selectedPrinter]);

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
          const resolvedName = [connectPayload.hostName, connectPayload.printerName, connectPayload.ipAddress]
            .find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? configuredHost;

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
        const ipAddress = typeof device?.ipAddress === 'string' ? device.ipAddress.trim() : '';

        return {
          id: `${selectedPrinter.id}-local-scan-${index}`,
          name: hostName || printerName || 'NanoDLP Printer',
          ipAddress,
          status: 'online' as const,
        };
      }).filter((item) => item.ipAddress.length > 0);

      const baseDiscovered = [...seedDevices, ...localDiscovered].filter((item, index, array) => (
        array.findIndex((candidate) => candidate.ipAddress === item.ipAddress) === index
      ));

      if (isCurrentRun()) setDiscoveredPrinters(baseDiscovered);

      setNetworkScanProgressPct(44);
      setNetworkScanPhaseLabel('Scanning local subnet…');
      setNetworkConnectionMessage('Scanning local subnet for NanoDLP devices…');
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
          const ipAddress = typeof device?.ipAddress === 'string' ? device.ipAddress.trim() : '';

          return {
            id: `${selectedPrinter.id}-scan-batch-${subnetBatchStart}-${index}`,
            name: hostName || printerName || 'NanoDLP Printer',
            ipAddress,
            status: 'online' as const,
          };
        }).filter((item) => item.ipAddress.length > 0);

        subnetDiscovered.push(...discoveredBatch);

        const liveMerged = [...baseDiscovered, ...subnetDiscovered].filter((item, index, array) => (
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

      const merged = [...baseDiscovered, ...subnetDiscovered].filter((item, index, array) => (
        array.findIndex((candidate) => candidate.ipAddress === item.ipAddress) === index
      ));

      if (isCurrentRun()) {
        setDiscoveredPrinters(merged);
        setNetworkScanProgressPct(100);
        setNetworkScanPhaseLabel('Scan complete');
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
            `Found ${merged.length} NanoDLP device${merged.length === 1 ? '' : 's'} (resolved ${scannedLocalHostnames} .local hostnames, scanned ${scannedSubnetHosts} subnet hosts / ${scannedEndpoints} endpoints).`,
          );
        }
      } else {
        if (isCurrentRun()) {
          setNetworkConnectionMessage(
            scannedSubnetHosts > 0 || scannedLocalHostnames > 0
              ? `No NanoDLP devices found (resolved ${scannedLocalHostnames} .local hostnames, scanned ${scannedSubnetHosts} subnet hosts / ${scannedEndpoints} endpoints).`
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
        setDiscoveredPrinters([]);
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

  const handleConnectNetworkPrinter = React.useCallback(async (options?: { host?: string; closeOnSuccess?: boolean }) => {
    if (!selectedPrinter || !networkUiAdapter) return;

    const host = (options?.host ?? networkIpAddress).trim();
    const normalizedHost = host.toLowerCase();
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
    setNetworkConnectionMessage('Connecting to NanoDLP host…');

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
        const resolvedHostName = [payload.hostName, payload.printerName, payload.ipAddress, host]
          .find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? host;
        const resolvedIpAddress = typeof payload.ipAddress === 'string' ? payload.ipAddress : host;

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
          : 'NanoDLP host unreachable.';

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
    effectiveNetworkUiAdapter,
    networkDiscoveryEnabled,
    networkIpAddress,
    networkUiAdapter,
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
    });
  }, [isMaterialEditorOpen, selectedMaterial]);

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
    setSelectedPresetManufacturer('All');
  }, [handlePickPrinter]);

  const requestDeleteSelectedPrinter = React.useCallback(() => {
    if (!selectedPrinter) return;
    setDeleteConfirmTarget({ kind: 'printer', id: selectedPrinter.id, name: selectedPrinter.name });
  }, [selectedPrinter]);

  const handleAddMaterial = React.useCallback(() => {
    if (!selectedPrinter) return;
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
    });
    setIsCreateMaterialOpen(true);
  }, [printerMaterials.length, selectedPrinter, selectedManufacturerValue, selectedResinFamilyValue]);

  const handleCreateMaterial = React.useCallback(() => {
    if (!selectedPrinter) return;

    const newId = addMaterialProfile(selectedPrinter.id, {
      ...newMaterialDraft,
      name: newMaterialDraft.name.trim() || `Material ${printerMaterials.length + 1}`,
      brand: newMaterialDraft.brand.trim() || 'Default',
    });

    setSelectedManufacturer((newMaterialDraft.brand || 'Default').trim() || 'Default');
    setSelectedResinFamily(newMaterialDraft.resinFamily);
    setSelectedMaterialId(newId);
    setActiveMaterialProfile(newId);
    setIsCreateMaterialOpen(false);
  }, [newMaterialDraft, printerMaterials.length, selectedPrinter]);

  const requestDeleteSelectedMaterial = React.useCallback(() => {
    if (!selectedMaterial) return;
    setDeleteConfirmTarget({ kind: 'material', id: selectedMaterial.id, name: selectedMaterial.name });
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
    });

    setIsMaterialEditorOpen(false);
  }, [editMaterialDraft, selectedMaterial]);

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
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      updatePrinterProfile(printerId, { imageDataUrl: result });
    };
    reader.readAsDataURL(file);
  }, [uploadTargetPrinterId]);

  const handleExportSelectedPrinterBundle = React.useCallback(() => {
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

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const safeName = printer.name.replace(/[^a-z0-9-_]+/gi, '_').toLowerCase();

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName || 'printer-profile'}-bundle.json`;
    anchor.click();

    URL.revokeObjectURL(url);
  }, [selectedPrinter]);

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
    const bitDepthLabel = Number.isFinite(Number(preset.bitDepth?.bits))
      ? `${Math.round(Number(preset.bitDepth?.bits))} Bit`
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
                  className="ui-button ui-button-primary mt-5 !h-10 !px-4 !py-0 text-sm inline-flex items-center justify-center gap-1.5 rounded-md"
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
              <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-strong)' }}>
                <Box className="w-4 h-4" />
                3D Printer
              </h3>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Each printer can store its own image and has a dedicated set of compatible resin/material profiles.
              </p>
            </div>

            <div className="p-3">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {profileState.printerProfiles.map((printer) => {
                  const active = printer.id === selectedPrinter?.id;
                  const isGenericPrinter = (printer.manufacturer ?? '').toLowerCase() === 'generic'
                    || printer.name.toLowerCase().includes('generic');
                  const isNetworkConnected = printer.networkConnection?.connected === true;
                  const platformBadge = printer.platformBadge?.text?.trim()
                    ? printer.platformBadge
                    : undefined;
                  const cardBadgeText = printer.isCustom
                    ? 'CUSTOM'
                    : platformBadge?.text;
                  const bitDepthBits = Number.isFinite(Number(printer.bitDepth?.bits))
                    ? Math.round(Number(printer.bitDepth?.bits))
                    : null;
                  const bitDepthLabel = Number.isFinite(Number(printer.bitDepth?.bits))
                    ? `${Math.round(Number(printer.bitDepth?.bits))} Bit`
                    : null;
                  const cardWidth = isEditingPrinter ? 'w-[198px]' : 'w-[236px]';
                  const imageHeight = isEditingPrinter ? 'h-[124px]' : 'h-[148px]';

                  return (
                    <button
                      key={printer.id}
                      type="button"
                      onClick={() => handlePickPrinter(printer.id)}
                      className={`shrink-0 ${cardWidth} rounded-xl border p-2.5 text-left transition-all duration-150`}
                      style={active
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 28%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-2)',
                          }}
                    >
                      <div className={`${imageHeight} rounded-lg border overflow-hidden flex items-center justify-center p-2 relative`} style={{ borderColor: 'var(--border-subtle)', background: '#1c2027' }}>
                        {printer.imageDataUrl ? (
                          <AutoTrimmedImage src={printer.imageDataUrl} alt={printer.name} className="h-full w-full object-contain" />
                        ) : (
                          <div className="text-[10px] text-center px-2" style={{ color: 'var(--text-muted)' }}>
                            {isGenericPrinter ? (
                              <>
                                <Printer className="w-5 h-5 mx-auto mb-1" />
                                Generic
                              </>
                            ) : (
                              <>
                                <ImagePlus className="w-5 h-5 mx-auto mb-1" />
                                No image
                              </>
                            )}
                          </div>
                        )}
                        {isNetworkConnected && (
                          <span
                            className="pointer-events-none absolute top-1 left-1 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full border"
                            title={`Connected to ${printer.networkConnection?.hostName || printer.networkConnection?.ipAddress || 'network printer'}`}
                            style={{
                              borderColor: 'color-mix(in srgb, #22c55e, white 10%)',
                              background: 'color-mix(in srgb, #22c55e, #0f172a 38%)',
                              color: '#dcfce7',
                            }}
                          >
                            <Wifi className="w-3 h-3" />
                          </span>
                        )}
                        {cardBadgeText && (
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
                        )}
                      </div>
                      <div className="mt-2.5 flex items-center gap-1.5">
                        <div className="text-[12px] leading-snug font-semibold truncate min-w-0" style={{ color: 'var(--text-strong)' }}>
                          {printer.name}
                        </div>
                        {bitDepthLabel && (
                          <span
                            className="shrink-0 inline-flex h-[18px] items-center justify-center whitespace-nowrap rounded-md border px-1.5 text-[9px] font-bold leading-none"
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
                            title={printer.bitDepth?.description || `${bitDepthLabel} display`}
                          >
                            <span className="relative top-[0.5px]">{bitDepthLabel}</span>
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                        {printer.manufacturer || 'Generic'}
                      </div>
                    </button>
                  );
                })}
              </div>

              {isEditingPrinter && selectedPrinter ? (
                <div className="mt-3 rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
                    Edit Printer Profile
                  </div>

                  <div className="mb-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setBuildDimensionMode('manual')}
                      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
                      style={selectedBuildDimensionMode === 'manual'
                        ? {
                            color: 'var(--accent-secondary)',
                            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                          }
                        : { color: 'var(--text-muted)' }}
                    >
                      Manual build mm
                    </button>
                    <button
                      type="button"
                      onClick={() => setBuildDimensionMode('auto')}
                      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
                      style={selectedBuildDimensionMode === 'auto'
                        ? {
                            color: 'var(--accent-secondary)',
                            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                          }
                        : { color: 'var(--text-muted)' }}
                    >
                      Auto-calc from px + μm
                    </button>
                    <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      {selectedBuildDimensionMode === 'auto'
                        ? 'Build width/depth are derived from resolution and pixel size.'
                        : 'Build width/depth are edited directly in mm.'}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <LabeledInput
                      label="Printer name"
                      value={selectedPrinter.name}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, { name: value })}
                    />
                    <LabeledInput
                      label="Manufacturer"
                      value={selectedPrinter.manufacturer ?? ''}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, { manufacturer: value })}
                    />

                    <LabeledNumberInput
                      label="Build width (mm)"
                      disabled={selectedBuildDimensionMode === 'auto'}
                      value={selectedPrinter.buildVolumeMm.width}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        buildVolumeMm: {
                          ...selectedPrinter.buildVolumeMm,
                          width: value,
                        },
                      })}
                    />
                    <LabeledNumberInput
                      label="Build depth (mm)"
                      disabled={selectedBuildDimensionMode === 'auto'}
                      value={selectedPrinter.buildVolumeMm.depth}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        buildVolumeMm: {
                          ...selectedPrinter.buildVolumeMm,
                          depth: value,
                        },
                      })}
                    />

                    <LabeledNumberInput
                      label="Build height (mm)"
                      value={selectedPrinter.buildVolumeMm.height}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        buildVolumeMm: {
                          ...selectedPrinter.buildVolumeMm,
                          height: value,
                        },
                      })}
                    />
                    <LabeledNumberInput
                      label="Resolution X (px)"
                      value={selectedPrinter.display.resolutionX}
                      onChange={(value) => handlePrinterDisplayChange({
                        resolutionX: Math.max(1, Math.round(value)),
                      })}
                    />

                    <LabeledNumberInput
                      label="Resolution Y (px)"
                      value={selectedPrinter.display.resolutionY}
                      onChange={(value) => handlePrinterDisplayChange({
                        resolutionY: Math.max(1, Math.round(value)),
                      })}
                    />

                    <LabeledNumberInput
                      label="Pixel size X (μm)"
                      value={selectedPrinter.pixelSize?.x ?? 1}
                      onChange={(value) => handlePrinterPixelSizeChange('x', value)}
                    />

                    <LabeledNumberInput
                      label="Pixel size Y (μm)"
                      value={selectedPrinter.pixelSize?.y ?? 1}
                      onChange={(value) => handlePrinterPixelSizeChange('y', value)}
                    />

                    <LabeledNumberInput
                      label="Bit depth"
                      value={selectedPrinter.bitDepth?.bits ?? 8}
                      onChange={handlePrinterBitDepthChange}
                    />

                    <LabeledSelectInput
                      label="Output format"
                      value={selectedPrinter.display.outputFormat}
                      options={OUTPUT_FORMAT_OPTIONS}
                      onChange={(value) => handlePrinterDisplayChange({ outputFormat: value })}
                    />

                    <LabeledToggleInput
                      label="Mirror X"
                      checked={selectedPrinter.display.mirrorX === true}
                      onChange={(checked) => handlePrinterDisplayChange({ mirrorX: checked })}
                    />

                    <LabeledToggleInput
                      label="Mirror Y"
                      checked={selectedPrinter.display.mirrorY === true}
                      onChange={(checked) => handlePrinterDisplayChange({ mirrorY: checked })}
                    />

                    <LabeledToggleInput
                      label="Anti-Aliasing"
                      checked={selectedPrinter.antiAliasing === true}
                      onChange={(checked) => updatePrinterProfile(selectedPrinter.id, { antiAliasing: checked })}
                    />
                  </div>
                </div>
              ) : null}

              {hasPrinters && (
              <div className="mt-2.5 rounded-lg border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleAddPrinter}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                    style={{
                      color: 'var(--accent-secondary)',
                      borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                      background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                    }}
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Printer
                  </button>
                  {selectedPrinterSupportsNetworkSettings && (
                    <button
                      type="button"
                      onClick={handleOpenNetworkSettings}
                      disabled={!hasPrinters || !selectedPrinter}
                      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                      style={{ color: 'var(--text-strong)' }}
                    >
                      <Search className="w-3.5 h-3.5" />
                      {networkSettingsActionLabel}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      if (!selectedPrinter || !hasPrinters) return;
                      if (selectedPrinter.isOfficial) {
                        showOfficialProfileDialog(selectedPrinter.id);
                        return;
                      }
                      setIsEditingPrinter((prev) => !prev);
                    }}
                    disabled={!hasPrinters}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                    style={{ color: 'var(--text-strong)' }}
                  >
                    {isEditingPrinter ? 'Done Editing' : 'Edit Printer'}
                  </button>
                  {isEditingPrinter && selectedPrinter && (
                    <>
                      <button
                        type="button"
                        onClick={() => triggerImageUpload(selectedPrinter.id)}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={{ color: 'var(--text-strong)' }}
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
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
                        style={{ color: selectedPrinter.imageDataUrl ? '#fca5a5' : 'var(--text-muted)' }}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Clear Image
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={handleExportSelectedPrinterBundle}
                    disabled={!hasPrinters}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                    style={{ color: 'var(--text-strong)' }}
                  >
                    <Download className="w-3.5 h-3.5" />
                    Export Bundle
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
              <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-strong)' }}>
                <FlaskConical className="w-4 h-4" />
                Material Settings
              </h3>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {shouldUseNanodlpOnDeviceMaterials
                  ? <>Connected NanoDLP profiles are loaded directly from <span style={{ color: 'var(--text-strong)' }}>{selectedPrinter.name}</span>. Selection is read-only for now.</>
                  : shouldShowNanodlpConnectInfo
                    ? <>Connect to a machine to view on-device material profiles.</>
                  : <>Profiles below are bound to <span style={{ color: 'var(--text-strong)' }}>{selectedPrinter.name}</span> and follow the selected printer hardware.</>}
              </p>
            </div>

            <div className="p-3 flex flex-col gap-3 flex-1 min-h-0">
              {shouldUseNanodlpOnDeviceMaterials ? (
                <>
                  <div className="rounded-xl border overflow-hidden flex flex-col flex-1 min-h-0" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                    <div className="px-3 py-2 border-b flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                      <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        NanoDLP On-Device Materials
                      </div>
                      <button
                        type="button"
                        onClick={() => { void loadNanodlpMaterials(); }}
                        disabled={isLoadingNanodlpMaterials}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        {isLoadingNanodlpMaterials ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
                        {isLoadingNanodlpMaterials ? 'Loading…' : 'Refresh'}
                      </button>
                    </div>

                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-2 space-y-1.5">
                      {isLoadingNanodlpMaterials ? (
                        <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                          Loading materials from printer…
                        </div>
                      ) : nanodlpMaterials.length === 0 ? (
                        <div className="h-full flex items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
                          {nanodlpMaterialsError || 'No on-device materials were returned by this NanoDLP host.'}
                        </div>
                      ) : (
                        nanodlpMaterials.map((material) => {
                          const active = selectedNanodlpMaterialId === material.id;
                          const chips = buildNanoDlpMaterialChips(material, effectiveNetworkUiAdapter.resolveMaterialProcessValues);
                          return (
                            <button
                              key={material.id}
                              type="button"
                              onClick={() => handleSelectNanodlpMaterial(material)}
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

                  <div className="rounded-xl border p-3 min-h-0" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                    {selectedNanodlpMaterial ? (
                      <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{selectedNanodlpMaterial.name}</span>
                          <span className="text-[11px] rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}>
                            Profile ID: {selectedNanodlpMaterial.id}
                          </span>
                          {selectedNanodlpMaterial.locked && (
                            <span className="text-[11px] rounded-full border px-2 py-0.5" style={{ borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 35%)', color: '#fbbf24', background: 'var(--surface-2)' }}>
                              Locked on printer
                            </span>
                          )}
                          <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                            Synced with NanoDLP
                          </span>
                          {!selectedNanodlpMaterial.locked && (
                            <button
                              type="button"
                              onClick={openNanodlpEditDialog}
                              className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] inline-flex items-center gap-1 rounded-md"
                              style={{ color: 'var(--accent-secondary)' }}
                            >
                              Edit all fields
                            </button>
                          )}
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                        Select a printer material profile to edit available NanoDLP parameters.
                      </div>
                    )}
                  </div>
                </>
              ) : shouldShowNanodlpConnectInfo ? (
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
                <div className="px-3 py-2 border-b flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Material Profiles
                  </div>
                  <div className="flex items-center gap-1.5">
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
                    <button
                      type="button"
                      onClick={requestDeleteSelectedMaterial}
                      disabled={!selectedMaterial || printerMaterials.length <= 1}
                      className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                      style={{ color: !selectedMaterial || printerMaterials.length <= 1 ? 'var(--text-muted)' : '#fca5a5' }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete
                    </button>
                  </div>
                </div>

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

              <div className="rounded-xl border p-3 min-h-0" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                {selectedMaterial ? (
                  <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{selectedMaterial.name}</span>
                      <span className="text-[11px] rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}>
                        {selectedMaterial.brand}
                      </span>
                      <span className="text-[11px] rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}>
                        {selectedMaterial.resinFamily}
                      </span>
                      <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                        {selectedMaterial.layerHeightMm}mm • {selectedMaterial.normalExposureSec}s • {selectedMaterial.bottomExposureSec}s
                      </span>
                      <button
                        type="button"
                        onClick={() => setIsMaterialEditorOpen(true)}
                        className="ui-button ui-button-secondary !h-7 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-full"
                        style={{ color: 'var(--text-strong)' }}
                      >
                        Edit Profile
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                    Pick a manufacturer and resin type, or add a new resin profile.
                  </div>
                )}
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

        {showPresetPicker && (
          <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowPresetPicker(false);
          }}>
            <div className="w-full max-w-[1040px] max-h-[94vh] rounded-xl border shadow-2xl overflow-hidden ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
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

              <div className="grid grid-cols-[220px_minmax(0,1fr)] min-h-[620px] max-h-[calc(94vh-56px)]">
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

                <div className="p-3 overflow-y-auto custom-scrollbar">
                  {selectedPresetManufacturer === 'All' ? (
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
            <div className="w-full max-w-[920px] max-h-[88vh] overflow-y-auto rounded-xl border shadow-2xl custom-scrollbar ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Resin Profile Settings</h3>
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

              <div className="p-3 space-y-3">
                <MaterialProfileFormSections draft={editMaterialDraft} onChange={setEditMaterialDraft} />

              <div className="px-3 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Changes are applied when you press Save.
                </span>
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
          </div>
        )}

        {isCreateMaterialOpen && selectedPrinter && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsCreateMaterialOpen(false);
          }}>
            <div className="w-full max-w-[920px] max-h-[88vh] overflow-y-auto rounded-xl border shadow-2xl custom-scrollbar ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Create Resin Profile</h3>
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

              <div className="p-3 space-y-3">
                <MaterialProfileFormSections draft={newMaterialDraft} onChange={setNewMaterialDraft} />
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
              onConnectDiscovered={(host) => { void handleConnectNetworkPrinter({ host, closeOnSuccess: false }); }}
              onSelectManagedPrinter={handleSelectManagedPrinter}
              onReconnectManagedPrinter={(device) => { void handleConnectNetworkPrinter({ host: device.ipAddress, closeOnSuccess: false }); }}
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

        {isNanodlpEditDialogOpen && selectedNanodlpMaterial && (
          <div className="fixed inset-0 z-[71] flex items-center justify-center bg-black/55 p-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isSavingNanodlpEdit) setIsNanodlpEditDialogOpen(false);
          }}>
            <div className="w-full max-w-[920px] max-h-[88vh] rounded-xl border shadow-2xl overflow-hidden flex flex-col ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Edit NanoDLP Resin Profile</h3>
                  <p className="ui-meta">{selectedNanodlpMaterial.name} • Profile ID {selectedNanodlpMaterial.id}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsNanodlpEditDialogOpen(false)}
                  disabled={isSavingNanodlpEdit}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close NanoDLP edit dialog"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 space-y-3 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="flex items-center gap-1.5 border-b pb-2" style={{ borderColor: 'var(--border-subtle)' }}>
                  <button
                    type="button"
                    onClick={() => setNanodlpEditTab('basic')}
                    className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
                    style={nanodlpEditTab === 'basic'
                      ? { color: 'var(--accent-secondary)', borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)' }
                      : { color: 'var(--text-muted)' }}
                  >
                    Basic
                  </button>
                  <button
                    type="button"
                    onClick={() => setNanodlpEditTab('advanced')}
                    className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] rounded-md"
                    style={nanodlpEditTab === 'advanced'
                      ? { color: 'var(--accent-secondary)', borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)' }
                      : { color: 'var(--text-muted)' }}
                  >
                    Advanced
                  </button>
                </div>

                {nanodlpEditTab === 'basic' ? (
                  <div className="space-y-2.5">
                    {basicNanodlpSections.map((section) => (
                      <div
                        key={section.id}
                        className="rounded-lg border p-2.5"
                        style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}
                      >
                        <div className="ui-meta font-semibold uppercase tracking-wide mb-2 flex items-center justify-between gap-2">
                          <span>{section.title}</span>
                          {section.id === 'timing' && isNanodlpDynamicWaitEnabledState && (
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
                            const field = nanodlpPrimaryFieldByKey.get(key);
                            const isDynamicWaitLockedField = isNanodlpDynamicWaitEnabledState && (key === 'SupportBeforeWait' || key === 'BeforeWait');
                            const dynamicWaitHelp = isDynamicWaitLockedField
                              ? 'Controlled by Dynamic Wait. Disable Dynamic Wait in Advanced settings to edit this value.'
                              : undefined;
                            const numericValue = Number(value);
                            const isNumeric = Number.isFinite(numericValue);
                            if (isNumeric) {
                              return (
                                <LabeledNumberInput
                                  key={key}
                                  label={field?.label ?? formatNanoDlpMetaLabel(key)}
                                  helpText={dynamicWaitHelp ?? field?.description}
                                  disabled={isDynamicWaitLockedField}
                                  value={numericValue}
                                  onChange={(next) => setNanodlpEditDraft((prev) => ({
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
                                label={field?.label ?? formatNanoDlpMetaLabel(key)}
                                helpText={dynamicWaitHelp ?? field?.description}
                                disabled={isDynamicWaitLockedField}
                                value={value}
                                onChange={(next) => setNanodlpEditDraft((prev) => ({ ...prev, [key]: next }))}
                              />
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {advancedNanodlpSections.length > 0 ? (
                      advancedNanodlpSections.map((section) => (
                        <div
                          key={section.id}
                          className="rounded-lg border p-2.5"
                          style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}
                        >
                          <div className="ui-meta font-semibold uppercase tracking-wide mb-2">{section.title}</div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                            {section.entries.map(([key, value]) => {
                              const numericValue = Number(value);
                              const useNumericInput = Number.isFinite(numericValue)
                                || (value.trim().length === 0 && isLikelyNumericNanoDlpField(key, value));

                              if (useNumericInput) {
                                return (
                                  <LabeledNumberInput
                                    key={key}
                                    label={formatNanoDlpMetaLabel(key)}
                                    helpText={effectiveNetworkUiAdapter.getFieldHelpText(key)}
                                    value={Number.isFinite(numericValue) ? numericValue : 0}
                                    onChange={(next) => setNanodlpEditDraft((prev) => ({ ...prev, [key]: String(next) }))}
                                  />
                                );
                              }

                              return (
                                <LabeledInput
                                  key={key}
                                  label={formatNanoDlpMetaLabel(key)}
                                  helpText={effectiveNetworkUiAdapter.getFieldHelpText(key)}
                                  value={value}
                                  onChange={(next) => setNanodlpEditDraft((prev) => ({ ...prev, [key]: next }))}
                                />
                              );
                            })}
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
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
                  Applies to NanoDLP profile on the printer (all scalar parameters from this profile).
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsNanodlpEditDialogOpen(false)}
                    disabled={isSavingNanodlpEdit}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => { void handleSaveNanodlpEdits(); }}
                    disabled={isSavingNanodlpEdit}
                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-full disabled:opacity-60"
                    style={{ color: 'var(--accent-secondary)' }}
                  >
                    {isSavingNanodlpEdit ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                    {isSavingNanodlpEdit ? 'Saving…' : 'Save to NanoDLP'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

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
        className={`ui-input w-full h-[34px] px-2.5 py-1.5 text-sm ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
      />
    </label>
  );
}

type LabeledNumberInputProps = {
  label: string;
  helpText?: string;
  disabled?: boolean;
  value: number;
  onChange: (value: number) => void;
};

function LabeledNumberInput({ label, helpText, disabled = false, value, onChange }: LabeledNumberInputProps) {
  const [localValue, setLocalValue] = React.useState<string>(() => String(value));
  const [isFocused, setIsFocused] = React.useState(false);

  React.useEffect(() => {
    if (isFocused) return;
    setLocalValue(String(value));
  }, [value, isFocused]);

  const commit = React.useCallback(() => {
    const trimmed = localValue.trim();
    if (trimmed === '') {
      // Revert to persisted value when input is left empty.
      setLocalValue(String(value));
      return;
    }

    const next = Number(trimmed);
    if (!Number.isFinite(next)) {
      setLocalValue(String(value));
      return;
    }

    onChange(next);
    setLocalValue(String(next));
  }, [localValue, onChange, value]);

  const nudge = React.useCallback((direction: 1 | -1) => {
    const fallback = Number.isFinite(value) ? value : 0;
    const parsed = Number(localValue.trim());
    const current = Number.isFinite(parsed) ? parsed : fallback;
    const step = Math.abs(current) < 1 ? 0.01 : 1;
    const decimals = step < 1 ? 3 : 0;
    const next = Number((current + direction * step).toFixed(decimals));
    onChange(next);
    setLocalValue(String(next));
  }, [localValue, onChange, value]);

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
          className={`ui-input w-full h-[34px] pl-2.5 pr-6 py-1.5 text-sm no-spinners ${disabled ? 'opacity-55 cursor-not-allowed' : ''}`}
        />

        <div className="absolute inset-y-0 right-1 flex w-4 flex-col items-center justify-center gap-0.5">
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

type LabeledSelectInputProps = {
  label: string;
  value: PrinterOutputFormat;
  options: Array<{ value: PrinterOutputFormat; label: string }>;
  onChange: (value: PrinterOutputFormat) => void;
};

function LabeledSelectInput({ label, value, options, onChange }: LabeledSelectInputProps) {
  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as PrinterOutputFormat)}
        className="ui-input w-full h-[34px] px-2.5 py-1.5 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

type LabeledToggleInputProps = {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
};

function LabeledToggleInput({ label, checked, onChange }: LabeledToggleInputProps) {
  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium">
        {label}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="ui-input w-full h-[34px] px-2.5 py-1.5 text-sm inline-flex items-center justify-between"
        style={{
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
          style={{ background: checked ? 'var(--accent-secondary)' : 'var(--surface-2)' }}
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
    <label className="space-y-1 block">
      <span className="ui-label font-medium">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as MaterialProfile['resinFamily'])}
        className="ui-input w-full h-[34px] px-2.5 py-1.5 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

type MaterialProfileFormSectionsProps = {
  draft: MaterialDraft;
  onChange: React.Dispatch<React.SetStateAction<MaterialDraft>>;
};

function MaterialProfileFormSections({ draft, onChange }: MaterialProfileFormSectionsProps) {
  return (
    <>
      <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
        <div className="ui-meta font-semibold uppercase tracking-wide mb-2">Metadata</div>
        <div className="grid grid-cols-2 gap-2">
          <LabeledInput
            label="Material brand"
            value={draft.brand}
            onChange={(value) => onChange((prev) => ({ ...prev, brand: value }))}
          />
          <LabeledInput
            label="Material name"
            value={draft.name}
            onChange={(value) => onChange((prev) => ({ ...prev, name: value }))}
          />
          <LabeledResinFamilySelect
            label="Resin family"
            value={draft.resinFamily}
            options={RESIN_FAMILY_OPTIONS}
            onChange={(value) => onChange((prev) => ({ ...prev, resinFamily: value }))}
          />
          <LabeledNumberInput
            label="Bottle price"
            value={draft.bottlePrice}
            onChange={(value) => onChange((prev) => ({ ...prev, bottlePrice: value }))}
          />
          <LabeledCurrencySelect
            label="Currency"
            value={draft.currencyCode || 'USD'}
            options={CURRENCY_OPTIONS}
            onChange={(value) => onChange((prev) => ({ ...prev, currencyCode: value }))}
          />
          <LabeledNumberInput
            label="Bottle capacity (ml)"
            value={draft.bottleCapacityMl}
            onChange={(value) => onChange((prev) => ({ ...prev, bottleCapacityMl: value }))}
          />
        </div>
      </div>

      <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
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
        </div>
      </div>

      <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
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

type LabeledCurrencySelectProps = {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
};

function LabeledCurrencySelect({ label, value, options, onChange }: LabeledCurrencySelectProps) {
  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium">
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="ui-input w-full h-[34px] px-2.5 py-1.5 text-sm"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
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

        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;

        for (let y = 0; y < height; y += 1) {
          for (let x = 0; x < width; x += 1) {
            const alpha = pixels[(y * width + x) * 4 + 3];
            if (alpha > 8) {
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
    <div className="relative h-full w-full">
      {isLoading && (
        <div className="absolute inset-0 z-[1] flex items-center justify-center" style={{ background: 'color-mix(in srgb, #151923, transparent 32%)' }}>
          <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--accent-secondary)' }} />
        </div>
      )}
      <img
        src={displaySrc}
        alt={alt}
        className={`${className ?? ''} transition-opacity duration-150 opacity-100`}
      />
    </div>
  );
}
