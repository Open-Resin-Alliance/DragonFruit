# Organic Cut — Registration Key — Dev Plan

> Status: **Draft for review** · Branch: `feat/organic-cuts` · Owner: TableflipFoundry
> Scope of this doc: design + milestone plan for adding an automatic **registration key** (peg + socket) to the organic cut, so the two halves socket together in exactly one alignment. This is the "registration keys/pegs" deferred in the organic-cuts dev plan (§ prototype scope).

---

## 1. Problem & Goal

The organic cut splits a model into two watertight halves that mate along a curved seam. Today they only *touch* — nothing holds them in alignment when glued. A user reassembling the print has to eyeball the fit.

**Goal:** when the user opts in, automatically add a **key** straddling the cut — a **male peg** on one half and a matching **female socket** on the other — so the halves self-locate and seat in exactly one position. With a print tolerance so the peg actually slides into the socket.

### What this does / does not do

- ✅ **Does:** generate one tapered peg + matching socket, sized from the cut's cross-section, placed at the center of the cut, oriented perpendicular to the cut, with a slide-fit tolerance. Union the peg onto one half, difference the socket from the other. Show a live preview of both.
- ❌ **Does not (this milestone):** multiple keys, user-positioned keys, key shape options (round/dovetail), per-half manual assignment. All deferred; the design must not preclude them.

### Hard constraint

**All key logic lives in `rust/dragonfruit-organic-cut/`.** Nothing key-related goes in `dragonfruit-mesh-repair`. (This is a direct response to the prior structural-debt cleanup — the cut tool got its own crate; the key is part of the cut tool.)

---

## 2. The spec (agreed with the domain expert)

### Trigger
- A **"Generate key" toggle**, set *before* cutting. When on, a single cut operation does: cut → build key → union peg onto half A → difference socket from half B → return both keyed halves.
- When off, behavior is **exactly** today's cut (back-compat: the toggle defaults off).

### Shape — a tapered rectangular frustum (truncated pyramid)
- **Base footprint** (the face that sits on the cut): a rectangle.
  - Area = **50% of the cut's cross-section area** (`cutArea` = membrane surface area).
  - Proportion: **length = 1.25 × width**.
  - So: `width = sqrt(0.5 * cutArea / 1.25)`, `length = 1.25 * width`.
- **Taper:** top face = **50% of base** (linear scale 0.5×) → narrows going in. **Wide at the cut face, narrow at the tip** — a self-centering plug.
- **Depth (height):** `1.5 × base width`, extruded perpendicular into the body.

### Position & orientation
- **Anchor:** center of the cut = **membrane centroid**.
- **Axis:** **membrane average normal** at the anchor (the same +normal direction the part-grouping already uses). Base face flush against the membrane (in its tangent plane); long axis along the normal so the peg points straight from one half into the other.
- **In-plane rotation:** long edge aligned to the membrane's principal tangent direction. Cosmetic only (peg & socket share it) — no correctness impact.

### Male / female + tolerance
- **Peg (male) = nominal frustum** → `partA.union(peg)`.
- **Socket (female) = nominal frustum grown 0.1 mm outward on every face** (4 sides + the far/tip end; the base end is open into the cut) → `partB.difference(socket)`.
- Result: **0.1 mm air gap all around** → slide fit.

### Which half is which
- The cut already classifies islands by **side of the membrane normal**: `+normal → part_a`, `−normal → part_b` (`split_into_two_sides` / `signed_side_distance` in `membrane.rs`). This is deterministic and consistent across every cut.
- **Convention:** **peg → part_a** (the +normal side), **socket → part_b**. Arbitrary but stable; if testing shows we want them swapped, it's a one-line flip. The two are co-located on the same anchor along the same axis, so they always mate.

---

## 3. Geometry details (the part that needs care)

### 3.1 Building the frustum mesh
A watertight 8-vertex / 12-triangle truncated box, same winding convention as `axis_aligned_slab` (CCW from outside → manifold accepts it). Built in a **local frame** then transformed:

- Local frame: `+Z` = key axis (into the body), `X`/`Y` = base rectangle directions (`X` = width, `Y` = length).
- Base ring at local `z = 0`: corners `(±w/2, ±l/2, 0)`.
- Top ring at local `z = height`: corners `(±0.5·w/2, ±0.5·l/2, height)` (50% scale).
- 8 corners → 12 triangles (4 side quads + base quad + top quad), outward-wound.

