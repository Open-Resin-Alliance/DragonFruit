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
 *   npx tsx scripts/scan-support-type-references.ts --report     markdown inventory
 *   npx tsx scripts/scan-support-type-references.ts --check --budget N
 *
 * `--check` also fails on any id prefix spelled outside the registry.
 *
 * `--report` splits by zone — outside `src/supports/` first, then the folder
 * itself as a tally — and flags the structural tells that mark a file as
 * re-implementing what the registry declares rather than reading it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    SUPPORT_COLLECTION_KEYS,
    SUPPORT_TYPES,
} from '../src/supports/supportTypeRegistry';

/** The id prefixes each type declares, so a new one is covered once declared. */
function declaredPrefixes(): string[] {
    const prefixes = new Set<string>();
    for (const descriptor of SUPPORT_TYPES) {
        if (descriptor.knotHostPrefix) prefixes.add(descriptor.knotHostPrefix);
        if (descriptor.segmentSelectionPrefix) prefixes.add(descriptor.segmentSelectionPrefix);
    }
    return [...prefixes];
}

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');
/**
 * Roots scanned for the report. `src` alone misses the CLI and the importers,
 * which restate the same rules with no folder and no lint coverage.
 */
const REPORT_ROOTS = [SRC, join(ROOT, 'scripts'), join(ROOT, 'plugins'), join(ROOT, 'rust'), join(ROOT, 'src-tauri')];
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
interface PrefixHit { path: string; line: number; prefix: string; text: string }
interface Entry { path: string; refs: number; lines: number; matches: Match[]; zone: Zone; signals: string[] }

/**
 * Where a file sits relative to the support system. Only `supports` and
 * `registry` have a folder that excuses a per-type name; everywhere else one is
 * drift with nothing to justify it.
 */
type Zone = 'registry' | 'supports' | 'app-core' | 'app-ui' | 'plugin' | 'script' | 'rust';

function zoneOf(path: string): Zone {
    if (path === REGISTRY) return 'registry';
    if (path.endsWith('.rs')) return 'rust';
    if (path.startsWith('src/supports/')) return 'supports';
    if (path.startsWith('plugins/')) return 'plugin';
    if (path.startsWith('scripts/')) return 'script';
    return path.endsWith('.tsx') ? 'app-ui' : 'app-core';
}

/** Structural tells that a file restates a rule the registry already declares. */
const SIGNALS: ReadonlyArray<{ id: string; test: (ids: string[]) => RegExp }> = [
    { id: 'switch-arms', test: (ids) => new RegExp(String.raw`\bcase\s+['"](${ids.join('|')})['"]`) },
    { id: 'type-equality', test: (ids) => new RegExp(String.raw`(===|!==)\s*['"](${ids.join('|')})['"]`) },
    { id: 'hardcoded-list', test: (ids) => new RegExp(String.raw`\[\s*['"](${ids.join('|')})['"]\s*,`) },
    { id: 'collection-loop', test: () => new RegExp(String.raw`Object\.(values|keys|entries)\(\s*[A-Za-z_$][\w$.]*\.(${SUPPORT_COLLECTION_KEYS.join('|')})\b`) },
    // A literal support document: collection keys spelled out as an object shape.
    { id: 'collection-literal', test: () => new RegExp(String.raw`["'](${SUPPORT_COLLECTION_KEYS.join('|')}|roots|knots)["']\s*:[^\n]*["'](${SUPPORT_COLLECTION_KEYS.join('|')}|roots|knots)["']\s*:`) },
];

function signalsIn(code: string, ids: string[]): string[] {
    return SIGNALS.filter((s) => s.test(ids).test(code)).map((s) => s.id);
}

const TYPE_IDS = SUPPORT_TYPES.map((descriptor) => descriptor.id);

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

// `rust` adds .rs; it is off by default so a budget set against TypeScript is
// not moved by the wider walk.
function walk(dir: string, acc: string[] = [], rust = false): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'target' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, acc, rust);
        else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) acc.push(full);
        else if (rust && entry.endsWith('.rs')) acc.push(full);
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
const PREFIXES = declaredPrefixes();
const only = value('--file');
const files: Entry[] = [];
const prefixHits: PrefixHit[] = [];

// The report reaches past `src`; every other mode keeps its original scope, so
// a budget set against `src` is not broken by the wider walk.
const report = flag('--report');
const roots = report ? REPORT_ROOTS : [SRC];

