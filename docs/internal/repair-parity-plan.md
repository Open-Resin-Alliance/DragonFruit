# Repair parity plan

Working plan for bringing the repair pipeline in line with how the shipping slicers repair a mesh.
The evidence behind it is kept out of the repository on purpose — see **Where the evidence lives** at
the end — because this file is pushed and describes a clean-room reimplementation, and clean-room
means the notes we commit do not carry the other implementations' names, symbols or addresses.

## Why

Three shipping slicers were examined and all three agree on the shape of repair: it is **local and
combinatorial**, and none of them resamples, voxelises or remeshes. The verdict they report has five
classes, and self-intersections are not among them. Ours counted eight and included
self-intersections twice (crossings and contacts), which is why a printable model kept reading as
broken and then cost minutes of work.

The five classes are: orientation, bad edges, holes, non-manifold, shells. The repair acts on
self-intersections; the verdict does not count them.

## The target order

The reference's automatic repair is ten passes, run **once, in order**, with no iteration:

| # | pass | parameter | ours |
| --- | --- | --- | --- |
| 1 | stitch | 0.010 mm, orientation respected | `weld_vertices_oriented`/`stitch_vertices_oriented` |
| 2 | close trivial holes | — | `holes::holes_trivial` |
| 3 | remove double triangles | — | `cull_faces` |
| 4 | fix flipped triangles | — | `repair_orientation` |
| 5 | close trivial holes | — | we run this once |
| 6 | stitch | 0.010 mm, orientation ignored | ours sits beside #1, not here |
| 7 | fix flipped triangles | — | we run this once |
| 8 | close all holes | — | **ours closes early** |
| 9 | remove degenerated faces | tolerance from the bbox | ours is a fixed criterion |
| 10 | remove tiny shells | border volume 0.0001 mm³ | ours is absolute volume |

The core's own composite, which is the executable truth rather than the UI's grouping, runs the
stitch **six times at hardcoded absolute tolerances** (0.005, 0.010, 0.002, 0.004 mm with the
orientation ignored, then 0.080 mm with it respected after the holes are closed), and **loops over
nothing**. Nothing in it probes the mesh, nothing derives a tolerance from the edge lengths, and the
only mesh-derived number in the whole script is the degenerate-removal tolerance, off the bbox.

That is the design lesson, and it is the opposite of what this engine had been doing. Our tolerances
are derived from the mesh — the weld from its own shortest edge over the diagonal, the fill cap from
its median edge — and our pipeline is built as rounds that keep coming round. Derived parameters are
fragile: the loader refines coarse faces before anything reads the mesh (see
`docs/dev/mesh-wire-formats.md`), so the shortest edge a file presents depends on how the file was
loaded, and the weld tolerance moves with it. Absolute tolerances do not move.

### Measured out: the absolute stitch ladder

Copying the rung structure was tried and rejected on measurement, and the numbers are here so it is not
tried again. A quantising weld can miss a pair at one step that it catches at the next, so four
absolute rungs (0.002 to 0.010 mm) were run in place of the derived tolerance, and a single absolute
0.010 mm default was tried as well:

| default | engine time over the corpus | defect classes and verdicts changed |
| --- | --- | --- |
| derived shortest-edge fraction (kept) | baseline | — |
| absolute 0.010 mm | +10% to +25% | none |
| ladder, 0.002 to 0.010 mm | +30% to +67% | none |

Neither welded anything on any file but one, where the ladder welded 4 vertices. The reason is
upstream of the stitch: **every mesh reaches the repair already welded**, because the loader welds the
soup it reads, so what is left for the stitch is normally nothing, and a coarser rung that does find
something is refused by its own guard. A caller can still name an absolute tolerance
(`weld_tolerance_mm`), which is the part worth keeping: a stitch is a distance, and until now no caller
could ask for one. The derived default stays because it is what the corpus measures as free.

## The acceptance criterion, read off the reference's own output

The reference's repair of the reported file is in the user's Downloads beside the input, and analysing it
with this engine says exactly what a repaired mesh has to look like. It is the best acceptance test we
have, and it settles an argument about mechanism.

| | input | the reference's output |
| --- | --- | --- |
| inconsistent / non-manifold / loops / pinches | 113 / 1364 / 14 / 1390 | **0 / 0 / 0 / 0** |
| parts | 8 | **2** |
| volume | 97.727 | 97.928 |
| triangles | 961,504 | 1,076,192 |
| watertight / oriented | no / no | yes / yes |
| self-intersecting faces | 14,432 | 9,892 (still, and not a class) |

**All five classes zero. Parts down, volume preserved.** That last row is the mechanism: it does not
*separate* surfaces that share an edge, it **unions** them. Separating gives each surface its own rim, so
the part count and the volume both rise — which is why this engine's `split_non_manifold_edges` can never
match this output, whatever its acceptance test says, and why every attempt to accept it made the object
worse. The reference's own script has no non-manifold stage at all: it resolves those with a boolean
union of the outer surface, which is the one thing this engine does not have in its repair path.

### What does match: the rebuild, then the pipeline

`solid-remesh --tolerance 0` followed by `repair` reproduces that output on every class:

| | this engine, rebuild then repair |
| --- | --- |
| inconsistent / non-manifold / loops / pinches | **0 / 0 / 0 / 0** |
| parts | 12 |
| volume | 98.602 |
| triangles | 153,034 (from 153,044) |
| self-intersecting faces | 4,724, left as a note |
| the whole repair's changes | **721 + 10** |

The changed column is the point: 701 faces flipped by the orientation pass and 10 culled as duplicate
faces, and every other stage reports **0**. The local pipeline's comparable run changes 3,736 vertices and
fills 2,951 holes, which is what closing a surface looks like — and it is where the flat sheets inside the
cavity and the fanned gap came from. The rebuilt mesh is already closed, so nothing has to be.

The one residual is the self-intersection note, which is deliberate: it is not one of the five classes, it
does not stop a print, and the surface is only rewritten when the caller asks for it.

The tolerance matters more than anything else in that chain: the mode's default of `0.001` simplifies the
surface before resolving it and takes this file from 961,504 triangles to 158,190, throwing the detail
away. At `0.0` it keeps it.

### How the reference's repair is driven, from the kernel underneath it

Read from the geometry kernel's own source-path strings, tool registry and log lines. Behaviour only;
the names and addresses are in the evidence file.

**Their repair is a defect-driven loop, not a script.** A defect tracker lists the mesh's defects, picks
a class, repairs it, *recomputes the defects*, and repeats until none remain or an iteration cap is
reached, printing each round. Two details matter:

- **Self-intersections are one of the defect classes the loop acts on** (a class index of their own,
  separate from the five the verdict reports), and when that pass makes progress the loop **resets and
  starts again**. So a residue gets another turn by construction.
- It reports what it could not fix, and iterates the orientation and normals passes again after every
  other class, which is why their winding comes out at zero where ours comes out at 177.

**Their tool set contains operations this engine has no counterpart for**, and three of them are exactly a
rim that should not be capped flat:

- a tool that **joins two boundary loops to each other**. A break-through is closed by joining its two
  rims, not by spanning one of them — which is what our fill does and what a render sees.
- a tool that **welds cracks**, with machinery that pairs up points on the two sides and fails loudly when
  it cannot agree. That is the small gap.
- a tool that **splits a non-manifold surface** — as an operation the loop can invoke, not a stage of the
  ordered script. Our split is the same operation; theirs just is not sequenced into the ten passes.

