import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const pluginsRoot = path.join(repoRoot, 'plugins');
const allowlistPath = path.join(repoRoot, 'src', 'config', 'complex-plugin-allowlist.json');
const tsGeneratedPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPlugins.ts');
const tsGeneratedNetworkHandlersPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPluginNetworkHandlers.ts');
const tsGeneratedUploadHandlersPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPluginUploadHandlers.ts');
const rustGeneratedPath = path.join(repoRoot, 'src-tauri', 'src', 'generated_builtin_plugins.rs');
const rustSlicerGeneratedEncodersPath = path.join(repoRoot, 'rust', 'dragonfruit-slicer-v3', 'src', 'encoders', 'generated_plugin_encoders.rs');

function toImportAlias(pluginId) {
      return `${pluginId.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^([0-9])/, '_$1')}Definition`;
}

async function discoverPlugins() {
      const entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
      const pluginIds = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .filter((name) => !name.startsWith('.'))
            .sort((a, b) => a.localeCompare(b));

      const discovered = [];

      for (const pluginId of pluginIds) {
            const pluginDir = path.join(pluginsRoot, pluginId);
            const pluginDefinitionPath = path.join(pluginDir, 'pluginDefinition.ts');
            const rustPluginPath = path.join(pluginDir, 'rust', 'plugin.rs');
            const rustNetworkPath = path.join(pluginDir, 'rust', 'network.rs');
            const tsNetworkHandlerPath = path.join(pluginDir, 'network', 'nanodlpHandlers.ts');
            const tsUploadHandlerPath = path.join(pluginDir, 'network', 'index.ts');
            const rustSlicerEncoderPath = path.join(pluginDir, 'slicing', 'rust', 'encoder_impl.rs');

            const hasPluginDefinition = await fs.access(pluginDefinitionPath).then(() => true).catch(() => false);
            if (!hasPluginDefinition) continue;

            const hasRustPlugin = await fs.access(rustPluginPath).then(() => true).catch(() => false);
            const hasRustNetwork = await fs.access(rustNetworkPath).then(() => true).catch(() => false);
            const hasTsNetworkHandler = await fs.access(tsNetworkHandlerPath).then(() => true).catch(() => false);
            const hasTsUploadHandler = await fs.access(tsUploadHandlerPath).then(() => true).catch(() => false);
            const hasRustSlicingEncoder = await fs.access(rustSlicerEncoderPath).then(() => true).catch(() => false);

            discovered.push({
                  id: pluginId,
                  hasRustPlugin,
                  hasRustNetwork,
                  hasTsNetworkHandler,
                  hasTsUploadHandler,
                  hasRustSlicingEncoder,
            });
      }

      return discovered;
}

async function readAllowlist() {
      const raw = await fs.readFile(allowlistPath, 'utf8');
      const parsed = JSON.parse(raw);
      const allowlisted = Array.isArray(parsed?.builtinComplexPlugins)
            ? parsed.builtinComplexPlugins
                  .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
                  .filter((id) => id.length > 0)
            : [];

      if (allowlisted.length === 0) {
            throw new Error('[plugin-registry] Allowlist is empty. Add entries to src/config/complex-plugin-allowlist.json');
      }

      return {
            raw,
            ids: Array.from(new Set(allowlisted)).sort((a, b) => a.localeCompare(b)),
      };
}

function enforceAllowlist(discovered, allowlistIds) {
      const discoveredIds = new Set(discovered.map((entry) => entry.id));
      const allowlistedIds = new Set(allowlistIds);

      const discoveredButUnallowlisted = discovered
            .filter((entry) => !allowlistedIds.has(entry.id))
            .map((entry) => entry.id)
            .sort((a, b) => a.localeCompare(b));

      if (discoveredButUnallowlisted.length > 0) {
            throw new Error(
                  `[plugin-registry] Discovered plugin(s) not in allowlist: ${discoveredButUnallowlisted.join(', ')}`,
            );
      }

      const allowlistedButMissing = allowlistIds
            .filter((id) => !discoveredIds.has(id));

      if (allowlistedButMissing.length > 0) {
            throw new Error(
                  `[plugin-registry] Allowlisted plugin(s) missing pluginDefinition.ts: ${allowlistedButMissing.join(', ')}`,
            );
      }
}

