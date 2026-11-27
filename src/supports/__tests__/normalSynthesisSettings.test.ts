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
    assert.equal(defaults.knotWeightedLeafNormals, false, 'must stay false in Wave C');
    assert.equal('normalSynthesisMode' in defaults, false);
    assert.equal('leafCapOrbit' in defaults, false);

    assert.equal((DIAGNOSTIC_AUTO_SUPPORT_KEYS as readonly string[]).includes('smoothContactNormals'), false);
    assert.equal((DIAGNOSTIC_AUTO_SUPPORT_KEYS as readonly string[]).includes('normalSynthesisPreset'), false);
    assert.equal((DIAGNOSTIC_AUTO_SUPPORT_KEYS as readonly string[]).includes('knotWeightedLeafNormals'), false);

    const normalizedEmpty = normalizeAutoSupportSettings({});
    assert.equal(normalizedEmpty.smoothContactNormals, true);
    assert.equal(normalizedEmpty.normalSynthesisPreset, 'bisector');
    assert.equal(normalizedEmpty.knotWeightedLeafNormals, false);
    assert.equal('normalSynthesisMode' in normalizedEmpty, false, 'must omit normalSynthesisMode when absent');
    assert.equal('leafCapOrbit' in normalizedEmpty, false, 'must omit leafCapOrbit when absent');

    const normalizedInvalid = normalizeAutoSupportSettings({
        smoothContactNormals: 'nope' as unknown as boolean,
        normalSynthesisPreset: 'bogus' as unknown as NormalSynthesisPreset,
        knotWeightedLeafNormals: 1 as unknown as boolean,
    });
    assert.equal(normalizedInvalid.smoothContactNormals, true);
    assert.equal(normalizedInvalid.normalSynthesisPreset, 'bisector');
    assert.equal(normalizedInvalid.knotWeightedLeafNormals, false);
    assert.equal('normalSynthesisMode' in normalizedInvalid, false);

    const withCli = normalizeAutoSupportSettings({
        normalSynthesisMode: 'crease-lock',
        leafCapOrbit: true,
    });
    assert.equal(withCli.normalSynthesisMode, 'crease-lock');
    assert.equal(withCli.leafCapOrbit, true);

    const patched = applyAutoSupportSettingsPatch(defaults, {
        smoothContactNormals: false,
        normalSynthesisPreset: 'macro-smooth',
    });
    assert.equal(patched.smoothContactNormals, false);
    assert.equal(patched.normalSynthesisPreset, 'macro-smooth');
    assert.equal('normalSynthesisMode' in patched, false);
    assert.equal('leafCapOrbit' in patched, false);
});

test('resolveEffectiveAutoNormalSynthesis resolves UI defaults, toggle off -> raw, and CLI overrides', () => {
    assert.deepEqual(resolveEffectiveAutoNormalSynthesis(undefined), {
        mode: 'bisector',
        leafCapOrbit: false,
    });
    assert.deepEqual(resolveEffectiveAutoNormalSynthesis(null), {
        mode: 'bisector',
        leafCapOrbit: false,
    });
    assert.deepEqual(resolveEffectiveAutoNormalSynthesis({}), {
        mode: 'bisector',
        leafCapOrbit: false,
    });

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: false,
            normalSynthesisPreset: 'crease-lock',
            knotWeightedLeafNormals: false,
        }),
        { mode: 'raw', leafCapOrbit: false },
    );

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: true,
            normalSynthesisPreset: 'macro-smooth',
            knotWeightedLeafNormals: true,
        }),
        { mode: 'macro-smooth', leafCapOrbit: true },
    );

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: false,
            normalSynthesisPreset: 'bisector',
            normalSynthesisMode: 'crease-lock',
            knotWeightedLeafNormals: false,
            leafCapOrbit: true,
        }),
        { mode: 'crease-lock', leafCapOrbit: true },
    );

    assert.deepEqual(
        resolveEffectiveAutoNormalSynthesis({
            smoothContactNormals: true,
            normalSynthesisPreset: 'macro-smooth',
            normalSynthesisMode: 'raw',
            knotWeightedLeafNormals: true,
            leafCapOrbit: false,
        }),
        { mode: 'raw', leafCapOrbit: false },
    );
});
