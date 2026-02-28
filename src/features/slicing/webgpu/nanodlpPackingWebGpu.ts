type PackingMode = 'rgb8_div3' | 'gray3_div2';

type PackRequest = {
  sourceRgba: Uint8ClampedArray;
  sourceWidthPx: number;
  sourceHeightPx: number;
  outputWidthPx: number;
  packingMode: PackingMode;
};

type WebGpuContext = {
  device: any;
  pipeline: any;
  bindGroupLayout: any;
  srcBuffer: any | null;
  outBuffer: any | null;
  uniformBuffer: any | null;
  readbackBuffer: any | null;
  bindGroup: any | null;
  srcCapacityBytes: number;
  outCapacityBytes: number;
  readbackCapacityBytes: number;
  boundShapeKey: string | null;
};

let webGpuContextPromise: Promise<WebGpuContext | null> | null = null;

const SHADER_CODE = `
struct Params {
  sourceWidth: u32,
  sourceHeight: u32,
  outputWidth: u32,
  padLeft: i32,
  mode: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
};

@group(0) @binding(0) var<storage, read> srcPixels: array<u32>;
@group(0) @binding(1) var<storage, read_write> outPixels: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

fn getR(v: u32) -> u32 { return v & 255u; }

fn readSourceR(x: i32, y: u32) -> u32 {
  if (x < 0 || x >= i32(params.sourceWidth)) {
    return 0u;
  }
  let idx = y * params.sourceWidth + u32(x);
  return getR(srcPixels[idx]);
}

@compute @workgroup_size(16, 16, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;

  if (x >= params.outputWidth || y >= params.sourceHeight) {
    return;
  }

  let outIdx = y * params.outputWidth + x;

  var r: u32 = 0u;
  var g: u32 = 0u;
  var b: u32 = 0u;

  if (params.mode == 0u) {
    // rgb8_div3
    let sx0 = i32(x * 3u) - params.padLeft;
    let sx1 = sx0 + 1;
    let sx2 = sx0 + 2;
    r = readSourceR(sx0, y);
    g = readSourceR(sx1, y);
    b = readSourceR(sx2, y);
  } else {
    // gray3_div2
    let sx0 = i32(x * 2u) - params.padLeft;
    let sx1 = sx0 + 1;
    let a = readSourceR(sx0, y);
    let bb = readSourceR(sx1, y);
    let gray = (a + bb) / 2u;
    r = gray;
    g = gray;
    b = gray;
  }

  let packed = r | (g << 8u) | (b << 16u) | (255u << 24u);
  outPixels[outIdx] = packed;
}
`;

async function getWebGpuContext(): Promise<WebGpuContext | null> {
  if (webGpuContextPromise) return webGpuContextPromise;

  webGpuContextPromise = (async () => {
    if (typeof navigator === 'undefined') return null;

    const gpu = (navigator as Navigator & { gpu?: { requestAdapter?: () => Promise<any> } }).gpu;
    if (!gpu?.requestAdapter) return null;

    const adapter = await gpu.requestAdapter();
    if (!adapter?.requestDevice) return null;

    const device = await adapter.requestDevice();
    if (!device) return null;

    const shaderModule = device.createShaderModule({ code: SHADER_CODE });
    const pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: {
        module: shaderModule,
        entryPoint: 'main',
      },
    });

    const bindGroupLayout = pipeline.getBindGroupLayout(0);

    return {
      device,
      pipeline,
      bindGroupLayout,
      srcBuffer: null,
      outBuffer: null,
      uniformBuffer: null,
      readbackBuffer: null,
      bindGroup: null,
      srcCapacityBytes: 0,
      outCapacityBytes: 0,
      readbackCapacityBytes: 0,
      boundShapeKey: null,
    };
  })().catch(() => null);

  return webGpuContextPromise;
}

function destroyBuffer(buffer: any | null): void {
  if (!buffer) return;
  try {
    buffer.destroy();
  } catch {
    // ignore
  }
}

function resetContextBuffers(context: WebGpuContext): void {
  destroyBuffer(context.srcBuffer);
  destroyBuffer(context.outBuffer);
  destroyBuffer(context.uniformBuffer);
  destroyBuffer(context.readbackBuffer);
  context.srcBuffer = null;
  context.outBuffer = null;
  context.uniformBuffer = null;
  context.readbackBuffer = null;
  context.bindGroup = null;
  context.srcCapacityBytes = 0;
  context.outCapacityBytes = 0;
  context.readbackCapacityBytes = 0;
  context.boundShapeKey = null;
}

