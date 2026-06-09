# LYS Import — Tapered Twig, Tapered Brace & Brace↔Twig Connections Development Plan

## Overview

**The plain-English goal.** Lychee (`.lys`) can author supports that DragonFruit only recently learned to make: twigs whose two ends are *different diameters* ("tapered twigs"), braces whose two ends are different diameters ("tapered braces"), and leaves/braces that hang off a twig instead of off a trunk/branch. We added that capability to DragonFruit a while after the fact, so the LYS importer was written before those features existed and never learned to import them faithfully. This plan finishes teaching the importer to reproduce them so an imported support behaves *identically* to one a user places by hand.

**Important framing (settled during research).** There is **no separate `TaperedTwig` / `TaperedBrace` entity type** anywhere in the codebase or git history. "Tapered" is an emergent property of the existing entities:

- A **twig is tapered** when `contactDiskA.contactDiameterMm ≠ contactDiskB.contactDiameterMm`. Linear interpolation along the twig (`twigTaper.ts`) does the rest — *every* twig runs through this; a uniform twig is just the equal-diameter case.
- A **brace is tapered** when its two endpoint knots have different `diameter`. The renderer detects this at runtime (`isTaperedBrace`) and draws a per-end shaft.

So the importer work is **fidelity**, not a new type: carry the correct per-end diameters, and size twig-hosted knots with the twig's local-taper rule (`localDiameter × 1.10`) instead of the generic `segment.diameter + 0.1mm`.

**Status board (updated after in-app verification):**

- ✅ **Tapered twig** — VERIFIED WORKING in-app (user confirmed; imports with correct per-end taper). Done, no code needed.
- 🐞 **Leaf-on-twig** — connects on import but the **leaf cone snaps on first knot drag** (knot looks fine; leaf is slightly mis-aimed until first interaction). Root cause found — see below. **Priority fix.**
- ⚠️ **Brace-on-twig** — connects, but knot sizing + on-line projection still use the generic (non-taper) path. Secondary fix.
- ❌ **Tapered brace (any host)** — NOT in importer at all: both brace knots get one shared `braceJointDiameter`, so imported braces are always uniform. Needs LYS per-end diameter mapping. (Open: confirm LYS exposes distinct base/tip brace diameters.)

**What's already done (current WIP on `feat/lys-import-leaf-brace-on-twig`).** On top of committed PR #156 ("Twig taper, leaf+brace snap to twigs"), the uncommitted working tree already:

- Adds `{ kind: 'twig' }` to the importer's `HostEntry` union and registers each imported twig as a host (`hostsByLysId.set(id, { kind: 'twig', ... })`).
- Adds twig branches to **all** host-projection helpers (`projectPointToHost`, `getHostBaseAndTipPoints`, `collectHostSegmentProjectionCandidates`, `projectPointToHostPreferredSide`), all projecting onto the segment **joint line** (`bottomJoint→topJoint`) so import == post-drag.
- Builds imported twigs with full native anatomy (raycast surface normals, disk-end socket joints via `twigDiskJointStandoff`, per-disk `diskLengthOverride`), and imports per-disk diameters independently (→ tapered twig falls out naturally — VERIFIED).
- Gives **leaf-on-twig** the taper-aware special case: knot pos forced on-line + `'project'` hint, knot diameter and cone body sized from `resolveTwigDiameterAtSegmentT` + the 10% rule.
- Host-repo `state.ts` (`normalizeLoadedKnotAndLeafGeometry`) resolves twig-hosted knots against twig joints and re-sizes them with the 10% rule at load time.

**🐞 ROOT CAUSE — leaf-on-twig cone snaps on first drag (priority fix).**

