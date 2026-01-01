# Island Scan & Overlay – Current Behavior

## 1. Big Picture

The island scan tool answers one question:

> **Where in this model is there geometry that “starts in mid-air” and then grows up into a full 3D chunk that needs supports?**

It works in three stages:

1. **Slice & scan** (off-screen, in workers)
2. **Track islands as 3D volumes** (in `IslandTracker`)
3. **Visualize results** on top of the 3D model (voxel view + 3D “island blobs” + vertex-color overlay).

---

## 2. How Scanning Works (Conceptual)

### 2.1 Geometry preparation (before scanning)

File: `useIslandManager.ts`

When you click **Scan**:

- The current STL mesh is cloned and transformed into **world space**:
  - Center offset is removed (geometry is recentered).
  - The model transform (position, rotation, scale) is applied.
  - A bounding box is recomputed.
- This transformed geometry + its bounding box is passed to `runIslandScan` / `runScanlineScan` along with:
  - **Layer height** (Z step in mm)
  - **Pixel size** (`px_mm`, raster resolution)
  - **Support buffer** (mm of “allowed bridging”)
  - **Connectivity** (4- or 8-neighbor for pixel groups)
  - **Minimum island area** (used later for filtering).

### 2.2 Slicing & rasterization (worker side)

File: `islandScan.worker.ts`

For each Z layer:

1. **Slice the mesh**
   - Uses `BucketedSlicer` to get 2D polygon loops at a given Z (current layer) and at the layer below (previous layer).

2. **Rasterize polygons to a grid**
   - The horizontal plane is turned into a 2D pixel grid (`Mask`):
     - Pixel size = `px_mm` (e.g. 0.10 mm).
     - Grid coordinate system is tied to the model’s bounding box.
   - Current layer loops → **current mask** (solid pixels = model material).
   - Previous layer loops → **previous mask** (same grid).

3. **Prepare masks for island detection**
   - Both current and previous masks are converted to **RLE (Run Length Encoded)** form for speed and memory efficiency.

4. **Run per-layer island detection**
   - Calls `scanLayer` from `island.ts` with:
     - `currentRle`: current solid mask.
     - `prevRle`: previous solid mask (or null for first layer).
     - `RasterScanOptions`: pixel size, support buffer, connectivity.

### 2.3 Per-layer island detection (scanLayer)

File: `island.ts` (function `scanLayer`)

For each rasterized layer:

- If there is **no previous layer**:
  - The entire current mask is treated as **unsupported candidates** (everything is potentially an island base).

- If there **is a previous layer**:
  1. Compute **support buffer in pixels**: `support_buffer_mm / px_mm`.
  2. **Dilate** the previous layer mask by that radius:
     - This simulates how far material can bridge without needing support.
  3. Compute **supported region**:
     - `supported = current ∧ Dilate(prev)` (solid material that has support within the buffer distance below).
  4. Compute **unsupported candidates**:
     - `islandCandidates = current − supported` (solid pixels that are too far from anything below).

- Then it runs **connected component labeling** on `islandCandidates`:
  - Groups adjacent unsupported pixels into components.
  - Produces:
    - `labels`: RLE labels per pixel (which unsupported component each pixel belongs to).
    - `components`: metadata per component (id, size in pixels, area).

Output per layer (simplified):

- `labels`: unsupported pixel labels.
- `components`: list of unsupported components.
- `solidMask`: the full solid mask of the current layer.

### 2.4 Multi-layer island tracking (3D volume)

File: `ScanOrchestrator.ts` + `islandTracker.ts`

`ScanOrchestrator` coordinates all layers and owns the main `ScanResults` structure.

**Step-by-step:**

1. **Grid setup**
   - From the model bounding box and `px_mm`, it defines:
     - `width` / `height` in pixels.
     - `originX` and `originZ` which map pixels back to world space.

2. **Parallel worker execution**
   - Multiple workers slice & rasterize layers in parallel.
   - For each layer, they return:
     - `solidMaskRle`: all solid pixels.
     - `islandLabelsRle`: unsupported-component labels from `scanLayer`.
     - `components`: metadata about those unsupported components.

