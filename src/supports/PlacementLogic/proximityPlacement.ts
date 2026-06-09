import type { Knot, SupportState, Trunk, Branch, Stick, Vec3, Segment } from '../types';
import type { SupportSettings } from '../Settings/types';
import type { TrunkBuildResult } from '../SupportTypes/Trunk/trunkBuilder';
import type { SupportData } from '../rendering/SupportBuilder';
import { buildBranchData } from '../SupportTypes/Branch/branchBuilder';
import { buildLeafData } from '../SupportTypes/Leaf/leafBuilder';
import { getFinalSocketPosition } from '../SupportPrimitives/ContactCone';
import { calculateKnotPositionOnSegmentFromT } from '../SupportPrimitives/Knot/knotUtils';
import { checkShaftCollision } from './CollisionUtils';
import { generateUuid } from '../../utils/uuid';
import * as THREE from 'three';

export interface DecideOrganicPlacementArgs {
    settings: SupportSettings;
    snapshot: SupportState;
    candidate: TrunkBuildResult;
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    mesh?: THREE.Mesh;
}

export type OrganicPlacementDecision =
    | {
          kind: 'place_trunk';
          trunkBuild: TrunkBuildResult;
          nodeKey: string;
      }
    | {
          kind: 'place_branch';
          nodeKey: string;
          hostTrunkId: string;
          knot: Knot;
          branch: ReturnType<typeof buildBranchData>['branch'];
          supportData: SupportData;
      }
    | {
          kind: 'place_leaf';
          nodeKey: string;
          hostTrunkId: string;
          knot: Knot;
          leaf: ReturnType<typeof buildLeafData>['leaf'];
          supportData: SupportData;
      }
    | {
          kind: 'reject';
          nodeKey: string;
          reason: string;
          trunkBuild?: TrunkBuildResult;
      };

const MAX_VERTICAL_ATTACHMENT_DISTANCE_MM = 40.0;
const MAX_HORIZONTAL_ATTACHMENT_DISTANCE_MM = 15.0;
const MIN_HORIZONTAL_LEAF_ANGLE_DEG = 30.0;
const MAX_LEAF_STRETCH_FACTOR = 2.0;
const MAX_CONE_ANGLE_DEV_DEG = 30.0;
const VERTICAL_KNOT_SPACING_MM = 3.0;
const MAX_BRANCHES_PER_TRUNK = 3;

function findEntityIdBySegmentId(segmentId: string, snapshot: SupportState): string | null {
    for (const [id, trunk] of Object.entries(snapshot.trunks)) {
        if (trunk.segments.some((s) => s.id === segmentId)) return id;
    }
    for (const [id, branch] of Object.entries(snapshot.branches)) {
        if (branch.segments.some((s) => s.id === segmentId)) return id;
    }
    for (const [id, stick] of Object.entries(snapshot.sticks)) {
        if (stick.segments.some((s) => s.id === segmentId)) return id;
    }
    return null;
}

function getRootTrunkId(entityId: string, snapshot: SupportState): string {
    if (snapshot.trunks[entityId]) return entityId;
    const branch = snapshot.branches[entityId];
    if (branch) {
        const knot = snapshot.knots[branch.parentKnotId];
        if (knot) {
            const parentEntityId = findEntityIdBySegmentId(knot.parentShaftId, snapshot);
            if (parentEntityId) {
                return getRootTrunkId(parentEntityId, snapshot);
            }
        }
    }
    return entityId; // Fallback or stick
}

function getHostTreeId(segmentId: string, snapshot: SupportState): string | null {
    const entityId = findEntityIdBySegmentId(segmentId, snapshot);
    if (!entityId) return null;
    return getRootTrunkId(entityId, snapshot);
}

