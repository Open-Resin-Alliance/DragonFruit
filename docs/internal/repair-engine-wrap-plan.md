# Wrapping the outer surface: the recipe, the blocker, and the measurements

**Point in time.** `feat/auto-repair-2.1`, after evaluating the ISIR reference implementation and
measuring `shrinkwrap` on the worm file. Numbers below are measured, not estimated.

## Why a wrap at all

`shrinkwrap` fully repairs the damaged export, but it **resamples**: the result has no relation to
the input's geometry beyond its shape. At 0.8 mm voxels on an 88 mm miniature that is a visible loss
of detail.

A wrap is the alternative that keeps it. It removes only the faces that are inside something else and
leaves every other face exactly where it was, so nothing is resampled and no detail is lost — the
operation we do not have. The tetrahedral surfacing mode (see `tetrahedral-surfacing.md`) reaches a
similar end by decomposition; a wrap reaches it without rebuilding the surface at all.

## The recipe

1. **Split at self-intersections** so no face crosses another. Existing:
   `arrangement::corefine_self_intersections`, wired as the opt-in `split_self_intersections` stage.
2. **Classify each face inside or outside** by parity: cast a ray from just off the face along its
   normal and count hits. Odd means interior. `Topology`-free, needs only `Bvh::ray_hit_count`.
3. **Remove the interior faces**, then **fill the rims that opens** with `fill_holes_oriented`.
4. **Guard it** the way every destructive stage is guarded: refuse unless the classes strictly
   improve and the volume does not move.

Step 2 looks like the per-face test the pass docs record as *failed* — "the classification is right
about 99.99% of faces, and a hundredth of a percent of a surface is a hole". The difference is that
the recorded attempt ran on a mesh that was **not conformal**, and step 1 is what makes step 2 exact.
That is the whole reason the order matters.

## Measured on the worm (596,293 triangles, 3515 non-manifold, 4969 boundary)

**The split is the blocker.** `corefine_self_intersections` on this file:

| | value |
|---|---|
| intersecting pairs | 385,241 |
| refined faces | 67,979 |
| **skipped faces** | **37,154** |
| new vertices | 326,101 |
| triangles | 581,959 to 913,760 |

A fallback was added while measuring this: when the CDT cannot triangulate a face, the chords that
do end on the face's boundary ring are now refined exactly instead of the face being kept whole.
That took skipped faces from 51,952 to 37,154, and the stage is still refused because the result is
still worse than the input. Both numbers are measured against the same file.

**Pair symmetry was tried and is not the fix.** Since a crossing is recorded on both faces, the
obvious repair is to decide per pair: apply a face only when every face it crosses is applied too,
iterated because demoting one can strand its partners. It was written and measured, and it makes
things worse rather than better:

| | refined | skipped | verdict |
|---|---|---|---|
| ring fallback alone | 67,979 | 37,154 | refused |
| ring fallback + pair symmetry | **5,017** | **100,116** | refused |

The fixed point collapses to almost nothing and the stage is still refused, which says the decision
cannot be made per pair either. A refined face inserts new vertices on its own edges wherever a
crossing enters or leaves it, and an edge is shared with a face that need not be a crossing partner
at all. So the T-junction can appear at any refined/unrefined neighbour boundary, and forcing
consistency per pair only shrinks how much gets refined without removing the inconsistency.

**The damage is T-junctions, not unrefined crossings.** `collect_face_segments` records each
crossing on *both* faces, so a crossing pair is normally refined together. When one of the pair
refines and the other is skipped, the refined one carries new vertices on their shared edge that the
neighbour does not use. That is what turns a partial refinement into thousands of boundary and
non-manifold edges, and it is why the guard is right to refuse. That leaves a structural conclusion
rather than a tweak: a T-junction is unavoidable while refinement is per face and partial, so the
split has to become **all or nothing** for the region it touches — build a fresh mesh for that region
and replace it, rather than refining faces selectively. Our per-face `Option` return cannot express
that, which is why every per-face variant
measured so far is refused.

It refines 62k faces, skips 52k, and leaves the mesh far worse. The guard refuses it, correctly.
The skipped faces are the mixed-chord case: the pass already handles a face whose chords both start
and end on its own boundary by splitting the boundary ring along each chord, which is exact because
splitting a convex ring along a chord leaves both pieces convex. A face with a mix of boundary and
interior chords still goes to the CDT and comes back wrong.

**The classification is not the problem.** Running step 2 by hand on the post-split mesh, counting
hits against every face rather than only other components:

| offset | faces interior |
|---|---|
| 1e-6 of bbox diagonal | 31.83% |
| 1e-5 | 32.51% |
| 1e-4 | 33.54% |
| 1e-3 | 34.11% |

It moves smoothly with the offset and shows no cliff, which is the opposite of the instability the
docs recorded. So the classification half is sound; only the split needs work.

## What to do

**Fix the mixed-chord case in `corefine_self_intersections`** the way the boundary-ring case was
fixed: split the ring along the chords rather than handing the face to the CDT. Then re-run the
probe above; the expected signal is a post-split mesh whose classes have not grown much, and a
classification that still moves smoothly with the offset.

Only after that is an outer-surface wrap stage worth writing. Writing it against the current split
would produce a stage that is always refused.

## Related

- `../../docs/dev/mesh-repair-passes.md` — the pass set, the guards, and the CDT/mixed-chord record
- `repair-engine-worm-model.md` — why the worm's tangle resists every other pass
- `repair-engine-winding-and-boundary.md` — the Harbinger residual, same shape of answer
