import { setHoveredCategory, setHoveredId } from '../../state';

let contactDiskHudHoverActive = false;
let contactDiskHudDraggingActive = false;
let contactDiskHudId: string | null = null;
let contactDiskHudPointerCaptureActive = false;

function emitHudInteractionEvent() {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('contact-disk-hud-interaction-change', {
        detail: {
            hovered: contactDiskHudHoverActive,
            dragging: contactDiskHudDraggingActive,
            pointerCapture: contactDiskHudPointerCaptureActive,
            active: contactDiskHudHoverActive || contactDiskHudDraggingActive || contactDiskHudPointerCaptureActive,
        },
    }));
}

export function setContactDiskHudHoverActive(active: boolean) {
    contactDiskHudHoverActive = active;
    if (active && contactDiskHudId) {
        setHoveredId(contactDiskHudId);
        setHoveredCategory('contactDisk');
    } else if (!contactDiskHudDraggingActive) {
        setHoveredId(null);
        setHoveredCategory('none');
    }
    emitHudInteractionEvent();
}

export function setContactDiskHudDraggingActive(active: boolean) {
    contactDiskHudDraggingActive = active;
    if (active && contactDiskHudId) {
        setHoveredId(contactDiskHudId);
        setHoveredCategory('contactDisk');
    } else if (!contactDiskHudHoverActive) {
        setHoveredId(null);
        setHoveredCategory('none');
    }
    emitHudInteractionEvent();
}

export function setContactDiskHudInteractionTarget(id: string | null) {
    contactDiskHudId = id;
    if (!id && !contactDiskHudHoverActive && !contactDiskHudDraggingActive && !contactDiskHudPointerCaptureActive) {
        setHoveredId(null);
        setHoveredCategory('none');
    }
}

export function isContactDiskHudInteractionActive() {
    return contactDiskHudHoverActive || contactDiskHudDraggingActive || contactDiskHudPointerCaptureActive;
}

export function isContactDiskHudDraggingActive() {
    return contactDiskHudDraggingActive;
}

export function setContactDiskHudPointerCaptureActive(active: boolean) {
    contactDiskHudPointerCaptureActive = active;
    if (active && contactDiskHudId) {
        setHoveredId(contactDiskHudId);
        setHoveredCategory('contactDisk');
    } else if (!contactDiskHudHoverActive && !contactDiskHudDraggingActive) {
        setHoveredId(null);
        setHoveredCategory('none');
    }
    emitHudInteractionEvent();
}

export function shouldSuppressContactDiskHudPlacementCommit() {
    return contactDiskHudPointerCaptureActive || contactDiskHudDraggingActive;
}
