---
issue: dragonfruit-kb-harvest-2026-08
date: 2026-08-18
subsystem: organic-cut
---

# Organic cut and tenon registration

## Scenario 1: Place a contour cut with tenons

Given a loaded model on the build plate
When I activate the cut tool and place a contour cut plane
Then the cut preview shows the two halves separated
And registration tenons appear at the cut boundary

## Scenario 2: Adjust tenon lean and roll

Given a contour cut with tenons visible
When I select a tenon and drag the lean handle
Then the tenon tilts along the lean axis without drifting in roll
And releasing the handle freezes the lean angle

## Scenario 3: Tenon gizmo visibility

Given a contour cut with tenons
When I hover over the cut region
Then tenon gizmos are always visible (not occluded by the model)
And each tenon shows a 2-ring gizmo with fixed-relative handles

## Scenario 4: Cut preview caching

Given a contour cut placed on a model
When I adjust cut parameters that don't change geometry (e.g. tenon clearance)
Then the preview updates without a full Rust round-trip (cache hit)
And when I change geometry-affecting parameters (plane position)
Then the preview recomputes via Rust (cache miss)

## Scenario 5: Commit a cut

Given a contour cut with tenons positioned to satisfaction
When I commit the cut
Then the model splits into separate parts
And each part has its tenon/mortise registration features
And undo returns the model to the pre-cut state with one action
