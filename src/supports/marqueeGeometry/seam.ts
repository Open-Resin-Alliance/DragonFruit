import type { SupportState } from '../types';
import type { SupportTypeId } from '../supportTypeRegistry';

/** Where each type registers the pickable polyline a marquee drag hits. */

/** Where a recipe appends its polyline. */
export interface MarqueeShapeSink {
    /** One entity's polyline. Null and repeated points are dropped. */
    chain(
        id: string,
        modelId: string | undefined,
        positions: Array<{ x: number; y: number; z: number } | null | undefined>,
    ): void;
}

/** What a recipe is handed. */
export interface MarqueeShapeContext extends MarqueeShapeSink {
    /** The live store, for the roots and host knots a recipe reaches by id. */
    state: SupportState;
}

type SupportMarqueeShapeBuilder = (entity: never, context: MarqueeShapeContext) => void;

const MARQUEE_SHAPE_BUILDERS = new Map<SupportTypeId, SupportMarqueeShapeBuilder>();

/** Called once per type from its own folder's registration module. */
export function registerSupportMarqueeShape<T>(
    typeId: SupportTypeId,
    build: (entity: T, context: MarqueeShapeContext) => void,
): void {
    MARQUEE_SHAPE_BUILDERS.set(typeId, build as SupportMarqueeShapeBuilder);
}

/** This type's recipe, or null when its folder registered none. */
export function supportMarqueeShapeOf(
    typeId: SupportTypeId,
): SupportMarqueeShapeBuilder | null {
    return MARQUEE_SHAPE_BUILDERS.get(typeId) ?? null;
}

/** Types whose folder registered no polyline, so no drag can select them. */
export function typesMissingMarqueeShape(
    typeIds: readonly SupportTypeId[],
): readonly SupportTypeId[] {
    return typeIds.filter((typeId) => !MARQUEE_SHAPE_BUILDERS.has(typeId));
}
