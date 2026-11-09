/**
 * Auto-Support Presets
 *
 * Named bundles of the `autoSupport` settings block: a preset is a run policy
 * (density, overhang angle, fan limits, sizing tier) that you pick, tweak, save
 * and share as JSON.
 *
 * Deliberately separate from the Support Studio presets in `./presets.ts`: that
 * store describes how a *manually placed* support is built (tip / shaft / roots
 * geometry) and excludes `autoSupport` from what it saves; this one carries
 * only the `autoSupport` block. They share no storage, no state and no ids —
 * neither store imports the other.
 *
 * Built-ins live in code and are never stored away: a stored record for a
 * built-in id can carry the user's saved edits, but never its identity.
 */

import {
    createDefaultAutoSupportSettings,
    migrateLegacySizingPreset,
    normalizeAutoSupportSettings,
    DIAGNOSTIC_AUTO_SUPPORT_KEYS,
    type AutoSupportSettings,
} from '../autoSupport/settings';
import {
    getAutoSupportSettings,
    saveSettingsToLocalStorage,
    updateAutoSupportSettings,
} from './state';

// --- Types ---

/**
 * A preset's payload IS the `autoSupport` settings block, whole — including
 * keys this build does not know, so a preset written by a newer version still
 * round-trips instead of losing what it cannot interpret.
 */
export type AutoSupportPresetSettings = AutoSupportSettings & Record<string, unknown>;

export type AutoSupportPreset = {
    id: string;
    /**
     * Stored name. A built-in id is displayed translated instead (see
     * `autoSupportPresetMessages`), so stored names stay language-neutral.
     */
    name: string;
    isBuiltIn: boolean;
    settings: AutoSupportPresetSettings;
    updatedAt?: number;
};

/** The import/export document — one preset, versioned by the format rather
 *  than by a field inside the payload. */
export type AutoSupportPresetDocument = {
    kind: typeof AUTO_SUPPORT_PRESET_DOCUMENT_KIND;
    formatVersion: typeof AUTO_SUPPORT_PRESET_FORMAT_VERSION;
    exportedAt: string;
    preset: {
        name: string;
        settings: AutoSupportPresetSettings;
    };
};

// --- Storage keys ---

/** The whole collection (`{ byId, allIds }`) — one key, written on every change. */
export const AUTO_SUPPORT_PRESETS_STORAGE_KEY = 'auto-support-presets-v1';
/** The active preset id, kept out of the collection key so the one fact has one home. */
export const AUTO_SUPPORT_ACTIVE_PRESET_ID_STORAGE_KEY = 'auto-support-active-preset-id-v1';

export const AUTO_SUPPORT_PRESET_DOCUMENT_KIND = 'dragonfruit-auto-support-preset';
export const AUTO_SUPPORT_PRESET_FORMAT_VERSION = 1;

// --- Built-ins ---

const DEFAULT_AUTO_SUPPORT_PRESET_NAME = 'Auto-Support Preset';

/**
 * The factory tier. Ids and settings mirror the Auto Support panel's
 * light/medium/heavy quick-select, whose values are the `autoSupport` blocks of
 * the Detail / Structure / Anchor trunk presets — reusing them is what keeps an
 * existing user's settings exactly where they are.
 *
 * Every block is built on `createDefaultAutoSupportSettings()` rather than a
 * literal copy, so a key added to the block later lands in the built-ins with
 * its default instead of arriving as `undefined`. The names here are English
 * placeholders: a built-in's display name is translated by id at render.
 */
const BUILT_IN_PRESETS: readonly AutoSupportPreset[] = [
    {
        id: 'light',
        name: 'Light',
        isBuiltIn: true,
        settings: {
            ...createDefaultAutoSupportSettings(),
            areaPerSupportMm2: 16,
            sizingPreset: 'detail',
        },
    },
    {
        id: 'medium',
        name: 'Medium',
        isBuiltIn: true,
        settings: snapshotPresetSettings(createDefaultAutoSupportSettings()),
    },
    {
        id: 'heavy',
        name: 'Heavy',
        isBuiltIn: true,
        settings: {
            ...createDefaultAutoSupportSettings(),
            areaPerSupportMm2: 5,
            sizingPreset: 'anchor',
        },
    },
];

