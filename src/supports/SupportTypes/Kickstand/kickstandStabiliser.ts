import * as THREE from 'three';
import { buildKickstandData } from './kickstandBuilder';
import { snapToGridIndex } from '../../PlacementLogic/Grid/gridMath';
import type { KickstandBuildResult, KickstandHostTarget } from './types';
import type { SupportState, Trunk, Vec3, Segment, Roots } from '../../types';
import { AUTO_BRACING_HARD_RULES, type AutoBracingSettings } from '../../autoBracing/settings';
import { getAllMeshEntriesForAutoBrace } from '../../autoBracing/meshGeometryStore';
import { resolveSegmentEndpoints } from '../../SupportPrimitives/Knot/segmentEndpoints';
import { linePassesMeshClearance } from '../../autoBracing/meshClearance';
import { isKickstandHostType, resolveSupportTypeIdOf } from '../../supportTypeRegistry';
import {
    additionalAxesNeededForTwoAxisBracing,
    hasQualifiedTwoAxisBracing,
    normalizeAxisAngleRad,
} from '../../autoBracing/twoAxisDetection';

export const MIN_HEIGHT_FOR_MANDATORY_BRACING_MM = 15.0;
const DROP_COLLISION_SAMPLES = 20;
const MIN_ROOT_PROXIMITY_CLEARANCE_MM = 2.0;


/**
 * Ensures that any trunk over 15mm tall has at least 2-axis bracing.
 * If a trunk lacks bracing, this function calculates the placement for
 * new Kickstands to satisfy the structural requirement.
 */
