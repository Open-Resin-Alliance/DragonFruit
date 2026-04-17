import printerPresetsData from '../../../profiles/printers';
import materialTemplatesData from '../../../profiles/materials';
import {
  getProfileLocalMaterialSettingsAdapter,
  getInstalledProfilePlugins,
  getRuntimeMaterialTemplates,
  getRuntimePrinterPresets,
  hydratePluginRegistry,
  installExternalProfilePlugin,
  uninstallExternalProfilePlugin,
  type InstalledProfilePlugin,
  type PluginManifest,
} from '@/features/plugins/pluginRegistry';
import {
  normalizeOutputFormat,
  normalizeFormatVersion,
  normalizeSettingsMode,
  normalizeWebcamRotationDeg,
  DEFAULT_OUTPUT_FORMAT,
  DEFAULT_WEBCAM_ROTATION_DEG,
} from '@/features/profiles/outputFormatUtils';

export type PrinterOutputFormat = string;
export type PrinterNetworkSupport = string;

export type PrinterNetworkSettings = {
  discoveryEnabled: boolean;
  ipAddress: string;
};

export type PrinterNetworkConnectionState = {
  mode: PrinterNetworkSupport;
  connected: boolean;
  hostName: string;
  ipAddress: string;
  port: number;
  lastCheckedAt: string;
  statusText?: string;
  selectedMaterialId?: string;
  selectedMaterialName?: string;
  selectedMaterialLayerHeightMm?: number;
  selectedMaterialNormalExposureSec?: number;
  selectedMaterialBottomExposureSec?: number;
  selectedMaterialBottomLayerCount?: number;
};

export type PrinterNetworkDevice = PrinterNetworkConnectionState & {
  id: string;
  displayName: string;
  imageDataUrl?: string;
};

export type PrinterPlatformBadge = {
  text: string;
  color?: string;
};

export type PrinterPixelSize = {
  x: number;
  y: number;
};

export type PrinterBitDepth = {
  bits: number;
  description?: string;
};

export type PrinterBuildDimensionMode = 'manual' | 'auto';
export type PrinterWebcamRotationDeg = 0 | 90 | 180 | 270;

export type PrinterPreset = {
  presetId: string;
  profileVersion?: number;
  manufacturer: string;
  name: string;
  family?: string;
  imageAssetPath?: string;
  antiAliasing?: boolean;
  networkSupport?: PrinterNetworkSupport;
  hasCamera?: boolean;
  networkFilter?: string;
  platformBadge?: PrinterPlatformBadge;
  pixelSize?: PrinterPixelSize;
  bitDepth?: PrinterBitDepth;
  buildDimensionMode?: PrinterBuildDimensionMode;
  buildVolumeMm: {
    width: number;
    depth: number;
    height: number;
  };
  safetyMarginMm?: {
    front: number;
    back: number;
    left: number;
    right: number;
  };
  display: {
    resolutionX: number;
    resolutionY: number;
    outputFormat: PrinterOutputFormat;
    formatVersion?: string;
    settingsMode?: string;
    webcamRotationDeg?: PrinterWebcamRotationDeg;
    mirrorX?: boolean;
    mirrorY?: boolean;
  };
};

export type PrinterProfile = {
  id: string;
  name: string;
  manufacturer?: string;
  imageDataUrl?: string;
  antiAliasing?: boolean;
  networkSupport?: PrinterNetworkSupport;
  hasCamera?: boolean;
  networkFilter?: string;
  platformBadge?: PrinterPlatformBadge;
  pixelSize?: PrinterPixelSize;
  bitDepth?: PrinterBitDepth;
  buildDimensionMode?: PrinterBuildDimensionMode;
  officialPresetId?: string;
  officialPresetVersion?: number;
  isOfficial?: boolean;
  isCustom?: boolean;
  safetyMarginMm?: {
    front: number;
    back: number;
    left: number;
    right: number;
  };
  buildVolumeMm: {
    width: number;
    depth: number;
    height: number;
  };
  display: {
    resolutionX: number;
    resolutionY: number;
    outputFormat: PrinterOutputFormat;
    formatVersion?: string;
    settingsMode?: string;
    webcamRotationDeg?: PrinterWebcamRotationDeg;
    mirrorX?: boolean;
    mirrorY?: boolean;
  };
  network?: PrinterNetworkSettings;
  networkFleet?: PrinterNetworkDevice[];
  activeNetworkDeviceId?: string;
  networkConnection?: PrinterNetworkConnectionState;
};

function normalizeNetworkSupport(value: unknown): PrinterNetworkSupport | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  // Keep this permissive so plugin-defined modes remain forward-compatible.
  // Legacy persisted values such as "nanodlp" are preserved.
  return normalized;
}

function sanitizePlatformBadge(input: unknown): PrinterPlatformBadge | undefined {
  const source = (input ?? {}) as any;
  const text = typeof source.text === 'string' ? source.text.trim() : '';
  if (!text) return undefined;

  const color = typeof source.color === 'string' ? source.color.trim() : '';
  return {
    text,
    color: color || undefined,
  };
}

function sanitizePixelSize(input: unknown): PrinterPixelSize | undefined {
  const source = (input ?? {}) as any;
  const x = Number(source.x);
  const y = Number(source.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) {
    return undefined;
  }

  return {
    x,
    y,
  };
}

function sanitizeBitDepth(input: unknown): PrinterBitDepth | undefined {
  const source = (input ?? {}) as any;
  const bits = Number(source.bits);
  if (!Number.isFinite(bits) || bits <= 0) {
    return undefined;
  }

  const description = typeof source.description === 'string' ? source.description.trim() : '';
  return {
    bits: Math.round(bits),
    description: description || undefined,
  };
}

export type LocalMaterialSettingsValue = string | number | boolean;
export type LocalMaterialSettingsMap = Record<string, LocalMaterialSettingsValue>;

const MATERIAL_PROFILE_LOCAL_OVERRIDE_KEYS = new Set<keyof MaterialProfile>([
  'layerHeightMm',
  'normalExposureSec',
  'bottomExposureSec',
  'bottomLayerCount',
  'liftDistanceMm',
  'liftSpeedMmMin',
  'retractSpeedMmMin',
  'minimumAaAlphaPercent',
]);

export type MaterialProfile = {
  id: string;
  printerProfileId: string;
  officialTemplateId?: string;
  officialTemplateVersion?: number;
  name: string;
  brand: string;
  currencyCode: string;
  bottlePrice: number;
  bottleCapacityMl: number;
  resinFamily: 'standard' | 'abs-like' | 'tough' | 'flexible' | 'engineering' | 'other';
  scaleCompensationPct: {
    x: number;
    y: number;
    z: number;
  };
  layerHeightMm: number;
  normalExposureSec: number;
  bottomExposureSec: number;
  bottomLayerCount: number;
  liftDistanceMm: number;
  liftSpeedMmMin: number;
  retractSpeedMmMin: number;
  minimumAaAlphaPercent: number;
  localSettingsByOutput?: Record<string, LocalMaterialSettingsMap>;
};

function normalizeMinimumAaAlphaPercent(value: unknown, fallback = 35): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, numeric));
}

function sanitizeLocalMaterialSettingsMap(input: unknown): LocalMaterialSettingsMap | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const source = input as Record<string, unknown>;
  const next: LocalMaterialSettingsMap = {};

  Object.entries(source).forEach(([key, rawValue]) => {
    const normalizedKey = key.trim();
    if (!normalizedKey) return;

    if (typeof rawValue === 'string' || typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      next[normalizedKey] = rawValue;
    }
  });

  return Object.keys(next).length > 0 ? next : undefined;
}

function sanitizeLocalSettingsByOutput(input: unknown): Record<string, LocalMaterialSettingsMap> | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const source = input as Record<string, unknown>;
  const next: Record<string, LocalMaterialSettingsMap> = {};

  Object.entries(source).forEach(([outputFormatRaw, value]) => {
    const outputFormat = normalizeOutputFormat(outputFormatRaw);
    const sanitized = sanitizeLocalMaterialSettingsMap(value);
    if (!sanitized) return;
    next[outputFormat] = sanitized;
  });

  return Object.keys(next).length > 0 ? next : undefined;
}

function resolveLocalMaterialOverrideTargetKey(
  field: { key: string; metadataPath?: string },
): keyof MaterialProfile | null {
  const candidates: string[] = [];
  const metadataPath = field.metadataPath?.trim() ?? '';

  if (metadataPath) {
    const segments = metadataPath
      .split('.')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);

    if (segments.length >= 2) {
      const root = segments[0].toLowerCase();
      if (root === 'material' || root === 'dragonfruit') {
        candidates.push(segments[segments.length - 1]!);
      }
    }
  }

  candidates.push(field.key);

  for (const candidate of candidates) {
    if (MATERIAL_PROFILE_LOCAL_OVERRIDE_KEYS.has(candidate as keyof MaterialProfile)) {
      return candidate as keyof MaterialProfile;
    }
  }

  return null;
}

function coerceLocalMaterialOverrideValue(
  rawValue: LocalMaterialSettingsValue,
  kind: 'number' | 'integer' | 'text' | 'boolean' | 'select',
): LocalMaterialSettingsValue | null {
  if (kind === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'string') {
      const normalized = rawValue.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
    return Boolean(rawValue);
  }

  if (kind === 'number' || kind === 'integer') {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return null;
    return kind === 'integer' ? Math.round(parsed) : parsed;
  }

  return String(rawValue);
}

function resolveMaterialProfileWithLocalSettings(
  materialProfile: MaterialProfile,
  printerProfile: PrinterProfile | null | undefined,
): MaterialProfile {
  if (!printerProfile) return materialProfile;

  const normalizedOutput = normalizeOutputFormat(printerProfile.display.outputFormat);
  const outputWithoutDot = normalizedOutput.replace(/^\./, '');
  const adapter = getProfileLocalMaterialSettingsAdapter(
    normalizedOutput,
    printerProfile.display.settingsMode,
  );

  if (!adapter?.replacesDefaultMaterialSettings || adapter.fields.length === 0) {
    return materialProfile;
  }

  const localForOutput = materialProfile.localSettingsByOutput?.[normalizedOutput]
    ?? materialProfile.localSettingsByOutput?.[outputWithoutDot];

  if (!localForOutput) return materialProfile;

  let nextProfile: MaterialProfile | null = null;

  adapter.fields.forEach((field) => {
    if (!Object.prototype.hasOwnProperty.call(localForOutput, field.key)) return;

    const targetKey = resolveLocalMaterialOverrideTargetKey(field);
    if (!targetKey) return;

    const coercedValue = coerceLocalMaterialOverrideValue(localForOutput[field.key]!, field.kind);
    if (coercedValue == null) return;

    if (materialProfile[targetKey] === coercedValue) return;

    if (!nextProfile) {
      nextProfile = { ...materialProfile };
    }

    (nextProfile as unknown as Record<string, LocalMaterialSettingsValue>)[targetKey] = coercedValue;
  });

  return nextProfile ?? materialProfile;
}

export type MaterialTemplate = Omit<MaterialProfile, 'id' | 'printerProfileId'> & {
  templateId?: string;
  profileVersion?: number;
};

export type MaterialPreset = MaterialTemplate & {
  /** presetId values (or glob patterns with `*`) that this preset applies to. */
  validForPresets?: string[];
};

export type OfficialPrinterProfileUpdateInfo = {
  printerProfileId: string;
  printerName: string;
  presetId: string;
  currentVersion: number;
  latestVersion: number;
};

export type OfficialMaterialProfileUpdateInfo = {
  materialProfileId: string;
  materialName: string;
  templateId: string;
  currentVersion: number;
  latestVersion: number;
};

