'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  ExternalLink,
  FolderOpen,
  Info,
  Loader2,
  Pause,
  Play,
  RefreshCcw,
  ScrollText,
  Trash2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

// ── Types ─────────────────────────────────────────────────────────────────────

export type LogLevelFilter = 'error' | 'warn' | 'info' | 'debug' | 'trace';

type ParsedLogLine = {
  raw: string;
  level: LogLevelFilter | 'unknown';
  timestamp: string;
  target: string;
  message: string;
};

// ── Storage keys ──────────────────────────────────────────────────────────────

const LOG_LEVEL_STORAGE_KEY = 'dragonfruit-logging:min-level';
const DEFAULT_LOG_LEVEL: LogLevelFilter = 'info';

// ── Helpers ───────────────────────────────────────────────────────────────────

const isTauri =
  typeof window !== 'undefined' &&
  '__TAURI_INTERNALS__' in window;

export function getSavedLogLevel(): LogLevelFilter {
  if (typeof window === 'undefined') return DEFAULT_LOG_LEVEL;
  const saved = window.localStorage.getItem(LOG_LEVEL_STORAGE_KEY);
  const valid: LogLevelFilter[] = ['error', 'warn', 'info', 'debug', 'trace'];
  return valid.includes(saved as LogLevelFilter) ? (saved as LogLevelFilter) : DEFAULT_LOG_LEVEL;
}

export function saveLogLevel(level: LogLevelFilter) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LOG_LEVEL_STORAGE_KEY, level);
  // Persist to disk so Rust reads the correct level on next startup.
  if (isTauri) {
    invoke('set_log_level_pref', { level }).catch(() => {});
  }
}

async function resolveLogDirPath(): Promise<string> {
  const { appLogDir, sep } = await import('@tauri-apps/api/path');
  const dir = await appLogDir();
  const separator = await sep();
  // Ensure we always have exactly one separator between dir and filename
  return dir.endsWith(separator) ? `${dir}dragonfruit.log` : `${dir}${separator}dragonfruit.log`;
}

async function revealLogFile(path: string): Promise<void> {
  await invoke('reveal_in_file_manager', { path });
}

async function openLogFile(): Promise<void> {
  await invoke('open_log_file');
}

async function deleteLogFile(): Promise<void> {
  await invoke('delete_log_file');
}

// ── Log line parser ───────────────────────────────────────────────────────────

const LEVEL_PATTERN = /\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i;

// tauri-plugin-log v2 default fern format: [YYYY-MM-DD][HH:MM:SS][LEVEL][target] message
const BRACKET_RE = /^\[(\d{4}-\d{2}-\d{2})\]\[(\d{2}:\d{2}:\d{2})\]\[(\w+)\]\[([^\]]*)\]\s*(.*)/;
// ISO-style: 2024-01-01T12:00:00.000Z LEVEL [target] message
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s+(\w+)\s+\[([^\]]*)\]\s*(.*)/;

function normalizeLevel(raw: string): LogLevelFilter | 'unknown' {
  const l = raw.toUpperCase();
  if (l === 'ERROR') return 'error';
  if (l === 'WARN' || l === 'WARNING') return 'warn';
  if (l === 'INFO') return 'info';
  if (l === 'DEBUG') return 'debug';
  if (l === 'TRACE') return 'trace';
  return 'unknown';
}

function parseLogLine(raw: string): ParsedLogLine {
  let m = BRACKET_RE.exec(raw);
  if (m) {
    return {
      raw,
      level: normalizeLevel(m[3]),
      timestamp: `${m[1]} ${m[2]}`,
      target: m[4],
      message: m[5],
    };
  }
  m = ISO_RE.exec(raw);
  if (m) {
    return { raw, level: normalizeLevel(m[2]), timestamp: m[1], target: m[3], message: m[4] };
  }
  // Fallback: scan for a level keyword anywhere in the line
  const lm = LEVEL_PATTERN.exec(raw);
  return { raw, level: lm ? normalizeLevel(lm[1]) : 'unknown', timestamp: '', target: '', message: raw };
}

// Rank: lower number = more severe. error=0 … trace=4, unknown=5
const LEVEL_RANK: Record<LogLevelFilter | 'unknown', number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
  unknown: 5,
};

// ── Level styling ─────────────────────────────────────────────────────────────

const LEVEL_META: Record<LogLevelFilter | 'unknown', { label: string; color: string; description: string }> = {
  error:   { label: 'Error',   color: '#f87171', description: 'Only critical failures' },
  warn:    { label: 'Warn',    color: '#fb923c', description: 'Warnings and errors' },
  info:    { label: 'Info',    color: '#4ade80', description: 'Normal operational messages (recommended)' },
  debug:   { label: 'Debug',   color: '#60a5fa', description: 'Verbose internal state' },
  trace:   { label: 'Trace',   color: '#a78bfa', description: 'Maximum verbosity — may impact performance' },
  unknown: { label: '?',       color: '#6b7280', description: '' },
};

