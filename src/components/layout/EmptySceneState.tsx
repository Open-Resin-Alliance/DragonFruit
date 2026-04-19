"use client";

import React from 'react';
import { FolderInput, Loader2, Upload, Printer, Wrench } from 'lucide-react';
import type { RecentOpenedFileEntry } from '@/features/scene/useSceneCollectionManager';

const BUILD_CHANNEL = (process.env.NEXT_PUBLIC_BUILD_CHANNEL ?? '').toLowerCase();
const APP_VERSION = (process.env.NEXT_PUBLIC_APP_VERSION ?? '').toLowerCase();
const IS_BETA_BUILD = BUILD_CHANNEL.includes('beta') || APP_VERSION.includes('beta');

type EmptySceneStateProps = {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onLoadMeshClick?: () => void;
  onImportSceneChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onImportSceneClick?: () => void;
  onDropMeshFiles?: (files: File[]) => void | Promise<void>;
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

const TAGLINES = [
  // Adventurous
  "Ready for your next adventure?",
  "The build plate awaits.",
  "What are we printing today?",
  "Time to make something real.",
  "Every great print starts with an empty scene.",
  // Snarky / witty
  "Nothing to see here. Yet.",
  "Your models called. They want to be sliced.",
  "Suspiciously empty in here.",
  "This scene is aggressively unoccupied.",
  "Zero polygons. Infinite potential.",
  "The resin is ready. Are you?",
  "Currently displaying nothing at maximum fidelity.",
  "Idle hands do no slicing.",
  "The build volume misses you.",
  "Drag a file in. The platform is judging you.",
  // Movie / pop-culture references
  "Do or do not. There is no try... oh wait, just click Load Mesh.",
  "In space, no one can hear you slice.",
  "You shall not pass... until you load a model.",
  "I am the one who slices.",
  "With great resin comes great responsibility.",
  "Why so empty?",
  "We're gonna need a bigger build plate.",
  "One does not simply import a mesh... or actually, you just click a button.",
  "I'll be back. (Drop a file and I really will be.)",
  "It's a trap! ...just kidding, drop your STL.",
  "The spice must flow. The resin must cure.",
  "Elementary, my dear user — load a model.",
  "Roads? Where we're printing, we don't need roads.",
  // Engineering/maker flavour
  "Waiting for first layer adhesion... to reality.",
  "No supports needed for an empty scene.",
  "Layer 0 of 0. Living dangerously.",
  "Anti-aliasing: nothing to anti-alias.",
  // Open Resin Alliance
  "Join the Open Resin Alliance!",
  // Origin story
  "Not all slicers are created equal. This one's free!",
];

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

function getFileExtension(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const dotIndex = trimmed.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === trimmed.length - 1) return '';
  return trimmed.slice(dotIndex);
}

function isSupportedDropName(name: string): boolean {
  const ext = getFileExtension(name);
  return ext === '.stl' || ext === '.obj' || ext === '.3mf' || ext === '.voxl' || ext === '.lys';
}

