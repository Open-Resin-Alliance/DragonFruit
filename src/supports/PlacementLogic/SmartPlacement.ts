import * as THREE from 'three';
import { Vec3 } from '../types';
import { calculateStandardPlacement, TrunkPlacementInput, TrunkPlacementResult } from './StandardPlacement';
import { checkShaftCollision } from './CollisionUtils';
import { getSettings } from '../Settings';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from './Grid/gridMath';
import { buildNearestCandidateNodeKeys } from './Grid/nearestCandidateNodeKeys';
import {
    BestCostEntry,
    distance3D,
    distanceXY,
    isBetterSearchState,
    positionKey,
    QueuedNode,
    queueSortValue,
} from './smartPlacementSearchUtils';
import { evaluateResolvedRoute } from './smartPlacementRouteEvaluation';
import { buildCandidateNodes } from './smartPlacementCandidateSearch';

export interface SmartPlacementInput extends TrunkPlacementInput {
    mesh: THREE.Mesh;
    modelId: string;
}

const MAX_SEARCH_EXPANSIONS = 220;
const SEARCH_RADII_MM = [2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40];
const SEARCH_DROPS_MM = [2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 40, 48];
const MIN_SEGMENT_LENGTH_MM = 0.5;
const MAX_NEAREST_NODE_SEARCH_RINGS = 4;
const MIN_INSERTED_BASE_SEGMENT_MM = 1.0;
const MIN_INSERTED_TRANSITION_SEGMENT_MM = 0.5;
const ROUTED_DETOUR_ANGLE_SLACK_DEG = 10;

function pushQueuedNode(heap: QueuedNode[], node: QueuedNode) {
    heap.push(node);
    let index = heap.length - 1;

    while (index > 0) {
        const parentIndex = Math.floor((index - 1) / 2);
        if (queueSortValue(heap[parentIndex]) <= queueSortValue(heap[index])) break;
        [heap[parentIndex], heap[index]] = [heap[index], heap[parentIndex]];
        index = parentIndex;
    }
}

function popQueuedNode(heap: QueuedNode[]): QueuedNode | undefined {
    if (heap.length === 0) return undefined;
    if (heap.length === 1) return heap.pop();

    const root = heap[0];
    heap[0] = heap.pop()!;

    let index = 0;
    while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;

        if (left < heap.length && queueSortValue(heap[left]) < queueSortValue(heap[smallest])) {
            smallest = left;
        }
        if (right < heap.length && queueSortValue(heap[right]) < queueSortValue(heap[smallest])) {
            smallest = right;
        }

        if (smallest === index) break;
        [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
        index = smallest;
    }

    return root;
}

function withInsertedRootTransition(args: {
    basePos: Vec3;
    rootTopZ: number;
    firstJointOrSocketPos: Vec3;
    minAngleDeg: number;
}): Vec3[] | null {
    const { basePos, rootTopZ, firstJointOrSocketPos, minAngleDeg } = args;
    const lateralShift = distanceXY(basePos, firstJointOrSocketPos);
    if (lateralShift <= 0.000001) {
        return [];
    }

    const minAngleRad = (minAngleDeg * Math.PI) / 180;
    const requiredDrop = lateralShift * Math.tan(minAngleRad);
    const maxInsertedJointZ = firstJointOrSocketPos.z - MIN_INSERTED_TRANSITION_SEGMENT_MM;
    const minInsertedJointZ = rootTopZ + MIN_INSERTED_BASE_SEGMENT_MM;

    if (maxInsertedJointZ <= minInsertedJointZ) {
        return null;
    }

    const insertedJointZ = Math.max(
        minInsertedJointZ,
        Math.min(firstJointOrSocketPos.z - requiredDrop, maxInsertedJointZ),
    );

    if (firstJointOrSocketPos.z - insertedJointZ + 0.000001 < requiredDrop) {
        return null;
    }

    return [{
        x: basePos.x,
        y: basePos.y,
        z: insertedJointZ,
    }];
}

