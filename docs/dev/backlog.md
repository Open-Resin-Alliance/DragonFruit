# Backlog and Known Gotchas

A home for temporary rules, tradeoffs, gotchas, and desired architectural
directions that `AGENTS.md` references tersely. When `AGENTS.md` points here,
this page is the fleshed-out explanation. Add entries here when a rule is too
long for `AGENTS.md`, is expected to be lifted once an upstream change lands,
or is a known refactor we intend to do.

## Lingui + React Compiler: interpolating translations

**Do not** add interpolating `msg` translations inline inside a React component
or hook:

```ts
msg`${minutes} minutes`;   // ❌ inside a component/hook
```

React Compiler renames the interpolated locals in production builds
(`minutes` → `minutes_2`), which desyncs the message id from the compiled
catalog — production then renders the placeholder raw (`{minutes_2}`). Dev looks
fine and hides the bug.

**Rule:** translations that interpolate values live in **module-scope helper
functions** (e.g. the duration formatters in `src/app/page.tsx`), which React
Compiler leaves untouched.

**Temporary until:** Lingui moves to a Babel macro ordered before React Compiler.

## In progress: make the support system registry-driven

`src/supports/supportTypeRegistry.ts` **exists** and is load-bearing: one
descriptor per type, and every "for each support type / collection" walk derives
from it. `SupportState`'s collections, the modelId and shafted walks, root
ownership, the updater and knot-diameter slots, and several behaviour decisions
that used to be hardcoded type names now come from there.

**Adoption is partway.** Measured by `npm run scan:support-types`: **7,052
hand-written type references across 147 files**, down from 12,164. History
handlers, registration slots, the support primitives, the clipboard, geometry
export and most of `state.ts` are converted; auto-placement (769) and
`SupportRenderer.tsx` (663) remain the two largest holdouts. Adding a type is
therefore still partly manual — see `dev/support-type-extension.md`, which marks
each step.

**Remaining goal:** move the rest of the per-type threading behind the registry,
so the renderer, interaction manager and export derive their behaviour rather
than enumerating types. Deliberately out of scope for the registry itself:
renderers, builders and placement logic. It describes what a type IS, not how it
draws — putting behaviour in it turns a mechanical refactor into a rewrite.

**Do not do this refactor while adding a support type.** Still true, and still
the point: converting a hand-wired path and adding a new type at once means a
behaviour change and a migration land in the same diff, and neither can be
reviewed or bisected cleanly. Add the type through the current hand-wired path,
then convert separately. Registry work should land on its own with no behaviour
change.

**The rule that matters.** When code needs type-specific behaviour, derive it
from the registry or declare it as a descriptor property. Never subtract
(`.filter(id => id !== 'trunk')`): a new type silently joins or skips the set,
which is the exact failure the registry exists to prevent.

Known remaining hand-written lists worth converting:

- (none outstanding here; see `support-registry-findings.md` for the open items)

### Bugs found while converting

Converting each hand-written type list turned up defects where the list
disagreed with the registry. They are recorded in
[`support-registry-findings.md`](support-registry-findings.md) -- 89 findings,
27 still open -- rather than here, because they are per-site detail rather than
rules to follow.

The rule they add up to is the one above: derive, never subtract. Two were
invisible to the whole suite AND all 22 goldens, so passing tests are not
evidence a flag is covered -- see AGENTS.md trap 4.

## Desired: route every native call through the IPC bridge

`src/features/slicing/tauri/nativeSlicerBridge.ts` is documented as the seam for
Tauri commands (`dev/tauri-ipc-bridge.md`), and it is where new wrappers belong.
It is not yet the only path: 84 direct `invoke(...)` call sites live in 29 other
modules, nine of them React components, reaching ~70 of the 107 native commands.

**Why it matters:** the command name is a plain string on the TS side, so nothing
type-checks it against Rust. Centralizing the calls is what would make a single
rename verifiable instead of a grep-and-pray.

