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

test('switching the active trunk preset never touches auto-support settings', () => {
    // Decoupled: trunk presets are sizing/geometry profiles. Auto-support
    // density is owned by the Auto Support panel; a custom density must
    // survive any preset switch (dropdown, hotkeys, quick-select activation).
    // 7 mm² sits between every built-in tier (5/10/16).
    updateAutoSupportSettings({ ...createDefaultAutoSupportSettings(), areaPerSupportMm2: 7 });

    setActivePreset('anchor');
    assert.equal(getSettings().autoSupport.areaPerSupportMm2, 7, 'custom density survives anchor');

    setActivePreset('detail');
    assert.equal(getSettings().autoSupport.areaPerSupportMm2, 7, 'custom density survives detail');

    setActivePreset('structure');
    assert.equal(getSettings().autoSupport.areaPerSupportMm2, 7, 'custom density survives structure');
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
