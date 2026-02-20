'use client';

import React from 'react';
import { Download, ExternalLink, Github, Loader2, Plug, ShieldCheck, Trash2 } from 'lucide-react';
import {
  getInstalledPlugins,
  getProfileStoreSnapshot,
  installPluginFromManifest,
  subscribeToProfileStore,
  uninstallPlugin,
} from '@/features/profiles/profileStore';
import type { PluginManifest } from '@/features/plugins/pluginRegistry';

const BUILTIN_ATHENA_DEVELOPER = 'Open Resin Alliance';
const BUILTIN_ATHENA_REPOSITORY_URL = 'https://github.com/Open-Resin-Alliance/Dragnfruit';

type GithubManifestResponse = {
  ok: boolean;
  error?: string;
  rawManifestUrl?: string;
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
  const profileSnapshot = React.useSyncExternalStore(subscribeToProfileStore, getProfileStoreSnapshot, getProfileStoreSnapshot);

  const [repoUrl, setRepoUrl] = React.useState('');
  const [isInstalling, setIsInstalling] = React.useState(false);
  const [status, setStatus] = React.useState<{ kind: 'idle' | 'success' | 'error'; message: string }>({ kind: 'idle', message: '' });

  const installedPlugins = React.useMemo(() => getInstalledPlugins(), [profileSnapshot]);

  const handleInstall = React.useCallback(async () => {
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      setStatus({ kind: 'error', message: 'Please enter a GitHub repository URL.' });
      return;
    }

    setIsInstalling(true);
    setStatus({ kind: 'idle', message: '' });

    try {
      const response = await fetch('/api/plugins/github-manifest', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ repoUrl: trimmed }),
      });

      const payload = await response.json().catch(() => null) as GithubManifestResponse | null;
      if (!response.ok || !payload?.ok || !payload.manifest) {
        throw new Error(payload?.error || 'Unable to install plugin from GitHub repository.');
      }

      const manifest = normalizePluginManifest(payload.manifest);
      if (!manifest) {
        throw new Error('Plugin manifest is missing required fields.');
      }

      installPluginFromManifest(manifest, trimmed);
      setStatus({ kind: 'success', message: `Installed plugin: ${manifest.name}` });
      setRepoUrl('');
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Plugin installation failed.',
      });
    } finally {
      setIsInstalling(false);
    }
  }, [repoUrl]);

  const handleUninstall = React.useCallback((pluginId: string) => {
    const removed = uninstallPlugin(pluginId);
    if (removed) {
      setStatus({ kind: 'success', message: `Uninstalled plugin: ${pluginId}` });
    }
  }, []);

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

        <div className="mt-2.5 grid grid-cols-[1fr_auto] gap-2">
          <input
            type="text"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/<owner>/<repo>"
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

      <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Installed Plugins</h4>

        <div className="mt-2 space-y-2">
          {installedPlugins.map((plugin) => {
            const manifest = plugin.manifest;
            const isBuiltin = plugin.source === 'builtin';
            const developer = manifest.author || (isBuiltin ? BUILTIN_ATHENA_DEVELOPER : 'Unknown');
            const repositoryUrl = manifest.homepage || (isBuiltin ? BUILTIN_ATHENA_REPOSITORY_URL : plugin.sourceUrl);
            const hasRepositoryLink = typeof repositoryUrl === 'string' && repositoryUrl.trim().length > 0;

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
                    {manifest.description && (
                      <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {manifest.description}
                      </div>
                    )}

                    <div className="mt-1.5 space-y-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                      <div>
                        <span className="font-semibold" style={{ color: 'var(--text-strong)' }}>Developer:</span>{' '}
                        <span>{developer}</span>
                      </div>

                      {hasRepositoryLink && (
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
                            {repositoryUrl}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      )}
                    </div>
                  </div>

                  {!isBuiltin && (
                    <button
                      type="button"
                      onClick={() => handleUninstall(manifest.id)}
                      className="ui-button ui-button-secondary !h-7 !px-2 !py-0 text-[11px] inline-flex items-center gap-1"
                      style={{ color: '#fca5a5' }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
