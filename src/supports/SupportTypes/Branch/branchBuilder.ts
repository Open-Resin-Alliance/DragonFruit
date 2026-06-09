import * as THREE from 'three';
import { Branch, Joint, Knot, Segment, Vec3 } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { recomputeContactConeForMovedDisk } from '../../SupportPrimitives/ContactDisk';
import type { SupportData } from '../../rendering/SupportBuilder';
import { getSettings } from '../../Settings';
import { getJointDiameter } from '../../constants';
import { resolveConeAxisPolicy } from '../../PlacementLogic/ConeAxisPolicy';
import { encodeSupportSettingsHex } from '../../Settings/supportSettingsCodec';
import { isCollisionFrustumBlocked } from '../../PlacementLogic/CollisionAvoidance';

const BRANCH_CONE_COLLISION_SAFETY_MM = 0.3;
// Branch socket search: polar angles from surface normal.  Capped at 30°
// to match the trunk cone axis deviation limit — branches should not bend
// the contact cone drastically away from the attachment surface.
const BRANCH_SOCKET_POLAR_DEG = [0, 10, 20, 30];
const BRANCH_SOCKET_AZIMUTH_DEG = [0, 25, -25, 50, -50, 85, -85, 120, -120, 155, -155, 180];
// Stretch factors: how much to extend the cone beyond nominal length.
// Kept conservative — long stretched cones look unnatural on branches.
const BRANCH_SOCKET_STRETCH_FACTORS = [1, 1.05, 1.12, 1.2];

function normalizeOrFallback(vector: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
    if (vector.lengthSq() < 0.000001) {
        return fallback.clone().normalize();
    }

    return vector.clone().normalize();
}

function getConeStartPosition(cone: ContactCone): Vec3 {
    const surfaceNormal = cone.surfaceNormal ?? cone.normal;
    const thickness = cone.diskLengthOverride ?? (
        cone.profile.type === 'disk'
            ? calculateDiskThickness(surfaceNormal, cone.normal, cone.profile)
            : 0
    );

    return {
        x: cone.pos.x + surfaceNormal.x * thickness,
        y: cone.pos.y + surfaceNormal.y * thickness,
        z: cone.pos.z + surfaceNormal.z * thickness,
    };
}

function isConePlacementClear(cone: ContactCone, mesh?: THREE.Mesh): boolean {
    if (!mesh) return true;

    const coneStart = getConeStartPosition(cone);
    const socketPos = getFinalSocketPosition(cone);
    const contactRadius = (cone.profile.contactDiameterMm / 2) + BRANCH_CONE_COLLISION_SAFETY_MM;
    const bodyRadius = (cone.profile.bodyDiameterMm / 2) + BRANCH_CONE_COLLISION_SAFETY_MM;
    return !isCollisionFrustumBlocked(coneStart, socketPos, contactRadius, bodyRadius, mesh);
}

function buildAuthoredBranchCone(
    tipPos: Vec3,
    tipNormal: Vec3,
    effectiveConeAxis: Vec3,
    tipProfile: SupportTipProfile,
    socketTarget: Vec3,
): ContactCone {
    return recomputeContactConeForMovedDisk(
        {
            id: 'preview-branch-cone',
            pos: tipPos,
            normal: effectiveConeAxis,
            surfaceNormal: tipNormal,
            profile: tipProfile,
        },
        tipPos,
        tipNormal,
        socketTarget,
    );
}

function buildNominalBranchSocketTarget(
    tipPos: Vec3,
    tipNormal: Vec3,
    effectiveConeAxis: Vec3,
    tipProfile: SupportTipProfile,
): Vec3 {
    const nominalCone: ContactCone = {
        id: 'preview-branch-cone',
        pos: tipPos,
        normal: effectiveConeAxis,
        surfaceNormal: tipNormal,
        profile: tipProfile,
    };

    return getFinalSocketPosition(nominalCone);
}

