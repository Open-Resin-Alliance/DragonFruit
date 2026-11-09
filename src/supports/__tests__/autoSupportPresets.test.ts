import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

import { ANCHOR_PRESET, DETAIL_PRESET, STRUCTURE_PRESET } from '../Settings/presets';
import { createDefaultAutoSupportSettings, SIZING_BANDS } from '../autoSupport/settings';
import { getAutoSupportSettings, updateAutoSupportDiagnostic, updateAutoSupportSettings } from '../Settings/state';
import type * as AutoSupportPresetStore from '../Settings/autoSupportPresets';

type Store = typeof AutoSupportPresetStore;

/**
 * The store reads localStorage exactly once, at module load, which is the
 * behaviour under test — so a test needs a *fresh instance* of the module, with
 * its storage stand-in already in place. A dynamic `import()` cannot do that
 * (tsx caches by path, ignoring a cache-busting query — verified), so the module
 * is pulled through `require` and dropped from the require cache first. The
 * store itself is referred to by type only, so nothing else loads it and the
 * instance under test is the only one alive.
 */
const require = createRequire(import.meta.url);
const STORE_PATH = require.resolve('../Settings/autoSupportPresets.ts');

const PRESETS_KEY = 'auto-support-presets-v1';
const ACTIVE_KEY = 'auto-support-active-preset-id-v1';
const DOCUMENT_KIND = 'dragonfruit-auto-support-preset';

/**
 * Node has no `localStorage`, so every storage call would land in the store's
 * catch: writes would never happen and the persistence path would be tested by
 * not being exercised. An in-memory store fixes both — the writes happen for
 * real and can be asserted on.
 */
function installMemoryLocalStorage(seed: Record<string, string> = {}): Map<string, string> {
    const store = new Map<string, string>(Object.entries(seed));
    const stub: Storage = {
        get length() {
            return store.size;
        },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
    };
    Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
    return store;
}

function reloadStore(): Store {
    delete require.cache[STORE_PATH];
    return require(STORE_PATH) as Store;
}

function loadStoreWith(seed: Record<string, string> = {}): { store: Store; storage: Map<string, string> } {
    const storage = installMemoryLocalStorage(seed);
    return { store: reloadStore(), storage };
}

function loadStoreWithNoStorage(): Store {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    delete require.cache[STORE_PATH];
    return require(STORE_PATH) as Store;
}

test('built-in presets are the Auto Support panel light/medium/heavy tiers, settings included', () => {
    const { store } = loadStoreWith();

    // The panel's quick-select writes these same blocks through the settings
    // store, so the two must stay equal or the panel and the preset list would
    // describe different densities under the same names.
    assert.deepEqual(store.getAutoSupportPresets().map((preset) => preset.id), ['light', 'medium', 'heavy']);
    assert.deepEqual(store.getAutoSupportPreset('light')!.settings, DETAIL_PRESET.settings.autoSupport);
    assert.deepEqual(store.getAutoSupportPreset('medium')!.settings, STRUCTURE_PRESET.settings.autoSupport);
    assert.deepEqual(store.getAutoSupportPreset('heavy')!.settings, ANCHOR_PRESET.settings.autoSupport);
    assert.ok(store.getAutoSupportPresets().every((preset) => preset.isBuiltIn));

    // Loading the store must not rearrange anybody's settings: no preset is
    // active until the user picks one.
    assert.equal(store.getActiveAutoSupportPresetId(), null);
});

test('a preset payload that predates a key reads clean, and a knob edit reads dirty', () => {
    // Two records a build before `sizingBand` would have written: one whose block
    // simply has no band, and one still carrying the legacy `sizingPreset`. Both
    // must read clean, or every preset shows as modified forever — the comparison
    // normalizes both sides, so a payload missing a key (or holding a legacy one)
    // fills the same defaults the live block does.
    const withoutTier = { ...createDefaultAutoSupportSettings() } as Record<string, unknown>;
    delete withoutTier.sizingPreset;
    // A block from the band-as-data build: it carries the seven numbers and no id.
    const bandEra = {
        ...createDefaultAutoSupportSettings(),
        sizingBand: { ...SIZING_BANDS.detail },
    } as Record<string, unknown>;
    delete bandEra.sizingPreset;

    for (const [label, settings] of [['no tier', withoutTier], ['band era', bandEra]] as const) {
        const { store } = loadStoreWith({
            [PRESETS_KEY]: JSON.stringify({
                byId: { light: { id: 'light', name: 'Light', isBuiltIn: true, settings } },
                allIds: ['light'],
            }),
            [ACTIVE_KEY]: 'light',
        });
        store.setActiveAutoSupportPreset('light');
        assert.equal(store.isAutoSupportPresetDirty(), false, `${label}: an untouched stored preset reads clean`);

        updateAutoSupportSettings({ areaPerSupportMm2: 7 });
        assert.equal(store.isAutoSupportPresetDirty(), true, `${label}: a knob edit reads dirty`);
    }
});

