# Scene Core Map

Where the scene rules live today, which of them can move into pure modules under
[ADR-0045](../../adr/0045-headless-scene-operations.md), in what order, and what has to be pinned
first. Point-in-time research for review: mapped on `dev` @ `5d31502c` (2026-10-21), read-only,
nothing was run. Line numbers cite the code as it was then and will drift.

The full row-by-row data is in the companion spreadsheet (`scene-core-map.xlsx`): 218 operations
in `useSceneCollectionManager.ts` and the save path, 82 scene rules in `page.tsx` and
`SceneCanvas.tsx`, all 27 CLI subcommands, the parity table, the decisions and the suspected bugs.
This page is the reading guide; Appendix A repeats the operation table in compact form.

## What the manager is

`useSceneCollectionManager` (8,289 lines) is one hook, mounted once in page.tsx:799, that holds
the scene's models, plates, selection, history snapshots, import prompts, viewer settings and
geometry lifecycle, and returns 153 keys. It is not in a context or a module store: other code
reaches it as the `scene` prop, passed down to six feature hooks (arrange, mirror, hollowing,
hole punch, import/export, printing preview) and about ten panels and modals.

Most of its lines are not scene rules. Roughly:

| Share of the hook | What it is | ADR-0045 scope? |
| --- | --- | --- |
| ~30% | Import and VOXL open: payload validation, prompts, id remap, repair, placement | Rules inside, but prompt-heavy |
| ~20% | Geometry lifecycle: BVH queues, disposal, AO bake, flattening planes, edge backfill | No — app-side by nature |
| ~15% | Viewer display settings, recent files, browser storage | No |
| ~15% | Transforms, plates, placement, delete, paste | Yes — the core of this work |
| ~10% | History snapshots and their registry | Stays in the manager (ADR rule 4) |
| ~10% | Grouping, linking, model fields, support split/merge | Yes, mostly small |

Two numbers frame the work. Of the 218 operations, **70 are already mostly pure** (the logic is
there, wrapped in refs and `setState`), and **85 read an implicit target** — the selection, the
active model or the active plate — instead of taking ids, which ADR rule 3 forbids in a pure
module. The second number, not the first, is what most often stands between a rule and the CLI.

## What `plateLayout.ts` already did, and what it left

PRs #855 and #857 moved plate frames, model-to-plate membership and slice scope into
`plates/plateLayout.ts`, and `scene slice --plate` uses the same functions. `plateFrames` and
`resolveModelPlateId` in the manager are now thin wrappers. Both failures the ADR measured are
fixed: the CLI save now carries `plates`, `activePlateId` and `meta.printer`.

Still in the manager: every rule that **changes** the plate list (add, remove, re-lay, move models
across plates), the two effects that re-lay plates when the printer or the ordering changes, and
about nine places that still compute a plate rect by hand next to `computePlateFrames`. That is
the next group (Plates, phase 2).

Two small points about the worked example itself: `resolveModelPlateId(model, frames)` takes two
positional arguments rather than one parameters object (ADR rule 4), and the CLI forces
`originMode: 'center'`, the ADR's own open question.

## Findings that change the plan

These came out of the mapping and are not in the ADR or the kickoff brief.

1. **ADR rule 6 is only partly pinned.** `check-scene-slice.ts` checks that plates survive a CLI
   save. Nothing checks *every* field. Reading the code, a CLI save drops the full-resolution
   original mesh chunks and the sha map, and `scene duplicate` likely writes copies with no mesh
   (the writer looks up mesh bytes by model id, and the copy has a new id). A full round-trip test
   is therefore step zero: every later parity test reads files the CLI saved.
2. **Groups do not survive a save, in either direction.** The app keeps `groupId`/`groupName` on
   each model and never writes them to VOXL; the CLI writes `extensions.groups`, which the app
   never reads and an app save strips. The grouping rules are already pure
   (`modelGroupingHistory.ts`); only the storage needs a decision.
3. **Four rules are written four times each**: the transform rule (two drifting copies in the
   manager, an inverted one in history commit, and one in a test that tests its own copy),
   "inside the build volume", "seat on the plate", and "put new models on a free spot" (import,
   paste, plugin import — three engines, none of them `arrange/`). Each one should become one pure
   function before any CLI command is pointed at it.
4. **Several hidden effects move models with no gesture.** A printer switch and a plate-ordering
   change both re-lay the plates from inside effects; only the first pushes history. Any CLI
   command that changes the printer or the plates needs the same rule.
5. **The save path is four savers, not one.** Autosave, Ctrl+S, the export panel and the CLI
   build the writer's input separately and disagree: Ctrl+S saves only visible models, the export
   panel leaves out the printer and the ordering, per-plate exports keep plate-N positions. A
   shared buildVoxlSaveInput (proposed) is ADR rule 6 at its source.
6. **THREE is already inside the "pure" helpers.** `selectionTransform.ts`,
   `selectionLiftDrop.ts`, `selectionPosition.ts` and `highPrecisionArrange` (the ADR's own success
   example) import THREE maths classes. The ADR says "no THREE". This needs a ruling (D1) before the
   transform and placement groups.
7. **Dead surface is worth deleting first.** About a dozen returned keys have no caller in `src/`
   (listed in D18). Deleting them shrinks what has to be tested.

## How the manager is reached

Besides direct calls, operations are triggered by:

- **The delete registry** — `registerDeleteHandler` claims at priorities 10 (manager), 20/30
  (page: select-all deletes extra plates), 100 (supports).
- **Hard-coded Ctrl+A/C/V/S** in a `hotkeyStore.subscribe` effect (page.tsx:9900-9993). The
  registry has bindings for them, but nothing reads them, so they are not remappable and paste has
  two callers with the same implicit arguments.
- **The A key** (arrange) through `usePrepareTransformHotkeys`.
- **Undo/redo** through the history registry: `SCENE_MODELS_SNAPSHOT_APPLY` → `applySceneSnapshot`,
  backed by a module-level snapshot Map shared by every mounted manager (including DOM tests).
- **Two context menus**, which resolve "selection, else active model" in page.tsx three different
  ways (`resolveModelActionTargetIds`, inline fallbacks, plain `activeModelId`).
- **Window events** `model-clicked` / `model-deselected` (SceneCanvas → page), and
  `window.__df_flushAutosave`.
- **Tauri events** `scene-file-handoff` and drag-drop, both ending in `loadFiles`.
- **Store-reactive effects**: printer/footprint relayout (:7694), ordering relayout (:7774),
  auto-brace mesh sync, the plate-lock selection clear.

There is no seam a script can reach inside the running app (no context, no `window` handle, no
automation server) — consistent with the decision that a live JSON-RPC server is not a goal.
Appendix C has the full wiring trace.

## Command groups

Each group is a set of rules that would move together, with the pure functions it would expose.
Signatures are drafts in ADR-0045's shape: one parameters object, the narrowest input, explicit
targets, data out. Operation counts are from the spreadsheet.

### 0. Foundations: pins and seams

Tests and small moves that every later extraction leans on: a full CLI save round-trip test (ADR rule 6), the snapshot registry in its own module, and pinning the suspected bugs before anyone touches the code around them.

*12 operations mapped (5 mostly pure, 4 with an implicit target). Effort S–M, risk Med. Depends on: —.*

- (test) voxlRoundTrip: app-written scene → CLI load → CLI save → compare every field and mesh chunk
- `move sceneSnapshotRegistry + storeSceneSnapshotPair to scene/history/sceneSnapshotRegistry.ts (already React-free)`
- (tests) one failing-or-passing test per suspected bug in the Bugs sheet, marked as 'pins current behaviour'

**Why here:** ADR rule 6 is only pinned for plates today. Two suspected CLI save defects (meshless duplicates, dropped ORIG chunks) would corrupt any later parity test's input.

### 1. Plates, phase 2

Finish what plateLayout.ts started: every plate rect from computePlateFrames, a pure re-layout rule, and pure plans for adding/removing plates. Adds the plate commands the CLI lacks.

*37 operations mapped (15 mostly pure, 21 with an implicit target). Effort M, risk Med. Depends on: foundation.*

- `relaidPlateShifts({ models, from: { plates, footprint, ordering }, to: {...} }) → { modelId, dxMm, dyMm }[]`
- `planAddPlates({ plates, count, footprint, ordering, models }) → { plates, shifts }`
- `planRemovePlate({ plates, plateId, models }) → { plates, removeModelIds, nextActivePlateId } | { refused }`
- `planEmptyScenePlates({ plates }) → plates (the 'scene became empty' rule now inside deleteModels)`
- `resolveModelPlateId({ model, frames }) — convert to one params object (ADR rule 4)`

**Why here:** Already half done, smallest conceptual step, unblocks paste/duplicate/import placement and lets `scene slice` honour meta.printer. ~9 sites still recompute plate rects by hand.

### 2. Model fields (quick wins)

Tiny rules over a model list: rename, visibility, colour, support designation, link/unlink. Each is a few lines of real logic wrapped in history plumbing.

*8 operations mapped (5 mostly pure, 2 with an implicit target). Effort S each, risk Low (designation: Med). Depends on: foundation.*

- `renameModels({ models, modelId, name }) → models`
- `setModelsVisible({ models, modelIds, visible }) → models`
- `setModelsColor({ models, modelIds, color }) → models (split from the viewer preference)`
- `setSupportDesignation({ models, modelIds, isSupport }) → models  (changes slicing → check:scene-slice case)`
- `linkModels({ models, modelIds }) / unlinkModels({ models, modelIds }) → models`

**Why here:** Nearly pure already. Good first PRs to establish the pattern and the parity-test template; adds CLI commands that don't exist yet.

### 3. Grouping

Rules already pure in modelGroupingHistory.ts. The blocker is storage: the app keeps groupId/groupName on models and never saves them; the CLI writes extensions.groups, which the app ignores.

*5 operations mapped (4 mostly pure, 0 with an implicit target). Effort S (after decision D5), risk Med (file format). Depends on: decision D5.*

- `applyModelGrouping (exists) — make CLI group/ungroup call it`
- `renameGroup({ models, groupId, name }) → models`
- `modelIdsInGroup({ models, groupId }) → ids  (today selectGroup does this inline)`

**Why here:** Cheapest real parity win once Ender picks where groups live in VOXL.

### 4. Save input (export-save)

One pure builder for what goes to the VOXL writer. Today autosave, Ctrl+S, the export panel and the CLI each assemble it by hand and disagree (hidden models, plates, printer, ordering, ORIG chunks, sha map).

*17 operations mapped (1 mostly pure, 7 with an implicit target). Effort M, risk High (file format). Depends on: foundation, decision D9.*

- `buildVoxlSaveInput({ models, supports, plates, activePlateId, printer, plateOrdering, scope }) → BuildVoxlDocumentInput`

**Why here:** ADR rule 6 at the source: one function, so the four savers cannot drift.

### 5. Delete

deleteModels holds three pure rules (link-group dissolve, selection cleanup, empty-scene plates) plus the support cascade. CLI remove-model restates the cascade for 5 of ~10 support collections.

*10 operations mapped (3 mostly pure, 3 with an implicit target). Effort M, risk High (support geometry). Depends on: plates, decision D13.*

- `planDeleteModels({ models, plates, modelIds }) → { models, plates, dissolvedLinkGroups }`
- `supportsCascadeForModels({ supports, modelIds }) → { removeIds by collection }  (pure compute half of deleteSupportsForModel)`

**Why here:** Clearest drift case found: CLI leaves knots, twigs, sticks, stumps and kickstands orphaned.

### 6. Volume bounds and seating

Two rules each written four times: 'is this model inside / overlapping the build volume' and 'what Z seats this model on the plate'. They decide what gets sliced and where models sit.

*12 operations mapped (7 mostly pure, 7 with an implicit target). Effort M, risk High (slicing output). Depends on: plates, decisions D11/D12.*

- `modelsOutsideVolume({ models, frames, volume, mode: 'overlap'|'contain', margins?, supportBounds? }) → ids`
- `seatZ({ model, geometryBounds, autoLift, liftDistance }) → z  (wraps selectionLiftDrop.getModelLowestWorldZ)`

**Why here:** App and CLI can slice different model sets today; CLI place-on-platform ignores rotation and scale.

### 7. Placement and duplicate layout

Three engines put new models on beds (import ring search, paste ring search with overflow, plugin shelfPack), plus the duplicate preview layout in page.tsx and arrange/. Clipboard itself stays UI.

*27 operations mapped (11 mostly pure, 15 with an implicit target). Effort L, risk Med. Depends on: plates, bounds-seat, decision D6.*

- `findFreeSpots({ footprints, frames, blockers, startPlateId, allowNewPlates }) → { positions, newPlateCount }`
- `layoutDuplicates({ source, count, spacing, frames, blockers }) → { transforms, newPlateCount }  (from page.tsx 9500–9790)`
- `deriveModelFrom({ source, id, name, transform }) → model  (one rule for which fields copies keep)`
- `arrange: make computeHighPrecisionArrangeUpdates callers plate-aware (CLI packs everything onto plate 1)`

**Why here:** Big payoff (CLI duplicate/add-model/arrange parity) but needs the plate rules and one placement decision first.

### 8. Transform

updateModelTransform and updateModelTransforms both do lock check → link-peer propagation → support move → plate restamp → follow plate, with drift between them. page.tsx picks targets and lift; the manager applies.

*29 operations mapped (8 mostly pure, 16 with an implicit target). Effort L, risk High (undo core, support geometry). Depends on: plates, model-fields, decisions D1/D2/D3.*

- `planModelTransforms({ models, updates: {modelId, transform}[], lockedPlateIds, frames }) → { models, supportDeltas, refused, landedPlateId }`
- `centerOnPlate({ models, modelIds, frame, originMode }) → updates`
- `linkPeerUpdates({ models, leaderId, before, after }) → updates (today written 4 times)`

**Why here:** The heart of CLI parity for transform-model/center-xy/place-on-platform, but touches undo and supports. Do it after the pattern is proven.

### 9. Import / VOXL open

Opening a VOXL changes it (name sanitising, import-default support rules, id remap, printer relayout, off-bed prompt, repair). The CLI's `scene load` just parses.

*47 operations mapped (19 mostly pure, 18 with an implicit target). Effort L, risk High (file formats). Depends on: plates, placement, save, decisions D7/D8.*

- `planVoxlOpen({ doc, existingIds, printer, ordering, prefs }) → { models, supports, plates, idRemap, needs: ['printer-mismatch'|'off-bed'|...] }`
- `planMeshImport({ entries, frames, activePlateId, blockers }) → placements`
- `sanitizeImportedModelName / remapModelIdsInPayload (already module-level, just move)`

**Why here:** Large and prompt-heavy; needs the plan/apply decision first.

### 10. Split and merge geometry

splitModelIntoParts, split/merge supports, split-import-group: real rules over triangle soups wrapped in THREE geometry, BVH and flattening-plane work.

*6 operations mapped (1 mostly pure, 2 with an implicit target). Effort L, risk High (orientation, support geometry). Depends on: transform, decision D1.*

- `splitByClassification({ positions: Float32Array, classification, transform }) → parts (data only)`
- `partTransforms({ source, partCentres }) → transforms  (fix the Euler-order suspect first)`

**Why here:** Last: depends on the THREE ruling and on transform maths being pinned.

### Stays in the app (not ADR-0045 scope)

Viewer display settings (~35 keys), prompts and reports, recent files, native repair/remesh, geometry queues, selection state. Some deserve tidying (a separate useViewerSettings hook) but are not scene rules.

*90 operations mapped (11 mostly pure, 41 with an implicit target). Effort —, risk —. Depends on: decisions D4/D17/D19.*

- (optional refactor) useViewerSettings hook — shrinks the return object by ~1/4
- (optional) selection reducers as pure helpers, never as rule inputs (ADR rule 3)
- (optional) repair/remesh behind a native-geometry service, not a pure module

**Why here:** Listed so the map is complete and nobody spends a PR extracting UI plumbing.

## Extraction order

Dependencies first, then the groups that are already nearly pure. Groups 2 and 3 can run in
parallel with group 1 once the foundation tests exist.

