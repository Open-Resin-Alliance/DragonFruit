import assert from 'node:assert/strict';
import test from 'node:test';

import { sizeParameters, presetForArea, activeSizingBand } from '../autoSupport/parameterSizing';
import { setSettings, getSettings, updateAutoSupportSettings } from '../Settings/state';
import { createDefaultSettings } from '../Settings/types';
import type { CandidatePoint } from '../autoSupport/types';
import type { AutoSupportSettings } from '../autoSupport/settings';

function makeCandidate(over: Partial<CandidatePoint> = {}): CandidatePoint {
    return {
        id: 'c',
        tipPos: { x: 0, y: 0, z: 10 },
        tipNormal: { x: 0, y: 0, z: -1 },
        modelId: 'm',
        source: 'voxel',
        islandAreaMm2: 0.1,
        zHeight: 10,
        priority: 0,
        ...over,
    };
}

/** Switch the auto-support sizing tier (as the panel quick-select would)
 *  and restore after. Sizing deliberately ignores the global shaft/tip/roots
 *  — trunk presets are for manual placement. */
function withTier<T>(tier: 'detail' | 'structure' | 'anchor', fn: () => T): T {
    const prev = getSettings().autoSupport;
    updateAutoSupportSettings({ sizingPreset: tier } as Partial<AutoSupportSettings>);
    try {
        return fn();
    } finally {
        updateAutoSupportSettings({ ...prev });
    }
}

test('presetForArea maps the empirical bands', () => {
    assert.equal(presetForArea(0.1), 'detail');
    assert.equal(presetForArea(0.15), 'detail');
    assert.equal(presetForArea(0.3), 'structure');
    assert.equal(presetForArea(0.5), 'structure');
    assert.equal(presetForArea(1), 'anchor');
    assert.equal(presetForArea(8), 'anchor');
});

test('density-grid cell sits FLAT at the active sizing tier', () => {
    withTier('anchor', () => {
        const s = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }));
        assert.equal(s.shaftDiameterMm, 1.4, 'a cell reads exactly the tier band — not the cell area');
        assert.equal(s.rootsDiameterMm, 2.3);
        // The 30%-of-shaft floor binds at factory band ratios (0.4 < 1.4/3).
        assert.ok(Math.abs(s.tipContactDiameterMm! - 0.42) < 1e-9,
            `flat ceiling contact floored at 30% of shaft (${s.tipContactDiameterMm})`);
    });
});

test('the band follows the hardcoded tier (detail < structure < anchor)', () => {
    // The regression: the old area-derived curve sized a light 16 mm² cell
    // THICKER than a heavy 5 mm² cell. The band must come from the tier.
    const shaftAt = (tier: 'detail' | 'structure' | 'anchor') => withTier(tier, () => (
        sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 })).shaftDiameterMm!
    ));
    assert.equal(shaftAt('detail'), 0.8, 'detail tier band');
    assert.equal(shaftAt('structure'), 1.0, 'structure tier band');
    assert.equal(shaftAt('anchor'), 1.4, 'anchor tier band');
});

test('sizing ignores the global shaft/tip bands (trunk presets are manual-only)', () => {
    // Selecting a thin manual preset must not thin the next auto run.
    const prev = getSettings();
    const defaults = createDefaultSettings();
    setSettings({
        ...defaults,
        shaft: { ...defaults.shaft, diameterMm: 0.5 },
        tip: { ...defaults.tip, contactDiameterMm: 0.1 },
    });
    try {
        const s = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }));
        assert.equal(s.shaftDiameterMm, activeSizingBand().shaftDiameterMm,
            'sizing reads the auto-support tier, not the global preset');
    } finally {
        setSettings(prev);
    }
});

test('shafts never go below the active band', () => {
    const s = sizeParameters(makeCandidate({ islandAreaMm2: 0.001, zHeight: 10 }));
    assert.equal(s.shaftDiameterMm, 1.0, 'floor = the active (default) band');
});

test('big islands extend beyond the band on the log tail', () => {
    const shaftAt = (areaMm2: number) => sizeParameters(makeCandidate({ islandAreaMm2: areaMm2, zHeight: 10 })).shaftDiameterMm!;
    assert.ok(shaftAt(100) > 1.0, `100 mm² island is thicker than the band (${shaftAt(100)})`);
    assert.ok(Math.abs(shaftAt(100) - 1.152) < 0.01, `100 mm² → ~1.152 (${shaftAt(100)})`);
    // The halved slope keeps the tail below the anchor girth at realistic sizes:
    // 0.06·ln(area/8) crosses ×1.25 only beyond ~516 mm².
    assert.ok(shaftAt(100) < 1.25, 'tail stays under the anchor girth at 100 mm²');
    assert.ok(shaftAt(10000) <= 2.0, 'tail caps at 2.0');
});

test('taller supports are mildly thicker (capped +25%)', () => {
    const low = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }))!;
    const high = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 90 }))!;
    assert.ok(high.shaftDiameterMm! > low.shaftDiameterMm!, 'taller → thicker');
    assert.ok(high.shaftDiameterMm! <= 1.0 * 1.25 + 1e-9, 'height cap holds');
});

test('tip contact never drops below 30% of the shaft', () => {
    // At factory band ratios the 30% floor binds before the angle factor
    // differentiates — the floor is the guarantee that matters.
    withTier('structure', () => {
        const flat = sizeParameters(makeCandidate({ islandAreaMm2: 8, tipNormal: { x: 0, y: 0, z: -1 } }))!;
        const slope = sizeParameters(makeCandidate({
            islandAreaMm2: 8,
            tipNormal: { x: 0, y: -0.5, z: -0.866 }, // 30° from straight-down
        }))!;
        assert.ok(Math.abs(flat.tipContactDiameterMm! - 0.3) < 1e-9,
            `flat contact at the floor (${flat.tipContactDiameterMm})`);
        assert.ok(Math.abs(slope.tipContactDiameterMm! - 0.3) < 1e-9,
            `slope contact floored identically (${slope.tipContactDiameterMm})`);
        assert.ok(slope.tipContactDiameterMm! >= 1.0 * 0.3 - 1e-9, 'floor = 30% of shaft');
    });
});

test('size scale multiplies the bands', () => {
    const base = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }))!;
    const scaled = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }), 1.5)!;
    assert.ok(Math.abs(scaled.shaftDiameterMm! - base.shaftDiameterMm! * 1.5) < 1e-9, 'shaft scales');
    assert.ok(Math.abs(scaled.rootsDiameterMm! - base.rootsDiameterMm! * 1.5) < 1e-9, 'roots scale');
});

test('sizing is deterministic', () => {
    const a = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 25, tipNormal: { x: 0.2, y: 0.3, z: -0.93 } }));
    const b = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 25, tipNormal: { x: 0.2, y: 0.3, z: -0.93 } }));
    assert.deepEqual(a, b);
});
