/**
 * LYS anatomy-less contact-disk seating PROBE (throwaway, read-only).
 *
 * Purpose (see .scratch/lys-twig-contact-disk-plan.md §7):
 *   Turn unknowns into measured numbers BEFORE touching the importer.
 *   For the twig (s573) and leaf-on-twig (s574) contacts in V3 Puck:
 *     - Does a mesh raycast HIT at the contact point?  (load-bearing assumption)
 *     - How far does the authored LYS contact point FLOAT off the true surface?
 *     - How much does the LYS authored normal DIVERGE from the true mesh normal?
 *       (both smoothed and raw face normal)
 *
 * It decodes o4 geometry from V3 Puck.lys using LysParser's EXACT pipeline,
 * rebuilds the importer's ghost mesh (useLysSceneImport policy), and casts.
 *
 * Run: node .scratch/lys-twig-probe/probe.mjs
 */

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { decode } from '@msgpack/msgpack';

const LYS_PATH = 'C:\\Users\\tyman\\Desktop\\Lys Conversion\\V3 Puck.lys';

// ---------------------------------------------------------------------------
// LysParser decode constants + helpers (verbatim from LysParser.ts:14-19,21-28,324-338)
// ---------------------------------------------------------------------------
const LYS_KEY_OBFUSCATION = 'DragonFruitFTW';
const LYS_DEFAULT_APP_ID_XOR = [
  0x25, 0x4a, 0x04, 0x02, 0x5e, 0x5f, 0x72, 0x44, 0x58, 0x51, 0x10, 0x76,
  0x67, 0x7a, 0x70, 0x10, 0x57, 0x5e, 0x42, 0x56, 0x27, 0x44, 0x42, 0x44,
  0x41, 0x7f, 0x64, 0x67, 0x7d, 0x13, 0x52, 0x01, 0x56, 0x0b, 0x23, 0x45,
];

function xorDeobfuscateToUtf8(input, mask) {
  const maskBytes = new TextEncoder().encode(mask);
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = input[i] ^ maskBytes[i % maskBytes.length];
  return new TextDecoder('utf-8').decode(out);
}
const DEFAULT_APP_ID = xorDeobfuscateToUtf8(LYS_DEFAULT_APP_ID_XOR, LYS_KEY_OBFUSCATION);

function decodeProtectedBytes(data, key) {
  const out = new Uint8Array(data.length);
  const keyBytes = new TextEncoder().encode(key);
  const klen = keyBytes.length;
  for (let i = 0; i < data.length; i++) {
    const k = keyBytes[i % klen];
    const val = data[i] - k;
    out[i] = ((val % 256) + 256) % 256;
  }
  return out;
}

function findJsonHeader(data) {
  const decoder = new TextDecoder('utf-8');
  const maxScan = Math.min(data.length, 2_000_000);
  const tryExtract = (start) => {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < maxScan; i++) {
      const c = data[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (c === 92) { escaped = true; continue; }
        if (c === 34) inString = false;
        continue;
      }
      if (c === 34) { inString = true; continue; }
      if (c === 123) { depth++; continue; }
      if (c === 125) { depth--; if (depth === 0) return { start, end: i + 1 }; if (depth < 0) return null; }
    }
    return null;
  };
  const marker = new TextEncoder().encode('"mangoFiles"');
  const markerStarts = [];
  for (let i = 0; i <= maxScan - marker.length; i++) {
    let ok = true;
    for (let j = 0; j < marker.length; j++) if (data[i + j] !== marker[j]) { ok = false; break; }
    if (ok) markerStarts.push(i);
  }
  const candidateStarts = [];
  for (const m of markerStarts) for (let i = m; i >= Math.max(0, m - 200_000); i--) if (data[i] === 123) { candidateStarts.push(i); break; }
  for (let i = 0; i < maxScan; i++) { if (data[i] === 123) candidateStarts.push(i); if (candidateStarts.length > 2000) break; }
  const seen = new Set();
  for (const start of candidateStarts) {
    if (seen.has(start)) continue;
    seen.add(start);
    const bounds = tryExtract(start);
    if (!bounds) continue;
    try {
      const parsed = JSON.parse(decoder.decode(data.subarray(bounds.start, bounds.end)));
      if (parsed && typeof parsed === 'object' && (parsed.mangoFiles || parsed.version || parsed.scene)) return bounds;
    } catch { /* keep scanning */ }
  }
  throw new Error('LYS manifest JSON header not found');
}