function getDropSupportStateFromDataTransfer(dataTransfer: DataTransfer | null): 'supported' | 'unsupported' | 'unknown' {
  if (!dataTransfer) return 'unknown';

  const fileNames = new Set<string>();

  const directFiles = Array.from(dataTransfer.files ?? []);
  for (const file of directFiles) {
    if (typeof file.name === 'string' && file.name.trim().length > 0) {
      fileNames.add(file.name.trim());
    }
  }

  const items = Array.from(dataTransfer.items ?? []);
  for (const item of items) {
    if (item.kind !== 'file') continue;
    try {
      const file = item.getAsFile();
      if (file && typeof file.name === 'string' && file.name.trim().length > 0) {
        fileNames.add(file.name.trim());
      }

      const webkitEntry = (item as DataTransferItem & {
        webkitGetAsEntry?: () => { isFile?: boolean; name?: string } | null;
      }).webkitGetAsEntry?.();
      if (webkitEntry?.isFile && typeof webkitEntry.name === 'string' && webkitEntry.name.trim().length > 0) {
        fileNames.add(webkitEntry.name.trim());
      }
    } catch {
      // noop
    }
  }

  const maybeExtractNameFromTextPath = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
    if (!firstLine) return;

    let normalized = firstLine;
    if (normalized.startsWith('file://')) {
      try {
        normalized = decodeURIComponent(normalized.replace(/^file:\/\//, ''));
      } catch {
        normalized = normalized.replace(/^file:\/\//, '');
      }
    }

    const parts = normalized.replace(/\\/g, '/').split('/').filter(Boolean);
    const name = parts[parts.length - 1] ?? normalized;
    if (name.trim().length > 0) fileNames.add(name.trim());
  };

  try {
    maybeExtractNameFromTextPath(dataTransfer.getData('text/uri-list'));
    maybeExtractNameFromTextPath(dataTransfer.getData('text/plain'));
  } catch {
    // noop
  }

  if (fileNames.size === 0) return 'unknown';

  const hasSupported = Array.from(fileNames).some((name) => isSupportedDropName(name));
  return hasSupported ? 'supported' : 'unsupported';
}

export function EmptySceneState({
  onFileChange,
  onLoadMeshClick,
  onImportSceneChange,
  onImportSceneClick,
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
  const [tagline] = React.useState(() => TAGLINES[Math.floor(Math.random() * TAGLINES.length)]);
  const [isDropActive, setIsDropActive] = React.useState(false);
  const [isDropUnsupported, setIsDropUnsupported] = React.useState(false);
  const [reopeningEntryId, setReopeningEntryId] = React.useState<string | null>(null);
  const [reopenError, setReopenError] = React.useState<string | null>(null);
  const [isLightTheme, setIsLightTheme] = React.useState(false);
  const dragAutoClearTimeoutRef = React.useRef<number | null>(null);
  const unsupportedDropTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    const check = () => {
      const html = document.documentElement;
      const light =
        html.classList.contains('dragonfruit-light') ||
        html.getAttribute('data-theme') === 'light' ||
        (window.matchMedia('(prefers-color-scheme: light)').matches &&
          !html.classList.contains('dragonfruit-dark'));
      setIsLightTheme(light);
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', check);
    return () => { observer.disconnect(); mq.removeEventListener('change', check); };
  }, [])

  const isLikelyFileDrag = React.useCallback((dataTransfer: DataTransfer | null) => {
    if (!dataTransfer) return false;
    if ((dataTransfer.files?.length ?? 0) > 0) return true;
    if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')) return true;
    if (Array.from(dataTransfer.types ?? []).includes('Files')) return true;
    // Some desktop runtimes (including certain Tauri/webview combos) expose file payloads
    // late in the drag lifecycle; allow the drag to proceed optimistically.
    return true;
  }, []);

  const clearDropActive = React.useCallback(() => {
    setIsDropActive(false);
    setIsDropUnsupported(false);
    if (dragAutoClearTimeoutRef.current !== null) {
      window.clearTimeout(dragAutoClearTimeoutRef.current);
      dragAutoClearTimeoutRef.current = null;
    }
    if (unsupportedDropTimeoutRef.current !== null) {
      window.clearTimeout(unsupportedDropTimeoutRef.current);
      unsupportedDropTimeoutRef.current = null;
    }
  }, []);

  const scheduleDropAutoClear = React.useCallback(() => {
    if (dragAutoClearTimeoutRef.current !== null) {
      window.clearTimeout(dragAutoClearTimeoutRef.current);
    }

    // Some drag-exit paths in desktop webviews can miss `dragleave`.
    // Keep this short timeout refreshed while dragging over the zone so stale highlights clear quickly.
    dragAutoClearTimeoutRef.current = window.setTimeout(() => {
      dragAutoClearTimeoutRef.current = null;
      setIsDropActive(false);
      setIsDropUnsupported(false);
    }, 220);
  }, []);

  React.useEffect(() => {
    const handleWindowDropLikeEnd = () => {
      clearDropActive();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') {
        clearDropActive();
      }
    };

    window.addEventListener('drop', handleWindowDropLikeEnd);
    window.addEventListener('dragend', handleWindowDropLikeEnd);
    window.addEventListener('blur', handleWindowDropLikeEnd);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('drop', handleWindowDropLikeEnd);
      window.removeEventListener('dragend', handleWindowDropLikeEnd);
      window.removeEventListener('blur', handleWindowDropLikeEnd);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (dragAutoClearTimeoutRef.current !== null) {
        window.clearTimeout(dragAutoClearTimeoutRef.current);
        dragAutoClearTimeoutRef.current = null;
      }
      if (unsupportedDropTimeoutRef.current !== null) {
        window.clearTimeout(unsupportedDropTimeoutRef.current);
        unsupportedDropTimeoutRef.current = null;
      }
    };
  }, [clearDropActive]);

  const handleDragEnter = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isLikelyFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const supportState = getDropSupportStateFromDataTransfer(e.dataTransfer);
    if (supportState === 'unsupported') {
      setIsDropUnsupported(true);
    } else if (supportState === 'supported') {
      setIsDropUnsupported(false);
    }
    setIsDropActive(true);
    scheduleDropAutoClear();
  }, [isLikelyFileDrag, scheduleDropAutoClear]);

  const handleDragOver = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!isLikelyFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    const supportState = getDropSupportStateFromDataTransfer(e.dataTransfer);
    if (supportState === 'unsupported') {
      setIsDropUnsupported(true);
      e.dataTransfer.dropEffect = 'none';
    } else {
      if (supportState === 'supported') {
        setIsDropUnsupported(false);
      }
      e.dataTransfer.dropEffect = 'copy';
    }
    setIsDropActive(true);
    scheduleDropAutoClear();
  }, [isLikelyFileDrag, scheduleDropAutoClear]);

  const handleDragLeave = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const relatedTarget = e.relatedTarget as Node | null;
    if (relatedTarget && e.currentTarget.contains(relatedTarget)) return;
    clearDropActive();
  }, [clearDropActive]);

  const handleDrop = React.useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length === 0) return;

    const hasSupportedFiles = files.some((file) => isSupportedDropName(file.name));
    if (!hasSupportedFiles) {
      setIsDropActive(true);
      setIsDropUnsupported(true);
      if (unsupportedDropTimeoutRef.current !== null) {
        window.clearTimeout(unsupportedDropTimeoutRef.current);
      }
      unsupportedDropTimeoutRef.current = window.setTimeout(() => {
        unsupportedDropTimeoutRef.current = null;
        clearDropActive();
      }, 1600);
      return;
    }

    clearDropActive();
    if (!onDropMeshFiles) return;
    void onDropMeshFiles(files);
  }, [clearDropActive, onDropMeshFiles]);

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

  const triggerMeshPicker = React.useCallback(() => {
    if (onLoadMeshClick) {
      onLoadMeshClick();
      return;
    }

    if (typeof document === 'undefined') return;
    const input = document.getElementById('empty-state-stl-file-input') as HTMLInputElement | null;
    input?.click();
  }, [onLoadMeshClick]);

  const triggerScenePicker = React.useCallback(() => {
    if (onImportSceneClick) {
      onImportSceneClick();
      return;
    }

    if (typeof document === 'undefined') return;
    const input = document.getElementById('empty-state-scene-file-input') as HTMLInputElement | null;
    input?.click();
  }, [onImportSceneClick]);

  const shouldShowFirstTimeOnboarding = showFirstTimeOnboarding && !isLoading;

  return (
    <div className="absolute inset-0 top-14 z-30 flex items-center justify-center pointer-events-none">
      <div className="ui-empty-state pointer-events-auto">
        {IS_BETA_BUILD ? (
          <div
            className="mb-2 inline-flex rounded-full border-2 px-3.5 py-1 text-[13px] font-black uppercase tracking-[0.2em]"
            style={{
              color: isLightTheme ? '#9a3412' : '#fdba74',
              borderColor: 'color-mix(in srgb, #f97316, var(--border-subtle) 22%)',
              background: isLightTheme
                ? 'color-mix(in srgb, #f97316, var(--surface-1) 88%)'
                : 'color-mix(in srgb, #f97316, transparent 96%)',
              textShadow: isLightTheme ? 'none' : '0 0 4px color-mix(in srgb, #fb923c, transparent 66%)',
              boxShadow: isLightTheme
                ? 'none'
                : '0 0 0 1px color-mix(in srgb, #f97316, transparent 62%), 0 0 10px color-mix(in srgb, #fb923c, transparent 74%)',
            }}
          >
            BETA VERSION
          </div>
        ) : (
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>
            Empty workspace
          </div>
        )}
        <h1 className="ui-empty-title" suppressHydrationWarning>{tagline}</h1>
        <p className="ui-empty-text" style={{ maxWidth: 560, marginLeft: 'auto', marginRight: 'auto' }}>
          Bring in a mesh or scene to start preparing, analyzing, supporting, and exporting your print.
        </p>

        {isLoading ? (
          <div
            className="rounded-lg border px-4 py-4 text-left"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 65%)',
              background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
            }}
          >
            <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
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
            <div
              className="rounded-lg border p-3 text-left"
              style={{
                borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 8%)',
                background: 'color-mix(in srgb, var(--surface-1), transparent 6%)',
              }}
            >
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Get started
              </div>
              <div className="grid gap-2 grid-cols-1">
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

              <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Add or switch printer anytime from the top bar.
              </div>
            </div>
          </>
        ) : (
          <>
            <div
              className="rounded-lg border p-3 text-left"
              style={{
                borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 8%)',
                background: 'color-mix(in srgb, var(--surface-1), transparent 6%)',
              }}
            >
              <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                Import
              </div>
              <div className={`grid gap-2 ${onImportSceneChange ? 'grid-cols-2' : 'grid-cols-1'}`}>
                <button
                  type="button"
                  onClick={triggerMeshPicker}
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
                    Mesh Files (.stl, .obj, .3mf)
                  </div>
                </button>

                {onImportSceneChange && (
                  <button
                    type="button"
                    onClick={triggerScenePicker}
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
                      Scene Files (.voxl, .lys)
                    </div>
                  </button>
                )}
              </div>

              <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Tip: Start with <span style={{ color: 'var(--text-strong)' }}>Load Mesh</span> for clean prints, or <span style={{ color: 'var(--text-strong)' }}>Import Scene</span> to continue an existing setup.
              </div>
            </div>

            <div
              className="mt-2 rounded-lg border p-3 text-left"
              style={{
                borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 8%)',
                background: 'color-mix(in srgb, var(--surface-1), transparent 6%)',
              }}
            >
              <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span className="font-semibold uppercase tracking-wide">Recent files</span>
                <span
                  className="inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold"
                  style={{
                    color: 'var(--text-muted)',
                    background: 'color-mix(in srgb, var(--surface-2), transparent 26%)',
                    border: '1px solid color-mix(in srgb, var(--border-subtle), transparent 20%)',
                  }}
                >
                  {Math.min(recentOpenedFiles.length, 6)}
                </span>
              </div>

              {recentOpenedFiles.length === 0 ? (
                <div className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  No recent files yet.
                </div>
              ) : (
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {recentOpenedFiles.slice().reverse().slice(0, 6).map((entry) => {
                    const sizeLabel = formatBytes(entry.sizeBytes);
                    const isBusy = reopeningEntryId === entry.id;
                    const kindAccent = entry.kind === 'scene'
                      ? (isLightTheme ? '#c2410c' : '#fb923c')
                      : (isLightTheme ? '#6d28d9' : '#a78bfa');

                    return (
                      <button
                        key={entry.id}
                        type="button"
                        onClick={() => { void handleReopenRecentFile(entry.id); }}
                        disabled={isBusy || isLoading || !onReopenRecentFile}
                        className="flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-[10px] text-left transition-colors disabled:cursor-not-allowed"
                        style={{
                          color: 'var(--text-strong)',
                          borderColor: 'color-mix(in srgb, var(--border-subtle), transparent 14%)',
                          background: 'color-mix(in srgb, var(--surface-1), transparent 8%)',
                          opacity: isBusy ? 0.65 : 1,
                        }}
                        title={`Reopen ${entry.name}`}
                      >
                        <span className="min-w-0 inline-flex items-center gap-1.5">
                          <span
                            className="inline-flex items-center rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                            style={{
                              color: kindAccent,
                              background: `color-mix(in srgb, ${kindAccent}, var(--surface-0) ${isLightTheme ? '84%' : '88%'})`,
                              border: `1px solid color-mix(in srgb, ${kindAccent}, var(--border-subtle) ${isLightTheme ? '38%' : '46%'})`,
                            }}
                          >
                            {entry.kind === 'scene' ? 'Scene' : 'Mesh'}
                          </span>
                          <span className="min-w-0">
                            <span className="block max-w-[132px] truncate text-[10px] leading-tight" title={entry.name}>
                              {entry.name}
                            </span>
                            <span className="block text-[9px]" style={{ color: 'var(--text-muted)' }}>
                              last opened {formatRecentOpenedAt(entry.openedAt)}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                          {isBusy ? 'loading…' : (sizeLabel ?? 'cached')}
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

              <div
                className="mt-2 block min-h-[92px] rounded-md border border-dashed px-4 py-3 transition-colors"
                style={{
                  borderColor: isDropActive
                    ? (isDropUnsupported ? 'var(--danger)' : 'var(--accent)')
                    : 'var(--border-subtle)',
                  background: isDropActive
                    ? (isDropUnsupported
                      ? 'color-mix(in srgb, var(--danger), var(--surface-0) 88%)'
                      : 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)')
                    : 'color-mix(in srgb, var(--surface-1), transparent 16%)',
                }}
                onDragOver={handleDragOver}
                onDragEnter={handleDragEnter}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <div className="flex min-h-[64px] items-center justify-between gap-3">
                  <div className="min-w-0 inline-flex items-center gap-2">
                    <Upload className="h-4 w-4" style={{ color: isDropUnsupported ? 'var(--danger)' : 'var(--accent)' }} />
                    <span className="truncate text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                      {isDropUnsupported ? 'Unsupported File Type' : 'Drop supported files'}
                    </span>
                  </div>
                  <span
                    className="shrink-0 rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
                    style={{
                      color: isDropUnsupported ? 'var(--danger)' : 'var(--accent)',
                      background: isDropUnsupported
                        ? 'color-mix(in srgb, var(--danger), var(--surface-0) 84%)'
                        : 'color-mix(in srgb, var(--accent), var(--surface-0) 86%)',
                      border: isDropUnsupported
                        ? '1px solid color-mix(in srgb, var(--danger), var(--border-subtle) 48%)'
                        : '1px solid color-mix(in srgb, var(--accent), var(--border-subtle) 56%)',
                    }}
                  >
                    STL • OBJ • 3MF • VOXL • LYS
                  </span>
                </div>
                {isDropUnsupported && (
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
                    Unsupported format detected. Please drop STL, OBJ, 3MF, VOXL, or LYS files.
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        <input
          id="empty-state-stl-file-input"
          type="file"
          accept=".stl,.obj,.3mf,.zip"
          multiple
          onChange={onFileChange}
          className="hidden"
        />

        {onImportSceneChange && (
          <input
            id="empty-state-scene-file-input"
            type="file"
            accept=".voxl,.lys,.zip"
            multiple
            onChange={onImportSceneChange}
            className="hidden"
          />
        )}
      </div>
    </div>
  );
}
