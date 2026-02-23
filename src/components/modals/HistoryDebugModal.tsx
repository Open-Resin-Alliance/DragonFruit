'use client';

import React from 'react';
import { X } from 'lucide-react';
import type { HistoryDebugEvent } from '@/history/types';

type HistoryDebugModalProps = {
  isOpen: boolean;
  onClose: () => void;
  historyDebugEvents: HistoryDebugEvent[];
  historyStackCounts: { undo: number; redo: number };
  selectedPreviewEventId: number | null;
  isPreviewActive: boolean;
  onJumpToEvent: (event: HistoryDebugEvent) => void;
  onCancelPreview: () => void;
  onClearEventLog: () => void;
  onClearUndoRedoStacks: () => void;
  onClearAll: () => void;
};

export function HistoryDebugModal({
  isOpen,
  onClose,
  historyDebugEvents,
  historyStackCounts,
  selectedPreviewEventId,
  isPreviewActive,
  onJumpToEvent,
  onCancelPreview,
  onClearEventLog,
  onClearUndoRedoStacks,
  onClearAll,
}: HistoryDebugModalProps) {
  const historyDebugEventsNewestFirst = React.useMemo(
    () => [...historyDebugEvents].reverse(),
    [historyDebugEvents],
  );

  const formatHistoryDebugTimestamp = React.useCallback((ts: number) => {
    try {
      return new Date(ts).toLocaleTimeString();
    } catch {
      return String(ts);
    }
  }, []);

  const formatHistoryDebugKind = React.useCallback((kind: HistoryDebugEvent['kind']) => {
    return kind.replaceAll('-', ' ').replace(/\b\w/g, (m) => m.toUpperCase());
  }, []);

  const getHistoryDebugEventVisual = React.useCallback((kind: HistoryDebugEvent['kind']) => {
    switch (kind) {
      case 'push':
        return {
          dot: 'var(--accent)',
          badgeBg: 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)',
          badgeBorder: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)',
          badgeText: 'var(--text-strong)',
          rowBorder: 'color-mix(in srgb, var(--accent), var(--border-subtle) 68%)',
        };
      case 'undo':
        return {
          dot: '#fbbf24',
          badgeBg: 'color-mix(in srgb, #fbbf24, var(--surface-0) 90%)',
          badgeBorder: 'color-mix(in srgb, #fbbf24, var(--border-subtle) 52%)',
          badgeText: 'var(--text-strong)',
          rowBorder: 'color-mix(in srgb, #fbbf24, var(--border-subtle) 72%)',
        };
      case 'redo':
        return {
          dot: '#60a5fa',
          badgeBg: 'color-mix(in srgb, #60a5fa, var(--surface-0) 90%)',
          badgeBorder: 'color-mix(in srgb, #60a5fa, var(--border-subtle) 52%)',
          badgeText: 'var(--text-strong)',
          rowBorder: 'color-mix(in srgb, #60a5fa, var(--border-subtle) 72%)',
        };
      case 'undo-empty':
      case 'redo-empty':
        return {
          dot: 'var(--text-muted)',
          badgeBg: 'color-mix(in srgb, var(--surface-2), var(--surface-0) 45%)',
          badgeBorder: 'var(--border-subtle)',
          badgeText: 'var(--text-muted)',
          rowBorder: 'var(--border-subtle)',
        };
      case 'undo-handler-missing':
      case 'redo-handler-missing':
        return {
          dot: '#fb7185',
          badgeBg: 'color-mix(in srgb, #fb7185, var(--surface-0) 90%)',
          badgeBorder: 'color-mix(in srgb, #fb7185, var(--border-subtle) 50%)',
          badgeText: 'var(--text-strong)',
          rowBorder: 'color-mix(in srgb, #fb7185, var(--border-subtle) 70%)',
        };
      case 'clear-history':
      case 'clear-debug-log':
      default:
        return {
          dot: '#a78bfa',
          badgeBg: 'color-mix(in srgb, #a78bfa, var(--surface-0) 90%)',
          badgeBorder: 'color-mix(in srgb, #a78bfa, var(--border-subtle) 50%)',
          badgeText: 'var(--text-strong)',
          rowBorder: 'color-mix(in srgb, #a78bfa, var(--border-subtle) 72%)',
        };
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="w-full max-w-5xl max-h-[88vh] overflow-hidden rounded-xl border shadow-2xl"
        style={{
          background: 'var(--surface-0)',
          borderColor: 'var(--border-subtle)',
          boxShadow: '0 28px 64px rgba(0,0,0,0.48)',
        }}
        role="dialog"
        aria-modal="true"
        aria-label="History Debug"
      >
        <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <div>
            <div className="text-base font-semibold" style={{ color: 'var(--text-strong)' }}>
              History Debug Log
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Hotkey: Ctrl+Shift+C
            </div>
          </div>

          <button
            type="button"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md border transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
            aria-label="Close history debug"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <span className="rounded-full border px-2 py-1 text-[11px] font-semibold" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            Undo Stack: {historyStackCounts.undo}
          </span>
          <span className="rounded-full border px-2 py-1 text-[11px] font-semibold" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            Redo Stack: {historyStackCounts.redo}
          </span>
          <span className="rounded-full border px-2 py-1 text-[11px] font-semibold" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            Events: {historyDebugEvents.length}
          </span>

          <div className="ml-auto flex flex-wrap gap-2">
            {isPreviewActive && (
              <button
                type="button"
                className="h-8 inline-flex items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors"
                style={{
                  borderColor: 'color-mix(in srgb, #fbbf24, var(--border-subtle) 55%)',
                  background: 'color-mix(in srgb, #fbbf24, var(--surface-1) 92%)',
                  color: 'var(--text-strong)',
                }}
                onClick={onCancelPreview}
              >
                Cancel Preview
              </button>
            )}
            <button
              type="button"
              className="h-8 inline-flex items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-1)',
                color: 'var(--text-muted)',
              }}
              onClick={onClearEventLog}
            >
              Clear Event Log
            </button>
            <button
              type="button"
              className="h-8 inline-flex items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'var(--surface-1)',
                color: 'var(--text-muted)',
              }}
              onClick={onClearUndoRedoStacks}
            >
              Clear Undo/Redo Stacks
            </button>
            <button
              type="button"
              className="h-8 inline-flex items-center justify-center rounded-md border px-3 text-xs font-semibold transition-colors"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 92%)',
                color: 'var(--text-strong)',
              }}
              onClick={onClearAll}
            >
              Clear All
            </button>
          </div>
        </div>

        <div className="max-h-[60vh] overflow-y-auto custom-scrollbar px-4 py-3">
          {historyDebugEventsNewestFirst.length === 0 ? (
            <div className="rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
              No history events yet.
            </div>
          ) : (
            <div className="space-y-1.5">
              {historyDebugEventsNewestFirst.map((event, index) => {
                const visual = getHistoryDebugEventVisual(event.kind);
                const isLast = index === historyDebugEventsNewestFirst.length - 1;
                const isSelectedPreview = selectedPreviewEventId === event.id;

                return (
                  <div key={event.id} className="relative pl-7">
                    {!isLast && (
                      <div
                        className="absolute left-[10px] top-5 bottom-[-10px] w-px"
                        style={{
                          background: 'color-mix(in srgb, var(--border-subtle), transparent 10%)',
                        }}
                      />
                    )}

                    <div
                      className="absolute left-0 top-2.5 h-5 w-5 rounded-full border"
                      style={{
                        borderColor: visual.badgeBorder,
                        background: 'var(--surface-0)',
                      }}
                    >
                      <div
                        className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                        style={{ background: visual.dot }}
                      />
                    </div>

                    <div
                      className="cursor-pointer rounded-lg border px-2.5 py-1.5 transition-colors"
                      style={{
                        borderColor: isSelectedPreview
                          ? 'color-mix(in srgb, var(--accent), var(--border-subtle) 40%)'
                          : visual.rowBorder,
                        background: 'color-mix(in srgb, var(--surface-1), black 8%)',
                      }}
                      onClick={() => onJumpToEvent(event)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          onJumpToEvent(event);
                        }
                      }}
                    >
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] leading-tight">
                        <span
                          className="rounded-full border px-2 py-0.5 font-semibold"
                          style={{
                            borderColor: visual.badgeBorder,
                            background: visual.badgeBg,
                            color: visual.badgeText,
                          }}
                        >
                          {formatHistoryDebugKind(event.kind)}
                        </span>
                        <span style={{ color: 'var(--text-muted)' }}>#{event.id}</span>
                        <span style={{ color: 'var(--text-muted)' }}>{formatHistoryDebugTimestamp(event.timestamp)}</span>
                        {isSelectedPreview && (
                          <span className="rounded-full border px-1.5 py-0 text-[10px] font-semibold" style={{ borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 45%)', color: 'var(--accent)' }}>
                            Preview
                          </span>
                        )}
                      </div>

                      {(event.actionType || event.actionDescription) ? (
                        <div className="mt-1 text-xs leading-tight" style={{ color: 'var(--text-strong)' }}>
                          <span className="font-semibold">{event.actionDescription || event.actionType}</span>
                          {event.actionDescription && event.actionType ? (
                            <span style={{ color: 'var(--text-muted)' }}> · {event.actionType}</span>
                          ) : null}
                        </div>
                      ) : (
                        <div className="mt-1 text-xs leading-tight" style={{ color: 'var(--text-muted)' }}>
                          No action payload attached
                        </div>
                      )}

                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
                          Undo: {event.undoCount}
                        </span>
                        <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
                          Redo: {event.redoCount}
                        </span>
                        <span className="rounded border px-1.5 py-0.5" style={{ borderColor: 'var(--border-subtle)' }}>
                          Jump
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
