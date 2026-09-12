import * as THREE from 'three';

import { calculateDiskThickness } from '../ContactDisk/contactDiskUtils';
import { contactEndpointsFor, type SupportTypeId } from '../../supportTypeRegistry';
import type { ContactDisk, Segment, Vec3 } from '../../types';
import type { ContactCone } from '../ContactCone/types';

/**
 * Re-solving a support's model contacts after one of its joints moved.
 *
 * A type contacting the model at both ends carries its contact with the end
 * that moved; a shaft between hosts does not. Both the pointer path and the
 * gizmo did this, each with its own copy of the same two solvers.
 */

/** The point a disk's shaft actually starts from, past the disk thickness. */
export function diskTipCenter(disk: ContactDisk): Vec3 {
    const thickness = disk.diskLengthOverride
        ?? calculateDiskThickness(disk.surfaceNormal, disk.coneAxis, disk.profile);
    return {
        x: disk.pos.x + disk.surfaceNormal.x * thickness,
        y: disk.pos.y + disk.surfaceNormal.y * thickness,
        z: disk.pos.z + disk.surfaceNormal.z * thickness,
    };
}

/**
 * A cone re-aimed at a moved socket, its contact point left on the surface.
 *
 * The three passes settle the disk thickness against the angle: thickness
 * depends on the axis, and the axis on where the shaft starts, which the
 * thickness sets.
 */
export function recomputeConeForSocket<T extends ContactCone>(cone: T, socketPos: Vec3): T {
    const effectiveSurfaceNormal = cone.surfaceNormal || cone.normal;
    let axis = new THREE.Vector3(cone.normal.x, cone.normal.y, cone.normal.z);
    if (axis.lengthSq() < 0.000001) axis.set(0, 0, 1);
    axis.normalize();

    let offset = 0;
    if (cone.profile?.type === 'disk') {
        offset = cone.diskLengthOverride
            ?? calculateDiskThickness(effectiveSurfaceNormal, { x: axis.x, y: axis.y, z: axis.z }, cone.profile);
    }

    const contactPos = new THREE.Vector3(cone.pos.x, cone.pos.y, cone.pos.z);
    const sn = new THREE.Vector3(effectiveSurfaceNormal.x, effectiveSurfaceNormal.y, effectiveSurfaceNormal.z);
    const socket = new THREE.Vector3(socketPos.x, socketPos.y, socketPos.z);

    let startPos = contactPos.clone().add(sn.clone().multiplyScalar(offset));
    for (let i = 0; i < 3; i += 1) {
        const v = socket.clone().sub(startPos);
        if (v.length() > 0.0001) axis = v.clone().normalize();

        if (cone.profile?.type === 'disk' && cone.diskLengthOverride === undefined) {
            offset = calculateDiskThickness(effectiveSurfaceNormal, { x: axis.x, y: axis.y, z: axis.z }, cone.profile);
            startPos = contactPos.clone().add(sn.clone().multiplyScalar(offset));
        }
    }

    const finalStart = contactPos.clone().add(sn.clone().multiplyScalar(offset));

    return {
        ...cone,
        normal: { x: axis.x, y: axis.y, z: axis.z },
        profile: { ...cone.profile, lengthMm: Math.max(0.1, socket.distanceTo(finalStart)) },
    };
}

/**
 * A disk tilted toward a moved socket, and the socket it snaps that joint to.
 *
 * The contact point stays anchored on the model; only the angle and the
 * standoff change, so the joint is pulled back onto the disk tip.
 */
