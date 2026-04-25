import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const pluginsRoot = path.join(repoRoot, 'plugins');
const allowlistPath = path.join(repoRoot, 'src', 'config', 'builtin-simple-plugin-allowlist.json');
const generatedTsPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinSimplePlugins.ts');

function normalizeRelativePath(baseDir, relativePath) {
      const stack = String(baseDir || '').split('/').filter(Boolean);
      const segments = String(relativePath || '').split('/');

      for (const segment of segments) {
            if (!segment || segment === '.') continue;
            if (segment === '..') {
                  if (stack.length > 0) stack.pop();
                  continue;
            }
            stack.push(segment);
      }

      return stack.join('/');
}

function normalizeImageAssetPath(pluginFolder, sourceDirWithinPlugin, imageAssetPath) {
      if (typeof imageAssetPath !== 'string') return undefined;
      const trimmed = imageAssetPath.trim();
      if (!trimmed) return undefined;

      if (
            trimmed.startsWith('http://')
            || trimmed.startsWith('https://')
            || trimmed.startsWith('data:')
            || trimmed.startsWith('/api/profile-assets/')
            || trimmed.startsWith('/')
      ) {
            return trimmed;
      }

      const normalized = normalizeRelativePath(sourceDirWithinPlugin, trimmed);
      return `/plugins/${pluginFolder}/${normalized}`;
}

function sanitizeRelativeJsonPath(input) {
      if (typeof input !== 'string') return null;
      const normalized = input.trim().replace(/^\/+/, '');
      if (!normalized) return null;
      if (normalized.includes('..') || normalized.includes('\\')) return null;
      if (!normalized.toLowerCase().endsWith('.json')) return null;
      return normalized;
}

async function readJsonFile(filePath) {
      const text = await fs.readFile(filePath, 'utf8');
      return JSON.parse(text);
}

function collectPresetEntries(payload, sourceDirWithinPlugin) {
      if (Array.isArray(payload)) {
            return payload.map((preset) => ({ preset, sourceDirWithinPlugin }));
      }

      if (payload && typeof payload === 'object' && Array.isArray(payload.printerPresets)) {
            return payload.printerPresets.map((preset) => ({ preset, sourceDirWithinPlugin }));
      }

      return [];
}

async function buildManifestFromAllowlistEntry(entry) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      const folder = typeof entry?.folder === 'string' ? entry.folder.trim() : '';
      const manifestPath = sanitizeRelativeJsonPath(entry?.manifestPath ?? 'dragonfruit-plugin.json');

      if (!id || !folder || !manifestPath) {
            throw new Error('[builtin-simple-plugins] Allowlist entry must include id, folder, and manifestPath (json).');
      }

      const pluginRoot = path.join(pluginsRoot, folder);
      const manifestFsPath = path.join(pluginRoot, manifestPath);
      const manifest = await readJsonFile(manifestFsPath);
      const manifestDirWithinPlugin = path.posix.dirname(manifestPath).replace(/^\.$/, '');

      const mergedPresetEntries = [];

      if (Array.isArray(manifest.printerPresets)) {
            mergedPresetEntries.push(
                  ...manifest.printerPresets.map((preset) => ({
                        preset,
                        sourceDirWithinPlugin: manifestDirWithinPlugin,
                  })),
            );
      }

      if (Array.isArray(manifest.printerPresetPaths)) {
            for (const rawPath of manifest.printerPresetPaths) {
                  const relativePath = sanitizeRelativeJsonPath(rawPath);
                  if (!relativePath) continue;

                  const sourcePayload = await readJsonFile(path.join(pluginRoot, relativePath));
                  const sourceDirWithinPlugin = path.posix.dirname(relativePath).replace(/^\.$/, '');
                  mergedPresetEntries.push(...collectPresetEntries(sourcePayload, sourceDirWithinPlugin));
            }
      }

      const resolvedPrinterPresets = mergedPresetEntries.map(({ preset, sourceDirWithinPlugin }) => {
            if (!preset || typeof preset !== 'object') return preset;

            const rawImageAssetPath = typeof preset.imageAssetPath === 'string' ? preset.imageAssetPath : undefined;
            const normalizedImageAssetPath = normalizeImageAssetPath(folder, sourceDirWithinPlugin, rawImageAssetPath);

            if (!normalizedImageAssetPath) return preset;

            return {
                  ...preset,
                  imageAssetPath: normalizedImageAssetPath,
            };
      });

      const resolvedMaterialPresets = [];

      if (Array.isArray(manifest.materialPresets)) {
            resolvedMaterialPresets.push(...manifest.materialPresets);
      }

      if (Array.isArray(manifest.materialPresetPaths)) {
            for (const rawPath of manifest.materialPresetPaths) {
                  const relativePath = sanitizeRelativeJsonPath(rawPath);
                  if (!relativePath) continue;

                  const presetData = await readJsonFile(path.join(pluginRoot, relativePath));
                  if (presetData && typeof presetData === 'object' && !Array.isArray(presetData)) {
                        resolvedMaterialPresets.push(presetData);
                  } else if (Array.isArray(presetData)) {
                        resolvedMaterialPresets.push(...presetData);
                  }
            }
      }

      return {
            schemaVersion: Number.isFinite(Number(manifest.schemaVersion)) ? Number(manifest.schemaVersion) : 1,
            id: typeof manifest.id === 'string' ? manifest.id : id,
            name: typeof manifest.name === 'string' ? manifest.name : id,
            version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
            description: typeof manifest.description === 'string' ? manifest.description : undefined,
            author: typeof manifest.author === 'string' ? manifest.author : undefined,
            homepage: typeof manifest.homepage === 'string' ? manifest.homepage : undefined,
            printerPresets: resolvedPrinterPresets,
            materialTemplates: Array.isArray(manifest.materialTemplates) ? manifest.materialTemplates : [],
            materialPresets: resolvedMaterialPresets,
      };
}

function renderGeneratedTs(manifests) {
      return `/* AUTO-GENERATED FILE. DO NOT EDIT.\n * Generated by scripts/generate-builtin-simple-plugins.mjs\n */\nimport type { PluginManifest } from '@/features/plugins/pluginRegistry';\n\nconst GENERATED_BUILTIN_SIMPLE_PLUGIN_MANIFESTS_RAW = Object.freeze(${JSON.stringify(manifests, null, 2)});\n\nexport const GENERATED_BUILTIN_SIMPLE_PLUGIN_MANIFESTS = GENERATED_BUILTIN_SIMPLE_PLUGIN_MANIFESTS_RAW as unknown as readonly PluginManifest[];\n`;
}

async function main() {
      const allowlist = await readJsonFile(allowlistPath);
      const entries = Array.isArray(allowlist?.builtinSimplePlugins) ? allowlist.builtinSimplePlugins : [];

      const manifests = [];
      for (const entry of entries) {
            manifests.push(await buildManifestFromAllowlistEntry(entry));
      }

      const content = renderGeneratedTs(manifests);
      await fs.writeFile(generatedTsPath, content, 'utf8');

      console.log(`[builtin-simple-plugins] Generated ${path.relative(repoRoot, generatedTsPath)} (${manifests.length} plugin(s)).`);
}

main().catch((error) => {
      console.error('[builtin-simple-plugins] Failed.', error);
      process.exitCode = 1;
});
