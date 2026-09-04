/**
 * Verifies that documentation still matches the code it describes.
 *
 * Docs rot silently: a path moves, a symbol is renamed, a line number drifts,
 * and the page keeps reading as authoritative. AGENTS.md tells agents to trust
 * these pages over the source, so a stale claim is an active hazard rather than
 * a cosmetic defect. This check is what makes that instruction safe to give.
 *
 * Checks, per doc file:
 *   1. repo paths cited (`src/…`, `rust/…`, …) exist on disk
 *   2. no pinned line numbers (`main.rs:4215`) — they drift within a week
 *   3. backticked code symbols appear somewhere in the codebase
 *   4. relative links to other .md files resolve
 * Plus, once: the MkDocs nav lists every published page and nothing missing.
 *
 * Usage:
 *   node scripts/check-docs-accuracy.mjs            # the repo's own docs
 *   node scripts/check-docs-accuracy.mjs <dir>…     # audit an external doc set
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();

const DEFAULT_DOC_FILES = ['AGENTS.md', 'CONTEXT.md', 'README.md', 'LOCALE.md'];
const DEFAULT_DOC_DIRS = ['docs'];

const CODE_ROOTS = ['src', 'src-tauri', 'rust', 'plugins', 'scripts', 'profiles', '.github'];
// Root-level config is cited by docs as often as anything under src/.
const CODE_FILES = [
      'package.json', 'next.config.ts', 'tsconfig.json', 'eslint.config.mjs',
      'lingui.config.ts', 'mkdocs.yml', 'crowdin.yml', 'rust-toolchain.toml',
];
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.rs', '.mjs', '.js', '.json', '.toml', '.yml', '.yaml', '.css']);

// A repo-relative path: starts at a known root, has a file extension or a trailing slash.
const REPO_PATH_RE = new RegExp(`^(?:${CODE_ROOTS.join('|')})/[A-Za-z0-9_./-]+$`);
// `file.rs:1234` — a pinned line number.
const PINNED_LINE_RE = /^[A-Za-z0-9_./-]+\.[a-z]{1,4}:\d+$/;
// An identifier that is plausibly a code symbol rather than prose.
const SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const MIN_SYMBOL_LENGTH = 7;

async function* walk(dir) {
      let entries;
      try {
            entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
            return;
      }
      for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.name === 'node_modules' || entry.name === 'target' || entry.name === '.git') continue;
            if (entry.isDirectory()) {
                  yield* walk(fullPath);
                  continue;
            }
            yield fullPath;
      }
}

async function loadAllowlist() {
      try {
            const raw = await fs.readFile(path.join(projectRoot, 'scripts/docs-accuracy-allowlist.json'), 'utf8');
            const parsed = JSON.parse(raw);
            return {
                  symbols: new Set(parsed.symbols ?? []),
                  paths: new Set(parsed.paths ?? []),
            };
      } catch {
            return { symbols: new Set(), paths: new Set() };
      }
}

/** Everything the codebase says, as one blob, plus the set of tracked paths. */
async function loadCodebase() {
      const blob = [];
      const paths = new Set();
      for (const root of CODE_ROOTS) {
            for await (const filePath of walk(path.join(projectRoot, root))) {
                  const relativePath = path.relative(projectRoot, filePath);
                  paths.add(relativePath);
                  if (!CODE_EXTENSIONS.has(path.extname(filePath))) continue;
                  try {
                        blob.push(await fs.readFile(filePath, 'utf8'));
                  } catch {
                        // unreadable (binary, permissions) — its path still counts
                  }
            }
      }
      for (const file of CODE_FILES) {
            paths.add(file);
            try {
                  blob.push(await fs.readFile(path.join(projectRoot, file), 'utf8'));
            } catch {
                  // absent in an external doc-set audit
            }
      }
      // A doc may name a file rather than an identifier (`potentialFieldSolver`
      // is a test file, not a symbol inside one), so basenames count too.
      for (const filePath of paths) {
            const base = path.basename(filePath).split('.')[0];
            if (base) blob.push(base);
      }
      return { text: blob.join('\n'), paths };
}

/** Plugin submodules that are not checked out would make every symbol in them look missing. */
async function uncheckedOutSubmodules() {
      const missing = [];
      let entries;
      try {
            entries = await fs.readdir(path.join(projectRoot, 'plugins'), { withFileTypes: true });
      } catch {
            return missing;
      }
      for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const contents = await fs.readdir(path.join(projectRoot, 'plugins', entry.name));
            if (contents.length === 0) missing.push(`plugins/${entry.name}`);
      }
      return missing;
}

