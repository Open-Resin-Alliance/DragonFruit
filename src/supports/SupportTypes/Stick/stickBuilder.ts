import { toVec3 } from '@/supports/Curves/BezierUtils';
import * as THREE from 'three';
import { Joint, Segment, Stick, Vec3, LimitationCode } from '../../types';
import type { ContactCone, SupportTipProfile } from '../../SupportPrimitives/ContactCone/types';
import { getSocketPosition } from '../../SupportPrimitives/ContactCone/contactConeUtils';
import { calculateDiskThickness } from '../../SupportPrimitives/ContactDisk/contactDiskUtils';
import { getSettings } from '../../Settings/state';
import { getJointDiameter } from '../../constants';
import { isShaftBlocked } from '../../PlacementLogic/CollisionAvoidance';
import { checkShaftCollision } from '../../PlacementLogic/CollisionUtils';
import { clampConeAxisDeviationFromSurfaceNormal } from '../../PlacementLogic/ConeAxisPolicy';
import { v4 as uuidv4 } from 'uuid';

export interface StickBuildInput {
    modelId: string;
    /** Auto-support tier overrides — absent for manual placement. */
    shaftDiameterMm?: number;
    tipContactDiameterMm?: number;
    aPos: Vec3;
    aNormal: Vec3;
    bPos: Vec3;
    bNormal: Vec3;
    mesh?: THREE.Mesh;
}

export interface StickBuildResult {
    stick: Stick;
    error?: LimitationCode;
}

const GEOMETRY_EPSILON = 0.000001;

/** Clearance kept between a shortened cone and the surface it stops short of. */
const CONE_GAP_CLEARANCE_MM = 0.1;
/** A cone never shortens away to nothing; the disk stands it off the surface. */
const MIN_CONE_LENGTH_MM = 0.1;

const _gapProbeRaycaster = new THREE.Raycaster();

/**
 * How far this end's cone may run before it leaves the free gap.
 *
 * A stick's cone axis runs along the span, so on a short span the stock cone
 * length (2.5mm per end) carries both sockets past each other and into the
 * model. The shaft then starts inside material, `isShaftBlocked` reports every
 * such stick as a collision, and the manual flow shows "would collide" for
 * bridges that are plainly clear. Cast along the axis and keep the cone inside
 * the room the gap actually has; a span with room keeps the full cone.
 */
function clampConeLengthToFreeGap(
    start: THREE.Vector3,
    axis: THREE.Vector3,
    lengthMm: number,
    mesh: THREE.Mesh | undefined,
): number {
    if (!mesh || lengthMm <= MIN_CONE_LENGTH_MM) return lengthMm;
    const end = start.clone().addScaledVector(axis, lengthMm);
    const { hit, distance } = checkShaftCollision(
        { x: start.x, y: start.y, z: start.z },
        { x: end.x, y: end.y, z: end.z },
        0,
        mesh,
        _gapProbeRaycaster,
    );
    if (!hit || distance === undefined) return lengthMm;
    return Math.max(MIN_CONE_LENGTH_MM, Math.min(lengthMm, distance - CONE_GAP_CLEARANCE_MM));
}


