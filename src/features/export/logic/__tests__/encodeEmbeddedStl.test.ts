import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as THREE from 'three';
import { STLExporter } from 'three-stdlib';
import { encodeEmbeddedStl } from '../encodeEmbeddedStl';
import { disposeEventLoopChannel } from '@/utils/yieldToEventLoop';

after(disposeEventLoopChannel);

function reference(geometry: THREE.BufferGeometry, center: THREE.Vector3): Uint8Array {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(center).negate();
  group.add(mesh);
  group.updateMatrixWorld(true);
  const result = new STLExporter().parse(group, { binary: true }) as DataView;
  material.dispose();
  return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
}

test('embedded STL matches the previous exporter byte-for-byte, including face order and normals', async () => {
  const indexed = new THREE.TorusKnotGeometry(12, 3, 100, 12);
  const soup = indexed.toNonIndexed();
  const interleaved = new THREE.BufferGeometry();
  const positions = new Float32Array(soup.getAttribute('position').count * 4);
  for (let i = 0; i < positions.length / 4; i++) {
    positions.set([soup.getAttribute('position').getX(i), soup.getAttribute('position').getY(i), soup.getAttribute('position').getZ(i), 99], i * 4);
  }
  interleaved.setAttribute('position', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(positions, 4), 3, 0));
  const degenerate = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
  for (const geometry of [indexed, soup, interleaved, degenerate, new THREE.BufferGeometry(), new THREE.BufferGeometry().setIndex([0, 1, 2])]) {
    geometry.addGroup(0, 3, 0); // Embedded STL must not skip/reorder groups.
    const center = new THREE.Vector3(1.234, -9.876, 0.125);
    const before = geometry.getAttribute('position')?.array.slice();
    assert.deepEqual(await encodeEmbeddedStl(geometry, center), reference(geometry, center));
    assert.deepEqual(geometry.getAttribute('position')?.array, before);
    geometry.dispose();
  }
});

test('large encodes let an event-loop task run before completion', async (t) => {
  disposeEventLoopChannel();
  let tick = 0;
  t.mock.method(performance, 'now', () => tick += 5);
  const geometry = new THREE.TorusKnotGeometry(12, 3, 600, 16);
  let turns = 0;
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { turns++; };
  channel.port2.postMessage(null);
  try {
    const bytes = await encodeEmbeddedStl(geometry, new THREE.Vector3());
    assert.ok(turns > 0, 'encoding must yield macrotasks, not only promises');
    assert.deepEqual(bytes, reference(geometry, new THREE.Vector3()));
  } finally {
    channel.port1.close();
    channel.port2.close();
    geometry.dispose();
  }
});

test('a geometry edit between batches rejects mixed-revision bytes', async (t) => {
  let tick = 0;
  t.mock.method(performance, 'now', () => tick += 5);
  for (const change of ['version', 'attribute', 'array', 'index'] as const) {
    disposeEventLoopChannel();
    const geometry = new THREE.TorusKnotGeometry(12, 3, 1000, 24);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      if (change === 'version') position.needsUpdate = true;
      if (change === 'attribute') geometry.setAttribute('position', position.clone());
      if (change === 'array') position.array = position.array.slice();
      if (change === 'index') geometry.setIndex(geometry.index!.clone());
    };
    channel.port2.postMessage(null);
    try {
      await assert.rejects(encodeEmbeddedStl(geometry, new THREE.Vector3()), /Geometry changed/, change);
    } finally {
      channel.port1.close();
      channel.port2.close();
      geometry.dispose();
    }
  }
});
