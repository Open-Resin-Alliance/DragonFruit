/**
 * Finds every support type name used outside the registry.
 *
 * The vocabulary comes from the registry, so a new type is scanned
 * automatically. Comments are blanked before matching; the only exempt paths
 * are listed in EXEMPT.
 *
 * Usage (needs tsx, as the registry is TypeScript):
 *   npx tsx scripts/scan-support-type-references.ts             summary by file
 *   npx tsx scripts/scan-support-type-references.ts --lines      every match
 *   npx tsx scripts/scan-support-type-references.ts --file X     one file
 *   npx tsx scripts/scan-support-type-references.ts --json       machine readable
 *   npx tsx scripts/scan-support-type-references.ts --check --budget N
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    SUPPORT_COLLECTION_KEYS,
    SUPPORT_TYPES,
} from '../src/supports/supportTypeRegistry';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const REGISTRY = 'src/supports/supportTypeRegistry.ts';

/**
 * Paths whose per-type names are allowed.
 *
 * A type's own folder may name that type -- renderers, builders, placement
 * controllers and rules live there by convention. `types.ts` declares the
 * entity interfaces the registry derives from. Everything else is in scope.
 */
const EXEMPT = [REGISTRY, 'src/supports/types.ts', 'src/supports/SupportTypes/'];

interface Match { line: number; identifier: string; text: string }
interface Entry { path: string; refs: number; lines: number; matches: Match[] }

/**
 * Type ids and their collection keys, read from the registry rather than
 * restated. Origins and the root/knot primitives are deliberately excluded:
 * `island`, `overhang` and `root` are also general geometry vocabulary, and
 * scanning them buries the real findings under thousands of false matches.
 */
function vocabulary(): string[] {
    const stems = new Set<string>();
    for (const descriptor of SUPPORT_TYPES) stems.add(descriptor.id);
    for (const key of SUPPORT_COLLECTION_KEYS) stems.add(key);
    stems.delete('roots');
    stems.delete('knots');
    if (stems.size === 0) throw new Error('registry exported no type names');
    return [...stems];
}

/** Matches a stem inside an identifier, so `getTrunkById` counts as well as `trunk`. */
function buildPattern(stems: string[]): RegExp {
    const alts = stems
        .flatMap((s) => [s, s[0].toUpperCase() + s.slice(1), s.toUpperCase()])
        .sort((a, b) => b.length - a.length)
        .join('|');
    return new RegExp(`[A-Za-z0-9_$]*(?:${alts})[A-Za-z0-9_$]*`, 'g');
}

/** Blanks comments, preserving offsets and newlines so line numbers stay true. */
function blankComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                out += src[i] === '\n' ? '\n' : ' ';
                i++;
            }
            out += '  '; i += 2;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += c; i++;
            while (i < src.length) {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
                if (src[i] === quote) { out += quote; i++; break; }
                out += src[i]; i++;
            }
            continue;
        }
        out += c; i++;
    }
    return out;
}

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, acc);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
    }
    return acc;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1];
};

const pattern = buildPattern(vocabulary());
const only = value('--file');
const files: Entry[] = [];

for (const abs of walk(SRC)) {
    const path = relative(ROOT, abs).split(sep).join('/');
    if (path.includes('__tests__')) continue;
    if (EXEMPT.some((e) => path === e || path.startsWith(e))) continue;
    if (only && !path.includes(only)) continue;

    const raw = readFileSync(abs, 'utf8');
    const rawLines = raw.split('\n');
    const matches: Match[] = [];
    blankComments(raw).split('\n').forEach((text, index) => {
        for (const m of text.matchAll(pattern)) {
            matches.push({ line: index + 1, identifier: m[0], text: rawLines[index]?.trim() ?? '' });
        }
    });
    if (matches.length) files.push({ path, refs: matches.length, lines: rawLines.length, matches });
}

files.sort((a, b) => b.refs - a.refs);
const total = files.reduce((sum, f) => sum + f.refs, 0);

if (flag('--json')) {
    console.log(JSON.stringify({ total, files: files.length, entries: files }, null, 2));
} else if (flag('--lines')) {
    for (const f of files) {
        console.log(`\n${f.path}  (${f.refs})`);
        for (const m of f.matches) {
            console.log(`  ${String(m.line).padStart(5)}  ${m.identifier.padEnd(28)} ${m.text.slice(0, 90)}`);
        }
    }
} else {
    console.log(`${total} references across ${files.length} files\n`);
    for (const f of files.slice(0, 30)) console.log(`  ${String(f.refs).padStart(5)}  ${f.path}`);
    const rest = files.slice(30);
    if (rest.length) {
        const n = rest.reduce((s, f) => s + f.refs, 0);
        console.log(`\n  ${String(n).padStart(5)}  … ${rest.length} more files`);
    }
}

if (flag('--check')) {
    const budget = Number(value('--budget') ?? Infinity);
    if (total > budget) {
        console.error(`\nover budget: ${total} > ${budget}`);
        process.exit(1);
    }
}
