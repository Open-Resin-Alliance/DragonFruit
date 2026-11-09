import { getFinalSocketPosition } from '@/supports/SupportPrimitives/ContactCone';
import type { ContactCone } from '@/supports/SupportPrimitives/ContactCone/types';
import { SUPPORT_TYPES } from '@/supports/supportTypeRegistry';
import { supportMarqueeShapeOf, type MarqueeShapeContext } from '@/supports/marqueeGeometry/seam';
import type { Segment, SupportState } from '@/supports/types';
import type { MarqueeSegment } from './marqueeHitTest';

/**
 * A support drawn as the polyline that runs along it: the root or host knot, each
 * joint in order, and the contact at the tip. The marquee hit-tests against these
 * on every pointer move, so what is here decides what a drag selects.
 */
export interface SupportMarqueeShape {
    id: string;
    modelId: string | undefined;
    points: Array<{ x: number; y: number; z: number }>;
    struts: MarqueeSegment[];
}

/** The points between a shaft's joints. */
export function jointPositions(segments: Segment[]) {
    return segments.flatMap((segment) => [
        segment.bottomJoint?.pos,
        segment.topJoint?.pos,
    ]);
}

/** A contact's socket and the contact point itself, in that order. */
export function conePositions(cone: ContactCone) {
    return [getFinalSocketPosition(cone), cone.pos];
}

/**
 * Every support as a pickable polyline, built once per state change.
 *
 * Pure, and exported, so the polylines a scene produces can be asserted directly
 * rather than through a drag: a change here changes what the marquee SELECTS, and
 * no golden covers it. A curved segment is approximated by its chord.
 *
 * One walk over `SUPPORT_TYPES`; where each type's polyline runs is that type's
 * own recipe, declared in its folder. The roots are emitted here rather than by a
 * recipe, because a root is a primitive rather than a support type -- and the
 * order roots come first is kept, since the shapes are built in walk order.
 */
export function collectSupportMarqueeShapes(state: SupportState): SupportMarqueeShape[] {
    const shapes: SupportMarqueeShape[] = [];

    /** Consecutive segments share a joint; the polyline keeps it once. */
    const chain = (
        id: string,
        modelId: string | undefined,
        positions: Array<{ x: number; y: number; z: number } | null | undefined>,
    ) => {
        if (!id) return;

        const points: SupportMarqueeShape['points'] = [];
        for (const position of positions) {
            if (!position) continue;
            const previous = points[points.length - 1];
            if (previous && previous.x === position.x && previous.y === position.y && previous.z === position.z) {
                continue;
            }
            points.push(position);
        }

        if (points.length === 0) return;

        const struts: MarqueeSegment[] = [];
        for (let i = 1; i < points.length; i += 1) {
            struts.push([i - 1, i]);
        }

        shapes.push({ id, modelId, points, struts });
    };

    for (const root of Object.values(state.roots)) {
        chain(root.id, root.modelId, [root.transform.pos]);
    }

    const context: MarqueeShapeContext = { state, chain };

    for (const descriptor of SUPPORT_TYPES) {
        const build = supportMarqueeShapeOf(descriptor.id);
        if (!build) continue;

        const entities = state[descriptor.location.key] as unknown as
            | Record<string, { id: string }>
            | undefined;
        for (const entity of Object.values(entities ?? {})) {
            build(entity as never, context);
        }
    }

    return shapes;
}
