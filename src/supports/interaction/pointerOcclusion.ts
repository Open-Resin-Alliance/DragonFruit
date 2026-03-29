import * as THREE from 'three';
import { isContactDiskHudInteractionActive } from '../SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { isSupportEditInteractionActive } from './gizmoInteractionLock';

type PointerIntersectionLike = {
    object?: THREE.Object3D | null;
};

type PointerEventLike = {
    intersections?: PointerIntersectionLike[] | null;
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

export function emitImmediateModelHover(modelId: string | null) {
    if (typeof window === 'undefined') return;

    if (shouldSuppressImmediateModelHover(modelId)) return;

    const w = window as any;
    if (w.__jointGizmoDragging || w.__knotGizmoDragging || w.__bezierGizmoDragging) return;

    window.dispatchEvent(new CustomEvent('model-pointer-hover-immediate', {
        detail: { modelId }
    }));
}
