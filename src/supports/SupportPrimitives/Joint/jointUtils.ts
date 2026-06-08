import { Trunk, Branch, Twig, Stick, Segment, Joint, Vec3, Roots, Knot, BezierSegment } from '../../types';
import * as THREE from 'three';
import { getSocketPosition, getFinalSocketPosition } from '../ContactCone';
import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import { getJointDiameter } from '../../constants';
import { getBezierPointAtT, toVector3, subdivideCubicBezier, toVec3 } from '../../Curves/BezierUtils';
import { getKnotById } from '../../state';
import { solveJointConstraint } from '../../PlacementLogic/JointConstraintSolver';

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

/**
 * Splits a trunk shaft segment by inserting a new joint.
 * 
 * @param trunk The trunk to modify
 * @param segmentId The ID of the segment to split
 * @param splitPoint The 3D position where the joint should be created
 * @param splitT The parameter t along the curve where the split occurs (required for Bezier preservation)
 * @param root The root of the trunk (required to determine start position)
 * @returns A new Trunk object with the split segment
 */
export function splitShaft(
    trunk: Trunk,
    segmentId: string,
    splitPoint: Vec3,
    splitT?: number,
    root?: Roots
): Trunk {
    // 1. Find segment index
    const segIndex = trunk.segments.findIndex(s => s.id === segmentId);
    if (segIndex === -1) {
        console.warn('[JointUtils] Segment not found:', segmentId);
        return trunk;
    }

    const originalSegment = trunk.segments[segIndex];

    // 2. Create new Joint
    const joint: Joint = {
        id: uuid(),
        pos: splitPoint,
        diameter: getJointDiameter(originalSegment.diameter)
    };

    let bottomSegment: Segment;
    let topSegment: Segment;

    if (originalSegment.type === 'bezier' && splitT !== undefined && root) {
        // Bezier Subdivision (Exact Geometry Preservation)

        // Find Start Point
        let startPos: Vec3;
        if (originalSegment.bottomJoint) {
            startPos = originalSegment.bottomJoint.pos;
        } else if (segIndex === 0) {
            const rPos = root.transform.pos;
            const startZ = rPos.z + root.diskHeight + root.coneHeight;
            startPos = { x: rPos.x, y: rPos.y, z: startZ };
        } else {
            const prev = trunk.segments[segIndex - 1];
            startPos = prev.topJoint!.pos;
        }

        // Find End Point
        let endPos: Vec3;
        if (originalSegment.topJoint) {
            endPos = originalSegment.topJoint.pos;
        } else if (trunk.contactCone) {
            endPos = getFinalSocketPosition(trunk.contactCone);
        } else {
            endPos = { x: startPos.x, y: startPos.y, z: startPos.z + 10 }; // Fallback
        }

        const [leftCurve, rightCurve] = subdivideCubicBezier(
            startPos,
            originalSegment.controlPoint1,
            originalSegment.controlPoint2,
            endPos,
            splitT
        );

        // leftCurve = [p0, p1, p2, p3] (p0=start, p3=split)
        // rightCurve = [p0, p1, p2, p3] (p0=split, p3=end)

        // Bottom (Left)
        bottomSegment = {
            ...originalSegment,
            id: originalSegment.id,
            topJoint: joint,
            // bottomJoint preserved
            controlPoint1: leftCurve[1],
            controlPoint2: leftCurve[2],
            // startTangent is v1-v0? No, we store tangents as vectors.
            // We should update tangents? Or do renderers use CP directly?
            // The type defines CP1, CP2. Tangents are usually derived or auxiliary.
            // Let's ensure we don't break tangent continuity logic later.
            // Tangent at split point = derivative.
            // Left End Tangent = (p3 - p2) normalized
            // Right Start Tangent = (p1 - p0) normalized (of right curve)
            // They should be opposite?
            // Wait, renderer uses CP. curveUtils uses Tangents to *derive* CP.
            // If we set CP directly, curveUtils might overwrite them if we call `updateCurves` later.
            // But we are preserving geometry here.
            // Let's just set CPs.
        } as BezierSegment;

        // Top (Right)
        topSegment = {
            ...originalSegment,
            id: uuid(),
            bottomJoint: joint,
            topJoint: originalSegment.topJoint,
            controlPoint1: rightCurve[1],
            controlPoint2: rightCurve[2]
        } as BezierSegment;

    } else {
        // Linear Split (Original Logic)
        bottomSegment = {
            ...originalSegment,
            id: originalSegment.id, // Keep original ID for the bottom part usually
            topJoint: joint
            // bottomJoint: originalSegment.bottomJoint (preserved)
        };

        topSegment = {
            ...originalSegment,
            id: uuid(),
            bottomJoint: joint,
            topJoint: originalSegment.topJoint
        };
    }

    // 4. Construct new segments array
    const newSegments = [
        ...trunk.segments.slice(0, segIndex),
        bottomSegment,
        topSegment,
        ...trunk.segments.slice(segIndex + 1)
    ];

    return {
        ...trunk,
        segments: newSegments
    };
}


