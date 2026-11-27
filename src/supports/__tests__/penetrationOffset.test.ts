import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { calculateTipOffset } from '../rendering/calculateTipOffset';
import {
    DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
    addMaterialProfile,
    addPrinterProfile,
    getActiveMaterialProfile,
    getActivePrinterProfile,
    removeMaterialProfile,
    removePrinterProfile,
    setActiveMaterialProfile,
    setActivePrinterProfile,
    type MaterialAntiAliasingSettings,
} from '@/features/profiles/profileStore';
import { resolveEffectiveAaSettings } from '@/features/slicing/resolveEffectiveAaSettings';
import * as ContactConeTypes from '../SupportPrimitives/ContactCone/types';
import { buildConeSlotIndex } from '../instanced/coneSlots';
import { fillConeBatchSlot } from '../instanced/dragSlots';
import { appendConeGeometry } from '../exportGeometry/helpers';
import type { ContactCone } from '../SupportPrimitives/ContactCone/types';

test('calculateTipOffset correctly resolves penetration offset based on mode', () => {
    // 1. Test Disabled Mode (should default to 0.05 mm)
    const disabledSettings: MaterialAntiAliasingSettings = {
        tipOffsetMode: 'disabled',
        tipOffsetMm: 0.123,
        tipOffsetDisplayInUi: false,
        enableCustomSettings: true,
        enableOverride: true,
        mode: '3DAA',
        zBlurRadiusLayers: 2,
    } as any;
    
    assert.strictEqual(calculateTipOffset(disabledSettings, 0.05, 0.05), 0.05);

    // 2. Test Manual Mode (should return tipOffsetMm)
    const manualSettings: MaterialAntiAliasingSettings = {
        tipOffsetMode: 'manual',
        enableCustomSettings: true,
        enableOverride: true,
        tipOffsetMm: 0.150,
        tipOffsetDisplayInUi: false,
    } as any;

    assert.strictEqual(calculateTipOffset(manualSettings, 0.05, 0.05), 0.150);

    // 3. Test Auto Mode (2 * Rz + 1) * Hz
    // Hz = 0.05, Pxy = 0.05. Balanced preset has Rz = 1.
    // Offset = (2 * 1 + 1) * 0.05 = 3 * 0.05 = 0.150 mm
    const autoSettingsBalanced: MaterialAntiAliasingSettings = {
        tipOffsetMode: 'auto',
        tipOffsetMm: 0.05,
        tipOffsetDisplayInUi: false,
        enableCustomSettings: true,
        enableOverride: true,
        useCustomZBlurRadius: true,
        zBlurRadiusLayers: 1,
    } as any;

    assert.strictEqual(calculateTipOffset(autoSettingsBalanced, 0.05, 0.05), 0.150);

    // Hz = 0.04, Pxy = 0.02. Smooth preset has Rz = 3 (due to fine resolution pitch).
    // Offset = (2 * 3 + 1) * 0.04 = 7 * 0.04 = 0.280 mm
    const autoSettingsSmooth: MaterialAntiAliasingSettings = {
        tipOffsetMode: 'auto',
        tipOffsetMm: 0.05,
        tipOffsetDisplayInUi: false,
        enableCustomSettings: true,
        enableOverride: true,
        useCustomZBlurRadius: true,
        zBlurRadiusLayers: 3,
    } as any;

    assert.strictEqual(calculateTipOffset(autoSettingsSmooth, 0.04, 0.02), 0.280);
});

test('Override Auto off computes automatic offset despite stored Disabled or Manual', () => {
    for (const tipOffsetMode of ['disabled', 'manual'] as const) {
        const settings: MaterialAntiAliasingSettings = {
            ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
            enableCustomSettings: false,
            enableOverride: false,
            tipOffsetMode,
            tipOffsetMm: 0.7,
            zBlurRadiusLayers: 8,
        };
        assert.strictEqual(resolveEffectiveAaSettings(settings, 0.05, 0.019).tipOffsetMode, 'auto');
        assert.strictEqual(calculateTipOffset(settings, 0.05, 0.019), 0.25);
    }
});

function makeDiskCone(id: string, maxSafePenetrationMm?: number): ContactCone {
    return {
        id,
        pos: { x: 0, y: 0, z: 10 },
        normal: { x: 0, y: 0, z: -1 },
        surfaceNormal: { x: 0, y: 0, z: -1 },
        profile: {
            type: 'disk',
            contactDiameterMm: 0.4,
            bodyDiameterMm: 1.2,
            lengthMm: 3.0,
            penetrationMm: 0.25,
            diskThicknessMm: 0.1,
            maxStandoffMm: 0.25,
            standoffAngleThreshold: Math.PI / 4,
            ...(maxSafePenetrationMm !== undefined ? { maxSafePenetrationMm } : {}),
        },
    };
}

test('clampContactPenetration enforces finite non-negative ceiling when provided', () => {
    const clamp = (ContactConeTypes as {
        clampContactPenetration?: (penetrationMm: number, maxSafePenetrationMm?: number) => number;
    }).clampContactPenetration;
    assert.equal(typeof clamp, 'function', 'clampContactPenetration must be exported');

    assert.equal(clamp!(0.25, 0.09), 0.09);
    assert.equal(clamp!(0.05, 0.09), 0.05);
    assert.equal(clamp!(0.15, undefined), 0.15);
    assert.equal(clamp!(0.15, Number.NaN), 0.15);
    assert.equal(clamp!(0.15, Number.POSITIVE_INFINITY), 0.15);
    assert.equal(clamp!(0.15, 0), 0);
    assert.equal(clamp!(0.15, -0.05), 0);
    assert.equal(clamp!(-0.1, 0.09), 0);
    assert.equal(clamp!(Number.NaN, 0.09), 0);
    assert.equal(clamp!(Number.POSITIVE_INFINITY, 0.09), 0);
    assert.equal(clamp!(Number.NEGATIVE_INFINITY, undefined), 0);
});

