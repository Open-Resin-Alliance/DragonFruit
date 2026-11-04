/**
 * The documentation viewer's build-time data layer.
 *
 * The Markdown under `docs/` is the documentation. A deployed site can be built
 * from `dev` while its default documentation comes from `main`, so this module
 * reads one or more snapshots prepared by `scripts/prepare-docs-versions.mjs`
 * (`website/.docs-versions/<id>/`) and renders every version through the same
 * pipeline. A snapshot from before this viewer existed is valid: the nav falls
 * back to that ref's `mkdocs.yml`.
 *
 * Nothing here is imported by the browser: `renderDoc()` runs while the page is
 * built, and `buildSearchIndex()` is what the search endpoint serialises.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Slugger from 'github-slugger';
import { markdownToHtml, type HastPluginDefinition } from 'satteri';
import { parse as parseYaml } from 'yaml';
import { satteriCreateHighlightFn, satteriHighlightPlugin } from '@astrojs/markdown-satteri';
import localNav from '../data/docs-nav.json';

const WEBSITE_ROOT =
  [process.cwd(), path.resolve(process.cwd(), 'website')].find((candidate) =>
    fs.existsSync(path.join(candidate, 'astro.config.mjs')),
  ) ?? process.cwd();
const REPO_ROOT = path.dirname(WEBSITE_ROOT);
const LOCAL_DOCS_DIR = path.join(REPO_ROOT, 'docs');
const VERSIONS_DIR = path.join(WEBSITE_ROOT, '.docs-versions');
const MANIFEST_FILE = path.join(VERSIONS_DIR, 'manifest.json');
const DOCS_PREFIX = '/docs';

export interface NavItem {
  label: string;
  slug?: string;
  href?: string;
  items?: NavItem[];
}

interface NavFile {
  exclude?: string[];
  items: NavItem[];
}

interface ManifestVersion {
  id: string;
  label: string;
  version?: string;
  root: string;
  exclude?: string[];
  ref?: string;
}

interface Manifest {
  default: string;
  exclude?: string[];
  versions: ManifestVersion[];
}

export interface DocsNavNode {
  label: string;
  slug?: string;
  url?: string;
  children?: DocsNavNode[];
}

export interface DocsHeading {
  depth: number;
  slug: string;
  text: string;
}

export interface DocsVersion {
  id: string;
  label: string;
  /** The branch's release number, when it has one; dev is rolling and does not. */
  version?: string;
  default: boolean;
  /** `/docs` for the default version, `/docs/versions/<id>` otherwise. */
  prefix: string;
  root: string;
  exclude: string[];
  items: NavItem[];
  nav: DocsNavNode[];
}

export interface DocsVersionInfo {
  id: string;
  label: string;
  version?: string;
  default: boolean;
  prefix: string;
  homeUrl: string;
}

export interface DocsVersionLink extends DocsVersionInfo {
  url: string;
  current: boolean;
}

export interface DocsPageMeta {
  versionId: string;
  slug: string;
  file: string;
  url: string;
  label: string;
  /** Group labels between the documentation root and this page. */
  trail: string[];
  prev?: { label: string; url: string };
  next?: { label: string; url: string };
}

export interface DocsPage extends DocsPageMeta {
  title: string;
  description: string;
  html: string;
  headings: DocsHeading[];
  toc: DocsHeading[];
  version: DocsVersionInfo;
  versions: DocsVersionLink[];
  searchIndexUrl: string;
  noindex: boolean;
}

export interface DocsIndex {
  versions: DocsVersion[];
  defaultVersion: DocsVersion;
  pages: DocsPageMeta[];
  byKey: Map<string, DocsPageMeta>;
}

export class DocsBuildError extends Error {
  constructor(file: string, message: string) {
    super(`${path.relative(REPO_ROOT, file)}: ${message}`);
    this.name = 'DocsBuildError';
  }
}

const versionKey = (versionId: string, slug: string) => `${versionId}\u0000${slug}`;

/** `/docs/` for the index, `/docs/foo/bar/` for a page, `/docs/foo/` for its index. */
export function docsUrl(version: Pick<DocsVersion, 'prefix'>, slug: string): string {
  if (slug === 'index') return `${version.prefix}/`;
  if (slug.endsWith('/index')) return `${version.prefix}/${slug.slice(0, -'/index'.length)}/`;
  return `${version.prefix}/${slug}/`;
}

/** Every Markdown file a version publishes, as absolute paths. */
function collectDocFiles(root: string, excluded: Set<string>): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  };
  walk(root);
  return files;
}

