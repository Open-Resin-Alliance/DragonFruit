import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { ExportManager } from '../ExportManager';
import type { LoadedModel } from '@/features/scene/useSceneCollectionManager';

/**
 * A model draws its display mesh — its long faces split for the AO — but it *is* its
 * own mesh. The file a save writes is the model's mesh, at its own triangle count,
 * however many triangles the renderer draws in its place: a model must never grow
 * because it was drawn.
 */

/** A flat square of `cells × cells` quads, as a soup. */
function square(cells: number): THREE.BufferGeometry {
  const soup: number[] = [];
  const step = 1 / cells;
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      const [x0, y0, x1, y1] = [col * step, row * step, (col + 1) * step, (row + 1) * step];
      soup.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(soup), 3));
  geometry.computeBoundingBox();
  return geometry;
}

function modelDrawing(geometry: THREE.BufferGeometry, displayGeometry?: THREE.BufferGeometry): LoadedModel {
  return {
    id: `model-${geometry.uuid}`,
    geometry: {
      geometry,
      ...(displayGeometry ? { displayGeometry } : {}),
      center: new THREE.Vector3(),
      bbox: geometry.boundingBox,
      size: new THREE.Vector3(1, 1, 0),
      flatteningPlanes: [],
    },
  } as unknown as LoadedModel;
}

/** A binary STL: 80-byte header, a 4-byte count, 50 bytes per triangle. */
const stlBytesFor = (triangles: number) => 84 + 50 * triangles;

test('the VOXL mesh chunk holds the model mesh, not the display mesh it draws', async () => {
  const real = square(1); // 2 triangles: the coarse panel the AO cannot shade
  const display = square(8); // 128 triangles: what the renderer draws instead
  const chunk = await ExportManager.bakeModelGeometryChunk(modelDrawing(real, display));

  assert.equal(chunk.uncompressedSize, stlBytesFor(2));
});

test('attaching a display mesh does not make the saved mesh look changed', () => {
  // The reconciler attaches the display mesh with a new `GeometryWithBounds` around
  // the same model mesh. The chunk store must keep serving what it already baked,
  // not take the attachment for an edit and write the mesh again.
  const real = square(1);
  const bare = ExportManager.computeModelGeometrySignature(modelDrawing(real));
  const drawn = ExportManager.computeModelGeometrySignature(modelDrawing(real, square(8)));
  assert.equal(drawn, bare);
});
