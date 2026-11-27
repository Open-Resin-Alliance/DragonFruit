import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createDefaultSettings,
    mergeSettingsWithDefaults,
    type NormalSynthesisPreset,
    type SupportSettings,
} from '../Settings/types';
import {
    getSettings,
    loadSettingsFromLocalStorage,
    saveSettingsToLocalStorage,
    setSettings,
    subscribeToSettings,
    updateDevToolsEnabled,
    updateDevToolsSettings,
    updateNormalSynthesisPreset,
    updateSmoothContactNormals,
} from '../Settings/state';
import {
    ANCHOR_PRESET,
    DETAIL_PRESET,
    STRUCTURE_PRESET,
    createPreset,
    deletePreset,
    getPresetById,
    setActivePreset,
} from '../Settings/presets';
import {
    decodeSupportSettingsHex,
    encodeSupportSettingsHex,
} from '../Settings/supportSettingsCodec';
import {
    DIAGNOSTIC_AUTO_SUPPORT_KEYS,
    applyAutoSupportSettingsPatch,
    createDefaultAutoSupportSettings,
    normalizeAutoSupportSettings,
    resolveEffectiveAutoNormalSynthesis,
} from '../autoSupport/settings';
import { computeNormalSynthesisMetrics } from '../autoSupport/normalSynthesisTelemetry';
import type { SupportState, Vec3 } from '../types';
import * as benchAutoSupports from '../../../scripts/bench-auto-supports';

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

function removeMemoryLocalStorage(): void {
    delete (globalThis as { localStorage?: unknown }).localStorage;
}

test('SupportSettings defaults expose root normal synthesis fields, not on TipProfile, plus DevTools fields', () => {
    const defaults = createDefaultSettings();

    assert.equal(defaults.smoothContactNormals, true);
    assert.equal(defaults.normalSynthesisPreset, 'bisector');
    assert.equal('smoothContactNormals' in defaults.tip, false);
    assert.equal('normalSynthesisPreset' in defaults.tip, false);

    assert.equal(defaults.devTools.normalSampleRadiusScale, 1.0);
    assert.equal(defaults.devTools.normalFlatThresholdDeg, 5);
    assert.equal(defaults.devTools.normalCreaseThresholdDeg, 0);
    assert.equal(defaults.devTools.normalDeadbandScale, 1.0);
    assert.equal(defaults.devTools.leafRimSlackDeg, 0);
});

test('mergeSettingsWithDefaults normalizes root synthesis fields and deep-merges partial devTools', () => {
    const defaults = createDefaultSettings();
    const partialBase = {
        ...defaults,
        smoothContactNormals: undefined,
        normalSynthesisPreset: 'invalid-preset',
        devTools: {
            normalFlatThresholdDeg: 8,
            leafRimSlackDeg: 3,
        },
    } as unknown as SupportSettings;

    const normalized = mergeSettingsWithDefaults(partialBase);
    assert.equal(normalized.smoothContactNormals, true);
    assert.equal(normalized.normalSynthesisPreset, 'bisector');
    assert.equal(normalized.devTools.normalFlatThresholdDeg, 8);
    assert.equal(normalized.devTools.leafRimSlackDeg, 3);
    assert.equal(normalized.devTools.normalSampleRadiusScale, 1.0);
    assert.equal(normalized.devTools.normalCreaseThresholdDeg, 0);
    assert.equal(normalized.devTools.normalDeadbandScale, 1.0);
    assert.equal(normalized.devTools.clearanceMm, defaults.devTools.clearanceMm);

    const custom = mergeSettingsWithDefaults({
        ...defaults,
        smoothContactNormals: false,
        normalSynthesisPreset: 'macro-smooth',
    });
    assert.equal(custom.smoothContactNormals, false);
    assert.equal(custom.normalSynthesisPreset, 'macro-smooth');
});