function buildNav(items: NavItem[], version: Pick<DocsVersion, 'prefix'>): DocsNavNode[] {
  const nodes: DocsNavNode[] = [];
  for (const item of items) {
    if (item.slug) {
      nodes.push({ label: item.label, slug: item.slug, url: docsUrl(version, item.slug) });
      continue;
    }
    if (item.href) continue;
    nodes.push({ label: item.label, children: buildNav(item.items ?? [], version) });
  }
  return nodes;
}

/** Whether a group in the sidebar contains the page currently being read. */
export function navContainsSlug(node: DocsNavNode, slug: string): boolean {
  if (node.slug === slug) return true;
  return node.children?.some((child) => navContainsSlug(child, slug)) ?? false;
}

function flattenNav(items: NavItem[], version: DocsVersion, trail: string[] = []): DocsPageMeta[] {
  const pages: DocsPageMeta[] = [];
  for (const item of items) {
    if (item.slug) {
      pages.push({
        versionId: version.id,
        slug: item.slug,
        file: path.join(version.root, `${item.slug}.md`),
        url: docsUrl(version, item.slug),
        label: item.label,
        trail,
      });
      continue;
    }
    pages.push(...flattenNav(item.items ?? [], version, [...trail, item.label]));
  }
  return pages;
}

function mkdocsNav(value: unknown): NavItem[] {
  if (!Array.isArray(value)) return [];
  const items: NavItem[] = [];

  for (const entry of value) {
    if (typeof entry === 'string') {
      const slug = entry.replace(/\.md$/, '');
      items.push({ label: path.posix.basename(slug), slug });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;

    for (const [label, target] of Object.entries(entry)) {
      if (typeof target === 'string') {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) items.push({ label, href: target });
        else items.push({ label, slug: target.replace(/^\.?\//, '').replace(/\.md$/, '') });
        continue;
      }
      if (Array.isArray(target)) items.push({ label, items: mkdocsNav(target) });
    }
  }

  return items;
}

function mkdocsExclude(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  return values
    .map((entry) => String(entry).trim().replace(/\/$/, ''))
    .filter((entry) => entry !== '' && !entry.startsWith('#'));
}

/**
 * A snapshot's nav. The current branch has `docs-nav.json`; an older ref has
 * `mkdocs.yml`, and that is all the viewer needs from it.
 */
function readNav(sourceRoot: string): { items: NavItem[]; exclude: string[] } {
  const navFile = path.join(sourceRoot, 'website/src/data/docs-nav.json');
  if (fs.existsSync(navFile)) {
    const nav = JSON.parse(fs.readFileSync(navFile, 'utf8')) as NavFile;
    return { items: nav.items, exclude: nav.exclude ?? ['internal'] };
  }

  const mkdocsFile = path.join(sourceRoot, 'mkdocs.yml');
  if (fs.existsSync(mkdocsFile)) {
    const config = parseYaml(fs.readFileSync(mkdocsFile, 'utf8')) as {
      nav?: unknown;
      exclude_docs?: unknown;
    };
    const exclude = mkdocsExclude(config.exclude_docs);
    return { items: mkdocsNav(config.nav), exclude: exclude.length > 0 ? exclude : ['internal'] };
  }

  throw new Error(`${sourceRoot} has neither website/src/data/docs-nav.json nor mkdocs.yml`);
}

function loadVersions(): { versions: DocsVersion[]; defaultVersion: DocsVersion } {
  let versions: DocsVersion[];

  if (fs.existsSync(MANIFEST_FILE)) {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')) as Manifest;
    versions = manifest.versions.map((entry) => {
      const sourceRoot = path.join(VERSIONS_DIR, entry.root);
      const nav = readNav(sourceRoot);
      const isDefault = entry.id === manifest.default;
      return {
        id: entry.id,
        label: entry.label,
        version: entry.version,
        default: isDefault,
        prefix: isDefault ? DOCS_PREFIX : `${DOCS_PREFIX}/versions/${entry.id}`,
        root: path.join(sourceRoot, 'docs'),
        exclude: entry.exclude ?? manifest.exclude ?? nav.exclude,
        items: nav.items,
        nav: [],
      };
    });
  } else {
    const nav = localNav as NavFile;
    versions = [
      {
        id: 'current',
        label: 'Current',
        default: true,
        prefix: DOCS_PREFIX,
        root: LOCAL_DOCS_DIR,
        exclude: nav.exclude ?? ['internal'],
        items: nav.items,
        nav: [],
      },
    ];
  }

  for (const version of versions) version.nav = buildNav(version.items, version);

  const defaultVersion = versions.find((version) => version.default) ?? versions[0];
  if (!defaultVersion) throw new Error('No documentation versions were prepared');
  return { versions, defaultVersion };
}

function buildIndex(): DocsIndex {
  const { versions, defaultVersion } = loadVersions();
  const pages: DocsPageMeta[] = [];
  const byKey = new Map<string, DocsPageMeta>();

  for (const version of versions) {
    const versionPages = flattenNav(version.items, version);
    const listed = new Set(versionPages.map((page) => page.slug));
    const excluded = new Set(version.exclude);

    for (const page of versionPages) {
      if (!fs.existsSync(page.file)) {
        throw new DocsBuildError(page.file, `"${page.label}" is listed in the nav but the page does not exist`);
      }
    }

    for (const file of collectDocFiles(version.root, excluded)) {
      const slug = path.relative(version.root, file).split(path.sep).join('/').replace(/\.md$/, '');
      if (!listed.has(slug)) {
        throw new DocsBuildError(file, `page is not listed in the ${version.label} documentation nav`);
      }
    }

    versionPages.forEach((page, index) => {
      const prev = versionPages[index - 1];
      const next = versionPages[index + 1];
      if (prev) page.prev = { label: prev.label, url: prev.url };
      if (next) page.next = { label: next.label, url: next.url };
      pages.push(page);
      byKey.set(versionKey(version.id, page.slug), page);
    });
  }

  return { versions, defaultVersion, pages, byKey };
}

let indexCache: DocsIndex | undefined;
let pageCache: Map<string, DocsPage> | undefined;

export function loadDocsIndex(): DocsIndex {
  /* A nav entry added in dev should not need a server restart; a production build
     reads the snapshots once and renders every page against that index. */
  if (process.env.NODE_ENV !== 'production') return buildIndex();
  indexCache ??= buildIndex();
  return indexCache;
}

const DEFAULT_ADMONITION_TITLES: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  hint: 'Hint',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
  attention: 'Attention',
  danger: 'Danger',
  error: 'Error',
  info: 'Info',
  example: 'Example',
  quote: 'Quote',
  abstract: 'Abstract',
  summary: 'Summary',
  success: 'Success',
  failure: 'Failure',
  bug: 'Bug',
  question: 'Question',
};

/**
 * MkDocs admonitions are not Markdown. A `!!! note "Title"` line followed by an
 * indented body becomes an HTML block with a title paragraph and the body left as
 * Markdown, which is exactly what the renderer needs when `rawHtml` reparses the
 * block: the body is still parsed, including fences and lists.
 */
function preprocessAdmonitions(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const output: string[] = [];
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = /^(\s*)(```+|~~~+)/.exec(line);

    if (fenceMatch) {
      const marker = fenceMatch[2][0];
      fence = fence === null ? marker : fence === marker ? null : fence;
      output.push(line);
      continue;
    }

    if (fence !== null) {
      output.push(line);
      continue;
    }

    /* GitHub alerts (`> [!NOTE]` and the other four types) render the same way, so a
       page reads correctly both on GitHub and on this site. */
    const alert = /^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(line);
    if (alert) {
      const type = alert[1].toLowerCase();
      const body: string[] = [];
      while (index + 1 < lines.length && /^\s*>/.test(lines[index + 1])) {
        index += 1;
        body.push(lines[index].replace(/^\s*> ?/, ''));
      }
      if (output.length > 0 && output[output.length - 1].trim() !== '') output.push('');
      output.push(`<div class="admonition admonition--${type}">`);
      output.push(`<p class="admonition-title">${DEFAULT_ADMONITION_TITLES[type]}</p>`);
      output.push('', ...body, '', '</div>', '');
      continue;
    }

    const marker = /^(\s*)!!!\s*([A-Za-z0-9_-]+)(?:\s+"([^"]*)")?\s*$/.exec(line);
    if (!marker) {
      output.push(line);
      continue;
    }

    const indent = marker[1].length;
    const type = marker[2].toLowerCase();
    const title = marker[3] ?? DEFAULT_ADMONITION_TITLES[type] ?? type.replace(/(^|[-_])(\w)/g, (_, __, letter) => ` ${letter.toUpperCase()}`).trim();
    const body: string[] = [];

    for (index += 1; index < lines.length; index += 1) {
      const bodyLine = lines[index];
      if (bodyLine.trim() === '') {
        body.push('');
        continue;
      }
      const bodyIndent = /^\s*/.exec(bodyLine)![0].length;
      if (bodyIndent <= indent) {
        index -= 1;
        break;
      }
      body.push(bodyLine.replace(new RegExp(`^ {0,${indent + 4}}`), ''));
    }

    while (body.length > 0 && body[0].trim() === '') body.shift();
    while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();

    /* Blank lines around the block: an HTML block ends at one, so without them the
       line after `</div>` would be swallowed as raw HTML text instead of Markdown. */
    if (output.length > 0 && output[output.length - 1].trim() !== '') output.push('');
    output.push(`<div class="admonition admonition--${type}">`);
    output.push(`<p class="admonition-title">${inlineMarkdown(title)}</p>`);
    if (body.length > 0) {
      output.push('');
      output.push(...body);
      output.push('');
    }
    output.push('</div>');
    output.push('');
  }

  return output.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Titles are one line of Markdown; emphasis and code spans are all the docs use. */
function inlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

const EXTERNAL_LINK = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function splitTarget(target: string): { pathPart: string; suffix: string } {
  const match = /^([^?#]*)([?#].*)?$/.exec(target);
  return { pathPart: match?.[1] ?? target, suffix: match?.[2] ?? '' };
}

/** A local target resolved the way MkDocs resolved it, or a build error when it is missing. */
function resolveLocalTarget(
  filePath: string,
  rawPath: string,
  version: DocsVersion,
): { file: string; relative: string } {
  const decoded = decodeURIComponent(rawPath);
  const candidates = [
    path.resolve(path.dirname(filePath), decoded),
    path.resolve(version.root, decoded.replace(/^\/+/, '')),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const insideDocs = path.relative(version.root, candidate);
    if (insideDocs === '' || insideDocs.startsWith('..') || path.isAbsolute(insideDocs)) continue;
    const relative = insideDocs.split(path.sep).join('/');
    if (version.exclude.includes(relative.split('/')[0])) {
      throw new DocsBuildError(filePath, `links to unpublished documentation: ${rawPath}`);
    }
    return { file: candidate, relative };
  }

  throw new DocsBuildError(filePath, `link target does not exist: ${rawPath}`);
}

function rewriteLocalUrl(
  filePath: string,
  target: string,
  kind: 'link' | 'image',
  version: DocsVersion,
): string {
  if (!target || target.startsWith('#') || EXTERNAL_LINK.test(target)) return target;
  if (target.startsWith('/')) return target;

  const { pathPart, suffix } = splitTarget(target);
  if (!pathPart) return target;

  const { file, relative } = resolveLocalTarget(filePath, pathPart, version);

  if (file.endsWith('.md')) {
    return docsUrl(version, relative.replace(/\.md$/, '')) + suffix;
  }

  if (kind === 'link' && fs.statSync(file).isDirectory()) {
    return `${version.prefix}/${relative.replace(/\/$/, '')}/` + suffix;
  }

  return `${version.prefix}/${relative}` + suffix;
}

function linksPlugin(filePath: string, version: DocsVersion): HastPluginDefinition {
  return {
    name: 'docs-links',
    element: [
      {
        filter: ['a'],
        visit(node, ctx) {
          const href = node.properties?.href;
          if (typeof href === 'string') {
            ctx.setProperty(node, 'href', rewriteLocalUrl(filePath, href, 'link', version));
          }
        },
      },
      {
        filter: ['img'],
        visit(node, ctx) {
          const src = node.properties?.src;
          if (typeof src === 'string') {
            ctx.setProperty(node, 'src', rewriteLocalUrl(filePath, src, 'image', version));
          }
        },
      },
    ],
  };
}

interface RenderState {
  headings: DocsHeading[];
  slugger: Slugger;
}

function headingsPlugin(state: RenderState): HastPluginDefinition {
  return {
    name: 'docs-headings',
    element: {
      filter: ['h1', 'h2', 'h3', 'h4'],
      visit(node, ctx) {
        const text = ctx.textContent(node);
        const depth = Number.parseInt(node.tagName[1], 10);
        const slug = state.slugger.slug(text);
        state.headings.push({ depth, slug, text });
        ctx.setProperty(node, 'id', slug);

        if (depth >= 2) {
          ctx.appendChild(node, {
            type: 'element',
            tagName: 'a',
            properties: {
              href: `#${slug}`,
              className: ['docs-anchor'],
              ariaHidden: 'true',
              tabIndex: -1,
            },
            children: [{ type: 'text', value: '#' }],
          });
        }
      },
    },
  };
}

