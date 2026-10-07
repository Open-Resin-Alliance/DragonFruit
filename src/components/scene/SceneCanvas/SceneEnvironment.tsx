"use client";

import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { AxisLabels } from '@/components/scene/AxisLabels';
import { fitFontToWidth } from '@/utils/canvasTextFit';
import { PlateNameLabel } from './PlateNameLabel';
import { PlateSideButtons } from './PlateSideButtons';

/**
 * Front-marker texture is 256px wide; leave 4px either side of the label. Wide
 * enough that the English "FRONT" still renders at its original 70px.
 */
const FRONT_MARKER_MAX_TEXT_WIDTH = 248;

export function EnableLocalClipping({ enabled = true }: { enabled?: boolean }) {
  const { gl } = useThree();
  useEffect(() => {
    gl.localClippingEnabled = enabled;
  }, [enabled, gl]);
  return null;
}

export function CameraProvider({ cameraRef }: { cameraRef: React.MutableRefObject<THREE.Camera | null> }) {
  const { camera } = useThree();
  React.useEffect(() => {
    cameraRef.current = camera;
  }, [camera, cameraRef]);
  return null;
}

export function CameraClipPlaneStabilizer() {
  const { camera, controls } = useThree();

  useFrame(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    if ((perspective as any).isPerspectiveCamera !== true) return;

    const orbitTarget = (controls as any)?.target as THREE.Vector3 | undefined;
    if (!orbitTarget) return;

    const dist = perspective.position.distanceTo(orbitTarget);
    if (!Number.isFinite(dist) || dist <= 0) return;

    // Depth precision fix:
    // A too-small near plane combined with a too-large far plane causes depth-buffer precision
    // issues that can make the model fail to occlude small geometry when zoomed in.
    // Keep near reasonably small but not extreme, and keep far tight.
    const desiredNear = Math.max(0.02, Math.min(0.5, dist / 200));
    const desiredFar = Math.min(5000, Math.max(200, dist * 50));

    if (Math.abs(perspective.near - desiredNear) > 1e-6 || Math.abs(perspective.far - desiredFar) > 1e-3) {
      perspective.near = desiredNear;
      perspective.far = desiredFar;
      perspective.updateProjectionMatrix();
    }
  });

  return null;
}

function ViewHeadlight({ intensity }: { intensity: number }) {
  const { camera } = useThree();
  const lightRef = React.useRef<THREE.DirectionalLight | null>(null);
  const targetRef = React.useRef<THREE.Object3D>(new THREE.Object3D());
  const viewDirectionRef = React.useRef(new THREE.Vector3());

  useFrame(() => {
    if (!lightRef.current) return;

    const light = lightRef.current;
    const target = targetRef.current;
    camera.getWorldDirection(viewDirectionRef.current);

    light.position.copy(camera.position);
    target.position.copy(camera.position).addScaledVector(viewDirectionRef.current, 100);
    target.updateMatrixWorld(true);
    light.target = target;
  });

  // Camera-forward key light: unlike a point light at the camera, this keeps
  // the illumination direction stable even when the inspected object is panned
  // away from screen center.
  return (
    <>
      <directionalLight
        ref={lightRef}
        name="view-headlight"
        intensity={intensity}
        color="#ffffff"
        userData={{ followCaptureCamera: true, followCaptureCameraDirection: true }}
      />
      <primitive object={targetRef.current} />
    </>
  );
}

export function Lights({
  ambientIntensity,
  directionalIntensity,
  headlightIntensity,
}: {
  ambientIntensity: number;
  directionalIntensity: number;
  headlightIntensity: number;
}) {
  const clampedHeadlightIntensity = Math.max(0, headlightIntensity);

  return (
    <>
      <ambientLight intensity={ambientIntensity} />
      <directionalLight position={[0, 0, 12]} intensity={directionalIntensity} color="#ffffff" />
      <directionalLight position={[0, 0, -12]} intensity={directionalIntensity * 0.15} color="#90a7ff" />
      <hemisphereLight args={['#f6e8ff', '#3e415c', ambientIntensity * 0.6]} />
      <ViewHeadlight intensity={clampedHeadlightIntensity} />
    </>
  );
}

export function SceneMoodOverlay() {
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'radial-gradient(120% 95% at 50% 46%, rgba(0,0,0,0) 56%, color-mix(in srgb, var(--scene-gradient-radial, #ff37aa), transparent 82%) 100%)',
          mixBlendMode: 'screen',
          opacity: 0.75,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--scene-gradient-linear-start, #ff37aa), transparent 90%) 0%, color-mix(in srgb, var(--scene-gradient-linear-mid, #6f33ff), transparent 94%) 40%, rgba(0,0,0,0) 100%)',
          mixBlendMode: 'screen',
          opacity: 0.8,
        }}
      />
    </>
  );
}

const SAFETY_STRIPE_VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SAFETY_STRIPE_FRAGMENT_SHADER = `
  varying vec2 vUv;

  uniform float uWidthMm;
  uniform float uHeightMm;
  uniform float uBleedXMm;
  uniform float uBleedYMm;
  uniform float uStripePeriodMm;
  uniform float uOpacity;
  uniform vec3 uBaseColor;
  uniform vec3 uStripeColor;

  void main() {
    float x = mix(-uBleedXMm, uWidthMm + uBleedXMm, vUv.x);
    float y = mix(-uBleedYMm, uHeightMm + uBleedYMm, vUv.y);
    float period = max(0.001, uStripePeriodMm);
    float band = fract((x + y) / period);
    float stripeMask = step(0.5, band);
    vec3 color = mix(uBaseColor, uStripeColor, stripeMask);

    gl_FragColor = vec4(color, uOpacity);
  }
`;

