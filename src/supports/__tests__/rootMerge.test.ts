import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { accelerateGeometry, initializeBVH } from '@/utils/bvh';
import { createEmptySupportCollections } from '../supportTypeRegistry';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import { mergeNearbyTrunkRoots, MID_SHAFT_MERGE_DISTANCE_MM, ROOT_MERGE_RADIUS_MM } from '../autoSupport/autoPlace';
import type { SupportState } from '../types';

function cone(id: string, x: number, y: number, z: number) {
    return {
        id,
        pos: { x, y, z },
        normal: { x: 0, y: 0, z: -1 },
        profile: { type: 'disk' as const, contactDiameterMm: 0.28, bodyDiameterMm: 1, lengthMm: 2, penetrationMm: 0 },
    };
}

function trunk(id: string, x: number, tipZ: number, tipX = x) {
    return {
        id,
        modelId: 'm',
        origin: 'standalone' as const,
        rootId: `r-${id}`,
        segments: [{
            id: `seg-${id}`,
            diameter: 1,
            bottomJoint: { id: `j0-${id}`, pos: { x, y: 0, z: 1 }, diameter: 1 },
            topJoint: { id: `j1-${id}`, pos: { x, y: 0, z: tipZ - 0.5 }, diameter: 1 },
        }],
        contactCone: cone(`c-${id}`, tipX, 0, tipZ),
    };
}

function snapshot(xB: number, tipDX = 0): SupportState {
    return {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            'r-A': { id: 'r-A', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2.5, diskHeight: 0.5, coneHeight: 0.5 } as never,
            'r-B': { id: 'r-B', modelId: 'm', transform: { pos: { x: xB, y: 0, z: 0 } }, diameter: 2.5, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: { A: trunk('A', 0, 12), B: trunk('B', xB, 10, xB + tipDX) } as never,
        knots: {
            kB: { id: 'kB', parentShaftId: 'seg-B', t: 0.5, pos: { x: xB, y: 0, z: 5 }, diameter: 1.1 },
        } as never,
        leaves: {
            lB: {
                id: 'lB',
                modelId: 'm',
                origin: 'standalone',
                parentKnotId: 'kB',
                contactCone: cone('clB', xB + tipDX, 0, 10.5),
            } as never,
        },
    };
}

const OPTIONS = {
    maxAttachments: 12,
    maxAngleDeg: 45,
    fanRadiusMm: 8,
    gridHostFanRadiusMm: 2.5,
    gridHostIds: new Set<string>(),
    autoSettings: createDefaultAutoSupportSettings(),
};

test('a co-located trunk dissolves into the taller host and re-serves its contacts', () => {
    const result = mergeNearbyTrunkRoots(snapshot(2), 'm', OPTIONS);
    assert.equal(result.merged, 1);
    assert.deepEqual(result.mergedTrunkIds, ['B']);
    assert.deepEqual(Object.keys(result.draft.trunks), ['A'], 'only the taller host remains');
    assert.equal(result.draft.roots['r-B'], undefined, 'the redundant root is removed');
    assert.equal(result.draft.leaves['lB'], undefined, 'the old hosted member is gone');
    const onA = Object.values(result.draft.knots).filter((knot) => knot.parentShaftId === 'seg-A' || knot.parentShaftId === 'A');
    assert.equal(onA.length, 2, 'both contacts (own tip + leaf tip) are re-fanned onto A');
    assert.ok(!Object.values(result.draft.knots).some((knot) => knot.parentShaftId === 'seg-B'));
});

test('a trunk whose contacts cannot reach the survivor is kept and the refusal is tallied', () => {
    const result = mergeNearbyTrunkRoots(snapshot(20), 'm', OPTIONS);
    assert.equal(result.merged, 0, 'roots 20 mm apart are not candidates at all');
    assert.equal(Object.keys(result.draft.trunks).length, 2);
});

test('a candidate pair whose contacts cannot reach the survivor rolls back', () => {
    // Roots 2 mm apart, but the victim leans 20 mm sideways: its tips are out
    // of the survivor's fan reach, so the pair must not merge.
    const result = mergeNearbyTrunkRoots(snapshot(2, 20), 'm', OPTIONS);
    assert.equal(result.merged, 0);
    assert.equal(Object.keys(result.draft.trunks).length, 2, 'both trunks stay');
    assert.ok(result.draft.roots['r-B'], 'the root stays on a refused pair');
    assert.ok(result.refusals.noHost, `refusal tallied (${JSON.stringify(result.refusals)})`);
});

test('mid-shaft proximity merges leaning trunks whose roots sit beyond ROOT_MERGE_RADIUS_MM', () => {
    const dist = ROOT_MERGE_RADIUS_MM + 1.5; // 4.5mm root spacing (> 3mm root merge radius)
    const s: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            'r-A': { id: 'r-A', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2.5, diskHeight: 0.5, coneHeight: 0.5 } as never,
            'r-B': { id: 'r-B', modelId: 'm', transform: { pos: { x: dist, y: 0, z: 0 } }, diameter: 2.5, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            A: trunk('A', 0, 12),
            B: {
                id: 'B',
                modelId: 'm',
                origin: 'standalone',
                rootId: 'r-B',
                segments: [{
                    id: 'seg-B',
                    diameter: 1,
                    bottomJoint: { id: 'j0-B', pos: { x: dist, y: 0, z: 1 }, diameter: 1 },
                    topJoint: { id: 'j1-B', pos: { x: MID_SHAFT_MERGE_DISTANCE_MM * 0.75, y: 0, z: 9.5 }, diameter: 1 },
                }],
                contactCone: cone('c-B', MID_SHAFT_MERGE_DISTANCE_MM * 0.75, 0, 10),
            },
        } as never,
    };

    const result = mergeNearbyTrunkRoots(s, 'm', OPTIONS);
    assert.equal(result.merged, 1, 'leaning mid-shaft within MID_SHAFT_MERGE_DISTANCE_MM triggers merge');
    assert.deepEqual(Object.keys(result.draft.trunks), ['A']);
    const hostedCount = Object.keys(result.draft.leaves).length + Object.keys(result.draft.branches).length;
    assert.equal(hostedCount, 1, 'victim tip re-fanned onto survivor');
});