test('state.ts mergeWithDefaults normalizes fields, deep-merges devTools, updates helpers, and preserves devTools reset on persistence', () => {
    const prev = getSettings();
    installMemoryLocalStorage();
    try {
        const legacy = {
            ...createDefaultSettings(),
            smoothContactNormals: 'yes',
            normalSynthesisPreset: 'unknown',
            devTools: {
                normalSampleRadiusScale: 1.75,
                normalCreaseThresholdDeg: 65,
            },
        } as unknown as SupportSettings;

        setSettings(legacy);
        const merged = getSettings();
        assert.equal(merged.smoothContactNormals, true);
        assert.equal(merged.normalSynthesisPreset, 'bisector');
        assert.equal(merged.devTools.normalSampleRadiusScale, 1.75);
        assert.equal(merged.devTools.normalCreaseThresholdDeg, 65);
        assert.equal(merged.devTools.normalFlatThresholdDeg, 5);
        assert.equal(merged.devTools.normalDeadbandScale, 1.0);
        assert.equal(merged.devTools.leafRimSlackDeg, 0);

        let notifications = 0;
        const unsub = subscribeToSettings(() => {
            notifications += 1;
        });
        try {
            updateSmoothContactNormals(false);
            updateNormalSynthesisPreset('crease-lock');
            updateDevToolsEnabled(true);
            updateDevToolsSettings({ normalDeadbandScale: 1.5 });
        } finally {
            unsub();
        }

        assert.equal(notifications, 4);
        assert.equal(getSettings().smoothContactNormals, false);
        assert.equal(getSettings().normalSynthesisPreset, 'crease-lock');
        assert.equal(getSettings().devToolsEnabled, true);
        assert.equal(getSettings().devTools.normalDeadbandScale, 1.5);

        saveSettingsToLocalStorage();
        setSettings(createDefaultSettings());
        assert.equal(loadSettingsFromLocalStorage(), true);

        const reloaded = getSettings();
        assert.equal(reloaded.smoothContactNormals, false);
        assert.equal(reloaded.normalSynthesisPreset, 'crease-lock');
        assert.equal(reloaded.devToolsEnabled, false, 'devToolsEnabled still resets on load');
        assert.equal(reloaded.devTools.normalDeadbandScale, 1.0, 'devTools values still reset on load');
    } finally {
        setSettings(prev);
        removeMemoryLocalStorage();
    }
});

test('presets include defaults, preserve root normal synthesis across applyPreset, and normalize custom presets', () => {
    const prev = getSettings();
    installMemoryLocalStorage();
    try {
        for (const preset of [DETAIL_PRESET, STRUCTURE_PRESET, ANCHOR_PRESET]) {
            assert.equal(preset.settings.smoothContactNormals, true);
            assert.equal(preset.settings.normalSynthesisPreset, 'bisector');
        }

        updateSmoothContactNormals(false);
        updateNormalSynthesisPreset('macro-smooth');

        setActivePreset('anchor');
        assert.equal(getSettings().smoothContactNormals, false);
        assert.equal(getSettings().normalSynthesisPreset, 'macro-smooth');

        setActivePreset('detail');
        assert.equal(getSettings().smoothContactNormals, false);
        assert.equal(getSettings().normalSynthesisPreset, 'macro-smooth');

        const created = createPreset('Normal Test Custom');
        try {
            const stored = getPresetById(created.id);
            assert.ok(stored);
            assert.equal(stored.settings.smoothContactNormals, false);
            assert.equal(stored.settings.normalSynthesisPreset, 'macro-smooth');
            assert.equal(stored.settings.devTools.normalFlatThresholdDeg, 5);
        } finally {
            deletePreset(created.id);
        }
    } finally {
        setSettings(prev);
        removeMemoryLocalStorage();
    }
});

test('supportSettingsCodec 42-byte share hex is invariant across normal synthesis and DevTools fields', () => {
    const base = createDefaultSettings();
    const baseHex = encodeSupportSettingsHex(base);
    assert.equal(baseHex.length, 84, '42 bytes = 84 hex chars');

    const modified: SupportSettings = {
        ...base,
        smoothContactNormals: false,
        normalSynthesisPreset: 'crease-lock',
        devToolsEnabled: true,
        devTools: {
            ...base.devTools,
            normalSampleRadiusScale: 2.2,
            normalFlatThresholdDeg: 12,
            normalCreaseThresholdDeg: 70,
            normalDeadbandScale: 0.4,
            leafRimSlackDeg: 8,
        },
    };
    const modifiedHex = encodeSupportSettingsHex(modified);
    assert.equal(modifiedHex, baseHex, '42-byte share hex must stay untouched');

    const decoded = decodeSupportSettingsHex(baseHex, modified);
    assert.ok(decoded);
    assert.equal(decoded.smoothContactNormals, false);
    assert.equal(decoded.normalSynthesisPreset, 'crease-lock');
});

