import { selectSupport, selectJoint } from './SupportSelection';
import { setSelectedId } from '../state';

let hoverGuardInitialized = false;
let orbitInteractionActive = false;
let pendingHoverModelId: string | null = null;
let lastDispatchedHoverModelId: string | null = null;
let pendingHoverDispatchRaf: number | null = null;

function initializeHoverGuards() {
    if (hoverGuardInitialized || typeof window === 'undefined') return;
    hoverGuardInitialized = true;

    const markOrbitActive = () => {
        orbitInteractionActive = true;
        if (pendingHoverDispatchRaf != null) {
            cancelAnimationFrame(pendingHoverDispatchRaf);
            pendingHoverDispatchRaf = null;
        }
        pendingHoverModelId = null;
    };

    const markOrbitInactive = () => {
        orbitInteractionActive = false;
    };

    window.addEventListener('picking-orbit-start', markOrbitActive);
    window.addEventListener('picking-orbit-change', markOrbitActive);
    window.addEventListener('picking-orbit-end', markOrbitInactive);
}

export function emitSupportModelPointerHover(modelId: string | null) {
    if (typeof window === 'undefined') return;

    initializeHoverGuards();

    if (orbitInteractionActive) return;

    pendingHoverModelId = modelId;
    if (pendingHoverDispatchRaf != null) return;

    pendingHoverDispatchRaf = requestAnimationFrame(() => {
        pendingHoverDispatchRaf = null;
        const nextModelId = pendingHoverModelId;
        pendingHoverModelId = null;

        if (nextModelId === lastDispatchedHoverModelId) return;
        lastDispatchedHoverModelId = nextModelId;

        window.dispatchEvent(new CustomEvent('support-raft-model-pointer-hover', {
            detail: {
                modelId: nextModelId,
                category: 'support',
            },
        }));
    });
}

/**
 * Logic for handling clicks on Support objects (Trunks, Branches).
 * Enforces interactability check and stops DOM propagation to prevent canvas deselection.
 */
export function handleSupportClick(e: any, id: string, isInteractable: boolean) {
    if (!isInteractable) {
        return;
    }
    
    e.stopPropagation(); // Stop R3F propagation
    
    // Stop DOM propagation to prevent SceneCanvas handleCanvasClick from clearing selection
    if (e.nativeEvent) {
        e.nativeEvent.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
    }
    
    selectSupport(id);
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

    selectJoint(id);
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

    setSelectedId(id);
    if (onSelect) onSelect(id);
}
