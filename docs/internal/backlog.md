# Findings inbox (internal)

> **Not to be confused with `docs/dev/backlog.md`**, which is the *published*
> record of known gotchas, temporary rules, and desired architectural
> directions. This file is not published and is a different thing: a short-lived
> inbox. A rule you must follow from now on goes there; a finding somebody will
> pick up some day goes here.

> **Instructions for the agent (read before touching this file).**
>
> **What this is.** A low-friction inbox for incidental findings that turn up
> *in the middle of another task* — dead code, unused imports, redundant
> functions, refactor and toolchain ideas. It is NOT a formal tracker (that is
> GitHub Issues) and it is NOT a graveyard. It is the in-tray.
>
> **What it is for.** Two things: (1) getting findings out of a human's head so
> they stop spending attention remembering them; (2) **preserving analysis
> already paid for** (processing time + tokens) so nobody has to re-investigate
> when they come back to it.
>
> **The golden rule: capture and carry on.** When something turns up while you
> are working on something else, add it here and **continue with the current
> task**. No rabbit holes. A branch or PR is born only when a human
> *deliberately* chooses to pull an item out of here. Don't open speculative
> branches on disk: they rot.
>
> **How to write an entry.** Just enough to pick it up cold, not one line more.
> By tier:
> - Trivial/mechanical → 1-3 lines and the location. No essay.
> - Meaty/structural → *what* + *cost/risk* briefly, plus a **pointer** to the
>   full context (an ADR in `docs/adr/`, a page under `docs/dev/`, an issue)
>   instead of duplicating the expensive reasoning. Write *"do not
>   re-investigate"*.
> - Point only at things everyone can read. An agent's own memory is not a
>   citation — anything load-bearing has to be written down somewhere in the
>   repo, or it does not exist for the next reader.
> - No entry should run past ~6 lines. If it needs more, it is really a GitHub
>   Issue or an ADR, not an inbox entry.
> - Dedup before adding. If the exact listing can go stale (e.g. dead imports),
>   record *how to regenerate it* rather than freezing it.
>
> **Entry format:**
> ```
> ### [area] Title — <S|M|L> · <low|medium|high risk>
> - Where: file:line(s)
> - What: one-line description
> - Why: impact / why it is worth doing
> - Context: pointer to ADR/doc/issue (omit if trivial)
> ```
> Usual areas: `cleanup`, `refactor`, `toolchain`, `i18n`, `ci`, `dx`, `perf`,
> `docs`.
>
> **Lifecycle.** This file lists only what is OPEN. When an item is done or
> promoted to a GitHub Issue (`needs-triage`/`ready-for-agent`), **delete** it
> from here (git keeps the history); if promoted, leave the issue number in the
> commit message. Keep the list short and actionable — inbox, not graveyard.

---

## Open

### [cleanup] Dead imports and components in the page.tsx header — S · low risk
- Where: src/app/page.tsx, lines ~7-59 (import header).
- What: ~30 symbols imported and unused — lucide icons, several panels/cards
  (`IslandScanCard`, `ModelManagerPanel`, `TransformControls`, `LayerSlider`,
  `VisualSettingsPanel`…) and 2 entirely unused imports (lines 50 and 56).
- Why: noise; the LSP flags them (TS 6133/6192). Mechanical, low-risk cleanup.
- Context: already unused at HEAD (confirmed against `git stash`), not from the
  i18n fix. Regenerate the exact list with `npx tsc --noEmit` (or ESLint
  no-unused-vars) before touching anything — don't trust this frozen listing.

### [toolchain] Root-cause fix for the Lingui × React Compiler bug — L · medium risk
- Where: next.config.ts (`swcPlugins` + `reactCompiler`); affects every `msg`
  interpolation inside components/hooks.
- What: move Lingui to the **Babel** macro
  (`@lingui/babel-plugin-lingui-macro`) ordered BEFORE react-compiler, to kill
  the whole bug class instead of patching site by site.
- Cost: loses SWC speed and probably drops dev out of Turbopack. Keeps the SAME
  RC implementation → no regression from RC itself.
- Note: the rule that stands while this is undone (interpolations live in
  module-scope helpers) is in `docs/dev/backlog.md`. If this lands, retire it there.
- Context: the `@swc/react-compiler` spike (all-SWC at no cost) was already
  ruled out — it is a gate + linter, not a transform. Do not re-investigate.

