# Camera Navigation

How the scene camera is driven, and the one invariant that keeps the
orthographic projection working.

## Projections

DragonFruit renders with either a `PerspectiveCamera` or an
`OrthographicCamera`, switched by `CameraProjectionController` in
`src/components/scene/SceneCanvas/SceneCanvasCameraControllers.tsx` (toggle is
the projection hotkey; the mode persists via
`src/components/settings/cameraProjectionPreferences.ts`). Orbit is handled by
`OrbitControls` from `@react-three/drei`.

`docs/adr/0032-camera-fov-projection-switching.md` records the FOV rules that
still hold: the perspective FOV is user-configurable, orthographic framing uses
the fixed `DEFAULT_FOV_DEG` so the slider never changes ortho scale, and
ortho-to-perspective solves camera distance rather than FOV.

## The derived-frustum invariant

An orthographic projection matrix does not depend on camera position, so
translating an ortho camera along its view axis does **not** change apparent
size — only the frustum extents do. The old implementation treated `camera.zoom`
as the navigation state and converted it to and from distance in every framing
path, which is where the cursor-zoom displacement, drag stalls, and runaway
SpaceMouse zoom came from.

The camera still *moves* through space, and what it has dollied past stays
drawn: the depth range is symmetric about the camera and deeply negative
(`ORTHO_NEAR`). That is not a leftover. Because the camera's distance **is** the
zoom, a near plane in front of it cannot work at a wide FOV: at FOV 70 with a
model 60 mm from the orbit target, the camera is already at the model's surface
while the view still shows ~84% of it, so a near plane there starts slicing the
model long before the view looks zoomed in. Symmetric depth is the only range
that keeps the whole scene drawn at every FOV.

The price is that the renderer and a stock raycast disagree by construction: a
pick ray starts at the camera plane and walks forward, so geometry the camera has
moved past is drawn but unreachable under the cursor, and support placement stops
working exactly where the user zoomed in to work. `src/components/scene/camera/pickRay.ts`
pays it: `setPickRayFromCamera` starts a ray at the near plane instead, so a pick
covers the same volume as the render. Every surface-aimed ray goes through it,
and R3F's shared event raycaster is patched to match (`OrthoPickRayAlignment`),
because that is how model hover, support clicks and placement hover resolve.

The camera system has a single ortho scale source: the dolly radius.

```
halfHeight = tan(fov / 2) * radius
radius     = |camera.position - controls.target|
camera.zoom = 1
```

`fov` is the app's live FOV setting, the same value perspective uses;
`ORTHO_REFERENCE_FOV_DEG` is only the fallback when a caller does not pass one.
Both projections therefore share one FOV, so **switching projection is the
identity** — same position, same apparent size, no compensation. (ADR-0032
previously kept ortho on a fixed default FOV; that is superseded here.)

`src/components/scene/camera/orthoDolly.ts` owns this. `syncOrthoFrustum`
derives the frustum from the current position, `applyOrthoFrustum` writes it for
an explicit radius (used by the SpaceMouse controllers), and
`dollyOrthoToCursor` performs a cursor-anchored dolly.

`OrthoFrustumSync` (same file as `CameraProjectionController`) keeps the frustum
in sync: it listens to OrbitControls' `change` event, re-derives on resize, and
runs once per frame as a safety net for programmatic moves that skip
`controls.update()`.

### Rules for camera code

- **Never set `camera.zoom` on the scene ortho camera.** Move `camera.position`
  and `controls.target`; the frustum follows. `zoom` is pinned to 1 by
  `syncOrthoFrustum`.
- **Framing is projection-agnostic.** A controller that lerps position and
  target to a fit distance frames correctly in both modes. `CameraIntroController`,
  `CameraHomeResetController`, `CameraFocusHotkeyController`,
  `CameraModeEntryFramingController`, and
  `src/volumeAnalysis/Islands/cameraFocusHelper.ts` all rely on this — they no
  longer touch zoom.
- **Real dolly lives in `SceneCanvas`.** In ortho, OrbitControls' zoom is
  disabled (`enableZoom={cameraProjectionMode === 'perspective'}`) and the
  `onTrackpadWheel` handler calls `dollyOrthoToCursor`. Perspective keeps
  OrbitControls' native dolly and `zoomToCursor`. Because the ortho path bypasses
  OrbitControls, it checks `controls.enabled` itself: a disabled OrbitControls is
  how every other owner of the camera announces itself (a live SpaceMouse
  gesture, the Home / focus / mode-framing animations), and the wheel must not
  dolly against them — otherwise it fights the SpaceMouse over the same radius.
