import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const allowlistPath = path.join(repoRoot, 'src', 'config', 'complex-plugin-allowlist.json');
const generatedTsPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPlugins.ts');
const generatedNetworkTsPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPluginNetworkHandlers.ts');
const generatedUploadTsPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPluginUploadHandlers.ts');
const generatedRustPath = path.join(repoRoot, 'src-tauri', 'src', 'generated_builtin_plugins.rs');
const generatedEncoderRustPath = path.join(repoRoot, 'rust', 'dragonfruit-slicer-v3', 'src', 'encoders', 'generated_plugin_encoders.rs');

async function readText(filePath) {
      return fs.readFile(filePath, 'utf8');
}

async function main() {
      const allowRaw = await readText(allowlistPath);
      const allowParsed = JSON.parse(allowRaw);
      const ids = (Array.isArray(allowParsed?.builtinComplexPlugins) ? allowParsed.builtinComplexPlugins : [])
            .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
            .filter(Boolean);

      if (ids.length === 0) {
            throw new Error('[plugin-registry-smoke] allowlist has no plugin ids');
      }

      const [generatedTs, generatedNetworkTs, generatedUploadTs, generatedRust, generatedEncoderRust] = await Promise.all([
            readText(generatedTsPath),
            readText(generatedNetworkTsPath),
            readText(generatedUploadTsPath),
            readText(generatedRustPath),
            readText(generatedEncoderRustPath),
      ]);

      for (const id of ids) {
            if (!generatedTs.includes(`'${id}'`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedTsPath)} missing plugin id '${id}'`);
            }

            if (!generatedNetworkTs.includes(`pluginId: '${id}'`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedNetworkTsPath)} missing network handler entry for '${id}'`);
            }

            if (!generatedUploadTs.includes(`pluginId: '${id}'`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedUploadTsPath)} missing upload handler entry for '${id}'`);
            }

            if (!generatedRust.includes(`"${id}"`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedRustPath)} missing rust runtime plugin id '${id}'`);
            }
      }

      if (!generatedEncoderRust.includes('create_plugin_encoder()')) {
            throw new Error(`[plugin-registry-smoke] ${path.basename(generatedEncoderRustPath)} missing create_plugin_encoder() invocation`);
      }

      console.log(`[plugin-registry-smoke] OK (${ids.length} plugin id(s))`);
}

main().catch((error) => {
      console.error('[plugin-registry-smoke] Failed.', error);
      process.exitCode = 1;
});
