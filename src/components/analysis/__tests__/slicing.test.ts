import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { computeLoopsAtZ, polygonArea } from '../Slice2D';

test('Slicing Performance Benchmark', () => {
    // Create a high-res sphere (approx 10k triangles)
    const geometry = new THREE.SphereGeometry(50, 100, 100);
    const numTriangles = geometry.getAttribute('position').count / 3;
    console.log(`\nGeometry: ${numTriangles} triangles`);

    const layers = 100;
    const start = performance.now();

    for (let i = 0; i < layers; i++) {
        const z = -40 + (i / layers) * 80;
        computeLoopsAtZ(geometry, z);
    }

    const end = performance.now();
    const totalTime = end - start;
    const timePerLayer = totalTime / layers;

    console.log(`Slicing ${layers} layers took ${totalTime.toFixed(2)}ms`);
    console.log(`Average time per layer: ${timePerLayer.toFixed(2)}ms`);

    // Estimate for a full print (e.g., 2000 layers)
    const estimatedFullScan = (timePerLayer * 2000) / 1000;
    console.log(`Estimated time for 2000 layers: ${estimatedFullScan.toFixed(2)}s`);

    const eqLoops = computeLoopsAtZ(geometry, 0.5);
    assert.equal(eqLoops.length, 1, 'indexed SphereGeometry slice away from pole seam should produce 1 closed loop');
    assert.ok(polygonArea(eqLoops[0]) > 7500, 'cross-section area near equator should exceed 7500 mm^2');
    geometry.dispose();
});
