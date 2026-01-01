import { Trunk, Branch, Vec3, Roots, Knot } from '../types';
import { getKnotById, getBranches } from '../state';
import { clampShaftAngle } from './ShaftAngleConstraint';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone/contactConeUtils';
import * as THREE from 'three';

/**
 * Solves the position constraints for a moving joint within a support structure.
 * Enforces shaft angle limits relative to connected segments and the contact cone.
 * 
 * @param structure The support structure (Trunk or Branch) containing the joint
 * @param jointId The ID of the joint being moved
 * @param candidatePos The proposed new position for the joint
 * @param maxAngleDeg The maximum allowed angle from vertical (or parent axis)
 * @param root Optional root (if structure is a Trunk)
 * @param parentStartPos Optional explicit start position (e.g. from parent knot)
 * @returns The constrained position
 */
export function solveJointConstraint(
    structure: Trunk | Branch,
    jointId: string,
    candidatePos: Vec3,
    maxAngleDeg: number,
    root?: Roots,
    parentStartPos?: Vec3
): Vec3 {
    let clampedPos = { ...candidatePos };

    // Find connected segments
    const segments = structure.segments;
    const bottomSegIndex = segments.findIndex(s => s.topJoint?.id === jointId);
    const topSegIndex = segments.findIndex(s => s.bottomJoint?.id === jointId);

    // 1. Bottom Constraint (Vector from Below -> Joint)
    // Prevents the segment below the joint from becoming too horizontal or pointing downwards.
    if (bottomSegIndex !== -1) {
        const seg = segments[bottomSegIndex];
        let start: Vec3 | null = null;

        if (seg.bottomJoint) {
            start = seg.bottomJoint.pos;
        } else if (parentStartPos) {
            // Use provided context
            start = parentStartPos;
        } else if (root && bottomSegIndex === 0) {
            // Fallback if root provided but parentStartPos not
            const rPos = root.transform.pos;
            const h = (root.height || 1.5) + 0.5;
            start = { x: rPos.x, y: rPos.y, z: rPos.z + h };
        } else if ('parentKnotId' in structure && bottomSegIndex === 0) {
            // Fallback: Branch with no parentStartPos provided - Try global store lookup
            const branch = structure as Branch;
            const knot = getKnotById(branch.parentKnotId);
            if (knot) {
                start = knot.pos;
            }
        }

        if (start) {
            const res = clampShaftAngle(start, clampedPos, maxAngleDeg, { x: 0, y: 0, z: 1 });
            if (res.isClamped) {
                clampedPos = res.clampedPos;
            }
        }
    }

    // 2. Top Constraint (Vector from Above -> Joint)
    // Prevents the segment above the joint from becoming too horizontal or pointing upwards (relative to the top).
    // We treat the joint as the 'Moving End' relative to the 'Fixed Start' (Above).
    // Vector is (Fixed -> Joint). This should point DOWN. Axis = {0,0,-1}.
    if (topSegIndex !== -1) {
        const seg = segments[topSegIndex];
        let end: Vec3 | null = null; // This is the 'Fixed Start' for our vector

        if (seg.topJoint) {
            end = seg.topJoint.pos;
        } else if (structure.contactCone) {
            // If segment ends at the cone
            const socketPos = getFinalSocketPosition(structure.contactCone);
            end = socketPos;
        }

        if (end) {
            const res = clampShaftAngle(end, clampedPos, maxAngleDeg, { x: 0, y: 0, z: -1 });
            if (res.isClamped) {
                clampedPos = res.clampedPos;
            }
        }
    }

    // 3. Contact Cone Constraint (Socket Joint)
    // If we are moving the joint that connects directly to the Contact Cone,
    // we must ensure the cone itself respects the angle constraint.
    if (structure.contactCone?.socketJointId && structure.contactCone.socketJointId === jointId) {
        // Fixed Point: Tip (Contact Pos)
        // Moving Point: Socket Joint (clampedPos)
        // Vector: Tip -> Socket (Should point DOWN, roughly)
        // Axis: {0,0,-1}
        const tipPos = structure.contactCone.pos;
        const res = clampShaftAngle(tipPos, clampedPos, maxAngleDeg, { x: 0, y: 0, z: -1 });
        if (res.isClamped) {
            clampedPos = res.clampedPos;
        }
    }

    return clampedPos;
}

/**
 * Solves the position constraints for a moving Knot.
 * Ensures that any branches attached to this knot do not exceed the max angle.
 * 
 * @param knot The knot being moved
 * @param candidatePos The proposed new position for the knot (already projected to parent shaft)
 * @param maxAngleDeg The maximum allowed angle
 * @param topologyMap Optional map of BranchID -> 'UP' (Knot Below Joint) or 'DOWN' (Knot Above Joint)
 * @param ignoredBranchIds Optional list of Branch IDs to skip (e.g. handled by ElasticChain solver)
 * @returns The constrained position
 */
