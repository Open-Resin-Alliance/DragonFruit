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

export function isCurvedBatchedShaft(shaft: InstancedShaft): boolean {
    return shaft.controlPoint1 != null && shaft.controlPoint2 != null;
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
 */
export function buildBatchedBezierTubes(
    curvedShafts: InstancedShaft[],
    radialSegments: number,
): BatchedBezierTubes | null {
    if (curvedShafts.length === 0) return null;

    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const triangleRangeEnds: number[] = [];

    const addCap = (ringStartVertex: number, center: THREE.Vector3, outward: THREE.Vector3) => {
        const capBase = positions.length / 3;
        positions.push(center.x, center.y, center.z);
        normals.push(outward.x, outward.y, outward.z);

        // Duplicate the rim ring with the cap normal (skip the tube's seam
        // duplicate at j === radialSegments) so the cap edge shades crisply.
        for (let j = 0; j < radialSegments; j += 1) {
            const src = (ringStartVertex + j) * 3;
            positions.push(positions[src], positions[src + 1], positions[src + 2]);
            normals.push(outward.x, outward.y, outward.z);
        }

        // Orient the fan so its winding faces `outward` regardless of the
        // direction TubeGeometry wound the ring.
        const a = new THREE.Vector3(
            positions[(capBase + 1) * 3] - center.x,
            positions[(capBase + 1) * 3 + 1] - center.y,
            positions[(capBase + 1) * 3 + 2] - center.z,
        );
        const b = new THREE.Vector3(
            positions[(capBase + 2) * 3] - center.x,
            positions[(capBase + 2) * 3 + 1] - center.y,
            positions[(capBase + 2) * 3 + 2] - center.z,
        );
        const flip = new THREE.Vector3().crossVectors(a, b).dot(outward) < 0;

        for (let j = 0; j < radialSegments; j += 1) {
            const r0 = capBase + 1 + j;
            const r1 = capBase + 1 + ((j + 1) % radialSegments);
            if (flip) {
                indices.push(capBase, r1, r0);
            } else {
                indices.push(capBase, r0, r1);
            }
        }
    };

    for (const shaft of curvedShafts) {
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

        const tube = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
        const vertexBase = positions.length / 3;
        const pos = tube.getAttribute('position') as THREE.BufferAttribute;
        const nor = tube.getAttribute('normal') as THREE.BufferAttribute;
        for (let i = 0; i < pos.count; i += 1) {
            positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
            normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
        }
        const idx = tube.getIndex()!;
        for (let i = 0; i < idx.count; i += 1) {
            indices.push(vertexBase + idx.getX(i));
        }
        tube.dispose();

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

        triangleRangeEnds.push(indices.length / 3);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    return { geometry, triangleRangeEnds };
}
