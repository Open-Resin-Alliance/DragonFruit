/**
 * Fails when the React Compiler skips a component or hook that it did not skip
 * before.
 *
 * A skipped function gets no automatic memoisation: its hand-written dependency
 * lists are taken literally, and a missing dependency is a stale closure (#941).
 * The compiler skips silently, so one `try…finally`, dynamic `import()` or
 * disabled react-hooks rule can take a whole component out of compilation with
 * nothing in the build or the lint to say so.
 *
 * This runs the compiler over `src` with the options Next gives it
 * (`reactCompiler: true`, i.e. the defaults) and compares the functions it skips
 * with scripts/compiler-skips.json. Like check-lint-clean.mjs it is a ratchet:
 *   - a skipped function missing from the list fails (new debt);
 *   - a listed function that now compiles, or no longer exists, also fails, so
 *     the entry is removed and the slot cannot be quietly refilled later.
 * Functions are keyed by file and name, not line, so edits elsewhere in a file
 * don't move them. Anonymous functions are `<anonymous>`.
 *
 * Usage:
 *   node scripts/check-compiler-skips.mjs            # check against the list
 *   node scripts/check-compiler-skips.mjs --report   # every skip, with its reason
 *   node scripts/check-compiler-skips.mjs --write    # rewrite the list from the current state
 *
 * `--write` is for removing entries after a fix. Adding one means accepting a
 * component without memoisation; say why in the PR.
 */
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const babel = require('@babel/core');
const compilerPlugin = require.resolve('babel-plugin-react-compiler');

const projectRoot = process.cwd();
const SRC_ROOT = path.join(projectRoot, 'src');
const LIST_FILE = 'scripts/compiler-skips.json';
const LIST_COMMENT =
      'Components and hooks the React Compiler skips, by file. Checked by scripts/check-compiler-skips.mjs; only ever shrink it.';

/** Event kinds that mean the compiler left a function as written. */
const SKIP_EVENTS = new Set(['CompileError', 'CompileSkip', 'PipelineError']);

function isSourceFile(relative) {
      if (!/\.(ts|tsx)$/.test(relative) || relative.endsWith('.d.ts')) return false;
      if (/(^|\/)__tests__\//.test(relative)) return false;
      return !/\.(test|dom-test)\.(ts|tsx)$/.test(relative);
}

async function listSourceFiles(dir) {
      const out = [];
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) out.push(...await listSourceFiles(full));
            else {
                  const relative = path.relative(projectRoot, full).split(path.sep).join('/');
                  if (isSourceFile(relative)) out.push(relative);
            }
      }
      return out;
}

function parserPlugins(file) {
      // `jsx` in a .ts file misreads `<T>(x) => …` generics and `<T>value` casts.
      return file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'];
}

/** The name a reader would look for: declaration, binding, key, or the binding a wrapper call is assigned to. */
function functionName(fnPath) {
      const node = fnPath.node;
      if (node.id?.name) return node.id.name;
      if ((node.type === 'ObjectMethod' || node.type === 'ClassMethod') && node.key.type === 'Identifier') {
            return node.key.name;
      }
      let parent = fnPath.parentPath;
      // memo(forwardRef(() => …)), React.memo(…), useCallback(…) inside a binding.
      while (parent?.isCallExpression()) parent = parent.parentPath;
      if (parent?.isVariableDeclarator() && parent.node.id.type === 'Identifier') return parent.node.id.name;
      if ((parent?.isObjectProperty() || parent?.isClassProperty()) && parent.node.key.type === 'Identifier') {
            return parent.node.key.name;
      }
      if (parent?.isExportDefaultDeclaration()) return 'default';
      return '<anonymous>';
}

const locKey = (loc) => (loc ? `${loc.start.line}:${loc.start.column}` : null);

/** Map function and function-body start positions to names; skip events carry one or the other. */
function functionsByLocation(code, file) {
      const ast = babel.parseSync(code, {
            filename: file,
            babelrc: false,
            configFile: false,
            parserOpts: { plugins: parserPlugins(file) },
      });
      const byLoc = new Map();
      babel.traverse(ast, {
            Function(fnPath) {
                  const name = functionName(fnPath);
                  const fnKey = locKey(fnPath.node.loc);
                  const bodyKey = locKey(fnPath.node.body.loc);
                  if (fnKey) byLoc.set(fnKey, name);
                  if (bodyKey) byLoc.set(bodyKey, name);
            },
      });
      return byLoc;
}

function eventReason(event) {
      // 1.0.0 interpolates the directive node itself: "Skipped due to '[object Object]' directive."
      if (event.kind === 'CompileSkip') return "Opted out with a 'use no memo' directive";
      if (event.reason) return event.reason;
      const detail = event.detail ?? {};
      return detail.reason ?? detail.options?.reason ?? detail.description ?? event.data ?? 'unknown';
}