3. **Sequential island tracking** (critical for stable IDs)
   - An `IslandTracker` instance processes each layer in order:
     - For layer 0:
       - All solid components are **new islands**.
     - For later layers:
       - First, it runs connected components on the **solid mask** (not just unsupported pixels).
       - For each solid component, it examines **overlap with previous layer’s island IDs**.

   - For each current solid component:
     - If **no overlap** with any previous island → **new island starts here**.
     - If it overlaps **exactly one** previous island → **continuation** of that island.
     - If it overlaps **multiple** previous islands → **merge event**; a special merge handling kicks in.

4. **Merge handling with delayed evaluation**
   - When components from multiple islands merge in a new layer:
     - Previous islands are marked complete at the prior layer.
     - A **new temporary “merged” island** is created (placeholder with `isMergedPlaceholder = true`).
     - A `PendingMerge` record tracks which islands merged and holds a copy of labels **before** the merge.
     - Over the next 30 layers, the tracker keeps track of **which original island has the most continuing overlap** with the merged geometry.
     - After 30 layers:
       - Whichever candidate has the most overlapping pixels is chosen as the **true parent**.
       - Other candidates become **children** (`parentId` / `childIds` links).
       - The placeholder island is assigned a parent and later removed from user-facing lists.

5. **Area, volume, and filters**
   - For each island, the tracker maintains `perLayerAreaMm2`: area at each layer when it was processed.
   - After scanning:
     - `ScanOrchestrator` computes volume by summing `area × layerHeight` across that island’s layers.
     - It also finds `maxAreaMm2` (largest 2D cross-section).
     - Temporary merged placeholders are filtered out.
     - Islands with `maxAreaMm2` below `min_island_area_mm2` are filtered from:
       - The island list.
       - The per-layer pixel labels (their pixels are set back to 0 / background).

6. **Final `ScanResults`**
   - Includes:
     - `grid` (coordinate system info).
     - `layers` (per-layer masks + island labels).
     - `islands` (final list with IDs, volumes, hierarchy).
     - `islandLabelsPerLayer` (full RLE label grids per layer).
     - `firstHit` / `lastHit` arrays (first/last layer where each pixel has solid material).
     - `baseFootprint` and `baseLabels` (which pixels belong to island bases).
     - `compBase` / `compTop`: mapping from island ID → base layer index / top layer index.

---

## 3. How the Overlay Works

There are **two main visual layers**:

1. **3D island blobs** (`IslandOverlay` + `computeIslandMarkers`).
2. **Vertex-color painting on the mesh** (`applyIslandOverlay`).

### 3.1 Island markers & 3D “blobs”

Files: `islandOverlayLogic.ts`, `IslandOverlay.tsx`, `useIslandManager.ts`

**Purpose:** show a clear, low-poly 3D “chunk” that corresponds to each island’s base and a bit of the geometry above it.

#### 3.1.1 Marker computation

`useIslandManager` computes `islandMarkers` once scan data is available:

- Calls `computeIslandMarkers(scanData, scanBBox, layerHeightMm, overlayTaper)`.
- `computeIslandMarkers` does the following:

1. **Filter to valid islands**
   - Uses the `islands` array from `ScanResults` (already filtered by min area and placeholder removal).
   - Builds a `validIslandIds` set and only considers base pixels whose label is in this set.

2. **Find base pixels per island**
   - It uses:
     - `baseLabels`: for each grid pixel, which island label (ID) owns the base there.
     - `compBase`: for each island ID, which layer index is the base.
     - `firstHit`: for each pixel, the first layer at which it is solid.
   - For each island ID:
     - Iterate through all grid pixels.
     - Keep only pixels where:
       - `baseLabels[idx] === islandId`, and
       - `firstHit[idx] === compBase[islandId]` (ensures we’re using the **base layer** for that island, not higher slices).

