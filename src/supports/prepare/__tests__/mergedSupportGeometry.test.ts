import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import { DEFAULT_TIP_PROFILE } from '../../SupportPrimitives/ContactCone/types';
import type { InstancedContactCone } from '../../SupportPrimitives/ContactCone/InstancedContactConeGroup';
import type { InstancedJoint } from '../../SupportPrimitives/Joint/InstancedJointGroup';
import type { InstancedRoot } from '../../SupportPrimitives/Roots/InstancedRootsGroup';
import type { InstancedShaft } from '../../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { ProxyModelGeometry } from '../../SupportProxyMeshLayer';
import { buildMergedSupportGeometry } from '../mergedSupportGeometry';

/**
 * The merged Prepare support geometry.
 *
 * Pins the proxy's primitive triangle budgets, the two material groups, the
 * world-space bounds and the curved-shaft path. The plate-scale case at the end
 * exercises the buffer-building path on a production-sized primitive count; it
 * asserts only that it builds, and prints its own elapsed time.
 */

const MODEL = 'model-a';

function emptyModel(): ProxyModelGeometry {
    return { modelId: MODEL, shafts: [], roots: [], joints: [], cones: [] };
}

function shaft(id: string, start: [number, number, number], end: [number, number, number], diameter: number, diameterEnd?: number): InstancedShaft {
    return {
        id,
        modelId: MODEL,
        start: { x: start[0], y: start[1], z: start[2] },
        end: { x: end[0], y: end[1], z: end[2] },
        diameter,
        ...(diameterEnd != null ? { diameterEnd } : {}),
    };
}

const DISK_PROFILE = { ...DEFAULT_TIP_PROFILE };

function diskCone(id: string, pos: [number, number, number]): InstancedContactCone {
    return {
        id,
        modelId: MODEL,
        pos: { x: pos[0], y: pos[1], z: pos[2] },
        normal: { x: 0, y: 0, z: 1 },
        surfaceNormal: { x: 0, y: 0, z: 1 },
        profile: DISK_PROFILE,
    };
}

function root(id: string, bottomRadius: number, topRadius: number, coneHeight: number): InstancedRoot {
    return {
        id,
        modelId: MODEL,
        basePos: { x: 0, y: 0, z: 0 },
        bottomRadius,
        topRadius,
        effectiveDiskHeight: 0.5,
        coneHeight,
    };
}

function joint(id: string, pos: [number, number, number], diameter: number): InstancedJoint {
    return {
        id,
        modelId: MODEL,
        pos: { x: pos[0], y: pos[1], z: pos[2] },
        diameter,
    };
}

test('empty input builds an empty three-group geometry', () => {
    const merged = buildMergedSupportGeometry(emptyModel());

    assert.equal(merged.triangles, 0);
    assert.equal(merged.modelId, MODEL);
    assert.equal(merged.geometry.groups.length, 3);
    assert.equal(merged.geometry.groups[0].materialIndex, 0);
    assert.equal(merged.geometry.groups[1].materialIndex, 1);
    assert.equal(merged.geometry.groups[2].materialIndex, 2);
    assert.equal(merged.geometry.groups[0].count, 0);
    assert.equal(merged.geometry.groups[1].count, 0);
    assert.equal(merged.geometry.groups[2].count, 0);
    assert.equal(merged.geometry.getAttribute('position').count, 0);
});

test('straight and tapered shafts share the body group and keep their endpoints in bounds', () => {
    const model = emptyModel();
    model.shafts = [
        shaft('straight', [0, 0, 0], [0, 0, 10], 1),
        shaft('tapered', [2, 0, 0], [2, 0, 10], 1, 0.5),
    ];

    const merged = buildMergedSupportGeometry(model);

    // One capped 10-segment cylinder each: 20 side + 2 x 10 cap triangles.
    assert.equal(merged.triangles, 80);
    assert.equal(merged.geometry.groups[0].count, 240);
    assert.equal(merged.geometry.groups[1].count, 0);

    const bounds = merged.geometry.boundingBox!;
    assert.ok(bounds.min.z <= 1e-4, `shaft start z ${bounds.min.z}`);
    assert.ok(bounds.max.z >= 10 - 1e-4, `shaft end z ${bounds.max.z}`);
    assert.ok(bounds.min.x <= 1e-4 && bounds.max.x >= 2 - 1e-4);
});