### 3.2 The key frame from the membrane
- `anchor` = mean of membrane vertices (its centroid).
- `axis` = area-weighted average of membrane triangle normals, normalized. (Consistent winding across the patch → a coherent +normal; this is the same normal convention `signed_side_distance` relies on.)
- `cutArea` = `membrane.area()` (already implemented).
- `tangent_u` = a unit vector ⟂ `axis` (principal tangent; pick the membrane edge direction of largest spread, or any stable ⟂ — cosmetic). `tangent_v = axis × tangent_u`.
- Transform local → world: `world = anchor + X·tangent_u + Y·tangent_v + Z·axis`.

### 3.3 Extrusion direction (the subtle bit)
The peg must occupy space **inside part_a** (the +normal half) and stick *out of part_a's cut face*; the socket must be carved *into part_b's cut face*. Both frusta are built along the **same axis from the same anchor**, base on the membrane. Because part_a is on the +normal side, extruding the peg toward **+axis** puts its body in part_a's half → union grows part_a. The socket frustum is the **same geometry** (same anchor, same +axis), grown by tolerance, differenced from part_b → carves the matching hole from the −normal half that part_b's cut face bounds.
- **Risk:** if the peg extrudes the wrong way it'll stick out into empty air / carve the wrong half. This is exactly what the cube test pins down (§5). If it's backwards, flip the axis sign — one line.

### 3.4 Tolerance growth
"Grow 0.1 mm on every face" = offset each face plane outward by 0.1 mm. For an axis-aligned-in-local-frame frustum this is: enlarge base half-extents by `tol`, enlarge top half-extents by `tol`, extend top in +Z by `tol`, and (since the base is the open mouth into the cut) **also pull the base down by `tol` in −Z** so the mouth fully clears the peg as it enters. Net: socket = peg dilated by `tol` in all 6 local directions. Implementation: build the frustum builder to take `tol` and inflate the two rings + both z-caps.

### 3.5 Clearance — the key must never come within 1 mm of a wall (BOTH halves)

**Hard rule:** there must always be **≥ 1 mm of solid material between the key and any mesh wall**, on both halves. Punch-through (peg exits the far side) and side-blowout (key too wide for a thin part) are both forbidden.

Since the **socket = peg + 0.1 mm tolerance** is the larger shape, we measure clearance against the **socket**. If the socket clears every wall by ≥1 mm, the peg inside it does too, and both halves keep ≥1 mm of wall.

**How we measure local thickness around the cut** (against the *refined/cut* model, in model-local mm):
- **Depth (punch-through):** ray-cast from the anchor along **+axis** (into part_a) to the first opposite wall → `depth_avail`. The socket tip must stop `≥ MARGIN` before it: `max_depth = depth_avail − MARGIN`.
- **Footprint (side blowout):** from the socket's outer corners (and along ±`tangent_u`/±`tangent_v`), ray-cast outward to the nearest wall → cap half-extents so each side keeps `≥ MARGIN`. Also cast on the **part_b** side (−axis) for the socket's mouth region, since the socket is carved from part_b.
- `MARGIN = 1.0 mm`.