test('AutoSupportSettings defaults, normalizeAutoSupportSettings, and diagnostic key boundary', () => {
    const defaults = createDefaultAutoSupportSettings();
    assert.equal(defaults.smoothContactNormals, true);
    assert.equal(defaults.normalSynthesisPreset, 'bisector');
    assert.equal(defaults.knotWeightedLeafNormals, true, 'Wave D flips Leaf Cap Orbiting default on');
    assert.equal('normalSynthesisMode' in defaults, false);
    assert.equal('leafCapOrbit' in defaults, false);
    assert.equal('leafRimSlackDeg' in defaults, false);

    assert.equal((DIAGNOSTIC_AUTO_SUPPORT_KEYS as readonly string[]).includes('smoothContactNormals'), false);
    assert.equal((DIAGNOSTIC_AUTO_SUPPORT_KEYS as readonly string[]).includes('normalSynthesisPreset'), false);
    assert.equal((DIAGNOSTIC_AUTO_SUPPORT_KEYS as readonly string[]).includes('knotWeightedLeafNormals'), false);

    const normalizedEmpty = normalizeAutoSupportSettings({});
    assert.equal(normalizedEmpty.smoothContactNormals, true);
    assert.equal(normalizedEmpty.normalSynthesisPreset, 'bisector');
    assert.equal(normalizedEmpty.knotWeightedLeafNormals, true);
    assert.equal('normalSynthesisMode' in normalizedEmpty, false, 'must omit normalSynthesisMode when absent');
    assert.equal('leafCapOrbit' in normalizedEmpty, false, 'must omit leafCapOrbit when absent');
    assert.equal('leafRimSlackDeg' in normalizedEmpty, false, 'must omit leafRimSlackDeg when absent');

    const normalizedInvalid = normalizeAutoSupportSettings({
        smoothContactNormals: 'nope' as unknown as boolean,
        normalSynthesisPreset: 'bogus' as unknown as NormalSynthesisPreset,
        knotWeightedLeafNormals: 1 as unknown as boolean,
        leafRimSlackDeg: Number.NaN,
    });
    assert.equal(normalizedInvalid.smoothContactNormals, true);
    assert.equal(normalizedInvalid.normalSynthesisPreset, 'bisector');
    assert.equal(normalizedInvalid.knotWeightedLeafNormals, true);
    assert.equal('normalSynthesisMode' in normalizedInvalid, false);
    assert.equal('leafRimSlackDeg' in normalizedInvalid, false);

    const withCli = normalizeAutoSupportSettings({
        normalSynthesisMode: 'crease-lock',
        leafCapOrbit: true,
        leafRimSlackDeg: 14,
    });
    assert.equal(withCli.normalSynthesisMode, 'crease-lock');
    assert.equal(withCli.leafCapOrbit, true);
    assert.equal(withCli.leafRimSlackDeg, 14);

    assert.equal(normalizeAutoSupportSettings({ leafRimSlackDeg: -8 }).leafRimSlackDeg, 0);
    assert.equal(normalizeAutoSupportSettings({ leafRimSlackDeg: 55 }).leafRimSlackDeg, 35);

    const patched = applyAutoSupportSettingsPatch(defaults, {
        smoothContactNormals: false,
        normalSynthesisPreset: 'macro-smooth',
    });
    assert.equal(patched.smoothContactNormals, false);
    assert.equal(patched.normalSynthesisPreset, 'macro-smooth');
    assert.equal('normalSynthesisMode' in patched, false);
    assert.equal('leafCapOrbit' in patched, false);
    assert.equal('leafRimSlackDeg' in patched, false);
});

