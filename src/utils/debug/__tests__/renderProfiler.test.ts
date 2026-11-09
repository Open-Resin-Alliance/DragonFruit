import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  annotateRenderFrames,
  formatRenderProfileLine,
  getRenderProfilerSnapshot,
  installRenderProfiler,
  markRenderFrame,
  passDrawCounts,
  setRenderProfilerEnabled,
  summarizeRenderFrames,
  uninstallRenderProfiler,
  type RenderFrameSample,
  type RenderPassSample,
} from '../renderProfiler';

function pass(overrides: Partial<RenderPassSample> = {}): RenderPassSample {
  return {
    scene: 'main',
    cpuMs: 3,
    gpuMs: 7,
    calls: 40,
    triangles: 12_000_000,
    lines: 0,
    points: 0,
    ...overrides,
  };
}

function frame(frameMs: number, passes: RenderPassSample[]): RenderFrameSample {
  const cpuMs = passes.reduce((sum, entry) => sum + entry.cpuMs, 0);
  const gpuTimes = passes.flatMap((entry) => (entry.gpuMs == null ? [] : [entry.gpuMs]));
  return {
    atMs: 0,
    frameMs,
    cpuMs,
    reactMs: 0,
    gpuMs: gpuTimes.length > 0 ? gpuTimes.reduce((sum, value) => sum + value, 0) : null,
    calls: passes.reduce((sum, entry) => sum + entry.calls, 0),
    triangles: passes.reduce((sum, entry) => sum + entry.triangles, 0),
    lines: 0,
    points: 0,
    passes,
    programs: 12,
    geometries: 30,
    textures: 4,
  };
}

test('a reset renderer reports the pass itself, an accumulating one reports the difference', () => {
  const before = { calls: 40, triangles: 1000, lines: 2, points: 0 };
  const after = { calls: 42, triangles: 1300, lines: 5, points: 1 };

  assert.deepEqual(passDrawCounts(before, after, true), after, 'autoReset replaced the counters');
  assert.deepEqual(
    passDrawCounts(before, after, false),
    { calls: 2, triangles: 300, lines: 3, points: 1 },
    'without autoReset the counters accumulate across passes',
  );
});

test('summarize reports percentiles, fps and per-pass attribution', () => {
  const frames = [
    frame(16, [pass()]),
    frame(20, [pass(), pass({ scene: 'picking', cpuMs: 1, gpuMs: null, calls: 5, triangles: 500_000 })]),
    frame(40, [pass()]),
    frame(8, [pass(), pass({ scene: 'picking', cpuMs: 1, gpuMs: null, calls: 5, triangles: 500_000 })]),
  ];

  const summary = summarizeRenderFrames(frames, 'available');

  assert.equal(summary.frameCount, 4);
  assert.equal(summary.frameMs?.avg, 21);
  assert.equal(summary.frameMs?.p50, 20, 'the middle value of 8, 16, 20, 40');
  assert.equal(summary.frameMs?.p95, 40);
  assert.ok(Math.abs(summary.fps - 1000 / 21) < 1e-9);

  assert.equal(summary.passesPerFrame, 1.5);
  const main = summary.passes.find((entry) => entry.scene === 'main');
  const picking = summary.passes.find((entry) => entry.scene === 'picking');
  assert.equal(main?.perFrame, 1);
  assert.equal(main?.calls, 40);
  assert.equal(main?.gpuMs?.p50, 7);
  assert.equal(picking?.perFrame, 0.5, 'two picking passes across four frames');
  assert.equal(picking?.gpuMs, null, 'a pass with no resolved query has no GPU stats');
  assert.equal(picking?.cpuMs?.p50, 1);
});

test('GPU statistics are absent when the context has no timer query', () => {
  const summary = summarizeRenderFrames([frame(16, [pass()])], 'unavailable');

  assert.equal(summary.gpuMs, null);
  assert.equal(summary.passes[0].gpuMs, null);
});

test('React commit time is aggregated apart from CPU render time', () => {
  const withReact = frame(16, [pass()]);
  withReact.reactMs = 11;
  const summary = summarizeRenderFrames([withReact], 'available');

  assert.equal(summary.reactMs?.p50, 11);
  assert.equal(summary.cpuMs?.p50, 3);
});

test('a sync probe contributes GPU statistics like a timer query', () => {
  const summary = summarizeRenderFrames([frame(16, [pass()]), frame(20, [pass({ gpuMs: 9 })])], 'sync-probe');

  assert.equal(summary.gpuMs?.avg, 8, 'the two GPU figures 7 and 9');
  assert.equal(summary.passes[0].gpuMs?.avg, 8);
});

test('an empty window summarizes to zero rather than NaN', () => {
  const summary = summarizeRenderFrames([], 'untested');

  assert.equal(summary.frameCount, 0);
  assert.equal(summary.fps, 0);
  assert.equal(summary.frameMs, null);
  assert.equal(summary.passesPerFrame, 0);
  assert.deepEqual(summary.passes, []);
});

