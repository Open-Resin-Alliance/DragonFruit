import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

/**
 * Tripwire for the auto-support worker's import graph.
 *
 * The worker evaluates its whole module graph before it can receive a request,
 * and a worker realm has no `window`. A module-scope DOM access anywhere in
 * that graph therefore kills the worker silently: the client's request is never
 * answered and the app sits on "Generating Supports" with nothing happening.
 * That is exactly what happened once, from a debug helper that installed
 * `window.__dfPerf` at import time — it threw under the dev server's worker
 * shim, which exists to catch this, and nothing in production would have shown
 * it.
 *
 * So: walk the graph from the worker entry and fail on module-scope side
 * effects, which is where such an access has to live. Anything genuinely safe
 * goes in the allowlist with the reason it is safe.
 */

const ROOT = process.cwd();
const ENTRY = resolve(ROOT, 'src/supports/autoSupport/autoPlace.worker.ts');

/** Module-scope side effects that are DOM-free, with the reason each is safe. */
const ALLOWED_SIDE_EFFECTS: Array<{ file: string; contains: string; reason: string }> = [
    {
        file: 'src/supports/Settings/state.ts',
        contains: 'loadSettingsFromLocalStorage()',
        reason: 'reads localStorage only through hasLocalStorage(), which is typeof-guarded',
    },
    {
        file: 'src/features/experiments/experimentsRegistry.ts',
        contains: 'assertValidExperimentsManifest(',
        reason: 'validates the bundled manifest; throws on bad data, touches no globals',
    },
    {
        file: 'src/supports/state.ts',
        contains: 'registerSupportTypeResolver(',
        reason: 'fills a registry slot',
    },
    {
        file: 'src/supports/state.ts',
        contains: "registerCollectionRestore('",
        reason: 'fills a registry slot',
    },
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
    let base: string;
    if (specifier.startsWith('@/')) base = resolve(ROOT, 'src', specifier.slice(2));
    else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
    else return null; // a package, not our module
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
        if (isFile(candidate)) return candidate;
    }
    return null;
}

/**
 * Module-scope statements that do something: brace depth 0, not a comment, not
 * a declaration, and not the continuation of a multi-line declaration.
 */
function moduleScopeSideEffects(source: string): string[] {
    const found: string[] = [];
    let depth = 0;
    let previousEndedStatement = true;
    for (const line of source.split('\n')) {
        const trimmed = line.trim();
        const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
        const isDeclaration = /^(import|export|type|interface|const|let|var|function|class|declare|abstract|return)\b/.test(trimmed);
        const looksLikeCall = /^[A-Za-z_$][\w$.]*\s*\(.*\)\s*;?$/.test(trimmed);
        if (depth === 0 && previousEndedStatement && !isComment && !isDeclaration && looksLikeCall) {
            found.push(trimmed);
        }
        if (!isComment && trimmed.length > 0) {
            previousEndedStatement = /[;{}]$/.test(trimmed) || /^[A-Za-z_$][\w$.]*\s*\(.*\)\s*;?$/.test(trimmed);
        }
        for (const ch of line) {
            if (ch === '{' || ch === '(' || ch === '[') depth++;
            else if (ch === '}' || ch === ')' || ch === ']') depth--;
        }
    }
    return found;
}

/** Every module reachable from the worker entry, by import specifier. */
function workerClosure(): Map<string, string> {
    const sources = new Map<string, string>();
    const queue = [ENTRY];
    while (queue.length > 0) {
        const file = queue.pop()!;
        if (sources.has(file)) continue;
        const source = readFileSync(file, 'utf8');
        sources.set(file, source);
        for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
            re.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = re.exec(source))) {
                const next = resolveSpecifier(match[1], file);
                if (next && !sources.has(next)) queue.push(next);
            }
        }
    }
    return sources;
}

test('no module in the worker graph has an unguarded module-scope side effect', () => {
    const closure = workerClosure();
    assert.ok(closure.size > 100, `the closure should be the whole placement pipeline, got ${closure.size}`);

    const offenders: string[] = [];
    for (const [file, source] of closure) {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        for (const statement of moduleScopeSideEffects(source)) {
            const allowed = ALLOWED_SIDE_EFFECTS.some(
                (entry) => rel === entry.file && statement.includes(entry.contains),
            );
            if (!allowed) offenders.push(`${rel}: ${statement}`);
        }
    }

    assert.deepEqual(
        offenders,
        [],
        'Module-scope side effects in the worker graph. A worker has no window, so a DOM access here kills it ' +
        'before it can answer a request (silently, and only in dev). Move the effect to the app root, or add it ' +
        'to ALLOWED_SIDE_EFFECTS with the reason it is DOM-free.',
    );
});

test('the worker entry itself is not imported by the pipeline', () => {
    // The shell registers `self.onmessage`, so importing it from a module the
    // main thread loads would register a handler there too.
    const closure = workerClosure();
    const shell = resolve(ROOT, 'src/supports/autoSupport/autoPlace.worker.ts');
    const importers = [...closure]
        .filter(([file, source]) => file !== shell && /from\s*['"][^'"]*autoPlace\.worker['"]/.test(source))
        .map(([file]) => relative(ROOT, file).replace(/\\/g, '/'));
    assert.deepEqual(importers, [], 'only the client may reference the worker shell');
});