**The fit ladder** (each rung previewed; the chosen rung's reason is reported so the user sees *why*):
1. **Tapered frustum (primary).** Try full size. If any clearance is violated, **shrink depth + footprint** to satisfy 1 mm everywhere. If the result is still a *useful* size (≥ a min footprint/depth floor), use it.
2. **Half-sphere fallback.** If the frustum can't fit even shrunk, try a **dome key**: a hemispherical peg + matching (grown) hemispherical socket on the same anchor/axis. Shrink its radius to keep 1 mm. A dome still *locates* the two halves (stops sliding) though it doesn't lock rotation. → **Alert:** "Key fell back to a half-sphere — the part is too thin for a full key."
3. **No key.** If even the dome can't keep 1 mm, place **no key**. → **Alert:** "No key placed — the part is too thin for any key."

**Outcome carries the chosen rung + reason** (`KeyKind::{Frustum, Dome, None}` + `detail`) so the report and the preview agree and the FE can show the alert.

### 3.6 Half-sphere (dome) key
- Peg = a UV/icosphere hemisphere, flat face on the membrane (base ring on the cut plane at the anchor), dome bulging along **+axis** into part_a. Watertight (hemisphere surface + flat cap disk).
- Socket = same hemisphere grown by `tol` (radius + `tol`), differenced from part_b.
- Radius derived from the cut: start at `sqrt(0.5·cutArea/π)` (a dome whose flat-disk area = 50% of the cut), then clamp to the 1 mm clearance like the frustum.
- Same builder shape as the frustum path (`tol` param, clearance clamp) so the ladder is uniform.

---

## 4. Touch list (files, all in-crate except the FE toggle)

| File | Change | Why |
|---|---|---|
| `rust/dragonfruit-organic-cut/src/key.rs` | **NEW** | All key geometry: frame, frustum + dome builders, clearance measurement + fit ladder, `apply_key`, `build_key_preview_soup`, tests |
| `rust/dragonfruit-organic-cut/src/lib.rs` | `#[cfg(feature="manifold")] pub mod key;` + re-exports | Expose the module |
| `rust/dragonfruit-organic-cut/src/membrane.rs` | `ContourSplit` gains the membrane (frame source); `contour_split` populates it. Key clearance ray-casts against the refined cut model (reuse the `Bvh` already in `dragonfruit-mesh-core`) | Cut needs the frame + local thickness to place/clamp the key |
| `rust/dragonfruit-organic-cut/src/organic_cut.rs` | `OrganicCutSpec.generate_key: bool` (`#[serde(default)]`); `organic_cut_contour` applies the key when on; report gains key kind + reason + counts | The toggle + wiring + alert text |
| `src-tauri/src/mesh_repair.rs` | preview command appends key soup + key kind/reason when toggle on; pass `generateKey` through the DTO | Truthful key preview + alert |
| `src/features/organicCut/OrganicCutPanel.tsx` | "Generate key" checkbox + alert area for fell-back/no-key reason | UI toggle + alert |
| `src/features/organicCut/useOrganicCutSession.ts` | `generateKey` in panel state + preview deps; surface key kind/reason | State + preview refresh + alert |
| `src/features/organicCut/meshOrganicCut.ts` | send `generateKey` in request JSON; receive key kind/reason | Transport |
| `src/features/organicCut/OrganicCutTool.tsx` | render the key preview soup (frustum OR dome, peg + socket) | Visual preview |

**No changes to `dragonfruit-mesh-repair`.** Confirmed: nothing there depends on the cut, and the key adds nothing it needs.

---

## 5. Test plan (test-first, on a cube — same discipline as the membrane)

In `key.rs` `#[cfg(test)]`:

1. **Frustum is watertight & manifold** — build nominal frustum, convert via `to_manifold`, expect Ok + non-empty (no open/non-manifold edges).
2. **Frustum dimensions** — base area ≈ `0.5·cutArea`, length ≈ `1.25·width`, top ≈ `0.5·base`, height ≈ `1.5·width`.
3. **Tolerance growth** — socket bbox = peg bbox + `2·tol` in width/length, +`tol` at the tip (and +`tol` at the mouth). Socket strictly contains peg.
4. **`apply_key` on a cube cut** — cut a cube with an equatorial loop → two halves; apply key. Assert: part_a tri count **grew** (union added the peg), part_b is still watertight (`to_manifold` Ok) and tri count changed (socket carved). Both halves still convert to manifold.
5. **Peg ⊂ socket cavity (fit)** — the peg manifold differenced from the socket manifold is empty/near-empty within tolerance (peg fits inside the grown cavity).
6. **Preview soup non-empty & finite** — `build_key_preview_soup` returns `Some`, length % 9 == 0, all finite.
7. **Clearance clamp shrinks the key** — on a deliberately THIN slab cut (part barely thicker than the nominal depth), the chosen frustum's depth/footprint are reduced so the socket clears all walls by ≥1 mm (assert socket bbox stays ≥1 mm inside the part along the axis).
8. **Fit ladder falls back** — on an even thinner slab, `apply_key` returns `KeyKind::Dome` with a reason; on a paper-thin slab it returns `KeyKind::None` with a reason (and parts are unchanged in that case).
9. **Dome key is watertight & fits** — hemisphere peg/socket convert to manifold; peg ⊂ grown dome socket.

Existing cut tests must still pass unchanged (toggle defaults off).

---

## 6. Milestones

- **M1 — Core frustum geometry (Rust):** `key.rs` frustum builder + frame + `apply_key` + tests 1-5. Surface the membrane from `contour_split`. Wire `generate_key` into `organic_cut_contour`. *Gate: all crate tests green with `--features manifold`.*
- **M1.5 — Clearance + fit ladder (Rust):** local-thickness ray-cast, frustum shrink-to-fit, dome fallback, no-key fallback, `KeyKind` + reason on the outcome. Tests 7-9. *Gate: thin-slab tests show clamp → dome → none with correct reasons.*
- **M2 — Preview (Rust):** `build_key_preview_soup` (frustum or dome) + test 6; thread `generateKey` + key kind/reason through the preview Tauri command. *Gate: preview returns truthful peg+socket soup matching the chosen rung.*
- **M3 — Frontend:** toggle checkbox + state + transport + render the key preview + alert for fell-back/no-key reason. *Gate: toggling shows the right key on the cut; thin parts show the dome/no-key alert; cutting with it on produces keyed halves.*
- **M4 — Validate & tune:** real model test in-app; confirm peg-on-correct-half, fit tolerance + 1 mm clearance feel right, taper direction correct, ladder triggers sensibly. Flip axis/half if needed. *Gate: user sign-off.*

---

## 7. Open questions / risks

- **Extrusion sign** (§3.3) — verified by test 4; flip is one line if backwards.
- **Peg vs socket half** — convention is peg→part_a; flip is one line.
- **Degenerate frame** — tiny/near-zero `cutArea`, or a membrane whose normals cancel (rare). Guard: if `cutArea` below an epsilon or axis length ~0, **skip the key** and return the un-keyed parts with a report note (never fail the whole cut over the key).
- **Key larger than the half (punch-through / side-blowout)** — **RESOLVED into the design** (§3.5): ≥1 mm clearance enforced against the socket on both halves, via local-thickness ray-casts, with a frustum→dome→none fit ladder. Each rung previewed + reason reported.
- **Ray-cast accuracy for thickness** — local thickness comes from BVH ray-casts along the axis + lateral directions. Few directions = cheap but could miss a concavity. Mitigation: sample the socket's corners + axial center; start conservative (round margin up). Revisit sampling density if a real model punches through.
- **Dome doesn't lock rotation** — a half-sphere locates but doesn't prevent twist. Acceptable: it's the *fallback* for parts too thin for a real key; better than nothing, and flagged to the user via the alert.
- **In-plane tangent stability** — purely cosmetic; any stable ⟂ to the axis is fine.

---

## 8. Decision log

- Key shape: **tapered rectangular frustum**, base on cut, narrow tip. (Not a plain cube — taper aids insertion/self-centering.)
- Key size is set by **two panel sliders, Key Width + Key Depth (mm)** — model units are mm, so the values are literal millimeters. Base length follows the fixed **1.25× width** ratio; top = **50%** of base (taper). Defaults 5 mm / 5 mm; slider range 1–20 mm. (Earlier area-based auto-sizing — 50% then 30% of cut area with a width cap — was unintuitive in practice because key size depended on the cut's area; replaced by direct sliders after in-app testing.) The 1 mm-wall fit ladder still shrinks below the chosen size on thin parts.
- Tolerance = **0.1 mm**, applied by **growing the socket** on all faces incl. the far end; peg stays nominal.
- Peg → **part_a** (+normal side), socket → **part_b**; consistent, swappable.
- Trigger = **pre-cut toggle**, one combined operation; defaults **off**.
- Location = **`dragonfruit-organic-cut` only**.
- Preview = **truthful** (shared builders), shows peg + socket for the chosen rung.
- Clearance = **≥1 mm of solid material between key and any wall, both halves**, measured against the socket (the larger shape).
- Fit ladder = **frustum (shrink-to-fit) → half-sphere dome → no key**; each rung previewed, the chosen rung's reason reported and shown as an alert.
