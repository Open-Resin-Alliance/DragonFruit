# Scanline Rasterization Method

## Understanding the Scanline Algorithm (Simple Explanation)

### The "Paint by Numbers" Analogy

Imagine you have a large coloring book page with a big circle in the middle, and you need to color it in.

#### 1. The Current Way (Pixel-by-Pixel)
This is like taking a fine-tip pen and visiting **every single tiny dot** on the page, one by one.
*   You go to dot #1: "Is this inside the circle?" -> No.
*   You go to dot #2: "Is this inside the circle?" -> No.
*   ...
*   You go to dot #500: "Is this inside the circle?" -> **Yes**. (Color it).
*   You go to dot #501: "Is this inside the circle?" -> **Yes**. (Color it).

You are asking the question "Am I inside?" millions of times (thats what she said). It's very slow because you're doing the same calculation over and over again for empty space.

#### 2. The Scanline Way (Row-by-Row)
This is like using a ruler and a wide marker.
*   You look at the first row of the page.
*   You calculate: "The circle starts at **inch 2** and ends at **inch 8**."
*   **Action:** You just swipe your marker from inch 2 to inch 8 in one go.

You don't ask "Am I inside?" for every dot. You just find the **edges** (the start and end points) and fill everything in between instantly.

### Why it's faster for us

In your 3D printer slicing:
*   **Current:** For a 4K layer, we do ~8 million checks per layer.
*   **Scanline:** We only calculate the edges (maybe a few thousand).

It turns a "fill every pixel" problem into a "find the edges" problem, which is much, much less work for the computer.

---

## Technical Overview

The Scanline Rasterization method is an optimized algorithm for converting vector polygons (loops) into a binary pixel grid (mask). It replaces the naive "Point-in-Polygon" approach to significantly improve performance during island detection.

## The Problem with Naive Rasterization

The previous approach checked every single pixel in the grid against every polygon loop:

```typescript
// Naive Approach: O(Width * Height * NumLoops)
for (each pixel (x,y)) {
  if (pointInPolygon(x, y, loops)) {
    mark(x, y);
  }
}
```

For a 4K resolution layer with complex geometry, this resulted in billions of unnecessary intersection tests per layer.

## The Scanline Solution

The Scanline algorithm exploits the fact that pixels are arranged in rows. Instead of testing points, we calculate the intersections of polygon edges with each horizontal scanline.

**Complexity:** `O(Height * NumEdges + FilledPixels)`

### Algorithm Steps

