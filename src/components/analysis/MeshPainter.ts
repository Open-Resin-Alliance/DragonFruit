"use client";

import * as THREE from 'three';

export type XZLoopPrism = {
  loops: THREE.Vector2[][]; // loops in (x, -z) space to match CrossSectionCap/IslandScan
  y0: number;               // inclusive bottom
  y1: number;               // inclusive top
};

type ColorStorageArray = Float32Array | Uint8Array | Uint8ClampedArray;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isByteColorBuffer(attribute: THREE.BufferAttribute): boolean {
  return attribute.array instanceof Uint8Array || attribute.array instanceof Uint8ClampedArray;
}

function encodeColorComponent(value: number, useBytes: boolean): number {
  return useBytes ? Math.round(clamp01(value) * 255) : value;
}

function decodeColorComponent(value: number, useBytes: boolean): number {
  return useBytes ? value / 255 : value;
}

function writeColorAt(
  arr: ColorStorageArray,
  vertexIndex: number,
  r: number,
  g: number,
  b: number,
  useBytes: boolean,
) {
  arr[vertexIndex * 3 + 0] = encodeColorComponent(r, useBytes);
  arr[vertexIndex * 3 + 1] = encodeColorComponent(g, useBytes);
  arr[vertexIndex * 3 + 2] = encodeColorComponent(b, useBytes);
}

function readColorAt(arr: ColorStorageArray, vertexIndex: number, useBytes: boolean) {
  return {
    r: decodeColorComponent(arr[vertexIndex * 3 + 0], useBytes),
    g: decodeColorComponent(arr[vertexIndex * 3 + 1], useBytes),
    b: decodeColorComponent(arr[vertexIndex * 3 + 2], useBytes),
  };
}

function ensureColorAttribute(geometry: THREE.BufferGeometry, base: THREE.Color) {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!pos) return;
  const n = pos.count;
  let color = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!color || color.count !== n) {
    const arr = new Uint8Array(n * 3);
    color = new THREE.BufferAttribute(arr, 3, true);
    geometry.setAttribute('color', color);
  }
  const resolvedColor = geometry.getAttribute('color') as THREE.BufferAttribute;
  const arr = resolvedColor.array as ColorStorageArray;
  const useByteColors = isByteColorBuffer(resolvedColor);
  for (let i = 0; i < n; i++) {
    writeColorAt(arr, i, base.r, base.g, base.b, useByteColors);
  }
  resolvedColor.needsUpdate = true;
}