function SafetyStripeMaterial({
  widthMm,
  heightMm,
  bleedXMm = 0,
  bleedYMm = 0,
  opacity,
}: {
  widthMm: number;
  heightMm: number;
  bleedXMm?: number;
  bleedYMm?: number;
  opacity: number;
}) {
  const uniforms = React.useMemo(() => ({
    uWidthMm: { value: widthMm },
    uHeightMm: { value: heightMm },
    uBleedXMm: { value: bleedXMm },
    uBleedYMm: { value: bleedYMm },
    uStripePeriodMm: { value: 8 },
    uOpacity: { value: opacity },
    uBaseColor: { value: new THREE.Color('#ffdddd') },
    uStripeColor: { value: new THREE.Color('#a23846') },
  }), [bleedXMm, bleedYMm, heightMm, opacity, widthMm]);

  return (
    <shaderMaterial
      attach="material"
      uniforms={uniforms}
      vertexShader={SAFETY_STRIPE_VERTEX_SHADER}
      fragmentShader={SAFETY_STRIPE_FRAGMENT_SHADER}
      transparent
      depthTest
      depthWrite={false}
      polygonOffset
      polygonOffsetFactor={-2}
      polygonOffsetUnits={-2}
      side={THREE.DoubleSide}
      toneMapped={false}
    />
  );
}

/** The scene helpers' scenery never answers a pick. */
const nullRaycast = () => null;

/**
 * One plate in the scene's plate list, as the canvas needs it: its own name (and the
 * wording to show while it has none), where it sits relative to the first plate
 * (`dxMm`/`dyMm`, in build-volume millimetres), and whether it is the plate being
 * worked on.
 */
export type PlateLayerSpec = {
  id: string;
  name: string;
  /** Already-translated wording for an unnamed plate, e.g. "Plate 2". */
  placeholder: string;
  dxMm: number;
  dyMm: number;
  isActive: boolean;
};

/** The plate's own side buttons, minus their anchors: placing them is this file's job. */
type PlateSideButtonsProps = Omit<
  React.ComponentProps<typeof PlateSideButtons>,
  'columnAnchor' | 'clearAnchor' | 'labelScale'
>;

/** The plate's name widget, with everything committing a new name needs. */
type PlateLayerNameLabel = {
  name: string;
  placeholder: string;
  editTitle: string;
  emptyTitle: string;
  onCommit: (next: string) => void;
};

/** One safety-margin strip: the plane the stripes are drawn across, and where it sits. */
type PlateMarginStrip = {
  widthMm: number;
  heightMm: number;
  /** The plate's overhang the stripes continue across, so they run off the edge. */
  bleedXMm: number;
  bleedYMm: number;
  position: [number, number, number];
  geometry: THREE.ShapeGeometry | null;
};

/**
 * Everything a plate layer draws from, apart from the plate itself: the geometry,
 * textures, colours and widget anchors every plate shares. Built once in `Helpers`, so
 * a second plate costs an offset rather than a second extrude and a second copy of
 * every texture. Positions are the first plate's, in world space: a layer is the whole
 * of this, shifted by its own offset.
 */
type PlateLayerShared = {
  /** What the scene helpers show at all, and the plate's own opacity, already clamped. */
  showGrid: boolean;
  showBuildPlate: boolean;
  buildPlateOpacity: number;
  plate: {
    geometry: THREE.ExtrudeGeometry;
    color: string;
    /** World centre of the plate's box. */
    position: [number, number, number];
  };
  grid: {
    baseSize: number;
    divisions: number;
    scaleX: number;
    scaleZ: number;
    position: [number, number, number];
    majorColor: string;
    minorColor: string;
    /** The same two, faded toward the plate: what a plate that is not active wears. */
    mutedMajorColor: string;
    mutedMinorColor: string;
  };
  logo: {
    groupPosition: [number, number, number];
    position: [number, number, number];
    widthMm: number;
    heightMm: number;
    texture: THREE.Texture;
  };
  axes: {
    position: [number, number, number];
    length: number;
    shaftRadius: number;
    headRadius: number;
    headLength: number;
    labelLift: number;
    xGradient: THREE.Texture | null;
    yGradient: THREE.Texture | null;
    zGradient: THREE.Texture | null;
  };
  frontMarker: {
    position: [number, number, number];
    widthMm: number;
    depthMm: number;
    texture: THREE.Texture | null;
  };
  margins: {
    groupPosition: [number, number, number];
    /** Whether the plate has any margin to stripe at all. */
    visible: boolean;
    front: PlateMarginStrip | null;
    back: PlateMarginStrip | null;
    left: PlateMarginStrip | null;
    right: PlateMarginStrip | null;
  };
  widgets: {
    /** World units per CSS pixel, sized to the plate. */
    scale: number;
    /** Where the name widget's bottom-left corner sits. */
    nameLabelPosition: [number, number, number];
    /** Where each side-button group hangs: the column's top-left, the bin's bottom-left. */
    columnAnchor: [number, number, number];
    clearAnchor: [number, number, number];
  };
};

/**
 * One plate and everything drawn on it, placed by its offset from the first plate.
 *
 * A plate that is not the active one reads as secondary: the opacity of everything
 * painted on it — the surface, its safety strips, the logo and the FRONT marker — is
 * halved, and its grid fades toward the plate, so the plate being worked on comes
 * first. Its surface is also the one part of it that answers a pick, because activating
 * it is the only thing an inactive plate does; the active plate's surface stays
 * unpickable, so a click on it is still a click on the scene. The axes triad is left
 * alone: it marks the origin, not the plate.
 */