/**
 * Splits a branch shaft segment by inserting a new joint.
 * Identical to splitShaft but for branches (which start at a knot instead of roots).
 */
export function splitBranchShaft(
    branch: Branch,
    segmentId: string,
    splitPoint: Vec3,
    splitT?: number,
    parentKnot?: Knot
): Branch {
    // 1. Find segment index
    const segIndex = branch.segments.findIndex(s => s.id === segmentId);
    if (segIndex === -1) {
        console.warn('[JointUtils] Segment not found in branch:', segmentId);
        return branch;
    }

    const originalSegment = branch.segments[segIndex];

    // 2. Create new Joint
    const joint: Joint = {
        id: uuid(),
        pos: splitPoint,
        diameter: getJointDiameter(originalSegment.diameter)
    };

    let bottomSegment: Segment;
    let topSegment: Segment;

    if (originalSegment.type === 'bezier' && splitT !== undefined && parentKnot) {
        // Bezier Subdivision (Exact Geometry Preservation)

        // Find Start Point
        let startPos: Vec3;
        if (segIndex === 0) {
            startPos = parentKnot.pos;
        } else {
            const prev = branch.segments[segIndex - 1];
            startPos = prev.topJoint!.pos;
        }

        // Find End Point
        let endPos: Vec3;
        if (originalSegment.topJoint) {
            endPos = originalSegment.topJoint.pos;
        } else if (branch.contactCone) {
            endPos = getFinalSocketPosition(branch.contactCone);
        } else {
            endPos = { x: startPos.x, y: startPos.y, z: startPos.z + 5 };
        }

        const [leftCurve, rightCurve] = subdivideCubicBezier(
            startPos,
            originalSegment.controlPoint1,
            originalSegment.controlPoint2,
            endPos,
            splitT
        );

        bottomSegment = {
            ...originalSegment,
            id: originalSegment.id,
            topJoint: joint,
            controlPoint1: leftCurve[1],
            controlPoint2: leftCurve[2],
        } as BezierSegment;

        topSegment = {
            ...originalSegment,
            id: uuid(),
            bottomJoint: joint,
            topJoint: originalSegment.topJoint,
            controlPoint1: rightCurve[1],
            controlPoint2: rightCurve[2]
        } as BezierSegment;

    } else {
        // Linear Split
        bottomSegment = {
            ...originalSegment,
            id: originalSegment.id,
            topJoint: joint
        };

        topSegment = {
            ...originalSegment,
            id: uuid(),
            bottomJoint: joint,
            topJoint: originalSegment.topJoint
        };
    }

    // 4. Construct new segments array
    const newSegments = [
        ...branch.segments.slice(0, segIndex),
        bottomSegment,
        topSegment,
        ...branch.segments.slice(segIndex + 1)
    ];

    return {
        ...branch,
        segments: newSegments
    };
}

 export function splitTwigShaft(
     twig: Twig,
     segmentId: string,
     splitPoint: Vec3,
     splitT?: number,
 ): Twig {
     const segIndex = twig.segments.findIndex((s: Segment) => s.id === segmentId);
     if (segIndex === -1) {
         console.warn('[JointUtils] Segment not found in twig:', segmentId);
         return twig;
     }

     const originalSegment = twig.segments[segIndex];

     const joint: Joint = {
         id: uuid(),
         pos: splitPoint,
         diameter: getJointDiameter(originalSegment.diameter)
     };

     let bottomSegment: Segment;
     let topSegment: Segment;

     if (originalSegment.type === 'bezier' && splitT !== undefined) {
         let startPos: Vec3;
         if (segIndex === 0) {
             startPos = originalSegment.bottomJoint?.pos ?? splitPoint;
         } else {
             const prev = twig.segments[segIndex - 1];
             startPos = prev.topJoint?.pos ?? splitPoint;
         }

         const endPos: Vec3 = originalSegment.topJoint?.pos ?? { x: startPos.x, y: startPos.y, z: startPos.z + 5 };

         const [leftCurve, rightCurve] = subdivideCubicBezier(
             startPos,
             originalSegment.controlPoint1,
             originalSegment.controlPoint2,
             endPos,
             splitT
         );

         bottomSegment = {
             ...originalSegment,
             id: originalSegment.id,
             topJoint: joint,
             controlPoint1: leftCurve[1],
             controlPoint2: leftCurve[2],
         } as BezierSegment;

         topSegment = {
             ...originalSegment,
             id: uuid(),
             bottomJoint: joint,
             topJoint: originalSegment.topJoint,
             controlPoint1: rightCurve[1],
             controlPoint2: rightCurve[2]
         } as BezierSegment;
     } else {
         bottomSegment = {
             ...originalSegment,
             id: originalSegment.id,
             topJoint: joint
         };

         topSegment = {
             ...originalSegment,
             id: uuid(),
             bottomJoint: joint,
             topJoint: originalSegment.topJoint
         };
     }

     const newSegments = [
         ...twig.segments.slice(0, segIndex),
         bottomSegment,
         topSegment,
         ...twig.segments.slice(segIndex + 1)
     ];

     return {
         ...twig,
         segments: newSegments
     };
 }

 export function splitStickShaft(
     stick: Stick,
     segmentId: string,
     splitPoint: Vec3,
     splitT?: number,
 ): Stick {
     const segIndex = stick.segments.findIndex((s: Segment) => s.id === segmentId);
     if (segIndex === -1) {
         console.warn('[JointUtils] Segment not found in stick:', segmentId);
         return stick;
     }

     const originalSegment = stick.segments[segIndex];

     const joint: Joint = {
         id: uuid(),
         pos: splitPoint,
         diameter: getJointDiameter(originalSegment.diameter)
     };

     let bottomSegment: Segment;
     let topSegment: Segment;

     if (originalSegment.type === 'bezier' && splitT !== undefined) {
         let startPos: Vec3;
         if (segIndex === 0) {
             startPos = originalSegment.bottomJoint?.pos ?? splitPoint;
         } else {
             const prev = stick.segments[segIndex - 1];
             startPos = prev.topJoint?.pos ?? splitPoint;
         }

         const endPos: Vec3 = originalSegment.topJoint?.pos ?? { x: startPos.x, y: startPos.y, z: startPos.z + 5 };

         const [leftCurve, rightCurve] = subdivideCubicBezier(
             startPos,
             originalSegment.controlPoint1,
             originalSegment.controlPoint2,
             endPos,
             splitT
         );

         bottomSegment = {
             ...originalSegment,
             id: originalSegment.id,
             topJoint: joint,
             controlPoint1: leftCurve[1],
             controlPoint2: leftCurve[2],
         } as BezierSegment;

         topSegment = {
             ...originalSegment,
             id: uuid(),
             bottomJoint: joint,
             topJoint: originalSegment.topJoint,
             controlPoint1: rightCurve[1],
             controlPoint2: rightCurve[2]
         } as BezierSegment;
     } else {
         bottomSegment = {
             ...originalSegment,
             id: originalSegment.id,
             topJoint: joint
         };

         topSegment = {
             ...originalSegment,
             id: uuid(),
             bottomJoint: joint,
             topJoint: originalSegment.topJoint
         };
     }

     const newSegments = [
         ...stick.segments.slice(0, segIndex),
         bottomSegment,
         topSegment,
         ...stick.segments.slice(segIndex + 1)
     ];

     return {
         ...stick,
         segments: newSegments
     };
 }