const LEVEL_OPTIONS: LogLevelFilter[] = ['error', 'warn', 'info', 'debug', 'trace'];

// 2 s poll, cap at 2000 lines from file tail
const POLL_INTERVAL_MS = 2000;
const MAX_LINES = 2000;

// ── Noise filter ──────────────────────────────────────────────────────────────
// These are chatty low-level crates we never need to see even at Debug level.
const NOISE_TARGETS = new Set([
  'tungstenite::client',
  'tungstenite::handshake::client',
  'tungstenite::handshake::server',
  'reqwest::connect',
  'reqwest::async_impl::client',
  'hyper::client',
  'hyper_util::client',
  'rustls',
  'h2',
]);

function isNoiseLine(line: ParsedLogLine): boolean {
  if (!line.target) return false;
  return NOISE_TARGETS.has(line.target);
}

// ── Component ──────────────────────────────────────────────────────────────────

type LoggingSettingsTabProps = {
  logLevel: LogLevelFilter;
  onLogLevelChange: (level: LogLevelFilter) => void;
};

export function LoggingSettingsTab({ logLevel, onLogLevelChange }: LoggingSettingsTabProps) {
  const [logPath, setLogPath] = useState<string | null>(null);
  const [logPathError, setLogPathError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Live viewer
  const [lines, setLines] = useState<ParsedLogLine[]>([]);
  const [viewerFilter, setViewerFilter] = useState<LogLevelFilter>('trace');
  const [hideNoise, setHideNoise] = useState(true);
  const [isLive, setIsLive] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    if (!isTauri) {
      setLogPath('<only available in desktop build>');
      return;
    }
    resolveLogDirPath().then(setLogPath).catch((err) => setLogPathError(String(err)));
  }, []);

  // ── Polling ────────────────────────────────────────────────────────────────

  const fetchLines = useCallback(async () => {
    if (!isTauri) return;
    try {
      const raw: string = await invoke('read_log_tail', { lines: MAX_LINES });
      if (!raw) { setLines([]); return; }
      setLines(raw.split('\n').filter(Boolean).map(parseLogLine));
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
    }
  }, []);

  useEffect(() => {
    if (!isLive) return;
    fetchLines();
    const id = setInterval(fetchLines, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [isLive, fetchLines]);

  // ── Auto-scroll ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleCopy = useCallback(async () => {
    if (!logPath) return;
    try { await navigator.clipboard.writeText(logPath); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable */ }
  }, [logPath]);

  const handleReveal = useCallback(async () => {
    if (!logPath || !isTauri) return;
    setRevealing(true); setRevealError(null);
    try { await revealLogFile(logPath); }
    catch (err) { setRevealError(String(err)); }
    finally { setRevealing(false); }
  }, [logPath]);

  const handleOpen = useCallback(async () => {
    if (!isTauri) return;
    setOpening(true); setOpenError(null);
    try { await openLogFile(); }
    catch (err) { setOpenError(String(err)); }
    finally { setOpening(false); }
  }, []);

  const handleDelete = useCallback(async () => {
    if (!isTauri) return;
    setDeleting(true); setDeleteError(null);
    try {
      await deleteLogFile();
      setLines([]);
      // Re-resolve path display (file gone but path is still valid)
    }
    catch (err) { setDeleteError(String(err)); }
    finally { setDeleting(false); }
  }, []);

  const handleClearViewer = useCallback(() => setLines([]), []);

  // ── Filtered view ──────────────────────────────────────────────────────────

  const visibleLines = lines.filter(
    (l) => LEVEL_RANK[l.level] <= LEVEL_RANK[viewerFilter] && !(hideNoise && isNoiseLine(l)),
  );

  const { color: filterColor, label: filterLabel } = LEVEL_META[viewerFilter];

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-3.5">

      {/* Log file location */}
      <section
        className="rounded-xl border p-4"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <div className="flex items-center gap-2 mb-3">
          <ScrollText className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--accent)' }} />
          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Log File</h4>
        </div>

        <p className="text-[12px] mb-3" style={{ color: 'var(--text-muted)' }}>
          DragonFruit writes structured logs to a platform-specific directory.
          Share this file when reporting startup or network issues.
        </p>

        <div
          className="rounded-lg border flex items-stretch overflow-hidden"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
        >
          <div className="flex-1 px-3 py-2.5 min-w-0">
            {logPathError ? (
              <span className="text-[11px]" style={{ color: '#f87171' }}>{logPathError}</span>
            ) : logPath === null ? (
              <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <Loader2 className="h-3 w-3 animate-spin" />Resolving path…
              </span>
            ) : (
              <span className="block text-[11px] font-mono truncate select-all" style={{ color: 'var(--text-strong)' }} title={logPath}>
                {logPath}
              </span>
            )}
          </div>

          <div className="flex border-l" style={{ borderColor: 'var(--border-subtle)' }}>
            <button type="button" onClick={handleCopy} disabled={!logPath} title="Copy path"
              className="inline-flex items-center justify-center px-3 transition-colors duration-150"
              style={{ color: copied ? 'var(--accent)' : 'var(--text-muted)' }}>
              {copied ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
            </button>
            {isTauri && (
              <>
                <button type="button" onClick={handleOpen} disabled={!logPath || opening} title="Open in text editor"
                  className="inline-flex items-center justify-center px-3 border-l transition-colors duration-150"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                  {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ExternalLink className="h-3.5 w-3.5" />}
                </button>
                <button type="button" onClick={handleReveal} disabled={!logPath || revealing} title="Reveal in file manager"
                  className="inline-flex items-center justify-center px-3 border-l transition-colors duration-150"
                  style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                  {revealing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                </button>
                <button type="button" onClick={handleDelete} disabled={deleting} title="Delete log file"
                  className="inline-flex items-center justify-center px-3 border-l transition-colors duration-150"
                  style={{ borderColor: 'var(--border-subtle)', color: deleting ? 'var(--text-muted)' : '#f87171' }}>
                  {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </>
            )}
          </div>
        </div>

        {revealError && (
          <p className="mt-2 text-[11px]" style={{ color: '#f87171' }}>{revealError}</p>
        )}
        {openError && (
          <p className="mt-2 text-[11px]" style={{ color: '#f87171' }}>{openError}</p>
        )}
        {deleteError && (
          <p className="mt-2 text-[11px]" style={{ color: '#f87171' }}>{deleteError}</p>
        )}
      </section>

      {/* Log level */}
      <section
        className="rounded-xl border p-4"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        <div className="flex items-center gap-2 mb-1">
          <RefreshCcw className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--accent)' }} />
          <h4 className="text-sm font-semibold" style={{ color: 'var(--text-strong)' }}>Minimum Log Level</h4>
        </div>
        <p className="text-[12px] mb-3" style={{ color: 'var(--text-muted)' }}>
          Controls the least-significant event written to the log file. Changes apply immediately and persist across restarts.
        </p>

        <div className="flex flex-col gap-1.5">
          {LEVEL_OPTIONS.map((value) => {
            const { label, description, color } = LEVEL_META[value];
            const active = logLevel === value;
            return (
              <button key={value} type="button" onClick={() => onLogLevelChange(value)}
                className="flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all duration-150"
                style={active
                  ? {
                    borderColor: `color-mix(in srgb, ${color}, var(--border-subtle) 40%)`,
                    background: `color-mix(in srgb, ${color}, var(--surface-0) 90%)`,
                    boxShadow: `0 0 0 1px color-mix(in srgb, ${color}, transparent 78%) inset`,
                  }
                  : { borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
              >
                <span className="inline-flex h-2 w-2 rounded-full flex-shrink-0"
                  style={{ background: color, boxShadow: active ? `0 0 6px ${color}` : 'none' }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-semibold" style={{ color: 'var(--text-strong)' }}>{label}</span>
                  <span className="block text-[11px]" style={{ color: 'var(--text-muted)' }}>{description}</span>
                </span>
                {active && <Check className="h-3.5 w-3.5 flex-shrink-0" style={{ color }} />}
              </button>
            );
          })}
        </div>
      </section>

      {/* Live log viewer */}
      <section
        className="rounded-xl border overflow-hidden"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      >
        {/* Toolbar */}
        <div
          className="flex items-center gap-2 px-3 py-2 border-b"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
        >
          {/* Live indicator */}
          <span className="flex items-center gap-1.5 flex-1 min-w-0">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full flex-shrink-0"
              style={{
                background: isLive ? '#4ade80' : '#6b7280',
                boxShadow: isLive ? '0 0 5px #4ade80' : 'none',
              }}
            />
            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-strong)' }}>Live Log</span>
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
              {visibleLines.length} line{visibleLines.length !== 1 ? 's' : ''}
              {lines.length !== visibleLines.length && ` (${lines.length - visibleLines.length} filtered)`}
            </span>
          </span>

          {/* Noise filter toggle */}
          <button
            type="button"
            onClick={() => setHideNoise((v) => !v)}
            title={hideNoise ? 'Show low-level transport noise (tungstenite, reqwest…)' : 'Hide transport noise'}
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors duration-150"
            style={{
              borderColor: 'var(--border-subtle)',
              color: hideNoise ? 'var(--text-muted)' : '#fb923c',
              background: hideNoise ? 'transparent' : 'color-mix(in srgb, #fb923c, var(--surface-0) 88%)',
            }}
          >
            {hideNoise ? 'noise hidden' : 'noise shown'}
          </button>

          {/* Filter dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setFilterOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors duration-150"
              style={{
                borderColor: `color-mix(in srgb, ${filterColor}, var(--border-subtle) 50%)`,
                background: `color-mix(in srgb, ${filterColor}, var(--surface-0) 88%)`,
                color: 'var(--text-strong)',
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: filterColor }} />
              {filterLabel}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
            {filterOpen && (
              <div
                className="absolute right-0 top-full mt-1 z-20 rounded-lg border shadow-lg overflow-hidden min-w-[100px]"
                style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-2)' }}
              >
                {LEVEL_OPTIONS.map((v) => {
                  const { label, color } = LEVEL_META[v];
                  const active = viewerFilter === v;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => { setViewerFilter(v); setFilterOpen(false); }}
                      className="flex items-center gap-2 w-full px-3 py-1.5 text-[11px] text-left transition-colors duration-100"
                      style={{
                        color: 'var(--text-strong)',
                        background: active ? `color-mix(in srgb, ${color}, var(--surface-0) 85%)` : 'transparent',
                      }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
                      {label}
                      {active && <Check className="ml-auto h-3 w-3" style={{ color }} />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Live toggle */}
          <button
            type="button"
            onClick={() => setIsLive((l) => !l)}
            title={isLive ? 'Pause polling' : 'Resume polling'}
            className="inline-flex items-center justify-center rounded-md border px-2 py-1 transition-colors duration-150"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
          >
            {isLive ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          </button>

          {/* Manual refresh */}
          {!isLive && (
            <button
              type="button"
              onClick={fetchLines}
              title="Refresh now"
              className="inline-flex items-center justify-center rounded-md border px-2 py-1 transition-colors duration-150"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
            >
              <RefreshCcw className="h-3 w-3" />
            </button>
          )}

          {/* Clear */}
          <button
            type="button"
            onClick={handleClearViewer}
            title="Clear viewer"
            className="inline-flex items-center justify-center rounded-md border px-2 py-1 transition-colors duration-150"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>

        {/* Log output */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="overflow-y-auto font-mono text-[11px] leading-relaxed"
          style={{
            height: 320,
            background: 'var(--surface-0, #0e0e0e)',
            padding: '8px 12px',
          }}
        >
          {loadError ? (
            <span style={{ color: '#f87171' }}>{loadError}</span>
          ) : !isTauri ? (
            <span style={{ color: '#6b7280' }}>Log viewer only available in the desktop build.</span>
          ) : visibleLines.length === 0 ? (
            <span style={{ color: '#4b5563' }}>
              {lines.length === 0 ? 'No log entries yet.' : 'All lines filtered out.'}
            </span>
          ) : (
            visibleLines.map((line, i) => (
              <LogLineRow key={i} line={line} />
            ))
          )}
        </div>
      </section>

      {/* Info callout */}
      <div
        className="rounded-lg border px-3 py-2.5 flex items-start gap-2.5"
        style={{
          borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 60%)',
          background: 'color-mix(in srgb, var(--accent), var(--surface-0) 94%)',
        }}
      >
        <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--accent)' }} />
        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The minimum log level applies <strong style={{ color: 'var(--text-strong)' }}>immediately</strong> and is
          also saved for next launch. The viewer filter and noise suppression are local-only — they do not affect what is written to disk.
        </p>
      </div>
    </div>
  );
}

// ── LogLineRow ─────────────────────────────────────────────────────────────────

function LogLineRow({ line }: { line: ParsedLogLine }) {
  const { color } = LEVEL_META[line.level];
  const levelLabel = line.level === 'unknown' ? '?' : line.level.toUpperCase().padEnd(5);

  return (
    <div className="flex gap-2 min-w-0 hover:bg-white/[0.03] rounded px-0.5 -mx-0.5">
      <span
        className="flex-shrink-0 text-[10px] font-bold tracking-wide pt-px"
        style={{ color, minWidth: 38, userSelect: 'none' }}
      >
        {levelLabel}
      </span>
      {line.timestamp && (
        <span className="flex-shrink-0 text-[10px] pt-px" style={{ color: '#4b5563', userSelect: 'none' }}>
          {line.timestamp}
        </span>
      )}
      {line.target && (
        <span className="flex-shrink-0 text-[10px] pt-px truncate max-w-[140px]" style={{ color: '#6b7280' }}>
          {line.target}
        </span>
      )}
      <span className="flex-1 min-w-0 break-all" style={{ color: line.level === 'error' ? '#fca5a5' : line.level === 'warn' ? '#fdba74' : '#d1d5db' }}>
        {line.message || line.raw}
      </span>
    </div>
  );
}
