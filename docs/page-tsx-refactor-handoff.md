# `src/app/page.tsx` refactor — handoff

## TL;DR

`src/app/page.tsx` was a single 23,133-line file with one ~21,600-line `Home()`
component. It has been decomposed into an atomic-design component tree plus
feature "manager hooks", and is now **9,696 lines** (−58%). All work landed on
`refactor/page-tsx`, each commit verified `tsc --noEmit`-clean (the only standing
errors are 8 pre-existing test-fixture type errors in `src/supports/__tests__/`,
unrelated to this work) and the final `pnpm build` passing.

This document explains **what's left in `page.tsx`**, why, and how to continue.

---

## Current architecture

`Home()` (lines ~490–12432) is now an **orchestrator**:

1. **Manager-hook calls** in dependency order (with a few `deps`-refs for the
   coupled ones — see *Patterns* below):

   | Hook | line | owns |
   |---|---|---|
   | `useSceneCollectionManager` | 493 | models, geometry, mode, import |
   | `useTransformManager` | 514 | gizmo transform state |
   | `useHollowingManager` | 537 (deps-ref 519) | hollowing/shell/voxel-edit |
   | `useEditorToasts` | 816 | all toasts incl. monitor error toast |
   | `usePrintingPreviewManager` | 924 (deps-ref 861) | layer scrub/zoom/pan |
   | `useImportExportManager` | 1334 (deps-ref 1328, populated 9027) | file/drag-drop/handoff/thumbnail |
   | `usePrintingMonitorManager` | ~3300 | webcam/relay, device status polling, recent plates, target+material picker, dashboard, debug bundles, reachability (10 direct deps, no deps-ref) |
   | `useSlicingManager` | 8923 | slicing params |
   | `useIslandManager` | 9254 | island scan |
   | `useSupportInteractionManager` | 9261 | support selection/drag |
   | `useArrangeManager` | 9749 | arrange + duplicate |
   | `useHolePunchManager` | 11151 | hole-punch placement/apply |
   | `useMirrorManager` | 11580 | mirror tool |
   | (`hollowingDepsRef.current = …` populated 11241) | | |

2. **Remaining in-Home logic** (see *What remains* below).
3. **The JSX return** (11592–12429): a `<EditorLayout>` wrapping `TopBar`,
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

Counts still in the file: **90 `useState`, 73 `useRef`, 86 `useEffect`,
115 `useCallback`, 67 `useMemo`** (was 208 / 158 / 169 / 245 / 155).

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
no inter-effect ordering dependency was relied upon.

### 2. Transform ↔ support-drag-sync — *intentionally kept*
`finalizeSupportDragSyncTransaction` (1511), `handleGizmoTransformCommit`
(10437), `handleTransformStart` (10587), `ensurePendingTransformHistoryForActiveModel`
(10640), `setTransformModeWithMirrorFinalize` (9843). These coordinate a
three-way sync across model-transform keys, the support store version, and the
kickstand store version. **Leave in Home** (or fold into
`useSupportInteractionManager`) — extracting it in isolation is high-risk and was
explicitly out of scope.

### 3. Slicing / print-send orchestration
`handleSliceRunStartedForPrinting` (2165), `handleSliceArtifactReady` (2265),
`sendToPrinterTargetName`/`canSliceAndPrint`/`sendToPrinterButtonLabel`
(3443–3491), `handleBeforeSliceStart` (3525). The slice→print glue; couples the
slicing manager with the (in-Home) monitor domain. Best tackled together with
the printing-monitor split.

### 4. History / hotkeys / context-menu / diagnostics
`handleEditorMenuAction` (7938), `jumpHistoryToCounts` (8187),
`handleHistoryJumpToEvent`/`handleHistoryCancelPreview` (8207/8219), the
diagnostics/history/slice-metrics **hotkey-registration effects** (~8238–8270),
and `useUndoRedoHotkeys()` / `usePrepareTransformHotkeys({…})` (9851/9861).
Candidate for a small `useEditorHotkeys` / `useHistoryControls` hook later.

### 5. Orchestration glue
The manager-hook calls, the three `deps`-ref declarations + their late
population blocks, `useSceneAutosave`, and the cross-manager wiring. This is the
irreducible "page composition" layer — keep it in Home.

### 6. The JSX return (11592–12429)
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
  pre-existing `__tests__` errors. **Never** run `pnpm exec …`: it triggers a full
  `pnpm install` that converts `node_modules` to a pnpm layout and drifts deps.
- **Build:** `pnpm build` (Next + type-check) — the final gate. **PASSES** (✓ Compiled
  successfully, all 14 static pages generated, exit 0; only noise is pre-existing i18n
  "Uncompiled message" catalog-fallback warnings). Run 2026-06-21 after node_modules drift fixed.
- **Smoke-test** the worker/interactive paths (extractions are verbatim moves, so
  behavior should be identical, but tsc can't see runtime/worker code): mirror
  (X/Y/Z bake), arrange/duplicate/fill, hole-punch place/gizmo/apply, hollowing
  apply/preview/voxel-edit, printing-mode layer scrub/zoom/pan, file open /
  drag-drop / `.voxl` handoff, all modals, toasts, and the 3D scene overlays.

## Known issues / not in scope

- **Molecules layer** not created (optional; would reclassify `components/ui`
  widgets like `NumberInput`, `SelectDropdown`). Low value.
- **pnpm migration**: dep pins added during this work (`@types/three`, `three`,
  `manifold-3d`, `zustand`, `three-mesh-bvh`, `@react-three/fiber`,
  `@react-three/drei`) and pre-session WIP (`.gitignore`, `flatpak/…yml`,
  `src-tauri/tauri.conf.json`, `pnpm-workspace.yaml`, `scripts/build-flatpak-docker.sh`)
  are left uncommitted/untracked for the maintainer to fold into the migration.
- **2 pre-existing solver test failures** (`fieldDeterministicSolver`,
  `potentialFieldSolver`) are unrelated to this refactor (fail with these changes
  stashed too).
- **Never `git add -A`** here — it once swept pre-session WIP into a commit. Stage
  specific paths.
