import type { ComponentType } from 'react';

import { RaftPreview } from './PreviewTypes/Raft/RaftPreview';
import { GridPreview } from './PreviewTypes/Grid/GridPreview';
import { BracePreview } from './PreviewTypes/Brace/BracePreview';
import { SUPPORT_KINDS, type SupportKind } from '../supportKindState';

/**
 * Everything a preview may read. Each component destructures the subset it
 * needs, so one shape covers all of them.
 */
export interface AnatomyPreviewProps {
    settings: unknown;
    liveConfig: unknown;
    previewState: unknown;
    activeKind: SupportKind;
    anatomyOverrides: unknown;
    raftSettings: unknown;
}

/**
 * The kinds that draw their own anatomy preview, by kind.
 *
 * Every other kind falls through to `TrunkPreview`, which the canvas mounts
 * directly -- it is the default, not an entry. Membership here must match
 * `drawsOwnPreview` on the kind; `anatomyPreviewTable.test.ts` holds them
 * together.
 */
export const ANATOMY_PREVIEWS: Partial<Record<SupportKind, ComponentType<AnatomyPreviewProps>>> = {
    raft: RaftPreview,
    grid: GridPreview,
    stick: BracePreview,

};

/** Kinds with their own preview, in table order so mounting is stable. */
export const ANATOMY_PREVIEW_KINDS: readonly SupportKind[] =
    (Object.keys(SUPPORT_KINDS) as SupportKind[]).filter((kind) => kind in ANATOMY_PREVIEWS);
