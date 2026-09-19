/**
 * SmartPlacementV3 — the support trunk router.
 *
 * One entry point, one route shape, one collision oracle. It replaces the chain
 * of engines that grew here before it (a discrete A* on a lattice, a potential
 * field integration, a deterministic gradient march, and a rescue candidate
 * sweep, each with its own caches and its own idea of what a valid route is).
 * They disagreed often enough that a placement could be a two joint diagonal in
 * one code path and a five joint contour hug in another, and the argument cost
 * more than the answer.
 *
 * The shape it produces, which is what slicers actually print:
 *
 *     contact cone ──► one diagonal ──► joint ──► straight drop to the plate
 *
 * The diagonal leaves the socket at up to 45° from vertical and is lifted as
 * high as its column allows, so the tilt is as short as the geometry permits
 * and everything below the joint is vertical. A trunk is strongest as a
 * vertical pillar, so the router's whole job is to find the earliest point
 * where vertical becomes possible and get there in one move.
 *
 * Cost is bounded by construction: the search is a bounded outward walk with a
 * hard probe budget (see `EscapeJointSearch`), the roots volume is the only
 * other place that touches the mesh, and nothing here iterates to a fixed
 * point. There is no expansion budget, no warm start, no stagnation cache, and
 * no tuning profile, because there is no search that could stagnate.
 */

import * as THREE from 'three';
import type { Vec3 } from '../types';
import {
    calculateStandardPlacement,
    type TrunkPlacementInput,
    type TrunkPlacementResult,
} from '../PlacementLogic/StandardPlacement';
import { getSettings } from '../Settings/state';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from '../PlacementLogic/Grid/gridMath';
import { buildNearestCandidateNodeKeys } from '../PlacementLogic/Grid/nearestCandidateNodeKeys';
import type { SDFCache } from '../PlacementLogic/Pathfinding/SDFCache';
import { getOrCreateSDFCache } from '../PlacementLogic/Pathfinding/SDFCachePool';
import { buildDirectionFan, findEscapeJoint, findGridJoint } from './EscapeJointSearch';
import {
    clampConeAxisDeviationFromSurfaceNormal,
    MAX_CONE_AXIS_DEVIATION_FROM_SURFACE_NORMAL_DEG,
} from '../PlacementLogic/ConeAxisPolicy';
import { getSocketPosition } from '../SupportPrimitives/ContactCone';
import { calculateDiskThickness } from '../SupportPrimitives/ContactDisk/contactDiskUtils';
import type { SupportTipProfile } from '../SupportPrimitives/ContactCone/types';
import {
    distance3D,
    distanceXY,
    getLengthAwareMaxAngleFromVerticalDeg,
    segmentSatisfiesLengthAwareMaxAngleFromVertical,
    segmentSatisfiesMaxAngleFromVertical,
    spanLeanFromVerticalDeg,
    TRUNK_DIAGONAL_LEAN_FROM_VERTICAL_DEG,
} from '../PlacementLogic/smartPlacementSearchUtils';
import {
    getSupportPathfindingDebugEnabled,
    setSupportPathfindingDebugSnapshot,
} from '../PlacementLogic/Pathfinding/pathfindingDebugState';

export interface SmartPlacementV3Input extends TrunkPlacementInput {
    mesh: THREE.Mesh;
    modelId: string;
    /** Hover preview rather than a committed click. Reported to the debug overlay only. */
    isPreview?: boolean;
}

export interface SmartPlacementV3Context {
    /** Cached SDF for the model mesh. Reuse across placements for the same mesh. */
    sdfCache?: SDFCache;
    /**
     * Resolve as if the grid were off. Set only by the retry below: a grid
     * placement that cannot meet the shape rule is re-resolved without it.
     */
    ignoreGrid?: boolean;
}

