/**
 * Support Settings State
 * 
 * Centralized store for current support settings.
 * Uses a simple subscription pattern for React integration.
 */

import { SupportSettings, createDefaultSettings } from './types';
import {
    applyAutoBracingSettingsPatch,
    normalizeAutoBracingSettings,
} from '../autoBracing/settings';

// --- Store ---

let currentSettings: SupportSettings = createDefaultSettings();

function coerceNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function mergeWithDefaults(settings: SupportSettings): SupportSettings {
    const defaults = createDefaultSettings();
    const legacyForceConeAngleEnabled = (settings as any)?.tip?.forceConeAngleEnabled;

    const mergedTip: SupportSettings['tip'] = { ...defaults.tip, ...settings.tip };
    if (mergedTip.coneAngleMode == null && legacyForceConeAngleEnabled === true) {
        mergedTip.coneAngleMode = 'locked';
    }

    const mergedGridRaw: SupportSettings['grid'] = { ...defaults.grid, ...(settings as any).grid };
    const mergedGrid: SupportSettings['grid'] = {
        enabled: coerceBoolean((mergedGridRaw as any).enabled, defaults.grid.enabled),
        spacingMm: coerceNumber((mergedGridRaw as any).spacingMm, defaults.grid.spacingMm),
        minBranchAngleDeg: coerceNumber((mergedGridRaw as any).minBranchAngleDeg, defaults.grid.minBranchAngleDeg),
        attachSearchStepMm: coerceNumber((mergedGridRaw as any).attachSearchStepMm, defaults.grid.attachSearchStepMm),
        minRoutedTrunkAngleDeg: coerceNumber((mergedGridRaw as any).minRoutedTrunkAngleDeg, defaults.grid.minRoutedTrunkAngleDeg),
    };

    const mergedAutoBracing = normalizeAutoBracingSettings({
        ...defaults.autoBracing,
        ...((settings as any).autoBracing ?? {}),
    });

    return {
        ...defaults,
        ...settings,
        tip: mergedTip,
        shaft: {
            ...defaults.shaft,
            ...settings.shaft,
            routingAlgorithm: (settings.shaft?.routingAlgorithm === 'potential') ? 'potential' : 'astar',
        },
        roots: { ...defaults.roots, ...settings.roots },
        baseFlare: { ...defaults.baseFlare, ...settings.baseFlare },
        joint: { ...defaults.joint, ...settings.joint },
        grid: mergedGrid,
        meshToMesh: { ...defaults.meshToMesh, ...(settings as any).meshToMesh },
        autoBracing: mergedAutoBracing,
        devToolsEnabled: settings.devToolsEnabled !== undefined ? settings.devToolsEnabled : defaults.devToolsEnabled,
        devTools: settings.devTools ? { ...defaults.devTools, ...settings.devTools } : defaults.devTools,
    };
}

type SettingsListener = () => void;
const listeners = new Set<SettingsListener>();

function notify() {
    listeners.forEach((listener) => {
        try {
            listener();
        } catch (err) {
            console.error('[SettingsStore] listener error', err);
        }
    });
}

// --- Getters ---

export function getSettings(): SupportSettings {
    return currentSettings;
}

export function getTipProfile() {
    return currentSettings.tip;
}

export function getShaftProfile() {
    return currentSettings.shaft;
}

export function getRootsProfile() {
    return currentSettings.roots;
}

export function getBaseFlareProfile() {
    return currentSettings.baseFlare;
}

export function getJointProfile() {
    return currentSettings.joint;
}

export function getGridSettings() {
    return currentSettings.grid;
}

export function getMeshToMeshSettings() {
    return currentSettings.meshToMesh;
}

export function getAutoBracingSettings() {
    return currentSettings.autoBracing;
}

// --- Setters ---

export function setSettings(settings: SupportSettings): void {
    currentSettings = mergeWithDefaults(settings);
    notify();
}

export function updateTipProfile(tip: Partial<SupportSettings['tip']>): void {
    currentSettings = {
        ...currentSettings,
        tip: { ...currentSettings.tip, ...tip },
    };
    notify();
}

