import type { Knot, Roots, Trunk, Vec3 } from '../../types';
import type { TrunkBuildResult } from '../../SupportTypes/Trunk/trunkBuilder';
import type { SnappedTrunkRouteResult } from '../../SupportTypes/Trunk/trunkRouteTypes';
import { buildBranchData } from '../../SupportTypes/Branch/branchBuilder';
import { getSettings } from '../../Settings/state';
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
import { isShaftBlocked } from '../CollisionAvoidance';
import * as THREE from 'three';
import { v4 as uuidv4 } from 'uuid';
import { buildAnchorData } from '../../SupportTypes/Anchor/anchorBuilder';
import { buildLeafData } from '../../SupportTypes/Leaf/leafBuilder';
import { perfMark, perfMeasureWithSpike } from '../Pathfinding/pathfindingPerf';
import {
    MAX_AUTO_LEAF_SPAN_MM,
} from '../../autoSupport/constants';
import { selectTypeForPlacement } from '../../supportTypeRegistry';
import {
    distance3D,
    getLengthAwareMaxAngleFromVerticalDeg,
    memberDepartureAngleFromVerticalDeg,
    SHORT_SPAN_DETOUR_MAX_LENGTH_MM,
    SOCKET_ELBOW_MAX_ANGLE_FROM_VERTICAL_DEG,
} from '../smartPlacementSearchUtils';

/**
 * Matches `validateAndCullOrphans`' post-thickening trunk check
 * (segment diameter/2 + 0.15). A trunk that passes the placement gate must
 * not die in the cull — a thinner gate here placed straight pillars that the
 * cull then removed, stripping whole regions of supports (Puck jaw/mouth).
 */
const MIN_TRUNK_CLEARANCE_MM = 0.15;

/**
 * Node key reported when the router resolved this placement with the grid out
 * (see `TrunkPlacementResult.gridIgnored`). Next to the `'disabled'` used when the
 * grid is off: one is "no grid", this is "the grid could not be met at 45 degrees
 * or steeper, so the routed base stands".
 */
const GRID_UNSNAPPED_NODE_KEY = 'unsnapped';


/**
 * The trunk standing on this node, if there is one.
 *
 * The node map is keyed by the node nearest a trunk's root, so a root sitting
 * between nodes (hand placed, or placed before the spacing changed) is keyed to
 * a neighbour and the map misses it exactly where the new contact is aiming.
 * Half a step of tolerance covers that band and no more: a trunk on its own
 * node, a full step away, is not this node's host. A trunk is measured by
 * whichever of its two ends is nearer — the pillar's base, and the contact it
 * carries.
 */
function findHostTrunkNearNode(
    trunkGridMap: Map<string, { trunkId: string; trunk: Trunk; root: Roots }>,
    nodeKey: string,
    spacingMm: number,
): { trunkId: string; trunk: Trunk; root: Roots } | null {
    const centre = gridSnappedXYFromKey(nodeKey, spacingMm);
    let best: { trunkId: string; trunk: Trunk; root: Roots } | null = null;
    let bestDistanceMm = spacingMm * 0.5;
    for (const entry of trunkGridMap.values()) {
        let distanceMm = Math.hypot(
            entry.root.transform.pos.x - centre.x,
            entry.root.transform.pos.y - centre.y,
        );
        const contact = entry.trunk.contactCone?.pos;
        if (contact) {
            distanceMm = Math.min(distanceMm, Math.hypot(contact.x - centre.x, contact.y - centre.y));
        }
        if (distanceMm > bestDistanceMm) continue;
        best = entry;
        bestDistanceMm = distanceMm;
    }
    return best;
}

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

    // Check the full knot→socket segment as a single shaft (SDF-based).
    // Splitting into two segments is
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

/**
 * Picks where a candidate attaches on a host trunk and builds that member, or
 * returns null when the host cannot take it.
 *
 * The loop walks the host's segments from the top down, and each segment from
 * its top end to its bottom, so the highest usable knot wins; reaching further
 * down the shaft buys a steeper departure when the branch cannot legally leave
 * the top.
 */