test('multi-host overflow distributes victim contacts across neighbor trunks when primary survivor is full', () => {
    const s: SupportState = {
        ...createEmptySupportCollections(),
        selectedId: null,
        hoveredId: null,
        roots: {
            'r-A': { id: 'r-A', modelId: 'm', transform: { pos: { x: 0, y: 0, z: 0 } }, diameter: 2.5, diskHeight: 0.5, coneHeight: 0.5 } as never,
            'r-B': { id: 'r-B', modelId: 'm', transform: { pos: { x: 1.5, y: 0, z: 0 } }, diameter: 2.5, diskHeight: 0.5, coneHeight: 0.5 } as never,
            'r-C': { id: 'r-C', modelId: 'm', transform: { pos: { x: 3.3, y: 0, z: 0 } }, diameter: 2.5, diskHeight: 0.5, coneHeight: 0.5 } as never,
        },
        trunks: {
            A: trunk('A', 0, 12),
            B: trunk('B', 1.5, 10),
            C: trunk('C', 3.3, 12.5),
        } as never,
        knots: {
            kA: { id: 'kA', parentShaftId: 'seg-A', t: 0.5, pos: { x: 0, y: 0, z: 6 }, diameter: 1.1 },
            kB1: { id: 'kB1', parentShaftId: 'seg-B', t: 0.5, pos: { x: 1.5, y: 0, z: 5 }, diameter: 1.1 },
            kB2: { id: 'kB2', parentShaftId: 'seg-B', t: 0.6, pos: { x: 1.5, y: 0, z: 6 }, diameter: 1.1 },
        } as never,
        leaves: {
            lA: { id: 'lA', modelId: 'm', origin: 'standalone', parentKnotId: 'kA', contactCone: cone('clA', -1, 0, 11) } as never,
            lB1: { id: 'lB1', modelId: 'm', origin: 'standalone', parentKnotId: 'kB1', contactCone: cone('clB1', 1.5, 1, 10.5) } as never,
            lB2: { id: 'lB2', modelId: 'm', origin: 'standalone', parentKnotId: 'kB2', contactCone: cone('clB2', 1.5, -1, 10.5) } as never,
        },
    };

    // maxAttachments = 3: A already holds 1 leaf, so A absorbs 2 of B's 3 contacts and C absorbs the 3rd overflow contact.
    const result = mergeNearbyTrunkRoots(s, 'm', { ...OPTIONS, maxAttachments: 3 });
    assert.equal(result.merged, 1, 'victim dissolves across primary survivor + neighbor trunk');
    assert.equal(result.draft.trunks['B'], undefined, 'victim B is removed');
    assert.ok(result.draft.trunks['A'] && result.draft.trunks['C'], 'both A and C remain');
    const knotsOnC = Object.values(result.draft.knots).filter((k) => k.parentShaftId === 'seg-C');
    assert.ok(knotsOnC.length >= 1, 'neighbor C absorbed overflow attachment from victim B');
});

test('mesh collision between survivor shaft and victim tips rolls back merge cleanly', () => {
    initializeBVH();
    const box = new THREE.BoxGeometry(1.0, 6.0, 12.0);
    box.translate(1.0, 0, 6.0); // vertical wall between trunk A (x=0) and trunk B tips (x=2.2)
    accelerateGeometry(box);
    const obstacleMesh = new THREE.Mesh(box, new THREE.MeshBasicMaterial());

    const result = mergeNearbyTrunkRoots(snapshot(2.2), 'm', { ...OPTIONS, mesh: obstacleMesh });
    assert.equal(result.merged, 0, 'blocked re-fan rolls back merge');
    assert.equal(Object.keys(result.draft.trunks).length, 2, 'victim trunk B remains intact');
    assert.ok(result.refusals.blocked, `blocked refusal tallied (${JSON.stringify(result.refusals)})`);
});
