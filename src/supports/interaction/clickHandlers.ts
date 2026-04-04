import { applySupportSelectionClick, selectJointById, selectPrimitiveById } from './shared/selection/selectionController';
import { isContactDiskHudInteractionActive } from '../SupportPrimitives/ContactDisk/contactDiskHudInteraction';

let hoverGuardInitialized = false;
let orbitInteractionActive = false;
let shiftModifierActive = false;
let lastDispatchedHoverModelId: string | null = null;

function initializeHoverGuards() {
    if (hoverGuardInitialized || typeof window === 'undefined') return;
    hoverGuardInitialized = true;

    const markOrbitActive = () => {
        orbitInteractionActive = true;
    };

    const markOrbitInactive = () => {
        orbitInteractionActive = false;
    };

    const markOrbitInactiveFromPointer = () => {
        orbitInteractionActive = false;
    };

    const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Shift') shiftModifierActive = true;
    };

    const handleKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Shift') shiftModifierActive = false;
    };

    const clearModifiers = () => {
        shiftModifierActive = false;
    };

    window.addEventListener('picking-orbit-start', markOrbitActive);
    window.addEventListener('picking-orbit-change', markOrbitActive);
    window.addEventListener('picking-orbit-end', markOrbitInactive);
    window.addEventListener('pointerup', markOrbitInactiveFromPointer, true);
    window.addEventListener('pointercancel', markOrbitInactiveFromPointer, true);
    window.addEventListener('mouseup', markOrbitInactiveFromPointer, true);
    window.addEventListener('contextmenu', markOrbitInactiveFromPointer, true);
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', markOrbitInactiveFromPointer);
    window.addEventListener('blur', clearModifiers);
    document.addEventListener('visibilitychange', markOrbitInactiveFromPointer);
    document.addEventListener('visibilitychange', clearModifiers);
}

function isShiftActiveFromEvent(e: any) {
    return !!(
        e?.shiftKey
        || e?.nativeEvent?.shiftKey
        || e?.sourceEvent?.shiftKey
        || shiftModifierActive
    );
}

export function emitSupportModelPointerHover(modelId: string | null) {
    if (typeof window === 'undefined') return;

    initializeHoverGuards();

    const w = window as any;
    if (w.__jointGizmoDragging || w.__knotGizmoDragging || w.__bezierGizmoDragging) return;

    if (orbitInteractionActive || isContactDiskHudInteractionActive()) return;

    if (modelId === lastDispatchedHoverModelId) return;
    lastDispatchedHoverModelId = modelId;

    window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
        detail: {
            modelId,
            category: 'support',
        },
    }));
}

export function emitSupportModelPointerSelect(modelId: string | null) {
    if (typeof window === 'undefined') return;
    if (!modelId) return;

    window.dispatchEvent(new CustomEvent('support-model-pointer-select', {
        detail: {
            modelId,
        },
    }));
}

/**
 * Logic for handling clicks on Support objects (Trunks, Branches).
 * Enforces interactability check and stops DOM propagation to prevent canvas deselection.
 */
export function handleSupportClick(e: any, id: string, isInteractable: boolean) {
    const shiftDown = isShiftActiveFromEvent(e);

    if (!isInteractable) {
        return;
    }
    
    e.stopPropagation(); // Stop R3F propagation
    
    // Stop DOM propagation to prevent SceneCanvas handleCanvasClick from clearing selection
    if (e.nativeEvent) {
        e.nativeEvent.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
    }
    
    applySupportSelectionClick({
        id,
        shiftKey: shiftDown,
        isInteractable,
    });
}

/**
 * Logic for handling clicks on Joint objects.
 * Enforces parent selection rule: Can only select joint if parent support is already selected.
 * Otherwise, lets the click bubble up to the parent support to select it.
 */
export function handleJointClick(
    e: any, 
    id: string, 
    isInteractable: boolean, 
    isParentSelected: boolean, 
    isJointSelected: boolean,
    onSelect?: (id: string) => void
) {
    if (!isInteractable) return;
    
    // If parent is NOT selected and THIS joint is NOT selected, 
    // let the click bubble to the parent (Trunk/Branch) to select the support first.
    if (!isParentSelected && !isJointSelected) {
        return;
    }

    e.stopPropagation(); // Stop R3F propagation
    
    // Stop DOM propagation
    if (e.nativeEvent) {
        e.nativeEvent.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
    }

    selectJointById(id);
    if (onSelect) onSelect(id);
}

/**
 * Logic for handling clicks on Knot objects.
 * Mirrors joint behavior: require parent selection before selecting the knot itself.
 */
export function handleKnotClick(
    e: any,
    id: string,
    isInteractable: boolean,
    isParentSelected: boolean,
    isKnotSelected: boolean,
    onSelect?: (id: string) => void
 ) {
    if (!isInteractable) return;

    if (!isParentSelected && !isKnotSelected) {
        return;
    }

    e.stopPropagation();

    if (e.nativeEvent) {
        e.nativeEvent.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
    }

    selectPrimitiveById(id);
    if (onSelect) onSelect(id);
}

export function handleContactDiskClick(
    e: any,
    id: string,
    isInteractable: boolean,
    isParentSelected: boolean,
    isContactDiskSelected: boolean,
    onSelect?: (id: string) => void
) {
    if (!isInteractable) return;

    if (!isParentSelected && !isContactDiskSelected) {
        return;
    }

    e.stopPropagation();

    if (e.nativeEvent) {
        e.nativeEvent.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
    }

    selectPrimitiveById(id);
    if (onSelect) onSelect(id);
}
