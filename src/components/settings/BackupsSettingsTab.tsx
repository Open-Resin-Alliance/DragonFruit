'use client';

import React from 'react';
import { ArchiveRestore, CheckCircle2, CircleHelp, Eye, Github, Loader2, RefreshCcw, ShieldCheck, ShieldX, Trash2, UploadCloud, X } from 'lucide-react';
import { getProfileStoreSnapshot } from '@/features/profiles/profileStore';
import { NumberInput } from '@/components/ui/NumberInput';

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

type BackupHistoryEntry = {
  id: string;
  path: string;
  sha: string;
  createdAt: string;
};

type HistoryListResponse = {
  ok: boolean;
  items?: BackupHistoryEntry[];
  count?: number;
  error?: string;
};

type HistoryItemResponse = {
  ok: boolean;
  item?: {
    id: string;
    createdAt: string;
    document: {
      source?: string;
      schemaVersion?: number;
      snapshot: BackupSnapshot;
      updatedAt: string;
    };
  };
  error?: string;
};

const AUTO_SYNC_ENABLED_KEY = 'dragonfruit-backups:auto-sync-enabled';
const AUTO_SYNC_MINUTES_KEY = 'dragonfruit-backups:auto-sync-minutes';
const CLIENT_ID_KEY = 'dragonfruit-backups:client-id';
const LAST_SYNC_AT_KEY = 'dragonfruit-backups:last-sync-at';
const BACKUP_STATUS_CACHE_KEY = 'dragonfruit-backups:status-cache-v1';
const BACKUP_STATUS_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

type SelectedHistoryDocument = NonNullable<HistoryItemResponse['item']>['document'];
type SnapshotModalTab = 'overview' | 'localStorage' | 'profiles' | 'raw';

type ParsedPrinterProfile = {
  id: string;
  name?: string;
  manufacturer?: string;
  officialPresetId?: string;
  isOfficial?: boolean;
  isCustom?: boolean;
  buildVolumeMm?: {
    width?: number;
    depth?: number;
    height?: number;
  };
  display?: {
    resolutionX?: number;
    resolutionY?: number;
    outputFormat?: string;
  };
  networkSupport?: string;
  networkConnection?: {
    mode?: string;
    connected?: boolean;
    hostName?: string;
    ipAddress?: string;
    port?: number;
    statusText?: string;
  };
};

type ParsedMaterialProfile = {
  id: string;
  printerProfileId?: string;
  name?: string;
  brand?: string;
  resinFamily?: string;
  layerHeightMm?: number;
  normalExposureSec?: number;
  bottomExposureSec?: number;
  bottomLayerCount?: number;
  liftDistanceMm?: number;
  liftSpeedMmMin?: number;
  retractSpeedMmMin?: number;
};

type ParsedProfilesSnapshot = {
  printerProfiles: ParsedPrinterProfile[];
  materialProfiles: ParsedMaterialProfile[];
  activePrinterProfileId?: string;
  activeMaterialProfileId?: string;
};

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

function readCachedStatus(): StatusResponse | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(BACKUP_STATUS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { cachedAt: number; status: StatusResponse };
    if (!parsed?.status || typeof parsed.cachedAt !== 'number') return null;
    if (Date.now() - parsed.cachedAt > BACKUP_STATUS_CACHE_MAX_AGE_MS) return null;
    return parsed.status;
  } catch {
    return null;
  }
}

function writeCachedStatus(status: StatusResponse): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(BACKUP_STATUS_CACHE_KEY, JSON.stringify({
      cachedAt: Date.now(),
      status,
    }));
  } catch {
    // Ignore cache write failures.
  }
}

