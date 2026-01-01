import { Trunk, Segment, BezierSegment, Joint, Vec3, Roots } from '../types';
import { calculateBezierControlPoints, toVector3, toVec3 } from './BezierUtils';
import * as THREE from 'three';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone';

/**
 * Converts a segment to a BezierSegment if it isn't already.
 * Preserves existing properties.
 */
export function ensureBezierSegment(segment: Segment): BezierSegment {
    if (segment.type === 'bezier') {
        return segment as BezierSegment;
    }

    // Initialize with default Bezier properties
    return {
        ...segment,
        type: 'bezier',
        controlPoint1: { x: 0, y: 0, z: 0 }, // Will be calculated
        controlPoint2: { x: 0, y: 0, z: 0 },
        startTangent: { x: 0, y: 0, z: 1 },
        endTangent: { x: 0, y: 0, z: 1 },
        tension: 0.5,
        bias: 0.5,
        resolution: 16
    };
}

/**
 * Helper to get start/end positions for a segment
 */
function getSegmentEndPoints(trunk: Trunk, seg: Segment, root: Roots): { start: Vec3, end: Vec3 } | null {
    // Start
    let start: Vec3 | null = null;
    if (seg.bottomJoint) {
        start = seg.bottomJoint.pos;
    } else if (trunk.segments[0].id === seg.id) {
        // Root
        const rPos = root.transform.pos;
        const rHeight = root.height || 0;
        start = { x: rPos.x, y: rPos.y, z: rPos.z + rHeight + 0.5 };
    } else {
        // Should be connected to previous segment top joint?
        // But if bottomJoint is null and it's not first... legacy?
        // In current system, bottomJoint should exist for index > 0.
        // Fallback: find previous segment
        const idx = trunk.segments.findIndex(s => s.id === seg.id);
        if (idx > 0) {
            start = trunk.segments[idx - 1].topJoint?.pos || null;
        }
    }

    // End
    let end: Vec3 | null = null;
    if (seg.topJoint) {
        end = seg.topJoint.pos;
    } else if (trunk.contactCone) {
        end = getFinalSocketPosition(trunk.contactCone);
    } else {
        // Tip?
        if (start) {
             end = { x: start.x, y: start.y, z: start.z + 10 }; // Fallback
        }
    }

    if (start && end) return { start, end };
    return null;
}

/**
 * Updates tension for a specific segment and recalculates its curve.
 */
export function updateSegmentTension(trunk: Trunk, segmentId: string, tension: number, root: Roots): Trunk {
    const segIndex = trunk.segments.findIndex(s => s.id === segmentId);
    if (segIndex === -1) return trunk;

    const oldSeg = trunk.segments[segIndex];
    if (oldSeg.type !== 'bezier') return trunk;

    const points = getSegmentEndPoints(trunk, oldSeg, root);
    if (!points) return trunk;

    // Use existing tangents
    const startTangent = oldSeg.startTangent;
    const endTangent = oldSeg.endTangent;
    const bias = (oldSeg as BezierSegment).bias ?? 0.5;

    const [cp1, cp2] = calculateBezierControlPoints(
        points.start,
        points.end,
        startTangent,
        endTangent,
        tension,
        bias
    );

    const newSeg: BezierSegment = {
        ...(oldSeg as BezierSegment),
        tension,
        controlPoint1: cp1,
        controlPoint2: cp2
    };

    const newSegments = [...trunk.segments];
    newSegments[segIndex] = newSeg;

    return {
        ...trunk,
        segments: newSegments
    };
}

/**
 * Updates bias for a specific segment and recalculates its curve.
 */
export function updateSegmentBias(trunk: Trunk, segmentId: string, bias: number, root: Roots): Trunk {
    const segIndex = trunk.segments.findIndex(s => s.id === segmentId);
    if (segIndex === -1) return trunk;

    const oldSeg = trunk.segments[segIndex];
    if (oldSeg.type !== 'bezier') return trunk;

    const points = getSegmentEndPoints(trunk, oldSeg, root);
    if (!points) return trunk;

    const startTangent = oldSeg.startTangent;
    const endTangent = oldSeg.endTangent;
    const tension = (oldSeg as BezierSegment).tension;

    const [cp1, cp2] = calculateBezierControlPoints(
        points.start,
        points.end,
        startTangent,
        endTangent,
        tension,
        bias
    );

    const newSeg: BezierSegment = {
        ...(oldSeg as BezierSegment),
        bias,
        controlPoint1: cp1,
        controlPoint2: cp2
    };

    const newSegments = [...trunk.segments];
    newSegments[segIndex] = newSeg;

    return {
        ...trunk,
        segments: newSegments
    };
}

