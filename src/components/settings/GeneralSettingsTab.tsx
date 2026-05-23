'use client';

import React from 'react';
import { Bug, ClipboardCopy, Database, LayoutGrid, RotateCcw } from 'lucide-react';
import type { ImportDefaultsSettings } from '@/features/scene/importDefaultsPreferences';
import {
  FLOATING_LAYOUT_DEBUG_REQUEST_EVENT,
  FLOATING_LAYOUT_STORAGE_KEY,
  type FloatingLayoutDebugRequestDetail,
} from '@/components/layout/floatingLayoutPreferences';

interface GeneralSettingsTabProps {
  floatingLayoutPersistence: boolean;
  onFloatingLayoutPersistenceChange: (enabled: boolean) => void;
  onResetFloatingLayout: () => void;
  debugPrimitivesPanelVisible: boolean;
  onDebugPrimitivesPanelVisibleChange: (enabled: boolean) => void;
  importDefaults: ImportDefaultsSettings;
  onImportDefaultsChange: (next: ImportDefaultsSettings) => void;
}

export function GeneralSettingsTab({
  floatingLayoutPersistence,
  onFloatingLayoutPersistenceChange,
  onResetFloatingLayout,
  debugPrimitivesPanelVisible,
  onDebugPrimitivesPanelVisibleChange,
  importDefaults,
  onImportDefaultsChange,
}: GeneralSettingsTabProps) {
  const [layoutDump, setLayoutDump] = React.useState<string>('');
  const [dumpStatus, setDumpStatus] = React.useState<string | null>(null);
  const rootsLockedByLineRaft = importDefaults.raftBottomMode === 'line';

  const handleDumpCurrentLayout = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const detail: FloatingLayoutDebugRequestDetail = {
      onResult: (snapshot) => {
        setLayoutDump(JSON.stringify(snapshot, null, 2));
        setDumpStatus('Captured current floating layout from runtime state.');
      },
    };

    window.dispatchEvent(new CustomEvent(FLOATING_LAYOUT_DEBUG_REQUEST_EVENT, { detail }));
  }, []);

  const handleDumpSavedLayout = React.useCallback(() => {
    if (typeof window === 'undefined') return;

    const raw = window.localStorage.getItem(FLOATING_LAYOUT_STORAGE_KEY);
    if (!raw) {
      setLayoutDump('');
      setDumpStatus('No saved layout JSON found in local storage.');
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      setLayoutDump(JSON.stringify(parsed, null, 2));
      setDumpStatus('Loaded saved floating layout JSON from local storage.');
    } catch {
      setLayoutDump(raw);
      setDumpStatus('Saved layout was not valid JSON; showing raw payload.');
    }
  }, []);

  const handleCopyDump = React.useCallback(async () => {
    if (!layoutDump) return;
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      setDumpStatus('Clipboard API unavailable in this environment.');
      return;
    }

    try {
      await navigator.clipboard.writeText(layoutDump);
      setDumpStatus('Copied layout JSON to clipboard.');
    } catch {
      setDumpStatus('Failed to copy layout JSON to clipboard.');
    }
  }, [layoutDump]);

  return (
    <div className="space-y-3">
      <section
        className="rounded-lg border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <LayoutGrid className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Floating Windows
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Keep moved panel positions between sessions, or always start from the default workspace layout.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Remember window positions
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Persist dragged panel positions in local storage.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onFloatingLayoutPersistenceChange(!floatingLayoutPersistence)}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={floatingLayoutPersistence
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
              {floatingLayoutPersistence ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Reset saved window layout
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Forget all stored panel positions and return to seeded layout.
              </div>
            </div>
            <button
              type="button"
              onClick={onResetFloatingLayout}
              className="ui-button ui-button-secondary !h-10 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <RotateCcw className="h-4 w-4 shrink-0" />
              Reset
            </button>
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Show Debug Primitives panel
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Toggle visibility of the Prepare-mode debug primitive window.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onDebugPrimitivesPanelVisibleChange(!debugPrimitivesPanelVisible)}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={debugPrimitivesPanelVisible
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
              {debugPrimitivesPanelVisible ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </section>

      <section
        className="rounded-lg border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <Database className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Import Defaults
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Applied automatically when importing Scene Files.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
            Default Raft Base
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Chooses raft bottom mode for imported supports.
          </div>

          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {([
              { value: 'off', label: 'Off' },
              { value: 'line', label: 'Line' },
              { value: 'solid', label: 'Solid' },
            ] as const).map((option) => {
              const isActive = importDefaults.raftBottomMode === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onImportDefaultsChange({
                    ...importDefaults,
                    raftBottomMode: option.value,
                    rootsEnabled: option.value === 'line' ? true : importDefaults.rootsEnabled,
                  })}
                  className="h-9 rounded-md border text-[12px] font-semibold transition-colors"
                  style={isActive
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
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {importDefaults.raftBottomMode === 'solid' ? (
          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Default Raft Wall
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Enable perimeter wall for imported solid rafts.
                </div>
              </div>
              <button
                type="button"
                onClick={() => onImportDefaultsChange({ ...importDefaults, raftWallEnabled: !importDefaults.raftWallEnabled })}
                className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                style={importDefaults.raftWallEnabled
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
                {importDefaults.raftWallEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        ) : null}

        {!rootsLockedByLineRaft ? (
          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Roots Enabled on Import
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  OFF makes imported root diameter match trunk diameter.
                </div>
              </div>
              <button
                type="button"
                onClick={() => onImportDefaultsChange({ ...importDefaults, rootsEnabled: !importDefaults.rootsEnabled })}
                className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                style={importDefaults.rootsEnabled
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
                {importDefaults.rootsEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                Auto-Repair Scenes
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                Automatically runs native mesh auto-repair for scene-file imports.
              </div>
            </div>
            <button
              type="button"
              onClick={() => onImportDefaultsChange({ ...importDefaults, autoRepairScenes: !importDefaults.autoRepairScenes })}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              style={importDefaults.autoRepairScenes
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
              {importDefaults.autoRepairScenes ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      </section>

      <section
        className="rounded-lg border p-3"
        style={{
          background: 'var(--surface-1)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'color-mix(in srgb, var(--surface-2), transparent 8%)',
            }}
          >
            <Bug className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              Debug
            </h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Dump floating window layout JSON for diagnostics, bug reports, or reproducible UX state.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleDumpCurrentLayout}
              className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5"
            >
              <Database className="h-4 w-4 shrink-0" />
              Dump Current Layout JSON
            </button>

            <button
              type="button"
              onClick={handleDumpSavedLayout}
              className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5"
            >
              <Database className="h-4 w-4 shrink-0" />
              Dump Saved Layout JSON
            </button>

            <button
              type="button"
              onClick={handleCopyDump}
              disabled={!layoutDump}
              className="ui-button ui-button-primary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ClipboardCopy className="h-4 w-4 shrink-0" />
              Copy JSON
            </button>
          </div>

          {dumpStatus && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {dumpStatus}
            </div>
          )}

          <div className="mt-2">
            <label className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
              Layout JSON
            </label>
            <textarea
              value={layoutDump}
              readOnly
              spellCheck={false}
              placeholder="Click a dump button to capture layout JSON..."
              className="mt-1 w-full rounded-md border p-2 font-mono text-[11px] leading-4 min-h-[180px] resize-y"
              style={{
                borderColor: 'var(--border-subtle)',
                background: 'color-mix(in srgb, var(--surface-0), black 5%)',
                color: 'var(--text-strong)',
              }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
