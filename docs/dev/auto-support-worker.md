# Auto-Support Worker

Auto-placement is seconds of synchronous work on a model that needs a few
hundred supports, and it used to run on the main thread: the window stopped
painting (the stall detector in `src/utils/debug/mainThreadHeartbeat.ts` logs
those blocks), and every control was dead until it finished. The run now
happens on a worker thread.

## What it is

Three modules, one protocol:

| File | Role |
|---|---|
| `src/supports/autoSupport/autoPlace.worker.shared.ts` | The wire types, the mesh/island serializers, and `runAutoPlaceRequest`, the worker's body |
| `src/supports/autoSupport/autoPlace.worker.ts` | The shell: `onmessage` → `runAutoPlaceRequest` → `postMessage` |
| `src/supports/autoSupport/autoPlaceWorkerClient.ts` | `runAutoPlaceInWorker`, which builds the payload, drives the worker and commits the plan |

The body lives in the shared module rather than in the shell so it can be
called in-process. That is what makes the equivalence test possible: importing
the shell in Node would evaluate `self.onmessage`.

## Usage

```ts
import { runAutoPlaceInWorker } from '@/supports/autoSupport/autoPlaceWorkerClient';

const result = await runAutoPlaceInWorker(islands, modelId, getSettings().autoSupport);
```

It returns the same `AutoPlaceResult` as `runAutoPlace` and commits the same
thing: one `setSnapshot` and one undoable history entry, through
`commitAutoPlacePlan`. With no `Worker` in the environment (tests, plain
browser) it falls back to the in-process run, so callers never branch on which
path they got.

## The seeding contract

`computeAutoSupportPlan` is pure with respect to the stores it *writes* (one
commit at the end, see [Auto-Supports](auto-supports.md)), but it still reads
three pieces of module state:

