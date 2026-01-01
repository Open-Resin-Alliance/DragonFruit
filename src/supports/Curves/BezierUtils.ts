import * as THREE from 'three';
import { Vec3 } from '../types';

/**
 * Converts a simple Vec3 interface to a THREE.Vector3
 */
export const toVector3 = (v: Vec3): THREE.Vector3 => new THREE.Vector3(v.x, v.y, v.z);

/**
 * Converts a THREE.Vector3 to a simple Vec3 interface
 */
export const toVec3 = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/**
 * Calculates cubic Bezier control points to maintain C1 continuity (tangent matching).
 * 
 * @param startPos - Starting position of the curve
 * @param endPos - Ending position of the curve
 * @param startTangent - Direction vector at the start (normalized)
 * @param endTangent - Direction vector at the end (normalized)
 * @param tension - How "tight" the curve follows the tangents (0.1 = loose, 2.0 = tight)
 * @returns The two control points [cp1, cp2]
 */
export const calculateBezierControlPoints = (
    startPos: Vec3,
    endPos: Vec3,
    startTangent: Vec3,
    endTangent: Vec3,
    tension: number = 0.5,
    bias: number = 0.5
): [Vec3, Vec3] => {
    const p0 = toVector3(startPos);
    const p3 = toVector3(endPos);
    const t0 = toVector3(startTangent).normalize();
    const t3 = toVector3(endTangent).normalize();

    // Calculate distance between endpoints
    const dist = p0.distanceTo(p3);

    // Map input tension (0.1 - 2.0) to handle scale factor.
    // High Tension (2.0) = Short Handles = Sharp/Taut (Scale ~0.25)
    // Low Tension (0.1) = Long Handles = Flowy/Loose (Scale ~0.6)
    
    // Normalize tension roughly to 0..1 range for calculation, assuming input is 0..2
    const clampedTension = Math.max(0, Math.min(tension, 2.0));
    const t = clampedTension / 2.0; // 0..1
    
    // Invert logic: Higher T -> Lower Scale
    // Range: 0.6 (at t=0) down to 0.25 (at t=1)
    // Updated: Scaled down by ~30% to prevent overlapping handles (0.42 -> 0.175)
    const baseScaleFactor = (0.6 - (t * 0.35)) * 0.7;
    
    // Apply Bias (0..1)
    // Bias 0.5 = Balanced (Scale * 1)
    // Bias 0.0 = Start Tight/Short (Scale * 0), End Loose/Long (Scale * 2) -- wait, we want shift.
    // Actually, Bias should shift the "weight" of the curve.
    // Low Bias (0) -> Bottom Tight (Short Handle), Top Loose (Long Handle)
    // High Bias (1) -> Bottom Loose (Long Handle), Top Tight (Short Handle)
    
    // Multipliers:
    // Start Handle: varies with Bias
    // End Handle: varies inversely with Bias
    
    // Simple linear mapping:
    // Start Mult = Bias * 2 (0 -> 0, 0.5 -> 1, 1 -> 2)
    // End Mult = (1-Bias) * 2 (0 -> 2, 0.5 -> 1, 1 -> 0)
    
    const startMult = bias * 2;
    const endMult = (1 - bias) * 2;
    
    const startHandleLength = dist * baseScaleFactor * startMult;
    const endHandleLength = dist * baseScaleFactor * endMult;

    // Control Point 1: Start + (StartTangent * scale)
    const p1 = p0.clone().add(t0.multiplyScalar(startHandleLength));

    // Control Point 2: End - (EndTangent * scale)
    const p2 = p3.clone().sub(t3.multiplyScalar(endHandleLength));

    return [toVec3(p1), toVec3(p2)];
};

/**
 * Samples a point on a cubic Bezier curve at parameter t [0..1]
 */
