import type { RaftBottomMode, RaftSettings } from '@/supports/Rafts/Crenelated/RaftTypes';
import {
  bundledSupportTypeId,
  getSupportTypeDescriptor,
  INLINE_ROOT_TYPES,
  SUPPORT_TYPES,
} from '@/supports/supportTypeRegistry';
import type { DragonfruitImportFormat } from '@/supports/types';
import { hasWindow } from '@/utils/dom';

export type ImportDefaultsSettings = {
  raftBottomMode: RaftBottomMode;
  raftWallEnabled: boolean;
  rootsEnabled: boolean;
  autoRepair: boolean;
  autoRepairScenes: boolean;
};

export const IMPORT_DEFAULTS_STORAGE_KEY = 'import-defaults-v1';

export const DEFAULT_IMPORT_DEFAULTS_SETTINGS: ImportDefaultsSettings = {
  raftBottomMode: 'solid',
  raftWallEnabled: true,
  rootsEnabled: true,
  autoRepair: false,
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
    autoRepair: typeof raw.autoRepair === 'boolean'
      ? raw.autoRepair
      : DEFAULT_IMPORT_DEFAULTS_SETTINGS.autoRepair,
    autoRepairScenes: typeof raw.autoRepairScenes === 'boolean'
      ? raw.autoRepairScenes
      : DEFAULT_IMPORT_DEFAULTS_SETTINGS.autoRepairScenes,
  };
}

export function getSavedImportDefaultsSettings(): ImportDefaultsSettings {
  if (!hasWindow()) {
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
  if (!hasWindow()) return;
  try {
    const normalized = normalizeImportDefaultsSettings(settings);
    window.localStorage.setItem(IMPORT_DEFAULTS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Best effort persistence.
  }
}

type Shafted = {
  baseDiameterMm?: unknown;
  segments?: { diameter?: unknown }[];
  profile?: { bodyDiameterMm?: unknown };
};

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The diameter a base should take from the entity standing on it: the captured
 * baseline, else the first segment, else the body profile.
 */
function resolveBaseDiameterMm(entity: unknown): number | null {
  const shaft = entity as Shafted;
  return positive(shaft.baseDiameterMm)
    ?? positive(shaft.segments?.[0]?.diameter)
    ?? positive(shaft.profile?.bodyDiameterMm);
}

/** A bundled type writes `{ <singular>, root, hostKnot }`, so the shaft is nested. */
function shaftOf(entry: unknown, typeId: string, bundled: boolean): unknown {
  if (!bundled) return entry;
  return (entry as Record<string, unknown>)[getSupportTypeDescriptor(typeId as never).singular];
}

export function applyImportDefaultsToSupportPayload(
  payload: DragonfruitImportFormat,
  defaults: ImportDefaultsSettings,
): DragonfruitImportFormat {
  const wire = payload as unknown as Record<string, unknown[] | undefined>;
  const bundledId = bundledSupportTypeId();
  // Every type standing on its own base, rather than only the two named here
  // before: a new one would otherwise keep an oversized plate.
  const rootOwners = SUPPORT_TYPES.filter((descriptor) => descriptor.ownsRoot);

  const hasInlineRoots = INLINE_ROOT_TYPES.some((t) => (wire[t.collectionKey]?.length ?? 0) > 0);
  const ownerEntries = rootOwners.flatMap((descriptor) => wire[descriptor.location.key] ?? []);
  if (defaults.rootsEnabled || (payload.roots.length === 0 && !hasInlineRoots && ownerEntries.length === 0)) {
    return payload;
  }

  // Widest shaft wins: one base can carry several entities.
  const rootDiameterById = new Map<string, number>();
  const claim = (rootId: string | undefined, diameter: number | null) => {
    if (!rootId || diameter == null) return;
    const existing = rootDiameterById.get(rootId);
    if (existing == null || diameter > existing) rootDiameterById.set(rootId, diameter);
  };

  for (const descriptor of rootOwners) {
    const bundled = descriptor.id === bundledId;
    for (const entry of wire[descriptor.location.key] ?? []) {
      const shaft = shaftOf(entry, descriptor.id, bundled);
      const rootId = bundled
        ? (entry as { root?: { id?: string } }).root?.id
        : (shaft as { rootId?: string }).rootId;
      claim(rootId, resolveBaseDiameterMm(shaft));
    }
  }

  let changed = false;
  const nextRoots = payload.roots.map((root) => {
    const diameter = rootDiameterById.get(root.id);
    if (diameter == null || root.diameter === diameter) return root;
    changed = true;
    return { ...root, diameter };
  });

  const next = { ...payload, roots: nextRoots } as unknown as Record<string, unknown>;

  for (const descriptor of rootOwners) {
    if (descriptor.id !== bundledId) continue;
    const entries = wire[descriptor.location.key];
    if (!entries) continue;
    next[descriptor.location.key] = entries.map((entry) => {
      const bundle = entry as { root: { id: string; diameter: number } };
      const diameter = rootDiameterById.get(bundle.root.id);
      if (diameter == null || bundle.root.diameter === diameter) return entry;
      changed = true;
      return { ...bundle, root: { ...bundle.root, diameter } };
    });
  }

  // An inline base is geometry on the entity, at the radius field the registry names.
  for (const inline of INLINE_ROOT_TYPES) {
    const entries = wire[inline.collectionKey];
    if (!entries) continue;
    next[inline.collectionKey] = entries.map((entry) => {
      const entity = entry as Record<string, unknown>;
      const diameter = resolveBaseDiameterMm(entity);
      if (diameter == null || entity[inline.radiusField] === diameter) return entry;
      changed = true;
      return { ...entity, [inline.radiusField]: diameter };
    });
  }

  if (!changed) {
    return payload;
  }

  return next as unknown as DragonfruitImportFormat;
}

export function getImportDefaultsRaftPatch(settings: ImportDefaultsSettings): Pick<RaftSettings, 'bottomMode' | 'wallEnabled'> {
  const normalized = normalizeImportDefaultsSettings(settings);
  return {
    bottomMode: normalized.raftBottomMode,
    wallEnabled: normalized.raftBottomMode === 'solid' ? normalized.raftWallEnabled : false,
  };
}