test('resolveEffectiveAutoNormalSynthesis resolves UI defaults, master gating, CLI overrides, and devTools.leafRimSlackDeg gating', () => {
    assert.deepEqual(resolveEffectiveAutoNormalSynthesis(undefined), {
        mode: 'bisector',
        leafCapOrbit: true,
        leafRimSlackDeg: 0,
    });
    assert.deepEqual(resolveEffectiveAutoNormalSynthesis(null), {
        mode: 'bisector',
        leafCapOrbit: true,
        leafRimSlackDeg: 0,
    });
    assert.deepEqual(resolveEffectiveAutoNormalSynthesis({}), {
        mode: 'bisector',
        leafCapOrbit: true,
        leafRimSlackDeg: 0,
    });

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: false,
            normalSynthesisPreset: 'crease-lock',
            knotWeightedLeafNormals: true,
        }),
        { mode: 'raw', leafCapOrbit: false, leafRimSlackDeg: 0 },
    );

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: true,
            normalSynthesisPreset: 'macro-smooth',
            knotWeightedLeafNormals: false,
        }),
        { mode: 'macro-smooth', leafCapOrbit: false, leafRimSlackDeg: 0 },
    );

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: true,
            normalSynthesisPreset: 'macro-smooth',
            knotWeightedLeafNormals: true,
        }),
        { mode: 'macro-smooth', leafCapOrbit: true, leafRimSlackDeg: 0 },
    );

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: false,
            normalSynthesisPreset: 'bisector',
            normalSynthesisMode: 'crease-lock',
            knotWeightedLeafNormals: false,
            leafCapOrbit: true,
            leafRimSlackDeg: 18,
        }),
        { mode: 'crease-lock', leafCapOrbit: true, leafRimSlackDeg: 18 },
    );

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: true,
            normalSynthesisPreset: 'macro-smooth',
            normalSynthesisMode: 'raw',
            knotWeightedLeafNormals: true,
            leafCapOrbit: false,
            leafRimSlackDeg: 50,
        }),
        { mode: 'raw', leafCapOrbit: false, leafRimSlackDeg: 35 },
    );

    // devTools.leafRimSlackDeg gating
    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({}, { enabled: false, leafRimSlackDeg: 20 }),
        { mode: 'bisector', leafCapOrbit: true, leafRimSlackDeg: 0 },
    );
    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({}, { enabled: true, leafRimSlackDeg: 20 }),
        { mode: 'bisector', leafCapOrbit: true, leafRimSlackDeg: 20 },
    );
    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({}, { enabled: true, leafRimSlackDeg: 50 }),
        { mode: 'bisector', leafCapOrbit: true, leafRimSlackDeg: 35 },
    );
    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({}, { enabled: true, leafRimSlackDeg: -4 }),
        { mode: 'bisector', leafCapOrbit: true, leafRimSlackDeg: 0 },
    );
    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({ leafRimSlackDeg: 7 }, { enabled: true, leafRimSlackDeg: 20 }),
        { mode: 'bisector', leafCapOrbit: true, leafRimSlackDeg: 7 },
    );
    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({ leafRimSlackDeg: 0 }, { enabled: true, leafRimSlackDeg: 20 }),
        { mode: 'bisector', leafCapOrbit: true, leafRimSlackDeg: 0 },
    );
});

