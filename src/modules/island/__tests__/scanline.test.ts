import { test } from 'node:test';
import assert from 'node:assert';
import { rasterizeLoopsToMask } from '../raster';
import { rasterizeLoopsScanline } from '../scanline';
import { type Pt2 } from '../geometry';

test('Scanline vs Naive Rasterization Correctness', (t) => {
    // Create a complex polygon (star shape)
    const center = { x: 50, y: 50 };
    const outerRadius = 40;
    const innerRadius = 20;
    const points = 20;
    const loop: Pt2[] = [];

    for (let i = 0; i < points * 2; i++) {
        const r = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = (Math.PI * 2 * i) / (points * 2);
        loop.push({
            x: center.x + Math.cos(angle) * r,
            y: center.y + Math.sin(angle) * r
        });
    }

    const loops = [loop];
    const px_mm = 0.1;

    // Run both methods
    const naive = rasterizeLoopsToMask(loops, px_mm, 0);
    const scanline = rasterizeLoopsScanline(loops, px_mm, 0);

    // Verify dimensions match
    assert.strictEqual(naive.width, scanline.width, 'Width mismatch');
    assert.strictEqual(naive.height, scanline.height, 'Height mismatch');
    assert.strictEqual(naive.originX, scanline.originX, 'OriginX mismatch');
    assert.strictEqual(naive.originZ, scanline.originZ, 'OriginZ mismatch');

    // Verify pixel data matches (allow small mismatch due to floating point/edge inclusion differences)
    let mismatches = 0;
    const totalPixels = naive.data.length;
    for (let i = 0; i < totalPixels; i++) {
        if (naive.data[i] !== scanline.data[i]) {
            mismatches++;
        }
    }

    const mismatchPercent = (mismatches / totalPixels) * 100;
    console.log(`Mismatch: ${mismatches}/${totalPixels} pixels (${mismatchPercent.toFixed(2)}%)`);

    // Allow < 1% mismatch (typically edge pixels)
    assert.ok(mismatchPercent < 1.0, `Too many mismatches: ${mismatchPercent.toFixed(2)}%`);
});

test('Performance Benchmark', (t) => {
    // Create a smaller polygon for benchmark to avoid timeout
    const center = { x: 50, y: 50 };
    const radius = 40;
    const points = 1000;
    const loop: Pt2[] = [];

    for (let i = 0; i < points; i++) {
        const angle = (Math.PI * 2 * i) / points;
        // Add some noise to make it irregular
        const r = radius + (Math.random() - 0.5) * 2;
        loop.push({
            x: center.x + Math.cos(angle) * r,
            y: center.y + Math.sin(angle) * r
        });
    }

    const loops = [loop];
    const px_mm = 0.1; // Moderate resolution

    const startNaive = performance.now();
    rasterizeLoopsToMask(loops, px_mm, 0);
    const endNaive = performance.now();
    const naiveTime = endNaive - startNaive;

    const startScanline = performance.now();
    rasterizeLoopsScanline(loops, px_mm, 0);
    const endScanline = performance.now();
    const scanlineTime = endScanline - startScanline;

    console.log(`\nPerformance Benchmark (1000 points, 0.1mm px):`);
    console.log(`Naive: ${naiveTime.toFixed(2)}ms`);
    console.log(`Scanline: ${scanlineTime.toFixed(2)}ms`);
    console.log(`Speedup: ${(naiveTime / scanlineTime).toFixed(1)}x`);

    assert.ok(scanlineTime < naiveTime, 'Scanline should be faster than naive');
});
