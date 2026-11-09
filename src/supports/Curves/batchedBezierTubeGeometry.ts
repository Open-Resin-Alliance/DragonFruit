import * as THREE from 'three';
import { calculateAdaptiveBezierResolution } from './BezierUtils';
import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';

export interface BatchedBezierTubes {
    geometry: THREE.BufferGeometry;
    /**
     * Cumulative triangle-end offsets aligned with the input curve list:
     * curve i owns triangles [i === 0 ? 0 : ends[i-1], ends[i]).
     */
    triangleRangeEnds: number[];
}

/**
 * One swept tube per curved shaft, kept by the shaft object it came from.
 *
 * The batches are re-laid-out whenever the visible set changes, and building a
 * `TubeGeometry` per shaft again is most of that cost. The shafts themselves are
 * rebuilt only when the support state changes, so the cache follows them.
 */
const tubeGeometryCache = new WeakMap<InstancedShaft, {
    curve: THREE.CubicBezierCurve3;
    tubularSegments: number;
    tube: THREE.TubeGeometry;
}>();

export function isCurvedBatchedShaft(shaft: InstancedShaft): boolean {
    return shaft.controlPoint1 != null && shaft.controlPoint2 != null;
}

/**
 * The swept tube for one shaft, from the cache or built now.
 *
 * Building a `TubeGeometry` is the expensive half of laying a batch out (the
 * merge is a buffer copy). It is per shaft, so a caller can warm a batch in idle
 * slices instead of paying all of it inside a render — see `warmBezierTube`.
 */
function sweptTubeFor(shaft: InstancedShaft, radialSegments: number): {
    curve: THREE.CubicBezierCurve3;
    tubularSegments: number;
    tube: THREE.TubeGeometry;
} {
    const cached = tubeGeometryCache.get(shaft);
    if (cached) return cached;

    const curve = new THREE.CubicBezierCurve3(
        new THREE.Vector3(shaft.start.x, shaft.start.y, shaft.start.z),
        new THREE.Vector3(shaft.controlPoint1!.x, shaft.controlPoint1!.y, shaft.controlPoint1!.z),
        new THREE.Vector3(shaft.controlPoint2!.x, shaft.controlPoint2!.y, shaft.controlPoint2!.z),
        new THREE.Vector3(shaft.end.x, shaft.end.y, shaft.end.z),
    );
    const tubularSegments = Math.max(2, Math.floor(
        shaft.resolution
        ?? calculateAdaptiveBezierResolution(shaft.start, shaft.controlPoint1!, shaft.controlPoint2!, shaft.end),
    ));
    const radius = Math.max(0.0005, shaft.diameter / 2);
    const entry = {
        curve,
        tubularSegments,
        tube: new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false),
    };
    tubeGeometryCache.set(shaft, entry);
    return entry;
}

/** Whether this shaft's tube is already built, so a warmer can skip it cheaply. */
export function hasCachedBezierTube(shaft: InstancedShaft): boolean {
    return tubeGeometryCache.has(shaft);
}

/** Build one shaft's tube now; call from an idle slice, never from render. */
export function warmBezierTube(shaft: InstancedShaft, radialSegments: number): void {
    sweptTubeFor(shaft, radialSegments);
}

/**
 * Split a batch's shafts into the ones the merged tube mesh draws and the ones
 * the instanced mesh draws.
 *
 * The instanced batch answers hover through an index of its own instances, so
 * whatever this drops must be dropped by that index too: a shaft with no length
 * is not drawn (it is an instanced mesh scaled to nothing) and must not be a
 * hover target, or every later instance's index shifts and a hit resolves to a
 * neighbouring support. A leaf has no shaft at all - its contact point is a
 * zero-length segment - which is 67 of an 18-model plate's shafts per model.
 */
export function splitBatchedShafts(shafts: readonly InstancedShaft[]): {
    straightShafts: InstancedShaft[];
    curvedShafts: InstancedShaft[];
} {
    const straightShafts: InstancedShaft[] = [];
    const curvedShafts: InstancedShaft[] = [];
    for (const shaft of shafts) {
        if (isCurvedBatchedShaft(shaft)) {
            // Degenerate only when the whole control net collapses to a point.
            const points = [shaft.controlPoint1!, shaft.controlPoint2!, shaft.end];
            const collapsed = points.every((p) => {
                const dx = p.x - shaft.start.x;
                const dy = p.y - shaft.start.y;
                const dz = p.z - shaft.start.z;
                return dx * dx + dy * dy + dz * dz < 1e-6;
            });
            if (!collapsed) curvedShafts.push(shaft);
            continue;
        }
        const dx = shaft.end.x - shaft.start.x;
        const dy = shaft.end.y - shaft.start.y;
        const dz = shaft.end.z - shaft.start.z;
        if (dx * dx + dy * dy + dz * dz >= 1e-6) straightShafts.push(shaft);
    }
    return { straightShafts, curvedShafts };
}

