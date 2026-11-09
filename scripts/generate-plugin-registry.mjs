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
const coreOutputFileTypesPath = path.join(repoRoot, 'src', 'config', 'core-output-file-types.json');
// The shell thumbnail providers are native and cannot load plugin code, so the file
// types every plugin writes are compiled into one table the providers read: the
// Windows COM DLL and the CLI `include_str!` it, and the QuickLook extension is
// shipped the same bytes. Regenerate with `npm run generate:plugin-registry`.
const providerOutputFileTypesPath = path.join(
      repoRoot,
      'rust',
      'dragonfruit-voxl-thumbnail',
      'src',
      'generated_output_file_types.json',
);
// The platform registrations are generated from the same declarations, so a new
// container reaches Explorer, Finder and the freedesktop thumbnailers without any of
// these files being edited by hand. Everything under a `generated/` directory, plus
// `**/generated*`, is gitignored: regenerate before building.
const generatedDir = path.join(repoRoot, 'rust', 'dragonfruit-voxl-thumbnail', 'generated');
const linuxMimePath = path.join(generatedDir, 'dragonfruit-mime.xml');
const linuxThumbnailerPath = path.join(generatedDir, 'dragonfruit.thumbnailer');
const macosInfoPlistPath = path.join(generatedDir, 'VoxlThumbnailExtension-Info.plist');
const macosExportedUtisPath = path.join(generatedDir, 'macos-exported-utis.plist');
const slicerEngineDir = path.join(repoRoot, 'rust', 'dragonfruit-slicing-engine');

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

// Resolve one dependency value. A plain value is a semver spec; an inline table
// with `path` points into the plugin's own checkout, which is how a plugin whose
// encoder needs a crate that is not on crates.io declares it. Returns either the
// version string or `{ path, absolute }`, and throws on anything else.
function parseDependencyValue(rawValue, key, pluginId, tomlDir) {
      const cleanValue = rawValue.trim();

      const pathTable = cleanValue.match(/^\{\s*path\s*=\s*(.+?)\s*,?\s*\}$/);
      if (pathTable) {
            let declared = pathTable[1].trim();
            if ((declared.startsWith('"') && declared.endsWith('"')) ||
                  (declared.startsWith("'") && declared.endsWith("'"))) {
                  declared = declared.slice(1, -1);
            }
            if (!declared) {
                  throw new Error(`[plugin-registry] Plugin "${pluginId}" requiredCrates.toml: crate "${key}" has an empty path`);
            }
            return { path: declared, absolute: path.resolve(tomlDir, declared) };
      }

      if (cleanValue.startsWith('{')) {
            throw new Error(`[plugin-registry] Plugin "${pluginId}" requiredCrates.toml: crate "${key}" is an inline table this registry understands only as { path = "..." }`);
      }

      let versionValue = cleanValue;
      if ((versionValue.startsWith('"') && versionValue.endsWith('"')) ||
            (versionValue.startsWith("'") && versionValue.endsWith("'"))) {
            versionValue = versionValue.slice(1, -1);
      }

      if (!/^(?:\^|~|>=|<=|>|<|=)?[\d.x*]+/.test(versionValue.trim())) {
            throw new Error(`[plugin-registry] Plugin "${pluginId}" requiredCrates.toml: crate "${key}" version "${versionValue}" is not valid semver`);
      }

      return versionValue;
}

// Parse requiredCrates.toml format: simple TOML-like sections
function parseRequiredCratesToml(tomlContent, pluginId, tomlDir) {
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

                  if (currentSection === 'dependencies' || currentSection === 'optionalDependencies') {
                        result[currentSection][key] = parseDependencyValue(value, key, pluginId, tomlDir);
                        continue;
                  }

                  let cleanValue = value.trim();
                  if ((cleanValue.startsWith('"') && cleanValue.endsWith('"')) ||
                        (cleanValue.startsWith("'") && cleanValue.endsWith("'"))) {
                        cleanValue = cleanValue.slice(1, -1);
                  }
                  result[currentSection][key] = cleanValue;
            }
      }

      return result;
}

function describeCargoDep(spec) {
      return typeof spec === 'string' ? `version ${spec}` : `path ${spec.path}`;
}

