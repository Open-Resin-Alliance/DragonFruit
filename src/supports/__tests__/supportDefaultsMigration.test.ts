import assert from 'node:assert/strict';
import test from 'node:test';

import {
    AUTO_SUPPORT_DEFAULT_MIGRATIONS,
    CURRENT_AUTO_SUPPORT_DEFAULTS_VERSION,
    SUPPORT_DEFAULTS_VERSION_KEY,
    applyAutoSupportDefaultMigrations,
    readWrittenDefaultsVersion,
} from '../Settings/defaultMigrations';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import { createDefaultAutoBracingSettings } from '../autoBracing/settings';
import type { AutoSupportSettings } from '../autoSupport/settings';

/**
 * The default-migration table is the record of a shipped auto-support default
 * having moved. These tests hold three things: the entries stay true to the code,
 * the rule moves only values this app shipped, and each load path applies it
 * exactly where it belongs.
 *
 * The last group is the one that matters most. The table once ran against the
 * live `support-settings` block too, using the same "that value is one we
 * shipped, not one the user chose" inference. On a saved studio block that
 * inference is wrong, and the consequence was fatal: the Support Studio could not
 * keep a setting whose value happened to equal a retired default, because the
 * table replaced it on load before the save button was ever reachable.
 */

type MigratableBlock = Partial<AutoSupportSettings>;

/** A localStorage stand-in over a plain map, for the module-load tests. */
function stubbedStorage(entries: Record<string, string>) {
    const storage = new Map<string, string>(Object.entries(entries));
    const globals = globalThis as unknown as { localStorage?: unknown };

    globals.localStorage = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value); },
        removeItem: (key: string) => { storage.delete(key); },
    };
    return storage;
}

test('every migration names a real key and ends on the value the code ships', () => {
    const shipped = createDefaultAutoSupportSettings();

    for (const migration of AUTO_SUPPORT_DEFAULT_MIGRATIONS) {
        const current = shipped[migration.key];
        assert.notEqual(
            current,
            undefined,
            `autoSupport.${String(migration.key)} is not a setting any more: drop the entry`,
        );
        assert.equal(
            current,
            migration.to,
            `autoSupport.${String(migration.key)} ships ${String(current)}, but the table migrates to ${String(migration.to)}`,
        );
        assert.notEqual(
            migration.from,
            migration.to,
            `autoSupport.${String(migration.key)} migrates a value to itself`,
        );
        assert.ok(migration.version > 0, 'a migration belongs to a batch above 0');
        assert.ok(
            migration.version <= CURRENT_AUTO_SUPPORT_DEFAULTS_VERSION,
            'a migration cannot belong to a batch above the current one',
        );
    }
});

test('a shipped default moves to the new one, a chosen value does not', () => {
    const block: MigratableBlock = {
        areaPerSupportMm2: 8, // the shipped default, so it follows the migration
        leafFanMaxAngleDeg: 60, // likewise
        enabled: false, // never a default: it is the user's, and stays
        sizeScale: 1.2, // never a default either
    };

    const migrated = applyAutoSupportDefaultMigrations(block, 0);

    assert.equal(migrated?.areaPerSupportMm2, 10);
    assert.equal(migrated?.leafFanMaxAngleDeg, 45);
    assert.equal(migrated?.enabled, false);
    assert.equal(migrated?.sizeScale, 1.2);
});

test('a block written at the current batch is left exactly as it was', () => {
    const block: MigratableBlock = { areaPerSupportMm2: 8, leafFanMaxAngleDeg: 60 };

    const migrated = applyAutoSupportDefaultMigrations(block, CURRENT_AUTO_SUPPORT_DEFAULTS_VERSION);

    assert.equal(migrated, block, 'a current block is returned by identity, not rewritten');
});

test('a key the profile states itself is never migrated', () => {
    const block: MigratableBlock = { areaPerSupportMm2: 8 };

    const migrated = applyAutoSupportDefaultMigrations(block, 0, { skip: new Set(['areaPerSupportMm2']) });

    assert.equal(migrated?.areaPerSupportMm2, 8, 'a stated value is a design decision');
});

