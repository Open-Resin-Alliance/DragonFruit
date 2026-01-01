import * as THREE from 'three';
import { Vec3 } from '../types';
import { calculateStandardPlacement, TrunkPlacementInput, TrunkPlacementResult } from './StandardPlacement';
import { checkShaftCollision } from './CollisionUtils';
import { getSettings } from '../Settings';
import { LimitationCode } from '../types';

export interface SmartPlacementInput extends TrunkPlacementInput {
    mesh: THREE.Mesh;
    modelId: string;
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

    // SAFETY MARGIN: 0.25mm
    // We test with a slightly thicker shaft to prevent fusing due to light bloom.
    const collisionRadius = shaftRadius + 0.25;

    // 1. Run Standard Placement first to get the baseline
    const standard = calculateStandardPlacement(input);

    // If standard placement is already invalid due to angle, we can't fix it with bending
    if (standard.error === 'ANGLE_TOO_STEEP') {
        return standard;
    }

    // 2. Check for Collisions in the Standard Path (Vertical Drop)
    // Path: Socket -> Base (Z=0)

    // We use a "virtual base" at Z=0 for the check
    const targetBase: Vec3 = { ...standard.basePos, z: 0 };

    // Check collision from Socket to Floor
    const collision = checkShaftCollision(
        standard.socketPos,
        targetBase,
        collisionRadius, // Use inflated radius
        mesh
    );

    // If no collision, or collision is far away (e.g. floor), Standard is fine.
    // Wait, checkShaftCollision intersects the MESH. 
    // If it returns hit=false, it means we didn't hit the mesh (Clear path to floor).
    // If it returns hit=true, we hit the mesh.

    if (!collision.hit || !collision.point) {
        return standard;
    }

    // --- SMART SOLVER START ---
    // STRATEGY: Iterative "Compass" Solver
    // When blocked, check multiple directions to find a clear path to the floor.

    const joints: Vec3[] = [];
    let currentStart = standard.socketPos;
    const MAX_JOINTS = 3;

    // Configuration
    const KNEE_OFFSET_MM = 15; // Increased search radius to clear obstacles
    const SEARCH_ANGLES = 8; // Check 8 directions (45 degrees)

