'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Plural, Trans } from '@lingui/react/macro';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Github, Info as InfoIcon, LockKeyhole, PackageCheck, PackageOpen, PackagePlus, Plug, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, IconButton, Input, SettingRow, Spinner } from '@/components/atoms';
import { Tooltip } from '@/components/ui/Tooltip';
import { StructuredDialogModal } from '@/components/ui/StructuredDialogModal';
import { isTauriRuntime } from '@/utils/tauriRuntime';
import {
  getSideloadAllowance,
  installSideloadPackage,
  inspectSideloadPackage,
  listSideloadedPlugins,
  pickSideloadPackage,
  removeSideloadedPlugin,
  setSideloadAllowance,
  shortFingerprint,
  type InstalledSideloadedPlugin,
  type SideloadedCapability,
  type SideloadedInspect,
} from '@/features/plugins/sideloadedPlugins';
import {
  getInstalledPlugins,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  installPluginFromManifest,
  subscribeToProfileStore,
  uninstallPlugin,
} from '@/features/profiles/profileStore';
import type { PluginManifest } from '@/features/plugins/pluginRegistry';
import { requestPluginManifest } from '@/features/plugins/pluginManifestClient';
import { PluginStudioModal } from './PluginStudioModal';

const BUILTIN_ATHENA_REPOSITORY_URL = 'https://github.com/Open-Resin-Alliance/DragonFruit';

// Interpolating messages stay at module scope for the same reason.
const passphrasePlaceholder = (pluginName: string) => msg`Passphrase for ${pluginName}`;

// Module scope on purpose: a `msg` descriptor created inside a component can be
// renamed out from under its catalog id by React Compiler.
const SIDELOAD_CAPABILITY_MESSAGES: Record<SideloadedCapability, MessageDescriptor> = {
  slicerEncoder: msg`Slicer encoder`,
  networkOperations: msg`Network operations`,
  fileType: msg`File-type import`,
};

/** One row in the installed list, whichever tier the plugin came from. */
type InstalledPluginRow = {
  key: string;
  id: string;
  name: string;
  version: string;
  description?: string;
  source: 'builtin' | 'github' | 'sideloaded';
  link?: string;
  fingerprint?: string;
  capabilities?: SideloadedCapability[];
  unverified: boolean;
  acceptedAt?: string;
  remove?: () => void;
};

function isOraHostedRepository(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (!/github\.com$/i.test(parsed.hostname)) return false;
    return parsed.pathname.toLowerCase().startsWith('/open-resin-alliance/');
  } catch {
    return false;
  }
}

function truncateRepositoryUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!/github\.com$/i.test(parsed.hostname)) return url;
    // Extract path like "/owner/repo" and remove leading slash
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2) {
      return `${pathParts[0]}/${pathParts[1]}`;
    }
    return url;
  } catch {
    return url;
  }
}

type GithubManifestResponse = {
  ok: boolean;
  error?: string;
  rawManifestUrl?: string;
  manifestSha256?: string;
  repoAllowlisted?: boolean;
  requiresLiabilityWarning?: boolean;
  unverifiedRepo?: {
    owner: string;
    name: string;
  };
  allowlistRules?: string[];
  manifest?: {
    schemaVersion: number;
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    homepage?: string;
    printerPresets?: unknown[];
    materialTemplates?: unknown[];
  };
};

function normalizePluginManifest(input: GithubManifestResponse['manifest']): PluginManifest | null {
  if (!input) return null;
  const id = typeof input.id === 'string' ? input.id.trim() : '';
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const version = typeof input.version === 'string' ? input.version.trim() : '';
  if (!id || !name || !version) return null;

  return {
    schemaVersion: Number.isFinite(Number(input.schemaVersion)) ? Number(input.schemaVersion) : 1,
    id,
    name,
    version,
    description: typeof input.description === 'string' ? input.description : undefined,
    author: typeof input.author === 'string' ? input.author : undefined,
    homepage: typeof input.homepage === 'string' ? input.homepage : undefined,
    printerPresets: Array.isArray(input.printerPresets) ? input.printerPresets as any : [],
    materialTemplates: Array.isArray(input.materialTemplates) ? input.materialTemplates as any : [],
  };
}

