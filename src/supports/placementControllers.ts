import type { ComponentType } from 'react';

import { BranchPlacementController } from './SupportTypes/Branch/BranchPlacementController';
import { LeafPlacementController } from './SupportTypes/Leaf/LeafPlacementController';
import { BracePlacementController } from './SupportTypes/Brace/BracePlacementController';
import { KickstandPlacementController } from './SupportTypes/Kickstand/KickstandPlacementController';
import { SUPPORT_TYPES, type SupportTypeId } from './supportTypeRegistry';
import {
    BRACE_PLACEMENT_OWNER,
    BRANCH_FAMILY_PLACEMENT_OWNER,
    KICKSTAND_PLACEMENT_OWNER,
    LEAF_PLACEMENT_OWNER,
} from './interaction/shared/placement/hotkeys/supportPlacementRouting';

/**
 * Props every placement controller accepts. Only leaf reads the active model;
 * the rest take none, so one shape covers all of them.
 */
export interface PlacementControllerProps {
    activeModelId?: string | null;
}

/**
 * The scene-mounted placement controllers, by type.
 *
 * Not on the descriptor: the registry stays free of React, or every consumer
 * of it pulls in the component tree. Declared here instead, keyed by the
 * placement owners the router derives from the registry rather than by
 * literals, so a renamed type moves its key and its controller together.
 *
 * Trunk is absent deliberately -- it has `hasPlacementPreview` but no mounted
 * controller, placing through `useTrunkPlacementV2` in the interaction manager.
 */
export const PLACEMENT_CONTROLLERS: Partial<Record<SupportTypeId, ComponentType<PlacementControllerProps>>> = {
    [BRANCH_FAMILY_PLACEMENT_OWNER]: BranchPlacementController,
    [LEAF_PLACEMENT_OWNER]: LeafPlacementController,
    [BRACE_PLACEMENT_OWNER]: BracePlacementController,
    [KICKSTAND_PLACEMENT_OWNER]: KickstandPlacementController,
};

/** Types with a mounted controller, in registry order so mounting is stable. */
export const PLACEMENT_CONTROLLER_TYPES: readonly SupportTypeId[] =
    SUPPORT_TYPES.map((descriptor) => descriptor.id).filter((id) => id in PLACEMENT_CONTROLLERS);
