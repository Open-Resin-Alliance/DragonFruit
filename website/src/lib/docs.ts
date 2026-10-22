/**
 * The documentation viewer's build-time data layer.
 *
 * The Markdown under `docs/` is the documentation: this module reads it, turns the
 * handful of MkDocs-isms it still contains (admonitions, `.md` links) into HTML the
 * site can render, and exposes the navigation the viewer paints. Rendering happens
 * with Astro's own Sätteri pipeline pieces so code blocks, heading ids and tables
 * behave exactly as they do in a normal Astro Markdown page.
 *
 * Nothing here is imported by the browser: `renderDoc()` runs while the page is
 * built, and `buildSearchIndex()` is what the `/docs/search-index.json` endpoint
 * serialises.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import Slugger from 'github-slugger';
import { markdownToHtml, type HastPluginDefinition } from 'satteri';
import { satteriCreateHighlightFn, satteriHighlightPlugin } from '@astrojs/markdown-satteri';
import docsNav from '../data/docs-nav.json';

/* Astro bundles this module for the prerender step, so `import.meta.url` would be
   the build chunk rather than this file. The project is normally built from
   `website/`; accepting the repository root too keeps `astro build --root website`
   working. */
const DOCS_DIR = (() => {
  const found = [
    path.resolve(process.cwd(), '..', 'docs'),
    path.resolve(process.cwd(), 'docs'),
    path.resolve(process.cwd(), 'website', 'docs'),
  ].find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`Could not find the docs/ directory from ${process.cwd()}`);
  return found;
})();
const REPO_ROOT = path.dirname(DOCS_DIR);
const DOCS_PREFIX = '/docs';
const DEFAULT_NAV = docsNav as NavFile;
const EXCLUDED_DIRECTORIES = new Set(DEFAULT_NAV.exclude ?? []);

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

export interface DocsPageMeta {
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
}

export interface DocsIndex {
  pages: DocsPageMeta[];
  bySlug: Map<string, DocsPageMeta>;
  nav: DocsNavNode[];
}

export class DocsBuildError extends Error {
  constructor(file: string, message: string) {
    super(`${path.relative(REPO_ROOT, file)}: ${message}`);
    this.name = 'DocsBuildError';
  }
}

