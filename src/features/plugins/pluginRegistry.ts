import type { MaterialPreset, MaterialProfile, PrinterPreset } from '@/features/profiles/profileStore';
export type { MaterialPreset };
import type {
  PluginLocalMaterialSettingsAdapterContract,
  PluginMonitoringSnapshotContract,
  PluginMonitoringUiAdapterContract,
  PluginMonitoringWebcamInfoContract,
  PluginNetworkUiAdapterContract,
  PluginSceneOverlayLoaderContract,
  RemoteMaterialProcessValues,
  RemoteMaterialSettingsAdapter,
} from '@/features/plugins/complexPluginContracts';
import { getBuiltinComplexPluginDefinitions } from '@/features/plugins/builtinComplexPlugins';
import { BUILTIN_SIMPLE_PLUGIN_MANIFESTS } from '@/features/plugins/builtinSimplePlugins';
import { normalizeOutputFormat, normalizeFormatVersion, normalizeSettingsMode, normalizeWebcamRotationDeg, DEFAULT_WEBCAM_ROTATION_DEG } from '@/features/profiles/outputFormatUtils';
import { sanitizeDeclaredMaterialSettings } from '@/features/plugins/declaredMaterialSettings';
import { hasWindow } from '@/utils/dom';

export type PluginSource = 'builtin' | 'github';
export type PluginInstallTrust = 'allowlisted' | 'unverified-user-approved';

/**
 * A network backend declared by a package instead of compiled in. The renderer
 * turns it into the same adapter shape `builtinComplexPlugins` registers, so the
 * mode appears in a printer profile's Network Support list and every panel talks
 * to the package through `plugin_network_request`.
 */
export type DeclaredNetworkOperations = {
  connect?: string;
  discover?: string;
  materials?: string;
  materialsEdit?: string;
  printerData?: string;
  status?: string;
  webcamInfo?: string;
  platesList?: string;
  start?: string;
  pause?: string;
  resume?: string;
  cancel?: string;
  deletePlate?: string;
  emergencyStop?: string;
  upload?: string;
};

export type DeclaredNetworkMode = {
  /** The answering plugin. The host refuses a package that names another. */
  pluginId: string;
  /** Lowercase slug a printer profile stores in `networkSupport`. */
  mode: string;
  displayName?: string;
  hostnames: string[];
  operations?: DeclaredNetworkOperations;
};

export type DeclaredMaterialSettings = {
  byOutput?: Record<string, unknown>;
  byOutputAndMode?: Record<string, Record<string, unknown>>;
};

export type PluginManifest = {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  network?: DeclaredNetworkMode;
  /** Material pane schema per output format, in the compiled plugins' own shape. */
  materialSettings?: DeclaredMaterialSettings;
  printerPresets?: PrinterPreset[];
  materialTemplates?: Array<Omit<MaterialProfile, 'id' | 'printerProfileId'>>;
  materialPresets?: MaterialPreset[];
};

export type ProfileNetworkUiAdapter = {
} & PluginNetworkUiAdapterContract;

export type ProfileNetworkModeOption = {
  mode: string;
  displayName: string;
  pluginId: string;
  operationNamespace: string;
};

export type PrinterMonitoringSnapshot = {
} & PluginMonitoringSnapshotContract;

export type PrinterMonitoringWebcamInfo = {
} & PluginMonitoringWebcamInfoContract;

export type ProfileMonitoringUiAdapter = {
} & PluginMonitoringUiAdapterContract;

export type ProfileLocalMaterialSettingsAdapter = {
} & PluginLocalMaterialSettingsAdapterContract;

const NETWORK_ADAPTERS_BY_MODE = new Map<string, ProfileNetworkUiAdapter>();
const MONITORING_ADAPTERS_BY_MODE = new Map<string, ProfileMonitoringUiAdapter>();
const LOCAL_MATERIAL_SETTINGS_BY_OUTPUT = new Map<string, ProfileLocalMaterialSettingsAdapter>();
const LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE = new Map<string, Map<string, ProfileLocalMaterialSettingsAdapter>>();
const SCENE_OVERLAY_LOADERS_BY_PLUGIN_ID = new Map<string, PluginSceneOverlayLoaderContract>();
/** Modes a compiled plugin owns. A package cannot take one over. */
const BUILTIN_NETWORK_MODE_KEYS = new Set<string>();
/** Modes the installed packages added, so a rebuild can retract them. */
const DECLARED_NETWORK_MODE_KEYS = new Set<string>();
/** `output` and `output|mode` keys the installed packages added to the material maps. */
const DECLARED_MATERIAL_SETTINGS_KEYS = new Set<string>();
let builtinAdaptersHydrated = false;
let adaptersHydratedRevision = -1;

function declaredOperationName(declared: DeclaredNetworkMode): (key: keyof DeclaredNetworkOperations) => string {
  return (key) => declared.operations?.[key]?.trim() || key;
}

/**
 * The common payload contract a declared mode answers with. Fixed keys are what
 * let one adapter shape serve every package: a malformed field reads as "no
 * value" instead of leaking a bad type into the monitor panel.
 */
