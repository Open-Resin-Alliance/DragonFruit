# Island Volume Identification: Flat Cutoffs, Merge Hierarchy, and Logical Volumes (Summary)

This document captures the key insights and conclusions from a brainstorming session about **logically identifying island volumes** for MSLA resin printing support generation.

The goal here is **not** to design the final auto-support placement rules yet. The goal is to build a reliable first-stage analysis that produces **useful, human-logical volumes and relationships** that later support logic can reason about.

---

## 0) What This Document Now Includes (Concrete)

In addition to the conceptual discussion, this document includes a practical outline of:

- What an “island” is in this context
- What data representation to use at analysis resolution
- How islands/volumes are created, continued, ended
- How merges and splits are handled (including edge cases)
- What to record per island node so later support logic can use it

---

## 1) Problem Statement

When analyzing a model along the print direction (Z), we can detect **leaf islands** (e.g., fingertips, toes, sleeve tips) as regions that appear “unsupported” until they connect to other geometry.

A naive island-volume definition often produces **flat cutoffs**:

- An island volume is tracked until the Z-layer where it first merges with something else.
- At the merge layer, the island is terminated.
- This creates an unnatural planar boundary (a horizontal cut) exactly where a human would still consider more of the anatomy/feature to be part of that appendage (e.g., finger → palm → arm; leg → hip region).

This becomes a blocker because later support logic needs **coherent logical regions** to estimate support need and choose placement/strength strategies.

---

## 2) Key Clarification: This is NOT “just rounding the merge plane”

A critical correction from the discussion:

- The objective is not merely to make the cutoff “look organic” by rounding the merge boundary.
- The objective is to build a **stable, human-logical decomposition** of a shape into meaningful volumetric units.

Examples of the intended interpretation:

- **Arm/leg/wings** should be recognized as major appendage systems that logically include their full subtree (fingers → hand → arm) and can justify including a meaningful attachment region (e.g., shoulder/hip).
- **Small details** (like an earlobe) must remain small and must not “claim” a large portion of the head/face simply because it connects there.

This means we need both:

- A correct structural representation of how components relate across layers.
- Strong guardrails against runaway “ownership” where small leaves expand into huge parent regions.

---

## 3) The Two Concepts That Must Be Separated

### A) Ownership / Segmentation (What belongs to what)

This is the partitioning of model volume into labeled regions (“this voxel/space belongs to node X”).

### B) Contribution / Aggregation (How lower parts contribute to higher-level support demand)

Even if a toe is a tiny leaf, supports under it can still “contribute” to the overall leg system via **hierarchical aggregation**, without the toe needing to own hip/pelvis volume.

This separation is essential to prevent the failure mode:

- “Tiny leaf islands start claiming huge surrounding volume”

while still allowing:

- “Bottom supports affect the stability requirements of larger parent systems.”

---

## 4) Why the “Parent/Child Attempt” Produced Weird Takeovers

A major insight:

> A volume should not persist through a merge as the same identity.

A common mistake is:

- Children terminate at a merge.
- Then one existing child ID is reused as the “parent” above the merge.

This creates the failure mode shown in the cone example:

- After the merge, a label (e.g., yellow) suddenly owns a large region above the junction that is spatially different.
- Downstream “support this volume” logic becomes nonsensical because the label is no longer a coherent part.

### Corrective interpretation

At a merge:

- The child volumes end.
- A **new parent volume node** begins above the merge representing the merged component.

This prevents one child identity from inheriting unrelated mass above the junction.

---

## 5) The Core Structural Rule (Prevents Most Weirdness)

### Event-based volumes: “Segments between topology events”

When slicing along Z, component relationships change at **events**:

- Birth: new component appears
- Merge: many-to-one
- Split: one-to-many (can happen)
- Death: component disappears

**Core invariant:**

- A volume can continue upward only while the mapping is **1-to-1** across adjacent layers.
- If the mapping becomes many-to-one (merge) or one-to-many (split), terminate the existing volume(s) and start new node(s).

This ensures identities remain coherent and prevents the “odd, hard-to-explain” takeovers.

