/**
 * One-off LYS scene inspector.
 *
 * Mirrors LysParser's manifest + decode pipeline without pulling three.js.
 * Prints the support graph so we can see exactly how Lychee encodes parent
 * references for leaves/braces attached to twigs.
 *
 * Run: node --import tsx .scratch/lys-inspect/inspect.ts <path-to.lys>
 */

import { readFileSync } from 'node:fs';
import { decode } from '@msgpack/msgpack';

const LYS_KEY_OBFUSCATION = 'DragonFruitFTW';
const LYS_DEFAULT_APP_ID_XOR: number[] = [
    0x25, 0x4a, 0x04, 0x02, 0x5e, 0x5f, 0x72, 0x44, 0x58, 0x51, 0x10, 0x76,
    0x67, 0x7a, 0x70, 0x10, 0x57, 0x5e, 0x42, 0x56, 0x27, 0x44, 0x42, 0x44,
    0x41, 0x7f, 0x64, 0x67, 0x7d, 0x13, 0x52, 0x01, 0x56, 0x0b, 0x23, 0x45,
];

function xorDeobfuscateToUtf8(input: number[], mask: string): string {
    const maskBytes = new TextEncoder().encode(mask);
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
        out[i] = input[i] ^ maskBytes[i % maskBytes.length];
    }
    return new TextDecoder('utf-8').decode(out);
}

function decodeProtectedBytes(data: Uint8Array, key: string): Uint8Array {
    const out = new Uint8Array(data.length);
    const keyBytes = new TextEncoder().encode(key);
    const klen = keyBytes.length;
    for (let i = 0; i < data.length; i++) {
        const k = keyBytes[i % klen];
        const val = data[i] - k;
        out[i] = ((val % 256) + 256) % 256;
    }
    return out;
}

function findJsonHeader(data: Uint8Array): { start: number; end: number } {
    const decoder = new TextDecoder('utf-8');
    const maxScan = Math.min(data.length, 2_000_000);

    const tryExtractObjectBounds = (start: number): { start: number; end: number } | null => {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < maxScan; i++) {
            const c = data[i];
            if (inString) {
                if (escaped) { escaped = false; continue; }
                if (c === 92) { escaped = true; continue; }
                if (c === 34) { inString = false; }
                continue;
            }
            if (c === 34) { inString = true; continue; }
            if (c === 123) { depth++; continue; }
            if (c === 125) {
                depth--;
                if (depth === 0) return { start, end: i + 1 };
                if (depth < 0) return null;
            }
        }
        return null;
    };

    const marker = new TextEncoder().encode('"mangoFiles"');
    const markerStarts: number[] = [];
    for (let i = 0; i <= maxScan - marker.length; i++) {
        let ok = true;
        for (let j = 0; j < marker.length; j++) {
            if (data[i + j] !== marker[j]) { ok = false; break; }
        }
        if (ok) markerStarts.push(i);
    }

    const candidateStarts: number[] = [];
    for (const m of markerStarts) {
        for (let i = m; i >= Math.max(0, m - 200_000); i--) {
            if (data[i] === 123) { candidateStarts.push(i); break; }
        }
    }
    for (let i = 0; i < maxScan; i++) {
        if (data[i] === 123) candidateStarts.push(i);
        if (candidateStarts.length > 2000) break;
    }

    const seen = new Set<number>();
    for (const start of candidateStarts) {
        if (seen.has(start)) continue;
        seen.add(start);
        const bounds = tryExtractObjectBounds(start);
        if (!bounds) continue;
        try {
            const raw = decoder.decode(data.subarray(bounds.start, bounds.end));
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object'
                && (parsed.mangoFiles || parsed.version || parsed.scene)) {
                return bounds;
            }
        } catch { /* keep scanning */ }
    }
    throw new Error('LYS manifest JSON header not found');
}

