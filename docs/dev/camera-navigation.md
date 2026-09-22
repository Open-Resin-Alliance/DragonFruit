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
derives the frustum from the current position, `applyOrthoFrustum` writes it for
an explicit radius (used by the SpaceMouse controllers), and
`dollyOrthoToCursor` performs a cursor-anchored dolly.

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
- **Ortho near/far track the radius.** When the scene radius is known, the depth
  range is `±(radius + sceneRadius + ORTHO_DEPTH_MARGIN)`, so z precision improves
  as you dolly in. `ORTHO_NEAR`/`ORTHO_FAR` are the fallback when it is not.

## SpaceMouse

Both SpaceMouse controllers (`NativeSpaceMouseController`,
`SpaceMouseController`) now dolly the camera and set the ortho frustum directly
from the radius via `applyOrthoFrustum` — no `zoom` conversion. The native path
integrates navlib's own per-frame axial delta onto the current radius (its
absolute axial distance is offset by the pivot it orbits, which need not be the
look target, so using it directly would jump at gesture start).

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

## Tests

`src/components/scene/camera/__tests__/orthoDolly.test.ts` covers the frustum
derivation, wheel scale, cursor anchoring, radius clamping, and the zoom bake.

## Related

- `docs/adr/0032-camera-fov-projection-switching.md`
- `docs/dev/state-and-stores.md`
