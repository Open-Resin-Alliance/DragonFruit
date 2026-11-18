import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as THREE from 'three';

import IslandInstancesOverlayDefault, {
  CONSOLIDATED_VOXEL_COLOR_RGB,
  FRAGMENT_SHADER,
  IslandInstancesOverlay,
  MIN_PIN_SCREEN_RADIUS_CSS_PX,
  MIN_SCREEN_RADIUS_CSS_PX,
  PIN_EXTRA_DEPTH_BIAS_MM,
  VERTEX_SHADER,
  computeInstanceDepthBiasMm,
} from '../IslandInstancesOverlay';
import {
  IslandOverhangOverlay,
  OVERHANG_OVERLAY_RENDER_ORDER,
  OVERHANG_POLYGON_OFFSET,
} from '../IslandOverhangOverlay';

const INSTANCES_OVERLAY_URL = new URL('../IslandInstancesOverlay.tsx', import.meta.url);
const OVERHANG_OVERLAY_URL = new URL('../IslandOverhangOverlay.tsx', import.meta.url);

test('IslandInstancesOverlay exports required constants, component, and default export', () => {
  assert.equal(typeof IslandInstancesOverlay, 'function');
  assert.equal(IslandInstancesOverlayDefault, IslandInstancesOverlay);
  assert.equal(MIN_SCREEN_RADIUS_CSS_PX, 2);
  assert.equal(MIN_PIN_SCREEN_RADIUS_CSS_PX, 3.5);
  assert.equal(PIN_EXTRA_DEPTH_BIAS_MM, 0.03);
  assert.deepEqual(CONSOLIDATED_VOXEL_COLOR_RGB, [0.20, 0.92, 0.82]);
});