- **The cursor dolly slides the camera sideways, never along the view axis.** In
  `dollyOrthoToCursor` the anchoring correction is computed in the camera's own
  basis (`anchorInView - ndc * halfExtent`) and applied on the right/up axes. It
  must not be built from two unprojected cursor points: taken before and after
  the move they sit on different camera planes, so their difference contains the
  dolly's own axial travel. Applying that as a translation cancels the dolly and
  hands the whole displacement to the returned target, which walks the orbit
  pivot a full dolly distance off whatever the user was orbiting, on every wheel
  step. The camera staying put and the pivot running forward is the symptom; a
  centred cursor must leave the pivot exactly where it is.
- **Ortho near/far stay symmetric about the camera.** `near = -far =
  -(radius + sceneRadius + ORTHO_DEPTH_MARGIN)`, so geometry behind the camera is
  still drawn; `ORTHO_NEAR`/`ORTHO_FAR` are the fallback when the scene radius is
  unknown. Do not move the near in front of the camera to make picking simpler: at
  a wide FOV the camera sits at the model's surface while the view is still
  zoomed out, so it would slice the model. Picking is handled on top of it
  instead, by `pickRay.ts`.
- **Every surface-aimed ray goes through `setPickRayFromCamera`.** It is
  `Raycaster.setFromCamera` plus the jump back to the near plane, which is what
  lets a ray reach what the camera has dollied past. A plain
  `raycaster.setFromCamera` is correct only for cameras that clip in front of
  themselves, and it fails silently: the cursor simply stops hitting anything on
  that surface. R3F's own event raycaster is patched for the same reason, so
  do not assume R3F's `e.point`/`e.ray` are uncorrected.
- **The radius reference is `controls.target`, never navlib's pivot.** The pivot a
  SpaceMouse gesture orbits is a different point (the active model's centre), and
  it is not where the frustum's scale comes from. Seeding the dolly radius from it
  re-scales the view on the first frame of a gesture — most visibly right after a
  Home reset, which puts the orbit target back on the home target and so maximises
  the difference. Deltas stay pivot-relative; the absolute seed does not.

## SpaceMouse

Both SpaceMouse controllers (`NativeSpaceMouseController`,
`SpaceMouseController`) now dolly the camera and set the ortho frustum directly
from the radius via `applyOrthoFrustum` — no `zoom` conversion. The native path
integrates navlib's own per-frame axial delta onto the current radius (its
absolute axial distance is offset by the pivot it orbits, which need not be the
look target, so using it directly would jump at gesture start). The seed that
integration starts from is the frustum's own reference — the camera→orbit target
distance — so the first frame of a gesture keeps the scale the user is looking at.

The native path also **reports a perspective view to navlib while the camera is
orthographic** (`FORCE_PERSPECTIVE_IN_ORTHO`, plus a synthetic `view.focusDistance`
sized so navlib's perspective half-height equals the ortho view's). That is
deliberate: navlib's Camera / Target-Camera / Fly / Walk modes are
perspective-only, and reporting the truth left the driver producing no motion for
them at all. The price is the conversion around it — navlib's "zoom" is an eye
dolly that means nothing in ortho, its view commands are sized for a perspective
projection, and its pan scale follows the focus distance we report. Those are
maintained costs, not leftovers. `view.perspective = false` restores the native
extents-based ortho path (`applyNavlibOrthoExtents`) if the trade is ever
revisited.

`OrthoFrustumSync` is suspended while a SpaceMouse owns the camera
(`spaceMouseNavigationActive`); on hand-back the controller re-seats
`controls.target` along the view axis at the current radius, so the resumed sync
derives the same frustum with no pop.

SpaceMouse navigation keeps GPU picking live — unlike mouse orbit/pan/zoom, the
pointer is free during a SpaceMouse gesture, so hover should keep following the
camera. It therefore does **not** fire the `picking-pan-*` events (those pause
the picker and disable mesh raycast). Instead it fires
`spacemouse-navigation-start` / `-change` / `-end`, which only `useSceneAutosave`
listens to so saving still defers until the camera settles.

navlib can roll the view. Free orbit is only for the SpaceMouse: the roll is
kept after release so a tilted view can be inspected, and the horizon is
re-locked the moment the regular mouse starts driving the camera. That is
`HorizonLock` (in `SceneCanvasCameraControllers.tsx`): it snaps `camera.up` back
to world Z-up on the `picking-orbit-start` / `picking-pan-start` /
`picking-zoom-start` events. Those fire for every mouse and trackpad path —
including the custom trackpad gesture, which never emits OrbitControls' `start`
— and are not fired by SpaceMouse navigation, so it never fights navlib
mid-gesture. A React drag counter would miss prepare/transform mode, where the
interaction state is deliberately not tracked.

