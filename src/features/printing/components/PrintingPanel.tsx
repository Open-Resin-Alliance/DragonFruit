import React from 'react';
import { ChevronDown, Download, ExternalLink, FolderOpen, Loader2, Printer, RotateCcw, X } from 'lucide-react';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';
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
  sendButtonLabel = 'Send to Printer',
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
  const [isExpanded, setIsExpanded] = useFloatingPanelCollapse(true);
  const [revealingSavedPath, setRevealingSavedPath] = React.useState(false);
  const [revealSavedPathError, setRevealSavedPathError] = React.useState<string | null>(null);

  const isDesktopRuntime = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
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
  const sendActionTitle = 'Cancel current upload';
  const sendActionLabel = 'Cancel';
  const sendActionHandler = onCancelSendToPrinter;

  return (
    <Card className="w-[22rem]">
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setIsExpanded((prev) => !prev)}
              className="!p-0.5"
              title={isExpanded ? 'Collapse card' : 'Expand card'}
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: isExpanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {isExpanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Printing</h3>
          </>
        )}
      />

      {isExpanded && <div className="px-3 pb-3 space-y-2.5">
        <div className="rounded-md border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Printer</div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{printerName}</div>

          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Resin</div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{resinName}</div>

          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Estimated print time</div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedPrintTimeLabel}</div>

          <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Estimated volume</div>
          <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedVolumeLabel}</div>
        </div>

        <div className="rounded-md border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Generated file</div>
          <div className="text-sm font-semibold truncate" title={outputName ?? 'No generated file yet'} style={{ color: 'var(--text-strong)' }}>
            {outputName ?? 'No generated file yet'}
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
              title={canDownload ? 'Download generated print file' : 'Slice first to generate a print file'}
            >
              <Download className="h-4 w-4" />
              Export as {outputFormat ? `${outputFormat}` : 'file'}
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
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Saved to</div>
                  <div
                    className="text-xs whitespace-nowrap overflow-hidden"
                    title={savedFilePath ?? outputName ?? ''}
                    style={{
                      color: 'var(--text-strong)',
                      fontFamily: 'monospace',
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
                  title={savedPathForReveal ? 'Open file location' : 'Path unavailable'}
                  aria-label="Open saved file location"
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors disabled:opacity-50"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    color: 'var(--text-muted)',
                    background: 'var(--surface-2)',
                  }}
                >
                  {revealingSavedPath ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
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
                    ? 'Send generated print file to selected printer'
                    : 'Requires connected printer with supported upload capability and a generated print file'}
                >
                  <Printer className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 truncate whitespace-nowrap" title={sendBusy ? 'Sending…' : sendButtonLabel}>
                    {sendBusy ? 'Sending…' : sendButtonLabel}
                  </span>
                </Button>
                {showSendActionButton && (
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 px-2.5 shrink-0 inline-flex items-center justify-center gap-1"
                    onClick={sendActionHandler}
                    disabled={!sendActionHandler}
                    title={sendActionTitle}
                    aria-label={sendActionTitle}
                  >
                    {sendBusy ? <X className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    <span className="text-[11px]">{sendActionLabel}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 w-10 shrink-0 inline-flex items-center justify-center rounded-md"
                  onClick={onOpenSendTargetPicker}
                  disabled={!canSendToPrinter || sendBusy}
                  title="Choose upload target printer"
                  aria-label="Choose upload target printer"
                >
                  <ChevronDown className="h-4.5 w-4.5" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="secondary"
                  className="!h-9 flex-1 inline-flex items-center justify-center gap-1.5 text-[12px]"
                  onClick={onSendToPrinter}
                  disabled={!canSendToPrinter || sendBusy}
                  title={canSendToPrinter
                    ? 'Send generated print file to connected printer'
                    : 'Requires connected printer with supported upload capability and a generated print file'}
                >
                  <Printer className="h-4 w-4" />
                  <span className="min-w-0 truncate whitespace-nowrap" title={sendBusy ? 'Sending…' : sendButtonLabel}>
                    {sendBusy ? 'Sending…' : sendButtonLabel}
                  </span>
                </Button>
                {showSendActionButton && (
                  <button
                    type="button"
                    className="ui-button ui-button-secondary !h-9 px-2.5 shrink-0 inline-flex items-center justify-center gap-1"
                    onClick={sendActionHandler}
                    disabled={!sendActionHandler}
                    title={sendActionTitle}
                    aria-label={sendActionTitle}
                  >
                    {sendBusy ? <X className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    <span className="text-[11px]">{sendActionLabel}</span>
                  </button>
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
              Send to UVTools
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