test('buildConeSlotIndex preserves maxSafePenetrationMm and fillConeBatchSlot deletes stale clamps on reuse', () => {
    const capped = makeDiskCone('cone-capped', 0.09);
    const uncapped = makeDiskCone('cone-uncapped');

    const index = buildConeSlotIndex([
        { color: '#ffffff', cones: [capped, uncapped] },
    ]);
    assert.equal(index.slots.length, 2);
    assert.equal((index.slots[0].slot as { maxSafePenetrationMm?: number }).maxSafePenetrationMm, 0.09);
    assert.equal((index.slots[1].slot as { maxSafePenetrationMm?: number }).maxSafePenetrationMm, undefined);
    assert.equal('maxSafePenetrationMm' in index.slots[1].slot, false);

    const scratchSlot = {
        ...index.slots[1].slot,
        pos: { ...index.slots[1].slot.pos },
        normal: { ...index.slots[1].slot.normal },
        surfaceNormal: { ...index.slots[1].slot.surfaceNormal },
    };

    assert.equal(fillConeBatchSlot(scratchSlot, capped, 'sup-1', 'model-1'), true);
    assert.equal((scratchSlot as { maxSafePenetrationMm?: number }).maxSafePenetrationMm, 0.09);

    assert.equal(fillConeBatchSlot(scratchSlot, uncapped, 'sup-2', 'model-2'), true);
    assert.equal((scratchSlot as { maxSafePenetrationMm?: number }).maxSafePenetrationMm, undefined);
    assert.equal('maxSafePenetrationMm' in scratchSlot, false, 'stale maxSafePenetrationMm must be deleted on reuse');
});

test('appendConeGeometry clamps global penetration depth by cone.profile.maxSafePenetrationMm', () => {
    const prevPrinter = getActivePrinterProfile();
    const prevMaterial = getActiveMaterialProfile();
    const tempPrinterId = prevPrinter
        ? null
        : addPrinterProfile({ name: 'Test Printer', manufacturer: 'Test' });
    const printerId = prevPrinter?.id ?? tempPrinterId!;
    const tempMaterialId = addMaterialProfile(printerId, {
        name: 'Test Manual Penetration 0.25',
        layerHeightMm: 0.05,
        antiAliasingSettings: {
            ...DEFAULT_MATERIAL_ANTI_ALIASING_SETTINGS,
            enableCustomSettings: true,
            enableOverride: true,
            tipOffsetMode: 'manual',
            tipOffsetMm: 0.25,
            tipOffsetDisplayInUi: true,
        },
    });

    try {
        setActiveMaterialProfile(tempMaterialId);

        const cappedGroup = new THREE.Group();
        const cappedCone = makeDiskCone('export-capped', 0.06);
        appendConeGeometry(cappedGroup, cappedCone);

        const cappedConeGroup = cappedGroup.children[0] as THREE.Group;
        const cappedTipSphere = cappedConeGroup.children[1] as THREE.Mesh;
        // surfaceNormal = (0, 0, -1), primitiveThickness = max(0.10, 0.4 / 2) = 0.20, clamped pen = 0.06 -> z = 10 - 0.20 + 0.06 = 9.86
        assert.ok(Math.abs(cappedTipSphere.position.z - 9.86) < 1e-6, `expected cone tip z 9.86, got ${cappedTipSphere.position.z}`);

        const cappedDiskGroup = cappedGroup.children[1] as THREE.Group;
        const cappedDiskShaft = cappedDiskGroup.children[0] as THREE.Mesh;
        const cappedShaftHeight = (cappedDiskShaft.geometry as THREE.CylinderGeometry).parameters.height;
        assert.ok(Math.abs(cappedShaftHeight - 0.26) < 1e-6, `expected clamped disk height 0.26, got ${cappedShaftHeight}`);
        assert.ok(Math.abs(cappedDiskShaft.position.y - (-0.03)) < 1e-6, `expected clamped shaft y -0.03, got ${cappedDiskShaft.position.y}`);

        const uncappedGroup = new THREE.Group();
        const uncappedCone = makeDiskCone('export-uncapped');
        appendConeGeometry(uncappedGroup, uncappedCone);

        const uncappedConeGroup = uncappedGroup.children[0] as THREE.Group;
        const uncappedTipSphere = uncappedConeGroup.children[1] as THREE.Mesh;
        // uncapped pen = 0.25 -> z = 10 - 0.20 + 0.25 = 10.05
        assert.ok(Math.abs(uncappedTipSphere.position.z - 10.05) < 1e-6, `expected uncapped cone tip z 10.05, got ${uncappedTipSphere.position.z}`);

        const uncappedDiskGroup = uncappedGroup.children[1] as THREE.Group;
        const uncappedDiskShaft = uncappedDiskGroup.children[0] as THREE.Mesh;
        const uncappedShaftHeight = (uncappedDiskShaft.geometry as THREE.CylinderGeometry).parameters.height;
        assert.ok(Math.abs(uncappedShaftHeight - 0.45) < 1e-6, `expected uncapped disk height 0.45, got ${uncappedShaftHeight}`);
    } finally {
        if (prevPrinter) setActivePrinterProfile(prevPrinter.id);
        if (prevMaterial) setActiveMaterialProfile(prevMaterial.id);
        removeMaterialProfile(tempMaterialId);
        if (tempPrinterId) removePrinterProfile(tempPrinterId);
    }
});
