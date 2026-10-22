// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import socialCards from './src/og/integration.mjs';
import documentation from './src/integrations/docs.mjs';

/**
 * The URLs the Markdown documentation used to be served from, before it moved under
 * `/docs/`. They are in issue comments and search results, so Astro writes a
 * forwarding page for each one. Only the default documentation version (normally
 * `main`) owns those old URLs; alternate branch snapshots live under
 * `/docs/versions/<id>/` and never claim a root path.
 *
 * @returns {Record<string, string>}
 */
function legacyDocumentRedirects() {
  const websiteRoot = fileURLToPath(new URL('.', import.meta.url));
  const versionsDir = path.join(websiteRoot, '.docs-versions');
  const manifestFile = path.join(versionsDir, 'manifest.json');

  let docsRoot = path.join(websiteRoot, '..', 'docs');
  let excluded = new Set(['internal']);

  if (fs.existsSync(manifestFile)) {
    const manifest = /** @type {{ default: string, exclude?: string[], versions: Array<{ id: string, root: string, exclude?: string[] }> }} */ (
      JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    );
    const version =
      manifest.versions.find((entry) => entry.id === manifest.default) ?? manifest.versions[0];
    docsRoot = path.join(versionsDir, version.root, 'docs');
    excluded = new Set(version.exclude ?? manifest.exclude ?? ['internal']);
  }

  /** @type {string[]} */
  const slugs = [];
  /** @param {string} directory */
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) continue;
        walk(path.join(directory, entry.name));
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      slugs.push(
        path
          .relative(docsRoot, path.join(directory, entry.name))
          .split(path.sep)
          .join('/')
          .replace(/\.md$/, ''),
      );
    }
  };
  walk(docsRoot);

  /** @type {Record<string, string>} */
  const redirects = {};
  for (const slug of slugs) {
    if (slug === 'index') continue;
    const oldPath = slug.endsWith('/index')
      ? `/${slug.slice(0, -'/index'.length)}/`
      : `/${slug}/`;
    redirects[oldPath] = `/docs${oldPath}`;
  }
  return redirects;
}

// https://astro.build/config
export default defineConfig({
  site: 'https://dragonfruit-slicer.com',
  trailingSlash: 'ignore',
  redirects: legacyDocumentRedirects(),
  integrations: [
    /* Every page gets a social card, rendered from the page itself once the site is
       built. See src/og/. */
    socialCards(),
    /* The documentation is Markdown from `docs/`; its screenshots live beside it. */
    documentation(),
  ],
  build: {
    inlineStylesheets: 'auto',
  },
  devToolbar: {
    enabled: false,
  },
});
