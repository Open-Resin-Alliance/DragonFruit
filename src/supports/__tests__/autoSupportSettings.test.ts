import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
    createDefaultAutoSupportSettings,
    normalizeAutoSupportSettings,
    applyAutoSupportSettingsPatch,
    migrateLegacySizingPreset,
    AUTO_SUPPORT_CONSTRAINTS,
    SIZING_BANDS,
} from '../autoSupport/settings';
import { computeAutoSupportPlan, forestReportToText } from '../autoSupport/autoPlace';
import { getSettings, updateAutoSupportSettings } from '../Settings/state';
import { accelerateGeometry, initializeBVH } from '../../utils/bvh';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

test('defaults match constraints', () => {
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(defaults.enabled, true);
    assert.equal(defaults.minIslandAreaMm2, AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2.defaultValue);
    assert.equal(defaults.tipInfluenceRadiusMm, AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm.defaultValue);
    assert.equal(defaults.prioritizeIntersection, false);
    assert.equal(defaults.maxAttachmentsPerTrunk, AUTO_SUPPORT_CONSTRAINTS.maxAttachmentsPerTrunk.defaultValue);
    assert.equal(defaults.areaPerSupportMm2, AUTO_SUPPORT_CONSTRAINTS.areaPerSupportMm2.defaultValue);
    assert.equal(defaults.overhangSelfSupportAngleDeg, AUTO_SUPPORT_CONSTRAINTS.overhangSelfSupportAngleDeg.defaultValue);
    assert.equal(defaults.sizeScale, 1);
    assert.equal(defaults.flatDensityBoost, AUTO_SUPPORT_CONSTRAINTS.flatDensityBoost.defaultValue);
    assert.equal(defaults.slopeRelaxFactor, AUTO_SUPPORT_CONSTRAINTS.slopeRelaxFactor.defaultValue);
    assert.equal(defaults.coverageTargetPercent, AUTO_SUPPORT_CONSTRAINTS.coverageTargetPercent.defaultValue);
    assert.equal(defaults.leafFanRadiusMm, AUTO_SUPPORT_CONSTRAINTS.leafFanRadiusMm.defaultValue);
    assert.equal(defaults.leafFanMaxAngleDeg, AUTO_SUPPORT_CONSTRAINTS.leafFanMaxAngleDeg.defaultValue);
    assert.equal(defaults.tipContactMarginScale, 0.9, 'measured tip contact margin');
    assert.equal(defaults.memberHostShaftRatio, 0.7, 'measured member/host floor');
    assert.equal(defaults.modelScaleEnabled, true, 'model-scale sizing on by default');
    assert.equal(defaults.modelSizeFactorCap, 1.45, 'measured size-factor cap');
    assert.equal(defaults.modelLoadFactorCap, 1.3, 'measured load-factor cap');
    assert.equal(defaults.heightFactorCap, 1.35, 'measured height-factor cap');
    assert.equal(defaults.sizingPreset, 'structure', 'the default tier is the factory structure preset');
    assert.equal(defaults.debugSkipAutoBracing, false);
});

test('normalize clamps the new knobs', () => {
    const normalized = normalizeAutoSupportSettings({
        sizeScale: 9,
        flatDensityBoost: 0.1,
        slopeRelaxFactor: 5,
        coverageTargetPercent: 50,
        leafFanRadiusMm: 100,
        leafFanMaxAngleDeg: 200,
    });
    assert.equal(normalized.sizeScale, AUTO_SUPPORT_CONSTRAINTS.sizeScale.max);
    assert.equal(normalized.flatDensityBoost, AUTO_SUPPORT_CONSTRAINTS.flatDensityBoost.min);
    assert.equal(normalized.slopeRelaxFactor, AUTO_SUPPORT_CONSTRAINTS.slopeRelaxFactor.max);
    assert.equal(normalized.coverageTargetPercent, AUTO_SUPPORT_CONSTRAINTS.coverageTargetPercent.min);
    assert.equal(normalized.leafFanRadiusMm, AUTO_SUPPORT_CONSTRAINTS.leafFanRadiusMm.max);
    assert.equal(normalized.leafFanMaxAngleDeg, AUTO_SUPPORT_CONSTRAINTS.leafFanMaxAngleDeg.max);
});

