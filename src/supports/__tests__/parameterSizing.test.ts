import assert from 'node:assert/strict';
import test from 'node:test';

import {
    sizeParameters,
    presetForArea,
    activeSizingBand,
    resolvedSizingBandsForRun,
    setResolvedSizingBands,
    HEIGHT_REFERENCE_MM,
} from '../autoSupport/parameterSizing';
import type { ModelSizingContext } from '../autoSupport/parameterSizing';
import { setSettings, getSettings, updateAutoSupportSettings } from '../Settings/state';
import { createPreset, deletePreset, getPresetById } from '../Settings/presets';
import { createDefaultSettings } from '../Settings/types';
import type { CandidatePoint } from '../autoSupport/types';
import { AUTO_SUPPORT_CONSTRAINTS, SIZING_BANDS } from '../autoSupport/settings';
import type { AutoSupportSettings, SizingBand } from '../autoSupport/settings';

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

/**
 * Pin the run's sizing tier for one case. The band is borrowed from a Support
 * Studio preset now, so a factory band is that preset's id.
 */
function withTier<T>(id: string, fn: () => T): T {
    const prev = getSettings().autoSupport;
    updateAutoSupportSettings({ sizingPreset: id });
    try {
        return fn();
    } finally {
        updateAutoSupportSettings({ ...prev });
    }
}

/**
 * A Support Studio preset carrying `band`: a preset IS its tip, shaft and roots,
 * so the profile fields are written to the band's numbers and a preset is created
 * from them. Returns the preset, so a caller can name its id.
 */
function createPresetWithBand(band: SizingBand, name = 'test band') {
    const settings = getSettings();
    setSettings({
        ...settings,
        tip: {
            ...settings.tip,
            contactDiameterMm: band.tipContactDiameterMm,
            lengthMm: band.tipLengthMm,
            penetrationMm: band.tipPenetrationMm,
        },
        shaft: { ...settings.shaft, diameterMm: band.shaftDiameterMm },
        roots: {
            ...settings.roots,
            diameterMm: band.rootDiameterMm,
            diskHeightMm: band.rootDiskHeightMm,
            coneHeightMm: band.rootConeHeightMm,
        },
    });
    return createPreset(name);
}

/** Pin a band no factory preset ships, restoring everything after. */
function withBand<T>(band: SizingBand, fn: () => T): T {
    const prevAutoSupport = getSettings().autoSupport;
    const prevSettings = getSettings();
    const created = createPresetWithBand(band);
    updateAutoSupportSettings({ sizingPreset: created.id });
    try {
        return fn();
    } finally {
        deletePreset(created.id);
        setSettings(prevSettings);
        updateAutoSupportSettings({ ...prevAutoSupport });
    }
}

/** Apply one `autoSupport` patch for the duration of a case, restoring after. */
function withAutoSupport<T>(patch: Partial<AutoSupportSettings>, fn: () => T): T {
    const prev = getSettings().autoSupport;
    updateAutoSupportSettings(patch);
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

test('density-grid cell sits FLAT at the active band', () => {
    withTier('anchor', () => {
        const s = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }));
        assert.equal(s.shaftDiameterMm, 1.4, 'a cell reads exactly the tier band — not the cell area');
        assert.equal(s.rootsDiameterMm, 2.3);
        // The 30%-of-shaft floor binds at factory band ratios (0.4 < 1.4/3).
        assert.ok(Math.abs(s.tipContactDiameterMm! - 0.42) < 1e-9,
            `flat ceiling contact floored at 30% of shaft (${s.tipContactDiameterMm})`);
    });
});

test('the band follows the hardcoded factory bands (detail < structure < anchor)', () => {
    // The regression: the old area-derived curve sized a light 16 mm² cell
    // THICKER than a heavy 5 mm² cell. The band must come from the block.
    const shaftAt = (tier: string) => withTier(tier, () => (
        sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 })).shaftDiameterMm!
    ));
    assert.equal(shaftAt('detail'), 0.8, 'the factory detail preset');
    assert.equal(shaftAt('structure'), 1.0, 'the factory structure preset');
    assert.equal(shaftAt('anchor'), 1.4, 'the factory anchor preset');
});

