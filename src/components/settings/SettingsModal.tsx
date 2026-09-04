'use client';

import React, { useEffect, useState } from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { GeneralSettingsTab } from '@/components/settings/GeneralSettingsTab';
import { useLocale } from '@/components/I18nClientProvider';
import contributors from '@/components/settings/contributors.json';
import { SponsorsCarousel } from '@/components/settings/SponsorsCarousel';
import { CameraSettingsTab } from '@/components/settings/CameraSettingsTab';
import { HotkeysSettingsTab } from '@/components/settings/HotkeysSettingsTab';
import { MeshSettingsTab } from '@/components/settings/MeshSettingsTab';
import { PluginsSettingsTab } from '@/components/settings/PluginsSettingsTab';
import { ExperimentsSettingsTab } from '@/components/settings/ExperimentsSettingsTab';
import { getEnabledExperimentIds } from '@/features/experiments/experimentsRegistry';
import { LocalBackupsSettingsTab } from '@/components/settings/LocalBackupsSettingsTab';
import { SceneAutosaveSettingsTab } from '@/components/settings/SceneAutosaveSettingsTab';
import { UvToolsSettingsTab } from '@/components/settings/UvToolsSettingsTab';
import { LoggingSettingsTab, getSavedLogLevel, saveLogLevel, type LogLevelFilter } from '@/components/settings/LoggingSettingsTab';
import { SpaceMouseSettingsTab } from '@/components/settings/SpaceMouseSettingsTab';
import { UISettingsTab } from './UISettingsTab';
import { UpdatesSettingsTab } from '@/features/updater/UpdatesSettingsTab';
import { getUpdateChannel, type UpdateChannel } from '@/features/updater/updateBridge';
import { WorkspacesSettingsTab } from '@/components/settings/WorkspacesSettingsTab';
import { PerformanceSettingsTab, type SlicingThumbnailRenderSettings } from '@/components/settings/PerformanceSettingsTab';
import { AlertTriangle, Check, CloudDownload, Edit3, ExternalLink, FlaskConical, Gamepad2, Github, HardDrive, Info, Keyboard, MonitorCog, Palette, Plug, RotateCcw, Save, Settings2, Trash2, X, Camera, Grid3x3, ArchiveRestore, ScrollText } from 'lucide-react';
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
  type ThemeCustomColors,
  type ThemePreset,
  type SavedCustomThemeProfile,
} from '@/components/settings/themeCustomizations';
import { DEFAULT_HOVER_COLOR, DEFAULT_SELECTION_COLOR } from '@/features/scene/useSceneCollectionManager';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { Tooltip } from '@/components/ui/Tooltip';
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
  DEFAULT_CAMERA_FOV_SETTINGS,
  getSavedCameraFovSettings,
  saveCameraFovSettings,
} from '@/components/settings/cameraFovPreferences';
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
import {
  DEFAULT_UVTOOLS_SETTINGS,
  getSavedUvToolsSettings,
  saveUvToolsSettings,
  type UvToolsSettings,
} from '@/components/settings/uvToolsPreferences';
import { outputFormatUsesPngLayers } from '@/features/slicing/formats/registry';
import {
  clearSavedFloatingLayout,
  isDebugPrimitivesPanelVisibleEnabled,
  isFloatingLayoutPersistenceEnabled,
  setDebugPrimitivesPanelVisibleEnabled,
  setFloatingLayoutPersistenceEnabled,
} from '@/components/layout/floatingLayoutPreferences';
import {
  DEFAULT_IMPORT_DEFAULTS_SETTINGS,
  getSavedImportDefaultsSettings,
  saveImportDefaultsSettings,
  type ImportDefaultsSettings,
} from '@/features/scene/importDefaultsPreferences';

const DEFAULT_MESH_COLOR = '#a3a3a3';
const DEFAULT_HEATMAP_MIN_ANGLE = 0;
const DEFAULT_HEATMAP_MAX_ANGLE = 45;
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
const DRAGONFRUIT_GIT_COMMIT = process.env.NEXT_PUBLIC_GIT_COMMIT ?? '';
const DRAGONFRUIT_GIT_REF = process.env.NEXT_PUBLIC_GIT_REF ?? '';
const BUILD_OS_LABELS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
const DRAGONFRUIT_BUILD_OS = process.env.NEXT_PUBLIC_BUILD_OS ?? '';
const DRAGONFRUIT_BUILD_ARCH = process.env.NEXT_PUBLIC_BUILD_ARCH ?? '';
// e.g. "macOS/arm64" — platform the binary was built for.
const DRAGONFRUIT_BUILD_PLATFORM = DRAGONFRUIT_BUILD_OS
  ? `${BUILD_OS_LABELS[DRAGONFRUIT_BUILD_OS] ?? DRAGONFRUIT_BUILD_OS}${DRAGONFRUIT_BUILD_ARCH ? `/${DRAGONFRUIT_BUILD_ARCH}` : ''}`
  : '';
// e.g. "dev @ 62e80c79b · macOS/arm64" — identifies the exact build behind a version number.
const DRAGONFRUIT_GIT_BUILD_LABEL = DRAGONFRUIT_GIT_COMMIT
  ? `${DRAGONFRUIT_GIT_REF ? `${DRAGONFRUIT_GIT_REF} @ ` : ''}${DRAGONFRUIT_GIT_COMMIT}${DRAGONFRUIT_BUILD_PLATFORM ? ` · ${DRAGONFRUIT_BUILD_PLATFORM}` : ''}`
  : '';
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
  heatmapMinAngle: number;
  heatmapMaxAngle: number;
  onXrayOpacityChange: (value: number) => void;
  onHeatmapMinAngleChange: (value: number) => void;
  onHeatmapMaxAngleChange: (value: number) => void;
  heatmapColors: string[];
  onHeatmapColorChange: (index: number, color: string) => void;
  hoverTintStrength: number;
  onHoverTintStrengthChange: (value: number) => void;
  selectedTintStrength: number;
  onSelectedTintStrengthChange: (value: number) => void;
  debugPrimitivesPanelVisible: boolean;
  onDebugPrimitivesPanelVisibleChange: (value: boolean) => void;
  view3dSettings: View3DSettings;
  onView3dSettingsChange: (settings: View3DSettings) => void;
  slicingThumbnailRenderSettings: SlicingThumbnailRenderSettings;
  onSlicingThumbnailRenderSettingsChange: (settings: SlicingThumbnailRenderSettings) => void;
  activeOutputFormat?: string | null;
  /** Optional: open to a specific tab on mount */
  initialTab?: SettingsTabKey;
};

