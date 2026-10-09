/**
 * Times the Tauri IPC bridge in isolation, with nothing else competing for the
 * main thread. Counterpart of `src-tauri/src/ipc_bench.rs`; context in #753.
 *
 * The slicing pipeline's `stageMeshMs` includes time the main thread spends
 * generating geometry before it can run the `.then` of a finished invoke, so it
 * cannot tell bridge cost from main-thread contention. This runs the same raw
 * upload path idle, and splits each round trip into request and response legs
 * using the handler's arrival timestamp.
 *
 * Usage: the "IPC bench" button in the slice metrics modal, or
 * `await window.__dfIpcBench()` from devtools. Both copy the JSON report.
 */

type Invoke = <T>(cmd: string, args?: unknown, opts?: { headers?: Record<string, string> }) => Promise<T>;

interface SinkAck {
    arrivedUnixUs: number;
    bytes: number;
    bodyKind: 'raw' | 'json';
    handlerNs: number;
}

interface Stats {
    median: number;
    min: number;
    max: number;
    n: number;
}

export interface IpcBenchRow {
    case: 'upload-raw' | 'upload-json' | 'download-raw' | 'renderer-copy';
    bytes: number;
    totalMs: Stats;
    /** JS send → handler start. Only for uploads. */
    requestMs?: Stats;
    /** Handler start → promise resolved. Only for uploads. */
    responseMs?: Stats;
    mibPerSecAtMedian: number | null;
}

export interface IpcBenchReport {
    startedAt: string;
    userAgent: string;
    env: unknown;
    clockOffsetUs: Stats;
    rows: IpcBenchRow[];
    /** Least-squares fit of upload-raw medians ≥ 1 MiB: t = fixedMs + bytes / bytesPerMs. */
    uploadFit: { fixedMs: number; mibPerSec: number } | null;
}

const MiB = 1024 * 1024;

const UPLOAD_SIZES: Array<[bytes: number, reps: number]> = [
    [0, 30],
    [1024, 30],
    [64 * 1024, 15],
    [MiB, 9],
    [16 * MiB, 7],
    [64 * MiB, 5],
    [256 * MiB, 3],
];

function stats(xs: number[]): Stats {
    const s = [...xs].sort((a, b) => a - b);
    return { median: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], n: s.length };
}

/** Wall clock in µs since the epoch, comparable with the Rust side's SystemTime. */
function nowUnixUs(): number {
    return (performance.timeOrigin + performance.now()) * 1000;
}

function mibPerSec(bytes: number, ms: number): number | null {
    return bytes > 0 && ms > 0 ? bytes / MiB / (ms / 1000) : null;
}

function filled(bytes: number): Uint8Array {
    const buf = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 4096) buf[i] = i & 0xff;
    return buf;
}

/**
 * Offset between the Rust and JS clocks, NTP-style: for a tiny call, assume the
 * handler ran halfway through the round trip. Error is bounded by half the RTT.
 */
async function estimateClockOffsetUs(invoke: Invoke): Promise<Stats> {
    const offsets: number[] = [];
    const empty = new Uint8Array(0);
    for (let i = 0; i < 31; i++) {
        const t0 = nowUnixUs();
        const ack = await invoke<SinkAck>('ipc_bench_sink', empty, { headers: { 'Content-Type': 'application/octet-stream' } });
        const t1 = nowUnixUs();
        offsets.push(ack.arrivedUnixUs - (t0 + t1) / 2);
    }
    return stats(offsets);
}

async function timeUpload(invoke: Invoke, payload: Uint8Array | Record<string, unknown>, reps: number, offsetUs: number) {
    const totals: number[] = [];
    const requests: number[] = [];
    const responses: number[] = [];
    let kind: SinkAck['bodyKind'] = 'raw';
    let bytes = 0;
    const isRaw = payload instanceof Uint8Array;
    // One unmeasured call so first-touch allocation in either process is not counted.
    for (let i = -1; i < reps; i++) {
        const t0 = nowUnixUs();
        const ack = await invoke<SinkAck>('ipc_bench_sink', payload,
            isRaw ? { headers: { 'Content-Type': 'application/octet-stream' } } : undefined);
        const t1 = nowUnixUs();
        if (i < 0) continue;
        kind = ack.bodyKind;
        bytes = ack.bytes;
        const arrived = ack.arrivedUnixUs - offsetUs;
        totals.push((t1 - t0) / 1000);
        requests.push((arrived - t0) / 1000);
        responses.push((t1 - arrived) / 1000 - ack.handlerNs / 1e6);
    }
    return { totals, requests, responses, kind, bytes };
}

async function timeDownload(invoke: Invoke, bytes: number, reps: number) {
    const totals: number[] = [];
    for (let i = -1; i < reps; i++) {
        const t0 = performance.now();
        const out = await invoke<ArrayBuffer | number[]>('ipc_bench_source', { bytes });
        const t1 = performance.now();
        const got = out instanceof ArrayBuffer ? out.byteLength : out.length;
        if (got !== bytes) throw new Error(`ipc_bench_source returned ${got} bytes, expected ${bytes}`);
        if (i >= 0) totals.push(t1 - t0);
    }
    return totals;
}

