# Island Volume Analysis - Development Checklist

This plan follows the strict step-by-step logic defined in `Island_Volume_Analysis_Brainstorm.md`.
**Core Principle:** Isolation & Visual Verification. Every step must be visually verifiable before proceeding to the next.

## Phase 1: Foundation & UI Setup
- [x] **1.1 Isolated "Workshop" Environment**
  - *Completed:* Integrated `IslandVolumeAnalysisCard` into the Analysis Mode sidebar.
  - *Note:* Removed the temporary isolated route in favor of direct integration.
- [x] **1.2 Step Controller**
  - *Completed:* Implemented `useIslandVolumeAnalysis` hook to centralize state, progress, and step management.

## Phase 1.5: Optimization Checkpoint 1 (Rendering & Voxelization)
- [x] **1.3 Voxelization Optimization (The "Scanline" Upgrade)**
  - *Completed:* Replaced slow Point-in-Polygon rasterizer with O(Height) Scanline algorithm.
  - *Result:* Instant voxelization even at high resolutions.
- [x] **1.4 Renderer Optimization (The "Shell" Upgrade)**
  - *Completed:* Switched to rendering ONLY surface voxels (Empty Neighbor check).
  - *Completed:* Implemented Geometry Chunking (max 20M indices per chunk) to bypass WebGL limits.
  - *Result:* Capable of rendering 80M+ voxels without crashing.

## Phase 1.6: Optimization Checkpoint 2 (Greedy Meshing & Linear Analysis)
- [x] **1.5 Renderer Optimization (The "Greedy Meshing" Upgrade)**
  - *Completed:* Replaced O(Voxel) mesh generation with O(Segments) **RLE Greedy Meshing**.
  - *Completed:* Fixed winding order to enable **Backface Culling** (FrontSide only).
  - *Completed:* Optimizations: Hoisted Neighbor Lookups, TypedArrays, Zero-GC Buffer access.
  - *Result:* Mesh generation reduced from 30s+ to <1s.
- [x] **1.6 Analysis Optimization (The "Linear Scan" Upgrade)**
  - *Completed:* Optimized `rleLabelComponents` to use Sliding Window finding (O(N) connectivity).
  - *Completed:* Optimized `IslandTracker` to use **Single-Pass Overlap Detection** instead of re-scanning.
  - *Result:* Island identification is now scale-invariant (O(Runs)) rather than scale-dependent (O(Components * Layers)).

---

## Phase 2: Logic Implementation (Step-by-Step)

### Step 2: Island Analysis ("Stool Leg" Logic)
- [x] **Goal: Identify Islands, Trace Volumes, and Handle Merges.**
  - [x] **Logic:** 
    - Initialize Body as ID 1.
    - New IDs for distinct overhangs.
    - Merge = Stop (Revert to ID 1).
  - [x] **Visual Verification:** 
    - [x] Red Overlays (Start Markers).
    - [x] Voxel Colors (ID 1 Neutral, ID > 1 Colored).

### Step 3: Internal Center & Seed Voxel
- [x] **Goal: Find the "Deepest" point inside each volume and mark it as the expansion seed.**
  - [x] **Logic:** "Pole of Inaccessibility" / Chebyshev Center approx. Find point max distance from boundary.
  - [x] **Output:** 
    - `internalCenter`: Vector3 (World Coordinates) for visualization.
    - `seedVoxel`: Grid Coordinates (x,y,z) for expansion algos.
  - [x] **Visual Verification:** Render distinct marker (Star/Orb) deep inside volumes.

#### Step 4: Iterative Voxel Expansion (Simulated Basin Filling)
- [x] **Algorithm:** Multi-Source Breadth-First Search (Push Method).
    -   Seed voxels have distance 0.
    -   Iteratively claim unassigned neighbor voxels (6-connectivity).
    -   "First-to-claim" wins (Voronoi-like boundaries).
- [x] **Visual Optimization:**
    -   **Surface Culling:** `BasinFillSimulator` identifies "Internal" voxels (surrounded by 6 solids) and excludes them from rendering. This reduces the instance count by ~90% (O(Volume) -> O(Surface)).
    -   **GPU DataTexture:** `IslandExpansionVisualization` uses a `DataTexture` to store island IDs and a custom shader to update colors. This moves all state management to the GPU, eliminating CPU-GPU bandwidth bottlenecks.
- [ ] **Visuals:**
    -   [x] Colored cubes expanding from seeds.
    -   [x] "One Mesh per Island" appearance (simulated via shader).
    -   [ ] Verify animation smoothness (60fps target).

### Step 5: Smoothing (Experimental)
- [ ] **Goal: Cleanup jagged voxel boundaries.**
  - [ ] **Logic:** Apply smoothing kernel / cellular automata rule.
  - [ ] **Visual Verification:** Toggle "Jagged" vs "Smooth".
