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

**The observer is a suspect.** In one session the Web Inspector killed the
process, editing the worktree restarted the app under a running test, the stall
detector invented hundreds of freezes, and the progress reporting doubled the
runtime. When a measurement surprises you, question the instrument before the
code.

## External profilers

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
