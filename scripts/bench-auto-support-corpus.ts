/**
 * The corpus the auto-support harness measures.
 *
 * Synthetic on purpose. An entry is a mesh *plus* the islands it presents,
 * authored together so that each one exercises a known branch of the placement
 * pipeline: a big flat underside (ring + lattice + consolidation), a sliver
 * (ring only), two pillars close enough to merge, a sloped overhang (real 3D
 * normals and the cone-axis policy), a steep flat (toppling spacing), an
 * enclosed ceiling (the cavity fallback), and a part with nothing to support.
 *
 * Every entry here authors its islands (`islands` is never null), so a run over
 * this corpus measures the placement pipeline and not the detectors, and two runs
 * are comparable across a change to placement. A model from `--corpus` has no
 * authored set and is detected instead.
 *
 * Every mesh is built in build-plate millimeters, Z up, sitting on z = 0.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { footprintFromPoints } from '../src/volumeAnalysis/Islands/voxelFootprint';
import type { DetectedIsland } from '../src/volumeAnalysis/Islands/types';

export interface CorpusEntry {
    /** Stable name, used as the model id and in the baseline. */
    name: string;
    /** The pipeline branch this entry exists to exercise. */
    exercises: string;
    /** World-space mesh, already posed and BVH-able. */
    geometry: () => THREE.BufferGeometry;
    /**
     * The islands that mesh presents, in world space, or null when this entry
     * expects the harness to detect them from the mesh.
     */
    islands: (() => DetectedIsland[]) | null;
}

/** A grid of footprint samples over an axis-aligned patch, `spacingMm` apart. */
function patch(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    spacingMm: number,
    z: (x: number, y: number) => number | undefined,
): { x: number; y: number; z?: number }[] {
    const points: { x: number; y: number; z?: number }[] = [];
    for (let x = x0; x <= x1 + 1e-9; x += spacingMm) {
        for (let y = y0; y <= y1 + 1e-9; y += spacingMm) {
            const surfaceZ = z(x, y);
            points.push(surfaceZ === undefined ? { x, y } : { x, y, z: surfaceZ });
        }
    }
    return points;
}

/** Moves a geometry so its lowest point is on the plate and its bbox is centred in XY. */
function seatOnPlate(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    geometry.translate(-(box.min.x + box.max.x) / 2, -(box.min.y + box.max.y) / 2, -box.min.z);
    return geometry;
}

