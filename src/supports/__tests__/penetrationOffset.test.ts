import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTipOffset } from '../rendering/calculateTipOffset';
import { MaterialAntiAliasingSettings } from '@/features/profiles/profileStore';

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
        useCustomZBlurRadius: true,
        zBlurRadiusLayers: 3,
    } as any;

    assert.strictEqual(calculateTipOffset(autoSettingsSmooth, 0.04, 0.02), 0.280);
});
