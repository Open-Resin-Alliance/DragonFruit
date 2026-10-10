# Performance Debugging

How to find out where DragonFruit's time goes. Two halves: scaffolding that
ships inside the app and reports from users' machines, and external profilers
you point at your own machine when you need a call stack.

## In-app scaffolding

### Main-thread stall detector

`src/utils/debug/mainThreadHeartbeat.ts` is the UI's equivalent of a database
slow query log. A timer that should fire every 100 ms measures how late it
actually woke up. The main thread is single-threaded, so a timer that is 12
seconds late means the thread was held for 12 seconds and the window was frozen
for exactly that long.

Reports land in `dragonfruit.log` at `WARN`:

```
[stall] Main thread blocked for 12340 ms (threshold 500 ms) — pointer: canvas (12358 ms ago), hotkey: s (4.2 s ago)
```

Because a stall is only noticed once a tick is late by the full threshold, a
block starting just after a tick gets one tick for free: with a 100 ms tick and
a 500 ms threshold, blocks up to 600 ms can go unreported, and a reported figure
understates the real block by up to 100 ms. It is a floor, not an exact
duration.

The threshold defaults to 500 ms and is read once at startup from the
`df.debug.stallThresholdMs` key in `localStorage`. Values below one tick are
ignored — the detector would be reporting its own scheduling jitter. Pick the
threshold the way you would pick `long_query_time`: low enough to catch what a
user notices, high enough that a legitimately heavy frame does not fill the log.

Ticks are skipped while the window is hidden and across any visibility change.
An occluded or minimised window has its timers throttled by the OS, which from
inside the page is indistinguishable from a freeze.

**What it cannot tell you** is which function was responsible. While the thread
is blocked no JavaScript runs, so there is nothing to sample from — this is a
property of the platform, not a gap in the implementation. What the report gives
you is the gesture that preceded the freeze, which is the part users can never
describe and the part you need to reproduce it. Take it to `sample` from there.

### Activity context

`src/utils/debug/heartbeatContext.ts` records what the user was doing, so a
stall report is more than a number. It listens to two signals the app already
emits — `app-hotkey-keydown` and `pointerdown` — and wires nothing at any call
site.

To have a slow subsystem name itself, call `noteActivity` immediately before the
expensive work:

```ts
import { noteActivity } from '@/utils/debug/heartbeatContext';

noteActivity('island-scan:contour-markers');
```

The label is truncated to 80 characters and becomes the `activity:` field of the
next stall report. Use a stable, greppable name; do not interpolate user data
into it. Only the most recent call is kept, so put it at the start of a phase
rather than inside a loop.

The same rule applies to the element description recorded on `pointerdown`: only
`data-testid`, `aria-label` and `title` are read, never text content, which would
carry users' model and file names into a log they are about to email you.

### The 16 GB ceiling, and the watchdog

WebKit gives each content process a hard memory limit — 16 GB on macOS — and
kills it when it cannot shrink below it. This is not system memory pressure and
not jetsam: WebKit does it to itself, and it logs the whole thing through the
app process:

```
Current memory footprint: 27351 MB
Process is above the memory kill threshold. Trying to shrink down.
New memory footprint: 16630 MB
Unable to shrink memory footprint of process (16630 MB) below the kill thresold (16384 MB). Killed
```

The app process survives, so the window stays open and grey with nothing to
explain it. To confirm this is what happened:

```bash
log show --last 10m --predicate 'eventMessage CONTAINS[c] "memory kill threshold"' --style compact
```

WebKit dumps its own counters as it dies — `javascript_gc_object_count` is
usually the one that names the culprit; a scan that kept one object per contact
voxel showed 99,593,201 live objects there. `vmmap -summary <pid>` on a running
process gives the same picture earlier: look at *WebKit Malloc* and at
*Physical footprint (peak)*, which remembers the spike long after the heap has
settled.

`webview_watchdog.rs` and `webviewHeartbeat.ts` handle the aftermath. The
webview pings the native side every five seconds; ninety seconds of silence
means the process is presumed dead and the user is offered a reload.

Recovery is deliberately **not** automatic. Silence from a blocked main thread
and silence from a dead process look identical from the native side, and
reloading a merely busy webview would throw away the user's scene. A webview
that catches up and pings again re-arms the watchdog and nothing happens.

### Startup header

Written once per run, in two halves, each on the side that has the information.
Rust logs what the process knows, from `log_startup_header()` in `main.rs`:

```
[header] DragonFruit 0.1.13 (debug=false) os=macos arch=aarch64 cores=12 log_level=INFO
```

The webview logs what only it can see, from `src/utils/debug/startupHeader.ts`:
GPU string, viewport, screen size and device pixel ratio.

Without a header every report floats in a vacuum: a 12-second freeze means
nothing until you know whether it happened on an M4 Max or a 2017 iMac.