---

## 6) Build a Full Merge Hierarchy (Not Just Leaf Islands)

Current state described:

- Leaf islands are detected.
- Parent/child hierarchy is incomplete or unstable.

Recommended conceptual structure:

- Create a **node at every merge** (not just leaves).

Example:

- Fingertips (leaves)
- Merge into palm node
- Palm merges into arm node
- Arm merges into torso node

This produces meaningful mid-level volumes (“palm”, “arm”) that later support logic can reason about.

Important: the *logical appendage volume* is often the **union of a subtree** (arm = arm node + hand node + finger nodes), not a single leaf.

---

## 7) How to Include “Shoulder/Hip” Without Earlobe Explosions

Once the merge hierarchy is correct, the “include the shoulder/hip” requirement should be implemented as:

### Controlled attachment allocation at junctions

At a junction (arm→torso, leg→pelvis), allow the child system to include some nearby attachment mass, but only under constraints.

To prevent small leaves (earlobes) from claiming huge parent areas, the allocation must be bounded by a **prominence limiter**, such as:

- Persistence: how long (in layers/mm) the child existed independently before merging
- Relative cross-section at merge: child area / parent area
- Thickness ratio near junction

Outcome:

- Major appendages earn meaningful attachment zones (shoulder/hip).
 - Tiny details earn little or none.

---

## 8) Concrete Method: Analysis-Resolution Solid Representation

This problem can be solved using either:

### Option A) “2.5D Voxels” (Recommended Starting Point)

A stack of 2D solid layers (one per Z slice).

- You represent each layer as a 2D grid of inside/outside (binary), or inside/outside + coverage (subsampling).
- This is conceptually voxel-like, but you do not need full 3D voxel adjacency for the first phase.

Why this is practical:

- It matches how resin printing works (layered).
- Connected components per layer + overlap tracking is efficient.
- You can compress each layer with RLE or similar (which you already have experience with).

### Option B) True 3D Voxels / Distance Fields (Optional Later)

Full 3D grids or SDF-style fields can help with later “attachment zone” calculations, thickness, etc.

- Not required for creating a stable merge hierarchy.
- Useful if/when you want advanced junction allocation (shoulder/hip caps) based on thickness/persistence.

### Recommended Resolution Mindset

- Use **analysis resolution**, not printer resolution.
- Add **local refinement** only where the analysis is unstable (thin spikes, very small islands).

---

## 9) Workflow 1: Island Scan (Start-to-Finish)

This describes the procedural flow in plain terms, as if you clicked a **Scan** button in the app.

### Step 1 — Inputs and settings

The scan is driven by a small set of knobs:

- **Layer height** for the scan (often same as print layer height, e.g., 50µm, but can be coarser).
- **XY pixel size** for the scan grid (analysis resolution).
- **Connectivity** (4-way or 8-way) for deciding what counts as “connected” within a slice.
- Optional: **support buffer** (a small dilation amount) used when deciding whether a pixel is “supported by the layer below.”
- Optional: minimum island area threshold to ignore extremely tiny noise islands.

#### Recommended defaults & tuning notes

These are pragmatic starting points that can be tuned later based on speed and stability:

- **Connectivity (default: 8-way)**
  - Rationale: at analysis resolution, diagonals are typically “physically connected enough” for island purposes.
  - If you ever see accidental diagonal bridges (aliasing artifacts), it’s usually better to adjust scan resolution or apply light cleanup than to switch to 4-way.

- **XY scan pixel size (`px_mm`) (suggested starting point: ~0.03mm / 30µm)**
  - Rationale: small enough to catch thin features reliably, but still compressible with RLE and workable on typical hardware.
  - Practical tuning:
    - If scans are too slow on big models, increase `px_mm` (coarser).
    - If you miss thin islands or see flicker, decrease `px_mm` (finer) or add local refinement.

- **Support buffer / dilation between layers (recommended starting point: 3 pixels)**
  - Meaning: when deciding whether a pixel is supported by the layer below, allow a small XY neighborhood (up to 3 pixels) to count as support.
  - Rationale: it should be a *tolerance for sampling/aliasing*, not a physics parameter.
  - If it is too large, it can hide real islands.