test('root, joint and disk-profile cone land in the expected groups', () => {
    const model = emptyModel();
    model.roots = [root('root', 2, 1, 1)];
    model.joints = [joint('joint', [5, 5, 5], 1)];
    model.cones = [diskCone('cone', [0, 0, 10])];

    const merged = buildMergedSupportGeometry(model);

    // Root: disk 40 (disc) + base cone 40 + top ball 80 (body).
    // Joint: 80 (body). Cone: body 40 (body), tip 80 + disk 40 (disc).
    assert.equal(merged.triangles, 400);
    assert.equal(merged.geometry.groups[0].count, 720);
    assert.equal(merged.geometry.groups[1].count, 120, 'one contact disk');
    assert.equal(merged.geometry.groups[2].count, 360, 'tip sphere plus root disk');

    const bounds = merged.geometry.boundingBox!;
    assert.ok(bounds.containsPoint(new THREE.Vector3(5, 5, 5)));
    assert.ok(bounds.max.z >= 10, `cone tip z ${bounds.max.z}`);
});

test('curved shafts sweep tubes and add triangles', () => {
    const straight = emptyModel();
    straight.shafts = [shaft('straight', [0, 0, 0], [0, 0, 10], 1)];

    const curved = emptyModel();
    curved.shafts = [{
        ...shaft('curved', [0, 0, 0], [0, 0, 10], 1),
        controlPoint1: { x: 3, y: 0, z: 3 },
        controlPoint2: { x: 3, y: 0, z: 7 },
        resolution: 8,
    }];

    const straightTriangles = buildMergedSupportGeometry(straight).triangles;
    const merged = buildMergedSupportGeometry(curved);

    assert.equal(merged.geometry.groups[1].count, 0);
    assert.equal(merged.geometry.groups[2].count, 0);
    // 8 tubular x 10 radial side triangles, plus ten triangles per flat cap.
    assert.equal(merged.triangles, 180);
    assert.ok(merged.triangles > straightTriangles);
    assert.ok(merged.geometry.boundingBox!.max.x >= 2, 'curve bulges into the control net');
});

test('plate-scale synthetic set builds', () => {
    const model = syntheticPlate(15_359, 16_004, 10_904, 2_169);

    const startedAt = performance.now();
    const merged = buildMergedSupportGeometry(model);
    const elapsedMs = performance.now() - startedAt;

    assert.ok(merged.triangles > 0);
    assert.equal(merged.geometry.groups.length, 3);
    assert.ok(merged.geometry.boundingSphere);
    console.log(
        `[merged support geometry] ${merged.triangles} triangles from `
        + `${model.shafts.length} shafts, ${model.joints.length} joints, `
        + `${model.cones.length} cones, ${model.roots.length} roots in ${elapsedMs.toFixed(1)} ms`,
    );
});

