import { useEffect } from 'react';
import type { SupportMode } from '@/supports/types';
import { removeSupport } from '@/supports/state';

export function useSupportDeletion(
  mode: SupportMode,
  selectedSupportId: string | null,
  setSelectedSupportId: (id: string | null) => void
) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode === 'support' && selectedSupportId && (e.key === 'Delete' || e.key === 'Backspace')) {
        removeSupport(selectedSupportId);
        setSelectedSupportId(null);
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [mode, selectedSupportId, setSelectedSupportId]);
}