- **Minimum overlap area threshold (separate from dilation; prevents accidental merges)**
  - Meaning: require at least a small number of overlapping pixels before treating two blobs as a true continuation/merge.
  - Suggested starting points:
    - **4 pixels** (sensitive)
    - **9 pixels** (more conservative)
  - Rationale: prevents “1-pixel touch” continuity/merges that make volumes feel wrong.

- **Minimum island threshold (recommended: pixel count, not mm²)**
  - Rationale: it’s intuitive (“ignore 1–N pixel specks”) and matches how you think about printer pixels.
  - Typical defaults:
    - **4 pixels (2×2)** if you only want to remove single-pixel noise.
    - **9 pixels (3×3)** if you want a stronger noise filter.
  - Important: the meaning of “N pixels” depends on the chosen `px_mm`, so it’s best to treat this threshold as “N pixels at the current scan resolution.”

### Step 2 — Determine the scan bounds

- Compute the XY bounds of the model (or the area you want to analyze).
- Choose a consistent grid origin and grid size so every layer aligns perfectly in XY.

### Step 3 — Slice the model into layers (Z = bottom to top)

For each Z layer from the build plate upward:

- Compute the 2D cross-section of the model at that Z.
- Rasterize that cross-section into a 2D grid mask:
  - Each cell is “solid” (inside model) or “empty.”

This produces a stack of per-layer 2D solid masks (the “2.5D slice stack”).

### Step 4 — Decide what is “unsupported” on this layer (the island mask)

Conceptually:

- A solid pixel on layer L is **supported** if there is solid geometry directly below it on layer L-1 (optionally with a small buffer/dilation to account for slight shifts and diagonal growth).
- A solid pixel on layer L is **unsupported** if it does not have supporting overlap on layer L-1.

The unsupported pixels form the per-layer **island mask**.

### Step 5 — Find connected components in the current layer

On the layer’s island mask (or on the full solid mask, depending on what you want to track), compute **connected components**:

- Each connected blob becomes a “layer component.”
- Record basic per-component stats (area, centroid sums).

### Step 6 — Propagate island identities from the previous layer

This is the core “island tracking” step.

For each current layer component, ask:

- Which island IDs from layer L-1 overlap this component?

Then apply these rules:

- **Rule A: No overlap**
  - If a component overlaps no prior island, it starts a **new island node**.
- **Rule B: Exactly one overlap**
  - If it overlaps exactly one island, it is a **continuation** of that island node.
- **Rule C: Multiple overlaps**
  - If it overlaps 2+ islands, it is a **merge event**.
  - The correct behavior for stable logical volumes is:
    - End the incoming islands at layer L-1.
    - Create a **new node above the merge** starting at layer L.
    - Record parent/child relationships: incoming nodes are children of the new node.

### Step 7 — Handle splits explicitly (important edge case)

Splits are the mirror image of merges:

- If one island from layer L-1 overlaps multiple distinct components on layer L, that is a **split event**.

Stable rule (same philosophy as merges):

- End the prior node at layer L-1.
- Create **new nodes** for each split branch starting at layer L.
- Record relationship links from the old node to the new nodes.

This prevents “one ID continuing into multiple branches,” which later produces confusing takeovers.

### Step 8 — Repeat upward until the top layer

As you step layer by layer:

- Islands are born (new unsupported blobs appear).
- Islands continue (1-to-1 overlap).
- Islands merge/split (events create new nodes).
- Islands end (no overlap above).

### Step 9 — Finalize scan output

At the end you have:

- A set of nodes (each node has a Z-range and per-layer footprint).
- A relationship graph (often a tree, sometimes a DAG if splits/re-merges occur).
- Per-node stats (area-by-layer, max area, centroid, persistence).

This is the “raw material” for logical volumes.

---

## 10) Workflow 2: Generate Logical Volumes From the Scan

