import assert from 'node:assert/strict';
import test from 'node:test';

import { DETAIL_PRESET, STRUCTURE_PRESET, ANCHOR_PRESET, setActivePreset } from '../Settings/presets';
import { getSettings, updateAutoSupportSettings } from '../Settings/state';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import type { AutoSupportSettings } from '../autoSupport/settings';

test('built-in presets carry distinct density tiers (Auto Support panel light/medium/heavy)', () => {
    assert.equal(DETAIL_PRESET.settings.autoSupport.areaPerSupportMm2, 16, 'detail = light tier');
    assert.equal(STRUCTURE_PRESET.settings.autoSupport.areaPerSupportMm2, 10, 'structure = medium tier');
    assert.equal(ANCHOR_PRESET.settings.autoSupport.areaPerSupportMm2, 5, 'anchor = heavy tier');
});

test('preset density is the only autoSupport difference (geometry band stays)', () => {
    // The sizing bands are driven by the preset shaft/tip values, not the
    // density — check the preset shaft progression still holds.
    assert.ok(DETAIL_PRESET.settings.shaft.diameterMm < STRUCTURE_PRESET.settings.shaft.diameterMm);
    assert.ok(STRUCTURE_PRESET.settings.shaft.diameterMm < ANCHOR_PRESET.settings.shaft.diameterMm);
});

/**
 * `setActivePreset` persists through the global `localStorage`, which Node does
 * not provide. Without a stand-in every call lands in the settings store's catch
 * and logs "[SettingsStore] Failed to save": the run looks broken while passing,
 * and the persistence path is never actually exercised. An in-memory store fixes
 * both — the writes happen for real and can be asserted on.
 */
function installMemoryLocalStorage(): Map<string, string> {
    const store = new Map<string, string>();
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

function removeMemoryLocalStorage(): void {
    delete (globalThis as { localStorage?: unknown }).localStorage;
}

test('switching the active trunk preset never touches auto-support settings', () => {
    // Decoupled: trunk presets are sizing/geometry profiles. Auto-support
    // density is owned by the Auto Support panel; a custom density must
    // survive any preset switch (dropdown, hotkeys, quick-select activation).
    // 7 mm² sits between every built-in tier (5/10/16).
    const persisted = installMemoryLocalStorage();
    try {
        updateAutoSupportSettings({ ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 7 });

        setActivePreset('anchor');
        assert.equal(getSettings().autoSupport.areaPerSupportMm2, 7, 'custom density survives anchor');

        setActivePreset('detail');
        assert.equal(getSettings().autoSupport.areaPerSupportMm2, 7, 'custom density survives detail');

        setActivePreset('structure');
        assert.equal(getSettings().autoSupport.areaPerSupportMm2, 7, 'custom density survives structure');

        // The saved copy must carry the custom density too — an in-memory-only
        // survival would come back as the preset default on the next startup.
        // Asserted through the written value rather than the key name, which the
        // settings store keeps private.
        assert.equal(persisted.size, 1, 'expected the settings store to persist under exactly one key');
        const [saved] = [...persisted.values()];
        assert.equal(
            (JSON.parse(saved) as { autoSupport: AutoSupportSettings }).autoSupport.areaPerSupportMm2,
            7,
            'persisted settings keep the custom density',
        );
    } finally {
        removeMemoryLocalStorage();
    }
});

test('preset autoSupport blocks equal defaults except the density (quick-select determinism)', () => {
    // The panel quick-select applies the FULL preset autoSupport block, so a
    // preset must differ from the defaults ONLY in areaPerSupportMm2 —
    // otherwise selecting medium after a load wouldn't reproduce the built-in
    // medium (the stale-keys bug: "default medium" ≠ round-tripped medium).
    const defaults = createDefaultAutoSupportSettings();
    const cases: Array<[typeof STRUCTURE_PRESET, number]> = [
        [DETAIL_PRESET, 16],
        [STRUCTURE_PRESET, 10],
        [ANCHOR_PRESET, 5],
    ];
    const tiers: Record<string, string> = { detail: 'detail', structure: 'structure', anchor: 'anchor' };
    for (const [preset, area] of cases) {
        const block = preset.settings.autoSupport;
        for (const key of Object.keys(defaults) as Array<keyof AutoSupportSettings>) {
            if (key === 'areaPerSupportMm2') {
                assert.equal(block.areaPerSupportMm2, area, `${preset.id} density`);
            } else if (key === 'sizingPreset') {
                assert.equal(block.sizingPreset, tiers[preset.id], `${preset.id} sizing tier`);
            } else {
                assert.equal(block[key], defaults[key], `${key} matches defaults for ${preset.id}`);
            }
        }
    }
});