function PlateLayer({
  dxMm,
  dyMm,
  isActive,
  shared,
  nameLabel,
  sideButtons,
  onActivate,
}: {
  dxMm: number;
  dyMm: number;
  isActive: boolean;
  shared: PlateLayerShared;
  nameLabel?: PlateLayerNameLabel;
  sideButtons?: PlateSideButtonsProps;
  /** What picking the surface does, on a plate that is not the active one. */
  onActivate?: () => void;
}) {
  // Halved rather than hidden: an inactive plate keeps its shape and stays readable, it
  // just stops competing with the plate being worked on.
  const dimFactor = isActive ? 1 : 0.5;
  const plateOpacity = shared.buildPlateOpacity * dimFactor;
  const pickable = !isActive && !!onActivate;
  const handleActivate = React.useCallback(
    (event: { stopPropagation: () => void }) => {
      // Picking this plate is what the click is for, so it must not also read as a click
      // on the empty scene behind it.
      event.stopPropagation();
      onActivate?.();
    },
    [onActivate],
  );

  return (
    <group position={[dxMm, dyMm, 0]}>
      {/* Primitive mock build plate under grid */}
      <mesh
        position={shared.plate.position}
        renderOrder={-10}
        raycast={pickable ? undefined : nullRaycast}
        onClick={pickable ? handleActivate : undefined}
        visible={shared.showBuildPlate && shared.buildPlateOpacity > 0.001}
        frustumCulled={false}
        userData={{ thumbnailHelperType: 'buildPlate' }}
      >
        <primitive object={shared.plate.geometry} attach="geometry" />
        <meshStandardMaterial
          color={shared.plate.color}
          transparent
          opacity={0.94 * plateOpacity}
          side={THREE.FrontSide}
          depthWrite
        />
      </mesh>

      {/* Grid on XY plane (horizontal) - rotate 90° around X */}
      {shared.showGrid && shared.buildPlateOpacity > 0.001 && (
        <gridHelper
          args={[
            shared.grid.baseSize,
            shared.grid.divisions,
            isActive ? shared.grid.majorColor : shared.grid.mutedMajorColor,
            isActive ? shared.grid.minorColor : shared.grid.mutedMinorColor,
          ]}
          position={shared.grid.position}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[shared.grid.scaleX, 1, shared.grid.scaleZ]}
          raycast={nullRaycast}
          frustumCulled={false}
          userData={{ thumbnailHelperType: 'grid' }}
          // The grid's own lines are scenery too, but an inactive plate's are faint: its
          // lines fade into the plate instead of drawing the eye away from it.
          material-transparent={!isActive}
          material-opacity={dimFactor}
        />
      )}

      {shared.showGrid && shared.showBuildPlate && (
        <group
          position={shared.logo.groupPosition}
          visible={shared.showBuildPlate && shared.buildPlateOpacity > 0.001}
          frustumCulled={false}
          userData={{ thumbnailHelperType: 'grid' }}
        >
          <mesh position={shared.logo.position} renderOrder={20} raycast={nullRaycast} frustumCulled={false}>
            <planeGeometry args={[shared.logo.widthMm, shared.logo.heightMm]} />
            <meshBasicMaterial
              map={shared.logo.texture}
              transparent
              opacity={0.4 * dimFactor}
              depthWrite={false}
              polygonOffset
              polygonOffsetFactor={-2}
              polygonOffsetUnits={-2}
              side={THREE.DoubleSide}
              toneMapped={false}
            />
          </mesh>
        </group>
      )}

      {/* Axes: short, thicker arrows hovering slightly above Z0 to avoid grid clipping */}
      {shared.showGrid && (
      <group position={shared.axes.position} frustumCulled={false} userData={{ thumbnailHelperType: 'grid' }}>
        {/* X axis */}
        <mesh position={[shared.axes.length * 0.5, 0, 0]} rotation={[0, 0, -Math.PI * 0.5]} raycast={nullRaycast}>
          <cylinderGeometry args={[shared.axes.shaftRadius, shared.axes.shaftRadius, shared.axes.length, 12]} />
          <meshBasicMaterial map={shared.axes.xGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[shared.axes.length + shared.axes.headLength * 0.5, 0, 0]} rotation={[0, 0, -Math.PI * 0.5]} raycast={nullRaycast}>
          <coneGeometry args={[shared.axes.headRadius, shared.axes.headLength, 12]} />
          <meshBasicMaterial map={shared.axes.xGradient ?? undefined} toneMapped={false} />
        </mesh>

        {/* Y axis */}
        <mesh position={[0, shared.axes.length * 0.5, 0]} raycast={nullRaycast}>
          <cylinderGeometry args={[shared.axes.shaftRadius, shared.axes.shaftRadius, shared.axes.length, 12]} />
          <meshBasicMaterial map={shared.axes.yGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[0, shared.axes.length + shared.axes.headLength * 0.5, 0]} raycast={nullRaycast}>
          <coneGeometry args={[shared.axes.headRadius, shared.axes.headLength, 12]} />
          <meshBasicMaterial map={shared.axes.yGradient ?? undefined} toneMapped={false} />
        </mesh>

        {/* Z axis */}
        <mesh position={[0, 0, shared.axes.length * 0.5]} rotation={[Math.PI * 0.5, 0, 0]} raycast={nullRaycast}>
          <cylinderGeometry args={[shared.axes.shaftRadius, shared.axes.shaftRadius, shared.axes.length, 12]} />
          <meshBasicMaterial map={shared.axes.zGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, shared.axes.length + shared.axes.headLength * 0.5]} rotation={[Math.PI * 0.5, 0, 0]} raycast={nullRaycast}>
          <coneGeometry args={[shared.axes.headRadius, shared.axes.headLength, 12]} />
          <meshBasicMaterial map={shared.axes.zGradient ?? undefined} toneMapped={false} />
        </mesh>

        <group position={[0, 0, shared.axes.labelLift]}>
          <AxisLabels size={shared.axes.length + 6} />
        </group>
      </group>
      )}

      {/* The plate's name, laid flat just inside its front-left corner. The anchor is the
          plate's left and back edge: the label is shifted by half its own size inside
          the component, so this point is its bottom-left corner. */}
      {nameLabel && (
        <PlateNameLabel
          name={nameLabel.name}
          placeholder={nameLabel.placeholder}
          editTitle={nameLabel.editTitle}
          emptyTitle={nameLabel.emptyTitle}
          onCommit={nameLabel.onCommit}
          position={shared.widgets.nameLabelPosition}
          labelScale={shared.widgets.scale * 1.5}
        />
      )}

      {/* Beside the plate, and only beside the plate being worked on: the buttons act on
          it. One component, so the column's spacing is CSS rather than millimetres of
          plate. */}
      {sideButtons && (
        <PlateSideButtons
          {...sideButtons}
          // Two anchors in one component: the column hangs from the plate's back edge,
          // the bin stands on its front edge (the plate's front is its smallest Y).
          columnAnchor={shared.widgets.columnAnchor}
          clearAnchor={shared.widgets.clearAnchor}
          labelScale={shared.widgets.scale}
        />
      )}

      {/* FRONT orientation marker locked to grid front edge and constrained within build plate bounds */}
      {shared.showBuildPlate && (
      <group position={shared.frontMarker.position} frustumCulled={false} userData={{ thumbnailHelperType: 'buildPlate' }}>
        {shared.frontMarker.texture && (
          <mesh renderOrder={21} raycast={nullRaycast}>
            <planeGeometry args={[shared.frontMarker.widthMm, shared.frontMarker.depthMm]} />
            <meshBasicMaterial
              map={shared.frontMarker.texture}
              transparent
              opacity={dimFactor}
              depthWrite={false}
              polygonOffset
              polygonOffsetFactor={-1}
              polygonOffsetUnits={-1}
              side={THREE.FrontSide}
              toneMapped={false}
            />
          </mesh>
        )}
      </group>
      )}

      {/* Safety margin hazard stripes - semi-transparent red-white diagonal stripes */}
      {shared.showBuildPlate && shared.margins.visible && (
        <group position={shared.margins.groupPosition} visible={shared.buildPlateOpacity > 0.001} frustumCulled={false} userData={{ thumbnailHelperType: 'buildPlate' }}>
          {(['front', 'back', 'left', 'right'] as const).map((side) => {
            const strip = shared.margins[side];
            if (!strip) return null;
            return (
              <mesh key={side} position={strip.position} renderOrder={20} raycast={nullRaycast}>
                {strip.geometry && <primitive object={strip.geometry} attach="geometry" />}
                <SafetyStripeMaterial
                  widthMm={strip.widthMm}
                  heightMm={strip.heightMm}
                  bleedXMm={strip.bleedXMm}
                  bleedYMm={strip.bleedYMm}
                  opacity={0.42 * plateOpacity}
                />
              </mesh>
            );
          })}
        </group>
      )}
    </group>
  );
}

