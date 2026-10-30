'use client';

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Plural, Trans } from '@lingui/react/macro';
import { AlertTriangle, CheckCircle2, Download, ExternalLink, Github, Info as InfoIcon, PackageCheck, PackagePlus, Plug, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, Input, Spinner, Toggle } from '@/components/atoms';
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

// Module scope on purpose: a `msg` descriptor created inside a component can be
// renamed out from under its catalog id by React Compiler.
const SIDELOAD_CAPABILITY_MESSAGES: Record<SideloadedCapability, MessageDescriptor> = {
  slicerEncoder: msg`Slicer encoder`,
  networkOperations: msg`Network operations`,
  fileType: msg`File-type import`,
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
  const [sideloadPlugins, setSideloadPlugins] = React.useState<InstalledSideloadedPlugin[]>([]);
  const [sideloadBusy, setSideloadBusy] = React.useState(false);
  const [sideloadStatus, setSideloadStatus] = React.useState<{ kind: 'idle' | 'success' | 'error'; message: string }>({ kind: 'idle', message: '' });
  const [pendingSideload, setPendingSideload] = React.useState<{ path: string; info: SideloadedInspect } | null>(null);
  const [sideloadPassphrase, setSideloadPassphrase] = React.useState('');
  const [pendingRemoveSideload, setPendingRemoveSideload] = React.useState<InstalledSideloadedPlugin | null>(null);

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
          setSideloadStatus({ kind: 'error', message: String(error) });
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
    setSideloadStatus({ kind: 'idle', message: '' });
    try {
      await setSideloadAllowance(next);
      await refreshSideloaded();
    } catch (error) {
      setAllowSideload(!next);
      setSideloadStatus({ kind: 'error', message: String(error) });
    }
  }, [refreshSideloaded]);

  const handlePickSideloadPackage = React.useCallback(async () => {
    setSideloadStatus({ kind: 'idle', message: '' });
    try {
      const path = await pickSideloadPackage();
      if (!path) return;
      const info = await inspectSideloadPackage(path);
      setSideloadPassphrase('');
      setPendingSideload({ path, info });
    } catch (error) {
      setSideloadStatus({ kind: 'error', message: String(error) });
    }
  }, []);

  const handleConfirmSideloadInstall = React.useCallback(async () => {
    if (!pendingSideload) return;
    setSideloadBusy(true);
    setSideloadStatus({ kind: 'idle', message: '' });
    try {
      const installed = await installSideloadPackage(
        pendingSideload.path,
        pendingSideload.info.sealed ? sideloadPassphrase : undefined,
      );
      await refreshSideloaded();
      setPendingSideload(null);
      setSideloadStatus({
        kind: 'success',
        message: `Installed ${installed.manifest.name} ${installed.manifest.version}.`,
      });
    } catch (error) {
      setSideloadStatus({ kind: 'error', message: String(error) });
    } finally {
      setSideloadBusy(false);
    }
  }, [pendingSideload, refreshSideloaded, sideloadPassphrase]);

  const handleConfirmRemoveSideload = React.useCallback(async () => {
    if (!pendingRemoveSideload) return;
    const target = pendingRemoveSideload;
    setPendingRemoveSideload(null);
    setSideloadBusy(true);
    try {
      await removeSideloadedPlugin(target.manifest.id);
      await refreshSideloaded();
      setSideloadStatus({ kind: 'success', message: `Removed ${target.manifest.name}.` });
    } catch (error) {
      setSideloadStatus({ kind: 'error', message: String(error) });
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

  const accentSecondaryActionColor = isLightTheme
    ? 'color-mix(in srgb, #4f8a08, var(--text-strong) 30%)'
    : 'var(--accent-secondary)';
  const accentSecondaryActionBorderColor = isLightTheme
    ? 'color-mix(in srgb, #6aa20d, var(--border-subtle) 34%)'
    : 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)';
  const accentSecondaryActionBackground92 = isLightTheme
    ? 'color-mix(in srgb, #6aa20d, var(--surface-1) 80%)'
    : 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)';
  const accentSecondaryActionStyle92: React.CSSProperties = {
    color: accentSecondaryActionColor,
    borderColor: accentSecondaryActionBorderColor,
    background: accentSecondaryActionBackground92,
  };
  const builtinShieldIconColor = isLightTheme
    ? 'color-mix(in srgb, #4f8a08, var(--text-strong) 28%)'
    : '#86efac';

  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 6%)' }}>
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <Plug className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Plugin Loader</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Install plugin manifests from GitHub repositories (profile packs only). Remote code execution is not supported.
            </p>
          </div>
        </div>
        {isDevRuntime && (
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            Debug URLs: <code>df://debug_plugin_official</code> and <code>df://debug_plugin_3rd</code>
          </p>
        )}

        <div className="mt-2.5 grid grid-cols-[1fr_auto] gap-2">
          <input
            type="text"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/<owner>/<repo> or df://debug_plugin_official"
            className="ui-input h-[34px] px-2.5 py-1.5 text-sm"
          />
          <Button
            type="button"
            onClick={() => { void handleInstall(); }}
            disabled={isInstalling}
            variant="secondary"
            size="auto"
            className="!h-[34px] !px-3 !py-0 text-xs inline-flex items-center gap-1.5 disabled:opacity-60"
            style={accentSecondaryActionStyle92}
          >
            {isInstalling ? <Spinner size="sm" /> : <Download className="h-3.5 w-3.5" />}
            {isInstalling ? 'Installing…' : 'Install Plugin'}
          </Button>
        </div>

        {status.kind !== 'idle' && (
          <div className="mt-2 text-xs" style={{ color: status.kind === 'error' ? '#fca5a5' : '#86efac' }}>
            {status.message}
          </div>
        )}
      </div>

      {isDesktop && (
        <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="flex items-start gap-2">
            <span
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
              style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
            >
              <PackagePlus className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            </span>
            <div className="flex-1 min-w-0">
              <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                <Trans>Sideloaded Plugins</Trans>
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                <Trans>Import a vendor&apos;s signed .dfplugin package. These contain native code and run with your user account, outside DragonFruit&apos;s control.</Trans>
              </p>
            </div>
            <Tooltip
              content={_(
                allowSideload
                  ? msg`Turn off to stop installing packages. Installed plugins stay on disk.`
                  : msg`Off by default. Only turn this on for a publisher you trust.`,
              )}
              wrapperClassName="flex items-center"
            >
              <Toggle
                checked={allowSideload}
                onChange={(next) => { void handleSideloadAllowanceChange(next); }}
                label={_(msg`Allow sideloaded complex plugins`)}
              />
            </Tooltip>
          </div>

          {allowSideload && (
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="inline-flex items-center gap-1.5"
                disabled={sideloadBusy}
                onClick={() => { void handlePickSideloadPackage(); }}
              >
                {sideloadBusy ? <Spinner size="sm" /> : <PackagePlus className="h-3.5 w-3.5" />}
                <Trans>Import plugin file…</Trans>
              </Button>
            </div>
          )}

          {allowSideload && sideloadPlugins.length === 0 && (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <Trans>No sideloaded plugins installed.</Trans>
            </p>
          )}

          {sideloadPlugins.length > 0 && (
            <div className="mt-2 space-y-2">
              {sideloadPlugins.map((plugin) => (
                <div
                  key={plugin.manifest.id}
                  className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-2"
                  style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                        {plugin.manifest.name}
                      </span>
                      <span className="text-[11px] rounded-full border px-1.5 py-0.5" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                        <Trans>v{plugin.manifest.version}</Trans>
                      </span>
                      <span
                        className="text-[11px] rounded-full border px-1.5 py-0.5"
                        style={{
                          borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 45%)',
                          color: 'var(--accent-secondary)',
                        }}
                      >
                        <Trans>Sideloaded</Trans>
                      </span>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {plugin.manifest.vendor.name}
                      {' · '}
                      <span className="font-mono">{shortFingerprint(plugin.publisherFingerprint)}</span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="auto"
                    className="!h-7 !px-2 !py-0 text-xs inline-flex items-center gap-1 shrink-0"
                    style={{ color: '#fca5a5' }}
                    disabled={sideloadBusy}
                    onClick={() => setPendingRemoveSideload(plugin)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              ))}
            </div>
          )}

          {sideloadStatus.kind !== 'idle' && (
            <div className="mt-2 text-xs" style={{ color: sideloadStatus.kind === 'error' ? '#fca5a5' : '#86efac' }}>
              {sideloadStatus.message}
            </div>
          )}
        </div>
      )}

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
        <p className="text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <Trans>
            DragonFruit cannot confirm who published this repository. A profile pack is data only — presets and
            material templates — so installing it cannot add code, but the values it declares are yours to check.
          </Trans>
        </p>
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
            <Button
              variant="tinted-accent"
              className="inline-flex items-center justify-center gap-1.5"
              disabled={sideloadBusy || (pendingSideload?.info.sealed === true && sideloadPassphrase.trim().length === 0)}
              onClick={() => { void handleConfirmSideloadInstall(); }}
            >
              {sideloadBusy ? <Spinner size="sm" /> : <PackagePlus className="h-3.5 w-3.5" />}
              {sideloadBusy ? <Trans>Installing…</Trans> : <Trans>Install</Trans>}
            </Button>
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
              <div className="break-all">
                <span style={{ color: 'var(--text-strong)' }}><Trans>Key</Trans>:</span>{' '}
                <span className="font-mono" style={{ color: 'var(--text-strong)' }}>{pendingSideload?.info.publisherFingerprint}</span>
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

        {pendingSideload?.info.sealed && (
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }} htmlFor="sideload-passphrase">
              <Trans>Passphrase</Trans>
            </label>
            <Input
              id="sideload-passphrase"
              type="password"
              autoComplete="off"
              className="mt-1"
              value={sideloadPassphrase}
              onChange={(event) => setSideloadPassphrase(event.target.value)}
              placeholder={_(msg`The key your vendor gave you`)}
            />
            <p className="mt-1 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <Trans>The key is stored locally so the plugin can load later. A leaked package stays unusable without it.</Trans>
            </p>
          </div>
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

      <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
        <div className="flex items-start gap-2">
          <span
            className="inline-flex h-8 w-8 items-center justify-center rounded-md border shrink-0"
            style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), transparent 8%)' }}
          >
            <PackageCheck className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </span>
          <div className="flex-1">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>Installed Plugins</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              Manage built-in and user-installed plugin packs.
            </p>
          </div>
        </div>

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
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {!isBuiltin && (
                        <Github className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
                      )}
                      {hasRepositoryLink ? (
                        <button
                          onClick={async () => {
                            const url = repositoryUrl as string;
                            try {
                              const { invoke } = await import('@tauri-apps/api/core');
                              await invoke('open_external_url', { url });
                            } catch {
                              window.open(url, '_blank');
                            }
                          }}
                          className="text-sm font-semibold truncate inline-flex items-center gap-1 underline underline-offset-2"
                          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                          title={repositoryUrl as string}
                        >
                          {manifest.name}
                          <ExternalLink className="h-3 w-3 shrink-0" />
                        </button>
                      ) : (
                        <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-strong)' }}>{manifest.name}</span>
                      )}
                    </div>
                    {isUnverifiedGithubPlugin && (
                      <div className="text-xs mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                        style={{
                          borderColor: 'color-mix(in srgb, #d97706, var(--border-subtle) 35%)',
                          color: 'color-mix(in srgb, #d97706, var(--text-strong) 18%)',
                          background: 'color-mix(in srgb, #d97706, var(--surface-2) 88%)',
                        }}
                        title={plugin.liabilityAcceptedAt ? `Liability accepted at ${plugin.liabilityAcceptedAt}` : 'Installed with liability acknowledgement'}
                      >
                        Unverified Source (User Approved)
                      </div>
                    )}
                    {manifest.description && (
                      <div className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {manifest.description}
                      </div>
                    )}


                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 self-center">
                    <Tooltip
                      content={(
                        <div className="space-y-0.5">
                          <div className="break-all"><span style={{ color: 'var(--text-strong)' }}><Trans>ID</Trans>:</span> {manifest.id}</div>
                          <div><span style={{ color: 'var(--text-strong)' }}><Trans>Source</Trans>:</span> {isBuiltin ? <Trans>Built-in</Trans> : <Trans>GitHub</Trans>}</div>
                          <div><span style={{ color: 'var(--text-strong)' }}><Trans>Version</Trans>:</span> <Trans>v{manifest.version}</Trans></div>
                        </div>
                      )}
                      maxWidth={280}
                      wrapperClassName="flex items-center"
                    >
                      <InfoIcon className="h-4 w-4 shrink-0 block" style={{ color: 'var(--text-muted)' }} />
                    </Tooltip>
                    {isBuiltin && (
                      <Tooltip content="Built-in plugin" wrapperClassName="flex items-center">
                        <ShieldCheck className="h-4 w-4 shrink-0 block" style={{ color: builtinShieldIconColor }} />
                      </Tooltip>
                    )}
                    {isOraVerifiedBuiltin ? (
                      <Tooltip content="Officially verified by ORA" wrapperClassName="flex items-center">
                        <CheckCircle2 className="h-4 w-4 shrink-0 block" style={{ color: 'color-mix(in srgb, #d97706, var(--text-strong) 18%)' }} />
                      </Tooltip>
                    ) : null}
                    {!isBuiltin && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="auto"
                        onClick={() => handleUninstall(manifest.id, manifest.name)}
                        className="!h-7 !px-2 !py-0 text-xs inline-flex items-center gap-1"
                        style={{ color: '#fca5a5' }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove
                      </Button>
                    )}
                  </div>
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
