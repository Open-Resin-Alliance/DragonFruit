# Render Profiler

The render profiler answers "where did that frame go?" from inside the running
app. It is a draggable window over the scene that reports, per frame and per
render pass:

- frame interval, CPU submission time, and GPU time where the context can
  measure it,
- draw calls, triangles, lines and points,
- how many `WebGLRenderer.render` passes a frame issued, attributed to the
  scene each one drew,
- the scene-graph inventory behind them (objects, meshes, instances, programs,
  geometries, textures),
- the input and navigation events that landed in each frame, so a hot frame says
  which gesture it belongs to, plus any idle task that took 20 ms or more with
  its caller and duration,
- browser-reported long frames (Long Animation Frame, long-task, and Event Timing
  entries) that overlap it, with the scripts the browser blames,
- the used JS heap change since the previous frame, so a GC pause is visible.

Toggle it with **Ctrl+Shift+P**. It is off by default and costs nothing while
closed. The window remembers where you left it. See
[Performance Debugging](performance-debugging.md) for the rest of the toolkit —
the stall detector, the diagnostics modal and external profilers.

## Reading the numbers

| Row | What it is | What a bad value suggests |
| --- | --- | --- |
| FPS | frames per second over the sampled window | below the display refresh while nothing moves — a frame budget problem |
| Frame time | interval between frame marks (p50, p95) | p95 far above p50 — intermittent work, not a steady cost |
| CPU render | time inside `WebGLRenderer.render`, summed over passes | high: draw-call setup, matrix/skinning updates, shader switches |
| React commit | time React spent committing the scene subtree, from a `<Profiler>` | high: a state write re-rendering the scene, not the renderer |
| GPU render | timer-query result, when available | high with low CPU: fill rate, vertex load or a heavy fragment shader |
| Draw calls | `renderer.info.render.calls` | hundreds per frame: per-object or per-bucket meshes instead of batches |
| Triangles | `renderer.info.render.triangles` | geometry drawn that is not on screen, or a missing LOD |
| Passes | render calls per frame, one row per scene | more than the app intends (a picking pass that should be paused) |
| Groups | triangles per top-level group (`models`, `supports`, `rafts`) | which half of the scene is actually heavy — a support plate adds geometry and draw calls the model count does not show |

A React commit is main-thread work the renderer never sees, so a frame that
renders cheaply and still misses vsync is attributed here before the GPU is
blamed. `frameMs` includes the wait for the display, and CPU and GPU time overlap;
subtracting one from another gives a bound, not a breakdown. The React commit
is not in either column — a frame that renders cheaply and still feels slow is
a React or layout problem, not a renderer one.

**Hot frames and input** is the section below the pass table. It lists the four
hottest frames in the window with the events inside each, then the browser's
long-frame entries and the recent inputs. The decisive split is whether a hot
frame has a long-frame entry: if it does, the browser names the script (or the
style/layout span) that held the main thread; if it does not, the block is
outside JS — GPU, compositor, or a synchronous driver wait — and no amount of
React or renderer optimisation will move it.

### GPU timing

GPU rows come from `EXT_disjoint_timer_query_webgl2`. When the context does not
expose it — WebView2 does not, on this machine — the badge reads **CPU only**
and every GPU cell reads `n/a`; the profiler does not estimate GPU time.

**GPU probe** is the explicit alternative: for 90 frames it waits with
`gl.finish()` after the main pass and records the GPU-inclusive cost of each
frame as that pass's GPU time. It stalls the main thread by design and distorts
the frame timing while it runs, so treat it as a measurement, not a mode: press
it, read the GPU row, stop. The badge reads **GPU sync** afterwards, and the
probe frames stay in the rolling window until they age out.

A real timer query resolves a frame or two after its pass, so a row can trail
briefly. Disjoint results (the GPU changed clocks mid-query) are discarded
rather than reported, and a context that never answers is abandoned after five
dropouts.

## Recording