test('normalize clamps the calibration knobs', () => {
    const high = normalizeAutoSupportSettings({
        tipContactMarginScale: 9,
        memberHostShaftRatio: 9,
        modelSizeFactorCap: 9,
        modelLoadFactorCap: 9,
        heightFactorCap: 9,
    });
    assert.equal(high.tipContactMarginScale, AUTO_SUPPORT_CONSTRAINTS.tipContactMarginScale.max);
    assert.equal(high.memberHostShaftRatio, AUTO_SUPPORT_CONSTRAINTS.memberHostShaftRatio.max);
    assert.equal(high.modelSizeFactorCap, AUTO_SUPPORT_CONSTRAINTS.modelSizeFactorCap.max);
    assert.equal(high.modelLoadFactorCap, AUTO_SUPPORT_CONSTRAINTS.modelLoadFactorCap.max);
    assert.equal(high.heightFactorCap, AUTO_SUPPORT_CONSTRAINTS.heightFactorCap.max);

    const low = normalizeAutoSupportSettings({
        tipContactMarginScale: 0,
        memberHostShaftRatio: 0,
        modelSizeFactorCap: 0,
        modelLoadFactorCap: 0,
        heightFactorCap: 0,
    });
    assert.equal(low.tipContactMarginScale, AUTO_SUPPORT_CONSTRAINTS.tipContactMarginScale.min);
    assert.equal(low.memberHostShaftRatio, AUTO_SUPPORT_CONSTRAINTS.memberHostShaftRatio.min);
    assert.equal(low.modelSizeFactorCap, AUTO_SUPPORT_CONSTRAINTS.modelSizeFactorCap.min);
    assert.equal(low.modelLoadFactorCap, AUTO_SUPPORT_CONSTRAINTS.modelLoadFactorCap.min);
    assert.equal(low.heightFactorCap, AUTO_SUPPORT_CONSTRAINTS.heightFactorCap.min);
});

test('normalize clamps high values', () => {
    const normalized = normalizeAutoSupportSettings({
        minIslandAreaMm2: 999,
        maxAttachmentsPerTrunk: 999,
    });

    assert.equal(normalized.minIslandAreaMm2, AUTO_SUPPORT_CONSTRAINTS.minIslandAreaMm2.max);
    assert.equal(normalized.maxAttachmentsPerTrunk, AUTO_SUPPORT_CONSTRAINTS.maxAttachmentsPerTrunk.max);
});

test('normalize fills missing fields', () => {
    const normalized = normalizeAutoSupportSettings({});
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(normalized.enabled, defaults.enabled);
    assert.equal(normalized.minIslandAreaMm2, defaults.minIslandAreaMm2);
    assert.equal(normalized.tipInfluenceRadiusMm, defaults.tipInfluenceRadiusMm);
    assert.equal(normalized.prioritizeIntersection, defaults.prioritizeIntersection);
    assert.equal(normalized.maxAttachmentsPerTrunk, defaults.maxAttachmentsPerTrunk);
    assert.equal(normalized.debugSkipAutoBracing, defaults.debugSkipAutoBracing);
});

test('normalize drops legacy dead keys', () => {
    // Settings saved before the dead-knob removal (clusterRadiusMm and friends)
    // must normalize cleanly to the live shape without errors. Cast through any
    // because the keys no longer exist on the type.
    const normalized = normalizeAutoSupportSettings({
        clusterRadiusMm: 30,
        debugClusterColorsEnabled: true,
        minIslandAreaMm2: 0.1,
    } as unknown as Parameters<typeof normalizeAutoSupportSettings>[0]);

    assert.equal(normalized.minIslandAreaMm2, 0.1);
    assert.equal(normalized.tipInfluenceRadiusMm, AUTO_SUPPORT_CONSTRAINTS.tipInfluenceRadiusMm.defaultValue);
});

test('defaults include the densification knobs', () => {
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(defaults.suctionAreaExponent, AUTO_SUPPORT_CONSTRAINTS.suctionAreaExponent.defaultValue);
});

test('normalize clamps the densification knobs', () => {
    const normalized = normalizeAutoSupportSettings({
        suctionAreaExponent: 9,
    });

    assert.equal(normalized.suctionAreaExponent, AUTO_SUPPORT_CONSTRAINTS.suctionAreaExponent.max);
});

test('defaults include distribution mode and perimeter factor', () => {
    const defaults = createDefaultAutoSupportSettings();

    assert.equal(defaults.debugSupportOriginColors, false);
});