function ensureReusableResources(
  context: WebGpuContext,
  gpuBufferUsage: any,
  srcBytesNeeded: number,
  outBytesNeeded: number,
  shapeKey: string,
): void {
  const { device, bindGroupLayout } = context;

  if (!context.uniformBuffer) {
    context.uniformBuffer = device.createBuffer({
      size: 32,
      usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
    });
  }

  if (!context.srcBuffer || context.srcCapacityBytes < srcBytesNeeded) {
    destroyBuffer(context.srcBuffer);
    context.srcBuffer = device.createBuffer({
      size: srcBytesNeeded,
      usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST,
      mappedAtCreation: false,
    });
    context.srcCapacityBytes = srcBytesNeeded;
    context.bindGroup = null;
  }

  if (!context.outBuffer || context.outCapacityBytes < outBytesNeeded) {
    destroyBuffer(context.outBuffer);
    context.outBuffer = device.createBuffer({
      size: outBytesNeeded,
      usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_SRC,
    });
    context.outCapacityBytes = outBytesNeeded;
    context.bindGroup = null;
  }

  if (!context.readbackBuffer || context.readbackCapacityBytes < outBytesNeeded) {
    destroyBuffer(context.readbackBuffer);
    context.readbackBuffer = device.createBuffer({
      size: outBytesNeeded,
      usage: gpuBufferUsage.COPY_DST | gpuBufferUsage.MAP_READ,
    });
    context.readbackCapacityBytes = outBytesNeeded;
  }

  if (!context.bindGroup || context.boundShapeKey !== shapeKey) {
    context.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: context.srcBuffer } },
        { binding: 1, resource: { buffer: context.outBuffer } },
        { binding: 2, resource: { buffer: context.uniformBuffer } },
      ],
    });
    context.boundShapeKey = shapeKey;
  }
}

export async function packNanodlpRgbaWithWebGpu(request: PackRequest): Promise<Uint8ClampedArray | null> {
  const context = await getWebGpuContext();
  if (!context) return null;

  const { device, pipeline } = context;

  const srcPixelCount = request.sourceWidthPx * request.sourceHeightPx;
  const outPixelCount = request.outputWidthPx * request.sourceHeightPx;
  const srcBytes = request.sourceRgba;

  if (srcBytes.byteLength < srcPixelCount * 4) {
    return null;
  }

  const requiredSubpixels = request.packingMode === 'rgb8_div3'
    ? request.outputWidthPx * 3
    : request.outputWidthPx * 2;
  const padLeft = Math.floor(Math.max(0, requiredSubpixels - request.sourceWidthPx) / 2);

  const GPUBufferUsageAny = (globalThis as any).GPUBufferUsage;
  const GPUMapModeAny = (globalThis as any).GPUMapMode;
  if (!GPUBufferUsageAny || !GPUMapModeAny) return null;

  const srcBytesNeeded = srcPixelCount * 4;
  const outBytesNeeded = outPixelCount * 4;
  const shapeKey = `${request.sourceWidthPx}x${request.sourceHeightPx}->${request.outputWidthPx}`;
  ensureReusableResources(context, GPUBufferUsageAny, srcBytesNeeded, outBytesNeeded, shapeKey);

  const paramArray = new Int32Array(8);
  paramArray[0] = request.sourceWidthPx;
  paramArray[1] = request.sourceHeightPx;
  paramArray[2] = request.outputWidthPx;
  paramArray[3] = padLeft;
  paramArray[4] = request.packingMode === 'rgb8_div3' ? 0 : 1;

  device.queue.writeBuffer(context.srcBuffer, 0, srcBytes.buffer, srcBytes.byteOffset, srcBytesNeeded);
  device.queue.writeBuffer(context.uniformBuffer, 0, paramArray.buffer, paramArray.byteOffset, paramArray.byteLength);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, context.bindGroup);
  const wgX = Math.ceil(request.outputWidthPx / 16);
  const wgY = Math.ceil(request.sourceHeightPx / 16);
  pass.dispatchWorkgroups(Math.max(1, wgX), Math.max(1, wgY));
  pass.end();

  encoder.copyBufferToBuffer(context.outBuffer, 0, context.readbackBuffer, 0, outBytesNeeded);
  device.queue.submit([encoder.finish()]);

  try {
    await context.readbackBuffer.mapAsync(GPUMapModeAny.READ);
  } catch {
    resetContextBuffers(context);
    return null;
  }

  const mapped = context.readbackBuffer.getMappedRange();
  const outCopy = new Uint8ClampedArray(mapped.byteLength);
  outCopy.set(new Uint8Array(mapped));
  context.readbackBuffer.unmap();

  return outCopy;
}
