"use client";

import React from 'react';
import { Card, CardHeader, IconButton } from '@/components/atoms';
import { useFloatingPanelCollapse } from '@/components/layout/FloatingPanelStack';
import type { UseIslandsReturn } from '@/volumeAnalysis/Islands/useIslands';
import { runAutoPlace } from '@/supports/autoSupport';
import { getSettings } from '@/supports/Settings/state';

const SECTION_CARD: React.CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-1)',
};

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-center" style={{ color: 'var(--text-strong)' }}>
      {title}
    </div>
  );
}

interface AutoSupportPanelProps {
  islands: UseIslandsReturn;
  hasGeometry: boolean;
  activeModelId?: string;
}

interface LogEntry {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'warning' | 'error';
}

let logId = 0;

export function AutoSupportPanel({ islands, hasGeometry, activeModelId }: AutoSupportPanelProps) {
  const [expanded, setExpanded] = useFloatingPanelCollapse(true);
  const [busy, setBusy] = React.useState(false);
  const [logs, setLogs] = React.useState<LogEntry[]>([]);

  const addLog = React.useCallback((text: string, kind: LogEntry['kind'] = 'info') => {
    setLogs((prev) => {
      const next = [...prev, { id: ++logId, text, kind }];
      return next.length > 50 ? next.slice(-50) : next;
    });
  }, []);

  const handleRun = React.useCallback(() => {
    if (!activeModelId || busy) return;
    setBusy(true);
    setLogs([]);
    addLog(`Starting auto-support for model ${activeModelId}...`);

    const captured: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
      originalLog.apply(console, args);
    };

    try {
      const settings = getSettings();
      const islandList = islands.filteredIslands;

      addLog(`${islandList.length} filtered islands (${islands.voxelIslands.length} voxel, ${islands.minimaIslands.length} minima)`);

      if (islandList.length === 0) {
        addLog('No islands to process — run island scan first.', 'warning');
        setBusy(false);
        console.log = originalLog;
        return;
      }

      if (!settings.autoSupport.enabled) {
        addLog('Auto-support is disabled in settings.', 'warning');
        setBusy(false);
        console.log = originalLog;
        return;
      }

      const result = runAutoPlace(
        islandList,
        activeModelId,
        undefined,
        settings.autoSupport,
      );

      for (const entry of captured) {
        if (entry.startsWith('[AutoSupport]')) {
          addLog(entry.replace('[AutoSupport] ', ''), 'info');
        }
      }

      if (result.changed) {
        addLog(
          `Done: ${result.placedTrunks} trunks, ${result.placedAnchors} anchors, ${result.placedBranches} branches, ${result.placedLeaves} leaves.`,
          'success',
        );
        if (result.rejectedCandidates > 0) {
          addLog(`${result.rejectedCandidates} candidates rejected.`, 'warning');
        }
      } else {
        addLog(result.message, 'warning');
      }
    } catch (err) {
      addLog(`Error: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      console.log = originalLog;
      setBusy(false);
    }
  }, [activeModelId, busy, islands.filteredIslands, islands.voxelIslands.length, islands.minimaIslands.length, addLog]);

  const canRun = hasGeometry && !!activeModelId && !busy && !islands.scanning;

  return (
    <Card>
      <CardHeader
        left={(
          <>
            <IconButton
              onClick={() => setExpanded(!expanded)}
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
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Auto Support</h3>
          </>
        )}
        hideDivider={!expanded}
      />

      {expanded && (
        <div className="px-2.5 pb-3 space-y-2.5">
          {/* Status card */}
          <div className="rounded-md border p-2" style={SECTION_CARD}>
            <SectionHeader title="Scan Summary" />
            <div className="grid grid-cols-3 gap-2">
              {([
                { label: 'Voxel', count: islands.voxelIslands.length },
                { label: 'Minima', count: islands.minimaIslands.length },
                { label: 'Filtered', count: islands.filteredIslands.length },
              ]).map((s) => (
                <div key={s.label} className="text-center min-w-0">
                  <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    {s.label}
                  </div>
                  <div
                    className="text-sm font-bold"
                    style={{ color: s.label === 'Filtered' ? 'var(--accent)' : 'var(--text-strong)' }}
                  >
                    {islands.scanning ? '…' : s.count}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Run button */}
          <button
            type="button"
            onClick={() => { void handleRun(); }}
            disabled={!canRun}
            className="ui-button w-full !h-8 text-[11px] disabled:opacity-50"
            style={{
              borderColor: 'var(--accent)',
              background: 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
              color: 'var(--accent)',
            }}
          >
            {busy
              ? 'Running…'
              : `Run Auto-Support${canRun ? ` (${islands.filteredIslands.length} islands)` : ''}`}
          </button>

          {/* Log area */}
          {logs.length > 0 && (
            <div className="rounded-md border p-2" style={SECTION_CARD}>
              <SectionHeader title="Log" />
              <div
                className="rounded overflow-y-auto max-h-[160px]"
                style={{
                  background: 'color-mix(in srgb, var(--surface-0), black 8%)',
                }}
              >
                <div className="p-1.5 space-y-0.5 font-mono text-[10px] leading-relaxed">
                  {logs.map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        color:
                          entry.kind === 'error'
                            ? '#f87171'
                            : entry.kind === 'warning'
                              ? '#f59e0b'
                              : entry.kind === 'success'
                                ? '#34d399'
                                : 'var(--text-muted)',
                      }}
                    >
                      {entry.text}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!hasGeometry && (
            <div className="text-[10px] italic text-center" style={{ color: 'var(--text-muted)' }}>
              Load a model and scan for islands.
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
