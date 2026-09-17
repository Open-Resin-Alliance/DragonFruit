import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { initializeBVH, accelerateGeometry } from '../../../utils/bvh';
import { calculateSmartPlacementV3 } from '../SmartPlacementV3';
import { findEscapeJoint, findGridJoint } from '../EscapeJointSearch';
import type { SDFCache } from '../../PlacementLogic/Pathfinding/SDFCache';
import { setSettings } from '../../Settings/state';
import { createDefaultSettings } from '../../Settings/types';
import type { Vec3 } from '../../types';

// ---------- pure search, against an analytic model ----------

interface Box {
    min: [number, number, number];
    max: [number, number, number];
}

function signedDistanceToBox(p: Vec3, box: Box): number {
    const qx = Math.max(box.min[0] - p.x, p.x - box.max[0]);
    const qy = Math.max(box.min[1] - p.y, p.y - box.max[1]);
    const qz = Math.max(box.min[2] - p.z, p.z - box.max[2]);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}

function makeBoxSdf(boxes: Box[]): SDFCache {
    const distanceAt = (x: number, y: number, z: number): number => {
        let best = Infinity;
        for (const box of boxes) best = Math.min(best, signedDistanceToBox({ x, y, z }, box));
        return best;
    };
    return {
        cellSize: 0.5,
        distanceAt,
        segmentBlocked: (
            ax: number, ay: number, az: number,
            bx: number, by: number, bz: number,
            clearance: number,
        ) => {
            const len = Math.hypot(bx - ax, by - ay, bz - az);
            const steps = Math.max(1, Math.ceil(len / 0.25));
            for (let i = 0; i <= steps; i++) {
                const t = i / steps;
                if (distanceAt(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t) < clearance) return true;
            }
            return false;
        },
    } as unknown as SDFCache;
}

const SEARCH = {
    clearanceMm: 0.98,
    stepMm: 0.5,
    maxLateralMm: 48,
    minVerticalLegMm: 1.0,
    directions: [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }],
    baseFitsAt: () => true,
};

test('findEscapeJoint: takes the closest column that clears, at the 45 degree shape', () => {
    // Body under the socket, spanning x ∈ [-3, 5]: the column straight down is
    // blocked, and clearing it costs 6mm of travel to +x but only 4mm to -x.
    const sdf = makeBoxSdf([{ min: [-3, -5, 0], max: [5, 5, 12] }]);
    const socketPos = { x: 0, y: 0, z: 20 };

    const result = findEscapeJoint(sdf, socketPos, 0, { ...SEARCH, leanRampFromVerticalDeg: [45] });

    assert.equal(result.outcome, 'found');
    const joint = result.joint!;
    // 45 degrees: the lateral travel equals the drop.
    assert.ok(Math.abs(joint.lateralMm - (socketPos.z - joint.joint.z)) < 1e-9,
        `45° diagonal, lateral ${joint.lateralMm.toFixed(3)} vs drop ${(socketPos.z - joint.joint.z).toFixed(3)}`);
    assert.equal(joint.leanFromVerticalDeg, 45);

    // The nearer column wins over the first direction tried. Taking the first
    // direction's answer is what produced supports that lean out until some
    // column clears when a neighbouring direction had a closer one.
    // Within one walk step (0.5mm of travel, 0.35mm of lateral) of the first
    // column that clears on that side.
    assert.ok(joint.lateralMm > 3.9 && joint.lateralMm < 4.4,
        `stops at the nearest clear column, got ${joint.lateralMm.toFixed(2)}mm`);
    assert.ok(joint.joint.x < 0,
        `and it is the -x side, got x=${joint.joint.x.toFixed(2)}`);
});

test('findEscapeJoint: escalates the lean only when no 45 degree leg can clear', () => {
    // Body slab with a taller lip standing on both sides, right where every 45°
    // ray passes: every direction is blocked at 45°, and the column below clears
    // only past the lip, so getting out needs a shallower diagonal.
    const sdf = makeBoxSdf([
        { min: [-5, -100, 0], max: [5, 100, 12] },
        { min: [3, -100, 0], max: [5, 100, 15] },
        { min: [-5, -100, 0], max: [-3, 100, 15] },
    ]);
    const socketPos = { x: 0, y: 0, z: 20 };

    const at45 = findEscapeJoint(sdf, socketPos, 0, { ...SEARCH, leanRampFromVerticalDeg: [45] });
    assert.equal(at45.joint, null, 'no 45° leg gets around the lips');

    const ramped = findEscapeJoint(sdf, socketPos, 0, { ...SEARCH, leanRampFromVerticalDeg: [45, 60, 75] });
    assert.equal(ramped.outcome, 'found');
    assert.ok(ramped.joint!.leanFromVerticalDeg > 45,
        `escalated to ${ramped.joint!.leanFromVerticalDeg}°`);
});

test('findEscapeJoint: gives up instead of growing an unbounded search', () => {
    // A slab covering the whole plane at every reachable height.
    const sdf = makeBoxSdf([{ min: [-100, -100, 0], max: [100, 100, 19] }]);

    const result = findEscapeJoint(sdf, { x: 0, y: 0, z: 20 }, 0, {
        ...SEARCH,
        leanRampFromVerticalDeg: [45, 60, 75, 89],
    });

    assert.equal(result.joint, null);
    assert.ok(result.probes > 0);
});

