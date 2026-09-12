import * as THREE from 'three';

import { getFinalSocketPosition } from '../ContactCone';
import {
    getSupportTypeDescriptor,
    type SupportEndpoint,
    type SupportTypeDescriptor,
    type SupportTypeId,
} from '../../supportTypeRegistry';
import type { Knot, Roots, Segment, Vec3 } from '../../types';

/**
 * Where a segment starts and ends in world space, for any shafted type.
 *
 * The declared `lower` endpoint anchors segment 0 -- a root's top, or a parent
 * knot -- and `upper` says what the shaft ends at.
 */

export interface SegmentEndpoints {
    start: Vec3;
    end: Vec3;
}

/** The pieces a caller has to hand that the entity itself cannot supply. */
export interface EndpointHosts {
    /** The root this type owns, for types declaring `ownsRoot`. */
    root?: Roots | null;
    /** The knot this type hangs from, for types with a `hostedBy` knot edge. */
    hostKnot?: Knot | null;
}

/** Any shafted entity. Contact fields are read by the names the registry declares. */
type ShaftEntity = { segments: Segment[] };

const vec = (p: Vec3) => new THREE.Vector3(p.x, p.y, p.z);
const out = (v: THREE.Vector3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

/** Top of a root's disk-plus-cone stack, where an owned shaft leaves it. */
function rootTop(root: Roots): THREE.Vector3 {
    const diskHeight = Number.isFinite(root.diskHeight) ? root.diskHeight : 0;
    const coneHeight = Number.isFinite(root.coneHeight)
        ? root.coneHeight
        : Number.isFinite((root as { height?: number }).height)
            ? ((root as { height?: number }).height as number)
            : 0;
    return vec(root.transform.pos).add(new THREE.Vector3(0, 0, diskHeight + coneHeight));
}

/** Whether this type's lower end hangs from a knot rather than a root. */
function startsAtKnot(descriptor: SupportTypeDescriptor): boolean {
    return descriptor.lower.kind === 'knot';
}

/**
 * Where segment 0 begins. Later segments always continue from the previous
 * segment's top joint, so only the first needs the host.
 */
export function anchorPoint(
    descriptor: SupportTypeDescriptor,
    hosts: EndpointHosts,
): THREE.Vector3 | null {
    switch (descriptor.lower.kind) {
        case 'plateRoot':
            return hosts.root ? rootTop(hosts.root) : null;
        case 'knot':
            return hosts.hostKnot ? vec(hosts.hostKnot.pos) : null;
        default:
            // A contact or inline root anchors the shaft on the entity itself,
            // so the segment joints already carry it.
            return null;
    }
}

/** The socket position of a declared contact endpoint. */
function contactAt(endpoint: SupportEndpoint, entity: ShaftEntity): THREE.Vector3 | null {
    if (!endpoint.field) return null;
    const contact = (entity as unknown as Record<string, unknown>)[endpoint.field];
    if (!contact) return null;
    return vec(getFinalSocketPosition(contact as Parameters<typeof getFinalSocketPosition>[0]));
}

/**
 * Endpoints of `segment` on a shafted support, or null when the host it needs
 * is missing.
 *
 * A type whose segments carry both joints resolves from the segment alone; the
 * others fall back through the previous joint, the declared anchor, and finally
 * the contact socket.
 */
/**
 * Where a shaft is anchored, as a plain Vec3. The joint-drag angle clamp
 * measures from here.
 */
export function resolveShaftAnchor(
    typeId: SupportTypeId,
    hosts: EndpointHosts,
): Vec3 | null {
    const point = anchorPoint(getSupportTypeDescriptor(typeId), hosts);
    return point ? out(point) : null;
}

export function resolveSegmentEndpoints(
    typeId: SupportTypeId,
    entity: ShaftEntity,
    segment: Segment,
    segmentIndex: number,
    hosts: EndpointHosts = {},
): SegmentEndpoints | null {
    const descriptor = getSupportTypeDescriptor(typeId);
    if (!descriptor.hasSegments) return null;

    const anchor = anchorPoint(descriptor, hosts);
    // A type that declares a host but was handed none cannot be placed.
    if (!descriptor.segmentsCarryBothJoints && anchor === null) return null;

    // A knot-hosted shaft starts at its host, not at its own bottom joint: the
    // joint is a render artefact there, and trusting it detaches the shaft from
    // the knot it hangs on. Root-owned and self-contained shafts read the joint
    // first, which is what their originals did.
    const startsAtHost = startsAtKnot(descriptor);

    let start: THREE.Vector3;
    if (!startsAtHost && segment.bottomJoint) {
        start = vec(segment.bottomJoint.pos);
    } else if (segmentIndex === 0) {
        if (!anchor) return null;
        start = anchor.clone();
    } else {
        const previous = entity.segments[segmentIndex - 1];
        if (previous?.topJoint) start = vec(previous.topJoint.pos);
        else if (anchor) start = anchor.clone();
        else if (segment.bottomJoint) start = vec(segment.bottomJoint.pos);
        else return null;
    }

    let end: THREE.Vector3;
    if (segment.topJoint) {
        end = vec(segment.topJoint.pos);
    } else if (descriptor.upper.kind === 'knot') {
        // A kickstand ends at the knot it braces, not at a contact.
        if (!hosts.hostKnot) return null;
        end = vec(hosts.hostKnot.pos);
    } else {
        const contact = contactAt(descriptor.upper, entity);
        end = contact ?? start.clone().add(
            new THREE.Vector3(0, 0, descriptor.shaftFallback.stubLengthMm),
        );
    }

    return { start: out(start), end: out(end) };
}