### [i18n] Guardrail: fail loudly on uncatalogued messages — S · low risk
- Where: src/i18n.ts (the `i18n` init).
- What: subscribe to `i18n.on('missing', …)` so dev/test blows up (or warns
  loudly) when an `id` is not in the catalog.
- Why: this event fires in dev AND prod (it is not gated on NODE_ENV). It would
  have caught the card bug on day one instead of in a release DMG.
- Context: see the Lingui section of `docs/dev/backlog.md`.

### [ci] Guardrail: production-shaped build before release — M · low risk
- Where: CI (release.yml / pr-check-build.yml) or a local smoke test.
- What: get a production build (`next build` + launch, or the Tauri bundle) into
  the loop before publishing. Today `tauri:dev` is not a faithful preview of
  prod for i18n, which is why the failure only showed up in the DMG.
- Why: turns prod-only failures (like the Lingui one) into something visible
  before signing a release.

### [refactor] Scattered, overlapping duration formatters — M · medium risk
- Where: src/app/page.tsx (`formatApproxPrintTimeLabel`,
  `formatProcessingElapsedLabel`, `formatEstimatedPrintTimeLabel`),
  src/features/printing/printingMonitorFormat.ts,
  src/components/layout/EmptySceneState.tsx.
- What: ~3 places format durations with similar but divergent templates
  (`{hours} h {minutes} min`, `{hours} h {paddedMinutes} min`, `~{mins} min`,
  `{minutes} min {paddedSeconds} s`, relative `{deltaMin} min`…). Seconds are
  zero-padded in some, rounded in others, absent in others.
- Why: consolidate the mechanics into one duration-formatting module — and
  translate one string instead of several.
- Careful: the *message shapes* differ deliberately by context (estimated /
  elapsed / relative / approximate). Do not merge messages bluntly: that would
  change catalog ids and drop translations. Consolidate the mechanics, keep the
  templates.

### [cleanup] Pre-existing ESLint errors in src/hotkeys — S · low risk
- Where: src/hotkeys/ (confirmed in `__tests__/hotkeyStore.test.ts` and
  `HotkeyContext.tsx`). Regenerate with `npx eslint src/hotkeys/` — don't freeze
  line numbers.
- What: (a) test mocks use `any`/`Function` and `let` where `const` belongs;
  (b) HotkeyContext.tsx uses `any` in `deepMerge`/`stripStaleActions` and calls
  `setState` inside the localStorage-loading effect (`react-hooks/set-state-in-effect`).
- Why: `npm run lint` (= `eslint`, tests not ignored) already flags these.
  src/hotkeys/ cannot join `scripts/lint-clean-dirs.json` (the per-directory
  lint gate in CI, see AGENTS.md) until this is cleared. Predates #435.
- Careful: (b) is not mechanical — typing the merge touches the shape of the
  persisted config.

### [cleanup] Finish the lint cleanup in the directories still uncovered — XL · mixed risk
- Where: everything under src/ that is not yet in `scripts/lint-clean-dirs.json`.
  Regenerate the current picture with `npx eslint src` — don't freeze counts or
  line numbers, they move with every commit.
- What: clean a directory until `npx eslint <dir> --max-warnings 0` passes, then
  add it to the list. `npm run check:lint` (CI job `lint` in test.yml) refuses
  any new problem inside what is already listed, so the debt only shrinks.
- Order that has held so far, cheapest first:
  1. Unused vars, dead constants and stray imports — verified by `tsc` and the
     unit tests alone. Most remaining directories still have some.
  2. `no-explicit-any` on payload and settings objects. Usually
     `Record<string, unknown>` plus the typeof guards already in the code; the
     plugin manifests were exactly this shape.
  3. `react-hooks/exhaustive-deps`, concentrated in useHollowingManager,
     useHolePunchManager and useArrangeManager. Arrays that list
     `deps.current.someFn` read a ref during render — swapping in the stable
     `deps` object is safe. Adding `scene` or `hollowingState` is NOT: it
     recreates callbacks on every scene mutation and can re-trigger the hollow
     preview. Needs a manual smoke test, which unit tests cannot stand in for.
  4. `react-hooks/refs` and `immutability`, almost all in src/supports and the
     gizmos — the drag paths, where a wrong fix breaks interaction silently.