test('migrating copies: the caller’s block is never mutated', () => {
    const block: MigratableBlock = { areaPerSupportMm2: 8 };
    const before = JSON.stringify(block);

    applyAutoSupportDefaultMigrations(block, 0);

    assert.equal(JSON.stringify(block), before, 'the input block must survive untouched');
});

test('the version read off a blob defaults to 0 when it is missing or malformed', () => {
    assert.equal(readWrittenDefaultsVersion(null), 0);
    assert.equal(readWrittenDefaultsVersion({}), 0, 'a blob from before versioning gets every entry');
    assert.equal(readWrittenDefaultsVersion({ [SUPPORT_DEFAULTS_VERSION_KEY]: 'one' }), 0);
    assert.equal(readWrittenDefaultsVersion({ [SUPPORT_DEFAULTS_VERSION_KEY]: 1 }), 1);
});

test('a saved studio block loads exactly as it was written, retired default-values included', async () => {
    // `areaPerSupportMm2: 8`, `braceDiameterMm: 0.7` and `patternIntervalMm: 10`
    // are all values this app shipped and then retired. As studio settings they
    // are the user's, and the stale batch field is what an install that ran the
    // over-reaching build left behind.
    const storage = stubbedStorage({
        'support-settings': JSON.stringify({
            tip: { contactDiameterMm: 0.31, lengthMm: 3.5 },
            shaft: { diameterMm: 1.7, secondaryDiameterMm: 1.7 },
            roots: { diameterMm: 2.9 },
            autoSupport: { areaPerSupportMm2: 8, leafFanMaxAngleDeg: 60, leafFanRadiusMm: 5 },
            autoBracing: { braceDiameterMm: 0.7, patternIntervalMm: 10, initialPattern: 'singleDiagonal' },
            [SUPPORT_DEFAULTS_VERSION_KEY]: 2,
        }),
    });

    // Dynamic import on purpose: the settings store reads storage while it is
    // being evaluated, so the stub has to be in place before the module loads.
    const { getSettings, saveSettingsToLocalStorage } = await import('../Settings/state');
    const settings = getSettings();

    assert.equal(settings.tip.contactDiameterMm, 0.31, 'a studio field the user set survives');
    assert.equal(settings.shaft.diameterMm, 1.7, 'so does the next one');
    assert.equal(settings.roots.diameterMm, 2.9, 'and the next');
    assert.equal(settings.autoSupport.areaPerSupportMm2, 8, 'a retired auto-support default is still the user’s');
    assert.equal(settings.autoSupport.leafFanMaxAngleDeg, 60, 'and so is the angle beside it');
    assert.equal(settings.autoBracing.braceDiameterMm, 0.7, 'the bracing block is never migrated');
    assert.equal(settings.autoBracing.patternIntervalMm, 10, 'nor its interval');
    assert.equal(settings.autoBracing.initialPattern, 'singleDiagonal', 'nor its pattern');
    // The one value that does move is the constraint floor raising it, which is
    // the clamp doing its job rather than a table reading intent.
    assert.equal(settings.autoSupport.leafFanRadiusMm, 8, 'the floor still raises 5');
    assert.ok(
        !(SUPPORT_DEFAULTS_VERSION_KEY in (settings as unknown as Record<string, unknown>)),
        'the stale batch is not a setting and must not ride into the live block',
    );

    saveSettingsToLocalStorage();
    const written = JSON.parse(storage.get('support-settings') ?? '{}') as Record<string, unknown>;
    assert.equal(
        written[SUPPORT_DEFAULTS_VERSION_KEY],
        undefined,
        'the studio blob carries no defaults batch to be read back',
    );
    assert.equal(
        (written.autoSupport as Record<string, unknown>).areaPerSupportMm2,
        8,
        'what the user had is what lands back in storage',
    );
});

