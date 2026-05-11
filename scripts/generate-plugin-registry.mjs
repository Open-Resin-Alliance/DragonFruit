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
const tsGeneratedFileTypeHandlersPath = path.join(repoRoot, 'src', 'features', 'plugins', 'generatedBuiltinComplexPluginFileTypeHandlers.ts');
const rustGeneratedPath = path.join(repoRoot, 'src-tauri', 'src', 'generated_builtin_plugins.rs');
const rustSlicerGeneratedEncodersPath = path.join(repoRoot, 'rust', 'dragonfruit-slicing-engine', 'src', 'encoders', 'generated_plugin_encoders.rs');
const cargoAuditPath = path.join(repoRoot, 'src-tauri', 'generated_crate_requirements.toml');

function toImportAlias(pluginId) {
      return `${pluginId.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^([0-9])/, '_$1')}Definition`;
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

function enforceCapabilityConsistency(discovered) {
      for (const plugin of discovered) {
            const { id, capabilities } = plugin;

            if (!capabilities.hasCapabilityBlock) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" must declare a capabilities block in pluginDefinition.ts`,
                  );
            }

            if (capabilities.networkOperations && !plugin.hasTsNetworkHandler) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" declares networkOperations=true but is missing network/networkHandlers.ts`,
                  );
            }

            if (!capabilities.networkOperations && plugin.hasTsNetworkHandler) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" has network/networkHandlers.ts but capabilities.networkOperations is not true`,
                  );
            }

            if (capabilities.uploadWithProgress && !plugin.hasTsUploadHandler) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" declares uploadWithProgress=true but is missing network/index.ts`,
                  );
            }

            if (!capabilities.uploadWithProgress && plugin.hasTsUploadHandler) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" has network/index.ts but capabilities.uploadWithProgress is not true`,
                  );
            }

            if (capabilities.slicerEncoder && !plugin.hasRustSlicingEncoder) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" declares slicerEncoder=true but is missing slicing/rust/encoder_impl.rs`,
                  );
            }

            if (!capabilities.slicerEncoder && plugin.hasRustSlicingEncoder) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" has slicing/rust/encoder_impl.rs but capabilities.slicerEncoder is not true`,
                  );
            }

            if (capabilities.slicerEncoder && plugin.hasFormatsJson && plugin.formatsMetadata) {
                  enforceFormatsJsonConsistency(id, plugin.formatsMetadata);
            }

            const hasAnyTauriFile = plugin.hasRustPlugin || plugin.hasRustNetwork;
            if (capabilities.tauriRuntimePlugin && (!plugin.hasRustPlugin || !plugin.hasRustNetwork)) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" declares tauriRuntimePlugin=true but is missing rust/plugin.rs or rust/network.rs`,
                  );
            }

            if (!capabilities.tauriRuntimePlugin && hasAnyTauriFile) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" has rust/plugin.rs or rust/network.rs but capabilities.tauriRuntimePlugin is not true`,
                  );
            }

            if (capabilities.fileType && !plugin.hasTsFileTypeHandler) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" declares fileType=true but is missing fileTypeHandlers.ts`,
                  );
            }

            if (!capabilities.fileType && plugin.hasTsFileTypeHandler) {
                  throw new Error(
                        `[plugin-registry] Plugin "${id}" has fileTypeHandlers.ts but capabilities.fileType is not true`,
                  );
            }
      }
}

function enforceFormatsJsonConsistency(pluginId, formatsMetadata) {
      if (!formatsMetadata || typeof formatsMetadata !== 'object') {
            return;
      }

      const allExtensions = new Set();
      for (const [formatType, formatData] of Object.entries(formatsMetadata)) {
            if (!Array.isArray(formatData?.extensions)) {
                  throw new Error(
                        `[plugin-registry] Plugin "${pluginId}" formats.json format "${formatType}" must declare extensions array`,
                  );
            }

            for (const ext of formatData.extensions) {
                  if (typeof ext !== 'string' || !ext.startsWith('.')) {
                        throw new Error(
                              `[plugin-registry] Plugin "${pluginId}" formats.json extension "${ext}" must be a string starting with "."`,
                        );
                  }

                  if (allExtensions.has(ext)) {
                        throw new Error(
                              `[plugin-registry] Plugin "${pluginId}" formats.json declares duplicate extension "${ext}"`,
                        );
                  }
                  allExtensions.add(ext);
            }
      }
}

