import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { formatPhaseStep, translateScanPhase } from '@/components/scene/scanProgressMessages';
import { ProgressBar } from '@/components/atoms';

export type ScanProgress = {
  done: number;
  total: number;
  phase?: string;
  phaseNumber?: number;
  phaseCount?: number;
};

/**
 * Determinate progress for the island scan, phase by phase.
 *
 * The scan is a sequence of passes and each one restarts at zero, so a single
 * bar would appear to go backwards. It shows which pass is running out of how
 * many — a count that travels with the report, because the two scan paths have
 * a different number of phases — and fills for the current one.
 *
 * Before the first report it simply sits at zero. An indeterminate animation
 * here was worse than nothing: it reads as the value moving on its own.
 */
export function ScanProgressBar({ progress }: { progress: ScanProgress | null }) {
  const { _ } = useLingui();
  const total = progress?.total ?? 0;
  const percent = total > 0
    ? Math.min(100, Math.max(0, (progress!.done / total) * 100))
    : 0;

  return (
    <div className="mt-3 space-y-1">
      <div className="flex items-baseline justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
        <span>
          {translateScanPhase(progress?.phase, _)}
          {progress?.phaseNumber && progress?.phaseCount
            ? ` · ${formatPhaseStep(progress.phaseNumber, progress.phaseCount, _)}`
            : ''}
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {total > 0 ? `${Math.round(percent)}%` : ''}
        </span>
      </div>

      <ProgressBar
        value={total > 0 ? percent : null}
        ariaLabel={progress?.phase ? translateScanPhase(progress.phase, _) : _(msg`Scan progress`)}
      />

      {total > 0 && (
        <div className="text-[11px]" style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
          {progress!.done.toLocaleString()} / {total.toLocaleString()}
        </div>
      )}
    </div>
  );
}
