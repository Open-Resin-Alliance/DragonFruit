import type { Roots, Trunk, Leaf, Knot, Kickstand, Branch, Brace, SupportState } from '../types';
import type { SupportEntityPayload, SupportRemovalResult, SupportTypeId } from '../supportTypeRegistry';
import type { KickstandBuildResult } from '../SupportTypes/Kickstand/types';

/**
 * Per-type history actions, derived from the type id.
 *
 * The spelling is `support:<verb>-<typeId>`, so a new type gets its actions by
 * being declared. These are in-memory undo/redo labels -- nothing in the voxl
 * codec writes them -- so the shape is free to be derived.
 */
type AddAction<T extends string> = `support:add-${T}`;
type RemoveAction<T extends string> = `support:remove-${T}`;

/** The action a type's add and remove push, spelled from its id. */
export const addAction = <T extends SupportTypeId>(typeId: T): AddAction<T> => `support:add-${typeId}`;
export const removeAction = <T extends SupportTypeId>(typeId: T): RemoveAction<T> => `support:remove-${typeId}`;

export const SUPPORT_UPDATE_TRUNK = 'support:update-trunk' as const;
export const SUPPORT_UPDATE_BRANCH = 'support:update-branch' as const;

export const SUPPORT_REPLACE_TRUNK = 'support:replace-trunk' as const;
export const SUPPORT_AUTO_BRACE_REPLACE = 'support:auto-brace-replace' as const;
export const SUPPORT_EDIT_REPLACE = 'support:edit-replace' as const;
export const SUPPORT_AUTO_PLACE = 'support:auto-place' as const;
export const SUPPORT_BLOCKER_STROKE = 'support:blocker-stroke' as const;

/** Every support history action type, derived from the payload map below. */
export type SupportHistoryActionType = keyof SupportHistoryPayloadMap;

export interface SupportTrunkPayload {
  trunk: Trunk;
  /** The trunk's own root, plus one per kickstand the cascade swept up. */
  roots?: Roots[];
  branches?: Branch[];
  braces?: Brace[];
  kickstands?: Kickstand[];
  leaves?: Leaf[];
  knots?: Knot[];
}

export interface SupportTrunkUpdatePayload {
  before: Trunk;
  after: Trunk;
}

export interface SupportLeafPayload {
  leaf: Leaf;
  knot?: Knot | null;
}

export interface SupportBranchPayload {
  branch: Branch;
  knot?: Knot | null;
  trunkUpdate?: {
    before: Trunk;
    after: Trunk;
  };
  knotUpdates?: {
    before: Knot;
    after: Knot;
  }[];
}

export interface SupportBranchUpdatePayload {
  before: Branch;
  after: Branch;
}


export interface SupportBranchRemovePayload {
  branches: Branch[];
  braces: Brace[];
  kickstands?: Kickstand[];
  leaves: Leaf[];
  knots: Knot[];
  trunkUpdate?: {
    before: Trunk;
    after: Trunk;
  };
  knotUpdates?: {
    before: Knot;
    after: Knot;
  }[];
}

export interface BraceLinkPayload {
  brace: Brace;
  startKnot?: Knot | null;
  endKnot?: Knot | null;
}


export interface SupportKickstandPayload {
  build: KickstandBuildResult;
}

/** Removal payloads, derived from what the registry declares each type takes. */
export type SupportTwigPayload = SupportEntityPayload<'twig'>;
export type SupportStickPayload = SupportEntityPayload<'stick'>;
export type SupportAnchorPayload = SupportEntityPayload<'anchor'>;

export type SupportTwigRemovePayload = SupportRemovalResult<'twig'>;
export type SupportStickRemovePayload = SupportRemovalResult<'stick'>;
export type SupportAnchorRemovePayload = SupportRemovalResult<'anchor'>;
export type SupportKickstandRemovePayload = SupportRemovalResult<'kickstand'>;

export interface SupportReplaceTrunkPayload {
  before: SupportState;
  after: SupportState;
}

export interface SupportReplaceStatePayload {
  before: SupportState;
  after: SupportState;
}

export interface SupportBlockerStrokePayload {
  modelId: string;
  before: number[];
  after: number[];
}

/**
 * The payload each support history action carries. One source of truth: push
 * sites and handlers both key off this map, so a type can't be pushed with a
 * payload its handler won't understand.
 */
/**
 * What each type's add and remove payload carries.
 *
 * The generic entry is what the registry already declares a type takes; the
 * entries below it are the types whose history payload carries more than the
 * entity (a trunk sweeps its cascade, a branch re-parents knots).
 */
/** Types whose add payload carries more than the entity the registry declares. */
interface AddPayloadOverrides {
  trunk: SupportTrunkPayload;
  leaf: SupportLeafPayload;
  branch: SupportBranchPayload;
  brace: BraceLinkPayload;
  kickstand: SupportKickstandPayload;
}

/** Types whose remove payload carries more than the registry's removal shape. */
interface RemovePayloadOverrides {
  trunk: SupportTrunkPayload;
  leaf: SupportLeafPayload;
  branch: SupportBranchRemovePayload;
  brace: BraceLinkPayload;
}

type AddPayloadByType = {
  [K in SupportTypeId]: K extends keyof AddPayloadOverrides
    ? AddPayloadOverrides[K]
    : SupportEntityPayload<K>;
};

type RemovePayloadByType = {
  [K in SupportTypeId]: K extends keyof RemovePayloadOverrides
    ? RemovePayloadOverrides[K]
    : SupportRemovalResult<K>;
};

/**
 * The payload each support history action carries. One source of truth: push
 * sites and handlers both key off this map, so a type can't be pushed with a
 * payload its handler won't understand.
 *
 * Keys are derived, so a new type gets its two actions by being declared.
 */
export type SupportHistoryPayloadMap =
  { [K in SupportTypeId as AddAction<K>]: AddPayloadByType[K] }
  & { [K in SupportTypeId as RemoveAction<K>]: RemovePayloadByType[K] }
  & {
    [SUPPORT_UPDATE_TRUNK]: SupportTrunkUpdatePayload;
    [SUPPORT_UPDATE_BRANCH]: SupportBranchUpdatePayload;
    [SUPPORT_REPLACE_TRUNK]: SupportReplaceTrunkPayload;
    [SUPPORT_EDIT_REPLACE]: SupportReplaceStatePayload;
    [SUPPORT_AUTO_BRACE_REPLACE]: SupportReplaceStatePayload;
    [SUPPORT_AUTO_PLACE]: SupportReplaceStatePayload;
    [SUPPORT_BLOCKER_STROKE]: SupportBlockerStrokePayload;
  };