function citedTokens(markdown) {
      // Backticked spans, and the targets of markdown links.
      const tokens = [];
      for (const match of markdown.matchAll(/`([^`\n]+)`/g)) tokens.push(match[1].trim());
      for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) tokens.push(match[1].trim());
      return tokens;
}

function classify(token) {
      // Schematic spans — `plugins/<vendor>/…`, `createTypedHistory<Map>()`, globs —
      // are illustrative by design and name nothing in particular.
      if (/[<*{]|\.\.\.|…/.test(token)) return null;
      const bare = token
            .replace(/^\.\//, '')
            .replace(/#.*$/, '')
            .replace(/\(.*$/, '')       // `fn(args)` → `fn`
            .replace(/[[\]{}]/g, '')
            .trim();
      if (!bare || bare.includes(' ')) return null;
      if (PINNED_LINE_RE.test(bare)) return { kind: 'pinned-line', value: bare };
      if (bare.includes('*')) return null;                     // globs are illustrative
      if (REPO_PATH_RE.test(bare) && path.extname(bare)) return { kind: 'path', value: bare };
      if (bare.length < MIN_SYMBOL_LENGTH) return null;
      if (!SYMBOL_RE.test(bare)) return null;
      const looksLikeCode = bare.includes('_') || /[a-z][A-Z]/.test(bare);
      return looksLikeCode ? { kind: 'symbol', value: bare } : null;
}

async function checkNav(problems) {
      let config;
      try {
            config = await fs.readFile(path.join(projectRoot, 'mkdocs.yml'), 'utf8');
      } catch {
            return;
      }
      const navSection = config.split('\nnav:')[1];
      if (!navSection) return;

      const listed = new Set([...navSection.matchAll(/:\s*([A-Za-z0-9_\-./]+\.md)\s*$/gm)].map((m) => m[1]));
      const excluded = [...(config.match(/exclude_docs:\s*\|([\s\S]*?)\n\S/) ?? [null, ''])[1].matchAll(/\s*(\S+)/g)]
            .map((m) => m[1]);

      for (const entry of listed) {
            try {
                  await fs.access(path.join(projectRoot, 'docs', entry));
            } catch {
                  problems.push({ file: 'mkdocs.yml', kind: 'nav-missing', value: entry });
            }
      }

      for await (const filePath of walk(path.join(projectRoot, 'docs'))) {
            if (path.extname(filePath) !== '.md') continue;
            const relativePath = path.relative(path.join(projectRoot, 'docs'), filePath);
            const posixPath = relativePath.split(path.sep).join('/');
            if (excluded.some((rule) => posixPath === rule || posixPath.startsWith(rule.replace(/\/$/, '') + '/'))) continue;
            if (!listed.has(posixPath)) {
                  problems.push({ file: `docs/${relativePath}`, kind: 'nav-orphan', value: relativePath });
            }
      }
}

async function main() {
      const args = process.argv.slice(2);
      const allowlist = await loadAllowlist();
      const codebase = await loadCodebase();
      const submodules = await uncheckedOutSubmodules();
      const skipSymbols = submodules.length > 0;
      const problems = [];

      const docFiles = [];
      if (args.length > 0) {
            for (const arg of args) {
                  for await (const filePath of walk(path.resolve(arg))) {
                        if (path.extname(filePath) === '.md') docFiles.push(filePath);
                  }
            }
      } else {
            for (const dir of DEFAULT_DOC_DIRS) {
                  for await (const filePath of walk(path.join(projectRoot, dir))) {
                        if (path.extname(filePath) === '.md') docFiles.push(filePath);
                  }
            }
            for (const file of DEFAULT_DOC_FILES) docFiles.push(path.join(projectRoot, file));
      }

      for (const filePath of docFiles) {
            let markdown;
            try {
                  markdown = await fs.readFile(filePath, 'utf8');
            } catch {
                  continue;
            }
            const relativePath = path.relative(projectRoot, filePath);

            for (const token of citedTokens(markdown)) {
                  const cited = classify(token);
                  if (!cited) continue;

                  if (cited.kind === 'pinned-line') {
                        problems.push({ file: relativePath, ...cited });
                  } else if (cited.kind === 'path') {
                        if (allowlist.paths.has(cited.value)) continue;
                        if (!codebase.paths.has(path.normalize(cited.value))) {
                              problems.push({ file: relativePath, ...cited });
                        }
                  } else if (cited.kind === 'symbol') {
                        if (skipSymbols) continue;
                        if (allowlist.symbols.has(cited.value)) continue;
                        if (!codebase.text.includes(cited.value)) {
                              problems.push({ file: relativePath, ...cited });
                        }
                  }
              }

            for (const match of markdown.matchAll(/\]\((\.{0,2}\/?[A-Za-z0-9_\-./]+\.md)(?:#[^)]*)?\)/g)) {
                  const target = path.resolve(path.dirname(filePath), match[1]);
                  try {
                        await fs.access(target);
                  } catch {
                        problems.push({ file: relativePath, kind: 'dead-link', value: match[1] });
                  }
            }
      }

      if (args.length === 0) await checkNav(problems);

      if (skipSymbols) {
            console.warn(`[docs-accuracy] WARNING: ${submodules.length} plugin submodule(s) not checked out, so symbols they define would look missing.`);
            console.warn('  Symbol verification was SKIPPED. Paths, links, line numbers and nav were still checked.');
            console.warn('  Run `git submodule update --init` for a complete check.\n');
      }

      if (problems.length === 0) {
            console.log(`[docs-accuracy] OK: ${docFiles.length} documents match the codebase.`);
            return;
      }

      const EXPLANATION = {
            'pinned-line': 'pinned line number (drifts — name the symbol instead)',
            path: 'cited path does not exist',
            symbol: 'cited symbol is nowhere in the codebase',
            'dead-link': 'link target does not exist',
            'nav-missing': 'nav entry has no file',
            'nav-orphan': 'published page missing from the nav',
      };

      console.error(`[docs-accuracy] ${problems.length} problem(s) across ${new Set(problems.map((p) => p.file)).size} file(s):`);
      let lastFile = null;
      for (const problem of problems.sort((a, b) => a.file.localeCompare(b.file))) {
            if (problem.file !== lastFile) {
                  console.error(`\n  ${problem.file}`);
                  lastFile = problem.file;
            }
            console.error(`    ${problem.value}  — ${EXPLANATION[problem.kind]}`);
      }
      console.error('\nFix the doc, or add a deliberate exception to scripts/docs-accuracy-allowlist.json.');
      process.exit(1);
}

main().catch((error) => {
      console.error('[docs-accuracy] Failed to run check:', error);
      process.exit(1);
});