function selectAttachmentDecision(args: {
    nodeKey: string;
    hostTrunkId: string;
    hostTrunk: Trunk;
    hostRoot: Roots;
    tipPos: Vec3;
    minAngleDeg: number;
    settings: DecideGridPlacementArgs['settings'];
    attachStepMm: number;
    mesh?: THREE.Mesh;
    tipNormal: Vec3;
    modelId: string;
    /**
     * True when a trunk already stands on this node, so this contact has to be
     * served by it: there is no second pillar to fall back to. A short graft may
     * then lean like a socket elbow (the bound the rest of the system uses for a
     * short member under a contact), because refusing it leaves the tip unplaced.
     */
    occupiedPoint?: boolean;
}): GridPlacementDecision | null {
    const {
        nodeKey, hostTrunkId, hostTrunk, hostRoot, tipPos,
        minAngleDeg, settings, attachStepMm, mesh, tipNormal, modelId,
        occupiedPoint = false,
    } = args;
    const shaftDiameterMm = settings.shaft.diameterMm;
    // A member may not leave its host shallower than the configured branch
    // angle (60 degrees above horizontal by default, so 30 from vertical),
    // except where the length-aware slack says otherwise: under 3mm a strut may
    // lean to 60 degrees from vertical and is mechanically sound. That slack is
    // what lets a host carry the tips beside it on a *flat* region, where the
    // host stands only as tall as the region's clearance and nothing could ever
    // leave it at a flat 30 degrees. Without it every tip but the one that
    // placed the host was refused outright.
    const baseMaxFromVerticalDeg = 90 - minAngleDeg;
    const memberAllowanceFromVerticalDeg = (segmentMm: number): number => {
        const branchAllowance = getLengthAwareMaxAngleFromVerticalDeg(
            segmentMm,
            baseMaxFromVerticalDeg,
            baseMaxFromVerticalDeg,
        );
        if (!occupiedPoint || segmentMm > SHORT_SPAN_DETOUR_MAX_LENGTH_MM) return branchAllowance;
        return Math.max(branchAllowance, SOCKET_ELBOW_MAX_ANGLE_FROM_VERTICAL_DEG);
    };

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

            // Cheap chord gate, on knot to tip, at the same length-aware
            // allowance the built member gets below. It is a pre-filter, not
            // the member's angle: see the departure gate further down.
            const spanMm = distance3D(pos, tipPos);
            if (memberDepartureAngleFromVerticalDeg(pos, tipPos) > memberAllowanceFromVerticalDeg(spanMm)) {
                continue;
            }

            const knot: Knot = {
                id: uuidv4(),
                parentShaftId: segment.id,
                t,
                pos,
                diameter: (segment.diameter ?? shaftDiameterMm) + 0.1,
            };

            if (mesh) {
                const collides = branchCollidesWithMesh(knot, tipPos, tipNormal, modelId, mesh, shaftDiameterMm);
                if (collides) continue;
            }

            // A short span becomes a leaf, and a leaf's single segment IS the
            // chord the gate above measured, so its departure is covered there.
            const leafDecision = tryBuildAutoLeafDecision({
                nodeKey,
                hostTrunkId,
                knot,
                tipPos,
                tipNormal,
                modelId,
                settings,
            });
            if (leafDecision) return leafDecision;

            // A longer span becomes a branch, and a branch's departure is NOT
            // its chord: the contact cone is clamped toward the surface normal
            // at the tip, so the shaft can leave the host nearly level, satisfy
            // the knot-to-tip angle, and bend into a steep cone only at the tip.
            // Gate the built shaft where it leaves the host, and let the loop
            // try a lower knot rather than accept a level branch.
            perfMark('grid:branch-build');
            const { branch, supportData } = buildBranchData({
                tipPos,
                tipNormal,
                modelId,
                parentKnot: knot,
                mesh,
            });
            perfMeasureWithSpike('grid:branch-build', 'branch:build');
            const firstJoint = branch.segments[0]?.topJoint?.pos;
            if (firstJoint
                && memberDepartureAngleFromVerticalDeg(pos, firstJoint)
                    > memberAllowanceFromVerticalDeg(distance3D(pos, firstJoint))) {
                continue;
            }

            return { kind: 'place_branch', nodeKey, hostTrunkId, knot, branch, supportData };
        }
    }

    return null;
}

