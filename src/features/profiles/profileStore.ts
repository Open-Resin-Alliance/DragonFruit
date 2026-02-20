import printerPresetsData from '../../../assets/profiles/printers.json';
import materialTemplatesData from '../../../assets/profiles/materials.json';

export type PrinterOutputFormat = '.nanodlp' | '.goo' | '.lumen';

export type PrinterPreset = {
  presetId: string;
  manufacturer: string;
  name: string;
  imageAssetPath?: string;
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
};

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

const STORAGE_KEY = 'dragonfruit-profiles-v1';

const DEFAULT_OUTPUT_FORMAT: PrinterOutputFormat = '.goo';

const PRINTER_PRESETS: PrinterPreset[] = (printerPresetsData as PrinterPreset[]).map((preset) => ({
  ...preset,
  display: {
    ...preset.display,
    outputFormat: normalizeOutputFormat(preset.display?.outputFormat),
  },
}));

const MATERIAL_TEMPLATES = materialTemplatesData as Array<Omit<MaterialProfile, 'id' | 'printerProfileId'>>;

const DEFAULT_PRINTER_PROFILES: PrinterProfile[] = PRINTER_PRESETS.map((preset) => ({
  id: `printer-default-${preset.presetId}`,
  name: preset.name,
  manufacturer: preset.manufacturer,
  imageDataUrl: preset.imageAssetPath,
  officialPresetId: preset.presetId,
  isOfficial: true,
  isCustom: false,
  buildVolumeMm: preset.buildVolumeMm,
  display: preset.display,
}));

function resolveOfficialPresetId(profile: Partial<PrinterProfile>): string | undefined {
  if (typeof (profile as any).officialPresetId === 'string') {
    return ((profile as any).officialPresetId as string).trim() || undefined;
  }

  const name = typeof profile.name === 'string' ? profile.name.trim().toLowerCase() : '';
  const manufacturer = typeof profile.manufacturer === 'string' ? profile.manufacturer.trim().toLowerCase() : '';
  if (!name || !manufacturer) return undefined;

  const matchedPreset = PRINTER_PRESETS.find((preset) => (
    preset.name.trim().toLowerCase() === name
    && preset.manufacturer.trim().toLowerCase() === manufacturer
  ));

  return matchedPreset?.presetId;
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

  return MATERIAL_TEMPLATES.map((template) => ({
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
        if (
          !profile
          || typeof profile.id !== 'string'
          || typeof profile.name !== 'string'
          || !profile.buildVolumeMm
          || !profile.display
        ) {
          return null;
        }

        return {
          id: profile.id,
          name: profile.name,
          manufacturer: typeof profile.manufacturer === 'string' ? profile.manufacturer : undefined,
          imageDataUrl: typeof profile.imageDataUrl === 'string' ? profile.imageDataUrl : undefined,
          officialPresetId: resolveOfficialPresetId(profile),
          isOfficial: isOfficialProfileByHeuristic(profile),
          isCustom: typeof profile.isCustom === 'boolean' ? profile.isCustom : !isOfficialProfileByHeuristic(profile),
          buildVolumeMm: {
            width: Number((profile as any).buildVolumeMm?.width) || 143,
            depth: Number((profile as any).buildVolumeMm?.depth) || 89,
            height: Number((profile as any).buildVolumeMm?.height) || 175,
          },
          display: {
            resolutionX: Number((profile as any).display?.resolutionX) || 2560,
            resolutionY: Number((profile as any).display?.resolutionY) || 1620,
            outputFormat: normalizeOutputFormat((profile as any).display?.outputFormat),
          },
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
        if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string' || typeof profile.layerHeightMm !== 'number') {
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
          layerHeightMm: Number(profile.layerHeightMm) || 0.05,
          normalExposureSec: Number(profile.normalExposureSec) || 2.5,
          bottomExposureSec: Number(profile.bottomExposureSec) || 28,
          bottomLayerCount: Number(profile.bottomLayerCount) || 5,
          liftDistanceMm: Number(profile.liftDistanceMm) || 6,
          liftSpeedMmMin: Number(profile.liftSpeedMmMin) || 60,
          retractSpeedMmMin: Number(profile.retractSpeedMmMin) || 150,
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    console.error('[ProfileStore] Failed to persist profile state', error);
  }
}

export function hydrateProfilesFromStorage(): void {
  if (typeof window === 'undefined') return;
  if (isHydrated) return;

  isHydrated = true;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      persist(state);
      return;
    }
    const parsed = JSON.parse(raw) as Partial<ProfileStoreState>;
    state = sanitizeState(parsed);
    notify();
  } catch (error) {
    console.error('[ProfileStore] Failed to hydrate profile state', error);
    state = createDefaultState();
    persist(state);
    notify();
  }
}

export function subscribeToProfileStore(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getProfileStoreSnapshot(): ProfileStoreState {
  return state;
}

function setState(next: ProfileStoreState): void {
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
  if (!state.printerProfiles.some((profile) => profile.id === id)) return;
  if (state.activePrinterProfileId === id) return;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    activePrinterProfileId: id,
  }));
}

export function setActiveMaterialProfile(id: string): void {
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
  const profile: PrinterProfile = {
    id: createId('printer'),
    name: partial?.name?.trim() || `Printer ${state.printerProfiles.length + 1}`,
    manufacturer: partial?.manufacturer?.trim() || 'Generic',
    imageDataUrl: partial?.imageDataUrl,
    officialPresetId: partial?.officialPresetId?.trim(),
    isOfficial: partial?.isOfficial ?? false,
    isCustom: partial?.isCustom ?? true,
    buildVolumeMm: partial?.buildVolumeMm ?? { width: 143, depth: 89, height: 175 },
    display: {
      resolutionX: partial?.display?.resolutionX ?? 2560,
      resolutionY: partial?.display?.resolutionY ?? 1620,
      outputFormat: normalizeOutputFormat(partial?.display?.outputFormat),
    },
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
  return PRINTER_PRESETS;
}

export function addPrinterProfileFromPreset(presetId: string): string {
  const preset = PRINTER_PRESETS.find((item) => item.presetId === presetId);
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
      isOfficial: profile.isOfficial,
      isCustom: profile.isCustom,
      buildVolumeMm: updates.buildVolumeMm ?? profile.buildVolumeMm,
      display: updates.display ?? profile.display,
    };
  });

  if (!changed) return;

  setState(ensureActiveMaterialForActivePrinter({
    ...state,
    printerProfiles,
  }));
}

export function updateMaterialProfile(id: string, updates: Partial<Omit<MaterialProfile, 'id'>>): void {
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
