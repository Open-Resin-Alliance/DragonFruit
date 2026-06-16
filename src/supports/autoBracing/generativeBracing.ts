import * as THREE from 'three';
import { buildKickstandData } from '../SupportTypes/Kickstand/kickstandBuilder';
import { snapToGridIndex } from '../PlacementLogic/Grid/gridMath';
import type { KickstandBuildResult, KickstandHostTarget, KickstandState } from '../SupportTypes/Kickstand/types';
import type { SupportState, Trunk, Vec3, Segment, Roots } from '../types';
import { AUTO_BRACING_HARD_RULES, type AutoBracingSettings } from './settings';
import { getAllMeshEntriesForAutoBrace } from './meshGeometryStore';
import { getTrunkSegmentEndpoints } from '../SupportPrimitives/Knot/knotUtils';
import { linePassesMeshClearance } from './meshClearance';
import {
    additionalAxesNeededForTwoAxisBracing,
    hasQualifiedTwoAxisBracing,
    normalizeAxisAngleRad,
} from './twoAxisDetection';

const MIN_HEIGHT_FOR_MANDATORY_BRACING_MM = 15.0;
const DROP_COLLISION_SAMPLES = 20;
const MAX_GRID_ROOT_SEARCH_RING = 1;
const MIN_ROOT_PROXIMITY_CLEARANCE_MM = 2.0;

function createVector3(v: Vec3) {
    return new THREE.Vector3(v.x, v.y, v.z);
}

/**
 * Ensures that any trunk over 15mm tall has at least 2-axis bracing.
 * If a trunk lacks bracing, this function calculates the placement for
 * new Kickstands to satisfy the structural requirement.
 */