const BUILT_IN_IDS: readonly string[] = BUILT_IN_PRESETS.map((preset) => preset.id);
/** The reserved ids, as the static lookup the load repair consults. */
const BUILT_IN_BY_ID: Record<string, AutoSupportPreset> = Object.fromEntries(
    BUILT_IN_PRESETS.map((preset) => [preset.id, preset]),
);

/** The keys the live settings block can hold. Unknown keys in a preset are
 *  forward-compatibility baggage: they are stored and exported verbatim, but
 *  the settings store drops them on apply, so they must not count as "edited". */
const KNOWN_AUTO_SUPPORT_KEYS = Object.keys(createDefaultAutoSupportSettings()) as (keyof AutoSupportSettings)[];

// --- Store state ---

type AutoSupportPresetState = {
    byId: Record<string, AutoSupportPreset>;
    allIds: string[];
    activeId: string | null;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasLocalStorage(): boolean {
    return typeof localStorage !== 'undefined';
}

/**
 * A detached copy of a settings block, for handing out or storing. The cast is
 * the seam: an interface carries no index signature, so TypeScript cannot see
 * the unknown keys a preset file may also hold.
 */
function snapshotPresetSettings(settings: AutoSupportSettings): AutoSupportPresetSettings {
    // The migration runs here rather than at each call site: this is the one
    // function every write path goes through — create, save, duplicate, restore,
    // import — and `readStoredState` adopts stored records through it as well, so
    // a preset written by a build that still carried `sizingPreset` is repaired
    // on the way in. One mapping, from the settings module.
    return structuredClone(migrateLegacySizingPreset(settings)) as AutoSupportPresetSettings;
}

function sanitizePresetName(value: unknown): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : DEFAULT_AUTO_SUPPORT_PRESET_NAME;
}

/**
 * Repair pass, run once at module load. The stored collection is user data that
 * a crash (or a hand-edited file) can leave inconsistent, and every read maps
 * `allIds` straight to records, so anything that would break that is fixed here
 * rather than guarded at every read:
 *
 * - unknown ids (never written, or from a build that no longer knows them) are dropped
 * - duplicate ids collapse to their first occurrence
 * - a record with no id in the order is appended, so a preset cannot be lost
 * - a missing/corrupt settings object falls back to the default block, keeping the name
 * - a built-in id is always the factory record, never the stored one
 */
function readStoredState(): AutoSupportPresetState {
    const byId: Record<string, AutoSupportPreset> = {};
    for (const preset of BUILT_IN_PRESETS) {
        byId[preset.id] = { ...preset, settings: snapshotPresetSettings(preset.settings) };
    }

    const stored = readStoredCollection();
    if (stored) {
        const storedById = isPlainObject(stored.byId) ? stored.byId : {};

        for (const [id, record] of Object.entries(storedById)) {
            if (Object.hasOwn(BUILT_IN_BY_ID, id)) {
                // Built-in ids are reserved: the factory record is the base, and
                // only the settings the user saved over it are adopted — never
                // the stored name, id or `isBuiltIn`.
                const builtIn = BUILT_IN_BY_ID[id];
                if (isPlainObject(record) && isPlainObject(record.settings)) {
                    byId[id] = {
                        ...builtIn,
                        settings: snapshotPresetSettings(record.settings as AutoSupportPresetSettings),
                        updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
                            ? record.updatedAt
                            : builtIn.updatedAt,
                    };
                }
                continue;
            }

            if (!isPlainObject(record) || byId[id]) continue;

            byId[id] = {
                id,
                name: sanitizePresetName(record.name),
                isBuiltIn: false,
                settings: isPlainObject(record.settings)
                    ? snapshotPresetSettings(record.settings as AutoSupportPresetSettings)
                    : snapshotPresetSettings(createDefaultAutoSupportSettings()),
                updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
                    ? record.updatedAt
                    : undefined,
            };
        }
    }

    // Built-ins first, then the user's presets in the order they were stored.
    const allIds: string[] = [...BUILT_IN_IDS];
    const storedOrder = stored && Array.isArray(stored.allIds) ? stored.allIds : [];
    for (const id of storedOrder) {
        if (typeof id !== 'string' || id.length === 0) continue;
        if (Object.hasOwn(BUILT_IN_BY_ID, id) || allIds.includes(id) || !byId[id]) continue;
        allIds.push(id);
    }
    for (const id of Object.keys(byId)) {
        if (!allIds.includes(id)) allIds.push(id);
    }

    // No preset is active until the user picks one. Inferring it from the live
    // settings — as the trunk preset store does — would claim the user chose a
    // preset they never picked, and the first knob edit would then read as a
    // silent rewrite of it. `null` honestly means "these settings are not a preset".
    let activeId: string | null = null;
    const storedActiveId = readStoredValue(AUTO_SUPPORT_ACTIVE_PRESET_ID_STORAGE_KEY);
    if (storedActiveId && byId[storedActiveId]) activeId = storedActiveId;

    return { byId, allIds, activeId };
}

