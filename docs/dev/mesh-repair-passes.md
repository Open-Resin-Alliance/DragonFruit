# Mesh repair passes

The repair engine is a fixed-order set of passes over an `IndexedMesh`. Each one mutates
the mesh in place and appends a `RepairStepReport`, and the report is the only thing
callers see. `repair()` is the entry point; `RepairOptions` is the input.

The crate is `dragonfruit-mesh-repair`, consumed by the shell at
`src-tauri/src/mesh_repair.rs` and by the CLI at `rust/dragonfruit-mesh-repair/src/bin/cli.rs`.
Reach for this page when you are changing the order, adding a pass, or changing what
counts as repaired.

## The order

```
orient_components
stitch
holes_trivial
double_faces
orient_holes_stitch
orient_holes_all_stitch
double_faces_after_split
remove_inner_faces
noise_shells
settle
repair_rounds
prune_and_classify
```

Four are conditional and so are not in that list. `split_self_intersections` runs between
`double_faces_after_split` and `remove_inner_faces` when the caller sets
`resolve_self_intersections`. `union_overlapping_parts` runs after `remove_inner_faces`
when the mesh still has bad edges, and `split_non_manifold_edges` follows it; both need
the `manifold` feature. `filter_components` runs after `noise_shells` when the caller
sets `keep_largest_n_components`.

The union running before the split is load-bearing. `tests/smoke.rs` pins it by asserting
the union's position is before the split's, because the split is what makes each surface
constructible and a union after it has nothing left to merge. Ordered the other way, the
same file keeps about 200 more parts.

A stage can also be skipped rather than made conditional on an option. The verdict the
pipeline takes before the first pass is what decides it: `orientation_settled` says the
first `orient_components` has nothing to do when no edge disagrees and every component's own
signed volume is decisively positive, which is the whole of what that pass can act on. The
gate re-arms the moment a stage changes anything, so the later calls to the same pass still
run, and one of them carries the cut. Measured on `poussin.stl`, 170,790 triangles that
arrive watertight and consistent: 762 ms to flip nothing.

The verdicts themselves are remembered too. `evaluate` and `analyze` are pure functions of a
mesh, and the pipeline asks them the same question about the same mesh repeatedly: every
guarded pass weighs the mesh it just made against the one it started from, the next pass's
"before" is that same mesh, and a repair that changes nothing leaves the report's post verdict
describing the mesh the pre verdict already described. Both remember their last few verdicts
against a key over the whole mesh (positions bit for bit, indices, both buffer lengths, hashed
twice in one pass), so a hit is only ever a verdict for exactly this mesh. What is cached is
the verdict, a handful of integers, never the topology it was built from.

Instrumenting the structure builders is why this exists: on `poussin.stl` a run was 21
halfedge builds, 934 ms of 2008, and 13 of those builds came from `evaluate` alone. The
consequence worth knowing is in the report: `timings_ms` is the cost of the computation that
produced the verdict, so a cached verdict carries the earlier call's numbers, because that is
what it cost and it was not paid again.

Reading the same verdict is what skips three more pieces of work. `remove_inner_faces` returns
before its ray casts when the mesh is one component, because one component cannot be inside
another. The settle's two last-resort passes, the re-tessellation and the cut, are skipped when
no edge disagrees, which is the question they would each walk the winding parity to ask; the cut
below them already returns on the same test.

`tests/smoke.rs` pins this list in `the_pipeline_runs_the_stage_order_it_says_it_does`.
If a change to the order is deliberate, that test is where you say so.

### A repair may not invent geometry

Every pass is judged by the five classes, and the five classes have no term for geometry that was not
there before. That gap is measurable and it was a print defect. On `Gusano_de_Dune_70%.stl`, whose
bottom is flat to 0.0000 mm, the fill the non-manifold class runs put one vertex **0.198 mm below that
bottom**: four layers at 0.05 mm, and because it was the lowest thing in the mesh the slicer printed
it alone while the model's own base waited 0.198 mm up. The same fill through the rebuild route left
one 0.096 mm down.

So the rounds now hold every candidate to the surface it arrived with. `project_added_onto_surface`
takes the vertices a pass *added* and pulls any that is more than a hundredth of a median edge from the
surface back onto its nearest point, and `Envelope` is the cheap backstop for the one case that cannot
see, a surface that is itself on the box the mesh came in with. Only added vertices are checked: the
splits and the weld move what is already there, and their offsets are deliberate, whereas a fill is
what adds geometry and it appends what it adds.