export function generateRequiredKickstands(
    snapshot: SupportState,
    kickstandState: KickstandState,
    settings: AutoBracingSettings,
    existingBraceEdges: Array<{ a: string; b: string; angleRad: number }>,
    gridSettings: { enabled: boolean; spacingMm: number },
): KickstandBuildResult[] {
    const meshEntries = getAllMeshEntriesForAutoBrace();
    const generatedKickstands: KickstandBuildResult[] = [];

    const maxHorizontalRun = settings.maxBraceLengthMm;
    // We want the new kickstand to generate well within the max run so it definitely connects.
    const GENERATION_DISTANCE_MM = Math.min(5.0, maxHorizontalRun * 0.8);

    const occupiedRootPositions: Vec3[] = [
        ...Object.values(snapshot.roots).map((root) => ({
            x: root.transform.pos.x,
            y: root.transform.pos.y,
            z: root.transform.pos.z,
        })),
        ...Object.values(kickstandState.roots).map((root) => ({
            x: root.transform.pos.x,
            y: root.transform.pos.y,
            z: root.transform.pos.z,
        })),
    ];
    const minRootProximityClearanceSq = MIN_ROOT_PROXIMITY_CLEARANCE_MM * MIN_ROOT_PROXIMITY_CLEARANCE_MM;
    const isCandidateRootTooCloseToExistingRoot = (x: number, y: number): boolean => {
        for (const root of occupiedRootPositions) {
            const dx = root.x - x;
            const dy = root.y - y;
            if (dx * dx + dy * dy <= minRootProximityClearanceSq) {
                return true;
            }
        }
        return false;
    };

    const isGridEnabled = gridSettings.enabled && gridSettings.spacingMm > 0;
    const gridNodeKey = (modelId: string, gx: number, gy: number) => `${modelId}:${gx},${gy}`;
    const occupiedGridNodeKeys = new Set<string>();
    if (isGridEnabled) {
        for (const root of Object.values(snapshot.roots)) {
            const gx = snapToGridIndex(root.transform.pos.x, gridSettings.spacingMm);
            const gy = snapToGridIndex(root.transform.pos.y, gridSettings.spacingMm);
            occupiedGridNodeKeys.add(gridNodeKey(root.modelId, gx, gy));
        }
        for (const root of Object.values(kickstandState.roots)) {
            const gx = snapToGridIndex(root.transform.pos.x, gridSettings.spacingMm);
            const gy = snapToGridIndex(root.transform.pos.y, gridSettings.spacingMm);
            occupiedGridNodeKeys.add(gridNodeKey(root.modelId, gx, gy));
        }
    }

    const isGridNodeOccupied = (modelId: string, gx: number, gy: number): boolean => {
        if (!isGridEnabled) return false;
        return occupiedGridNodeKeys.has(gridNodeKey(modelId, gx, gy));
    };

    const snapToGlobalGrid = (valueMm: number, spacingMm: number): number => {
        const idx = snapToGridIndex(valueMm, spacingMm);
        return idx * spacingMm;
    };

    const findNearestAvailableGridPoint = (
        x: number,
        y: number,
        hostX: number,
        hostY: number,
        modelId: string,
        maxRingOverride?: number,
    ): { x: number; y: number } | null => {
        if (!isGridEnabled) return { x, y };

        const spacing = gridSettings.spacingMm;
        // Hard rule: search must stay within the host-centered grid neighborhood.
        // We then pick the candidate nearest to the desired target point.
        const centerGx = snapToGridIndex(hostX, spacing);
        const centerGy = snapToGridIndex(hostY, spacing);
        const defaultMaxRing = Math.max(1, Math.ceil(maxHorizontalRun / spacing) + 2);
        const maxRing = typeof maxRingOverride === 'number'
            ? Math.max(0, Math.min(defaultMaxRing, maxRingOverride))
            : defaultMaxRing;
        if (maxRing < 1) return null;

        // Match manual support-brace snapping neighborhood: immediate cardinal nodes around host.
        const candidates = [
            { gx: centerGx + 1, gy: centerGy },
            { gx: centerGx - 1, gy: centerGy },
            { gx: centerGx, gy: centerGy + 1 },
            { gx: centerGx, gy: centerGy - 1 },
        ];

        let best: { x: number; y: number; distSq: number } | null = null;
        for (const candidate of candidates) {
            const worldX = candidate.gx * spacing;
            const worldY = candidate.gy * spacing;
            if (isGridNodeOccupied(modelId, candidate.gx, candidate.gy)) continue;
            if (isCandidateRootTooCloseToExistingRoot(worldX, worldY)) continue;

            const ddx = worldX - x;
            const ddy = worldY - y;
            const distSq = ddx * ddx + ddy * ddy;
            if (!best || distSq < best.distSq) {
                best = { x: worldX, y: worldY, distSq };
            }
        }

        if (best) {
            return { x: best.x, y: best.y };
        }

        return null;
    };

    const toCanonicalGridPoint = (x: number, y: number): { x: number; y: number } => {
        const snappedX = snapToGlobalGrid(x, gridSettings.spacingMm);
        const snappedY = snapToGlobalGrid(y, gridSettings.spacingMm);
        return {
            x: snappedX,
            y: snappedY,
        };
    };

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

    // Mix in axes from existing Kickstands already hosted on this trunk
    for (const sb of Object.values(kickstandState.kickstands)) {
        const hostTrunkId = segmentOwnerTrunkId.get(sb.hostSegmentId);
        if (!hostTrunkId) continue;
        
        const root = kickstandState.roots[sb.rootId];
        const hostKnot = kickstandState.knots[sb.hostKnotId];
        if (!root || !hostKnot) continue;

        const angleRad = normalizeAxisAngleRad(Math.atan2(root.transform.pos.y - hostKnot.pos.y, root.transform.pos.x - hostKnot.pos.x));
        
        const list = axesByTrunkId.get(hostTrunkId) || [];
        list.push(angleRad);
        axesByTrunkId.set(hostTrunkId, list);
    }

    // Build connected trunk groups using trunk-to-trunk brace edges and gather group-level axes.
    // Generative support-brace decisions should be based on group axis coverage, not only per-trunk axes.
    const trunkAdjacency = new Map<string, Set<string>>();
    for (const trunkId of Object.keys(snapshot.trunks)) {
        trunkAdjacency.set(trunkId, new Set<string>());
    }
    for (const edge of existingBraceEdges) {
        if (!trunkAdjacency.has(edge.a) || !trunkAdjacency.has(edge.b)) continue;
        trunkAdjacency.get(edge.a)!.add(edge.b);
        trunkAdjacency.get(edge.b)!.add(edge.a);
    }

    const visitedTrunks = new Set<string>();
    const groupIdByTrunkId = new Map<string, string>();
    const groupAxesByGroupId = new Map<string, number[]>();
    const remainingBracesNeededByGroupId = new Map<string, number>();
    for (const trunkId of Object.keys(snapshot.trunks)) {
        if (visitedTrunks.has(trunkId)) continue;

        const members: string[] = [];
        const queue: string[] = [trunkId];
        visitedTrunks.add(trunkId);

        for (let cursor = 0; cursor < queue.length; cursor += 1) {
            const current = queue[cursor];
            members.push(current);

            const neighbors = trunkAdjacency.get(current);
            if (!neighbors) continue;
            for (const neighborId of neighbors) {
                if (visitedTrunks.has(neighborId)) continue;
                visitedTrunks.add(neighborId);
                queue.push(neighborId);
            }
        }

        const memberSet = new Set(members);
        const groupAxes = existingBraceEdges
            .filter((edge) => memberSet.has(edge.a) && memberSet.has(edge.b))
            .map((edge) => edge.angleRad);

        const groupId = members[0] ?? trunkId;
        const groupAxesState = [...groupAxes];
        groupAxesByGroupId.set(groupId, groupAxesState);
        remainingBracesNeededByGroupId.set(
            groupId,
            additionalAxesNeededForTwoAxisBracing(groupAxesState, AUTO_BRACING_HARD_RULES.minAxisSeparationDeg),
        );

        for (const memberId of members) {
            groupIdByTrunkId.set(memberId, groupId);
        }
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

    const builtKickstandPassesMeshClearance = (build: KickstandBuildResult, modelId: string): boolean => {
        const bodyDiameterMm = Math.max(0.001, build.kickstand.profile.bodyDiameterMm);
        const rootPos = build.root.transform.pos;
        const rootTop: Vec3 = {
            x: rootPos.x,
            y: rootPos.y,
            z: rootPos.z + build.root.diskHeight + build.root.coneHeight,
        };

        const pathPoints: Vec3[] = [rootTop];
        for (const segment of build.kickstand.segments) {
            if (segment.bottomJoint) pathPoints.push(segment.bottomJoint.pos);
            if (segment.topJoint) pathPoints.push(segment.topJoint.pos);
        }
        pathPoints.push(build.hostKnot.pos);

        for (let i = 0; i < pathPoints.length - 1; i += 1) {
            const a = pathPoints[i];
            const b = pathPoints[i + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dz = b.z - a.z;
            if (dx * dx + dy * dy + dz * dz < 0.000001) continue;
            if (!linePassesMeshClearance(a, b, modelId, bodyDiameterMm)) return false;
        }

        return true;
    };

    // Two-phase generation:
    // Pass 1 = normal generation flow.
    // Pass 2 = cleanup retry for groups still missing true two-axis bracing.
    for (let passIndex = 0; passIndex < 2; passIndex += 1) {
        const isCleanupPass = passIndex === 1;

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

        const localAxes = axesByTrunkId.get(trunk.id) || [];
        const groupId = groupIdByTrunkId.get(trunk.id) ?? trunk.id;
        const groupAxesState = groupAxesByGroupId.get(groupId) ?? [];
        const decisionAxes = [...groupAxesState];
        const hasTwoAxis = hasQualifiedTwoAxisBracing(decisionAxes, AUTO_BRACING_HARD_RULES.minAxisSeparationDeg);
        let remainingGroupNeed = remainingBracesNeededByGroupId.get(groupId) ?? 0;

        if (hasTwoAxis || remainingGroupNeed <= 0) continue;

        // Needs extra bracing!
        const maxBracesToGenerate = Math.min(2, Math.max(1, remainingGroupNeed));
        
        if (candidateAnchors.length === 0) continue;
        
        // Sort anchors highest to lowest so we attach as high as possible
        candidateAnchors.sort((a, b) => b.pos.z - a.pos.z);

        const rootPos = root.transform.pos;
        const gridOriginX = rootPos.x;
        const gridOriginY = rootPos.y;
        let existingAxis = decisionAxes.length > 0
            ? decisionAxes[0]
            : (localAxes.length > 0 ? localAxes[0] : 0);

        const generatedAxes = [...decisionAxes];

        const usedRootPositions: Vec3[] = [];

        for (let i = 0; i < maxBracesToGenerate; i++) {
            if (hasQualifiedTwoAxisBracing(generatedAxes, AUTO_BRACING_HARD_RULES.minAxisSeparationDeg) || remainingGroupNeed <= 0) {
                break;
            }

            const angleOffset = maxBracesToGenerate === 2
                ? (i === 0 ? 0 : existingAxis + Math.PI / 2)
                : (existingAxis + Math.PI / 2);
            const dropDist = GENERATION_DISTANCE_MM;
            let selectedBuild: KickstandBuildResult | null = null;
            let selectedRootPos: Vec3 | null = null;

            // Iterate through possible anchor points (highest first)
            for (const anchor of candidateAnchors) {
                // Calculate the lateral drift of the trunk up to THIS anchor so we can mirror it
                const trunkDx = anchor.pos.x - rootPos.x;
                const trunkDy = anchor.pos.y - rootPos.y;

                // Simple iterative solver to find a non-colliding drop from this anchor
                const maxAttempts = isCleanupPass ? 12 : 8;
                for (let attempt = 0; attempt < maxAttempts; attempt++) {
                    let angle = angleOffset + (attempt % 2 === 0 ? 0 : Math.PI);
                    if (isCleanupPass) {
                        const cleanupPhase = attempt % 6;
                        if (cleanupPhase === 2) {
                            angle = existingAxis + Math.PI / 2;
                        } else if (cleanupPhase === 3) {
                            angle = existingAxis + (3 * Math.PI) / 2;
                        } else if (cleanupPhase === 4) {
                            angle = existingAxis;
                        } else if (cleanupPhase === 5) {
                            angle = existingAxis + Math.PI;
                        }
                    }
                    const currentDist = isGridEnabled
                        ? dropDist
                        : dropDist + Math.floor(attempt / 2) * 2; // Expand only in non-grid mode

                    if (currentDist > maxHorizontalRun) break; // Don't generate out of connection range

                    // Calculate the top anchor point offset from the trunk
                    const topAnchorX = anchor.pos.x + Math.cos(angle) * currentDist;
                    const topAnchorY = anchor.pos.y + Math.sin(angle) * currentDist;

                    // Drop parallel to the trunk: subtract the trunk's lateral drift from the top anchor
                    let candidateRootX = topAnchorX - trunkDx;
                    let candidateRootY = topAnchorY - trunkDy;

                    if (isGridEnabled) {
                        const snapped = findNearestAvailableGridPoint(
                            candidateRootX,
                            candidateRootY,
                            gridOriginX,
                            gridOriginY,
                            trunk.modelId,
                            MAX_GRID_ROOT_SEARCH_RING,
                        );
                        if (!snapped) continue;
                        const canonical = toCanonicalGridPoint(snapped.x, snapped.y);
                        candidateRootX = canonical.x;
                        candidateRootY = canonical.y;

                        const hostGx = snapToGridIndex(rootPos.x, gridSettings.spacingMm);
                        const hostGy = snapToGridIndex(rootPos.y, gridSettings.spacingMm);
                        const candidateGx = snapToGridIndex(candidateRootX, gridSettings.spacingMm);
                        const candidateGy = snapToGridIndex(candidateRootY, gridSettings.spacingMm);
                        if (Math.abs(candidateGx - hostGx) > 1 || Math.abs(candidateGy - hostGy) > 1) {
                            continue;
                        }
                    }

                    const candidateRootPos = {
                        x: candidateRootX,
                        y: candidateRootY,
                        z: 0 // Drop to build plate
                    };

                    const hostDx = candidateRootX - anchor.pos.x;
                    const hostDy = candidateRootY - anchor.pos.y;
                    if (hostDx * hostDx + hostDy * hostDy <= minRootProximityClearanceSq) {
                        continue;
                    }

                    const hostRootDx = candidateRootX - rootPos.x;
                    const hostRootDy = candidateRootY - rootPos.y;
                    if (hostRootDx * hostRootDx + hostRootDy * hostRootDy <= minRootProximityClearanceSq) {
                        continue;
                    }

                    const hostSegDx = anchor.pos.x - rootPos.x;
                    const hostSegDy = anchor.pos.y - rootPos.y;
                    const hostSegLenSq = hostSegDx * hostSegDx + hostSegDy * hostSegDy;
                    if (hostSegLenSq > 0.000001) {
                        const t = Math.max(0, Math.min(1,
                            ((candidateRootX - rootPos.x) * hostSegDx + (candidateRootY - rootPos.y) * hostSegDy) / hostSegLenSq,
                        ));
                        const nearestX = rootPos.x + hostSegDx * t;
                        const nearestY = rootPos.y + hostSegDy * t;
                        const shaftDx = candidateRootX - nearestX;
                        const shaftDy = candidateRootY - nearestY;
                        if (shaftDx * shaftDx + shaftDy * shaftDy <= minRootProximityClearanceSq) {
                            continue;
                        }
                    } else {
                        // Degenerate host projection fallback: treat as host point clearance.
                        const rootPointDx = candidateRootX - rootPos.x;
                        const rootPointDy = candidateRootY - rootPos.y;
                        if (rootPointDx * rootPointDx + rootPointDy * rootPointDy <= minRootProximityClearanceSq) {
                            continue;
                        }
                    }

                    if (isCandidateRootTooCloseToExistingRoot(candidateRootX, candidateRootY)) {
                        continue;
                    }

                    // Prevent generating exactly on top of an already placed kickstand root
                    const isOverlapping = usedRootPositions.some(used => 
                        Math.abs(used.x - candidateRootX) < 0.1 && Math.abs(used.y - candidateRootY) < 0.1
                    );
                    
                    if (isOverlapping) {
                        continue;
                    }

                    const topAnchorPos = { x: topAnchorX, y: topAnchorY, z: anchor.pos.z };

                    if (!linePassesMeshClearance(topAnchorPos, anchor.pos, trunk.modelId, anchor.diameterMm)) {
                        continue;
                    }

                    const candidateBraceRadius = Math.max(0.001, anchor.diameterMm / 2);
                    if (checkSlantedCollision(topAnchorPos, candidateRootPos, trunk.modelId, candidateBraceRadius + 1.0)) {
                        continue;
                    }

                    const hostTarget: KickstandHostTarget = {
                        segmentId: anchor.segmentId,
                        supportKind: 'trunk',
                        t: anchor.t,
                        pos: anchor.pos,
                        diameterMm: anchor.diameterMm,
                    };

                    const buildInput = {
                        modelId: trunk.modelId,
                        rootPos: candidateRootPos,
                        host: hostTarget,
                    };

                    try {
                        const trialBuild = buildKickstandData(buildInput);
                        if (!builtKickstandPassesMeshClearance(trialBuild, trunk.modelId)) {
                            continue;
                        }

                        selectedBuild = trialBuild;
                        selectedRootPos = candidateRootPos;
                        break;
                    } catch (err) {
                        console.warn("Failed to build generative Kickstand", err);
                    }
                }

                if (selectedBuild && selectedRootPos) break; // Found a valid drop path, stop walking down the trunk
            }

            if (selectedBuild && selectedRootPos) {
                const actualAngle = normalizeAxisAngleRad(Math.atan2(selectedRootPos.y - rootPos.y, selectedRootPos.x - rootPos.x));
                const needBefore = additionalAxesNeededForTwoAxisBracing(
                    groupAxesState,
                    AUTO_BRACING_HARD_RULES.minAxisSeparationDeg,
                );
                const needAfter = additionalAxesNeededForTwoAxisBracing(
                    [...groupAxesState, actualAngle],
                    AUTO_BRACING_HARD_RULES.minAxisSeparationDeg,
                );
                // Accept only if this kickstand actually improves group axis coverage.
                // This prevents placing one-axis duplicates on every support in a straight chain.
                if (needAfter >= needBefore) {
                    continue;
                }

                generatedKickstands.push(selectedBuild);

                if (isGridEnabled) {
                    const gx = snapToGridIndex(selectedRootPos.x, gridSettings.spacingMm);
                    const gy = snapToGridIndex(selectedRootPos.y, gridSettings.spacingMm);
                    occupiedGridNodeKeys.add(gridNodeKey(trunk.modelId, gx, gy));
                }
                occupiedRootPositions.push(selectedRootPos);

                generatedAxes.push(actualAngle);
                groupAxesState.push(actualAngle);
                remainingGroupNeed = needAfter;
                remainingBracesNeededByGroupId.set(groupId, remainingGroupNeed);

                if (i === 0) {
                    existingAxis = actualAngle;
                }

                usedRootPositions.push(selectedRootPos);
            }
        }
    }
    }

    return generatedKickstands;
}