// Parse requiredCrates.toml format: simple TOML-like sections
function parseRequiredCratesToml(tomlContent, pluginId) {
      const result = { dependencies: {}, optionalDependencies: {}, features: {}, notes: {} };
      let currentSection = null;

      for (const line of tomlContent.split('\n')) {
            const trimmed = line.trim();

            // Skip comments and empty lines
            if (!trimmed || trimmed.startsWith('#')) continue;

            // Detect section headers like [dependencies], [optional-dependencies], etc.
            const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
            if (sectionMatch) {
                  const section = sectionMatch[1];
                  if (section === 'dependencies') currentSection = 'dependencies';
                  else if (section === 'optional-dependencies') currentSection = 'optionalDependencies';
                  else if (section === 'features') currentSection = 'features';
                  else if (section === 'notes') currentSection = 'notes';
                  continue;
            }

            // Parse key = value pairs
            const kvMatch = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
            if (kvMatch && currentSection) {
                  const [, key, value] = kvMatch;
                  let cleanValue = value.trim();

                  // Handle quoted strings
                  if ((cleanValue.startsWith('"') && cleanValue.endsWith('"')) ||
                        (cleanValue.startsWith("'") && cleanValue.endsWith("'"))) {
                        cleanValue = cleanValue.slice(1, -1);
                  }

                  // Validate semver for dependencies
                  if ((currentSection === 'dependencies' || currentSection === 'optionalDependencies') &&
                        !/^(?:\^|~|>=|<=|>|<|=)?[\d.x*]+/.test(cleanValue.trim())) {
                        throw new Error(`[plugin-registry] Plugin "${pluginId}" requiredCrates.toml: crate "${key}" version "${cleanValue}" is not valid semver`);
                  }

                  result[currentSection][key] = cleanValue;
            }
      }

      return result;
}

// Enforce strict version conflict detection across all plugins
function enforceCargoDepConsistency(discovered) {
      const allCrateDeps = {};
      const crateOrigins = {};

      for (const plugin of discovered) {
            if (!plugin.hasRequiredCrates || !plugin.requiredCratesMetadata) continue;

            const { dependencies = {}, optionalDependencies = {} } = plugin.requiredCratesMetadata;
            const allPluginDeps = { ...dependencies, ...optionalDependencies };

            for (const [crate, versionSpec] of Object.entries(allPluginDeps)) {
                  const cleanVersion = versionSpec.trim();

                  if (!allCrateDeps[crate]) {
                        allCrateDeps[crate] = cleanVersion;
                        crateOrigins[crate] = plugin.id;
                  } else if (allCrateDeps[crate] !== cleanVersion) {
                        throw new Error(
                              `[plugin-registry] Cargo crate conflict: "${crate}" version mismatch: plugin "${crateOrigins[crate]}" wants "${allCrateDeps[crate]}", plugin "${plugin.id}" wants "${cleanVersion}". Plugins must coordinate on compatible versions.`,
                        );
                  }
            }
      }

      return allCrateDeps;
}

// Build cargo audit file for transparency
function buildCargoAuditFile(discovered, mergedCargoDeps) {
      const lines = [
            '# AUTO-GENERATED FILE. DO NOT EDIT.',
            '# Generated by scripts/generate-plugin-registry.mjs',
            '#',
            '# This file documents all Cargo crate requirements declared by plugins.',
            '# It is merged into dragonfruit-slicer-v3/Cargo.toml during the build.',
            '# Keep this file for reference and auditing purposes.',
            '#',
      ];

      const pluginsWithDeps = discovered.filter((p) => p.hasRequiredCrates && p.requiredCratesMetadata);

      if (pluginsWithDeps.length === 0) {
            lines.push('# No plugins declare cargo crate requirements.');
            return lines.join('\n');
      }

      for (const plugin of pluginsWithDeps) {
            const { dependencies = {}, optionalDependencies = {} } = plugin.requiredCratesMetadata;
            if (Object.keys(dependencies).length === 0 && Object.keys(optionalDependencies).length === 0) {
                  continue;
            }

            lines.push(`# ${plugin.id}`);
            for (const [crate, version] of Object.entries(dependencies)) {
                  lines.push(`# ${crate} = "${version}"`);
            }
            for (const [crate, version] of Object.entries(optionalDependencies)) {
                  lines.push(`# ${crate} (optional) = "${version}"`);
            }
            lines.push('#');
      }

      lines.push('# Merged into dragonfruit-slicer-v3/Cargo.toml [dependencies]:');
      for (const [crate, version] of Object.entries(mergedCargoDeps)) {
            lines.push(`# ${crate} = "${version}"`);
      }

      return lines.join('\n');
}