**Goal:** every native command reached through a named wrapper, so the bridge is
the full inventory of the contract and a boundary check (in the style of
`scripts/check-plugin-boundaries.mjs`) can enforce it.

Do not attempt the migration as part of unrelated work — move a call site into
the bridge when you are already editing it, and leave the rest. The bulk move is
its own change, with no behavior difference.

## Desired: native twin optimization plan

A roadmap note, not a current runtime contract — previously
`dev/native-twin-optimization-plan.md`.

**Goal:** move toward a native scene twin in Rust so the frontend can send small
state diffs instead of repeatedly staging large geometry buffers during slicing
and export.

**Key constraints:** support editing in the frontend must stay smooth; support
fidelity must remain exact; the work should land after the stable beta path is
complete.

**Architecture direction:** frontend owns live interaction and preview; backend
owns canonical slice-ready state; model assets are loaded by identity rather
than resent repeatedly; support changes are transmitted as graph diffs with
stable IDs and resolved coordinates.

**Success criteria:** less bulk geometry IPC; better support-heavy export
performance; revision parity between frontend and twin before slicing/export.

## Import post-processing: what still blocks a scene load

A scene load pays these per model, synchronously, in `processGeometry`
(`src/hooks/useStlGeometry.ts`) — measured with
`npm run bench:import-postprocess` on a 500k-triangle non-indexed soup
(~1.5M vertices, the shape a VOXL-embedded mesh has):

| Phase                       | Cost     | Needed for                       |
| --------------------------- | -------- | -------------------------------- |
| `EdgesGeometry(30)` overlay | ~2139 ms | optional, default-off overlay    |
| flattening planes           | ~98 ms   | Place on Face                    |
| `computeVertexNormals`      | ~43 ms   | rendering                        |
| `computeBoundingBox`        | ~13 ms   | everything                       |
| BVH (`accelerateGeometry`)  | ~120 ms  | support placement raycasts       |

The overlay geometry is the whole problem: ~93% of the phase, and three times
larger than everything else combined. It is off by default, so it is now built
**only when the user has the overlay enabled** — `buildModelEdgeGeometry()` is
the single gate, called from `processGeometry` for imports (with the import
progress UI up, so the cost is where a load's cost belongs), from
`replaceModelGeometry` for geometry swaps, from the Split Supports path, and
from the scene's settings effect for models that were loaded while the setting
was off (one model per idle callback, cached on the geometry so it is built
exactly once).

Do not move this build off the import path into the overlay component: it
measured *worse*, not better — six 500k-triangle models went from one import
stall to 6 × ~1.9 s of post-load main-thread blocking (18 s of long tasks in a
browser profile, versus 5.5 s), because each model's `StlMesh` re-paid it on
mount and there is no shared cache at that layer.

**What remains, in value order:**

- **The overlay build itself (~1.9 s per 500k-triangle model) is unavoidable
  main-thread work while the setting is on.** It is the only remaining
  multi-second op in the load path; a worker (the repo already runs workers for
  the 3MF loader) is the way to remove it, and would let the overlay be enabled
  without any import penalty.
- **BVH + flattening planes are still synchronous on the import path.** Both are
  already deferrable: `finalizeModelGeometryPostProcessing` in
  `src/features/scene/useSceneCollectionManager.ts` runs exactly these two in
  idle callbacks for geometry swaps, and `hasPendingBackgroundGeometryWork()`
  reports when that queue is still draining, so the UI can stay honest. Routing
  imports through the same seam would remove ~220 ms/model and shrink the
  "import finished" to "app responsive" gap.
- **VOXL original-mesh sidecars are resolved on the import path.** When a VOXL
  has no embedded `ORIG` chunk, `resolveOriginalRefSidecar` falls back to the
  model's on-disk `sourcePath` and `readSidecarFileBytes` fetches it. For a
  source that has moved or been re-exported (the common case after a repair
  round-trip) that is a real network attempt per model that can only 404 — noisy
  and awaited, though harmless (the loader falls back to the embedded preview).
