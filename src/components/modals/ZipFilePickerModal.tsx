'use client';

import React from 'react';
import { ArchiveRestore, FileArchive, X } from 'lucide-react';
import { getFileExtensionLower } from '@/utils/zipImport';

const MESH_EXTS = new Set(['.stl', '.obj', '.3mf']);
const SCENE_EXTS = new Set(['.voxl', '.lys']);

type ZipFilePickerModalProps = {
  zipName: string;
  files: File[];
  category: 'mesh' | 'scene' | 'mixed';
  defaultSelectionCategory: 'mesh' | 'scene';
  onConfirm: (selected: File[]) => void;
  onCancel: () => void;
};

const EXT_COLORS: Record<string, string> = {
  '.stl': '#60a5fa',
  '.3mf': '#34d399',
  '.obj': '#a78bfa',
  '.voxl': '#baf72e',
  '.lys': '#f59e0b',
};

const EXT_COLORS_LIGHT: Record<string, string> = {
  '.stl': '#1d4ed8',
  '.3mf': '#047857',
  '.obj': '#6d28d9',
  '.voxl': '#3f6212',
  '.lys': '#b45309',
};

const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${Math.round(value)} ${FILE_SIZE_UNITS[unitIndex]}`;
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${FILE_SIZE_UNITS[unitIndex]}`;
}

function getDefaultSelectedIndices(
  files: File[],
  category: 'mesh' | 'scene' | 'mixed',
  defaultSelectionCategory: 'mesh' | 'scene',
): Set<number> {
  if (category !== 'mixed') {
    return new Set(files.map((_, idx) => idx));
  }

  return new Set(
    files.flatMap((file, index) => {
      const ext = getFileExtensionLower(file.name);
      const matchesRequestedCategory = defaultSelectionCategory === 'mesh'
        ? MESH_EXTS.has(ext)
        : SCENE_EXTS.has(ext);
      return matchesRequestedCategory ? [index] : [];
    }),
  );
}