Measured on that file, a repair that used to leave the first layer as 6 faces over 7.6 mm² now leaves
it as the model's own base, 9,607 faces over 4,261 mm², with the five classes unchanged (98 non-manifold
edges and 189 pinched vertices either way) and the run the same length. Across the 130-file corpus no
repair leaves a mesh lower than it arrived and no verdict changes.

## `repair_rounds`, and why the list above is not the whole story

`repair_rounds` runs last and is a loop, not a pass. It evaluates the mesh, picks a defect class that is
actually non-zero, runs the one pass that class needs, re-evaluates, and repeats — up to
`MAX_REPAIR_ATTEMPTS` passes, stopping as soon as no class can improve the defect total. A pass is kept
only when the *whole* total strictly drops, so a round can trade one class for another only when the sum
improves, and the loop cannot wander.

This exists because one ordered pass per stage leaves a residue: a pass that half-solves something gets
no second turn. The classes disturb each other, so a round can expose one the round before it created.
The order it tries them in is `DEFECT_CLASSES` — non-manifold edges, winding, boundary, pinched
vertices, noise shells — and the reason for that order is in its doc comment.

Measured: on the worst file in the corpus it takes non-manifold edges from 3,515 to 107 and pinched
vertices from 3,164 to 209, where the ordered passes alone left 2,001 and 1,816; and on the reported
1.02M-triangle model it takes them from 1,364 and 1,390 to 17 and 32.

It costs about a third of a run on the files that need it, and nothing on the files that do not, because
a mesh with no defects left breaks out of the loop before its first attempt.

### The repetition is the design

`orient`, `stitch`, `holes` and `double_faces` each appear more than once, and that is
not duplication to be tidied. Each one disturbs what the one before it settled: welding
vertices makes degenerate faces, filling a hole adds faces whose winding has to be
decided, flipping a face changes which of its edges is a boundary. Running the set once
leaves work that the next pass creates. `settle` is the same four passes again, in the
order the stages after `remove_inner_faces` leave the mesh needing them.

The rule that follows from this: **a pass is not scored on a by-product that another
pass owns.** If a pass's side effect is somebody else's job, order it that way and do not
judge it on that side effect. A guard that rejected a pass for disturbing winding, when
orientation runs immediately afterwards, rejects its own successor's work.

## The verdict

`fully_repaired` is five classes and no more, computed by `evaluate::evaluate`:

| class | what it counts |
| --- | --- |
| orientation | edges whose two faces disagree about direction |
| bad edges | edges not shared by exactly two faces |
| holes | boundary loops |
| non-manifold | edges carrying more than two faces, and the vertices they pass through |
| shells | shells small enough to be noise |

**Self-intersections are not one of them.** The repair acts on them when asked, and
`MeshHealthReport::self_intersection_triangles` reports the count, but a mesh that
crosses itself and is otherwise sound is a mesh that prints. Treating crossings as a
defect is how a good file gets reported as broken, and how a caller ends up being told
its model needs minutes of work it does not need.

Each class that survives is also written into `residual_issues`, one line per class, so
the report says what is left and not just that something is.

## The options

| option | what it does |
| --- | --- |
| `weld_tolerance_mm` | vertex weld tolerance, absolute and in model units. Unset runs the default ladder |
| `fill_holes_max_edges` | the longest border loop `holes_all` will close |
| `keep_largest_n_components` | keep the top N components by absolute volume, or all |
| `repair_orientation` | whether the orientation passes run |
| `resolve_self_intersections` | whether the crossings are split and the buried faces removed |
| `assume_support_geometry` | force the model/support classification for support STLs |

### A non-manifold edge is one whose faces cannot be paired

More than two faces on an edge does not make it non-manifold, and counting it that way is
how a model the reference engine calls clean, and which is clean, came out of a repair
reported as broken.

Four faces with two traversing the edge each way are two coincident manifold edges: two
surfaces meeting along a shared edge, each of them closed. So `Topology::non_manifold_edges`
pairs every forward traversal with a backward one and looks at what is left. Two forward
and one backward is a fan with a face it cannot pair, which is non-manifold. A single face
is a boundary, which is a hole and not this class at all. Two faces traversing the same way
are a winding disagreement, which `inconsistent_edges` reports and the orientation pass can
fix, so they are not counted here either.

Measured on `213277_438404_1039898_HF_Warlock_unified_mm.3mf`: eleven edges carry four
faces, and all eleven are two forward and two backward. Under the old count the file read
as having 11 non-manifold edges and 4 pinched vertices, and the reference engine's panel
reports 0 bad edges, 0 holes and 0 bad orientation for the same file and the same vertex
count. The file is clean.

