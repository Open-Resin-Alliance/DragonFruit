import assert from 'node:assert/strict';
import test from 'node:test';

import { buildForestReport, forestSizingNote, forestReportToText } from '../autoSupport/autoPlace';
import type { ForestLedgerEntry } from '../autoSupport/types';
import type { SupportState } from '../types';

function emptySnapshot(): SupportState {
    return {
        trunks: {},
        roots: {},
        branches: {},
        leaves: {},
        anchors: {},
        knots: {},
        braces: {},
        twigs: {},
        sticks: {},
    } as unknown as SupportState;
}

/** Trunk at (0,0,z) with a shaft of `diameter`. */
function trunkAt(id: string, z: number, diameter: number): SupportState {
    const s = emptySnapshot();
    s.trunks[id] = {
        id,
        modelId: 'm',
        rootId: `r-${id}`,
        origin: 'standalone',
        segments: [{
            id: `seg-${id}`,
            diameter,
            bottomJoint: { id: `${id}-b`, pos: { x: 0, y: 0, z: 1 }, diameter: diameter + 0.2 },
            topJoint: { id: `${id}-t`, pos: { x: 0, y: 0, z }, diameter: diameter + 0.2 },
        }],
        contactCone: { id: `c-${id}`, pos: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 0.5, lengthMm: 1.2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: 1 } },
    };
    return s;
}

/** Leaf attached to host trunk's shaft at (0,0,zKnot), tip at (dx, zTip). */
function leafOn(hostTrunkId: string, leafId: string, knotId: string, dx: number, zKnot: number, zTip: number): SupportState {
    const s = emptySnapshot();
    s.trunks[hostTrunkId] = {
        id: hostTrunkId,
        modelId: 'm',
        rootId: `r-${hostTrunkId}`,
        origin: 'standalone',
        segments: [{
            id: `seg-${hostTrunkId}`,
            diameter: 1.2,
            bottomJoint: { id: `${hostTrunkId}-b`, pos: { x: 0, y: 0, z: 1 }, diameter: 1.4 },
            topJoint: { id: `${hostTrunkId}-t`, pos: { x: 0, y: 0, z: 10 }, diameter: 1.4 },
        }],
    };
    s.knots[knotId] = {
        id: knotId,
        parentShaftId: `seg-${hostTrunkId}`,
        pos: { x: 0, y: 0, z: zKnot },
        diameter: 1.325,
    };
    s.leaves[leafId] = {
        id: leafId,
        modelId: 'm',
        parentKnotId: knotId,
        contactCone: { id: `c-${leafId}`, pos: { x: dx, y: 0, z: zTip }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 0.5, lengthMm: 1.2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: 1 } },
    };
    return s;
}

const ledgerEntry = (displayId: string, entityId: string, zHeight: number, areaMm2: number): ForestLedgerEntry => ({
    displayId,
    kind: 'trunk',
    entityId,
    areaMm2,
    zHeight,
    preset: 'detail',
    bandShaftMm: 1.0,
});

test('buildForestReport groups fan-out trees and lists bare trunks with sizing', () => {
    const draft = emptySnapshot();
    draft.trunks['host-1'] = {
        id: 'host-1',
        modelId: 'm',
        rootId: 'r-host-1',
        origin: 'standalone',
        segments: [{
            id: 'seg-host-1',
            diameter: 1.22,
            bottomJoint: { id: 'host-1-b', pos: { x: 0, y: 0, z: 1 }, diameter: 1.42 },
            topJoint: { id: 'host-1-t', pos: { x: 0, y: 0, z: 15.9 }, diameter: 1.42 },
        }],
        contactCone: { id: 'c-host', pos: { x: 0, y: 0, z: 15.9 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 0.5, lengthMm: 1.2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: 1 } },
    };
    draft.knots['knot-a'] = { id: 'knot-a', parentShaftId: 'seg-host-1', pos: { x: 0, y: 0, z: 9.4 }, diameter: 1.345 };
    draft.knots['knot-b'] = { id: 'knot-b', parentShaftId: 'seg-host-1', pos: { x: 0, y: 0, z: 9.4 }, diameter: 1.345 };
    draft.leaves['leaf-a'] = { id: 'leaf-a', modelId: 'm', parentKnotId: 'knot-a', contactCone: { id: 'c-a', pos: { x: 1.1, y: 0, z: 15.9 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 0.5, lengthMm: 1.2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: 1 } } };
    draft.leaves['leaf-b'] = { id: 'leaf-b', modelId: 'm', parentKnotId: 'knot-b', contactCone: { id: 'c-b', pos: { x: 1.3, y: 0, z: 15.9 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 0.5, lengthMm: 1.2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: 1 } } };
    draft.trunks['bare-1'] = {
        id: 'bare-1',
        modelId: 'm',
        rootId: 'r-bare-1',
        origin: 'standalone',
        segments: [{
            id: 'seg-bare-1',
            diameter: 0.89,
            bottomJoint: { id: 'bare-1-b', pos: { x: 0, y: 0, z: 1 }, diameter: 1.09 },
            topJoint: { id: 'bare-1-t', pos: { x: 0, y: 0, z: 5 }, diameter: 1.09 },
        }],
        contactCone: { id: 'c-bare', pos: { x: 0, y: 0, z: 5 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 0.5, lengthMm: 1.2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: 1 } },
    };

    const report = buildForestReport(draft, [
        ledgerEntry('v19', 'host-1', 15.9, 0.5),
        ledgerEntry('v0', 'bare-1', 5.0, 0.1),
    ]);

    assert.equal(report.trunkCount, 2);
    assert.equal(report.leafCount, 2);
    assert.equal(report.trees.length, 1);
    assert.equal(report.bareTrunks.length, 1);

    const tree = report.trees[0];
    assert.equal(tree.hostId, 'v19');
    assert.equal(tree.hostZ, 15.9);
    assert.equal(tree.shaftDiameterMm, 1.22);
    assert.equal(tree.members.length, 2);
    assert.equal(tree.members[0].id, 'leaf-a');
    assert.equal(tree.members[0].kind, 'leaf');
    // Knot at z=9.4, tip at z=15.9, dx=1.1 → span ≈ 6.51mm, angle ≈ 10°.
    assert.ok(Math.abs(tree.members[0].spanMm - Math.hypot(1.1, 6.5)) < 0.01);
    assert.ok(tree.sizingNote.includes('base Ø1.00'));

    const bare = report.bareTrunks[0];
    assert.equal(bare.id, 'v0');
    assert.equal(bare.shaftDiameterMm, 0.89);
    assert.ok(bare.sizingNote.includes('area 0.10mm²'));
});

