/**
 * Support Settings State
 * 
 * Centralized store for current support settings.
 * Uses a simple subscription pattern for React integration.
 */

import { SupportSettings, createDefaultSettings } from './types';
import {
    DEFAULT_ROOTS_CONE_HEIGHT_MM,
    DEFAULT_ROOTS_DIAMETER_MM,
    DEFAULT_ROOTS_DISK_HEIGHT_MM,
    DEFAULT_SHAFT_DIAMETER_MM,
    DEFAULT_TIP_CONTACT_DIAMETER_MM,
    DEFAULT_TIP_LENGTH_MM,
    SUPPORT_PROFILE_LIMITS,
} from './defaults';
import {
    applyAutoBracingSettingsPatch,
    normalizeAutoBracingSettings,
} from '../autoBracing/settings';
import {
    applyAutoSupportSettingsPatch,
    normalizeAutoSupportSettings,
} from '../autoSupport/settings';

// --- Store ---

let currentSettings: SupportSettings = createDefaultSettings();

function coerceNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

/** Clamp a field to its `SUPPORT_PROFILE_LIMITS` range; non-finite falls back. */
function clampToRange(value: unknown, fallback: number, range: { min: number; max: number }): number {
    return Math.min(range.max, Math.max(range.min, coerceNumber(value, fallback)));
}

/**
 * Apply the General tab's field limits to a profile set. Runs on every write —
 * including presets, imported scenes and plugin calls — so no path can hand a
 * negative diameter or length to the geometry builders.
 */