test('the log line carries the frame, pass and scene summary in one line', () => {
  const report = {
    summary: summarizeRenderFrames(
      [frame(16, [pass()]), frame(24, [pass({ scene: 'picking', cpuMs: 1, calls: 6, triangles: 100_000 })])],
      'unavailable',
    ),
    gpuTiming: 'unavailable' as const,
    sceneStats: {
      objects: 120,
      meshes: 24,
      instancedMeshes: 4,
      instances: 9000,
      lines: 3,
      points: 1,
      geometries: 30,
      materials: 12,
      triangles: 12_100_000,
      byGroup: {
        models: { triangles: 12_000_000, objects: 21 },
        supports: { triangles: 100_000, objects: 3 },
      },
    },
    frames: [],
    events: [],
    stalls: [],
    viewport: null,
    renderer: null,
  };

  const line = formatRenderProfileLine(report);

  assert.match(line, /^\[render\] frames=2 fps=50\.0/);
  assert.match(line, /cpu p50=/);
  assert.match(line, /gpu=unavailable/);
  assert.match(line, /main:0\.50x/);
  assert.match(line, /picking:0\.50x/);
  assert.match(line, /scene objects=120 meshes=24/);
  assert.match(line, /groups models=12\.00M,supports=100\.0k/);
  assert.doesNotMatch(line, /undefined|NaN/);
});

test('the installed sampler attributes each render call to its pass and restores the renderer on uninstall', () => {
  const mainScene = new THREE.Scene();
  const pickScene = new THREE.Scene();
  pickScene.name = 'picking';
  const info = {
    autoReset: true,
    render: { calls: 0, triangles: 0, lines: 0, points: 0, frame: 0 },
    memory: { geometries: 30, textures: 4 },
    programs: [] as unknown[],
  };
  const countsByScene = new Map([
    [mainScene, { calls: 40, triangles: 12_000_000, lines: 0, points: 0 }],
    [pickScene, { calls: 5, triangles: 500_000, lines: 0, points: 0 }],
  ]);
  const render = (scene: THREE.Scene) => {
    Object.assign(info.render, countsByScene.get(scene) ?? countsByScene.get(mainScene));
  };
  const renderer = {
    render,
    info,
    getContext: () => null,
  } as unknown as THREE.WebGLRenderer;

  setRenderProfilerEnabled(true);
  try {
    installRenderProfiler(renderer, mainScene);

    markRenderFrame();
    renderer.render(mainScene, new THREE.Camera());
    renderer.render(pickScene, new THREE.Camera());
    markRenderFrame();
    renderer.render(mainScene, new THREE.Camera());
    markRenderFrame();

    const snapshot = getRenderProfilerSnapshot();
    assert.equal(snapshot.enabled, true);
    assert.equal(snapshot.gpuTiming, 'unavailable', 'the fake context exposes no timer extension');
    assert.equal(snapshot.frames.length, 2);

    const first = snapshot.frames[0];
    assert.deepEqual(first.passes.map((entry) => entry.scene), ['main', 'picking']);
    assert.equal(first.calls, 45);
    assert.equal(first.triangles, 12_500_000);
    assert.equal(first.passes[1].calls, 5);

    const second = snapshot.frames[1];
    assert.deepEqual(second.passes.map((entry) => entry.scene), ['main']);

    uninstallRenderProfiler();
    assert.equal(renderer.render, render, 'uninstall restores the original method');
    assert.equal(getRenderProfilerSnapshot().frames.length, 0);
  } finally {
    uninstallRenderProfiler();
    setRenderProfilerEnabled(false);
  }
});

test('a hot frame is labelled with the input it contains and the browser-reported stall', () => {
  const slow = { ...frame(44, [pass({ cpuMs: 2.8 })]), atMs: 1006.1 };
  const fast = { ...frame(6.1, [pass()]), atMs: 1000 };
  const events = [
    { atMs: 1004, name: 'pointerdown', detail: 'button=2 buttons=2 mouse' },
    { atMs: 1040, name: 'orbit-end', detail: 'resume=220ms' },
  ];
  const stalls = [{
    kind: 'loaf' as const,
    name: 'long-animation-frame',
    startMs: 1007,
    durationMs: 40,
    blockingMs: 38,
    scripts: [{ name: 'onOrbitEnd', source: 'https://example/chunk.js', durationMs: 30 }],
  }];

  const annotated = annotateRenderFrames([fast, slow], events, stalls);

  assert.deepEqual(annotated[0].events, ['pointerdown(button=2 buttons=2 mouse)']);
  assert.equal(annotated[0].stallMs, undefined);
  assert.deepEqual(annotated[1].events, ['orbit-end(resume=220ms)']);
  assert.equal(annotated[1].stallMs, 40, 'the frame overlaps the whole 40 ms long frame');

  const report = {
    summary: summarizeRenderFrames(annotated, 'unavailable'),
    gpuTiming: 'unavailable' as const,
    sceneStats: null,
    frames: annotated,
    events,
    stalls,
    viewport: null,
    renderer: null,
  };
  const line = formatRenderProfileLine(report);
  assert.match(line, /hotFrame=44\.0ms@1006 stall=40\.0ms\(loaf:onOrbitEnd\) \[orbit-end\(resume=220ms\)\]/);
  assert.match(line, /stalls=1 worst=40\.0ms\(loaf\) blocking=38\.0ms scripts=onOrbitEnd@chunk\.js:30\.0/);
  assert.match(line, /events=pointerdown>orbit-end/);
});

test('stall time merges the same block reported by two APIs', () => {
  const slow = { ...frame(44, [pass()]), atMs: 1000 };
  const stalls = [
    { kind: 'event' as const, name: 'click', startMs: 1005, durationMs: 40 },
    { kind: 'loaf' as const, name: 'long-animation-frame', startMs: 1004, durationMs: 42 },
  ];
  const [annotated] = annotateRenderFrames([slow], [], stalls);
  assert.equal(annotated.stallMs, 40, 'the union clipped to the frame [1004,1044], not the summed overlaps');
});
