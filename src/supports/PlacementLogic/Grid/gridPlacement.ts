import type { Knot, Roots, SupportState, Trunk, Vec3 } from '../../types';
import type { TrunkBuildResult } from '../../SupportTypes/Trunk/trunkBuilder';
import type { SnappedTrunkRouteResult } from '../../SupportTypes/Trunk/trunkRouteTypes';
import { buildBranchData } from '../../SupportTypes/Branch/branchBuilder';
import { getSettings } from '../../Settings';
import {
    getDefaultSnappedValidity,
    getResolvedSnappedNodeKey,
    getResolvedSnappedRootPos,
    getResolvedSnappedValidity,
    hasResolvedSnappedRoot,
} from '../../SupportTypes/Trunk/trunkRouteResolution';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from './gridMath';
import type { DecideGridPlacementArgs, GridPlacementDecision } from './types';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { calculateKnotPositionOnSegmentFromT } from '../../SupportPrimitives/Knot/knotUtils';
import { isShaftBlocked, isCollisionSegmentBlocked } from '../CollisionAvoidance';
import * as THREE from 'three';
import { generateUuid } from '../../../utils/uuid';
import { buildAnchorData } from '../../SupportTypes/Anchor/anchorBuilder';
import { buildLeafData } from '../../SupportTypes/Leaf/leafBuilder';
import { perfMark, perfMeasureWithSpike } from '../Pathfinding/pathfindingPerf';

const MIN_TRUNK_CLEARANCE_MM = 0.05;
const ANCHOR_HEIGHT_THRESHOLD_MM = 5.0;
const MAX_AUTO_LEAF_SPAN_MM = 2.5;

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
    _modelId: string,
    mesh: THREE.Mesh,
    shaftDiameterMm: number
): boolean {
    const radius = shaftDiameterMm / 2 + 0.25;

    const settings = getSettings();
    const nominalConeLengthMm = settings.tip.lengthMm;
    const socketApprox: Vec3 = {
        x: tipPos.x + tipNormal.x * nominalConeLengthMm,
        y: tipPos.y + tipNormal.y * nominalConeLengthMm,
        z: tipPos.z + tipNormal.z * nominalConeLengthMm,
    };

    // Check the full knot→socket segment as a single shaft (SDF-based,
    // benefits from precomputed grid). Splitting into two segments is
    // unnecessary — the SDF's adaptive sphere tracing handles curvature.
    return isShaftBlocked(knot.pos, socketApprox, radius, mesh);
}

function getHostDiameterMmFromKnot(knot: Knot, settings: DecideGridPlacementArgs['settings']): number {
    return Math.max(0.001, (knot.diameter ?? (settings.shaft.diameterMm + 0.1)) - 0.1);
}

