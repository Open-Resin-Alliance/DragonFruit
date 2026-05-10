import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const allowlistPath = path.join(repoRoot, 'src', 'config', 'complex-plugin-allowlist.json');
const pluginsRoot = path.join(repoRoot, 'plugins');
const generatedTsPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPlugins.ts');
const generatedNetworkTsPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPluginNetworkHandlers.ts');
const generatedUploadTsPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPluginUploadHandlers.ts');
const generatedFileTypeTsPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPluginFileTypeHandlers.ts');
const generatedRustPath = path.join(repoRoot, 'src-tauri', 'src', 'generated_builtin_plugins.rs');
const generatedEncoderRustPath = path.join(repoRoot, 'rust', 'dragonfruit-slicing-engine', 'src', 'encoders', 'generated_plugin_encoders.rs');

async function readText(filePath) {
      return fs.readFile(filePath, 'utf8');
}

function parseCapabilitiesFromPluginDefinitionSource(sourceText) {
      const hasCapabilityBlock = /capabilities\s*:\s*\{[\s\S]*?\}/m.test(sourceText);
      const hasTrueFlag = (flag) => new RegExp(`${flag}\\s*:\\s*true`, 'm').test(sourceText);

      return {
            hasCapabilityBlock,
            networkOperations: hasTrueFlag('networkOperations'),
            uploadWithProgress: hasTrueFlag('uploadWithProgress'),
            slicerEncoder: hasTrueFlag('slicerEncoder'),
            tauriRuntimePlugin: hasTrueFlag('tauriRuntimePlugin'),
            fileType: hasTrueFlag('fileType'),
      };
}

async function readPluginCapabilities(pluginId) {
      const definitionPath = path.join(pluginsRoot, pluginId, 'pluginDefinition.ts');
      const source = await readText(definitionPath);
      return parseCapabilitiesFromPluginDefinitionSource(source);
}

async function hasPluginDefinition(pluginId) {
      const definitionPath = path.join(pluginsRoot, pluginId, 'pluginDefinition.ts');
      try {
            await fs.access(definitionPath);
            return true;
      } catch {
            return false;
      }
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

      const [generatedTs, generatedNetworkTs, generatedUploadTs, generatedFileTypeTs, generatedRust, generatedEncoderRust] = await Promise.all([
            readText(generatedTsPath),
            readText(generatedNetworkTsPath),
            readText(generatedUploadTsPath),
            readText(generatedFileTypeTsPath),
            readText(generatedRustPath),
            readText(generatedEncoderRustPath),
      ]);

      const localPresence = await Promise.all(
            ids.map(async (id) => ({ id, present: await hasPluginDefinition(id) })),
      );
      const locallyAvailableIds = localPresence.filter((entry) => entry.present).map((entry) => entry.id);
      const missingIds = localPresence.filter((entry) => !entry.present).map((entry) => entry.id);

      if (missingIds.length > 0) {
            console.warn(
                  `[plugin-registry-smoke] Warning: allowlisted plugin(s) missing locally (likely uninitialized submodule): ${missingIds.join(', ')}`,
            );
            console.warn('[plugin-registry-smoke] Skipping smoke validation for missing local plugin sources.');
      }

      const capabilityEntries = await Promise.all(
            locallyAvailableIds.map(async (id) => ({ id, capabilities: await readPluginCapabilities(id) })),
      );

      for (const { id, capabilities } of capabilityEntries) {
            if (!capabilities.hasCapabilityBlock) {
                  throw new Error(`[plugin-registry-smoke] plugin '${id}' is missing capabilities block in pluginDefinition.ts`);
            }

            if (!generatedTs.includes(`'${id}'`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedTsPath)} missing plugin id '${id}'`);
            }

            if (capabilities.networkOperations && !generatedNetworkTs.includes(`pluginId: '${id}'`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedNetworkTsPath)} missing network handler entry for '${id}'`);
            }

            if (capabilities.uploadWithProgress && !generatedUploadTs.includes(`pluginId: '${id}'`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedUploadTsPath)} missing upload handler entry for '${id}'`);
            }

            if (capabilities.fileType && !generatedFileTypeTs.includes(`pluginId: '${id}'`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedFileTypeTsPath)} missing file-type handler entry for '${id}'`);
            }

            if (capabilities.tauriRuntimePlugin && !generatedRust.includes(`"${id}"`)) {
                  throw new Error(`[plugin-registry-smoke] ${path.basename(generatedRustPath)} missing rust runtime plugin id '${id}'`);
            }

            if (
                  capabilities.slicerEncoder &&
                  !generatedEncoderRust.includes(`plugins/${id}/slicing/rust/encoder_impl.rs`)
            ) {
                  throw new Error(
                        `[plugin-registry-smoke] ${path.basename(generatedEncoderRustPath)} missing slicing encoder include for '${id}'`,
                  );
            }
      }

      if (
            capabilityEntries.some((entry) => entry.capabilities.slicerEncoder) &&
            !generatedEncoderRust.includes('create_plugin_encoder()')
      ) {
            throw new Error(`[plugin-registry-smoke] ${path.basename(generatedEncoderRustPath)} missing create_plugin_encoder() invocation`);
      }

      console.log(`[plugin-registry-smoke] OK (${locallyAvailableIds.length} local plugin id(s), ${missingIds.length} missing)`);
}

main().catch((error) => {
      console.error('[plugin-registry-smoke] Failed.', error);
      process.exitCode = 1;
});