3. **Compute world-space centroid and base Z**
   - For each base pixel:
     - Convert flattened index → `(row, col)` using `grid.width`.
     - Convert `(row, col)` to world `X, Y` using grid origin + pixel size + sub-pixel offsets (`VOXEL_OFFSET_X`, `VOXEL_OFFSET_Y`).
   - Average all these pixel centers → `centerX`, `centerY`.
   - Compute `baseZ` using the model’s bounding box min Z and base layer index (`bbox.min.z + layerIndex * layerHeightMm`).

4. **Build 3D geometry for each island**
   - Calls `buildIslandGeometry(label, scanResults, minZ, layerHeightMm, numLayers=3, taperFactor)`.
   - This function:
     - Gathers base-layer pixels for the island, converts them to world `X, Y`.
     - If there are 1–2 pixels total:
       - Creates a small cylinder “blob” at that location (`createCircleFromPixels`).
     - If there are more:
       - Computes a **2D convex hull** around those points (gift-wrapping / Jarvis march).
       - Ensures a **minimum footprint size** (e.g. 0.5 mm) so tiny islands are still visible.
       - Builds a `THREE.Shape` from the hull points.
       - Runs `THREE.ExtrudeGeometry` to extrude that 2D shape upwards by a fixed height (`numLayers * layerHeightMm`).
       - Applies a **taper**: vertices are scaled in X/Y based on their Z position so the shape shrinks towards the base or top (controlled by `taperFactor`).
       - Translates geometry to the correct `baseZ` position.
   - The result is a low-poly, tapered “chunk” geometry positioned over the island’s base footprint.

5. **IslandMarker output**
   - For each island, `computeIslandMarkers` returns an object with:
     - `id`: island ID.
     - `centerX`, `centerY`, `baseZ`.
     - `pixelCount`: number of contributing base pixels.
     - `geometry`: the actual `THREE.BufferGeometry` for the 3D overlay.

#### 3.1.2 Rendering the blobs

File: `IslandOverlay.tsx`

- Receives `markers` (list of `IslandMarker`), `transform`, selection state, opacity settings, and clipping plane bounds.
- Uses `getScanVisualPosition(transform)` to create a **group translation** that aligns the islands in X/Y with the main model.
  - The marker geometries themselves are already in correct world coordinates, so the group position is mainly handling transform offsets / visual alignment.
- For each marker:
  - If it has no geometry: skip.
  - If it is **selected**:
    - Renders **two meshes** with the same geometry:
      1. **Occluded version**:
         - Color: bright orange.
         - Depth test **off**; depth write off.
         - Slightly lower render order.
         - Always visible, even when behind the model (acts like a halo silhouette).
      2. **Visible version**:
         - Color: bright yellow.
         - Depth test **on**, depth write off.
         - Renders where it is actually visible in front of the mesh.
    - Both use the same clipping planes driven by the layer slider.
  - If it is **not selected**:
    - Renders **one mesh** per marker using the configured overlay color + opacity.
    - Depth test is on, depth write off, with clipping planes applied.

The result: islands appear as soft, colored blobs wrapped around the model surface, with special highlighting when a single island is selected.

### 3.2 Vertex-color overlay on the main mesh

File: `islandOverlayPainter.ts` → `applyIslandOverlay`

Purpose: tint the main model’s vertices at the island base locations with a “brush” effect.

1. `applyIslandOverlay` receives:
   - `geometry`: the main model’s buffer geometry.
   - `baseColor`: the original vertex color (or neutral base).
   - `scanResults`: full island scan results.
   - `bbox.min.y`: used for positioning along the vertical axis.
   - `layerHeightMm`.
   - `options`: brush radius, color, opacity.

2. It builds an effective tint color:
   - Since vertex colors have **no alpha**, opacity is simulated by interpolating between `baseColor` and `tintColor`.
   - Higher opacity moves more towards the island color.

3. Calls `applyIslandSoftBrushByLabel`:
   - This helper (elsewhere) uses:
     - `grid` (pixel coordinate system).
     - `baseLabels` (which island owns each base pixel).
     - `firstHit` (first solid layer per pixel).
     - `compBase` (base layer index per island).
     - Vertical info (bounding box min Y + layer heights).
     - `brushRadiusMm`.
     - The tint color.
   - For each island’s base region, it “paints” vertices near those pixel locations, producing a soft halo directly on the model surface.