/** Tables are wide; a scroll container keeps the page's own horizontal rhythm. */
function tablesPlugin(): HastPluginDefinition {
  return {
    name: 'docs-tables',
    element: {
      filter: ['table'],
      visit(node, ctx) {
        ctx.wrapNode(node, { raw: '<div class="docs-table"></div>' });
      },
    },
  };
}

const highlight = await satteriCreateHighlightFn('shiki', {
  themes: { light: 'github-light', dark: 'github-dark' },
  defaultColor: false,
});
const highlightPlugin = highlight ? [satteriHighlightPlugin(highlight, undefined)] : [];

function stripHtml(html: string): string {
  return html
    .replace(/<a class="docs-anchor"[\s\S]*?<\/a>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstParagraph(html: string): string {
  for (const match of html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/g)) {
    if (/^<p class="admonition-title"/.test(match[0])) continue;
    const text = stripHtml(match[1]);
    if (text) return text;
  }
  return '';
}

function trimDescription(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= 200) return flat;
  const cut = flat.slice(0, 200);
  const space = cut.lastIndexOf(' ');
  return `${(space > 140 ? cut.slice(0, space) : cut).replace(/[,;:.]$/, '')}…`;
}

async function renderOne(meta: DocsPageMeta, version: DocsVersion, index: DocsIndex): Promise<DocsPage> {
  const source = fs.readFileSync(meta.file, 'utf8');
  const state: RenderState = { headings: [], slugger: new Slugger() };

  const result = await markdownToHtml(preprocessAdmonitions(source), {
    features: { gfm: true, rawHtml: true },
    fileURL: pathToFileURL(meta.file),
    hastPlugins: [linksPlugin(meta.file, version), headingsPlugin(state), tablesPlugin(), ...highlightPlugin],
  });

  const title = state.headings.find((heading) => heading.depth === 1)?.text ?? meta.label;
  const description = trimDescription(firstParagraph(result.html)) || `${meta.label} — DragonFruit documentation.`;
  const homeUrl = docsUrl(version, 'index');

  const versions = index.versions.map((candidate): DocsVersionLink => {
    const target = index.byKey.get(versionKey(candidate.id, meta.slug));
    return {
      id: candidate.id,
      label: candidate.label,
      version: candidate.version,
      default: candidate.default,
      prefix: candidate.prefix,
      homeUrl: docsUrl(candidate, 'index'),
      url: target?.url ?? docsUrl(candidate, 'index'),
      current: candidate.id === version.id,
    };
  });

  return {
    ...meta,
    title,
    description,
    html: result.html,
    headings: state.headings,
    toc: state.headings.filter((heading) => heading.depth >= 2 && heading.depth <= 3),
    version: {
      id: version.id,
      label: version.label,
      version: version.version,
      default: version.default,
      prefix: version.prefix,
      homeUrl,
    },
    versions,
    searchIndexUrl: `${version.prefix}/search-index.json`,
    noindex: !version.default,
  };
}

