/**
 * Serves the documentation's own assets in `astro dev` and copies them into the build.
 *
 * Each documentation version is a snapshot under `website/.docs-versions/<id>/`
 * (see `scripts/prepare-docs-versions.mjs`). The default version keeps the familiar
 * `/docs/assets/` URLs; an alternate version lives under
 * `/docs/versions/<id>/assets/`. The same mapping is used by the page renderer, so
 * a screenshot referenced relatively from Markdown resolves without a second copy.
 */
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEBSITE_ROOT =
  [process.cwd(), path.resolve(process.cwd(), 'website')].find((candidate) =>
    fs.existsSync(path.join(candidate, 'astro.config.mjs')),
  ) ?? process.cwd();
const REPO_ROOT = path.dirname(WEBSITE_ROOT);
const LOCAL_DOCS_DIR = path.join(REPO_ROOT, 'docs');
const VERSIONS_DIR = path.join(WEBSITE_ROOT, '.docs-versions');
const MANIFEST_FILE = path.join(VERSIONS_DIR, 'manifest.json');

const MIME_TYPES = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function loadVersions() {
  if (!fs.existsSync(MANIFEST_FILE)) {
    return [{ id: 'current', prefix: '/docs', root: LOCAL_DOCS_DIR }];
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  return manifest.versions.map((version) => ({
    id: version.id,
    prefix: version.id === manifest.default ? '/docs' : `/docs/versions/${version.id}`,
    root: path.join(VERSIONS_DIR, version.root, 'docs'),
  }));
}

export default function documentation() {
  const versions = loadVersions();

  return {
    name: 'dragonfruit-documentation',
    hooks: {
      'astro:server:setup': ({ server, logger }) => {
        server.middlewares.use((request, response, next) => {
          const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
          let version;
          let relative;

          const alternate = /^\/docs\/versions\/([^/]+)\/assets\/(.*)$/.exec(pathname);
          if (alternate) {
            version = versions.find((candidate) => candidate.id === alternate[1]);
            relative = alternate[2];
          } else if (pathname.startsWith('/docs/assets/')) {
            version = versions.find((candidate) => candidate.prefix === '/docs');
            relative = pathname.slice('/docs/assets/'.length);
          }

          if (!version) return next();

          try {
            relative = decodeURIComponent(relative);
          } catch {
            response.writeHead(400).end('bad path');
            return;
          }

          const assetsDir = path.join(version.root, 'assets');
          const file = path.resolve(assetsDir, relative);
          const inside = path.relative(assetsDir, file);
          if (inside.startsWith('..') || path.isAbsolute(inside)) {
            response.writeHead(400).end('bad path');
            return;
          }
          if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
            response.writeHead(404).end('not found');
            logger.warn(`documentation asset not found: ${path.relative(REPO_ROOT, file)}`);
            return;
          }

          response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': fs.statSync(file).size,
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(file).pipe(response);
        });

        for (const version of versions) server.watcher.add(version.root);
        server.watcher.on('all', (_event, file) => {
          const absolute = path.resolve(file);
          if (absolute.endsWith('.md') && versions.some((version) => absolute.startsWith(version.root + path.sep))) {
            server.ws.send({ type: 'full-reload' });
          }
        });
      },

      'astro:build:done': async ({ dir, logger }) => {
        const distRoot = fileURLToPath(dir);

        for (const version of versions) {
          const source = path.join(version.root, 'assets');
          if (!fs.existsSync(source)) continue;

          const target = path.join(distRoot, version.prefix.slice(1), 'assets');
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.cp(source, target, { recursive: true });
          logger.info(`copied ${version.id} documentation assets to ${path.relative(WEBSITE_ROOT, target)}`);
        }
      },
    },
  };
}