function readStoredCollection(): Record<string, unknown> | null {
    const raw = readStoredValue(AUTO_SUPPORT_PRESETS_STORAGE_KEY);
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : null;
    } catch (err) {
        console.error('[AutoSupportPresetStore] Failed to load presets:', err);
        return null;
    }
}

function readStoredValue(key: string): string | null {
    if (!hasLocalStorage()) return null;
    try {
        return localStorage.getItem(key);
    } catch (err) {
        console.error('[AutoSupportPresetStore] Failed to read', key, err);
        return null;
    }
}

const state: AutoSupportPresetState = readStoredState();

function writeStoredState(): void {
    if (!hasLocalStorage()) return;
    try {
        localStorage.setItem(
            AUTO_SUPPORT_PRESETS_STORAGE_KEY,
            JSON.stringify({ byId: state.byId, allIds: state.allIds }),
        );
        if (state.activeId) {
            localStorage.setItem(AUTO_SUPPORT_ACTIVE_PRESET_ID_STORAGE_KEY, state.activeId);
        } else {
            localStorage.removeItem(AUTO_SUPPORT_ACTIVE_PRESET_ID_STORAGE_KEY);
        }
    } catch (err) {
        console.error('[AutoSupportPresetStore] Failed to save presets:', err);
    }
}

// --- Subscription ---

type AutoSupportPresetListener = () => void;
const listeners = new Set<AutoSupportPresetListener>();

/** The list every reader gets, rebuilt on every change — a selection change is
 *  a visible state change too — so `useSyncExternalStore` sees one reference per
 *  state and no reader observes a half-updated collection. */
let snapshot: AutoSupportPreset[] = state.allIds.map((id) => state.byId[id]);

/** What a storage-less render can show, as one stable reference. */
const SERVER_SNAPSHOT: AutoSupportPreset[] = BUILT_IN_PRESETS.map((preset) => ({
    ...preset,
    settings: snapshotPresetSettings(preset.settings),
}));

function notify() {
    snapshot = state.allIds.map((id) => state.byId[id]);
    listeners.forEach((listener) => {
        try {
            listener();
        } catch (err) {
            console.error('[AutoSupportPresetStore] listener error', err);
        }
    });
}

export function subscribeToAutoSupportPresets(listener: AutoSupportPresetListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** For `useSyncExternalStore(subscribeToAutoSupportPresets, getAutoSupportPresetsSnapshot)`. */
export function getAutoSupportPresetsSnapshot(): AutoSupportPreset[] {
    return snapshot;
}

/**
 * For the store's third `useSyncExternalStore` argument: a stable
 * built-ins-only list, which is what a server render (no storage) can show.
 * Returning the live snapshot instead would render one list on the server and
 * another after hydration in the browser.
 */
export function getAutoSupportPresetsServerSnapshot(): AutoSupportPreset[] {
    return SERVER_SNAPSHOT;
}

// --- Getters ---

export function getAutoSupportPresets(): AutoSupportPreset[] {
    return snapshot;
}

export function getAutoSupportPreset(id: string): AutoSupportPreset | undefined {
    return state.byId[id];
}

export function getActiveAutoSupportPresetId(): string | null {
    return state.activeId;
}

/**
 * The block's *policy* keys: everything except the diagnostics, which are view
 * switches rather than the run's instructions. They are compared everywhere
 * "did the user change something" is asked — the preset's drifted state here and
 * the dialog's staged draft in `useAutoSupportDialogChanges` — so a flipped
 * diagnostic never asks for a decision it does not need.
 */
export const POLICY_AUTO_SUPPORT_KEYS = KNOWN_AUTO_SUPPORT_KEYS.filter(
    (key) => !(DIAGNOSTIC_AUTO_SUPPORT_KEYS as readonly string[]).includes(key),
);

/** Whether two blocks differ on any policy key. By value: a block holds objects. */
export function autoSupportPolicyDiffers(a: AutoSupportSettings, b: AutoSupportSettings): boolean {
    return POLICY_AUTO_SUPPORT_KEYS.some(
        (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]),
    );
}

