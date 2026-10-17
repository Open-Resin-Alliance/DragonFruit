import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { ChevronDown, Download, ExternalLink, FolderOpen, Printer, RotateCcw, X } from 'lucide-react';
import { Button, Card, CardHeader, Spinner } from '@/components/atoms';
import { PanelCollapseToggle } from '@/components/atoms/PanelCollapseToggle';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';

type PrintingPanelProps = {
  outputName: string | null;
  outputFormat: string | null;
  outputSizeLabel: string;
  printerName: string;
  resinName: string;
  estimatedPrintTimeLabel: string;
  estimatedVolumeLabel: string;
  canDownload: boolean;
  canSendToPrinter: boolean;
  sendBusy: boolean;
  sendStatusText: string | null;
  sendButtonLabel?: string;
  showSendTargetPicker?: boolean;
  onOpenSendTargetPicker?: () => void;
  onDownload: () => void;
  onSendToPrinter: () => void;
  onCancelSendToPrinter?: () => void;
  canSendToUvTools?: boolean;
  onSendToUvTools?: () => void;
  sliceIntent?: 'file' | 'upload' | 'print' | 'preview' | 'uvtools' | null;
  savedFilePath?: string | null;
};

type Translate = (descriptor: MessageDescriptor) => string;

// Module level so React Compiler cannot rename the placeholder (see AGENTS.md).
function formatExportAsLabel(translate: Translate, format: string): string {
  return translate(msg({ message: `Export as ${format}`, comment: 'Button that saves the sliced file. {format} is its extension, e.g. ".ctb".' }));
}

