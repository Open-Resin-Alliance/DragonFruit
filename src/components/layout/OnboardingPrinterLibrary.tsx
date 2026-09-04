"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Check, ChevronLeft, ImagePlus, Plus, Printer, Search } from 'lucide-react';
import {
  addPrinterProfileFromPreset,
  getLibraryPrinterPresets,
  getPrinterPresetVariants,
  getProfileStoreServerSnapshot,
  getProfileStoreSnapshot,
  setActivePrinterProfile,
  subscribeToProfileStore,
  upsertPrinterNetworkDevice,
} from '@/features/profiles/profileStore';
import type { PrinterNetworkSupport, PrinterPreset, PrinterProfile } from '@/features/profiles/profileStore';
import {
  PrinterVariantPickerModal,
  type PrinterVariantPickerNetworkContext,
} from '@/components/printers/PrinterVariantPickerModal';

function resolveOfficialPresetIdFromProfile(profile: PrinterProfile): string | null {
  if (profile.officialPresetId && profile.officialPresetId.trim().length > 0) {
    return profile.officialPresetId.trim();
  }
  if (typeof profile.id === 'string' && profile.id.startsWith('printer-default-')) {
    return profile.id.slice('printer-default-'.length);
  }
  return null;
}

type OnboardingPrinterLibraryProps = {
  /** Called after a preset is added and activated — the wizard then closes. */
  onAdded: () => void;
  /** Collapses back to the theme step. */
  onBack: () => void;
};