!!! warning "Nothing may be logged before `setup()`"
    `tauri-plugin-log` attaches the `log` facade during its own plugin setup.
    Any `log::info!` emitted earlier in `main()` is silently dropped — it does
    not reach the file, or stdout, or anywhere. This is why the header is
    emitted from inside `setup()`.

### Asking a user for a report

The plumbing already exists and needs no new UI: Settings has a log level
selector that applies without restarting, a live log viewer, and buttons to
reveal or open the log file. Ask the user to set the level to `debug`, reproduce
the problem, and send `dragonfruit.log`.

## Measuring without lying to yourself

Every one of these cost a wasted test cycle before it was understood.

**`console.log` from the webview never reaches `dragonfruit.log`.** `attachConsole`
mirrors Rust records *into* the webview console; nothing travels the other way.
Measurements meant for a log file must go through `@tauri-apps/plugin-log`.

**`Physical footprint (peak)` is reset** when WebKit relieves memory pressure, so
reading it with `vmmap` after the fact reports a peak lower than the real one —
in one case 7.2 GB against an actual 14.0 GB. Sample continuously during the
run instead, and note that `vmmap` on a multi-gigabyte process takes long enough
that a "once per second" loop really samples every two.

**A late timer is not a blocked thread.** WebKit aligns and throttles timers when
the window loses focus. One session logged 959 stalls that a `sample` showed to
be an idle process. Corroborate with the animation frame clock, which is not
aligned, and treat gaps beyond a minute as the machine sleeping.

**Yielding with a timer stops working in the background**, throttled to about
1 Hz, which turns eighty yields per pass into eighty seconds. A message channel is a macrotask
that is not a timer and is not throttled, which is what the shared yield helper
in the island scan uses.

**Yielding is cheap; telling React is not.** A progress report is a state update
that re-renders a tree with the 3D scene in it. Reporting on every yield added
roughly twenty seconds to a forty-second scan. Yield as often as the work needs;
report at a human rate.

**Two detectors will find each other.** `RendererCrashDiagnostics` patches
`console.warn` and `console.error` to collect breadcrumbs, and `attachConsole`
feeds it every Rust log record. Anything logged from a hot path arrives there
too. Check what already exists before adding an instrument.

**`wgpu_hal` is filtered off, on purpose.** The Vulkan loader hands wgpu every
implicit layer on the machine, and a third-party overlay whose manifest is missing
or whose layer breaks the loader's naming policy is reported as an ERROR on the
instance we asked for (Epic's EOS layer, Samsung's Galaxy overlay, Overwolf's OBS
hook). Those records are mirrored into the webview console by the log plugin and
read as application crashes, so `src-tauri/src/main.rs` sets
`.level_for("wgpu_hal", log::LevelFilter::Off)`. Nothing from wgpu reaches the log
unless you raise that line — do it while diagnosing an adapter or device problem,
then put it back. The AO path's own failures come from `dragonfruit-ao-gpu` and
`ao_vertex.rs`, which log under `dragonfruit_desktop`.

**`structuredClone` costs ~10 µs per call whatever the size.** A support snapshot
is thousands of small records, so a whole-state `structuredClone` pays that fixed
cost per entity: ~57 ms for a 9,000-entity scene against ~20 ms for
`clonePlainData` (`src/utils/plainDataClone.ts`), which walks plain records and
keeps object identity. Use it for state snapshots and payload copies. Keep
`structuredClone` where a payload may hold typed arrays or other non-plain values
and is small enough that the fixed cost does not matter — the history store's own
payload clone, for instance.

**One store write per copy is not free either.** Every `setSnapshot` rebuilds the
support store's whole index, so cloning N models one paste call at a time costs N
rebuilds. `pasteModelSupports` takes every target of one gesture and merges them
into a single write. `npm run bench:duplicate-confirm` measures the duplicate
confirm end to end; `MODELS`, `SUPPORTS`, `DUPS` and `RUNS` override its scenario.

**One pointer move raycasts every object with a hover handler.** R3F calls
`raycaster.intersectObject` for each object that registers a pointer-move
handler — its event system filters the scene's interaction list down to those —
so the cost of a hover is the sum over those objects, not the one under the
cursor. Two shapes dominate, both measured with the app's own three.js:

| object | cost per pointer move |
| --- | --- |
| `InstancedMesh` with N instances (proxy supports) | ~0.11 µs × N — 3 ms at 25k, 13 ms at 100k |
| merged `Mesh` of T triangles with no `boundsTree` (raft proxy) | ~0.35 µs × T — 7 ms for 20×5k, 50 ms for 20×20k |
| the same mesh with a `boundsTree` | ~0.12 ms, flat |

