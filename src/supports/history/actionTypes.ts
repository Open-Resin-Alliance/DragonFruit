import type { Anchor, Roots, Trunk, Leaf, Knot, Branch, Brace, Twig, Stick, SupportState } from '../types';
import type { KickstandBuildResult, KickstandRemoveResult, KickstandState } from '../SupportTypes/Kickstand/types';

export const SUPPORT_ADD_TRUNK = 'support:add-trunk' as const;
export const SUPPORT_REMOVE_TRUNK = 'support:remove-trunk' as const;
export const SUPPORT_UPDATE_TRUNK = 'support:update-trunk' as const;

export const SUPPORT_ADD_LEAF = 'support:add-leaf' as const;
export const SUPPORT_REMOVE_LEAF = 'support:remove-leaf' as const;

export const SUPPORT_ADD_BRANCH = 'support:add-branch' as const;
export const SUPPORT_REMOVE_BRANCH = 'support:remove-branch' as const;
export const SUPPORT_UPDATE_BRANCH = 'support:update-branch' as const;

export const SUPPORT_ADD_TWIG = 'support:add-twig' as const;
export const SUPPORT_REMOVE_TWIG = 'support:remove-twig' as const;

export const SUPPORT_ADD_STICK = 'support:add-stick' as const;
export const SUPPORT_REMOVE_STICK = 'support:remove-stick' as const;

export const SUPPORT_ADD_BRACE = 'support:add-brace' as const;
export const SUPPORT_REMOVE_BRACE = 'support:remove-brace' as const;

export const SUPPORT_ADD_ANCHOR = 'support:add-anchor' as const;
export const SUPPORT_REMOVE_ANCHOR = 'support:remove-anchor' as const;

export const SUPPORT_ADD_KICKSTAND = 'support:add-kickstand' as const;
export const SUPPORT_REMOVE_KICKSTAND = 'support:remove-kickstand' as const;

export const SUPPORT_REPLACE_TRUNK = 'support:replace-trunk' as const;
export const SUPPORT_AUTO_BRACE_REPLACE = 'support:auto-brace-replace' as const;
export const SUPPORT_EDIT_REPLACE = 'support:edit-replace' as const;
export const SUPPORT_AUTO_PLACE = 'support:auto-place' as const;

/** Every support history action type, derived from the payload map below. */
export type SupportHistoryActionType = keyof SupportHistoryPayloadMap;

export interface SupportTrunkPayload {
  trunk: Trunk;
  root?: Roots | null;
  branches?: Branch[];
  braces?: Brace[];
  kickstands?: KickstandBuildResult[];
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

export interface SupportTwigPayload {
  twig: Twig;
}

export interface SupportTwigRemovePayload {
  twig: Twig;
  knots: Knot[];
  leaves: Leaf[];
}

export interface SupportStickPayload {
  stick: Stick;
}

export interface SupportBranchRemovePayload {
  branches: Branch[];
  braces: Brace[];
  kickstands?: KickstandBuildResult[];
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

export interface SupportAnchorPayload {
  anchor: Anchor;
}

export interface SupportKickstandPayload {
  build: KickstandBuildResult;
}

export type SupportKickstandRemovePayload = KickstandRemoveResult;

export interface SupportReplaceTrunkPayload {
  before: SupportState;
  after: SupportState;
}

export interface SupportReplaceStatePayload {
  before: SupportState;
  after: SupportState;
  kickstandBefore?: KickstandState;
  kickstandAfter?: KickstandState;
}

/**
 * The payload each support history action carries. One source of truth: push
 * sites and handlers both key off this map, so a type can't be pushed with a
 * payload its handler won't understand.
 */
export type SupportHistoryPayloadMap = {
  [SUPPORT_ADD_TRUNK]: SupportTrunkPayload;
  [SUPPORT_REMOVE_TRUNK]: SupportTrunkPayload;
  [SUPPORT_UPDATE_TRUNK]: SupportTrunkUpdatePayload;
  [SUPPORT_ADD_LEAF]: SupportLeafPayload;
  [SUPPORT_REMOVE_LEAF]: SupportLeafPayload;
  [SUPPORT_ADD_BRANCH]: SupportBranchPayload;
  [SUPPORT_REMOVE_BRANCH]: SupportBranchRemovePayload;
  [SUPPORT_UPDATE_BRANCH]: SupportBranchUpdatePayload;
  [SUPPORT_ADD_TWIG]: SupportTwigPayload;
  [SUPPORT_REMOVE_TWIG]: SupportTwigRemovePayload;
  [SUPPORT_ADD_STICK]: SupportStickPayload;
  [SUPPORT_REMOVE_STICK]: SupportStickPayload;
  [SUPPORT_ADD_BRACE]: BraceLinkPayload;
  [SUPPORT_REMOVE_BRACE]: BraceLinkPayload;
  [SUPPORT_ADD_ANCHOR]: SupportAnchorPayload;
  [SUPPORT_REMOVE_ANCHOR]: SupportAnchorPayload;
  [SUPPORT_ADD_KICKSTAND]: SupportKickstandPayload;
  [SUPPORT_REMOVE_KICKSTAND]: SupportKickstandRemovePayload;
  [SUPPORT_REPLACE_TRUNK]: SupportReplaceTrunkPayload;
  [SUPPORT_EDIT_REPLACE]: SupportReplaceStatePayload;
  [SUPPORT_AUTO_BRACE_REPLACE]: SupportReplaceStatePayload;
  [SUPPORT_AUTO_PLACE]: SupportReplaceStatePayload;
};