`bad_edges` is the union of this class with the hole edges, which is how the reference
counts it, so the two agree by construction once the pairing is right.

## Three passes where the five classes are not enough

### The cull is two face classes, and they behave nothing alike

`cull_faces` removes two kinds of face and now judges them separately, because judging them
together is how `3DBenchy.stl` came out of a repair with all 355 of its winding edges and
every one of its 2,017 degenerate faces still in place.

A face that names the same vertex twice, `(a, b, a)`, has no area and no volume, and its
edges are phantom: it contributes both `(a, b)` and `(b, a)`, so an edge carrying one real
face looks like it carries two. That manufactured pairing is exactly what the winding count
reports, which is why benchy read 355 inconsistent edges and watertight at once. Removing
its 2,006 of these clears all 355 with no other class moving.

A face whose three positions are collinear but whose indices are all different is a
different animal: benchy's 11 of them are load-bearing, and removing them opens 29 edges
and 9 holes.

The guard used to wrap the pair, so the second class's refusal threw away the first class's
removal. Now `cull_repeated_vertex_faces` is guarded on its own and runs first, and
`cull_duplicate_and_zero_area_faces` follows it.

### Winding runs cheapest first and stops when flipping cannot help

Three passes in increasing cost, each running only when the one before it has given up:

1. `greedy_flip_winding_edges` — single-face flips, best net first, over one topology
   build. A full rebuild per flip hung benchy: 355 flips at a full build each.
2. `solve_winding_regions` — the disagreements no single flip can reach. A frustrated cycle
   has no improving first move, but flipping a *set* of faces changes only the edges on the
   set's boundary, so a bounded region around the residual is enumerated exactly and the
   best assignment kept.
3. `walk_winding_edges` — the disagreements neither of those can enter. It takes the
   steepest toggle available even when that toggle makes the count *worse*, never revisits
   a face, remembers the best count it saw, and undoes everything past that point.

All three answer to the same guard: the volume must not move more than one percent. The
`unify_winding` that runs before them is per patch, and a patch decision cannot settle a
disagreement *within* a patch. That is the gap these three close.

**What they cannot close** is a genuinely frustrated seam. The V3 Cones keep exactly 4
edges, and those form a closed loop 58357 → 162679 → 160762 → 160761 → 58357 around a
sliver cluster whose faces measure 1e-5 to 2.6e-4 square units. Every face on it scores
-1, the tree assignment leaves the same 4, and 400 toggles of the walk never beat it. They
are independent frustrated cycles: no assignment of face orientations resolves them, so
they need the surface rebuild the reference engine gets from its self-intersection split,
not a winding pass. That is reported, and not forced.

Scale does not change it. On `INDIGO AWARD '26_Hollow_Fixed.stl`, a hollowed model of 1.08M
triangles, the same wall arrives with 10,417 edges: `unify_winding_once` flips 10,417 faces
and the count does not move at all, no face on any disagreement scores positive so the
greedy has nothing to take, and 400 toggles of the walk never beat it. `Untitled2.stl` is
the same at 1,389, and the V3 Cones at 4. Four files now sit behind one missing capability —
a surface rebuild — rather than four separate bugs.

### The residual is always an even subgraph, and the cut solver is what moves it

The disagreement set that survives every cheaper pass has a shape, and it is always the same one:
it is an **even subgraph** of the mesh — every vertex has even degree in it. Measured, the count of
odd-degree vertices is 0 on the V3 Cones (4 edges), `Untitled2.stl` (1,389) and the hollowed INDIGO
model (10,417). That is what a residual is, not a coincidence.

So the bad edges are the boundary of *some* set of faces, and on an orientable surface that set is
always reachable, by Poincaré duality: an even subgraph of the mesh is a cut of the face graph.
`solve_winding_cut` finds it. Removing the bad edges splits the face graph into regions, and any
union of regions has a boundary made only of bad edges, so turning regions over fixes exactly the
bad edges it cuts. Which regions to turn is a max-cut on the region graph, solved exactly when
that graph is small and by a local search when it is not.

This is the one move the greedy, the region enumeration, the walk and the annealed search all
miss. The set to turn over is a union of whole regions, not a patch — on Untitled2 it is 429,571
faces — so toggling faces one at a time cannot find it and a region cap cannot contain it.

Measured on `Untitled2.stl`: 1,389 disagreements, 409 of them lying between regions and 980 inside
one. The cut solver fixes all 409 and leaves the 980, which no assignment of face orientations can
fix: a bad edge with both faces in the same region is in the interior of every region.