4. The function returns how many vertices were actually painted (for debugging/metrics).

---

## 4. Scan Logic – Technical Summary

Below is a more technical bullet list of how everything hangs together.

### 4.1 Input → ScanResults

- Input:
  - Transformed `THREE.BufferGeometry` in world space.
  - Bounding box.
  - Layer height (mm).
  - Scan params: `px_mm`, `support_buffer_mm`, connectivity, `min_island_area_mm2`.
- Output: `ScanResults` struct with:
  - Grid definition (`originX`, `originZ`, `width`, `height`, `px_mm`).
  - Per-layer RLE masks (`solidMaskRle` and derived labels).
  - Stable island list with volume, area, parent/child.
  - Helper maps (`firstHit`, `lastHit`, `baseFootprint`, `baseLabels`, `compBase`, `compTop`).

### 4.2 Worker responsibilities

- Slice mesh into 2D loops for each Z.
- Rasterize loops into binary masks on a shared grid.
- Encode current and previous masks as RLE.
- Call `scanLayer` to:
  - Compute supported vs unsupported via dilation.
  - Detect unsupported components.
  - Emit RLE labels + component info.
- Return to main thread:
  - `solidMaskRle`.
  - `islandLabelsRle` (unsupported components for that layer).
  - `islandCount`, `components`.

### 4.3 Main thread (ScanOrchestrator)

- Runs workers concurrently for performance.
- Feeds RLE data through `IslandTracker` layer-by-layer.
- Builds `ScanLayerResult` array and grid-wide helper arrays.
- Computes per-island volume and max cross-sectional area.
- Applies filtering (placeholders, min area), and reassigns labels to true parents.

### 4.4 IslandTracker behavior

- Maintains a map of `Island` objects keyed by stable island ID.
- For each layer:
  - Runs connected components on full solid mask (RLE) to find solid components.
  - For each solid component, finds overlapping previous island IDs (with a small neighborhood margin).
  - Decides new vs continuation vs merge.
  - Updates per-layer area maps, total area, max area.
  - Tracks pending merges for 30-layer evaluation.
- After scan completion:
  - Merge parents & children, and placeholder relationships are resolved.

### 4.5 Overlay path

- `useIslandManager` exposes:
  - Raw `scanData` + `scanBBox`.
  - UI controls for resolution, thresholds, and overlay behavior.
  - `islandMarkers` (via `computeIslandMarkers`).
- Rendering:
  - `IslandOverlay` → 3D blob meshes.
  - `applyIslandOverlay` → vertex-color painting on the main mesh.
  - A separate voxel visualization (not detailed here) uses `islandLabelsPerLayer` to build per-voxel meshes.

---

## 5. Notes for Debugging Graphical Glitches

When you see visual glitches in the island overlay, the likely sources are:

- **Coordinate mapping issues**
  - `originX` / `originZ` vs model transform.
  - The negation of Y (`grid.originZ` actually stores `-Y`).
  - `VOXEL_OFFSET_X` / `VOXEL_OFFSET_Y` offsets shifting markers.
- **Bounding box vs center offsets**
  - The geometry is recentred before transform; `ScanResults.grid` is based on that transformed geometry’s bounds.
  - Any mismatch between how `ScanOrchestrator` defines the grid and how overlay/painting convert back to world coords can cause slight drift.
- **Filtering & relabeling**
  - After placeholder resolution and area filtering, some islands are removed and labels are remapped.
  - `computeIslandMarkers` uses the final `islands` list, but the dense arrays (`baseLabels`, etc.) were originally derived before filtering and are then patched. Bugs here can produce mismatches between visual geometry and logical IDs.
- **Clipping planes / depth ordering**
  - `IslandOverlay` uses custom clipping planes and non-standard depth test settings for selected islands (two meshes with different depth state). Misordered `renderOrder` or clipping values can create strange overdraw or “ghosting” artifacts.

