import type { Roots, Trunk, Leaf, Knot, Branch, Brace, Twig, Stick, SupportState } from '../types';
import type { SupportBraceBuildResult } from '../SupportTypes/SupportBrace/types';

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

export const SUPPORT_ADD_SUPPORT_BRACE = 'support:add-support-brace' as const;
export const SUPPORT_REMOVE_SUPPORT_BRACE = 'support:remove-support-brace' as const;

export const SUPPORT_REPLACE_TRUNK = 'support:replace-trunk' as const;

export type SupportHistoryActionType =
  | typeof SUPPORT_ADD_TRUNK
  | typeof SUPPORT_REMOVE_TRUNK
  | typeof SUPPORT_UPDATE_TRUNK
  | typeof SUPPORT_ADD_LEAF
  | typeof SUPPORT_REMOVE_LEAF
  | typeof SUPPORT_ADD_BRANCH
  | typeof SUPPORT_REMOVE_BRANCH
  | typeof SUPPORT_UPDATE_BRANCH
  | typeof SUPPORT_ADD_TWIG
  | typeof SUPPORT_REMOVE_TWIG
  | typeof SUPPORT_ADD_STICK
  | typeof SUPPORT_REMOVE_STICK
  | typeof SUPPORT_ADD_BRACE
  | typeof SUPPORT_REMOVE_BRACE
  | typeof SUPPORT_ADD_SUPPORT_BRACE
  | typeof SUPPORT_REMOVE_SUPPORT_BRACE
  | typeof SUPPORT_REPLACE_TRUNK;

export interface SupportTrunkPayload {
  trunk: Trunk;
  root?: Roots | null;
  branches?: Branch[];
  braces?: Brace[];
  supportBraces?: SupportBraceBuildResult[];
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

export interface SupportStickPayload {
  stick: Stick;
}

export interface SupportBranchRemovePayload {
  branches: Branch[];
  braces: Brace[];
  supportBraces?: SupportBraceBuildResult[];
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

export interface SupportBracePayload {
  brace: Brace;
  startKnot?: Knot | null;
  endKnot?: Knot | null;
}

export interface SupportSupportBracePayload {
  build: SupportBraceBuildResult;
}

export interface SupportReplaceTrunkPayload {
  before: SupportState;
  after: SupportState;
}
