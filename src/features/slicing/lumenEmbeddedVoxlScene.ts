/**
 * The DragonFruit half of LUMEN's `embedVoxlScene` option.
 *
 * A `.lumen` material profile may ask for the editor scene to travel inside the
 * container. This module bakes that payload: it serializes the scene (models +
 * support forest) with the app's own VOXL writer — the same V2 binary container
 * the scene is saved with — and puts the bytes into the slicing job's metadata
 * as `lumen.voxlSceneBase64`, right beside the setting that asked for them.
 *
 * The gate is read back out of the metadata the settings merge already produced
 * rather than re-derived from the profile: whatever the merge resolved (an
 * explicit profile value or a schema default) is what the format encoder sees,
 * so the payload can never disagree with the flag next to it.
 *
 * A bake that cannot happen leaves no key behind rather than a half-embedded one,
 * and the format encoder stays the one place that decides what a missing payload
 * means for the job — LUMEN refuses a job whose flag asks for a scene it did not
 * receive.
 */

import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import {
  buildSupportExportFromStores,
  serializeVoxlDocumentV2,
  type VoxlMeshRef,
  type VoxlModelRuntimeLike,
} from '@/features/scene/voxl';
import { getSnapshot as getSupportSnapshot } from '@/supports/state';
import { bytesToBase64 } from '@/utils/base64';

const LUMEN_METADATA_GROUP = 'lumen';
/** Field key of the option in LUMEN's material settings. */
const EMBED_SCENE_SETTING_KEY = 'embedVoxlScene';
/** Where the baked payload lands — sibling of the setting that turns it on. */
const VOXL_SCENE_PAYLOAD_KEY = 'voxlSceneBase64';

/** `source` recorded on the baked support forest. */
const SUPPORT_EXPORT_SOURCE = 'dragonfruit-lumen-embed';

/**
 * The LUMEN-owned slice of a job's metadata, keyed by the `metadataPath`s of the
 * plugin's settings schema. Both fields are checked before use, so a metadata
 * payload from another format (or a hand-written one) simply reads as "off".
 */
type LumenJobMetadata = {
  [LUMEN_METADATA_GROUP]?: { [EMBED_SCENE_SETTING_KEY]?: unknown } & Record<string, unknown>;
};

type Vec3Like = { x: number; y: number; z: number };

/**
 * What the bake needs from a scene model — a structural subset of `LoadedModel`,
 * so the slicer can hand its models over without re-mapping them first.
 */
export type EmbedVoxlSceneModel = {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  polygonCount: number;
  fileSizeBytes?: number;
  sourcePath?: string | null;
  originalRef?: VoxlMeshRef;
  meshModifiers?: ModelMeshModifiers;
  isSupportGeometry?: boolean;
  linkGroupId?: string;
  transform: {
    position: Vec3Like;
    rotation: Vec3Like;
    scale: Vec3Like;
  };
};

function toRuntimeModel(model: EmbedVoxlSceneModel): VoxlModelRuntimeLike {
  return {
    id: model.id,
    name: model.name,
    visible: model.visible,
    color: model.color,
    polygonCount: model.polygonCount,
    fileSizeBytes: model.fileSizeBytes,
    ...(model.sourcePath ? { sourcePath: model.sourcePath } : {}),
    originalRef: model.originalRef,
    transform: {
      position: { ...model.transform.position },
      rotation: { ...model.transform.rotation },
      scale: { ...model.transform.scale },
    },
    meshModifiers: model.meshModifiers,
    isSupportGeometry: model.isSupportGeometry,
    linkGroupId: model.linkGroupId,
    // The embed carries no mesh bytes, so the scene document describes each
    // model rather than embedding it: the geometry it points at is the model's
    // own source file when it has one.
    mesh: model.sourcePath
      ? { mode: 'external-file', fileName: model.sourcePath }
      : { mode: 'none' },
  };
}

/**
 * Adds `lumen.voxlSceneBase64` — base64 VOXL V2 bytes, the payload LUMEN's
 * `voxl::is_voxl` transport check and a VOXL reader both accept — to a job's
 * metadata when the merged LUMEN settings ask for the scene embed.
 *
 * Returns the metadata untouched — no key, no throw — when the setting is off,
 * when there is no scene to bake, or when serialization fails.
 */
export async function attachEmbeddedVoxlSceneToMetadata(
  metadataJson: string,
  models: readonly EmbedVoxlSceneModel[],
): Promise<string> {
  try {
    const parsed = JSON.parse(metadataJson) as LumenJobMetadata;
    const lumenMetadata = parsed[LUMEN_METADATA_GROUP];
    if (lumenMetadata?.[EMBED_SCENE_SETTING_KEY] !== true || models.length === 0) {
      return metadataJson;
    }

    const bytes = await serializeVoxlDocumentV2(
      {
        models: models.map(toRuntimeModel),
        activeModelId: null,
        selectedModelIds: [],
        supports: buildSupportExportFromStores(getSupportSnapshot(), SUPPORT_EXPORT_SOURCE),
        meta: { generator: 'DragonFruit' },
      },
      new Map(),
    );

    lumenMetadata[VOXL_SCENE_PAYLOAD_KEY] = bytesToBase64(bytes);
    return JSON.stringify(parsed);
  } catch (error) {
    console.warn('[LumenEmbed] Skipping embedded VOXL scene.', error);
    return metadataJson;
  }
}