This document captures how the scan and overlay **currently** behave, so we can now cross-check any glitch you’re seeing against the specific stages: slicing, rasterization, island tracking, marker generation, and rendering.

---

## 6. Island Parenting & Hierarchy (Common-Language View)

This section explains, in plain language, how we think about **parent** and **child** islands and why this matters for auto-support.

### 6.1 What is an “island” in this system?

- **An island is a 3D chunk of the model that, at some point, starts in mid-air.**
- Once an island starts, it can **grow upward** and **merge** into other geometry.
- That geometry might later connect to other unsupported bits above it – those become **children** in the hierarchy.

So the hierarchy is not just about "floating pieces"; it is about **how unsupported volumes grow and merge** into the rest of the model.

### 6.2 Parents, children, and merges

- Imagine two separate arms of a character that both start unsupported.
  - Each arm is its own island at first.
  - At some higher layers, those arms connect through armor or cloth.
- When they connect, we say the islands **merge**.
- The system then decides which of those original islands becomes the **parent**:
  - The parent is the island that most of the merged volume appears to come from.
  - The other islands become **children**.
  - Children are still real islands (they each had their own unsupported start), but they now live under a parent that represents the merged bulk.

For the auto-support system, this hierarchy lets us answer questions like:

- "What is the **largest unsupported volume** that eventually holds this whole section up?"
- "If I support the parent’s base, are the children automatically supported?" (often yes).

### 6.3 Why we kept parents but hide some of them

- Some parent islands exist mainly as a **bookkeeping node**:
  - Their lower layers are often fully supported by other islands below.
  - They do not introduce a new unsupported base; they just represent the merged body.
- Showing red blobs for these parent volumes is **visually confusing**:
  - They appear as huge red slabs that aren’t true overhangs.
  - They distract from the real unsupported bases that actually need supports.

Our solution:

- We keep the full hierarchy and volume data for every island for later features (like auto-support).
- The overlay now focuses on **true leaf islands and true unsupported seeds** when deciding where to place blobs.

---

## 7. Visual Layers: Voxels, Blobs, and Labels (Common-Language View)

There are three main visual tools for understanding islands:

- **Voxel view** – shows each island as differently colored “LEGO blocks”.
- **Overlay blobs** – red (or colored) 3D chunks sitting at island bases.
- **Debug ID labels** – floating text like `#284` that tells you which island you’re looking at.

### 7.1 Voxel colors

- Each island ID gets a **unique color** in the voxel view.
- As you move up through the model:
  - If you stay inside the same island, the color stays the same.
  - If the color changes, it means the tracker decided that this region belongs to a **different island ID**.
- This is incredibly useful for spotting logic mistakes:
  - If you see a **continuous piece of geometry** where the color changes, the tracker split that body into multiple islands.
  - Sometimes that is correct (a new overhang starts above an existing part).
  - Other times, it is wrong (a “top cap” resting directly on existing solid should stay the same color).

### 7.2 Blob overlay

- Blobs are intended to answer: **“Where does this island actually start unsupported?”**
- We place blobs at each island’s **base footprint**:
  - Down at the layer where the unsupported pixels **first appear**.
  - The blob is then extruded upward a small number of layers so it is visible.
- After recent fixes, blobs are now only created for:
  - Islands that are **true unsupported seeds** (they have a real overhang start).
  - Islands that are **leaf nodes** in the parent/child graph (no children beneath them).
- this combination dramatically reduces noisy blobs from merge parents and always-supported internal volumes.

### 7.3 Debug island ID labels

- Each island marker can have a floating `#ID` label above its base.
- These labels are small, green, and slightly above the blob.
- They are crucial for debugging:
  - You can match an ID seen in the voxel view to the blob and to the internal data.
  - You can quickly see which voxel colors correspond to which islands and whether two differently colored regions are **actually** different IDs.

---

## 8. The Red Blob Bug – What Was Wrong (Common-Language)

Originally, several issues combined to create confusing red overlays.

### 8.1 Missing markers for valid islands