export function solveKnotConstraint(
    knot: Knot,
    candidatePos: Vec3,
    maxAngleDeg: number,
    topologyMap?: Record<string, 'UP' | 'DOWN'>,
    ignoredBranchIds?: string[]
): Vec3 {
    let clampedPos = { ...candidatePos };
    const branches = getBranches();

    // Find all branches attached to this knot
    const attachedBranches = branches.filter(b => b.parentKnotId === knot.id);

    for (const branch of attachedBranches) {
        if (ignoredBranchIds?.includes(branch.id)) continue;
        if (branch.segments.length === 0) continue;

        // The branch starts at the Knot and ends at its first joint (or contact socket)
        const firstSeg = branch.segments[0];
        let branchEnd: Vec3 | null = null;

        if (firstSeg.topJoint) {
            branchEnd = firstSeg.topJoint.pos;
        } else if (branch.contactCone) {
            // Branch with single segment ending in cone
            branchEnd = getFinalSocketPosition(branch.contactCone);
        }

        if (!branchEnd) continue;

        // 0. TOPOLOGY LOCK (Prevent Flip-Over)
        if (topologyMap && topologyMap[branch.id]) {
            const initialType = topologyMap[branch.id];

            // Hard Limit at Joint Z-Level (+/- epsilon)
            // If initially UP (Knot Below Joint), Knot must stay Below Joint.
            // If initially DOWN (Knot Above Joint), Knot must stay Above Joint.

            // Note: We use a small epsilon to prevent Z-fighting or precision issues at the boundary.
            const limitZ = branchEnd.z;
            const epsilon = 0.001;

            if (initialType === 'UP') {
                // Knot must be BELOW Joint (z < limitZ)
                if (clampedPos.z >= limitZ - epsilon) {
                    clampedPos.z = limitZ - epsilon;
                }
            } else {
                // Knot must be ABOVE Joint (z > limitZ)
                if (clampedPos.z <= limitZ + epsilon) {
                    clampedPos.z = limitZ + epsilon;
                }
            }
        }

        // Calculate Vector from Joint (Fixed) -> Knot (Moving)
        // We use Joint -> Knot because we want to see where the Knot is relative to the Joint.
        const v = new THREE.Vector3().subVectors(
            new THREE.Vector3(clampedPos.x, clampedPos.y, clampedPos.z),
            new THREE.Vector3(branchEnd.x, branchEnd.y, branchEnd.z)
        );

        const len = v.length();
        if (len < 0.001) continue; // Coincident, ignore

        // Calculate Angle relative to World UP (0,0,1)
        const up = new THREE.Vector3(0, 0, 1);
        const angleRad = v.angleTo(up);
        const angleDeg = THREE.MathUtils.radToDeg(angleRad);

        // Defined Forbidden Zones relative to Vertical:
        // MaxAngle = 80.
        // Valid Up-Pointing Branch (Knot below Joint):
        //    Vector Joint->Knot points DOWN (approx 180 deg).
        //    Valid Range: [180 - MaxAngle, 180] -> [100, 180].
        // Valid Down-Pointing Branch (Knot above Joint):
        //    Vector Joint->Knot points UP (approx 0 deg).
        //    Valid Range: [0, MaxAngle] -> [0, 80].

        // Forbidden Zone: (MaxAngle, 180 - MaxAngle) -> (80, 100).

        const minValid = maxAngleDeg;
        const maxValid = 180 - maxAngleDeg;

        if (angleDeg > minValid && angleDeg < maxValid) {
            // VIOLATION: We are in the horizontal dead zone.
            // Clamp to the NEAREST valid boundary.

            const distToUp = Math.abs(angleDeg - minValid); // Distance to 80
            const distToDown = Math.abs(angleDeg - maxValid); // Distance to 100

            let targetAngleDeg: number;
            let refAxisId: number; // 1 for UP, -1 for DOWN reference logic

            if (topologyMap && topologyMap[branch.id]) {
                // Use Topology to decide direction!
                if (topologyMap[branch.id] === 'DOWN') {
                    // Should act like UP Vector (0..80 range)
                    targetAngleDeg = maxAngleDeg;
                    refAxisId = 1;
                } else {
                    // Should act like DOWN Vector (100..180 range)
                    targetAngleDeg = maxAngleDeg;
                    refAxisId = -1;
                }
            } else {
                // Fallback to proximity if no topology map
                if (distToUp < distToDown) {
                    targetAngleDeg = maxAngleDeg;
                    refAxisId = 1;
                } else {
                    targetAngleDeg = maxAngleDeg;
                    refAxisId = -1;
                }
            }

            const refAxis = { x: 0, y: 0, z: refAxisId };
            const res = clampShaftAngle(branchEnd, clampedPos, maxAngleDeg, refAxis);

            if (res.isClamped) {
                clampedPos = res.clampedPos;
            }
        }
    }

    return clampedPos;
}
