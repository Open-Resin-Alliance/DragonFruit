import { AlertTriangle, CheckCircle2, RefreshCw, Redo2, Undo2 } from 'lucide-react';
import { Toast, ToastViewport } from '@/components/atoms';
import type { SceneImportReport } from '@/features/scene/useSceneCollectionManager';

type IdText = { id: number; text: string };

export type NotificationStackProps = {
  isSaveToastVisible: boolean;
  isSaveToastAnimatedVisible: boolean;
  saveToastLabel: 'Saving…' | 'Autosaving…';

  historyActionToast: { id: number; text: string; direction: 'undo' | 'redo' } | null;
  isHistoryActionToastVisible: boolean;

  printingMonitorErrorToast: IdText | null;
  isPrintingMonitorErrorToastVisible: boolean;

  sceneImportReport: SceneImportReport | null;
  isSceneImportToastVisible: boolean;
  onOpenMeshRepairReport: () => void;

  exportSuccessToast: { id: number; path: string } | null;
  isExportSuccessToastVisible: boolean;

  exportErrorToast: IdText | null;
  isExportErrorToastVisible: boolean;
};

/** Bottom-corner toast/notification stack for the editor shell. */
export function NotificationStack({
  isSaveToastVisible,
  isSaveToastAnimatedVisible,
  saveToastLabel,
  historyActionToast,
  isHistoryActionToastVisible,
  printingMonitorErrorToast,
  isPrintingMonitorErrorToastVisible,
  sceneImportReport,
  isSceneImportToastVisible,
  onOpenMeshRepairReport,
  exportSuccessToast,
  isExportSuccessToastVisible,
  exportErrorToast,
  isExportErrorToastVisible,
}: NotificationStackProps) {
  return (
    <>
      {isSaveToastVisible && (
        <ToastViewport zIndex={126} offset="1.25rem">
          <Toast tone="info" animated visible={isSaveToastAnimatedVisible} className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 animate-spin" />
            {saveToastLabel}
          </Toast>
        </ToastViewport>
      )}

      {historyActionToast && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast
            tone={historyActionToast.direction === 'undo' ? 'warning' : 'info'}
            animated
            visible={isHistoryActionToastVisible}
            className="flex items-center gap-2"
          >
            {historyActionToast.direction === 'undo' ? (
              <Undo2 className="h-4 w-4 motion-safe:animate-pulse" />
            ) : (
              <Redo2 className="h-4 w-4 motion-safe:animate-pulse" />
            )}
            {historyActionToast.text}
          </Toast>
        </ToastViewport>
      )}

      {printingMonitorErrorToast && (
        <ToastViewport
          zIndex={126}
          offset={(historyActionToast || sceneImportReport) ? '4.5rem' : '1.25rem'}
        >
          <Toast
            tone="error"
            animated
            visible={isPrintingMonitorErrorToastVisible}
            className="flex items-center gap-2"
          >
            <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            {printingMonitorErrorToast.text}
          </Toast>
        </ToastViewport>
      )}

      {sceneImportReport && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast
            tone={
              sceneImportReport.tone === 'error'
                ? 'error'
                : sceneImportReport.tone === 'warning'
                  ? 'warning'
                  : 'success'
            }
            animated
            visible={isSceneImportToastVisible}
            className={`flex items-center gap-2 ${
              sceneImportReport.clickAction === 'openMeshRepairReport'
                ? 'pointer-events-auto cursor-pointer select-none'
                : ''
            }`}
            role={sceneImportReport.clickAction === 'openMeshRepairReport' ? 'button' : undefined}
            tabIndex={sceneImportReport.clickAction === 'openMeshRepairReport' ? 0 : undefined}
            onClick={() => {
              if (sceneImportReport?.clickAction === 'openMeshRepairReport') {
                onOpenMeshRepairReport();
              }
            }}
            onKeyDown={(event) => {
              if (sceneImportReport?.clickAction !== 'openMeshRepairReport') {
                return;
              }
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onOpenMeshRepairReport();
              }
            }}
          >
            {sceneImportReport.tone === 'error' ? (
              <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            ) : sceneImportReport.tone === 'warning' ? (
              <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {sceneImportReport.text}
          </Toast>
        </ToastViewport>
      )}

      {exportSuccessToast && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast tone="success" animated visible={isExportSuccessToastVisible} className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4" />
            Saved to: {exportSuccessToast.path}
          </Toast>
        </ToastViewport>
      )}

      {exportErrorToast && (
        <ToastViewport zIndex={125} offset="1.25rem">
          <Toast tone="error" animated visible={isExportErrorToastVisible} className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 motion-safe:animate-pulse" />
            {exportErrorToast.text}
          </Toast>
        </ToastViewport>
      )}
    </>
  );
}