- Some genuine overhangs showed voxels but **no red blob**.
- Cause:
  - The overlay’s base-layer logic relied on older arrays (`baseLabels`, `firstHit`, `compBase`) that were not fully in sync with the **final** island labels after merges and filtering.
  - If an island’s base got remapped or started above other geometry, the overlay sometimes failed to find its base pixels.
- Fix:
  - The blob logic was updated to use `islandLabelsPerLayer` (the same data used by the voxel view) to find the actual layers and pixels for each island.
  - Now, if the voxel system sees an island, the overlay can reliably find its footprint and produce a marker.

### 8.2 Huge red sheets from parent islands

- In earlier versions, many large red slabs showed up under the model.
- These were often **parent islands** that represented merged geometry, not real unsupported bases.
- Causes:
  - The base layer for some islands was computed from temporary merge placeholders.
  - Parent islands’ lower boundaries were being treated like overhangs, even when they were fully supported.
- Fixes:
  - The overlay now prefers each island’s `compBase` or its inherent `firstLayer` when locating its base, falling back to label data only when necessary.
  - Blobs are rendered **only for leaf islands** (those with no children). Parent islands that mainly collect merged volume are skipped for blob rendering.
  - Result: the huge red sheets mostly disappeared, leaving clearer markers for true unsupported islands.

### 8.3 Top caps becoming separate islands

- In some models, a large island (for example, a blue body) would grow upward and then its top caps would switch to a **different island color** in the voxel view.
- These caps got their own island ID and therefore **their own red blob**, even though they were simply the top of the same supported tower.
- Intuitively:
  - They never started in mid-air.
  - They always sat directly on existing solid from the same body.

This exposed a deeper issue in the **IslandTracker** logic.

---

## 9. IslandTracker – What Changed and Why It Works Now

This section first explains the new behavior in common language, then in a more technical way.

### 9.1 Common-language description of the fix

When the tracker processes each new layer, it looks at each solid chunk and asks:

1. **Does this chunk overlap an existing island from the layer below?**
2. If yes, is it one island or several?
3. If no, we *used to* assume it was a brand-new island.

The key mistake was step 3:

- Some chunks did not overlap any **active** islands below, because the previous islands had been marked "complete" during a merge or re-parenting.
- However, they still sat right on top of **solid material that belonged to those completed islands**.
- The tracker treated these caps as brand-new islands, causing color changes and extra blobs.

The new behavior adds more nuance:

- The tracker now distinguishes between:
  - "No overlap with any island at all" (truly floating → real new island).
  - "No overlap with *active* islands, but overlap with previously completed parents/placeholders" (top caps sitting on an existing body).
- In the second case, the tracker:
  - Follows the parent chain upward to find the **ultimate parent island** of the overlapping region.
  - Treats the current chunk as a **continuation of that parent**, not a brand-new island.

What this achieves visually:

- Continuous towers of geometry (the "blue body" example) now keep the **same island ID** all the way up.
- Their top caps no longer flip color in the voxel view.
- No extra red blobs appear for those caps, because they never represent a new unsupported start.

At the same time:

- True new overhangs that appear above existing geometry **still** get their own islands and blobs.
- The full parent–child hierarchy and per-layer area/volume accounting remain intact for later auto-support logic.

### 9.2 Technical summary of the tracker change

In more technical terms, within the `IslandTracker` layer-processing logic:

- For each solid component on the current layer, we compute:
  - `prevIds` – the set of island IDs whose pixels this component overlaps in the **previous layer’s island label grid** (using a small neighborhood search).
  - `activePrevIds` – the subset of `prevIds` whose islands are currently marked as `active`.

The decision rules are now:

- **If `activePrevIds` has more than one ID**:
  - Treat as a merge event, create (or continue) a merge placeholder, and update pending merge tracking as before.

- **If `activePrevIds` has exactly one ID**:
  - Treat as a straightforward **continuation** of that island.
  - Extend its `lastLayer`, add area for this layer, and update `maxAreaMm2` if needed.

