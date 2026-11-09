# Repair engine plan

The plan for this branch. `repair-engine-reference.md` holds the evidence; this
holds the decisions.

## Why

Three shipping slicers were reverse-engineered and all three agree: repair is local
and combinatorial, and **none of them resamples, voxelises or remeshes**. One of
them has a pipeline known stage by stage, and its defect verdict is five classes
that do not include self-intersections. This engine's verdict has eight and includes
self-intersections twice (crossings and contacts), which is why it marks good models
as broken and then spends minutes trying to fix them.

## The pipeline

The reference order, with the reference's stage names. Eighteen stages, and the
repetition is the design: orientation, then stitch, then holes, then double faces,
then orientation again, because each of those disturbs what the one before it
settled.

```
orient        stitch        trivial holes   double faces
orient        trivial holes  stitch
orient        all holes      stitch
split crossings  double faces  inner faces  noise shells
stitch        noise shells   all holes       orient
```

| stage | what it does |
| --- | --- |
| the orientation pass | Per-component flood fill over the neighbour graph, then turn closed shells outward by signed volume. |
| the stitch pass | A vertex weld, then an edge zip, both on a tolerance, both no-ops when the tolerance is not positive. |
| the trivial-hole pass | Close boundary loops of **six edges or fewer**. |
| the all-holes pass | Every hole the caller's cap allows. |
| the double-face pass | Delete duplicate and coincident faces. |
| splitting the self-intersections | Split the self-crossings in place. |
| removing the inner faces | Remove the triangles that are inside **another component**. |
| the noise-shell pass | Delete a shell when it has fewer than four triangles, or its area is under a hundredth of the mesh's and its count under a twentieth. |

### The weld answers for its own work

A vertex weld is a heuristic, and on a mesh that is already nearly clean it can leave the
mesh worse than it found it. Joining two surfaces a hair apart is the point, and where
three or more of them meet the junction is non-manifold. The reference resolves that with
a boolean union and there is no union here, so the weld checks itself against the five
classes and refuses when any of them would go up.

The guard is inside the helper rather than at the call sites because four stages stitch and
two more run the cull on its own, and one of them forgetting to check is how a mesh came out
of a repair with more non-manifold edges than it went in with. Both halves of the stitch do
their own damage, so the condition is either of them having done something, not the weld
alone: guarding on the weld let a run that welded nothing remove 996 duplicate faces and
leave the mesh with nine non-manifold edges.

The cull needs its own guard for the same reason, and on the app's path it is the whole of
the damage. Repairing the reported file through the staging path, which expands the geometry
to a triangle soup and re-derives every vertex, goes from 0 non-manifold edges and 0 boundary
edges to 9 and 3 with the weld refusing and reporting nothing: the cull removed 995 faces on
its own.

Measured on `213277_438404_1039898_HF_Warlock_unified_mm.3mf`: the default tolerance of
1e-5 welds 615 vertices, collapses 1,236 degenerate or duplicate faces, and takes
non-manifold edges 11 to 19 and boundary edges 0 to 5. At 1e-6 and 5e-6 the same mesh
welds 38 and 231 vertices with no damage at all, so the harm is not the tolerance being
loose in absolute terms, it is what joining those surfaces does to the topology. With the
guard the repair of that file is a byte-for-byte no-op, and the report says what is
actually wrong with it: 11 non-manifold edges, 4 pinched vertices, and crossings as a note.

A refusal is not a repair. The report says the weld was refused rather than counting a
stitch that did not happen.

### The inner-face removal is component-level, and that is not a shortcut

The reference resolves non-manifoldness and self-intersections by wrapping the outer
surface with a boolean union. We do not have one, so the stage removes a face only
when it sits inside *another component*, where removing it provably cannot open the
outer shell.

The obvious upgrade is a per-face test: sample both sides of a face along its normal
and count ray crossings, and a face separates inside from outside exactly when the
two sides disagree. It was written and measured, and it does not hold up. Three
directions per side with a conservative vote, the offset tied to the face's own
longest edge, and the ray tilted off the normal: at an offset of three thousandths of
the longest edge it took seven faces from `poussin` that were on the surface, opened
it, and the hole pass then made two non-manifold edges out of the patch. Tightening
the offset to five ten-thousandths left `poussin` alone but still took forty-seven
faces from `3DBenchy` and produced seven non-manifold edges the same way. The
classification is right about 99.99% of faces, and a hundredth of a percent of a
surface is a hole.

Guarding it does not save it either. A face may only be dropped when its removal
cannot create a boundary, which means every one of its edges keeps two faces, and a
buried sheet's edges are its own, so that guard blocks exactly the case the stage
exists for. The test cannot tell a sheet edge from a boundary edge, because locally
they are the same thing: one face on an edge.

So the stage stays component-level and honest about it. The single-component case
needs the boolean union, and until we have one this stage will not pretend to have
solved it.

## The verdict

Five classes, and no more:

| class | what it counts |
| --- | --- |
| orientation | edges whose two faces disagree about direction |
| bad edges | edges not shared by exactly two faces |
| holes | boundary loops |
| non-manifold | edges carrying more than two faces, and the vertices they pass through |
| shells | shells small enough to be noise |

**Self-intersections are not one of them.** The repair acts on them; the verdict
does not count them. Ours must stop counting them too, in the engine and in
everything the frontend shows, or a printable model keeps reading as broken.

## What this branch does, in order

1. `evaluate.rs` — the five classes, and `is_broken` on top of them.
2. `shells.rs` — the noise-shell pass, the ratio rule exactly. It replaces
   `prune_open_fragments`, which kept a component only when it was closed or nearly
   so and deleted whole models for it.
3. `holes.rs` — the trivial-hole pass as its own first pass, and the all-holes pass behind it.
4. `pipeline` — `repair()` rewritten to the order above, reusing the passes that
   already match (`weld_vertices`, `cull_degenerate_and_duplicate`,
   `corefine_self_intersections`) and dropping the two the reference does not have:
   `remove_non_manifold_faces` and `split_non_manifold_vertices`. The reference
   resolves non-manifoldness with removing the inner faces and carries no bespoke pass for
   it.
5. The report and the frontend verdict follow the five classes.
6. The repair progress UI from `feat/repair-pass-set` comes across, because a
   rewrite that cannot say what it is doing is no easier to trust than the old one:
   a stage name, an elapsed counter, a capped stage list, and a cancel that stops
   the pipeline at a stage boundary.

## What is deliberately not copied

No code, names, strings or constants from any surveyed engine. The tolerances stay
ours (the mesh's own shortest edge, grown by a fraction of the bounding diagonal,
two passes), which is the same *design* as the references without being their
expression. The stage names above are descriptive of what each stage does, and the
passes here keep the names this codebase already uses.
