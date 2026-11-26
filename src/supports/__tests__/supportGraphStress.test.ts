import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { initializeBVH, accelerateGeometry } from '@/utils/bvh';
import { footprintFromPoints } from '@/volumeAnalysis/Islands/voxelFootprint';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import type { SupportState } from '../types';
import { createDefaultSettings } from '../Settings/types';
import { getSettings, setSettings } from '../Settings/state';
import { resetKickstandsInState, resetStore } from '../state';
import { computeAutoSupportPlan, forestReportToText } from '../autoSupport/autoPlace';
import {
    buildSupportGraph,
    rigidBodyRockingMm,
    computePeelLayerSamples,
    distributeRigidBodyPeelLoads,
    distributeRigidBodyDragLoads,
    biaxialContactStressMpa,
    reinforceOverloadedFrameMembers,
    reinforcementDiameterCapMm,
    solveSupportFrameStress,
    type SupportFrameStressReport,
} from '../autoSupport/supportGraphStress';
import { DEFAULT_SUPPORT_BREAK_STRENGTH_MPA } from '../autoSupport/greenMaterialCalibration';
import { GREEN_RESIN_MODULUS_MPA, NOMINAL_PEEL_PRESSURE_MPA } from '../autoSupport/treeSynthesis';
import { referenceStefanMeanPressureMm2, type RepresentativeLayerProfile } from '../autoSupport/tractionOptimization';

