import type { Knot, Roots, Segment, SupportState, Trunk, Vec3 } from '../../types';
import type { TrunkBuildResult } from '../../SupportTypes/Trunk/trunkBuilder';
import { buildBranchData } from '../../SupportTypes/Branch/branchBuilder';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from './gridMath';
import type { DecideGridPlacementArgs, GridPlacementDecision } from './types';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { calculateKnotPositionOnSegmentFromT } from '../../SupportPrimitives/Knot/knotUtils';
import { checkShaftCollision } from '../CollisionUtils';
import * as THREE from 'three';

function applyGridSnapToCandidate(
    candidate: TrunkBuildResult,
    spacingMm: number,
    referenceXY?: { x: number; y: number }
): TrunkBuildResult {
    const root = candidate.root;
    const refX = referenceXY?.x ?? root.transform.pos.x;
    const refY = referenceXY?.y ?? root.transform.pos.y;
    const key = gridNodeKeyFromXY(refX, refY, spacingMm);
    const snapped = gridSnappedXYFromKey(key, spacingMm);

    if (snapped.x === root.transform.pos.x && snapped.y === root.transform.pos.y) {
        return candidate;
    }

    const dx = snapped.x - root.transform.pos.x;
    const dy = snapped.y - root.transform.pos.y;

    const socketJointId = candidate.trunk.contactCone?.socketJointId;

    const nextSegments = candidate.trunk.segments.map((seg) => {
        const nextTopJoint = seg.topJoint && (!socketJointId || seg.topJoint.id !== socketJointId)
            ? {
                ...seg.topJoint,
                pos: {
                    ...seg.topJoint.pos,
                    x: seg.topJoint.pos.x + dx,
                    y: seg.topJoint.pos.y + dy,
                },
            }
            : seg.topJoint;

        const nextBottomJoint = seg.bottomJoint && (!socketJointId || seg.bottomJoint.id !== socketJointId)
            ? {
                ...seg.bottomJoint,
                pos: {
                    ...seg.bottomJoint.pos,
                    x: seg.bottomJoint.pos.x + dx,
                    y: seg.bottomJoint.pos.y + dy,
                },
            }
            : seg.bottomJoint;

        if (nextTopJoint === seg.topJoint && nextBottomJoint === seg.bottomJoint) return seg;
        return {
            ...seg,
            topJoint: nextTopJoint,
            bottomJoint: nextBottomJoint,
        };
    });

    const nextRoot = {
        ...root,
        transform: {
            ...root.transform,
            pos: {
                ...root.transform.pos,
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
            segments: nextSegments,
        },
        supportData: {
            ...candidate.supportData,
            roots: nextRoot,
            segments: nextSegments,
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
                id: crypto.randomUUID(),
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
    const snappedCandidate = applyGridSnapToCandidate(
        candidate,
        spacingMm,
        socketPos ? { x: socketPos.x, y: socketPos.y } : undefined
    );
    const nodeKey = gridNodeKeyFromXY(snappedCandidate.root.transform.pos.x, snappedCandidate.root.transform.pos.y, spacingMm);

    const host = findHostTrunkAtNode(snapshot, modelId, nodeKey, spacingMm);
    if (!host) {
        return {
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
