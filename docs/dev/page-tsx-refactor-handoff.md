# `src/app/page.tsx` refactor — handoff

## TL;DR

`src/app/page.tsx` was a single 23,133-line file with one ~21,600-line `Home()`
component. It has been decomposed into an atomic-design component tree plus
feature "manager hooks", and is now **9,696 lines** (−58%). All work landed on
`refactor/page-tsx`, each commit verified `tsc --noEmit`-clean (the only standing
errors are 8 pre-existing test-fixture type errors in `src/supports/__tests__/`,
unrelated to this work) and the final build passing.

> **Update (2026-07-12):** branch `refactor/page-tsx-sync` merged **all of `dev`**
> (228 commits, six staged merges — see *Dev-sync addendum* at the bottom).
> `page.tsx` is now **10,033 lines** (dev's page.tsx grew to 23,459 in the same
> period, so still −57%). Line numbers and hook counts below were refreshed to the
> post-sync state. The accidental pnpm-migration sweep was reverted (`4f271c24`);
> all commands in this doc are npm again.

This document explains **what's left in `page.tsx`**, why, and how to continue.

---

## Current architecture

`Home()` (lines ~495–10033) is now an **orchestrator**:

1. **Manager-hook calls** in dependency order (with a few `deps`-refs for the
   coupled ones — see *Patterns* below; line numbers as of the 2026-07-12 sync):

   | Hook | line | owns |
   |---|---|---|
   | `useSceneCollectionManager` | 498 | models, geometry, mode, import |
   | `useTransformManager` | 519 | gizmo transform state |
   | `useHollowingManager` | 543 (deps-ref 525) | hollowing/shell/voxel-edit |
   | `useEditorToasts` | 825 | all toasts incl. monitor error toast |
   | `usePrintingPreviewManager` | 933 (deps-ref 870) | layer scrub/zoom/pan |
   | `useImportExportManager` | 1222 (deps-ref, populated 6372) | file/drag-drop/handoff/thumbnail |
   | `usePrintingMonitorManager` | 3326 | webcam/relay, device status polling, recent plates, target+material picker, dashboard, debug bundles, reachability (10 direct deps, no deps-ref) |
   | `useSlicingManager` | 6277 | slicing params |
   | `useIslandManager` | 6599 | island scan (Analysis overlay) |
   | `useIslands` | 6661 | Support-tab islands PoC (came in from dev's #288) |
   | `useSupportInteractionManager` | 6672 | support selection/drag |
   | `useArrangeManager` | 7160 | arrange + duplicate |
   | `useHolePunchManager` | 8540 | hole-punch placement/apply |
   | `useMirrorManager` | 9049 | mirror tool |
   | (`hollowingDepsRef.current = …` populated 8710) | | |

2. **Remaining in-Home logic** (see *What remains* below).
3. **The JSX return** (9061–10031): a `<EditorLayout>` wrapping `TopBar`,
   `FloatingPanelStack` (the panel-stack organisms + `SceneCanvas` with
   `SceneOverlays`/`PrintingPreviewPane`), `EditorContextMenu`, the 5 modal
   organisms, and `NotificationStack`.

### Where extracted code lives

```
src/features/
  scene/useSceneCollectionManager.ts, scene/arrange/useArrangeManager.ts
  transform/useTransformManager.ts · slicing/useSlicingManager.ts
  mirror/useMirrorManager.ts · hole-punching/useHolePunchManager.ts
  hollowing/useHollowingManager.ts · import-export/useImportExportManager.ts
  printing/usePrintingPreviewManager.ts · printing/usePrintingMonitorManager.ts
  notifications/useEditorToasts.ts
  …plus Phase-1 pure modules (base64, geometrySnapshot, geometryScaling,
    jsonFields, holePunch{Geometry,Persistence}, hollowing{Serialize,PreviewTypes,
    PreviewCache}, printingMonitor{Types,Format}, supportSnapshotHelpers,
    exportThumbnailOptions, import-export/fileHandling)
src/components/
  atoms/        Button, IconButton, Input, Select, Card, Toast, cn
  organisms/    NotificationStack, PrintingPreviewPane, scene/SceneOverlays,
                modals/{Diagnostics,MeshRepair,Modifier,SceneFile,Printing}Modals,
                panels/{Prepare,Analysis,Export,Printing,Shared}PanelStack
  templates/    EditorLayout
```

---

## What remains in `page.tsx` (≈ ⅓ of the original logic)

Counts still in the file: **95 `useState`, 83 `useRef`, 90 `useEffect`,
117 `useCallback`, 68 `useMemo`** (was 208 / 158 / 169 / 245 / 155 originally;
90 / 73 / 86 / 115 / 67 pre-sync — the small growth is dev-side features that
land in Home per convention: islands PoC wiring, new-device toast, isExporting).

### 1. Printing-monitor domain — *✅ EXTRACTED → `usePrintingMonitorManager`*
The ~2,950-line monitor domain (193 statements: webcam streaming/relay, device
status polling, recent plates, target+material picker, dashboard, debug/RTSP
channels, reachability) is now `src/features/printing/usePrintingMonitorManager.ts`
(one cohesive manager hook, state + all its logic moved together — *not* the
net-negative "state-only" split). The boundary turned out cleaner than feared:
only **10 external deps** (`activePrinterProfile`, `setPrintingMonitorError` from
`useEditorToasts`, the shared `printingReadyPlateId`/setter, `printerReachability‑
ByDeviceId`, `activeNetworkUiAdapter`, `slicedLayerHeightMm`, `isLayerHeightMatch`,
`printableConnectedPrinterFleet`, `selectedPrinterProbeTarget`) — all defined
before the call site (~L3300), so **no deps-ref needed**. The two trivial
monitor-derived selectors the send-flow shares (`requiresRemoteMaterialSelection‑
ForUpload`, `isPreSliceTargetPicker`) were folded into the hook and returned. The
slice→print send glue (§3) stays in Home and reads the hook's ~206-name return via
destructure-same-names, so its call sites were untouched. Done as a single
content-anchored AST slice-assemble (TS compiler API for exact spans + reference
graph); verified `tsc` baseline-clean + `pnpm build` green.

*Note on risk:* this grouped all monitor `useEffect`s (previously interleaved
3700→8431) to register consecutively at the hook call site. React hook **order**
stays consistent across renders (the one rule that matters), but cross-domain
effect *execution order* shifted — smoke-test the monitor runtime paths (webcam
poll/relay, status polling, recent-plate start/delete, target picker) to confirm
no inter-effect ordering dependency was relied upon. **Still pending as of the
2026-07-12 sync** — it needs a real printer under Tauri; browser-side DOM
verification (see addendum) can't reach these paths.

### 2. Transform ↔ support-drag-sync — *intentionally kept*
`finalizeSupportDragSyncTransaction` (1400), `handleGizmoTransformCommit`
(7817), `handleTransformStart` (7967), `ensurePendingTransformHistoryForActiveModel`
(8020), `setTransformModeWithMirrorFinalize` (7254). These coordinate a
three-way sync across model-transform keys, the support store version, and the
kickstand store version. **Leave in Home** (or fold into
`useSupportInteractionManager`) — extracting it in isolation is high-risk and was
explicitly out of scope.

### 3. Slicing / print-send orchestration
`handleSliceRunStartedForPrinting` (2060), `handleSliceArtifactReady` (2160),
`sendToPrinterTargetName`/`canSliceAndPrint`/`sendToPrinterButtonLabel`
(3478–3526), `handleBeforeSliceStart` (3555). The slice→print glue; couples the
slicing manager with the (in-Home) monitor domain. Best tackled together with
the printing-monitor split.

### 4. History / hotkeys / context-menu / diagnostics
`handleEditorMenuAction` (5370), `jumpHistoryToCounts` (5652),
`handleHistoryJumpToEvent`/`handleHistoryCancelPreview` (5672/5684), the
diagnostics/history/slice-metrics **debug-hotkey effect** (~5695, now a single
`hotkeyStore.subscribe` after dev's #297), and `useUndoRedoHotkeys({…})` /
`usePrepareTransformHotkeys({…})` (7262/7272).
Candidate for a small `useEditorHotkeys` / `useHistoryControls` hook later.

### 5. Orchestration glue
The manager-hook calls, the three `deps`-ref declarations + their late
population blocks, `useSceneAutosave`, and the cross-manager wiring. This is the
irreducible "page composition" layer — keep it in Home.

### 6. The JSX return (9061–10031)
Already mostly organism calls. The remaining bulk is the inline prop-wiring for
`TopBar` (~70 props) and `SceneCanvas` (~60 props) — both are already components,
so there's little to extract; bundling their props would not reduce real
complexity. Leave as-is unless prop-grouping becomes worthwhile.

---

## Patterns & conventions (follow these for further extraction)

**Manager-hook pattern** (mirror the existing ones, esp. `useArrangeManager` and
`useHollowingManager`):
- Single options object in. Other managers are typed `ReturnType<typeof useX>`;
  plain callbacks/values by their signature.
- Return one flat object of state + setters + actions.
- **Destructure-same-names** in Home: `const { fooState, setFooState, … } =
  useFooManager({…})`. Because the names match, every existing consumer (JSX
  props, hotkeys, effects) is unchanged — no call-site edits.

**TDZ / hook ordering:** a hook call must sit *after* all its deps are defined in
Home. If a value the hook owns is read by code that stays in Home *before* the
call site, you get TS2448/2454. Fix by either moving that consumer into the hook,
keeping that value in Home as a dep, or — for genuinely coupled/late deps — use
the **deps-ref pattern**: the hook takes `deps: MutableRefObject<XDeps>` and reads
`deps.current.*` at event/effect time; Home populates `xDepsRef.current = {…}`
*after* all those deps (incl. values returned by later hooks) exist. See
`useHollowingManager` (it consumes values returned by `useHolePunchManager`,
which is called later) for the canonical example.

**Coupling:** when two domains share state (e.g. hollowing ↔ hole-punch via the
modifier-reset/blocker machinery; monitor ↔ toasts via the error toast), keep the
shared piece in Home (or in the hook that most owns it) and inject it as a dep
into the other. Don't duplicate it.

**Mechanical execution — content-anchored slice-assemble scripts:** every
extraction was done with a Python script that locates each move-region by a
**unique first-line anchor** (never hardcoded line numbers), asserts boundaries,
slices verbatim, assembles the new module/hook/component, and rewrites
`page.tsx`. This is exact (no hand-transcription) and shift-robust. Verify with
`./node_modules/.bin/tsc --noEmit` and iterate on missing imports/deps.

**Subagents:** the hooks and organisms were authored by worktree-isolated
subagents in parallel, then integrated serially (single file ⇒ can't edit
concurrently). Gotchas learned:
- Agent worktrees branch from a **stale `main`** (~23k lines), not the
  `refactor/page-tsx` tip. Each agent must `git merge --ff-only refactor/page-tsx`
  first and verify `wc -l src/app/page.tsx` + that prior hooks/modules exist.
- Fresh worktrees have no `node_modules` and no generated plugin files — symlink
  `node_modules` from the main checkout and run
  `node scripts/generate-plugin-registry.mjs && node scripts/generate-builtin-simple-plugins.mjs`
  once to reach the clean 8-error tsc baseline.

---

## Verification & merge checklist

- **Typecheck:** `./node_modules/.bin/tsc --noEmit` — must show only the 8
  pre-existing `__tests__` errors. (The branch is back on npm; the old "never
  `pnpm exec`" warning is moot since the accidental pnpm sweep was reverted.)
- **Build:** `npm run build` (Next + type-check) — the final gate. **PASSES**
  (✓ Compiled successfully, exit 0). Last run 2026-07-12 on `refactor/page-tsx-sync`
  after the full dev sync.
- **Smoke-test** the worker/interactive paths (extractions are verbatim moves, so
  behavior should be identical, but tsc can't see runtime/worker code): mirror
  (X/Y/Z bake), arrange/duplicate/fill, hole-punch place/gizmo/apply, hollowing
  apply/preview/voxel-edit, printing-mode layer scrub/zoom/pan, file open /
  drag-drop / `.voxl` handoff, all modals, toasts, and the 3D scene overlays.

## Known issues / not in scope

- **Molecules layer** not created (optional; would reclassify `components/ui`
  widgets like `NumberInput`, `SelectDropdown`). Low value.
- **pnpm migration**: the pre-session pnpm WIP that was accidentally swept into
  the first refactor commit (`f9fc1329`, the `git add -A` incident below) was
  reverted on the sync branch (`4f271c24`): scripts are `npm run` again,
  `packageManager` and `pnpm-lock.yaml` removed. The dep pins were kept — they
  are real fixes (`zustand` is imported by dev src without being declared;
  `three-mesh-bvh` was imported via drei's nested `node_modules` path). The
  migration itself should land as its own PR. Note: `package-lock.json` still
  needs an `npm install` to pick up the kept pins.
- **2 pre-existing solver test failures** (`fieldDeterministicSolver`,
  `potentialFieldSolver`) are unrelated to this refactor (fail with these changes
  stashed too).
- **Never `git add -A`** here — it once swept pre-session WIP into a commit. Stage
  specific paths.

---

## Dev-sync addendum (2026-07-12, branch `refactor/page-tsx-sync`)

The refactor branch fell 228 commits behind `dev`. Rather than rebasing (20
mechanical commits × repeated conflicts) it was brought current with **six
staged merges** along dev's first-parent history, each one typecheck-verified
before the next:

1. `679dc87c` — Support Separation #277, Auto-Collapse UI #278
2. `01f1ca4d` — Island Scanning #288 (new `useIslands` hook + `IslandsPanel` in the Support arm)
3. `aecf273d` — perf #295, GOO/CTB #296, 3D-mouse blocking #298
4. `34e89094` — hotkey management refactor #297 (the hairiest one)
5. `04c2673d` — 0.1.8/0.1.9 batch (Save Scene As #312, negative arrange #310, …)
6. `upstream/dev` tip — translations, Node 22, Lingui print-time/area labels

**Conflict-resolution convention** (applies to any future merge): every
`page.tsx` conflict is "dev edited a region this refactor moved out". Take this
branch's side (the deletion / the organism call) and re-apply dev's *change* —
not the whole block — inside the extracted hook/organism. Examples: dev's
`uniformScaling` props → `PreparePanelStack`; hotkey-store Escape rewrites →
`usePrintingMonitorManager` / `useHollowingManager`; negative arrange gaps →
`useArrangeManager`; Lingui monitor formatters → `printingMonitorFormat.ts` +
`PrintingModals`. Two cross-cutting renames bite new dev files:
`@/components/ui/primitives` → `@/components/atoms`, and dev's external
mesh-modifier store (`scene.getModelMeshModifiers(id)` — models always carry
`meshModifiers: undefined` now; mirror dev's call sites exactly, it compiles
either way but reads stale `undefined` if missed).

**Verification so far:** `tsc` baseline-clean (the same 8 `__tests__` errors),
`npm run build` green, and a DOM-equivalence check against a pure `dev`
worktree — serialized tag/class trees are **identical** across all four modes,
the five Prepare sub-tools and the Settings modal; the only difference is the
intentional `ModelStatsCard` flip fix (`e3138ae9`, opacity crossfade for
WebKitGTK). So no wrapper `<div>`s were lost in the extraction. **Still
pending:** the Tauri smoke-test (printing mode, monitor modal, native file
dialogs) and an `npm install` to sync the lockfile.