function segmentCollidesChain(points: Vec3[], collisionRadius: number, mesh: THREE.Mesh, raycaster?: THREE.Raycaster): boolean {
    for (let i = 0; i < points.length - 1; i++) {
        const hit = checkShaftCollision(points[i], points[i + 1], collisionRadius, mesh, raycaster);
        if (hit.hit) return true;
    }
    return false;
}

function totalSegmentLateral(points: Vec3[]): number {
    let total = 0;
    for (let i = 0; i < points.length - 1; i++) {
        total += distanceXY(points[i], points[i + 1]);
    }
    return total;
}

function resolvedRouteWouldExceedLateralLimit(args: {
    socketPos: Vec3;
    rootTopZ: number;
    joints: Vec3[];
    maxTotalLateralMm: number;
    spacingMm: number;
    gridEnabled: boolean;
    buildNearestCandidateNodeKeys: (preferredKey: string, maxRings: number) => string[];
}): boolean {
    const unsnappedBottomPos = args.joints[args.joints.length - 1] ?? {
        x: args.socketPos.x,
        y: args.socketPos.y,
        z: 0,
    };
    const candidateNodeKeys = args.gridEnabled
        ? args.buildNearestCandidateNodeKeys(
            gridNodeKeyFromXY(unsnappedBottomPos.x, unsnappedBottomPos.y, args.spacingMm),
            MAX_NEAREST_NODE_SEARCH_RINGS,
        )
        : ['disabled'];

    let bestLateral = Number.POSITIVE_INFINITY;
    for (const nodeKey of candidateNodeKeys) {
        const snappedXY = args.gridEnabled
            ? gridSnappedXYFromKey(nodeKey, args.spacingMm)
            : { x: unsnappedBottomPos.x, y: unsnappedBottomPos.y };
        const chainPoints: Vec3[] = [
            { x: snappedXY.x, y: snappedXY.y, z: args.rootTopZ },
            ...args.joints,
            args.socketPos,
        ];
        bestLateral = Math.min(bestLateral, totalSegmentLateral(chainPoints));
    }

    return bestLateral > args.maxTotalLateralMm;
}

function evaluateBestSnapDistance(args: {
    socketPos: Vec3;
    joints: Vec3[];
    spacingMm: number;
    gridEnabled: boolean;
    buildNearestCandidateNodeKeys: (preferredKey: string, maxRings: number) => string[];
}): number {
    const unsnappedBottomPos = args.joints[args.joints.length - 1] ?? {
        x: args.socketPos.x,
        y: args.socketPos.y,
        z: 0,
    };
    const candidateNodeKeys = args.gridEnabled
        ? args.buildNearestCandidateNodeKeys(
            gridNodeKeyFromXY(unsnappedBottomPos.x, unsnappedBottomPos.y, args.spacingMm),
            MAX_NEAREST_NODE_SEARCH_RINGS,
        )
        : ['disabled'];

    let bestSnapDistance = Number.POSITIVE_INFINITY;
    for (const nodeKey of candidateNodeKeys) {
        const snappedXY = args.gridEnabled
            ? gridSnappedXYFromKey(nodeKey, args.spacingMm)
            : { x: unsnappedBottomPos.x, y: unsnappedBottomPos.y };
        bestSnapDistance = Math.min(
            bestSnapDistance,
            distanceXY(
                { x: snappedXY.x, y: snappedXY.y, z: 0 },
                unsnappedBottomPos,
            ),
        );
    }

    return bestSnapDistance;
}

/**
 * Smart Placement Solver
 * 
 * Attempts to find a valid support path when Standard Placement fails due to collision.
 * Uses an iterative "Joint Injection" strategy to bend the support around obstacles.
 */
