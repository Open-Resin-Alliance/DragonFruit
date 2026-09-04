"use client";

import React from 'react';
import { useLingui } from '@lingui/react';
import { msg } from '@lingui/core/macro';
import { Loader2, Search, Settings2, Wifi } from 'lucide-react';

type SetupMode = 'auto' | 'manual';

type SetupModeButtonProps = {
  /** The current mode. The button's label shows the other mode to switch to. */
  mode: SetupMode;
  onSwitch: () => void;
};

/** Single footer button that conditionally shows "Auto" or "Manual". */
export function SetupModeButton({ mode, onSwitch }: SetupModeButtonProps) {
  const { _ } = useLingui();
  return (
    <button
      type="button"
      onClick={onSwitch}
      className="ui-button ui-button-secondary !h-8 !px-3 !py-0 text-xs rounded-full"
    >
      {mode === 'auto' ? _(msg`Manual`) : _(msg`Auto`)}
    </button>
  );
}

/**
 * Shared printer setup pieces used by both the Initial Setup dialog and the
 * Network Settings modal, so the "Auto Detect / Manual IP Entry" flows look
 * identical everywhere.
 */

type SetupMethodChooserProps = {
  onAutoDetect: () => void;
  onManualIp: () => void;
};

/** Two method cards: Auto Detect (scan) and Manual IP Entry. */
export function SetupMethodChooser({ onAutoDetect, onManualIp }: SetupMethodChooserProps) {
  const { _ } = useLingui();

  return (
    <div className="grid grid-cols-2 gap-2">
      <button
        type="button"
        onClick={onAutoDetect}
        className="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent),var(--border-subtle)_45%)]"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
          style={{ borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 55%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)', color: 'var(--accent)' }}
        >
          <Search className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            {_(msg`Auto Detect`)}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {_(msg`Find your printer on the network`)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onManualIp}
        className="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:border-[color-mix(in_srgb,var(--accent),var(--border-subtle)_45%)]"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <span
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border"
          style={{ borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 55%)', background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)', color: 'var(--accent)' }}
        >
          <Settings2 className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>
            {_(msg`Manual IP Entry`)}
          </span>
          <span className="mt-0.5 block truncate text-[11px] leading-snug" style={{ color: 'var(--text-muted)' }}>
            {_(msg`Enter your printer's IP address`)}
          </span>
        </span>
      </button>
    </div>
  );
}

type ManualIpEntryCardProps = {
  value: string;
  onChange: (value: string) => void;
  onConnect: () => void;
  isConnecting?: boolean;
  /** Action label, defaults to "Connect". */
  connectLabel?: string;
};

/** Card with an IP field and an inline connect button. */
export function ManualIpEntryCard({
  value,
  onChange,
  onConnect,
  isConnecting = false,
  connectLabel,
}: ManualIpEntryCardProps) {
  const { _ } = useLingui();
  const label = connectLabel ?? _(msg`Connect`);

  return (
    <div className="rounded-xl border p-3.5" style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}>
      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        {_(msg`Manual IP Entry`)}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="192.168.1.100"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          className="ui-input h-[34px] min-w-0 flex-1 px-2.5 py-1.5 font-mono text-sm tabular-nums"
          onKeyDown={(event) => {
            if (event.key === 'Enter') onConnect();
          }}
        />
        <button
          type="button"
          onClick={onConnect}
          disabled={isConnecting || !value.trim()}
          className="ui-button ui-button-secondary !h-[34px] !px-3 !py-0 shrink-0 text-xs inline-flex items-center gap-1 rounded-full disabled:opacity-45"
          style={{ color: 'var(--accent-secondary)' }}
        >
          {isConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wifi className="h-3.5 w-3.5" />}
          {isConnecting ? _(msg`Connecting…`) : label}
        </button>
      </div>
    </div>
  );
}
