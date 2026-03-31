import * as THREE from 'three';
import { Vec3 } from '../types';
import { gridNodeKeyFromXY, gridSnappedXYFromKey } from './Grid/gridMath';
import type { TrunkPlacementResult } from './StandardPlacement';
import { simplifyRouteJoints } from './smartPlacementSimplification';
import {
    chainSatisfiesLengthAwareUpperSpanRule,
    distanceXY,
    RouteEvaluationMetrics,
    SearchNode,
    segmentSatisfiesLengthAwareMaxAngleFromVertical,
} from './smartPlacementSearchUtils';

export interface RouteEvaluation extends RouteEvaluationMetrics {
    result: TrunkPlacementResult;
}

export interface EvaluateResolvedRouteArgs {
    node: SearchNode;
    socketPos: Vec3;
    rootTopZ: number;
    gridEnabled: boolean;
    spacingMm: number;
    maxNearestNodeSearchRings: number;
    minRoutedTrunkAngleDeg: number;
    collisionRadius: number;
    mesh: THREE.Mesh;
    warning?: TrunkPlacementResult['warning'];
    angle?: TrunkPlacementResult['angle'];
    coneAxis?: TrunkPlacementResult['coneAxis'];
    raycaster?: THREE.Raycaster;
    buildNearestCandidateNodeKeys: (preferredKey: string, maxRings: number) => string[];
    withInsertedRootTransition: (args: {
        basePos: Vec3;
        rootTopZ: number;
        firstJointOrSocketPos: Vec3;
        minAngleDeg: number;
    }) => Vec3[] | null;
    segmentCollidesChain: (points: Vec3[], collisionRadius: number, mesh: THREE.Mesh) => boolean;
    totalSegmentLateral: (points: Vec3[]) => number;
}

const EPS = 0.000001;

function compareFloat(a: number, b: number): number {
    if (a < b - EPS) return -1;
    if (a > b + EPS) return 1;
    return 0;
}

function isCandidateRouteBetter(candidate: RouteEvaluationMetrics, current: RouteEvaluationMetrics): boolean {
    const scoreCmp = compareFloat(candidate.score, current.score);
    if (scoreCmp !== 0) return scoreCmp < 0;

    const dropCmp = compareFloat(candidate.verticalDrop, current.verticalDrop);
    if (dropCmp !== 0) return dropCmp > 0;

    const snapCmp = compareFloat(candidate.snapDistance, current.snapDistance);
    if (snapCmp !== 0) return snapCmp < 0;

    const lengthCmp = compareFloat(candidate.totalLength, current.totalLength);
    if (lengthCmp !== 0) return lengthCmp < 0;

    const lateralCmp = compareFloat(candidate.totalLateral, current.totalLateral);
    if (lateralCmp !== 0) return lateralCmp < 0;

    return candidate.jointCount < current.jointCount;
}

export function evaluateResolvedRoute(args: EvaluateResolvedRouteArgs): RouteEvaluation | null {
    const {
        node,
        socketPos,
        rootTopZ,
        gridEnabled,
        spacingMm,
        maxNearestNodeSearchRings,
        minRoutedTrunkAngleDeg,
        collisionRadius,
        mesh,
        warning,
        angle,
        coneAxis,
        raycaster,
        buildNearestCandidateNodeKeys,
        withInsertedRootTransition,
        segmentCollidesChain,
        totalSegmentLateral,
    } = args;

    const unsnappedBottomPos: Vec3 = {
        x: node.pos.x,
        y: node.pos.y,
        z: 0,
    };

    const candidateNodeKeys = gridEnabled
        ? buildNearestCandidateNodeKeys(
            gridNodeKeyFromXY(unsnappedBottomPos.x, unsnappedBottomPos.y, spacingMm),
            maxNearestNodeSearchRings,
        )
        : ['disabled'];

    let best: RouteEvaluation | null = null;

    for (const nodeKey of candidateNodeKeys) {
        const snappedXY = gridEnabled
            ? gridSnappedXYFromKey(nodeKey, spacingMm)
            : { x: unsnappedBottomPos.x, y: unsnappedBottomPos.y };
        const basePos: Vec3 = { x: snappedXY.x, y: snappedXY.y, z: 0 };
        const rootTopTarget: Vec3 = { x: snappedXY.x, y: snappedXY.y, z: rootTopZ };
        const firstJointOrSocketPos = node.joints[0] ?? node.pos;
        const insertedRootJoints = withInsertedRootTransition({
            basePos,
            rootTopZ,
            firstJointOrSocketPos,
            minAngleDeg: minRoutedTrunkAngleDeg,
        });

        if (insertedRootJoints === null) {
            continue;
        }

        const simplifiedRouteJoints = simplifyRouteJoints({
            routeJoints: node.joints,
            constructionJoints: insertedRootJoints,
            socketPos,
            rootTopTarget,
            collisionRadius,
            mesh,
            maxAngleFromVerticalDeg: 90 - minRoutedTrunkAngleDeg,
            raycaster,
        });
        const resolvedJoints = [...insertedRootJoints, ...simplifiedRouteJoints];
        const routeJointCount = simplifiedRouteJoints.length;
        const chainPoints = [
            rootTopTarget,
            ...resolvedJoints,
            socketPos,
        ];

        if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(node.pos, rootTopTarget, 90 - minRoutedTrunkAngleDeg) && insertedRootJoints.length === 0) {
            continue;
        }

        const upperSpanPoints = [resolvedJoints[0] ?? rootTopTarget, ...resolvedJoints.slice(1), socketPos];
        if (!chainSatisfiesLengthAwareUpperSpanRule(upperSpanPoints, 90 - minRoutedTrunkAngleDeg)) {
            continue;
        }

        if (segmentCollidesChain(chainPoints, collisionRadius, mesh)) {
            continue;
        }

        const snapDistance = distanceXY(basePos, unsnappedBottomPos);
        const totalLateral = totalSegmentLateral(chainPoints);
        const routeScore =
            node.totalLength * 3 +
            totalLateral * 16 +
            routeJointCount * 18 +
            snapDistance * 20 -
            node.verticalDrop * 2;

        const result: TrunkPlacementResult = {
            socketPos,
            joints: [...simplifiedRouteJoints],
            constructionJoints: [...insertedRootJoints],
            basePos,
            unsnappedBottomPos,
            snappedNodeKey: gridEnabled ? nodeKey : null,
            warning,
            angle,
            coneAxis,
        };

        const candidateMetrics: RouteEvaluationMetrics = {
            score: routeScore,
            jointCount: routeJointCount,
            snapDistance,
            totalLateral,
            totalLength: node.totalLength,
            verticalDrop: node.verticalDrop,
        };

        if (!best || isCandidateRouteBetter(candidateMetrics, best)) {
            best = {
                result,
                ...candidateMetrics,
            };
        }
    }

    return best;
}