// Soft-brush variant: for each island label, treat its base pixels as seed points and
// paint strength by 3D spherical falloff from the nearest seed (radius in mm).
export function applyIslandSoftBrushByLabel(
  geometry: THREE.BufferGeometry,
  baseColor: THREE.Color,
  grid: RasterGridInfo,
  baseLabels: Int32Array,
  firstHit: Int16Array,
  compBase: Int16Array,
  yOffset: number,
  layerHeightMm: number,
  brushRadiusMm: number,
  tint: THREE.Color,
) {
  ensureColorAttribute(geometry, baseColor);

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!pos || !col) return 0;

  const arrPos = pos.array as Float32Array;
  const arrCol = col.array as ColorStorageArray;
  const useByteColors = isByteColorBuffer(col);
  const tmpColor = new THREE.Color();
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const { width, height, originX, originZ, px_mm } = grid;

  // Build per-label seed lists (sampled) at the base layer (firstHit == compBase[label])
  const maxLabel = compBase.length - 1;
  const seedsX: Float32Array[] = new Array(maxLabel + 1);
  const seedsZ: Float32Array[] = new Array(maxLabel + 1);
  for (let id = 1; id <= maxLabel; id++) {
    // Count seeds
    let count = 0;
    for (let idx = 0; idx < baseLabels.length; idx++) {
      if (baseLabels[idx] === id && firstHit[idx] === compBase[id]) count++;
    }
    if (count === 0) { seedsX[id] = new Float32Array(0); seedsZ[id] = new Float32Array(0); continue; }
    // Sample every n-th to keep it bounded
    const stride = Math.max(1, Math.floor(count / 128));
    const sx = new Float32Array(Math.ceil(count / stride));
    const sz = new Float32Array(Math.ceil(count / stride));
    let w = 0, k = 0;
    for (let idx = 0; idx < baseLabels.length; idx++) {
      if (baseLabels[idx] !== id) continue;
      if (firstHit[idx] !== compBase[id]) continue;
      if ((k++ % stride) !== 0) continue;
      const r = (idx / width) | 0;
      const c = idx % width;
      const xw = originX + c * px_mm;
      const zw = - (originZ + r * px_mm);
      sx[w] = xw; sz[w] = zw; w++;
      if (w >= sx.length) break;
    }
    seedsX[id] = sx.subarray(0, w);
    seedsZ[id] = sz.subarray(0, w);
  }

  const br = baseColor.r, bg = baseColor.g, bb = baseColor.b;
  const radius = Math.max(0.001, brushRadiusMm);
  const radius2 = radius * radius;
  let painted = 0;

  for (let i = 0; i < pos.count; i += 3) {
    const ax = arrPos[i * 3 + 0], ay = arrPos[i * 3 + 1], az = arrPos[i * 3 + 2];
    const bx = arrPos[(i + 1) * 3 + 0], by = arrPos[(i + 1) * 3 + 1], bz = arrPos[(i + 1) * 3 + 2];
    const cx = arrPos[(i + 2) * 3 + 0], cy = arrPos[(i + 2) * 3 + 1], cz = arrPos[(i + 2) * 3 + 2];

    const centX = (ax + bx + cx) / 3;
    const centY = (ay + by + cy) / 3;
    const centZ = (az + bz + cz) / 3;

    // Map to label index
    const c = Math.floor((centX - (originX - px_mm * 0.5)) / px_mm);
    const r = Math.floor(((-centZ) - (originZ - px_mm * 0.5)) / px_mm);
    if (c < 0 || c >= width || r < 0 || r >= height) continue;
    const idx = r * width + c;
    const id = baseLabels[idx] | 0;
    if (id <= 0) continue;

    // Limit to above the island base
    const baseL = compBase[id] | 0;
    if (baseL < 0) continue;
    const baseY = yOffset + baseL * layerHeightMm;
    const dy = centY - baseY;
    if (dy < 0) continue;

    const sx = seedsX[id];
    const sz = seedsZ[id];
    if (!sx || sx.length === 0) continue;

    // Find nearest seed in XZ (2D), then combine with dy for 3D radius
    let best2 = Infinity;
    for (let s = 0; s < sx.length; s++) {
      const dx = centX - sx[s];
      const dz = centZ - sz[s];
      const d2 = dx * dx + dz * dz;
      if (d2 < best2) best2 = d2;
    }
    const dist3_2 = best2 + dy * dy; // squared 3D distance
    if (dist3_2 > radius2) continue;
    const u = Math.max(0, Math.min(1, 1 - Math.sqrt(dist3_2) / radius));
    // Smooth falloff
    const smooth = u * u * (3 - 2 * u);
    const s = smooth; // darkest at center

    for (let k = 0; k < 3; k++) {
      const vi = i + k;
      tmpColor.setRGB(
        lerp(br, tint.r, s),
        lerp(bg, tint.g, s),
        lerp(bb, tint.b, s)
      );
      writeColorAt(arrCol, vi, tmpColor.r, tmpColor.g, tmpColor.b, useByteColors);
    }
    painted++;
  }

  col.needsUpdate = true;
  return painted;
}

