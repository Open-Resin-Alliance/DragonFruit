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
    GREEN_RESIN_UTS_MPA,
    buildSupportGraph,
    distributeRigidBodyPeelLoads,
    solveSupportFrameStress,
} from '../autoSupport/supportGraphStress';
import { GREEN_RESIN_MODULUS_MPA } from '../autoSupport/treeSynthesis';

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
    // Each split trunk contributes 2 shaft sub-members + 1 cone member = 3; plus 1 brace + 1 leaf = 8.
    assert.equal(graph.members.length, 8, 'splits both host trunk segments at their brace/leaf knots');
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
    const expectedUtilPct = (100 * expectedSigmaMpa) / GREEN_RESIN_UTS_MPA;

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

        const formatted = forestReportToText(report);
        assert.ok(formatted.includes('FRAME STRESS (SUPPORT GRAPH)'), 'Forest Report prints frame stress section');
    } finally {
        setSettings(prevSettings);
    }
});
