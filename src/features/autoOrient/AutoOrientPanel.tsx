import React from 'react';
import { Compass, Loader2 } from 'lucide-react';
import { Button, Card, CardHeader, IconButton } from '@/components/ui/primitives';
import type { AutoOrientGoals } from './types';
import type { AutoOrientProgress } from './useAutoOrientManager';

interface AutoOrientPanelProps {
  goals: AutoOrientGoals;
  onGoalsChange: (goals: AutoOrientGoals) => void;
  onRun: () => void;
  onCancel: () => void;
  running: boolean;
  progress: AutoOrientProgress | null;
  /** Number of models that will be oriented (selection, or active fallback). */
  targetCount: number;
  /** Protected-face count on the active model (for the protect-faces goal). */
  protectedFaceCount: number;
  /** Whether face painting is currently active. */
  painting: boolean;
  /** Toggle the face-paint brush on the active model. */
  onTogglePaint: () => void;
  /** Clear the active model's protected mask. */
  onClearPaint: () => void;
}

type GoalKey = keyof AutoOrientGoals;

const GOAL_LABELS: Record<GoalKey, { label: string; hint: string }> = {
  minimizeIslands: { label: 'Minimize supports', hint: 'Fewest unsupported islands (support material)' },
  minimizeHeight: { label: 'Minimize height', hint: 'Lower Z — fewer layers, faster print' },
  minimizeFootprint: { label: 'Minimize footprint', hint: 'Smaller plate area' },
  protectFaces: { label: 'Protect painted faces', hint: 'Keep painted faces pointing up so they stay support-free' },
};

export function AutoOrientPanel({
  goals,
  onGoalsChange,
  onRun,
  onCancel,
  running,
  progress,
  targetCount,
  protectedFaceCount,
  painting,
  onTogglePaint,
  onClearPaint,
}: AutoOrientPanelProps) {
  const [expanded, setExpanded] = React.useState(true);

  const anyGoalEnabled =
    goals.minimizeIslands > 0 || goals.minimizeHeight > 0 || goals.minimizeFootprint > 0;

  const runDisabled = running || !anyGoalEnabled || targetCount === 0;

  const accentCardStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 76%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 95%)',
  };

  const setGoalWeight = React.useCallback(
    (key: GoalKey, weight: number) => {
      onGoalsChange({ ...goals, [key]: weight });
    },
    [goals, onGoalsChange],
  );

  return (
    <Card>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded((prev) => !prev)}
              className="!p-0.5"
              title={expanded ? 'Collapse card' : 'Expand card'}
            >
              <svg
                className="w-3 h-3 transform transition-transform"
                style={{ color: expanded ? 'var(--accent)' : 'var(--text-muted)' }}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                {expanded ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                )}
              </svg>
            </IconButton>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Auto-Orient</h3>
          </>
        )}
        right={(
          <div className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <Compass className="w-3 h-3" style={{ color: 'var(--accent)' }} />
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {targetCount} model{targetCount === 1 ? '' : 's'}
            </span>
          </div>
        )}
      />

      {expanded && (
        <div className="px-2 pb-2 space-y-2 sm:px-2.5 sm:pb-2.5">
          {/* Goals */}
          <div className="rounded-md border p-2 space-y-2" style={accentCardStyle}>
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>Optimize for</div>
            {(Object.keys(GOAL_LABELS) as GoalKey[]).map((key) => {
              const weight = goals[key];
              const { label, hint } = GOAL_LABELS[key];
              const active = weight > 0;
              return (
                <div key={key} className="space-y-0.5" title={hint}>
                  <div className="flex items-center justify-between">
                    <span
                      className="text-[11px]"
                      style={{ color: active ? 'var(--text-strong)' : 'var(--text-muted)' }}
                    >
                      {label}
                    </span>
                    <span className="text-[10px] tabular-nums w-7 text-right" style={{ color: 'var(--text-muted)' }}>
                      {active ? weight.toFixed(2) : 'off'}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={weight}
                    disabled={running}
                    onChange={(e) => setGoalWeight(key, Number(e.target.value))}
                    className="w-full"
                    aria-label={`${label} weight`}
                  />
                </div>
              );
            })}
          </div>

          {/* Protected-face painting (only relevant when the protect goal is on) */}
          {goals.protectFaces > 0 && (
            <div className="rounded-md border p-2 space-y-1.5" style={accentCardStyle}>
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: 'var(--text-strong)' }}>Protected faces</span>
                <span className="text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                  {protectedFaceCount} face{protectedFaceCount === 1 ? '' : 's'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  className="!h-8 text-[11px]"
                  onClick={onTogglePaint}
                  disabled={running}
                >
                  {painting ? 'Done painting' : 'Paint faces'}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="!h-8 text-[11px]"
                  onClick={onClearPaint}
                  disabled={running || protectedFaceCount === 0}
                >
                  Clear
                </Button>
              </div>
              {protectedFaceCount === 0 && (
                <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>
                  Paint the faces you want to keep support-free.
                </div>
              )}
            </div>
          )}

          {/* Run / progress */}
          {running && progress ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span>{progress.currentModelName ? `Scoring ${progress.currentModelName}…` : 'Scoring…'}</span>
                <span className="tabular-nums">{progress.done}/{progress.total}</span>
              </div>
              <div className="h-1.5 w-full rounded-full overflow-hidden" style={{ background: 'var(--surface-2)' }}>
                <div
                  className="h-full rounded-full transition-[width] duration-150"
                  style={{
                    width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                    background: 'var(--accent)',
                  }}
                />
              </div>
              <Button variant="secondary" size="sm" className="w-full" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="accent"
              size="sm"
              className="w-full inline-flex items-center justify-center gap-1.5"
              onClick={onRun}
              disabled={runDisabled}
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Compass className="w-3.5 h-3.5" />}
              Auto-Orient {targetCount > 1 ? `${targetCount} Models` : 'Model'}
            </Button>
          )}

          {targetCount === 0 && (
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>
              Select one or more models to auto-orient.
            </div>
          )}
          {!anyGoalEnabled && targetCount > 0 && (
            <div className="ui-meta" style={{ color: 'var(--text-muted)' }}>
              Set at least one slider above 0.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
