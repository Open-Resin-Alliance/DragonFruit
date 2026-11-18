import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyGpuRenderer } from '../gpuRenderer';

test('integrated and discrete renderer strings are told apart', () => {
  assert.equal(
    classifyGpuRenderer('ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    'integrated',
  );
  assert.equal(
    classifyGpuRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    'discrete',
  );
  assert.equal(
    classifyGpuRenderer('ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    'integrated',
  );
  assert.equal(
    classifyGpuRenderer('ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    'discrete',
  );
});

test('Intel Arc is discrete, not integrated', () => {
  // The vendor name contains "Intel", so the integrated check must not win.
  assert.equal(
    classifyGpuRenderer('ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    'discrete',
  );
});

test('software rasterisers are detected before vendor names', () => {
  assert.equal(
    classifyGpuRenderer('ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)'),
    'software',
  );
  assert.equal(
    classifyGpuRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)'),
    'software',
  );
});

test('an unrecognised renderer stays unknown so the warning never fires on a guess', () => {
  assert.equal(classifyGpuRenderer('Mystery Renderer'), 'unknown');
});
