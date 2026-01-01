import { useEffect } from 'react';
import { usePicking } from '@/components/picking';
import { setHoveredCategory, setHoveredId } from '@/supports/state';

/**
 * Syncs the GPU picking state to the global support state store.
 * This allows non-React logic (like useInteractionStatus) to know what is being hovered.
 */
export function PickingStateSyncer() {
    const { hit } = usePicking();

    useEffect(() => {
        // Update global store with the category and ID of the hovered item
        setHoveredCategory(hit.category);
        setHoveredId(hit.objectId);
    }, [hit.category, hit.objectId]);

    return null;
}
