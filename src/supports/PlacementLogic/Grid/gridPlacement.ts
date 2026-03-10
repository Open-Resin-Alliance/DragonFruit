import type { Knot, Roots, Segment, SupportState, Trunk, Vec3 } from '../../types';
import type { TrunkBuildResult } from '../../SupportTypes/Trunk/trunkBuilder';
import { buildBranchData } from '../../SupportTypes/Branch/branchBuilder';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from './gridMath';
import type { DecideGridPlacementArgs, GridPlacementDecision } from './types';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { calculateKnotPositionOnSegmentFromT } from '../../SupportPrimitives/Knot/knotUtils';
import { checkShaftCollision } from '../CollisionUtils';
import * as THREE from 'three';
import { generateUuid } from '../../../utils/uuid';

const MIN_TRUNK_CLEARANCE_MM = 0.5;
const MAX_NEAREST_NODE_SEARCH_RINGS = 4;
const MIN_INSERTED_BASE_SEGMENT_MM = 1.0;
const MIN_INSERTED_TRANSITION_SEGMENT_MM = 0.5;

function moveRootToXY(
    candidate: TrunkBuildResult,
    rootX: number,
    rootY: number
): TrunkBuildResult {
    const nextRoot = {
        ...candidate.root,
        transform: {
            ...candidate.root.transform,
            pos: {
                ...candidate.root.transform.pos,
                x: rootX,
                y: rootY,
            },
        },
    };

    return {
        ...candidate,
        root: nextRoot,
        trunk: {
            ...candidate.trunk,
            segments: candidate.trunk.segments,
        },
        supportData: {
            ...candidate.supportData,
            roots: nextRoot,
            segments: candidate.trunk.segments,
        },
    };
}

function buildNearestCandidateNodeKeys(preferredKey: string, maxRings: number): string[] {
    const [gxRaw, gyRaw] = preferredKey.split(',');
    const centerX = Number(gxRaw);
    const centerY = Number(gyRaw);
    const keys: string[] = [];

    for (let ring = 0; ring <= maxRings; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
            for (let dy = -ring; dy <= ring; dy++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                keys.push(`${centerX + dx},${centerY + dy}`);
            }
        }
    }

    return keys;
}

function applyGridSnapToNodeKey(
    candidate: TrunkBuildResult,
    settings: DecideGridPlacementArgs['settings'],
    spacingMm: number,
    nodeKey: string
): TrunkBuildResult | null {
    const snapped = gridSnappedXYFromKey(nodeKey, spacingMm);
    const root = candidate.root;
    const movedCandidate = moveRootToXY(candidate, snapped.x, snapped.y);
    const lowestJoint = candidate.trunk.segments[0]?.topJoint;

    if (snapped.x === root.transform.pos.x && snapped.y === root.transform.pos.y) {
        return movedCandidate;
    }

    if (!lowestJoint) {
        return movedCandidate;
    }

    const rootTop = getRootTopPosition(movedCandidate.root, settings);
    const lateralShift = Math.hypot(lowestJoint.pos.x - snapped.x, lowestJoint.pos.y - snapped.y);
    if (lateralShift <= 0.000001) {
        return movedCandidate;
    }

    const minAngleRad = (settings.grid.minRoutedTrunkAngleDeg * Math.PI) / 180;
    const requiredDrop = lateralShift * Math.tan(minAngleRad);
    const maxInsertedJointZ = lowestJoint.pos.z - MIN_INSERTED_TRANSITION_SEGMENT_MM;
    const minInsertedJointZ = rootTop.z + MIN_INSERTED_BASE_SEGMENT_MM;

    if (maxInsertedJointZ <= minInsertedJointZ) {
        return null;
    }

    const insertedJointZ = Math.max(
        minInsertedJointZ,
        Math.min(lowestJoint.pos.z - requiredDrop, maxInsertedJointZ),
    );

    if (lowestJoint.pos.z - insertedJointZ + 0.000001 < requiredDrop) {
        return null;
    }

    const insertedJoint = {
        id: generateUuid(),
        pos: {
            x: snapped.x,
            y: snapped.y,
            z: insertedJointZ,
        },
        diameter: lowestJoint.diameter,
    };

    const insertedSegment: Segment = {
        id: generateUuid(),
        diameter: movedCandidate.trunk.segments[0]?.diameter ?? settings.shaft.diameterMm,
        topJoint: insertedJoint,
    };

    const nextSegments = [insertedSegment, ...movedCandidate.trunk.segments];
    return {
        ...movedCandidate,
        trunk: {
            ...movedCandidate.trunk,
            segments: nextSegments,
        },
        supportData: {
            ...movedCandidate.supportData,
            roots: movedCandidate.root,
            segments: nextSegments,
        },
    };
}

