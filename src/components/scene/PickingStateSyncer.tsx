import { useEffect, useState } from 'react';
import { usePicking } from '@/components/picking';
import { setHoveredState } from '@/supports/state';
import { isContactDiskHudInteractionActive } from '@/supports/SupportPrimitives/ContactDisk/contactDiskHudInteraction';
import { isSupportEditInteractionActive } from '@/supports/interaction/gizmoInteractionLock';

/**
 * Syncs the GPU picking state to the global support state store.
 * This allows non-React logic (like useInteractionStatus) to know what is being hovered.
 */
export function PickingStateSyncer({ enabled = true }: { enabled?: boolean }) {
    const { hit, isDragging } = usePicking();
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
        if (!enabled) {
            setHoveredState('none', null);
            return;
        }

        const hoverSyncSuppressed = contactDiskHudInteractionActive || isDragging || isSupportEditInteractionActive();

        if (hoverSyncSuppressed) {
            setHoveredState('none', null);
            return;
        }

        // Update global store with the category and ID of the hovered item
        setHoveredState(hit.category, hit.objectId);
    }, [enabled, hit.category, hit.objectId, contactDiskHudInteractionActive, isDragging]);

    return null;
}
