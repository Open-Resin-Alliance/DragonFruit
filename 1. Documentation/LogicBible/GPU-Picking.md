# GPU Picking (Color Picking) — Logic Bible

## Plain-language overview
- **Goal**: Whatever looks on top under your mouse is exactly what we detect, every time.
- **What it is**: A tiny, hidden camera check under the mouse. Each pickable thing paints itself a unique solid color for this check (not what you see on screen). We read that color to know which thing is on top.
- **Why it fixes our current issue**: Our old “laser” method (raycast) can disagree with what you see when special draw rules are in play (e.g., overlays, transparent looks, drawing order). This method matches the camera’s view by design—so highlight, snapping, and selection all agree.

## How it works (non-technical)
1. The mouse moves.
2. We take a tiny “snapshot” right under the cursor that includes only things we want to interact with (model, supports, joints, raft, and gizmo handles when visible).
3. In this snapshot, each item paints itself with its own color ID.
4. We look at a very small patch (3×3 pixels). The color that appears the most wins. If tied, we prefer the center; if still tied, we keep the last winner to avoid flicker.
5. We share that single answer (“what’s under the mouse”) with all features (highlight, snapping, selection).

## What counts as pickable
- **Pickable (default = yes)**: model, supports, joints, raft.
- **Gizmo handles**: pickable only when the gizmo is visible (active).
- **Not pickable by default**: decorative overlays, outlines, helper grids, visual effects that are not directly interacted with.

## Update frequency and performance
- **Update rate**: 30 times per second during normal hover; 60 times per second during drags or very fast mouse movement.
- **Only when needed**: We update only when the mouse moves; we pause when idle.
- **Global switch**: The system is ON by default. It turns OFF during heavy tasks (e.g., island scanning) and turns back ON afterwards.
- **Efficiency**: Because the snapshot is tiny and uses simple flat colors, it runs fast and is comparable to (often better than) a single raycast per update—while being more reliable.

## Why this is reliable
- It follows the same rules the camera uses to decide what you see: front-most wins.
- No split-brain behavior: all features read the same single answer.
- Stable near edges thanks to the 3×3 patch and tie-breakers.

## Expected behavior in common situations
- **Hovering an object**: The object that visually appears on top highlights consistently.
- **Snapping**: Uses the exact same “who’s under the mouse” result that drove highlight, so no more mismatch.
- **Gizmo visible**: Gizmo handles win the mouse so you can grab them; when hidden, they can’t block interaction.

## Controls and defaults
- **Defaults**:
  - Pickable flag = true for real objects; false for overlays.
  - Use 3×3 patch (majority wins, center bias, keep previous on ties).
  - 30 Hz for hover, 60 Hz for dragging/high-speed moves.
  - Global ON by default; auto-OFF during heavy operations.
- **Config toggles**:
  - Enable/disable GPU picking globally.
  - Switch between 1×1 and 3×3 mode if needed.
  - Include/exclude gizmo handles when visible.

---

## Technical appendix (concise)

### Terminology
- GPU picking / color picking / selection buffer / pick buffer: offscreen render where each pickable draws with a unique color ID.

### Render pass
- Offscreen framebuffer sized 3×3 (or 1×1).
- Same camera, transforms, clipping planes, and render order as the main view.
- No lighting, shadows, postprocessing; flat unlit colors only.
- Only pickable layers are drawn.

### Object identity
- Each pickable is assigned a stable integer ID; encoded into RGB.
- If using instancing, encode instanceId so each instance can be identified.

### Readback and decision
- Read the 3×3 pixel colors.
- Majority vote → winner.
- Tie-breakers: center pixel; then previous winner.

### Publication
- Store the result as the single authoritative `pointerHit` for the frame.
- Consumers (highlight, snapping, selection) subscribe to this value rather than performing their own queries.

### Performance controls
- Throttle to 30–60 Hz based on pointer state.
- Update only on pointer move; pause when idle.
- Reuse framebuffer/materials; avoid per-frame allocations.
- Global enable/disable switch for heavy operations (e.g., island scanning).

### Edge cases and policies
- Gizmo handles are rendered in the pick pass only when visible (active).
- Decorative overlays/helpers are excluded from the pick pass.
- Transparent-looking materials should render as opaque in the pick pass (depth write on) to preserve front-most behavior.
- Postprocessing is not part of the pick pass.

### Fallback
- This fallback applies only when the tiny pixel read under the mouse is flaky or slow, while the scene itself still renders normally.
- In that narrow case, temporarily use a single CPU raycast (with the same include/exclude list and clipping) to keep hover usable, then switch back to GPU picking when stable.
- If the scene cannot render at all (GPU totally unavailable and no software renderer), there is nothing to pick—no fallback is meaningful.
- Optional: If our GPU picking proves fully reliable on target devices, we can skip implementing this fallback and enable it later only if needed.
