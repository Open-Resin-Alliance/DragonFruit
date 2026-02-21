"use client";

import React, { useState } from 'react';
import { ViewTypeDropdown } from '@/components/controls/ViewTypeDropdown';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { ProfileSettingsModal } from '@/components/settings/ProfileSettingsModal';
import type { SupportMode } from '@/supports/types';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';
import type { SelectionHighlightMode } from '@/components/selection';
import { Button } from '@/components/ui/primitives';
import { Printer } from 'lucide-react';
import {
  applyThemeCustomColors,
  getSavedThemeCustomColors,
  getSavedThemePreference,
} from '@/components/settings/themeCustomizations';
import {
  OPEN_PROFILE_SETTINGS_MODAL_EVENT,
  type ProfileSettingsTab,
} from '@/components/settings/profileModalEvents';
import {
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  hydrateProfilesFromStorage,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';
import type { View3DSettings } from '@/components/settings/view3dPreferences';

interface TopBarProps {
  meshColor: string;
  onMeshColorChange: (color: string) => void;
  shaderType: MeshShaderType;
  onShaderTypeChange: (shaderType: MeshShaderType) => void;
  matcapVariant: MatcapVariant;
  onMatcapVariantChange: (variant: MatcapVariant) => void;
  flatUseVertexColors: boolean;
  onFlatUseVertexColorsChange: (value: boolean) => void;
  toonSteps: number;
  onToonStepsChange: (value: number) => void;
  ambientIntensity: number;
  onAmbientIntensityChange: (value: number) => void;
  directionalIntensity: number;
  onDirectionalIntensityChange: (value: number) => void;
  materialRoughness: number;
  onMaterialRoughnessChange: (value: number) => void;
  xrayOpacity: number;
  onXrayOpacityChange: (value: number) => void;
  hoverTintStrength: number;
  onHoverTintStrengthChange: (value: number) => void;
  selectedTintStrength: number;
  onSelectedTintStrengthChange: (value: number) => void;
  selectionHighlightMode: SelectionHighlightMode;
  onSelectionHighlightModeChange: (mode: SelectionHighlightMode) => void;
  debugPrimitivesPanelVisible: boolean;
  onDebugPrimitivesPanelVisibleChange: (value: boolean) => void;
  view3dSettings: View3DSettings;
  onView3dSettingsChange: (settings: View3DSettings) => void;
  // New: global application mode (prepare vs support)
  mode: SupportMode;
  onModeChange: (mode: SupportMode) => void;
  hasModels: boolean;
  viewTypeOverride: MeshShaderType | null;
  onViewTypeOverrideChange: (value: MeshShaderType | null) => void;
}

export function TopBar({
  meshColor,
  onMeshColorChange,
  shaderType,
  onShaderTypeChange,
  matcapVariant,
  onMatcapVariantChange,
  flatUseVertexColors,
  onFlatUseVertexColorsChange,
  toonSteps,
  onToonStepsChange,
  ambientIntensity,
  onAmbientIntensityChange,
  directionalIntensity,
  onDirectionalIntensityChange,
  materialRoughness,
  onMaterialRoughnessChange,
  xrayOpacity,
  onXrayOpacityChange,
  hoverTintStrength,
  onHoverTintStrengthChange,
  selectedTintStrength,
  onSelectedTintStrengthChange,
  selectionHighlightMode,
  onSelectionHighlightModeChange,
  debugPrimitivesPanelVisible,
  onDebugPrimitivesPanelVisibleChange,
  view3dSettings,
  onView3dSettingsChange,
  mode,
  onModeChange,
  hasModels,
  viewTypeOverride,
  onViewTypeOverrideChange,
}: TopBarProps) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [profileModalTab, setProfileModalTab] = useState<'printer' | 'material'>('printer');
  const [profileModalOpenPrinterLibraryToken, setProfileModalOpenPrinterLibraryToken] = useState(0);
  const [windowMetrics, setWindowMetrics] = useState(() => ({
    innerWidth: 0,
    innerHeight: 0,
    screenAvailWidth: 0,
    screenAvailHeight: 0,
    isLikelyMaximized: true,
  }));

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const savedTheme = getSavedThemePreference();
    if (savedTheme === 'dark' || savedTheme === 'light') {
      document.documentElement.setAttribute('data-theme', savedTheme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }

    applyThemeCustomColors(getSavedThemeCustomColors());
  }, []);

  React.useEffect(() => {
    hydrateProfilesFromStorage();
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOpenProfileModal = (event: Event) => {
      const customEvent = event as CustomEvent<{ tab?: ProfileSettingsTab; openPrinterLibrary?: boolean }>;
      const requestedTab = customEvent.detail?.tab;
      const shouldOpenPrinterLibrary = customEvent.detail?.openPrinterLibrary === true;
      if (requestedTab === 'printer' || requestedTab === 'material') {
        setProfileModalTab(requestedTab);
      } else {
        setProfileModalTab('printer');
      }

      if (shouldOpenPrinterLibrary) {
        setProfileModalOpenPrinterLibraryToken((prev) => prev + 1);
      }

      setIsProfileModalOpen(true);
    };

    window.addEventListener(OPEN_PROFILE_SETTINGS_MODAL_EVENT, handleOpenProfileModal as EventListener);
    return () => {
      window.removeEventListener(OPEN_PROFILE_SETTINGS_MODAL_EVENT, handleOpenProfileModal as EventListener);
    };
  }, []);

  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateMetrics = () => {
      const innerWidth = window.innerWidth;
      const innerHeight = window.innerHeight;
      const screenAvailWidth = window.screen?.availWidth ?? innerWidth;
      const screenAvailHeight = window.screen?.availHeight ?? innerHeight;

      const widthGap = Math.abs(screenAvailWidth - innerWidth);
      const heightGap = Math.abs(screenAvailHeight - innerHeight);
      const isLikelyMaximized = widthGap <= 24 && heightGap <= 96;

      setWindowMetrics({
        innerWidth,
        innerHeight,
        screenAvailWidth,
        screenAvailHeight,
        isLikelyMaximized,
      });
    };

    updateMetrics();
    window.addEventListener('resize', updateMetrics);
    window.addEventListener('orientationchange', updateMetrics);

    return () => {
      window.removeEventListener('resize', updateMetrics);
      window.removeEventListener('orientationchange', updateMetrics);
    };
  }, []);

  const MIN_GOOD_WIDTH = 1920;
  const MIN_GOOD_HEIGHT = 1080;
  const isUnderRecommendedViewport =
    windowMetrics.innerWidth > 0 &&
    (windowMetrics.innerWidth < MIN_GOOD_WIDTH || windowMetrics.innerHeight < MIN_GOOD_HEIGHT);
  const showLayoutWarning = isUnderRecommendedViewport;

  const metricsLabel =
    windowMetrics.innerWidth > 0
      ? `${windowMetrics.innerWidth}×${windowMetrics.innerHeight}`
      : 'detecting…';

  const steps: Array<{
    mode: SupportMode;
    label: string;
    step: number;
    hint: string;
    locked: boolean;
  }> = [
    {
      mode: 'prepare',
      label: 'Prepare',
      step: 1,
      hint: 'Arrange model and transforms',
      locked: false,
    },
    {
      mode: 'analysis',
      label: 'Analysis',
      step: 2,
      hint: 'Inspect islands and diagnostics',
      locked: !hasModels,
    },
    {
      mode: 'support',
      label: 'Support',
      step: 3,
      hint: 'Build and tune supports',
      locked: !hasModels,
    },
    {
      mode: 'export',
      label: 'Export',
      step: 4,
      hint: 'Finalize and export output',
      locked: !hasModels,
    },
  ];

  return (
    <div className="ui-topbar fixed top-0 left-0 right-0 z-50 flex items-center relative">
      <div className="flex w-[280px] items-center gap-2.5 pl-2 pr-4 py-1.5">
        <img
          src="/textonlyupdate.png"
          alt="Dragonfruit Slicer"
          className="h-8 w-auto object-contain translate-y-px"
        />
      </div>

      <div className="pointer-events-none absolute inset-x-0 flex justify-center px-2">
        <div className="relative w-full max-w-[760px]">
          <div
            className="absolute left-6 right-6 top-1/2 -translate-y-1/2 h-px"
            style={{ background: 'color-mix(in srgb, var(--border-subtle), transparent 10%)' }}
          />

          <div className="relative grid grid-cols-4 gap-2 pointer-events-auto">
            {steps.map((item) => {
              const active = mode === item.mode;
              const locked = item.locked;

              return (
                <button
                  key={item.mode}
                  type="button"
                  onClick={() => {
                    if (locked) return;
                    onModeChange(item.mode);
                  }}
                  disabled={locked}
                  className={`group relative flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 transition-all duration-180 ${
                    active
                      ? 'shadow-[0_6px_16px_rgba(0,0,0,0.25)]'
                      : 'hover:-translate-y-[1px] hover:shadow-[0_6px_14px_rgba(0,0,0,0.18)]'
                  } ${locked ? 'opacity-45 cursor-not-allowed hover:translate-y-0 hover:shadow-none' : ''}`}
                  style={active
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), white 8%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 84%)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'color-mix(in srgb, var(--surface-1), transparent 4%)',
                      }
                  }
                  title={locked ? 'Load a model in Prepare to unlock this stage' : item.hint}
                >
                  <span
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold"
                    style={active
                      ? {
                          color: 'var(--accent-contrast)',
                          background: 'color-mix(in srgb, var(--accent), white 10%)',
                        }
                      : {
                          color: 'var(--text-muted)',
                          background: 'var(--surface-2)',
                        }
                    }
                  >
                    {item.step}
                  </span>

                  <span
                    className="text-xs font-bold leading-none tracking-[0.01em]"
                    style={{ color: active ? 'var(--accent-contrast)' : 'var(--text-strong)' }}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="ml-auto flex w-[420px] items-center justify-end gap-2">
        {showLayoutWarning && (
          <div
            className="pointer-events-none hidden md:flex items-center rounded-md border px-2 py-1 text-[10px] leading-tight"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
              color: 'var(--text-muted)',
            }}
            title={`Current window: ${metricsLabel}. Recommended for full panel comfort: >= ${MIN_GOOD_WIDTH}x${MIN_GOOD_HEIGHT} and maximized.`}
          >
            <span className="font-semibold mr-1" style={{ color: 'var(--text-strong)' }}>Layout tip:</span>
            <span>{metricsLabel} • for best fit use ≥ {MIN_GOOD_WIDTH}×{MIN_GOOD_HEIGHT} maximized</span>
          </div>
        )}
        <Button
          onClick={() => {
            setProfileModalTab('printer');
            setIsProfileModalOpen(true);
          }}
          variant="secondary"
          className="!h-8 !px-2.5 !py-0 max-w-[200px] inline-flex items-center gap-1.5"
          title={activePrinterProfile ? `Printer profile: ${activePrinterProfile.name}` : 'Select printer profile'}
          aria-label={activePrinterProfile ? `Printer profile ${activePrinterProfile.name}` : 'Select printer profile'}
        >
          <Printer className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate text-[11px] font-semibold leading-none">
            {activePrinterProfile?.name ?? 'Select Printer'}
          </span>
        </Button>
        <ViewTypeDropdown
          value={viewTypeOverride}
          onChange={onViewTypeOverrideChange}
          iconOnly
          title="Camera view mode"
        />
        <Button
          onClick={() => setIsSettingsOpen(true)}
          variant="secondary"
          className="!p-2"
          title="Settings"
          aria-label="Settings"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </Button>
      </div>

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        meshColor={meshColor}
        onMeshColorChange={onMeshColorChange}
        shaderType={shaderType}
        onShaderTypeChange={onShaderTypeChange}
        matcapVariant={matcapVariant}
        onMatcapVariantChange={onMatcapVariantChange}
        flatUseVertexColors={flatUseVertexColors}
        onFlatUseVertexColorsChange={onFlatUseVertexColorsChange}
        toonSteps={toonSteps}
        onToonStepsChange={onToonStepsChange}
        ambientIntensity={ambientIntensity}
        onAmbientIntensityChange={onAmbientIntensityChange}
        directionalIntensity={directionalIntensity}
        onDirectionalIntensityChange={onDirectionalIntensityChange}
        materialRoughness={materialRoughness}
        onMaterialRoughnessChange={onMaterialRoughnessChange}
        xrayOpacity={xrayOpacity}
        onXrayOpacityChange={onXrayOpacityChange}
        hoverTintStrength={hoverTintStrength}
        onHoverTintStrengthChange={onHoverTintStrengthChange}
        selectedTintStrength={selectedTintStrength}
        onSelectedTintStrengthChange={onSelectedTintStrengthChange}
        selectionHighlightMode={selectionHighlightMode}
        onSelectionHighlightModeChange={onSelectionHighlightModeChange}
        debugPrimitivesPanelVisible={debugPrimitivesPanelVisible}
        onDebugPrimitivesPanelVisibleChange={onDebugPrimitivesPanelVisibleChange}
        view3dSettings={view3dSettings}
        onView3dSettingsChange={onView3dSettingsChange}
      />

      <ProfileSettingsModal
        isOpen={isProfileModalOpen}
        onClose={() => setIsProfileModalOpen(false)}
        initialTab={profileModalTab}
        openPrinterLibraryToken={profileModalOpenPrinterLibraryToken}
      />
    </div>
  );
}