/** In-renderer copy of the same bytes: the floor any bridge is compared against. */
function timeRendererCopy(buf: Uint8Array, reps: number): number[] {
    const totals: number[] = [];
    for (let i = -1; i < reps; i++) {
        const t0 = performance.now();
        const copy = buf.slice();
        const t1 = performance.now();
        if (copy.length !== buf.length) throw new Error('copy length mismatch');
        if (i >= 0) totals.push(t1 - t0);
    }
    return totals;
}

function fitUpload(rows: IpcBenchRow[]): IpcBenchReport['uploadFit'] {
    const pts = rows.filter((r) => r.case === 'upload-raw' && r.bytes >= MiB).map((r) => [r.bytes, r.totalMs.median]);
    if (pts.length < 2) return null;
    const n = pts.length;
    const mx = pts.reduce((a, [x]) => a + x, 0) / n;
    const my = pts.reduce((a, [, y]) => a + y, 0) / n;
    const slope = pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    return { fixedMs: my - slope * mx, mibPerSec: MiB / slope / 1000 };
}

export async function runIpcBench(log: (line: string) => void = console.info): Promise<IpcBenchReport> {
    const { invoke } = (await import('@tauri-apps/api/core')) as { invoke: Invoke };
    const env = await invoke('ipc_bench_env');
    log(`[ipc-bench] env ${JSON.stringify(env)}`);

    const clockOffsetUs = await estimateClockOffsetUs(invoke);
    log(`[ipc-bench] clock offset ${clockOffsetUs.median.toFixed(0)} µs [${clockOffsetUs.min.toFixed(0)}, ${clockOffsetUs.max.toFixed(0)}]`);

    const rows: IpcBenchRow[] = [];
    for (const [bytes, reps] of UPLOAD_SIZES) {
        const buf = filled(bytes);
        const up = await timeUpload(invoke, buf, reps, clockOffsetUs.median);
        if (up.kind !== 'raw') throw new Error(`upload of ${bytes} bytes arrived as ${up.kind}, expected raw`);
        const totalMs = stats(up.totals);
        rows.push({
            case: 'upload-raw', bytes, totalMs,
            requestMs: stats(up.requests), responseMs: stats(up.responses),
            mibPerSecAtMedian: mibPerSec(bytes, totalMs.median),
        });
        log(`[ipc-bench] upload-raw ${bytes} B: ${totalMs.median.toFixed(2)} ms [${totalMs.min.toFixed(2)}, ${totalMs.max.toFixed(2)}]`);

        const down = stats(await timeDownload(invoke, bytes, reps));
        rows.push({ case: 'download-raw', bytes, totalMs: down, mibPerSecAtMedian: mibPerSec(bytes, down.median) });

        if (bytes > 0) {
            const copy = stats(timeRendererCopy(buf, reps));
            rows.push({ case: 'renderer-copy', bytes, totalMs: copy, mibPerSecAtMedian: mibPerSec(bytes, copy.median) });
        }
    }

    // The JSON path for small structured args: what a typical command pays per call.
    for (const [bytes, reps] of [[0, 30], [1024, 30], [64 * 1024, 15]] as const) {
        const payload = { data: 'x'.repeat(bytes) };
        const up = await timeUpload(invoke, payload, reps, clockOffsetUs.median);
        const totalMs = stats(up.totals);
        rows.push({
            case: 'upload-json', bytes: up.bytes, totalMs,
            requestMs: stats(up.requests), responseMs: stats(up.responses),
            mibPerSecAtMedian: mibPerSec(up.bytes, totalMs.median),
        });
    }

    const report: IpcBenchReport = {
        startedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        env,
        clockOffsetUs,
        rows,
        uploadFit: fitUpload(rows),
    };
    if (report.uploadFit) {
        log(`[ipc-bench] upload fit: ${report.uploadFit.fixedMs.toFixed(2)} ms + bytes at ${report.uploadFit.mibPerSec.toFixed(1)} MiB/s`);
    }
    // One line, so it lands whole in the platform log file via the attached console.
    log(`[ipc-bench] report ${JSON.stringify(report)}`);
    return report;
}

/** Exposes `window.__dfIpcBench()` for devtools. Copies the report when it can. */
export function installIpcBenchGlobal(): void {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    (window as unknown as { __dfIpcBench: () => Promise<IpcBenchReport> }).__dfIpcBench = async () => {
        const report = await runIpcBench();
        console.table(report.rows.map((r) => ({
            case: r.case, bytes: r.bytes,
            medianMs: +r.totalMs.median.toFixed(3), minMs: +r.totalMs.min.toFixed(3), maxMs: +r.totalMs.max.toFixed(3),
            requestMs: r.requestMs ? +r.requestMs.median.toFixed(3) : null,
            responseMs: r.responseMs ? +r.responseMs.median.toFixed(3) : null,
            mibPerSec: r.mibPerSecAtMedian ? +r.mibPerSecAtMedian.toFixed(1) : null,
        })));
        await navigator.clipboard?.writeText(JSON.stringify(report, null, 2)).catch(() => { });
        return report;
    };
}