function clampProfileFields(settings: SupportSettings): SupportSettings {
    return {
        ...settings,
        tip: {
            ...settings.tip,
            contactDiameterMm: clampToRange(settings.tip.contactDiameterMm, DEFAULT_TIP_CONTACT_DIAMETER_MM, SUPPORT_PROFILE_LIMITS.tip.contactDiameterMm),
            lengthMm: clampToRange(settings.tip.lengthMm, DEFAULT_TIP_LENGTH_MM, SUPPORT_PROFILE_LIMITS.tip.lengthMm),
            // 30 mirrors the fallback the General tab uses when the offset is unset.
            adaptiveConeAngleOffsetDeg: clampToRange(settings.tip.adaptiveConeAngleOffsetDeg, 30, SUPPORT_PROFILE_LIMITS.tip.adaptiveConeAngleOffsetDeg),
        },
        shaft: {
            ...settings.shaft,
            diameterMm: clampToRange(settings.shaft.diameterMm, DEFAULT_SHAFT_DIAMETER_MM, SUPPORT_PROFILE_LIMITS.shaft.diameterMm),
        },
        roots: {
            ...settings.roots,
            diameterMm: clampToRange(settings.roots.diameterMm, DEFAULT_ROOTS_DIAMETER_MM, SUPPORT_PROFILE_LIMITS.roots.diameterMm),
            diskHeightMm: clampToRange(settings.roots.diskHeightMm, DEFAULT_ROOTS_DISK_HEIGHT_MM, SUPPORT_PROFILE_LIMITS.roots.diskHeightMm),
            coneHeightMm: clampToRange(settings.roots.coneHeightMm, DEFAULT_ROOTS_CONE_HEIGHT_MM, SUPPORT_PROFILE_LIMITS.roots.coneHeightMm),
        },
    };
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

    return clampProfileFields({
        ...defaults,
        ...settings,
        tip: mergedTip,
        shaft: {
            ...defaults.shaft,
            ...settings.shaft,
            routingAlgorithm: (settings.shaft?.routingAlgorithm === 'astar') ? 'astar' : 'potential',
        },
        roots: { ...defaults.roots, ...settings.roots },
        baseFlare: { ...defaults.baseFlare, ...settings.baseFlare },
        joint: { ...defaults.joint, ...settings.joint },
        grid: mergedGrid,
        meshToMesh: { ...defaults.meshToMesh, ...(settings as any).meshToMesh },
        autoBracing: mergedAutoBracing,
        autoSupport: normalizeAutoSupportSettings({
            ...defaults.autoSupport,
            ...((settings as any).autoSupport ?? {}),
        }),
        devToolsEnabled: settings.devToolsEnabled !== undefined ? settings.devToolsEnabled : defaults.devToolsEnabled,
        devTools: settings.devTools ? { ...defaults.devTools, ...settings.devTools } : defaults.devTools,
        debugSimpleSupportRender: typeof settings.debugSimpleSupportRender === 'boolean' ? settings.debugSimpleSupportRender : defaults.debugSimpleSupportRender,
        navigationDiscsOnly: typeof settings.navigationDiscsOnly === 'boolean' ? settings.navigationDiscsOnly : defaults.navigationDiscsOnly,
    });
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

export function getAutoSupportSettings() {
    return currentSettings.autoSupport;
}

// --- Setters ---

export function setSettings(settings: SupportSettings): void {
    const merged = mergeWithDefaults(settings);
    // Clamp contact cone body diameter so it never exceeds the trunk diameter
    if (merged.tip.bodyDiameterMm > merged.shaft.diameterMm) {
        merged.tip.bodyDiameterMm = merged.shaft.diameterMm;
    }
    currentSettings = merged;
    notify();
}

export function updateTipProfile(tip: Partial<SupportSettings['tip']>): void {
    const mergedTip = { ...currentSettings.tip, ...tip };
    // Clamp contact cone body diameter so it never exceeds the trunk diameter
    if (mergedTip.bodyDiameterMm > currentSettings.shaft.diameterMm) {
        mergedTip.bodyDiameterMm = currentSettings.shaft.diameterMm;
    }
    currentSettings = clampProfileFields({
        ...currentSettings,
        tip: mergedTip,
    });
    notify();
}

export function updateShaftProfile(shaft: Partial<SupportSettings['shaft']>): void {
    // Clamp first, then mirror the accepted diameter onto the cone body: clamping
    // after the sync would leave a body diameter wider than the trunk.
    const next = clampProfileFields({
        ...currentSettings,
        shaft: { ...currentSettings.shaft, ...shaft },
    });
    const shouldSyncTipBodyDiameter = typeof shaft.diameterMm === 'number' && Number.isFinite(shaft.diameterMm) && shaft.diameterMm > 0;

    currentSettings = shouldSyncTipBodyDiameter
        ? { ...next, tip: { ...next.tip, bodyDiameterMm: next.shaft.diameterMm } }
        : next;
    notify();
}

export function updateRootsProfile(roots: Partial<SupportSettings['roots']>): void {
    currentSettings = clampProfileFields({
        ...currentSettings,
        roots: { ...currentSettings.roots, ...roots },
    });
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

export function updateAutoSupportSettings(autoSupport: Partial<SupportSettings['autoSupport']>): void {
    currentSettings = {
        ...currentSettings,
        autoSupport: applyAutoSupportSettingsPatch(currentSettings.autoSupport, autoSupport),
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

export function updateDebugSimpleSupportRender(enabled: boolean): void {
    currentSettings = {
        ...currentSettings,
        debugSimpleSupportRender: enabled,
    };
    notify();
}

/** The eye button in the Support Studio header: contact discs only, lines for the rest. */
export function updateNavigationDiscsOnly(enabled: boolean): void {
    currentSettings = {
        ...currentSettings,
        navigationDiscsOnly: enabled,
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

/**
 * Whether this context has the storage the settings persist to. The worker
 * loads this module and has none; tested directly rather than through `window`.
 */
function hasLocalStorage(): boolean {
    return typeof localStorage !== 'undefined';
}

export function saveSettingsToLocalStorage(): void {
    if (!hasLocalStorage()) return;
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
    if (!hasLocalStorage()) return false;
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (!stored) return false;
        const parsed = JSON.parse(stored) as SupportSettings;
        // Force reset dev tools on load
        parsed.devToolsEnabled = false;
        parsed.devTools = createDefaultSettings().devTools;
        // Force reset routingAlgorithm to potential on launch
        if (parsed.shaft) {
            parsed.shaft.routingAlgorithm = 'potential';
        }
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

loadSettingsFromLocalStorage();
