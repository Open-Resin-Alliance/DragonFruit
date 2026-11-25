import type { DetectedIsland } from './types';
import { isTauriRuntime } from '@/utils/tauriRuntime';
import { savePrintArtifactWithNativeDialog } from '@/features/slicing/tauri/nativeSlicerBridge';

/** The filename the real-model harness expects beside a model. */
export function islandsExportFileName(modelName?: string): string {
  const leaf = (modelName ?? 'islands').split(/[\\/]/).pop() ?? 'islands';
  const base = leaf
    .replace(/\.(stl|obj|3mf|ply)$/i, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return `${base || 'islands'}.islands.json`;
}

/**
 * The island set as plain JSON.
 *
 * `contact` is a THREE.Vector3 and `contactVoxels` is a pair of Float32Arrays;
 * both need the shape the harness's `<name>.islands.json` loader accepts. Every
 * other field is already JSON-safe and is kept so the scan's provenance
 * (source, angles, normals, spans) survives the file.
 */
export function serializeIslandsForExport(islands: readonly DetectedIsland[]): unknown[] {
  return islands.map((island) => {
    const { contact, contactVoxels, ...rest } = island;
    return {
      ...rest,
      contact: { x: contact.x, y: contact.y, z: contact.z },
      ...(contactVoxels
        ? {
            contactVoxels: {
              xy: Array.from(contactVoxels.xy),
              z: contactVoxels.z ? Array.from(contactVoxels.z) : null,
              count: contactVoxels.count,
            },
          }
        : {}),
    };
  });
}

/** Saves the island set as JSON: native dialog in the app, download in a browser. */
export async function exportIslandsToJson(islands: readonly DetectedIsland[], modelName?: string): Promise<string | null> {
  const json = JSON.stringify(serializeIslandsForExport(islands), null, 2);
  const fileName = islandsExportFileName(modelName);
  if (isTauriRuntime()) {
    return savePrintArtifactWithNativeDialog(new TextEncoder().encode(json), fileName);
  }
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return fileName;
}