`InstancedMesh.raycast` loops every instance once the mesh's whole bounding
sphere is hit, and a support batch spans the plate, so any ray over the plate
pays for all of it. three-mesh-bvh cannot accelerate it. A batch that must
answer hover therefore needs a `raycast` of its own: the shaft batch indexes its
instances into cells and tests only the cells the ray crosses
(`src/supports/proxyHoverIndex.ts`), built inside `InstancedShaftGroup` from the
list that mesh draws, since a target's `index` is the instance index the event
reports and a batch that filters its input — zero-length shafts are not drawn —
would otherwise shift every index against the drawn list. Give raycast-only
merged geometries a bounds tree.

**A grid belongs to a mesh, not to a kind of primitive.** The shafts, roots,
joints and cones are drawn by four different components, and three of them split
their instances into buckets by geometry parameters — hundreds of small meshes,
some holding a single instance. Handing one whole-kind grid to those groups means
every bucket asks the *whole* grid: measured on an 18-model plate, 448 meshes per
pointer move, 157k segment tests and 35 ms, against 2 meshes, 727 tests and 14 ms
with three's own raycast on the buckets. The index in a target is also the index
inside the batch the grid was built from, which a bucket's `instanceId` is not.
Grids go to the batch that spans the plate and is 1:1 with its instances; a small
bucket is better off with three's own raycast.

**A colour change is per model, so write it per model.** The proxy batches tint
by writing per-instance colours, and a selection or a hover moves the colour of
one or two models. Rewriting every instance and re-uploading the whole buffer
made a hover that moves between models cost ~70 ms in a development build, with
~18% of it in the colour pass — mostly `Color.toArray` inside `setColorAt`, run
once per instance per bucket. `writeInstanceColors`
(`src/supports/SupportPrimitives/instanceColorWriter.ts`) groups a batch by model
once, compares the resolved colour per model, and writes only the instances of
the models that moved.

**The observer is a suspect.** In one session the Web Inspector killed the
process, editing the worktree restarted the app under a running test, the stall
detector invented hundreds of freezes, and the progress reporting doubled the
runtime. When a measurement surprises you, question the instrument before the
code.

## External profilers

### Windows: drive the app over CDP

WebView2 takes `--remote-debugging-port`, so the real app — with its Tauri
commands, its own file loading and a real GPU — can be driven and profiled from a
script. No Playwright install: `npm run profile:df` talks CDP over Node's built-in
`WebSocket`.

```bash
npm run dev                                              # the debug exe loads localhost:3005
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 \
  src-tauri/target/debug/dragonfruit-desktop.exe path/to/scene.voxl
```

```bash
npm run profile:df -- eval "document.title"
npm run profile:df -- hover 0.58 0.5 40          # 40 trusted moves, profiled
npm run profile:df -- sweep 0 0 60 '[[0.25,0.5],[0.583,0.5]]'   # between two models
npm run profile:df -- click 0.35 0.6
npm run profile:df -- clickdom 'button[aria-label="Hide"]' 0    # click UI by selector
npm run profile:df -- scan 6 5                   # which screen cells hit a model
npm run profile:df -- shot out.png 0.35 0.6      # screenshot, pointer parked there
npm run profile:df -- fps 4 [move]               # frames per second, pointer still or moving
npm run profile:df -- drag 0.5 0.6 0.5 0.4 right # right-drag orbits, middle pans
npm run profile:df -- zoom 0.4 0.6 8 -120        # wheel at a point
CDP_FILTER=raycast npm run profile:df -- hover 0.58 0.5 60
```

Draw calls and triangles per frame are not reachable through the app's own
objects, but they are through the context: patch
`drawElements` / `drawElementsInstanced` on the canvas's WebGL prototype from
`eval` and sample for a second. That is how the 3282 draw calls behind a 53 fps
frame were found (see `docs/dev/backlog.md`).

`CDP_STACK=<regex>` prints the ancestry of the hottest frame matching it, which is
how a 19-second stall was traced to the raft clustering rather than the supports
that looked responsible. When a frame's *caller* is what you need and the profile
cannot name it — a memo body, a closure — write a counter or a stack into a global
from the code under suspicion and read it back with `eval`:

```js
const g = globalThis; (g.__calls ??= []).push(new Error().stack);
```

That is a temporary edit, and it must be reverted before committing.

Input goes through CDP, so it is trusted and the app's handlers run; the profile
covers the React commits and R3F renders that follow the gesture, not just the
handler. Two things it taught, worth knowing before trusting a number: a gesture
that lands on the *same* model every time never changes the hover state, so it
measures the raycast and nothing else — `sweep` between two models to see the
colour path; and the development build's `jsxDEV`, `measure` and React element
churn dominate any profile that re-renders the scene, so compare two runs of the
same build rather than reading absolute milliseconds.