// Enforce strict version conflict detection across all plugins
async function enforceCargoDepConsistency(discovered) {
      const allCrateDeps = {};
      const crateOrigins = {};

      for (const plugin of discovered) {
            if (!plugin.hasRequiredCrates || !plugin.requiredCratesMetadata) continue;

            const { dependencies = {}, optionalDependencies = {} } = plugin.requiredCratesMetadata;
            const allPluginDeps = { ...dependencies, ...optionalDependencies };

            for (const [crate, spec] of Object.entries(allPluginDeps)) {
                  const cleanSpec = typeof spec === 'string' ? spec.trim() : spec;

                  // A version is resolved by cargo; a path is resolved here, so a path
                  // that points nowhere has to fail now rather than as a cargo error in
                  // a build that names the engine rather than the plugin that asked.
                  if (typeof cleanSpec === 'object') {
                        const exists = await fs.access(cleanSpec.absolute).then(() => true).catch(() => false);
                        if (!exists) {
                              throw new Error(
                                    `[plugin-registry] Plugin "${plugin.id}" requiredCrates.toml: crate "${crate}" path "${cleanSpec.path}" does not exist (resolved to "${cleanSpec.absolute}")`,
                              );
                        }
                  }

                  if (!allCrateDeps[crate]) {
                        allCrateDeps[crate] = cleanSpec;
                        crateOrigins[crate] = plugin.id;
                        continue;
                  }

                  if (typeof allCrateDeps[crate] !== typeof cleanSpec
                        || (typeof cleanSpec === 'string' && allCrateDeps[crate] !== cleanSpec)
                        || (typeof cleanSpec === 'object' && allCrateDeps[crate].absolute !== cleanSpec.absolute)) {
                        throw new Error(
                              `[plugin-registry] Cargo crate conflict: "${crate}" is required differently: plugin "${crateOrigins[crate]}" wants ${describeCargoDep(allCrateDeps[crate])}, plugin "${plugin.id}" wants ${describeCargoDep(cleanSpec)}. Plugins must coordinate on one source.`,
                        );
                  }
            }
      }

      return allCrateDeps;
}

// A dependency as the audit file spells it. The per-plugin section repeats what the
// plugin declared; the merged section has to show the path the manifest actually
// carries, which is relative to the engine crate.
function formatCargoDepForAudit(spec, { asMerged = false } = {}) {
      if (typeof spec === 'string') return `"${spec}"`;
      if (!asMerged) return `{ path = "${spec.path}" }`;
      const relative = path.relative(slicerEngineDir, spec.absolute).split(path.sep).join('/');
      return `{ path = "${relative}" }`;
}

// Build cargo audit file for transparency
function buildCargoAuditFile(discovered, mergedCargoDeps) {
      const lines = [
            '# AUTO-GENERATED FILE. DO NOT EDIT.',
            '# Generated by scripts/generate-plugin-registry.mjs',
            '#',
            '# This file documents all Cargo crate requirements declared by plugins.',
            '# It is merged into dragonfruit-slicing-engine/Cargo.toml during the build.',
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
            for (const [crate, spec] of Object.entries(dependencies)) {
                  lines.push(`# ${crate} = ${formatCargoDepForAudit(spec)}`);
            }
            for (const [crate, spec] of Object.entries(optionalDependencies)) {
                  lines.push(`# ${crate} (optional) = ${formatCargoDepForAudit(spec)}`);
            }
            lines.push('#');
      }

      lines.push('# Merged into dragonfruit-slicing-engine/Cargo.toml [dependencies]:');
      for (const [crate, spec] of Object.entries(mergedCargoDeps)) {
            lines.push(`# ${crate} = ${formatCargoDepForAudit(spec, { asMerged: true })}`);
      }

      return lines.join('\n');
}

