import React from 'react';
import type { SceneImportReport } from '@/features/scene/useSceneCollectionManager';

/**
 * Owns the editor shell's toast/notification subsystem: all toast state, timer
 * & raf refs, fade/show effects, and helpers. Extracted verbatim from
 * src/app/page.tsx — every symbol is returned under its original name so Home
 * (and <NotificationStack .../>) consume via destructure-same-names, unchanged.
 *
 * Trigger call-sites (export-flow setExportSuccessToast, undo/redo
 * setHistoryActionToast, autosave save-toast setters, the monitor flow
 * setPrintingMonitorError, scene-import setIsSceneImportToastVisible) stay in
 * Home and call these returned setters/callbacks. The cross-domain save-toast
 * machinery effect lives here but reads the external save-progress state
 * (isSceneSaveInProgress / isPreSliceSceneSaveInProgress / isAutosaving) and the
 * scene import report via the single options object below.
 */
/** Who got oriented — the stack renders the message, never this. */
export type OrientationToastReport = {
    id: number;
    status: 'applied' | 'already-optimal';
    modelName: string;
};

export type UseEditorToastsOptions = {
  /** External save-progress state, read by the save-toast machinery effect. */
  isSceneSaveInProgress: boolean;
  isPreSliceSceneSaveInProgress: boolean;
  isAutosaving: boolean;
  /** Drives the scene-import toast visibility/fade effect. */
  sceneImportReport: SceneImportReport | null;
};

/**
 * Keeps an `animated` toast in the tree for `tailMs` after it is told to hide.
 *
 * A toast whose presence and whose `visible` flag are the same boolean is torn
 * out of the tree in the commit that hides it, so its fade-out never gets to run
 * and it blinks away. Holding the element for one transition is what the other
 * toasts get for free from the gap between their fade timer and their clear
 * timer; this is that gap for the ones that have no second timer.
 */
export function useTrailingMount(visible: boolean, tailMs = 240): boolean {
  const [mounted, setMounted] = React.useState(visible);
  React.useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const timeout = window.setTimeout(() => setMounted(false), tailMs);
    return () => window.clearTimeout(timeout);
  }, [tailMs, visible]);
  return mounted;
}

