'use client';

import React from 'react';
import { AlertTriangle, Box, Check, ChevronDown, ChevronUp, Download, FlaskConical, ImagePlus, Lock, Plus, Printer, Search, Trash2, Upload, X } from 'lucide-react';
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

  React.useEffect(() => {
    if (!isOpen) return;

    setSelectedPrinterId(profileState.activePrinterProfileId);
    setSelectedManufacturer(null);
    setSelectedResinFamily(null);
    setIsMaterialEditorOpen(false);
    setIsEditingPrinter(false);
    setShowPresetPicker(false);
    setPresetSearch('');
    setSelectedPresetManufacturer('All');
    const materials = getMaterialProfilesForPrinter(profileState.activePrinterProfileId, profileState);
    setSelectedMaterialId(materials[0]?.id ?? null);
  }, [isOpen]);

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
                Profiles below are bound to <span style={{ color: 'var(--text-strong)' }}>{selectedPrinter.name}</span> and follow the selected printer hardware.
              </p>
            </div>

            <div className="p-3 flex flex-col gap-3 flex-1 min-h-0">
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
            <div className="w-full max-w-[1040px] max-h-[88vh] rounded-xl border shadow-2xl overflow-hidden" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
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

              <div className="grid grid-cols-[220px_minmax(0,1fr)] min-h-[540px] max-h-[calc(88vh-56px)]">
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
                        className="w-full rounded-md border px-2 py-1.5 text-left text-xs font-semibold"
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
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(164px,1fr))] gap-2.5">
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
                          <div className="h-[110px] rounded-md border overflow-hidden flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: '#2b3039' }}>
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

function AutoTrimmedImage({ src, alt, className }: AutoTrimmedImageProps) {
  const [displaySrc, setDisplaySrc] = React.useState(src);

  React.useEffect(() => {
    let cancelled = false;

    const process = async () => {
      try {
        const image = new Image();
        image.decoding = 'async';
        image.src = src;
        await image.decode();

        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) {
          if (!cancelled) setDisplaySrc(src);
          return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          if (!cancelled) setDisplaySrc(src);
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
          if (!cancelled) setDisplaySrc(src);
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
          if (!cancelled) setDisplaySrc(src);
          return;
        }

        const trimmedCanvas = document.createElement('canvas');
        trimmedCanvas.width = paddedWidth;
        trimmedCanvas.height = paddedHeight;
        const trimmedCtx = trimmedCanvas.getContext('2d');
        if (!trimmedCtx) {
          if (!cancelled) setDisplaySrc(src);
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
        if (!cancelled) setDisplaySrc(next);
      } catch {
        if (!cancelled) setDisplaySrc(src);
      }
    };

    setDisplaySrc(src);
    void process();

    return () => {
      cancelled = true;
    };
  }, [src]);

  return <img src={displaySrc} alt={alt} className={className} />;
}