function scoreBranchConeCandidate(args: {
    socketPos: THREE.Vector3;
    desiredSocket: THREE.Vector3;
    cone: ContactCone;
    surfaceNormal: THREE.Vector3;
    desiredDirection: THREE.Vector3;
    nominalLengthMm: number;
}): number {
    const { socketPos, desiredSocket, cone, surfaceNormal, desiredDirection, nominalLengthMm } = args;
    const axis = normalizeOrFallback(
        new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z),
        surfaceNormal,
    );

    const surfaceAlignmentPenalty = (1 - Math.max(-1, Math.min(1, axis.dot(surfaceNormal)))) * 6.75;
    const desiredDirectionPenalty = (1 - Math.max(-1, Math.min(1, axis.dot(desiredDirection)))) * 0.35;
    const socketDistancePenalty = socketPos.distanceTo(desiredSocket) * 0.95;
    const extraLengthMm = Math.max(0, cone.profile.lengthMm - nominalLengthMm);
    const extraLengthPenalty = extraLengthMm * 5.5 + extraLengthMm * extraLengthMm * 1.6;

    return surfaceAlignmentPenalty + desiredDirectionPenalty + socketDistancePenalty + extraLengthPenalty;
}

function findBestBranchConePlacement(args: {
    tipPos: Vec3;
    tipNormal: Vec3;
    effectiveConeAxis: Vec3;
    tipProfile: SupportTipProfile;
    mesh?: THREE.Mesh;
}): { cone: ContactCone; socketPos: Vec3; rerouted: boolean } {
    const { tipPos, tipNormal, effectiveConeAxis, tipProfile, mesh } = args;
    const nominalSocketTarget = buildNominalBranchSocketTarget(
        tipPos,
        tipNormal,
        effectiveConeAxis,
        tipProfile,
    );
    const directCone = buildAuthoredBranchCone(tipPos, tipNormal, effectiveConeAxis, tipProfile, nominalSocketTarget);
    const directSocketPos = getFinalSocketPosition(directCone);

    const surfaceNormal = normalizeOrFallback(
        new THREE.Vector3(tipNormal.x, tipNormal.y, tipNormal.z),
        new THREE.Vector3(0, 0, 1),
    );
    const coneStart = new THREE.Vector3(
        directCone.pos.x + (directCone.surfaceNormal?.x ?? tipNormal.x) * (directCone.diskLengthOverride ?? 0),
        directCone.pos.y + (directCone.surfaceNormal?.y ?? tipNormal.y) * (directCone.diskLengthOverride ?? 0),
        directCone.pos.z + (directCone.surfaceNormal?.z ?? tipNormal.z) * (directCone.diskLengthOverride ?? 0),
    );
    const desiredSocket = new THREE.Vector3(nominalSocketTarget.x, nominalSocketTarget.y, nominalSocketTarget.z);
    const desiredVector = desiredSocket.clone().sub(coneStart);
    const desiredDistance = Math.max(0.25, desiredVector.length());
    const desiredDirection = normalizeOrFallback(desiredVector, surfaceNormal);
    const nominalLengthMm = tipProfile.lengthMm;

    const tangentForward = desiredDirection.clone().sub(
        surfaceNormal.clone().multiplyScalar(desiredDirection.dot(surfaceNormal)),
    );
    if (tangentForward.lengthSq() < 0.000001) {
        tangentForward.copy(new THREE.Vector3(1, 0, 0).cross(surfaceNormal));
        if (tangentForward.lengthSq() < 0.000001) {
            tangentForward.copy(new THREE.Vector3(0, 1, 0).cross(surfaceNormal));
        }
    }
    tangentForward.normalize();
    const tangentRight = new THREE.Vector3().crossVectors(surfaceNormal, tangentForward).normalize();

    let bestCandidate: { cone: ContactCone; socketPos: Vec3; score: number } | null = null;

    if (!mesh || isConePlacementClear(directCone, mesh)) {
        bestCandidate = {
            cone: directCone,
            socketPos: directSocketPos,
            score: scoreBranchConeCandidate({
                socketPos: new THREE.Vector3(directSocketPos.x, directSocketPos.y, directSocketPos.z),
                desiredSocket,
                cone: directCone,
                surfaceNormal,
                desiredDirection,
                nominalLengthMm,
            }),
        };
    }

    for (const polarDeg of BRANCH_SOCKET_POLAR_DEG) {
        const polarRad = THREE.MathUtils.degToRad(polarDeg);
        const sinPolar = Math.sin(polarRad);
        const cosPolar = Math.cos(polarRad);

        for (const azimuthDeg of BRANCH_SOCKET_AZIMUTH_DEG) {
            const azimuthRad = THREE.MathUtils.degToRad(azimuthDeg);
            const tangentComponent = tangentForward.clone().multiplyScalar(Math.cos(azimuthRad) * sinPolar)
                .add(tangentRight.clone().multiplyScalar(Math.sin(azimuthRad) * sinPolar));
            const axis = surfaceNormal.clone().multiplyScalar(cosPolar).add(tangentComponent);
            if (axis.lengthSq() < 0.000001) {
                continue;
            }
            axis.normalize();

            if (axis.dot(surfaceNormal) < 0.12) {
                continue;
            }

            for (const stretch of BRANCH_SOCKET_STRETCH_FACTORS) {
                const candidateLength = Math.max(nominalLengthMm, nominalLengthMm * stretch);
                const candidateSocket = coneStart.clone().add(axis.clone().multiplyScalar(candidateLength));
                const candidateCone = buildAuthoredBranchCone(
                    tipPos,
                    tipNormal,
                    effectiveConeAxis,
                    tipProfile,
                    { x: candidateSocket.x, y: candidateSocket.y, z: candidateSocket.z },
                );

                if (!isConePlacementClear(candidateCone, mesh)) {
                    continue;
                }

                const score = scoreBranchConeCandidate({
                    socketPos: candidateSocket,
                    desiredSocket,
                    cone: candidateCone,
                    surfaceNormal,
                    desiredDirection,
                    nominalLengthMm,
                });

                if (!bestCandidate || score < bestCandidate.score) {
                    bestCandidate = {
                        cone: candidateCone,
                        socketPos: getFinalSocketPosition(candidateCone),
                        score,
                    };
                }
            }
        }
    }

    if (bestCandidate) {
        const rerouted =
            Math.abs(bestCandidate.socketPos.x - directSocketPos.x) > 0.0001
            || Math.abs(bestCandidate.socketPos.y - directSocketPos.y) > 0.0001
            || Math.abs(bestCandidate.socketPos.z - directSocketPos.z) > 0.0001;

        return {
            cone: bestCandidate.cone,
            socketPos: bestCandidate.socketPos,
            rerouted,
        };
    }

    return {
        cone: directCone,
        socketPos: directSocketPos,
        rerouted: false,
    };
}

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

