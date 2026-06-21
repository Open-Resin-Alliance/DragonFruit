import React from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, LayoutGrid, Maximize2, Minimize2, Play, Printer, RefreshCw, Trash2, X } from 'lucide-react';
import { IconButton } from '@/components/ui/primitives';
import { SliceCompletedModal } from '@/components/modals/SliceCompletedModal';
import { UvToolsLaunchingModal } from '@/components/modals/UvToolsLaunchingModal';
import { PrintingResliceModal } from '@/components/modals/PrintingResliceModal';
import { RtspRelayCanvasPlayer } from '@/components/monitoring/RtspRelayCanvasPlayer';
import { launchExternalProcess } from '@/features/slicing/tauri/nativeSlicerBridge';
import { getSavedUvToolsSettings, resolveUvToolsExecutablePath } from '@/components/settings/uvToolsPreferences';
import { useSceneCollectionManager } from '@/features/scene/useSceneCollectionManager';
import {
  formatPrintingMonitorEstimatedTime,
  formatPrintingMonitorUsedMaterial,
  formatPrintingMonitorAreaMm2,
  normalizePrintingMonitorWebcamAspectRatio,
} from '@/features/printing/printingMonitorFormat';
import type {
  FleetUploadMaterialOption,
  PrintingMonitorDebugChannel,
  PrintingMonitorFeatureToggleResponse,
  PrintingMonitorPendingConfirmation,
  PrintingMonitorRecentPlate,
} from '@/features/printing/printingMonitorTypes';
import { openProfileSettingsModal } from '@/components/settings/profileModalEvents';
import {
  selectPrinterNetworkDevice,
  upsertPrinterNetworkDevice,
  type PrinterNetworkDevice,
  type PrinterProfile,
} from '@/features/profiles/profileStore';
import type { PrinterReachabilityMap } from '@/features/network/printerReachabilityStore';
import type {
  PluginMonitoringSnapshotContract,
  PluginMonitoringUiAdapterContract,
} from '@/features/plugins/complexPluginContracts';
import type { ProfileNetworkUiAdapter } from '@/features/plugins/pluginRegistry';
import type { SupportMode } from '@/supports/types';
import type { SliceExportArtifact, SliceExportResult } from '@/features/slicing/sliceExportOrchestrator';

export type PrintingModalsProps = {
  DEFAULT_RELAY_AUTORETRY_DELAY_MS: number;
  DEFAULT_RELAY_AUTORETRY_LIMIT: number;
  activeNetworkUiAdapter: ProfileNetworkUiAdapter | null;
  activePrinterProfile: PrinterProfile | null;
  canPrintNow: boolean;
  canSendToPrinter: boolean;
  cancelPrintingMonitorWebcamReadinessCheck: () => void;
  dashboardMonitorDevices: PrinterNetworkDevice[];
  executeDeleteMonitorRecentPlate: (plateId: number) => Promise<void>;
  executePrintingMonitorControlAction: (action: "pause" | "resume" | "cancel" | "emergency-stop") => Promise<void>;
  executePrintingMonitorFeatureToggle: (feature: "webcam" | "timelapse", enabled: boolean) => Promise<void>;
  executePrintingMonitorSdcpDebugCommand: (options: { operation: string; label: string; channel: PrintingMonitorDebugChannel; payload?: Record<string, unknown>; }) => Promise<void>;
  executeStartMonitorRecentPlate: (plateId: number) => Promise<void>;
  handleCopyPrintingMonitorDebugBundle: () => Promise<void>;
  handleDeleteMonitorRecentPlate: (plateId: number) => void;
  handlePrintNow: () => Promise<void>;
  handlePrintingMonitorControlAction: (action: "pause" | "resume" | "cancel" | "emergency-stop") => void;
  handlePrintingMonitorStoragePathChange: (nextPath: "/local/" | "/usb/") => void;
  handleResetPrintingMonitorWebcamStreamSlot: () => Promise<void>;
  handleSavePrintingMonitorWebcamSnapshot: () => Promise<void>;
  handleSendToPrinter: () => Promise<void>;
  handleStartMonitorRecentPlate: (plateId: number) => void;
  hasPrintingMonitorFleet: boolean;
  isPreSliceTargetPicker: boolean;
  isPrintingMonitorDebugOpen: boolean;
  isPrintingMonitorPolling: boolean;
  isPrintingMonitorPrinterMenuOpen: boolean;
  isPrintingMonitorRecentPlatesLoading: boolean;
  isPrintingMonitorRtspDebugOpen: boolean;
  isPrintingMonitorSelectedPrinterOffline: boolean;
  isPrintingMonitorStatusRequestInFlight: boolean;
  isPrintingMonitorThumbnailLoaded: boolean;
  isPrintingMonitorWebcamLoaded: boolean;
  isPrintingMonitorWebcamResetBusy: boolean;
  isPrintingMonitorWebcamSnapshotSaving: boolean;
  isPrintingMonitorWithinSlowResponseGrace: boolean;
  isPrintingTargetMaterialsLoading: boolean;
  modeBeforePrintingRef: React.RefObject<SupportMode>;
  monitorSelectableDevices: PrinterNetworkDevice[];
  monitorWebcamDisplayAspectRatio: number | null;
  monitorWebcamTransform: string | undefined;
  monitoringDevice: PrinterNetworkDevice | null;
  openPrintingMonitorForTargetDevice: (deviceId: string | null) => void;
  performSendToPrinter: (targetDevice: PrinterNetworkDevice, selectedMaterialIdOverride?: string) => Promise<void>;
  preSlicePrintConfirmOpen: boolean;
  preSlicePrintConfirmResolverRef: React.RefObject<((confirmed: boolean) => void) | null>;
  preSliceTargetPickerResolverRef: React.RefObject<((selection: { deviceId: string; materialId?: string; } | null) => void) | null>;
  printableConnectedPrinterFleet: PrinterNetworkDevice[];
  printerReachabilityByDeviceId: PrinterReachabilityMap;
  printingArtifact: SliceExportArtifact | null;
  printingDialogIsIndeterminate: boolean;
  printingDialogProgressPercent: number;
  printingDialogStageLabel: string;
  printingMonitorActionBusy: "start" | "pause" | "resume" | "cancel" | "emergency-stop" | "delete" | "webcam-enable" | "webcam-disable" | "timelapse-enable" | "timelapse-disable" | null;
  printingMonitorActionStatus: string | null;
  printingMonitorAnyActionBusy: boolean;
  printingMonitorCanExpandWebcam: boolean;
  printingMonitorCancelButtonAnimating: boolean;
  printingMonitorCancelButtonDisabled: boolean;
  printingMonitorControlPendingAction: "pause" | "resume" | "cancel" | "emergency-stop" | null;
  printingMonitorDashboardSnapshots: Record<string, PluginMonitoringSnapshotContract | null>;
  printingMonitorDebugBundle: { selectedDevice: { id: string; displayName: string; hostName: string; ipAddress: string; port: number; connectedFlag: boolean; reachability: boolean | null; } | null; offlineGate: { isPrintingMonitorSelectedPrinterOffline: boolean; snapshotConnected: boolean | null; snapshotStateText: string | null; }; channels: { status: { requestedAt: string | null; httpStatus: number | null; request: Record<string, unknown> | null; error: string | null; rawPayload: unknown; parsedPayload: unknown; }; webcam: { requestedAt: string | null; httpStatus: number | null; request: Record<string, unknown> | null; error: string | null; rawPayload: unknown; parsedPayload: unknown; }; plates: { requestedAt: string | null; httpStatus: number | null; request: Record<string, unknown> | null; error: string | null; rawPayload: unknown; parsedPayload: unknown; }; taskHistory: { requestedAt: string | null; httpStatus: number | null; request: Record<string, unknown> | null; error: string | null; rawPayload: unknown; parsedPayload: unknown; }; taskDetails: { requestedAt: string | null; httpStatus: number | null; request: Record<string, unknown> | null; error: string | null; rawPayload: unknown; parsedPayload: unknown; }; }; };
  printingMonitorDebugCopyState: "idle" | "copied" | "failed";
  printingMonitorDebugPanels: { channel: PrintingMonitorDebugChannel; statusText: string; requestedAt: string | null; json: string; hasError: boolean; }[];
  printingMonitorDetailWebcamExpanded: boolean;
  printingMonitorDisplayCurrentLayer: number | null;
  printingMonitorDisplayMaterialProfile: string;
  printingMonitorDisplayProgressPct: number | null;
  printingMonitorDisplayTotalLayers: number | null;
  printingMonitorEmergencyStopDisabled: boolean;
  printingMonitorHasActivePrint: boolean;
  printingMonitorHasCamera: boolean;
  printingMonitorHeaderBottomLabel: string;
  printingMonitorHeaderTitle: string;
  printingMonitorHeaderTopLabel: string;
  printingMonitorHeaderUsesFleetLabelOrder: boolean;
  printingMonitorInlineWebcamUrl: string | undefined;
  printingMonitorIsPauseTransition: boolean;
  printingMonitorLastFeatureToggleResponse: PrintingMonitorFeatureToggleResponse | null;
  printingMonitorLeftColumnRef: React.RefObject<HTMLElement | null>;
  printingMonitorModalOpen: boolean;
  printingMonitorModalWidthClass: string;
  printingMonitorPauseButtonAnimating: boolean;
  printingMonitorPauseButtonDisabled: boolean;
  printingMonitorPendingConfirmation: PrintingMonitorPendingConfirmation | null;
  printingMonitorPlatesStoragePath: "/local/" | "/usb/";
  printingMonitorPrinterMenuRef: React.RefObject<HTMLDivElement | null>;
  printingMonitorPrinterThumbnailSrc: string | null;
  printingMonitorRecentPlates: PrintingMonitorRecentPlate[];
  printingMonitorRecentPlatesError: string | null;
  printingMonitorRelayAutoRetryCountRef: React.RefObject<number>;
  printingMonitorRelayAutoRetryTimeoutRef: React.RefObject<number | null>;
  printingMonitorRelayBaseWsUrl: string | null;
  printingMonitorRelayDebugTransport: { clientPort: number | null; serverPort: number | null; transportHeader: string | null; updatedAtEpochMs: number | null; } | null;
  printingMonitorRelayReclaimDebug: { activeSessionId: string | null; clientRtpPort: number | null; serverRtpPort: number | null; lastClaimStatus: string | null; lastClaimAtMs: number | null; updatedAtMs: number | null; } | null;
  printingMonitorRtspDebugSummary: { title: string; description: string; };
  printingMonitorRtspSourceUrl: string | null;
  printingMonitorSlowResponseGraceRemainingSec: number;
  printingMonitorSnapshot: PluginMonitoringSnapshotContract | null;
  printingMonitorThumbnailDisplayUrl: string | null;
  printingMonitorThumbnailUrl: string | null;
  printingMonitorUsesTwoColumnDetailLayout: boolean;
  printingMonitorViewMode: "detail" | "dashboard";
  printingMonitorWebcamCanResetStreamSlot: boolean;
  printingMonitorWebcamDisplayPresentation: { tone: "warning"; title: string; description: string; } | { tone: "error"; title: string; description: string; } | { tone: "neutral"; title: string; description: string; };
  printingMonitorWebcamLoadError: string | null;
  printingMonitorWebcamSectionRef: React.RefObject<HTMLElement | null>;
  printingMonitorWebcamStatusPresentation: { tone: "warning"; title: string; description: string; } | { tone: "error"; title: string; description: string; } | { tone: "neutral"; title: string; description: string; };
  printingMonitorWebcamUrl: string | null;
  printingMonitorWebcamUsesRelayWs: boolean;
  printingMonitorWebcamViewportRef: React.RefObject<HTMLDivElement | null>;
  printingMonitoringAdapter: PluginMonitoringUiAdapterContract;
  printingPrintNowBusy: boolean;
  printingProcessingElapsedLabel: string;
  printingReadyPlateId: number | null;
  printingSendBusy: boolean;
  printingSendStatusText: string | null;
  printingTargetDevice: PrinterNetworkDevice | null;
  printingTargetDeviceId: string | null;
  printingTargetMaterialError: string | null;
  printingTargetMaterialGroups: { label: string; materials: FleetUploadMaterialOption[]; }[];
  printingTargetMaterialId: string;
  printingTargetMaterialOptions: FleetUploadMaterialOption[];
  printingTargetPickerOpen: boolean;
  printingUploadDialogOpen: boolean;
  printingUploadDialogStage: "uploading" | "processing" | "started" | "ready" | "failed" | "starting";
  printingUploadTelemetry: { speed: string; remaining: string; transferred: string; } | null;
  refreshPrintingMonitorRecentPlates: () => Promise<void>;
  requiresRemoteMaterialSelectionForUpload: boolean;
  scene: ReturnType<typeof useSceneCollectionManager>;
  schedulePrintingMonitorMjpegReadinessCheck: (target: HTMLImageElement) => void;
  setIsPrintingMonitorDebugOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsPrintingMonitorPrinterMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsPrintingMonitorPrinterThumbnailFailed: React.Dispatch<React.SetStateAction<boolean>>;
  setIsPrintingMonitorRtspDebugOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsPrintingMonitorWebcamLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setPreSlicePrintConfirmOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPrintingMonitorDeviceId: React.Dispatch<React.SetStateAction<string | null>>;
  setPrintingMonitorModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPrintingMonitorPendingConfirmation: React.Dispatch<React.SetStateAction<PrintingMonitorPendingConfirmation | null>>;
  setPrintingMonitorViewMode: React.Dispatch<React.SetStateAction<"detail" | "dashboard">>;
  setPrintingMonitorWebcamAspectRatio: React.Dispatch<React.SetStateAction<number | null>>;
  setPrintingMonitorWebcamExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  setPrintingMonitorWebcamLoadError: React.Dispatch<React.SetStateAction<string | null>>;
  setPrintingTargetDeviceId: React.Dispatch<React.SetStateAction<string | null>>;
  setPrintingTargetMaterialId: React.Dispatch<React.SetStateAction<string>>;
  setPrintingTargetPickerMode: React.Dispatch<React.SetStateAction<"post-slice" | "pre-slice-upload" | "pre-slice-print">>;
  setPrintingTargetPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPrintingUploadDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShouldAutoSliceOnExportEntry: React.Dispatch<React.SetStateAction<boolean>>;
  setShowPrintingResliceModal: React.Dispatch<React.SetStateAction<boolean>>;
  setShowSliceCompletedModal: React.Dispatch<React.SetStateAction<boolean>>;
  setUvToolsLaunchingPath: React.Dispatch<React.SetStateAction<string | null>>;
  shouldReturnToPrintingAfterSliceRef: React.RefObject<boolean>;
  shouldShowPrintingMonitorSlowResponseCard: boolean;
  showPrintingResliceModal: boolean;
  showSliceCompletedModal: boolean;
  sliceCompletedModalData: { filePath: string | null; slicingTimeMs: number | null; };
  slicedLayerHeightMm: number;
  triggerPrintingMonitorWebcamRetry: () => void;
  uvToolsLaunchingPath: string | null;
};

