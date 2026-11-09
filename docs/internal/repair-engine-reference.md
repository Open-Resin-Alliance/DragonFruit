# Repair engines: what three shipping slicers actually do

Reverse-engineering notes, and what they say about the engine here. The raw dumps
came out of the NotableReindeer session; this is the part that changes decisions.

Three slicers were surveyed: a resin one, a print-oriented one, and a second resin
one. None is named here, and no code, identifier or string from any of them is
copied. What follows is behaviour.

## The headline, because it settles an argument

**None of the three resamples, voxelises or remeshes a mesh to repair it.** Every
automatic path is local and combinatorial on the triangle soup and its neighbour
graph.

- The first resin slicer: "No voxel remesh or resampling occurs in any automatic or
  hole path; the only resampling route is the explicitly user-invoked wrap command."
- The print-oriented slicer: "There is no voxel/level-set/isotropic remesh anywhere
  in the repair path." Its boolean library *validates* closedness rather than
  establishing it, its volume library serves hollowing only, and both of its
  simplifiers are explicitly not repair.
- The second resin slicer: "PATCH, not remesh. No new vertices are synthesized by
  resampling; no subdivision, smoothing, or remeshing stage exists in the repair
  core's callee set."

This engine had a field-rebuild fallback on the self-intersection path, which is
voxel remeshing by another name, and it replaced a 405,465-triangle model with
85,472 triangles on a 0.94 mm voxel. It is gone, and the references say that was
right.

## The reference pipeline

The first resin slicer's automatic repair is a fixed call list, and the
interleaving is the design rather than sloppiness: orientation, then stitch, then
holes, then double faces, then orientation again, because each of those disturbs
what the one before it settled.

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
| the all-holes pass | Every hole, in two passes. |
| the double-face pass | Delete duplicate and coincident faces. |
| splitting the self-intersections | Split the self-crossings in place, replacing the mesh with the split result. |
| removing the inner faces | Remove the triangles that are inside: "Wrap out faces by removing inner triangles". |
| the noise-shell pass | Delete a shell when it has fewer than four triangles, or its area is under a hundredth of the mesh's and its count under a twentieth. |

Its own mesh type carries per-triangle flags (deleted, selected) and edge
neighbours, and every stage ends by rebuilding topology on the same mesh. No stage
allocates a new mesh except the split and the wrap.

## Its verdict is five classes

Its evaluators are orientation, bad edges, holes, non-manifold and shells. There is
no sixth.

**Self-intersections are not one of them.** The repair *acts* on self-intersections
through splitting the self-intersections and removing the inner faces; the verdict does not *count* them.
That is the distinction this engine kept getting wrong: a mesh was called broken for
carrying self-intersections a slicer does not care about, and then minutes were
spent trying to remove them, on files that print perfectly.

## The print-oriented slicer

The most conservative of the three.

1. Bitwise-exact edge match, degenerate purge, neighbour graph.
2. Tolerance grid snap, **at most two passes**, tolerance seeded from the mesh's own
   shortest edge and grown by a ten-thousandth of the bounding diagonal per pass.
3. Collapse the degenerates the snap created; delete facets with no neighbours.
4. **Hole filling is compiled out** (`#if 0`), with the reasoning that on complex
   holes it does more harm than good.
5. Per-patch orientation flood over the neighbour graph, reverting the whole run on
   a conflict.
6. Normal recompute, epsilon 0.001 per component.
7. Global signed-volume flip.
8. Verify neighbours, and refresh connectivity if anything changed.
9. Soup to indexed by fan traversal, with visit stamps so a non-manifold fan
   terminates instead of looping.

Its answer to a gap is not to fill it in 3D at all: the *slicer* chains open
polylines and closes gaps with a 2 mm budget in slice space. That is a deliberate
architectural choice, and the opposite of chasing perfect closure.

## The second resin slicer

Native order: vertex merge and reindex, orientation (a parallel flood plus a
signed-volume flip), weld and bounds, invalid and degenerate face cull, then hole
closing, a write-back, and an iterative post-pass bounded at 16 rounds.

Its defaults are what a user gets without asking:

```
fillHoles                  true
deleteInvisibleSurfaces    true
deleteIsolatedSurfaces     false
reverseMisorientedSurfaces true
isolatedSurfaceThreshold   1.5
nmaxPass                   16
```

And: **no evidence of self-intersection handling at all** — zero self-intersect
strings in the binary or the script. It does not repair them.

## Against this engine

| reference stage | here | note |
| --- | --- | --- |
| the orientation pass | `orient_components` | same idea: flood fill, then turn closed shells outward |
| the stitch pass | `weld` + `cull_post_weld` | same tolerance design, and the same two-pass budget |
| the double-face pass | `cull_degenerate_and_duplicate` | same |
| the trivial-hole pass / the all-holes pass | `fill_holes` | ours is one pass on the caller's cap |
| splitting the self-intersections | `corefine_self_intersections` | same: split the crossings in place |
| removing the inner faces | `extract_union_boundary_faces` | same shape; theirs is a boolean union |
| the noise-shell pass | **nothing** | the reference's ratio rule has no equivalent here |
| - | `split_non_manifold_vertices` | ours; the reference has no vertex-split stage |
| - | `micro_topology_heal` | ours |
| - | `resample_outer_surface` | ours, opt-in; the reference's equivalent is a separate command |

The reference has **no bespoke non-manifold pass**: removing the inner faces, the union,
resolves non-manifoldness and self-intersections together. Our
`remove_non_manifold_faces` and `split_non_manifold_vertices` churn is our own
invention, and it is exactly what keeps rolling back.

## What that implies, in priority order

1. **A noise-shell prune by ratio.** The rule is exact and needs no parameter:
   `triCount < 4`, or area under a hundredth of the mesh's and count under a
   twentieth. This engine had a cruder rule (`prune_open_fragments`, keep a
   component only when closed or nearly so) which was deleted for deleting whole
   models, and nothing replaced it.
2. **Close trivial holes unconditionally.** The reference does six boundary edges or
   fewer as a separate first pass, and the second resin slicer fills holes by
   default. Here the default cap is zero, so a four-edge slit is reported and left.
3. **Do not chase the hand-rolled extraction further.** The engines that handle
   self-intersections use a union for it. If the surface-based path is wanted, the
   extraction wants to be a union; where no boolean library is available, reporting
   the crossings is what the other two do.
4. **Consider the slice-time backstop.** Tolerating gaps and closing them in slice
   space with a budget is a cheaper guarantee than perfect closure, and it belongs
   in the slicing engine rather than here.