This is the second stage: turning the raw scan nodes into the practical “volumes” that later auto-support logic can reason about.

### Step 1 — Treat each tracked “blob” as a separate building block until something changes

As you scan upward layer-by-layer, you are tracking connected blobs.

If a blob stays “basically the same blob” from one layer to the next (a clean 1-to-1 overlap), treat it as one continuous volume piece.

The moments where a blob stops being “the same blob” are the only times you cut the volume and start a new one. Those moments are:

- **Birth:** a new blob appears with no overlap below (a true new island starting).
- **Merge:** two or more blobs below become one blob above.
- **Split:** one blob below becomes two or more blobs above.
- **Death:** a blob ends (no overlap above).

Key rule:

- When a **merge** or **split** happens, don’t try to keep using the old ID as if nothing happened. End the old piece(s) and start new piece(s).

### Step 2 — Record simple parent/child relationships (this is the “hierarchy”)

This step is just bookkeeping. It is not a visual graph in the UI.

You store relationships like:

- “These children blobs combined to form this new blob.” (merge)
- “This blob separated into these new blobs.” (split)

So you end up with a parent/child structure where:

- **Leaves** are the blobs that were born as true islands.
- **Parents** are blobs created when earlier blobs merged together.

This naturally creates understandable mid-level parts like:

- finger → palm → arm → torso

Note: in many models this behaves like a clean tree, but in some geometry a split can later re-merge, which makes it more general than a simple tree. That’s OK as long as the relationships are recorded consistently.

#### Quick example (what this looks like in practice)

- Several fingertip islands are **born**.
- They **continue** upward for a while.
- They **merge** into one blob: that new blob is a “palm piece.”
- The palm piece **continues** upward.
- The palm piece **merges** into a larger blob: that new blob is an “arm piece.”
- The arm piece eventually **merges** into the torso piece.

### Step 3 — Define “logical appendage volume” as a subtree union

This is the simplest and most stable way to get the volume you intuitively care about.

Example:

- “Arm system volume” = union of all nodes in the arm subtree.
- “Leg system volume” = union of all nodes in the leg subtree.

This solves the common misunderstanding:

- Toes do not need to *own* the hip.
- Toes contribute to leg demand because the leg system aggregates its descendants.

### Step 3.5 — How you actually “create the volumes” (what you store)

This is the missing practical piece: you don’t need a new mesh operation here.

You already produced the raw ingredients during the scan:

- A per-layer solid mask (and/or per-layer island labels)
- Per-node layer ranges (first/last layer)
- Per-layer footprints for each node (which pixels belong to that node on that layer)

To create a usable volume for later logic, you store it as a **stack of 2D masks**, not as millions of individual cube objects.

In plain terms:

- A “volume” = “the set of pixels that belong to this thing, layer by layer.”

Practical storage representation:

- Keep each layer’s pixels as **run-length encoded rows (RLE)** (which you already use).
- For a single node, the volume is simply “all of that node’s RLE rows across its layer range.”

When you want a bigger logical volume (like an entire arm system):

- For each layer, take the union (logical OR) of the RLE masks from every node in that subtree.
- The result is another per-layer RLE mask stack, which is your “arm system volume.”

Key benefit:

- You are not voxel-filling the world again.
- You are reusing the scan output and combining it efficiently.

This is also where you can compute per-layer areas, centroids, and other metrics on the combined mask without ever expanding it into a dense 3D grid.

### Step 4 — Compute the properties you’ll later use for support logic

For each logical volume (subtree union), compute aggregates such as:

- Total volume
- Cross-section profile vs height (area-by-layer envelope)
- Estimated lever arms (via centroids by layer)
- Persistence measures

These are the inputs your later “how many supports / what strength / where” logic can use.

### Step 5 — Optional: controlled attachment allocation (shoulder/hip)

If you want an appendage to include some attachment mass (shoulder/hip) without earlobes taking over heads:

- Apply attachment allocation only at junctions.
- Bound it with prominence measures such as:
  - Persistence of the branch before merge
  - Relative cross-section at merge (child area / parent area)
  - Thickness ratio near the junction

