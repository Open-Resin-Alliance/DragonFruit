"use client";

import React from 'react';
import { FolderInput, Loader2, Upload, Printer, Wrench } from 'lucide-react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
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

// Returns null for "just now" (< 60 s), or a translated compact period string for everything else.
// The period is just the quantity+unit, e.g. "5m" — the caller wraps it with "last opened {period} ago".
// NOTE: some locales write a space between number and unit (e.g. "5 min", "3 h").
// Translators control this through their own msgstr for each period string below.
function formatRecentOpenedAt(openedAt: number, translate: (descriptor: MessageDescriptor) => string): string | null {
  const deltaMs = Date.now() - openedAt;
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return null;

  const deltaSec = Math.floor(deltaMs / 1000);
  if (deltaSec < 60) return null;

  // {deltaMin} = number of minutes elapsed (1–59)
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return translate(msg`${deltaMin}m`);

  // {deltaHours} = number of hours elapsed (1–23)
  const deltaHours = Math.floor(deltaMin / 60);
  if (deltaHours < 24) return translate(msg`${deltaHours}h`);

  // {deltaDays} = number of days elapsed (1–6)
  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return translate(msg`${deltaDays}d`);

  return new Date(openedAt).toLocaleDateString();
}

const TAGLINES: MessageDescriptor[] = [
  // Adventurous
  msg`Ready for your next adventure?`,
  msg`The build plate awaits.`,
  msg`What are we printing today?`,
  msg`Time to make something real.`,
  msg`Every great print starts with an empty scene.`,
  // Snarky / witty
  msg`Nothing to see here. Yet.`,
  msg`Your models called. They want to be sliced.`,
  msg`Suspiciously empty in here.`,
  msg`This scene is aggressively unoccupied.`,
  msg`Zero polygons. Infinite potential.`,
  msg`The resin is ready. Are you?`,
  msg`Currently displaying nothing at maximum fidelity.`,
  msg({ message: 'Idle hands do no slicing.', comment: 'Adaptation of the English proverb "Idle hands are the devil\'s workshop".' }),
  msg`The build volume misses you.`,
  msg`Drag a file in. The platform is judging you.`,
  // Movie / pop-culture references
  msg({ message: 'Do or do not. There is no try... oh wait, just click Load Mesh.', comment: 'Paraphrase of Yoda\'s line from Star Wars: The Empire Strikes Back (1980): "Do or do not. There is no try."' }),
  msg({ message: 'In space, no one can hear you slice.', comment: 'Parody of the tagline for Alien (1979): "In space, no one can hear you scream."' }),
  msg({ message: 'You shall not pass... until you load a model.', comment: 'Paraphrase of Gandalf\'s line from The Lord of the Rings: The Fellowship of the Ring (2001): "You shall not pass!"' }),
  msg({ message: 'I am the one who slices.', comment: 'Paraphrase of Walter White\'s line from Breaking Bad, S04E06 "Cornered": "I am the one who knocks."' }),
  msg({ message: 'With great resin comes great responsibility.', comment: 'Paraphrase of the Spider-Man motto, originating in Amazing Fantasy #15 (1962): "With great power comes great responsibility."' }),
  msg({ message: 'Why so empty?', comment: 'Paraphrase of the Joker\'s line from The Dark Knight (2008): "Why so serious?"' }),
  msg({ message: "We're gonna need a bigger build plate.", comment: 'Paraphrase of Chief Brody\'s line from Jaws (1975): "You\'re gonna need a bigger boat."' }),
  msg({ message: 'One does not simply import a mesh... or actually, you just click a button.', comment: 'Paraphrase of Boromir\'s line from The Lord of the Rings: The Fellowship of the Ring (2001): "One does not simply walk into Mordor."' }),
  msg({ message: "I'll be back. (Drop a file and I really will be.)", comment: 'Paraphrase of the Terminator\'s line from The Terminator (1984): "I\'ll be back."' }),
  msg({ message: "It's a trap! ...just kidding, drop your STL.", comment: 'Paraphrase of Admiral Ackbar\'s line from Star Wars: Return of the Jedi (1983): "It\'s a trap!"' }),
  msg({ message: 'The spice must flow. The resin must cure.', comment: 'Paraphrase of "The spice must flow" from Dune (novel by Frank Herbert, 1965; films 1984 and 2021).' }),
  msg({ message: 'Elementary, my dear user — load a model.', comment: 'Paraphrase of "Elementary, my dear Watson", the line associated with Sherlock Holmes (Arthur Conan Doyle stories; multiple film and TV adaptations).' }),
  msg({ message: "Roads? Where we're printing, we don't need roads.", comment: 'Paraphrase of Doc Brown\'s line from Back to the Future (1985): "Roads? Where we\'re going, we don\'t need roads."' }),
  // Engineering/maker flavour
  msg`Waiting for first layer adhesion... to reality.`,
  msg`No supports needed for an empty scene.`,
  msg`Layer 0 of 0. Living dangerously.`,
  msg`Anti-aliasing: nothing to anti-alias.`,
  // Open Resin Alliance
  msg`Join the Open Resin Alliance!`,
  // Origin story
  msg({ message: "Not all slicers are created equal. This one's free!", comment: 'Play on "all men are created equal" from the United States Declaration of Independence (1776).' }),
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
  const { _ } = useLingui();
  const [taglineDescriptor] = React.useState(() => TAGLINES[Math.floor(Math.random() * TAGLINES.length)]);
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
        setReopenError(_(msg`Could not reopen this file from cache.`));
      }
    } catch {
      setReopenError(_(msg`Could not reopen this file from cache.`));
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
            {_(msg({ message: 'BETA VERSION', comment: 'Badge shown in the top of the empty workspace when the app is a beta build. Uppercase label.' }))}
          </div>
        ) : (
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: 'var(--text-muted)' }}>
            {_(msg`Empty workspace`)}
          </div>
        )}
        <h1 className="ui-empty-title" suppressHydrationWarning>{_(taglineDescriptor)}</h1>
        <p className="ui-empty-text" style={{ maxWidth: 560, marginLeft: 'auto', marginRight: 'auto' }}>
          {_(msg`Bring in a mesh or scene to start preparing, analyzing, supporting, and exporting your print.`)}
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
              <span>{loadingLabel ?? _(msg`Importing your file…`)}</span>
            </div>
            <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {loadingDetail ?? _(msg`Please hang tight while we prepare your scene.`)}
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
                {_(msg`Get started`)}
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
                    <span>{_(msg`Add Printer`)}</span>
                  </div>
                  <div className="text-[11px]" style={{ color: 'color-mix(in srgb, var(--accent-contrast), black 16%)' }}>
                    {_(msg`Open printer library and add one now.`)}
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
                    <span>{_(msg`Use without Printer`)}</span>
                  </div>
                  <div className="text-[11px]" style={{ color: 'color-mix(in srgb, var(--accent-secondary-contrast), black 18%)' }}>
                    {_(msg`Keep going without a printer. You can add one later.`)}
                  </div>
                </button>
              </div>

              <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {_(msg`Add or switch printer anytime from the top bar.`)}
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
                {_(msg({ message: 'Import', comment: 'Section header label above the file import buttons. Noun, not imperative verb.' }))}
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
                    <span>{_(msg`Load Mesh`)}</span>
                  </div>
                  <div className="text-[11px]" style={{ color: 'color-mix(in srgb, var(--accent-contrast), black 16%)' }}>
                    {_(msg`Mesh Files (.stl, .obj, .3mf)`)}
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
                      <span>{_(msg`Import Scene`)}</span>
                    </div>
                    <div className="text-[11px]" style={{ color: 'color-mix(in srgb, var(--accent-secondary-contrast), black 18%)' }}>
                      {_(msg`Scene Files (.voxl, .lys)`)}
                    </div>
                  </button>
                )}
              </div>

              <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <Trans comment="Tip shown below the import buttons. <0> wraps the highlighted label 'Load Mesh'; <1> wraps 'Import Scene'. Keep both placeholders in your translation.">Tip: Start with <span style={{ color: 'var(--text-strong)' }}>Load Mesh</span> for clean prints, or <span style={{ color: 'var(--text-strong)' }}>Import Scene</span> to continue an existing setup.</Trans>
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
                <span className="font-semibold uppercase tracking-wide">{_(msg`Recent files`)}</span>
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
                  {_(msg`No recent files yet.`)}
                </div>
              ) : (
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {recentOpenedFiles.slice().reverse().slice(0, 6).map((entry) => {
                    const sizeLabel = formatBytes(entry.sizeBytes);
                    const isBusy = reopeningEntryId === entry.id;
                    const period = formatRecentOpenedAt(entry.openedAt, _);
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
                        title={_(msg`Reopen ${entry.name}`)}
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
                            {entry.kind === 'scene'
                              ? _(msg({ message: 'Scene', comment: 'File type badge on the recent files list. Noun — labels a saved scene file (.voxl, .lys).' }))
                              : _(msg({ message: 'Mesh', comment: 'File type badge on the recent files list. Noun — labels a mesh file (.stl, .obj, .3mf).' }))}
                          </span>
                          <span className="min-w-0">
                            <span className="block max-w-[132px] truncate text-[10px] leading-tight" title={entry.name}>
                              {entry.name}
                            </span>
                            <span className="block text-[9px]" style={{ color: 'var(--text-muted)' }}>
                              {period === null
                                ? _(msg`last opened just now`)
                                : _(msg`last opened ${period} ago`)}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0 text-[9px]" style={{ color: 'var(--text-muted)' }}>
                          {isBusy
                            ? _(msg({ message: 'loading…', comment: 'Shown in place of file size while a recent file is being reopened. Keep it short.' }))
                            : (sizeLabel ?? _(msg({ message: 'cached', comment: 'Shown in place of file size when the file is in cache but its size is unknown. Adjective/state label.' })))}
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
                className="mt-2 block min-h-[32px] rounded-md border border-dashed px-4 py-3 transition-colors"
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
                <div className="flex min-h-[34px] items-center justify-between gap-3">
                  <div className="min-w-0 inline-flex items-center gap-2">
                    <Upload className="h-4 w-4" style={{ color: isDropUnsupported ? 'var(--danger)' : 'var(--accent)' }} />
                    <span className="truncate text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                      {isDropUnsupported ? _(msg`Unsupported File Type`) : _(msg`Drop supported files`)}
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
                    {_(msg`Unsupported format detected. Please drop STL, OBJ, 3MF, VOXL, or LYS files.`)}
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