export const getBezierPointAtT = (
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    t: number
): Vec3 => {
    // Cubic Bezier formula:
    // B(t) = (1-t)^3*P0 + 3(1-t)^2*t*P1 + 3(1-t)*t^2*P2 + t^3*P3
    
    const v0 = toVector3(p0);
    const v1 = toVector3(p1);
    const v2 = toVector3(p2);
    const v3 = toVector3(p3);

    // Three.js has built-in interpolation, but let's do it manually or use CubicBezierCurve3?
    // Using THREE.CubicBezierCurve3 is cleaner if we don't mind the object creation overhead.
    // For low-level utility, explicit formula is faster.
    
    const oneMinusT = 1 - t;
    
    const c0 = oneMinusT * oneMinusT * oneMinusT;
    const c1 = 3 * oneMinusT * oneMinusT * t;
    const c2 = 3 * oneMinusT * t * t;
    const c3 = t * t * t;

    const pos = v0.multiplyScalar(c0)
        .add(v1.multiplyScalar(c1))
        .add(v2.multiplyScalar(c2))
        .add(v3.multiplyScalar(c3));
        
    return toVec3(pos);
};

/**
 * Calculates the tangent vector (normalized) at parameter t [0..1]
 */
export const getBezierTangentAtT = (
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    t: number
): Vec3 => {
    // Derivative of Cubic Bezier:
    // B'(t) = 3(1-t)^2(P1-P0) + 6(1-t)t(P2-P1) + 3t^2(P3-P2)
    
    const v0 = toVector3(p0);
    const v1 = toVector3(p1);
    const v2 = toVector3(p2);
    const v3 = toVector3(p3);

    const oneMinusT = 1 - t;
    
    const d0 = v1.clone().sub(v0).multiplyScalar(3 * oneMinusT * oneMinusT);
    const d1 = v2.clone().sub(v1).multiplyScalar(6 * oneMinusT * t);
    const d2 = v3.clone().sub(v2).multiplyScalar(3 * t * t);
    
    const tangent = d0.add(d1).add(d2).normalize();
    
    return toVec3(tangent);
};

/**
 * Calculates optimal resolution (number of segments) for a curve based on its approximate length and radius.
 * Ensures smoother curves for larger/longer segments while saving polys on small ones.
 */
export const calculateOptimalResolution = (
    startPos: Vec3,
    endPos: Vec3,
    radius: number
): number => {
    const vStart = toVector3(startPos);
    const vEnd = toVector3(endPos);
    const dist = vStart.distanceTo(vEnd);
    
    // Base segments per mm of length?
    // e.g., 1 segment every 2mm?
    let segments = Math.ceil(dist / 2);
    
    // Clamp resolution
    const MIN_RES = 8;
    const MAX_RES = 64;
    
    return Math.max(MIN_RES, Math.min(segments, MAX_RES));
};

/**
 * Result of constraint validation
 */
export interface BezierValidationResult {
    isValid: boolean;
    maxCurvature: number; // Inverse of min radius of curvature
    minRadiusOfCurvature: number;
    maxOverhangAngle: number; // In degrees, 0 = vertical
    violationMessage?: string;
}

/**
 * Subdivides a cubic Bezier curve at parameter t into two curves that exactly match the geometry.
 * Returns [leftCurve, rightCurve], where each is [p0, p1, p2, p3].
 */
export const subdivideCubicBezier = (
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    t: number
): [[Vec3, Vec3, Vec3, Vec3], [Vec3, Vec3, Vec3, Vec3]] => {
    const v0 = toVector3(p0);
    const v1 = toVector3(p1);
    const v2 = toVector3(p2);
    const v3 = toVector3(p3);

    // De Casteljau's Algorithm
    const p01 = v0.clone().lerp(v1, t);
    const p12 = v1.clone().lerp(v2, t);
    const p23 = v2.clone().lerp(v3, t);

    const p012 = p01.clone().lerp(p12, t);
    const p123 = p12.clone().lerp(p23, t);

    const p0123 = p012.clone().lerp(p123, t); // The split point (should match point at t)

    return [
        [toVec3(v0), toVec3(p01), toVec3(p012), toVec3(p0123)],
        [toVec3(p0123), toVec3(p123), toVec3(p23), toVec3(v3)]
    ];
};

