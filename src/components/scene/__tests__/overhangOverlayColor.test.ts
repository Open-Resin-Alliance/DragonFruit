import assert from 'node:assert/strict';
import test from 'node:test';

import { overhangRegionColor } from '../IslandOverhangOverlay';

const FORMATION_ORANGE = '#ffa500';

test('a formation overhang keeps the flat orange', () => {
    const c = overhangRegionColor({ steepFlat: false, dragMomentMm3: 900 }, 1000);
    assert.equal(`#${c.getHexString()}`, FORMATION_ORANGE);
    // ...and so does a region from a scan that predates the flag.
    const legacy = overhangRegionColor({ dragMomentMm3: 900 }, 1000);
    assert.equal(`#${legacy.getHexString()}`, FORMATION_ORANGE);
});

test('a topple patch is ramped by the share of the drag moment it carries', () => {
    const hot = overhangRegionColor({ steepFlat: true, dragMomentMm3: 1000 }, 1000);
    const cold = overhangRegionColor({ steepFlat: true, dragMomentMm3: 0 }, 1000);
    const mid = overhangRegionColor({ steepFlat: true, dragMomentMm3: 500 }, 1000);

    // The ramp runs from light amber to saturated orange-red: the share is
    // carried by saturation (green and blue fall), never by brightness — a dim
    // end reads as "the overlay is broken" rather than as "less load here".
    assert.ok(hot.g < cold.g, `hot is more saturated (${hot.g} vs ${cold.g})`);
    assert.ok(hot.g < mid.g && mid.g < cold.g, 'and the ramp is monotone');
    assert.ok(hot.b < cold.b, 'along both channels');
    for (const c of [cold, mid, hot]) {
        assert.ok(c.r > c.g, `orange, not white (${c.r} vs ${c.g})`);
        assert.ok(c.r > 0.9, `and bright enough to read on the model (${c.r})`);
    }
});

test('the ramp survives a scan with no moment at all', () => {
    const c = overhangRegionColor({ steepFlat: true, dragMomentMm3: 0 }, 0);
    assert.ok(Number.isFinite(c.r) && c.r > 0, 'a colour, not NaN');
    // Clamped, so a patch bigger than the normaliser cannot overshoot.
    const clamped = overhangRegionColor({ steepFlat: true, dragMomentMm3: 5000 }, 1000);
    const hot = overhangRegionColor({ steepFlat: true, dragMomentMm3: 1000 }, 1000);
    assert.deepEqual([clamped.r, clamped.g], [hot.r, hot.g]);
});
