import type { Knot, Roots, SupportState, Trunk, Vec3 } from '../../types';
import type { TrunkBuildResult } from '../../SupportTypes/Trunk/trunkBuilder';
import type { SnappedTrunkRouteResult } from '../../SupportTypes/Trunk/trunkRouteTypes';
import { buildBranchData } from '../../SupportTypes/Branch/branchBuilder';
import {
    getDefaultSnappedValidity,
    getResolvedSnappedNodeKey,
    getResolvedSnappedRootPos,
    getResolvedSnappedValidity,
    hasResolvedSnappedRoot,
} from '../../SupportTypes/Trunk/trunkRouteResolution';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from './gridMath';
import { buildNearestCandidateNodeKeys } from './nearestCandidateNodeKeys';
import type { DecideGridPlacementArgs, GridPlacementDecision } from './types';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { calculateKnotPositionOnSegmentFromT } from '../../SupportPrimitives/Knot/knotUtils';
import { checkShaftCollision } from '../CollisionUtils';
import * as THREE from 'three';
import { generateUuid } from '../../../utils/uuid';
import { buildAnchorData } from '../../SupportTypes/Anchor/anchorBuilder';

const MIN_TRUNK_CLEARANCE_MM = 0.5;
const MAX_NEAREST_NODE_SEARCH_RINGS = 4;
const ANCHOR_HEIGHT_THRESHOLD_MM = 5.0;

function withResolvedSnappedRoute(
    candidate: TrunkBuildResult,
    args: {
        snappedRootPos: Vec3;
        snappedNodeKey: string | null;
        snappedValidity: SnappedTrunkRouteResult['snappedValidity'];
        validity?: SnappedTrunkRouteResult['validity'];
        error?: SnappedTrunkRouteResult['error'];
    }
): TrunkBuildResult {
    const nextError = args.error ?? candidate.route.error;
    const nextValidity = args.validity ?? candidate.route.validity;
    return {
        ...candidate,
        route: {
            ...candidate.route,
            snappedRootPos: args.snappedRootPos,
            snappedNodeKey: args.snappedNodeKey,
            snappedValidity: args.snappedValidity,
            validity: nextValidity,
            error: nextError,
        },
        error: nextError,
        warning: nextError ? undefined : candidate.warning,
        supportData: {
            ...candidate.supportData,
            error: nextError,
            warning: nextError ? undefined : candidate.supportData.warning,
        },
    };
}

