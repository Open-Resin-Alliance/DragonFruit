import * as THREE from 'three';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';
import type { MaterialProfile, PrinterProfile } from '@/features/profiles/profileStore';
import { runSliceExportOrchestrator, type SliceExportOrchestratorOptions } from '../../sliceExportOrchestrator';
import { installFakeWindow } from '@/utils/__tests__/helpers/fakeWindow';

/**
 * The job the app hands the native slicer, captured at the Tauri boundary.
 *
 * Runs the real `runSliceExportOrchestrator` against a stubbed `window` that
 * answers the staging commands and throws once `slice_solid_native_to_temp_path`
 * receives the job. Everything the app assembles in TypeScript is exercised; only
 * the native side is skipped.
 */
export type CapturedSliceJob = Record<string, unknown> & { metadata_json: string };

/** An axis-aligned cube resting on the plate, centred on the origin. */
export function cubeModel(id: string, sizeMm: number): LoadedModel {
  const h = sizeMm / 2;
  const v = [
    [-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0],
    [-h, -h, sizeMm], [h, -h, sizeMm], [h, h, sizeMm], [-h, h, sizeMm],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const positions = new Float32Array(faces.flatMap((face) => face.flatMap((i) => v[i])));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const center = bbox.getCenter(new THREE.Vector3());
  return {
    id,
    name: id,
    fileUrl: '',
    color: '#a3a3a3',
    visible: true,
    polygonCount: positions.length / 9,
    geometry: { geometry, bbox, center, size: bbox.getSize(new THREE.Vector3()), flatteningPlanes: [] },
    transform: { position: center.clone(), rotation: new THREE.Euler(), scale: new THREE.Vector3(1, 1, 1) },
  };
}

export async function captureAppSliceJob(options: {
  models: LoadedModel[];
  printerProfile: PrinterProfile;
  materialProfile: MaterialProfile;
  /** Anything else the panel would pass, such as the anti-aliasing settings. */
  extraOptions?: Partial<SliceExportOrchestratorOptions>;
}): Promise<CapturedSliceJob> {
  let captured: CapturedSliceJob | undefined;
  const reachedSlicer = new Error('captured native slice job');
  const invoke = async (command: string, args?: unknown): Promise<unknown> => {
    switch (command) {
      case 'stage_mesh_binary_set':
        return {};
      case 'plugin:event|listen':
        return 1;
      case 'plugin:event|unlisten':
        return;
      case 'slice_solid_native_to_temp_path':
        captured = JSON.parse((args as { jobJson: string }).jobJson) as CapturedSliceJob;
        throw reachedSlicer;
      default:
        throw new Error(`Unexpected native command: ${command}`);
    }
  };

  const restoreWindow = installFakeWindow({
    dispatchEvent: () => true,
    __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  });
  try {
    await runSliceExportOrchestrator({
      ...options.extraOptions,
      models: options.models,
      printerProfile: options.printerProfile,
      materialProfile: options.materialProfile,
      filenameBase: 'capture',
      outputMode: 'return',
    }).catch((error: unknown) => {
      if (error !== reachedSlicer) throw error;
    });
  } finally {
    restoreWindow();
  }

  if (!captured) throw new Error('The orchestrator never reached the native slicer.');
  return captured;
}