| Order | Group | Effort | Risk | Depends on |
| --- | --- | --- | --- | --- |
| 0 | Foundations: pins and seams | S–M | Med | — |
| 1 | Plates, phase 2 | M | Med | foundation |
| 2 | Model fields (quick wins) | S each | Low (designation: Med) | foundation |
| 3 | Grouping | S (after decision D5) | Med (file format) | decision D5 |
| 4 | Save input (export-save) | M | High (file format) | foundation, decision D9 |
| 5 | Delete | M | High (support geometry) | plates, decision D13 |
| 6 | Volume bounds and seating | M | High (slicing output) | plates, decisions D11/D12 |
| 7 | Placement and duplicate layout | L | Med | plates, bounds-seat, decision D6 |
| 8 | Transform | L | High (undo core, support geometry) | plates, model-fields, decisions D1/D2/D3 |
| 9 | Import / VOXL open | L | High (file formats) | plates, placement, save, decisions D7/D8 |
| 10 | Split and merge geometry | L | High (orientation, support geometry) | transform, decision D1 |

Each PR follows the ADR's recipe: tests that pin today's behaviour, then the move, with the manager
and the CLI calling the same function, and a parity test as the definition of done (plus a
`check:scene-slice` case when the rule changes what is sliced).

## CLI and GUI parity

Each user-level GUI operation against the TypeScript CLI. **Full** = same rule, tested;
**Partial** = a command exists but restates the rule or skips part of it; **Missing** = no command.

| Area | GUI operation | CLI | Status | Gap |
| --- | --- | --- | --- | --- |
| Scene | New scene | scene create | **Partial** | CLI makes an empty doc; app keeps extra plates (B12) and resets UI state. |
| Scene | Open scene (VOXL) | scene load | **Partial** | CLI parses and prints only; app normalises names, applies prefs, remaps ids, re-lays plates, prompts. load counts 6 support collections. |
| Scene | Save / autosave | (every saving command) toBuildInput | **Partial** | Plates/printer now kept. Drops ORIG chunks and sha map (B2); Ctrl+S drops hidden models (B3). |
| Scene | Import mesh (STL/OBJ/3MF) | scene add-model | **Partial** | CLI: origin placement, no plate, no free spot, no seat Z, fixed colour, polygonCount 0, no repair. |
| Scene | Import plugin scene / support JSON | — | **Missing** |  |
| Scene | List models | scene list-models | **Full** | Read-only. |
| Models | Delete model(s) | scene remove-model | **Partial** | Orphans 5 support types (B7); no link dissolve; no empty-scene plate collapse. |
| Models | Rename model | — | **Missing** |  |
| Models | Show / hide model | — | **Missing** |  |
| Models | Model colour | — | **Missing** |  |
| Models | Mark as support (designation) | — | **Missing** | Affects slicing. |
| Models | Link / unlink models | — | **Missing** |  |
| Transform | Move / rotate / scale | scene transform-model | **Partial** | CLI overwrites the vector: no supports, no link peers, no plateId restamp, no lock. |
| Transform | Center on plate | scene center-xy | **Partial** | CLI sets 0,0; app uses plate centre/origin mode and keeps multi-select layout. |
| Transform | Drop / lift to plate | scene place-on-platform | **Partial** | CLI uses raw mesh min Z, ignores rotation/scale/lift (B8). |
| Transform | Auto orient / place on face / mirror | — | **Missing** |  |
| Grouping | Group / ungroup | scene group / ungroup | **Partial** | Different storage; neither sees the other's groups (B6). |
| Grouping | List groups | scene list-groups | **Partial** | Always 0 on an app-saved scene. |
| Grouping | Rename group | — | **Missing** |  |
| Duplicate/arrange | Duplicate with layout | scene duplicate | **Partial** | CLI: fixed offset, different names, no group, no supports; copies may be meshless (B1). |
| Duplicate/arrange | Arrange | scene arrange | **Partial** | Same algorithm, but CLI packs all onto plate 1: no offsets, locks, new beds, support footprints. |
| Clipboard | Copy / cut / paste | — | **Missing** | Clipboard is UI; paste placement is a rule (placement group). |
| Plates | Add / remove / rename plate | — | **Missing** | CLI can keep plates through a save but not change them. |
| Plates | Move models to plate | — | **Missing** |  |
| Plates | Set active plate / lock plate | — | **Missing** | Session state; see D3. |
| Slicing | Slice one plate | scene slice --plate | **Full** | ADR 'done': assembleSliceJob + plateLayout + cliJobParity + check:scene-slice. Gaps: origin mode (B20), disjoint-model drop (D11). |
| Export | Export STL | scene export-stl | **Partial** | CLI reads STLs from --mesh-dir, merges all plates, no supports/raft/plate scope. |
| Supports | Add support entities | support add-* | **Partial** | Restated field by field (ADR cites add-trunk); leaf/stick cones lack id/profile (unconfirmed). |
| Supports | Edit / remove / straighten | support update / remove / straighten-segment | **Partial** | remove doesn't cascade from a knot. |
| Supports | Split / merge supports from model | — | **Missing** | VOXL keeps classification, so feasible. |
| Repair | Repair / remesh / undo repairs | — (Rust CLI has mesh tools) | **Missing** | Likely out of scope (D19). |
| Hollowing | Hollow / hole punch / organic cut | — | **Missing** | Outside this hook; implicit active-model target. |

2 full, 15 partial, 15 missing. Only `scene slice` meets the ADR's bar today; `scene arrange`
shares the algorithm but not the plate handling. The spreadsheet's *CLI commands* sheet lists, per
command, the rules it restates by hand.

## Decisions for Ender

Where the core/UI line is unclear. Each is a question with options, not a recommendation, except
where a pass had a clear lean (noted in the spreadsheet).

**D1. Does THREE count as impure for maths-only use?**