test('a flipped diagnostic asks for nothing; a policy edit still does', () => {
    const { store } = loadStoreWith({
        [PRESETS_KEY]: JSON.stringify({
            byId: {
                light: { id: 'light', name: 'Light', isBuiltIn: true, settings: createDefaultAutoSupportSettings() },
            },
            allIds: ['light'],
        }),
        [ACTIVE_KEY]: 'light',
    });
    store.setActiveAutoSupportPreset('light');
    assert.equal(store.isAutoSupportPresetDirty(), false, 'a freshly applied preset reads clean');

    // Diagnostics are view switches: applied at once, and invisible to every
    // "did the user change something" question, so closing the dialog never asks
    // whether to discard one.
    const beforeToggle = getAutoSupportSettings();
    updateAutoSupportDiagnostic('debugSupportOriginColors', true);
    assert.equal(getAutoSupportSettings().debugSupportOriginColors, true, 'the diagnostic applies at once');
    assert.equal(store.isAutoSupportPresetDirty(), false, 'a diagnostic does not dirty the preset');
    assert.equal(
        store.autoSupportPolicyDiffers(
            { ...getAutoSupportSettings(), debugSupportOriginColors: false },
            getAutoSupportSettings(),
        ),
        false,
        'a diagnostic does not count as a staged edit in the dialog either',
    );
    assert.equal(
        store.autoSupportPolicyDiffers(
            { ...beforeToggle, areaPerSupportMm2: beforeToggle.areaPerSupportMm2 + 1 },
            getAutoSupportSettings(),
        ),
        true,
        'a staged policy edit still counts',
    );

    // The run policy is a different matter: it is what Save writes.
    updateAutoSupportSettings({ areaPerSupportMm2: 7 });
    assert.equal(store.isAutoSupportPresetDirty(), true, 'a policy edit still reads dirty');
});

test('create, rename, duplicate and delete persist, and built-ins are not renamed or deleted', () => {
    updateAutoSupportSettings(createDefaultAutoSupportSettings());
    const { store, storage } = loadStoreWith();

    updateAutoSupportSettings({ areaPerSupportMm2: 7 });
    const created = store.createAutoSupportPreset('Mine');
    assert.equal(created.settings.areaPerSupportMm2, 7);
    assert.equal(created.isBuiltIn, false);
    assert.equal(store.getActiveAutoSupportPresetId(), created.id);
    assert.equal(store.isAutoSupportPresetDirty(), false);
    assert.deepEqual(store.getAutoSupportPresets().map((preset) => preset.name), ['Light', 'Medium', 'Heavy', 'Mine']);

    // A name already in use is made unique rather than duplicated.
    assert.equal(store.renameAutoSupportPreset(created.id, 'Medium')!.name, 'Medium (2)');
    // A built-in's name is translated at render, so a stored rename could never show.
    assert.equal(store.renameAutoSupportPreset('light', 'Pale'), null);
    assert.equal(store.getAutoSupportPreset('light')!.name, 'Light');

    // An edit with no home yet — the case Duplicate exists for, since a built-in
    // cannot be saved over and this is the live block the copy has to be made from.
    updateAutoSupportSettings({ sizeScale: 1.2 });

    const copy = store.duplicateAutoSupportPreset(created.id)!;
    assert.notEqual(copy.id, created.id);
    assert.deepEqual(copy.settings, store.getAutoSupportPreset(created.id)!.settings);
    assert.notEqual(copy.settings, store.getAutoSupportPreset(created.id)!.settings);
    assert.equal(copy.name, 'Medium (2) copy');
    // The copy is what gets worked on next, so the selection moves to it.
    assert.equal(store.getActiveAutoSupportPresetId(), copy.id);
    // And the live block is left where it was rather than re-applied: applying the
    // copy's block (which is the source's) would discard that edit, exactly the work
    // the duplicate was made to keep. So the copy reads modified, which is the truth
    // until the edit is saved into it.
    assert.equal(getAutoSupportSettings().sizeScale, 1.2);
    assert.equal(store.isAutoSupportPresetDirty(), true);

    // One key per fact: records and order in the collection key, the active id on its own.
    assert.equal(storage.get(ACTIVE_KEY), copy.id);
    assert.deepEqual(Object.keys(JSON.parse(storage.get(PRESETS_KEY)!)).sort(), ['allIds', 'byId']);

    const reloaded = reloadStore();
    assert.deepEqual(
        reloaded.getAutoSupportPresets().map((preset) => preset.name),
        ['Light', 'Medium', 'Heavy', 'Medium (2)', 'Medium (2) copy'],
    );
    // The copy is the selection, and it survives the reload: the active id is its
    // own key, not a field of the collection.
    assert.equal(reloaded.getActiveAutoSupportPresetId(), copy.id);
    assert.deepEqual(reloaded.getAutoSupportPreset(created.id)!.settings, {
        ...createDefaultAutoSupportSettings(),
        areaPerSupportMm2: 7,
    });

    // Deleting a built-in is refused: the light/medium/heavy row and the file
    // format are defined in terms of those ids.
    reloaded.deleteAutoSupportPreset('heavy');
    assert.deepEqual(reloaded.getAutoSupportPresets().map((preset) => preset.id), ['light', 'medium', 'heavy', created.id, copy.id]);

    reloaded.deleteAutoSupportPreset(created.id);
    reloaded.deleteAutoSupportPreset(copy.id);
    assert.deepEqual(reloaded.getAutoSupportPresets().map((preset) => preset.id), ['light', 'medium', 'heavy']);
    assert.equal(reloaded.getActiveAutoSupportPresetId(), null);
    assert.equal(storage.get(ACTIVE_KEY), undefined);
    assert.equal(JSON.parse(storage.get(PRESETS_KEY)!).allIds.length, 3);
});

