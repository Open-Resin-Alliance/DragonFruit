import * as THREE from 'three';
import { getSettings, getGridSettings } from '../Settings/state';
import { checkShaftCollision } from '../PlacementLogic/CollisionUtils';
import { buildSupportBraceData } from '../SupportTypes/SupportBrace/supportBraceBuilder';
import { snapToGridIndex } from '../PlacementLogic/Grid/gridMath';
import type { SupportBraceBuildResult, SupportBraceHostTarget, SupportBraceState } from '../SupportTypes/SupportBrace/types';
import type { SupportState, Trunk, Vec3, Segment, Roots } from '../types';
import { AUTO_BRACING_HARD_RULES, type AutoBracingSettings } from './settings';
import { getAllMeshEntriesForAutoBrace } from './meshGeometryStore';
import { getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';

const MIN_HEIGHT_FOR_MANDATORY_BRACING_MM = 25.0; // Reverted back to 25.0
const DROP_COLLISION_SAMPLES = 20;

function createVector3(v: Vec3) {
    return new THREE.Vector3(v.x, v.y, v.z);
}

function normalizeAxisAngleRad(angleRad: number): number {
    let n = angleRad % Math.PI;
    if (n < 0) n += Math.PI;
    return n;
}

function axisSeparationDeg(aRad: number, bRad: number): number {
    const diff = Math.abs(aRad - bRad);
    return (Math.min(diff, Math.PI - diff) * 180) / Math.PI;
}

/**
 * Ensures that any trunk over 15mm tall has at least 2-axis bracing.
 * If a trunk lacks bracing, this function calculates the placement for
 * new Support Braces to satisfy the structural requirement.
 */
export function generateRequiredSupportBraces(
    snapshot: SupportState,
    supportBraceState: SupportBraceState,
    settings: AutoBracingSettings,
    existingBraceEdges: Array<{ a: string; b: string; angleRad: number }>
): SupportBraceBuildResult[] {
    const meshEntries = getAllMeshEntriesForAutoBrace();
    const globalSettings = getSettings();
    const gridSettings = getGridSettings();
    const generatedSupportBraces: SupportBraceBuildResult[] = [];

    // The maximum horizontal run a brace can physically reach based on the 3D max length setting
    const maxHorizontalRun = settings.maxBraceLengthMm / Math.SQRT2;
    // We want the new support brace to generate well within the max run so it definitely connects.
    const GENERATION_DISTANCE_MM = Math.min(5.0, maxHorizontalRun * 0.8);

    const segmentOwnerTrunkId = new Map<string, string>();
    for (const trunk of Object.values(snapshot.trunks)) {
        for (const seg of trunk.segments) {
            segmentOwnerTrunkId.set(seg.id, trunk.id);
        }
    }

    // Map existing brace axes to trunk IDs
    const axesByTrunkId = new Map<string, number[]>();
    for (const edge of existingBraceEdges) {
        const aList = axesByTrunkId.get(edge.a) || [];
        aList.push(edge.angleRad);
        axesByTrunkId.set(edge.a, aList);
        
        const bList = axesByTrunkId.get(edge.b) || [];
        bList.push(edge.angleRad);
        axesByTrunkId.set(edge.b, bList);
    }

    // Mix in axes from existing Support Braces already hosted on this trunk
    for (const sb of Object.values(supportBraceState.supportBraces)) {
        const hostTrunkId = segmentOwnerTrunkId.get(sb.hostSegmentId);
        if (!hostTrunkId) continue;
        
        const root = supportBraceState.roots[sb.rootId];
        const hostKnot = supportBraceState.knots[sb.hostKnotId];
        if (!root || !hostKnot) continue;

        const angleRad = normalizeAxisAngleRad(Math.atan2(root.transform.pos.y - hostKnot.pos.y, root.transform.pos.x - hostKnot.pos.x));
        
        const list = axesByTrunkId.get(hostTrunkId) || [];
        list.push(angleRad);
        axesByTrunkId.set(hostTrunkId, list);
    }

    const checkSlantedCollision = (topPos: Vec3, bottomPos: Vec3, modelId: string, radius: number): boolean => {
        const entry = meshEntries.get(modelId);
        if (!entry) return false;

        const bvh = (entry.geometry as any).boundsTree;
        if (!bvh) return false;

        const inverseMatrix = entry.transform.clone().invert();
        const start = createVector3(topPos).applyMatrix4(inverseMatrix);
        const end = createVector3(bottomPos).applyMatrix4(inverseMatrix);
        
        const resultTarget: { point?: THREE.Vector3; distance?: number } = {};

        for (let i = 0; i <= DROP_COLLISION_SAMPLES; i++) {
            const t = i / DROP_COLLISION_SAMPLES;
            const p = new THREE.Vector3().lerpVectors(start, end, t);
            const result = bvh.closestPointToPoint(p, resultTarget);
            if (result && (result.distance as number) < radius) {
                return true; // Collision detected
            }
        }
        return false;
    };

    // 1. Find trunks > 15mm that lack 2-axis bracing
    for (const trunk of Object.values(snapshot.trunks)) {
        const root = snapshot.roots[trunk.rootId];
        if (!root) continue;

        let maxZ = root.transform.pos.z;
        
        interface CandidateAnchor {
            segmentId: string;
            t: number;
            pos: Vec3;
            diameterMm: number;
        }
        const candidateAnchors: CandidateAnchor[] = [];

        trunk.segments.forEach((seg, idx) => {
            const ep = getTrunkSegmentEndpoints(trunk, seg, idx, root);
            if (ep) {
                if (ep.end.z > maxZ) {
                    maxZ = ep.end.z;
                }
                // Sample anchor points along the segment
                for (let t = 0.9; t >= 0.1; t -= 0.2) {
                    candidateAnchors.push({
                        segmentId: seg.id,
                        t,
                        pos: {
                            x: ep.start.x + (ep.end.x - ep.start.x) * t,
                            y: ep.start.y + (ep.end.y - ep.start.y) * t,
                            z: ep.start.z + (ep.end.z - ep.start.z) * t,
                        },
                        diameterMm: seg.diameter
                    });
                }
            }
        });

        const trunkHeight = maxZ - root.transform.pos.z;
        if (trunkHeight < MIN_HEIGHT_FOR_MANDATORY_BRACING_MM) continue;

        const axes = axesByTrunkId.get(trunk.id) || [];
        let hasTwoAxis = false;

        for (let i = 0; i < axes.length; i++) {
            for (let j = i + 1; j < axes.length; j++) {
                if (axisSeparationDeg(axes[i], axes[j]) >= AUTO_BRACING_HARD_RULES.minAxisSeparationDeg) {
                    hasTwoAxis = true;
                    break;
                }
            }
            if (hasTwoAxis) break;
        }

        if (hasTwoAxis) continue;

        // Needs extra bracing!
        const numBracesNeeded = axes.length === 0 ? 2 : 1;
        
        if (candidateAnchors.length === 0) continue;
        
        // Sort anchors highest to lowest so we attach as high as possible
        candidateAnchors.sort((a, b) => b.pos.z - a.pos.z);

        const rootPos = root.transform.pos;
        let existingAxis = axes.length > 0 ? axes[0] : 0;
        const braceRadius = settings.braceDiameterMm / 2;

        const usedRootPositions: Vec3[] = [];

        for (let i = 0; i < numBracesNeeded; i++) {
            const angleOffset = numBracesNeeded === 2 ? (i === 0 ? 0 : existingAxis + Math.PI / 2) : (existingAxis + Math.PI / 2);
            let dropDist = GENERATION_DISTANCE_MM;
            let finalRootPos: Vec3 | null = null;
            let chosenAnchor: CandidateAnchor | null = null;

            // Iterate through possible anchor points (highest first)
            for (const anchor of candidateAnchors) {
                // Calculate the lateral drift of the trunk up to THIS anchor so we can mirror it
                const trunkDx = anchor.pos.x - rootPos.x;
                const trunkDy = anchor.pos.y - rootPos.y;

                // Simple iterative solver to find a non-colliding drop from this anchor
                for (let attempt = 0; attempt < 8; attempt++) { 
                    const angle = angleOffset + (attempt % 2 === 0 ? 0 : Math.PI); // Try opposite side if first fails
                    const currentDist = dropDist + Math.floor(attempt / 2) * 2; // Expand distance slowly

                    if (currentDist > maxHorizontalRun) break; // Don't generate out of connection range

                    // Calculate the top anchor point offset from the trunk
                    const topAnchorX = anchor.pos.x + Math.cos(angle) * currentDist;
                    const topAnchorY = anchor.pos.y + Math.sin(angle) * currentDist;

                    // Drop parallel to the trunk: subtract the trunk's lateral drift from the top anchor
                    let candidateRootX = topAnchorX - trunkDx;
                    let candidateRootY = topAnchorY - trunkDy;

                    if (gridSettings.enabled) {
                        const gx = snapToGridIndex(candidateRootX, gridSettings.spacingMm);
                        const gy = snapToGridIndex(candidateRootY, gridSettings.spacingMm);
                        candidateRootX = gx * gridSettings.spacingMm;
                        candidateRootY = gy * gridSettings.spacingMm;
                    }

                    const candidateRootPos = {
                        x: candidateRootX,
                        y: candidateRootY,
                        z: 0 // Drop to build plate
                    };

                    // Prevent generating exactly on top of an already placed support brace root
                    const isOverlapping = usedRootPositions.some(used => 
                        Math.abs(used.x - candidateRootX) < 0.1 && Math.abs(used.y - candidateRootY) < 0.1
                    );
                    
                    if (isOverlapping) {
                        continue;
                    }

                    const topAnchorPos = { x: topAnchorX, y: topAnchorY, z: anchor.pos.z };

                    if (!checkSlantedCollision(topAnchorPos, candidateRootPos, trunk.modelId, braceRadius + 1.0)) {
                        finalRootPos = candidateRootPos;
                        chosenAnchor = anchor;
                        break;
                    }
                }

                if (finalRootPos) break; // Found a valid drop path, stop walking down the trunk
            }

            if (finalRootPos && chosenAnchor) {
                const hostTarget: SupportBraceHostTarget = {
                    segmentId: chosenAnchor.segmentId,
                    supportKind: 'trunk',
                    t: chosenAnchor.t,
                    pos: chosenAnchor.pos,
                    diameterMm: chosenAnchor.diameterMm
                };

                const buildInput = {
                    modelId: trunk.modelId,
                    rootPos: finalRootPos,
                    host: hostTarget
                };
                
                try {
                    const result = buildSupportBraceData(buildInput);
                    generatedSupportBraces.push(result);
                    
                    const actualAngle = normalizeAxisAngleRad(Math.atan2(finalRootPos.y - rootPos.y, finalRootPos.x - rootPos.x));
                    axes.push(actualAngle);
                    
                    if (i === 0) {
                        existingAxis = actualAngle;
                    }

                    usedRootPositions.push(finalRootPos);
                } catch (err) {
                    console.warn("Failed to build generative Support Brace", err);
                }
            }
        }
    }

    return generatedSupportBraces;
}
