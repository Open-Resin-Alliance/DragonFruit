# The worm model: what is wrong with it and what was tried

**Point in time.** Written on `feat/repair-refinement`, after iterating on
`Gusano_de_Dune_70%.stl` and taking what the guards allow.

The file is a 596,293 triangle, 302 part pre-supported export with 3,515 non-manifold edges and
1,454 boundary edges. It arrives tangled, and everything below is measured.

## What the file actually is

The non-manifold edges are two different problems wearing one number:

| kind | count | what it is |
|---|---|---|
| exact duplicates | 3,655 vertex-sets holding 18,374 faces | the same triangle repeated, up to ~23 copies at one junction |
| genuine overlap | ~2,000 junctions | faces sharing an edge without being the same triangle, up to **92 faces at one edge** |

Spread across 76 x 79 x 98 of a 157.75 diagonal model, so not a local defect. All of it on the
**model** section: the support section is clean, which is the same shape of result the Harbinger
file gave and the opposite of what pre-supported exports are assumed to be.

`Manifold::from_mesh_f32` **refuses the biggest component** (`manifold3d status: NotManifold`), so
no boolean can take the surface as it stands.

## What was fixed, and it holds

`cull_duplicate_and_zero_area_faces` removed a face that stood twice, took the last face off an edge
doing it, and then `worse_than` refused the removal for opening the mesh. The rims it opens are
where a doubled wall stood rather than openings somebody designed, so the pass now fills them, and
splits the pinches first because the fill skips a pinched loop by design. That is the recipe
`split_non_manifold_edges` already used on its own rims.

The ripple is worth knowing: `stitch_vertices` calls `cull_faces` internally, so the same fill
applies there too, and **`stitch` went from collapsing 124 duplicate faces to 15,350**.

On the worm model: non-manifold 3,515 to 1,999, boundary 1,454 to 976, loops 315 to 237, winding
1,896 to 1,505, **no parts added**. The reference files are unchanged and all six still fully
repaired.

## What is still refused, and why the guards are right

**The split.** It reaches non-manifold **1,999 to 0**, loops 237 to 140, and is refused on parts:
302 to **600** against an allowance of about 317. A model nearly doubling its piece count has come
apart rather than been repaired.

**The union.** It produces parts 302 to **1,986** and triangles +33%, and refuses itself.

**The pair cannot rescue each other.** Recorded from an earlier attempt: the split *offsets* the
separated surfaces so a re-weld cannot merge them back, which is why a union can never merge them
either. Judging the pair together was tried and reverted, and it cost a CSG per split round without
ever turning a refusal into an acceptance.

## What would actually repair it

A boolean that can take tangled input, or a re-export. Everything in the crate refuses for a
measured reason, and the sequence deduplicate, fill, split, union does not close because step three
makes step four impossible by construction.

One thing not yet tried: the **union runs before the split** in the pipeline order, deliberately, and
that order was chosen on other files. Running it on the split's output is the dead end above.

## Measured since: the union is not the problem

The first measurement said Manifold shatters this file's solids, and it was wrong. It called
`Manifold::batch_union` on the raw components, and the pass does not do that:
`union_closed_components` keeps every component Manifold refuses and recombines it, so the net
effect is small.

The real numbers, from the pipeline:

| | union | parts | surface |
|---|---|---|---|
| COOKIE_b4 | accepted | 233 to 37 | -14.16% |
| corbu | accepted | 8 to 12 | -0.01% |
| the worm | refused | 302 to 1986 | -6.31% |

The union *does* lose surface on the subset it accepts, and that loss is legitimate: it counts a
shared interior once instead of twice, which is the point of merging solids. COOKIE_b4's 14% buys
the merge that makes that file fully repaired, so a surface bound is the wrong guard to add here. It
was written, measured against this table, and reverted, because it refuses the one union that works.

The worm is refused on parts, 302 to 1,986 against an allowance of about 317, which is the right
reason and catches it already.

## The inner-face refusal does not matter here, and the guard was unsound

`remove_inner_faces` refuses on this file, and the reason is worth stating because it was wrong.
The count is 38 faces, a genuinely closed shell buried in the model, so the refusal is correct: the
shell encloses about 127 cubic units and removing it would fill that void.

What was wrong is how the guard decided. It watched the signed volume, standing in for "a cavity is
closed and a buried sheet is open", and on this input 2,975 boundary edges make the signed volume
meaningless. It tripped on a 0.589% move that was arithmetic on an open surface, not a cavity. The
cull now requires the component to be **closed** before it is a candidate at all, which is the
property being tested rather than a proxy for it, and the volume it reads afterwards is a real
volume. Measured: the six reference files are unchanged, corbu takes 18 closed interior faces it is
free to remove, and 73 tests pass.

38 faces against 302 parts and 1,999 non-manifold edges also answers the original question: this
refusal is not what stands between the file and a repair. Those faces are not part of the tangle.

## Related

- `../../docs/dev/mesh-repair-passes.md` — the published pass set and the guards
- `repair-engine-winding-and-boundary.md` — the Harbinger residual, same shape of answer