// Standoff from model geometry, matching the shaft collision gate used
// everywhere else in the support system.
const COLLISION_AVOIDANCE_MM = 0.48;
/** Safety margin applied to the roots volume, as the rest of the system does. */
const ROOTS_DISK_SAFETY_MM = COLLISION_AVOIDANCE_MM;
/** Perimeter samples around the roots cross-section at each height slice. */
const ROOTS_DISK_PERIMETER_SAMPLES = 16;
/**
 * Ring search around the preferred base node when the grid is on. Grid mode
 * searches no rings at all: the joint already sits on a node, and walking the
 * base outwards to find one whose roots fit is what made a grid pillar lean
 * across to a distant node instead of tilting at the top and dropping onto a
 * node vertically. When the node under the joint cannot take the base, the
 * answer is a different joint, not a longer lean.
 */
const MAX_BASE_SEARCH_RINGS = 4;
const GRID_BASE_SEARCH_RINGS = 0;
// Shortest vertical leg worth putting below a joint.
const MIN_VERTICAL_LEG_MM = 1.0;
/** A base this far off the socket's column still counts as a straight drop. */
const STRAIGHT_BASE_TOLERANCE_MM = 0.05;
/** Lateral step of the outward walk. One SDF probe pair per step. */
const WALK_STEP_MM = 0.5;
/** Directions tried, in preference order, before the router gives up. */
const DIRECTION_COUNT = 12;
/**
 * How many lattice nodes the grid search may try, nearest first. The nearest
 * node is the answer unless the model blocks it, so this only bounds the case
 * where the tip sits in a pocket that forces the joint well outwards.
 */
const GRID_JOINT_NODE_BUDGET = 24;
/**
 * The vertical leg below the joint is the load-bearing span, so it obeys the
 * configured routed-trunk angle: a segment may sit up to the configured angle
 * (90 minus `grid.minRoutedTrunkAngleDeg`) and the length-aware tightening
 * floors there instead of at a fixed 15.
 */
const ROUTED_DETOUR_SLACK_DEG = 10;
const MIN_ALLOWED_ROUTED_ANGLE_DEG = 15;

/**
 * Roots volume check: does the disk + cone the root is made of intersect the model?
 *
 * Samples the cross-section the root actually occupies at each height and asks
 * whether that circle comes within the safety margin of the mesh, with the
 * bounding-ball early-out the 1-Lipschitz SDF allows (if the slice centre is
 * further than the slice radius + safety, no perimeter point can be blocked).
 */
