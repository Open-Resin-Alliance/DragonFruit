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

        if (
            !best ||
            routeScore < best.score - 0.000001 ||
            (
                Math.abs(routeScore - best.score) <= 0.000001 &&
                (
                    node.verticalDrop > best.verticalDrop + 0.000001 ||
                    (
                        Math.abs(node.verticalDrop - best.verticalDrop) <= 0.000001 &&
                        (
                            snapDistance < best.snapDistance - 0.000001 ||
                            (
                                Math.abs(snapDistance - best.snapDistance) <= 0.000001 &&
                                (
                                    node.totalLength < best.totalLength - 0.000001 ||
                                    (
                                        Math.abs(node.totalLength - best.totalLength) <= 0.000001 &&
                                        (
                                            totalLateral < best.totalLateral - 0.000001 ||
                                            (
                                                Math.abs(totalLateral - best.totalLateral) <= 0.000001 &&
                                                routeJointCount < best.jointCount
                                            )
                                        )
                                    )
                                )
                            )
                        )
                    )
                )
            )
        ) {
            best = {
                result,
                score: routeScore,
                jointCount: routeJointCount,
                snapDistance,
                totalLateral,
                totalLength: node.totalLength,
                verticalDrop: node.verticalDrop,
            };
        }
    }

    return best;
}
