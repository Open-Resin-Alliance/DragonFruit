import * as THREE from 'three';
import { Vec3 } from '../types';
import { PickingResult } from '../../components/picking/types';
import { getBezierPointAtT, toVector3 } from '../Curves/BezierUtils';

// --- Types ---

export type SnapState = 'idle' | 'seeking' | 'locked';

export type SnapTargetType = 'path' | 'surface' | 'point';

export interface SnapTarget {
    id: string;
    type: SnapTargetType;
    // For paths (shafts), we need segment info. 
    // For now, let's assume a simple line segment for the specific part we are snapped to.
    // In a full implementation, this might need to be richer.
    pathSegment?: {
        start: Vec3;
        end: Vec3;
        radius: number;
        bezier?: {
            control1: Vec3;
            control2: Vec3;
        };
    };
    // For surfaces (planes), point + normal
    surface?: {
        origin: Vec3;
        normal: Vec3;
    };
    // For points (sockets)
    point?: Vec3;
}

export interface SnapResult {
    state: SnapState;
    snappedPos: Vec3;
    targetId: string | null;
    targetType: SnapTargetType | null;
    // If snapped to a path, where are we along it?
    t?: number; 
}

export interface SnappingConfig {
    snapDistanceMm: number;
    unlockRatio: number;
    switchDwellMs: number;
}

const DEFAULT_CONFIG: SnappingConfig = {
    snapDistanceMm: 1.0,
    unlockRatio: 1.5,
    switchDwellMs: 50,
};

/**
 * SnappingManager
 * 
 * Implements the universal snapping state machine:
 * Idle -> Seeking -> Locked -> (Slide) -> Locked (new)
 */
export class SnappingManager {
    private state: SnapState = 'idle';
    private config: SnappingConfig;
    
    // State variables
    private lockedTargetId: string | null = null;
    private lastSwitchTime: number = 0;
    
