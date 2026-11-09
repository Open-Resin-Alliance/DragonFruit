# Tetrahedral surfacing: plan and measurements

**Point in time.** `feat/auto-repair-2.1`.

## What the mode is

1. **Tetrahedralise the model's points** with TetGen, with no facet constraints.
2. **Label every tetrahedron** inside or outside. Today: the winding number at its centroid.
3. **Keep the boundary** between the two labels.
4. **Simplify** to a triangle budget if one is given.

No facet constraints, deliberately. A damaged export is a soup with self-intersecting and
non-manifold facets, which is exactly what a constrained tetrahedralisation rejects, and making such
a soup admissible first is work we do not need: deciding inside from outside afterwards reaches the
same end.

## Why a second surfacing mode exists

`shrink_wrap` samples a narrow-band signed distance field and extracts the isosurface with marching
tetrahedra. Two properties of that are not parameter problems:

- **Detail loss.** The surface has to sit on a uniform lattice, so anything finer than the lattice
  does not survive. On an 88 mm miniature at 0.8 mm voxels that is visible.
- **Debris.** Where the band thins, the march emits detached pieces. Measured on a damaged export:
  559 components against 302 in the input, which is what a user sees as floating bits.

A label per cell has neither. The decomposition follows where the model's own points are, so nothing
is coarser than the input, and the boundary between two labels is closed by construction, so there is
nothing to detach. That is the whole argument, and it does not need anyone else's implementation to
be true.

## Measured

On `poussin.stl`, 170,790 triangles and clean:

| | value |
|---|---|
| welded points | 85,395 |
| tetrahedra | 596,374 |
| inside | 310,140 |
| output triangles | 172,512 (+1.0%) |
| volume | -0.011% |
| non-manifold / boundary / loops / winding | 0 / 0 / 0 / 0 |
| components | 1 |
| watertight, fully repaired | yes |
| runtime | 20 s |

Compare the voxel mode, which resamples onto a lattice at a chosen resolution and cannot make that
claim about volume or detail.

## The cost that is not yet paid

**Every tetrahedron is labelled by the winding number at its own centroid.** That is unambiguous for
a cell well inside or well outside, and not for one the surface passes through: those read close to
one half and the decision is a guess.

Resolving them properly is a labelling problem with two terms: a **data cost** per cell from the
winding number, and a **smoothness cost** on shared faces that is a metric, so the labelling can be
solved as a minimum cut. No Rust implementation of that solver exists; a Boykov-Kolmogorov-style
max-flow is the piece to write.

It cannot be sized without a **damaged** file. On a clean model almost every cell is unambiguous, so
the ambiguous count there is near zero and the graph cut would look worthless. The mode exists for
damaged input, so that is where it has to be measured.

## Open items

- The graph cut, above.
- The decomposition is unconstrained, so it follows the point set. Whether that is enough on a soup
  whose points are dense and uneven is a measurement nobody has taken yet.

## Related

- `../../docs/dev/shrink-wrap.md` — both surfacing modes, their public surface and parameters
- `repair-engine-wrap-plan.md` — the outer-surface wrap, which needs the same inside test