/**
 * Whether the live `autoSupport` block still matches the active preset.
 *
 * Editing a knob while a preset is active leaves the preset alone and leaves
 * the active id in place: the preset is the user's saved reference point, so
 * rewriting it silently would destroy what they can revert to, and clearing the
 * id would throw away the fact that they started from it. The state is simply
 * *dirty*, and the UI offers Save (`saveAutoSupportPreset`) or Revert
 * (`resetToActivePreset`).
 *
 * Only the keys the settings block can hold are compared; an imported preset's
 * unknown keys never make it dirty, because the settings store cannot apply
 * them in the first place.
 */
export function isAutoSupportPresetDirty(): boolean {
    const preset = state.activeId ? state.byId[state.activeId] : undefined;
    if (!preset) return false;

    // Both sides go through the normalizer, so a stored payload that predates a
    // key — or still carries a legacy one — fills the same defaults the live block
    // does and an untouched preset reads clean. Comparing the raw payloads marked
    // every preset dirty the moment a key was added or renamed (`sizingPreset` →
    // `sizingBand`), and would do so again for the next key.
    return autoSupportPolicyDiffers(
        normalizeAutoSupportSettings(preset.settings),
        normalizeAutoSupportSettings(getAutoSupportSettings()),
    );
}

// --- Setters ---

/**
 * Applies a whole block, not a patch: a preset that omits a key gets the
 * default for it rather than whatever the previous preset left behind, so
 * selecting the same preset twice always lands on the same state.
 */
function applyPresetSettings(preset: AutoSupportPreset): void {
    updateAutoSupportSettings(preset.settings);
    // Keep the persisted settings and the active id in step: without this, a
    // restart would show one preset as active over the settings of another and
    // read as dirty before the user touched anything.
    saveSettingsToLocalStorage();
}

export function setActiveAutoSupportPreset(id: string | null): void {
    if (id === null) {
        if (state.activeId === null) return;
        state.activeId = null;
        writeStoredState();
        notify();
        return;
    }

    const preset = state.byId[id];
    if (!preset) {
        console.warn('[AutoSupportPresetStore] Cannot activate, preset not found:', id);
        return;
    }

    state.activeId = id;
    applyPresetSettings(preset);
    writeStoredState();
    notify();
}

/** Re-applies the active preset over the live settings — the UI's Revert. */
export function resetToActivePreset(): void {
    const preset = state.activeId ? state.byId[state.activeId] : undefined;
    if (!preset) return;
    applyPresetSettings(preset);
    notify();
}

