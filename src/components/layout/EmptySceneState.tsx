"use client";

import React from 'react';
import { FolderInput, Loader2, Sparkles, Upload, Printer, Wrench } from 'lucide-react';
import type { RecentOpenedFileEntry } from '@/features/scene/useSceneCollectionManager';

type EmptySceneStateProps = {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onImportSceneChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDropMeshFiles?: (files: File[]) => void;
  recentOpenedFiles?: RecentOpenedFileEntry[];
  onReopenRecentFile?: (entryId: string) => Promise<boolean> | boolean;
  isLoading?: boolean;
  loadingLabel?: string;
  loadingDetail?: string;
  showFirstTimeOnboarding?: boolean;
  onAddPrinter?: () => void;
  onUseWithoutPrinter?: () => void;
};

function formatRecentOpenedAt(openedAt: number): string {
  const deltaMs = Date.now() - openedAt;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return 'just now';

  const deltaSec = Math.floor(deltaMs / 1000);
  if (deltaSec < 60) return 'just now';

  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;

  const deltaHours = Math.floor(deltaMin / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;

  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays}d ago`;

  return new Date(openedAt).toLocaleString();
}

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

export function EmptySceneState({
  onFileChange,
  onImportSceneChange,
  onDropMeshFiles,
  recentOpenedFiles = [],
  onReopenRecentFile,
  isLoading = false,
  loadingLabel,
  loadingDetail,
  showFirstTimeOnboarding = false,
  onAddPrinter,
  onUseWithoutPrinter,
}: EmptySceneStateProps) {
  const [isDropActive, setIsDropActive] = React.useState(false);
  const [reopeningEntryId, setReopeningEntryId] = React.useState<string | null>(null);
  const [reopenError, setReopenError] = React.useState<string | null>(null);

  const handleDragOver = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropActive(true);
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropActive(false);
  }, []);

  const handleDrop = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropActive(false);

    if (!onDropMeshFiles) return;
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;
    onDropMeshFiles(files);
  }, [onDropMeshFiles]);

  const handleReopenRecentFile = React.useCallback(async (entryId: string) => {
    if (!onReopenRecentFile) return;

    setReopenError(null);
    setReopeningEntryId(entryId);

    try {
      const result = await onReopenRecentFile(entryId);
      if (result === false) {
        setReopenError('Could not reopen this file from cache.');
      }
    } catch {
      setReopenError('Could not reopen this file from cache.');
    } finally {
      setReopeningEntryId(null);
    }
  }, [onReopenRecentFile]);

  const shouldShowFirstTimeOnboarding = showFirstTimeOnboarding && !isLoading;

  return (
    <div className="absolute inset-0 top-14 z-30 flex items-center justify-center pointer-events-none">
      <div className="ui-empty-state pointer-events-auto">
        <div className="mb-4 flex items-center justify-center">
          <div
            className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 65%)',
              background: 'color-mix(in srgb, var(--surface-1), transparent 12%)',
              color: 'var(--text-strong)',
            }}
          >
            <Sparkles className="w-3.5 h-3.5" style={{ color: 'var(--accent)' }} />
            <span>DragonFruit Slicer</span>
          </div>
        </div>

        <h1 className="ui-empty-title">Ready for your next adventure?</h1>
        <p className="ui-empty-text">
          Bring in a mesh or scene to start preparing, analyzing, supporting, and exporting your print.
        </p>

        {isLoading ? (
          <div
            className="rounded-md border px-4 py-5"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 65%)',
              background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
            }}
          >
            <div className="flex items-center justify-center gap-2 text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--accent)' }} />
              <span>{loadingLabel ?? 'Importing your file…'}</span>
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {loadingDetail ?? 'Please hang tight while we prepare your scene.'}
            </div>
            <div
              className="ui-loading-track mt-3 h-2 w-full rounded-full"
              style={{ background: 'color-mix(in srgb, var(--surface-2), black 20%)' }}
            >
              <div
                className="ui-loading-indicator"
                style={{ background: 'linear-gradient(90deg, var(--accent), #ff79c6)' }}
              />
            </div>
          </div>
        ) : shouldShowFirstTimeOnboarding ? (
          <>
            <div className="grid gap-3 grid-cols-1">
              <button
                type="button"
                onClick={onAddPrinter}
                className="group rounded-md border px-3 py-3 text-left transition-colors"
                style={{
                  background: 'var(--primary-button-surface)',
                  borderColor: 'color-mix(in srgb, var(--primary-button-surface), white 16%)',
                  color: 'var(--accent-contrast)',
                }}
              >
                <div className="mb-1 inline-flex items-center gap-1.5 text-sm font-semibold">
                  <Printer className="w-4 h-4" />
                  <span>Add Printer</span>
                </div>
                <div className="text-[11px]" style={{ color: 'color-mix(in srgb, var(--accent-contrast), black 16%)' }}>
                  Open printer library and add one now.
                </div>
              </button>

              <button
                type="button"
                onClick={onUseWithoutPrinter}
                className="group rounded-md border px-3 py-3 text-left transition-colors"
                style={{
                  background: 'var(--secondary-button-surface)',
                  borderColor: 'color-mix(in srgb, var(--secondary-button-surface), white 16%)',
                  color: 'var(--accent-secondary-contrast)',
                }}
              >
                <div className="mb-1 inline-flex items-center gap-1.5 text-sm font-semibold">
                  <Wrench className="w-4 h-4" />
                  <span>Use without Printer</span>
                </div>
                <div className="text-[11px]" style={{ color: 'color-mix(in srgb, var(--accent-secondary-contrast), black 18%)' }}>
                  Keep going without a printer. You can add one later.
                </div>
              </button>
            </div>

            <div className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Add or switch printer anytime from the top bar.
            </div>
          </>
        ) : (
          <>
            <div className={`grid gap-3 ${onImportSceneChange ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <label
                htmlFor="empty-state-stl-file-input"
                className="group cursor-pointer rounded-md border px-3 py-3 text-left transition-colors"
                style={{
                  background: 'var(--primary-button-surface)',
                  borderColor: 'color-mix(in srgb, var(--primary-button-surface), white 16%)',
                }}
              >
                <div className="mb-1 inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--accent-contrast)' }}>
                  <Upload className="w-4 h-4" />
                  <span>Load Mesh</span>
                </div>
                <div className="text-[11px]" style={{ color: 'color-mix(in srgb, var(--accent-contrast), black 16%)' }}>
                  STL now • 3MF coming soon
                </div>
              </label>

              {onImportSceneChange && (
                <label
                  htmlFor="empty-state-scene-file-input"
                  className="group cursor-pointer rounded-md border px-3 py-3 text-left transition-colors"
                  style={{
                    background: 'var(--secondary-button-surface)',
                    borderColor: 'color-mix(in srgb, var(--secondary-button-surface), white 16%)',
                  }}
                >
                  <div className="mb-1 inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--accent-secondary-contrast)' }}>
                    <FolderInput className="w-4 h-4" />
                    <span>Import Scene</span>
                  </div>
                  <div className="text-[11px]" style={{ color: 'color-mix(in srgb, var(--accent-secondary-contrast), black 18%)' }}>
                    LYS now • VOXL coming soon
                  </div>
                </label>
              )}
            </div>

            <div className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Tip: Start with <span style={{ color: 'var(--text-strong)' }}>Load Mesh</span> for clean prints, or <span style={{ color: 'var(--text-strong)' }}>Import Scene</span> to continue an existing setup.
            </div>

            <div className="mt-3">
              <div className="text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>
                Recently opened:
              </div>

              {recentOpenedFiles.length === 0 ? (
                <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  No recent files yet.
                </div>
              ) : (
                <div className="mt-1 grid grid-cols-2 gap-1.5">
                  {recentOpenedFiles.slice().reverse().slice(0, 10).map((entry) => {
                    const sizeLabel = formatBytes(entry.sizeBytes);
                    const isBusy = reopeningEntryId === entry.id;
                    const kindChipStyle = entry.kind === 'scene'
                      ? {
                          color: 'color-mix(in srgb, #fb923c, white 10%)',
                          background: 'color-mix(in srgb, #fb923c, var(--surface-0) 88%)',
                          border: '1px solid color-mix(in srgb, #fb923c, var(--border-subtle) 46%)',
                        }
                      : {
                          color: 'color-mix(in srgb, #a78bfa, white 14%)',
                          background: 'color-mix(in srgb, #a78bfa, var(--surface-0) 88%)',
                          border: '1px solid color-mix(in srgb, #a78bfa, var(--border-subtle) 46%)',
                        };

                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => { void handleReopenRecentFile(entry.id); }}
                        disabled={isBusy || isLoading || !onReopenRecentFile}
                        className="flex w-full items-center justify-between gap-2 rounded-full border px-2 py-1 text-[10px] text-left transition-colors disabled:cursor-not-allowed"
                        style={{
                          color: 'var(--text-strong)',
                          borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 14%)',
                          background: 'color-mix(in srgb, var(--surface-1), transparent 10%)',
                          opacity: isBusy ? 0.65 : 1,
                        }}
                        title={`Reopen ${entry.name}`}
                      >
                        <span className="min-w-0 inline-flex items-center gap-1.5">
                          <span
                            className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                            style={kindChipStyle}
                          >
                            {entry.kind === 'scene' ? 'Scene' : 'Mesh'}
                          </span>
                          <span className="max-w-[140px] truncate" title={entry.name}>
                            {entry.name}
                          </span>
                        </span>
                        <span className="shrink-0" style={{ color: 'var(--text-muted)' }}>
                          {isBusy ? 'loading…' : (sizeLabel ?? formatRecentOpenedAt(entry.openedAt))}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {reopenError && (
                <div className="mt-1 text-[10px]" style={{ color: 'var(--danger)' }}>
                  {reopenError}
                </div>
              )}
            </div>

            <div
              className="mt-3 block rounded-md border border-dashed px-3 py-3 text-center transition-colors"
              style={{
                borderColor: isDropActive ? 'var(--accent)' : 'var(--border-subtle)',
                background: isDropActive
                  ? 'color-mix(in srgb, var(--accent), var(--surface-0) 88%)'
                  : 'color-mix(in srgb, var(--surface-1), transparent 12%)',
              }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="text-[12px] font-semibold" style={{ color: 'var(--text-strong)' }}>
                Drag & drop mesh files here
              </div>
              <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                STL supported now • 3MF coming soon
              </div>
            </div>
          </>
        )}

        <input
          id="empty-state-stl-file-input"
          type="file"
          accept=".stl"
          multiple
          onChange={onFileChange}
          className="hidden"
        />

        {onImportSceneChange && (
          <input
            id="empty-state-scene-file-input"
            type="file"
            accept=".lys"
            onChange={onImportSceneChange}
            className="hidden"
          />
        )}
      </div>
    </div>
  );
}