for (const abs of roots.flatMap((root) => walk(root, [], report))) {
    const path = relative(ROOT, abs).split(sep).join('/');
    if (path.includes('__tests__')) continue;
    if (only && !path.includes(only)) continue;

    const raw = readFileSync(abs, 'utf8');
    const rawLines = raw.split('\n');

    // Scanned everywhere but the registry: a type's own folder may spell its
    // NAME, but an id format is cross-cutting.
    if (path !== REGISTRY) {
        for (const prefix of PREFIXES) {
            rawLines.forEach((text, index) => {
                if (!text.includes(prefix)) return;
                prefixHits.push({ path, line: index + 1, prefix, text: text.trim() });
            });
        }
    }

    // The report counts the exempt paths too: a type's own folder is a tally
    // there, not a pass. Every other mode keeps the exemption.
    if (!report && EXEMPT.some((e) => path === e || path.startsWith(e))) continue;
    const code = blankComments(raw);
    const matches: Match[] = [];
    code.split('\n').forEach((text, index) => {
        for (const m of text.matchAll(pattern)) {
            matches.push({ line: index + 1, identifier: m[0], text: rawLines[index]?.trim() ?? '' });
        }
    });
    if (matches.length) {
        files.push({
            path,
            refs: matches.length,
            lines: rawLines.length,
            matches,
            zone: zoneOf(path),
            signals: signalsIn(code, TYPE_IDS),
        });
    }
}

files.sort((a, b) => b.refs - a.refs);
const total = files.reduce((sum, f) => sum + f.refs, 0);

