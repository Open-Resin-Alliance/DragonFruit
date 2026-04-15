'use client';

import React from 'react';
import { AlertTriangle, ArchiveRestore, CheckCircle2, CircleHelp, Eye, FolderOpen, HardDrive, Loader2, RefreshCcw, Trash2, UploadCloud, X } from 'lucide-react';
import { getProfileStoreSnapshot } from '@/features/profiles/profileStore';
import { NumberInput } from '@/components/ui/NumberInput';
import { generateUuid } from '@/utils/uuid';

type BackupSnapshot = {
  version: number;
  updatedAt: string;
  clientId: string;
  localStorage: Record<string, string>;
  profiles?: unknown;
};

type BackupDocument = {
  source?: string;
  schemaVersion?: number;
  updatedAt: string;
  snapshot: BackupSnapshot;
};

type LocalBackupStateResponse = {
  documentJson?: string | null;
  updatedAt?: string | null;
};

type LocalBackupSyncResponse = {
  syncedAt: string;
  historyId: string;
  statePath: string;
  historyPath: string;
};

type LocalBackupHistoryEntry = {
  id: string;
  path: string;
  updatedAt?: string | null;
};

type LocalBackupReadHistoryResponse = {
  documentJson: string;
};

type SelectedHistoryDocument = BackupDocument;
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

const AUTO_SYNC_ENABLED_KEY = 'dragonfruit-local-backups:auto-sync-enabled';
const AUTO_SYNC_MINUTES_KEY = 'dragonfruit-local-backups:auto-sync-minutes';
const CLIENT_ID_KEY = 'dragonfruit-local-backups:client-id';
const LAST_SYNC_AT_KEY = 'dragonfruit-local-backups:last-sync-at';
const SELECTED_DIRECTORY_KEY = 'dragonfruit-local-backups:directory';

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
  SELECTED_DIRECTORY_KEY,
];

function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeDesktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktopRuntime()) {
    throw new Error('Local backups are only available in the DragonFruit desktop build.');
  }

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

