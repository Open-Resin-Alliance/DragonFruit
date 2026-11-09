import { useSyncExternalStore } from 'react';
import {
    getHoveredCategory,
    getHoveredId,
    getSelectedCategory,
    subscribe,
} from '@/supports/state';
import {
    getImmediateModelHoverIdSnapshot,
    resolveModelHover,
    subscribeImmediateModelHover,
} from './modelHoverResolver';
import { resolveHoverSuppressionReason } from './hoverSuppression';
import {
    EMPTY_RESOLVED_HOVER_STATE,
    type HoverIntent,
    type ResolvedHoverState,
} from './hoverTypes';
import type { Vec3 } from '@/supports/types';
import { resolveHoverSource, resolveSupportHover } from './supportHoverResolver';
import { hasWindow } from '@/utils/dom';

const listeners = new Set<() => void>();

let initialized = false;
let unsubscribeSupport: (() => void) | null = null;
let unsubscribeModelHover: (() => void) | null = null;
let resolvedHoverSnapshot: ResolvedHoverState = EMPTY_RESOLVED_HOVER_STATE;

let orbitActive = false;
let marqueeActive = false;
/**
 * A release that should not republish hover yet.
 *
 * Orbit modes with damping keep moving the camera after pointerup. Publishing
 * `orbitActive = false` there makes every `useResolvedHoverState` subscriber
 * render while the camera is still gliding, and the render is long enough to
 * drop a frame (the release stutter). The hover stays suppressed until the
 * pointer actually moves again, or another input starts.
 */
let resumeHoverOnPointerMove = false;
let resumeHoverTimer: number | null = null;
/** Damping on the slowest feel preset is settled well inside this window. */
const RESUME_HOVER_AFTER_RELEASE_MS = 350;

const handleOrbitStart = () => {
  resumeHoverOnPointerMove = false;
  if (resumeHoverTimer !== null) {
    window.clearTimeout(resumeHoverTimer);
    resumeHoverTimer = null;
  }
  setOrbitActive(true);
};
const endOrbitAfterRelease = () => {
  if (!orbitActive) return;
  orbitActive = false;
  resumeHoverOnPointerMove = true;
  if (resumeHoverTimer === null) {
    resumeHoverTimer = window.setTimeout(resumeHover, RESUME_HOVER_AFTER_RELEASE_MS);
  }
};
const handleOrbitEnd = () => endOrbitAfterRelease();
const handlePointerEnd = () => endOrbitAfterRelease();
const handlePointerMoveResume = (event: PointerEvent) => {
  if (!resumeHoverOnPointerMove || event.buttons !== 0) return;
  resumeHover();
};
const handlePointerDownResume = () => {
  if (resumeHoverOnPointerMove) resumeHover();
};
const handleWheelResume = () => {
  if (resumeHoverOnPointerMove) resumeHover();
};
const handleMarqueeActive = (event: Event) => {
    const customEvent = event as CustomEvent<{ active?: boolean }>;
    setMarqueeActive(!!customEvent.detail?.active);
};
const handleMarqueeEnd = () => setMarqueeActive(false);
const handleWindowBlur = () => {
    resumeHoverOnPointerMove = false;
    if (resumeHoverTimer !== null) {
        window.clearTimeout(resumeHoverTimer);
        resumeHoverTimer = null;
    }
    setOrbitActive(false);
    setMarqueeActive(false);
};

/** Publish the release once the user asks for hover again by moving the pointer. */
function resumeHover() {
    resumeHoverOnPointerMove = false;
    if (resumeHoverTimer !== null) {
        window.clearTimeout(resumeHoverTimer);
        resumeHoverTimer = null;
    }
    notify();
}

function notify() {
    listeners.forEach((listener) => listener());
}

function setOrbitActive(next: boolean) {
    if (orbitActive === next) return;
    orbitActive = next;
    notify();
}

function setMarqueeActive(next: boolean) {
    if (marqueeActive === next) return;
    marqueeActive = next;
    notify();
}