export function PrintingPanel({
  outputName,
  outputFormat,
  outputSizeLabel,
  printerName,
  resinName,
  estimatedPrintTimeLabel,
  estimatedVolumeLabel,
  canDownload,
  canSendToPrinter,
  sendBusy,
  sendStatusText,
  sendButtonLabel: sendButtonLabelProp,
  showSendTargetPicker = false,
  onOpenSendTargetPicker,
  onDownload,
  onSendToPrinter,
  onCancelSendToPrinter,
  canSendToUvTools = false,
  onSendToUvTools,
  sliceIntent = null,
  savedFilePath = null,
}: PrintingPanelProps) {
  const { _ } = useLingui();
  const sendButtonLabel = sendButtonLabelProp ?? _(msg`Send to Printer`);
  const sendingLabel = _(msg`Sending…`);
  const [isExpanded, setIsExpanded] = useFloatingPanelCollapse(true);
  const [revealingSavedPath, setRevealingSavedPath] = React.useState(false);
  const [revealSavedPathError, setRevealSavedPathError] = React.useState<string | null>(null);

  const isDesktopRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  // The slicer names its output from the scene, in ASCII for the printers that need it; a file
  // the user saved goes by the name they gave it in the save dialog.
  const savedFileName = savedFilePath?.split(/[\\/]/).pop()?.trim() || null;
  const displayedFileName = savedFileName ?? outputName;
  const savedPathForReveal = React.useMemo(() => {
    const trimmed = savedFilePath?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  }, [savedFilePath]);

  const handleRevealSavedPath = React.useCallback(async () => {
    if (!isDesktopRuntime || !savedPathForReveal) return;

    setRevealingSavedPath(true);
    setRevealSavedPathError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('reveal_in_file_manager', { path: savedPathForReveal });
    } catch (error) {
      setRevealSavedPathError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealingSavedPath(false);
    }
  }, [isDesktopRuntime, savedPathForReveal]);

  const showSendActionButton = sendBusy;
  const sendActionTitle = _(msg`Cancel current upload`);
  const sendActionLabel = _(msg`Cancel`);
  const sendActionHandler = onCancelSendToPrinter;

  return (
    <Card className="w-[22rem]">
      <CardHeader
        left={(
          <>
            <PanelCollapseToggle
              expanded={isExpanded}
              onToggle={() => setIsExpanded((prev) => !prev)}
            />
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{_(msg({ message: 'Printing', context: 'Title of the panel with the sliced file and its print actions' }))}</h3>
          </>
        )}
      />

      {isExpanded && <div className="px-3 pb-3 space-y-2.5">
        <div className="rounded-md border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Printer</Trans></div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{printerName}</div>

          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Resin</Trans></div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{resinName}</div>

          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Estimated print time</Trans></div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedPrintTimeLabel}</div>

          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Estimated volume</Trans></div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedVolumeLabel}</div>
        </div>

        <div className="rounded-md border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Generated file</Trans></div>
          <div className="text-sm font-semibold truncate" title={displayedFileName ?? _(msg`No generated file yet`)} style={{ color: 'var(--text-strong)' }}>
            {displayedFileName ?? _(msg`No generated file yet`)}
          </div>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {outputFormat ?? '—'} • {outputSizeLabel}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2">
          {/* Export to file — hidden when this slice was already saved to file */}
          {sliceIntent !== 'file' && (
            <Button
              variant="accent"
              className="!h-9 inline-flex items-center justify-center gap-1.5"
              onClick={onDownload}
              disabled={!canDownload}
              title={canDownload ? _(msg`Download generated print file`) : _(msg`Slice first to generate a print file`)}
            >
              <Download className="h-4 w-4" />
              {outputFormat ? formatExportAsLabel(_, outputFormat) : _(msg`Export as file`)}
            </Button>
          )}

          {/* Saved path — shown when slice intent was 'file' */}
          {sliceIntent === 'file' && (
            <div
              className="rounded-md border p-2.5 space-y-0.5"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
            >
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}><Trans>Saved to</Trans></div>
                  <div
                    className="text-xs whitespace-nowrap overflow-hidden"
                    title={savedFilePath ?? outputName ?? ''}
                    style={{
                      color: 'var(--text-strong)',
                      fontFamily: 'var(--font-geist-mono)',
                      maskImage: 'linear-gradient(to right, #000 0%, #000 calc(100% - 18px), transparent 100%)',
                      WebkitMaskImage: 'linear-gradient(to right, #000 0%, #000 calc(100% - 18px), transparent 100%)',
                    }}
                  >
                    {savedFilePath ?? outputName ?? '—'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { void handleRevealSavedPath(); }}
                  disabled={!isDesktopRuntime || !savedPathForReveal || revealingSavedPath}
                  title={savedPathForReveal ? _(msg`Open file location`) : _(msg`Path unavailable`)}
                  aria-label={_(msg`Open saved file location`)}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-50"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-muted)',
                    background: 'var(--surface-2)',
                  }}
                >
                  {revealingSavedPath ? <Spinner size="sm" /> : <FolderOpen className="h-3.5 w-3.5" />}
                </button>
              </div>
              {revealSavedPathError && (
                <div className="text-[11px]" style={{ color: '#f87171' }}>
                  {revealSavedPathError}
                </div>
              )}
            </div>
          )}

          {/* Upload to printer — hidden when slice was already uploaded/printed */}
          {sliceIntent !== 'upload' && sliceIntent !== 'print' && (
            showSendTargetPicker && onOpenSendTargetPicker ? (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  className="!h-9 flex-1 min-w-0 inline-flex items-center justify-center gap-1.5 text-[12px]"
                  onClick={onSendToPrinter}
                  disabled={!canSendToPrinter || sendBusy}
                  title={canSendToPrinter
                    ? _(msg`Send generated print file to selected printer`)
                    : _(msg`Requires connected printer with supported upload capability and a generated print file`)}
                >
                  <Printer className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate whitespace-nowrap" title={sendBusy ? sendingLabel : sendButtonLabel}>
                    {sendBusy ? sendingLabel : sendButtonLabel}
                  </span>
                </Button>
                {showSendActionButton && (
                  <Button
                    variant="secondary"
                    size="auto"
                    className="!h-9 px-2.5 shrink-0 inline-flex items-center justify-center gap-1"
                    onClick={sendActionHandler}
                    disabled={!sendActionHandler}
                    title={sendActionTitle}
                    aria-label={sendActionTitle}
                  >
                    {sendBusy ? <X className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    <span className="text-[11px]">{sendActionLabel}</span>
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="auto"
                  className="!h-9 w-10 shrink-0 inline-flex items-center justify-center rounded-md"
                  onClick={onOpenSendTargetPicker}
                  disabled={!canSendToPrinter || sendBusy}
                  title={_(msg`Choose upload target printer`)}
                  aria-label={_(msg`Choose upload target printer`)}
                >
                  <ChevronDown className="h-4.5 w-4.5" />
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  className="!h-9 flex-1 inline-flex items-center justify-center gap-1.5 text-[12px]"
                  onClick={onSendToPrinter}
                  disabled={!canSendToPrinter || sendBusy}
                  title={canSendToPrinter
                    ? _(msg`Send generated print file to connected printer`)
                    : _(msg`Requires connected printer with supported upload capability and a generated print file`)}
                >
                  <Printer className="h-4 w-4" />
                  <span className="min-w-0 truncate whitespace-nowrap" title={sendBusy ? sendingLabel : sendButtonLabel}>
                    {sendBusy ? sendingLabel : sendButtonLabel}
                  </span>
                </Button>
                {showSendActionButton && (
                  <Button
                    variant="secondary"
                    size="auto"
                    className="!h-9 px-2.5 shrink-0 inline-flex items-center justify-center gap-1"
                    onClick={sendActionHandler}
                    disabled={!sendActionHandler}
                    title={sendActionTitle}
                    aria-label={sendActionTitle}
                  >
                    {sendBusy ? <X className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    <span className="text-[11px]">{sendActionLabel}</span>
                  </Button>
                )}
              </div>
            )
          )}

          {/* Send to UVTools — shown when file is saved and UVTools integration is enabled */}
          {canSendToUvTools && onSendToUvTools && savedFilePath && (
            <Button
              variant="secondary"
              className="!h-9 inline-flex items-center justify-center gap-1.5 text-[12px]"
              onClick={onSendToUvTools}
            >
              <ExternalLink className="h-4 w-4" />
              <Trans>Send to UVTools</Trans>
            </Button>
          )}
        </div>

        {sendStatusText && (
          <div className="text-xs rounded border px-2 py-1" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            {sendStatusText}
          </div>
        )}
      </div>}
    </Card>
  );
}

export default PrintingPanel;