**Their boolean refines both sides before joining.** It computes the intersecting pairs, *refines the
mesh so the two surfaces' boundary loops match in edge length*, then pairs up the loops and merges them,
and reports the loops' edge min/max/average/variance as its measure of whether the join is clean. That is
the step that makes a union produce a smooth stitch instead of slivers, and it is why the part count goes
down with the volume preserved.

### Done: the same loop, bounded

`repair_rounds` is now that loop. It evaluates the mesh, picks a class that is actually non-zero, runs the
one pass that class needs, re-evaluates, and repeats until no class can improve the defect *total* — and
a pass is kept only when the total strictly drops, so it cannot wander. Measured:

| | before the loop | after |
| --- | --- | --- |
| the reported 1.02M-triangle model: non-manifold / pinches | 1,363 / 1,389 | **17 / 32** |
| the worst corpus file: non-manifold / pinches / loops | 2,001 / 1,816 / 0 | **107 / 209 / 0** |

It costs about a third of a run on those files and nothing on files that are already clean, because a
mesh with no defects breaks out before the first attempt. Eleven of the twelve corpus files are unchanged.

### The file is not the mesh: every export here is a soup

Every export path this engine has produces a triangle soup — an STL carries no vertex indices, and the
staged `positions.bin` is nine floats per triangle — and the loader welds a soup at
`DEFAULT_MERGE_EPSILON` relative to the diagonal. So **a weld is applied to the repair's own output the
moment a caller saves it**, and a weld coarser than the repair's work undoes that work.

It was `1e-5`, and that is coarser than a dense mesh can take. Measured on the reported model: the
rebuild-then-repair output is `0/0/0/0` in memory and comes back from an STL with **177 winding edges**.
The weld joins vertices the repair had deliberately kept apart — a separated non-manifold junction, a
patch rim — and puts the resolved defects back into the file the user renders. At `1e-6` the same file
round-trips as `0/0/0/0`.

Two consequences worth keeping straight:

- **A render is of the file, not of the mesh.** Counters read in memory can be perfect while the file
  handed over is not, and that gap is what "the repair says success and it looks wrong" turns out to be
  made of. Any claim about output quality has to be made from the file.

**Closed, and it changed two results.** The pipeline now ends welded, and the weld's own damage earns one
more pass of the ordered stages. Measured on corbu, in memory and re-read from the file — they agree now,
which they did not before:

| corbu | in memory | as a file |
| --- | --- | --- |
| the ordered stages alone | 26 / 25 / 0 / 48 | 64 / 117 / 1 / 193 |
| + the weld at the end | 26 / 117 / 1 / 193 | 26 / 117 / 1 / 193 |
| + the weld's damage settled | **0 / 0 / 0 / 0** | **0 / 0 / 0 / 0** |

The middle row is the finding. Welding the *output* turns the repair's own state into the file's, and the
counts go from a plausibly-clean `26/25/0/48` to `117/193`. Those were always the file's numbers: measured
straight off the previous build's output, corbu is **64/117/1/193** with 81 faces carrying a repeated
vertex, and Harbinger is **103 winding edges and 244 repeated-vertex faces** — against `0/0/0/0` reported
in memory. "The repair says success and it looks wrong" is exactly this and nothing else.

Three things that are *not* the fix, each measured:

- **Displacing every coincident copy.** The pipeline's own separations are four loader cells apart, so they
  survive the weld; the *pinch* copies sit at exactly the same position, and a pinch is how a support
  attaches to the model it supports. Moving one separates a shell from the shell it touches — measured on
  the supported file in the corpus, components 3,148 to 5,442 and classes `0/0/0/0` to `44/132/220`. The
  copies stay where they are, and the weld merges them back, which is what a re-read does with them anyway.
- **Welding the union's output.** Most of a supported model's coincident vertices are the boolean's: it
  returns the positions of both operands, so a vertex the two sides share comes back twice — 28,009 of
  137,987, measured. Welding there merges duplicate *faces* into existence early enough for the double-face
  stage to cull them, which cost that file 11,148 faces and took its parts from 43 to 239.
- **Moving the weld rather than the passes.** The defect loop does not repair a weld: run against the
  welded output, `repair_rounds` changed nothing. The *ordered stages* do, and their counts say which —
  the non-manifold split at 1,288 and the settle at 1,745.

So a pass whose weld merged or culled anything earns one more pass of the ordered stages, and a mesh the
weld leaves alone costs exactly what it did before. The result, in memory and re-read from the file (they
agree on every row), with what the previous build's *file* measured for comparison:

| file | triangles | winding / non-manifold / loops / pinches | the previous build, as a file |
| --- | --- | --- | --- |
| corbu | 1,020,820 | **0 / 0 / 0 / 0** | 64 / 117 / 1 / 193 |
| poussin | 170,790 | **0 / 0 / 0 / 0** | 0 / 0 / 0 / 0 |
| `COOKIE_b4` | 185,312 | **0 / 0 / 0 / 0** | 0 / 0 / 0 / 0, 50 repeated-vertex faces |
| 3DBenchy | 405,420 | **0 / 0 / 0 / 0** | 0 / 0 / 0 / 0, 11 |
| Harbinger | 3,069,776 | **0 / 0 / 0 / 0** | **103 / 0 / 0 / 0**, 244 |

Two files were never fixed and read as fixed — corbu and Harbinger — and both are fixed now, in the file as
well as in the report. `fully_repaired` is true on all five.

The invariant is asserted rather than only measured: `prune_and_classify` ends by checking that no two
distinct vertices share a loader cell, in debug builds, so a pass added later that leaves a copy in place
fails a fixture rather than shipping. Two notes for whoever reads a number off this engine next: a class
count taken in memory is now also the count in the file, but **only** through the pipeline that ends welded
— the `analyze` subcommand on a file with no repair still reports the file; and the second pass is not free,
it is the ordered stages again, so it costs a run whose weld had work to do.

### What is still different, measured

Re-measured after the round-trip work, on corbu, from both the mesh and the file (they now agree):

| | winding / non-manifold / loops / pinches | parts | volume | self-intersecting | degenerate |
| --- | --- | --- | --- | --- | --- |
| input | 113 / 1364 / 14 / 1390 | 8 | 97.727 | 14,432 | 653 |
| the reference's output | **0 / 0 / 0 / 0** | **2** | 97.928 | 9,892 | 3 |
| this engine, local pipeline | **0 / 0 / 0 / 0** | 5 | — | 18,561 | 0 |
| this engine, rebuild then repair | **0 / 0 / 0 / 0** | 5 | 98.736 | 18,582 | 0 |

Every class is zero on both paths now, and the file matches the report. What is left:

- **Parts, 5 against their 2.** Still the largest difference, and still the one the kernel notes explain:
  their boolean removes the triangles contained in the other operand and then joins the boundary-loop
  pairs, with both sides refined first so the loops match in edge length before anything is joined.
  Nothing here merges a contained shell into its container. The behaviour is in *How the reference's
  repair is driven* below; the names and addresses are in the evidence file.
- **Self-intersecting faces, 18,561 and 18,582 against their 9,892.** Ours are *up* from the input's
  14,432 where theirs are down to 9,892 — this is not one of the five classes, and it does not stop a
  print, but it is what a mesh of loose slivers looks like, so it is the number to watch when a render
  looks rough. The reference's repair *acts* on crossings; this engine leaves them and says so.
