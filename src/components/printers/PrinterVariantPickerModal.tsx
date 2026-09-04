"use client";

import React from 'react';
import { useEscapeToClose } from '@/hotkeys/useEscapeToClose';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Check, ChevronRight, Loader2, Printer, X } from 'lucide-react';
import { getProfileNetworkUiAdapter } from '@/features/plugins/pluginRegistry';
import { pluginNetworkFetch } from '@/utils/pluginNetworkBridge';
import { ManualIpEntryCard, SetupMethodChooser, SetupModeButton } from '@/components/printers/SetupMethodChooser';
import {
  matchPrinterVariantByBitDepth,
  type PrinterPreset,
} from '@/features/profiles/profileStore';

// Interpolated message helpers MUST stay at module scope (see AGENTS.md): React
// Compiler renames interpolated locals inside component bodies, desyncing Lingui
// message ids in production builds. Static strings can use `_(msg`...`)` inline.

// NOTE: interpolated messages must use static ICU patterns + values passed to
// `translate`. The `msg` macro strips dynamic template messages to `message: ""`,
// so Lingui falls back to the raw message id (e.g. "_Z5u4") when the catalog
// doesn't contain the id yet.

function formatDetectedVariantLabel(translate: (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string, variantName: string): string {
  return translate(msg({
    message: 'Detected: {variantName}',
    comment: 'Confirmation that the printer model variant was auto-detected over the network. {variantName} is the variant display name.',
  }), { variantName });
}

function formatScanningLabel(translate: (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string, presetName: string): string {
  return translate(msg({
    message: 'Scanning your network for {presetName} printers…',
    comment: 'Auto-detection is scanning the network for a matching printer. {presetName} is the printer family name.',
  }), { presetName });
}

function formatDevicesFoundLabel(translate: (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string, count: number): string {
  return translate(msg({
    message: '{count, plural, one {# printer found} other {# printers found}}',
    comment: 'How many matching printers the network scan discovered. {count} is a positive integer.',
  }), { count });
}

function formatUnmatchedBitDepthError(translate: (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string, bits: number | null, presetName: string): string {
  const bitsLabel = bits == null ? '?' : `${bits}-bit`;
  return translate(msg({
    message: "Detected a {bitsLabel} screen that doesn't match any known variant of {presetName}.",
    comment: 'Auto-detection found a bit depth with no matching variant. {bitsLabel} is the detected bit depth, {presetName} the printer family name.',
  }), { bitsLabel, presetName });
}

function formatConnectError(translate: (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string, host: string): string {
  return translate(msg({
    message: "Couldn't connect to {host}.",
    comment: 'Network connect failed for the given printer host/IP. {host} is the address.',
  }), { host });
}

function formatNoDevicesFoundMessage(translate: (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string, presetName: string): string {
  return translate(msg({
    message: 'No {presetName} printers found on the network.',
    comment: 'Network discovery found no matching printers. {presetName} is the printer family name.',
  }), { presetName });
}

/**
 * Strip a trailing variant suffix (e.g. " · 8-bit") from a variant display name
 * so the bit-depth chip on the option row doesn't repeat it.
 */
function stripVariantSuffix(name: string): string {
  const stripped = name.replace(/\s*[·–—-]\s*\d+\s*-?\s*bit$/i, '').trim();
  return stripped.length > 0 ? stripped : name;
}

/** Active-tab / primary-action accent styling, mirroring the material editor. */
const ACCENT_ACTION_STYLE: React.CSSProperties = {
  color: 'var(--accent-secondary)',
  borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
  background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
};

type DeviceInfo = {
  ipAddress: string;
  port?: number;
  printerName?: string;
  printerModel?: string;
  hostName?: string;
};

export type PrinterVariantPickerNetworkContext = {
  host: string;
  port?: number;
  /** The printer's own name reported by the `printer_data` probe (e.g. "Negotiator-Gourd"). */
  printerName?: string;
  /** The network mode the printer was connected with (e.g. "nanodlp"). */
  mode?: string;
};

type PrinterVariantPickerModalProps = {
  /** The family preset the user picked (carries `modelVariants` / `modelVariantDetectPath`). */
  preset: PrinterPreset;
  /** Concrete variant presets resolved from `preset.modelVariants`. */
  variants: PrinterPreset[];
  /** presetIds already installed as official profiles (options get disabled). */
  addedPresetIds: ReadonlySet<string>;
  /**
   * Called with the resolved concrete variant presetId. When the variant was
   * auto-detected over the network, `networkContext` carries the connected
   * host/port so the caller can persist the connection on the new profile.
   */
  onSelect: (variantPresetId: string, networkContext?: PrinterVariantPickerNetworkContext) => void;
  onClose: () => void;
};

/**
 * "Initial Setup" — resolves a family preset (e.g. an Athena II 16K with
 * 3-bit/8-bit variants) to one concrete variant preset.
 *
 * Two tabs: **Auto-detect** (network-first: scan → connect → probe the preset's
 * `modelVariantDetectPath` via the plugin network adapter → match the reported
 * bit-depth) and **Manual** (pick a variant directly).
 *
 * This component is fully generic: it only reads preset data and the plugin's
 * registered network adapter. No plugin-specific code lives here.
 */
export function PrinterVariantPickerModal({
  preset,
  variants,
  addedPresetIds,
  onSelect,
  onClose,
}: PrinterVariantPickerModalProps) {
  const { _ } = useLingui();

  const networkAdapter = React.useMemo(() => {
    const adapter = getProfileNetworkUiAdapter(preset.networkSupport);
    const hasDetectOps = Boolean(
      adapter?.operations?.discover
      && adapter?.operations?.connect
      && adapter?.operations?.printerData,
    );
    return preset.modelVariantDetectPath && hasDetectOps ? adapter : null;
  }, [preset.networkSupport, preset.modelVariantDetectPath]);

  const [mode, setMode] = React.useState<'choose' | 'scan' | 'manual' | 'ip'>(networkAdapter ? 'choose' : 'manual');
  const [manualIp, setManualIp] = React.useState('');
  const [scanning, setScanning] = React.useState(false);
  const [devices, setDevices] = React.useState<DeviceInfo[]>([]);
  const [scanError, setScanError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [connectingHost, setConnectingHost] = React.useState<string | null>(null);
  const [detectedVariant, setDetectedVariant] = React.useState<PrinterPreset | null>(null);
  const [detectedDeviceName, setDetectedDeviceName] = React.useState<string | null>(null);
  const [detectError, setDetectError] = React.useState<string | null>(null);
  // Shown once scanning drags on (~25s) without a detection, offering to add
  // the printer without networking and configure it later.
  const [showConfigureLater, setShowConfigureLater] = React.useState(false);

  // Kept out of the render path: the connect response gives the resolved
  // host/port used to create the profile once the variant is confirmed.
  const pendingNetworkRef = React.useRef<PrinterVariantPickerNetworkContext | undefined>(undefined);
  // Lets selecting a device abort the still-running subnet scan so the UI can
  // show the connection progress instead of the scanning bar.
  const scanAbortRef = React.useRef(false);

  useEscapeToClose(true, onClose);

  const runScan = React.useCallback(async () => {
    if (!networkAdapter) return;
    scanAbortRef.current = false;
    setScanning(true);
    setScanError(null);
    setDevices([]);

    const foundByAddress = new Map<string, DeviceInfo>();
    const collectDevices = (rawDevices: unknown[]) => {
      for (const device of rawDevices) {
        const row = (device ?? {}) as Record<string, unknown>;
        const ipAddress = typeof row.ipAddress === 'string' ? row.ipAddress.trim() : '';
        if (!ipAddress) continue;
        const port = Number(row.port);
        if (foundByAddress.has(ipAddress)) continue;
        foundByAddress.set(ipAddress, {
          ipAddress,
          port: Number.isFinite(port) && port > 0 ? port : undefined,
          printerName: typeof row.printerName === 'string' ? row.printerName : undefined,
          printerModel: typeof row.printerModel === 'string' ? row.printerModel : undefined,
          hostName: typeof row.hostName === 'string' ? row.hostName : undefined,
        });
      }
      setDevices(Array.from(foundByAddress.values()));
    };

    try {
      // Run the fast local/mDNS pass and the progressive subnet scan
      // concurrently. Athena printers don't advertise mDNS, so the subnet scan
      // is what actually finds them; the local pass adds any Bonjour-advertising
      // devices without delaying the subnet scan.
      await Promise.all([
        (async () => {
          const localResponse = await pluginNetworkFetch({
            pluginId: networkAdapter.pluginId,
            operation: networkAdapter.operations.discover,
            mode: preset.networkSupport,
            scanScope: 'local-hostnames',
            networkFilter: preset.networkFilter ?? undefined,
            ports: [80, 8080],
          });
          const localPayload = (await localResponse.json().catch(() => null)) as { devices?: unknown; error?: unknown } | null;
          if (!localResponse.ok) {
            const rawError = typeof localPayload?.error === 'string' && localPayload.error.trim() ? localPayload.error.trim() : '';
            setScanError(rawError || _(msg`Network scan failed.`));
            return;
          }
          if (Array.isArray(localPayload?.devices)) collectDevices(localPayload.devices);
        })(),
        (async () => {
          let batchStart = 0;
          while (true) {
            const response = await pluginNetworkFetch({
              pluginId: networkAdapter.pluginId,
              operation: networkAdapter.operations.discover,
              mode: preset.networkSupport,
              scanScope: 'subnet',
              progressive: true,
              batchStart,
              batchSize: 96,
              networkFilter: preset.networkFilter ?? undefined,
              ports: [80, 8080],
            });
            const payload = (await response.json().catch(() => null)) as {
              devices?: unknown;
              error?: unknown;
              done?: unknown;
              nextBatchStart?: unknown;
            } | null;
            if (!response.ok) {
              const rawError = typeof payload?.error === 'string' && payload.error.trim() ? payload.error.trim() : '';
              setScanError(rawError || _(msg`Network scan failed.`));
              break;
            }

            if (Array.isArray(payload?.devices)) collectDevices(payload.devices);

            // ARP priority puts the likely printer in the first batch — stop
            // scanning once a matching device is found so discovery completes
            // in a couple of seconds instead of a full subnet sweep.
            if (foundByAddress.size > 0) break;
            if (scanAbortRef.current) break;
            const done = payload?.done === true;
            const nextBatchRaw = Number(payload?.nextBatchStart);
            const nextBatchStart = Number.isFinite(nextBatchRaw) ? nextBatchRaw : batchStart;
            if (done || nextBatchStart <= batchStart) break;
            batchStart = nextBatchStart;
          }
        })(),
      ]);

      if (foundByAddress.size === 0) {
        setScanError(formatNoDevicesFoundMessage(_, preset.name));
      }
    } catch {
      setScanError(_(msg`Network scan failed.`));
    } finally {
      setScanning(false);
      // Whether or not the scan found anything, offer the offline fallback.
      setShowConfigureLater(true);
    }
  }, [networkAdapter, preset.networkSupport, preset.networkFilter, preset.name, _]);

  // If the scan has been going ~25s without a detection, offer to skip
  // networking so the user isn't stuck waiting on a long subnet scan.
  React.useEffect(() => {
    const timer = window.setTimeout(() => setShowConfigureLater(true), 25000);
    return () => window.clearTimeout(timer);
  }, []);

  const handleAutoDiscovery = React.useCallback(() => {
    setMode('scan');
    void runScan();
  }, [runScan]);

  const connectAndDetect = React.useCallback(async (hostInput: string, portInput?: number) => {
    if (!networkAdapter) return;
    const targetHost = hostInput.trim();
    if (!targetHost) return;

    // Stop the still-running scan so the UI shows connection progress, not the
    // scanning bar.
    scanAbortRef.current = true;
    setScanning(false);
    setShowConfigureLater(false);
    setBusy(true);
    setDetectError(null);
    setDetectedVariant(null);
    setDetectedDeviceName(null);
    setConnectingHost(targetHost);
    pendingNetworkRef.current = undefined;

    try {
      const connectResponse = await pluginNetworkFetch({
        pluginId: networkAdapter.pluginId,
        operation: networkAdapter.operations.connect,
        host: targetHost,
        port: portInput,
        networkFilter: preset.networkFilter ?? undefined,
      });
      const connectPayload = (await connectResponse.json().catch(() => null)) as Record<string, unknown> | null;
      if (connectPayload?.connected !== true) {
        const reason = typeof connectPayload?.statusText === 'string' && connectPayload.statusText.trim()
          ? connectPayload.statusText.trim()
          : null;
        setDetectError(reason || formatConnectError(_, targetHost));
        return;
      }

      const resolvedHost = typeof connectPayload?.ipAddress === 'string' && connectPayload.ipAddress.trim()
        ? connectPayload.ipAddress.trim()
        : targetHost;
      const resolvedPortRaw = Number(connectPayload?.port);
      const resolvedPort = Number.isFinite(resolvedPortRaw) && resolvedPortRaw > 0 ? resolvedPortRaw : portInput;

      const dataResponse = await pluginNetworkFetch({
        pluginId: networkAdapter.pluginId,
        operation: networkAdapter.operations.printerData,
        host: resolvedHost,
        port: resolvedPort,
        path: preset.modelVariantDetectPath,
      });
      const dataPayload = (await dataResponse.json().catch(() => null)) as Record<string, unknown> | null;
      if (dataPayload?.ok !== true) {
        const rawError = typeof dataPayload?.error === 'string' && dataPayload.error.trim()
          ? dataPayload.error.trim()
          : '';
        setDetectError(rawError || _(msg`Could not read printer data.`));
        return;
      }

      const detectedBits = Number(dataPayload?.bitdepth);
      // Multi-variant presets resolve the concrete variant from the reported
      // bit depth. Presets without variants (e.g. other Athena models) are
      // "detected" as themselves — the networking setup is the point.
      const matched = variants.length > 0
        ? matchPrinterVariantByBitDepth(variants, Number.isFinite(detectedBits) ? detectedBits : null)
        : null;
      if (variants.length > 0 && !matched) {
        setDetectError(formatUnmatchedBitDepthError(_, Number.isFinite(detectedBits) ? detectedBits : null, preset.name));
        return;
      }

      const reportedPrinterName = typeof dataPayload?.printerName === 'string' && dataPayload.printerName.trim()
        ? dataPayload.printerName.trim()
        : null;
      setDetectedVariant(matched ?? preset);
      setDetectedDeviceName(reportedPrinterName);
      pendingNetworkRef.current = {
        host: resolvedHost,
        port: resolvedPort,
        printerName: reportedPrinterName ?? undefined,
        mode: preset.networkSupport,
      };
    } catch {
      setDetectError(formatConnectError(_, targetHost));
    } finally {
      setBusy(false);
    }
  }, [networkAdapter, preset, variants, _]);

  const handleManualIpConnect = React.useCallback(() => {
    const host = manualIp.trim();
    if (!host) return;
    void connectAndDetect(host);
  }, [connectAndDetect, manualIp]);

  const handleConfirmDetected = React.useCallback(() => {
    if (!detectedVariant) return;
    onSelect(detectedVariant.presetId, pendingNetworkRef.current);
  }, [detectedVariant, onSelect]);

  const handleSelectVariant = React.useCallback((variant: PrinterPreset) => {
    onSelect(variant.presetId);
  }, [onSelect]);

  const detectedAlreadyAdded = detectedVariant ? addedPresetIds.has(detectedVariant.presetId) : false;
  const connecting = busy && connectingHost != null;
  const showNetworkMode = networkAdapter != null && mode === 'scan';
  const detectedDisplayName = detectedDeviceName?.trim() || detectedVariant?.name || '';

  return (
    <div
      className="ui-modal-backdrop-enter fixed inset-0 z-[65] flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="ui-modal-panel-enter flex max-h-[88vh] w-full max-w-[560px] min-h-0 flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}
        role="dialog"
        aria-modal="true"
        aria-label="Initial Setup"
      >
        {/* Header */}
        <div
          className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
              {_(msg`Initial Setup`)}
            </h3>
            <p className="ui-meta truncate">{preset.libraryDisplayName ?? preset.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
            aria-label={_(msg`Close`)}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          {!networkAdapter && variants.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {_(msg`This printer has no setup options.`)}
            </p>
          ) : (
            <>
              {mode === 'choose' ? (
                <SetupMethodChooser
                  onAutoDetect={handleAutoDiscovery}
                  onManualIp={() => setMode('ip')}
                />
              ) : showNetworkMode ? (
                <div className="space-y-3">
                  {/* Status card */}
                  <div
                    className="rounded-xl border px-3 py-2.5"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      background: 'color-mix(in srgb, var(--surface-1), var(--surface-0) 30%)',
                    }}
                  >
                    {detectedVariant ? (
                      <div>
                        <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                          {formatDetectedVariantLabel(_, detectedDisplayName)}
                        </div>
                        <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {detectedDeviceName ? detectedVariant.name : _(msg`The printer reported this variant.`)}
                        </div>
                        {detectedAlreadyAdded && (
                          <div className="mt-1.5 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                            {_(msg`This model is already added.`)}
                          </div>
                        )}
                      </div>
                    ) : connecting ? (
                      <div className="flex items-center gap-2.5">
                        <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--accent-secondary)' }} />
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {_(msg`Detecting model…`)}
                        </span>
                      </div>
                    ) : scanning ? (
                      <div className="space-y-2">
                        <span className="block truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                          {formatScanningLabel(_, preset.libraryDisplayName ?? preset.name)}
                        </span>
                        <div
                          className="ui-loading-track h-1.5 w-full rounded-full"
                          style={{ background: 'color-mix(in srgb, var(--surface-2), var(--surface-0) 40%)' }}
                        >
                          <div
                            className="ui-loading-indicator"
                            style={{
                              background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent-secondary), var(--surface-0) 30%), var(--accent))',
                            }}
                          />
                        </div>
                      </div>
                    ) : devices.length > 0 ? (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                          {formatDevicesFoundLabel(_, devices.length)}
                        </span>
                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                          {_(msg`Select a printer to detect its model.`)}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {scanError ?? _(msg`No printers found.`)}
                        </span>
                        <button
                          type="button"
                          onClick={() => { void runScan(); }}
                          className="ui-button ui-button-secondary !h-6 !px-2.5 !py-0 text-[11px] rounded-md"
                        >
                          {_(msg`Scan again`)}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Device list */}
                  {!detectedVariant && devices.length > 0 && (
                    <div className="space-y-1.5">
                      {devices.map((device) => {
                        const displayName = device.printerName || device.printerModel || device.hostName || device.ipAddress;
                        return (
                          <button
                            key={`${device.ipAddress}:${device.port ?? ''}`}
                            type="button"
                            disabled={busy}
                            onClick={() => { void connectAndDetect(device.ipAddress, device.port); }}
                            className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent),var(--border-subtle)_45%)] disabled:opacity-55"
                            style={{
                              borderColor: 'var(--border-subtle)',
                              background: 'color-mix(in srgb, var(--surface-1), var(--surface-0) 40%)',
                            }}
                          >
                            <span
                              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
                              style={{
                                borderColor: 'var(--border-subtle)',
                                background: 'var(--surface-1)',
                                color: 'var(--accent-secondary)',
                              }}
                            >
                              <Printer className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                                {displayName}
                              </span>
                              <span className="mt-0.5 block truncate text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                {device.ipAddress}{device.port ? `:${device.port}` : ''}
                              </span>
                            </span>
                            {connecting ? (
                              <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: 'var(--text-muted)' }} />
                            ) : (
                              <ChevronRight className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Errors */}
                  {!detectedVariant && detectError && (
                    <p className="text-[11px] leading-snug" style={{ color: '#f87171' }}>
                      {detectError}
                    </p>
                  )}

                  {/* Fallback: skip networking entirely */}
                  {!detectedVariant && !connecting && devices.length === 0 && showConfigureLater && (
                    <div className="pt-1 text-center">
                      <button
                        type="button"
                        onClick={() => {
                          if (variants.length > 0) {
                            setMode('manual');
                          } else {
                            onSelect(preset.presetId);
                          }
                        }}
                        className="text-xs font-semibold underline-offset-2 hover:underline"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {_(msg`Configure Networking Later`)}
                      </button>
                    </div>
                  )}
                </div>
              ) : mode === 'ip' ? (
                <div className="space-y-3">
                  {detectedVariant ? (
                    <div
                      className="rounded-xl border px-3 py-2.5"
                      style={{
                        borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 55%)',
                        background: 'color-mix(in srgb, var(--accent), var(--surface-1) 92%)',
                      }}
                    >
                      <div className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                        {formatDetectedVariantLabel(_, detectedDisplayName)}
                      </div>
                      <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {detectedDeviceName ? detectedVariant.name : _(msg`The printer reported this variant.`)}
                      </div>
                    </div>
                  ) : (
                    <ManualIpEntryCard
                      value={manualIp}
                      onChange={setManualIp}
                      onConnect={handleManualIpConnect}
                      isConnecting={busy}
                    />
                  )}

                </div>
              ) : (
                <div className="space-y-2">
                  {variants.map((variant) => {
                    const isAdded = addedPresetIds.has(variant.presetId);
                    const bits = Number.isFinite(Number(variant.bitDepth?.bits))
                      ? Math.round(Number(variant.bitDepth?.bits))
                      : null;
                    return (
                      <button
                        key={variant.presetId}
                        type="button"
                        disabled={isAdded}
                        onClick={() => handleSelectVariant(variant)}
                        className="flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent),var(--border-subtle)_45%)] disabled:opacity-55"
                        style={{
                          borderColor: 'var(--border-subtle)',
                          background: 'color-mix(in srgb, var(--surface-1), var(--surface-0) 40%)',
                        }}
                      >
                        <span
                          className="inline-flex h-6 min-w-[46px] shrink-0 items-center justify-center rounded border px-1.5 text-[10px] font-bold leading-none"
                          style={{
                            borderColor: bits === 8
                              ? 'color-mix(in srgb, #22c55e, white 22%)'
                              : bits === 3
                                ? 'color-mix(in srgb, #ef4444, white 18%)'
                                : 'color-mix(in srgb, var(--accent-secondary), white 20%)',
                            color: '#f8fafc',
                            background: bits === 8
                              ? 'linear-gradient(135deg, color-mix(in srgb, #22c55e, #111827 56%), color-mix(in srgb, #22c55e, #0b1220 72%))'
                              : bits === 3
                                ? 'linear-gradient(135deg, color-mix(in srgb, #ef4444, #111827 56%), color-mix(in srgb, #ef4444, #0b1220 72%))'
                                : 'linear-gradient(135deg, color-mix(in srgb, var(--accent-secondary), #111827 52%), color-mix(in srgb, var(--accent-secondary), #0b1220 68%))',
                          }}
                        >
                          {bits != null ? `${bits}-bit` : ''}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                            {variant.libraryDisplayName ?? stripVariantSuffix(variant.name)}
                          </span>
                          {variant.bitDepth?.description && (
                            <span className="mt-0.5 block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {variant.bitDepth.description}
                            </span>
                          )}
                        </span>
                        {isAdded ? (
                          <span className="shrink-0 text-[10px] font-bold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                            {_(msg`Added`)}
                          </span>
                        ) : (
                          <ChevronRight className="h-4 w-4 shrink-0" style={{ color: 'var(--text-muted)' }} />
                        )}
                      </button>
                    );
                  })}

                </div>
              )}
            </>
          )}
        </div>

        {/* Footer — hidden on the method chooser; the header X handles closing. */}
        {mode !== 'choose' && (
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <SetupModeButton
            mode={mode === 'scan' ? 'auto' : 'manual'}
            onSwitch={() => {
              if (mode === 'scan') {
                setMode('ip');
              } else {
                setMode('scan');
                void runScan();
              }
            }}
          />
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
            >
              {_(msg`Cancel`)}
            </button>
            {showNetworkMode && detectedVariant && !detectedAlreadyAdded && (
              <button
                type="button"
                onClick={handleConfirmDetected}
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 inline-flex items-center gap-1 text-xs rounded-full"
                style={ACCENT_ACTION_STYLE}
              >
                <Check className="h-3.5 w-3.5" />
                {_(msg`Add printer`)}
              </button>
            )}
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

export default PrinterVariantPickerModal;