export function useEditorToasts({
  isSceneSaveInProgress,
  isPreSliceSceneSaveInProgress,
  isAutosaving,
  sceneImportReport,
}: UseEditorToastsOptions) {
  const [historyActionToast, setHistoryActionToast] = React.useState<{ id: number; text: string; direction: 'undo' | 'redo' } | null>(null);
  const [isHistoryActionToastVisible, setIsHistoryActionToastVisible] = React.useState(false);
  const [isSceneImportToastVisible, setIsSceneImportToastVisible] = React.useState(false);
  const [exportSuccessToast, setExportSuccessToast] = React.useState<{ id: number; path: string } | null>(null);
  const [isExportSuccessToastVisible, setIsExportSuccessToastVisible] = React.useState(false);
  const [exportErrorToast, setExportErrorToast] = React.useState<{ id: number; text: string } | null>(null);
  const [isExportErrorToastVisible, setIsExportErrorToastVisible] = React.useState(false);
  const [orientationToast, setOrientationToast] = React.useState<OrientationToastReport | null>(null);
  const [isOrientationToastVisible, setIsOrientationToastVisible] = React.useState(false);
  const orientationToastFadeTimeoutRef = React.useRef<number | null>(null);
  const [isSaveToastVisible, setIsSaveToastVisible] = React.useState(false);
  const [isSaveToastAnimatedVisible, setIsSaveToastAnimatedVisible] = React.useState(false);
  // A mode rather than a label: the wording is resolved where it is rendered,
  // so it follows the active locale instead of freezing English into state.
  const [saveToastMode, setSaveToastMode] = React.useState<'saving' | 'autosaving'>('autosaving');
  const historyActionToastFadeTimeoutRef = React.useRef<number | null>(null);
  const historyActionToastClearTimeoutRef = React.useRef<number | null>(null);
  const printingMonitorErrorToastFadeTimeoutRef = React.useRef<number | null>(null);
  const printingMonitorErrorToastClearTimeoutRef = React.useRef<number | null>(null);
  const sceneImportToastFadeTimeoutRef = React.useRef<number | null>(null);
  const exportSuccessToastFadeTimeoutRef = React.useRef<number | null>(null);
  const exportErrorToastFadeTimeoutRef = React.useRef<number | null>(null);
  const saveToastHideTimeoutRef = React.useRef<number | null>(null);
  const saveToastClearTimeoutRef = React.useRef<number | null>(null);
  const saveToastEnterRafRef = React.useRef<number | null>(null);
  const saveToastShownAtRef = React.useRef<number | null>(null);
  const [printingMonitorErrorToast, setPrintingMonitorErrorToast] = React.useState<{ id: number; text: string } | null>(null);
  const [isPrintingMonitorErrorToastVisible, setIsPrintingMonitorErrorToastVisible] = React.useState(false);
  const lastPrintingMonitorErrorToastRef = React.useRef<{ message: string; atEpochMs: number } | null>(null);
  const clearPrintingMonitorErrorToastTimeouts = React.useCallback(() => {
    if (printingMonitorErrorToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(printingMonitorErrorToastFadeTimeoutRef.current);
      printingMonitorErrorToastFadeTimeoutRef.current = null;
    }
    if (printingMonitorErrorToastClearTimeoutRef.current !== null) {
      window.clearTimeout(printingMonitorErrorToastClearTimeoutRef.current);
      printingMonitorErrorToastClearTimeoutRef.current = null;
    }
  }, []);

  const normalizePrintingMonitorErrorMessage = React.useCallback((message: string) => {
    const normalized = message.trim();
    if (!normalized) return '';

    const lower = normalized.toLowerCase();
    if (lower.includes('tainted canvases may not be exported')) {
      return 'Unable to export this webcam frame directly. Retrying through the secure snapshot proxy.';
    }

    return normalized;
  }, []);

  const setPrintingMonitorError = React.useCallback((nextError: string | null) => {
    const normalized = typeof nextError === 'string' ? normalizePrintingMonitorErrorMessage(nextError) : '';

    if (!normalized) {
      clearPrintingMonitorErrorToastTimeouts();
      setIsPrintingMonitorErrorToastVisible(false);
      setPrintingMonitorErrorToast(null);
      return;
    }

    const now = Date.now();
    const previous = lastPrintingMonitorErrorToastRef.current;
    if (
      previous
      && previous.message === normalized
      && (now - previous.atEpochMs) < 1500
    ) {
      return;
    }

    lastPrintingMonitorErrorToastRef.current = {
      message: normalized,
      atEpochMs: now,
    };

    setPrintingMonitorErrorToast({ id: now, text: normalized });
    setIsPrintingMonitorErrorToastVisible(true);

    clearPrintingMonitorErrorToastTimeouts();
    printingMonitorErrorToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsPrintingMonitorErrorToastVisible(false);
      printingMonitorErrorToastFadeTimeoutRef.current = null;
    }, 2200);

    printingMonitorErrorToastClearTimeoutRef.current = window.setTimeout(() => {
      setPrintingMonitorErrorToast(null);
      printingMonitorErrorToastClearTimeoutRef.current = null;
    }, 2600);
  }, [clearPrintingMonitorErrorToastTimeouts, normalizePrintingMonitorErrorMessage]);

  React.useEffect(() => {
    return () => {
      clearPrintingMonitorErrorToastTimeouts();
    };
  }, [clearPrintingMonitorErrorToastTimeouts]);

  React.useEffect(() => {
    const MIN_SAVE_TOAST_VISIBLE_MS = 2000;
    const TOAST_ANIMATION_MS = 220;
    const hasActiveSaveWork = isSceneSaveInProgress || (isAutosaving && !isPreSliceSceneSaveInProgress);

    if (hasActiveSaveWork) {
      if (saveToastHideTimeoutRef.current !== null) {
        window.clearTimeout(saveToastHideTimeoutRef.current);
        saveToastHideTimeoutRef.current = null;
      }
      if (saveToastClearTimeoutRef.current !== null) {
        window.clearTimeout(saveToastClearTimeoutRef.current);
        saveToastClearTimeoutRef.current = null;
      }
      if (saveToastEnterRafRef.current !== null) {
        window.cancelAnimationFrame(saveToastEnterRafRef.current);
        saveToastEnterRafRef.current = null;
      }

      setSaveToastMode(isSceneSaveInProgress ? 'saving' : 'autosaving');

      if (!isSaveToastVisible) {
        saveToastShownAtRef.current = Date.now();
        setIsSaveToastVisible(true);
        setIsSaveToastAnimatedVisible(false);
        saveToastEnterRafRef.current = window.requestAnimationFrame(() => {
          saveToastEnterRafRef.current = null;
          setIsSaveToastAnimatedVisible(true);
        });
      } else if (!isSaveToastAnimatedVisible) {
        setIsSaveToastAnimatedVisible(true);
      }
      return;
    }

    if (!isSaveToastVisible) {
      saveToastShownAtRef.current = null;
      return;
    }

    const shownAt = saveToastShownAtRef.current ?? Date.now();
    const elapsed = Date.now() - shownAt;
    const remaining = Math.max(0, MIN_SAVE_TOAST_VISIBLE_MS - elapsed);

    if (saveToastHideTimeoutRef.current !== null) {
      window.clearTimeout(saveToastHideTimeoutRef.current);
    }
    saveToastHideTimeoutRef.current = window.setTimeout(() => {
      saveToastHideTimeoutRef.current = null;
      setIsSaveToastAnimatedVisible(false);
      if (saveToastClearTimeoutRef.current !== null) {
        window.clearTimeout(saveToastClearTimeoutRef.current);
      }
      saveToastClearTimeoutRef.current = window.setTimeout(() => {
        saveToastClearTimeoutRef.current = null;
        saveToastShownAtRef.current = null;
        setIsSaveToastVisible(false);
      }, TOAST_ANIMATION_MS);
    }, remaining);
  }, [isAutosaving, isPreSliceSceneSaveInProgress, isSaveToastAnimatedVisible, isSaveToastVisible, isSceneSaveInProgress]);

  React.useEffect(() => {
    return () => {
      if (saveToastHideTimeoutRef.current !== null) {
        window.clearTimeout(saveToastHideTimeoutRef.current);
        saveToastHideTimeoutRef.current = null;
      }
      if (saveToastClearTimeoutRef.current !== null) {
        window.clearTimeout(saveToastClearTimeoutRef.current);
        saveToastClearTimeoutRef.current = null;
      }
      if (saveToastEnterRafRef.current !== null) {
        window.cancelAnimationFrame(saveToastEnterRafRef.current);
        saveToastEnterRafRef.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (!sceneImportReport) {
      setIsSceneImportToastVisible(false);
      if (sceneImportToastFadeTimeoutRef.current !== null) {
        window.clearTimeout(sceneImportToastFadeTimeoutRef.current);
        sceneImportToastFadeTimeoutRef.current = null;
      }
      return;
    }

    setIsSceneImportToastVisible(true);

    if (sceneImportToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(sceneImportToastFadeTimeoutRef.current);
    }

    const sceneImportToastDurationMs = sceneImportReport.durationMs ?? 4200;
    const sceneImportToastFadeMs = Math.max(0, sceneImportToastDurationMs - 400);

    sceneImportToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsSceneImportToastVisible(false);
      sceneImportToastFadeTimeoutRef.current = null;
    }, sceneImportToastFadeMs);

    return () => {
      if (sceneImportToastFadeTimeoutRef.current !== null) {
        window.clearTimeout(sceneImportToastFadeTimeoutRef.current);
        sceneImportToastFadeTimeoutRef.current = null;
      }
    };
  }, [sceneImportReport]);

  const handleExportSuccess = React.useCallback((savedPath: string) => {
    setExportSuccessToast({ id: Date.now(), path: savedPath });
    setIsExportSuccessToastVisible(true);
    if (exportSuccessToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(exportSuccessToastFadeTimeoutRef.current);
    }
    exportSuccessToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsExportSuccessToastVisible(false);
      exportSuccessToastFadeTimeoutRef.current = null;
    }, 3800);
  }, []);

  const showOperationError = React.useCallback((message: string) => {
    setExportErrorToast({ id: Date.now(), text: message });
    setIsExportErrorToastVisible(true);
    if (exportErrorToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(exportErrorToastFadeTimeoutRef.current);
    }
    exportErrorToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsExportErrorToastVisible(false);
      exportErrorToastFadeTimeoutRef.current = null;
    }, 4500);
  }, []);

  const showOrientationToast = React.useCallback((report: Omit<OrientationToastReport, 'id'>) => {
    setOrientationToast({ ...report, id: Date.now() });
    setIsOrientationToastVisible(true);
    if (orientationToastFadeTimeoutRef.current !== null) {
      window.clearTimeout(orientationToastFadeTimeoutRef.current);
    }
    orientationToastFadeTimeoutRef.current = window.setTimeout(() => {
      setIsOrientationToastVisible(false);
      orientationToastFadeTimeoutRef.current = null;
    }, 6000);
  }, []);

  return {
    historyActionToast,
    setHistoryActionToast,
    isHistoryActionToastVisible,
    setIsHistoryActionToastVisible,
    isSceneImportToastVisible,
    setIsSceneImportToastVisible,
    exportSuccessToast,
    setExportSuccessToast,
    isExportSuccessToastVisible,
    setIsExportSuccessToastVisible,
    exportErrorToast,
    setExportErrorToast,
    isExportErrorToastVisible,
    setIsExportErrorToastVisible,
    isSaveToastVisible,
    setIsSaveToastVisible,
    isSaveToastAnimatedVisible,
    setIsSaveToastAnimatedVisible,
    saveToastMode,
    setSaveToastMode,
    historyActionToastFadeTimeoutRef,
    historyActionToastClearTimeoutRef,
    printingMonitorErrorToastFadeTimeoutRef,
    printingMonitorErrorToastClearTimeoutRef,
    sceneImportToastFadeTimeoutRef,
    exportSuccessToastFadeTimeoutRef,
    exportErrorToastFadeTimeoutRef,
    orientationToastFadeTimeoutRef,
    saveToastHideTimeoutRef,
    saveToastClearTimeoutRef,
    saveToastEnterRafRef,
    saveToastShownAtRef,
    printingMonitorErrorToast,
    setPrintingMonitorErrorToast,
    isPrintingMonitorErrorToastVisible,
    setIsPrintingMonitorErrorToastVisible,
    lastPrintingMonitorErrorToastRef,
    clearPrintingMonitorErrorToastTimeouts,
    normalizePrintingMonitorErrorMessage,
    setPrintingMonitorError,
    handleExportSuccess,
    showOperationError,
    orientationToast,
    isOrientationToastVisible,
    showOrientationToast,
  };
}