// Label-based variant: uses per-island base layer from compBase via label grid.
export function applyIslandGradientByLabel(
  geometry: THREE.BufferGeometry,
  baseColor: THREE.Color,
  grid: RasterGridInfo,
  baseLabels: Int32Array,
  compBase: Int16Array,
  compTop: Int16Array,
  yOffset: number,
  layerHeightMm: number,
  fadeSpanLayers: number,
  tint: THREE.Color,
) {
  ensureColorAttribute(geometry, baseColor);

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!pos || !col) return 0;

  const arrPos = pos.array as Float32Array;
  const arrCol = col.array as ColorStorageArray;
  const useByteColors = isByteColorBuffer(col);
  const tmpColor = new THREE.Color();
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const { width, height, originX, originZ, px_mm } = grid;

  function toMaskIndex(xWorld: number, zWorld: number): number {
    const x = xWorld;
    const y = -zWorld;
    const c = Math.floor((x - (originX - px_mm * 0.5)) / px_mm);
    const r = Math.floor((y - (originZ - px_mm * 0.5)) / px_mm);
    if (c < 0 || c >= width || r < 0 || r >= height) return -1;
    return r * width + c;
  }

  let painted = 0;
  const br = baseColor.r, bg = baseColor.g, bb = baseColor.b;
  const span = Math.max(1, Math.floor(fadeSpanLayers));

  for (let i = 0; i < pos.count; i += 3) {
    const ax = arrPos[i * 3 + 0], ay = arrPos[i * 3 + 1], az = arrPos[i * 3 + 2];
    const bx = arrPos[(i + 1) * 3 + 0], by = arrPos[(i + 1) * 3 + 1], bz = arrPos[(i + 1) * 3 + 2];
    const cx = arrPos[(i + 2) * 3 + 0], cy = arrPos[(i + 2) * 3 + 1], cz = arrPos[(i + 2) * 3 + 2];

    const centX = (ax + bx + cx) / 3;
    const centY = (ay + by + cy) / 3;
    const centZ = (az + bz + cz) / 3;

    const idx = toMaskIndex(centX, centZ);
    if (idx < 0) continue;
    const id = baseLabels[idx] | 0;
    if (id <= 0) continue;
    if (!compBase || !compTop) continue;
    if (id >= compBase.length || id >= compTop.length) continue;
    const f = compBase[id] | 0;
    const tTop = compTop[id] | 0;
    if (f < 0 || tTop < 0) continue;

    const Ltri = Math.max(0, Math.floor((centY - yOffset) / layerHeightMm));
    // clamp to island's vertical extent
    if (Ltri < f || Ltri > tTop) continue;
    const localSpan = Math.max(1, Math.min(span, tTop - f + 1));
    const x = Math.min(1, Math.max(0, (Ltri - f) / localSpan));
    const smooth = x * x * (3 - 2 * x);
    let s = 1 - smooth;
    const gamma = 1.6; // darken mid-tones so fade is visible
    s = Math.pow(Math.min(1, Math.max(0, s)), gamma);

    for (let k = 0; k < 3; k++) {
      const vi = i + k;
      tmpColor.setRGB(
        lerp(br, tint.r, s),
        lerp(bg, tint.g, s),
        lerp(bb, tint.b, s)
      );
      writeColorAt(arrCol, vi, tmpColor.r, tmpColor.g, tmpColor.b, useByteColors);
    }
    painted++;
  }

  col.needsUpdate = true;
  return painted;
}

export type RasterGridInfo = {
  width: number;
  height: number;
  originX: number;
  originZ: number; // corresponds to -Z world
  px_mm: number;
};

