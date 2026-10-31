import { invoke } from '@tauri-apps/api/core';

/**
 * Sideloaded complex plugins — signed `.dfplugin` packages imported at runtime.
 *
 * The format and trust model live in `docs/dev/plugins-sideloaded.md`. This
 * module is the renderer half of the host commands in
 * `src-tauri/src/plugin_sideload.rs`; nothing here executes the plugin, it only
 * verifies, extracts and records what the host installed.
 */

export type SideloadedCapability = 'slicerEncoder' | 'networkOperations' | 'fileType';

export type SideloadedFormat = {
  id: string;
  extensions: string[];
  displayName?: string | null;
};

export type SideloadedManifest = {
  formatVersion: number;
  id: string;
  name: string;
  version: string;
  description?: string;
  vendor: { name: string; homepage?: string | null };
  minAppVersion: string;
  capabilities: SideloadedCapability[];
  entry: { kind: 'process'; proto: number; transport: 'shm' | 'pipe' };
  publisher: { key: string };
  payload: {
    sha256: string;
    bytes: number;
    seal?: { alg: string; kdf: string; salt: string; m: number; t: number; p: number } | null;
  };
  formats: SideloadedFormat[];
  /**
   * The network backend the package hosts. `mode` is what a printer profile
   * stores in `networkSupport`; the renderer turns the block into the same
   * adapter shape the compiled plugins register.
   */
  network?: {
    pluginId: string;
    mode?: string;
    displayName?: string;
    hostnames?: string[];
    operations?: Record<string, string | null | undefined>;
    remoteMaterials?: unknown;
  } | null;
  fileTypes?: Array<{ extension: string; displayName: string; isSceneFile?: boolean }>;
  /** Scene data the host bakes into a job when a settings path asks for it. */
  jobMetadataPayloads?: Array<{ settingPath: string; payloadPath: string; payload: string }>;
  /** Material pane schema per output format, in the compiled plugins' own shape. */
  materialSettings?: {
    byOutput?: Record<string, unknown>;
    byOutputAndMode?: Record<string, Record<string, unknown>>;
  };
  /** Printer presets the package contributes; the renderer normalises them. */
  printerPresets?: unknown[];
  /** Material templates the package contributes. */
  materialTemplates?: unknown[];
};

export type SideloadedInspect = {
  manifest: SideloadedManifest;
  publisherFingerprint: string;
  sealed: boolean;
  replacesExisting: boolean;
};

export type InstalledSideloadedPlugin = {
  manifest: SideloadedManifest;
  publisherFingerprint: string;
  importedAt: string;
  sealed: boolean;
};

export function getSideloadAllowance(): Promise<boolean> {
  return invoke<boolean>('sideloaded_plugin_allowance');
}

export function setSideloadAllowance(allow: boolean): Promise<boolean> {
  return invoke<boolean>('sideloaded_plugin_set_allowance', { allow });
}

/** Opens the file picker; resolves `null` when the user cancels. */
export function pickSideloadPackage(): Promise<string | null> {
  return invoke<string | null>('sideloaded_plugin_pick');
}

export function inspectSideloadPackage(path: string): Promise<SideloadedInspect> {
  return invoke<SideloadedInspect>('sideloaded_plugin_inspect', { path });
}

export function installSideloadPackage(
  path: string,
  passphrase?: string,
): Promise<InstalledSideloadedPlugin> {
  return invoke<InstalledSideloadedPlugin>('sideloaded_plugin_install', {
    path,
    passphrase: passphrase && passphrase.length > 0 ? passphrase : null,
  });
}

export function listSideloadedPlugins(): Promise<InstalledSideloadedPlugin[]> {
  return invoke<InstalledSideloadedPlugin[]>('sideloaded_plugin_list');
}

export function removeSideloadedPlugin(id: string): Promise<void> {
  return invoke<void>('sideloaded_plugin_remove', { id });
}

/**
 * Opens a file through a package's importer.
 *
 * The bytes go as a raw body (a scene is tens of MB and JSON numbers would double
 * it); the plugin id and file name travel in headers, percent-encoded.
 */
export function importSideloadedFile(
  pluginId: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('sideloaded_plugin_import_file', bytes, {
    headers: {
      'x-plugin-id': pluginId,
      'x-file-name': encodeURIComponent(fileName),
    },
  });
}

/**
 * First 16 hex characters of the publisher fingerprint, grouped in fours
 * (`fe81 2c12 f3ab 4ce6`). Sixteen hex is 64 bits: enough to compare against the
 * vendor's published value by eye, short enough to read in a dialog.
 */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ');
}