/**
 * Removes curve from a specific segment (reverts to straight).
 */
export function removeSegmentCurve(trunk: Trunk, segmentId: string): Trunk {
    const segIndex = trunk.segments.findIndex(s => s.id === segmentId);
    if (segIndex === -1) return trunk;

    const oldSeg = trunk.segments[segIndex];
    if (oldSeg.type !== 'bezier') return trunk;

    const { 
        controlPoint1, controlPoint2, 
        startTangent, endTangent, 
        tension, resolution, 
        type, 
        ...base 
    } = oldSeg as any;

    const newSeg = {
        ...base,
        type: 'straight'
    } as Segment;

    const newSegments = [...trunk.segments];
    newSegments[segIndex] = newSeg;

    return {
        ...trunk,
        segments: newSegments
    };
}

/**
 * Updates the curves of segments connected to a specific joint.
 * Ensures C1 continuity at the joint.
 */
export function updateCurvesAtJoint(trunk: Trunk, jointId: string, root: Roots, forceCurve: boolean = false): Trunk {
    console.log('[CurveUtils] updateCurvesAtJoint called. Joint:', jointId, 'Root:', !!root, 'Force:', forceCurve);

    // 1. Find segments connected to this joint
    const connectedSegments = trunk.segments.filter(s => 
        s.topJoint?.id === jointId || s.bottomJoint?.id === jointId
    );

    if (connectedSegments.length === 0) return trunk;

    // 2. We need to look at the local neighborhood to calculate smooth tangents.
    
    // Find segment where joint is TOP (incoming)
    const incomingIdx = trunk.segments.findIndex(s => s.topJoint?.id === jointId);
    const incomingSeg = incomingIdx !== -1 ? trunk.segments[incomingIdx] : undefined;
    
    // Find segment where joint is BOTTOM (outgoing)
    let outgoingSeg = trunk.segments.find(s => s.bottomJoint?.id === jointId);

    // Fallback
    if (incomingSeg && !outgoingSeg && incomingIdx + 1 < trunk.segments.length) {
        outgoingSeg = trunk.segments[incomingIdx + 1];
    }

    let newSegments = [...trunk.segments];

    // Helper to get position of a joint or end
    const getPos = (seg: Segment, end: 'top' | 'bottom'): Vec3 | null => {
        if (end === 'top') {
            if (seg.topJoint) return seg.topJoint.pos;
            if (trunk.contactCone) return getFinalSocketPosition(trunk.contactCone);
            return null;
        }
        if (end === 'bottom') {
            if (seg.bottomJoint) return seg.bottomJoint.pos;
            if (trunk.segments[0].id === seg.id) {
                if (!root) return null;
                const rPos = root.transform.pos;
                const diskHeight = 0.5;
                const coneHeight = root.height || 1.5;
                return { x: rPos.x, y: rPos.y, z: rPos.z + diskHeight + coneHeight };
            }
            return null;
        }
        return null;
    };

    // Calculate Smooth Tangent at the Joint
    const jointPos = incomingSeg ? incomingSeg.topJoint!.pos : outgoingSeg!.bottomJoint!.pos;
    let tangent = new THREE.Vector3(0, 0, 1);

    if (incomingSeg && outgoingSeg) {
        const pPrev = getPos(incomingSeg, 'bottom');
        const pNext = getPos(outgoingSeg, 'top');

        if (pPrev && pNext) {
            const v1 = toVector3(jointPos).sub(toVector3(pPrev)).normalize();
            const v2 = toVector3(pNext).sub(toVector3(jointPos)).normalize();
            tangent = v1.add(v2).normalize();
        } else if (pPrev) {
             tangent = toVector3(jointPos).sub(toVector3(pPrev)).normalize();
        } else if (pNext) {
             tangent = toVector3(pNext).sub(toVector3(jointPos)).normalize();
        }
    } else if (incomingSeg) {
        const pPrev = getPos(incomingSeg, 'bottom');
        if (pPrev) tangent = toVector3(jointPos).sub(toVector3(pPrev)).normalize();
    } else if (outgoingSeg) {
        const pNext = getPos(outgoingSeg, 'top');
        if (pNext) tangent = toVector3(pNext).sub(toVector3(jointPos)).normalize();
    }

    const tangentVec = toVec3(tangent);

    // Update Incoming Segment
    if (incomingSeg) {
        // Only update if it's already bezier OR we are forcing it
        if (incomingSeg.type === 'bezier' || forceCurve) {
            const idx = newSegments.findIndex(s => s.id === incomingSeg.id);
            let seg = ensureBezierSegment(incomingSeg);
            
            seg.endTangent = tangentVec;
            
            const startPos = getPos(seg, 'bottom');
            if (startPos) {
                const dir = toVector3(jointPos).sub(toVector3(startPos)).normalize();
                const hasStartTangent = seg.startTangent && (Math.abs(seg.startTangent.x) > 0.001 || Math.abs(seg.startTangent.y) > 0.001 || Math.abs(seg.startTangent.z) > 0.001);
                const finalStartTangent = hasStartTangent ? seg.startTangent : toVec3(dir);
                
                const [cp1, cp2] = calculateBezierControlPoints(
                    startPos,
                    jointPos,
                    finalStartTangent,
                    tangentVec,
                    seg.tension,
                    seg.bias ?? 0.5
                );
                
                seg.controlPoint1 = cp1;
                seg.controlPoint2 = cp2;
                seg.startTangent = finalStartTangent;
                
                newSegments[idx] = seg;
            }
        }
    }

    // Update Outgoing Segment
    if (outgoingSeg) {
        // Only update if it's already bezier OR we are forcing it
        if (outgoingSeg.type === 'bezier' || forceCurve) {
            const idx = newSegments.findIndex(s => s.id === outgoingSeg.id);
            let seg = ensureBezierSegment(outgoingSeg);
            
            seg.startTangent = tangentVec;
            
            const endPos = getPos(seg, 'top');
            if (endPos) {
                const dir = toVector3(endPos).sub(toVector3(jointPos)).normalize();
                const hasEndTangent = seg.endTangent && (Math.abs(seg.endTangent.x) > 0.001 || Math.abs(seg.endTangent.y) > 0.001 || Math.abs(seg.endTangent.z) > 0.001);
                const finalEndTangent = hasEndTangent ? seg.endTangent : toVec3(dir);
                
                const [cp1, cp2] = calculateBezierControlPoints(
                    jointPos,
                    endPos,
                    tangentVec,
                    finalEndTangent,
                    seg.tension,
                    seg.bias ?? 0.5
                );

                seg.controlPoint1 = cp1;
                seg.controlPoint2 = cp2;
                seg.endTangent = finalEndTangent;
                
                newSegments[idx] = seg;
            }
        }
    }

    return {
        ...trunk,
        segments: newSegments
    };
}