test('the tier is an open preset id, and only the default repairs it', () => {
    // Any non-empty string is kept: the id names a Support Studio preset, the user's
    // own included, and a deleted one is a run-time fallback rather than an error.
    const custom = normalizeAutoSupportSettings({ sizingPreset: 'my-thick-preset' });
    assert.equal(custom.sizingPreset, 'my-thick-preset');
    assert.equal(normalizeAutoSupportSettings({ sizingPreset: 'anchor' }).sizingPreset, 'anchor');

    // Missing, empty or not a string: the default tier.
    assert.equal(normalizeAutoSupportSettings({}).sizingPreset, 'structure');
    assert.equal(normalizeAutoSupportSettings({ sizingPreset: '   ' }).sizingPreset, 'structure');
    assert.equal(normalizeAutoSupportSettings({ sizingPreset: 7 as unknown as string }).sizingPreset, 'structure');
});

test('a band-era block migrates back to the factory preset whose band it was', () => {
    // The band-as-data build wrote the seven numbers into the block; the field
    // names a Support Studio preset again, so the band maps to the factory preset
    // it matches — and to `structure` for a band the factory never shipped.
    const anchor = {
        areaPerSupportMm2: 5,
        sizingBand: { ...SIZING_BANDS.anchor },
    } as unknown as Parameters<typeof normalizeAutoSupportSettings>[0];
    const migrated = normalizeAutoSupportSettings(anchor);
    assert.equal(migrated.sizingPreset, 'anchor', 'the matching factory preset');
    assert.equal(migrated.areaPerSupportMm2, 5, 'the rest of the block is untouched');
    assert.ok(!('sizingBand' in migrated), 'the obsolete key is gone');

    // Merged over the defaults (what the settings store does on load) the band
    // still wins over the default tier.
    const merged = normalizeAutoSupportSettings({
        ...createDefaultAutoSupportSettings(),
        ...anchor,
    } as unknown as Parameters<typeof normalizeAutoSupportSettings>[0]);
    assert.equal(merged.sizingPreset, 'anchor');
    assert.ok(!('sizingBand' in merged));

    const detail = normalizeAutoSupportSettings({
        sizingBand: { ...SIZING_BANDS.detail },
    } as unknown as Parameters<typeof normalizeAutoSupportSettings>[0]);
    assert.equal(detail.sizingPreset, 'detail');

    // A band nobody ships is `structure`, the engine's own fallback.
    const unknown = normalizeAutoSupportSettings({
        sizingBand: { ...SIZING_BANDS.detail, shaftDiameterMm: 0.97 },
    } as unknown as Parameters<typeof normalizeAutoSupportSettings>[0]);
    assert.equal(unknown.sizingPreset, 'structure');
});

test("migrateLegacySizingPreset keeps a preset payload's unknown keys", () => {
    // This is the call the preset store makes on a payload it must store
    // verbatim: the tier comes from the band, the obsolete key goes, and a key
    // this build cannot name survives.
    const payload = { areaPerSupportMm2: 7, sizingBand: { ...SIZING_BANDS.detail }, futureKnobMm: 3 };
    assert.deepEqual(migrateLegacySizingPreset(payload), {
        areaPerSupportMm2: 7,
        sizingPreset: 'detail',
        futureKnobMm: 3,
    });

    // No legacy key: the same object comes back (no copy on every read).
    const clean = { areaPerSupportMm2: 7 };
    assert.equal(migrateLegacySizingPreset(clean), clean);
});

test('patch merges partially', () => {
    const base = createDefaultAutoSupportSettings();
    const patched = applyAutoSupportSettingsPatch(base, {
        enabled: false,
        maxAttachmentsPerTrunk: 30,
    });

    assert.equal(patched.enabled, false);
    assert.equal(patched.maxAttachmentsPerTrunk, 30);
    assert.equal(patched.minIslandAreaMm2, base.minIslandAreaMm2);
    assert.equal(patched.tipInfluenceRadiusMm, base.tipInfluenceRadiusMm);
    assert.equal(patched.prioritizeIntersection, base.prioritizeIntersection);
    assert.equal(patched.debugSkipAutoBracing, base.debugSkipAutoBracing);
});