- Threads that widen past lint, decide before pulling them:
  - `raftOverride` reaches RootsRenderer from SupportBuilder and four
    AnatomyPreview components and is now provably ignored there; removing it
    touches the supports render pipeline.
  - `SupportGeometryGenerator` takes two ignored `raftSettings` parameters and
    types `coneData` as `any`; the accepted shape is a union of ContactCone and
    the twig disk the NaN-radius regression test covers, so it needs a real
    interface, not a cast.
- Context: `src/app/page.tsx` alone holds ~440 unused-symbol warnings and is the
  single largest mechanical win left; it has its own entry above.

### [cleanup] CRLF line endings in the plugin submodules — M · medium risk
- Where: plugins/ (git submodules). Detect with
  `find plugins -type f | xargs grep -lU $'\r' | head` (~51+ files with CRLF).
- What: several files in the submodule repos use Windows carriage returns;
  normalize to LF.
- Why: inconsistent line endings → diff noise and possible tooling/patching
  failures.
- Careful: these are submodules → the change belongs in THEIR repos, not this
  one. Also add a `.gitattributes` (`* text=auto eol=lf`) per plugin so it does
  not come back.

### [ci] TS-vs-Rust island conformance has never actually run — M · medium risk
- Where: rust/dragonfruit-islands/src/bin/{island_harness,island_diff}.rs; the live
  TS path in src/volumeAnalysis/IslandScan/; `/fixtures/` in .gitignore.
- What: two island-detection implementations ship side by side, and the only
  thing checking they agree is a harness/diff pair that reads
  `fixtures/island-scan/<case>/` — a directory that is gitignored and untracked,
  so it exists on one developer's machine. The guarantee has never been enforced.
- Why: a dual implementation with no conformance check drifts silently, and the
  TS path is wired into production UI, not hidden behind a native-only switch.
- Fix: commit fixtures and convert the pair into an integration test.
- Context: ADR-0025 (`docs/adr/`) records the full audit and disposition; it is
  `status: proposed` and this is its unexecuted phase 1. Do not re-derive.

### [cleanup] Stale DFST header size in a doc comment — S · low risk
- Where: src-tauri/src/mesh_repair.rs, the comment above the DFST spec.
- What: one comment says "a 16-byte `DFST` header"; the spec below it and
  `STL_RESPONSE_HEADER_BYTES` both say 64. The constant is right.
- Why: trivial, but it is the kind of thing someone trusts while writing a reader.

### [docs] Candidate ADR: empirical sizing over physics-based — S · low risk
- Where: src/supports/autoSupport/parameterSizing.ts (header comment), and the
  reverted physics work in the auto-supports history.
- What: physics-derived shaft sizing was implemented and then removed because an
  area-derived curve inverted the profiles (a light 16 mm² cell sized 1.28 mm
  against a heavy 5 mm² cell at 1.12 mm). Sizing is now hardcoded profile bands.
- Why it may deserve an ADR: it passes the three-part bar — the naming left
  behind (`SizingDebugInfo`) and the obvious appeal of "size it by load" mean
  someone will propose physics sizing again, and the rejection is measured, not
  aesthetic. Currently that reasoning survives only in a source comment.
- Context: summarized in `docs/dev/auto-supports.md`; promote to `docs/adr/` if
  the user agrees it clears the bar.

### [refactor] Consolidate toasts into a queue with one lifetime — M · medium risk
- Where: src/features/notifications/useEditorToasts.ts (12 useState + 11 timer
  refs for six toasts), src/components/organisms/NotificationStack.tsx (literal
  z-indexes and a hardcoded offset conditional), src/components/ui/SupportToasts.tsx
  (a second path, no timer), plus inline `<ToastViewport>` uses such as
  AutoBracingSettingsCard.tsx (a third).
- What: replace the repeated fade/clear timer pair with a module store holding a
  queue and one timer — `pushToast({ tone, text, durationMs })` — and let the
  stack compute its own offsets instead of a two-case conditional.
- Why: adding one message today is five steps across four files plus a judgement
  call about overlap, and the durations are per-toast literals (2200/2600,
  3800/4500, duration-400). Three independent paths means three behaviours for
  the same UI element.
