import assert from 'node:assert/strict';
import test from 'node:test';
import { findSceneCanvas } from '../canvasBuffer';

function engineCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-engine', 'three.js r180');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

test('the scene canvas is the largest R3F canvas, not the first one in the document', () => {
  const root = document.createElement('div');
  const preview = engineCanvas(143, 432);
  const scene = engineCanvas(1638, 1140);
  root.append(preview, document.createElement('canvas'), scene);
  assert.equal(findSceneCanvas(root), scene);
  assert.equal(findSceneCanvas(document.createElement('div')), null);
});
