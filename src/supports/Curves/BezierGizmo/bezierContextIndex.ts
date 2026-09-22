import { getFinalSocketPosition } from '../../SupportPrimitives/ContactCone';
import { resolveShaftAnchor } from '../../SupportPrimitives/Knot/segmentEndpoints';
import type { ContactCone } from '../../SupportPrimitives/ContactCone/types';
import { getSupportTypeDescriptor, spanKnotHostType, SUPPORT_TYPES, type SupportTypeId } from '../../supportTypeRegistry';
import type { Brace, Joint, Segment, SupportState } from '../../types';

/**
 * Which bezier handles to offer for the current selection.
 *
 * One context per joint and per segment end, indexed by the id a selection
 * carries. A segment end resolves through the same declarations the geometry
 * does: a bottom joint or the declared lower endpoint, a top joint or the
 * declared upper contact's socket or host knot.
 *
 * Brace keeps its own loop: it declares no segments, and its two handles are the
 * knots its curve runs between.
 */
export interface HandleContext {
    id: string; // Unique ID for key
    /** The support this handle reshapes, and which type it is. */
    entity?: { id: string; segments?: Segment[] };
    typeId?: SupportTypeId;
    joint: Joint;
    incomingSegment?: Segment; // Segment ending at this joint (from below)
    incomingIndex: number;
    outgoingSegment?: Segment; // Segment starting at this joint (going up)
    outgoingIndex: number;
    activeHandle: 'incoming' | 'outgoing'; // Which handle to show for this context
}

/** An entity in a shafted collection, as far as this index reads it. */
interface ShaftedEntity {
    id: string;
    segments: Segment[];
    rootId?: string;
    parentKnotId?: string;
    contactCone?: ContactCone;
    /** Whatever else the descriptor's edges name, read by field. */
    [field: string]: unknown;
}

export interface GizmoContextIndex {
    jointContextsById: Map<string, HandleContext[]>;
    segmentContextsById: Map<string, HandleContext[]>;
    braceContextsById: Map<string, HandleContext[]>;
}

