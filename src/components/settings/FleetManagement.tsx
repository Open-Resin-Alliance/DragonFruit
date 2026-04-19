import React from 'react';
import { Check, Loader2, Plus, Search, Wifi, X } from 'lucide-react';
import type { PrinterNetworkDevice } from '@/features/profiles/profileStore';

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
  networkDiscoveryEnabled: boolean;
  onToggleDiscovery: () => void;
  onRunDiscovery: () => void;
  isNetworkScanning: boolean;
  networkScanProgressPct: number;
  networkScanPhaseLabel: string;
  discoveredPrinters: DiscoveredNetworkPrinter[];
  isNetworkConnecting: boolean;
  onConnectDiscovered: (printer: DiscoveredNetworkPrinter) => void;
  onSelectManagedPrinter: (device: PrinterNetworkDevice) => void;
  onReconnectManagedPrinter: (device: PrinterNetworkDevice) => void;
  onDisconnectManagedPrinter: (device: PrinterNetworkDevice) => void;
  onRemoveManagedPrinter: (device: PrinterNetworkDevice) => void;
  showManualNetworkEntry: boolean;
  onToggleManualEntry: () => void;
  networkIpAddress: string;
  onNetworkIpAddressChange: (value: string) => void;
  onConnectManual: () => void;
  activePrinterSummary: string;
  onClose: () => void;
  onSave: () => void;
};

