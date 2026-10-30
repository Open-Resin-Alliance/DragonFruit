import { useSyncExternalStore } from 'react';

/** The platform never changes while the page is open, so there is nothing to subscribe to. */
export function subscribeToPlatform(): () => void {
  return () => {};
}

export function detectPlatform(): 'mac' | 'windows' | 'linux' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  if (ua.startsWith('Mac') || ua === 'macOS') return 'mac';
  if (ua.startsWith('Win')) return 'windows';
  if (ua.startsWith('Linux') || ua === 'linux') return 'linux';
  return 'unknown';
}

// The server snapshot is false so the first render matches the prerendered HTML.
export function useIsLinux(): boolean {
  return useSyncExternalStore(
    subscribeToPlatform,
    () => detectPlatform() === 'linux',
    () => false,
  );
}

// iOS WebKit greys out files whose extension it can't map to a known UTI
// (e.g. .stl, .3mf), so callers relax a file input's `accept` on iOS and rely
// on extension validation when the picked files are processed.
export function detectIsIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent ?? '';
  // iPhone/iPod/iPad, plus iPadOS 13+ which reports as Macintosh but is touch.
  return /iP(hone|od|ad)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
