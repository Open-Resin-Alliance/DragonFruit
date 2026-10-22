/**
 * Serves the documentation's own assets in `astro dev` and copies them into the build.
 *
 * The Markdown under `docs/` links its screenshots and diagrams relatively, and those
 * files live beside the Markdown rather than under `website/public`. A build copies
 * `docs/assets` to `/docs/assets/`; the dev server answers the same URLs from the
 * source directory, so a new screenshot needs no second copy in the repository.
 *
 * It also watches the docs directory: Markdown is read with `fs` at render time, so
 * Vite has no module edge to invalidate when one changes. A full reload is enough -
 * the page re-renders and reads the file again.
 */
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* The integration runs in the project process, whose cwd is `website/` for both
   `astro dev` and `astro build`. Resolve to the repository's docs directory from
   there, with the source-file URL as a fallback for a tool that loads this module
   from elsewhere. */
const DOCS_DIR = (() => {
  const candidates = [
    path.resolve(process.cwd(), '..', 'docs'),
    path.resolve(process.cwd(), 'docs'),
    fileURLToPath(new URL('../../../docs', import.meta.url)),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
})();
const ASSETS_DIR = path.join(DOCS_DIR, 'assets');

const MIME_TYPES = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

export default function documentation() {
  return {
    name: 'dragonfruit-documentation',
    hooks: {
      'astro:server:setup': ({ server, logger }) => {
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
          if (!pathname.startsWith('/docs/assets/')) return next();

          let relative;
          try {
            relative = decodeURIComponent(pathname.slice('/docs/assets/'.length));
          } catch {
            response.writeHead(400).end('bad path');
            return;
          }

          const file = path.resolve(ASSETS_DIR, relative);
          const inside = path.relative(ASSETS_DIR, file);
          if (inside.startsWith('..') || path.isAbsolute(inside)) {
            response.writeHead(400).end('bad path');
            return;
          }
          if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            response.writeHead(404).end('not found');
            logger.warn(`documentation asset not found: docs/assets/${relative}`);
            return;
          }

          response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': fs.statSync(file).size,
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(file).pipe(response);
        });

        server.watcher.add(DOCS_DIR);
        server.watcher.on('all', (_event, file) => {
          const absolute = path.resolve(file);
          if (absolute.startsWith(DOCS_DIR + path.sep) && absolute.endsWith('.md')) {
            server.ws.send({ type: 'full-reload' });
          }
        });
      },

      'astro:build:done': async ({ dir, logger }) => {
        if (!fs.existsSync(ASSETS_DIR)) return;
        const target = fileURLToPath(new URL('./docs/assets/', dir));
        await fsp.cp(ASSETS_DIR, target, { recursive: true });
        logger.info(`copied documentation assets to ${path.relative(process.cwd(), target)}`);
      },
    },
  };
}
