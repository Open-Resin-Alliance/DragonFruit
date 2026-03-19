import type {
    HoverSource,
    ResolvedSupportHoverHit,
    SupportHoverCategory,
} from './hoverTypes';

export const SUPPORT_HOVER_CATEGORIES: readonly SupportHoverCategory[] = [
    'support',
    'segment',
    'joint',
    'knot',
    'raft',
] as const;

export const SUPPORT_TARGET_HOVER_CATEGORIES = [
    'support',
    'segment',
    'joint',
    'knot',
] as const;

type SupportTargetHoverCategory = (typeof SUPPORT_TARGET_HOVER_CATEGORIES)[number];

const SUPPORT_HOVER_CATEGORY_SET = new Set<string>(SUPPORT_HOVER_CATEGORIES);
const SUPPORT_TARGET_HOVER_CATEGORY_SET = new Set<string>(SUPPORT_TARGET_HOVER_CATEGORIES);

export function isSupportHoverCategory(category: string | null | undefined): category is SupportHoverCategory {
    if (!category) return false;
    return SUPPORT_HOVER_CATEGORY_SET.has(category);
}

export function isSupportTargetHoverCategory(
    category: string | null | undefined,
): category is SupportTargetHoverCategory {
    if (!category) return false;
    return SUPPORT_TARGET_HOVER_CATEGORY_SET.has(category);
}

export function isJointHoverCategory(category: string | null | undefined) {
    return category === 'joint' || category === 'join';
}

export function resolveSupportHover(
    hoveredId: string | null,
    hoveredCategory: string | null | undefined,
): ResolvedSupportHoverHit | null {
    if (!isSupportHoverCategory(hoveredCategory)) return null;
    return {
        id: hoveredId,
        category: hoveredCategory,
    };
}

export function resolveHoverSource(
    modelHoverPresent: boolean,
    supportHoverPresent: boolean,
    isGizmoActive: boolean,
): HoverSource {
    if (isGizmoActive) return 'gizmo';
    if (modelHoverPresent) return 'model';
    if (supportHoverPresent) return 'support';
    return 'none';
}
