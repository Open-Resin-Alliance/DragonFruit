/**
 * Bakes the metadata payloads a plugin's settings ask for.
 *
 * A plugin declares the pairs — the merged-settings path whose `true` asks for a
 * payload, the metadata path the payload lands on, and the kind of payload — and
 * this module does the baking. It knows the *kinds* the app can produce
 * ([`PAYLOAD_BAKERS`]) and nothing about which plugin wants one, so a plugin may
 * declare a kind a given build does not implement: the bake is skipped, the job
 * goes out without it, and the encoder decides what that means (LUMEN refuses a job
 * whose setting asks for a scene it did not receive, rather than writing a file
 * that is quietly missing the scene its profile promised).
 *
 * Everything here is best-effort by design: a payload that cannot be baked leaves
 * the metadata exactly as it was.
 */

import type { PluginJobMetadataPayloadDefinition } from '@/features/plugins/complexPluginContracts';
import { getBuiltinComplexPluginDefinitions } from '@/features/plugins/builtinComplexPlugins';
import { bytesToBase64 } from '@/utils/base64';
import { bakeVoxlScenePayload, type EmbedVoxlSceneModel } from './voxlScenePayload';

/** What a bake needs from the scene, per payload kind. */
export type JobMetadataPayloadContext = {
  models: readonly EmbedVoxlSceneModel[];
};

type PayloadBaker = (context: JobMetadataPayloadContext) => Promise<Uint8Array | null>;

/**
 * The payload kinds the app can bake. A kind absent here is a declaration this
 * build skips, which is how a plugin can name something newer than the app.
 */
const PAYLOAD_BAKERS: Record<PluginJobMetadataPayloadDefinition['payload'], PayloadBaker> = {
  'voxl-scene': (context) => bakeVoxlScenePayload(context.models),
};

/** Reads `<a>.<b>` out of parsed metadata, or `undefined`. */
function readMetadataPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Writes `<value>` at `<a>.<b>`, creating intermediate objects. */
function writeMetadataPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop();
  if (!last) return;

  let cursor = root;
  for (const segment of segments) {
    const next = cursor[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[last] = value;
}

/**
 * Every payload the loaded plugins declare.
 *
 * The declarations are plugin-owned data, hydrated from the generated registry; the
 * driver below takes them as an argument so it can be exercised without one.
 */
export function getJobMetadataPayloadDeclarations(): PluginJobMetadataPayloadDefinition[] {
  return getBuiltinComplexPluginDefinitions().flatMap((definition) => definition.jobMetadataPayloads ?? []);
}

/**
 * The metadata with every declared payload the merged settings ask for baked into it.
 *
 * Metadata that is not JSON, a setting that is not `true`, no models to bake, a kind
 * this build does not implement, a baker that fails: each of those returns the
 * metadata unchanged rather than a key with nothing usable behind it.
 */
export async function attachJobMetadataPayloads(
  metadataJson: string,
  context: JobMetadataPayloadContext,
  declarations: readonly PluginJobMetadataPayloadDefinition[],
): Promise<string> {
  if (declarations.length === 0) return metadataJson;

  let parsed: Record<string, unknown>;
  try {
    const candidate: unknown = JSON.parse(metadataJson);
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return metadataJson;
    }
    parsed = candidate as Record<string, unknown>;
  } catch {
    return metadataJson;
  }

  let changed = false;
  for (const declaration of declarations) {
    if (readMetadataPath(parsed, declaration.settingPath) !== true) continue;

    const bake = PAYLOAD_BAKERS[declaration.payload];
    if (!bake) continue;

    try {
      const bytes = await bake(context);
      if (!bytes || bytes.length === 0) continue;

      writeMetadataPath(parsed, declaration.payloadPath, bytesToBase64(bytes));
      changed = true;
    } catch (error) {
      console.warn(`[JobMetadataPayload] Skipping ${declaration.payload} at ${declaration.payloadPath}.`, error);
    }
  }

  return changed ? JSON.stringify(parsed) : metadataJson;
}
