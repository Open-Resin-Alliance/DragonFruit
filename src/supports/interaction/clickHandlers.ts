import { selectSupport, selectJoint } from './SupportSelection';
import { setSelectedId, getModelIdForSupportEntityId } from '../state';

/**
 * Logic for handling clicks on Support objects (Trunks, Branches).
 * Enforces interactability check and stops DOM propagation to prevent canvas deselection.
 */
export function handleSupportClick(e: any, id: string, isInteractable: boolean) {
    if (!isInteractable) {
        const modelId = getModelIdForSupportEntityId(id);
        if (modelId) {
            window.dispatchEvent(new CustomEvent('support-model-pointer-select', {
                detail: {
                    supportId: id,
                    modelId,
                },
            }));
        }
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
