import type { ComponentType } from 'react';

import { BranchPlacementController } from './SupportTypes/Branch/BranchPlacementController';
import { LeafPlacementController } from './SupportTypes/Leaf/LeafPlacementController';
import { BracePlacementController } from './SupportTypes/Brace/BracePlacementController';
import { KickstandPlacementController } from './SupportTypes/Kickstand/KickstandPlacementController';
import { SUPPORT_TYPES, type SupportTypeId } from './supportTypeRegistry';

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
 * of it pulls in the component tree. Declared here instead, keyed by type id
 * so the scene mounts them in a loop rather than naming four imports.
 *
 * Trunk is absent deliberately -- it has `hasPlacementPreview` but no mounted
 * controller, placing through `useTrunkPlacementV2` in the interaction manager.
 */
export const PLACEMENT_CONTROLLERS: Partial<Record<SupportTypeId, ComponentType<PlacementControllerProps>>> = {
    branch: BranchPlacementController,
    leaf: LeafPlacementController,
    brace: BracePlacementController,
    kickstand: KickstandPlacementController,
};

/** Types with a mounted controller, in registry order so mounting is stable. */
export const PLACEMENT_CONTROLLER_TYPES: readonly SupportTypeId[] =
    SUPPORT_TYPES.map((descriptor) => descriptor.id).filter((id) => id in PLACEMENT_CONTROLLERS);