test('the preset load path migrates a factory preset’s auto-support block, and leaves a user’s own alone', async () => {
    // Stored copies from before the sizing defaults changed, exactly what a
    // preview install carries: a factory preset that inherits its values, a factory
    // preset that states its own density, and a preset the user made.
    const staleAutoSupport = { ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 8, leafFanMaxAngleDeg: 60 };
    const staleBracing = { ...createDefaultAutoBracingSettings(), braceDiameterMm: 0.7, patternIntervalMm: 10 };
    stubbedStorage({
        'support-presets-v1': JSON.stringify({
            byId: {
                structure: {
                    id: 'structure',
                    name: 'Structure',
                    isBuiltIn: false,
                    pinnedSlot: 2,
                    settings: {
                        autoSupport: staleAutoSupport,
                        autoBracing: staleBracing,
                        roots: { diameterMm: 3.5 },
                    },
                },
                // `detail` states its own density, so a stored 8 is its design, not
                // an old default. Its bracing is not a shipped auto-support profile
                // at all, so the table must not touch it either.
                detail: {
                    id: 'detail',
                    name: 'Detail',
                    isBuiltIn: false,
                    settings: {
                        autoSupport: { areaPerSupportMm2: 8, leafFanMaxAngleDeg: 60 },
                        autoBracing: { ...staleBracing },
                    },
                },
                'custom-mine': {
                    id: 'custom-mine',
                    name: 'Mine',
                    isBuiltIn: false,
                    settings: {
                        autoSupport: { ...staleAutoSupport },
                        autoBracing: { ...staleBracing },
                    },
                },
            },
            allIds: ['structure', 'custom-mine'],
            activePresetId: 'structure',
        }),
    });
    // `presets.ts` reads through `window`, and a preset test has no DOM. The
    // dynamic import is the module-load boundary the stub has to precede.
    Object.assign(globalThis, { window: {} });

    const { getPresetById } = await import('../Settings/presets');
    const structure = getPresetById('structure');
    const detail = getPresetById('detail');
    const mine = getPresetById('custom-mine');

    assert.ok(structure && detail && mine, 'every preset is still there');

    // `structure` inherits its auto-support values, so they follow the table. Its
    // bracing and root diameter are not auto-support defaults and stay put.
    assert.equal(structure.settings.autoSupport.areaPerSupportMm2, 10, 'the inherited density followed the default');
    assert.equal(structure.settings.autoSupport.leafFanMaxAngleDeg, 45, 'so did the inherited angle');
    assert.equal(structure.settings.autoBracing.braceDiameterMm, 0.7, 'the bracing block is out of scope');
    assert.equal(structure.settings.autoBracing.patternIntervalMm, 10, 'the whole bracing block is out of scope');
    assert.equal(structure.settings.roots.diameterMm, 3.5, 'a customized value inside the factory preset is kept');
    assert.equal(structure.pinnedSlot, 2, 'arrangement is the user’s, not the migration’s');

    // `detail` states its density, so a stored 8 is its design; the angle is
    // inherited, so it follows.
    assert.equal(detail.settings.autoSupport.areaPerSupportMm2, 8, 'a density the preset states itself must survive the table');
    assert.equal(detail.settings.autoSupport.leafFanMaxAngleDeg, 45, 'an inherited angle still follows');
    assert.equal(detail.settings.autoBracing.braceDiameterMm, 0.7, 'a stated density does not unlock the bracing block');

    // A preset the user made is their artifact: its block is what they configured,
    // so the table does not reach into it even though the values are old defaults.
    assert.equal(mine.settings.autoSupport.areaPerSupportMm2, 8, 'a user preset is not migrated');
    assert.equal(mine.settings.autoSupport.leafFanMaxAngleDeg, 60, 'a user preset keeps its angle');
    assert.equal(mine.settings.autoBracing.braceDiameterMm, 0.7, 'a user preset keeps its brace diameter');
});