test('computeInstanceDepthBiasMm scales with layer height above 0.08 mm floor and guards invalid input', () => {
  const approx = (actual: number, expected: number) => {
    assert.ok(Math.abs(actual - expected) < 1e-12, `expected ${actual} ≈ ${expected}`);
  };

  approx(computeInstanceDepthBiasMm(), 0.08);
  approx(computeInstanceDepthBiasMm(0.05), 0.08);
  approx(computeInstanceDepthBiasMm(0.02), 0.08);
  approx(computeInstanceDepthBiasMm(0.03), 0.08);
  approx(computeInstanceDepthBiasMm(0.1), 0.16);
  approx(computeInstanceDepthBiasMm(0.2), 0.32);

  for (const invalid of [0, -0.05, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    approx(computeInstanceDepthBiasMm(invalid), 0.08);
  }
});

test('VERTEX_SHADER declares pin/bias uniforms and computes pin radius mix', () => {
  assert.match(VERTEX_SHADER, /uniform\s+float\s+uMinPinScreenRadiusPx\s*;/);
  assert.match(VERTEX_SHADER, /uniform\s+float\s+uDepthBiasMm\s*;/);
  assert.match(VERTEX_SHADER, /uniform\s+float\s+uPinExtraBiasMm\s*;/);

  assert.match(
    VERTEX_SHADER,
    /float\s+isPin\s*=\s*step\(\s*1\.5\s*,\s*vType\s*\)\s*\*\s*\(\s*1\.0\s*-\s*step\(\s*2\.5\s*,\s*vType\s*\)\s*\)\s*;/,
  );
  assert.match(
    VERTEX_SHADER,
    /float\s+minRadiusPx\s*=\s*mix\(\s*uMinScreenRadiusPx\s*,\s*uMinPinScreenRadiusPx\s*,\s*isPin\s*\)\s*;/,
  );
  assert.match(
    VERTEX_SHADER,
    /float\s+grow\s*=\s*max\(\s*1\.0\s*,\s*minRadiusPx\s*\/\s*max\(\s*radiusPx\s*,\s*1e-6\s*\)\s*\)\s*;/,
  );
});

test('VERTEX_SHADER computes radiusPx using per-axis 0.5 * uViewportPx (not uViewportPx.y)', () => {
  assert.match(
    VERTEX_SHADER,
    /float\s+radiusPx\s*=\s*length\(\s*\(\s*probeNdc\s*-\s*centerNdc\s*\)\s*\*\s*0\.5\s*\*\s*uViewportPx\s*\)\s*;/,
  );
  assert.equal(
    /uViewportPx\.y/.test(VERTEX_SHADER),
    false,
    'VERTEX_SHADER must scale probeNdc - centerNdc per-axis by uViewportPx, not scalar uViewportPx.y',
  );
});

test('VERTEX_SHADER clips un-biased mvPosition before applying perspective/ortho depth bias and preserves OCCLUDED_PASS', () => {
  const parkIdx = VERTEX_SHADER.indexOf('gl_Position = vec4(2.0, 2.0, 2.0, 1.0);');
  const clipIdx = VERTEX_SHADER.indexOf('#include <clipping_planes_vertex>');
  const occludedBranchIdx = VERTEX_SHADER.indexOf('gl_Position = projectionMatrix * mvPosition;');
  const biasAssignIdx = VERTEX_SHADER.indexOf('biasedMv.z += appliedBiasMm;');
  const biasedProjIdx = VERTEX_SHADER.indexOf('gl_Position = projectionMatrix * biasedMv;');

  assert.ok(parkIdx > -1, 'OCCLUDED_PASS early clip-space park present');
  assert.ok(clipIdx > parkIdx, '#include <clipping_planes_vertex> appears in main');
  assert.ok(occludedBranchIdx > clipIdx, 'OCCLUDED_PASS emits un-biased projection after clipping');
  assert.ok(biasAssignIdx > clipIdx, '#include <clipping_planes_vertex> MUST precede depth bias');
  assert.ok(biasedProjIdx > biasAssignIdx, 'biasedMv projected after adding appliedBiasMm');

  // Perspective vs orthographic guard (projectionMatrix[2][3] != 0.0)
  assert.match(VERTEX_SHADER, /float\s+totalBiasMm\s*=\s*uDepthBiasMm\s*\+\s*isPin\s*\*\s*uPinExtraBiasMm\s*;/);
  assert.match(VERTEX_SHADER, /projectionMatrix\[2\]\[3\]\s*!=\s*0\.0/);
  assert.match(VERTEX_SHADER, /clamp\(\s*totalBiasMm\s*,\s*0\.0\s*,\s*0\.25\s*\*\s*abs\(\s*mvPosition\.z\s*\)\s*\)/);
});

test('FRAGMENT_SHADER distinguishes COLOR_CONSOLIDATED from COLOR_VOXEL and adds dark contrast halo to intersection pins', () => {
  const voxelColorMatch = FRAGMENT_SHADER.match(/const\s+vec3\s+COLOR_VOXEL\s*=\s*vec3\(([^)]+)\)/);
  const consolidatedColorMatch = FRAGMENT_SHADER.match(/const\s+vec3\s+COLOR_CONSOLIDATED\s*=\s*vec3\(([^)]+)\)/);
  assert.ok(voxelColorMatch, 'COLOR_VOXEL defined');
  assert.ok(consolidatedColorMatch, 'COLOR_CONSOLIDATED defined');
  assert.notEqual(
    consolidatedColorMatch[1].replace(/\s+/g, ''),
    voxelColorMatch[1].replace(/\s+/g, ''),
    'COLOR_CONSOLIDATED must differ from COLOR_VOXEL',
  );
  assert.equal(consolidatedColorMatch[1].replace(/\s+/g, ''), '0.20,0.92,0.82');

  assert.match(FRAGMENT_SHADER, /dFdx\(\s*dist\s*\)/);
  assert.match(FRAGMENT_SHADER, /dFdy\(\s*dist\s*\)/);
  assert.match(
    FRAGMENT_SHADER,
    /mix\(\s*COLOR_INTERSECTION\s*,\s*vec3\(\s*0\.08\s*,\s*0\.02\s*,\s*0\.02\s*\)\s*,\s*haloMix\s*\)/,
  );
  const consolidatedBranchIdx = FRAGMENT_SHADER.indexOf('vType > 2.5');
  const intersectionBranchIdx = FRAGMENT_SHADER.indexOf('vType > 1.5');
  assert.ok(consolidatedBranchIdx > -1 && intersectionBranchIdx > consolidatedBranchIdx,
    'vType > 2.5 (consolidated) precedes vType > 1.5 (intersection pin)');
});

