# DragonFruit

DragonFruit is a desktop slicer (Tauri + Rust) for resin 3D printers: mesh repair, support generation, and layer rasterization/encoding to a range of printer-specific output formats via a plugin system.

## Language

### Supports

Definitions live in **[`docs/reference/support-anatomy/`](docs/reference/support-anatomy/index.md)** — one page per piece, with geometry, behaviour and constraints. Don't restate them here. What follows is only what a glossary adds on top: the distinctions people get wrong in prose, and the places the code spells a term differently.

**primitive** vs **support type**:
Primitives are the reusable geometry pieces every support is assembled from (Roots, shaft, joint, knot, contact cone, contact disk). Support types are the named things a user places (trunk, branch, brace, kickstand, leaf, twig, stick, anchor). A type is a legal arrangement of primitives, not a subclass — the same shaft and joint appear in most of them. In code the line is drawn by `extends SupportEntity` in `src/supports/types.ts`: types do, primitives don't — `Knot` is a plain interface.
_Avoid_: element, part, component (all three get used for either level, which is what makes support discussions drift)

**knot** vs **joint**:
Same sphere on screen, opposite rule. A **joint** is a break *within* one support so its own shaft segments can change angle with the endpoints anchored. A **knot** attaches one support *to another support's shaft*, and slides only along that host's axis. Confusing the two is the most common vocabulary error in this subsystem.
_Avoid_: using either name for the other; node, hinge, elbow, attachment ball

**brace** vs **kickstand**:
Both connect support to support. A **brace** is ungrounded — a shaft with a knot at each end, touching neither model nor build surface. A **kickstand** starts at Roots on the plate or raft and ends in a knot on a host shaft. The grounding is the entire distinction.
_Avoid_: strut, tie, diagonal, prop

**twig** vs **stick**:
Both span model to model. A **twig** is one continuous body between two contacts; a **stick** has two branched sides meeting at a central joint hub, for longer spans. The placement preview switches between them by distance, so they are neighbours, not synonyms.
_Avoid_: bridge, span, Y-support

