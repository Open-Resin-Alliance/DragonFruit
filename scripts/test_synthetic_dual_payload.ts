import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { serializeVoxlDocumentV2 } from '@/features/scene/voxl/codec-v2';
import type { BuildVoxlDocumentInput, VoxlModelRuntimeLike } from '@/features/scene/voxl/types';
import type { DragonfruitImportFormat } from '@/supports/types';

const EMPTY_SUPPORTS = {
  version: 1,
  meta: { source: 'test', objectCenter: { x: 0, y: 0, z: 0 } },
  roots: [],
} as unknown as DragonfruitImportFormat;

/**
 * Creates a valid binary STL payload with specified triangle count.
 */
function createSyntheticStl(numTriangles: number): Uint8Array {
  const bufferLength = 84 + numTriangles * 50;
  const buffer = new Uint8Array(bufferLength);
  const view = new DataView(buffer.buffer);

  // 80-byte header
  const headerText = `Synthetic STL ${numTriangles} triangles`;
  const encoder = new TextEncoder();
  buffer.set(encoder.encode(headerText), 0);

  // 4-byte uint32 LE triangle count
  view.setUint32(80, numTriangles, true);

  // Write triangles
  let offset = 84;
  for (let i = 0; i < numTriangles; i++) {
    // Normal (0, 0, 1)
    view.setFloat32(offset + 0, 0.0, true);
    view.setFloat32(offset + 4, 0.0, true);
    view.setFloat32(offset + 8, 1.0, true);

    // Vertex 1: (0, 0, 0)
    view.setFloat32(offset + 12, 0.0, true);
    view.setFloat32(offset + 16, 0.0, true);
    view.setFloat32(offset + 20, 0.0, true);

    // Vertex 2: (10, 0, 0)
    view.setFloat32(offset + 24, 10.0, true);
    view.setFloat32(offset + 28, 0.0, true);
    view.setFloat32(offset + 32, 0.0, true);

    // Vertex 3: (0, 10, 10)
    view.setFloat32(offset + 36, 0.0, true);
    view.setFloat32(offset + 40, 10.0, true);
    view.setFloat32(offset + 44, 10.0, true);

    // Attribute byte count (0)
    view.setUint16(offset + 48, 0, true);

    offset += 50;
  }

  return buffer;
}

async function main() {
  console.log('--- Dual-Payload VOXL Verification Test ---');

  const voxlFile = resolve(process.cwd(), 'synthetic_dual_payload.voxl');
  const outFile = resolve(process.cwd(), 'synthetic_out.nanodlp');

  try {
    // Step 2: Generate 512-triangle preview MESH chunk and 8192-triangle ORIG chunk
    console.log('1. Generating synthetic STL payloads (MESH=512 tris, ORIG=8192 tris)...');
    const previewStl = createSyntheticStl(512);
    const originalStl = createSyntheticStl(8192);

    const model: VoxlModelRuntimeLike = {
      id: 'model-dual-payload-0',
      name: 'synthetic_model',
      visible: true,
      color: '#00ffaa',
      polygonCount: 8192,
      transform: {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      mesh: {
        mode: 'embedded-chunk',
        fileName: 'synthetic_model.stl',
        mimeType: 'model/stl',
        uncompressedSizeBytes: previewStl.length,
      },
    };

    const input: BuildVoxlDocumentInput = {
      models: [model],
      activeModelId: model.id,
      selectedModelIds: [],
      supports: EMPTY_SUPPORTS,
    };

    const meshBytesMap = new Map<number, Uint8Array>([[0, previewStl]]);
    const originalMeshBytesMap = new Map<number, Uint8Array>([[0, originalStl]]);

    // Step 3: Serialize to VOXL V2 document with embedOriginalMesh: true
    console.log('2. Serializing dual-payload VOXL file...');
    const voxlBytes = await serializeVoxlDocumentV2(
      input,
      meshBytesMap,
      undefined,
      {
        originalMeshBytes: originalMeshBytesMap,
        embedOriginalMesh: true,
      }
    );

    writeFileSync(voxlFile, voxlBytes);
    console.log(`Saved ${voxlFile} (${voxlBytes.length} bytes)`);

    // Step 4: Run cargo CLI slicer command
    console.log('3. Running Rust CLI slicer command...');
    const cargoCmd = `cargo run --manifest-path rust/dragonfruit-cli/Cargo.toml -- slice run "${voxlFile}" -o "${outFile}" --json`;
    console.log(`Executing: ${cargoCmd}`);
    const stdout = execSync(cargoCmd, { cwd: process.cwd(), encoding: 'utf-8' });

    console.log('CLI Slicer Output JSON:');
    console.log(stdout.trim());

    // Step 5: Verify JSON output
    const jsonResult = JSON.parse(stdout.trim());

    console.log('\n--- Verification Checks ---');
    console.log(`model_triangle_count: ${jsonResult.model_triangle_count} (expected: 8192)`);
    console.log(`mesh_encoding: ${jsonResult.mesh_encoding} (expected: voxl_orig)`);
    console.log(`slice layers: ${jsonResult.layers}`);
    console.log(`output file exists: ${existsSync(outFile)}`);

    let passed = true;
    if (jsonResult.model_triangle_count !== 8192) {
      console.error('FAILED: model_triangle_count does not equal 8192!');
      passed = false;
    }
    if (jsonResult.mesh_encoding !== 'voxl_orig') {
      console.error('FAILED: mesh_encoding does not equal voxl_orig!');
      passed = false;
    }
    if (!existsSync(outFile)) {
      console.error('FAILED: Output file synthetic_out.nanodlp was not created!');
      passed = false;
    }

    if (passed) {
      console.log('\nSUCCESS: All dual-payload VOXL verification assertions passed!');
    } else {
      process.exitCode = 1;
    }

  } catch (err) {
    console.error('Error during verification:', err);
    process.exitCode = 1;
  } finally {
    // Step 6: Clean up temporary test files
    console.log('\nCleaning up temporary files...');
    if (existsSync(voxlFile)) {
      unlinkSync(voxlFile);
      console.log(`Removed ${voxlFile}`);
    }
    if (existsSync(outFile)) {
      unlinkSync(outFile);
      console.log(`Removed ${outFile}`);
    }
  }
}

main();
