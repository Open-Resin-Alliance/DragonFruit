import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import { writeInstanceColors } from '../instanceColorWriter';

type Primitive = { modelId?: string };

const base = new THREE.Color('#9a9a9a');
const active = new THREE.Color('#ff6a00');

function makeMesh(count: number): THREE.InstancedMesh {
  return new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), count);
}

function colorAt(mesh: THREE.InstancedMesh, index: number): string {
  const color = new THREE.Color();
  mesh.getColorAt(index, color);
  return color.getHexString();
}

/** Counts the colour writes, so "only what moved" is observable. */
function countingMesh(count: number): { mesh: THREE.InstancedMesh; writes: number[] } {
  const mesh = makeMesh(count);
  const writes: number[] = [];
  const original = mesh.setColorAt.bind(mesh);
  mesh.setColorAt = (index: number, color: THREE.Color) => {
    writes.push(index);
    return original(index, color);
  };
  return { mesh, writes };
}

describe('instance colour writer', () => {
  const instances: Primitive[] = [
    { modelId: 'a' },
    { modelId: 'b' },
    { modelId: 'a' },
    { modelId: 'c' },
  ];

  it('writes every instance the first time', () => {
    const mesh = makeMesh(instances.length);
    writeInstanceColors(mesh, instances, (p) => (p.modelId === 'a' ? active : base));

    assert.strictEqual(colorAt(mesh, 0), 'ff6a00');
    assert.strictEqual(colorAt(mesh, 1), '9a9a9a');
    assert.strictEqual(colorAt(mesh, 2), 'ff6a00');
  });

  it('writes only the instances of the models whose colour moved', () => {
    const { mesh, writes } = countingMesh(instances.length);
    let selected = new Set<string>();
    const colorFor = (p: Primitive) => (selected.has(p.modelId ?? '') ? active : base);

    writeInstanceColors(mesh, instances, colorFor);
    writes.length = 0;

    selected = new Set(['a']);
    writeInstanceColors(mesh, instances, colorFor);

    // Both of model a's instances, and nothing of b or c. The order is the
    // group order, which does not matter; the set does.
    assert.deepStrictEqual([...writes].sort((a, b) => a - b), [0, 2]);
    assert.strictEqual(colorAt(mesh, 0), 'ff6a00');
    assert.strictEqual(colorAt(mesh, 1), '9a9a9a');
  });

  it('writes nothing, and does not flag the buffer, when no colour moved', () => {
    const { mesh, writes } = countingMesh(instances.length);
    const colorFor = () => base;

    writeInstanceColors(mesh, instances, colorFor);
    writes.length = 0;
    const version = mesh.instanceColor?.version;

    writeInstanceColors(mesh, instances, colorFor);

    assert.deepStrictEqual(writes, []);
    // `needsUpdate` is a setter with no getter; three bumps `version` instead.
    assert.strictEqual(mesh.instanceColor?.version, version);
  });

  it('rewrites everything when the batch is rebuilt', () => {
    const { mesh, writes } = countingMesh(instances.length);
    const colorFor = () => base;

    writeInstanceColors(mesh, instances, colorFor);
    writes.length = 0;

    const rebuilt: Primitive[] = instances.map((p) => ({ ...p }));
    writeInstanceColors(mesh, rebuilt, colorFor);

    assert.deepStrictEqual([...writes].sort((a, b) => a - b), [0, 1, 2, 3]);
  });

  it('rewrites everything when the mesh remounts with a fresh buffer', () => {
    const colorFor = () => base;
    const { mesh } = countingMesh(instances.length);
    writeInstanceColors(mesh, instances, colorFor);

    // A remounted mesh has a new instance list identity and a new attribute.
    const { mesh: fresh, writes } = countingMesh(instances.length);
    writeInstanceColors(fresh, [...instances], colorFor);

    assert.deepStrictEqual([...writes].sort((a, b) => a - b), [0, 1, 2, 3]);
  });

  it('treats instances with no model as one group', () => {
    const { mesh, writes } = countingMesh(3);
    const mixed: Primitive[] = [{}, {}, { modelId: 'a' }];
    let active2 = false;
    const colorFor = (p: Primitive) => (active2 && !p.modelId ? active : base);

    writeInstanceColors(mesh, mixed, colorFor);
    writes.length = 0;

    active2 = true;
    writeInstanceColors(mesh, mixed, colorFor);

    assert.deepStrictEqual([...writes].sort((a, b) => a - b), [0, 1]);
  });
});
