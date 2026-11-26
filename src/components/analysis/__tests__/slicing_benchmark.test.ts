import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as THREE from 'three';
import { computeLoopsAtZ, BucketedSlicer, polygonArea } from '../Slice2D';

describe('Slicing Performance Benchmark', () => {
    it('should be significantly faster with BucketedSlicer', () => {
        // 1. Generate a complex mesh (indexed and non-indexed views of a sphere)
        const geometry = new THREE.SphereGeometry(10, 64, 64); // ~8000 triangles
        const nonIndexed = geometry.toNonIndexed();
        const positions = nonIndexed.getAttribute('position').array as Float32Array;

        // 2. Setup Slicers
        const slicer = new BucketedSlicer(positions, 1.0); // 1mm buckets

        const numLayers = 100;
        const layerHeight = 0.2;

        // 3. Benchmark Naive
        const startNaive = performance.now();
        for (let i = 0; i < numLayers; i++) {
            const z = -10 + i * layerHeight;
            computeLoopsAtZ(geometry, z);
        }
        const timeNaive = performance.now() - startNaive;

        // 4. Benchmark Bucketed
        const startBucketed = performance.now();
        for (let i = 0; i < numLayers; i++) {
            const z = -10 + i * layerHeight;
            slicer.slice(z);
        }
        const timeBucketed = performance.now() - startBucketed;

        console.log(`\nSlicing Benchmark (${numLayers} layers, ~8k triangles):`);
        console.log(`Naive: ${timeNaive.toFixed(2)}ms`);
        console.log(`Bucketed: ${timeBucketed.toFixed(2)}ms`);
        console.log(`Speedup: ${(timeNaive / timeBucketed).toFixed(1)}x`);

        const eqNaive = computeLoopsAtZ(geometry, 0.5);
        const eqBucketed = slicer.slice(0.5);
        assert.equal(eqNaive.length, 1, 'indexed SphereGeometry slice should emit 1 loop');
        assert.equal(eqBucketed.length, 1, 'BucketedSlicer slice should emit 1 loop');
        assert.ok(Math.abs(polygonArea(eqNaive[0]) - polygonArea(eqBucketed[0])) < 1e-2);

        geometry.dispose();
        nonIndexed.dispose();

        if (timeBucketed > timeNaive) {
            throw new Error('Bucketed slicer is slower!');
        }
    });
});