- **If `activePrevIds` is empty but `prevIds` is not empty**:
  - New behavior:
    - Recognize that this component overlaps islands that are *not* active anymore (they may have been marked complete or replaced by a merge parent), but their material still exists below.
    - Resolve one of these IDs to its **ultimate ancestor** by following `parentId` links until there is no further parent.
    - Assign the solid component to that ancestor island ID.
    - Update that ancestor’s area and `lastLayer` accordingly.
  - In other words, this is now treated as a **continuation of the existing body** rather than a distinct island.

- **If both `activePrevIds` and `prevIds` are truly empty**:
  - This is a genuine **new unsupported seed**.
  - Create a new island ID, starting its lifetime at this layer.

This change means that components resting on previously completed parents or placeholder chains no longer get promoted to separate islands; they merge logically into their parent’s volume.

---

## 10. How the Overlay Uses the Improved Data

With the tracker fix in place, the overlay logic becomes much simpler and more trustworthy.

### 10.1 Which islands get blobs now

The blob computation function now effectively follows these rules when deciding whether to render a marker:

- Only consider islands that:
  - Survive all filtering (min area, placeholder removal).
  - Are **leaf islands** (no `childIds`).
  - Have a valid base layer according to `compBase` or `firstLayer`, cross-checked with `islandLabelsPerLayer`.

If any of these checks fails (for example, no pixels are found at the supposed base layer), the island simply **does not get a blob**, but it still exists in the data for metrics and future tools.

### 10.2 Alignment with voxel view

- Both the voxel view and the overlay now rely on the same underlying `islandLabelsPerLayer` data.
- This means:
  - If voxels show an island with a particular ID at a certain height, the blob logic can always find its pixels.
  - Discrepancies between voxel colors and blob positions should now almost always point to a real bug either in coordinate mapping or in the tracker, not in stale base-layer metadata.

### 10.3 Why this matters for auto-support later

Because the tracker and overlay now agree on where islands start and how they propagate:

- We can trust each island’s:
  - **Volume** (sum of per-layer areas × layer height).
  - **Largest cross-section** (`maxAreaMm2`).
  - **Parent/child** chain (who feeds into whom).
- The red blobs give a clean, focused view of **true unsupported bases** rather than every internal or merged volume.

This is exactly the information an automatic support algorithm will need:

- It can ask: "Show me all leaf islands that start unsupported and exceed a certain area or volume" and then plan supports based on their base footprints and local orientation.

---

## 11. Practical Debugging Checklist (Updated)

When something looks wrong in the island view, you can now debug in this order:

- **1. Voxels first**
  - Check if a continuous piece of geometry (visually) is all one color.
  - If colors change in a place that is clearly supported from below, the tracker might still be splitting islands.

- **2. Compare IDs with labels**
  - Turn on Island ID labels.
  - Confirm that the ID on the blob matches the voxel color you expect.
  - If a cap region has a different color and ID but should not, that is a tracker-level bug.

- **3. Check blob presence**
  - If voxels show an island but there is no blob:
    - The base-layer detection for that island might be off.
    - Or the island might have been filtered out by area or hierarchy rules (non-leaf parent, below threshold, etc.).

- **4. Check parent/child relationships**
  - For suspicious islands, inspect their `parentId` and `childIds` in the debug data.
  - If a small cap is marked as a new, separate island with no real unsupported start, this points directly to tracker behavior to investigate.

- **5. Only then suspect rendering**
  - If IDs, layers, and base pixels all look correct, but visuals still look wrong, the issue is probably in:
    - World-space coordinate mapping.
    - Clipping planes.
    - Depth testing / renderOrder.

This updated overview, together with the tracker fixes, provides a solid baseline to revisit and extend the island system later (for example, when implementing fully automatic support generation).

---

## 12. How This Feeds a Future Auto-Support System

This section explains how the existing island scan and hierarchy are designed to feed a future automatic support feature.

### 12.1 Common-language view

When placing supports automatically, the system needs to answer questions like:

- "Which parts of the model **truly cannot print without supports**?"
- "Which unsupported chunks are **big and risky**, and which are tiny and maybe ignorable?"
- "If I support **this base**, does it automatically take care of several other pieces above it?"