`scan` prints what a cell resolves to, which is how you find a point over a model
without guessing the camera: hover a grid and read back
`window.__dragonfruitLastImmediateModelHoverId`.

**Sandbox the instance. Do not drive the user's window.** The app takes a scene
path as an argument and hands it to an already-running instance through
`tauri-plugin-single-instance`, so launching a second copy while the user has one
open loads the file *into their window* — and, without an isolated profile, the
scene they already had stays loaded, so the two accumulate. Every launch must:

```bash
mkdir -p "$TMP/df-sandbox/webview"
cp scene.voxl "$TMP/df-sandbox/scene.voxl"     # sidecar autosaves stay out of the way
WEBVIEW2_USER_DATA_FOLDER="$TMP\df-sandbox\webview" \
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" \
  src-tauri/target/debug/dragonfruit-desktop.exe "$TMP/df-sandbox/scene.voxl"
```

The separate user-data folder isolates localStorage, so nothing of theirs is
restored into the sandbox. **Delete the copy's autosave sidecar before every
launch.** The app autosaves next to the scene it opened, so a sandbox scene copy
grows a `<name>_autosave.voxl`; the next launch restores *that* and then loads the
CLI argument on top, and the scene quietly doubles - 17 models became 34, twice,
before the sidecar was noticed. Check that no instance is running before launching,
and when shutting down kill only the PID you started — never every
`dragonfruit-desktop.exe` on the machine. The log file is shared and cannot be
redirected, so the sandbox's lines land in the user's log.

### macOS: `sample` and flame graphs

The heavy lifting happens in the WebKit content process, not in the app process.
Find it and sample it:

```bash
ps -Ao pid,ppid,%cpu,command | grep 'WebKit.WebContent' | grep -v grep
```

```bash
sample <pid> 60 -file /tmp/df-$(date +%H%M%S).txt
```

`-file` truncates the path it is given, so vary the name if you want to keep
successive captures. For a flame graph:

```bash
~/FlameGraph/stackcollapse-sample.awk /tmp/df-*.txt | ~/FlameGraph/flamegraph.pl > /tmp/df.svg
```

Note that `sample` aggregates: you get totals, not a timeline. Take one capture
per phase if you need the sequence.

!!! warning "JIT frames are not symbolicated"
    Application JavaScript appears as `???  (in <unknown binary>)`. Neither
    `sample` nor Instruments can symbolicate JavaScriptCore's JIT output. These
    tools tell you *where in WebKit* you are — event dispatch, GC, compositing —
    not which of your functions is responsible. For that, use the Web Inspector
    profiler, or profile the plain web build in Chrome.

### Reading a WebKit sample

Some stacks that come up repeatedly and what they mean:

| Stack | Meaning |
|---|---|
| `mouseEvent` → `dispatchMouseEvent` → `performMicrotaskCheckpoint` | Work in a promise continuation after a click — typically a React state flush, not the handler itself |
| `timerFired` → `WindowEventLoop` → `Worker::dispatchEvent` | The main thread processing worker messages. Work is *off* the worker but still blocking the UI |
| `updateRendering` → `WebGLRenderingContextBase::prepareForDisplay` → `waitForSyncReply` | Blocked on synchronous IPC to the GPU process. Fixed per-frame cost of WKWebView; a scene rendering when nothing moves pays it for nothing |
| `operationMapHash` + `JSRopeString::resolveRope` + `IsoInlinedHeapCellType<JSRopeString>::finishSweep` | `Map`/`Set` keyed by concatenated strings. The GC cost of the temporary keys is often as large as the lookups |

That last row is worth internalising. Building keys with template literals is
idiomatic and looks harmless, but in a hot loop it allocates a rope string per
lookup, and the sweep shows up as a third of total time. Numeric keys cost
nothing to hash and allocate nothing.

### Web Inspector and Chrome

For JavaScript with real function names, bracket the operation from the console
rather than recording everything:

```javascript
console.profile('place-support'); /* do the thing */ console.profileEnd('place-support');
```

This works in both Safari's Web Inspector, attached to the real WKWebView, and
in Chrome against `npm run dev`. Chrome has the better flame chart and exports a
`.cpuprofile` that `npx speedscope` opens, but it will not reproduce anything
WKWebView-specific.

## Known gaps

**A hung Rust command is invisible to the stall detector.** `invoke` is
asynchronous: it posts a message and returns a promise. If a command never
returns, the promise never settles, the main thread stays free, and the
heartbeat says nothing — the UI is responsive and the feature is simply dead.
Nothing currently watches for invokes that never come back.

**Large payloads returned from Rust can stall the main thread**, on the return
path rather than the call. Deserialising a large result happens on the webview's
main thread and is charged to whatever happens to be running.

**Only instrumented phases are named.** Everything else shows up as a stall with
whatever `pointerdown` happened to be last.