export type SettingsTabKey = 'general' | 'camera' | 'workspaces' | 'mesh' | 'performance' | 'spacemouse' | 'plugins' | 'experiments' | 'sceneAutosave' | 'backups' | 'uvtools' | 'ui' | 'hotkeys' | 'logging' | 'updates' | 'about';
type SettingsTabTone = 'primary' | 'secondary';

/**
 * A sidebar description line that only offers a tooltip when it is actually
 * clipped. Translated descriptions run much longer than the English ones — the
 * Spanish "Comportamiento del espacio de trabajo y disposición de los paneles"
 * is more than twice "Workspace behavior and panel layout" — so the truncation
 * that never triggered in English hides most of the sentence in other locales.
 *
 * Two traps this deliberately avoids:
 *
 * 1. Measuring the truncating span itself. `Tooltip` renders no wrapper at all
 *    when its content is falsy, so a measurement taken on the span reacts to
 *    the very wrapper it decides to add — the element measures, gets wrapped,
 *    measures differently, gets unwrapped. The reference box here is the outer
 *    span, whose width is set by the sidebar and never by this decision, and
 *    the text is measured through a Range, which reports the full laid-out
 *    width regardless of what clips it.
 * 2. Measuring once. A late webfont changes text metrics after the first pass,
 *    and the outer box never resizes, so a ResizeObserver alone would keep a
 *    stale answer forever. Hence the `fonts.ready` re-measure.
 */
