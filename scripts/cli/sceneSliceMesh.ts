/**
 * Builds the slice mesh for `scene slice` with the app's own orchestrator
 * (`buildSolidSliceMeshForWasm`), so the model/support/raft geometry, the
 * model-vs-support split, and the layer count stay in exact parity with the GUI
 * slice path — and keep parity as that path evolves.
 *
 * Isolated from the CLI entry point because it pulls in THREE and the slicing
 * stores; `dragonfruit-ts-cli.ts` loads it only for `scene slice`.
 */
import * as THREE from 'three';
import type { LoadedModel } from '../../src/features/scene/useSceneCollectionManager';
import {
  buildSolidSliceMeshForWasm,
  type SolidSliceMeshForWasm,
} from '../../src/features/slicing/rasterLayerZipExport';
import { loadFromImportFormat } from '../../src/supports/state';
import { setRaftSettings } from '../../src/supports/Rafts/Crenelated/RaftState';
import { DEFAULT_RAFT_SETTINGS } from '../../src/supports/Rafts/Crenelated/RaftDefaults';
import type { RaftBottomMode, RaftSettings } from '../../src/supports/Rafts/Crenelated/RaftTypes';
import type { MaterialProfile, PrinterProfile } from '../../src/features/profiles/profileStore';
import type { DragonfruitImportFormat } from '../../src/supports/types';

/**
 * One visible model's already-world-space triangles plus the metadata the slice
 * mesh needs. The CLI bakes the VOXL transform into `positions`, so the model
 * enters the orchestrator with an identity transform and zero center — the
 * orchestrator then passes the vertices straight through, matching the CLI's
 * validated world output while the support/raft/split logic comes from the app.
 */
export type SceneSliceModelInput = {
  id: string;
  name: string;
  color: string;
  polygonCount: number;
  isSupportGeometry: boolean;
  /** World-space triangle positions, 9 floats per triangle. */
  positions: Float32Array;
};

export type SceneSliceMeshOptions = {
  models: readonly SceneSliceModelInput[];
  supports: DragonfruitImportFormat;
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  /**
   * Full raft settings, like the app stores them (merged over the defaults).
   * When set, its `bottomMode` decides the raft unless `raftMode` overrides it.
   */
  raftSettings?: Partial<RaftSettings>;
  /**
   * Raft bottom mode shorthand. Overrides `raftSettings.bottomMode` when given.
   * When neither this nor `raftSettings` is set, no raft is generated.
   */
  raftMode?: RaftBottomMode;
  supportTipShrinkPercent?: number;
};

/** Resolves the raft config from the shorthand mode and/or full settings.
 *  Nothing given → raft off; settings only → its mode; mode wins when both. */
function resolveRaftSettings(options: SceneSliceMeshOptions): RaftSettings {
  const base: RaftSettings = { ...DEFAULT_RAFT_SETTINGS, ...(options.raftSettings ?? {}) };
  if (options.raftMode) {
    base.bottomMode = options.raftMode;
  } else if (!options.raftSettings) {
    base.bottomMode = 'off';
  }
  return base;
}

function toLoadedModel(model: SceneSliceModelInput): LoadedModel {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox ?? new THREE.Box3();
  const size = new THREE.Vector3();
  bbox.getSize(size);
  return {
    id: model.id,
    name: model.name,
    fileUrl: '',
    visible: true,
    color: model.color,
    polygonCount: model.polygonCount,
    isSupportGeometry: model.isSupportGeometry,
    transform: {
      position: new THREE.Vector3(),
      rotation: new THREE.Euler(),
      scale: new THREE.Vector3(1, 1, 1),
    },
    geometry: {
      geometry,
      bbox,
      center: new THREE.Vector3(),
      size,
      flatteningPlanes: [],
    },
  };
}

/**
 * Assembles the slice mesh via the app orchestrator. The printer/material
 * profiles must already be active in the profile store (`resolveSceneSliceJob`
 * adds and activates them) so support tip penetration resolves the same way the
 * GUI does.
 */
export async function buildSceneSliceMesh(options: SceneSliceMeshOptions): Promise<SolidSliceMeshForWasm> {
  // loadFromImportFormat chatters on stdout (console.log); keep it off the
  // `--json` channel for the duration of the build.
  const origLog = console.log;
  console.log = console.error;
  try {
    loadFromImportFormat(options.supports);
    setRaftSettings(resolveRaftSettings(options));
    return await buildSolidSliceMeshForWasm({
      models: options.models.map(toLoadedModel),
      printerProfile: options.printerProfile,
      materialProfile: options.materialProfile,
      filenameBase: 'scene-slice',
      supportTipShrinkPercent: options.supportTipShrinkPercent ?? 0,
      outputMode: 'return',
    });
  } finally {
    console.log = origLog;
  }
}
