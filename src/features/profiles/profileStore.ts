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

export type PrinterPreset = {
  presetId: string;
  manufacturer: string;
  name: string;
  imageAssetPath?: string;
  networkSupport?: PrinterNetworkSupport;
  buildVolumeMm: {
    width: number;
    depth: number;
    height: number;
  };
  display: {
    resolutionX: number;
    resolutionY: number;
    outputFormat: PrinterOutputFormat;
  };
};

export type PrinterProfile = {
  id: string;
  name: string;
  manufacturer?: string;
  imageDataUrl?: string;
  networkSupport?: PrinterNetworkSupport;
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
  };
  network?: PrinterNetworkSettings;
  networkConnection?: PrinterNetworkConnectionState;
};

function normalizeNetworkSupport(value: unknown): PrinterNetworkSupport | undefined {
  if (value === 'nanodlp') return 'nanodlp';
  return undefined;
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
  networkSupport: normalizeNetworkSupport(preset.networkSupport),
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

        return {
          id: profile.id,
          name: profile.name,
          manufacturer: typeof profile.manufacturer === 'string' ? profile.manufacturer : undefined,
          imageDataUrl: typeof profile.imageDataUrl === 'string' ? profile.imageDataUrl : undefined,
          networkSupport: resolveNetworkSupport(profile),
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
          },
          network: sanitizePrinterNetworkSettings((profile as any).network),
          networkConnection: resolveNetworkSupport(profile)
            ? sanitizePrinterNetworkConnectionState(
              (profile as any).networkConnection,
              resolveNetworkSupport(profile)!,
              sanitizePrinterNetworkSettings((profile as any).network).ipAddress,
            )
            : undefined,
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

function createId(prefix: 'printer' | 'material'): string {
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
    networkSupport,
    officialPresetId: partial?.officialPresetId?.trim(),
    isOfficial: partial?.isOfficial ?? false,
    isCustom: partial?.isCustom ?? true,
    buildVolumeMm: partial?.buildVolumeMm ?? { width: 143, depth: 89, height: 175 },
    display: {
      resolutionX: partial?.display?.resolutionX ?? 2560,
      resolutionY: partial?.display?.resolutionY ?? 1620,
      outputFormat: normalizeOutputFormat(partial?.display?.outputFormat),
    },
    network: networkSettings,
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
    networkSupport: normalizeNetworkSupport(preset.networkSupport),
    officialPresetId: preset.presetId,
    isOfficial: true,
    isCustom: false,
    buildVolumeMm: preset.buildVolumeMm,
    display: {
      resolutionX: preset.display.resolutionX,
      resolutionY: preset.display.resolutionY,
      outputFormat: normalizeOutputFormat(preset.display.outputFormat),
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
      networkSupport: updates.networkSupport !== undefined
        ? normalizeNetworkSupport(updates.networkSupport)
        : profile.networkSupport,
      isOfficial: profile.isOfficial,
      isCustom: profile.isCustom,
      buildVolumeMm: updates.buildVolumeMm ?? profile.buildVolumeMm,
      display: updates.display ?? profile.display,
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

    const networkConnection = profile.networkSupport
      ? {
        ...createDefaultNetworkConnectionState(profile.networkSupport, next.ipAddress),
        lastCheckedAt: profile.networkConnection?.lastCheckedAt ?? '',
      }
      : undefined;

    return {
      ...profile,
      network: next,
      networkConnection,
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
    return {
      ...profile,
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