/**
 * Updates tension for curves connected to a joint
 */
export function updateCurveTension(trunk: Trunk, jointId: string, tension: number, root: Roots): Trunk {
    const newSegments = trunk.segments.map(seg => {
        if ((seg.topJoint?.id === jointId || seg.bottomJoint?.id === jointId) && seg.type === 'bezier') {
            return { ...seg, tension };
        }
        return seg;
    });
    
    const tempTrunk = { ...trunk, segments: newSegments };
    return updateCurvesAtJoint(tempTrunk, jointId, root);
}

/**
 * Removes curve properties from segments connected to a joint, reverting them to straight lines.
 */
export function removeCurveAtJoint(trunk: Trunk, jointId: string): Trunk {
    const newSegments = trunk.segments.map(seg => {
        if (seg.topJoint?.id === jointId || seg.bottomJoint?.id === jointId) {
            if (seg.type === 'bezier') {
                // Convert back to straight
                // Remove bezier props.
                // Since we are using a union type, we construct a StraightSegment.
                // But we need to keep BaseSegment props.
                const { 
                    controlPoint1, controlPoint2, 
                    startTangent, endTangent, 
                    tension, resolution, 
                    type, 
                    ...base 
                } = seg as any; // cast to any to destructure safely
                
                return {
                    ...base,
                    type: 'straight'
                } as Segment;
            }
        }
        return seg;
    });
    
    return {
        ...trunk,
        segments: newSegments
    };
}
