"use client";

import * as React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { BufferGeometry, CanvasTexture, DoubleSide, Float32BufferAttribute, Group, MathUtils, Matrix4, Object3D, Quaternion, Vector3 } from 'three';
import type { OrthographicCamera as ThreeOrthographicCamera } from 'three';
import { Edges, GizmoHelperProps, Hud, OrthographicCamera } from '@react-three/drei';
import { __iconNode as houseIconNode } from 'lucide-react/dist/esm/icons/house.js';

type TweenCamera = (direction: Vector3) => void;
type QuarterTurnDirection = 'left' | 'right' | 'up' | 'down';
type QuarterTurn = (direction: QuarterTurnDirection) => void;

type OrbitControlsLike = {
  minPolarAngle: number;
  target: Vector3;
  enabled?: boolean;
  update: (delta?: number) => void;
};

type CameraControlsLike = {
  getTarget: (out: Vector3) => Vector3;
  setPosition: (x: number, y: number, z: number) => void;
  enabled?: boolean;
  update: (delta?: number) => void;
};

const Context = React.createContext<{ tweenCamera: TweenCamera; quarterTurn: QuarterTurn }>({
  tweenCamera: () => undefined,
  quarterTurn: () => undefined,
});

export const useGizmoContext = () => React.useContext(Context);

const turnRate = 4 * Math.PI;
const dummy = new Object3D();
const matrix = new Matrix4();
const q1 = new Quaternion();
const q2 = new Quaternion();
const targetDirection = new Vector3();
const targetPosition = new Vector3();
const worldUp = new Vector3(0, 0, 1);
/** Screen-up chosen for the poles, where world Z cannot serve (it is the view axis). */
const polarScreenUp = new Vector3(0, 1, 0);
/** Off-pole tilt (~0.5°) that keeps OrbitControls' spherical away from its singularity. */
const polarTilt = 0.0087;

/**
 * A view direction pointing straight along ±worldUp is a singularity for
 * OrbitControls: the camera's up-vector is the view axis, so the azimuth is
 * undefined and the roll snaps to a canonical value instead of animating. Tilt
 * such a direction a fraction of a degree off the pole toward the side that puts
 * `polarScreenUp` up on screen, so the whole tween (and the state it lands in) is
 * well-defined. Visually it is still a top/bottom view.
 */
function stabilizeDirection(direction: Vector3): Vector3 {
  const stabilized = direction.clone().normalize();
  const upDot = stabilized.dot(worldUp);
  if (Math.abs(upDot) < 0.999) return stabilized;

  const sign = upDot > 0 ? -1 : 1;
  stabilized.addScaledVector(polarScreenUp, Math.tan(polarTilt) * sign);
  return stabilized.normalize();
}

function isOrbitControls(
  controls: unknown,
): controls is OrbitControlsLike {
  return (
    !!controls
    && typeof controls === 'object'
    && 'minPolarAngle' in controls
    && 'target' in controls
    && 'update' in controls
  );
}

function isCameraControls(
  controls: unknown,
): controls is CameraControlsLike {
  return (
    !!controls
    && typeof controls === 'object'
    && 'getTarget' in controls
    && 'setPosition' in controls
    && 'update' in controls
  );
}

/**
 * Enable/disable whichever controls hook is in use. Lives outside the component
 * so the write does not read as mutating a hook-returned value in render scope.
 */
function assignControlsEnabled(controls: unknown, enabled: boolean): void {
  if (isOrbitControls(controls) || isCameraControls(controls)) {
    (controls as { enabled?: boolean }).enabled = enabled;
  }
}

/** How far the quarter-turn arrows sit from the widget centre (cube half is 0.5). */
const ARROW_DISTANCE = 0.74;
/** Arrowhead: a flat, shallow triangle in gizmo units (cube half is 0.5). */
const ARROW_WIDTH = 0.22;
const ARROW_HEIGHT = 0.12;
/**
 * Quarter-turn arrows fade with how face-on the view is: fully opaque within
 * ARROW_FADE_FULL_DEGREES of a face, gone by ARROW_FADE_ZERO_DEGREES. A quarter
 * turn is only meaningful from a face-on (FRONT/TOP/…) view.
 */
const ARROW_FADE_FULL_DEGREES = 6;
const ARROW_FADE_ZERO_DEGREES = 20;
const ARROW_FADE_FULL_COS = Math.cos((ARROW_FADE_FULL_DEGREES * Math.PI) / 180);
const ARROW_FADE_ZERO_COS = Math.cos((ARROW_FADE_ZERO_DEGREES * Math.PI) / 180);
const arrowViewDirection = new Vector3();