function findNeighborAttachment(args: {
    nodeKey: string;
    trunkGridMap: Map<string, { trunkId: string; trunk: Trunk; root: Roots }>;
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    minAngleDeg: number;
    settings: DecideGridPlacementArgs['settings'];
    attachStepMm: number;
    mesh?: THREE.Mesh;
}): GridPlacementDecision | null {
    const [gxStr, gyStr] = args.nodeKey.split(',');
    const gx = Number(gxStr);
    const gy = Number(gyStr);
    const neighborOffsets = [
        // Cardinals
        { dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
        // Diagonals
        { dx: 1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: -1, dy: -1 }
    ];

    for (const offset of neighborOffsets) {
        const neighborKey = `${gx + offset.dx},${gy + offset.dy}`;
        const neighborHost = args.trunkGridMap.get(neighborKey);
        if (neighborHost && neighborHost.trunk.segments.length > 0) {
            const neighborDecision = selectAttachmentDecision({
                nodeKey: neighborKey,
                hostTrunkId: neighborHost.trunkId,
                hostTrunk: neighborHost.trunk,
                hostRoot: neighborHost.root,
                tipPos: args.tipPos,
                minAngleDeg: args.minAngleDeg,
                settings: args.settings,
                attachStepMm: args.attachStepMm,
                mesh: args.mesh,
                tipNormal: args.tipNormal,
                modelId: args.modelId,
            });
            if (neighborDecision) {
                return neighborDecision;
            }
        }
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
    // Gate at the trunk's own (tier-sized) shaft, not the global setting —
    // auto-sized tiers build fatter shafts than settings.shaft.
    let maxSegDiameter = settings.shaft.diameterMm;
    for (const seg of trunk.segments) {
        maxSegDiameter = Math.max(maxSegDiameter, seg.diameter ?? 0);
    }
    const collisionRadius = maxSegDiameter / 2 + MIN_TRUNK_CLEARANCE_MM;

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

    const spacingMm = settings.grid?.spacingMm ?? 4;
    
    // Build O(1) grid hash map of hosts
    const trunkGridMap = new Map<string, { trunkId: string; trunk: Trunk; root: Roots }>();
    const trunks: { trunkId: string; trunk: Trunk; root: Roots }[] = [];
    for (const trunk of Object.values(snapshot.trunks)) {
        if (trunk.modelId !== modelId) continue;
        const root = snapshot.roots[trunk.rootId];
        if (!root) continue;
        trunks.push({ trunkId: trunk.id, trunk, root });
    }
    // Indexed twice, roots first: where each pillar stands, then the point it
    // serves. A base routed off the grid (gridIgnored) stands wherever 45 degrees
    // allowed, a shaft height from its contact, so a root key says nothing about
    // which points are already taken. Contacts are written last, so the point a
    // trunk serves wins a node some other trunk merely stands on.
    for (const entry of trunks) {
        trunkGridMap.set(
            gridNodeKeyFromXY(entry.root.transform.pos.x, entry.root.transform.pos.y, spacingMm),
            entry,
        );
    }
    for (const entry of trunks) {
        const contact = entry.trunk.contactCone?.pos;
        if (contact) trunkGridMap.set(gridNodeKeyFromXY(contact.x, contact.y, spacingMm), entry);
    }

    // Which type a tip height calls for is declared; anchor claims the
    // near-plate band, trunk everything above it.
    if (selectTypeForPlacement('tipHeight', tipPos.z) === 'anchor') {
        const { anchor, supportData } = buildAnchorData({ tipPos, tipNormal, modelId, mesh });
        // The cone body spans contact disk → socket and must never dip below
        // the root joint: a tip lower than the root (or an over-long cone on a
        // downward axis) would push the shaft below the root, into -Z.
        const jointZ = anchor.joint.pos.z;
        const lowestShaftZ = Math.min(
            anchor.contactCone.pos.z,
            getFinalSocketPosition(anchor.contactCone).z,
        );
        if (lowestShaftZ < jointZ - 1e-3) {
            // Ghost-preview the invalid anchor (red, with the reason as
            // `error`) so the hover tooltip explains the rejection.
            return {
                kind: 'reject',
                nodeKey: '',
                reason: 'ANCHOR_BELOW_ROOT',
                supportData: { ...supportData, error: 'ANCHOR_BELOW_ROOT' },
            };
        }
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
    const host = trunkGridMap.get(nodeKey) ?? null;
    const snappedCandidate = hasResolvedSnappedRoot(candidate.route) && nodeKey === resolvedNodeKey
        ? candidate
        : applyGridSnapToNodeKey(
            candidate,
            spacingMm,
            nodeKey,
        );
    if (!host) {
        // The node is free by key, but a trunk may still be standing on it: a
        // root between nodes is keyed to a neighbour. When one is there, this is
        // an occupied point, so the merge is what the answer has to be. Grid
        // mode never replaces a trunk, and a second pillar beside the first is
        // not a placement either: it is the preview that gets refused.
        const hostOnNode = findHostTrunkNearNode(trunkGridMap, nodeKey, spacingMm);
        if (hostOnNode && hostOnNode.trunk.segments.length > 0) {
            const attachment = selectAttachmentDecision({
                nodeKey,
                hostTrunkId: hostOnNode.trunkId,
                hostTrunk: hostOnNode.trunk,
                hostRoot: hostOnNode.root,
                tipPos,
                minAngleDeg,
                settings,
                attachStepMm,
                mesh,
                tipNormal,
                modelId,
                occupiedPoint: true,
            });
            if (attachment) return attachment;

            const neighborMerge = findNeighborAttachment({
                nodeKey,
                trunkGridMap,
                tipPos,
                tipNormal,
                modelId,
                minAngleDeg,
                settings,
                attachStepMm,
                mesh,
            });
            if (neighborMerge) return neighborMerge;

            // Occupied point, and no member can leave the trunk standing there. A
            // pillar beside it is the preview that gets refused, so this is refused
            // too: the answer is a different contact, not a second trunk.
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

        // Grid-mode trunk candidates are built without the flexible mesh router,
        // so preview and click must share this collision gate.
        perfMark('grid:trunk-collision');
        const collidesWithGroundRoute = Boolean(mesh && trunkCollidesWithMesh(snappedCandidate, settings, mesh));
        perfMeasureWithSpike('grid:trunk-collision', 'grid:collision-check');
        if (!collidesWithGroundRoute) {
            // The router resolved this placement with the grid out, because holding
            // the base to a node would have asked for a member past what its length
            // may lean: a contact low to the plate beside a node a couple of
            // millimetres out has no height left for a 45 degree diagonal, so the
            // drop would have closed the gap with a near-horizontal elbow. Snapping
            // here would build that elbow, so the routed base stands.
            // The router already resolved this placement with the grid out, because
            // the grid could not be met at 45 degrees or steeper. Snapping here would
            // build the member the router declined to build, so the routed base stands.
            if (candidate.route.gridIgnored) {
                return {
                    kind: 'place_trunk',
                    trunkBuild: candidate,
                    nodeKey: GRID_UNSNAPPED_NODE_KEY,
                };
            }
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

        const neighborDecision = findNeighborAttachment({
            nodeKey,
            trunkGridMap,
            tipPos,
            tipNormal,
            modelId,
            minAngleDeg,
            settings,
            attachStepMm,
            mesh,
        });
        if (neighborDecision) {
            return neighborDecision;
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
    // node means attach to that node; do not route to nearby nodes or scan
    // distant hosts during hover. A trunk already standing on the node is
    // never replaced: a taller new contact becomes a branch on it, so the
    // pillar keeps serving every contact it already carries.
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

    // Attach to the co-located host: highest usable knot that can take the
    // member, else a neighbouring node, else refuse. The host is never removed
    // or replaced, whatever the new contact's height.
    perfMark('grid:attach-search');
    const attachment = selectAttachmentDecision({
        nodeKey,
        hostTrunkId: host.trunkId,
        hostTrunk: host.trunk,
        hostRoot: host.root,
        tipPos,
        minAngleDeg,
        settings,
        attachStepMm,
        mesh,
        tipNormal,
        modelId,
        occupiedPoint: true,
    });
    perfMeasureWithSpike('grid:attach-search', 'grid:attachment-search');
    if (attachment) return attachment;

    const neighborDecision = findNeighborAttachment({
        nodeKey,
        trunkGridMap,
        tipPos,
        tipNormal,
        modelId,
        minAngleDeg,
        settings,
        attachStepMm,
        mesh,
    });
    if (neighborDecision) {
        return neighborDecision;
    }

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
    }
}