test('findGridJoint: keeps the escape heading the way the cone points', () => {
    // A block under the socket's own node, so the nearest usable nodes are the
    // two neighbours either side, exactly the same distance away. Which one the
    // shaft reaches for is decided by the direction it is already going.
    const sdf = makeBoxSdf([{ min: [-2, -5, 0], max: [2, 5, 15] }]);
    const socketPos = { x: 0, y: 0, z: 20 };
    const options = {
        clearanceMm: 0.98,
        spacingMm: 4,
        maxLateralMm: 48,
        leanRampFromVerticalDeg: [45],
        minVerticalLegMm: 1.0,
        maxNodeCount: 24,
        baseFitsAt: () => true,
    };

    const rightwards = findGridJoint(sdf, socketPos, 0, { ...options, preferredDirection: { x: 1, y: 0 } });
    assert.equal(rightwards.joint?.joint.x, 4, 'goes right when the cone points right');
    assert.equal(rightwards.joint?.joint.z, 16, 'lands on the node at a 45 degree drop');

    const leftwards = findGridJoint(sdf, socketPos, 0, { ...options, preferredDirection: { x: -1, y: 0 } });
    assert.equal(leftwards.joint?.joint.x, -4, 'goes left when the cone points left');
});

// ---------- the placement contract ----------

const TIP_PROFILE = {
    type: 'disk' as const,
    contactDiameterMm: 0.4,
    bodyDiameterMm: 1.2,
    lengthMm: 1.2,
    penetrationMm: 0.05,
    diskThicknessMm: 0.1,
    maxStandoffMm: 0.35,
    standoffAngleThreshold: Math.PI / 4,
};

function angleFromVerticalDeg(a: Vec3, b: Vec3): number {
    return (Math.atan2(Math.hypot(b.x - a.x, b.y - a.y), Math.abs(b.z - a.z)) * 180) / Math.PI;
}

/** Jaw chip overhanging a body slab: the tip's column down pierces the body. */
function placeUnderJaw(gridEnabled = false) {
    initializeBVH();
    const body = new THREE.BoxGeometry(25, 20, 10);
    body.translate(-7.5, 0, 5);
    const jaw = new THREE.BoxGeometry(4, 4, 2);
    jaw.translate(3.5, 0, 17);
    const geometry = mergeGeometries([body, jaw])!;
    accelerateGeometry(geometry);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);

    const settings = createDefaultSettings();
    settings.grid.enabled = gridEnabled;
    if (gridEnabled) settings.grid.spacingMm = 2;
    setSettings(settings);
    return calculateSmartPlacementV3({
        tipPos: { x: 3.5, y: 0, z: 16 },
        tipNormal: { x: 0, y: 0, z: -1 },
        tipProfile: TIP_PROFILE,
        modelId: 'model-v3',
        mesh,
        rootsTopZ: 2,
    });
}

test('a routed trunk is one diagonal and one vertical drop, never a wandering chain', () => {
    const result = placeUnderJaw();

    assert.equal(result.error, undefined);
    assert.equal(result.joints!.length, 1, `one joint, got ${result.joints!.length}`);

    const socket = result.socketPos!;
    const joint = result.joints![0];
    const diagonalDeg = angleFromVerticalDeg(socket, joint);
    assert.ok(diagonalDeg <= 75.05, `diagonal stays within the lean ceiling, got ${diagonalDeg.toFixed(2)}°`);

    // Everything below the joint is the load-bearing span, and it is vertical:
    // the trunk's only tilt is the short escape at the tip.
    const dropLateralMm = Math.hypot(result.basePos!.x - joint.x, result.basePos!.y - joint.y);
    assert.ok(dropLateralMm < 0.2,
        `drop is vertical, lateral offset ${dropLateralMm.toFixed(3)}mm`);
    assert.ok(joint.z > 10, `joint sits clear of the body top, got ${joint.z.toFixed(2)}`);
});

test('with the grid on, the joint is the node and the drop stays vertical', () => {
    const result = placeUnderJaw(true);

    assert.equal(result.error, undefined);
    assert.equal(result.joints!.length, 1);
    assert.ok(result.snappedNodeKey, 'the base committed to a grid node');

    const joint = result.joints![0];

    // Grid mode picks the node first and derives the joint from it, so the
    // load-bearing leg does not lean to reach the lattice. Walking the base out
    // to a node whose roots fit is what produced a support leaning across to a
    // distant node with no joint in it at all.
    assert.equal(result.basePos!.x, joint.x, 'the drop is vertical in X');
    assert.equal(result.basePos!.y, joint.y, 'the drop is vertical in Y');

    // And the joint is on the lattice, which is what makes that possible.
    const spacingMm = 2;
    for (const axis of ['x', 'y'] as const) {
        const cells = joint[axis] / spacingMm;
        assert.ok(Math.abs(cells - Math.round(cells)) < 1e-9,
            `joint ${axis}=${joint[axis]} sits on a ${spacingMm}mm node`);
    }
});
