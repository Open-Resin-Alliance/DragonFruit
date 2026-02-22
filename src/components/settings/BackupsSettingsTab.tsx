'use client';

import React from 'react';
import { ArchiveRestore, CheckCircle2, Github, Loader2, RefreshCcw, ShieldCheck, ShieldX, UploadCloud } from 'lucide-react';
import { getProfileStoreSnapshot } from '@/features/profiles/profileStore';

type StatusResponse = {
  ok: boolean;
  configured: boolean;
  authenticated: boolean;
  expectedOrigin?: string | null;
  user?: {
    login: string;
    name: string | null;
    avatarUrl: string;
  };
  repository?: {
    name: string;
    exists: boolean;
    private: boolean | null;
  };
  remoteUpdatedAt?: string | null;
  error?: string;
};

type SyncResponse = {
  ok: boolean;
  conflict?: boolean;
  reason?: string;
  remoteSnapshot?: BackupSnapshot;
  remoteUpdatedAt?: string;
  localUpdatedAt?: string;
  syncedAt?: string;
  error?: string;
};

type BackupSnapshot = {
  version: number;
  updatedAt: string;
  clientId: string;
  localStorage: Record<string, string>;
  profiles?: unknown;
};

const AUTO_SYNC_ENABLED_KEY = 'dragonfruit-backups:auto-sync-enabled';
const AUTO_SYNC_MINUTES_KEY = 'dragonfruit-backups:auto-sync-minutes';
const CLIENT_ID_KEY = 'dragonfruit-backups:client-id';
const LAST_SYNC_AT_KEY = 'dragonfruit-backups:last-sync-at';

const KNOWN_LOCAL_STORAGE_KEYS = [
  'support-settings',
  'app-hotkeys-config',
  'app-theme-preference',
  'app-theme-colors',
  'app-theme-preset',
  'lumenslicer:floating-panel-layout:v4',
  'app-floating-layout-persistence',
  'app-recent-opened-files',
  'app-3d-view-settings',
  'dragonfruit-profiles-v1',
  'dragonfruit-profiles-v1-backup',
  AUTO_SYNC_ENABLED_KEY,
  AUTO_SYNC_MINUTES_KEY,
  CLIENT_ID_KEY,
  LAST_SYNC_AT_KEY,
];

