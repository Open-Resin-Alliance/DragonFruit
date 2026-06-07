# Support Pathfinding V3

This page documents the support pathfinding pipeline used by `SmartPlacementV2`.

It focuses on:

- the order in which rules run
- what each rule is allowed to change
- the mathematical criteria used during rescue and validation
- how debug tuning changes the solver when enabled

## Overview

Support pathfinding resolves a placement from a user hover/click into a valid support chain:

1. choose a socket position near the model contact point
2. determine whether the cone is valid or needs rescue
3. confirm the shaft can reach the roots plane without collision
4. search for a routed chain when the straight path fails
5. simplify and revalidate the route
6. snap the base to a legal committed root location

The solver is intentionally layered so cheaper checks run first and more expensive checks only run when necessary.

## The pathfinding chain

The main solver path is executed in this order:

1. **Standard placement baseline**
   - compute the default socket and bottom position
   - if the placement is already invalid by a non-routing rule, return immediately

2. **SDF cache refresh**
   - refresh the per-mesh signed-distance cache matrix
   - all subsequent collision checks reuse this cache

3. **Cone feasibility and cone rescue**
   - test whether the nominal contact cone is clear
   - if blocked, try cone-clear socket seeds and rescue variants

4. **Straight path checks**
   - check direct shaft clearance
   - check root disk fit at the base
   - if both pass, return a straight support

5. **Spatial fast-fail caches**
   - if the current socket is already known to stagnate, skip A*
   - if preview mode already exhausted budget near this position, skip A*

6. **Fine A***
   - run the 0.25 mm grid search with the fine budget

7. **Wide A***
   - if fine A* fails, retry with the 0.6 mm grid and a wider budget

8. **Post-search simplification and straightening**
   - remove unnecessary joints
   - optionally attempt zero-joint or one-joint reductions

9. **Final validation**
   - ensure each chain segment is collision-free
   - ensure final angles and crack-span rules still hold

10. **Commit base snapping**
    - resolve the best legal root position for the final chain

## Rule ordering and priority

The solver is deliberately greedy about cheap rejection first.

### 1. Cone rules

The cone is the first major gate because if the support cannot legally touch the model, routing effort is wasted.

Cone rescue may shift the socket laterally before any routing work begins.

### 2. Straight path rules

If the cone is valid, the solver checks whether the shaft can go straight down without clipping and whether the roots disk fits at the base.

This is the cheapest fully valid outcome, so it wins immediately if it passes.

### 3. Routing rules

Only after straight placement fails does the solver spend budget on A* and rescue geometry.

### 4. Final safety gates

Even a candidate that reaches the goal still gets rechecked segment-by-segment.

This prevents a route from surviving due to search heuristics alone.

## Core geometry rules

### Shaft clearance

The solver uses a clearance value:

$$
\text{clearance} = \frac{\text{shaft diameter}}{2} + \text{collision avoidance margin}
$$

This clearance is passed into segment collision checks.

### Roots fit check

The roots are valid at $(x, y)$ only if the swept root disk volume does not intersect the model.

At a high level, the roots volume is sampled across the disk section and the cone section, and a position is rejected if any sampled point is blocked.

### Straight path rule

Let $S$ be the socket position and $R$ be the root-top target.

The straight path is valid if:

$$
\neg \text{segmentBlocked}(S, R)
$$

and

$$
\neg \text{rootsBlocked}(R_{xy})
$$

If both are true, the support is returned with no routing joints.

## Cone rescue math

The cone rescue system tries to keep the tip shape short and near-normal while still finding a usable socket.

### Cone length

Let the cone start after tip thickness compensation be $C_0$ and the socket be $S$.

$$
L_{cone} = \lVert S - C_0 \rVert
$$

The added cone length is:

$$
\Delta L = \max(0, L_{cone} - L_{ref})
$$

where $L_{ref}$ is the original reference cone length.

### Cone angle

Let $n$ be the surface normal and $a$ be the final cone axis.

The angle from surface normal is:

$$
\theta = \arccos\left(\operatorname{clamp}(a \cdot n, -1, 1)\right)
$$

converted to degrees.

### Cone penalty score

The cone rescue ranking uses a weighted score that prefers short, minimally distorted cones.

In simplified form:

$$
J_{cone} = J_{angle} + J_{worsen} + J_{length} + J_{direction}
$$

where:

$$
J_{length} = w_1 d + w_2 d^2 + w_3 d^3
$$

