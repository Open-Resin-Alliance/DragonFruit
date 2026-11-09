import React from 'react';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';

type OutsideDismissOptions = {
  /**
   * Pointer down inside this element does not dismiss. Set it to the toggle
   * button that owns a dropdown, so its own click can close the surface.
   */
  ignoreRef?: React.RefObject<HTMLElement | null>;
  /** Default true. */
  dismissOnResize?: boolean;
  /** Default true. A popover anchored to layout should close when the page scrolls. */
  dismissOnScroll?: boolean;
};

/**
 * The dismissal every anchored surface shares: outside pointer down, Escape
 * through the dialog stack, window resize and scroll.
 *
 * Menus get this from `ContextMenu`, which owns the whole lifecycle; reach for
 * this hook when a surface is not a menu (a popover, a slider's thumb editor, an
 * anchored dialog) and would otherwise hand-roll the listeners.
 */
export function useOutsideDismiss(open: boolean, onDismiss: () => void, options: OutsideDismissOptions = {}) {
  const { ignoreRef, dismissOnResize = true, dismissOnScroll = true } = options;

  useEscapeToClose(open, onDismiss);

  React.useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && ignoreRef?.current?.contains(target)) return;
      onDismiss();
    };
    const handleLayoutChange = () => onDismiss();

    window.addEventListener('pointerdown', handlePointerDown);
    if (dismissOnResize) window.addEventListener('resize', handleLayoutChange);
    if (dismissOnScroll) window.addEventListener('scroll', handleLayoutChange, true);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      if (dismissOnResize) window.removeEventListener('resize', handleLayoutChange);
      if (dismissOnScroll) window.removeEventListener('scroll', handleLayoutChange, true);
    };
  }, [dismissOnResize, dismissOnScroll, ignoreRef, onDismiss, open]);
}