function stringifyReadable(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return value;
    }
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseProfilesSnapshot(value: unknown): ParsedProfilesSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const rawPrinters = Array.isArray(obj.printerProfiles) ? obj.printerProfiles : [];
  const rawMaterials = Array.isArray(obj.materialProfiles) ? obj.materialProfiles : [];

  const printerProfiles: ParsedPrinterProfile[] = rawPrinters
    .map((item) => item as ParsedPrinterProfile)
    .filter((item) => item && typeof item === 'object' && typeof item.id === 'string');

  const materialProfiles: ParsedMaterialProfile[] = rawMaterials
    .map((item) => item as ParsedMaterialProfile)
    .filter((item) => item && typeof item === 'object' && typeof item.id === 'string');

  return {
    printerProfiles,
    materialProfiles,
    activePrinterProfileId: typeof obj.activePrinterProfileId === 'string' ? obj.activePrinterProfileId : undefined,
    activeMaterialProfileId: typeof obj.activeMaterialProfileId === 'string' ? obj.activeMaterialProfileId : undefined,
  };
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
  const [historyItems, setHistoryItems] = React.useState<BackupHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [selectedHistoryId, setSelectedHistoryId] = React.useState<string | null>(null);
  const [selectedHistoryDocument, setSelectedHistoryDocument] = React.useState<SelectedHistoryDocument | null>(null);
  const [showSnapshotModal, setShowSnapshotModal] = React.useState(false);
  const [snapshotModalTab, setSnapshotModalTab] = React.useState<SnapshotModalTab>('overview');
  const [selectedStorageKey, setSelectedStorageKey] = React.useState<string | null>(null);
  const [selectedProfilesPrinterId, setSelectedProfilesPrinterId] = React.useState<string | null>(null);

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

  const loadStatus = React.useCallback(async (showSpinner = true) => {
    if (showSpinner) {
      setLoadingStatus(true);
    }

    try {
      const next = await fetchStatus();
      const alignedUrl = shouldAlignToExpectedOrigin(next.expectedOrigin);
      if (alignedUrl) {
        window.location.assign(alignedUrl);
        return;
      }

      setStatus(next);
      if (next.ok) {
        writeCachedStatus(next);
      }
      if (!next.ok && next.error) {
        setMessage({ kind: 'error', text: next.error });
      }
    } catch (error) {
      setStatus({ ok: false, configured: false, authenticated: false, error: 'Failed to load backup status.' });
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to load backup status.' });
    } finally {
      if (showSpinner) {
        setLoadingStatus(false);
      }
    }
  }, []);

  const loadHistory = React.useCallback(async () => {
    setHistoryLoading(true);
    try {
      const response = await fetch('/api/backups/github/history', { cache: 'no-store' });
      const payload = await response.json().catch(() => null) as HistoryListResponse | null;
      if (!response.ok || !payload?.ok || !payload.items) {
        throw new Error(payload?.error || 'Failed to load backup history.');
      }
      setHistoryItems(payload.items);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to load backup history.' });
    } finally {
      setHistoryLoading(false);
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

  const handleViewHistory = React.useCallback(async (id: string) => {
    setSelectedHistoryId(id);
    setSelectedHistoryDocument(null);
    setSelectedStorageKey(null);
    setSnapshotModalTab('overview');
    setShowSnapshotModal(true);
    try {
      const response = await fetch(`/api/backups/github/history/${encodeURIComponent(id)}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => null) as HistoryItemResponse | null;
      if (!response.ok || !payload?.ok || !payload.item) {
        throw new Error(payload?.error || 'Failed to load backup snapshot.');
      }
      setSelectedHistoryDocument(payload.item.document);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to load backup snapshot.' });
      setShowSnapshotModal(false);
      setSelectedHistoryId(null);
    }
  }, []);

  const handleDeleteHistory = React.useCallback(async (id: string) => {
    if (!window.confirm('Delete this backup snapshot from GitHub history? This cannot be undone.')) return;

    try {
      const response = await fetch(`/api/backups/github/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to delete backup snapshot.');
      }

      if (selectedHistoryId === id) {
        setSelectedHistoryId(null);
        setSelectedHistoryDocument(null);
        setShowSnapshotModal(false);
      }

      await loadHistory();
      setMessage({ kind: 'success', text: 'Backup snapshot deleted.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to delete backup snapshot.' });
    }
  }, [loadHistory, selectedHistoryId]);

  const handleRestoreHistory = React.useCallback(async (id: string) => {
    setBusy('restore');
    try {
      const response = await fetch(`/api/backups/github/history/${encodeURIComponent(id)}/restore`, { method: 'POST' });
      const payload = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to restore backup snapshot.');
      }

      setMessage({ kind: 'success', text: 'Backup restored. Run "Restore Remote" in conflict mode or sync this device if needed.' });
      await Promise.all([loadStatus(false), loadHistory()]);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to restore backup snapshot.' });
    } finally {
      setBusy('none');
    }
  }, [loadHistory, loadStatus]);

  React.useEffect(() => {
    const cached = readCachedStatus();
    if (cached) {
      setStatus(cached);
      setLoadingStatus(false);
      void loadStatus(false);
      return;
    }

    void loadStatus(true);
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

  React.useEffect(() => {
    const authenticated = Boolean(status?.authenticated);
    const repoExists = Boolean(status?.repository?.exists);
    const hasAnySync = Boolean(status?.remoteUpdatedAt || lastLocalSyncAt);
    const setupComplete = authenticated && repoExists && hasAnySync;

    if (!setupComplete) return;
    void loadHistory();
  }, [lastLocalSyncAt, loadHistory, status?.authenticated, status?.remoteUpdatedAt, status?.repository?.exists]);

  React.useEffect(() => {
    const keys = Object.keys(selectedHistoryDocument?.snapshot.localStorage ?? {});
    if (keys.length === 0) {
      setSelectedStorageKey(null);
      return;
    }

    setSelectedStorageKey((prev) => (prev && keys.includes(prev) ? prev : keys[0]));
  }, [selectedHistoryDocument]);

  const authenticated = Boolean(status?.authenticated);
  const backupsConfigured = Boolean(status?.configured);
  const repoExists = Boolean(status?.repository?.exists);
  const hasAnySync = Boolean(status?.remoteUpdatedAt || lastLocalSyncAt);
  const setupComplete = authenticated && repoExists && hasAnySync;
  const parsedProfiles = React.useMemo(() => (
    parseProfilesSnapshot(selectedHistoryDocument?.snapshot.profiles)
  ), [selectedHistoryDocument?.snapshot.profiles]);

  const activePrinter = React.useMemo(() => {
    if (!parsedProfiles?.activePrinterProfileId) return null;
    return parsedProfiles.printerProfiles.find((p) => p.id === parsedProfiles.activePrinterProfileId) ?? null;
  }, [parsedProfiles]);

  const activeMaterial = React.useMemo(() => {
    if (!parsedProfiles?.activeMaterialProfileId) return null;
    return parsedProfiles.materialProfiles.find((m) => m.id === parsedProfiles.activeMaterialProfileId) ?? null;
  }, [parsedProfiles]);

  const selectedProfilesPrinter = React.useMemo(() => (
    parsedProfiles?.printerProfiles.find((p) => p.id === selectedProfilesPrinterId) ?? null
  ), [parsedProfiles, selectedProfilesPrinterId]);

  const filteredMaterialsForSelectedPrinter = React.useMemo(() => {
    if (!parsedProfiles || !selectedProfilesPrinterId) return [] as ParsedMaterialProfile[];
    return parsedProfiles.materialProfiles.filter((m) => m.printerProfileId === selectedProfilesPrinterId);
  }, [parsedProfiles, selectedProfilesPrinterId]);

  React.useEffect(() => {
    const printers = parsedProfiles?.printerProfiles ?? [];
    if (printers.length === 0) {
      setSelectedProfilesPrinterId(null);
      return;
    }

    setSelectedProfilesPrinterId((prev) => {
      if (prev && printers.some((p) => p.id === prev)) return prev;
      if (parsedProfiles?.activePrinterProfileId && printers.some((p) => p.id === parsedProfiles.activePrinterProfileId)) {
        return parsedProfiles.activePrinterProfileId;
      }
      return printers[0]?.id ?? null;
    });
  }, [parsedProfiles]);

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
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Private GitHub Backups</h3>
                <div className="relative group">
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full border transition-colors"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--accent-secondary)' }}
                    aria-label="View privacy commitments"
                  >
                    <CircleHelp className="h-3.5 w-3.5" />
                  </button>
                  <div
                    className="pointer-events-none absolute left-0 top-[calc(100%+8px)] z-20 w-[min(440px,calc(100vw-32px))] rounded-md border p-3 text-xs leading-relaxed opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-strong)' }}
                  >
                    <p>
                      Backups are stored in your own private GitHub repository. Dragonfruit does not run a central backup server and does not keep a copy of your backup data outside your repository.
                    </p>
                    <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
                      You can disconnect GitHub at any time. OAuth access is used only for repository checks and syncing backup files.
                    </p>
                  </div>
                </div>
              </div>
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
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              Run a sync, verify repository readiness, or disconnect this GitHub account.
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <button
                type="button"
                onClick={() => { void runSync(false); }}
                disabled={busy !== 'none' || !authenticated}
                className="ui-button ui-button-primary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
              >
                {busy === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Backup Now
              </button>

              <button
                type="button"
                onClick={() => { void handleEnsureRepo(); }}
                disabled={busy !== 'none' || !authenticated}
                className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
              >
                {busy === 'ensure' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
                Verify Repo
              </button>

              <button
                type="button"
                onClick={() => { void handleDisconnect(); }}
                disabled={busy !== 'none' || !authenticated}
                className="ui-button ui-button-danger !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
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
            <div className="mt-2 grid gap-2">
              <div className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Enable automatic backups</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Automatically sync to your private GitHub backup on an interval.</div>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoSyncEnabled((prev) => !prev)}
                  className="h-10 min-w-[92px] rounded-md border px-3 text-[12px] font-semibold uppercase tracking-wide transition-colors"
                  aria-pressed={autoSyncEnabled}
                  style={autoSyncEnabled
                    ? {
                        borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-0) 76%)',
                        color: 'var(--accent-contrast)',
                      }
                    : {
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--surface-1)',
                        color: 'var(--text-muted)',
                      }}
                >
                  {autoSyncEnabled ? 'ON' : 'OFF'}
                </button>
              </div>

              <div
                className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-3"
                style={{
                  borderColor: 'var(--border-subtle)',
                  background: 'var(--surface-1)',
                  opacity: autoSyncEnabled ? 1 : 0.68,
                }}
              >
                <div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Sync interval</div>
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Minutes between automatic sync attempts.</div>
                </div>
                <div className="inline-flex items-center gap-2">
                  <NumberInput
                    min={1}
                    max={240}
                    step={1}
                    value={autoSyncMinutes}
                    onChange={(next) => {
                      if (!Number.isFinite(next)) return;
                      setAutoSyncMinutes(Math.max(1, Math.min(240, Math.round(next))));
                    }}
                    className="ui-input h-[34px] w-[120px] pl-2.5 pr-5 py-1.5 text-sm"
                    disabled={!autoSyncEnabled}
                  />
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>min</span>
                </div>
              </div>
            </div>

            <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              Last local sync: {lastLocalSyncAt ? new Date(lastLocalSyncAt).toLocaleString() : 'never'}
            </div>
          </div>

          <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Manage Backups</div>
                <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>View, restore, or delete older snapshots from your private repository.</div>
              </div>
              <button
                type="button"
                onClick={() => { void loadHistory(); }}
                disabled={historyLoading}
                className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
              >
                {historyLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
                Refresh
              </button>
            </div>

            <div className="mt-2">
              <div className="max-h-64 overflow-auto rounded-md border custom-scrollbar" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                {historyItems.length === 0 ? (
                  <div className="px-3 py-3 text-xs" style={{ color: 'var(--text-muted)' }}>
                    No history snapshots yet. New syncs will appear here.
                  </div>
                ) : (
                  <ul className="p-1.5 space-y-1.5">
                    {historyItems.map((item) => (
                      <li key={item.id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                        <button
                          type="button"
                          onClick={() => { void handleViewHistory(item.id); }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className="truncate text-xs font-medium" style={{ color: 'var(--text-strong)' }}>
                            {new Date(item.createdAt).toLocaleString()}
                          </div>
                          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            ID {item.id}
                          </div>
                        </button>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => { void handleViewHistory(item.id); }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded border transition-colors"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--accent-secondary)' }}
                            title="View snapshot"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => { void handleDeleteHistory(item.id); }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded border"
                            style={{ borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 55%)', color: '#fca5a5' }}
                            title="Delete snapshot"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {showSnapshotModal && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 ui-modal-backdrop-enter"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowSnapshotModal(false);
            }
          }}
        >
          <div className="w-full max-w-6xl h-[820px] max-h-[94vh] flex flex-col rounded-xl border shadow-2xl overflow-hidden ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
            <div className="flex items-center justify-between gap-2 px-4 py-3" style={{ background: 'color-mix(in srgb, var(--surface-1), transparent 8%)' }}>
              <div>
                <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Backup Snapshot Content
                </h4>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {selectedHistoryId ? `Snapshot ${new Date(Number(selectedHistoryId)).toLocaleString()}` : 'Loading snapshot...'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {selectedHistoryId && (
                  <button
                    type="button"
                    onClick={() => { void handleRestoreHistory(selectedHistoryId); }}
                    disabled={busy !== 'none'}
                    className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
                    style={{ color: 'var(--accent-secondary)' }}
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    Restore as Current
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setShowSnapshotModal(false)}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-md border transition-colors"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)', background: 'var(--surface-1)' }}
                  aria-label="Close snapshot details"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-hidden px-4 py-3">
              {!selectedHistoryId || !selectedHistoryDocument ? (
                <div className="h-full min-h-0 flex items-center justify-center">
                  <div className="inline-flex items-center gap-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading snapshot content…
                  </div>
                </div>
              ) : (
                <div className="h-full min-h-0 grid gap-3 lg:grid-cols-[190px_minmax(0,1fr)]">
                  <aside className="h-full min-h-0 rounded-lg border p-2 overflow-auto custom-scrollbar" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    {([
                      { id: 'overview' as const, label: 'Overview' },
                      { id: 'localStorage' as const, label: 'Local Storage' },
                      { id: 'profiles' as const, label: 'Profiles' },
                      { id: 'raw' as const, label: 'Raw JSON' },
                    ]).map((tab) => (
                      <button
                        key={tab.id}
                        type="button"
                        onClick={() => setSnapshotModalTab(tab.id)}
                        className="w-full text-left rounded-md px-2 py-1.5 text-xs font-medium transition-colors"
                        style={snapshotModalTab === tab.id
                          ? {
                              background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 88%)',
                              color: 'var(--accent-secondary)',
                              border: '1px solid color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 40%)',
                            }
                          : {
                              color: 'var(--text-muted)',
                              border: '1px solid transparent',
                            }}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </aside>

                  <div className="h-full min-h-0 rounded-lg border p-3 overflow-hidden flex flex-col" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    {snapshotModalTab === 'overview' && (
                      <div className="h-full min-h-0 overflow-auto custom-scrollbar pr-1">
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                          <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Snapshot ID</div>
                            <div className="mt-1 text-xs font-medium" style={{ color: 'var(--text-strong)' }}>{selectedHistoryId}</div>
                          </div>
                          <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Document Updated</div>
                            <div className="mt-1 text-xs font-medium" style={{ color: 'var(--text-strong)' }}>{new Date(selectedHistoryDocument.updatedAt).toLocaleString()}</div>
                          </div>
                          <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Client ID</div>
                            <div className="mt-1 text-xs font-medium break-all" style={{ color: 'var(--text-strong)' }}>{selectedHistoryDocument.snapshot.clientId}</div>
                          </div>
                          <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                            <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>LocalStorage Keys</div>
                            <div className="mt-1 text-xs font-medium" style={{ color: 'var(--text-strong)' }}>{Object.keys(selectedHistoryDocument.snapshot.localStorage ?? {}).length}</div>
                          </div>
                        </div>
                      </div>
                    )}

                    {snapshotModalTab === 'localStorage' && (
                      <div className="h-full min-h-0 grid gap-2 lg:grid-cols-[minmax(220px,30%)_minmax(0,1fr)]">
                        <div className="rounded-md border p-1.5 min-h-0 overflow-auto custom-scrollbar" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                          {Object.keys(selectedHistoryDocument.snapshot.localStorage ?? {}).length === 0 ? (
                            <div className="px-2 py-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>No LocalStorage keys found.</div>
                          ) : (
                            Object.keys(selectedHistoryDocument.snapshot.localStorage ?? {}).map((key) => (
                              <button
                                key={key}
                                type="button"
                                onClick={() => setSelectedStorageKey(key)}
                                className="mb-1 last:mb-0 w-full rounded-md border px-2 py-1.5 text-left text-xs transition-colors"
                                style={selectedStorageKey === key
                                  ? {
                                      borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)',
                                      background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
                                      color: 'var(--accent-secondary)',
                                    }
                                  : {
                                      borderColor: 'var(--border-subtle)',
                                      background: 'var(--surface-1)',
                                      color: 'var(--text-muted)',
                                    }}
                              >
                                {key}
                              </button>
                            ))
                          )}
                        </div>

                        <div className="rounded-md border p-2.5 min-h-0 flex flex-col" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                          <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>
                            {selectedStorageKey ?? 'Select a key'}
                          </div>
                          <pre className="mt-2 flex-1 min-h-0 w-full rounded-md border p-2 text-[11px] leading-relaxed overflow-auto custom-scrollbar whitespace-pre" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
                            {selectedStorageKey
                              ? stringifyReadable((selectedHistoryDocument.snapshot.localStorage ?? {})[selectedStorageKey])
                              : 'Select a LocalStorage key from the left to view its value.'}
                          </pre>
                        </div>
                      </div>
                    )}

                    {snapshotModalTab === 'profiles' && (
                      parsedProfiles ? (
                        <div className="h-full min-h-0 grid gap-2 lg:grid-cols-[minmax(230px,32%)_minmax(0,1fr)]">
                          <div className="rounded-md border p-2 min-h-0 overflow-auto custom-scrollbar" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                            <div className="text-[10px] uppercase tracking-wide font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                              Printer Profiles ({parsedProfiles.printerProfiles.length})
                            </div>
                            <div className="space-y-1.5">
                              {parsedProfiles.printerProfiles.length === 0 ? (
                                <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No printer profiles.</div>
                              ) : parsedProfiles.printerProfiles.map((printer) => {
                                const isSelected = selectedProfilesPrinterId === printer.id;
                                const isActiveSnapshot = parsedProfiles.activePrinterProfileId === printer.id;
                                const materialCount = parsedProfiles.materialProfiles.filter((m) => m.printerProfileId === printer.id).length;
                                return (
                                  <button
                                    key={printer.id}
                                    type="button"
                                    onClick={() => setSelectedProfilesPrinterId(printer.id)}
                                    className="w-full rounded-md border p-2 text-left transition-colors"
                                    style={{
                                      borderColor: isSelected
                                        ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)'
                                        : 'var(--border-subtle)',
                                      background: isSelected
                                        ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 94%)'
                                        : 'var(--surface-1)',
                                    }}
                                  >
                                    <div className="flex items-center justify-between gap-2">
                                      <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{printer.name ?? printer.id}</div>
                                      {isActiveSnapshot && <span className="text-[10px] font-semibold" style={{ color: 'var(--accent-secondary)' }}>ACTIVE</span>}
                                    </div>
                                    <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                      {printer.manufacturer ?? 'Unknown manufacturer'}
                                    </div>
                                    <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                      {materialCount} material{materialCount === 1 ? '' : 's'}
                                    </div>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="rounded-md border p-2 min-h-0 overflow-auto custom-scrollbar" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
                            {!selectedProfilesPrinter ? (
                              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>Select a printer profile to view details.</div>
                            ) : (
                              <div className="space-y-2">
                                <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{selectedProfilesPrinter.name ?? selectedProfilesPrinter.id}</div>
                                  <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    {selectedProfilesPrinter.manufacturer ?? 'Unknown manufacturer'}
                                    {selectedProfilesPrinter.networkSupport ? ` • ${selectedProfilesPrinter.networkSupport}` : ''}
                                  </div>
                                  <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    Build: {selectedProfilesPrinter.buildVolumeMm?.width ?? '-'} × {selectedProfilesPrinter.buildVolumeMm?.depth ?? '-'} × {selectedProfilesPrinter.buildVolumeMm?.height ?? '-'} mm
                                  </div>
                                  <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                    Display: {selectedProfilesPrinter.display?.resolutionX ?? '-'} × {selectedProfilesPrinter.display?.resolutionY ?? '-'}{selectedProfilesPrinter.display?.outputFormat ? ` (${selectedProfilesPrinter.display.outputFormat})` : ''}
                                  </div>
                                </div>

                                <div className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                                  <div className="text-[10px] uppercase tracking-wide font-semibold mb-2" style={{ color: 'var(--text-muted)' }}>
                                    Materials for this printer ({filteredMaterialsForSelectedPrinter.length})
                                  </div>
                                  <div className="space-y-1.5">
                                    {filteredMaterialsForSelectedPrinter.length === 0 ? (
                                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No materials linked to this printer.</div>
                                    ) : filteredMaterialsForSelectedPrinter.map((material) => {
                                      const isActiveSnapshot = parsedProfiles.activeMaterialProfileId === material.id;
                                      return (
                                        <div key={material.id} className="rounded-md border p-2" style={{
                                          borderColor: isActiveSnapshot
                                            ? 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)'
                                            : 'var(--border-subtle)',
                                          background: isActiveSnapshot
                                            ? 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 94%)'
                                            : 'var(--surface-0)',
                                        }}>
                                          <div className="flex items-center justify-between gap-2">
                                            <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{material.name ?? material.id}</div>
                                            {isActiveSnapshot && <span className="text-[10px] font-semibold" style={{ color: 'var(--accent-secondary)' }}>ACTIVE</span>}
                                          </div>
                                          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                            {material.brand ?? 'Unknown brand'}{material.resinFamily ? ` • ${material.resinFamily}` : ''}
                                          </div>
                                          <div className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                                            Layer {material.layerHeightMm ?? '-'} mm • Normal {material.normalExposureSec ?? '-'}s • Bottom {material.bottomExposureSec ?? '-'}s × {material.bottomLayerCount ?? '-'}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      ) : (
                        <pre className="rounded-md border p-2 text-[11px] leading-relaxed overflow-auto custom-scrollbar" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-muted)', maxHeight: '56vh' }}>
                          {stringifyReadable(selectedHistoryDocument.snapshot.profiles ?? null)}
                        </pre>
                      )
                    )}

                    {snapshotModalTab === 'raw' && (
                      <pre className="flex-1 min-h-0 rounded-md border p-2 text-[11px] leading-relaxed overflow-auto custom-scrollbar whitespace-pre" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-muted)' }}>
                        {stringifyReadable(selectedHistoryDocument)}
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

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
