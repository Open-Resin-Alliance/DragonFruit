import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

import {
    generateGridCandidates,
    createTriangleSurfaceAt,
    createVoxelSurfaceAt,
} from '../autoSupport/gridPlacement';
import { footprintFromPoints, footprintToPoints } from '../../volumeAnalysis/Islands/voxelFootprint';
import { createDefaultAutoSupportSettings } from '../autoSupport/settings';
import type { DetectedIsland } from '../../volumeAnalysis/Islands/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Exact surface height of the fixture plane. */
const PLANE_Z = (x: number) => 5 + 0.2 * x;

/**
 * Two-triangle sloped plane, x/y ∈ [-10, 10], z = 5 + 0.2·x, wound so the
 * front faces face downward (an overhang underside).
 */
function slopedPlaneMesh(): THREE.Mesh {
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array([
        -10, -10, PLANE_Z(-10), 10, 10, PLANE_Z(10), 10, -10, PLANE_Z(10),
        -10, -10, PLANE_Z(-10), -10, 10, PLANE_Z(-10), 10, 10, PLANE_Z(10),
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mesh = new THREE.Mesh(g);
    mesh.updateMatrixWorld();
    return mesh;
}

/**
 * Region over the same footprint. The contact voxels carry Z quantized to the
 * 0.25 mm mask spacing — deliberately WRONG vs the exact plane — so the tests
 * prove the sampler used triangles, not the voxel fallback.
 */
function slopedRegion(id: string, triangleIds?: number[]): DetectedIsland {
    const contactVoxels: { x: number; y: number; z?: number }[] = [];
    for (let x = -10; x <= 10; x += 0.25) {
        for (let y = -10; y <= 10; y += 0.25) {
            contactVoxels.push({ x, y, z: Math.round(PLANE_Z(x) * 4) / 4 });
        }
    }
    return {
        id,
        source: 'overhang',
        contact: new THREE.Vector3(0, 0, PLANE_Z(-10)),
        baseZ: PLANE_Z(-10),
        areaMm2: 400,
        overhangAngleDeg: 11,
        surfaceNormal: { x: 0, y: 0.196, z: -0.98 },
        contactVoxels: footprintFromPoints(contactVoxels),
        ...(triangleIds ? { triangleIds } : {}),
    };
}

const settings = {
    ...createDefaultAutoSupportSettings(),
    areaPerSupportMm2: 8,
    gridAreaThresholdMm2: 25,
    suctionAreaExponent: 0,
};

const onPlane = (c: { tipPos: { x: number; y: number; z: number } }) =>
    Math.abs(c.tipPos.z - PLANE_Z(c.tipPos.x));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('triangle sampler resolves exact plane height where the voxel mask is quantized', () => {
    const mesh = slopedPlaneMesh();
    const island = slopedRegion('o0', [0, 1]);

    const tri = createTriangleSurfaceAt(island, mesh)!;
    const voxel = createVoxelSurfaceAt(footprintToPoints(island.contactVoxels!), Math.max(settings.areaPerSupportMm2, 1) ** 0.5, island.baseZ);

    assert.ok(Math.abs(tri(3.1, -2.7)!.z - PLANE_Z(3.1)) < 1e-9, 'triangle sampler is exact');
    assert.ok(
        Math.abs(voxel(3.1, -2.7)!.z - PLANE_Z(3.1)) > 0.001,
        'voxel sampler is quantized — the fixture really distinguishes the paths',
    );
});

test('grid interior sits exactly on the mesh surface', () => {
    const mesh = slopedPlaneMesh();
    const candidates = generateGridCandidates(
        [slopedRegion('o0', [0, 1])], settings, mesh,
    );

    const lattice = candidates.filter((c) => c.id.startsWith('grid-'));
    assert.ok(lattice.length >= 30, `interior lattice generated (${lattice.length})`);
    for (const c of lattice) {
        assert.ok(onPlane(c) < 1e-6, `grid tip (${c.tipPos.x.toFixed(2)}) on plane, dz=${onPlane(c)}`);
    }
});

test('grid containment follows the triangles, not the coarse mask', () => {
    // Triangles cover only the LEFT half of the voxel-mask bbox.
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array([
        -10, -10, PLANE_Z(-10), 0, 10, PLANE_Z(0), 0, -10, PLANE_Z(0),
        -10, -10, PLANE_Z(-10), -10, 10, PLANE_Z(-10), 0, 10, PLANE_Z(0),
    ]);
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const halfMesh = new THREE.Mesh(g);
    halfMesh.updateMatrixWorld();

    const candidates = generateGridCandidates(
        [slopedRegion('o0', [0, 1])], settings, halfMesh,
    );

    const lattice = candidates.filter((c) => c.id.startsWith('grid-'));
    assert.ok(lattice.length >= 10, 'left half still latticed');
    for (const c of lattice) {
        assert.ok(c.tipPos.x <= 0 + 1e-9, `no lattice point right of the true region edge (${c.tipPos.x})`);
    }
});

test('without a mesh the generators fall back to voxel sampling unchanged', () => {
    const region = slopedRegion('o0', [0, 1]);
    const candidates = generateGridCandidates([region], settings);
    assert.ok(candidates.length > 0);
    // Quantized fixture heights are NOT the exact plane — proves fallback ran.
    assert.ok(candidates.some((c) => onPlane(c) > 0.001));
});