test('computeAutoSupportPlan merges settingsOverride undefined-safely over live store and threads overrides without store mutation', () => {
    initializeBVH();
    // Large (300mm long) narrow (0.52mm wide) rib at z=30:
    // - If modelScaleEnabled were true (live store), 300mm extent & z=30 would scale shaft > 0.8mm.
    // - If sizingPreset were 'anchor' (live store), shaft would be >= 1.4mm instead of 'detail' (0.8mm).
    // - On a 0.52mm rib: default margin 0.9 -> 0.468mm (uncapped vs detail 0.25mm, or on structure 0.28mm),
    //   whereas tipContactMarginScale: 0.5 -> 0.52 * 0.5 = 0.26mm (< structure 0.28mm & < detail 30%-floor 0.24mm? Wait: on detail band tip is 0.25mm, on 0.46mm rib 0.46 * 0.5 = 0.23mm < 0.25mm!).
    const ribGeo = new THREE.BoxGeometry(300, 0.46, 2).translate(0, 0, 31).toNonIndexed();
    ribGeo.computeVertexNormals();
    accelerateGeometry(ribGeo);
    const ribMesh = new THREE.Mesh(ribGeo, new THREE.MeshBasicMaterial());
    ribMesh.updateMatrixWorld(true);

    const prevAuto = getSettings().autoSupport;
    updateAutoSupportSettings({
        areaPerSupportMm2: 20,
        leafFanMaxAngleDeg: 20,
        memberHostShaftRatio: 0.65,
        sizingPreset: 'anchor',
        modelScaleEnabled: true,
        tipContactMarginScale: 0.95,
    });

    try {
        const islands: DetectedIsland[] = [
            {
                id: 'rib-v0',
                source: 'voxel',
                contact: new THREE.Vector3(0, 0, 30),
                baseZ: 30,
                areaMm2: 4,
                surfaceNormal: { x: 0, y: 0, z: -1 },
                contactVoxels: { xy: new Float32Array([0, 0]), z: new Float32Array([30]), count: 1 },
            },
            {
                id: 'rib-o1',
                source: 'overhang',
                contact: new THREE.Vector3(20, 0, 30),
                baseZ: 30,
                areaMm2: 4,
                surfaceNormal: { x: 0, y: 0, z: -1 },
                contactVoxels: { xy: new Float32Array([20, 0]), z: new Float32Array([30]), count: 1 },
            },
        ];

        const plan = computeAutoSupportPlan(
            islands,
            'model-override',
            {
                modelScaleEnabled: false,
                sizingPreset: 'detail',
                tipContactMarginScale: 0.5,
                leafFanMaxAngleDeg: undefined,
                debugSkipAutoBracing: true,
                stabilizationEnabled: false,
                minimaReinforcementEnabled: false,
            },
            undefined,
            ribMesh,
        );

        assert.ok(plan, 'plan computed');
        // Global store was NOT mutated by overrides
        assert.equal(getSettings().autoSupport.sizingPreset, 'anchor');
        assert.equal(getSettings().autoSupport.modelScaleEnabled, true);
        assert.equal(getSettings().autoSupport.tipContactMarginScale, 0.95);
        assert.equal(getSettings().autoSupport.leafFanMaxAngleDeg, 20);

        // (1) Live-store areaPerSupportMm2 = 20 survived into loadBudget with concrete non-zero capacity (2x areaPerSupportMm2: 10)
        const planDefaultArea = computeAutoSupportPlan(
            islands,
            'model-override',
            {
                areaPerSupportMm2: 10,
                modelScaleEnabled: false,
                sizingPreset: 'detail',
                tipContactMarginScale: 0.5,
                leafFanMaxAngleDeg: undefined,
                debugSkipAutoBracing: true,
                stabilizationEnabled: false,
                minimaReinforcementEnabled: false,
            },
            undefined,
            ribMesh,
        );
        assert.ok(plan.analytics.forestReport?.loadBudget, 'loadBudget present');
        assert.ok(planDefaultArea?.analytics.forestReport?.loadBudget, 'reference loadBudget present');
        assert.ok(plan.analytics.forestReport!.loadBudget!.totalCapacityMm2 > 0, 'non-zero loadBudget capacity');
        assert.notEqual(
            plan.analytics.forestReport!.loadBudget!.totalCapacityMm2,
            planDefaultArea!.analytics.forestReport!.loadBudget!.totalCapacityMm2,
            'live-store areaPerSupportMm2=20 survived partial settingsOverride merge into loadBudget',
        );

        // (2) undefined leafFanMaxAngleDeg override did NOT clobber live-store 20 back to default 45 (capped at 30° by grid branch angle)
        const reportWithFanDiag = {
            ...plan.analytics.forestReport!,
            diagnostics: {
                ...plan.analytics.forestReport!.diagnostics!,
                fanRefusals: { angle: 1 },
            },
        };
        const text = forestReportToText(reportWithFanDiag);
        assert.match(text, /angle=>20°/, 'live-store leafFanMaxAngleDeg=20 survived undefined override');
        const textOverride = forestReportToText(reportWithFanDiag, { leafFanMaxAngleDeg: 25 });
        assert.match(textOverride, /angle=>25°/, 'forestReportToText honors explicit autoSettings override');

        // (3) sizingPreset: 'detail' (0.8mm), modelScaleEnabled: false (factors=1), and tipContactMarginScale: 0.5 (0.46 * 0.5 = 0.23mm) took effect
        assert.equal(plan.analytics.sizingDebug?.sizeFactor, 1, 'modelScaleEnabled: false pinned sizeFactor to 1');
        assert.equal(plan.analytics.sizingDebug?.loadFactor, 1, 'modelScaleEnabled: false pinned loadFactor to 1');
        const placedTrunks = Object.values(plan.support.trunks).filter((t) => t.modelId === 'model-override');
        assert.ok(placedTrunks.length > 0, 'placed at least one trunk');
        for (const trunk of placedTrunks) {
            assert.equal(trunk.segments[0].diameter, SIZING_BANDS.detail.shaftDiameterMm,
                'trunk shaft uses overridden detail band (0.8mm) with modelScaleEnabled=false');
            const tipDia = trunk.contactCone?.profile?.contactDiameterMm ?? 0;
            // Note: syncContactConeDiameters raises contact to 30% of shaft (0.8 * 0.3 = 0.24mm), whereas uncapped anchor/structure would be >= 0.30-0.42mm.
            // Wait: let's also check candidate tip cap before sync on a 0.50mm rib with structure preset (0.50 * 0.5 = 0.25mm < 0.30mm) or check sizingDebug!
            assert.ok(tipDia <= 0.25, `tip contact reflects detail band + 0.5 margin cap (got ${tipDia})`);
        }

        // Direct check that tipContactMarginScale: 0.5 caps candidate tips below 0.95 margin scale on a 0.56mm rib under structure band:
        // On a 0.56mm rib with anchor band (shaft 1.4mm, tipContact 0.40mm -> 30% floor 0.42mm):
        // With margin 0.95 -> 0.56 * 0.95 = 0.532 >= 0.40 (uncapped -> synced to 0.42mm);
        // With margin 0.5 -> 0.56 * 0.5 = 0.28mm (< 0.40mm, capped!). And sizingDebugSample / candidate pre-sync uses capped tip!
        const rib60Geo = new THREE.BoxGeometry(30, 0.60, 2).translate(0, 0, 16).toNonIndexed();
        rib60Geo.computeVertexNormals();
        accelerateGeometry(rib60Geo);
        const rib60Mesh = new THREE.Mesh(rib60Geo, new THREE.MeshBasicMaterial());
        rib60Mesh.updateMatrixWorld(true);
        const island60: DetectedIsland = {
            id: 'rib60',
            source: 'voxel',
            contact: new THREE.Vector3(0, 0, 15),
            baseZ: 15,
            areaMm2: 4,
            surfaceNormal: { x: 0, y: 0, z: -1 },
        };
        const planTightScaled = computeAutoSupportPlan(
            [island60],
            'm-tight-s',
            { sizingPreset: 'structure', sizeScale: 0.75, modelScaleEnabled: false, tipContactMarginScale: 0.4, debugSkipAutoBracing: true, stabilizationEnabled: false, minimaReinforcementEnabled: false },
            undefined,
            rib60Mesh,
        );
        const planWideScaled = computeAutoSupportPlan(
            [island60],
            'm-wide-s',
            { sizingPreset: 'structure', sizeScale: 0.75, modelScaleEnabled: false, tipContactMarginScale: 0.95, debugSkipAutoBracing: true, stabilizationEnabled: false, minimaReinforcementEnabled: false },
            undefined,
            rib60Mesh,
        );
        const tightTip = Object.values(planTightScaled!.support.trunks)[0]?.contactCone?.profile?.contactDiameterMm ?? 0;
        const wideTip = Object.values(planWideScaled!.support.trunks)[0]?.contactCone?.profile?.contactDiameterMm ?? 0;
        assert.ok(tightTip < wideTip, `overridden tipContactMarginScale=0.4 (${tightTip}) caps tighter than 0.95 (${wideTip})`);
    } finally {
        updateAutoSupportSettings({ ...prevAuto });
    }
});
