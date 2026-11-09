import * as React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import { Button, IconChip, Spinner, cn } from '@/components/atoms';

/** One phase of a surfacing run: the engine's stable code and its 1-based position. */
export type SurfacingPhase = { name: string; index: number };

/** A surfacing pass in flight: when it started and the phases the engine has announced. */
export type SurfacingProgressState = {
  startedAt: number;
  phase: SurfacingPhase | null;
  phases: SurfacingPhase[];
};

/**
 * One card under the progress bar: a consequence of the pass the user should know before it lands.
 *
 * `warn` is for something the pass costs them — a surface that is rebuilt rather than preserved, a
 * model it may decline — and `info` for how it behaves. The body is built by the caller with its own
 * `<Trans>`, so each card is one message rather than fragments joined at render time.
 */
export type SurfacingNotice = {
  tone: 'warn' | 'info';
  body: React.ReactNode;
};

/**
 * What tells one surfacing pass's dialog from another's.
 *
 * Both resamplers — shrinkwrap (Remesh) and the tetrahedral mode — run for tens of seconds on a
 * large model and announce their phases the same way, so they share this dialog and differ only in
 * the words and the accent, passed here. A phase code the presentation does not know falls back to
 * the raw code rather than rendering blank.
 */
export type SurfacingProgressPresentation = {
  /** Heading of the dialog, e.g. `Remesh`. */
  title: string;
  /** One line under the heading. */
  subtitle: string;
  /** Accessible name for the dialog. */
  ariaLabel: string;
  /** Accessible name for the progress bar. */
  progressAriaLabel: string;
  /** Chip icon. */
  icon: LucideIcon;
  /** Bar and icon accent colour. */
  accent: string;
  /** A phase code to its translated label; an unknown code falls back to the code. */
  phaseLabel: (name: string | undefined) => string;
  /** How full the bar is, 0..1, from the 1-based phase index the engine reports. */
  progressFraction: (phaseIndex: number | undefined) => number;
  /** Cards under the progress bar. Both resamplers rebuild the surface, so neither is ever bare. */
  notices: SurfacingNotice[];
};

/** `0:04.2`, which is a duration a person reads at a glance. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/**
 * The in-flight surfacing pass: a progress bar over the phase the engine is on, how long the run
 * has been going, and the one way out — a Stop that lands at the next phase boundary. The words and
 * the accent come from the caller's presentation, so Remesh and the tetrahedral mode read the same
 * without a second dialog.
 */
export function SurfacingProgressModal({
  state,
  cancelling,
  onStop,
  presentation,
}: {
  state: SurfacingProgressState;
  cancelling: boolean;
  /** Presentation of the running pass. */
  presentation: SurfacingProgressPresentation;
  onStop: () => void;
}) {
  const { _ } = useLingui();
  const [tick, setTick] = React.useState(0);
  const { accent, notices } = presentation;

  // The elapsed clock only runs while the dialog is mounted, which is exactly while a pass is.
  React.useEffect(() => {
    const timer = window.setInterval(() => setTick(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, []);

  const phaseLabel = cancelling
    ? _(msg`Stopping at the end of this step…`)
    : presentation.phaseLabel(state.phase?.name);
  const fraction = state.phase ? presentation.progressFraction(state.phase.index) : 0;
  const percent = Math.round(fraction * 100);

  return (
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3">
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 24px 46px rgba(0,0,0,0.42)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label={presentation.ariaLabel}
      >
        <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex min-w-0 items-center gap-3">
            <IconChip
              size="lg"
              icon={presentation.icon}
              style={{
                borderColor: `color-mix(in srgb, ${accent}, var(--border-subtle) 45%)`,
                background: `color-mix(in srgb, ${accent}, var(--surface-1) 88%)`,
                color: accent,
              }}
            />

            <div className="min-w-0 pr-2">
              <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                {presentation.title}
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                {presentation.subtitle}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4 p-5">
          <div className="space-y-3">
            <div className="mx-1.5 flex items-baseline justify-between gap-3">
              <div className="min-w-0 truncate text-[11px] font-medium" style={{ color: 'var(--text-strong)' }}>
                {phaseLabel}
              </div>
              <div className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                {formatElapsed(tick - state.startedAt)}
              </div>
            </div>

            <div
              className={cn('mx-1.5 h-1.5 overflow-hidden rounded-full', !state.phase && 'ui-loading-track')}
              style={{ background: 'var(--surface-2)' }}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={state.phase ? percent : undefined}
              aria-label={presentation.progressAriaLabel}
            >
              {state.phase ? (
                <div
                  className="h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{ width: `${percent}%`, background: accent }}
                />
              ) : (
                <div className="ui-loading-indicator" style={{ background: accent }} />
              )}
            </div>
          </div>

          <div className="space-y-2">
            {notices.map((notice, index) => {
              const tone = notice.tone === 'warn' ? '#d97706' : '#2563eb';
              return (
                <div
                  key={index}
                  className="rounded-md border px-3 py-2"
                  style={{
                    borderColor: `color-mix(in srgb, ${tone}, var(--border-subtle) 40%)`,
                    background: `color-mix(in srgb, ${tone}, var(--surface-1) 92%)`,
                  }}
                >
                  <div className="flex items-start gap-2">
                    {notice.tone === 'warn' ? (
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: tone }} />
                    ) : (
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: tone }} />
                    )}
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                      {notice.body}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>

          <Button
            variant="secondary"
            className="w-full inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            disabled={cancelling}
            onClick={onStop}
          >
            {cancelling
              ? <><Spinner size="sm" /><Trans>Stopping…</Trans></>
              : <Trans>Stop</Trans>
            }
          </Button>
        </div>
      </div>
    </div>
  );
}