function computeAllowlistHash(rawAllowlistJson) {
      return createHash('sha256').update(rawAllowlistJson, 'utf8').digest('hex');
}

function buildTsGeneratedFile(discovered, allowlistHash) {
      const imports = discovered
            .map((plugin) => {
                  const alias = toImportAlias(plugin.id);
                  return `import ${alias} from '../../../plugins/${plugin.id}/pluginDefinition';`;
            })
            .join('\n');

      const definitions = discovered
            .map((plugin) => toImportAlias(plugin.id))
            .join(',\n  ');

      const allowlist = discovered.map((plugin) => `'${plugin.id}'`).join(',\n  ');

      return `/* AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated by scripts/generate-plugin-registry.mjs
 */
import type { ComplexPluginDefinition } from '@/features/plugins/complexPluginContracts';
${imports ? `${imports}\n` : ''}
export const GENERATED_BUILTIN_COMPLEX_PLUGIN_ID_ALLOWLIST = Object.freeze([
  ${allowlist}
]) as readonly string[];

export const GENERATED_COMPLEX_PLUGIN_ALLOWLIST_SHA256 = '${allowlistHash}' as const;

export const GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS: ComplexPluginDefinition[] = [
  ${definitions}
];
`;
}

function buildTsGeneratedNetworkHandlersFile(discovered) {
      const networkCapable = discovered.filter((plugin) => plugin.hasTsNetworkHandler);

      const imports = networkCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `import { handlePluginNetworkOperation as ${safe}_network_handler } from '../../../plugins/${plugin.id}/network/nanodlpHandlers';`;
            })
            .join('\n');

      const entries = networkCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `  { pluginId: '${plugin.id}', handler: ${safe}_network_handler }`;
            })
            .join(',\n');

      return `/* AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated by scripts/generate-plugin-registry.mjs
 */
import type { PluginNetworkOperationHandler } from '@/features/plugins/networkPluginRegistry';
${imports ? `${imports}\n` : ''}
export type GeneratedBuiltinComplexPluginNetworkHandler = {
  pluginId: string;
  handler: PluginNetworkOperationHandler;
};

export const GENERATED_BUILTIN_COMPLEX_PLUGIN_NETWORK_HANDLERS: GeneratedBuiltinComplexPluginNetworkHandler[] = [
${entries}
];
`;
}

function buildTsGeneratedUploadHandlersFile(discovered) {
      const uploadCapable = discovered.filter((plugin) => plugin.hasTsUploadHandler);

      const imports = uploadCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `import { uploadPrintJobWithProgress as ${safe}_upload_handler } from '../../../plugins/${plugin.id}/network';`;
            })
            .join('\n');

      const entries = uploadCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `  { pluginId: '${plugin.id}', handler: ${safe}_upload_handler }`;
            })
            .join(',\n');

      return `/* AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated by scripts/generate-plugin-registry.mjs
 */
import type { PluginUploadHandler } from '@/features/plugins/pluginUploadBridge';
${imports ? `${imports}\n` : ''}
export type GeneratedBuiltinComplexPluginUploadHandler = {
  pluginId: string;
  handler: PluginUploadHandler;
};

export const GENERATED_BUILTIN_COMPLEX_PLUGIN_UPLOAD_HANDLERS: GeneratedBuiltinComplexPluginUploadHandler[] = [
${entries}
];
`;
}

