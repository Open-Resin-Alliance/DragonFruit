import {
    resolveSupportPlacementHotkeyIntent,
} from './supportPlacementHotkeyResolver';
import { PLACEMENT_FAMILY_BY_BINDING } from './supportPlacementHotkeyTypes';
import type {
    ResolvedSupportPlacementOwner,
    SupportModelPlacementOwner,
    SupportPlacementHotkeyBindings,
    SupportPlacementModifierState,
    SupportPlacementOwner,
    SupportPlacementRoutingState,
} from './supportPlacementHotkeyTypes';
import { MODEL_SURFACE_GESTURE_TYPES, PLACEMENT_MODE_OWNER_TYPES, SUPPORT_TYPES } from '../../../../supportTypeRegistry';
import type {
    ModelSurfaceGestureTypeId,
    PlacementModeOwnerTypeId,
    SupportTypeDescriptor,
    SupportTypeId,
} from '../../../../supportTypeRegistry';
import type { SupportPlacementActive, SupportPlacementPreviews } from '../../../../rendering';

/**
 * The types with a placement mode of their own: those declaring
 * `hasPlacementPreview` without `previewYieldsToOtherModes` (the default tool).
 */
export const PLACEMENT_MODE_TYPE_IDS: readonly PlacementModeOwnerTypeId[] = PLACEMENT_MODE_OWNER_TYPES;

/** The placement owner union without its `'none'` arm: the types themselves. */
export type PlacementOwnerTypeId = Exclude<SupportPlacementOwner, 'none'>;

/** The one type declaring `flag`, asserting there is exactly one. */
function singleTypeDeclaring(
    flag: string,
    test: (descriptor: SupportTypeDescriptor) => boolean,
): SupportTypeId {
    const matches = SUPPORT_TYPES.filter(test).map((descriptor) => descriptor.id);
    const [typeId, ...rest] = matches;
    if (!typeId || rest.length > 0) {
        throw new Error(
            `expected exactly one support type ${flag}, found: ${matches.join(', ') || 'none'}.`,
        );
    }
    return typeId;
}

/** Whether `typeId` names a type the router resolves a placement owner to. */
function isPlacementOwnerType(typeId: SupportTypeId): typeId is PlacementOwnerTypeId {
    return PLACEMENT_MODE_TYPE_IDS.some((ownerTypeId) => ownerTypeId === typeId);
}

/** Whether `typeId` is one of the types the router hands model-face gestures to. */
function isModelSurfaceGestureOwner(typeId: SupportTypeId): typeId is ModelSurfaceGestureTypeId {
    return (MODEL_SURFACE_GESTURE_TYPES as readonly SupportTypeId[]).includes(typeId);
}

/** The one placement mode declaring `flag`. */
function placementOwnerDeclaring(
    flag: string,
    test: (descriptor: SupportTypeDescriptor) => boolean,
): PlacementOwnerTypeId {
    const typeId = singleTypeDeclaring(flag, test);
    if (!isPlacementOwnerType(typeId)) {
        throw new Error(`expected ${flag} to be a placement mode, found ${typeId}.`);
    }
    return typeId;
}

/**
 * The one type declaring `flag` among those taking a model-face gesture.
 * Narrowing to that set first is what makes the answer unique.
 */
function gestureOwnerDeclaring(
    flag: string,
    test: (descriptor: SupportTypeDescriptor) => boolean,
): ModelSurfaceGestureTypeId {
    const typeId = singleTypeDeclaring(
        `${flag}, claiming a model-face gesture`,
        (descriptor) => test(descriptor) && isModelSurfaceGestureOwner(descriptor.id),
    );
    if (!isPlacementOwnerType(typeId) || !isModelSurfaceGestureOwner(typeId)) {
        throw new Error(`expected ${flag} to own a placement and claim a model-face gesture, found ${typeId}.`);
    }
    return typeId;
}

