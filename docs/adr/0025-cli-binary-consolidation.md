---
issue: cli-consolidation
date: 2026-07-24
kind: decision
status: proposed
---

# ADR-0025: CLI binary consolidation — disposition of eight entry points

DragonFruit has eight CLI entry points, none referenced by any workflow, npm script or
bundle config. This records what each one uniquely does and what happens to it.

Compared by **artifacts produced**, not commands offered. An earlier draft claimed
`island_scan_cli` "overlaps `island full` almost exactly"; that was false — they share two
files out of eight.

## The load-bearing discovery

`island_harness` + `island_diff` (952 of the 1640 lines) are **not** disposable dev scrap.
They are a TS↔Rust conformance pair, and the TS implementation is **still live**:
`src/volumeAnalysis/IslandScan/` contains `ScanOrchestrator.ts`, `islandTracker.ts`,
`rle.ts`, `components.ts` and `nativeIslandScan.ts` — a full second implementation of island
detection, selectable against the Rust one. `island_harness` runs the Rust side over golden
fixtures; `island_diff` semantically compares the two outputs layer by layer.

They are the only thing checking that the two implementations agree.

**The TS path is live, verified 2026-07-24.** Retirement was considered and is blocked on this
evidence: `useIslandManager` is a value import in `src/app/page.tsx` and
`src/components/controls/IslandScanCard.tsx`; `ScanOrchestrator.ts` instantiates
`islandScan.worker.ts` and `scanlineScan.worker.ts`; `Islands/detect.ts` spawns a third
worker. Only `ScanResults` and the `VOXEL_OFFSET_*` constants are imported as types. This is
wired into production UI, not dead code behind a native-only switch.

**They cannot run.** Both read `fixtures/island-scan/<case>/`, and `/fixtures/` is
gitignored and untracked — developer-local data on one machine
(`two-cubes` is the only case present). So the conformance guarantee has been unenforced for
as long as the fixtures have been untracked.

That is the real defect here. Retiring these two would delete the safety net for a live
dual-implementation invariant; keeping them as-is preserves a guarantee nothing verifies.

## Disposition

| Binary | Lines | Uses shared service | Unique artifacts | Disposition |
|---|---|---|---|---|
| `island_scan_cli` | 240 | yes — `run_island_scan` | `params.json`, `positions.bin`, `layer_pixels.txt`, `summary.txt` | **Fold, then retire.** Its approach is what `dragonfruit-cli island full` adopts in step 3. Retire once `island full` covers STL→islands with an equivalent dump. |
| `island_ipc_debug` | 188 | yes — `run_island_scan` | replays `/tmp/dragonfruit-island-debug/` written by `run_island_scan_native` | **Keep, fold as `island replay`.** Uniquely reproduces a GUI-produced dump offline. Nothing else does this. |
| `island_stl_bench` | 137 | yes | none (stdout timings) | **Retire** once `island bench` routes through the service. |
| `island_bench` | 123 | yes | none (stdout timings) | **Retire**, or fold as `island bench --synthetic` — it benchmarks in-memory masks with no STL. |
| `island_harness` | 501 | partly — also calls `scan_layer` directly | `layers/NNN-{mask,candidates,components,island-labels}`, `result.json` under `rust-output/` | **Keep, convert to a test.** See below. |
| `island_diff` | 451 | n/a — comparator | diff report to stdout | **Keep, convert to a test.** Pairs with the harness. |
| `dragonfruit-cli` | ~1650 | no — hand-rolls it | per-layer RLE + tracker snapshots + `islands.json` | **Survivor.** Routed onto the shared service in step 3. |
| `dragonfruit-ts-cli.ts` | 1522 | n/a — VOXL scene/support | `.voxl` scene state | **Keep** as a dev-only tsx script (decided 2026-07-23). |

Net: 1640 lines of islands binaries become roughly 690 kept (harness + diff, converted) plus
one folded capability (`island replay`), with ~500 retired.

## Consequences

1. **The conformance pair becomes a real test, not a binary.** Convert `island_harness` and
   `island_diff` into an integration test with **committed** fixtures, so TS↔Rust equivalence
   is checked on every PR instead of never. This is the highest-value outcome of the audit and
   was not in the plan when it was approved — absorbed into phase 1 by decision on 2026-07-24.
   **Decision confirmed 2026-07-27: keep the check.** Retirement of the pair was considered and
   rejected — the TS island path is live (evidence above), so deleting the harness/diff pair
   would remove the only verification of an invariant production code depends on. The pair is
   converted, not retired.
2. **`island_replay` must survive in some form.** It is the only offline reproducer for a
   GUI-side island scan, which makes it the tool of choice when a user reports a bad scan.
3. **Retirement is gated on artifacts.** No binary is deleted until a test shows its unique
   output is reproducible from `dragonfruit-cli`. `island_stl_bench` and `island_bench`
   produce no artifacts, so their gate is timing parity only.
4. **`island_scan_cli` is written to harness standards, not shipped standards** — line 20 is
   `fs::read(path).expect("Failed to read STL file")`. Under `src-tauri`'s `panic = "abort"`
   that becomes SIGABRT. Its logic folds in; its error handling does not.

## See also

- ADR-0014 (RLE island detection) and ADR-0016 (IPC boundary) — both remain in the
  external knowledge base; not imported.
- [Tauri IPC and Native Bridge](../dev/tauri-ipc-bridge.md) — the in-repo account of
  the boundary `island_ipc_debug` replays.

---

_Imported from the external knowledge base on 2026-08-18. Every claim above was
re-checked against the tree: the six binaries, the live TypeScript island path,
the untracked `/fixtures/` and the absent conformance test are all still as
described. Pinned line numbers were replaced with symbol names and two links to
un-imported records were flattened; nothing else was altered._
