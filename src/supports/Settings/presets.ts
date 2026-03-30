/**
 * Support Presets
 * 
 * Built-in presets + dynamically created custom presets.
 */

import { SupportPreset, PresetCollection, SupportSettings, createDefaultSettings } from './types';
import { getSettings, setSettings, saveSettingsToLocalStorage } from './state';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';

function normalizePresetSettings(
    settings: Partial<SupportSettings> | undefined,
    fallback: SupportSettings,
): SupportSettings {
    const defaults = createDefaultSettings();
    const source = settings ?? {};

    return {
        ...defaults,
        ...fallback,
        ...source,
        tip: {
            ...defaults.tip,
            ...fallback.tip,
            ...(source.tip ?? {}),
        },
        shaft: {
            ...defaults.shaft,
            ...fallback.shaft,
            ...(source.shaft ?? {}),
        },
        roots: {
            ...defaults.roots,
            ...fallback.roots,
            ...(source.roots ?? {}),
        },
        baseFlare: {
            ...defaults.baseFlare,
            ...fallback.baseFlare,
            ...(source.baseFlare ?? {}),
        },
        joint: {
            ...defaults.joint,
            ...fallback.joint,
            ...(source.joint ?? {}),
        },
        grid: {
            ...defaults.grid,
            ...fallback.grid,
            ...(source.grid ?? {}),
        },
        meshToMesh: {
            ...defaults.meshToMesh,
            ...fallback.meshToMesh,
            ...(source.meshToMesh ?? {}),
        },
        autoBracing: {
            ...defaults.autoBracing,
            ...fallback.autoBracing,
            ...(source.autoBracing ?? {}),
        },
    };
}

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
            maxAngleDeg: 80,
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
        },
        grid: {
            enabled: false,
            spacingMm: 4.0,
            minBranchAngleDeg: 45,
            attachSearchStepMm: 2.0,
            minRoutedTrunkAngleDeg: 60,
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
            maxAngleDeg: 80,
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
        },
        grid: {
            enabled: false,
            spacingMm: 4.0,
            minBranchAngleDeg: 45,
            attachSearchStepMm: 2.0,
            minRoutedTrunkAngleDeg: 60,
        },
        meshToMesh: {
            stickVsTwigCutoffMm: 5.0,
        },
        autoBracing: createDefaultAutoBracingSettings(),
    },
};

// --- Store ---

// --- Store ---

const PRESET_STORAGE_KEY = 'support-presets-v1';
const ACTIVE_PRESET_STORAGE_KEY = 'support-active-preset-id-v1';
const SUPPORT_SETTINGS_STORAGE_KEY = 'support-settings';
const LEGACY_CUSTOM_IDS = new Set(['custom1', 'custom2', 'custom3']);

let presets: PresetCollection = loadPresetsFromStorage();