export function ZipFilePickerModal({
  zipName,
  files,
  category,
  defaultSelectionCategory,
  onConfirm,
  onCancel,
}: ZipFilePickerModalProps) {
  const defaultSelectedIndices = React.useMemo(
    () => getDefaultSelectedIndices(files, category, defaultSelectionCategory),
    [category, defaultSelectionCategory, files],
  );

  const [selectedIndices, setSelectedIndices] = React.useState<Set<number>>(() => defaultSelectedIndices);
  const [isLightTheme, setIsLightTheme] = React.useState(false);

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
  }, []);

  const extensionGroups = React.useMemo(() => {
    const groups = new Map<string, { label: string; color: string; indices: number[] }>();

    files.forEach((file, index) => {
      const ext = getFileExtensionLower(file.name);
      const label = (ext.slice(1) || 'file').toUpperCase();
      const existing = groups.get(ext);
      if (existing) {
        existing.indices.push(index);
        return;
      }

      const colorMap = isLightTheme ? EXT_COLORS_LIGHT : EXT_COLORS;
      groups.set(ext, {
        label,
        color: colorMap[ext] ?? 'var(--accent)',
        indices: [index],
      });
    });

    return Array.from(groups.entries()).map(([ext, group]) => ({
      ext,
      ...group,
    }));
  }, [files, isLightTheme]);

  React.useEffect(() => {
    setSelectedIndices(defaultSelectedIndices);
  }, [defaultSelectedIndices]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  const toggleFile = (index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const allSelected = selectedIndices.size === files.length;
  const toggleAll = () => {
    setSelectedIndices(allSelected ? new Set() : new Set(files.map((_, idx) => idx)));
  };

  const toggleExtension = React.useCallback((indices: number[]) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      const areAllSelected = indices.every((index) => next.has(index));

      indices.forEach((index) => {
        if (areAllSelected) {
          next.delete(index);
        } else {
          next.add(index);
        }
      });

      return next;
    });
  }, []);

  const handleConfirm = () => {
    const chosen = files.filter((_, idx) => selectedIndices.has(idx));
    if (chosen.length > 0) onConfirm(chosen);
  };

  const categoryLabel = category === 'mixed'
    ? 'mesh and scene files'
    : (category === 'mesh' ? 'mesh files' : 'scene files');
  const actionLabel = category === 'mixed'
    ? 'Load Mesh / Import Scene'
    : (category === 'mesh' ? 'Load Mesh' : 'Import Scene');
  const defaultSelectionLabel = category === 'mixed'
    ? (defaultSelectionCategory === 'mesh'
        ? 'Matching mesh files are selected by default.'
        : 'Matching scene files are selected by default.')
    : 'All files are selected by default.';

  return (
    <div
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
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
        aria-label="Select files from ZIP archive"
      >
        <div
          className="flex items-center justify-between gap-4 border-b px-5 py-4"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 55%)',
                background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
                color: 'var(--accent)',
              }}
            >
              <FileArchive className="h-4 w-4" />
            </span>
            <div className="min-w-0 pr-2">
              <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                Select Files from ZIP
              </h2>
              <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                DragonFruit found {categoryLabel} in this archive for {actionLabel}
              </p>
            </div>
          </div>

          <button
            type="button"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border transition-colors"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-1)',
              color: 'var(--text-muted)',
            }}
            aria-label="Cancel ZIP import"
            onClick={onCancel}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Choose which files to import from this archive. {defaultSelectionLabel}
          </p>

          <div
            className="rounded-lg border px-3 py-2.5"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-1), var(--surface-0) 30%)',
            }}
          >
            <div className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Archive
            </div>
            <div className="mt-1 truncate text-sm font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
              {zipName}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {selectedIndices.size} of {files.length} selected
              </span>
            </div>
          </div>

          <div className="space-y-1.5 px-1">
            <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Quick select
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-colors"
                style={{
                  borderColor: allSelected
                    ? 'color-mix(in srgb, var(--accent), var(--border-subtle) 35%)'
                    : 'var(--border-subtle)',
                  background: allSelected
                    ? 'color-mix(in srgb, var(--accent), var(--surface-0) 90%)'
                    : 'var(--surface-2)',
                  color: allSelected ? 'var(--accent)' : 'var(--text-muted)',
                }}
                onClick={toggleAll}
                title={allSelected ? 'Deselect all files' : 'Select all files'}
              >
                <span>ALL</span>
                <span style={{ color: allSelected ? 'var(--text-strong)' : 'var(--text-muted)' }}>
                  {selectedIndices.size}/{files.length}
                </span>
              </button>

              {extensionGroups.map((group) => {
                const selectedCount = group.indices.filter((index) => selectedIndices.has(index)).length;
                const allOfTypeSelected = selectedCount === group.indices.length;
                const hasAnySelected = selectedCount > 0;

                return (
                  <button
                    key={group.ext}
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold tracking-wide transition-colors"
                    style={{
                      borderColor: allOfTypeSelected
                        ? `color-mix(in srgb, ${group.color}, var(--border-subtle) 35%)`
                        : 'var(--border-subtle)',
                      background: hasAnySelected
                        ? `color-mix(in srgb, ${group.color}, var(--surface-0) ${isLightTheme ? '84%' : '88%'})`
                        : 'var(--surface-2)',
                      color: allOfTypeSelected ? group.color : 'var(--text-muted)',
                    }}
                    onClick={() => toggleExtension(group.indices)}
                    title={allOfTypeSelected ? `Deselect all ${group.label} files` : `Select all ${group.label} files`}
                  >
                    <span>{group.label}</span>
                    <span style={{ color: hasAnySelected ? 'var(--text-strong)' : 'var(--text-muted)' }}>
                      {selectedCount}/{group.indices.length}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div
            className="max-h-72 overflow-y-auto rounded-lg border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-1), var(--surface-0) 40%)',
            }}
          >
            {files.map((file, index) => {
              const ext = getFileExtensionLower(file.name);
              const extColor = (isLightTheme ? EXT_COLORS_LIGHT[ext] : EXT_COLORS[ext]) ?? 'var(--accent)';
              const isChecked = selectedIndices.has(index);
              const sizeLabel = formatFileSize(file.size);

              return (
                <label
                  key={`${file.name}-${index}`}
                  className="flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 transition-colors"
                  style={{
                    borderColor: index === files.length - 1 ? 'transparent' : 'var(--border-subtle)',
                    background: isChecked
                      ? 'color-mix(in srgb, var(--accent), var(--surface-0) 94%)'
                      : 'transparent',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleFile(index)}
                    className="ui-checkbox shrink-0"
                  />
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide"
                    style={{
                      color: extColor,
                      background: `color-mix(in srgb, ${extColor}, var(--surface-0) ${isLightTheme ? '84%' : '86%'})`,
                      border: `1px solid color-mix(in srgb, ${extColor}, var(--border-subtle) ${isLightTheme ? '38%' : '55%'})`,
                    }}
                  >
                    {ext.slice(1)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs" style={{ color: 'var(--text-strong)' }}>
                    {file.name}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                    {sizeLabel}
                  </span>
                </label>
              );
            })}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
            <button
              type="button"
              className="ui-button ui-button-secondary !h-9 px-3 text-xs"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className="ui-button !h-9 px-3 text-xs inline-flex items-center gap-1.5"
              style={{
                borderColor: selectedIndices.size > 0
                  ? `color-mix(in srgb, ${isLightTheme ? '#16a34a' : '#22c55e'}, var(--border-subtle) 45%)`
                  : 'var(--border-subtle)',
                background: selectedIndices.size > 0
                  ? `color-mix(in srgb, ${isLightTheme ? '#16a34a' : '#22c55e'}, var(--surface-1) 86%)`
                  : 'var(--surface-2)',
                color: selectedIndices.size > 0
                  ? `color-mix(in srgb, ${isLightTheme ? '#16a34a' : '#22c55e'}, var(--text-strong) 18%)`
                  : 'var(--text-muted)',
                opacity: selectedIndices.size > 0 ? 1 : 0.65,
                cursor: selectedIndices.size > 0 ? 'pointer' : 'not-allowed',
              }}
              aria-disabled={selectedIndices.size === 0}
              disabled={selectedIndices.size === 0}
              onClick={handleConfirm}
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
              {selectedIndices.size > 0
                ? `Import ${selectedIndices.size} file${selectedIndices.size !== 1 ? 's' : ''}`
                : 'Import'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
