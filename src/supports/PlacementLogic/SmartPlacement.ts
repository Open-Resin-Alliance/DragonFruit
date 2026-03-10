import * as THREE from 'three';
import { Vec3 } from '../types';
import { calculateStandardPlacement, TrunkPlacementInput, TrunkPlacementResult } from './StandardPlacement';
import { checkShaftCollision } from './CollisionUtils';
import { getSettings } from '../Settings';

export interface SmartPlacementInput extends TrunkPlacementInput {
    mesh: THREE.Mesh;
    modelId: string;
}

interface SearchNode {
    pos: Vec3;
    joints: Vec3[];
    totalLength: number;
    totalLateral: number;
}

interface CandidateNode {
    pos: Vec3;
    score: number;
}

interface QueuedNode extends SearchNode {
    score: number;
}

const MAX_INTERNAL_JOINTS = 3;
const SEARCH_RADII_MM = [2, 4, 6, 8, 10, 12, 16, 20, 24];
const SEARCH_DROPS_MM = [2, 4, 6, 8, 12, 16, 20, 24, 28, 32, 40];
const SEARCH_ANGLES = 16;
const POSITION_KEY_MM = 0.5;
const MIN_SEGMENT_LENGTH_MM = 0.5;

function distanceXY(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}

function distance3D(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function segmentAngleFromHorizontalDeg(start: Vec3, end: Vec3): number {
    const horizontal = distanceXY(start, end);
    const verticalDrop = start.z - end.z;
    if (verticalDrop <= 0) return -Infinity;
    return Math.atan2(verticalDrop, Math.max(horizontal, 0.0001)) * (180 / Math.PI);
}

function segmentSatisfiesMinAngle(start: Vec3, end: Vec3, minAngleDeg: number): boolean {
    return segmentAngleFromHorizontalDeg(start, end) >= minAngleDeg;
}

function positionKey(pos: Vec3): string {
    const qx = Math.round(pos.x / POSITION_KEY_MM);
    const qy = Math.round(pos.y / POSITION_KEY_MM);
    const qz = Math.round(pos.z / POSITION_KEY_MM);
    return `${qx},${qy},${qz}`;
}

function queueSortValue(node: QueuedNode): number {
    return node.joints.length * 100000 + node.score;
}

function buildCandidateNodes(args: {
    current: SearchNode;
    socketPos: Vec3;
    blockPoint: Vec3;
    rootTopZ: number;
    mesh: THREE.Mesh;
    collisionRadius: number;
    minAngleDeg: number;
    maxTotalLateralMm: number;
}): CandidateNode[] {
    const { current, socketPos, blockPoint, rootTopZ, mesh, collisionRadius, minAngleDeg, maxTotalLateralMm } = args;
    const candidates: CandidateNode[] = [];
    const seen = new Set<string>();
    const anchorPoints: Vec3[] = [current.pos];

    if (distanceXY(current.pos, blockPoint) > 0.25 || Math.abs(current.pos.z - blockPoint.z) > 0.25) {
        anchorPoints.push(blockPoint);
    }

    for (const anchor of anchorPoints) {
        for (const radius of SEARCH_RADII_MM) {
            const requiredDrop = radius * Math.tan((minAngleDeg * Math.PI) / 180);

            for (const drop of SEARCH_DROPS_MM) {
                const targetDrop = Math.max(drop, requiredDrop);
                const nextZ = current.pos.z - targetDrop;

                if (nextZ <= rootTopZ + 0.25) continue;

                for (let angleIdx = 0; angleIdx < SEARCH_ANGLES; angleIdx++) {
                    const angleRad = (angleIdx / SEARCH_ANGLES) * Math.PI * 2;
                    const candidate: Vec3 = {
                        x: anchor.x + Math.cos(angleRad) * radius,
                        y: anchor.y + Math.sin(angleRad) * radius,
                        z: nextZ,
                    };

                    const key = positionKey(candidate);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    if (distance3D(current.pos, candidate) < MIN_SEGMENT_LENGTH_MM) continue;
                    if (!segmentSatisfiesMinAngle(current.pos, candidate, minAngleDeg)) continue;

                    const lateralFromSocket = distanceXY(socketPos, candidate);
                    if (lateralFromSocket > maxTotalLateralMm) continue;

                    const segmentCollision = checkShaftCollision(current.pos, candidate, collisionRadius, mesh);
                    if (segmentCollision.hit) continue;

                    const rootTopTarget: Vec3 = { x: candidate.x, y: candidate.y, z: rootTopZ };
                    const descentCollision = checkShaftCollision(candidate, rootTopTarget, collisionRadius, mesh);
                    const downwardProgress = descentCollision.point ? Math.max(0, blockPoint.z - descentCollision.point.z) : (candidate.z - rootTopZ + 20);
                    const anchorPenalty = anchor === current.pos ? 0 : 2;
                    const candidateScore =
                        lateralFromSocket * 5 +
                        distance3D(current.pos, candidate) * 0.75 +
                        current.totalLateral * 2 +
                        anchorPenalty -
                        downwardProgress * 1.5;

                    candidates.push({
                        pos: candidate,
                        score: candidateScore,
                    });
                }
            }
        }
    }

    candidates.sort((a, b) => a.score - b.score);
    return candidates;
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
    const collisionRadius = shaftRadius + 0.25;
    const standard = calculateStandardPlacement(input);
    if (standard.error === 'ANGLE_TOO_STEEP') {
        return standard;
    }
    const rootTopZ = input.rootsTopZ;
    const minRoutedTrunkAngleDeg = settings.grid.minRoutedTrunkAngleDeg;
    const maxTotalLateralMm = Math.max(18, settings.grid.spacingMm * 5);
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

    const tryDirectDescent = (node: SearchNode): TrunkPlacementResult | null => {
        const targetRootTop: Vec3 = {
            x: node.pos.x,
            y: node.pos.y,
            z: rootTopZ,
        };

        if (!segmentSatisfiesMinAngle(node.pos, targetRootTop, minRoutedTrunkAngleDeg)) {
            return null;
        }

        const collision = checkShaftCollision(node.pos, targetRootTop, collisionRadius, mesh);
        if (collision.hit) return null;

        return {
            socketPos: standard.socketPos,
            joints: node.joints,
            basePos: {
                x: node.pos.x,
                y: node.pos.y,
                z: 0,
            },
            warning: standard.warning,
            angle: standard.angle,
            coneAxis: standard.coneAxis
        };
    };

    const searchRoute = (): TrunkPlacementResult | null => {
        const start: QueuedNode = {
            pos: standard.socketPos,
            joints: [],
            totalLength: 0,
            totalLateral: 0,
            score: 0,
        };

        const queue: QueuedNode[] = [start];
        const bestCostByKey = new Map<string, number>();

        while (queue.length > 0) {
            queue.sort((a, b) => queueSortValue(a) - queueSortValue(b));
            const current = queue.shift()!;
            const directResult = tryDirectDescent(current);
            if (directResult) {
                return directResult;
            }

            if (current.joints.length >= MAX_INTERNAL_JOINTS) {
                continue;
            }

            const blockedTarget: Vec3 = {
                x: current.pos.x,
                y: current.pos.y,
                z: rootTopZ,
            };
            const blockCollision = checkShaftCollision(current.pos, blockedTarget, collisionRadius, mesh);
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
                minAngleDeg: minRoutedTrunkAngleDeg,
                maxTotalLateralMm,
            });

            for (let i = nextCandidates.length - 1; i >= 0; i--) {
                const candidate = nextCandidates[i];
                const nextJoints = [...current.joints, candidate.pos];
                const key = positionKey(candidate.pos);
                const nextScore =
                    candidate.score +
                    current.totalLength * 0.5 +
                    nextJoints.length * 1000;
                const bestCost = bestCostByKey.get(key);
                if (bestCost != null && bestCost <= nextScore) {
                    continue;
                }

                bestCostByKey.set(key, nextScore);
                queue.push({
                    pos: candidate.pos,
                    joints: nextJoints,
                    totalLength: current.totalLength + distance3D(current.pos, candidate.pos),
                    totalLateral: current.totalLateral + distanceXY(current.pos, candidate.pos),
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
