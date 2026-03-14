import type { MaterialProfile, PrinterPreset } from '@/features/profiles/profileStore';
import { ATHENA_PLUGIN_MANIFEST } from '../../../plugins/athena/pluginManifest';
import {
  NANODLP_ADVANCED_SECTIONS,
  NANODLP_BASIC_SECTIONS,
  NANODLP_PRIMARY_EDIT_FIELDS,
  denormalizeNanodlpEditDraftForBackend,
  getNanoDlpFieldHelpText,
  isNanoDlpDynamicWaitEnabled,
  resolveNanodlpEditDraftFromMeta,
  resolveNanoDlpAdvancedSectionId,
  resolveNanodlpMaterialProcessValues,
  type NanoDlpAdvancedSectionDef,
  type NanoDlpBasicSection,
  type NanoDlpPrimaryEditField,
} from '../../../plugins/athena/nanodlpProfilePlugin';
import {
  resolveNanodlpMonitoringSnapshot,
  resolveNanodlpWebcamFeedInfo,
} from '../../../plugins/athena/network';

export type PluginSource = 'builtin' | 'github';

export type PluginManifest = {
  schemaVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  homepage?: string;
  printerPresets?: PrinterPreset[];
  materialTemplates?: Array<Omit<MaterialProfile, 'id' | 'printerProfileId'>>;
};

export type ProfileNetworkUiAdapter = {
  mode: string;
  pluginId: string;
  displayName: string;
  operationNamespace: string;
  operations: {
    connect: string;
    discover: string;
    materials: string;
    materialsEdit: string;
  };
  defaultLocalHostnames: string[];
  primaryEditFields: NanoDlpPrimaryEditField[];
  basicSections: NanoDlpBasicSection[];
  advancedSections: NanoDlpAdvancedSectionDef[];
  resolveEditDraftFromMeta: (meta: Record<string, unknown>) => Record<string, string>;
  resolveMaterialProcessValues: (meta: Record<string, unknown>) => {
    layerHeightMm?: number;
    normalExposureSec?: number;
    bottomExposureSec?: number;
    bottomLayerCount?: number;
  };
  denormalizeEditDraftForBackend: (draft: Record<string, string>) => Record<string, string>;
  resolveAdvancedSectionId: (fieldKey: string) => string;
  getFieldHelpText: (fieldKey: string) => string;
  isDynamicWaitEnabled: (draft: Record<string, string>) => boolean;
};

export type PrinterMonitoringSnapshot = {
  connected: boolean;
  stateText: string;
  isPrinting: boolean;
  isPaused: boolean;
  cancelLatched: boolean;
  pauseLatched: boolean;
  finished: boolean;
  progressPct: number | null;
  currentLayer: number | null;
  totalLayers: number | null;
  plateId: number | null;
  jobName: string | null;
  etaSec: number | null;
};

export type PrinterMonitoringWebcamInfo = {
  available: boolean;
  streamUrl: string | null;
  snapshotUrl: string | null;
  message: string;
};

export type ProfileMonitoringUiAdapter = {
  mode: string;
  pluginId: string | null;
  displayName: string;
  available: boolean;
  operations: {
    status: string;
    webcamInfo: string;
    platesList: string;
    start: string;
    deletePlate: string;
    pause: string;
    resume: string;
    cancel: string;
    emergencyStop: string;
  } | null;
  parseStatusPayload: (payload: unknown, contextKey?: string) => PrinterMonitoringSnapshot;
  parseWebcamInfoPayload: (payload: unknown, host: string, port: number) => PrinterMonitoringWebcamInfo;
};