export function parseDeclaredNetworkStatus(payload: unknown): PluginMonitoringSnapshotContract {
  const value = (payload ?? {}) as Record<string, unknown>;
  const numeric = (input: unknown) => {
    const parsed = typeof input === 'number' ? input : Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const text = (input: unknown) => (typeof input === 'string' ? input : null);

  return {
    connected: value.connected === true,
    stateText: text(value.stateText) ?? '',
    isPrinting: value.isPrinting === true,
    isPaused: value.isPaused === true,
    cancelLatched: value.cancelLatched === true,
    pauseLatched: value.pauseLatched === true,
    finished: value.finished === true,
    progressPct: numeric(value.progressPct),
    currentLayer: numeric(value.currentLayer),
    totalLayers: numeric(value.totalLayers),
    plateId: numeric(value.plateId),
    jobName: text(value.jobName),
    etaSec: numeric(value.etaSec),
    thumbnailPath: text(value.thumbnailPath),
    taskId: text(value.taskId),
    taskStatus: numeric(value.taskStatus),
  };
}

export function parseDeclaredNetworkWebcamInfo(payload: unknown): PluginMonitoringWebcamInfoContract {
  const value = (payload ?? {}) as Record<string, unknown>;
  const text = (input: unknown) => (typeof input === 'string' ? input : null);
  return {
    available: value.available === true,
    streamUrl: text(value.streamUrl),
    snapshotUrl: text(value.snapshotUrl),
    message: text(value.message) ?? '',
  };
}

function buildDeclaredNetworkAdapter(declared: DeclaredNetworkMode): ProfileNetworkUiAdapter {
  const operation = declaredOperationName(declared);
  const printerData = declared.operations?.printerData?.trim();
  return {
    mode: declared.mode,
    pluginId: declared.pluginId,
    displayName: declared.displayName ?? declared.mode,
    operationNamespace: declared.mode,
    // On-device material editing needs an edit schema and per-field mapping, which
    // a manifest cannot describe yet, so listing and selection stay off with it.
    supportsRemoteMaterialProfiles: false,
    operations: {
      connect: operation('connect'),
      discover: operation('discover'),
      materials: operation('materials'),
      materialsEdit: operation('materialsEdit'),
      upload: operation('upload'),
      ...(printerData ? { printerData } : {}),
    },
    defaultLocalHostnames: declared.hostnames,
    primaryEditFields: [],
    basicSections: [],
    advancedSections: [],
    resolveEditDraftFromMeta: () => ({}),
    resolveMaterialProcessValues: () => ({}),
    denormalizeEditDraftForBackend: (draft) => ({ ...draft }),
    resolveAdvancedSectionId: () => '',
    getFieldHelpText: () => '',
    isDynamicWaitEnabled: () => false,
  };
}

function buildDeclaredMonitoringAdapter(declared: DeclaredNetworkMode): ProfileMonitoringUiAdapter {
  const operation = declaredOperationName(declared);
  return {
    mode: declared.mode,
    pluginId: declared.pluginId,
    displayName: declared.displayName ?? declared.mode,
    available: true,
    operations: {
      status: operation('status'),
      webcamInfo: operation('webcamInfo'),
      platesList: operation('platesList'),
      start: operation('start'),
      pause: operation('pause'),
      resume: operation('resume'),
      cancel: operation('cancel'),
      deletePlate: operation('deletePlate'),
      emergencyStop: operation('emergencyStop'),
    },
    parseStatusPayload: (payload) => parseDeclaredNetworkStatus(payload),
    parseWebcamInfoPayload: (payload) => parseDeclaredNetworkWebcamInfo(payload),
  };
}

function ensureBuiltinAdaptersHydrated(): void {
  // Presets, templates and declared modes all come from the installed set, so the
  // registry's revision decides whether these maps are still current.
  const revision = getPluginRegistryRevision();
  if (builtinAdaptersHydrated && revision === adaptersHydratedRevision) return;

  if (!builtinAdaptersHydrated) {
    loadBuiltinAdapters();
    builtinAdaptersHydrated = true;
  }

  for (const mode of DECLARED_NETWORK_MODE_KEYS) {
    NETWORK_ADAPTERS_BY_MODE.delete(mode);
    MONITORING_ADAPTERS_BY_MODE.delete(mode);
  }
  DECLARED_NETWORK_MODE_KEYS.clear();

  for (const plugin of getInstalledProfilePlugins()) {
    if (!plugin.enabled) continue;
    const declared = plugin.manifest.network;
    if (!declared || BUILTIN_NETWORK_MODE_KEYS.has(declared.mode)) continue;
    // Two packages claiming one mode: the first installed one answers, so the
    // second cannot silently take the network panel away from it.
    if (NETWORK_ADAPTERS_BY_MODE.has(declared.mode)) continue;
    NETWORK_ADAPTERS_BY_MODE.set(declared.mode, buildDeclaredNetworkAdapter(declared));
    MONITORING_ADAPTERS_BY_MODE.set(declared.mode, buildDeclaredMonitoringAdapter(declared));
    DECLARED_NETWORK_MODE_KEYS.add(declared.mode);
  }

  registerDeclaredMaterialSettings();

  adaptersHydratedRevision = revision;
}

/**
 * Material pane schemas a package declares. Compiled plugins own their output
 * format, so a package fills a format nobody else claims; within a format it may
 * add modes, never replace one.
 */
function registerDeclaredMaterialSettings(): void {
  for (const key of DECLARED_MATERIAL_SETTINGS_KEYS) {
    const [output, mode] = key.split('|');
    if (mode) {
      const modeMap = LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE.get(output);
      modeMap?.delete(mode);
      if (modeMap && modeMap.size === 0) LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE.delete(output);
    } else {
      LOCAL_MATERIAL_SETTINGS_BY_OUTPUT.delete(output);
    }
  }
  DECLARED_MATERIAL_SETTINGS_KEYS.clear();

  for (const plugin of getInstalledProfilePlugins()) {
    if (!plugin.enabled) continue;
    const declared = plugin.manifest.materialSettings;
    if (!declared) continue;

    for (const [rawOutput, source] of Object.entries(declared.byOutput ?? {})) {
      const output = normalizeOutputFormat(rawOutput);
      if (!output || LOCAL_MATERIAL_SETTINGS_BY_OUTPUT.has(output)) continue;
      const adapter = sanitizeDeclaredMaterialSettings(output, source);
      if (!adapter) continue;
      LOCAL_MATERIAL_SETTINGS_BY_OUTPUT.set(output, adapter);
      DECLARED_MATERIAL_SETTINGS_KEYS.add(output);
    }

    for (const [rawOutput, modes] of Object.entries(declared.byOutputAndMode ?? {})) {
      const output = normalizeOutputFormat(rawOutput);
      if (!output || !modes) continue;
      const modeMap = LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE.get(output);
      const additions: Array<[string, ProfileLocalMaterialSettingsAdapter]> = [];
      for (const [rawMode, source] of Object.entries(modes)) {
        const mode = normalizeSettingsMode(rawMode);
        if (!mode || modeMap?.has(mode)) continue;
        const adapter = sanitizeDeclaredMaterialSettings(output, source, modes);
        if (adapter) additions.push([mode, adapter]);
      }
      if (additions.length === 0) continue;
      const target = modeMap ?? new Map<string, ProfileLocalMaterialSettingsAdapter>();
      for (const [mode, adapter] of additions) {
        target.set(mode, adapter);
        DECLARED_MATERIAL_SETTINGS_KEYS.add(`${output}|${mode}`);
      }
      LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE.set(output, target);
    }
  }
}

function loadBuiltinAdapters(): void {
  getBuiltinComplexPluginDefinitions().forEach((definition) => {
    const networkAdapters = definition.networkAdaptersByMode ?? {};
    Object.values(networkAdapters).forEach((adapter) => {
      NETWORK_ADAPTERS_BY_MODE.set(adapter.mode, adapter);
      BUILTIN_NETWORK_MODE_KEYS.add(adapter.mode);
    });

    const monitoringAdapters = definition.monitoringAdaptersByMode ?? {};
    Object.values(monitoringAdapters).forEach((adapter) => {
      MONITORING_ADAPTERS_BY_MODE.set(adapter.mode, adapter);
    });

    const localMaterialAdapters = definition.localMaterialSettingsByOutput ?? {};
    Object.entries(localMaterialAdapters).forEach(([outputFormat, adapter]) => {
      const normalized = normalizeOutputFormat(outputFormat);
      // A key that is not a format declares nothing to attach settings to.
      if (!normalized) return;
      LOCAL_MATERIAL_SETTINGS_BY_OUTPUT.set(normalized, {
        ...adapter,
        outputFormat: normalized,
      });
    });

    const localMaterialAdaptersByMode = definition.localMaterialSettingsByOutputAndMode ?? {};
    Object.entries(localMaterialAdaptersByMode).forEach(([outputFormat, adaptersByMode]) => {
      const normalizedOutput = normalizeOutputFormat(outputFormat);
      // Same rule as the per-output map above.
      if (!normalizedOutput) return;
      const modeMap = LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE.get(normalizedOutput) ?? new Map<string, ProfileLocalMaterialSettingsAdapter>();

      Object.entries(adaptersByMode ?? {}).forEach(([settingsMode, adapter]) => {
        const normalizedMode = normalizeSettingsMode(settingsMode);
        if (!normalizedMode) return;

        modeMap.set(normalizedMode, {
          ...adapter,
          outputFormat: normalizedOutput,
        });
      });

      if (modeMap.size > 0) {
        LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE.set(normalizedOutput, modeMap);
      }
    });

    if (definition.sceneOverlayLoader) {
      SCENE_OVERLAY_LOADERS_BY_PLUGIN_ID.set(definition.id, definition.sceneOverlayLoader);
    }
  });
}

const GENERIC_MONITORING_STUB_ADAPTER: ProfileMonitoringUiAdapter = {
  mode: 'generic',
  pluginId: null,
  displayName: 'Generic Monitoring Stub',
  available: false,
  operations: null,
  parseStatusPayload: () => ({
    connected: false,
    stateText: 'Monitoring unavailable for this backend.',
    isPrinting: false,
    isPaused: false,
    cancelLatched: false,
    pauseLatched: false,
    finished: false,
    progressPct: null,
    currentLayer: null,
    totalLayers: null,
    plateId: null,
    jobName: null,
    etaSec: null,
  }),
  parseWebcamInfoPayload: () => ({
    available: false,
    streamUrl: null,
    snapshotUrl: null,
    message: 'Webcam feed unavailable for this backend.',
  }),
};

export function getProfileNetworkUiAdapter(mode: string | null | undefined): ProfileNetworkUiAdapter | null {
  ensureBuiltinAdaptersHydrated();
  if (!mode || typeof mode !== 'string') return null;
  return NETWORK_ADAPTERS_BY_MODE.get(mode.trim().toLowerCase()) ?? null;
}

export function getDefaultProfileNetworkUiAdapter(): ProfileNetworkUiAdapter {
  ensureBuiltinAdaptersHydrated();
  const first = NETWORK_ADAPTERS_BY_MODE.values().next().value as ProfileNetworkUiAdapter | undefined;
  if (!first) {
    throw new Error('No built-in profile network adapters registered');
  }
  return first;
}

export function getAvailableProfileNetworkModes(): ProfileNetworkModeOption[] {
  ensureBuiltinAdaptersHydrated();
  return Array.from(NETWORK_ADAPTERS_BY_MODE.values())
    .map((adapter) => ({
      mode: adapter.mode,
      displayName: adapter.displayName,
      pluginId: adapter.pluginId,
      operationNamespace: adapter.operationNamespace,
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function getProfileMonitoringUiAdapter(mode: string | null | undefined): ProfileMonitoringUiAdapter {
  ensureBuiltinAdaptersHydrated();
  if (!mode || typeof mode !== 'string') return GENERIC_MONITORING_STUB_ADAPTER;
  return MONITORING_ADAPTERS_BY_MODE.get(mode.trim().toLowerCase()) ?? GENERIC_MONITORING_STUB_ADAPTER;
}

export function getProfileLocalMaterialSettingsAdapter(
  outputFormat: string | null | undefined,
  settingsMode?: string | null | undefined,
): ProfileLocalMaterialSettingsAdapter | null {
  ensureBuiltinAdaptersHydrated();
  if (!outputFormat || typeof outputFormat !== 'string') return null;

  const normalizedOutput = normalizeOutputFormat(outputFormat);
  if (!normalizedOutput) return null;
  const normalizedMode = normalizeSettingsMode(settingsMode);

  if (normalizedMode) {
    const modeMap = LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE.get(normalizedOutput);
    const modeMatch = modeMap?.get(normalizedMode);
    if (modeMatch) return modeMatch;
  }

  const fallbackByOutput = LOCAL_MATERIAL_SETTINGS_BY_OUTPUT.get(normalizedOutput);
  if (fallbackByOutput) return fallbackByOutput;

  const modeMap = LOCAL_MATERIAL_SETTINGS_BY_OUTPUT_AND_MODE.get(normalizedOutput);
  if (!modeMap || modeMap.size === 0) return null;

  const explicitDefault = modeMap.get('default');
  if (explicitDefault) return explicitDefault;

  const first = Array.from(modeMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))[0]?.[1];
  return first ?? null;
}

/**
 * Resolve a plugin-owned scene overlay loader from the central registry.
 *
 * The host can turn the returned loader into a client-side lazy component
 * without importing the plugin module directly, keeping plugin ownership
 * centralized.
 */
export function getPluginSceneOverlayLoader(
  pluginId: string | null | undefined,
): PluginSceneOverlayLoaderContract | null {
  ensureBuiltinAdaptersHydrated();
  if (!pluginId || typeof pluginId !== 'string') return null;
  return SCENE_OVERLAY_LOADERS_BY_PLUGIN_ID.get(pluginId.trim().toLowerCase()) ?? null;
}

export type InstalledProfilePlugin = {
  manifest: PluginManifest;
  enabled: boolean;
  source: PluginSource;
  sourceUrl?: string;
  manifestSha256?: string;
  installTrust?: PluginInstallTrust;
  liabilityAcceptedAt?: string;
  installedAt: string;
};

type PersistedPluginEnvelope = {
  version: number;
  plugins: InstalledProfilePlugin[];
};

const STORAGE_KEY = 'dragonfruit-plugins-v1';

/**
 * Bumped whenever the installed set changes. Presets and templates are derived
 * from this registry, so a consumer that memoised them needs a reason to look
 * again; the profile store's snapshot carries this number.
 */
let registryRevision = 0;

export function getPluginRegistryRevision(): number {
  hydratePluginRegistry();
  return registryRevision;
}
const STORAGE_VERSION = 1;
const MAX_PRINTER_PRESETS = 128;
const MAX_MATERIAL_TEMPLATES = 512;
const MAX_MATERIAL_PRESETS = 2048;

function shouldUseBundledAssetPaths(): boolean {
  if (!hasWindow()) return false;
  if (process.env.NODE_ENV !== 'production') return false;
  const protocol = window.location?.protocol ?? '';
  const hostname = window.location?.hostname ?? '';
  const hasTauriInternals = typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined';
  return protocol === 'file:' || protocol === 'tauri:' || hostname === 'tauri.localhost' || hasTauriInternals;
}

function resolveRuntimeAssetPath(value: string): string {
  const isBundledRuntime = shouldUseBundledAssetPaths();

  if (value.startsWith('/api/profile-assets/')) {
    if (!isBundledRuntime) return value;
    return `/${value.slice('/api/profile-assets/'.length)}`;
  }

  if (value.startsWith('/plugins/') || value.startsWith('/printers/')) {
    if (isBundledRuntime) return value;
    return `/api/profile-assets${value}`;
  }

  return value;
}

function boundedString(value: unknown, max = 120): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitizeOptionalPositiveNumber(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function sanitizeProfileVersion(value: unknown): number | undefined {
  const n = sanitizeOptionalPositiveNumber(value);
  if (n == null) return undefined;
  return Math.max(1, Math.round(n));
}

function sanitizeOutputFormat(value: unknown): PrinterPreset['display']['outputFormat'] {
  // A preset without a usable format keeps an empty one rather than borrowing
  // another plugin's: the printer picker shows it and slicing names it.
  return normalizeOutputFormat(value) ?? '';
}

function sanitizeNetworkSupport(value: unknown): PrinterPreset['networkSupport'] {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return normalized;
}

const NETWORK_MODE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const NETWORK_OPERATION_PATTERN = /^[a-z0-9_./-]{1,64}$/;
const NETWORK_HOSTNAME_PATTERN = /^[a-z0-9.-]{1,253}$/;

function sanitizeDeclaredNetwork(mode: unknown): DeclaredNetworkMode | null {
  const value = (mode ?? {}) as Record<string, unknown>;
  const pluginId = boundedString(value.pluginId, 120);
  const name = boundedString(value.mode, 48).toLowerCase();
  if (!pluginId || !NETWORK_MODE_PATTERN.test(name)) return null;

  const displayName = boundedString(value.displayName, 64);
  const hostnames = Array.isArray(value.hostnames)
    ? value.hostnames
      .slice(0, 8)
      .map((entry) => boundedString(entry, 253).toLowerCase())
      .filter((entry) => NETWORK_HOSTNAME_PATTERN.test(entry))
    : [];

  const declaredOperations = (value.operations ?? {}) as Record<string, unknown>;
  const operations: DeclaredNetworkOperations = {};
  for (const key of ['connect', 'discover', 'materials', 'materialsEdit', 'printerData', 'status', 'webcamInfo', 'platesList', 'start', 'pause', 'resume', 'cancel', 'deletePlate', 'emergencyStop', 'upload'] as const) {
    const operation = boundedString(declaredOperations[key], 64);
    if (operation && NETWORK_OPERATION_PATTERN.test(operation)) operations[key] = operation;
  }

  return {
    pluginId,
    mode: name,
    displayName: displayName || undefined,
    hostnames,
    operations,
  };
}

function sanitizeDeclaredMaterialSettingsMap(value: unknown): DeclaredMaterialSettings | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const byOutput: Record<string, unknown> = {};
  if (source.byOutput && typeof source.byOutput === 'object' && !Array.isArray(source.byOutput)) {
    for (const [key, entry] of Object.entries(source.byOutput as Record<string, unknown>).slice(0, 8)) {
      if (entry && typeof entry === 'object') byOutput[key] = entry;
    }
  }
  const byOutputAndMode: Record<string, Record<string, unknown>> = {};
  if (source.byOutputAndMode && typeof source.byOutputAndMode === 'object' && !Array.isArray(source.byOutputAndMode)) {
    for (const [key, entry] of Object.entries(source.byOutputAndMode as Record<string, unknown>).slice(0, 8)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const modes: Record<string, unknown> = {};
      for (const [mode, modeSource] of Object.entries(entry as Record<string, unknown>).slice(0, 8)) {
        if (modeSource && typeof modeSource === 'object') modes[mode] = modeSource;
      }
      if (Object.keys(modes).length > 0) byOutputAndMode[key] = modes;
    }
  }
  if (Object.keys(byOutput).length === 0 && Object.keys(byOutputAndMode).length === 0) return null;
  return { byOutput, byOutputAndMode };
}

function sanitizeImageAssetPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (
    trimmed.startsWith('/api/profile-assets/')
    || trimmed.startsWith('/plugins/')
    || trimmed.startsWith('/printers/')
  ) {
    return resolveRuntimeAssetPath(trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('data:')) return undefined;

  return undefined;
}

function sanitizePlatformBadge(input: unknown): PrinterPreset['platformBadge'] {
  const value = (input ?? {}) as Record<string, unknown>;
  const text = boundedString(value.text, 48);
  if (!text) return undefined;
  const color = boundedString(value.color, 24);
  return {
    text,
    color: color || undefined,
  };
}

function sanitizePixelSize(input: unknown): PrinterPreset['pixelSize'] {
  const value = (input ?? {}) as Record<string, unknown>;
  const x = sanitizeOptionalPositiveNumber(value.x);
  const y = sanitizeOptionalPositiveNumber(value.y);
  if (x == null || y == null) return undefined;
  return { x, y };
}

function sanitizeBitDepth(input: unknown): PrinterPreset['bitDepth'] {
  const value = (input ?? {}) as Record<string, unknown>;
  const bits = sanitizeOptionalPositiveNumber(value.bits);
  if (bits == null) return undefined;
  const description = boundedString(value.description, 240);
  return {
    bits: Math.round(bits),
    description: description || undefined,
  };
}

function sanitizeModelVariants(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const ids = input
    .slice(0, 32)
    .map((value) => boundedString(value, 120))
    .filter((value): value is string => value.length > 0);
  return ids.length > 0 ? ids : undefined;
}

function resolveBuildDimensionMm(
  explicitValue: unknown,
  resolutionPx: number,
  pixelSizeUm: number | undefined,
  fallbackMm: number,
): number {
  const explicit = sanitizeOptionalPositiveNumber(explicitValue);
  if (explicit != null) return explicit;
  if (pixelSizeUm != null) return (resolutionPx * pixelSizeUm) / 1000;
  return fallbackMm;
}

function sanitizeSafetyMarginMm(input: unknown): PrinterPreset['safetyMarginMm'] {
  if (!input || typeof input !== 'object') return undefined;
  const src = input as Record<string, unknown>;
  const clampEdge = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    front: clampEdge(src.front),
    back: clampEdge(src.back),
    left: clampEdge(src.left),
    right: clampEdge(src.right),
  };
}

function sanitizePrinterPreset(input: unknown): PrinterPreset | null {
  const value = (input ?? {}) as Record<string, unknown>;

  const presetId = boundedString(value.presetId, 120);
  const manufacturer = boundedString(value.manufacturer, 80);
  const name = boundedString(value.name, 120);
  const family = boundedString(value.family, 80);
  if (!presetId || !manufacturer || !name) return null;

  const resolutionX = Math.round(sanitizeNumber((value as any).display?.resolutionX, 2560, 1, 200000));
  const resolutionY = Math.round(sanitizeNumber((value as any).display?.resolutionY, 1620, 1, 200000));
  const pixelSize = sanitizePixelSize((value as any).pixelSize);
  const explicitBuildWidth = sanitizeOptionalPositiveNumber((value as any).buildVolumeMm?.width);
  const explicitBuildDepth = sanitizeOptionalPositiveNumber((value as any).buildVolumeMm?.depth);
  const buildDimensionMode: PrinterPreset['buildDimensionMode'] =
    explicitBuildWidth == null
      && explicitBuildDepth == null
      && pixelSize != null
      ? 'auto'
      : 'manual';

  return {
    presetId,
    profileVersion: sanitizeProfileVersion((value as any).profileVersion),
    manufacturer,
    name,
    family: family || undefined,
    imageAssetPath: sanitizeImageAssetPath(value.imageAssetPath),
    antiAliasing: typeof value.antiAliasing === 'boolean' ? value.antiAliasing : undefined,
    hasCamera: typeof value.hasCamera === 'boolean' ? value.hasCamera : undefined,
    networkSupport: sanitizeNetworkSupport(value.networkSupport),
    networkFilter: boundedString((value as any).networkFilter, 120) || undefined,
    platformBadge: sanitizePlatformBadge((value as any).platformBadge),
    pixelSize,
    bitDepth: sanitizeBitDepth((value as any).bitDepth),
    modelVariants: sanitizeModelVariants((value as any).modelVariants),
    modelVariantDetectPath: boundedString((value as any).modelVariantDetectPath, 240) || undefined,
    libraryDisplayName: boundedString((value as any).libraryDisplayName, 120) || undefined,
    isModelVariant: typeof value.isModelVariant === 'boolean' ? value.isModelVariant : undefined,
    buildDimensionMode,
    buildVolumeMm: {
      width: resolveBuildDimensionMm((value as any).buildVolumeMm?.width, resolutionX, pixelSize?.x, 143),
      depth: resolveBuildDimensionMm((value as any).buildVolumeMm?.depth, resolutionY, pixelSize?.y, 89),
      height: sanitizeNumber((value as any).buildVolumeMm?.height, 175, 1, 10000),
    },
    safetyMarginMm: sanitizeSafetyMarginMm((value as any).safetyMarginMm),
    display: {
      resolutionX,
      resolutionY,
      outputFormat: sanitizeOutputFormat((value as any).display?.outputFormat),
      formatVersion: normalizeFormatVersion((value as any).display?.formatVersion),
      settingsMode: normalizeSettingsMode((value as any).display?.settingsMode),
      webcamRotationDeg: normalizeWebcamRotationDeg(
        (value as any).display?.webcamRotationDeg ?? (value as any).display?.webcamOrientation,
        DEFAULT_WEBCAM_ROTATION_DEG,
      ),
      mirrorX: typeof (value as any).display?.mirrorX === 'boolean'
        ? (value as any).display.mirrorX
        : undefined,
      mirrorY: typeof (value as any).display?.mirrorY === 'boolean'
        ? (value as any).display.mirrorY
        : undefined,
    },
  };
}

function sanitizeMaterialPreset(input: unknown): MaterialPreset | null {
  const base = sanitizeMaterialTemplate(input);
  if (!base) return null;

  const value = (input ?? {}) as Record<string, unknown>;
  const templateId = boundedString(value.templateId as string | undefined, 200) || undefined;
  const profileVersion = Number.isFinite(Number(value.profileVersion)) ? Number(value.profileVersion) : undefined;
  const validForPresets = Array.isArray(value.validForPresets)
    ? (value.validForPresets as unknown[])
      .slice(0, 256)
      .map((v) => boundedString(v as string, 120))
      .filter((v): v is string => v.length > 0)
    : undefined;

  const localSettingsByOutput = value.localSettingsByOutput && typeof value.localSettingsByOutput === 'object' && !Array.isArray(value.localSettingsByOutput)
    ? Object.fromEntries(
        Object.entries(value.localSettingsByOutput as Record<string, unknown>)
          .slice(0, 32)
          .map(([format, settings]) => [
            format,
            settings && typeof settings === 'object' && !Array.isArray(settings)
              ? Object.fromEntries(
                  Object.entries(settings as Record<string, unknown>)
                    .slice(0, 256)
                    .map(([k, v]) => [k, typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string' ? v : 0]),
                )
              : {},
          ]),
      )
    : undefined;

  return {
    ...base,
    ...(templateId !== undefined ? { templateId } : {}),
    ...(profileVersion !== undefined ? { profileVersion } : {}),
    ...(validForPresets !== undefined ? { validForPresets } : {}),
    ...(localSettingsByOutput !== undefined ? { localSettingsByOutput } : {}),
  };
}

function sanitizeMaterialTemplate(input: unknown): Omit<MaterialProfile, 'id' | 'printerProfileId'> | null {
  const value = (input ?? {}) as Record<string, unknown>;
  const name = boundedString(value.name, 120);
  if (!name) return null;

  const resinFamilyRaw = boundedString(value.resinFamily, 32).toLowerCase();
  const resinFamily: MaterialProfile['resinFamily'] = (
    resinFamilyRaw === 'standard'
    || resinFamilyRaw === 'abs-like'
    || resinFamilyRaw === 'tough'
    || resinFamilyRaw === 'flexible'
    || resinFamilyRaw === 'engineering'
    || resinFamilyRaw === 'other'
  )
    ? resinFamilyRaw
    : 'standard';

  return {
    name,
    brand: boundedString(value.brand, 80) || 'Default',
    currencyCode: (boundedString(value.currencyCode, 3) || 'USD').toUpperCase(),
    bottlePrice: sanitizeNumber(value.bottlePrice, 0, 0, 1000000),
    bottleCapacityMl: sanitizeNumber(value.bottleCapacityMl, 1000, 1, 1000000),
    resinFamily,
    scaleCompensationPct: {
      x: sanitizeNumber((value as any).scaleCompensationPct?.x, 0, -100, 100),
      y: sanitizeNumber((value as any).scaleCompensationPct?.y, 0, -100, 100),
      z: sanitizeNumber((value as any).scaleCompensationPct?.z, 0, -100, 100),
    },
    layerHeightMm: sanitizeNumber(value.layerHeightMm, 0.05, 0.001, 10),
    normalExposureSec: sanitizeNumber(value.normalExposureSec, 2.5, 0.01, 10000),
    bottomExposureSec: sanitizeNumber(value.bottomExposureSec, 28, 0.01, 10000),
    bottomLayerCount: Math.round(sanitizeNumber(value.bottomLayerCount, 5, 0, 100000)),
    liftDistanceMm: sanitizeNumber(value.liftDistanceMm, 6, 0, 1000),
    liftSpeedMmMin: sanitizeNumber(value.liftSpeedMmMin, 60, 0, 100000),
    retractSpeedMmMin: sanitizeNumber(value.retractSpeedMmMin, 150, 0, 100000),
    minimumAaAlphaPercent: sanitizeNumber(value.minimumAaAlphaPercent, 35, 0, 100),
    antiAliasingSettings: (value.antiAliasingSettings && typeof value.antiAliasingSettings === 'object')
      ? value.antiAliasingSettings as MaterialProfile['antiAliasingSettings']
      : {
        enableCustomSettings: false,
        enableOverride: false,
        mode: 'Blur',
        level: '4x',
        useCustomLevel: false,
        blurBrushRadiusPx: 1,
        useCustomBlurBrushRadius: false,
        blurBrushKernel: 'gaussian',
        blurBrushSigmaX: 0.5,
        blurBrushSigmaY: 0.5,
        zBlurRadiusLayers: 0,
        useCustomZBlurRadius: false,
        zBlurKernel: 'box',
        zBlurSigma: 0.5,
        zBlendLookBack: 2,
        useCustomZBlendLookBack: false,
        zBlendAutoMode: true,
        zaaPattern: 'halton',
        zaaDuplicateZ: true,
        blurGraySourceMode: 'lut',
        zBlendResinType: 'opaque',
        tipOffsetMode: 'auto',
        tipOffsetMm: 0.05,
        tipOffsetDisplayInUi: false,
        supportTipShrinkPercent: 10,
        selectedLutCurveId: 'default',
        aaOnSupports: false,
        ditherEnabled: false,
        ditherBitDepth: 3,
        ditherDeviceGamma: 3.0,
      },
  };
}

const BUILTIN_COMPLEX_PLUGINS: InstalledProfilePlugin[] = getBuiltinComplexPluginDefinitions()
  .flatMap((definition) => {
    const manifest = sanitizeManifest({
      schemaVersion: 1,
      ...definition.manifest,
    });
    if (!manifest) return [];
    return [{
      manifest,
      enabled: true,
      source: 'builtin' as const,
      sourceUrl: `builtin://plugins/${definition.id}`,
      installedAt: new Date(0).toISOString(),
    }];
  });

let hydrated = false;
let externalPlugins: InstalledProfilePlugin[] = [];

function sanitizeManifest(input: unknown): PluginManifest | null {
  const value = (input ?? {}) as any;

  const id = boundedString(value.id, 120);
  const name = boundedString(value.name, 120);
  const version = boundedString(value.version, 48);

  if (!id || !name || !version) return null;

  const schemaVersion = Number.isFinite(Number(value.schemaVersion)) ? Number(value.schemaVersion) : 1;
  const printerPresets = Array.isArray(value.printerPresets)
    ? value.printerPresets
      .slice(0, MAX_PRINTER_PRESETS)
      .map((preset: unknown) => sanitizePrinterPreset(preset))
      .filter((preset: PrinterPreset | null): preset is PrinterPreset => preset !== null)
    : [];

  const materialTemplates = Array.isArray(value.materialTemplates)
    ? value.materialTemplates
      .slice(0, MAX_MATERIAL_TEMPLATES)
      .map((template: unknown) => sanitizeMaterialTemplate(template))
      .filter((template: Omit<MaterialProfile, 'id' | 'printerProfileId'> | null): template is Omit<MaterialProfile, 'id' | 'printerProfileId'> => template !== null)
    : [];

  const materialPresets = Array.isArray(value.materialPresets)
    ? value.materialPresets
      .slice(0, MAX_MATERIAL_PRESETS)
      .map((preset: unknown) => sanitizeMaterialPreset(preset))
      .filter((preset: MaterialPreset | null): preset is MaterialPreset => preset !== null)
    : [];

  return {
    schemaVersion,
    id,
    name,
    version,
    description: boundedString(value.description, 500) || undefined,
    author: boundedString(value.author, 120) || undefined,
    homepage: boundedString(value.homepage, 500) || undefined,
    network: sanitizeDeclaredNetwork(value.network) ?? undefined,
    materialSettings: sanitizeDeclaredMaterialSettingsMap(value.materialSettings) ?? undefined,
    printerPresets,
    materialTemplates,
    materialPresets,
  };
}

const BUILTIN_SIMPLE_PLUGINS: InstalledProfilePlugin[] = BUILTIN_SIMPLE_PLUGIN_MANIFESTS
  .map((manifest) => sanitizeManifest(manifest))
  .filter((manifest): manifest is PluginManifest => manifest !== null)
  .map((manifest) => ({
    manifest,
    enabled: true,
    source: 'builtin' as const,
    sourceUrl: `builtin://plugins/${manifest.id}`,
    installedAt: new Date(0).toISOString(),
  }));

function sanitizeInstalledPlugin(input: unknown): InstalledProfilePlugin | null {
  const value = (input ?? {}) as any;
  const manifest = sanitizeManifest(value.manifest);
  if (!manifest) return null;

  const manifestSha256 = typeof value.manifestSha256 === 'string' && /^[a-fA-F0-9]{64}$/.test(value.manifestSha256.trim())
    ? value.manifestSha256.trim().toLowerCase()
    : undefined;
  const installTrust = value.installTrust === 'allowlisted' || value.installTrust === 'unverified-user-approved'
    ? value.installTrust
    : undefined;
  const liabilityAcceptedAt = typeof value.liabilityAcceptedAt === 'string' && value.liabilityAcceptedAt.trim().length > 0
    ? value.liabilityAcceptedAt
    : undefined;

  return {
    manifest,
    enabled: value.enabled !== false,
    source: value.source === 'github' ? 'github' : 'builtin',
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : undefined,
    manifestSha256,
    installTrust,
    liabilityAcceptedAt,
    installedAt: typeof value.installedAt === 'string' ? value.installedAt : new Date().toISOString(),
  };
}

function save() {
  if (!hasWindow()) return;
  try {
    const envelope: PersistedPluginEnvelope = {
      version: STORAGE_VERSION,
      plugins: externalPlugins,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch (error) {
    console.error('[PluginRegistry] Failed to persist plugins', error);
  }
}

export function hydratePluginRegistry() {
  if (hydrated) return;
  hydrated = true;
  if (!hasWindow()) return;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      externalPlugins = [];
      return;
    }

    const parsed = JSON.parse(raw) as PersistedPluginEnvelope;
    const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    externalPlugins = plugins
      .map((plugin) => sanitizeInstalledPlugin(plugin))
      .filter((plugin): plugin is InstalledProfilePlugin => plugin !== null && plugin.source !== 'builtin');
    registryRevision += 1;
  } catch (error) {
    console.error('[PluginRegistry] Failed to hydrate plugins', error);
    externalPlugins = [];
  }
}

export function getInstalledProfilePlugins(): InstalledProfilePlugin[] {
  hydratePluginRegistry();
  return [...BUILTIN_COMPLEX_PLUGINS, ...BUILTIN_SIMPLE_PLUGINS, ...externalPlugins];
}

export function installExternalProfilePlugin(
  manifestInput: PluginManifest,
  sourceUrl?: string,
  options?: { manifestSha256?: string; installTrust?: PluginInstallTrust; liabilityAcceptedAt?: string },
): InstalledProfilePlugin {
  hydratePluginRegistry();
  const manifest = sanitizeManifest(manifestInput);
  if (!manifest) throw new Error('Invalid plugin manifest');
  const manifestSha256 = typeof options?.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(options.manifestSha256.trim())
    ? options.manifestSha256.trim().toLowerCase()
    : undefined;
  const installTrust = options?.installTrust === 'allowlisted' || options?.installTrust === 'unverified-user-approved'
    ? options.installTrust
    : undefined;
  const liabilityAcceptedAt = installTrust === 'unverified-user-approved'
    ? (typeof options?.liabilityAcceptedAt === 'string' && options.liabilityAcceptedAt.trim().length > 0
      ? options.liabilityAcceptedAt
      : new Date().toISOString())
    : undefined;

  const plugin: InstalledProfilePlugin = {
    manifest,
    enabled: true,
    source: 'github',
    sourceUrl,
    manifestSha256,
    installTrust,
    liabilityAcceptedAt,
    installedAt: new Date().toISOString(),
  };

  externalPlugins = [
    ...externalPlugins.filter((existing) => existing.manifest.id !== manifest.id),
    plugin,
  ];

  registryRevision += 1;
  save();
  return plugin;
}

export function uninstallExternalProfilePlugin(pluginId: string): boolean {
  hydratePluginRegistry();
  const before = externalPlugins.length;
  externalPlugins = externalPlugins.filter((plugin) => plugin.manifest.id !== pluginId);
  const changed = externalPlugins.length !== before;
  if (changed) {
    registryRevision += 1;
    save();
  }
  return changed;
}

export function getRuntimePrinterPresets(basePresets: PrinterPreset[]): PrinterPreset[] {
  hydratePluginRegistry();
  const byId = new Map<string, PrinterPreset>();
  const pluginPresets = getInstalledProfilePlugins()
    .flatMap((plugin) => plugin.enabled ? (plugin.manifest.printerPresets ?? []) : []);

  [...basePresets, ...pluginPresets]
    .forEach((preset) => {
      if (!preset?.presetId) return;
      const nextImageAssetPath = sanitizeImageAssetPath(preset.imageAssetPath);
      if (nextImageAssetPath !== preset.imageAssetPath) {
        byId.set(preset.presetId, {
          ...preset,
          imageAssetPath: nextImageAssetPath,
        });
        return;
      }
      byId.set(preset.presetId, preset);
    });

  return Array.from(byId.values());
}

export function getRuntimeMaterialTemplates(baseTemplates: Array<Omit<MaterialProfile, 'id' | 'printerProfileId'>>): Array<Omit<MaterialProfile, 'id' | 'printerProfileId'>> {
  hydratePluginRegistry();
  const pluginTemplates = getInstalledProfilePlugins()
    .flatMap((plugin) => plugin.enabled ? (plugin.manifest.materialTemplates ?? []) : []);

  return [
    ...baseTemplates,
    ...pluginTemplates,
  ];
}

/**
 * Returns true if the given presetId matches a pattern.
 * Supports exact strings and glob patterns containing `*`.
 */
export function matchesPresetPattern(pattern: string, presetId: string): boolean {
  if (!pattern.includes('*')) return pattern === presetId;
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return regex.test(presetId);
}

/**
 * Returns all MaterialPresets from enabled plugins, optionally filtered
 * to only those whose `validForPresets` contains a pattern matching the given presetId.
 */
export function getRuntimeMaterialPresets(printerPresetId?: string): MaterialPreset[] {
  hydratePluginRegistry();
  const allPresets = getInstalledProfilePlugins()
    .flatMap((plugin) => plugin.enabled ? (plugin.manifest.materialPresets ?? []) : []);

  if (!printerPresetId) return allPresets;

  return allPresets.filter((preset) => {
    if (!preset.validForPresets || preset.validForPresets.length === 0) return true;
    return preset.validForPresets.some((pattern) => matchesPresetPattern(pattern, printerPresetId));
  });
}
