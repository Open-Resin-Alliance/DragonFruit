import { contactEndpointsFor, type SupportTypeId } from '../supportTypeRegistry';
import type { SupportData } from '../rendering/SupportBuilder';
import type { PlacementSurface } from '../supportPlacementPreviewMath';

export type { PlacementSurface };

/** Stamps the surface on one contact. */
export function markContactPlacementSurface<T>(contact: T, surface?: PlacementSurface): T {
    if (!contact || !surface) return contact;
    return { ...contact, placementSurface: surface } as T;
}

/**
 * Stamps the placement surface on a support's declared contacts.
 *
 * Which fields those are comes from the registry, so this is one function
 * rather than one per type. Cone and disk take the same stamp; they differed
 * only in the generic they were written against.
 */
export function markPlacementSurface<T extends object>(
    typeId: SupportTypeId,
    entity: T,
    surface?: PlacementSurface,
): T {
    if (!surface) return entity;

    const next = { ...entity } as Record<string, unknown>;
    for (const { field } of contactEndpointsFor(typeId)) {
        if (next[field]) next[field] = markContactPlacementSurface(next[field], surface);
    }
    return next as T;
}

/** The same stamp applied to a preview's already-flattened contact lists. */
export function markSupportDataPlacementSurface(
    data: SupportData,
    surface?: PlacementSurface,
): SupportData {
    if (!surface) return data;
    return {
        ...data,
        contactCone: markContactPlacementSurface(data.contactCone, surface),
        contactCones: data.contactCones?.map((cone) => markContactPlacementSurface(cone, surface)),
        contactDisks: data.contactDisks?.map((disk) => markContactPlacementSurface(disk, surface)),
    };
}
