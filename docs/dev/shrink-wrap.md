# ShrinkWrap

ShrinkWrap resamples a mesh into a closed one. It is the escape hatch for input whose topology
cannot be repaired: a mesh with a frustrated winding seam, a hollowed model whose interior has been
turned inside out, or anything else where every pass in
[the repair pipeline](mesh-repair-passes.md) has to refuse rather than damage the object.

**It resamples.** The result bears no relation to the input's vertex count, triangle count or exact
geometry beyond its overall shape. That is the point — it is the only way to guarantee a closed
result on input whose topology cannot be fixed — and it is why it is never part of `repair()`.

The reference engine has the same shape: its `ShrinkWrap::run` is a separate command with its own
dialog parameters, and its automatic repair path never calls it.

## The public surface

| item | what it is |
| --- | --- |
| `shrink_wrap(mesh, options)` | the entry point, in `dragonfruit_mesh_repair::shrink_wrap` |
| `ShrinkWrapOptions` | `voxel_mm`, `gap_fill_mm`, `thickness_mm`, `max_triangles` |
| `ShrinkWrapOutcome` | the wrapped `mesh` plus a `ShrinkWrapReport` |
| `ShrinkWrapReport` | input, isosurface and output triangle counts, voxel size, offset, band size, elapsed milliseconds |
| `mesh_shrinkwrap_staged(options_json)` | the Tauri command. Resamples the staged mesh, replaces the staging buffer with the result and returns the report. It remains registered and callable; the app no longer reaches it, since the entry that did was removed. |

In the app it is the **Remesh** entry in the repair flyout on the Editor menu. It is enabled only
with an active model, and it asks for confirmation first, because the consequence is the whole
surface rather than a repair of it. The defaults there are the ones measured on a ~600k-triangle
model: `voxel_mm` 0.8 with `max_triangles` 600,000, which lands within a fraction of a percent of
the input triangle count while closing the surface.


The CLI exposes it as its own subcommand rather than a flag on `repair`, so that asking for it is a
deliberate act:

```
dragonfruit-mesh-repair shrinkwrap model.stl --voxel-mm 0.1 --gap-fill-mm 0.1 \
    --max-triangles 2000000 --out-stl wrapped.stl
```

## How it works

1. **Sample a signed distance field** in a narrow band: only lattice points within a few voxels of a
   triangle are stored, so memory is proportional to surface area over voxel size rather than to
   the bounding box volume. A dense grid at 0.05 mm on a 50 mm model is 10⁹ cells; the band is a
   few million. The sign comes from the nearest triangle's own normal, not from a parity ray cast,
   because parity is meaningless on the open and mis-oriented input this exists for.
2. **March tetrahedra** through the field at the requested offset, six per cell, interpolating each
   crossing. This is what puts the surface *between* lattice points.
3. **Smooth** lightly with Taubin, which removes the lattice ripple without the volume loss a plain
   Laplacian would cause.
4. **Simplify** to the caller's triangle budget. This is not an optimisation: at 0.05 mm the
   isosurface is tens of millions of triangles, and the budget is what makes the resolution usable.
   The reference engine's ShrinkWrap pulls a simplifier for the same reason.
5. **Close** the small openings the offset leaves where the model is thinner than it, and again
   after simplification, which collapses edges across them.

## The parameters

| option | what it does |
| --- | --- |
| `voxel_mm` | the resolution. Detail finer than this does not survive, and the surface error is a fraction of it. Smaller costs memory and time linearly in the band. |
| `gap_fill_mm` | push the surface out by this much before extracting, which is what closes gaps: two sheets of a hole up to twice this wide meet and merge. Costs that much inflation. |
| `thickness_mm` | push it out by this much more. Additive with `gap_fill_mm`; kept separate because the reference dialog has both. |
| `max_triangles` | simplify to at most this. Zero keeps all of it. |

**Offsets are the fidelity knob.** At 0.1 mm a one-voxel fill moves the surface a tenth of a
millimetre; at 0.05 mm, half that. That is why the reference's 0.05–0.1 mm range looks like the
original and a coarser one does not.

Measured on the V3 Cones, which cannot be repaired locally at all — 4 winding edges that no
assignment of face orientations resolves. Input 1,383,426 triangles, volume 2,713:

| resolution | offset | output triangles | volume delta |
| --- | --- | --- | --- |
| 0.1 mm | 0.1 mm | 1,999,658 (budget 2M) | **+16.3%** |
| 0.2 mm | 0.1 mm | 1,284,188 (no budget) | +16.6% |
| 0.3 mm, occupancy grid | 1 voxel | 132,160 | **+83.5%** |

The last row is the previous implementation — an occupancy grid with voxel faces drawn on it — and
the comparison is the point: at a *coarser* resolution it inflated five times as much, because its
surface could only sit on voxel boundaries, a whole voxel away from the input, and it could not
interpolate.

**It is not dimensionally faithful.** The wrap closes a mesh and moves its surface by roughly the
offset. On a calibration part whose dimensions are the point, that matters — the cones are still
16% fat at 0.1 mm. It repairs the topology, not the measurements.

## Constraints

- **Never called from `repair()`.** It is a separate function, a separate CLI subcommand, and a
  caller has to name it. A repair that silently resampled would destroy geometry a caller never
  agreed to lose.
- **The band has to reach past the isosurface.** Extracting at an offset of *n* voxels puts the
  surface *n* voxels off the mesh; a band that stops short does not contain its own crossing and
  the result fragments. Measured with a half-millimetre fill at a tenth-millimetre voxel: eight
  components where there should have been one.
- **The interpolation starts from a canonical end of each lattice edge.** Several tetrahedra reach
  the same edge from either end, and computing the parameter from a different end gives a point
  that differs in the last bits — which the weld then fails to merge, leaving the surface open.
- **Orientation is by propagation, not by the triangle's own normal.** The normal is numerically
  unstable on the slivers an isosurface makes, and 2,400 edges came out inconsistent on a cube.
- **It does not use `repair_orientation`.** That pass refuses when the volume moves more than one
  percent, which is the right guard for a repair that might invert a solid and the wrong one here:
  correcting a winding *is* a volume correction. It reverted the fix and left the 2,400 edges; an
  independent propagation settles the same surface to zero.

## The second mode: tetrahedral surfacing

Beside ShrinkWrap there is a second way to rebuild a surface, and it is the one to reach for when
fine detail matters. Where ShrinkWrap resamples onto a **uniform lattice** — which is what loses
detail and, where the band thins, emits detached pieces — tetrahedral surfacing decomposes the
model into tetrahedra and keeps the boundary between the inside and outside cells. The decomposition
follows the model's own points, so nothing is coarser than the input, and the boundary between two
labels is closed by construction, so there is nothing to detach.

It is a separate mode, not a setting on ShrinkWrap: a lattice and a decomposition are unrelated
results, and a user choosing between them needs to know which one they asked for.

### The public surface

| item | what it is |
| --- | --- |
| `tet_surface(mesh, options)` | the entry point, in `dragonfruit_mesh_repair::tet_wrap` |
| `tet_surface_with_progress(mesh, options, sink)` | the same run, announcing each phase; `tet_surface` is a thin wrapper over it |
| `TetWrapOptions` | `switches`, `max_triangles`, `tolerance` |
| `TetWrapOutcome` | the rebuilt `mesh` plus a `TetWrapReport` |
| `TetWrapReport` | input and output triangle counts, decomposition size, inside-cell count, per-phase milliseconds, and `cancelled` |
| `mesh_tet_surface_staged(options_json)` | the Tauri command. Resamples the staged mesh, replaces the staging buffer with the result and returns the report. |
| `tetSurfaceFromGeometry(geometry, options)` | the frontend entry, in `src/utils/meshShrinkwrap.ts`. Stages the geometry, calls the command and reads the new positions back. |
| `tetSurfaceModelInPlace(modelId, options)` | the scene action. Swaps the rebuilt geometry in, records one undo step and reports the triangle counts. |

In the app it is the **Remesh** entry in the repair flyout on the Editor menu. It is
enabled only with an active model, and it asks for confirmation first, because the consequence is the
whole surface rather than a repair of it. Its progress runs in its own dialog, on its three phases,
and its Stop stops the run at a phase boundary.

The lattice mode above is no longer reachable from the app. It remains a native pass and its own CLI
subcommand, `shrinkwrap`, and a caller has to name it. It left the menu because a lattice loses fine
detail to its voxel size, which the decomposition does not, so offering both asked the user to
choose between a resample and a better resample.

The CLI exposes it as its own subcommand, `tetwrap`, for the same reason `shrinkwrap` is not a flag
on `repair`:

```
dragonfruit-mesh-repair tetwrap model.stl --switches pQ --tolerance 0 --out-stl surfaced.stl
```

### The phases

`tet_surface_with_progress` announces three phases, in order, each a cancellation point:

1. **`tetrahedralize`** — prepare the input, then decompose it. Preparation is: weld exact
   coincident corners; merge the nearly-coincident ones that a soup leaves behind when it computes
   the same corner from two places and floating point rounds the copies apart; drop triangles with no
   area; drop pairs of triangles that share three vertices and wind opposite ways, which are
   zero-depth sheets and enclose nothing; correct the winding; and simplify the input by
   `tolerance_mm` so the cell size follows the shape rather than the export's density. The
   decomposition is then **constrained**: the input's triangles are handed to TetGen as a piecewise
   linear complex (`-p`), so the decomposition is required to contain them.
2. **`label`** — decide inside from outside by the winding number at each tetrahedron's own
   centroid.
3. **`extract`** — walk the tetrahedra's faces and keep the ones between an inside and an outside
   cell, wound as the inside cell has them so the result faces outward.

`TetWrapOptions::max_triangles` simplifies the extracted surface when it exceeds the budget; it runs
after the third phase and is not itself a cancellation point.

### Measured

On `poussin.stl`, a clean 170,790-triangle model, the constrained decomposition that made the
difference: 170,909 triangles out from 170,790, on 323,632 tetrahedra against the 596,374 a
point-only decomposition produced, in about 20 seconds.

The unconstrained form, on the same file: 172,512 triangles out (**+1.0%**), volume
**−0.011%**, one component, watertight, `fully_repaired: true`, and no non-manifold, boundary, loop
or winding defects, in about 20 seconds.

It is still a resample, so the same caveat as ShrinkWrap applies: the surface is rebuilt and its
triangles are new. But it does not move the surface by a voxel the way the lattice does — the
decomposition follows the input, so there is no resolution floor separating it from the original.

## Cavities

A cavity is a closed shell inside the material. A hollowed model has them on purpose and a damaged
one can have them by accident, so they are **reported** before anything removes them: the choice
between a hollow model and a solid one is the caller's.

| item | what it is |
| --- | --- |
| `scan_cavities(mesh)` | `dragonfruit_mesh_repair::repair::scan_cavities`, returning `CavityScan` |
| `remove_cavities(mesh, include_broken)` | delete them, returning the triangle count removed |
| `CavityScan` | `components`, `broken_components`, `triangles`, `volume` |
| `drop_zero_depth_sheets(triangles)` | delete pairs of triangles sharing three vertices and winding opposite ways |

```
dragonfruit-mesh-repair cavities model.stl --pretty
dragonfruit-mesh-repair solidify model.stl --include-broken --out-stl solid.stl
```

Two kinds are reported. A **cavity** is a closed component whose faces are almost all interior to
another component — the same rule the repair pipeline's own cull uses, so what is reported is what
it would remove. A **broken** cavity is one that is mostly interior but *not* closed, which is what
a cavity breaking through the outer wall leaves behind.

Removing one removes surface, not material: a cavity encloses nothing, so deleting it leaves the
outer shell, solid except where the cavity broke through it. Closing that is the resampler's job,
which may invent geometry; repair keeps refusing such a model.

Known limit: this classifies by **component**, so it sees a cavity only when the cavity is a
component of its own. On `corbu-chibi-corrboo45.stl` the inner shell shares edges with the wall it
broke through, making the two one component, and the scan reports only fragments — 13 triangles of
1.016 million. Separating that case needs a per-face test, distinguishing air that is enclosed
(cavity) from air that is unbounded (outside), rather than a component test.

### Smoothing the resolve costs two passes and buys nothing measured

Taubin smoothing moves the vertices of the resolve's own triangulation, and a rebuild that is only a
resolve comes out of it with fold lines across flat regions and starbursts at the pocket rims that are
not there without it. The numbers do not see it: that bottom's median aspect is 4.60 with two passes
and 4.78 without. The render does. It also costs two passes over the mesh, 18.6 s against 16.5 s on
`Gusano_de_Dune_70%.stl`, so the default is zero and a caller that wants it can ask.

Two limits on that, both measured. It is not the whole artefact: the mesh the app shows goes through
the repair pipeline after the rebuild, and repairing a clean, unsmoothed rebuild re-creates the folds
with only 2,006 faces changed, so the repair's own passes are the larger source and are still to be
tracked down, one stage at a time. And the stair-steps this was written for belong to a lattice-ish
input, which is what [`crate::shrink_wrap`] produces, not to a resolve.

