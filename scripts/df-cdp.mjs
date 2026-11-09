// Drives the running DragonFruit webview over CDP and profiles a gesture.
//
//   npm run profile:df -- eval "<js expression>"
//   npm run profile:df -- hover <xPct> <yPct> <moves> [label]
//   npm run profile:df -- sweep <xPct> <yPct> <moves> '<[[x,y],…]>' [label]
//   npm run profile:df -- click <xPct> <yPct> [label]
//   npm run profile:df -- key <key> <ctrl|shift|alt|none> <times> [label]
//   npm run profile:df -- scan <cols> <rows> [js probe]
//   npm run profile:df -- shot <file.png> [xPct] [yPct]
//   npm run profile:df -- zoom <xPct> <yPct> <steps> [deltaY]
//   npm run profile:df -- drag <x1> <y1> <x2> <y2> [right|middle] [steps]
//   npm run profile:df -- fps <seconds> [move] [moves]
//   npm run profile:df -- clickdom <css selector> [index]
//   npm run profile:df -- blockdrag <x1> <y1> <x2> <y2>   long tasks at a drag's start
//   npm run profile:df -- dragshot <x1> <y1> <x2> <y2> [file] [steps]   screenshot mid-drag
//   npm run profile:df -- block <xPct> <yPct>     long tasks and frame gaps after a click
//
// Start the app with the port open first:
//
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
//     src-tauri/target/debug/dragonfruit-desktop.exe [scene.voxl]
//
// Input goes through CDP, so it is trusted and the app's own handlers run; a CPU
// profile covers everything the gesture triggers, including the React commits and
// R3F renders that follow it, not just the handler. Set `CDP_FILTER` to a regex
// to show only matching frames. See docs/dev/performance-debugging.md.

const [, , mode, ...rest] = process.argv;

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('localhost:3005') && !t.url.includes('splashscreen'));
if (!page) {
  console.error('no page target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails));
  }
  return result.result.value;
}

const frame = () => evaluate('new Promise((r) => requestAnimationFrame(() => r(1)))');

await send('Runtime.enable');
await send('Profiler.enable');
await send('Page.enable');

if (mode === 'reload') {
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: true });
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => setTimeout(r, 1000));
    const ready = await evaluate(`document.body.innerText.length > 200`).catch(() => false);
    if (ready) break;
  }
  console.log('reloaded:', JSON.stringify(await evaluate("document.body.innerText.slice(0, 120)")).slice(0, 200));
  ws.close();
  process.exit(0);
}

if (mode === 'eval') {
  console.log(JSON.stringify(await evaluate(rest.join(' ')), null, 1));
  ws.close();
  process.exit(0);
}