const ATHENA_NANODLP_NETWORK_ADAPTER: ProfileNetworkUiAdapter = {
  mode: 'nanodlp',
  pluginId: 'athena',
  displayName: 'NanoDLP',
  operationNamespace: 'nanodlp',
  operations: {
    connect: 'nanodlp/connect',
    discover: 'nanodlp/discover',
    materials: 'nanodlp/materials',
    materialsEdit: 'nanodlp/materials/edit',
  },
  defaultLocalHostnames: ['nanodlp.local', 'athena.local', 'printer.local', 'resin.local'],
  primaryEditFields: NANODLP_PRIMARY_EDIT_FIELDS,
  basicSections: NANODLP_BASIC_SECTIONS,
  advancedSections: NANODLP_ADVANCED_SECTIONS,
  resolveEditDraftFromMeta: resolveNanodlpEditDraftFromMeta,
  resolveMaterialProcessValues: resolveNanodlpMaterialProcessValues,
  denormalizeEditDraftForBackend: denormalizeNanodlpEditDraftForBackend,
  resolveAdvancedSectionId: resolveNanoDlpAdvancedSectionId,
  getFieldHelpText: getNanoDlpFieldHelpText,
  isDynamicWaitEnabled: isNanoDlpDynamicWaitEnabled,
};

const NETWORK_ADAPTERS_BY_MODE = new Map<string, ProfileNetworkUiAdapter>([
  [ATHENA_NANODLP_NETWORK_ADAPTER.mode, ATHENA_NANODLP_NETWORK_ADAPTER],
]);

const ATHENA_NANODLP_MONITORING_ADAPTER: ProfileMonitoringUiAdapter = {
  mode: 'nanodlp',
  pluginId: 'athena',
  displayName: 'Athena Monitoring',
  available: true,
  operations: {
    status: 'nanodlp/printer/status',
    webcamInfo: 'nanodlp/printer/webcam/info',
    platesList: 'nanodlp/plates/list/json',
    start: 'nanodlp/printer/start',
    deletePlate: 'nanodlp/plate/delete',
    pause: 'nanodlp/printer/pause',
    resume: 'nanodlp/printer/unpause',
    cancel: 'nanodlp/printer/stop',
    emergencyStop: 'nanodlp/printer/force-stop',
  },
  parseStatusPayload: (payload, contextKey) => resolveNanodlpMonitoringSnapshot(payload, contextKey),
  parseWebcamInfoPayload: (payload, host, port) => resolveNanodlpWebcamFeedInfo(payload, host, port),
};

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

const MONITORING_ADAPTERS_BY_MODE = new Map<string, ProfileMonitoringUiAdapter>([
  [ATHENA_NANODLP_MONITORING_ADAPTER.mode, ATHENA_NANODLP_MONITORING_ADAPTER],
]);

export function getProfileNetworkUiAdapter(mode: string | null | undefined): ProfileNetworkUiAdapter | null {
  if (!mode || typeof mode !== 'string') return null;
  return NETWORK_ADAPTERS_BY_MODE.get(mode.trim().toLowerCase()) ?? null;
}

export function getDefaultProfileNetworkUiAdapter(): ProfileNetworkUiAdapter {
  return ATHENA_NANODLP_NETWORK_ADAPTER;
}

export function getProfileMonitoringUiAdapter(mode: string | null | undefined): ProfileMonitoringUiAdapter {
  if (!mode || typeof mode !== 'string') return GENERIC_MONITORING_STUB_ADAPTER;
  return MONITORING_ADAPTERS_BY_MODE.get(mode.trim().toLowerCase()) ?? GENERIC_MONITORING_STUB_ADAPTER;
}

export type InstalledProfilePlugin = {
  manifest: PluginManifest;
  enabled: boolean;
  source: PluginSource;
  sourceUrl?: string;
  installedAt: string;
};

type PersistedPluginEnvelope = {
  version: number;
  plugins: InstalledProfilePlugin[];
};

const STORAGE_KEY = 'dragonfruit-plugins-v1';
const STORAGE_VERSION = 1;
const MAX_PRINTER_PRESETS = 128;
const MAX_MATERIAL_TEMPLATES = 512;

function shouldUseBundledAssetPaths(): boolean {
  if (typeof window === 'undefined') return false;
  const protocol = window.location?.protocol ?? '';
  const hostname = window.location?.hostname ?? '';
  return protocol === 'file:' || protocol === 'tauri:' || hostname === 'tauri.localhost';
}