- the settings store, through `getSettings()` (21 call sites across the
  pipeline, including the registry's placement thresholds),
- the support snapshot, through `getSnapshot()` (the gap-fill coverage pass),
- the model mesh, through `getModelMesh()` and the brace clearance store.

A worker thread has its own copies of all three, so every run seeds them from
the payload first, in `seedAutoPlaceEnvironment`. **A new read of module state
inside the plan must be seeded here too**, or the worker will quietly place
different supports than the main thread. `__tests__/autoPlaceWorker.test.ts`
pins the equality (support state, analytics and placement counts) so that
mistake fails a test instead of shipping.

Two details that are not obvious:

- **The mesh carries its normals.** three's raycast takes `face.normal` from
  the geometry's `normal` attribute when it is present and computes it from the
  positions when it is not, and the two disagree in the eighth decimal. The
  plan stores those normals on contact cones, so dropping the attribute makes a
  worker run differ from an in-process one in the last digits. `normals` is
  part of the wire format for that reason.
- **The mesh is registered for brace clearance.** `linePassesMeshClearance`
  allows a brace when no mesh is registered for the model id, with a one-time
  warning, so a worker without the mesh would cheerfully brace through the
  model. `seedAutoPlaceEnvironment` registers it.

## Cost and caching

- The mesh is copied onto the wire, never transferred: the main thread keeps
  rendering from the same buffers. The client caches the serialized form by
  `modelMeshKey` (geometry uuid, attribute versions, pose) and the worker caches
  the rebuilt mesh, so a repeat run pays neither the copy nor the BVH build.
- Building the BVH in the worker measured **~210 ms at 500k triangles**, which
  is why the rebuild is cached rather than per-run.
- Islands serialize as plain points and typed arrays. `structuredClone` drops
  prototypes, so `island.contact` arrives as a plain `{x,y,z}`; the plan only
  reads those fields. The test asserts that too, so a future method call on the
  contact fails loudly.

## Constraints

- **No module-scope DOM access anywhere in the worker's import graph.** The
  worker evaluates its whole graph before it can receive a request, and a worker
  realm has no `window`. One debug helper that installed `window.__dfPerf` at
  import time was enough to kill the worker silently: the request was never
  answered and the app sat on "Generating Supports" with nothing happening. It
  only reproduced under the dev server, whose worker shim throws on DOM access
  precisely to catch this, so a production build would have hidden it.
  `__tests__/autoPlaceWorkerClosure.test.ts` walks the graph from the worker
  entry and fails on any module-scope side effect that is not in its allowlist
  with a reason; `installPerfConsoleAPI` is now called from the app root
  (`page.tsx`) instead of from `pathfindingPerf` itself.
- The worker body must stay DOM-free at *runtime* too, and the obvious guard is
  wrong in a way that hides itself. The dev server's worker realm **defines**
  `window` as an object whose *property access* throws
  `ReferenceError: window is not defined` (a trap for DOM use in a worker), so:

  | check | dev worker | real DOM |
  |---|---|---|
  | `typeof window === 'undefined'` | `false` — the guard lets you through | `false` |
  | `window.document` | **throws** | fine |

  Both worker failures came from that first row: `installPerfConsoleAPI` at
  module scope got past its `typeof` guard and died on the next line, then
  `setSnapshot` → `emitSupportInteractionReset` did the same inside the run.
  Use `hasWindow()` from `@/utils/dom`, which reads a property inside a `try`;
  every `typeof window` in the worker's import closure goes through it.
  `__tests__/autoPlaceWorker.test.ts` runs the whole plan, bracing included, in
  both realms (no `window`, and the trapping one) and asserts the placement is
  unchanged, so a new DOM reach fails a test rather than the app.
- The worker is long-lived and per-app, not per-run: it keeps the last mesh and
  the last environment. It owns no state that must survive a model switch,
  because every run re-seeds.
- A run that is cancelled or that throws leaves nothing behind: the plan
  commits nothing until the end, and the client's fallback path is the same
  function the main thread uses.
- The worker acks the request (`{type:'started'}`) before planning, and the
  client gives up if no ack arrives within
  `AUTO_PLACE_WORKER_STARTUP_TIMEOUT_MS` (10 s). Without it, a worker that died
  loading its graph left the caller waiting forever. The plan blocks its own
  thread, so a heartbeat from *inside* the run is impossible without progress
  callbacks in the pipeline: a worker that dies mid-run is still
  indistinguishable from a slow one, and the timeout deliberately does not cover
  that.
- **A worker failure falls back to the in-process run**, loudly and one-way:
  `runAutoPlaceInWorker` logs the failure (with the worker's own stack, which is
  what names the module) and retries on the main thread, and the client retires
  the worker for the rest of the session so a broken one cannot quietly become
  the normal path. The worker is an optimisation, so a run that blocks the UI
  for a while beats a run that does nothing. `resetAutoPlaceWorker()` puts it
  back.

## Not done yet

- **Progress and cancel.** The run is off-thread, but the modal that covers the
  UI is still indeterminate ("Elapsed: …") and has no cancel button, so the
  *perceived* freeze only goes away once a percentage (or a ticking elapsed
  counter) and a cancel action are wired. A cancel is safe by construction:
  terminate the worker, reject the pending request, and the store is untouched.
- **A failed run is only reported in the console.** The panel logs the error and
  the busy overlay clears, but nothing in the UI says the run failed, so a
  failure still looks like "it did nothing". A toast needs a new message
  string and a callback into the panel; the startup timeout's message is
  written to be actionable in the meantime.
- The remaining placement cost profile, and why a worker comes before any Rust
  port, is in [Backlog and Known Gotchas](backlog.md) under
  "computeAutoSupportPlan is superlinear in support count".

## Related pages

- [Auto-Supports](auto-supports.md) — the pipeline this runs
- [State and Stores](state-and-stores.md) — the stores that get seeded
- [Performance Debugging](performance-debugging.md) — the stall detector, and
  how to profile the run
