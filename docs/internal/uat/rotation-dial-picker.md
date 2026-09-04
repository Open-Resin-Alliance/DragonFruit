---
issue: dragonfruit-103-2
date: 2026-07-29
kind: verification
---

# UAT: Rotation dial — armed tick picker

Manual verification for the protractor-dial rotation interaction
(issues #103/#104). Every scenario here guards a bug that shipped to
hands-on testing and was only caught there.

## Scenario: Arm, aim, commit

**Rationale.** The core interaction contract, decided across four hands-on
iterations. One click on a tick rotates by the angle from the dial's 0°
reference — rotation is relative to the dial, not to where the model points.

```gherkin
Given a model is selected in Prepare/Modify
When the user clicks a rotation ring's diamond handle
Then that ring's dial arms (ticks, spokes and 0° reference show; other rings dim)
When the user moves the cursor
Then the selection spoke follows the cursor in the ring plane, sticking to ticks
  And the selected tick is highlighted
  And the readout shows the signed angle from the 0° reference to that tick
When the user clicks
Then the model rotates by exactly the readout angle, in the direction of the arc
  And the dial disarms
```

## Scenario: The armed session survives pointer movement

**Rationale.** Three stacked bugs made commits unreachable: an unconsumed
suppress flag ate the first pick; commit logic inside a setState updater
self-disarmed under StrictMode double-invocation; and mid-aim clicks that hit
no mesh fired the scene's pointer-missed deselect, unmounting the gizmo. All
were invisible to unit tests (no R3F mounting) and found only by hand.

```gherkin
Given a ring's dial is armed
When the user moves the pointer continuously across the scene for several seconds
Then the dial stays armed and the selection spoke keeps tracking
When the user clicks a tick
Then the rotation commits on that first qualifying click — not the second, not the third
  And the model remains selected throughout the armed session
```

## Scenario: Orbit and cancel while armed

**Rationale.** Aiming must not capture the camera. Click-vs-drag is decided by
a 4 px slop; Escape goes through the app hotkey broadcast (direct keydown
listeners are lint-forbidden).

```gherkin
Given a ring's dial is armed
When the user drags (beyond 4 px) anywhere in the scene
Then the camera orbits and no rotation is committed
When the user presses Escape or clicks the diamond again
Then the dial disarms without rotating
```

## Scenario: Diamond drag still rotates freely

**Rationale.** Drag-to-rotate was removed entirely at one point and restored on
maintainer feedback — press-and-move on the diamond is a free drag, press-and-
release is the arm toggle.

```gherkin
Given a model is selected
When the user presses a ring's diamond and moves beyond 4 px
Then the model rotates freely following the cursor, and the readout shows the accumulated angle
When the user presses the diamond and releases within 4 px
Then no rotation occurs and the dial arms instead
```

## Scenario: Commit direction matches the arc

**Rationale.** The scene consumer applies emitted rotate deltas negated
(`setFromAxisAngle(axis, -angle)`); the dial's emission must pre-negate or the
model turns against the drawn sweep. Render-side signs are pinned by the
fiducial test; the wire sign is only observable here.

```gherkin
Given a ring's dial is armed
When the user clicks the tick the arc shows at +40°
Then the model rotates +40° in the same rotational direction the arc sweeps
```

---

## Post-harvest additions (2026-08-18)

Scenarios below guard gizmo fixes that landed after the initial 103-2 harvest.

## Scenario: Rotation drag is tied to the starting pointer and button

**Rationale.** A rotation drag must be owned by the pointer and button that
started it. Switching fingers or devices mid-drag caused a detached drag that
could not be committed or cancelled.

```gherkin
Given a model is selected
When the user starts a rotation drag with the left mouse button
Then only that pointer's move events steer the rotation
  And releasing a different button does not commit or cancel
When the user releases the original left button
Then the rotation commits
```

## Scenario: Escape cancels a rotation drag cleanly

**Rationale.** Pressing Escape during a rotation drag previously broke the
tool state, requiring a mode switch to recover.

```gherkin
Given a rotation drag is in progress
When the user presses Escape
Then the rotation is cancelled and the model returns to its pre-drag angle
  And the dial returns to its resting state without errors
  And subsequent rotation interactions work normally
```

## Scenario: Backing off a rotation limit keeps the dial on the mark

**Rationale.** When the dial reaches a rotation limit and the user reverses
direction, the dial snapped to an incorrect position instead of tracking the
cursor back smoothly.

```gherkin
Given a ring's dial is armed and the model is near a rotation limit
When the user aims past the limit (the dial clamps)
  And then reverses direction back within the valid range
Then the dial follows the cursor smoothly without jumping
  And the selection spoke and readout remain consistent
```

## Scenario: Move arrow and scale handle stay on the same side

**Rationale.** The move arrow and scale handle could appear on opposite sides
of the gizmo, making the spatial relationship confusing.

```gherkin
Given a model is selected with the transform gizmo visible
When the camera orbits around the model
Then the move arrow and scale handle remain on the same side of the gizmo
  And they do not flip independently of each other
```
