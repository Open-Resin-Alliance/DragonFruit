/**
 * Support Presets
 * 
 * Built-in and custom preset management.
 */

import { SupportPreset, PresetCollection, SupportSettings, createDefaultSettings } from './types';
import { getSettings, setSettings } from './state';

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
    },
};

// --- Store ---

let presets: PresetCollection = {
    byId: {
        detail: DETAIL_PRESET,
        structure: STRUCTURE_PRESET,
        anchor: ANCHOR_PRESET,
    },
    allIds: ['detail', 'structure', 'anchor'],
    activePresetId: 'structure',
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

// --- Getters ---

export function getActivePreset(): SupportPreset {
    return presets.byId[presets.activePresetId] || STRUCTURE_PRESET;
}

export function getPresetList(): SupportPreset[] {
    return presets.allIds.map((id) => presets.byId[id]).filter(Boolean);
}

export function getPresetById(id: string): SupportPreset | undefined {
    return presets.byId[id];
}

// --- Setters ---

export function setActivePreset(id: string): void {
    if (!presets.byId[id]) {
        console.warn('[PresetStore] Preset not found:', id);
        return;
    }
    presets.activePresetId = id;
    
    // Apply preset settings to current settings
    const preset = presets.byId[id];
    const current = getSettings();
    setSettings({
        ...preset.settings,
        grid: {
            ...preset.settings.grid,
            enabled: current.grid.enabled,
        },
    });
    
    notify();
    console.log('[PresetStore] Active preset:', id);
}

// --- Subscription ---

export function subscribeToPresets(listener: PresetListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