- **Volume.** 98.736 against 97.928 on the rebuild path — 1.0% high, where the input reads 97.727. The
  local pipeline's volume is not comparable and is not quoted: its part count and its surface differ
  enough that the number no longer means the same thing.

**Counters, not renders.** Every number here is a count. The standing rule for this work applies: a change
that improves a counter and cannot be seen in a render is not known to be an improvement.

### A fan is not the difference any more

An earlier render showed the cavity closed by a fan of triangles converging on a point. That was a stale
output, produced before the boundary walk was fixed. Measured on the current build, the local pipeline
fans **once** on this file, over an area of 0.0004 mm², and the ring patch handles the rest.

## Why it matters — what was actually wrong



On `corbu-chibi-corrboo45.stl` our repair reported `fully_repaired: true` with 0 boundary edges, 0
loops and 0 non-manifold, and looked wrong: open walls and flat faces inside the cavity. Both were
true, and the cause was found and fixed: `stitch_vertices` welded **and then culled faces**, and on
that model the weld found nothing — all 653 of the stage's changes were the cull. Removing those
faces opens the surface, and the hole pass then fills the openings flat, because a loop's
minimum-area triangulation *is* a facet. The cull is gone from the stitch; duplicate removal happens
where the target does it, at the double-faces stage.

## The instrument problem — read this before believing any result

Our report gave **identical numbers for runs that looked different**: the default, `2.5e-4` and
`5e-4` weld tolerances all reported 0/0/0 and `fully_repaired: true`.

So a green report is **not** evidence a repair looks right. Every claim about output quality needs an
eye or at least a render. Do not call a repair fixed on the strength of counters.

Two things make the counters read better than they are, and both are now fixed:

- A stage's `changed` column counted a pass that had been refused, because the cull is judged in two
  halves and only one of them was being reported.
- The loader silently refines the mesh, so `analyze` on a coarse part reports a count that belongs to
  neither the file nor the renderer. The CLI takes `--raw` for the file as written, and says on
  stderr when it refined.

## Where the time goes

Measured before the guard rework, 84 s in 13 stages on a 1.02M-triangle model:

| ms | stage | changed |
| --- | --- | --- |
| 14,103 | `orient_holes_stitch` | **0** |
| 13,641 | `orient_holes_all_stitch` | 39 |
| 12,806 | `settle` | 1347 |
| 10,668 | `split_non_manifold_edges` | 7742 |
| 7,850 | `orient_components` | 7 |
| 6,455 | `stitch` | **0** |
| 5,036 | `double_faces` | **0** |
| 4,857 | `double_faces_after_split` | **0** |
| 2,755 | `union_overlapping_parts` | **0** |

**~40% of the time was stages that changed nothing.** Two causes, both addressed:

- Every pass was wrapped in a full five-class evaluation of the mesh *before* it ran, whether or not
  it then did anything. `judge` now weighs a pass only when the pass reports a change.
- The second double-face pass ran even when the crossings were not split. It now runs only when a
  pass since the first cull could have made a duplicate.

Corpus effect: 5% to 32% faster per file with every five-class outcome identical.

Then the largest one. `repair_orientation` is reached **four** times, because orientation, stitch,
holes and double faces each disturb what the one before settled — but an orientation pass handed a mesh
nothing has touched since the last one does nothing, and every pass here is deterministic (verified:
three files repair to bit-identical output across repeated runs). `OrientationGate` runs the pass only
when a stage has changed something, and it is fed from the same `stage!` that records what each stage
changed, so a new stage cannot forget to declare itself and a refused pass declares zero because it
reverted.

| file | before | after | ratio |
| --- | --- | --- | --- |
| `213277_…_HF_Warlock_unified_mm.3mf` | 11,219 ms | 3,877 ms | 2.9x |
| `Dino_V3.stl` | 8,717 ms | 3,103 ms | 2.8x |
| `GT2_Pulley_40T_6.35_R_CS.stl` | 6,820 ms | 3,096 ms | 2.2x |
| `poussin.stl` | 4,533 ms | 2,241 ms | 2.0x |
| `Nut cap M5.stl` | 19,026 ms | 11,637 ms | 1.6x |
| `STL_DV_DarthVader_Supported.stl` | 24,510 ms | 15,077 ms | 1.6x |

Every file's five classes and its verdict are unchanged. Against the session's starting point the
Warlock file is 15.0s to 3.9s.

Deleting a round because it happened to be a no-op on one input is still not on the table:
`orient_holes_stitch` changed nothing on corbu, but `holes_trivial` had altered the mesh since those
passes last ran, so it was not provably a repeat. The tests that remain are the provable ones.

## Open questions

- **A plate of parts, and the pass that would have merged it.** `Untitled2.stl` is not one model: it is
  a print plate of **25 parts** (the slicer's own count; 29 closed shells by the engine's, the extra
  ones being shells inside shells — two of them are the inner and outer surface of the same object,
  +2,358,243 and −4,836,120 of signed volume at the same centre). Every shell is closed: 0 boundary
  edges and 0 non-manifold edges across all 29, so the file's problem is not shape at all.

  Two things follow from it being a plate. The first is that the *verdict* on it was read wrong: "the
  surface is inside-out, signed volume −26,062" is a sum over 25 parts of which **11 of the 25 larger
  ones are individually inverted**, and a total is not a property of any part. The second is that the
  union would have merged it: `union_overlapping_parts` picked operands by *bounding box* overlap, and
  a plate shares one box across most of its pairs (266 of 406), so every part went to the boolean at
  once — and the stage would have been *kept*, because what it is accepted on is a falling part count.
  Operands are decided on surface contact now (`crossing_component_pairs`: a triangle of one crossing a
  triangle of the other), and the stage note says how many solids it left separate.

  What the repair does *not* fix on this file is the same 1,389 edges it did not fix before: they are
  same-direction edges inside 13 of the parts, 39 to 361 each, on closed shells with no boundary and no
  non-manifold edges. `orient_components` flips 0 faces and the rounds report `defects 1389 -> 1389`,
  so it is the class the plan already recorded for this file — a component whose cycles demand an odd
  flip, which is what a doubled or self-crossing surface leaves behind. Those parts carry **45,214
  self-intersecting triangles** between them, which is the same work as the crossings pass above and
  the reason this file is the one of 128 that does not come out `fully_repaired`.

- **The hole patch.** The reference does not fan a loop flat: it solves a patch in a mesh of its own,
  with the rim edges marked and a solver behind it. What that solver does differently is *not yet
  identified* — the interval-DP criterion is the same recurrence as ours (minimise area, penalise
  slivers), the triangulation adds no geometry, and the join does not move the rim. Three candidates
  remain, and they are recorded in the evidence file.
- **The degenerate criterion, settled, and its order measured out.** The reference's *Remove
  Degenerated Faces* is two halves and neither is an area test: a weld of vertices by **exact** float
  position, then deletion of every live face whose vertex references repeat — `v[0] == v[1]` — with its
  neighbour and the twin edge. The tolerance quoted in its UI belongs to a different step; there is no
  distance anywhere in this pass. Our counterword is `cull_repeated_vertex_faces`, which is the same
  deletion, and the exact weld it follows has already happened here, in the loader.

  The reference removes degenerates at step 9 of its script, after Close All Holes, where ours runs
  before the fills. That was tried: the repeated-vertex class was moved into a stage of its own after
  the fills and the corpus re-run. **It changes no outcome and costs up to twice the engine time** —
  a 292,470-triangle model 4.9s to 10.0s, an 815,474-triangle one 15.1s to 28.8s — because a face that
  names the same vertex twice contributes both `(a, b)` and `(b, a)`, so removing it first is what lets
  the winding settle; leaving them in place keeps `repair_orientation` flipping the same faces on every
  call (2,160 faces, three times, on the woven model). On the reported file the two orders produce a
  **byte-identical mesh**, same sha256 and same size. Reverted.
