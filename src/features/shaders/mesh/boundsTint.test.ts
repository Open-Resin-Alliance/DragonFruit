import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { applyBoundsTint, createBoundsTintUniforms } from './boundsTint';

function standardShader() {
  return {
    vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    uniforms: { existing: { value: 7 } },
  };
}

test('bounds tint augments standard shader chunks after projection and output conversion', () => {
  const shader = standardShader();
  const uniforms = createBoundsTintUniforms();
  applyBoundsTint(shader, uniforms);
  assert.ok(shader.vertexShader.indexOf('vBoundsTintWorldPosition =') > shader.vertexShader.indexOf('#include <project_vertex>'));
  assert.ok(shader.fragmentShader.indexOf('if (uBoundsTintEnabled') > shader.fragmentShader.indexOf('#include <colorspace_fragment>'));
  assert.ok(shader.fragmentShader.includes('#include <clipping_planes_fragment>'));
  assert.ok(shader.fragmentShader.includes('vBoundsTintWorldPosition.z > uBoundsTintMax.z'));
  assert.ok(shader.fragmentShader.includes('mix(gl_FragColor.rgb, boundsTintStripe, 0.42)'));
  assert.equal(shader.uniforms.existing.value, 7);
  assert.equal((shader.uniforms as unknown as typeof uniforms).uBoundsTintEnabled, uniforms.uBoundsTintEnabled);
});

test('boundary, bed and color changes use live uniforms without a new program', () => {
  const shader = standardShader();
  const uniforms = createBoundsTintUniforms();
  applyBoundsTint(shader, uniforms);
  const source = [shader.vertexShader, shader.fragmentShader];
  assert.equal(uniforms.uBoundsTintEnabled.value, 0);
  uniforms.uBoundsTintEnabled.value = 1;
  uniforms.uBoundsTintMin.value.set(200, -60, 0);
  uniforms.uBoundsTintMax.value.set(400, 60, 180);
  uniforms.uBoundsTintColor.value.set('#ff0000');
  const live = shader.uniforms as unknown as typeof uniforms;
  assert.equal(live.uBoundsTintEnabled.value, 1);
  assert.deepEqual(live.uBoundsTintMin.value.toArray(), [200, -60, 0]);
  assert.deepEqual(live.uBoundsTintMax.value.toArray(), [400, 60, 180]);
  assert.equal(live.uBoundsTintColor.value.getHexString(), 'ff0000');
  uniforms.uBoundsTintEnabled.value = 0;
  assert.equal(live.uBoundsTintEnabled.value, 0);
  assert.deepEqual([shader.vertexShader, shader.fragmentShader], source);
});

test('each model has independent bounds and tint state', () => {
  const first = createBoundsTintUniforms(), second = createBoundsTintUniforms();
  first.uBoundsTintEnabled.value = 1;
  first.uBoundsTintMin.value.set(100, 200, 300);
  assert.equal(second.uBoundsTintEnabled.value, 0);
  assert.deepEqual(second.uBoundsTintMin.value.toArray(), [0, 0, 0]);
});