/**
 * Flat triangle pointing +Y, apex at the top. A flat primitive (rather than a
 * cone) has no interior faces, so its `Edges` outline is a clean triangle — a
 * cone's base cap fans edges through the middle of the silhouette.
 */
const arrowTriangle = new BufferGeometry();
arrowTriangle.setAttribute(
  'position',
  new Float32BufferAttribute(
    [
      0, ARROW_HEIGHT * 0.5, 0,
      -ARROW_WIDTH * 0.5, -ARROW_HEIGHT * 0.5, 0,
      ARROW_WIDTH * 0.5, -ARROW_HEIGHT * 0.5, 0,
    ],
    3,
  ),
);
arrowTriangle.computeVertexNormals();

function RotationArrow({
  direction,
  position,
  rotation,
  fade,
  color,
  hoverColor,
  strokeColor,
}: {
  direction: QuarterTurnDirection;
  position: [number, number, number];
  rotation: number;
  fade: number;
  color: string;
  hoverColor: string;
  strokeColor: string;
}) {
  const { quarterTurn } = React.useContext(Context);
  const [hover, setHover] = React.useState(false);

  return (
    <mesh
      geometry={arrowTriangle}
      position={position}
      rotation={[0, 0, rotation]}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHover(false);
      }}
      onClick={(e) => {
        e.stopPropagation();
        quarterTurn(direction);
      }}
    >
      <meshBasicMaterial
        color={hover ? hoverColor : color}
        transparent
        opacity={(hover ? 0.95 : 0.8) * fade}
        side={DoubleSide}
      />
      {/* Same secondary outline the cube faces carry. */}
      <Edges color={strokeColor} transparent opacity={0.9 * fade} />
    </mesh>
  );
}

/** Home button sits on the bottom-right diagonal, between the right and bottom arrows. */
const HOME_OFFSET = 0.76;
const HOME_SIZE = 0.36;

function HomeButton({
  position,
  strokeColor,
  onClick,
}: {
  position: [number, number, number];
  strokeColor: string;
  onClick?: () => void;
}) {
  const [hover, setHover] = React.useState(false);

  const texture = React.useMemo(() => {
    if (typeof document === 'undefined') return null;
    const size = 64;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Rasterize lucide's House icon (the same one the rest of the UI uses),
    // filled rather than stroked. lucide is stroke-only, so fill the closed
    // silhouette path and punch the open detail path (the door) out with
    // destination-out — the filled-home look.
    const viewBox = 24;
    const padding = size * 0.06;
    const scale = (size - padding * 2) / viewBox;
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(padding, padding);
    ctx.scale(scale, scale);

    const paths: { path: Path2D; closed: boolean }[] = [];
    for (const [tag, attrs] of houseIconNode) {
      if (tag !== 'path' || typeof attrs.d !== 'string') continue;
      paths.push({ path: new Path2D(attrs.d), closed: /z\s*$/i.test(attrs.d.trim()) });
    }

    ctx.fillStyle = strokeColor;
    for (const { path, closed } of paths) {
      if (closed) ctx.fill(path);
    }
    ctx.globalCompositeOperation = 'destination-out';
    for (const { path, closed } of paths) {
      if (!closed) ctx.fill(path);
    }
    ctx.restore();

    return new CanvasTexture(canvas);
  }, [strokeColor]);

  React.useEffect(() => () => texture?.dispose(), [texture]);

  return (
    <mesh
      position={position}
      scale={hover ? 1.15 : 1}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHover(true);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHover(false);
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
    >
      <planeGeometry args={[HOME_SIZE, HOME_SIZE]} />
      <meshBasicMaterial
        map={texture ?? undefined}
        transparent
        opacity={hover ? 1 : 0.9}
        depthWrite={false}
        side={DoubleSide}
      />
    </mesh>
  );
}

