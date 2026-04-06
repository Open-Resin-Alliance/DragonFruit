import { useMemo } from 'react';

/** Returns "Cmd" on macOS, "Ctrl" on other platforms. */
export function usePlatformModifier(): string {
  return useMemo(() => {
    const platform = (navigator as any).userAgentData?.platform ?? navigator.platform ?? '';
    return platform.startsWith('Mac') ? 'Cmd' : 'Ctrl';
  }, []);
}
