# LYS Import — Contact-Disk Seating for Anatomy-less Supports

**Status:** Planning / pre-implementation
**Branch:** `feat/lys-import-leaf-brace-on-twig`
**Scope:** `plugins/lys-import` (git submodule — has its own `.git`)
**Author context:** Reconstructed from a long diagnostic session. This document is the
single source of truth for the task so context is not lost. Read it top to bottom before
touching code.

---

## 0. TL;DR (the one-paragraph version)

The LYS importer builds **twig / stick / leaf-on-twig** contacts by orienting DragonFruit's
**contact disk** using Lychee's *authored normal*. But Lychee's contact primitive is a
**sphere on a shaft**, and its authored normal is the **sphere's approach direction**, not the
**true model-surface normal**. At steep approach angles those two diverge, so the disk seats
at the wrong angle — partial, oblong, floating contact (see screenshots in session). DragonFruit's
disk is *deliberately* stricter than the source: it exists to guarantee a clean, fixed-diameter
circular contact. The fix: for these anatomy-less contacts, derive the disk's `surfaceNormal`
from a **mesh raycast at the contact point** (true face normal) — keeping the shaft (`coneAxis`)
at Lychee's angle — and let the existing **joint standoff** absorb the difference. This is
**already exactly how the native `twigBuilder` works**; the importer is simply feeding the right
field the wrong vector and skipping the raycast that every other support already performs.

---

## 1. Background: the two contact philosophies

### Lychee Slicer (source format)
- A support contacts the model with a **sphere on the end of a shaft**.
- A sphere touching a surface contacts at a **single point regardless of surface orientation**.
- Therefore Lychee **does not care** how clean/perpendicular the interface is — geometrically it
  *can't* care; a sphere has no orientation to get wrong.
- **Defect this causes:** at a **steep approach angle**, the sphere↔surface intersection is an
  **oblong, smeared footprint** with more contact area than intended and unpredictable shape.
  Contact area becomes an uncontrolled variable dependent on approach angle.

### DragonFruit (target format)
- Contacts the model with a **contact disk**: a flat, oriented patch seated **perpendicular to
  the face**, with a **precise fixed diameter**.
- This is a **deliberate control mechanism** — it *refuses* the oblong smear Lychee tolerates,
  guaranteeing a clean circular contact of known area "nearly all the time."
- The disk is **better on purpose**. We are NOT trying to reproduce Lychee's sphere contact —
  we are **upgrading** an underspecified contact into a constrained one.

### The core mismatch
We are mapping an **orientation-free** primitive (sphere) onto an **orientation-critical** one
(disk). The disk encodes an assumption — "there exists a locally-flat-enough patch, and I know
its normal" — that Lychee's authored data does **not** reliably provide.

---

## 2. The key anatomical insight (why this is solvable)

The contact disk and the shaft are **decoupled by a joint**. Concretely, in the native twig:

