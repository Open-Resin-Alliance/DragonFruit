"use client";

import React, { useState } from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { ViewTypeDropdown } from '@/components/controls/ViewTypeDropdown';
import { SettingsModal, type SettingsTabKey } from '@/components/settings/SettingsModal';
import { ProfileSettingsModal } from '@/components/settings/ProfileSettingsModal';
import type { SupportMode } from '@/supports/types';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';
import type { SelectionHighlightMode } from '@/components/selection';
import { Button } from '@/components/ui/primitives';
import { Activity, AlertTriangle, Anchor, ChevronDown, FolderInput, FolderOpen, Lock, Maximize2, Minimize2, Power, Printer, Save, Square, Upload, X } from 'lucide-react';
import {
  applyThemeCustomColors,
  getSavedThemeCustomColors,
  getSavedThemePreference,
} from '@/components/settings/themeCustomizations';
import {
  OPEN_PROFILE_SETTINGS_MODAL_EVENT,
  PROFILE_SETTINGS_MODAL_OPEN_CHANGE_EVENT,
  dispatchProfileSettingsModalOpenChange,
  type ProfileSettingsTab,
} from '@/components/settings/profileModalEvents';
import { OPEN_SETTINGS_ABOUT_EVENT } from '@/features/updater/updateNotificationEvents';
import {
  getActivePrinterProfile,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  hydrateProfilesFromStorage,
  selectPrinterNetworkDevice,
  subscribeToProfileStore,
} from '@/features/profiles/profileStore';

import type { View3DSettings } from '@/components/settings/view3dPreferences';
import type { SlicingThumbnailRenderSettings } from '@/components/settings/PerformanceSettingsTab';

interface TopBarProps {
  meshColor: string;
  onMeshColorChange: (color: string) => void;
  selectionColor: string;
  onSelectionColorChange: (color: string) => void;
  hoverColor: string;
  onHoverColorChange: (color: string) => void;
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
  slicingThumbnailRenderSettings: SlicingThumbnailRenderSettings;
  onSlicingThumbnailRenderSettingsChange: (settings: SlicingThumbnailRenderSettings) => void;
  // New: global application mode (prepare vs support)
  mode: SupportMode;
  onModeChange: (mode: SupportMode) => void;
  hasModels: boolean;
  hasPrintingData: boolean;
  viewTypeOverride: MeshShaderType | null;
  onViewTypeOverrideChange: (value: MeshShaderType | null) => void;
  interiorView: boolean;
  onInteriorViewChange: (value: boolean) => void;
  interiorViewAvailable?: boolean;
  heatmapColors: string[];
  onHeatmapColorChange: (index: number, color: string) => void;
  isSlicingBusy?: boolean;
  onSaveScene?: () => void;
  onOpenScene?: () => void;
  onLoadMeshChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onImportSceneChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onCloseProgram?: () => void;
  showMonitorButton?: boolean;
  monitorButtonActive?: boolean;
  monitorButtonPaused?: boolean;
  monitorButtonOffline?: boolean;
  printerReachabilityByDeviceId?: Record<string, boolean | null>;
  onOpenMonitor?: () => void;
  warnBeforeProfileSettingsOpen?: boolean;
}