function buildRustGeneratedFile(discovered, allowlistHash) {
      const rustCapable = discovered.filter((plugin) => plugin.hasRustPlugin && plugin.hasRustNetwork);

      const pathModules = rustCapable
            .flatMap((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return [
                        `#[path = "../../plugins/${plugin.id}/rust/plugin.rs"]`,
                        `pub mod ${safe}_plugin;`,
                        '',
                        `#[path = "../../plugins/${plugin.id}/rust/network.rs"]`,
                        `pub mod ${safe}_network;`,
                  ];
            })
            .join('\n');

      const registerCalls = rustCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `    register_plugin(${safe}_plugin::get_plugin_registration())?;`;
            })
            .join('\n');

      const dispatchArms = rustCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `        "${plugin.id}" => {
            let response = ${safe}_network::dispatch_plugin_network_request(request_json).await?;
            Ok(Some(PluginNetworkResponse {
                status: response.status,
                body: response.body,
            }))
        }`;
            })
            .join(',\n');

      const ids = rustCapable.map((plugin) => `"${plugin.id}"`).join(', ');

      return `// AUTO-GENERATED FILE. DO NOT EDIT.
// Generated by scripts/generate-plugin-registry.mjs

use super::{PluginNetworkResponse, register_plugin};

${pathModules}

pub const GENERATED_BUILTIN_PLUGIN_IDS: &[&str] = &[${ids}];
pub const GENERATED_COMPLEX_PLUGIN_ALLOWLIST_SHA256: &str = "${allowlistHash}";

pub fn register_generated_plugins() -> Result<(), String> {
${registerCalls}
    Ok(())
}

pub async fn dispatch_generated_network_request(
    plugin_id: &str,
    request_json: String,
) -> Result<Option<PluginNetworkResponse>, String> {
    match plugin_id {
${dispatchArms}
        _ => Ok(None),
    }
}
`;
}

function buildRustSlicerGeneratedEncodersFile(discovered) {
      const encoderCapable = discovered.filter((plugin) => plugin.hasRustSlicingEncoder);

      const moduleImports = encoderCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `#[path = "../../../../plugins/${plugin.id}/slicing/rust/encoder_impl.rs"]\npub mod ${safe}_encoder;`;
            })
            .join('\n\n');

      const encoderItems = encoderCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `        ${safe}_encoder::create_plugin_encoder(),`;
            })
            .join('\n');

      return `// AUTO-GENERATED FILE. DO NOT EDIT.
// Generated by scripts/generate-plugin-registry.mjs

use crate::encoders::FormatEncoder;

${moduleImports}

pub fn build_generated_plugin_encoders() -> Vec<Box<dyn FormatEncoder>> {
    vec![
${encoderItems}
    ]
}
`;
}

async function ensureParent(filePath) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function main() {
      const discovered = await discoverPlugins();
      const allowlist = await readAllowlist();
      enforceAllowlist(discovered, allowlist.ids);

      const filteredDiscovered = discovered
            .filter((entry) => allowlist.ids.includes(entry.id))
            .sort((a, b) => a.id.localeCompare(b.id));

      const allowlistHash = computeAllowlistHash(allowlist.raw);
      const tsSource = buildTsGeneratedFile(filteredDiscovered, allowlistHash);
      const tsNetworkHandlersSource = buildTsGeneratedNetworkHandlersFile(filteredDiscovered);
      const tsUploadHandlersSource = buildTsGeneratedUploadHandlersFile(filteredDiscovered);
      const rustSource = buildRustGeneratedFile(filteredDiscovered, allowlistHash);
      const rustSlicerEncodersSource = buildRustSlicerGeneratedEncodersFile(filteredDiscovered);

      await ensureParent(tsGeneratedPath);
      await ensureParent(tsGeneratedNetworkHandlersPath);
      await ensureParent(tsGeneratedUploadHandlersPath);
      await ensureParent(rustGeneratedPath);
      await ensureParent(rustSlicerGeneratedEncodersPath);

      await fs.writeFile(tsGeneratedPath, tsSource, 'utf8');
      await fs.writeFile(tsGeneratedNetworkHandlersPath, tsNetworkHandlersSource, 'utf8');
      await fs.writeFile(tsGeneratedUploadHandlersPath, tsUploadHandlersSource, 'utf8');
      await fs.writeFile(rustGeneratedPath, rustSource, 'utf8');
      await fs.writeFile(rustSlicerGeneratedEncodersPath, rustSlicerEncodersSource, 'utf8');

      console.log(`[plugin-registry] Generated TS+Rust plugin registry for ${filteredDiscovered.length} plugin(s).`);
      console.log(`[plugin-registry] Allowlist SHA256: ${allowlistHash}`);
}

main().catch((error) => {
      console.error('[plugin-registry] Failed to generate plugin registry files.', error);
      process.exitCode = 1;
});