function getPreferredNodeKey(
    candidate: TrunkBuildResult,
    spacingMm: number,
    referenceXY?: { x: number; y: number }
): string {
    const root = candidate.root;
    const refX = referenceXY?.x ?? root.transform.pos.x;
    const refY = referenceXY?.y ?? root.transform.pos.y;
    return gridNodeKeyFromXY(refX, refY, spacingMm);
}

function withSnappedRootOnly(
    candidate: TrunkBuildResult,
    spacingMm: number,
    referenceXY?: { x: number; y: number }
): TrunkBuildResult {
    const key = getPreferredNodeKey(candidate, spacingMm, referenceXY);
    const snapped = gridSnappedXYFromKey(key, spacingMm);
    if (snapped.x === candidate.root.transform.pos.x && snapped.y === candidate.root.transform.pos.y) {
        return candidate;
    }

    const nextRoot = {
        ...candidate.root,
        transform: {
            ...candidate.root.transform,
            pos: {
                ...candidate.root.transform.pos,
                x: snapped.x,
                y: snapped.y,
            },
        },
    };

    return {
        ...candidate,
        root: nextRoot,
        trunk: {
            ...candidate.trunk,
            segments: candidate.trunk.segments,
        },
        supportData: {
            ...candidate.supportData,
            roots: nextRoot,
            segments: candidate.trunk.segments,
        },
    };
}

function getTrunkSegmentEndpointsWithSettings(
    trunk: Trunk,
    root: Roots,
    segmentIndex: number,
    settings: DecideGridPlacementArgs['settings']
): { start: Vec3; end: Vec3 } | null {
    const diskHeight = settings.roots.diskHeightMm;
    const flareEnabled = settings.baseFlare?.enabled;
    const coneHeight = flareEnabled ? settings.baseFlare.heightMm : settings.roots.coneHeightMm;
    const effectiveConeHeight = flareEnabled ? coneHeight : 0;

    const basePos = root.transform.pos;

    const segment = trunk.segments[segmentIndex];
    if (!segment) return null;

    let start: Vec3;
    if (segmentIndex === 0) {
        start = {
            x: basePos.x,
            y: basePos.y,
            z: basePos.z + diskHeight + effectiveConeHeight,
        };
    } else {
        const prev = trunk.segments[segmentIndex - 1];
        if (prev?.topJoint) {
            start = prev.topJoint.pos;
        } else {
            start = {
                x: basePos.x,
                y: basePos.y,
                z: basePos.z + diskHeight + effectiveConeHeight,
            };
        }
    }

    let end: Vec3;
    if (segment.topJoint) {
        end = segment.topJoint.pos;
    } else if (trunk.contactCone) {
        end = getFinalSocketPosition(trunk.contactCone);
    } else {
        end = { x: start.x, y: start.y, z: start.z + 10 };
    }

    return { start, end };
}

function satisfiesMinAngleFromHorizontal(tipPos: Vec3, knotPos: Vec3, minAngleDeg: number): boolean {
    const dx = tipPos.x - knotPos.x;
    const dy = tipPos.y - knotPos.y;
    const horizontal = Math.sqrt(dx * dx + dy * dy);
    const vertical = tipPos.z - knotPos.z;
    if (vertical <= 0) return false;

    const minAngleRad = (minAngleDeg * Math.PI) / 180;
    const requiredVertical = horizontal * Math.tan(minAngleRad);
    return vertical >= requiredVertical;
}