export function getSegmentEndpoints(
    entity: Trunk | Branch | Stick,
    segmentIndex: number,
    snapshot: SupportState,
    settings: SupportSettings
): { start: Vec3; end: Vec3 } | null {
    const segment = entity.segments[segmentIndex];
    if (!segment) return null;

    if ('rootId' in entity) {
        // Trunk
        const root = snapshot.roots[entity.rootId];
        if (!root) return null;
        const diskHeight = settings.roots.diskHeightMm;
        const flareEnabled = settings.baseFlare?.enabled;
        const coneHeight = flareEnabled ? settings.baseFlare.heightMm : settings.roots.coneHeightMm;
        const effectiveConeHeight = flareEnabled ? coneHeight : 0;
        const basePos = root.transform.pos;

        let start: Vec3;
        if (segment.bottomJoint) {
            start = segment.bottomJoint.pos;
        } else if (segmentIndex === 0) {
            start = {
                x: basePos.x,
                y: basePos.y,
                z: basePos.z + diskHeight + effectiveConeHeight,
            };
        } else {
            const prev = entity.segments[segmentIndex - 1];
            if (prev?.topJoint) {
                start = prev.topJoint.pos;
            } else {
                start = {
                    x: basePos.x,
                    y: basePos.y,
                    z: basePos.z + diskHeight + effectiveConeHeight,
                };
            }
        }

        let end: Vec3;
        if (segment.topJoint) {
            end = segment.topJoint.pos;
        } else if (entity.contactCone) {
            end = getFinalSocketPosition(entity.contactCone);
        } else {
            end = { x: start.x, y: start.y, z: start.z + 10 };
        }
        return { start, end };
    } else if ('parentKnotId' in entity) {
        // Branch
        const parentKnot = snapshot.knots[entity.parentKnotId];
        if (!parentKnot) return null;

        let start: Vec3;
        if (segment.bottomJoint) {
            start = segment.bottomJoint.pos;
        } else if (segmentIndex === 0) {
            start = parentKnot.pos;
        } else {
            const prev = entity.segments[segmentIndex - 1];
            if (prev?.topJoint) {
                start = prev.topJoint.pos;
            } else {
                start = parentKnot.pos;
            }
        }

        let end: Vec3;
        if (segment.topJoint) {
            end = segment.topJoint.pos;
        } else if (entity.contactCone) {
            end = getFinalSocketPosition(entity.contactCone);
        } else {
            end = { x: start.x, y: start.y, z: start.z + 10 };
        }
        return { start, end };
    } else {
        // Stick
        let start: Vec3;
        if (segment.bottomJoint) {
            start = segment.bottomJoint.pos;
        } else if (segmentIndex === 0) {
            start = getFinalSocketPosition(entity.contactConeA);
        } else {
            const prev = entity.segments[segmentIndex - 1];
            if (prev?.topJoint) {
                start = prev.topJoint.pos;
            } else {
                start = getFinalSocketPosition(entity.contactConeA);
            }
        }

        let end: Vec3;
        if (segment.topJoint) {
            end = segment.topJoint.pos;
        } else if (segmentIndex === entity.segments.length - 1) {
            end = getFinalSocketPosition(entity.contactConeB);
        } else {
            end = { x: start.x, y: start.y, z: start.z + 10 };
        }
        return { start, end };
    }
}

function getClosestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): { point: Vec3; t: number } {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const lenSq = abx * abx + aby * aby + abz * abz;
    if (lenSq < 1e-8) {
        return { point: { ...a }, t: 0 };
    }
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const apz = p.z - a.z;
    let t = (apx * abx + apy * aby + apz * abz) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return {
        point: {
            x: a.x + t * abx,
            y: a.y + t * aby,
            z: a.z + t * abz,
        },
        t,
    };
}

function satisfiesMinAngleFromHorizontal(tipPos: Vec3, knotPos: Vec3, minAngleDeg: number): boolean {
    const dx = tipPos.x - knotPos.x;
    const dy = tipPos.y - knotPos.y;
    const horizontal = Math.sqrt(dx * dx + dy * dy);
    const vertical = tipPos.z - knotPos.z;
    if (vertical <= 0) return false;

    const minAngleRad = (minAngleDeg * Math.PI) / 180;
    const requiredVertical = horizontal * Math.tan(minAngleRad);
    return vertical >= requiredVertical;
}

function leafCollidesWithMesh(
    knotPos: Vec3,
    tipPos: Vec3,
    tipNormal: Vec3,
    mesh: THREE.Mesh,
    settings: SupportSettings
): boolean {
    const raycaster = new THREE.Raycaster();
    const radius = settings.tip.contactDiameterMm / 2 + 0.1;
    const socketApprox: Vec3 = {
        x: tipPos.x + tipNormal.x * settings.tip.lengthMm,
        y: tipPos.y + tipNormal.y * settings.tip.lengthMm,
        z: tipPos.z + tipNormal.z * settings.tip.lengthMm,
    };
    return checkShaftCollision(knotPos, socketApprox, radius, mesh, raycaster).hit;
}