test('a custom band sizes the run (the band is the block, not a tier lookup)', () => {
    // A band no factory preset ships. Nothing in the engine may fall back to a
    // tier's numbers, so the same candidate has to size from these seven.
    const thinBand: SizingBand = {
        ...SIZING_BANDS.structure,
        shaftDiameterMm: 0.45,
        tipContactDiameterMm: 0.12,
        rootDiameterMm: 1.2,
    };
    const fatBand: SizingBand = {
        ...SIZING_BANDS.structure,
        shaftDiameterMm: 1.8,
        tipContactDiameterMm: 0.7,
        rootDiameterMm: 2.6,
    };
    const candidate = makeCandidate({ islandAreaMm2: 8, zHeight: 10 });
    const at = (band: SizingBand) => withBand(band, () => sizeParameters(candidate)!);

    const defaulted = withTier('structure', () => sizeParameters(candidate)!);
    const thin = at(thinBand);
    const fat = at(fatBand);

    assert.equal(thin.shaftDiameterMm, 0.45, "the shaft is the block's own number");
    assert.equal(thin.rootsDiameterMm, 1.2, 'the pad too');
    // A 0.45 mm shaft's 30% floor would be 0.135, and the band's own contact
    // 0.12 — both below the 0.22 mm minimum a run may print, which binds here.
    assert.ok(Math.abs(thin.tipContactDiameterMm! - 0.22) < 1e-9,
        `tip floors at the 0.22 mm minimum on a thin custom shaft (${thin.tipContactDiameterMm})`);

    assert.ok(thin.shaftDiameterMm! < defaulted.shaftDiameterMm!, 'a smaller band sizes thinner');
    assert.ok(thin.tipContactDiameterMm! < defaulted.tipContactDiameterMm!, 'and with a smaller tip');
    assert.ok(fat.shaftDiameterMm! > defaulted.shaftDiameterMm!, 'a larger band sizes thicker');
    assert.equal(fat.tipContactDiameterMm, 0.7, 'a tip band above the 30% floor is taken as written');
    assert.ok(fat.rootsDiameterMm! > defaulted.rootsDiameterMm!, 'and the pad with it');
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
            'sizing reads the auto-support band, not the global preset');
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

test('taller supports are thicker, floored at the band and capped', () => {
    const band = activeSizingBand().shaftDiameterMm;
    const at = (zHeight: number) => sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight })).shaftDiameterMm!;
    // At or below the reference the support is exactly at its band — a short
    // support is never thinned by the height term.
    assert.equal(at(10), band, 'below the height reference: band');
    assert.equal(at(HEIGHT_REFERENCE_MM), band, 'at the height reference: band');
    assert.ok(at(90) > at(40), 'longer → thicker');
    assert.ok(at(90) <= band * AUTO_SUPPORT_CONSTRAINTS.heightFactorCap.defaultValue + 1e-9, 'height cap holds');
    assert.equal(at(90), at(400), 'saturates at the cap');
});

test('a bigger print gets thicker trunks than a small one', () => {
    const ctx = (modelSizeMm: number): ModelSizingContext => ({
        modelVolumeMm3: 27000, totalCandidates: 100, modelSizeMm,
    });
    const candidate = makeCandidate({ islandAreaMm2: 8, zHeight: 40 });
    const mini = sizeParameters(candidate, 1, ctx(40))!;
    const mid = sizeParameters(candidate, 1, ctx(150))!;
    const large = sizeParameters(candidate, 1, ctx(400))!;
    assert.deepEqual(mini, sizeParameters(candidate), 'a mini is the band, exactly');
    assert.ok(mid.shaftDiameterMm! > mini.shaftDiameterMm!, 'mid-size model is thicker');
    assert.ok(large.shaftDiameterMm! > mid.shaftDiameterMm!, 'larger model is thicker again');
    assert.ok(
        large.shaftDiameterMm! <= mini.shaftDiameterMm! * AUTO_SUPPORT_CONSTRAINTS.modelSizeFactorCap.defaultValue * AUTO_SUPPORT_CONSTRAINTS.modelLoadFactorCap.defaultValue + 1e-9,
        'the factors bound the growth',
    );
    assert.ok(large.rootsDiameterMm! > mini.rootsDiameterMm!, 'the pad scales with the trunk');
    assert.ok(large.tipContactDiameterMm! > mini.tipContactDiameterMm!, 'the tip floor rides the shaft');
});

test('a heavy share per support thickens, an easy one does not', () => {
    const candidate = makeCandidate({ islandAreaMm2: 8, zHeight: 10 });
    const share = (totalCandidates: number) => sizeParameters(candidate, 1, {
        modelVolumeMm3: 400000, totalCandidates, modelSizeMm: 60,
    })!;
    // 440 g over 4000 supports = 0.11 g each: below the reference, at band.
    assert.equal(share(4000).shaftDiameterMm, sizeParameters(candidate).shaftDiameterMm, 'easy share: band');
    assert.ok(share(400).shaftDiameterMm! > share(4000).shaftDiameterMm!, 'more mass each → thicker');
    assert.ok(share(20).shaftDiameterMm! <= 1.0 * AUTO_SUPPORT_CONSTRAINTS.modelLoadFactorCap.defaultValue + 1e-9, 'share cap holds');
});

