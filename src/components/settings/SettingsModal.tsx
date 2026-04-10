'use client';

import React, { useEffect, useState } from 'react';
import { GeneralSettingsTab } from '@/components/settings/GeneralSettingsTab';
import { CameraSettingsTab } from '@/components/settings/CameraSettingsTab';
import { HotkeysSettingsTab } from '@/components/settings/HotkeysSettingsTab';
import { MeshSettingsTab } from '@/components/settings/MeshSettingsTab';
import { PluginsSettingsTab } from '@/components/settings/PluginsSettingsTab';
import { LocalBackupsSettingsTab } from '@/components/settings/LocalBackupsSettingsTab';
import { SceneAutosaveSettingsTab } from '@/components/settings/SceneAutosaveSettingsTab';
import { LoggingSettingsTab, getSavedLogLevel, saveLogLevel, type LogLevelFilter } from '@/components/settings/LoggingSettingsTab';
import { SpaceMouseSettingsTab } from '@/components/settings/SpaceMouseSettingsTab';
import { UISettingsTab } from '@/components/settings/UISettingsTab';
import { WorkspacesSettingsTab } from '@/components/settings/WorkspacesSettingsTab';
import { PerformanceSettingsTab } from '@/components/settings/PerformanceSettingsTab';
import { Check, ExternalLink, Gamepad2, Github, HardDrive, Info, Keyboard, MonitorCog, Palette, Plug, RotateCcw, Settings2, X, Camera, Grid3x3, ArchiveRestore, ScrollText } from 'lucide-react';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';
import {
  applyThemeCustomColors,
  applyThemePreference,
  DEFAULT_THEME_CUSTOM_COLORS,
  getSavedThemeCustomColors,
  getSavedThemePreset,
  getSavedThemePreference,
  THEME_COLORS_STORAGE_KEY,
  THEME_PRESET_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ThemePreset,
  type ThemeCustomColors,
} from '@/components/settings/themeCustomizations';
import {
  DEFAULT_SPACEMOUSE_SETTINGS,
  getSavedSpaceMouseSettings,
  saveSpaceMouseSettings,
  type SpaceMouseSettings,
  normalizeSpaceMouseSettings,
} from '@/components/settings/spacemousePreferences';
import {
  DEFAULT_CAMERA_PROJECTION_SETTINGS,
  getSavedCameraProjectionSettings,
  saveCameraProjectionSettings,
  type CameraProjectionMode,
} from '@/components/settings/cameraProjectionPreferences';
import {
  DEFAULT_CAMERA_FEEL_SETTINGS,
  getSavedCameraFeelSettings,
  saveCameraFeelSettings,
  type CameraFeelPreset,
} from '@/components/settings/cameraFeelPreferences';
import {
  DEFAULT_WORKSPACE_CAMERA_SETTINGS,
  getSavedWorkspaceCameraSettings,
  saveWorkspaceCameraSettings,
  type CameraScopeMode,
  type WorkspaceCameraDefaults,
} from '@/components/settings/workspaceCameraPreferences';
import {
  DEFAULT_VIEW3D_SETTINGS,
  getSavedView3DSettings,
  normalizeView3DSettings,
  saveView3DSettings,
  type View3DSettings,
} from '@/components/settings/view3dPreferences';
import {
  DEFAULT_SLICING_PERFORMANCE_SETTINGS,
  getSavedSlicingPerformanceSettings,
  saveSlicingPerformanceSettings,
  type SlicingPerformanceSettings,
} from '@/components/settings/performancePreferences';
import { outputFormatUsesPngLayers } from '@/features/slicing/formats/registry';
import type { SelectionHighlightMode } from '@/components/selection';
import {
  clearSavedFloatingLayout,
  isDebugPrimitivesPanelVisibleEnabled,
  isFloatingLayoutPersistenceEnabled,
  setDebugPrimitivesPanelVisibleEnabled,
  setFloatingLayoutPersistenceEnabled,
} from '@/components/layout/floatingLayoutPreferences';

const DEFAULT_MESH_COLOR = '#a3a3a3';
const DEFAULT_AMBIENT_INTENSITY = 0.6;
const DEFAULT_DIRECTIONAL_INTENSITY = 0.8;
const DEFAULT_MATERIAL_ROUGHNESS = 0.65;
const DEFAULT_XRAY_OPACITY = 0.25;
const DEFAULT_SHADER_TYPE: MeshShaderType = 'soft_clay';
const DEFAULT_MATCAP_VARIANT: MatcapVariant = 'neutral';
const DEFAULT_FLAT_USE_VERTEX_COLORS = true;
const DEFAULT_TOON_STEPS = 5;
const DEFAULT_HOVER_TINT_STRENGTH = 0.5;
const DEFAULT_SELECTED_TINT_STRENGTH = 0.75;
const DRAGONFRUIT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0';
const DRAGONFRUIT_BUILD_CHANNEL = (process.env.NEXT_PUBLIC_BUILD_CHANNEL ?? 'mainline').trim().toLowerCase();
const ORA_LOGO_DARK_URL = 'https://raw.githubusercontent.com/Open-Resin-Alliance/Orion/athena_public_beta/assets/images/ora/open_resin_alliance_logo_darkmode.png';
const DRAGONFRUIT_REPO_URL = 'https://github.com/Open-Resin-Alliance/DragonFruit';