export function recomputeDiskForSocket(
    disk: ContactDisk,
    desiredSocketPos: Vec3,
    axisHint?: THREE.Vector3,
): { disk: ContactDisk; socket: Vec3 } {
    const contactPos = new THREE.Vector3(disk.pos.x, disk.pos.y, disk.pos.z);
    const desiredSocket = new THREE.Vector3(desiredSocketPos.x, desiredSocketPos.y, desiredSocketPos.z);
    const contactToDesiredSocket = desiredSocket.clone().sub(contactPos);

    let surfaceNormal = contactToDesiredSocket.clone();
    if (surfaceNormal.lengthSq() < 0.000001) {
        surfaceNormal = new THREE.Vector3(disk.surfaceNormal.x, disk.surfaceNormal.y, disk.surfaceNormal.z);
    }
    if (surfaceNormal.lengthSq() < 0.000001) surfaceNormal.set(0, 0, 1);
    surfaceNormal.normalize();

    let axis = axisHint?.clone() ?? contactToDesiredSocket.clone();
    if (axis.lengthSq() < 0.000001) axis = new THREE.Vector3(disk.coneAxis.x, disk.coneAxis.y, disk.coneAxis.z);
    if (axis.lengthSq() < 0.000001) axis = surfaceNormal.clone();
    axis.normalize();

    const desiredDistance = contactToDesiredSocket.length();
    const fallbackThickness = disk.diskLengthOverride ?? calculateDiskThickness(
        { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z },
        { x: axis.x, y: axis.y, z: axis.z },
        disk.profile,
    );
    const thickness = Number.isFinite(desiredDistance) && desiredDistance > 0.000001
        ? Math.max(0.001, desiredDistance)
        : Math.max(0.001, fallbackThickness);

    const snappedSocket = contactPos.clone().add(surfaceNormal.clone().multiplyScalar(thickness));

    return {
        disk: {
            ...disk,
            pos: { x: contactPos.x, y: contactPos.y, z: contactPos.z },
            surfaceNormal: { x: surfaceNormal.x, y: surfaceNormal.y, z: surfaceNormal.z },
            coneAxis: { x: axis.x, y: axis.y, z: axis.z },
            diskLengthOverride: thickness,
        } as ContactDisk,
        socket: { x: snappedSocket.x, y: snappedSocket.y, z: snappedSocket.z },
    };
}

/** A shaft entity whose contacts sit in declared fields. */
type ContactEntity = { segments: Segment[] } & Record<string, unknown>;

/**
 * An entity with its moved joint applied and its contacts re-solved.
 *
 * Which fields hold contacts, and whether each is a disk or a cone, comes from
 * the declared endpoints. A disk also snaps the joint back onto its tip, which
 * is why the segments come back changed.
 */
export function resolveDraggedContacts<T extends ContactEntity>(
    typeId: SupportTypeId,
    entity: T,
    jointId: string,
    movedSegments: Segment[],
): T {
    const contacts = contactEndpointsFor(typeId);
    if (contacts.length === 0) return { ...entity, segments: movedSegments };

    const first = movedSegments[0];
    const last = movedSegments[movedSegments.length - 1];
    let segments = movedSegments;
    const next = { ...entity } as ContactEntity;

    for (const { end, kind, field } of contacts) {
        const contact = entity[field];
        if (!contact) continue;

        const atLower = end === 'lower';
        const joint = atLower ? first?.bottomJoint : last?.topJoint;

        if (kind === 'cone') {
            // A cone follows the joint it names as its socket.
            const cone = contact as ContactCone;
            if (cone.socketJointId !== jointId) continue;
            next[field] = recomputeConeForSocket(cone, resolveJointPos(segments, jointId) ?? cone.pos);
            continue;
        }

        // A disk owns the endpoint joint rather than naming one.
        if (!joint || joint.id !== jointId) continue;

        const otherEnd = atLower
            ? last?.topJoint?.pos ?? diskTipCenter(oppositeDisk(entity, contacts, field) ?? (contact as ContactDisk))
            : segments[0]?.bottomJoint?.pos ?? diskTipCenter(oppositeDisk(entity, contacts, field) ?? (contact as ContactDisk));

        const axisHint = new THREE.Vector3(
            otherEnd.x - joint.pos.x,
            otherEnd.y - joint.pos.y,
            otherEnd.z - joint.pos.z,
        );

        const recomputed = recomputeDiskForSocket(contact as ContactDisk, joint.pos, axisHint);
        next[field] = recomputed.disk;

        const index = atLower ? 0 : segments.length - 1;
        const key = atLower ? 'bottomJoint' : 'topJoint';
        segments = segments.map((segment, i) => (
            i !== index || !segment[key]
                ? segment
                : { ...segment, [key]: { ...segment[key]!, pos: recomputed.socket } }
        ));
    }

    next.segments = segments;
    return next as T;
}

/** The contact at the entity's other declared end, if it has one. */
function oppositeDisk(
    entity: ContactEntity,
    contacts: readonly { end: 'lower' | 'upper'; field: string }[],
    field: string,
): ContactDisk | null {
    const other = contacts.find((c) => c.field !== field);
    return other ? (entity[other.field] as ContactDisk | undefined) ?? null : null;
}

/** Where a joint sits in a segment list. */
function resolveJointPos(segments: readonly Segment[], jointId: string): Vec3 | null {
    for (const segment of segments) {
        if (segment.topJoint?.id === jointId) return segment.topJoint.pos;
        if (segment.bottomJoint?.id === jointId) return segment.bottomJoint.pos;
    }
    return null;
}