test('bench-auto-supports parseArgs handles --leaf-rim-slack order-independently and formatNormalSynthesisTable prints capSplit/slack', () => {
    const spaceFlag = benchAutoSupports.parseArgs([
        '--leaf-rim-slack', '15',
        '--settings', '{"areaPerSupportMm2":20,"leafRimSlackDeg":3}',
    ]);
    assert.equal(spaceFlag.settings.leafRimSlackDeg, 15);
    assert.equal(spaceFlag.settings.areaPerSupportMm2, 20);

    const eqFlag = benchAutoSupports.parseArgs([
        '--settings', '{"areaPerSupportMm2":12}',
        '--leaf-rim-slack=15',
    ]);
    assert.equal(eqFlag.settings.leafRimSlackDeg, 15);
    assert.equal(eqFlag.settings.areaPerSupportMm2, 12);

    assert.equal(benchAutoSupports.parseArgs(['--leaf-rim-slack', '-5']).settings.leafRimSlackDeg, 0);
    assert.equal(benchAutoSupports.parseArgs(['--leaf-rim-slack=50']).settings.leafRimSlackDeg, 35);

    assert.throws(() => benchAutoSupports.parseArgs(['--leaf-rim-slack', 'nope']), /leaf-rim-slack/);
    assert.throws(() => benchAutoSupports.parseArgs(['--leaf-rim-slack=']), /leaf-rim-slack/);
    assert.throws(() => benchAutoSupports.parseArgs(['--leaf-rim-slack']), /needs a value/);

    const emptyState: SupportState = {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {},
        twigs: {},
        sticks: {},
        braces: {},
        stumps: {},
        kickstands: {},
        knots: {},
        selectedId: null,
        hoveredId: null,
    };
    const withOrbit = computeNormalSynthesisMetrics(emptyState, 'm-fmt', {
        mode: 'bisector',
        leafCapOrbit: true,
    });
    const formatFn = (benchAutoSupports as Record<string, unknown>).formatNormalSynthesisTable as
        | ((rows: Array<{ name: string; normalSynthesis?: typeof withOrbit }>, leafRimSlackDeg?: number) => string)
        | undefined;
    assert.equal(typeof formatFn, 'function', 'formatNormalSynthesisTable must be exported');
    const rendered = formatFn!([{ name: 'm-fmt', normalSynthesis: withOrbit }], 15);
    assert.match(rendered, /bisector\+orb\+slack15/);
    assert.match(rendered, /== Leaf Cap Split \(H1-H2\) ==/);
});