test('forestSizingNote reports the height factor and area reasoning', () => {
    const note = forestSizingNote(ledgerEntry('v19', 'e', 40, 0.5), 1.3);
    // Z=40 → h = 1 + (40-20)/200 = 1.10.
    assert.ok(note.includes('h1.10'));
    assert.ok(note.includes('Ø1.30mm'));
    const short = forestSizingNote(ledgerEntry('v0', 'e', 5, 0.1), 0.89);
    // Z=5 → h = 1.00 (below the 20mm band start).
    assert.ok(short.includes('h1.00'));
});

test('forestReportToText renders the copyable plain-text report', () => {
    const report = buildForestReport(
        (() => {
            const s = emptySnapshot();
            s.trunks['host-1'] = {
                id: 'host-1',
                modelId: 'm',
                rootId: 'r-host-1',
                origin: 'standalone',
                segments: [{
                    id: 'seg-host-1',
                    diameter: 1.22,
                    bottomJoint: { id: 'host-1-b', pos: { x: 0, y: 0, z: 1 }, diameter: 1.42 },
                    topJoint: { id: 'host-1-t', pos: { x: 0, y: 0, z: 15.9 }, diameter: 1.42 },
                }],
                contactCone: { id: 'c-host', pos: { x: 0, y: 0, z: 15.9 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 0.5, lengthMm: 1.2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: 1 } },
            };
            s.knots['knot-a'] = { id: 'knot-a', parentShaftId: 'seg-host-1', pos: { x: 0, y: 0, z: 9.4 }, diameter: 1.345 };
            s.leaves['leaf-a'] = { id: 'leaf-a', modelId: 'm', parentKnotId: 'knot-a', contactCone: { id: 'c-a', pos: { x: 1.1, y: 0, z: 15.9 }, normal: { x: 0, y: 0, z: -1 }, profile: { type: 'disk', contactDiameterMm: 0.4, bodyDiameterMm: 0.5, lengthMm: 1.2, penetrationMm: 0.05, diskThicknessMm: 0.1, maxStandoffMm: 1.5, standoffAngleThreshold: 1 } } };
            return s;
        })(),
        [ledgerEntry('v19', 'host-1', 15.9, 0.5)],
    );
    report.scan = {
        islands: 184,
        bySource: { voxel: 150, minima: 30, intersection: 0, overhang: 4 },
        overhangRegions: 5,
        anchorClusters: 1,
        anchorRegions: 3,
        candidates: 183,
        totalAreaMm2: 1280,
        coveragePercent: 100,
        uncoveredIslands: 5,
        rejected: 10,
    };

    const text = forestReportToText(report);
    assert.ok(text.startsWith('FOREST REPORT'));
    assert.ok(text.includes('1 trunks · 1 leaves'));
    assert.ok(text.includes('v19 @ Z=15.9mm'));
    assert.ok(text.includes('leaf-a(L 6.6mm/'));
    assert.ok(text.includes('SCAN'), 'scan section rendered');
    assert.ok(text.includes('184 islands (voxel 150 · minima 30 · intersection 0 · overhang 4)'));
    assert.ok(text.includes('coverage 100% of 1280mm² (5 uncovered) · 10 rejected'));
});