export function buildGizmoContextIndex(state: SupportState): GizmoContextIndex {
    const jointContextsById = new Map<string, HandleContext[]>();
    const segmentContextsById = new Map<string, HandleContext[]>();
    const braceContextsById = new Map<string, HandleContext[]>();

    const pushContext = (map: Map<string, HandleContext[]>, key: string | null | undefined, context: HandleContext) => {
        if (!key) return;
        const existing = map.get(key);
        if (existing) {
            existing.push(context);
        } else {
            map.set(key, [context]);
        }
    };

    // Every shafted type builds the same handles. Both differences are
    // declared: where a first segment's missing bottom joint comes from
    // (the lower endpoint), and the context id prefix, which is a React key.
    for (const descriptor of SUPPORT_TYPES) {
        if (!descriptor.hasSegments) continue;

        const prefix = descriptor.bezierContextIdPrefix;
        const collection = state[descriptor.location.key] as unknown as Record<string, ShaftedEntity>;

        for (const entity of Object.values(collection ?? {})) {
            const segments = entity.segments ?? [];

            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.topJoint?.id) {
                    for (const activeHandle of ['incoming', 'outgoing'] as const) {
                        pushContext(jointContextsById, seg.topJoint.id, {
                            id: `${prefix}joint-${seg.topJoint.id}-${activeHandle}`,
                            entity,
                            typeId: descriptor.id,
                            joint: seg.topJoint,
                            incomingSegment: seg,
                            incomingIndex: i,
                            outgoingSegment: segments[i + 1],
                            outgoingIndex: i + 1,
                            activeHandle,
                        });
                    }
                }

                if (seg.bottomJoint?.id && i === 0) {
                    pushContext(jointContextsById, seg.bottomJoint.id, {
                        id: `${prefix}joint-${seg.bottomJoint.id}-outgoing`,
                        entity,
                        typeId: descriptor.id,
                        joint: seg.bottomJoint,
                        incomingSegment: undefined,
                        incomingIndex: -1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.type !== 'bezier') continue;

                // A first segment with no bottom joint starts at whatever the
                // type declares as its lower endpoint.
                let bottomJoint = seg.bottomJoint;
                if (!bottomJoint) {
                    if (i > 0) {
                        bottomJoint = segments[i - 1].topJoint;
                    } else {
                        const root = descriptor.ownsRoot ? state.roots[entity.rootId ?? ''] : undefined;
                        const hostKnot = descriptor.lower.kind === 'knot'
                            ? state.knots[entity.parentKnotId ?? '']
                            : undefined;
                        const anchor = resolveShaftAnchor(descriptor.id, { root, hostKnot });
                        if (anchor) {
                            bottomJoint = {
                                id: root?.id ?? hostKnot?.id ?? `${entity.id}-anchor`,
                                pos: anchor,
                                diameter: root?.diameter ?? hostKnot?.diameter ?? seg.diameter,
                            };
                        }
                    }
                }

                if (bottomJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `seg-${seg.id}-bottom`,
                        entity,
                        typeId: descriptor.id,
                        joint: bottomJoint,
                        incomingSegment: segments[i - 1],
                        incomingIndex: i - 1,
                        outgoingSegment: seg,
                        outgoingIndex: i,
                        activeHandle: 'outgoing',
                    });
                }

                if (seg.topJoint) {
                    pushContext(segmentContextsById, seg.id, {
                        id: `seg-${seg.id}-top`,
                        entity,
                        typeId: descriptor.id,
                        joint: seg.topJoint,
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: segments[i + 1],
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                } else if (entity.contactCone) {
                    const socketPos = getFinalSocketPosition(entity.contactCone);
                    pushContext(segmentContextsById, seg.id, {
                        id: `seg-${seg.id}-top-cone`,
                        entity,
                        typeId: descriptor.id,
                        joint: {
                            id: entity.contactCone.socketJointId || 'cone-socket',
                            pos: { x: socketPos.x, y: socketPos.y, z: socketPos.z },
                            diameter: entity.contactCone.profile?.bodyDiameterMm ?? seg.diameter,
                        },
                        incomingSegment: seg,
                        incomingIndex: i,
                        outgoingSegment: undefined,
                        outgoingIndex: i + 1,
                        activeHandle: 'incoming',
                    });
                } else if (descriptor.upper.kind === 'knot') {
                    // A type whose upper end is a knot has no contact to read:
                    // the shaft ends on the host the `hostedBy` edge declares,
                    // which is where resolveSegmentEndpoints ends it too.
                    const hostEdge = descriptor.edges.find(
                        (edge) => edge.to === 'knots' && edge.ownership === 'hostedBy',
                    );
                    const hostKnotId = hostEdge ? entity[hostEdge.field] : undefined;
                    const hostKnot = typeof hostKnotId === 'string' ? state.knots[hostKnotId] : undefined;
                    if (hostKnot) {
                        pushContext(segmentContextsById, seg.id, {
                            id: `seg-${seg.id}-top-host`,
                            entity,
                            typeId: descriptor.id,
                            joint: {
                                id: hostKnot.id,
                                pos: hostKnot.pos,
                                diameter: hostKnot.diameter ?? seg.diameter,
                            },
                            incomingSegment: seg,
                            incomingIndex: i,
                            outgoingSegment: undefined,
                            outgoingIndex: i + 1,
                            activeHandle: 'incoming',
                        });
                    }
                }
            }
        }
    }

    // Brace -- the registry's single span knot host -- keeps its own loop: it
    // declares no segments, so the generic walk skips it, and its two handles
    // are the knots its curve runs between. Its descriptor supplies the id and
    // the collection, so a rename moves the whole loop with it.
    const spanHost = getSupportTypeDescriptor(spanKnotHostType());
    const spanHosts = state[spanHost.location.key] as unknown as Record<string, Brace | undefined>;

    for (const brace of Object.values(spanHosts)) {
        if (brace?.curve?.type !== 'bezier') continue;
        const startKnot = state.knots[brace.startKnotId];
        const endKnot = state.knots[brace.endKnotId];
        if (!startKnot || !endKnot) continue;

        const startJoint: Joint = { id: startKnot.id, pos: startKnot.pos, diameter: startKnot.diameter ?? 1.5 };
        const endJoint: Joint = { id: endKnot.id, pos: endKnot.pos, diameter: endKnot.diameter ?? 1.5 };

        pushContext(braceContextsById, brace.id, {
            id: `brace-${brace.id}-start-outgoing`,
            entity: brace,
            typeId: spanHost.id,
            joint: startJoint,
            incomingSegment: undefined,
            incomingIndex: -1,
            outgoingSegment: undefined,
            outgoingIndex: 0,
            activeHandle: 'outgoing',
        });

        pushContext(braceContextsById, brace.id, {
            id: `brace-${brace.id}-end-incoming`,
            entity: brace,
            typeId: spanHost.id,
            joint: endJoint,
            incomingSegment: undefined,
            incomingIndex: 0,
            outgoingSegment: undefined,
            outgoingIndex: 1,
            activeHandle: 'incoming',
        });
    }

    return {
        jointContextsById,
        segmentContextsById,
        braceContextsById,
    };
}