export function buildStick(input: StickBuildInput): StickBuildResult {
    const { modelId, aPos, aNormal, bPos, bNormal, mesh } = input;

    const settings = getSettings();

    // Auto-support tier overrides (absent for manual placement). The tier
    // band sizes the stick; the active Support Studio preset must not, or an
    // auto run inherits whatever profile the user last selected by hand.
    const tipContactDiameterMm = input.tipContactDiameterMm ?? settings.tip.contactDiameterMm;
    const shaftDiameter = input.shaftDiameterMm ?? settings.shaft.diameterMm;

    const tipProfile: SupportTipProfile = {
        type: 'disk',
        contactDiameterMm: tipContactDiameterMm,
        bodyDiameterMm: settings.tip.bodyDiameterMm,
        lengthMm: settings.tip.lengthMm,
        penetrationMm: settings.tip.penetrationMm,
        diskThicknessMm: settings.tip.diskThicknessMm ?? 0.1,
        maxStandoffMm: settings.tip.maxStandoffMm ?? 1.5,
        standoffAngleThreshold: settings.tip.standoffAngleThreshold ?? Math.PI / 4,
    };

    const jointDiameter = getJointDiameter(shaftDiameter);

    const surfaceNormalA = new THREE.Vector3(aNormal.x, aNormal.y, aNormal.z);
    if (surfaceNormalA.lengthSq() < GEOMETRY_EPSILON) surfaceNormalA.set(0, 0, 1);
    surfaceNormalA.normalize();

    const surfaceNormalB = new THREE.Vector3(bNormal.x, bNormal.y, bNormal.z);
    if (surfaceNormalB.lengthSq() < GEOMETRY_EPSILON) surfaceNormalB.set(0, 0, 1);
    surfaceNormalB.normalize();

    const coneAxisA = new THREE.Vector3(
        bPos.x - aPos.x,
        bPos.y - aPos.y,
        bPos.z - aPos.z,
    );
    if (coneAxisA.lengthSq() < GEOMETRY_EPSILON) {
        coneAxisA.copy(surfaceNormalA);
    }
    coneAxisA.normalize();

    const coneAxisB = coneAxisA.clone().multiplyScalar(-1);
    const coneStartA = new THREE.Vector3();
    const coneStartB = new THREE.Vector3();
    let diskThicknessA = 0;
    let diskThicknessB = 0;

    // Match trunk behavior more closely: the disk stays glued to the local
    // surface normal, but the cone body is allowed to cant toward the bridge.
    for (let pass = 0; pass < 2; pass += 1) {
        const clampedAxisA = clampConeAxisDeviationFromSurfaceNormal(
            toVec3(surfaceNormalA),
            toVec3(coneAxisA),
        );
        coneAxisA.set(clampedAxisA.x, clampedAxisA.y, clampedAxisA.z);

        const clampedAxisB = clampConeAxisDeviationFromSurfaceNormal(
            toVec3(surfaceNormalB),
            toVec3(coneAxisB),
        );
        coneAxisB.set(clampedAxisB.x, clampedAxisB.y, clampedAxisB.z);

        diskThicknessA = tipProfile.type === 'disk'
            ? calculateDiskThickness(toVec3(surfaceNormalA), toVec3(coneAxisA), tipProfile)
            : 0;
        diskThicknessB = tipProfile.type === 'disk'
            ? calculateDiskThickness(toVec3(surfaceNormalB), toVec3(coneAxisB), tipProfile)
            : 0;

        coneStartA.set(aPos.x, aPos.y, aPos.z).addScaledVector(surfaceNormalA, diskThicknessA);
        coneStartB.set(bPos.x, bPos.y, bPos.z).addScaledVector(surfaceNormalB, diskThicknessB);

        const bridgeAxis = coneStartB.clone().sub(coneStartA);
        if (bridgeAxis.lengthSq() < GEOMETRY_EPSILON) break;

        bridgeAxis.normalize();
        coneAxisA.copy(bridgeAxis);
        coneAxisB.copy(bridgeAxis).multiplyScalar(-1);
    }

    const finalClampedAxisA = clampConeAxisDeviationFromSurfaceNormal(
        toVec3(surfaceNormalA),
        toVec3(coneAxisA),
    );
    coneAxisA.set(finalClampedAxisA.x, finalClampedAxisA.y, finalClampedAxisA.z);

    const finalClampedAxisB = clampConeAxisDeviationFromSurfaceNormal(
        toVec3(surfaceNormalB),
        toVec3(coneAxisB),
    );
    coneAxisB.set(finalClampedAxisB.x, finalClampedAxisB.y, finalClampedAxisB.z);

    const coneLengthA = clampConeLengthToFreeGap(coneStartA, coneAxisA, tipProfile.lengthMm, mesh);
    const coneLengthB = clampConeLengthToFreeGap(coneStartB, coneAxisB, tipProfile.lengthMm, mesh);
    const profileA: SupportTipProfile = coneLengthA === tipProfile.lengthMm
        ? tipProfile
        : { ...tipProfile, lengthMm: coneLengthA };
    const profileB: SupportTipProfile = coneLengthB === tipProfile.lengthMm
        ? tipProfile
        : { ...tipProfile, lengthMm: coneLengthB };

    const socketA = getSocketPosition(toVec3(coneStartA), toVec3(coneAxisA), profileA);
    const socketB = getSocketPosition(toVec3(coneStartB), toVec3(coneAxisB), profileB);

    const socketJointA: Joint = {
        id: uuidv4(),
        pos: socketA,
        diameter: jointDiameter,
    };

    const socketJointB: Joint = {
        id: uuidv4(),
        pos: socketB,
        diameter: jointDiameter,
    };

    const segment: Segment = {
        id: uuidv4(),
        diameter: shaftDiameter,
        bottomJoint: socketJointA,
        topJoint: socketJointB,
    };

    const contactConeA: ContactCone = {
        id: uuidv4(),
        pos: aPos,
        normal: toVec3(coneAxisA),
        surfaceNormal: toVec3(surfaceNormalA),
        diskLengthOverride: diskThicknessA,
        profile: profileA,
        socketJointId: socketJointA.id,
    };

    const contactConeB: ContactCone = {
        id: uuidv4(),
        pos: bPos,
        normal: toVec3(coneAxisB),
        surfaceNormal: toVec3(surfaceNormalB),
        diskLengthOverride: diskThicknessB,
        profile: profileB,
        socketJointId: socketJointB.id,
    };

    // Normalize ordering so the ID/joint ordering is deterministic across equivalent inputs.
        const a = new THREE.Vector3(aPos.x, aPos.y, aPos.z);
    const b = new THREE.Vector3(bPos.x, bPos.y, bPos.z);
    const swap = a.z > b.z || (a.z === b.z && (a.y > b.y || (a.y === b.y && a.x > b.x)));

    const stickId = uuidv4();
    const stick: Stick = {
        id: stickId,
        modelId,
        segments: [segment],
        contactConeA: swap ? contactConeB : contactConeA,
        contactConeB: swap ? contactConeA : contactConeB,
    };

    let error: LimitationCode | undefined = undefined;
    if (mesh) {
        const shaftRadius = shaftDiameter / 2;
        // A stick is anchored on the two surfaces it bridges, so the shaft's own
        // ends always sit within a shaft radius of material -- by construction,
        // not by fault. Testing those ends as clearance reported *every* stick
        // as a collision, which the manual flow surfaced as "would collide" on
        // bridges that were plainly clear. Test the free span instead, the part
        // that can actually foul.
        //
        // The tip cones are left out of it, as every other type leaves its own:
        // a tip is anchored where it was aimed, and its length is already
        // bounded by the gap it crosses (`clampConeLengthToFreeGap`).
        const span = Math.hypot(
            socketB.x - socketA.x,
            socketB.y - socketA.y,
            socketB.z - socketA.z,
        );
        if (span > GEOMETRY_EPSILON) {
            const inset = Math.min(shaftRadius + 0.15, span * 0.4);
            const ux = (socketB.x - socketA.x) / span;
            const uy = (socketB.y - socketA.y) / span;
            const uz = (socketB.z - socketA.z) / span;
            const blocked = isShaftBlocked(
                {
                    x: socketA.x + ux * inset,
                    y: socketA.y + uy * inset,
                    z: socketA.z + uz * inset,
                },
                {
                    x: socketB.x - ux * inset,
                    y: socketB.y - uy * inset,
                    z: socketB.z - uz * inset,
                },
                shaftRadius,
                mesh,
            );
            if (blocked) error = 'COLLISION_WITH_MODEL';
        }
    }

    return { stick, error };
}
