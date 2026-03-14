import printerPresetsData from '../../../profiles/printers';
import materialTemplatesData from '../../../profiles/materials';
import {
  getInstalledProfilePlugins,
  getRuntimeMaterialTemplates,
  getRuntimePrinterPresets,
  hydratePluginRegistry,
  installExternalProfilePlugin,
  uninstallExternalProfilePlugin,
  type InstalledProfilePlugin,
  type PluginManifest,
} from '@/features/plugins/pluginRegistry';

export type PrinterOutputFormat = '.nanodlp' | '.goo' | '.lumen';
export type PrinterNetworkSupport = 'nanodlp';

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

export type PrinterPreset = {
  presetId: string;
  manufacturer: string;
  name: string;
  family?: string;
  imageAssetPath?: string;
  antiAliasing?: boolean;
  networkSupport?: PrinterNetworkSupport;
  networkFilter?: string;
  platformBadge?: PrinterPlatformBadge;
  pixelSize?: PrinterPixelSize;
  bitDepth?: PrinterBitDepth;
  buildVolumeMm: {
    width: number;
    depth: number;
    height: number;
  };
  display: {
    resolutionX: number;
    resolutionY: number;
    outputFormat: PrinterOutputFormat;
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
  networkFilter?: string;
  platformBadge?: PrinterPlatformBadge;
  pixelSize?: PrinterPixelSize;
  bitDepth?: PrinterBitDepth;
  officialPresetId?: string;
  isOfficial?: boolean;
  isCustom?: boolean;
  buildVolumeMm: {
    width: number;
    depth: number;
    height: number;
  };
  display: {
    resolutionX: number;
    resolutionY: number;
    outputFormat: PrinterOutputFormat;
    mirrorX?: boolean;
    mirrorY?: boolean;
  };
  network?: PrinterNetworkSettings;
  networkFleet?: PrinterNetworkDevice[];
  activeNetworkDeviceId?: string;
  networkConnection?: PrinterNetworkConnectionState;
};

function normalizeNetworkSupport(value: unknown): PrinterNetworkSupport | undefined {
  if (value === 'nanodlp') return 'nanodlp';
  return undefined;
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

export type MaterialProfile = {
  id: string;
  printerProfileId: string;
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
};

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
const PROFILE_STORE_SCHEMA_VERSION = 2;

const DEFAULT_OUTPUT_FORMAT: PrinterOutputFormat = '.goo';

const DEFAULT_PRINTER_NETWORK_SETTINGS: PrinterNetworkSettings = {
  discoveryEnabled: true,
  ipAddress: '',
};

function normalizeAntiAliasingSupport(value: unknown): boolean | undefined {
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
    mirrorX: normalizeMirrorFlag((preset.display as { mirrorX?: unknown } | undefined)?.mirrorX, false),
    mirrorY: normalizeMirrorFlag((preset.display as { mirrorY?: unknown } | undefined)?.mirrorY, false),
  },
}));

const BUILTIN_MATERIAL_TEMPLATES = materialTemplatesData as Array<Omit<MaterialProfile, 'id' | 'printerProfileId'>>;

function getAllPrinterPresets(): PrinterPreset[] {
  return getRuntimePrinterPresets(BUILTIN_PRINTER_PRESETS);
}

function getAllMaterialTemplates(): Array<Omit<MaterialProfile, 'id' | 'printerProfileId'>> {
  return getRuntimeMaterialTemplates(BUILTIN_MATERIAL_TEMPLATES);
}