function resolveRuntimeAssetPath(value: string): string {
  if (!value.startsWith('/api/profile-assets/')) return value;
  if (!shouldUseBundledAssetPaths()) return value;
  return `/${value.slice('/api/profile-assets/'.length)}`;
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

function sanitizeOutputFormat(value: unknown): PrinterPreset['display']['outputFormat'] {
  return value === '.nanodlp' || value === '.goo' || value === '.lumen'
    ? value
    : '.goo';
}

function sanitizeImageAssetPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('/api/profile-assets/')) return resolveRuntimeAssetPath(trimmed);
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

  return {
    presetId,
    manufacturer,
    name,
    family: family || undefined,
    imageAssetPath: sanitizeImageAssetPath(value.imageAssetPath),
    antiAliasing: typeof value.antiAliasing === 'boolean' ? value.antiAliasing : undefined,
    networkSupport: value.networkSupport === 'nanodlp' ? 'nanodlp' : undefined,
    networkFilter: boundedString((value as any).networkFilter, 120) || undefined,
    platformBadge: sanitizePlatformBadge((value as any).platformBadge),
    pixelSize,
    bitDepth: sanitizeBitDepth((value as any).bitDepth),
    buildVolumeMm: {
      width: resolveBuildDimensionMm((value as any).buildVolumeMm?.width, resolutionX, pixelSize?.x, 143),
      depth: resolveBuildDimensionMm((value as any).buildVolumeMm?.depth, resolutionY, pixelSize?.y, 89),
      height: sanitizeNumber((value as any).buildVolumeMm?.height, 175, 1, 10000),
    },
    display: {
      resolutionX,
      resolutionY,
      outputFormat: sanitizeOutputFormat((value as any).display?.outputFormat),
      mirrorX: typeof (value as any).display?.mirrorX === 'boolean'
        ? (value as any).display.mirrorX
        : undefined,
      mirrorY: typeof (value as any).display?.mirrorY === 'boolean'
        ? (value as any).display.mirrorY
        : undefined,
    },
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
  };
}

const BUILTIN_ATHENA_PLUGIN: InstalledProfilePlugin = {
  manifest: ATHENA_PLUGIN_MANIFEST,
  enabled: true,
  source: 'builtin',
  sourceUrl: 'builtin://plugins/athena',
  installedAt: new Date(0).toISOString(),
};

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

  return {
    schemaVersion,
    id,
    name,
    version,
    description: boundedString(value.description, 500) || undefined,
    author: boundedString(value.author, 120) || undefined,
    homepage: boundedString(value.homepage, 500) || undefined,
    printerPresets,
    materialTemplates,
  };
}

function sanitizeInstalledPlugin(input: unknown): InstalledProfilePlugin | null {
  const value = (input ?? {}) as any;
  const manifest = sanitizeManifest(value.manifest);
  if (!manifest) return null;

  return {
    manifest,
    enabled: value.enabled !== false,
    source: value.source === 'github' ? 'github' : 'builtin',
    sourceUrl: typeof value.sourceUrl === 'string' ? value.sourceUrl : undefined,
    installedAt: typeof value.installedAt === 'string' ? value.installedAt : new Date().toISOString(),
  };
}

function save() {
  if (typeof window === 'undefined') return;
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
  if (typeof window === 'undefined') return;

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
  } catch (error) {
    console.error('[PluginRegistry] Failed to hydrate plugins', error);
    externalPlugins = [];
  }
}

export function getInstalledProfilePlugins(): InstalledProfilePlugin[] {
  hydratePluginRegistry();
  return [BUILTIN_ATHENA_PLUGIN, ...externalPlugins];
}

export function installExternalProfilePlugin(manifestInput: PluginManifest, sourceUrl?: string): InstalledProfilePlugin {
  hydratePluginRegistry();
  const manifest = sanitizeManifest(manifestInput);
  if (!manifest) throw new Error('Invalid plugin manifest');

  const plugin: InstalledProfilePlugin = {
    manifest,
    enabled: true,
    source: 'github',
    sourceUrl,
    installedAt: new Date().toISOString(),
  };

  externalPlugins = [
    ...externalPlugins.filter((existing) => existing.manifest.id !== manifest.id),
    plugin,
  ];

  save();
  return plugin;
}

export function uninstallExternalProfilePlugin(pluginId: string): boolean {
  hydratePluginRegistry();
  const before = externalPlugins.length;
  externalPlugins = externalPlugins.filter((plugin) => plugin.manifest.id !== pluginId);
  const changed = externalPlugins.length !== before;
  if (changed) save();
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