test('IslandInstancesOverlay wires layerHeightMm prop fallback and pin/bias uniforms', () => {
  const source = fs.readFileSync(INSTANCES_OVERLAY_URL, 'utf8');
  assert.match(source, /layerHeightMm\s*\?\?\s*instances\.layerHeightMm\s*\?\?\s*0\.05/);
  assert.match(source, /uMinPinScreenRadiusPx\s*:\s*\{\s*value:\s*MIN_PIN_SCREEN_RADIUS_CSS_PX\s*\}/);
  assert.match(source, /uDepthBiasMm\s*:\s*\{\s*value:\s*depthBiasMm\s*\}/);
  assert.match(source, /uPinExtraBiasMm\s*:\s*\{\s*value:\s*PIN_EXTRA_DEPTH_BIAS_MM\s*\}/);
  assert.match(source, /uniforms\.uMinPinScreenRadiusPx\.value\s*=\s*MIN_PIN_SCREEN_RADIUS_CSS_PX\s*\*\s*dpr/);
  assert.match(source, /uniforms\.uDepthBiasMm\.value\s*=\s*depthBiasMm/);
  assert.match(source, /renderOrder=\{999\}/);
  assert.match(source, /renderOrder=\{1000\}/);
});

test('IslandOverhangOverlay renders below IslandInstancesOverlay with negative polygonOffset', () => {
  assert.equal(typeof IslandOverhangOverlay, 'function');
  assert.equal(OVERHANG_OVERLAY_RENDER_ORDER, 995);
  assert.ok(OVERHANG_OVERLAY_RENDER_ORDER < 999, 'overhang overlay renders before occluded island pass (999)');
  assert.ok(OVERHANG_OVERLAY_RENDER_ORDER < 1000, 'overhang overlay renders before visible island pass (1000)');
  assert.deepEqual(OVERHANG_POLYGON_OFFSET, { factor: -1, units: -2 });
  assert.ok(OVERHANG_POLYGON_OFFSET.factor < 0 && OVERHANG_POLYGON_OFFSET.units < 0);

  // Verify Three.js MeshBasicMaterial accepts the polygonOffset settings cleanly.
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: OVERHANG_POLYGON_OFFSET.factor,
    polygonOffsetUnits: OVERHANG_POLYGON_OFFSET.units,
  });
  assert.equal(mat.polygonOffset, true);
  assert.equal(mat.polygonOffsetFactor, -1);
  assert.equal(mat.polygonOffsetUnits, -2);
  mat.dispose();

  const source = fs.readFileSync(OVERHANG_OVERLAY_URL, 'utf8');
  assert.equal(source.includes('renderOrder={1001}'), false, 'legacy renderOrder={1001} removed');
  const renderOrderMatches = source.match(/renderOrder=\{OVERHANG_OVERLAY_RENDER_ORDER\}/g) ?? [];
  assert.equal(renderOrderMatches.length, 3, 'all three overhang meshes use OVERHANG_OVERLAY_RENDER_ORDER');
  const offsetMatches = source.match(/polygonOffset:\s*true/g) ?? [];
  const factorMatches = source.match(/polygonOffsetFactor:\s*OVERHANG_POLYGON_OFFSET\.factor/g) ?? [];
  const unitsMatches = source.match(/polygonOffsetUnits:\s*OVERHANG_POLYGON_OFFSET\.units/g) ?? [];
  assert.equal(offsetMatches.length, 3, 'all three overhang materials enable polygonOffset');
  assert.equal(factorMatches.length, 3, 'all three overhang materials set polygonOffsetFactor');
  assert.equal(unitsMatches.length, 3, 'all three overhang materials set polygonOffsetUnits');
});
