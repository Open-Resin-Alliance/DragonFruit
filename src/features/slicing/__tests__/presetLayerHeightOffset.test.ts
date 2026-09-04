import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEffectiveAaSettings } from '../resolveEffectiveAaSettings';
import { computePhysicalAaConfig } from '../autoAaPhysics';
import { MaterialAntiAliasingSettings } from '@/features/profiles/profileStore';

test('Balanced and Smooth presets recalculate automatic tip penetration offset across varying layer heights', () => {
    const pitchX = 0.05; // 50um pixel pitch
    const pitchY = 0.05;

    // Test cases: varying layer heights from 0.025mm to 0.100mm
    const layerHeights = [0.025, 0.050, 0.075, 0.100];

    for (const layerH of layerHeights) {
        // Balanced Preset Test
        const balancedConfig = computePhysicalAaConfig('balanced', pitchX, layerH, pitchY);
        const balancedSettings: MaterialAntiAliasingSettings = {
            enableOverride: false, // Auto-AA active
            tipOffsetMode: 'auto',
        } as any;

        const resolvedBalanced = resolveEffectiveAaSettings(balancedSettings, layerH, pitchX, pitchY, 'balanced');

        const expectedBalancedZBlur = balancedConfig.zBlurRadiusLayers;
        const expectedBalancedOffset = Number(((2 * expectedBalancedZBlur + 1) * layerH).toFixed(3));

        assert.strictEqual(
            resolvedBalanced.tipOffsetMode,
            'auto',
            `Balanced preset at ${layerH}mm should resolve tipOffsetMode to auto`
        );
        assert.strictEqual(
            resolvedBalanced.tipOffsetMm,
            expectedBalancedOffset,
            `Balanced preset at ${layerH}mm should compute tipOffsetMm ${expectedBalancedOffset} (Z blur = ${expectedBalancedZBlur})`
        );

        // Smooth Preset Test
        const smoothConfig = computePhysicalAaConfig('smooth', pitchX, layerH, pitchY);
        const smoothSettings: MaterialAntiAliasingSettings = {
            enableOverride: false, // Auto-AA active
            tipOffsetMode: 'auto',
        } as any;

        const resolvedSmooth = resolveEffectiveAaSettings(smoothSettings, layerH, pitchX, pitchY, 'smooth');

        const expectedSmoothZBlur = smoothConfig.zBlurRadiusLayers;
        const expectedSmoothOffset = Number(((2 * expectedSmoothZBlur + 1) * layerH).toFixed(3));

        assert.strictEqual(
            resolvedSmooth.tipOffsetMode,
            'auto',
            `Smooth preset at ${layerH}mm should resolve tipOffsetMode to auto`
        );
        assert.strictEqual(
            resolvedSmooth.tipOffsetMm,
            expectedSmoothOffset,
            `Smooth preset at ${layerH}mm should compute tipOffsetMm ${expectedSmoothOffset} (Z blur = ${expectedSmoothZBlur})`
        );

        // Verify Smooth preset has >= penetration depth than Balanced preset due to deeper Z blur
        assert.ok(
            resolvedSmooth.tipOffsetMm >= resolvedBalanced.tipOffsetMm,
            `Smooth preset tip offset (${resolvedSmooth.tipOffsetMm}mm) should be >= Balanced offset (${resolvedBalanced.tipOffsetMm}mm)`
        );
    }
});
