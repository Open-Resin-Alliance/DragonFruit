import type { ComponentType } from 'react';
import type { Knot, Roots } from '../types';
import { SUPPORT_TYPES, type SupportTypeId } from '../supportTypeRegistry';

/**
 * What one type's detail renderer is and what it needs from the frame.
 *
 * Held in each type's own folder and registered here, so the shared renderer
 * asks by id. The entry closes over live scene state, so a registration stores
 * a factory and the renderer supplies the context.
 */
export interface DetailRendererEntry {
    component: ComponentType<Record<string, unknown>>;
    hosts?: (entity: never) => Record<string, unknown> | null;
    skip?: (context: { entity: never; isSelected: boolean; isBatchable: boolean }) => boolean;
    extraProps?: (context: { entity: never; isSelected: boolean; isBatchable: boolean }) => Record<string, unknown>;
    noClipping?: (context: { entity: never; isSelected: boolean; isBatchable: boolean }) => boolean;
    /** Where "is this shaft batched" comes from, when not `plainShaftsOf`. */
    batchedIds?: ReadonlySet<string> | { has(id: string): boolean };
}

/**
 * The live scene state a factory closes over. Supplied by the renderer: this
 * seam loads with the type folders and must not reach back into it.
 */
export interface DetailRendererContext {
    roots: Record<string, Roots>;
    renderKnotsById: Record<string, Knot>;
    braceRenderKnotsById: Record<string, Knot>;
    simpleRender: boolean;
    /**
     * The eye button's navigation view: the batches draw lines and contact
     * discs, and a SELECTED support is still drawn in full by its detail
     * renderer, so it can be inspected while the forest around it is light.
     */
    navigationView: boolean;
    hideUnselectedKnots: boolean;
    hidePlateContactPrimitivesEffective: boolean;
    ghostedBraceIdSet: ReadonlySet<string>;
    ghostOpacityClamped: number;
    suppressHover: boolean;
    isInteractable: boolean;
    debugSectionColorsEnabled: boolean;
    /** Brace's own shaft set; a `Map` is passed, `has` is all that is read. */
    braceShaftsBySupport: { has(id: string): boolean };
}

type DetailRendererFactory = (context: DetailRendererContext) => DetailRendererEntry;

const FACTORIES = new Map<SupportTypeId, DetailRendererFactory>();

/**
 * Registers a type's detail renderer, from that type's own folder.
 *
 * The `entity` inside `hosts` / `skip` / `extraProps` is annotated by the
 * implementer, which keeps each entry's body typed from the entity the type
 * publishes.
 */
export function registerSupportDetailRenderer(typeId: SupportTypeId, factory: DetailRendererFactory): void {
    FACTORIES.set(typeId, factory);
}

/**
 * Whether the simple/navigation view hides this member.
 *
 * The navigation view is the exception that keeps a SELECTED support whole: a
 * selection is a deliberate act, so the support it names is drawn in full while
 * the rest of the forest is lines. Nothing else in the view draws detail — the
 * batches do not mount the solids a line stands for, and a hovered member is
 * revealed by the hover overlay — so the exception cannot leave a support
 * showing primitives it was never selected for.
 */
export function detailSkippedInSimpleView(context: DetailRendererContext, isSelected: boolean): boolean {
    return context.simpleRender && !(context.navigationView && isSelected);
}

/** The detail renderer table for this frame, keyed by type id. */
export function detailRenderersFor(context: DetailRendererContext): Partial<Record<SupportTypeId, DetailRendererEntry>> {
    const entries: Partial<Record<SupportTypeId, DetailRendererEntry>> = {};
    for (const descriptor of SUPPORT_TYPES) {
        const factory = FACTORIES.get(descriptor.id);
        if (factory) entries[descriptor.id] = factory(context);
    }
    return entries;
}

/**
 * Types that reach the registry without a registered detail renderer. A ninth
 * type without one would draw nothing, silently, so
 * `registerBuiltinDetailRenderers` asserts this list is empty at load.
 */
export function detailRenderersMissingTypes(): readonly SupportTypeId[] {
    return SUPPORT_TYPES.filter((descriptor) => !FACTORIES.has(descriptor.id)).map((descriptor) => descriptor.id);
}
