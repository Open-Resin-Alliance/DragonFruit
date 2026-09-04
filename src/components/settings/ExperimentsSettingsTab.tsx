'use client';

import React from 'react';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { createPortal } from 'react-dom';
import { AlertTriangle, FlaskConical } from 'lucide-react';
import {
  getExperimentDefinitions,
  isExperimentEnabled,
  setExperimentEnabled,
  subscribeToExperiments,
} from '@/features/experiments/experimentsRegistry';

function getInitialEnabledState(): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const definition of getExperimentDefinitions()) {
    state[definition.id] = isExperimentEnabled(definition.id);
  }
  return state;
}

type ExperimentsDisclaimerProps = {
  onAcknowledge: () => void;
  onExit: () => void;
};

/**
 * ORA disclaimer shown as a gate before the Experiments tab content. Rendered
 * via a portal to document.body so it escapes the settings panel's transient
 * entry animation transform (which would otherwise offset a fixed overlay).
 */
function ExperimentsDisclaimer({ onAcknowledge, onExit }: ExperimentsDisclaimerProps) {
  useEscapeToClose(true, onExit);

  return (
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onExit();
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
        aria-label="Experiments disclaimer"
      >
        <div className="flex items-center gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
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
              <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                Experimental Features
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                Use at your own risk.
              </p>
            </div>
          </div>

        </div>

        <div className="space-y-4 p-5">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Experiments are early-access features still under active development. They are provided &quot;as is&quot; without any warranty, and without guarantee of correctness, reliability, or compatibility.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            The Open Resin Alliance and its contributors accept no responsibility or liability for any loss, damage, or data loss arising from the use of experimental features.
          </p>
          <p className="text-xs leading-relaxed" style={{ color: '#fca5a5', fontWeight: 600 }}>
            Enable and use them at your own risk.
          </p>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
              onClick={onExit}
            >
              Take me back!
            </button>
            <button
              type="button"
              className="ui-button !h-9 w-full px-3 text-xs inline-flex items-center justify-center gap-1.5"
              style={{
                borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                color: '#fde68a',
              }}
              onClick={onAcknowledge}
            >
              I understand
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Module-level so the disclaimer is shown until acknowledged with I understand;
// Take me back keeps it for next entry, so it can reappear within the same launch.
let disclaimerSeenThisLaunch = false;

export function ExperimentsSettingsTab({ onExit }: { onExit: () => void }) {
  const [enabledState, setEnabledState] = React.useState<Record<string, boolean>>(() => getInitialEnabledState());
  const [showDisclaimer, setShowDisclaimer] = React.useState(false);

  const handleToggle = React.useCallback((id: string, enabled: boolean) => {
    setExperimentEnabled(id, enabled);
  }, []);

  React.useEffect(() => {
    // Show the ORA disclaimer if not yet acknowledged this launch.
    // Only I understand marks it as seen — Take me back keeps it for next entry.
    if (!disclaimerSeenThisLaunch) {
      setShowDisclaimer(true);
    }
  }, []);

  React.useEffect(() => {
    return subscribeToExperiments(() => {
      setEnabledState(getInitialEnabledState());
    });
  }, []);

  if (showDisclaimer) {
    return typeof document === 'undefined'
      ? null
      : createPortal(
          <ExperimentsDisclaimer
            onAcknowledge={() => {
              disclaimerSeenThisLaunch = true;
              setShowDisclaimer(false);
            }}
            onExit={() => {
              // Keep disclaimer for next entry — don't mark as seen
              setShowDisclaimer(false);
              onExit();
            }}
          />,
          document.body,
        );
  }

  const experiments = getExperimentDefinitions();

  return (
    <div className="space-y-3">
      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}>
        <div className="flex items-start gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}>
            <FlaskConical className="h-4 w-4" style={{ color: 'var(--accent-secondary)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Experiments</h3>
            <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
              Early-access features that are still in testing. They may change or disappear without notice.
            </p>
          </div>
        </div>
      </div>

      {experiments.length === 0 ? (
        <div className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-muted)' }}>
          No experiments are available in this build.
        </div>
      ) : (
        experiments.map((experiment) => {
          const enabled = enabledState[experiment.id] ?? experiment.defaultEnabled;
          return (
            <div
              key={experiment.id}
              className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-3"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
            >
              <div className="min-w-0 flex-1">
                <span className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{experiment.name}</span>
                <div className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>{experiment.description}</div>
              </div>
              <button
                type="button"
                onClick={() => handleToggle(experiment.id, !enabled)}
                className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors shrink-0"
                aria-pressed={enabled}
                style={enabled
                  ? {
                      borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                      background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                      color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
                    }
                  : {
                      borderColor: 'var(--border-subtle)',
                      background: 'var(--surface-1)',
                      color: 'var(--text-muted)',
                    }}
              >
                {enabled ? 'ON' : 'OFF'}
              </button>
            </div>
          );
        })
      )}

      <div className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
        Experiment changes apply after you restart DragonFruit or reload the window.
      </div>
    </div>
  );
}