test('the commit writes the settings and the preset together, so no star is left behind', () => {
    updateAutoSupportSettings(createDefaultAutoSupportSettings());
    const { store } = loadStoreWith();

    const mine = store.createAutoSupportPreset('Mine');
    // What the dialog holds when the user edits a knob and then presses Save: the
    // draft has moved, the store has not.
    const staged = { ...getAutoSupportSettings(), areaPerSupportMm2: 12 };

    store.commitAutoSupportSettings(staged);

    assert.equal(getAutoSupportSettings().areaPerSupportMm2, 12, 'the draft becomes the live block');
    assert.equal(
        store.getAutoSupportPreset(mine.id)!.settings.areaPerSupportMm2,
        12,
        'and the preset the dialog was saving into holds it',
    );
    assert.equal(store.isAutoSupportPresetDirty(), false, 'so nothing is left reading as modified');

    // A commit with nothing staged must not rewrite the record: the same object
    // still stands, so `updatedAt` is not bumped and no write is issued.
    store.commitAutoSupportSettings(getAutoSupportSettings());
    const before = store.getAutoSupportPreset(mine.id)!;
    store.commitAutoSupportSettings(getAutoSupportSettings());
    assert.equal(store.getAutoSupportPreset(mine.id), before, 'a clean commit leaves the preset as it is');

    // A built-in is refused by the store, so a commit that reaches one still writes
    // the live settings and leaves the factory block alone.
    store.setActiveAutoSupportPreset('light');
    store.commitAutoSupportSettings({ ...getAutoSupportSettings(), areaPerSupportMm2: 9 });
    assert.equal(getAutoSupportSettings().areaPerSupportMm2, 9, 'the live settings take the draft');
    assert.equal(store.getAutoSupportPreset('light')!.settings.areaPerSupportMm2, 16, 'the built-in does not');
});

