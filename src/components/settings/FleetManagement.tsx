import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { MessageDescriptor } from '@lingui/core';
import { Check, Loader2, Plus, Printer, RefreshCw, Search, Trash2, Unplug, X } from 'lucide-react';
import { ManualIpEntryCard, SetupMethodChooser, SetupModeButton } from '@/components/printers/SetupMethodChooser';
import type { PrinterNetworkDevice } from '@/features/profiles/profileStore';

type Translate = (descriptor: MessageDescriptor, values?: Record<string, unknown>) => string;

// Counts carry plurals, so they go through static ICU patterns in module-level
// formatters rather than inline interpolation — same rule as the printer picker.
function formatFleetCountsLabel(translate: Translate, saved: number, online: number): string {
  return translate(msg({
    message: '{saved, plural, one {# saved} other {# saved}} • {online, plural, one {# online} other {# online}}',
    comment: 'Counter above the managed printer list: how many printers are saved and how many are reachable.',
  }), { saved, online });
}

function formatDiscoveredCountLabel(translate: Translate, count: number): string {
  return translate(msg({
    message: '{count, plural, one {# found} other {# found}}',
    comment: 'Badge counting the printers the network scan turned up.',
  }), { count });
}

type DiscoveredNetworkPrinter = {
  id: string;
  name: string;
  ipAddress: string;
  status: 'online' | 'reachable';
};

type FleetManagementProps = {
  printerName: string;
  managedPrinters: PrinterNetworkDevice[];
  printerReachabilityByDeviceId?: Record<string, boolean | null>;
  activePrinterId: string | null;
  showAddPrinterFlow: boolean;
  onEnterAddPrinterFlow: () => void;
  onExitAddPrinterFlow: () => void;
  onRunDiscovery: () => void;
  isNetworkScanning: boolean;
  networkScanPhaseLabel: string;
  discoveredPrinters: DiscoveredNetworkPrinter[];
  isNetworkConnecting: boolean;
  onConnectDiscovered: (printer: DiscoveredNetworkPrinter) => void;
  onSelectManagedPrinter: (device: PrinterNetworkDevice) => void;
  onReconnectManagedPrinter: (device: PrinterNetworkDevice) => void;
  onDisconnectManagedPrinter: (device: PrinterNetworkDevice) => void;
  onRemoveManagedPrinter: (device: PrinterNetworkDevice) => void;
  networkIpAddress: string;
  onNetworkIpAddressChange: (value: string) => void;
  onConnectManual: () => void;
  activePrinterSummary: string;
  onClose: () => void;
};