The native controller applies navlib's affine while `out.motion` is true (plus
the final frame) and for a **view command that arrives without motion** — a
fit/preset, which moves the eye a long way. Plain idle output is an echo of the
pose we reported, and applying it re-asserts navlib's up-vector, which would
leave the regular mouse orbiting a rolled horizon from app start with no pending
re-level.

A view command can arrive **without `motion`** (a Fit is not a drag). The Rust
bridge owns the pose shadow, and while idle it used to overwrite navlib's write
with JS's pushed pose before JS ever saw it — so such a command did nothing. JS
now sends back the `seq` / `extentsSeq` it has applied (`lastAppliedSeq`,
`lastAppliedExtentsSeq`); the bridge only lets JS overwrite once it has consumed
navlib's latest write. An extents write is handled as a pan/zoom by
`applyNavlibOrthoExtents` (box height → dolly radius, box centre → pan).

View commands need their scale handling too (`resolveOrthoNavRadius`): navlib
chooses their eye distance for a *perspective* projection, and under the derived
ortho frustum that distance *is* the scale — which is why a preset landed far too
close. Any frame that rotates past `ORTHO_VIEW_TURN_RAD` keeps the user's zoom
(presets reorient; an orbit never changes distance), and `isOrthoFitFrame` flags
a rotationless distance jump as a Fit. A Fit also keeps the scale, and the
controller fires a `camera-fit-request` window event;
`CameraFocusHotkeyController` runs the same focus the F key does, which frames
the model properly instead of trusting navlib's fit distance. Interactive dollies
still integrate navlib's axial delta as a real dolly.

Because hover keeps updating, the **support trunk router must not run per
frame** — it would pathfind continuously as the camera moves. `SceneCanvas` sets
`setSupportNavigationActive` (see
`src/supports/interaction/navigationActiveStore.ts`) while navigating;
`useTrunkPlacement`'s hover handler returns early on it, freezing the preview.
It re-routes once navigation stops. Mouse navigation needs no such gate because
its picking is paused, so no new hover arrives.

### Session lifetime

The navlib session belongs to the app, not to a render branch:
`useNativeSpaceMouseLifecycle` (`src/components/scene/camera/`) is called at the
app root beside `useSupportHistoryHandlers`, and it starts/stops the session with
the SpaceMouse *setting*. Both controllers render under
`cameraInteractionCycleEnabled` — false for the intro and for every Home reset —
so a lifecycle bound to their mount tore the session down and created a fresh
navlib client on each of those, resetting the driver's state and restarting the
pose handshake. The bridge is a process-wide singleton; nothing that comes and
goes with an animation may own it.

### Focus gating

SpaceMouse input is ignored unless DragonFruit's window is the OS-active window —
for as long as another application is in front, not merely while the window is
hidden. Both paths gate on the same fact, and they must agree:

- `src/components/scene/camera/windowFocus.ts` is the frontend's source
  (`getWindowFocused`), fed by Tauri's `onFocusChanged` — the OS window event —
  with the webview's own focus/blur as the fallback outside the shell. Both
  controllers retain it while mounted and return early on it in their frame loop.
- The native bridge tells navlib the same thing: `spacemouse::track_window_focus`
  forwards `WindowEvent::Focused` to `nav::set_focus`, which writes navlib's
  `active` / `focus` properties. Those are how the driver decides which
  application the puck drives at all, so claiming them unconditionally — as the
  session used to at `start` — leaves a backgrounded DragonFruit receiving motion
  it then has to ignore.

A gap in the pose handshake follows from both of the above, because navlib keeps
writing poses while nobody consumes them (while unfocused we stop syncing, and
while a controller is unmounted for an animation there is no frame loop at all).
`nav::set_focus` clears `motion` and re-claims the camera on return (`claim_pose`,
the same mechanism a fresh session uses); the controller sets `discardNextOutRef`
at mount and whenever the window regains focus, and the **first output received
after that is recorded as consumed without being applied**. Applying it would
replay the accumulated pose as a jump — and, because the ownership handshake keys
off the last applied `seq`, leaving it unconsumed would stall the handshake so JS
could never re-assert its own camera while navlib is idle.

## Tests

`src/components/scene/camera/__tests__/orthoDolly.test.ts` covers the frustum
derivation, wheel scale, cursor anchoring, radius clamping, and the zoom bake.

## Related

- `docs/adr/0032-camera-fov-projection-switching.md`
- `docs/dev/state-and-stores.md`