export function TopBar({
  meshColor,
  onMeshColorChange,
  selectionColor,
  onSelectionColorChange,
  hoverColor,
  onHoverColorChange,
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
  slicingThumbnailRenderSettings,
  onSlicingThumbnailRenderSettingsChange,
  mode,
  onModeChange,
  hasModels,
  hasPrintingData,
  viewTypeOverride,
  onViewTypeOverrideChange,
  interiorView,
  onInteriorViewChange,
  interiorViewAvailable = true,
  heatmapColors,
  onHeatmapColorChange,
  isSlicingBusy = false,
  onLoadMeshChange,
  onImportSceneChange,
  onSaveScene,
  onOpenScene,
  onCloseProgram,
  showMonitorButton = false,
  monitorButtonActive = false,
  monitorButtonPaused = false,
  monitorButtonOffline = false,
  printerReachabilityByDeviceId,
  onOpenMonitor,
  warnBeforeProfileSettingsOpen = false,
}: TopBarProps) {
  const { _ } = useLingui();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTabKey>('general');
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [profileModalTab, setProfileModalTab] = useState<'printer' | 'material'>('printer');
  const [profileModalOpenPrinterLibraryToken, setProfileModalOpenPrinterLibraryToken] = useState(0);
  const [profileModalOpenNetworkSettingsToken, setProfileModalOpenNetworkSettingsToken] = useState(0);
  const [profileModalOpenMaterialAntiAliasingToken, setProfileModalOpenMaterialAntiAliasingToken] = useState(0);
  const [showProfileChangeWarning, setShowProfileChangeWarning] = useState(false);
  const [isDesktopWindow, setIsDesktopWindow] = useState(false);
  const [isDesktopWindowMaximized, setIsDesktopWindowMaximized] = useState(false);
  const [isLightTheme, setIsLightTheme] = useState(() => {
    if (typeof document === 'undefined') return false;
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light') return true;
    if (attr === 'dark') return false;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  });
  const [printerThumbnailFailed, setPrinterThumbnailFailed] = useState(false);
  const [windowMetrics, setWindowMetrics] = useState(() => ({
    innerWidth: 0,
    innerHeight: 0,
  }));
  const topbarActionsDisabled = isSlicingBusy;
  const [isAppMenuOpen, setIsAppMenuOpen] = useState(false);
  const [appMenuPosition, setAppMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [isPrinterQuickMenuOpen, setIsPrinterQuickMenuOpen] = useState(false);
  const [printerQuickMenuPosition, setPrinterQuickMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const appMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const printerQuickMenuButtonRef = React.useRef<HTMLButtonElement | null>(null);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const savedTheme = getSavedThemePreference();
    if (savedTheme === 'dark' || savedTheme === 'light') {
      document.documentElement.setAttribute('data-theme', savedTheme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }

    applyThemeCustomColors(getSavedThemeCustomColors());

    const updateLightTheme = () => {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'light') { setIsLightTheme(true); return; }
      if (attr === 'dark') { setIsLightTheme(false); return; }
      setIsLightTheme(window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false);
    };
    const themeObserver = new MutationObserver(updateLightTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    mq?.addEventListener('change', updateLightTheme);
    return () => { themeObserver.disconnect(); mq?.removeEventListener('change', updateLightTheme); };
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

  const openPrinterQuickMenu = React.useCallback(() => {
    const button = printerQuickMenuButtonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    setPrinterQuickMenuPosition({ x: rect.left, y: rect.bottom + 6 });
    setIsPrinterQuickMenuOpen(true);
  }, []);

  const closePrinterQuickMenu = React.useCallback(() => {
    setIsPrinterQuickMenuOpen(false);
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

  React.useEffect(() => {
    if (!isPrinterQuickMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      const quickMenuNode = document.querySelector('[data-printer-quick-menu="true"]');
      const quickMenuButtonNode = printerQuickMenuButtonRef.current;

      if (quickMenuNode?.contains(target)) return;
      if (quickMenuButtonNode?.contains(target)) return;
      closePrinterQuickMenu();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePrinterQuickMenu();
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [closePrinterQuickMenu, isPrinterQuickMenuOpen]);

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
      const customEvent = event as CustomEvent<{ tab?: ProfileSettingsTab; openPrinterLibrary?: boolean; openNetworkSettings?: boolean; openMaterialAntiAliasing?: boolean }>;
      const requestedTab = customEvent.detail?.tab;
      const shouldOpenPrinterLibrary = customEvent.detail?.openPrinterLibrary === true;
      const shouldOpenNetworkSettings = customEvent.detail?.openNetworkSettings === true;
      const shouldOpenMaterialAntiAliasing = customEvent.detail?.openMaterialAntiAliasing === true;
      if (requestedTab === 'printer' || requestedTab === 'material') {
        setProfileModalTab(requestedTab);
      } else {
        setProfileModalTab('printer');
      }

      if (shouldOpenPrinterLibrary) {
        setProfileModalOpenPrinterLibraryToken((prev) => prev + 1);
      }

      if (shouldOpenNetworkSettings) {
        setProfileModalOpenNetworkSettingsToken((prev) => prev + 1);
      }

      if (shouldOpenMaterialAntiAliasing) {
        setProfileModalOpenMaterialAntiAliasingToken((prev) => prev + 1);
      }

      setIsProfileModalOpen(true);
      dispatchProfileSettingsModalOpenChange(true);
    };

    window.addEventListener(OPEN_PROFILE_SETTINGS_MODAL_EVENT, handleOpenProfileModal as EventListener);
    return () => {
      window.removeEventListener(OPEN_PROFILE_SETTINGS_MODAL_EVENT, handleOpenProfileModal as EventListener);
    };
  }, []);

  // Listen for event to open Settings → About tab (from update notification).
  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOpenSettingsAbout = () => {
      setSettingsInitialTab('about');
      setIsSettingsOpen(true);
    };

    window.addEventListener(OPEN_SETTINGS_ABOUT_EVENT, handleOpenSettingsAbout);
    return () => {
      window.removeEventListener(OPEN_SETTINGS_ABOUT_EVENT, handleOpenSettingsAbout);
    };
  }, []);

  const profileState = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);
  const activePrinterProfile = React.useMemo(() => getActivePrinterProfile(profileState), [profileState]);


  React.useEffect(() => {
    setPrinterThumbnailFailed(false);
  }, [activePrinterProfile?.id, activePrinterProfile?.imageDataUrl]);

  const activePrinterThumbnailSrc = printerThumbnailFailed ? undefined : activePrinterProfile?.imageDataUrl;
  const topbarFleetPrinterName = React.useMemo(() => {
    const fleet = activePrinterProfile?.networkFleet ?? [];
    if (fleet.length === 0) return null;

    const preferred = fleet.find((device) => device.id === activePrinterProfile?.activeNetworkDeviceId)
      ?? fleet.find((device) => device.connected)
      ?? fleet[0]
      ?? null;
    if (!preferred) return null;

    return preferred.displayName || preferred.hostName || preferred.ipAddress || null;
  }, [activePrinterProfile?.activeNetworkDeviceId, activePrinterProfile?.networkFleet]);
  const topbarUsesFleetLabelOrder = React.useMemo(() => {
    return (activePrinterProfile?.networkFleet?.length ?? 0) > 1;
  }, [activePrinterProfile?.networkFleet]);
  const topbarPrinterLabelTop = React.useMemo(() => {
    if (topbarUsesFleetLabelOrder) {
      return activePrinterProfile?.name ?? 'Select Profile';
    }
    return 'Printer';
  }, [activePrinterProfile?.name, topbarUsesFleetLabelOrder]);
  const topbarPrinterLabelBottom = React.useMemo(() => {
    if (topbarUsesFleetLabelOrder) {
      return topbarFleetPrinterName ?? 'No active printer';
    }
    return activePrinterProfile?.name ?? 'Select Printer';
  }, [activePrinterProfile?.name, topbarFleetPrinterName, topbarUsesFleetLabelOrder]);
  const topbarPrinterButtonTitle = React.useMemo(() => {
    if (topbarUsesFleetLabelOrder) {
      const profileName = activePrinterProfile?.name ?? 'Select Profile';
      const printerName = topbarFleetPrinterName ?? 'No active printer';
      return `Printer profile: ${profileName} • Active printer: ${printerName}`;
    }
    return activePrinterProfile ? `Printer profile: ${activePrinterProfile.name}` : 'Select printer profile';
  }, [activePrinterProfile, topbarFleetPrinterName, topbarUsesFleetLabelOrder]);
  const topbarPrinterButtonAriaLabel = React.useMemo(() => {
    if (topbarUsesFleetLabelOrder) {
      const profileName = activePrinterProfile?.name ?? 'Select profile';
      const printerName = topbarFleetPrinterName ?? 'No active printer';
      return `Printer profile ${profileName}, active printer ${printerName}`;
    }
    return activePrinterProfile ? `Printer profile ${activePrinterProfile.name}` : 'Select printer profile';
  }, [activePrinterProfile, topbarFleetPrinterName, topbarUsesFleetLabelOrder]);
  const monitorButtonAnimationClass = monitorButtonPaused
    ? 'ui-topbar-monitor-paused'
    : (monitorButtonActive ? 'ui-topbar-monitor-active' : '');
  const monitorButtonLabel = monitorButtonOffline ? 'Offline' : 'Monitor';
  const monitorButtonTone = monitorButtonOffline
    ? '#f87171'
    : 'var(--text-strong)';

  const openProfileSettings = React.useCallback((tab: 'printer' | 'material' = 'printer') => {
    setProfileModalTab(tab);
    setIsProfileModalOpen(true);
    dispatchProfileSettingsModalOpenChange(true);
  }, []);

  const requestOpenProfileSettings = React.useCallback((tab: 'printer' | 'material' = 'printer') => {
    if (topbarActionsDisabled) return;
    if (warnBeforeProfileSettingsOpen) {
      setProfileModalTab(tab);
      setShowProfileChangeWarning(true);
      return;
    }
    openProfileSettings(tab);
  }, [openProfileSettings, topbarActionsDisabled, warnBeforeProfileSettingsOpen]);

  const topbarFleetUnits = React.useMemo(() => {
    const fleet = activePrinterProfile?.networkFleet ?? [];
    return fleet.filter((device) => (device.ipAddress || '').trim().length > 0);
  }, [activePrinterProfile?.networkFleet]);
  const hasTopbarFleetUnits = topbarFleetUnits.length > 1;

  const handleOpenPrinterManagerFromQuickMenu = React.useCallback(() => {
    closePrinterQuickMenu();
    requestOpenProfileSettings('printer');
  }, [closePrinterQuickMenu, requestOpenProfileSettings]);

  const handleSelectFleetUnitFromQuickMenu = React.useCallback((deviceId: string) => {
    if (!activePrinterProfile?.id) return;
    selectPrinterNetworkDevice(activePrinterProfile.id, deviceId);
    closePrinterQuickMenu();
  }, [activePrinterProfile?.id, closePrinterQuickMenu]);

  const stepsContainerRef = React.useRef<HTMLDivElement>(null);
  const [hideBadges, setHideBadges] = React.useState(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 800;
  });

  React.useEffect(() => {
    const el = stepsContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const gapPx = 4;
      const perButton = (entry.contentRect.width - 3 * gapPx) / 4;
      setHideBadges(perButton < 120);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const steps: Array<{
    mode: SupportMode;
    label: string;
    step: number;
    icon: React.ReactNode;
    hint: string;
    locked: boolean;
  }> = [
    {
      mode: 'prepare',
      label: _(msg`Prepare`),
      step: 1,
      icon: <FolderOpen className="h-3 w-3" strokeWidth={2.5} />,
      hint: _(msg`Arrange model and transforms`),
      locked: false,
    },
    {
      mode: 'support',
      label: _(msg`Support`),
      step: 2,
      icon: <Anchor className="h-3 w-3" strokeWidth={2.5} />,
      hint: _(msg`Build and tune supports`),
      locked: !hasModels,
    },
    {
      mode: 'export',
      label: _(msg`Export`),
      step: 3,
      icon: <Upload className="h-3 w-3" strokeWidth={2.5} />,
      hint: _(msg`Finalize and export output`),
      locked: !hasModels,
    },
    {
      mode: 'printing',
      label: _(msg`Printing`),
      step: 4,
      icon: <Printer className="h-3 w-3" strokeWidth={2.5} />,
      hint: _(msg`Inspect sliced layers before printing`),
      locked: !hasModels || !hasPrintingData,
    },
  ];

  return (
    <div
      className="ui-topbar fixed top-0 left-0 right-0 z-50 flex items-center relative"
      onMouseDownCapture={handleTopBarPointerDown}
    >
      <div
        className={`flex flex-1 max-w-[430px] items-center gap-2.5 pl-0 pr-4 py-1.5 transition-opacity ${topbarActionsDisabled ? 'opacity-45 pointer-events-none' : ''}`}
        data-no-window-drag="false"
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
          className="inline-flex h-10 w-10 items-center justify-center rounded-md transition-colors"
          style={{
            background: isAppMenuOpen
              ? 'color-mix(in srgb, var(--accent), transparent 80%)'
              : 'transparent',
          }}
          title="DragonFruit menu"
          aria-label="Open DragonFruit menu"
          data-no-window-drag="true"
        >
          <img
            src="/dragonfruit_assets/branding/simple_icon.svg"
            alt="DragonFruit"
            className="h-7 w-7 object-contain"
            draggable={false}
            style={isLightTheme ? { filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.35))' } : undefined}
          />
        </button>

        <div
          className="h-6 w-px mx-0.5 shrink-0"
          style={{ background: 'color-mix(in srgb, var(--border-subtle), transparent 24%)' }}
          aria-hidden="true"
        />

        <button
          ref={printerQuickMenuButtonRef}
          type="button"
          disabled={topbarActionsDisabled}
          onClick={() => {
            if (hasTopbarFleetUnits) {
              if (isPrinterQuickMenuOpen) {
                closePrinterQuickMenu();
              } else {
                openPrinterQuickMenu();
              }
              return;
            }
            requestOpenProfileSettings('printer');
          }}
          className="group inline-flex h-10 max-w-[300px] items-center gap-2 rounded-md px-2 transition-colors"
          style={{
            background: 'transparent',
          }}
          title={topbarPrinterButtonTitle}
          aria-label={topbarPrinterButtonAriaLabel}
          data-no-window-drag="true"
        >
          <div className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-sm shrink-0" style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 6%)', ...(hideBadges ? { display: 'none' } : {}) }}>
            {activePrinterThumbnailSrc ? (
              <img
                src={activePrinterThumbnailSrc}
                alt={activePrinterProfile?.name ?? 'Selected printer'}
                className="h-full w-full object-contain"
                draggable={false}
                onError={() => setPrinterThumbnailFailed(true)}
              />
            ) : (
              <Printer className="h-4 w-4" style={{ color: 'var(--text-muted)' }} />
            )}
          </div>
          <span className="min-w-0 flex flex-col items-start leading-none gap-[2px]">
            <span
              className={topbarUsesFleetLabelOrder
                ? 'truncate text-[10px] tracking-[0.01em]'
                : 'text-[9px] uppercase tracking-[0.11em]'}
              style={{ color: 'var(--text-muted)' }}
              title={topbarPrinterLabelTop}
            >
              {topbarPrinterLabelTop}
            </span>
            <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>
              {topbarPrinterLabelBottom}
            </span>
          </span>
          <ChevronDown className={`h-3.5 w-3.5 ml-auto shrink-0 transition-transform ${isPrinterQuickMenuOpen ? 'rotate-180' : ''}`} style={{ color: 'color-mix(in srgb, var(--text-muted), white 8%)' }} />
        </button>

        {showMonitorButton && (
          <button
            type="button"
            disabled={topbarActionsDisabled || !onOpenMonitor}
            onClick={() => onOpenMonitor?.()}
            className="group inline-flex h-10 items-center gap-1.5 rounded-md px-2 transition-colors"
            style={{
              background: 'transparent',
              color: monitorButtonTone,
            }}
            title={monitorButtonOffline ? 'Selected printer is offline' : 'Open printer monitor'}
            aria-label={monitorButtonOffline ? 'Selected printer is offline' : 'Open printer monitor'}
            data-no-window-drag="true"
          >
            <Activity
              className={`h-3.5 w-3.5 ${monitorButtonAnimationClass}`}
              style={{ color: monitorButtonTone }}
            />
            <span
              className={`text-[11px] font-semibold ${monitorButtonAnimationClass}`}
              style={{ color: monitorButtonTone }}
            >
              {monitorButtonLabel}
            </span>
          </button>
        )}
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
                if (typeof document === 'undefined') return;
                const input = document.getElementById('topbar-mesh-input') as HTMLInputElement | null;
                input?.click();
              }}
              disabled={topbarActionsDisabled || !onLoadMeshChange}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
              style={{
                color: (topbarActionsDisabled || !onLoadMeshChange) ? 'var(--text-muted)' : 'var(--text-strong)',
                opacity: (topbarActionsDisabled || !onLoadMeshChange) ? 0.55 : 1,
              }}
              role="menuitem"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <Upload className="h-3.5 w-3.5" />
              </span>
              <span>Import Mesh…</span>
            </button>

            <button
              type="button"
              onClick={() => {
                closeAppMenu();
                if (typeof document === 'undefined') return;
                const input = document.getElementById('topbar-scene-input') as HTMLInputElement | null;
                input?.click();
              }}
              disabled={topbarActionsDisabled || !onImportSceneChange}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium transition-colors"
              style={{
                color: (topbarActionsDisabled || !onImportSceneChange) ? 'var(--text-muted)' : 'var(--text-strong)',
                opacity: (topbarActionsDisabled || !onImportSceneChange) ? 0.55 : 1,
              }}
              role="menuitem"
            >
              <span className="inline-flex h-5 w-5 items-center justify-center rounded border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <FolderInput className="h-3.5 w-3.5" />
              </span>
              <span>Import Scene…</span>
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

      <input
        id="topbar-mesh-input"
        type="file"
        accept=".stl,.obj,.3mf,.zip"
        multiple
        onChange={onLoadMeshChange}
        className="hidden"
      />
      <input
        id="topbar-scene-input"
        type="file"
        accept=".voxl,.lys,.zip"
        onChange={onImportSceneChange}
        className="hidden"
      />

      {isPrinterQuickMenuOpen && printerQuickMenuPosition && hasTopbarFleetUnits && activePrinterProfile && (
        <div
          data-printer-quick-menu="true"
          className="fixed z-[121] w-[280px] rounded-lg border p-1.5 shadow-xl backdrop-blur-sm"
          style={{
            left: printerQuickMenuPosition.x,
            top: printerQuickMenuPosition.y,
            borderColor: 'var(--border-subtle)',
            background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
          }}
          role="menu"
          aria-label="Fleet quick switch"
        >
          <div className="mb-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Fleet Units
          </div>

          <div className="max-h-[260px] overflow-y-auto custom-scrollbar space-y-0.5">
            {topbarFleetUnits.map((device) => {
              const active = device.id === activePrinterProfile.activeNetworkDeviceId;
              const deviceName = device.displayName || device.hostName || device.ipAddress || `Printer ${device.id}`;
              const isOffline = printerReachabilityByDeviceId?.[device.id] === false;
              return (
                <button
                  key={device.id}
                  type="button"
                  onClick={() => {
                    if (isOffline) return;
                    handleSelectFleetUnitFromQuickMenu(device.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[12px] transition-colors"
                  style={isOffline
                    ? {
                      borderColor: 'color-mix(in srgb, var(--border-subtle), black 18%)',
                      background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                      opacity: 0.55,
                    }
                    : active
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
                  disabled={isOffline}
                  role="menuitem"
                  title={device.ipAddress || undefined}
                >
                  <span className="inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-sm shrink-0" style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}>
                    {activePrinterThumbnailSrc ? (
                      <img
                        src={activePrinterThumbnailSrc}
                        alt={activePrinterProfile?.name ?? deviceName}
                        className="h-full w-full object-contain"
                        draggable={false}
                        onError={() => setPrinterThumbnailFailed(true)}
                      />
                    ) : (
                      <Printer className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{deviceName}</span>
                    <span className="block truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {device.ipAddress || 'No IP'} • {isOffline ? 'Offline' : 'Online'}
                    </span>
                  </span>
                  {active && (
                    <span className="text-[10px] rounded-full border px-1.5 py-0.5" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)', color: 'var(--accent-secondary)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)' }}>
                      Active
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--border-subtle)' }}>
            <button
              type="button"
              onClick={handleOpenPrinterManagerFromQuickMenu}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] font-semibold transition-colors"
              style={{ color: 'var(--accent-secondary)' }}
              role="menuitem"
            >
              <ChevronDown className="h-3.5 w-3.5 rotate-[-90deg]" />
              Show Manager
            </button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 justify-center px-2">
        <div
          className={`relative w-full transition-opacity ${topbarActionsDisabled ? 'opacity-45' : ''}`}
          aria-disabled={topbarActionsDisabled}
        >
          <div ref={stepsContainerRef} className="flex items-center justify-center gap-1">
            {steps.map((item) => {
              const active = mode === item.mode;
              const locked = item.locked;
              const disabled = locked || topbarActionsDisabled;
              const nativeDisabled = disabled;
              const visuallyDimmed = topbarActionsDisabled || locked;
              const printingLocked = item.mode === 'printing' && locked;

              return (
                <button
                  key={item.mode}
                  type="button"
                  onClick={() => {
                    if (disabled) return;
                    onModeChange(item.mode);
                  }}
                  disabled={nativeDisabled}
                  aria-disabled={disabled}
                  className={`group relative flex cursor-pointer items-center gap-1.5 rounded-lg border px-1.5 py-2 transition-all duration-200 flex-1 min-w-[90px] max-w-[190px] h-[36px] ${
                    active
                      ? 'shadow-[0_6px_16px_rgba(0,0,0,0.25)]'
                      : 'hover:-translate-y-[1px] hover:shadow-[0_6px_14px_rgba(0,0,0,0.18)]'
                  } ${visuallyDimmed ? 'opacity-45' : ''} ${disabled ? 'cursor-not-allowed hover:translate-y-0 hover:shadow-none' : ''} ${printingLocked ? 'grayscale saturate-0' : ''}`}
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
                    style={{
                      ...(active
                        ? {
                          color: 'var(--accent)',
                          background: 'transparent',
                        }
                        : {
                          color: 'var(--text-muted)',
                          background: 'var(--surface-2)',
                        }),
                      ...(hideBadges ? { display: 'none' } : {}),
                    }}
                  >
                    {item.icon}
                  </span>

                  <span
                    className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap text-center text-xs font-bold leading-none tracking-[0.01em]"
                    style={{ color: active ? 'var(--text-strong)' : 'var(--text-strong)' }}
                  >
                    {item.label}
                  </span>

                  {printingLocked && !hideBadges && (
                    <Lock className="h-3 w-3 ml-auto flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
                  )}


                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-1 max-w-[430px] items-center justify-end gap-2 pr-2">
        <div className={`flex items-center gap-2 transition-opacity ${topbarActionsDisabled ? 'opacity-45 pointer-events-none' : ''}`}>
          <ViewTypeDropdown
            value={viewTypeOverride}
            onChange={onViewTypeOverrideChange}
            iconOnly
            title="View mode"
            className="[&>button]:!h-8 [&>button]:!w-8 [&>button]:!p-0"
          />
          <Button
            type="button"
            variant={interiorView ? 'primary' : 'secondary'}
            className="!p-2"
            onClick={() => onInteriorViewChange(!interiorView)}
            disabled={topbarActionsDisabled || !interiorViewAvailable}
            title={interiorView ? 'Interior View: On' : interiorViewAvailable ? 'Interior View: Off' : 'Interior View: Unavailable (apply hollowing first)'}
            aria-label={interiorView ? 'Interior View: On' : interiorViewAvailable ? 'Interior View: Off' : 'Interior View: Unavailable'}
            data-no-window-drag="true"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
              {/* Cube with inward-facing arrow to symbolize inner/backface viewing */}
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18M3.6 9l16.8 0M3.6 15l16.8 0" opacity="0.3" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 11l-2 2m2-2l2 2m-2-2v3" />
            </svg>
          </Button>
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
              style={isLightTheme ? {
                borderColor: 'color-mix(in srgb, #c8920a, var(--border-subtle) 35%)',
                background: 'color-mix(in srgb, #c8920a, var(--surface-1) 50%)',
                color: 'var(--text-strong)',
              } : {
                borderColor: 'color-mix(in srgb, #f4bf4f, var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, #f4bf4f, var(--surface-1) 86%)',
                color: 'color-mix(in srgb, #f4bf4f, var(--text-strong) 16%)',
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
              style={isLightTheme ? {
                borderColor: 'color-mix(in srgb, #1a7a3a, var(--border-subtle) 35%)',
                background: 'color-mix(in srgb, #1a7a3a, var(--surface-1) 50%)',
                color: 'var(--text-strong)',
              } : {
                borderColor: 'color-mix(in srgb, #40c463, var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, #40c463, var(--surface-1) 86%)',
                color: 'color-mix(in srgb, #40c463, var(--text-strong) 16%)',
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
              style={isLightTheme ? {
                borderColor: 'color-mix(in srgb, #c0160a, var(--border-subtle) 35%)',
                background: 'color-mix(in srgb, #c0160a, var(--surface-1) 50%)',
                color: 'var(--text-strong)',
              } : {
                borderColor: 'color-mix(in srgb, #ff6b6b, var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, #ff6b6b, var(--surface-1) 88%)',
                color: 'color-mix(in srgb, #ff6b6b, var(--text-strong) 18%)',
              }}
              title="Close"
              aria-label="Close window"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {showProfileChangeWarning && (
        <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3" data-no-window-drag="true">
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Changing printer profile requires re-slice"
          >
            <div className="flex items-start justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-start gap-2.5 pr-2">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: '#d97706',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Re-slice required after profile change
                  </h2>
                  <p className="mt-1 max-w-[40ch] text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Changing print settings invalidates the current sliced file.
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close warning"
                onClick={() => setShowProfileChangeWarning(false)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                You can continue to adjust profiles, but you’ll be prompted to re-slice before printing with the updated settings.
              </p>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                  onClick={() => setShowProfileChangeWarning(false)}
                >
                  Keep Current Profiles
                </button>
                <button
                  type="button"
                  className="ui-button !h-9 w-full px-3 text-xs"
                  style={{
                    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                    color: 'color-mix(in srgb, #f59e0b, var(--text-strong) 20%)',
                  }}
                  onClick={() => {
                    setShowProfileChangeWarning(false);
                    openProfileSettings(profileModalTab);
                  }}
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => { setIsSettingsOpen(false); setSettingsInitialTab('general'); }}
        initialTab={settingsInitialTab}
        meshColor={meshColor}
        onMeshColorChange={onMeshColorChange}
        selectionColor={selectionColor}
        onSelectionColorChange={onSelectionColorChange}
        hoverColor={hoverColor}
        onHoverColorChange={onHoverColorChange}
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
        slicingThumbnailRenderSettings={slicingThumbnailRenderSettings}
        onSlicingThumbnailRenderSettingsChange={onSlicingThumbnailRenderSettingsChange}
        activeOutputFormat={activePrinterProfile?.display.outputFormat ?? null}
        heatmapColors={heatmapColors}
        onHeatmapColorChange={onHeatmapColorChange}
      />

      <ProfileSettingsModal
        isOpen={isProfileModalOpen}
        onClose={() => { setIsProfileModalOpen(false); dispatchProfileSettingsModalOpenChange(false); }}
        initialTab={profileModalTab}
        openPrinterLibraryToken={profileModalOpenPrinterLibraryToken}
        openNetworkSettingsToken={profileModalOpenNetworkSettingsToken}
        openMaterialAntiAliasingToken={profileModalOpenMaterialAntiAliasingToken}
      />
    </div>
  );
}
