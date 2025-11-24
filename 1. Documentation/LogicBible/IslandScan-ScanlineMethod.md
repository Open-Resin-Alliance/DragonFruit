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