// Single-pass, triangle-aware per-island gradient painter.
// Uses firstHit (base layer index per pixel) and paints a fade up over fadeSpan layers.
export function applyIslandGradientSinglePass(
  geometry: THREE.BufferGeometry,
  baseColor: THREE.Color,
  grid: RasterGridInfo,
  firstHit: Int16Array,
  baseFootprint: Uint8Array,
  yOffset: number,
  layerHeightMm: number,
  fadeSpanLayers: number,
  tint: THREE.Color,
) {
  ensureColorAttribute(geometry, baseColor);

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!pos || !col) return 0;

  const arrPos = pos.array as Float32Array;
  const arrCol = col.array as ColorStorageArray;
  const useByteColors = isByteColorBuffer(col);
  const tmpColor = new THREE.Color();
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const { width, height, originX, originZ, px_mm } = grid;

  function toMaskIndex(xWorld: number, zWorld: number): number {
    const x = xWorld;
    const y = -zWorld;
    const c = Math.floor((x - (originX - px_mm * 0.5)) / px_mm);
    const r = Math.floor((y - (originZ - px_mm * 0.5)) / px_mm);
    if (c < 0 || c >= width || r < 0 || r >= height) return -1;
    return r * width + c;
  }

  let painted = 0;
  const br = baseColor.r, bg = baseColor.g, bb = baseColor.b;
  const span = Math.max(1, Math.floor(fadeSpanLayers));

  for (let i = 0; i < pos.count; i += 3) {
    const ax = arrPos[i * 3 + 0], ay = arrPos[i * 3 + 1], az = arrPos[i * 3 + 2];
    const bx = arrPos[(i + 1) * 3 + 0], by = arrPos[(i + 1) * 3 + 1], bz = arrPos[(i + 1) * 3 + 2];
    const cx = arrPos[(i + 2) * 3 + 0], cy = arrPos[(i + 2) * 3 + 1], cz = arrPos[(i + 2) * 3 + 2];

    const centX = (ax + bx + cx) / 3;
    const centY = (ay + by + cy) / 3;
    const centZ = (az + bz + cz) / 3;

    const idx = toMaskIndex(centX, centZ);
    if (idx < 0) continue;
    if (baseFootprint[idx] !== 1) continue; // only paint within island footprint
    const f = firstHit[idx];
    if (f === -1) continue;

    // layer at triangle height
    const Ltri = Math.max(0, Math.floor((centY - yOffset) / layerHeightMm));
    const x = Math.min(1, Math.max(0, (Ltri - f) / span));
    const smooth = x * x * (3 - 2 * x);
    let s = 1 - smooth; // darkest at base, lighter upward
    // Gamma to boost mid-tones for visibility
    const gamma = 0.4;
    s = Math.pow(Math.min(1, Math.max(0, s)), gamma);

    for (let k = 0; k < 3; k++) {
      const vi = i + k;
      tmpColor.setRGB(
        lerp(br, tint.r, s),
        lerp(bg, tint.g, s),
        lerp(bb, tint.b, s)
      );
      writeColorAt(arrCol, vi, tmpColor.r, tmpColor.g, tmpColor.b, useByteColors);
    }
    painted++;
  }

  col.needsUpdate = true;
  return painted;
}

function pointInPolygon(p: THREE.Vector2, loop: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const xi = loop[i].x, yi = loop[i].y;
    const xj = loop[j].x, yj = loop[j].y;
    const intersect = ((yi > p.y) !== (yj > p.y)) && (p.x < (xj - xi) * (p.y - yi) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function isPointInsideAnyLoopXZ(pXZ: THREE.Vector2, loops: THREE.Vector2[][]): boolean {
  for (const loop of loops) {
    if (loop.length < 3) continue;
    if (pointInPolygon(pXZ, loop)) return true;
  }
  return false;
}

export function clearPaintToBase(geometry: THREE.BufferGeometry, baseColor: THREE.Color) {
  ensureColorAttribute(geometry, baseColor);
}

export function applyTintPrisms(
  geometry: THREE.BufferGeometry,
  baseColor: THREE.Color,
  prisms: XZLoopPrism[],
  tint: THREE.Color,
  strength: number, // 0..1, lerp to tint
) {
  // Initialize base if needed
  ensureColorAttribute(geometry, baseColor);
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!pos || !col) return;

  const arrPos = pos.array as Float32Array;
  const arrCol = col.array as ColorStorageArray;
  const useByteColors = isByteColorBuffer(col);
  const tmpColor = new THREE.Color();

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  // Paint per triangle by centroid test (more robust than per-vertex)
  let painted = 0;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = arrPos[i * 3 + 0], ay = arrPos[i * 3 + 1], az = arrPos[i * 3 + 2];
    const bx = arrPos[(i + 1) * 3 + 0], by = arrPos[(i + 1) * 3 + 1], bz = arrPos[(i + 1) * 3 + 2];
    const cx = arrPos[(i + 2) * 3 + 0], cy = arrPos[(i + 2) * 3 + 1], cz = arrPos[(i + 2) * 3 + 2];

    const centX = (ax + bx + cx) / 3;
    const centY = (ay + by + cy) / 3;
    const centZ = (az + bz + cz) / 3;
    const pXZ = new THREE.Vector2(centX, -centZ);

    let hit = false;
    for (const prism of prisms) {
      if (centY < prism.y0 || centY > prism.y1) continue;
      if (isPointInsideAnyLoopXZ(pXZ, prism.loops)) { hit = true; break; }
    }
    if (!hit) continue;

    // Tint all three vertices of this triangle
    for (let k = 0; k < 3; k++) {
      const idx = i + k;
      const { r, g, b } = readColorAt(arrCol, idx, useByteColors);
      tmpColor.setRGB(
        lerp(r, tint.r, strength),
        lerp(g, tint.g, strength),
        lerp(b, tint.b, strength)
      );
      writeColorAt(arrCol, idx, tmpColor.r, tmpColor.g, tmpColor.b, useByteColors);
    }
  }

  col.needsUpdate = true;
  return painted;
}