export function generateRequiredKickstands(
    snapshot: SupportState,
    kickstandState: Pick<SupportState, 'kickstands' | 'roots' | 'knots'>,
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

    const sampleWorld = new THREE.Vector3();
    const sampleLocal = new THREE.Vector3();
    const hitWorld = new THREE.Vector3();
    const worldTri = new THREE.Triangle();
    const inverseTransform = new THREE.Matrix4();
    const resultTarget = {
        point: new THREE.Vector3(),
        distance: 0,
        faceIndex: -1,
    };

    const checkSlantedCollision = (topPos: Vec3, bottomPos: Vec3, modelId: string, radius: number): boolean => {
        const entry = meshEntries.get(modelId);
        if (!entry) return false;

        const bvh = (entry.geometry as any).boundsTree;
        if (!bvh) return false;

        const e = entry.transform.elements;
        const sx = Math.hypot(e[0], e[1], e[2]);
        const sy = Math.hypot(e[4], e[5], e[6]);
        const sz = Math.hypot(e[8], e[9], e[10]);
        const minScale = Math.max(1e-6, Math.min(sx, sy, sz));
        const maxScale = Math.max(sx, sy, sz);
        const isAnisotropic = maxScale - minScale > 1e-4;
        const maxLocalDistance = radius / minScale;
        const radiusSq = radius * radius;

        inverseTransform.copy(entry.transform).invert();

        for (let i = 0; i <= DROP_COLLISION_SAMPLES; i++) {
            const t = i / DROP_COLLISION_SAMPLES;
            sampleWorld.set(
                topPos.x + (bottomPos.x - topPos.x) * t,
                topPos.y + (bottomPos.y - topPos.y) * t,
                topPos.z + (bottomPos.z - topPos.z) * t,
            );
            sampleLocal.copy(sampleWorld).applyMatrix4(inverseTransform);
            if (!isAnisotropic) {
                const result = bvh.closestPointToPoint(sampleLocal, resultTarget, 0, maxLocalDistance);
                if (result) {
                    hitWorld.copy(resultTarget.point).applyMatrix4(entry.transform);
                    if (hitWorld.distanceToSquared(sampleWorld) < radiusSq) {
                        return true; // Collision detected
                    }
                }
            } else {
                const collided = bvh.shapecast({
                    intersectsBounds: (box: THREE.Box3) => box.distanceToPoint(sampleLocal) <= maxLocalDistance,
                    intersectsTriangle: (tri: THREE.Triangle) => {
                        worldTri.a.copy(tri.a).applyMatrix4(entry.transform);
                        worldTri.b.copy(tri.b).applyMatrix4(entry.transform);
                        worldTri.c.copy(tri.c).applyMatrix4(entry.transform);
                        worldTri.closestPointToPoint(sampleWorld, hitWorld);
                        return hitWorld.distanceToSquared(sampleWorld) < radiusSq;
                    },
                });
                if (collided) {
                    return true;
                }
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

    for (const [trunkIndex, trunk] of Object.values(snapshot.trunks).entries()) {
        const root = snapshot.roots[trunk.rootId];
        if (!root) continue;

        // The kind this kickstand rides is the trunk's OWN type, read off the
        // entity the store stamps, and taken only when the registry says a
        // kickstand may host on it. A trunk that resolves to no such type has
        // nothing for this pass to brace.
        const hostKind = resolveSupportTypeIdOf(trunk);
        if (!hostKind || !isKickstandHostType(hostKind)) continue;

        let maxZ = root.transform.pos.z;
        
        interface CandidateAnchor {
            segmentId: string;
            t: number;
            pos: Vec3;
            diameterMm: number;
        }
        const candidateAnchors: CandidateAnchor[] = [];

        trunk.segments.forEach((seg, idx) => {
            const ep = resolveSegmentEndpoints(trunk, seg, idx, { root });
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
        let existingAxis = decisionAxes.length > 0
            ? decisionAxes[0]
            : (localAxes.length > 0 ? localAxes[0] : 0);

        const generatedAxes = [...decisionAxes];

        const usedRootPositions: Vec3[] = [];

        for (let i = 0; i < maxBracesToGenerate; i++) {
            if (hasQualifiedTwoAxisBracing(generatedAxes, AUTO_BRACING_HARD_RULES.minAxisSeparationDeg) || remainingGroupNeed <= 0) {
                break;
            }

            const needBefore = additionalAxesNeededForTwoAxisBracing(
                groupAxesState,
                AUTO_BRACING_HARD_RULES.minAxisSeparationDeg,
            );
            if (needBefore <= 0) {
                break;
            }

            const angleOffset = maxBracesToGenerate === 2
                ? (i === 0 ? 0 : existingAxis + Math.PI / 2)
                : (existingAxis + Math.PI / 2);
            const dropDist = Math.max(MIN_ROOT_PROXIMITY_CLEARANCE_MM + 0.25, GENERATION_DISTANCE_MM);
            let selectedBuild = null as KickstandBuildResult | null;
            let selectedRootPos = null as Vec3 | null;
            let selectedGridNode = null as { gx: number; gy: number } | null;
            let selectedRootDistSq = Infinity;

            // Iterate through possible anchor points (highest first)
            for (const [anchorIndex, anchor] of candidateAnchors.entries()) {
                // Calculate the lateral drift of the trunk up to THIS anchor so we can mirror it
                const trunkDx = anchor.pos.x - rootPos.x;
                const trunkDy = anchor.pos.y - rootPos.y;
                let attemptCounter = 0;

                const evaluateCandidateRoot = (
                    candidateRootX: number,
                    candidateRootY: number,
                    gridNode: { gx: number; gy: number } | null,
                ): void => {
                    if (gridNode && isGridNodeOccupied(trunk.modelId, gridNode.gx, gridNode.gy)) {
                        return;
                    }

                    const candidateAxis = normalizeAxisAngleRad(
                        Math.atan2(candidateRootY - rootPos.y, candidateRootX - rootPos.x),
                    );
                    const candidateNeedAfter = additionalAxesNeededForTwoAxisBracing(
                        [...groupAxesState, candidateAxis],
                        AUTO_BRACING_HARD_RULES.minAxisSeparationDeg,
                    );
                    if (candidateNeedAfter >= needBefore) {
                        return;
                    }

                    const hostDx = candidateRootX - anchor.pos.x;
                    const hostDy = candidateRootY - anchor.pos.y;
                    if (hostDx * hostDx + hostDy * hostDy <= minRootProximityClearanceSq) {
                        return;
                    }

                    const hostRootDx = candidateRootX - rootPos.x;
                    const hostRootDy = candidateRootY - rootPos.y;
                    const hostDistSq = hostRootDx * hostRootDx + hostRootDy * hostRootDy;
                    if (hostDistSq <= minRootProximityClearanceSq) {
                        return;
                    }

                    if (selectedBuild && hostDistSq >= selectedRootDistSq) {
                        return;
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
                            return;
                        }
                    } else {
                        // Degenerate host projection fallback: treat as host point clearance.
                        const rootPointDx = candidateRootX - rootPos.x;
                        const rootPointDy = candidateRootY - rootPos.y;
                        if (rootPointDx * rootPointDx + rootPointDy * rootPointDy <= minRootProximityClearanceSq) {
                            return;
                        }
                    }

                    if (isCandidateRootTooCloseToExistingRoot(candidateRootX, candidateRootY)) {
                        return;
                    }

                    // Prevent generating exactly on top of an already placed kickstand root
                    const isOverlapping = usedRootPositions.some((used) =>
                        Math.abs(used.x - candidateRootX) < 0.1 && Math.abs(used.y - candidateRootY) < 0.1,
                    );
                    if (isOverlapping) {
                        return;
                    }

                    const candidateRootPos: Vec3 = {
                        x: candidateRootX,
                        y: candidateRootY,
                        z: 0, // Drop to build plate
                    };
                    const topAnchorPos: Vec3 = {
                        x: candidateRootX + trunkDx,
                        y: candidateRootY + trunkDy,
                        z: anchor.pos.z,
                    };

                    if (!linePassesMeshClearance(topAnchorPos, anchor.pos, trunk.modelId, anchor.diameterMm)) {
                        return;
                    }

                    const candidateBraceRadius = Math.max(0.001, anchor.diameterMm / 2);
                    if (checkSlantedCollision(topAnchorPos, candidateRootPos, trunk.modelId, candidateBraceRadius + 1.0)) {
                        return;
                    }

                    const attemptId = attemptCounter;
                    attemptCounter += 1;

                    const hostTarget: KickstandHostTarget = {
                        segmentId: anchor.segmentId,
                        supportKind: hostKind,
                        t: anchor.t,
                        pos: anchor.pos,
                        diameterMm: anchor.diameterMm,
                    };

                    const buildInput = {
                        modelId: trunk.modelId,
                        rootPos: candidateRootPos,
                        host: hostTarget,
                        idSeed: `auto-ks-${passIndex}-${trunkIndex}-${i}-${anchorIndex}-${attemptId}`,
                    };

                    try {
                        const trialBuild = buildKickstandData(buildInput);
                        // The same gate a manual placement applies. A build
                        // error means the terminal cannot reach the host at a
                        // legal angle (or runs through the model), leaving a
                        // column beside the trunk rather than a kickstand.
                        if (trialBuild.error) return;
                        if (!builtKickstandPassesMeshClearance(trialBuild, trunk.modelId)) {
                            return;
                        }

                        // Prefer the SNUGGEST valid root: the mirrored side
                        // of the same axis (angle vs angle+π) is equivalent
                        // for axis coverage, so keep whichever sits closer to
                        // the host — minimal plate footprint, stable across
                        // re-runs. Never break on the first valid drop.
                        if (!selectedBuild || hostDistSq < selectedRootDistSq) {
                            selectedBuild = trialBuild;
                            selectedRootPos = candidateRootPos;
                            selectedGridNode = gridNode;
                            selectedRootDistSq = hostDistSq;
                        }
                    } catch (err) {
                        console.warn("Failed to build generative Kickstand", err);
                    }
                };

                if (isGridEnabled) {
                    const spacing = gridSettings.spacingMm;
                    const hostGx = snapToGridIndex(rootPos.x, spacing);
                    const hostGy = snapToGridIndex(rootPos.y, spacing);
                    const kMin = Math.max(1, Math.ceil((MIN_ROOT_PROXIMITY_CLEARANCE_MM + 0.05) / spacing));
                    const kMax = Math.max(kMin, Math.ceil(maxHorizontalRun / spacing));
                    const preferXAxis = Math.abs(Math.cos(angleOffset)) >= Math.abs(Math.sin(angleOffset));

                    // Tier 1: Cardinal grid ring slots (hostGx ± k, hostGy) and (hostGx, hostGy ± k)
                    for (let k = kMin; k <= kMax; k++) {
                        const xPair = [
                            { gx: hostGx + k, gy: hostGy },
                            { gx: hostGx - k, gy: hostGy },
                        ];
                        const yPair = [
                            { gx: hostGx, gy: hostGy + k },
                            { gx: hostGx, gy: hostGy - k },
                        ];
                        const orderedPairs = preferXAxis ? [xPair, yPair] : [yPair, xPair];
                        for (const pair of orderedPairs) {
                            for (const slot of pair) {
                                const worldX = slot.gx * spacing;
                                const worldY = slot.gy * spacing;
                                const dist = Math.hypot(worldX - rootPos.x, worldY - rootPos.y);
                                if (dist <= MIN_ROOT_PROXIMITY_CLEARANCE_MM || dist > maxHorizontalRun + 1e-6) {
                                    continue;
                                }
                                evaluateCandidateRoot(worldX, worldY, slot);
                            }
                            if (selectedBuild) break;
                        }
                        if (selectedBuild) break;
                    }

                    // Tier 2: Non-cardinal grid perimeter slots (Math.max(|dx|, |dy|) === k)
                    if (!selectedBuild) {
                        for (let k = kMin; k <= kMax; k++) {
                            const perimeterSlots: Array<{
                                gx: number;
                                gy: number;
                                worldX: number;
                                worldY: number;
                                dist: number;
                                align: number;
                            }> = [];
                            for (let dx = -k; dx <= k; dx++) {
                                for (let dy = -k; dy <= k; dy++) {
                                    if (dx === 0 || dy === 0) continue;
                                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== k) continue;
                                    const gx = hostGx + dx;
                                    const gy = hostGy + dy;
                                    const worldX = gx * spacing;
                                    const worldY = gy * spacing;
                                    const dist = Math.hypot(worldX - rootPos.x, worldY - rootPos.y);
                                    if (dist <= MIN_ROOT_PROXIMITY_CLEARANCE_MM || dist > maxHorizontalRun + 1e-6) {
                                        continue;
                                    }
                                    const slotAngle = Math.atan2(worldY - rootPos.y, worldX - rootPos.x);
                                    const align = Math.abs(Math.cos(slotAngle - angleOffset));
                                    perimeterSlots.push({ gx, gy, worldX, worldY, dist, align });
                                }
                            }
                            perimeterSlots.sort((a, b) => (b.align - a.align) || (a.dist - b.dist));
                            for (const slot of perimeterSlots) {
                                evaluateCandidateRoot(slot.worldX, slot.worldY, { gx: slot.gx, gy: slot.gy });
                            }
                            if (selectedBuild) break;
                        }
                    }

                    // Tier 3: Continuous radial fallback when all grid slots in [kMin, kMax] are occupied or obstructed
                    if (!selectedBuild) {
                        const radialStart = MIN_ROOT_PROXIMITY_CLEARANCE_MM + 0.25;
                        const radialStep = 1.0;
                        const angleCandidates = [
                            angleOffset,
                            angleOffset + Math.PI,
                            angleOffset + Math.PI / 2,
                            angleOffset + (3 * Math.PI) / 2,
                            angleOffset + Math.PI / 4,
                            angleOffset + (5 * Math.PI) / 4,
                            angleOffset + (3 * Math.PI) / 4,
                            angleOffset + (7 * Math.PI) / 4,
                        ];
                        for (let currentDist = radialStart; currentDist <= maxHorizontalRun + 1e-6; currentDist += radialStep) {
                            const clampedDist = Math.min(currentDist, maxHorizontalRun);
                            if (clampedDist <= MIN_ROOT_PROXIMITY_CLEARANCE_MM) continue;
                            for (const angle of angleCandidates) {
                                const topAnchorX = anchor.pos.x + Math.cos(angle) * clampedDist;
                                const topAnchorY = anchor.pos.y + Math.sin(angle) * clampedDist;
                                const candidateRootX = topAnchorX - trunkDx;
                                const candidateRootY = topAnchorY - trunkDy;
                                evaluateCandidateRoot(candidateRootX, candidateRootY, null);
                            }
                            if (selectedBuild || clampedDist >= maxHorizontalRun) break;
                        }
                    }
                } else {
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
                        const currentDist = dropDist + Math.floor(attempt / 2) * 2;
                        if (currentDist > maxHorizontalRun) break; // Don't generate out of connection range

                        // Calculate the top anchor point offset from the trunk
                        const topAnchorX = anchor.pos.x + Math.cos(angle) * currentDist;
                        const topAnchorY = anchor.pos.y + Math.sin(angle) * currentDist;

                        // Drop parallel to the trunk: subtract the trunk's lateral drift from the top anchor
                        const candidateRootX = topAnchorX - trunkDx;
                        const candidateRootY = topAnchorY - trunkDy;
                        evaluateCandidateRoot(candidateRootX, candidateRootY, null);
                    }
                }

                if (selectedBuild && selectedRootPos) break; // Found a valid drop path, stop walking down the trunk
            }

            if (selectedBuild && selectedRootPos) {
                const actualAngle = normalizeAxisAngleRad(Math.atan2(selectedRootPos.y - rootPos.y, selectedRootPos.x - rootPos.x));
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

                if (isGridEnabled && selectedGridNode) {
                    occupiedGridNodeKeys.add(gridNodeKey(trunk.modelId, selectedGridNode.gx, selectedGridNode.gy));
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