- **Disk** faces along `surfaceNormal` (perpendicular to the model face).
- **Shaft** runs along `coneAxis` (the line between the two contact points — Lychee's geometry).
- A **socket joint** sits offset from the contact point **along `surfaceNormal`** by a standoff
  distance, and the **joint is the hinge** that takes up the angular slack between the
  perpendicular disk and the steep shaft.

So we do **not** have to choose between "honor Lychee's approach angle" and "seat the disk
perpendicular." We keep **both**:
- Shaft stays at Lychee's authored angle (fidelity to placement).
- Disk pivots to the true surface normal (contact quality).
- Joint absorbs the difference.

This is the whole unlock. Lychee couldn't do this (its sphere had no joint, no orientation).
DragonFruit's anatomy **already has the degree of freedom** needed.

---

## 3. Evidence: the real data (V3 Puck scene)

Source file (decrypted scene JSON):
`C:\Users\tyman\Desktop\Lys Conversion\V3 Puck_Scene.json` (640 KB)

Minimal reproduction: **2 supports, 1 object (`o4`)** — a twig and a leaf attached to it.

### `s573` — the twig (floating two-contact, no parents)
```
parentId: []          parentBaseId: null     parentTipId: null
isBaseTip: true       objectIdBase: "o4"     objectIdTip: "o4"
type: null            mini: true
base: { -2.691, 4.482, -2.433 }   baseNormal: { 0.230, 0.079, -0.970 }
tip:  { -3.080, 6.283, -0.872 }   tipNormal:  { 0.197, -0.557, -0.807 }
```
Both ends contact the model; both have authored normals → passes `isTwigCandidate`.

### `s574` — the leaf attached to the twig
```
parentId: []          parentBaseId: "s573"   parentTipId: null   <-- attachment is ONLY in parentBaseId
isBaseTip: true       objectIdBase: "o4"     objectIdTip: "o4"
type: 1               mini: true
base: { -2.878, 5.347, -1.683 }   baseNormal: { 0.201, 0.547, 0.813 }
tip:  { -2.635, 6.009, -0.700 }   tipNormal:  { 0.479, 0.312, -0.820 }
```

**Critical encoding detail:** the leaf's parent link is **not** in `parentId` (which is `[]`) —
it is encoded **only** in `parentBaseId: "s573"`. This is handled correctly already (see §5),
but it's the kind of thing that looks like a bug and isn't. Do not "fix" it.

### Inspector
`.scratch/lys-inspect/inspect.ts` already decodes a `.lys` and dumps the support graph
(mirrors `LysParser` decode without three.js). Run:
```
node --import tsx .scratch/lys-inspect/inspect.ts <path-to.lys>
```

---

## 4. Dead-ends already ruled out (DO NOT re-walk these)

1. **"The leaf is misclassified as a twig/root because `parentId` is empty."**
   ❌ Wrong. `inferParentIds` already folds `parentBaseId`/`parentTipId` in when `parentId` is
   empty (`helpers.ts:61-73`). The leaf IS correctly classified as a 1-parent child of `s573`.

2. **"The twig-host attachment path doesn't exist."**
   ❌ Wrong. It's fully wired: `projectPointToHost` has a `kind: 'twig'` branch
   (`helpers.ts:530-538` → `projectPointToTwigHost` at `:485-506`), `getHostBaseAndTipPoints`
   handles twigs (`:578-591`), and `pickAttachAndTipFromParentHints` uses the `parentBaseId`
   hint (`:1064-1067`). This is why it's "nearly working."

3. **"Reproduce Lychee's sphere contact faithfully."**
   ❌ Wrong goal. The sphere's oblique contact is the *defect*. The disk is the intended
   improvement. We are upgrading, not copying.

4. **"Average nearby face normals and make the disk perpendicular to the average."**
   ⚠️ Plausible *fallback* only. This was the user's instinct when we (wrongly) believed
   "nothing is available." Once we confirmed the **mesh is available and every other support
   raycasts**, the primary approach became a direct **raycast**, with averaging held in reserve
   for ray-miss cases (see §7, fallback question — currently UNDECIDED, to be settled by probe).

5. **"Build a special LYS-only support type with no contact disk."**
   ❌ Rejected as premature/expensive. It diverges the importer from native anatomy, burdens
   slicing/editing/gizmo/export, and defers the contact problem to first-edit. Only justified if
   contacts genuinely cannot be seated — which §2 shows they can.

---

## 5. How conversion currently flows (the accurate map)

Pipeline: **Parse** (`LysParser.ts`) → **Convert** (`LysConverter.ts` → `converter/convertLysData.ts`).

`convertLysData` phases (`converter/convertLysData.ts`):
- **Phase 1** group supports by owning object.
- **Phase 2** per-object transforms (`transformObjectPoint` `:134-140`, `transformObjectNormal` `:142-157`).
- **Phase 3** classify by topology (`:350-389`):
  - 0 parents → `isTwigCandidate` / `isStickCandidate` / else root→trunk.
    Twig/stick shape check **beats** has-children promotion (PR #156 — a twig can host
    leaves/braces). Twigs registered as `HostEntry{kind:'twig'}` (`:482-489`).
  - 1 parent → kickstand (grounded+hint+not mini/object-touching) else branch/leaf.
  - 2+ parents → brace.
- **Phase 4A** twig (inline build, `:415-489`) — **THE BUG LIVES HERE.**
- **Phase 4B** stick (`:494-559`, calls `createContactAssembly`).
- **Phase 4C** roots/trunks (`:564-667`, calls `createContactAssembly`).
- **Phase 4D** branches/leaves, iterative host resolution (`:669-891`).
- **Phase 4E** kickstands (`:902-1019`; explicitly reject twig parents `:920-925`).
- **Phase 4F** braces (`:1024-1135`).
- **Phase 5** per-object world-XY placement.

### Where contact orientation is decided
`converter/contactAssembly.ts :: createContactAssembly` — used by stick/root/branch/leaf.
Surface-normal **priority** (`:119-139`):
1. **Authored LYS normal** (if present) → used first, **raycast skipped**.
2. **Mesh raycast** smoothed normal — **only if no LYS normal**.
3. Cone axis (last resort).

> **VERIFIED CORRECTION (2026-06):** This is not merely "LYS normal wins for the
> normal *value*." The block at `:123-139` is a single `if (hasLysTipNormal) {...}
> else if (mesh) {...}`. The **entire raycast branch is structurally unreachable**
> for anatomy-less supports, because they *always* have an authored normal (that's
> what makes them pass `isTwigCandidate`). And that same `else` branch is the only
> place `finalTipPos` is snapped to `hit.point` (`:135`) — so for these supports the
> **contact point is never surface-snapped either**, not just the normal. The fix
> therefore **cannot be a simple priority flip**: the LYS-normal path and the
> raycast path are entangled in one if/else that also governs point-snapping (and,
> above at `:51-78`, socket placement). Plan §8 must split these concerns explicitly.

The cone carries TWO vectors (already decoupled, `:171-178`):
- `normal` = `coneAxis` (shaft / approach direction)
- `surfaceNormal` = disk facing
Standoff math (`:152-161`) reconciles the angle between them — this is the joint slack.

### Native twig anatomy (the correct reference)
`src/supports/SupportTypes/Twig/twigBuilder.ts`:
- Disk faces `surfaceNormal` (`aNormal`/`bNormal`, `:126`,`:136`).
- Shaft along `coneAxis = bVec - aVec` (`:71-74`).
- Joint offset **along surfaceNormal**: `jointPosA = aPos + aNormal * diskThicknessA` (`:92-96`).
- `src/supports/SupportTypes/Twig/twigJointStandoff.ts :: twigDiskJointStandoff` —
  `max(angle-based standoff, joint-radius+clearance)`; the comment explicitly notes steep
  surfaces push the joint out so the shaft stays off the model. **This is the steep-angle
  case already solved in native code.**
- `twigTaper.ts` — `twigJointDiameterForLocalDiameter` (10% rule, SSOT), taper math.

### The defect, exactly
Phase 4A sets `contactDiskA.surfaceNormal = transformedBaseNormal` and
`contactDiskB.surfaceNormal = transformedTipNormal` — i.e. the **LYS authored normal**
(= sphere approach direction). It **never raycasts the mesh**, even though `mesh` is in scope.
At steep approach angles the disk faces wrong → bad seating.

### The mesh IS available (confirmed)
Both import paths build a transformed ghost mesh and pass it to `convert()`:
- `useLysSceneImport.ts:208-238` — **JSON+STL path**. Mesh = a **separate STL the user
  picks** (`loadStlGeometry`, `:163`), NOT the `.lys` blob. This is the path our sample
  (`V3 Puck_Scene.json`) uses.
- `useLysImport.ts:315-344` — **single-`.lys` path**. Mesh = `data.geometry`, decoded
  from the `o*.bin` blob inside the container (`:334`).

> **NOTE (2026-06): the existing importer is working and is OUT OF SCOPE.** We are
> adding ONE feature (contact-disk seating for anatomy-less supports). Do not refactor
> or "fix" anything else in the import paths. (An earlier pass noted a rotation-order
> difference between the two ghost-mesh builds; per the user it is explicitly ignored —
> the importer works. It is irrelevant to this probe anyway: `V3 Puck`'s `o4` rotation
> is `{0,0,0}`, so the ghost mesh and contact points coincide regardless.)

For `V3 Puck`'s `o4` specifically (verified from the scene JSON): `rotation {0,0,0}`,
`scale {1,1,1}`, `position {0,0,5}`, `center {0.639, 2.205, 17.906}`. So
`transformObjectPoint(p) = p + (0,0,5)` and the ghost mesh is `(v − center) + (0,0,5)`.
These agree **iff** LYS support `base`/`tip` are authored in center-relative
(pivot-local, bottom-aligned) space — which the probe must MEASURE by confirming hits,
not assume.

---

## 6. Decisions locked in (from the user)

- **Scope:** ALL anatomy-less contacts → **twig + stick + leaf-on-twig**. (Not trunk/branch,
  which already raycast and behave.)
- **Reuse:** Route disk/joint construction through the **native standoff code**
  (`twigDiskJointStandoff`, `twigJointDiameterForLocalDiameter`) instead of hardcoded inline
  profile values, so importer and editor share one anatomy.
- **Fallback on raycast miss:** **UNDECIDED.** To be settled by the probe in §7. Options:
  (a) fall back to LYS authored normal (no regression), or
  (b) average nearby face normals. Decide from measured miss-rate.

---

## 7. Probe FIRST (no product code until this runs)

**Goal:** turn the remaining unknowns into measured numbers before changing the importer.

**Mesh source (verified):** the model mesh is NOT in the scene JSON. Decode the `o4`
geometry blob from the original container **`C:\Users\tyman\Desktop\Lys Conversion\V3 Puck.lys`**
(17.9 MB) using `LysParser`'s exact pipeline (decode constants `LysParser.ts:14-19`;
blob format `parseGeometry` `:343-414`). **Critical:** replicate `toNonIndexed()` +
`computeVertexNormals()` (`:408-411`) so the probe's mesh has the same **flat per-face
normals** the importer raycasts against — otherwise `calculateSmoothedNormal` operates on
different data than production.

Write a throwaway script in `.scratch/` that:
1. Decodes `V3 Puck.lys` → scene data + `o4` geometry (via `geometriesByName.get('o4')`).
2. Rebuilds the **same ghost mesh** the importer builds (same transform policy as
   `useLysSceneImport.ts:212-227`): `mesh.position = -center`, `ghostGroup` at
   `(0,0,pos.z=5)`, scale 1, rotation 0, then `updateMatrixWorld(true)`.
3. **Sanity gate (must pass before any other number is trusted):** cast a ray straight
   down (−Z) from well above each contact's XY and confirm it hits the mesh at all. If
   even this misses, the mesh rebuild/frame is wrong — STOP and fix the probe, do not
   report divergence numbers.
4. For each anatomy-less contact point (twig disk A `s573.base`, twig disk B `s573.tip`,
   leaf contact `s574`):
   - Raycast toward the contact. **Try BOTH** candidate directions (contact→other-endpoint
     and contact→socket-joint) and report which hits — this settles the §9 ray-direction
     question on real data.
   - Record **hit/miss**.
   - On hit, record **angle(LYS authored normal, smoothed mesh normal)** AND
     **angle(LYS authored normal, raw face normal)** — both, to expose whether smoothing
     itself tilts the disk (§9).
   - Record **distance from the LYS contact point to the actual hit point** (how far the
     authored point floats off the true surface).

**What the numbers decide:**
- **Miss rate ≈ 0** → simple LYS-normal fallback is enough; averaging code is dead weight.
- **Miss rate high** (these are oblique, edge-of-curvature contacts — plausible) → averaging
  fallback earns its place.
- **Normal divergence angle** → quantifies *how wrong* current behavior is and validates the
  whole theory on real data. Large angles at the bad-looking contacts = theory confirmed.

Report numbers + recommendation to the user, THEN implement.

---

## 7.5 PROBE RESULTS (ran 2026-06 on `V3 Puck.lys`) — THEORY CONFIRMED

> **Probe scripts:** `.scratch/lys-twig-probe/probe2.mjs` (final, raw-frame),
> `diag-transform.mjs` (frame diagnostic). v1 `probe.mjs` is superseded — see the
> frame correction below.

### Critical methodology correction (the importer is tested; the PROBE was wrong)
The first probe hand-rebuilt the importer's *ghost-mesh* transform (subtract `center`,
`+5` z) for the MESH while applying only part of it to the POINTS — splitting them into
two mismatched frames, so every contact "floated" 3–15 mm and all normals were garbage.
**The importer works and its transform is tested; do not validate it — match it.**
`diag-transform.mjs` swept candidate point transforms and found:

```
identity (p as-is)   nearest-surface dist = [0.004, 0.000, 1.121, 0.000] mm
p + center           = [11.5, 15.4, 12.5, 14.4] mm   (and all other candidates worse)
```

→ **The authored LYS `base`/`tip` points already sit ON the RAW geometry-blob surface.**
Contacts, mesh, and authored normals all live in ONE frame: the raw blob frame. The
divergence ANGLE is rigid-transform-invariant, so measuring in the raw frame is valid and
equals what the importer sees post-transform. The final probe (`probe2.mjs`) works
entirely in the raw frame — no hand-rebuilt transform, nothing to get wrong.

### The numbers (final probe)
| Contact | float-off (pt→surface) | ∠(authored LYS normal, true mesh normal) | Verdict |
|---|---|---|---|
| twig `s573` **base** | 0.008 mm | **111.08°** | catastrophic (disk faces ~backwards) |
| twig `s573` **tip**  | 0.000 mm | **50.46°**  | badly wrong |
| leaf `s574` **tip** (model contact) | 0.000 mm | **0.00°** | already perfect |
| leaf `s574` base (attaches to twig, NOT model) | 1.21 mm | 113.56° | N/A — correctly not on mesh |

### What the probe SETTLED
1. **Theory confirmed on real data.** Authored normal ≠ true surface normal — by up to
   **111°** at twig contacts. Non-uniform and contact-specific → no constant correction
   possible; per-contact raycast is the only fix.
2. **Why the importer "looks nearly working":** the leaf's model contact has a perfect
   (0°) authored normal, so it already seats. Only the twig ends are broken.
3. **Raycast hits reliably** at every model contact (float-off ≈ 0 mm). Primary path
   viable; **no fallback exercised on this sample.**
4. **Ray direction is a non-issue here.** Casting along `−authoredNormal` and along the
   shaft (`other→contact`) hit the SAME face and give the same angle to 2 decimals.
   Recommended primary cast: **`−authoredNormal`** (originate outside along `+N`, travel
   inward), picking the intersection NEAREST the authored point (robust to concavity).
5. **Smoothing is harmless on this mesh.** `calculateSmoothedNormal` ≡ raw face normal to
   2 decimals (expected: `toNonIndexed()`+`computeVertexNormals()` → flat per-face).

### §6 fallback question — RESOLVED (for now)
Miss rate = 0 at model contacts → **averaging fallback is dead weight; do NOT build it.**
On a (currently unobserved) raycast miss, fall back to the **authored LYS normal**
(no regression vs. today). Revisit averaging only if a real file shows misses.

### ⚠️ MAJOR FINDING (2026-06, probe3 + diag-frame-reconcile): the importer's
### contact points and ghost mesh DO NOT SHARE A FRAME — off by exactly `o4.center`.
- probe2 (raw geometry frame): contact seats at **0.000mm**, correct normals (111°/50°).
- probe3 (PRODUCTION ghost-mesh frame, exact `useLysSceneImport` policy): same contact
  raycasts to a face **9.6mm away**, wrong normal. The fix as first written would seat the
  disk to a RANDOM far face → WORSE than today.
- `diag-frame-reconcile.mjs`: `transformObjectPoint(P) − (mesh.matrixWorld · P)` =
  **(0.639, 2.205, 17.906) = `o4.center` exactly.**
- **Root cause:** the ghost mesh offsets its inner mesh by `mesh.position = −center`
  (`useLysSceneImport.ts:224`), but `transformObjectPoint` (`convertLysData.ts:134-140`)
  does `scale → rotate → +posZ` with **NO `−center`**. So importer contact points float
  ~18mm off the ghost mesh.
- **Why the importer still "works":** `createContactAssembly` uses the authored LYS normal
  and SKIPS the raycast whenever a normal exists (`contactAssembly.ts:123`) — and every
  anatomy-less support has one. So the broken raycast branch is essentially never taken;
  the frame mismatch has been dormant. Turning the raycast on naïvely exposes it.
- **CONSEQUENCE FOR THE FIX:** we must raycast in a frame where points and mesh AGREE.
  Two equivalent options were both proven on real data:
  - **Option B** (probe4): raycast in the **raw geometry frame** (0.000mm), map the surface
    normal to world via `transformObjectNormal`. Corrections 111.08° / 50.46°. ✓
  - **Option B2 (SHIPPED)** (probe5): raycast the **ghost mesh already in scope** in
    `convert()`, after subtracting `meshPivotShift = R·S·pivot` from the world contact point
    to land it ON the ghost mesh. `calculateSmoothedNormal` then returns the world normal
    directly (no separate mapping). floatOff 0.008 / 0.000mm; corrections 111.08° / 50.46°
    — identical to B and to probe2 to the decimal. Chosen because it reuses the in-scope
    mesh and the production normal path.

### ✅ IMPLEMENTED (2026-06) — leaf-on-twig host connection (2 bugs)
After the twig disks were fixed, selecting the leaf showed an **oversized knot** and
dragging it **snapped to the build plate** — the twig wasn't acting as the leaf's host.
Two independent root causes, both fixed:

1. **Importer twig segments had no joints.** Native `buildTwig` builds the segment with
   `bottomJoint`/`topJoint` (offset along each disk's surface normal by
   `twigDiskJointStandoff`, sized by `twigJointDiameterForLocalDiameter`). The importer's
   Phase 4A built a bare `{id,type,diameter}` segment. The runtime knot-drag path
   (`useKnotInteraction.resolveEndpoints`/`getHostCandidates`) and the taper math
   (`twigTaper.buildTwigTaperLayout`) read `seg.bottomJoint`/`topJoint` for host endpoints
   — absent → no host line → knot collapses toward origin (build plate) + diameter lookup
   degenerates. **Fix:** Phase 4A now builds both joints via the native standoff/taper
   helpers (preserving the importer's per-endpoint LYS contact diameters + raycast normals),
   and stamps `diskLengthOverride` on each disk — structurally identical to native `buildTwig`.
2. **`normalizeLoadedKnotAndLeafGeometry` (src/supports/state.ts) didn't resolve TWIG hosts.**
   It built only `trunkSegmentMap` + `branchSegmentMap`; a twig-segment `parentShaftId` matched
   neither → knot skipped normalization → diameter stayed at the `1.2` renderer default
   (oversized) and position/`t` never reconciled. **Fix:** added `twigSegmentMap` +
   `getTwigSegmentEndpoints` (endpoints = segment's two joints) and a twig fallback in the
   segment/endpoints resolution; widened the function's `Pick` to include `twigs`.
- **Verification:** `tsc` clean; **29/29** LysConverter + **5/5** import-normalization tests
  pass. Full supports suite: 43/46 — the 3 failures (autoBracing ×2, gridPlacement ×1) are
  **pre-existing on baseline** (confirmed by stashing the change and re-running: still 3 fail),
  unrelated to twig/knot work.

### ✅ RESOLVED (2026-06) — knot-not-on-twig + leaf "snaps on select" (CONFIRMED IN-APP)
After native-parity sizing, the leaf still rendered disconnected on import and "snapped"
into place only when the knot was selected. Root cause found via temporary in-app logging
(`[LYS-PREWARM]`), which exposed the **real runtime frame** — the importer applies a
**+16.2mm Z-lift** (`fileTypeHandlers.applySupportZOffset`) AFTER conversion that earlier
static probes never modeled. In that frame:
- The importer kept the **authored LYS attach point** for the knot (since its delta to the
  projected line was < 0.5mm → `preserveAuthoredAttachPoint`). But that authored point sits
  ~0.12mm OFF the twig's joint line, while the knot's stored `t` describes the on-line point.
  So `pos` and `t` disagreed: the initial render drew the off-line `pos`; selecting the knot
  reprojected onto the line (from `t`) → the visible "snap."
- **Fix** (`convertLysData` Phase 4D): for `parentHost.kind === 'twig'`, force
  `knot.pos = attachProjection.pointOnLine` and `_importHint = 'project'`, so the knot sits
  EXACTLY on the joint line (pos consistent with t) — identical to what the runtime resolves.
- **Verified in the real frame** (probe replicating convert + applySupportZOffset(+16.2) +
  mergeFromImportFormat): knot-to-joint-line **0.0000mm**; snap distance **0.0000mm**.
- **CONFIRMED IN-APP BY USER:** initial load renders correctly, knot sits on the twig, no
  snap on select. ✅
- Residual: ~0.2mm leaf-cone shortfall introduced by normalization's leaf recompute — below
  visual threshold; not pursued (user confirmed it looks correct).
- Debug logging (LeafRenderer, useKnotInteraction) and all `.scratch`/`__probe*` files removed.

### ✅ IMPLEMENTED (2026-06) — leaf-on-twig NATIVE PARITY (the real bar)
User bar: "an imported twig + leaf must be IDENTICAL to one I create myself." Diffing the
importer's leaf-on-twig against native `buildTwig`/`buildLeafData`/`LeafPlacementController`
found the importer diverged in THREE places (all now fixed):
1. **Importer twig segment had no joints** → no host line for knot drag/taper. Fixed (joints
   via native standoff, see above).
2. **`projectPointToTwigHost` projected onto the DISK-CENTER line, not the JOINT line** the
   runtime uses (`helpers.ts`). Fixed to project onto `segment.bottomJoint→topJoint` so the
   imported knot sits where a drag would put it (import == post-drag).
3. **Knot diameter + leaf body diameter sized unlike native.** Native sizes a twig-hosted
   knot by the 10% rule on the twig's LOCAL taper diameter at `t`
   (`twigJointDiameterForLocalDiameter(resolveTwigDiameterAtSegmentT(...))`), and the leaf's
   wide end = that host diameter. Importer left knot.diameter unset (→1.2 default) and sized
   the cone body from LYS endpoint settings. Fixed in TWO spots:
   - `convertLysData` Phase 4D: for `parentHost.kind==='twig'` leaves, set
     `knot.diameter` + cone `bodyDiameterMm` from the twig taper.
   - `state.ts normalizeLoadedKnotAndLeafGeometry`: twig-hosted knots now compute
     `computedDiameter` via the 10% taper rule (not the generic `segment.diameter+0.1mm`),
     else normalization would overwrite the converter's correct value back to the +0.1 form.
- **Verification (probe on real `V3 Puck`, run through real `LysConverter` + `loadFromImportFormat`):**
  imported knot.diameter `0.3080` == native `0.3080`; imported leaf bodyDiameter `0.2800` ==
  native `0.2800`. Both match to 1e-4. `tsc` clean; 34/34 LYS+normalization tests;
  43/46 supports suite (3 pre-existing unrelated failures).
- **AWAITING USER VISUAL CONFIRMATION** that the leaf now connects + the knot gizmo arrows
  point along the twig, matching a hand-placed leaf.

### ✅ IMPLEMENTED (2026-06) — twig Phase 4A
- `convertLysData.ts`: added `raycastSurfaceNormal(contactWorld, authoredNormal,
  meshPivotShift, mesh)` (Option B2) + per-object `meshPivotShift = R·S·pivot`. Phase 4A now
  sets `contactDiskA/B.surfaceNormal` from the raycast (fallback = authored normal on miss /
  no mesh). `coneAxis` unchanged (keeps Lychee's shaft angle).
- **Verification:** `npx tsc --noEmit` clean (exit 0); all **29** `LysConverter.test.ts`
  tests pass (no mesh in tests → fallback path → prior behavior preserved). Live path proven
  by probe5 (ghost-mesh frame, real `V3 Puck.lys`): disks now seat to the true face.
- **STILL TODO** (this sample can't exercise): route twig through native standoff helpers
  (`twigDiskJointStandoff` / `twigJointDiameterForLocalDiameter`) per §6; extend to stick
  (4B) + leaf-on-twig (4D). And: **user visual confirmation** in-app (before/after twig).

---

## 8. Implementation plan (after probe)

Scope: twig (Phase 4A), stick (Phase 4B), leaf-on-twig (Phase 4D leaf branch).

1. **Surface normal source swap.** For these contacts, derive `surfaceNormal` from the **mesh
   raycast** (true face normal) rather than the authored LYS normal. Keep `coneAxis` = Lychee's
   shaft direction. Apply the fallback chosen in §7 when the ray misses.
   - For stick/leaf this likely means *inverting the priority* inside (or around)
     `createContactAssembly` for these call sites — currently authored-LYS-normal wins over
     raycast (`contactAssembly.ts:119-139`). Be careful NOT to change trunk/branch behavior.
   - For twig (inline, doesn't call `createContactAssembly`) add the raycast directly.

2. **Route twig through native standoff.** Replace inline disk-profile/standoff values in
   Phase 4A with `twigDiskJointStandoff` + `twigJointDiameterForLocalDiameter`. Consider whether
   to call native `buildTwig` wholesale (cleaner, bigger change) vs. just adopting the standoff
   helpers (user said "use the standoff code" — minimum bar is the helpers).

3. **Verify the joint hinge.** Confirm the socket joint is offset along the (new, true)
   `surfaceNormal`, so the disk seats flat while the shaft keeps Lychee's angle.

4. **Regression guard.** Trunk/branch/kickstand contacts must be untouched. Existing
   `LysConverter.test.ts` (90 KB) must still pass; add focused cases for twig/stick/leaf-on-twig
   surface-normal sourcing.

---

## 9. Open questions / risks to watch

- **Ray direction at a two-ended contact.** A twig endpoint has no shaft "behind" it the way a
  trunk does. Use contact→(other endpoint) or contact→(socket joint) as the cast direction;
  validate in the probe that this actually hits the intended face.
- **Concave / no-seatable-patch contacts.** Some Lychee placements may have NO clean perpendicular
  seat (tight crevice / high curvature). Decide graceful degradation (tolerant disk vs. flag)
  — only if the probe shows such cases exist in real files.
- **Smoothed vs. raw mesh normal.** `createContactAssembly` uses `calculateSmoothedNormal(hit)`.
  Smoothing across a curved patch may tilt the disk off the true contact tangent; the probe
  should compare smoothed vs. face normal if divergence looks off.
- **Disk footprint vs. patch size.** Contact diameters in the sample are ~0.28–1 mm (small), so
  curvature across the footprint is probably minor — but confirm, don't assume.
- **Submodule discipline.** `plugins/lys-import` is its own git repo. Keep changes on this
  feature branch; do not commit until reviewed.
- **[NEW, verified] `createContactAssembly` raycast branch is unreachable for our scope.**
  See §5 correction: the `if (hasLysTipNormal) … else if (mesh) …` means stick/leaf-on-twig
  contacts (which always have authored normals) never raycast and never surface-snap the
  point. The stick fix (§8) must restructure this if/else, not just reorder priority — and
  must NOT change trunk/branch/root behavior, which depends on the current ordering.

---

## 10. Key file index (quick jump)

| Concern | File |
|---|---|
| Container parse / decrypt / geometry | `plugins/lys-import/LysParser.ts` |
| Conversion orchestration | `plugins/lys-import/LysConverter.ts` |
| Core conversion (phases) | `plugins/lys-import/converter/convertLysData.ts` |
| Classification + projection helpers | `plugins/lys-import/converter/helpers.ts` |
| Contact cone/disk + raycast assembly | `plugins/lys-import/converter/contactAssembly.ts` |
| Conversion types / HostEntry | `plugins/lys-import/converter/types.ts` |
| Import flow (mesh build) A | `plugins/lys-import/useLysSceneImport.ts` |
| Import flow (mesh build) B | `plugins/lys-import/useLysImport.ts` |
| Native twig builder (reference) | `src/supports/SupportTypes/Twig/twigBuilder.ts` |
| Native twig joint standoff (reuse) | `src/supports/SupportTypes/Twig/twigJointStandoff.ts` |
| Native twig taper / 10% rule (reuse) | `src/supports/SupportTypes/Twig/twigTaper.ts` |
| Scene inspector (decode + dump graph) | `.scratch/lys-inspect/inspect.ts` |
| Anatomy docs | `docs/reference/support-anatomy/{twig,leaf,brace,stick}.md` |
| Sample scene (twig + leaf-on-twig) | `C:\Users\tyman\Desktop\Lys Conversion\V3 Puck_Scene.json` |

---

## 11. Next action

Run the **§7 probe** on `V3 Puck_Scene.json`, report hit/miss + normal-divergence numbers,
settle the §6 fallback question, then implement §8. No product code before the probe.