- **A guard that trades.** `worse_than` compares the five classes for *rises*. The cull once passed it
  while opening the surface, because removing duplicate faces removes non-manifold edges at the same
  time as it creates boundary ones. A per-class comparison cannot see a swap. Worth deciding whether
  any guard should refuse a trade rather than only a rise.
- **The dead orientation option.** `ResolvedOptions::repair_orientation` is set from the caller and
  never read, so `RepairOptions::repair_orientation == false` still runs every orientation pass. A
  documented option that silently does nothing is worse than no option.
- **`Gusano_de_Dune_70%.stl`** is the worst file in the corpus. It enters with 1,896 winding edges,
  3,515 non-manifold edges, 315 loops and 3,164 pinched vertices across 302 parts, and the local
  pipeline leaves almost all of it: 1,818 / 3,514 / 91 / 3,162. Keeping only the largest component
  still leaves 3,510 non-manifold edges, so the defect is *inside* one large shell rather than between
  the parts, which rules out a part-level answer.

  **Closed since, on this branch, but only when asked for.** The winding residue is the class a
  *cut* reaches: the faces joined across two-face edges demand a parity, and an odd cycle is satisfied
  by no assignment, so no amount of flipping clears them. The repair-2.0 branch had that cut
  (`3ffb3deb` and the campaign around it) and the rebuild of this branch replaced it with a
  re-tessellation that refuses a spread defect — measured, 0 faces re-tessellated twice on this file.
  With the cut restored behind `--cut-unsatisfiable-edges` and judged (kept only when the defect total
  drops), Gusano comes out **winding 1,374 -> 0, non-manifold edges 196 -> 97, pinched vertices
  338 -> 188**, where the default leaves 1,374 / 196 / 338. It is not a clean file either way — it
  arrives with 3,513 non-manifold edges inside 302 shells — but the class the report named is settled.

  **And it is settled automatically since.** `repair_auto` runs the local pipeline first and, when it
  cannot settle the mesh, the surface-to-solid rebuild behind it, judged: measured on this file the
  rebuild comes out **`fully_repaired`, 0/0/0/0, 603,772 triangles from 596,293**, with the report
  saying the surface moved (37,293 -> 45,094 of signed volume, +20.9%). The app's repair runs that
  route, and the rebuild's own simplify default is 0.0002 rather than 0.001 because the coarser
  setting came back with 13.3% of its edges over 30° against the input's 7.4% — see *The rebuild's own
  look* in the passes doc. The local pipeline stays the answer where it works, which is every other file measured.

  The local pipeline is not the right instrument for it, and the rebuild mode now is. The surface to
  solid path separates the shared edges and rebuilds it into a solid: watertight, 0 non-manifold
  edges, 0 pinches, 0 loops, 307,258 triangles from 596,293. It costs a 20% volume rise, 532 shells
  and 114 winding edges the pass will not keep, because the surface moved. That is a last-resort
  rebuild, not a repair, and it is a mode the caller names.

  Still open for the *local* pipeline: a mesh with thousands of non-manifold edges inside one shell is
  exactly what the reference's own script has no stage for either, so matching it means reporting the
  defect rather than removing it.

## The three open areas, after tonight

**The subdivision route was tried and does not reach the case.** A half-edge walk of the planar graph the
chords make, with the outgoing edges sorted by angle at each vertex and each face ear-clipped, is written and
the walk is verified — it finds the faces of a test graph and traverses the cut edge both ways. It cannot
triangulate an interior chord all the same, and the reason is geometric, not a bug: a chord with both
endpoints inside the face does not divide it. The face stays simply connected and the chord is a **slit**, so
the walk's own face for it is a cycle that visits one vertex twice, which is not a simple polygon to ear-clip.
Forcing the chord in needs the textbook constrained-edge insertion — walk from one endpoint to the other and
flip the crossed edges — not a face decomposition. That is the piece to build.

**The refinement's gap, counted by reason.** Of the 10,558 faces that carry an intersection and come back
unrefined, measured with the reason each one gives:

| reason | faces |
|---|---|
| the CDT returned an error, and no chord of the face ends on its ring | **10,258** |
| the ring path failed its coverage check | 1,017 |
| the CDT returned an error and the ring fallback also failed | 172 |
| the CDT returned nothing | 36 |
| two points coincident in 2d | 2 |

So the pass is not failing in many ways. It fails in one: a chord whose endpoints are both inside the face —
the shape the other triangle makes when it punches through the middle rather than clipping an edge. The
partner face on the other side of that intersection *is* refined, because its own chord does end on its own
ring, which is why the pair stays crossed: one side is split and the other is not. `cdt` returns an error for
that input rather than panicking, and 79% of the ring-fallback path's work is unreachable because a chord with
an interior endpoint is not a boundary chord.

**What that leaves to build.** A constrained triangulation of the face, not a fallback: points (three corners,
points on the edges, interior points) plus a set of non-crossing chords, needing a triangulation that covers
the face exactly, makes every chord an edge, and has no zero-area triangle. The shape is a planar subdivision
of a triangle — the chords partition it into polygons — so the work is to walk that subdivision's faces and
ear-clip each, taking the largest ear so a flat one is never chosen while a real one exists. Two checks are
already in place and make it verifiable: the per-face coverage check (the output's area against the face's) and
the arrangement fixture whose guarantee is that corefinement fully resolves crossings.

**The crossings — the refusal is the last thing wrong with the refinement, and the zipper was the thing
before it.** With the shared-end triangles dropped (the fix in `f8432064`) and the refinement forced past the
judgement, the pipeline finishes it — the same refinement that earlier ended at 924 components and 17,722
winding edges now ends at:

| | input | default repair | refinement forced through |
|---|---|---|---|
| winding edges | 53 | 0 | **0** |
| non-manifold edges | 1,429 | 0 | **9** |
| non-manifold vertices | 1,462 | 0 | **15** |
| boundary loops | 16 | 0 | **0** |
| connected components | 8 | 5 | **2** |
| self-intersection triangles | 16,899 | 18,060 | 20,037 |

Two components is the reference's number, against the default repair's five. The zip's shared-end triangles
were the whole difference: they are zero-area and name one vertex twice, so every edge they touched had no
normal to compare winding against, and the winding pass detonated on them — 17,722 against 0.

**It is still not a win, and the reason is the crossings.** Forced through, the refinement ends with *more*
intersecting triangles than it started with (20,037 against the input's 16,899 and the default repair's
18,060), and the classes are 9 and 15 rather than zero, so the default repair is still the better mesh. The
refinement resolves crossing *pairs* — 16,901 to 15,322 through the pass itself — and the rest of the
pipeline then adds more intersecting triangles in the same tangle. That is the gap to close, and it is now the
only one: everything else the refinement does, the pipeline finishes.

The ear-clip triangulation written for the same purpose is not shipped either: with the zip's flat triangles
already gone it changes nothing (nme 10,630 against 10,699) so there is no measured benefit to justify it.

