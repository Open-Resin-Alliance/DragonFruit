import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { loadMeshGeometry, processGeometry } from '../useStlGeometry';

function ensureProgressEventPolyfill() {
  if (typeof globalThis.ProgressEvent !== 'undefined') return;

  class ProgressEventPolyfill extends Event {
    lengthComputable: boolean;
    loaded: number;
    total: number;

    constructor(type: string, init: { lengthComputable?: boolean; loaded?: number; total?: number } = {}) {
      super(type);
      this.lengthComputable = Boolean(init.lengthComputable);
      this.loaded = Number(init.loaded ?? 0);
      this.total = Number(init.total ?? 0);
    }
  }

  (globalThis as typeof globalThis & { ProgressEvent: typeof ProgressEventPolyfill }).ProgressEvent = ProgressEventPolyfill;
}

function buildTriangleObjDataUrl(): string {
  const obj = [
    'v 0 0 0',
    'v 1 0 0',
    'v 0 1 0',
    'f 1 2 3',
  ].join('\n');

  return `data:text/plain;base64,${Buffer.from(obj, 'utf8').toString('base64')}`;
}

function buildTriangleGeometryWithVertexColors(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
  ], 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([
    1, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ], 3));
  return geometry;
}

describe('loadMeshGeometry OBJ support', () => {
  it('loads OBJ geometry when file extension is .obj', async () => {
    ensureProgressEventPolyfill();

    const result = await loadMeshGeometry(buildTriangleObjDataUrl(), 'triangle.obj');
    const position = result.geometry.getAttribute('position');

    assert.ok(position, 'expected OBJ position attribute to exist');
    assert.equal(position.count, 3, 'expected one triangle (3 vertices)');
    assert.equal(result.bbox.min.y, 0, 'expected geometry to be normalized to build plate (minY=0)');
    assert.equal(result.bbox.max.y, 1, 'expected normalized geometry height to be preserved');
  });

  it('supports uppercase OBJ file extensions', async () => {
    ensureProgressEventPolyfill();

    const result = await loadMeshGeometry(buildTriangleObjDataUrl(), 'TRIANGLE.OBJ');
    const position = result.geometry.getAttribute('position');

    assert.ok(position, 'expected OBJ position attribute to exist for uppercase extension');
    assert.equal(position.count, 3, 'expected one triangle (3 vertices) for uppercase extension');
  });
});

describe('processGeometry color normalization', () => {
  it('strips embedded vertex color attributes from imported geometry', async () => {
    const source = buildTriangleGeometryWithVertexColors();
    assert.ok(source.getAttribute('color'), 'expected source geometry to include a color attribute');

    const result = await processGeometry(source);

    assert.equal(result.geometry.getAttribute('color'), undefined, 'expected processed geometry color attribute to be removed');
    assert.ok(source.getAttribute('color'), 'expected source geometry to remain unchanged');
  });

  it('falls back to in-place processing if geometry copy allocation fails', async () => {
    const source = buildTriangleGeometryWithVertexColors();
    const originalCopy = THREE.BufferGeometry.prototype.copy;
    let copyCallCount = 0;

    THREE.BufferGeometry.prototype.copy = function copyThatThrowsAllocationFailure(_source: THREE.BufferGeometry): THREE.BufferGeometry {
      void _source;
      copyCallCount += 1;
      throw new RangeError('Array buffer allocation failed');
    };

    try {
      const result = await processGeometry(source);

      assert.ok(copyCallCount > 0, 'expected copy to be attempted before fallback');
      assert.equal(result.geometry, source, 'expected in-place fallback to return original geometry instance');
      assert.equal(result.geometry.getAttribute('color'), undefined, 'expected fallback path to still strip vertex colors');
    } finally {
      THREE.BufferGeometry.prototype.copy = originalCopy;
    }
  });
});