export function Helpers({
  gridWidthMm,
  gridDepthMm,
  originMinX,
  originMinY,
  buildPlateOpacity,
  showGrid,
  showBuildPlate,
  safetyMarginMm,
  frontLabel = 'Front',
  plateName,
  showPlateName = false,
  plateNamePlaceholder,
  plateNameEditTitle,
  plateNameEmptyTitle,
  onPlateNameChange,
  addPlateLabel,
  addPlateComingSoonTitle,
  plateLocked,
  onTogglePlateLock,
  plateLockTitle,
  plateUnlockTitle,
  plateClearTitle,
  plateClearDisabledTitle,
  onClearPlate,
  plateArrangeTitle,
  plateArrangeDisabledTitle,
  onArrangePlate,
  plates,
  onActivatePlate,
  onRenamePlate,
  onAddPlate,
}: {
  gridWidthMm?: number;
  gridDepthMm?: number;
  originMinX?: number;
  originMinY?: number;
  buildPlateOpacity?: number;
  showGrid?: boolean;
  showBuildPlate?: boolean;
  safetyMarginMm?: { front: number; back: number; left: number; right: number };
  /**
   * Text baked into the build plate's front-edge marker, already translated.
   * Passed in rather than resolved here: this component runs inside the r3f
   * reconciler, where the i18n provider is out of scope.
   */
  frontLabel?: string;
  /** The build plate's name, and the strings its editor needs (see the note above). */
  plateName?: string;
  /** Whether to draw the plate's name widget at all: an empty plate has nothing to name. */
  showPlateName?: boolean;
  plateNamePlaceholder?: string;
  plateNameEditTitle?: string;
  plateNameEmptyTitle?: string;
  onPlateNameChange?: (next: string) => void;
  /** The add-plate button's accessible name, and its hover wording (see the note above). */
  addPlateLabel?: string;
  addPlateComingSoonTitle?: string;
  /** The plate lock: its state, its toggle, and the wordings for its tooltip. */
  plateLocked?: boolean;
  onTogglePlateLock?: () => void;
  plateLockTitle?: string;
  plateUnlockTitle?: string;
  /** Clearing the plate from beside it, and the wording the lock uses to forbid it. */
  plateClearTitle?: string;
  plateClearDisabledTitle?: string;
  onClearPlate?: () => void;
  /** Arranging every model on the plate, and the wording the lock uses to forbid it. */
  plateArrangeTitle?: string;
  plateArrangeDisabledTitle?: string;
  onArrangePlate?: () => void;
  /**
   * The scene's plates, each drawn at its own offset from the first one. Absent while
   * the scene has a single plate: that plate is then drawn at the origin with the props
   * above, exactly as it always was.
   */
  plates?: PlateLayerSpec[];
  /** Picking the surface of a plate that is not active makes it the active one. */
  onActivatePlate?: (plateId: string) => void;
  /** Committing a new name for one of the plates above. */
  onRenamePlate?: (plateId: string, name: string) => void;
  /** Adding another plate, from the button beside the active one. */
  onAddPlate?: () => void;
}) {
  const shouldShowGrid = showGrid ?? true;
  const shouldShowBuildPlate = showBuildPlate ?? true;

  const [isLightTheme, setIsLightTheme] = React.useState(() => {
    if (typeof document === 'undefined') return false;
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light') return true;
    if (attr === 'dark') return false;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;
  });

  React.useEffect(() => {
    const update = () => {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'light') { setIsLightTheme(true); return; }
      if (attr === 'dark') { setIsLightTheme(false); return; }
      setIsLightTheme(window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia?.('(prefers-color-scheme: light)');
    mq?.addEventListener('change', update);
    return () => { observer.disconnect(); mq?.removeEventListener('change', update); };
  }, []);

  const width = Number.isFinite(gridWidthMm) && (gridWidthMm as number) > 0 ? (gridWidthMm as number) : 200;
  const depth = Number.isFinite(gridDepthMm) && (gridDepthMm as number) > 0 ? (gridDepthMm as number) : 200;
  const resolvedOriginMinX = Number.isFinite(originMinX) ? (originMinX as number) : -width * 0.5;
  const resolvedOriginMinY = Number.isFinite(originMinY) ? (originMinY as number) : -depth * 0.5;
  const buildVolumeCenterX = resolvedOriginMinX + width * 0.5;
  const buildVolumeCenterY = resolvedOriginMinY + depth * 0.5;
  const baseSize = Math.max(width, depth);
  const baseDivisions = Math.max(20, Math.min(240, Math.round(baseSize / 5)));
  const divisions = Math.max(8, Math.round(baseDivisions / 3));
  const scaleX = width / baseSize;
  const scaleZ = depth / baseSize;
  const buildPlateOversizeEachSideMm = 3;
  const buildPlateThicknessMm = 3;
  const buildPlateCornerRadiusMm = 3;
  const clampedBuildPlateOpacity = THREE.MathUtils.clamp(buildPlateOpacity ?? 1, 0, 1);
  const buildPlateColor = isLightTheme ? '#8a8e9e' : '#323841';
  const gridMajorColor = isLightTheme ? '#8a8e9e' : '#4f5560';
  const gridMinorColor = isLightTheme ? '#9ea2b0' : '#2c3138';
  const frontMarkerColor = React.useMemo(() => {
    return new THREE.Color(gridMajorColor).lerp(new THREE.Color(isLightTheme ? '#000000' : '#ffffff'), 0.36).getStyle();
  }, [gridMajorColor, isLightTheme]);
  /**
   * The grid of a plate that is not the active one: the same lines, faded toward the
   * plate they lie on, so a second plate reads as scenery rather than as the plate being
   * worked on.
   */
  const mutedGridColors = React.useMemo(() => ({
    major: new THREE.Color(gridMajorColor).lerp(new THREE.Color(buildPlateColor), 0.55).getStyle(),
    minor: new THREE.Color(gridMinorColor).lerp(new THREE.Color(buildPlateColor), 0.55).getStyle(),
  }), [buildPlateColor, gridMajorColor, gridMinorColor]);
  const buildPlateWidth = width + buildPlateOversizeEachSideMm * 2;
  const buildPlateDepth = depth + buildPlateOversizeEachSideMm * 2;
  const buildPlateCenterZ = -buildPlateThicknessMm * 0.5 - 0.08;
  // The tab the FRONT marker is printed on. Its depth is what sizes that marker: the
  // label's texture is fitted to the plane, and the plane is aspect-locked to the tab
  // (256/72), so a deeper tab is a larger label: the tab's 3.2mm -> 4.2mm takes the
  // marker from 11.4 x 3.2mm to 13.5 x 3.8mm, the "a little larger" range.
  const frontTabDepth = buildPlateOversizeEachSideMm + 1.2;
  // A hair more than the overhang the mock plate draws past the build volume, so the
  // buttons sit just outside the plate you can see. Their spacing is CSS inside the
  // component; only this clearance is a plate measurement.
  const plateWidgetClearanceMm = 1;
  // Widget size follows the plate, so a 100mm printer's buttons are not the same
  // physical size as a 300mm one's. 5 is what a 200mm plate has always used; the
  // clamp keeps a very small plate legible and a very large one from dominating.
  const plateWidgetScale = Math.min(14, Math.max(3, width / 40));
  const frontTabBackWidth = Math.min(buildPlateWidth - 12, 24);
  const frontTabFrontWidth = Math.min(frontTabBackWidth - 3, 16);
  const frontMarkerInsetMm = 0.2;
  const frontMarkerAspect = 256 / 72;
  const markerAvailableDepth = Math.max(2.8, frontTabDepth - frontMarkerInsetMm * 2);
  const markerAvailableWidth = Math.max(12, frontTabBackWidth - frontMarkerInsetMm * 2);
  const frontMarkerDepth = Math.min(markerAvailableDepth, markerAvailableWidth / frontMarkerAspect);
  const frontMarkerWidth = frontMarkerDepth * frontMarkerAspect;
  const axisBaseZ = 0.5;
  const axisLength = 22;
  const axisShaftRadius = 0.42;
  const axisHeadRadius = 1.3;
  const axisHeadLength = 1.9;
  const axisLabelLift = 1.0;
  // Keep decal geometry in lockstep with the logo SVG's intrinsic viewBox ratio
  // to avoid non-uniform stretching on the build plate.
  const plateLogoAspect = 1772 / 304;
  const plateLogoBaseWidth = Math.max(16, Math.min(42, width * 0.2));
  const plateLogoScale = 1.0;
  const plateLogoWidth = plateLogoBaseWidth * plateLogoScale;
  const plateLogoHeight = (plateLogoBaseWidth / plateLogoAspect) * plateLogoScale;
  const plateLogoInset = 1.6;
  const plateLogoX = resolvedOriginMinX + width - plateLogoInset - plateLogoWidth * 0.5;
  const plateLogoY = resolvedOriginMinY + plateLogoInset + plateLogoHeight * 0.5;
  const plateLogoZ = 0.12;
  // Seat marker over the front tab so it reads as part of the build plate geometry.
  const frontMarkerY = -buildPlateDepth * 0.5 - frontTabDepth * 0.1;

  const frontTexture = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 256;
    canvas.height = 72;

    const label = frontLabel.toUpperCase();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = frontMarkerColor;
    // The plane geometry below is locked to the canvas aspect, so a longer
    // translation has to shrink into the same texture instead of widening it.
    context.font = fitFontToWidth(context, '700 70px Arial', label, FRONT_MARKER_MAX_TEXT_WIDTH);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    // Nudged below the texture's centre: `middle` centres the em box, and the
    // capitals sit above its middle, so dead-centre reads high in the tab. 5px of a
    // 72px texture is a fraction of a millimetre on the plate.
    context.fillText(label, canvas.width / 2, canvas.height / 2 + 5);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, [frontLabel, frontMarkerColor]);

  const xAxisGradient = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 16;
    canvas.height = 256;

    const gradient = context.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0, '#8d232f');
    gradient.addColorStop(1, '#ff7a7a');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }, []);

  const yAxisGradient = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 16;
    canvas.height = 256;

    const gradient = context.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0, '#1e6b35');
    gradient.addColorStop(1, '#74ff95');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }, []);

  const zAxisGradient = React.useMemo(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return null;

    canvas.width = 16;
    canvas.height = 256;

    const gradient = context.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0, '#21428d');
    gradient.addColorStop(1, '#74a3ff');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }, []);


  // Rasterize SVG to canvas and use as texture for robust WebGL support
  const plateLogoTexture = React.useMemo(() => {
    const texture = new THREE.Texture();
    fetch('/dragonfruit_assets/branding/text_logo.svg')
      .then(res => res.text())
      .then(svgText => {
        // Create an image from SVG text
        const svg = new Blob([svgText], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(svg);
        const img = new window.Image();
        img.onload = () => {
          // Draw SVG onto a canvas
          const canvas = document.createElement('canvas');
          canvas.width = img.width || 1772;
          canvas.height = img.height || 304;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            texture.image = canvas;
            texture.needsUpdate = true;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.generateMipmaps = true;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
          }
          URL.revokeObjectURL(url);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
        };
        img.src = url;
      });
    return texture;
  }, []);

  React.useEffect(() => {
    return () => {
      frontTexture?.dispose();
    };
  }, [frontTexture]);

  React.useEffect(() => {
    return () => {
      xAxisGradient?.dispose();
      yAxisGradient?.dispose();
      zAxisGradient?.dispose();
    };
  }, [xAxisGradient, yAxisGradient, zAxisGradient]);

  React.useEffect(() => {
    return () => {
      plateLogoTexture.dispose();
    };
  }, [plateLogoTexture]);

  const buildPlateGeometry = React.useMemo(() => {
    const halfW = buildPlateWidth * 0.5;
    const halfD = buildPlateDepth * 0.5;
    const r = Math.max(0.2, Math.min(buildPlateCornerRadiusMm, halfW - 0.2, halfD - 0.2));
    const tabBackHalf = frontTabBackWidth * 0.5;
    const tabFrontHalf = frontTabFrontWidth * 0.5;
    const tabFrontY = -halfD - frontTabDepth;

    const shape = new THREE.Shape();
    shape.moveTo(-halfW + r, -halfD);
    shape.lineTo(-tabBackHalf, -halfD);
    shape.lineTo(-tabFrontHalf, tabFrontY);
    shape.lineTo(tabFrontHalf, tabFrontY);
    shape.lineTo(tabBackHalf, -halfD);
    shape.lineTo(halfW - r, -halfD);
    shape.quadraticCurveTo(halfW, -halfD, halfW, -halfD + r);
    shape.lineTo(halfW, halfD - r);
    shape.quadraticCurveTo(halfW, halfD, halfW - r, halfD);
    shape.lineTo(-halfW + r, halfD);
    shape.quadraticCurveTo(-halfW, halfD, -halfW, halfD - r);
    shape.lineTo(-halfW, -halfD + r);
    shape.quadraticCurveTo(-halfW, -halfD, -halfW + r, -halfD);

    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: buildPlateThicknessMm,
      bevelEnabled: false,
      curveSegments: 18,
      steps: 1,
    });

    // Center thickness around local Z=0 so top sits at +thickness/2 and bottom at -thickness/2.
    geom.translate(0, 0, -buildPlateThicknessMm * 0.5);
    geom.computeVertexNormals();
    return geom;
  }, [
    buildPlateCornerRadiusMm,
    buildPlateDepth,
    buildPlateThicknessMm,
    buildPlateWidth,
    frontTabBackWidth,
    frontTabDepth,
    frontTabFrontWidth,
  ]);

  React.useEffect(() => {
    return () => {
      buildPlateGeometry.dispose();
    };
  }, [buildPlateGeometry]);

  const makeBleedPlaneGeometry = React.useCallback((
    planeWidthMm: number,
    planeHeightMm: number,
    opts?: {
      bleedXMm?: number;
      bleedYMm?: number;
      outwardSide?: 'top' | 'bottom' | 'left' | 'right';
      outwardCornerRadiusMm?: number;
    },
  ) => {
    const halfW = planeWidthMm * 0.5;
    const halfH = planeHeightMm * 0.5;

    const outwardCornerRadius = Math.max(0, opts?.outwardCornerRadiusMm ?? 0);
    const maxRadius = Math.max(0, Math.min(outwardCornerRadius, halfW - 0.01, halfH - 0.01));
    const outwardSide = opts?.outwardSide;

    const rTL = outwardSide === 'top' || outwardSide === 'left' ? maxRadius : 0;
    const rTR = outwardSide === 'top' || outwardSide === 'right' ? maxRadius : 0;
    const rBR = outwardSide === 'bottom' || outwardSide === 'right' ? maxRadius : 0;
    const rBL = outwardSide === 'bottom' || outwardSide === 'left' ? maxRadius : 0;

    const shape = new THREE.Shape();
    shape.moveTo(-halfW + rBL, -halfH);
    shape.lineTo(halfW - rBR, -halfH);
    if (rBR > 0) {
      shape.absarc(halfW - rBR, -halfH + rBR, rBR, -Math.PI * 0.5, 0, false);
    } else {
      shape.lineTo(halfW, -halfH);
    }

    shape.lineTo(halfW, halfH - rTR);
    if (rTR > 0) {
      shape.absarc(halfW - rTR, halfH - rTR, rTR, 0, Math.PI * 0.5, false);
    } else {
      shape.lineTo(halfW, halfH);
    }

    shape.lineTo(-halfW + rTL, halfH);
    if (rTL > 0) {
      shape.absarc(-halfW + rTL, halfH - rTL, rTL, Math.PI * 0.5, Math.PI, false);
    } else {
      shape.lineTo(-halfW, halfH);
    }

    shape.lineTo(-halfW, -halfH + rBL);
    if (rBL > 0) {
      shape.absarc(-halfW + rBL, -halfH + rBL, rBL, Math.PI, Math.PI * 1.5, false);
    } else {
      shape.lineTo(-halfW, -halfH);
    }
    shape.closePath();

    const geometry = new THREE.ShapeGeometry(shape, 18);
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const bleedX = Math.max(0, opts?.bleedXMm ?? 0);
    const bleedY = Math.max(0, opts?.bleedYMm ?? 0);
    const virtualWidth = Math.max(planeWidthMm, planeWidthMm + bleedX * 2);
    const virtualHeight = Math.max(planeHeightMm, planeHeightMm + bleedY * 2);
    const minU = bleedX / virtualWidth;
    const maxU = 1 - minU;
    const minV = bleedY / virtualHeight;
    const maxV = 1 - minV;

    for (let i = 0; i < uv.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const u = THREE.MathUtils.clamp((x + halfW) / Math.max(planeWidthMm, 1e-6), 0, 1);
      const v = THREE.MathUtils.clamp((y + halfH) / Math.max(planeHeightMm, 1e-6), 0, 1);
      uv.setXY(
        i,
        THREE.MathUtils.lerp(minU, maxU, u),
        THREE.MathUtils.lerp(minV, maxV, v),
      );
    }

    uv.needsUpdate = true;
    return geometry;
  }, []);

  const marginFront = Math.max(0, safetyMarginMm?.front ?? 0);
  const marginBack = Math.max(0, safetyMarginMm?.back ?? 0);
  const marginLeft = Math.max(0, safetyMarginMm?.left ?? 0);
  const marginRight = Math.max(0, safetyMarginMm?.right ?? 0);
  const hasSafetyMargins = marginFront > 0 || marginBack > 0 || marginLeft > 0 || marginRight > 0;
  const stripeEdgeBleedMm = buildPlateOversizeEachSideMm;
  const safetyStripOutwardCornerRadiusMm = 2;

  const frontStripGeometry = React.useMemo(
    () => (marginFront > 0 ? makeBleedPlaneGeometry(width, marginFront, {
      bleedXMm: stripeEdgeBleedMm,
      outwardSide: 'bottom',
      outwardCornerRadiusMm: safetyStripOutwardCornerRadiusMm,
    }) : null),
    [makeBleedPlaneGeometry, width, marginFront, stripeEdgeBleedMm, safetyStripOutwardCornerRadiusMm],
  );
  const backStripGeometry = React.useMemo(
    () => (marginBack > 0 ? makeBleedPlaneGeometry(width, marginBack, {
      bleedXMm: stripeEdgeBleedMm,
      outwardSide: 'top',
      outwardCornerRadiusMm: safetyStripOutwardCornerRadiusMm,
    }) : null),
    [makeBleedPlaneGeometry, width, marginBack, stripeEdgeBleedMm, safetyStripOutwardCornerRadiusMm],
  );
  const leftStripGeometry = React.useMemo(
    () => (marginLeft > 0 ? makeBleedPlaneGeometry(marginLeft, depth, {
      bleedYMm: stripeEdgeBleedMm,
      outwardSide: 'left',
      outwardCornerRadiusMm: safetyStripOutwardCornerRadiusMm,
    }) : null),
    [makeBleedPlaneGeometry, marginLeft, depth, stripeEdgeBleedMm, safetyStripOutwardCornerRadiusMm],
  );
  const rightStripGeometry = React.useMemo(
    () => (marginRight > 0 ? makeBleedPlaneGeometry(marginRight, depth, {
      bleedYMm: stripeEdgeBleedMm,
      outwardSide: 'right',
      outwardCornerRadiusMm: safetyStripOutwardCornerRadiusMm,
    }) : null),
    [makeBleedPlaneGeometry, marginRight, depth, stripeEdgeBleedMm, safetyStripOutwardCornerRadiusMm],
  );

  React.useEffect(() => {
    return () => {
      frontStripGeometry?.dispose();
      backStripGeometry?.dispose();
      leftStripGeometry?.dispose();
      rightStripGeometry?.dispose();
    };
  }, [
    frontStripGeometry,
    backStripGeometry,
    leftStripGeometry,
    rightStripGeometry,
  ]);

  /**
   * What every plate draws from, built once: the plates differ only by where they sit
   * and by being the one being worked on.
   */
  const shared: PlateLayerShared = {
    showGrid: shouldShowGrid,
    showBuildPlate: shouldShowBuildPlate,
    buildPlateOpacity: clampedBuildPlateOpacity,
    plate: {
      geometry: buildPlateGeometry,
      color: buildPlateColor,
      position: [buildVolumeCenterX, buildVolumeCenterY, buildPlateCenterZ],
    },
    grid: {
      baseSize,
      divisions,
      scaleX,
      scaleZ,
      position: [buildVolumeCenterX, buildVolumeCenterY, -0.01],
      majorColor: gridMajorColor,
      minorColor: gridMinorColor,
      mutedMajorColor: mutedGridColors.major,
      mutedMinorColor: mutedGridColors.minor,
    },
    logo: {
      groupPosition: [0, 0, plateLogoZ],
      position: [plateLogoX, plateLogoY, 0],
      widthMm: plateLogoWidth,
      heightMm: plateLogoHeight,
      texture: plateLogoTexture,
    },
    axes: {
      position: [resolvedOriginMinX, resolvedOriginMinY, axisBaseZ],
      length: axisLength,
      shaftRadius: axisShaftRadius,
      headRadius: axisHeadRadius,
      headLength: axisHeadLength,
      labelLift: axisLabelLift,
      xGradient: xAxisGradient,
      yGradient: yAxisGradient,
      zGradient: zAxisGradient,
    },
    frontMarker: {
      position: [buildVolumeCenterX, buildVolumeCenterY + frontMarkerY, 0.001],
      widthMm: frontMarkerWidth,
      depthMm: frontMarkerDepth,
      texture: frontTexture,
    },
    margins: {
      groupPosition: [0, 0, plateLogoZ],
      visible: hasSafetyMargins,
      front: marginFront > 0 ? {
        widthMm: width,
        heightMm: marginFront,
        bleedXMm: stripeEdgeBleedMm,
        bleedYMm: 0,
        position: [buildVolumeCenterX, resolvedOriginMinY + marginFront * 0.5, 0],
        geometry: frontStripGeometry,
      } : null,
      back: marginBack > 0 ? {
        widthMm: width,
        heightMm: marginBack,
        bleedXMm: stripeEdgeBleedMm,
        bleedYMm: 0,
        position: [buildVolumeCenterX, resolvedOriginMinY + depth - marginBack * 0.5, 0],
        geometry: backStripGeometry,
      } : null,
      left: marginLeft > 0 ? {
        widthMm: marginLeft,
        heightMm: depth,
        bleedXMm: 0,
        bleedYMm: stripeEdgeBleedMm,
        position: [resolvedOriginMinX + marginLeft * 0.5, buildVolumeCenterY, 0],
        geometry: leftStripGeometry,
      } : null,
      right: marginRight > 0 ? {
        widthMm: marginRight,
        heightMm: depth,
        bleedXMm: 0,
        bleedYMm: stripeEdgeBleedMm,
        position: [resolvedOriginMinX + width - marginRight * 0.5, buildVolumeCenterY, 0],
        geometry: rightStripGeometry,
      } : null,
    },
    widgets: {
      scale: plateWidgetScale,
      // The plate's left edge (X0 in the front-left origin mode) and its back edge.
      nameLabelPosition: [resolvedOriginMinX, resolvedOriginMinY + depth, plateLogoZ + 0.2],
      // Two anchors in one component: the column hangs from the plate's back edge, the
      // bin stands on its front edge (the plate's front is its smallest Y).
      columnAnchor: [resolvedOriginMinX + width + buildPlateOversizeEachSideMm + plateWidgetClearanceMm, resolvedOriginMinY + depth, plateLogoZ + 0.2],
      clearAnchor: [resolvedOriginMinX + width + buildPlateOversizeEachSideMm + plateWidgetClearanceMm, resolvedOriginMinY, plateLogoZ + 0.2],
    },
  };

  /**
   * One plate's name widget. A plate from the scene's list carries its own name and the
   * wording to show while it has none, so it is labelled whenever the strings its editor
   * needs are there; the scene without a list keeps the single plate's rule, including
   * hiding the name while the plate is empty.
   */
  const nameLabelFor = (plate: PlateLayerSpec | null): PlateLayerNameLabel | undefined => {
    if (!shouldShowBuildPlate || !plateNameEditTitle || !plateNameEmptyTitle) return undefined;
    if (plate) {
      if (!onRenamePlate) return undefined;
      return {
        name: plate.name,
        placeholder: plate.placeholder,
        editTitle: plateNameEditTitle,
        emptyTitle: plateNameEmptyTitle,
        onCommit: (next) => onRenamePlate(plate.id, next),
      };
    }
    if (!showPlateName || plateName === undefined || !plateNamePlaceholder || !onPlateNameChange) return undefined;
    return {
      name: plateName,
      placeholder: plateNamePlaceholder,
      editTitle: plateNameEditTitle,
      emptyTitle: plateNameEmptyTitle,
      onCommit: onPlateNameChange,
    };
  };

  /**
   * One plate's side buttons, or none: they act on the plate being worked on, so only the
   * active plate has them. The scene without a plate list keeps the single plate's rule,
   * where the widgets arrive with the scene's content. The add button is live as soon as
   * there is somewhere to add a plate to.
   */
  const sideButtonsFor = (plate: PlateLayerSpec | null, isActive: boolean): PlateSideButtonsProps | undefined => {
    if (!shouldShowBuildPlate) return undefined;
    if (plate ? !isActive : (!showPlateName || !addPlateComingSoonTitle)) return undefined;
    if (!addPlateLabel
      || plateLocked === undefined
      || !onTogglePlateLock
      || !plateLockTitle
      || !plateUnlockTitle
      || !plateClearTitle
      || !plateClearDisabledTitle
      || !onClearPlate
      || !plateArrangeTitle
      || !plateArrangeDisabledTitle
      || !onArrangePlate) {
      return undefined;
    }
    return {
      addLabel: addPlateLabel,
      addComingSoonTitle: addPlateComingSoonTitle,
      onAdd: onAddPlate,
      locked: plateLocked,
      lockTitle: plateLockTitle,
      unlockTitle: plateUnlockTitle,
      onToggleLock: onTogglePlateLock,
      arrangeTitle: plateArrangeTitle,
      arrangeDisabledTitle: plateArrangeDisabledTitle,
      arrangeDisabled: plateLocked,
      onArrangePlate,
      clearTitle: plateClearTitle,
      clearDisabledTitle: plateClearDisabledTitle,
      clearDisabled: plateLocked,
      onClearPlate,
    };
  };

  // No plate list is the scene's one plate: it draws at the origin, active, from the
  // single plate's own props. A plate list draws one entry per plate.
  const plateLayers: (PlateLayerSpec | null)[] = plates && plates.length > 0 ? plates : [null];

  return (
    <>
      {plateLayers.map((plate) => {
        const isActive = plate ? plate.isActive : true;
        return (
          <PlateLayer
            key={plate ? plate.id : 'plate'}
            dxMm={plate ? plate.dxMm : 0}
            dyMm={plate ? plate.dyMm : 0}
            isActive={isActive}
            shared={shared}
            nameLabel={nameLabelFor(plate)}
            sideButtons={sideButtonsFor(plate, isActive)}
            onActivate={plate && onActivatePlate ? () => onActivatePlate(plate.id) : undefined}
          />
        );
      })}
    </>
  );
}