function tryBuildAutoLeafDecision(args: {
    nodeKey: string;
    hostTrunkId: string;
    knot: Knot;
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    settings: DecideGridPlacementArgs['settings'];
    mesh?: THREE.Mesh;
}): GridPlacementDecision | null {
    const { nodeKey, hostTrunkId, knot, tipPos, tipNormal, modelId, settings, mesh } = args;
    const dx = tipPos.x - knot.pos.x;
    const dy = tipPos.y - knot.pos.y;
    const dz = tipPos.z - knot.pos.z;
    const spanSq = dx * dx + dy * dy + dz * dz;
    const spanMm = Math.sqrt(spanSq);
    const epsilonZ = 0.0001;
    if (knot.pos.z > tipPos.z + epsilonZ) return null;
    if (spanMm > MAX_AUTO_LEAF_SPAN_MM) return null;

    const angleFromUpDeg = spanSq < 0.000001
        ? 0
        : THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, dz / spanMm))));
    const maxAngleDeg = settings.shaft.maxAngleDeg ?? 80;
    if (angleFromUpDeg > maxAngleDeg) return null;

    const hostDiameterMm = getHostDiameterMmFromKnot(knot, settings);
    const { leaf, supportData } = buildLeafData({
        tipPos,
        surfaceNormal: tipNormal,
        modelId,
        parentKnot: knot,
        hostDiameterMm,
        mesh,
    });

    return {
        kind: 'place_leaf',
        nodeKey,
        hostTrunkId,
        knot,
        leaf,
        supportData,
    };
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

    // Iterate segments from top (last) to bottom (first).
    for (let segIndex = hostTrunk.segments.length - 1; segIndex >= 0; segIndex--) {
        const segment = hostTrunk.segments[segIndex];
        const endpoints = getTrunkSegmentEndpointsWithSettings(hostTrunk, hostRoot, segIndex, settings);
        if (!segment || !endpoints) continue;

        // Segments fully below the tip are valid attachment candidates.

        // Coarse pre-filter: if the segment's bottom joint is above the tip,
        // there's no valid attachment point on this segment (all points on it
        // are above the tip). Skip to the next segment.
        if (endpoints.start.z >= tipPos.z) continue;

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

// Reusable raycaster for trunk collision checks — avoids allocating one per call.
function trunkCollidesWithMesh(
    candidate: TrunkBuildResult,
    settings: DecideGridPlacementArgs['settings'],
    mesh: THREE.Mesh
): boolean {
    const trunk = candidate.trunk;
    const root = candidate.root;
    const collisionRadius = settings.shaft.diameterMm / 2 + MIN_TRUNK_CLEARANCE_MM;

    for (let segIndex = 0; segIndex < trunk.segments.length; segIndex++) {
        const endpoints = getTrunkSegmentEndpointsWithSettings(trunk, root, segIndex, settings);
        if (!endpoints) continue;

        if (isShaftBlocked(endpoints.start, endpoints.end, collisionRadius, mesh)) {
            return true;
        }
    }

    return false;
}

export function decideGridPlacement(args: DecideGridPlacementArgs): GridPlacementDecision {
    const { settings, snapshot, candidate, tipPos, tipNormal, modelId, mesh } = args;

    // Near-plate contacts get a minimal anchor support instead of trunk/branch
    if (tipPos.z < ANCHOR_HEIGHT_THRESHOLD_MM) {
        const { anchor, supportData } = buildAnchorData({ tipPos, tipNormal, modelId, mesh });
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
        // Grid-mode trunk candidates are built without the flexible mesh router,
        // so preview and click must share this collision gate.
        perfMark('grid:trunk-collision');
        const collidesWithGroundRoute = Boolean(mesh && trunkCollidesWithMesh(snappedCandidate, settings, mesh));
        perfMeasureWithSpike('grid:trunk-collision', 'grid:collision-check');
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

    // ================================================================
    // A host trunk already occupies this grid node.
    //
    // STRATEGY: grid mode is fixed-node placement. An occupied preferred
    // node means attach to or replace that node; do not route to nearby nodes
    // or scan distant hosts during hover.
    // ================================================================

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

    // --- Step 1: Attach to the co-located host. ---
    perfMark('grid:attach-search');
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
    perfMeasureWithSpike('grid:attach-search', 'grid:attachment-search');

    if (!selectedKnot) {
        return {
            kind: 'reject',
            nodeKey,
            reason: 'NO_VALID_ATTACHMENT',
            trunkBuild: withResolvedSnappedRoute(snappedCandidate, {
                snappedRootPos: getResolvedSnappedRootPos(snappedCandidate.route, snappedCandidate.root.transform.pos),
                snappedNodeKey: nodeKey,
                snappedValidity: getDefaultSnappedValidity(snappedCandidate.route),
                error: snappedCandidate.route.error,
            }),
        };
    }

    // --- Step 2: Build branch on the fixed node. ---
    perfMark('grid:branch-build');
    const { branch, supportData } = buildBranchData({
        tipPos,
        tipNormal,
        modelId,
        parentKnot: selectedKnot,
        mesh,
    });
    perfMeasureWithSpike('grid:branch-build', 'branch:build');

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

    const leafDecision = tryBuildAutoLeafDecision({
        nodeKey,
        hostTrunkId: host.trunkId,
        knot: selectedKnot,
        tipPos,
        tipNormal,
        modelId,
        settings,
    });
    if (leafDecision) {
        return leafDecision;
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


