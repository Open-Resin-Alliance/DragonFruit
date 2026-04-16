import { useEffect, useState } from 'react';

export function detectPlatform(): 'mac' | 'windows' | 'linux' | 'unknown' {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
  if (ua.startsWith('Mac') || ua === 'macOS') return 'mac';
  if (ua.startsWith('Win')) return 'windows';
  if (ua.startsWith('Linux') || ua === 'linux') return 'linux';
  return 'unknown';
}

export function useIsLinux(): boolean {
  const [isLinux, setIsLinux] = useState(false);
  useEffect(() => {
    setIsLinux(detectPlatform() === 'linux');
  }, []);
  return isLinux;
}
