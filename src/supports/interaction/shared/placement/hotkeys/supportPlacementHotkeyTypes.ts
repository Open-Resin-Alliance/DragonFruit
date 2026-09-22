import type * as THREE from 'three';
import { BRANCH_FAMILY_MEMBER_TYPES, PLACEMENT_MODE_OWNER_TYPES, getSupportTypeDescriptor } from '../../../../supportTypeRegistry';
import type {
    BranchFamilyMemberTypeId,
    ModelSurfaceGestureTypeId,
    OwnNamedPlacementFamilyTypeId,
    PlacementFamilyName,
    PlacementModeOwnerTypeId,
    SupportTypeDescriptor,
} from '../../../../supportTypeRegistry';
import type { HotkeyBinding } from '@/hotkeys/hotkeyConfig';

/**
 * Which placement a pointer gesture belongs to.
 *
 * Every member that names a type is derived in the registry, so a rename there
 * renames the family here. `branchFamily` is the one family NAME rather than a
 * type: branch and brace share one placement binding.
 */
export type SupportPlacementFamily = 'none' | PlacementFamilyName;
/**
 * Which placement a pointer gesture belongs to.
 *
 * Drawn from the registry's `PlacementModeOwnerTypeId`; only types with a
 * placement mode appear.
 */
export type SupportPlacementOwner = 'none' | PlacementModeOwnerTypeId;
/** Model-surface gestures route to the types that declare they claim them. */
export type SupportModelPlacementOwner = 'none' | ModelSurfaceGestureTypeId;

/**
 * The model-face half of a placement hook. Every claiming type exposes it with
 * the same signature, so the router's owner can index a table of them.
 */
export interface SupportModelPlacementHandlers {
    onModelHover: (hit: THREE.Intersection | null) => void;
    onModelClick: (hit: THREE.Intersection | null) => void;
}
export type SupportPlacementFirstClickTarget = 'none' | 'model' | 'support';

export interface SupportPlacementModifierState {
    ctrlKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
    metaKey: boolean;
}

export interface SupportPlacementHotkeyBindings {
    branchFamily: HotkeyBinding;
    leaf: HotkeyBinding;
    kickstand: HotkeyBinding;
}

/** Whether `typeId` is placed by the shared branch binding rather than its own. */
function isBranchFamilyMember(typeId: PlacementModeOwnerTypeId): typeId is BranchFamilyMemberTypeId {
    return BRANCH_FAMILY_MEMBER_TYPES.some((memberTypeId) => memberTypeId === typeId);
}

/**
 * The own-named placement families: the owners outside the shared
 * `branchFamily` binding, which give their binding their own name.
 */
const OWN_NAMED_PLACEMENT_FAMILY_TYPES: readonly OwnNamedPlacementFamilyTypeId[] =
    PLACEMENT_MODE_OWNER_TYPES.filter(
        (typeId): typeId is OwnNamedPlacementFamilyTypeId => !isBranchFamilyMember(typeId),
    );

/**
 * The one own-named family declaring `flag`, asserting there is exactly one.
 * The two are told apart by `claimsModelSurfaceGestures`: a leaf places against
 * the model face, a kickstand between existing shafts.
 */
function singleOwnNamedFamily(
    flag: string,
    test: (descriptor: SupportTypeDescriptor) => boolean,
): OwnNamedPlacementFamilyTypeId {
    const matches = OWN_NAMED_PLACEMENT_FAMILY_TYPES.filter((typeId) =>
        test(getSupportTypeDescriptor(typeId)),
    );
    const [typeId, ...rest] = matches;
    if (!typeId || rest.length > 0) {
        throw new Error(
            `expected exactly one own-named placement family ${flag}, found: ${matches.join(', ') || 'none'}.`,
        );
    }
    return typeId;
}

/** The own-named family that places against the model face. */
const MODEL_FACE_PLACEMENT_FAMILY = singleOwnNamedFamily(
    'that claims a model-surface gesture',
    (descriptor) => descriptor.claimsModelSurfaceGestures,
);

/** The own-named family that places between existing supports. */
const BETWEEN_SUPPORTS_PLACEMENT_FAMILY = singleOwnNamedFamily(
    'that claims no model-surface gesture',
    (descriptor) => !descriptor.claimsModelSurfaceGestures,
);

/**
 * The family each placement binding belongs to.
 *
 * Branch and brace share the one `branchFamily` binding, the only value here
 * that is a family name rather than a type id.
 *
 * Keyed by binding, not owner: the owner constants are derived in the router,
 * which imports this, so an owner-keyed table would cycle.
 */
export const PLACEMENT_FAMILY_BY_BINDING = {
    branchFamily: 'branchFamily',
    leaf: MODEL_FACE_PLACEMENT_FAMILY,
    kickstand: BETWEEN_SUPPORTS_PLACEMENT_FAMILY,
} as const satisfies Record<keyof SupportPlacementHotkeyBindings, SupportPlacementFamily>;

export interface ResolvedSupportPlacementHotkeyIntent {
    family: SupportPlacementFamily;
    requiredKeysHeld: boolean;
    releaseShouldCancel: boolean;
    bindingSource: HotkeyBinding | null;
    matches: {
        branchFamily: boolean;
        leaf: boolean;
        kickstand: boolean;
    };
}

export interface SupportPlacementRoutingState {
    branchHotkeyActive: boolean;
    branchAwaitingBase: boolean;
    leafHotkeyActive: boolean;
    leafAwaitingBase: boolean;
    braceHotkeyActive: boolean;
    braceAwaitingEnd: boolean;
    kickstandHotkeyActive: boolean;
}

export interface ResolvedSupportPlacementOwner {
    owner: SupportPlacementOwner;
    basedOnFirstClick: boolean;
    firstClickTarget: SupportPlacementFirstClickTarget;
    modelHoverOwner: SupportModelPlacementOwner;
    modelClickOwner: SupportModelPlacementOwner;
    blocksDefaultModelPlacement: boolean;
    intent: ResolvedSupportPlacementHotkeyIntent;
}