The island scan already provides the ingredients for these decisions:

- **Island bases and footprints**
  - Each island has a well-defined base layer and base footprint in pixel/grid space.
  - This footprint can be projected onto the model surface to find good support anchor regions.

- **Area and volume**
  - For each island we know:
    - Total volume (how much material hangs off this unsupported start).
    - Largest cross-section (`maxAreaMm2`) – a proxy for how wide the island gets.
  - Larger volume or area usually means higher risk and higher priority for support.

- **Parent/child hierarchy**
  - Each child island eventually merges into some parent.
  - Supporting a parent’s base can indirectly support all of its children.
  - An auto-support tool can use this to avoid redundant supports and instead target **key parent islands**.

- **Leaf islands and true seeds**
  - Leaf islands that start unsupported and never become a parent are often the **actual print risks**.
  - Focusing on these can keep the support plan simple and targeted.

- **Voxels and overlays for explanation**
  - Voxels and blobs give a clear, visual explanation for why the auto-support module is recommending certain supports.
  - When users see a large red blob and matching voxel island, it is obvious that this is a chunk that needs attention.

In short, the island system turns the raw mesh into a set of **support-relevant chunks** with sizes, footprints, and relationships – exactly what an auto-support tool needs.

### 12.2 Technical view – which fields are important

An auto-support module would primarily consume these pieces from the current data model:

- From `ScanResults`:
  - **`grid`** – maps pixel coordinates back to world space so supports can be positioned correctly.
  - **`islandLabelsPerLayer`** – per-layer RLE label grids that show where each island exists.
  - **`compBase`** – base layer index for each island ID.
  - **`firstHit` / `lastHit`** – help locate where the model first/last appears at each pixel.
  - **`baseLabels` / base footprints** – compact representation of which pixels belong to island bases.

- From each `Island` object:
  - **`id`** – stable identifier used everywhere (voxels, overlay, debug).
  - **`firstLayer` / `lastLayer`** – vertical extent.
  - **`parentId` / `childIds`** – hierarchy of merges.
  - **`totalVolumeMm3` (or equivalent)** – integrated volume over all layers.
  - **`perLayerAreaMm2`** – area per layer for fine-grained analysis.
  - **`maxAreaMm2` and `maxAreaLayer`** – where the island is widest.
  - **Status flags** – whether the island is active, complete, or a resolved placeholder.

### 12.3 How an auto-support algorithm could use this

At a high level, an auto-support pipeline might:

1. **Filter islands to candidates**
   - Consider only islands that:
     - Start unsupported (true seeds).
     - Are leaf islands, or important parents whose children depend on them.
     - Exceed user-configurable thresholds for volume or max area.

2. **Rank islands by risk / importance**
   - Compute a score per island based on:
     - Volume (bigger chunks are more critical).
     - `maxAreaMm2` (wide spans may be harder to print).
     - Height from the build plate (higher islands can be more fragile).
   - Optionally propagate scores through the parent/child graph, so a key parent that carries many children gets a higher priority.

3. **Derive support target regions**
   - For each chosen island, use its base footprint:
     - Start from `compBase[id]` to find the base layer.
     - Use `islandLabelsPerLayer` at that layer, combined with `grid`, to locate base pixels in world space.
     - Convert those pixels to patches on the mesh surface for potential support anchors.

4. **Place support structures**
   - Based on printer and user settings, generate one or more support structures that:
     - Start from the build plate or other supported surfaces.
     - Terminate within the island’s base footprint region.
   - The geometry of supports would be handled by a separate module, but it would rely on these well-defined base regions.

5. **Explain and visualize decisions**
   - Use existing voxel colors and blobs to show:
     - Which islands were chosen.
     - Where supports will attach.
   - This gives users a clear visual connection between the **data-driven decision** and the **3D model**.

Because the island scan already encodes the model into discrete unsupported volumes with rich metadata, future auto-support logic can remain relatively clean: it will focus on ranking islands and designing supports, rather than rediscovering where overhangs are.