if (report) {
    const OUTSIDE: Zone[] = ['app-core', 'app-ui', 'plugin', 'script', 'rust'];
    const sum = (rows: Entry[]) => rows.reduce((n, f) => n + f.refs, 0);
    const outside = files.filter((f) => OUTSIDE.includes(f.zone));
    const inside = files.filter((f) => f.zone === 'supports');
    const registry = files.filter((f) => f.zone === 'registry');
    const say = (s = '') => console.log(s);

    // A collection key maps to its own type ("leaves" -> leaf), so a plural is
    // not counted as an unknown. Anything matching neither is reported under
    // `other`: the vocabulary is broader than the type ids alone.
    const typeOfIdentifier = (identifier: string): string => {
        const lower = identifier.toLowerCase();
        const collection = SUPPORT_COLLECTION_KEYS.find((key) => lower.includes(key));
        if (collection) {
            const owner = SUPPORT_TYPES.find((descriptor) => descriptor.location.key === collection);
            if (owner) return owner.id;
        }
        return TYPE_IDS.find((t) => lower.includes(t)) ?? 'other';
    };

    const perType = (entry: Entry) => {
        const counts = new Map<string, number>();
        for (const m of entry.matches) {
            const id = typeOfIdentifier(m.identifier);
            counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        return [...counts].sort((a, b) => b[1] - a[1]);
    };

    const table = (rows: Entry[], withSignals = true) => {
        say(`| hits | types | reg | lines | file | names${withSignals ? ' | signals' : ''} |`);
        say(`|---:|---:|:--:|---:|---|---${withSignals ? '|---' : ''}|`);
        for (const f of rows) {
            const names = perType(f);
            const usesRegistry = readFileSync(join(ROOT, f.path), 'utf8').includes('supportTypeRegistry');
            const sig = withSignals ? ` | ${f.signals.join(', ') || '—'}` : '';
            say(`| ${f.refs} | ${names.length} | ${usesRegistry ? 'Y' : '—'} | ${f.lines} | \`${f.path}\` | ${names.map(([t, n]) => `${t}:${n}`).join(' ')}${sig} |`);
        }
        say('');
    };

    say('# Support-type drift inventory');
    say('');
    say('Every identifier carrying a support-type stem, outside tests. Generated by');
    say('`npx tsx scripts/scan-support-type-references.ts --report`.');
    say('');
    say('A hit is an identifier, so `braces`, `bracePlacementStore` and `isBraceSelected` each');
    say('count once. Under one generic entity a per-type name is drift: the distinction belongs');
    say('in the registry as data.');
    say('');
    say('| scope | files | hits |');
    say('|---|---:|---:|');
    say(`| **Outside \`src/supports/\`** | **${outside.length}** | **${sum(outside)}** |`);
    say(`| Inside \`src/supports/\` | ${inside.length} | ${sum(inside)} |`);
    say(`| The registry itself | ${registry.length} | ${sum(registry)} |`);
    say(`| **Total** | **${files.length}** | **${sum(files)}** |`);
    say('');
    say('The registry\'s own hits are the declarations everything else should read.');
    say('');
    say('## Signals');
    say('');
    say('- `switch-arms` — `case \'trunk\':` dispatch, one arm per type.');
    say('- `type-equality` — `typeId === \'leaf\'` branching.');
    say('- `hardcoded-list` — an inline array of type names.');
    say('- `collection-loop` — `Object.values(state.branches)`, one collection by name.');
    say('- `collection-literal` — a support document written out as collection keys.');
    say('');
    say('`reg = Y` means the file imports the registry somewhere, not that the counted lines use it.');
    say('');
    say('**Rust is almost all false positives.** `leaf` is a BVH leaf and a Merkle leaf, `branch` is');
    say('a git or control-flow branch, `trunk` is a tenon trunk. Rust never parses the support');
    say('document, only forwards its bytes, so read the Rust rows by `types` and `signals`, not hits:');
    say('a row naming one type is English, and only a `collection-literal` row is drift.');
    say('');
    say('---');
    say('');
    say('# Part 1 — outside `src/supports/`');
    say('');
    say(`${outside.length} files, ${sum(outside)} hits. No folder excuses a per-type name here.`);
    say('');
    for (const zone of OUTSIDE) {
        const rows = outside.filter((f) => f.zone === zone);
        if (rows.length === 0) continue;
        const label: Record<string, string> = {
            'app-core': 'App core (`.ts`)',
            'app-ui': 'App UI (`.tsx`)',
            plugin: 'Plugins (separate repos, building `DragonfruitImportFormat`)',
            script: 'Scripts (outside this scanner\'s default scope and `check:lint`)',
            rust: 'Rust (`rust/`, `src-tauri/`, plugin crates — most hits are English, see the caveat)',
        };
        say(`## ${label[zone]} — ${rows.length} files, ${sum(rows)} hits`);
        say('');
        table(rows);
    }
    say('---');
    say('');
    say('# Part 2 — inside `src/supports/` (tally)');
    say('');
    say(`${inside.length} files, ${sum(inside)} hits. Tracked, not actioned: this code already`);
    say('lives with the support system. It is still the bulk of what a one-entity collapse absorbs.');
    say('');
    const ownedRe = /^src\/supports\/SupportTypes\/([A-Z][a-z]+)\//;
    const owned = inside.filter((f) => ownedRe.test(f.path));
    const rest = inside.filter((f) => !ownedRe.test(f.path));

    const leak = owned
        .map((f) => {
            const owner = f.path.match(ownedRe)![1].toLowerCase();
            const foreign = perType(f).filter(([t]) => t !== owner);
            return { path: f.path, owner, n: foreign.reduce((s, [, v]) => s + v, 0), foreign };
        })
        .filter((l) => l.n > 0)
        .sort((a, b) => b.n - a.n);

    say(`## Cross-type leakage — ${leak.length} of ${owned.length} owned files, ${leak.reduce((s, l) => s + l.n, 0)} foreign hits`);
    say('');
    say('A type\'s own folder naming itself is conceded. Naming others is cross-type logic filed');
    say('under one owner.');
    say('');
    say('| foreign | owner | file | foreign names |');
    say('|---:|---|---|---|');
    for (const l of leak) say(`| ${l.n} | ${l.owner} | \`${l.path}\` | ${l.foreign.map(([t, n]) => `${t}:${n}`).join(' ')} |`);
    say('');
    say(`## All \`SupportTypes/\` files — ${owned.length} files, ${sum(owned)} hits`);
    say('');
    table(owned, false);
    say(`## Rest of \`src/supports/\` — ${rest.length} files, ${sum(rest)} hits`);
    say('');
    table(rest, false);
} else if (flag('--json')) {
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

if (prefixHits.length && !flag('--json')) {
    console.log(`\n${prefixHits.length} spelled-out id prefix(es):\n`);
    for (const hit of prefixHits) {
        console.log(`  ${hit.path}:${hit.line}  ${hit.prefix}`);
        console.log(`        ${hit.text.slice(0, 90)}`);
    }
}

if (flag('--check')) {
    let failed = false;

    const budget = Number(value('--budget') ?? Infinity);
    if (total > budget) {
        console.error(`\nover budget: ${total} > ${budget}`);
        failed = true;
    }

    // No budget: a spelled prefix splits a write from its read on a rename.
    if (prefixHits.length) {
        console.error(
            `\n${prefixHits.length} spelled-out id prefix(es) outside the registry. `
            + 'Build with `knotHostId` / `segmentSelectionId`, parse with '
            + '`parseKnotHostId` / `parseSegmentSelectionId`.',
        );
        failed = true;
    }

    if (failed) process.exit(1);
}
