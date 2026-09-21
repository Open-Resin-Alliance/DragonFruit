import type { Segment, SupportState, Vec3 } from '../types';
import type { SupportTypeId } from '../supportTypeRegistry';
import type { InstancedShaft } from '../SupportPrimitives/Shaft/InstancedShaftGroup';
import type { InstancedRoot } from '../SupportPrimitives/Roots/InstancedRootsGroup';
import type { InstancedJoint } from '../SupportPrimitives/Joint/InstancedJointGroup';
import type { InstancedContactCone } from '../SupportPrimitives/ContactCone/InstancedContactConeGroup';

/** Where each type registers the primitives it contributes to the proxy view. */

/** Where a recipe puts the primitives it builds. */
export interface ProxyPrimitiveSink {
    pushShaft(shaft: InstancedShaft): void;
    /** One segment as a shaft, curved ones as their batched bezier form. */
    pushSegmentShafts(
        segment: Segment,
        start: Vec3,
        end: Vec3,
        supportId: string,
        modelId?: string,
    ): void;
    pushRoot(root: InstancedRoot): void;
    pushJoint(joint: InstancedJoint, dedupeKey?: string, diameterBlendMm?: number): void;
    pushCone(cone: InstancedContactCone, dedupeKey?: string): void;
}

/** What a recipe is handed: the live store, plus the layer's detail flag. */
export interface ProxyGeometryContext extends ProxyPrimitiveSink {
    state: SupportState;
    includeDetailedPrimitives: boolean;
}

/** When a type's recipe runs, as opposed to what it builds. */
export interface ProxyGeometryRegistration {
    /** Skipped entirely in the interior view. */
    skipInInteriorView?: boolean;
    /** Emitted only when detailed primitives are on. */
    detailedOnly?: boolean;
}

type SupportProxyGeometryBuilder = (entity: never, context: ProxyGeometryContext) => void;

const PROXY_GEOMETRY_BUILDERS = new Map<SupportTypeId, SupportProxyGeometryBuilder>();
const PROXY_GEOMETRY_REGISTRATIONS = new Map<SupportTypeId, ProxyGeometryRegistration>();

/** Called once per type from its own folder's registration module. */
export function registerSupportProxyGeometry<T>(
    typeId: SupportTypeId,
    build: (entity: T, context: ProxyGeometryContext) => void,
    registration: ProxyGeometryRegistration = {},
): void {
    PROXY_GEOMETRY_BUILDERS.set(typeId, build as SupportProxyGeometryBuilder);
    PROXY_GEOMETRY_REGISTRATIONS.set(typeId, registration);
}

/** This type's builder, or null when its folder registered none. */
export function supportProxyGeometryOf(
    typeId: SupportTypeId,
): { build: SupportProxyGeometryBuilder; registration: ProxyGeometryRegistration } | null {
    const build = PROXY_GEOMETRY_BUILDERS.get(typeId);
    if (!build) return null;
    return { build, registration: PROXY_GEOMETRY_REGISTRATIONS.get(typeId) ?? {} };
}

/** Types whose folder registered no proxy geometry, for the completeness test. */
export function typesMissingProxyGeometry(
    typeIds: readonly SupportTypeId[],
): readonly SupportTypeId[] {
    return typeIds.filter((typeId) => !PROXY_GEOMETRY_BUILDERS.has(typeId));
}
