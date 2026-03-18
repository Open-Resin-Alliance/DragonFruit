import { useEffect, useState } from 'react';
import { usePicking } from '@/components/picking';
import { setHoveredCategory, setHoveredId } from '@/supports/state';
import { isContactDiskHudInteractionActive } from '@/supports/SupportPrimitives/ContactDisk/contactDiskHudInteraction';

/**
 * Syncs the GPU picking state to the global support state store.
 * This allows non-React logic (like useInteractionStatus) to know what is being hovered.
 */
export function PickingStateSyncer() {
    const { hit } = usePicking();
    const [contactDiskHudInteractionActive, setContactDiskHudInteractionActive] = useState(() => isContactDiskHudInteractionActive());

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const handleContactDiskHudInteractionChange = (event: Event) => {
            const detail = (event as CustomEvent<{ active?: boolean }>).detail;
            setContactDiskHudInteractionActive(!!detail?.active);
        };

        window.addEventListener('contact-disk-hud-interaction-change', handleContactDiskHudInteractionChange as EventListener);
        return () => {
            window.removeEventListener('contact-disk-hud-interaction-change', handleContactDiskHudInteractionChange as EventListener);
        };
    }, []);

    useEffect(() => {
        if (contactDiskHudInteractionActive) return;
        // Update global store with the category and ID of the hovered item
        setHoveredCategory(hit.category);
        setHoveredId(hit.objectId);
    }, [hit.category, hit.objectId, contactDiskHudInteractionActive]);

    return null;
}
