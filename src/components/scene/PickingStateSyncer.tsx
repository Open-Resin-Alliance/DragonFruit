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
    // Camera navigation changes the picking hit every frame while the pointer is
    // over the model. Writing those hits to the support store re-rendered the
    // whole page (supportStateForBounds.hoveredCategory) on a 1M-triangle scene:
    // the 232 ms React tasks in the navigation profile. Hover is not meaningful
    // mid-orbit/pan/zoom, so suppress it until the gesture ends.
    const [cameraNavigationActive, setCameraNavigationActive] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const start = () => setCameraNavigationActive(true);
        const end = () => setCameraNavigationActive(false);
        const starts = [
            'picking-orbit-start',
            'picking-pan-start',
            'picking-zoom-start',
            'spacemouse-navigation-start',
        ];
        const ends = [
            'picking-orbit-end',
            'picking-pan-end',
            'picking-zoom-end',
            'spacemouse-navigation-end',
        ];
        for (const name of starts) window.addEventListener(name, start);
        for (const name of ends) window.addEventListener(name, end);
        window.addEventListener('window-blur', end);
        window.addEventListener('blur', end);
        return () => {
            for (const name of starts) window.removeEventListener(name, start);
            for (const name of ends) window.removeEventListener(name, end);
            window.removeEventListener('window-blur', end);
            window.removeEventListener('blur', end);
        };
    }, []);

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

        const hoverSyncSuppressed = contactDiskHudInteractionActive
            || isDragging
            || cameraNavigationActive
            || isSupportEditInteractionActive();

        if (hoverSyncSuppressed) {
            setHoveredState('none', null);
            return;
        }

        // Update global store with the category and ID of the hovered item
        setHoveredState(hit.category, hit.objectId);
    }, [enabled, hit.category, hit.objectId, contactDiskHudInteractionActive, isDragging, cameraNavigationActive]);

    return null;
}
