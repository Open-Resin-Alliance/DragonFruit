import type { RaftBottomMode, RaftSettings } from '@/supports/Rafts/Crenelated/RaftTypes';
import type { DragonfruitImportFormat, Trunk } from '@/supports/types';

export type ImportDefaultsSettings = {
  raftBottomMode: RaftBottomMode;
  raftWallEnabled: boolean;
  rootsEnabled: boolean;
  autoRepairScenes: boolean;
};

export const IMPORT_DEFAULTS_STORAGE_KEY = 'import-defaults-v1';

export const DEFAULT_IMPORT_DEFAULTS_SETTINGS: ImportDefaultsSettings = {
  raftBottomMode: 'solid',
  raftWallEnabled: true,
  rootsEnabled: true,
  autoRepairScenes: false,
};

function isRaftBottomMode(value: unknown): value is RaftBottomMode {
  return value === 'off' || value === 'solid' || value === 'line';
}

export function normalizeImportDefaultsSettings(value: unknown): ImportDefaultsSettings {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_IMPORT_DEFAULTS_SETTINGS };
  }

  const raw = value as Partial<ImportDefaultsSettings>;
  const raftBottomMode = isRaftBottomMode(raw.raftBottomMode)
    ? raw.raftBottomMode
    : DEFAULT_IMPORT_DEFAULTS_SETTINGS.raftBottomMode;
  const rootsEnabled = raftBottomMode === 'line'
    ? true
    : (typeof raw.rootsEnabled === 'boolean'
      ? raw.rootsEnabled
      : DEFAULT_IMPORT_DEFAULTS_SETTINGS.rootsEnabled);

  return {
    raftBottomMode,
    raftWallEnabled: typeof raw.raftWallEnabled === 'boolean'
      ? raw.raftWallEnabled
      : DEFAULT_IMPORT_DEFAULTS_SETTINGS.raftWallEnabled,
    rootsEnabled,
    autoRepairScenes: typeof raw.autoRepairScenes === 'boolean'
      ? raw.autoRepairScenes
      : DEFAULT_IMPORT_DEFAULTS_SETTINGS.autoRepairScenes,
  };
}

export function getSavedImportDefaultsSettings(): ImportDefaultsSettings {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_IMPORT_DEFAULTS_SETTINGS };
  }

  try {
    const raw = window.localStorage.getItem(IMPORT_DEFAULTS_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_IMPORT_DEFAULTS_SETTINGS };
    }
    return normalizeImportDefaultsSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_IMPORT_DEFAULTS_SETTINGS };
  }
}

export function saveImportDefaultsSettings(settings: ImportDefaultsSettings): void {
  if (typeof window === 'undefined') return;
  try {
    const normalized = normalizeImportDefaultsSettings(settings);
    window.localStorage.setItem(IMPORT_DEFAULTS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Best effort persistence.
  }
}

function resolveTrunkDiameterMm(trunk: Trunk): number | null {
  if (typeof trunk.baseDiameterMm === 'number' && Number.isFinite(trunk.baseDiameterMm) && trunk.baseDiameterMm > 0) {
    return trunk.baseDiameterMm;
  }

  const firstSegmentDiameter = trunk.segments[0]?.diameter;
  if (typeof firstSegmentDiameter === 'number' && Number.isFinite(firstSegmentDiameter) && firstSegmentDiameter > 0) {
    return firstSegmentDiameter;
  }

  return null;
}

export function applyImportDefaultsToSupportPayload(
  payload: DragonfruitImportFormat,
  defaults: ImportDefaultsSettings,
): DragonfruitImportFormat {
  if (defaults.rootsEnabled || payload.roots.length === 0 || payload.trunks.length === 0) {
    return payload;
  }

  const rootDiameterById = new Map<string, number>();
  for (const trunk of payload.trunks) {
    const diameter = resolveTrunkDiameterMm(trunk);
    if (diameter == null) continue;
    const existing = rootDiameterById.get(trunk.rootId);
    if (existing == null || diameter > existing) {
      rootDiameterById.set(trunk.rootId, diameter);
    }
  }

  if (rootDiameterById.size === 0) {
    return payload;
  }

  let changed = false;
  const nextRoots = payload.roots.map((root) => {
    const trunkDiameter = rootDiameterById.get(root.id);
    if (trunkDiameter == null || root.diameter === trunkDiameter) {
      return root;
    }

    changed = true;
    return {
      ...root,
      diameter: trunkDiameter,
    };
  });

  if (!changed) {
    return payload;
  }

  return {
    ...payload,
    roots: nextRoots,
  };
}

export function getImportDefaultsRaftPatch(settings: ImportDefaultsSettings): Pick<RaftSettings, 'bottomMode' | 'wallEnabled'> {
  const normalized = normalizeImportDefaultsSettings(settings);
  return {
    bottomMode: normalized.raftBottomMode,
    wallEnabled: normalized.raftBottomMode === 'solid' ? normalized.raftWallEnabled : false,
  };
}