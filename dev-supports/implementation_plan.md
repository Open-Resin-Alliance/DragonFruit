# Implementation Plan: Comprehensive Placement Chain Validation

Resolve the support tip/cone penetration and routing issues by deterministically closing the validation loopholes across all pathfinding, preview, and grid-mode solvers.

## Loophole Analysis & Proposed Changes

Our investigation has revealed four distinct loopholes in the support placement chain where validation is bypassed:

1. **A* Wide-Pass Bypass**: When the wide A* pass (fallback) succeeds, it returns a candidate immediately without running the final validation block at the bottom of `calculateSmartPlacementV2` (which contains the `isSocketEmbedded` and `raycastSegmentBlockedBetween` checks).
2. **Preview Mode Bypass**: In `isPreview: true` mode, the solver returns the path immediately without checking for socket embedding or segment collisions, leading to false-positives (valid previews) on thin features during hovers.
3. **Grid-Mode Trunk/Branch Bypass**: Grid-mode placement (`isGridMode === true`) disables `calculateSmartPlacementV2` and relies on `trunkCollidesWithMesh` / `branchCollidesWithMesh`, which only check segment collisions but never check if the socket itself is embedded.
4. **Grid-Mode Leaf Bypass**: Auto-leaf placements in grid mode do not pass `mesh` to `tryBuildAutoLeafDecision`, preventing any collision or socket embedding checks.

---

### Component-Level Changes

#### [MODIFY] [GridAStar.ts](file:///x:/Antigravity/ag-DF-2/DragonFruit/src/supports/PlacementLogic/Pathfinding/GridAStar.ts)
* **Start Node Blockage Check**:
  * In `gridAStar`, check if the start node is embedded before starting search:
    ```typescript
    const startDist = sdf.distanceAt(startPos.x, startPos.y, startPos.z);
    if (startDist < safetyClearance) {
        return { reached: false, expansions: 0, stagnated: true, warmState: null };
    }
    ```
* **Warm-Start Empty openEntries Fix**:
  * Modify `canWarmStart` to verify that `warmStart.openEntries.length > 0`:
    ```typescript
    const canWarmStart = warmStart &&
        warmStart.openEntries.length > 0 &&
        Math.abs(warmStart.socketPos.x - startPos.x) < step * 2 &&
        Math.abs(warmStart.socketPos.y - startPos.y) < step * 2 &&
        Math.abs(warmStart.socketPos.z - startPos.z) < step * 2;
    ```

#### [MODIFY] [SmartPlacementV2.ts](file:///x:/Antigravity/ag-DF-2/DragonFruit/src/supports/PlacementLogic/Pathfinding/SmartPlacementV2.ts)
* **Unify Fine & Wide Pass Processing**:
  * Refactor `calculateSmartPlacementV2` to extract the path waypoints and base candidates from either the fine or wide pass into common variables (`pathJoints`, `bestBase`, `unsnappedBottomPos`), allowing both passes to fall through to the unified post-processing and final validation block.
* **Enforce Raycast Validation in Preview**:
  * In the `isPreview` early-out block, run lightweight `isSocketEmbedded` and `raycastSegmentBlockedBetween` checks before returning, returning a `COLLISION_WITH_MODEL` error if they fail.

#### [MODIFY] [gridPlacement.ts](file:///x:/Antigravity/ag-DF-2/DragonFruit/src/supports/PlacementLogic/Grid/gridPlacement.ts)
* **Check Socket Embedding in Grid Mode**:
  * Import `isSocketEmbedded` from `../CollisionUtils`.
  * Validate that `snappedCandidate.route.socketPos` is not embedded using `isSocketEmbedded` in `decideGridPlacement` when placing a trunk.
  * Validate that the approximated socket is not embedded using `isSocketEmbedded` in `branchCollidesWithMesh`.
  * Pass `mesh` to `tryBuildAutoLeafDecision` and validate that the auto-leaf socket is not embedded using `isSocketEmbedded` before accepting the leaf.

#### [MODIFY] [branchBuilder.ts](file:///x:/Antigravity/ag-DF-2/DragonFruit/src/supports/SupportTypes/Branch/branchBuilder.ts)
* **Branch Socket Embedding Check**:
  * Import `isSocketEmbedded` from `../../PlacementLogic/CollisionUtils`.
  * In `isConePlacementClear`, reject candidates where `isSocketEmbedded(socketPos, cone.pos, mesh)` is true.

---

## Addendum: Support Debug Logs Evidence Analysis & Root Cause Proof

### The Symptom in the Debug Logs
The user's debug logs documented the following placement chain run:
```
preflight: straight=blocked roots=fit | active socket=(-7.77, -4.86, 24.11)
astar:fine: Fine A* failed after 0 expansions
astar:wide: Wide A* reached in 55 expansions
```
This output displays two critical anomalies:
1. The **Fine A*** pass fails immediately with **0 expansions**.
2. The **Wide A*** fallback pass successfully runs in 55 expansions, but when the resulting route is hovered or clicked, the support penetrates directly through the model walls.

### The Root Cause Proof (Deterministic Chain of Defects)

#### 1. Defect 1: The Fine A* 0-Expansion Warm-Start Bug (`GridAStar.ts`)
* When a pathfinding search succeeds, it returns a `warmState` object containing the search frontier (`openEntries`) to enable frame-to-frame coherence on subsequent hovers.
* Since a successful search reached the goal, the open set is empty. The returned `warmState` therefore records `openEntries: []`.
* On the next frame, if the cursor has moved slightly (within `step * 2 = 1.0mm`), `canWarmStart` evaluates to `true`.
* The pathfinder attempts to warm-start using the cached state, initializing `openSet` directly from the empty `warmStart.openEntries`.
* Because `openSet` is empty, the A* search loop terminates instantly without doing a single expansion, reporting failure (`reached: false`) with `expansions: 0`.
* This matches the log symptom perfectly.

#### 2. Defect 2: The Wide A* Fallback Pass Physical Raycast Validation Bypass (`SmartPlacementV2.ts`)
* Since the fine pass failed instantly, the solver falls back to the Wide A* pass.
* The Wide A* pass is always executed with `warmStart: null` (cold start), allowing it to bypass the warm-start bug and successfully find a route.
* However, upon a successful wide-pass search, the solver executes an early return block for both preview (`isPreview === true`) and click placement (`_angleOk === true`):
  ```typescript
  if (isPreview) {
      publishPathfindingDebugSnapshot();
      return { ... };
  }
  ```
* These early returns bypass the entire post-processing and final validation pipeline at the bottom of `calculateSmartPlacementV2`.
* Critically, this skips the physical raycasting checks (`raycastSegmentBlockedBetween`) that serve as the last line of defense against model clipping.
* Since the course A* pass only checks grid-aligned endpoints during preview to save performance, bypassing the physical raycast allows paths that clip thin geometry or walls to be drawn as valid previews and placed.

### Remediation Action Items
1. **Fix Warm-Start Bug**: Ensure that `canWarmStart` requires `warmStart.openEntries.length > 0`.
2. **Unify Placement Pipeline**: Refactor `calculateSmartPlacementV2` to funnel both the fine-step and wide-step results into the same final post-processing and physical raycast validation block.

---

## Verification Plan

### Automated Tests
* Run `npm run test` to verify that all existing tests pass.
* Add a test case for grid-mode socket embedding.
* Add a test case for wide A* pass final validation.
