import { useEffect } from 'react';
import type { TransformMode } from '@/hooks/useModelTransform';
import { useHotkeyConfig } from './HotkeyContext';
import { matchesConfiguredHotkeyDown } from './hotkeyConfig';

type UsePrepareTransformHotkeysParams = {
  appMode: 'prepare' | 'analysis' | 'support' | 'export';
  hasModels: boolean;
  setTransformMode: (mode: TransformMode) => void;
};

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function usePrepareTransformHotkeys({
  appMode,
  hasModels,
  setTransformMode,
}: UsePrepareTransformHotkeysParams) {
  const { getHotkey } = useHotkeyConfig();
  const selectKey = getHotkey('CANVAS', 'TOOL_SELECT');
  const modifyKey = getHotkey('CANVAS', 'TOOL_MODIFY');
  const smoothKey = getHotkey('CANVAS', 'TOOL_SMOOTH');
  const arrangeKey = getHotkey('CANVAS', 'TOOL_ARRANGE');
  const duplicateKey = getHotkey('CANVAS', 'TOOL_DUPLICATE');

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (appMode !== 'prepare') return;
      if (!hasModels) return;
      if (event.repeat) return;
      if (isEditableElement(event.target)) return;

      if (matchesConfiguredHotkeyDown(event, { key: selectKey.key, modifier: selectKey.modifier })) {
        event.preventDefault();
        setTransformMode('select');
        return;
      }

      if (matchesConfiguredHotkeyDown(event, { key: modifyKey.key, modifier: modifyKey.modifier })) {
        event.preventDefault();
        setTransformMode('transform');
        return;
      }

      if (matchesConfiguredHotkeyDown(event, { key: smoothKey.key, modifier: smoothKey.modifier })) {
        event.preventDefault();
        setTransformMode('smoothing');
        return;
      }

      if (matchesConfiguredHotkeyDown(event, { key: arrangeKey.key, modifier: arrangeKey.modifier })) {
        event.preventDefault();
        setTransformMode('arrange');
        return;
      }

      if (matchesConfiguredHotkeyDown(event, { key: duplicateKey.key, modifier: duplicateKey.modifier })) {
        event.preventDefault();
        setTransformMode('duplicate');
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [
    appMode,
    hasModels,
    setTransformMode,
    selectKey,
    modifyKey,
    smoothKey,
    arrangeKey,
    duplicateKey,
  ]);
}
