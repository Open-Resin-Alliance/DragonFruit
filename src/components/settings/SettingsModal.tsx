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
import { UISettingsTab } from './UISettingsTab';
import { WorkspacesSettingsTab } from '@/components/settings/WorkspacesSettingsTab';
import { PerformanceSettingsTab, type SlicingThumbnailRenderSettings } from '@/components/settings/PerformanceSettingsTab';
import { AlertTriangle, Check, Edit3, ExternalLink, Gamepad2, Github, HardDrive, Info, Keyboard, MonitorCog, Palette, Plug, RotateCcw, Save, Settings2, Trash2, X, Camera, Grid3x3, ArchiveRestore, ScrollText } from 'lucide-react';
import type { MatcapVariant, MeshShaderType } from '@/features/shaders/mesh';
import {
  applyThemeCustomColors,
  applyThemePreference,
  createCustomThemeProfile,
  DEFAULT_THEME_CUSTOM_COLORS,
  deleteCustomThemeProfile,
  getSavedThemeCustomColors,
  getSavedCustomThemeProfiles,
  getThemeProfile,
  getSavedThemePreset,
  getSavedThemePreference,
  exportThemeProfileToJson,
  getThemePresetColors,
  importThemeProfileFromJson,
  isBuiltInThemePreset,
  deriveThemeCustomColorsFromBranding,
  saveCustomThemeProfile,
  THEME_COLORS_STORAGE_KEY,
  THEME_CUSTOM_PROFILES_STORAGE_KEY,
  THEME_PRESET_STORAGE_KEY,
  THEME_STORAGE_KEY,
  type ThemePreset,
  type ThemeCustomColors,
  type SavedCustomThemeProfile,
} from '@/components/settings/themeCustomizations';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
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
  DEFAULT_CAMERA_TRACKPAD_SETTINGS,
  getSavedCameraTrackpadSettings,
  saveCameraTrackpadSettings,
  type CameraTrackpadPrimaryAction,
  type CameraTrackpadModifierKey,
} from '@/components/settings/cameraTrackpadPreferences';
import {
  DEFAULT_WORKSPACE_CAMERA_SETTINGS,
  getSavedWorkspaceCameraSettings,
  saveWorkspaceCameraSettings,
  type CameraScopeMode,
  type WorkspaceCameraDefaults,
} from '@/components/settings/workspaceCameraPreferences';
import {
  pickOpenFilesWithNativeDialog,
  readPrintArtifactBytesFromPath,
  savePrintArtifactWithNativeDialog,
} from '@/features/slicing/tauri/nativeSlicerBridge';
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
const ORA_LOGO_DARK_URL = '/dragonfruit_assets/branding/open_resin_alliance_logo_darkmode.png';
const DRAGONFRUIT_REPO_URL = 'https://github.com/Open-Resin-Alliance/DragonFruit';
const DEFAULT_SLICING_THUMBNAIL_RENDER_SETTINGS: SlicingThumbnailRenderSettings = {
  includeGradient: false,
  includeBuildPlate: false,
  includeGrid: false,
};

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
  slicingThumbnailRenderSettings: SlicingThumbnailRenderSettings;
  onSlicingThumbnailRenderSettingsChange: (settings: SlicingThumbnailRenderSettings) => void;
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
  slicingThumbnailRenderSettings,
  onSlicingThumbnailRenderSettingsChange,
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
  const [draftCameraTrackpadPrimaryAction, setDraftCameraTrackpadPrimaryAction] = useState<CameraTrackpadPrimaryAction>(() => getSavedCameraTrackpadSettings().primaryAction);
  const [draftCameraTrackpadModifierKey, setDraftCameraTrackpadModifierKey] = useState<CameraTrackpadModifierKey>(() => getSavedCameraTrackpadSettings().modifierKey);
  const [draftCameraTrackpadPanAcceleration, setDraftCameraTrackpadPanAcceleration] = useState<number>(() => getSavedCameraTrackpadSettings().panAcceleration);
  const [draftCameraTrackpadOrbitAcceleration, setDraftCameraTrackpadOrbitAcceleration] = useState<number>(() => getSavedCameraTrackpadSettings().orbitAcceleration);
  const [draftCameraTrackpadZoomAcceleration, setDraftCameraTrackpadZoomAcceleration] = useState<number>(() => getSavedCameraTrackpadSettings().zoomAcceleration);
  const [draftCameraScope, setDraftCameraScope] = useState<CameraScopeMode>(() => getSavedWorkspaceCameraSettings().scope);
  const [draftThemePreference, setDraftThemePreference] = useState(getSavedThemePreference());
  const [draftThemePreset, setDraftThemePreset] = useState<ThemePreset>(getSavedThemePreset());
  const [draftThemeColors, setDraftThemeColors] = useState<ThemeCustomColors>(getSavedThemeCustomColors());
  const [draftThemeProfiles, setDraftThemeProfiles] = useState<SavedCustomThemeProfile[]>(() => getSavedCustomThemeProfiles());
  const [draftCustomThemeName, setDraftCustomThemeName] = useState<string>(() => {
    const savedPreset = getSavedThemePreset();
    const savedProfile = getThemeProfile(savedPreset, getSavedCustomThemeProfiles());
    return savedProfile.isBuiltIn ? '' : savedProfile.name;
  });
  const [draftFloatingLayoutPersistence, setDraftFloatingLayoutPersistence] = useState<boolean>(() => isFloatingLayoutPersistenceEnabled());
  const [draftDebugPrimitivesPanelVisible, setDraftDebugPrimitivesPanelVisible] = useState<boolean>(() => debugPrimitivesPanelVisible);
  const [draftSpaceMouseSettings, setDraftSpaceMouseSettings] = useState<SpaceMouseSettings>(() => getSavedSpaceMouseSettings());
  const [draftWorkspaceCameraDefaults, setDraftWorkspaceCameraDefaults] = useState<WorkspaceCameraDefaults>(() => getSavedWorkspaceCameraSettings().defaults);
  const [draftView3dSettings, setDraftView3dSettings] = useState<View3DSettings>(() => view3dSettings ?? getSavedView3DSettings());
  const [draftSlicingPerformanceSettings, setDraftSlicingPerformanceSettings] = useState<SlicingPerformanceSettings>(() => getSavedSlicingPerformanceSettings());
  const [draftSlicingThumbnailRenderSettings, setDraftSlicingThumbnailRenderSettings] = useState<SlicingThumbnailRenderSettings>(() => slicingThumbnailRenderSettings ?? DEFAULT_SLICING_THUMBNAIL_RENDER_SETTINGS);
  const [draftLogLevel, setDraftLogLevel] = useState<LogLevelFilter>(() => getSavedLogLevel());
  const [showRestoreDefaultsConfirm, setShowRestoreDefaultsConfirm] = useState(false);
  const [showThemeSaveConfirm, setShowThemeSaveConfirm] = useState(false);
  const [showThemeRenameDialog, setShowThemeRenameDialog] = useState(false);
  const [showThemeDeleteConfirm, setShowThemeDeleteConfirm] = useState(false);
  const [draftThemeRenameName, setDraftThemeRenameName] = useState('');
  const [draftThemeCreateBasePreset, setDraftThemeCreateBasePreset] = useState<'dark' | 'light'>(() => {
    const savedPreference = getSavedThemePreference();
    const savedPreset = getSavedThemePreset();
    return savedPreference === 'light' || savedPreset === 'dragonfruit-light' ? 'light' : 'dark';
  });
  const [draftThemeCreatePrimaryBrandColor, setDraftThemeCreatePrimaryBrandColor] = useState<string>(() => getSavedThemeCustomColors().accent);
  const [draftThemeCreateSecondaryBrandColor, setDraftThemeCreateSecondaryBrandColor] = useState<string>(() => getSavedThemeCustomColors().accentSecondary);
  const [themeNameDialogMode, setThemeNameDialogMode] = useState<'rename' | 'create'>('rename');
  const [pendingCreatedThemePreset, setPendingCreatedThemePreset] = useState<ThemePreset | null>(null);
  const [themeCreationFallbackPreset, setThemeCreationFallbackPreset] = useState<ThemePreset | null>(null);
  const [isLightTheme, setIsLightTheme] = useState(false);
  const didCommitThemeDraftRef = React.useRef(false);
  const showPngCompressionControls = outputFormatUsesPngLayers(activeOutputFormat ?? undefined);

  const accentSecondaryActionColor = isLightTheme
    ? 'color-mix(in srgb, #4f8a08, var(--text-strong) 30%)'
    : 'var(--accent-secondary)';
  const accentSecondaryActionBorderColor = isLightTheme
    ? 'color-mix(in srgb, #6aa20d, var(--border-subtle) 34%)'
    : 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)';
  const accentSecondaryActionBackground92 = isLightTheme
    ? 'color-mix(in srgb, #6aa20d, var(--surface-1) 80%)'
    : 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)';
  const accentSecondaryActionStyle92: React.CSSProperties = {
    color: accentSecondaryActionColor,
    borderColor: accentSecondaryActionBorderColor,
    background: accentSecondaryActionBackground92,
  };

  const setThemeDraftFromProfile = React.useCallback((preset: ThemePreset, profiles: SavedCustomThemeProfile[]) => {
    const profile = getThemeProfile(preset, profiles);
    setDraftThemePreset(profile.id);
    setDraftThemePreference(profile.preference);
    setDraftThemeColors(profile.colors);
    setDraftCustomThemeName(profile.isBuiltIn ? '' : profile.name);
  }, []);

  const resetDraftFromProps = React.useCallback(() => {
    const savedThemeProfiles = getSavedCustomThemeProfiles();
    const savedThemePreset = getSavedThemePreset();
    const savedThemeProfile = getThemeProfile(savedThemePreset, savedThemeProfiles);

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
    setDraftSelectionColor(savedThemeProfile.colors.accent);
    setDraftHoverColor(savedThemeProfile.colors.accentHover);
    setDraftCameraProjectionMode(getSavedCameraProjectionSettings().mode);
    setDraftCameraFeelPreset(getSavedCameraFeelSettings().preset);
    setDraftCameraTrackpadPrimaryAction(getSavedCameraTrackpadSettings().primaryAction);
    setDraftCameraTrackpadModifierKey(getSavedCameraTrackpadSettings().modifierKey);
    setDraftCameraTrackpadPanAcceleration(getSavedCameraTrackpadSettings().panAcceleration);
    setDraftCameraTrackpadOrbitAcceleration(getSavedCameraTrackpadSettings().orbitAcceleration);
    setDraftCameraTrackpadZoomAcceleration(getSavedCameraTrackpadSettings().zoomAcceleration);
    setDraftCameraScope(getSavedWorkspaceCameraSettings().scope);
    setDraftThemePreference(getSavedThemePreference());
    setDraftThemePreset(savedThemePreset);
    setDraftThemeColors(getSavedThemeCustomColors());
    setDraftThemeProfiles(savedThemeProfiles);
    setDraftCustomThemeName(savedThemeProfile.isBuiltIn ? '' : savedThemeProfile.name);
    setDraftFloatingLayoutPersistence(isFloatingLayoutPersistenceEnabled());
    setDraftDebugPrimitivesPanelVisible(isDebugPrimitivesPanelVisibleEnabled());
    setDraftSpaceMouseSettings(getSavedSpaceMouseSettings());
    setDraftWorkspaceCameraDefaults(getSavedWorkspaceCameraSettings().defaults);
    setDraftView3dSettings(view3dSettings ?? getSavedView3DSettings());
    setDraftSlicingPerformanceSettings(getSavedSlicingPerformanceSettings());
    setDraftSlicingThumbnailRenderSettings(slicingThumbnailRenderSettings ?? DEFAULT_SLICING_THUMBNAIL_RENDER_SETTINGS);
    setDraftLogLevel(getSavedLogLevel());
  }, [
    ambientIntensity,
    directionalIntensity,
    flatUseVertexColors,
    meshColor,
    toonSteps,
    matcapVariant,
    materialRoughness,
    heatmapColors,
    hoverTintStrength,
    selectedTintStrength,
    selectionHighlightMode,
    debugPrimitivesPanelVisible,
    view3dSettings,
    slicingThumbnailRenderSettings,
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

  const restoreSavedThemePreview = React.useCallback(() => {
    applyThemePreference(getSavedThemePreference());
    applyThemeCustomColors(getSavedThemeCustomColors());
  }, []);

  const handleDraftHeatmapColorChange = React.useCallback((index: number, color: string) => {
    setDraftHeatmapColors((prev) => {
      const copy = [...prev];
      copy[index] = color;
      return copy;
    });
  }, []);

  const handleThemePresetChange = React.useCallback((preset: ThemePreset) => {
    setThemeDraftFromProfile(preset, draftThemeProfiles);
  }, [draftThemeProfiles, setThemeDraftFromProfile]);

  const handleResetThemeColors = React.useCallback(() => {
    const profile = getThemeProfile(draftThemePreset, draftThemeProfiles);
    setDraftThemeColors(profile.colors);
    setDraftThemePreference(profile.preference);
    setDraftCustomThemeName(profile.isBuiltIn ? '' : profile.name);
  }, [draftThemePreset, draftThemeProfiles]);

  const getThemeExportName = React.useCallback(() => {
    if (isBuiltInThemePreset(draftThemePreset)) {
      return getThemeProfile(draftThemePreset, draftThemeProfiles).name;
    }
    return draftCustomThemeName.trim() || 'Custom Theme';
  }, [draftCustomThemeName, draftThemePreset, draftThemeProfiles]);

  const handleExportTheme = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    void (async () => {
      try {
      const exportName = getThemeExportName();
      const exportJson = exportThemeProfileToJson({
        name: exportName,
        preference: draftThemePreference,
        colors: draftThemeColors,
        sourcePresetId: draftThemePreset,
        appVersion: DRAGONFRUIT_VERSION,
      });

      const safeName = exportName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'dragonfruit-theme';

      const fileName = `${safeName}.dragonfruit-theme.json`;
      const bytes = new TextEncoder().encode(exportJson);

      try {
        await savePrintArtifactWithNativeDialog(bytes, fileName);
        return;
      } catch (nativeError) {
        const nativeMessage = nativeError instanceof Error ? nativeError.message : String(nativeError ?? '');
        const loweredNativeMessage = nativeMessage.toLowerCase();
        if (loweredNativeMessage.includes('cancel')) return;

        const nativeUnavailable = loweredNativeMessage.includes('only available in dragonfruit desktop')
          || loweredNativeMessage.includes('tauri runtime');
        if (!nativeUnavailable) {
          throw nativeError;
        }
      }

      const blob = new Blob([exportJson], { type: 'application/json;charset=utf-8' });
      const blobUrl = window.URL.createObjectURL(blob);

      const anchor = document.createElement('a');
      anchor.href = blobUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      window.URL.revokeObjectURL(blobUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown export error';
      window.alert(`Failed to export theme profile. ${message}`);
    }
    })();
  }, [draftThemeColors, draftThemePreference, draftThemePreset, getThemeExportName]);

  const handleImportTheme = React.useCallback(async (file?: File) => {
    try {
      let rawJson = '';

      if (file) {
        rawJson = await file.text();
      } else {
        const picked = await pickOpenFilesWithNativeDialog('bundle', false);
        const sourcePath = picked[0]?.path?.trim();
        if (!sourcePath) return;

        const bytes = await readPrintArtifactBytesFromPath(sourcePath);
        rawJson = new TextDecoder().decode(bytes);
      }

      const imported = importThemeProfileFromJson(rawJson);

      const createdProfile = createCustomThemeProfile(imported.name, imported.preference, imported.colors);
      const nextProfiles = [...draftThemeProfiles, createdProfile];

      setDraftThemeProfiles(nextProfiles);
      setThemeDraftFromProfile(createdProfile.id, nextProfiles);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown import error';
      if (message.toLowerCase().includes('cancel')) return;
      if (typeof window !== 'undefined') {
        window.alert(`Failed to import theme profile. ${message}`);
      }
    }
  }, [draftThemeProfiles, setThemeDraftFromProfile]);

  const handleCreateCustomThemeFromPreset = React.useCallback(() => {
    const previousPreset = draftThemePreset;
    const initialCreateBasePreset: 'dark' | 'light' = draftThemePreference === 'light' || draftThemePreset === 'dragonfruit-light'
      ? 'light'
      : 'dark';
    const initialCreateBaseColors = getThemePresetColors(initialCreateBasePreset === 'light' ? 'dragonfruit-light' : 'dragonfruit-dark');
    const profile = createCustomThemeProfile('', draftThemePreference, draftThemeColors);
    const nextProfiles = [...draftThemeProfiles, profile];
    setDraftThemeProfiles(nextProfiles);
    setDraftThemePreset(profile.id);
    setDraftCustomThemeName(profile.name);
    setDraftThemeRenameName(profile.name);
    setDraftThemeCreateBasePreset(initialCreateBasePreset);
    setDraftThemeCreatePrimaryBrandColor(initialCreateBaseColors.accent);
    setDraftThemeCreateSecondaryBrandColor(initialCreateBaseColors.accentSecondary);
    setThemeNameDialogMode('create');
    setPendingCreatedThemePreset(profile.id);
    setThemeCreationFallbackPreset(previousPreset);
    setShowThemeRenameDialog(true);
  }, [draftThemeColors, draftThemePreference, draftThemePreset, draftThemeProfiles]);

  const handleThemeCreateBasePresetChange = React.useCallback((preset: 'dark' | 'light') => {
    setDraftThemeCreateBasePreset(preset);
    const basePresetColors = getThemePresetColors(preset === 'light' ? 'dragonfruit-light' : 'dragonfruit-dark');
    setDraftThemeCreatePrimaryBrandColor(basePresetColors.accent);
    setDraftThemeCreateSecondaryBrandColor(basePresetColors.accentSecondary);
  }, []);

  const persistCurrentCustomTheme = React.useCallback(() => {
    if (isBuiltInThemePreset(draftThemePreset)) return;

    const savedProfile = saveCustomThemeProfile(draftThemePreset, {
      name: draftCustomThemeName,
      preference: draftThemePreference,
      colors: draftThemeColors,
    });
    if (!savedProfile) return;

    const nextProfiles = draftThemeProfiles.map((profile) => (
      profile.id === savedProfile.id ? savedProfile : profile
    ));
    setDraftThemeProfiles(nextProfiles);
    setDraftCustomThemeName(savedProfile.name);
  }, [draftCustomThemeName, draftThemeColors, draftThemePreference, draftThemePreset, draftThemeProfiles]);

  const handleRequestSaveCurrentCustomTheme = React.useCallback(() => {
    if (isBuiltInThemePreset(draftThemePreset)) return;
    setShowThemeSaveConfirm(true);
  }, [draftThemePreset]);

  const handleConfirmSaveCurrentCustomTheme = React.useCallback(() => {
    persistCurrentCustomTheme();
    setShowThemeSaveConfirm(false);
  }, [persistCurrentCustomTheme]);

  const handleRequestRenameCurrentCustomTheme = React.useCallback(() => {
    if (isBuiltInThemePreset(draftThemePreset)) return;
    const profile = getThemeProfile(draftThemePreset, draftThemeProfiles);
    if (profile.isBuiltIn) return;
    setDraftThemeRenameName(profile.name);
    setThemeNameDialogMode('rename');
    setPendingCreatedThemePreset(null);
    setThemeCreationFallbackPreset(null);
    setShowThemeRenameDialog(true);
  }, [draftThemePreset, draftThemeProfiles]);

  const handleConfirmRenameCurrentCustomTheme = React.useCallback(() => {
    if (isBuiltInThemePreset(draftThemePreset)) return;
    const nextName = draftThemeRenameName.trim();
    if (!nextName) return;

    const selectedProfile = getThemeProfile(draftThemePreset, draftThemeProfiles);
    if (selectedProfile.isBuiltIn) return;

    const nextPreference = themeNameDialogMode === 'create'
      ? draftThemeCreateBasePreset
      : selectedProfile.preference;

    const nextColors = themeNameDialogMode === 'create'
      ? deriveThemeCustomColorsFromBranding({
        primaryBrandColor: draftThemeCreatePrimaryBrandColor,
        secondaryBrandColor: draftThemeCreateSecondaryBrandColor,
        preference: nextPreference,
      })
      : selectedProfile.colors;

    const renamed = saveCustomThemeProfile(selectedProfile.id, {
      name: nextName,
      preference: nextPreference,
      colors: nextColors,
    });
    if (!renamed) return;

    const nextProfiles = draftThemeProfiles.map((profile) => (
      profile.id === renamed.id ? renamed : profile
    ));
    setDraftThemeProfiles(nextProfiles);
    if (themeNameDialogMode === 'create') {
      setThemeDraftFromProfile(renamed.id, nextProfiles);
    } else {
      setDraftCustomThemeName(renamed.name);
    }
    setDraftThemeRenameName(renamed.name);
    setThemeNameDialogMode('rename');
    setPendingCreatedThemePreset(null);
    setThemeCreationFallbackPreset(null);
    setShowThemeRenameDialog(false);
  }, [draftThemeCreateBasePreset, draftThemeCreatePrimaryBrandColor, draftThemeCreateSecondaryBrandColor, draftThemePreset, draftThemeProfiles, draftThemeRenameName, setThemeDraftFromProfile, themeNameDialogMode]);

  const performDeleteCurrentCustomTheme = React.useCallback(() => {
    if (isBuiltInThemePreset(draftThemePreset)) return;

    const nextProfiles = deleteCustomThemeProfile(draftThemePreset);
    setDraftThemeProfiles(nextProfiles);

    if (typeof window !== 'undefined' && getSavedThemePreset() === draftThemePreset) {
      const fallbackPreset: ThemePreset = draftThemePreference === 'light' ? 'dragonfruit-light' : 'dragonfruit-dark';
      window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, fallbackPreset);
    }

    const fallbackPreset: ThemePreset = draftThemePreference === 'light' ? 'dragonfruit-light' : 'dragonfruit-dark';
    setThemeDraftFromProfile(fallbackPreset, nextProfiles);
  }, [draftThemePreference, draftThemePreset, setThemeDraftFromProfile]);

  const handleRequestDeleteCurrentCustomTheme = React.useCallback(() => {
    if (isBuiltInThemePreset(draftThemePreset)) return;
    setShowThemeDeleteConfirm(true);
  }, [draftThemePreset]);

  const handleConfirmDeleteCurrentCustomTheme = React.useCallback(() => {
    performDeleteCurrentCustomTheme();
    setShowThemeDeleteConfirm(false);
  }, [performDeleteCurrentCustomTheme]);

  const handleCancel = React.useCallback(() => {
    setShowRestoreDefaultsConfirm(false);
    setShowThemeSaveConfirm(false);
    setShowThemeRenameDialog(false);
    setShowThemeDeleteConfirm(false);
    setThemeNameDialogMode('rename');
    setPendingCreatedThemePreset(null);
    setThemeCreationFallbackPreset(null);
    didCommitThemeDraftRef.current = false;
    restoreSavedThemePreview();
    resetDraftFromProps();
    onClose();
  }, [onClose, resetDraftFromProps, restoreSavedThemePreview]);

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
    setDraftSelectionColor(DEFAULT_THEME_CUSTOM_COLORS.accent);
    setDraftHoverColor(DEFAULT_THEME_CUSTOM_COLORS.accentHover);
    setDraftCameraProjectionMode(DEFAULT_CAMERA_PROJECTION_SETTINGS.mode);
    setDraftCameraFeelPreset(DEFAULT_CAMERA_FEEL_SETTINGS.preset);
    setDraftCameraTrackpadPrimaryAction(DEFAULT_CAMERA_TRACKPAD_SETTINGS.primaryAction);
    setDraftCameraTrackpadModifierKey(DEFAULT_CAMERA_TRACKPAD_SETTINGS.modifierKey);
    setDraftCameraTrackpadPanAcceleration(DEFAULT_CAMERA_TRACKPAD_SETTINGS.panAcceleration);
    setDraftCameraTrackpadOrbitAcceleration(DEFAULT_CAMERA_TRACKPAD_SETTINGS.orbitAcceleration);
    setDraftCameraTrackpadZoomAcceleration(DEFAULT_CAMERA_TRACKPAD_SETTINGS.zoomAcceleration);
    setDraftCameraScope(DEFAULT_WORKSPACE_CAMERA_SETTINGS.scope);
    setDraftThemePreference('dark');
    setDraftThemePreset('dragonfruit-dark');
    setDraftThemeColors(DEFAULT_THEME_CUSTOM_COLORS);
    setDraftCustomThemeName('');
    setDraftFloatingLayoutPersistence(true);
    setDraftDebugPrimitivesPanelVisible(false);
    setDraftSpaceMouseSettings(DEFAULT_SPACEMOUSE_SETTINGS);
    setDraftWorkspaceCameraDefaults(DEFAULT_WORKSPACE_CAMERA_SETTINGS.defaults);
    setDraftView3dSettings(DEFAULT_VIEW3D_SETTINGS);
    setDraftSlicingPerformanceSettings(DEFAULT_SLICING_PERFORMANCE_SETTINGS);
    setDraftSlicingThumbnailRenderSettings(DEFAULT_SLICING_THUMBNAIL_RENDER_SETTINGS);
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

  const handleCancelThemeSaveConfirm = React.useCallback(() => {
    setShowThemeSaveConfirm(false);
  }, []);

  const handleCancelThemeRenameDialog = React.useCallback(() => {
    if (themeNameDialogMode === 'create' && pendingCreatedThemePreset) {
      const nextProfiles = deleteCustomThemeProfile(pendingCreatedThemePreset);
      setDraftThemeProfiles(nextProfiles);

      const fallbackPreset = themeCreationFallbackPreset
        && (isBuiltInThemePreset(themeCreationFallbackPreset) || nextProfiles.some((profile) => profile.id === themeCreationFallbackPreset))
        ? themeCreationFallbackPreset
        : 'dragonfruit-dark';

      setThemeDraftFromProfile(fallbackPreset, nextProfiles);
    }

    setThemeNameDialogMode('rename');
    setPendingCreatedThemePreset(null);
    setThemeCreationFallbackPreset(null);
    setShowThemeRenameDialog(false);
  }, [pendingCreatedThemePreset, themeCreationFallbackPreset, themeNameDialogMode, setThemeDraftFromProfile]);

  const handleCancelThemeDeleteConfirm = React.useCallback(() => {
    setShowThemeDeleteConfirm(false);
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
    onSelectionColorChange(draftThemeColors.accent);
    onHoverColorChange(draftThemeColors.accentHover);

    applyThemePreference(draftThemePreference);
    applyThemeCustomColors(draftThemeColors);
    setFloatingLayoutPersistenceEnabled(draftFloatingLayoutPersistence);
    setDebugPrimitivesPanelVisibleEnabled(draftDebugPrimitivesPanelVisible);
    saveSpaceMouseSettings(draftSpaceMouseSettings);
    saveCameraProjectionSettings({ mode: draftCameraProjectionMode });
    saveCameraFeelSettings({ preset: draftCameraFeelPreset });
    saveCameraTrackpadSettings({
      primaryAction: draftCameraTrackpadPrimaryAction,
      modifierKey: draftCameraTrackpadModifierKey,
      panAcceleration: draftCameraTrackpadPanAcceleration,
      orbitAcceleration: draftCameraTrackpadOrbitAcceleration,
      zoomAcceleration: draftCameraTrackpadZoomAcceleration,
    });
    saveWorkspaceCameraSettings({
      scope: draftCameraScope,
      defaults: draftWorkspaceCameraDefaults,
      selectionHighlightDefaults: getSavedWorkspaceCameraSettings().selectionHighlightDefaults,
    });
    saveSlicingPerformanceSettings(draftSlicingPerformanceSettings);
    onSlicingThumbnailRenderSettingsChange(draftSlicingThumbnailRenderSettings);
    const normalized3dView = normalizeView3DSettings(draftView3dSettings);
    saveView3DSettings(normalized3dView);
    onView3dSettingsChange(normalized3dView);
    onDebugPrimitivesPanelVisibleChange(draftDebugPrimitivesPanelVisible);
    saveLogLevel(draftLogLevel);

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, draftThemePreference);
      window.localStorage.setItem(THEME_PRESET_STORAGE_KEY, draftThemePreset);
      window.localStorage.setItem(THEME_COLORS_STORAGE_KEY, JSON.stringify(draftThemeColors));
      window.localStorage.setItem(THEME_CUSTOM_PROFILES_STORAGE_KEY, JSON.stringify(draftThemeProfiles));
    }

    didCommitThemeDraftRef.current = true;
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
    draftCameraScope,
    draftThemePreset,
    draftShaderType,
    draftToonSteps,
    draftThemePreference,
    draftThemeColors,
    draftThemeProfiles,
    draftFloatingLayoutPersistence,
    draftDebugPrimitivesPanelVisible,
    draftSpaceMouseSettings,
    draftCameraProjectionMode,
    draftCameraFeelPreset,
    draftCameraTrackpadPrimaryAction,
    draftCameraTrackpadModifierKey,
    draftCameraTrackpadPanAcceleration,
    draftCameraTrackpadOrbitAcceleration,
    draftCameraTrackpadZoomAcceleration,
    draftWorkspaceCameraDefaults,
    draftSlicingPerformanceSettings,
    draftSlicingThumbnailRenderSettings,
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
    onSlicingThumbnailRenderSettingsChange,
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

    didCommitThemeDraftRef.current = false;

    const frame = requestAnimationFrame(() => {
      resetDraftFromProps();
    });

    return () => {
      cancelAnimationFrame(frame);
      if (!didCommitThemeDraftRef.current) {
        restoreSavedThemePreview();
      }
    };
  }, [isOpen, resetDraftFromProps, restoreSavedThemePreview]);

  useEffect(() => {
    if (!isOpen) return;

    applyThemePreference(draftThemePreference);
    applyThemeCustomColors(draftThemeColors);
  }, [draftThemeColors, draftThemePreference, isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    setDraftSelectionColor(draftThemeColors.accent);
    setDraftHoverColor(draftThemeColors.accentHover);
  }, [draftThemeColors.accent, draftThemeColors.accentHover, isOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const evaluateTheme = () => {
      const root = document.documentElement;
      const explicitTheme = root.getAttribute('data-theme');
      if (explicitTheme === 'light') {
        setIsLightTheme(true);
        return;
      }
      if (explicitTheme === 'dark') {
        setIsLightTheme(false);
        return;
      }
      setIsLightTheme(window.matchMedia('(prefers-color-scheme: light)').matches);
    };

    evaluateTheme();

    const observer = new MutationObserver(evaluateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleMediaChange = () => evaluateTheme();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMediaChange);
    } else {
      mediaQuery.addListener(handleMediaChange);
    }

    return () => {
      observer.disconnect();
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMediaChange);
      } else {
        mediaQuery.removeListener(handleMediaChange);
      }
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (showThemeDeleteConfirm) {
        handleCancelThemeDeleteConfirm();
        return;
      }
      if (showThemeRenameDialog) {
        handleCancelThemeRenameDialog();
        return;
      }
      if (showThemeSaveConfirm) {
        handleCancelThemeSaveConfirm();
        return;
      }
      if (showRestoreDefaultsConfirm) {
        handleCancelRestoreDefaults();
        return;
      }
      handleCancel();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isOpen,
    handleCancel,
    handleCancelRestoreDefaults,
    handleCancelThemeDeleteConfirm,
    handleCancelThemeRenameDialog,
    handleCancelThemeSaveConfirm,
    showRestoreDefaultsConfirm,
    showThemeDeleteConfirm,
    showThemeRenameDialog,
    showThemeSaveConfirm,
  ]);

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

  const isCreatingCustomThemeName = themeNameDialogMode === 'create';
  const isThemeDraftDirty = (() => {
    const profile = getThemeProfile(draftThemePreset, draftThemeProfiles);
    const preferenceChanged = profile.preference !== draftThemePreference;
    const colorsChanged = (Object.keys(profile.colors) as Array<keyof ThemeCustomColors>)
      .some((key) => profile.colors[key] !== draftThemeColors[key]);

    return preferenceChanged || colorsChanged;
  })();
  const isCustomThemeDirty = (() => {
    if (isBuiltInThemePreset(draftThemePreset)) return false;

    const profile = getThemeProfile(draftThemePreset, draftThemeProfiles);
    if (profile.isBuiltIn) return false;

    const preferenceChanged = profile.preference !== draftThemePreference;
    const colorsChanged = (Object.keys(profile.colors) as Array<keyof ThemeCustomColors>)
      .some((key) => profile.colors[key] !== draftThemeColors[key]);

    return preferenceChanged || colorsChanged;
  })();

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
      description: 'Shader, rendering options, and selection behavior',
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
      description: 'Theme and custom UI token customization',
      icon: Palette,
      tone: 'primary',
    },
    hotkeys: {
      label: 'Hotkeys',
      description: 'Keyboard bindings and presets',
      icon: Keyboard,
      tone: 'primary',
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
  const isAboutTab = activeTab === 'about';
  const usesInternalTabScrollLayout = isAboutTab || activeTab === 'hotkeys';
  const isBetaBuildChannel = DRAGONFRUIT_BUILD_CHANNEL.includes('beta');
  const buildStatusLabel = isBetaBuildChannel
    ? 'BETA VERSION'
    : DRAGONFRUIT_BUILD_CHANNEL === 'mainline'
      ? 'Mainline Build'
      : `${DRAGONFRUIT_BUILD_CHANNEL.toUpperCase()} Build`;
  const buildStatusStyle: React.CSSProperties = isBetaBuildChannel
    ? isLightTheme
      ? {
        color: '#9a3412',
        borderColor: 'color-mix(in srgb, #ea580c, var(--border-subtle) 30%)',
        background: 'color-mix(in srgb, #fed7aa, var(--surface-0) 14%)',
      }
      : {
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
            className="w-72 min-h-0 p-2.5"
            style={{
              borderRight: '1px solid var(--border-subtle)',
              background: 'linear-gradient(180deg, color-mix(in srgb, var(--surface-1), transparent 6%), color-mix(in srgb, var(--accent-secondary), var(--surface-1) 96%))',
            }}
          >
            <div className="h-full min-h-0 overflow-y-auto custom-scrollbar pr-1 flex flex-col">
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

          <div className={usesInternalTabScrollLayout ? 'flex-1 min-h-0 flex flex-col p-4' : 'flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4'}>
            <div className="mb-3 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
              <div className="flex items-center gap-2">
                <ActiveTabIcon className="h-4 w-4" style={{ color: activeTabColor }} />
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{tabMeta[activeTab].label}</h3>
              </div>
              <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>{tabMeta[activeTab].description}</p>
            </div>

            <div key={activeTab} className={usesInternalTabScrollLayout ? 'animate-[settingsTabIn_180ms_ease-out] flex-1 min-h-0 flex flex-col' : 'animate-[settingsTabIn_180ms_ease-out]'}>
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
                  cameraTrackpadPrimaryAction={draftCameraTrackpadPrimaryAction}
                  onCameraTrackpadPrimaryActionChange={setDraftCameraTrackpadPrimaryAction}
                  cameraTrackpadModifierKey={draftCameraTrackpadModifierKey}
                  onCameraTrackpadModifierKeyChange={setDraftCameraTrackpadModifierKey}
                  cameraTrackpadPanAcceleration={draftCameraTrackpadPanAcceleration}
                  onCameraTrackpadPanAccelerationChange={setDraftCameraTrackpadPanAcceleration}
                  cameraTrackpadOrbitAcceleration={draftCameraTrackpadOrbitAcceleration}
                  onCameraTrackpadOrbitAccelerationChange={setDraftCameraTrackpadOrbitAcceleration}
                  cameraTrackpadZoomAcceleration={draftCameraTrackpadZoomAcceleration}
                  onCameraTrackpadZoomAccelerationChange={setDraftCameraTrackpadZoomAcceleration}
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
                  selectionColor={draftSelectionColor}
                  hoverColor={draftHoverColor}
                  selectionHighlightMode={draftSelectionHighlightMode}
                  onSelectionHighlightModeChange={setDraftSelectionHighlightMode}
                  hoverTintStrength={draftHoverTintStrength}
                  onHoverTintStrengthChange={setDraftHoverTintStrength}
                  selectedTintStrength={draftSelectedTintStrength}
                  onSelectedTintStrengthChange={setDraftSelectedTintStrength}
                />
              )}
              {activeTab === 'performance' && (
                <PerformanceSettingsTab
                  settings={draftSlicingPerformanceSettings}
                  onChange={setDraftSlicingPerformanceSettings}
                  thumbnailSettings={draftSlicingThumbnailRenderSettings}
                  onThumbnailSettingsChange={setDraftSlicingThumbnailRenderSettings}
                  showPngCompressionControls={showPngCompressionControls}
                />
              )}
              {activeTab === 'ui' && (
                <UISettingsTab
                  themeProfiles={[
                    getThemeProfile('dragonfruit-dark', draftThemeProfiles),
                    getThemeProfile('dragonfruit-light', draftThemeProfiles),
                    ...draftThemeProfiles.map((profile) => getThemeProfile(profile.id, draftThemeProfiles)),
                  ]}
                  themePreset={draftThemePreset}
                  onThemePresetChange={handleThemePresetChange}
                  themePreference={draftThemePreference}
                  onThemePreferenceChange={setDraftThemePreference}
                  themeColors={draftThemeColors}
                  onThemeColorChange={handleThemeColorChange}
                  isBuiltInThemePreset={isBuiltInThemePreset(draftThemePreset)}
                  isCustomThemeDirty={isCustomThemeDirty}
                  isThemeResetDirty={isThemeDraftDirty}
                  onCreateCustomThemeFromPreset={handleCreateCustomThemeFromPreset}
                  onRequestSaveCustomTheme={handleRequestSaveCurrentCustomTheme}
                  onRequestRenameCustomTheme={handleRequestRenameCurrentCustomTheme}
                  onRequestDeleteCustomTheme={handleRequestDeleteCurrentCustomTheme}
                  onExportTheme={handleExportTheme}
                  onImportTheme={handleImportTheme}
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
                <div className="flex h-full min-h-0 flex-col gap-3.5">
                  <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
                    <div className="space-y-3.5 pb-2">
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
                              style={isLightTheme ? { filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.35))' } : undefined}
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
                                  Open Resin Alliance & Tableflip Foundry
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
                                  Magistr
                                </div>
                                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                  umag
                                </div>
                                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                  Support Tooling, Physics, and General Bugfixes. Linux Builds mysteriously work better when he's around, but who knows why.
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
                                  Tim
                                </div>
                                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                  tslater2006
                                </div>
                                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                  Anycubic Photon Support, Testing, and Bugfixes. Prints fun stuff.
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
                                  Ada Phillips
                                </div>
                                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                  Open Resin Alliance
                                </div>
                                <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                  Ensures the software doesn't set itself on fire.
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
                    </div>
                  </div>

                  <div className="shrink-0 rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <h5 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Open Resin Alliance
                    </h5>

                    <div className="mt-2 flex items-center gap-4 rounded-lg border px-3 py-3" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 52%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 94%)' }}>
                      <img
                        src={ORA_LOGO_DARK_URL}
                        alt="Open Resin Alliance"
                        className="h-24 w-auto object-contain shrink-0"
                        style={isLightTheme ? { filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.3))' } : undefined}
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
            style={accentSecondaryActionStyle92}
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
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: '#d97706',
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
                  style={accentSecondaryActionStyle92}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore Defaults
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <StructuredDialogModal
        open={showThemeSaveConfirm && !isBuiltInThemePreset(draftThemePreset)}
        ariaLabel="Confirm save custom theme"
        title="Save Theme Changes?"
        subtitle="This updates the selected custom theme profile."
        icon={<Save className="h-4 w-4" />}
        iconTone="accent"
        zIndexClassName="z-[72]"
        closeAriaLabel="Close save theme confirmation"
        onClose={handleCancelThemeSaveConfirm}
        actions={(
          <>
            <button
              type="button"
              onClick={handleCancelThemeSaveConfirm}
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmSaveCurrentCustomTheme}
              className="ui-button !h-9 px-3 text-xs inline-flex items-center gap-1.5"
              style={accentSecondaryActionStyle92}
            >
              <Save className="h-3.5 w-3.5" />
              Save Theme
            </button>
          </>
        )}
      >
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Save <strong>{draftCustomThemeName.trim() || 'this custom theme'}</strong> with the current scheme and palette values?
        </p>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={showThemeDeleteConfirm && !isBuiltInThemePreset(draftThemePreset)}
        ariaLabel="Confirm delete custom theme"
        title="Delete Custom Theme?"
        subtitle="This action cannot be undone."
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="danger"
        zIndexClassName="z-[73]"
        closeAriaLabel="Close delete theme confirmation"
        onClose={handleCancelThemeDeleteConfirm}
        actions={(
          <>
            <button
              type="button"
              onClick={handleCancelThemeDeleteConfirm}
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
            >
              Keep Theme
            </button>
            <button
              type="button"
              onClick={handleConfirmDeleteCurrentCustomTheme}
              className="ui-button ui-button-secondary !h-9 px-3 text-xs inline-flex items-center gap-1.5"
              style={{
                color: 'var(--danger)',
                borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 40%)',
                background: 'color-mix(in srgb, var(--danger), var(--surface-1) 92%)',
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Theme
            </button>
          </>
        )}
      >
        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Delete <strong>{draftCustomThemeName.trim() || 'this custom theme'}</strong>? DragonFruit will switch back to a built-in preset.
        </p>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={showThemeRenameDialog && !isBuiltInThemePreset(draftThemePreset)}
        ariaLabel={isCreatingCustomThemeName ? 'Create custom theme' : 'Rename custom theme'}
        title={isCreatingCustomThemeName ? 'Create Custom Theme' : 'Rename Custom Theme'}
        subtitle={isCreatingCustomThemeName ? 'Choose a name for your new custom theme profile.' : 'Update the display name for this custom theme profile.'}
        icon={<Edit3 className="h-4 w-4" />}
        iconTone="accent"
        zIndexClassName="z-[74]"
        closeAriaLabel={isCreatingCustomThemeName ? 'Close create custom theme dialog' : 'Close rename custom theme dialog'}
        onClose={handleCancelThemeRenameDialog}
        actions={(
          <>
            <button
              type="button"
              onClick={handleCancelThemeRenameDialog}
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleConfirmRenameCurrentCustomTheme}
              className="ui-button !h-9 px-3 text-xs inline-flex items-center gap-1.5"
              style={accentSecondaryActionStyle92}
              disabled={draftThemeRenameName.trim().length === 0}
            >
              <Check className="h-3.5 w-3.5" />
              {isCreatingCustomThemeName ? 'Create' : 'Save Name'}
            </button>
          </>
        )}
      >
        <div className="space-y-2">
          <label className="block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Theme name
          </label>
          <input
            type="text"
            value={draftThemeRenameName}
            onChange={(event) => setDraftThemeRenameName(event.target.value)}
            className="ui-input h-9 w-full text-xs"
            placeholder="Custom Theme"
          />

          {isCreatingCustomThemeName ? (
            <div className="space-y-2">
              <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Base preset
                </label>
                <div
                  className="inline-flex w-full rounded-md border p-1"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}
                >
                  {(['dark', 'light'] as const).map((preset) => {
                    const active = draftThemeCreateBasePreset === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => handleThemeCreateBasePresetChange(preset)}
                        className="flex-1 rounded-sm border px-2 py-1 text-[11px] font-semibold transition-colors"
                        style={active
                          ? {
                            color: 'var(--accent)',
                            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 22%)',
                            background: 'color-mix(in srgb, var(--accent), transparent 94%)',
                            boxShadow: '0 0 0 1px color-mix(in srgb, var(--accent), transparent 78%) inset',
                          }
                          : {
                            color: 'var(--text-muted)',
                            borderColor: 'var(--border-subtle)',
                            background: 'transparent',
                          }}
                      >
                        {preset === 'dark' ? 'Dark' : 'Light'}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Primary branding
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={draftThemeCreatePrimaryBrandColor}
                    onChange={(event) => setDraftThemeCreatePrimaryBrandColor(event.target.value)}
                    className="h-8 w-9 shrink-0 rounded border"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}
                  />
                  <input
                    type="text"
                    value={draftThemeCreatePrimaryBrandColor}
                    onChange={(event) => setDraftThemeCreatePrimaryBrandColor(event.target.value)}
                    className="ui-input h-8 min-w-0 flex-1 text-xs"
                    placeholder="#ec2a77"
                  />
                </div>
              </div>

              <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Secondary branding
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="color"
                    value={draftThemeCreateSecondaryBrandColor}
                    onChange={(event) => setDraftThemeCreateSecondaryBrandColor(event.target.value)}
                    className="h-8 w-9 shrink-0 rounded border"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}
                  />
                  <input
                    type="text"
                    value={draftThemeCreateSecondaryBrandColor}
                    onChange={(event) => setDraftThemeCreateSecondaryBrandColor(event.target.value)}
                    className="ui-input h-8 min-w-0 flex-1 text-xs"
                    placeholder="#baf72e"
                  />
                </div>
              </div>

              </div>
            </div>
          ) : null}
        </div>
      </StructuredDialogModal>
    </div>
  );
}
