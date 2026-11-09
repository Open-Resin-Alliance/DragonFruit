import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { syncInstancedStandardMaterialState } from '../instancedStandardMaterial';
import {
  INSTANCED_JOINT_PROGRAM_KEY,
  createInstancedJointMaterial,
} from '../instancedJointMaterial';

/**
 * The injection targets exist in the stock standard program, and the material
 * stays on it: the batch must keep the built-in lighting, clipping and tone
 * mapping rather than reimplementing them.
 */
test('the joint material injects instanceMatrix into the stock standard program', () => {
  const material = createInstancedJointMaterial();

  assert.equal(material.type, 'MeshStandardMaterial');
  assert.equal(material.vertexColors, true);
  assert.equal(material.color.getHexString(), 'ffffff');
  assert.equal(material.transparent, false);
  assert.equal(material.customProgramCacheKey(), INSTANCED_JOINT_PROGRAM_KEY);

  const stock = THREE.ShaderLib.physical;
  const shader = {
    vertexShader: stock.vertexShader,
    fragmentShader: stock.fragmentShader,
    uniforms: {},
  };
  material.onBeforeCompile(shader as never, null as never);

  // Declared once, before the body that uses it.
  assert.equal(shader.vertexShader.split('attribute mat4 instanceMatrix;').length - 1, 1);
  assert.ok(
    shader.vertexShader.indexOf('attribute mat4 instanceMatrix;') < shader.vertexShader.indexOf('void main()'),
  );

  // Applied after the chunk that declares `transformed`, and to the normal
  // before the stock normal matrix. The instance scale is non-uniform for a
  // tapered shaft or a cone, so the normal goes through three's own
  // non-uniform-scale correction rather than a bare `mat3(instanceMatrix)`.
  assert.ok(shader.vertexShader.includes(
    'transformed = ( instanceMatrix * vec4( transformed, 1.0 ) ).xyz;',
  ));
  assert.ok(shader.vertexShader.includes(
    'mat3 instanceNormalMatrix = mat3( instanceMatrix );',
  ));
  assert.ok(shader.vertexShader.includes(
    'objectNormal = instanceNormalMatrix * objectNormal;',
  ));
  assert.ok(shader.vertexShader.includes(
    'dot( instanceNormalMatrix[0], instanceNormalMatrix[0] ),',
  ));
  assert.ok(
    shader.vertexShader.indexOf('mat3 instanceNormalMatrix')
      > shader.vertexShader.indexOf('#include <beginnormal_vertex>'),
  );

  // Nothing is added to the fragment stage: step 1 has no per-instance emissive
  // and no integer attribute.
  assert.equal(shader.fragmentShader, stock.fragmentShader);
  assert.ok(!shader.vertexShader.includes('iData'));
  assert.ok(!shader.vertexShader.includes('iPick'));
});

test('the program cache key is constant across materials and calls', () => {
  const first = createInstancedJointMaterial();
  const second = createInstancedJointMaterial();
  assert.equal(first.customProgramCacheKey(), second.customProgramCacheKey());
  assert.equal(first.customProgramCacheKey(), INSTANCED_JOINT_PROGRAM_KEY);
});

test('material state sync applies the parent traversal values, and only when they change', () => {
  const material = createInstancedJointMaterial();
  const planes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), -5)];

  const versionBefore = material.version;
  syncInstancedStandardMaterialState(material, { clippingPlanes: planes, transparent: true, opacity: 0.4 });

  assert.deepEqual(material.clippingPlanes, planes);
  assert.equal(material.transparent, true);
  assert.equal(material.opacity, 0.4);
  // Ghost geometry must not write depth, exactly as the legacy material behaved.
  assert.equal(material.depthWrite, false);
  assert.ok(material.version > versionBefore);

  // Unchanged state is a no-op, so a re-render does not recompile.
  const stableVersion = material.version;
  syncInstancedStandardMaterialState(material, { clippingPlanes: planes, transparent: true, opacity: 0.4 });
  assert.equal(material.version, stableVersion);
});