- Options: (a) Allow three's maths classes (Vector3, Euler, Quaternion, Matrix4, Box3) in pure modules — status quo in selection*.ts and arrange/. (b) Plain {x,y,z} types only, convert at the edges. (c) Allow maths classes, ban BufferGeometry/Object3D.
- Why: ADR says 'no THREE', but highPrecisionArrange (the ADR's own success example) and the selection helpers import it. Every transform/placement extraction depends on this.
- Affects: transform, placement, geometry-split

**D2. What does a transform carry with it?**

- Options: (a) One planModelTransforms returns model updates + support deltas + link-peer updates + plateId restamp; CLI transform-model then moves supports and peers too. (b) CLI stays a raw setter, difference documented. (c) Both, via a --raw flag.
- Why: Today supports move by side effect inside the hook; CLI moves nothing but the model.
- Affects: transform

**D3. Are plate locks core or UI?**

- Options: (a) Session UI state: guards stay in the manager, CLI ignores locks. (b) Rules take lockedPlateIds and return refused ids, so the CLI or an agent can honour them.
- Why: Lock is per-session, not saved. Checked in the manager and again in page.tsx handleTransformStart; raw setters bypass it.
- Affects: plates, transform, placement

**D4. Is selection part of the core?**

- Options: (a) Selection never enters a rule (ADR rule 3); reducers may be pure helpers but rules take ids and don't return a next selection. (b) Rules also return the next selection (as applyModelGrouping does today).
- Why: ~30 page.tsx rules and mergeSupports/copySelectedModels read the selection implicitly.
- Affects: all

**D5. Where do groups live in the file?**

- Options: (a) groupId/groupName on VoxlModelEntry, like linkGroupId; CLI moves to model fields. (b) App reads/writes extensions.groups. (c) Groups are UI-only; drop CLI group commands.
- Why: App groups are lost on every save; CLI groups are invisible to the app and stripped by an app save.
- Affects: grouping, duplicate

**D6. One placement engine or several?**

- Options: (a) One findFreeSpots for import, paste and CLI (ring grid + overflow), extracted as-is. (b) Rebase on arrange/plateFreeSpace + shelfPack (better packing, positions change). (c) Extract each as-is for parity, merge later.
- Why: Import, paste and plugin import use three engines; overlap tests disagree on touching edges.
- Affects: placement

**D7. How do imports handle user prompts when headless?**

- Options: (a) Split into plan (returns needs[]) and apply (takes answers). (b) A policy object { placement, hollowing, repair } — app passes resolvers, CLI passes fixed answers.
- Why: Headless defaults today: placement 'auto_arrange' (contradicts the 'preserve authored placement' comment), hollowing 'bake', repair 'repair'.
- Affects: import

**D8. Should opening a VOXL change it, and does open merge or replace?**

- Options: Content: (a) open exactly as saved, prefs only for mesh imports; (b) keep today's normalisation and make CLI load apply the same pure step; (c) explicit 'normalize on open' option. Merge: (a) open replaces and clears history, separate import merges; (b) keep merge and push one undo entry.
- Why: Open strips dotted name suffixes, applies import-default support/raft prefs, remaps colliding ids, re-lays plates, ignores the saved plate ordering, and pushes no undo.
- Affects: import, save

**D9. Is the saved model set 'all' or 'visible'?**

- Options: (a) All, always — fix Ctrl+S to match autosave and CLI. (b) Visible only, everywhere. (c) Explicit scope parameter on buildVoxlSaveInput.
- Why: Ctrl+S saves visible models only (page.tsx ~4561, code checked); autosave and CLI save all.
- Affects: save

**D10. Who owns plate ordering and origin mode?**

- Options: (a) Document state: saved, undoable, restored by snapshots. (b) Settings, but recorded in snapshots and files the way the printer is. (c) As today, documented as lossy.
- Why: ADR-0045's own open question (originMode not in VOXL, CLI assumes centre). Ordering is a global setting written to each file; changing it moves models with no undo; open ignores the saved value.
- Affects: plates, import, bounds-seat

**D11. One out-of-bounds rule, and should `scene slice` drop models outside the volume?**

- Options: (a) One modelsOutsideVolume with flags (overlap vs containment, margins, supports). (b) Two named functions ('for slicing', 'for warning') in one module. Plus yes/no on CLI dropping disjoint models.
- Why: Four copies today; the app drops disjoint models from a slice, the CLI doesn't.
- Affects: bounds-seat

**D12. Seat Z, Auto Lift and manualZMoveOverride as inputs?**

- Options: (a) Pass liftDistance/autoLift/manualZMoveOverride explicitly; CLI place-on-platform gets --lift. (b) Persist manualZMoveOverride (and lift settings?) in VOXL. Also: unify 0 / 0.001 / lift distance targets?
- Why: manualZMoveOverride changes what lift/drop does but isn't saved; loaded models start with it true.
- Affects: bounds-seat, transform

**D13. Who owns support removal for a model?**

- Options: (a) Split deleteSupportsForModel into pure compute + apply; CLI runs the compute on doc.supports via an adapter. (b) Keep the CLI's hand filter and add the missing types.
- Why: Only (a) gives a parity test.
- Affects: delete

**D14. Which fields does a derived model keep?**

- Options: (a) One deriveModelFrom rule for split, merge, paste and duplicate. (b) Per operation, documented.
- Why: Split/merge/paste drop plateId, group, link group and modifiers inconsistently; CLI duplicate copies fields the app drops.
- Affects: placement, geometry-split

**D15. Should transform history become a pure 'edit session'?**

- Options: (a) Leave the pending-history refs/RAF machinery in page.tsx (handoff doc's advice). (b) Fold into useTransformManager. (c) A pure begin/update/commit reducer that produces the history payload, so CLI/agents get identical labels.
- Why: Only (c) lets non-GUI clients produce the same history labels; it is also the most work.
- Affects: transform, foundation

**D16. Which undo gaps are bugs vs by design?**

- Options: Per item: mesh import, VOXL open, support-JSON import, undoRepairsInPlace, scan-for-supports, plate-ordering change, plate rename. Options each: (a) push history, (b) document as not undoable.
- Why: None of these push history today.
- Affects: foundation

**D17. Move viewer settings out of the manager now?**

- Options: (a) Yes, a useViewerSettings hook (low risk, ~35 return keys). (b) Later.
- Why: Not scene rules; they make the manager's surface look bigger than the scene core is.
- Affects: stays-in-app

**D18. Delete dead API before extracting?**

- Options: (a) Remove: addModelFromGeometry, finalizeModelGeometryPostProcessing, deferPostProcessing, cutModel, pasteModel, modelPlateFrame, setMeshVisible, handleLoadSupportJson, two-step plugin import stubs, onImportSceneChange, importPluginSceneFile (external). (b) Keep for plugins/tests.
- Why: Each has no caller in src/ (moveModelsToPlate is test-only). Removing first shrinks what has to be mapped and tested.
- Affects: foundation

**D19. Repair and remesh: in scope?**

- Options: (a) Out of ADR-0045 scope — native I/O behind a service. (b) Extract the small rules (which report needs attention, auto-repair gate) only.
- Why: Four functions of native/Tauri work with almost no scene rule in them.
- Affects: stays-in-app

**D20. What does 'center' mean on plate 2?**

- Options: (a) Centre of the plate the model stands on (cascade offset included), app and CLI. (b) Origin plate, as today.
- Why: App centres on plate 1 even for a model on plate 2 (suspected); CLI center-xy sets 0,0 regardless of origin mode.
- Affects: transform

**D21. Bring plateLayout.ts fully in line with ADR rule 4?**

- Options: (a) Change resolveModelPlateId(model, frames) to resolveModelPlateId({ model, frames }) now, while it has few callers. (b) Leave it.
- Why: The worked example takes two positional arguments.
- Affects: plates

## What to pin before each extraction

**Foundations: pins and seams**

- App-written multi-plate scene with duplicate meshes, originals, every support type, link groups → CLI load → transform-model no-op → save → deep compare (fields + chunks).
- Snapshot registry: eviction at 200 pairs / ~300 MB, evicted key → entry discarded (characterise as-is).

**Plates, phase 2**

- computePlateFrames vs every hand-computed rect site (defaultImportCenterXY, activePlateRect, plateOffsetFor, addPlates, moveModelsToPlate, seatModelOnNewBedIfNeeded, VOXL load) for both origin modes and both orderings.
- modelsShiftedForRelaidPlates golden cases: printer switch, ordering switch, add/remove plate; supports shifted with models (pins B5).
- removePlate refuses first plate; dropPlates currently allows it (pin as-is).

**Model fields (quick wins)**

- Each setter: input models + ids → output models; history label unchanged (DOM test reads the label).
- Support designation: check:scene-slice case where a designated model changes the sliced output.
- Replace voxlSupportDesignation.test.ts's inline copy with a call to the real function.

**Grouping**

- After D5: group in app → save → CLI list-groups shows it, and the reverse.
- modelGroupingHistory existing tests stay green.

**Save input (export-save)**

- Four savers (autosave, Ctrl+S, export panel, CLI) given the same scene produce the same BuildVoxlDocumentInput, except for documented scope differences.
- Hidden model + Ctrl+S (pins B3).

**Delete**

- Scene with every support type, a 2-member link group, 2 plates: delete one model → app result == CLI result (supports, link groups, plates).
- Delete last model → plates collapse (app); undo restores modifiers? (pins B14).

**Volume bounds and seating**

- One fixture per out-of-bounds copy (resin estimate, sliceable, warning, SceneCanvas) with models inside, overlapping, outside; record each copy's answer today.
- Seat Z for unrotated/rotated/scaled off-centre mesh: selectionLiftDrop vs performAutoSnap vs SceneCanvas vs CLI place-on-platform (pins B8).

**Placement and duplicate layout**

- Import free-spot, paste, plugin import and duplicate preview: golden positions for fixed footprints/blockers on 1 and 2 plates, including overflow to a new bed.
- Touching-edge overlap behaviour of intersectsRect vs plateFreeSpace.rectsOverlap.
- Derived-model field lists for split, merge, paste, duplicate (what's kept today).

**Transform**

- updateModelTransform vs updateModelTransforms on the same input: link peers, supports, plateId, landedPlateId, lock refusal — record the drift.
- Link-peer propagation: replace linkGroupTransformPropagation.test.ts's own copy with the manager path.
- center on plate 2 (pins B10), transform tolerance epsilons.

**Import / VOXL open**

- Open an app-saved VOXL: names, supports (prefs applied), ids on collision, plate shift on printer mismatch, ordering adoption — snapshot the app's result.
- Headless prompt defaults (placement/hollowing/repair).

**Split and merge geometry**

- Split a model rotated about two axes: part world positions (pins B4).
- Split/merge supports round trip keeps triangle count and classification.

Most operations in the spreadsheet also have a row-level *Test first* entry.

## Suspected bugs found while mapping

To pin with tests, not to fix inside an extraction PR. *How sure* says whether the code was
re-checked by hand or is a mapping pass's reading.

| ID | Suspected bug | Where | How sure | Impact |
| --- | --- | --- | --- | --- |
| B1 | CLI `scene duplicate` likely saves copies with no mesh | dragonfruit-ts-cli.ts:85-90, 352-384 | Code checked: toBuildInput looks up mesh bytes by model id; the copy's new id has none. Not run. | High |
| B2 | CLI save drops ORIG (full-res original) chunks and the sha map | dragonfruit-ts-cli.ts:85-114 | Agent-reported (two agents agree); not run. | High |
| B3 | Ctrl+S saves only visible models (and their supports) | page.tsx:4561-4562 | Code checked. | Med |
| B4 | splitModelIntoParts uses a different Euler order from the renderer | useSceneCollectionManager.ts:3785 vs StlMesh.tsx:583 | Code checked: new THREE.Euler(x,y,z) vs quaternionFromGlobalEuler. Agent computed 4.1 mm offset at (0.5,0.7,0.3). | High |
| B5 | addPlates shifts models but not their supports | useSceneCollectionManager.ts:7886-7917 | Code checked: no shiftSupportsWithModels call (addPlate has two). | High |
| B6 | App groups are never saved; CLI groups are invisible to the app | `VoxlModelEntry / extensions.groups` | Code checked: no groupId/groupName in src/features/scene/voxl/. | Med |
| B7 | CLI remove-model orphans knots, twigs, sticks, stumps, kickstands | dragonfruit-ts-cli.ts:269-297 | Code checked: filters roots, trunks, branches, leaves, braces only. | High |
| B8 | CLI place-on-platform ignores rotation and scale; CLI transform maths subtracts bbox centre only when rotated/scaled | dragonfruit-ts-cli.ts:1029-1066, 1309-1355 | Code checked for center-xy (sets x=y=0); place-on-platform agent-reported with line refs. | High |
| B9 | Blocker reset always empties the list (`resolutionChanged ? [] : []`) | page.tsx:10075 | Code checked. | Low |
| B10 | Center sends a model on plate 2 to plate 1's centre | page.tsx:9171-9189 | Agent-reported, Med confidence. | Med |
| B11 | Auto Orient apply reads the active model's transform for any modelId | page.tsx:2456-2479 | Agent-reported. | Low |
| B12 | New Scene keeps extra plates; select-all + Delete removes them | page.tsx:5067-5105 | Agent-reported. | Low |
| B13 | Mesh-repair confirm prompt isn't released on unmount (import can hang) | useSceneCollectionManager.ts:1825-1838 | Agent-reported. | Low |
| B14 | Undoing a delete may not restore hollowing/hole-punch modifiers | useSceneCollectionManager.ts:4744-4894 | Agent suspicion; snapshot has no modifierRecord. | Med |
| B15 | Plate-ordering change moves models with no undo; undo across it restores old-layout positions | useSceneCollectionManager.ts:7774-7793 | Agent-reported. | Med |
| B16 | selectModel(id,'toggle') on a selected model still makes it active | useSceneCollectionManager.ts:2652-2670 | Agent-reported. | Low |
| B17 | Imported models stamped with the active plate's id even when placed on another bed | useSceneCollectionManager.ts:2693-3058 | Agent-reported, Med. | Med |
| B18 | Recent-files writes storage inside a React state updater (can run twice) | useSceneCollectionManager.ts:2547-2632 | Agent-reported. | Low |
| B19 | Ctrl+S callback dependency list omits plates/printer/ordering (possible stale save) | page.tsx:4654 | Agent-reported; React Compiler may mask. | Med |
| B20 | CLI `scene slice` assumes centre origin and ignores meta.printer | dragonfruit-ts-cli.ts:1410-1439 | Code checked (comment says so). Matches ADR open question. | Med |

## Appendix A: operations in the manager, by group

Compact form of the spreadsheet's *Operations* sheet. Lines are in `useSceneCollectionManager.ts`
unless a file is named. Ret = returned by the hook. Imp = implicit target. E/R/C = effort, risk,
confidence. Helper and Undo are first clauses only.

### Foundations: pins and seams

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **scene-snapshot-registry** — The scene undo store. | 281-300, 345-351, 508-578 |  | No | Mixed | createTypedHistory (@/history/typedHistory) | Is the undo core: payload {key, modelId?}; | None | M/High/High |
| **capture-scene-snapshot** — Builds an undo snapshot: shallow-clones each model (transform vectors cloned, meshModifie… | 302-348, 353-359, 370-377, 441-470 |  | Yes | Mixed | clonePlainData (support state) | Produces the before/after halves every histo… | None | S/High/High |
| **clone-mesh-modifiers** — Copies a model's mesh-modifier record (hollowing, hole punches, applied placements). | 389-418 |  | No | Mostly pure | None | Used to build modifierRecord on snapshots. | None | S/Low/High |
| **store-scene-snapshot-pair** — Module-level registry that holds heavy snapshot pairs. | 508-577 (outside range; called by pushSceneSnapshotHistory) |  | No | Mostly pure | None | Eviction makes older undo entries decline (s… | None | S/High/High |
| **get-scene-snapshot-registry-bytes** — Exported reader of the registry's deduplicated geometry byte total, for the history debug… | 553-555 |  | No | Mostly pure | estimateSceneSnapshotRegistryBytes | None | None | S/Low/High |
| **scene-data-types** — The app's runtime scene shape: models with id/name/group/link/plateId/transform(THREE)/ge… | 1063-1102, 1125-1131, 1307-1319 |  | Yes | Mostly React | PlateMember (plateLayout) is the narrow stru… | n/a | n/a | S/Low/High |
| **core-scene-state** — The scene's model list, active model and selection, mirrored into refs every render so st… | 1472-1474, 1580-1592 | ✓ | Yes | Mostly React | None | setActiveModelId/setSelectedModelIds are raw… | n/a | S/Low/High |
| **apply-scene-snapshot** — Puts a stored scene state back (undo/redo). | 2281-2341 |  | No | Mixed | cloneLoadedModel, cloneMeshModifiersForHisto… | Is the undo core: called by the SCENE_MODELS… | None | M/High/High |
| **scene-snapshot-history-handler** — Registers the one scene undo/redo handler. | 2343-2360 |  | No | Mostly React | createTypedHistory (src/history/typedHistory… | Registers handler for SCENE_MODELS_SNAPSHOT_… | None | S/High/High |
| **push-scene-snapshot-history** — Stores a {before, after} snapshot pair in the module registry (with eviction) and pushes… | 2362-2369 |  | No | Mostly pure | storeSceneSnapshotPair (module, 557-577), sc… | This IS the push: type SCENE_MODELS_SNAPSHOT… | None | S/High/High |
| **return-object-surface** — The hook's public surface: 153 keys (list in rows/return-keys.txt), grouped by comments i… | 8113-8288 | ✓ | Yes | Mostly React | None | None | None | S/Low/High |

### Plates, phase 2

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **shift-supports-with-models** — After a bed relayout moves models (printer switch, ordering change, plate removal), moves… | 493-500 |  | No | Mixed | transformSupportsForModel (supports/state) | None itself; | None | M/High/High |
| **plates-state** — Plate list (starts with one unnamed plate) and active plate; | 1475-1493, 1522-1523 | ✓ | Yes | Mostly React | None | Plates are recorded on snapshots only by ent… | Partial | S/Low/High |
| **plate-name** — Active plate's name (the plate widget edits it; | 1494-1502 | ✓ | Yes | Mostly pure | None (renamePlate at 7959 is the explicit-id… | None (by design: plate renames are not histo… | None | S/Low/High |
| **plate-lock** — Per-plate session lock (not saved). | 1503-1520 | ✓ | Yes | Mostly React | None | None (session state). | None | S/Low/High |
| **model-plate-id** — The plate a model stands on (position inside a frame wins; | 1524-1538 |  | No | Mostly pure | resolveModelPlateId (plateLayout) | None | Full | S/Low/High |
| **plate-lock-guards** — Lock checks: is the plate this model stands on locked; | 1539-1554 | ✓ | Yes | Mostly pure | resolveModelPlateId | None | None | S/Low/High |
| **locked-plate-notice** — When a guard refuses a gesture, names which locked plate refused it (the bed it would lan… | 1555-1570, 1589 |  | No | Mixed | resolveModelPlateId | None | None | S/Low/High |
| **clear-empty-plate-name** — When the scene has no models and only one plate, clears that plate's name so the widget s… | 1571-1579 |  | Yes | Mostly React | None | None (not recorded; | None | S/Low/High |
| **printer-profile-subscription** — Subscribes to the global printer/material profile store and derives the active printer pr… | 1869-1870 |  | Yes | Mostly React | getActivePrinterProfile (profileStore) | Indirect: snapshots record printerProfileId; | Partial | S/Med/High |
| **multi-plate-ordering** — Subscribes to multi-plate preferences: whether the active plate follows a model dropped o… | 1871-1888 | ✓ | Yes | Mostly React | plateOrderingFor (multiPlatePreferences), Pl… | Ordering change relayout effect 7774 uses ap… | Partial | S/Med/Med |
| **voxl-printer-bundle** — What a save embeds as the scene's printer: the active profile plus its materials, as a Vo… | 1912-1923 | ✓ | Yes | Mostly pure | toVoxlPrinterBundle, getMaterialProfilesForP… | None | Partial | S/Med/High |
| **active-plate-rect** — Active plate's build-volume rectangle in world coordinates. | 2030-2046 |  | Yes | Mostly pure | plateLocalRect, plateCascadeOffsetMm | None | Partial | S/Low/High |
| **voxl-load-printer-relayout** — When the file records meta.printer.buildVolumeMm and has 2+ plates, moves each model by t… | 6646-6668 |  | Yes | Mostly pure | modelsShiftedForRelaidPlates (hook), plateCa… | None | None | M/High/High |
| **plate-offset-for** — Cascade offset (dx, dy mm) of a plate by id: its index in the plate list, the current foo… | 7580-7587 | ✓ | No | Mostly pure | plates/plateCascade.ts plateCascadeOffsetMm | None | Partial | S/Low/High |
| **plate-forward-refs** — Forward-declaration refs so callbacks declared earlier in the hook (paste overflow, impor… | 7596-7602 (+ assignment 7917) |  | Yes | Mostly React | None | None | None | S/Low/High |
| **models-shifted-for-relaid-plates** — When the bed grid is re-laid (plate added/removed, ordering switched, footprint changed),… | 7622-7678 |  | No | Mostly pure | plateCascadeOffsetMm, plateLocalRect (plates… | None (callers push) | None | S/Med/High |
| **relay-on-printer-switch** — When the active printer or its build footprint changes, shifts models (and their world-sp… | 7688-7762 |  | Yes | Mixed | modelsShiftedForRelaidPlates, shiftSupportsW… | pushSceneSnapshotHistory(before, after, swit… | None | M/High/Med |
| **relay-on-ordering-change** — When the Multi-Plate 'ordering' setting changes (fixed/dynamic or column count), shifts m… | 7774-7793 |  | Yes | Mixed | modelsShiftedForRelaidPlates, shiftSupportsW… | None (by design). | Partial | S/Med/Med |
| **add-plate** — Appends one empty plate (new uuid, empty name) after the last; | 7795-7832 | ✓ | Yes | Mixed | modelsShiftedForRelaidPlates, shiftSupportsW… | pushSceneSnapshotHistory(before, after, addP… | None | S/Med/High |
| **drop-plates** — Removes named plates WITHOUT touching their models (for an arrange run about to move them… | 7847-7870 | ✓ | No | Mixed | modelsShiftedForRelaidPlates, shiftSupportsW… | None — folded by caller (useArrangeManager p… | None | S/Med/High |
| **add-plates** — Appends `count` empty plates and returns { plates, added, offsets } — every bed's final c… | 7886-7917 | ✓ | No | Mixed | modelsShiftedForRelaidPlates, plateCascadeOf… | None — folded by caller (arrange, duplicate,… | None | S/Med/Med |
| **activate-plate** — Makes a plate the one being worked on: clears selection and active model, sets activePlat… | 7919-7932 | ✓ | No | Mostly React | None | None (active plate is not a history step) | None | S/Low/High |
| **plate-frames** — Every plate's world rect and cascade offset, memoized from plates, footprint (width, dept… | 7940-7945 | ✓ | No | Mostly pure | plates/plateLayout.ts computePlateFrames (do… | None | Full | S/Low/High |
| **resolve-model-plate-id** — The plate a model stands on: frame containing its XY, else its stored plateId if that pla… | 7948-7951 | ✓ | No | Mostly pure | plates/plateLayout.ts resolveModelPlateId | None | Full | S/Low/High |
| **model-plate-frame** — The PlateFrame of the plate a model stands on, falling back to the first frame. | 7954-7957 | ✓ | No | Mostly pure | resolveModelPlateId (plateLayout) | None | None | S/Low/High |
| **rename-plate** — Sets a plate's name by id. | 7959-7961 | ✓ | No | Mostly pure | None | None — deliberately (comment at 1476-1479: '… | None | S/Low/High |
| **remove-plate** — Deletes a plate and every model standing on it (by position), as one history step. | 7968-8020 | ✓ | No | Mixed | modelsOnPlate (plateLayout), modelsShiftedFo… | One pushSceneSnapshotHistory(before, after,… | None | M/High/Med |
| **delete-models-and-extra-plates** — Select-all delete: deletes the given models and, if no surviving model stands on a bed ot… | 8034-8075 | ✓ | No | Mixed | modelPlateId (-> plateLayout.resolveModelPla… | One pushSceneSnapshotHistory(..., DELETE_MOD… | None | S/Med/High |
| **move-models-to-plate** — Moves models to another plate keeping their position relative to their bed: each is trans… | 8082-8111 | ✓ | No | Mixed | plateCascadeOffsetMm, modelPlateId (plateLay… | None — no commitModelTransformHistory call,… | None | S/Med/High |
| **active-plate-name-and-lock** — Active-plate name and setter (edits whichever plate is active), and per-plate session loc… | 8117-8118, 8138-8141 (defined 1497-1545) | ✓ | Yes | Mostly React | resolveModelPlateId (plateLayout) | None (name and locks are not history) | None | S/Low/High |
| **plate-state-passthrough** — Plate document state (plates list, active plate id), a counter that tells the canvas to s… | 8119-8131 (state declared 1480-1490, 1883-1888) | ✓ | Yes | Mostly React | plateOrderingFor (components/settings/multiP… | plates/activePlateId captured in snapshots w… | Partial | S/Low/High |

### Model fields (quick wins)

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **set-model-visibility** — Shows/hides one model; | 4082-4094 | ✓ | No | Mostly pure | captureSceneSnapshot, showModelLabel/hideMod… | Snapshot pair (no support state), label show… | None | S/Low/High |
| **rename-model** — Renames one model; | 4166-4178 | ✓ | No | Mostly pure | captureSceneSnapshot, renameLabel | Snapshot pair (no support state), label rena… | None | S/Low/High |
| **set-mesh-color** — Sets the preferred mesh colour (persisted in appearance settings) and, if there is an act… | 7088-7104 | ✓ | Yes | Mixed | clampHexColor (module fn 609), paintModelBas… | pushSceneSnapshotHistory(before, after, colo… | None | S/Low/High |
| **set-mesh-visible** — Shows or hides the active model (delegates to setModelVisibility with an undo step). | 7106-7110 | ✓ | Yes | Mostly React | setModelVisibility (4082) | Via setModelVisibility: pushSceneSnapshotHis… | None | S/Low/Med |
| **toggle-support-designation** — Marks the given models as support geometry or as normal models (isSupportGeometry flag),… | 7112-7135 | ✓ | No | Mostly pure | None | pushSceneSnapshotHistory(before, after, MARK… | None | S/Med/High |
| **link-models** — Links 2+ models together under a new linkGroupId (linked models follow each other's trans… | 7137-7161 | ✓ | No | Mostly pure | None | pushSceneSnapshotHistory(before, after, link… | None | S/Low/High |
| **unlink-models** — Removes the given models from their link groups, then dissolves any affected group left w… | 7163-7199 | ✓ | No | Mostly pure | None | pushSceneSnapshotHistory(before, after, unli… | None | S/Low/High |

### Grouping

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **group-models** — Puts the given models in one folder-style group (groupId + groupName on each model). | 4180-4203 | ✓ | No | Mostly pure | modelGroupingHistory.ts applyModelGrouping | pushSceneSnapshotHistory, full scene snapsho… | Partial | S/Low/High |
| **list-groups** — There is no list-groups operation in the hook. | 4180-4241 |  | No | Mostly React | None | None | Partial | S/Low/High |
| **ungroup-models** — Removes groupId/groupName from the given models (only those currently grouped). | 4205-4222 | ✓ | No | Mostly pure | modelGroupingHistory.ts applyModelUngrouping | pushSceneSnapshotHistory snapshot, label ung… | None | S/Low/High |
| **ungroup-group** — Dissolves a whole group by id: clears groupId/groupName on every member. | 4224-4241 | ✓ | No | Mostly pure | modelGroupingHistory.ts applyModelGroupUngro… | pushSceneSnapshotHistory snapshot, label ung… | Partial | S/Low/High |
| **rename-group** — Sets groupName (trimmed) on every member of a group. | 4712-4729 | ✓ | No | Mostly pure | None (not in modelGroupingHistory.ts, though… | pushSceneSnapshotHistory, label renameLabel(… | None | S/Low/High |

### Save input (export-save)

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **chunk-store-bake** — Copy-on-write mesh chunk store upkeep: lazily loads ExportManager and, in idle time, bake… | 1331-1398 |  | No | Mostly React | ExportManager.bakeModelGeometryChunk / retai… | None | None | S/Low/High |
| **voxl-format-chunked-ref** — Remembers whether the last loaded .voxl used the chunked 3.1 layout so autosave keeps an… | 1584-1588 | ✓ | Yes | Mostly React | None | None | Partial | S/Med/High |
| **chunk-store-sweep-effect** — Whenever the models array changes and is non-empty, schedules a coalesced idle sweep of t… | 1594-1601 |  | No | Mostly React | scheduleChunkStoreSweep | None | None | S/Low/High |
| **save-cli-tobuildinput** — CLI save: re-serialises the in-memory VoxlDocumentV1 with models verbatim, scene cursor,… | dragonfruit-ts-cli.ts:85-114 |  | Yes | Mostly pure | serializeVoxlDocumentV2 | None | Full | S/High/Med |
| **save-export-panel** — Export panel VOXL bundle: writes the scoped models (active model / current plate / all) w… | ExportPanel.tsx:335-490 (VOXL context at 380-395 and 458-463) |  | Yes | Mostly React | ExportManager.exportScene, resolvePlateOutpu… | None | None | M/Med/Med |
| **save-autosave** — Periodic/dirty-triggered save of ALL models to the autosave path (beside the project), wi… | useSceneAutosave.ts:501-712 |  | Yes | Mostly React | ExportManager.exportScene, VoxlChunkCache | None | None | S/Med/High |
| **save-export-scene-dispatch** — Entry for every save/export: picks the native save path first (or uses the given one; | ExportManager.ts:893-1082 |  | Yes | Mostly React | pickSavePathWithNativeDialog, buildScopedSup… | None | Partial | L/High/High |
| **save-export-voxl** — The app's VOXL writer front end: snapshots supports (scoped to the given models when any… | ExportManager.ts:1120-1454 |  | No | Mixed | serializeVoxlDocumentV2(Streaming) (voxl/cod… | None | Partial | M/High/High |
| **save-topbar-ctrl-s** — Ctrl+S / Save As: captures a thumbnail with cross-section clipping off, then saves VOXL w… | page.tsx:4557-4654 |  | Yes | Mostly React | ExportManager.exportScene | None | Partial | S/High/Med |

### Delete

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **delete-models** — Deletes models by id with everything attached: releases mesh chunks, revokes blob URLs, d… | 4744-4894 | ✓ | No | Mixed | SupportModelLinker.ts getSupportsForModel/de… | pushSceneSnapshotHistory with plates+activeP… | Partial | M/High/Med |
| **delete-models-link-dissolve** — After removing models, any link group that now has fewer than 2 members has linkGroupId c… | 4819-4834 |  | No | Mostly pure | None | Part of deleteModels snapshot | None | S/Low/High |
| **delete-models-empty-scene-plates** — If the delete leaves zero models and there is more than one plate, keep only the first pl… | 4838-4853 |  | No | Mostly pure | None (belongs next to plates/plateLayout.ts) | plates + activePlateId captured in both snap… | None | S/Low/High |
| **delete-models-support-cascade** — For each deleted model, removes all support entities with that modelId across every regis… | 4861-4879 |  | No | Mixed | src/supports/PlacementLogic/SupportModelLink… | Captured by includeSupportState snapshot | Partial | M/High/High |
| **delete-model** — Single-id wrapper: fire-and-forget deleteModels([id]). | 4896-4898 | ✓ | No | Mostly React | deleteModels | via deleteModels | Partial | S/Low/High |
| **delete-supports-for-models** — Removes all supports of the given models (only those that have any) in one undoable step; | 4900-4936 | ✓ | No | Mixed | SupportModelLinker.ts deleteSupportsForModel… | pushSceneSnapshotHistory includeSupportState… | None | S/High/High |
| **delete-active-model-handler** — Registers with the global delete registry (priority 10): in prepare mode with an active m… | 7069-7081 |  | Yes | Mostly React | registerDeleteHandler (features/delete/delet… | Via deleteModel | Partial | S/Low/Med |

### Volume bounds and seating

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **set-model-manual-z-move-override** — Flags a model as 'Z set by hand' so Auto Lift/seat-on-plate leaves it alone (page.tsx sea… | 4154-4164 | ✓ | No | Mostly pure | None | None (but it rides along in any later snapsh… | None | S/Med/High |
| **scene-bounds** — World-space bounding box of every visible model: each model's cached geometry bbox is re-… | 7536-7572 | ✓ | No | Mixed | quaternionFromGlobalEuler (@/utils/rotation) | None | None | S/Low/High |

### Placement and duplicate layout

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **default-import-center** — World XY where new work lands: the centre of the active plate (local centre from originMo… | 2001-2022 |  | Yes | Mostly pure | plateLocalRect (plateLayout), plateCascadeOf… | None | None | S/Med/High |
| **intersects-rect** — Axis-aligned rectangle overlap test (touching edges count as overlap). | 2024-2028 |  | No | Mostly pure | None (duplicated inline in pasteCopiedModels… | None | None | S/Low/High |
| **is-rect-inside-plate** — Whether a world rect lies fully within the active plate's rect (edges inclusive). | 2048-2055 |  | Yes | Mostly pure | None | None | None | S/Low/High |
| **footprint-for-transform** — Width/depth of a model's footprint on the bed, projected through its full rotation and sc… | 2057-2062 |  | No | Mixed | computeProjectedFootprintSize (utils/modelFo… | None | None | M/Med/High |
| **build-mesh-placement-offsets** — Turns a footprint at a centre into offsets from the centre (half width/depth each way) an… | 2064-2085 |  | No | Mostly pure | footprintForTransform | None | None | S/Low/Med |
| **model-footprint-rect** — A model's footprint where it stands, as a world rect; | 2087-2103 |  | No | Mostly pure | buildMeshPlacementOffsets | None | None | S/Low/High |
| **is-model-footprint-inside-plate** — Whether a model's footprint lies wholly on the active plate; | 2105-2107 |  | Yes | Mostly pure | modelFootprintRect, isRectInsidePlate | None | None | S/Med/High |
| **find-free-spot-centers** — Places incoming models in order: a ring grid of candidate centres around the active plate… | 2109-2279 |  | Yes | Mixed | buildMeshPlacementOffsets, intersectsRect, i… | None itself (callers capture snapshots). | None | M/Med/High |
| **seat-model-on-new-bed** — If the free-spot search put the model outside every bed and the model fits a bed, adds on… | 2762-2793 |  | No | Mixed | plateLocalRect (plateLayout), addPlates (in… | None — the added plate is not recorded in hi… | None | M/Med/High |
| **import-free-spot-placement** — Places each new model at the nearest free grid spot (5 mm spacing) on the active plate, a… | 2936-2940, 2979-2983 (search itself at 2109-2279) |  | Yes | Mostly pure | findFreeSpotCentersForModels, buildMeshPlace… | None | None | M/Med/High |
| **copy-model** — Puts one model (by id) and its supports on the in-memory model clipboard, replacing its c… | 4938-4965 | ✓ | No | Mixed | supportClipboard.ts captureModelSupportsToCl… | None | None | S/Low/High |
| **clipboard-entry-build** — Builds a clipboard entry from a model: name, size, shared geometry reference, cloned tran… | 4944-4962, 4974-4993 |  | No | Mixed | supportClipboard.ts captureModelSupportsToCl… | None | None | S/Med/Med |
| **copy-selected-models** — Copies the given ids, or the current selection when none are given, to the clipboard (in… | 4967-4996 | ✓ | Yes | Mixed | modelCut.ts selectModelsForClipboard; | None | None | S/Low/High |
| **cut-selected-models** — Copy then delete the given ids (delete is fire-and-forget, with its own history entry). | 4998-5000 | ✓ | No | Mostly React | modelCut.ts performModelCut | Only the delete half (deleteModels label 'De… | None | S/Low/High |
| **cut-model** — Single-id wrapper over cutSelectedModels. | 5002-5004 | ✓ | No | Mostly React | cutSelectedModels | via deleteModels | None | S/Low/High |
| **paste-model** — Pastes the FIRST clipboard entry as a new model offset +6mm X/Y, sharing the geometry, se… | 5006-5067 | ✓ | Yes | Mixed | supportClipboard.ts pasteModelSupportsFromCl… | pushSceneSnapshotHistory (includeSupportStat… | None | M/Med/High |
| **paste-auto-arrange** — Pastes every model in the model clipboard as new models (with their copied supports), pla… | 5069-5586 | ✓ | Yes | Mixed | footprintForTransform (computeProjectedFootp… | pushSceneSnapshotHistory(before, after, past… | None | M/Med/High |
| **paste-support-rect** — Works out the XY rectangle a copied model's supports cover: roots (and their disk+cone),… | 5091-5179 |  | Yes | Mostly pure | computeFootprint, computeRaftOuterBoundary,… | None | None | S/Med/High |
| **paste-place-into-bed** — Grid ring search: candidate centres on a grid of (max width+spacing) x (max depth+spacing… | 5181-5365 |  | No | Mostly pure | footprintForTransform; | None | None | S/Low/High |
| **duplicate-with-transforms** — Makes N copies of one model at given transforms, copying its supports onto each copy, opt… | 5588-5719 | ✓ | No | Mixed | duplicatedModelName (modelCopyNames.ts), cap… | pushSceneSnapshotHistory(before, after, dupl… | Partial | M/Med/Med |
| **plugin-import-arrange** — When the user chose auto-arrange: measures each new model's footprint plus its raft overh… | 6032-6220 |  | Yes | Mixed | shelfPack, computeProjectedFootprintSize, pl… | None (part of the un-undoable import) | Partial | M/Med/High |
| **voxl-load-offbed-placement** — Lays out the file's beds (or the scene's, if the file has none) with the current bed size… | 6670-6719 |  | Yes | Mixed | plateCascadeOffsetMm, plateLocalRect, rectSt… | None | None | S/Med/Med |

### Transform

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **transforms-equal** — Tolerance test (1e-5, squared distance for position/scale, abs per Euler axis) for whethe… | 361-368 |  | No | Mostly pure | None | None (gates whether history is pushed) | None | S/Low/High |
| **supports-for-models** — Whether any support entity references a model id; | 483-486, 503-506 |  | No | Mixed | getSupportsForModel (SupportModelLinker) | Decides whether history entries include supp… | None | S/Med/High |
| **set-model-transform-raw** — Sets one model's transform without moving its supports or pushing history; | 3073-3089 | ✓ | No | Mostly pure | resolveModelPlateId, withPlateMembership (pl… | None — caller (mirror) records history itsel… | Partial | S/Med/High |
| **update-model-transform** — Writes one model's new transform (every drag, gizmo, panel edit, nudge ends here). | 3091-3231 | ✓ | No | Mixed | plates/plateLayout.ts (resolveModelPlateId,… | None here; | Partial | M/High/High |
| **transform-plate-lock-guard** — Refuses a transform if the model's current plate OR the plate it would land on is locked,… | 3111-3122, 3374-3392 (helpers 1540-1572) |  | No | Mostly pure | plates/plateLayout.ts resolveModelPlateId | None | None | S/Low/High |
| **transform-link-peer-propagation** — Linked models (same linkGroupId) receive the leader's delta: position delta added, Euler… | 3164-3193, 3408-3438, 3256-3281 |  | No | Mostly pure | None (the test file holds a copy: applySymme… | Via callers | None | S/Med/High |
| **commit-model-transform-history** — Pushes one undo step for a single-model transform already applied: rebuilds before-models… | 3233-3316 | ✓ | No | Mixed | captureSceneSnapshot (module fn 441), pushSc… | Snapshot pair, SCENE_MODELS_SNAPSHOT_APPLY,… | None | S/High/Med |
| **commit-model-transforms-history** — Pushes one undo step for a multi-model edit already applied live (panel typing / selectio… | 3318-3358 | ✓ | No | Mixed | captureSceneSnapshot, transformModelsLabel | Snapshot pair, label transformModelsLabel(co… | None | S/Med/High |
| **update-model-transforms** — Batch transform write (selection move/rotate/scale, lift/drop, center, arrange). | 3360-3525 | ✓ | No | Mixed | plateLayout.withPlateMembership, plateIntera… | Snapshot pair (support state included if any… | Partial | M/High/High |

### Import / VOXL open

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **sanitize-imported-model-name** — Strips every trailing extension from a file/object name ('a.b.stl' -> 'a'), returning 'mo… | 845-858 |  | No | Mostly pure | None | None | Partial | S/Low/High |
| **helper-name-sanitize** — Turns a file/object name into a display name by stripping every trailing '.something' seg… | 845-858 |  | No | Mostly pure | None | None | None | S/Low/High |
| **sha256-hex** — SHA-256 of bytes as hex, via WebCrypto; | 860-874 |  | No | Mostly pure | None | None | Partial | S/Low/Med |
| **remap-model-ids-in-payload** — Deep-walks any payload and rewrites every string field named 'modelId' through an id map… | 876-898 |  | No | Mostly pure | None | None | None | S/Med/Med |
| **helper-support-payload** — remapModelIdsInPayload deep-copies a support payload rewriting every 'modelId' string via… | 876-923 |  | No | Mostly pure | SUPPORT_COLLECTION_KEYS, getImportDefaultsRa… | None | None | S/Low/High |
| **support-payload-counts** — Lists a support payload's collections by the registry's SUPPORT_COLLECTION_KEYS and count… | 901-914 |  | No | Mostly pure | SUPPORT_COLLECTION_KEYS (supportTypeRegistry) | None | Partial | S/Low/High |
| **apply-import-defaults-to-raft** — On importing supports, merges the user's saved import-default raft settings into the glob… | 916-923 |  | Yes | Mixed | getImportDefaultsRaftPatch, applyImportDefau… | None | None | S/Med/High |
| **normalize-plugin-scene-payload** — Validates an untyped plugin (LYS/Chitubox) model payload: geometry must be a BufferGeomet… | 925-1057 |  | No | Mixed | SUPPORT_COLLECTION_KEYS | None | None | S/Med/High |
| **helper-normalize-plugin-payload** — Validates a plugin payload: requires a THREE.BufferGeometry and a transform; | 1006-1057 |  | No | Mostly pure | toVector3, toEuler | None | None | S/Low/High |
| **scene-import-placement-prompt** — Async prompt: an import whose models stand off every bed asks 'auto-arrange or load as is… | 1168-1175, 1612, 1625, 1745-1750, 1784-1802 | ✓ | Yes | Mostly React | None | None | None | M/Med/High |
| **scene-import-hollowing-prompt** — Async prompt for pre-hollowed plugin imports: bake the cavity into the shell, or keep sol… | 1177-1184, 1615, 1626, 1752-1757, 1804-1823 | ✓ | Yes | Mostly React | None | None | None | S/Med/High |
| **merge-cavity-into-shell** — For pre-hollowed imports (Lychee), decodes the hollowing modifier's base64 cavity positio… | 1197-1260 |  | No | Mixed | base64ToBytes | None | None | S/High/High |
| **helper-cavity** — readPayloadCavity decodes a hollowing modifier's cavity positions (base64 Float32, length… | 1197-1240 |  | No | Mostly pure | base64ToBytes, geometryPositionsAsSoup | None | None | S/Med/High |
| **mesh-repair-confirm-prompt** — Async prompt before a heavy repair on mesh import: repair / repair parts / load as is / c… | 1262-1272, 1305, 1616, 1627, 1759-1782 | ✓ | Yes | Mostly React | None | None | None | S/Med/High |
| **printer-mismatch** — Prompt raised on VOXL import when the file's embedded printer bundle resolves to a profil… | 1287-1303, 1614, 1711-1718 (raised at 6766-6785) | ✓ | No | Mixed | findPrinterProfileForBundle, buildVolumeIsSm… | Not directly; | Partial | M/Med/High |
| **mesh-scene-extension** — Classifies a file name: mesh (.stl/.obj/.3mf) or scene (.voxl or any built-in plugin file… | 1418-1437 |  | No | Mostly pure | getBuiltinComplexPluginDefinitions | None | Partial | S/Low/High |
| **scene-plugin-import-handlers** — Builds a map from scene file extension to the built-in plugin's file-type definition and… | 1439-1463 |  | No | Mostly pure | getBuiltinComplexPluginFileTypeHandlers | None | None | S/Low/High |
| **load-files** — Mesh import (STL/OBJ/3MF), one file at a time: refuses on a locked active plate, filters… | 2693-3058 | ✓ | Yes | Mixed | loadMeshGeometry, load3mfGeometryMergedWithS… | None — import pushes no history entry (scene… | Partial | L/High/High |
| **import-lock-and-extension-filter** — Before anything, a locked active plate refuses the whole import; | 2697-2705 (getMeshExtension at 1418-1424) |  | Yes | Mostly pure | getMeshExtension (in hook, useCallback with… | None | None | S/Low/High |
| **import-progress-and-recent-paths** — Shows and updates import progress text per file and stage, yields to the UI, resolves on-… | 2707-2734, 2804-2817, 2997-3017, 3049-3057 |  | No | Mostly React | readNativeFileSize (utils/pluginNetworkBridg… | None | None | S/Low/High |
| **import-prefs-read** — Reads autoLift and liftDistance (owned by useTransformManager) and the preferred mesh col… | 2736-2750 |  | Yes | Mostly React | readMeshAppearanceFromLocalStorage, DEFAULT_… | None | None | S/Low/High |
| **import-native-repair-options** — Builds the loader options: native repair 'auto' if Import Defaults autoRepair else 'none'; | 2820-2896 |  | No | Mostly React | requestMeshRepairConfirmation (in hook), imp… | None | None | M/Med/High |
| **import-build-model-entry** — Creates the LoadedModel: new uuid, file name as name, blob URL, size, sourcePath, plateId… | 2898-2996 |  | Yes | Mixed | countTriangles (utils/geometry) | None | Partial | S/Med/Med |
| **import-post-selection** — After import: if more than one model loaded, select all of them and make the first active; | 3020-3032 |  | Yes | Mostly pure | None | None | Partial | S/Low/High |
| **import-repair-report** — Collects native repair reports per imported model; | 3034-3047 (rule at 1156-1166) |  | No | Mixed | repairReportNeedsAttention (module-level in… | None | None | S/Low/High |
| **on-file-change** — <input type=file> change handler: passes picked files to loadFiles and resets the input s… | 3060-3066 | ✓ | No | Mostly React | None | None | None | S/Low/High |
| **scene-import-run-options** — Option bag shared by every scene import (suppress progress/report/recent tracking/placeme… | 5723-5736 |  | Yes | Mostly pure | importDefaultsPreferences.getSavedImportDefa… | None | None | S/Low/High |
| **should-auto-repair-scene-imports** — Decides whether a scene import should run the native auto-repair: false if the caller sup… | 5733-5736 |  | Yes | Mostly pure | getSavedImportDefaultsSettings (importDefaul… | None | None | S/Low/High |
| **import-plugin-scene-file** — Imports a non-VOXL scene file (LYS, Chitubox etc.) through the plugin registered for its… | 5738-6286 | ✓ | Yes | Mixed | normalizePluginSceneImportPayload, readPaylo… | None — no history entry is pushed; | None | L/High/Med |
| **plugin-import-hollow-bake** — If any payload carries a hollowing cavity, asks 'bake or keep separate' (headless default… | 5794-5849 |  | No | Mixed | readPayloadCavity, mergeCavityIntoShell, sna… | None | None | S/High/High |
| **plugin-import-apply-supports** — In one support-store batch per import: applies import-default raft settings, merges each… | 6222-6250 |  | No | Mostly React | mergeFromImportFormat(data, ownerModelId), t… | None | None | M/High/High |
| **import-voxl-file** — Opens a .voxl into the current scene (merges, does not replace): checks header (refuses o… | 6288-6868 |  | Yes | Mixed | parseVoxlBinaryV2, isVoxlBinaryV2, detectObs… | None — loading pushes no history; | Partial | L/High/Med |
| **voxl-load-header-check** — Reads the first 6 bytes; | 6307-6319 |  | No | Mostly pure | isVoxlBinaryV2, detectObsoleteVoxlVersion, V… | None | Full | S/Low/High |
| **voxl-load-mesh-build-dedup** — Keys each embedded-chunk model by declared SHA, else chunk index (deferred) or computed S… | 6359-6462 |  | No | Mostly React | loadMeshGeometry, loadMeshGeometryFromRange,… | None | Partial | S/Med/High |
| **voxl-load-model-mapping** — For each file model: skips missing/non-embedded meshes (counted), verifies SHA when bytes… | 6465-6630 |  | No | Mixed | clampHexColor, eulerFromGlobalEuler, sanitiz… | None | None | M/High/High |
| **voxl-load-commit** — Back-fills unknown file sizes from the source path (desktop), appends models, makes the f… | 6721-6760 |  | Yes | Mixed | readScenePlates, readNativeFileSize | None | Partial | S/Med/Med |
| **voxl-load-printer-mismatch** — If the file embeds a printer bundle and the bundle does not resolve to the currently sele… | 6762-6786 |  | Yes | Mostly pure | findPrinterProfileForBundle, buildVolumeIsSm… | None | None | S/Low/High |
| **voxl-load-supports** — If the file has any support, rewrites every 'modelId' in the payload through idMap, appli… | 6789-6800 |  | Yes | Mixed | remapModelIdsInPayload, voxlSupportsContainD… | None | None | M/High/High |
| **import-scene-file** — Routes one scene file by extension: .voxl → handleImportVoxlFile, other registered scene… | 6870-6881 | ✓ | No | Mostly pure | getSceneExtension | None | Partial | S/Low/High |
| **import-scene-files** — Imports several scene files one after another with progress, per-file reports suppressed,… | 6883-6948 | ✓ | No | Mostly React | importSceneFile | None | None | S/Low/High |
| **on-import-scene-change** — File-input change handler: imports the picked files via importSceneFiles and clears the i… | 6950-6955 | ✓ | No | Mostly React | None | None | None | S/Low/Med |
| **load-support-json-dev** — Dev/legacy: fetches /dragonfruit_supports.json from the web root and loads it as the supp… | 7030-7040 | ✓ | Yes | Mostly React | applyImportDefaultsToRaftState, loadFromImpo… | None | None | S/Low/Med |
| **import-support-data-file** — Reads a user-picked support JSON file, validates its shape, applies the saved import raft… | 7043-7061 | ✓ | Yes | Mostly React | asDragonfruitImportFormat (module fn line 97… | None — loadFromImportFormat calls setState w… | None | S/High/High |
| **plugin-import-stubs** — Constant stubs for a removed two-step plugin import (always 'idle', null, undefined). | 7063-7067 | ✓ | No | Mostly pure | None | None | None | S/Low/High |
| **plugin-two-step-import-stubs** — Constant stubs: phase is always 'idle', error null, the three handlers undefined. | 7063-7067 | ✓ | No | Mostly pure | None | None | None | S/Low/High |

### Split and merge geometry

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **split-model-into-parts** — Organic Cut commit: source model becomes part 0, other parts appended as new models ('<na… | 3744-3883 | ✓ | No | Mixed | accelerateGeometry, computeFlatteningPlanes,… | Snapshot pair without support state, label f… | None | M/High/Med |
| **split-import-group** — Replaces a multi-body 3MF model with one model per pre-processed body (model.splitBodies)… | 4243-4284 | ✓ | No | Mixed | None (countTriangles for polygonCount) | pushSceneSnapshotHistory snapshot WITHOUT su… | None | M/Med/Med |
| **split-supports** — Splits a model whose native classify report has model_triangle_count into two models, '<b… | 4286-4451 | ✓ | No | Mixed | splitClassifiedSupports.ts splitClassifiedSu… | pushSceneSnapshotHistory with includeSupport… | None | M/High/High |
| **split-supports-synthetic-report** — Builds a fake 'clean' native repair report (all zero defects, fully_repaired) to tag geom… | 4324-4370, 4547-4596 |  | No | Mostly pure | None | Part of caller's snapshot | None | S/Med/High |
| **merge-supports** — Re-joins exactly two selected models into one: picks the non-support one (else active, el… | 4453-4654 | ✓ | Yes | Mixed | None (inverse of splitClassifiedSupportGeome… | pushSceneSnapshotHistory with includeSupport… | None | M/High/Med |

### Stays in the app (not ADR-0045 scope)

| Operation | Lines | Ret | Imp | Pure | Helper | Undo | CLI | E/R/C |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **mesh-appearance-persistence** — Reads/validates/writes the viewer appearance record in localStorage key 'mesh-appearance-… | 197-218, 603-678 |  | No | Mixed | MESH_SHADER_TYPES | None | None | S/Low/High |
| **scene-tuning-constants** — Module constants that encode scene rules: max beds a paste/import may add (32), import ar… | 220-291 |  | No | Mostly pure | None | None (history caps feed storeSceneSnapshotPa… | None | S/Low/High |
| **schedule-post-paint** — setTimeout(0) wrapper used to run history pushes after React paints. | 431-437 |  | No | Mostly React | None | Delays history push for paste/duplicate. | None | S/Low/High |
| **paint-model-base-color** — When a model has vertex colours, repaints them all to one flat colour (used by colour cha… | 473-480 |  | No | Mostly React | clearPaintToBase (MeshPainter) | Indirect: applySceneSnapshot repaints on und… | None | S/Low/High |
| **recent-files-storage** — Recent-files list (localStorage 'app-recent-opened-files', max 10, validated) plus file b… | 582-601, 680-843 |  | No | Mostly React | None | None | None | S/Low/High |
| **prompt-and-report-types** — Exported shapes of the modal prompts and toast reports the manager raises during import/r… | 1133-1184, 1262-1305 |  | Yes | Mostly pure | None | n/a | n/a | S/Low/High |
| **repair-report-needs-attention** — Decides whether a mesh repair report is shown to the user: not fully repaired, or any cou… | 1156-1166 |  | No | Mostly pure | None | None | None | S/Low/High |
| **wait-for-ui-yield** — Promise that resolves after setTimeout(0) so long imports/repairs let React paint progres… | 1465-1470 |  | No | Mostly React | None | None | None | S/Low/High |
| **selection-state-passthrough** — Raw React setter for the selected model ids, exposed so callers can set arbitrary selecti… | 1474 (state); return key 8143 | ✓ | No | Mostly React | None | None | Partial | S/Low/High |
| **model-clipboard-state** — In-memory model clipboard entries (geometry, transform, colour, modifiers, captured suppo… | 1602, 1307-1319 (+ return 8228) | ✓ | Yes | Mostly React | None | None | None | S/Low/High |
| **can-paste-model** — Boolean in the return object: clipboard non-empty. | 1602-1602, 8228-8228 | ✓ | Yes | Mostly React | None | None | None | S/Low/High |
| **recent-opened-files-state** — Recent-files list shown on the empty-scene screen (reopen/clear functions are outside thi… | 1603 | ✓ | Yes | Mostly React | readRecentOpenedFilesFromLocalStorage | None | None | S/Low/High |
| **import-progress-state** — Progress banner state for mesh/scene imports and support split/merge/scan (label, detail,… | 1604-1610 | ✓ | Yes | Mostly React | None | None | None | S/Low/High |
| **emit-scene-import-report** — Shows a toast report (text, tone, duration default 4.2 s, optional click action) and clea… | 1611, 1624, 1661-1686 | ✓ | Yes | Mostly React | None | None | n/a | S/Low/High |
| **obsolete-voxl-prompt** — Prompt state raised when a scene from an unsupported VOXL generation (v1 json/binary) is… | 1613, 1702-1704 | ✓ | Yes | Mostly React | detectObsoleteVoxlVersion (voxl) at import | None | Partial | S/Low/Med |
| **mesh-repair-reports** — Repair report dialog state: reports shown, presentation ('default' vs 'optimistic'), repo… | 1617-1623, 1697-1700 | ✓ | Yes | Mostly React | None | None for the report state; | None | S/Low/Med |
| **manually-repaired-model-ids** — List of model ids that were repaired by hand this session; | 1621-1621 (state); written 7232, 7340 | ✓ | No | Mostly React | None | None — not part of snapshots, so undoing a r… | None | S/Low/High |
| **background-geometry-refs** — Bookkeeping for background geometry work: BVH acceleration queue, deferred dispose queue,… | 1629-1649 |  | Yes | Mostly React | None (consumed by processDeferred* at 2425-2… | None | None | S/Low/High |
| **try-revoke-object-url** — Revokes a blob: object URL (a model's fileUrl) when a model is deleted or disposed. | 1651-1659 |  | No | Mostly React | None | None | None | S/Low/High |
| **clear-scene-import-report** — Hides the current toast and cancels its timer. | 1688-1695 | ✓ | Yes | Mostly React | None | None | None | S/Low/High |
| **open-mesh-repair-report-for-model** — Opens the repair dialog for a model from the report stored on its geometry (meshDefects.n… | 1726-1733 | ✓ | No | Mostly React | None | None | None | S/Low/High |
| **open-pending-mesh-repair-reports** — From the import toast's click, moves pending repair reports into the dialog and clears th… | 1735-1743 | ✓ | Yes | Mostly React | None | None | None | S/Low/High |
| **prompt-unmount-cleanup** — On unmount, resolves a pending placement prompt with 'load_as_is' and hollowing prompt wi… | 1825-1838 |  | Yes | Mostly React | None | None | None | S/Low/High |
| **viewer-display-settings** — Global viewer appearance: lighting, material, shader mode (viewport) vs shader being conf… | 1840-1845, 1852-1867 (+ return 8230-8270) | ✓ | No | Mostly React | None | None | n/a | S/Low/High |
| **baked-ao-intensity-sync** — Pushes the AO intensity into the bakedOcclusion module so geometry prep (outside React) b… | 1846-1850 |  | No | Mostly React | setBakedOcclusionIntensity (bakedOcclusion.t… | None | None | S/Low/High |
| **view3d-settings** — Build-volume/view settings: stored preferences merged with the active printer's volume, s… | 1868, 1890-1910, 1992-1996 | ✓ | Yes | Mixed | normalizeView3DSettings, saveView3DSettings,… | None | Partial | S/Med/High |
| **appearance-and-prefs-load-effect** — On mount, restores persisted appearance into all viewer state, reads the recent-files lis… | 1925-1948 |  | No | Mostly React | readMeshAppearanceFromLocalStorage, readRece… | None | None | S/Low/Med |
| **appearance-persist-effect** — Writes the whole appearance record to localStorage whenever any appearance value changes. | 1950-1990 |  | No | Mostly React | writeMeshAppearanceToLocalStorage | None | None | S/Low/High |
| **app-mode** — Global application mode (SupportMode: 'prepare' etc.). | 1998-1999 | ✓ | Yes | Mostly React | None | None | n/a | S/Low/High |
| **clone-geometry-with-bounds** — Copies a GeometryWithBounds for paste/duplicate/import. | 2371-2423 |  | No | Mostly React | accelerateGeometry (utils/bvh) | None | None | S/Med/High |
| **deferred-acceleration-queue** — Queues BVH (bounding-volume hierarchy, a raycast speed-up) builds and drains them one per… | 2425-2470 |  | No | Mostly React | accelerateGeometry (utils/bvh) | None | None | S/Low/High |
| **set-background-geometry-work-paused** — Pauses/resumes the BVH queue (only that queue, not disposal). | 2472-2477 | ✓ | No | Mostly React | None | None | None | S/Low/High |
| **has-pending-background-geometry-work** — Reports whether any deferred geometry work is still queued or running: BVH builds, dispos… | 2487-2495 | ✓ | No | Mostly React | None | None | None | S/Low/High |
| **deferred-disposal-queue** — Queues BufferGeometries no longer referenced by models, clipboard or any undo snapshot, a… | 2497-2545 |  | No | Mostly React | disposeGeometryBVH (utils/bvh) | Indirect: geometry held by sceneSnapshotRegi… | None | S/Med/High |
| **track-recent-opened-files** — Adds opened files to the Recent list: dedups by kind+name+sourcePath when a disk path is… | 2547-2632 |  | No | Mixed | putRecentOpenedFileBlob, deleteRecentOpenedF… | None | None | S/Low/High |
| **active-model** — The model whose id is activeModelId, with meshModifiers re-attached from the external mod… | 2636-2642 (return keys 8147, 8155-8156) | ✓ | Yes | Mostly pure | getStoredMeshModifiers (mesh-modifiers/meshM… | None | Partial | S/Low/High |
| **prune-selection-effect** — Whenever models or activeModelId change, drops selected ids that no longer exist and clea… | 2644-2650 |  | No | Mostly React | None | None (runs after undo too, as a consequence) | Partial | S/Low/High |
| **select-model** — Selection gesture on one model: refuses (and reports through onBlockedByLock) if the mode… | 2652-2670 | ✓ | No | Mostly pure | resolveModelPlateId (plateLayout) via isMode… | None (selection is not undoable on its own; | None | S/Low/High |
| **clear-selection-on-plate-lock** — When the active plate becomes locked, empties the model selection (activeModelId is left… | 2675-2678 |  | Yes | Mostly React | None | None | None | S/Low/High |
| **clear-model-selection** — Empties the selection and clears the active model (no-ops when already empty to avoid re-… | 2680-2683 | ✓ | No | Mostly React | None | None | None | S/Low/High |
| **clear-support-selection-on-mode** — Leaving the Support workspace clears the support selection held in the supports selection… | 2686-2690 |  | Yes | Mostly React | clearSupportSelection (supports/interaction/… | None | None | S/Low/High |
| **replace-model-geometry** — Swaps a model's BufferGeometry (hollow, hole punch, mirror bake, restore). | 3527-3664 | ✓ | No | Mostly React | buildModelEdgeGeometry (hooks/useStlGeometry… | Snapshot pair with modifierRecord (when modi… | None | L/High/Med |
| **flattening-planes-idle-pass** — After a geometry change, computes Place-On-Face candidate planes on an idle callback and… | 3577-3597, 3724-3736, 3862-3877, 4060-4079 |  | No | Mostly React | features/placeOnFace/logic/computeFlattening… | None | None | S/Low/High |
| **add-model-from-geometry** — Adds a new model built from a BufferGeometry, inheriting group, transform, colour and mod… | 3666-3742 | ✓ | No | Mostly React | accelerateGeometry, computeFlatteningPlanes,… | Snapshot pair without support state, caller-… | None | S/Low/High |
| **higher-contrast-edges-backfill** — When the 'Higher Contrast Model Edges' camera setting turns on, builds the edge-overlay g… | 3885-3937 |  | Yes | Mostly React | buildModelEdgeGeometry (hooks/useStlGeometry) | None | None | S/Low/Med |
| **baked-ao-sweep** — On every models/bakedAoIntensity change, queues models whose geometry has no aBakedAo att… | 3939-4051 |  | Yes | Mostly React | features/scene/bakedOcclusion.ts (bakeOcclus… | None | None | M/Low/High |
| **finalize-model-geometry-post-processing** — Queues deferred BVH build and idle flattening-plane computation for a model's current geo… | 4053-4080 | ✓ | No | Mostly React | deferAccelerateGeometry, computeFlatteningPl… | None | None | S/Low/High |
| **set-model-mesh-modifiers** — Stores a model's mesh modifiers (hollowing/hole-punch drafts) in the external meshModifie… | 4096-4152 | ✓ | No | Mixed | features/mesh-modifiers/meshModifierStore.ts… | Own push: sceneHistory.push({type: SCENE_MOD… | None | S/Med/High |
| **scan-model-for-supports-in-place** — Re-runs the native classifier ('classify-only') on a model's geometry so baked-in support… | 4656-4710 | ✓ | No | Mostly React | useStlGeometry.ts processGeometry (nativePro… | None — geometry replaced with NO history ent… | None | M/Med/High |
| **select-group** — Selects all members of a group (replace, or 'add' to union with current selection) and ma… | 4731-4742 | ✓ | No | Mostly pure | None | None (selection is not in history) | None | S/Low/High |
| **voxl-load-report-errors** — Logs phase timings (also to the native log file), emits an imported-scene report (warning… | 6802-6867 |  | No | Mostly React | reportImportedScene, reportVoxlNoMeshes, rep… | None | Partial | S/Low/High |
| **reopen-recent-file** — Reopens a recent-files entry: a mesh with a disk path is reloaded from disk (STL as a pat… | 6957-7017 | ✓ | Yes | Mostly React | readRecentOpenedFileBlob, loadTauriCore, imp… | None | None | S/Low/High |
| **clear-recent-files** — Empties the recent-files list in state and localStorage and deletes the cached blobs from… | 7020-7027 | ✓ | No | Mostly React | writeRecentOpenedFilesToLocalStorage, delete… | None | None | S/Low/High |
| **load-support-json-legacy** — Legacy debug loader: fetches /dragonfruit_supports.json and REPLACES the support store wi… | 7030-7040 | ✓ | Yes | Mostly React | loadFromImportFormat, applyImportDefaultsToR… | None | None | S/Low/Med |
| **active-model-accessors** — Compatibility values for the active model: its colour (or the preferred colour if none),… | 7083-7086 | ✓ | Yes | Mostly pure | None | None | None | S/Low/Med |
| **undo-repairs-in-place** — Restores a model's original mesh by re-reading its source file from disk (through Rust),… | 7208-7242 | ✓ | No | Mostly React | loadMeshFromPath (utils/meshRepair.ts), proc… | None — the geometry swap is NOT pushed to hi… | None | S/Med/High |
| **repair-models-in-place** — Runs the native repair pipeline on each listed model in turn (with progress and cancel),… | 7252-7354 | ✓ | No | Mostly React | processGeometry (nativeProcessingMode:'repai… | pushSceneSnapshotHistory(before, after, repa… | None | M/High/High |
| **tet-surface-model-in-place** — Rebuilds one model's surface with the native tetrahedral remesh and swaps it in as one un… | 7365-7406 | ✓ | No | Mostly React | tetSurfaceFromGeometry (utils/meshShrinkwrap… | replaceModelGeometry(..., tetSurfaceModelLab… | None | S/Med/High |
| **solid-remesh-model-in-place** — Shrink-Wrap: resolves one model into a solid with the native remesh and swaps it in as on… | 7419-7460 | ✓ | No | Mostly React | solidRemeshFromGeometry (utils/meshShrinkwra… | replaceModelGeometry(..., solidRemeshModelLa… | None | S/Med/High |
| **geometry-tracking-dispose** — After each change to models or the clipboard, works out which THREE geometries are still… | 7462-7488 |  | Yes | Mostly React | deferDisposeGeometries (2540) | Reads history registry so undoable geometry… | None | S/Med/High |
| **auto-brace-mesh-sync** — Keeps the auto-brace module's mesh store in sync with every model's geometry and world ma… | 7490-7506 |  | Yes | Mostly React | registerMeshForAutoBrace/unregisterMeshForAu… | None | None | S/Med/High |
| **unmount-cleanup** — On unmount: clears the import-report toast timer, revokes model blob URLs, and disposes e… | 7508-7533 |  | Yes | Mostly React | tryRevokeObjectUrl, disposeGeometryBVH | None | None | S/Low/High |
| **active-model-compat-aliases** — Single-model compatibility view of the active model: its name, colour (or preferred colou… | 8150-8156 | ✓ | Yes | Mostly React | None | None | Partial | S/Low/Med |
| **get-model-mesh-modifiers** — Reads a model's modifiers from the external store (inline useCallback in the return objec… | 8205 | ✓ | No | Mostly pure | meshModifierStore.getStoredMeshModifiers | None | Partial | S/Low/High |
| **on-heatmap-color-change** — Replaces one colour stop of the overhang heatmap gradient. | 8264-8270 | ✓ | No | Mostly React | None | None | None | S/Low/High |

## Appendix B: scene rules in page.tsx and SceneCanvas.tsx

Lighter pass; confidence is Med where a block was not read in full.

| Rule | Location | Group | Imp | Pure | E/R/C |
| --- | --- | --- | --- | --- | --- |
| **history-jump** — Debug history panel: jump to an event by undoing/redoing until the undo count matches (sa… | page.tsx:6461-6499 | Foundations: pins and seams | No | Mostly pure | S/Low/High |
| **sc-plate-scenery** — Models on another plate are scenery: dimmed and not pickable, except selected ones. | SceneCanvas.tsx:1094-1109, SceneCanvas.tsx:1710-1736 | Plates, phase 2 | Yes | Mostly pure | S/Low/High |
| **sc-next-plate-frame-ghost-drop** — Where the next plate would go (cascade step past the last plate) and whether a select-dra… | SceneCanvas.tsx:1741-1757, SceneCanvas.tsx:6102-6214 | Plates, phase 2 | No | Mixed | S/Med/High |
| **plate-widget-passthroughs** — Plate widget actions pass straight to the hook: add plate, toggle lock of the active plat… | page.tsx:10827-10851 | Plates, phase 2 | Yes | Mostly React. | S/Low/High |
| **slice-run-plate-scope** — Records each sliced bed against the plate actually sliced (context.plateId), falling back… | page.tsx:2667-2887 | Plates, phase 2 | Yes | Mostly React | M/Med/Med |
| **printing-scrub-preview-models** — Models on the active plate, shifted by -plate offset so the printing scrub preview (drawn… | page.tsx:2920-2934 | Plates, phase 2 | Yes | Mostly pure | S/Med/High |
| **active-plate-model-ids** — Set of model ids on the active plate (modelsOnPlate). | page.tsx:828-834 | Plates, phase 2 | Yes | Mostly pure | S/Low/High |
| **grouping-rename-passthrough** — Thin passthroughs from the Models panel to the hook's grouping and rename functions. | page.tsx:5657-5679 | Model fields (quick wins) | No | Mostly React | S/Low/High |
| **scene-autosave-wiring** — Feeds the autosave hook every field the VOXL writer accepts: models, active/selected ids,… | page.tsx:1194-1221 | Save input (export-save) | No | Mostly React | S/High/High |
| **save-baseline-dirty** — Unsaved-changes rule: the scene is dirty when it has models and the undo count, redo coun… | page.tsx:1770-1801 | Save input (export-save) | No | Mixed | S/Low/High |
| **slice-thumbnail-per-plate** — Frames the export thumbnail on the given plate's build volume so each plate's file gets i… | page.tsx:2944-2950 | Save input (export-save) | No | Mostly React | S/Low/High |
| **before-slice-start** — Pre-slice gate: preview slices straight away; | page.tsx:4135-4269 | Save input (export-save) | Yes | Mostly React | S/Low/High |
| **top-bar-save-scene** — Manual Save: saves VOXL with only the VISIBLE models if any are visible (else all), plus… | page.tsx:4557-4654 | Save input (export-save) | No | Mixed | M/High/Med |
| **save-path-resolution** — Decides where Ctrl+S writes: a loaded VOXL with a native path asks overwrite / save-as /… | page.tsx:4726-4889 | Save input (export-save) | No | Mostly React | S/Med/High |
| **empty-scene-reset** — When the scene becomes empty: drops the save target path, resets format to chunked, close… | page.tsx:4891-4910 | Save input (export-save) | No | Mostly React | S/Med/High |
| **autosave-recovery-discovery** — On startup, offers recovery only if enabled, in Tauri, not launched with a scene file, an… | page.tsx:4925-4980 | Save input (export-save) | No | Mostly React | S/Low/High |
| **clear-or-delete-plate** — Plate bin rule: on a non-first plate when there is more than one, the bin deletes the pla… | page.tsx:10855-10866, page.tsx:11683-11701 | Delete | Yes | Mostly pure | S/Med/High |
| **new-scene** — New Scene = delete every model through scene.deleteModels (one undoable entry); | page.tsx:5067-5105 | Delete | No | Mostly React | S/Med/Med |
| **select-all-and-delete** — Ctrl+A selects all visible models (in hollowing: all hole punches) and sets a select-all… | page.tsx:9435-9484, page.tsx:9898-9936 | Delete | Yes | Mostly React | S/Med/High |
| **sc-align-live-transform-to-lift** — Snaps a live gizmo transform so the model's lowest point is at the lift distance (auto-li… | SceneCanvas.tsx:1054-1088 | Volume bounds and seating | No | Mostly pure | S/Med/Med |
| **sc-volume-boxes-and-oob** — Viewport out-of-bounds: model mesh bounds unioned with its supports/raft bounds, tested a… | SceneCanvas.tsx:2022-2210 | Volume bounds and seating | Yes | Mixed | S/Med/High |
| **resin-in-bounds-models** — Models counted in the resin estimate: visible and fully inside the volume of the plate th… | page.tsx:3073-3168 | Volume bounds and seating | Yes | Mostly pure | S/Med/High |
| **sliceable-models** — What gets sliced: visible models on the active plate whose bounds overlap their plate's v… | page.tsx:3128-3157, page.tsx:6840-6851 | Volume bounds and seating | Yes | Mostly pure | M/High/High |
| **scene-z-range** — Z range for the layer slider and slicer: max Z from actual transformed vertices of slicin… | page.tsx:6835-7023 | Volume bounds and seating | Yes | Mixed | S/Med/High |
| **out-of-bounds-models-page** — Models outside the volume of the plate they stand on (using the live hook transform for t… | page.tsx:7406-7482 | Volume bounds and seating | Yes | Mostly pure | S/Med/High |
| **plate-volume-bounds** — Builds one world-space build-volume box per plate from scene.plateFrames (x/y from the fr… | page.tsx:806-813 | Volume bounds and seating | No | Mostly pure | S/Med/High |
| **volume-bounds-for-model** — Picks the build volume a model is judged against: the plate it stands on (scene.resolveMo… | page.tsx:819-822 | Volume bounds and seating | No | Mostly pure | S/Med/High |
| **lift-drop-selection** — Lift puts the selection's lowest point at the lift distance, Drop at 0, moving all target… | page.tsx:9191-9224 | Volume bounds and seating | Yes | Mostly pure. | S/High/High |
| **auto-lift-toggle** — Auto-lift toggled: with >1 selected, lift/drop them together first; | page.tsx:9226-9247 | Volume bounds and seating | Yes | Mixed. | S/Med/High |
| **arrange-plate-button** — The plate's own Arrange button: auto-arrange all models at 1mm with Z rotation, filling t… | page.tsx:10841-10847 | Placement and duplicate layout | Yes | Mostly React. | S/Med/High |
| **support-aware-arrange-bounds** — Size a model for arrange/duplicate including its supports and raft: per-model support bou… | page.tsx:7496-7797 | Placement and duplicate layout | Yes | Mostly pure | M/Med/Med |
| **prepare-hotkeys-arrange-all** — Arrange-all hotkey picks the arrange algorithm from the panel settings: manual array, hig… | page.tsx:7997-8010 | Placement and duplicate layout | No | Mostly React. | S/Med/High |
| **duplicate-preview-layout** — Duplicate tool preview: array mode lays a centred XxYxZ grid around the source; | page.tsx:9500-9790 | Placement and duplicate layout | Yes | Mostly pure | M/Med/High |
| **copy-paste-hotkeys** — Ctrl+C copies selection else active (Prepare only); | page.tsx:9938-10004 | Placement and duplicate layout | Yes | Mostly React | S/Low/High |
| **sc-multi-selection-transform** — Live multi-selection gizmo: move adds the active delta to all; | SceneCanvas.tsx:2878-2949 | Transform | No | Mostly pure. | S/Med/High |
| **sc-move-z-lock** — Dragging an in-plane gizmo arrow pins the height (when its world direction has no Z), so… | SceneCanvas.tsx:7211-7272 | Transform | Yes | Mostly React. | S/Low/High |
| **destructive-transform-guard** — Rule: in Prepare, a rotate X/Y, scale, reset, place-on-face or mirror on models that carr… | page.tsx:2384-2503 | Transform | Yes | Mixed | S/High/High |
| **apply-orientation** — Auto Orientation apply: sets the model's rotation, then re-seats it so its lowest point s… | page.tsx:2456-2479 | Transform | Yes | Mostly pure | S/High/Med |
| **pending-transform-history** — Pending single-model transform history: picks 'after' from explicit after, else live gizm… | page.tsx:5774-5939, page.tsx:9332-9366 | Transform | Yes | Mixed | M/High/Med |
| **history-origin-restore** — Every history entry is stamped with the app mode and tool it was made in; | page.tsx:5948-5993, page.tsx:7915-7932 | Transform | No | Mostly React. | S/Med/High |
| **history-transform-resync** — After undo/redo, copies the active model's stored transform back into the transform hook… | page.tsx:6031-6087 | Transform | Yes | Mostly React | S/Low/High |
| **mirror-finalize-on-tool-change** — Leaving the Mirror tool bakes the pending mirror (flushPendingBake) and suppresses 10 per… | page.tsx:7903-7909 | Transform | Yes | Mostly React. | S/High/Med |
| **transform-end** — Gizmo/drag release: optionally spawns a new plate for a drop on the ghost bed (folded int… | page.tsx:8474-8760 | Transform | Yes | Mixed | L/High/Med |
| **gizmo-commit** — Single-model gizmo commit: rotate is held until transform end (so the lift is included); | page.tsx:8762-8826, page.tsx:9385-9405 | Transform | No | Mostly React | M/High/Med |
| **gizmo-group-commit** — Multi-selection gizmo commit: keep entries that changed (eps 1e-6); | page.tsx:8833-8919 | Transform | No | Mostly pure | S/High/Med |
| **selection-panel-edits** — Panel edits on a selection: each keystroke applies without history from the transforms ca… | page.tsx:8921-9027 | Transform | Yes | Mixed | M/High/High |
| **selection-scale** — Scales the selection by the factor from the active model, keeps each model's bottom where… | page.tsx:9029-9042, page.tsx:9106-9134 | Transform | Yes | Mostly pure. | S/High/High |
| **selection-move** — Sets the selection's position: the selection origin moves to (x,y,z), every target moves… | page.tsx:9044-9054, page.tsx:9161-9169 | Transform | Yes | Mostly pure | S/Med/High |
| **selection-rotate** — Rotates the selection about the active model to the typed Euler (global), asking about su… | page.tsx:9056-9081 | Transform | Yes | Mostly pure | S/High/High |
| **selection-transform-commit** — Closes the panel's open undo step; | page.tsx:9084-9104 | Transform | Yes | Mixed. | S/Med/High |
| **selection-reset** — Reset rotation or scale on the selection; | page.tsx:9136-9159 | Transform | Yes | Mostly pure. | S/High/High |
| **center-selection** — Centres the selection on the build plate centre: (0,0) for centre origin, (w/2,d/2) for f… | page.tsx:9171-9189 | Transform | Yes | Mostly pure. | S/Med/Med |
| **transform-start** — Gizmo/select-drag start: refuse if any active/selected model is on a locked plate; | page.tsx:9259-9330 | Transform | Yes | Mixed | M/High/High |
| **place-on-face** — Place-on-face: opens a rotate history entry, clears the manual-Z override, re-enables aut… | page.tsx:9792-9804, page.tsx:10349-10356 | Transform | Yes | Mostly React. | M/High/Med |
| **import-placement-escape** — Escape on the scene-import placement prompt resolves it as 'load as is'. | page.tsx:1649-1664 | Import / VOXL open | No | Mostly React. | S/Low/High |
| **autosave-restore** — Restores the autosave by reading its bytes and importing them as a scene file with recent… | page.tsx:4656-4724 | Import / VOXL open | No | Mostly React | S/Med/High |
| **organic-cut-commit** — Cut tool commit: replaces the active model with N parts in ONE atomic split (separate rep… | page.tsx:10365-10382 | Split and merge geometry | Yes | Mostly React | S/High/High |
| **sc-select-model-pointer** — Prepare-mode click selects the model (and fires window 'model-clicked'); | SceneCanvas.tsx:1638-1649, SceneCanvas.tsx:4726-4751 | Stays in the app (not ADR-0045 scope) | No | Mostly React. | S/Low/High |
| **sc-marquee** — Marquee: projects model meshes and supports to screen and returns ids inside the rectangl… | SceneCanvas.tsx:3189-3301 | Stays in the app (not ADR-0045 scope) | No | Mostly React | S/Low/Med |
| **overhang-view-toggle** — Switches shader to overhang heatmap, remembering the previous shader to restore. | page.tsx:10018-10028 | Stays in the app (not ADR-0045 scope) | No | Mostly React. | S/Low/High |
| **blocker-reset-confirm** — Confirming a hollowing change that clears blockers: applies the deferred panel state, cle… | page.tsx:10053-10102 | Stays in the app (not ADR-0045 scope) | Yes | Mixed | S/Med/High |
| **hollow-preview-trigger** — In the hollowing tool, debounces (90ms) a hollow preview for the active model unless appl… | page.tsx:10105-10133, page.tsx:10272-10347 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React | S/Low/High |
| **active-model-modifier-panel-sync** — When the active model changes, rebuilds the hole-punch and hollowing panel state from its… | page.tsx:10143-10270 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React | S/Low/Med |
| **remesh-confirms** — Runs tet-surface or solid remesh in place on the confirmed model with progress/cancel tok… | page.tsx:11473-11494, page.tsx:11531-11552 | Stays in the app (not ADR-0045 scope) | No | Mostly React. | S/Med/High |
| **support-drag-sync-transaction** — After a transform commit, holds the support drag delta until the store shows the expected… | page.tsx:1997-2119 | Stays in the app (not ADR-0045 scope) | No | Mostly React | M/High/High |
| **context-menu-disabled-actions** — Decides which editor menu actions are enabled: delete/mark need a target (selection else… | page.tsx:2547-2655 | Stays in the app (not ADR-0045 scope) | Yes | Mostly pure | S/Low/High |
| **context-menu-open-rule** — Right-button release opens the editor menu only if the pointer did not move >6px, no orbi… | page.tsx:5616-5622, page.tsx:6116-6146 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React | S/Low/High |
| **repair-target** — A row's repair button repairs the whole selection when that row is part of a multi-select… | page.tsx:5625-5632 | Stays in the app (not ADR-0045 scope) | Yes | Mostly pure | S/Low/High |
| **selection-handlers** — Selection entry points: list click/toggle/add, shift-range (replace or add, sets active),… | page.tsx:5638-5697, page.tsx:5723-5735 | Stays in the app (not ADR-0045 scope) | No | Mostly pure | S/Low/High |
| **editor-menu-action** — Executes editor/support context-menu actions: toggle support curve, add joint (projects c… | page.tsx:6165-6411 | Stays in the app (not ADR-0045 scope) | Yes | Mixed | M/High/High |
| **transform-persistence-effect** — Writes the transform hook's live values into the active model when they differ (eps 1e-4)… | page.tsx:6671-6798 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React | L/High/Med |
| **mode-change-guard** — Workspace switching rules: no models -> forced to Prepare; | page.tsx:7340-7356, page.tsx:7130-7202, page.tsx:8012-8016 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React | S/Med/High |
| **workspace-tool-memory** — Each workspace remembers its last tool (Prepare rail tool; | page.tsx:7944-7981 | Stays in the app (not ADR-0045 scope) | No | Mostly React. | S/Low/High |
| **unapplied-modifiers** — Lists visible models with unapplied hole punches and/or hollowing (hidden models ignored). | page.tsx:8025-8131 | Stays in the app (not ADR-0045 scope) | No | Mostly pure. | S/Med/High |
| **apply-all-hole-punches** — Apply-to-All bakes holes model by model by making each one active and handing it to the h… | page.tsx:8049-8094, page.tsx:8135-8148, page.tsx:8197-8215 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React | M/High/High |
| **export-mode-select-all** — Entering Export: if visible models have unapplied hole punches, open the unapplied-holes… | page.tsx:8150-8189 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React. | S/Med/High |
| **tool-entry-selection** — Entering Arrange with exactly one visible model selects it; | page.tsx:8218-8237 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React. | S/Low/High |
| **support-mode-selection-invariants** — In Support mode: ensure an active model (first visible), collapse multi-selection to one… | page.tsx:8308-8382 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React | S/Med/High |
| **plate-locked-notice** — Shows a 2.6s toast when the manager refuses an edit because a plate is locked; | page.tsx:846-863 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React | S/Low/High |
| **manifold-warning-effect** — After import, if any model's native repair report says model_is_manifold === false and it… | page.tsx:864-873 | Stays in the app (not ADR-0045 scope) | No | Mostly React | S/Low/High |
| **camera-pauses-geometry-work** — Pauses background geometry work while the camera moves, resumes 140ms after it stops. | page.tsx:9407-9424 | Stays in the app (not ADR-0045 scope) | No | Mostly React. | S/Low/High |
| **persist-active-model-modifiers** — Writes mesh modifiers for the active model (with history options). | page.tsx:9806-9813 | Stays in the app (not ADR-0045 scope) | Yes | Mostly React. | S/Med/High |

## Appendix C: indirect wiring into the manager

On `dev @ 5d31502c (2026-10-21)`. Paths are relative to `src/` unless they start with `scripts/` or `src-tauri/`. "Manager" means `features/scene/useSceneCollectionManager.ts`. Line numbers were checked with grep and sed.

### 0. The one instance and how it spreads

| Mechanism | Where | What it reaches |
|---|---|---|
| **Single instantiation** | app/page.tsx:799 `const scene = useSceneCollectionManager({ onBlockedByLock })` | Everything. There is exactly one manager. It is **not** in a React context or module store. It reaches other files only as the `scene` prop or argument. |
| **Prop drilling of the whole object** (`scene={scene}` or `scene,`) | `app/page.tsx` lines 949, 1504, 1818, 7809, 9816, 9994, 10396, 10482, 10543, 10551, 10588, 10707, 10994, 11228, 11366, 11419, 11591 | Feature hooks and organisms typed as `ReturnType<typeof useSceneCollectionManager>`: `useArrangeManager`, `useMirrorManager`, `useHollowingManager`, `useHolePunchManager`, `useImportExportManager`, `usePrintingPreviewManager`, and `components/organisms/{panels,modals,scene}/*` (ModelsPanel, PreparePanelStack, ExportPanelStack, SharedPanelStack, AnalysisPanelStack, SceneFileModals, PrintingModals, MeshRepairModals, DiagnosticsModals, SceneOverlays). |
| Methods each feature hook calls on that object | grep of `scene.X(` | **useArrangeManager**: `addPlates, dropPlates, duplicateModelWithTransforms, isPlateLocked, plateOffsetFor, resolveModelPlateId, updateModelTransforms`. **useMirrorManager**: `replaceModelGeometry, setModelTransformRaw`. **useHollowingManager**: `getModelMeshModifiers, replaceModelGeometry, setModelMeshModifiers`. **useHolePunchManager**: `getModelMeshModifiers, replaceModelGeometry`. **useImportExportManager**: `loadFiles, onFileChange, setActiveModelId, setSelectedModelIds` (+ `lastLoadedVoxlFormatChunkedRef`). **Organisms** mostly read state and resolve prompts: `resolveSceneImportPlacementPrompt, resolveSceneImportHollowingPrompt, resolveMeshRepairConfirmPrompt, resolvePrinterMismatch, dismissObsoleteVoxlScene, dismissMeshRepairReports, repairModelsInPlace, renamePlate, removePlate, activatePlate, deleteModel, setModelVisibility, importSupportDataFile, handleLoadSupportJson`. |
| `ModelsPanel` → `ModelManagerPanel` callbacks | components/organisms/panels/ModelsPanel.tsx:56-80 | Direct: `scene.activatePlate`, `renamePlate`, `removePlate`, `resolveModelPlateId`. Through page handlers (page.tsx:5616-5690): `groupModels`, `ungroupModels`, `ungroupGroup`, `splitImportGroup`, `renameGroup`, `renameModel`, `selectModel`, `clearModelSelection`, `setActiveModelId`, `setSelectedModelIds`. |
| Exported module-level values used by other files | Manager :281 `SCENE_MODELS_SNAPSHOT_APPLY`; :553 `getSceneSnapshotRegistryBytes()`; types `LoadedModel`, `ScenePlate`, `PlateFrame` | `getSceneSnapshotRegistryBytes` → the page's history debug panel (page.tsx:6421,6441). The constant → the hollowing history listener (§5). The types are imported by ExportManager, useSceneAutosave, SceneCanvas, SlicingPanel, ExportPanel, `scripts/cli/sceneSliceMesh.ts` and others. These are type-only imports and do not reach the hook. |
| **Constructor callback** | `onBlockedByLock` option → `onBlockedByLockRef` (manager :1557,1590). Called at :2658, 2698, 3116, 3386. | Plate-lock refusals inside `updateModelTransform`, `updateModelTransforms`, paste and plate operations call back into the page's toast (`notifyPlateLockedRef`). |

Not found: no `createContext` around the scene. The only selection context is `components/selection/SelectionContext.tsx`, and it is a separate local "selected id" used by SelectionManager and the spotlight; it does not hold the manager. No `window.__*` handle to the manager. No MCP or automation server in `src-tauri/src` or `src/`. No plugin API that calls scene operations (see §6).

### 1. Hotkeys (hotkeyStore subscription, `app-hotkey-keydown` CustomEvent)

The infrastructure: `HotkeyRegistryManager.tsx` installs capture-phase listeners. They feed the Zustand `hotkeyStore` and re-dispatch `CustomEvent('app-hotkey-keydown'|'app-hotkey-keyup')`. Bindings are defined in `hotkeys/hotkeyConfig.ts` (`DEFAULT_KEYBINDINGS`).

| Binding | Mechanism | Where | Scene operations reached |
|---|---|---|---|
| `GLOBAL.DELETE` (Backspace) + `Delete` | `app-hotkey-keydown` listener → `triggerDelete()` in the delete registry | features/delete/useDeleteHotkey.ts:22-29, mounted at page.tsx:7983 | Whichever claim wins (§2): `deleteModel(activeModelId)`, `deleteModels` / `deleteModelsAndExtraPlates`, or support deletes |
| Ctrl/Cmd+A, +C, +V, +S (hard-coded keys, **not** registry actions) | `hotkeyStore.subscribe` with rising-edge detection | page.tsx:9900-9993 | Ctrl+A: `setSelectedModelIds`, `setActiveModelId` (all visible). Ctrl+C: `copySelectedModels` or `copyModel(activeModelId)`. Ctrl+V: `pasteCopiedModelsAutoArrange(arrangeSpacingMm)` and then selection. Ctrl+S: `handleTopBarSaveScene` → ExportManager VOXL save. The config has `CANVAS.SELECT_ALL/COPY/PASTE` and `GLOBAL.SAVE`, but nothing reads them, so these keys are **not remappable**. |
| `GLOBAL.SAVE_AS` | `useActionActive` | page.tsx:9486 | Save As flow |
| `CANVAS.TOOL_ARRANGE` (A) | `isActionActiveSync` in `usePrepareTransformHotkeys` → `onArrangeAll` | hotkeys/usePrepareTransformHotkeys.ts:35-64; callback at page.tsx:7997-8010 | `handleManualArrayArrangeModels` / `handleHighPrecisionArrangeModels` / `handleAutoArrangeModels('all')` → arrange manager → `scene.updateModelTransforms`, `addPlates`, `duplicateModelWithTransforms` |
| `CANVAS.TOOL_SELECT/MODIFY/MODIFY_LOCAL/SMOOTH/DUPLICATE` | same hook | same | Transform mode only (UI). Duplicate mode later calls `duplicateModelWithTransforms` through the arrange manager. |
| `GLOBAL.UNDO/REDO` | `isActionActiveSync` → `historyStore.undo/redo` | hotkeys/useUndoRedoHotkeys.ts:10-20, page.tsx:10364 | Indirect: the history registry calls the manager's registered handler `SCENE_MODELS_SNAPSHOT_APPLY` → `applySceneSnapshot` (§5) |
| Escape | `hotkeyStore.subscribe` | page.tsx:1650-1665 | `resolveSceneImportPlacementPrompt('load_as_is')` |
| Escape | `hotkeyStore.subscribe` | page.tsx:5705-5735 (hole-punch area) | `clearModelSelection`, `setSelectedModelIds`, `setActiveModelId` |
| Escape | `hotkeyStore.subscribe` | components/scene/SceneCanvas/SceneCanvas.tsx:4616-4640 | `onActiveModelChange(null)` (→ page selection → `scene.clearModelSelection` / `selectModel`), and dispatches `model-deselected` |
| Organic cut Delete (priority 200) | `useOrganicCutHotkeys.ts` → delete registry | `hotkeys/useOrganicCutHotkeys.ts` | Cut seam edit, which pre-empts model delete |
| Support placement and selection keys | `supports/interaction/shared/placement/hotkeys/supportPlacementHotkeyResolver.ts`, `selectionController.ts`, useSupportInteractionManager.ts:444 (`app-hotkey-keydown`) | | The support store, not the manager |
| Nudges | **Not found as hotkeys.** A code comment (manager :3105) says nudge hotkeys land in `updateModelTransform`, but no nudge binding exists in `hotkeyConfig.ts`. Worth checking. | | |

### 2. Delete registry (registration seam)

`features/delete/deleteRegistry.ts`: priority claims, dispatched by `triggerDelete()`.

| Priority | Registered at | Predicate | Scene op |
|---:|---|---|---|
| 200 | `hotkeys/useOrganicCutHotkeys.ts` | cut seam edit active | none (cut tool) |
| 100 | `features/supports/useSupportInteractionManager.ts` | support selection | support store removal |
| 50 | `features/hole-punching/useHolePunchManager.ts` | hole selected | hole punch removal → `scene.replaceModelGeometry` |
| 30 | app/page.tsx:9436-9456 | prepare and selection not empty | `scene.deleteModelsAndExtraPlates(ids)` or `scene.deleteModels(ids)` |
| 20 | app/page.tsx:9458-9470 | prepare, select-all active, models exist | `scene.deleteModelsAndExtraPlates(all ids)` |
| 10 | **manager** :7069-7081 (useEffect) | prepare and activeModelId set | `deleteModel(activeModelId)` → `deleteModels` |

The manager registers its own delete claim. It is the only manager operation reached by a seam it set up itself.

### 3. Context menus

| Menu | Dispatch | Where | Scene ops |
|---|---|---|---|
| Editor canvas menu (`EditorContextMenu`, action vocabulary `EditorMenuAction` at components/ui/EditorContextMenu.tsx:28, items at :105) | `handleEditorMenuAction` switch | page.tsx:6165-6411, rendered at :11201. Opened by `setEditorContextMenuPos` (:5621), from canvas right-click and from the models list's "Model actions…" row | `split-supports` → `splitSupports(activeModelId)`. `merge-supports` → `mergeSupports()`. `delete` → `dispatchDeleteModelAction(..., scene.deleteModels)`. `copy` → `copySelectedModels` / `copyModel`. `cut` → `dispatchCutModelAction(..., scene.cutSelectedModels)`. `paste` → `pasteCopiedModelsAutoArrange`. `undo-repairs` → `undoRepairsInPlace`. `show-repair-report` → `openMeshRepairReportForModel`. `repair` → the repair flow. `mark-as-support-geometry` / `mark-as-model-geometry` → `toggleSupportDesignation(ids, bool)`. `link-models` / `unlink-models` → `linkModels` / `unlinkModels`. `scan-for-supports` → `scanModelForSupportsInPlace`. `supports-toggle-curve` / `supports-add-joint` → support store (`toggleSegmentCurve`), not the manager. The targets are **implicit**: `selectedModelIds`, else `activeModelId`, resolved inside the page. |
| Models panel menu (`ContextMenu`) | `handleContextMenuSelect` | components/controls/ModelManagerPanel.tsx:514-585 (entries :463-511) | `group-selected` / `ungroup-selected` / `ungroup-folder` / `rename-folder` / `rename-model` / `split-bodies` / `repair-model` → page handlers → `groupModels`, `ungroupModels`, `ungroupGroup`, `renameGroup`, `renameModel`, `splitImportGroup`, the repair flow. `rename-plate` / `delete-plate` → `scene.renamePlate` / `scene.removePlate` (after a confirm modal when the plate holds models). `model-actions` → opens the editor menu above. |
| Plate HUD buttons (not a menu, but indirect) | props on the canvas | page.tsx:10833-10851 | `addPlate()`, `setPlateLocked(!plateLocked)`, `onArrangePlate` → `handleAutoArrangeModels('all', …, {plateFillMode:'plate'})`, `renamePlate` (also from `PlateNameLabel` via SceneCanvas :6425) |
| TopBar file menu | props | page.tsx:10458-10462 | `onNewScene`, `onSaveScene`, `onSaveSceneAs`, `onOpenScene`, `onImportSceneChange` → the import-export manager → `scene.loadFiles` / `onFileChange`; save → ExportManager |

### 4. Window CustomEvents (event bus)

None of these are dispatched or listened to inside the manager. They reach it only through the page and SceneCanvas callbacks.

| Event | Dispatched | Listened | Effect on scene |
|---|---|---|---|
| `model-clicked` `{modelId}` | SceneCanvas.tsx:1644, StlMesh.tsx:1434, useMarqueeSelectionHandlers.ts:226 | SelectionManager.tsx:46 (local SelectionContext), SceneCanvas.tsx:4601 (gizmo visibility), SupportRenderer.tsx:1162, RaftRenderer.tsx:110, LineRaftRenderer.tsx:202 | Does not change the manager directly. The same click path calls `onActiveModelChange` → page `handleSceneModelSelection` (page.tsx:5681) → `scene.selectModel` / `clearModelSelection`. |
| `model-deselected` | SceneCanvas.tsx:4636,4743, SelectionManager.tsx:72 | page.tsx:9478 (`clearSelectAll`, which turns off select-all mode and so changes which delete claim is enabled), renderers | Indirect: the delete-registry predicate at priority 20 |
| `support-model-pointer-select` `{modelId}` | supports/interaction/clickHandlers.ts:77 | SceneCanvas.tsx:1658 → `selectModelFromPointerHit` → `onActiveModelChange` | `scene.selectModel` (support mode clicking a model) |
| `app-hotkey-keydown` / `keyup` | `HotkeyRegistryManager.tsx` | §1 | §1 |
| Preferences events `app-3d-view-settings-changed` (components/settings/view3dPreferences.ts:24,153,167), `dragonfruit://multi-plate-settings-changed` (multiPlatePreferences.ts:29,115,135), workspace camera settings | `save*()` in the settings modules | The manager subscribes with `useSyncExternalStore` (:1875 multi-plate, :3893 workspace camera). View3D is read once at hydrate (:1947) and written by `setView3dSettings` (:1992-1996). | Multi-plate ordering change → **effect at :7765-7800 moves every model on a non-first plate (`modelsShiftedForRelaidPlates`) with no history**. `followLandedPlate` changes plate switching in `updateModelTransform`. View3D footprint change → see §5. |
| `scene-autosave-failed` | hooks/useSceneAutosave.ts:677 | page.tsx:1271 | Toast only |
| Gizmo flags `window.__gizmoDragEndedThisFrame`, `__modelClickedThisFrame`, `__modelClickGuardUntil` | JointGizmo, BezierGizmoManager, SceneCanvas, StlMesh, marquee | SelectionManager, SceneCanvas | Gate whether a click deselects, and so gate `selectModel` / `clearModelSelection` |

### 5. Module stores, history registry, effects that react to stores

| Mechanism | Where | Operations reached / triggered |
|---|---|---|
| **Undo/redo registry** (typed history over `historyStore`) | Manager :298 `sceneHistory = createTypedHistory`; :350 module-level `sceneSnapshotRegistry` Map; :2343-2360 `sceneHistory.register(SCENE_MODELS_SNAPSHOT_APPLY, …)` | Every undo or redo of a scene step, from any trigger (hotkey, toolbar, history panel), runs `applySceneSnapshot` (manager ~:2280-2340: setModels, active and selection, plates, support store `setSnapshot` / `resetStore`). The snapshot pairs live in a **module-level Map**, so they outlive the hook. |
| History subscribers | `historyStore.subscribeHistory*` | hooks/useSceneAutosave.ts:766 (every push, undo or redo schedules an autosave → ExportManager VOXL write), page.tsx:1797 (unsaved flag), page.tsx:5951 (undo/redo toast), page.tsx:6427 (debug), features/printing/useSlicedPlates.ts:77 (invalidates sliced plates), features/hollowing/useHollowingManager.ts:1300-1308 (on a `SCENE_MODELS_SNAPSHOT_APPLY` with `modelId`, frees hollowing caches) |
| Support store (`supports/state.ts`) | Manager imports `getSnapshot, setSnapshot, loadFromImportFormat, mergeFromImportFormat, transformSupportsForModel, transformAllSupportsForSingleModel, reassignAllSupportModelIds, resetStore, begin/endSupportStateBatch` (:30, :1106) | Two-way: the manager writes it on transform, delete, duplicate, paste, import and undo. Support tools write it without going through the manager. The manager's snapshot captures read it (`includeSupportState`). No subscription from the manager to support changes was found. |
| Auto-brace mesh store (registration seam) | Manager :7490-7505 effect → `registerMeshForAutoBrace` / `unregisterMeshForAutoBrace` (`supports/autoBracing/meshGeometryStore.ts`) | Every `models` change re-registers all geometries and matrices. Auto-brace reads them by id. |
| Profile store | Manager :1869 `useSyncExternalStore(subscribeToProfileStore…)` → `activePrinterProfile` | **`useLayoutEffect` at :7694-7745**: a printer change or build-footprint change re-lays plates and shifts models and supports (`shiftSupportsWithModels`). A printer change pushes history labelled `switchPrinterLabel(name)`. Triggered by the printer picker, the profile editor, or importing a VOXL with a printer bundle. |
| `meshChunkStore` (voxl) | Manager :6552-6581 `meshChunkStore.bake(...)` | Load-time precompression that ExportManager later reuses for saves |
| Preferences in localStorage, read and written directly | Manager :640-674 (mesh appearance), :796-839 (recent files), :681-690 (IndexedDB recent-file handles), :2742-2744 (`autoLift`, `liftDistance`) | Hydrate effects at :1930-1948; a persist effect on every appearance change (:1953+) |
| `onBlockedByLock` callback ref | §0 | Lock refusals → page toast |

### 6. Tauri events, OS integration, plugins, automation

| Mechanism | Where | Reaches |
|---|---|---|
| `dragonfruit://scene-file-handoff` (Rust `app.emit`) | src-tauri/src/main.rs:3580-3591, emitted at :3621 (primary launch) and :4475 (single-instance second launch, i.e. double-clicking a .voxl while the app runs); listened at features/import-export/useImportExportManager.ts:817-860 | `queueLaunchSceneEntries` → `flushQueuedLaunchSceneImports` (:710-740) → `importSceneFromLaunchEntries` (:673-703, `invoke('read_print_file_bytes')`) → `importSceneFilesWithPluginWarning` → `scene.loadFiles` / `onFileChange`. Also `invoke('get_launch_scene_files')` on mount (:800-812). |
| `tauri://drag-drop`, `drag-over`, `drag-leave`, `drag-drop-cancelled` | useImportExportManager.ts:1037-1117 | `handleDroppedPrepareFilesRef` → `handleDroppedPrepareFiles` (:868+, prepare mode only) → `scene.loadFiles` / `onFileChange` → manager import pipeline (placement prompt, hollowing prompt, repair, free-spot placement) |
| Window close request | page.tsx:5140-5180 `currentWindow.onCloseRequested` | Unsaved-changes guard → save |
| Progress events (`islandscan://progress`, `mesh-repair-progress`, `mesh-solid-remesh-progress`, slicer progress) | utils/meshRepair.ts:312,362,516, `utils/meshShrinkwrap.ts`, nativeSlicerBridge.ts:330 | Progress UI only. Repair results return to the manager by `await`, not by event. |
| **Plugin file-type handlers** (built-in complex plugins) | Manager :37-39 imports `getBuiltinComplexPluginFileTypeHandlers`, `getBuiltinComplexPluginDefinitions`; :1439-1460 `scenePluginImportHandlersByExtension` memo; used by `handleImportPluginSceneFile` (:5738-5760+) | A plugin-declared scene extension (`fileType.isSceneFile`) imports through the plugin's handler, which returns `PluginSceneImportPayload` (features/plugins/pluginFileTypeBridge.ts:12-73). The manager then adds the models. Plugins cannot call scene operations; they only supply data. The plugin-import UI keys (`pluginImportPhase`, `handlePluginJsonFile`, `handlePluginStlFile`, `cancelPluginImport`) are **hard-wired to idle/undefined stubs** at manager :7062-7066 but are still consumed by SceneFileModals. They are dead wiring. |
| Getting a scene into a slice | features/slicing/voxlScenePayload.ts:21,93 calls `serializeVoxlDocumentV2` | Slicing builds a VOXL payload from app state. This is a second app-side writer next to ExportManager, and it is worth comparing with the CLI save. |
| MCP / automation / IPC server | Searched `src-tauri/src/*.rs` and `src/`: **none** | — |
| CDP driver (dev only) | `scripts/df-cdp.mjs` (`npm run profile:df`) | Drives the running webview with trusted input over the Chrome DevTools Protocol (CDP): `eval`, `click`, `key`, `drag`. It can trigger any hotkey or menu path above, and `eval` can run arbitrary JS. It has no scene handle, so it reaches operations only through the UI. The nearest thing to automation today. |
| TS CLI | `scripts/dragonfruit-ts-cli.ts` | Does not reach the manager at all; it edits the VOXL file. See `cli.json`. |

### 7. Observations for the extraction

1. **Implicit targets are resolved in three places, not in the manager.** The editor menu (page.tsx:6165-6411), the Ctrl+C/V/A subscription (page.tsx:9900-9993) and the delete claims each turn "selection else active model" into ids. `resolveModelActionTargetIds` (features/scene/modelActionTargets.ts:8) is the pure helper, but link, unlink and support designation inline their own copies (`page.tsx` ~`6365-6395`). A command registry needs one resolver.
2. **Two state-reactive effects move models with no user gesture.** The printer or footprint relayout (:7694, which pushes history only on a printer change) and the plate-ordering relayout (:7765, never in history). Both are rules (`modelsShiftedForRelaidPlates`) that the CLI would also need when it gains `--printer` or plate edits.
3. **Hard-coded Ctrl+A/C/V/S** bypass the hotkey registry although `CANVAS.SELECT_ALL/COPY/PASTE` and `GLOBAL.SAVE` exist in `hotkeyConfig.ts`. They are duplicated in the editor menu, so the paste rule `pasteCopiedModelsAutoArrange(arrangeSpacingMm)` has two callers with the same implicit arguments.
4. **The history snapshot registry is a module-level Map** (:350), while `pushSceneSnapshotHistory` is hook-scoped. Any headless "apply the result and push history" path has to go through the hook instance.
5. **There is no seam a script can reach inside the running app.** The only out-of-window entry points are the OS file handoff, drag-drop, and CDP. An MCP or agent surface would need either the ADR-0045 pure modules plus the CLI, or a new registry. Nothing exists today.