1.  **Build Edge Table (ET):**
    *   Iterate through all polygon edges.
    *   Discard horizontal edges (they don't intersect scanlines).
    *   Store non-horizontal edges in a bucket sorted by their minimum Y-coordinate (`yMin`).
    *   Each edge entry stores:
        *   `yMax`: The maximum Y-coordinate of the edge.
        *   `x`: The X-coordinate at `yMin`.
        *   `slope`: The inverse slope (`1/m = dx/dy`) to increment X for each scanline.

2.  **Process Scanlines:**
    *   Start at the minimum Y found in the Edge Table.
    *   Initialize an **Active Edge List (AEL)** (empty).
    *   For each scanline `y`:
        1.  **Move edges from ET to AEL:** Add all edges where `yMin == y`.
        2.  **Remove finished edges:** Remove edges from AEL where `yMax == y`.
        3.  **Sort AEL:** Sort active edges by their current `x` coordinate.
        4.  **Fill Spans:** Iterate through the sorted AEL in pairs (0-1, 2-3, etc.). Fill pixels between `ceil(edge[i].x)` and `floor(edge[i+1].x)`.
        5.  **Update X:** For all edges in AEL, increment `x` by `slope`.

### Implementation Details

*   **Coordinate System:** The algorithm works in pixel coordinates.
*   **Winding Rule:** The "Odd-Even" rule is implicitly used by filling between pairs of sorted intersections. This correctly handles holes and nested polygons automatically.
*   **Precision:** Floating point coordinates are used for `x` and `slope` to maintain sub-pixel accuracy during edge tracking, but filling snaps to integer pixel centers.

## Benefits

*   **Performance:** Eliminates the loop multiplier for every pixel. Speed scales with edge count (geometry complexity) rather than grid resolution.
*   **Accuracy:** Produces mathematically identical results to the point-in-polygon test for standard polygons.
*   **Scalability:** Allows for much higher resolution scans (smaller pixel sizes) without exponential slowdowns.

---

## Parallel Slicing Optimization

To further improve performance, the system uses a **Parallel Slicing** architecture to distribute the workload across multiple CPU cores.

### The Bottleneck
Originally, the main thread was responsible for "slicing" the 3D geometry (calculating the 2D cross-section loops) for every layer and sending those loops to the workers.
*   **Problem:** Slicing is computationally expensive (O(Triangles)).
*   **Result:** The main thread became the bottleneck, spending ~96% of the time calculating slices while workers sat idle waiting for data.

### The Solution: Scatter-Gather Pattern

1.  **Scatter (Initialization):**
    *   At the start of the scan, the **entire raw geometry buffer** (Float32Array of vertex positions) is sent to all workers.
    *   This happens once and is very fast due to memory transfer optimizations.

2.  **Parallel Execution (Worker Autonomy):**
    *   The main thread sends lightweight "jobs" to workers: *"Process Layer #5 at Z=10.5mm"*.
    *   **Worker Action:**
        1.  **Slice:** The worker uses its local copy of the geometry to calculate the 2D loops for that specific Z-height.
        2.  **Rasterize:** The worker immediately rasterizes those loops into a binary mask using the Scanline algorithm.
    *   This allows all CPU cores to slice and rasterize simultaneously without waiting for the main thread.

3.  **Gather (Aggregation):**
    *   Workers send the finished binary masks back to the main thread.
    *   The main thread simply stores the results and runs the `IslandTracker` (which is fast and sequential) to connect islands across layers.

### Performance Impact
This architecture removes the single-threaded bottleneck, allowing the scan speed to scale linearly with the number of available CPU cores (typically **4x-12x faster**).

---

## Run-Length Encoding (RLE) Pipeline Optimization

To address critical memory bottlenecks at high resolutions (e.g., 4K/8K screens), the entire island detection pipeline was refactored to use **Run-Length Encoding (RLE)** instead of raw pixel arrays.

### The Memory Problem
Storing full 2D grids for every layer consumes massive amounts of RAM.
*   **Raw Grid:** A single 4K layer (4096 x 2160) requires ~8.8 MB per mask (Int32).
*   **Total Usage:** For 2000 layers, this would require **~17 GB of RAM**, causing browser crashes.

### The RLE Solution
RLE compresses the data by storing "runs" of identical values instead of every pixel.
*   **Format:** `[start, length, value, start, length, value, ...]`
*   **Compression:** For sparse island data (mostly empty space), this achieves **99%+ compression ratios**.

### Pipeline Architecture

1.  **Worker-Side Encoding:**
    *   Workers rasterize layers to `Uint8Array`.
    *   Immediately encode to `RleMask` (compressed) before sending to the main thread.
    *   **Benefit:** Drastically reduces data transfer overhead between workers and main thread.

2.  **RLE-Native Processing:**
    *   `IslandTracker` was rewritten to operate *directly* on RLE data.
    *   **Boolean Operations:** `Intersection`, `Subtraction`, and `Dilation` are performed on RLE runs without ever decoding to full grids.
    *   **Connected Components:** Labeling is done using RLE runs as nodes in the graph.

3.  **Visualization (Sliding Window Decoding):**
    *   To render 3D voxels efficiently without decoding all layers (which would crash memory), the visualizer uses a **Sliding Window** approach.
    *   It decodes only 3 layers at a time (Previous, Current, Next) into temporary buffers to calculate surface voxels, then discards them.

### Results
*   **Memory Usage:** Reduced from GBs to MBs, enabling high-resolution scans on standard hardware.
*   **Performance:** Scan times reduced significantly (e.g., **~4.7s total scan time** for complex models).
*   **Scalability:** The system can now handle thousands of layers without performance degradation.

---

## Deep Dive: RLE Implementation Details

This section details the specific data structures and algorithms used to achieve the RLE optimization.

### 1. Data Structures

We introduced two core types to handle compressed data:

#### `RleMask` (Binary)
Used for representing solid geometry (on/off).
```typescript
type RleMask = {
  rows: Int32Array[]; // Array of rows, each row is [start, length, start, length...]
  width: number;
  height: number;
}
```
*   **Storage:** Each row is an `Int32Array` containing pairs of `(start, length)`.
*   **Meaning:** These pairs represent the *solid* (1) regions. Empty space is implicit.
*   **Efficiency:** A row with 3 islands might look like `[10, 5, 50, 10, 100, 2]`, taking only 6 integers instead of 4096.

#### `RleLabels` (Multi-Value)
Used for tracking island IDs (connected components).
```typescript
type RleLabels = {
  rows: Int32Array[]; // Array of rows, each row is [start, length, id, start, length, id...]
  width: number;
  height: number;
}
```
*   **Storage:** Each row is an `Int32Array` containing triplets of `(start, length, id)`.
*   **Meaning:** Represents a run of `length` pixels starting at `start` with value `id`.
*   **Efficiency:** Allows tracking thousands of unique island IDs with minimal memory overhead.

### 2. Core Algorithms

All island detection logic was rewritten to operate directly on these compressed structures.

#### Intersection (`A AND B`)
Finding supported regions (Current Layer AND Previous Layer).
*   **Logic:** Iterates through runs of Row A and Row B simultaneously (like a merge sort).
*   **Output:** Generates new runs only where intervals overlap.
*   **Speed:** O(N + M) where N and M are the number of runs, not pixels.

#### Subtraction (`A MINUS B`)
Finding unsupported regions (islands).
*   **Logic:** Iterates through runs of Row A (Current) and subtracts intervals from Row B (Supported).
*   **Output:** Remaining intervals are the "islands" (unsupported overhangs).

#### Connected Components (Labeling)
Assigning unique IDs to connected regions.
*   **Graph Construction:** Each RLE run is treated as a node.
*   **Edge Detection:** We check for overlaps between runs on adjacent rows (y and y+1).
*   **Union-Find:** If two runs overlap, their IDs are merged using a Union-Find data structure.
*   **Result:** A fast, single-pass labeling algorithm that works on compressed data.

### 3. Visualization Strategy: Sliding Window

The 3D voxel visualizer needs to know if a voxel is "surface" (exposed to air) or "interior". This requires checking 6 neighbors (Left, Right, Up, Down, Above, Below).

*   **Challenge:** Random access in RLE is slow (O(N)), and decoding everything is memory-heavy.
*   **Solution:** **Sliding Window Decoding**.
    1.  We maintain 3 temporary `Int32Array` buffers: `PrevLayer`, `CurrLayer`, `NextLayer`.
    2.  As we iterate through the layers (Z), we decode *only* these 3 layers from RLE.
    3.  We perform O(1) neighbor checks using these buffers.
    4.  We discard `PrevLayer`, move `Curr` to `Prev`, `Next` to `Curr`, and decode a new `Next`.
*   **Memory Impact:** We only ever hold ~25MB of raw data in memory (for 3 layers) instead of 17GB.

---

## Island Detection Pipeline (High-Level)

The scanline + RLE pipeline above is the **foundation** for island detection. This section connects it to the island concept the slicer uses.

### What is an Island?

- An **island** is a 3D volume of model material that, at some point, starts in mid‑air (unsupported) and then grows upward.
- Once an island starts, all connected solid above that unsupported base belongs to the **same island**, until it merges into other islands or reaches the top of the model.

### Per-Layer Unsupported Detection

For each layer, workers:

1. Slice the mesh at the current Z to get 2D loops.
2. Rasterize loops into a binary mask using the scanline method.
3. Encode the mask as `RleMask`.
4. Compare the current mask to the **dilated** previous mask:
   - Dilate previous mask by `support_buffer_mm / px_mm` in pixel space (using RLE).
   - `supported = current ∧ dilated(previous)`.
   - `unsupportedCandidates = current − supported`.
5. Run RLE component labeling on `unsupportedCandidates` to get **unsupported components** (potential island seeds).

Each worker returns, per layer:

- `solidMaskRle` – all solid pixels for that layer.
- `islandLabelsRle` – labels of unsupported components for that layer.
- `components` – metadata for those unsupported components.

The main thread feeds these into **IslandTracker** to form full 3D islands.

---

## IslandTracker: 3D Islands and Hierarchy

IslandTracker is responsible for turning per‑layer masks into stable 3D islands with IDs, volumes, and parent–child relationships.

### Core Island Data (Conceptual Interface)

```typescript
interface Island {
  id: number;                               // Stable ID
  firstLayer: number;                       // First layer where island appears
  lastLayer: number;                        // Last layer where island appears
  status: 'active' | 'complete';            // Lifecycle during scan
  perLayerAreaMm2: Map<number, number>;     // Area at each layer when processed
  volumeMm3?: number;                       // Computed after scan
  maxAreaMm2?: number;                      // Largest cross-section
  maxAreaLayer?: number;                    // Layer of largest cross-section
  parentId?: number;                        // Parent island ID (if merged)
  childIds: number[];                       // Child island IDs
  isMergedPlaceholder?: boolean;            // Temporary merged islands during evaluation
}
```

### Per-Layer Logic

For each layer, IslandTracker:

1. Runs connected components on the **solid mask** (RLE) to find solid components.
2. For each solid component, checks overlap with the **previous layer’s island labels** (also RLE):
   - Builds `prevIds`: set of all island IDs overlapped one layer below.
   - Builds `activePrevIds`: subset of `prevIds` whose islands are still `active`.

Then decides how to label the component:

- **Multiple active overlaps** (`activePrevIds.size > 1`):
  - Merge event.
  - Previous islands are marked `complete` at layer‑1.
  - A new **merged placeholder** island is created and a `PendingMerge` record is added.

- **Single active overlap** (`activePrevIds.size === 1`):
  - Simple **continuation** of that island.
  - The island’s `lastLayer`, `perLayerAreaMm2`, volume stats, and `maxAreaMm2` are updated.

- **No active overlaps, but `prevIds` not empty**:
  - The component only overlaps islands that are no longer active (completed parents or placeholders).
  - Instead of starting a new island, the tracker resolves those IDs through their `parentId` chain to find the **ultimate ancestor** and treats this as a **continuation of that ancestor**.
  - This prevents “top caps” that sit directly on existing bodies from becoming separate child islands.

- **No overlaps at all** (`prevIds` empty):
  - True new unsupported seed → start a **new island** at this layer.

After assigning an island ID to each component, IslandTracker writes the ID into the per‑layer `RleLabels` grid (`islandLabelsPerLayer`) that downstream systems use.

---

## Volume and Parent–Child Hierarchy

### Per-Layer Area and Volume

- Each island maintains `perLayerAreaMm2`, a map from `layerIndex → areaMm2` recorded when that layer is processed.
- After the scan:

```text
volumeMm3 = Σ (areaAtLayer × layerHeightMm) over all layers in perLayerAreaMm2
```

- Using pre‑merge areas ensures that each island’s volume reflects its own contribution, even after parent reassignments.

### PendingMerge and the 30-Layer Window

When a merge happens (multiple active islands feed into a single component):

- IslandTracker creates a `PendingMerge` record roughly like:

```typescript
type PendingMerge = {
  mergeLayer: number;                 // Layer where merge occurred
  candidateIds: number[];             // Islands that merged
  mergedIslandId: number;             // Temporary merged placeholder
  overlapCounts: Map<number, number>; // Overlap per candidate in later layers
  preMergeLabels: RleLabels;          // Island labels from layer before the merge
};
```

- Over the next 30 layers, it tracks how much each candidate continues inside the merged placeholder using `preMergeLabels` to attribute pixels.
- After 30 layers:
  - The candidate with the **highest overlap** becomes the **parent**.
  - Other candidates and the placeholder become **children**.

### Placeholder Resolution and True Parents

- Placeholders may participate in later merges, so they can form chains.
- A conceptual `resolveTrueParent(id)` helper walks `parentId` links until it reaches a **non‑placeholder ancestor**.
- All hierarchy references (including new merges and top‑cap continuation) use this resolved ancestor ID.
- Once all merges are evaluated:
  - Placeholder islands are removed from the public `islands` list.
  - Their areas/volumes remain merged into their real parent.

The result is a clean parent–child tree that describes how unsupported volumes grow and merge without exposing temporary bookkeeping nodes.

---

## Visualization: Voxels, Blobs, and Labels

The same `ScanResults` data is visualized in three main ways.

### 1. Voxel Visualization

- Uses `islandLabelsPerLayer` to instantiate colored voxels.
- Each island ID is mapped to a unique color.
- Only **surface** voxels are rendered, using the sliding‑window decode described earlier.
- Color changes along continuous geometry make it easy to see where the tracker starts/stops islands or where merges occur.

### 2. Island Overlay Blobs

- For each island, a base footprint is computed from its base layer (`compBase` / `firstLayer` and label data).
- That footprint is converted to world‑space points, hulled, and extruded a few layers to create a 3D **blob** over the base region.
- Blobs are only shown for:
  - Islands that are **true unsupported seeds**.
  - Islands that are **leaf nodes** (no `childIds`), to avoid huge parent slabs.
- This yields a focused view of the islands that actually need support attention.

### 3. Debug Island ID Labels

- Each blob can optionally show a small `#ID` label just above the base.
- These labels help correlate:
  - Voxel colors ↔ island IDs ↔ overlay blobs ↔ internal island data.

---

## How This Feeds Future Auto-Support

The island system is designed so an auto‑support module can reuse its results directly.

### Key Inputs for Auto-Support

From `ScanResults` and `Island` objects, an auto‑support system can access:

- **Island bases and footprints**
  - Base layer indices (`compBase` / `firstLayer`).
  - Base footprints in grid space (via `islandLabelsPerLayer` and `baseLabels`).

- **Size metrics**
  - `volumeMm3` and `maxAreaMm2` for how big / wide each unsupported volume is.

- **Hierarchy**
  - `parentId` / `childIds` describing which islands feed into which merged bodies.
  - This allows focusing supports on key parents that indirectly support multiple children.

- **Spatial mapping**
  - `grid` for mapping pixel indices back to world‑space positions on the mesh.

### Example Auto-Support Workflow (Conceptual)

1. **Candidate selection**
   - Start with islands that:
     - Begin unsupported (true seeds).
     - Are leaf islands or important parents.
     - Exceed thresholds for volume or `maxAreaMm2`.

2. **Ranking**
   - Score islands based on size and height to decide which are most critical.

3. **Support target derivation**
   - For a chosen island, project its base footprint (from `islandLabelsPerLayer` at `compBase[id]`) into world space to find anchor patches on the model.

4. **Support placement and explanation**
   - Generate support geometry that terminates within those anchor patches.
   - Use voxel colors + blobs to visually explain why those supports were chosen.

Because the scanline + RLE pipeline already reduces the model to a small set of well‑described unsupported volumes, automatic support generation can focus on **deciding where and how to support**, rather than rediscovering which parts of the model are islands.

