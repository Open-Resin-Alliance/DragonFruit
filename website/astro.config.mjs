// @ts-check
import fs from 'node:fs';
import { defineConfig } from 'astro/config';
import socialCards from './src/og/integration.mjs';
import documentation from './src/integrations/docs.mjs';

/**
 * The URLs the Markdown documentation used to be served from, before it moved under
 * `/docs/`. They are in issue comments and search results, so Astro writes a
 * forwarding page for each one. The list comes from the same nav the viewer builds
 * from, and the old path is the new one without the `/docs` prefix.
 */
/**
 * @typedef {{ slug?: string, items?: NavItem[] }} NavItem
 */

/** @returns {Record<string, string>} */
function legacyDocumentRedirects() {
  const nav = /** @type {{ items: NavItem[] }} */ (
    JSON.parse(fs.readFileSync(new URL('./src/data/docs-nav.json', import.meta.url), 'utf8'))
  );
  /** @type {string[]} */
  const slugs = [];
  /** @param {NavItem[]} items */
  const walk = (items) => {
    for (const item of items) {
      if (item.slug) slugs.push(item.slug);
      if (item.items) walk(item.items);
    }
  };
  walk(nav.items);

  /** @type {Record<string, string>} */
  const redirects = {};
  for (const slug of slugs) {
    if (slug === 'index') continue;
    const target =
      slug.endsWith('/index')
        ? `/docs/${slug.slice(0, -'/index'.length)}/`
        : `/docs/${slug}/`;
    redirects[target.replace(/^\/docs/, '')] = target;
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
