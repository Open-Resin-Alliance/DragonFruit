"use client";

import React, { useState } from 'react';
import { ViewTypeDropdown } from '@/components/controls/ViewTypeDropdown';
import { SettingsModal } from '@/components/settings/SettingsModal';
import { ProfileSettingsModal } from '@/components/settings/ProfileSettingsModal';
import type { SupportMode } from '@/supports/types';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';
import type { SelectionHighlightMode } from '@/components/selection';
import { Button } from '@/components/ui/primitives';
import { AlertTriangle, ChevronDown, FolderOpen, Lock, Maximize2, Minimize2, Power, Printer, Save, Square, X } from 'lucide-react';
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
  heatmapBlend: number;
  onHeatmapBlendChange: (value: number) => void;
  heatmapContrast: number;
  onHeatmapContrastChange: (value: number) => void;
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
  hasPrintingData: boolean;
  viewTypeOverride: MeshShaderType | null;
  onViewTypeOverrideChange: (value: MeshShaderType | null) => void;
  heatmapColors: string[];
  onHeatmapColorChange: (index: number, color: string) => void;
  isSlicingBusy?: boolean;
  onSaveScene?: () => void;
  onOpenScene?: () => void;
  onCloseProgram?: () => void;
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
  heatmapBlend,
  onHeatmapBlendChange,
  heatmapContrast,
  onHeatmapContrastChange,
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
  hasPrintingData,
  viewTypeOverride,
  onViewTypeOverrideChange,
  heatmapColors,
  onHeatmapColorChange,
  isSlicingBusy = false,
  onSaveScene,
  onOpenScene,
  onCloseProgram,
}: TopBarProps) {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [profileModalTab, setProfileModalTab] = useState<'printer' | 'material'>('printer');
  const [profileModalOpenPrinterLibraryToken, setProfileModalOpenPrinterLibraryToken] = useState(0);
  const [isDesktopWindow, setIsDesktopWindow] = useState(false);
  const [isDesktopWindowMaximized, setIsDesktopWindowMaximized] = useState(false);
  const [printerThumbnailFailed, setPrinterThumbnailFailed] = useState(false);
  const [windowMetrics, setWindowMetrics] = useState(() => ({
    innerWidth: 0,
    innerHeight: 0,
  }));
  const MIN_GOOD_WIDTH = 1920;
  const MIN_GOOD_HEIGHT = 1080;
  const showLayoutWarning =
    windowMetrics.innerWidth > 0
    && (windowMetrics.innerWidth < MIN_GOOD_WIDTH || windowMetrics.innerHeight < MIN_GOOD_HEIGHT);
  const layoutMetricsLabel =
    windowMetrics.innerWidth > 0
      ? `${windowMetrics.innerWidth}×${windowMetrics.innerHeight}`
      : 'detecting…';
  const layoutWarningTitle = `Layout tip: Current window ${layoutMetricsLabel}. For full panel comfort use ≥ ${MIN_GOOD_WIDTH}×${MIN_GOOD_HEIGHT} and maximize the app window.`;
  const topbarActionsDisabled = isSlicingBusy;
  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false);
  const [appMenuPosition, setAppMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const appMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);

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
    if (typeof window === 'undefined') return;

    let cancelled = false;

    const hydrateDesktopWindowState = async () => {
      const isLikelyDesktopRuntime =
        window.location.protocol === 'tauri:'
        || window.location.protocol === 'file:'
        || window.location.hostname === 'tauri.localhost'
        || typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';

      if (!isLikelyDesktopRuntime) {
        if (!cancelled) {
          setIsDesktopWindow(false);
        }
        return;
      }

      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        const maximized = await currentWindow.isMaximized();
        if (!cancelled) {
          setIsDesktopWindow(true);
          setIsDesktopWindowMaximized(maximized);
        }
      } catch {
        if (!cancelled) {
          setIsDesktopWindow(false);
        }
      }
    };

    void hydrateDesktopWindowState();

    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const updateMetrics = () => {
      setWindowMetrics({
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
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

  const handleDesktopWindowMinimize = React.useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().minimize();
    } catch {
      // no-op in web runtime or restricted capability mode
    }
  }, []);

  const handleDesktopWindowToggleMaximize = React.useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow();
      await currentWindow.toggleMaximize();
      const maximized = await currentWindow.isMaximized();
      setIsDesktopWindowMaximized(maximized);
    } catch {
      // no-op in web runtime or restricted capability mode
    }
  }, []);

  const handleDesktopWindowClose = React.useCallback(async () => {
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().close();
    } catch {
      // no-op in web runtime or restricted capability mode
    }
  }, []);

  const handleCloseProgram = React.useCallback(async () => {
    if (onCloseProgram) {
      onCloseProgram();
      return;
    }
    await handleDesktopWindowClose();
  }, [handleDesktopWindowClose, onCloseProgram]);

  const openAppMenu = React.useCallback(() => {
    const button = appMenuButtonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    setAppMenuPosition({ x: rect.left, y: rect.bottom + 6 });
    setIsAppMenuOpen(true);
  }, []);

  const closeAppMenu = React.useCallback(() => {
    setIsAppMenuOpen(false);
  }, []);

  React.useEffect(() => {
    if (!isAppMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      const appMenuNode = document.querySelector('[data-app-menu="true"]');
      const appMenuButtonNode = appMenuButtonRef.current;

      if (appMenuNode?.contains(target)) return;
      if (appMenuButtonNode?.contains(target)) return;
      closeAppMenu();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeAppMenu();
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [closeAppMenu, isAppMenuOpen]);

  const handleTopBarPointerDown = React.useCallback(async (event: React.MouseEvent<HTMLDivElement>) => {
    if (!isDesktopWindow) return;
    if (event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;
    const topbarRoot = event.currentTarget;
    const topbarRect = topbarRoot.getBoundingClientRect();

    // Guardrail: only allow drag starts from the visible topbar strip itself.
    // This prevents nested modals/menus rendered under TopBar from dragging the app window.
    if (
      event.clientX < topbarRect.left
      || event.clientX > topbarRect.right
      || event.clientY < topbarRect.top
      || event.clientY > topbarRect.bottom
    ) {
      return;
    }

    const interactiveSelector = [
      'button',
      'a',
      'input',
      'textarea',
      'select',
      '[role="button"]',
      '[data-no-window-drag="true"]',
    ].join(',');

    let node: HTMLElement | null = target;
    while (node && node !== topbarRoot) {
      if (node.matches(interactiveSelector)) return;
      node = node.parentElement;
    }

    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().startDragging();
    } catch {
      // no-op if not available in current runtime/capability
    }
  }, [isDesktopWindow]);

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
    setPrinterThumbnailFailed(false);
  }, [activePrinterProfile?.id, activePrinterProfile?.imageDataUrl]);

  const activePrinterThumbnailSrc = printerThumbnailFailed ? undefined : activePrinterProfile?.imageDataUrl;

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
    {
      mode: 'printing',
      label: 'Printing',
      step: 5,
      hint: 'Inspect sliced layers before printing',
      locked: !hasModels || !hasPrintingData,
    },
  ];

  return (
    <div
      className="ui-topbar fixed top-0 left-0 right-0 z-50 flex items-center relative"
      onMouseDownCapture={handleTopBarPointerDown}
    >
      <div
        className={`flex w-[430px] items-center gap-2.5 pl-0 pr-4 py-1.5 transition-opacity ${topbarActionsDisabled ? 'opacity-45 pointer-events-none' : ''}`}
        data-no-window-drag="true"
        aria-disabled={topbarActionsDisabled}
      >
        <button
          ref={appMenuButtonRef}
          type="button"
          disabled={topbarActionsDisabled}
          onClick={() => {
            if (isAppMenuOpen) {
              closeAppMenu();
            } else {
              openAppMenu();
            }
          }}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border transition-colors"
          style={{
            borderColor: 'var(--border-subtle)',
            background: isAppMenuOpen
              ? 'color-mix(in srgb, var(--accent), var(--surface-1) 84%)'
              : 'color-mix(in srgb, var(--surface-1), transparent 8%)',
          }}
          title="DragonFruit menu"
          aria-label="Open DragonFruit menu"
          data-no-window-drag="true"
        >
          <img
            src="/dragonfruit_assets/branding/simple_icon.svg"
            alt="DragonFruit"
            className="h-6 w-6 object-contain"
            draggable={false}
          />
        </button>

        <div
          className="h-6 w-px mx-0.5 shrink-0"
          style={{ background: 'color-mix(in srgb, var(--border-subtle), transparent 24%)' }}
          aria-hidden="true"
        />

        <button
          type="button"
          disabled={topbarActionsDisabled}
          onClick={() => {
            setProfileModalTab('printer');
            setIsProfileModalOpen(true);
          }}
          className="group inline-flex h-10 max-w-[300px] items-center gap-2 rounded-md px-2 transition-colors"
          style={{
            background: 'transparent',
          }}
          title={activePrinterProfile ? `Printer profile: ${activePrinterProfile.name}` : 'Select printer profile'}
          aria-label={activePrinterProfile ? `Printer profile ${activePrinterProfile.name}` : 'Select printer profile'}
          data-no-window-drag="true"
        >
          <div className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-sm shrink-0">
            {activePrinterThumbnailSrc ? (
              <img
                src={activePrinterThumbnailSrc}
                alt={activePrinterProfile?.name ?? 'Selected printer'}
                className="h-full w-full object-cover"
                draggable={false}
                onError={() => setPrinterThumbnailFailed(true)}
              />
            ) : (
              <Printer className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
            )}
          </div>
          <span className="min-w-0 flex flex-col items-start leading-none gap-[2px]">
            <span className="text-[9px] uppercase tracking-[0.11em]" style={{ color: 'var(--text-muted)' }}>
              Printer
            </span>
            <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>
              {activePrinterProfile?.name ?? 'Select Printer'}
            </span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 ml-auto shrink-0" style={{ color: 'color-mix(in srgb, var(--text-muted), white 8%)' }} />
        </button>
      </div>

      {isAppMenuOpen && appMenuPosition && (
        <div
          data-app-menu="true"
          className="fixed z-[120] w-44 rounded-lg border p-1.5 shadow-xl backdrop-blur-sm"
          style={{
            left: appMenuPosition.x,
            top: appMenuPosition.y,
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
          }}
          role="menu"
          aria-label="DragonFruit app menu"
        >
          <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            DragonFruit
          </div>
          <div className="space-y-0.5">
            <button
              type="button"
              onClick={() => {
                closeAppMenu();
                onSaveScene?.();
              }}
              disabled={topbarActionsDisabled || !onSaveScene}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
              style={{
                color: (topbarActionsDisabled || !onSaveScene) ? 'var(--text-muted)' : 'var(--text-strong)',
                opacity: (topbarActionsDisabled || !onSaveScene) ? 0.55 : 1,
              }}
              role="menuitem"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <Save className="h-3.5 w-3.5" />
              </span>
              <span>Save Scene</span>
            </button>

            <button
              type="button"
              onClick={() => {
                closeAppMenu();
                onOpenScene?.();
              }}
              disabled={topbarActionsDisabled || !onOpenScene}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
              style={{
                color: (topbarActionsDisabled || !onOpenScene) ? 'var(--text-muted)' : 'var(--text-strong)',
                opacity: (topbarActionsDisabled || !onOpenScene) ? 0.55 : 1,
              }}
              role="menuitem"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <FolderOpen className="h-3.5 w-3.5" />
              </span>
              <span>Open Scene…</span>
            </button>

            <button
              type="button"
              onClick={() => {
                closeAppMenu();
                void handleCloseProgram();
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
              style={{ color: 'var(--text-strong)' }}
              role="menuitem"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <Power className="h-3.5 w-3.5" />
              </span>
              <span>Close Program</span>
            </button>
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 flex justify-center px-2">
        <div
          className={`relative w-full max-w-[760px] transition-opacity ${topbarActionsDisabled ? 'opacity-45' : ''}`}
          aria-disabled={topbarActionsDisabled}
        >
          <div
            className="absolute left-6 right-6 top-1/2 -translate-y-1/2 h-px"
            style={{ background: 'color-mix(in srgb, var(--border-subtle), transparent 10%)' }}
          />

          <div className={`relative grid grid-cols-5 gap-2 ${topbarActionsDisabled ? 'pointer-events-none' : 'pointer-events-auto'}`}>
            {steps.map((item) => {
              const active = mode === item.mode;
              const locked = item.locked;
              const disabled = locked || topbarActionsDisabled;
              const printingLocked = item.mode === 'printing' && locked;

              return (
                <button
                  key={item.mode}
                  type="button"
                  onClick={() => {
                    if (disabled) return;
                    onModeChange(item.mode);
                  }}
                  disabled={disabled}
                  className={`group relative flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 transition-all duration-180 ${
                    active
                      ? 'shadow-[0_6px_16px_rgba(0,0,0,0.25)]'
                      : 'hover:-translate-y-[1px] hover:shadow-[0_6px_14px_rgba(0,0,0,0.18)]'
                  } ${disabled ? 'opacity-45 cursor-not-allowed hover:translate-y-0 hover:shadow-none' : ''} ${printingLocked ? 'grayscale saturate-0' : ''}`}
                  style={active
                    ? {
                      borderColor: 'color-mix(in srgb, var(--accent), white 8%)',
                      background: 'color-mix(in srgb, var(--accent), var(--surface-0) 84%)',
                    }
                    : {
                        borderColor: printingLocked
                          ? 'color-mix(in srgb, var(--border-subtle), black 30%)'
                          : 'var(--border-subtle)',
                        background: printingLocked
                          ? 'color-mix(in srgb, var(--surface-2), black 12%)'
                          : 'color-mix(in srgb, var(--surface-1), transparent 4%)',
                      }
                  }
                  title={topbarActionsDisabled
                    ? 'Slicing in progress. Topbar actions are temporarily disabled.'
                    : locked
                    ? (item.mode === 'printing'
                      ? 'Run slicing in Export to unlock Printing preview'
                      : 'Load a model in Prepare to unlock this stage')
                    : item.hint}
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

                  {printingLocked && (
                    <Lock className="h-3 w-3 ml-auto" style={{ color: 'var(--text-muted)' }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="ml-auto flex w-[320px] items-center justify-end gap-2 pr-2">
        <div className={`flex items-center gap-2 transition-opacity ${topbarActionsDisabled ? 'opacity-45 pointer-events-none' : ''}`}>
          {showLayoutWarning && (
            <div className="relative group" data-no-window-drag="true">
              <Button
                type="button"
                variant="secondary"
                className="!p-2"
                aria-label="Layout tip"
                data-no-window-drag="true"
              >
                <AlertTriangle
                  className="w-4 h-4"
                  style={{ color: 'color-mix(in srgb, #ff6b6b, white 8%)' }}
                />
              </Button>

              <div
                className="pointer-events-none absolute right-0 top-full mt-2 z-[70] w-[300px] rounded-md border px-2.5 py-2 text-[10px] leading-tight opacity-0 -translate-y-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-y-0"
                style={{
                  borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)',
                  background: 'color-mix(in srgb, var(--surface-0), black 10%)',
                  color: 'var(--text-muted)',
                  boxShadow: '0 10px 24px rgba(0,0,0,0.28)',
                }}
                role="tooltip"
                aria-hidden="true"
              >
                <div className="font-semibold mb-0.5" style={{ color: 'var(--text-strong)' }}>
                  Layout tip
                </div>
                <div>
                  Current window: {layoutMetricsLabel}. For full panel comfort use ≥ {MIN_GOOD_WIDTH}×{MIN_GOOD_HEIGHT} and maximize the app window.
                </div>
              </div>
            </div>
          )}
          <ViewTypeDropdown
            value={viewTypeOverride}
            onChange={onViewTypeOverrideChange}
            iconOnly
            title="View mode"
            className="[&>button]:!h-8 [&>button]:!w-8 [&>button]:!p-0"
          />
            <Button
              type="button"
              variant="secondary"
              className="!p-2"
            onClick={() => setIsSettingsOpen(true)}
            disabled={topbarActionsDisabled}
            title="Settings"
            aria-label="Settings"
              data-no-window-drag="true"
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
        {isDesktopWindow && (
          <div className="ml-1 flex items-center gap-1" aria-label="Window controls">
            <button
              type="button"
              onClick={handleDesktopWindowMinimize}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
              style={{
                borderColor: 'color-mix(in srgb, #f4bf4f, var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, #f4bf4f, transparent 86%)',
                color: 'color-mix(in srgb, #f4bf4f, white 16%)',
              }}
              title="Minimize"
              aria-label="Minimize window"
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleDesktopWindowToggleMaximize}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
              style={{
                borderColor: 'color-mix(in srgb, #40c463, var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, #40c463, transparent 86%)',
                color: 'color-mix(in srgb, #40c463, white 16%)',
              }}
              title={isDesktopWindowMaximized ? 'Restore' : 'Maximize'}
              aria-label={isDesktopWindowMaximized ? 'Restore window' : 'Maximize window'}
            >
              {isDesktopWindowMaximized ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={handleDesktopWindowClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors"
              style={{
                borderColor: 'color-mix(in srgb, #ff6b6b, var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, #ff6b6b, transparent 88%)',
                color: 'color-mix(in srgb, #ff6b6b, white 18%)',
              }}
              title="Close"
              aria-label="Close window"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
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
        heatmapBlend={heatmapBlend}
        onHeatmapBlendChange={onHeatmapBlendChange}
        heatmapContrast={heatmapContrast}
        onHeatmapContrastChange={onHeatmapContrastChange}
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
        heatmapColors={heatmapColors}
        onHeatmapColorChange={onHeatmapColorChange}
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