    constructor(config?: Partial<SnappingConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    public getState(): SnapState {
        return this.state;
    }

    public getLockedTargetId(): string | null {
        return this.lockedTargetId;
    }

    /**
     * Main update loop. Call this on every frame/pointer move.
     * 
     * @param ray The ray from camera through mouse pointer (World Space)
     * @param pickResult Result from GPU picking (what is visually under the cursor)
     * @param getTargetCallback Function to resolve a target ID into geometric data
     * @param potentialTargets Optional list of targets to check for proximity (3D ray snapping)
     */
    public update(
        ray: THREE.Ray, 
        pickResult: PickingResult,
        getTargetCallback: (id: string) => SnapTarget | null,
        potentialTargets: SnapTarget[] = []
    ): SnapResult {
        const now = Date.now();
        const { snapDistanceMm, unlockRatio, switchDwellMs } = this.config;
        const releaseDistance = snapDistanceMm * unlockRatio;

        // 1. Calculate distance to current locked target (if any)
        let distToCurrent = Infinity;
        let currentTargetGeo: SnapTarget | null = null;

        if (this.lockedTargetId) {
            currentTargetGeo = getTargetCallback(this.lockedTargetId);
            if (currentTargetGeo) {
                distToCurrent = this.getDistanceToTarget(ray, currentTargetGeo);
            } else {
                // Target disappeared (deleted?), force unlock
                this.state = 'seeking';
                this.lockedTargetId = null;
            }
        }

        // 2. Find Best Candidate
        // Priority 1: GPU Picking (Visual hit)
        // Priority 2: 3D Proximity (Ray distance)
        
        let candidateId: string | null = null;
        let bestDist = Infinity;

        // Check GPU Pick first
        if (pickResult.category !== 'none' && pickResult.objectId) {
            // Verify if this object ID resolves to a target.
            // If not (e.g. picking returns trunk ID, but we need segment ID), we should discard it
            // and fallback to spatial search.
            const resolved = getTargetCallback(pickResult.objectId);
            if (resolved) {
                candidateId = pickResult.objectId;
                bestDist = 0; 
            } else {
            }
        } 
        
        // If no visual hit (or to find better proximity match if we want to override?), 
        // check spatial targets if provided.
        // Only check if we don't have a hard visual hit? 
        // Or if visual hit is not a valid snap target?
        
        // Let's allow spatial snapping to override empty space, but not necessarily occlusion.
        // If candidateId is set, we stick with it.
        // If not, we search potentialTargets.
        if (!candidateId) {
            for (const target of potentialTargets) {
                const dist = this.getDistanceToTarget(ray, target);
                if (dist < snapDistanceMm && dist < bestDist) {
                    bestDist = dist;
                    candidateId = target.id;
                }
            }
        }

        // 3. State Machine Transitions

        switch (this.state) {
            case 'idle':
                // Always transition to seeking if update is called (implies active tool)
                this.state = 'seeking';
                break;

            case 'seeking':
                // Transition: Seeking -> Locked
                // If we found a candidate via GPU picking (it's visually under cursor)
                // AND it resolves to a valid SnapTarget
                if (candidateId) {
                    const candidateGeo = getTargetCallback(candidateId);
                    if (candidateGeo) {
                        // GPU pick implies we are "hitting" it.
                        this.state = 'locked';
                        this.lockedTargetId = candidateId;
                        this.lastSwitchTime = now;
                        currentTargetGeo = candidateGeo; // Update for result calculation
                    }
                }
                break;

            case 'locked':
                // Transition: Locked -> Locked (new)
                // If we pick a DIFFERENT candidate, and we are allowed to switch
                if (candidateId && candidateId !== this.lockedTargetId) {
                    const candidateGeo = getTargetCallback(candidateId);
                    
                    if (candidateGeo) {
                        // Check dwell time to prevent flicker
                        if (now - this.lastSwitchTime > switchDwellMs) {
                            // Hysteresis Logic:
                            // "Stay on the current target while the pointer is within releaseDistance."
                            
                            const isOutsideRelease = distToCurrent > releaseDistance;
                            
                            // But if GPU picking says we are hitting something else, it means visual occlusion.
                            // GPU picking solves occlusion. Visual = Truth.
                            
                            // Hybrid approach:
                            // If GPU pick changes, we respect it, BUT we check if we are actually close to the new thing.
                            const distToCandidate = this.getDistanceToTarget(ray, candidateGeo);
                            
                            if (distToCandidate < snapDistanceMm) {
                                // Close enough to snap to new target
                                this.lockedTargetId = candidateId;
                                this.lastSwitchTime = now;
                                currentTargetGeo = candidateGeo;
                            } else if (isOutsideRelease) {
                                // We drifted too far from current, and found a new valid candidate (even if slightly far)
                                this.lockedTargetId = candidateId;
                                this.lastSwitchTime = now;
                                currentTargetGeo = candidateGeo;
                            }
                        }
                    }
                }
                // Transition: Locked -> Seeking
                // If we drifted too far and have no new candidate
                else if (!candidateId && distToCurrent > releaseDistance) {
                    this.state = 'seeking';
                    this.lockedTargetId = null;
                    currentTargetGeo = null;
                }
                break;
        }

        // 4. Calculate Snap Result (Sliding)
        if (this.state === 'locked' && currentTargetGeo) {
            const snapped = this.projectToTarget(ray, currentTargetGeo);
            return {
                state: 'locked',
                snappedPos: snapped.pos,
                targetId: this.lockedTargetId,
                targetType: currentTargetGeo.type,
                t: snapped.t
            };
        }

        // Default: return point on ray at some distance?
        return {
            state: this.state,
            snappedPos: { x: 0, y: 0, z: 0 }, // Dummy
            targetId: null,
            targetType: null
        };
    }

    /**
     * Calculates closest distance from Ray to target geometry
     */
    private getDistanceToTarget(ray: THREE.Ray, target: SnapTarget): number {
        if (target.type === 'path' && target.pathSegment) {
            const { start, end, bezier, radius } = target.pathSegment;
            
            if (bezier) {
                // Bezier Distance
                const result = this.projectRayToBezier(ray, start, end, bezier.control1, bezier.control2);
                // result.dist is the distance from the RAY to the closest point on curve
                // But we want distance from ray to curve?
                // projectRayToBezier returns the point on the curve closest to the ray.
                // So we calculate distance between that point and the ray.
                return Math.max(0, result.dist - (radius ?? 0));
            } else {
                const a = new THREE.Vector3(start.x, start.y, start.z);
                const b = new THREE.Vector3(end.x, end.y, end.z);
                // Distance between Ray and Line Segment
                const dist = Math.sqrt(ray.distanceSqToSegment(a, b, undefined, undefined));
                return Math.max(0, dist - (radius ?? 0));
            }
        }
        
        if (target.type === 'point' && target.point) {
            const t = new THREE.Vector3(target.point.x, target.point.y, target.point.z);
            return ray.distanceToPoint(t);
        }

        return Infinity;
    }

    /**
     * Projects a Ray onto the target geometry (finding closest point)
     */
    private projectToTarget(ray: THREE.Ray, target: SnapTarget): { pos: Vec3, t?: number } {
        if (target.type === 'path' && target.pathSegment) {
            const { start, end, bezier } = target.pathSegment;
            
            if (bezier) {
                const result = this.projectRayToBezier(ray, start, end, bezier.control1, bezier.control2);
                return {
                    pos: { x: result.point.x, y: result.point.y, z: result.point.z },
                    t: result.t
                };
            } else {
                const a = new THREE.Vector3(start.x, start.y, start.z);
                const b = new THREE.Vector3(end.x, end.y, end.z);
                
                const result = this.closestPointRaySegment(ray, a, b);
                
                return {
                    pos: { x: result.point.x, y: result.point.y, z: result.point.z },
                    t: result.parameter
                };
            }
        }
        
        if (target.type === 'point' && target.point) {
            return { pos: target.point };
        }

        return { pos: { x: 0, y: 0, z: 0 } };
    }
    
    public reset() {
        this.state = 'idle';
        this.lockedTargetId = null;
    }

    // --- Math Helpers ---

    private projectRayToBezier(ray: THREE.Ray, start: Vec3, end: Vec3, c1: Vec3, c2: Vec3) {
        const STEPS = 30;
        let bestDist = Infinity;
        let bestPoint = new THREE.Vector3();
        let bestT = 0;

        // Sample curve
        for (let i = 0; i <= STEPS; i++) {
            const t = i / STEPS;
            const p = getBezierPointAtT(start, c1, c2, end, t); // Returns Vec3
            const vP = new THREE.Vector3(p.x, p.y, p.z);
            
            // Distance from Ray to Point
            const distSq = ray.distanceSqToPoint(vP);
            if (distSq < bestDist) {
                bestDist = distSq;
                bestPoint = vP;
                bestT = t;
            }
        }

        return { point: bestPoint, t: bestT, dist: Math.sqrt(bestDist) };
    }

    private closestPointRaySegment(ray: THREE.Ray, p0: THREE.Vector3, p1: THREE.Vector3) {
        // Vector representing the segment
        const vSeg = new THREE.Vector3().subVectors(p1, p0);
        const segLenSq = vSeg.lengthSq();

        if (segLenSq < 1e-6) {
            // Segment is a point
            return { point: p0.clone(), parameter: 0 };
        }

        // Standard skew lines closest point
        // Line 1: Ray (Origin O, Dir D)
        // Line 2: Segment (Origin P0, Dir V)
        
        // w0 = O - P0
        const w0 = new THREE.Vector3().subVectors(ray.origin, p0);
        const a = ray.direction.dot(ray.direction); // 1
        const b = ray.direction.dot(vSeg);
        const c = vSeg.dot(vSeg); // segLenSq
        const d = ray.direction.dot(w0);
        const e = vSeg.dot(w0);

        const denom = a * c - b * b;
        
        let sc, tc;

        if (denom < 1e-8) {
            // Parallel
            sc = 0;
            tc = (b > c ? d / b : e / c);
        } else {
            sc = (b * e - c * d) / denom;
            tc = (a * e - b * d) / denom;
        }

        // Clamp tc to [0,1]
        let tClamped = tc;
        if (tClamped < 0) tClamped = 0;
        if (tClamped > 1) tClamped = 1;

        const pointOnSegment = new THREE.Vector3().copy(p0).addScaledVector(vSeg, tClamped);
        return { point: pointOnSegment, parameter: tClamped };
    }
}
