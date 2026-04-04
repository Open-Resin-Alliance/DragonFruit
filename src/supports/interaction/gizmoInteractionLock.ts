type SupportInteractionWindow = Window & {
    __jointGizmoDragging?: boolean;
    __knotGizmoDragging?: boolean;
    __bezierGizmoDragging?: boolean;
    __jointGizmoGuardUntil?: number;
    __knotGizmoGuardUntil?: number;
    __bezierGizmoGuardUntil?: number;
};

function getSupportInteractionWindow(): SupportInteractionWindow | null {
    if (typeof window === 'undefined') return null;
    return window as SupportInteractionWindow;
}

function getInteractionGuardUntilMs(w: SupportInteractionWindow): number {
    const knotGuardUntil = typeof w.__knotGizmoGuardUntil === 'number' ? w.__knotGizmoGuardUntil : 0;
    const jointGuardUntil = typeof w.__jointGizmoGuardUntil === 'number' ? w.__jointGizmoGuardUntil : 0;
    const bezierGuardUntil = typeof w.__bezierGizmoGuardUntil === 'number' ? w.__bezierGizmoGuardUntil : 0;
    return Math.max(knotGuardUntil, jointGuardUntil, bezierGuardUntil);
}

/**
 * True while support gizmo edits are actively dragging, plus a brief post-drag guard window.
 */
export function isSupportEditInteractionActive(nowMs = Date.now()): boolean {
    const w = getSupportInteractionWindow();
    if (!w) return false;

    if (w.__jointGizmoDragging || w.__knotGizmoDragging || w.__bezierGizmoDragging) {
        return true;
    }

    return getInteractionGuardUntilMs(w) > nowMs;
}