export type ApplyOfficialProfileUpdateResult =
  | 'updated'
  | 'version-bumped-custom'
  | 'already-latest'
  | 'not-linked'
  | 'not-found';

export type ProfileStoreState = {
  printerProfiles: PrinterProfile[];
  materialProfiles: MaterialProfile[];
  activePrinterProfileId: string;
  activeMaterialProfileId: string;
};

type PersistedProfileStoreEnvelope = {
  version: number;
  state: Partial<ProfileStoreState>;
};

const STORAGE_KEY = 'dragonfruit-profiles-v1';
const STORAGE_BACKUP_KEY = 'dragonfruit-profiles-v1-backup';
const LEGACY_STORAGE_KEYS = ['dragonfruit-profiles'];
const PROFILE_STORE_SCHEMA_VERSION = 3;

const DEFAULT_PRINTER_NETWORK_SETTINGS: PrinterNetworkSettings = {
  discoveryEnabled: true,
  ipAddress: '',
};

function normalizeAntiAliasingSupport(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

function normalizeBuildDimensionMode(value: unknown): PrinterBuildDimensionMode | undefined {
  if (value === 'auto' || value === 'manual') return value;
  return undefined;
}

function normalizeCameraSupport(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

function sanitizeNetworkFilter(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function createDefaultNetworkConnectionState(mode: PrinterNetworkSupport, ipAddress = ''): PrinterNetworkConnectionState {
  return {
    mode,
    connected: false,
    hostName: '',
    ipAddress: ipAddress.trim(),
    port: 80,
    lastCheckedAt: '',
    statusText: '',
    selectedMaterialId: '',
    selectedMaterialName: '',
    selectedMaterialLayerHeightMm: undefined,
    selectedMaterialNormalExposureSec: undefined,
    selectedMaterialBottomExposureSec: undefined,
    selectedMaterialBottomLayerCount: undefined,
  };
}

function createDefaultPrinterNetworkDevice(mode: PrinterNetworkSupport, ipAddress = ''): PrinterNetworkDevice {
  const base = createDefaultNetworkConnectionState(mode, ipAddress);
  return {
    id: createId('network-device'),
    displayName: ipAddress.trim() || 'Printer',
    ...base,
  };
}

function sanitizePrinterNetworkConnectionState(
  input: unknown,
  mode: PrinterNetworkSupport,
  fallbackIpAddress = '',
): PrinterNetworkConnectionState {
  const source = (input ?? {}) as any;

  return {
    mode,
    connected: source.connected === true,
    hostName: typeof source.hostName === 'string' ? source.hostName.trim() : '',
    ipAddress: typeof source.ipAddress === 'string'
      ? source.ipAddress.trim()
      : fallbackIpAddress.trim(),
    port: Number.isFinite(Number(source.port)) ? Math.max(1, Number(source.port)) : 80,
    lastCheckedAt: typeof source.lastCheckedAt === 'string' ? source.lastCheckedAt : '',
    statusText: typeof source.statusText === 'string' ? source.statusText : '',
    selectedMaterialId: typeof source.selectedMaterialId === 'string' ? source.selectedMaterialId.trim() : '',
    selectedMaterialName: typeof source.selectedMaterialName === 'string' ? source.selectedMaterialName.trim() : '',
    selectedMaterialLayerHeightMm: Number.isFinite(Number(source.selectedMaterialLayerHeightMm))
      ? Number(source.selectedMaterialLayerHeightMm)
      : undefined,
    selectedMaterialNormalExposureSec: Number.isFinite(Number(source.selectedMaterialNormalExposureSec))
      ? Number(source.selectedMaterialNormalExposureSec)
      : undefined,
    selectedMaterialBottomExposureSec: Number.isFinite(Number(source.selectedMaterialBottomExposureSec))
      ? Number(source.selectedMaterialBottomExposureSec)
      : undefined,
    selectedMaterialBottomLayerCount: Number.isFinite(Number(source.selectedMaterialBottomLayerCount))
      ? Number(source.selectedMaterialBottomLayerCount)
      : undefined,
  };
}

function sanitizePrinterNetworkDevice(
  input: unknown,
  mode: PrinterNetworkSupport,
  fallbackIpAddress = '',
): PrinterNetworkDevice {
  const source = (input ?? {}) as any;
  const connection = sanitizePrinterNetworkConnectionState(source, mode, fallbackIpAddress);
  const displayNameRaw = typeof source.displayName === 'string' ? source.displayName.trim() : '';

  return {
    id: typeof source.id === 'string' && source.id.trim().length > 0
      ? source.id.trim()
      : createId('network-device'),
    displayName: displayNameRaw || connection.hostName || connection.ipAddress || 'Printer',
    imageDataUrl: typeof source.imageDataUrl === 'string' && source.imageDataUrl.trim().length > 0
      ? source.imageDataUrl
      : undefined,
    ...connection,
  };
}

function hasMeaningfulPrinterNetworkConnection(value: PrinterNetworkConnectionState | null | undefined): boolean {
  if (!value) return false;
  return Boolean(
    value.connected
    || value.hostName.trim().length > 0
    || value.ipAddress.trim().length > 0
    || value.lastCheckedAt.trim().length > 0
    || (value.statusText ?? '').trim().length > 0
    || (value.selectedMaterialId ?? '').trim().length > 0,
  );
}

function sanitizePrinterNetworkFleet(
  input: unknown,
  mode: PrinterNetworkSupport,
  fallbackIpAddress = '',
): PrinterNetworkDevice[] {
  if (!Array.isArray(input)) return [];

  const byId = new Set<string>();
  const byAddress = new Set<string>();
  const fleet: PrinterNetworkDevice[] = [];

  for (const item of input) {
    const device = sanitizePrinterNetworkDevice(item, mode, fallbackIpAddress);
    if (!hasMeaningfulPrinterNetworkConnection(device)) continue;
    const normalizedAddress = device.ipAddress.trim().toLowerCase();
    if (byId.has(device.id)) continue;
    if (normalizedAddress && byAddress.has(normalizedAddress)) continue;
    byId.add(device.id);
    if (normalizedAddress) byAddress.add(normalizedAddress);
    fleet.push(device);
  }

  return fleet;
}

function resolveActivePrinterNetworkDevice(
  fleet: PrinterNetworkDevice[],
  requestedId?: string,
  fallbackIpAddress = '',
): PrinterNetworkDevice | null {
  if (fleet.length === 0) return null;

  const normalizedRequestedId = requestedId?.trim() || '';
  if (normalizedRequestedId) {
    const matched = fleet.find((device) => device.id === normalizedRequestedId);
    if (matched) return matched;
  }

  const normalizedFallbackIp = fallbackIpAddress.trim().toLowerCase();
  if (normalizedFallbackIp) {
    const matched = fleet.find((device) => device.ipAddress.trim().toLowerCase() === normalizedFallbackIp);
    if (matched) return matched;
  }

  return fleet.find((device) => device.connected) ?? fleet[0] ?? null;
}

function deriveNetworkProfileState(
  profile: Partial<PrinterProfile>,
  mode: PrinterNetworkSupport,
): Pick<PrinterProfile, 'network' | 'networkFleet' | 'activeNetworkDeviceId' | 'networkConnection'> {
  const network = sanitizePrinterNetworkSettings((profile as any).network);
  let networkFleet = sanitizePrinterNetworkFleet((profile as any).networkFleet, mode, network.ipAddress);

  if (networkFleet.length === 0) {
    const legacyConnection = sanitizePrinterNetworkConnectionState(
      (profile as any).networkConnection,
      mode,
      network.ipAddress,
    );
    if (hasMeaningfulPrinterNetworkConnection(legacyConnection)) {
      networkFleet = [{
        id: createId('network-device'),
        displayName: legacyConnection.hostName || legacyConnection.ipAddress || 'Printer',
        ...legacyConnection,
      }];
    }
  }

  const rawActiveDeviceId = typeof (profile as any).activeNetworkDeviceId === 'string'
    ? (profile as any).activeNetworkDeviceId.trim()
    : '';
  const activeDevice = resolveActivePrinterNetworkDevice(networkFleet, rawActiveDeviceId, network.ipAddress);
  const resolvedNetwork = activeDevice?.ipAddress
    ? { ...network, ipAddress: activeDevice.ipAddress }
    : network;

  return {
    network: resolvedNetwork,
    networkFleet,
    activeNetworkDeviceId: activeDevice?.id ?? undefined,
    networkConnection: activeDevice
      ? sanitizePrinterNetworkConnectionState(activeDevice, mode, resolvedNetwork.ipAddress)
      : createDefaultNetworkConnectionState(mode, resolvedNetwork.ipAddress),
  };
}

function sanitizePrinterNetworkSettings(input: unknown): PrinterNetworkSettings {
  const discoveryEnabled = typeof (input as any)?.discoveryEnabled === 'boolean'
    ? (input as any).discoveryEnabled
    : DEFAULT_PRINTER_NETWORK_SETTINGS.discoveryEnabled;

  const ipAddress = typeof (input as any)?.ipAddress === 'string'
    ? (input as any).ipAddress.trim()
    : DEFAULT_PRINTER_NETWORK_SETTINGS.ipAddress;

  return {
    discoveryEnabled,
    ipAddress,
  };
}

const BUILTIN_PRINTER_PRESETS: PrinterPreset[] = (printerPresetsData as PrinterPreset[]).map((preset) => ({
  ...preset,
  display: {
    ...preset.display,
    outputFormat: normalizeOutputFormat(preset.display?.outputFormat),
    formatVersion: normalizeFormatVersion((preset.display as { formatVersion?: unknown } | undefined)?.formatVersion),
    settingsMode: normalizeSettingsMode((preset.display as { settingsMode?: unknown } | undefined)?.settingsMode),
    webcamRotationDeg: normalizeWebcamRotationDeg(
      (preset.display as { webcamRotationDeg?: unknown; webcamOrientation?: unknown } | undefined)?.webcamRotationDeg
      ?? (preset.display as { webcamRotationDeg?: unknown; webcamOrientation?: unknown } | undefined)?.webcamOrientation,
      DEFAULT_WEBCAM_ROTATION_DEG,
    ),
    mirrorX: normalizeMirrorFlag((preset.display as { mirrorX?: unknown } | undefined)?.mirrorX, false),
    mirrorY: normalizeMirrorFlag((preset.display as { mirrorY?: unknown } | undefined)?.mirrorY, false),
  },
}));

const BUILTIN_MATERIAL_TEMPLATES = materialTemplatesData as MaterialTemplate[];

function getAllPrinterPresets(): PrinterPreset[] {
  return getRuntimePrinterPresets(BUILTIN_PRINTER_PRESETS);
}

function getAllMaterialTemplates(): MaterialTemplate[] {
  return getRuntimeMaterialTemplates(BUILTIN_MATERIAL_TEMPLATES);
}

const DEFAULT_PRINTER_PROFILES: PrinterProfile[] = BUILTIN_PRINTER_PRESETS.map((preset) => ({
  id: `printer-default-${preset.presetId}`,
  name: preset.name,
  manufacturer: preset.manufacturer,
  imageDataUrl: preset.imageAssetPath,
  antiAliasing: normalizeAntiAliasingSupport((preset as any).antiAliasing),
  networkSupport: normalizeNetworkSupport(preset.networkSupport),
  hasCamera: normalizeCameraSupport((preset as any).hasCamera),
  networkFilter: sanitizeNetworkFilter((preset as any).networkFilter),
  platformBadge: sanitizePlatformBadge((preset as any).platformBadge),
  pixelSize: sanitizePixelSize((preset as any).pixelSize),
  bitDepth: sanitizeBitDepth((preset as any).bitDepth),
  buildDimensionMode: normalizeBuildDimensionMode((preset as any).buildDimensionMode),
  officialPresetId: preset.presetId,
  officialPresetVersion: normalizeProfileVersion((preset as any).profileVersion, 1),
  isOfficial: true,
  isCustom: false,
  buildVolumeMm: preset.buildVolumeMm,
  safetyMarginMm: sanitizeSafetyMarginMm((preset as any).safetyMarginMm),
  display: preset.display,
  network: sanitizePrinterNetworkSettings((preset as any).network),
}));

function resolveOfficialPresetId(profile: Partial<PrinterProfile>): string | undefined {
  if (typeof (profile as any).officialPresetId === 'string') {
    return ((profile as any).officialPresetId as string).trim() || undefined;
  }

  const name = typeof profile.name === 'string' ? profile.name.trim().toLowerCase() : '';
  const manufacturer = typeof profile.manufacturer === 'string' ? profile.manufacturer.trim().toLowerCase() : '';
  if (!name || !manufacturer) return undefined;

  const matchedPreset = getAllPrinterPresets().find((preset) => (
    preset.name.trim().toLowerCase() === name
    && preset.manufacturer.trim().toLowerCase() === manufacturer
  ));

  return matchedPreset?.presetId;
}

function resolveSafetyMarginForProfile(profile: Partial<PrinterProfile>): PrinterProfile['safetyMarginMm'] {
  const explicit = sanitizeSafetyMarginMm((profile as any).safetyMarginMm);
  if (explicit) return explicit;

  const presetId = resolveOfficialPresetId(profile);
  if (!presetId) return undefined;

  const preset = getAllPrinterPresets().find((item) => item.presetId === presetId);
  return sanitizeSafetyMarginMm((preset as any)?.safetyMarginMm);
}

function resolveNetworkSupport(profile: Partial<PrinterProfile>): PrinterNetworkSupport | undefined {
  const explicit = normalizeNetworkSupport((profile as any).networkSupport);
  if (explicit) return explicit;

  const presetId = resolveOfficialPresetId(profile);
  if (!presetId) return undefined;

  const preset = getAllPrinterPresets().find((item) => item.presetId === presetId);
  return normalizeNetworkSupport(preset?.networkSupport);
}

function isOfficialProfileByHeuristic(profile: Partial<PrinterProfile>): boolean {
  if (typeof profile.id === 'string' && profile.id.startsWith('printer-default-')) return true;
  if (profile.isOfficial === true) return true;
  return false;
}

function normalizeMirrorFlag(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function sanitizeSafetyMarginMm(input: unknown): PrinterProfile['safetyMarginMm'] {
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

function normalizeProfileVersion(value: unknown, fallback = 1): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Math.max(1, Math.round(fallback));
  return Math.max(1, Math.round(numeric));
}

function createDefaultMaterialIdFromTemplateName(name: string): string {
  return `material-default-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function createDefaultMaterials(printerProfiles: PrinterProfile[]): MaterialProfile[] {
  const primaryPrinterId = printerProfiles[0]?.id;
  if (!primaryPrinterId) return [];

  return getAllMaterialTemplates().map((template) => ({
    ...template,
    currencyCode: typeof (template as any).currencyCode === 'string' ? (template as any).currencyCode : 'USD',
    minimumAaAlphaPercent: normalizeMinimumAaAlphaPercent((template as any).minimumAaAlphaPercent, 35),
    localSettingsByOutput: sanitizeLocalSettingsByOutput((template as any).localSettingsByOutput),
    id: createDefaultMaterialIdFromTemplateName(template.name),
    printerProfileId: primaryPrinterId,
    officialTemplateId: typeof (template as any).templateId === 'string' && (template as any).templateId.trim().length > 0
      ? (template as any).templateId.trim()
      : undefined,
    officialTemplateVersion: normalizeProfileVersion((template as any).profileVersion, 1),
  }));
}

function createDefaultState(): ProfileStoreState {
  const printerProfiles: PrinterProfile[] = [];
  const materialProfiles = createDefaultMaterials(printerProfiles);

  return {
    printerProfiles,
    materialProfiles,
    activePrinterProfileId: '',
    activeMaterialProfileId: '',
  };
}

let state: ProfileStoreState = createDefaultState();
let serverSnapshot: ProfileStoreState | null = null;
let isHydrated = false;

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[ProfileStore] listener error', error);
    }
  });
}

function sanitizeState(input: Partial<ProfileStoreState> | null | undefined): ProfileStoreState {
  const fallback = createDefaultState();

  const printerProfiles = Array.isArray(input?.printerProfiles)
    ? input!.printerProfiles
      .map((profile): PrinterProfile | null => {
        if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') {
          return null;
        }

        const officialPresetId = resolveOfficialPresetId(profile);
        const matchedPreset = officialPresetId
          ? getAllPrinterPresets().find((preset) => preset.presetId === officialPresetId)
          : undefined;

        const rawBuildVolume = (profile as any).buildVolumeMm;
        const rawDisplay = (profile as any).display;

        const fallbackBuildVolume = matchedPreset?.buildVolumeMm;
        const fallbackDisplay = matchedPreset?.display;
        const fallbackOfficialPresetVersion = normalizeProfileVersion((matchedPreset as any)?.profileVersion, 1);
        const fallbackSafetyMargin = sanitizeSafetyMarginMm((matchedPreset as any)?.safetyMarginMm);
        const explicitSafetyMargin = sanitizeSafetyMarginMm((profile as any).safetyMarginMm);
        const resolvedPixelSize = sanitizePixelSize((profile as any).pixelSize) ?? sanitizePixelSize((matchedPreset as any)?.pixelSize);
        const explicitBuildDimensionMode = normalizeBuildDimensionMode((profile as any).buildDimensionMode)
          ?? normalizeBuildDimensionMode((matchedPreset as any)?.buildDimensionMode);
        const inferAutoBuildDimensionMode = explicitBuildDimensionMode == null
          && rawBuildVolume != null
          && (rawBuildVolume as any).width == null
          && (rawBuildVolume as any).depth == null
          && resolvedPixelSize != null;
        const resolvedBuildDimensionMode: PrinterBuildDimensionMode = explicitBuildDimensionMode
          ?? (inferAutoBuildDimensionMode ? 'auto' : 'manual');
        const networkSupport = resolveNetworkSupport(profile);
        const networkProfileState = networkSupport
          ? deriveNetworkProfileState(profile, networkSupport)
          : {
            network: sanitizePrinterNetworkSettings((profile as any).network),
            networkFleet: undefined,
            activeNetworkDeviceId: undefined,
            networkConnection: undefined,
          };

        return {
          id: profile.id,
          name: profile.name,
          manufacturer: typeof profile.manufacturer === 'string' ? profile.manufacturer : undefined,
          imageDataUrl: typeof profile.imageDataUrl === 'string' ? profile.imageDataUrl : undefined,
          antiAliasing: normalizeAntiAliasingSupport((profile as any).antiAliasing)
            ?? normalizeAntiAliasingSupport((matchedPreset as any)?.antiAliasing),
          networkSupport,
          hasCamera: normalizeCameraSupport((profile as any).hasCamera)
            ?? normalizeCameraSupport((matchedPreset as any)?.hasCamera),
          networkFilter: sanitizeNetworkFilter((profile as any).networkFilter) ?? sanitizeNetworkFilter((matchedPreset as any)?.networkFilter),
          platformBadge: sanitizePlatformBadge((profile as any).platformBadge) ?? sanitizePlatformBadge((matchedPreset as any)?.platformBadge),
          pixelSize: resolvedPixelSize,
          bitDepth: sanitizeBitDepth((profile as any).bitDepth) ?? sanitizeBitDepth((matchedPreset as any)?.bitDepth),
          buildDimensionMode: resolvedBuildDimensionMode,
          officialPresetId,
          officialPresetVersion: normalizeProfileVersion((profile as any).officialPresetVersion, fallbackOfficialPresetVersion),
          isOfficial: isOfficialProfileByHeuristic(profile),
          isCustom: typeof profile.isCustom === 'boolean' ? profile.isCustom : !isOfficialProfileByHeuristic(profile),
          buildVolumeMm: {
            width: Number(rawBuildVolume?.width) || fallbackBuildVolume?.width || 143,
            depth: Number(rawBuildVolume?.depth) || fallbackBuildVolume?.depth || 89,
            height: Number(rawBuildVolume?.height) || fallbackBuildVolume?.height || 175,
          },
          safetyMarginMm: explicitSafetyMargin ?? fallbackSafetyMargin,
          display: {
            resolutionX: Number(rawDisplay?.resolutionX) || fallbackDisplay?.resolutionX || 2560,
            resolutionY: Number(rawDisplay?.resolutionY) || fallbackDisplay?.resolutionY || 1620,
            outputFormat: normalizeOutputFormat(rawDisplay?.outputFormat ?? fallbackDisplay?.outputFormat),
            formatVersion: normalizeFormatVersion(rawDisplay?.formatVersion ?? fallbackDisplay?.formatVersion),
            settingsMode: normalizeSettingsMode(rawDisplay?.settingsMode ?? fallbackDisplay?.settingsMode),
            webcamRotationDeg: normalizeWebcamRotationDeg(
              rawDisplay?.webcamRotationDeg
              ?? rawDisplay?.webcamOrientation
              ?? fallbackDisplay?.webcamRotationDeg
              ?? (fallbackDisplay as { webcamOrientation?: unknown } | undefined)?.webcamOrientation,
              DEFAULT_WEBCAM_ROTATION_DEG,
            ),
            mirrorX: normalizeMirrorFlag(rawDisplay?.mirrorX, normalizeMirrorFlag(fallbackDisplay?.mirrorX, false)),
            mirrorY: normalizeMirrorFlag(rawDisplay?.mirrorY, normalizeMirrorFlag(fallbackDisplay?.mirrorY, false)),
          },
          network: networkProfileState.network,
          networkFleet: networkProfileState.networkFleet,
          activeNetworkDeviceId: networkProfileState.activeNetworkDeviceId,
          networkConnection: networkProfileState.networkConnection,
        };
      })
      .filter((profile): profile is PrinterProfile => profile !== null)
    : fallback.printerProfiles;

  const fallbackPrinterId = printerProfiles[0]?.id ?? '';

  const materialProfiles = printerProfiles.length === 0
    ? []
    : Array.isArray(input?.materialProfiles) && input!.materialProfiles.length > 0
      ? input!.materialProfiles
      .map((profile): MaterialProfile | null => {
        if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') {
          return null;
        }

        const materialProfile = profile as any;
        const availableTemplates = getAllMaterialTemplates();
        const explicitTemplateId = typeof materialProfile.officialTemplateId === 'string'
          ? materialProfile.officialTemplateId.trim()
          : '';
        const inferredTemplateId = explicitTemplateId || (
          typeof materialProfile.id === 'string' && materialProfile.id.startsWith('material-default-')
            ? availableTemplates.find((template) => createDefaultMaterialIdFromTemplateName(String((template as any).name ?? '')) === materialProfile.id)?.templateId ?? ''
            : ''
        );
        const matchedTemplate = inferredTemplateId
          ? availableTemplates.find((template) => (template.templateId ?? '').trim() === inferredTemplateId)
          : undefined;

        const rawPrinterId = (profile as any).printerProfileId;
        const printerProfileId =
          typeof rawPrinterId === 'string' && printerProfiles.some((printer) => printer.id === rawPrinterId)
            ? rawPrinterId
            : fallbackPrinterId;

        return {
          id: profile.id,
          printerProfileId,
          officialTemplateId: inferredTemplateId || undefined,
          officialTemplateVersion: normalizeProfileVersion(materialProfile.officialTemplateVersion, normalizeProfileVersion((matchedTemplate as any)?.profileVersion, 1)),
          name: profile.name,
          brand: typeof (profile as any).brand === 'string' ? (profile as any).brand : 'Default',
          currencyCode: typeof (profile as any).currencyCode === 'string' ? (profile as any).currencyCode.toUpperCase() : 'USD',
          bottlePrice: Number((profile as any).bottlePrice) || 0,
          bottleCapacityMl: Number((profile as any).bottleCapacityMl) || 1000,
          resinFamily: (profile.resinFamily ?? 'standard') as MaterialProfile['resinFamily'],
          scaleCompensationPct: {
            x: Number((profile as any).scaleCompensationPct?.x) || 0,
            y: Number((profile as any).scaleCompensationPct?.y) || 0,
            z: Number((profile as any).scaleCompensationPct?.z) || 0,
          },
          layerHeightMm: Number((profile as any).layerHeightMm) || 0.05,
          normalExposureSec: Number((profile as any).normalExposureSec) || 2.5,
          bottomExposureSec: Number((profile as any).bottomExposureSec) || 28,
          bottomLayerCount: Number((profile as any).bottomLayerCount) || 5,
          liftDistanceMm: Number((profile as any).liftDistanceMm) || 6,
          liftSpeedMmMin: Number((profile as any).liftSpeedMmMin) || 60,
          retractSpeedMmMin: Number((profile as any).retractSpeedMmMin) || 150,
          minimumAaAlphaPercent: normalizeMinimumAaAlphaPercent((profile as any).minimumAaAlphaPercent, 35),
          localSettingsByOutput: sanitizeLocalSettingsByOutput((profile as any).localSettingsByOutput),
        };
      })
      .filter((profile): profile is MaterialProfile => profile !== null)
      : createDefaultMaterials(printerProfiles);

  const ensuredMaterials = printerProfiles.length === 0
    ? []
    : materialProfiles.length > 0
    ? materialProfiles
    : createDefaultMaterials(printerProfiles);

  const activePrinterProfileId =
    typeof input?.activePrinterProfileId === 'string'
      && printerProfiles.some((profile) => profile.id === input.activePrinterProfileId)
      ? input.activePrinterProfileId
      : printerProfiles[0]?.id ?? '';

  const materialsForActivePrinter = ensuredMaterials.filter((profile) => profile.printerProfileId === activePrinterProfileId);
  const fallbackActiveMaterialId = materialsForActivePrinter[0]?.id ?? ensuredMaterials[0]?.id ?? '';

  const activeMaterialProfileId =
    typeof input?.activeMaterialProfileId === 'string'
      && materialsForActivePrinter.some((profile) => profile.id === input.activeMaterialProfileId)
      ? input.activeMaterialProfileId
      : fallbackActiveMaterialId ?? '';

  return {
    printerProfiles,
    materialProfiles: ensuredMaterials,
    activePrinterProfileId,
    activeMaterialProfileId,
  };
}

function persist(next: ProfileStoreState): void {
  if (typeof window === 'undefined') return;
  try {
    const payload: PersistedProfileStoreEnvelope = {
      version: PROFILE_STORE_SCHEMA_VERSION,
      state: next,
    };

    const serialized = JSON.stringify(payload);
    window.localStorage.setItem(STORAGE_KEY, serialized);
    window.localStorage.setItem(STORAGE_BACKUP_KEY, serialized);
  } catch (error) {
    console.error('[ProfileStore] Failed to persist profile state', error);
  }
}

function parsePersistedState(raw: string | null): Partial<ProfileStoreState> | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;

    const envelopeState = (parsed as any).state;
    if (envelopeState && typeof envelopeState === 'object') {
      return envelopeState as Partial<ProfileStoreState>;
    }

    return parsed as Partial<ProfileStoreState>;
  } catch {
    return null;
  }
}

function ensureHydrated(): void {
  if (typeof window === 'undefined') return;
  if (isHydrated) return;
  hydratePluginRegistry();
  hydrateProfilesFromStorage();
}

export function hydrateProfilesFromStorage(): void {
  if (typeof window === 'undefined') return;
  if (isHydrated) return;

  isHydrated = true;

  try {
    const candidateRawValues = [
      window.localStorage.getItem(STORAGE_KEY),
      window.localStorage.getItem(STORAGE_BACKUP_KEY),
      ...LEGACY_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)),
    ];

    const parsed = candidateRawValues
      .map((raw) => parsePersistedState(raw))
      .find((candidate): candidate is Partial<ProfileStoreState> => candidate !== null);

    if (!parsed) {
      persist(state);
      return;
    }

    state = sanitizeState(parsed);
    persist(state);
    notify();
  } catch (error) {
    console.error('[ProfileStore] Failed to hydrate profile state', error);
    state = createDefaultState();
    persist(state);
    notify();
  }
}

export function subscribeToProfileStore(listener: Listener): () => void {
  ensureHydrated();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getProfileStoreSnapshot(): ProfileStoreState {
  ensureHydrated();
  return state;
}

export function getProfileStoreServerSnapshot(): ProfileStoreState {
  if (!serverSnapshot) {
    serverSnapshot = createDefaultState();
  }
  return serverSnapshot;
}

function setState(next: ProfileStoreState): void {
  ensureHydrated();
  state = sanitizeState(next);
  persist(state);
  notify();
}

function getFirstMaterialForPrinter(printerId: string, sourceState: ProfileStoreState = state): MaterialProfile | null {
  return sourceState.materialProfiles.find((profile) => profile.printerProfileId === printerId) ?? null;
}

function ensureActiveMaterialForActivePrinter(nextState: ProfileStoreState): ProfileStoreState {
  if (!nextState.activePrinterProfileId) {
    return {
      ...nextState,
      materialProfiles: [],
      activeMaterialProfileId: '',
    };
  }

  const materialForActivePrinter = getFirstMaterialForPrinter(nextState.activePrinterProfileId, nextState);

  if (!materialForActivePrinter) {
    const createdMaterial: MaterialProfile = {
      id: createId('material'),
      printerProfileId: nextState.activePrinterProfileId,
      officialTemplateId: undefined,
      officialTemplateVersion: undefined,
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
      minimumAaAlphaPercent: 35,
      localSettingsByOutput: undefined,
    };

    return {
      ...nextState,
      materialProfiles: [...nextState.materialProfiles, createdMaterial],
      activeMaterialProfileId: createdMaterial.id,
    };
  }

  const activeMaterialValid = nextState.materialProfiles.some(
    (profile) => profile.id === nextState.activeMaterialProfileId && profile.printerProfileId === nextState.activePrinterProfileId,
  );

  if (activeMaterialValid) return nextState;

  return {
    ...nextState,
    activeMaterialProfileId: materialForActivePrinter.id,
  };
}

function createId(prefix: 'printer' | 'material' | 'network-device'): string {
  const rand = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

export function setActivePrinterProfile(id: string): void {
  ensureHydrated();
  if (!state.printerProfiles.some((profile) => profile.id === id)) return;
  if (state.activePrinterProfileId === id) return;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    activePrinterProfileId: id,
  }));
}

export function setActiveMaterialProfile(id: string): void {
  ensureHydrated();
  const match = state.materialProfiles.find((profile) => profile.id === id);
  if (!match) return;
  if (match.printerProfileId !== state.activePrinterProfileId) return;
  if (state.activeMaterialProfileId === id) return;

  setState({
    ...state,
    activeMaterialProfileId: id,
  });
}

export function addPrinterProfile(partial?: Partial<Omit<PrinterProfile, 'id'>>): string {
  ensureHydrated();
  const networkSupport = normalizeNetworkSupport(partial?.networkSupport);
  const networkSettings = sanitizePrinterNetworkSettings(partial?.network);

  const profile: PrinterProfile = {
    id: createId('printer'),
    name: partial?.name?.trim() || `Printer ${state.printerProfiles.length + 1}`,
    manufacturer: partial?.manufacturer?.trim() || 'Generic',
    imageDataUrl: partial?.imageDataUrl,
    antiAliasing: normalizeAntiAliasingSupport(partial?.antiAliasing),
    networkSupport,
    hasCamera: normalizeCameraSupport(partial?.hasCamera),
    networkFilter: sanitizeNetworkFilter(partial?.networkFilter),
    platformBadge: sanitizePlatformBadge(partial?.platformBadge),
    pixelSize: sanitizePixelSize(partial?.pixelSize),
    bitDepth: sanitizeBitDepth(partial?.bitDepth),
    buildDimensionMode: normalizeBuildDimensionMode((partial as any)?.buildDimensionMode) ?? 'manual',
    officialPresetId: partial?.officialPresetId?.trim(),
    officialPresetVersion: Number.isFinite(Number((partial as any)?.officialPresetVersion))
      ? normalizeProfileVersion((partial as any).officialPresetVersion, 1)
      : undefined,
    isOfficial: partial?.isOfficial ?? false,
    isCustom: partial?.isCustom ?? true,
    buildVolumeMm: partial?.buildVolumeMm ?? { width: 143, depth: 89, height: 175 },
    safetyMarginMm: sanitizeSafetyMarginMm(partial?.safetyMarginMm),
    display: {
      resolutionX: partial?.display?.resolutionX ?? 2560,
      resolutionY: partial?.display?.resolutionY ?? 1620,
      outputFormat: normalizeOutputFormat(partial?.display?.outputFormat),
      formatVersion: normalizeFormatVersion(partial?.display?.formatVersion),
      settingsMode: normalizeSettingsMode(partial?.display?.settingsMode),
      webcamRotationDeg: normalizeWebcamRotationDeg(
        partial?.display?.webcamRotationDeg ?? (partial?.display as { webcamOrientation?: unknown } | undefined)?.webcamOrientation,
        DEFAULT_WEBCAM_ROTATION_DEG,
      ),
      mirrorX: normalizeMirrorFlag(partial?.display?.mirrorX, false),
      mirrorY: normalizeMirrorFlag(partial?.display?.mirrorY, false),
    },
    network: networkSettings,
    networkFleet: networkSupport ? sanitizePrinterNetworkFleet(partial?.networkFleet, networkSupport, networkSettings.ipAddress) : undefined,
    activeNetworkDeviceId: typeof partial?.activeNetworkDeviceId === 'string' ? partial.activeNetworkDeviceId.trim() || undefined : undefined,
    networkConnection: networkSupport
      ? sanitizePrinterNetworkConnectionState(partial?.networkConnection, networkSupport, networkSettings.ipAddress)
      : undefined,
  };

  const nextState = {
    ...state,
    printerProfiles: [...state.printerProfiles, profile],
    activePrinterProfileId: profile.id,
  };

  setState(ensureActiveMaterialForActivePrinter(nextState));

  return profile.id;
}

export function getAvailablePrinterPresets(): PrinterPreset[] {
  ensureHydrated();
  return getAllPrinterPresets();
}

export function addPrinterProfileFromPreset(presetId: string): string {
  ensureHydrated();
  const preset = getAllPrinterPresets().find((item) => item.presetId === presetId);
  if (!preset) {
    throw new Error(`[ProfileStore] Unknown printer preset id: ${presetId}`);
  }

  const existingOfficial = state.printerProfiles.find((profile) => (
    profile.isOfficial
    && resolveOfficialPresetId(profile) === presetId
  ));

  if (existingOfficial) {
    return existingOfficial.id;
  }

  return addPrinterProfile({
    name: preset.name,
    manufacturer: preset.manufacturer,
    imageDataUrl: preset.imageAssetPath,
    antiAliasing: normalizeAntiAliasingSupport((preset as any).antiAliasing),
    networkSupport: normalizeNetworkSupport(preset.networkSupport),
    hasCamera: normalizeCameraSupport((preset as any).hasCamera),
    networkFilter: sanitizeNetworkFilter((preset as any).networkFilter),
    platformBadge: sanitizePlatformBadge((preset as any).platformBadge),
    pixelSize: sanitizePixelSize((preset as any).pixelSize),
    bitDepth: sanitizeBitDepth((preset as any).bitDepth),
    buildDimensionMode: normalizeBuildDimensionMode((preset as any).buildDimensionMode) ?? 'manual',
    officialPresetId: preset.presetId,
    officialPresetVersion: normalizeProfileVersion((preset as any).profileVersion, 1),
    isOfficial: true,
    isCustom: false,
    buildVolumeMm: preset.buildVolumeMm,
    safetyMarginMm: sanitizeSafetyMarginMm((preset as any).safetyMarginMm),
    display: {
      resolutionX: preset.display.resolutionX,
      resolutionY: preset.display.resolutionY,
      outputFormat: normalizeOutputFormat(preset.display.outputFormat),
      formatVersion: normalizeFormatVersion((preset.display as { formatVersion?: unknown }).formatVersion),
      settingsMode: normalizeSettingsMode((preset.display as { settingsMode?: unknown }).settingsMode),
      webcamRotationDeg: normalizeWebcamRotationDeg(
        (preset.display as { webcamRotationDeg?: unknown; webcamOrientation?: unknown }).webcamRotationDeg
        ?? (preset.display as { webcamRotationDeg?: unknown; webcamOrientation?: unknown }).webcamOrientation,
        DEFAULT_WEBCAM_ROTATION_DEG,
      ),
      mirrorX: normalizeMirrorFlag((preset.display as { mirrorX?: unknown }).mirrorX, false),
      mirrorY: normalizeMirrorFlag((preset.display as { mirrorY?: unknown }).mirrorY, false),
    },
  });
}

export function addMaterialProfile(
  printerProfileId: string,
  partial?: Partial<Omit<MaterialProfile, 'id' | 'printerProfileId'>>,
): string {
  ensureHydrated();
  if (!state.printerProfiles.some((profile) => profile.id === printerProfileId)) {
    throw new Error(`[ProfileStore] Cannot add material. Unknown printer profile id: ${printerProfileId}`);
  }

  const profile: MaterialProfile = {
    id: createId('material'),
    printerProfileId,
    officialTemplateId: typeof (partial as any)?.officialTemplateId === 'string' && (partial as any).officialTemplateId.trim().length > 0
      ? (partial as any).officialTemplateId.trim()
      : undefined,
    officialTemplateVersion: Number.isFinite(Number((partial as any)?.officialTemplateVersion))
      ? normalizeProfileVersion((partial as any).officialTemplateVersion, 1)
      : undefined,
    name: partial?.name?.trim() || `Material ${state.materialProfiles.length + 1}`,
    brand: partial?.brand?.trim() || 'Default',
    currencyCode: partial?.currencyCode?.trim().toUpperCase() || 'USD',
    bottlePrice: partial?.bottlePrice ?? 0,
    bottleCapacityMl: partial?.bottleCapacityMl ?? 1000,
    resinFamily: partial?.resinFamily ?? 'standard',
    scaleCompensationPct: {
      x: partial?.scaleCompensationPct?.x ?? 0,
      y: partial?.scaleCompensationPct?.y ?? 0,
      z: partial?.scaleCompensationPct?.z ?? 0,
    },
    layerHeightMm: partial?.layerHeightMm ?? 0.05,
    normalExposureSec: partial?.normalExposureSec ?? 2.5,
    bottomExposureSec: partial?.bottomExposureSec ?? 28,
    bottomLayerCount: partial?.bottomLayerCount ?? 5,
    liftDistanceMm: partial?.liftDistanceMm ?? 6,
    liftSpeedMmMin: partial?.liftSpeedMmMin ?? 60,
    retractSpeedMmMin: partial?.retractSpeedMmMin ?? 150,
    minimumAaAlphaPercent: normalizeMinimumAaAlphaPercent(partial?.minimumAaAlphaPercent, 35),
    localSettingsByOutput: sanitizeLocalSettingsByOutput(partial?.localSettingsByOutput),
  };

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    materialProfiles: [...state.materialProfiles, profile],
    activePrinterProfileId: printerProfileId,
    activeMaterialProfileId: profile.id,
  }));

  return profile.id;
}

export function updatePrinterProfile(id: string, updates: Partial<Omit<PrinterProfile, 'id'>>): void {
  ensureHydrated();
  let changed = false;

  const filterOfficialPrinterProfileUpdates = (
    sourceUpdates: Partial<Omit<PrinterProfile, 'id'>>,
  ): Partial<Omit<PrinterProfile, 'id'>> => {
    const nextUpdates: Partial<Omit<PrinterProfile, 'id'>> = {};

    if (Object.prototype.hasOwnProperty.call(sourceUpdates, 'networkSupport')) {
      nextUpdates.networkSupport = sourceUpdates.networkSupport;
    }

    if (Object.prototype.hasOwnProperty.call(sourceUpdates, 'hasCamera')) {
      nextUpdates.hasCamera = sourceUpdates.hasCamera;
    }

    if (sourceUpdates.display) {
      const nextDisplay: Partial<PrinterProfile['display']> = {};
      if (Object.prototype.hasOwnProperty.call(sourceUpdates.display, 'outputFormat')) {
        nextDisplay.outputFormat = sourceUpdates.display.outputFormat;
      }
      if (Object.prototype.hasOwnProperty.call(sourceUpdates.display, 'formatVersion')) {
        nextDisplay.formatVersion = sourceUpdates.display.formatVersion;
      }
      if (Object.prototype.hasOwnProperty.call(sourceUpdates.display, 'webcamRotationDeg')) {
        nextDisplay.webcamRotationDeg = sourceUpdates.display.webcamRotationDeg;
      }
      if (Object.prototype.hasOwnProperty.call(sourceUpdates.display as Record<string, unknown>, 'webcamOrientation')) {
        nextDisplay.webcamRotationDeg = (sourceUpdates.display as { webcamOrientation?: unknown }).webcamOrientation as PrinterWebcamRotationDeg;
      }
      if (Object.keys(nextDisplay).length > 0) {
        nextUpdates.display = nextDisplay as PrinterProfile['display'];
      }
    }

    return nextUpdates;
  };

  const targetProfile = state.printerProfiles.find((profile) => profile.id === id);
  const appliedUpdates = targetProfile?.isOfficial === true
    ? filterOfficialPrinterProfileUpdates(updates)
    : updates;
  const hasNetworkSupportUpdate = Object.prototype.hasOwnProperty.call(appliedUpdates, 'networkSupport');
  const hasBuildDimensionModeUpdate = Object.prototype.hasOwnProperty.call(appliedUpdates, 'buildDimensionMode');

  if (targetProfile?.isOfficial === true && Object.keys(appliedUpdates).length === 0) {
    return;
  }

  const printerProfiles = state.printerProfiles.map((profile) => {
    if (profile.id !== id) return profile;
    changed = true;

    const nextNetworkSupport = hasNetworkSupportUpdate
      ? normalizeNetworkSupport(appliedUpdates.networkSupport)
      : profile.networkSupport;
    const nextNetwork = appliedUpdates.network !== undefined
      ? sanitizePrinterNetworkSettings(appliedUpdates.network)
      : sanitizePrinterNetworkSettings(profile.network);
    const nextNetworkConnection = appliedUpdates.networkConnection !== undefined
      ? (
        nextNetworkSupport
          ? sanitizePrinterNetworkConnectionState(
            appliedUpdates.networkConnection,
            nextNetworkSupport,
            nextNetwork.ipAddress,
          )
          : undefined
      )
      : profile.networkConnection;
    const nextNetworkProfileState = nextNetworkSupport
      ? deriveNetworkProfileState(
        {
          ...profile,
          networkSupport: nextNetworkSupport,
          network: nextNetwork,
          networkFleet: appliedUpdates.networkFleet !== undefined ? appliedUpdates.networkFleet : profile.networkFleet,
          activeNetworkDeviceId: appliedUpdates.activeNetworkDeviceId !== undefined ? appliedUpdates.activeNetworkDeviceId : profile.activeNetworkDeviceId,
          networkConnection: nextNetworkConnection,
        },
        nextNetworkSupport,
      )
      : {
        network: nextNetwork,
        networkFleet: undefined,
        activeNetworkDeviceId: undefined,
        networkConnection: undefined,
      };

    return {
      ...profile,
      ...appliedUpdates,
      name: appliedUpdates.name !== undefined ? appliedUpdates.name : profile.name,
      manufacturer: appliedUpdates.manufacturer !== undefined ? appliedUpdates.manufacturer : profile.manufacturer,
      antiAliasing: appliedUpdates.antiAliasing !== undefined
        ? normalizeAntiAliasingSupport(appliedUpdates.antiAliasing)
        : profile.antiAliasing,
      networkSupport: nextNetworkSupport,
      hasCamera: appliedUpdates.hasCamera !== undefined
        ? normalizeCameraSupport(appliedUpdates.hasCamera)
        : profile.hasCamera,
      networkFilter: appliedUpdates.networkFilter !== undefined
        ? sanitizeNetworkFilter(appliedUpdates.networkFilter)
        : profile.networkFilter,
      platformBadge: appliedUpdates.platformBadge !== undefined
        ? sanitizePlatformBadge(appliedUpdates.platformBadge)
        : profile.platformBadge,
      pixelSize: appliedUpdates.pixelSize !== undefined
        ? sanitizePixelSize(appliedUpdates.pixelSize)
        : profile.pixelSize,
      bitDepth: appliedUpdates.bitDepth !== undefined
        ? sanitizeBitDepth(appliedUpdates.bitDepth)
        : profile.bitDepth,
      buildDimensionMode: hasBuildDimensionModeUpdate
        ? (normalizeBuildDimensionMode((appliedUpdates as any).buildDimensionMode) ?? 'manual')
        : (profile.buildDimensionMode ?? 'manual'),
      isOfficial: profile.isOfficial,
      isCustom: profile.isCustom,
      buildVolumeMm: appliedUpdates.buildVolumeMm ?? profile.buildVolumeMm,
      safetyMarginMm: appliedUpdates.safetyMarginMm !== undefined
        ? sanitizeSafetyMarginMm(appliedUpdates.safetyMarginMm)
        : profile.safetyMarginMm,
      display: appliedUpdates.display
        ? {
          resolutionX: Number(appliedUpdates.display.resolutionX) || profile.display.resolutionX,
          resolutionY: Number(appliedUpdates.display.resolutionY) || profile.display.resolutionY,
          outputFormat: normalizeOutputFormat(appliedUpdates.display.outputFormat ?? profile.display.outputFormat),
          formatVersion: normalizeFormatVersion(appliedUpdates.display.formatVersion ?? profile.display.formatVersion),
          settingsMode: normalizeSettingsMode(appliedUpdates.display.settingsMode ?? profile.display.settingsMode),
          webcamRotationDeg: normalizeWebcamRotationDeg(
            appliedUpdates.display.webcamRotationDeg
            ?? (appliedUpdates.display as { webcamOrientation?: unknown }).webcamOrientation
            ?? profile.display.webcamRotationDeg
            ?? (profile.display as { webcamOrientation?: unknown }).webcamOrientation,
            DEFAULT_WEBCAM_ROTATION_DEG,
          ),
          mirrorX: normalizeMirrorFlag(appliedUpdates.display.mirrorX, profile.display.mirrorX === true),
          mirrorY: normalizeMirrorFlag(appliedUpdates.display.mirrorY, profile.display.mirrorY === true),
        }
        : profile.display,
      network: nextNetworkProfileState.network,
      networkFleet: nextNetworkProfileState.networkFleet,
      activeNetworkDeviceId: nextNetworkProfileState.activeNetworkDeviceId,
      networkConnection: nextNetworkProfileState.networkConnection,
    };
  });

  if (!changed) return;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    printerProfiles,
  }));
}

export function updatePrinterNetworkSettings(id: string, updates: Partial<PrinterNetworkSettings>): void {
  ensureHydrated();
  let changed = false;

  const printerProfiles = state.printerProfiles.map((profile) => {
    if (profile.id !== id) return profile;

    const current = sanitizePrinterNetworkSettings(profile.network);
    const next = sanitizePrinterNetworkSettings({
      ...current,
      ...updates,
    });

    if (
      next.discoveryEnabled === current.discoveryEnabled
      && next.ipAddress === current.ipAddress
    ) {
      return profile;
    }

    changed = true;

    return {
      ...profile,
      network: next,
    };
  });

  if (!changed) return;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    printerProfiles,
  }));
}

export function updatePrinterNetworkConnectionStatus(
  id: string,
  updates: Partial<PrinterNetworkConnectionState>,
): void {
  ensureHydrated();
  let changed = false;

  const printerProfiles = state.printerProfiles.map((profile) => {
    if (profile.id !== id) return profile;
    if (!profile.networkSupport) return profile;

    const base = sanitizePrinterNetworkConnectionState(
      profile.networkConnection,
      profile.networkSupport,
      sanitizePrinterNetworkSettings(profile.network).ipAddress,
    );

    const next = sanitizePrinterNetworkConnectionState(
      {
        ...base,
        ...updates,
      },
      profile.networkSupport,
      sanitizePrinterNetworkSettings(profile.network).ipAddress,
    );

    if (
      next.mode === base.mode
      && next.connected === base.connected
      && next.hostName === base.hostName
      && next.ipAddress === base.ipAddress
      && next.port === base.port
      && next.lastCheckedAt === base.lastCheckedAt
      && next.statusText === base.statusText
      && next.selectedMaterialId === base.selectedMaterialId
      && next.selectedMaterialName === base.selectedMaterialName
      && next.selectedMaterialLayerHeightMm === base.selectedMaterialLayerHeightMm
      && next.selectedMaterialNormalExposureSec === base.selectedMaterialNormalExposureSec
      && next.selectedMaterialBottomExposureSec === base.selectedMaterialBottomExposureSec
      && next.selectedMaterialBottomLayerCount === base.selectedMaterialBottomLayerCount
    ) {
      return profile;
    }

    changed = true;
    const fleet = Array.isArray(profile.networkFleet) ? [...profile.networkFleet] : [];
    const activeDeviceId = profile.activeNetworkDeviceId?.trim() || '';
    const activeIndex = fleet.findIndex((device) => device.id === activeDeviceId);

    if (activeIndex >= 0) {
      const resolvedDisplayName = (
        next.connected && next.hostName.trim().length > 0
          ? next.hostName
          : fleet[activeIndex].displayName || next.hostName || next.ipAddress || 'Printer'
      );

      fleet[activeIndex] = {
        ...fleet[activeIndex],
        ...next,
        displayName: resolvedDisplayName,
      };
    } else if (hasMeaningfulPrinterNetworkConnection(next)) {
      fleet.push({
        id: createId('network-device'),
        displayName: next.hostName || next.ipAddress || 'Printer',
        ...next,
      });
    }

    return {
      ...profile,
      networkFleet: fleet,
      networkConnection: next,
    };
  });

  if (!changed) return;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    printerProfiles,
  }));
}

export function updateMaterialProfile(id: string, updates: Partial<Omit<MaterialProfile, 'id'>>): void {
  ensureHydrated();
  let changed = false;

  const materialProfiles = state.materialProfiles.map((profile) => {
    if (profile.id !== id) return profile;
    // Official template materials are read-only; only internal update paths (applyOfficialMaterialProfileUpdate) may change them.
    const isOfficial = typeof profile.officialTemplateId === 'string' && profile.officialTemplateId.trim().length > 0;
    if (isOfficial) return profile;
    changed = true;
    return {
      ...profile,
      ...updates,
      printerProfileId: profile.printerProfileId,
      brand: updates.brand !== undefined ? updates.brand : profile.brand,
      currencyCode: updates.currencyCode !== undefined ? updates.currencyCode.toUpperCase() : profile.currencyCode,
      name: updates.name !== undefined ? updates.name : profile.name,
      localSettingsByOutput: updates.localSettingsByOutput !== undefined
        ? sanitizeLocalSettingsByOutput(updates.localSettingsByOutput)
        : profile.localSettingsByOutput,
    };
  });

  if (!changed) return;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    materialProfiles,
  }));
}

export function removePrinterProfile(id: string): void {
  ensureHydrated();
  if (!state.printerProfiles.some((profile) => profile.id === id)) return;

  const printerProfiles = state.printerProfiles.filter((profile) => profile.id !== id);
  const materialProfiles = state.materialProfiles.filter((profile) => profile.printerProfileId !== id);
  const activePrinterProfileId =
    state.activePrinterProfileId === id
      ? printerProfiles[0]?.id ?? ''
      : state.activePrinterProfileId;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    printerProfiles,
    materialProfiles,
    activePrinterProfileId,
  }));
}

export function duplicatePrinterProfileAsCustom(id: string): string {
  ensureHydrated();
  const source = state.printerProfiles.find((profile) => profile.id === id);
  if (!source) {
    throw new Error(`[ProfileStore] Cannot duplicate unknown printer profile id: ${id}`);
  }

  const duplicateId = createId('printer');
  const baseName = source.name.includes('Custom') ? source.name : `${source.name} Custom`;
  const duplicateName = state.printerProfiles.some((profile) => profile.name === baseName)
    ? `${baseName} ${state.printerProfiles.length + 1}`
    : baseName;

  const duplicatedPrinter: PrinterProfile = {
    ...source,
    id: duplicateId,
    name: duplicateName,
    isOfficial: false,
    isCustom: true,
  };

  const sourceMaterials = state.materialProfiles.filter((material) => material.printerProfileId === source.id);
  const duplicatedMaterials: MaterialProfile[] = sourceMaterials.length > 0
    ? sourceMaterials.map((material) => ({
      ...material,
      id: createId('material'),
      printerProfileId: duplicateId,
      officialTemplateId: undefined,
      officialTemplateVersion: undefined,
    }))
    : [
      {
        id: createId('material'),
        printerProfileId: duplicateId,
        officialTemplateId: undefined,
        officialTemplateVersion: undefined,
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
        minimumAaAlphaPercent: 35,
        localSettingsByOutput: undefined,
      },
    ];

  setState({
    ...state,
    printerProfiles: [...state.printerProfiles, duplicatedPrinter],
    materialProfiles: [...state.materialProfiles, ...duplicatedMaterials],
    activePrinterProfileId: duplicateId,
    activeMaterialProfileId: duplicatedMaterials[0].id,
  });

  return duplicateId;
}

export function movePrinterProfile(id: string, beforeId?: string): void {
  ensureHydrated();
  const sourceIndex = state.printerProfiles.findIndex((profile) => profile.id === id);
  if (sourceIndex < 0) return;

  const nextPrinterProfiles = [...state.printerProfiles];
  const [movedPrinter] = nextPrinterProfiles.splice(sourceIndex, 1);
  if (!movedPrinter) return;

  const normalizedBeforeId = typeof beforeId === 'string' ? beforeId.trim() : '';
  if (!normalizedBeforeId) {
    nextPrinterProfiles.push(movedPrinter);
  } else {
    const targetIndex = nextPrinterProfiles.findIndex((profile) => profile.id === normalizedBeforeId);
    if (targetIndex < 0) {
      nextPrinterProfiles.push(movedPrinter);
    } else {
      nextPrinterProfiles.splice(targetIndex, 0, movedPrinter);
    }
  }

  setState({
    ...state,
    printerProfiles: nextPrinterProfiles,
  });
}

export type PrinterBundleExportPayload = {
  version: number;
  exportedAt: string;
  printer: PrinterProfile;
  materials: MaterialProfile[];
};

export function importPrinterBundle(payload: unknown): string {
  ensureHydrated();

  const bundle = payload as Partial<PrinterBundleExportPayload> & {
    printer?: Partial<PrinterProfile>;
    materials?: unknown;
  };

  const sourcePrinter = bundle?.printer;
  if (!sourcePrinter || typeof sourcePrinter !== 'object') {
    throw new Error('[ProfileStore] Invalid printer bundle payload');
  }

  const importedPrinterId = createId('printer');
  const importedNetworkSupport = normalizeNetworkSupport(sourcePrinter.networkSupport);
  const importedNetworkSettings = sanitizePrinterNetworkSettings(sourcePrinter.network);
  const importedPrinter: PrinterProfile = {
    id: importedPrinterId,
    name: typeof sourcePrinter.name === 'string' && sourcePrinter.name.trim().length > 0
      ? sourcePrinter.name.trim()
      : `Printer ${state.printerProfiles.length + 1}`,
    manufacturer: typeof sourcePrinter.manufacturer === 'string' && sourcePrinter.manufacturer.trim().length > 0
      ? sourcePrinter.manufacturer.trim()
      : 'Generic',
    imageDataUrl: typeof sourcePrinter.imageDataUrl === 'string' ? sourcePrinter.imageDataUrl : undefined,
    antiAliasing: normalizeAntiAliasingSupport(sourcePrinter.antiAliasing),
    networkSupport: importedNetworkSupport,
    hasCamera: normalizeCameraSupport(sourcePrinter.hasCamera),
    networkFilter: sanitizeNetworkFilter(sourcePrinter.networkFilter),
    platformBadge: sanitizePlatformBadge(sourcePrinter.platformBadge),
    pixelSize: sanitizePixelSize(sourcePrinter.pixelSize),
    bitDepth: sanitizeBitDepth(sourcePrinter.bitDepth),
    buildDimensionMode: normalizeBuildDimensionMode(sourcePrinter.buildDimensionMode) ?? 'manual',
    officialPresetId: undefined,
    officialPresetVersion: undefined,
    isOfficial: false,
    isCustom: true,
    buildVolumeMm: sourcePrinter.buildVolumeMm ?? { width: 143, depth: 89, height: 175 },
    safetyMarginMm: sanitizeSafetyMarginMm(sourcePrinter.safetyMarginMm),
    display: {
      resolutionX: sourcePrinter.display?.resolutionX ?? 2560,
      resolutionY: sourcePrinter.display?.resolutionY ?? 1620,
      outputFormat: normalizeOutputFormat(sourcePrinter.display?.outputFormat),
      formatVersion: normalizeFormatVersion(sourcePrinter.display?.formatVersion),
      settingsMode: normalizeSettingsMode(sourcePrinter.display?.settingsMode),
      webcamRotationDeg: normalizeWebcamRotationDeg(
        sourcePrinter.display?.webcamRotationDeg ?? (sourcePrinter.display as { webcamOrientation?: unknown } | undefined)?.webcamOrientation,
        DEFAULT_WEBCAM_ROTATION_DEG,
      ),
      mirrorX: normalizeMirrorFlag(sourcePrinter.display?.mirrorX, false),
      mirrorY: normalizeMirrorFlag(sourcePrinter.display?.mirrorY, false),
    },
    network: importedNetworkSettings,
    networkFleet: importedNetworkSupport
      ? sanitizePrinterNetworkFleet(sourcePrinter.networkFleet, importedNetworkSupport, importedNetworkSettings.ipAddress)
      : undefined,
    activeNetworkDeviceId: typeof sourcePrinter.activeNetworkDeviceId === 'string' && sourcePrinter.activeNetworkDeviceId.trim().length > 0
      ? sourcePrinter.activeNetworkDeviceId.trim()
      : undefined,
    networkConnection: importedNetworkSupport
      ? sanitizePrinterNetworkConnectionState(sourcePrinter.networkConnection, importedNetworkSupport, importedNetworkSettings.ipAddress)
      : undefined,
  };

  const sourceMaterials = Array.isArray(bundle.materials) ? (bundle.materials as unknown[]) : [];
  const importedMaterials: MaterialProfile[] = sourceMaterials
    .filter((item): item is MaterialProfile => Boolean(item) && typeof item === 'object')
    .map((material, index) => ({
      id: createId('material'),
      printerProfileId: importedPrinterId,
      officialTemplateId: typeof material.officialTemplateId === 'string' && material.officialTemplateId.trim().length > 0
        ? material.officialTemplateId.trim()
        : undefined,
      officialTemplateVersion: Number.isFinite(Number(material.officialTemplateVersion))
        ? normalizeProfileVersion(material.officialTemplateVersion, 1)
        : undefined,
      name: typeof material.name === 'string' && material.name.trim().length > 0
        ? material.name.trim()
        : `Material ${index + 1}`,
      brand: typeof material.brand === 'string' && material.brand.trim().length > 0
        ? material.brand.trim()
        : 'Default',
      currencyCode: typeof material.currencyCode === 'string' && material.currencyCode.trim().length > 0
        ? material.currencyCode.trim().toUpperCase()
        : 'USD',
      bottlePrice: Number.isFinite(Number(material.bottlePrice)) ? Number(material.bottlePrice) : 0,
      bottleCapacityMl: Number.isFinite(Number(material.bottleCapacityMl)) ? Number(material.bottleCapacityMl) : 1000,
      resinFamily: material.resinFamily ?? 'standard',
      scaleCompensationPct: {
        x: Number(material.scaleCompensationPct?.x ?? 0),
        y: Number(material.scaleCompensationPct?.y ?? 0),
        z: Number(material.scaleCompensationPct?.z ?? 0),
      },
      layerHeightMm: Number.isFinite(Number(material.layerHeightMm)) ? Number(material.layerHeightMm) : 0.05,
      normalExposureSec: Number.isFinite(Number(material.normalExposureSec)) ? Number(material.normalExposureSec) : 2.5,
      bottomExposureSec: Number.isFinite(Number(material.bottomExposureSec)) ? Number(material.bottomExposureSec) : 28,
      bottomLayerCount: Number.isFinite(Number(material.bottomLayerCount)) ? Math.max(1, Math.round(Number(material.bottomLayerCount))) : 5,
      liftDistanceMm: Number.isFinite(Number(material.liftDistanceMm)) ? Number(material.liftDistanceMm) : 6,
      liftSpeedMmMin: Number.isFinite(Number(material.liftSpeedMmMin)) ? Number(material.liftSpeedMmMin) : 60,
      retractSpeedMmMin: Number.isFinite(Number(material.retractSpeedMmMin)) ? Number(material.retractSpeedMmMin) : 150,
      minimumAaAlphaPercent: normalizeMinimumAaAlphaPercent(material.minimumAaAlphaPercent, 35),
      localSettingsByOutput: sanitizeLocalSettingsByOutput(material.localSettingsByOutput),
    }));

  if (importedMaterials.length === 0) {
    importedMaterials.push({
      id: createId('material'),
      printerProfileId: importedPrinterId,
      officialTemplateId: undefined,
      officialTemplateVersion: undefined,
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
      minimumAaAlphaPercent: 35,
      localSettingsByOutput: undefined,
    });
  }

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    printerProfiles: [...state.printerProfiles, importedPrinter],
    materialProfiles: [...state.materialProfiles, ...importedMaterials],
    activePrinterProfileId: importedPrinterId,
    activeMaterialProfileId: importedMaterials[0].id,
  }));

  return importedPrinterId;
}

export function removeMaterialProfile(id: string): void {
  ensureHydrated();
  const target = state.materialProfiles.find((profile) => profile.id === id);
  if (!target) return;

  const boundMaterials = state.materialProfiles.filter((profile) => profile.printerProfileId === target.printerProfileId);
  if (boundMaterials.length <= 1) return;

  const materialProfiles = state.materialProfiles.filter((profile) => profile.id !== id);
  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    materialProfiles,
  }));
}

export function getPrinterNetworkFleet(printerProfileId: string, stateOverride?: ProfileStoreState): PrinterNetworkDevice[] {
  const snapshot = stateOverride ?? state;
  const profile = snapshot.printerProfiles.find((entry) => entry.id === printerProfileId);
  return Array.isArray(profile?.networkFleet) ? profile.networkFleet : [];
}

export function getConnectedPrinterNetworkFleet(printerProfileId: string, stateOverride?: ProfileStoreState): PrinterNetworkDevice[] {
  return getPrinterNetworkFleet(printerProfileId, stateOverride).filter((device) => device.connected);
}

export function upsertPrinterNetworkDevice(
  printerProfileId: string,
  deviceInput: Partial<PrinterNetworkDevice> & { ipAddress: string },
  options?: { select?: boolean },
): string {
  ensureHydrated();
  const profile = state.printerProfiles.find((entry) => entry.id === printerProfileId);
  if (!profile?.networkSupport) {
    throw new Error(`[ProfileStore] Cannot update network fleet for printer ${printerProfileId}`);
  }

  const normalizedIp = deviceInput.ipAddress.trim();
  if (!normalizedIp) {
    throw new Error('[ProfileStore] ipAddress is required for network fleet device upsert');
  }

  const currentFleet = Array.isArray(profile.networkFleet) ? [...profile.networkFleet] : [];
  const targetIndex = currentFleet.findIndex((device) => (
    (typeof deviceInput.id === 'string' && deviceInput.id.trim().length > 0 && device.id === deviceInput.id.trim())
    || device.ipAddress.trim().toLowerCase() === normalizedIp.toLowerCase()
  ));
  const existing = targetIndex >= 0 ? currentFleet[targetIndex] : createDefaultPrinterNetworkDevice(profile.networkSupport, normalizedIp);
  const nextConnection = sanitizePrinterNetworkConnectionState(
    {
      ...existing,
      ...deviceInput,
      ipAddress: normalizedIp,
    },
    profile.networkSupport,
    normalizedIp,
  );

  const hasImageDataUrlOverride = Object.prototype.hasOwnProperty.call(deviceInput, 'imageDataUrl');
  const nextImageDataUrl = hasImageDataUrlOverride
    ? (typeof deviceInput.imageDataUrl === 'string' && deviceInput.imageDataUrl.trim().length > 0
      ? deviceInput.imageDataUrl
      : undefined)
    : existing.imageDataUrl;

  const nextDevice: PrinterNetworkDevice = {
    id: existing.id,
    displayName: typeof deviceInput.displayName === 'string' && deviceInput.displayName.trim().length > 0
      ? deviceInput.displayName.trim()
      : existing.displayName || nextConnection.hostName || nextConnection.ipAddress || 'Printer',
    imageDataUrl: nextImageDataUrl,
    ...nextConnection,
  };

  if (targetIndex >= 0) {
    currentFleet[targetIndex] = nextDevice;
  } else {
    currentFleet.push(nextDevice);
  }

  const shouldSelect = options?.select === true || !profile.activeNetworkDeviceId;
  const nextActiveDeviceId = shouldSelect ? nextDevice.id : profile.activeNetworkDeviceId;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    printerProfiles: state.printerProfiles.map((entry) => entry.id === printerProfileId
      ? {
        ...entry,
        network: {
          ...sanitizePrinterNetworkSettings(entry.network),
          ipAddress: shouldSelect ? nextDevice.ipAddress : sanitizePrinterNetworkSettings(entry.network).ipAddress,
        },
        networkFleet: currentFleet,
        activeNetworkDeviceId: nextActiveDeviceId,
        networkConnection: shouldSelect
          ? sanitizePrinterNetworkConnectionState(nextDevice, entry.networkSupport!, nextDevice.ipAddress)
          : entry.networkConnection,
      }
      : entry),
  }));

  return nextDevice.id;
}

export function selectPrinterNetworkDevice(printerProfileId: string, deviceId: string): void {
  ensureHydrated();
  const normalizedDeviceId = deviceId.trim();
  if (!normalizedDeviceId) return;

  let changed = false;
  const printerProfiles = state.printerProfiles.map((profile) => {
    if (profile.id !== printerProfileId) return profile;
    const fleet = Array.isArray(profile.networkFleet) ? profile.networkFleet : [];
    const target = fleet.find((device) => device.id === normalizedDeviceId);
    if (!target) return profile;
    if (profile.activeNetworkDeviceId === normalizedDeviceId && sanitizePrinterNetworkSettings(profile.network).ipAddress === target.ipAddress) {
      return profile;
    }
    changed = true;
    return {
      ...profile,
      activeNetworkDeviceId: normalizedDeviceId,
      network: {
        ...sanitizePrinterNetworkSettings(profile.network),
        ipAddress: target.ipAddress,
      },
      networkConnection: sanitizePrinterNetworkConnectionState(target, profile.networkSupport!, target.ipAddress),
    };
  });

  if (!changed) return;
  setState(ensureActiveMaterialForActivePrinter({ ...state, printerProfiles }));
}

export function disconnectPrinterNetworkDevice(printerProfileId: string, deviceId: string): void {
  ensureHydrated();
  let changed = false;
  const now = new Date().toISOString();

  const printerProfiles = state.printerProfiles.map((profile) => {
    if (profile.id !== printerProfileId) return profile;
    const fleet = Array.isArray(profile.networkFleet) ? profile.networkFleet : [];
    const nextFleet = fleet.map((device) => {
      if (device.id !== deviceId) return device;
      changed = true;
      return {
        ...device,
        connected: false,
        lastCheckedAt: now,
        statusText: 'Disconnected',
      };
    });
    if (!changed) return profile;
    const nextActive = nextFleet.find((device) => device.id === profile.activeNetworkDeviceId);
    return {
      ...profile,
      networkFleet: nextFleet,
      networkConnection: nextActive
        ? sanitizePrinterNetworkConnectionState(nextActive, profile.networkSupport!, nextActive.ipAddress)
        : profile.networkConnection,
    };
  });

  if (!changed) return;
  setState(ensureActiveMaterialForActivePrinter({ ...state, printerProfiles }));
}

export function removePrinterNetworkDevice(printerProfileId: string, deviceId: string): void {
  ensureHydrated();
  let changed = false;

  const printerProfiles = state.printerProfiles.map((profile) => {
    if (profile.id !== printerProfileId) return profile;
    const fleet = Array.isArray(profile.networkFleet) ? profile.networkFleet : [];
    const nextFleet = fleet.filter((device) => device.id !== deviceId);
    if (nextFleet.length === fleet.length) return profile;
    changed = true;
    const nextActive = profile.activeNetworkDeviceId === deviceId ? nextFleet[0]?.id : profile.activeNetworkDeviceId;
    return {
      ...profile,
      networkFleet: nextFleet,
      activeNetworkDeviceId: nextActive,
      network: {
        ...sanitizePrinterNetworkSettings(profile.network),
        ipAddress: profile.activeNetworkDeviceId === deviceId ? (nextFleet[0]?.ipAddress ?? '') : sanitizePrinterNetworkSettings(profile.network).ipAddress,
      },
      networkConnection: nextActive
        ? sanitizePrinterNetworkConnectionState(
          nextFleet.find((device) => device.id === nextActive),
          profile.networkSupport!,
          nextFleet.find((device) => device.id === nextActive)?.ipAddress ?? '',
        )
        : createDefaultNetworkConnectionState(profile.networkSupport!, ''),
    };
  });

  if (!changed) return;
  setState(ensureActiveMaterialForActivePrinter({ ...state, printerProfiles }));
}

export function getActivePrinterProfile(stateOverride?: ProfileStoreState): PrinterProfile | null {
  const snapshot = stateOverride ?? state;
  const profile = (
    snapshot.printerProfiles.find((entry) => entry.id === snapshot.activePrinterProfileId)
    ?? snapshot.printerProfiles[0]
    ?? null
  );

  if (!profile) return null;

  return {
    ...profile,
    safetyMarginMm: resolveSafetyMarginForProfile(profile),
  };
}

export function getActiveMaterialProfile(stateOverride?: ProfileStoreState): MaterialProfile | null {
  const snapshot = stateOverride ?? state;
  const activePrinterId = snapshot.activePrinterProfileId;

  const activePrinterProfile = snapshot.printerProfiles.find((entry) => entry.id === activePrinterId)
    ?? snapshot.printerProfiles[0]
    ?? null;

  const materialProfile = (
    snapshot.materialProfiles.find(
      (profile) => profile.id === snapshot.activeMaterialProfileId && profile.printerProfileId === activePrinterId,
    )
    ?? snapshot.materialProfiles.find((profile) => profile.printerProfileId === activePrinterId)
    ?? snapshot.materialProfiles[0]
    ?? null
  );

  if (!materialProfile) return null;
  return resolveMaterialProfileWithLocalSettings(materialProfile, activePrinterProfile);
}

export function getMaterialProfilesForPrinter(printerProfileId: string, stateOverride?: ProfileStoreState): MaterialProfile[] {
  const snapshot = stateOverride ?? state;
  const printerProfile = snapshot.printerProfiles.find((entry) => entry.id === printerProfileId) ?? null;
  return snapshot.materialProfiles
    .filter((profile) => profile.printerProfileId === printerProfileId)
    .map((profile) => resolveMaterialProfileWithLocalSettings(profile, printerProfile));
}

export function getOfficialPrinterProfileUpdates(stateOverride?: ProfileStoreState): OfficialPrinterProfileUpdateInfo[] {
  const snapshot = stateOverride ?? state;
  const presetsById = new Map(getAllPrinterPresets().map((preset) => [preset.presetId, preset] as const));

  return snapshot.printerProfiles
    .filter((profile) => profile.isOfficial === true && typeof profile.officialPresetId === 'string' && profile.officialPresetId.trim().length > 0)
    .map((profile) => {
      const presetId = profile.officialPresetId!.trim();
      const preset = presetsById.get(presetId);
      if (!preset) return null;

      const currentVersion = normalizeProfileVersion(profile.officialPresetVersion, 1);
      const latestVersion = normalizeProfileVersion((preset as any).profileVersion, 1);
      if (latestVersion <= currentVersion) return null;

      return {
        printerProfileId: profile.id,
        printerName: profile.name,
        presetId,
        currentVersion,
        latestVersion,
      } satisfies OfficialPrinterProfileUpdateInfo;
    })
    .filter((item): item is OfficialPrinterProfileUpdateInfo => item !== null);
}

export function getOfficialMaterialProfileUpdates(stateOverride?: ProfileStoreState): OfficialMaterialProfileUpdateInfo[] {
  const snapshot = stateOverride ?? state;
  const templatesById = new Map(
    getAllMaterialTemplates()
      .filter((template) => typeof template.templateId === 'string' && template.templateId.trim().length > 0)
      .map((template) => [template.templateId!.trim(), template] as const),
  );

  return snapshot.materialProfiles
    .filter((profile) => typeof profile.officialTemplateId === 'string' && profile.officialTemplateId.trim().length > 0)
    .map((profile) => {
      const templateId = profile.officialTemplateId!.trim();
      const template = templatesById.get(templateId);
      if (!template) return null;

      const currentVersion = normalizeProfileVersion(profile.officialTemplateVersion, 1);
      const latestVersion = normalizeProfileVersion((template as any).profileVersion, 1);
      if (latestVersion <= currentVersion) return null;

      return {
        materialProfileId: profile.id,
        materialName: profile.name,
        templateId,
        currentVersion,
        latestVersion,
      } satisfies OfficialMaterialProfileUpdateInfo;
    })
    .filter((item): item is OfficialMaterialProfileUpdateInfo => item !== null);
}

export function applyOfficialPrinterProfileUpdate(printerProfileId: string): ApplyOfficialProfileUpdateResult {
  ensureHydrated();

  const profile = state.printerProfiles.find((item) => item.id === printerProfileId);
  if (!profile) return 'not-found';

  const presetId = resolveOfficialPresetId(profile);
  if (!presetId) return 'not-linked';

  const preset = getAllPrinterPresets().find((item) => item.presetId === presetId);
  if (!preset) return 'not-linked';

  const latestVersion = normalizeProfileVersion((preset as any).profileVersion, 1);
  const currentVersion = normalizeProfileVersion(profile.officialPresetVersion, 1);
  if (latestVersion <= currentVersion) return 'already-latest';

  if (profile.isOfficial === true) {
    setState(ensureActiveMaterialForActivePrinter({
      ...state,
      printerProfiles: state.printerProfiles.map((item) => {
        if (item.id !== printerProfileId) return item;

        return {
          ...item,
          name: preset.name,
          manufacturer: preset.manufacturer,
          imageDataUrl: typeof preset.imageAssetPath === 'string' && preset.imageAssetPath.trim().length > 0
            ? preset.imageAssetPath
            : item.imageDataUrl,
          antiAliasing: normalizeAntiAliasingSupport((preset as any).antiAliasing),
          networkSupport: normalizeNetworkSupport(preset.networkSupport),
          hasCamera: normalizeCameraSupport((preset as any).hasCamera),
          networkFilter: sanitizeNetworkFilter((preset as any).networkFilter),
          platformBadge: sanitizePlatformBadge((preset as any).platformBadge),
          pixelSize: sanitizePixelSize((preset as any).pixelSize),
          bitDepth: sanitizeBitDepth((preset as any).bitDepth),
          buildDimensionMode: normalizeBuildDimensionMode((preset as any).buildDimensionMode) ?? 'manual',
          officialPresetId: preset.presetId,
          officialPresetVersion: latestVersion,
          isOfficial: true,
          isCustom: false,
          buildVolumeMm: preset.buildVolumeMm,
          safetyMarginMm: sanitizeSafetyMarginMm((preset as any).safetyMarginMm),
          display: {
            resolutionX: preset.display.resolutionX,
            resolutionY: preset.display.resolutionY,
            outputFormat: normalizeOutputFormat(preset.display.outputFormat),
            formatVersion: normalizeFormatVersion((preset.display as { formatVersion?: unknown }).formatVersion),
            settingsMode: normalizeSettingsMode((preset.display as { settingsMode?: unknown }).settingsMode),
            mirrorX: normalizeMirrorFlag((preset.display as { mirrorX?: unknown }).mirrorX, false),
            mirrorY: normalizeMirrorFlag((preset.display as { mirrorY?: unknown }).mirrorY, false),
          },
          // Preserve user-managed connection/fleet state.
          network: sanitizePrinterNetworkSettings(item.network),
          networkFleet: item.networkFleet,
          activeNetworkDeviceId: item.activeNetworkDeviceId,
          networkConnection: item.networkConnection,
        };
      }),
    }));

    return 'updated';
  }

  // Custom profiles linked to official presets are not overwritten for safety.
  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    printerProfiles: state.printerProfiles.map((item) => item.id === printerProfileId
      ? {
        ...item,
        officialPresetId: preset.presetId,
        officialPresetVersion: latestVersion,
      }
      : item),
  }));

  return 'version-bumped-custom';
}

export function applyOfficialMaterialProfileUpdate(materialProfileId: string): ApplyOfficialProfileUpdateResult {
  ensureHydrated();

  const material = state.materialProfiles.find((item) => item.id === materialProfileId);
  if (!material) return 'not-found';

  const templateId = typeof material.officialTemplateId === 'string' ? material.officialTemplateId.trim() : '';
  if (!templateId) return 'not-linked';

  const template = getAllMaterialTemplates().find((item) => (item.templateId ?? '').trim() === templateId);
  if (!template) return 'not-linked';

  const latestVersion = normalizeProfileVersion((template as any).profileVersion, 1);
  const currentVersion = normalizeProfileVersion(material.officialTemplateVersion, 1);
  if (latestVersion <= currentVersion) return 'already-latest';

  const isOfficialMaterial = material.id.startsWith('material-default-');

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    materialProfiles: state.materialProfiles.map((item) => {
      if (item.id !== materialProfileId) return item;

      if (!isOfficialMaterial) {
        // Preserve custom values; only acknowledge latest baseline version.
        return {
          ...item,
          officialTemplateId: templateId,
          officialTemplateVersion: latestVersion,
        };
      }

      return {
        ...item,
        name: template.name,
        brand: template.brand,
        currencyCode: typeof (template as any).currencyCode === 'string' ? (template as any).currencyCode : item.currencyCode,
        bottlePrice: Number((template as any).bottlePrice) || item.bottlePrice,
        bottleCapacityMl: Number((template as any).bottleCapacityMl) || item.bottleCapacityMl,
        resinFamily: (template.resinFamily ?? item.resinFamily) as MaterialProfile['resinFamily'],
        scaleCompensationPct: {
          x: Number((template as any).scaleCompensationPct?.x) || 0,
          y: Number((template as any).scaleCompensationPct?.y) || 0,
          z: Number((template as any).scaleCompensationPct?.z) || 0,
        },
        layerHeightMm: Number((template as any).layerHeightMm) || item.layerHeightMm,
        normalExposureSec: Number((template as any).normalExposureSec) || item.normalExposureSec,
        bottomExposureSec: Number((template as any).bottomExposureSec) || item.bottomExposureSec,
        bottomLayerCount: Number((template as any).bottomLayerCount) || item.bottomLayerCount,
        liftDistanceMm: Number((template as any).liftDistanceMm) || item.liftDistanceMm,
        liftSpeedMmMin: Number((template as any).liftSpeedMmMin) || item.liftSpeedMmMin,
        retractSpeedMmMin: Number((template as any).retractSpeedMmMin) || item.retractSpeedMmMin,
        minimumAaAlphaPercent: normalizeMinimumAaAlphaPercent(
          (template as any).minimumAaAlphaPercent,
          item.minimumAaAlphaPercent,
        ),
        localSettingsByOutput: sanitizeLocalSettingsByOutput((template as any).localSettingsByOutput)
          ?? item.localSettingsByOutput,
        officialTemplateId: templateId,
        officialTemplateVersion: latestVersion,
      };
    }),
  }));

  return isOfficialMaterial ? 'updated' : 'version-bumped-custom';
}

export function getInstalledPlugins(): InstalledProfilePlugin[] {
  ensureHydrated();
  return getInstalledProfilePlugins();
}

export function installPluginFromManifest(
  manifest: PluginManifest,
  sourceUrl?: string,
  options?: {
    manifestSha256?: string;
    installTrust?: 'allowlisted' | 'unverified-user-approved';
    liabilityAcceptedAt?: string;
  },
): InstalledProfilePlugin {
  ensureHydrated();
  const plugin = installExternalProfilePlugin(manifest, sourceUrl, options);
  notify();
  return plugin;
}

export function uninstallPlugin(pluginId: string): boolean {
  ensureHydrated();
  const removed = uninstallExternalProfilePlugin(pluginId);
  if (removed) notify();
  return removed;
}
