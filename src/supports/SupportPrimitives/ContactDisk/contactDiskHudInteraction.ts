import { setHoveredState } from '../../state';

let contactDiskHudHoverActive = false;
let contactDiskHudDraggingActive = false;
let contactDiskHudId: string | null = null;
let contactDiskHudPointerCaptureActive = false;
let contactDiskHudPlacementSuppressUntilMs = 0;
const CONTACT_DISK_HUD_POST_DRAG_SUPPRESS_MS = 250;

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
        setHoveredState('contactDisk', contactDiskHudId);
    } else if (!contactDiskHudDraggingActive) {
        setHoveredState('none', null);
    }
    emitHudInteractionEvent();
}

export function setContactDiskHudDraggingActive(active: boolean) {
    const wasDragging = contactDiskHudDraggingActive;
    contactDiskHudDraggingActive = active;
    if (wasDragging && !active) {
        contactDiskHudPlacementSuppressUntilMs = Date.now() + CONTACT_DISK_HUD_POST_DRAG_SUPPRESS_MS;
    }
    if (active && contactDiskHudId) {
        setHoveredState('contactDisk', contactDiskHudId);
    } else if (!contactDiskHudHoverActive) {
        setHoveredState('none', null);
    }
    emitHudInteractionEvent();
}

export function setContactDiskHudInteractionTarget(id: string | null) {
    contactDiskHudId = id;
    if (!id && !contactDiskHudHoverActive && !contactDiskHudDraggingActive && !contactDiskHudPointerCaptureActive) {
        setHoveredState('none', null);
    }
}

export function isContactDiskHudInteractionActive() {
    return contactDiskHudHoverActive || contactDiskHudDraggingActive || contactDiskHudPointerCaptureActive;
}

export function isContactDiskHudDraggingActive() {
    return contactDiskHudDraggingActive;
}

export function setContactDiskHudPointerCaptureActive(active: boolean) {
    const wasPointerCaptureActive = contactDiskHudPointerCaptureActive;
    contactDiskHudPointerCaptureActive = active;
    if (wasPointerCaptureActive && !active) {
        contactDiskHudPlacementSuppressUntilMs = Date.now() + CONTACT_DISK_HUD_POST_DRAG_SUPPRESS_MS;
    }
    if (active && contactDiskHudId) {
        setHoveredState('contactDisk', contactDiskHudId);
    } else if (!contactDiskHudHoverActive && !contactDiskHudDraggingActive) {
        setHoveredState('none', null);
    }
    emitHudInteractionEvent();
}

export function shouldSuppressContactDiskHudPlacementCommit() {
    return contactDiskHudPointerCaptureActive
        || contactDiskHudDraggingActive
        || Date.now() < contactDiskHudPlacementSuppressUntilMs;
}
