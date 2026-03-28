import { Vec3 } from '../types';

/**
 * Snapshot of a branch's state before dragging begins.
 * Used to ensure reversibility (elasticity).
 */
export interface ElasticChainInitialState {
    branchId: string;
    knotPos: Vec3; // Initial Knot Position
    joints: { id: string; pos: Vec3 }[]; // Ordered bottom-to-top
    contactCone?: { pos: Vec3 }; // Fixed socket position (where shaft connects)
}

export interface ElasticChainResult {
    knotPos: Vec3;
    jointPositions: Record<string, Vec3>; // JointID -> NewPos
    isLocked: boolean;
}

const EPS = 1e-6;

function toSafeTan(maxAngleDeg: number) {
    const clamped = Math.min(89.999, Math.max(0.001, maxAngleDeg));
    return Math.tan((clamped * Math.PI) / 180);
}

function horizontalDistance(ax: number, ay: number, bx: number, by: number) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
}

function minVerticalDistance(ax: number, ay: number, bx: number, by: number, tanMaxAngle: number) {
    if (tanMaxAngle <= EPS) return Number.POSITIVE_INFINITY;
    const h = horizontalDistance(ax, ay, bx, by);
    if (h <= EPS) return 0;
    return h / tanMaxAngle;
}

/**
 * Fast analytic IK-style solver for the elastic branch chain.
 *
 * Keeps XY fixed per captured chain and solves only Z values using:
 * - a forward pass for upward segments,
 * - optional backward propagation when socket/tip constraints require it.
 */
export function solveElasticChain(
    targetKnotPos: Vec3,
    initialState: ElasticChainInitialState,
    maxAngleDeg: number
): ElasticChainResult {
    const joints = initialState.joints;
    const jointCount = joints.length;
    const tanMaxAngle = toSafeTan(maxAngleDeg);

    // Topology per segment (knot->joint0, joint0->joint1, ...):
    // true = segment originally rose upward, false = segment originally descended/same.
    const segmentOriginallyUp: boolean[] = new Array(jointCount);
    let prevInitZ = initialState.knotPos.z;

    for (let i = 0; i < jointCount; i += 1) {
        const jp = joints[i].pos;
        segmentOriginallyUp[i] = jp.z > prevInitZ;
        prevInitZ = jp.z;
    }

    let isLocked = false;
    const solvedJointZ = new Array<number>(jointCount);

    // Forward analytic IK pass:
    // - Upward segments can push joints up as knot rises.
    // - Downward segments remain anchored in Z in this pass.
    let baseX = targetKnotPos.x;
    let baseY = targetKnotPos.y;
    let baseZ = targetKnotPos.z;

    for (let i = 0; i < jointCount; i += 1) {
        const jp = joints[i].pos;
        const minVDist = minVerticalDistance(baseX, baseY, jp.x, jp.y, tanMaxAngle);

        let nextZ = jp.z;
        if (segmentOriginallyUp[i]) {
            const required = baseZ + minVDist;
            if (required > nextZ + EPS) {
                nextZ = required;
                isLocked = true;
            }
        }

        solvedJointZ[i] = nextZ;
        baseX = jp.x;
        baseY = jp.y;
        baseZ = nextZ;
    }

    let finalKnotZ = targetKnotPos.z;

    // Backward propagation utility used when the tip/socket imposes a hard bound.
    const propagateFromLast = (forcedLastZ: number) => {
        if (jointCount === 0) {
            if (Math.abs(finalKnotZ - forcedLastZ) > EPS) {
                finalKnotZ = forcedLastZ;
                isLocked = true;
            }
            return;
        }

        if (Math.abs(solvedJointZ[jointCount - 1] - forcedLastZ) > EPS) {
            solvedJointZ[jointCount - 1] = forcedLastZ;
            isLocked = true;
        }

        for (let i = jointCount - 1; i >= 0; i -= 1) {
            const nextX = joints[i].pos.x;
            const nextY = joints[i].pos.y;
            const nextZ = solvedJointZ[i];

            const currentX = i === 0 ? targetKnotPos.x : joints[i - 1].pos.x;
            const currentY = i === 0 ? targetKnotPos.y : joints[i - 1].pos.y;
            let currentZ = i === 0 ? finalKnotZ : solvedJointZ[i - 1];

            const minVDist = minVerticalDistance(currentX, currentY, nextX, nextY, tanMaxAngle);

            if (segmentOriginallyUp[i]) {
                // nextZ must be at least currentZ + minV => currentZ <= nextZ - minV
                const maxCurrentZ = nextZ - minVDist;
                if (currentZ > maxCurrentZ + EPS) {
                    currentZ = maxCurrentZ;
                    isLocked = true;
                }
            } else {
                // nextZ must be at most currentZ - minV => currentZ >= nextZ + minV
                const minCurrentZ = nextZ + minVDist;
                if (currentZ < minCurrentZ - EPS) {
                    currentZ = minCurrentZ;
                    isLocked = true;
                }
            }

            if (i === 0) finalKnotZ = currentZ;
            else solvedJointZ[i - 1] = currentZ;
        }
    };

    // Tip/socket IK bound.
    if (initialState.contactCone) {
        const socket = initialState.contactCone.pos;

        const lastX = jointCount > 0 ? joints[jointCount - 1].pos.x : targetKnotPos.x;
        const lastY = jointCount > 0 ? joints[jointCount - 1].pos.y : targetKnotPos.y;
        const lastZ = jointCount > 0 ? solvedJointZ[jointCount - 1] : finalKnotZ;

        const minVDistToSocket = minVerticalDistance(lastX, lastY, socket.x, socket.y, tanMaxAngle);
        const originalLastZ = jointCount > 0 ? joints[jointCount - 1].pos.z : initialState.knotPos.z;
        const socketOriginallyAbove = socket.z > originalLastZ;

        if (socketOriginallyAbove) {
            const maxLastZ = socket.z - minVDistToSocket;
            if (lastZ > maxLastZ + EPS) {
                propagateFromLast(maxLastZ);
            }
        } else {
            const minLastZ = socket.z + minVDistToSocket;
            if (lastZ < minLastZ - EPS) {
                propagateFromLast(minLastZ);
            }
        }
    }

    const jointPositions: Record<string, Vec3> = {};
    for (let i = 0; i < jointCount; i += 1) {
        const jp = joints[i].pos;
        jointPositions[joints[i].id] = {
            x: jp.x,
            y: jp.y,
            z: solvedJointZ[i],
        };
    }

    return {
        knotPos: { x: targetKnotPos.x, y: targetKnotPos.y, z: finalKnotZ },
        jointPositions,
        isLocked,
    };
}