function branchCollidesWithMesh(
    knot: Knot,
    tipPos: Vec3,
    tipNormal: Vec3,
    modelId: string,
    mesh: THREE.Mesh,
    shaftDiameterMm: number
): boolean {
    const { branch } = buildBranchData({ tipPos, tipNormal, modelId, parentKnot: knot });
    const radius = shaftDiameterMm / 2 + 0.25;

    const raycaster = new THREE.Raycaster();

    // Bottom segment: Knot -> Middle joint
    const bottom = branch.segments[0];
    const midPos = bottom.topJoint?.pos;
    if (midPos) {
        const hit = checkShaftCollision(knot.pos, midPos, radius, mesh, raycaster);
        if (hit.hit) return true;
    }

    // Top segment: Middle joint -> Socket joint
    const top = branch.segments[1];
    const socketPos = top.topJoint?.pos ?? (branch.contactCone ? getFinalSocketPosition(branch.contactCone) : null);
    if (midPos && socketPos) {
        const hit = checkShaftCollision(midPos, socketPos, radius, mesh, raycaster);
        if (hit.hit) return true;
    }

    return false;
}

function selectHighestValidAttachment(args: {
    hostTrunk: Trunk;
    hostRoot: Roots;
    tipPos: Vec3;
    minAngleDeg: number;
    settings: DecideGridPlacementArgs['settings'];
    attachStepMm: number;
    mesh?: THREE.Mesh;
    tipNormal: Vec3;
    modelId: string;
}): Knot | null {
    const { hostTrunk, hostRoot, tipPos, minAngleDeg, settings, attachStepMm, mesh, tipNormal, modelId } = args;
    const shaftDiameterMm = settings.shaft.diameterMm;

    // Iterate segments from top (last) to bottom (first)
    for (let segIndex = hostTrunk.segments.length - 1; segIndex >= 0; segIndex--) {
        const segment = hostTrunk.segments[segIndex];
        const endpoints = getTrunkSegmentEndpointsWithSettings(hostTrunk, hostRoot, segIndex, settings);
        if (!segment || !endpoints) continue;

        const approxLen = Math.max(
            0.001,
            Math.sqrt(
                Math.pow(endpoints.end.x - endpoints.start.x, 2) +
                Math.pow(endpoints.end.y - endpoints.start.y, 2) +
                Math.pow(endpoints.end.z - endpoints.start.z, 2)
            )
        );

        const step = Math.max(0.0005, attachStepMm / approxLen);

        for (let t = 1; t >= 0; t -= step) {
            const pos = calculateKnotPositionOnSegmentFromT(endpoints.start, endpoints.end, segment, t);

            // Must be below tip
            if (pos.z >= tipPos.z) continue;

            // Must satisfy min angle from horizontal
            if (!satisfiesMinAngleFromHorizontal(tipPos, pos, minAngleDeg)) continue;

            const knot: Knot = {
                id: generateUuid(),
                parentShaftId: segment.id,
                t,
                pos,
                diameter: (segment.diameter ?? shaftDiameterMm) + 0.1,
            };

            if (mesh) {
                const collides = branchCollidesWithMesh(knot, tipPos, tipNormal, modelId, mesh, shaftDiameterMm);
                if (collides) continue;
            }

            return knot;
        }
    }

    return null;
}

function findHostTrunkAtNode(snapshot: SupportState, modelId: string, nodeKey: string, spacingMm: number): { trunkId: string; trunk: Trunk; root: Roots } | null {
    for (const trunk of Object.values(snapshot.trunks)) {
        if (trunk.modelId !== modelId) continue;
        const root = snapshot.roots[trunk.rootId];
        if (!root) continue;
        const trunkKey = gridNodeKeyFromXY(root.transform.pos.x, root.transform.pos.y, spacingMm);
        if (trunkKey !== nodeKey) continue;
        return { trunkId: trunk.id, trunk, root };
    }
    return null;
}

function getRootTopPosition(root: Roots, settings: DecideGridPlacementArgs['settings']): Vec3 {
    const diskHeight = settings.roots.diskHeightMm;
    const flareEnabled = settings.baseFlare?.enabled;
    const coneHeight = flareEnabled ? settings.baseFlare.heightMm : settings.roots.coneHeightMm;
    const effectiveConeHeight = flareEnabled ? coneHeight : 0;

    return {
        x: root.transform.pos.x,
        y: root.transform.pos.y,
        z: root.transform.pos.z + diskHeight + effectiveConeHeight,
    };
}

