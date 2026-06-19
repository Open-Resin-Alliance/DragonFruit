import * as THREE from 'three';
import { isContactDiskHudInteractionActive } from '../SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { isSupportEditInteractionActive } from './gizmoInteractionLock';
import { getClipBounds } from '@/components/scene/SceneCanvas/clipBoundsStore';

type PointerIntersectionLike = {
    object?: THREE.Object3D | null;
    point?: THREE.Vector3 | null;
};

type PointerEventLike = {
    intersections?: PointerIntersectionLike[] | null;
};

const IMMEDIATE_MODEL_HOVER_UNSET = Symbol('immediate-model-hover-unset');
let interiorSupportInteractionDepth = 0;

type ImmediateModelHoverWindow = Window & {
    __dragonfruitLastImmediateModelHoverId?: string | null | typeof IMMEDIATE_MODEL_HOVER_UNSET;
    __dragonfruitImmediateModelHoverDedupeInitialized?: boolean;
};

function isWithinTargetSubtree(object: THREE.Object3D | null | undefined, targetRoot: THREE.Object3D | null | undefined): boolean {
    let current = object ?? null;
    while (current) {
        if (current === targetRoot) return true;
        current = current.parent;
    }
    return false;
}

export function setInteriorSupportInteractionActive(active: boolean) {
    interiorSupportInteractionDepth = Math.max(0, interiorSupportInteractionDepth + (active ? 1 : -1));
}

export function isInteriorSupportInteractionActive() {
    return interiorSupportInteractionDepth > 0;
}

export function getFrontBlockingModelId(event: PointerEventLike | null | undefined, targetRoot: THREE.Object3D | null | undefined): string | null {
    if (!targetRoot) return null;
    if (isInteriorSupportInteractionActive()) return null;

    const intersections = Array.isArray(event?.intersections) ? event.intersections : [];
    const { clipLower, clipUpper } = getClipBounds();
    for (const entry of intersections) {
        const object = entry?.object ?? null;
        if (!object) continue;
        if (isWithinTargetSubtree(object, targetRoot)) return null;

        const modelId = object.userData?.modelId;
        if (typeof modelId === 'string' && modelId.length > 0) {
            // When cross-section is active, skip model hits whose intersection
            // point falls in the clipped (invisible) zone — the surface is
            // visually removed and should not block interactions behind it.
            const pt = (entry as { point?: THREE.Vector3 | null }).point;
            if (pt) {
                if (clipUpper != null && pt.z > clipUpper) continue;
                if (clipLower != null && pt.z < clipLower) continue;
            }
            return modelId;
        }
    }

    return null;
}

export function hasFrontBlockingModel(event: PointerEventLike | null | undefined, targetRoot: THREE.Object3D | null | undefined): boolean {
    return getFrontBlockingModelId(event, targetRoot) !== null;
}

function shouldSuppressImmediateModelHover(modelId: string | null) {
    return modelId !== null && (isSupportEditInteractionActive() || isContactDiskHudInteractionActive());
}

function ensureImmediateModelHoverDedupeHooks(w: ImmediateModelHoverWindow) {
    if (w.__dragonfruitImmediateModelHoverDedupeInitialized) return;
    w.__dragonfruitImmediateModelHoverDedupeInitialized = true;
    w.__dragonfruitLastImmediateModelHoverId = IMMEDIATE_MODEL_HOVER_UNSET;

    const resetLastImmediateHover = () => {
        w.__dragonfruitLastImmediateModelHoverId = IMMEDIATE_MODEL_HOVER_UNSET;
    };

    window.addEventListener('blur', resetLastImmediateHover);
    document.addEventListener('visibilitychange', resetLastImmediateHover);
}

export function emitImmediateModelHover(modelId: string | null) {
    if (typeof window === 'undefined') return;

    if (shouldSuppressImmediateModelHover(modelId)) return;

    const w = window as ImmediateModelHoverWindow & {
        __jointGizmoDragging?: boolean;
        __knotGizmoDragging?: boolean;
        __bezierGizmoDragging?: boolean;
    };

    if (w.__jointGizmoDragging || w.__knotGizmoDragging || w.__bezierGizmoDragging) return;

    ensureImmediateModelHoverDedupeHooks(w);

    const lastModelId = w.__dragonfruitLastImmediateModelHoverId;
    if (lastModelId !== IMMEDIATE_MODEL_HOVER_UNSET && lastModelId === modelId) {
        return;
    }

    w.__dragonfruitLastImmediateModelHoverId = modelId;

    window.dispatchEvent(new CustomEvent('model-pointer-hover-immediate', {
        detail: { modelId }
    }));
}