/** `/docs/` for the index, `/docs/foo/bar/` for a page, `/docs/foo/` for its index. */
export function docsUrl(slug: string): string {
  if (slug === 'index') return `${DOCS_PREFIX}/`;
  if (slug.endsWith('/index')) return `${DOCS_PREFIX}/${slug.slice(0, -'/index'.length)}/`;
  return `${DOCS_PREFIX}/${slug}/`;
}
/** Every Markdown file the site publishes, as absolute paths. */
function collectDocFiles(directory = DOCS_DIR): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      files.push(...collectDocFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function flattenNav(items: NavItem[], trail: string[] = []): DocsPageMeta[] {
  const pages: DocsPageMeta[] = [];
  for (const item of items) {
    if (item.slug) {
      const file = path.join(DOCS_DIR, `${item.slug}.md`);
      pages.push({
        slug: item.slug,
        file,
        url: docsUrl(item.slug),
        label: item.label,
        trail,
      });
      continue;
    }
    pages.push(...flattenNav(item.items ?? [], [...trail, item.label]));
  }
  return pages;
}

function buildNav(items: NavItem[]): DocsNavNode[] {
  const nodes: DocsNavNode[] = [];
  for (const item of items) {
    if (item.slug) {
      nodes.push({ label: item.label, slug: item.slug, url: docsUrl(item.slug) });
      continue;
    }
    if (item.href) continue;
    nodes.push({ label: item.label, children: buildNav(item.items ?? []) });
  }
  return nodes;
}

/** Whether a group in the sidebar contains the page currently being read. */
export function navContainsSlug(node: DocsNavNode, slug: string): boolean {
  if (node.slug === slug) return true;
  return node.children?.some((child) => navContainsSlug(child, slug)) ?? false;
}

function buildIndex(): DocsIndex {
  const pages = flattenNav(DEFAULT_NAV.items);
  const files = collectDocFiles();
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const listedFiles = new Set(pages.map((page) => page.slug));

  for (const page of pages) {
    if (!fs.existsSync(page.file)) {
      throw new DocsBuildError(page.file, `"${page.label}" is listed in docs-nav.json but the page does not exist`);
    }
  }

  for (const file of files) {
    const slug = path.relative(DOCS_DIR, file).split(path.sep).join('/').replace(/\.md$/, '');
    if (!listedFiles.has(slug)) {
      throw new DocsBuildError(file, 'page is not listed in website/src/data/docs-nav.json');
    }
  }

  pages.forEach((page, index) => {
    const prev = pages[index - 1];
    const next = pages[index + 1];
    if (prev) page.prev = { label: prev.label, url: prev.url };
    if (next) page.next = { label: next.label, url: next.url };
  });

  return { pages, bySlug, nav: buildNav(DEFAULT_NAV.items) };
}

let indexCache: DocsIndex | undefined;
let pageCache: Map<string, DocsPage> | undefined;

export function loadDocsIndex(): DocsIndex {
  /* A nav entry added in dev should not need a server restart; a production build
     reads the directory once and renders every page against that snapshot. */
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
function resolveLocalTarget(filePath: string, rawPath: string): { file: string; relative: string } {
  const decoded = decodeURIComponent(rawPath);
  const candidates = [
    path.resolve(path.dirname(filePath), decoded),
    path.resolve(DOCS_DIR, decoded.replace(/^\/+/, '')),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const insideDocs = path.relative(DOCS_DIR, candidate);
    if (insideDocs === '' || insideDocs.startsWith('..') || path.isAbsolute(insideDocs)) continue;
    const relative = insideDocs.split(path.sep).join('/');
    if (EXCLUDED_DIRECTORIES.has(relative.split('/')[0])) {
      throw new DocsBuildError(filePath, `links to unpublished documentation: ${rawPath}`);
    }
    return { file: candidate, relative };
  }

  throw new DocsBuildError(filePath, `link target does not exist: ${rawPath}`);
}

function rewriteLocalUrl(filePath: string, target: string, kind: 'link' | 'image'): string {
  if (!target || target.startsWith('#') || EXTERNAL_LINK.test(target)) return target;
  if (target.startsWith('/')) return target;

  const { pathPart, suffix } = splitTarget(target);
  if (!pathPart) return target;

  const { file, relative } = resolveLocalTarget(filePath, pathPart);

  if (file.endsWith('.md')) {
    return docsUrl(relative.replace(/\.md$/, '')) + suffix;
  }

  if (kind === 'link' && fs.statSync(file).isDirectory()) {
    return `${DOCS_PREFIX}/${relative.replace(/\/$/, '')}/` + suffix;
  }

  return `${DOCS_PREFIX}/${relative}` + suffix;
}

function linksPlugin(filePath: string): HastPluginDefinition {
  return {
    name: 'docs-links',
    element: [
      {
        filter: ['a'],
        visit(node, ctx) {
          const href = node.properties?.href;
          if (typeof href === 'string') ctx.setProperty(node, 'href', rewriteLocalUrl(filePath, href, 'link'));
        },
      },
      {
        filter: ['img'],
        visit(node, ctx) {
          const src = node.properties?.src;
          if (typeof src === 'string') ctx.setProperty(node, 'src', rewriteLocalUrl(filePath, src, 'image'));
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

async function renderOne(meta: DocsPageMeta): Promise<DocsPage> {
  const source = fs.readFileSync(meta.file, 'utf8');
  const state: RenderState = { headings: [], slugger: new Slugger() };

  const result = await markdownToHtml(preprocessAdmonitions(source), {
    features: { gfm: true, rawHtml: true },
    fileURL: pathToFileURL(meta.file),
    hastPlugins: [linksPlugin(meta.file), headingsPlugin(state), tablesPlugin(), ...highlightPlugin],
  });

  const title = state.headings.find((heading) => heading.depth === 1)?.text ?? meta.label;
  const description = trimDescription(firstParagraph(result.html)) || `${meta.label} — DragonFruit documentation.`;

  return {
    ...meta,
    title,
    description,
    html: result.html,
    headings: state.headings,
    toc: state.headings.filter((heading) => heading.depth >= 2 && heading.depth <= 3),
  };
}

export async function renderDoc(slug: string): Promise<DocsPage> {
  const index = loadDocsIndex();
  const meta = index.bySlug.get(slug);
  if (!meta) throw new Error(`Unknown documentation page: ${slug}`);

  if (process.env.NODE_ENV !== 'production') {
    return renderOne(meta);
  }

  pageCache ??= new Map();
  let page = pageCache.get(slug);
  if (!page) {
    page = await renderOne(meta);
    pageCache.set(slug, page);
  }
  return page;
}

export interface SearchEntry {
  url: string;
  title: string;
  text: string;
  headings: { slug: string; text: string }[];
}

export async function buildSearchIndex(): Promise<SearchEntry[]> {
  const index = loadDocsIndex();
  const entries: SearchEntry[] = [];
  for (const meta of index.pages) {
    const page = await renderDoc(meta.slug);
    entries.push({
      url: page.url,
      title: page.title,
      text: stripHtml(page.html),
      headings: page.toc.map((heading) => ({ slug: heading.slug, text: heading.text })),
    });
  }
  return entries;
}
