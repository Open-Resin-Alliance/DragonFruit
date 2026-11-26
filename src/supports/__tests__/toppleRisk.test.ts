import assert from 'node:assert/strict';
import test from 'node:test';

import {
    evaluateToppleRisk,
    ROCKING_THRESHOLD_MM,
    TOPPLE_ADHESION_THRESHOLD_MPA,
    toppleRiskNeedsCoverage,
} from '../autoSupport/toppleRisk';
import { NOMINAL_PEEL_PRESSURE_MPA } from '../autoSupport/treeSynthesis';
import { referenceStefanMeanPressureMm2 } from '../autoSupport/tractionOptimization';
import type { RepresentativeLayerProfile } from '../autoSupport/tractionOptimization';

/** A 10 × 10 field with one pressurised cell at (3.5, 0.5) and a mean pressure
 *  equal to the 10 mm² reference, so the traction factor is exactly 1 and the
 *  100 mm² layer carries `100 × NOMINAL_PEEL_PRESSURE_MPA` N. */
function unitForceProfile(): RepresentativeLayerProfile {
    const pRef = referenceStefanMeanPressureMm2(10);
    const pressure = new Float32Array(100);
    pressure[5 * 10 + 8] = 1;
    return {
        layers: [{
            zMm: 10,
            areaMm2: 100,
            areaJumpRatio: 1,
            clusterSpanCount: 1,
            stefanField: {
                minX: -5, minY: -5, cellMm: 1, nx: 10, ny: 10,
                pressure,
                peakPressureMm2: 1,
                meanPressureMm2: 0.01,
                integratedForceMm4: pRef * 100,
                maskAreaMm2: 100,
            },
        }],
        samples: [{ zMm: 10, areaMm2: 100 }],
        peakAreaMm2: 100,
        sampledPlaneCount: 1,
    };
}

const EDGE = { point: { x: 10, y: 0 }, normal: { x: 1, y: 0 } };

test('the solved peel moment uses the field centre of pressure as its lever', () => {
    const risk = evaluateToppleRisk({
        profile: unitForceProfile(),
        centroid: { x: 0.5, y: 0 },
        edge: EDGE,
        bearingAreaMm2: 100,
        contactDepthMm: 10,
    });
    const forceN = 100 * NOMINAL_PEEL_PRESSURE_MPA;
    assert.ok(Math.abs(risk.peakLayerForceN - forceN) < 1e-6, `force ${risk.peakLayerForceN}`);
    // CoP at (3.5, 0.5): depth from the edge line x=10 is 6.5 mm.
    assert.ok(Math.abs(risk.peelMomentNmm - forceN * 6.5) < 1e-3, `moment ${risk.peelMomentNmm}`);
    assert.ok(Math.abs(risk.requiredAdhesionMpa - (forceN * 6.5) / (100 * 10)) < 1e-9,
        `required ${risk.requiredAdhesionMpa}`);
    assert.ok(Math.abs(risk.comDepthMm - 9.5) < 1e-9, `COM depth ${risk.comDepthMm}`);
    assert.equal(risk.outcome, 'adhesionBound');
});

test('a centre of mass past the edge and a rocking frame are distinct outcomes', () => {
    const base = {
        profile: unitForceProfile(),
        edge: EDGE,
        bearingAreaMm2: 100,
        contactDepthMm: 10,
    };
    const past = evaluateToppleRisk({ ...base, centroid: { x: 11, y: 0 } });
    assert.ok(past.comDepthMm < 0);
    assert.equal(past.outcome, 'pastEdge');

    const rocking = evaluateToppleRisk({
        ...base,
        centroid: { x: 0, y: 0 },
        frameRockingMm: ROCKING_THRESHOLD_MM + 0.01,
    });
    assert.equal(rocking.outcome, 'rocking');
});

test('without a solved field the demand acts at the bearing patch lever', () => {
    const profile: RepresentativeLayerProfile = {
        layers: [{ zMm: 10, areaMm2: 100, areaJumpRatio: 1, clusterSpanCount: 1 }],
        samples: [{ zMm: 10, areaMm2: 100 }],
        peakAreaMm2: 100,
        sampledPlaneCount: 1,
    };
    const risk = evaluateToppleRisk({
        profile,
        centroid: { x: 0, y: 0 },
        edge: EDGE,
        bearingAreaMm2: 100,
        contactDepthMm: 10,
    });
    // 100 mm² at the nominal calibration is `100 × NOMINAL_PEEL_PRESSURE_MPA` N,
    // acting 10 mm inside the edge.
    const forceN = 100 * NOMINAL_PEEL_PRESSURE_MPA;
    assert.ok(Math.abs(risk.peakLayerForceN - forceN) < 1e-3, `force ${risk.peakLayerForceN}`);
    assert.ok(Math.abs(risk.peelMomentNmm - forceN * 10) < 1e-2, `moment ${risk.peelMomentNmm}`);
});

test('multi-layer profiles take the worst single layer rather than summing across layers', () => {
    const base = unitForceProfile();
    const multiLayer = {
        ...base,
        samples: [
            { zMm: 5, areaMm2: 100 },
            { zMm: 10, areaMm2: 100 },
            { zMm: 15, areaMm2: 100 },
        ],
    };
    const risk = evaluateToppleRisk({
        profile: multiLayer,
        centroid: { x: 0.5, y: 0 },
        edge: EDGE,
        bearingAreaMm2: 100,
        contactDepthMm: 10,
    });
    const forceN = 100 * NOMINAL_PEEL_PRESSURE_MPA;
    assert.ok(Math.abs(risk.peakLayerForceN - forceN) < 1e-6, `worst single-layer force ${risk.peakLayerForceN}`);
    assert.ok(Math.abs(risk.peelMomentNmm - forceN * 6.5) < 1e-3, `worst single-layer moment ${risk.peelMomentNmm}`);
});

test('zero bearing area with non-zero peel requires infinite adhesion and needs coverage', () => {
    const risk = evaluateToppleRisk({
        profile: unitForceProfile(),
        centroid: { x: 0, y: 0 },
        edge: EDGE,
        bearingAreaMm2: 0,
        contactDepthMm: 0,
    });
    assert.equal(risk.requiredAdhesionMpa, Number.POSITIVE_INFINITY);
    assert.equal(toppleRiskNeedsCoverage(risk), true);
});

test('toppleRiskNeedsCoverage triggers on pastEdge or adhesion, not elastic rocking', () => {
    const safe = {
        comDepthMm: 5,
        peelMomentNmm: 1,
        peakLayerForceN: 0.5,
        requiredAdhesionMpa: TOPPLE_ADHESION_THRESHOLD_MPA * 0.5,
        complianceMm: 0.02,
        outcome: 'adhesionBound' as const,
    };
    assert.equal(toppleRiskNeedsCoverage(safe), false);
    assert.equal(toppleRiskNeedsCoverage({ ...safe, requiredAdhesionMpa: TOPPLE_ADHESION_THRESHOLD_MPA }), true);
    assert.equal(toppleRiskNeedsCoverage({ ...safe, outcome: 'rocking' }), false, 'elastic flex does not gate anti-topple coverage');
    assert.equal(toppleRiskNeedsCoverage({ ...safe, outcome: 'pastEdge', comDepthMm: -1 }), true);
});
