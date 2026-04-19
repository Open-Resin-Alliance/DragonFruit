'use client';

import React from 'react';
import { AlertTriangle, HardDrive, Loader2, RefreshCw } from 'lucide-react';
import { NumberInput } from '@/components/ui/NumberInput';
import {
  getSceneAutosaveSettingsSnapshot,
  saveSceneAutosaveSettings,
  type SceneAutosaveSettings,
} from '@/components/settings/sceneAutosavePreferences';

type AutosavePaths = {
  voxlPath: string;
  manifestPath: string;
};

type AutosaveManifest = {
  savedAt: string;
  clean: boolean;
};

function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

export function SceneAutosaveSettingsTab() {
  const [desktopAvailable] = React.useState<boolean>(() => isDesktopRuntime());
  const [settings, setSettings] = React.useState<SceneAutosaveSettings>(() => getSceneAutosaveSettingsSnapshot());
  const [paths, setPaths] = React.useState<AutosavePaths | null>(null);
  const [manifest, setManifest] = React.useState<AutosaveManifest | null>(null);
  const [loadingStatus, setLoadingStatus] = React.useState<boolean>(false);
  const [busy, setBusy] = React.useState<'none' | 'refresh' | 'mark-clean' | 'reveal'>('none');
  const [message, setMessage] = React.useState<{ kind: 'idle' | 'success' | 'error'; text: string }>({ kind: 'idle', text: '' });

  React.useEffect(() => {
    saveSceneAutosaveSettings(settings);
  }, [settings]);

  const loadStatus = React.useCallback(async () => {
    if (!desktopAvailable) return;

    setLoadingStatus(true);
    setMessage({ kind: 'idle', text: '' });

    try {
      const [nextPaths, nextManifest] = await Promise.all([
        invokeDesktop<AutosavePaths>('scene_autosave_get_paths'),
        invokeDesktop<AutosaveManifest | null>('scene_autosave_read_manifest'),
      ]);
      setPaths(nextPaths);
      setManifest(nextManifest);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to load autosave status.' });
    } finally {
      setLoadingStatus(false);
    }
  }, [desktopAvailable]);

  React.useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleRefresh = React.useCallback(async () => {
    setBusy('refresh');
    try {
      await loadStatus();
      setMessage({ kind: 'success', text: 'Autosave status refreshed.' });
    } finally {
      setBusy('none');
    }
  }, [loadStatus]);

  const handleMarkClean = React.useCallback(async () => {
    if (!desktopAvailable) return;

    setBusy('mark-clean');
    setMessage({ kind: 'idle', text: '' });

    try {
      await invokeDesktop('scene_autosave_write_manifest', {
        savedAt: manifest?.savedAt ?? new Date().toISOString(),
        clean: true,
      });
      await loadStatus();
      setMessage({ kind: 'success', text: 'Autosave recovery state marked clean.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to mark autosave as clean.' });
    } finally {
      setBusy('none');
    }
  }, [desktopAvailable, loadStatus, manifest?.savedAt]);

  const handleRevealAutosave = React.useCallback(async () => {
    if (!desktopAvailable || !paths?.voxlPath) return;

    setBusy('reveal');
    try {
      await invokeDesktop('reveal_in_file_manager', { path: paths.voxlPath });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to open autosave location.' });
    } finally {
      setBusy('none');
    }
  }, [desktopAvailable, paths?.voxlPath]);

  const debounceSeconds = Math.round(settings.debounceMs / 1000);
  const capMinutes = Math.round(settings.capMs / 60_000);

  return (
    <div className="space-y-3">
      <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-start gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}>
            <HardDrive className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Scene Autosave</h3>
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Automatically saves a crash-recovery `.voxl` scene in the background and offers restore on next launch.
            </p>
          </div>
        </div>

        <div className="mt-2 grid gap-2">
          <div className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Enable scene autosave</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Creates recovery snapshots while editing.</div>
            </div>
            <button
              type="button"
              onClick={() => setSettings((prev) => ({ ...prev, enabled: !prev.enabled }))}
              className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
              aria-pressed={settings.enabled}
              style={settings.enabled
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
              {settings.enabled ? 'ON' : 'OFF'}
            </button>
          </div>

          <div
            className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-3"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
              opacity: settings.enabled ? 1 : 0.68,
            }}
          >
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Autosave idle delay</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Wait this long after edits before autosaving.</div>
            </div>
            <div className="inline-flex items-center gap-2">
              <NumberInput
                min={15}
                max={900}
                step={5}
                value={debounceSeconds}
                onChange={(next) => {
                  if (!Number.isFinite(next)) return;
                  const nextSeconds = Math.max(15, Math.min(900, Math.round(next)));
                  setSettings((prev) => ({
                    ...prev,
                    debounceMs: nextSeconds * 1000,
                    capMs: Math.max(prev.capMs, nextSeconds * 1000),
                  }));
                }}
                className="ui-input h-[34px] w-[120px] pl-2.5 pr-5 py-1.5 text-sm"
                disabled={!settings.enabled}
              />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>sec</span>
            </div>
          </div>

          <div
            className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-3"
            style={{
              borderColor: 'var(--border-subtle)',
              background: 'var(--surface-0)',
              opacity: settings.enabled ? 1 : 0.68,
            }}
          >
            <div>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Maximum autosave interval</div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>For continuous edits, save at least this often.</div>
            </div>
            <div className="inline-flex items-center gap-2">
              <NumberInput
                min={1}
                max={60}
                step={1}
                value={capMinutes}
                onChange={(next) => {
                  if (!Number.isFinite(next)) return;
                  const nextMinutes = Math.max(1, Math.min(60, Math.round(next)));
                  setSettings((prev) => ({
                    ...prev,
                    capMs: Math.max(nextMinutes * 60_000, prev.debounceMs),
                  }));
                }}
                className="ui-input h-[34px] w-[120px] pl-2.5 pr-5 py-1.5 text-sm"
                disabled={!settings.enabled}
              />
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>min</span>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-start gap-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0" style={{ borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 50%)', background: 'color-mix(in srgb, #d97706, var(--surface-1) 85%)' }}>
            <AlertTriangle className="h-4 w-4" style={{ color: '#d97706' }} />
          </span>
          <div className="flex-1">
            <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Crash Recovery</h4>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Show restore/discard prompt if a dirty autosave is detected at startup.
            </p>
          </div>
        </div>

        <div className="mt-2 rounded-md border px-2.5 py-2 flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Recovery prompt on startup</div>
          <button
            type="button"
            onClick={() => setSettings((prev) => ({ ...prev, recoveryPromptEnabled: !prev.recoveryPromptEnabled }))}
            className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
            aria-pressed={settings.recoveryPromptEnabled}
            style={settings.recoveryPromptEnabled
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
            {settings.recoveryPromptEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </section>

      <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-center justify-between gap-2">
          <div>
            <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Autosave Status</h4>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Desktop-only diagnostics for autosave files and recovery state.
            </p>
          </div>
          <button
            type="button"
            onClick={() => { void handleRefresh(); }}
            disabled={!desktopAvailable || busy !== 'none'}
            className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            {busy === 'refresh' || loadingStatus ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </button>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          {!desktopAvailable ? (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Autosave files are available in the DragonFruit desktop build.
            </div>
          ) : loadingStatus ? (
            <div className="text-xs inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading autosave status…
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Recovery state</div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-strong)' }}>
                  {manifest == null ? 'No autosave manifest found' : manifest.clean ? 'Clean (no pending recovery)' : 'Recovery available'}
                </div>
              </div>

              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Last autosave timestamp</div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-strong)' }}>
                  {manifest?.savedAt ? new Date(manifest.savedAt).toLocaleString() : 'Unknown'}
                </div>
              </div>

              <div className="rounded-md border px-2.5 py-2 sm:col-span-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Autosave scene file</div>
                <div className="mt-1 text-xs break-all" style={{ color: 'var(--text-strong)' }}>
                  {paths?.voxlPath ?? 'Unavailable'}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => { void handleMarkClean(); }}
            disabled={!desktopAvailable || busy !== 'none'}
            className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          >
            {busy === 'mark-clean' ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
            Mark Recovery Clean
          </button>
          <button
            type="button"
            onClick={() => { void handleRevealAutosave(); }}
            disabled={!desktopAvailable || !paths?.voxlPath || busy !== 'none'}
            className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          >
            {busy === 'reveal' ? <Loader2 className="h-4 w-4 animate-spin" /> : <HardDrive className="h-4 w-4" />}
            Open Autosave Location
          </button>
        </div>
      </section>

      {message.kind !== 'idle' && (
        <div
          className="rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: message.kind === 'error'
              ? 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)'
              : 'color-mix(in srgb, #22c55e, var(--border-subtle) 40%)',
            background: 'var(--surface-1)',
            color: message.kind === 'error' ? '#fca5a5' : '#86efac',
          }}
        >
          {message.text}
        </div>
      )}
    </div>
  );
}