In the pipeline it is refused, and the reason is the volume guard. Turning those regions over moves
the signed volume 233%. That is the *input's* volume being wrong rather than the fix being one — a
mesh with mis-oriented regions has no meaningful signed volume to compare against, which is the
same shape of problem as the duplicate faces `stitch` removes moving sr-71 by 1.33% while
correcting it.

### The V3 Cones cannot be fixed by flipping at all

Its disagreements sit **inside a single region** — zero lie between regions — so no union of
regions has them as its boundary. Three independent searches agree the count cannot be reduced:
exact enumeration over 20 faces, an annealed search over 20,000, and the cut solver. An even
subgraph that is not a cut of the dual is the signature of a non-orientable surface, and on a
closed mesh the usual cause is self-intersection: two sheets passing through each other glue into
a twisted neighbourhood.

Flipping cannot help, so the *surface* has to change. `retessellate_unsatisfiable` deletes the
faces carrying those edges and lets the fill close what that opens: the edge is gone, so the
winding drops, and what replaces it is the fill's own surface rather than a copy of anything. On
the cones that is 7 edges, 11 faces deleted and 13 filled — winding 4 to 0, parts 15 to 15, volume
unchanged in the sixth decimal.

It is judged on the outcome, not on a threshold count, because the same move is wrong elsewhere: on
the harbinger file those edges number 181, deleting them adds nine parts, and the winding only
reaches 48. A localised defect can be re-tessellated; one spread across the surface cannot, because
every local fix for it adds geometry. The rule that decides it is **no pass may add a part**, and a
pass that means to repair winding has to be judged on whether it did.

### An earlier attempt at this is worth knowing about

Duplicating the vertices around those edges also makes the surface orientable, and it was in the
tree for a while. It is wrong, and the reason is subtle enough to be worth recording: the copies
sit exactly on the originals, so the volume does not move and no class gets worse — the mesh reads
as fully repaired while carrying coincident facets. What it actually costs shows in the
self-intersection count, 17,879 to 20,906 on corbu, and in the viewport as doubled surfaces. Adding
a part is the defect; nothing in the five classes sees it.

### The orientation pass is per component, so it has to stay O(faces)

`repair_orientation` walks the components and decides each one's winding, which means anything
inside that walk is multiplied by the component count. A presupported scene makes that fatal
rather than slow: `supported_apaato_DF_Scene.3mf` is 3.8M triangles in **2,938,564
components**, nearly one per triangle. Three loops inside the walk were O(faces × components)
or worse — a full scan of the component array per component, `mesh.bbox()` per component, and
`mesh.signed_volume()` per flipped component — and the nesting ray-cast test ran for every
component although it can only change the answer for one that would otherwise be flipped. That
file had not reached the *second* stage after an hour.

What it costs now: faces bucketed by component once, the bbox and the mesh volume hoisted, the
nesting test asked only where it can matter, and a fragment under four faces skipped, since it
cannot enclose anything and its signed volume describes where it sits rather than which way it
faces. The same file finishes in 544 s, with bad edges 9,364,576 to 0 and boundary loops
2,938,564 to 0.

The rule this leaves: inside the component walk, no pass over the whole mesh, and no scan of
the component array per component.

### A union is judged on what it costs as well as what it merges

`union_overlapping_parts` accepts on a falling part count, classes that did not get worse,
and no volume growth. That was not enough. On the harbinger file it merged 5,414 solids and
took the parts 3,083 down to 646, and paid for that with 47% more triangles and 10,664 new
degenerate faces on a mesh that started with 683 of them.

So it also carries a size budget: triangles within 10% of the count it started with, and
degenerate faces within 0.1% of the triangle count or 64, whichever is larger. COOKIE_b4's
union — the one that makes that file read as repaired — adds 4.3% and 126, and stays.

**Its operands are decided on contact, not on bounding boxes.** The rule used to be "the boxes
overlap", chosen because a shared box may still be a disjoint pair, and so it erred in the safe
direction — it did not. A print plate of separate parts shares one bounding box across most of its
pairs (measured on `Untitled2.stl`, 25 parts: 266 of 406 pairs), so that rule handed the boolean
every part at once. `Manifold::batch_union` answers a set of separate solids with the union of them,
so the pass would have merged the user's parts into one object *and been kept for it*, because what
it is accepted on is a falling part count. What decides an operand now is `crossing_component_pairs`:
a triangle of one solid crossing a triangle of the other. Solids that meet only at a vertex (a pinch,
which `split_pinched_vertices` owns) and solids that merely nest (a union with a cavity fills the
cavity) are not operands. The stage note says how many solids it left separate and why.