export function calculateSmartPlacement(input: SmartPlacementInput): TrunkPlacementResult {
    const { mesh } = input;
    const settings = getSettings();
    const shaftRadius = settings.shaft.diameterMm / 2;
    const collisionRadius = shaftRadius + 0.8;
    const standard = calculateStandardPlacement(input);
    if (standard.error === 'ANGLE_TOO_STEEP') {
        return standard;
    }
    const rootTopZ = input.rootsTopZ;
    const minRoutedTrunkAngleDeg = settings.grid.minRoutedTrunkAngleDeg;
    const effectiveMinRoutedTrunkAngleDeg = Math.max(40, minRoutedTrunkAngleDeg - ROUTED_DETOUR_ANGLE_SLACK_DEG);
    const maxTotalLateralMm = Math.max(42, settings.grid.spacingMm * 10);
    const initialRootTopTarget: Vec3 = {
        x: standard.basePos.x,
        y: standard.basePos.y,
        z: rootTopZ,
    };
    const initialCollision = checkShaftCollision(
        standard.socketPos,
        initialRootTopTarget,
        collisionRadius,
        mesh
    );

    if (!initialCollision.hit || !initialCollision.point) {
        return standard;
    }

    const searchRoute = (): TrunkPlacementResult | null => {
        const start: QueuedNode = {
            pos: standard.socketPos,
            joints: [],
            totalLength: 0,
            totalLateral: 0,
            verticalDrop: 0,
            bestSnapDistance: 0,
            score: 0,
        };

        const queue: QueuedNode[] = [];
        pushQueuedNode(queue, start);
        const bestCostByKey = new Map<string, BestCostEntry>();
        const nearestCandidateNodeKeysCache = new Map<string, string[]>();
        const bestSnapDistanceCache = new Map<string, number>();
        const sharedRaycaster = new THREE.Raycaster();
        let expansions = 0;

        const buildNearestCandidateNodeKeysCached = (preferredKey: string, maxRings: number) => {
            const key = `${preferredKey}|${maxRings}`;
            const cached = nearestCandidateNodeKeysCache.get(key);
            if (cached) return cached;
            const computed = buildNearestCandidateNodeKeys(preferredKey, maxRings);
            nearestCandidateNodeKeysCache.set(key, computed);
            return computed;
        };

        const getBestSnapDistanceForJoints = (joints: Vec3[]) => {
            const unsnappedBottomPos = joints[joints.length - 1] ?? {
                x: standard.socketPos.x,
                y: standard.socketPos.y,
                z: 0,
            };
            const key = positionKey({ x: unsnappedBottomPos.x, y: unsnappedBottomPos.y, z: 0 });
            const cached = bestSnapDistanceCache.get(key);
            if (cached !== undefined) return cached;

            const computed = evaluateBestSnapDistance({
                socketPos: standard.socketPos,
                joints,
                spacingMm: settings.grid.spacingMm,
                gridEnabled: settings.grid.enabled,
                buildNearestCandidateNodeKeys: buildNearestCandidateNodeKeysCached,
            });

            bestSnapDistanceCache.set(key, computed);
            return computed;
        };

        while (queue.length > 0 && expansions < MAX_SEARCH_EXPANSIONS) {
            const current = popQueuedNode(queue);
            if (!current) break;
            expansions += 1;
            const resolvedRoute = evaluateResolvedRoute({
                node: current,
                socketPos: standard.socketPos,
                rootTopZ,
                gridEnabled: settings.grid.enabled,
                spacingMm: settings.grid.spacingMm,
                maxNearestNodeSearchRings: MAX_NEAREST_NODE_SEARCH_RINGS,
                minRoutedTrunkAngleDeg: effectiveMinRoutedTrunkAngleDeg,
                collisionRadius,
                mesh,
                warning: standard.warning,
                angle: standard.angle,
                coneAxis: standard.coneAxis,
                raycaster: sharedRaycaster,
                buildNearestCandidateNodeKeys: buildNearestCandidateNodeKeysCached,
                withInsertedRootTransition,
                segmentCollidesChain: (points, radius, targetMesh) => segmentCollidesChain(points, radius, targetMesh, sharedRaycaster),
                totalSegmentLateral,
            });
            if (resolvedRoute) {
                return resolvedRoute.result;
            }

            const blockedTarget: Vec3 = {
                x: current.pos.x,
                y: current.pos.y,
                z: rootTopZ,
            };
            const blockCollision = checkShaftCollision(current.pos, blockedTarget, collisionRadius, mesh, sharedRaycaster);
            if (!blockCollision.hit || !blockCollision.point) {
                continue;
            }

            const nextCandidates = buildCandidateNodes({
                current,
                socketPos: standard.socketPos,
                blockPoint: blockCollision.point,
                rootTopZ,
                mesh,
                collisionRadius,
                minAngleDeg: effectiveMinRoutedTrunkAngleDeg,
                maxTotalLateralMm,
                searchRadiiMm: SEARCH_RADII_MM,
                searchDropsMm: SEARCH_DROPS_MM,
                searchAngles: 16,
                minSegmentLengthMm: MIN_SEGMENT_LENGTH_MM,
                raycaster: sharedRaycaster,
            });

            for (let i = nextCandidates.length - 1; i >= 0; i--) {
                const candidate = nextCandidates[i];
                const nextJoints = [...current.joints, candidate.pos];
                const key = positionKey(candidate.pos);
                const bestSnapDistance = getBestSnapDistanceForJoints(nextJoints);
                const directDescentTarget: Vec3 = {
                    x: candidate.pos.x,
                    y: candidate.pos.y,
                    z: rootTopZ,
                };
                const directDescentCollision = checkShaftCollision(candidate.pos, directDescentTarget, collisionRadius, mesh, sharedRaycaster);
                const directDescentBonus = !directDescentCollision.hit ? 24 : 0;
                const nextScore =
                    candidate.score +
                    current.totalLength * 3 +
                    current.totalLateral * 10 +
                    nextJoints.length * 18 -
                    (current.verticalDrop + Math.max(0, current.pos.z - candidate.pos.z)) * 2 +
                    bestSnapDistance * 20 -
                    directDescentBonus;
                const nextVerticalDrop = current.verticalDrop + Math.max(0, current.pos.z - candidate.pos.z);
                const nextTotalLength = current.totalLength + distance3D(current.pos, candidate.pos);
                const nextTotalLateral = current.totalLateral + distanceXY(current.pos, candidate.pos);
                const nextState: BestCostEntry = {
                    score: nextScore,
                    totalLength: nextTotalLength,
                    totalLateral: nextTotalLateral,
                    verticalDrop: nextVerticalDrop,
                    bestSnapDistance,
                    jointCount: nextJoints.length,
                };
                const bestCost = bestCostByKey.get(key);
                if (!isBetterSearchState(nextState, bestCost)) {
                    continue;
                }

                if (resolvedRouteWouldExceedLateralLimit({
                    socketPos: standard.socketPos,
                    rootTopZ,
                    joints: nextJoints,
                    maxTotalLateralMm,
                    spacingMm: settings.grid.spacingMm,
                    gridEnabled: settings.grid.enabled,
                    buildNearestCandidateNodeKeys: buildNearestCandidateNodeKeysCached,
                })) {
                    continue;
                }

                bestCostByKey.set(key, nextState);
                pushQueuedNode(queue, {
                    pos: candidate.pos,
                    joints: nextJoints,
                    totalLength: nextTotalLength,
                    totalLateral: nextTotalLateral,
                    verticalDrop: nextVerticalDrop,
                    bestSnapDistance,
                    score: nextScore,
                });
            }
        }

        return null;
    };

    const routed = searchRoute();
    if (routed) {
        return routed;
    }

    return {
        ...standard,
        error: 'COLLISION_WITH_MODEL'
    };
}