/** Every function the compiler skips in one file, as { name, line, reasons }. */
function skippedFunctions(code, file) {
      const events = [];
      babel.transformSync(code, {
            filename: file,
            babelrc: false,
            configFile: false,
            code: false,
            parserOpts: { plugins: parserPlugins(file) },
            plugins: [[compilerPlugin, { logger: { logEvent: (_filename, event) => events.push(event) } }]],
      });
      const skipEvents = events.filter((event) => SKIP_EVENTS.has(event.kind));
      if (skipEvents.length === 0) return [];

      const names = functionsByLocation(code, file);
      const byFunction = new Map();
      for (const event of skipEvents) {
            const key = locKey(event.fnLoc) ?? `?:${byFunction.size}`;
            const entry = byFunction.get(key) ?? {
                  name: names.get(key) ?? `<line ${event.fnLoc?.start.line ?? '?'}>`,
                  line: event.fnLoc?.start.line ?? null,
                  reasons: new Set(),
            };
            entry.reasons.add(String(eventReason(event)).split('\n')[0].slice(0, 160));
            byFunction.set(key, entry);
      }
      return [...byFunction.values()];
}

async function collect() {
      const files = await listSourceFiles(SRC_ROOT);
      const result = new Map();
      for (const file of files.sort()) {
            const code = await fs.readFile(path.join(projectRoot, file), 'utf8');
            let skipped;
            try {
                  skipped = skippedFunctions(code, file);
            } catch (error) {
                  throw new Error(`${file}: ${error.message.split('\n')[0]}`);
            }
            if (skipped.length > 0) result.set(file, skipped);
      }
      return { fileCount: files.length, result };
}

async function readList() {
      try {
            const parsed = JSON.parse(await fs.readFile(path.join(projectRoot, LIST_FILE), 'utf8'));
            return parsed.files ?? {};
      } catch (error) {
            if (error.code === 'ENOENT') return {};
            throw error;
      }
}

/** Names in `a` beyond those in `b`, counting duplicates. */
function multisetMinus(a, b) {
      const remaining = new Map();
      for (const name of b) remaining.set(name, (remaining.get(name) ?? 0) + 1);
      const extra = [];
      for (const name of a) {
            const left = remaining.get(name) ?? 0;
            if (left > 0) remaining.set(name, left - 1);
            else extra.push(name);
      }
      return extra;
}

async function main() {
      const args = new Set(process.argv.slice(2));
      const { fileCount, result } = await collect();
      const total = [...result.values()].reduce((sum, list) => sum + list.length, 0);

      if (args.has('--report')) {
            for (const [file, list] of result) {
                  for (const fn of list) {
                        console.log(`${file}:${fn.line ?? '?'} ${fn.name} — ${[...fn.reasons].join(' / ')}`);
                  }
            }
            console.log(`[compiler-skips] ${total} skipped functions in ${result.size} of ${fileCount} files.`);
            return;
      }

      if (args.has('--write')) {
            const files = {};
            for (const [file, list] of result) files[file] = list.map((fn) => fn.name).sort();
            await fs.writeFile(
                  path.join(projectRoot, LIST_FILE),
                  `${JSON.stringify({ comment: LIST_COMMENT, files }, null, 2)}\n`,
            );
            console.log(`[compiler-skips] Wrote ${total} skipped functions in ${result.size} files to ${LIST_FILE}.`);
            return;
      }

      const listed = await readList();
      const added = [];
      const stale = [];
      for (const [file, list] of result) {
            const extra = multisetMinus(list.map((fn) => fn.name), listed[file] ?? []);
            for (const name of extra) {
                  const fn = list.find((candidate) => candidate.name === name);
                  added.push(`  ${file}:${fn.line ?? '?'} ${name} — ${[...fn.reasons].join(' / ')}`);
            }
      }
      for (const [file, names] of Object.entries(listed)) {
            const current = (result.get(file) ?? []).map((fn) => fn.name);
            for (const name of multisetMinus(names, current)) stale.push(`  ${file} ${name}`);
      }

      if (added.length > 0) {
            console.error('[compiler-skips] The React Compiler now skips these, so their memoisation is gone:');
            console.error(added.join('\n'));
            console.error('Fix the construct named after each one. If a skip is truly unavoidable, run');
            console.error(`\`node scripts/check-compiler-skips.mjs --write\` and say why in the PR.`);
      }
      if (stale.length > 0) {
            console.error('[compiler-skips] These are listed but now compile (or are gone). Take them off the list:');
            console.error(stale.join('\n'));
            console.error(`Run \`node scripts/check-compiler-skips.mjs --write\` to update ${LIST_FILE}.`);
      }
      if (added.length > 0 || stale.length > 0) {
            process.exitCode = 1;
            return;
      }
      console.log(`[compiler-skips] OK: ${total} skipped functions, all listed (${fileCount} files checked).`);
}

main().catch((error) => {
      console.error(`[compiler-skips] ${error.message}`);
      process.exitCode = 1;
});