- Careful: `Toast`/`ToastViewport` are already shared and fine — this is about
  what drives them. The save toast has three pieces of state, not two (a
  minimum-visible-time animation), so it is the one that constrains the API.
- Context: current state documented in `docs/dev/notifications.md`; retire that
  page's "there is no notification system" warning when this lands.

### [fix] Support placement modifiers ignore the macOS primary modifier — M · medium risk
- Where: src/supports/interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver.ts
  (`parseBindingModifiers`, `hasModifier`); contrast with `getRequiredKeys` in
  src/hotkeys/hotkeyStore.ts, which maps a binding's `ctrl` through
  `getPrimaryModifierKey()` (→ `meta` on macOS).
- What: the placement resolver tests `ctrlKey` literally, so on macOS kickstand
  placement needs physical Control and leaf placement needs Control+Option,
  while every other `ctrl` binding in the app is Cmd. And since matching is on
  an exact modifier set, the Cmd combination a Mac user would try (`{meta, alt}`)
  matches nothing at all — not even the Alt-only branch family, because two
  modifiers are held.
- Why: silently wrong on one of the three supported platforms, in a core
  interaction. Fix is to route the resolver's modifier comparison through
  `getPrimaryModifierKey()` like the main hotkey path already does.
- Careful: the exact-set match is deliberate (it is what keeps Ctrl+Alt from
  falling through to Alt); preserve it, only translate `ctrl` → primary.
- Context: documented in `docs/reference/support-placement-modifiers.md`; retire
  that warning when fixed.

### [cleanup] `releaseShouldCancel` is always false and nobody reads it — S · low risk
- Where: src/supports/interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver.ts
  (`resolveSupportPlacementHotkeyIntent`) and its type in
  `supportPlacementHotkeyTypes.ts`.
- What: every return path sets `releaseShouldCancel: false`, and no consumer
  outside the module reads the field. The behaviour it would control — releasing
  the modifier cancelling an in-flight placement — is instead settled by
  `resolveSupportPlacementRouting` checking the `*Awaiting*` state first.
- Why: a field that never varies reads like a live switch. Either drop it, or
  make it mean something if cancel-on-release is ever wanted (the current
  behaviour, not cancelling, is the sensible one — a started two-click placement
  should survive letting go of the key).
- Context: the retired DEPRECATED_hotkeys page claimed release *does* cancel,
  which is where the discrepancy surfaced.

### [fix] Delete does nothing on a selected anchor — S · low risk
- Where: src/features/supports/useSupportInteractionManager.ts, `canDeleteSelection`.
- What: the single-selection gate lists `joint | trunk | leaf | branch | twig |
  stick | brace` and omits `anchor`, while `deleteSelectionByCategoryAndId`
  handles anchors fine. So Delete silently no-ops on a selected anchor.
  Multi-selection is unaffected (it returns early on `selectedIds.length > 0`).
- Why: one missing string in a gate; the delete path underneath already works.
- Context: documented as a known bug in `docs/dev/support-type-extension.md` and
  in `docs/reference/support-anatomy/anchor.md`. Retire both notes when fixed.

### [docs] "Anchor" names three unrelated things — M · medium risk
- Where: src/supports/types.ts (`Anchor` support type, and the `Knot` doc comment
  reading "Knot (Anchor)").
- What: a placeable support type, a legacy alias for the knot primitive, and the
  auto-support densification band over the first-printed surface — one word.
- Why: costs a code read every time. Cheapest fix is dropping the "(Anchor)" from
  the `Knot` comment, which is the only one of the three that is purely vestigial.
- Context: recorded in CONTEXT.md; do not rename the type or the bands, both are
  load-bearing (`selectedCategory` strings persist in saved scenes).

### [ci] `guard:plugin-boundaries` exists but never runs — S · low risk
- Where: package.json (`guard:plugin-boundaries`), scripts/check-plugin-boundaries.mjs,
  .github/workflows/.
- What: the script enforces that core `src/` files don't import plugin internals
  directly, but no workflow invokes it. `plugin-registry-guardrails.yml` runs the
  generator and the two allowlist checks, not this one.
- Why: a guardrail nobody runs is a guardrail that has already stopped working.
  Cheapest fix is one more step in the guardrails workflow.
- Context: found while auditing `docs/dev/config-schemas.md`, which also
  mis-attributed the simple-plugin allowlist validation to this script.

