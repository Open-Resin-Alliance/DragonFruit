# dragonfruit-tetgen

TetGen, vendored, behind a small safe surface. It exists for one job: producing the tetrahedral
decomposition the tetrahedral surfacing mode is built on. See
`../../docs/internal/tetrahedral-surfacing.md`.

## Provenance

The files in `vendor/` are TetGen, unmodified, taken from the primary development repository at
<https://codeberg.org/TetGen/TetGen> on branch `main`:

| file | what it is |
| --- | --- |
| `tetgen.cxx` | the mesher |
| `tetgen.h` | its header, including the `tetgenio` type the shim drives |
| `predicates.cxx` | Shewchuk's exact geometric predicates |
| `LICENSE` | TetGen's own licence |
| `README.md` | TetGen's own readme |

Nothing in `vendor/` is edited. Anything we need on top of it lives in `src/shim.cpp`, so a future
version bump is a file replacement rather than a merge.

## Licence

TetGen is **AGPL-3.0**, and this repository is **AGPL-3.0**, so the two are compatible and the
vendored copy can ship. The crates that declare MIT are components inside an AGPL work, which is
fine; what matters is the work as a whole, and the whole is AGPL.

If the application is ever relicensed away from AGPL, **this crate is the blocker**: it would need a
commercial TetGen licence or a different tetrahedraliser. Nothing else in the tree has that property,
so this is the one place to look.

## Why a vendored copy rather than a bindings crate

The available bindings crates do not vendor the source: `tritet`'s `with_tetgen` feature gates
bindings and "does not enable additional features", so it still expects TetGen to be provided. TetGen
is three translation units and a header, and builds as a library with one define, which makes
vendoring it simpler than reproducing a build someone else already has to get right.

## Why the point-set mode

`tetrahedralize_points` calls TetGen without facet constraints, so it builds the Delaunay
tetrahedralisation of the model's points rather than a conforming mesh of its triangles.

That is deliberate. A damaged export is a triangle soup with self-intersecting and non-manifold
facets, and a facet-constrained tetrahedralisation rejects exactly that input. The reference engine
adds virtual constraints to make such a soup admissible; deciding inside from outside by winding
number afterwards is the cheaper route to the same end, and it keeps the decomposition adaptive to
where the model's own points are, so there is no resolution to choose.

## Related

- `../../docs/internal/tetrahedral-surfacing.md` — the mode this serves, and its measurements
- `../dragonfruit-mesh-core/src/winding.rs` — the inside test that replaces facet constraints
