import assert from 'node:assert/strict';
import test from 'node:test';

import {
    greenModulusFromCantilever,
    greenUtsFromContactPullOff,
    NOMINAL_PEEL_REFERENCE_AREA_MM2,
    peelPressureFromPullOff,
    peelTractionFactorForArea,
    roundBarInertiaMm4,
} from '../autoSupport/greenMaterialCalibration';

function close(actual: number | null, expected: number, tolerance: number, label: string): void {
    assert.ok(actual !== null && Math.abs(actual - expected) < tolerance,
        `${label}: ${actual} vs ${expected}`);
}

test('the traction factor is 1 at the reference coupon and clamps above it', () => {
    assert.equal(peelTractionFactorForArea(NOMINAL_PEEL_REFERENCE_AREA_MM2), 1);
    // 0.50 + 0.50·59.85^0.22 = 1.73 → clamped.
    assert.equal(peelTractionFactorForArea(598.5), 1.55);
});

test('pull-off on a reference coupon reads the nominal pressure directly', () => {
    close(peelPressureFromPullOff({ forceN: 0.15, couponAreaMm2: 10 }), 0.015, 1e-12, 'pressure');
});

test('the Cao et al. coupon calibrates a 45 kPa saturated layer traction', () => {
    // 31.7 N peak on a 706.85 mm² coupon (damage initiation, 0.4 mm lift).
    const pressureMpa = peelPressureFromPullOff({ forceN: 31.7, couponAreaMm2: 706.85 });
    assert.ok(pressureMpa !== null);
    const saturated = pressureMpa * peelTractionFactorForArea(706.85);
    close(saturated, 31.7 / 706.85, 1e-6, 'saturated traction (MPa)');
});

test('a larger coupon is inverted through the traction factor it measured', () => {
    const areaMm2 = 100;
    const pRef = 0.015;
    const measuredN = areaMm2 * peelTractionFactorForArea(areaMm2) * pRef;
    close(peelPressureFromPullOff({ forceN: measuredN, couponAreaMm2: areaMm2 }), pRef, 1e-12, 'pressure');
});

test('a measured cantilever deflection inverts to the modulus it was printed at', () => {
    const modulusMpa = 850;
    const forceN = 0.1;
    const lengthMm = 20;
    const diameterMm = 1;
    const deflectionMm = (forceN * lengthMm ** 3) / (3 * modulusMpa * roundBarInertiaMm4(diameterMm));
    close(greenModulusFromCantilever({ forceN, lengthMm, diameterMm, deflectionMm }), modulusMpa, 1e-9, 'modulus');
});

test('a contact pull-off reads the green UTS', () => {
    // 0.28 mm tip at 12 MPa holds π·0.14²·12.
    const forceN = Math.PI * 0.14 ** 2 * 12;
    close(greenUtsFromContactPullOff({ forceN, contactDiameterMm: 0.28 }), 12, 1e-9, 'uts');
});

test('measurements that cannot be physical return null instead of zero', () => {
    assert.equal(peelPressureFromPullOff({ forceN: 0, couponAreaMm2: 10 }), null);
    assert.equal(peelPressureFromPullOff({ forceN: 1, couponAreaMm2: 0 }), null);
    assert.equal(greenModulusFromCantilever({ forceN: 0.1, lengthMm: 0, diameterMm: 1, deflectionMm: 1 }), null);
    assert.equal(greenUtsFromContactPullOff({ forceN: 1, contactDiameterMm: 0 }), null);
});
