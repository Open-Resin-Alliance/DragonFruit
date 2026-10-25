import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import { INSTANCED_JOINT_PROGRAM_KEY } from '../instancedJointMaterial';
import { createInstancedStandardMaterial } from '../instancedStandardMaterial';

/**
 * One shader, one name per primitive kind: a shaft batch and a joint batch inject
 * the same two steps, so the only thing that keeps them from sharing a compiled
 * program is the key each is given.
 */
test('the shared batch material keeps the program key it was given', () => {
  const shaft = createInstancedStandardMaterial('df-instanced-shaft');
  const joint = createInstancedStandardMaterial(INSTANCED_JOINT_PROGRAM_KEY);

  assert.equal(shaft.customProgramCacheKey(), 'df-instanced-shaft');
  assert.equal(joint.customProgramCacheKey(), INSTANCED_JOINT_PROGRAM_KEY);
  assert.notEqual(shaft.customProgramCacheKey(), joint.customProgramCacheKey());
});

test('a shaft batch material injects the two shared steps and nothing else', () => {
  const material = createInstancedStandardMaterial('df-instanced-shaft');

  assert.equal(material.type, 'MeshStandardMaterial');
  assert.equal(material.vertexColors, true);
  assert.equal(material.color.getHexString(), 'ffffff');

  const stock = THREE.ShaderLib.physical;
  const shader = {
    vertexShader: stock.vertexShader,
    fragmentShader: stock.fragmentShader,
    uniforms: {},
  };
  material.onBeforeCompile(shader as never, null as never);

  assert.equal(shader.vertexShader.split('attribute mat4 instanceMatrix;').length - 1, 1);
  assert.ok(shader.vertexShader.includes(
    'transformed = ( instanceMatrix * vec4( transformed, 1.0 ) ).xyz;',
  ));
  // A tapered shaft or a cone has an axial normal component and a non-uniform
  // instance scale, so the normal takes three's own non-uniform-scale
  // correction — the exact rule the legacy `<instancedMesh>` buckets get.
  assert.ok(shader.vertexShader.includes(
    'mat3 instanceNormalMatrix = mat3( instanceMatrix );',
  ));
  assert.ok(shader.vertexShader.includes(
    'objectNormal /= vec3(',
  ));
  assert.ok(shader.vertexShader.includes(
    'objectNormal = instanceNormalMatrix * objectNormal;',
  ));
  assert.equal(shader.fragmentShader, stock.fragmentShader);
});
