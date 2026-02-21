/**
 * Support Presets
 * 
 * Built-in and custom preset management.
 */

import { SupportPreset, PresetCollection, SupportSettings, createDefaultSettings } from './types';
import { getSettings, setSettings } from './state';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';

// --- Built-in Presets ---

const DETAIL_PRESET: SupportPreset = {
    id: 'detail',
    name: 'Detail',
    description: 'Fine supports for delicate features',
    hotkey: '1',
    icon: '🔬',
    isBuiltIn: true,
    settings: {
        tip: {
            shape: 'cone',
            contactDiameterMm: 0.2,
            bodyDiameterMm: 0.8,
            lengthMm: 2.0,
            penetrationMm: 0,
            coneAngleDeg: 100,
            breakpointMm: 0,
        },
        shaft: {
            shape: 'cylinder',
            diameterMm: 0.8,
            secondaryDiameterMm: 0.8,
            isStraight: true,
        },
        roots: {
            shape: 'cylinder',
            diameterMm: 4.0,
            diskHeightMm: 0.3,
            coneHeightMm: 1.2,
            neckDiameterMm: 0.8,
            neckBlend: 0.7,
        },
        baseFlare: {
            enabled: true,
            diameterMm: 2.5,
            heightMm: 1.2,
        },
        joint: {
            ballDiameterMm: 1.2,
            maxRotationDeg: 45,
            maxSlideMm: 5,
            defaultJointCount: 1,
        },
        grid: {
            enabled: false,
            spacingMm: 4.0,
            minBranchAngleDeg: 45,
            attachSearchStepMm: 2.0,
        },
        meshToMesh: {
            stickVsTwigCutoffMm: 5.0,
        },
        autoBracing: createDefaultAutoBracingSettings(),
    },
};

const STRUCTURE_PRESET: SupportPreset = {
    id: 'structure',
    name: 'Structure',
    description: 'Balanced supports for general use',
    hotkey: '2',
    icon: '🏗️',
    isBuiltIn: true,
    settings: createDefaultSettings(),
};

const ANCHOR_PRESET: SupportPreset = {
    id: 'anchor',
    name: 'Anchor',
    description: 'Heavy supports for large overhangs',
    hotkey: '3',
    icon: '⚓',
    isBuiltIn: true,
    settings: {
        tip: {
            shape: 'cone',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.5,
            lengthMm: 3.0,
            penetrationMm: 0,
            coneAngleDeg: 100,
            breakpointMm: 0,
        },
        shaft: {
            shape: 'cylinder',
            diameterMm: 1.5,
            secondaryDiameterMm: 1.5,
            isStraight: true,
        },
        roots: {
            shape: 'cylinder',
            diameterMm: 7.0,
            diskHeightMm: 0.5,
            coneHeightMm: 2.0,
            neckDiameterMm: 1.5,
            neckBlend: 0.7,
        },
        baseFlare: {
            enabled: true,
            diameterMm: 4.0,
            heightMm: 2.0,
        },
        joint: {
            ballDiameterMm: 2.0,
            maxRotationDeg: 45,
            maxSlideMm: 5,
            defaultJointCount: 1,
        },
        grid: {
            enabled: false,
            spacingMm: 4.0,
            minBranchAngleDeg: 45,
            attachSearchStepMm: 2.0,
        },
        meshToMesh: {
            stickVsTwigCutoffMm: 5.0,
        },
        autoBracing: createDefaultAutoBracingSettings(),
    },
};

// --- New Presets ---

const CUSTOM_1_PRESET: SupportPreset = {
    id: 'custom1',
    name: 'Custom 1',
    description: 'User custom preset',
    hotkey: '4',
    icon: '👤',
    isBuiltIn: false,
    settings: createDefaultSettings(),
};

const CUSTOM_2_PRESET: SupportPreset = {
    id: 'custom2',
    name: 'Custom 2',
    description: 'User custom preset',
    hotkey: '5',
    icon: '👤',
    isBuiltIn: false,
    settings: createDefaultSettings(),
};

const CUSTOM_3_PRESET: SupportPreset = {
    id: 'custom3',
    name: 'Custom 3',
    description: 'User custom preset',
    hotkey: '6',
    icon: '👤',
    isBuiltIn: false,
    settings: createDefaultSettings(),
};

// --- Store ---

// --- Store ---

const PRESET_STORAGE_KEY = 'support-presets-v1';

let presets: PresetCollection = loadPresetsFromStorage();

function loadPresetsFromStorage(): PresetCollection {
    const defaults: PresetCollection = {
        byId: {
            detail: DETAIL_PRESET,
            structure: STRUCTURE_PRESET,
            anchor: ANCHOR_PRESET,
            custom1: CUSTOM_1_PRESET,
            custom2: CUSTOM_2_PRESET,
            custom3: CUSTOM_3_PRESET,
        },
        allIds: ['detail', 'custom1', 'structure', 'custom2', 'anchor', 'custom3'],
        activePresetId: 'structure',
    };

    if (typeof window === 'undefined') return defaults;

    try {
        const stored = localStorage.getItem(PRESET_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);

            // Merge stored presets into defaults (preserves new structure if code updates)
            // But allows stored names/settings to win.
            defaults.allIds.forEach(id => {
                if (parsed.byId && parsed.byId[id]) {
                    defaults.byId[id] = {
                        ...defaults.byId[id],
                        name: parsed.byId[id].name || defaults.byId[id].name,
                        settings: {
                            ...defaults.byId[id].settings,
                            ...parsed.byId[id].settings,
                        },
                        updatedAt: parsed.byId[id].updatedAt,
                    };
                }
            });

            // Restore active ID if valid
            if (parsed.activePresetId && defaults.byId[parsed.activePresetId]) {
                defaults.activePresetId = parsed.activePresetId;
            }
        }
    } catch (err) {
        console.error('[PresetStore] Failed to load presets:', err);
    }

    return defaults;
}

