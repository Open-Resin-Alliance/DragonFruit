import { useEffect } from 'react';
import type { TransformMode } from '@/hooks/useModelTransform';
import type { SupportMode } from '@/supports/types';
import { hotkeyStore, isActionActiveSync } from './hotkeyStore';

type UsePrepareTransformHotkeysParams = {
  appMode: SupportMode;
  hasModels: boolean;
  transformMode: TransformMode;
  setTransformMode: (mode: TransformMode) => void;
  onArrangeAll: () => void;
};

export function usePrepareTransformHotkeys({
  appMode,
  hasModels,
  transformMode,
  setTransformMode,
  onArrangeAll,
}: UsePrepareTransformHotkeysParams) {
  useEffect(() => {
    if (appMode !== 'prepare') return;
    if (!hasModels) return;

    let wasSelectActive = false;
    let wasModifyActive = false;
    let wasSmoothActive = false;
    let wasArrangeActive = false;
    let wasDuplicateActive = false;
    let wasEscapeActive = false;

    const unsubscribe = hotkeyStore.subscribe(() => {
      const isSelectActive = isActionActiveSync('CANVAS', 'TOOL_SELECT');
      const isModifyActive = isActionActiveSync('CANVAS', 'TOOL_MODIFY');
      const isSmoothActive = isActionActiveSync('CANVAS', 'TOOL_SMOOTH');
      const isArrangeActive = isActionActiveSync('CANVAS', 'TOOL_ARRANGE');
      const isDuplicateActive = isActionActiveSync('CANVAS', 'TOOL_DUPLICATE');
      const isEscapeActive = hotkeyStore.getState().activeKeys.has('escape');

      if (isSelectActive && !wasSelectActive) {
        setTransformMode('select');
      } else if (isModifyActive && !wasModifyActive) {
        setTransformMode('transform');
      } else if (isSmoothActive && !wasSmoothActive) {
        setTransformMode('smoothing');
      } else if (isArrangeActive && !wasArrangeActive) {
        if (transformMode === 'arrange') {
          onArrangeAll();
        } else {
          setTransformMode('arrange');
        }
      } else if (isDuplicateActive && !wasDuplicateActive) {
        setTransformMode('arrange');
      } else if (isEscapeActive && !wasEscapeActive && transformMode === 'mirror') {
        setTransformMode('select');
      }

      wasSelectActive = isSelectActive;
      wasModifyActive = isModifyActive;
      wasSmoothActive = isSmoothActive;
      wasArrangeActive = isArrangeActive;
      wasDuplicateActive = isDuplicateActive;
      wasEscapeActive = isEscapeActive;
    });

    return unsubscribe;
  }, [appMode, hasModels, transformMode, setTransformMode, onArrangeAll]);
}
