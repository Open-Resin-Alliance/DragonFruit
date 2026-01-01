import { useEffect, useRef } from 'react';
import { SupportMode } from '@/supports_legacy/types';

export function useJointCreationHotkey(
  mode: SupportMode,
  onActivate: () => void,
  onDeactivate: () => void,
) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode !== 'support') return;
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
      if (e.key.toLowerCase() === 'j' && !e.repeat) onActivate();
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'j') onDeactivate();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [mode, onActivate, onDeactivate]);
}
