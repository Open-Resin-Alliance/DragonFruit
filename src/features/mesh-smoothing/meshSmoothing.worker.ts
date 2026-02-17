type MeshSmoothingFalloff = 'linear' | 'smooth' | 'sharp';

type InitMessage = {
  type: 'init';
  geometryKey: number;
  uniquePositions: Float32Array;
  neighborOffsets: Uint32Array;
  neighborsFlat: Uint32Array;
};

type StepMessage = {
  type: 'step';
  geometryKey: number;
  jobId: number;
  center: [number, number, number];
  radius: number;
  strength: number;
  iterations: number;
  falloff: MeshSmoothingFalloff;
  maxVertices: number;
  affected: Uint32Array;
};

type FinalizeMessage = {
  type: 'finalize';
  geometryKey: number;
  jobId: number;
  strength: number;
  iterations: number;
  maxVertices: number;
  affected: Uint32Array;
};

type ResultMessage = {
  type: 'result';
  geometryKey: number;
  jobId: number;
  applied: Uint32Array;
  newPositions: Float32Array;
};

type InMessage = InitMessage | StepMessage | FinalizeMessage;

let currentGeometryKey = 0;
let uniquePositions: Float32Array | null = null;
let neighborOffsets: Uint32Array | null = null;
let neighborsFlat: Uint32Array | null = null;

let processing = false;
let pendingJob: StepMessage | FinalizeMessage | null = null;
let latestRequestedJobId = 0;

let scratchWeights: Float32Array = new Float32Array(0);
let scratchTmp: Float32Array = new Float32Array(0);
let scratchIds: Uint32Array = new Uint32Array(0);

function ensureScratch(size: number) {
  if (scratchWeights.length < size) scratchWeights = new Float32Array(size);
  if (scratchTmp.length < size * 3) scratchTmp = new Float32Array(size * 3);
  if (scratchIds.length < size) scratchIds = new Uint32Array(size);
}

function doFinalize(job: FinalizeMessage): ResultMessage | null {
  if (!uniquePositions || !neighborOffsets || !neighborsFlat) return null;
  if (job.geometryKey !== currentGeometryKey) return null;

  const uPos = uniquePositions;
  const nOff = neighborOffsets;
  const nFlat = neighborsFlat;

  const uCount = Math.floor(uPos.length / 3);
  if (uCount <= 0) return null;
  if (nOff.length < uCount + 1) return null;

  const ids = limitVertices(job.affected, Math.max(1, job.maxVertices | 0));
  const n = ids.length;
  if (n === 0) return null;

  ensureScratch(n);

  for (let i = 0; i < n; i++) {
    const id = ids[i];
    if (id >= uCount) return null;
    scratchIds[i] = id;
  }

  const iters = Math.max(1, job.iterations | 0);
  const lambda = Math.max(0, Math.min(1, job.strength));

  const doPass = (coeff: number) => {
    for (let i = 0; i < n; i++) {
      if (job.jobId !== latestRequestedJobId) return false;

      const id = scratchIds[i];
      if (id >= uCount) return false;
      const k = coeff;
      const i3 = id * 3;

      const start = nOff[id];
      const end = nOff[id + 1];
      if (end < start) return false;
      if (end > nFlat.length) return false;
      const nbCount = end - start;

      if (nbCount <= 0 || k === 0) {
        scratchTmp[i * 3 + 0] = uPos[i3 + 0];
        scratchTmp[i * 3 + 1] = uPos[i3 + 1];
        scratchTmp[i * 3 + 2] = uPos[i3 + 2];
        continue;
      }

      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let j = start; j < end; j++) {
        const nb = nFlat[j];
        if (nb >= uCount) return false;
        const nb3 = nb * 3;
        ax += uPos[nb3 + 0];
        ay += uPos[nb3 + 1];
        az += uPos[nb3 + 2];
      }
      const inv = 1 / nbCount;
      ax *= inv;
      ay *= inv;
      az *= inv;

      const px = uPos[i3 + 0];
      const py = uPos[i3 + 1];
      const pz = uPos[i3 + 2];

      scratchTmp[i * 3 + 0] = px + (ax - px) * k;
      scratchTmp[i * 3 + 1] = py + (ay - py) * k;
      scratchTmp[i * 3 + 2] = pz + (az - pz) * k;

      if (!Number.isFinite(scratchTmp[i * 3 + 0]) || !Number.isFinite(scratchTmp[i * 3 + 1]) || !Number.isFinite(scratchTmp[i * 3 + 2])) {
        return false;
      }
    }

    for (let i = 0; i < n; i++) {
      const id = scratchIds[i];
      const i3 = id * 3;
      uPos[i3 + 0] = scratchTmp[i * 3 + 0];
      uPos[i3 + 1] = scratchTmp[i * 3 + 1];
      uPos[i3 + 2] = scratchTmp[i * 3 + 2];

      if (!Number.isFinite(uPos[i3 + 0]) || !Number.isFinite(uPos[i3 + 1]) || !Number.isFinite(uPos[i3 + 2])) {
        return false;
      }
    }

    return true;
  };

  for (let iter = 0; iter < iters; iter++) {
    if (job.jobId !== latestRequestedJobId) return null;
    if (!doPass(lambda)) return null;
  }

  if (job.jobId !== latestRequestedJobId) return null;

  const applied = new Uint32Array(n);
  const newPositions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const id = scratchIds[i];
    applied[i] = id;
    const i3 = id * 3;
    newPositions[i * 3 + 0] = uPos[i3 + 0];
    newPositions[i * 3 + 1] = uPos[i3 + 1];
    newPositions[i * 3 + 2] = uPos[i3 + 2];

    if (!Number.isFinite(newPositions[i * 3 + 0]) || !Number.isFinite(newPositions[i * 3 + 1]) || !Number.isFinite(newPositions[i * 3 + 2])) {
      return null;
    }
  }

  return {
    type: 'result',
    geometryKey: job.geometryKey,
    jobId: job.jobId,
    applied,
    newPositions,
  };
}