/** The kickstand's placement family, read from `PLACEMENT_FAMILY_BY_BINDING`. */
const KICKSTAND_FAMILY = PLACEMENT_FAMILY_BY_BINDING.kickstand;

/**
 * The type the branch family's gesture belongs to. Branch and brace share the
 * binding, so `previewRequiresOwnMode` is what separates them.
 */
export const BRANCH_FAMILY_PLACEMENT_OWNER = gestureOwnerDeclaring(
    'whose own mode owns its preview',
    (descriptor) => descriptor.hasPlacementPreview && descriptor.previewRequiresOwnMode === true,
);

/**
 * The leaf's placement: the mode claiming a model gesture that does not gate its
 * preview on being active.
 */
export const LEAF_PLACEMENT_OWNER = gestureOwnerDeclaring(
    'whose preview is not kept for its own mode',
    (descriptor) => descriptor.hasPlacementPreview && descriptor.previewRequiresOwnMode !== true,
);

/** The brace's placement: the mode whose live preview is a bare span between supports. */
export const BRACE_PLACEMENT_OWNER = placementOwnerDeclaring(
    'whose preview is a bare segment',
    (descriptor) => descriptor.hasPlacementPreview && descriptor.previewShape === 'segment',
);

/** The kickstand's placement, the family and the type sharing one name. */
export const KICKSTAND_PLACEMENT_OWNER = placementOwnerDeclaring(
    'named after its own type',
    (descriptor) => descriptor.id === KICKSTAND_FAMILY,
);

/**
 * The default tool: the type whose preview yields to every other mode. Not a
 * placement mode itself, so `PLACEMENT_MODE_TYPE_IDS` leaves it out.
 */
export const DEFAULT_PLACEMENT_TYPE_ID = singleTypeDeclaring(
    'whose preview yields to another mode',
    (descriptor) => descriptor.previewYieldsToOtherModes === true,
);

export interface SupportPlacementRoutingInput {
    bindings: SupportPlacementHotkeyBindings;
    modifierState: SupportPlacementModifierState;
    state: SupportPlacementRoutingState;
}

export function resolveSupportPlacementRouting(
    input: SupportPlacementRoutingInput,
): ResolvedSupportPlacementOwner {
    const intent = resolveSupportPlacementHotkeyIntent(input.bindings, input.modifierState);
    const branchFamilyActive = input.state.branchHotkeyActive || input.state.braceHotkeyActive || intent.family === PLACEMENT_FAMILY_BY_BINDING.branchFamily;
    const leafActive = input.state.leafHotkeyActive || intent.family === PLACEMENT_FAMILY_BY_BINDING.leaf;
    const kickstandActive = input.state.kickstandHotkeyActive || intent.family === KICKSTAND_FAMILY;

    if (input.state.braceAwaitingEnd) {
        return {
            owner: BRACE_PLACEMENT_OWNER,
            basedOnFirstClick: true,
            firstClickTarget: 'support',
            modelHoverOwner: 'none',
            modelClickOwner: 'none',
            blocksDefaultModelPlacement: true,
            intent,
        };
    }

    if (input.state.leafAwaitingBase) {
        return {
            owner: LEAF_PLACEMENT_OWNER,
            basedOnFirstClick: true,
            firstClickTarget: 'model',
            modelHoverOwner: 'none',
            modelClickOwner: 'none',
            blocksDefaultModelPlacement: true,
            intent,
        };
    }

    if (input.state.branchAwaitingBase) {
        return {
            owner: BRANCH_FAMILY_PLACEMENT_OWNER,
            basedOnFirstClick: true,
            firstClickTarget: 'model',
            modelHoverOwner: BRANCH_FAMILY_PLACEMENT_OWNER,
            modelClickOwner: BRANCH_FAMILY_PLACEMENT_OWNER,
            blocksDefaultModelPlacement: true,
            intent,
        };
    }

    if (leafActive) {
        return {
            owner: LEAF_PLACEMENT_OWNER,
            basedOnFirstClick: false,
            firstClickTarget: 'none',
            modelHoverOwner: LEAF_PLACEMENT_OWNER,
            modelClickOwner: LEAF_PLACEMENT_OWNER,
            blocksDefaultModelPlacement: true,
            intent,
        };
    }

    if (branchFamilyActive) {
        return {
            owner: 'none',
            basedOnFirstClick: true,
            firstClickTarget: 'none',
            modelHoverOwner: BRANCH_FAMILY_PLACEMENT_OWNER,
            modelClickOwner: BRANCH_FAMILY_PLACEMENT_OWNER,
            blocksDefaultModelPlacement: true,
            intent,
        };
    }

    if (kickstandActive) {
        return {
            owner: KICKSTAND_PLACEMENT_OWNER,
            basedOnFirstClick: false,
            firstClickTarget: 'support',
            modelHoverOwner: 'none',
            modelClickOwner: 'none',
            blocksDefaultModelPlacement: true,
            intent,
        };
    }

    return {
        owner: 'none',
        basedOnFirstClick: false,
        firstClickTarget: 'none',
        modelHoverOwner: 'none',
        modelClickOwner: 'none',
        blocksDefaultModelPlacement: false,
        intent,
    };
}