function main() {
    const filePath = process.argv[2];
    if (!filePath) {
        console.error('usage: inspect.ts <path-to.lys>');
        process.exit(1);
    }

    const buf = readFileSync(filePath);
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

    const { start, end } = findJsonHeader(data);
    const manifest = JSON.parse(new TextDecoder('utf-8').decode(data.subarray(start, end)));

    let dataStart = end;
    while (dataStart < data.length && data[dataStart] === 0) dataStart++;

    const filesInfo = manifest.mangoFiles || {};
    let sceneBlob: Uint8Array | null = null;
    for (const [fname, info] of Object.entries(filesInfo) as [string, any][]) {
        if (fname.toLowerCase() === 'scene.bin') {
            const off = dataStart + Number(info.offset || 0);
            const size = Number(info.size || 0);
            sceneBlob = data.subarray(off, off + size);
            break;
        }
    }
    if (!sceneBlob) throw new Error('scene.bin not found in manifest');

    const key = xorDeobfuscateToUtf8(LYS_DEFAULT_APP_ID_XOR, LYS_KEY_OBFUSCATION);
    const decoded = decodeProtectedBytes(sceneBlob, key);
    const scene = decode(decoded) as any;

    const supports = scene?.supports?.present?.byId ?? {};
    const supportIds = Object.keys(supports);
    const objects = scene?.objects?.present?.byId ?? {};

    console.log('=== scene summary ===');
    console.log('object count:', Object.keys(objects).length);
    console.log('support count:', supportIds.length);

    // Tally by parent-count + key flags so we get an at-a-glance shape.
    const buckets: Record<string, number> = {};
    for (const id of supportIds) {
        const s = supports[id];
        const parentRaw = s?.parentId ?? s?.parentIds ?? s?.parents ?? s?.parent ?? s?.hostId ?? s?.hostIds;
        const parentCount = Array.isArray(parentRaw)
            ? parentRaw.filter((v: any) => v).length
            : (parentRaw ? 1 : 0);
        const hasBaseNormal = !!(s?.baseNormal && (s.baseNormal.x || s.baseNormal.y || s.baseNormal.z));
        const hasTipNormal = !!(s?.tipNormal && (s.tipNormal.x || s.tipNormal.y || s.tipNormal.z));
        const baseZ = s?.base?.z;
        const grounded = Number.isFinite(baseZ) && Math.abs(baseZ as number) <= 0.2;
        const type = s?.type;
        const bucket = `type=${type ?? 'none'} parents=${parentCount} baseN=${hasBaseNormal?'y':'n'} tipN=${hasTipNormal?'y':'n'} grounded=${grounded?'y':'n'} mini=${!!s?.mini}`;
        buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    console.log('\n=== shape buckets ===');
    for (const [bucket, count] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${count.toString().padStart(4)}  ${bucket}`);
    }

    // Index parents by id so we can find children-of-twigs.
    // A "twig-like" parent = parent record with NO parents itself, two valid normals,
    // grounded base, type==1 (or unset), and presumably short length.
    function looksLikeTwig(s: any): boolean {
        const parentRaw = s?.parentId ?? s?.parentIds ?? s?.parents ?? s?.parent ?? s?.hostId ?? s?.hostIds;
        const parentCount = Array.isArray(parentRaw)
            ? parentRaw.filter((v: any) => v).length
            : (parentRaw ? 1 : 0);
        if (parentCount !== 0) return false;
        const hasBaseNormal = !!(s?.baseNormal && (s.baseNormal.x || s.baseNormal.y || s.baseNormal.z));
        const hasTipNormal = !!(s?.tipNormal && (s.tipNormal.x || s.tipNormal.y || s.tipNormal.z));
        if (!hasBaseNormal || !hasTipNormal) return false;
        const baseZ = s?.base?.z;
        if (!Number.isFinite(baseZ) || Math.abs(baseZ as number) <= 0.2) return false;
        const type = s?.type;
        if (Number.isFinite(type) && type !== 1) return false;
        return true;
    }

    const twigLikeIds = new Set(supportIds.filter((id) => looksLikeTwig(supports[id])));
    console.log(`\n=== twig-like support ids: ${twigLikeIds.size} ===`);
    for (const id of [...twigLikeIds].slice(0, 5)) {
        const s = supports[id];
        const dx = (s.tip?.x ?? 0) - (s.base?.x ?? 0);
        const dy = (s.tip?.y ?? 0) - (s.base?.y ?? 0);
        const dz = (s.tip?.z ?? 0) - (s.base?.z ?? 0);
        const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
        console.log(`  ${id}  len=${len.toFixed(2)}mm  baseZ=${s.base?.z}  tipZ=${s.tip?.z}  mini=${!!s.mini}`);
    }

    // Now find children whose parent reference resolves to a twig-like support.
    console.log('\n=== supports whose parent is a twig-like support ===');
    let foundChildren = 0;
    for (const id of supportIds) {
        const s = supports[id];
        const parentRaw = s?.parentId ?? s?.parentIds ?? s?.parents ?? s?.parent ?? s?.hostId ?? s?.hostIds;
        const parents: string[] = Array.isArray(parentRaw)
            ? parentRaw.map((v: any) => (typeof v === 'string' ? v : String(v ?? ''))).filter((v: string) => v.length > 0)
            : (typeof parentRaw === 'string' && parentRaw.length > 0 ? [parentRaw] : []);
        const parentBase = typeof s?.parentBaseId === 'string' ? s.parentBaseId : null;
        const parentTip = typeof s?.parentTipId === 'string' ? s.parentTipId : null;
        const allRefs = [...new Set([...parents, ...(parentBase ? [parentBase] : []), ...(parentTip ? [parentTip] : [])])];

        const twigParents = allRefs.filter((pid) => twigLikeIds.has(pid));
        if (twigParents.length === 0) continue;

        foundChildren++;
        if (foundChildren > 20) continue;

        const dx = (s.tip?.x ?? 0) - (s.base?.x ?? 0);
        const dy = (s.tip?.y ?? 0) - (s.base?.y ?? 0);
        const dz = (s.tip?.z ?? 0) - (s.base?.z ?? 0);
        const len = Math.sqrt(dx*dx + dy*dy + dz*dz);

        console.log(`\n  child=${id}`);
        console.log(`    parents (resolved to twigs): ${twigParents.join(', ')}`);
        console.log(`    parentId field:     ${JSON.stringify(s.parentId)}`);
        console.log(`    parentBaseId field: ${JSON.stringify(s.parentBaseId)}`);
        console.log(`    parentTipId field:  ${JSON.stringify(s.parentTipId)}`);
        console.log(`    type:               ${JSON.stringify(s.type)}`);
        console.log(`    mini:               ${JSON.stringify(s.mini)}`);
        console.log(`    isBaseTip:          ${JSON.stringify(s.isBaseTip)}`);
        console.log(`    base:               ${JSON.stringify(s.base)}`);
        console.log(`    tip:                ${JSON.stringify(s.tip)}`);
        console.log(`    baseNormal:         ${JSON.stringify(s.baseNormal)}`);
        console.log(`    tipNormal:          ${JSON.stringify(s.tipNormal)}`);
        console.log(`    endpoint distance:  ${len.toFixed(3)}mm`);
        console.log(`    settings keys:      ${Object.keys(s.settings ?? {}).join(', ')}`);
    }
    if (foundChildren === 0) {
        console.log('  (none found)');
    } else {
        console.log(`\n  total: ${foundChildren} child support(s) reference a twig-like parent`);
    }

    // Also dump a sample of all top-level keys on one support record so we
    // see what fields exist beyond what the converter currently reads.
    const sample = supports[supportIds[0]];
    console.log('\n=== sample support record keys ===');
    console.log(Object.keys(sample ?? {}).sort());
}

main();
