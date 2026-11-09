import type * as THREE from 'three';

import { SUPPORT_TYPES, type SupportTypeId } from '../supportTypeRegistry';
import type { SupportState } from '../types';

/**
 * How a support type contributes its geometry to an export.
 *
 * Each type's export geometry lives in that type's own folder and registers
 * here; the export walks `SUPPORT_TYPES` and asks each one what it builds.
 * Beside the geometry rather than in the registry, which declares what a type
 * is rather than how it draws.
 */
export interface SupportExportContext {
    /** The live store, for a type that must resolve an owned root or host knot. */
    supportState: SupportState;
    /**
     * The model a support entity id resolves to, following the entity's declared
     * links. Supplied by the caller because resolution needs the store.
     */
    modelIdOf: (entityId: string) => string | null;
}

/**
 * One entity's exported geometry.
 *
 * `null` drops that one entity rather than failing the export -- a support whose
 * host knot is missing is a broken link, not a reason to export nothing.
 */
type SupportExportGroupBuilder = (
    entity: never,
    context: SupportExportContext,
) => THREE.Group | null;

const EXPORT_GROUP_BUILDERS = new Map<SupportTypeId, SupportExportGroupBuilder>();

/**
 * Called once per type from its own folder's registration module.
 *
 * The entity parameter is annotated by the implementer (`(stick: Stick) => …`),
 * which is what keeps each builder's body typed without the caller casting.
 */
export function registerSupportExportGroup<T>(
    typeId: SupportTypeId,
    build: (entity: T, context: SupportExportContext) => THREE.Group | null,
): void {
    EXPORT_GROUP_BUILDERS.set(typeId, build as SupportExportGroupBuilder);
}

/** Builds `entity`'s export group, or throws when the type never registered. */
export function buildSupportExportGroup(
    typeId: SupportTypeId,
    entity: { id: string },
    context: SupportExportContext,
): THREE.Group | null {
    const build = EXPORT_GROUP_BUILDERS.get(typeId);
    if (!build) throw new Error(`no export group builder registered for "${typeId}"`);
    return (build as (value: unknown, ctx: SupportExportContext) => THREE.Group | null)(entity, context);
}

/**
 * Types that never registered an export group builder.
 *
 * Every type has export geometry, so this is non-empty only when a registration
 * module did not load -- which would otherwise show up as a silently empty
 * export rather than an error.
 */
export function typesMissingExportGroupBuilder(): SupportTypeId[] {
    return SUPPORT_TYPES
        .filter((descriptor) => !EXPORT_GROUP_BUILDERS.has(descriptor.id))
        .map((descriptor) => descriptor.id);
}
