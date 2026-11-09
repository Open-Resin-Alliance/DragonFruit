/**
 * The DragonFruit half of a plugin's job-metadata payload.
 *
 * A format sometimes needs data the app owns rather than data a setting names:
 * LUMEN's `embedVoxlScene` wants the editor scene serialized into the file, and no
 * amount of JSON settings produces that. The plugin declares which setting asks for
 * which payload and this module bakes it, so the slice path knows a *kind* of
 * payload and never a plugin name.
 *
 * The scene is serialized with the app's own VOXL writer — the same V2 binary
 * container the scene is saved with — and the bytes are base64 in the job's
 * metadata, which is the only channel a job has.
 *
 * A bake that cannot happen leaves no key behind rather than a half-written one,
 * and the format encoder decides what a missing payload means for its job.
 */

import type { ModelMeshModifiers } from '@/features/mesh-modifiers/types';
import {
  buildSupportExportFromStores,
  serializeVoxlDocumentV2,
  type VoxlMeshRef,
  type VoxlModelRuntimeLike,
} from '@/features/scene/voxl';
import { getSnapshot as getSupportSnapshot } from '@/supports/state';

/** `source` recorded on the baked support forest. */
const SUPPORT_EXPORT_SOURCE = 'dragonfruit-plugin-payload';

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
    // The payload carries no mesh bytes, so the scene document describes each model
    // rather than embedding it: the geometry it points at is the model's own source
    // file when it has one.
    mesh: model.sourcePath
      ? { mode: 'external-file', fileName: model.sourcePath }
      : { mode: 'none' },
  };
}

/**
 * The scene as VOXL V2 bytes, or `null` when there is nothing to serialize.
 *
 * These are the bytes a VOXL reader accepts, which is also what a format's own
 * transport check asserts before it writes a chunk that claims to be a scene.
 */
export async function bakeVoxlScenePayload(
  models: readonly EmbedVoxlSceneModel[],
): Promise<Uint8Array | null> {
  if (models.length === 0) return null;

  return serializeVoxlDocumentV2(
    {
      models: models.map(toRuntimeModel),
      activeModelId: null,
      selectedModelIds: [],
      supports: buildSupportExportFromStores(getSupportSnapshot(), SUPPORT_EXPORT_SOURCE),
      meta: { generator: 'DragonFruit' },
    },
    new Map(),
  );
}