function trunkCollidesWithMesh(
    candidate: TrunkBuildResult,
    settings: DecideGridPlacementArgs['settings'],
    mesh: THREE.Mesh
): boolean {
    const trunk = candidate.trunk;
    const root = candidate.root;
    const collisionRadius = settings.shaft.diameterMm / 2 + MIN_TRUNK_CLEARANCE_MM;
    const raycaster = new THREE.Raycaster();

    for (let segIndex = 0; segIndex < trunk.segments.length; segIndex++) {
        const endpoints = getTrunkSegmentEndpointsWithSettings(trunk, root, segIndex, settings);
        if (!endpoints) continue;

        const hit = checkShaftCollision(endpoints.start, endpoints.end, collisionRadius, mesh, raycaster);
        if (hit.hit) return true;
    }

    return false;
}

export function decideGridPlacement(args: DecideGridPlacementArgs): GridPlacementDecision {
    const { settings, snapshot, candidate, tipPos, tipNormal, modelId, mesh } = args;

    if (!settings.grid?.enabled) {
        return {
            kind: 'place_trunk',
            trunkBuild: candidate,
            nodeKey: 'disabled',
        };
    }

    const spacingMm = settings.grid.spacingMm;

    const socketPos = candidate.trunk.contactCone ? getFinalSocketPosition(candidate.trunk.contactCone) : null;
    const preferredNodeKey = getPreferredNodeKey(
        candidate,
        spacingMm,
        socketPos ? { x: socketPos.x, y: socketPos.y } : undefined
    );
    const candidateNodeKeys = buildNearestCandidateNodeKeys(preferredNodeKey, MAX_NEAREST_NODE_SEARCH_RINGS);

    for (const nodeKey of candidateNodeKeys) {
        const nodeCandidate = applyGridSnapToNodeKey(candidate, settings, spacingMm, nodeKey);
        if (!nodeCandidate) continue;
        const host = findHostTrunkAtNode(snapshot, modelId, nodeKey, spacingMm);
        if (host) continue;
        if (mesh && trunkCollidesWithMesh(nodeCandidate, settings, mesh)) continue;

        return {
            kind: 'place_trunk',
            trunkBuild: nodeCandidate,
            nodeKey,
        };
    }

    const nodeKey = preferredNodeKey;
    const host = findHostTrunkAtNode(snapshot, modelId, nodeKey, spacingMm);
    const snappedCandidate = applyGridSnapToNodeKey(
        candidate,
        settings,
        spacingMm,
        nodeKey,
    ) ?? withSnappedRootOnly(
        candidate,
        spacingMm,
        socketPos ? { x: socketPos.x, y: socketPos.y } : undefined
    );
    if (!host) {
        return mesh && trunkCollidesWithMesh(snappedCandidate, settings, mesh)
            ? { kind: 'reject', nodeKey, reason: 'COLLISION_WITH_MODEL' }
            : {
                kind: 'place_trunk',
                trunkBuild: snappedCandidate,
                nodeKey,
            };
    }

    const hostSegment: Segment | undefined = host.trunk.segments[0];
    if (!hostSegment) {
        return { kind: 'reject', nodeKey, reason: 'NO_HOST_SEGMENT' };
    }

    const minAngleDeg = settings.grid.minBranchAngleDeg;
    const attachStepMm = settings.grid.attachSearchStepMm;

    const selectedKnot = selectHighestValidAttachment({
        hostTrunk: host.trunk,
        hostRoot: host.root,
        tipPos,
        minAngleDeg,
        settings,
        attachStepMm,
        mesh,
        tipNormal,
        modelId,
    });

    if (!selectedKnot) {
        return { kind: 'reject', nodeKey, reason: mesh ? 'COLLISION_WITH_MODEL' : 'NO_VALID_ATTACHMENT' };
    }

    const { branch, supportData } = buildBranchData({
        tipPos,
        tipNormal,
        modelId,
        parentKnot: selectedKnot,
    });

    const hostTrunkContactZ = host.trunk.contactCone?.pos.z ?? Number.NEGATIVE_INFINITY;
    const candidateContactZ = tipPos.z;
    if (candidateContactZ > hostTrunkContactZ + 0.000001) {
        return {
            kind: 'replace_trunk',
            nodeKey,
            hostTrunkId: host.trunkId,
            trunkBuild: snappedCandidate,
            promoteKnot: selectedKnot,
            promoteBranch: branch,
            oldTrunkKnot: null,
            oldTrunkBranch: null,
        };
    }

    return {
        kind: 'place_branch',
        nodeKey,
        hostTrunkId: host.trunkId,
        knot: selectedKnot,
        branch,
        supportData,
    };
}


