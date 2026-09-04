---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
subsystem: hollowing
---

# Hollowing workflow

## Scenario 1: Apply hollowing to a solid model

Given a loaded solid model
When I activate the hollowing tool and set wall thickness
Then a voxel preview shows the hollow interior
And the preview respects resource-aware caps (reduced resolution on large models)

## Scenario 2: Cavity detection

Given a hollowed model
When the hollowing operation completes
Then cavities (enclosed voids) are detected and highlighted
And I can place drain holes to connect cavities to the exterior

## Scenario 3: Blocker placement

Given a hollowed model with the hollowing tool active
When I place a blocker region
Then the blocked area retains its original solid geometry
And the blocker boundary is clean (no stray voxels at the interface)

## Scenario 4: Async lasso selection

Given a hollowed model in the hollowing tool
When I draw a lasso selection around a region
Then the selection completes asynchronously without freezing the UI
And the selected region can be toggled between hollow and blocked

## Scenario 5: Slice-path blocker integrity

Given a hollowed model with blockers placed
When I slice the model
Then blocker regions produce solid layers (no hollow artefacts)
And the transition between hollow and blocked regions is watertight
