import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEffectiveAaSettings } from '../resolveEffectiveAaSettings';
import { MaterialAntiAliasingSettings } from '@/features/profiles/profileStore';

test('resolveEffectiveAaSettings correctly resolves AA/blur parameters based on overrides and sub-toggles', () => {
    // Pitch settings: 50um (0.05mm)
    const pxPitch = 0.05;

    // Scenario 1: enableOverride = false (Auto-AA active)
    // Slicing should fallback to auto-computed values (e.g. Balanced preset has Z-blur layers = 1, blur radius = 1)
    const autoSettings: MaterialAntiAliasingSettings = {
        enableOverride: false,
        enableCustomSettings: true,
        mode: '3DAA',
        level: '8x',
        blurBrushRadiusPx: 4,
        blurBrushSigmaX: 1.5,
        blurBrushSigmaY: 1.5,
        zBlurRadiusLayers: 3,
        zBlurSigma: 1.2,
        useCustomBlurBrushRadius: true,
        useCustomZBlurRadius: true,
    } as any;

    const res1 = resolveEffectiveAaSettings(autoSettings, 0.05, pxPitch);
    // Since enableOverride is false, custom levels and custom sigmas/radii MUST be ignored, falling back to auto configuration
    assert.strictEqual(res1.blurBrushRadiusPx, 1); // Auto computed Balanced radius
    assert.strictEqual(res1.zBlurRadiusLayers, 1); // Auto computed Balanced Z-blur layers
    assert.strictEqual(res1.blurBrushSigmaX, 0.5); // Default auto sigma
    assert.strictEqual(res1.zBlurSigma, 0.5); // Default auto Z sigma

    // Scenario 2: enableOverride = true, enableCustomSettings = false
    // Since enableCustomSettings = false, enableOverride is safety-coerced to false (Auto Balanced preset defaults)
    const presetSettings: MaterialAntiAliasingSettings = {
        enableOverride: true,
        enableCustomSettings: false,
        mode: '3DAA',
        level: '8x',
        blurBrushRadiusPx: 4,
        blurBrushSigmaX: 1.5,
        blurBrushSigmaY: 1.5,
        zBlurRadiusLayers: 3,
        zBlurSigma: 1.2,
        useCustomBlurBrushRadius: true,
        useCustomZBlurRadius: true,
    } as any;

    const res2 = resolveEffectiveAaSettings(presetSettings, 0.05, pxPitch);
    assert.strictEqual(res2.blurBrushRadiusPx, 1); // Balanced preset radius
    assert.strictEqual(res2.zBlurRadiusLayers, 1); // Balanced preset Z layers
    assert.strictEqual(res2.blurBrushSigmaX, 0.5); // Default preset sigma
    assert.strictEqual(res2.zBlurSigma, 0.5); // Default preset Z sigma

    // Scenario 3: enableOverride = true, enableCustomSettings = true, useCustomBlurBrushRadius = false
    // Should use custom values for Z-blur (since useCustomZBlurRadius is true) but preset defaults for XY-blur (since useCustomBlurBrushRadius is false)
    const mixedSettings: MaterialAntiAliasingSettings = {
        enableOverride: true,
        enableCustomSettings: true,
        mode: '3DAA',
        level: '4x', // Balanced preset (4 steps)
        blurBrushRadiusPx: 4,
        blurBrushSigmaX: 1.5,
        blurBrushSigmaY: 1.5,
        zBlurRadiusLayers: 3,
        zBlurSigma: 1.2,
        useCustomBlurBrushRadius: false,
        useCustomZBlurRadius: true,
    } as any;

    const res3 = resolveEffectiveAaSettings(mixedSettings, 0.05, pxPitch);
    assert.strictEqual(res3.blurBrushRadiusPx, 1); // Balanced preset radius (useCustomBlurBrushRadius = false)
    assert.strictEqual(res3.blurBrushSigmaX, 0.5); // Balanced preset sigma
    assert.strictEqual(res3.zBlurRadiusLayers, 3); // Custom Z layers (useCustomZBlurRadius = true)
    assert.strictEqual(res3.zBlurSigma, 1.2); // Custom Z sigma

    // Scenario 4: enableOverride = true, enableCustomSettings = true, useCustomBlurBrushRadius = true, useCustomZBlurRadius = true
    // Should fully apply custom values for both XY-blur and Z-blur
    const customSettings: MaterialAntiAliasingSettings = {
        enableOverride: true,
        enableCustomSettings: true,
        mode: '3DAA',
        level: '8x',
        blurBrushRadiusPx: 4,
        blurBrushSigmaX: 1.5,
        blurBrushSigmaY: 1.5,
        zBlurRadiusLayers: 3,
        zBlurSigma: 1.2,
        useCustomBlurBrushRadius: true,
        useCustomZBlurRadius: true,
    } as any;

    const res4 = resolveEffectiveAaSettings(customSettings, 0.05, pxPitch);
    assert.strictEqual(res4.blurBrushRadiusPx, 4); // Custom radius
    assert.strictEqual(res4.blurBrushSigmaX, 1.5); // Custom sigma
    assert.strictEqual(res4.zBlurRadiusLayers, 3); // Custom Z layers
    assert.strictEqual(res4.zBlurSigma, 1.2); // Custom Z sigma

    // Scenario 5: Dynamic tip penetration offset calculation in Automatic mode as Z-blur layers change
    const layerH = 0.05;
    const testAutoOffset = (zLayers: number) => {
        const s: MaterialAntiAliasingSettings = {
            enableOverride: true,
            enableCustomSettings: true,
            mode: '3DAA',
            zBlurRadiusLayers: zLayers,
            tipOffsetMode: 'auto',
            useCustomZBlurRadius: false, // Preset button clicked
        } as any;
        return resolveEffectiveAaSettings(s, layerH, pxPitch).tipOffsetMm;
    };

    assert.strictEqual(testAutoOffset(0), 0.050); // (2*0 + 1) * 0.05 = 0.050 mm
    assert.strictEqual(testAutoOffset(1), 0.150); // (2*1 + 1) * 0.05 = 0.150 mm
    assert.strictEqual(testAutoOffset(2), 0.250); // (2*2 + 1) * 0.05 = 0.250 mm
    assert.strictEqual(testAutoOffset(3), 0.350); // (2*3 + 1) * 0.05 = 0.350 mm
});
