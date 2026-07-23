#!/usr/bin/env node
// visualize-stats.mjs — turn a slicing-benchmark JSONL into a single
// self-contained HTML dashboard, styled like the app's in-UI "Slice Performance
// Metrics (V3)" modal (src/features/slicing/components/SliceMetricsDebugModal.tsx
// — used only as a visual reference).
//
// It surfaces *everything the benchmark records*, not just the SliceStatsV3 perf
// fields: the imposed hardware envelope (cpus/mem), CPU + RAM resources, the
// periodic RSS/CPU time-series, every un-averaged repeat under runs[], the
// correctness gate + validation, and output size.
//
// Usage:
//   scripts/bench/visualize-stats.mjs [options] <results.jsonl>...
//
//   --out <file.html>   output page (default: bench-report.html)
//   --title <text>      page title / header
//   --open              open the page in the default browser when done
//
// Dependencies: node built-ins only.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, basename } from 'node:path';

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { inputs: [], out: 'bench-report.html', title: 'Slicing benchmark', open: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--out': opts.out = argv[++i]; break;
      case '--title': opts.title = argv[++i]; break;
      case '--open': opts.open = true; break;
      case '-h': case '--help': printHelp(); process.exit(0); break;
      default:
        if (a.startsWith('--')) { console.error(`unknown option: ${a}`); process.exit(2); }
        opts.inputs.push(a);
    }
  }
  if (opts.inputs.length === 0) { printHelp(); process.exit(2); }
  return opts;
}