Outcome:

- Major appendages earn meaningful attachment regions.
- Tiny details earn little or none.

Important: this step should never replace the base hierarchy. It is an optional refinement.

### Step 6 — Performance note: “voxels” here don’t have to be millions of tiny cubes

It’s easy to picture voxels as “millions of little cubes,” but that’s not how you have to store or process them.

In this workflow, the practical unit is:

- “a set of filled pixels per layer”

And you already compress those pixels using RLE. That compression is effectively a form of “dynamically sized voxels” in 2D:

- Instead of storing every filled pixel, you store continuous runs (start + length).

---

## 10.1) “Dynamically shaped voxels” (What you described, in concrete terms)

What you’re describing makes sense and it’s a common performance strategy:

- If many neighboring pixels are filled, don’t store them as a million separate cells.
- Store them as larger combined blocks where possible.

In this project, you already have one excellent version of this idea:

- **RLE (run-length encoding)**
  - Per row, consecutive filled pixels are stored as a single run.
  - This is exactly “combining many voxels into one” (in 2D).

There are two further upgrades people sometimes use (optional):

### Option A) Merge runs into rectangles (still 2D)

- If you have similar runs repeated on many consecutive rows, you can merge them into bigger rectangles.
- This can reduce data further on large smooth regions.

### Option B) Adaptive grids (quadtree / multi-resolution)

- Use larger cells in big flat/solid regions.
- Automatically refine into smaller cells only near thin features, edges, or high-detail areas.

Why this directly addresses your concern:

- Coarse cells won’t “stick out” everywhere, because you refine only where the geometry is thin or changing.
- Big models remain fast because most of the model is stored at a coarser level.

Practical takeaway:

- You do not need to pick one fixed voxel size that must represent everything perfectly.
- You can keep a reasonable baseline (e.g., ~30µm) and add targeted refinement only where the scan becomes unstable (thin spikes, flicker, tiny bridges).

---

## 10.2) Performance & Optimization (Keeping This Fast for Normal Computers)

The goal is for the scan + analysis workflows to feel usable on average hardware. If a workflow takes tens of minutes, users will not use it.

The main performance idea:

- Avoid “global high-resolution everywhere.”
- Spend detail only where it changes the outcome.

### A) The real cost driver

Scan time scales roughly with:

- Number of layers processed
- Number of pixels per layer
- How much per-layer work you do on those pixels/runs

So the biggest levers are:

- XY scan resolution (`px_mm`)
- Z step / layer height used for analysis
- How much you can reuse/cached results

### B) Cap scan resolution automatically for large models

Large models can explode total pixel count if `px_mm` is fixed.

To prevent worst-case scans from becoming unusable, pick a target maximum grid size (for example, “roughly 1K–2K pixels per dimension”) and compute `px_mm` automatically from the model’s XY bounds so the grid stays within that cap.

This ensures:

- Small models can use fine resolution.
- Large build-plate models automatically get a coarser baseline scan that finishes in reasonable time.

### C) Two-pass scanning (coarse first, refine where needed)

This is often the highest-ROI approach:

- **Pass 1 (coarse):** run quickly to discover the overall island structure (births, merges, big regions).
- **Pass 2 (refine locally):** only in regions that need it:
  - thin spikes
  - unstable topology (flicker)
  - around important events (birth/merge)

This avoids paying the “fine scan” cost across the entire model.

### D) Cache and reuse work

Many tweaks shouldn’t force a full rescan.

Examples of things that can usually be changed without re-slicing everything:

- Minimum island pixel threshold
- Color/visualization settings
- Which node/subtree is currently being inspected

If the model and scan resolution are unchanged, reusing prior per-layer masks/labels can save a lot of time.

### E) Make long scans feel fast (incremental + cancel)

Even if a large model scan takes multiple seconds (or longer), it can still feel usable if:

- Results appear incrementally as layers are processed.
- The scan is cancellable.
- The UI shows progress and estimated remaining time.

### F) Avoid dense 3D voxel grids unless absolutely required

For island identification and logical volumes, the practical representation is:

- “a stack of 2D masks per layer”

Stored efficiently (RLE), this avoids the memory and CPU cost of a global dense 3D voxel array.

---

## 10.3) Visualization / Debug Views (Seeing What’s Happening Without Rendering Cubes)

Seeing the islands and logical volumes is critical for building and trusting auto-support logic.

The key point:

- You can visualize the analysis without rendering “millions of cube voxels.”

### Option 1: Slice Viewer (must-have)

This is the fastest, clearest debugging view.

- You show a single layer (like a slicer preview) with:
  - the solid mask
  - the unsupported/island mask
  - component labels / island IDs
  - merge/split/birth markers

Why this is valuable:

- It directly shows the truth source your algorithm is using.

### Option 2: 3D Contour Stack (cheap 3D context)

Instead of cubes, you display thin “slice sheets” in 3D:

- Each layer mask is rendered as a translucent filled shape.
- Colored by island ID / logical volume.

Why this helps:

- It gives 3D context with relatively low rendering cost.

### Option 3: Fast surface overlay (“mesh painting”) without per-triangle coloring

Important distinction:

- **Do not** color per-triangle/per-vertex (this makes messy triangulation look worse and can paint an entire long triangle incorrectly).
- Instead, color **per pixel on-screen** using a lookup into the scan label field.

In plain terms:

- Every pixel you see on the model corresponds to a world position.
- That world position maps to a scan layer + XY cell.
- The overlay color comes from the island/logical-volume ID stored in the scan results.

Key benefit:

- A single triangle can contain multiple colors across its surface (so you don’t get “one long triangle painted all the way up”).

Performance note:

- When done this way, the runtime “painting” is typically fast; the main cost is keeping the label data available to sample.
- For debugging, you can also limit what is sampled/loaded (e.g., only show selected logical volumes or use a downsampled field for display).

---

## 11) Definitions (What Exactly Is an Island Here?)

### “Layer component”

A **layer component** is one connected region of “solid” within a single Z slice.

### “Island” (leaf island)

A **leaf island** is a layer component that appears at some layer and initially has **no supporting overlap** from the layer below (it is “born unsupported”).

Important: leaf islands are not the final answer. They are the leaves of a hierarchy.

### “Island volume node” (event-bounded volume)

An **island volume node** is the 3D volume represented by a sequence of layer components across consecutive layers **only while the mapping remains 1-to-1**.

In other words:

- A node is a “tube” of connected components across Z.
- A node stops when topology changes (merge/split).

### “Merge hierarchy”

A directed graph/tree where:

- Leaves are born islands (fingertips, toe tips, sleeve tips).
- Internal nodes are created at merges (fingers → palm, palm → arm, arm → torso).

---

## 12) Inputs, Outputs, and What to Record

### Inputs

- A watertight (or effectively watertight) printable solid.
- A chosen Z slicing schedule (layer height for analysis).
- A chosen XY sampling resolution for the 2D masks.

### Outputs (Core)

- A set of **island volume nodes**.
- Parent/child relationships forming a **merge hierarchy**.

### What each node should record (minimum useful set)

- Z range: start layer, end layer
- Per-layer 2D mask (or reference to compressed representation)
- Volume estimate (sum over layers)
- Per-layer area and centroid (for later heuristics)
- “Birth type”: born-as-leaf vs created-at-merge vs created-at-split
- “Persistence” (height in layers/mm)
- Parent id (if any) and child ids (if any)

This is enough for later steps to do aggregation and prioritize support needs without needing the node to “own” unrelated mass.

---

## 13) Step-by-Step Procedure (How Islands and Parents Are Actually Built)

### Step 1: Build per-layer solid masks

For each Z layer:

- Compute a 2D solid mask representing the intersection of the model with the layer slab.
- Recommended: optionally use sub-sampling per cell to reduce aliasing on thin spikes.

### Step 2: Connected components per layer

For each layer mask:

- Compute connected components (choose 4- or 8-connectivity; be consistent).
- Assign a temporary id per component in that layer.