export interface BranchBuildInput {
    tipPos: Vec3;
    tipNormal: Vec3;
    modelId: string;
    parentKnot: Knot;
    mesh?: THREE.Mesh;
}

export interface BranchBuildResult {
    branch: Branch;
    supportData: SupportData;
}

/**
 * Builds a branch with 2 segments and a middle joint (like trunks):
 * - Starts at the parent knot position
 * - Bottom segment: knot -> middle joint
 * - Top segment: middle joint -> socket joint
 * - Contact cone at the tip
 */
export function buildBranchData(input: BranchBuildInput): BranchBuildResult {
    const { tipPos, tipNormal, modelId, parentKnot, mesh } = input;

    const settings = getSettings();
    const settingsCodeHex = encodeSupportSettingsHex(settings);
    const coneAngleMode = settings.tip.coneAngleMode ?? 'normal';
    const adaptiveConeAngleOffsetDeg = settings.tip.adaptiveConeAngleOffsetDeg ?? 30;

    const { coneAxis } = resolveConeAxisPolicy({
        surfaceNormal: tipNormal,
        coneAngleMode,
        adaptiveConeAngleOffsetDeg,
    });

    const effectiveConeAxis = coneAxis ?? tipNormal;
    const tipProfile: SupportTipProfile = {
        type: 'disk',
        contactDiameterMm: settings.tip.contactDiameterMm,
        bodyDiameterMm: settings.tip.bodyDiameterMm,
        lengthMm: settings.tip.lengthMm,
        penetrationMm: settings.tip.penetrationMm,
        diskThicknessMm: 0.1,
        maxStandoffMm: 1.5,
        standoffAngleThreshold: Math.PI / 4,
    };

    const shaftDiameter = settings.shaft.diameterMm;
    const jointDiameter = getJointDiameter(shaftDiameter);
    const { cone: authoredCone, socketPos, rerouted } = findBestBranchConePlacement({
        tipPos,
        tipNormal,
        effectiveConeAxis,
        tipProfile,
        mesh,
    });

    const socketJoint: Joint = {
        id: uuid(),
        pos: socketPos,
        diameter: jointDiameter,
    };

    const knotPos = parentKnot.pos;
    const socketVec = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);
    const knotVec = new THREE.Vector3(knotPos.x, knotPos.y, knotPos.z);
    const span = socketVec.clone().sub(knotVec);
    const spanLength = span.length();
    const spanDirection = spanLength > 0.000001
        ? span.clone().normalize()
        : new THREE.Vector3(authoredCone.normal.x, authoredCone.normal.y, authoredCone.normal.z).normalize();

    const joints: Joint[] = [];
    const segments: Segment[] = [];

    const addJoint = (pos: Vec3): Joint => ({
        id: uuid(),
        pos,
        diameter: jointDiameter,
    });

    if (rerouted && spanLength > 1.8) {
        const approachBackoff = Math.min(Math.max(spanLength * 0.28, 0.9), Math.max(spanLength - 0.65, 0.9));
        const approachVec = socketVec.clone().sub(spanDirection.clone().multiplyScalar(approachBackoff));
        const approachDistanceToKnot = approachVec.distanceTo(knotVec);

        if (approachDistanceToKnot > 0.6) {
            const middleVec = knotVec.clone().lerp(approachVec, 0.5);
            const middleJoint = addJoint({ x: middleVec.x, y: middleVec.y, z: middleVec.z });
            const approachJoint = addJoint({ x: approachVec.x, y: approachVec.y, z: approachVec.z });
            joints.push(middleJoint, approachJoint);

            segments.push(
                {
                    id: uuid(),
                    diameter: shaftDiameter,
                    topJoint: middleJoint,
                    bottomJoint: undefined,
                },
                {
                    id: uuid(),
                    diameter: shaftDiameter,
                    topJoint: approachJoint,
                    bottomJoint: middleJoint,
                },
                {
                    id: uuid(),
                    diameter: shaftDiameter,
                    topJoint: socketJoint,
                    bottomJoint: approachJoint,
                },
            );
        }
    }

    if (segments.length === 0) {
        const middleJointPos: Vec3 = {
            x: (knotPos.x + socketPos.x) / 2,
            y: (knotPos.y + socketPos.y) / 2,
            z: (knotPos.z + socketPos.z) / 2,
        };

        const middleJoint = addJoint(middleJointPos);
        joints.push(middleJoint);

        segments.push(
            {
                id: uuid(),
                diameter: shaftDiameter,
                topJoint: middleJoint,
                bottomJoint: undefined,
            },
            {
                id: uuid(),
                diameter: shaftDiameter,
                topJoint: socketJoint,
                bottomJoint: middleJoint,
            },
        );
    }

    const contactCone: ContactCone = {
        ...authoredCone,
        id: uuid(),
        socketJointId: socketJoint.id,
    };

    const branchId = uuid();
    const branch: Branch = {
        id: branchId,
        modelId,
        settingsCodeHex,
        parentKnotId: parentKnot.id,
        segments,
        contactCone,
    };

    const supportData: SupportData = {
        id: branchId,
        startPos: parentKnot.pos,
        knot: parentKnot,
        segments,
        contactCone,
    };

    return { branch, supportData };
}
