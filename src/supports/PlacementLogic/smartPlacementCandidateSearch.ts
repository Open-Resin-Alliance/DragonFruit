import * as THREE from 'three';
import { Vec3 } from '../types';
import { checkShaftCollision } from './CollisionUtils';
import {
    CandidateNode,
    distance3D,
    distanceXY,
    positionKey,
    SearchNode,
    segmentSatisfiesLengthAwareMaxAngleFromVertical,
} from './smartPlacementSearchUtils';

export interface BuildCandidateNodesArgs {
    current: SearchNode;
    socketPos: Vec3;
    blockPoint: Vec3;
    rootTopZ: number;
    mesh: THREE.Mesh;
    collisionRadius: number;
    minAngleDeg: number;
    maxTotalLateralMm: number;
    searchRadiiMm: number[];
    searchDropsMm: number[];
    searchAngles: number;
    minSegmentLengthMm: number;
    raycaster?: THREE.Raycaster;
}

export function buildCandidateNodes(args: BuildCandidateNodesArgs): CandidateNode[] {
    const {
        current,
        socketPos,
        blockPoint,
        rootTopZ,
        mesh,
        collisionRadius,
        minAngleDeg,
        maxTotalLateralMm,
        searchRadiiMm,
        searchDropsMm,
        searchAngles,
        minSegmentLengthMm,
        raycaster,
    } = args;

    const candidates: CandidateNode[] = [];
    const seen = new Set<string>();
    const anchorPoints: Vec3[] = [current.pos];
    const minAngleRad = (minAngleDeg * Math.PI) / 180;
    const tanMinAngle = Math.tan(minAngleRad);
    const angleCount = Math.max(1, Math.floor(searchAngles));
    const angularDirections: Array<{ x: number; y: number }> = new Array(angleCount);

    for (let angleIdx = 0; angleIdx < angleCount; angleIdx += 1) {
        const angleRad = (angleIdx / angleCount) * Math.PI * 2;
        angularDirections[angleIdx] = {
            x: Math.cos(angleRad),
            y: Math.sin(angleRad),
        };
    }

    if (distanceXY(current.pos, blockPoint) > 0.25 || Math.abs(current.pos.z - blockPoint.z) > 0.25) {
        anchorPoints.push(blockPoint);
    }

    for (let anchorIndex = 0; anchorIndex < anchorPoints.length; anchorIndex += 1) {
        const anchor = anchorPoints[anchorIndex];
        const anchorPenalty = anchorIndex === 0 ? 0 : 2;
        for (const radius of searchRadiiMm) {
            const requiredDrop = radius * tanMinAngle;

            for (const drop of searchDropsMm) {
                const targetDrop = Math.max(drop, requiredDrop);
                const nextZ = current.pos.z - targetDrop;

                if (nextZ <= rootTopZ + 0.25) continue;

                for (let angleIdx = 0; angleIdx < angleCount; angleIdx += 1) {
                    const dir = angularDirections[angleIdx];
                    const candidate: Vec3 = {
                        x: anchor.x + dir.x * radius,
                        y: anchor.y + dir.y * radius,
                        z: nextZ,
                    };

                    const key = positionKey(candidate);
                    if (seen.has(key)) continue;
                    seen.add(key);

                    if (distance3D(current.pos, candidate) < minSegmentLengthMm) continue;
                    if (!segmentSatisfiesLengthAwareMaxAngleFromVertical(current.pos, candidate, 90 - minAngleDeg)) continue;

                    const lateralFromSocket = distanceXY(socketPos, candidate);
                    if (lateralFromSocket > maxTotalLateralMm) continue;

                    const segmentCollision = checkShaftCollision(current.pos, candidate, collisionRadius, mesh, raycaster);
                    if (segmentCollision.hit) continue;

                    const rootTopTarget: Vec3 = { x: candidate.x, y: candidate.y, z: rootTopZ };
                    const descentCollision = checkShaftCollision(candidate, rootTopTarget, collisionRadius, mesh, raycaster);
                    const downwardProgress = descentCollision.point ? Math.max(0, blockPoint.z - descentCollision.point.z) : (candidate.z - rootTopZ + 20);
                    const candidateScore =
                        lateralFromSocket * 8 +
                        distance3D(current.pos, candidate) * 1.5 +
                        current.totalLateral * 5 +
                        anchorPenalty -
                        downwardProgress * 1.25;

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
