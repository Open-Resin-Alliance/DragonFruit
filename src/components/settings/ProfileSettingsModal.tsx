'use client';

import React from 'react';
import { AlertTriangle, Box, Check, ChevronDown, ChevronUp, Download, FlaskConical, ImagePlus, Loader2, Lock, Plus, Printer, Search, Trash2, Upload, Wifi, X } from 'lucide-react';
import {
  addMaterialProfile,
  addPrinterProfileFromPreset,
  duplicatePrinterProfileAsCustom,
  getActivePrinterProfile,
  getAvailablePrinterPresets,
  getMaterialProfilesForPrinter,
  getProfileStoreSnapshot,
  removeMaterialProfile,
  removePrinterProfile,
  setActiveMaterialProfile,
  setActivePrinterProfile,
  subscribeToProfileStore,
  updateMaterialProfile,
  updatePrinterNetworkConnectionStatus,
  updatePrinterNetworkSettings,
  updatePrinterProfile,
  type MaterialProfile,
  type PrinterOutputFormat,
  type PrinterProfile,
} from '@/features/profiles/profileStore';

type ProfileSettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'printer' | 'material';
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

type NanoDlpDetailRow = {
  label: string;
  value: string;
};

type NanoDlpEditDraft = {
  burnInCureTime: number;
  normalCureTime: number;
  liftAfterPrint: number;
  burnInCount: number;
  waitAfterCure: number;
  waitAfterLift: number;
};

function toDisplayValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return null;
}

function firstMetaValue(meta: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (!(key in meta)) continue;
    const display = toDisplayValue(meta[key]);
    if (display) return display;
  }
  return null;
}

function formatNanoDlpMetaLabel(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .trim();
}

