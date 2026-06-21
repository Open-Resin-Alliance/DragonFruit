import React from 'react';
import { PrintingPanel } from '@/features/printing/components/PrintingPanel';
import { launchExternalProcess } from '@/features/slicing/tauri/nativeSlicerBridge';
import { getSavedUvToolsSettings, resolveUvToolsExecutablePath } from '@/components/settings/uvToolsPreferences';
import type { SliceExportArtifact } from '@/features/slicing/sliceExportOrchestrator';
import type { SliceIntent } from '@/features/slicing/components/SlicingPanel';
import type { PrinterProfile } from '@/features/profiles/profileStore';

export type PrintingPanelStackProps = {
  printingArtifact: SliceExportArtifact | null;
  printingOutputSizeLabel: React.ComponentProps<typeof PrintingPanel>['outputSizeLabel'];
  activePrinterProfile: PrinterProfile | null;
  printingResinName: React.ComponentProps<typeof PrintingPanel>['resinName'];
  estimatedPrintTimeLabel: React.ComponentProps<typeof PrintingPanel>['estimatedPrintTimeLabel'];
  estimatedVolumeMlLabel: React.ComponentProps<typeof PrintingPanel>['estimatedVolumeLabel'];
  canDownloadPrintArtifact: boolean;
  canSendToPrinter: boolean;
  printingSendBusy: boolean;
  printingSendStatusText: string | null;
  sendToPrinterButtonLabel: React.ComponentProps<typeof PrintingPanel>['sendButtonLabel'];
  printableConnectedPrinterFleet: readonly unknown[];
  setPrintingTargetPickerMode: (mode: 'post-slice' | 'pre-slice-upload' | 'pre-slice-print') => void;
  setPrintingTargetPickerOpen: (open: boolean) => void;
  handleDownloadPrintArtifact: () => void;
  handleSendToPrinter: () => void;
  handleCancelSendToPrinter: () => void;
  completedSliceIntent: SliceIntent | null;
  completedSaveDestinationPath: string | null;
};

/** PRINTING-mode floating panel group: the printing summary/actions panel. */
export function PrintingPanelStack({
  printingArtifact,
  printingOutputSizeLabel,
  activePrinterProfile,
  printingResinName,
  estimatedPrintTimeLabel,
  estimatedVolumeMlLabel,
  canDownloadPrintArtifact,
  canSendToPrinter,
  printingSendBusy,
  printingSendStatusText,
  sendToPrinterButtonLabel,
  printableConnectedPrinterFleet,
  setPrintingTargetPickerMode,
  setPrintingTargetPickerOpen,
  handleDownloadPrintArtifact,
  handleSendToPrinter,
  handleCancelSendToPrinter,
  completedSliceIntent,
  completedSaveDestinationPath,
}: PrintingPanelStackProps) {
  // Invoked inline by Home (not as <JSX/>) so FloatingPanelStack can flatten these keyed panels as direct children for its layout-profile positioning. 'use no memo' keeps React Compiler from injecting a useMemoCache hook (the conditional inline call must stay hook-free).
  'use no memo';
  return (
    <>
      <PrintingPanel
        outputName={printingArtifact?.outputName ?? null}
        outputFormat={printingArtifact?.outputName?.split('.').pop() ? `.${printingArtifact.outputName.split('.').pop()}` : null}
        outputSizeLabel={printingOutputSizeLabel}
        printerName={activePrinterProfile?.name ?? 'No printer selected'}
        resinName={printingResinName}
        estimatedPrintTimeLabel={estimatedPrintTimeLabel}
        estimatedVolumeLabel={estimatedVolumeMlLabel}
        canDownload={canDownloadPrintArtifact}
        canSendToPrinter={canSendToPrinter}
        sendBusy={printingSendBusy}
        sendStatusText={printingSendStatusText}
        sendButtonLabel={sendToPrinterButtonLabel}
        showSendTargetPicker={printableConnectedPrinterFleet.length > 1}
        onOpenSendTargetPicker={() => {
          setPrintingTargetPickerMode('post-slice');
          setPrintingTargetPickerOpen(true);
        }}
        onDownload={handleDownloadPrintArtifact}
        onSendToPrinter={handleSendToPrinter}
        onCancelSendToPrinter={handleCancelSendToPrinter}
        canSendToUvTools={getSavedUvToolsSettings().enabled}
        onSendToUvTools={() => {
          const fp = completedSaveDestinationPath;
          if (!fp) return;
          const s = getSavedUvToolsSettings();
          launchExternalProcess(resolveUvToolsExecutablePath(s), fp).catch((err) =>
            console.warn('[UVTools] Failed to launch from printing panel:', err),
          );
        }}
        sliceIntent={completedSliceIntent}
        savedFilePath={completedSaveDestinationPath}
      />
    </>
  );
}