/** A production-sized primitive set spread over a plate, deterministic in shape. */
function syntheticPlate(shaftCount: number, jointCount: number, coneCount: number, rootCount: number): ProxyModelGeometry {
    const model = emptyModel();
    const shafts: InstancedShaft[] = [];
    const joints: InstancedJoint[] = [];
    const cones: InstancedContactCone[] = [];
    const roots: InstancedRoot[] = [];

    const gridX = 180;
    const xAt = (index: number) => (index % gridX) * 1.4;
    const yAt = (index: number) => Math.floor(index / gridX) * 1.4;

    for (let i = 0; i < shaftCount; i += 1) {
        const x = xAt(i);
        const y = yAt(i);
        const baseZ = (i % 53) * 0.2;
        const height = 4 + (i % 31) * 0.3;
        const diameter = 0.6 + (i % 7) * 0.05;
        if (i % 997 === 0) {
            shafts.push({
                id: `shaft-${i}`,
                modelId: MODEL,
                start: { x, y, z: baseZ },
                end: { x: x + 1.5, y, z: baseZ + height },
                controlPoint1: { x: x - 1, y: y + 1, z: baseZ + height * 0.33 },
                controlPoint2: { x: x + 2.5, y: y - 1, z: baseZ + height * 0.66 },
                diameter,
            });
        } else {
            shafts.push({
                id: `shaft-${i}`,
                modelId: MODEL,
                start: { x, y, z: baseZ },
                end: { x: x + ((i % 5) - 2) * 0.05, y, z: baseZ + height },
                diameter,
                ...(i % 13 === 0 ? { diameterEnd: diameter * 0.5 } : {}),
            });
        }
    }

    for (let i = 0; i < jointCount; i += 1) {
        joints.push({
            id: `joint-${i}`,
            modelId: MODEL,
            pos: { x: xAt(i) + 0.2, y: yAt(i), z: (i % 41) * 0.25 },
            diameter: 0.8 + (i % 5) * 0.1,
        });
    }

    for (let i = 0; i < coneCount; i += 1) {
        cones.push({
            id: `cone-${i}`,
            modelId: MODEL,
            pos: { x: xAt(i) + 0.1, y: yAt(i) + 0.1, z: 10 + (i % 29) * 0.2 },
            normal: { x: 0, y: 0, z: 1 },
            surfaceNormal: { x: 0, y: 0, z: 1 },
            profile: {
                ...DEFAULT_TIP_PROFILE,
                contactDiameterMm: 0.4,
                bodyDiameterMm: 0.8 + (i % 40) * 0.05,
                lengthMm: 2.5 + (i % 11) * 0.1,
            },
        });
    }

    for (let i = 0; i < rootCount; i += 1) {
        roots.push({
            id: `root-${i}`,
            modelId: MODEL,
            basePos: { x: xAt(i) * 1.2, y: yAt(i) + 0.3, z: 0 },
            bottomRadius: 1.2 + (i % 9) * 0.1,
            topRadius: 0.6 + (i % 4) * 0.1,
            effectiveDiskHeight: 0.4 + (i % 3) * 0.1,
            coneHeight: 0.8 + (i % 6) * 0.1,
        });
    }

    model.shafts = shafts;
    model.joints = joints;
    model.cones = cones;
    model.roots = roots;
    return model;
}

test('a skipped sub-millimetre shaft leaves no degenerate indices or vertices behind', () => {
  const empty = {
    shafts: [
      {
        id: 'tiny', supportId: 'p', modelId: 'm',
        start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 0 },
        diameter: 1, diameterEnd: 1,
      },
      {
        id: 'ok', supportId: 'p', modelId: 'm',
        start: { x: 0, y: 0, z: 0 }, end: { x: 0, y: 0, z: 10 },
        diameter: 1, diameterEnd: 1,
      },
    ],
    roots: [], joints: [], cones: [],
  } as never;
  const merged = buildMergedSupportGeometry(empty);
  assert.equal(merged.geometry.getIndex()?.count, merged.triangles * 3);
  const oneShaftVertices = new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, false).getAttribute('position').count;
  assert.equal(
    merged.geometry.getAttribute('position').count,
    oneShaftVertices,
    'the skipped shaft must not leave its vertices in the buffer',
  );
  assert.ok(merged.geometry.boundingBox);
  assert.ok(merged.geometry.boundingBox.max.z >= 9.9, 'the kept shaft must define the bounds');
  assert.equal(merged.geometry.groups.length, 3);
});

