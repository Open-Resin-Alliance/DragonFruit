'use client';

import React from 'react';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Github, Loader2, Plug, ShieldCheck, Trash2 } from 'lucide-react';
import {
  getInstalledPlugins,
  getProfileStoreSnapshot,
  getProfileStoreServerSnapshot,
  installPluginFromManifest,
  subscribeToProfileStore,
  uninstallPlugin,
} from '@/features/profiles/profileStore';
import type { PluginManifest } from '@/features/plugins/pluginRegistry';
import { PluginStudioModal } from './PluginStudioModal';

const BUILTIN_ATHENA_REPOSITORY_URL = 'https://github.com/Open-Resin-Alliance/DragonFruit';

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
  React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreServerSnapshot);

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
    const response = await fetch('/api/plugins/github-manifest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repoUrl: repoUrlInput,
        allowUnverifiedInstall: options?.allowUnverifiedInstall === true,
        acknowledgeLiabilityWarning: options?.acknowledgeLiabilityWarning === true,
      }),
    });

    const payload = await response.json().catch(() => null) as GithubManifestResponse | null;
    if (!response.ok || !payload?.ok || !payload.manifest) {
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
    const removed = uninstallPlugin(pendingRemovePlugin.id);
    if (removed) {
      setStatus({ kind: 'success', message: `Uninstalled plugin: ${pendingRemovePlugin.name}` });
    }
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

      setStatus({
        kind: 'success',
        message: pendingInstallPreview.trust === 'unverified-user-approved'
          ? `Installed unverified plugin: ${pendingInstallPreview.manifest.name}`
          : `Installed plugin: ${pendingInstallPreview.manifest.name}`,
      });
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
  }, [pendingInstallPreview]);

  React.useEffect(() => {
    if (isDevRuntime) return;
    setStudioOpen(false);
  }, [isDevRuntime]);

  return (
    <div className="space-y-3">
      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}>
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4" style={{ color: 'var(--accent-secondary)' }} />
          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Plugin Loader</h4>
        </div>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Install plugin manifests from GitHub repositories (profile packs only). Remote code execution is not supported.
        </p>
        <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          Debug URLs: <code>df://debug_plugin_official</code> and <code>df://debug_plugin_3rd</code>
        </p>

        <div className="mt-2.5 grid grid-cols-[1fr_auto] gap-2">
          <input
            type="text"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/<owner>/<repo> or df://debug_plugin_official"
            className="ui-input h-[34px] px-2.5 py-1.5 text-sm"
          />
          <button
            type="button"
            onClick={() => { void handleInstall(); }}
            disabled={isInstalling}
            className="ui-button ui-button-secondary !h-[34px] !px-3 !py-0 text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
            style={{ color: 'var(--accent-secondary)' }}
          >
            {isInstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            {isInstalling ? 'Installing…' : 'Install Plugin'}
          </button>
        </div>

        {status.kind !== 'idle' && (
          <div className="mt-2 text-xs" style={{ color: status.kind === 'error' ? '#fca5a5' : '#86efac' }}>
            {status.message}
          </div>
        )}
      </div>

      {pendingLiabilityInstall && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !isInstalling) setPendingLiabilityInstall(null);
        }}>
          <div className="w-full max-w-xl rounded-xl border p-4 ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
            <div className="flex items-start gap-2.5">
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border leading-none"
                style={{
                  borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                  background: 'color-mix(in srgb, #f59e0b, var(--surface-2) 88%)',
                  color: '#fbbf24',
                }}
              >
                <AlertTriangle className="h-4.5 w-4.5" />
              </span>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Unverified Plugin Liability Warning
                </div>
                <div className="mt-1 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  This repository is not on the trusted allowlist. You can still install this <strong>simple/data-only</strong> plugin,
                  but you accept responsibility for validating the source and manifest contents.
                </div>
              </div>
            </div>
            <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                <span style={{ color: 'var(--text-strong)' }}>Repo:</span>{' '}
                {pendingLiabilityInstall.unverifiedRepo?.owner}/{pendingLiabilityInstall.unverifiedRepo?.name}
              </div>
              {Array.isArray(pendingLiabilityInstall.allowlistRules) && pendingLiabilityInstall.allowlistRules.length > 0 && (
                <div className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  <span style={{ color: 'var(--text-strong)' }}>Allowlist:</span> {pendingLiabilityInstall.allowlistRules.join(', ')}
                </div>
              )}
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs"
                disabled={isInstalling}
                onClick={() => setPendingLiabilityInstall(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs"
                style={{ color: '#fbbf24' }}
                disabled={isInstalling}
                onClick={() => { void handleConfirmLiabilityInstall(); }}
              >
                {isInstalling ? 'Installing…' : 'I Understand, Install Anyway'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingInstallPreview && (
        <div className="fixed inset-0 z-[121] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !isInstalling) setPendingInstallPreview(null);
        }}>
          <div className="w-full max-w-3xl rounded-xl border p-4 ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
            <div
              className="rounded-lg border px-3.5 py-3"
              style={{
                borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
                background: 'linear-gradient(145deg, color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%), color-mix(in srgb, var(--surface-1), transparent 5%))',
              }}
            >
              <div className="flex items-start gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border leading-none"
                  style={{
                    borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 35%)',
                    background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-2) 88%)',
                    color: 'var(--accent-secondary)',
                  }}
                >
                  <Plug className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                    Review Plugin Before Install
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                    Confirm source and metadata before adding this plugin to your profile library.
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                      {pendingInstallPreview.manifest.name}
                    </span>
                    <span className="text-[10px] rounded-full border px-1.5 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                      v{pendingInstallPreview.manifest.version}
                    </span>
                    <span
                      className="text-[10px] rounded-full border px-1.5 py-0.5 font-semibold"
                      style={{
                        borderColor: pendingInstallPreview.trust === 'allowlisted'
                          ? 'color-mix(in srgb, #86efac, var(--border-subtle) 45%)'
                          : 'color-mix(in srgb, #f59e0b, var(--border-subtle) 45%)',
                        color: pendingInstallPreview.trust === 'allowlisted' ? '#86efac' : '#fbbf24',
                        background: pendingInstallPreview.trust === 'allowlisted'
                          ? 'color-mix(in srgb, #86efac, var(--surface-2) 92%)'
                          : 'color-mix(in srgb, #f59e0b, var(--surface-2) 92%)',
                      }}
                    >
                      {pendingInstallPreview.trust === 'allowlisted' ? 'Allowlisted Source' : 'Unverified Source'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Identity</div>
                <div className="mt-2 space-y-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <div><span style={{ color: 'var(--text-strong)' }}>ID:</span> {pendingInstallPreview.manifest.id}</div>
                  {pendingInstallPreview.manifest.author && (
                    <div><span style={{ color: 'var(--text-strong)' }}>Author:</span> {pendingInstallPreview.manifest.author}</div>
                  )}
                  <div>
                    <span style={{ color: 'var(--text-strong)' }}>Contents:</span>{' '}
                    {pendingInstallPreview.manifest.printerPresets?.length ?? 0} printer preset(s),{' '}
                    {pendingInstallPreview.manifest.materialTemplates?.length ?? 0} material template(s)
                  </div>
                </div>
              </div>

              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Origin</div>
                <div className="mt-2 space-y-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                  <div className="break-all"><span style={{ color: 'var(--text-strong)' }}>Repo:</span> {pendingInstallPreview.repoUrl}</div>
                  {pendingInstallPreview.originUrl && (
                    <div className="break-all"><span style={{ color: 'var(--text-strong)' }}>Manifest URL:</span> {pendingInstallPreview.originUrl}</div>
                  )}
                  {pendingInstallPreview.manifestSha256 && (
                    <div className="break-all"><span style={{ color: 'var(--text-strong)' }}>SHA-256:</span> {pendingInstallPreview.manifestSha256}</div>
                  )}
                </div>
              </div>
            </div>

            {pendingInstallPreview.manifest.description && (
              <div className="mt-3 rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>Description</div>
                <div className="mt-1.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                  {pendingInstallPreview.manifest.description}
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs"
                disabled={isInstalling}
                onClick={() => setPendingInstallPreview(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs"
                style={{ color: 'var(--accent-secondary)' }}
                disabled={isInstalling}
                onClick={handleInstallFromPreview}
              >
                {isInstalling ? 'Installing…' : 'Install'}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingRemovePlugin && (
        <div className="fixed inset-0 z-[122] flex items-center justify-center bg-black/60 backdrop-blur-sm px-4 ui-modal-backdrop-enter" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setPendingRemovePlugin(null);
        }}>
          <div className="w-full max-w-lg rounded-xl border p-4 ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
            <div className="flex items-start gap-2.5">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border"
                style={{
                  borderColor: 'color-mix(in srgb, #ef4444, var(--border-subtle) 45%)',
                  background: 'color-mix(in srgb, #ef4444, var(--surface-2) 90%)',
                  color: '#fca5a5',
                }}
              >
                <Trash2 className="h-4 w-4" />
              </span>
              <div>
                <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
                  Remove Plugin?
                </div>
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  This removes <span style={{ color: 'var(--text-strong)' }}>{pendingRemovePlugin.name}</span> from installed plugins.
                </div>
              </div>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs"
                onClick={() => setPendingRemovePlugin(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1"
                style={{ color: '#fca5a5' }}
                onClick={handleConfirmUninstall}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Installed Plugins</h4>

        <div className="mt-2 space-y-2">
          {installedPlugins.map((plugin) => {
            const manifest = plugin.manifest;
            const isBuiltin = plugin.source === 'builtin';
            const repositoryUrl = manifest.homepage || (isBuiltin ? BUILTIN_ATHENA_REPOSITORY_URL : plugin.sourceUrl);
            const hasRepositoryLink = typeof repositoryUrl === 'string' && repositoryUrl.trim().length > 0;
            const isOraVerifiedBuiltin = isBuiltin && isOraHostedRepository(repositoryUrl);
            const isUnverifiedGithubPlugin = !isBuiltin && plugin.installTrust === 'unverified-user-approved';

            return (
              <div
                key={manifest.id}
                className="rounded-md border px-2.5 py-2"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      {isBuiltin ? (
                        <ShieldCheck className="h-3.5 w-3.5" style={{ color: '#86efac' }} />
                      ) : (
                        <Github className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                      )}
                      <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>{manifest.name}</span>
                      <span className="text-[10px] rounded-full border px-1.5 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                        v{manifest.version}
                      </span>
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {manifest.id} • {isBuiltin ? 'Built-in' : 'GitHub'}
                    </div>
                    {isUnverifiedGithubPlugin && (
                      <div className="text-[11px] mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                        style={{
                          borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 35%)',
                          color: '#fbbf24',
                          background: 'color-mix(in srgb, #f59e0b, var(--surface-2) 90%)',
                        }}
                        title={plugin.liabilityAcceptedAt ? `Liability accepted at ${plugin.liabilityAcceptedAt}` : 'Installed with liability acknowledgement'}
                      >
                        Unverified Source (User Approved)
                      </div>
                    )}
                    {manifest.description && (
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {manifest.description}
                      </div>
                    )}

                    {hasRepositoryLink && (
                      <div className="mt-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        <div className="flex items-center gap-1.5">
                          <Github className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                          <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>Repository:</span>
                          <a
                            href={repositoryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 underline underline-offset-2"
                            style={{ color: 'var(--accent)' }}
                          >
                            {truncateRepositoryUrl(repositoryUrl)}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      </div>
                    )}
                  </div>

                  {isOraVerifiedBuiltin ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold"
                      style={{
                        borderColor: 'color-mix(in srgb, #f59e0b, var(--border-subtle) 40%)',
                        color: '#f59e0b',
                        background: 'color-mix(in srgb, #f59e0b, var(--surface-2) 88%)',
                      }}
                      title="Built-in and hosted by Open Resin Alliance"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      ORA Verified
                    </span>
                  ) : !isBuiltin ? (
                    <button
                      type="button"
                      onClick={() => handleUninstall(manifest.id, manifest.name)}
                      className="ui-button ui-button-secondary !h-7 !px-2 !py-0 text-[11px] inline-flex items-center gap-1"
                      style={{ color: '#fca5a5' }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {isDevRuntime && (
        <div className="pt-1 flex justify-center">
          <button
            type="button"
            onClick={() => setStudioOpen(true)}
            className="text-[11px] underline-offset-2 hover:underline"
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
