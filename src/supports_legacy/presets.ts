import { SupportPreset, PresetCollection, SupportSettings } from './types';
import { createDefaultSupportSettings } from './types';

// Built-in preset definitions
const DETAIL_PRESET: SupportPreset = {
  id: 'detail',
  name: 'Detail',
  description: 'Fine supports for delicate features with minimal scarring',
  hotkey: '1',
  icon: '🔬',
  isBuiltIn: true,
  settings: {
    tip: {
      shape: 'cone',
      contactDiameterMm: 0.2,      // Very small contact
      bodyDiameterMm: 0.8,
      lengthMm: 2.0,
      penetrationMm: 0,
      coneAngleDeg: 100,
      breakpointMm: 0,
    },
    mid: {
      shape: 'cylinder',
      diameterMm: 0.8,
      secondaryDiameterMm: 0.8,
      isStraight: true,
    },
    base: {
      shape: 'cylinder',
      diameterMm: 4.0,
      heightMm: 0.3,
      sideAngleDeg: 0,
      neckDiameterMm: 0.8,
      neckHeightMm: 0.4,
      neckBlend: 0.7,
    },
    baseFlare: {
      enabled: true,
      diameterMm: 3.0,
      heightMm: 1.5,
    },
    baseJoint: {
      shape: 'cone',
      contactDiameterMm: 0.8,
      bodyDiameterMm: 0.8,
      lengthMm: 1.8,
      penetrationMm: 0,
      coneAngleDeg: 100,
      allowRotation: true,
    },
    extra: {
      tipContactDiameter2Mm: 0.4,
      tipBodyDiameter2Mm: 0.6,
      baseDiameter2Mm: 5.0,
      baseJointBodyDiameter2Mm: 1.0,
      baseJointContactDiameter2Mm: 0.5,
    },
    adaptiveBase: false,
    isTrunkStraight: true,
    grid: {
      enabled: false,
      spacingMm: 4.0,
    },
    jointDefaults: {
      ballDiameterMm: 1.2,
      maxRotationDeg: 45,
      maxSlideMm: 5,
      defaultJointCount: 1, // Detail preset: 1 joint for fine control
    },
  },
};

const STRUCTURE_PRESET: SupportPreset = {
  id: 'structure',
  name: 'Structure',
  description: 'Balanced supports for general use',
  hotkey: '2',
  icon: '🏗️',
  isBuiltIn: true,
  settings: {
    tip: {
      shape: 'cone',
      contactDiameterMm: 0.3,
      bodyDiameterMm: 1.0,
      lengthMm: 2.5,
      penetrationMm: 0,
      coneAngleDeg: 100,
      breakpointMm: 0,
    },
    mid: {
      shape: 'cylinder',
      diameterMm: 1.0,
      secondaryDiameterMm: 1.0,
      isStraight: true,
    },
    base: {
      shape: 'cylinder',
      diameterMm: 5.0,
      heightMm: 0.3,
      sideAngleDeg: 0,
      neckDiameterMm: 1.0,
      neckHeightMm: 0.5,
      neckBlend: 0.7,
    },
    baseFlare: {
      enabled: true,
      diameterMm: 3.0,
      heightMm: 1.5,
    },
    baseJoint: {
      shape: 'cone',
      contactDiameterMm: 1.0,
      bodyDiameterMm: 1.0,
      lengthMm: 2.0,
      penetrationMm: 0,
      coneAngleDeg: 100,
      allowRotation: true,
    },
    extra: {
      tipContactDiameter2Mm: 0.5,
      tipBodyDiameter2Mm: 0.8,
      baseDiameter2Mm: 6.0,
      baseJointBodyDiameter2Mm: 1.2,
      baseJointContactDiameter2Mm: 0.6,
    },
    adaptiveBase: false,
    isTrunkStraight: true,
    grid: {
      enabled: false,
      spacingMm: 4.0,
    },
    jointDefaults: {
      ballDiameterMm: 1.5,
      maxRotationDeg: 45,
      maxSlideMm: 5,
      defaultJointCount: 1, // Structure preset: 1 joint for balanced support
    },
  },
};