**The crossings — the T-junction was tried, measured, and is not the fix.** The theory was that a refined face
splits its own edges while the face across that edge keeps them whole, leaving one long half-edge against two
short ones. The propagation was built (every new vertex that lands on a face's edge is given to the face on the
other side, with its edge id so the split is registered exactly) and it does do what it says: the components
right after the refinement stay at **15–17** instead of the hundreds, and the boundary loops drop from 704 to
133 when the ring is closed with the zipper rather than fanned.

It does not survive the pipeline. Forced through, the refinement *with* the propagation ends at **1,610
components and 52,860 winding edges**; the same refinement *without* it ends at 924 components and 17,722
winding edges. So the propagation trades a local improvement for a worse final mesh, because the ring fan it
needs emits a zero-area triangle for every point on the two edges meeting the apex — half the output on a face
split once per edge — and a zero-area triangle has no normal, so the winding pass detonates on it. Both runs
are worse than the input and neither is shipped.

What the experiment establishes is the shape of the real requirement: **the T-junction repair has to
triangulate the ring without degenerates.** The zipper does (it cut the loops 704 → 133 on the same faces)
and its rungs then need the guard the hole-filling copy already has — a rung that is already an edge of the
mesh folds the strip and leaves an edge with three faces.

**The refinement cannot be let through as it stands.** Forced past the judgement with no propagation at all it
takes the connected components **8 → 924** and the winding edges 53 → 17,722, and the crossings *up* to 23,242
from 16,899. The refusal is correct; the judgement is not the thing standing in the way.

**Two fixes came out of it and stay.** The zipper in the crossings path no longer emits the shared end of the
two sides paired with itself — a face naming one vertex twice counts its zero-length edge twice, which reads
as a non-manifold edge (worth 11,000 of them in one measurement). And the hole-filling zipper read
`side_b[q + 1]` without checking `q + 1 < nb`: a reachable index-out-of-bounds panic on the default path,
found because the forced run dug out a loop whose sides differ in length.

**The crossings — the dropped region is now repaired, and the pass still does not land.** What the CDT drops
shows up in its output as a boundary loop, exactly like a hole in a mesh, so the same zipper that closes a
break-through closes it: the loop's two sides are welded to each other, which covers the missing region and
introduces no vertex the face did not already have. That is in, and the arrangement tests — including the
fixture whose guarantee is *"corefinement should fully resolve crossings"* — all pass with it, because the
repair keeps the chords the CDT did get right.

It does not make the pass land. The refinement still leaves non-manifold edges, pinched vertices and winding
edges that the five-class judgement counts and the crossings it resolves are not among them, so the total
still rises and the pass is still refused. What is left after the region is covered is the **T-junction**: a
refined face splits its own edges and its neighbour does not, and 10,558 faces are not refined at all.

**The crossings — the triangulation itself is broken, and that is the whole chain.** Measured per face, the
CDT's output covers **0.008%** of the area of a four-point face — one triangle where three are needed — and
2.9%, 7.0%, 19.3%, 74.4%, 96.7% on others. It is not losing "a region": for these inputs it returns a
triangulation that does not represent the face at all. Everything downstream follows from that — the 2,335
boundary loops, the 2,718 non-manifold edges, the 3,952 pinched vertices, the 2,725 winding edges — and the
pass cannot land, because the five classes it is judged on are exactly what the lost surface turns into.

The refinement *does* do its job: crossings 16,901 → 15,322 on the reported model. That is invisible to the
judgement, which counts only the five classes, and the reference's own verdict does not count crossings either
— it *repairs* them in a loop that is judged on defects.

So the fix is to triangulate the face ourselves. The structure is known and small: a triangle carrying points
on its three edges, interior points, and non-crossing chords between them — a planar subdivision of a triangle,
which wants ear clipping over each region of the subdivision. The ring path already handles the case where
every chord lies on the ring, exactly, and it takes those faces; what is needed is the same treatment for the
interior case. The bar: 100% coverage, the fixture's crossing guarantee intact, and a defect total that beats
the 27,147 the holes-closed refinement reaches today.

**The crossings — the pass's own damage is now repaired before it is judged.** The refinement's holes are
closed as part of the pass, and *then* it is judged, which is the pattern that made the weld land. Measured on
corbu, on the refined mesh:

| | judged immediately | holes closed first |
| --- | --- | --- |
| boundary loops opened | 2,335 | **0** |
| non-manifold edges | 2,676 | 2,718 |
| pinched vertices | 3,878 | 3,952 |
| winding edges | 2,724 | 2,725 |
| defect total | 39,251 | **27,147** |

The pass is still refused — the total has to *drop* below the input's 5,083 — and what is left is not the
holes: it is the refinement's own sub-triangles and the T-junctions they leave with their neighbours, which is
the CDT's lost region again. Closing the holes is a prerequisite rather than the fix, and it is kept for that:
without it the pass is judged on a mesh it has visibly broken.

**The crossings — the cause, found.** The refinement's triangles do not tile the faces they replace. Measured
on corbu, refining 13,048 faces opened **2,335 boundary loops**: the surface is *lost* where the CDT's
triangulation misses a region, and the non-manifold edges, pinched vertices and winding that follow are all
downstream of that hole. The plan already knew the CDT does this — the ring path exists because of it, with
"25% of one face on a two-triangle fixture, and 8,123 of 14,751 faces on 3DBenchy" — but the ring path only
applies when every chord lies on the ring, so a face with an interior point still goes to the CDT.

A coverage check was added to the CDT path — sum the sub-triangles' areas, and if they do not cover the parent
the refinement is refused and the parent kept — and it is a large improvement on the mesh: refined faces
13,048 → 10,718, holes 2,335 → **1,838**, winding 2,724 → **1,108**, defect total 39,251 → **24,325**. It is
**not kept**: it breaks a test that encodes a real guarantee, `corefine_shares_new_vertices_across_adjacent_faces`
— *"corefinement should fully resolve crossings"* — because on that fixture the refinement loses a region
*and* the ring path does not apply, so refusing the refinement leaves the crossing in place. Trading a
documented guarantee for mesh integrity is not a trade this branch makes.

So the fix is not to refuse the CDT's output but to make it cover: either a triangulation that handles a face
with interior points exactly (the ring path generalised), or the missing region added afterwards. That is the
next step here, and the numbers above are what it has to beat.

**The crossings.** The refinement still explodes the winding and is still refused: 29 same-direction edges
become 2,688, of which 2,051 are between a refined face and an untouched neighbour and none carries a new
vertex. Every emitter in the refinement forces its sub-triangles to the face's own orientation — the 2D basis
is built from that face's normal, so the positive 2D orientation *is* the parent's — which means the reversal
is not in the emission and the next step is to compare, for one of those 2,051 edges, the *parent* face's
direction against the neighbour's, both taken from the pre-refinement triangles.

The T-junction healing this plan recorded earlier is **reverted**: it improves two classes (non-manifold
edges 1,428 → 608, pinched vertices 1,460 → 1,197) and drives the third through the roof (winding 2,688 →
3,205), for a net loss — the defect total 22,444 → 36,734. Its fans are the reason, the same fans the zipper
was written to remove.

