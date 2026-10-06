/**
 * Fails when a user-visible string literal sits in a `.tsx` file under i18n
 * control without going through Lingui (`<Trans>`, `msg`, `_()`), so it never
 * reaches the catalog and stays English in every locale.
 *
 * The repo still carries over a thousand unwrapped literals, so a full gate
 * would be permanently red. Like check-lint-clean.mjs, coverage grows one path
 * at a time: a directory (or a single file) is cleaned once, listed in
 * scripts/i18n-clean-dirs.json, and from then on CI refuses any literal inside it.
 *
 * What counts as a literal: JSX text (single- and multi-line), text-bearing
 * props (`title`, `label`, `aria-label`, `ariaLabel`, `placeholder`, `help`, …)
 * with a plain string value, and `label`/`hint`/`title`/`description` keys in
 * data arrays. Text inside `<Trans>` and template literals is skipped. It is a
 * heuristic: when a literal is deliberately not translatable (a unit, a brand,
 * a file extension), put `i18n-ignore` in a comment on that line or the line
 * above it.
 *
 * Usage:
 *   node scripts/check-i18n-literals.mjs              # check every listed path
 *   node scripts/check-i18n-literals.mjs <path>…      # check specific paths
 *   node scripts/check-i18n-literals.mjs --report [<path>…]  # list literals, by file
 *   node scripts/check-i18n-literals.mjs --suggest    # clean directories not yet listed
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.cwd();
const SRC_ROOT = path.join(projectRoot, 'src');
const CATALOG = path.join(projectRoot, 'src/locales/en.po');
const LIST_FILE = 'scripts/i18n-clean-dirs.json';

const TEXT_PROPS = [
      'title', 'label', 'ariaLabel', 'aria-label', 'placeholder', 'alt', 'help',
      'hint', 'subtitle', 'description', 'tooltip', 'heading', 'emptyText',
      'confirmLabel', 'cancelLabel', 'closeAriaLabel', 'summary', 'caption',
];
const PROP_RE = new RegExp(`\\b(${TEXT_PROPS.join('|')})="([^"]{2,})"`, 'g');
const DATA_RE = /\b(label|hint|title|description): (['"])((?:[^'"\\]|\\.){2,}?)\2/g;
const JSX_TEXT_RE = />([^<>{}\n]{2,})</g;
const JSX_MULTILINE_RE = />\s*\n\s*([A-Za-z][^<>{}]{1,240}?)\s*\n\s*<\//gs;

const TS_TYPES = new Set(['Promise', 'Array', 'Record', 'Readonly', 'Partial', 'Map', 'Set',
      'React', 'HTMLElement', 'HTMLDivElement', 'HTMLInputElement', 'Omit', 'Pick']);
const CODEY = /&&|\|\||=>|;\s*$|\breturn\b|\bconst\b|\bfunction\b|\bnew [A-Z]|\{|\}/;

/** Text a person would read, as opposed to code, identifiers, paths or CSS. */
function looksHuman(raw) {
      const text = raw.trim();
      if (text.length < 2 || text.startsWith('=')) return false;
      if (TS_TYPES.has(text.replace(/^[,\s]+/, ''))) return false;
      if (!/[A-Za-z]{2}/.test(text)) return false;
      if (CODEY.test(text)) return false;
      if (text.includes('(') || text.replace(/\.+$/, '').includes(')') || text.includes(' as ')) return false;
      if (/^[a-z0-9]+([-_.:/][a-z0-9]+)*$/.test(text)) return false;
      if (/^[A-Z0-9_]+$/.test(text)) return false;
      if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(text)) return false;
      if (/^(http|\/|\.\/|\.\.\/|#|data:|var\()/.test(text)) return false;
      if (/\.(tsx?|jsx?|css|png|svg|json|voxl|stl|ctb)$/.test(text)) return false;
      return true;
}

/** Every msgid in the source catalog, plus the forms JSX text takes before extraction. */
async function readCatalog() {
      const known = new Set();
      const text = await fs.readFile(CATALOG, 'utf8');
      for (const match of text.matchAll(/^msgid "(.*)"$/gm)) {
            const id = match[1];
            known.add(id);
            known.add(id.replace(/<\/?\d+>/g, ''));
            known.add(id.replace(/\{[^}]*\}/g, '').trim());
      }
      return known;
}

/** Blank a region out while keeping its newlines, so line numbers stay true. */
const blank = (match) => match.replace(/[^\n]/g, '');

function lineOf(text, index) {
      let line = 1;
      for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
      return line;
}

function scanFile(raw, known) {
      const rawLines = raw.split('\n');
      const ignored = (line) => /i18n-ignore/.test(rawLines[line - 1] ?? '') || /i18n-ignore/.test(rawLines[line - 2] ?? '');
      const source = raw
            .replace(/<Trans[\s>][\s\S]*?<\/Trans>/g, blank)
            .replace(/`[^`]*`/g, blank);
      const found = [];
      const keep = (line, kind, text) => {
            const value = text.trim().replace(/\s+/g, ' ');
            if (!looksHuman(value) || known.has(value) || ignored(line)) return;
            found.push({ line, kind, text: value });
      };

      source.split('\n').forEach((lineText, index) => {
            const line = index + 1;
            const trimmed = lineText.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
            for (const m of lineText.matchAll(PROP_RE)) keep(line, `prop:${m[1]}`, m[2]);
            for (const m of lineText.matchAll(JSX_TEXT_RE)) keep(line, 'jsx-text', m[1]);
            for (const m of lineText.matchAll(DATA_RE)) keep(line, `data:${m[1]}`, m[3].replace(/\\'/g, "'"));
      });
      for (const m of source.matchAll(JSX_MULTILINE_RE)) {
            keep(lineOf(source, m.index + m[0].indexOf(m[1])), 'jsx-multiline', m[1]);
      }

      const seen = new Set();
      return found.filter((f) => {
            const key = `${f.line}\0${f.text}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
      });
}