**contact cone** vs **contact disk**:
Not two spellings of one thing. The **contact cone** is the tapered terminal on trunks, branches and leaves — and on sticks, which carry two. The **contact disk** (`ContactDisk`, "the nib") is a flat standoff pad, and **twigs are the only type that uses it**. Overloaded on purpose in the code: `ContactDiskProfile` is also a tip shape a cone can wear, so read which sense is meant.
_Avoid_: calling either one "the tip" (the tip is only the small contact face at a cone's end)

**Roots**:
The grounded base of a trunk, and never anything else's base — a branch's base is a knot, a kickstand's is Roots. Roots do **not** include the shaft above them; that is the trunk.
_Avoid_: base, foot, pad (their generic use is exactly the collision)

**anchor**:
A support type in its own right, not a synonym for anything: a minimal near-plate support for contact points below 5 mm that bypasses the grid system entirely, built as frustum root → joint → one segment → contact cone. Branches, leaves and braces cannot target it. Beware the collision: the doc comment on the unrelated `Knot` interface reads "Knot (Anchor)", so the word names two different things in the same file.
_Avoid_: knot (a knot is a primitive that attaches supports to a shaft; an anchor is a placeable support)

**doc term → code identifier**:
The code predates parts of this vocabulary and has not caught up. When grepping, expect: shaft → `'segment'`; Roots → `'root'`, singular; contact disk → `contactDisk`. Selection and hover categories are unions in `src/supports/types.ts`. Most entity interfaces live there, but `Kickstand` lives in `src/supports/SupportTypes/Kickstand/types.ts`.
_Avoid_: renaming these in passing — they are persisted in scenes and matched by string.

### Slicing and 3DAA

**3DAA**:
DragonFruit's vertical (Z-axis) antialiasing mode for resin printing. Instead of supersampling within a single layer's XY plane, it perturbs/samples across multiple Z heights per printed layer and blends the results, trading extra per-layer compute for smoother stair-stepping on sloped surfaces. Implemented in `rust/dragonfruit-slicing-engine/src/zaa.rs` and the post-processing stages of `engine.rs`.
_Avoid_: vertical AA, Z-AA (used interchangeably in code/config, but "3DAA" is the name used in the UI and in most discussion)

**look_back**:
The number of already-processed layers a 3DAA job keeps resident for cross-layer (Z-axis) blending — the backward half of the sliding window. Configured per-job via `SliceJobV3.z_blend_look_back`.
_Avoid_: history depth, backward window

**post_buffer_depth**:
The number of layers 3DAA's post-processing stage (Z-blend, LUT, support merge) is allowed to hold in flight at once, chosen automatically from resolution and core count in `choose_3daa_post_buffer_depth`. The forward half of the sliding window, paired with `look_back`.
_Avoid_: lookahead depth, worker count (it bounds in-flight layers, not thread count)

**sliding window** (3DAA pipeline):
The pattern used throughout 3DAA raster/post-processing: only `look_back` + `post_buffer_depth` layers are ever resident at once, instead of materializing every layer of a job simultaneously. A queue or buffer that looks like a sliding window in the code isn't necessarily one in practice — see [ADR-0036](docs/adr/0036-stream-ctb-layer-payloads-to-disk.md) for a case where backpressure didn't actually propagate end-to-end.
_Avoid_: streaming (too generic — most of the pipeline "streams" data through; a sliding window is specifically what bounds peak memory)

**seam**:
The curve the user draws across a model's skin to say where a contour cut should run. Traced as a geodesic through their waypoints, so it lies ON the surface rather than near it — which everything downstream depends on. A cut can carry several, and a piece held by two of them only comes free when both are cutting at once.
_Avoid_: loop (the loop is the user's waypoints; the seam is the curve traced through them), cut line, path

**membrane**:
The soap-film surface spanned across a seam — a minimal surface, relaxed so it bows to follow the seam's contour instead of cutting flat across it. It is the cut surface itself, which is why a contour cut can never reach outside the seam the user drew.
_Avoid_: cutter (the wafer is a cutter; the membrane is a surface), cut plane, patch

**surface cut**:
The contour cut proper: cut the skin along the seam until the seam IS mesh edges, flood-fill each side over the face graph, and close each piece with the membrane. No cutter and no material removed. See [ADR-0037](docs/adr/0037-cut-the-surface-not-a-volume.md).
_Avoid_: mesh cut, edge split, topological cut

**wafer**:
The older contour cutter: the membrane thickened into a razor-thin slab and differenced out of the model with a boolean. Kept only as the fallback behind the surface cut, for skin a flood fill would leak through. Its thickness is its own business now — not a setting.
_Avoid_: slab (the slab is the wafer's geometry; the wafer is the strategy), knife, blade

**cap**:
The lid that closes one piece of a surface cut into a solid: the membrane sewn to the cut's own chain of edges, vertex for vertex. The two pieces either side of a seam get the same cap triangles with the winding reversed, so they mate exactly.
_Avoid_: lid, cut face (the cut face is what the user sees; the cap is the geometry that makes it), seal

**rim**:
The closed chain of edges bounding one piece's cap — read off the cut as the edges whose two faces landed in different pieces. Not a polyline resembling the seam: the same vertices, or the piece would not close.
_Avoid_: boundary, border, ring (used loosely in code for any cycle of vertices)

**piece**:
What the surface falls into once the seam is a wall — the unit the cut hands back, one closed solid each. Not the same as a connected solid: a U-shaped part cut by a plane is one solid with two cut faces. Loose shells the model already carried are pieces too, and ride along with the body rather than being handed over as freed.
_Avoid_: part (fine in the UI; ambiguous in code, where `part_a`/`part_b` are the two sides of one seam), component, island

**tenon** / **mortise**:
The registration joint a cut can place so the halves line up when reassembled: the **tenon** is the solid peg unioned onto one piece, the **mortise** the matching cavity carved from the other. Two degrees of freedom only — `lean` (angle to the cut face's normal) and `roll` (which turns the peg and its lean plane together). Anchored on the cut face of the piece it stands on, never on a surface between the halves — which is what makes a joint clearance free: the base is already inside its own material at any gap, so the peg simply crosses the gap and the mortise is carved wherever it lands. Nothing sinks, nothing stretches.
_Avoid_: key (a key is the pin that stops a joint opening, and there isn't one here), peg + socket, pin, dowel

**joint clearance**:
The gap left between the two halves so glue has somewhere to go and the assembled model doesn't come out fatter than it started. Zero by default. Cut, not measured out afterwards: the surface cut's halves share their cut face, so the gap is made by cutting along the seam moved BOTH ways — half the clearance each — and discarding the strip of skin between. Optional and never structural: the cut works the same at any value, which is what separates it from the wafer thickness it replaced.
_Avoid_: kerf, cut thickness, wafer thickness (all three named a cutter whose size decided whether the cut worked at all), tolerance (the tenon's own fit allowance, a separate number and a different job)

**strip**:
The band of skin between a seam's two offsets — the material a joint clearance is made of, discarded once the cut is done. Recognised structurally, not by measuring: a seam cut with a clearance leaves two caps, and the piece they both face is the strip.
_Avoid_: kerf (what the strip replaces, but a kerf was what a cutter removed and this is what the cut chooses to drop), band, waste, offcut