// Variable-strength painter: tint strength determined per pixel via callback.
export function applyTintMaskBandVariableStrength(
  geometry: THREE.BufferGeometry,
  baseColor: THREE.Color,
  band: RasterMaskBand,
  tint: THREE.Color,
  sampleStrength: (colIdx: number, rowIdx: number) => number,
) {
  ensureColorAttribute(geometry, baseColor);

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!pos || !col) return;

  const arrPos = pos.array as Float32Array;
  const arrCol = col.array as ColorStorageArray;
  const useByteColors = isByteColorBuffer(col);
  const tmpColor = new THREE.Color();
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const { data, width, height, originX, originZ, px_mm, y0, y1 } = band;

  function toMaskIndices(xWorld: number, zWorld: number): { c: number; r: number } | null {
    const x = xWorld;
    const y = -zWorld; // mask Y corresponds to -Z
    const c = Math.floor((x - (originX - px_mm * 0.5)) / px_mm);
    const r = Math.floor((y - (originZ - px_mm * 0.5)) / px_mm);
    if (c < 0 || c >= width || r < 0 || r >= height) return null;
    return { c, r };
  }

  let painted = 0;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = arrPos[i * 3 + 0], ay = arrPos[i * 3 + 1], az = arrPos[i * 3 + 2];
    const bx = arrPos[(i + 1) * 3 + 0], by = arrPos[(i + 1) * 3 + 1], bz = arrPos[(i + 1) * 3 + 2];
    const cx = arrPos[(i + 2) * 3 + 0], cy = arrPos[(i + 2) * 3 + 1], cz = arrPos[(i + 2) * 3 + 2];

    const centX = (ax + bx + cx) / 3;
    const centY = (ay + by + cy) / 3;
    const centZ = (az + bz + cz) / 3;

    if (centY < y0 || centY > y1) continue;
    const idxs = toMaskIndices(centX, centZ);
    if (!idxs) continue;
    const { c, r } = idxs;
    if (data[r * width + c] !== 1) continue;
    painted++;

    const s = Math.min(1, Math.max(0, sampleStrength(c, r)));

    // Derive solely from baseColor for this triangle with current strength (no accumulation)
    const br = baseColor.r, bg = baseColor.g, bb = baseColor.b;
    for (let k = 0; k < 3; k++) {
      const idx = i + k;
      tmpColor.setRGB(
        lerp(br, tint.r, s),
        lerp(bg, tint.g, s),
        lerp(bb, tint.b, s)
      );
      writeColorAt(arrCol, idx, tmpColor.r, tmpColor.g, tmpColor.b, useByteColors);
    }
  }

  col.needsUpdate = true;
  return painted;
}