async function* walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) yield* walk(fullPath);
            else if (entry.name.endsWith('.tsx')) yield fullPath;
      }
}

const toPosix = (p) => p.split(path.sep).join('/');

/** Findings per `.tsx` file under `root` (a directory or a single file), sorted by path. */
async function scan(roots, known) {
      const byFile = new Map();
      for (const root of roots) {
            const absolute = path.join(projectRoot, root);
            const stats = await fs.stat(absolute);
            const files = stats.isDirectory() ? walk(absolute) : [absolute];
            for await (const filePath of files) {
                  const relative = toPosix(path.relative(projectRoot, filePath));
                  if (byFile.has(relative)) continue;
                  byFile.set(relative, scanFile(await fs.readFile(filePath, 'utf8'), known));
            }
      }
      return new Map([...byFile].sort(([a], [b]) => a.localeCompare(b)));
}

async function readList() {
      const parsed = JSON.parse(await fs.readFile(path.join(projectRoot, LIST_FILE), 'utf8'));
      if (!Array.isArray(parsed.paths)) throw new Error(`${LIST_FILE} has no "paths" array.`);
      return parsed.paths;
}

/** A renamed or deleted path must fail loudly — silently losing coverage is the failure mode this check exists to prevent. */
async function missingPaths(paths) {
      const missing = [];
      for (const listed of paths) {
            try {
                  const stats = await fs.stat(path.join(projectRoot, listed));
                  if (!stats.isDirectory() && !listed.endsWith('.tsx')) missing.push(listed);
            } catch {
                  missing.push(listed);
            }
      }
      return missing;
}

/** Directories whose every `.tsx` is clean and that no listed path covers yet — the highest such level only. */
function suggest(byFile, listed) {
      const dirty = new Set();
      const hasTsx = new Set();
      for (const [file, findings] of byFile) {
            for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
                  hasTsx.add(dir);
                  if (findings.length > 0) dirty.add(dir);
            }
      }
      const isCovered = (dir) => listed.some((entry) => dir === entry || dir.startsWith(`${entry}/`));
      const clean = [...hasTsx].filter((dir) => !dirty.has(dir) && !isCovered(dir));
      return clean.filter((dir) => !clean.includes(path.posix.dirname(dir))).sort();
}

async function main() {
      const args = process.argv.slice(2);
      const flags = new Set(args.filter((arg) => arg.startsWith('--')));
      const explicit = args.filter((arg) => !arg.startsWith('--')).map((arg) => toPosix(arg).replace(/\/+$/, ''));
      const known = await readCatalog();

      if (flags.has('--suggest')) {
            const listed = await readList();
            const candidates = suggest(await scan(['src'], known), listed);
            if (candidates.length === 0) {
                  console.log('[i18n-clean] No clean directory left outside the list.');
                  return;
            }
            console.log(`[i18n-clean] ${candidates.length} clean director${candidates.length === 1 ? 'y' : 'ies'} not yet in ${LIST_FILE}:`);
            for (const dir of candidates) console.log(`  ${dir}`);
            return;
      }

      if (flags.has('--report')) {
            for (const [file, findings] of await scan(explicit.length > 0 ? explicit : ['src'], known)) {
                  if (findings.length === 0) continue;
                  console.log(`\n${file} — ${findings.length}`);
                  for (const { line, kind, text } of findings) console.log(`  L${line} ${kind}: ${text}`);
            }
            return;
      }

      const paths = explicit.length > 0 ? explicit : await readList();
      const missing = await missingPaths(paths);
      if (missing.length > 0) {
            console.error(`[i18n-clean] Listed path(s) no longer exist — follow the rename in ${LIST_FILE}:`);
            for (const entry of missing) console.error(`  ${entry}`);
            process.exit(1);
      }

      const byFile = await scan(paths, known);
      const violations = [...byFile].flatMap(([file, findings]) => findings.map((finding) => ({ file, ...finding })));
      if (violations.length > 0) {
            console.error(`[i18n-clean] ${violations.length} unwrapped UI literal(s) under i18n control. Wrap them with <Trans>, msg or _() so they reach the catalog:`);
            for (const { file, line, kind, text } of violations) console.error(`  ${file}:${line}  ${kind}  ${JSON.stringify(text)}`);
            console.error('Deliberately untranslatable text (a unit, a brand) takes an `i18n-ignore` comment on its line or the line above.');
            process.exit(1);
      }
      console.log(`[i18n-clean] OK: ${paths.length} path(s), ${byFile.size} file(s), no unwrapped literals.`);
}

main().catch((error) => {
      console.error(error);
      process.exit(1);
});
