/**
 * Iterative auto-support comparison harness.
 *
 * Usage: node --import tsx scripts/compare-auto-supports.ts <ours.voxl> <pro.voxl>
 *
 * Parses two VOXL files (DragonFruit's native format), extracts every support
 * contact tip and plate root, and prints a side-by-side report + a spatial
 * diff so we can compare our auto-supports against a professional
 * pre-support (the official models under E:\DragonFruit_AutoSupports).
 *
 * Coordinate frame: the VOXL support payload is DragonFruitImportFormat with
 * WORLD-space positions (the support snapshot is world-space), so tips and
 * roots are compared directly. All numbers are pure geometry — no physics.
 */
import { readFileSync } from 'node:fs';
import { parseVoxlAuto } from '../src/features/scene/voxl/codec';
import type { DragonfruitImportFormat } from '../src/supports/types';

type XY = { x: number; y: number };
type Tip = XY & { z: number; kind: string };

const [oursPath, proPath] = process.argv.slice(2);
if (!oursPath || !proPath) {
    console.error('usage: node --import tsx scripts/compare-auto-supports.ts <ours.voxl> <pro.voxl>');
    process.exit(1);
}

function load(path: string): DragonfruitImportFormat {
    const bytes = readFileSync(path);
    const parsed = parseVoxlAuto(bytes);
    const supports = (parsed.document as { supports?: DragonfruitImportFormat }).supports;
    if (!supports) {
        // A bare model file carries no supports payload — treat as empty.
        return {
            version: 1,
            meta: { source: '', objectCenter: { x: 0, y: 0, z: 0 } },
            roots: [], trunks: [], branches: [], leaves: [], braces: [], knots: [],
        };
    }
    return supports;
}

function extract(s: DragonfruitImportFormat): { tips: Tip[]; rootXY: XY[] } {
    const tips: Tip[] = [];
    for (const t of s.trunks ?? []) if (t.contactCone?.pos) tips.push({ ...t.contactCone.pos, kind: 'trunk' });
    for (const b of s.branches ?? []) if (b.contactCone?.pos) tips.push({ ...b.contactCone.pos, kind: 'branch' });
    for (const l of s.leaves ?? []) if (l.contactCone?.pos) tips.push({ ...l.contactCone.pos, kind: 'leaf' });
    for (const a of s.anchors ?? []) tips.push({ x: a.rootPos.x, y: a.rootPos.y, z: 0, kind: 'anchor' });
    const rootXY: XY[] = [
        ...(s.roots ?? []).map((r) => ({ x: r.transform.pos.x, y: r.transform.pos.y })),
        ...(s.anchors ?? []).map((a) => ({ x: a.rootPos.x, y: a.rootPos.y })),
    ];
    return { tips, rootXY };
}

/** Mean XY nearest-neighbor distance — density proxy. */
function meanNNDist(points: XY[]): number {
    if (points.length < 2) return NaN;
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
        let best = Infinity;
        for (let j = 0; j < points.length; j++) {
            if (i === j) continue;
            const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
            if (d < best) best = d;
        }
        sum += best;
    }
    return sum / points.length;
}

function cellKey(x: number, y: number, cell: number): string {
    return `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
}

function spatialDiff(ours: XY[], pro: XY[], cell = 2): { missed: number; missedAreaMm2: number; extra: number; extraAreaMm2: number; proCoveredByOursPct: number } {
    const ourCells = new Set(ours.map((p) => cellKey(p.x, p.y, cell)));
    const proCells = new Set(pro.map((p) => cellKey(p.x, p.y, cell)));
    let missed = 0;
    let extra = 0;
    for (const c of proCells) if (!ourCells.has(c)) missed++;
    for (const c of ourCells) if (!proCells.has(c)) extra++;
    // Coverage: fraction of pro tips within 4 mm (XY) of an our tip.
    let covered = 0;
    for (const p of pro) {
        if (ours.some((o) => Math.hypot(o.x - p.x, o.y - p.y) <= 4)) covered++;
    }
    return {
        missed,
        missedAreaMm2: missed * cell * cell,
        extra,
        extraAreaMm2: extra * cell * cell,
        proCoveredByOursPct: pro.length > 0 ? (covered / pro.length) * 100 : NaN,
    };
}

function report(name: string, tips: Tip[], rootXY: XY[]): void {
    const byKind: Record<string, number> = {};
    for (const t of tips) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
    const minTipZ = Math.min(...tips.map((t) => t.z), Infinity);
    // Anchor layer: the first-printed band (tips within 5 mm of the model's
    // lowest contact) — the density we tune with the anchor knobs.
    const anchorTips = tips.filter((t) => t.z <= minTipZ + 5);
    console.log(`  ${name}: ${tips.length} tips (${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(', ')})`);
    console.log(`    roots: ${rootXY.length} | tip spacing (mean NN, XY): ${meanNNDist(tips).toFixed(2)} mm | root spacing: ${meanNNDist(rootXY).toFixed(2)} mm`);
    console.log(`    anchor layer (z ≤ ${minTipZ.toFixed(1)} + 5): ${anchorTips.length} tips (${((anchorTips.length / tips.length) * 100).toFixed(0)}% of total), spacing ${meanNNDist(anchorTips).toFixed(2)} mm`);
}

const ours = extract(load(oursPath));
const pro = extract(load(proPath));

console.log(`\n== Support forest comparison ==`);
report('ours', ours.tips, ours.rootXY);
report('pro ', pro.tips, pro.rootXY);

const diff = spatialDiff(ours.tips, pro.tips);
console.log(`\n== Spatial diff (2 mm cells over XY) ==`);
console.log(`  pro tips not covered by ours: ${diff.missed} cells (${diff.missedAreaMm2.toFixed(0)} mm²)`);
console.log(`  our tips not covered by pro:  ${diff.extra} cells (${diff.extraAreaMm2.toFixed(0)} mm²)`);
console.log(`  pro tips within 4 mm of an ours tip: ${diff.proCoveredByOursPct.toFixed(1)}%`);

// Anchor-layer spatial diff (the thing we're tuning).
const oursMinZ = Math.min(...ours.tips.map((t) => t.z), Infinity);
const proMinZ = Math.min(...pro.tips.map((t) => t.z), Infinity);
const anchorDiff = spatialDiff(
    ours.tips.filter((t) => t.z <= oursMinZ + 5),
    pro.tips.filter((t) => t.z <= proMinZ + 5),
);
console.log(`\n== Anchor-layer diff (first 5 mm above the lowest contact) ==`);
console.log(`  pro anchor cells not covered by ours: ${anchorDiff.missed} (${anchorDiff.missedAreaMm2.toFixed(0)} mm²)`);
console.log(`  our anchor cells not covered by pro:  ${anchorDiff.extra} (${anchorDiff.extraAreaMm2.toFixed(0)} mm²)`);
console.log(`  pro anchor tips within 4 mm of an ours: ${anchorDiff.proCoveredByOursPct.toFixed(1)}%`);