export async function renderDoc(versionId: string, slug: string): Promise<DocsPage> {
  const index = loadDocsIndex();
  const version = index.versions.find((candidate) => candidate.id === versionId);
  if (!version) throw new Error(`Unknown documentation version: ${versionId}`);

  const meta = index.byKey.get(versionKey(versionId, slug));
  if (!meta) throw new Error(`Unknown documentation page: ${versionId}/${slug}`);

  if (process.env.NODE_ENV !== 'production') {
    return renderOne(meta, version, index);
  }

  pageCache ??= new Map();
  const key = versionKey(versionId, slug);
  let page = pageCache.get(key);
  if (!page) {
    page = await renderOne(meta, version, index);
    pageCache.set(key, page);
  }
  return page;
}

export interface SearchEntry {
  url: string;
  title: string;
  text: string;
  headings: { slug: string; text: string }[];
}

export async function buildSearchIndex(versionId?: string): Promise<SearchEntry[]> {
  const index = loadDocsIndex();
  const target = versionId ?? index.defaultVersion.id;
  const entries: SearchEntry[] = [];
  for (const meta of index.pages.filter((page) => page.versionId === target)) {
    const page = await renderDoc(meta.versionId, meta.slug);
    entries.push({
      url: page.url,
      title: page.title,
      text: stripHtml(page.html),
      headings: page.toc.map((heading) => ({ slug: heading.slug, text: heading.text })),
    });
  }
  return entries;
}