/**
 * Which model-face placement receives a gesture, and which are cleared.
 *
 * The manager holds the hooks and cannot be exercised in tests, so the decision
 * lives here as a plain function over the owner the router named.
 */
export function routeModelPlacementHit<THit>(
    owners: readonly ModelSurfaceGestureTypeId[],
    owner: SupportModelPlacementOwner,
    hit: THit | null,
): Record<ModelSurfaceGestureTypeId, THit | null> {
    const routed = {} as Record<ModelSurfaceGestureTypeId, THit | null>;
    for (const id of owners) {
        routed[id] = id === owner ? hit : null;
    }
    return routed;
}

/**
 * Which support type owns the placement interaction right now, or null when none
 * does.
 *
 * A model-face owner counts as owning it: the branch family routes its gesture
 * to the model face while its `owner` stays `'none'`, which is the same answer
 * the manager acts on.
 */
export function resolveActivePlacementTypeId(
    input: SupportPlacementRoutingInput,
): SupportTypeId | null {
    const routing = resolveSupportPlacementRouting(input);
    if (routing.owner !== 'none') return routing.owner;
    return routing.modelHoverOwner === 'none' ? null : routing.modelHoverOwner;
}

/**
 * The type whose placement mode is live in `placementActive`, or null when none
 * is.
 *
 * More than one mode can be live at once, so this answers with the first in the
 * registry's declared order. A caller that must know about every live mode asks
 * `isPlacementActiveForType` for each type instead.
 */
export function activePlacementTypeId(placementActive: SupportPlacementActive): SupportTypeId | null {
    return PLACEMENT_MODE_TYPE_IDS.find((typeId) => placementActive[typeId] === true) ?? null;
}

/**
 * Whether type `typeId`'s placement mode is live.
 *
 * How a consumer tests the type-keyed `placementActive` record without spelling
 * a type: it passes the id it already holds, so a rename in the registry moves
 * the question with the record and no key is written at the reading site.
 */
export function isPlacementActiveForType(
    placementActive: SupportPlacementActive,
    typeId: SupportTypeId,
): boolean {
    return placementActive[typeId] === true;
}

/**
 * Whether a live placement preview exists for type `typeId`. Same contract as
 * `isPlacementActiveForType`, over `placementPreviews`: an absent key and a null
 * preview both read false, which is the truthiness the scene reads today.
 */
export function isPlacementPreviewForType(
    placementPreviews: SupportPlacementPreviews,
    typeId: SupportTypeId,
): boolean {
    return Boolean(placementPreviews[typeId]);
}