test('a knob edit dirties the active preset; save and reset are the two exits', () => {
    updateAutoSupportSettings(createDefaultAutoSupportSettings());
    const { store, storage } = loadStoreWith();

    store.setActiveAutoSupportPreset('light');
    assert.equal(getAutoSupportSettings().areaPerSupportMm2, 16);
    assert.equal(store.isAutoSupportPresetDirty(), false);

    // The edit is not silently written into the preset, and it does not detach it.
    updateAutoSupportSettings({ areaPerSupportMm2: 12 });
    assert.equal(store.isAutoSupportPresetDirty(), true);
    assert.equal(store.getActiveAutoSupportPresetId(), 'light');
    assert.equal(store.getAutoSupportPreset('light')!.settings.areaPerSupportMm2, 16);

    store.resetToActivePreset();
    assert.equal(getAutoSupportSettings().areaPerSupportMm2, 16);
    assert.equal(store.isAutoSupportPresetDirty(), false);

    // A built-in refuses the save: its block is the factory's, so Duplicate is the
    // way to keep an edit. The live block keeps the edit and stays dirty.
    updateAutoSupportSettings({ sizeScale: 1.2 });
    store.saveAutoSupportPreset('light');
    assert.equal(store.getAutoSupportPreset('light')!.settings.sizeScale, 1);
    assert.equal(store.isAutoSupportPresetDirty(), true);

    // Factory restore is a no-op on a block that was never saved over, and Reset
    // is still the way to accept the factory's.
    store.restoreAutoSupportFactoryDefaults();
    assert.equal(store.getAutoSupportPreset('light')!.settings.sizeScale, 1);
    store.resetToActivePreset();
    assert.equal(getAutoSupportSettings().sizeScale, 1);
    assert.equal(store.isAutoSupportPresetDirty(), false);

    // A preset of the user's own takes the save.
    const mine = store.createAutoSupportPreset('Mine');
    updateAutoSupportSettings({ sizeScale: 1.3 });
    assert.equal(store.isAutoSupportPresetDirty(), true);
    store.saveAutoSupportPreset(mine.id);
    assert.equal(store.getAutoSupportPreset(mine.id)!.settings.sizeScale, 1.3);
    assert.equal(store.isAutoSupportPresetDirty(), false);

    // With nothing selected there is nothing to be dirty about.
    store.setActiveAutoSupportPreset(null);
    assert.equal(storage.get(ACTIVE_KEY), undefined);
    updateAutoSupportSettings({ areaPerSupportMm2: 22 });
    assert.equal(store.getActiveAutoSupportPresetId(), null);
    assert.equal(store.isAutoSupportPresetDirty(), false);
});

test('subscribers fire per change and the snapshot reference is stable between them', () => {
    updateAutoSupportSettings(createDefaultAutoSupportSettings());
    const { store } = loadStoreWith();

    let notifications = 0;
    const unsubscribe = store.subscribeToAutoSupportPresets(() => {
        notifications += 1;
    });

    const before = store.getAutoSupportPresets();
    assert.equal(store.getAutoSupportPresetsSnapshot(), before);

    store.setActiveAutoSupportPreset('heavy');
    assert.equal(notifications, 1);
    assert.notEqual(store.getAutoSupportPresetsSnapshot(), before);
    assert.equal(store.getActiveAutoSupportPresetId(), 'heavy');

    // A refused mutation changes nothing, so nothing is announced.
    store.deleteAutoSupportPreset('heavy');
    assert.equal(notifications, 1);

    store.createAutoSupportPreset('Mine');
    assert.equal(notifications, 2);

    unsubscribe();
    store.deleteAutoSupportPreset(store.getAutoSupportPresets().at(-1)!.id);
    assert.equal(notifications, 2);
});

test('export and import round-trip a preset document', () => {
    const { store } = loadStoreWith();

    const exported = store.exportAutoSupportPresetToJson('heavy');
    const doc = JSON.parse(exported);
    assert.equal(doc.kind, DOCUMENT_KIND);
    assert.equal(doc.formatVersion, 1);
    assert.equal(doc.preset.name, 'Heavy');
    assert.deepEqual(doc.preset.settings, ANCHOR_PRESET.settings.autoSupport);
    assert.equal(Object.keys(doc).sort().join(','), 'exportedAt,formatVersion,kind,preset');
    assert.ok(!Number.isNaN(Date.parse(doc.exportedAt)), 'exportedAt is an ISO timestamp');

    const imported = store.importAutoSupportPresetFromJson(exported);
    assert.notEqual(imported.id, 'heavy');
    assert.equal(imported.isBuiltIn, false);
    assert.equal(imported.name, 'Heavy (2)');
    assert.deepEqual(imported.settings, ANCHOR_PRESET.settings.autoSupport);
    // The user asked for this policy, so it is the one now in effect.
    assert.equal(store.getActiveAutoSupportPresetId(), imported.id);
    assert.equal(getAutoSupportSettings().areaPerSupportMm2, 5);
    assert.equal(store.isAutoSupportPresetDirty(), false);

    // The document survives a second round trip unchanged.
    const reExported = JSON.parse(store.exportAutoSupportPresetToJson(imported.id));
    assert.equal(reExported.preset.name, imported.name);
    assert.deepEqual(reExported.preset.settings, doc.preset.settings);
    assert.deepEqual(store.getAutoSupportPresets().map((preset) => preset.id), ['light', 'medium', 'heavy', imported.id]);

    assert.throws(
        () => store.exportAutoSupportPresetToJson('missing'),
        { message: 'Unknown auto-support preset: missing.' },
    );
});