function TabDescription({ text }: { text: string }) {
  const outerRef = React.useRef<HTMLSpanElement>(null);
  const textRef = React.useRef<HTMLSpanElement>(null);
  const [isClipped, setIsClipped] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const textEl = textRef.current;
    if (!outer || !textEl) return;

    let disposed = false;

    const measure = () => {
      if (disposed) return;
      const range = document.createRange();
      range.selectNodeContents(textEl);
      const textWidth = range.getBoundingClientRect().width;
      range.detach();
      // The 1px slack absorbs sub-pixel rounding, which otherwise reports a
      // one-pixel overflow on text that visibly fits.
      setIsClipped(textWidth > outer.clientWidth + 1);
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    void document.fonts?.ready.then(measure);

    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [text]);

  return (
    <span ref={outerRef} className="block min-w-0">
      <Tooltip content={isClipped ? text : null} fullWidth maxWidth={280}>
        <span
          ref={textRef}
          className="block min-w-0 flex-1 truncate text-xs"
          style={{ color: 'var(--text-muted)' }}
        >
          {text}
        </span>
      </Tooltip>
    </span>
  );
}

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
  heatmapMinAngle,
  heatmapMaxAngle,
  onXrayOpacityChange,
  onHeatmapMinAngleChange,
  onHeatmapMaxAngleChange,
  heatmapColors,
  onHeatmapColorChange,
  hoverTintStrength,
  onHoverTintStrengthChange,
  selectedTintStrength,
  onSelectedTintStrengthChange,
  debugPrimitivesPanelVisible,
  onDebugPrimitivesPanelVisibleChange,
  view3dSettings,
  onView3dSettingsChange,
  slicingThumbnailRenderSettings,
  onSlicingThumbnailRenderSettingsChange,
  activeOutputFormat,
  initialTab,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabKey>(initialTab ?? 'general');
  // The modal stays mounted while closed (isOpen toggles visibility), so activeTab
  // would otherwise persist across open/close. Reset it to the caller's requested
  // tab each time the modal opens — the normal open path passes 'general', so
  // closing on Experiments reopens to General rather than the last-active tab.
  const wasOpenRef = React.useRef(isOpen);
  // Snapshot of enabled experiments at open; if it differs when the user closes
  // the modal, they toggled an experiment this session and we prompt to reload.
  const experimentsSnapshotRef = React.useRef<string>(getEnabledExperimentIds().sort().join(','));
  const [showReloadPrompt, setShowReloadPrompt] = useState(false);
  React.useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      setActiveTab(initialTab ?? 'general');
      setShowReloadPrompt(false);
      experimentsSnapshotRef.current = getEnabledExperimentIds().sort().join(',');
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, initialTab]);

  const requestClose = React.useCallback(() => {
    const currentKey = getEnabledExperimentIds().sort().join(',');
    if (currentKey !== experimentsSnapshotRef.current) {
      setShowReloadPrompt(true);
      return;
    }
    onClose();
  }, [onClose]);

  const reloadToApplyExperiments = React.useCallback(() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }, []);
  // Tracks the tab active before the current one, so the Experiments disclaimer
  // can return the user where they were if they decline to acknowledge.
  const previousTabRef = React.useRef<SettingsTabKey>(initialTab ?? 'general');
  const handleSelectTab = React.useCallback((tab: SettingsTabKey) => {
    previousTabRef.current = activeTab;
    setActiveTab(tab);
  }, [activeTab]);

  const [copied, setCopied] = useState(false);
  const handleCopyBuildInfo = React.useCallback(async () => {
    // Full build identity in one string — what a bug report needs.
    const buildInfo = `DragonFruit ${DRAGONFRUIT_VERSION} (${DRAGONFRUIT_BUILD_CHANNEL})${DRAGONFRUIT_GIT_BUILD_LABEL ? ` — ${DRAGONFRUIT_GIT_BUILD_LABEL}` : ''}`;
    try {
      await navigator.clipboard.writeText(buildInfo);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard unavailable */ }
  }, []);

  // Language is a draft like every other setting: changing the switcher only
  // updates draftLocale; the actual loadLocale happens in handleApply.
  const { _ } = useLingui();
  const { locale: activeLocale, setLocale: applyLocale } = useLocale();
  const [draftLocale, setDraftLocale] = useState(activeLocale);

  const [draftMeshColor, setDraftMeshColor] = useState(meshColor);
  const [draftShaderType, setDraftShaderType] = useState(shaderType);
  const [draftMatcapVariant, setDraftMatcapVariant] = useState(matcapVariant);
  const [draftFlatUseVertexColors, setDraftFlatUseVertexColors] = useState(flatUseVertexColors);
  const [draftToonSteps, setDraftToonSteps] = useState(toonSteps);
  const [draftAmbientIntensity, setDraftAmbientIntensity] = useState(ambientIntensity);
  const [draftDirectionalIntensity, setDraftDirectionalIntensity] = useState(directionalIntensity);
  const [draftMaterialRoughness, setDraftMaterialRoughness] = useState(materialRoughness);
  const [draftXrayOpacity, setDraftXrayOpacity] = useState(xrayOpacity);
  const [draftHeatmapMinAngle, setDraftHeatmapMinAngle] = useState(heatmapMinAngle);
  const [draftHeatmapMaxAngle, setDraftHeatmapMaxAngle] = useState(heatmapMaxAngle);
  const [draftHeatmapColors, setDraftHeatmapColors] = useState(heatmapColors);
  const [draftHoverTintStrength, setDraftHoverTintStrength] = useState(hoverTintStrength);
  const [draftSelectedTintStrength, setDraftSelectedTintStrength] = useState(selectedTintStrength);
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
  const [draftHigherContrastModelEdges, setDraftHigherContrastModelEdges] = useState<boolean>(() => getSavedWorkspaceCameraSettings().higherContrastModelEdges);
  const [draftPerspectiveFov, setDraftPerspectiveFov] = useState<number>(() => getSavedCameraFovSettings().fov);
  const [draftThemePreference, setDraftThemePreference] = useState(getSavedThemePreference());
  const [draftThemePreset, setDraftThemePreset] = useState<ThemePreset>(getSavedThemePreset());
  const [draftThemeColors, setDraftThemeColors] = useState<ThemeCustomColors>(() => {
    const preset = getSavedThemePreset();
    const profile = getThemeProfile(preset, getSavedCustomThemeProfiles());
    return { ...profile.colors };
  });
  const [draftThemeProfiles, setDraftThemeProfiles] = useState<SavedCustomThemeProfile[]>(() => getSavedCustomThemeProfiles());
  const [draftCustomThemeName, setDraftCustomThemeName] = useState<string>(() => {
    const savedPreset = getSavedThemePreset();
    const savedProfile = getThemeProfile(savedPreset, getSavedCustomThemeProfiles());
    return savedProfile.isBuiltIn ? '' : savedProfile.name;
  });
  const [draftFloatingLayoutPersistence, setDraftFloatingLayoutPersistence] = useState<boolean>(() => isFloatingLayoutPersistenceEnabled());
  const [draftDebugPrimitivesPanelVisible, setDraftDebugPrimitivesPanelVisible] = useState<boolean>(() => debugPrimitivesPanelVisible);
  const [draftImportDefaults, setDraftImportDefaults] = useState<ImportDefaultsSettings>(() => getSavedImportDefaultsSettings());
  const [draftSpaceMouseSettings, setDraftSpaceMouseSettings] = useState<SpaceMouseSettings>(() => getSavedSpaceMouseSettings());
  const [draftWorkspaceCameraDefaults, setDraftWorkspaceCameraDefaults] = useState<WorkspaceCameraDefaults>(() => getSavedWorkspaceCameraSettings().defaults);
  const [draftView3dSettings, setDraftView3dSettings] = useState<View3DSettings>(() => view3dSettings ?? getSavedView3DSettings());
  const [draftSlicingPerformanceSettings, setDraftSlicingPerformanceSettings] = useState<SlicingPerformanceSettings>(() => getSavedSlicingPerformanceSettings());
  const [draftSlicingThumbnailRenderSettings, setDraftSlicingThumbnailRenderSettings] = useState<SlicingThumbnailRenderSettings>(() => slicingThumbnailRenderSettings ?? DEFAULT_SLICING_THUMBNAIL_RENDER_SETTINGS);
  const [draftUvToolsSettings, setDraftUvToolsSettings] = useState<UvToolsSettings>(() => getSavedUvToolsSettings());
  const [draftLogLevel, setDraftLogLevel] = useState<LogLevelFilter>(() => getSavedLogLevel());
  const [updateChannel, setUpdateChannel] = useState<UpdateChannel>('stable');
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

  // Load saved update channel preference.
  React.useEffect(() => {
    getUpdateChannel().then(setUpdateChannel);
  }, []);

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
    setDraftHeatmapMinAngle(heatmapMinAngle);
    setDraftHeatmapMaxAngle(heatmapMaxAngle);
    setDraftHeatmapColors(heatmapColors);
    setDraftHoverTintStrength(hoverTintStrength);
    setDraftSelectedTintStrength(selectedTintStrength);
    setDraftSelectionColor(selectionColor);
    setDraftHoverColor(hoverColor);
    setDraftCameraProjectionMode(getSavedCameraProjectionSettings().mode);
    setDraftCameraFeelPreset(getSavedCameraFeelSettings().preset);
    setDraftCameraTrackpadPrimaryAction(getSavedCameraTrackpadSettings().primaryAction);
    setDraftCameraTrackpadModifierKey(getSavedCameraTrackpadSettings().modifierKey);
    setDraftCameraTrackpadPanAcceleration(getSavedCameraTrackpadSettings().panAcceleration);
    setDraftCameraTrackpadOrbitAcceleration(getSavedCameraTrackpadSettings().orbitAcceleration);
    setDraftCameraTrackpadZoomAcceleration(getSavedCameraTrackpadSettings().zoomAcceleration);
    setDraftCameraScope(getSavedWorkspaceCameraSettings().scope);
    setDraftHigherContrastModelEdges(getSavedWorkspaceCameraSettings().higherContrastModelEdges);
    setDraftPerspectiveFov(getSavedCameraFovSettings().fov);
    setDraftThemePreference(getSavedThemePreference());
    setDraftThemePreset(savedThemePreset);
    setDraftThemeColors(getSavedThemeCustomColors());
    setDraftThemeProfiles(savedThemeProfiles);
    setDraftCustomThemeName(savedThemeProfile.isBuiltIn ? '' : savedThemeProfile.name);
    setDraftFloatingLayoutPersistence(isFloatingLayoutPersistenceEnabled());
    setDraftDebugPrimitivesPanelVisible(isDebugPrimitivesPanelVisibleEnabled());
    setDraftImportDefaults(getSavedImportDefaultsSettings());
    setDraftSpaceMouseSettings(getSavedSpaceMouseSettings());
    setDraftWorkspaceCameraDefaults(getSavedWorkspaceCameraSettings().defaults);
    setDraftView3dSettings(view3dSettings ?? getSavedView3DSettings());
    setDraftSlicingPerformanceSettings(getSavedSlicingPerformanceSettings());
    setDraftSlicingThumbnailRenderSettings(slicingThumbnailRenderSettings ?? DEFAULT_SLICING_THUMBNAIL_RENDER_SETTINGS);
    setDraftUvToolsSettings(getSavedUvToolsSettings());
    setDraftLogLevel(getSavedLogLevel());
    setDraftLocale(activeLocale);
  }, [
    activeLocale,
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
    selectionColor,
    hoverColor,
    debugPrimitivesPanelVisible,
    view3dSettings,
    slicingThumbnailRenderSettings,
    shaderType,
    xrayOpacity,
    heatmapMinAngle,
    heatmapMaxAngle,
    heatmapColors,
  ]);

  const handleThemeColorChange = React.useCallback((key: keyof ThemeCustomColors, value: string) => {
    if (key === 'accent' && typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) {
      const oldAccent = draftThemeColors.accent?.toLowerCase();
      const newAccent = value.toLowerCase();
      if (oldAccent && newAccent && oldAccent !== newAccent) {
        const selLower = draftSelectionColor.toLowerCase();
        const hovLower = draftHoverColor.toLowerCase();
        if (selLower === oldAccent) setDraftSelectionColor(value);
        if (hovLower === oldAccent) setDraftHoverColor(value);
      }
    }
    setDraftThemeColors((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, [draftThemeColors.accent, draftSelectionColor, draftHoverColor]);
  const restoreSavedThemePreview = React.useCallback(() => {
    applyThemePreference(getSavedThemePreference());
    applyThemeCustomColors(getSavedThemeCustomColors());
  }, []);
  const handleThemePresetChange = React.useCallback((preset: ThemePreset) => {
    const oldProfile = getThemeProfile(draftThemePreset, draftThemeProfiles);
    const newProfile = getThemeProfile(preset, draftThemeProfiles);
    const oldAccent = oldProfile.colors.accent?.toLowerCase();
    const newAccent = newProfile.colors.accent?.toLowerCase();
    if (oldAccent && newAccent && oldAccent !== newAccent) {
      const selLower = draftSelectionColor.toLowerCase();
      const hovLower = draftHoverColor.toLowerCase();
      const defSel = DEFAULT_SELECTION_COLOR.toLowerCase();
      const defHov = DEFAULT_HOVER_COLOR.toLowerCase();
      const isSelDefault = selLower === oldAccent || selLower === defSel;
      const isHovDefault = hovLower === oldAccent || hovLower === defHov;
      if (isSelDefault) setDraftSelectionColor(newProfile.colors.accent);
      if (isHovDefault) setDraftHoverColor(newProfile.colors.accent);
    }
    setThemeDraftFromProfile(preset, draftThemeProfiles);
  }, [draftThemePreset, draftThemeProfiles, draftSelectionColor, draftHoverColor, setThemeDraftFromProfile]);

  const handleDraftHeatmapColorChange = React.useCallback((index: number, color: string) => {
    setDraftHeatmapColors((prev) => {
      const copy = [...prev];
      copy[index] = color;
      return copy;
    });
  }, []);

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
    requestClose();
  }, [requestClose, resetDraftFromProps, restoreSavedThemePreview]);

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
    setDraftHeatmapMinAngle(DEFAULT_HEATMAP_MIN_ANGLE);
    setDraftHeatmapMaxAngle(DEFAULT_HEATMAP_MAX_ANGLE);
    setDraftHoverTintStrength(DEFAULT_HOVER_TINT_STRENGTH);
    setDraftSelectedTintStrength(DEFAULT_SELECTED_TINT_STRENGTH);
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
    setDraftHigherContrastModelEdges(DEFAULT_WORKSPACE_CAMERA_SETTINGS.higherContrastModelEdges);
    setDraftPerspectiveFov(DEFAULT_CAMERA_FOV_SETTINGS.fov);
    setDraftThemePreference('dark');
    setDraftThemePreset('dragonfruit-dark');
    setDraftThemeColors(DEFAULT_THEME_CUSTOM_COLORS);
    setDraftCustomThemeName('');
    setDraftFloatingLayoutPersistence(true);
    setDraftDebugPrimitivesPanelVisible(false);
    setDraftImportDefaults(DEFAULT_IMPORT_DEFAULTS_SETTINGS);
    setDraftSpaceMouseSettings(DEFAULT_SPACEMOUSE_SETTINGS);
    setDraftWorkspaceCameraDefaults(DEFAULT_WORKSPACE_CAMERA_SETTINGS.defaults);
    setDraftView3dSettings(DEFAULT_VIEW3D_SETTINGS);
    setDraftSlicingPerformanceSettings(DEFAULT_SLICING_PERFORMANCE_SETTINGS);
    setDraftSlicingThumbnailRenderSettings(DEFAULT_SLICING_THUMBNAIL_RENDER_SETTINGS);
    setDraftUvToolsSettings(DEFAULT_UVTOOLS_SETTINGS);
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
    applyLocale(draftLocale);
    onMeshColorChange(draftMeshColor);
    onShaderTypeChange(draftShaderType);
    onMatcapVariantChange(draftMatcapVariant);
    onFlatUseVertexColorsChange(draftFlatUseVertexColors);
    onToonStepsChange(draftToonSteps);
    onAmbientIntensityChange(draftAmbientIntensity);
    onDirectionalIntensityChange(draftDirectionalIntensity);
    onMaterialRoughnessChange(draftMaterialRoughness);
    onXrayOpacityChange(draftXrayOpacity);
    onHeatmapMinAngleChange(draftHeatmapMinAngle);
    onHeatmapMaxAngleChange(draftHeatmapMaxAngle);
    draftHeatmapColors.forEach((color, i) => onHeatmapColorChange(i, color));
    onHoverTintStrengthChange(draftHoverTintStrength);
    onSelectedTintStrengthChange(draftSelectedTintStrength);
    // Auto-apply theme accent to selection/hover if not user-overridden (theme changed and selection still at old default)
    let finalSelectionColor = draftSelectionColor;
    let finalHoverColor = draftHoverColor;
    try {
      const savedThemeAccent = getSavedThemeCustomColors().accent?.toLowerCase();
      const draftAccent = draftThemeColors.accent?.toLowerCase();
      if (savedThemeAccent && draftAccent && savedThemeAccent !== draftAccent) {
        const savedSel = selectionColor.toLowerCase();
        const defSel = DEFAULT_SELECTION_COLOR.toLowerCase();
        const isSavedSelDefault = savedSel === savedThemeAccent || savedSel === defSel;
        const isDraftSelUnchanged = draftSelectionColor.toLowerCase() === savedSel;
        if (isSavedSelDefault && isDraftSelUnchanged) finalSelectionColor = draftThemeColors.accent;
        const savedHov = hoverColor.toLowerCase();
        const defHov = DEFAULT_HOVER_COLOR.toLowerCase();
        const isSavedHovDefault = savedHov === savedThemeAccent || savedHov === defHov;
        const isDraftHovUnchanged = draftHoverColor.toLowerCase() === savedHov;
        if (isSavedHovDefault && isDraftHovUnchanged) finalHoverColor = draftThemeColors.accent;
      }
    } catch {}
    onSelectionColorChange(finalSelectionColor);
    onHoverColorChange(finalHoverColor);
    applyThemePreference(draftThemePreference);
    applyThemeCustomColors(draftThemeColors);
    setFloatingLayoutPersistenceEnabled(draftFloatingLayoutPersistence);
    setDebugPrimitivesPanelVisibleEnabled(draftDebugPrimitivesPanelVisible);
    saveImportDefaultsSettings(draftImportDefaults);
    saveSpaceMouseSettings(draftSpaceMouseSettings);
    saveCameraProjectionSettings({ mode: draftCameraProjectionMode });
    saveCameraFovSettings({ fov: draftPerspectiveFov });
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
      higherContrastModelEdges: draftHigherContrastModelEdges,
    });
    saveSlicingPerformanceSettings(draftSlicingPerformanceSettings);
    saveUvToolsSettings(draftUvToolsSettings);
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
    requestClose();
  }, [
    applyLocale,
    draftLocale,
    draftAmbientIntensity,
    draftDirectionalIntensity,
    draftFlatUseVertexColors,
    draftMatcapVariant,
    draftMaterialRoughness,
    draftMeshColor,
    draftHoverTintStrength,
    draftSelectedTintStrength,
    draftSelectionColor,
    draftHoverColor,
    selectionColor,
    hoverColor,
    draftCameraScope,
    draftHigherContrastModelEdges,
    draftThemePreset,
    draftShaderType,
    draftToonSteps,
    draftThemePreference,
    draftThemeColors,
    draftThemeProfiles,
    draftFloatingLayoutPersistence,
    draftDebugPrimitivesPanelVisible,
    draftImportDefaults,
    draftSpaceMouseSettings,
    draftCameraProjectionMode,
    draftPerspectiveFov,
    draftCameraFeelPreset,
    draftCameraTrackpadPrimaryAction,
    draftCameraTrackpadModifierKey,
    draftCameraTrackpadPanAcceleration,
    draftCameraTrackpadOrbitAcceleration,
    draftCameraTrackpadZoomAcceleration,
    draftWorkspaceCameraDefaults,
    draftSlicingPerformanceSettings,
    draftSlicingThumbnailRenderSettings,
    draftUvToolsSettings,
    draftView3dSettings,
    draftXrayOpacity,
    draftHeatmapMinAngle,
    draftHeatmapMaxAngle,
    draftHeatmapColors,
    draftLogLevel,
    onAmbientIntensityChange,
    onClose,
    requestClose,
    onDirectionalIntensityChange,
    onFlatUseVertexColorsChange,
    onMatcapVariantChange,
    onMaterialRoughnessChange,
    onMeshColorChange,
    onHoverTintStrengthChange,
    onSelectedTintStrengthChange,
    onSelectionColorChange,
    onHoverColorChange,
    onDebugPrimitivesPanelVisibleChange,
    onSlicingThumbnailRenderSettingsChange,
    onView3dSettingsChange,
    onShaderTypeChange,
    onToonStepsChange,
    onXrayOpacityChange,
    onHeatmapMinAngleChange,
    onHeatmapMaxAngleChange,
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

  // Nested dialogs rendered through StructuredDialogModal register their own
  // Escape handler and take precedence; the cascade here covers the inline
  // restore-defaults confirmation, which does not.
  useEscapeToClose(isOpen, () => {
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
  });

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
      label: _(msg`General`),
      description: _(msg`Workspace behavior and panel layout`),
      icon: Settings2,
      tone: 'primary',
    },
    camera: {
      label: _(msg`Camera`),
      description: _(msg`Projection and navigation behavior`),
      icon: Camera,
      tone: 'primary',
    },
    mesh: {
      label: _(msg`Mesh`),
      description: _(msg`Shader, rendering options, and selection behavior`),
      icon: Grid3x3,
      tone: 'primary',
    },
    performance: {
      label: _(msg`Slicing`),
      description: _(msg`PNG compression and engine metadata`),
      icon: MonitorCog,
      tone: 'primary',
    },
    workspaces: {
      label: _(msg`Workspaces`),
      description: _(msg`Per-workspace camera defaults`),
      icon: MonitorCog,
      tone: 'primary',
    },
    ui: {
      label: _(msg`UI & Theme`),
      description: _(msg`Theme and custom UI token customization`),
      icon: Palette,
      tone: 'primary',
    },
    hotkeys: {
      label: _(msg`Hotkeys`),
      description: _(msg`Keyboard bindings and presets`),
      icon: Keyboard,
      tone: 'primary',
    },
    spacemouse: {
      label: _(msg`3D Mouse`),
      description: _(msg`3D mouse navigation controls`),
      icon: Gamepad2,
      tone: 'primary',
    },
    plugins: {
      label: _(msg`Plugins`),
      description: _(msg`Load vendor profile plugins`),
      icon: Plug,
      tone: 'secondary',
    },
    experiments: {
      label: _(msg`Experiments`),
      description: _(msg`Early-access and experimental features`),
      icon: FlaskConical,
      tone: 'secondary',
    },
    sceneAutosave: {
      label: _(msg`Scene Autosave`),
      description: _(msg`Autosave and crash recovery behavior`),
      icon: HardDrive,
      tone: 'secondary',
    },
    backups: {
      label: _(msg`Backups`),
      description: _(msg`Local on-disk backup snapshots`),
      icon: ArchiveRestore,
      tone: 'secondary',
    },
    uvtools: {
      label: _(msg`UVTools`),
      description: _(msg`Send sliced files to UVTools for analysis`),
      icon: ExternalLink,
      tone: 'secondary',
    },
    logging: {
      label: _(msg`Logging`),
      description: _(msg`Log file location and verbosity`),
      icon: ScrollText,
      tone: 'secondary',
    },
    updates: {
      label: _(msg`Updates`),
      description: _(msg`Check for new versions and manage channels`),
      icon: CloudDownload,
      tone: 'secondary',
    },
    about: {
      label: _(msg`About`),
      description: _(msg`Version info and project details`),
      icon: Info,
      tone: 'secondary',
    },
  };

  const sidebarTopTabs: SettingsTabKey[] = ['general', 'camera', 'workspaces', 'mesh', 'performance', 'spacemouse', 'ui', 'hotkeys'];
  const sidebarBottomTabs: SettingsTabKey[] = ['plugins', 'experiments', 'sceneAutosave', 'backups', 'uvtools', 'logging', 'updates', 'about'];


  const ActiveTabIcon = tabMeta[activeTab].icon;
  const activeTabColor = tabMeta[activeTab].tone === 'secondary' ? 'var(--accent-secondary)' : 'var(--accent)';
  const isAboutTab = activeTab === 'about';
  const usesInternalTabScrollLayout = isAboutTab || activeTab === 'hotkeys' || activeTab === 'updates';
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
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
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
              <div className="space-y-1">
                {sidebarTopTabs.map((tab) => {
                  const meta = tabMeta[tab];
                  const Icon = meta.icon;
                  const active = activeTab === tab;
                  const tabColor = meta.tone === 'secondary' ? 'var(--accent-secondary)' : 'var(--accent)';

                  return (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => handleSelectTab(tab)}
                      className="w-full rounded-lg border px-3 py-2 text-left transition-all duration-150"
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
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
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
                          <TabDescription text={meta.description} />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="mt-auto space-y-1 pt-3">
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
                      onClick={() => handleSelectTab(tab)}
                      className="w-full rounded-lg border px-3 py-2 text-left transition-all duration-150"
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
                      <div className="flex items-center gap-2">
                        <span
                          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border"
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
                          <TabDescription text={meta.description} />
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className={usesInternalTabScrollLayout ? 'flex-1 min-h-0 flex flex-col p-4' : 'flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4'}>

            <div key={activeTab} className={usesInternalTabScrollLayout ? 'animate-[settingsTabIn_180ms_ease-out] flex-1 min-h-0 flex flex-col' : 'animate-[settingsTabIn_180ms_ease-out]'}>
              {activeTab === 'general' && (
                <GeneralSettingsTab
                  floatingLayoutPersistence={draftFloatingLayoutPersistence}
                  onFloatingLayoutPersistenceChange={setDraftFloatingLayoutPersistence}
                  onResetFloatingLayout={handleResetFloatingLayout}
                  debugPrimitivesPanelVisible={draftDebugPrimitivesPanelVisible}
                  onDebugPrimitivesPanelVisibleChange={setDraftDebugPrimitivesPanelVisible}
                  importDefaults={draftImportDefaults}
                  onImportDefaultsChange={setDraftImportDefaults}
                  language={draftLocale}
                  onLanguageChange={setDraftLocale}
                />
              )}
              {activeTab === 'camera' && (
                <CameraSettingsTab
                  cameraScope={draftCameraScope}
                  onCameraScopeChange={setDraftCameraScope}
                  cameraProjectionMode={draftCameraProjectionMode}
                  onCameraProjectionModeChange={setDraftCameraProjectionMode}
                  perspectiveFov={draftPerspectiveFov}
                  onPerspectiveFovChange={setDraftPerspectiveFov}
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
                  higherContrastModelEdges={draftHigherContrastModelEdges}
                  onHigherContrastModelEdgesChange={setDraftHigherContrastModelEdges}
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
                  heatmapMinAngle={draftHeatmapMinAngle}
                  heatmapMaxAngle={draftHeatmapMaxAngle}
                  onXrayOpacityChange={setDraftXrayOpacity}
                  onHeatmapMinAngleChange={setDraftHeatmapMinAngle}
                  onHeatmapMaxAngleChange={setDraftHeatmapMaxAngle}
                  heatmapColors={draftHeatmapColors}
                  onHeatmapColorChange={handleDraftHeatmapColorChange}
                  selectionColor={draftSelectionColor}
                  onSelectionColorChange={setDraftSelectionColor}
                  hoverColor={draftHoverColor}
                  onHoverColorChange={setDraftHoverColor}
                  hoverTintStrength={draftHoverTintStrength}
                  onHoverTintStrengthChange={setDraftHoverTintStrength}
                  selectedTintStrength={draftSelectedTintStrength}
                  onSelectedTintStrengthChange={setDraftSelectedTintStrength}
                  defaultSelectionColor={draftThemeColors.accent}
                  defaultHoverColor={draftThemeColors.accent}
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
              {activeTab === 'experiments' && (
                <ExperimentsSettingsTab
                  // Declining the disclaimer returns to the tab the user came
                  // from — unless they deep-linked straight here, in which case
                  // fall back to General rather than re-showing the gate.
                  onExit={() => setActiveTab(previousTabRef.current === 'experiments' ? 'general' : previousTabRef.current)}
                />
              )}
              {activeTab === 'sceneAutosave' && <SceneAutosaveSettingsTab />}
              {activeTab === 'backups' && <LocalBackupsSettingsTab />}
              {activeTab === 'uvtools' && (
                <UvToolsSettingsTab
                  uvToolsSettings={draftUvToolsSettings}
                  onUvToolsSettingsChange={setDraftUvToolsSettings}
                />
              )}
              {activeTab === 'logging' && (
                <LoggingSettingsTab
                  logLevel={draftLogLevel}
                  onLogLevelChange={setDraftLogLevel}
                />
              )}
              {activeTab === 'updates' && (
                <UpdatesSettingsTab
                  channel={updateChannel}
                  onChannelChange={setUpdateChannel}
                />
              )}
              {activeTab === 'about' && (
                <div className="flex h-full min-h-0 flex-col gap-3.5">
                  <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1">
                    <div className="space-y-3.5 pb-2">
                      <div
                        className="rounded-xl p-4"
                        style={{
                          background: 'linear-gradient(145deg, color-mix(in srgb, var(--accent), var(--surface-0) 95%), color-mix(in srgb, var(--accent-secondary), var(--surface-0) 94%))',
                        }}
                      >
                        <div className="relative flex items-center justify-center">
                          <img
                            src="/dragonfruit_assets/branding/text_logo.svg"
                            alt="DragonFruit"
                            className="h-9 w-auto object-contain"
                            style={isLightTheme ? { filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.35))' } : undefined}
                          />
                          <span
                            className="absolute right-0 top-0 inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold"
                            style={{
                              color: '#ffffff',
                              background: 'linear-gradient(135deg, #3b0764 0%, #991b1b 50%, #9a3412 100%)',
                            }}
                          >
                            An Open Resin Alliance Project
                          </span>
                        </div>

                        <div className="mt-3 flex flex-col items-center gap-2">
                          <div className="flex flex-wrap items-center justify-center gap-2.5">
                            <Tooltip
                              content={
                                <span className="whitespace-pre-line">
                                  Click to copy build info{DRAGONFRUIT_GIT_BUILD_LABEL ? `\n${DRAGONFRUIT_GIT_BUILD_LABEL}` : ''}
                                </span>
                              }
                            >
                              <span
                                role="button"
                                tabIndex={0}
                                onClick={handleCopyBuildInfo}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleCopyBuildInfo(); } }}
                                className="inline-flex cursor-pointer items-center rounded-full border px-2.5 py-0.5 text-[12px] font-semibold tabular-nums transition-colors"
                                style={{
                                  color: copied ? '#2d8a4e' : 'var(--text-strong)',
                                  borderColor: copied ? '#2d8a4e' : 'color-mix(in srgb, var(--border-subtle), white 8%)',
                                  background: copied
                                    ? 'rgba(45,138,78,0.1)'
                                    : 'color-mix(in srgb, var(--surface-1), transparent 8%)',
                                }}
                              >
                                {copied ? '✓ Copied!' : `Version ${DRAGONFRUIT_VERSION}`}
                              </span>
                            </Tooltip>
                            <span
                              className="inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold"
                              style={buildStatusStyle}
                            >
                              {buildStatusLabel}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                        <h5 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                          Team & Credits
                        </h5>

                        <div className="mt-2.5 space-y-2">
                          {(() => {
                            const sorted = [...contributors].sort((a, b) => {
                              const toneRank = (t: string) => t === 'founder' ? 0 : t === 'accent' ? 1 : 2;
                              const tr = toneRank(a.tone) - toneRank(b.tone);
                              if (tr !== 0) return tr;
                              return a.name.localeCompare(b.name);
                            });

                            const tones = ['founder', 'accent', 'secondary'] as const;

                            return tones.map((tone, i) => {
                              const people = sorted.filter((p) => p.tone === tone);
                              if (people.length === 0) return null;
                              return (
                                <React.Fragment key={tone}>
                                  {i > 0 && (
                                    <div
                                      className="my-2.5 h-px rounded-full"
                                      style={{
                                        background: 'linear-gradient(90deg, transparent 0%, var(--border-subtle) 22%, var(--border-subtle) 78%, transparent 100%)',
                                      }}
                                    />
                                  )}
                                  <div className="grid grid-cols-2 gap-2">
                                    {people.map((person) => {
                                      const toneVar =
                                        person.tone === 'founder' ? '#d4a017' :
                                        person.tone === 'accent' ? 'var(--accent)' :
                                        'var(--accent-secondary)';
                                      const bgMix = person.tone === 'founder' ? '94%' : person.tone === 'accent' ? '90%' : '93%';
                                      return (
                                        <div
                                          key={person.name}
                                          className="rounded-lg border px-3 py-2.5"
                                          style={{
                                            borderColor: `color-mix(in srgb, ${toneVar}, var(--border-subtle) 45%)`,
                                            background: `color-mix(in srgb, ${toneVar}, var(--surface-0) ${bgMix})`,
                                          }}
                                        >
                                          <div className="flex items-center justify-between gap-2 text-sm">
                                            <span className="font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                                              {person.name}
                                            </span>
                                            <button
                                              type="button"
                                              onClick={async () => {
                                                try {
                                                  const { invoke } = await import('@tauri-apps/api/core');
                                                  await invoke('open_external_url', { url: `https://github.com/${person.affiliation}` });
                                                } catch { /* ignore */ }
                                              }}
                                              className="inline-flex shrink-0 items-center gap-0.5 font-normal hover:underline"
                                              style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                                            >
                                              <Github className="h-3 w-3" />
                                              {person.affiliation}
                                            </button>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </React.Fragment>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    </div>
                  </div>

                  <SponsorsCarousel />


                  <div className="flex items-center gap-4 rounded-xl border px-4 py-3" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 52%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 94%)' }}>
                      <img
                        src={ORA_LOGO_DARK_URL}
                        alt="Open Resin Alliance"
                        className="h-14 w-auto object-contain shrink-0"
                        style={isLightTheme ? { filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.3))' } : undefined}
                      />

                      <div className="min-w-0 flex-1 space-y-2 text-center">
                        <div className="flex items-center justify-center gap-2 text-[12px]">
                          <Github className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                          <button
                            onClick={async () => {
                              const url = DRAGONFRUIT_REPO_URL;
                              try {
                                const { invoke } = await import('@tauri-apps/api/core');
                                await invoke('open_external_url', { url });
                              } catch {
                                window.open(url, '_blank');
                              }
                            }}
                            className="inline-flex items-center gap-1 underline underline-offset-2 font-mono tracking-tighter"
                            style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                          >
                            Open-Resin-Alliance/DragonFruit
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        </div>

                        <div className="flex items-center justify-center gap-2 text-[12px]" style={{ color: 'var(--text-strong)' }}>
                          <ScrollText className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                          <span className="font-mono tracking-tighter">AGPL-3.0-or-later</span>
                        </div>
                      </div>

                      <img
                        src="/dragonfruit_assets/branding/simple_icon.svg"
                        alt=""
                        aria-hidden="true"
                        className="h-10 w-auto object-contain shrink-0"
                      />
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
                  <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Restore Defaults?
                  </h3>
                  <p className="text-xs leading-snug mt-0.5" style={{ color: 'var(--text-muted)' }}>
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
              <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
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
                  className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                    color: 'var(--accent)',
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

      {showReloadPrompt && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowReloadPrompt(false);
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
            aria-label="Apply experiments"
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
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Apply Experiments
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Experiment changes take effect after a restart.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowReloadPrompt(false)}
                className="ui-button ui-button-secondary inline-flex items-center justify-center leading-none !h-8 !w-8 !p-0"
                aria-label="Close restart prompt"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                Reload DragonFruit now to apply your experiment changes? Any unsaved changes to the current scene will be lost.
              </p>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setShowReloadPrompt(false); onClose(); }}
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                >
                  Not Now
                </button>
                <button
                  type="button"
                  onClick={reloadToApplyExperiments}
                  className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                    color: 'var(--accent)',
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reload Now
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
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                color: 'var(--accent)',
              }}
            >
              <Save className="h-3.5 w-3.5" />
              Save Theme
            </button>
          </>
        )}
      >
        <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
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
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                color: 'var(--danger)',
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete Theme
            </button>
          </>
        )}
      >
        <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
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
              className="ui-button !h-9 px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 86%)',
                color: 'var(--accent)',
              }}
              disabled={draftThemeRenameName.trim().length === 0}
            >
              <Check className="h-3.5 w-3.5" />
              {isCreatingCustomThemeName ? 'Create' : 'Save Name'}
            </button>
          </>
        )}
      >
        <div className="space-y-2">
          <label className="block text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
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
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
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
                        className="flex-1 rounded-sm border px-2 py-1 text-xs font-semibold transition-colors"
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
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
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
                <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
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
