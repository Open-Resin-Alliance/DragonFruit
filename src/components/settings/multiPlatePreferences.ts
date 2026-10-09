'use client';

import {
  DEFAULT_FIXED_PLATE_COLUMNS,
  fixedPlateColumns,
  type PlateOrdering,
} from '@/features/scene/plates/plateCascade';

/** Which grid the beds are laid out on: the grown one, or a fixed column count. */
export type PlateOrderingMode = PlateOrdering['mode'];

export type MultiPlateSettings = {
  /**
   * A move that puts a model on another bed makes that bed the one being worked on,
   * and brings the view with it. Off, a drop leaves the active plate alone.
   */
  followLandedPlate: boolean;
  /**
   * `fixed` (the default) holds the width at `fixedPlateColumns` and never re-lays.
   * `dynamic` grows the grid to stay as square as it can, which re-lays the beds
   * already placed whenever a plate is added.
   */
  plateOrdering: PlateOrderingMode;
  /** How many beds a `fixed` grid puts on a row. Read by `fixed` alone. */
  fixedPlateColumns: number;
};

export const MULTI_PLATE_SETTINGS_STORAGE_KEY = 'dragonfruit-multi-plate:settings-v1';
export const MULTI_PLATE_SETTINGS_CHANGE_EVENT = 'dragonfruit://multi-plate-settings-changed';

export const DEFAULT_MULTI_PLATE_SETTINGS: MultiPlateSettings = {
  followLandedPlate: true,
  plateOrdering: 'fixed',
  fixedPlateColumns: DEFAULT_FIXED_PLATE_COLUMNS,
};

/** The layout the settings describe, in the shape the cascade reads. */
export function plateOrderingFor(settings: MultiPlateSettings): PlateOrdering {
  return settings.plateOrdering === 'fixed'
    ? { mode: 'fixed', columns: settings.fixedPlateColumns }
    : { mode: 'dynamic', columns: settings.fixedPlateColumns };
}

let cachedRawSettingsValue: string | null | undefined;
let cachedSettingsSnapshot: MultiPlateSettings = DEFAULT_MULTI_PLATE_SETTINGS;

export function normalizeMultiPlateSettings(
  value: Partial<MultiPlateSettings> | null | undefined,
): MultiPlateSettings {
  return {
    followLandedPlate: value?.followLandedPlate !== false,
    plateOrdering: value?.plateOrdering === 'dynamic' ? 'dynamic' : 'fixed',
    fixedPlateColumns: fixedPlateColumns(
      typeof value?.fixedPlateColumns === 'number' ? value.fixedPlateColumns : DEFAULT_FIXED_PLATE_COLUMNS,
    ),
  };
}

function areMultiPlateSettingsEqual(a: MultiPlateSettings, b: MultiPlateSettings): boolean {
  return a.followLandedPlate === b.followLandedPlate
    && a.plateOrdering === b.plateOrdering
    && a.fixedPlateColumns === b.fixedPlateColumns;
}

function cacheMultiPlateSettings(raw: string | null, next: MultiPlateSettings): MultiPlateSettings {
  cachedRawSettingsValue = raw;
  if (areMultiPlateSettingsEqual(cachedSettingsSnapshot, next)) {
    return cachedSettingsSnapshot;
  }
  cachedSettingsSnapshot = next;
  return cachedSettingsSnapshot;
}

export function getMultiPlateSettingsSnapshot(): MultiPlateSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_MULTI_PLATE_SETTINGS;
  }

  try {
    const raw = window.localStorage.getItem(MULTI_PLATE_SETTINGS_STORAGE_KEY);
    if (raw === cachedRawSettingsValue) {
      return cachedSettingsSnapshot;
    }

    if (!raw) {
      return cacheMultiPlateSettings(raw, DEFAULT_MULTI_PLATE_SETTINGS);
    }

    const parsed = JSON.parse(raw) as Partial<MultiPlateSettings>;
    return cacheMultiPlateSettings(raw, normalizeMultiPlateSettings(parsed));
  } catch {
    return cacheMultiPlateSettings(null, DEFAULT_MULTI_PLATE_SETTINGS);
  }
}

export function getMultiPlateSettingsServerSnapshot(): MultiPlateSettings {
  return DEFAULT_MULTI_PLATE_SETTINGS;
}

export function saveMultiPlateSettings(next: Partial<MultiPlateSettings>): MultiPlateSettings {
  const merged = normalizeMultiPlateSettings({
    ...getMultiPlateSettingsSnapshot(),
    ...next,
  });
  const mergedRaw = JSON.stringify(merged);

  if (typeof window !== 'undefined') {
    try {
      const currentRaw = window.localStorage.getItem(MULTI_PLATE_SETTINGS_STORAGE_KEY);
      cacheMultiPlateSettings(currentRaw, merged);

      if (currentRaw !== mergedRaw) {
        window.localStorage.setItem(MULTI_PLATE_SETTINGS_STORAGE_KEY, mergedRaw);
        cacheMultiPlateSettings(mergedRaw, merged);
        window.dispatchEvent(new CustomEvent(MULTI_PLATE_SETTINGS_CHANGE_EVENT));
      }
    } catch {
      // Ignore localStorage write failures.
    }
  }

  return merged;
}

export function subscribeToMultiPlateSettings(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onSettingsChanged = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === MULTI_PLATE_SETTINGS_STORAGE_KEY) {
      listener();
    }
  };

  window.addEventListener(MULTI_PLATE_SETTINGS_CHANGE_EVENT, onSettingsChanged as EventListener);
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener(MULTI_PLATE_SETTINGS_CHANGE_EVENT, onSettingsChanged as EventListener);
    window.removeEventListener('storage', onStorage);
  };
}