function printHelp() {
  for (const line of readFileSync(new URL(import.meta.url)).toString().split('\n')) {
    if (line.startsWith('#!')) continue;
    if (!line.startsWith('//')) break;
    console.log(line.replace(/^\/\/ ?/, ''));
  }
}

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------
function loadRows(paths) {
  const rows = [];
  for (const p of paths) {
    const r = resolve(p);
    if (!existsSync(r)) { console.error(`WARN: not found: ${p}`); continue; }
    for (const line of readFileSync(r, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { console.error(`WARN: skipping unparseable line in ${p}`); }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function normalize(row) {
  const res = row.resources || {};
  const rssMb = num(row.peak_rss_mb) ?? (num(res.peak_rss_bytes) != null ? res.peak_rss_bytes / 1048576 : null);
  const endRssMb = num(row.end_rss_mb) ?? (num(res.end_rss_bytes) != null ? res.end_rss_bytes / 1048576 : null);

  const runs = Array.isArray(row.runs) && row.runs.length
    ? row.runs.map((r) => ({
        run: r.run, total_s: num(r.total_s), wall_s: num(r.wall_s),
        layers_per_second: num(r.layers_per_second),
        cpu_percent: num(r.cpu_percent), peak_cpu_percent: num(r.peak_sample_cpu_percent),
        peak_rss_mb: num(r.peak_rss_mb), end_rss_mb: num(r.end_rss_mb),
        samples: Array.isArray(r.samples) ? r.samples : [],
      }))
    : [];
  const samples = runs.find((r) => r.samples && r.samples.length)?.samples
    || (Array.isArray(row.samples) ? row.samples : []);

  return {
    error: row.error || null,
    voxl: row.voxl ?? '?', printer: row.printer ?? '?', format: row.format || null,
    layer_height: num(row.layer_height), aa_preset: row.aa_preset ?? '?',
    ref: row.ref || null, git_sha: row.git_sha || null,
    hw: row.hw || null, hw_cpus: row.hw_cpus ?? null, hw_mem: row.hw_mem ?? null,
    layers: num(row.layers), layer_count: num(row.layer_count), numeric_layer_count: num(row.numeric_layer_count),
    total_s: num(row.total_s), wall_s: num(row.wall_s),
    total_s_min: num(row.total_s_min), total_s_max: num(row.total_s_max),
    layers_per_second: num(row.layers_per_second),
    cpu_total_s: num(row.cpu_total_s) ?? num(res.cpu_total_s),
    cpu_percent: num(row.cpu_percent) ?? num(res.cpu_percent),
    peak_cpu_percent: num(row.peak_sample_cpu_percent) ?? num(res.peak_sample_cpu_percent),
    peak_rss_mb: rssMb, end_rss_mb: endRssMb,
    samples, runs,
    perf: row.perf || null,
    anti_aliasing: row.anti_aliasing || null, dither: row.dither || null,
    x_packing_mode: row.x_packing_mode || null, triangles: num(row.triangles),
    file_bytes: num(row.file_bytes),
    ok: typeof row.ok === 'boolean' ? row.ok : null, gate: row.gate || null,
    validation: row.validation || null, repeats: num(row.repeats),
  };
}

// ---------------------------------------------------------------------------
// formatting (mirrors the modal's helpers)
// ---------------------------------------------------------------------------
const DASH = '—';
const fmtMs = (ms, d = 2) => ms == null || !Number.isFinite(ms) ? DASH : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(d)} ms`;
const nsToMs = (ns) => ns == null || !Number.isFinite(ns) ? null : ns / 1e6;
const fmtNs = (ns) => ns == null || !Number.isFinite(ns) ? DASH : `${Math.round(ns).toLocaleString()} ns`;
const fmtRate = (v) => v == null || !Number.isFinite(v) ? DASH : v >= 100 ? `${Math.round(v).toLocaleString()} L/s` : `${v.toFixed(2)} L/s`;
const fmtPct = (v) => v == null || !Number.isFinite(v) ? DASH : `${v.toFixed(1)}%`;
const fmtInt = (v) => v == null || !Number.isFinite(v) ? DASH : Math.round(v).toLocaleString();
const fmtMb = (v) => v == null || !Number.isFinite(v) ? DASH : `${v.toFixed(1)} MB`;
const fmtSec = (v) => v == null || !Number.isFinite(v) ? DASH : `${v.toFixed(2)} s`;
const fmtBytes = (v) => {
  if (v == null || !Number.isFinite(v)) return DASH;
  if (v < 1024) return `${Math.round(v)} B`;
  if (v < 1048576) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1048576).toFixed(2)} MB`;
};
const ratioPct = (a, b) => (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || b <= 0) ? null : (a / b) * 100;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function parseMemMb(mem) {
  if (!mem) return null;
  const m = String(mem).match(/^([\d.]+)\s*([kmg]?)i?b?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  return u === 'g' ? n * 1024 : u === 'k' ? n / 1024 : u === 'm' || u === '' ? n : n;
}

// ---------------------------------------------------------------------------
// html fragments
// ---------------------------------------------------------------------------
const stat = (k, v) => `<div class="stat"><span class="stat-k">${esc(k)}</span><span class="stat-v">${esc(v)}</span></div>`;
const metric = (k, v, compact = false) => `<div class="metric${compact ? ' compact' : ''}"><div class="metric-k">${esc(k)}</div><div class="metric-v">${esc(v)}</div></div>`;

const PIE_COLORS = { 'Index build': '#60a5fa', 'Render pipeline': '#f472b6', 'Archive encode': '#f59e0b', 'Other / overhead': '#94a3b8' };
function pipelinePie(perf) {
  const total = nsToMs(perf?.total_ns);
  const slices = [
    { name: 'Index build', ms: nsToMs(perf?.index_build_ns) },
    { name: 'Render pipeline', ms: nsToMs(perf?.render_wall_ns) },
    { name: 'Archive encode', ms: nsToMs(perf?.archive_encode_ns) },
  ];
  const known = slices.reduce((a, s) => a + (s.ms || 0), 0);
  slices.push({ name: 'Other / overhead', ms: total != null ? Math.max(0, total - known) : null });
  const has = total != null && total > 0;
  for (const s of slices) s.pct = has ? Math.max(0, ratioPct(s.ms, total) ?? 0) : 0;
  let cur = 0; const stops = [];
  for (const s of slices) {
    const end = Math.min(100, cur + s.pct);
    if (end > cur) stops.push(`${PIE_COLORS[s.name]} ${cur.toFixed(2)}% ${end.toFixed(2)}%`);
    cur = end;
  }
  const bg = stops.length ? `conic-gradient(${stops.join(', ')})` : 'conic-gradient(var(--surface-2) 0% 100%)';
  const legend = slices.map((s) => `<div class="stat"><span class="stat-k"><i class="dot" style="background:${PIE_COLORS[s.name]}"></i>${esc(s.name)}</span><span class="stat-v">${fmtMs(s.ms, 2)} • ${fmtPct(s.pct)}</span></div>`).join('')
    + stat('Native total', `${fmtMs(total, 2)} • ${has ? '100.0%' : DASH}`);
  return `<div class="pie-wrap"><div class="pie" style="background:${bg}"><div class="pie-hole">${has ? 'Timing' : DASH}</div></div><div class="pie-legend">${legend}</div></div>`;
}

// SVG dual-axis time-series: RSS (MB) + CPU (%) vs t_ms, with an optional mem-cap line.
function resourceChart(s) {
  const pts = (s.samples || []).filter((p) => num(p.t_ms) != null).map((p) => ({
    t: p.t_ms, rss: num(p.rss_mb) ?? (num(p.rss_bytes) != null ? p.rss_bytes / 1048576 : null), cpu: num(p.cpu_percent),
  }));
  if (pts.length < 2) return '';
  const W = 560, H = 150, PL = 6, PR = 6, PT = 10, PB = 18;
  const tMax = Math.max(...pts.map((p) => p.t)) || 1;
  const capMb = parseMemMb(s.hw_mem);
  const rssVals = pts.map((p) => p.rss).filter((v) => v != null);
  let rssMax = Math.max(s.peak_rss_mb ?? 0, ...rssVals, 1);
  if (capMb) rssMax = Math.max(rssMax, capMb);
  const cpuMax = Math.max(s.peak_cpu_percent ?? 0, ...pts.map((p) => p.cpu ?? 0), 100);
  const x = (t) => PL + (t / tMax) * (W - PL - PR);
  const yR = (v) => H - PB - (v / rssMax) * (H - PT - PB);
  const yC = (v) => H - PB - (v / cpuMax) * (H - PT - PB);
  const line = (sel, y) => pts.filter((p) => sel(p) != null).map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(sel(p)).toFixed(1)}`).join(' ');
  const rssPath = line((p) => p.rss, yR);
  const rssArea = `${rssPath} L${x(pts[pts.length - 1].t).toFixed(1)},${(H - PB).toFixed(1)} L${x(pts[0].t).toFixed(1)},${(H - PB).toFixed(1)} Z`;
  const cpuPath = line((p) => p.cpu, yC);
  const capLine = capMb ? `<line x1="${PL}" y1="${yR(capMb).toFixed(1)}" x2="${W - PR}" y2="${yR(capMb).toFixed(1)}" stroke="#ef4444" stroke-width="1" stroke-dasharray="4 3" opacity="0.8"/><text x="${W - PR}" y="${(yR(capMb) - 3).toFixed(1)}" text-anchor="end" fill="#ef4444" font-size="9">mem cap ${esc(s.hw_mem)}</text>` : '';
  return `<div class="subpanel"><div class="subhead">Resource usage over time
      <span class="legend-inline"><i class="ls rss"></i>RSS &nbsp;<i class="ls cpu"></i>CPU%</span></div>
    <svg viewBox="0 0 ${W} ${H}" class="chart" preserveAspectRatio="none">
      <path d="${rssArea}" fill="var(--accent)" opacity="0.14"/>
      <path d="${rssPath}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>
      <path d="${cpuPath}" fill="none" stroke="#f59e0b" stroke-width="1.4" stroke-dasharray="3 2" opacity="0.9"/>
      ${capLine}
      <text x="${PL}" y="${H - 5}" fill="var(--text-muted)" font-size="9">0</text>
      <text x="${W - PR}" y="${H - 5}" text-anchor="end" fill="var(--text-muted)" font-size="9">${Math.round(tMax / 1000)}s</text>
    </svg>
    <div class="chart-scale"><span>peak RSS ${fmtMb(s.peak_rss_mb)}</span><span>peak CPU ${fmtPct(s.peak_cpu_percent)}</span><span>${pts.length} samples</span></div>
  </div>`;
}

function repeatsTable(s) {
  if (!s.runs || s.runs.length < 1) return '';
  const rows = s.runs.map((r) => `<tr>
    <td>${r.run ?? DASH}</td><td>${fmtSec(r.total_s)}</td><td>${fmtRate(r.layers_per_second)}</td>
    <td>${fmtMb(r.peak_rss_mb)}</td><td>${fmtPct(r.peak_cpu_percent)}</td><td>${fmtPct(r.cpu_percent)}</td></tr>`).join('');
  const spread = (s.total_s_min != null && s.total_s_max != null)
    ? `<span class="spread">spread ${fmtSec(s.total_s_min)}–${fmtSec(s.total_s_max)}</span>` : '';
  return `<div class="subpanel"><div class="subhead">Per-repeat runs <span class="dim">(${s.runs.length}×, kept separate)</span> ${spread}</div>
    <table class="mini"><thead><tr><th>run</th><th>total</th><th>throughput</th><th>peak RSS</th><th>peak CPU</th><th>avg CPU</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function correctnessPanel(s) {
  const vs = s.validation;
  return `<div class="subpanel"><div class="subhead">Correctness &amp; output</div>
    ${stat('Result', s.ok == null ? DASH : s.ok ? 'ok' : 'FAIL')}
    ${stat('Gate', s.gate ?? DASH)}
    ${stat('Reported layers', fmtInt(s.layers))}
    ${stat('Layer count (meta)', fmtInt(s.layer_count))}
    ${stat('Numeric layer count', fmtInt(s.numeric_layer_count))}
    ${stat('Output size', fmtBytes(s.file_bytes))}
    ${vs ? stat('Validation', `${vs.status}${vs.method ? ` (${vs.method})` : ''}`) : ''}
    ${vs && vs.mismatched_layers != null ? stat('Mismatched layers', fmtInt(vs.mismatched_layers)) : ''}
  </div>`;
}

function statsPanel(s) {
  const perf = s.perf || {};
  const renderWallPct = ratioPct(nsToMs(perf.render_wall_ns), nsToMs(perf.total_ns));
  const pl = s.layers && s.layers > 0
    ? { rw: nsToMs(perf.render_wall_ns) / s.layers, png: nsToMs(perf.png_encode_ns) / s.layers, tot: nsToMs(perf.total_ns) / s.layers }
    : {};

  const head = [
    metric('Total time', fmtMs(s.total_s != null ? s.total_s * 1000 : null)),
    metric('Throughput', fmtRate(s.layers_per_second)),
    metric('Layers', fmtInt(s.layers)),
    metric('Peak RSS', fmtMb(s.peak_rss_mb)),
  ].join('');
  const head2 = [
    metric('Peak CPU', fmtPct(s.peak_cpu_percent), true),
    metric('CPU time', fmtSec(s.cpu_total_s), true),
    metric('Avg CPU', fmtPct(s.cpu_percent), true),
    metric('Output', fmtBytes(s.file_bytes), true),
  ].join('');

  const perLayer = `<div class="subpanel"><div class="subhead">Per-layer KPIs</div>
    ${stat('Render wall / layer', fmtMs(pl.rw, 3))}
    ${stat('PNG encode / layer (CPU)', fmtMs(pl.png, 3))}
    ${stat('Native total / layer', fmtMs(pl.tot, 3))}
    ${stat('Render wall share', fmtPct(renderWallPct))}
  </div>`;

  const config = `<div class="subpanel"><div class="subhead">Render configuration</div>
    ${stat('Format', s.format ?? DASH)}
    ${stat('Layer height', s.layer_height != null ? `${s.layer_height} mm` : DASH)}
    ${stat('AA preset', s.aa_preset ?? DASH)}
    ${stat('AA level', s.anti_aliasing?.level ?? DASH)}
    ${stat('AA mode', s.anti_aliasing?.mode ?? DASH)}
    ${stat('Z-blend look-back', s.anti_aliasing?.z_blend_look_back ?? DASH)}
    ${stat('Dither', s.dither ? (s.dither.enabled ? `on (${s.dither.bit_depth}-bit, γ${s.dither.device_gamma})` : 'off') : DASH)}
    ${stat('X packing', s.x_packing_mode ?? DASH)}
    ${stat('Triangles', fmtInt(s.triangles))}
  </div>`;

  const counters = `<div class="subpanel"><div class="subhead">Raw perf counters</div><div class="counters">
    ${stat('total_ns', fmtNs(perf.total_ns))}
    ${stat('index_build_ns', fmtNs(perf.index_build_ns))}
    ${stat('render_wall_ns', fmtNs(perf.render_wall_ns))}
    ${stat('render_ns', fmtNs(perf.render_ns))}
    ${stat('png_encode_ns', fmtNs(perf.png_encode_ns))}
    ${stat('archive_encode_ns', fmtNs(perf.archive_encode_ns))}
    ${stat('z_blend_backward_ns', fmtNs(perf.z_blend_backward_ns))}
    ${stat('z_blend_forward_ns', fmtNs(perf.z_blend_forward_ns))}
    ${stat('cross_blend_ns', fmtNs(perf.cross_blend_ns))}
    ${stat('cross_blend_touched_px', fmtInt(perf.cross_blend_touched_pixels))}
    ${stat('post_blur_ns', fmtNs(perf.post_blur_ns))}
    ${stat('support_merge_ns', fmtNs(perf.support_merge_ns))}
    ${stat('daa_post_threads', perf.daa_post_threads ?? DASH)}
    ${stat('daa_post_buffer_depth', perf.daa_post_buffer_depth ?? DASH)}
  </div></div>`;

  return `<div class="panel">
    <div class="metrics-grid">${head}</div>
    <div class="metrics-grid">${head2}</div>
    ${resourceChart(s)}
    <div class="panel-title">Pipeline timing</div>
    ${pipelinePie(perf)}
    <div class="two-col">${perLayer}${config}</div>
    <div class="two-col">${repeatsTable(s)}${correctnessPanel(s)}</div>
    ${counters}
  </div>`;
}

function hwBadge(s) {
  if (s.hw == null && s.hw_cpus == null && s.hw_mem == null) return '';
  const spec = [s.hw_cpus != null ? `${s.hw_cpus}c` : null, s.hw_mem ? esc(s.hw_mem) : null].filter(Boolean).join('/');
  return `<span class="badge hw">${[s.hw ? esc(s.hw) : null, spec || null].filter(Boolean).join(' · ')}</span>`;
}
function okBadge(s) {
  if (s.ok == null) return '';
  return s.ok ? `<span class="badge ok">ok</span>` : `<span class="badge bad">fail${s.validation?.status && s.validation.status !== 'match' ? ` · ${esc(s.validation.status)}` : ''}</span>`;
}
function refBadge(s) { return s.ref && s.ref !== 'working-tree' ? `<span class="badge ref">${esc(s.ref)}</span>` : ''; }

function caseTitle(s) {
  return [s.voxl, s.printer, s.layer_height != null ? `lh${s.layer_height}` : null, s.aa_preset].filter(Boolean).join(' · ');
}

function card(id, s) {
  if (s.error) {
    return `<section class="card" id="c${id}"><div class="card-head"><div class="card-title">${esc(caseTitle(s))}</div>
      <div class="badges">${refBadge(s)}${hwBadge(s)}<span class="badge bad">error</span></div></div>
      <div class="card-body error-body">${esc(s.error)}</div></section>`;
  }
  return `<section class="card" id="c${id}"><div class="card-head">
      <div class="card-title">${esc(caseTitle(s))}</div>
      <div class="badges">${refBadge(s)}${hwBadge(s)}${okBadge(s)}</div>
    </div><div class="card-body">${statsPanel(s)}</div></section>`;
}

// overview table --------------------------------------------------------------
function overviewTable(list) {
  const cols = [
    ['#', null], ['case', 't'], ['ref', 't'], ['hw', 't'], ['fmt', 't'],
    ['layers', 'n'], ['total s', 'n'], ['L/s', 'n'], ['peak RSS', 'n'], ['peak CPU', 'n'], ['CPU s', 'n'], ['out', 'n'], ['ok', 't'],
  ];
  const head = cols.map((c, i) => `<th data-col="${i}"${c[1] ? ` class="sortable" data-type="${c[1]}"` : ''}>${esc(c[0])}${c[1] ? '<span class="arrow"></span>' : ''}</th>`).join('');
  const body = list.map(({ s, id }, i) => {
    const cells = [
      [i + 1, i + 1],
      [`<a href="#c${id}">${esc(caseTitle(s))}</a>`, caseTitle(s)],
      [s.ref ? esc(s.ref) : DASH, s.ref || ''],
      [hwLabel(s), hwLabel(s)],
      [s.format ? esc(s.format) : DASH, s.format || ''],
      [fmtInt(s.layers), s.layers ?? -1],
      [fmtSec(s.total_s), s.total_s ?? -1],
      [fmtRate(s.layers_per_second), s.layers_per_second ?? -1],
      [fmtMb(s.peak_rss_mb), s.peak_rss_mb ?? -1],
      [fmtPct(s.peak_cpu_percent), s.peak_cpu_percent ?? -1],
      [fmtSec(s.cpu_total_s), s.cpu_total_s ?? -1],
      [fmtBytes(s.file_bytes), s.file_bytes ?? -1],
      [s.error ? '<span class="pill bad">err</span>' : s.ok == null ? DASH : s.ok ? '<span class="pill ok">ok</span>' : '<span class="pill bad">fail</span>', s.ok ? 1 : 0],
    ];
    return `<tr>${cells.map((c, ci) => `<td data-sort="${esc(String(c[1]))}"${cols[ci][1] === 'n' ? ' class="numcol"' : ''}>${c[0]}</td>`).join('')}</tr>`;
  }).join('');
  return `<table id="ov"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
const hwLabel = (s) => s.hw ? s.hw : (s.hw_cpus != null || s.hw_mem != null ? [s.hw_cpus != null ? `${s.hw_cpus}c` : '', s.hw_mem || ''].filter(Boolean).join('/') : 'host');

// ---------------------------------------------------------------------------
// page
// ---------------------------------------------------------------------------
const CSS = `
:root{--surface-0:#0e1420;--surface-1:#161d2b;--surface-2:#212b3d;--border-subtle:#2a3549;
  --text-strong:#e7eef7;--text-muted:#8b97a8;--accent:#5b9dd9;}
*{box-sizing:border-box}
body{margin:0;background:var(--surface-0);color:var(--text-strong);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-2);padding:1px 5px;border-radius:4px;font-size:.85em}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.page-head{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:14px;padding:14px 22px;
  background:var(--surface-0);border-bottom:1px solid var(--border-subtle)}
.page-head .icon{width:40px;height:40px;border-radius:10px;border:1px solid var(--border-subtle);display:flex;
  align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent),var(--surface-1) 86%);font-size:20px}
.page-head h1{margin:0;font-size:18px;font-weight:650}
.page-head .sub{margin:0;font-size:12px;color:var(--text-muted)}
.wrap{padding:18px 22px;display:flex;flex-direction:column;gap:18px;max-width:1500px;margin:0 auto}
.section-title{font-size:13px;font-weight:650;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin:4px 0 -6px}
/* overview table */
.ov-wrap{border:1px solid var(--border-subtle);border-radius:12px;overflow:auto;background:var(--surface-1)}
table#ov{border-collapse:collapse;width:100%;font-size:12.5px;white-space:nowrap}
table#ov th,table#ov td{padding:7px 12px;text-align:left;border-bottom:1px solid var(--border-subtle)}
table#ov th{position:sticky;top:0;background:var(--surface-2);color:var(--text-muted);font-weight:600;font-size:11px;
  text-transform:uppercase;letter-spacing:.03em;z-index:1}
table#ov th.sortable{cursor:pointer;user-select:none}
table#ov th.sortable:hover{color:var(--text-strong)}
table#ov .arrow{display:inline-block;width:9px;margin-left:3px;opacity:.5}
table#ov th.asc .arrow::after{content:"▲"}table#ov th.desc .arrow::after{content:"▼"}
table#ov td.numcol{text-align:right;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
table#ov tbody tr:hover{background:color-mix(in srgb,var(--accent),var(--surface-1) 90%)}
.pill{font-size:10px;padding:1px 7px;border-radius:999px}
.pill.ok{background:color-mix(in srgb,#22c55e,var(--surface-1) 78%);color:#c9f7d8}
.pill.bad{background:color-mix(in srgb,#ef4444,var(--surface-1) 76%);color:#ffd7d3}
/* cards */
.cards{display:flex;flex-direction:column;gap:16px}
.card{border:1px solid var(--border-subtle);border-radius:14px;background:var(--surface-0);overflow:hidden;scroll-margin-top:70px}
.card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;
  border-bottom:1px solid var(--border-subtle);background:var(--surface-1)}
.card-title{font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.badges{display:flex;gap:6px;flex-wrap:wrap}
.badge{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--border-subtle);color:var(--text-muted);white-space:nowrap}
.badge.hw{background:color-mix(in srgb,var(--accent),var(--surface-1) 86%);color:#cfe3f5;border-color:transparent}
.badge.ref{background:var(--surface-2);color:#cbd5e1}
.badge.ok{background:color-mix(in srgb,#22c55e,var(--surface-1) 80%);color:#c9f7d8;border-color:transparent}
.badge.bad{background:color-mix(in srgb,#ef4444,var(--surface-1) 78%);color:#ffd7d3;border-color:transparent}
.card-body{padding:16px}
.error-body{color:#ffb4ad;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
.panel{display:flex;flex-direction:column;gap:12px}
.metrics-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
@media(max-width:640px){.metrics-grid{grid-template-columns:repeat(2,1fr)}}
.metric{border:1px solid var(--border-subtle);border-radius:10px;background:var(--surface-1);padding:9px 11px;display:flex;flex-direction:column;gap:3px}
.metric.compact{padding:7px 9px}
.metric-k{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-muted)}
.metric-v{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums}
.metric.compact .metric-v{font-size:14px}
.panel-title{font-size:13px;font-weight:650;margin-top:2px}
.pie-wrap{display:flex;gap:14px;align-items:center;border:1px solid var(--border-subtle);border-radius:10px;background:var(--surface-1);padding:12px}
.pie{width:84px;height:84px;border-radius:50%;border:1px solid var(--border-subtle);position:relative;flex:none}
.pie-hole{position:absolute;inset:26%;border-radius:50%;background:var(--surface-1);border:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text-muted)}
.pie-legend{flex:1;min-width:0}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:10px}
@media(max-width:640px){.two-col{grid-template-columns:1fr}}
.subpanel{border:1px solid var(--border-subtle);border-radius:10px;background:var(--surface-1);padding:10px 12px}
.subhead{font-size:12px;font-weight:650;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px}
.counters{columns:2;column-gap:16px}
@media(max-width:640px){.counters{columns:1}}
.stat{display:flex;justify-content:space-between;gap:10px;padding:3px 0;border-bottom:1px solid color-mix(in srgb,var(--border-subtle),transparent 45%);break-inside:avoid}
.stat:last-child{border-bottom:0}
.stat-k{font-size:12px;color:var(--text-muted);min-width:0;display:flex;align-items:center;gap:6px}
.stat-v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--text-strong);text-align:right;word-break:break-word}
.dot{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}
.dim{opacity:.55;font-weight:400}
.spread{font-size:11px;color:var(--text-muted);font-weight:400}
.chart{width:100%;height:150px;display:block}
.chart-scale{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--text-muted);margin-top:2px}
.legend-inline{font-size:10px;color:var(--text-muted);font-weight:400;display:flex;align-items:center;gap:3px}
.ls{width:14px;height:0;border-top:2px solid;display:inline-block;vertical-align:middle}
.ls.rss{border-color:var(--accent)}.ls.cpu{border-color:#f59e0b;border-top-style:dashed}
table.mini{border-collapse:collapse;width:100%;font-size:11.5px}
table.mini th,table.mini td{padding:3px 6px;text-align:right;border-bottom:1px solid color-mix(in srgb,var(--border-subtle),transparent 45%)}
table.mini th:first-child,table.mini td:first-child{text-align:left}
table.mini th{color:var(--text-muted);font-weight:600}
table.mini td{font-family:ui-monospace,Menlo,monospace}
`;

const JS = `
(function(){
  var tbl=document.getElementById('ov'); if(!tbl) return;
  var tb=tbl.tBodies[0];
  tbl.querySelectorAll('th.sortable').forEach(function(th){
    th.addEventListener('click',function(){
      var idx=[].indexOf.call(th.parentNode.children,th);
      var type=th.getAttribute('data-type');
      var asc=!th.classList.contains('asc');
      tbl.querySelectorAll('th').forEach(function(o){o.classList.remove('asc','desc');});
      th.classList.add(asc?'asc':'desc');
      var rows=[].slice.call(tb.rows);
      rows.sort(function(a,b){
        var x=a.cells[idx].getAttribute('data-sort'),y=b.cells[idx].getAttribute('data-sort');
        if(type==='n'){x=parseFloat(x);y=parseFloat(y);if(isNaN(x))x=-Infinity;if(isNaN(y))y=-Infinity;return asc?x-y:y-x;}
        return asc?String(x).localeCompare(String(y)):String(y).localeCompare(String(x));
      });
      rows.forEach(function(r){tb.appendChild(r);});
    });
  });
})();
`;

function buildPage(list, opts, meta) {
  const cards = list.map(({ s, id }) => card(id, s)).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title><style>${CSS}</style></head><body>
<div class="page-head"><div class="icon">📊</div><div>
  <h1>${esc(opts.title)}</h1>
  <p class="sub">${meta.n} case${meta.n === 1 ? '' : 's'} • ${meta.refs} ref(s) • ${meta.hws} hw config(s) • ${meta.printers} printer(s) • ${meta.fails} failed • generated ${esc(meta.when)}</p>
</div></div>
<div class="wrap">
  <div class="section-title">Overview — click a header to sort, a case to jump</div>
  <div class="ov-wrap">${overviewTable(list)}</div>
  <div class="section-title">Per-case detail</div>
  <div class="cards">${cards}</div>
</div>
<script>${JS}</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = loadRows(opts.inputs);
  if (raw.length === 0) { console.error('no rows found in input JSONL'); process.exit(1); }
  const list = raw.map((r, i) => ({ s: normalize(r), id: i }));

  const meta = {
    n: list.length,
    refs: new Set(list.map(({ s }) => s.ref || 'working-tree')).size,
    hws: new Set(list.map(({ s }) => hwLabel(s))).size,
    printers: new Set(list.map(({ s }) => s.printer)).size,
    fails: list.filter(({ s }) => s.error || s.ok === false).length,
    when: new Date().toISOString().replace('T', ' ').slice(0, 16) + 'Z',
  };
  const html = buildPage(list, opts, meta);
  writeFileSync(opts.out, html);
  process.stderr.write(`==> wrote ${opts.out} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, ${list.length} cases)\n`);

  if (opts.open) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try { spawn(opener, [resolve(opts.out)], { detached: true, stdio: 'ignore' }).unref(); } catch { /* ignore */ }
  }
}

main();