**The crossings — the chords were not in the face.** Measured per face inside `refine_face_with_segments`, on
the 407k-triangle refinement of a real file: **8,066 of the 15,307 chords the faces carried lay entirely
outside the face they were recorded on**, and of the rest most had at least one endpoint outside it. A chord
is found by overlapping the two triangles' intervals along the planes' intersection line, projected onto one
axis; that overlap is a necessary condition and not a sufficient one — with a vertex nearly on the other plane
the interval is computed from the wrong edges. It matters because the CDT triangulates the **convex hull** of
the points it is given, so an endpoint outside the face drags surface out with it: the refinement's own
coverage check, the one added and then removed above, read a median of **1.16** times the face's own area and
a maximum of **744**.

The chord is clipped to the face before it is used (`clip_segment_to_face`): the part outside is dropped, and
an endpoint outside lands exactly on the face's boundary, which is where an intersection that leaves a face
through an edge belongs. Per face, because the same chord is a different segment on each side of the pair.

Three more things came out of the same measurement:

- **A corner is a ring point.** Only points carrying an edge id counted as being on the ring, so a chord that
  ends *at* a corner was treated as an interior chord and handed to the CDT as a constraint duplicating a
  boundary edge — which the CDT answers with nothing at all. On the measured file that is most of the chords a
  face carries.
- **A chord between two ring points that are next to each other is a ring edge** — what a chord becomes when
  the other triangle's plane runs along the face's own edge. It has nothing to split, and a constraint that
  duplicates a boundary edge is exactly what makes the CDT return an empty triangulation. It is dropped, and
  the points it ended on are kept: the ring is still built with them, which is what the face across that edge
  needs in order to be split at the same place.
- **The ring path takes a face with no interior chord left — chords dropped, or none at all.** It used to
  require a non-empty chord list, so a face carrying only ring points went to the CDT with nothing to
  triangulate. But those points are the whole reason to refine such a face: the neighbour across its edge was
  split there, and matching it is what this face owes.

**The crossings — the zipper was welding a face to itself, and the fan put a flat triangle under every point.**
Two more defects came out of reading the ring path against what it is for.

The zipper that closes what the CDT drops took *every* loop of edges with a face on one side only, and every
face has one: its own rim — the edges it shares with neighbours whose triangles are not in its own output. So
it welded the rim to itself and emitted a **second copy of every triangle**; the coverage check read 2.000
where the triangulation itself read 1.000. It now walks the boundary as *directed* edges, which is what tells
the rim (counter-clockwise, the direction every emitter forces) from a dropped region (clockwise), and closes
only the latter.

The ring was triangulated by fanning each piece from its first vertex. A fan is only a triangulation when no
two of the piece's points are collinear *with the apex*, and a chord that ends mid-edge — the common case,
since an intersection line enters and leaves a face through its edges — leaves two points sharing an edge with
a corner. The fan emitted a zero-area triangle for each of them, and a zero-area triangle has no normal: the
winding pass compares face normals, and measured in the pipeline a fan's flat triangles took the refinement
from 2 connected components to 924. The pieces are ear-clipped now, cutting the largest *empty* ear: empty so
that the slivers the on-edge tolerance creates are left for last, where they collapse into a remainder with no
area instead of being covered twice — measured on one face, the corner ear plus the slivers behind it came to
1.6e-8 more than the polygon's own area. The coverage check compares against the *ring polygon* now rather
than the three corners, for the same reason: the ring bulges past the corner triangle by about the tolerance
that put its points on it — 1.9e-6 relative on one face, which was enough to refuse the face under the old
comparison while the triangulation matched the ring polygon to the digit.

**The crossings — what that measures now.** On a 226k-triangle file entering with 583 crossing triangles and
258 inconsistent edges and nothing else:

| | before this work | now |
|---|---|---|
| crossing triangles | 583 → **804** | 583 → **535** |
| surface area | +5.70e-3 | **+6.23e-5** |
| non-manifold edges | 1,422 | **32** |
| pinched vertices | 1,678 | **56** |
| inconsistent edges | 1,368 | **303** |
| bad edges | 2,156 | **1,648** |
| boundary loops | 47 | 307 |
| defect total | 5,214 | **2,336** |

The refinement no longer invents surface and no longer adds crossings, and it took the non-manifold edges from
1,422 to 32 — but it now leaves 307 boundary loops where it left 47. Those are T-junctions: a point the clip
snapped *onto* a face's edge is a vertex of that face and not of the face on the other side of the edge, so the
edge's two sides no longer match. It is the propagation this plan names below, and the reason it was reverted
before — the ring fan's zero-area triangles — is fixed.

**The crossings — through the pipeline on the reported model.** `--resolve-self-intersections` on corbu,
against the committed build:

| | before | now |
|---|---|---|
| pairs | 20,279 | 17,987 |
| faces refined | 13,048 | 8,851 |
| faces skipped | 10,558 | 7,389 |
| triangles added | 41,093 | 38,545 |
| defect total, once the pass' own holes are closed | 27,147 | **10,372** |

That refined mesh reads, after its holes are closed: inconsistent 2,188 (was 2,725), non-manifold edges 1,850
(was 2,718), pinched vertices 2,259 (was 3,952). It is **still refused** — all four classes it is judged on are
above the mesh it replaced (29 / 2,157 / 1,428 / 1,460) — and corbu's verdict is unchanged, `fully_repaired`
with 0/0/0/0, five components and 18,060 crossings, because a refused pass reverts.

**The crossings — what is left, and it is two things.** Both are named by the measurements above.

1. **The propagation.** A new vertex that lands on a face's edge has to be given to the face on the other side
   of that edge, so both sides still match. The 307 loops are what its absence costs. The earlier attempt
   improved the classes it was aimed at and then lost on the winding, because it needed the ring fan and the
   fan emitted a flat triangle under every point (2 components → 1,610). The ring is ear-clipped now, so that
   reason is gone and the piece is worth redoing.
2. **A constrained triangulation of a face that has an interior chord.** Of the 269 faces on the measured file
   that go to the CDT, **62 still come back short** — 7.4e-5 of the mesh's area, with the worst covering
   nothing at all — because the CDT does not represent a face whose chord has an endpoint in its interior. The
   textbook answer is the constrained insertion the subdivision experiment arrived at: walk from one endpoint
   to the other and flip the edges it crosses. It is bounded, and the per-face coverage check is already there
   to verify it.

**The winding cycle.** `Untitled2` is the one file of 128 the repair does not fix, and it is a no-op on it:
1,389 inconsistent winding edges before and after. Measured, it is **inside-out** — signed volume -26,062 —
and it also carries 1,389 *local* disagreements. The retessellation written for exactly this refuses, and the
probe says why: deleting the conflicted faces opens 6,629 boundary edges, the fill closes 1,703 of them, the
parts go 76 → 133, and the volume flips sign. Two candidates were tried and neither changed the outcome, so neither is in: a pinch
split before the refill (a pinched rim is not a simple cycle, so the loop walk never covers its edges) and a
volume test on the *magnitude* when the sign flips (a sign flip is an orientation correction, not a change of
shape). Both are principled and both left the refusal exactly where it was — the parts, and the 4,926
boundary edges the fill does not reach — and the uncovered edges are not pinches: 4,926 of the 6,629 survive
the split, so whatever leaves them is a different shape of rim than `split_pinched_vertices` handles.

**The union.** Unchanged: corbu is 5 components against the reference's 2 and 98.733 of volume against its
97.928. Two overlapping operands still come back as four shells, so `manifold_csg` fragments geometry that
touches and is coplanar, and the reference's own answer to that is the refine-both-sides-then-join it carries
in its tool set.

