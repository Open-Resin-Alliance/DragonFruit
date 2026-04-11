import { useMemo } from 'react';

/** Detect the host OS from the browser's navigator API. */
function detectPlatform(): 'mac' | 'windows' | 'linux' | 'unknown' {
  const ua = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  if (ua.startsWith('Mac') || ua === 'macOS') return 'mac';
  if (ua.startsWith('Win')) return 'windows';
  if (ua.startsWith('Linux') || ua === 'linux') return 'linux';
  return 'unknown';
}

/** Returns true when the app is running on Linux (WebKitGTK or CEF). */
export function useIsLinux(): boolean {
  return useMemo(() => detectPlatform() === 'linux', []);
}
