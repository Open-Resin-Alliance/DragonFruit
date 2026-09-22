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

The camera system now has a single ortho scale source: the dolly radius.

```
halfHeight = tan(ORTHO_REFERENCE_FOV_DEG / 2) * radius
radius     = |camera.position - controls.target|
camera.zoom = 1
```

`src/components/scene/camera/orthoDolly.ts` owns this. `syncOrthoFrustum`
derives the frustum, `dollyOrthoToCursor` performs a cursor-anchored dolly, and
`bakeOrthoZoomIntoRadius` converts an explicit `zoom` back into a radius.

### Projection switching preserves apparent size

Ortho derives from the fixed reference FOV while perspective uses the user's
FOV, so switching at the same distance would change the framing. Perspective to
ortho therefore scales the distance by
`tan(perspectiveFov/2) / tan(referenceFov/2)`
(`orthoRadiusForPerspectiveFraming`), and ortho to perspective already solves
distance for the same reason. Together they make the round trip the identity —
without the first half, each toggle compounds the scale error.

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
  OrbitControls' native dolly and `zoomToCursor`.
- **Ortho near/far are symmetric and large** (`ORTHO_NEAR`/`ORTHO_FAR`) so
  geometry behind the camera position is never clipped.

## SpaceMouse

The SpaceMouse controllers (`NativeSpaceMouseController`,
`SpaceMouseController`) still drive `camera.zoom` directly while they own the
camera. `OrthoFrustumSync` is suspended for the duration
(`spaceMouseNavigationActive`) so they run unopposed; on hand-back it calls
`bakeOrthoZoomIntoRadius` using the radius captured at gesture start, so the
derived frustum matches the last visible scale before normal navigation
resumes. Fully unifying the SpaceMouse onto the radius model is still open.

## Tests

`src/components/scene/camera/__tests__/orthoDolly.test.ts` covers the frustum
derivation, wheel scale, cursor anchoring, radius clamping, and the zoom bake.

## Related

- `docs/adr/0032-camera-fov-projection-switching.md`
- `docs/dev/state-and-stores.md`