### [ci] Run the Rust tests in CI — M · medium risk
- Where: .github/workflows/ (a new `cargo test` job, or inside an existing one).
- What: `cargo test` does NOT run in CI. 155+ `#[test]` functions across the
  `rust/` crates (plus `src-tauri/`) with no automated net. Same gap already
  closed for the TS suite (see `test.yml`), one layer down.
- Cost: heavier than the TS one — Rust toolchain plus compile time; probably
  needs the `plugins/*/rust` submodules. Lean on `warm-rust-cache.yml`.
- Note: cargo discovers tests through the compiler (`#[test]`/`#[cfg(test)]`),
  not by glob, so nothing from the TS suite-exposure fix affects it.

### [refactor] Move createTypedHistory into historyStore.ts — M · medium risk
- Where: src/history/typedHistory.ts + src/history/historyStore.ts.
- What: fold the factory into historyStore.ts and stop exporting
  `pushHistory`/`registerHistoryHandler` (module-private) → the typed façade
  becomes the only path. `undo`/`redo`/`subscribe*`/`clearHistory` stay public.
- Why: the boundary is conventional today; a future contributor can call the raw
  store and reintroduce the type↔payload drift we removed.
- Cheaper alternative: a lint guardrail (in the style of
  `scripts/check-plugin-boundaries.mjs`) restricting imports of those two
  functions to typedHistory.ts.
- Context: branch fix/history-undo-seam; `docs/dev/history-and-undo-redo.md`
  documents the façade this would enforce.

### [fix] Show continuous Euler angles in the Transform panel — M · medium risk
- Where: the gizmo drag applies rotation as quaternion deltas
  (src/components/scene/SceneCanvas/SceneCanvas.tsx, onRotate:
  `setFromAxisAngle(rotationAxis, -angle)` premultiplied onto the model
  quaternion); the panel reads Euler angles back off that quaternion via THREE's
  `setFromQuaternion(q, 'XYZ')`. At 180° the XYZ decomposition has two equivalent
  forms and THREE picks the (-180, 0, -180) one.
- What: make the displayed Euler triple continuous — when converting the model
  quaternion to Euler for display, pick the decomposition closest to the triple
  currently shown, so the fields stop jumping between equivalent representations.
- Why: rotating a model exactly 180° about Y makes the ROTATE fields read
  X=-180, Y=0, Z=-180 instead of Y=180. Both describe the same orientation
  (verified: quaternions differ by 0°, all three basis vectors map identically),
  so this is Euler decomposition degeneracy, not a wrong rotation.
- Careful: the same Euler values feed undo/redo snapshots, scene persistence and
  export, so the display-side choice must not change the stored orientation.
  Confirm with an exact 180° rotation on each axis, and with a drag crossing 180°
  continuously.

### [cleanup] Dead symbols in SlicingPanel and the backups tabs — S · low risk
- Where: src/features/slicing/components/SlicingPanel.tsx and
  src/components/settings/BackupsSettingsTab.tsx. Regenerate with
  `npx eslint <file>` — don't trust a frozen listing.
- What: `sliceStatus` is a useState written by seven call sites and never read;
  `formatDuration`, `fetchStatus`, `activePrinter`, `activeMaterial` and a
  handful of `set*` setters are unused.
- Why: `sliceStatus` in particular reads like live status and is not — it
  invites someone to "fix" a display that no longer exists. Predates the i18n
  pass (confirmed at HEAD); mechanical once the parked block below is resolved.

### [cleanup] 790 lines of parked expert-AA UI in SlicingPanel — M · medium risk
- Where: src/features/slicing/components/SlicingPanel.tsx, lines ~2779-3571,
  opened by `{false && aaQualityMode === 'expert' && <>`.
- What: the whole expert anti-aliasing panel is switched off by a literal
  `false`. It holds most of the AA vocabulary (Perturbation Pattern, LUT Curve,
  Z Blur Radius, Minimum Grey Level, AA on Supports) and keeps several memoized
  labels alive (`advancedSampleCountLabel`, `advancedBlurWidthLabel`…).
- Why: decide with the AA owner whether this is parked or abandoned. Left
  untranslated in the i18n pass on purpose — wrapping it would add ~80 strings
  nobody can see; if it comes back, it needs that pass plus an AA glossary.
