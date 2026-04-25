"use client";

import React, { useEffect } from 'react';
import * as THREE from 'three';
import { useThree, useFrame } from '@react-three/fiber';
import { AxisLabels } from '@/components/scene/AxisLabels';

export function LoggingHelper({ mode }: { mode?: string }) {
  React.useEffect(() => {
    console.log('[SceneCanvas] Mode in Canvas:', mode);
  }, [mode]);
  return null;
}

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

function FillLight({ intensity }: { intensity: number }) {
  // Fixed-position fill light that mimics a frontal fill without tracking the
  // camera. Camera movement (orbit, zoom, F-focus) will never change the
  // model's illumination.
  return (
    <directionalLight
      name="fill-light"
      position={[0, -80, 60]}
      intensity={intensity}
      color="#ffffff"
    />
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
      <FillLight intensity={clampedHeadlightIntensity} />
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
          background: 'linear-gradient(180deg, color-mix(in srgb, var(--scene-gradient-linear-start, #ff37aa), transparent 92%) 0%, color-mix(in srgb, var(--scene-gradient-linear-mid, #6f33ff), transparent 95%) 40%, rgba(0,0,0,0) 100%)',
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

export function Helpers({
  gridWidthMm,
  gridDepthMm,
  originMinX,
  originMinY,
  buildPlateOpacity,
  showGrid,
  showBuildPlate,
  safetyMarginMm,
}: {
  gridWidthMm?: number;
  gridDepthMm?: number;
  originMinX?: number;
  originMinY?: number;
  buildPlateOpacity?: number;
  showGrid?: boolean;
  showBuildPlate?: boolean;
  safetyMarginMm?: { front: number; back: number; left: number; right: number };
}) {
  const nullRaycast = () => null;
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
  const buildPlateWidth = width + buildPlateOversizeEachSideMm * 2;
  const buildPlateDepth = depth + buildPlateOversizeEachSideMm * 2;
  const buildPlateCenterZ = -buildPlateThicknessMm * 0.5 - 0.08;
  const frontTabDepth = buildPlateOversizeEachSideMm + 0.2;
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

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = frontMarkerColor;
    context.font = '700 70px Arial';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('FRONT', canvas.width / 2, canvas.height / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }, [frontMarkerColor]);

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

  const plateLogoTexture = React.useMemo(() => {
    const texture = new THREE.TextureLoader().load('/dragonfruit_assets/branding/text_logo.svg');
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
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

  return (
    <>
      {/* Primitive mock build plate under grid */}
      <mesh
        position={[buildVolumeCenterX, buildVolumeCenterY, buildPlateCenterZ]}
        renderOrder={-10}
        raycast={nullRaycast}
        visible={shouldShowBuildPlate && clampedBuildPlateOpacity > 0.001}
        userData={{ thumbnailHelperType: 'buildPlate' }}
      >
        <primitive object={buildPlateGeometry} attach="geometry" />
        <meshStandardMaterial
          color={buildPlateColor}
          transparent
          opacity={0.94 * clampedBuildPlateOpacity}
          side={THREE.FrontSide}
          depthWrite
        />
      </mesh>

      {/* Grid on XY plane (horizontal) - rotate 90° around X */}
      {shouldShowGrid && (
        <gridHelper
          args={[baseSize, divisions, gridMajorColor, gridMinorColor]}
          position={[buildVolumeCenterX, buildVolumeCenterY, -0.01]}
          rotation={[Math.PI / 2, 0, 0]}
          scale={[scaleX, 1, scaleZ]}
          raycast={nullRaycast}
          userData={{ thumbnailHelperType: 'grid' }}
        />
      )}

      {shouldShowGrid && shouldShowBuildPlate && (
        <group
          position={[0, 0, plateLogoZ]}
          userData={{ thumbnailHelperType: 'grid' }}
        >
          <mesh position={[plateLogoX, plateLogoY, 0]} renderOrder={20} raycast={nullRaycast}>
            <planeGeometry args={[plateLogoWidth, plateLogoHeight]} />
            <meshBasicMaterial
              map={plateLogoTexture}
              transparent
              opacity={0.4}
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
      {shouldShowGrid && (
      <group position={[resolvedOriginMinX, resolvedOriginMinY, axisBaseZ]} userData={{ thumbnailHelperType: 'grid' }}>
        {/* X axis */}
        <mesh position={[axisLength * 0.5, 0, 0]} rotation={[0, 0, -Math.PI * 0.5]} raycast={nullRaycast}>
          <cylinderGeometry args={[axisShaftRadius, axisShaftRadius, axisLength, 12]} />
          <meshBasicMaterial map={xAxisGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[axisLength + axisHeadLength * 0.5, 0, 0]} rotation={[0, 0, -Math.PI * 0.5]} raycast={nullRaycast}>
          <coneGeometry args={[axisHeadRadius, axisHeadLength, 12]} />
          <meshBasicMaterial map={xAxisGradient ?? undefined} toneMapped={false} />
        </mesh>

        {/* Y axis */}
        <mesh position={[0, axisLength * 0.5, 0]} raycast={nullRaycast}>
          <cylinderGeometry args={[axisShaftRadius, axisShaftRadius, axisLength, 12]} />
          <meshBasicMaterial map={yAxisGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[0, axisLength + axisHeadLength * 0.5, 0]} raycast={nullRaycast}>
          <coneGeometry args={[axisHeadRadius, axisHeadLength, 12]} />
          <meshBasicMaterial map={yAxisGradient ?? undefined} toneMapped={false} />
        </mesh>

        {/* Z axis */}
        <mesh position={[0, 0, axisLength * 0.5]} rotation={[Math.PI * 0.5, 0, 0]} raycast={nullRaycast}>
          <cylinderGeometry args={[axisShaftRadius, axisShaftRadius, axisLength, 12]} />
          <meshBasicMaterial map={zAxisGradient ?? undefined} toneMapped={false} />
        </mesh>
        <mesh position={[0, 0, axisLength + axisHeadLength * 0.5]} rotation={[Math.PI * 0.5, 0, 0]} raycast={nullRaycast}>
          <coneGeometry args={[axisHeadRadius, axisHeadLength, 12]} />
          <meshBasicMaterial map={zAxisGradient ?? undefined} toneMapped={false} />
        </mesh>

        <group position={[0, 0, axisLabelLift]}>
          <AxisLabels size={axisLength + 6} />
        </group>
      </group>
      )}

      {/* FRONT orientation marker locked to grid front edge and constrained within build plate bounds */}
      {shouldShowBuildPlate && (
      <group position={[buildVolumeCenterX, buildVolumeCenterY + frontMarkerY, 0.001]} userData={{ thumbnailHelperType: 'buildPlate' }}>
        {frontTexture && (
          <mesh renderOrder={21} raycast={nullRaycast}>
            <planeGeometry args={[frontMarkerWidth, frontMarkerDepth]} />
            <meshBasicMaterial
              map={frontTexture}
              transparent
              opacity={1}
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
      {shouldShowBuildPlate && hasSafetyMargins && clampedBuildPlateOpacity > 0.001 && (
        <group position={[0, 0, plateLogoZ]} userData={{ thumbnailHelperType: 'buildPlate' }}>
          {/* Front strip */}
          {marginFront > 0 && (
            <mesh
              position={[buildVolumeCenterX, resolvedOriginMinY + marginFront * 0.5, 0]}
              renderOrder={20}
              raycast={nullRaycast}
            >
              {frontStripGeometry && <primitive object={frontStripGeometry} attach="geometry" />}
              <SafetyStripeMaterial
                widthMm={width}
                heightMm={marginFront}
                bleedXMm={stripeEdgeBleedMm}
                opacity={0.42 * clampedBuildPlateOpacity}
              />
            </mesh>
          )}
          {/* Back strip */}
          {marginBack > 0 && (
            <mesh
              position={[buildVolumeCenterX, resolvedOriginMinY + depth - marginBack * 0.5, 0]}
              renderOrder={20}
              raycast={nullRaycast}
            >
              {backStripGeometry && <primitive object={backStripGeometry} attach="geometry" />}
              <SafetyStripeMaterial
                widthMm={width}
                heightMm={marginBack}
                bleedXMm={stripeEdgeBleedMm}
                opacity={0.42 * clampedBuildPlateOpacity}
              />
            </mesh>
          )}
          {/* Left strip */}
          {marginLeft > 0 && (
            <mesh
              position={[resolvedOriginMinX + marginLeft * 0.5, buildVolumeCenterY, 0]}
              renderOrder={20}
              raycast={nullRaycast}
            >
              {leftStripGeometry && <primitive object={leftStripGeometry} attach="geometry" />}
              <SafetyStripeMaterial
                widthMm={marginLeft}
                heightMm={depth}
                bleedYMm={stripeEdgeBleedMm}
                opacity={0.42 * clampedBuildPlateOpacity}
              />
            </mesh>
          )}
          {/* Right strip */}
          {marginRight > 0 && (
            <mesh
              position={[resolvedOriginMinX + width - marginRight * 0.5, buildVolumeCenterY, 0]}
              renderOrder={20}
              raycast={nullRaycast}
            >
              {rightStripGeometry && <primitive object={rightStripGeometry} attach="geometry" />}
              <SafetyStripeMaterial
                widthMm={marginRight}
                heightMm={depth}
                bleedYMm={stripeEdgeBleedMm}
                opacity={0.42 * clampedBuildPlateOpacity}
              />
            </mesh>
          )}
        </group>
      )}
    </>
  );
}
