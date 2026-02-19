"use client";

import React from 'react';
import { FolderInput, Loader2, Sparkles, Upload } from 'lucide-react';

type EmptySceneStateProps = {
  onFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onImportSceneChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDropMeshFiles?: (files: File[]) => void;
  isLoading?: boolean;
  loadingLabel?: string;
  loadingDetail?: string;
};

export function EmptySceneState({
  onFileChange,
  onImportSceneChange,
  onDropMeshFiles,
  isLoading = false,
  loadingLabel,
  loadingDetail,
}: EmptySceneStateProps) {
  const [isDropActive, setIsDropActive] = React.useState(false);

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
            <span>Dragonfruit Slicer</span>
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
        ) : (
          <>
            <div className={`grid gap-3 ${onImportSceneChange ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <label
                htmlFor="empty-state-stl-file-input"
                className="group cursor-pointer rounded-md border px-3 py-3 text-left transition-colors"
                style={{
                  background: 'var(--accent)',
                  borderColor: 'color-mix(in srgb, var(--accent), white 16%)',
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
                    background: 'var(--accent-secondary)',
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), white 16%)',
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
