import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveEffectiveDitherPolicy, type DitherPolicyInput } from '../resolveEffectiveDitherPolicy';

/**
 * The dither policy is the only place that reconciles the user's toggle with
 * the panel's declared bit depth. Getting the 8-bit case wrong is silent and
 * physically backwards: it quantizes a panel that can already emit every grey
 * level down to 7 bits, doubling the worst-case energy step between adjacent
 * levels at the default gamma.
 */
function policyInput(overrides: Partial<DitherPolicyInput> & { bits?: number | undefined } = {}) {
    const { bits, ...rest } = overrides;
    return {
        printerProfile: bits === undefined ? {} : { bitDepth: { bits } },
        materialProfile: {},
        ...rest,
    } as DitherPolicyInput;
}

test('a sub-8-bit panel forces dithering on at the panel bit depth', () => {
    const policy = resolveEffectiveDitherPolicy(policyInput({ bits: 3, ditherEnabled: false }));

    assert.equal(policy.ditherEnabled, true);
    assert.equal(policy.ditherBitDepth, 3);
});

test('an 8-bit panel forces dithering off even when the user turned it on', () => {
    const policy = resolveEffectiveDitherPolicy(policyInput({ bits: 8, ditherEnabled: true }));

    assert.equal(policy.ditherEnabled, false);
});

test('a panel deeper than 8 bits also forces dithering off instead of quantizing to 7', () => {
    for (const bits of [10, 12, 16]) {
        const policy = resolveEffectiveDitherPolicy(policyInput({ bits, ditherEnabled: true }));

        assert.equal(policy.ditherEnabled, false, `${bits}-bit panel should not dither`);
    }
});

test('an 8-bit panel never derives a bit depth from the panel itself', () => {
    // The old policy clamped the panel depth into 2..7, so an 8-bit display
    // silently produced a 7-bit palette.
    const policy = resolveEffectiveDitherPolicy(policyInput({ bits: 8, ditherBitDepth: 4 }));

    assert.equal(policy.ditherBitDepth, 4);
});

test('an undeclared panel bit depth leaves the toggle and depth to the user', () => {
    const enabled = resolveEffectiveDitherPolicy(policyInput({ ditherEnabled: true, ditherBitDepth: 5 }));
    assert.equal(enabled.ditherEnabled, true);
    assert.equal(enabled.ditherBitDepth, 5);

    const disabled = resolveEffectiveDitherPolicy(policyInput({ ditherEnabled: false }));
    assert.equal(disabled.ditherEnabled, false);
});

test('material anti-aliasing settings supply the fallback when the caller passes nothing', () => {
    const policy = resolveEffectiveDitherPolicy({
        printerProfile: {},
        materialProfile: {
            antiAliasingSettings: {
                ditherEnabled: true,
                ditherBitDepth: 6,
                ditherDeviceGamma: 2.2,
            },
        },
    } as DitherPolicyInput);

    assert.equal(policy.ditherEnabled, true);
    assert.equal(policy.ditherBitDepth, 6);
    assert.equal(policy.ditherDeviceGamma, 2.2);
});

test('device gamma is clamped to the range the engine accepts', () => {
    assert.equal(resolveEffectiveDitherPolicy(policyInput({ ditherDeviceGamma: 9 })).ditherDeviceGamma, 4.0);
    assert.equal(resolveEffectiveDitherPolicy(policyInput({ ditherDeviceGamma: 0.1 })).ditherDeviceGamma, 0.5);
});