export function findClosestSegment(trunk: Trunk, root: Roots, point: Vec3): { segment: Segment, t: number, pointOnLine: Vec3 } | null {
    // Reconstruct skeleton start
    const startZOffset = root.diskHeight + root.coneHeight;

    let currentStart = new THREE.Vector3(root.transform.pos.x, root.transform.pos.y, root.transform.pos.z + startZOffset);

    let closestSeg = null;
    let minDist = Infinity;
    let bestT = 0;
    let bestPoint = new THREE.Vector3();

    for (const seg of trunk.segments) {
        let endPoint: THREE.Vector3;
        if (seg.topJoint) {
            endPoint = new THREE.Vector3(seg.topJoint.pos.x, seg.topJoint.pos.y, seg.topJoint.pos.z);
        } else if (trunk.contactCone) {
            const socketPos = getFinalSocketPosition(trunk.contactCone);
            endPoint = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
        } else {
            endPoint = currentStart.clone().add(new THREE.Vector3(0, 0, 10));
        }

        let dist: number;
        let closest = new THREE.Vector3();
        let tVal = 0;

        if (seg.type === 'bezier') {
            // Bezier Segment Projection
            // Approximate by sampling (e.g., 20 steps) or using a robust projector.
            // For snapping, 20-30 steps is plenty fast and accurate enough.

            const STEPS = 30;
            let localMinDist = Infinity;
            let localBestT = 0;
            let localBestPoint = new THREE.Vector3();

            const p0 = { x: currentStart.x, y: currentStart.y, z: currentStart.z };
            const p3 = { x: endPoint.x, y: endPoint.y, z: endPoint.z };

            // Use BezierUtils helper
            for (let i = 0; i <= STEPS; i++) {
                const t = i / STEPS;
                // getBezierPointAtT returns Vec3
                const p = getBezierPointAtT(
                    p0,
                    seg.controlPoint1,
                    seg.controlPoint2,
                    p3,
                    t
                );
                const vP = new THREE.Vector3(p.x, p.y, p.z);
                const d = vP.distanceTo(new THREE.Vector3(point.x, point.y, point.z));
                if (d < localMinDist) {
                    localMinDist = d;
                    localBestT = t;
                    localBestPoint = vP;
                }
            }

            // Refine search around localBestT? optional but good.
            // For now, just use sampled result.
            dist = localMinDist;
            closest.copy(localBestPoint);
            tVal = localBestT;

        } else {
            // Straight Segment Projection (Legacy)
            const line = new THREE.Line3(currentStart, endPoint);
            const pt = new THREE.Vector3(point.x, point.y, point.z);
            line.closestPointToPoint(pt, true, closest);
            dist = pt.distanceTo(closest);
            tVal = currentStart.distanceTo(closest) / currentStart.distanceTo(endPoint);
        }

        if (dist < minDist) {
            minDist = dist;
            closestSeg = seg;
            bestPoint = closest;
            bestT = tVal;
        }

        currentStart = endPoint;
    }

    if (closestSeg) {
        return { segment: closestSeg, t: bestT, pointOnLine: { x: bestPoint.x, y: bestPoint.y, z: bestPoint.z } };
    }
    return null;
}