### The resolve works at the model's own scale

Manifold's default tolerance is an absolute 1.2e-5 whatever the model is, and on a presupported plate
whose median edge is 0.46 mm that asks it to keep geometry two millionths of an edge apart. What came
back was the crossing soup re-triangulated at a scale nothing in the model shared: on
`Gusano_de_Dune_70%.stl`, shard shells ringing every pocket in the underside, 302 shells going in and
960 coming out. The tolerance is now a fraction of the mesh's own median edge (see
`resolve_tolerance`), which is the scale the rest of the engine works at. Measured over that file's
underside: 1.2e-5 and 1e-5 both star every pocket, 1e-4 and coarser are clean, and 1e-4 keeps the most
detail at 499,168 triangles against the 603,772 the default produced.

The resolve also triangulates a flat region as one polygon, so a plate's whole underside came back as
a fan of needles bridging its pockets, and `as_original` cannot help: on a round trip there is no
operand for the provenance to point at, and the construction is what re-triangulated. The rebuild
therefore ends with the loader's own refinement ([`crate::io::refine_coarse_faces`]), at its
threshold and budget, so it hands back a surface at the density a read would have given it. Measured
over that file's base, faces within 1 mm of the bottom:

| base | faces | median edge | p99 | longest |
| --- | --- | --- | --- | --- |
| the input | 13,078 | 0.536 mm | 3.011 mm | 3.155 mm |
| the resolve alone | 7,717 | 0.309 mm | 14.563 mm | 27.028 mm |
| the resolve plus the refinement | 15,131 | 0.580 mm | 3.031 mm | 3.151 mm |

## The third mode: surface to solid

This mode is neither a resampler nor a decomposition. It closes what is open, resolves the mesh into
a solid with a boolean of the mesh with itself, and drops the scrap shells the boolean leaves. A
boolean of a mesh with itself reconciles it: the result is retriangulated, coincident and
self-intersecting geometry is resolved, and boundaries are gone. That is what moves the surface.
[`crate::tet_wrap`] conforms a decomposition to the input's own triangles, so it returns the input's
surface; this returns a *resolved* one.

The four steps, in order:

```text
scan for open edges
close them
boolean the mesh with itself
drop the shells small enough to be scrap
```

| item | what it is |
| --- | --- |
| `solid_remesh(mesh, options)` | the entry point, in `dragonfruit_mesh_repair::solid_remesh` |
| `solid_remesh_with_progress(mesh, options, sink)` | the same run, announcing each phase |
| `SolidRemeshOptions` | `fill_holes_max_edges`, `remove_noise_shells`, `tolerance` |
| `SolidRemeshReport` | input and output triangle counts, shells before and after, holes filled, `non_manifold_resolved`, `declined`, `ms`, `cancelled` |
| `mesh_solid_remesh_staged(options_json, progress_token)` | the Tauri command. Rebuilds the staged mesh and returns the report |
| `solidRemeshStagedMesh(invoke, options, token)` | the bridge call, in `src/utils/tauriMeshBridge.ts` |
| `solidRemeshFromGeometry(geometry, options, sink)` | the frontend entry, in `src/utils/meshShrinkwrap.ts` |
| `solidRemeshModelInPlace(modelId, options, sink)` | the scene action. Swaps the rebuilt geometry in, records one undo step and reports the triangle counts |

```
dragonfruit-mesh-repair solid-remesh model.stl --out-stl solid.stl
```

In the app it is the **Shrink-Wrap** entry in the repair flyout, beside **Remesh**. Both are whole
surface replacements and both ask for confirmation first. Its progress runs in the same dialog as
Remesh, on its own four phases, with its own accent so the two are not confused mid-run.

The phases are `prepare` (weld, merge near-coincident vertices, correct winding, split pinches),
`simplify` (drop the triangles `tolerance` allows), `fill` (cap every boundary loop), `solid` (the
boolean), and `shells` (drop scrap shells) — the reference's own order, with its simplification in
the same place.

### Measured

On `poussin.stl`, a clean closed model, 170,790 triangles in:

