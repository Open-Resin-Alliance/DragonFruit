/**
 * The `DFMX` decoder: what a native mesh load (and the display-mesh refine) sends
 * back. A leaf module — no React, no Tauri — so the app and headless callers share it.
 *
 * The layout is specified in docs/dev/mesh-wire-formats.md, and written by
 * `encode_mesh_bodies` in `src-tauri/src/mesh_repair.rs`; keep the offsets in step.
 */
import * as THREE from 'three';
import { inflateZlib } from '@/utils/inflateZlib';
import type { MeshHealthReport } from '@/utils/meshRepair';
import { runWithConcurrency } from '@/utils/runWithConcurrency';

const MESH_RESPONSE_HEADER_BYTES = 32;
const MESH_RESPONSE_BODY_ENTRY_BYTES = 8;
const SOUP_BYTES_PER_TRIANGLE = 9 * Float32Array.BYTES_PER_ELEMENT * 2;
/**
 * Version 2: each body is a zlib stream holding that body's soup (positions, then
 * one normal per corner). A scene's payloads are 910 MB across thirteen models, and
 * the channel only does ~75 MB/s effective during an import because the transfer
 * and the main thread that receives each model take turns — the volume is what the
 * load pays. The native encoder packs each body at zlib level 1 (2.7x on real
 * geometry) and the bodies are unpacked here with the platform's
 * `DecompressionStream`, off the main thread.
 */
const MESH_RESPONSE_VERSION = 2;
/** Bodies unpacked at once: 52-129 MB each once inflated, so not all at once. */
const BODY_INFLATE_CONCURRENCY = 4;

/** One decoded native payload: its bodies plus the header facts the STL preview
 *  path needs. */
export type DecodedMesh = {
  bodies: THREE.BufferGeometry[];
  /** The payload's preview bit: the body (or bodies) are a decimation. */
  isPreview: boolean;
  /** Triangles in the file the payload was made from. */
  originalTriangleCount: number;
  /** Triangles actually in this payload. */
  previewTriangleCount: number;
  /** Model-section triangles for a preview, when the loader classified them. */
  modelTriangleCount?: number;
  /** The classification report the loader produced for a single-body load, when
   *  it did. Passing this to `processGeometry` skips the native classify pass. */
  report?: MeshHealthReport;
  /** The mesh the loader kept for this payload's AO bake, when it kept one (a
   *  single-body load). The bake asks for it by token instead of being sent the
   *  soup back: 36 bytes a triangle, 430 MB across a scene. 0 or absent means the
   *  caller sends the soup, which is what every other geometry does. */
  meshToken?: number;
};

/**
 * Unpack one packed body into its geometry.
 *
 * The stream is the platform's own decompressor — genuinely off the main thread,
 * unlike `fflate`'s pool, which waits on its workers through `SharedArrayBuffer` in
 * a `crossOriginIsolated` webview and blocks the thread it should free. Its output
 * is a fresh `ArrayBuffer`, so the geometry can view it directly rather than copying
 * the soup again. `inflateZlib` falls back to a synchronous inflate on webviews
 * older than Safari 16.4.
 */
async function decodeBody(packed: Uint8Array, triangleCount: number): Promise<THREE.BufferGeometry> {
  const soup = await inflateZlib(packed);
  const expected = triangleCount * SOUP_BYTES_PER_TRIANGLE;
  if (soup.byteLength !== expected) {
    throw new Error(
      `Native mesh loader returned a body that unpacks to ${soup.byteLength} bytes, ` +
      `not the ${expected} its table entry claims.`,
    );
  }
  const corners = triangleCount * 9;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(soup.buffer, soup.byteOffset, corners), 3),
  );
  geometry.setAttribute(
    'normal',
    new THREE.BufferAttribute(
      new Float32Array(soup.buffer, soup.byteOffset + corners * Float32Array.BYTES_PER_ELEMENT, corners),
      3,
    ),
  );
  return geometry;
}

/**
 * Decode a DFMX payload into one geometry per body.
 *
 * Each body arrives packed (version 2) and is unpacked four at a time; the packed
 * bytes are views into the payload buffer, which belongs to this call — Tauri's IPC
 * is a `fetch` against a custom-protocol URL (`tauri`'s `ipc-protocol.js`), so
 * `response.arrayBuffer()` hands back a buffer nothing reuses or shortens.
 */
export async function decodeDfmx(payload: Uint8Array | ArrayBuffer): Promise<DecodedMesh> {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (bytes.byteLength < MESH_RESPONSE_HEADER_BYTES) {
    throw new Error('Native mesh loader returned a truncated DFMX header.');
  }
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    header.getUint8(0), header.getUint8(1), header.getUint8(2), header.getUint8(3),
  );
  if (magic !== 'DFMX') {
    throw new Error(`Native mesh loader returned an unsupported payload (${magic}).`);
  }
  if (header.getUint32(4, true) !== MESH_RESPONSE_VERSION) {
    throw new Error('Native mesh loader returned an unsupported DFMX version.');
  }

  const bodyCount = header.getUint32(12, true);
  // The table first: each entry carries the body's triangle count and the length of
  // its packed stream, so the bodies no longer follow from the header alone.
  let offset = MESH_RESPONSE_HEADER_BYTES + bodyCount * MESH_RESPONSE_BODY_ENTRY_BYTES;
  const table: Array<{ index: number; triangleCount: number; packed: Uint8Array }> = [];
  for (let index = 0; index < bodyCount; index += 1) {
    const entry = MESH_RESPONSE_HEADER_BYTES + index * MESH_RESPONSE_BODY_ENTRY_BYTES;
    const triangleCount = header.getUint32(entry, true);
    const packedBytes = header.getUint32(entry + 4, true);
    if (offset + packedBytes > bytes.byteLength) {
      throw new Error('Native mesh loader returned a truncated DFMX body.');
    }
    table.push({ index, triangleCount, packed: bytes.subarray(offset, offset + packedBytes) });
    offset += packedBytes;
  }

  const bodies = new Array<THREE.BufferGeometry>(bodyCount);
  await runWithConcurrency(table, BODY_INFLATE_CONCURRENCY, async (body) => {
    bodies[body.index] = await decodeBody(body.packed, body.triangleCount);
  });
  const previewTriangleCount = table.reduce((sum, body) => sum + body.triangleCount, 0);

  const meshToken = header.getUint32(28, true);
  const modelTriangleCount = header.getUint32(20, true);
  const metadataLength = header.getUint32(24, true);
  let report: MeshHealthReport | undefined;
  if (metadataLength > 0 && metadataLength <= bytes.byteLength) {
    const json = new TextDecoder().decode(bytes.subarray(bytes.byteLength - metadataLength));
    try {
      report = JSON.parse(json) as MeshHealthReport;
    } catch (error) {
      // A report we cannot read is not worth failing the mesh over: dropping it
      // sends the caller back to the staging classify pass, which is correct.
      console.warn('[loadMeshFile] could not parse the native classification report.', error);
    }
  }

  return {
    bodies,
    isPreview: (header.getUint32(8, true) & 1) !== 0,
    originalTriangleCount: header.getUint32(16, true),
    previewTriangleCount,
    modelTriangleCount: modelTriangleCount > 0 ? modelTriangleCount : undefined,
    ...(meshToken > 0 ? { meshToken } : {}),
    report,
  };
}