// Mirrors the app's Printer Library modal layout: left manufacturer/search
// sidebar + right grouped preset grid, single-select for the onboarding flow.
export function OnboardingPrinterLibrary({ onAdded, onBack }: OnboardingPrinterLibraryProps) {
  const { _ } = useLingui();
  const presets = React.useMemo(() => getLibraryPrinterPresets(), []);
  const [search, setSearch] = React.useState('');
  const [selectedManufacturer, setSelectedManufacturer] = React.useState<string | null>(null);
  const [selectedPresetId, setSelectedPresetId] = React.useState<string | null>(null);
  const [variantChooserPreset, setVariantChooserPreset] = React.useState<PrinterPreset | null>(null);

  const profileState = React.useSyncExternalStore(
    subscribeToProfileStore,
    getProfileStoreSnapshot,
    getProfileStoreServerSnapshot,
  );
  const addedOfficialPresetIds = React.useMemo(() => {
    const ids = new Set<string>();
    profileState.printerProfiles.forEach((profile) => {
      const presetId = resolveOfficialPresetIdFromProfile(profile);
      if (presetId) ids.add(presetId);
    });
    return ids;
  }, [profileState.printerProfiles]);

  const variantChooserVariants = React.useMemo(
    () => (variantChooserPreset ? getPrinterPresetVariants(variantChooserPreset.presetId) : []),
    [variantChooserPreset],
  );

  const manufacturers = React.useMemo(() => {
    const uniq = new Set(presets.map((preset) => preset.manufacturer));
    const sorted = Array.from(uniq)
      .filter((m) => m.toLowerCase() !== 'generic')
      .sort((a, b) => a.localeCompare(b));
    const generic = Array.from(uniq).filter((m) => m.toLowerCase() === 'generic');
    return [...sorted, ...generic];
  }, [presets]);

  // Default to the first manufacturer once the list is known.
  React.useEffect(() => {
    if (selectedManufacturer === null && manufacturers.length > 0) {
      setSelectedManufacturer(manufacturers[0]);
    }
  }, [manufacturers, selectedManufacturer]);

  const filteredPresets = React.useMemo(() => {
    const term = search.trim().toLowerCase();
    return presets.filter((preset) => {
      const manufacturerMatch = term.length > 0 || preset.manufacturer === selectedManufacturer;
      const searchMatch =
        term.length === 0
        || preset.name.toLowerCase().includes(term)
        || preset.manufacturer.toLowerCase().includes(term)
        || (preset.family ?? '').toLowerCase().includes(term);
      return manufacturerMatch && searchMatch;
    });
  }, [presets, search, selectedManufacturer]);

  const isSearching = search.trim().length > 0;

  const groupedPresets = React.useMemo(() => {
    const grouped = new Map<string, PrinterPreset[]>();
    const familyOrder = new Map<string, number>();
    filteredPresets.forEach((preset) => {
      const family = (preset.family ?? '').trim() || 'Other';
      const current = grouped.get(family);
      if (current) {
        current.push(preset);
      } else {
        grouped.set(family, [preset]);
        familyOrder.set(family, familyOrder.size);
      }
    });
    return Array.from(grouped.entries())
      .sort(([a], [b]) => (familyOrder.get(a) ?? 999) - (familyOrder.get(b) ?? 999))
      .map(([family, groupPresets]) => ({ family, presets: groupPresets }));
  }, [filteredPresets]);

  const selectedPreset = selectedPresetId
    ? presets.find((preset) => preset.presetId === selectedPresetId) ?? null
    : null;

  const handleAdd = React.useCallback(() => {
    if (!selectedPresetId) return;
    const preset = presets.find((item) => item.presetId === selectedPresetId);
    // Presets with model variants OR a network detect path (e.g. Athena, which
    // relies on networking) go through the Initial Setup flow.
    if (preset?.modelVariants?.length || preset?.modelVariantDetectPath) {
      setVariantChooserPreset(preset);
      return;
    }
    const newProfileId = addPrinterProfileFromPreset(selectedPresetId);
    setActivePrinterProfile(newProfileId);
    onAdded();
  }, [presets, selectedPresetId, onAdded]);

  const handleSelectVariant = React.useCallback((
    variantPresetId: string,
    networkContext?: PrinterVariantPickerNetworkContext,
  ) => {
    const newProfileId = addPrinterProfileFromPreset(variantPresetId);
    if (networkContext) {
      // The dialog already verified connectivity, so persist the device as
      // connected so the printer is ready to go.
      const displayName = networkContext.printerName?.trim() || networkContext.host;
      upsertPrinterNetworkDevice(newProfileId, {
        ipAddress: networkContext.host,
        port: networkContext.port ?? 80,
        connected: true,
        mode: networkContext.mode as PrinterNetworkSupport | undefined,
        hostName: displayName,
        lastCheckedAt: new Date().toISOString(),
        statusText: 'Connected',
        displayName,
      }, { select: true });
    }
    setActivePrinterProfile(newProfileId);
    setVariantChooserPreset(null);
    onAdded();
  }, [onAdded]);

  const renderCard = (preset: PrinterPreset) => {
    const isSelected = selectedPresetId === preset.presetId;
    const isGenericPreset = preset.manufacturer.toLowerCase() === 'generic'
      || preset.name.toLowerCase().includes('generic');
    const platformBadge = preset.platformBadge?.text?.trim() ? preset.platformBadge : undefined;
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
        onClick={() => {
          // Match the printer library: variant families / network-detect presets
          // (e.g. Athena II) open Initial Setup on click instead of selecting.
          if (preset.modelVariants?.length || preset.modelVariantDetectPath) {
            setVariantChooserPreset(preset);
            return;
          }
          setSelectedPresetId(isSelected ? null : preset.presetId);
        }}
        className="rounded-lg border p-2.5 text-left transition-[background-color,box-shadow] duration-150"
        style={{
          borderColor: 'var(--border-subtle)',
          background: isSelected
            ? 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)'
            : 'var(--surface-1)',
          boxShadow: isSelected
            ? 'inset 0 0 0 1.5px color-mix(in srgb, var(--accent), transparent 40%)'
            : 'inset 0 0 0 0 transparent',
        }}
      >
        <div className="relative flex h-[132px] items-center justify-center overflow-hidden rounded-md border" style={{ borderColor: 'var(--border-subtle)', background: '#2b3039' }}>
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
              ? <Printer className="h-5 w-5" style={{ color: 'var(--text-muted)' }} />
              : <ImagePlus className="h-5 w-5" style={{ color: 'var(--text-muted)' }} />
          )}
          {isSelected && (
            <span
              className="pointer-events-none absolute left-1 top-1 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full"
              style={{ background: 'var(--accent)', color: '#0a0f0a' }}
            >
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
          )}
          {platformBadge && (
            <span
              className="pointer-events-none absolute right-1 top-1 z-10 inline-flex h-[18px] min-w-[44px] items-center justify-center whitespace-nowrap rounded-md px-1.5 text-[9px] font-bold leading-none"
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
        <div className="mt-2.5 min-w-0">
          <div className="truncate text-[12px] font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
            {preset.libraryDisplayName ?? preset.name}
          </div>
          <div className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-muted)' }}>
            {preset.manufacturer}
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div
        className="flex shrink-0 items-center justify-between border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}
      >
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
            title={_(msg`Back`)}
            aria-label={_(msg`Back to setup step`)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent-secondary), var(--surface-1) 84%), color-mix(in srgb, var(--accent), var(--surface-1) 90%))',
            }}
          >
            <Printer className="h-4 w-4" style={{ color: 'var(--accent-secondary)' }} />
          </span>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              {_(msg`Printer Library`)}
            </h3>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              {_(msg`Choose an official printer preset to add.`)}
            </p>
          </div>
        </div>
      </div>

      {/* Body: manufacturer/search sidebar + preset grid */}
      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] overflow-hidden">
        <div className="flex min-h-0 flex-col border-r" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
          <div className="border-b p-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={_(msg`Search printers`)}
                className="ui-input h-8 w-full text-xs"
                style={{ paddingLeft: '2.5rem', paddingRight: '0.625rem' }}
              />
            </div>
          </div>

          <div className="custom-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto p-1.5">
            {manufacturers.map((manufacturer) => (
              <button
                key={manufacturer}
                type="button"
                onClick={() => { setSelectedManufacturer(manufacturer); setSearch(''); }}
                className="w-full rounded-md border px-2.5 py-2 text-left text-sm font-semibold"
                style={selectedManufacturer === manufacturer
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

        <div className="custom-scrollbar min-h-0 overflow-y-auto p-3">
          {filteredPresets.length === 0 ? (
            <div className="flex h-full items-center justify-center text-xs" style={{ color: 'var(--text-muted)' }}>
              {_(msg`No printers match your search.`)}
            </div>
          ) : isSearching ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-2.5">
              {filteredPresets.map(renderCard)}
            </div>
          ) : (
            <div className="space-y-2">
              {groupedPresets.map((group) => (
                <section key={group.family}>
                  <div className="mb-2 flex items-center gap-3">
                    <div
                      className="h-px flex-1"
                      style={{
                        background: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--border-subtle), transparent 52%) 18%, color-mix(in srgb, var(--text-muted), white 28%) 100%)',
                      }}
                      aria-hidden="true"
                    />
                    <span className="shrink-0 text-sm font-semibold tracking-[0.08em]" style={{ color: 'var(--text-muted)' }}>
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
                    {group.presets.map(renderCard)}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div
        className="flex shrink-0 items-center justify-between gap-3 border-t px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}
      >
        <span className="text-[12px]" style={{ color: 'var(--text-muted)' }}>
          {selectedPreset ? (selectedPreset.libraryDisplayName ?? selectedPreset.name) : _(msg`Choose a printer to add`)}
        </span>
        <button
          type="button"
          onClick={selectedPreset ? handleAdd : undefined}
          aria-disabled={!selectedPreset}
          className="ui-button inline-flex items-center gap-1.5 !h-8 !px-3 !py-0 text-sm rounded-md"
          style={selectedPreset
            ? {
                background: 'var(--secondary-button-surface)',
                color: 'var(--accent-secondary-contrast)',
                borderColor: 'color-mix(in srgb, var(--secondary-button-surface), white 14%)',
              }
            : {
                background: 'var(--surface-1)',
                color: 'var(--text-muted)',
                borderColor: 'var(--border-subtle)',
              }}
        >
          <Plus className="h-3.5 w-3.5" />
          {_(msg`Add printer`)}
        </button>
      </div>

      {variantChooserPreset && (
        <PrinterVariantPickerModal
          preset={variantChooserPreset}
          variants={variantChooserVariants}
          addedPresetIds={addedOfficialPresetIds}
          onSelect={handleSelectVariant}
          onClose={() => setVariantChooserPreset(null)}
        />
      )}
    </div>
  );
}