function makeAutoSupportPresetId(): string {
    return `asp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function ensureUniquePresetName(desiredName: string, excludeId?: string): string {
    const base = sanitizePresetName(desiredName);
    let name = base;
    let counter = 1;

    const taken = (candidate: string) => {
        const lower = candidate.toLowerCase();
        return Object.values(state.byId).some(
            (preset) => preset.id !== excludeId && preset.name.toLowerCase() === lower,
        );
    };

    while (taken(name)) {
        counter += 1;
        name = `${base} (${counter})`;
    }

    return name;
}

function insertPreset(preset: AutoSupportPreset, activate: boolean): AutoSupportPreset {
    state.byId[preset.id] = preset;
    state.allIds.push(preset.id);
    if (activate) state.activeId = preset.id;
    writeStoredState();
    notify();
    return preset;
}

/** Captures the live `autoSupport` block as a new preset and makes it active. */
export function createAutoSupportPreset(name: string): AutoSupportPreset {
    return insertPreset({
        id: makeAutoSupportPresetId(),
        name: ensureUniquePresetName(name),
        isBuiltIn: false,
        settings: snapshotPresetSettings(getAutoSupportSettings()),
        updatedAt: Date.now(),
    }, true);
}

/** Writes the live `autoSupport` block into a preset — the UI's Save. */
export function saveAutoSupportPreset(id: string): void {
    const preset = state.byId[id];
    if (!preset) {
        console.warn('[AutoSupportPresetStore] Cannot save, preset not found:', id);
        return;
    }
    if (preset.isBuiltIn) {
        // A built-in's block is the factory's, and its id is what the panel's tier
        // row and the file format are defined in terms of. Refused here as well as
        // in the UI, so no caller can write over one: `duplicateAutoSupportPreset`
        // is the way to keep an edit, and it returns a preset of the user's own.
        console.warn('[AutoSupportPresetStore] Built-in presets cannot be saved over:', id);
        return;
    }

    state.byId[id] = {
        ...preset,
        settings: snapshotPresetSettings(getAutoSupportSettings()),
        updatedAt: Date.now(),
    };

    writeStoredState();
    notify();
}

/**
 * The settings dialog's commit: the draft becomes the live block, and the active
 * preset is written with it **when the two differ**.
 *
 * One call, because those two halves are one decision. Splitting them is what made
 * `Save` leave its own preset reading as modified: writing only the live settings
 * leaves the preset holding the block it had, and the star the user just asked Save
 * to clear stays on.
 *
 * The "do they differ" test is read *after* the write, on purpose. It used to be
 * read from the pre-write block, which is answerable only for the drift the live
 * settings had before the draft landed — never for the draft itself.
 *
 * A built-in is untouched: `saveAutoSupportPreset` refuses one, which is why the
 * dialog disables Save for it in the first place.
 */
export function commitAutoSupportSettings(draft: AutoSupportSettings): void {
    updateAutoSupportSettings(draft);
    const activeId = state.activeId;
    if (activeId && isAutoSupportPresetDirty()) saveAutoSupportPreset(activeId);
}

/**
 * Renames a user preset, returning it so the caller can show the name actually
 * applied ("Medium" becomes "Medium (2)" rather than a duplicate).
 *
 * A built-in is refused — its title is translated by id at render, so a stored
 * rename could never be displayed. `null` means the rename did not happen.
 */
export function renameAutoSupportPreset(id: string, name: string): AutoSupportPreset | null {
    const preset = state.byId[id];
    if (!preset) {
        console.warn('[AutoSupportPresetStore] Cannot rename, preset not found:', id);
        return null;
    }
    if (preset.isBuiltIn) {
        console.warn('[AutoSupportPresetStore] Built-in preset names are translated and cannot be renamed:', id);
        return null;
    }

    const renamed: AutoSupportPreset = {
        ...preset,
        name: ensureUniquePresetName(name, id),
        updatedAt: Date.now(),
    };

    state.byId[id] = renamed;
    writeStoredState();
    notify();
    return renamed;
}

/**
 * Copies a preset under a new name, and makes the copy the selection.
 *
 * The copy is the way to keep an edit that the store refuses to write where it is
 * — a built-in cannot be saved over — so the selection has to move with it: `Save`
 * writes the *selected* preset, and leaving the source selected would send the next
 * save straight back into the refusal.
 *
 * The copy's block is the source's, and the live settings are left where they are
 * rather than being re-applied. That is what lets a staged edit survive: an edit
 * the dialog is holding in its draft is not in the source's stored block, so
 * re-applying would discard exactly the work the duplicate was made to keep. The
 * copy then reads as modified, which is the truth — the settings on screen are not
 * its block until they are saved into it.
 */
/**
 * `copyName` is the name the copy should take, translated by the caller (the store has no
 * language); it is made unique here. Without one the copy is named "<source> copy".
 */
export function duplicateAutoSupportPreset(id: string, copyName?: string): AutoSupportPreset | null {
    const source = state.byId[id];
    if (!source) {
        console.warn('[AutoSupportPresetStore] Cannot duplicate, preset not found:', id);
        return null;
    }

    return insertPreset({
        id: makeAutoSupportPresetId(),
        name: ensureUniquePresetName(copyName ?? `${source.name} copy`),
        isBuiltIn: false,
        settings: snapshotPresetSettings(source.settings),
        updatedAt: Date.now(),
    }, true);
}

/**
 * Deletes a user preset. A built-in is refused: the Auto Support panel's
 * light/medium/heavy row and the preset file format are defined in terms of
 * those ids, and `restoreAutoSupportFactoryDefaults` is about their settings,
 * not about bringing a deleted tier back.
 */
export function deleteAutoSupportPreset(id: string): void {
    const preset = state.byId[id];
    if (!preset) {
        console.warn('[AutoSupportPresetStore] Cannot delete, preset not found:', id);
        return;
    }
    if (preset.isBuiltIn) {
        console.warn('[AutoSupportPresetStore] Built-in presets cannot be deleted:', id);
        return;
    }

    delete state.byId[id];
    state.allIds = state.allIds.filter((presetId) => presetId !== id);
    if (state.activeId === id) state.activeId = null;

    writeStoredState();
    notify();
}

/**
 * Puts the built-in records back to their factory settings; the user's own
 * presets are left alone. The live settings are not touched either, so a user
 * who reverts a tier sees it read as dirty and can Revert to accept the factory
 * block — a reset that also overwrote the live settings would be a second,
 * unasked-for change.
 */
export function restoreAutoSupportFactoryDefaults(): void {
    for (const preset of BUILT_IN_PRESETS) {
        state.byId[preset.id] = { ...preset, settings: snapshotPresetSettings(preset.settings) };
    }

    writeStoredState();
    notify();
}

// --- Import / export ---

export function exportAutoSupportPresetToJson(id: string): string {
    const preset = state.byId[id];
    if (!preset) {
        throw new Error(`Unknown auto-support preset: ${id}.`);
    }

    const doc: AutoSupportPresetDocument = {
        kind: AUTO_SUPPORT_PRESET_DOCUMENT_KIND,
        formatVersion: AUTO_SUPPORT_PRESET_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        preset: {
            name: preset.name,
            settings: snapshotPresetSettings(preset.settings),
        },
    };

    return JSON.stringify(doc, null, 2);
}

/**
 * Reads a preset document and adds it, making it active and applying it — the
 * user asked for this policy, so it is the one the next run uses.
 *
 * Every rejection throws with a message a UI can show verbatim. An unknown
 * `kind` or `formatVersion` is a hard reject with no migration attempt, exactly
 * as the theme-profile importer treats them: guessing at a format this build
 * does not know is how a preset silently becomes the wrong policy. Unknown keys
 * inside `settings` are accepted — carrying a knob this build cannot name is
 * the point of a preset file.
 */
export function importAutoSupportPresetFromJson(jsonText: string): AutoSupportPreset {
    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonText);
    } catch {
        throw new Error('Invalid auto-support preset file: not valid JSON.');
    }

    if (!isPlainObject(parsed)) {
        throw new Error('Invalid auto-support preset file: expected a JSON object.');
    }

    if (parsed.kind !== AUTO_SUPPORT_PRESET_DOCUMENT_KIND) {
        throw new Error('Invalid auto-support preset file: unsupported kind.');
    }

    if (parsed.formatVersion !== AUTO_SUPPORT_PRESET_FORMAT_VERSION) {
        throw new Error(`Invalid auto-support preset file: unsupported format version ${String(parsed.formatVersion)}.`);
    }

    if (!isPlainObject(parsed.preset)) {
        throw new Error('Invalid auto-support preset file: missing preset.');
    }

    const name = parsed.preset.name;
    if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('Invalid auto-support preset file: missing preset name.');
    }

    if (!isPlainObject(parsed.preset.settings)) {
        throw new Error('Invalid auto-support preset file: settings must be an object.');
    }

    const preset: AutoSupportPreset = {
        id: makeAutoSupportPresetId(),
        name: ensureUniquePresetName(name),
        isBuiltIn: false,
        // The file may name only some keys. Merging over the defaults yields a
        // complete block (so applying it cannot read back as dirty against the
        // live settings) while imported values win and keys this build does not
        // know still survive the round trip.
        settings: snapshotPresetSettings({
            ...createDefaultAutoSupportSettings(),
            // The payload is migrated before the spread: a file exported by a
            // build that still wrote `sizingPreset` must land on its band, and the
            // obsolete key must not survive as an unknown key of the preset.
            ...migrateLegacySizingPreset(parsed.preset.settings as Partial<AutoSupportSettings>),
        } as AutoSupportPresetSettings),
        updatedAt: Date.now(),
    };

    insertPreset(preset, true);
    applyPresetSettings(preset);
    return preset;
}