function moveRootToXY(
    candidate: TrunkBuildResult,
    rootX: number,
    rootY: number
): TrunkBuildResult {
    const dx = rootX - candidate.root.transform.pos.x;
    const dy = rootY - candidate.root.transform.pos.y;

    if (dx === 0 && dy === 0) {
        return candidate;
    }

    const socketJointId = candidate.trunk.contactCone?.socketJointId;
    const nextSegments = candidate.trunk.segments.map((seg) => {
        const nextTopJoint =
            seg.topJoint && (!socketJointId || seg.topJoint.id !== socketJointId)
                ? {
                    ...seg.topJoint,
                    pos: {
                        ...seg.topJoint.pos,
                        x: seg.topJoint.pos.x + dx,
                        y: seg.topJoint.pos.y + dy,
                    },
                }
                : seg.topJoint;

        const nextBottomJoint =
            seg.bottomJoint && (!socketJointId || seg.bottomJoint.id !== socketJointId)
                ? {
                    ...seg.bottomJoint,
                    pos: {
                        ...seg.bottomJoint.pos,
                        x: seg.bottomJoint.pos.x + dx,
                        y: seg.bottomJoint.pos.y + dy,
                    },
                }
                : seg.bottomJoint;

        if (nextTopJoint === seg.topJoint && nextBottomJoint === seg.bottomJoint) {
            return seg;
        }

        return {
            ...seg,
            topJoint: nextTopJoint,
            bottomJoint: nextBottomJoint,
        };
    });

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
        route: {
            ...candidate.route,
            basePos: {
                ...candidate.route.basePos,
                x: rootX,
                y: rootY,
            },
            joints: candidate.route.joints.map((joint) => ({
                ...joint,
                x: joint.x + dx,
                y: joint.y + dy,
            })),
            constructionJoints: candidate.route.constructionJoints.map((joint) => ({
                ...joint,
                x: joint.x + dx,
                y: joint.y + dy,
            })),
        },
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

function applyGridSnapToNodeKey(
    candidate: TrunkBuildResult,
    spacingMm: number,
    nodeKey: string
): TrunkBuildResult {
    const snapped = gridSnappedXYFromKey(nodeKey, spacingMm);
    const movedCandidate = moveRootToXY(candidate, snapped.x, snapped.y);
    return movedCandidate;
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
    if (segment.bottomJoint) {
        start = segment.bottomJoint.pos;
    } else if (segmentIndex === 0) {
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

function findNearestReachableHostTrunkAttachment(args: {
    snapshot: SupportState;
    modelId: string;
    spacingMm: number;
    tipPos: Vec3;
    minAngleDeg: number;
    settings: DecideGridPlacementArgs['settings'];
    attachStepMm: number;
    mesh?: THREE.Mesh;
    tipNormal: Vec3;
    excludeTrunkIds?: Set<string>;
}): { trunkId: string; nodeKey: string; knot: Knot } | null {
    const { snapshot, modelId, spacingMm, tipPos, minAngleDeg, settings, attachStepMm, mesh, tipNormal, excludeTrunkIds } = args;

    let best: {
        trunkId: string;
        nodeKey: string;
        knot: Knot;
        distanceSq: number;
        lateralSq: number;
    } | null = null;

    for (const trunk of Object.values(snapshot.trunks)) {
        if (trunk.modelId !== modelId) continue;
        if (excludeTrunkIds?.has(trunk.id)) continue;

        const root = snapshot.roots[trunk.rootId];
        if (!root) continue;

        const knot = selectHighestValidAttachment({
            hostTrunk: trunk,
            hostRoot: root,
            tipPos,
            minAngleDeg,
            settings,
            attachStepMm,
            mesh,
            tipNormal,
            modelId,
        });
        if (!knot) continue;

        const dx = tipPos.x - knot.pos.x;
        const dy = tipPos.y - knot.pos.y;
        const dz = tipPos.z - knot.pos.z;
        const distanceSq = dx * dx + dy * dy + dz * dz;
        const lateralSq = dx * dx + dy * dy;

        if (
            !best ||
            distanceSq < best.distanceSq - 0.000001 ||
            (
                Math.abs(distanceSq - best.distanceSq) <= 0.000001 &&
                (
                    lateralSq < best.lateralSq - 0.000001 ||
                    (
                        Math.abs(lateralSq - best.lateralSq) <= 0.000001 &&
                        knot.pos.z > best.knot.pos.z + 0.000001
                    )
                )
            )
        ) {
            best = {
                trunkId: trunk.id,
                nodeKey: gridNodeKeyFromXY(root.transform.pos.x, root.transform.pos.y, spacingMm),
                knot,
                distanceSq,
                lateralSq,
            };
        }
    }

    return best
        ? {
            trunkId: best.trunkId,
            nodeKey: best.nodeKey,
            knot: best.knot,
        }
        : null;
}

// Reusable raycaster for trunk collision checks — avoids allocating one per call.
const _trunkCollisionRaycaster = new THREE.Raycaster();

function trunkCollidesWithMesh(
    candidate: TrunkBuildResult,
    settings: DecideGridPlacementArgs['settings'],
    mesh: THREE.Mesh
): boolean {
    const trunk = candidate.trunk;
    const root = candidate.root;
    const collisionRadius = settings.shaft.diameterMm / 2 + MIN_TRUNK_CLEARANCE_MM;
    const raycaster = _trunkCollisionRaycaster;

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

    // Near-plate contacts get a minimal anchor support instead of trunk/branch
    if (tipPos.z < ANCHOR_HEIGHT_THRESHOLD_MM) {
        const { anchor, supportData } = buildAnchorData({ tipPos, tipNormal, modelId });
        return { kind: 'place_anchor', anchor, supportData };
    }

    if (!settings.grid?.enabled) {
        return {
            kind: 'place_trunk',
            trunkBuild: withResolvedSnappedRoute(candidate, {
                snappedRootPos: getResolvedSnappedRootPos(candidate.route, candidate.root.transform.pos),
                snappedNodeKey: 'disabled',
                snappedValidity: getResolvedSnappedValidity(candidate.route) ?? getDefaultSnappedValidity(candidate.route),
            }),
            nodeKey: 'disabled',
        };
    }

    const spacingMm = settings.grid.spacingMm;
    const minAngleDeg = settings.grid.minBranchAngleDeg;
    const attachStepMm = settings.grid.attachSearchStepMm;
    const resolvedNodeKey = getResolvedSnappedNodeKey(candidate.route);
    const preferredReference = candidate.route.unsnappedBottomPos ?? candidate.root.transform.pos;

    const preferredNodeKey = resolvedNodeKey ?? getPreferredNodeKey(
        candidate,
        spacingMm,
        { x: preferredReference.x, y: preferredReference.y }
    );
    const candidateNodeKeys = buildNearestCandidateNodeKeys(preferredNodeKey, MAX_NEAREST_NODE_SEARCH_RINGS);

    const nodeKey = preferredNodeKey;
    const host = findHostTrunkAtNode(snapshot, modelId, nodeKey, spacingMm);
    const snappedCandidate = hasResolvedSnappedRoot(candidate.route) && nodeKey === resolvedNodeKey
        ? candidate
        : applyGridSnapToNodeKey(
            candidate,
            spacingMm,
            nodeKey,
        );
    if (!host) {
        const collidesWithGroundRoute = Boolean(mesh && trunkCollidesWithMesh(snappedCandidate, settings, mesh));
        if (!collidesWithGroundRoute) {
            return {
                kind: 'place_trunk',
                trunkBuild: withResolvedSnappedRoute(snappedCandidate, {
                    snappedRootPos: getResolvedSnappedRootPos(snappedCandidate.route, snappedCandidate.root.transform.pos),
                    snappedNodeKey: nodeKey,
                    snappedValidity: getResolvedSnappedValidity(snappedCandidate.route) ?? getDefaultSnappedValidity(snappedCandidate.route),
                }),
                nodeKey,
            };
        }

        for (const alternateNodeKey of candidateNodeKeys) {
            if (alternateNodeKey === nodeKey) continue;

            const nodeCandidate = hasResolvedSnappedRoot(candidate.route) && alternateNodeKey === resolvedNodeKey
                ? candidate
                : applyGridSnapToNodeKey(candidate, spacingMm, alternateNodeKey);
            const alternateHost = findHostTrunkAtNode(snapshot, modelId, alternateNodeKey, spacingMm);
            if (alternateHost) continue;
            if (mesh && trunkCollidesWithMesh(nodeCandidate, settings, mesh)) continue;

            return {
                kind: 'place_trunk',
                trunkBuild: withResolvedSnappedRoute(nodeCandidate, {
                    snappedRootPos: getResolvedSnappedRootPos(nodeCandidate.route, nodeCandidate.root.transform.pos),
                    snappedNodeKey: alternateNodeKey,
                    snappedValidity: getResolvedSnappedValidity(nodeCandidate.route) ?? getDefaultSnappedValidity(nodeCandidate.route),
                }),
                nodeKey: alternateNodeKey,
            };
        }

        const fallbackHost = findNearestReachableHostTrunkAttachment({
            snapshot,
            modelId,
            spacingMm,
            tipPos,
            minAngleDeg,
            settings,
            attachStepMm,
            mesh,
            tipNormal,
        });
        if (fallbackHost) {
            const { branch, supportData } = buildBranchData({
                tipPos,
                tipNormal,
                modelId,
                parentKnot: fallbackHost.knot,
            });
            return {
                kind: 'place_branch',
                nodeKey: fallbackHost.nodeKey,
                hostTrunkId: fallbackHost.trunkId,
                knot: fallbackHost.knot,
                branch,
                supportData,
            };
        }

        return {
            kind: 'reject',
            nodeKey,
            reason: 'COLLISION_WITH_MODEL',
            trunkBuild: withResolvedSnappedRoute(snappedCandidate, {
                snappedRootPos: getResolvedSnappedRootPos(snappedCandidate.route, snappedCandidate.root.transform.pos),
                snappedNodeKey: nodeKey,
                snappedValidity: 'hard_invalid',
                validity: 'hard_invalid',
                error: 'COLLISION_WITH_MODEL',
            }),
        };
    }

    if (host.trunk.segments.length === 0) {
        return {
            kind: 'reject',
            nodeKey,
            reason: 'NO_HOST_SEGMENT',
            trunkBuild: withResolvedSnappedRoute(snappedCandidate, {
                snappedRootPos: getResolvedSnappedRootPos(snappedCandidate.route, snappedCandidate.root.transform.pos),
                snappedNodeKey: nodeKey,
                snappedValidity: 'hard_invalid',
                validity: 'hard_invalid',
            }),
        };
    }

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
        const fallbackHost = findNearestReachableHostTrunkAttachment({
            snapshot,
            modelId,
            spacingMm,
            tipPos,
            minAngleDeg,
            settings,
            attachStepMm,
            mesh,
            tipNormal,
            excludeTrunkIds: new Set([host.trunkId]),
        });
        if (fallbackHost) {
            const { branch, supportData } = buildBranchData({
                tipPos,
                tipNormal,
                modelId,
                parentKnot: fallbackHost.knot,
            });
            return {
                kind: 'place_branch',
                nodeKey: fallbackHost.nodeKey,
                hostTrunkId: fallbackHost.trunkId,
                knot: fallbackHost.knot,
                branch,
                supportData,
            };
        }

        return {
            kind: 'reject',
            nodeKey,
            reason: mesh ? 'COLLISION_WITH_MODEL' : 'NO_VALID_ATTACHMENT',
            trunkBuild: withResolvedSnappedRoute(snappedCandidate, {
                snappedRootPos: getResolvedSnappedRootPos(snappedCandidate.route, snappedCandidate.root.transform.pos),
                snappedNodeKey: nodeKey,
                snappedValidity: mesh ? 'hard_invalid' : getDefaultSnappedValidity(snappedCandidate.route),
                error: mesh ? 'COLLISION_WITH_MODEL' : snappedCandidate.route.error,
            }),
        };
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
            trunkBuild: withResolvedSnappedRoute(snappedCandidate, {
                snappedRootPos: getResolvedSnappedRootPos(snappedCandidate.route, snappedCandidate.root.transform.pos),
                snappedNodeKey: nodeKey,
                snappedValidity: getResolvedSnappedValidity(snappedCandidate.route) ?? getDefaultSnappedValidity(snappedCandidate.route),
            }),
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