export function applyTintAll(
  geometry: THREE.BufferGeometry,
  baseColor: THREE.Color,
  tint: THREE.Color,
  strength: number,
) {
  ensureColorAttribute(geometry, baseColor);
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!pos || !col) return;
  const arrPos = pos.array as Float32Array;
  const arrCol = col.array as ColorStorageArray;
  const useByteColors = isByteColorBuffer(col);
  const tmpColor = new THREE.Color();
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  let painted = 0;
  for (let i = 0; i < pos.count; i += 3) {
    painted++;
    for (let k = 0; k < 3; k++) {
      const idx = i + k;
      const { r, g, b } = readColorAt(arrCol, idx, useByteColors);
      tmpColor.setRGB(
        lerp(r, tint.r, strength),
        lerp(g, tint.g, strength),
        lerp(b, tint.b, strength)
      );
      writeColorAt(arrCol, idx, tmpColor.r, tmpColor.g, tmpColor.b, useByteColors);
    }
  }
  col.needsUpdate = true;
  return painted;
}

export type RasterMaskBand = {
  data: Uint8Array; // row-major, width*height; 1 = paint
  width: number;
  height: number;
  originX: number; // world X at column 0 center
  originZ: number; // world Z at row 0 center (Vector2.y maps to -Z)
  px_mm: number;
  y0: number;
  y1: number;
};

export function applyTintMaskBand(
  geometry: THREE.BufferGeometry,
  baseColor: THREE.Color,
  band: RasterMaskBand,
  tint: THREE.Color,
  strength: number,
) {
  ensureColorAttribute(geometry, baseColor);

  const pos = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  const col = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!pos || !col) return;

  const arrPos = pos.array as Float32Array;
  const arrCol = col.array as ColorStorageArray;
  const useByteColors = isByteColorBuffer(col);
  const tmpColor = new THREE.Color();

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

  const { data, width, height, originX, originZ, px_mm, y0, y1 } = band;

  function sampleMask(xWorld: number, zWorld: number): boolean {
    // Map world (x, -z) to mask coordinates (col,row)
    const x = xWorld;
    const y = -zWorld; // mask Y corresponds to -Z
    const colIdx = Math.floor((x - (originX - px_mm * 0.5)) / px_mm);
    const rowIdx = Math.floor((y - (originZ - px_mm * 0.5)) / px_mm);
    if (colIdx < 0 || colIdx >= width || rowIdx < 0 || rowIdx >= height) return false;
    return data[rowIdx * width + colIdx] === 1;
  }

  let painted = 0;
  for (let i = 0; i < pos.count; i += 3) {
    const ax = arrPos[i * 3 + 0], ay = arrPos[i * 3 + 1], az = arrPos[i * 3 + 2];
    const bx = arrPos[(i + 1) * 3 + 0], by = arrPos[(i + 1) * 3 + 1], bz = arrPos[(i + 1) * 3 + 2];
    const cx = arrPos[(i + 2) * 3 + 0], cy = arrPos[(i + 2) * 3 + 1], cz = arrPos[(i + 2) * 3 + 2];

    const centX = (ax + bx + cx) / 3;
    const centY = (ay + by + cy) / 3;
    const centZ = (az + bz + cz) / 3;

    if (centY < y0 || centY > y1) continue;
    if (!sampleMask(centX, centZ)) continue;
    painted++;

    for (let k = 0; k < 3; k++) {
      const idx = i + k;
      const { r, g, b } = readColorAt(arrCol, idx, useByteColors);
      tmpColor.setRGB(
        lerp(r, tint.r, strength),
        lerp(g, tint.g, strength),
        lerp(b, tint.b, strength)
      );
      writeColorAt(arrCol, idx, tmpColor.r, tmpColor.g, tmpColor.b, useByteColors);
    }
  }

  col.needsUpdate = true;
  return painted;
}