function loadPresetsFromStorage(): PresetCollection {
    const defaults: PresetCollection = {
        byId: {
            detail: DETAIL_PRESET,
            structure: STRUCTURE_PRESET,
            anchor: ANCHOR_PRESET,
        },
        allIds: ['detail', 'structure', 'anchor'],
        activePresetId: 'structure',
    };

    if (typeof window === 'undefined') return defaults;

    try {
        let resolvedActiveFromStorage = false;
        const stored = localStorage.getItem(PRESET_STORAGE_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);

            // Merge stored presets into defaults (preserves new structure if code updates)
            // But allows stored names/settings to win.
            defaults.allIds.forEach(id => {
                if (parsed.byId && parsed.byId[id]) {
                    const parsedPreset = parsed.byId[id];
                    const fallbackPreset = defaults.byId[id];
                    defaults.byId[id] = {
                        ...fallbackPreset,
                        name: parsedPreset.name || fallbackPreset.name,
                        settings: normalizePresetSettings(
                            parsedPreset.settings,
                            fallbackPreset.settings,
                        ),
                        updatedAt: parsedPreset.updatedAt,
                    };
                }
            });

            // Recover dynamically-created custom presets from storage.
            if (parsed.byId && typeof parsed.byId === 'object') {
                Object.entries(parsed.byId as Record<string, SupportPreset>).forEach(([id, parsedPreset]) => {
                    if (LEGACY_CUSTOM_IDS.has(id)) return;
                    if (!parsedPreset || defaults.byId[id] || parsedPreset.isBuiltIn) return;

                    defaults.byId[id] = {
                        ...parsedPreset,
                        id,
                        name: parsedPreset.name || 'Custom Preset',
                        description: parsedPreset.description || 'User custom preset',
                        icon: parsedPreset.icon || '👤',
                        isBuiltIn: false,
                        settings: normalizePresetSettings(
                            parsedPreset.settings,
                            createDefaultSettings(),
                        ),
                        updatedAt: parsedPreset.updatedAt,
                    };

                    if (!defaults.allIds.includes(id)) {
                        defaults.allIds.push(id);
                    }
                });
            }

            // Restore active ID if valid
            if (parsed.activePresetId && defaults.byId[parsed.activePresetId]) {
                defaults.activePresetId = parsed.activePresetId;
                resolvedActiveFromStorage = true;
            } else {
                const storedActivePresetId = localStorage.getItem(ACTIVE_PRESET_STORAGE_KEY);
                if (storedActivePresetId && defaults.byId[storedActivePresetId]) {
                    defaults.activePresetId = storedActivePresetId;
                    resolvedActiveFromStorage = true;
                }
            }
        }

        // Fallback: infer active preset from persisted settings when explicit active id
        // is missing/invalid (older or stale localStorage cases).
        if (!resolvedActiveFromStorage) {
            const storedSettingsRaw = localStorage.getItem(SUPPORT_SETTINGS_STORAGE_KEY);
            if (storedSettingsRaw) {
                const parsedSettings = JSON.parse(storedSettingsRaw) as Partial<SupportSettings>;
                const normalizedCurrent = normalizePresetSettings(parsedSettings, createDefaultSettings());
                for (const id of defaults.allIds) {
                    const preset = defaults.byId[id];
                    if (!preset) continue;
                    if (doesPresetMatchSettings(preset.settings, normalizedCurrent)) {
                        defaults.activePresetId = id;
                        break;
                    }
                }
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
        if (presets.activePresetId) {
            localStorage.setItem(ACTIVE_PRESET_STORAGE_KEY, presets.activePresetId);
        } else {
            localStorage.removeItem(ACTIVE_PRESET_STORAGE_KEY);
        }
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

function doesPresetMatchSettings(presetSettings: SupportSettings, current: SupportSettings): boolean {
    return (
        current.tip.shape === presetSettings.tip.shape
        && current.tip.contactDiameterMm === presetSettings.tip.contactDiameterMm
        && current.tip.bodyDiameterMm === presetSettings.tip.bodyDiameterMm
        && current.tip.lengthMm === presetSettings.tip.lengthMm
        && current.tip.penetrationMm === presetSettings.tip.penetrationMm
        && (current.tip.breakpointMm ?? 0) === (presetSettings.tip.breakpointMm ?? 0)
        && JSON.stringify(current.shaft) === JSON.stringify(presetSettings.shaft)
        && JSON.stringify(current.roots) === JSON.stringify(presetSettings.roots)
        && JSON.stringify(current.baseFlare) === JSON.stringify(presetSettings.baseFlare)
    );
}

export function isPresetDirtyForSettings(presetId: string | null | undefined, current: SupportSettings): boolean {
    if (!presetId) return false;
    const preset = presets.byId[presetId];
    if (!preset) return false;
    return !doesPresetMatchSettings(preset.settings, current);
}

export function findMatchingPresetIdForSettings(current: SupportSettings): string | null {
    for (const id of presets.allIds) {
        const preset = presets.byId[id];
        if (!preset) continue;
        if (doesPresetMatchSettings(preset.settings, current)) {
            return id;
        }
    }
    return null;
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
        // Keep the current preset selected even when values drift.
        // UX requirement: no "unselected" preset state in the trunk preset dropdown.
        return;
    }
}

export function setActivePreset(id: string | null): void {
    if (id === null) {
        presets.activePresetId = 'structure';
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

    // Keep selected preset + persisted settings in sync across app restarts.
    // Without this, active preset can persist while support-settings storage
    // still holds older values, which produces a false "dirty" state on load.
    saveSettingsToLocalStorage();

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

    const uniqueName = ensureUniqueName(newName, id);

    presets.byId[id] = {
        ...presets.byId[id],
        name: uniqueName,
    };

    savePresetsToStorage();
    notify();
}

export function updateCustomPresetMetadata(id: string, name: string, description: string): void {
    if (!presets.byId[id]) {
        console.warn('[PresetStore] Cannot update preset metadata, preset not found:', id);
        return;
    }

    if (presets.byId[id].isBuiltIn) {
        console.warn('[PresetStore] Cannot update built-in preset metadata:', id);
        return;
    }

    const uniqueName = ensureUniqueName(name, id);
    const sanitizedDescription = sanitizePresetDescription(description);

    presets.byId[id] = {
        ...presets.byId[id],
        name: uniqueName,
        description: sanitizedDescription,
    };

    savePresetsToStorage();
    notify();
}

function sanitizePresetName(name: string): string {
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : 'Custom Preset';
}

function sanitizePresetDescription(description: string): string {
    const trimmed = description.trim();
    return trimmed.length > 0 ? trimmed : 'User custom preset';
}

function ensureUniqueName(desiredName: string, excludeId?: string): string {
    const base = desiredName.trim().length > 0 ? desiredName.trim() : 'Custom Preset';
    let name = base;
    let counter = 1;

    const exists = (candidate: string) => {
        const lower = candidate.toLowerCase();
        return Object.values(presets.byId).some((p) => p.id !== excludeId && p.name.toLowerCase() === lower);
    };

    while (exists(name)) {
        counter += 1;
        name = `${base} (${counter})`;
    }

    return name;
}

function makeCustomPresetId(): string {
    return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function createPreset(name: string): SupportPreset {
    const id = makeCustomPresetId();
    const current = getSettings();

    const sanitized = sanitizePresetName(name);
    const uniqueName = ensureUniqueName(sanitized);

    const preset: SupportPreset = {
        id,
        name: uniqueName,
        description: 'User custom preset',
        icon: '👤',
        isBuiltIn: false,
        settings: normalizePresetSettings(current, createDefaultSettings()),
        updatedAt: Date.now(),
    };

    presets.byId[id] = preset;
    presets.allIds = [...presets.allIds, id];
    presets.activePresetId = id;

    savePresetsToStorage();
    notify();
    return preset;
}

export function deletePreset(id: string): void {
    if (!presets.byId[id]) {
        console.warn('[PresetStore] Cannot delete, preset not found:', id);
        return;
    }

    // Prevent deleting built-in presets
    if (presets.byId[id].isBuiltIn) {
        console.warn('[PresetStore] Cannot delete built-in preset:', id);
        return;
    }

    // Remove from byId and allIds
    delete presets.byId[id];
    presets.allIds = presets.allIds.filter((pid) => pid !== id);

    // If deleted preset was active, fall back to 'structure' if available
    if (presets.activePresetId === id) {
        presets.activePresetId = presets.byId['structure'] ? 'structure' : (presets.allIds[0] ?? null);
    }

    savePresetsToStorage();
    notify();
    console.log('[PresetStore] Deleted preset:', id);
}

// --- Subscription ---

export function subscribeToPresets(listener: PresetListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
