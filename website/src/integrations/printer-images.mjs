/**
 * Printer thumbnails for the compatibility page.
 *
 * The renders live in the plugin packs (`plugins/<id>/printers/assets/`), at the
 * size the app wants. The gallery needs small ones, so this serves a resized WebP
 * from `/printers/<presetId>.webp` in `astro dev` and writes the same files into
 * the build. Nothing is committed: the packs stay the only copy of the artwork.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const WEBSITE_ROOT =
  [process.cwd(), path.resolve(process.cwd(), 'website')].find((candidate) =>
    fs.existsSync(path.join(candidate, 'astro.config.mjs')),
  ) ?? process.cwd();
const REPO_ROOT = path.dirname(WEBSITE_ROOT);

/** Big enough for a 2x card, small enough that 57 of them stay a light page. */
const MAX_SIZE = 480;

/** presetId -> the render's path on disk, for every preset that ships one. */
let sources = null;

function printerSources() {
  if (sources) return sources;

  sources = new Map();
  const pluginsDir = path.join(REPO_ROOT, 'plugins');

  for (const plugin of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;

    const printersDir = path.join(pluginsDir, plugin.name, 'printers');
    let files;
    try {
      files = fs.readdirSync(printersDir).filter((file) => file.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of files) {
      const presets = JSON.parse(fs.readFileSync(path.join(printersDir, file), 'utf8'));
      for (const preset of presets) {
        if (!preset?.presetId || !preset.imageAssetPath) continue;
        const source = path.resolve(printersDir, preset.imageAssetPath);
        if (fs.existsSync(source)) sources.set(preset.presetId, source);
      }
    }
  }

  return sources;
}

async function render(source) {
  return sharp(source)
    .resize({ width: MAX_SIZE, height: MAX_SIZE, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
}

export default function printerImages() {
  return {
    name: 'dragonfruit-printer-images',
    hooks: {
      'astro:server:setup': ({ server }) => {
        const cache = new Map();

        server.middlewares.use((request, response, next) => {
          const match = /^\/printers\/([^/]+)\.webp$/.exec(new URL(request.url ?? '/', 'http://localhost').pathname);
          if (!match) return next();

          const id = decodeURIComponent(match[1]);
          let source = printerSources().get(id);

          /* A pack added while the server is running is not in the map yet. */
          if (!source) {
            sources = null;
            source = printerSources().get(id);
          }

          if (!source) return next();

          const send = (body) => {
            response.setHeader('Content-Type', 'image/webp');
            response.setHeader('Cache-Control', 'no-cache');
            response.end(body);
          };

          const cached = cache.get(id);
          if (cached) return send(cached);

          render(source)
            .then((body) => {
              cache.set(id, body);
              send(body);
            })
            .catch(next);
        });
      },

      'astro:build:done': async ({ dir, logger }) => {
        const outDir = path.join(fileURLToPath(dir), 'printers');
        fs.mkdirSync(outDir, { recursive: true });

        let written = 0;
        for (const [id, source] of printerSources()) {
          fs.writeFileSync(path.join(outDir, `${id}.webp`), await render(source));
          written += 1;
        }

        logger.info(`wrote ${written} printer thumbnails`);
      },
    },
  };
}