- **Record** captures the next 600 frames into a separate buffer. While it runs
  the panel stops refreshing, so its own four-renders-a-second cost cannot show
  up as the p95 the recording is meant to explain. When the buffer fills, one
  `[render]` line is written to `dragonfruit.log`: frame, CPU, React and GPU
  percentiles, draw-call and triangle percentiles, a line per pass, the scene
  inventory, the hottest frame with its stall time and events, and the worst
  browser-reported long frame with its top scripts. That is the line to ask a
  user for in a report. The copied JSON carries every event and long frame as
  `events` and `stalls`, and each frame carries the overlapping `events`,
  `stallMs` and `heapDeltaMb`.
- **Write log** writes the same line for the current rolling window.
- **Copy JSON** puts the full report — every captured frame, both summaries, and
  the events/long frames that fall inside that frame window — on the clipboard.
  After a recording finishes it reports that recording, not the idle rolling
  window that replaced it, until the next recording starts.
- **Pause** stops sampling without unpatching anything; the renderer resumes
  normal behaviour on the next frame.

The rolling window keeps 240 frames (about four seconds at 60 fps) so the live
panel stays cheap. Recording is the path for a longer capture.

## How it works

`src/utils/debug/renderProfiler.ts` is the sampler and the store. It patches the
live renderer's `render` method and restores it on uninstall; each pass is timed
with a `performance.now()` pair and its counters are read from
`renderer.info.render` immediately after the call. `passDrawCounts` handles both
`info.autoReset` modes: with it on, the counters already describe the pass; with
it off, the difference from the previous reading does.

`src/components/scene/SceneCanvas/SceneRenderProfiler.tsx` mounts inside the
canvas. It installs the sampler while the window is open, and its `useFrame`
calls `markRenderFrame` to close the previous frame before any render of the
next is recorded. It is mounted first among the canvas children; R3F runs frame
subscribers in mount order, so the picking pass's own `useFrame` lands in the
right frame.

`src/components/debug/RenderProfilerOverlay.tsx` is the window. It is a plain
DOM card, not a drei `Html` label: it must keep its React tree out of the R3F
reconciler and stay readable while the scene is throttled. It refreshes at the
store's notify rate — four times a second — so drawing it cannot pollute the
numbers it reports.

Input capture is installed with the sampler: `recordRenderEvent` is called from
window listeners for the picking navigation events and for pointer down/up and
clicks (with the target's tag and label), so
the events exist even when the gesture never reaches React state (a right-drag
orbit in transform mode is one). Long frames come from a `PerformanceObserver`
that prefers `long-animation-frame`, falls back to `longtask`, and separately
observes `event` entries at 40 ms for input names only (pointer moves would flood it). `annotateRenderFrames` attaches
the overlapping stall time and event names when frames are read, not when they
are recorded, so a long-frame entry that arrives a frame late still lands on the
frame that overlapped it.

The picking scene is named `picking` (`createPickScene` in
`src/components/picking/PickingRenderer.tsx`), which is what gives that pass a
readable label instead of `aux1`. Any other unnamed scene gets a stable `auxN`
label per scene identity.

## Constraints

- **Ctrl+Shift+P is the profiling binding.** The platform reads that
  combination as Print, so `setupHotkeyListeners` prevents its default action
  in `src/hotkeys/HotkeyRegistryManager.tsx`; without that the print dialog
  opens over the app.
- The sampler is one method patch on one renderer object. Mounting two canvases
  with the profiler open re-points it at the last installed renderer; the
  diagnostics use case is the main workspace canvas.
- The pass counters are `renderer.info.render`, so anything that bypasses the
  renderer (a raw `gl.drawElements` in a custom pass) is not in them.
- Scene inventory is a traversal of the main scene, refreshed every two seconds
  while the profiler is open.
- Long-frame attribution is whatever the browser exposes. Chromium gives scripts,
  blocking, render and style/layout time; an older engine without those APIs
  reports only that a long task happened (or nothing at all). A missing entry is
  evidence that the block was not main-thread script, not proof that nothing
  happened.

## Related pages

- [Performance Debugging](performance-debugging.md) — the in-app stall
  detector, the diagnostics modal (Ctrl+Shift+D) and the CDP harness.