test('buildSupportGraph splits trunk shafts at branch and brace knots cleanly', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rA: { id: 'rA', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
            rB: { id: 'rB', modelId: 'm', transform: { pos: { x: 4, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tA: {
                id: 'tA',
                modelId: 'm',
                rootId: 'rA',
                segments: [
                    {
                        id: 'segA',
                        diameter: 1.0,
                        bottomJoint: { id: 'jA0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.0 },
                        topJoint: { id: 'jA1', pos: { x: 0, y: 0, z: 20 }, diameter: 1.0 },
                    },
                ],
                contactCone: {
                    id: 'cA',
                    pos: { x: 0, y: 0, z: 22.5 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
                },
            } as never,
            tB: {
                id: 'tB',
                modelId: 'm',
                rootId: 'rB',
                segments: [
                    {
                        id: 'segB',
                        diameter: 1.0,
                        bottomJoint: { id: 'jB0', pos: { x: 4, y: 0, z: 1 }, diameter: 1.0 },
                        topJoint: { id: 'jB1', pos: { x: 4, y: 0, z: 20 }, diameter: 1.0 },
                    },
                ],
                contactCone: {
                    id: 'cB',
                    pos: { x: 4, y: 0, z: 22.5 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
                },
            } as never,
        },
        knots: {
            kAB: { id: 'kAB', parentShaftId: 'segA', t: 0.5, pos: { x: 0, y: 0, z: 10.5 }, diameter: 1.1 } as never,
            kBA: { id: 'kBA', parentShaftId: 'segB', t: 0.5, pos: { x: 4, y: 0, z: 10.5 }, diameter: 1.1 } as never,
        },
        braces: {
            br1: {
                id: 'br1',
                modelId: 'm',
                startKnotId: 'kAB',
                endKnotId: 'kBA',
                profile: { diameter: 0.9 },
            } as never,
        },
        leaves: {
            l1: {
                id: 'l1',
                modelId: 'm',
                parentKnotId: 'kAB',
                contactCone: {
                    id: 'cL1',
                    pos: { x: -2, y: 0, z: 14 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.25, bodyDiameterMm: 0.9, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
                },
            } as never,
        },
    };

    const graph = buildSupportGraph(draft, 'm');
    assert.equal(graph.rootCount, 2, 'both trunk plate roots grounded');
    assert.equal(graph.tipCount, 3, 'two trunk tips plus one leaf tip');
    assert.equal(graph.braceCount, 1, 'one brace strut recorded');
    // Each split trunk contributes 2 shaft sub-members + 1 effective cone
    // member = 3; two trunks + 1 brace + 1 leaf = 8.
    assert.equal(graph.members.length, 8, 'splits both host trunk segments at their brace/leaf knots');
    const cones = graph.members.filter((member) => member.role === 'cone');
    assert.equal(cones.length, 2, 'each trunk cone keeps one stiffness member');
    for (const cone of cones) {
        assert.equal(cone.taperBodyDiameterMm, 1.0);
        assert.equal(cone.taperTipDiameterMm, 0.28);
        assert.equal(cone.diameterMm, 0.7, 'stiffness keeps the effective 0.7 x body diameter');
    }
});

test('a knot within 0.5 mm of a shaft end welds into it instead of splitting a stub', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rA: { id: 'rA', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tA: {
                id: 'tA',
                modelId: 'm',
                rootId: 'rA',
                segments: [
                    {
                        id: 'segA',
                        diameter: 2.2,
                        bottomJoint: { id: 'jA0', pos: { x: 0, y: 0, z: 1 }, diameter: 2.2 },
                        topJoint: { id: 'jA1', pos: { x: 0, y: 0, z: 20 }, diameter: 2.2 },
                    },
                ],
                contactCone: {
                    id: 'cA',
                    pos: { x: 0, y: 0, z: 22.5 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 2.2, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
                },
            } as never,
        },
        knots: {
            kNear: { id: 'kNear', parentShaftId: 'segA', t: 0.94, pos: { x: 0, y: 0, z: 19.8 }, diameter: 2.2 } as never,
        },
        leaves: {
            l1: {
                id: 'l1',
                modelId: 'm',
                parentKnotId: 'kNear',
                contactCone: {
                    id: 'cL1',
                    pos: { x: 3, y: 0, z: 20 },
                    normal: { x: 0, y: 0, z: -1 },
                    profile: { type: 'disk', contactDiameterMm: 0.25, bodyDiameterMm: 0.9, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 },
                },
            } as never,
        },
    };

    const graph = buildSupportGraph(draft, 'm');
    const trunkShaft = graph.members.filter((m) => m.entityId === 'tA' && m.lengthMm > 10);
    assert.equal(trunkShaft.length, 1, 'the shaft is one member, not a 0.2 mm stub plus a long span');
    assert.ok(graph.members.every((m) => m.lengthMm >= 0.5), 'no sub-millimetre member survives');
    const leafMember = graph.members.find((m) => m.entityId === 'l1');
    assert.ok(leafMember, 'the leaf hosts at the welded shaft end');
    assert.equal(leafMember.nodeA, trunkShaft[0].nodeB, 'leaf and shaft share the welded node');
});

test('a broad plate contact takes most of the rigid peel load out of the supports', () => {
    const supports = [
        { x: -5, y: 0, contactDiameterMm: 0.28 },
        { x: 5, y: 0, contactDiameterMm: 0.28 },
    ];
    const withoutPlate = distributeRigidBodyPeelLoads(supports, 1, 0, 0);
    const withPlate = distributeRigidBodyPeelLoads(
        [...supports, { x: 0, y: 0, contactDiameterMm: 20 }],
        1,
        0,
        0,
    );
    assert.ok(withoutPlate[0] > 0.4, 'the two supports split the peel');
    assert.ok(withPlate[0] < withoutPlate[0] * 0.01, 'the plate contact carries the share');
    assert.ok(withPlate[0] + withPlate[1] + withPlate[2] > 0.999, 'equilibrium is preserved');
});

test('distributeRigidBodyPeelLoads distributes centered uniformly, shifts off-center load, and clamps compression', () => {
    const symmetric = [
        { x: -5, y: 0, contactDiameterMm: 0.3 },
        { x: 5, y: 0, contactDiameterMm: 0.3 },
    ];
    const even = distributeRigidBodyPeelLoads(symmetric, 1.0, 0, 0);
    assert.ok(Math.abs(even[0] - 0.5) < 1e-4 && Math.abs(even[1] - 0.5) < 1e-4, 'centered CoP splits 50/50');

    // CoP shifted right to x=+2 => right support takes ~70%, left takes ~30%.
    const shifted = distributeRigidBodyPeelLoads(symmetric, 1.0, 2, 0);
    assert.ok(shifted[1] > shifted[0] && Math.abs(shifted[0] + shifted[1] - 1.0) < 1e-4, 'moment balance increases right tip load');

    // CoP outside right edge (x=+8): active-set clamp zeroes left tip so all 1.0 N goes to right tip.
    const overhang = distributeRigidBodyPeelLoads(symmetric, 1.0, 8, 0);
    assert.equal(overhang[0], 0, 'negative compressive reaction clamped out of tensile peel set');
    assert.ok(Math.abs(overhang[1] - 1.0) < 1e-4, 'remaining tensile tip carries 100% of net peel force');
});

test('distributeRigidBodyDragLoads shares lateral drag by stiffness within a rigid component', () => {
    const dx = Math.SQRT1_2;
    const dy = Math.SQRT1_2;
    // Stiffness 4:1; vertical loads place the CoP on the stiffness centroid
    // (x = -0.6), so the plate translates without rotating.
    const tips = [
        { x: -1, y: 0, contactDiameterMm: 0.5 },
        { x: 1, y: 0, contactDiameterMm: 0.25 },
    ];
    const vertical = new Float64Array([1, 0.25]);
    const out = distributeRigidBodyDragLoads(tips, vertical, null, 0.08, dx, dy);
    const along = (i: number) => out.fx[i] * dx + out.fy[i] * dy;
    const total = vertical[0] + vertical[1];
    assert.ok(Math.abs(along(0) + along(1) - total * 0.08) < 1e-9, 'the component carries its own drag total');
    assert.ok(Math.abs(along(0) / along(1) - 4) < 1e-6, `stiff tip takes 4x (${along(0)} vs ${along(1)})`);
    const cross = tips[0].x * out.fy[0] - tips[0].y * out.fx[0]
        + tips[1].x * out.fy[1] - tips[1].y * out.fx[1];
    const copX = (tips[0].x * vertical[0] + tips[1].x * vertical[1]) / total;
    assert.ok(Math.abs(cross - total * 0.08 * (copX * dy)) < 1e-9,
        'the resultant acts through the load centre');
});

test('distributeRigidBodyDragLoads conserves force and moment for an asymmetric plate', () => {
    const dx = Math.cos(0.4);
    const dy = Math.sin(0.4);
    const tips = [
        { x: -2, y: 1, contactDiameterMm: 0.5 },
        { x: 0, y: -1, contactDiameterMm: 0.25 },
        { x: 3, y: 0.5, contactDiameterMm: 0.35 },
    ];
    const vertical = new Float64Array([1, 2, 0.5]);
    const totalVertical = vertical[0] + vertical[1] + vertical[2];
    const copX = (tips[0].x * vertical[0] + tips[1].x * vertical[1] + tips[2].x * vertical[2]) / totalVertical;
    const copY = (tips[0].y * vertical[0] + tips[1].y * vertical[1] + tips[2].y * vertical[2]) / totalVertical;
    const out = distributeRigidBodyDragLoads(tips, vertical, null, 0.08, dx, dy);

    const totalDrag = totalVertical * 0.08;
    let fx = 0, fy = 0, moment = 0;
    for (let i = 0; i < tips.length; i++) {
        fx += out.fx[i];
        fy += out.fy[i];
        moment += tips[i].x * out.fy[i] - tips[i].y * out.fx[i];
    }
    assert.ok(Math.abs(fx - totalDrag * dx) < 1e-9, `sum Fx ${fx}`);
    assert.ok(Math.abs(fy - totalDrag * dy) < 1e-9, `sum Fy ${fy}`);
    assert.ok(Math.abs(moment - totalDrag * (copX * dy - copY * dx)) < 1e-4, `moment ${moment}`);
});

test('distributeRigidBodyDragLoads does not couple disconnected cross-section components', () => {
    const dx = 1;
    const dy = 0;
    const tips = [
        { x: -1, y: 0, contactDiameterMm: 0.3 },
        { x: 1, y: 0, contactDiameterMm: 0.3 },
    ];
    const vertical = new Float64Array([1, 3]);
    const out = distributeRigidBodyDragLoads(tips, vertical, new Int32Array([0, 1]), 0.08, dx, dy);
    assert.ok(Math.abs(out.fx[0] - 0.08) < 1e-9, `first component ${out.fx[0]}`);
    assert.ok(Math.abs(out.fx[1] - 0.24) < 1e-9, `second component ${out.fx[1]}`);
    assert.ok(Math.abs(out.fy[0]) < 1e-9 && Math.abs(out.fy[1]) < 1e-9, 'drag is along its own axis');
});

test('biaxialContactStressMpa counts normal peel and √3-scaled lateral shear', () => {
    const diameter = 0.28;
    const area = Math.PI * 0.25 * diameter * diameter;
    // Pure peel at the break load reproduces the break strength.
    assert.ok(Math.abs(biaxialContactStressMpa(4.8 * area, 0, diameter) - 4.8) < 1e-9);
    // Pure shear of the same magnitude counts √3×.
    assert.ok(Math.abs(biaxialContactStressMpa(0, 4.8 * area, diameter) - 4.8 * Math.sqrt(3)) < 1e-9);
    // Combined follows the von Mises form.
    const expected = Math.hypot(0.1 / area, Math.sqrt(3) * 0.05 / area);
    assert.ok(Math.abs(biaxialContactStressMpa(0.1, 0.05, diameter) - expected) < 1e-9);
    // A compressive normal load does not offset the shear.
    assert.ok(Math.abs(biaxialContactStressMpa(-1, 0.05, diameter)
        - biaxialContactStressMpa(0, 0.05, diameter)) < 1e-12);
});

test('3D beam frame solver reproduces exact analytical Euler-Bernoulli cantilever deflection and bending stress', () => {
    const L = 10.0;
    const d = 1.0;
    const F = 0.20;
    const graph = {
        nodes: [
            { id: 'n-0', pos: { x: 0, y: 0, z: 0 }, kind: 'root' as const, fixed: true },
            { id: 'n-1', pos: { x: 0, y: 0, z: L }, kind: 'tip' as const, fixed: false, entityId: 't-bench', entityKind: 'trunk' as const, tipContactDiameterMm: d },
        ],
        members: [
            { id: 'm-0', entityId: 't-bench', entityKind: 'trunk' as const, nodeA: 0, nodeB: 1, lengthMm: L, diameterMm: d, angleFromVerticalDeg: 0 },
        ],
        rootCount: 1,
        tipCount: 1,
        braceCount: 0,
    };

    const report = solveSupportFrameStress(graph, undefined, {
        explicitNodalLoads: new Map([[1, [F, 0, 0, 0, 0, 0]]]),
    });

    const I = (Math.PI * (d ** 4)) / 64;
    const expectedDefl = (F * (L ** 3)) / (3 * GREEN_RESIN_MODULUS_MPA * I);
    const expectedSigmaMpa = (F * L * (0.5 * d)) / I;
    const expectedUtilPct = (100 * expectedSigmaMpa) / DEFAULT_SUPPORT_BREAK_STRENGTH_MPA;

    assert.equal(report.solverMode, 'frame3d');
    const relDeflErr = Math.abs(report.maxTipDeflectionMm - expectedDefl) / expectedDefl;
    const relStressErr = Math.abs(report.maxMemberUtilizationPct - expectedUtilPct) / expectedUtilPct;
    assert.ok(relDeflErr < 0.005, `tip deflection matches FL³/3EI within 0.5% (got ${report.maxTipDeflectionMm.toFixed(4)} vs ${expectedDefl.toFixed(4)})`);
    assert.ok(relStressErr < 0.005, `bending utilization matches FLc/I within 0.5% (got ${report.maxMemberUtilizationPct.toFixed(2)}% vs ${expectedUtilPct.toFixed(2)}%)`);
});

test('3D beam frame solver quantifies bracing stiffness reduction under lateral peel load', () => {
    const makePair = (braced: boolean): SupportState => ({
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rA: { id: 'rA', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
            rB: { id: 'rB', modelId: 'm', transform: { pos: { x: 5, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tA: {
                id: 'tA', modelId: 'm', rootId: 'rA',
                segments: [{ id: 'sA', diameter: 1.0, bottomJoint: { id: 'jA0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'jA1', pos: { x: 0, y: 0, z: 22 }, diameter: 1.0 } }],
                contactCone: { id: 'cA', pos: { x: 0, y: 0, z: 24.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
            tB: {
                id: 'tB', modelId: 'm', rootId: 'rB',
                segments: [{ id: 'sB', diameter: 1.0, bottomJoint: { id: 'jB0', pos: { x: 5, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'jB1', pos: { x: 5, y: 0, z: 22 }, diameter: 1.0 } }],
                contactCone: { id: 'cB', pos: { x: 5, y: 0, z: 24.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.3, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
        knots: braced ? {
            kA1: { id: 'kA1', parentShaftId: 'sA', t: 0.2, pos: { x: 0, y: 0, z: 5.2 }, diameter: 1.1 } as never,
            kB2: { id: 'kB2', parentShaftId: 'sB', t: 0.5, pos: { x: 5, y: 0, z: 11.5 }, diameter: 1.1 } as never,
            kB1: { id: 'kB1', parentShaftId: 'sB', t: 0.2, pos: { x: 5, y: 0, z: 5.2 }, diameter: 1.1 } as never,
            kA2: { id: 'kA2', parentShaftId: 'sA', t: 0.5, pos: { x: 0, y: 0, z: 11.5 }, diameter: 1.1 } as never,
        } : {},
        braces: braced ? {
            x1: { id: 'x1', modelId: 'm', startKnotId: 'kA1', endKnotId: 'kB2', profile: { diameter: 0.9 } } as never,
            x2: { id: 'x2', modelId: 'm', startKnotId: 'kB1', endKnotId: 'kA2', profile: { diameter: 0.9 } } as never,
        } : {},
    });

    const unbracedGraph = buildSupportGraph(makePair(false), 'm');
    const bracedGraph = buildSupportGraph(makePair(true), 'm');
    const loadsUnbraced = new Map<number, readonly [number, number, number, number, number, number]>();
    const loadsBraced = new Map<number, readonly [number, number, number, number, number, number]>();
    for (const [g, m] of [[unbracedGraph, loadsUnbraced], [bracedGraph, loadsBraced]] as const) {
        g.nodes.forEach((n, idx) => {
            if (n.kind === 'tip') m.set(idx, [0.15, 0, 0.30, 0, 0, 0]);
        });
    }

    const unbraced = solveSupportFrameStress(unbracedGraph, undefined, { explicitNodalLoads: loadsUnbraced });
    const braced = solveSupportFrameStress(bracedGraph, undefined, { explicitNodalLoads: loadsBraced });

    assert.ok(braced.maxTipDeflectionMm < unbraced.maxTipDeflectionMm * 0.5,
        `X-bracing sharply reduces lateral tip deflection (${braced.maxTipDeflectionMm.toFixed(3)}mm vs ${unbraced.maxTipDeflectionMm.toFixed(3)}mm)`);
    assert.ok(braced.maxMemberUtilizationPct < unbraced.maxMemberUtilizationPct,
        `X-bracing lowers peak member bending stress (${braced.maxMemberUtilizationPct.toFixed(1)}% vs ${unbraced.maxMemberUtilizationPct.toFixed(1)}%)`);

    // Rocking is the differential across contacts, not a single tip's sag: the
    // same load on two identical towers displaces both alike, so the range is
    // ~zero even though each tip deflects.
    assert.ok(unbraced.maxTipRockingMm < 1e-3,
        `symmetric contacts do not rock (${unbraced.maxTipRockingMm})`);

    const loadsAsym = new Map<number, readonly [number, number, number, number, number, number]>();
    unbracedGraph.nodes.forEach((node, idx) => {
        if (node.kind === 'tip' && node.pos.x < 1) loadsAsym.set(idx, [0.15, 0, 0.30, 0, 0, 0]);
    });
    const asym = solveSupportFrameStress(unbracedGraph, undefined, { explicitNodalLoads: loadsAsym });
    assert.ok(asym.maxTipRockingMm > 1e-3,
        `one-sided load rocks the contact set (${asym.maxTipRockingMm.toFixed(4)}mm)`);
});

test('computeAutoSupportPlan attaches deterministic frameStress report and formats it in Forest Report', () => {
    const prevSettings = getSettings();
    try {
        resetStore();
        resetKickstandsInState();
        initializeBVH();
        const s = createDefaultSettings();
        s.grid.enabled = false;
        setSettings(s);

        const geo = new THREE.BoxGeometry(16, 16, 12).translate(0, 0, 22).toNonIndexed();
        geo.computeVertexNormals();
        accelerateGeometry(geo);
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
        mesh.updateMatrixWorld(true);

        const voxels: { x: number; y: number }[] = [];
        for (let x = -7.5; x <= 7.5; x += 0.5) {
            for (let y = -7.5; y <= 7.5; y += 0.5) {
                voxels.push({ x, y });
            }
        }
        const plan = computeAutoSupportPlan(
            [{
                id: 'plate-cap',
                source: 'overhang',
                contact: new THREE.Vector3(0, 0, 16),
                baseZ: 16,
                areaMm2: 256,
                surfaceNormal: { x: 0, y: 0, z: -1 },
                overhangAngleDeg: 0,
                contactVoxels: footprintFromPoints(voxels),
            }],
            'model-a',
            { stabilizationEnabled: false },
            undefined,
            mesh,
        );

        assert.ok(plan, 'auto-support plan generated');
        const report = plan.analytics.forestReport;
        assert.ok(report?.frameStress, 'frameStress summary populated on ForestReport');
        assert.equal(report.frameStress.solverMode, 'frame3d');
        assert.ok(report.frameStress.braceCount > 0, 'X-braces included in support graph');
        assert.ok(report.frameStress.peakLayerPeelForceN > 0, 'Stefan peel force integrated onto critical layers');
        assert.ok(report.frameStress.layerProfile.length > 0, 'layer-by-layer peel curve populated');
        assert.equal(report.frameStress.memberSegments.length, report.frameStress.memberCount, 'every frame beam has a stress segment');
        assert.equal(report.frameStress.tipPoints.length, report.frameStress.tipCount, 'every support tip has a stress point');

        const formatted = forestReportToText(report);
        assert.ok(formatted.includes('FRAME STRESS (SUPPORT GRAPH)'), 'Forest Report prints frame stress section');
    } finally {
        setSettings(prevSettings);
    }
});

test('reinforceOverloadedFrameMembers thickens overloaded trunks and drops utilization on re-solve', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rWeak: { id: 'rWeak', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tWeak: {
                id: 'tWeak', modelId: 'm', rootId: 'rWeak',
                segments: [{ id: 'sWeak', diameter: 0.65, bottomJoint: { id: 'j0', pos: { x: 0, y: 0, z: 1 }, diameter: 0.65 }, topJoint: { id: 'j1', pos: { x: 0, y: 0, z: 19 }, diameter: 0.65 } }],
                contactCone: { id: 'cWeak', pos: { x: 0, y: 0, z: 21.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 0.65, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };

    const graph = buildSupportGraph(draft, 'm');
    const overloadedReport = solveSupportFrameStress(graph, undefined, {
        explicitNodalLoads: new Map([[graph.nodes.length - 1, [0.12, 0, 0.25, 0, 0, 0]]]),
    });
    assert.ok(overloadedReport.maxMemberUtilizationPct > 100, `thin Ø0.65mm trunk exceeds 100% (got ${overloadedReport.maxMemberUtilizationPct.toFixed(0)}%)`);

    const reinforced = reinforceOverloadedFrameMembers(draft, overloadedReport, undefined, 'm');
    assert.equal(reinforced.changed, true);
    assert.equal(reinforced.reinforcedTrunks, 1);
    const newDia = reinforced.snapshot.trunks.tWeak.segments[0].diameter;
    assert.ok(newDia > 0.65, `trunk thickened from 0.65mm to ${newDia}mm`);

    const reGraph = buildSupportGraph(reinforced.snapshot, 'm');
    const afterReport = solveSupportFrameStress(reGraph, undefined, {
        explicitNodalLoads: new Map([[reGraph.nodes.length - 1, [0.12, 0, 0.25, 0, 0, 0]]]),
    });
    assert.ok(afterReport.maxMemberUtilizationPct < overloadedReport.maxMemberUtilizationPct * 0.6,
        `re-solve shows steep stress drop (${afterReport.maxMemberUtilizationPct.toFixed(0)}% vs ${overloadedReport.maxMemberUtilizationPct.toFixed(0)}%)`);
});

test('reinforceOverloadedFrameMembers thickens overloaded branches, leaves, braces, and parent knots while preserving tip contacts', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rA: { id: 'rA', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
            rB: { id: 'rB', modelId: 'm', transform: { pos: { x: 5, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tA: {
                id: 'tA', modelId: 'm', rootId: 'rA',
                segments: [{ id: 'sA', diameter: 1.0, bottomJoint: { id: 'jA0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'jA1', pos: { x: 0, y: 0, z: 16 }, diameter: 1.0 } }],
            } as never,
            tB: {
                id: 'tB', modelId: 'm', rootId: 'rB',
                segments: [{ id: 'sB', diameter: 1.0, bottomJoint: { id: 'jB0', pos: { x: 5, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'jB1', pos: { x: 5, y: 0, z: 16 }, diameter: 1.0 } }],
            } as never,
        },
        knots: {
            kBraceA: { id: 'kBraceA', parentShaftId: 'sA', t: 0.4, pos: { x: 0, y: 0, z: 7 }, diameter: 0.9 } as never,
            kBraceB: { id: 'kBraceB', parentShaftId: 'sB', t: 0.8, pos: { x: 5, y: 0, z: 13 }, diameter: 0.9 } as never,
            kLeaf: { id: 'kLeaf', parentShaftId: 'sA', t: 0.85, pos: { x: 0, y: 0, z: 14 }, diameter: 0.8 } as never,
            kBranch: { id: 'kBranch', parentShaftId: 'sB', t: 0.85, pos: { x: 5, y: 0, z: 14 }, diameter: 0.8 } as never,
        },
        braces: {
            br1: { id: 'br1', modelId: 'm', startKnotId: 'kBraceA', endKnotId: 'kBraceB', profile: { diameter: 0.55 } } as never,
        },
        leaves: {
            lf1: {
                id: 'lf1', modelId: 'm', parentKnotId: 'kLeaf',
                contactCone: { id: 'cLeaf', pos: { x: -2.4, y: 0, z: 17.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.24, bodyDiameterMm: 0.6, lengthMm: 2.0, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
        branches: {
            bn1: {
                id: 'bn1', modelId: 'm', parentKnotId: 'kBranch',
                segments: [{ id: 'sBn1', diameter: 0.65, bottomJoint: { id: 'jBn0', pos: { x: 5, y: 0, z: 14 }, diameter: 0.65 }, topJoint: { id: 'jBn1', pos: { x: 7.5, y: 0, z: 17.5 }, diameter: 0.65 } }],
                contactCone: { id: 'cBn1', pos: { x: 8.2, y: 0, z: 19.2 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.26, bodyDiameterMm: 0.65, lengthMm: 2.0, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };

    const graph = buildSupportGraph(draft, 'm');
    const loads = new Map<number, readonly [number, number, number, number, number, number]>();
    graph.nodes.forEach((n, idx) => {
        if (n.kind === 'tip') loads.set(idx, [0.22, 0.12, 0.45, 0, 0, 0]);
    });

    const beforeReport = solveSupportFrameStress(graph, undefined, { explicitNodalLoads: loads });
    assert.ok(beforeReport.overloadedMembers >= 2, `expected overloaded members before reinforce, got ${beforeReport.overloadedMembers}`);

    const reinforced = reinforceOverloadedFrameMembers(draft, beforeReport, undefined, 'm');
    assert.equal(reinforced.changed, true);
    assert.ok(reinforced.totalReinforced >= 2, `expected >=2 reinforced members, got ${reinforced.totalReinforced}`);
    assert.equal(reinforced.reinforcedLeaves, 1, 'overloaded leaf reinforced');
    assert.equal(reinforced.reinforcedBranches, 1, 'overloaded branch reinforced');

    const newLeafBody = reinforced.snapshot.leaves.lf1.contactCone.profile.bodyDiameterMm;
    assert.ok(newLeafBody > 0.6, `leaf body thickened from 0.6mm to ${newLeafBody}mm`);
    assert.equal(reinforced.snapshot.leaves.lf1.contactCone.profile.contactDiameterMm, 0.24, 'leaf contact tip scar preserved');
    assert.ok((reinforced.snapshot.knots.kLeaf.diameter ?? 0) >= newLeafBody + 0.125 - 1e-6, 'leaf host knot updated');

    const newBranchDia = reinforced.snapshot.branches.bn1.segments[0].diameter;
    assert.ok(newBranchDia > 0.65, `branch shaft thickened from 0.65mm to ${newBranchDia}mm`);
    assert.equal(reinforced.snapshot.branches.bn1.contactCone?.profile.contactDiameterMm, 0.26, 'branch contact tip scar preserved');
    assert.ok((reinforced.snapshot.knots.kBranch.diameter ?? 0) >= newBranchDia + 0.125 - 1e-6, 'branch host knot updated');

    if (reinforced.reinforcedBraces > 0) {
        const newBraceDia = reinforced.snapshot.braces.br1.profile.diameter;
        assert.ok(newBraceDia > 0.55, `brace thickened from 0.55mm to ${newBraceDia}mm`);
        assert.ok((reinforced.snapshot.knots.kBraceA.diameter ?? 0) >= newBraceDia + 0.125 - 1e-6, 'brace start knot updated for BraceRenderer');
        assert.ok((reinforced.snapshot.knots.kBraceB.diameter ?? 0) >= newBraceDia + 0.125 - 1e-6, 'brace end knot updated for BraceRenderer');
    }

    const reGraph = buildSupportGraph(reinforced.snapshot, 'm');
    const reLoads = new Map<number, readonly [number, number, number, number, number, number]>();
    reGraph.nodes.forEach((n, idx) => {
        if (n.kind === 'tip') reLoads.set(idx, [0.22, 0.12, 0.45, 0, 0, 0]);
    });
    const afterReport = solveSupportFrameStress(reGraph, undefined, { explicitNodalLoads: reLoads });
    assert.ok(afterReport.maxMemberUtilizationPct < beforeReport.maxMemberUtilizationPct,
        `re-solve shows lower stress (${afterReport.maxMemberUtilizationPct.toFixed(0)}% vs ${beforeReport.maxMemberUtilizationPct.toFixed(0)}%)`);
});

test('reinforceOverloadedFrameMembers falls back to smaller clearance-safe step and reports skippedCount at cap', () => {
    initializeBVH();
    // Place an obstacle box just close enough to block 1.35x scaled leaf radius (~1.22mm -> 0.427mm)
    // while clearing the 1.08x fallback step (~0.97mm -> 0.340mm) with nearest box face at x=0.36mm.
    const boxGeo = new THREE.BoxGeometry(1.0, 2.0, 2.0).translate(0.86, 0, 12.0).toNonIndexed();
    boxGeo.computeVertexNormals();
    accelerateGeometry(boxGeo);
    const fitMesh = new THREE.Mesh(boxGeo, new THREE.MeshBasicMaterial());
    fitMesh.updateMatrixWorld(true);

    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            r1: { id: 'r1', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            t1: {
                id: 't1', modelId: 'm', rootId: 'r1',
                segments: [{ id: 's1', diameter: 1.6, bottomJoint: { id: 'j0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.6 }, topJoint: { id: 'j1', pos: { x: 0, y: 0, z: 10 }, diameter: 1.6 } }],
            } as never,
        },
        knots: {
            k1: { id: 'k1', parentShaftId: 's1', t: 1, pos: { x: 0, y: 0, z: 10 }, diameter: 1.2 } as never,
        },
        leaves: {
            lfNear: {
                id: 'lfNear', modelId: 'm', parentKnotId: 'k1',
                contactCone: { id: 'cNear', pos: { x: 0, y: 0, z: 14 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.24, bodyDiameterMm: 0.90, lengthMm: 2.0, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };

    const syntheticOverloadReport: SupportFrameStressReport = {
        nodeCount: 3, rootCount: 1, tipCount: 1, memberCount: 2, braceCount: 0,
        layersEvaluated: 1, peakLayerZMm: 14, peakLayerPeelForceN: 1,
        maxTipUtilizationPct: 50, overloadedTips: 0,
        maxMemberUtilizationPct: 220, overloadedMembers: 1,
        maxTipDeflectionMm: 0.2, maxTipRockingMm: 0.08, solverMode: 'frame3d',
        hotspots: [], layerProfile: [],
        memberSegments: [
            { entityId: 'lfNear', entityKind: 'leaf', a: { x: 0, y: 0, z: 10 }, b: { x: 0, y: 0, z: 14 }, diameterMm: 0.63, utilizationPct: 220 },
        ],
        tipPoints: [],
    };

    const stepped = reinforceOverloadedFrameMembers(draft, syntheticOverloadReport, fitMesh, 'm');
    assert.equal(stepped.changed, true, 'fallback clearance step accepted');
    assert.equal(stepped.reinforcedLeaves, 1);
    const steppedDia = stepped.snapshot.leaves.lfNear.contactCone.profile.bodyDiameterMm;
    assert.ok(steppedDia > 0.90 && steppedDia < 1.22, `stepped fallback diameter ${steppedDia}mm (< ideal 1.22mm)`);

    // Already-capped leaf reports changed: false and skippedCount: 1.
    const cappedDraft: SupportState = {
        ...draft,
        leaves: {
            lfNear: {
                ...draft.leaves.lfNear,
                contactCone: {
                    ...draft.leaves.lfNear.contactCone,
                    profile: { ...draft.leaves.lfNear.contactCone.profile, bodyDiameterMm: 1.55 },
                },
            },
        },
    };
    const atCap = reinforceOverloadedFrameMembers(cappedDraft, syntheticOverloadReport, undefined, 'm');
    assert.equal(atCap.changed, false);
    assert.equal(atCap.skippedCount, 1);
});

test('a disconnected sub-assembly below every global stage gets its own critical layer', () => {
    const cone = (id: string, x: number, z: number) => ({
        id,
        pos: { x, y: 0, z },
        normal: { x: 0, y: 0, z: -1 },
        profile: { type: 'disk' as const, contactDiameterMm: 0.28, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0 },
    });
    const tower = (id: string, x: number, tipZ: number) => ({
        id,
        modelId: 'm',
        rootId: `r-${id}`,
        segments: [{
            id: `seg-${id}`,
            diameter: 1.0,
            bottomJoint: { id: `j0-${id}`, pos: { x, y: 0, z: 1 }, diameter: 1.0 },
            topJoint: { id: `j1-${id}`, pos: { x, y: 0, z: tipZ - 0.5 }, diameter: 1.0 },
        }],
        contactCone: cone(`c-${id}`, x, tipZ),
    } as never);
    const snapshot: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            'r-short': { id: 'r-short', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
            'r-tall': { id: 'r-tall', modelId: 'm', transform: { pos: { x: 12, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            short: tower('short', 0, 13),
            tall: tower('tall', 12, 30),
        },
    };

    // Global picks: peak area (z=20) and the highest stage (z=30). The short
    // tower's own peak (z=13) is below both and is only reached by the
    // per-component pass.
    const profile: RepresentativeLayerProfile = {
        layers: [
            { zMm: 13, areaMm2: 25, areaJumpRatio: 1.2, clusterSpanCount: 1 },
            { zMm: 20, areaMm2: 40, areaJumpRatio: 3.0, clusterSpanCount: 1 },
            { zMm: 30, areaMm2: 20, areaJumpRatio: 1.0, clusterSpanCount: 1 },
        ],
        peakAreaMm2: 40,
        sampledPlaneCount: 3,
    };

    const graph = buildSupportGraph(snapshot, 'm');
    assert.equal(graph.rootCount, 2, 'two independent towers');
    const report = solveSupportFrameStress(graph, profile, { areaPerSupportMm2: 10 });

    assert.equal(report.layersEvaluated, 3, 'two global stages plus the short tower stage');
    const shortTowerStage = report.layerProfile.find((layer) => layer.zMm === 13);
    assert.ok(shortTowerStage, 'the short tower layer is in the profile');
    assert.equal(shortTowerStage.critical, true, 'and it was actually solved at its own peak');
    assert.ok(shortTowerStage.maxTipUtilPct > 0, 'the short tower tip carried load at that stage');

    const shortTip = report.tipPoints.find((tip) => tip.pos.x === 0);
    assert.ok(shortTip && shortTip.utilizationPct > 0, 'and its tip reports the load');
});

test('the reported peel curve runs at the sampled-layer resolution, not the cluster peaks', () => {
    const cone = {
        id: 'c1',
        pos: { x: 0, y: 0, z: 20 },
        normal: { x: 0, y: 0, z: -1 },
        profile: { type: 'disk' as const, contactDiameterMm: 0.28, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0 },
    };
    const snapshot: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            r1: { id: 'r1', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            t1: {
                id: 't1',
                modelId: 'm',
                rootId: 'r1',
                segments: [{
                    id: 's1',
                    diameter: 1.0,
                    bottomJoint: { id: 'j0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.0 },
                    topJoint: { id: 'j1', pos: { x: 0, y: 0, z: 19.5 }, diameter: 1.0 },
                }],
                contactCone: cone,
            } as never,
        },
    };
    const profile: RepresentativeLayerProfile = {
        layers: [{ zMm: 10, areaMm2: 20, areaJumpRatio: 1.5, clusterSpanCount: 40 }],
        samples: [
            { zMm: 9.95, areaMm2: 10 },
            { zMm: 10, areaMm2: 20 },
            { zMm: 10.05, areaMm2: 30 },
        ],
        peakAreaMm2: 30,
        sampledPlaneCount: 3,
    };

    const report = solveSupportFrameStress(buildSupportGraph(snapshot, 'm'), profile, { areaPerSupportMm2: 10 });
    assert.deepEqual(report.layerProfile.map((point) => point.zMm), [9.95, 10, 10.05], 'one point per sampled layer');
    assert.equal(report.layersEvaluated, 1, 'only the critical layer costs a solve');
    assert.equal(report.layerProfile.find((point) => point.zMm === 10)?.critical, true);
    // 30 mm² at the nominal calibration (0.29 N per 10 mm²) is 0.87 N.
    assert.ok(Math.abs((report.layerProfile.find((point) => point.zMm === 10.05)?.peelForceN ?? 0) - 0.87) < 1e-6);
});

test('the peel curve interpolates the field factor instead of spiking at cluster peaks', () => {
    const pRef = referenceStefanMeanPressureMm2(10);
    const field = {
        minX: -5, minY: -5, cellMm: 0.5, nx: 20, ny: 20,
        pressure: new Float32Array(400).fill(0.5),
        peakPressureMm2: 1, meanPressureMm2: 0.5,
        // Mean pressure 10× the 10 mm² reference disc.
        integratedForceMm4: 10 * 100 * pRef,
        maskAreaMm2: 100,
    };
    const layers = [{ zMm: 10, areaMm2: 100, areaJumpRatio: 1, clusterSpanCount: 1, stefanField: field }];
    const samples = [9.9, 9.95, 10, 10.05, 10.1].map((zMm) => ({ zMm, areaMm2: 100 }));

    const forces = computePeelLayerSamples(samples, layers, 100).map((sample) => sample.forceN);
    // Compression `0.50 + 0.50·10^0.22` = 1.3298, so every layer reads the same
    // force — the neighbours interpolate the factor instead of falling back to
    // nominal 1.0 (which used to make the centre a 10× spike).
    const factor = 0.5 + 0.5 * Math.pow(10, 0.22);
    const expected = 100 * factor * NOMINAL_PEEL_PRESSURE_MPA;
    for (const force of forces) {
        assert.ok(Math.abs(force - expected) < 1e-3, `layer force ${force} should be ${expected.toFixed(3)} N`);
    }
});

test('the frame report exposes the worst rocking pair and per-tip displacements', () => {
    const graph = {
        nodes: [
            { id: 'r0', pos: { x: 0, y: 0, z: 0 }, kind: 'root' as const, fixed: true },
            { id: 't0', pos: { x: 0, y: 0, z: 10 }, kind: 'tip' as const, fixed: false, entityId: 'trunk-a', entityKind: 'trunk' as const, tipContactDiameterMm: 0.28 },
            { id: 'r1', pos: { x: 10, y: 0, z: 0 }, kind: 'root' as const, fixed: true },
            { id: 't1', pos: { x: 10, y: 0, z: 12 }, kind: 'tip' as const, fixed: false, entityId: 'trunk-b', entityKind: 'trunk' as const, tipContactDiameterMm: 0.28 },
        ],
        members: [
            { id: 'm0', entityId: 'trunk-a', entityKind: 'trunk' as const, nodeA: 0, nodeB: 1, lengthMm: 10, diameterMm: 0.8, angleFromVerticalDeg: 0 },
            { id: 'm1', entityId: 'trunk-b', entityKind: 'trunk' as const, nodeA: 2, nodeB: 3, lengthMm: 12, diameterMm: 0.8, angleFromVerticalDeg: 0 },
        ],
        rootCount: 2,
        tipCount: 2,
        braceCount: 0,
    };
    const profile: RepresentativeLayerProfile = {
        layers: [{ zMm: 10, areaMm2: 20, areaJumpRatio: 1, clusterSpanCount: 1 }],
        samples: [{ zMm: 10, areaMm2: 20 }],
        peakAreaMm2: 20,
        sampledPlaneCount: 1,
    };
    const report = solveSupportFrameStress(graph, profile, { areaPerSupportMm2: 10 });

    assert.equal(report.solverMode, 'frame3d');
    assert.ok(report.maxTipRockingMm > 0, `rocking ${report.maxTipRockingMm}`);
    assert.ok(report.rockingPair, 'worst rocking pair recorded');
    assert.equal(report.tipDisplacements?.length, 2);
    assert.ok(Math.abs(report.rockingPair!.differentialMm - report.maxTipRockingMm) < 1e-9);
    assert.notEqual(report.rockingPair!.aEntityId, report.rockingPair!.bEntityId);
    const projections = (report.tipDisplacements ?? []).map((d) => d.dx * Math.SQRT1_2 + d.dy * Math.SQRT1_2);
    const spread = Math.max(...projections) - Math.min(...projections);
    assert.ok(Math.abs(spread - report.maxTipRockingMm) < 1e-9);
});

test('the material tensile strength scales tip utilization without moving geometry', () => {
    const cone = {
        id: 'c1',
        pos: { x: 0, y: 0, z: 10 },
        normal: { x: 0, y: 0, z: -1 },
        profile: { type: 'disk' as const, contactDiameterMm: 0.28, bodyDiameterMm: 1.0, lengthMm: 2.5, penetrationMm: 0 },
    };
    const snapshot: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            r1: { id: 'r1', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            t1: {
                id: 't1', modelId: 'm', rootId: 'r1',
                segments: [{ id: 's1', diameter: 1.0, bottomJoint: { id: 'j0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.0 }, topJoint: { id: 'j1', pos: { x: 0, y: 0, z: 9.5 }, diameter: 1.0 } }],
                contactCone: cone,
            } as never,
        },
    };
    const profile: RepresentativeLayerProfile = {
        layers: [{ zMm: 10, areaMm2: 20, areaJumpRatio: 1, clusterSpanCount: 1 }],
        samples: [{ zMm: 10, areaMm2: 20 }],
        peakAreaMm2: 20,
        sampledPlaneCount: 1,
    };
    const graph = buildSupportGraph(snapshot, 'm');
    const at12 = solveSupportFrameStress(graph, profile, { areaPerSupportMm2: 10, supportStrengthMpa: 12 });
    const at24 = solveSupportFrameStress(graph, profile, { areaPerSupportMm2: 10, supportStrengthMpa: 24 });
    assert.ok(at12.maxTipUtilizationPct > 0, `tip loaded (${at12.maxTipUtilizationPct})`);
    assert.ok(Math.abs(at12.maxTipUtilizationPct / at24.maxTipUtilizationPct - 2) < 1e-6,
        `doubling UTS halves utilization (${at12.maxTipUtilizationPct} vs ${at24.maxTipUtilizationPct})`);

    // The tip sees the contact coupon strength; the member sees the bulk value.
    const split = solveSupportFrameStress(graph, profile, {
        areaPerSupportMm2: 10,
        supportStrengthMpa: 12,
        memberStrengthMpa: 24,
    });
    assert.ok(Math.abs(split.maxTipUtilizationPct - at12.maxTipUtilizationPct) < 1e-9,
        'member strength does not move tip utilization');
    assert.ok(at12.maxMemberUtilizationPct > 0, `member loaded (${at12.maxMemberUtilizationPct})`);
    assert.ok(Math.abs(at12.maxMemberUtilizationPct / split.maxMemberUtilizationPct - 2) < 1e-6,
        `doubling member strength halves member utilization (${at12.maxMemberUtilizationPct} vs ${split.maxMemberUtilizationPct})`);
});

test('rocking is the rigid-body fit, not a local leaf sag', () => {
    const sOf = (x: number, y: number) => (x - y) * Math.SQRT1_2;
    const theta = 0.01;
    const rigid: Array<{ pos: { x: number; y: number }; dx: number; dy: number }> = [
        { pos: { x: 0, y: 0 }, dx: -theta * 0, dy: theta * 0 },
        { pos: { x: 10, y: 0 }, dx: -theta * 0, dy: theta * 10 },
        { pos: { x: 0, y: 10 }, dx: -theta * 10, dy: theta * 0 },
        { pos: { x: 10, y: 10 }, dx: -theta * 10, dy: theta * 10 },
    ];
    const sValues = rigid.map((p) => sOf(p.pos.x, p.pos.y));
    const expected = theta * (Math.max(...sValues) - Math.min(...sValues));
    assert.ok(Math.abs(rigidBodyRockingMm(rigid) - expected) < 1e-9, 'pure rotation is recovered');

    const translated = rigid.map((p) => ({ ...p, dx: 1, dy: 1 }));
    assert.ok(rigidBodyRockingMm(translated) < 1e-9, 'rigid translation has no rocking');

    const withCenterSag = [
        ...rigid,
        { pos: { x: 5, y: 5 }, dx: 3, dy: 0 },
    ];
    assert.ok(Math.abs(rigidBodyRockingMm(withCenterSag) - expected) < 1e-9,
        'a local contact sag at the rotation center does not become part rocking');
});


test('reinforcement caps keep every member under the trunk and stop at 1.4 mm', () => {
    assert.equal(reinforcementDiameterCapMm('trunk'), 1.4);
    assert.equal(reinforcementDiameterCapMm('branch'), 1.4);
    assert.equal(reinforcementDiameterCapMm('leaf'), 1.3);
    assert.equal(reinforcementDiameterCapMm('brace'), 1.4);
    assert.equal(reinforcementDiameterCapMm('stick'), 0, 'no shaft to reinforce');
});

test('a trunk already at the reinforcement cap is skipped, not clubbed further', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rCap: { id: 'rCap', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tCap: {
                id: 'tCap', modelId: 'm', rootId: 'rCap',
                segments: [{ id: 'sCap', diameter: 1.4, bottomJoint: { id: 'jc0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.4 }, topJoint: { id: 'jc1', pos: { x: 0, y: 0, z: 19 }, diameter: 1.4 } }],
                contactCone: { id: 'cCap', pos: { x: 0, y: 0, z: 21.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 1.4, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };
    const graph = buildSupportGraph(draft, 'm');
    const report = solveSupportFrameStress(graph, undefined, {
        explicitNodalLoads: new Map([[graph.nodes.length - 1, [0.3, 0, 0.6, 0, 0, 0]]]),
    });
    assert.ok(report.maxMemberUtilizationPct > 100, 'the capped trunk is still overloaded');
    const reinforced = reinforceOverloadedFrameMembers(draft, report, undefined, 'm');
    assert.equal(reinforced.changed, false, 'no diameter increase past the cap');
    assert.equal(reinforced.snapshot.trunks.tCap.segments[0].diameter, 1.4);
    assert.equal(reinforced.skippedCount, 1, 'the at-cap skip is counted for the brace fallback');
});

test('a member already structurally addressed is not thickened in the same batch', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rSkip: { id: 'rSkip', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tSkip: {
                id: 'tSkip', modelId: 'm', rootId: 'rSkip',
                segments: [{ id: 'sSkip', diameter: 0.65, bottomJoint: { id: 'js0', pos: { x: 0, y: 0, z: 1 }, diameter: 0.65 }, topJoint: { id: 'js1', pos: { x: 0, y: 0, z: 19 }, diameter: 0.65 } }],
                contactCone: { id: 'cSkip', pos: { x: 0, y: 0, z: 21.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 0.65, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };
    const graph = buildSupportGraph(draft, 'm');
    const report = solveSupportFrameStress(graph, undefined, {
        explicitNodalLoads: new Map([[graph.nodes.length - 1, [0.12, 0, 0.25, 0, 0, 0]]]),
    });
    assert.ok(report.maxMemberUtilizationPct > 100);
    const skipped = reinforceOverloadedFrameMembers(draft, report, undefined, 'm', new Set(['tSkip']));
    assert.equal(skipped.changed, false, 'a braced/promoted member is left to the verification solve');
    assert.equal(skipped.reinforcedTrunks, 0);
    assert.equal(skipped.snapshot.trunks.tSkip.segments[0].diameter, 0.65);
});

test('a twig sharing a support tip becomes a model-coupled frame member', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rT: { id: 'rT', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tT: {
                id: 'tT', modelId: 'm', rootId: 'rT',
                segments: [{ id: 'sT', diameter: 1, bottomJoint: { id: 'jt0', pos: { x: 0, y: 0, z: 1 }, diameter: 1 }, topJoint: { id: 'jt1', pos: { x: 0, y: 0, z: 19 }, diameter: 1 } }],
                contactCone: { id: 'cT', pos: { x: 0, y: 0, z: 21 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 1, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
        twigs: {
            w1: {
                id: 'w1', modelId: 'm',
                segments: [{ id: 'ws1', diameter: 0.8, bottomJoint: { id: 'wj0', pos: { x: 0, y: 0, z: 21 }, diameter: 0.8 }, topJoint: { id: 'wj1', pos: { x: 4, y: 0, z: 12 }, diameter: 0.8 } }],
                contactDiskA: { pos: { x: 0, y: 0, z: 21 } },
                contactDiskB: { pos: { x: 4, y: 0, z: 12 } },
            } as never,
        },
    };
    const graph = buildSupportGraph(draft, 'm');
    const twig = graph.members.find((m) => m.entityId === 'w1');
    assert.ok(twig, 'twig is in the frame');
    assert.equal(twig.entityKind, 'twig');
    const tipNode = graph.nodes.find((n) => n.kind === 'tip');
    assert.ok(tipNode && !tipNode.fixed, 'support tip stays free and is shared');
    assert.ok(graph.nodes.some((n) => n.kind === 'model' && n.fixed), 'model end is a fixed node');
});

test('the tapered cone report finds a stronger section than the effective stiffness diameter', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rEx: { id: 'rEx', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tEx: {
                id: 'tEx', modelId: 'm', rootId: 'rEx',
                segments: [{ id: 'sEx', diameter: 1.4, bottomJoint: { id: 'je0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.4 }, topJoint: { id: 'je1', pos: { x: 0, y: 0, z: 19 }, diameter: 1.4 } }],
                contactCone: { id: 'cEx', pos: { x: 0, y: 0, z: 21.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 1.4, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };
    const graph = buildSupportGraph(draft, 'm');
    const loads = { explicitNodalLoads: new Map<number, readonly [number, number, number, number, number, number]>([[graph.nodes.length - 1, [0.3, 0, 0.6, 0, 0, 0]]]) };
    const effective = solveSupportFrameStress(graph, undefined, loads);
    const tapered = solveSupportFrameStress(graph, undefined, { ...loads, taperedConeStress: true });
    const effectiveCone = effective.memberSegments.find((seg) => seg.role === 'cone');
    const taperedCone = tapered.memberSegments.find((seg) => seg.role === 'cone');
    assert.ok(effectiveCone && taperedCone, 'both reports carry the cone member');
    assert.ok(taperedCone.diameterMm < effectiveCone.diameterMm,
        'the governing tapered section is narrower than the 0.7 x body stiffness diameter');
    assert.ok(taperedCone.utilizationPct > effectiveCone.utilizationPct,
        'the real taper exposes more stress than the effective constant section');
});

test('a bounded cap override lets an at-cap trunk take one more step', () => {
    const draft: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            rEx: { id: 'rEx', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            tEx: {
                id: 'tEx', modelId: 'm', rootId: 'rEx',
                segments: [
                    { id: 'sEx', diameter: 1.4, bottomJoint: { id: 'je0', pos: { x: 0, y: 0, z: 1 }, diameter: 1.4 }, topJoint: { id: 'je1', pos: { x: 0, y: 0, z: 10 }, diameter: 1.4 } },
                    { id: 'sEx2', diameter: 1.4, bottomJoint: { id: 'je1', pos: { x: 0, y: 0, z: 10 }, diameter: 1.4 }, topJoint: { id: 'je2', pos: { x: 0, y: 0, z: 19 }, diameter: 1.4 } },
                ],
                contactCone: { id: 'cEx', pos: { x: 0, y: 0, z: 21.5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.28, bodyDiameterMm: 1.4, lengthMm: 2.5, penetrationMm: 0, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: Math.PI / 4 } },
            } as never,
        },
    };
    const graph = buildSupportGraph(draft, 'm');
    const report = solveSupportFrameStress(graph, undefined, {
        explicitNodalLoads: new Map([[graph.nodes.length - 1, [0.3, 0, 0.6, 0, 0, 0]]]),
    });
    assert.ok(report.maxMemberUtilizationPct > 100);
    const reinforced = reinforceOverloadedFrameMembers(
        draft,
        report,
        undefined,
        'm',
        undefined,
        new Map([['tEx', 1.6]]),
    );
    assert.equal(reinforced.changed, true);
    assert.equal(reinforced.snapshot.trunks.tEx.segments[0].diameter, 1.6,
        'the lower segment takes the bounded 1.6 mm exception');
    assert.equal(reinforced.snapshot.trunks.tEx.segments[1].diameter, 1.6,
        'the contact segment also takes the bounded step');
    assert.equal(reinforced.snapshot.trunks.tEx.contactCone?.profile.bodyDiameterMm, 1.4,
        'the cone body stays at the normal cap so it cannot rise above the tip');
});