export function PluginsSettingsTab() {
  const { _ } = useLingui();
  React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);

  const [isLightTheme, setIsLightTheme] = React.useState(false);
  const [repoUrl, setRepoUrl] = React.useState('');
  const [studioOpen, setStudioOpen] = React.useState(false);
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [pendingLiabilityInstall, setPendingLiabilityInstall] = React.useState<{
    repoUrl: string;
    unverifiedRepo?: { owner: string; name: string };
    allowlistRules?: string[];
  } | null>(null);
  const [pendingInstallPreview, setPendingInstallPreview] = React.useState<{
    repoUrl: string;
    manifest: PluginManifest;
    manifestSha256?: string;
    trust: 'allowlisted' | 'unverified-user-approved';
    liabilityAcceptedAt?: string;
    originUrl?: string;
  } | null>(null);
  const [pendingRemovePlugin, setPendingRemovePlugin] = React.useState<{ id: string; name: string } | null>(null);
  const [status, setStatus] = React.useState<{ kind: 'idle' | 'success' | 'error'; message: string }>({ kind: 'idle', message: '' });
  const isDevRuntime = process.env.NODE_ENV === 'development';

  // Sideloaded complex plugins exist only in the desktop shell: the web build has
  // no app data dir and no place to put a native binary.
  const [isDesktop, setIsDesktop] = React.useState(false);
  const [allowSideload, setAllowSideload] = React.useState(false);
  // Sideloading is a semi-hidden switch behind the card's cog: enabling it asks
  // for an explicit acknowledgement instead of being a row a user can flip by accident.
  const [allowanceDialogOpen, setAllowanceDialogOpen] = React.useState(false);
  const [sideloadPlugins, setSideloadPlugins] = React.useState<InstalledSideloadedPlugin[]>([]);
  const [sideloadBusy, setSideloadBusy] = React.useState(false);
  const [pendingSideload, setPendingSideload] = React.useState<{ path: string; info: SideloadedInspect } | null>(null);
  const [sideloadPassphrase, setSideloadPassphrase] = React.useState('');
  // Sealed packages finish in a second, focused step so the passphrase is not a
  // field a user can scroll past on a long review sheet.
  const [passphraseOpen, setPassphraseOpen] = React.useState(false);
  const [passphraseError, setPassphraseError] = React.useState<string | null>(null);
  const [pendingRemoveSideload, setPendingRemoveSideload] = React.useState<InstalledSideloadedPlugin | null>(null);
  // A fresh install is announced by the row itself, not by a green line above the
  // list: one glow that fades after three seconds.
  const [recentlyInstalledKey, setRecentlyInstalledKey] = React.useState<string | null>(null);
  const highlightTimerRef = React.useRef<number | null>(null);

  const highlightInstalledRow = React.useCallback((key: string) => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    setRecentlyInstalledKey(key);
    highlightTimerRef.current = window.setTimeout(() => {
      setRecentlyInstalledKey(null);
      highlightTimerRef.current = null;
    }, 3_000);
  }, []);

  React.useEffect(() => () => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
  }, []);

  React.useEffect(() => {
    setIsDesktop(isTauriRuntime());
  }, []);

  React.useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void (async () => {
      try {
        const [allow, installed] = await Promise.all([
          getSideloadAllowance(),
          listSideloadedPlugins(),
        ]);
        if (cancelled) return;
        setAllowSideload(allow);
        setSideloadPlugins(installed);
      } catch (error) {
        if (!cancelled) {
          setStatus({ kind: 'error', message: String(error) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDesktop]);

  const refreshSideloaded = React.useCallback(async () => {
    setSideloadPlugins(await listSideloadedPlugins());
  }, []);

  const handleSideloadAllowanceChange = React.useCallback(async (next: boolean) => {
    setAllowSideload(next);
    setStatus({ kind: 'idle', message: '' });
    try {
      await setSideloadAllowance(next);
      await refreshSideloaded();
    } catch (error) {
      setAllowSideload(!next);
      setStatus({ kind: 'error', message: String(error) });
    }
  }, [refreshSideloaded]);

  const handlePickSideloadPackage = React.useCallback(async () => {
    setStatus({ kind: 'idle', message: '' });
    try {
      const path = await pickSideloadPackage();
      if (!path) return;
      const info = await inspectSideloadPackage(path);
      setSideloadPassphrase('');
      setPendingSideload({ path, info });
    } catch (error) {
      setStatus({ kind: 'error', message: String(error) });
    }
  }, []);

  const closePassphraseDialog = React.useCallback(() => {
    setPassphraseOpen(false);
    setSideloadPassphrase('');
    setPassphraseError(null);
  }, []);

  const handleConfirmSideloadInstall = React.useCallback(async () => {
    if (!pendingSideload) return;
    const sealed = pendingSideload.info.sealed;
    setSideloadBusy(true);
    setPassphraseError(null);
    setStatus({ kind: 'idle', message: '' });
    try {
      const installed = await installSideloadPackage(
        pendingSideload.path,
        sealed ? sideloadPassphrase : undefined,
      );
      await refreshSideloaded();
      setPendingSideload(null);
      closePassphraseDialog();
      highlightInstalledRow(`sideloaded:${installed.manifest.id}`);
    } catch (error) {
      // A wrong passphrase belongs next to the field that produced it.
      if (sealed) {
        setPassphraseError(String(error));
      } else {
        setStatus({ kind: 'error', message: String(error) });
      }
    } finally {
      setSideloadBusy(false);
    }
  }, [closePassphraseDialog, highlightInstalledRow, pendingSideload, refreshSideloaded, sideloadPassphrase]);

  const handleConfirmRemoveSideload = React.useCallback(async () => {
    if (!pendingRemoveSideload) return;
    const target = pendingRemoveSideload;
    setPendingRemoveSideload(null);
    setSideloadBusy(true);
    try {
      await removeSideloadedPlugin(target.manifest.id);
      await refreshSideloaded();
    } catch (error) {
      setStatus({ kind: 'error', message: String(error) });
    } finally {
      setSideloadBusy(false);
    }
  }, [pendingRemoveSideload, refreshSideloaded]);

  // Read fresh list on every render; avoids stale memo behavior when external store
  // updates don't change snapshot identity but still emit notifications.
  const installedPlugins = getInstalledPlugins();

  const runInstallRequest = React.useCallback(async (
    repoUrlInput: string,
    options?: {
      allowUnverifiedInstall?: boolean;
      acknowledgeLiabilityWarning?: boolean;
    },
  ) => {
    const { status, body } = await requestPluginManifest({
      repoUrl: repoUrlInput,
      allowUnverifiedInstall: options?.allowUnverifiedInstall === true,
      acknowledgeLiabilityWarning: options?.acknowledgeLiabilityWarning === true,
    });

    const payload = body as GithubManifestResponse | null;
    // 2xx is not enough on its own: a parsed-but-rejected manifest also fails the install.
    if (status < 200 || status > 299 || !payload?.ok || !payload.manifest) {
      const err = new Error(payload?.error || 'Unable to install plugin from GitHub repository.') as Error & {
        payload?: GithubManifestResponse | null;
      };
      err.payload = payload;
      throw err;
    }

    return payload;
  }, []);

  const handleInstall = React.useCallback(async () => {
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      setStatus({ kind: 'error', message: 'Please enter a GitHub repository URL.' });
      return;
    }

    setIsInstalling(true);
    setStatus({ kind: 'idle', message: '' });
    setPendingLiabilityInstall(null);
    setPendingInstallPreview(null);

    try {
      const payload = await runInstallRequest(trimmed);

      const manifest = normalizePluginManifest(payload.manifest);
      if (!manifest) {
        throw new Error('Plugin manifest is missing required fields.');
      }

      setPendingInstallPreview({
        repoUrl: trimmed,
        manifest,
        manifestSha256: typeof payload.manifestSha256 === 'string' ? payload.manifestSha256 : undefined,
        trust: payload.repoAllowlisted === false ? 'unverified-user-approved' : 'allowlisted',
        liabilityAcceptedAt: payload.repoAllowlisted === false ? new Date().toISOString() : undefined,
        originUrl: typeof payload.rawManifestUrl === 'string' ? payload.rawManifestUrl : undefined,
      });
    } catch (error) {
      const installError = error as Error & { payload?: GithubManifestResponse | null };
      const payload = installError?.payload;
      if (payload?.requiresLiabilityWarning) {
        setPendingLiabilityInstall({
          repoUrl: trimmed,
          unverifiedRepo: payload.unverifiedRepo,
          allowlistRules: payload.allowlistRules,
        });
        setStatus({
          kind: 'error',
          message: 'This repository is not on the allowlist. Review and acknowledge the warning to proceed.',
        });
        return;
      }
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Plugin installation failed.',
      });
    } finally {
      setIsInstalling(false);
    }
  }, [repoUrl, runInstallRequest]);

  const handleConfirmLiabilityInstall = React.useCallback(async () => {
    if (!pendingLiabilityInstall) return;

    setIsInstalling(true);
    setStatus({ kind: 'idle', message: '' });

    try {
      const payload = await runInstallRequest(pendingLiabilityInstall.repoUrl, {
        allowUnverifiedInstall: true,
        acknowledgeLiabilityWarning: true,
      });

      const manifest = normalizePluginManifest(payload.manifest);
      if (!manifest) {
        throw new Error('Plugin manifest is missing required fields.');
      }

      setPendingInstallPreview({
        repoUrl: pendingLiabilityInstall.repoUrl,
        manifest,
        manifestSha256: typeof payload.manifestSha256 === 'string' ? payload.manifestSha256 : undefined,
        trust: 'unverified-user-approved',
        liabilityAcceptedAt: new Date().toISOString(),
        originUrl: typeof payload.rawManifestUrl === 'string' ? payload.rawManifestUrl : undefined,
      });
      setPendingLiabilityInstall(null);
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Plugin installation failed.',
      });
    } finally {
      setIsInstalling(false);
    }
  }, [pendingLiabilityInstall, runInstallRequest]);

  const handleUninstall = React.useCallback((pluginId: string, pluginName: string) => {
    setPendingRemovePlugin({ id: pluginId, name: pluginName });
  }, []);

  const handleConfirmUninstall = React.useCallback(() => {
    if (!pendingRemovePlugin) return;
    uninstallPlugin(pendingRemovePlugin.id);
    setPendingRemovePlugin(null);
  }, [pendingRemovePlugin]);

  const handleInstallFromPreview = React.useCallback(() => {
    if (!pendingInstallPreview) return;

    setIsInstalling(true);
    setStatus({ kind: 'idle', message: '' });
    try {
      installPluginFromManifest(pendingInstallPreview.manifest, pendingInstallPreview.repoUrl, {
        manifestSha256: pendingInstallPreview.manifestSha256,
        installTrust: pendingInstallPreview.trust,
        liabilityAcceptedAt: pendingInstallPreview.liabilityAcceptedAt,
      });

      highlightInstalledRow(`profile:${pendingInstallPreview.manifest.id}`);
      setRepoUrl('');
      setPendingInstallPreview(null);
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Plugin installation failed.',
      });
    } finally {
      setIsInstalling(false);
    }
  }, [highlightInstalledRow, pendingInstallPreview]);

  React.useEffect(() => {
    if (isDevRuntime) return;
    setStudioOpen(false);
  }, [isDevRuntime]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const evaluateTheme = () => {
      const root = document.documentElement;
      const explicitTheme = root.getAttribute('data-theme');
      if (explicitTheme === 'light') {
        setIsLightTheme(true);
        return;
      }
      if (explicitTheme === 'dark') {
        setIsLightTheme(false);
        return;
      }
      setIsLightTheme(window.matchMedia('(prefers-color-scheme: light)').matches);
    };

    evaluateTheme();

    const observer = new MutationObserver(evaluateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
    const handleMediaChange = () => evaluateTheme();
    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleMediaChange);
    } else {
      mediaQuery.addListener(handleMediaChange);
    }

    return () => {
      observer.disconnect();
      if (typeof mediaQuery.removeEventListener === 'function') {
        mediaQuery.removeEventListener('change', handleMediaChange);
      } else {
        mediaQuery.removeListener(handleMediaChange);
      }
    };
  }, []);

  const builtinShieldIconColor = isLightTheme
    ? 'color-mix(in srgb, #4f8a08, var(--text-strong) 28%)'
    : '#86efac';

  // One list for all three tiers: built-in, GitHub manifest packs and sideloaded
  // packages differ in where they came from, not in how they are managed.
  const installedRows: InstalledPluginRow[] = [];
  for (const plugin of installedPlugins) {
    const manifest = plugin.manifest;
    const isBuiltin = plugin.source === 'builtin';
    const repositoryUrl = manifest.homepage || (isBuiltin ? BUILTIN_ATHENA_REPOSITORY_URL : plugin.sourceUrl);
    installedRows.push({
      key: `profile:${manifest.id}`,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source: isBuiltin ? 'builtin' : 'github',
      link: typeof repositoryUrl === 'string' && repositoryUrl.trim().length > 0 ? repositoryUrl : undefined,
      unverified: !isBuiltin && plugin.installTrust === 'unverified-user-approved',
      acceptedAt: plugin.liabilityAcceptedAt,
      remove: isBuiltin ? undefined : () => handleUninstall(manifest.id, manifest.name),
    });
  }
  for (const plugin of sideloadPlugins) {
    installedRows.push({
      key: `sideloaded:${plugin.manifest.id}`,
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.vendor.name,
      source: 'sideloaded',
      fingerprint: plugin.publisherFingerprint,
      capabilities: plugin.manifest.capabilities,
      unverified: false,
      remove: () => setPendingRemoveSideload(plugin),
    });
  }
  installedRows.sort((left, right) => left.name.localeCompare(right.name));
  // What the user added comes first, untouched built-ins after a divider.
  const userInstalledRows = installedRows.filter((row) => row.source !== 'builtin');
  const builtinRows = installedRows.filter((row) => row.source === 'builtin');

  const renderInstalledRow = (row: InstalledPluginRow) => (
    <li
      key={row.key}
      className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-2"
      style={{
        borderColor: row.key === recentlyInstalledKey
          ? 'color-mix(in srgb, #86efac, var(--border-subtle) 28%)'
          : 'var(--border-subtle)',
        // The fill, not just the outline: a ring alone read as a focus state.
        background: row.key === recentlyInstalledKey
          ? 'color-mix(in srgb, #86efac, var(--surface-0) 88%)'
          : 'var(--surface-0)',
        boxShadow: row.key === recentlyInstalledKey
          ? 'inset 0 0 0 1px color-mix(in srgb, #86efac, transparent 45%), inset 0 0 14px color-mix(in srgb, #86efac, transparent 72%), 0 0 16px color-mix(in srgb, #86efac, transparent 62%)'
          : 'none',
        transition: 'box-shadow 600ms ease, border-color 600ms ease, background 600ms ease',
      }}
    >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              {row.source === 'github' && (
                <Github className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
              )}
              {row.source === 'sideloaded' && (
                <PackagePlus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent-secondary)' }} />
              )}
              {row.link ? (
                <button
                  onClick={async () => {
                    const url = row.link as string;
                    try {
                      const { invoke } = await import('@tauri-apps/api/core');
                      await invoke('open_external_url', { url });
                    } catch {
                      window.open(url, '_blank');
                    }
                  }}
                  className="inline-flex items-center gap-1 truncate text-sm font-semibold underline underline-offset-2"
                  style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  title={row.link}
                >
                  {row.name}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </button>
              ) : (
                <span className="truncate text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>{row.name}</span>
              )}
              {row.unverified && (
                <span
                  className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px]"
                  style={{
                    borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 35%)',
                    color: 'color-mix(in srgb, #d97706, var(--text-strong) 18%)',
                    background: 'color-mix(in srgb, #d97706, var(--surface-2) 88%)',
                  }}
                >
                  <Trans>Unverified source</Trans>
                </span>
              )}
            </div>
            {row.description && (
              <div className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
                {row.description}
              </div>
            )}
          </div>
    
          <div className="flex shrink-0 items-center gap-1.5 self-center">
            <Tooltip
              content={(
                <div className="space-y-0.5">
                  <div className="break-all"><span style={{ color: 'var(--text-strong)' }}><Trans>ID</Trans>:</span> {row.id}</div>
                  <div>
                    <span style={{ color: 'var(--text-strong)' }}><Trans>Source</Trans>:</span>{' '}
                    {row.source === 'builtin' ? <Trans>Built-in</Trans> : row.source === 'github' ? <Trans>GitHub</Trans> : <Trans>Sideloaded</Trans>}
                  </div>
                  <div><span style={{ color: 'var(--text-strong)' }}><Trans>Version</Trans>:</span> <Trans>v{row.version}</Trans></div>
                  {row.acceptedAt && (
                    <div><span style={{ color: 'var(--text-strong)' }}><Trans>Liability accepted</Trans>:</span> {row.acceptedAt}</div>
                  )}
                  {row.fingerprint && (
                    <div className="break-all">
                      <span style={{ color: 'var(--text-strong)' }}><Trans>Publisher</Trans>:</span>{' '}
                      <span className="font-mono">{shortFingerprint(row.fingerprint)}</span>
                    </div>
                  )}
                  {row.capabilities && row.capabilities.length > 0 && (
                    <div>
                      <span style={{ color: 'var(--text-strong)' }}><Trans>Capabilities</Trans>:</span>{' '}
                      {row.capabilities.map((capability) => _(SIDELOAD_CAPABILITY_MESSAGES[capability])).join(', ')}
                    </div>
                  )}
                </div>
              )}
              maxWidth={300}
              wrapperClassName="flex items-center"
            >
              <InfoIcon className="h-4 w-4 shrink-0 block" style={{ color: 'var(--text-muted)' }} />
            </Tooltip>
            {row.source === 'builtin' && (
              <Tooltip content={_(msg`Built-in plugin`)} wrapperClassName="flex items-center">
                <ShieldCheck className="h-4 w-4 shrink-0 block" style={{ color: builtinShieldIconColor }} />
              </Tooltip>
            )}
            {row.source === 'builtin' && isOraHostedRepository(row.link) ? (
              <Tooltip content={_(msg`Officially verified by ORA`)} wrapperClassName="flex items-center">
                <CheckCircle2 className="h-4 w-4 shrink-0 block" style={{ color: 'color-mix(in srgb, #d97706, var(--text-strong) 18%)' }} />
              </Tooltip>
            ) : null}
            {row.remove && (
              <Tooltip content={_(msg`Remove plugin`)} wrapperClassName="flex items-center">
                <IconButton
                  variant="ghost"
                  size="xs"
                  aria-label={_(msg`Remove plugin`)}
                  onClick={row.remove}
                  className="hover:brightness-125"
                >
                  <Trash2 className="h-4 w-4" style={{ color: '#fca5a5' }} />
                </IconButton>
              </Tooltip>
            )}
          </div>
        </li>
  );

  return (
    <div className="space-y-3">
      <section className="relative rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        {isDesktop && (
          <IconButton
            variant="surface"
            size="sm"
            tone="warning"
            className="absolute right-3 top-3 hover:brightness-110"
            aria-label={_(msg`Sideloaded packages`)}
            title={_(msg`Sideloaded packages`)}
            onClick={() => setAllowanceDialogOpen(true)}
          >
            <PackageOpen className="h-4 w-4" />
          </IconButton>
        )}
        <div className="flex items-start gap-2.5">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <Plug className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="min-w-0 flex-1 pr-10">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{_(msg`Plugins`)}</h3>
            <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
              <Trans>Profile packs add presets and material profiles. A sideloaded package adds code and needs a publisher you trust.</Trans>
            </p>
          </div>
        </div>

        <div className="mt-2 grid gap-2">
          <SettingRow
            bordered
            label={_(msg`Install profile pack`)}
            description={_(msg`Adds presets and materials from a repository. Contains no code.`)}
          >
            <div className="flex items-center gap-2" style={{ width: 'min(420px, 46vw)' }}>
              <Input
                type="text"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void handleInstall();
                }}
                placeholder={isDevRuntime ? 'df://debug_plugin_official' : _(msg`https://github.com/owner/repo`)}
                className="h-[34px] min-w-0 flex-1 text-sm"
                aria-label={_(msg`Plugin repository URL`)}
              />
              <Button
                variant="tinted-accent"
                className="inline-flex shrink-0 items-center gap-1.5"
                disabled={isInstalling}
                onClick={() => { void handleInstall(); }}
              >
                {isInstalling ? <Spinner size="sm" /> : <Download className="h-3.5 w-3.5" />}
                {isInstalling ? <Trans>Installing…</Trans> : <Trans>Install</Trans>}
              </Button>
            </div>
          </SettingRow>

          {isDesktop && allowSideload && (
            <SettingRow
              bordered
              label={_(msg`Import package`)}
              description={_(msg`Checks the publisher signature, then unseals and installs the .dfplugin file.`)}
            >
              <Button
                variant="secondary"
                className="inline-flex shrink-0 items-center gap-1.5"
                disabled={sideloadBusy}
                onClick={() => { void handlePickSideloadPackage(); }}
              >
                {sideloadBusy ? <Spinner size="sm" /> : <PackagePlus className="h-3.5 w-3.5" />}
                <Trans>Choose file…</Trans>
              </Button>
            </SettingRow>
          )}
        </div>

        {status.kind !== 'idle' && (
          <p className="mt-2 text-xs" style={{ color: status.kind === 'error' ? '#fca5a5' : '#86efac' }}>
            {status.message}
          </p>
        )}
      </section>

      <StructuredDialogModal
        open={pendingLiabilityInstall !== null}
        ariaLabel={_(msg`Install unverified plugin`)}
        title={<Trans>Install an unverified plugin?</Trans>}
        subtitle={pendingLiabilityInstall
          ? `${pendingLiabilityInstall.unverifiedRepo?.owner ?? ''}/${pendingLiabilityInstall.unverifiedRepo?.name ?? ''}`
          : undefined}
        icon={<AlertTriangle className="h-4 w-4" />}
        iconTone="warning"
        maxWidthClassName="max-w-xl"
        zIndexClassName="z-[130]"
        closeAriaLabel={_(msg`Close modal`)}
        closeDisabled={isInstalling}
        onClose={() => setPendingLiabilityInstall(null)}
        onBackdropClick={() => setPendingLiabilityInstall(null)}
        actions={(
          <>
            <Button variant="secondary" disabled={isInstalling} onClick={() => setPendingLiabilityInstall(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="tinted-warning"
              className="inline-flex items-center justify-center gap-1.5"
              disabled={isInstalling}
              onClick={() => { void handleConfirmLiabilityInstall(); }}
            >
              {isInstalling ? <Spinner size="sm" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              {isInstalling ? <Trans>Installing…</Trans> : <Trans>Install anyway</Trans>}
            </Button>
          </>
        )}
      >
        <div className="space-y-1.5">
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-strong)' }}>
            <Trans>DragonFruit cannot confirm who published this repository.</Trans>
          </p>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <Trans>A profile pack is data only — presets and material templates — so installing it cannot add code. The values it declares are still yours to check.</Trans>
          </p>
        </div>
        {Array.isArray(pendingLiabilityInstall?.allowlistRules) && pendingLiabilityInstall.allowlistRules.length > 0 && (
          <div
            className="rounded-md border px-3 py-2"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans>Trusted sources</Trans>
            </div>
            <div className="mt-0.5 text-xs break-all" style={{ color: 'var(--text-strong)' }}>
              {pendingLiabilityInstall.allowlistRules.join(', ')}
            </div>
          </div>
        )}
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingInstallPreview !== null}
        ariaLabel={_(msg`Review plugin before install`)}
        title={<Trans>Install this plugin?</Trans>}
        subtitle={pendingInstallPreview?.manifest.name}
        icon={<Plug className="h-4 w-4" />}
        iconTone="accent"
        maxWidthClassName="max-w-2xl"
        zIndexClassName="z-[130]"
        closeAriaLabel={_(msg`Close modal`)}
        closeDisabled={isInstalling}
        onClose={() => setPendingInstallPreview(null)}
        onBackdropClick={() => setPendingInstallPreview(null)}
        bodyClassName="space-y-3 p-5"
        actions={(
          <>
            <Button variant="secondary" disabled={isInstalling} onClick={() => setPendingInstallPreview(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="tinted-accent"
              className="inline-flex items-center justify-center gap-1.5"
              disabled={isInstalling}
              onClick={handleInstallFromPreview}
            >
              {isInstalling ? <Spinner size="sm" /> : <Download className="h-3.5 w-3.5" />}
              {isInstalling ? <Trans>Installing…</Trans> : <Trans>Install</Trans>}
            </Button>
          </>
        )}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] rounded-full border px-1.5 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            <Trans>v{pendingInstallPreview?.manifest.version}</Trans>
          </span>
          <span
            className="text-[11px] rounded-full border px-1.5 py-0.5 font-semibold"
            style={pendingInstallPreview?.trust === 'allowlisted'
              ? {
                  borderColor: 'color-mix(in srgb, #86efac, var(--border-subtle) 45%)',
                  color: '#86efac',
                  background: 'color-mix(in srgb, #86efac, var(--surface-2) 92%)',
                }
              : {
                  borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 45%)',
                  color: 'color-mix(in srgb, #d97706, var(--text-strong) 18%)',
                  background: 'color-mix(in srgb, #d97706, var(--surface-2) 88%)',
                }}
          >
            {pendingInstallPreview?.trust === 'allowlisted'
              ? <Trans>Allowlisted source</Trans>
              : <Trans>Unverified source</Trans>}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans>Identity</Trans>
            </div>
            <div className="mt-1.5 space-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <div className="break-all">
                <span style={{ color: 'var(--text-strong)' }}><Trans>ID</Trans>:</span> {pendingInstallPreview?.manifest.id}
              </div>
              {pendingInstallPreview?.manifest.author && (
                <div className="break-all">
                  <span style={{ color: 'var(--text-strong)' }}><Trans>Author</Trans>:</span> {pendingInstallPreview.manifest.author}
                </div>
              )}
              <div>
                <span style={{ color: 'var(--text-strong)' }}><Trans>Contents</Trans>:</span>{' '}
                <Plural value={pendingInstallPreview?.manifest.printerPresets?.length ?? 0} one="# printer preset" other="# printer presets" />,{' '}
                <Plural value={pendingInstallPreview?.manifest.materialTemplates?.length ?? 0} one="# material template" other="# material templates" />
              </div>
            </div>
          </div>

          <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans>Origin</Trans>
            </div>
            <div className="mt-1.5 space-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <div className="break-all">
                <span style={{ color: 'var(--text-strong)' }}><Trans>Repository</Trans>:</span> {pendingInstallPreview?.repoUrl}
              </div>
              {pendingInstallPreview?.originUrl && (
                <div className="break-all">
                  <span style={{ color: 'var(--text-strong)' }}><Trans>Manifest</Trans>:</span> {pendingInstallPreview.originUrl}
                </div>
              )}
              {pendingInstallPreview?.manifestSha256 && (
                <div className="break-all">
                  <span style={{ color: 'var(--text-strong)' }}><Trans>SHA-256</Trans>:</span>{' '}
                  <span className="font-mono" style={{ color: 'var(--text-strong)' }}>{pendingInstallPreview.manifestSha256}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {pendingInstallPreview?.manifest.description && (
          <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans>Description</Trans>
            </div>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {pendingInstallPreview.manifest.description}
            </p>
          </div>
        )}
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingRemovePlugin !== null}
        ariaLabel={_(msg`Remove plugin`)}
        title={<Trans>Remove Plugin?</Trans>}
        subtitle={pendingRemovePlugin?.name}
        icon={<Trash2 className="h-4 w-4" />}
        iconTone="danger"
        zIndexClassName="z-[130]"
        closeAriaLabel={_(msg`Close modal`)}
        onClose={() => setPendingRemovePlugin(null)}
        onBackdropClick={() => setPendingRemovePlugin(null)}
        actions={(
          <>
            <Button variant="secondary" onClick={() => setPendingRemovePlugin(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button variant="tinted-danger" onClick={handleConfirmUninstall}>
              <Trash2 className="h-3.5 w-3.5" />
              <Trans>Remove plugin</Trans>
            </Button>
          </>
        )}
      >
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <Trans>This removes the plugin from your profile library.</Trans>
        </p>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={passphraseOpen && pendingSideload !== null}
        ariaLabel={_(msg`Package passphrase`)}
        title={<Trans>Enter the passphrase</Trans>}
        subtitle={pendingSideload?.info.manifest.name}
        icon={<LockKeyhole className="h-4 w-4" />}
        iconTone="neutral"
        maxWidthClassName="max-w-md"
        zIndexClassName="z-[131]"
        closeAriaLabel={_(msg`Close modal`)}
        closeDisabled={sideloadBusy}
        onClose={closePassphraseDialog}
        onBackdropClick={closePassphraseDialog}
        actions={(
          <>
            <Button variant="secondary" disabled={sideloadBusy} onClick={closePassphraseDialog}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="tinted-accent"
              className="inline-flex items-center justify-center gap-1.5"
              disabled={sideloadBusy || sideloadPassphrase.trim().length === 0}
              onClick={() => { void handleConfirmSideloadInstall(); }}
            >
              {sideloadBusy ? <Spinner size="sm" /> : <LockKeyhole className="h-3.5 w-3.5" />}
              {sideloadBusy ? <Trans>Installing…</Trans> : <Trans>Unseal and install</Trans>}
            </Button>
          </>
        )}
      >
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <Trans>The package is sealed. Enter the key your vendor gave you; it is kept locally so the plugin can load later.</Trans>
        </p>
        <Input
          autoFocus
          id="sideload-passphrase"
          type="password"
          autoComplete="off"
          className="h-10 w-full"
          value={sideloadPassphrase}
          onChange={(event) => setSideloadPassphrase(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && sideloadPassphrase.trim().length > 0 && !sideloadBusy) {
              void handleConfirmSideloadInstall();
            }
          }}
          placeholder={_(passphrasePlaceholder(pendingSideload?.info.manifest.name ?? ''))}
          aria-label={_(msg`Package passphrase`)}
        />
        {passphraseError && (
          <p className="text-xs leading-relaxed" style={{ color: '#fca5a5' }}>
            {passphraseError}
          </p>
        )}
      </StructuredDialogModal>

      <StructuredDialogModal
        open={allowanceDialogOpen}
        ariaLabel={_(msg`Sideloaded packages`)}
        title={allowSideload ? <Trans>Sideloading is on</Trans> : <Trans>Allow untrusted plugins?</Trans>}
        subtitle={_(msg`Sideloaded packages`)}
        icon={<ShieldAlert className="h-4 w-4" />}
        iconTone="warning"
        maxWidthClassName="max-w-lg"
        zIndexClassName="z-[130]"
        closeAriaLabel={_(msg`Close modal`)}
        onClose={() => setAllowanceDialogOpen(false)}
        onBackdropClick={() => setAllowanceDialogOpen(false)}
        actions={(
          <>
            <Button variant="secondary" onClick={() => setAllowanceDialogOpen(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant={allowSideload ? 'tinted-danger' : 'tinted-warning'}
              className="inline-flex items-center justify-center gap-1.5"
              onClick={() => {
                void (async () => {
                  await handleSideloadAllowanceChange(!allowSideload);
                  setAllowanceDialogOpen(false);
                })();
              }}
            >
              {allowSideload ? <><ShieldAlert className="h-3.5 w-3.5" /><Trans>Disable Sideloading</Trans></> : <><ShieldAlert className="h-3.5 w-3.5" /><Trans>Enable Sideloading</Trans></>}
            </Button>
          </>
        )}
      >
        {allowSideload ? (
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            <Trans>Packages you import run with your permissions and can read any file you can read, open network connections, and crash the app if they misbehave. Disabling this stops new imports; packages already installed stay on disk.</Trans>
          </p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-strong)' }}>
              <Trans>A sideloaded package is a native program, not a profile pack.</Trans>
            </p>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <Trans>Once imported it runs with your permissions: it can read any file you can read, open network connections, and crash the app if it misbehaves.</Trans>
            </p>
          </div>
        )}
        <div
          className="rounded-md border px-3 py-2"
          style={{
            borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 40%)',
            background: 'color-mix(in srgb, #d97706, var(--surface-1) 92%)',
          }}
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: '#d97706' }} />
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              <Trans>Signatures prove who built the package, not that it is safe. Only enable this for a publisher you trust.</Trans>
            </p>
          </div>
        </div>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingSideload !== null}
        ariaLabel={_(msg`Install sideloaded plugin`)}
        title={<Trans>Install this plugin?</Trans>}
        subtitle={pendingSideload?.info.manifest.name}
        icon={<PackagePlus className="h-4 w-4" />}
        iconTone="accent"
        maxWidthClassName="max-w-xl"
        zIndexClassName="z-[130]"
        closeAriaLabel={_(msg`Close modal`)}
        closeDisabled={sideloadBusy}
        onClose={() => setPendingSideload(null)}
        onBackdropClick={() => setPendingSideload(null)}
        bodyClassName="space-y-3 p-5"
        actions={(
          <>
            <Button variant="secondary" disabled={sideloadBusy} onClick={() => setPendingSideload(null)}>
              <Trans>Cancel</Trans>
            </Button>
            {pendingSideload?.info.sealed ? (
              <Button
                variant="tinted-accent"
                className="inline-flex items-center justify-center gap-1.5"
                onClick={() => {
                  setSideloadPassphrase('');
                  setPassphraseError(null);
                  setPassphraseOpen(true);
                }}
              >
                <LockKeyhole className="h-3.5 w-3.5" />
                <Trans>Continue</Trans>
              </Button>
            ) : (
              <Button
                variant="tinted-accent"
                className="inline-flex items-center justify-center gap-1.5"
                disabled={sideloadBusy}
                onClick={() => { void handleConfirmSideloadInstall(); }}
              >
                {sideloadBusy ? <Spinner size="sm" /> : <PackagePlus className="h-3.5 w-3.5" />}
                {sideloadBusy ? <Trans>Installing…</Trans> : <Trans>Install</Trans>}
              </Button>
            )}
          </>
        )}
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] rounded-full border px-1.5 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
            <Trans>v{pendingSideload?.info.manifest.version}</Trans>
          </span>
          {pendingSideload?.info.manifest.capabilities.map((capability) => (
            <span
              key={capability}
              className="text-[11px] rounded-full border px-1.5 py-0.5"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-strong)' }}
            >
              {_(SIDELOAD_CAPABILITY_MESSAGES[capability])}
            </span>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans>Publisher</Trans>
            </div>
            <div className="mt-1.5 space-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <div><span style={{ color: 'var(--text-strong)' }}><Trans>Vendor</Trans>:</span> {pendingSideload?.info.manifest.vendor.name}</div>
              <div>
                <span style={{ color: 'var(--text-strong)' }}><Trans>Key</Trans>:</span>{' '}
                <Tooltip
                  content={<span className="font-mono break-all">{pendingSideload?.info.publisherFingerprint}</span>}
                  maxWidth={320}
                  wrapperClassName="inline-flex"
                >
                  <span className="font-mono" style={{ color: 'var(--text-strong)' }}>
                    {shortFingerprint(pendingSideload?.info.publisherFingerprint ?? '')}
                  </span>
                </Tooltip>
              </div>
            </div>
          </div>
          <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans>Package</Trans>
            </div>
            <div className="mt-1.5 space-y-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              <div><span style={{ color: 'var(--text-strong)' }}><Trans>ID</Trans>:</span> {pendingSideload?.info.manifest.id}</div>
              <div><span style={{ color: 'var(--text-strong)' }}><Trans>Needs</Trans>:</span> <Trans>DragonFruit {pendingSideload?.info.manifest.minAppVersion} or newer</Trans></div>
              <div><span style={{ color: 'var(--text-strong)' }}><Trans>Sealed</Trans>:</span> {pendingSideload?.info.sealed ? <Trans>yes</Trans> : <Trans>no</Trans>}</div>
            </div>
          </div>
        </div>

        {(pendingSideload?.info.manifest.formats.length ?? 0) > 0 && (
          <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans>Output formats</Trans>
            </div>
            <div className="mt-1 space-y-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              {pendingSideload?.info.manifest.formats.map((format) => (
                <div key={format.id} className="font-mono break-all">
                  {format.extensions.join(' ')}
                </div>
              ))}
            </div>
          </div>
        )}

        {pendingSideload?.info.replacesExisting && (
          <p className="text-xs" style={{ color: 'color-mix(in srgb, #d97706, var(--text-strong) 18%)' }}>
            <Trans>An older install with this ID and publisher is replaced.</Trans>
          </p>
        )}

        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <Trans>This package runs native code with your user account. It can read your files and open network connections. Only install packages from a vendor you trust.</Trans>
        </p>
      </StructuredDialogModal>

      <StructuredDialogModal
        open={pendingRemoveSideload !== null}
        ariaLabel={_(msg`Remove sideloaded plugin`)}
        title={<Trans>Remove this plugin?</Trans>}
        subtitle={pendingRemoveSideload?.manifest.name}
        icon={<Trash2 className="h-4 w-4" />}
        iconTone="danger"
        zIndexClassName="z-[130]"
        closeAriaLabel={_(msg`Close modal`)}
        onClose={() => setPendingRemoveSideload(null)}
        onBackdropClick={() => setPendingRemoveSideload(null)}
        actions={(
          <>
            <Button variant="secondary" onClick={() => setPendingRemoveSideload(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button variant="tinted-danger" onClick={() => { void handleConfirmRemoveSideload(); }}>
              <Trash2 className="h-3.5 w-3.5" />
              <Trans>Remove plugin</Trans>
            </Button>
          </>
        )}
      >
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <Trans>The package, its extracted payload and its stored key are deleted. Re-importing needs the passphrase again.</Trans>
        </p>
      </StructuredDialogModal>

      <section className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-start gap-2.5">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <PackageCheck className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>{_(msg`Installed plugins`)}</h3>
            <p className="mt-0.5 text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
              <Plural value={installedRows.length} one="# plugin in this profile." other="# plugins in this profile." />
            </p>
          </div>
        </div>

        {userInstalledRows.length > 0 && (
          <ul className="mt-2 space-y-1.5">
            {userInstalledRows.map(renderInstalledRow)}
          </ul>
        )}

        {userInstalledRows.length > 0 && builtinRows.length > 0 && (
          <div className="my-2 h-px" style={{ background: 'var(--border-subtle)' }} aria-hidden />
        )}

        {builtinRows.length > 0 && (
          <ul className={userInstalledRows.length > 0 ? 'space-y-1.5' : 'mt-2 space-y-1.5'}>
            {builtinRows.map(renderInstalledRow)}
          </ul>
        )}
      </section>



      {isDevRuntime && (
        <div className="pt-1 flex justify-center">
          <button
            type="button"
            onClick={() => setStudioOpen(true)}
            className="text-xs underline-offset-2 hover:underline"
            style={{ color: 'var(--text-faint, var(--text-muted))' }}
          >
            Plugin Creation Studio
          </button>
        </div>
      )}

      <PluginStudioModal isOpen={isDevRuntime && studioOpen} onClose={() => setStudioOpen(false)} />
    </div>
  );
}