// Merge plugin cargo dependencies into dragonfruit-slicer-v3/Cargo.toml
async function mergePluginCratesIntoCargoToml(mergedCargoDeps) {
      const cargoTomlPath = path.join(repoRoot, 'rust', 'dragonfruit-slicing-engine', 'Cargo.toml');
      let content = await fs.readFile(cargoTomlPath, 'utf8');

      // Find the [dependencies] section
      const depsSectionStart = content.indexOf('[dependencies]');
      if (depsSectionStart === -1) {
            throw new Error('dragonfruit-slicer-v3/Cargo.toml does not have a [dependencies] section');
      }

      // Find the next section (or end of file)
      const nextSectionStart = content.indexOf('\n[', depsSectionStart + 1);
      const depsSectionEnd = nextSectionStart === -1 ? content.length : nextSectionStart;

      // Parse existing deps to avoid duplicates
      const depsSection = content.substring(depsSectionStart, depsSectionEnd);
      const existingDeps = new Set();
      for (const line of depsSection.split('\n')) {
            const match = line.match(/^([a-zA-Z0-9_-]+)\s*=/);
            if (match) {
                  existingDeps.add(match[1]);
            }
      }

      // Collect new deps that don't already exist
      const newDeps = [];
      for (const [crate, version] of Object.entries(mergedCargoDeps)) {
            if (!existingDeps.has(crate)) {
                  newDeps.push(`${crate} = "${version}"`);
            }
      }

      // Append new deps if any
      if (newDeps.length > 0) {
            const insertPoint = depsSectionEnd;
            const newDepsStr = '\n' + newDeps.join('\n');
            const updatedContent = content.substring(0, insertPoint) + newDepsStr + content.substring(insertPoint);
            await fs.writeFile(cargoTomlPath, updatedContent, 'utf8');
            return newDeps.length;
      }

      return 0;
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
            const tsNetworkHandlerPath = path.join(pluginDir, 'network', 'networkHandlers.ts');
            const tsUploadHandlerPath = path.join(pluginDir, 'network', 'index.ts');
            const tsFileTypeHandlerPath = path.join(pluginDir, 'fileTypeHandlers.ts');
            const rustSlicerEncoderPath = path.join(pluginDir, 'slicing', 'rust', 'encoder_impl.rs');
            const formatsJsonPath = path.join(pluginDir, 'slicing', 'formats.json');
            const requiredCratesPath = path.join(pluginDir, 'slicing', 'rust', 'requiredCrates.toml');
            const hasPluginDefinition = await fs.access(pluginDefinitionPath).then(() => true).catch(() => false);
            if (!hasPluginDefinition) continue;

            const pluginDefinitionSource = await fs.readFile(pluginDefinitionPath, 'utf8');
            const capabilities = parseCapabilitiesFromPluginDefinitionSource(pluginDefinitionSource);

            const hasRustPlugin = await fs.access(rustPluginPath).then(() => true).catch(() => false);
            const hasRustNetwork = await fs.access(rustNetworkPath).then(() => true).catch(() => false);
            const hasTsNetworkHandler = await fs.access(tsNetworkHandlerPath).then(() => true).catch(() => false);
            const hasTsUploadHandler = await fs.access(tsUploadHandlerPath).then(() => true).catch(() => false);
            const hasRustSlicingEncoder = await fs.access(rustSlicerEncoderPath).then(() => true).catch(() => false);
            const hasTsFileTypeHandler = await fs.access(tsFileTypeHandlerPath).then(() => true).catch(() => false);

            // Extract file extensions (without leading dot) from the pluginDefinition source for Rust generation.
            // Matches fileExtension: '.ext' or fileExtension: ".ext" patterns.
            const fileTypeExtensions = capabilities.fileType
                  ? [...pluginDefinitionSource.matchAll(/fileExtension\s*:\s*['"]\.([a-zA-Z0-9]+)['"]/g)]
                        .map((m) => m[1].toLowerCase())
                  : [];

            let formatsMetadata = null;
            const hasFormatsJson = await fs.access(formatsJsonPath).then(() => true).catch(() => false);
            if (hasFormatsJson) {
                  try {
                        const formatsJsonContent = await fs.readFile(formatsJsonPath, 'utf8');
                        formatsMetadata = JSON.parse(formatsJsonContent);
                  } catch (err) {
                        throw new Error(`[plugin-registry] Plugin "${pluginId}" formats.json is not valid JSON: ${err.message}`);
                  }
            }

            let requiredCratesMetadata = null;
            const hasRequiredCrates = await fs.access(requiredCratesPath).then(() => true).catch(() => false);
            if (hasRequiredCrates) {
                  try {
                        const requiredCratesContent = await fs.readFile(requiredCratesPath, 'utf8');
                        requiredCratesMetadata = parseRequiredCratesToml(requiredCratesContent, pluginId);
                  } catch (err) {
                        throw new Error(`[plugin-registry] Plugin "${pluginId}" requiredCrates.toml parsing failed: ${err.message}`);
                  }
            }

            discovered.push({
                  id: pluginId,
                  hasRustPlugin,
                  hasRustNetwork,
                  hasTsNetworkHandler,
                  hasTsUploadHandler,
                  hasRustSlicingEncoder,
                  hasTsFileTypeHandler,
                  fileTypeExtensions,
                  capabilities,
                  hasFormatsJson,
                  formatsMetadata,
                  hasRequiredCrates,
                  requiredCratesMetadata,
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

      return {
            allowlistedButMissing,
      };
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
      const networkCapable = discovered.filter((plugin) => plugin.capabilities.networkOperations && plugin.hasTsNetworkHandler);

      const imports = networkCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `import { handlePluginNetworkOperation as ${safe}_network_handler } from '../../../plugins/${plugin.id}/network/networkHandlers';`;
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
      const uploadCapable = discovered.filter((plugin) => plugin.capabilities.uploadWithProgress && plugin.hasTsUploadHandler);

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

function buildTsGeneratedFileTypeHandlersFile(discovered) {
      const fileTypeCapable = discovered.filter((plugin) => plugin.capabilities.fileType && plugin.hasTsFileTypeHandler);

      const imports = fileTypeCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `import { handleFileTypeImport as ${safe}_file_type_handler } from '../../../plugins/${plugin.id}/fileTypeHandlers';`;
            })
            .join('\n');

      const entries = fileTypeCapable
            .map((plugin) => {
                  const safe = plugin.id.replace(/[^a-zA-Z0-9]+/g, '_');
                  return `  { pluginId: '${plugin.id}', handler: ${safe}_file_type_handler }`;
            })
            .join(',\n');

      return `/* AUTO-GENERATED FILE. DO NOT EDIT.
 * Generated by scripts/generate-plugin-registry.mjs
 */
import type { PluginFileTypeHandler } from '@/features/plugins/pluginFileTypeBridge';
${imports ? `${imports}\n` : ''}
export type GeneratedBuiltinComplexPluginFileTypeHandler = {
  pluginId: string;
  handler: PluginFileTypeHandler;
};

export const GENERATED_BUILTIN_COMPLEX_PLUGIN_FILE_TYPE_HANDLERS: GeneratedBuiltinComplexPluginFileTypeHandler[] = [
${entries}
];
`;
}

function buildRustGeneratedFile(discovered, allowlistHash) {
      const rustCapable = discovered.filter((plugin) => plugin.capabilities.tauriRuntimePlugin && plugin.hasRustPlugin && plugin.hasRustNetwork);

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

      // Collect all scene file extensions from fileType-capable plugins (de-duplicated, sorted)
      const allSceneExts = [...new Set(
            discovered
                  .filter((p) => p.capabilities.fileType && p.fileTypeExtensions.length > 0)
                  .flatMap((p) => p.fileTypeExtensions),
      )].sort();
      const sceneExtsLiteral = allSceneExts.map((e) => `"${e}"`).join(', ');

      return `// AUTO-GENERATED FILE. DO NOT EDIT.
// Generated by scripts/generate-plugin-registry.mjs

use super::{PluginNetworkResponse, register_plugin};

${pathModules}

#[allow(dead_code)]
pub const GENERATED_BUILTIN_PLUGIN_IDS: &[&str] = &[${ids}];
pub const GENERATED_COMPLEX_PLUGIN_ALLOWLIST_SHA256: &str = "${allowlistHash}";
/// Scene file extensions contributed by built-in fileType plugins (without leading dot).
pub const GENERATED_BUILTIN_PLUGIN_SCENE_FILE_EXTENSIONS: &[&str] = &[${sceneExtsLiteral}];

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
      const encoderCapable = discovered.filter((plugin) => plugin.capabilities.slicerEncoder && plugin.hasRustSlicingEncoder);

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
    [
${encoderItems}
    ]
    .into_iter()
    .flat_map(|encoders| encoders)
    .collect()
}
`;
}

async function ensureParent(filePath) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function writeFileIfChanged(filePath, content) {
      let existing = null;
      try {
            existing = await fs.readFile(filePath, 'utf8');
      } catch {
            // File does not exist yet; we'll create it below.
      }

      if (existing === content) {
            return false;
      }

      await fs.writeFile(filePath, content, 'utf8');
      return true;
}

async function main() {
      const discovered = await discoverPlugins();
      const allowlist = await readAllowlist();
      const allowlistResult = enforceAllowlist(discovered, allowlist.ids);
      enforceCapabilityConsistency(discovered);

      if (allowlistResult.allowlistedButMissing.length > 0) {
            console.warn(
                  `[plugin-registry] Warning: allowlisted plugin(s) missing locally (likely uninitialized submodule): ${allowlistResult.allowlistedButMissing.join(', ')}`,
            );
            console.warn('[plugin-registry] Continuing with locally available complex plugins only.');
      }

      const filteredDiscovered = discovered
            .filter((entry) => allowlist.ids.includes(entry.id))
            .sort((a, b) => a.id.localeCompare(b.id));

      const allowlistHash = computeAllowlistHash(allowlist.raw);
      const tsSource = buildTsGeneratedFile(filteredDiscovered, allowlistHash);
      const tsNetworkHandlersSource = buildTsGeneratedNetworkHandlersFile(filteredDiscovered);
      const tsUploadHandlersSource = buildTsGeneratedUploadHandlersFile(filteredDiscovered);
      const tsFileTypeHandlersSource = buildTsGeneratedFileTypeHandlersFile(filteredDiscovered);
      const rustSource = buildRustGeneratedFile(filteredDiscovered, allowlistHash);
      const rustSlicerEncodersSource = buildRustSlicerGeneratedEncodersFile(filteredDiscovered);

      // Phase 2: Cargo dependency automation
      let mergedCargoDeps = {};
      if (filteredDiscovered.some((p) => p.hasRequiredCrates)) {
            mergedCargoDeps = enforceCargoDepConsistency(filteredDiscovered);
            const numMergedDeps = await mergePluginCratesIntoCargoToml(mergedCargoDeps);
            console.log(`[plugin-registry] Merged ${numMergedDeps} cargo crate(s) into dragonfruit-slicer-v3/Cargo.toml`);
      }

      // Generate cargo audit file for transparency
      const cargoAuditContent = buildCargoAuditFile(filteredDiscovered, mergedCargoDeps);

      await ensureParent(tsGeneratedPath);
      await ensureParent(tsGeneratedNetworkHandlersPath);
      await ensureParent(tsGeneratedUploadHandlersPath);
      await ensureParent(tsGeneratedFileTypeHandlersPath);
      await ensureParent(rustGeneratedPath);
      await ensureParent(rustSlicerGeneratedEncodersPath);
      await ensureParent(cargoAuditPath);

      let changedFiles = 0;
      if (await writeFileIfChanged(tsGeneratedPath, tsSource)) changedFiles += 1;
      if (await writeFileIfChanged(tsGeneratedNetworkHandlersPath, tsNetworkHandlersSource)) changedFiles += 1;
      if (await writeFileIfChanged(tsGeneratedUploadHandlersPath, tsUploadHandlersSource)) changedFiles += 1;
      if (await writeFileIfChanged(tsGeneratedFileTypeHandlersPath, tsFileTypeHandlersSource)) changedFiles += 1;
      if (await writeFileIfChanged(rustGeneratedPath, rustSource)) changedFiles += 1;
      if (await writeFileIfChanged(rustSlicerGeneratedEncodersPath, rustSlicerEncodersSource)) changedFiles += 1;
      if (await writeFileIfChanged(cargoAuditPath, cargoAuditContent)) changedFiles += 1;

      console.log(`[plugin-registry] Generated TS+Rust plugin registry for ${filteredDiscovered.length} plugin(s).`);
      console.log(`[plugin-registry] Updated ${changedFiles} generated file(s).`);
      console.log(`[plugin-registry] Allowlist SHA256: ${allowlistHash}`);
}

main().catch((error) => {
      console.error('[plugin-registry] Failed to generate plugin registry files.', error);
      process.exitCode = 1;
});
