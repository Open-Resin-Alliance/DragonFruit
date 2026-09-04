/**
 * Where the last refused cut went wrong, pinned in the viewport.
 *
 * The cut refuses with a reason and a set of places, and a place is only useful if
 * the user can go and look at it. These are those places. They replace a ball of
 * translucent colour per spot, which was findable and useless in the same breath:
 * big enough to see meant big enough to hide the geometry the user had to inspect.
 *
 * So the pin is drawn as a map pin is drawn, and for the same reason — a map pin
 * has to point at one building without covering the street:
 *
 * - The TIP is the spot, exactly, marked with a small ring and a cross. Nothing is
 *   drawn over the spot itself.
 * - The STEM leans away and up, so everything the pin has to say about itself is
 *   said in empty space above the geometry, not on top of it.
 * - The HEAD is an outline, not a disc, and carries the pin's NUMBER — the same
 *   number the message beside the Cut button counts up to, so "three places" and
 *   the three things on screen are the same three things.
 *
 * Constant size on screen, because a spot that has to be found must not shrink into
 * the model as the user zooms out to look for it; and drawn through the model
 * (`depthTest: false`), because the spot is as often on the far side as the near
 * one. Both of those are what make it findable — the size and opacity of the ink
 * are then free to stay out of the way, which is the whole trade the ball got wrong.
 *
 * Not a colour preference. This is a status, like a form error, and a preference is
 * a way to make it invisible — the same reasoning as `TENON_WONT_FIT_COLORS`.
 */

import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';

/** Pin height as a fraction of the viewport height, so it is the same on any zoom. */
const PIN_SCREEN_HEIGHT = 0.055;
/** Above every other overlay the cut draws (the tenon tops out at 1004). */
const PIN_RENDER_ORDER = 1010;
const PIN_COLOR = '#ff4d4d';

/** A circle of `steps` points on the pin's own plane, centred on `cy`. */
function ring(cx: number, cy: number, r: number, steps = 40): [number, number, number][] {
  return Array.from({ length: steps + 1 }, (_, k) => {
    const t = (k / steps) * Math.PI * 2;
    return [cx + r * Math.cos(t), cy + r * Math.sin(t), 0] as [number, number, number];
  });
}

/**
 * One pin, in a space where the tip is the origin, +Y is up the screen and the
 * whole thing is one unit tall. The group is turned to face the camera and scaled
 * to the screen every frame, so these numbers are read as fractions of the pin.
 */
const STEM_TOP = 1;
const HEAD_RADIUS = 0.34;
const TIP_RADIUS = 0.075;
const TIP_CROSS = 0.16;

function PinShape({ label }: { label: string }) {
  const geometry = useMemo(
    () => ({
      // Leaning stem: the tip is the spot, the head sits up and to the right of it,
      // so the head never sits on what the tip is pointing at.
      stem: [
        [0, 0, 0],
        [0.22, STEM_TOP, 0],
      ] as [number, number, number][],
      head: ring(0.22, STEM_TOP + HEAD_RADIUS, HEAD_RADIUS),
      tip: ring(0, 0, TIP_RADIUS, 16),
      cross: [
        [-TIP_CROSS, 0, 0],
        [TIP_CROSS, 0, 0],
      ] as [number, number, number][],
      cross2: [
        [0, -TIP_CROSS, 0],
        [0, TIP_CROSS, 0],
      ] as [number, number, number][],
    }),
    [],
  );

  const line = {
    color: PIN_COLOR,
    transparent: true,
    depthTest: false,
    renderOrder: PIN_RENDER_ORDER,
  } as const;

  return (
    <>
      <Line {...line} points={geometry.stem} lineWidth={1.5} opacity={0.55} />
      <Line {...line} points={geometry.head} lineWidth={2} opacity={0.85} />
      <Line {...line} points={geometry.tip} lineWidth={2} opacity={0.95} />
      <Line {...line} points={geometry.cross} lineWidth={1.5} opacity={0.75} />
      <Line {...line} points={geometry.cross2} lineWidth={1.5} opacity={0.75} />
      <Html
        center
        position={[0.22, STEM_TOP + HEAD_RADIUS, 0]}
        zIndexRange={[100, 0]}
        style={{
          pointerEvents: 'none',
          userSelect: 'none',
          color: PIN_COLOR,
          font: '600 11px var(--font-geist-mono)',
          lineHeight: 1,
        }}
      >
        {label}
      </Html>
    </>
  );
}

/**
 * The scale that keeps the pin the same height on screen wherever it sits. Mirrors
 * `ScreenSpaceGizmo`'s: under a perspective camera size falls off with distance,
 * and under an orthographic one it is the zoom alone.
 */
function screenScale(camera: THREE.Camera, at: THREE.Vector3): number {
  const ortho = camera as THREE.OrthographicCamera;
  if (ortho.isOrthographicCamera) {
    return ((ortho.top - ortho.bottom) / Math.max(1e-6, ortho.zoom)) * PIN_SCREEN_HEIGHT;
  }
  const perspective = camera as THREE.PerspectiveCamera;
  const fov = (perspective.fov * Math.PI) / 180;
  return perspective.position.distanceTo(at) * 2 * Math.tan(fov / 2) * PIN_SCREEN_HEIGHT;
}

function Pin({ at, label }: { at: [number, number, number]; label: string }) {
  const group = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const world = useMemo(() => new THREE.Vector3(at[0], at[1], at[2]), [at]);

  // Turned to the camera and sized to the screen every frame. Copying the camera's
  // rotation is what makes the pin stand UP on screen rather than along some axis
  // of the model: a pin lying along +Z is invisible from directly above, which is
  // the view a user looking down at the plate is most likely to be in.
  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.quaternion.copy(camera.quaternion);
    g.scale.setScalar(screenScale(camera, world));
  });

  return (
    <group ref={group} position={at} frustumCulled={false}>
      <PinShape label={label} />
    </group>
  );
}

export function CutLeakPins({ points }: { points: [number, number, number][] }) {
  if (points.length === 0) return null;
  return (
    <>
      {points.map((p, i) => (
        <Pin key={`leak-${i}-${p[0]},${p[1]},${p[2]}`} at={p} label={String(i + 1)} />
      ))}
    </>
  );
}
