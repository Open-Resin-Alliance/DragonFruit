export type ResolvedSelectionMode = 'none' | 'single' | 'multi' | 'marquee';

export type SelectionBlockedReason =
    | 'gizmo-active'
    | 'placement-active'
    | 'marquee-active';

export interface ResolvedSelectionState {
    mode: ResolvedSelectionMode;
    selectedId: string | null;
    selectedIds: string[];
    selectedCategory: string | null;
    marqueeCandidateIds: string[];
    blockedReason: SelectionBlockedReason | null;
}

export const EMPTY_RESOLVED_SELECTION_STATE: ResolvedSelectionState = {
    mode: 'none',
    selectedId: null,
    selectedIds: [],
    selectedCategory: null,
    marqueeCandidateIds: [],
    blockedReason: null,
};

export interface SupportSelectionClickInput {
    id: string;
    shiftKey: boolean;
    isInteractable: boolean;
}
