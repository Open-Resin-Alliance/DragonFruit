/** Display formatters and lenient input parsers for the printing monitor. */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

// {hours}/{minutes} are the whole-number quantities (e.g. "2h 05m", "8m") —
// translators control abbreviation and spacing (e.g. "2 h 05 min") through their msgstr.
export function formatPrintingMonitorEstimatedTime(seconds: number | null, translate: (descriptor: MessageDescriptor) => string): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';

  const rounded = Math.max(1, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const paddedMinutes = minutes.toString().padStart(2, '0');

  if (hours > 0) {
    return translate(msg`${hours} h ${paddedMinutes} min`);
  }

  if (minutes > 0) {
    return translate(msg`${minutes} min`);
  }

  return translate(msg({ message: '< 1 min', comment: 'Shown when the estimated print time rounds down to under one minute. Keep the "<" comparison symbol.' }));
}

export function formatPrintingMonitorUsedMaterial(ml: number | null): string {
  if (ml == null || !Number.isFinite(ml) || ml <= 0) return '—';
  return `${ml.toFixed(2)} ml`;
}

export function formatPrintingMonitorAreaMm2(areaMm2: number | null): string {
  if (areaMm2 == null || !Number.isFinite(areaMm2) || areaMm2 <= 0) return '—';
  if (areaMm2 >= 1000) return `${areaMm2.toFixed(0)} mm²`;
  if (areaMm2 >= 100) return `${areaMm2.toFixed(1)} mm²`;
  return `${areaMm2.toFixed(2)} mm²`;
}

export function parsePrintingMonitorSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.round(numeric);
  }

  const hms = trimmed.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const s = Number(hms[3] ?? '0');
    if ([h, m, s].every((n) => Number.isFinite(n) && n >= 0)) {
      const total = (hms[3] == null)
        ? (h * 60 + m)
        : (h * 3600 + m * 60 + s);
      return total > 0 ? total : null;
    }
  }

  const units = trimmed.match(/(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i);
  if (units) {
    const h = Number(units[1] ?? 0);
    const m = Number(units[2] ?? 0);
    const s = Number(units[3] ?? 0);
    if ([h, m, s].every((n) => Number.isFinite(n) && n >= 0)) {
      const total = Math.round(h * 3600 + m * 60 + s);
      return total > 0 ? total : null;
    }
  }

  return null;
}

export function parsePrintingMonitorMaterialMl(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const extracted = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (!extracted) return null;
  const parsed = Number(extracted[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parsePrintingMonitorAreaMm2(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }

  const extracted = trimmed.match(/(\d+(?:\.\d+)?)/);
  if (!extracted) return null;
  const parsed = Number(extracted[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function normalizePrintingMonitorWebcamAspectRatio(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  // Keep practical camera bounds and reject pathological stream metadata.
  if (value < 0.45 || value > 2.4) return null;
  return value;
}

export function resolvePrintingMonitorAbsoluteUrl(candidate: string, host: string, port: number): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `http:${trimmed}`;
  const base = `http://${host}${port === 80 ? '' : `:${port}`}`;
  if (trimmed.startsWith('/')) return `${base}${trimmed}`;
  return `${base}/${trimmed.replace(/^\/+/, '')}`;
}
