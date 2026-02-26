import React from 'react';
import { Download, Printer } from 'lucide-react';
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
  sendProgress: number;
  sendStageText: string | null;
  canPrintNow: boolean;
  printNowBusy: boolean;
  onDownload: () => void;
  onSendToPrinter: () => void;
  onPrintNow: () => void;
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
  sendProgress,
  sendStageText,
  canPrintNow,
  printNowBusy,
  onDownload,
  onSendToPrinter,
  onPrintNow,
}: PrintingPanelProps) {
  const [isExpanded, setIsExpanded] = React.useState(true);
  const clampedProgress = Math.max(0, Math.min(1, sendProgress));
  const showProgress = sendBusy || clampedProgress > 0;

  return (
    <Card className="w-80">
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
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Printer</div>
          <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{printerName}</div>

          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>Resin</div>
          <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{resinName}</div>

          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>Estimated print time</div>
          <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedPrintTimeLabel}</div>

          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>Estimated volume</div>
          <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{estimatedVolumeLabel}</div>
        </div>

        <div className="rounded-md border p-2.5 space-y-1" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Generated file</div>
          <div className="text-xs font-semibold truncate" title={outputName ?? 'No generated file yet'} style={{ color: 'var(--text-strong)' }}>
            {outputName ?? 'No generated file yet'}
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {outputFormat ?? '—'} • {outputSizeLabel}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2">
          <Button
            variant="accent"
            className="!h-9 inline-flex items-center justify-center gap-1.5"
            onClick={onDownload}
            disabled={!canDownload}
            title={canDownload ? 'Download generated print file' : 'Slice first to generate a print file'}
          >
            <Download className="h-4 w-4" />
            Download print file
          </Button>

          <Button
            variant="secondary"
            className="!h-9 inline-flex items-center justify-center gap-1.5"
            onClick={onSendToPrinter}
            disabled={!canSendToPrinter || sendBusy}
            title={canSendToPrinter
              ? 'Send generated print file to connected printer'
              : 'Requires connected printer with supported upload capability and a generated print file'}
          >
            <Printer className="h-4 w-4" />
            {sendBusy ? 'Sending…' : 'Send to printer'}
          </Button>

          <Button
            variant="secondary"
            className="!h-9 inline-flex items-center justify-center gap-1.5"
            onClick={onPrintNow}
            disabled={!canPrintNow || printNowBusy || sendBusy}
            title={canPrintNow
              ? 'Start print immediately on NanoDLP'
              : 'Print Now will appear once NanoDLP finishes processing the uploaded plate'}
          >
            <Printer className="h-4 w-4" />
            {printNowBusy ? 'Starting print…' : 'Print Now'}
          </Button>
        </div>

        {showProgress && (
          <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="mb-1 flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span>{sendStageText ?? (sendBusy ? 'Sending to printer…' : 'Awaiting next action')}</span>
              <span>{Math.round(clampedProgress * 100)}%</span>
            </div>
            <div className="h-1.5 w-full rounded" style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}>
              <div
                className="h-full rounded transition-all duration-200"
                style={{
                  width: `${Math.round(clampedProgress * 100)}%`,
                  background: 'linear-gradient(90deg, var(--accent), #ff79c6)',
                }}
              />
            </div>
          </div>
        )}

        {sendStatusText && (
          <div className="text-[11px] rounded border px-2 py-1" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            {sendStatusText}
          </div>
        )}
      </div>}
    </Card>
  );
}

export default PrintingPanel;
