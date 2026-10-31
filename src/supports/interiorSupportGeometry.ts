import * as THREE from 'three';

import { anyContactMatches, contactEndpointsFor, SUPPORT_TYPES } from './supportTypeRegistry';
import type { Segment, SupportState, Vec3 } from './types';

/** The slice of a three-mesh-bvh bounds tree this module queries. */
type BvhBoundsTree = {
    closestPointToPoint: (point: THREE.Vector3, target: {
        point: THREE.Vector3;
        distance: number;
        faceIndex: number;
    }) => unknown;
};

/** How close to the cavity wall a point may be and still count as interior. */
export const INTERIOR_WALL_THRESHOLD_MM = 1.5;

/** An interior-support id: the entity's `typeId`, a colon, then its own id. */
export function interiorSupportKey(entity: { id: string; typeId?: string }): string {
    return `${entity.typeId}:${entity.id}`;
}

/** The cavity query surface: the side the renderer shows, plus the void test
 *  the auto-support run uses to refuse a plate route out of a cavity. */
export interface CavityTester {
    /** On the cavity side of the wall, or within the shell thickness of it. */
    isOnInteriorSide(pos: Vec3, modelId?: string): boolean;
    /** Strictly in the cavity void (the face normal decides; no wall slack). */
    isInsideVoid(pos: Vec3, modelId?: string): boolean;
    /** Distance from the point to the nearest cavity triangle (mm), or Infinity. */
    distanceToSurface(pos: Vec3, modelId?: string): number;
}

/**
 * Build the world-space cavity queries the interior view and the auto-support
 * run share.
 *
 * Contact positions are in WORLD space; the cavity geometry is in the model's
 * LOCAL space, so the model's world-inverse matrix is applied first. The BVH
 * and the face normals are built once and reused for every query.
 */