test('a partial document is completed from the defaults, so importing it is not dirty', () => {
    const { store } = loadStoreWith();
    const defaults = createDefaultAutoSupportSettings();

    const partial = JSON.stringify({
        kind: DOCUMENT_KIND,
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        preset: { name: 'Partial', settings: { areaPerSupportMm2: 7, sizingPreset: 'detail' } },
    });

    const imported = store.importAutoSupportPresetFromJson(partial);

    // The named keys win, everything else comes from the defaults.
    assert.equal(getAutoSupportSettings().areaPerSupportMm2, 7);
    // The payload names a tier: it survives as the preset id the run resolves.
    assert.equal(getAutoSupportSettings().sizingPreset, 'detail');
    assert.equal(getAutoSupportSettings().overhangSelfSupportAngleDeg, defaults.overhangSelfSupportAngleDeg);
    assert.equal(getAutoSupportSettings().tipContactMarginScale, defaults.tipContactMarginScale);
    // Applying a complete block leaves nothing to save.
    assert.equal(store.isAutoSupportPresetDirty(), false);
    assert.deepEqual(imported.settings.overhangSelfSupportAngleDeg, defaults.overhangSelfSupportAngleDeg);
});

test('a settings key this build does not know survives a round trip without reading as dirty', () => {
    const { store } = loadStoreWith();
    const doc = {
        kind: DOCUMENT_KIND,
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        preset: {
            name: 'From the future',
            settings: {
                ...createDefaultAutoSupportSettings(),
                areaPerSupportMm2: 9,
                futureKnobMm: 3,
                futureNested: { mode: 'x' },
            },
        },
    };

    const imported = store.importAutoSupportPresetFromJson(JSON.stringify(doc));
    assert.equal((imported.settings as Record<string, unknown>).futureKnobMm, 3);

    const reloaded = reloadStore();
    const persisted = reloaded.getAutoSupportPreset(imported.id)!;
    assert.equal((persisted.settings as Record<string, unknown>).futureKnobMm, 3);
    assert.deepEqual((persisted.settings as Record<string, unknown>).futureNested, { mode: 'x' });
    assert.equal((JSON.parse(reloaded.exportAutoSupportPresetToJson(imported.id))
        .preset.settings as Record<string, unknown>).futureKnobMm, 3);

    // The settings store cannot apply a key it does not know, so its absence
    // from the live block must not read as an unsaved edit.
    assert.equal((getAutoSupportSettings() as unknown as Record<string, unknown>).futureKnobMm, undefined);
    assert.equal(reloaded.isAutoSupportPresetDirty(), false);
});

test('every import rejection has its own user-presentable message, and adds nothing', () => {
    updateAutoSupportSettings(createDefaultAutoSupportSettings());
    const { store } = loadStoreWith();
    const valid = {
        kind: DOCUMENT_KIND,
        formatVersion: 1,
        exportedAt: '2026-01-01T00:00:00.000Z',
        preset: { name: 'Ok', settings: createDefaultAutoSupportSettings() },
    };

    const reject = (jsonText: string, message: string) => {
        assert.throws(() => store.importAutoSupportPresetFromJson(jsonText), { message });
    };

    reject('{', 'Invalid auto-support preset file: not valid JSON.');
    reject('null', 'Invalid auto-support preset file: expected a JSON object.');
    reject('[1, 2]', 'Invalid auto-support preset file: expected a JSON object.');
    reject(JSON.stringify({ ...valid, kind: 'dragonfruit-theme-profile' }), 'Invalid auto-support preset file: unsupported kind.');
    reject(JSON.stringify({ preset: valid.preset }), 'Invalid auto-support preset file: unsupported kind.');
    reject(JSON.stringify({ ...valid, formatVersion: 2 }), 'Invalid auto-support preset file: unsupported format version 2.');
    reject(JSON.stringify({ ...valid, formatVersion: '1' }), 'Invalid auto-support preset file: unsupported format version 1.');
    reject(JSON.stringify({ ...valid, preset: null }), 'Invalid auto-support preset file: missing preset.');
    reject(JSON.stringify({ ...valid, preset: 'Ok' }), 'Invalid auto-support preset file: missing preset.');
    reject(JSON.stringify({ ...valid, preset: { name: '   ', settings: {} } }), 'Invalid auto-support preset file: missing preset name.');
    reject(JSON.stringify({ ...valid, preset: { settings: {} } }), 'Invalid auto-support preset file: missing preset name.');
    reject(JSON.stringify({ ...valid, preset: { name: 5, settings: {} } }), 'Invalid auto-support preset file: missing preset name.');
    reject(JSON.stringify({ ...valid, preset: { name: 'Ok', settings: null } }), 'Invalid auto-support preset file: settings must be an object.');
    reject(JSON.stringify({ ...valid, preset: { name: 'Ok', settings: [1] } }), 'Invalid auto-support preset file: settings must be an object.');

    assert.deepEqual(store.getAutoSupportPresets().map((preset) => preset.id), ['light', 'medium', 'heavy']);
    assert.equal(store.getActiveAutoSupportPresetId(), null);
});