const ANCHOR_PRESET: SupportPreset = {
  id: 'anchor',
  name: 'Anchor',
  description: 'Heavy supports for large overhangs and critical areas',
  hotkey: '3',
  icon: '⚓',
  isBuiltIn: true,
  settings: {
    tip: {
      shape: 'cone',
      contactDiameterMm: 0.4,      // Larger contact
      bodyDiameterMm: 1.5,
      lengthMm: 3.0,
      penetrationMm: 0,
      coneAngleDeg: 100,
      breakpointMm: 0,
    },
    mid: {
      shape: 'cylinder',
      diameterMm: 1.5,
      secondaryDiameterMm: 1.5,
      isStraight: true,
    },
    base: {
      shape: 'cylinder',
      diameterMm: 7.0,             // Larger base
      heightMm: 0.5,
      sideAngleDeg: 0,
      neckDiameterMm: 1.5,
      neckHeightMm: 0.6,
      neckBlend: 0.7,
    },
    baseFlare: {
      enabled: true,
      diameterMm: 3.0,
      heightMm: 1.5,
    },
    baseJoint: {
      shape: 'cone',
      contactDiameterMm: 1.5,
      bodyDiameterMm: 1.5,
      lengthMm: 2.5,
      penetrationMm: 0,
      coneAngleDeg: 100,
      allowRotation: true,
    },
    extra: {
      tipContactDiameter2Mm: 0.6,
      tipBodyDiameter2Mm: 1.2,
      baseDiameter2Mm: 8.0,
      baseJointBodyDiameter2Mm: 1.8,
      baseJointContactDiameter2Mm: 0.8,
    },
    adaptiveBase: false,
    isTrunkStraight: true,
    grid: {
      enabled: false,
      spacingMm: 4.0,
    },
    jointDefaults: {
      ballDiameterMm: 2.0,
      maxRotationDeg: 45,
      maxSlideMm: 5,
      defaultJointCount: 1, // Anchor preset: 1 joint for heavy supports
    },
  },
};

// Preset store
let presets: PresetCollection = {
  byId: {},
  allIds: [],
  activePresetId: 'structure', // Default to Structure
};

type PresetListener = () => void;
const listeners = new Set<PresetListener>();

function notify() {
  listeners.forEach((listener) => {
    try {
      listener();
    } catch (err) {
      console.error('[PresetStore] listener error', err);
    }
  });
}

// Initialize with built-in presets
export function initializePresets(): void {
  const builtIns = [DETAIL_PRESET, STRUCTURE_PRESET, ANCHOR_PRESET];

  presets.byId = {};
  presets.allIds = [];

  builtIns.forEach((preset) => {
    presets.byId[preset.id] = preset;
    presets.allIds.push(preset.id);
  });

  // Try to load custom presets from localStorage
  loadPresetsFromLocalStorage();

  console.log('[PresetStore] Initialized with', presets.allIds.length, 'presets');
}

// Getters
export function getPresetCollection(): PresetCollection {
  return presets;
}

export function getActivePreset(): SupportPreset {
  return presets.byId[presets.activePresetId] || STRUCTURE_PRESET;
}

export function getPresetById(id: string): SupportPreset | undefined {
  return presets.byId[id];
}

export function getPresetList(): SupportPreset[] {
  return presets.allIds.map((id) => presets.byId[id]).filter(Boolean);
}

// Setters
export function setActivePreset(id: string): void {
  if (!presets.byId[id]) {
    console.warn('[PresetStore] Preset not found:', id);
    return;
  }
  presets.activePresetId = id;
  notify();
  console.log('[PresetStore] Active preset:', id);
}