test('computeNormalSynthesisMetrics omits capSplit when leafCapOrbit is false and no capAnchor exists, and populates H1-H2 capSplit otherwise', () => {
    const vecFromDown = (deg: number, azDeg = 0): Vec3 => {
        const r = (deg * Math.PI) / 180;
        const a = (azDeg * Math.PI) / 180;
        return { x: Math.sin(r) * Math.cos(a), y: Math.sin(r) * Math.sin(a), z: -Math.cos(r) };
    };
    const diskProfile = {
        type: 'disk' as const,
        contactDiameterMm: 0.2,
        bodyDiameterMm: 0.5,
        lengthMm: 1.2,
        penetrationMm: 0.05,
        diskThicknessMm: 0.1,
        maxStandoffMm: 0.35,
        standoffAngleThreshold: Math.PI / 4,
    };
    const baseState: SupportState = {
        roots: {},
        trunks: {},
        branches: {},
        leaves: {
            'l-plain': {
                id: 'l-plain',
                modelId: 'm1',
                parentKnotId: 'k1',
                contactCone: {
                    id: 'c-plain',
                    pos: { x: 0, y: 0, z: 10 },
                    normal: vecFromDown(0),
                    surfaceNormal: vecFromDown(0),
                    profile: diskProfile,
                },
            },
            'l-other-cap': {
                id: 'l-other-cap',
                modelId: 'other-model',
                parentKnotId: 'k2',
                contactCone: {
                    id: 'c-other',
                    pos: { x: 0, y: 0, z: 10 },
                    normal: vecFromDown(0),
                    surfaceNormal: vecFromDown(0),
                    profile: diskProfile,
                    capAnchor: {
                        nMean: vecFromDown(0),
                        baseNormal: vecFromDown(0),
                        thetaSpreadRad: (25 * Math.PI) / 180,
                        thetaCapRad: (25 * Math.PI) / 180,
                        isConcave: false,
                    },
                } as unknown as SupportState['leaves'][string]['contactCone'],
            },
        },
        twigs: {},
        sticks: {},
        braces: {},
        stumps: {},
        kickstands: {},
        knots: {},
        selectedId: null,
        hoveredId: null,
    };

    const arm0Off = computeNormalSynthesisMetrics(baseState, 'm1', { mode: 'raw', leafCapOrbit: false });
    assert.equal(arm0Off.capSplit, undefined);
    assert.equal('capSplit' in arm0Off, false);

    const orbitEnabledNoAnchor = computeNormalSynthesisMetrics(baseState, 'm1', { mode: 'bisector', leafCapOrbit: true });
    assert.ok(orbitEnabledNoAnchor.capSplit);
    assert.deepEqual(orbitEnabledNoAnchor.capSplit.flatOrSmooth, {
        count: 1,
        flushCount: 1,
        angleDrivenCount: 0,
        collisionDrivenCount: 0,
        capReachableCount: 0,
        orbitedCount: 0,
        concaveCount: 0,
        meanOrbitShiftDeg: 0,
        maxOrbitShiftDeg: 0,
    });
    assert.equal(orbitEnabledNoAnchor.capSplit.ridgeOrCorner.count, 0);

    const anchoredState: SupportState = {
        ...baseState,
        leaves: {
            ...baseState.leaves,
            // flatOrSmooth (< 15°): thetaSpread = 10°, orbited 4°, reachable, angle-driven (sn vs cn = 60°)
            'l-flat-cap': {
                id: 'l-flat-cap',
                modelId: 'm1',
                parentKnotId: 'k1',
                contactCone: {
                    id: 'c-flat',
                    pos: { x: 0, y: 0, z: 10 },
                    normal: vecFromDown(60),
                    surfaceNormal: vecFromDown(4),
                    profile: diskProfile,
                    capAnchor: {
                        nMean: vecFromDown(0),
                        baseNormal: vecFromDown(0),
                        thetaSpreadRad: (10 * Math.PI) / 180,
                        thetaCapRad: (15 * Math.PI) / 180, // 45 + 15 = 60° (reachable!)
                        isConcave: false,
                    },
                } as unknown as SupportState['leaves'][string]['contactCone'],
            },
            // ridgeOrCorner (>= 15° boundary): thetaSpread = 15°, orbited 12°, concave, collision-driven, unreachable (nMean vs cn = 65° > 45 + 15)
            'l-ridge-1': {
                id: 'l-ridge-1',
                modelId: 'm1',
                parentKnotId: 'k1',
                contactCone: {
                    id: 'c-r1',
                    pos: { x: 0, y: 0, z: 10 },
                    normal: vecFromDown(65),
                    surfaceNormal: vecFromDown(12),
                    diskLengthOverride: 0.34,
                    profile: diskProfile,
                    capAnchor: {
                        nMean: vecFromDown(0),
                        baseNormal: vecFromDown(0),
                        thetaSpreadRad: (15 * Math.PI) / 180,
                        thetaCapRad: (15 * Math.PI) / 180,
                        isConcave: true,
                    },
                } as unknown as SupportState['leaves'][string]['contactCone'],
            },
            // ridgeOrCorner: thetaSpread = 25°, shift 0.2° (<= 0.5, not orbited), flush, reachable
            'l-ridge-2': {
                id: 'l-ridge-2',
                modelId: 'm1',
                parentKnotId: 'k1',
                contactCone: {
                    id: 'c-r2',
                    pos: { x: 0, y: 0, z: 10 },
                    normal: vecFromDown(0.2),
                    surfaceNormal: vecFromDown(0.2),
                    profile: diskProfile,
                    capAnchor: {
                        nMean: vecFromDown(0),
                        baseNormal: vecFromDown(0),
                        thetaSpreadRad: (25 * Math.PI) / 180,
                        thetaCapRad: (25 * Math.PI) / 180,
                        isConcave: false,
                    },
                } as unknown as SupportState['leaves'][string]['contactCone'],
            },
        },
    };

    // Even when leafCapOrbit option is false, presence of capAnchor on modelId populates capSplit
    const withAnchors = computeNormalSynthesisMetrics(anchoredState, 'm1', { mode: 'bisector', leafCapOrbit: false });
    assert.ok(withAnchors.capSplit);
    assert.deepEqual(withAnchors.capSplit.flatOrSmooth, {
        count: 2,
        flushCount: 1,
        angleDrivenCount: 1,
        collisionDrivenCount: 0,
        capReachableCount: 1,
        orbitedCount: 1,
        concaveCount: 0,
        meanOrbitShiftDeg: 2,
        maxOrbitShiftDeg: 4,
    });
    assert.deepEqual(withAnchors.capSplit.ridgeOrCorner, {
        count: 2,
        flushCount: 1,
        angleDrivenCount: 0,
        collisionDrivenCount: 1,
        capReachableCount: 1,
        orbitedCount: 1,
        concaveCount: 1,
        meanOrbitShiftDeg: 6.1,
        maxOrbitShiftDeg: 12,
    });
});
