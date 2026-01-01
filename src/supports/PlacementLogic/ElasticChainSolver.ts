import { Vec3 } from '../types';
import * as THREE from 'three';

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

/**
 * Solves the "Elastic Chain" behavior.
 * 
 * When a knot moves up:
 * - UPWARD segments (joint above base): Push joint up to maintain max angle
 * - DOWNWARD segments (joint below base): Limit knot movement to prevent exceeding max angle
 * 
 * @param targetKnotPos The proposed position of the knot (from mouse drag)
 * @param initialState The captured state of the branch at drag start
 * @param maxAngleDeg Max angle from vertical (e.g. 80 degrees)
 */
export function solveElasticChain(
    targetKnotPos: Vec3,
    initialState: ElasticChainInitialState,
    maxAngleDeg: number
): ElasticChainResult {

    let currentBasePos = new THREE.Vector3(targetKnotPos.x, targetKnotPos.y, targetKnotPos.z);
    const newJointPositions: Record<string, Vec3> = {};
    let currentPos = currentBasePos.clone();
    let constraintViolated = false;

    const maxAngleRad = THREE.MathUtils.degToRad(maxAngleDeg);

    // Track INITIAL positions to determine original segment topology
    let initialPrevPos = new THREE.Vector3(
        initialState.knotPos.x,
        initialState.knotPos.y,
        initialState.knotPos.z
    );

    // First, check if we need to limit the knot position based on DOWNWARD segments
    // For downward segments, the knot can't go higher than a certain point
    let maxKnotZ = Infinity;

    for (const joint of initialState.joints) {
        const initialJointPos = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);
        const wasOriginallyAbove = initialJointPos.z > initialPrevPos.z;

        if (!wasOriginallyAbove) {
            // DOWNWARD segment: joint is below previous point
            // The knot (or previous point) can't go so high that angle exceeds limit
            const hDist = Math.sqrt(
                Math.pow(initialJointPos.x - initialState.knotPos.x, 2) +
                Math.pow(initialJointPos.y - initialState.knotPos.y, 2)
            );

            // Max vertical distance for max angle: tan(maxAngle) = hDist / vDist
            // vDist = hDist / tan(maxAngle)
            const minVDist = hDist / Math.tan(maxAngleRad);

            // For downward segment (joint BELOW knot), knot can be at most this high:
            // knotZ - jointZ >= minVDist
            // knotZ <= jointZ + minVDist... wait no, joint is BELOW
            // The vertical distance is knotZ - jointZ (positive when knot above joint)
            // We need: knotZ - jointZ >= minVDist (to not exceed max angle)
            // So: knotZ <= jointZ + some_max_height... 

            // Actually for a downward segment with max angle from vertical:
            // The angle is atan(hDist / vDist) where vDist = knotZ - jointZ
            // We need angle <= maxAngle
            // tan(angle) = hDist / vDist <= tan(maxAngle)
            // So: hDist / vDist <= tan(maxAngle)
            // vDist >= hDist / tan(maxAngle)
            // knotZ - jointZ >= minVDist
            // knotZ >= jointZ + minVDist

            // This means the knot must stay ABOVE jointZ + minVDist
            // Wait, that's the OPPOSITE of a maximum - it's a MINIMUM
            // If the knot goes DOWN, the angle would become too flat

            // But the user's issue is UPWARD movement causing problems...
            // Let me think again...

            // For a downward segment (joint below knot):
            // - If knot moves UP, vertical distance INCREASES
            // - Larger vertical = SMALLER angle from vertical = BETTER
            // - If knot moves DOWN toward joint, vertical decreases
            // - Smaller vertical = LARGER angle = BAD

            // So for downward segments, moving the knot UP is fine!
            // The problem must be elsewhere...

            // Wait - but in the IMAGE, the first segment is nearly HORIZONTAL
            // That means the angle FROM VERTICAL is close to 90 degrees
            // If max angle is 80 degrees, that's a violation

            // The issue is: the JOINT is being pushed up by elastic chain logic
            // Oh wait, no - for a DOWNWARD segment, joints DON'T get pushed
            // So the joint stays in place while the knot moves up
            // Eventually the knot reaches the same Z as the joint, making it HORIZONTAL

            // We need to prevent the knot from getting TOO CLOSE in Z to the joint
            // For downward segment: knotZ - jointZ >= minVDist
            // So: knotZ >= jointZ + minVDist
            // This is a MINIMUM knotZ, not maximum

            // Hmm, but the user wants to move UP and hit a limit
            // The limit should be when the segment becomes horizontal (90 deg)
            // But max angle is 80 deg, so limit is when angle reaches 80 deg

            // Wait, I had this backwards. Let me reconsider:
            // - Initial: knot at Z=5, joint at Z=3 (downward segment)
            // - Knot moves UP to Z=10: vertical = 10-3 = 7, angle is atan(hDist/7) = small angle (good)
            // - Knot moves UP MORE to Z=15: vertical = 15-3 = 12, angle is atan(hDist/12) = even smaller (better)

            // So moving UP never makes a downward segment violate... unless...

            // OH! I think I misunderstood the segment direction!
            // Looking at the screenshot: Knot is on the RIGHT (on the trunk), Joint is on the LEFT
            // The joint is at approximately the SAME Z level as the knot
            // The segment is nearly HORIZONTAL

            // So this is NOT a "downward" segment in terms of Z!
            // It's a segment where the joint's Z is GREATER than or EQUAL to the knot's Z
            // Let me check the wasOriginallyAbove logic...
        }

        initialPrevPos = initialJointPos; // Move to next segment's base
    }

    // 1. Forward Pass: Push joints UP to maintain angle constraint
    const chainPoints: THREE.Vector3[] = [];
    const wasAboveFlags: boolean[] = [];

    initialPrevPos = new THREE.Vector3(
        initialState.knotPos.x,
        initialState.knotPos.y,
        initialState.knotPos.z
    );
    currentPos = currentBasePos.clone();

    for (const joint of initialState.joints) {
        const initialJointPos = new THREE.Vector3(joint.pos.x, joint.pos.y, joint.pos.z);

        // Horizontal distance is FIXED - use INITIAL positions, not current moving position
        // The knot slides along the shaft (Z changes), but the horizontal distance to each joint is invariant
        const hDist = Math.sqrt(
            Math.pow(initialJointPos.x - initialPrevPos.x, 2) +
            Math.pow(initialJointPos.y - initialPrevPos.y, 2)
        );

        // Minimum vertical distance to satisfy angle constraint
        const minVDist = hDist / Math.tan(maxAngleRad);

        // Determine ORIGINAL topology: Was joint above or below in the INITIAL state?
        const wasOriginallyAbove = initialJointPos.z > initialPrevPos.z;
        wasAboveFlags.push(wasOriginallyAbove);

        let finalZ: number;

        if (wasOriginallyAbove) {
            // UPWARD segment: need to push joint UP to maintain angle
            const requiredZ = currentPos.z + minVDist;
            finalZ = Math.max(initialJointPos.z, requiredZ);

            console.log('[ElasticChain] UPWARD segment check:', {
                jointId: joint.id.slice(0, 8),
                currentBaseZ: currentPos.z.toFixed(2),
                jointInitialZ: initialJointPos.z.toFixed(2),
                hDist: hDist.toFixed(2),
                minVDist: minVDist.toFixed(2),
                requiredZ: requiredZ.toFixed(2),
                finalZ: finalZ.toFixed(2),
                pushed: finalZ > initialJointPos.z
            });
        } else {
            // DOWNWARD segment (or same level): 
            // Joint is at or below the base. As base moves up, angle improves.
            // BUT we need to check if the base has moved so high that the angle is violated!

            // Check: is the current angle valid?
            const vDist = Math.abs(currentPos.z - initialJointPos.z);

            if (hDist > 0.001 && vDist < minVDist) {
                // ANGLE EXCEEDED! The knot is too close in Z to the joint
                // We need to limit the knot position
                constraintViolated = true;

                // Calculate the minimum Z distance the knot needs to be from this joint
                // For segment going DOWN from knot: knotZ - jointZ >= minVDist
                // So: knotZ >= jointZ + minVDist
                // But we're setting a MAX for knotZ because we're moving up and hit a limit
                // Actually if joint is BELOW knot, knot moving up INCREASES vDist (good)
                // If joint is ABOVE knot (wasOriginallyAbove=false but now joint is above)...

                // This is getting complex. Let me simplify:
                // If after moving, the angle is violated, clamp the knot
                const clampedKnotZ = initialJointPos.z + (currentPos.z > initialJointPos.z ? minVDist : -minVDist);
                maxKnotZ = Math.min(maxKnotZ, clampedKnotZ);

                console.log('[ElasticChain] Downward segment angle exceeded!', {
                    jointZ: initialJointPos.z.toFixed(2),
                    knotZ: currentPos.z.toFixed(2),
                    hDist: hDist.toFixed(2),
                    minVDist: minVDist.toFixed(2),
                    actualVDist: vDist.toFixed(2),
                    clampedKnotZ: clampedKnotZ.toFixed(2)
                });
            }

            finalZ = initialJointPos.z; // Joint doesn't move for downward segments
        }

        // Store computed position
        const finalPos = new THREE.Vector3(initialJointPos.x, initialJointPos.y, finalZ);
        newJointPositions[joint.id] = { x: finalPos.x, y: finalPos.y, z: finalPos.z };
        chainPoints.push(finalPos);

        // Update for next iteration
        currentPos = finalPos;
        initialPrevPos = initialJointPos;
    }

    // Apply max knot Z constraint if violated
    if (maxKnotZ < Infinity && currentBasePos.z > maxKnotZ) {
        currentBasePos.z = maxKnotZ;
        constraintViolated = true;
    }

    // 2. Fixed Tip/Socket Check  
    if (initialState.contactCone) {
        const socketPos = new THREE.Vector3(
            initialState.contactCone.pos.x,
            initialState.contactCone.pos.y,
            initialState.contactCone.pos.z
        );

        // Last point in the chain (or knot if no joints)
        const lastPoint = chainPoints.length > 0 ? chainPoints[chainPoints.length - 1] : currentBasePos;

        // Get the ORIGINAL last joint position to determine original topology
        const originalLastJointZ = chainPoints.length > 0
            ? initialState.joints[initialState.joints.length - 1].pos.z
            : initialState.knotPos.z;
        const wasSocketOriginallyAbove = socketPos.z > originalLastJointZ;

        // TOPOLOGY CHECK: Prevent joints from crossing over the socket
        // If socket was originally above last joint, last joint cannot go above socket
        // If socket was originally below last joint, last joint cannot go below socket
        if (wasSocketOriginallyAbove && lastPoint.z > socketPos.z) {
            // Last joint has crossed ABOVE the socket - this inverts the geometry!
            constraintViolated = true;

            // The last joint must stay at or below the socket Z (with some margin for angle)
            const hDistToSocket = Math.sqrt(
                Math.pow(socketPos.x - lastPoint.x, 2) +
                Math.pow(socketPos.y - lastPoint.y, 2)
            );
            const minVDistToSocket = hDistToSocket / Math.tan(maxAngleRad);
            const maxLastJointZ = socketPos.z - minVDistToSocket;

            console.log('[ElasticChain] TOPOLOGY VIOLATION - joint crossed above socket:', {
                socketZ: socketPos.z.toFixed(2),
                lastJointZ: lastPoint.z.toFixed(2),
                maxAllowedZ: maxLastJointZ.toFixed(2)
            });

            // Back-propagate constraint down the chain
            let allowedZ = maxLastJointZ;
            for (let i = chainPoints.length - 1; i >= 0; i--) {
                const point = chainPoints[i];
                if (point.z > allowedZ) {
                    point.z = allowedZ;
                    const jointId = initialState.joints[i].id;
                    newJointPositions[jointId].z = allowedZ;
                }

                // Calculate allowed Z for previous joint
                if (i > 0) {
                    const prevPoint = chainPoints[i - 1];
                    const segHDist = Math.sqrt(
                        Math.pow(point.x - prevPoint.x, 2) +
                        Math.pow(point.y - prevPoint.y, 2)
                    );
                    const segMinV = segHDist / Math.tan(maxAngleRad);
                    allowedZ = point.z - segMinV;
                } else {
                    // First segment: from Knot to first joint
                    const initialKnotPos = new THREE.Vector3(
                        initialState.knotPos.x,
                        initialState.knotPos.y,
                        initialState.knotPos.z
                    );
                    const segHDist = Math.sqrt(
                        Math.pow(point.x - initialKnotPos.x, 2) +
                        Math.pow(point.y - initialKnotPos.y, 2)
                    );
                    const segMinV = segHDist / Math.tan(maxAngleRad);
                    allowedZ = point.z - segMinV;
                }
            }

            // Clamp knot if needed
            if (currentBasePos.z > allowedZ) {
                currentBasePos.z = allowedZ;
            }
        }

        // Horizontal distance from last point to fixed socket
        const hDistToSocket = Math.sqrt(
            Math.pow(socketPos.x - lastPoint.x, 2) +
            Math.pow(socketPos.y - lastPoint.y, 2)
        );

        // Check angle constraint for socket segment
        const minVDistToSocket = hDistToSocket / Math.tan(maxAngleRad);
        const actualVDist = Math.abs(socketPos.z - lastPoint.z);

        // Log socket constraint check
        console.log('[ElasticChain] Socket constraint check:', {
            socketZ: socketPos.z.toFixed(2),
            lastJointZ: lastPoint.z.toFixed(2),
            hDistToSocket: hDistToSocket.toFixed(2),
            minVDistToSocket: minVDistToSocket.toFixed(2),
            actualVDist: actualVDist.toFixed(2),
            violated: actualVDist < minVDistToSocket - 0.001,
            hasContactCone: !!initialState.contactCone,
            wasSocketOriginallyAbove
        });

        if (actualVDist < minVDistToSocket - 0.001) {
            constraintViolated = true;

            const isSocketAbove = socketPos.z > lastPoint.z;
            const maxLastZ = isSocketAbove
                ? socketPos.z - minVDistToSocket
                : socketPos.z + minVDistToSocket;

            let allowedZ = maxLastZ;

            for (let i = chainPoints.length - 1; i >= 0; i--) {
                const point = chainPoints[i];
                const needsClamp = isSocketAbove ? (point.z > allowedZ) : (point.z < allowedZ);

                if (needsClamp) {
                    point.z = allowedZ;
                    const jointId = initialState.joints[i].id;
                    newJointPositions[jointId].z = allowedZ;
                }

                if (i > 0) {
                    const prevPoint = chainPoints[i - 1];
                    const segHDist = Math.sqrt(
                        Math.pow(point.x - prevPoint.x, 2) +
                        Math.pow(point.y - prevPoint.y, 2)
                    );
                    const segMinV = segHDist / Math.tan(maxAngleRad);
                    allowedZ = wasAboveFlags[i] ? point.z - segMinV : point.z + segMinV;
                } else {
                    const segHDist = Math.sqrt(
                        Math.pow(point.x - currentBasePos.x, 2) +
                        Math.pow(point.y - currentBasePos.y, 2)
                    );
                    const segMinV = segHDist / Math.tan(maxAngleRad);
                    allowedZ = wasAboveFlags[0] ? point.z - segMinV : point.z + segMinV;
                }
            }

            // Clamp knot if needed
            if (chainPoints.length === 0) {
                if (isSocketAbove && currentBasePos.z > maxLastZ) {
                    currentBasePos.z = maxLastZ;
                } else if (!isSocketAbove && currentBasePos.z < maxLastZ) {
                    currentBasePos.z = maxLastZ;
                }
            } else {
                const firstSegmentWasUp = wasAboveFlags[0];
                const knotNeedsClamp = firstSegmentWasUp
                    ? (currentBasePos.z > allowedZ)
                    : (currentBasePos.z < allowedZ);
                if (knotNeedsClamp) {
                    currentBasePos.z = allowedZ;
                }
            }
        }
    }

    return {
        knotPos: { x: currentBasePos.x, y: currentBasePos.y, z: currentBasePos.z },
        jointPositions: newJointPositions,
        isLocked: constraintViolated
    };
}