function falloffValue(falloff: MeshSmoothingFalloff, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  if (falloff === 'linear') return x;
  if (falloff === 'sharp') return x * x;
  return x * x * (3 - 2 * x);
}

function limitVertices(input: Uint32Array, maxVertices: number): Uint32Array {
  if (input.length <= maxVertices) return input;
  const stride = Math.ceil(input.length / maxVertices);
  const outLen = Math.ceil(input.length / stride);
  const out = new Uint32Array(outLen);
  let o = 0;
  for (let i = 0; i < input.length; i += stride) {
    out[o++] = input[i];
  }
  return out;
}

function doSmoothing(job: StepMessage): ResultMessage | null {
  if (!uniquePositions || !neighborOffsets || !neighborsFlat) return null;
  if (job.geometryKey !== currentGeometryKey) return null;

  const uPos = uniquePositions;
  const nOff = neighborOffsets;
  const nFlat = neighborsFlat;

  const uCount = Math.floor(uPos.length / 3);
  if (uCount <= 0) return null;
  if (nOff.length < uCount + 1) return null;

  const ids = limitVertices(job.affected, Math.max(1, job.maxVertices | 0));
  const n = ids.length;
  if (n === 0) return null;

  ensureScratch(n);

  const cx = job.center[0];
  const cy = job.center[1];
  const cz = job.center[2];
  const radius = Math.max(0.0001, job.radius);

  // Precompute weights
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    if (id >= uCount) return null;
    scratchIds[i] = id;
    const i3 = id * 3;
    const dx = uPos[i3 + 0] - cx;
    const dy = uPos[i3 + 1] - cy;
    const dz = uPos[i3 + 2] - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const t = 1 - dist / radius;
    scratchWeights[i] = falloffValue(job.falloff, t);
  }

  const iters = Math.max(1, job.iterations | 0);
  const lambda = Math.max(0, Math.min(1, job.strength));

  const doPass = (coeff: number) => {
    for (let i = 0; i < n; i++) {
      if (job.jobId !== latestRequestedJobId) return false;

      const id = scratchIds[i];
      if (id >= uCount) return false;
      const w = scratchWeights[i];
      const k = coeff * w;
      const i3 = id * 3;

      const start = nOff[id];
      const end = nOff[id + 1];
      if (end < start) return false;
      if (end > nFlat.length) return false;
      const nbCount = end - start;

      if (nbCount <= 0 || k === 0) {
        scratchTmp[i * 3 + 0] = uPos[i3 + 0];
        scratchTmp[i * 3 + 1] = uPos[i3 + 1];
        scratchTmp[i * 3 + 2] = uPos[i3 + 2];
        continue;
      }

      let ax = 0;
      let ay = 0;
      let az = 0;
      for (let j = start; j < end; j++) {
        const nb = nFlat[j];
        if (nb >= uCount) return false;
        const nb3 = nb * 3;
        ax += uPos[nb3 + 0];
        ay += uPos[nb3 + 1];
        az += uPos[nb3 + 2];
      }
      const inv = 1 / nbCount;
      ax *= inv;
      ay *= inv;
      az *= inv;

      const px = uPos[i3 + 0];
      const py = uPos[i3 + 1];
      const pz = uPos[i3 + 2];

      scratchTmp[i * 3 + 0] = px + (ax - px) * k;
      scratchTmp[i * 3 + 1] = py + (ay - py) * k;
      scratchTmp[i * 3 + 2] = pz + (az - pz) * k;

      if (!Number.isFinite(scratchTmp[i * 3 + 0]) || !Number.isFinite(scratchTmp[i * 3 + 1]) || !Number.isFinite(scratchTmp[i * 3 + 2])) {
        return false;
      }
    }

    for (let i = 0; i < n; i++) {
      const id = scratchIds[i];
      const i3 = id * 3;
      uPos[i3 + 0] = scratchTmp[i * 3 + 0];
      uPos[i3 + 1] = scratchTmp[i * 3 + 1];
      uPos[i3 + 2] = scratchTmp[i * 3 + 2];

      if (!Number.isFinite(uPos[i3 + 0]) || !Number.isFinite(uPos[i3 + 1]) || !Number.isFinite(uPos[i3 + 2])) {
        return false;
      }
    }

    return true;
  };

  for (let iter = 0; iter < iters; iter++) {
    if (job.jobId !== latestRequestedJobId) return null;
    if (!doPass(lambda)) return null;
  }

  if (job.jobId !== latestRequestedJobId) return null;

  const applied = new Uint32Array(n);
  const newPositions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const id = scratchIds[i];
    applied[i] = id;
    const i3 = id * 3;
    newPositions[i * 3 + 0] = uPos[i3 + 0];
    newPositions[i * 3 + 1] = uPos[i3 + 1];
    newPositions[i * 3 + 2] = uPos[i3 + 2];

    if (!Number.isFinite(newPositions[i * 3 + 0]) || !Number.isFinite(newPositions[i * 3 + 1]) || !Number.isFinite(newPositions[i * 3 + 2])) {
      return null;
    }
  }

  return {
    type: 'result',
    geometryKey: job.geometryKey,
    jobId: job.jobId,
    applied,
    newPositions,
  };
}

async function runLoop() {
  if (processing) return;
  processing = true;
  try {
    while (pendingJob) {
      const job = pendingJob;
      pendingJob = null;

      const res = job.type === 'finalize' ? doFinalize(job) : doSmoothing(job);
      if (res) {
        (self as any).postMessage(res, [res.applied.buffer, res.newPositions.buffer]);
      }

      // Yield so the worker can receive a newer pending job quickly.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    processing = false;
  }
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === 'init') {
    currentGeometryKey = msg.geometryKey;
    uniquePositions = msg.uniquePositions;
    neighborOffsets = msg.neighborOffsets;
    neighborsFlat = msg.neighborsFlat;
    pendingJob = null;
    latestRequestedJobId = 0;
    return;
  }

  if (msg.type === 'step' || msg.type === 'finalize') {
    if (msg.geometryKey !== currentGeometryKey) return;
    latestRequestedJobId = msg.jobId;
    pendingJob = msg; // latest-wins
    runLoop();
  }
};