// Geometry blob parse — verbatim policy from LysParser.parseGeometry (:343-414),
// INCLUDING toNonIndexed() + computeVertexNormals() so normals are flat-per-face
// exactly as the importer raycasts.
function parseGeometry(buffer) {
  const MIN_HEADER_BYTES = 20;
  const view = new DataView(buffer);
  if (buffer.byteLength < MIN_HEADER_BYTES) throw new Error('Geometry file too short');
  const declaredHeaderLength = view.getUint32(4, true);
  const dataOffset = (Number.isFinite(declaredHeaderLength) && declaredHeaderLength >= MIN_HEADER_BYTES && declaredHeaderLength <= buffer.byteLength)
    ? declaredHeaderLength : MIN_HEADER_BYTES;
  const nIndices = view.getUint32(8, true);
  const nCoords = view.getUint32(12, true);
  if (!nIndices || !nCoords) throw new Error(`invalid counts (i=${nIndices}, c=${nCoords})`);
  if (nCoords % 3 !== 0) throw new Error(`non-vec3 coord count (${nCoords})`);
  const indicesByteLen = nIndices * 4;
  const coordsByteLen = nCoords * 4;
  if (indicesByteLen + coordsByteLen > buffer.byteLength - dataOffset) throw new Error('byte length mismatch');
  const indicesStart = dataOffset;
  const indicesEnd = indicesStart + indicesByteLen;
  const coordsStart = indicesEnd;
  const coordsEnd = coordsStart + coordsByteLen;
  const indices = new Uint32Array(buffer.slice(indicesStart, indicesEnd));
  const coords = new Float32Array(buffer.slice(coordsStart, coordsEnd));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(coords, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  const flat = geometry.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

// ---------------------------------------------------------------------------
// calculateSmoothedNormal — faithful port of PlacementUtils.ts:21-79
// ---------------------------------------------------------------------------
const _nA = new THREE.Vector3(), _nB = new THREE.Vector3(), _nC = new THREE.Vector3();
const _pA = new THREE.Vector3(), _pB = new THREE.Vector3(), _pC = new THREE.Vector3();
const _tri = new THREE.Triangle(), _bary = new THREE.Vector3(), _interp = new THREE.Vector3();
function calculateSmoothedNormal(hit) {
  if (!hit.face || !(hit.object instanceof THREE.Mesh) || !hit.object.geometry) {
    return { x: hit.face?.normal.x ?? 0, y: hit.face?.normal.y ?? 0, z: hit.face?.normal.z ?? 1 };
  }
  const geom = hit.object.geometry;
  const normalAttr = geom.attributes.normal;
  if (!normalAttr) return { x: hit.face.normal.x, y: hit.face.normal.y, z: hit.face.normal.z };
  const positionAttr = geom.attributes.position;
  const { a, b, c } = hit.face;
  _nA.fromBufferAttribute(normalAttr, a);
  _nB.fromBufferAttribute(normalAttr, b);
  _nC.fromBufferAttribute(normalAttr, c);
  _pA.fromBufferAttribute(positionAttr, a);
  _pB.fromBufferAttribute(positionAttr, b);
  _pC.fromBufferAttribute(positionAttr, c);
  _pA.applyMatrix4(hit.object.matrixWorld);
  _pB.applyMatrix4(hit.object.matrixWorld);
  _pC.applyMatrix4(hit.object.matrixWorld);
  _tri.set(_pA, _pB, _pC);
  _tri.getBarycoord(hit.point, _bary);
  _interp.set(0, 0, 0);
  _interp.addScaledVector(_nA, _bary.x);
  _interp.addScaledVector(_nB, _bary.y);
  _interp.addScaledVector(_nC, _bary.z);
  _interp.normalize();
  _interp.transformDirection(hit.object.matrixWorld);
  return { x: _interp.x, y: _interp.y, z: _interp.z };
}

// ---------------------------------------------------------------------------
// Load container
// ---------------------------------------------------------------------------
const buf = readFileSync(LYS_PATH);
const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
const { start, end } = findJsonHeader(data);
const manifest = JSON.parse(new TextDecoder('utf-8').decode(data.subarray(start, end)));
let dataStart = end;
while (dataStart < data.length && data[dataStart] === 0) dataStart++;

const filesInfo = manifest.mangoFiles || {};
let sceneBlob = null;
const geomBlobs = new Map();
for (const [fname, info] of Object.entries(filesInfo)) {
  const name = fname.toLowerCase();
  const absOffset = dataStart + Number(info.offset || 0);
  const size = Number(info.size || 0);
  if (name === 'scene.bin') sceneBlob = data.subarray(absOffset, absOffset + size);
  else if (name.endsWith('.bin')) geomBlobs.set(fname.slice(0, fname.length - 4), data.subarray(absOffset, absOffset + size));
}
if (!sceneBlob) throw new Error('scene.bin not found');
const scene = decode(decodeProtectedBytes(sceneBlob, DEFAULT_APP_ID));

// Select o4's geometry blob. The blob is named by a CONTENT HASH, not the object id;
// the object links to it via o4.properties.hash (verified). Fall back to the single /
// largest blob (mirrors LysParser's "largest parseable blob = geometry").
const objects = scene?.objects?.present?.byId ?? {};
const o4 = objects['o4'];
const o4Hash = o4?.properties?.hash;
let o4Blob = o4Hash ? geomBlobs.get(o4Hash) : null;
if (!o4Blob) for (const [stem, b] of geomBlobs) if (stem.toLowerCase() === String(o4Hash).toLowerCase()) { o4Blob = b; break; }
if (!o4Blob) {
  // single/largest fallback
  let best = null;
  for (const [, b] of geomBlobs) if (!best || b.byteLength > best.byteLength) best = b;
  o4Blob = best;
}
if (!o4Blob) throw new Error(`no geometry blob found. stems: ${[...geomBlobs.keys()].join(', ')}`);
console.log(`[probe] o4.properties.hash=${o4Hash}  selected blob bytes=${o4Blob.byteLength}`);
const o4Geo = parseGeometry(o4Blob.slice().buffer);

// ---------------------------------------------------------------------------
// Rebuild ghost mesh EXACTLY as useLysSceneImport.ts:212-227 (o4: rot0/scale1/+5z)
// ---------------------------------------------------------------------------
const center = o4.formerCenter || o4.center || { x: 0, y: 0, z: 0 };
const position = o4.position || { x: 0, y: 0, z: 0 };
const scale = o4.scale || { x: 1, y: 1, z: 1 };
const rotation = o4.rotation || { x: 0, y: 0, z: 0 };

const ghostGroup = new THREE.Group();
ghostGroup.position.set(0, 0, position.z);
ghostGroup.scale.set(scale.x, scale.y, scale.z);
const deg2rad = Math.PI / 180;
ghostGroup.rotation.copy(new THREE.Euler((rotation.x || 0) * deg2rad, (rotation.y || 0) * deg2rad, (rotation.z || 0) * deg2rad, 'XYZ'));
const mesh = new THREE.Mesh(o4Geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
mesh.position.set(-center.x, -center.y, -center.z);
ghostGroup.add(mesh);
ghostGroup.updateMatrixWorld(true);
mesh.geometry.computeBoundingSphere();

// transformObjectPoint for o4 (scale1/rot0 → just +z), matching convertLysData.ts:134-140
const transformObjectPoint = (v) => new THREE.Vector3(v.x * scale.x, v.y * scale.y, v.z * scale.z).add(new THREE.Vector3(0, 0, position.z));
// rotation/scale are identity here so no quaternion needed; assert that to be safe:
if (rotation.x || rotation.y || rotation.z) throw new Error('PROBE ASSUMES rot=0 for o4; got ' + JSON.stringify(rotation));

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const V = (o) => new THREE.Vector3(o.x, o.y, o.z);
const angleDeg = (a, b) => THREE.MathUtils.radToDeg(a.clone().normalize().angleTo(b.clone().normalize()));

// Bounding box of mesh in world space, for sanity-gate ray heights.
const worldBox = new THREE.Box3().setFromObject(ghostGroup);

function allHits(origin, dir) {
  const rc = new THREE.Raycaster();
  rc.set(origin.clone(), dir.clone().normalize());
  return rc.intersectObject(mesh, false); // sorted near→far
}

// Model bounding radius (for placing ray origins safely OUTSIDE the solid).
const _bs = new THREE.Box3().setFromObject(ghostGroup).getBoundingSphere(new THREE.Sphere());
const FAR = _bs.radius * 2 + 50;

// Cast along a unit direction THROUGH the contact point, and pick the intersection
// CLOSEST to the authored contact point (robust to concavity / interior origins).
// origin is placed FAR outside the model, opposite to travel dir, so the ray
// enters from outside and crosses the contact region.
function castThroughContact(contact, travelDir) {
  const d = travelDir.clone().normalize();
  const origin = contact.clone().addScaledVector(d, -FAR); // far back along -d
  const hits = allHits(origin, d);
  if (!hits.length) return null;
  let best = hits[0], bestDist = best.point.distanceTo(contact);
  for (const h of hits) {
    const dist = h.point.distanceTo(contact);
    if (dist < bestDist) { best = h; bestDist = dist; }
  }
  return best;
}

const supports = scene?.supports?.present?.byId ?? {};
const s573 = supports['s573'];
const s574 = supports['s574'];

console.log('=== PROBE: V3 Puck anatomy-less contact seating ===\n');
console.log('o4 transform: center', JSON.stringify(center), 'pos', JSON.stringify(position), 'scale', JSON.stringify(scale), 'rot', JSON.stringify(rotation));
console.log('mesh world AABB:', `min(${worldBox.min.x.toFixed(2)},${worldBox.min.y.toFixed(2)},${worldBox.min.z.toFixed(2)}) max(${worldBox.max.x.toFixed(2)},${worldBox.max.y.toFixed(2)},${worldBox.max.z.toFixed(2)})`);
console.log('o4 triangles:', o4Geo.attributes.position.count / 3, '\n');

// ---------------------------------------------------------------------------
// SANITY GATE: down-cast from above each contact's XY must hit the mesh.
// ---------------------------------------------------------------------------
console.log('--- SANITY GATE (down-cast −Z from above each contact XY) ---');
const contactsForGate = [
  ['s573.base', transformObjectPoint(s573.base)],
  ['s573.tip', transformObjectPoint(s573.tip)],
  ['s574.base', transformObjectPoint(s574.base)],
  ['s574.tip', transformObjectPoint(s574.tip)],
];
let gateOk = true;
const topZ = worldBox.max.z + 50;
for (const [name, p] of contactsForGate) {
  const origin = new THREE.Vector3(p.x, p.y, topZ);
  const hits = allHits(origin, new THREE.Vector3(0, 0, -1));
  const hit = hits.length ? hits[0] : null;
  const ok = !!hit;
  if (!ok) gateOk = false;
  console.log(`  ${name.padEnd(12)} worldPt(${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)})  downHit=${ok ? `z=${hit.point.z.toFixed(3)} (Δz to contact=${(hit.point.z - p.z).toFixed(3)})` : 'MISS'}`);
}
if (!gateOk) {
  console.log('\n*** SANITY GATE FAILED: mesh frame is wrong. Divergence numbers below would be GARBAGE. STOP. ***');
  process.exit(2);
}
console.log('  → gate PASSED: mesh is loaded and in the expected frame.\n');

// ---------------------------------------------------------------------------
// MEASUREMENTS per anatomy-less contact.
// For each, try BOTH candidate ray directions (the §9 ray-direction question):
//   (A) contact → other endpoint of the same support
//   (B) contact → LYS authored-normal direction (i.e. cast along authored normal toward surface)
// and report which hits + divergence on hit.
// ---------------------------------------------------------------------------
const faceNormalWorld = (hit) => hit.face ? V(hit.face.normal).applyMatrix4(new THREE.Matrix4().extractRotation(mesh.matrixWorld)).normalize() : null;

function measureContact(label, support, which) {
  const isBase = which === 'base';
  const contactRaw = isBase ? support.base : support.tip;
  const otherRaw = isBase ? support.tip : support.base;
  const lysNormalRaw = isBase ? support.baseNormal : support.tipNormal;

  const contact = transformObjectPoint(contactRaw);
  const other = transformObjectPoint(otherRaw);
  const lysN = lysNormalRaw ? V(lysNormalRaw).normalize() : null; // scale1 → no normal rescale

  console.log(`--- ${label} (${which}) ---`);
  console.log(`  authored LYS normal: ${lysN ? `(${lysN.x.toFixed(3)},${lysN.y.toFixed(3)},${lysN.z.toFixed(3)})` : 'NONE'}  contactWorld(${contact.x.toFixed(3)},${contact.y.toFixed(3)},${contact.z.toFixed(3)})`);

  // Candidate travel directions (the ray moves ALONG these, entering from outside):
  //  - along −authoredNormal: come from outside along +N, travel into surface (−N). PRIMARY.
  //  - shaft (contact ← other): travel from other-endpoint side through contact.
  const candidates = [];
  if (lysN) candidates.push(['along −authoredNormal', lysN.clone().multiplyScalar(-1)]);
  candidates.push(['shaft (other→contact)', contact.clone().sub(other).normalize()]);

  for (const [dlabel, dir] of candidates) {
    const hit = castThroughContact(contact, dir);
    if (!hit) { console.log(`  [${dlabel}] MISS`); continue; }
    const floatOff = hit.point.distanceTo(contact);
    const smoothed = V(calculateSmoothedNormal(hit));
    const faceN = faceNormalWorld(hit);
    // A trustworthy seat: nearest-hit should be ~on the authored point (small floatOff).
    const trust = floatOff < 1.0 ? 'OK' : (floatOff < 3.0 ? 'far' : 'SUSPECT');
    let line = `  [${dlabel}] HIT floatOff=${floatOff.toFixed(4)}mm[${trust}]`;
    if (lysN) {
      line += `  ∠(LYS,smoothed)=${angleDeg(lysN, smoothed).toFixed(1)}°`;
      if (faceN) line += `  ∠(LYS,face)=${angleDeg(lysN, faceN).toFixed(1)}°`;
    }
    console.log(line);
    console.log(`        hit(${hit.point.x.toFixed(3)},${hit.point.y.toFixed(3)},${hit.point.z.toFixed(3)}) smoothedN(${smoothed.x.toFixed(3)},${smoothed.y.toFixed(3)},${smoothed.z.toFixed(3)})`);
  }
  console.log('');
}

console.log('=== TWIG s573 (two model contacts) ===');
measureContact('twig s573', s573, 'base');
measureContact('twig s573', s573, 'tip');

console.log('=== LEAF s574 (model contact; base attaches to twig) ===');
// Leaf: base attaches to the twig (s573), tip contacts the model. Measure the model-contact end(s).
measureContact('leaf s574', s574, 'tip');
measureContact('leaf s574', s574, 'base');

console.log('=== PROBE COMPLETE ===');
