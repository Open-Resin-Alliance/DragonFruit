import { GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS } from '@/features/plugins/generatedBuiltinComplexPlugins';

const PLUGIN_SCENE_FILE_TYPES = GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS.flatMap(
  (def) => (def.fileTypes ?? []).filter((ft) => ft.isSceneFile),
);
const PLUGIN_ALL_FILE_TYPES = GENERATED_BUILTIN_COMPLEX_PLUGIN_DEFINITIONS.flatMap(
  (def) => def.fileTypes ?? [],
);
const PREPARE_DROP_EXTENSIONS = new Set([
  '.stl', '.obj', '.3mf', '.voxl',
  ...PLUGIN_ALL_FILE_TYPES.map((ft) => ft.fileExtension),
]);
export const PLUGIN_IMPORT_WARNING_DISMISSED_STORAGE_KEY =
  PLUGIN_SCENE_FILE_TYPES.find((ft) => ft.fileExtension === '.lys')?.importWarning?.storageKey
  ?? 'dragonfruit.lysImportWarningDismissed';

export function getFileExtension(name: string): string {
  const trimmed = name.trim().toLowerCase();
  const dotIndex = trimmed.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === trimmed.length - 1) return '';
  return trimmed.slice(dotIndex);
}

export function getFileNameFromPath(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function isDragonfruitTempArtifactPath(path: string | null | undefined): boolean {
  if (typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (!trimmed) return false;
  const name = getFileNameFromPath(trimmed).toLowerCase();
  return name.startsWith('dragonfruit-slice-');
}

export function isSupportedPrepareDropName(name: string): boolean {
  return PREPARE_DROP_EXTENSIONS.has(getFileExtension(name));
}

export function getDroppedFileMimeType(name: string): string {
  const ext = getFileExtension(name);
  if (ext === '.stl') return 'model/stl';
  if (ext === '.obj') return 'model/obj';
  if (ext === '.3mf') return 'model/3mf';
  if (ext === '.voxl') return 'application/json';
  const pluginType = PLUGIN_ALL_FILE_TYPES.find((ft) => ft.fileExtension === ext);
  return pluginType?.mimeType ?? 'application/octet-stream';
}

export function isSceneFileName(name: string): boolean {
  const ext = getFileExtension(name);
  if (ext === '.voxl') return true;
  return PLUGIN_SCENE_FILE_TYPES.some((ft) => ft.fileExtension === ext);
}

export function normalizeActiveVoxlScenePath(path: string | null | undefined): string | null {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  return getFileExtension(trimmed) === '.voxl' ? trimmed : null;
}

export type LaunchSceneFileEntry = {
  path: string;
  name: string;
};

export type SceneFileHandoffPayload = {
  paths?: string[];
  source?: string;
};

export function extractTauriDroppedPaths(payload: unknown): string[] {
  const isStringArray = (value: unknown): value is string[] => (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );

  if (isStringArray(payload)) {
    return payload;
  }

  if (payload && typeof payload === 'object' && 'paths' in payload) {
    const candidate = (payload as { paths?: unknown }).paths;
    if (isStringArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

export function isLikelyFileDragPayload(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if ((dataTransfer.files?.length ?? 0) > 0) return true;
  if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === 'file')) return true;
  if (Array.from(dataTransfer.types ?? []).includes('Files')) return true;
  // Desktop runtime drags may not expose file metadata until drop.
  return true;
}

export function getPrepareDropSupportStateFromDataTransfer(dataTransfer: DataTransfer | null): 'supported' | 'unsupported' | 'unknown' {
  if (!dataTransfer) return 'unknown';

  const fileNames = new Set<string>();

  const directFiles = Array.from(dataTransfer.files ?? []);
  for (const file of directFiles) {
    if (typeof file.name === 'string' && file.name.trim().length > 0) {
      fileNames.add(file.name.trim());
    }
  }

  const items = Array.from(dataTransfer.items ?? []);
  for (const item of items) {
    if (item.kind !== 'file') continue;
    try {
      const file = item.getAsFile();
      if (file && typeof file.name === 'string' && file.name.trim().length > 0) {
        fileNames.add(file.name.trim());
      }

      const webkitEntry = (item as DataTransferItem & {
        webkitGetAsEntry?: () => { isFile?: boolean; name?: string } | null;
      }).webkitGetAsEntry?.();
      if (webkitEntry?.isFile && typeof webkitEntry.name === 'string' && webkitEntry.name.trim().length > 0) {
        fileNames.add(webkitEntry.name.trim());
      }
    } catch {
      // Some runtimes throw here during drag hover metadata probing.
    }
  }

  const maybeExtractNameFromTextPath = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;

    const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
    if (!firstLine) return;

    let normalized = firstLine;
    if (normalized.startsWith('file://')) {
      try {
        normalized = decodeURIComponent(normalized.replace(/^file:\/\//, ''));
      } catch {
        normalized = normalized.replace(/^file:\/\//, '');
      }
    }

    const name = getFileNameFromPath(normalized);
    if (name.trim().length > 0) {
      fileNames.add(name.trim());
    }
  };

  try {
    maybeExtractNameFromTextPath(dataTransfer.getData('text/uri-list'));
    maybeExtractNameFromTextPath(dataTransfer.getData('text/plain'));
  } catch {
    // Ignore dataTransfer text extraction failures on restricted drag payloads.
  }

  if (fileNames.size === 0) {
    return 'unknown';
  }

  const hasSupported = Array.from(fileNames).some((name) => isSupportedPrepareDropName(name));
  return hasSupported ? 'supported' : 'unsupported';
}

export function buildDroppedFilesSignature(files: File[]): string {
  return files
    .map((file) => `${file.name.trim().toLowerCase()}::${Number.isFinite(file.size) ? file.size : -1}`)
    .sort((a, b) => a.localeCompare(b))
    .join('|');
}