The importer aims the leaf cone **once, from the bare cone tip**, at the knot ([convertLysData.ts:970-978](plugins/lys-import/converter/convertLysData.ts#L970-L978)):
```ts
const conePosVec = new THREE.Vector3(contactCone.pos.x, ...);   // bare tip
const coneToKnot = knotPosVec.clone().sub(conePosVec);
contactCone.normal = leafDir;                                    // (knot - tip).normalize()
contactCone.profile.lengthMm = conePosVec.distanceTo(knotPosVec);
```
The renderer's first-drag recompute (`recomputeLeafPreviewContactCone`, [SupportRenderer.tsx:234-308](src/supports/SupportRenderer.tsx#L234-L308)) aims from a **disk-standoff-offset start** and **iterates 3×** to converge:
```ts
const thickness = calculateDiskThickness(cone.surfaceNormal, axisVec3, cone.profile);
const start = tip.clone().add(sn.clone().multiplyScalar(thickness));  // NOT bare tip
axis = knot.clone().sub(start).normalize();
finalLength = Math.max(0.1, knot.clone().sub(start).length());
```
So the imported cone's `normal`/`lengthMm` are off by the disk-thickness correction (and the un-converged angle). The first drag emits a preview knot → renderer re-aims the cone → `updateLeaf` on release persists it → visible "snap." It only bites on twigs because twig knots are force-projected off the LYS-authored point (`'project'`), making the discrepancy visible; on trunk/branch hosts the knot stays at the authored point so it's negligible.

**Fix:** make the importer aim the leaf cone the same way the renderer does — iterate from `start = tip + surfaceNormal × calculateDiskThickness(surfaceNormal, axis, profile)`, not from the bare tip, AFTER `knot.pos` is finalized on-line. `calculateDiskThickness` is exported from `src/supports/SupportPrimitives/ContactDisk/contactDiskUtils.ts` and already imported in the sibling `converter/contactAssembly.ts`. Mechanism is host-agnostic; resolving it fixes the twig case and tightens trunk/branch leaves.

**What's missing (verified during research).** The brace path was *not* given the same twig treatment the leaf path got:

1. **Brace-on-twig knot diameter is wrong.** In the brace phase, both brace knots get `diameter: getJointDiameter(braceDiameter)` (generic). On a twig they should use `twigJointDiameterForLocalDiameter(resolveTwigDiameterAtSegmentT(twig, shaftId, t))`, matching the leaf path and a hand-placed brace.
2. **Brace-on-twig knot pos / import hint.** Brace knots keep their authored `pos` and `_importHint: 'braceImported'`. Leaf-on-twig knots are forced onto the joint line with `'project'` because the runtime strictly reprojects twig-hosted knots; a brace knot ~0.1mm off the line will "snap" on first interaction. Needs the same on-line treatment for twig hosts (while preserving brace behavior for non-twig hosts).
3. **Tapered brace not imported at all.** Both brace knots ([convertLysData.ts:1278,1287](plugins/lys-import/converter/convertLysData.ts#L1278)) share one `braceJointDiameter` from a single `braceDiameter`. An imported brace is therefore always uniform. Needs per-end diameter mapping. **OPEN QUESTION:** confirm whether raw LYS carries distinct base-side vs tip-side brace diameters (`settings.base.joinDiameter` vs `settings.tip.diameter`/`baseTip.diameter`) before designing the mapping.
4. **No tests** cover leaf-on-twig or brace-on-twig.

**Verified NOT missing.** Brace↔twig *connection wiring* is complete end-to-end: `pickBracePairing → projectBracePointToHost → projectPointToHost / pickBestBraceHostCandidate / getHostBaseAndTipPoints / projectPointToHostPreferredSide` all have twig branches. Braces pair with and project onto twig hosts correctly.

---

## Development Checklist
> **Agent Note:** Update this checklist after completing each step. Mark `- [x]` when done. Changes span TWO git repos (host + `plugins/lys-import` submodule); keep them in sync and bump the submodule pointer together.

- [x] **Phase 0: Tapered twig** — VERIFIED WORKING in-app. No code changes required.

- [x] **Phase 1: Fix leaf-on-twig cone snap (PRIORITY — root cause confirmed) — DONE (code), pending in-app verify**
    - [x] Chose SSOT reuse over a 3rd copy of the math (user decision): exported `recomputeLeafContactConeAxisAndLength` from `src/supports/state.ts` and called it in the importer. This is the EXACT routine load-normalization (`recomputeKnotDependentGeometry`) and the drag preview (`recomputeLeafPreviewContactCone`) use, so import == load == drag by construction.
    - [x] `convertLysData.ts`: added `import { recomputeLeafContactConeAxisAndLength } from '@/supports/state';`; in the leaf block replaced the one-shot `tip->knot` aim with a call to the SSOT (keeps `contactCone.pos` fixed = LYS contact preserved; only `normal`/`lengthMm` recomputed toward the on-line knot).
    - [x] `tsc --noEmit` passes clean. No circular import (`state.ts` does not import the plugin). `knotPosVec` still used (line 949) — no dead var.
    - [x] **Verified in-app:** imported leaf-on-tapered-twig sits correct with NO snap on first knot click/drag.
    - [ ] OPTIONAL cleanup (not required): move `recomputeLeafContactConeAxisAndLength` into a pure util (e.g. `contactDiskUtils.ts`) so converter + renderer + state don't import the whole state store to reach it. Larger refactor; defer unless desired.

- [ ] **Phase 2: Pre-flight for brace work (no code changes)**
    - [ ] Confirm `pairing.projA/B.parentShaftId` for a twig host is the twig **segment** id (not twig id) — required for `resolveTwigDiameterAtSegmentT`.
    - [ ] Confirm `resolveTwigDiameterAtSegmentT` + `twigJointDiameterForLocalDiameter` already imported in `convertLysData.ts` (yes, for leaf path).
    - [ ] **Resolve OPEN QUESTION:** does raw LYS expose distinct base vs tip brace diameters? Inspect a real `.lys` brace's `settings` (`base.joinDiameter`, `tip.diameter`, `baseTip.diameter`). Decides whether tapered-brace import is possible and which fields map to which end.

- [x] **Phase 3: Brace knot sizing = native (scale to host shaft at position) — DONE (code), pending in-app verify**
    - [x] REFRAMED per user: this is NOT "import a tapered brace from LYS" (LYS has no tapered brace). It's "apply DF's native knot-sizing so each brace knot scales to whatever shaft it sits on, at its position." DF's tapered-brace RENDERING then falls out for free (two knots → two diameters).
    - [x] `convertLysData.ts` brace phase: added `braceKnotDiameterForHost(host, proj)` — twig host → `twigJointDiameterForLocalDiameter(resolveTwigDiameterAtSegmentT(host.twig, proj.parentShaftId, proj.t))`; non-twig → generic `getJointDiameter(braceDiameter)`. Applied per-endpoint (`knotA`↔`hostA`/`projA`, `knotB`↔`hostB`/`projB`), so a mixed brace (one twig end, one trunk/branch end) sizes each end correctly.
    - [x] Reload survives: `state.ts` `preserveImportedBraceUniformDiameter` keeps whatever diameter the importer wrote for `braceImported` knots → it now preserves the per-knot twig-taper diameter (no clobber). Confirmed by reading state.ts:790-810.
    - [x] `tsc --noEmit` clean.
    - [x] **Verified in-app:** imported brace endpoint on the thin end of a tapered twig is now correctly thin (not oversized); brace renders tapered between its two knots.
    - [ ] NOTE (out of scope unless observed): brace endpoints keep authored `pos` + `'braceImported'` (intentional "span fidelity", state.ts:856-862), NOT forced on-line like leaves. If a twig-hosted brace endpoint visibly snaps on first drag, revisit giving twig-hosted brace knots the on-line `'project'` treatment — but only if it actually manifests.

- [ ] **Phase 4: Tapered brace (gated on Phase 2 open question)**
    - [ ] If LYS carries per-end diameters: emit `knotA.diameter` and `knotB.diameter` from the respective ends (instead of one shared `braceJointDiameter`), so `isTaperedBrace` fires and the renderer draws the taper. NOTE: twig-hosted ends still override with the twig 10% rule (Phase 3) — these compose.
    - [ ] If LYS does NOT carry per-end diameters: document that tapered-brace import is not representable from the source and close the item.

- [ ] **Phase 5: Host-repo normalization parity for brace knots on twigs**
    - [ ] Confirm `normalizeLoadedKnotAndLeafGeometry` (state.ts) does not let the `braceImported`/`preserveImportedBraceUniformDiameter` path clobber the twig 10% diameter for twig-hosted brace knots — adjust precedence if it does, so import == reload == hand-placed.

- [ ] **Phase 6: Tests (submodule `LysConverter.test.ts`)**
    - [ ] **tapered twig** — different base/tip diameters → assert `contactDiskA.contactDiameterMm !== contactDiskB.contactDiameterMm` + both segment joints exist.
    - [ ] **leaf-on-twig cone aim** — assert cone `normal`/`lengthMm` match the disk-offset converging computation (i.e. import == post-recompute), so no first-drag snap.
    - [ ] **leaf-on-twig** — knot `parentShaftId === twig.segments[0].id`, `_importHint === 'project'`, `diameter` = 10%-taper rule.
    - [ ] **brace-on-twig** — twig-hosted knot(s) on segment id, on joint line, 10%-taper diameter (not generic).
    - [ ] **mixed brace** — one twig end + one trunk/branch end → each end uses its own diameter rule.
    - [ ] **tapered brace** (if Phase 4 lands) — distinct `knotA.diameter !== knotB.diameter`.

- [ ] **Phase 7: Manual verification & wrap-up**
    - [ ] Import a real `.lys` with tapered twig + leaf + brace; confirm no snap on first select and correct sizing/taper.
    - [ ] Converter test suite green.
    - [ ] Commit submodule changes, bump submodule pointer in host repo, commit host changes together.

---

## Technical Details

### Relevant Files

**Submodule `plugins/lys-import/` (converter logic):**
- `converter/convertLysData.ts` — main conversion. Brace phase ~L1193–1304 (the edit target, Phase 1). Leaf-on-twig reference implementation at ~L994–1015 and knot-pos/hint handling ~L917–937. Twig build + host registration ~L494–614.
- `converter/helpers.ts` — host projection (twig branches already present): `projectPointToHost` (~L532), `getHostBaseAndTipPoints` (~L580), `collectHostSegmentProjectionCandidates` (~L690), `projectPointToHostPreferredSide` (~L944), `projectBracePointToHost` (L800), `projectPointToHostForBrace` (L841), `pickBracePairing` (L1079). `getJointDiameter` (generic knot sizing).
- `converter/types.ts` — `HostEntry` union (twig variant added, ~L100).
- `LysConverter.test.ts` — test target (Phase 3).

**Host repo:**
- `src/supports/types.ts` — `Twig` (L157–161), `Brace` (L198–206), `Leaf` (L142–145), `Knot` (L67–80), `ContactDisk` (L147–155). No tapered types — confirmed.
- `src/supports/SupportTypes/Twig/twigTaper.ts` — `resolveTwigDiameterAtSegmentT` (L87), `twigJointDiameterForLocalDiameter` (L14), `TWIG_JOINT_DISK_DIAMETER_MULTIPLIER = 1.10` (L12).
- `src/supports/SupportTypes/Twig/twigBuilder.ts`, `twigJointStandoff.ts` — native twig anatomy the importer mirrors.
- `src/supports/SupportTypes/Brace/BraceRenderer.tsx` — `isTaperedBrace` derivation (L107); renderer that draws taper from per-end knot diameters.
- `src/supports/state.ts` — `normalizeLoadedKnotAndLeafGeometry` (twig map + 10%-rule re-sizing at load; Phase 2 target).

### Existing logic to mirror (leaf-on-twig → brace-on-twig)

Leaf path knot pos/hint (`convertLysData.ts` ~L928–936):
```ts
let knotImportHint: Knot['_importHint'] = preserveAuthoredAttachPoint ? 'preserve' : 'project';
if (parentHost.kind === 'twig') {
  knotPos = endpointRoles.attachProjection.pointOnLine;
  knotImportHint = 'project';
}
```

Leaf path diameter (`convertLysData.ts` ~L1005–1015):
```ts
if (parentHost.kind === 'twig') {
  const hostTwigDiameter = resolveTwigDiameterAtSegmentT(
    parentHost.twig,
    endpointRoles.attachProjection.parentShaftId,
    endpointRoles.attachProjection.t,
  );
  if (hostTwigDiameter !== null && hostTwigDiameter > 0) {
    contactCone.profile.bodyDiameterMm = hostTwigDiameter;
    knot.diameter = twigJointDiameterForLocalDiameter(hostTwigDiameter);
  }
}
```

### Proposed new logic (brace phase, per endpoint)

Replace the flat brace-knot construction (~L1273–1289) with per-endpoint sizing. Sketch (final placement/naming TBD during impl):
```ts
function braceKnotForEndpoint(
  host: HostEntry,
  proj: { t: number; pointOnLine: Vec3; parentShaftId: string },
  authoredPos: Vec3,
  fallbackDiameter: number,
): Knot {
  if (host.kind === 'twig') {
    const localDia = resolveTwigDiameterAtSegmentT(host.twig, proj.parentShaftId, proj.t);
    const diameter = (localDia !== null && localDia > 0)
      ? twigJointDiameterForLocalDiameter(localDia)
      : fallbackDiameter;
    return {
      id: uuidv4(),
      parentShaftId: proj.parentShaftId,
      t: proj.t,
      pos: proj.pointOnLine,        // force on-line (runtime reprojects twig knots)
      diameter,
      _importHint: 'project',
    };
  }
  return {
    id: uuidv4(),
    parentShaftId: proj.parentShaftId,
    t: proj.t,
    pos: authoredPos,               // preserve authored geometry for non-twig hosts
    diameter: fallbackDiameter,     // getJointDiameter(braceDiameter)
    _importHint: 'braceImported',
  };
}
```
- `knotA` uses `hostA` + `pairing.projA` + `knotPosA`; `knotB` uses `hostB` + `pairing.projB` + `knotPosB`.
- `fallbackDiameter = braceJointDiameter = getJointDiameter(braceDiameter)` (unchanged for non-twig).

### Integration points
- Brace phase consumes `pickBracePairing` output (`projA`/`projB` carry `parentShaftId` = twig **segment** id and `t`); these feed `resolveTwigDiameterAtSegmentT` directly.
- `_importHint: 'project'` is consumed/stripped by `normalizeLoadedKnotAndLeafGeometry` (host repo) — so Phase 1 (importer) and Phase 2 (load normalization) must agree on the twig 10% diameter, or a reload will resize the knot and reintroduce the mismatch.
- Renderer needs no changes: `isTaperedBrace` and twig-taper rendering already react to the per-end knot diameters this plan produces.

### Risks / watch-items
- **Precedence bug surface:** the brace `preserveImportedBraceUniformDiameter` / `braceImported` path in `state.ts` may clobber the twig 10% diameter on reload. Phase 2 explicitly checks this.
- **Segment id vs twig id:** `resolveTwigDiameterAtSegmentT` returns `null` if given the twig id instead of the segment id — Phase 0 confirms `proj.parentShaftId` is the segment id.
- **Mixed-host braces** (one twig end, one trunk end) must size each end independently — handled by per-endpoint construction.