// Merge plugin cargo dependencies into dragonfruit-slicing-engine/Cargo.toml
async function mergePluginCratesIntoCargoToml(mergedCargoDeps) {
      const cargoTomlPath = path.join(repoRoot, 'rust', 'dragonfruit-slicing-engine', 'Cargo.toml');
      let content = await fs.readFile(cargoTomlPath, 'utf8');

      // Find the [dependencies] section
      const depsSectionStart = content.indexOf('[dependencies]');
      if (depsSectionStart === -1) {
            throw new Error('dragonfruit-slicing-engine/Cargo.toml does not have a [dependencies] section');
      }

      // Find the next section (or end of file)
      const nextSectionStart = content.indexOf('\n[', depsSectionStart + 1);
      const depsSectionEnd = nextSectionStart === -1 ? content.length : nextSectionStart;

      const engineDir = path.dirname(cargoTomlPath);

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
      for (const [crate, spec] of Object.entries(mergedCargoDeps)) {
            if (existingDeps.has(crate)) continue;

            if (typeof spec === 'string') {
                  newDeps.push(`${crate} = "${spec}"`);
                  continue;
            }

            // A plugin-relative path is rewritten against the engine crate, which is
            // the manifest cargo will actually read it from.
            const relative = path.relative(engineDir, spec.absolute).split(path.sep).join('/');
            newDeps.push(`${crate} = { path = "${relative}" }`);
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
                        requiredCratesMetadata = parseRequiredCratesToml(
                              requiredCratesContent,
                              pluginId,
                              path.dirname(requiredCratesPath),
                        );
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


const FIELD_WIDTHS = ['u16', 'u32', 'u64'];

function assertPositiveInt(value, what, pluginId) {
      if (!Number.isInteger(value) || value < 0) {
            throw new Error(`[plugin-registry] ${pluginId}: ${what} must be a non-negative integer`);
      }
}

function assertBinaryField(field, what, pluginId) {
      if (!field || typeof field !== 'object') {
            throw new Error(`[plugin-registry] ${pluginId}: ${what} is not a field descriptor`);
      }
      if (!FIELD_WIDTHS.includes(field.type)) {
            throw new Error(`[plugin-registry] ${pluginId}: ${what} has an unknown width "${field.type}"`);
      }
      assertPositiveInt(field.at, `${what}.at`, pluginId);
}

// The declaration is data a native reader interprets, so it is checked here rather
// than trusted: a wrong offset would surface as a missing thumbnail on a user's
// desktop, which is the hardest place to debug it.
function validateThumbnailLocator(locator, extension, pluginId) {
      const fail = (what) => {
            throw new Error(`[plugin-registry] ${pluginId}: ${extension} thumbnail ${what}`);
      };

      if (typeof locator?.magic !== 'string' || !/^[\x20-\x7e]{1,8}$/.test(locator.magic)) {
            fail('needs a printable ASCII magic');
      }
      if (locator.version) {
            assertBinaryField(locator.version, 'version', pluginId);
            if (locator.version.equals === undefined && locator.version.atLeast === undefined) {
                  fail('version states neither equals nor atLeast');
            }
      }

      const { directory, entry, previewChunks, payload } = locator;
      if (!directory || typeof directory !== 'object') fail('has no directory');
      const offsetIsFixed = Number.isInteger(directory.offset?.fixed);
      if (!offsetIsFixed) assertBinaryField(directory.offset, 'directory.offset', pluginId);
      if (offsetIsFixed) assertPositiveInt(directory.offset.fixed, 'directory.offset.fixed', pluginId);
      assertBinaryField(directory.count, 'directory.count', pluginId);
      assertPositiveInt(directory.entrySize, 'directory.entrySize', pluginId);
      if (directory.entrySize === 0) fail('has a zero entry size');

      if (!entry || typeof entry !== 'object') fail('has no entry layout');
      assertPositiveInt(entry.type?.at, 'entry.type.at', pluginId);
      assertBinaryField(entry.offset, 'entry.offset', pluginId);
      if (!Array.isArray(entry.size) || entry.size.length === 0) fail('has no size fields');
      entry.size.forEach((field, index) => assertBinaryField(field, `entry.size[${index}]`, pluginId));
      if (entry.index) {
            assertBinaryField(entry.index, 'entry.index', pluginId);
            assertPositiveInt(entry.index.value, 'entry.index.value', pluginId);
      }
      if (entry.compression) {
            assertBinaryField(entry.compression, 'entry.compression', pluginId);
            if (!Array.isArray(entry.compression.zlib) || entry.compression.zlib.length === 0) {
                  fail('lists no compression code as zlib');
            }
            if (entry.compression.stored !== undefined && !Array.isArray(entry.compression.stored)) {
                  fail('lists its stored compression codes as something other than an array');
            }
      }
      if (entry.flags) {
            assertBinaryField(entry.flags, 'entry.flags', pluginId);
            if (entry.flags.sealedBit !== undefined) assertPositiveInt(entry.flags.sealedBit, 'entry.flags.sealedBit', pluginId);
            if (entry.flags.roleMask !== undefined) assertPositiveInt(entry.flags.roleMask, 'entry.flags.roleMask', pluginId);
            if (entry.flags.roleOrder !== undefined && (!Array.isArray(entry.flags.roleOrder) || entry.flags.roleOrder.length === 0)) {
                  fail('lists an empty role order');
            }
      }

      if (!Array.isArray(previewChunks) || previewChunks.length === 0) fail('names no preview chunk');
      for (const chunk of previewChunks) {
            if (typeof chunk !== 'string' || !/^[\x20-\x7e]{1,4}$/.test(chunk)) fail('names a non-ASCII preview chunk');
      }

      if (payload?.encoding === 'png') {
            // Nothing further to describe.
      } else if (payload?.encoding === 'json-base64') {
            if (!Array.isArray(payload.jsonPath) || payload.jsonPath.length === 0 || payload.jsonPath.some((key) => typeof key !== 'string' || !key)) {
                  fail('has no JSON path to the base64 payload');
            }
      } else {
            fail(`has an unknown payload encoding "${payload?.encoding}"`);
      }

      if (locator.trailer) {
            if (typeof locator.trailer.magic !== 'string' || !/^[\x20-\x7e]{1,8}$/.test(locator.trailer.magic)) {
                  fail('has a non-ASCII trailer magic');
            }
            assertPositiveInt(locator.trailer.size, 'trailer.size', pluginId);
      }
}

function validateOutputFileType(entry, pluginId) {
      if (typeof entry?.fileExtension !== 'string' || !/^\.[a-z0-9][a-z0-9_-]*$/.test(entry.fileExtension)) {
            throw new Error(`[plugin-registry] ${pluginId}: "${entry?.fileExtension}" is not a lowercase file extension`);
      }
      for (const key of ['mimeType', 'uti', 'displayName']) {
            if (typeof entry[key] !== 'string' || !entry[key].trim()) {
                  throw new Error(`[plugin-registry] ${pluginId}: ${entry.fileExtension} has no ${key}`);
            }
      }
      validateThumbnailLocator(entry.thumbnail, entry.fileExtension, pluginId);
}

// The output file types every plugin writes, plus the core ones, in one table for
// the native providers. Extensions are unique: two formats claiming one extension
// would fight over the shell registration.
async function collectOutputFileTypes(discovered) {
      const sources = [{ pluginId: 'core', path: coreOutputFileTypesPath }];
      for (const plugin of discovered) {
            const candidate = path.join(pluginsRoot, plugin.id, 'outputFileTypes.json');
            const exists = await fs.access(candidate).then(() => true).catch(() => false);
            if (exists) sources.push({ pluginId: plugin.id, path: candidate });
      }

      const entries = [];
      const claimedBy = new Map();
      for (const source of sources) {
            let fileTypes;
            try {
                  fileTypes = JSON.parse(await fs.readFile(source.path, 'utf8'));
            } catch (error) {
                  throw new Error(`[plugin-registry] ${source.pluginId}: outputFileTypes.json is not readable JSON: ${error.message}`);
            }
            if (!Array.isArray(fileTypes)) {
                  throw new Error(`[plugin-registry] ${source.pluginId}: outputFileTypes.json is not an array`);
            }
            for (const entry of fileTypes) {
                  validateOutputFileType(entry, source.pluginId);
                  const claimed = claimedBy.get(entry.fileExtension);
                  if (claimed) {
                        throw new Error(`[plugin-registry] ${entry.fileExtension} is declared by both "${claimed}" and "${source.pluginId}"`);
                  }
                  claimedBy.set(entry.fileExtension, source.pluginId);
                  entries.push(entry);
            }
            if (fileTypes.length > 0) {
                  console.log(`[plugin-registry] ${source.pluginId} declares ${fileTypes.length} output file type(s): ${fileTypes.map((entry) => entry.fileExtension).join(', ')}`);
            }
      }

      // Core first, then plugins by id, then by extension: a stable order so the
      // generated table only changes when a declaration does.
      return entries.sort((a, b) => a.fileExtension.localeCompare(b.fileExtension));
}


/// The extension without its dot, e.g. `.lumen` becomes `lumen`.
function withoutDot(extension) {
      return extension.replace(/^\./, '');
}

/// The freedesktop alias for a declared type: the convention `application/x-<ext>`,
/// which is what file managers used for these extensions before the vendor types
/// existed, and what a user's `~/.config/mimeapps.list` may still name.
function freedesktopAlias(entry) {
      return `application/x-${withoutDot(entry.fileExtension)}`;
}

function buildLinuxMimeXml(entries) {
      const types = entries
            .map((entry) => {
                  const alias = freedesktopAlias(entry);
                  const aliasLine = alias === entry.mimeType ? '' : `\n    <alias type="${alias}"/>`;
                  return `  <mime-type type="${entry.mimeType}">
    <comment>${entry.displayName}</comment>${aliasLine}
    <glob pattern="*${entry.fileExtension}"/>
    <magic priority="50">
      <match type="string" offset="0" value="${entry.thumbnail.magic}"/>
    </magic>
  </mime-type>`;
            })
            .join('\n');

      return `<?xml version="1.0" encoding="utf-8"?>
<!-- AUTO-GENERATED FILE. DO NOT EDIT. Generated by scripts/generate-plugin-registry.mjs
     from the output file types declared by the core and by the plugins. -->
<mime-info xmlns="http://www.freedesktop.org/standards/shared-mime-info">
${types}
</mime-info>
`;
}

function buildLinuxThumbnailer(entries) {
      // One entry for every declared type: the freedesktop contract takes a MIME
      // list, and the binary dispatches on the file's own magic anyway.
      const mimeTypes = entries.map((entry) => `${entry.mimeType};`).join('');
      return `[Thumbnailer Entry]
# AUTO-GENERATED FILE. DO NOT EDIT. Generated by scripts/generate-plugin-registry.mjs
Exec=dragonfruit-voxl-thumbnailer %i %o %s
MimeType=${mimeTypes}
`;
}

/// The appex plist, with the declared UTIs wired into the keys the QuickLook system
/// reads. Generated so adding a container does not mean editing three arrays by hand.
function buildMacosAppexPlist(entries) {
      const supported = entries.map((entry) => `                <string>${entry.uti}</string>`).join('\n');

      const declarations = entries
            .map((entry) => `        <dict>
            <key>UTTypeConformsTo</key>
            <array>
                <string>public.data</string>
            </array>
            <key>UTTypeDescription</key>
            <string>${entry.displayName}</string>
            <key>UTTypeIdentifier</key>
            <string>${entry.uti}</string>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key>
                <array>
                    <string>${withoutDot(entry.fileExtension)}</string>
                </array>
                <key>public.mime-type</key>
                <array>
                    <string>${entry.mimeType}</string>
                </array>
            </dict>
        </dict>`)
            .join('\n');

      return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- AUTO-GENERATED FILE. DO NOT EDIT. Generated by scripts/generate-plugin-registry.mjs -->
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleDisplayName</key>
    <string>DragonFruit Thumbnail Extension</string>
    <key>CFBundleExecutable</key>
    <string>VoxlThumbnailExtension</string>
    <key>CFBundleIdentifier</key>
    <string>org.openresinalliance.dragonfruit.thumbnail-ext</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>VoxlThumbnailExtension</string>
    <key>CFBundlePackageType</key>
    <string>XPC!</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>

    <key>NSExtension</key>
    <dict>
        <key>NSExtensionPointIdentifier</key>
        <string>com.apple.quicklook.thumbnail</string>
        <key>NSExtensionPrincipalClass</key>
        <string>ThumbnailProvider</string>
        <key>NSExtensionAttributes</key>
        <dict>
            <key>QLSupportedContentTypes</key>
            <array>
${supported}
            </array>
        </dict>
    </dict>

    <key>UTImportedTypeDeclarations</key>
    <array>
${declarations}
    </array>
</dict>
</plist>
`;
}

/// The host application's exported types, for the development install path: Finder
/// maps the extension to the declared UTI only when something exports it.
function buildMacosExportedUtisPlist(entries) {
      const declarations = entries
            .map((entry) => `        <dict>
            <key>UTTypeConformsTo</key>
            <array>
                <string>public.data</string>
            </array>
            <key>UTTypeDescription</key>
            <string>${entry.displayName}</string>
            <key>UTTypeIdentifier</key>
            <string>${entry.uti}</string>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key>
                <array>
                    <string>${withoutDot(entry.fileExtension)}</string>
                </array>
                <key>public.mime-type</key>
                <array>
                    <string>${entry.mimeType}</string>
                </array>
            </dict>
        </dict>`)
            .join('\n');

      return `        <key>UTExportedTypeDeclarations</key>
        <array>
${declarations}
        </array>`;
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
            mergedCargoDeps = await enforceCargoDepConsistency(filteredDiscovered);
            const numMergedDeps = await mergePluginCratesIntoCargoToml(mergedCargoDeps);
            console.log(`[plugin-registry] Merged ${numMergedDeps} cargo crate(s) into dragonfruit-slicing-engine/Cargo.toml`);
      }

      // Generate cargo audit file for transparency
      const cargoAuditContent = buildCargoAuditFile(filteredDiscovered, mergedCargoDeps);

      // Output file types for the native shell providers
      const outputFileTypes = await collectOutputFileTypes(filteredDiscovered);
      const outputFileTypesSource = `${JSON.stringify(outputFileTypes, null, 2)}\n`;
      const linuxMimeSource = buildLinuxMimeXml(outputFileTypes);
      const linuxThumbnailerSource = buildLinuxThumbnailer(outputFileTypes);
      const macosInfoPlistSource = buildMacosAppexPlist(outputFileTypes);
      const macosExportedUtisSource = buildMacosExportedUtisPlist(outputFileTypes);

      await ensureParent(tsGeneratedPath);
      await ensureParent(tsGeneratedNetworkHandlersPath);
      await ensureParent(tsGeneratedUploadHandlersPath);
      await ensureParent(tsGeneratedFileTypeHandlersPath);
      await ensureParent(rustGeneratedPath);
      await ensureParent(rustSlicerGeneratedEncodersPath);
      await ensureParent(cargoAuditPath);
      await ensureParent(providerOutputFileTypesPath);
      await ensureParent(linuxMimePath);
      await ensureParent(linuxThumbnailerPath);
      await ensureParent(macosInfoPlistPath);
      await ensureParent(macosExportedUtisPath);

      let changedFiles = 0;
      if (await writeFileIfChanged(tsGeneratedPath, tsSource)) changedFiles += 1;
      if (await writeFileIfChanged(tsGeneratedNetworkHandlersPath, tsNetworkHandlersSource)) changedFiles += 1;
      if (await writeFileIfChanged(tsGeneratedUploadHandlersPath, tsUploadHandlersSource)) changedFiles += 1;
      if (await writeFileIfChanged(tsGeneratedFileTypeHandlersPath, tsFileTypeHandlersSource)) changedFiles += 1;
      if (await writeFileIfChanged(rustGeneratedPath, rustSource)) changedFiles += 1;
      if (await writeFileIfChanged(rustSlicerGeneratedEncodersPath, rustSlicerEncodersSource)) changedFiles += 1;
      if (await writeFileIfChanged(cargoAuditPath, cargoAuditContent)) changedFiles += 1;
      if (await writeFileIfChanged(providerOutputFileTypesPath, outputFileTypesSource)) changedFiles += 1;
      if (await writeFileIfChanged(linuxMimePath, linuxMimeSource)) changedFiles += 1;
      if (await writeFileIfChanged(linuxThumbnailerPath, linuxThumbnailerSource)) changedFiles += 1;
      if (await writeFileIfChanged(macosInfoPlistPath, macosInfoPlistSource)) changedFiles += 1;
      if (await writeFileIfChanged(macosExportedUtisPath, macosExportedUtisSource)) changedFiles += 1;

      console.log(`[plugin-registry] Generated TS+Rust plugin registry for ${filteredDiscovered.length} plugin(s).`);
      console.log(`[plugin-registry] Updated ${changedFiles} generated file(s).`);
      console.log(`[plugin-registry] Allowlist SHA256: ${allowlistHash}`);
}

main().catch((error) => {
      console.error('[plugin-registry] Failed to generate plugin registry files.', error);
      process.exitCode = 1;
});