function firstMetaNumericValue(meta: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (!(key in meta)) continue;
    const value = Number(meta[key]);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function resolveNanodlpMaterialProcessValues(material: NanoDlpMaterial): {
  layerHeightMm?: number;
  normalExposureSec?: number;
  bottomExposureSec?: number;
  bottomLayerCount?: number;
} {
  const meta = material.meta ?? {};

  const rawLayerHeight = firstMetaNumericValue(meta, [
    'LayerHeight',
    'layerHeight',
    'SliceHeight',
    'sliceHeight',
    'Depth',
    'depth',
  ]);

  const layerHeightMm = rawLayerHeight == null
    ? undefined
    : (rawLayerHeight > 1 ? rawLayerHeight / 1000 : rawLayerHeight);

  const normalExposureSec = firstMetaNumericValue(meta, [
    'CureTime',
    'cureTime',
    'Exposure',
    'exposure',
    'NormalExposure',
    'normalExposure',
    'ExpTime',
  ]);

  const bottomExposureSec = firstMetaNumericValue(meta, [
    'SupportCureTime',
    'supportCureTime',
    'BottomCureTime',
    'bottomCureTime',
    'BottomExposure',
    'bottomExposure',
    'BottomExp',
    'bottomExp',
  ]);

  const bottomLayerCount = firstMetaNumericValue(meta, [
    'SupportLayerNumber',
    'supportLayerNumber',
    'BottomLayerCount',
    'bottomLayerCount',
    'BottomLayers',
    'bottomLayers',
  ]);

  return {
    layerHeightMm: layerHeightMm != null && layerHeightMm > 0 ? layerHeightMm : undefined,
    normalExposureSec: normalExposureSec != null && normalExposureSec > 0 ? normalExposureSec : undefined,
    bottomExposureSec: bottomExposureSec != null && bottomExposureSec > 0 ? bottomExposureSec : undefined,
    bottomLayerCount: bottomLayerCount != null && bottomLayerCount > 0 ? bottomLayerCount : undefined,
  };
}

function resolveNanodlpEditDraft(material: NanoDlpMaterial): NanoDlpEditDraft {
  const meta = material.meta ?? {};

  const burnInCureTime = firstMetaNumericValue(meta, [
    'SupportCureTime',
    'supportCureTime',
    'burn_in_cure_time',
    'BurnInCureTime',
    'BottomCureTime',
  ]) ?? 10;

  const normalCureTime = firstMetaNumericValue(meta, [
    'CureTime',
    'cureTime',
    'normal_cure_time',
    'NormalExposure',
    'normalExposure',
  ]) ?? 8;

  const liftAfterPrint = firstMetaNumericValue(meta, [
    'WaitHeight',
    'waitHeight',
    'lift_after_print',
    'LiftAfterPrint',
    'ZLiftDistance',
  ]) ?? 5;

  const burnInCount = firstMetaNumericValue(meta, [
    'SupportLayerNumber',
    'supportLayerNumber',
    'burn_in_count',
    'BottomLayerCount',
  ]) ?? 3;

  const waitAfterCure = firstMetaNumericValue(meta, [
    'TopWait',
    'topWait',
    'wait_after_cure',
    'WaitAfterCure',
  ]) ?? 2;

  const waitAfterLift = firstMetaNumericValue(meta, [
    'WaitAfterPrint',
    'waitAfterPrint',
    'wait_after_life',
    'wait_after_lift',
  ]) ?? 2;

  return {
    burnInCureTime,
    normalCureTime,
    liftAfterPrint,
    burnInCount: Math.max(0, Math.round(burnInCount)),
    waitAfterCure,
    waitAfterLift,
  };
}

function denormalizeNanodlpEditDraftForBackend(draft: NanoDlpEditDraft): Record<string, string> {
  return {
    SupportCureTime: String(draft.burnInCureTime),
    CureTime: String(draft.normalCureTime),
    WaitHeight: String(draft.liftAfterPrint),
    SupportLayerNumber: String(Math.max(0, Math.round(draft.burnInCount))),
    TopWait: String(draft.waitAfterCure),
    WaitAfterPrint: String(draft.waitAfterLift),
  };
}

function buildNanoDlpMaterialChips(material: NanoDlpMaterial): string[] {
  const processValues = resolveNanodlpMaterialProcessValues(material);
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

function buildNanoDlpDetailRows(material: NanoDlpMaterial): NanoDlpDetailRow[] {
  const meta = material.meta ?? {};
  const rows: NanoDlpDetailRow[] = [];

  const add = (label: string, keys: string[]) => {
    const value = firstMetaValue(meta, keys);
    if (value) rows.push({ label, value });
  };

  add('Profile ID', ['ProfileID', 'ProfileId', 'profileId', 'id', 'ID']);
  add('Path', ['Path', 'path', 'File', 'file']);
  add('Normal Exposure', ['CureTime', 'cureTime', 'Exposure', 'exposure', 'NormalExposure', 'normalExposure', 'ExpTime']);
  add('Bottom Exposure', ['SupportCureTime', 'supportCureTime', 'BottomExposure', 'bottomExposure', 'BottomExp', 'bottomExp']);
  add('Layer Height', ['LayerHeight', 'layerHeight', 'SliceHeight', 'sliceHeight']);
  add('Bottom Layers', ['SupportLayerNumber', 'supportLayerNumber', 'BottomLayers', 'bottomLayers', 'BottomLayerCount', 'bottomLayerCount']);
  add('Lift Distance', ['LiftDistance', 'liftDistance']);
  add('Lift Speed', ['LiftSpeed', 'liftSpeed']);
  add('Retract Speed', ['RetractSpeed', 'retractSpeed']);
  add('Brand', ['Brand', 'brand']);
  add('Resin Type', ['ResinType', 'resinType', 'Type', 'type']);

  const usedValues = new Set(rows.map((row) => `${row.label}:${row.value}`));
  for (const [key, raw] of Object.entries(meta)) {
    if (rows.length >= 16) break;
    const value = toDisplayValue(raw);
    if (!value) continue;
    const marker = `${key}:${value}`;
    if (usedValues.has(marker)) continue;
    usedValues.add(marker);
    rows.push({ label: key, value });
  }

  if (!rows.some((row) => row.label === 'Profile ID')) {
    rows.unshift({ label: 'Profile ID', value: material.id });
  }

  return rows;
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

export function ProfileSettingsModal({ isOpen, onClose }: ProfileSettingsModalProps) {
  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreSnapshot);
  const [selectedPrinterId, setSelectedPrinterId] = React.useState<string | null>(null);
  const [selectedMaterialId, setSelectedMaterialId] = React.useState<string | null>(null);
  const [selectedManufacturer, setSelectedManufacturer] = React.useState<string | null>(null);
  const [selectedResinFamily, setSelectedResinFamily] = React.useState<MaterialProfile['resinFamily'] | null>(null);
  const [isCreateMaterialOpen, setIsCreateMaterialOpen] = React.useState(false);
  const [isMaterialEditorOpen, setIsMaterialEditorOpen] = React.useState(false);
  const [showOfficialLockDialog, setShowOfficialLockDialog] = React.useState(false);
  const [officialLockedProfileId, setOfficialLockedProfileId] = React.useState<string | null>(null);
  const [isNetworkSettingsOpen, setIsNetworkSettingsOpen] = React.useState(false);
  const [networkDiscoveryEnabled, setNetworkDiscoveryEnabled] = React.useState(true);
  const [networkIpAddress, setNetworkIpAddress] = React.useState('');
  const [isNetworkScanning, setIsNetworkScanning] = React.useState(false);
  const [isNetworkConnecting, setIsNetworkConnecting] = React.useState(false);
  const [networkConnectionMessage, setNetworkConnectionMessage] = React.useState('');
  const [showManualNetworkEntry, setShowManualNetworkEntry] = React.useState(false);
  const [hasAutoScannedOnOpen, setHasAutoScannedOnOpen] = React.useState(false);
  const [discoveredPrinters, setDiscoveredPrinters] = React.useState<Array<{ id: string; name: string; ipAddress: string; status: 'online' | 'reachable' }>>([]);
  const [nanodlpMaterials, setNanodlpMaterials] = React.useState<NanoDlpMaterial[]>([]);
  const [isLoadingNanodlpMaterials, setIsLoadingNanodlpMaterials] = React.useState(false);
  const [nanodlpMaterialsError, setNanodlpMaterialsError] = React.useState<string | null>(null);
  const [selectedNanodlpMaterialId, setSelectedNanodlpMaterialId] = React.useState<string>('');
  const [isNanodlpDetailsDialogOpen, setIsNanodlpDetailsDialogOpen] = React.useState(false);
  const [isNanodlpEditDialogOpen, setIsNanodlpEditDialogOpen] = React.useState(false);
  const [isSavingNanodlpEdit, setIsSavingNanodlpEdit] = React.useState(false);
  const [nanodlpEditDraft, setNanodlpEditDraft] = React.useState<NanoDlpEditDraft>({
    burnInCureTime: 10,
    normalCureTime: 8,
    liftAfterPrint: 5,
    burnInCount: 3,
    waitAfterCure: 2,
    waitAfterLift: 2,
  });
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
  const imageUploadInputRef = React.useRef<HTMLInputElement | null>(null);

  const availablePrinterPresets = React.useMemo(() => getAvailablePrinterPresets(), []);

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
        || preset.manufacturer.toLowerCase().includes(search);
      return manufacturerMatch && searchMatch;
    });
  }, [availablePrinterPresets, presetSearch, selectedPresetManufacturer]);

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
  const selectedNetworkModeLabel = selectedPrinter?.networkSupport === 'nanodlp' ? 'NanoDLP' : 'Unknown';
  const shouldUseNanodlpOnDeviceMaterials = Boolean(
    selectedPrinter?.networkSupport === 'nanodlp'
    && selectedPrinter.networkConnection?.connected
    && (selectedPrinter.networkConnection?.ipAddress || selectedPrinter.network?.ipAddress),
  );

  const selectedNanodlpMaterial = React.useMemo(() => {
    if (!selectedNanodlpMaterialId) return null;
    return nanodlpMaterials.find((material) => material.id === selectedNanodlpMaterialId) ?? null;
  }, [nanodlpMaterials, selectedNanodlpMaterialId]);

  const selectedNanodlpMaterialIdRef = React.useRef('');

  React.useEffect(() => {
    selectedNanodlpMaterialIdRef.current = selectedNanodlpMaterialId;
  }, [selectedNanodlpMaterialId]);

  const selectedPrinterResolvedId = selectedPrinter?.id ?? '';
  const selectedPrinterNetworkSupportMode = selectedPrinter?.networkSupport ?? null;
  const selectedNanodlpHost = (selectedPrinter?.networkConnection?.ipAddress || selectedPrinter?.network?.ipAddress || '').trim();

  const selectedNanodlpMaterialDetails = React.useMemo(() => {
    if (!selectedNanodlpMaterial) return [];
    return buildNanoDlpDetailRows(selectedNanodlpMaterial);
  }, [selectedNanodlpMaterial]);

  const { compactNanodlpDetailRows, expandedNanodlpDetailRows } = React.useMemo(() => {
    const expanded: NanoDlpDetailRow[] = [];
    const compact: NanoDlpDetailRow[] = [];

    for (const row of selectedNanodlpMaterialDetails) {
      const key = row.label.toLowerCase();
      const isNarrativeField = key.includes('desc')
        || key.includes('description')
        || key.includes('title')
        || key.includes('note')
        || key.includes('comment');
      const isLongValue = row.value.length > 96;

      if (isNarrativeField || isLongValue) {
        expanded.push(row);
      } else {
        compact.push(row);
      }
    }

    return { compactNanodlpDetailRows: compact, expandedNanodlpDetailRows: expanded };
  }, [selectedNanodlpMaterialDetails]);

  React.useEffect(() => {
    if (!isOpen) return;

    setSelectedPrinterId(profileState.activePrinterProfileId);
    setSelectedManufacturer(null);
    setSelectedResinFamily(null);
    setIsMaterialEditorOpen(false);
    setIsEditingPrinter(false);
    setIsNetworkSettingsOpen(false);
    setShowPresetPicker(false);
    setPresetSearch('');
    setSelectedPresetManufacturer('All');
    const materials = getMaterialProfilesForPrinter(profileState.activePrinterProfileId, profileState);
    setSelectedMaterialId(materials[0]?.id ?? null);
  }, [isOpen]);

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
      return;
    }

    setNetworkDiscoveryEnabled(selectedPrinter.network?.discoveryEnabled ?? true);
    setNetworkIpAddress(selectedPrinter.network?.ipAddress ?? '');
    setDiscoveredPrinters([]);
    setNetworkConnectionMessage(selectedPrinter.networkConnection?.statusText ?? '');
    setShowManualNetworkEntry(false);
  }, [selectedPrinter]);

  React.useEffect(() => {
    if (!selectedPrinterSupportsNetworkSettings) {
      setIsNetworkSettingsOpen(false);
    }
  }, [selectedPrinterSupportsNetworkSettings]);

  const loadNanodlpMaterials = React.useCallback(async () => {
    if (!selectedPrinterResolvedId) return;
    if (selectedPrinterNetworkSupportMode !== 'nanodlp') return;

    const host = selectedNanodlpHost;
    if (!host) {
      setNanodlpMaterials([]);
      setNanodlpMaterialsError('Connect to a NanoDLP printer to load on-device materials.');
      return;
    }

    setIsLoadingNanodlpMaterials(true);
    setNanodlpMaterialsError(null);

    try {
      const response = await fetch('/api/network/nanodlp/materials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ host }),
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
        const processValues = resolveNanodlpMaterialProcessValues(nextSelected as NanoDlpMaterial);
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
  }, [selectedNanodlpHost, selectedPrinterNetworkSupportMode, selectedPrinterResolvedId]);

  React.useEffect(() => {
    if (!shouldUseNanodlpOnDeviceMaterials || !selectedPrinterResolvedId) {
      setNanodlpMaterials([]);
      setSelectedNanodlpMaterialId('');
      setIsNanodlpDetailsDialogOpen(false);
      setIsNanodlpEditDialogOpen(false);
      setNanodlpMaterialsError(null);
      return;
    }

    void loadNanodlpMaterials();
  }, [loadNanodlpMaterials, selectedPrinterResolvedId, shouldUseNanodlpOnDeviceMaterials]);

  const handleSelectNanodlpMaterial = React.useCallback((material: NanoDlpMaterial) => {
    if (!selectedPrinter) return;
    const processValues = resolveNanodlpMaterialProcessValues(material);
    setSelectedNanodlpMaterialId(material.id);
    updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
      selectedMaterialId: material.id,
      selectedMaterialName: material.name,
      selectedMaterialLayerHeightMm: processValues.layerHeightMm,
      selectedMaterialNormalExposureSec: processValues.normalExposureSec,
      selectedMaterialBottomExposureSec: processValues.bottomExposureSec,
      selectedMaterialBottomLayerCount: processValues.bottomLayerCount,
    });
  }, [selectedPrinter]);

  const openNanodlpEditDialog = React.useCallback(() => {
    if (!selectedNanodlpMaterial) return;
    setNanodlpEditDraft(resolveNanodlpEditDraft(selectedNanodlpMaterial));
    setIsNanodlpEditDialogOpen(true);
  }, [selectedNanodlpMaterial]);

  const handleSaveNanodlpEdits = React.useCallback(async () => {
    if (!selectedPrinter) return;
    if (!selectedNanodlpMaterial) return;

    const host = (selectedPrinter.networkConnection?.ipAddress || selectedPrinter.network?.ipAddress || '').trim();
    const profileId = Number(selectedNanodlpMaterial.id);
    if (!host || !Number.isFinite(profileId) || profileId <= 0) return;

    setIsSavingNanodlpEdit(true);
    setNanodlpMaterialsError(null);

    try {
      const response = await fetch('/api/network/nanodlp/materials/edit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          host,
          profileId,
          fields: denormalizeNanodlpEditDraftForBackend(nanodlpEditDraft),
        }),
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
  }, [loadNanodlpMaterials, nanodlpEditDraft, selectedNanodlpMaterial, selectedPrinter]);

  React.useEffect(() => {
    if (isNetworkSettingsOpen) {
      setHasAutoScannedOnOpen(false);
    }
  }, [isNetworkSettingsOpen, selectedPrinter?.id]);

  const handleRunNetworkDiscovery = React.useCallback(async () => {
    if (!selectedPrinter) return;
    if (!networkDiscoveryEnabled) return;
    if (selectedPrinter.networkSupport !== 'nanodlp') return;

    setIsNetworkScanning(true);
    setNetworkConnectionMessage('Scanning local network for NanoDLP devices…');

    try {
      const configuredHost = networkIpAddress.trim();
      const seedDevices: Array<{ id: string; name: string; ipAddress: string; status: 'online' | 'reachable' }> = [];

      if (configuredHost.length > 0) {
        const connectResponse = await fetch('/api/network/nanodlp/connect', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ host: configuredHost }),
        });

        const connectPayload = await connectResponse.json().catch(() => null) as any;
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

      const response = await fetch('/api/network/nanodlp/discover', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: 'nanodlp',
          host: networkIpAddress.trim() || undefined,
          ports: [80, 8080],
        }),
      });

      const payload = await response.json().catch(() => null) as any;
      const devices: any[] = Array.isArray(payload?.devices) ? payload.devices : [];
      const scannedHosts = Number.isFinite(Number(payload?.scannedHosts)) ? Number(payload.scannedHosts) : 0;
      const scannedEndpoints = Number.isFinite(Number(payload?.scannedEndpoints)) ? Number(payload.scannedEndpoints) : 0;

      const discovered = devices.map((device, index) => {
        const hostName = typeof device?.hostName === 'string' ? device.hostName.trim() : '';
        const printerName = typeof device?.printerName === 'string' ? device.printerName.trim() : '';
        const ipAddress = typeof device?.ipAddress === 'string' ? device.ipAddress.trim() : '';

        return {
          id: `${selectedPrinter.id}-scan-${index}`,
          name: hostName || printerName || 'NanoDLP Printer',
          ipAddress,
          status: 'online' as const,
        };
      }).filter((item) => item.ipAddress.length > 0);

      const merged = [...seedDevices, ...discovered].filter((item, index, array) => (
        array.findIndex((candidate) => candidate.ipAddress === item.ipAddress) === index
      ));

      setDiscoveredPrinters(merged);

      if (merged.length > 0) {
        setNetworkConnectionMessage(
          `Found ${merged.length} NanoDLP device${merged.length === 1 ? '' : 's'} (scanned ${scannedHosts} hosts / ${scannedEndpoints} endpoints).`,
        );
      } else {
        setNetworkConnectionMessage(
          scannedHosts > 0
            ? `No NanoDLP devices found (scanned ${scannedHosts} hosts / ${scannedEndpoints} endpoints).`
            : 'No local IPv4 subnet detected by the scanner. Try entering printer IP and scanning again.',
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Discovery failed';
      setDiscoveredPrinters([]);
      setNetworkConnectionMessage(message);
    } finally {
      setIsNetworkScanning(false);
    }
  }, [networkDiscoveryEnabled, networkIpAddress, selectedPrinter]);

  const handleConnectNetworkPrinter = React.useCallback(async (options?: { host?: string; closeOnSuccess?: boolean }) => {
    if (!selectedPrinter || selectedPrinter.networkSupport !== 'nanodlp') return;

    const host = (options?.host ?? networkIpAddress).trim();
    if (!host) {
      const now = new Date().toISOString();
      setNetworkConnectionMessage('Enter a printer IP address or host first.');
      updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
        mode: 'nanodlp',
        connected: false,
        hostName: '',
        ipAddress: '',
        port: 80,
        lastCheckedAt: now,
        statusText: 'Missing printer host/IP.',
      });
      return false;
    }

    setIsNetworkConnecting(true);
    setNetworkConnectionMessage('Connecting to NanoDLP host…');

    try {
      const response = await fetch('/api/network/nanodlp/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ host }),
      });

      const payload = await response.json().catch(() => null) as any;
      const now = new Date().toISOString();

      if (payload?.connected === true) {
        const resolvedHostName = [payload.hostName, payload.printerName, payload.ipAddress, host]
          .find((value) => typeof value === 'string' && value.trim().length > 0)?.trim() ?? host;

        updatePrinterNetworkSettings(selectedPrinter.id, {
          discoveryEnabled: networkDiscoveryEnabled,
          ipAddress: typeof payload.ipAddress === 'string' ? payload.ipAddress : host,
        });

        setNetworkIpAddress(typeof payload.ipAddress === 'string' ? payload.ipAddress : host);

        updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
          mode: 'nanodlp',
          connected: true,
          hostName: resolvedHostName,
          ipAddress: typeof payload.ipAddress === 'string' ? payload.ipAddress : host,
          port: Number.isFinite(Number(payload.port)) ? Number(payload.port) : 80,
          lastCheckedAt: now,
          statusText: typeof payload.statusText === 'string' ? payload.statusText : 'Connected',
        });

        setNetworkConnectionMessage(`Connected to ${resolvedHostName}`);
        if (options?.closeOnSuccess) {
          setIsNetworkSettingsOpen(false);
        }
        return true;
      } else {
        const statusText = typeof payload?.statusText === 'string'
          ? payload.statusText
          : 'NanoDLP host unreachable.';

        updatePrinterNetworkConnectionStatus(selectedPrinter.id, {
          mode: 'nanodlp',
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
        mode: 'nanodlp',
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
  }, [networkDiscoveryEnabled, networkIpAddress, selectedPrinter]);

  React.useEffect(() => {
    if (!isNetworkSettingsOpen) return;
    if (!selectedPrinterSupportsNetworkSettings) return;
    if (selectedPrinter?.networkSupport !== 'nanodlp') return;
    if (!networkDiscoveryEnabled) return;
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

  if (!isOpen) return null;
  const hasPrinters = profileState.printerProfiles.length > 0;
  const isCustomSelectedPrinter = Boolean(selectedPrinter?.isCustom && !selectedPrinter?.isOfficial);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/58 backdrop-blur-sm p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-[1120px] h-full flex flex-col rounded-xl border shadow-2xl overflow-hidden"
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

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 custom-scrollbar">
          <div className="flex flex-col gap-3 min-h-full">
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
          <section className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 8%), var(--surface-1))' }}>
            <div className="px-3 py-2.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-strong)' }}>
                <Box className="w-4 h-4" />
                3D Printer
              </h3>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Each printer can store its own image and has a dedicated set of compatible resin/material profiles.
              </p>
            </div>

            <div className="px-3 py-2.5">
              <div className="flex gap-2 overflow-x-auto pb-1">
                {profileState.printerProfiles.map((printer) => {
                  const active = printer.id === selectedPrinter?.id;
                  const isGenericPrinter = (printer.manufacturer ?? '').toLowerCase() === 'generic'
                    || printer.name.toLowerCase().includes('generic');
                  const isNetworkConnected = printer.networkConnection?.connected === true;
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
                        {isNetworkConnected && (
                          <span
                            className="absolute top-1 left-1 inline-flex h-5 w-5 items-center justify-center rounded-full border"
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
                        {printer.isCustom && (
                          <span
                            className="absolute top-1 right-1 text-[9px] font-bold px-1.5 py-0.5 rounded"
                            style={{
                              background: '#dc2626',
                              color: '#ffffff',
                              letterSpacing: '0.04em',
                            }}
                          >
                            CUSTOM
                          </span>
                        )}
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
                      </div>
                      <div className="mt-2.5 text-[12px] leading-snug font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                        {printer.name}
                      </div>
                      <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                        {printer.manufacturer || 'Generic'}
                      </div>
                    </button>
                  );
                })}
              </div>

              {!hasPrinters && (
                <div className="mt-3 min-h-[220px] rounded-xl border flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="text-center max-w-[420px] px-5">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border mb-3" style={{ borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 30%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)' }}>
                      <Printer className="w-6 h-6" style={{ color: 'var(--accent)' }} />
                    </div>
                    <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Welcome to Printer Profiles</h4>
                    <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Start by adding your first printer from the preset library. Once added, resin profiles will be created for that printer.
                    </p>
                    <button
                      type="button"
                      onClick={handleAddPrinter}
                      className="ui-button ui-button-secondary mt-3 !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-full"
                      style={{ color: 'var(--accent)' }}
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Printer
                    </button>
                  </div>
                </div>
              )}

              {isEditingPrinter && selectedPrinter ? (
                <div className="mt-3 rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
                  <div className="text-[11px] font-semibold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>
                    Edit Printer Profile
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
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        display: {
                          ...selectedPrinter.display,
                          resolutionX: value,
                        },
                      })}
                    />

                    <LabeledNumberInput
                      label="Resolution Y (px)"
                      value={selectedPrinter.display.resolutionY}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        display: {
                          ...selectedPrinter.display,
                          resolutionY: value,
                        },
                      })}
                    />
                    <LabeledSelectInput
                      label="Output format"
                      value={selectedPrinter.display.outputFormat}
                      options={OUTPUT_FORMAT_OPTIONS}
                      onChange={(value) => updatePrinterProfile(selectedPrinter.id, {
                        display: {
                          ...selectedPrinter.display,
                          outputFormat: value,
                        },
                      })}
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
                      onClick={() => {
                        if (!selectedPrinter) return;
                        setNetworkDiscoveryEnabled(selectedPrinter.network?.discoveryEnabled ?? true);
                        setNetworkIpAddress(selectedPrinter.network?.ipAddress ?? '');
                        setIsNetworkSettingsOpen(true);
                      }}
                      disabled={!hasPrinters || !selectedPrinter}
                      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                      style={{ color: 'var(--text-strong)' }}
                    >
                      <Search className="w-3.5 h-3.5" />
                      Network Settings
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

          {hasPrinters && selectedPrinter && (
          <section
            className="rounded-lg border overflow-hidden flex flex-col min-h-0 flex-1"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 8%), var(--surface-1))',
            }}
          >
            <div className="px-3 py-2.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
              <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: 'var(--text-strong)' }}>
                <FlaskConical className="w-4 h-4" />
                Material Settings
              </h3>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {shouldUseNanodlpOnDeviceMaterials
                  ? <>Connected NanoDLP profiles are loaded directly from <span style={{ color: 'var(--text-strong)' }}>{selectedPrinter.name}</span>. Selection is read-only for now.</>
                  : <>Profiles below are bound to <span style={{ color: 'var(--text-strong)' }}>{selectedPrinter.name}</span> and follow the selected printer hardware.</>}
              </p>
            </div>

            <div className="p-3 flex flex-col gap-3 flex-1 min-h-0">
              {shouldUseNanodlpOnDeviceMaterials ? (
                <>
                  <div className="rounded-xl border overflow-hidden flex flex-col flex-1 min-h-[420px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
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
                          const chips = buildNanoDlpMaterialChips(material);
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
                          <button
                            type="button"
                            onClick={openNanodlpEditDialog}
                            className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] inline-flex items-center gap-1 rounded-md"
                            style={{ color: 'var(--accent-secondary)' }}
                          >
                            Edit profile
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsNanodlpDetailsDialogOpen(true)}
                            className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] inline-flex items-center gap-1 rounded-md"
                            style={{ color: 'var(--text-strong)' }}
                          >
                            View details
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
                        Select a printer material profile to view details.
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
              <div className="rounded-xl border overflow-hidden flex flex-col flex-1 min-h-[420px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}>
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

                <div className="grid grid-cols-[1fr_1fr_1.25fr] flex-1 min-h-[300px] border-b" style={{ borderColor: 'var(--border-subtle)' }}>
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
          <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowPresetPicker(false);
          }}>
            <div className="w-full max-w-[1040px] max-h-[94vh] rounded-xl border shadow-2xl overflow-hidden" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
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
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-2.5">
                    {filteredPrinterPresets.map((preset) => {
                      const isAlreadyAdded = addedOfficialPresetIds.has(preset.presetId);
                      const isGenericPreset = preset.manufacturer.toLowerCase() === 'generic'
                        || preset.name.toLowerCase().includes('generic');

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
                          <div className="h-[136px] rounded-md border overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: '#2b3039' }}>
                            {preset.imageAssetPath ? (
                              <AutoTrimmedImage src={preset.imageAssetPath} alt={preset.name} className="h-full w-full object-contain" />
                            ) : (
                              isGenericPreset
                                ? <Printer className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                                : <ImagePlus className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                            )}
                          </div>
                          <div className="mt-2 text-[12px] font-semibold leading-tight flex items-center justify-between gap-2" style={{ color: 'var(--text-strong)' }}>
                            <span className="truncate">{preset.name}</span>
                            {isAlreadyAdded && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)', color: 'var(--accent-secondary)' }}>
                                Added
                              </span>
                            )}
                          </div>
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            {preset.manufacturer}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {isMaterialEditorOpen && selectedMaterial && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsMaterialEditorOpen(false);
          }}>
            <div className="w-full max-w-[920px] max-h-[88vh] overflow-y-auto rounded-xl border shadow-2xl custom-scrollbar" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
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
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsCreateMaterialOpen(false);
          }}>
            <div className="w-full max-w-[920px] max-h-[88vh] overflow-y-auto rounded-xl border shadow-2xl custom-scrollbar" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
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
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsNetworkSettingsOpen(false);
          }}>
            <div className="w-full max-w-[620px] rounded-xl border shadow-2xl" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Network Settings</h3>
                  <p className="ui-meta">{selectedPrinter.name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsNetworkSettingsOpen(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close network settings"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-4 space-y-3">
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Discovery</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        Automatically find this printer on the local network.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNetworkDiscoveryEnabled((prev) => !prev)}
                      className="h-8 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                      style={networkDiscoveryEnabled
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                            color: 'var(--accent-contrast)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            color: 'var(--text-muted)',
                          }}
                    >
                      {networkDiscoveryEnabled ? 'ON' : 'OFF'}
                    </button>
                  </div>

                  <div className="mt-2.5 flex items-center justify-between gap-2">
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      Scan for network printers and pick one to auto-fill IP.
                    </div>
                    <button
                      type="button"
                      onClick={() => { void handleRunNetworkDiscovery(); }}
                      disabled={!networkDiscoveryEnabled || isNetworkScanning}
                      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                      style={{ color: 'var(--text-strong)' }}
                    >
                      <Search className={`w-3.5 h-3.5 ${isNetworkScanning ? 'animate-pulse' : ''}`} />
                      {isNetworkScanning ? 'Scanning…' : 'Scan'}
                    </button>
                  </div>
                </div>

                {networkDiscoveryEnabled && (
                  <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Discovered Printers</div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {discoveredPrinters.length} found
                      </div>
                    </div>

                    {discoveredPrinters.length === 0 ? (
                      <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                        No discovered printers yet. Run Scan to search your local subnet.
                      </div>
                    ) : (
                      <div className="mt-2 space-y-1.5 max-h-[160px] overflow-y-auto custom-scrollbar pr-1">
                        {discoveredPrinters.map((entry) => (
                          (() => {
                            const isEntryConnected = selectedPrinter.networkConnection?.connected === true
                              && selectedPrinter.networkConnection.ipAddress === entry.ipAddress;

                            return (
                              <div
                                key={entry.id}
                                className="rounded-md border px-2 py-1.5 flex items-center justify-between gap-2"
                                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                              >
                                <div className="min-w-0">
                                  <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-strong)' }}>{entry.name}</div>
                                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    {entry.ipAddress} • {entry.status === 'online' ? 'Online' : 'Reachable'}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (isEntryConnected) return;
                                    void handleConnectNetworkPrinter({ host: entry.ipAddress, closeOnSuccess: true });
                                  }}
                                  disabled={isEntryConnected || isNetworkConnecting}
                                  className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-[11px] inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-60"
                                  style={{ color: isEntryConnected ? '#9ca3af' : 'var(--accent-secondary)' }}
                                >
                                  {isEntryConnected
                                    ? <><Check className="w-3.5 h-3.5" />Connected</>
                                    : (isNetworkConnecting ? 'Connecting…' : 'Connect')}
                                </button>
                              </div>
                            );
                          })()
                        ))}
                      </div>
                    )}

                    <div className="mt-3 border-t pt-2.5" style={{ borderColor: 'var(--border-subtle)' }}>
                      <button
                        type="button"
                        onClick={() => setShowManualNetworkEntry((prev) => !prev)}
                        className="text-[11px] underline decoration-dotted underline-offset-2 hover:opacity-80 transition-opacity"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {showManualNetworkEntry ? 'Hide manual IP entry' : 'Cannot find your machine?'}
                      </button>
                    </div>
                  </div>
                )}

                {showManualNetworkEntry && (
                  <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                    <label className="space-y-1 block">
                      <span className="ui-label font-medium">Printer IP Address (manual)</span>
                      <input
                        type="text"
                        value={networkIpAddress}
                        onChange={(event) => setNetworkIpAddress(event.target.value)}
                        placeholder="e.g. 192.168.1.140"
                        className="ui-input w-full h-[34px] px-2.5 py-1.5 text-sm"
                      />
                    </label>

                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {selectedPrinter.networkConnection?.connected
                          ? `Connected: ${selectedPrinter.networkConnection.hostName || selectedPrinter.networkConnection.ipAddress}`
                          : 'Not connected'}
                      </div>
                      <button
                        type="button"
                        onClick={() => { void handleConnectNetworkPrinter(); }}
                        disabled={isNetworkConnecting || !networkIpAddress.trim()}
                        className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                        style={{ color: 'var(--accent-secondary)' }}
                      >
                        {isNetworkConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
                        {isNetworkConnecting ? 'Connecting…' : 'Connect'}
                      </button>
                    </div>
                  </div>
                )}

                {networkConnectionMessage && (
                  <div className="text-[11px]" style={{ color: selectedPrinter.networkConnection?.connected ? '#86efac' : 'var(--text-muted)' }}>
                    {networkConnectionMessage}
                  </div>
                )}
              </div>

              <div className="px-4 pb-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsNetworkSettingsOpen(false)}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    updatePrinterNetworkSettings(selectedPrinter.id, {
                      discoveryEnabled: networkDiscoveryEnabled,
                      ipAddress: networkIpAddress.trim(),
                    });
                    setIsNetworkSettingsOpen(false);
                  }}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                  style={{
                    color: 'var(--accent-secondary)',
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                  }}
                >
                  <Check className="w-3.5 h-3.5" />
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {isNanodlpEditDialogOpen && selectedNanodlpMaterial && (
          <div className="fixed inset-0 z-[71] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isSavingNanodlpEdit) setIsNanodlpEditDialogOpen(false);
          }}>
            <div className="w-full max-w-[920px] max-h-[88vh] overflow-y-auto rounded-xl border shadow-2xl custom-scrollbar" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
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

              <div className="p-3 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  <LabeledNumberInput
                    label="Burn-In Layer Cure Time (s)"
                    value={nanodlpEditDraft.burnInCureTime}
                    onChange={(value) => setNanodlpEditDraft((prev) => ({ ...prev, burnInCureTime: value }))}
                  />
                  <LabeledNumberInput
                    label="Burn-In Layer Count"
                    value={nanodlpEditDraft.burnInCount}
                    onChange={(value) => setNanodlpEditDraft((prev) => ({ ...prev, burnInCount: Math.max(0, Math.round(value)) }))}
                  />
                  <LabeledNumberInput
                    label="Normal Layer Cure Time (s)"
                    value={nanodlpEditDraft.normalCureTime}
                    onChange={(value) => setNanodlpEditDraft((prev) => ({ ...prev, normalCureTime: value }))}
                  />
                  <LabeledNumberInput
                    label="Wait After Cure (s)"
                    value={nanodlpEditDraft.waitAfterCure}
                    onChange={(value) => setNanodlpEditDraft((prev) => ({ ...prev, waitAfterCure: value }))}
                  />
                  <LabeledNumberInput
                    label="Lift After Print (mm)"
                    value={nanodlpEditDraft.liftAfterPrint}
                    onChange={(value) => setNanodlpEditDraft((prev) => ({ ...prev, liftAfterPrint: value }))}
                  />
                  <LabeledNumberInput
                    label="Wait After Lift (s)"
                    value={nanodlpEditDraft.waitAfterLift}
                    onChange={(value) => setNanodlpEditDraft((prev) => ({ ...prev, waitAfterLift: value }))}
                  />
                </div>
              </div>

              <div className="px-3 py-2 border-t flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Applies to NanoDLP profile on the printer.
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

        {isNanodlpDetailsDialogOpen && selectedNanodlpMaterial && (
          <div className="fixed inset-0 z-[72] flex items-center justify-center bg-black/55 p-4" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsNanodlpDetailsDialogOpen(false);
          }}>
            <div className="w-full max-w-[920px] max-h-[88vh] overflow-y-auto rounded-xl border shadow-2xl custom-scrollbar" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <div>
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>NanoDLP Resin Profile Details</h3>
                  <p className="ui-meta">{selectedNanodlpMaterial.name}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsNanodlpDetailsDialogOpen(false)}
                  className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
                  aria-label="Close NanoDLP material details"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="p-3 space-y-3">
                <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}>
                      Profile ID: {selectedNanodlpMaterial.id}
                    </span>
                    {selectedNanodlpMaterial.locked && (
                      <span className="text-[11px] rounded-full border px-2 py-0.5" style={{ borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 35%)', color: '#fbbf24', background: 'var(--surface-2)' }}>
                        Locked on printer
                      </span>
                    )}
                    <span className="text-[11px] ml-auto" style={{ color: 'var(--text-muted)' }}>
                      Source: NanoDLP device
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  {selectedNanodlpMaterialDetails.length > 0 ? (
                    <div className="space-y-3">
                      {compactNanodlpDetailRows.length > 0 && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px]">
                          {compactNanodlpDetailRows.map((row) => (
                            <div
                              key={`${row.label}:${row.value}`}
                              className="rounded-md border px-2.5 py-2"
                              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                            >
                              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                {formatNanoDlpMetaLabel(row.label)}
                              </div>
                              <div className="mt-1 text-[12px] font-semibold break-all" style={{ color: 'var(--text-strong)' }}>
                                {row.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {expandedNanodlpDetailRows.length > 0 && (
                        <div className="space-y-2">
                          {expandedNanodlpDetailRows.map((row) => (
                            <div
                              key={`${row.label}:${row.value}`}
                              className="rounded-md border px-2.5 py-2"
                              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                            >
                              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                {formatNanoDlpMetaLabel(row.label)}
                              </div>
                              <div className="mt-1 text-[12px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: 'var(--text-strong)' }}>
                                {row.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      No additional material details were provided by this NanoDLP profile.
                    </div>
                  )}
                </div>
              </div>

              <div className="px-3 py-2 border-t flex items-center justify-end gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  type="button"
                  onClick={() => setIsNanodlpDetailsDialogOpen(false)}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {showOfficialLockDialog && (
          <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowOfficialLockDialog(false);
              setOfficialLockedProfileId(null);
            }
          }}>
            <div className="w-full max-w-[520px] rounded-xl border shadow-2xl" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
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
          <div className="fixed inset-0 z-[76] flex items-center justify-center bg-black/60 p-4" onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setDeleteConfirmTarget(null);
            }
          }}>
            <div className="w-full max-w-[520px] rounded-xl border shadow-2xl" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
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
  value: string | number;
  onChange: (value: string) => void;
};

function LabeledInput({ label, value, onChange }: LabeledInputProps) {
  const [localValue, setLocalValue] = React.useState<string>(() => String(value));
  const [isFocused, setIsFocused] = React.useState(false);

  React.useEffect(() => {
    if (isFocused) return;
    setLocalValue(String(value));
  }, [value, isFocused]);

  return (
    <label className="space-y-1 block">
      <span className="ui-label font-medium">
        {label}
      </span>
      <input
        type="text"
        value={localValue}
        onChange={(event) => {
          const next = event.target.value;
          setLocalValue(next);
          onChange(next);
        }}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        className="ui-input w-full h-[34px] px-2.5 py-1.5 text-sm"
      />
    </label>
  );
}

type LabeledNumberInputProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
};

function LabeledNumberInput({ label, value, onChange }: LabeledNumberInputProps) {
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
      <span className="ui-label font-medium">
        {label}
      </span>
      <div className="relative">
        <input
          type="text"
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
          className="ui-input w-full h-[34px] pl-2.5 pr-6 py-1.5 text-sm no-spinners"
        />

        <div className="absolute inset-y-0 right-1 flex w-4 flex-col items-center justify-center gap-0.5">
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10"
            onClick={() => nudge(1)}
            tabIndex={-1}
            aria-label={`Increase ${label}`}
          >
            <ChevronUp className="h-2.5 w-2.5" />
          </button>
          <button
            type="button"
            className="inline-flex h-3 w-3 items-center justify-center rounded hover:bg-white/10"
            onClick={() => nudge(-1)}
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