`split_non_manifold_edges` has the same shape of problem and a worse one. It judges itself
on the volume not moving, and it was comparing the volume of a mesh that *arrived* with
boundary edges to one whose rims it had just filled. Those are different measurements —
signing a boundary loop the other way is the same mesh and a different number. On the corbu
model, sealing alone moves the volume 97.7 to 117.4 before the split does anything, so the
+26% it was refused for was mostly the measurement changing.

Against a sealed baseline its own cost is +5.28%: non-manifold edges 1364 to 0, loops 30 to
4, parts 8 to 13 against an allowance of 16. That is still above the one percent guard, so
it is still refused, and the stage note now says which of the four tests refused it.

`split_self_intersections` is the only pass that rebuilds the surface rather than editing it,
and it carried no acceptance test at all. On the V3 Cones it took non-manifold edges 0 to
5,557, the boundary 0 to 344 and the volume up 132%; on corbu, bad edges 822 to 16,704 and
the volume up 852%. Both were applied and kept. It is guarded on the same test as the rest
now, so asking for it on a mesh it cannot handle gives the mesh back unchanged, with the
refusal in the stage report.

### The boolean engine cannot be the wrap for damaged input

The established recipe for a hard case is a self-union boolean, and
ours would have to run on `manifold-csg`. It cannot. `Manifold::from_mesh_f32` requires input
that is already edge-manifold *and* consistently oriented, so it refuses exactly the meshes a
wrap is for: measured, it refuses the V3 Cones (0 non-manifold edges, watertight, 4
inconsistent winding edges), corbu (1,364 non-manifold) and `Untitled2.stl` (1,389 winding),
and accepts only meshes the earlier passes have already cleaned. A wrap therefore has to come
from our own `corefine_self_intersections`, which is guarded off because it produces a worse mesh, or from
a different boolean engine. That pass has since been through its own defects — a chord that lay outside the
face it belonged to, a fan that put a zero-area triangle under every point, a zipper that welded a face's
own rim to itself — and on corbu it now leaves a defect total of 10,372 once its own holes are closed, where
it left 27,147. It is still refused there: the four classes it is judged on are 2,188 / 1,850 / 2,259 /
3,823 against the 29 / 2,157 / 1,428 / 1,460 of the mesh it would replace.

The clamp on that pass's edge-crossing parameter was the first of its defects. Where
an edge crosses a plane was computed without clamping the parameter to the edge, and `same_sign`
lets a near-coplanar triangle through — three signed distances of order 1e-9 are not all above its
1e-7 epsilon — so the ratio could be enormous. Measured on 3DBenchy, 80 of 15,813 new vertices
landed outside the input bounding box and stretched its diagonal from 82.9 to 147,829, taking the
surface area up 1,444% and the signed volume negative. Clamped, the same file comes out at +0.29%
area and +0.06% volume with no point off the box. The crossing counts fall too — 11,223 to 8,647 on
benchy, 29,383 to 24,653 on the cones — because the extrapolated points had been inventing
intersections that were never there.

A face whose chords all start and end on its own boundary is triangulated directly, without the CDT:
the boundary ring is split along each chord and each piece triangulated by ear clipping, cutting the
largest empty ear. Splitting a convex ring along a chord leaves both pieces convex, so this is exact,
and it is precisely the case the CDT gets wrong — with extra points sitting collinear on the boundary
it returns a triangulation missing a whole region, 25% of one face on a two-triangle fixture and
0.29% of 3DBenchy's surface area. Rejecting those triangulations instead, which is the obvious guard,
rejects 8,123 of 14,751 of them — 55% — so the split is the fix and distrust is not.

Two things about that ring path are load-bearing. The ear has to be *empty* — no other vertex inside
it — because a point the on-edge tolerance accepted can still sit slightly off the edge, which makes
the ring polygon not quite convex, and cutting the corner first then covers those points' slivers
twice. And the ear has to be the *largest* one, because a fan emits a zero-area triangle for every
point collinear with its apex, and a zero-area triangle has no normal for the winding pass to compare.

A chord is also clipped to the face before it is used. A chord comes from overlapping the two
triangles' intervals along the planes' intersection line, projected onto one axis; that overlap is
necessary and not sufficient, and on a 407k-triangle refinement **8,066 of the 15,307 chords the
faces carried lay entirely outside the face they were recorded on**. The CDT triangulates the convex
*hull* of the points it is handed, so an endpoint outside the face drags surface out with it: the
per-face coverage check read a median of 1.16 times the face's own area and a maximum of 744. Clipped,
the same refinement covers each face to the digit, and the pass' own zipper closes only the regions
that are genuinely missing — it used to take the face's own rim for a hole and weld it to itself,
putting a second copy of every triangle behind the first.