test('sizing without a model context is exactly the band', () => {
    // Short support, no context: no height term, no model terms.
    const s = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }));
    assert.equal(s.shaftDiameterMm, activeSizingBand().shaftDiameterMm,
        'no context = no model factors: manual paths and existing callers are untouched');
    assert.equal(s.rootsDiameterMm, activeSizingBand().rootDiameterMm, 'roots too');
});

test('tip contact never drops below 30% of the shaft', () => {
    // At factory band ratios the 30% floor binds before the angle factor
    // differentiates — the floor is the guarantee that matters.
    withBand(SIZING_BANDS.structure, () => {
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

test('per-point tip override bypasses band and floor', () => {
    // Explicit 0.22 tip on a structure shaft: kept as-is even though the
    // 30%-of-shaft floor (0.3) and the band contact (0.28) both exceed it.
    const s = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10, tipDiameterMm: 0.22 }));
    assert.equal(s.tipContactDiameterMm, 0.22, 'explicit tip wins over band and floor');
    assert.equal(s.tipBodyDiameterMm, s.shaftDiameterMm, 'shaft untouched by the tip override');
});

test('absent override keeps band × angle with floor', () => {
    const s = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }));
    assert.ok(s.tipContactDiameterMm! >= s.shaftDiameterMm! * 0.3 - 1e-9, 'floor holds without override');
});

// ---------------------------------------------------------------------------
// The advanced-calibration keys are READ, not decorative: each test below
// changes exactly one `autoSupport` setting and shows the sized geometry move.
// ---------------------------------------------------------------------------

test('modelSizeFactorCap bounds the size factor', () => {
    // Big model, no load share, height at band: the only live factor is size,
    // which the default cap 1.45 pins; at cap 1.0 it collapses to the band.
    const ctx: ModelSizingContext = { modelVolumeMm3: 27000, totalCandidates: 100, modelSizeMm: 400 };
    const candidate = makeCandidate({ islandAreaMm2: 0.001, zHeight: 10 });
    const band = activeSizingBand().shaftDiameterMm;

    const defaulted = sizeParameters(candidate, 1, ctx)!;
    assert.equal(defaulted.shaftDiameterMm, band * AUTO_SUPPORT_CONSTRAINTS.modelSizeFactorCap.defaultValue,
        'default cap 1.45 is the sized size factor');

    const capped = withAutoSupport({ modelSizeFactorCap: 1.0 }, () => sizeParameters(candidate, 1, ctx)!);
    assert.equal(capped.shaftDiameterMm, band, 'cap 1.0 removes the size factor entirely');
    assert.ok(capped.shaftDiameterMm! < defaulted.shaftDiameterMm!, 'lowering the cap thins the trunk');
});

test('modelLoadFactorCap bounds the load factor', () => {
    // Model at the size reference (size factor ×1) but a heavy load share:
    // the default cap 1.3 pins the load factor; at cap 1.0 it collapses.
    const ctx: ModelSizingContext = { modelVolumeMm3: 400000, totalCandidates: 20, modelSizeMm: 60 };
    const candidate = makeCandidate({ islandAreaMm2: 0.001, zHeight: 10 });
    const band = activeSizingBand().shaftDiameterMm;

    const defaulted = sizeParameters(candidate, 1, ctx)!;
    assert.equal(defaulted.shaftDiameterMm, band * AUTO_SUPPORT_CONSTRAINTS.modelLoadFactorCap.defaultValue,
        'default cap 1.3 is the sized load factor');

    const capped = withAutoSupport({ modelLoadFactorCap: 1.0 }, () => sizeParameters(candidate, 1, ctx)!);
    assert.equal(capped.shaftDiameterMm, band, 'cap 1.0 removes the load factor entirely');
    assert.ok(capped.shaftDiameterMm! < defaulted.shaftDiameterMm!, 'lowering the cap thins the trunk');
});