/** Map a raycast faceIndex back to the owning curve's index; -1 if out of range. */
export function resolveCurvedShaftIndexForFace(triangleRangeEnds: number[], faceIndex: number): number {
    let lo = 0;
    let hi = triangleRangeEnds.length - 1;
    if (hi < 0 || faceIndex < 0 || faceIndex >= triangleRangeEnds[hi]) return -1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (triangleRangeEnds[mid] > faceIndex) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

/**
 * Merge curved batched shafts into one smooth tube geometry (one draw call per
 * batch group). Each curve is swept with the same resolution rules as the
 * detailed BezierRenderer and closed with flat end caps so the proxy-layer
 * scene graph stays serializable as a closed mesh by the STL/3MF export path.
 *
 *
 * A caller that tints some of its shafts builds one of these per colour and gives
 * each its own material, rather than writing a colour attribute here: a merged
 * mesh has one material, and the colour then takes the same route as an
 * instanced shaft's.
 */
export function buildBatchedBezierTubes(
    curvedShafts: InstancedShaft[],
    radialSegments: number,
): BatchedBezierTubes | null {
    if (curvedShafts.length === 0) return null;

    // Resolve every swept tube first and total the merge, so each buffer is
    // allocated once and written in place. Pushing three floats and one index at a
    // time into plain arrays was most of this function's cost on a supported
    // plate — ~950 ms for 20k curved shafts — and it ran on the render thread
    // whenever the batch was re-laid-out (a load, a move, a selection tint).
    const swept: Array<{
        curve: THREE.CubicBezierCurve3;
        tubularSegments: number;
        tube: THREE.TubeGeometry;
    }> = [];
    let vertexTotal = 0;
    let indexTotal = 0;
    for (const shaft of curvedShafts) {
        const entry = sweptTubeFor(shaft, radialSegments);
        swept.push(entry);
        vertexTotal += entry.tube.getAttribute('position').count + 2 * (1 + radialSegments);
        indexTotal += entry.tube.getIndex()!.count + 2 * radialSegments * 3;
    }

    const positions = new Float32Array(vertexTotal * 3);
    const normals = new Float32Array(vertexTotal * 3);
    const indices = new Uint32Array(indexTotal);
    const triangleRangeEnds = new Array<number>(swept.length);
    let vertexCursor = 0;
    let indexCursor = 0;

    const addCap = (ringStartVertex: number, center: THREE.Vector3, outward: THREE.Vector3) => {
        const capBase = vertexCursor;
        positions[vertexCursor * 3] = center.x;
        positions[vertexCursor * 3 + 1] = center.y;
        positions[vertexCursor * 3 + 2] = center.z;
        normals[vertexCursor * 3] = outward.x;
        normals[vertexCursor * 3 + 1] = outward.y;
        normals[vertexCursor * 3 + 2] = outward.z;
        vertexCursor += 1;

        // Duplicate the rim ring with the cap normal (skip the tube's seam
        // duplicate at j === radialSegments) so the cap edge shades crisply.
        for (let j = 0; j < radialSegments; j += 1) {
            const src = (ringStartVertex + j) * 3;
            positions[vertexCursor * 3] = positions[src];
            positions[vertexCursor * 3 + 1] = positions[src + 1];
            positions[vertexCursor * 3 + 2] = positions[src + 2];
            normals[vertexCursor * 3] = outward.x;
            normals[vertexCursor * 3 + 1] = outward.y;
            normals[vertexCursor * 3 + 2] = outward.z;
            vertexCursor += 1;
        }

        // Orient the fan so its winding faces `outward` regardless of the
        // direction TubeGeometry wound the ring.
        const ax = positions[(capBase + 1) * 3] - center.x;
        const ay = positions[(capBase + 1) * 3 + 1] - center.y;
        const az = positions[(capBase + 1) * 3 + 2] - center.z;
        const bx = positions[(capBase + 2) * 3] - center.x;
        const by = positions[(capBase + 2) * 3 + 1] - center.y;
        const bz = positions[(capBase + 2) * 3 + 2] - center.z;
        const crossX = ay * bz - az * by;
        const crossY = az * bx - ax * bz;
        const crossZ = ax * by - ay * bx;
        const flip = crossX * outward.x + crossY * outward.y + crossZ * outward.z < 0;

        for (let j = 0; j < radialSegments; j += 1) {
            const r0 = capBase + 1 + j;
            const r1 = capBase + 1 + ((j + 1) % radialSegments);
            indices[indexCursor] = capBase;
            if (flip) {
                indices[indexCursor + 1] = r1;
                indices[indexCursor + 2] = r0;
            } else {
                indices[indexCursor + 1] = r0;
                indices[indexCursor + 2] = r1;
            }
            indexCursor += 3;
        }
    };

    for (let s = 0; s < swept.length; s += 1) {
        const { curve, tubularSegments, tube } = swept[s];

        const vertexBase = vertexCursor;
        const pos = tube.getAttribute('position') as THREE.BufferAttribute;
        const nor = tube.getAttribute('normal') as THREE.BufferAttribute;
        positions.set(pos.array as Float32Array, vertexCursor * 3);
        normals.set(nor.array as Float32Array, vertexCursor * 3);
        vertexCursor += pos.count;

        const idx = tube.getIndex()!;
        const src = idx.array as Uint16Array | Uint32Array;
        for (let i = 0; i < idx.count; i += 1) {
            indices[indexCursor + i] = vertexBase + src[i];
        }
        indexCursor += idx.count;

        const startOutward = curve.getTangent(0).normalize().negate();
        const endOutward = curve.getTangent(1).normalize();
        const fallback = new THREE.Vector3()
            .subVectors(curve.v3, curve.v0)
            .normalize();
        if (!Number.isFinite(startOutward.x + startOutward.y + startOutward.z) || startOutward.lengthSq() < 0.5) {
            startOutward.copy(fallback).negate();
        }
        if (!Number.isFinite(endOutward.x + endOutward.y + endOutward.z) || endOutward.lengthSq() < 0.5) {
            endOutward.copy(fallback);
        }
        addCap(vertexBase, curve.getPoint(0), startOutward);
        addCap(vertexBase + tubularSegments * (radialSegments + 1), curve.getPoint(1), endOutward);

        triangleRangeEnds[s] = indexCursor / 3;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return { geometry, triangleRangeEnds };
}
