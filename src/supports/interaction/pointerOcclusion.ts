import * as THREE from 'three';
import { isContactDiskHudInteractionActive } from '../SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { isSupportEditInteractionActive } from './gizmoInteractionLock';

type PointerIntersectionLike = {
    object?: THREE.Object3D | null;
};

type PointerEventLike = {
    intersections?: PointerIntersectionLike[] | null;
};

const IMMEDIATE_MODEL_HOVER_UNSET = Symbol('immediate-model-hover-unset');

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

export function getFrontBlockingModelId(event: PointerEventLike | null | undefined, targetRoot: THREE.Object3D | null | undefined): string | null {
    if (!targetRoot) return null;

    const intersections = Array.isArray(event?.intersections) ? event.intersections : [];
    for (const entry of intersections) {
        const object = entry?.object ?? null;
        if (!object) continue;
        if (isWithinTargetSubtree(object, targetRoot)) return null;

        const modelId = object.userData?.modelId;
        if (typeof modelId === 'string' && modelId.length > 0) return modelId;
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