const rect = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`);

if (mode === 'scan') {
  const cols = Number(rest[0] ?? 6);
  const rows = Number(rest[1] ?? 5);
  const probe = rest[2] ?? 'String(window.__dragonfruitLastImmediateModelHoverId)';
  const hits = [];
  for (let r = 0; r < rows; r += 1) {
    const row = [];
    for (let c = 0; c < cols; c += 1) {
      const px = rect.left + rect.width * ((c + 0.5) / cols);
      const py = rect.top + rect.height * ((r + 0.5) / rows);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, buttons: 0, pointerType: 'mouse' });
      await frame();
      row.push(await evaluate(probe));
    }
    hits.push(row);
    console.log(`row ${r}: ${row.join('  ')}`);
  }
  console.log('rect', JSON.stringify(rect));
  ws.close();
  process.exit(0);
}

if (mode === 'shot') {
  const file = rest[0];
  if (rest[1] !== undefined) {
    const px = rect.left + rect.width * Number(rest[1]);
    const py = rect.top + rect.height * Number(rest[2]);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, buttons: 0, pointerType: 'mouse' });
    await frame();
    await frame();
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, Buffer.from(data, 'base64'));
  console.log('wrote', file);
  ws.close();
  process.exit(0);
}

if (mode === 'zoom') {
  // Wheel at a point: negative steps zoom in, positive out.
  const steps = Number(rest[2] ?? 3);
  const delta = Number(rest[3] ?? -120);
  for (let i = 0; i < steps; i += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: rect.left + rect.width * Number(rest[0]),
      y: rect.top + rect.height * Number(rest[1]),
      deltaX: 0,
      deltaY: delta,
      pointerType: 'mouse',
    });
    await frame();
    await frame();
  }
  console.log('zoomed', steps, 'x', delta);
  ws.close();
  process.exit(0);
}

if (mode === 'drag') {
  // Right-drag orbits (mouseButtons: RIGHT: ROTATE), middle-drag pans.
  const [x1, y1, x2, y2] = rest.slice(0, 4).map(Number);
  const button = rest[4] ?? 'right';
  const steps = Number(rest[5] ?? 12);
  const buttons = button === 'right' ? 2 : button === 'middle' ? 4 : 1;
  const px = (v) => rect.left + rect.width * v;
  const py = (v) => rect.top + rect.height * v;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px(x1), y: py(y1), buttons: 0, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px(x1), y: py(y1), button, buttons, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: px(x1 + (x2 - x1) * t),
      y: py(y1 + (y2 - y1) * t),
      button,
      buttons,
      pointerType: 'mouse',
    });
    await frame();
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px(x2), y: py(y2), button, buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await frame();
  console.log('dragged', button, x1, y1, '->', x2, y2);
  ws.close();
  process.exit(0);
}

if (mode === 'fps') {
  // Frames per second over a window. With `move`, trusted pointer moves are
  // dispatched through CDP between samples: in-page synthetic events carry
  // offsetX 0, so R3F reads them as a pointer at the canvas origin and the hover
  // path never runs.
  const seconds = Number(rest[0] ?? 3);
  const move = rest[1] === 'move';
  const moves = Number(rest[2] ?? 60);
  const script = `(async () => {
    const times = [];
    let raf = 0;
    const tick = (t) => { times.push(t); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, ${seconds} * 1000));
    cancelAnimationFrame(raf);
    const span = (times[times.length - 1] - times[0]) / 1000;
    const gaps = times.slice(1).map((t, k) => t - times[k]).sort((a, b) => a - b);
    return {
      frames: times.length,
      seconds: +span.toFixed(2),
      fps: +(times.length / span).toFixed(1),
      medianFrameMs: +gaps[Math.floor(gaps.length / 2)].toFixed(1),
      p95FrameMs: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
      worstFrameMs: +gaps[gaps.length - 1].toFixed(1),
    };
  })()`;
  const sampler = evaluate(script);
  if (move) {
    for (let i = 0; i < moves; i += 1) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: rect.left + rect.width * (0.2 + (i % 20) / 40),
        y: rect.top + rect.height * 0.5,
        buttons: 0,
        pointerType: 'mouse',
      });
      await new Promise((r) => setTimeout(r, Math.max(8, (seconds * 1000) / moves)));
    }
  }
  console.log(JSON.stringify(await sampler, null, 1));
  ws.close();
  process.exit(0);
}

if (mode === 'clickdom') {
  // Click an element found by selector, through trusted CDP input: R3F and the
  // app both read real event geometry, which synthetic in-page events lack.
  const selector = rest[0];
  const index = Number(rest[1] ?? 0);
  const box = await evaluate(`(() => {
    const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: (el.getAttribute('aria-label') || el.title || el.className || '').slice(0, 60) };
  })()`);
  if (!box) {
    console.log('no element for', selector, index);
    ws.close();
    process.exit(1);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0, pointerType: 'mouse' });
  await frame();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await frame();
  await frame();
  console.log('clicked', JSON.stringify(box));
  ws.close();
  process.exit(0);
}

if (mode === 'block') {
  // What a click costs the user: the long tasks it starts and the frames it
  // delays, measured in the page while trusted input is dispatched.
  const x = rect.left + rect.width * Number(rest[0]);
  const y = rect.top + rect.height * Number(rest[1]);
  await evaluate(`(() => {
    const g = globalThis;
    g.__lt = [];
    g.__frames = [];
    g.__ltObserver?.disconnect();
    g.__rafId && cancelAnimationFrame(g.__rafId);
    try {
      g.__ltObserver = new PerformanceObserver((list) => { for (const e of list.getEntries()) g.__lt.push({ start: +e.startTime.toFixed(1), ms: +e.duration.toFixed(1) }); });
      g.__ltObserver.observe({ entryTypes: ['longtask'] });
    } catch {}
    const tick = (t) => { g.__frames.push(t); g.__rafId = requestAnimationFrame(tick); };
    g.__rafId = requestAnimationFrame(tick);
    return 'armed';
  })()`);
  const t0 = Date.now();
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await frame();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  const { profile } = await send('Profiler.stop');
  await new Promise((r) => setTimeout(r, 1500));
  const out = await evaluate(`(() => {
    const g = globalThis;
    const frames = g.__frames ?? [];
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => b - a);
    return { longTasks: g.__lt, frames: frames.length, worstGaps: gaps.slice(0, 5).map((g) => +g.toFixed(1)) };
  })()`);
  console.log(`${mode} ${rest[0]},${rest[1]}: dispatch wall ${Date.now() - t0} ms`);
  console.log(JSON.stringify(out, null, 1));
  ws.close();
  process.exit(0);
}

if (mode === 'dragshot') {
  // Press, move in steps, screenshot *before* releasing: the state the user sees
  // mid-drag is what is being reported, and a release commits it away.
  const [x1, y1, x2, y2] = rest.slice(0, 4).map(Number);
  const file = rest[4] ?? 'C:/tmp/dragshot.png';
  const steps = Number(rest[5] ?? 12);
  const px = (v) => rect.left + rect.width * v;
  const py = (v) => rect.top + rect.height * v;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px(x1), y: py(y1), buttons: 0, pointerType: 'mouse' });
  await frame();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px(x1), y: py(y1), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await frame();
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: px(x1 + (x2 - x1) * t),
      y: py(y1 + (y2 - y1) * t),
      button: 'left',
      buttons: 1,
      pointerType: 'mouse',
    });
    await frame();
  }
  await frame();
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, Buffer.from(data, 'base64'));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px(x2), y: py(y2), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await frame();
  console.log('dragged', x1, y1, '->', x2, y2, '; shot while held:', file);
  ws.close();
  process.exit(0);
}

if (mode === 'blockdrag') {
  // Press a model, cross the drag threshold, then hold still while the long task
  // observer runs: the chug a drag reports is at its start, not while it moves.
  const [x1, y1, x2, y2] = rest.slice(0, 4).map(Number);
  const px = (v) => rect.left + rect.width * v;
  const py = (v) => rect.top + rect.height * v;
  await evaluate(`(() => {
    const g = globalThis;
    g.__lt = []; g.__frames = [];
    g.__ltObserver?.disconnect();
    g.__rafId && cancelAnimationFrame(g.__rafId);
    try { g.__ltObserver = new PerformanceObserver((l) => { for (const e of l.getEntries()) g.__lt.push({ start: +e.startTime.toFixed(1), ms: +e.duration.toFixed(1) }); }); g.__ltObserver.observe({ entryTypes: ['longtask'] }); } catch {}
    const tick = (t) => { g.__frames.push(t); g.__rafId = requestAnimationFrame(tick); }; g.__rafId = requestAnimationFrame(tick);
    return 'armed';
  })()`);
  const t0 = Date.now();
  await send('Profiler.start');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px(x1), y: py(y1), buttons: 0, pointerType: 'mouse' });
  await frame();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px(x1), y: py(y1), button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await frame();
  for (let i = 1; i <= 6; i += 1) {
    const t = i / 6;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px(x1 + (x2 - x1) * t), y: py(y1 + (y2 - y1) * t), button: 'left', buttons: 1, pointerType: 'mouse' });
    await frame();
  }
  const { profile } = await send('Profiler.stop');
  await new Promise((r) => setTimeout(r, 1500));
  const out = await evaluate(`(() => {
    const g = globalThis;
    const frames = g.__frames ?? [];
    const gaps = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => b - a);
    return { longTasks: g.__lt, frames: frames.length, worstGaps: gaps.slice(0, 5).map((v) => +v.toFixed(1)) };
  })()`);
  console.log(`${mode} ${x1},${y1} -> ${x2},${y2}: total ${Date.now() - t0} ms`);
  console.log(JSON.stringify(out, null, 1));
  {
    const self = new Map();
    const parentOf = new Map();
    for (const node of profile.nodes) for (const child of node.children ?? []) parentOf.set(child, node.id);
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const frameName = (n) => `${n.callFrame.functionName || '(anonymous)'} @ ${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber + 1}`;
    for (const node of profile.nodes) self.set(frameName(node), (self.get(frameName(node)) ?? 0) + (node.hitCount ?? 0));
    const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
    console.log(`\nprofile: ${((profile.endTime - profile.startTime) / 1000).toFixed(1)} ms, ${total} samples`);
    for (const [name, hits] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
      console.log(`  ${((hits / total) * 100).toFixed(1).padStart(5)}%  ${hits.toString().padStart(5)}  ${name}`);
    }
    if (process.env.CDP_STACK) {
      const re = new RegExp(process.env.CDP_STACK, 'i');
      const target = profile.nodes.filter((n) => re.test(frameName(n))).sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))[0];
      if (target) {
        const chain = [];
        let node = target;
        while (node && chain.length < 12) { chain.push(frameName(node)); node = byId.get(parentOf.get(node.id)); }
        console.log('\nstack for ' + frameName(target) + ':');
        for (const [depth, name] of chain.entries()) console.log(`  ${'  '.repeat(depth)}${name}`);
      }
    }
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px(x2), y: py(y2), button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  ws.close();
  process.exit(0);
}

const keyMods = { ctrl: 2, shift: 8, alt: 1 };
const xPct = Number(rest[0]);
const yPct = Number(rest[1]);
const moves = Number(rest[2] ?? 1);
const label = (mode === 'sweep' ? rest[4] : rest[3]) ?? `${mode} ${rest[0]},${rest[1]}`;
const x = rect.left + rect.width * xPct;
const y = rect.top + rect.height * yPct;

await send('Profiler.start');
const t0 = Date.now();
if (mode === 'hover') {
  for (let i = 0; i < moves; i += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x + (i % 3),
      y: y + (i % 2),
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    });
    await frame();
  }
} else if (mode === 'sweep') {
  const pts = JSON.parse(rest[3]);
  for (let i = 0; i < moves; i += 1) {
    const [sx, sy] = pts[i % pts.length];
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: rect.left + rect.width * sx,
      y: rect.top + rect.height * sy,
      buttons: 0,
      pointerType: 'mouse',
    });
    await frame();
  }
} else if (mode === 'key') {
  const key = rest[0];
  const mods = keyMods[rest[1]] ?? 0;
  for (let i = 0; i < moves; i += 1) {
    for (const type of ['keyDown', 'keyUp']) {
      await send('Input.dispatchKeyEvent', {
        type,
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
        modifiers: mods,
      });
    }
    await frame();
  }
} else if (mode === 'click') {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0, pointerType: 'mouse' });
  await frame();
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await frame();
}
await frame();
const wall = Date.now() - t0;
const { profile } = await send('Profiler.stop');

const self = new Map();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
// V8 profile nodes link downwards (`children`), not upwards: build the parent
// map from those, or an ancestry walk stops at the frame it started from.
const parentOf = new Map();
for (const node of profile.nodes) {
  for (const child of node.children ?? []) parentOf.set(child, node.id);
}
const frameName = (n) => `${n.callFrame.functionName || '(anonymous)'} @ ${n.callFrame.url.split('/').slice(-1)[0]}:${n.callFrame.lineNumber + 1}`;
for (const node of profile.nodes) {
  self.set(frameName(node), (self.get(frameName(node)) ?? 0) + (node.hitCount ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0) || 1;
const durationMs = (profile.endTime - profile.startTime) / 1000;
console.log(`${label}: ${moves} ${mode}(s), ${wall} ms wall, ${durationMs.toFixed(1)} ms profiled, ${total} samples`);
if (process.env.CDP_STACK) {
  // Name the caller of a hot frame: the ancestry of the node with the most hits.
  const re = new RegExp(process.env.CDP_STACK, 'i');
  const target = profile.nodes.filter((n) => re.test(frameName(n))).sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))[0];
  if (target) {
    const chain = [];
    let node = target;
    while (node && chain.length < 12) {
      chain.push(frameName(node));
      node = byId.get(parentOf.get(node.id));
    }
    console.log('\nstack for ' + frameName(target) + ':');
    for (const [depth, name] of chain.entries()) console.log(`  ${'  '.repeat(depth)}${name}`);
  } else {
    console.log('no frame matched', process.env.CDP_STACK);
  }
}
const filter = process.env.CDP_FILTER ? new RegExp(process.env.CDP_FILTER, 'i') : null;
const ranked = [...self.entries()].sort((a, b) => b[1] - a[1]);
const shown = filter ? ranked.filter(([n]) => filter.test(n)) : ranked;
for (const [name, hits] of shown.slice(0, filter ? 14 : 18)) {
  console.log(`  ${((hits / total) * 100).toFixed(1).padStart(5)}%  ${hits.toString().padStart(5)}  ${name}`);
}
ws.close();