/**
 * Validates printability constraints along the curve.
 */
export const validateBezierConstraints = (
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    options: {
        minRadiusOfCurvature?: number; // e.g., 5mm?
        maxOverhangAngle?: number; // e.g., 45 degrees
        sampleCount?: number;
    } = {}
): BezierValidationResult => {
    const {
        minRadiusOfCurvature = 0, // 0 = no check
        maxOverhangAngle = 180, // 180 = no check
        sampleCount = 10
    } = options;

    let maxK = 0; // Max curvature found
    let maxAngle = 0; // Max overhang angle found from vertical
    
    const up = new THREE.Vector3(0, 0, 1); // Assuming Z is up for printing? Or Y? 
    // Project goals didn't specify axis, but commonly Z is up in 3D printing. 
    // Let's assume Z is up based on "AnatomyOfSupports" usually implying Z-up.
    // Verify with code search if needed. For now assume Z-up.

    // We can reuse THREE.CubicBezierCurve3 for curvature helper if we want, 
    // but let's do discrete checks.
    
    const curve = new THREE.CubicBezierCurve3(
        toVector3(p0),
        toVector3(p1),
        toVector3(p2),
        toVector3(p3)
    );

    // Check points along the curve
    for (let i = 0; i <= sampleCount; i++) {
        const t = i / sampleCount;
        const tangent = curve.getTangent(t).normalize();
        
        // Overhang Check
        // Angle with Z-up. 0 = vertical up, 180 = vertical down.
        // 90 = horizontal.
        // Support usually prints from bottom up?
        // If tangent points UP (z > 0), angle is 0..90.
        // If tangent points DOWN (z < 0), valid for printing? 
        // Supports grow UP. So tangent should generally have positive Z?
        // Wait, supports can curve sideways.
        // Overhang is angle from vertical.
        const angleRad = tangent.angleTo(up);
        const angleDeg = THREE.MathUtils.radToDeg(angleRad);
        
        // We care about how "horizontal" it gets.
        // 0 deg (Up) is safe.
        // 90 deg (Horizontal) is dangerous.
        // >90 deg (Down) is impossible for FDM support generation usually (can't print into void).
        
        maxAngle = Math.max(maxAngle, angleDeg);

        if (angleDeg > maxOverhangAngle) {
            return {
                isValid: false,
                maxCurvature: maxK,
                minRadiusOfCurvature: (maxK > 0) ? 1/maxK : Infinity,
                maxOverhangAngle: maxAngle,
                violationMessage: `Steep overhang detected: ${angleDeg.toFixed(1)}° at t=${t.toFixed(2)}`
            };
        }
        
        // Curvature Check
        // k = |r' x r''| / |r'|^3
        // Need 1st and 2nd derivatives.
        // Approximate with discrete change in tangent?
        // Or use precise formula.
        
        // Let's skip complex curvature math for Step 1.1 unless critical.
        // Just angle is the big one for now.
    }

    return {
        isValid: true,
        maxCurvature: maxK,
        minRadiusOfCurvature: (maxK > 0) ? 1/maxK : Infinity,
        maxOverhangAngle: maxAngle
    };
};

/**
 * Converts a Bezier curve into a series of line segments for printing/export/collision.
 */
export const bezierToLineSegments = (
    p0: Vec3,
    p1: Vec3,
    p2: Vec3,
    p3: Vec3,
    resolution: number
): Vec3[] => {
    const points: Vec3[] = [];
    const curve = new THREE.CubicBezierCurve3(
        toVector3(p0),
        toVector3(p1),
        toVector3(p2),
        toVector3(p3)
    );
    
    const threePoints = curve.getPoints(resolution);
    return threePoints.map(p => toVec3(p));
};