    for (let i = 0; i < MAX_JOINTS; i++) {
        // 1. Try to go straight down to floor (Z=0)
        const targetBase: Vec3 = { x: currentStart.x, y: currentStart.y, z: 0 };
        const colToFloor = checkShaftCollision(currentStart, targetBase, collisionRadius, mesh);

        if (!colToFloor.hit || !colToFloor.point) {
            // Path is clear! We made it to the floor.
            return {
                socketPos: standard.socketPos,
                joints: joints,
                basePos: targetBase,
                warning: standard.warning, // Preserve warning from standard placement
                angle: standard.angle,
                coneAxis: standard.coneAxis
            };
        }

        // 2. Collision detected. We need to find a way around.
        const hitPoint = colToFloor.point;

        // "Compass Check": Try multiple directions and distances around the collision point
        // We want to find the "Best Turn".

        let bestCandidate: { pos: Vec3, score: number } | null = null;

        // Search Parameters
        // 1. Radii: Try small nudges first, then big swings.
        const RADII = [2, 5, 10, 15, 20]; // Added 2mm for "micro-offsets"
        // 2. Heights: Try turning "Early" (High) vs "Late" (Low/At Collision).
        // We assume 'currentStart' is higher than 'hitPoint'.
        const startZ = currentStart.z;
        const hitZ = hitPoint.z;
        const distZ = startZ - hitZ;

        // Constraints
        // Use user setting but cap it? Or just use it?
        // User setting: "Max Angle From Vertical". 
        // If user sets 80, we allow up to 80.
        // If user sets 45, we allow up to 45 (stricter).
        // For Smart Placement, we probably want to respect the user's wish.
        // However, if we go too flat, we fail.
        const MAX_ANGLE_DEG = settings.shaft.maxAngleDeg ?? 80;

        const MAX_HORIZONTAL_SEGMENT_MM = 2;

        // Define heights to test relative to start
        const HEIGHT_RATIOS = [0.1, 0.5, 0.9]; // 10% down (High), 50% (Mid), 90% (Low)

        // Loop Order: We want the "Tightest" valid path.
        for (const radius of RADII) {
            for (const ratio of HEIGHT_RATIOS) {
                let searchZ = startZ - (distZ * ratio);

                // --- ANGLE CONSTRAINT ENFORCEMENT ---
                // Calculate Vertical Drop
                let drop = startZ - searchZ;
                // Ensure non-zero drop to avoid divide-by-zero
                if (drop < 0.001) drop = 0.001;

                // Current Angle (0=Vertical, 90=Horizontal)
                const angleRad = Math.atan(radius / drop);
                const angleDeg = angleRad * (180 / Math.PI);

                // Logic: If too flat (> 70) AND too long (> 2mm), we must lower the Z.
                if (angleDeg > MAX_ANGLE_DEG && radius > MAX_HORIZONTAL_SEGMENT_MM) {
                    // Calculate required drop for MAX_ANGLE
                    // tan(max) = radius / requiredDrop
                    // requiredDrop = radius / tan(max)
                    const maxRad = MAX_ANGLE_DEG * (Math.PI / 180);
                    const requiredDrop = radius / Math.tan(maxRad);

                    // Update Search Z to satisfy angle
                    searchZ = startZ - requiredDrop;

                    // If this pushes us below the floor (or too deep), this radius might be invalid
                    // but we let the collision check handle it (Start -> Joint -> Floor)
                }

                // 8 Compass Angles
                for (let angleIdx = 0; angleIdx < SEARCH_ANGLES; angleIdx++) {
                    const angleRad = (angleIdx / SEARCH_ANGLES) * Math.PI * 2;
                    const dirX = Math.cos(angleRad);
                    const dirY = Math.sin(angleRad);

                    // Proposed Knee Position
                    const kneePosVec = new THREE.Vector3(hitPoint.x, hitPoint.y, searchZ)
                        .add(new THREE.Vector3(dirX, dirY, 0).multiplyScalar(radius));

                    const kneePos: Vec3 = { x: kneePosVec.x, y: kneePosVec.y, z: kneePosVec.z };

                    // CHECK 1: Is Start -> Knee clear?
                    const leg1Col = checkShaftCollision(currentStart, kneePos, collisionRadius, mesh);
                    if (leg1Col.hit) continue;

                    // CHECK 2: Is Knee -> Floor clear?
                    const floorPos: Vec3 = { x: kneePos.x, y: kneePos.y, z: 0 };
                    const leg2Col = checkShaftCollision(kneePos, floorPos, collisionRadius, mesh);

                    // Scoring
                    let score = 0;
                    if (!leg2Col.hit) {
                        score = 1000; // Clear path to floor
                        // Penalty for large radius (prefer tight turns)
                        score -= radius;
                    } else if (leg2Col.point && leg2Col.point.z < hitZ - 5) {
                        // Progress (getting deeper)
                        score = 500 + (hitZ - leg2Col.point.z);
                    } else {
                        score = 10;
                    }

                    if (!bestCandidate || score > bestCandidate.score) {
                        bestCandidate = { pos: kneePos, score };
                    }

                    // If we found a clear path to floor, this is likely good enough.
                    // Since we iterate Radii from Small->Large, the first 1000 is the "Tightest Winner".
                    if (score >= 900) break;
                }
                if (bestCandidate && bestCandidate.score >= 900) break;
            }
            if (bestCandidate && bestCandidate.score >= 900) break;
        }

        if (bestCandidate) {
            // We found a valid step
            joints.push(bestCandidate.pos);
            currentStart = bestCandidate.pos;
            console.log(`[SmartPlacement] Step ${i + 1}: Best candidate score ${bestCandidate.score}`);

            // If we found the floor (Score 1000), we can technically break the loop next iter,
            // or return immediately here?
            // The loop structure checks "Path to Floor" at the start of next iteration.
            // So if we found a clear path, the next loop will verify it and return.
            // BUT, we updated `currentStart` to `kneePos`.
            // The next loop will check `kneePos` -> `floor`.
            // Since we verified `leg2Col` was clear for Score 1000, the next loop is guaranteed to succeed.
        } else {
            // No valid directions found! Stuck.
            console.log('[SmartPlacement] Failed: No valid directions found');
            break;
        }
    }

    // If we exited loop without returning, we failed to find a path
    return {
        ...standard,
        error: 'COLLISION_WITH_MODEL'
    };
}