export function createCavityTester(
    cavityGeometryByModelId?: Map<string, THREE.BufferGeometry>,
    modelWorldInverseById?: Map<string, THREE.Matrix4>,
): CavityTester {
    if (!cavityGeometryByModelId || cavityGeometryByModelId.size === 0) {
        return {
            isOnInteriorSide: () => false,
            isInsideVoid: () => false,
            distanceToSurface: () => Infinity,
        };
    }

    const tempVec = new THREE.Vector3();
    const queryTarget = { point: new THREE.Vector3(), distance: 0, faceIndex: -1 } as {
        point: THREE.Vector3;
        distance: number;
        faceIndex: number;
    };

    // Build BVH on cavity geometries for O(log n) closest-point queries.
    const cavityBvhByGeometry = new Map<
        THREE.BufferGeometry,
        THREE.BufferGeometry & { boundsTree?: BvhBoundsTree }
    >();
    for (const [, geometry] of cavityGeometryByModelId) {
        const g = geometry as THREE.BufferGeometry & {
            boundsTree?: BvhBoundsTree;
            computeBoundsTree?: () => void;
        };
        if (!g.boundsTree && typeof g.computeBoundsTree === 'function') {
            g.computeBoundsTree();
        }
        cavityBvhByGeometry.set(geometry, g);
    }

    // Face normals per cavity geometry, to tell the cavity side from the wall.
    const faceNormalsByGeometry = new Map<THREE.BufferGeometry, Float32Array>();
    for (const [, geometry] of cavityGeometryByModelId) {
        const posAttr = geometry.getAttribute('position');
        const indexAttr = geometry.getIndex();
        if (!posAttr) continue;
        const positions = posAttr.array as Float32Array;
        const indices = indexAttr ? (indexAttr.array as Uint16Array | Uint32Array) : null;

        const triCount = indices ? indices.length / 3 : posAttr.count / 3;
        const normals = new Float32Array(triCount * 3);

        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        const edge1 = new THREE.Vector3();
        const edge2 = new THREE.Vector3();
        const faceNormal = new THREE.Vector3();

        for (let i = 0; i < triCount; i++) {
            const i0 = indices ? indices[i * 3] : i * 3;
            const i1 = indices ? indices[i * 3 + 1] : i * 3 + 1;
            const i2 = indices ? indices[i * 3 + 2] : i * 3 + 2;
            a.set(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
            b.set(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
            c.set(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
            edge1.subVectors(b, a);
            edge2.subVectors(c, a);
            faceNormal.crossVectors(edge1, edge2).normalize();
            normals[i * 3] = faceNormal.x;
            normals[i * 3 + 1] = faceNormal.y;
            normals[i * 3 + 2] = faceNormal.z;
        }
        faceNormalsByGeometry.set(geometry, normals);
    }

    const query = (pos: Vec3, modelId?: string): { dot: number; distance: number } | null => {
        const geometry = modelId ? cavityGeometryByModelId.get(modelId) : null;
        const target = geometry ?? Array.from(cavityGeometryByModelId.values())[0] ?? null;
        if (!target) return null;
        const g = cavityBvhByGeometry.get(target);
        if (!g?.boundsTree) return null;

        // Distances come back in the model's LOCAL units; callers compare them
        // in world millimetres. The inverse's basis length recovers the scale.
        let worldScale = 1;
        tempVec.set(pos.x, pos.y, pos.z);
        if (modelId && modelWorldInverseById) {
            const inv = modelWorldInverseById.get(modelId);
            if (inv) {
                tempVec.applyMatrix4(inv);
                const inverseScale = inv.getMaxScaleOnAxis();
                if (inverseScale > 0) worldScale = 1 / inverseScale;
            }
        }
        queryTarget.distance = Infinity;
        queryTarget.faceIndex = -1;
        const result = g.boundsTree.closestPointToPoint(tempVec, queryTarget);
        if (!result || queryTarget.faceIndex < 0) return null;

        const normals = faceNormalsByGeometry.get(target);
        if (!normals || queryTarget.faceIndex * 3 + 2 >= normals.length) return null;

        const dx = tempVec.x - queryTarget.point.x;
        const dy = tempVec.y - queryTarget.point.y;
        const dz = tempVec.z - queryTarget.point.z;
        const nx = normals[queryTarget.faceIndex * 3];
        const ny = normals[queryTarget.faceIndex * 3 + 1];
        const nz = normals[queryTarget.faceIndex * 3 + 2];
        return { dot: dx * nx + dy * ny + dz * nz, distance: result.distance * worldScale };
    };

    return {
        isOnInteriorSide: (pos, modelId) => {
            const hit = query(pos, modelId);
            if (!hit) return false;
            // Cavity normals point into the cavity. dot > 0 is the void;
            // otherwise the point is on the cavity-facing wall when close.
            return hit.dot > 0 || hit.distance < INTERIOR_WALL_THRESHOLD_MM;
        },
        isInsideVoid: (pos, modelId) => (query(pos, modelId)?.dot ?? 0) > 0,
        distanceToSurface: (pos, modelId) => query(pos, modelId)?.distance ?? Infinity,
    };
}

/** A contact is interior when its placement surface says so, or when an
 *  unstamped one sits on the cavity side. */
export function isInteriorContact(
    contact: unknown,
    modelId: string | undefined,
    isOnInteriorSide: (pos: Vec3, modelId?: string) => boolean,
): boolean {
    const c = contact as { pos?: Vec3; placementSurface?: 'interior' | 'exterior' } | null | undefined;
    if (!c?.pos) return false;
    if (c.placementSurface === 'interior') return true;
    if (c.placementSurface === 'exterior') return false;
    return isOnInteriorSide(c.pos, modelId);
}

/** A shaft can cross the cavity only over a short fraction of its length, so
 *  sample it at 10% increments rather than testing just the joints. */
export function isAnySegmentPointInterior(
    segments: readonly Segment[],
    isOnInteriorSide: (pos: Vec3, modelId?: string) => boolean,
    modelId?: string,
): boolean {
    for (const seg of segments) {
        if (seg.bottomJoint?.pos && isOnInteriorSide(seg.bottomJoint.pos, modelId)) return true;
        if (seg.topJoint?.pos && isOnInteriorSide(seg.topJoint.pos, modelId)) return true;

        const a = seg.bottomJoint?.pos;
        const b = seg.topJoint?.pos;
        if (a && b) {
            for (let i = 1; i <= 9; i++) {
                const t = i / 10;
                const mid: Vec3 = {
                    x: a.x + (b.x - a.x) * t,
                    y: a.y + (b.y - a.y) * t,
                    z: a.z + (b.z - a.z) * t,
                };
                if (isOnInteriorSide(mid, modelId)) return true;
            }
        }
    }
    return false;
}

/**
 * Which supports the interior (cavity) view draws. A `plateRoot` type is
 * skipped; any interior contact qualifies; a shaft is tested along its length
 * only when it starts at a knot. Predicates are injected to keep this pure.
 */
export function interiorSupportIds(
    state: SupportState,
    isContactInterior: (contact: unknown, modelId?: string) => boolean,
    areSegmentsInterior: (segments: readonly Segment[], modelId?: string) => boolean,
): Set<string> {
    const ids = new Set<string>();

    for (const descriptor of SUPPORT_TYPES) {
        // Rooted in the plate: never inside a cavity.
        if (descriptor.lower.kind === 'plateRoot') continue;
        if (contactEndpointsFor(descriptor.id).length === 0) continue;

        const collection = state[descriptor.location.key] as unknown as
            | Record<string, { id: string; typeId?: string; modelId?: string; segments?: Segment[] }>
            | undefined;

        for (const entity of Object.values(collection ?? {})) {
            const key = interiorSupportKey(entity);
            if (anyContactMatches(descriptor.id, entity, (contact) => isContactInterior(contact, entity.modelId))) {
                ids.add(key);
                continue;
            }
            if (descriptor.lower.kind === 'knot'
                && descriptor.hasSegments
                && areSegmentsInterior(entity.segments ?? [], entity.modelId)) {
                ids.add(key);
            }
        }
    }

    return ids;
}
