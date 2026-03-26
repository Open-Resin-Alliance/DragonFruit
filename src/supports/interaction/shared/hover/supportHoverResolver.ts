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
    'contactDisk',
    'raft',
] as const;

export const SUPPORT_TARGET_HOVER_CATEGORIES = [
    'support',
    'segment',
    'joint',
    'knot',
    'contactDisk',
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

export function isSupportPrimitiveHoverCategory(category: string | null | undefined) {
    return category === 'segment'
        || category === 'knot'
        || category === 'contactDisk'
        || isJointHoverCategory(category);
}

export function resolveHoveredSupportOwnerId(
    hoveredId: string | null,
    hoveredCategory: string | null | undefined,
    supportIdBySegmentId: ReadonlyMap<string, string>,
    supportIdByJointId: ReadonlyMap<string, string>,
    supportIdByKnotId: ReadonlyMap<string, string>,
    supportIdByContactDiskId: ReadonlyMap<string, string>,
) {
    if (!hoveredId) return null;
    if (hoveredCategory === 'support') return hoveredId;
    if (hoveredCategory === 'segment') return supportIdBySegmentId.get(hoveredId) ?? null;
    if (isJointHoverCategory(hoveredCategory)) return supportIdByJointId.get(hoveredId) ?? null;
    if (hoveredCategory === 'knot') return supportIdByKnotId.get(hoveredId) ?? null;
    if (hoveredCategory === 'contactDisk') return supportIdByContactDiskId.get(hoveredId) ?? null;
    return null;
}

export function resolveSelectedPrimitiveHoverSuppression(
    hoveredSupportIdFromPicking: string | null,
    hoveredCategory: string | null | undefined,
    hoveredId: string | null,
    selectedId: string | null,
    selectedCategory: string | null | undefined,
    selectedSupportIdSet: ReadonlySet<string>,
    selectedPrimitiveSupportId: string | null = null,
) {
    const primitiveHoverOnSelectedSupport = hoveredSupportIdFromPicking !== null
        && selectedSupportIdSet.has(hoveredSupportIdFromPicking)
        && isSupportPrimitiveHoverCategory(hoveredCategory);

    const selectedPrimitiveHoverActive = selectedId !== null
        && hoveredId === selectedId
        && isSupportPrimitiveHoverCategory(hoveredCategory);

    const suppressSupportHoverForSelectedKnotSupport = selectedCategory === 'knot'
        && hoveredSupportIdFromPicking !== null
        && selectedSupportIdSet.has(hoveredSupportIdFromPicking);

    const suppressSupportHoverForSelectedJointSupport = isSupportPrimitiveHoverCategory(selectedCategory)
        && selectedPrimitiveSupportId !== null
        && hoveredSupportIdFromPicking !== null
        && hoveredSupportIdFromPicking === selectedPrimitiveSupportId;

    return {
        primitiveHoverOnSelectedSupport,
        selectedPrimitiveHoverActive,
        suppressSupportHoverForSelectedKnotSupport,
        suppressSupportHoverForSelectedJointSupport,
    };
}

export function resolveHoveredSupportVisualState(
    marqueeHoveredSupportId: string | null,
    hoveredSupportIdFromPicking: string | null,
    sceneHoveredSupportId: string | null,
    selectedPrimitiveHoverActive: boolean,
    suppressSupportHoverForSelectedKnotSupport: boolean,
    selectedSupportIdSet: ReadonlySet<string>,
    selectedPrimitiveSupportId: string | null = null,
) {
    const candidateId = marqueeHoveredSupportId ?? hoveredSupportIdFromPicking ?? sceneHoveredSupportId;
    const suppressForSelectedPrimitiveParent = selectedPrimitiveSupportId !== null && candidateId === selectedPrimitiveSupportId;

    const hoveredSupportIdForVisual = (selectedPrimitiveHoverActive || suppressSupportHoverForSelectedKnotSupport || suppressForSelectedPrimitiveParent)
        ? null
        : candidateId;

    return {
        hoveredSupportIdForVisual,
        hoveredSupportIsSelected: hoveredSupportIdForVisual !== null && selectedSupportIdSet.has(hoveredSupportIdForVisual),
    };
}

export function resolveRawSupportHoverSuppressionState(rawHoveredCategory: string | null | undefined) {
    const jointCategoryHoverSuppressed = isJointHoverCategory(rawHoveredCategory);

    return {
        primitiveHoverSuppressesSceneShaftHover: rawHoveredCategory === 'knot' || jointCategoryHoverSuppressed,
        jointCategoryHoverSuppressed,
    };
}

export function shouldSuppressSceneBatchedSupportHover(
    supportId: string | null | undefined,
    selectedCategory: string | null | undefined,
    selectedPrimitiveHoverActive: boolean,
    primitiveHoverOnSelectedSupport: boolean,
    selectedSupportIdSet: ReadonlySet<string>,
    selectedPrimitiveSupportId: string | null = null,
) {
    const suppressForSelectedKnotSupport = selectedCategory === 'knot'
        && !!supportId
        && selectedSupportIdSet.has(supportId);

    const suppressForSelectedPrimitiveSupport = isSupportPrimitiveHoverCategory(selectedCategory)
        && !!supportId
        && selectedPrimitiveSupportId !== null
        && supportId === selectedPrimitiveSupportId;

    return selectedPrimitiveHoverActive || suppressForSelectedKnotSupport || suppressForSelectedPrimitiveSupport || (
        primitiveHoverOnSelectedSupport
        && (!supportId || !selectedSupportIdSet.has(supportId))
    );
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