What remains of the loss is the faces with a chord whose endpoint is *strictly inside* the face: they
still go to the CDT, and it does not represent them — 62 of the 269 faces that reach it on the
measured file come back short, 7.4e-5 of that file's surface area. The textbook answer is constrained
insertion: walk from one chord endpoint to the other and flip the crossed edges.

Two things the clamp had to be careful about, and both were found by the tests rather than by
reading the code:

- **Finiteness has to be checked before clamping, not after.** A vertex exactly on the other plane
  makes the denominator zero; clamping first maps that infinity to a bound and lets a degenerate
  pair through as though it were a real crossing. That is how a pair of triangles that merely touch
  came to be reported as intersecting, which inflates the crossing count the panel shows.
- **A coverage check on the CDT's output is not the answer.** It rejects 55% of the faces it would
  otherwise refine, trading a quietly missing surface for a pass that barely works.

The pass stays off until the mixed-chord case is handled the same way.

## The winding that flipping cannot settle, and the cut that can

The faces joined across a mesh's two-face edges form a graph whose edges demand a parity, and a cycle
whose parities sum to an odd number is satisfied by *no* assignment of face orientations. A file can
therefore end with inconsistently wound edges that no amount of flipping clears, and the report says
exactly that: "its topology has cycles that demand an odd flip".

Two of the corpus files are like that, and the pipeline's answer is layered:

- `repair_orientation`'s side-split cut settles a mesh whose disagreements are spread over the
  surface. It cannot separate the two faces of an edge that are already on the same side, which is
  what a *localised* defect leaves.
- `retessellate_unsatisfiable` drops the faces on the unsatisfiable edges and lets the fill close what
  that opens. It is guarded on the outcome — a move that adds parts or moves the volume is refused —
  which is right for a localised defect and refuses on a spread one.
- `RepairOptions::cut_unsatisfiable_edges` (**on by default** — it is judged, see below;
  `--cut-unsatisfiable-edges=false` on the CLI, `cutUnsatisfiableEdges` from the app) is the last
  resort: one face per unsatisfiable edge is taken
  as the region, the vertices it shares with the rest of the surface are duplicated exactly where they
  were, and the seam each cut opens is capped one side at a time — the general fill cannot do that,
  because its walk pairs boundary edges by vertex alone and joins two fans at a pinched vertex, which
  bridges the sides and brings the non-orientability straight back.

### The route is chosen, not asked for

`repair_auto` is the repair the app runs, and it decides between two routes:

- **The local pipeline.** It repairs what is there, so it goes first, and if it comes back
  `fully_repaired` the second route never runs (no guess about the file is involved — the verdict
  decides).
- **The surface-to-solid rebuild**, behind it. When the local pipeline cannot settle a mesh and the
  caller allows it (`allow_rebuild`, on by default), the mesh goes through `solid_remesh` and that
  result is repaired in turn, then **judged**: kept only when it is `fully_repaired` or its defect
  total is strictly better. It rebuilds the surface into a solid, so it moves the model, and the
  report says so in as many words — "this mesh was rebuilt rather than repaired: ... 20.6% more volume
  and 356044 triangles where the input had 596293" — because that is a different object rather than
  the same one repaired.

A rebuild resolves *one* object, so the route has to know which it is looking at, and the criterion
is measured rather than guessed — a mesh with one object in it has a dominant shell, a plate of
comparable objects does not:

| file | shells | largest shell |
| --- | --- | --- |
| `3DBenchy` | 1 | 100% |
| `corbu` | 8 | 77.0% |
| `Gusano_de_Dune_70%` | 302 | 77.6% |
| `Untitled2` (a plate of 25 objects) | 29 | 20.8% |

So "several shells, none of them dominant" stands the route down with the numbers in the note
("the mesh is several objects and the largest holds 28% of it — repair the parts, not the plate"),
and the bias is deliberate: declining a rebuild leaves the honest local result, while running one that
should not have run replaces a detailed model with a coarser one — the plate's own rebuild measured
656,922 triangles in and 149,768 out, its shells fragmented from 118 to 306.

**And a rebuild is only kept when it finishes the job.** It costs detail, so "better but still
broken" is not the trade this route is for; when it does not come out `fully_repaired` the local
result is handed back with a note saying the rebuild was tried and what it came to. A caller that
wants the surfacing for its own sake has the mode by name.

Measured on `Gusano_de_Dune_70%.stl`, the one file in the corpus nothing else settles:

| route | non-manifold | pinched | loops | winding | triangles | verdict |
|---|---|---|---|---|---|---|
| input | 3,513 | 3,164 | 66 | 1,897 | 596,293 | — |
| local, with the cut | 97 | 188 | 0 | 0 | 595,802 | not repaired |
| **rebuild, repaired** | **0** | **0** | **0** | **0** | 356,044 | **fully repaired** |

And the five files the corpus sweep watches are unchanged by the new defaults — 3DBenchy, poussin,
COOKIE_b4, Harbinger and corbu all come out `fully_repaired` 0/0/0/0, with the cut firing on none of
them (it is judged, and on corbu there is no unsatisfiable edge to cut at all).

The cut is judged like the passes that rebuild surface: its own scraps are culled first (a region
detached from the surface is a shell of one to three faces, and the noise rule is what removes those),
then it is kept only when the defect total strictly drops, and — on a watertight mesh, where the
number means something — when the volume holds. Measured on `Gusano_de_Dune_70%.stl`, which arrives
with 596,293 triangles, 3,513 non-manifold edges and 1,897 winding edges:

| | default | with the cut |
|---|---|---|
| inconsistent winding edges | 1,374 | **0** |
| non-manifold edges | 196 | **97** |
| pinched vertices | 338 | **188** |
| boundary loops | 0 | 0 |

It stays off by default because the same move on a surface frustrated *throughout* can go the other
way: on an earlier branch it took one file's winding from 113 to 919. The guard above is what makes
that a refusal instead of a regression, and the option is how a caller says they want the trade.

## Repairing a plate: the parts flow

A print plate is not one model, and a repair of the whole file gives one verdict for all of its
objects. Measured on the plate in the corpus (`Untitled2.stl`, 656,922 triangles as loaded): 118
components by the engine's edge test, 29 by vertex connectivity, and a slicer lists **25 objects** —
because an object is one *or several* shells, and the shells of one object are the ones that meet
each other. Repairing it whole leaves 1,389 inconsistently wound edges and says the surface "cannot be
wound consistently", which is true of the file and useless to the user: it does not say which object
is the problem, and 26 of the parts are fine.

So there is a flow that separates the parts first:

- `dragonfruit_mesh_repair::repair_separate_parts(&mesh, &options, progress)` — `repair.rs`. Groups the
  components by contact (`topology_passes::crossing_component_pairs`: a triangle of one crossing a
  triangle of the other), repairs each group on its own, and returns `PartsRepair` — one `PartOutcome`
  per part, each with the part's own `RepairOutcome` (its `mesh`, its `report`, its verdict).
  `PartsRepair::repaired()` counts the parts that came out `fully_repaired`. `None` means the mesh is
  one object and the caller's own pipeline is the right one.
- `dragonfruit-mesh-repair parts <input> <out_dir>` — the same flow from the CLI, writing
  `<stem>.partNN.stl` and `<stem>.partNN.json` per part and a `parts.json`-shaped summary to stdout.