const DEFAULT_PRINTER_PROFILES: PrinterProfile[] = BUILTIN_PRINTER_PRESETS.map((preset) => ({
  id: `printer-default-${preset.presetId}`,
  name: preset.name,
  manufacturer: preset.manufacturer,
  imageDataUrl: preset.imageAssetPath,
  antiAliasing: normalizeAntiAliasingSupport((preset as any).antiAliasing),
  networkSupport: normalizeNetworkSupport(preset.networkSupport),
  networkFilter: sanitizeNetworkFilter((preset as any).networkFilter),
  platformBadge: sanitizePlatformBadge((preset as any).platformBadge),
  pixelSize: sanitizePixelSize((preset as any).pixelSize),
  bitDepth: sanitizeBitDepth((preset as any).bitDepth),
  officialPresetId: preset.presetId,
  isOfficial: true,
  isCustom: false,
  buildVolumeMm: preset.buildVolumeMm,
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

function normalizeOutputFormat(value: unknown): PrinterOutputFormat {
  if (value === '.nanodlp' || value === '.goo' || value === '.lumen') return value;
  if (value === '.luman') return '.lumen';
  return DEFAULT_OUTPUT_FORMAT;
}

function normalizeMirrorFlag(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function createDefaultMaterials(printerProfiles: PrinterProfile[]): MaterialProfile[] {
  const primaryPrinterId = printerProfiles[0]?.id;
  if (!primaryPrinterId) return [];

  return getAllMaterialTemplates().map((template) => ({
    ...template,
    currencyCode: typeof (template as any).currencyCode === 'string' ? (template as any).currencyCode : 'USD',
    id: `material-default-${template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    printerProfileId: primaryPrinterId,
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
          networkFilter: sanitizeNetworkFilter((profile as any).networkFilter) ?? sanitizeNetworkFilter((matchedPreset as any)?.networkFilter),
          platformBadge: sanitizePlatformBadge((profile as any).platformBadge) ?? sanitizePlatformBadge((matchedPreset as any)?.platformBadge),
          pixelSize: sanitizePixelSize((profile as any).pixelSize) ?? sanitizePixelSize((matchedPreset as any)?.pixelSize),
          bitDepth: sanitizeBitDepth((profile as any).bitDepth) ?? sanitizeBitDepth((matchedPreset as any)?.bitDepth),
          officialPresetId,
          isOfficial: isOfficialProfileByHeuristic(profile),
          isCustom: typeof profile.isCustom === 'boolean' ? profile.isCustom : !isOfficialProfileByHeuristic(profile),
          buildVolumeMm: {
            width: Number(rawBuildVolume?.width) || fallbackBuildVolume?.width || 143,
            depth: Number(rawBuildVolume?.depth) || fallbackBuildVolume?.depth || 89,
            height: Number(rawBuildVolume?.height) || fallbackBuildVolume?.height || 175,
          },
          display: {
            resolutionX: Number(rawDisplay?.resolutionX) || fallbackDisplay?.resolutionX || 2560,
            resolutionY: Number(rawDisplay?.resolutionY) || fallbackDisplay?.resolutionY || 1620,
            outputFormat: normalizeOutputFormat(rawDisplay?.outputFormat ?? fallbackDisplay?.outputFormat),
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

        const rawPrinterId = (profile as any).printerProfileId;
        const printerProfileId =
          typeof rawPrinterId === 'string' && printerProfiles.some((printer) => printer.id === rawPrinterId)
            ? rawPrinterId
            : fallbackPrinterId;

        return {
          id: profile.id,
          printerProfileId,
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
    networkFilter: sanitizeNetworkFilter(partial?.networkFilter),
    platformBadge: sanitizePlatformBadge(partial?.platformBadge),
    pixelSize: sanitizePixelSize(partial?.pixelSize),
    bitDepth: sanitizeBitDepth(partial?.bitDepth),
    officialPresetId: partial?.officialPresetId?.trim(),
    isOfficial: partial?.isOfficial ?? false,
    isCustom: partial?.isCustom ?? true,
    buildVolumeMm: partial?.buildVolumeMm ?? { width: 143, depth: 89, height: 175 },
    display: {
      resolutionX: partial?.display?.resolutionX ?? 2560,
      resolutionY: partial?.display?.resolutionY ?? 1620,
      outputFormat: normalizeOutputFormat(partial?.display?.outputFormat),
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
    networkFilter: sanitizeNetworkFilter((preset as any).networkFilter),
    platformBadge: sanitizePlatformBadge((preset as any).platformBadge),
    pixelSize: sanitizePixelSize((preset as any).pixelSize),
    bitDepth: sanitizeBitDepth((preset as any).bitDepth),
    officialPresetId: preset.presetId,
    isOfficial: true,
    isCustom: false,
    buildVolumeMm: preset.buildVolumeMm,
    display: {
      resolutionX: preset.display.resolutionX,
      resolutionY: preset.display.resolutionY,
      outputFormat: normalizeOutputFormat(preset.display.outputFormat),
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

  const printerProfiles = state.printerProfiles.map((profile) => {
    if (profile.id !== id) return profile;
    if (profile.isOfficial) return profile;
    changed = true;
    return {
      ...profile,
      ...updates,
      name: updates.name !== undefined ? updates.name : profile.name,
      manufacturer: updates.manufacturer !== undefined ? updates.manufacturer : profile.manufacturer,
      antiAliasing: updates.antiAliasing !== undefined
        ? normalizeAntiAliasingSupport(updates.antiAliasing)
        : profile.antiAliasing,
      networkSupport: updates.networkSupport !== undefined
        ? normalizeNetworkSupport(updates.networkSupport)
        : profile.networkSupport,
      networkFilter: updates.networkFilter !== undefined
        ? sanitizeNetworkFilter(updates.networkFilter)
        : profile.networkFilter,
      platformBadge: updates.platformBadge !== undefined
        ? sanitizePlatformBadge(updates.platformBadge)
        : profile.platformBadge,
      pixelSize: updates.pixelSize !== undefined
        ? sanitizePixelSize(updates.pixelSize)
        : profile.pixelSize,
      bitDepth: updates.bitDepth !== undefined
        ? sanitizeBitDepth(updates.bitDepth)
        : profile.bitDepth,
      isOfficial: profile.isOfficial,
      isCustom: profile.isCustom,
      buildVolumeMm: updates.buildVolumeMm ?? profile.buildVolumeMm,
      display: updates.display
        ? {
          resolutionX: Number(updates.display.resolutionX) || profile.display.resolutionX,
          resolutionY: Number(updates.display.resolutionY) || profile.display.resolutionY,
          outputFormat: normalizeOutputFormat(updates.display.outputFormat ?? profile.display.outputFormat),
          mirrorX: normalizeMirrorFlag(updates.display.mirrorX, profile.display.mirrorX === true),
          mirrorY: normalizeMirrorFlag(updates.display.mirrorY, profile.display.mirrorY === true),
        }
        : profile.display,
      network: updates.network !== undefined ? sanitizePrinterNetworkSettings(updates.network) : profile.network,
      networkConnection: updates.networkConnection !== undefined
        ? (
          (updates.networkSupport !== undefined
            ? normalizeNetworkSupport(updates.networkSupport)
            : profile.networkSupport)
            ? sanitizePrinterNetworkConnectionState(
              updates.networkConnection,
              (updates.networkSupport !== undefined
                ? normalizeNetworkSupport(updates.networkSupport)
                : profile.networkSupport)!,
              sanitizePrinterNetworkSettings(updates.network ?? profile.network).ipAddress,
            )
            : undefined
        )
        : profile.networkConnection,
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
      fleet[activeIndex] = {
        ...fleet[activeIndex],
        ...next,
        displayName: fleet[activeIndex].displayName || next.hostName || next.ipAddress || 'Printer',
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
    changed = true;
    return {
      ...profile,
      ...updates,
      printerProfileId: profile.printerProfileId,
      brand: updates.brand !== undefined ? updates.brand : profile.brand,
      currencyCode: updates.currencyCode !== undefined ? updates.currencyCode.toUpperCase() : profile.currencyCode,
      name: updates.name !== undefined ? updates.name : profile.name,
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
    }))
    : [
      {
        id: createId('material'),
        printerProfileId: duplicateId,
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

  const nextDevice: PrinterNetworkDevice = {
    id: existing.id,
    displayName: typeof deviceInput.displayName === 'string' && deviceInput.displayName.trim().length > 0
      ? deviceInput.displayName.trim()
      : existing.displayName || nextConnection.hostName || nextConnection.ipAddress || 'Printer',
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
  return (
    snapshot.printerProfiles.find((profile) => profile.id === snapshot.activePrinterProfileId)
    ?? snapshot.printerProfiles[0]
    ?? null
  );
}

export function getActiveMaterialProfile(stateOverride?: ProfileStoreState): MaterialProfile | null {
  const snapshot = stateOverride ?? state;
  const activePrinterId = snapshot.activePrinterProfileId;

  return (
    snapshot.materialProfiles.find(
      (profile) => profile.id === snapshot.activeMaterialProfileId && profile.printerProfileId === activePrinterId,
    )
    ?? snapshot.materialProfiles.find((profile) => profile.printerProfileId === activePrinterId)
    ?? snapshot.materialProfiles[0]
    ?? null
  );
}

export function getMaterialProfilesForPrinter(printerProfileId: string, stateOverride?: ProfileStoreState): MaterialProfile[] {
  const snapshot = stateOverride ?? state;
  return snapshot.materialProfiles.filter((profile) => profile.printerProfileId === printerProfileId);
}

export function getInstalledPlugins(): InstalledProfilePlugin[] {
  ensureHydrated();
  return getInstalledProfilePlugins();
}

export function installPluginFromManifest(manifest: PluginManifest, sourceUrl?: string): InstalledProfilePlugin {
  ensureHydrated();
  const plugin = installExternalProfilePlugin(manifest, sourceUrl);
  notify();
  return plugin;
}

export function uninstallPlugin(pluginId: string): boolean {
  ensureHydrated();
  const removed = uninstallExternalProfilePlugin(pluginId);
  if (removed) notify();
  return removed;
}
