const EVENT_NAME = 'dragonfruit-support-interaction-reset';

export interface SupportInteractionResetPayload {
  reason: string;
  timestampMs: number;
}

export function emitSupportInteractionReset(reason = 'support-store-replaced') {
  if (typeof window === 'undefined') return;

  const w = window as any;
  // Ensure interaction lock cannot survive scene/store replacement.
  w.__jointGizmoDragging = false;
  w.__jointGizmoGuardUntil = 0;

  const payload: SupportInteractionResetPayload = {
    reason,
    timestampMs: Date.now(),
  };

  window.dispatchEvent(new CustomEvent<SupportInteractionResetPayload>(EVENT_NAME, { detail: payload }));
}

export function subscribeSupportInteractionReset(listener: (payload: SupportInteractionResetPayload) => void) {
  if (typeof window === 'undefined') return () => {};

  const handle = (event: Event) => {
    const detail = (event as CustomEvent<SupportInteractionResetPayload>).detail;
    listener(detail ?? { reason: 'unknown', timestampMs: Date.now() });
  };

  window.addEventListener(EVENT_NAME, handle as EventListener);
  return () => {
    window.removeEventListener(EVENT_NAME, handle as EventListener);
  };
}
