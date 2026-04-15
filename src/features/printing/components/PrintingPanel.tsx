import React from 'react';
import { ChevronDown, Download, Printer } from 'lucide-react';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';

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
  sliceIntent?: 'file' | 'upload' | 'print' | 'preview' | null;
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
  sliceIntent = null,
  savedFilePath = null,
}: PrintingPanelProps) {
  const [isExpanded, setIsExpanded] = React.useState(true);

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
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Printing</h2>
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
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Saved to</div>
              <div
                className="text-xs truncate"
                title={savedFilePath ?? outputName ?? ''}
                style={{ color: 'var(--text-strong)', fontFamily: 'monospace' }}
              >
                {savedFilePath ?? outputName ?? '—'}
              </div>
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
              <Button
                variant="secondary"
                className="!h-9 inline-flex items-center justify-center gap-1.5 text-[12px]"
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
            )
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