function savePresetsToStorage() {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
    } catch (err) {
        console.error('[PresetStore] Failed to save presets:', err);
    }
}

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

// --- Getters ---

export function getActivePreset(): SupportPreset | null {
    if (!presets.activePresetId) return null;
    return presets.byId[presets.activePresetId] || null;
}

export function getPresetList(): SupportPreset[] {
    return presets.allIds.map((id) => presets.byId[id]).filter(Boolean);
}

export function getPresetById(id: string): SupportPreset | undefined {
    return presets.byId[id];
}

// --- Setters ---

// Fields to EXCLUDE from being overwritten by a preset application
// and EXCLUDE from being saved into a preset from current settings.
// - Grid: User wants this independent.
// - Cone Control Angle: User wants this independent.
// - (Raft is managed separately, so not an issue here)

export function checkPresetDrift(current: SupportSettings): void {
    const activeId = presets.activePresetId;
    if (!activeId || !presets.byId[activeId]) return; // No preset active

    const presetSettings = presets.byId[activeId].settings;

    // Deep compare ESSENTIAL fields only.
    // Exclude: grid, tip.coneAngleMode, tip.adaptiveConeAngleOffsetDeg, tip.coneAngleDeg
    // (And raft is separate)

    const isDifferent =
        // Tip (excluding cone angles)
        current.tip.shape !== presetSettings.tip.shape ||
        current.tip.contactDiameterMm !== presetSettings.tip.contactDiameterMm ||
        current.tip.bodyDiameterMm !== presetSettings.tip.bodyDiameterMm ||
        current.tip.lengthMm !== presetSettings.tip.lengthMm ||
        current.tip.penetrationMm !== presetSettings.tip.penetrationMm ||
        current.tip.breakpointMm !== presetSettings.tip.breakpointMm ||
        // Shaft
        JSON.stringify(current.shaft) !== JSON.stringify(presetSettings.shaft) ||
        // Roots
        JSON.stringify(current.roots) !== JSON.stringify(presetSettings.roots) ||
        // Base Flare
        JSON.stringify(current.baseFlare) !== JSON.stringify(presetSettings.baseFlare) ||
        // Joint
        JSON.stringify(current.joint) !== JSON.stringify(presetSettings.joint) ||
        // Mesh to Mesh
        JSON.stringify(current.meshToMesh) !== JSON.stringify(presetSettings.meshToMesh);

    if (isDifferent) {
        console.log('[PresetStore] Drift detected, deselecting preset.');
        presets.activePresetId = null;
        savePresetsToStorage(); // Persist the "no selection" state
        notify();
    }
}

export function setActivePreset(id: string | null): void {
    if (id === null) {
        presets.activePresetId = null;
        savePresetsToStorage();
        notify();
        return;
    }

    if (!presets.byId[id]) {
        console.warn('[PresetStore] Preset not found:', id);
        return;
    }
    presets.activePresetId = id;

    // Apply preset settings to current settings
    // BUT preserve specific "excluded" fields from the CURRENT settings
    const preset = presets.byId[id];
    const current = getSettings();

    setSettings({
        ...preset.settings,
        // Preserve current Grid settings
        grid: {
            ...current.grid, // Use current, ignore preset
        },
        // Preserve current Cone Control Angle settings (Tip)
        tip: {
            ...preset.settings.tip,
            coneAngleMode: current.tip.coneAngleMode,
            adaptiveConeAngleOffsetDeg: current.tip.adaptiveConeAngleOffsetDeg,
            coneAngleDeg: current.tip.coneAngleDeg,
        },
        // Preserve current Auto Bracing settings
        autoBracing: {
            ...current.autoBracing,
        },
    });

    savePresetsToStorage();
    notify();
    console.log('[PresetStore] Active preset:', id);
}

export function savePreset(id: string): void {
    if (!presets.byId[id]) {
        console.warn('[PresetStore] Cannot save, preset not found:', id);
        return;
    }

    const current = getSettings();
    const existingPreset = presets.byId[id];

    // Create new settings object from current
    // BUT restore the "excluded" fields from the EXISTING preset (or defaults)
    // so that saving current settings doesn't pollute the preset with grid/cone values.
    const newSettings: SupportSettings = {
        ...current,
        grid: {
            ...existingPreset.settings.grid, // Keep what was in the preset
        },
        tip: {
            ...current.tip,
            // Restore cone angle settings from existing preset to avoid saving current ones
            coneAngleMode: existingPreset.settings.tip.coneAngleMode,
            adaptiveConeAngleOffsetDeg: existingPreset.settings.tip.adaptiveConeAngleOffsetDeg,
            coneAngleDeg: existingPreset.settings.tip.coneAngleDeg,
        },
        autoBracing: {
            ...existingPreset.settings.autoBracing,
        },
    };

    presets.byId[id] = {
        ...existingPreset,
        settings: newSettings,
        updatedAt: Date.now(),
    };

    savePresetsToStorage();
    notify();
    console.log('[PresetStore] Saved settings to preset:', id);
}

export function renamePreset(id: string, newName: string): void {
    if (!presets.byId[id]) {
        console.warn('[PresetStore] Cannot rename, preset not found:', id);
        return;
    }

    presets.byId[id] = {
        ...presets.byId[id],
        name: newName,
    };

    savePresetsToStorage();
    notify();
}

// --- Subscription ---

export function subscribeToPresets(listener: PresetListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
