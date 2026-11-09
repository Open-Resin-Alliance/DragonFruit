/**
 * Whether DragonFruit's window is the OS-active window.
 *
 * Both SpaceMouse controllers gate on this: input must be ignored for as long as
 * another application is in front, in the native (navlib) path and in the
 * Gamepad-API path alike. The authority is the window's own focus — Tauri's
 * `onFocusChanged`, which is the OS window event the native bridge also follows
 * (`spacemouse::track_window_focus`) — with the webview's own signal as the
 * fallback outside the shell (browser dev, tests).
 *
 * Tracking is reference-counted, so the listeners exist only while a controller
 * needs them.
 */
import { isTauriRuntime } from '@/utils/tauriRuntime';

let focused = true;
let retained = 0;
let detach: (() => void) | null = null;

/** The window's focus as last reported. Optimistic until the first report. */
export function getWindowFocused(): boolean {
  return focused;
}

/**
 * Track window focus for as long as the caller needs it. The returned function
 * releases; the last release tears the listeners down.
 */
export function retainWindowFocus(): () => void {
  retained += 1;
  if (retained === 1) {
    detach = attachFocusTracking();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    retained -= 1;
    if (retained === 0) {
      detach?.();
      detach = null;
    }
  };
}

function attachFocusTracking(): () => void {
  if (typeof window === 'undefined') return () => {};
  if (!isTauriRuntime()) return attachDocumentFocusTracking();

  let disposed = false;
  let unlisten: (() => void) | null = null;
  let fallback: (() => void) | null = null;

  void (async () => {
    try {
      // Dynamic on purpose: `@tauri-apps/api/window` must not be pulled into the
      // SSR/browser bundle, where no window exists to attach to.
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const currentWindow = getCurrentWindow();
      const stop = await currentWindow.onFocusChanged(({ payload }) => {
        focused = payload;
      });
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      // Seed from the window: an event only arrives on the next change, and the
      // app can be created unfocused (e.g. launched behind another window).
      focused = await currentWindow.isFocused();
    } catch {
      // Window API unavailable — the document signal is better than nothing.
      if (!disposed) fallback = attachDocumentFocusTracking();
    }
  })();

  return () => {
    disposed = true;
    unlisten?.();
    fallback?.();
    fallback = null;
  };
}

/** Fallback source: the webview's own focus/blur and visibility. */
function attachDocumentFocusTracking(): () => void {
  const update = () => {
    focused = document.hasFocus() && !document.hidden;
  };

  update();
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);

  return () => {
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
  };
}