function parseBackupDocument(raw: string): BackupDocument | null {
  try {
    const parsed = JSON.parse(raw) as BackupDocument;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!parsed.snapshot || typeof parsed.snapshot !== 'object') return null;
    if (!parsed.updatedAt || typeof parsed.updatedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function getOrCreateClientId(): string {
  if (typeof window === 'undefined') return 'server';
  const existing = window.localStorage.getItem(CLIENT_ID_KEY)?.trim();
  if (existing) return existing;

  const created = generateUuid();
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

function applySnapshotToLocalApp(snapshot: BackupSnapshot): void {
  if (typeof window === 'undefined') return;

  for (const [key, value] of Object.entries(snapshot.localStorage ?? {})) {
    window.localStorage.setItem(key, value);
  }

  window.localStorage.setItem(LAST_SYNC_AT_KEY, new Date().toISOString());
  window.location.reload();
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

function classifyJsonToken(token: string): 'key' | 'string' | 'number' | 'boolean' | 'null' {
  if (token.startsWith('"')) {
    return /:\s*$/.test(token) ? 'key' : 'string';
  }
  if (token === 'true' || token === 'false') return 'boolean';
  if (token === 'null') return 'null';
  return 'number';
}

function renderHighlightedJson(raw: string): React.ReactNode {
  const jsonTokenRegex = /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"\s*:|"(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)/g;
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let matchIndex = 0;

  const getTokenColor = (kind: ReturnType<typeof classifyJsonToken>) => {
    switch (kind) {
      case 'key':
        return '#f472b6';
      case 'string':
        return '#a5b4fc';
      case 'number':
        return '#facc15';
      case 'boolean':
        return '#22d3ee';
      case 'null':
        return '#94a3b8';
      default:
        return 'var(--text-muted)';
    }
  };

  for (const match of raw.matchAll(jsonTokenRegex)) {
    const token = match[0];
    const index = match.index ?? 0;

    if (index > lastIndex) {
      nodes.push(raw.slice(lastIndex, index));
    }

    const kind = classifyJsonToken(token);
    nodes.push(
      <span key={`json-token-${matchIndex}`} style={{ color: getTokenColor(kind) }}>
        {token}
      </span>,
    );

    lastIndex = index + token.length;
    matchIndex += 1;
  }

  if (lastIndex < raw.length) {
    nodes.push(raw.slice(lastIndex));
  }

  return nodes;
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

function formatHistoryDate(item: LocalBackupHistoryEntry): string {
  if (item.updatedAt) {
    const ts = Date.parse(item.updatedAt);
    if (Number.isFinite(ts)) {
      return new Date(ts).toLocaleString();
    }
  }

  const numericId = Number(item.id);
  if (Number.isFinite(numericId)) {
    return new Date(numericId).toLocaleString();
  }

  return item.id;
}

export function LocalBackupsSettingsTab() {
  const [desktopAvailable] = React.useState<boolean>(() => isDesktopRuntime());
  const [loadingStatus, setLoadingStatus] = React.useState(true);
  const [busy, setBusy] = React.useState<'none' | 'choose-directory' | 'sync' | 'restore' | 'reveal'>('none');
  const [message, setMessage] = React.useState<{ kind: 'idle' | 'success' | 'error'; text: string }>({ kind: 'idle', text: '' });

  const [defaultDirectory, setDefaultDirectory] = React.useState<string>('');
  const [selectedDirectory, setSelectedDirectory] = React.useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem(SELECTED_DIRECTORY_KEY)?.trim() ?? '';
  });

  const [stateUpdatedAt, setStateUpdatedAt] = React.useState<string | null>(null);
  const [lastLocalSyncAt, setLastLocalSyncAt] = React.useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(LAST_SYNC_AT_KEY);
  });

  const [historyItems, setHistoryItems] = React.useState<LocalBackupHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);

  const [selectedHistoryId, setSelectedHistoryId] = React.useState<string | null>(null);
  const [selectedHistoryDocument, setSelectedHistoryDocument] = React.useState<SelectedHistoryDocument | null>(null);
  const [showSnapshotModal, setShowSnapshotModal] = React.useState(false);
  const [confirmRestoreId, setConfirmRestoreId] = React.useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = React.useState<string | null>(null);
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

  const loadState = React.useCallback(async (directoryOverride?: string) => {
    const targetDirectory = (directoryOverride ?? selectedDirectory).trim();
    if (!targetDirectory) {
      setStateUpdatedAt(null);
      return;
    }

    const payload = await invokeDesktop<LocalBackupStateResponse>('local_backup_read_state', {
      directoryPath: targetDirectory,
    });

    setStateUpdatedAt(payload.updatedAt ?? null);
  }, [selectedDirectory]);

  const loadHistory = React.useCallback(async (directoryOverride?: string) => {
    const targetDirectory = (directoryOverride ?? selectedDirectory).trim();
    if (!targetDirectory) {
      setHistoryItems([]);
      return;
    }

    setHistoryLoading(true);
    try {
      const items = await invokeDesktop<LocalBackupHistoryEntry[]>('local_backup_list_history', {
        directoryPath: targetDirectory,
      });
      setHistoryItems(items);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to load local backup history.' });
    } finally {
      setHistoryLoading(false);
    }
  }, [selectedDirectory]);

  const runSync = React.useCallback(async () => {
    const targetDirectory = selectedDirectory.trim();
    if (!targetDirectory) {
      setMessage({ kind: 'error', text: 'Choose a local backup directory before syncing.' });
      return;
    }

    setBusy('sync');
    setMessage({ kind: 'idle', text: '' });

    try {
      const snapshot = collectSnapshot();
      const document: BackupDocument = {
        source: 'dragonfruit',
        schemaVersion: 1,
        updatedAt: snapshot.updatedAt,
        snapshot,
      };

      const payload = await invokeDesktop<LocalBackupSyncResponse>('local_backup_sync', {
        directoryPath: targetDirectory,
        documentJson: JSON.stringify(document),
      });

      const syncedAt = payload.syncedAt?.trim() || snapshot.updatedAt;
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LAST_SYNC_AT_KEY, syncedAt);
      }
      setLastLocalSyncAt(syncedAt);
      setStateUpdatedAt(syncedAt);

      setMessage({ kind: 'success', text: 'Backup saved to local disk.' });
      await loadHistory(targetDirectory);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Local backup sync failed.' });
    } finally {
      setBusy('none');
    }
  }, [loadHistory, selectedDirectory]);

  const handleChooseDirectory = React.useCallback(async () => {
    setBusy('choose-directory');
    setMessage({ kind: 'idle', text: '' });

    try {
      const nextDirectory = await invokeDesktop<string>('local_backup_pick_directory', {
        currentPath: selectedDirectory || defaultDirectory || undefined,
      });

      const trimmed = nextDirectory.trim();
      setSelectedDirectory(trimmed);
      await Promise.all([loadState(trimmed), loadHistory(trimmed)]);
      setMessage({ kind: 'success', text: 'Local backup directory updated.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to choose local backup directory.' });
    } finally {
      setBusy('none');
    }
  }, [defaultDirectory, loadHistory, loadState, selectedDirectory]);

  const handleUseDefaultDirectory = React.useCallback(async () => {
    if (!defaultDirectory) return;

    const nextDirectory = defaultDirectory.trim();
    setSelectedDirectory(nextDirectory);
    await Promise.all([loadState(nextDirectory), loadHistory(nextDirectory)]);
    setMessage({ kind: 'success', text: 'Using default local backup directory.' });
  }, [defaultDirectory, loadHistory, loadState]);

  const handleRevealDirectory = React.useCallback(async () => {
    const targetDirectory = selectedDirectory.trim();
    if (!targetDirectory) return;

    setBusy('reveal');
    try {
      await invokeDesktop('reveal_in_file_manager', { path: targetDirectory });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to open folder in file manager.' });
    } finally {
      setBusy('none');
    }
  }, [selectedDirectory]);

  const handleViewHistory = React.useCallback(async (id: string) => {
    const targetDirectory = selectedDirectory.trim();
    if (!targetDirectory) return;

    setSelectedHistoryId(id);
    setSelectedHistoryDocument(null);
    setSelectedStorageKey(null);
    setSnapshotModalTab('overview');
    setShowSnapshotModal(true);

    try {
      const payload = await invokeDesktop<LocalBackupReadHistoryResponse>('local_backup_read_history_item', {
        directoryPath: targetDirectory,
        id,
      });

      const parsed = parseBackupDocument(payload.documentJson);
      if (!parsed) {
        throw new Error('Backup snapshot is malformed.');
      }

      setSelectedHistoryDocument(parsed);
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to load backup snapshot.' });
      setShowSnapshotModal(false);
      setSelectedHistoryId(null);
      setSelectedHistoryDocument(null);
    }
  }, [selectedDirectory]);

  const handleDeleteHistory = React.useCallback(async (id: string) => {
    const targetDirectory = selectedDirectory.trim();
    if (!targetDirectory) return;

    try {
      await invokeDesktop<boolean>('local_backup_delete_history_item', {
        directoryPath: targetDirectory,
        id,
      });

      if (selectedHistoryId === id) {
        setSelectedHistoryId(null);
        setSelectedHistoryDocument(null);
        setShowSnapshotModal(false);
      }

      await loadHistory(targetDirectory);
      setMessage({ kind: 'success', text: 'Backup snapshot deleted.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to delete backup snapshot.' });
    }
  }, [loadHistory, selectedDirectory, selectedHistoryId]);

  const handleRestoreHistory = React.useCallback(async (id: string) => {
    const targetDirectory = selectedDirectory.trim();
    if (!targetDirectory) return;

    setBusy('restore');

    try {
      await invokeDesktop('local_backup_restore_history_item', {
        directoryPath: targetDirectory,
        id,
      });

      const restoredSnapshot = selectedHistoryId === id ? selectedHistoryDocument?.snapshot ?? null : null;
      if (restoredSnapshot) {
        applySnapshotToLocalApp(restoredSnapshot);
        return;
      }

      await Promise.all([loadState(targetDirectory), loadHistory(targetDirectory)]);
      setMessage({ kind: 'success', text: 'Snapshot restored to current local backup state.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to restore backup snapshot.' });
    } finally {
      setBusy('none');
    }
  }, [loadHistory, loadState, selectedDirectory, selectedHistoryDocument, selectedHistoryId]);

  React.useEffect(() => {
    if (!desktopAvailable) {
      setLoadingStatus(false);
      return;
    }

    let cancelled = false;

    const init = async () => {
      setLoadingStatus(true);
      try {
        const defaultPath = await invokeDesktop<string>('local_backup_default_directory');
        if (cancelled) return;

        const normalizedDefaultPath = defaultPath.trim();
        setDefaultDirectory(normalizedDefaultPath);

        const nextDirectory = (selectedDirectory.trim() || normalizedDefaultPath);
        setSelectedDirectory(nextDirectory);

        await Promise.all([loadState(nextDirectory), loadHistory(nextDirectory)]);
      } catch (error) {
        if (!cancelled) {
          setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to initialize local backups.' });
        }
      } finally {
        if (!cancelled) {
          setLoadingStatus(false);
        }
      }
    };

    void init();

    return () => {
      cancelled = true;
    };
  }, [desktopAvailable, loadHistory, loadState, selectedDirectory]);

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
    if (!selectedDirectory.trim()) {
      window.localStorage.removeItem(SELECTED_DIRECTORY_KEY);
      return;
    }
    window.localStorage.setItem(SELECTED_DIRECTORY_KEY, selectedDirectory);
  }, [selectedDirectory]);

  React.useEffect(() => {
    if (!desktopAvailable) return;
    if (!autoSyncEnabled) return;
    if (!selectedDirectory.trim()) return;

    const intervalMs = autoSyncMinutes * 60 * 1000;
    const handle = window.setInterval(() => {
      void runSync();
    }, intervalMs);

    return () => window.clearInterval(handle);
  }, [autoSyncEnabled, autoSyncMinutes, desktopAvailable, runSync, selectedDirectory]);

  React.useEffect(() => {
    const keys = Object.keys(selectedHistoryDocument?.snapshot.localStorage ?? {});
    if (keys.length === 0) {
      setSelectedStorageKey(null);
      return;
    }

    setSelectedStorageKey((prev) => (prev && keys.includes(prev) ? prev : keys[0]));
  }, [selectedHistoryDocument]);

  const parsedProfiles = React.useMemo(() => (
    parseProfilesSnapshot(selectedHistoryDocument?.snapshot.profiles)
  ), [selectedHistoryDocument?.snapshot.profiles]);

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

  if (!desktopAvailable) {
    return (
      <div className="rounded-lg border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}>
        Local on-disk backups are currently available in the DragonFruit desktop build only.
      </div>
    );
  }

  const hasAnySync = Boolean(stateUpdatedAt || lastLocalSyncAt);

  return (
    <div className="space-y-3">
      <section className="relative rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-start gap-2.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}>
            <HardDrive className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Local On-Disk Backups</h3>
              <div className="relative group">
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full border transition-colors"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--accent-secondary)' }}
                  aria-label="View local backup details"
                >
                  <CircleHelp className="h-3.5 w-3.5" />
                </button>
                <div
                  className="pointer-events-none absolute left-0 top-[calc(100%+8px)] z-20 w-[min(420px,calc(100vw-32px))] rounded-md border p-3 text-xs leading-relaxed opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-strong)' }}
                >
                  <p>
                    Backups are written directly to your machine. DragonFruit stores `state.json` and timestamped snapshots in `history/*.json` inside your selected backup directory.
                  </p>
                </div>
              </div>
            </div>
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Automatically saves snapshots of your settings and profiles to a folder on your computer.
            </p>
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          {loadingStatus ? (
            <div className="text-xs inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading backup status…
            </div>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Default directory</div>
                <div className="mt-1 text-xs font-medium break-all" style={{ color: 'var(--text-strong)' }}>
                  {defaultDirectory || 'Resolving...'}
                </div>
              </div>

              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Selected directory</div>
                <div className="mt-1 text-xs font-medium break-all" style={{ color: 'var(--text-strong)' }}>
                  {selectedDirectory || 'Not selected'}
                </div>
              </div>

              <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Last backup on disk</div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-strong)' }}>
                  {stateUpdatedAt ? new Date(stateUpdatedAt).toLocaleString() : 'Never'}
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

        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => { void handleUseDefaultDirectory(); }}
            disabled={!defaultDirectory || busy !== 'none'}
            className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          >
            <CheckCircle2 className="h-4 w-4" />
            Use Default Path
          </button>

          <button
            type="button"
            onClick={() => { void handleChooseDirectory(); }}
            disabled={busy !== 'none'}
            className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          >
            {busy === 'choose-directory' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
            Choose Folder
          </button>

          <button
            type="button"
            onClick={() => { void handleRevealDirectory(); }}
            disabled={!selectedDirectory || busy !== 'none'}
            className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
          >
            {busy === 'reveal' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
            Open Folder
          </button>
        </div>
      </section>

      <section className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-center gap-2">
          <RefreshCcw className="h-4 w-4" style={{ color: 'var(--accent-secondary)' }} />
          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Backup Management</h4>
        </div>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Save snapshots to your local backup folder, then review and restore any point-in-time snapshot in-app.
        </p>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Quick actions</div>
          <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Create a snapshot now and refresh history.
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => { void runSync(); }}
              disabled={busy !== 'none' || !selectedDirectory}
              className="ui-button ui-button-primary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              {busy === 'sync' ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Backup Now
            </button>

            <button
              type="button"
              onClick={() => { void loadHistory(); }}
              disabled={busy !== 'none' || historyLoading || !selectedDirectory}
              className="ui-button ui-button-secondary !h-9 !px-3 !py-0 text-sm inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
            >
              {historyLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
              Refresh History
            </button>
          </div>
        </div>

        <div className="mt-2 rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}>
          <div className="text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>Automation</div>
          <div className="mt-2 grid gap-2">
            <div className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div>
                <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Enable automatic backups</div>
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Automatically write snapshots to local disk on an interval.</div>
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
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>Minutes between automatic local backups.</div>
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
              <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>View, restore, or delete older snapshots from disk.</div>
            </div>
            <button
              type="button"
              onClick={() => { void loadHistory(); }}
              disabled={historyLoading || !selectedDirectory}
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
                  {hasAnySync ? 'No history snapshots found in this folder.' : 'No snapshots yet. Run "Backup Now" to create your first local snapshot.'}
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
                          {formatHistoryDate(item)}
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
                          onClick={() => { setConfirmDeleteId(item.id); }}
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

      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmDeleteId(null);
            }
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
            aria-label="Confirm delete snapshot"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #ef4444, var(--surface-1) 88%)',
                    color: '#fca5a5',
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </span>
                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Delete Snapshot
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    {confirmDeleteId ? new Date(Number(confirmDeleteId)).toLocaleString() : ''}
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
                aria-label="Cancel delete"
                onClick={() => { setConfirmDeleteId(null); }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                This snapshot will be permanently deleted from disk. This action cannot be undone.
              </p>
              <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                  onClick={() => { setConfirmDeleteId(null); }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ui-button !h-9 px-3 text-xs inline-flex items-center gap-1.5"
                  style={{
                    borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, #ef4444, var(--surface-1) 86%)',
                    color: '#fca5a5',
                  }}
                  disabled={busy !== 'none'}
                  onClick={() => {
                    const id = confirmDeleteId;
                    setConfirmDeleteId(null);
                    void handleDeleteHistory(id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmRestoreId && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 backdrop-blur-sm px-3"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setConfirmRestoreId(null);
            }
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
            aria-label="Confirm restore snapshot"
          >
            <div className="flex items-center justify-between gap-4 border-b px-5 py-4" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
                  style={{
                    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 55%)',
                    background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 88%)',
                    color: '#f59e0b',
                  }}
                >
                  <AlertTriangle className="h-4 w-4" />
                </span>
                <div className="min-w-0 pr-2">
                  <h2 className="text-base font-semibold leading-tight" style={{ color: 'var(--text-strong)' }}>
                    Restore Snapshot
                  </h2>
                  <p className="mt-0.5 text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
                    Snapshot from {confirmRestoreId ? new Date(Number(confirmRestoreId)).toLocaleString() : ''}
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
                aria-label="Cancel restore"
                onClick={() => { setConfirmRestoreId(null); }}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 p-5">
              <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                This will overwrite your current app settings and profiles with the data from this snapshot, then reload the app. This action cannot be undone.
              </p>
              <div className="flex shrink-0 items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  className="ui-button ui-button-secondary !h-9 px-3 text-xs"
                  onClick={() => { setConfirmRestoreId(null); }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ui-button !h-9 px-3 text-xs inline-flex items-center gap-1.5"
                  style={{
                    borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                    background: 'color-mix(in srgb, #f59e0b, var(--surface-1) 86%)',
                    color: '#fde68a',
                  }}
                  disabled={busy !== 'none'}
                  onClick={() => {
                    const id = confirmRestoreId;
                    setConfirmRestoreId(null);
                    void handleRestoreHistory(id);
                  }}
                >
                  <ArchiveRestore className="h-3.5 w-3.5" />
                  Yes, restore
                </button>
              </div>
            </div>
          </div>
        </div>
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
                    onClick={() => { setConfirmRestoreId(selectedHistoryId); }}
                    disabled={busy !== 'none'}
                    className="ui-button ui-button-secondary !h-8 !px-2.5 !py-0 text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
                    style={{ color: 'var(--accent-secondary)' }}
                  >
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    Restore to App
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
                              ? renderHighlightedJson(stringifyReadable((selectedHistoryDocument.snapshot.localStorage ?? {})[selectedStorageKey]))
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
                        {renderHighlightedJson(stringifyReadable(selectedHistoryDocument))}
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