function ensureInitialized() {
    if (initialized || !hasWindow()) return;
    initialized = true;

    unsubscribeSupport = subscribe(notify);
    unsubscribeModelHover = subscribeImmediateModelHover(notify);

    window.addEventListener('picking-orbit-start', handleOrbitStart);
    window.addEventListener('picking-orbit-change', handleOrbitStart);
    window.addEventListener('picking-orbit-end', handleOrbitEnd);
    window.addEventListener('pointerup', handlePointerEnd, true);
    window.addEventListener('pointercancel', handlePointerEnd, true);
    window.addEventListener('pointermove', handlePointerMoveResume, true);
    window.addEventListener('pointerdown', handlePointerDownResume, true);
    window.addEventListener('wheel', handleWheelResume, { capture: true, passive: true });
    window.addEventListener('support-marquee-selection-active', handleMarqueeActive as EventListener);
    window.addEventListener('support-marquee-selection-end', handleMarqueeEnd);
    window.addEventListener('blur', handleWindowBlur);
}

function teardownInitializedResources() {
    if (hasWindow()) {
        window.removeEventListener('picking-orbit-start', handleOrbitStart);
        window.removeEventListener('picking-orbit-change', handleOrbitStart);
        window.removeEventListener('picking-orbit-end', handleOrbitEnd);
        window.removeEventListener('pointerup', handlePointerEnd, true);
        window.removeEventListener('pointercancel', handlePointerEnd, true);
        window.removeEventListener('support-marquee-selection-active', handleMarqueeActive as EventListener);
        window.removeEventListener('support-marquee-selection-end', handleMarqueeEnd);
        window.removeEventListener('blur', handleWindowBlur);
    }
    unsubscribeSupport?.();
    unsubscribeSupport = null;
    unsubscribeModelHover?.();
    unsubscribeModelHover = null;
    orbitActive = false;
    marqueeActive = false;
    resumeHoverOnPointerMove = false;
    if (resumeHoverTimer !== null) {
        window.clearTimeout(resumeHoverTimer);
        resumeHoverTimer = null;
    }
    initialized = false;
}

function areVec3Equal(a: Vec3 | undefined, b: Vec3 | undefined): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y && a.z === b.z;
}

function areResolvedHoverStatesEqual(a: ResolvedHoverState, b: ResolvedHoverState): boolean {
    return (
        a.activeSource === b.activeSource
        && a.intent === b.intent
        && a.blockedReason === b.blockedReason
        && a.isStale === b.isStale
        && (a.modelHit?.modelId ?? null) === (b.modelHit?.modelId ?? null)
        && areVec3Equal(a.modelHit?.point, b.modelHit?.point)
        && (a.supportHit?.id ?? null) === (b.supportHit?.id ?? null)
        && (a.supportHit?.category ?? null) === (b.supportHit?.category ?? null)
    );
}

function resolveIntent(activeSource: ResolvedHoverState['activeSource'], blocked: boolean): HoverIntent {
    if (activeSource === 'none') return 'none';
    if (blocked) return 'suppressed';
    if (activeSource === 'model') return 'placement';
    return 'selection';
}

export function getResolvedHoverSnapshot(): ResolvedHoverState {
    ensureInitialized();

    const hoveredCategory = getHoveredCategory();
    const hoveredId = getHoveredId();
    const selectedCategory = getSelectedCategory();

    const modelHover = resolveModelHover(getImmediateModelHoverIdSnapshot());
    const supportHover = resolveSupportHover(hoveredId, hoveredCategory);
    const isGizmoActive = selectedCategory === 'joint';

    const activeSource = resolveHoverSource(!!modelHover, !!supportHover, isGizmoActive);
    const blockedReason = resolveHoverSuppressionReason({
        activeSource,
        isGizmoActive,
        orbitActive,
        marqueeActive,
        interactionDisabled: false,
    });

    const intent = resolveIntent(activeSource, blockedReason !== null);
    const isStale = !!(supportHover && modelHover);

    const nextSnapshot: ResolvedHoverState = {
        activeSource,
        intent,
        modelHit: modelHover,
        supportHit: supportHover,
        blockedReason,
        isStale,
    };

    if (areResolvedHoverStatesEqual(resolvedHoverSnapshot, nextSnapshot)) {
        return resolvedHoverSnapshot;
    }

    resolvedHoverSnapshot = nextSnapshot;
    return resolvedHoverSnapshot;
}

export function subscribeResolvedHover(listener: () => void) {
    ensureInitialized();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        teardownInitializedResources();
        resolvedHoverSnapshot = EMPTY_RESOLVED_HOVER_STATE;
    };
}

export function useResolvedHoverState() {
    return useSyncExternalStore(
        subscribeResolvedHover,
        getResolvedHoverSnapshot,
        () => EMPTY_RESOLVED_HOVER_STATE,
    );
}