export const SYNTHETIC_CORPUS: CorpusEntry[] = [
    {
        name: 'overhang-slab',
        exercises: 'a large flat underside with a pedestal in the middle: boundary ring, lattice infill, routed drops around the pedestal, chunk consolidation',
        geometry: () => {
            const slab = new THREE.BoxGeometry(30, 30, 2).translate(0, 0, 21); // underside at z = 20
            const pedestal = new THREE.BoxGeometry(6, 6, 20).translate(0, 0, 10);
            return mergeGeometries([slab, pedestal])!;
        },
        islands: () => [{
            id: 'o-slab',
            source: 'overhang',
            contact: new THREE.Vector3(0, -12, 20),
            baseZ: 20,
            areaMm2: 900 - 49,
            overhangAngleDeg: 0,
            surfaceNormal: { x: 0, y: 0, z: -1 },
            contactVoxels: footprintFromPoints([
                // The underside minus the pedestal's 6 x 6 footprint (plus its clearance).
                ...patch(-15, 15, -15, -3.5, 0.5, () => 20),
                ...patch(-15, 15, 3.5, 15, 0.5, () => 20),
                ...patch(-15, -3.5, -3.5, 3.5, 0.5, () => 20),
                ...patch(3.5, 15, -3.5, 3.5, 0.5, () => 20),
            ]),
        }],
    },
    {
        name: 'narrow-rib',
        exercises: 'a sliver 1.4 mm wide: the ring resamples the perimeter and the lattice is skipped because the footprint is thinner than one cell',
        geometry: () => {
            const rib = new THREE.BoxGeometry(24, 1.4, 1.2).translate(0, 0, 18.6); // underside at z = 18
            const post = new THREE.BoxGeometry(2, 2, 18).translate(0, 0, 9);
            return mergeGeometries([rib, post])!;
        },
        islands: () => [{
            id: 'o-rib',
            source: 'overhang',
            contact: new THREE.Vector3(-10, 0, 18),
            baseZ: 18,
            areaMm2: 24 * 1.4,
            overhangAngleDeg: 0,
            surfaceNormal: { x: 0, y: 0, z: -1 },
            contactVoxels: footprintFromPoints(patch(-12, 12, -0.5, 0.5, 0.25, () => 18)),
        }],
    },
    {
        name: 'staggered-twins',
        exercises: 'two contacts 3 mm apart in plan and 3 mm apart in height: the fan and merge gates refuse the link (the chord to the higher trunk is past the angle bound), so both stand as plate contacts. Pins the refusal path.',
        geometry: () => {
            // Floating plates: nothing stands under the contacts, so the roots
            // volume fits and the only question left is whether the second
            // contact attaches to the first support or stands on its own.
            const high = new THREE.BoxGeometry(4, 4, 1.5).translate(-1.5, 0, 14.75); // underside at z = 14
            const low = new THREE.BoxGeometry(4, 4, 1.5).translate(1.5, 0, 11.75); // underside at z = 11
            return mergeGeometries([high, low])!;
        },
        islands: () => [
            {
                id: 'o-high',
                source: 'overhang',
                contact: new THREE.Vector3(-1.5, 0, 14),
                baseZ: 14,
                areaMm2: 16,
                overhangAngleDeg: 0,
                surfaceNormal: { x: 0, y: 0, z: -1 },
                contactVoxels: footprintFromPoints(patch(-3.5, 0.5, -2, 2, 0.5, () => 14)),
            },
            {
                id: 'o-low',
                source: 'overhang',
                contact: new THREE.Vector3(1.5, 0, 11),
                baseZ: 11,
                areaMm2: 16,
                overhangAngleDeg: 0,
                surfaceNormal: { x: 0, y: 0, z: -1 },
                contactVoxels: footprintFromPoints(patch(0.5, 3.5, -2, 2, 0.5, () => 11)),
            },
        ],
    },
    {
        name: 'sloped-cantilever',
        exercises: 'a 25 degree underside: cells sample the real face normal, so the cone axis policy and the contact gates run on sloped geometry',
        geometry: () => {
            const tiltRad = THREE.MathUtils.degToRad(25);
            const slab = new THREE.BoxGeometry(24, 24, 2).rotateX(-tiltRad);
            const wall = new THREE.BoxGeometry(24, 3, 22).translate(0, -10.5, 11);
            return seatOnPlate(mergeGeometries([slab.translate(0, 0, 18), wall])!);
        },
        islands: () => {
            const tiltRad = THREE.MathUtils.degToRad(25);
            // The underside plane after rotateX(-25): z = y * tan(25) + c, rebased by seatOnPlate.
            const surface = (y: number) => y * Math.tan(tiltRad) + 18 - 1 / Math.cos(tiltRad);
            return [{
                id: 'o-slope',
                source: 'overhang',
                contact: new THREE.Vector3(0, -9, surface(-9)),
                baseZ: surface(-9),
                areaMm2: Math.pow(24, 2) * Math.cos(tiltRad),
                overhangAngleDeg: 25,
                surfaceNormal: { x: 0, y: -Math.sin(tiltRad), z: -Math.cos(tiltRad) },
                contactVoxels: footprintFromPoints(patch(-11, 11, -9, 9, 0.5, (_x, y) => surface(y))),
            }];
        },
    },
    {
        name: 'steep-flat-wedge',
        exercises: 'a 60 degree face classified as a steep flat: sparse toppling contact instead of formation density, plus stabilization anchors on the low edge',
        geometry: () => {
            const tiltRad = THREE.MathUtils.degToRad(60);
            const face = new THREE.BoxGeometry(24, 20, 2).rotateX(-tiltRad).translate(0, 0, 16);
            const base = new THREE.BoxGeometry(24, 8, 6).translate(0, -3, 3);
            return seatOnPlate(mergeGeometries([face, base])!);
        },
        islands: () => {
            const tiltRad = THREE.MathUtils.degToRad(60);
            const surface = (y: number) => y * Math.tan(tiltRad) + 16 - 1 / Math.cos(tiltRad);
            return [{
                id: 'o-steep',
                source: 'overhang',
                contact: new THREE.Vector3(0, -8, surface(-8)),
                baseZ: surface(-8),
                areaMm2: 24 * 20 * Math.cos(tiltRad),
                surfaceAreaMm2: 24 * 20,
                maxZ: surface(10),
                overhangAngleDeg: 60,
                steepFlat: true,
                dragMomentMm3: 24 * 20 * Math.sin(tiltRad) * 16,
                dragDirDeg: 180,
                surfaceNormal: { x: 0, y: -Math.sin(tiltRad), z: -Math.cos(tiltRad) },
                contactVoxels: footprintFromPoints(patch(-11, 11, -8, 10, 0.5, (_x, y) => surface(y))),
            }];
        },
    },
    {
        name: 'cavity-ceiling',
        exercises: 'an enclosed ceiling: the tip has no plate route, so the cavity fallback bridges model to model (stick or twig, ray-cast collision)',
        geometry: () => {
            const outer = 18;
            const wall = 2;
            const top = 16;
            const parts = [
                new THREE.BoxGeometry(outer, outer, wall).translate(0, 0, top - wall / 2), // ceiling at z = 14
                new THREE.BoxGeometry(wall, outer, top).translate(-(outer - wall) / 2, 0, top / 2),
                new THREE.BoxGeometry(wall, outer, top).translate((outer - wall) / 2, 0, top / 2),
                new THREE.BoxGeometry(outer, wall, top).translate(0, -(outer - wall) / 2, top / 2),
                new THREE.BoxGeometry(outer, wall, top).translate(0, (outer - wall) / 2, top / 2),
                new THREE.BoxGeometry(outer, outer, wall).translate(0, 0, wall / 2), // floor
            ];
            return mergeGeometries(parts)!;
        },
        islands: () => [{
            id: 'o-cavity',
            source: 'overhang',
            contact: new THREE.Vector3(0, 0, 14),
            baseZ: 14,
            areaMm2: 14 * 14,
            overhangAngleDeg: 0,
            surfaceNormal: { x: 0, y: 0, z: -1 },
            contactVoxels: footprintFromPoints(patch(-7, 7, -7, 7, 0.5, () => 14)),
        }],
    },
    {
        name: 'flat-base',
        exercises: 'nothing to support: the run must be a no-op rather than a crash or a stray support',
        geometry: () => new THREE.BoxGeometry(20, 20, 10).translate(0, 0, 5),
        islands: () => [],
    },
];

export function corpusEntry(name: string): CorpusEntry {
    const entry = SYNTHETIC_CORPUS.find((candidate) => candidate.name === name);
    if (!entry) {
        throw new Error(`no corpus entry "${name}"; known: ${SYNTHETIC_CORPUS.map((c) => c.name).join(', ')}`);
    }
    return entry;
}