export function ZUpGizmoHelper({
  alignment = 'bottom-right',
  margin = [80, 80],
  renderPriority = 1,
  arrowColor = '#f0f0f0',
  arrowHoverColor = '#999999',
  arrowStrokeColor = '#baf72e',
  onHome,
  onUpdate,
  onTarget,
  children,
}: GizmoHelperProps & {
  arrowColor?: string;
  arrowHoverColor?: string;
  arrowStrokeColor?: string;
  onHome?: () => void;
}) {
  const size = useThree((state) => state.size);
  const mainCamera = useThree((state) => state.camera);
  const defaultControls = useThree((state) => state.controls) as unknown;
  const invalidate = useThree((state) => state.invalidate);
  const gizmoRef = React.useRef<Group | null>(null);
  const virtualCam = React.useRef<ThreeOrthographicCamera | null>(null);
  const animating = React.useRef(false);
  const radius = React.useRef(0);
  const focusPoint = React.useRef(new Vector3(0, 0, 0));
  const savedControlsEnabled = React.useRef<boolean | null>(null);
  const [arrowFade, setArrowFade] = React.useState(0);
  const arrowFadeRef = React.useRef(0);

  const restoreControls = React.useCallback(() => {
    if (isOrbitControls(defaultControls) || isCameraControls(defaultControls)) {
      if (savedControlsEnabled.current !== null && typeof defaultControls.enabled === 'boolean') {
        assignControlsEnabled(defaultControls, savedControlsEnabled.current);
      }
      if (isCameraControls(defaultControls)) {
        defaultControls.setPosition(mainCamera.position.x, mainCamera.position.y, mainCamera.position.z);
      }
      defaultControls.update();
    }
    savedControlsEnabled.current = null;
  }, [defaultControls, mainCamera]);

  const resolveFocusPoint = React.useCallback((): Vector3 => {
    if (onTarget) return focusPoint.current.copy(onTarget());
    if (isCameraControls(defaultControls)) return defaultControls.getTarget(focusPoint.current);
    if (isOrbitControls(defaultControls)) return focusPoint.current.copy(defaultControls.target);
    return focusPoint.current.set(0, 0, 0);
  }, [defaultControls, onTarget]);

  const tweenCamera = React.useCallback<TweenCamera>(
    (direction) => {
      animating.current = true;
      resolveFocusPoint();
      radius.current = mainCamera.position.distanceTo(focusPoint.current);
      q1.copy(mainCamera.quaternion);
      targetDirection.copy(stabilizeDirection(direction));
      targetPosition.copy(targetDirection).multiplyScalar(radius.current).add(focusPoint.current);
      dummy.up.copy(worldUp);
      dummy.position.copy(focusPoint.current);
      dummy.lookAt(targetPosition);
      q2.copy(dummy.quaternion);

      // Take the camera out of OrbitControls' hands for the tween: its update()
      // rebuilds the orientation from position+up, which is singular near the
      // poles and would snap the roll instead of letting the slerp animate it.
      if (
        savedControlsEnabled.current === null
        && (isOrbitControls(defaultControls) || isCameraControls(defaultControls))
        && typeof defaultControls.enabled === 'boolean'
      ) {
        savedControlsEnabled.current = defaultControls.enabled;
        assignControlsEnabled(defaultControls, false);
      }
      invalidate();
    },
    [defaultControls, invalidate, mainCamera, resolveFocusPoint],
  );

  // Orbit exactly 90° about the axis perpendicular to the arrow, using the
  // camera's own axes — so the arrow always means "turn one quarter in this
  // screen direction from wherever I am now".
  const quarterTurn = React.useCallback<QuarterTurn>(
    (direction) => {
      const focus = resolveFocusPoint();
      mainCamera.updateMatrixWorld();
      const offset = mainCamera.position.clone().sub(focus).normalize();
      const right = new Vector3().setFromMatrixColumn(mainCamera.matrixWorld, 0).normalize();
      const up = new Vector3().setFromMatrixColumn(mainCamera.matrixWorld, 1).normalize();
      const quarter = Math.PI / 2;

      if (direction === 'up') offset.applyAxisAngle(right, -quarter);
      else if (direction === 'down') offset.applyAxisAngle(right, quarter);
      else if (direction === 'right') offset.applyAxisAngle(up, quarter);
      else offset.applyAxisAngle(up, -quarter);

      tweenCamera(offset);
    },
    [mainCamera, resolveFocusPoint, tweenCamera],
  );

  useFrame((_, delta) => {
    if (virtualCam.current && gizmoRef.current) {
      if (animating.current) {
        if (q1.angleTo(q2) < 0.01) {
          mainCamera.position.copy(targetPosition);
          mainCamera.quaternion.copy(q2);
          mainCamera.up.copy(worldUp);
          animating.current = false;
          restoreControls();
        } else {
          const step = delta * turnRate;
          q1.rotateTowards(q2, step);
          mainCamera.position.set(0, 0, 1).applyQuaternion(q1).multiplyScalar(radius.current).add(focusPoint.current);
          mainCamera.quaternion.copy(q1);
          mainCamera.up.copy(worldUp);
          if (onUpdate) onUpdate();
          invalidate();
        }
      }

      matrix.copy(mainCamera.matrix).invert();
      gizmoRef.current.quaternion.setFromRotationMatrix(matrix);
    }

    // Fade the quarter-turn arrows with how face-on the view is. Re-render only
    // when the fade moves meaningfully, not every frame.
    mainCamera.getWorldDirection(arrowViewDirection);
    const faceOn = Math.max(
      Math.abs(arrowViewDirection.x),
      Math.abs(arrowViewDirection.y),
      Math.abs(arrowViewDirection.z),
    );
    const rawFade = MathUtils.clamp(
      (faceOn - ARROW_FADE_ZERO_COS) / Math.max(1e-6, ARROW_FADE_FULL_COS - ARROW_FADE_ZERO_COS),
      0,
      1,
    );
    // Snap the ends so the meshes leave the scene (and the raycast) entirely.
    const fade = rawFade <= 0.02 ? 0 : rawFade >= 0.98 ? 1 : rawFade * rawFade * (3 - 2 * rawFade);
    if (Math.abs(fade - arrowFadeRef.current) > 0.01) {
      arrowFadeRef.current = fade;
      setArrowFade(fade);
    }
  });

  // Never leave OrbitControls disabled if this unmounts mid-tween (thumbnail
  // capture does exactly that).
  React.useEffect(() => {
    return () => {
      if (
        savedControlsEnabled.current !== null
        && (isOrbitControls(defaultControls) || isCameraControls(defaultControls))
        && typeof defaultControls.enabled === 'boolean'
      ) {
        assignControlsEnabled(defaultControls, savedControlsEnabled.current);
      }
      savedControlsEnabled.current = null;
    };
  }, [defaultControls]);

  const gizmoHelperContext = React.useMemo(
    () => ({
      tweenCamera,
      quarterTurn,
    }),
    [quarterTurn, tweenCamera],
  );

  const [marginX, marginY] = margin;
  const x = alignment.endsWith('-center')
    ? 0
    : alignment.endsWith('-left')
      ? -size.width / 2 + marginX
      : size.width / 2 - marginX;
  const y = alignment.startsWith('center-')
    ? 0
    : alignment.startsWith('top-')
      ? size.height / 2 - marginY
      : -size.height / 2 + marginY;

  return (
    <Hud renderPriority={renderPriority}>
      <Context.Provider value={gizmoHelperContext}>
        <OrthographicCamera makeDefault ref={virtualCam} position={[0, 0, 200]} />
        <group ref={gizmoRef} position={[x, y, 0]}>
          {children}
        </group>
        {/* Quarter-turn arrows live outside the rotating group, so they stay
            screen-aligned: the top arrow is always "turn up from here". They
            fade out as the view leaves a face — a quarter turn is meaningless
            from an arbitrary angle. Fully faded frames render nothing (not
            `visible`), so the faded arrows cannot be hit. */}
        {arrowFade > 0 && (
          <group position={[x, y, 0]} scale={[60, 60, 60]}>
            <RotationArrow direction="up" position={[0, ARROW_DISTANCE, 0]} rotation={Math.PI} fade={arrowFade} color={arrowColor} hoverColor={arrowHoverColor} strokeColor={arrowStrokeColor} />
            <RotationArrow direction="down" position={[0, -ARROW_DISTANCE, 0]} rotation={0} fade={arrowFade} color={arrowColor} hoverColor={arrowHoverColor} strokeColor={arrowStrokeColor} />
            <RotationArrow direction="left" position={[-ARROW_DISTANCE, 0, 0]} rotation={-Math.PI / 2} fade={arrowFade} color={arrowColor} hoverColor={arrowHoverColor} strokeColor={arrowStrokeColor} />
            <RotationArrow direction="right" position={[ARROW_DISTANCE, 0, 0]} rotation={Math.PI / 2} fade={arrowFade} color={arrowColor} hoverColor={arrowHoverColor} strokeColor={arrowStrokeColor} />
          </group>
        )}
        {/* Home is useful from any angle, so it is always shown (the quarter-turn
            arrows are not). */}
        <group position={[x, y, 0]} scale={[60, 60, 60]}>
          <HomeButton
            position={[HOME_OFFSET, -HOME_OFFSET, 0]}
            strokeColor={arrowStrokeColor}
            onClick={onHome}
          />
        </group>
      </Context.Provider>
    </Hud>
  );
}