test('heightFactorCap bounds the height factor', () => {
    // A tall support saturates the height term; cap 1.0 pins it to the band.
    const candidate = makeCandidate({ islandAreaMm2: 0.001, zHeight: 400 });
    const band = activeSizingBand().shaftDiameterMm;

    const defaulted = sizeParameters(candidate)!;
    assert.equal(defaulted.shaftDiameterMm, band * AUTO_SUPPORT_CONSTRAINTS.heightFactorCap.defaultValue,
        'default cap 1.35 is the saturated height factor');

    const capped = withAutoSupport({ heightFactorCap: 1.0 }, () => sizeParameters(candidate)!);
    assert.equal(capped.shaftDiameterMm, band, 'cap 1.0 removes the height factor entirely');
    assert.ok(capped.shaftDiameterMm! < defaulted.shaftDiameterMm!, 'lowering the cap thins the trunk');
});

test('modelScaleEnabled off pins every model factor to ×1', () => {
    // Every input is past its reference, so an enabled run would scale both
    // the trunk (size × load) and the pad, and thicken on height.
    const ctx: ModelSizingContext = { modelVolumeMm3: 400000, totalCandidates: 20, modelSizeMm: 400 };
    const candidate = makeCandidate({ islandAreaMm2: 0.001, zHeight: 400 });
    const band = activeSizingBand();

    const enabled = sizeParameters(candidate, 1, ctx)!;
    assert.ok(enabled.shaftDiameterMm! > band.shaftDiameterMm, 'enabled run scales past the band');
    assert.ok(enabled.rootsDiameterMm! > band.rootDiameterMm, 'enabled run scales the pad');

    const disabled = withAutoSupport({ modelScaleEnabled: false }, () => sizeParameters(candidate, 1, ctx)!);
    assert.equal(disabled.shaftDiameterMm, band.shaftDiameterMm, 'off = height × size × load all ×1');
    assert.equal(disabled.rootsDiameterMm, band.rootDiameterMm, 'off leaves the pad at band too');
});

test('a run naming a custom Support Studio preset sizes with its numbers, not the fallback', () => {
    // The shape of a worker run: the main thread can reach the preset table and
    // resolves every band the run may name; the worker has no storage at all, so
    // the id resolves to nothing there. The handed band has to win.
    const custom: SizingBand = {
        ...SIZING_BANDS.structure,
        shaftDiameterMm: 0.45,
        tipContactDiameterMm: 0.12,
        rootDiameterMm: 1.2,
    };
    const created = createPresetWithBand(custom, 'my custom tier');
    const handed = resolvedSizingBandsForRun(created.id);
    // The run's block names it, then the preset goes away: exactly what the worker
    // sees, where the id resolves to nothing.
    updateAutoSupportSettings({ sizingPreset: created.id });
    deletePreset(created.id);
    assert.equal(getPresetById(created.id), undefined, 'the worker cannot see this preset');

    setResolvedSizingBands(handed);
    try {
        assert.equal(activeSizingBand().shaftDiameterMm, 0.45, 'the handed band, not the structure fallback');
        const sized = sizeParameters(makeCandidate({ islandAreaMm2: 8, zHeight: 10 }))!;
        assert.equal(sized.shaftDiameterMm, 0.45, "the run sizes with the user's own preset");
        assert.equal(sized.rootsDiameterMm, 1.2, 'and its roots');
        assert.ok(Math.abs(sized.tipContactDiameterMm! - 0.22) < 1e-9,
            `and its tip, floored at the 0.22 mm minimum (${sized.tipContactDiameterMm})`);
    } finally {
        setResolvedSizingBands(null);
        updateAutoSupportSettings({ sizingPreset: 'structure' });
    }

    // Without the handover the same id is the documented factory fallback.
    updateAutoSupportSettings({ sizingPreset: created.id });
    assert.equal(activeSizingBand().shaftDiameterMm, 1.0, 'an unresolvable id falls back to structure');
    updateAutoSupportSettings({ sizingPreset: 'structure' });
});

test('the three model factors together are capped at the documented 1.85', () => {
    const band = activeSizingBand().shaftDiameterMm;
    const candidate = makeCandidate({ islandAreaMm2: 8, zHeight: 100 });
    // Large part (size cap 1.45), heavy share (load cap 1.3) and a tall
    // support (height cap 1.35): 2.54 if multiplied freely.
    const ctx: ModelSizingContext = { modelVolumeMm3: 400000, totalCandidates: 20, modelSizeMm: 400 };
    const sized = sizeParameters(candidate, 1, ctx)!;
    assert.ok(sized.shaftDiameterMm! <= band * 1.85 + 1e-9,
        `combined factor caps at 1.85 (got ${sized.shaftDiameterMm})`);
    assert.ok(sized.shaftDiameterMm! > band * 1.5, 'and the scaled end still grows');
});
