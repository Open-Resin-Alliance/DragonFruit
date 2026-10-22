/**
 * Renders a social card for every page, after the site is built.
 *
 * Deliberately downstream of the pages rather than a route of its own: the card for
 * a page is built from that page's own <title>, description and card meta, so a new
 * blog post or specification gets a card the moment it gets a page, with nothing to
 * register and nothing to keep in step. A route endpoint would need its own list of
 * slugs, and a list that disagrees with the pages fails silently as a 404 image.
 *
 * The paths line up with `ogImagePath()` in src/lib/og.ts, which is what the pages
 * put in their markup: `/builds/` is `/og/builds.png` either way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCard } from './render.mjs';

/** Astro escapes text as it writes attributes: undo the few entities that matter here. */
const decode = (value) =>
  value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

const fromHtml = (source, pattern) => {
  const found = pattern.exec(source)?.[1];
  return found === undefined ? undefined : decode(found).trim();
};

const slugFor = (pathname) => {
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? 'home' : trimmed;
};

export default function socialCards() {
  return {
    name: 'dragonfruit-social-cards',
    hooks: {
      'astro:build:done': async ({ dir, pages, logger }) => {
        const root = fileURLToPath(dir);
        const started = Date.now();
        let written = 0;

        for (const { pathname } of pages) {
          const slug = slugFor(pathname);
          const page = path.join(root, slug === 'home' ? '' : slug, 'index.html');
          const source = fs.existsSync(page)
            ? fs.readFileSync(page, 'utf8')
            : fs.existsSync(`${path.join(root, slug)}.html`)
              ? fs.readFileSync(path.join(root, `${slug}.html`), 'utf8')
              : undefined;
          if (!source) continue;
          /* A forwarding stub is not a landing page - it bounces straight to the
             section it belongs to, carries no social tags, and is noindex - so it
             gets no card. Astro's stub starts with this exact title; a documentation
             page can mention `http-equiv="refresh"` while explaining the redirects. */
          if (source.startsWith('<!doctype html><title>Redirecting to:')) continue;

          const title = fromHtml(source, /<meta name="card:title" content="([^"]*)"/) ?? 'DragonFruit';

          const png = await renderCard({
            /* The home card is the brand's: the wordmark centred, with the project's
               line under it, and no page title to repeat. */
            centred: slug === 'home',
            title,
            description:
              fromHtml(source, /<meta name="card:summary" content="([^"]*)"/) ??
              fromHtml(source, /<meta name="description" content="([^"]*)"/),
            meta: fromHtml(source, /<meta name="card:meta" content="([^"]*)"/),
          });

          const target = path.join(root, 'og', `${slug}.png`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, png);
          written += 1;
        }

        logger.info(`rendered ${written} social cards in ${Date.now() - started}ms`);
      },
    },
  };
}