test('load repairs unknown, duplicate and reserved ids, and adopts a valid active id', () => {
    const collection = {
        byId: {
            // A stored built-in may carry the user's saved edits, never its identity.
            light: { id: 'light', name: 'Hacked', isBuiltIn: false, settings: { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, sizingPreset: 'detail' } },
            'asp-ok': { id: 'asp-ok', name: '  Ok  ', isBuiltIn: false, settings: { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 12 } },
            'asp-broken': { id: 'asp-broken', name: 'Broken', settings: 'not an object' },
            'asp-string': 'nope',
            'asp-empty': null,
            'asp-nameless': { settings: { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 4 } },
        },
        allIds: ['asp-ok', 'asp-ok', null, 42, 'asp-unknown', 'light', 'asp-empty'],
    };
    const seed = { [PRESETS_KEY]: JSON.stringify(collection), [ACTIVE_KEY]: 'asp-unknown' };

    const { store } = loadStoreWith(seed);
    assert.deepEqual(
        store.getAutoSupportPresets().map((preset) => preset.id),
        ['light', 'medium', 'heavy', 'asp-ok', 'asp-broken', 'asp-nameless'],
    );
    assert.equal(store.getAutoSupportPreset('light')!.settings.areaPerSupportMm2, 8);
    assert.equal(store.getAutoSupportPreset('light')!.name, 'Light');
    assert.equal(store.getAutoSupportPreset('light')!.isBuiltIn, true);
    assert.equal(store.getAutoSupportPreset('asp-ok')!.name, 'Ok');
    assert.equal(store.getAutoSupportPreset('asp-ok')!.settings.areaPerSupportMm2, 12);
    // A record whose settings are unusable keeps its name and gets the default block.
    assert.deepEqual(store.getAutoSupportPreset('asp-broken')!.settings, createDefaultAutoSupportSettings());
    assert.equal(store.getAutoSupportPreset('asp-nameless')!.name, 'Auto-Support Preset');
    // An active id that names nothing is not a selection.
    assert.equal(store.getActiveAutoSupportPresetId(), null);

    const { store: renamed } = loadStoreWith({ ...seed, [ACTIVE_KEY]: 'asp-ok' });
    assert.equal(renamed.getActiveAutoSupportPresetId(), 'asp-ok');
});

test('with no storage at all the store still runs on its built-ins', () => {
    const store = loadStoreWithNoStorage();
    const live = getAutoSupportSettings();

    assert.deepEqual(store.getAutoSupportPresets().map((preset) => preset.id), ['light', 'medium', 'heavy']);
    assert.equal(store.getActiveAutoSupportPresetId(), null);

    const created = store.createAutoSupportPreset('Ephemeral');
    assert.equal(store.getAutoSupportPresets().length, 4);

    store.setActiveAutoSupportPreset('heavy');
    assert.equal(store.getActiveAutoSupportPresetId(), 'heavy');
    assert.equal(getAutoSupportSettings().areaPerSupportMm2, 5);
    assert.equal(store.isAutoSupportPresetDirty(), false);

    store.deleteAutoSupportPreset(created.id);
    assert.deepEqual(store.getAutoSupportPresets().map((preset) => preset.id), ['light', 'medium', 'heavy']);
    assert.ok(live);
});