with $d$ being the excess cone stretch above the reference length.

The angular terms penalize both absolute shallowness and worsening relative to the nominal cone.

### Stretch limit

The cone is considered over-stretched if:

$$
\Delta L > L_{ref} \cdot r_{max}
$$

where $r_{max}$ is the cone stretch ratio cap.

### Disk axis limit

For disk tips, the final cone axis angle must also satisfy:

$$
\theta \le \theta_{max}
$$

where $\theta_{max}$ is the disk cone axis limit.

## Search envelope math

The routing envelope determines how far the solver is allowed to search laterally.

### Envelope construction

Let the vertical span be:

$$
V = \max(0, z_{socket} - z_{rootTop})
$$

The unclamped lateral limit is:

$$
L_{unclamped} = \max\left(L_{min},\; 15\,\text{spacing},\; 3V\right)
$$

The final lateral cap is:

$$
L_{max} = \min(L_{hard}, L_{unclamped})
$$

The rescue sweep radii are then generated from a fixed sweep table and clamped so they do not exceed $L_{max}$.

## A* search math

### Grid steps

The solver uses two search grids:

- **fine pass**: $0.25\,\text{mm}$
- **wide pass**: $0.6\,\text{mm}$

The wide pass is a fallback for large detours and rescue routes.

### Expansion budgets

The number of allowed expansions scales with grid step so the solver keeps roughly comparable search reach:

$$
E = \operatorname{round}\left(\frac{B_{2mm} \cdot 2}{s}\right)
$$

where:

- $B_{2mm}$ is the base budget expressed at 2 mm step size
- $s$ is the active grid step size

### A* objective

The search is still a feasibility search first and a quality search second.

It prefers routes that:

1. reach the root target
2. stay collision-free
3. avoid excessive lateral drift
4. avoid upward motion where possible
5. remain valid under the final angle gates

## Final route validation

After A* and simplification, the solver validates the final chain segment by segment.

Let the final points be:

$$
[P_0, P_1, \dots, P_n]
$$

with $P_0$ the socket and $P_n$ the root-top target.

For every segment $(P_i, P_{i+1})$:

$$
\neg \text{segmentBlocked}(P_i, P_{i+1})
$$

and

$$
\angle(P_i, P_{i+1}) \le \angle_{max}
$$

must hold.

## Crack-span rule

If the route has two or more joints, the solver checks the routing Z span:

$$
Z_{span} = z_{socket} - z_{lowestJoint}
$$

If:

$$
Z_{span} < Z_{min}
$$

the route is rejected as too crack-like.

This prevents supports from being squeezed through narrow voids that are likely to be unstable or physically misleading.

## Debug tuning behavior

The debug tuning mode activated by `M` is intentionally separate from the baseline defaults.

### Baseline defaults

The current baseline already uses the tuned values for practical pathfinding.

### Extra debug tuning

When enabled, `M` applies an extra layer that makes the solver more forgiving:

- slightly larger search envelope
- slightly more rescue radii
- slightly larger cone seed range
- extra A* expansions
- lower collision avoidance margin
- slightly looser max segment angle
- looser crack-span rejection
- more permissive cone stretch and cone-axis gating

This mode is for interactive exploration and tuning, not for permanently lowering production safety rules.

## Blocked-path diagnostics

When a path fails, the debug overlay records the main reason(s) and suggests which rule family to tune:

- cone blocked
- cone rescue failed
- A* stagnated
- A* hit expansion budget
- no valid root target reached
- base resolution failed
- crack-span rejection
- angle validation failure
- segment collision in final validation

These are designed to be actionable rather than just descriptive.

## Practical tuning order

If a model still fails, tune in this order:

1. **cone rescue** first
2. **search envelope and budgets** second
3. **clearance and angle gates** third
4. **crack-span rule** last

That order gives the best chance of improving success without hiding real collision problems.

## Implementation references

- `src/supports/PlacementLogic/Pathfinding/SmartPlacementV2.ts`
- `src/supports/PlacementLogic/Pathfinding/pathfindingDebugState.ts`
- `src/components/scene/SupportPathfindingDebugOverlay.tsx`

## Summary

Support Pathfinding V3 is a layered feasibility solver:

- geometry first
- routing second
- simplification and validation last

The new debug tooling makes it easier to see which rule blocked a placement and whether the solver should be tuned by adjusting cone rescue, search breadth, or final safety gates.