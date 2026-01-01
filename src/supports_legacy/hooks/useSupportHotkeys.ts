import { useEffect } from 'react';
import { undoSupportAction, redoSupportAction, setCurrentSupportSettings, getCurrentSupportSettings } from '@/supports_legacy/state';
import { setActivePreset, getPresetById } from '@/supports_legacy/presets';
import type { SupportMode } from '@/supports_legacy/types';

// Consolidates undo/redo and preset hotkeys so page.tsx stays lean.
export function useSupportHotkeys(mode: SupportMode) {
  // Undo/redo hotkeys
  useEffect(() => {
    const handleUndoRedo = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (!isMeta) return;
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        undoSupportAction();
        e.preventDefault();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        redoSupportAction();
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handleUndoRedo);
    return () => window.removeEventListener('keydown', handleUndoRedo);
  }, []);

  // Preset hotkeys (1/2/3) - only in Support mode
  useEffect(() => {
    const handlePresetHotkey = (e: KeyboardEvent) => {
      if (mode !== 'support') return;

      // Ignore if user is typing in an input field
      const target = e.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

      const key = e.key;
      let presetId: string | null = null;

      if (key === '1') presetId = 'detail';
      else if (key === '2') presetId = 'structure';
      else if (key === '3') presetId = 'anchor';

      if (presetId) {
        setActivePreset(presetId);
        const preset = getPresetById(presetId);
        if (preset) {
          // Preserve grid settings
          const currentSettings = getCurrentSupportSettings();
          setCurrentSupportSettings({
            ...preset.settings,
            grid: currentSettings.grid || preset.settings.grid
          });
          console.log('[Hotkey] Switched to preset:', preset.name);
        }
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', handlePresetHotkey);
    return () => window.removeEventListener('keydown', handlePresetHotkey);
  }, [mode]);
}