## The corpus, after the zipper

The Downloads folder holds 171 STL files. 128 of them are 20 MB or under and were run end to end; the 43
larger ones were skipped for time (the largest is 2 GB).

**128 ran, 0 failed, 127 came out `fully_repaired`.** The one that did not is Untitled2: 1,389 inconsistent
winding edges before the repair and **1,389 after** — the repair is a no-op on it, and that is the winding
*cycle* the loop cannot settle, the same class as `Gusano_de_Dune_70%` in the open questions.

**No fan was created on any of them.** The worst vertex's valence, which is what a fan is:

| file | input | ours |
| --- | --- | --- |
| corbu | 135 | **135** (the reference's own output is 136) |
| STL_ST_BaseDesign_Supported | 275 | 275 |
| C3D-RERF-Scene | 206 | 206 |
| A4Tv2_4015_Ducts [alternate] | 180 | 180 |
| Untitled2 | 84 | 88 |

Every high valence in the corpus is the input's, carried through, not made. Two files carry a valence of
167 from their inputs and one (an ASCII STL the quick loader could not read) reports 355 — unmeasured against
its input, and the one case still to check.

Time is 2 s for a small part and about 60 s for a 20 MB one.

## The stray triangles: closed, against the reference's own numbers

The fan is gone. Measured the way it was found — the worst vertex's valence — against the reference's own
output of the same file:

| | triangles | worst vertex | vertices over valence 30 |
| --- | --- | --- | --- |
| input | 961,504 | 135 | 343 |
| the reference | 1,076,192 | 136 | 735 |
| this engine, before | 1,020,820 | **937** | 346 |
| this engine, now | 1,020,850 | **135** | 345 |

Two changes, both in the closure a hole gets, and both measured:

- **The plan is asked for a minimum-*weight* triangulation when the minimum-area one comes out fan-shaped.**
  Area alone is not the objective a band needs: on a *non-planar* rim the fan's triangles lie across the
  opening and their total area is *less* than the strip's, so minimising area prefers the fan — a 937-edge
  rim came out of this plan with 937 faces at one vertex. Adding the lengths of the diagonals each step
  introduces is the classic minimum-weight objective, and it is what makes a band come out as a strip. It is
  asked for only when the area-only plan is fan-shaped (one vertex in more than a quarter of the triangles),
  because asking always changes plans that were already fine, and that is a regression on a model whose rims
  are not bands.
- **A rim with no plan is zipped, not fanned.** Past `MIN_AREA_DP_MAX_LOOP` edges no plan is attempted, and
  the closure fell through to a fan from a new centre vertex — verbatim, *"a fan from a new centre vertex
  reuses none"*. It is now a **zipper**: the loop is split at its narrowest crossing and its two sides are
  welded to each other, one triangle per step, advancing the side that is *behind* rather than the one whose
  next vertex is nearer. The nearer-vertex rule has no bound — where the two sides run far apart one advances
  alone and the strip becomes the fan again (measured: one vertex in 286 of 958 triangles) — while progress
  keeps every vertex of the loop in two or three triangles. This is the operation the reference's hole filler
  logs when it closes a break-through (`welding holes %d and %d`), and the split has to leave both sides a
  real length or the zip degenerates the same way.

  The zip is refused unless it is a band (its rungs short against the loop's diameter), unless none of its
  rungs is already an edge of the mesh, and unless its own triangles form a strip (no edge used three times).
  Each refusal was added because a supported model came out of a zip with a non-manifold edge and two pinched
  vertices without it.

Corpus: all five files `fully_repaired`, 0/0/0/0 in memory and re-read from the file, no regression — corbu
1,020,850 triangles, poussin and 3DBenchy unchanged, `COOKIE_b4` unchanged at 43 parts, Harbinger 3,071,482
with 3,135 parts against 3,136.

What is left on corbu is the union, not the closure: **5 components against the reference's 2** (outer surface
and cavity), and 98.733 of volume against its 97.928.

## The stray triangles are a fan, and it is one pass

Traced by vertex valence, which is what a fan *is*: a normal mesh vertex has six faces, a fan's centre has
as many as the loop has edges. The input's worst vertex carries **135** faces. The repair's carries **899**,
at (317.4, −0.4, 7.8) — inside the region a render shows as stray triangles.

Per stage, and then per step inside it:

```
[valence] orient_components 135   ...   [valence] settle 135 -> 899
[settle]  stitch 135 | noise_shells 135 | holes_all 135 -> 899
```

So it is one step: **the second pass's residual hole fill**, `holes_all` with no cap, closing a large
break-through loop. Everything before it is clean, and the input has no such vertex at all.

The closure of a large loop is a fan, and the code says so. `flat_cap` skips its minimum-area plan above 384
edges, and its last resort is verbatim *"a fan from a new centre vertex reuses none"* — one point with the
whole opening fanned off it. Below 384 edges the plan runs, and a minimum-area triangulation of a long thin
band is itself a fan, which is why the size of the fan moved when the threshold was moved.

Two repairs were tried and neither is sufficient, both reverted:

- **Ear clipping as the fallback.** It walks the rim instead of collapsing it to a point, and it does help —
  the worst vertex went 899 to 806 — but a wide break-through's rim does not project to a simple polygon, so
  the clip returns nothing for exactly the loops that matter and the fan runs anyway. Routing every loop
  through it (threshold 384 to 0) moved the fan rather than removing it: 15 vertices over valence 100 where
  there were 7.
- **A plane for a folded rim.** Newell's normal of a folded rim cancels to zero and the clip bailed before
  it started; deriving the plane from the loop's largest non-degenerate triple changed no output at all.

**What is left is the operator itself.** A break-through's rim is a wide band, and no cap over it is right —
not a fan, not a minimum-area plan, not an ear clip. It needs a **strip built along the rim**, which is the
join the reference's tool set carries and this engine does not have. That is the piece to build, and the
valence probe above is its acceptance test: the repaired mesh's worst vertex should be no worse than the
input's 135.

## How the reference closes a break-through: it joins the rims

This is the missing operator, and it was in the tool list all along.

The reference's repair is a defect loop with a tool set, and the set contains **a tool that joins two
boundary loops to each other**, and one that welds cracks — its hole filler logs *welding holes %d and %d*
when it does. A break-through — a sheet meeting a wall, which is exactly what corbu's cavity has — is closed
by **joining the two rims to each other**, not by spanning one of them with a patch.

This engine has only the spanning patch: `fill_loop_with_patch` for loops of seven edges or more, and a flat
fan below that. So every break-through becomes a sheet, however tangent the patch is to the surface it came
from — and on corbu that is 2,951 fills in the first pass plus 990 in the settle. Measured, the fill is not
the problem: the patches *are* tangent (the curved-wall smoke test proves that). The problem is that they
span a rim that should have been welded to the surface on the other side of the break.

So the sheets go when a rim that runs alongside another surface is joined to it, and the tool to build is
that join. Two candidates for finding the partner: the rim's own edges' nearest surface within the loader's
weld cell, and the boundary loop whose vertices pair with this one — the reference logs the loops' edge
min/max/avg/variance when it matches them, which is what its own pairing uses as the measure.

## The flat sheets: what they are, and what removing them costs

The sheets on corbu's right are the **fills**: the first pass separates 3,736 vertices at non-manifold
junctions and then caps the rims that exposes — 2,951 hole faces — and the settle adds 990 more. 1,994
faces of flat patch, inside a cavity.

The reference has none because it never separates: it **unions** the overlapping parts (8 components in,
**2** out — the outer surface and the cavity) and removes the contained faces, so there are no rims to cap.
That is the whole of the difference, and it means the sheets cannot be tuned away: they go when the union
works, and only then.

**The union, and why ours does not.** Two things were wrong with it, both now fixed, neither sufficient:

- It handed `manifold_csg` components whose vertices were merely *close* where the surfaces touch, and a
  boolean needs them *exactly* shared. It answers that with fragmentation: measured on corbu, bad edges
  2,157 → **5,567** and refused. Each component is now welded at the loader's own cell before the boolean,
  component by component so nothing else is re-indexed. Bad edges now read 2,157 → 2,157.
- It handed it *every* closed component, disjoint ones included. A boolean is for overlapping operands; the
  disjoint ones came back as more shells than went in. Only components whose bounding boxes overlap are
  operands now — on corbu that is 2 solids of 7.

**What is left, measured, and it is not a tune.** Two *overlapping* solids still come back as four shells:
the union reports 8 parts → 11 with 2 solids unioned, so it is still refused on the part count. The boolean
fragments geometry that touches and is coplanar — which is precisely why the reference refines *both* sides
before it joins and then pairs the boundary loops and merges them, rather than relying on a plain boolean.
That join is the feature to build; nothing short of it removes the caps.

No regression from either change: the corpus is unchanged, class for class, file for file — corbu 0/0/0/0,
poussin 0/0/0/0, `COOKIE_b4` 0/0/0/0 with 43 parts and 7,648 crossings, 3DBenchy 0/0/0/0, Harbinger 0/0/0/0
with 3,136 parts.

## Measured since: three things that are not the flat sheets

Each was run on corbu, against the committed build.

**The absolute stitch ladder is destructive here, and the plan's earlier rejection stands.** Copied as
plain position welds — the core's own ladder, 0.005/0.010/0.002/0.004 then 0.080 — it welds **nothing**
(the stitch guard refuses it, which is what the earlier measurement found). Run unguarded: the 0.080 rung
welds **453,332** vertices, the double-face cull then takes 901,864 faces, and corbu collapses from
1,020,820 triangles to **114,860** with 167 non-manifold edges. The safe-looking 0.010 rung unguarded welds
**132,766** vertices and leaves 79 non-manifold edges and 134 pinched vertices. The model is 13 mm with a
million triangles, so its own edges are about 0.01 mm and a position weld at that reach eats the detail.
The reference's step carries `Ignore Orientation: No` — it will not join vertices whose surfaces disagree —
and that constraint is what makes 0.010 safe there. Our `weld_vertices` has no such constraint.

**The hole-closing order is neutral on this file.** Closing holes only at the end, as the script does,
gives byte-identical counters (0/0/0/0, 1,020,820 triangles, 18,561 crossings) — the same rims are filled,
just later (34+178+37+1,745 becomes 212+1,745). So the flat sheets are not a question of *when* the fill
runs; they are the fills themselves, 1,994 faces of them, plus the crossings below.

**The crossings pass is refused, and the reason is one class.** `--resolve-self-intersections` finds 20,279
pairs, refines 13,048 faces and adds 30,710 vertices, then judges the result worse and reverts it. Measured
on the refined mesh *with* the junctions it creates repaired:

| | before | refined |
| --- | --- | --- |
| non-manifold edges | 1,428 | **502** |
| pinched vertices | 1,460 | **987** |
| winding edges | 29 | **2,688** |
| defect total | 5,083 | 22,444 |

So the refinement is a large win on two classes and a catastrophe on the third, which is the only reason it
is refused.

**Where the winding goes, traced to the edge.** Classifying all 2,688 same-direction edges of the refined
mesh by what produced their two faces:

| edge | count |
| --- | --- |
| between a refined face and an untouched neighbour | **2,051** |
| between two refined faces | 639 |
| between two untouched faces | 33 (the pass's input has 29) |
| inside one refined face | 1 |

and **none of them has a new vertex on it** — every one joins two original vertices. The per-face sub-triangle
orientation is not the fault: the 2D basis is right-handed (`v = n × u`, so `u × v = n`) and every
sub-triangle is forced to the positive 2D orientation before it is emitted, which is why a normal test finds
only 9 faces with a reversed sub-triangle.

**It is a T-junction.** The refinement splits a face's edges at the intersection segments' endpoints and
registers those endpoints as shared vertices — but only for faces it refines. 10,558 faces are *skipped*, and
a skipped face keeps its whole edge while its refined neighbour has the split one. That is one side of the
join refined and the other not, which is precisely what the reference's own refinement step exists to
prevent — it refines the mesh so *both* sides' boundary loops match in edge length before anything is joined
(the behaviour and the log lines are in the evidence file) — and it is why their joins come out clean instead
of slivered.

**The fix, therefore, is propagation, not a tolerance:** after corefining, every new vertex inserted on a
shared edge has to be inserted into the neighbouring triangle as well, splitting it. That is a bounded piece
of work with a clear acceptance test — the refined mesh must read 0 same-direction edges outside the ones it
started with — and it is the same shape as the reference's own refine-both-sides step.

## Next steps

0. **Closed: the round trip, and corbu and Harbinger with it.** The pipeline ends welded, the weld's damage
   earns one more pass of the ordered stages, and the invariant is asserted in debug builds. All five files
   measure `0/0/0/0` in memory and re-read from the file. See *The file is not the mesh* above.
1. **Contained shells, and the part count.** 12 parts against the reference's 2, 6 on the local pipeline,
   and it is the largest difference left. Their boolean removes what is contained, then joins the
   boundary-loop pairs, and refines both sides first so the loops match in edge length. Nothing here
   merges a shell into the shell that contains it. See *Why their boolean joins cleanly* in the evidence
   file for the two operators that do it.
2. **The crossings pass, which is two pieces and both are measured.** The propagation (a new vertex on a
   face's edge goes to the face on the other side of it, closing the 307 loops the clip opens) and a
   constrained triangulation of a face with an interior chord (62 of 269 CDT faces come back short, 7.4e-5
   of a file's area). Until both are in, the pass stays refused: it is judged on four classes and all four
   are still above the mesh it replaces, on corbu at 2,188 / 1,850 / 2,259 / 3,823 against 29 / 2,157 /
   1,428 / 1,460. See *The crossings — what is left, and it is two things* above.
3. The absolute stitch ladder: replace the derived weld tolerance with the reference's absolute one, so
   loading a file one way or another cannot move it.
4. The ordered script: one instance of each pass, in the target order, instead of rounds.
5. The degenerate criterion, topological rather than by area — and do not move it after the fills; that
   is measured out.
6. `Gusano_de_Dune_70%.stl`, and a last-resort rebuild for a mesh no local pass can settle.

## Where the evidence lives

`.omp/notes/repair-parity-plan.raw.md` — the full record: which binary, which units, which addresses,
what each function does, and which readings were retracted. `.omp/` is excluded from version control
in this checkout, deliberately. Nothing in it is a substitute for measurement: every claim about a
repair's quality is unverified until a render, and the raw file says which of its own conclusions were
wrong when they were first written.

## Standing rules for this work

- Verify with the real binary on real files. `cargo test` alone has caught none of this work's actual
  bugs.
- A change that improves the counters but cannot be seen in a render is not known to be an
  improvement. Say so.
- No product names, symbols or addresses in anything committed.
