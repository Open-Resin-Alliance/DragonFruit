/**
 * Preload for `npm run test:dom`: a DOM, and app code compiled the way Next
 * compiles it.
 *
 * - happy-dom is registered on `globalThis` before any test module loads, so
 *   React DOM finds `window` and `document` at import time.
 * - Every `.ts`/`.tsx` under `src/` and `plugins/` goes through the React
 *   Compiler and the Lingui macro before esbuild strips the types. The compiler
 *   is not optional: without it, mounting `page.tsx` loops on effects whose
 *   dependencies only the compiler keeps stable ("Maximum update depth
 *   exceeded"). The macro replaces `@lingui/core/macro` / `@lingui/react/macro`,
 *   which cannot be imported at runtime.
 * - CSS imports resolve to nothing.
 *
 * Compiling a file costs far more than loading it (importing `page.tsx` cold
 * is ~20 s over ~800 files, ~2 s cached), so the output is cached on disk,
 * keyed by the file's content, this file, and the versions of every tool
 * involved. A hit refreshes the entry's mtime; entries unused for
 * CACHE_MAX_IDLE_DAYS are pruned at startup, so the directory (and the CI cache
 * restored into it) does not grow with every edit. Delete
 * `node_modules/.cache/dragonfruit-dom-tests` to start cold.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import babel from '@babel/core';
import linguiMacro from '@lingui/babel-plugin-lingui-macro';
import esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPILED_DIRS = ['src', 'plugins'].map((dir) => path.join(ROOT, dir) + path.sep);
const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'dragonfruit-dom-tests');
const CACHE_MAX_IDLE_DAYS = 14;

GlobalRegistrator.register({ url: 'http://localhost:3005/' });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// The app leaves timers running (module-level polling, animation frames) that
// unmounting does not clear, and the test process would wait on them forever.
after(() => window.happyDOM.abort());

const require = createRequire(import.meta.url);
const toolVersions = ['@babel/core', 'babel-plugin-react-compiler', '@lingui/babel-plugin-lingui-macro', 'esbuild']
    .map((name) => `${name}@${JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', name, 'package.json'), 'utf8')).version}`);
const cacheSalt = createHash('sha256')
    .update(toolVersions.join('\n'))
    .update(fs.readFileSync(fileURLToPath(import.meta.url)))
    .update(fs.readFileSync(path.join(ROOT, 'lingui.config.ts')))
    .digest('hex');

function pruneIdleCacheEntries() {
    const cutoff = Date.now() - CACHE_MAX_IDLE_DAYS * 24 * 60 * 60 * 1000;
    let entries;
    try {
        entries = fs.readdirSync(CACHE_DIR);
    } catch {
        return; // No cache yet.
    }
    for (const entry of entries) {
        const file = path.join(CACHE_DIR, entry);
        try {
            if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file);
        } catch {
            // Another test process got there first.
        }
    }
}
pruneIdleCacheEntries();

function babelPass(filename, source, plugin) {
    return babel.transformSync(source, {
        filename,
        babelrc: false,
        configFile: false,
        sourceMaps: 'inline',
        inputSourceMap: true,
        parserOpts: { plugins: ['typescript', 'jsx'] },
        plugins: [plugin],
    }).code;
}

function compile(filename, source) {
    // Two passes, in Next's order: the compiler, then the Lingui macro. In one
    // pass the macro follows bindings the compiler has already rewritten and
    // throws "Unsupported macro usage".
    const compiled = babelPass(filename, source, require.resolve('babel-plugin-react-compiler'));
    const translated = babelPass(filename, compiled, linguiMacro);
    return esbuild.transformSync(translated, {
        loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
        format: 'cjs',
        jsx: 'automatic',
        target: 'node22',
        sourcefile: filename,
        sourcemap: 'inline',
    }).code;
}

function compileCached(filename, source) {
    const key = createHash('sha256').update(cacheSalt).update(path.relative(ROOT, filename)).update(source).digest('hex');
    const cached = path.join(CACHE_DIR, `${key}.js`);
    try {
        const code = fs.readFileSync(cached, 'utf8');
        const now = new Date();
        fs.utimesSync(cached, now, now);
        return code;
    } catch {
        // Not cached yet.
    }
    const code = compile(filename, source);
    // Test files run in parallel processes: write aside, then rename into place.
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const scratch = `${cached}.${process.pid}.tmp`;
    fs.writeFileSync(scratch, code);
    fs.renameSync(scratch, cached);
    return code;
}

function isAppSource(filename) {
    return !filename.includes(`${path.sep}node_modules${path.sep}`)
        && COMPILED_DIRS.some((dir) => filename.startsWith(dir));
}

// tsx loads `.ts`/`.tsx` through CommonJS extension handlers that read the
// file themselves, so a `module.registerHooks` load hook never sees them. Wrap
// the handlers instead; this file is preloaded after tsx, so `previous` is tsx's.
for (const ext of ['.ts', '.tsx']) {
    const previous = Module._extensions[ext];
    Module._extensions[ext] = function loadAppSource(module, filename) {
        if (!isAppSource(filename)) return previous.call(this, module, filename);
        module._compile(compileCached(filename, fs.readFileSync(filename, 'utf8')), filename);
    };
}
Module._extensions['.css'] = () => {};