export function decideOrganicPlacement(args: DecideOrganicPlacementArgs): OrganicPlacementDecision {
    const { settings, snapshot, candidate, tipPos, tipNormal, modelId, mesh } = args;

    const maxVerticalAttachmentDistanceMm = settings.devTools?.maxVerticalAttachmentDistanceMm ?? MAX_VERTICAL_ATTACHMENT_DISTANCE_MM;
    const maxHorizontalAttachmentDistanceMm = settings.devTools?.maxHorizontalAttachmentDistanceMm ?? MAX_HORIZONTAL_ATTACHMENT_DISTANCE_MM;
    const minHorizontalLeafAngleDeg = settings.devTools?.minHorizontalLeafAngleDeg ?? MIN_HORIZONTAL_LEAF_ANGLE_DEG;
    const maxLeafStretchFactor = settings.devTools?.maxLeafStretchFactor ?? MAX_LEAF_STRETCH_FACTOR;
    const maxConeAngleDevDeg = settings.devTools?.maxConeAngleDevDeg ?? MAX_CONE_ANGLE_DEV_DEG;
    const verticalKnotSpacingMm = settings.devTools?.verticalKnotSpacingMm ?? VERTICAL_KNOT_SPACING_MM;
    const maxBranchesPerTrunk = settings.devTools?.maxBranchesPerTrunk ?? MAX_BRANCHES_PER_TRUNK;

    // First, scan all active segments in snapshot
    const activeEntities: { id: string; entity: Trunk | Branch | Stick }[] = [];
    for (const [id, trunk] of Object.entries(snapshot.trunks)) {
        if (trunk.modelId === modelId) activeEntities.push({ id, entity: trunk });
    }
    for (const [id, branch] of Object.entries(snapshot.branches)) {
        if (branch.modelId === modelId) activeEntities.push({ id, entity: branch });
    }
    for (const [id, stick] of Object.entries(snapshot.sticks)) {
        if (stick.modelId === modelId) activeEntities.push({ id, entity: stick });
    }

    // Pre-calculate host tree load counts to avoid redundant loops
    const treeLoadCounts: Record<string, number> = {};
    for (const knot of Object.values(snapshot.knots)) {
        const treeId = getHostTreeId(knot.parentShaftId, snapshot);
        if (treeId) {
            treeLoadCounts[treeId] = (treeLoadCounts[treeId] ?? 0) + 1;
        }
    }

    interface SegmentCandidate {
        entityId: string;
        entity: Trunk | Branch | Stick;
        segment: Segment;
        start: Vec3;
        end: Vec3;
        closestPoint: Vec3;
        dist3D: number;
    }

    const candidates: SegmentCandidate[] = [];
    const searchRadius = settings.grid?.spacingMm ?? 15.0;

    for (const { id: entityId, entity } of activeEntities) {
        // Enforce load limit per trunk tree
        const rootId = getRootTrunkId(entityId, snapshot);
        const load = treeLoadCounts[rootId] ?? 0;
        if (load >= maxBranchesPerTrunk) {
            continue;
        }

        for (let segIndex = 0; segIndex < entity.segments.length; segIndex++) {
            const segment = entity.segments[segIndex];
            const endpoints = getSegmentEndpoints(entity, segIndex, snapshot, settings);
            if (!endpoints) continue;

            const zMin = Math.min(endpoints.start.z, endpoints.end.z);
            if (zMin >= tipPos.z) continue;

            const clippedStart = { ...endpoints.start };
            const clippedEnd = { ...endpoints.end };

            if (endpoints.end.z - endpoints.start.z !== 0) {
                if (clippedEnd.z > tipPos.z) {
                    const tClip = (tipPos.z - endpoints.start.z) / (endpoints.end.z - endpoints.start.z);
                    clippedEnd.x = endpoints.start.x + tClip * (endpoints.end.x - endpoints.start.x);
                    clippedEnd.y = endpoints.start.y + tClip * (endpoints.end.y - endpoints.start.y);
                    clippedEnd.z = tipPos.z;
                }
                if (clippedStart.z > tipPos.z) {
                    const tClip = (tipPos.z - endpoints.end.z) / (endpoints.start.z - endpoints.end.z);
                    clippedStart.x = endpoints.end.x + tClip * (endpoints.start.x - endpoints.end.x);
                    clippedStart.y = endpoints.end.y + tClip * (endpoints.start.y - endpoints.end.y);
                    clippedStart.z = tipPos.z;
                }
            }

            const { point: closestPoint } = getClosestPointOnSegment(tipPos, clippedStart, clippedEnd);

            const dx = tipPos.x - closestPoint.x;
            const dy = tipPos.y - closestPoint.y;
            const dz = tipPos.z - closestPoint.z;
            const dist3D = Math.sqrt(dx * dx + dy * dy + dz * dz);

            if (dist3D > searchRadius) continue;
            if (dz > maxVerticalAttachmentDistanceMm) continue;
            const distHorizontal = Math.sqrt(dx * dx + dy * dy);
            if (distHorizontal > maxHorizontalAttachmentDistanceMm) continue;

            candidates.push({
                entityId,
                entity,
                segment,
                start: endpoints.start,
                end: endpoints.end,
                closestPoint,
                dist3D,
            });
        }
    }

    // Sort candidates by 3D distance to tipPos (closest first)
    candidates.sort((a, b) => a.dist3D - b.dist3D);

    const existingKnots = Object.values(snapshot.knots);

    for (const cand of candidates) {
        const seg = cand.segment;
        const segLen = Math.max(
            0.001,
            Math.sqrt(
                Math.pow(cand.end.x - cand.start.x, 2) +
                Math.pow(cand.end.y - cand.start.y, 2) +
                Math.pow(cand.end.z - cand.start.z, 2)
            )
        );

        // Step by 0.5mm along segment parameter t
        const step = Math.max(0.0005, 0.5 / segLen);

        // --- Down-search for Leaf ---
        for (let t = 1; t >= 0; t -= step) {
            const pos = calculateKnotPositionOnSegmentFromT(cand.start, cand.end, seg, t);

            // Must be below tip
            if (pos.z >= tipPos.z) continue;

            // Enforce vertical knot spacing
            const tooClose = existingKnots.some(
                (k) => k.parentShaftId === seg.id && Math.abs(pos.z - k.pos.z) <= verticalKnotSpacingMm
            );
            if (tooClose) continue;

            // Enforce horizontal leaf angle
            if (!satisfiesMinAngleFromHorizontal(tipPos, pos, minHorizontalLeafAngleDeg)) continue;

            // Check stretch factor limit
            const dx = tipPos.x - pos.x;
            const dy = tipPos.y - pos.y;
            const dz = tipPos.z - pos.z;
            const spanMm = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const nominalConeLength = settings.tip.lengthMm;
            const stretchFactor = spanMm / nominalConeLength;
            if (stretchFactor > maxLeafStretchFactor) continue;

            // Check cone axis angle with face normal
            const axisVec = new THREE.Vector3(dx, dy, dz).normalize();
            const normalVec = new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z).normalize();
            const angleDevDeg = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.max(-1, axisVec.dot(normalVec)))));
            if (angleDevDeg > maxConeAngleDevDeg) continue;

            // Check model collision
            if (mesh && leafCollidesWithMesh(pos, tipPos, tipNormal, mesh, settings)) continue;

            // Found a valid Leaf placement!
            const knot: Knot = {
                id: generateUuid(),
                parentShaftId: seg.id,
                t,
                pos,
                diameter: (seg.diameter ?? settings.shaft.diameterMm) + 0.1,
            };

            const { leaf, supportData } = buildLeafData({
                tipPos,
                surfaceNormal: tipNormal,
                modelId,
                parentKnot: knot,
                hostDiameterMm: Math.max(0.001, (seg.diameter ?? settings.shaft.diameterMm) - 0.1),
                mesh,
            });

            return {
                kind: 'place_leaf',
                nodeKey: 'organic',
                hostTrunkId: cand.entityId,
                knot,
                leaf,
                supportData,
            };
        }

        // --- Promotion to Branch ---
        // If leaf failed, search for the highest valid point below the tip to attach a jointed Branch.
        for (let t = 1; t >= 0; t -= step) {
            const pos = calculateKnotPositionOnSegmentFromT(cand.start, cand.end, seg, t);

            // Must be below tip
            if (pos.z >= tipPos.z) continue;

            // Enforce vertical knot spacing
            const tooClose = existingKnots.some(
                (k) => k.parentShaftId === seg.id && Math.abs(pos.z - k.pos.z) <= verticalKnotSpacingMm
            );
            if (tooClose) continue;

            const knot: Knot = {
                id: generateUuid(),
                parentShaftId: seg.id,
                t,
                pos,
                diameter: (seg.diameter ?? settings.shaft.diameterMm) + 0.1,
            };

            const { branch, supportData } = buildBranchData({
                tipPos,
                tipNormal,
                modelId,
                parentKnot: knot,
                mesh,
            });

            return {
                kind: 'place_branch',
                nodeKey: 'organic',
                hostTrunkId: cand.entityId,
                knot,
                branch,
                supportData,
            };
        }
    }

    // Fall back to placing a direct trunk if no proximity attachment was resolved.
    return {
        kind: 'place_trunk',
        trunkBuild: candidate,
        nodeKey: 'organic',
    };
}