import { checkShaftCollision } from '../../PlacementLogic/CollisionUtils';
import { calculateSafeOffset } from '../../PlacementLogic/CollisionAvoidance';
import { updateCurvesAtJoint } from '../../Curves/curveUtils';
import { getSettings } from '../../Settings';

import { clampShaftAngle } from '../../PlacementLogic/ShaftAngleConstraint';

/**
 * Updates the position of a joint within a trunk.
 * Handles updating all references to the joint (topJoint/bottomJoint) in connected segments.
 * 
 * @param trunk The trunk containing the joint
 * @param jointId The ID of the joint to move
 * @param newPos The new 3D position
 * @param mesh Optional mesh for collision-based thickness adjustment
 * @param isCurveMode If true, converts connected segments to Bezier curves and maintains C1 continuity
 * @param root Optional root (for bezier updates)
 * @param parentStartPos Optional start position of the parent chain (Root pos or Knot pos) for constraint calculation
 * @returns A new Trunk object with updated joint
 */
export function moveJoint(
    trunk: Trunk,
    jointId: string,
    newPos: Vec3,
    mesh?: THREE.Mesh,
    isCurveMode: boolean = false,
    root?: Roots,
    parentStartPos?: Vec3,
    options?: { skipContactConeSolve?: boolean }
): Trunk {
    const skipContactConeSolve = options?.skipContactConeSolve === true;
    // 0. Apply Shaft Angle Constraints
    const settings = getSettings();
    const maxAngleDeg = settings.shaft.maxAngleDeg ?? 80;

    // Use isolated Constraint Solver
    const clampedPos = solveJointConstraint(
        trunk,
        jointId,
        newPos,
        maxAngleDeg,
        root,
        parentStartPos
    );

    // Update newPos to the clamped result
    newPos = clampedPos;

    // Fast path: if constraint solving snaps to the already-committed joint position,
    // skip all downstream cone/curve work to avoid no-op drag churn.
    let currentJointPos: Vec3 | null = null;
    for (const seg of trunk.segments) {
        if (seg.topJoint?.id === jointId) {
            currentJointPos = seg.topJoint.pos;
            break;
        }
        if (seg.bottomJoint?.id === jointId) {
            currentJointPos = seg.bottomJoint.pos;
            break;
        }
    }

    if (currentJointPos) {
        const dx = currentJointPos.x - newPos.x;
        const dy = currentJointPos.y - newPos.y;
        const dz = currentJointPos.z - newPos.z;
        const samePosEpsSq = 1e-10;
        if ((dx * dx) + (dy * dy) + (dz * dz) <= samePosEpsSq) {
            return trunk;
        }
    }

    // Check if we are moving the Contact Cone's Socket Joint
    let newContactCone = trunk.contactCone;

    if (trunk.contactCone?.socketJointId && trunk.contactCone.socketJointId === jointId) {
        const contactPos = new THREE.Vector3(trunk.contactCone.pos.x, trunk.contactCone.pos.y, trunk.contactCone.pos.z);
        const socketPos = new THREE.Vector3(newPos.x, newPos.y, newPos.z);

        if (skipContactConeSolve) {
            const axis = new THREE.Vector3().subVectors(socketPos, contactPos);
            const axisLen = axis.length();
            if (axisLen > 0.001) {
                axis.normalize();
                newContactCone = {
                    ...trunk.contactCone,
                    normal: { x: axis.x, y: axis.y, z: axis.z },
                    diskLengthOverride: undefined,
                    profile: {
                        ...trunk.contactCone.profile,
                        lengthMm: Math.max(0.1, axisLen),
                    },
                };
            }
        } else {

        // 1. Calculate Vector from Contact (Surface) -> New Socket Position
        const toSocket = new THREE.Vector3().subVectors(socketPos, contactPos);
        const totalDistanceToSocket = toSocket.length();

        if (totalDistanceToSocket > 0.001) {
            // ITERATIVE SOLVER for Disk Thickness & Cone Normal
            // Circular Dependency: Thickness -> StartPos -> Normal -> Thickness
            // We iterate to converge on a stable Normal that produces the matching Thickness.

            const surfaceNormal = trunk.contactCone.surfaceNormal || trunk.contactCone.normal;
            const sn = new THREE.Vector3(surfaceNormal.x, surfaceNormal.y, surfaceNormal.z);

            // Initial guess: Axis = Surface -> Socket
            let currentAxis = new THREE.Vector3().subVectors(socketPos, contactPos).normalize();
            let finalNormal = { x: currentAxis.x, y: currentAxis.y, z: currentAxis.z };
            let finalLength = totalDistanceToSocket;
            let finalThickness = 0;

            // Iterate 3 times (usually converges in 2)
            for (let i = 0; i < 3; i++) {
                const coneAxis = { x: currentAxis.x, y: currentAxis.y, z: currentAxis.z };

                // 1. Calculate Thickness using current axis guess
                const angleThickness = trunk.contactCone.profile.type === 'disk'
                    ? calculateDiskThickness(surfaceNormal, coneAxis, trunk.contactCone.profile)
                    : 0;

                let thickness = angleThickness;

                // COLLISION CHECK OVERRIDE
                // If mesh is provided, ensure we have physical clearance.
                if (mesh && trunk.contactCone.profile.type === 'disk') {
                    const bodyRadius = trunk.contactCone.profile.bodyDiameterMm / 2;
                    const safetyMargin = 0.8;
                    const testRadius = bodyRadius + safetyMargin;

                    // Legacy Fix: Treat 1.5 as 0.35, else respect user value
                    const rawMax = trunk.contactCone.profile.maxStandoffMm;
                    const maxStandoff = (rawMax === 1.5) ? 0.35 : rawMax;

                    // Use reusable solver
                    const safeThickness = calculateSafeOffset(
                        contactPos,
                        sn, // surfaceNormal (Vec3) - passed as THREE.Vector3, check util signature
                        socketPos,
                        testRadius,
                        mesh,
                        angleThickness, // minOffset (start at angle-based)
                        maxStandoff,
                        0.2,
                        {
                            startRadius: (trunk.contactCone.profile.contactDiameterMm / 2) + safetyMargin,
                            endRadius: testRadius,
                        },
                    );

                    // If we hit the cap, treat it as "solver couldn't prove clearance" rather than
                    // a real requirement to max-extend the disk.
                    // This prevents snapping to full length on drag end due to false positives.
                    const capEps = 1e-6;
                    thickness = safeThickness >= (maxStandoff - capEps) ? angleThickness : safeThickness;
                }

                finalThickness = thickness;

                // 2. Calculate Start Pos
                const coneStartPos = contactPos.clone().add(sn.clone().multiplyScalar(thickness));

                // 3. Calculate New Axis (Start -> Socket)
                const coneVector = new THREE.Vector3().subVectors(socketPos, coneStartPos);
                const len = coneVector.length();

                if (len > 0.0001) {
                    coneVector.normalize();
                    currentAxis = coneVector; // Update for next loop
                    finalNormal = { x: currentAxis.x, y: currentAxis.y, z: currentAxis.z };
                    finalLength = Math.max(0.1, len);
                }
            }

            // Store the Calculated Thickness in the Profile?
            // No, the Disk Logic is deterministic based on geometry.
            // BUT wait. If we override the thickness due to Collision, 
            // and then we just save the new Normal...
            // When 'calculateDiskThickness' runs in the Renderer (which only sees Angle),
            // it will revert to the Angle-based thickness!

            // CRITICAL: We cannot just save the Normal if the Thickness was forced by Collision.
            // If the Renderer logic is pure Angle-based, it will ignore our collision result.

            // We must UPDATE the profile's 'diskThicknessMm' or 'standoffAngleThreshold'? 
            // No, those are profile constants.

            // We need to store the 'forcedThickness' or 'overrideThickness' in the ContactCone object?
            // Or we need to make 'calculateDiskThickness' collision-aware? (It can't be, it's a pure util).

            // SOLUTION: 
            // We must adjust the stored 'normal' such that the Angle-based logic *yields* the target thickness.
            // Inverse Trig?
            // CalculateDiskThickness = Min + Factor * (Max - Min).
            // Factor = (Angle - Threshold) / (MaxAngle - Threshold).
            // We want Factor = (TargetThickness - Min) / (Max - Min).
            // Then we need an Angle that produces this Factor.
            // Angle = Threshold + Factor * (MaxAngle - Threshold).
            // Then we need to "fake" the normal to match this Angle?
            // That changes the visual direction of the cone! We can't do that.

            // ALTERNATIVE:
            // The 'ContactCone' needs a 'manualThicknessOverride' field.
            // If present, Renderer uses it.
            // 'getFinalSocketPosition' uses it.

            // Let's check types.ts. Can we add a field?
            // We should add 'customDiskLength?: number' to ContactCone.

            // For now, I will assume we can add this field.
            // I need to update types.ts first?
            // The user asked me to fix the logic. I should do it properly.

            // Wait, if I add a field to ContactCone, I need to update types.ts.
            // I'll assume I can do that in the next step if needed.
            // Or I can verify if I can edit types.ts now.

            // Let's proceed with the assumption that I will update types.ts to include 'diskLengthOverride'.

            // Only persist a diskLengthOverride when collision avoidance truly required extra standoff.
            // Otherwise, leave it undefined so rendering stays purely angle-based and stable.
            const finalAxisForCompare = new THREE.Vector3(finalNormal.x, finalNormal.y, finalNormal.z);
            if (finalAxisForCompare.lengthSq() < 0.000001) finalAxisForCompare.set(0, 0, 1);
            finalAxisForCompare.normalize();

            const angleThicknessAtFinal = trunk.contactCone.profile.type === 'disk'
                ? calculateDiskThickness(surfaceNormal, { x: finalAxisForCompare.x, y: finalAxisForCompare.y, z: finalAxisForCompare.z }, trunk.contactCone.profile)
                : 0;

            const EPS = 1e-4;
            const shouldOverride = trunk.contactCone.profile.type === 'disk' && finalThickness > angleThicknessAtFinal + EPS;

            newContactCone = {
                ...trunk.contactCone,
                normal: finalNormal,
                diskLengthOverride: shouldOverride ? finalThickness : undefined,
                profile: {
                    ...trunk.contactCone.profile,
                    lengthMm: finalLength
                }
            };
        }
        }
    }

    // We must iterate segments and update any reference to this joint
    const newSegments = trunk.segments.map(seg => {
        let changed = false;
        let newTop = seg.topJoint;
        let newBottom = seg.bottomJoint;

        if (seg.topJoint && seg.topJoint.id === jointId) {
            newTop = { ...seg.topJoint, pos: newPos };
            changed = true;
        }

        if (seg.bottomJoint && seg.bottomJoint.id === jointId) {
            newBottom = { ...seg.bottomJoint, pos: newPos };
            changed = true;
        }

        if (changed) {
            return {
                ...seg,
                topJoint: newTop,
                bottomJoint: newBottom
            };
        }
        return seg;
    });

    const trunkWithMovedJoint = {
        ...trunk,
        segments: newSegments,
        contactCone: newContactCone
    };

    // UX Improvement: If segments were already bezier, keep them bezier (Sticky Mode)
    // OR if global Curve Mode is active.
    const connectedAreBezier = trunk.segments.some(s =>
        (s.topJoint?.id === jointId || s.bottomJoint?.id === jointId) && s.type === 'bezier'
    );

    const shouldUpdateCurves = isCurveMode || connectedAreBezier;

    if (shouldUpdateCurves && root) {
        return updateCurvesAtJoint(trunkWithMovedJoint, jointId, root, isCurveMode);
    } else if (shouldUpdateCurves && !root) {
        console.warn('[JointUtils] CurveMode active but NO ROOT provided to moveJoint');
    }

    return trunkWithMovedJoint;
}