### Step 3: Build overlap relationships between adjacent layers

For each pair of consecutive layers (L and L+1):

- For each component in L, find which components in L+1 it overlaps (by pixel intersection count or area).
- Record an overlap graph:
  - From components at L to components at L+1
  - With weights (overlap area)

This overlap graph is the backbone of births, merges, splits, and 1-to-1 continuations.

### Step 4: Classify relationships (1-to-1 vs merge vs split)

For each component at L+1, consider the set of components at L that overlap it.

- **Birth**: component at L+1 has no incoming overlaps
- **Merge**: component at L+1 has 2+ incoming overlaps

For each component at L, consider how many components at L+1 it overlaps.

- **Death**: component at L has no outgoing overlaps
- **Split**: component at L overlaps 2+ components at L+1

### Step 5: The core invariant (ID continuation rule)

Only allow “same node continues upward” when mapping is strictly **1-to-1**:

- Component A at L overlaps exactly one component B at L+1
- Component B at L+1 overlaps exactly one component A at L

If that is true:

- Node continues (append layer B to the same node)

If that is not true (merge or split):

- Terminate the current node(s) at layer L
- Create new node(s) starting at layer L+1

This is the rule that prevents the “yellow takes over unrelated volume” behavior.

### Step 6: Construct hierarchy links at events

- **At a merge (many-to-one)**:
  - The incoming nodes (children) terminate at L
  - Create a new node starting at L+1 (the merged component)
  - Link: children → new parent node

- **At a split (one-to-many)**:
  - The incoming node (parent-ish) terminates at L
  - Create multiple new nodes at L+1
  - Link: old node → new nodes

Note: even if you expect merges to dominate, splits must be handled, or the hierarchy can become unstable and “hard to explain.”

---

## 14) Edge Cases and Guardrails (What Commonly Breaks Naive Implementations)

### Edge case A: “Parent converges with child” / continuation ambiguity

This is exactly why the 1-to-1 continuation rule exists.

If what looks like “the parent” at L+1 overlaps with a child at L:

- Do not try to guess which id should continue.
- If it is not 1-to-1, treat it as an event (merge or split) and start a new node.

### Edge case B: Tangential contact (1-pixel bridges)

Two components may become connected by a tiny bridge due to resolution.

Guardrails:

- Require a minimum overlap area to consider two components “truly connected” between layers.
- Optionally erode/dilate masks mildly to stabilize topology at your chosen resolution.

### Edge case C: Very thin spikes / near-2D features

At coarse XY resolution, these can flicker on/off.

Guardrails:

- Subsample coverage per cell (treat a cell as “solid” if coverage exceeds threshold).
- Add local refinement when a region’s topology changes too frequently over a short Z span.

### Edge case D: Rapid flicker (appear-disappear-appear)

If a tiny component vanishes for one layer due to sampling, it will look like:

- death then re-birth

Guardrails:

- Allow short “gaps” to be bridged if the component reappears in nearly the same XY region within N layers.

### Edge case E: Splits that later re-merge

This can happen in organic shapes.

Proper handling:

- Treat split as a real event (terminate old node, start new nodes)
- If those nodes later merge, that merge creates another new parent node.

This may create a non-tree (a DAG). That is acceptable if you track it consistently.

---

## 15) How This Enables Later Support Logic (Without Forcing Bad Ownership)

Once the hierarchy exists:

- You can define “logical appendage volume” as the union of a subtree.
- You can compute total demand by aggregating leaf contributions upward.

Crucially:

- Small leaves (earlobes) remain small in ownership.
- They can still contribute upward through aggregation.
- You avoid the “earlobe claims face/head/back” failure mode.

---

## 16) Core Takeaway (Operational)

To get stable, useful island volumes:

- Build per-layer components.
- Build overlap relationships.
- Continue identities only for strict 1-to-1 mappings.
- Terminate and create new nodes at merges and splits.
- Link nodes into a hierarchy (or DAG) of events.

Once that is in place, “shoulder/hip inclusion” can be added later as a controlled, bounded junction allocation step without breaking the base hierarchy.