export function FleetManagement({
  printerName,
  managedPrinters,
  printerReachabilityByDeviceId,
  activePrinterId,
  showAddPrinterFlow,
  onEnterAddPrinterFlow,
  onExitAddPrinterFlow,
  onRunDiscovery,
  isNetworkScanning,
  networkScanPhaseLabel,
  discoveredPrinters,
  isNetworkConnecting,
  onConnectDiscovered,
  onSelectManagedPrinter,
  onReconnectManagedPrinter,
  onDisconnectManagedPrinter,
  onRemoveManagedPrinter,
  networkIpAddress,
  onNetworkIpAddressChange,
  onConnectManual,
  activePrinterSummary,
  onClose,
}: FleetManagementProps) {
  const { _ } = useLingui();
  const [method, setMethod] = React.useState<'scan' | 'manual' | null>(null);

  // Reset the add-printer method picker each time the add flow is entered.
  React.useEffect(() => {
    setMethod(null);
  }, [showAddPrinterFlow]);
  const connectedCount = managedPrinters.filter((device) => device.connected).length;
  const hasMultiplePrinters = managedPrinters.length > 1;
  const activeManagedPrinter = managedPrinters.find((device) => device.id === activePrinterId) ?? null;
  const nonActiveManagedPrinters = managedPrinters.filter((device) => device.id !== activePrinterId);
  const orderedManagedPrinters = activeManagedPrinter
    ? [activeManagedPrinter, ...nonActiveManagedPrinters]
    : managedPrinters;

  return (
    <div className="flex max-h-[92vh] w-full max-w-[560px] min-h-0 flex-col overflow-hidden rounded-xl border shadow-2xl ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            {hasMultiplePrinters ? _(msg`Fleet Management`) : _(msg`Network Settings`)}
          </h3>
          <p className="ui-meta truncate">{printerName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
          aria-label={_(msg`Close network settings`)}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {managedPrinters.length > 0 && (
        <div className="rounded-xl border p-3.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
          <div className="flex items-center justify-between gap-3">
            <h5 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              <Trans>Managed Printers</Trans>
            </h5>
            <div className="text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
              {formatFleetCountsLabel(_, managedPrinters.length, connectedCount)}
            </div>
          </div>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {hasMultiplePrinters
              ? _(msg`Your fleet for this profile.`)
              : _(msg`Primary printer assigned to this profile.`)}
          </p>

          {managedPrinters.length === 0 ? (
            <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <Trans>No printers saved yet. Add one below to start.</Trans>
            </div>
          ) : (
            <div className="mt-2.5 space-y-2 max-h-[328px] overflow-y-auto custom-scrollbar pr-1">
              {orderedManagedPrinters.map((device, index) => {
                const isActive = device.id === activePrinterId;
                const isOfflineByProbe = printerReachabilityByDeviceId?.[device.id] === false;
                const isOnline = device.connected && !isOfflineByProbe;
                const cardBackground = 'var(--surface-0)';
                return (
                  <React.Fragment key={device.id}>
                    {activeManagedPrinter && index === 1 && (
                      <div className="my-1.5 border-t pt-1" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                          Other Printers
                        </div>
                      </div>
                    )}
                    <div
                      className="relative rounded-md border px-3 py-2.5 pl-10"
                      style={{
                        borderColor: 'var(--border-subtle)',
                        background: cardBackground,
                      }}
                    >
                      <span
                        className="absolute inset-y-0.5 left-0.5 w-14 rounded-md pointer-events-none"
                        style={isOnline
                          ? {
                              background: 'linear-gradient(90deg, color-mix(in srgb, #22c55e, transparent 8%) 0%, color-mix(in srgb, #22c55e, transparent 40%) 20%, color-mix(in srgb, #22c55e, transparent 68%) 40%, color-mix(in srgb, #22c55e, transparent 84%) 62%, transparent 82%)',
                            }
                          : {
                              background: 'linear-gradient(90deg, color-mix(in srgb, #ef4444, transparent 8%) 0%, color-mix(in srgb, #ef4444, transparent 40%) 20%, color-mix(in srgb, #ef4444, transparent 68%) 40%, color-mix(in srgb, #ef4444, transparent 84%) 62%, transparent 82%)',
                            }}
                        aria-hidden="true"
                      />
                      <span
                        className="absolute left-1.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center pointer-events-none"
                        style={{ color: cardBackground }}
                        aria-label={isOnline ? _(msg`Printer online`) : _(msg`Printer offline`)}
                        title={isOnline ? _(msg`Online`) : _(msg`Offline`)}
                      >
                        {isOnline
                          ? <Check className="h-[18px] w-[18px]" strokeWidth={3} />
                          : <X className="h-[18px] w-[18px]" strokeWidth={3} />}
                      </span>

                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                            {device.displayName || device.hostName || device.ipAddress}
                          </div>
                          <div className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                            {device.ipAddress} • {isOnline ? _(msg`Online`) : _(msg`Offline`)}
                          </div>
                          {device.statusText && (
                            <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                              {device.statusText}
                            </div>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-1">
                          {!isActive && (
                            <button
                              type="button"
                              onClick={() => onSelectManagedPrinter(device)}
                              className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-xs rounded-full"
                              style={{ color: 'var(--text-strong)' }}
                            >
                              <Trans>Select</Trans>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onReconnectManagedPrinter(device)}
                            disabled={isNetworkConnecting}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-45"
                            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--accent-secondary)' }}
                            title={device.connected ? _(msg`Refresh`) : _(msg`Connect`)}
                            aria-label={device.connected ? _(msg`Refresh`) : _(msg`Connect`)}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onDisconnectManagedPrinter(device)}
                            disabled={!device.connected}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors disabled:opacity-45"
                            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: device.connected ? 'var(--text-strong)' : 'var(--text-muted)' }}
                            title={_(msg`Disconnect`)}
                            aria-label={_(msg`Disconnect`)}
                          >
                            <Unplug className="h-3.5 w-3.5" />
                          </button>
                          {!device.connected && (
                            <button
                              type="button"
                              onClick={() => onRemoveManagedPrinter(device)}
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors"
                              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--danger)' }}
                              title={_(msg`Remove saved printer`)}
                              aria-label={_(msg`Remove`)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2 border-t pt-2.5" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {activePrinterSummary}
            </div>
            {!showAddPrinterFlow ? (
              <button
                type="button"
                onClick={onEnterAddPrinterFlow}
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-full"
                style={{ color: 'var(--accent-secondary)' }}
              >
                <Plus className="h-3.5 w-3.5" />
                <Trans>Add Printer</Trans>
              </button>
            ) : (
              managedPrinters.length > 0 && (
                <button
                  type="button"
                  onClick={onExitAddPrinterFlow}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <Trans>Done Adding</Trans>
                </button>
              )
            )}
          </div>
        </div>
        )}

        {showAddPrinterFlow && (
          <>
            {method === null ? (
              <SetupMethodChooser
                onAutoDetect={() => { setMethod('scan'); onRunDiscovery(); }}
                onManualIp={() => setMethod('manual')}
              />
            ) : method === 'scan' ? (
              <>
                {/* Discovery status */}
                <div
                  className="rounded-xl border px-3 py-2.5"
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--surface-1), var(--surface-0) 30%)',
                  }}
                >
                  {isNetworkScanning ? (
                    <div className="space-y-2">
                      <span className="block truncate text-xs" style={{ color: 'var(--text-muted)' }}>
                        {_(msg`Scanning your local network…`)}
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
                      <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>
                        {networkScanPhaseLabel || _(msg`Scanning network…`)}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                        {discoveredPrinters.length > 0
                          ? `${discoveredPrinters.length} printer${discoveredPrinters.length !== 1 ? 's' : ''} found`
                          : _(msg`No printers found.`)}
                      </span>
                      <button
                        type="button"
                        onClick={onRunDiscovery}
                        className="ui-button ui-button-secondary !h-7 !px-2.5 !py-0 text-xs inline-flex items-center gap-1 rounded-full"
                        style={{ color: 'var(--accent-secondary)' }}
                      >
                        <Search className="h-3 w-3" />
                        {_(msg`Scan again`)}
                      </button>
                    </div>
                  )}
                </div>

                {/* Discovered printers — only shown once any are found */}
                {discoveredPrinters.length > 0 && (
                  <div className="rounded-xl border p-3.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <h5 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                        <Trans>Discovered Printers</Trans>
                      </h5>
                      <span className="rounded-full border px-2 py-0.5 text-[10px] font-semibold tabular-nums" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                        {formatDiscoveredCountLabel(_, discoveredPrinters.length)}
                      </span>
                    </div>

                    <div className="mt-2 space-y-1.5 max-h-[180px] overflow-y-auto custom-scrollbar pr-1">
                      {discoveredPrinters.map((entry) => {
                        const savedEntry = managedPrinters.find((device) => device.ipAddress === entry.ipAddress) ?? null;
                        const isEntryConnected = savedEntry?.connected === true;

                        return (
                          <div
                            key={entry.id}
                            className="flex items-center gap-3 rounded-md border px-3 py-2.5"
                            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)' }}
                          >
                            <span
                              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
                              style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--accent-secondary)' }}
                            >
                              <Printer className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-semibold" style={{ color: 'var(--text-strong)' }}>
                                {entry.name}
                              </span>
                              <span className="mt-0.5 block truncate text-[11px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
                                {entry.ipAddress}
                              </span>
                            </span>
                            {isEntryConnected ? (
                              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-semibold" style={{ color: '#22c55e' }}>
                                <Check className="h-3.5 w-3.5" />
                                <Trans>Connected</Trans>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => onConnectDiscovered(entry)}
                                disabled={isNetworkConnecting}
                                className="ui-button ui-button-secondary !h-7 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-full disabled:opacity-60"
                                style={{ color: 'var(--accent-secondary)' }}
                              >
                                {isNetworkConnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                                {isNetworkConnecting ? _(msg`Connecting…`) : _(msg`Connect`)}
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              </>
            ) : (
              <ManualIpEntryCard
                value={networkIpAddress}
                onChange={onNetworkIpAddressChange}
                onConnect={onConnectManual}
                isConnecting={isNetworkConnecting}
              />
            )}
          </>
        )}

      </div>

      {/* Footer — Auto/Manual toggle + Cancel, hidden on the method chooser. */}
      {method !== null && showAddPrinterFlow && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-t px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
          <SetupModeButton
            mode={method === 'scan' ? 'auto' : 'manual'}
            onSwitch={() => {
              if (method === 'scan') {
                setMethod('manual');
              } else {
                setMethod('scan');
                onRunDiscovery();
              }
            }}
          />
          <button
            type="button"
            onClick={onClose}
            className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
          >
            <Trans>Cancel</Trans>
          </button>
        </div>
      )}
    </div>
  );
}

export default FleetManagement;