/** Editor modal organism: SliceCompletedModal, UvToolsLaunchingModal, printingMonitorPendingConfirmation, PrintingResliceModal, preSlicePrintConfirm, printingTargetPicker, printingUploadDialog, printingMonitorModal, printingMonitorRtspDebug. */
export function PrintingModals({
  DEFAULT_RELAY_AUTORETRY_DELAY_MS,
  DEFAULT_RELAY_AUTORETRY_LIMIT,
  activeNetworkUiAdapter,
  activePrinterProfile,
  canPrintNow,
  canSendToPrinter,
  cancelPrintingMonitorWebcamReadinessCheck,
  dashboardMonitorDevices,
  executeDeleteMonitorRecentPlate,
  executePrintingMonitorControlAction,
  executePrintingMonitorFeatureToggle,
  executePrintingMonitorSdcpDebugCommand,
  executeStartMonitorRecentPlate,
  handleCopyPrintingMonitorDebugBundle,
  handleDeleteMonitorRecentPlate,
  handlePrintNow,
  handlePrintingMonitorControlAction,
  handlePrintingMonitorStoragePathChange,
  handleResetPrintingMonitorWebcamStreamSlot,
  handleSavePrintingMonitorWebcamSnapshot,
  handleSendToPrinter,
  handleStartMonitorRecentPlate,
  hasPrintingMonitorFleet,
  isPreSliceTargetPicker,
  isPrintingMonitorDebugOpen,
  isPrintingMonitorPolling,
  isPrintingMonitorPrinterMenuOpen,
  isPrintingMonitorRecentPlatesLoading,
  isPrintingMonitorRtspDebugOpen,
  isPrintingMonitorSelectedPrinterOffline,
  isPrintingMonitorStatusRequestInFlight,
  isPrintingMonitorThumbnailLoaded,
  isPrintingMonitorWebcamLoaded,
  isPrintingMonitorWebcamResetBusy,
  isPrintingMonitorWebcamSnapshotSaving,
  isPrintingMonitorWithinSlowResponseGrace,
  isPrintingTargetMaterialsLoading,
  modeBeforePrintingRef,
  monitorSelectableDevices,
  monitorWebcamDisplayAspectRatio,
  monitorWebcamTransform,
  monitoringDevice,
  openPrintingMonitorForTargetDevice,
  performSendToPrinter,
  preSlicePrintConfirmOpen,
  preSlicePrintConfirmResolverRef,
  preSliceTargetPickerResolverRef,
  printableConnectedPrinterFleet,
  printerReachabilityByDeviceId,
  printingArtifact,
  printingDialogIsIndeterminate,
  printingDialogProgressPercent,
  printingDialogStageLabel,
  printingMonitorActionBusy,
  printingMonitorActionStatus,
  printingMonitorAnyActionBusy,
  printingMonitorCanExpandWebcam,
  printingMonitorCancelButtonAnimating,
  printingMonitorCancelButtonDisabled,
  printingMonitorControlPendingAction,
  printingMonitorDashboardSnapshots,
  printingMonitorDebugBundle,
  printingMonitorDebugCopyState,
  printingMonitorDebugPanels,
  printingMonitorDetailWebcamExpanded,
  printingMonitorDisplayCurrentLayer,
  printingMonitorDisplayMaterialProfile,
  printingMonitorDisplayProgressPct,
  printingMonitorDisplayTotalLayers,
  printingMonitorEmergencyStopDisabled,
  printingMonitorHasActivePrint,
  printingMonitorHasCamera,
  printingMonitorHeaderBottomLabel,
  printingMonitorHeaderTitle,
  printingMonitorHeaderTopLabel,
  printingMonitorHeaderUsesFleetLabelOrder,
  printingMonitorInlineWebcamUrl,
  printingMonitorIsPauseTransition,
  printingMonitorLastFeatureToggleResponse,
  printingMonitorLeftColumnRef,
  printingMonitorModalOpen,
  printingMonitorModalWidthClass,
  printingMonitorPauseButtonAnimating,
  printingMonitorPauseButtonDisabled,
  printingMonitorPendingConfirmation,
  printingMonitorPlatesStoragePath,
  printingMonitorPrinterMenuRef,
  printingMonitorPrinterThumbnailSrc,
  printingMonitorRecentPlates,
  printingMonitorRecentPlatesError,
  printingMonitorRelayAutoRetryCountRef,
  printingMonitorRelayAutoRetryTimeoutRef,
  printingMonitorRelayBaseWsUrl,
  printingMonitorRelayDebugTransport,
  printingMonitorRelayReclaimDebug,
  printingMonitorRtspDebugSummary,
  printingMonitorRtspSourceUrl,
  printingMonitorSlowResponseGraceRemainingSec,
  printingMonitorSnapshot,
  printingMonitorThumbnailDisplayUrl,
  printingMonitorThumbnailUrl,
  printingMonitorUsesTwoColumnDetailLayout,
  printingMonitorViewMode,
  printingMonitorWebcamCanResetStreamSlot,
  printingMonitorWebcamDisplayPresentation,
  printingMonitorWebcamLoadError,
  printingMonitorWebcamSectionRef,
  printingMonitorWebcamStatusPresentation,
  printingMonitorWebcamUrl,
  printingMonitorWebcamUsesRelayWs,
  printingMonitorWebcamViewportRef,
  printingMonitoringAdapter,
  printingPrintNowBusy,
  printingProcessingElapsedLabel,
  printingReadyPlateId,
  printingSendBusy,
  printingSendStatusText,
  printingTargetDevice,
  printingTargetDeviceId,
  printingTargetMaterialError,
  printingTargetMaterialGroups,
  printingTargetMaterialId,
  printingTargetMaterialOptions,
  printingTargetPickerOpen,
  printingUploadDialogOpen,
  printingUploadDialogStage,
  printingUploadTelemetry,
  refreshPrintingMonitorRecentPlates,
  requiresRemoteMaterialSelectionForUpload,
  scene,
  schedulePrintingMonitorMjpegReadinessCheck,
  setIsPrintingMonitorDebugOpen,
  setIsPrintingMonitorPrinterMenuOpen,
  setIsPrintingMonitorPrinterThumbnailFailed,
  setIsPrintingMonitorRtspDebugOpen,
  setIsPrintingMonitorWebcamLoaded,
  setPreSlicePrintConfirmOpen,
  setPrintingMonitorDeviceId,
  setPrintingMonitorModalOpen,
  setPrintingMonitorPendingConfirmation,
  setPrintingMonitorViewMode,
  setPrintingMonitorWebcamAspectRatio,
  setPrintingMonitorWebcamExpanded,
  setPrintingMonitorWebcamLoadError,
  setPrintingTargetDeviceId,
  setPrintingTargetMaterialId,
  setPrintingTargetPickerMode,
  setPrintingTargetPickerOpen,
  setPrintingUploadDialogOpen,
  setShouldAutoSliceOnExportEntry,
  setShowPrintingResliceModal,
  setShowSliceCompletedModal,
  setUvToolsLaunchingPath,
  shouldReturnToPrintingAfterSliceRef,
  shouldShowPrintingMonitorSlowResponseCard,
  showPrintingResliceModal,
  showSliceCompletedModal,
  sliceCompletedModalData,
  slicedLayerHeightMm,
  triggerPrintingMonitorWebcamRetry,
  uvToolsLaunchingPath,
}: PrintingModalsProps) {
  return (
    <>
      <SliceCompletedModal
        isOpen={showSliceCompletedModal}
        onClose={() => setShowSliceCompletedModal(false)}
        filePath={sliceCompletedModalData.filePath}
        slicingTimeMs={sliceCompletedModalData.slicingTimeMs}
        onOpenInUvTools={getSavedUvToolsSettings().enabled ? (fp) => {
          const s = getSavedUvToolsSettings();
          launchExternalProcess(resolveUvToolsExecutablePath(s), fp).catch((err) =>
            console.warn('[UVTools] Failed to launch from completed dialog:', err),
          );
        } : undefined}
      />

      <UvToolsLaunchingModal
        isOpen={uvToolsLaunchingPath !== null}
        filePath={uvToolsLaunchingPath}
        onLaunchComplete={() => setUvToolsLaunchingPath(null)}
      />

      {printingMonitorPendingConfirmation && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPrintingMonitorPendingConfirmation(null);
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label={
              printingMonitorPendingConfirmation.kind === 'control'
                ? (printingMonitorPendingConfirmation.action === 'cancel' ? 'Confirm cancel print' : 'Confirm emergency stop')
                : (printingMonitorPendingConfirmation.action === 'start' ? 'Confirm start recent file' : 'Confirm delete recent file')
            }
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2.5">
                <span
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: '#d97706',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <div>
                  <h2 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {printingMonitorPendingConfirmation.kind === 'control'
                      ? (printingMonitorPendingConfirmation.action === 'cancel' ? 'Cancel Print Job' : 'Emergency Stop')
                      : (printingMonitorPendingConfirmation.action === 'start' ? 'Start Recent Print File' : 'Delete Recent Print File')}
                  </h2>
                  <p className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {printingMonitorPendingConfirmation.kind === 'control'
                      ? (
                        printingMonitorPendingConfirmation.action === 'cancel'
                          ? 'This action cannot be undone.'
                          : 'This will immediately halt the printer.'
                      )
                      : (
                        printingMonitorPendingConfirmation.action === 'start'
                          ? 'Start this recent file on the selected printer now?'
                          : 'This will remove the file from the printer.'
                      )}
                  </p>
                </div>
              </div>

              <button
                type="button"
                className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close monitor confirmation modal"
                onClick={() => setPrintingMonitorPendingConfirmation(null)}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {printingMonitorPendingConfirmation.kind === 'plate' && (
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>File</div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={`#${printingMonitorPendingConfirmation.plateId} • ${printingMonitorPendingConfirmation.plateName}`}>
                    {`#${printingMonitorPendingConfirmation.plateId} • ${printingMonitorPendingConfirmation.plateName}`}
                  </div>
                </div>
              )}

              <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Printer</div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {monitoringDevice?.displayName || monitoringDevice?.hostName || monitoringDevice?.ipAddress || 'Selected printer'}
                </div>
              </div>

              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {printingMonitorPendingConfirmation.kind === 'control'
                  ? (
                    printingMonitorPendingConfirmation.action === 'cancel'
                      ? 'Canceling will stop the current print job and clear queued progress for this plate.'
                      : 'Emergency Stop is for immediate intervention and should be used only when necessary.'
                  )
                  : (
                    printingMonitorPendingConfirmation.action === 'start'
                      ? 'The selected plate will begin printing immediately on this machine.'
                      : 'Deleted files cannot be restored from this monitor.'
                  )}
              </p>

              <div className="grid grid-cols-2 gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs"
                  onClick={() => setPrintingMonitorPendingConfirmation(null)}
                >
                  {printingMonitorPendingConfirmation.kind === 'plate' ? 'Keep File' : 'Keep Printing'}
                </button>
                <button
                  type="button"
                  className="ui-button !h-9 w-full px-3 text-xs"
                  style={
                    printingMonitorPendingConfirmation.kind === 'plate'
                      ? (
                        printingMonitorPendingConfirmation.action === 'start'
                          ? {
                              borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)',
                              background: 'color-mix(in srgb, #22c55e, var(--surface-1) 84%)',
                              color: 'color-mix(in srgb, #22c55e, var(--text-strong) 25%)',
                            }
                          : {
                              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                              background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                              color: 'color-mix(in srgb, #ef4444, var(--text-strong) 25%)',
                            }
                      )
                      : (
                        printingMonitorPendingConfirmation.action === 'cancel'
                          ? {
                              borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                              background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                              color: 'color-mix(in srgb, #f59e0b, var(--text-strong) 20%)',
                            }
                          : {
                              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                              background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                              color: 'color-mix(in srgb, #ef4444, var(--text-strong) 25%)',
                            }
                      )
                  }
                  onClick={() => {
                    const pending = printingMonitorPendingConfirmation;
                    if (!pending) return;
                    setPrintingMonitorPendingConfirmation(null);
                    if (pending.kind === 'control') {
                      void executePrintingMonitorControlAction(pending.action);
                      return;
                    }
                    if (pending.action === 'start') {
                      void executeStartMonitorRecentPlate(pending.plateId);
                    } else {
                      void executeDeleteMonitorRecentPlate(pending.plateId);
                    }
                  }}
                >
                  {printingMonitorPendingConfirmation.kind === 'plate'
                    ? (printingMonitorPendingConfirmation.action === 'start' ? 'Confirm Start' : 'Confirm Delete')
                    : (printingMonitorPendingConfirmation.action === 'cancel' ? 'Confirm Cancel' : 'Confirm Emergency Stop')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <PrintingResliceModal
        isOpen={showPrintingResliceModal}
        onCancel={() => {
          setShowPrintingResliceModal(false);
          scene.setMode(modeBeforePrintingRef.current);
        }}
        onResliceNow={() => {
          setShowPrintingResliceModal(false);
          shouldReturnToPrintingAfterSliceRef.current = true;
          setShouldAutoSliceOnExportEntry(true);
          scene.setMode('export');
        }}
      />

      {preSlicePrintConfirmOpen && (
        <div
          className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPreSlicePrintConfirmOpen(false);
              if (preSlicePrintConfirmResolverRef.current) {
                preSlicePrintConfirmResolverRef.current(false);
                preSlicePrintConfirmResolverRef.current = null;
              }
            }
          }}
        >
          <div
            className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Print readiness confirmation"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)',
                    color: '#d97706',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>

                <div className="min-w-0 pr-2">
                  <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Safety Check
                  </div>
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Confirm printer is ready to print
                  </h2>
                </div>
              </div>

              <button
                type="button"
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  color: 'var(--text-muted)',
                }}
                aria-label="Close print readiness confirmation"
                onClick={() => {
                  setPreSlicePrintConfirmOpen(false);
                  if (preSlicePrintConfirmResolverRef.current) {
                    preSlicePrintConfirmResolverRef.current(false);
                    preSlicePrintConfirmResolverRef.current = null;
                  }
                }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <div className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Please verify before continuing:
              </div>
              <div className="rounded-md border p-3 space-y-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)' }} />
                  <span>Build plate and resin vat are properly seated and secured.</span>
                </div>
                <div className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)' }} />
                  <span>Resin is mixed, sufficient for the print, and at operating temperature.</span>
                </div>
                <div className="flex items-start gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)' }} />
                  <span>Build plate is clean and clear, and the printer cover is fully closed.</span>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                  onClick={() => {
                    setPreSlicePrintConfirmOpen(false);
                    if (preSlicePrintConfirmResolverRef.current) {
                      preSlicePrintConfirmResolverRef.current(false);
                      preSlicePrintConfirmResolverRef.current = null;
                    }
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-accent !h-9 px-3 text-xs"
                  onClick={() => {
                    setPreSlicePrintConfirmOpen(false);
                    if (preSlicePrintConfirmResolverRef.current) {
                      preSlicePrintConfirmResolverRef.current(true);
                      preSlicePrintConfirmResolverRef.current = null;
                    }
                  }}
                >
                  Continue to Slicing
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {printingTargetPickerOpen && (
        <div className="absolute inset-0 z-[120] flex items-center justify-center bg-black/55 backdrop-blur-sm px-4">
          <div
            className="w-full max-w-3xl overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Choose printer"
          >
            <div className="border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div>
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  {isPreSliceTargetPicker ? 'Pre-Slice Targeting' : 'Fleet Upload'}
                </div>
                <div className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {isPreSliceTargetPicker ? 'Choose target before slicing' : 'Choose target printer'}
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3.5">
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {requiresRemoteMaterialSelectionForUpload
                  ? (isPreSliceTargetPicker
                    ? 'Pick the target machine and material profile now, then slicing will begin.'
                    : 'Pick the target machine and material profile for this upload.')
                  : (isPreSliceTargetPicker
                    ? 'Pick the target machine now, then slicing will begin.'
                    : 'Pick the target machine for this upload.')}
              </div>
              {requiresRemoteMaterialSelectionForUpload && !isPreSliceTargetPicker && (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Target layer height: <span style={{ color: 'var(--text-strong)' }}>{slicedLayerHeightMm.toFixed(3)} mm</span>
                </div>
              )}

              <div className={`grid gap-3 md:items-start ${requiresRemoteMaterialSelectionForUpload ? 'md:grid-cols-2' : 'md:grid-cols-1'}`}>
                <div className="rounded-md border px-3 py-2.5 min-h-[360px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                    Target printer
                  </div>
                  <div className="max-h-[318px] overflow-y-auto custom-scrollbar pr-1 space-y-2">
                    {printableConnectedPrinterFleet.map((device) => {
                      const isSelected = device.id === (printingTargetDeviceId ?? printingTargetDevice?.id);
                      const isDeviceOffline = printerReachabilityByDeviceId[device.id] === false;
                      return (
                        <button
                          key={device.id}
                          type="button"
                          onClick={() => {
                            if (isDeviceOffline) return;
                            setPrintingTargetDeviceId(device.id);
                            if (activePrinterProfile?.id) {
                              selectPrinterNetworkDevice(activePrinterProfile.id, device.id);
                            }
                          }}
                          disabled={isDeviceOffline}
                          className="relative w-full rounded-lg border px-3 py-2.5 pr-9 text-left"
                          style={isDeviceOffline
                            ? {
                                borderColor: 'color-mix(in srgb, var(--border-subtle), black 18%)',
                                background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                                color: 'var(--text-muted)',
                                opacity: 0.55,
                              }
                            : isSelected
                            ? {
                                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 28%)',
                                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 89%)',
                              }
                            : {
                                borderColor: 'var(--border-subtle)',
                                background: 'color-mix(in srgb, var(--surface-1), black 3%)',
                              }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-[15px] font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                                {device.displayName || device.hostName || device.ipAddress}
                              </div>
                              <div className="text-[12px] leading-tight mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                {device.ipAddress} • {isDeviceOffline ? 'Offline' : 'Online'}
                              </div>
                            </div>
                          </div>
                          {isDeviceOffline ? (
                            <span
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-semibold uppercase tracking-wide"
                              style={{ color: 'var(--text-muted)' }}
                              aria-label="Printer offline"
                            >
                              Offline
                            </span>
                          ) : (isSelected && (
                            <div
                              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full"
                              style={{
                                color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
                                background: 'color-mix(in srgb, #22c55e, transparent 84%)',
                              }}
                              aria-label="Selected printer"
                              title="Selected"
                            >
                              <CheckCircle2 className="h-4 w-4" />
                            </div>
                          ))}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {requiresRemoteMaterialSelectionForUpload && (
                  <div className="rounded-md border px-3 py-2.5 min-h-[360px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="text-[11px] mb-2" style={{ color: 'var(--text-muted)' }}>
                      {isPreSliceTargetPicker ? 'Target material' : 'Target material (matching sliced layer height)'}
                    </div>
                    {isPrintingTargetMaterialsLoading ? (
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading materials from selected printer…</div>
                    ) : printingTargetMaterialOptions.length > 0 ? (
                      <div className="max-h-[318px] overflow-y-auto custom-scrollbar pr-1 space-y-2">
                        {printingTargetMaterialGroups.map((group) => (
                          <div key={group.label} className="space-y-1.5">
                            {group.label && (
                              <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                                {group.label}
                              </div>
                            )}
                            <div className="space-y-1">
                              {group.materials.map((material) => {
                                const isSelectedMaterial = material.id === printingTargetMaterialId;
                                return (
                                  <button
                                    key={material.id}
                                    type="button"
                                    onClick={() => {
                                      setPrintingTargetMaterialId(material.id);
                                      if (activePrinterProfile?.id && printingTargetDevice) {
                                        upsertPrinterNetworkDevice(
                                          activePrinterProfile.id,
                                          {
                                            id: printingTargetDevice.id,
                                            ipAddress: printingTargetDevice.ipAddress,
                                            selectedMaterialId: material.id,
                                            selectedMaterialName: material.name,
                                            selectedMaterialLayerHeightMm: material.layerHeightMm ?? undefined,
                                          },
                                          { select: true },
                                        );
                                      }
                                    }}
                                    className="relative w-full rounded-md border px-2.5 py-2 pr-9 text-left"
                                    style={isSelectedMaterial
                                      ? {
                                          borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 32%)',
                                          background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                                        }
                                      : {
                                          borderColor: 'var(--border-subtle)',
                                          background: 'color-mix(in srgb, var(--surface-1), black 3%)',
                                        }}
                                  >
                                    <div className="flex items-start justify-between gap-2">
                                      <div className="min-w-0 text-[13px] font-medium truncate" style={{ color: 'var(--text-strong)' }} title={material.name}>
                                        {material.name}
                                      </div>
                                    </div>
                                    {material.layerHeightMm != null && (
                                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                                        {material.layerHeightMm.toFixed(3)} mm
                                      </div>
                                    )}
                                    {isSelectedMaterial && (
                                      <div
                                        className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex h-5 w-5 items-center justify-center rounded-full"
                                        style={{
                                          color: 'color-mix(in srgb, #22c55e, var(--text-strong) 18%)',
                                          background: 'color-mix(in srgb, #22c55e, transparent 84%)',
                                        }}
                                        aria-label="Selected material"
                                        title="Selected"
                                      >
                                        <CheckCircle2 className="h-4 w-4" />
                                      </div>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {printingTargetMaterialError ?? 'No matching material profile found on this printer.'}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {requiresRemoteMaterialSelectionForUpload && printingTargetMaterialError && printingTargetMaterialOptions.length > 0 && (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {printingTargetMaterialError}
                </div>
              )}

              {printingTargetDevice && printerReachabilityByDeviceId[printingTargetDevice.id] === false && (
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Selected printer is offline. Choose an online printer to continue.
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                  onClick={() => {
                    setPrintingTargetPickerOpen(false);
                    if (isPreSliceTargetPicker && preSliceTargetPickerResolverRef.current) {
                      preSliceTargetPickerResolverRef.current(null);
                      preSliceTargetPickerResolverRef.current = null;
                    }
                    setPrintingTargetPickerMode('post-slice');
                  }}
                  disabled={printingSendBusy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ui-button ui-button-accent !h-9 px-3 text-xs"
                  disabled={
                    printingSendBusy
                    || isPrintingTargetMaterialsLoading
                    || !printingTargetDevice
                    || (requiresRemoteMaterialSelectionForUpload && !printingTargetMaterialId)
                    || printerReachabilityByDeviceId[printingTargetDevice.id] === false
                  }
                  onClick={() => {
                    if (!printingTargetDevice) return;
                    if (requiresRemoteMaterialSelectionForUpload && !printingTargetMaterialId) return;
                    setPrintingTargetPickerOpen(false);
                    if (isPreSliceTargetPicker && preSliceTargetPickerResolverRef.current) {
                      preSliceTargetPickerResolverRef.current({
                        deviceId: printingTargetDevice.id,
                        materialId: requiresRemoteMaterialSelectionForUpload ? printingTargetMaterialId : undefined,
                      });
                      preSliceTargetPickerResolverRef.current = null;
                      setPrintingTargetPickerMode('post-slice');
                      return;
                    }

                    setPrintingTargetPickerMode('post-slice');
                    void performSendToPrinter(
                      printingTargetDevice,
                      requiresRemoteMaterialSelectionForUpload ? printingTargetMaterialId : undefined,
                    );
                  }}
                >
                  {isPreSliceTargetPicker ? 'Continue to Slicing' : 'Upload to Selected Printer'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {printingUploadDialogOpen && (
        <div className="absolute inset-0 z-[121] flex items-center justify-center bg-black/55 backdrop-blur-sm px-4">
          <div
            className="w-full max-w-xl overflow-hidden rounded-xl border shadow-2xl"
            style={{
              background: 'var(--surface-0)',
              borderColor: 'var(--border-subtle)',
              boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
            }}
            role="dialog"
            aria-modal="true"
            aria-live="polite"
            aria-label="Printer upload status"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                  Post-Processing
                </div>
                <div className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Upload to {activeNetworkUiAdapter?.displayName ?? 'Printer'}
                </div>
                <div className="mt-0.5 text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                  {printingArtifact?.outputName ?? 'Preparing artifact'}
                </div>
              </div>
            </div>

            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Stage</div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {printingDialogStageLabel}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Target Printer</div>
                  <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }} title={printingTargetDevice?.displayName || printingTargetDevice?.hostName || printingTargetDevice?.ipAddress || 'Pending'}>
                    {printingTargetDevice?.displayName || printingTargetDevice?.hostName || printingTargetDevice?.ipAddress || 'Pending'}
                  </div>
                </div>
                <div className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Plate</div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    {printingReadyPlateId ? `#${printingReadyPlateId}` : 'Pending'}
                  </div>
                </div>
              </div>

              <div className="text-xs min-h-[18px]" style={{ color: 'var(--text-muted)' }}>
                {printingSendStatusText ?? 'Preparing upload pipeline…'}
              </div>

              {printingUploadDialogStage === 'started' && (
                <div className="rounded-md border px-3 py-2 text-[11px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
                  Print started. Use <span style={{ color: 'var(--text-strong)', fontWeight: 600 }}>Monitor</span> in the top bar to view live progress and webcam.
                </div>
              )}

              {printingUploadDialogStage === 'uploading' && printingUploadTelemetry && (
                <div className="grid grid-cols-3 gap-2 text-[11px]">
                  <div
                    className="rounded-md border px-2.5 py-2"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                  >
                    <div className="uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Speed</div>
                    <div
                      className="mt-1 text-xs font-semibold"
                      style={{ color: 'var(--text-strong)', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {printingUploadTelemetry.speed}
                    </div>
                  </div>
                  <div
                    className="rounded-md border px-2.5 py-2"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                  >
                    <div className="uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Remaining</div>
                    <div
                      className="mt-1 text-xs font-semibold"
                      style={{ color: 'var(--text-strong)', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {printingUploadTelemetry.remaining}
                    </div>
                  </div>
                  <div
                    className="rounded-md border px-2.5 py-2"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                  >
                    <div className="uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Transferred</div>
                    <div
                      className="mt-1 text-xs font-semibold"
                      style={{ color: 'var(--text-strong)', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {printingUploadTelemetry.transferred}
                    </div>
                  </div>
                </div>
              )}

              {printingDialogIsIndeterminate ? (
                <>
                  <div
                    className="ui-loading-track h-2.5 w-full rounded-full"
                    style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                  >
                    <div
                      className="ui-loading-indicator"
                      style={{ background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))' }}
                    />
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Processing on {activeNetworkUiAdapter?.displayName ?? 'printer backend'}… elapsed {printingProcessingElapsedLabel}
                  </div>
                </>
              ) : (
                <div
                  className="h-2.5 w-full rounded-full border overflow-hidden"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-2), black 20%)',
                  }}
                >
                  <div
                    className="h-full rounded-full transition-[width] duration-200 ease-out"
                    style={{
                      width: `${printingDialogProgressPercent.toFixed(2)}%`,
                      background: printingUploadDialogStage === 'failed'
                        ? 'linear-gradient(90deg, #ef4444, #f97316)'
                        : printingUploadDialogStage === 'started'
                          ? 'linear-gradient(90deg, #60a5fa, #22d3ee)'
                          : 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))',
                    }}
                  />
                </div>
              )}

              <div className="mt-1 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <span>
                  {printingUploadDialogStage === 'processing'
                    ? 'Waiting for metadata readiness'
                    : 'Transfer progress'}
                </span>
                <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>
                  {printingDialogIsIndeterminate ? '—' : `${printingDialogProgressPercent.toFixed(0)}%`}
                </span>
              </div>

              <div className="pt-1 flex items-center justify-end gap-2">
                {(printingUploadDialogStage === 'failed' || printingUploadDialogStage === 'started' || printingUploadDialogStage === 'ready') && (
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                    onClick={() => setPrintingUploadDialogOpen(false)}
                    disabled={printingSendBusy || printingPrintNowBusy}
                  >
                    Close
                  </button>
                )}

                {printingUploadDialogStage === 'failed' && (
                  <button
                    type="button"
                    className="ui-button ui-button-accent !h-9 px-3 text-xs"
                    onClick={() => { void handleSendToPrinter(); }}
                    disabled={printingSendBusy || printingPrintNowBusy || !canSendToPrinter}
                  >
                    Retry Upload
                  </button>
                )}

                {printingUploadDialogStage === 'ready' && (
                  <button
                    type="button"
                    className="ui-button ui-button-accent !h-9 px-3 text-xs"
                    onClick={handlePrintNow}
                    disabled={!canPrintNow || printingPrintNowBusy || printingSendBusy}
                  >
                    {printingPrintNowBusy ? 'Starting print…' : 'Start Print'}
                  </button>
                )}

                {printingUploadDialogStage === 'started' && (
                  <button
                    type="button"
                    className="ui-button ui-button-accent !h-9 px-3 text-xs"
                    onClick={() => openPrintingMonitorForTargetDevice(printingTargetDevice?.id ?? null)}
                    disabled={printingSendBusy || printingPrintNowBusy}
                  >
                    Open Monitor
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {printingMonitorModalOpen && (
        <div className="fixed inset-0 z-[140] flex items-center justify-center p-4" role="presentation">
          <button
            type="button"
            className="absolute inset-0 bg-black/55"
            onClick={() => setPrintingMonitorModalOpen(false)}
            aria-label="Close printer monitor"
          />

          <div
            className={`relative z-[1] ${printingMonitorModalWidthClass} max-h-[88vh] overflow-auto rounded-xl border shadow-2xl`}
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-0), #000 10%)',
            }}
            role="dialog"
            aria-modal="true"
            aria-label="Printer monitor"
          >
            <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
              {printingMonitorViewMode === 'dashboard' ? (
                <div className="inline-flex items-center gap-2 px-1.5 py-1">
                  <div className="inline-flex h-7 w-7 items-center justify-center rounded-sm shrink-0" style={{
                    background: 'color-mix(in srgb, #baf72e, var(--surface-1) 90%)',
                    border: '1px solid color-mix(in srgb, #baf72e, var(--border-subtle) 45%)',
                    color: 'var(--accent-secondary)',
                  }}>
                    <LayoutGrid className="h-3.5 w-3.5" />
                  </div>
                  <span className="min-w-0 flex max-w-[320px] flex-col items-start leading-none gap-[2px]">
                    <span
                      className="truncate text-[10px] tracking-[0.01em]"
                      style={{ color: 'var(--text-muted)' }}
                      title="Monitoring Dashboard"
                    >
                      Monitoring Dashboard
                    </span>
                    <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }} title="Fleet Status Overview">
                      Fleet Status Overview
                    </span>
                  </span>
                </div>
              ) : (
                <div className="relative" ref={printingMonitorPrinterMenuRef}>
                  {monitorSelectableDevices.length > 1 ? (
                    <button
                      type="button"
                      className="group inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold transition-colors"
                      style={{
                        background: 'transparent',
                        color: 'var(--text-strong)',
                      }}
                      onClick={() => setIsPrintingMonitorPrinterMenuOpen((previous) => !previous)}
                      aria-label={printingMonitorHeaderUsesFleetLabelOrder
                        ? `Select monitored printer for profile ${printingMonitorHeaderTopLabel}`
                        : 'Select monitored printer'}
                      title={printingMonitorHeaderTitle}
                    >
                      <div
                        className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-sm shrink-0"
                        style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}
                      >
                        {printingMonitorPrinterThumbnailSrc ? (
                          <img
                            src={printingMonitorPrinterThumbnailSrc}
                            alt={activePrinterProfile?.name ?? 'Selected printer'}
                            className="h-full w-full object-contain"
                            draggable={false}
                            onError={() => setIsPrintingMonitorPrinterThumbnailFailed(true)}
                          />
                        ) : (
                          <Printer className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                        )}
                      </div>
                      <span className="min-w-0 flex max-w-[280px] flex-col items-start leading-none gap-[2px]">
                        <span
                          className={printingMonitorHeaderUsesFleetLabelOrder
                            ? 'truncate text-[10px] tracking-[0.01em]'
                            : 'text-[9px] uppercase tracking-[0.11em]'}
                          style={{ color: 'var(--text-muted)' }}
                          title={printingMonitorHeaderTopLabel}
                        >
                          {printingMonitorHeaderTopLabel}
                        </span>
                        <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }} title={printingMonitorHeaderBottomLabel}>
                          {printingMonitorHeaderBottomLabel}
                        </span>
                      </span>
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isPrintingMonitorPrinterMenuOpen ? 'rotate-180' : ''}`} />
                    </button>
                  ) : (
                    <div className="inline-flex items-center gap-2 px-1.5 py-1">
                      <div
                        className="inline-flex h-7 w-7 items-center justify-center overflow-hidden rounded-sm shrink-0"
                        style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}
                      >
                        {printingMonitorPrinterThumbnailSrc ? (
                          <img
                            src={printingMonitorPrinterThumbnailSrc}
                            alt={activePrinterProfile?.name ?? 'Selected printer'}
                            className="h-full w-full object-contain"
                            draggable={false}
                            onError={() => setIsPrintingMonitorPrinterThumbnailFailed(true)}
                          />
                        ) : (
                          <Printer className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                        )}
                      </div>
                      <span className="min-w-0 flex max-w-[280px] flex-col items-start leading-none gap-[2px]">
                        <span
                          className={printingMonitorHeaderUsesFleetLabelOrder
                            ? 'truncate text-[10px] tracking-[0.01em]'
                            : 'text-[9px] uppercase tracking-[0.11em]'}
                          style={{ color: 'var(--text-muted)' }}
                          title={printingMonitorHeaderTopLabel}
                        >
                          {printingMonitorHeaderTopLabel}
                        </span>
                        <span className="truncate text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }} title={printingMonitorHeaderBottomLabel}>
                          {printingMonitorHeaderBottomLabel}
                        </span>
                      </span>
                    </div>
                  )}

                  {isPrintingMonitorPrinterMenuOpen && monitorSelectableDevices.length > 1 && (
                    <div
                      className="absolute left-0 top-full z-20 mt-2 w-[min(360px,82vw)] rounded-lg border p-1.5 shadow-xl"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        background: 'color-mix(in srgb, var(--surface-0), #000 8%)',
                      }}
                    >
                      <div className="max-h-56 overflow-y-auto custom-scrollbar space-y-1 pr-0.5">
                        {monitorSelectableDevices.map((device) => {
                          const selected = monitoringDevice?.id === device.id;
                          const display = device.displayName || device.hostName || device.ipAddress || `Printer ${device.id}`;
                          const isOffline = printerReachabilityByDeviceId[device.id] === false;
                          return (
                            <button
                              key={device.id}
                              type="button"
                              className="w-full rounded-md border px-2.5 py-2 text-left"
                              style={isOffline
                                ? {
                                    borderColor: 'color-mix(in srgb, var(--border-subtle), black 18%)',
                                    background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                                    opacity: 0.55,
                                  }
                                : selected
                                ? {
                                    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)',
                                    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 90%)',
                                  }
                                : {
                                    borderColor: 'var(--border-subtle)',
                                    background: 'var(--surface-1)',
                                  }}
                              disabled={isOffline}
                              onClick={() => {
                                if (isOffline) return;
                                setPrintingMonitorDeviceId(device.id);
                                setIsPrintingMonitorPrinterMenuOpen(false);
                              }}
                            >
                              <div className="flex items-center gap-2">
                                <div
                                  className="inline-flex h-6 w-6 items-center justify-center overflow-hidden rounded-sm shrink-0"
                                  style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}
                                >
                                  {printingMonitorPrinterThumbnailSrc ? (
                                    <img
                                      src={printingMonitorPrinterThumbnailSrc}
                                      alt={activePrinterProfile?.name ?? display}
                                      className="h-full w-full object-contain"
                                      draggable={false}
                                      onError={() => setIsPrintingMonitorPrinterThumbnailFailed(true)}
                                    />
                                  ) : (
                                    <Printer className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-[12px] font-semibold" style={{ color: 'var(--text-strong)' }} title={display}>
                                    {display}
                                  </div>
                                  <div className="mt-0.5 truncate text-[10px]" style={{ color: 'var(--text-muted)' }} title={device.ipAddress || undefined}>
                                    {device.ipAddress || 'No IP'} • {isOffline ? 'Offline' : 'Online'}
                                  </div>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-1.5">
                {hasPrintingMonitorFleet && (
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-8 px-2.5 text-[11px] inline-flex items-center gap-1"
                    onClick={() => {
                      setIsPrintingMonitorPrinterMenuOpen(false);
                      setPrintingMonitorViewMode((previous) => {
                        const next = previous === 'dashboard' ? 'detail' : 'dashboard';
                        return next;
                      });
                    }}
                    title={printingMonitorViewMode === 'dashboard' ? 'Switch to detailed single-printer view' : 'Switch to dashboard view for all fleet printers'}
                  >
                    <LayoutGrid className="w-3.5 h-3.5" />
                    {printingMonitorViewMode === 'dashboard' ? 'Detail View' : 'Dashboard View'}
                  </button>
                )}
                <button
                  type="button"
                  className="ui-button ui-button-secondary inline-flex items-center justify-center leading-none !h-8 !w-8 !p-0"
                  onClick={() => setPrintingMonitorModalOpen(false)}
                  aria-label="Close printer monitor"
                  title="Close monitor"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {printingMonitorViewMode === 'dashboard' ? (
              <div className="p-5">
                {dashboardMonitorDevices.length > 0 ? (
                  <div
                    className="overflow-y-auto custom-scrollbar pr-1"
                    style={{ height: 'clamp(34rem, 66vh, 42rem)' }}
                  >
                    <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 auto-rows-max content-start">
                    {dashboardMonitorDevices.map((device) => {
                      const display = device.displayName || device.hostName || device.ipAddress || `Printer ${device.id}`;
                      const snapshot = printingMonitorDashboardSnapshots[device.id] ?? null;
                      const isOffline = printerReachabilityByDeviceId[device.id] === false || device.connected !== true;
                      const isPaused = !isOffline && Boolean(snapshot?.isPaused);
                      const isPrinting = !isOffline && Boolean(snapshot?.isPrinting) && !isPaused;
                      const isIdle = !isOffline && !isPrinting && !isPaused;
                      const stateText = isOffline ? 'Offline' : (snapshot?.stateText?.trim() || 'Status unavailable');
                      const hasActivePrint = !isOffline && (isPrinting || isPaused);
                      const currentLayer = Number.isFinite(Number(snapshot?.currentLayer)) ? Math.max(0, Math.round(Number(snapshot?.currentLayer))) : null;
                      const totalLayersRaw = Number.isFinite(Number(snapshot?.totalLayers)) ? Math.round(Number(snapshot?.totalLayers)) : null;
                      const totalLayers = totalLayersRaw != null && totalLayersRaw > 0 ? totalLayersRaw : null;
                      const progressPct = totalLayers != null && currentLayer != null
                        ? Math.max(0, Math.min(100, ((Math.max(0, currentLayer - 1)) / totalLayers) * 100))
                        : null;
                      const displayCurrentLayer = hasActivePrint ? currentLayer : null;
                      const displayTotalLayers = hasActivePrint ? totalLayers : null;
                      const displayProgressPct = hasActivePrint ? progressPct : null;
                      const displayLayerText = hasActivePrint
                        ? (displayTotalLayers != null
                          ? `${displayCurrentLayer ?? '—'}/${displayTotalLayers}`
                          : (displayCurrentLayer != null ? `${displayCurrentLayer}` : '—'))
                        : '-/-';
                      const brandColor = '#baf72e';
                      const idleColor = '#60a5fa';
                      const pausedColor = '#f59e0b';
                      const cardHoverHintText = 'Click to show Detailed View';
                      const progressFill = isPaused
                        ? `linear-gradient(90deg, ${pausedColor}, color-mix(in srgb, ${pausedColor}, #fde68a 35%))`
                        : isPrinting
                          ? `linear-gradient(90deg, ${brandColor}, color-mix(in srgb, ${brandColor}, #52cc80 50%))`
                          : 'color-mix(in srgb, var(--text-muted), transparent 78%)';
                      const progressTextColor = isPaused
                        ? '#fde68a'
                        : isPrinting
                          ? brandColor
                          : 'var(--text-muted)';

                      return (
                        <div
                          key={device.id}
                          className="group w-full rounded-lg border overflow-hidden transition-shape hover:shadow-sm text-left"
                          onClick={() => {
                            if (isOffline) return;
                            setPrintingMonitorDeviceId(device.id);
                            setPrintingMonitorViewMode('detail');
                          }}
                          onKeyDown={(event) => {
                            if (isOffline) return;
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setPrintingMonitorDeviceId(device.id);
                              setPrintingMonitorViewMode('detail');
                            }
                          }}
                          style={{
                            borderColor: 'var(--border-subtle)',
                            background: 'var(--surface-1)',
                            cursor: isOffline ? 'not-allowed' : 'pointer',
                          }}
                          title={isOffline
                              ? `${display} is offline`
                              : `Open detailed monitor for ${display}`}
                          aria-label={isOffline
                              ? `${display} is offline`
                              : `Open detailed monitor for ${display}`}
                          role={isOffline ? undefined : 'button'}
                          tabIndex={isOffline ? -1 : 0}
                        >
                          {/* Thumbnail Header */}
                          {device.imageDataUrl ? (
                            <div
                              className="relative h-28 overflow-hidden"
                              style={{
                                background: 'linear-gradient(135deg, color-mix(in srgb, var(--surface-2), black 30%), var(--surface-1))',
                              }}
                            >
                              <img
                                src={device.imageDataUrl}
                                alt={display}
                                className="h-full w-full object-cover"
                                style={isOffline ? { filter: 'grayscale(100%) sepia(0.25) brightness(0.94)' } : undefined}
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                }}
                              />
                              {!isOffline && (
                                <div
                                  className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                  style={{ background: 'color-mix(in srgb, #000, transparent 55%)' }}
                                >
                                  <span
                                    className="rounded-md border px-2 py-1 text-[10px] font-semibold tracking-wide"
                                    style={{
                                      borderColor: 'color-mix(in srgb, #baf72e, var(--border-subtle) 55%)',
                                      color: '#d9ff8f',
                                      background: 'color-mix(in srgb, #1f2937, transparent 35%)',
                                    }}
                                  >
                                    {cardHoverHintText}
                                  </span>
                                </div>
                              )}
                            </div>
                          ) : (
                            <div
                              className="relative h-28 flex items-center justify-center"
                              style={{
                                background: 'linear-gradient(135deg, color-mix(in srgb, var(--surface-2), black 30%), var(--surface-1))',
                                color: 'var(--text-muted)',
                              }}
                            >
                              <Printer className="h-8 w-8 opacity-40" />
                              {!isOffline && (
                                <div
                                  className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                                  style={{ background: 'color-mix(in srgb, #000, transparent 55%)' }}
                                >
                                  <span
                                    className="rounded-md border px-2 py-1 text-[10px] font-semibold tracking-wide"
                                    style={{
                                      borderColor: 'color-mix(in srgb, #baf72e, var(--border-subtle) 55%)',
                                      color: '#d9ff8f',
                                      background: 'color-mix(in srgb, #1f2937, transparent 35%)',
                                    }}
                                  >
                                    {cardHoverHintText}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          <div className="p-3 space-y-2">
                            {/* Name + Status Pill */}
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-semibold leading-tight" style={{ color: 'var(--text-strong)' }} title={display}>
                                  {display}
                                </div>
                                <div className="truncate text-[10px] mt-0.5" style={{ color: 'var(--text-muted)' }} title={device.ipAddress || undefined}>
                                  {device.ipAddress || 'No IP'}
                                </div>
                              </div>
                              <div
                                className="inline-flex h-6 items-center rounded-full border px-2.5 text-[10px] font-semibold whitespace-nowrap flex-shrink-0"
                                style={{
                                  borderColor: isOffline
                                    ? 'color-mix(in srgb, #ef4444, var(--border-subtle) 52%)'
                                    : isPaused
                                    ? `color-mix(in srgb, ${pausedColor}, var(--border-subtle) 45%)`
                                    : isPrinting
                                    ? `color-mix(in srgb, ${brandColor}, var(--border-subtle) 45%)`
                                    : `color-mix(in srgb, ${idleColor}, var(--border-subtle) 40%)`,
                                  color: isOffline
                                    ? '#fecaca'
                                    : isPaused
                                      ? '#fde68a'
                                      : isPrinting
                                        ? brandColor
                                        : '#bfdbfe',
                                  background: isOffline
                                    ? 'color-mix(in srgb, #ef4444, var(--surface-1) 90%)'
                                    : isPaused
                                    ? `color-mix(in srgb, ${pausedColor}, var(--surface-1) 90%)`
                                    : isPrinting
                                    ? `color-mix(in srgb, ${brandColor}, var(--surface-1) 92%)`
                                    : `color-mix(in srgb, ${idleColor}, var(--surface-1) 88%)`,
                                }}
                              >
                                {isOffline ? 'Offline' : (isPaused ? 'Paused' : (isPrinting ? 'Printing' : (isIdle ? 'Idle' : 'Idle')))}
                              </div>
                            </div>

                            {/* State Text */}
                            <div className="text-[11px] leading-tight" style={{ color: 'var(--text-muted)' }} title={stateText}>
                              {stateText}
                            </div>

                            {/* Progress Bar (always rendered to keep card heights consistent) */}
                            <div className="space-y-2 min-h-[34px]">
                              <div className="h-2.5 w-full rounded-full border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), black 25%)' }}>
                                <div
                                  className="h-full rounded-full transition-[width] duration-200 ease-out"
                                  style={{
                                    width: `${(displayProgressPct ?? 0).toFixed(1)}%`,
                                    background: hasActivePrint ? progressFill : 'color-mix(in srgb, var(--text-muted), transparent 78%)',
                                  }}
                                />
                              </div>
                              <div className="text-[10px] flex justify-between" style={{ color: 'var(--text-muted)' }}>
                                <span>Layer {displayLayerText}</span>
                                <span className="font-semibold" style={{ color: hasActivePrint ? progressTextColor : 'var(--text-muted)' }}>
                                  {hasActivePrint && displayProgressPct != null ? `${displayProgressPct.toFixed(0)}%` : '-'}
                                </span>
                              </div>
                            </div>

                          </div>
                        </div>
                      );
                    })}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border p-6 text-center" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 4%)' }}>
                    <Printer className="h-8 w-8 mx-auto mb-2 opacity-40" style={{ color: 'var(--text-muted)' }} />
                    <div className="text-[12px] font-medium" style={{ color: 'var(--text-strong)' }}>
                      No printers available
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                      No networked printers with valid IP addresses were found in this fleet
                    </div>
                  </div>
                )}
              </div>
            ) : shouldShowPrintingMonitorSlowResponseCard ? (
              <div className="p-4">
                <div
                  className="h-[min(62vh,520px)] rounded-xl border"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-1), #000 4%)',
                  }}
                >
                  <div className="h-full w-full flex items-center justify-center p-6">
                    <div className="max-w-md w-full rounded-xl border px-5 py-5 text-center" style={{
                      borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 56%)',
                      background: 'color-mix(in srgb, #78350f, var(--surface-1) 72%)',
                    }}>
                      <div className="mx-auto mb-3 inline-flex h-11 w-11 items-center justify-center rounded-lg border" style={{
                        borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 52%)',
                        background: 'color-mix(in srgb, #f59e0b, transparent 84%)',
                        color: 'color-mix(in srgb, #f59e0b, var(--text-strong) 20%)',
                      }}>
                        <RefreshCw className="h-5 w-5 animate-spin" />
                      </div>
                      <h3 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                        Printer is responding slowly
                      </h3>
                      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        We will keep trying to reconnect for another {printingMonitorSlowResponseGraceRemainingSec}s. If reconnection fails, please verify the network configuration and confirm the printer is online.
                      </p>
                      <div className="mt-4 mx-auto w-[78%]">
                        <div
                          className="ui-loading-track h-2.5 w-full rounded-full"
                          style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                        >
                          <div
                            className="ui-loading-indicator"
                            style={{ background: 'linear-gradient(90deg, #f59e0b, color-mix(in srgb, #f59e0b, #fde68a 28%))' }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : isPrintingMonitorSelectedPrinterOffline ? (
              <div className="p-4">
                <div
                  className="h-[min(62vh,520px)] rounded-xl border"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-1), #000 4%)',
                  }}
                >
                  <div className="h-full w-full flex items-center justify-center p-6">
                    <div className="max-w-md w-full rounded-xl border px-5 py-5 text-center" style={{
                      borderColor: 'color-mix(in srgb, #f87171, var(--border-subtle) 56%)',
                      background: 'color-mix(in srgb, #7f1d1d, var(--surface-1) 72%)',
                    }}>
                      <div className="mx-auto mb-3 inline-flex h-11 w-11 items-center justify-center rounded-lg border" style={{
                        borderColor: 'color-mix(in srgb, #f87171, var(--border-subtle) 52%)',
                        background: 'color-mix(in srgb, #f87171, transparent 84%)',
                        color: 'var(--danger)',
                      }}>
                        <AlertTriangle className="h-5 w-5" />
                      </div>
                      <h3 className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
                        This machine is currently offline
                      </h3>
                      <p className="mt-2 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        Reconnect this printer in Network Settings, or choose a different online printer from the selector above.
                      </p>
                      <div className="mt-4 flex items-center justify-center">
                        <button
                          type="button"
                          className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                          onClick={() => {
                            setPrintingMonitorModalOpen(false);
                            openProfileSettingsModal('printer', { openNetworkSettings: true });
                          }}
                        >
                          Open Network Settings
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div
                className={`p-4 grid grid-cols-1 items-start ${printingMonitorDetailWebcamExpanded ? 'gap-y-3 lg:gap-x-0' : 'gap-3'} ${printingMonitorUsesTwoColumnDetailLayout ? 'lg:items-stretch lg:[grid-template-columns:var(--printing-monitor-detail-columns)]' : ''}`}
                style={printingMonitorUsesTwoColumnDetailLayout
                  ? ({
                      '--printing-monitor-detail-columns': printingMonitorDetailWebcamExpanded
                        ? 'minmax(0,1fr)'
                        : 'minmax(340px,1fr) minmax(420px,1fr)',
                    } as React.CSSProperties)
                  : undefined}
              >
                {!printingMonitorDetailWebcamExpanded && (
                <section
                  ref={printingMonitorLeftColumnRef}
                  className="grid gap-3 grid-rows-[auto_1fr] overflow-hidden transition-[opacity,transform] duration-140 ease-out motion-reduce:transition-none opacity-100 translate-y-0"
                >
                <div className="w-full min-w-0 max-w-full overflow-hidden rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 4%)' }}>
                  <div className={`grid min-h-[34px] items-center gap-2 px-1 ${printingMonitorHasActivePrint ? 'grid-cols-[1fr_auto]' : 'grid-cols-[1fr_auto_1fr]'}`}>
                    <div className="justify-self-start text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      {printingMonitorHasActivePrint ? 'Print Details' : 'Print Files'}
                    </div>
                    {!printingMonitorHasActivePrint && (
                      <div
                        className="relative inline-flex h-9 w-[132px] items-center rounded-lg border p-1 justify-self-center overflow-hidden"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-1), #000 12%)',
                          boxShadow: 'inset 0 1px 0 color-mix(in srgb, #ffffff, transparent 94%)',
                        }}
                        aria-label="Print file source"
                      >
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute bottom-1 left-1 top-1 rounded-md border transition-transform duration-200 ease-out"
                          style={{
                            width: 'calc(50% - 4px)',
                            transform: printingMonitorPlatesStoragePath === '/usb/' ? 'translateX(100%)' : 'translateX(0)',
                            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 32%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 78%)',
                          }}
                        />
                        <button
                          type="button"
                          className="relative z-[1] inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold tracking-[0.02em] transition-colors duration-200"
                          style={{
                            color: printingMonitorPlatesStoragePath === '/local/' ? 'var(--text-strong)' : 'var(--text-muted)',
                          }}
                          onClick={() => handlePrintingMonitorStoragePathChange('/local/')}
                          title="Show print files from local storage"
                        >
                          Local
                        </button>
                        <button
                          type="button"
                          className="relative z-[1] inline-flex h-7 min-w-0 flex-1 items-center justify-center rounded-md px-2.5 text-[11px] font-semibold tracking-[0.02em] transition-colors duration-200"
                          style={{
                            color: printingMonitorPlatesStoragePath === '/usb/' ? 'var(--text-strong)' : 'var(--text-muted)',
                          }}
                          onClick={() => handlePrintingMonitorStoragePathChange('/usb/')}
                          title="Show print files from USB storage"
                        >
                          USB
                        </button>
                      </div>
                    )}
                    <IconButton
                      onClick={() => {
                        void refreshPrintingMonitorRecentPlates();
                      }}
                      disabled={printingMonitorAnyActionBusy || isPrintingMonitorRecentPlatesLoading}
                      className="!p-1.5 justify-self-end"
                      title="Refresh print files"
                      aria-label="Refresh print files"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isPrintingMonitorRecentPlatesLoading ? 'animate-spin' : ''}`} />
                    </IconButton>
                  </div>
                  <div className="mt-1.5 w-full min-w-0 max-w-full rounded-md border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 6%)' }}>
                    <div className="h-[clamp(220px,30vh,320px)] w-full">
                      {printingMonitorHasActivePrint && (printingMonitorThumbnailDisplayUrl || printingMonitorThumbnailUrl) ? (
                        <div className="relative h-full w-full overflow-hidden">
                          {!isPrintingMonitorThumbnailLoaded && (
                            <div className="absolute inset-0 flex items-center justify-center px-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              <div className="w-[74%]">
                                <div
                                  className="ui-loading-track h-2.5 w-full rounded-full"
                                  style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                                >
                                  <div
                                    className="ui-loading-indicator"
                                    style={{ background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))' }}
                                  />
                                </div>
                                <div className="mt-2 text-center">Loading thumbnail…</div>
                              </div>
                            </div>
                          )}
                          <img
                            src={printingMonitorThumbnailDisplayUrl ?? printingMonitorThumbnailUrl ?? undefined}
                            alt="Active print thumbnail"
                            className="absolute inset-0 h-full w-full object-contain object-center transition-opacity duration-150"
                            style={{
                              opacity: isPrintingMonitorThumbnailLoaded ? 1 : 0,
                              maxWidth: '100%',
                              maxHeight: '100%',
                            }}
                            loading="eager"
                            decoding="async"
                            fetchPriority="high"
                          />
                        </div>
                      ) : (
                        <div className="h-full w-full min-w-0 max-w-full overflow-hidden p-2">
                          {printingMonitorRecentPlates.length > 0 ? (
                            <div className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col overflow-hidden">
                              <div className="min-h-0 w-full min-w-0 max-w-full flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar space-y-1 pr-1">
                                {printingMonitorRecentPlates.map((plate) => {
                                  return (
                                    <div
                                      key={plate.plateId}
                                      className="w-full min-w-0 overflow-hidden rounded-md border px-2 py-1.5"
                                      style={{
                                        borderColor: 'var(--border-subtle)',
                                        background: 'var(--surface-1)',
                                      }}
                                    >
                                      <div className="flex w-full min-w-0 items-center gap-3 overflow-hidden">
                                        <div className="min-w-0 basis-0 flex-1 overflow-hidden pr-3 text-left">
                                          <div className="block w-full max-w-full truncate text-[11px]" style={{ color: 'var(--text-strong)' }} title={`#${plate.plateId} • ${plate.name}`}>
                                            {`#${plate.plateId} • ${plate.name}`}
                                          </div>
                                          <div className="mt-0.5 block w-full max-w-full truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {plate.materialProfileName ?? 'Material profile unavailable'}
                                          </div>
                                          <div className="mt-0.5 block w-full max-w-full truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {`Est. ${formatPrintingMonitorEstimatedTime(plate.printTimeSec)} • ${formatPrintingMonitorUsedMaterial(plate.usedMaterialMl)}`}
                                          </div>
                                          <div className="mt-0.5 block w-full max-w-full truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>
                                            {`Area Σ ${formatPrintingMonitorAreaMm2(plate.totalSolidAreaMm2)} • Min ${formatPrintingMonitorAreaMm2(plate.smallestAreaMm2)} • Max ${formatPrintingMonitorAreaMm2(plate.largestAreaMm2)}`}
                                          </div>
                                        </div>

                                        <div className="flex w-[56px] shrink-0 items-center justify-end gap-1">
                                          <IconButton
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              void handleStartMonitorRecentPlate(plate.plateId);
                                            }}
                                            className="!p-1.5"
                                            style={{
                                              borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)',
                                              background: 'color-mix(in srgb, #22c55e, var(--surface-1) 86%)',
                                              color: 'color-mix(in srgb, #22c55e, var(--text-strong) 25%)',
                                            }}
                                            title={`Start plate #${plate.plateId}`}
                                            disabled={printingMonitorAnyActionBusy || printingMonitorHasActivePrint}
                                          >
                                            <Play className="w-3.5 h-3.5" />
                                          </IconButton>
                                          <IconButton
                                            onClick={(event) => {
                                              event.stopPropagation();
                                              void handleDeleteMonitorRecentPlate(plate.plateId);
                                            }}
                                            className="!p-1.5"
                                            style={{
                                              borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                                              background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                                              color: '#fecaca',
                                            }}
                                            title={`Delete plate #${plate.plateId}`}
                                            disabled={printingMonitorAnyActionBusy}
                                          >
                                            <Trash2 className="w-3.5 h-3.5" />
                                          </IconButton>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <div className="flex h-full w-full items-center justify-center px-3 py-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {isPrintingMonitorRecentPlatesLoading ? (
                                'Loading recent print files…'
                              ) : printingMonitorRecentPlatesError ? (
                                printingMonitorRecentPlatesError
                              ) : (
                                <div className="flex flex-col items-center gap-2 text-center">
                                  <span className="text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>No Files Found</span>
                                  <button
                                    type="button"
                                    className="ui-button ui-button-secondary !h-8 !px-3 !py-0 !text-[11px] !font-semibold inline-flex items-center justify-center gap-1"
                                    onClick={() => {
                                      void refreshPrintingMonitorRecentPlates();
                                    }}
                                    disabled={printingMonitorAnyActionBusy || isPrintingMonitorRecentPlatesLoading}
                                  >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    Refresh
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-md border p-3 space-y-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 4%)' }}>
                  <div className="flex items-center justify-between gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <span>{printingMonitorSnapshot?.stateText ?? 'Polling printer status…'}</span>
                    <span>
                      {isPrintingMonitorStatusRequestInFlight && isPrintingMonitorWithinSlowResponseGrace
                        ? 'Busy…'
                        : (isPrintingMonitorPolling ? 'Live' : 'Idle')}
                    </span>
                  </div>

                  {printingMonitorHasActivePrint ? (
                    <>
                      <div
                        className="h-2 w-full rounded-full border overflow-hidden"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), black 20%)',
                        }}
                      >
                        <div
                          className="h-full rounded-full transition-[width] duration-200 ease-out"
                          style={{
                            width: `${(printingMonitorDisplayProgressPct ?? 0).toFixed(2)}%`,
                            background: 'linear-gradient(90deg, #60a5fa, #22d3ee)',
                          }}
                        />
                      </div>
                      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        Progress {printingMonitorDisplayProgressPct != null ? `${printingMonitorDisplayProgressPct.toFixed(1)}%` : '—'}
                      </div>
                    </>
                  ) : (
                    <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      No active print.
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                      Layer:{' '}
                      <span style={{ color: 'var(--text-strong)' }}>
                        {printingMonitorDisplayTotalLayers != null
                          ? `${printingMonitorDisplayCurrentLayer ?? '—'}/${printingMonitorDisplayTotalLayers}`
                          : (printingMonitorDisplayCurrentLayer != null ? `${printingMonitorDisplayCurrentLayer}` : '—')}
                      </span>
                    </div>
                    <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                      Material:{' '}
                      <span style={{ color: 'var(--text-strong)' }}>{printingMonitorDisplayMaterialProfile}</span>
                    </div>
                    <div
                      className="col-span-2 rounded-md border px-2.5 py-2 truncate"
                      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                      title={printingMonitorHasActivePrint ? (printingMonitorSnapshot?.jobName ?? undefined) : undefined}
                    >
                      Job:{' '}
                      <span style={{ color: 'var(--text-strong)' }}>{printingMonitorHasActivePrint ? (printingMonitorSnapshot?.jobName ?? '—') : '—'}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className="ui-button !h-9 px-3 text-xs"
                      style={!printingMonitorPauseButtonDisabled
                        ? {
                            borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
                            background: 'color-mix(in srgb, var(--accent), var(--surface-1) 87%)',
                            color: 'var(--text-strong)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--surface-2), black 8%)',
                            color: 'var(--text-muted)',
                            opacity: 0.55,
                          }}
                      onClick={() => {
                        void handlePrintingMonitorControlAction(printingMonitorSnapshot?.isPaused ? 'resume' : 'pause');
                      }}
                      disabled={printingMonitorPauseButtonDisabled}
                    >
                      {printingMonitorPauseButtonAnimating
                        ? (
                          <span className="inline-flex items-center gap-1.5">
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            <span>
                              {printingMonitorControlPendingAction === 'resume'
                                ? 'Resuming…'
                                : printingMonitorSnapshot?.isPaused && !printingMonitorIsPauseTransition
                                  ? 'Resuming…'
                                  : 'Pausing…'}
                            </span>
                          </span>
                        )
                        : (printingMonitorSnapshot?.isPaused ? 'Resume' : 'Pause')}
                    </button>

                    <button
                      type="button"
                      className="ui-button !h-9 px-3 text-xs"
                      style={!printingMonitorCancelButtonDisabled
                        ? {
                            borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 48%)',
                            background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 88%)',
                            color: '#fde68a',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--surface-2), black 8%)',
                            color: 'var(--text-muted)',
                            opacity: 0.55,
                          }}
                      onClick={() => {
                        void handlePrintingMonitorControlAction('cancel');
                      }}
                      disabled={printingMonitorCancelButtonDisabled}
                    >
                      {printingMonitorCancelButtonAnimating
                        ? (
                          <span className="inline-flex items-center gap-1.5">
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            <span>Canceling…</span>
                          </span>
                        )
                        : 'Cancel'}
                    </button>

                    <button
                      type="button"
                      className="ui-button !h-9 px-3 text-xs col-span-2"
                      style={{
                        borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)',
                        background: 'color-mix(in srgb, #ef4444, var(--surface-1) 78%)',
                        color: '#fee2e2',
                      }}
                      onClick={() => {
                        void handlePrintingMonitorControlAction('emergency-stop');
                      }}
                      disabled={printingMonitorEmergencyStopDisabled}
                    >
                      {(printingMonitorControlPendingAction === 'emergency-stop' || printingMonitorActionBusy === 'emergency-stop')
                        ? 'Stopping…'
                        : 'Emergency Stop'}
                    </button>
                  </div>

                </div>
                </section>
                )}

                {printingMonitorHasCamera && (
                <section
                  ref={printingMonitorWebcamSectionRef}
                  className={`rounded-md border p-2 flex flex-col min-h-0 overflow-hidden self-stretch h-[min(62vh,520px)] lg:h-full transition-opacity duration-150 ease-out motion-reduce:transition-none ${printingMonitorDetailWebcamExpanded ? 'opacity-100' : 'opacity-[0.985]'}`}
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-1), #000 4%)',
                  }}
                >
                <div className="grid min-h-[34px] grid-cols-[1fr_auto] items-center gap-2 px-1">
                  <div className="justify-self-start text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Webcam
                  </div>
                  <div className="justify-self-end inline-flex items-center gap-1.5">
                    {printingMonitorCanExpandWebcam && (
                      <IconButton
                        onClick={() => setPrintingMonitorWebcamExpanded((previous) => !previous)}
                        className="!p-1.5"
                        title={printingMonitorDetailWebcamExpanded ? 'Collapse webcam view' : 'Expand webcam view'}
                        aria-label={printingMonitorDetailWebcamExpanded ? 'Collapse webcam view' : 'Expand webcam view'}
                      >
                        {printingMonitorDetailWebcamExpanded
                          ? <Minimize2 className="w-3.5 h-3.5" />
                          : <Maximize2 className="w-3.5 h-3.5" />}
                      </IconButton>
                    )}
                    <IconButton
                      onClick={() => {
                        void handleSavePrintingMonitorWebcamSnapshot();
                      }}
                      disabled={isPrintingMonitorWebcamSnapshotSaving || !printingMonitorWebcamUrl || !isPrintingMonitorWebcamLoaded}
                      className="!p-1.5"
                      title="Save webcam snapshot"
                      aria-label="Save webcam snapshot"
                    >
                      {isPrintingMonitorWebcamSnapshotSaving
                        ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        : <Download className="w-3.5 h-3.5" />}
                    </IconButton>
                  </div>
                </div>
                {printingMonitorWebcamUrl ? (
                  <div className="mt-1.5 flex-1 min-h-0 min-w-0 flex items-center justify-center overflow-hidden">
                    {printingMonitorWebcamLoadError ? (
                      <div className="w-full max-w-full rounded-md border p-4 flex items-center justify-center h-full" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 7%)' }}>
                        <div className="text-center max-w-[520px] w-full">
                          <div
                            className="inline-flex h-12 w-12 items-center justify-center rounded-full border mb-3"
                            style={{
                              borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 30%)',
                              background: 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)',
                            }}
                          >
                            <AlertTriangle className="w-5 h-5" style={{ color: 'var(--danger)' }} />
                          </div>

                          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                            {printingMonitorWebcamDisplayPresentation.title}
                          </h4>
                          <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                            {printingMonitorWebcamDisplayPresentation.description}
                          </p>

                          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                            {printingMonitorWebcamCanResetStreamSlot && (
                              <button
                                type="button"
                                className="ui-button ui-button-secondary !h-8 px-2.5 text-[10px]"
                                onClick={() => {
                                  void handleResetPrintingMonitorWebcamStreamSlot();
                                }}
                                disabled={isPrintingMonitorWebcamResetBusy}
                                title="Ask the printer to disable any stale webcam stream before retrying"
                              >
                                {isPrintingMonitorWebcamResetBusy ? 'Resetting stream…' : 'Reset stream slot'}
                              </button>
                            )}

                            <button
                              type="button"
                              className="ui-button ui-button-secondary !h-8 px-2.5 text-[10px]"
                              onClick={() => {
                                triggerPrintingMonitorWebcamRetry();
                              }}
                              disabled={isPrintingMonitorWebcamResetBusy}
                            >
                              Retry
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div
                        ref={printingMonitorWebcamViewportRef}
                        className="relative rounded-md border overflow-hidden h-full max-h-full max-w-full"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-1), #000 6%)',
                          width: isPrintingMonitorWebcamLoaded ? undefined : '100%',
                          minWidth: isPrintingMonitorWebcamLoaded ? undefined : 'min(100%, 220px)',
                        }}
                      >
                        {!isPrintingMonitorWebcamLoaded && (
                          <div className="absolute inset-0 z-[1] flex items-center justify-center px-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            <div className="w-[74%]">
                              <div
                                className="ui-loading-track h-2.5 w-full rounded-full"
                                style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
                              >
                                <div
                                  className="ui-loading-indicator"
                                  style={{ background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent), #ffffff 28%))' }}
                                />
                              </div>
                              <div className="mt-2 text-center">Loading camera feed…</div>
                            </div>
                          </div>
                        )}
                        <div className="h-full w-full min-h-0 min-w-0 flex items-center justify-center overflow-hidden">
                        <div
                          className="max-h-full max-w-full"
                          style={monitorWebcamDisplayAspectRatio != null
                            ? {
                                width: '100%',
                                height: 'auto',
                                maxWidth: '100%',
                                maxHeight: '100%',
                                aspectRatio: String(monitorWebcamDisplayAspectRatio),
                              }
                            : {
                                width: '100%',
                                height: '100%',
                                maxWidth: '100%',
                                maxHeight: '100%',
                              }}
                        >
                          {printingMonitorWebcamUsesRelayWs ? (
                            <RtspRelayCanvasPlayer
                              url={printingMonitorWebcamUrl}
                              className="block h-full w-full object-contain transition-opacity duration-150"
                              style={{
                                opacity: isPrintingMonitorWebcamLoaded ? 1 : 0,
                                transform: monitorWebcamTransform,
                                transformOrigin: 'center center',
                              }}
                              onLoaded={(ratio) => {
                                cancelPrintingMonitorWebcamReadinessCheck();
                                printingMonitorRelayAutoRetryCountRef.current = 0;
                                if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
                                  window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
                                  printingMonitorRelayAutoRetryTimeoutRef.current = null;
                                }
                                const normalizedRatio = normalizePrintingMonitorWebcamAspectRatio(ratio);
                                if (normalizedRatio != null) {
                                  setPrintingMonitorWebcamAspectRatio((previous) => {
                                    if (previous != null && Math.abs(previous - normalizedRatio) < 0.001) return previous;
                                    return normalizedRatio;
                                  });
                                }
                                setIsPrintingMonitorWebcamLoaded(true);
                                setPrintingMonitorWebcamLoadError(null);
                              }}
                              onError={(message) => {
                                cancelPrintingMonitorWebcamReadinessCheck();
                                console.warn('[Monitor/Webcam] rtsp-relay playback issue', { url: printingMonitorWebcamUrl, message });
                                const normalizedMessage = String(message ?? '').toLowerCase();
                                const isRetryableRelayError = printingMonitorWebcamUsesRelayWs && (
                                  normalizedMessage.includes('did not deliver any video data in time')
                                  || normalizedMessage.includes('websocket disconnected')
                                );
                                if (isRetryableRelayError && printingMonitorRelayAutoRetryCountRef.current < DEFAULT_RELAY_AUTORETRY_LIMIT) {
                                  printingMonitorRelayAutoRetryCountRef.current += 1;
                                  const attempt = printingMonitorRelayAutoRetryCountRef.current;
                                  setIsPrintingMonitorWebcamLoaded(false);
                                  setPrintingMonitorWebcamLoadError(`Webcam stream stalled. Retrying (${attempt}/${DEFAULT_RELAY_AUTORETRY_LIMIT})…`);
                                  if (printingMonitorRelayAutoRetryTimeoutRef.current != null) {
                                    window.clearTimeout(printingMonitorRelayAutoRetryTimeoutRef.current);
                                  }
                                  printingMonitorRelayAutoRetryTimeoutRef.current = window.setTimeout(() => {
                                    printingMonitorRelayAutoRetryTimeoutRef.current = null;
                                    triggerPrintingMonitorWebcamRetry();
                                  }, DEFAULT_RELAY_AUTORETRY_DELAY_MS);
                                  return;
                                }
                                setIsPrintingMonitorWebcamLoaded(false);
                                setPrintingMonitorWebcamLoadError(message);
                              }}
                            />
                          ) : (
                            <img
                              src={printingMonitorWebcamUrl}
                              alt="Printer webcam preview"
                              className="block h-full w-full object-contain transition-opacity duration-150"
                              style={{
                                opacity: isPrintingMonitorWebcamLoaded ? 1 : 0,
                                transform: monitorWebcamTransform,
                                transformOrigin: 'center center',
                              }}
                              onLoad={(event) => {
                                schedulePrintingMonitorMjpegReadinessCheck(event.currentTarget);
                              }}
                              onError={() => {
                                cancelPrintingMonitorWebcamReadinessCheck();
                                setIsPrintingMonitorWebcamLoaded(false);
                                setPrintingMonitorWebcamLoadError('The webcam image could not be loaded.');
                              }}
                              loading="eager"
                              decoding="async"
                              fetchPriority="high"
                            />
                          )}
                        </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="mt-1.5 flex-1 min-h-0 rounded-md border p-4 flex items-center justify-center" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 7%)' }}>
                    <div className="text-center max-w-[520px] w-full">
                      <div
                        className="inline-flex h-12 w-12 items-center justify-center rounded-full border mb-3"
                        style={printingMonitorWebcamStatusPresentation.tone === 'warning'
                            ? {
                                borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 35%)',
                                background: 'color-mix(in srgb, #d97706, var(--surface-1) 90%)',
                              }
                            : printingMonitorWebcamStatusPresentation.tone === 'error'
                              ? {
                                  borderColor: 'color-mix(in srgb, var(--danger), var(--border-subtle) 30%)',
                                  background: 'color-mix(in srgb, var(--danger), var(--surface-1) 90%)',
                                }
                              : {
                                  borderColor: 'var(--border-subtle)',
                                  background: 'var(--surface-1)',
                                }}
                      >
                        {printingMonitorWebcamStatusPresentation.tone === 'warning' ? (
                          <AlertTriangle className="w-5 h-5" style={{ color: '#d97706' }} />
                        ) : printingMonitorWebcamStatusPresentation.tone === 'error' ? (
                          <AlertTriangle className="w-5 h-5" style={{ color: 'var(--danger)' }} />
                        ) : (
                          <RefreshCw className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />
                        )}
                      </div>

                      <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                        {printingMonitorWebcamStatusPresentation.title}
                      </h4>
                      <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        {printingMonitorWebcamStatusPresentation.description}
                      </p>

                      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                      {printingMonitorWebcamCanResetStreamSlot && (
                        <button
                          type="button"
                          className="ui-button ui-button-secondary !h-8 px-2.5 text-[10px]"
                          onClick={() => {
                            void handleResetPrintingMonitorWebcamStreamSlot();
                          }}
                          disabled={isPrintingMonitorWebcamResetBusy}
                          title="Ask the printer to disable any stale webcam stream before retrying"
                        >
                          {isPrintingMonitorWebcamResetBusy ? 'Resetting stream…' : 'Reset stream slot'}
                        </button>
                      )}

                      <button
                        type="button"
                        className="ui-button ui-button-secondary !h-8 px-2.5 text-[10px]"
                        onClick={() => {
                          triggerPrintingMonitorWebcamRetry();
                        }}
                        disabled={isPrintingMonitorWebcamResetBusy}
                      >
                        Retry
                      </button>
                    </div>
                    </div>
                  </div>
                )}
                </section>
                )}
              </div>
            )}

            {isPrintingMonitorDebugOpen && (
              <div className="pointer-events-none fixed right-4 top-[5.25rem] z-[170] w-[min(760px,94vw)]">
                <div
                  className="pointer-events-auto rounded-lg border p-2.5 font-mono text-[10px] leading-tight shadow-xl"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-strong)',
                    background: 'color-mix(in srgb, var(--surface-0), black 14%)',
                    fontSize: '10px',
                  }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs font-semibold" style={{ fontFamily: 'var(--font-geist-mono)' }}>
                      Monitor Debug Overlay (Ctrl+Shift+N)
                    </div>
                    <div className="inline-flex items-center gap-1.5">
                      <button
                        type="button"
                        className="rounded border px-2 py-0.5 text-[10px]"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                        onClick={() => {
                          void handleCopyPrintingMonitorDebugBundle();
                        }}
                        title="Copy monitor debug bundle"
                      >
                        {printingMonitorDebugCopyState === 'copied'
                          ? 'Copied'
                          : printingMonitorDebugCopyState === 'failed'
                            ? 'Copy Failed'
                            : 'Copy JSON'}
                      </button>
                      <button
                        type="button"
                        className="rounded border px-2 py-0.5 text-[10px]"
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                        onClick={() => setIsPrintingMonitorDebugOpen(false)}
                      >
                        Close
                      </button>
                    </div>
                  </div>


                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <div style={{ color: 'var(--text-muted)' }}>Printer</div>
                    <div className="truncate" title={printingMonitorHeaderBottomLabel}>
                      {printingMonitorHeaderBottomLabel}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Device host</div>
                    <div className="truncate" title={printingMonitorDebugBundle.selectedDevice?.ipAddress ?? 'n/a'}>
                      {printingMonitorDebugBundle.selectedDevice?.ipAddress ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Reachability</div>
                    <div>
                      {printingMonitorDebugBundle.selectedDevice?.reachability == null
                        ? 'unknown'
                        : (printingMonitorDebugBundle.selectedDevice.reachability ? 'online' : 'offline')}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Offline gate</div>
                    <div>{printingMonitorDebugBundle.offlineGate.isPrintingMonitorSelectedPrinterOffline ? 'true' : 'false'}</div>
                  </div>

                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Channel payloads
                    </div>
                    <div className="grid gap-2 lg:grid-cols-3">
                      {printingMonitorDebugPanels.map((panel) => (
                        <div
                          key={panel.channel}
                          className="rounded-md border overflow-hidden"
                          style={{

                            borderColor: 'var(--border-subtle)',
                            background: 'color-mix(in srgb, var(--surface-2), #000 8%)',
                          }}
                        >
                          <div
                            className="border-b px-2 py-1 text-[10px] uppercase tracking-[0.08em] flex items-center justify-between gap-2"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                          >
                            <span>{panel.channel}</span>
                            <span style={{ color: panel.hasError ? '#fca5a5' : 'var(--text-muted)' }}>
                              {panel.statusText}
                            </span>
                          </div>
                          <pre
                            className="max-h-56 overflow-auto custom-scrollbar p-2 text-[10px] leading-[1.35]"
                            style={{ color: 'var(--text-strong)' }}
                          >
                            {panel.json}
                          </pre>
                          <div
                            className="border-t px-2 py-1 text-[10px]"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                          >
                            {panel.requestedAt ?? 'not requested'}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Manual SDCP commands
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || !printingMonitoringAdapter.operations?.webcamEnable}
                        onClick={() => {
                          void executePrintingMonitorFeatureToggle('webcam', true);
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 386</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Enable video stream</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || !printingMonitoringAdapter.operations?.webcamDisable}
                        onClick={() => {
                          void executePrintingMonitorFeatureToggle('webcam', false);
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 386</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Disable video stream</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || !printingMonitoringAdapter.operations?.timelapseEnable}
                        onClick={() => {
                          void executePrintingMonitorFeatureToggle('timelapse', true);
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 387</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Enable timelapse</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || !printingMonitoringAdapter.operations?.timelapseDisable}
                        onClick={() => {
                          void executePrintingMonitorFeatureToggle('timelapse', false);
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 387</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Disable timelapse</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || printingMonitoringAdapter.pluginId !== 'sdcp-v3'}
                        onClick={() => {
                          void executePrintingMonitorSdcpDebugCommand({
                            operation: 'sdcp/task/history/list',
                            label: 'Task history',
                            channel: 'taskHistory',
                          });
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 320</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Fetch task history IDs</div>
                      </button>
                      <button
                        type="button"
                        className="rounded-md border px-2 py-1 text-left text-[10px] transition-colors"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-2), #000 6%)',
                          color: 'var(--text-strong)',
                        }}
                        disabled={printingMonitorAnyActionBusy || printingMonitoringAdapter.pluginId !== 'sdcp-v3'}
                        onClick={() => {
                          void executePrintingMonitorSdcpDebugCommand({
                            operation: 'sdcp/task/details',
                            label: 'Task details',
                            channel: 'taskDetails',
                          });
                        }}
                      >
                        <div className="font-semibold uppercase tracking-wide">Cmd 321</div>
                        <div className="mt-0.5" style={{ color: 'var(--text-muted)' }}>Fetch task detail records</div>
                      </button>
                    </div>
                    <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      {printingMonitorActionStatus ?? 'Use these commands to manually toggle SDCP device features.'}
                    </div>
                  </div>

                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="mb-1 text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Last SDCP response JSON
                    </div>
                    <div
                      className="rounded-md border px-2 py-1"
                      style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), #000 8%)' }}
                    >
                      <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                        <span className="truncate" title={printingMonitorLastFeatureToggleResponse?.operation ?? 'n/a'}>
                          {printingMonitorLastFeatureToggleResponse?.operation ?? 'No response yet'}
                        </span>
                        <span>
                          {printingMonitorLastFeatureToggleResponse
                            ? `HTTP ${printingMonitorLastFeatureToggleResponse.httpStatus ?? 'n/a'}${printingMonitorLastFeatureToggleResponse.httpOk === true ? ' • transport-ok' : printingMonitorLastFeatureToggleResponse.httpOk === false ? ' • transport-error' : ''}${printingMonitorLastFeatureToggleResponse.commandOk === true ? ' • command-ok' : printingMonitorLastFeatureToggleResponse.commandOk === false ? ' • command-error' : ''}`
                            : 'waiting'}
                        </span>
                      </div>
                      <pre
                        className="mt-1 max-h-40 overflow-auto custom-scrollbar whitespace-pre-wrap break-words rounded-sm border px-2 py-1 text-[10px] leading-[1.35]"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'var(--surface-1)',
                          color: 'var(--text-strong)',
                        }}
                      >
                        {printingMonitorLastFeatureToggleResponse
                          ? JSON.stringify({
                            httpStatus: printingMonitorLastFeatureToggleResponse.httpStatus,
                            httpOk: printingMonitorLastFeatureToggleResponse.httpOk,
                            commandOk: printingMonitorLastFeatureToggleResponse.commandOk,
                            error: printingMonitorLastFeatureToggleResponse.error,
                            payload: printingMonitorLastFeatureToggleResponse.payload,
                          }, null, 2)
                          : 'Click a command to inspect the response JSON.'}
                      </pre>
                    </div>
                  </div>

                  <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Toggle: Ctrl+Shift+N
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

            {isPrintingMonitorRtspDebugOpen && (
              <div className="pointer-events-none fixed left-4 top-[5.25rem] z-[170] w-[min(620px,94vw)]">
                <div
                  className="pointer-events-auto rounded-lg border p-2.5 font-mono text-[10px] leading-tight shadow-xl"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-strong)',
                    background: 'color-mix(in srgb, var(--surface-0), black 14%)',
                    fontSize: '10px',
                  }}
                >
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs font-semibold" style={{ fontFamily: 'var(--font-geist-mono)' }}>
                      RTSP Debug Overlay (Ctrl+Shift+M)
                    </div>
                    <button
                      type="button"
                      className="rounded border px-2 py-0.5 text-[10px]"
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
                      onClick={() => setIsPrintingMonitorRtspDebugOpen(false)}
                    >
                      Close
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                    <div style={{ color: 'var(--text-muted)' }}>Mode</div>
                    <div>{printingMonitorRtspDebugSummary.title}</div>

                    <div style={{ color: 'var(--text-muted)' }}>Source RTSP</div>
                    <div className="truncate" title={printingMonitorRtspSourceUrl ?? 'n/a'}>
                      {printingMonitorRtspSourceUrl ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Relay base</div>
                    <div className="truncate" title={printingMonitorRelayBaseWsUrl ?? 'n/a'}>
                      {printingMonitorRelayBaseWsUrl ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Final webcam URL</div>
                    <div className="truncate" title={printingMonitorWebcamUrl ?? 'n/a'}>
                      {printingMonitorWebcamUrl ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Transport path</div>
                    <div>
                      {printingMonitorWebcamUsesRelayWs
                        ? 'RTSP relay websocket'
                        : printingMonitorInlineWebcamUrl
                          ? 'Direct webcam URL'
                          : 'Unavailable'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>UDP source port</div>
                    <div>{printingMonitorRelayDebugTransport?.serverPort ?? 'n/a'}</div>

                    <div style={{ color: 'var(--text-muted)' }}>UDP destination port</div>
                    <div>{printingMonitorRelayDebugTransport?.clientPort ?? 'n/a'}</div>

                    <div className="col-span-2 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Source is the printer/server RTP port; destination is the DragonFruit/client RTP port.
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Reclaim session</div>
                    <div className="truncate" title={printingMonitorRelayReclaimDebug?.activeSessionId ?? 'n/a'}>
                      {printingMonitorRelayReclaimDebug?.activeSessionId ?? 'n/a'}
                    </div>

                    <div style={{ color: 'var(--text-muted)' }}>Reclaim status</div>
                    <div>{printingMonitorRelayReclaimDebug?.lastClaimStatus ?? 'n/a'}</div>

                    <div style={{ color: 'var(--text-muted)' }}>Webcam status</div>
                    <div title={printingMonitorWebcamDisplayPresentation.description}>
                      {printingMonitorWebcamDisplayPresentation.title}
                    </div>
                  </div>

                  <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      {printingMonitorRtspDebugSummary.description}
                    </div>
                    <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      Current feed note: {printingMonitorWebcamDisplayPresentation.description}
                    </div>
                    {printingMonitorRelayDebugTransport?.transportHeader && (
                      <div className="mt-1 text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                        Last Transport header: {printingMonitorRelayDebugTransport.transportHeader}
                      </div>
                    )}
                  </div>

                  <div className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    Toggle: Ctrl+Shift+M
                  </div>
                </div>
              </div>
            )}
    </>
  );
}
