import React from 'react';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { RefreshCw } from 'lucide-react';
import { IconButton, Spinner } from '@/components/atoms';
import type { PluginPrintHistoryEntryContract } from '@/features/plugins/complexPluginContracts';
import { pluginNetworkFetch } from '@/utils/pluginNetworkBridge';

type Props = {
  pluginId: string;
  operation: string;
  host: string;
  port: number;
  /** a change (e.g. a print ended) loads the history again */
  refreshKey?: string | number | null;
};

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parseEntries(payload: unknown): PluginPrintHistoryEntryContract[] {
  const list = (payload as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => (e && typeof e === 'object' ? (e as Record<string, unknown>) : null))
    .filter((e): e is Record<string, unknown> => e !== null)
    .map((e) => ({
      fileName: typeof e.fileName === 'string' ? e.fileName : '',
      startedAt: num(e.startedAt),
      durationSec: num(e.durationSec),
      result: typeof e.result === 'string' ? e.result : '',
      layersDone: num(e.layersDone),
      totalLayers: num(e.totalLayers),
    }));
}

function formatDuration(sec: number | null): string {
  if (sec == null) return '–';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : m > 0 ? `${m} min` : `${Math.round(sec)} s`;
}

function resultColor(result: string): string {
  if (result === 'done') return 'var(--success, #2e9d5b)';
  if (result === 'error' || result === 'lost') return 'var(--danger, #d9534f)';
  return 'var(--text-muted)';
}

/** A printer's print history, for monitoring adapters that declare the optional `history` operation. */
export function PrintHistoryPanel({ pluginId, operation, host, port, refreshKey }: Props) {
  const { _ } = useLingui();
  const [entries, setEntries] = React.useState<PluginPrintHistoryEntryContract[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const requestId = React.useRef(0);

  const load = React.useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const r = await pluginNetworkFetch({ pluginId, operation, ipAddress: host, host, port });
      const body = (await r.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
      if (id !== requestId.current) return;
      if (!r.ok || body?.ok === false) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`);
      setEntries(parseEntries(body));
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [pluginId, operation, host, port]);

  React.useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const resultLabel = (r: string) => {
    switch (r) {
      case 'done': return _(msg`Finished`);
      case 'stopped': return _(msg`Stopped`);
      case 'error': return _(msg`Failed`);
      case 'lost': return _(msg`Power loss`);
      default: return r || '–';
    }
  };

  return (
    <div className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), #000 4%)' }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}><Trans>Print history</Trans></span>
        <IconButton
          onClick={() => { void load(); }}
          disabled={loading}
          className="!p-1.5"
          title={_(msg`Refresh print history`)}
          aria-label={_(msg`Refresh print history`)}
        >
          {loading ? <Spinner size="sm" icon={RefreshCw} /> : <RefreshCw className="w-3.5 h-3.5" />}
        </IconButton>
      </div>
      <div className="mt-1.5 max-h-48 overflow-y-auto custom-scrollbar space-y-1 pr-1">
        {entries.length === 0 ? (
          <div className="px-1 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {loading ? _(msg`Loading print history…`) : error ?? _(msg`No prints yet`)}
          </div>
        ) : entries.map((e, i) => (
          <div
            key={`${e.startedAt ?? 'x'}-${e.fileName}-${i}`}
            className="grid grid-cols-[1fr_auto] gap-x-2 rounded-md border px-2 py-1 text-[11px]"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
          >
            <span className="truncate font-semibold" style={{ color: 'var(--text-strong)' }} title={e.fileName}>{e.fileName || '–'}</span>
            <span style={{ color: resultColor(e.result) }}>{resultLabel(e.result)}</span>
            <span style={{ color: 'var(--text-muted)' }}>
              {e.startedAt != null ? new Date(e.startedAt * 1000).toLocaleString() : _(msg`Time unknown`)}
              {' · '}
              {formatDuration(e.durationSec)}
            </span>
            <span style={{ color: 'var(--text-muted)' }}>
              {e.layersDone != null && e.totalLayers != null ? `${e.layersDone} / ${e.totalLayers}` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