export function updateShaftProfile(shaft: Partial<SupportSettings['shaft']>): void {
    const nextShaft = { ...currentSettings.shaft, ...shaft };
    const nextDiameter = shaft.diameterMm;
    const shouldSyncTipBodyDiameter = typeof nextDiameter === 'number' && Number.isFinite(nextDiameter) && nextDiameter > 0;

    currentSettings = {
        ...currentSettings,
        shaft: nextShaft,
        tip: shouldSyncTipBodyDiameter
            ? {
                ...currentSettings.tip,
                bodyDiameterMm: nextDiameter,
            }
            : currentSettings.tip,
    };
    notify();
}

export function updateRootsProfile(roots: Partial<SupportSettings['roots']>): void {
    currentSettings = {
        ...currentSettings,
        roots: { ...currentSettings.roots, ...roots },
    };
    notify();
}

export function updateBaseFlareProfile(baseFlare: Partial<SupportSettings['baseFlare']>): void {
    currentSettings = {
        ...currentSettings,
        baseFlare: { ...currentSettings.baseFlare, ...baseFlare },
    };
    notify();
}

export function updateJointProfile(joint: Partial<SupportSettings['joint']>): void {
    currentSettings = {
        ...currentSettings,
        joint: { ...currentSettings.joint, ...joint },
    };
    notify();
}

export function updateGridSettings(grid: Partial<SupportSettings['grid']>): void {
    currentSettings = mergeWithDefaults({
        ...currentSettings,
        grid: { ...currentSettings.grid, ...grid },
    });
    notify();
}

export function updateMeshToMeshSettings(meshToMesh: Partial<SupportSettings['meshToMesh']>): void {
    currentSettings = {
        ...currentSettings,
        meshToMesh: { ...currentSettings.meshToMesh, ...meshToMesh },
    };
    notify();
}

export function updateAutoBracingSettings(autoBracing: Partial<SupportSettings['autoBracing']>): void {
    currentSettings = {
        ...currentSettings,
        autoBracing: applyAutoBracingSettingsPatch(currentSettings.autoBracing, autoBracing),
    };
    notify();
}

export function updateDevToolsSettings(devTools: Partial<SupportSettings['devTools']>): void {
    currentSettings = {
        ...currentSettings,
        devTools: { ...currentSettings.devTools, ...devTools },
    };
    notify();
}

export function updateDevToolsEnabled(enabled: boolean): void {
    currentSettings = {
        ...currentSettings,
        devToolsEnabled: enabled,
    };
    notify();
}

// --- Subscription ---

export function subscribeToSettings(listener: SettingsListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

// --- React Hook Helper ---

/**
 * For use with useSyncExternalStore:
 * const settings = useSyncExternalStore(subscribeToSettings, getSettings, getSettings);
 */
export function getSettingsSnapshot(): SupportSettings {
    return currentSettings;
}

// --- Persistence ---

const STORAGE_KEY = 'support-settings';

export function saveSettingsToLocalStorage(): void {
    try {
        // Exclude dev tools settings from saved state to reset on next app startup
        const toSave = {
            ...currentSettings,
            devToolsEnabled: false,
            devTools: createDefaultSettings().devTools,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
        console.log('[SettingsStore] Saved to localStorage (DevTools reset)');
    } catch (err) {
        console.error('[SettingsStore] Failed to save:', err);
    }
}

export function loadSettingsFromLocalStorage(): boolean {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return false;
        const parsed = JSON.parse(stored) as SupportSettings;
        // Force reset dev tools on load
        parsed.devToolsEnabled = false;
        parsed.devTools = createDefaultSettings().devTools;
        currentSettings = mergeWithDefaults(parsed);
        notify();
        console.log('[SettingsStore] Loaded from localStorage (DevTools reset)');
        return true;
    } catch (err) {
        console.error('[SettingsStore] Failed to load:', err);
        return false;
    }
}

// --- Initialize ---

if (typeof window !== 'undefined') {
    loadSettingsFromLocalStorage();
}