function rootsVolumeBlocked(
    sdf: SDFCache,
    centerX: number,
    centerY: number,
    diskHeight: number,
    coneHeight: number,
    rootsRadius: number,
    shaftRadius: number,
): boolean {
    const rootTopZ = diskHeight + coneHeight;
    const zSlices = Math.max(4, Math.ceil(rootTopZ / sdf.cellSize));
    for (let slice = 0; slice <= zSlices; slice++) {
        const z = (slice / zSlices) * rootTopZ;
        const radiusAtZ = z <= diskHeight
            ? rootsRadius
            : rootsRadius + ((z - diskHeight) / Math.max(coneHeight, 1e-6)) * (shaftRadius - rootsRadius);

        const centerDist = sdf.distanceAt(centerX, centerY, z);
        if (centerDist >= radiusAtZ + ROOTS_DISK_SAFETY_MM) continue;
        if (centerDist < ROOTS_DISK_SAFETY_MM) return true;

        for (let i = 0; i < ROOTS_DISK_PERIMETER_SAMPLES; i++) {
            const angle = (i / ROOTS_DISK_PERIMETER_SAMPLES) * Math.PI * 2;
            if (sdf.distanceAt(
                centerX + Math.cos(angle) * radiusAtZ,
                centerY + Math.sin(angle) * radiusAtZ,
                z,
            ) < ROOTS_DISK_SAFETY_MM) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Resolves the cone's axis and the shaft's top point together, because they are
 * one decision: the builder renders the cone along the direction from the cone
 * start to the socket, and both its direction and its length come from that
 * socket, so wherever the socket goes the cone points.
 *
 * With a joint to aim at, the socket moves onto the line from the cone start
 * toward that joint, so the cone and the first shaft segment form one line. The
 * move is clamped, because the contact disk is oriented along the surface
 * normal and the cone cannot point radically away from it. With no joint (a
 * straight shaft) the socket stands and the axis follows it.
 */
function resolveConeSocketAndAxis(args: {
    socketPos: Vec3;
    joints: Vec3[];
    tipPos: Vec3;
    tipNormal: Vec3;
    tipProfile: SupportTipProfile;
    /** The pre-routing axis: used for the disk thickness, and as the fallback direction. */
    coneAxisHint: Vec3;
    coneBlockedAt: (socketPos: Vec3) => boolean;
    segmentBlockedBetween: (from: Vec3, to: Vec3) => boolean;
}): { socketPos: Vec3; coneAxis: Vec3 } {
    const { socketPos, joints, tipPos, tipNormal, tipProfile, coneAxisHint } = args;

    const diskThickness = tipProfile.type === 'disk'
        ? calculateDiskThickness(tipNormal, coneAxisHint, tipProfile)
        : 0;
    const coneStartPos: Vec3 = {
        x: tipPos.x + tipNormal.x * diskThickness,
        y: tipPos.y + tipNormal.y * diskThickness,
        z: tipPos.z + tipNormal.z * diskThickness,
    };
    const hint = new THREE.Vector3(coneAxisHint.x, coneAxisHint.y, coneAxisHint.z);

    const firstJoint = joints[0];
    if (firstJoint) {
        const alignedAxis = clampConeAxisDeviationFromSurfaceNormal(
            tipNormal,
            hint.clone().set(
                firstJoint.x - coneStartPos.x,
                firstJoint.y - coneStartPos.y,
                firstJoint.z - coneStartPos.z,
            ).normalize(),
            MAX_CONE_AXIS_DEVIATION_FROM_SURFACE_NORMAL_DEG,
        );
        const alignedSocket = getSocketPosition(coneStartPos, alignedAxis, tipProfile);
        if (!args.coneBlockedAt(alignedSocket) && !args.segmentBlockedBetween(alignedSocket, firstJoint)) {
            return { socketPos: alignedSocket, coneAxis: alignedAxis };
        }
    }

    return {
        socketPos,
        coneAxis: hint.clone().set(
            socketPos.x - coneStartPos.x,
            socketPos.y - coneStartPos.y,
            socketPos.z - coneStartPos.z,
        ).normalize(),
    };
}

/**
 * Resolves where the root lands and where the shaft's vertical leg ends.
 *
 * With the grid on, the base snaps to the nearest legal node: legal means the
 * roots volume fits there and the leg from the joint reaches it without
 * clipping. Among legal nodes the nearest to directly under the joint wins, so
 * the last leg stays as vertical as the grid allows. With the grid off the
 * preferred XY is continuous and is used as-is.
 */
function resolveBase(args: {
    preferredXY: { x: number; y: number };
    lastSegmentStart: Vec3;
    rootTopZ: number;
    spacingMm: number;
    gridEnabled: boolean;
    /** How many node rings to search around the preferred XY. 0 = that node only. */
    maxSearchRings: number;
    sdf: SDFCache;
    diskHeight: number;
    coneHeight: number;
    rootsRadius: number;
    shaftRadius: number;
    clearanceMm: number;
    baseFitsAt: (x: number, y: number) => boolean;
    segmentBlockedBetween: (from: Vec3, to: Vec3) => boolean;
}): { basePos: Vec3; rootTopTarget: Vec3; nodeKey: string | null } | null {
    const nodeKeys = args.gridEnabled
        ? buildNearestCandidateNodeKeys(
            gridNodeKeyFromXY(args.preferredXY.x, args.preferredXY.y, args.spacingMm),
            args.maxSearchRings,
        )
        : ['continuous'];

    let best: { basePos: Vec3; rootTopTarget: Vec3; nodeKey: string | null; lateralMm: number } | null = null;
    for (const nodeKey of nodeKeys) {
        const xy = args.gridEnabled
            ? gridSnappedXYFromKey(nodeKey, args.spacingMm)
            : args.preferredXY;
        if (!args.baseFitsAt(xy.x, xy.y)) continue;

        const basePos: Vec3 = { x: xy.x, y: xy.y, z: 0 };
        const rootTopTarget: Vec3 = { x: xy.x, y: xy.y, z: args.rootTopZ };
        if (args.segmentBlockedBetween(args.lastSegmentStart, rootTopTarget)) continue;

        const lateralMm = Math.hypot(xy.x - args.lastSegmentStart.x, xy.y - args.lastSegmentStart.y);
        if (!best || lateralMm < best.lateralMm) {
            best = { basePos, rootTopTarget, nodeKey: args.gridEnabled ? nodeKey : null, lateralMm };
        }
    }
    return best;
}

/**
 * Whether a resolved chain holds the shape rule: every span from the socket down
 * to the base, measured against the 45 degrees a trunk's diagonal is built to.
 *
 * The router's own checks cover the diagonal it chose and the leg below it, but
 * not the *base* the grid moved: snapping the drop to a node leaves the socket
 * where the contact is, so the span under the tip can come out flatter than any
 * diagonal the router would ever have built. A tip low to the plate beside a node
 * a couple of millimetres out is the case: there is no height left for a 45°
 * diagonal, and the builder closes the gap with a near-horizontal elbow.
 */
function chainHoldsShapeRule(points: Vec3[], clearanceMm: number): boolean {
    for (let i = 0; i < points.length - 1; i++) {
        const start = points[i];
        const end = points[i + 1];
        if (distanceXY(start, end) <= Math.max(clearanceMm * 0.5, 0.05)) continue;
        const spanMm = distance3D(start, end);
        // The same allowance the router applies to the leg it built: short spans
        // may take the detour slack, longer ones tighten to the trunk's 45 degrees.
        const allowanceDeg = getLengthAwareMaxAngleFromVerticalDeg(
            spanMm,
            TRUNK_DIAGONAL_LEAN_FROM_VERTICAL_DEG,
            TRUNK_DIAGONAL_LEAN_FROM_VERTICAL_DEG,
        );
        if (spanLeanFromVerticalDeg(start, end) > allowanceDeg + 0.05) return false;
    }
    return true;
}

/**
 * Resolves a trunk placement: the socket the shaft leaves from, the chain that
 * gets it to the plate, and the cone that attaches it to the model.
 *
 * Returns a `COLLISION_WITH_MODEL` result rather than searching harder when the
 * socket's column is blocked and no joint in the envelope fixes it. A trunk
 * that cannot reach the plate in one diagonal is not a trunk, and the caller
 * has the cavity fallback for exactly that case.
 */
export function calculateSmartPlacementV3(
    input: SmartPlacementV3Input,
    context?: SmartPlacementV3Context,
): TrunkPlacementResult {
    const standard = calculateStandardPlacement(input);
    if (standard.error) return standard;

    const settings = getSettings();
    const sdf = context?.sdfCache ?? getOrCreateSDFCache(input.mesh);
    sdf.refreshMatrix();

    const rootTopZ = input.rootsTopZ;
    const shaftRadius = settings.shaft.diameterMm / 2;
    const clearanceMm = shaftRadius + COLLISION_AVOIDANCE_MM;
    const rootsRadius = settings.roots.diameterMm / 2;
    const diskHeight = settings.roots.diskHeightMm;
    const coneHeight = settings.roots.coneHeightMm;
    const spacingMm = settings.grid.spacingMm;
    const ignoredGrid = Boolean(settings.grid.enabled && context?.ignoreGrid);
    const gridEnabled = settings.grid.enabled && !context?.ignoreGrid;

    // Two memos only: the roots volume (a disk + cone sweep, the most
    // expensive per-point check here) and the segment test the chain uses.
    const rootsMemo = new Map<string, boolean>();
    /** True when the roots volume at this XY is blocked by the model. */
    const rootsBlockedAt = (x: number, y: number): boolean => {
        const key = `${Math.round(x / 0.05)}|${Math.round(y / 0.05)}`;
        const cached = rootsMemo.get(key);
        if (cached !== undefined) return cached;
        const blocked = rootsVolumeBlocked(sdf, x, y, diskHeight, coneHeight, rootsRadius, shaftRadius);
        rootsMemo.set(key, blocked);
        return blocked;
    };
    const segmentMemo = new Map<string, boolean>();
    const segmentBlockedBetween = (from: Vec3, to: Vec3): boolean => {
        const key = [from.x, from.y, from.z, to.x, to.y, to.z].map((v) => Math.round(v * 100)).join(',');
        const cached = segmentMemo.get(key);
        if (cached !== undefined) return cached;
        const blocked = sdf.segmentBlocked(from.x, from.y, from.z, to.x, to.y, to.z, clearanceMm);
        segmentMemo.set(key, blocked);
        return blocked;
    };
    const coneBlockedAt = (socketPos: Vec3): boolean => (
        sdf.distanceAt(socketPos.x, socketPos.y, socketPos.z) < clearanceMm
    );

    const socketPos = standard.socketPos;
    const verticalSpanMm = Math.max(0, socketPos.z - rootTopZ);
    const maxLateralMm = Math.min(72, Math.max(48, verticalSpanMm * 2.5));

    /**
     * Publishes what the router decided, for the pathfinding debug overlay. The
     * overlay used to be fed by the retired engine's snapshot publisher; this is
     * the only producer now, so a placement that stops calling it takes the
     * debug view with it.
     */
    const publishDebug = (args: {
        status: 'straight' | 'routed' | 'blocked';
        reason: string;
        resolvedSocketPos: Vec3;
        basePos?: Vec3;
        finalChain?: Vec3[];
        straightPreflightClear: boolean;
        rootsFitStraightDown: boolean;
        routerProbes: number;
    }): void => {
        if (!getSupportPathfindingDebugEnabled()) return;
        setSupportPathfindingDebugSnapshot({
            modelId: input.modelId,
            socketPos: args.resolvedSocketPos,
            nominalSocketPos: standard.socketPos,
            rootTopZ,
            clearanceMm,
            basePos: args.basePos,
            finalChain: args.finalChain,
            outcome: { status: args.status, reason: args.reason },
            envelope: { maxTotalLateralMm: maxLateralMm, rootTopZ, clearanceMm },
            events: [{
                stage: 'route',
                severity: args.status === 'blocked' ? 'warning' : 'success',
                message: args.reason,
                details: `${args.routerProbes} probes, diagonal lean ${TRUNK_DIAGONAL_LEAN_FROM_VERTICAL_DEG}deg`,
            }],
            updatedAtMs: Date.now(),
            isPreview: input.isPreview,
            maxSegmentAngleDeg: Math.max(MIN_ALLOWED_ROUTED_ANGLE_DEG, 90 - settings.grid.minRoutedTrunkAngleDeg),
            straightPreflightClear: args.straightPreflightClear,
            rootsFitStraightDown: args.rootsFitStraightDown,
            routerProbes: args.routerProbes,
        });
    };

    const straightPreflightClear = !segmentBlockedBetween(socketPos, { x: socketPos.x, y: socketPos.y, z: rootTopZ });
    const rootsFitStraightDown = !rootsBlockedAt(socketPos.x, socketPos.y);

    // 1. Straight: the column below the socket is already clear and a root fits
    //    there. Nothing to route, and this is the strongest shape there is.
    if (straightPreflightClear && rootsFitStraightDown) {
        const cone = resolveConeSocketAndAxis({
            socketPos,
            joints: [],
            tipPos: input.tipPos,
            tipNormal: input.tipNormal,
            tipProfile: input.tipProfile,
            coneAxisHint: standard.coneAxis ?? input.tipNormal,
            coneBlockedAt,
            segmentBlockedBetween,
        });
        const base = resolveBase({
            preferredXY: { x: cone.socketPos.x, y: cone.socketPos.y },
            lastSegmentStart: cone.socketPos,
            rootTopZ,
            spacingMm,
            gridEnabled,
            maxSearchRings: gridEnabled ? GRID_BASE_SEARCH_RINGS : MAX_BASE_SEARCH_RINGS,
            sdf,
            diskHeight,
            coneHeight,
            rootsRadius,
            shaftRadius,
            clearanceMm,
            baseFitsAt: (x, y) => !rootsBlockedAt(x, y),
            segmentBlockedBetween,
        });
        // "Straight" means the column under the socket, and the grid is allowed to
        // move the base off it. That is not a straight drop any more: the builder
        // draws it as a vertical leg plus a short closing member, and with a low
        // contact that member comes out near-horizontal. A base the grid moved is
        // left to the routing below, which is where a diagonal belongs.
        const baseIsUnderSocket = Boolean(base) && Math.hypot(
            base!.basePos.x - cone.socketPos.x,
            base!.basePos.y - cone.socketPos.y,
        ) <= STRAIGHT_BASE_TOLERANCE_MM;
        if (base && baseIsUnderSocket) {
            const straightChain = [cone.socketPos, base.rootTopTarget];
            if (gridEnabled && !chainHoldsShapeRule(straightChain, clearanceMm)) {
                return calculateSmartPlacementV3(input, { ...context, ignoreGrid: true });
            }
            publishDebug({
                status: 'straight',
                reason: 'socket column and roots are clear, no routing',
                resolvedSocketPos: cone.socketPos,
                basePos: base.basePos,
                finalChain: straightChain,
                straightPreflightClear,
                rootsFitStraightDown,
                routerProbes: 0,
            });
            return {
                ...standard,
                socketPos: cone.socketPos,
                joints: [],
                constructionJoints: [],
                basePos: base.basePos,
                unsnappedBottomPos: cone.socketPos,
                snappedNodeKey: base.nodeKey,
                coneAxis: cone.coneAxis,
                error: undefined,
                gridIgnored: ignoredGrid,
            };
        }
    }

    // 2. One diagonal to a column that clears, then straight down. The fan is
    //    ordered so the way off the surface the tip is attached to is tried
    //    first; every direction is tried before giving up.
    const outward = new THREE.Vector3(
        (standard.coneAxis ?? input.tipNormal).x,
        (standard.coneAxis ?? input.tipNormal).y,
        0,
    );
    const jointSearchShared = {
        clearanceMm,
        maxLateralMm,
        leanFromVerticalDeg: TRUNK_DIAGONAL_LEAN_FROM_VERTICAL_DEG,
        minVerticalLegMm: MIN_VERTICAL_LEG_MM,
        baseFitsAt: (x: number, y: number) => !rootsBlockedAt(x, y),
    };
    // Grid mode searches the lattice: the drop has to land on a node, so the
    // node is chosen first and the joint derived from it. Every other mode
    // drops at the first column that clears.
    const found = gridEnabled
        ? findGridJoint(sdf, socketPos, rootTopZ, {
            ...jointSearchShared,
            spacingMm,
            maxNodeCount: GRID_JOINT_NODE_BUDGET,
            // Keep leaving the way the cone points: the node nearest that
            // direction wins over an equally close node the other way.
            preferredDirection: outward.lengthSq() > 1e-6 ? { x: outward.x, y: outward.y } : null,
        })
        : findEscapeJoint(sdf, socketPos, rootTopZ, {
            ...jointSearchShared,
            stepMm: WALK_STEP_MM,
            directions: buildDirectionFan(
                outward.lengthSq() > 1e-6 ? { x: outward.x, y: outward.y } : null,
                DIRECTION_COUNT,
            ),
        });
    if (!found.joint) {
        // The grid could not serve this contact: no node left room for the drop at
        // a lean the shape rule allows. That is the case the grid is dropped for,
        // rather than refused: the contact is reachable, just not on a node.
        if (gridEnabled) {
            return calculateSmartPlacementV3(input, { ...context, ignoreGrid: true });
        }
        publishDebug({
            status: 'blocked',
            reason: `no joint reached a clear column (${found.outcome}, ${found.probes} probes)`,
            resolvedSocketPos: socketPos,
            straightPreflightClear,
            rootsFitStraightDown,
            routerProbes: found.probes,
        });
        return { ...standard, error: 'COLLISION_WITH_MODEL' };
    }

    const joints: Vec3[] = [found.joint.joint];
    const cone = resolveConeSocketAndAxis({
        socketPos,
        joints,
        tipPos: input.tipPos,
        tipNormal: input.tipNormal,
        tipProfile: input.tipProfile,
        coneAxisHint: standard.coneAxis ?? input.tipNormal,
        coneBlockedAt,
        segmentBlockedBetween,
    });
    const base = resolveBase({
        preferredXY: { x: found.joint.joint.x, y: found.joint.joint.y },
        lastSegmentStart: found.joint.joint,
        rootTopZ,
        spacingMm,
        gridEnabled,
        maxSearchRings: gridEnabled ? GRID_BASE_SEARCH_RINGS : MAX_BASE_SEARCH_RINGS,
        sdf,
        diskHeight,
        coneHeight,
        rootsRadius,
        shaftRadius,
        clearanceMm,
        baseFitsAt: (x, y) => !rootsBlockedAt(x, y),
        segmentBlockedBetween,
    });
    if (!base) {
        publishDebug({
            status: 'blocked',
            reason: 'no committed base under the joint',
            resolvedSocketPos: cone.socketPos,
            finalChain: [cone.socketPos, found.joint.joint],
            straightPreflightClear,
            rootsFitStraightDown,
            routerProbes: found.probes,
        });
        return { ...standard, error: 'COLLISION_WITH_MODEL' };
    }

    // 3. The chain is built from the socket the cone actually ends at, so the
    //    leg angles are checked against the real geometry. The diagonal is the
    //    one segment exempt from the length-aware tightening (its job is to get
    //    out from under the model, and the load-bearing span below it is
    //    vertical), and it is bounded by the lean ceiling instead.
    const firstSegmentOk = segmentSatisfiesMaxAngleFromVertical(
        cone.socketPos,
        found.joint.joint,
        found.joint.leanFromVerticalDeg + 0.05,
    );
    const configuredRoutedAngleDeg = Math.max(
        MIN_ALLOWED_ROUTED_ANGLE_DEG,
        90 - settings.grid.minRoutedTrunkAngleDeg,
    );
    const verticalLegOk = !segmentBlockedBetween(found.joint.joint, base.rootTopTarget)
        && segmentSatisfiesLengthAwareMaxAngleFromVertical(
            found.joint.joint,
            base.rootTopTarget,
            Math.min(89, configuredRoutedAngleDeg + ROUTED_DETOUR_SLACK_DEG),
            configuredRoutedAngleDeg,
        );
    if (!firstSegmentOk || !verticalLegOk) {
        publishDebug({
            status: 'blocked',
            reason: 'rejected chain: '
                + `${firstSegmentOk ? '' : 'diagonal past its lean '}`
                + `${verticalLegOk ? '' : 'vertical leg blocked or too shallow'}`.trim(),
            resolvedSocketPos: cone.socketPos,
            finalChain: [cone.socketPos, found.joint.joint, base.rootTopTarget],
            straightPreflightClear,
            rootsFitStraightDown,
            routerProbes: found.probes,
        });
        return { ...standard, error: 'COLLISION_WITH_MODEL' };
    }

    // Same rule, measured on the whole chain: the leg below the joint can be the
    // span the grid made flat, when the node it snapped to is off the joint's
    // column and the joint is low enough to leave no height for the lean.
    if (gridEnabled
        && !chainHoldsShapeRule([cone.socketPos, found.joint.joint, base.rootTopTarget], clearanceMm)) {
        return calculateSmartPlacementV3(input, { ...context, ignoreGrid: true });
    }

    publishDebug({
        status: 'routed',
        reason: `one ${found.joint.leanFromVerticalDeg.toFixed(0)}° diagonal `
            + `${found.joint.lateralMm.toFixed(2)}mm out of the socket, then vertical`,
        resolvedSocketPos: cone.socketPos,
        basePos: base.basePos,
        finalChain: [cone.socketPos, found.joint.joint, base.rootTopTarget],
        straightPreflightClear,
        rootsFitStraightDown,
        routerProbes: found.probes,
    });

    return {
        ...standard,
        socketPos: cone.socketPos,
        joints,
        constructionJoints: [],
        basePos: base.basePos,
        unsnappedBottomPos: { x: found.joint.joint.x, y: found.joint.joint.y, z: 0 },
        snappedNodeKey: base.nodeKey,
        coneAxis: cone.coneAxis,
        error: undefined,
        gridIgnored: ignoredGrid,
    };
}