Measured on that plate: **39 parts, 26 `fully_repaired`, 13 not** — and the 13 name their own defect
(39 to 361 same-direction edges each, adding up to the file's 1,389). Two things about the grouping are
load-bearing. Components that **meet** are one part: they are one object between them, and repairing
them apart separates surfaces the repair is meant to join — the same relation the union uses to pick
its operands. And a part is repaired with the pipeline's own rules, so a part smaller than the noise
threshold is still culled, which is why some parts report `4 -> 0` triangles and `fully_repaired`.

What this does not do is make a broken part repairable. The 13 that fail do so for the class the plan
records: their own topology demands an odd flip, which is what their self-intersections leave behind.

### In the app

The flow is wired into the import path, at the point where a heavy repair is already offered:

- `MeshRepairConfirmModal` carries a third action, **Repair parts separately**, shown when the
  pre-repair analysis reports more than one component *and* the import has a source path behind it
  (`MeshRepairConfirmPrompt.canRepairParts`). The parts runner reads the file, so an import that only
  has staged geometry cannot use it; the hook says so on the console and repairs whole instead.
- `ProcessGeometryOptions.onConfirmHeavyRepair` returns `'repair' | 'repair_parts' | 'skip'`
  (`HeavyRepairChoice`) rather than a boolean, and `useStlGeometry` routes `'repair_parts'` through
  `repairPartsFromPath`.
- `mesh_repair_parts_from_path` is the IPC command: it repairs the parts, **joins them back into one
  mesh**, stages that, and returns a `MeshHealthReport` with `parts` filled in — so the scene carries
  one model, as every other import does, and the report is per object.
- `MeshRepairReportModal` renders `report.parts` as its own section: "N of M parts repaired", one line
  per part, with the failing ones carrying their own reason.

The report fields a caller reads are `MeshHealthReport::parts` (`MeshPartReport` in Rust,
`MeshRepairPartSummary` in TS): `index`, `triangles_before`, `triangles_after`, `fully_repaired` and
the part's own `residual_issues`.

### The rebuild's own look: what "rough" measured as

A rebuilt surface reads as rougher than the model it replaced, and on `Gusano_de_Dune_70%.stl` that is
measurable — the mean dihedral angle across its interior edges, and how much of it is sharp:

| | triangles | mean dihedral | edges over 30° | triangle size | signed volume |
| --- | --- | --- | --- | --- | --- |
| the input | 596,293 | 9.4° | 7.4% | 0.344 mm | 37,293 |
| rebuild at simplify 0.001 | 356,072 | 13.2° | 13.3% | 0.446 mm | 44,909 (+20.4%) |
| **rebuild at simplify 0.0002, Taubin x2** | 603,772 | ~11.0° | ~9.8% | 0.325 mm | 45,094 (+20.9%) |

Two of the three causes are the *simplify* before the boolean: collapsing the surface folds it, the
boolean then resolves a folded one, and the result comes back coarser than the input (0.446 mm faces
where the input had 0.344 mm) with nearly twice the sharp edges. So the simplify default is `0.0002`
now, which buys back the input's own density and most of its smoothness for 1.7x the triangles and
about five seconds on that model. A light Taubin pass (`smooth_iterations`, default 2, step derived
from the mesh's own median edge) takes the last of the stair-steps off, and shares its implementation
with the hollow's cavity surface, which needed the same thing for the same reason.

The third cause is not roughness and does not move: the resolve fills the model's own shells, so its
signed volume comes out about 20% above the input's at every simplify setting. That is the resolve
doing what it is for, and the report says the surface moved.

## Two things that are not what they look like

### The inner-face removal is component-level, and that is not a shortcut

The reference engine resolves non-manifoldness and self-intersections by wrapping the
outer surface with a boolean union. There is no union here, so `cull_interior_components`
removes a face only when it sits inside *another component*, where removing it provably
cannot open the outer shell.

The component it removes has to be **closed**. A cavity is a closed component inside another, and
removing it fills a void; a buried sheet is open, carries no volume, and removing it moves nothing.
That used to be tested by watching the signed volume, which is a stand-in that stops working the
moment the mesh is not watertight: on the worm file 2,975 boundary edges leave the volume
meaningless, and the removal tripped a 0.589% move that was arithmetic on an open surface rather
than a cavity being filled. Closeness is the property the guard is really about, so closeness is
what it tests now, by requiring every edge of the component to be used by exactly two of its faces.
The volume check stays as a second bound, and in this reduced domain the volume it reads is real.

The upgrade you would reach for is a per-face test: sample both sides of a face along its
normal, count ray crossings, and a face separates inside from outside exactly when the
two sides disagree. It was written and measured, and it does not hold up. Three
directions per side with a conservative vote, the offset tied to the face's own longest
edge, the ray tilted off the normal: at an offset of three thousandths of the longest
edge it took seven faces from `poussin.stl` that were on the surface, opened it, and the
hole pass then made two non-manifold edges out of the patch. At five ten-thousandths it
left `poussin` alone and still took forty-seven faces from `3DBenchy.stl` and produced
seven non-manifold edges the same way. The classification is right about 99.99% of faces,
and a hundredth of a percent of a surface is a hole.

The guard that would make it sound, "drop a face only when its edges keep two faces",
blocks exactly the case the stage exists for: a buried sheet's edges are its own, and one
face on an edge is what a sheet edge and a boundary edge both look like. The test cannot
tell them apart locally, which is why the parity test is the only candidate and why its
error rate decides the question.

Until there is a boolean union, this stage stays component-level and says so.

### The hole patching is on the boundary, not in the middle

`holes_trivial` closes a border loop of six edges or fewer and `holes_all` closes
anything up to the caller's cap, both in `crate::holes`. A loop that is not a simple
cycle, or that another loop already claimed, is skipped: a border that pinches is not a
hole, and capping it adds the faces that make the mesh non-manifold.

## Related pages

- [Mesh wire formats](mesh-wire-formats.md), the payloads this engine reads and writes
- [Tauri IPC bridge](tauri-ipc-bridge.md), how a repair reaches the frontend
- [The slicing engine](slicing-engine/index.md), what consumes the result