type SettingsModalProps = {
  isOpen: boolean;
  onClose: () => void;
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
  heatmapBlend: number;
  heatmapContrast: number;
  onXrayOpacityChange: (value: number) => void;
  onHeatmapBlendChange: (value: number) => void;
  onHeatmapContrastChange: (value: number) => void;
  heatmapColors: string[];
  onHeatmapColorChange: (index: number, color: string) => void;
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
  activeOutputFormat?: string | null;
};

type SettingsTabKey = 'general' | 'camera' | 'workspaces' | 'mesh' | 'performance' | 'spacemouse' | 'plugins' | 'sceneAutosave' | 'backups' | 'ui' | 'hotkeys' | 'logging' | 'about';
type SettingsTabTone = 'primary' | 'secondary';

export function SettingsModal({
  isOpen,
  onClose,
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
  heatmapBlend,
  heatmapContrast,
  onXrayOpacityChange,
  onHeatmapBlendChange,
  onHeatmapContrastChange,
  heatmapColors,
  onHeatmapColorChange,
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
  activeOutputFormat,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabKey>('general');

  const [draftMeshColor, setDraftMeshColor] = useState(meshColor);
  const [draftShaderType, setDraftShaderType] = useState(shaderType);
  const [draftMatcapVariant, setDraftMatcapVariant] = useState(matcapVariant);
  const [draftFlatUseVertexColors, setDraftFlatUseVertexColors] = useState(flatUseVertexColors);
  const [draftToonSteps, setDraftToonSteps] = useState(toonSteps);
  const [draftAmbientIntensity, setDraftAmbientIntensity] = useState(ambientIntensity);
  const [draftDirectionalIntensity, setDraftDirectionalIntensity] = useState(directionalIntensity);
  const [draftMaterialRoughness, setDraftMaterialRoughness] = useState(materialRoughness);
  const [draftXrayOpacity, setDraftXrayOpacity] = useState(xrayOpacity);
  const [draftHeatmapBlend, setDraftHeatmapBlend] = useState(heatmapBlend);
  const [draftHeatmapContrast, setDraftHeatmapContrast] = useState(heatmapContrast);
  const [draftHeatmapColors, setDraftHeatmapColors] = useState(heatmapColors);
  const [draftHoverTintStrength, setDraftHoverTintStrength] = useState(hoverTintStrength);
  const [draftSelectedTintStrength, setDraftSelectedTintStrength] = useState(selectedTintStrength);
  const [draftSelectionHighlightMode, setDraftSelectionHighlightMode] = useState(selectionHighlightMode);
  const [draftSelectionColor, setDraftSelectionColor] = useState(selectionColor);
  const [draftHoverColor, setDraftHoverColor] = useState(hoverColor);
  const [draftCameraProjectionMode, setDraftCameraProjectionMode] = useState<CameraProjectionMode>(() => getSavedCameraProjectionSettings().mode);
  const [draftCameraFeelPreset, setDraftCameraFeelPreset] = useState<CameraFeelPreset>(() => getSavedCameraFeelSettings().preset);
  const [draftCameraScope, setDraftCameraScope] = useState<CameraScopeMode>(() => getSavedWorkspaceCameraSettings().scope);
  const [draftThemePreference, setDraftThemePreference] = useState(getSavedThemePreference());
  const [draftThemePreset, setDraftThemePreset] = useState<ThemePreset>(getSavedThemePreset());
  const [draftThemeColors, setDraftThemeColors] = useState<ThemeCustomColors>(getSavedThemeCustomColors());
  const [draftFloatingLayoutPersistence, setDraftFloatingLayoutPersistence] = useState<boolean>(() => isFloatingLayoutPersistenceEnabled());
  const [draftDebugPrimitivesPanelVisible, setDraftDebugPrimitivesPanelVisible] = useState<boolean>(() => debugPrimitivesPanelVisible);
  const [draftSpaceMouseSettings, setDraftSpaceMouseSettings] = useState<SpaceMouseSettings>(() => getSavedSpaceMouseSettings());
  const [draftWorkspaceCameraDefaults, setDraftWorkspaceCameraDefaults] = useState<WorkspaceCameraDefaults>(() => getSavedWorkspaceCameraSettings().defaults);
  const [draftView3dSettings, setDraftView3dSettings] = useState<View3DSettings>(() => view3dSettings ?? getSavedView3DSettings());
  const [draftSlicingPerformanceSettings, setDraftSlicingPerformanceSettings] = useState<SlicingPerformanceSettings>(() => getSavedSlicingPerformanceSettings());
  const [draftLogLevel, setDraftLogLevel] = useState<LogLevelFilter>(() => getSavedLogLevel());
  const [showRestoreDefaultsConfirm, setShowRestoreDefaultsConfirm] = useState(false);
  const showPngCompressionControls = outputFormatUsesPngLayers(activeOutputFormat ?? undefined);

  const resetDraftFromProps = React.useCallback(() => {
    setDraftMeshColor(meshColor);
    setDraftShaderType(shaderType);
    setDraftMatcapVariant(matcapVariant);
    setDraftFlatUseVertexColors(flatUseVertexColors);
    setDraftToonSteps(toonSteps);
    setDraftAmbientIntensity(ambientIntensity);
    setDraftDirectionalIntensity(directionalIntensity);
    setDraftMaterialRoughness(materialRoughness);
    setDraftXrayOpacity(xrayOpacity);
    setDraftHeatmapBlend(heatmapBlend);
    setDraftHeatmapContrast(heatmapContrast);
    setDraftHeatmapColors(heatmapColors);
    setDraftHoverTintStrength(hoverTintStrength);
    setDraftSelectedTintStrength(selectedTintStrength);
    setDraftSelectionHighlightMode(selectionHighlightMode);
    setDraftSelectionColor(selectionColor);
    setDraftHoverColor(hoverColor);
    setDraftCameraProjectionMode(getSavedCameraProjectionSettings().mode);
    setDraftCameraFeelPreset(getSavedCameraFeelSettings().preset);
    setDraftCameraScope(getSavedWorkspaceCameraSettings().scope);
    setDraftThemePreference(getSavedThemePreference());
    setDraftThemePreset(getSavedThemePreset());
    setDraftThemeColors(getSavedThemeCustomColors());
    setDraftFloatingLayoutPersistence(isFloatingLayoutPersistenceEnabled());
    setDraftDebugPrimitivesPanelVisible(isDebugPrimitivesPanelVisibleEnabled());
    setDraftSpaceMouseSettings(getSavedSpaceMouseSettings());
    setDraftWorkspaceCameraDefaults(getSavedWorkspaceCameraSettings().defaults);
    setDraftView3dSettings(view3dSettings ?? getSavedView3DSettings());
    setDraftSlicingPerformanceSettings(getSavedSlicingPerformanceSettings());
    setDraftLogLevel(getSavedLogLevel());
  }, [
    ambientIntensity,
    directionalIntensity,
    flatUseVertexColors,
    toonSteps,
    matcapVariant,
    materialRoughness,
    heatmapColors,
    hoverTintStrength,
    selectedTintStrength,
    selectionHighlightMode,
    selectionColor,
    hoverColor,
    debugPrimitivesPanelVisible,
    view3dSettings,
    shaderType,
    xrayOpacity,
    heatmapBlend,
    heatmapContrast,
    heatmapColors,
  ]);

  const handleThemeColorChange = React.useCallback((key: keyof ThemeCustomColors, value: string) => {
    setDraftThemeColors((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);

  const handleDraftHeatmapColorChange = React.useCallback((index: number, color: string) => {
    setDraftHeatmapColors((prev) => {
      const copy = [...prev];
      copy[index] = color;
      return copy;
    });
  }, []);

  const handleResetThemeColors = React.useCallback(() => {
    setDraftThemePreference('system');
    setDraftThemeColors(DEFAULT_THEME_CUSTOM_COLORS);
  }, []);

  const handleCancel = React.useCallback(() => {
    setShowRestoreDefaultsConfirm(false);
    resetDraftFromProps();
    onClose();
  }, [onClose, resetDraftFromProps]);

  const applyRestoreDefaultsToDraft = React.useCallback(() => {
    setDraftMeshColor(DEFAULT_MESH_COLOR);
    setDraftShaderType(DEFAULT_SHADER_TYPE);
    setDraftMatcapVariant(DEFAULT_MATCAP_VARIANT);
    setDraftFlatUseVertexColors(DEFAULT_FLAT_USE_VERTEX_COLORS);
    setDraftToonSteps(DEFAULT_TOON_STEPS);
    setDraftAmbientIntensity(DEFAULT_AMBIENT_INTENSITY);
    setDraftDirectionalIntensity(DEFAULT_DIRECTIONAL_INTENSITY);
    setDraftMaterialRoughness(DEFAULT_MATERIAL_ROUGHNESS);
    setDraftXrayOpacity(DEFAULT_XRAY_OPACITY);
    setDraftHeatmapBlend(0.85);
    setDraftHeatmapContrast(1.0);
    setDraftHoverTintStrength(DEFAULT_HOVER_TINT_STRENGTH);
    setDraftSelectedTintStrength(DEFAULT_SELECTED_TINT_STRENGTH);
    setDraftSelectionHighlightMode('tint');
    setDraftSelectionColor('#ec2a77');
    setDraftHoverColor('#ec2a77');
    setDraftCameraProjectionMode(DEFAULT_CAMERA_PROJECTION_SETTINGS.mode);
    setDraftCameraFeelPreset(DEFAULT_CAMERA_FEEL_SETTINGS.preset);
    setDraftCameraScope(DEFAULT_WORKSPACE_CAMERA_SETTINGS.scope);
    setDraftThemePreference('system');
    setDraftThemePreset('dragonfruit-dark');
    setDraftThemeColors(DEFAULT_THEME_CUSTOM_COLORS);
    setDraftFloatingLayoutPersistence(true);
    setDraftDebugPrimitivesPanelVisible(false);
    setDraftSpaceMouseSettings(DEFAULT_SPACEMOUSE_SETTINGS);
    setDraftWorkspaceCameraDefaults(DEFAULT_WORKSPACE_CAMERA_SETTINGS.defaults);
    setDraftView3dSettings(DEFAULT_VIEW3D_SETTINGS);
    setDraftSlicingPerformanceSettings(DEFAULT_SLICING_PERFORMANCE_SETTINGS);
  }, []);

  const handleRestoreDefaults = React.useCallback(() => {
    setShowRestoreDefaultsConfirm(true);
  }, []);

  const handleConfirmRestoreDefaults = React.useCallback(() => {
    applyRestoreDefaultsToDraft();
    setShowRestoreDefaultsConfirm(false);
  }, [applyRestoreDefaultsToDraft]);

  const handleCancelRestoreDefaults = React.useCallback(() => {
    setShowRestoreDefaultsConfirm(false);
  }, []);

  const handleApply = React.useCallback(() => {
    onMeshColorChange(draftMeshColor);
    onShaderTypeChange(draftShaderType);
    onMatcapVariantChange(draftMatcapVariant);
    onFlatUseVertexColorsChange(draftFlatUseVertexColors);
    onToonStepsChange(draftToonSteps);
    onAmbientIntensityChange(draftAmbientIntensity);
    onDirectionalIntensityChange(draftDirectionalIntensity);
    onMaterialRoughnessChange(draftMaterialRoughness);
    onXrayOpacityChange(draftXrayOpacity);
    onHeatmapBlendChange(draftHeatmapBlend);
    onHeatmapContrastChange(draftHeatmapContrast);
    draftHeatmapColors.forEach((color, i) => onHeatmapColorChange(i, color));
    onHoverTintStrengthChange(draftHoverTintStrength);
    onSelectedTintStrengthChange(draftSelectedTintStrength);
    onSelectionHighlightModeChange(draftSelectionHighlightMode);
    onSelectionColorChange(draftSelectionColor);
    onHoverColorChange(draftHoverColor);

    applyThemePreference(draftThemePreference);
    applyThemeCustomColors(draftThemeColors);
    setFloatingLayoutPersistenceEnabled(draftFloatingLayoutPersistence);
    setDebugPrimitivesPanelVisibleEnabled(draftDebugPrimitivesPanelVisible);
    saveSpaceMouseSettings(draftSpaceMouseSettings);
    saveCameraProjectionSettings({ mode: draftCameraProjectionMode });
    saveCameraFeelSettings({ preset: draftCameraFeelPreset });
    saveWorkspaceCameraSettings({
      scope: draftCameraScope,
      defaults: draftWorkspaceCameraDefaults,
      selectionHighlightDefaults: getSavedWorkspaceCameraSettings().selectionHighlightDefaults,
    });
    saveSlicingPerformanceSettings(draftSlicingPerformanceSettings);
    const normalized3dView = normalizeView3DSettings(draftView3dSettings);
    saveView3DSettings(normalized3dView);
    onView3dSettingsChange(normalized3dView);
    onDebugPrimitivesPanelVisibleChange(draftDebugPrimitivesPanelVisible);
    saveLogLevel(draftLogLevel);

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, draftThemePreference);
      window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, draftThemePreset);
      window.localStorage.setItem(THEME_COLORS_STORAGE_KEY, JSON.stringify(draftThemeColors));
    }

    onClose();
  }, [
    draftAmbientIntensity,
    draftDirectionalIntensity,
    draftFlatUseVertexColors,
    draftMatcapVariant,
    draftMaterialRoughness,
    draftMeshColor,
    draftHoverTintStrength,
    draftSelectedTintStrength,
    draftSelectionHighlightMode,
    draftSelectionColor,
    draftHoverColor,
    draftCameraScope,
    draftThemePreset,
    draftShaderType,
    draftToonSteps,
    draftThemePreference,
    draftThemeColors,
    draftFloatingLayoutPersistence,
    draftDebugPrimitivesPanelVisible,
    draftSpaceMouseSettings,
    draftCameraProjectionMode,
    draftCameraFeelPreset,
    draftWorkspaceCameraDefaults,
    draftSlicingPerformanceSettings,
    draftView3dSettings,
    draftXrayOpacity,
    draftHeatmapBlend,
    draftHeatmapContrast,
    draftHeatmapColors,
    draftLogLevel,
    onAmbientIntensityChange,
    onClose,
    onDirectionalIntensityChange,
    onFlatUseVertexColorsChange,
    onMatcapVariantChange,
    onMaterialRoughnessChange,
    onMeshColorChange,
    onHoverTintStrengthChange,
    onSelectedTintStrengthChange,
    onSelectionHighlightModeChange,
    onSelectionColorChange,
    onHoverColorChange,
    onDebugPrimitivesPanelVisibleChange,
    onView3dSettingsChange,
    onShaderTypeChange,
    onToonStepsChange,
    onXrayOpacityChange,
    onHeatmapBlendChange,
    onHeatmapContrastChange,
    onHeatmapColorChange,
  ]);

  const handleResetFloatingLayout = React.useCallback(() => {
    clearSavedFloatingLayout();
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const frame = requestAnimationFrame(() => {
      resetDraftFromProps();
    });

    return () => cancelAnimationFrame(frame);
  }, [isOpen, resetDraftFromProps]);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showRestoreDefaultsConfirm) {
        handleCancelRestoreDefaults();
        return;
      }
      handleCancel();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, handleCancel, handleCancelRestoreDefaults, showRestoreDefaultsConfirm]);

  const handleSpaceMouseChange = React.useCallback((partial: Partial<SpaceMouseSettings>) => {
    setDraftSpaceMouseSettings((prev) => normalizeSpaceMouseSettings({ ...prev, ...partial }));
  }, []);

  const handleWorkspaceCameraModeChange = React.useCallback((workspace: keyof WorkspaceCameraDefaults, mode: 'orthographic' | 'perspective') => {
    setDraftWorkspaceCameraDefaults((prev) => ({
      ...prev,
      [workspace]: mode,
    }));
  }, []);

  if (!isOpen) return null;

  const tabMeta: Record<SettingsTabKey, { label: string; description: string; icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; tone: SettingsTabTone }> = {
    general: {
      label: 'General',
      description: 'Workspace behavior and panel layout',
      icon: Settings2,
      tone: 'primary',
    },
    camera: {
      label: 'Camera',
      description: 'Projection and navigation behavior',
      icon: Camera,
      tone: 'primary',
    },
    mesh: {
      label: 'Mesh',
      description: 'Shader preview and render tuning',
      icon: Grid3x3,
      tone: 'primary',
    },
    performance: {
      label: 'Slicing',
      description: 'PNG compression, spatial acceleration, and engine metadata',
      icon: MonitorCog,
      tone: 'primary',
    },
    workspaces: {
      label: 'Workspaces',
      description: 'Per-workspace camera defaults',
      icon: MonitorCog,
      tone: 'primary',
    },
    ui: {
      label: 'UI & Theme',
      description: 'Selection behavior, theme, and custom UI tokens',
      icon: Palette,
      tone: 'primary',
    },
    hotkeys: {
      label: 'Hotkeys',
      description: 'Keyboard bindings and presets',
      icon: Keyboard,
      tone: 'secondary',
    },
    spacemouse: {
      label: '3D Mouse',
      description: '3D mouse navigation controls',
      icon: Gamepad2,
      tone: 'primary',
    },
    plugins: {
      label: 'Plugins',
      description: 'Load vendor profile plugins',
      icon: Plug,
      tone: 'secondary',
    },
    sceneAutosave: {
      label: 'Scene Autosave',
      description: 'Autosave and crash recovery behavior',
      icon: HardDrive,
      tone: 'secondary',
    },
    backups: {
      label: 'Backups',
      description: 'Local on-disk backup snapshots',
      icon: ArchiveRestore,
      tone: 'secondary',
    },
    logging: {
      label: 'Logging',
      description: 'Log file location and verbosity',
      icon: ScrollText,
      tone: 'secondary',
    },
    about: {
      label: 'About',
      description: 'Version info and project details',
      icon: Info,
      tone: 'secondary',
    },
  };

  const sidebarTopTabs: SettingsTabKey[] = ['general', 'camera', 'workspaces', 'mesh', 'performance', 'spacemouse', 'ui', 'hotkeys'];
  const sidebarBottomTabs: SettingsTabKey[] = ['plugins', 'sceneAutosave', 'backups', 'logging', 'about'];

  const ActiveTabIcon = tabMeta[activeTab].icon;
  const activeTabColor = tabMeta[activeTab].tone === 'secondary' ? 'var(--accent-secondary)' : 'var(--accent)';
  const isBetaBuildChannel = DRAGONFRUIT_BUILD_CHANNEL.includes('beta');
  const buildStatusLabel = isBetaBuildChannel
    ? 'BETA VERSION'
    : DRAGONFRUIT_BUILD_CHANNEL === 'mainline'
      ? 'Mainline Build'
      : `${DRAGONFRUIT_BUILD_CHANNEL.toUpperCase()} Build`;
  const buildStatusStyle: React.CSSProperties = isBetaBuildChannel
    ? {
      color: '#fdba74',
      borderColor: 'color-mix(in srgb, #f97316, var(--border-subtle) 16%)',
      background: 'color-mix(in srgb, #f97316, transparent 96%)',
      textShadow: '0 0 4px color-mix(in srgb, #fb923c, transparent 66%)',
      boxShadow: '0 0 0 1px color-mix(in srgb, #f97316, transparent 62%), 0 0 10px color-mix(in srgb, #fb923c, transparent 74%)',
    }
    : {
      color: 'var(--text-strong)',
      borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
      background: 'color-mix(in srgb, var(--accent), transparent 84%)',
    };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/60 backdrop-blur-sm p-5 ui-modal-backdrop-enter"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleCancel();
      }}
    >
      <div
        className="w-full max-w-[72rem] h-full flex flex-col rounded-2xl shadow-2xl border overflow-hidden ui-modal-panel-enter"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-strong)',
          boxShadow: '0 26px 64px rgba(0, 0, 0, 0.46)',
        }}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-2.5">
            <span
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent), var(--surface-1) 84%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 90%))',
              }}
            >
              <Settings2 className="h-4.5 w-4.5" style={{ color: 'var(--accent)' }} />
            </span>
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>Settings</h2>
              <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Customize DragonFruit behavior, visuals, and controls.
              </p>
            </div>
          </div>
          <button
            onClick={handleCancel}
            className="ui-button ui-button-secondary inline-flex items-center justify-center leading-none !h-8 !w-8 !p-0"
            aria-label="Close"
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div
            className="w-72 p-2.5"
            style={{
              borderRight: '1px solid var(--border-subtle)',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 6%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 96%))',
            }}
          >
            <div className="h-full flex flex-col">
              <div className="space-y-1.5">
                {sidebarTopTabs.map((tab) => {
                  const meta = tabMeta[tab];
                  const Icon = meta.icon;
                  const active = activeTab === tab;
                  const tabColor = meta.tone === 'secondary' ? 'var(--accent-secondary)' : 'var(--accent)';

                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setActiveTab(tab)}
                      className="w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-150"
                      style={active
                        ? {
                          borderColor: `color-mix(in srgb, ${tabColor}, var(--border-subtle) 35%)`,
                          background: `color-mix(in srgb, ${tabColor}, var(--surface-0) 84%)`,
                          boxShadow: `0 0 0 1px color-mix(in srgb, ${tabColor}, transparent 76%) inset`,
                        }
                        : {
                          borderColor: 'var(--border-subtle)',
                          background: 'var(--surface-1)',
                        }}
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
                          style={{
                            borderColor: active
                              ? `color-mix(in srgb, ${tabColor}, var(--border-subtle) 30%)`
                              : 'var(--border-subtle)',
                            background: active
                              ? `color-mix(in srgb, ${tabColor}, var(--surface-1) 82%)`
                              : 'var(--surface-2)',
                          }}
                        >
                          <Icon className="h-3.5 w-3.5" style={{ color: active ? tabColor : 'var(--text-muted)' }} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold" style={{ color: active ? 'var(--text-strong)' : 'var(--text-strong)' }}>
                            {meta.label}
                          </span>
                          <span className="block text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                            {meta.description}
                          </span>
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-auto space-y-1.5 pt-3">
                {sidebarBottomTabs.map((tab) => {
                  const meta = tabMeta[tab];
                  const Icon = meta.icon;
                  const active = activeTab === tab;
                  const tabColor = meta.tone === 'secondary' ? 'var(--accent-secondary)' : 'var(--accent)';

                  return (
                    <button
                      key={tab}
                      type="button"
                      aria-disabled={false}
                      onClick={() => setActiveTab(tab)}
                      className="w-full rounded-lg border px-3 py-2.5 text-left transition-all duration-150"
                      style={{
                        ...(active
                          ? {
                            borderColor: `color-mix(in srgb, ${tabColor}, var(--border-subtle) 35%)`,
                            background: `color-mix(in srgb, ${tabColor}, var(--surface-0) 84%)`,
                            boxShadow: `0 0 0 1px color-mix(in srgb, ${tabColor}, transparent 76%) inset`,
                          }
                          : {
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                          }),
                      }}
                    >
                      <div className="flex items-start gap-2.5">
                        <span
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border"
                          style={{
                            borderColor: active
                              ? `color-mix(in srgb, ${tabColor}, var(--border-subtle) 30%)`
                              : 'var(--border-subtle)',
                            background: active
                              ? `color-mix(in srgb, ${tabColor}, var(--surface-1) 82%)`
                              : 'var(--surface-2)',
                          }}
                        >
                          <Icon className="h-3.5 w-3.5" style={{ color: active ? tabColor : 'var(--text-muted)' }} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold" style={{ color: active ? 'var(--text-strong)' : 'var(--text-strong)' }}>
                            {meta.label}
                          </span>
                          <span className="block text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                            {meta.description}
                          </span>
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4">
            <div className="mb-3 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
              <div className="flex items-center gap-2">
                <ActiveTabIcon className="h-4 w-4" style={{ color: activeTabColor }} />
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{tabMeta[activeTab].label}</h3>
              </div>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>{tabMeta[activeTab].description}</p>
            </div>

            <div key={activeTab} className="animate-[settingsTabIn_180ms_ease-out]">
              {activeTab === 'general' && (
                <GeneralSettingsTab
                  floatingLayoutPersistence={draftFloatingLayoutPersistence}
                  onFloatingLayoutPersistenceChange={setDraftFloatingLayoutPersistence}
                  onResetFloatingLayout={handleResetFloatingLayout}
                  debugPrimitivesPanelVisible={draftDebugPrimitivesPanelVisible}
                  onDebugPrimitivesPanelVisibleChange={setDraftDebugPrimitivesPanelVisible}
                />
              )}
              {activeTab === 'camera' && (
                <CameraSettingsTab
                  cameraScope={draftCameraScope}
                  onCameraScopeChange={setDraftCameraScope}
                  cameraProjectionMode={draftCameraProjectionMode}
                  onCameraProjectionModeChange={setDraftCameraProjectionMode}
                  cameraFeelPreset={draftCameraFeelPreset}
                  onCameraFeelPresetChange={setDraftCameraFeelPreset}
                  workspaceCameraDefaults={draftWorkspaceCameraDefaults}
                  onWorkspaceCameraModeChange={handleWorkspaceCameraModeChange}
                />
              )}
              {activeTab === 'workspaces' && (
                <WorkspacesSettingsTab
                  view3dSettings={draftView3dSettings}
                  onView3dSettingsChange={setDraftView3dSettings}
                />
              )}
              {activeTab === 'mesh' && (
                <MeshSettingsTab
                  shaderType={draftShaderType}
                  onShaderTypeChange={setDraftShaderType}
                  matcapVariant={draftMatcapVariant}
                  onMatcapVariantChange={setDraftMatcapVariant}
                  flatUseVertexColors={draftFlatUseVertexColors}
                  onFlatUseVertexColorsChange={setDraftFlatUseVertexColors}
                  toonSteps={draftToonSteps}
                  onToonStepsChange={setDraftToonSteps}
                  meshColor={draftMeshColor}
                  onMeshColorChange={setDraftMeshColor}
                  ambientIntensity={draftAmbientIntensity}
                  onAmbientIntensityChange={setDraftAmbientIntensity}
                  directionalIntensity={draftDirectionalIntensity}
                  onDirectionalIntensityChange={setDraftDirectionalIntensity}
                  materialRoughness={draftMaterialRoughness}
                  onMaterialRoughnessChange={setDraftMaterialRoughness}
                  xrayOpacity={draftXrayOpacity}
                  heatmapBlend={draftHeatmapBlend}
                  heatmapContrast={draftHeatmapContrast}
                  onXrayOpacityChange={setDraftXrayOpacity}
                  onHeatmapBlendChange={setDraftHeatmapBlend}
                  onHeatmapContrastChange={setDraftHeatmapContrast}
                  heatmapColors={draftHeatmapColors}
                  onHeatmapColorChange={handleDraftHeatmapColorChange}
                />
              )}
              {activeTab === 'performance' && (
                <PerformanceSettingsTab
                  settings={draftSlicingPerformanceSettings}
                  onChange={setDraftSlicingPerformanceSettings}
                  showPngCompressionControls={showPngCompressionControls}
                />
              )}
              {activeTab === 'ui' && (
                <UISettingsTab
                  selectionColor={draftSelectionColor}
                  onSelectionColorChange={setDraftSelectionColor}
                  hoverColor={draftHoverColor}
                  onHoverColorChange={setDraftHoverColor}
                  selectionHighlightMode={draftSelectionHighlightMode}
                  onSelectionHighlightModeChange={setDraftSelectionHighlightMode}
                  hoverTintStrength={draftHoverTintStrength}
                  onHoverTintStrengthChange={setDraftHoverTintStrength}
                  selectedTintStrength={draftSelectedTintStrength}
                  onSelectedTintStrengthChange={setDraftSelectedTintStrength}
                  themePreset={draftThemePreset}
                  onThemePresetChange={setDraftThemePreset}
                  themePreference={draftThemePreference}
                  onThemePreferenceChange={setDraftThemePreference}
                  themeColors={draftThemeColors}
                  onThemeColorChange={handleThemeColorChange}
                  onResetThemeColors={handleResetThemeColors}
                />
              )}
              {activeTab === 'hotkeys' && <HotkeysSettingsTab />}
              {activeTab === 'spacemouse' && (
                <SpaceMouseSettingsTab
                  settings={draftSpaceMouseSettings}
                  onChange={handleSpaceMouseChange}
                />
              )}
              {activeTab === 'plugins' && <PluginsSettingsTab />}
              {activeTab === 'sceneAutosave' && <SceneAutosaveSettingsTab />}
              {activeTab === 'backups' && <LocalBackupsSettingsTab />}
              {activeTab === 'logging' && (
                <LoggingSettingsTab
                  logLevel={draftLogLevel}
                  onLogLevelChange={setDraftLogLevel}
                />
              )}
              {activeTab === 'about' && (
                <div className="flex min-h-full flex-col gap-3.5">
                  <div
                    className="rounded-xl border p-4"
                    style={{
                      borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 62%)',
                      background: 'linear-gradient(145deg, color-mix(in srgb, var(--accent), var(--surface-0) 95%), color-mix(in srgb, var(--accent-secondary), var(--surface-0) 94%))',
                    }}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <img
                          src="/dragonfruit_assets/branding/text_logo.svg"
                          alt="DragonFruit"
                          className="h-8 w-auto object-contain"
                        />
                        <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                          DragonFruit is an open-source slicer for resin 3D printing.
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span
                        className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums"
                        style={{
                          color: 'var(--text-strong)',
                          borderColor: 'color-mix(in srgb, var(--border-subtle), white 8%)',
                          background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
                        }}
                      >
                        v{DRAGONFRUIT_VERSION}
                      </span>
                      <span
                        className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                        style={{
                          color: 'var(--accent-secondary-contrast)',
                          borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)',
                          background: 'color-mix(in srgb, var(--accent-secondary), transparent 24%)',
                        }}
                      >
                        An Open Resin Alliance Project
                      </span>
                      <span
                        className="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                        style={buildStatusStyle}
                      >
                        {buildStatusLabel}
                      </span>
                    </div>
                  </div>

                  <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <h5 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Team & Credits
                    </h5>

                    <div className="mt-2.5 space-y-2">
                      <div
                        className="rounded-lg border px-3 py-2.5"
                        style={{
                          borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                          background: 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                              Ty Mansfield
                            </div>
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              TableFlip Foundry, Open Resin Alliance
                            </div>
                            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              Core Framework, Supports, Bugfixes, and General Mayhem
                            </div>
                          </div>
                          <div
                            className="rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                            style={{
                              color: 'var(--accent-contrast)',
                              borderColor: 'color-mix(in srgb, var(--accent), white 18%)',
                              background: 'color-mix(in srgb, var(--accent), transparent 18%)',
                            }}
                          >
                            Main Developer & Maintainer
                          </div>
                        </div>
                      </div>

                      <div
                        className="rounded-lg border px-3 py-2.5"
                        style={{
                          borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                          background: 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                              Paul Skapczyk
                            </div>
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              Open Resin Alliance
                            </div>
                            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              Core Framework, UI & UX, Backend, Plugins and Chaos Engineering
                            </div>
                          </div>
                          <div
                            className="rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                            style={{
                              color: 'var(--accent-contrast)',
                              borderColor: 'color-mix(in srgb, var(--accent), white 18%)',
                              background: 'color-mix(in srgb, var(--accent), transparent 18%)',
                            }}
                          >
                            Main Developer & Maintainer
                          </div>
                        </div>
                      </div>

                      <div
                        className="rounded-lg border px-3 py-2.5"
                        style={{
                          borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
                          background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 93%)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                              William Patton
                            </div>
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              PattonWebz
                            </div>
                            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              Breaks stuff, maybe fixes it. Maybe.
                            </div>
                          </div>
                          <div
                            className="rounded-full border px-2 py-0.5 text-[10px] font-semibold"
                            style={{
                              color: 'var(--accent-secondary-contrast)',
                              borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 38%)',
                              background: 'color-mix(in srgb, var(--accent-secondary), transparent 18%)',
                            }}
                          >
                            Contributor
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 25%)' }}>
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      DragonFruit is actively evolving. Expect rapid iteration and workflow improvements.
                    </div>
                  </div>

                  <div className="mt-auto rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <h5 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Open Resin Alliance
                    </h5>

                    <div className="mt-2 flex items-center gap-4 rounded-lg border px-3 py-3" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 52%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 94%)' }}>
                      <img
                        src={ORA_LOGO_DARK_URL}
                        alt="Open Resin Alliance"
                        className="h-24 w-auto object-contain shrink-0"
                      />

                      <div className="min-w-0 flex-1 space-y-1.5">
                        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-strong)' }}>
                          <Github className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                          <span className="font-semibold">Repository:</span>
                          <a
                            href={DRAGONFRUIT_REPO_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 underline underline-offset-2"
                            style={{ color: 'var(--accent)' }}
                          >
                            Open-Resin-Alliance/DragonFruit
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>

                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          Status: Private GitHub Repo until public launch, then open-source.
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          License: TBD (GPLv3 or similar open-source license likely)
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 flex items-center justify-between gap-2" style={{ borderTop: '1px solid var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 10%)' }}>
          <button
            type="button"
            onClick={handleRestoreDefaults}
            className="ui-button !h-10 !px-3.5 !py-0 text-sm inline-flex items-center gap-1.5 whitespace-nowrap"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 64%)',
              background: 'color-mix(in srgb, var(--surface-1), var(--accent-secondary) 7%)',
              color: 'var(--text-strong)',
            }}
          >
            <RotateCcw className="h-4 w-4 shrink-0" />
            Restore Defaults
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleCancel}
              className="ui-button ui-button-secondary !h-10 !px-4 !py-0 text-sm"
              style={{
                color: 'var(--text-muted)',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="ui-button ui-button-primary !h-10 !px-4 !py-0 text-sm inline-flex items-center gap-1.5 whitespace-nowrap"
              style={{
                background: 'color-mix(in srgb, var(--accent), var(--surface-0) 16%)',
                borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
              }}
            >
              <Check className="h-4 w-4 shrink-0" />
              Apply
            </button>
          </div>
        </div>
      </div>

      {showRestoreDefaultsConfirm && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              handleCancelRestoreDefaults();
            }
          }}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm restore defaults"
          >
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2.5 min-w-0">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 88%)',
                    color: '#f59e0b',
                  }}
                >
                  <RotateCcw className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Restore Defaults?
                  </h3>
                  <p className="text-[11px] leading-snug mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    This resets settings in this dialog to their default values.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleCancelRestoreDefaults}
                className="ui-button ui-button-secondary inline-flex items-center justify-center leading-none !h-8 !w-8 !p-0"
                aria-label="Close restore defaults confirmation"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                You can still review the changes before saving. Nothing is written until you click <strong>Apply</strong>.
              </p>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleCancelRestoreDefaults}
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                >
                  Keep Current
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRestoreDefaults}
                  className="ui-button !h-9 px-3 text-xs inline-flex items-center gap-1.5"
                  style={{
                    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                    color: '#fde68a',
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore Defaults
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