function getOrCreateClientId(): string {
  if (typeof window === 'undefined') return 'server';
  const existing = window.localStorage.getItem(CLIENT_ID_KEY)?.trim();
  if (existing) return existing;

  const created = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `df-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  window.localStorage.setItem(CLIENT_ID_KEY, created);
  return created;
}

function collectSnapshot(): BackupSnapshot {
  const localStoragePayload: Record<string, string> = {};

  if (typeof window !== 'undefined') {
    const known = new Set(KNOWN_LOCAL_STORAGE_KEYS);

    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key) continue;
      if (
        known.has(key)
        || key.startsWith('dragonfruit-')
        || key.startsWith('app-')
        || key.startsWith('lumenslicer:')
      ) {
        const value = window.localStorage.getItem(key);
        if (value != null) localStoragePayload[key] = value;
      }
    }
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    clientId: getOrCreateClientId(),
    localStorage: localStoragePayload,
    profiles: getProfileStoreSnapshot(),
  };
}

function applyRemoteSnapshot(snapshot: BackupSnapshot): void {
  if (typeof window === 'undefined') return;

  for (const [key, value] of Object.entries(snapshot.localStorage ?? {})) {
    window.localStorage.setItem(key, value);
  }

  window.localStorage.setItem(LAST_SYNC_AT_KEY, new Date().toISOString());
  window.location.reload();
}

async function fetchStatus(): Promise<StatusResponse> {
  const response = await fetch('/api/backups/github/auth/status', { cache: 'no-store' });
  return response.json() as Promise<StatusResponse>;
}

async function startGithubAuthPopup(): Promise<Window | null> {
  const response = await fetch('/api/backups/github/auth/start?popup=1', { cache: 'no-store' });
  const payload = await response.json().catch(() => null) as { ok?: boolean; authUrl?: string; error?: string } | null;
  if (!response.ok || !payload?.ok || !payload.authUrl) {
    throw new Error(payload?.error || 'Failed to start GitHub OAuth.');
  }

  const width = 520;
  const height = 680;
  const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);

  return window.open(
    payload.authUrl,
    'dragonfruit-github-backups-auth',
    `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`,
  );
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/\[|\]/g, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function isTrustedBackupAuthOrigin(origin: string): boolean {
  try {
    const incoming = new URL(origin);
    const current = new URL(window.location.origin);

    if (incoming.origin === current.origin) return true;
    if (incoming.port !== current.port) return false;

    return isLoopbackHost(incoming.hostname) && isLoopbackHost(current.hostname);
  } catch {
    return false;
  }
}

function shouldAlignToExpectedOrigin(expectedOrigin?: string | null): string | null {
  if (!expectedOrigin || typeof window === 'undefined') return null;
  try {
    const expected = new URL(expectedOrigin);
    const current = new URL(window.location.href);
    if (expected.origin === current.origin) return null;

    if (isLoopbackHost(expected.hostname) && isLoopbackHost(current.hostname) && expected.port === current.port) {
      current.protocol = expected.protocol;
      current.hostname = expected.hostname;
      current.port = expected.port;
      return current.toString();
    }
  } catch {
    return null;
  }

  return null;
}

export function BackupsSettingsTab() {
  const [status, setStatus] = React.useState<StatusResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = React.useState(true);
  const [busy, setBusy] = React.useState<'none' | 'auth' | 'ensure' | 'sync' | 'restore' | 'logout'>('none');
  const [message, setMessage] = React.useState<{ kind: 'idle' | 'success' | 'error'; text: string }>({ kind: 'idle', text: '' });
  const [remoteConflictSnapshot, setRemoteConflictSnapshot] = React.useState<BackupSnapshot | null>(null);

  const [autoSyncEnabled, setAutoSyncEnabled] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(AUTO_SYNC_ENABLED_KEY) !== 'false';
  });
  const [autoSyncMinutes, setAutoSyncMinutes] = React.useState<number>(() => {
    if (typeof window === 'undefined') return 15;
    const raw = Number(window.localStorage.getItem(AUTO_SYNC_MINUTES_KEY) ?? '15');
    return Number.isFinite(raw) ? Math.min(240, Math.max(1, raw)) : 15;
  });
  const [lastLocalSyncAt, setLastLocalSyncAt] = React.useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(LAST_SYNC_AT_KEY);
  });

  const statusRef = React.useRef<StatusResponse | null>(null);
  statusRef.current = status;

  const loadStatus = React.useCallback(async () => {
    setLoadingStatus(true);
    try {
      const next = await fetchStatus();
      const alignedUrl = shouldAlignToExpectedOrigin(next.expectedOrigin);
      if (alignedUrl) {
        window.location.assign(alignedUrl);
        return;
      }

      setStatus(next);
      if (!next.ok && next.error) {
        setMessage({ kind: 'error', text: next.error });
      }
    } catch (error) {
      setStatus({ ok: false, configured: false, authenticated: false, error: 'Failed to load backup status.' });
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to load backup status.' });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const runSync = React.useCallback(async (forcePush = false) => {
    setBusy('sync');
    setMessage({ kind: 'idle', text: '' });

    try {
      const snapshot = collectSnapshot();
      const response = await fetch('/api/backups/github/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot, forcePush }),
      });

      const payload = await response.json().catch(() => null) as SyncResponse | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Backup sync failed.');
      }

      if (payload.conflict && payload.remoteSnapshot) {
        setRemoteConflictSnapshot(payload.remoteSnapshot);
        setMessage({ kind: 'error', text: payload.reason || 'Remote backup is newer. Choose restore or force sync.' });
        return;
      }

      window.localStorage.setItem(LAST_SYNC_AT_KEY, payload.syncedAt ?? new Date().toISOString());
      setLastLocalSyncAt(payload.syncedAt ?? new Date().toISOString());
      setRemoteConflictSnapshot(null);
      setMessage({ kind: 'success', text: 'Backup synced to GitHub repository.' });
      await loadStatus();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Backup sync failed.' });
    } finally {
      setBusy('none');
    }
  }, [loadStatus]);

  const handleConnectGithub = React.useCallback(async () => {
    setBusy('auth');
    try {
      const popup = await startGithubAuthPopup();
      setMessage({ kind: 'success', text: 'GitHub OAuth popup opened.' });

      if (popup) {
        const startedAt = Date.now();
        const watcher = window.setInterval(() => {
          const timedOut = Date.now() - startedAt > 120000;
          if (popup.closed || timedOut) {
            window.clearInterval(watcher);
            void loadStatus();
          }
        }, 500);
      }
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to start OAuth.' });
    } finally {
      setBusy('none');
    }
  }, [loadStatus]);

  const handleEnsureRepo = React.useCallback(async () => {
    setBusy('ensure');
    setMessage({ kind: 'idle', text: '' });
    try {
      const response = await fetch('/api/backups/github/repo/ensure', { method: 'POST' });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Failed to ensure repository.');
      setMessage({ kind: 'success', text: 'Backup repository is ready.' });
      await loadStatus();
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to ensure repository.' });
    } finally {
      setBusy('none');
    }
  }, [loadStatus]);

  const handleDisconnect = React.useCallback(async () => {
    setBusy('logout');
    try {
      await fetch('/api/backups/github/auth/logout', { method: 'POST' });
      setRemoteConflictSnapshot(null);
      setMessage({ kind: 'success', text: 'Disconnected GitHub account.' });
      await loadStatus();
    } catch {
      setMessage({ kind: 'error', text: 'Failed to disconnect GitHub account.' });
    } finally {
      setBusy('none');
    }
  }, [loadStatus]);

  React.useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; success?: boolean; message?: string; sourceOrigin?: string } | undefined;
      if (data?.type !== 'dragonfruit:backup-auth') return;
      if (!isTrustedBackupAuthOrigin(event.origin)) return;

      if (data.success && data.sourceOrigin && data.sourceOrigin !== window.location.origin) {
        try {
          const source = new URL(data.sourceOrigin);
          const current = new URL(window.location.href);
          if (isLoopbackHost(source.hostname) && isLoopbackHost(current.hostname) && source.port === current.port) {
            current.protocol = source.protocol;
            current.hostname = source.hostname;
            current.port = source.port;
            window.location.assign(current.toString());
            return;
          }
        } catch {
          // fall through to normal status refresh
        }
      }

      if (data.success) {
        setMessage({ kind: 'success', text: data.message || 'GitHub account connected.' });
      } else {
        setMessage({ kind: 'error', text: data.message || 'GitHub authentication failed.' });
      }

      void loadStatus();
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadStatus]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(AUTO_SYNC_ENABLED_KEY, autoSyncEnabled ? 'true' : 'false');
  }, [autoSyncEnabled]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(AUTO_SYNC_MINUTES_KEY, String(autoSyncMinutes));
  }, [autoSyncMinutes]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    if (!autoSyncEnabled) return;
    if (!statusRef.current?.authenticated) return;

    const intervalMs = autoSyncMinutes * 60 * 1000;
    const handle = window.setInterval(() => {
      void runSync(false);
    }, intervalMs);

    return () => window.clearInterval(handle);
  }, [autoSyncEnabled, autoSyncMinutes, runSync]);

  const authenticated = Boolean(status?.authenticated);
  const backupsConfigured = Boolean(status?.configured);
  const repoExists = Boolean(status?.repository?.exists);
  const hasAnySync = Boolean(status?.remoteUpdatedAt || lastLocalSyncAt);
  const setupComplete = authenticated && repoExists && hasAnySync;

  const onboardingStep = !authenticated
    ? 1
    : !repoExists
      ? 2
      : !hasAnySync
        ? 3
        : 4;

  const onboardingTask = onboardingStep === 1
    ? {
        title: 'Connect your GitHub account',
        description: 'Authorize Dragonfruit so backups can be saved into your private repository.',
        buttonLabel: 'Connect GitHub now',
        icon: Github,
        busyState: 'auth' as const,
        onClick: () => { void handleConnectGithub(); },
      }
    : onboardingStep === 2
      ? {
          title: 'Prepare your private backup repository',
          description: 'Create or verify dragonfruit-backups in your GitHub account.',
          buttonLabel: 'Create private repo now',
          icon: ArchiveRestore,
          busyState: 'ensure' as const,
          onClick: () => { void handleEnsureRepo(); },
        }
      : {
          title: 'Create your first backup snapshot',
          description: 'Upload your current settings and profiles to complete setup.',
          buttonLabel: 'Run first backup now',
          icon: UploadCloud,
          busyState: 'sync' as const,
          onClick: () => { void runSync(false); },
        };

  return (
    <div className="space-y-3">
      <section className="relative rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        {!loadingStatus && !backupsConfigured && (
          <div
            className="absolute right-3 top-3 z-10 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{
              borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 35%)',
              background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 92%)',
              color: '#fcd34d',
            }}
          >
            Env config required
          </div>
        )}

        <div
          className="transition-opacity duration-200"
          style={{
            opacity: !loadingStatus && !backupsConfigured ? 0.48 : 1,
            filter: !loadingStatus && !backupsConfigured ? 'grayscale(0.35)' : 'none',
            pointerEvents: !loadingStatus && !backupsConfigured ? 'none' : 'auto',
          }}
          aria-disabled={!loadingStatus && !backupsConfigured}
        >
          <div className="flex items-start gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}>
              <ShieldCheck className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Private GitHub Backups</h3>
              <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Dragonfruit stores backups in your own private GitHub repository. We intentionally avoid ORA-hosted cloud storage and we do not operate a Dragonfruit backup server.
              </p>
            </div>
          </div>

        {!setupComplete && (
          <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 54%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 95%)' }}>
            <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Getting Started</div>
            <h4 className="mt-0.5 text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Set up backups in under a minute</h4>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              We’ll walk you through setup one action at a time. Dragonfruit only syncs to your own private GitHub repository.
            </p>

            <div className="mt-2.5 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-medium" style={{ color: 'var(--text-strong)' }}>
                  Progress
                </div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {Math.min(onboardingStep, 3)} / 3 complete
                </div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-1.5">
                {[
                  { key: 'connect', label: 'Connect', done: authenticated, active: onboardingStep === 1 },
                  { key: 'repo', label: 'Repo', done: repoExists, active: onboardingStep === 2 },
                  { key: 'backup', label: 'Backup', done: hasAnySync, active: onboardingStep === 3 },
                ].map((item) => (
                  <div
                    key={item.key}
                    className="rounded-md border px-2 py-1.5 text-center text-[11px] font-medium"
                    style={{
                      borderColor: item.done
                        ? 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)'
                        : item.active
                          ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)'
                          : 'var(--border-subtle)',
                      background: item.done
                        ? 'color-mix(in srgb, #22c55e, var(--surface-1) 92%)'
                        : item.active
                          ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 93%)'
                          : 'var(--surface-1)',
                      color: item.done
                        ? '#86efac'
                        : item.active
                          ? 'var(--accent-secondary)'
                          : 'var(--text-muted)',
                    }}
                  >
                    {item.done ? '✓ ' : ''}{item.label}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
              <h5 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{onboardingTask.title}</h5>
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{onboardingTask.description}</p>

              <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onboardingTask.onClick}
                disabled={busy !== 'none' || !status?.configured}
                className="ui-button ui-button-primary !h-10 !px-4 !py-0 text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
                style={{
                  background: onboardingStep === 1
                    ? 'linear-gradient(135deg, #8250df, #6f42c1)'
                    : 'color-mix(in srgb, var(--accent), var(--surface-0) 16%)',
                  borderColor: onboardingStep === 1
                    ? 'color-mix(in srgb, #8250df, white 14%)'
                    : 'color-mix(in srgb, var(--accent), white 10%)',
                  color: '#ffffff',
                }}
              >
                {busy === onboardingTask.busyState ? <Loader2 className="h-4 w-4 animate-spin" /> : <onboardingTask.icon className="h-4 w-4" />}
                {onboardingTask.buttonLabel}
              </button>

              {onboardingStep > 1 && (
                <button
                  type="button"
                  onClick={() => { void handleConnectGithub(); }}
                  disabled={busy !== 'none' || !status?.configured}
                  className="ui-button ui-button-secondary !h-10 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
                  style={{ color: 'var(--accent-secondary)' }}
                >
                  <Github className="h-4 w-4" />
                  Reconnect GitHub
                </button>
              )}
            </div>

              {onboardingStep === 1 && (
                <div className="mt-2 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  We’ll open a secure GitHub popup to connect your account.
                </div>
              )}
            </div>
          </div>
        )}

        {setupComplete && (
          <div className="mt-3 rounded-md border p-2.5" style={{ borderColor: 'color-mix(in srgb, #22c55e, var(--border-subtle) 45%)', background: 'color-mix(in srgb, #22c55e, var(--surface-1) 95%)' }}>
            <div className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: '#86efac' }}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Setup complete — backups are active.
            </div>
          </div>
        )}

          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          {loadingStatus ? (
            <div className="text-xs inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading backup status…
            </div>
          ) : !status?.configured ? (
            <div className="text-xs" style={{ color: '#fca5a5' }}>
              Backups are not configured on this build yet. Add GitHub OAuth env values to enable this tab.
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Connection</div>
                <div className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--text-strong)' }}>
                  {authenticated ? <CheckCircle2 className="h-3.5 w-3.5" style={{ color: '#86efac' }} /> : <ShieldX className="h-3.5 w-3.5" style={{ color: '#fca5a5' }} />}
                  {authenticated ? `@${status.user?.login ?? 'unknown'}` : 'Not connected'}
                </div>
              </div>

              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Repository</div>
                <div className="mt-1 text-xs font-medium" style={{ color: 'var(--text-strong)' }}>
                  {status.repository?.name ?? 'dragonfruit-backups'}
                </div>
                <div className="text-[11px]" style={{ color: repoExists ? '#86efac' : 'var(--text-muted)' }}>
                  {repoExists ? 'Private repo ready' : 'Not created yet'}
                </div>
              </div>

              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Last remote backup</div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-strong)' }}>
                  {status.remoteUpdatedAt ? new Date(status.remoteUpdatedAt).toLocaleString() : 'Never'}
                </div>
              </div>

              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Last local sync</div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-strong)' }}>
                  {lastLocalSyncAt ? new Date(lastLocalSyncAt).toLocaleString() : 'Never'}
                </div>
              </div>
            </div>
          )}
          </div>
        </div>
      </section>

      {setupComplete && (
        <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="flex items-center gap-2">
            <RefreshCcw className="h-4 w-4" style={{ color: 'var(--accent-secondary)' }} />
            <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Backup Management</h4>
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            If GitHub has a newer backup, Dragonfruit pauses sync and asks whether to restore remote or force-push local.
          </p>

          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Quick actions</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => { void runSync(false); }}
                disabled={busy !== 'none' || !authenticated}
                className="ui-button ui-button-primary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {busy === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Backup Now
              </button>

              <button
                type="button"
                onClick={() => { void handleEnsureRepo(); }}
                disabled={busy !== 'none' || !authenticated}
                className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {busy === 'ensure' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
                Verify Repo
              </button>

              <button
                type="button"
                onClick={() => { void handleDisconnect(); }}
                disabled={busy !== 'none' || !authenticated}
                className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {busy === 'logout' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldX className="h-4 w-4" />}
                Disconnect
              </button>
            </div>
          </div>

          {remoteConflictSnapshot && (
            <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 40%)', background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 95%)' }}>
              <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: '#fcd34d' }}>Conflict detected</div>
              <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                Remote backup is newer than your local snapshot. Choose how to resolve this sync.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setBusy('restore');
                    applyRemoteSnapshot(remoteConflictSnapshot);
                  }}
                  disabled={busy !== 'none'}
                  className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
                  style={{ color: '#facc15' }}
                >
                  <ArchiveRestore className="h-4 w-4" />
                  Restore Remote
                </button>

                <button
                  type="button"
                  onClick={() => { void runSync(true); }}
                  disabled={busy !== 'none'}
                  className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center gap-1.5 disabled:opacity-60"
                  style={{ color: '#fca5a5' }}
                >
                  <RefreshCcw className="h-4 w-4" />
                  Force Push Local
                </button>
              </div>
            </div>
          )}

          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Automation</div>
            <div className="mt-2 grid gap-2 sm:grid-cols-[auto_120px_auto] sm:items-center">
              <label className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--text-strong)' }}>
                <input
                  type="checkbox"
                  checked={autoSyncEnabled}
                  onChange={(event) => setAutoSyncEnabled(event.target.checked)}
                />
                Enable automatic backups
              </label>

              <input
                type="number"
                min={1}
                max={240}
                value={autoSyncMinutes}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (!Number.isFinite(next)) return;
                  setAutoSyncMinutes(Math.max(1, Math.min(240, Math.round(next))));
                }}
                className="ui-input h-[34px] px-2.5 py-1.5 text-sm"
                disabled={!autoSyncEnabled}
              />

              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>minutes between sync attempts</span>
            </div>

            <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              Last local sync: {lastLocalSyncAt ? new Date(lastLocalSyncAt).toLocaleString() : 'never'}
            </div>
          </div>
        </section>
      )}

      <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 4%)' }}>
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Privacy Commitments</h4>
        <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Where your data lives</div>
            <div className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-strong)' }}>
              In your own private GitHub repository.
            </div>
          </div>

          <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>What we intentionally avoid</div>
            <div className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-strong)' }}>
              No ORA-hosted cloud backups, no Dragonfruit central backup database.
            </div>
          </div>

          <div className="rounded-md border p-2.5 sm:col-span-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Your control</div>
            <div className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-strong)' }}>
              You can disconnect GitHub at any time. OAuth access is only used for repository checks and backup file sync.
            </div>
          </div>
        </div>
      </section>

      {message.kind !== 'idle' && (
        <div className="rounded-md border px-3 py-2 text-xs" style={{
          borderColor: message.kind === 'error' ? 'color-mix(in srgb, #ef4444, var(--border-subtle) 40%)' : 'color-mix(in srgb, #22c55e, var(--border-subtle) 40%)',
          background: 'var(--surface-1)',
          color: message.kind === 'error' ? '#fca5a5' : '#86efac',
        }}>
          {message.text}
        </div>
      )}
    </div>
  );
}