export function FleetManagement({
  printerName,
  managedPrinters,
  printerReachabilityByDeviceId,
  activePrinterId,
  showAddPrinterFlow,
  onEnterAddPrinterFlow,
  onExitAddPrinterFlow,
  networkDiscoveryEnabled,
  onToggleDiscovery,
  onRunDiscovery,
  isNetworkScanning,
  networkScanProgressPct,
  networkScanPhaseLabel,
  discoveredPrinters,
  isNetworkConnecting,
  onConnectDiscovered,
  onSelectManagedPrinter,
  onReconnectManagedPrinter,
  onDisconnectManagedPrinter,
  onRemoveManagedPrinter,
  showManualNetworkEntry,
  onToggleManualEntry,
  networkIpAddress,
  onNetworkIpAddressChange,
  onConnectManual,
  activePrinterSummary,
  onClose,
  onSave,
}: FleetManagementProps) {
  const connectedCount = managedPrinters.filter((device) => device.connected).length;
  const hasMultiplePrinters = managedPrinters.length > 1;
  const activeManagedPrinter = managedPrinters.find((device) => device.id === activePrinterId) ?? null;
  const nonActiveManagedPrinters = managedPrinters.filter((device) => device.id !== activePrinterId);
  const orderedManagedPrinters = activeManagedPrinter
    ? [activeManagedPrinter, ...nonActiveManagedPrinters]
    : managedPrinters;

  return (
    <div className="w-full max-w-[920px] rounded-xl border shadow-2xl ui-modal-panel-enter" style={{ borderColor: 'var(--border-strong)', background: 'var(--surface-0)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
        <div>
          <h3 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            {hasMultiplePrinters ? 'Fleet Management' : 'Network Settings'}
          </h3>
          <p className="ui-meta">{printerName}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md border"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)', color: 'var(--text-muted)' }}
          aria-label="Close network settings"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="p-5 space-y-4">
        {managedPrinters.length > 0 && (
        <div className="rounded-lg border p-4" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Managed Printers</div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {hasMultiplePrinters ? 'Your fleet for this profile.' : 'Primary printer assigned to this profile.'}
              </div>
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {managedPrinters.length} saved • {connectedCount} online
            </div>
          </div>

          {managedPrinters.length === 0 ? (
            <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              No printers saved yet. Add one below to start.
            </div>
          ) : (
            <div className="mt-2.5 space-y-2 max-h-[328px] overflow-y-auto custom-scrollbar pr-1">
              {orderedManagedPrinters.map((device, index) => {
                const isActive = device.id === activePrinterId;
                const isOfflineByProbe = printerReachabilityByDeviceId?.[device.id] === false;
                const isOnline = device.connected && !isOfflineByProbe;
                const cardBackground = 'var(--surface-1)';
                return (
                  <React.Fragment key={device.id}>
                    {activeManagedPrinter && index === 1 && (
                      <div
                        className="my-1.5 border-t pt-1"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
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
                      style={{
                        color: cardBackground,
                      }}
                      aria-label={isOnline ? 'Printer online' : 'Printer offline'}
                      title={isOnline ? 'Online' : 'Offline'}
                    >
                      {isOnline
                        ? <Check className="w-[18px] h-[18px]" strokeWidth={3} />
                        : <X className="w-[18px] h-[18px]" strokeWidth={3} />}
                    </span>

                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                            {device.displayName || device.hostName || device.ipAddress}
                          </div>
                        </div>
                        <div className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                          {device.ipAddress} • {isOnline ? 'Online' : 'Offline'}
                        </div>
                        {device.statusText && (
                          <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>
                            {device.statusText}
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {!isActive && (
                          <button
                            type="button"
                            onClick={() => onSelectManagedPrinter(device)}
                            className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-[11px] rounded-md"
                            style={{ color: 'var(--text-strong)' }}
                          >
                            Select
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onReconnectManagedPrinter(device)}
                          disabled={isNetworkConnecting}
                          className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-[11px] rounded-md disabled:opacity-50"
                          style={{ color: 'var(--accent-secondary)' }}
                        >
                          {device.connected ? 'Refresh' : 'Connect'}
                        </button>
                        <button
                          type="button"
                          onClick={() => onDisconnectManagedPrinter(device)}
                          disabled={!device.connected}
                          className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-[11px] rounded-md disabled:opacity-45"
                          style={{ color: device.connected ? 'var(--text-strong)' : 'var(--text-muted)' }}
                        >
                          Disconnect
                        </button>
                        {!device.connected && (
                          <button
                            type="button"
                            onClick={() => onRemoveManagedPrinter(device)}
                            className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-[11px] rounded-md"
                            style={{ color: 'var(--danger)' }}
                            title="Remove saved printer"
                          >
                            Remove
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

          <div className="mt-3 border-t pt-2.5 flex items-center justify-between gap-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {activePrinterSummary}
            </div>
            {!showAddPrinterFlow ? (
              <button
                type="button"
                onClick={onEnterAddPrinterFlow}
                className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs inline-flex items-center gap-1 rounded-md"
                style={{ color: 'var(--accent-secondary)' }}
              >
                <Plus className="w-3.5 h-3.5" />
                Add Printer
              </button>
            ) : (
              managedPrinters.length > 0 && (
                <button
                  type="button"
                  onClick={onExitAddPrinterFlow}
                  className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-md"
                  style={{ color: 'var(--text-muted)' }}
                >
                  Done Adding
                </button>
              )
            )}
          </div>
        </div>
        )}

        {showAddPrinterFlow && (
          <>
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Discovery</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Scan local network for compatible printers.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onToggleDiscovery}
                  className="h-8 min-w-[112px] rounded-md border px-3 text-xs font-semibold uppercase tracking-wide transition-colors"
                  style={networkDiscoveryEnabled
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
                  {networkDiscoveryEnabled ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="mt-2.5 flex items-center justify-between gap-2">
                <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  Find printers and connect to save them in this profile fleet.
                </div>
                <button
                  type="button"
                  onClick={onRunDiscovery}
                  disabled={!networkDiscoveryEnabled || isNetworkScanning}
                  className="ui-button ui-button-secondary !h-8 !min-w-[112px] !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                  style={{ color: 'var(--text-strong)' }}
                >
                  <Search className={`w-3.5 h-3.5 ${isNetworkScanning ? 'animate-pulse' : ''}`} />
                  {isNetworkScanning ? 'Scanning…' : 'Scan'}
                </button>
              </div>

              <div className="mt-2 space-y-1">
                <div className="h-1.5 rounded-full border overflow-hidden" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-2), black 14%)' }}>
                  <div
                    className="h-full rounded-full transition-[width] duration-200 ease-out"
                    style={{
                      width: `${Math.max(0, Math.min(100, networkScanProgressPct))}%`,
                      background: 'linear-gradient(90deg, color-mix(in srgb, var(--accent), var(--accent-secondary) 22%), var(--accent-secondary))',
                    }}
                  />
                </div>
                <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  {isNetworkScanning
                    ? `${networkScanPhaseLabel || 'Scanning network…'} • ${Math.round(networkScanProgressPct)}%`
                    : networkScanPhaseLabel
                      ? `${networkScanPhaseLabel} • 100%`
                      : 'Idle'}
                </div>
              </div>
            </div>

            {networkDiscoveryEnabled && (
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Discovered Printers</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {discoveredPrinters.length} found
                  </div>
                </div>

                {discoveredPrinters.length === 0 ? (
                  <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    No discovered printers yet. Run Scan to search your local subnet.
                  </div>
                ) : (
                  <div className="mt-2 space-y-1.5 max-h-[180px] overflow-y-auto custom-scrollbar pr-1">
                    {discoveredPrinters.map((entry) => {
                      const savedEntry = managedPrinters.find((device) => device.ipAddress === entry.ipAddress) ?? null;
                      const isEntryConnected = savedEntry?.connected === true;
                      const isEntryActive = savedEntry?.id === activePrinterId;

                      return (
                        <div
                          key={entry.id}
                          className="rounded-md border px-2.5 py-2 flex items-center justify-between gap-2"
                          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
                        >
                          <div className="min-w-0">
                            <div className="text-xs font-semibold truncate" style={{ color: 'var(--text-strong)' }}>
                              {entry.name}
                              {isEntryActive ? ' • Active' : savedEntry ? ' • Saved' : ''}
                            </div>
                            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                              {entry.ipAddress} • {entry.status === 'online' ? 'Online' : 'Offline'}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => onConnectDiscovered(entry)}
                            disabled={isNetworkConnecting}
                            className="ui-button ui-button-secondary !h-8 !min-w-[120px] !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-60"
                            style={{ color: isEntryConnected ? 'var(--text-strong)' : 'var(--accent-secondary)' }}
                          >
                            {isNetworkConnecting
                              ? 'Connecting…'
                              : isEntryConnected
                                ? <><Check className="w-3.5 h-3.5" />Refresh</>
                                : savedEntry
                                  ? 'Connect & Select'
                                  : 'Connect & Save'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="mt-2 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
                  <button
                    type="button"
                    onClick={onToggleManualEntry}
                    className="text-[11px] underline decoration-dotted underline-offset-2 hover:opacity-80 transition-opacity"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {showManualNetworkEntry ? 'Hide manual IP entry' : 'Cannot find your machine?'}
                  </button>
                </div>
              </div>
            )}

            {showManualNetworkEntry && (
              <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 5%)' }}>
                <label className="space-y-1 block">
                  <span className="ui-label font-medium">Printer IP Address (manual)</span>
                  <input
                    type="text"
                    value={networkIpAddress}
                    onChange={(event) => onNetworkIpAddressChange(event.target.value)}
                    placeholder="e.g. 192.168.1.140"
                    className="ui-input w-full h-[34px] px-2.5 py-1.5 text-sm"
                  />
                </label>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    Save and select a printer by connecting manually.
                  </div>
                  <button
                    type="button"
                    onClick={onConnectManual}
                    disabled={isNetworkConnecting || !networkIpAddress.trim()}
                    className="ui-button ui-button-secondary !h-8 !min-w-[112px] !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md disabled:opacity-45"
                    style={{ color: 'var(--accent-secondary)' }}
                  >
                    {isNetworkConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />}
                    {isNetworkConnecting ? 'Connecting…' : 'Connect'}
                  </button>
                </div>
              </div>
            )}
          </>
        )}

      </div>

      <div className="px-4 pb-4 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="ui-button ui-button-secondary !h-8 !min-w-[112px] !px-3 !py-0 text-xs rounded-md"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onSave}
          className="ui-button ui-button-secondary !h-8 !min-w-[112px] !px-3 !py-0 text-xs inline-flex items-center justify-center gap-1 rounded-md"
          style={{
            color: 'var(--accent-secondary)',
            borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 42%)',
            background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 92%)',
          }}
        >
          <Check className="w-3.5 h-3.5" />
          Save
        </button>
      </div>
    </div>
  );
}

export default FleetManagement;