| `tolerance` | triangles out | reduction |
| --- | --- | --- |
| 0 | 170,790 | none |
| 0.0001 | 167,210 | 2% |
| 0.0005 | 159,270 | 7% |
| **0.001** (default) | **123,558** | **28%** |
| 0.002 | 48,824 | 71% |
| 0.005 | 11,854 | 93% |
| 0.05 | 190 | 99.9%, destroyed |

One shell before and after, no holes filled, 1.5 seconds at the default.

Two things follow from that table, and both are load-bearing.

**The `tolerance` is not a percentage of anything intuitive.** It is `meshopt`'s relative error, and
the value in a reference implementation's dialog is not this quantity: 0.05 of *theirs* is a light
pass and 0.05 of *this* leaves 190 triangles of 170,790. The default here is 0.001 because it is a
reduction a person can see without the model being gone.

**Without the simplification this mode is a no-op.** A boolean of a mesh with itself is idempotent
and the manifold round trip preserves a clean mesh's triangulation, so at `tolerance = 0` the surface
comes back exactly as it went in. The simplification is the whole of what "shrink-wrap" does to a
clean model, which is why it is a phase of this mode and not of the tetrahedral one: collapsing a
surface folds it, and a boolean is what resolves a folded one. The tetrahedral mode constrains the
model's own facets, so it defaults to leaving them alone.

### Constraints

- **A resolved surface is not a repair.** Like the other two modes it is never a stage of
  `repair()`, and a caller names it.
- **Declining returns the input, not an empty mesh.** `SolidRemeshReport::declined` carries the
  reason. A caller that asked about a model must still have that model afterwards.
- **`fill_holes_max_edges` counts down, not up.** The pass reads zero as "no loop qualifies", not as
  "no cap", so filling every loop is `usize::MAX` and that is the default.
- **The boolean is tried first, and the harder preparation is a retry.** A boolean will only take a
  surface where every edge carries two faces, and a mesh with thousands of non-manifold edges is the
  mesh this mode most needs. So the run attempts the boolean on the prepared surface, and only when it
  refuses does it separate the shared edges and retry. On a file the boolean accepts, the separation is
  never run and the cost is nothing: `non_manifold_resolved` stays zero.

  Measured on a 596,293-triangle supported model that the mode used to decline outright:

  | step | non-manifold edges |
  | --- | --- |
  | as prepared | 3,288 |
  | after one separation round | 144 |
  | after two | 94 (the split stalls; the edges left are ones where more than two surfaces meet through a single vertex) |
  | after excising the remainder | 0 |
  | the rebuilt surface | 0, watertight, 0 loops |

  8,020 vertices were split and 808 loops closed. The result is 307,258 triangles from 596,293, and it
  is a *different object*: the separation and the rebuild move the surface, the volume rises about 20%
  and the shell count rises. That is what a last-resort rebuild costs, and it is why this is a mode a
  caller names rather than a stage of `repair()`.
- **The excise rung is the last one, and it is not a repair.** It runs only when the separation
  stalls, and only here, because the boolean is what judges the result. In `repair()` the same
  function is kept behind the five-class acceptance test, which this mode does not have.

### Constraints

- **Never called from `repair()` on its own.** `remove_cavities` is available to a caller, and
  `solidify` is a subcommand; the pipeline's own cull keeps its closed-component rule.
- **Never called from `repair()`.** Like ShrinkWrap, it is a separate function, a separate CLI
  subcommand, and a caller has to name it.
- **The inside decision is a plain winding number per centroid, not an optimal cut.** It is
  unambiguous for a cell well inside or well outside but not for one the surface passes through;
  resolving those optimally is the next step.
- **`-d` is not used, and it is the switch that sounds right.** TetGen's `-d` detects intersections
  between PLC facets and splits them, which is the remedy for the soup this path is for. It also
  produces no decomposition at all on a clean model, so the constrained path takes input whose
  facets are compatible and refuses the rest. `corbu-chibi-corrboo45.stl` is refused for exactly
  that reason, and its facets genuinely intersect.
- **Constraining needs compatibility, and compatibility is the whole difficulty.** The comparison
  above is why the constraint is worth having; the refusal on corbu is why a point-only
  decomposition is still reachable.
- **A cancelled run returns the input unchanged.** A half-built decomposition shares nothing with
  the input, so there is no meaningful halfway result; `TetWrapReport::cancelled` marks the case.

## Related pages

- [Mesh repair passes](mesh-repair-passes.md) — the local passes, and why they refuse on this input
- [Mesh wire formats](mesh-wire-formats.md) — the payloads this reads and writes