// CRUD operations
export function createPreset(preset: Omit<SupportPreset, 'id' | 'createdAt'>): SupportPreset {
  const id = `custom-${Date.now()}`;
  const newPreset: SupportPreset = {
    ...preset,
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  presets.byId[id] = newPreset;
  presets.allIds.push(id);
  notify();
  savePresetsToLocalStorage();

  console.log('[PresetStore] Created preset:', id);
  return newPreset;
}

export function updatePreset(id: string, updates: Partial<SupportPreset>): void {
  const preset = presets.byId[id];
  if (!preset) {
    console.warn('[PresetStore] Preset not found:', id);
    return;
  }

  if (preset.isBuiltIn) {
    console.warn('[PresetStore] Cannot update built-in preset:', id);
    return;
  }

  presets.byId[id] = {
    ...preset,
    ...updates,
    id, // Preserve ID
    isBuiltIn: preset.isBuiltIn, // Preserve built-in flag
    updatedAt: Date.now(),
  };

  notify();
  savePresetsToLocalStorage();
  console.log('[PresetStore] Updated preset:', id);
}

export function deletePreset(id: string): void {
  const preset = presets.byId[id];
  if (!preset) {
    console.warn('[PresetStore] Preset not found:', id);
    return;
  }

  if (preset.isBuiltIn) {
    console.warn('[PresetStore] Cannot delete built-in preset:', id);
    return;
  }

  delete presets.byId[id];
  presets.allIds = presets.allIds.filter((presetId) => presetId !== id);

  // If deleted preset was active, switch to Structure
  if (presets.activePresetId === id) {
    presets.activePresetId = 'structure';
  }

  notify();
  savePresetsToLocalStorage();
  console.log('[PresetStore] Deleted preset:', id);
}

export function duplicatePreset(id: string, newName: string): SupportPreset {
  const preset = presets.byId[id];
  if (!preset) {
    throw new Error(`Preset not found: ${id}`);
  }

  return createPreset({
    name: newName,
    description: preset.description,
    icon: preset.icon,
    isBuiltIn: false,
    settings: JSON.parse(JSON.stringify(preset.settings)), // Deep copy
  });
}

// Serialization
export interface SerializedPresets {
  version: number;
  customPresets: SupportPreset[];
  activePresetId: string;
}

export function serializePresets(): SerializedPresets {
  // Only serialize custom presets (built-ins are always available)
  const customPresets = presets.allIds
    .map((id) => presets.byId[id])
    .filter((preset) => !preset.isBuiltIn);

  return {
    version: 1,
    customPresets,
    activePresetId: presets.activePresetId,
  };
}

export function deserializePresets(data: SerializedPresets): void {
  if (data.version !== 1) {
    console.warn('[PresetStore] Unknown serialization version:', data.version);
    return;
  }

  // Add custom presets to existing built-ins
  data.customPresets.forEach((preset) => {
    if (!presets.byId[preset.id]) {
      presets.byId[preset.id] = preset;
      presets.allIds.push(preset.id);
    }
  });

  // Restore active preset if it exists
  if (presets.byId[data.activePresetId]) {
    presets.activePresetId = data.activePresetId;
  }

  notify();
}

// localStorage persistence
export function savePresetsToLocalStorage(key: string = 'presets'): void {
  try {
    const serialized = serializePresets();
    localStorage.setItem(key, JSON.stringify(serialized));
    console.log('[PresetStore] Saved to localStorage');
  } catch (err) {
    console.error('[PresetStore] Failed to save to localStorage:', err);
  }
}

export function loadPresetsFromLocalStorage(key: string = 'presets'): boolean {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return false;
    const data = JSON.parse(stored) as SerializedPresets;
    deserializePresets(data);
    console.log('[PresetStore] Loaded from localStorage');
    return true;
  } catch (err) {
    console.error('[PresetStore] Failed to load from localStorage:', err);
    return false;
  }
}

// Export/Import to JSON files
export function exportPresetsToFile(): void {
  try {
    const data = serializePresets();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `presets-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    console.log('[PresetStore] Exported to file');
  } catch (err) {
    console.error('[PresetStore] Failed to export:', err);
  }
}

export function importPresetsFromFile(file: File): Promise<boolean> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const json = e.target?.result as string;
        const data = JSON.parse(json) as SerializedPresets;
        deserializePresets(data);
        savePresetsToLocalStorage(); // Persist imported presets
        console.log('[PresetStore] Imported from file');
        resolve(true);
      } catch (err) {
        console.error('[PresetStore] Failed to import:', err);
        resolve(false);
      }
    };
    reader.onerror = () => {
      console.error('[PresetStore] Failed to read file');
      resolve(false);
    };
    reader.readAsText(file);
  });
}

// Subscription
export function subscribeToPresets(listener: PresetListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// Initialize on module load
if (typeof window !== 'undefined') {
  initializePresets();
}
